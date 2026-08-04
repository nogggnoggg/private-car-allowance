/**
 * Maintenance application service — PHASE-006-T4
 *
 * Spec §2 群組 B（AC-02/03/04/05）、§7.2 `MaintenanceApplicationDto`、
 * §9.1「草稿儲存」、§16 D1(a)（子表模式）/D6(a)（generic complete/內嵌
 * computed）/D7(a)（僅本人完成）/D11(a)（不另存 snapshotActualCost）。
 *
 * Owns the DB-touching half of the maintenance draft CRUD vertical;
 * `routes.ts` (Fastify plugin) is the thin HTTP layer that calls into this
 * module — same split as `travel-service.ts` + `applications/routes.ts`
 * (T4 Packet「複用既有模式」義務).
 *
 * 本 Task 範圍（Packet 明文）：僅草稿 CRUD＋欄位驗證＋狀態／授權守門
 * （AC-02~05）。**不含**：
 *   - 完成流程與快照寫入（T7）——`snapshot` 恆為 `null`（本 Task 從不轉換
 *     `status` 至 `COMPLETED`；AC-04 測試以直接 `prisma.application.update`
 *     建立 COMPLETED fixture，模擬「未來由 T7 完成」的既有列）。
 *   - 期間公務里程／預覽（T5）——`computed` 恆為 `null`（DRAFT 亦然）；
 *     `completionBlockers` 呼叫 `computeMaintenanceBlockers` 時
 *     `officialKm` 恆傳 `null`（兩段式語意之「第一段」，§9.3），故第 9、11
 *     項（`OFFICIAL_KM_EXCEEDS_INTERVAL`／`AMOUNT_OUT_OF_RANGE`）本 Task
 *     從不出現。
 *   - 附件關聯（T6）——`attachments` 恆為 `[]`（PUT 不接受 `attachmentIds[]`，
 *     没有任何程式路徑可以把附件關聯到保養申請；`attachmentCount` 傳給
 *     `computeMaintenanceBlockers` 恆為 `0`，故第 10 項
 *     `MAINTENANCE_ATTACHMENT_REQUIRED` 本 Task 恆出現於 DRAFT 的 blockers）。
 *   - 代操作稽核 hook（T9）——本檔不提供 `onCreated`/`onUpdated` 參數
 *     （與 `travel-service.ts` 不同）；T9 依 Files Allowed 清單將擴充本檔。
 *
 * 日期精度紀律（B-32／T3 即審 FW-4）：`lastMaintenanceDate`／
 * `currentMaintenanceDate` 一律 UTC 日粒度（`@db.Date`），寫入前經
 * `utcDateOnly` 正規化（沿用 `travel-service.ts` 既有匯出的純函式，不重寫）。
 *
 * `intervalKm` 不設第二來源（T3 即審 FW-3）：本檔從不自行計算或儲存
 * `intervalKm`——`computeMaintenanceBlockers` 內部由
 * `currentOdometerKm − lastOdometerKm` 推導（見該檔文件註解），本檔僅原樣
 * 傳遞五個業務欄位。
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { AppError } from "../platform/errors.js";
import { assertApplicationMutable } from "./application-state-machine.js";
import type { Blocker } from "./maintenance-blockers.js";
import { computeMaintenanceBlockers } from "./maintenance-blockers.js";
import { derivePrimaryDate, utcDateOnly } from "./travel-service.js";

// ---------------------------------------------------------------------------
// Prisma include shape shared by create/read/update
// ---------------------------------------------------------------------------

const maintenanceApplicationInclude = {
  owner: { select: { displayName: true, loginName: true } },
  createdBy: { select: { displayName: true } },
  maintenance: true,
} satisfies Prisma.ApplicationInclude;

type MaintenanceApplicationRecord = Prisma.ApplicationGetPayload<{
  include: typeof maintenanceApplicationInclude;
}>;

// ---------------------------------------------------------------------------
// Decimal formatting helpers (DTO 紀律：金額／里程一律以固定小數位字串對外，
// 沿 §7.2「不得改用 JSON number」)
// ---------------------------------------------------------------------------

function formatDecimalOrNull(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed(2);
}

function formatDateOrNull(value: Date | null): string | null {
  if (value === null) return null;
  return value.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// createMaintenanceDraft (AC-02)
// ---------------------------------------------------------------------------

export interface CreateMaintenanceDraftInput {
  ownerId: string;
  createdById: string;
  lastMaintenanceDate?: Date | null;
  currentMaintenanceDate?: Date | null;
  lastOdometerKm?: Prisma.Decimal | null;
  currentOdometerKm?: Prisma.Decimal | null;
  actualCost?: Prisma.Decimal | null;
}

/**
 * Creates a new MAINTENANCE draft (Application + MaintenanceApplication, 1:1).
 * §7.1「body 全選填」——所有五個業務欄位皆可選，未提供者一律以 `null` 建立
 * （AC-02：不因缺欄位而拒絕）。
 *
 * owner 恆為呼叫者提供（自建＝自己；T9 代建立＝指定使用者），從不讀取
 * request body 的任何 ownerId/createdById（§6.2 資料隔離不變式 1，同
 * `createTravelDraft` 既有紀律）。
 */
export async function createMaintenanceDraft(
  prisma: PrismaClient,
  input: CreateMaintenanceDraftInput
): Promise<MaintenanceApplicationRecord> {
  const currentMaintenanceDate = input.currentMaintenanceDate
    ? utcDateOnly(input.currentMaintenanceDate)
    : null;
  const lastMaintenanceDate = input.lastMaintenanceDate
    ? utcDateOnly(input.lastMaintenanceDate)
    : null;
  const primaryDate = derivePrimaryDate(currentMaintenanceDate, new Date());

  return prisma.application.create({
    data: {
      type: "MAINTENANCE",
      status: "DRAFT",
      ownerId: input.ownerId,
      createdById: input.createdById,
      primaryDate,
      maintenance: {
        create: {
          lastMaintenanceDate,
          currentMaintenanceDate,
          lastOdometerKm: input.lastOdometerKm ?? null,
          currentOdometerKm: input.currentOdometerKm ?? null,
          actualCost: input.actualCost ?? null,
        },
      },
    },
    include: maintenanceApplicationInclude,
  });
}

// ---------------------------------------------------------------------------
// getMaintenanceApplication (AC-05, B-34)
// ---------------------------------------------------------------------------

/**
 * Reads a MAINTENANCE application by id. Returns `null` if not found OR the
 * application is not a MAINTENANCE type (B-34: `:id` pointing at a TRAVEL
 * application must 404, never leak its type — mirrors
 * `getTravelApplication`'s identical defensive check).
 */
export async function getMaintenanceApplication(
  prisma: PrismaClient,
  id: string
): Promise<MaintenanceApplicationRecord | null> {
  const application = await prisma.application.findUnique({
    where: { id },
    include: maintenanceApplicationInclude,
  });
  if (!application || application.type !== "MAINTENANCE" || !application.maintenance) {
    return null;
  }
  return application;
}

// ---------------------------------------------------------------------------
// updateMaintenanceDraft (AC-02/03/04, 三態語意)
// ---------------------------------------------------------------------------

/**
 * 五欄三態語意（§8.2，沿 `UpdateTravelDraftPatch` 既有慣例）：
 *   - key 缺席（未出現於 `patch` 物件上）= 不變
 *   - key 存在但值為 `null`           = 清空
 *   - key 存在且有值                  = 設定
 * 呼叫端（routes.ts）以 `"lastMaintenanceDate" in patch` 等方式判斷是否要
 * 帶入該 key，把 HTTP body 的三態原封不動地傳下來。
 */
export interface UpdateMaintenanceDraftPatch {
  lastMaintenanceDate?: Date | null;
  currentMaintenanceDate?: Date | null;
  lastOdometerKm?: Prisma.Decimal | null;
  currentOdometerKm?: Prisma.Decimal | null;
  actualCost?: Prisma.Decimal | null;
}

function hasKey(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * PHASE-004-R4 同型紀律（`isRetryableTransactionConflict`，沿用
 * `travel-service.ts` 既有判斷，見該檔文件註解對三種訊號形狀的完整解釋）：
 * 本檔不重寫這套判斷邏輯，直接複製其判定條件（Files Allowed 未列
 * `travel-service.ts` 為可修改檔案，故不能把該函式改為 export 後在此
 * import——改為在本檔重新宣告同一段純邏輯，屬「同一份規則的獨立小型複本」
 * 而非「第二套驗證實作」：此為交易衝突偵測，不是 AC-03 所指的欄位驗證。
 */
function isRetryableTransactionConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2034") return true;
    if (err.code === "P2010") {
      const meta = err.meta as { code?: string } | undefined;
      return meta?.code === "40001" || meta?.code === "40P01";
    }
    return false;
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return /deadlock detected|could not serialize access/i.test(err.message);
  }
  return false;
}

const UPDATE_DRAFT_MAX_RETRIES = 6;
const RETRY_BACKOFF_BASE_MS = 15;
const RETRY_BACKOFF_CAP_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryBackoffMs(attempt: number): number {
  const exp = Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

/**
 * Updates a MAINTENANCE draft's five business fields + `primaryDate`
 * （§9.1 步驟；本 Task 不含附件對帳與代操作稽核 hook，見檔頭說明）。
 *
 * SERIALIZABLE + `SELECT ... FOR UPDATE` + 重試（沿
 * `updateTravelDraft` 既有交易紀律，§10.3 NFR「所有寫入路徑 SERIALIZABLE
 * ＋ 重試」）：交易內重新讀取 `status` 並再次 `assertApplicationMutable`
 * （M-2 教訓，防止外層檢查與交易之間的 TOCTOU 競態）。
 */
export async function updateMaintenanceDraft(
  prisma: PrismaClient,
  id: string,
  patch: UpdateMaintenanceDraftPatch
): Promise<MaintenanceApplicationRecord> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= UPDATE_DRAFT_MAX_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          // Table name quoted for Postgres case-sensitivity (unquoted-default,
          // no @@map in schema.prisma) — same pattern as updateTravelDraft.
          await tx.$queryRaw`SELECT "id" FROM "Application" WHERE "id" = ${id} FOR UPDATE`;

          const existing = await tx.application.findUniqueOrThrow({
            where: { id },
            select: {
              status: true,
              createdAt: true,
              maintenance: {
                select: {
                  lastMaintenanceDate: true,
                  currentMaintenanceDate: true,
                  lastOdometerKm: true,
                  currentOdometerKm: true,
                  actualCost: true,
                },
              },
            },
          });

          // PHASE-004-R4 (M-2) 同型紀律：交易內以新鮮讀取再驗一次可變性，
          // 不僅信任 routes.ts 呼叫本函式前的外層檢查。
          assertApplicationMutable(existing.status);

          const nextLastMaintenanceDate = hasKey(patch, "lastMaintenanceDate")
            ? patch.lastMaintenanceDate
              ? utcDateOnly(patch.lastMaintenanceDate)
              : null
            : (existing.maintenance?.lastMaintenanceDate ?? null);
          const nextCurrentMaintenanceDate = hasKey(patch, "currentMaintenanceDate")
            ? patch.currentMaintenanceDate
              ? utcDateOnly(patch.currentMaintenanceDate)
              : null
            : (existing.maintenance?.currentMaintenanceDate ?? null);
          const nextLastOdometerKm = hasKey(patch, "lastOdometerKm")
            ? (patch.lastOdometerKm ?? null)
            : (existing.maintenance?.lastOdometerKm ?? null);
          const nextCurrentOdometerKm = hasKey(patch, "currentOdometerKm")
            ? (patch.currentOdometerKm ?? null)
            : (existing.maintenance?.currentOdometerKm ?? null);
          const nextActualCost = hasKey(patch, "actualCost")
            ? (patch.actualCost ?? null)
            : (existing.maintenance?.actualCost ?? null);

          const primaryDate = derivePrimaryDate(nextCurrentMaintenanceDate, existing.createdAt);

          await tx.application.update({
            where: { id },
            data: {
              primaryDate,
              maintenance: {
                update: {
                  lastMaintenanceDate: nextLastMaintenanceDate,
                  currentMaintenanceDate: nextCurrentMaintenanceDate,
                  lastOdometerKm: nextLastOdometerKm,
                  currentOdometerKm: nextCurrentOdometerKm,
                  actualCost: nextActualCost,
                },
              },
            },
          });

          return await tx.application.findUniqueOrThrow({
            where: { id },
            include: maintenanceApplicationInclude,
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (err) {
      lastError = err;

      if (err instanceof AppError) {
        throw err;
      }
      if (!isRetryableTransactionConflict(err)) {
        throw err;
      }
      if (attempt >= UPDATE_DRAFT_MAX_RETRIES) {
        throw new AppError(
          "SERVICE_UNAVAILABLE",
          503,
          "系統忙碌，請稍後再試（儲存時發生資料庫並發衝突，已重試多次仍未成功）"
        );
      }
      await sleep(retryBackoffMs(attempt));
    }
  }

  // Unreachable (loop always returns or throws) — satisfies TypeScript control-flow analysis.
  throw lastError;
}

// ---------------------------------------------------------------------------
// toMaintenanceApplicationDto (§7.2 MaintenanceApplicationDto)
// ---------------------------------------------------------------------------

export interface MaintenanceApplicationDto {
  id: string;
  type: "MAINTENANCE";
  status: string;
  ownerId: string;
  ownerDisplayName: string;
  createdById: string;
  onBehalf: boolean;
  primaryDate: string;
  createdAt: string;
  updatedAt: string;

  lastMaintenanceDate: string | null;
  currentMaintenanceDate: string | null;
  lastOdometerKm: string | null;
  currentOdometerKm: string | null;
  actualCost: string | null;

  attachments: unknown[];
  completionBlockers: Blocker[] | null;
  computed: null;
  snapshot: null;
}

/**
 * Builds the response DTO for a MAINTENANCE application.
 *
 * `attachments`：本 Task 恆為 `[]`（T6 範圍，見檔頭說明）。
 * `computed`：本 Task 恆為 `null`（T5 範圍——期間公務里程尚未接線）。
 * `snapshot`：本 Task 恆為 `null`（T7 範圍——完成流程尚未接線；即使 fixture
 * 直接以 `prisma` 寫入 `status=COMPLETED`，本函式仍不讀取任何
 * `snapshot*` 欄位，因為 DTO 目前完全不宣告這些欄位對應的原始資料——
 * AC-04/AC-05 測試只驗證 403/404，不驗證 COMPLETED 的 `snapshot` 內容）。
 * `completionBlockers`：僅 DRAFT 才計算（COMPLETED 為 `null`，§7.2 明文）；
 * 呼叫 `computeMaintenanceBlockers` 時 `officialKm` 恆傳 `null`（兩段式
 * 第一段，§9.3），`attachmentCount` 恆傳 `0`（T6 範圍）。
 */
export function toMaintenanceApplicationDto(
  application: MaintenanceApplicationRecord
): MaintenanceApplicationDto {
  const maintenance = application.maintenance;
  const isDraft = application.status === "DRAFT";

  const completionBlockers = isDraft
    ? computeMaintenanceBlockers({
        lastMaintenanceDate: maintenance?.lastMaintenanceDate ?? null,
        currentMaintenanceDate: maintenance?.currentMaintenanceDate ?? null,
        lastOdometerKm: maintenance?.lastOdometerKm ?? null,
        currentOdometerKm: maintenance?.currentOdometerKm ?? null,
        actualCost: maintenance?.actualCost ?? null,
        attachmentCount: 0,
        officialKm: null,
      })
    : null;

  return {
    id: application.id,
    type: "MAINTENANCE",
    status: application.status,
    ownerId: application.ownerId,
    ownerDisplayName: application.owner.displayName,
    createdById: application.createdById,
    onBehalf: application.createdById !== application.ownerId,
    primaryDate: formatDateOrNull(application.primaryDate) as string,
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),

    lastMaintenanceDate: formatDateOrNull(maintenance?.lastMaintenanceDate ?? null),
    currentMaintenanceDate: formatDateOrNull(maintenance?.currentMaintenanceDate ?? null),
    lastOdometerKm: formatDecimalOrNull(maintenance?.lastOdometerKm ?? null),
    currentOdometerKm: formatDecimalOrNull(maintenance?.currentOdometerKm ?? null),
    actualCost: formatDecimalOrNull(maintenance?.actualCost ?? null),

    attachments: [],
    completionBlockers,
    computed: null,
    snapshot: null,
  };
}
