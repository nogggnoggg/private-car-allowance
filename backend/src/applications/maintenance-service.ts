/**
 * Maintenance application service — PHASE-006-T4／T5／T6
 *
 * Spec §2 群組 B（AC-02/03/04/05）、群組 D／E（AC-11~20）、群組 F
 * （AC-21~24 附件）、§7.2 `MaintenanceApplicationDto`／`MaintenanceComputedDto`、
 * §7.3（引擎呼叫）、§9.1「草稿儲存」（含步驟④附件對帳）、§9.2「分攤預覽」、
 * §16 D1(a)（子表模式）/D2(a)（附件容器＝`refId=Application.id`）/D6(a)
 * （generic complete/內嵌 computed／stateless preview 端點）/D7(a)（僅本人
 * 完成）/D11(a)（不另存 snapshotActualCost）。
 *
 * Owns the DB-touching half of the maintenance draft CRUD vertical;
 * `routes.ts` (Fastify plugin) is the thin HTTP layer that calls into this
 * module — same split as `travel-service.ts` + `applications/routes.ts`
 * (T4 Packet「複用既有模式」義務).
 *
 * T4 範圍：僅草稿 CRUD＋欄位驗證＋狀態／授權守門（AC-02~05）。
 * T5 範圍：期間公務里程接線（`computeMaintenanceComputed`，唯一呼叫
 * `sumOfficialMileage` 之處，AC-11~15）＋草稿 DTO／預覽端點之 `computed`
 * 填充（AC-16~20 之接線層）。
 * T6 範圍：`PUT` 之 `attachmentIds[]` 對帳（`reconcileMaintenanceAttachments`，
 * AC-21/22、B-25~B-28）、`MAINTENANCE_ATTACHMENT_LIMIT=5`（AC-21）、DTO
 * 之 `attachments`／`completionBlockers` 第 10 項改讀真實 `LINKED` 計數
 * （`buildMaintenanceApplicationDto` 一次查詢後傳入，T4 即審 FW-T6 節義務：
 * DTO builder 不得偷查 DB）。附件之完成鎖定（`deriveContainerState`）與草稿
 * 刪除 detach 補洞（B-29）落在 `attachment/lifecycle-service.ts` 與
 * `travel-service.ts`（僅 `deleteApplication` 之 detach 範圍），非本檔。
 * T7 範圍（本次擴充，AC-25/26/27/18 整合層）：`completeMaintenanceApplication`
 * ——單一 `SERIALIZABLE` 交易內依序完成狀態機守門 → 完成度驗證（兩段式，
 * §9.3）→ 期間公務里程查詢（同交易呼叫 `sumOfficialMileage`，AC-14）→ 計算
 * → 容量守門 → 快照寫入 → `Application` 狀態轉換；`toMaintenanceApplicationDto`
 * 之 `snapshot` 欄位（COMPLETED 才非 `null`，§7.2 `MaintenanceSnapshotDto`）
 * 亦由本次擴充填入。授權（D7(a)：僅本人，不使用 `assertOwnershipOrAdmin`）
 * 由 `routes.ts` 之路由層判定，本函式本身不做任何授權檢查（與
 * `completeTravelApplication` 同型分工）。
 * 仍**不含**：
 *   - 代操作稽核 hook（T9）——本檔不提供 `onCreated`/`onUpdated` 參數
 *     （與 `travel-service.ts` 不同）；T9 依 Files Allowed 清單將擴充本檔。
 *   - 快照不可變之 spy 零重查證明與後端權威夾帶矩陣、併發恰一成功之正式
 *     斷言（T8，`phase6-snapshot-immutability.test.ts`）——本 Task 只需
 *     完成流程本身之交易切點回滾實證（見下方
 *     `CompleteMaintenanceApplicationOptions.__testOnlyFailAfterSnapshotWrite`）
 *     與 B-30 之單次併發正確性（不得 500、恰一方成功）。
 *
 * 日期精度紀律（B-32／T3 即審 FW-4）：`lastMaintenanceDate`／
 * `currentMaintenanceDate` 一律 UTC 日粒度（`@db.Date`），寫入前經
 * `utcDateOnly` 正規化（沿用 `travel-service.ts` 既有匯出的純函式，不重寫）。
 *
 * `intervalKm` 不設第二來源（T3 即審 FW-3）：本檔從不自行計算或儲存
 * `intervalKm`——`computeMaintenanceBlockers` 內部由
 * `currentOdometerKm − lastOdometerKm` 推導（見該檔文件註解），本檔僅原樣
 * 傳遞五個業務欄位；`computeMaintenanceComputed`／`calculateMaintenance`
 * （T2）之 `intervalKm` 為同一公式之獨立計算，兩者互不依賴、互不覆寫。
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  type AttachmentDto,
  detachAttachmentsByIdsTx,
  linkAttachmentTx,
  toDto as toAttachmentDto,
} from "../attachment/lifecycle-service.js";
import { type PrismaLike, sumOfficialMileage } from "../mileage/mileage-engine.js";
import type { FieldError } from "../platform/errors.js";
import { AppError } from "../platform/errors.js";
import { assertApplicationMutable, assertTransition } from "./application-state-machine.js";
import type { Blocker } from "./maintenance-blockers.js";
import {
  computeMaintenanceBlockers,
  computeMaintenanceStructuralBlockers,
  isOfficialKmExceedsInterval,
} from "./maintenance-blockers.js";
import {
  calculateMaintenance,
  isMaintenanceCalculationOverCapacity,
} from "./maintenance-calculation.js";
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
  /**
   * PHASE-006-T6 (AC-21/22, §9.1 步驟④「附件對帳」)：三態語意與其他欄位不同
   * ——這是一個**宣告式全集**（declarative full set），key 缺席＝不對帳（不
   * 動任何附件關聯）；key 存在＝把目前 LINKED 集合與此陣列做差集，多出者
   * detach、缺少者 link（見 `reconcileMaintenanceAttachments`）。無「清空」
   * 之 `null` 值——空陣列 `[]` 本身就代表「全部 detach」。
   */
  attachmentIds?: string[];
}

// ---------------------------------------------------------------------------
// MAINTENANCE_ATTACHMENT_LIMIT — PHASE-006-T6 (AC-21, Spec §7.1「上限常數…
// 定義於後端且不得由用戶端提供」)
// ---------------------------------------------------------------------------

export const MAINTENANCE_ATTACHMENT_LIMIT = 5;

// ---------------------------------------------------------------------------
// reconcileMaintenanceAttachments — PHASE-006-T6 (AC-21/22, B-25~B-28)
//
// Single-container declarative reconciliation: unlike travel-service.ts's
// per-segment `computeAttachmentDeltas`/`applyAttachmentDeltas` (which must
// handle attachments moving BETWEEN several segments in one PUT), a
// MaintenanceApplication has exactly one container (`refId = Application.id`
// itself, Spec §16 D2(a)) — so the diff is a plain set difference against the
// single currently-LINKED set. Detach-then-link ordering is kept anyway
// (mirrors the travel pattern) so re-declaring the exact same id set is a
// true no-op and any request-order assumption elsewhere is not violated.
//
// MUST be called inside the SAME transaction as the rest of
// `updateMaintenanceDraft`'s write (its business-field update) so that a
// TOO_MANY_ATTACHMENTS/403/409 thrown here rolls back the whole PUT
// (AC-21: "整份儲存 rollback（附件與業務欄位皆不變）").
// ---------------------------------------------------------------------------

async function reconcileMaintenanceAttachments(
  tx: Prisma.TransactionClient,
  applicationId: string,
  applicationOwnerId: string,
  requestedIds: string[]
): Promise<void> {
  const currentRows = await tx.attachment.findMany({
    where: { refType: "MAINTENANCE", refId: applicationId, status: "LINKED" },
    select: { id: true },
  });
  const current = new Set(currentRows.map((row) => row.id));
  const requested = new Set(requestedIds);

  const toRemove = [...current].filter((attachmentId) => !requested.has(attachmentId));
  const toLink = requestedIds.filter((attachmentId) => !current.has(attachmentId));

  if (toRemove.length > 0) {
    await detachAttachmentsByIdsTx(tx, toRemove);
  }

  for (const attachmentId of toLink) {
    // B-27/B-28 per-attachment checks (same shape as travel-service.ts's
    // `applyAttachmentDeltas` link pass — not imported/reused across files
    // because that function is segment-refType-specific and not exported;
    // this is the same three checks, independently applied to refType=MAINTENANCE).
    const attachment = await tx.attachment.findUnique({ where: { id: attachmentId } });
    if (!attachment) {
      throw new AppError("NOT_FOUND", 404, "找不到附件");
    }
    if (attachment.ownerId !== applicationOwnerId) {
      throw new AppError("FORBIDDEN", 403, "附件擁有人與申請擁有人不一致，無法關聯");
    }
    if (attachment.status !== "TEMP") {
      throw new AppError("CONFLICT", 409, "附件已關聯，無法重複關聯");
    }

    // AC-21: `linkAttachmentTx` recomputes the live LINKED count for this
    // (refType, refId) container on every call inside this same transaction,
    // so the 6th call in a single PUT declaring 6 new ids correctly sees
    // count=5 and throws TOO_MANY_ATTACHMENTS (B-26), rolling back the tx.
    await linkAttachmentTx(tx, {
      attachmentId,
      refType: "MAINTENANCE",
      refId: applicationId,
      limit: MAINTENANCE_ATTACHMENT_LIMIT,
    });
  }
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
 * （§9.1 步驟；本函式含附件對帳（T6）；不含代操作稽核 hook（T9），見檔頭說明）。
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
              ownerId: true,
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

          // AC-21/22 附件對帳（key 缺席＝不對帳，見 `UpdateMaintenanceDraftPatch`
          // 文件註解）：與上面的業務欄位寫入同一交易，任一附件錯誤（404/403/
          // 409）皆使整份 PUT（含業務欄位）一併回滾。
          if (hasKey(patch, "attachmentIds")) {
            await reconcileMaintenanceAttachments(
              tx,
              id,
              existing.ownerId,
              patch.attachmentIds ?? []
            );
          }

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
// computeMaintenanceComputed (§7.2 MaintenanceComputedDto, §7.3 引擎呼叫,
// §9.2 分攤預覽, AC-11~15) — PHASE-006-T5
//
// 草稿/預覽路徑之呼叫點；完成路徑於 completeMaintenanceApplication 同 tx
// 另有一處（AC-14：不得在任何檔案重寫過濾條件或加總邏輯）。`db` 之型別為
// `PrismaLike`（`PrismaClient | Prisma.TransactionClient`，沿 mileage-engine.ts
// 既有簽章），使本函式可於草稿/預覽（非 tx）與完成流程（同一交易 `tx`）
// 兩種呼叫端下皆可運作。
//
// 本函式本身即為「呼叫端」（§9.1/9.2 pseudocode 之編排層），负责一次取得
// 期間公務里程並往下傳給純函式 `calculateMaintenance`；`toMaintenanceApplicationDto`
// （下方）維持零 DB 存取，只接收本函式算好的結果（T4 即審 FW-T5 節義務）。
// ---------------------------------------------------------------------------

export interface MaintenanceComputedDto {
  calculable: boolean;
  intervalKm: string | null;
  officialKm: string | null;
  officialApplicationCount: number | null;
  ratio: string | null;
  ratioPercent: string | null;
  rawAmount: string | null;
  amount: number | null;
  blockingCodes: string[];
}

/**
 * 內部結果：對外 DTO（`dto`）＋ 餵給 `computeMaintenanceBlockers` 兩段式第二段
 * 所需的原始值（`officialKmForBlockers`：非 `null` 時代表「已查詢」；
 * `amountOutOfRange`：第 11 項旗標）。兩者分離是因為 `computeMaintenanceBlockers`
 * 需要未取整之 `Prisma.Decimal`（用於 `O`/`I` 直接比較，AC-18 明文禁止以
 * 取整後之字串比較），而對外 DTO 一律為固定小數字串（§7.2）。
 */
export interface MaintenanceComputedResult {
  dto: MaintenanceComputedDto;
  officialKmForBlockers: Prisma.Decimal | null;
  amountOutOfRange: boolean;
  /**
   * `true` 一旦五欄業務資料皆齊備（已嘗試計算，無論結果是否
   * `calculable`）；`false` 表「尚未齊備，連嘗試都沒有」——用於
   * `toMaintenanceApplicationDto` 決定草稿 DTO 之 `computed` 是否維持
   * `null`（沿 §4「分攤預覽」五態表「欄位未齊 → 非錯誤之 Empty 狀態」，
   * 與 T4 既有「空 body → computed=null」行為逐位元相容——本欄位存在
   * 之前，T4 的 DTO 建構者本就恆傳 `null`，本次只在「五欄齊備」時才
   * 首次改變其值）。預覽端點（`preview.dto`）不受本欄位影響——契約
   * 要求 stateless 預覽恆回傳一個 `MaintenanceComputedDto` 物件。
   */
  hasAllFields: boolean;
}

export interface ComputeMaintenanceComputedInput {
  /** 絕不可為操作者（管理員代操作時亦為擁有人）——AC-14 明文。 */
  ownerId: string;
  lastMaintenanceDate: Date | null;
  currentMaintenanceDate: Date | null;
  lastOdometerKm: Prisma.Decimal | null;
  currentOdometerKm: Prisma.Decimal | null;
  actualCost: Prisma.Decimal | null;
}

function formatRawAmountOrNull(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed(4);
}

/**
 * 「欄位未齊」之不可計算結果（PHASE-006-T5R SF-2 修復）：`blockingCodes`
 * 依當下傳入之五欄現況，重用 `computeMaintenanceStructuralBlockers`（§7.4
 * 第 1~8 項結構性判定，與 `computeMaintenanceBlockers` 內部第一段同一份
 * 實作）計算，**不**回傳固定空陣列——沿 §7.2 `blockingCodes` 定義「不可
 * 計算之原因代碼」，欄位未齊本身即為原因，應可見對應 `*_REQUIRED`／
 * `*_ORDER_INVALID` 碼。
 *
 * （T5R 即審 AR-1 一併修復）本函式**逐請求建構**新物件，不再回傳模組級
 * 共用單例——原 `NOT_CALCULABLE_RESULT` 為模組級可變常數，各請求共享同一
 * 物件參照；本次修復使 `blockingCodes` 依請求輸入而異，若繼續共用同一
 * 物件將導致跨請求污染（同一參照被不同呼叫端各自解讀成不同語意）。
 */
function buildFieldsIncompleteResult(
  input: Pick<
    ComputeMaintenanceComputedInput,
    | "lastMaintenanceDate"
    | "currentMaintenanceDate"
    | "lastOdometerKm"
    | "currentOdometerKm"
    | "actualCost"
  >
): MaintenanceComputedResult {
  const structuralBlockers = computeMaintenanceStructuralBlockers(input);
  return {
    dto: {
      calculable: false,
      intervalKm: null,
      officialKm: null,
      officialApplicationCount: null,
      ratio: null,
      ratioPercent: null,
      rawAmount: null,
      amount: null,
      blockingCodes: structuralBlockers.map((b) => b.code),
    },
    officialKmForBlockers: null,
    amountOutOfRange: false,
    hasAllFields: false,
  };
}

/**
 * 計算保養分攤預覽（AC-11~20 之核心編排）。五欄任一為 `null`（未齊）→
 * `calculable=false`，**不查詢**期間公務里程（避免無意義的 DB 呼叫）。
 *
 * 五欄齊備時：`sumOfficialMileage(db, { ownerId, dateFrom: lastMaintenanceDate,
 * dateTo: currentMaintenanceDate })`（§7.3 逐字呼叫形狀）→
 * `calculateMaintenance(...)`（T2 引擎）→ 容量守門（`isMaintenanceCalculationOverCapacity`）。
 *
 * 容量超出（AC-19a）：`calculable=false`、`rawAmount`/`amount` 為 `null`
 * （不可信之溢位值不對外呈現），但 `intervalKm`/`officialKm`/`ratio` 仍如實
 * 呈現（供使用者核對里程與比例，呼應 blocker 文案「請檢查里程與費用」）。
 */
export async function computeMaintenanceComputed(
  db: PrismaLike,
  input: ComputeMaintenanceComputedInput
): Promise<MaintenanceComputedResult> {
  const {
    ownerId,
    lastMaintenanceDate,
    currentMaintenanceDate,
    lastOdometerKm,
    currentOdometerKm,
    actualCost,
  } = input;

  if (
    lastMaintenanceDate === null ||
    currentMaintenanceDate === null ||
    lastOdometerKm === null ||
    currentOdometerKm === null ||
    actualCost === null
  ) {
    return buildFieldsIncompleteResult({
      lastMaintenanceDate,
      currentMaintenanceDate,
      lastOdometerKm,
      currentOdometerKm,
      actualCost,
    });
  }

  // AC-14：唯一呼叫點；ownerId 恆為呼叫端傳入之擁有人，本函式從不讀取
  // 「操作者」身分（本函式甚至不知道誰在呼叫，只知道要問誰的里程）。
  const { totalKm, applicationCount } = await sumOfficialMileage(db, {
    ownerId,
    dateFrom: lastMaintenanceDate,
    dateTo: currentMaintenanceDate,
  });

  const result = calculateMaintenance({
    lastOdometerKm,
    currentOdometerKm,
    officialKm: totalKm,
    actualCost,
  });

  if (!result.calculable) {
    // PHASE-006-T5R SF-2 修復：五欄皆非 null（已通過上方 guard），
    // `calculable=false` 於此僅可能因 `intervalKm ≤ 0`（含相等，同
    // `ODOMETER_ORDER_INVALID` 條件）或防禦性非有限值——重用同一份結構性
    // 判定（`computeMaintenanceStructuralBlockers`）填充 `blockingCodes`，
    // 不再回傳固定空陣列，亦不另寫第三份 `intervalKm ≤ 0` 判定。
    const structuralBlockers = computeMaintenanceStructuralBlockers({
      lastMaintenanceDate,
      currentMaintenanceDate,
      lastOdometerKm,
      currentOdometerKm,
      actualCost,
    });
    return {
      dto: {
        calculable: false,
        intervalKm: formatDecimalOrNull(result.intervalKm),
        officialKm: formatDecimalOrNull(result.officialKm),
        officialApplicationCount: applicationCount,
        ratio: null,
        ratioPercent: null,
        rawAmount: null,
        amount: null,
        blockingCodes: structuralBlockers.map((b) => b.code),
      },
      // AC-08 已於上游擋下此輸入（本函式獨立防禦）；此處與 fieldLevelBlockers
      // 之互斥語意呼應，抑制第 9/11 項（見 maintenance-blockers.ts 檔頭）。
      officialKmForBlockers: null,
      amountOutOfRange: false,
      hasAllFields: true,
    };
  }

  const overCapacity = isMaintenanceCalculationOverCapacity(result);
  // AC-18 明文：以 O 與 I 之 Decimal 直接比較，不得以取整後之 ratio 比較——
  // 共用 predicate（PHASE-006-T5R SF-1：單一事實來源，見
  // `maintenance-blockers.ts` 之 `isOfficialKmExceedsInterval` 文件註解）。
  const officialExceedsInterval = isOfficialKmExceedsInterval(result.officialKm, result.intervalKm);

  const blockingCodes: string[] = [];
  if (officialExceedsInterval) blockingCodes.push("OFFICIAL_KM_EXCEEDS_INTERVAL");
  if (overCapacity) blockingCodes.push("AMOUNT_OUT_OF_RANGE");

  return {
    dto: {
      calculable: !overCapacity,
      intervalKm: formatDecimalOrNull(result.intervalKm),
      officialKm: formatDecimalOrNull(result.officialKm),
      officialApplicationCount: applicationCount,
      ratio: result.ratioString,
      ratioPercent: result.ratioPercentString,
      rawAmount: overCapacity ? null : formatRawAmountOrNull(result.rawAmount),
      amount: overCapacity ? null : result.amount,
      blockingCodes,
    },
    officialKmForBlockers: totalKm,
    amountOutOfRange: overCapacity,
    hasAllFields: true,
  };
}

// ---------------------------------------------------------------------------
// toMaintenanceApplicationDto (§7.2 MaintenanceApplicationDto)
// ---------------------------------------------------------------------------

/**
 * §7.2 `MaintenanceSnapshotDto`（AC-26：BE-US-18 逐字五項 ＋ `rawAmount` ＋
 * `calculatedAt`）。`actualCost` 為 D11(a) 之「不另存 `snapshotActualCost`」
 * 落地——直接讀 `MaintenanceApplication.actualCost` 欄位本身（完成後由狀態機
 * 凍結不可改，凍結保證＝快照保證，見 Spec D11(a)）。
 */
export interface MaintenanceSnapshotDto {
  intervalKm: string; // 2 位小數
  officialKm: string; // 2 位小數
  ratio: string; // 6 位小數
  ratioPercent: string; // 4 位小數（＝ ratio × 100，逐位元由 6dp snapshotRatio 推導，見 completeMaintenanceApplication 文件註解）
  actualCost: string; // 2 位小數（＝完成當時之欄位值，D11(a)）
  rawAmount: string; // 4 位小數，取整前
  totalAmount: number; // 整數（＝ Application.totalAmount）
  calculatedAt: string; // ISO8601
}

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

  attachments: AttachmentDto[];
  completionBlockers: Blocker[] | null;
  computed: MaintenanceComputedDto | null;
  snapshot: MaintenanceSnapshotDto | null;
}

/**
 * 建構 `MaintenanceSnapshotDto`（AC-26）。僅 `status="COMPLETED"` 時非
 * `null`（§7.2 明文）。`ratioPercent` 由已持久化之 `snapshotRatio`（6dp）
 * ×100 推導而非另讀一個獨立欄位——schema 未另存 `snapshotRatioPercent`
 * （§8.2），且 6dp 值 ×100 為單純小數點位移，不產生第二次捨入（100 ＝
 * 10^2，位移 2 位小數點恰對應 6dp→4dp，數學上與直接對未捨入比例
 * 取 4dp 結果逐位元相同）。
 *
 * T7R S-1 修復：五個 snapshot* 欄位 ＋ `calculatedAt` ＋
 * `Application.totalAmount` 逐欄 `!= null` 守門後才組裝，任一缺席即回傳
 * `null`——沿 `travel-service.ts` 之 `toTravelApplicationDto` 既有慣例（該檔
 * `snapshot` 建構前之逐欄非 null 判定）。`status="COMPLETED"` 但快照欄位仍
 * 為 null 的列（例如測試直接以 Prisma 撥動 `status` 而未經
 * `completeMaintenanceApplication` 寫入快照）先前會在此處以 `as
 * Prisma.Decimal` 轉型後呼叫 `.toFixed()` 於 `null` 上而 500；修復後與 T4
 * 既有「未齊備 → Empty 狀態」精神一致，優雅回傳 `null`。
 */
function buildSnapshotDto(
  application: MaintenanceApplicationRecord
): MaintenanceSnapshotDto | null {
  const maintenance = application.maintenance;
  if (
    application.status !== "COMPLETED" ||
    !maintenance ||
    maintenance.snapshotIntervalKm == null ||
    maintenance.snapshotOfficialKm == null ||
    maintenance.snapshotRatio == null ||
    maintenance.snapshotRawAmount == null ||
    maintenance.actualCost == null ||
    maintenance.calculatedAt == null ||
    application.totalAmount == null
  ) {
    return null;
  }
  const snapshotRatio = maintenance.snapshotRatio;
  return {
    intervalKm: maintenance.snapshotIntervalKm.toFixed(2),
    officialKm: maintenance.snapshotOfficialKm.toFixed(2),
    ratio: snapshotRatio.toFixed(6),
    ratioPercent: snapshotRatio.times(100).toFixed(4),
    actualCost: maintenance.actualCost.toFixed(2),
    rawAmount: maintenance.snapshotRawAmount.toFixed(4),
    totalAmount: application.totalAmount,
    calculatedAt: maintenance.calculatedAt.toISOString(),
  };
}

/**
 * Builds the response DTO for a MAINTENANCE application.
 *
 * `attachments`（PHASE-006-T6 起）：呼叫端（見下方 `buildMaintenanceApplicationDto`）
 * 一次查得真實 `LINKED` 附件列表後，經 `attachments` 參數傳入——本函式本身
 * **不**碰 DB（T4 即審 FW-T6 節義務：DTO builder 不得偷查 DB）；省略時預設
 * `[]`（與 T4/T5 之既有行為相容）。
 * `snapshot`（PHASE-006-T7 起）：`status="COMPLETED"` 時由 `buildSnapshotDto`
 * 讀取 `maintenance.snapshotIntervalKm`/`snapshotOfficialKm`/`snapshotRatio`/
 * `snapshotRawAmount`/`calculatedAt`（`completeMaintenanceApplication` 寫入）
 * ＋ `actualCost`（凍結欄位本身，D11(a)）＋ `Application.totalAmount` 組裝
 * 為 `MaintenanceSnapshotDto`（AC-26）；`status="DRAFT"` 恆為 `null`。
 * `completionBlockers`：僅 DRAFT 才計算（COMPLETED 為 `null`，§7.2 明文）；
 * 第 10 項 `attachmentCount`（PHASE-006-T6 起）＝ `attachments.length`（本函式
 * 只查詢 `status="LINKED"` 之附件，故 `.length` 即為 AC-22 之真實計數）。
 *
 * `computed`（PHASE-006-T5 起）：呼叫端一次呼叫 `computeMaintenanceComputed`
 * 取得期間公務里程與計算結果後，經 `computed` 參數傳入。`computed` 省略、為
 * `null`，或 `hasAllFields=false`（五欄尚未齊備，連嘗試計算都沒有——沿 §4
 * 「分攤預覽」五態表之 Empty 狀態，與 T4「空 body → computed=null」既有行為
 * 逐位元相容）時，對外 `computed` 欄位維持 `null`；`completionBlockers` 之
 * `officialKm`/`amountOutOfRange` 亦沿用第一段語意（`null`/`false`）。五欄
 * 齊備後（無論是否 `calculable`）`computed` 欄位即為非 `null` 之
 * `MaintenanceComputedDto` 物件。
 */
export function toMaintenanceApplicationDto(
  application: MaintenanceApplicationRecord,
  computed: MaintenanceComputedResult | null = null,
  attachments: AttachmentDto[] = []
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
        attachmentCount: attachments.length,
        officialKm: computed?.officialKmForBlockers ?? null,
        amountOutOfRange: computed?.amountOutOfRange ?? false,
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

    attachments,
    completionBlockers,
    computed: isDraft && computed?.hasAllFields ? computed.dto : null,
    snapshot: buildSnapshotDto(application),
  };
}

// ---------------------------------------------------------------------------
// buildMaintenanceApplicationDto — routes.ts 呼叫的薄編排層（T5／T6）
//
// 「呼叫端一次取得後傳入」之呼叫端本體：COMPLETED 申請**不**查詢期間公務
// 里程（呼應 AC-28 之精神——已完成申請讀取不應觸發任何期間里程查詢；正式
// spy 零重查驗證屬 T8，本函式之設計已提前滿足該不變式）。
//
// PHASE-006-T6：一次查詢真實 `LINKED` 附件（`refType="MAINTENANCE"`,
// `refId=application.id`）並映射為 `AttachmentDto[]`——DRAFT／COMPLETED 皆
// 查（已完成之保養詳情頁仍需顯示證明縮圖，AC-26），差異僅在是否另查
// `computed`。
// ---------------------------------------------------------------------------

export async function buildMaintenanceApplicationDto(
  db: PrismaLike,
  application: MaintenanceApplicationRecord
): Promise<MaintenanceApplicationDto> {
  const attachmentRows = await db.attachment.findMany({
    where: { refType: "MAINTENANCE", refId: application.id, status: "LINKED" },
  });
  const attachments = attachmentRows.map(toAttachmentDto);

  if (application.status !== "DRAFT") {
    return toMaintenanceApplicationDto(application, null, attachments);
  }

  const maintenance = application.maintenance;
  const computed = await computeMaintenanceComputed(db, {
    ownerId: application.ownerId,
    lastMaintenanceDate: maintenance?.lastMaintenanceDate ?? null,
    currentMaintenanceDate: maintenance?.currentMaintenanceDate ?? null,
    lastOdometerKm: maintenance?.lastOdometerKm ?? null,
    currentOdometerKm: maintenance?.currentOdometerKm ?? null,
    actualCost: maintenance?.actualCost ?? null,
  });

  return toMaintenanceApplicationDto(application, computed, attachments);
}

// ---------------------------------------------------------------------------
// completeMaintenanceApplication — PHASE-006-T7 (AC-25/26/27, AC-18 整合層)
//
// §9.3「完成與快照寫入」逐字流程，單一 SERIALIZABLE 交易：
//   ① assertTransition(status, "COMPLETED")            — 非 DRAFT → 403（狀態機單一事實來源）
//   ② attachmentCount = tx 內現算（FW-1：不得沿用交易外 DTO 結果，B-30 write-skew 防禦）
//      firstPassBlockers = computeMaintenanceBlockers({ ..., officialKm: null })
//        （§7.4 第 1~8、10 項；officialKm=null 完全抑制第 9/11 項——兩段式
//        第一段，尚未查詢期間公務里程）；非空 → 400，**不**執行 ③。
//   ③ sumOfficialMileage(tx, {...})                     — 同一交易（AC-14，FW-3）
//   ④ calculateMaintenance(...) → isMaintenanceCalculationOverCapacity(...)
//        （FW-4：與草稿/預覽共用同一 predicate，勿另寫）
//      secondPassBlockers = computeMaintenanceBlockers({ ..., officialKm: totalKm,
//        amountOutOfRange: overCapacity })              — 兩段式第二段（FW-6：
//        交易內重算，不沿用 DRAFT DTO 快照）；非空 → 400，**寫入前**拒絕
//        （容量超出／比例超容量絕不寫快照）。
//   ⑤a MaintenanceApplication 五個快照欄位（FW-5：snapshotRawAmount 顯式
//       toFixed(4)、snapshotRatio 顯式 ratioString 6dp——防 Postgres 靜默第二次
//       取整；snapshotIntervalKm/snapshotOfficialKm 直接寫 Decimal 全精度值，
//       兩者天然只有 2dp（差旅/里程表來源皆 Decimal(_,2)），無第二次取整風險）
//   ⑤b Application.status/totalAmount/completedAt
//
// 授權（D7(a)）不在本函式判定——`routes.ts` 於呼叫本函式「前」已完成嚴格
// `actor.id === ownerId` 判定（與 `completeTravelApplication` 同型分工，見
// 該函式文件註解「D17: this function has NO owner/admin distinction」）。
// ---------------------------------------------------------------------------

export interface CompleteMaintenanceApplicationOptions {
  /**
   * TEST-ONLY 失敗切點（AC-25 原子性鑑別力測試需要）：於快照寫入（⑤a）之後、
   * 狀態轉換（⑤b）之前呼叫。預設 no-op；生產路徑（`routes.ts`）從不傳入此
   * 選項——與 `completeTravelApplication` 之
   * `__testOnlyFailAfterSnapshotWrite` 同型（見 travel-service.ts 文件註解）。
   */
  __testOnlyFailAfterSnapshotWrite?: () => void;
}

const COMPLETE_MAINTENANCE_MAX_RETRIES = 6;

function throwMaintenanceBlockersError(blockers: Blocker[]): never {
  // §7.4 完成端點拒絕形狀：400 VALIDATION_ERROR + fields[]（僅具欄位路徑者）
  // + details.blockers[]（永遠是完整清單），沿 PHASE-004 D14(i) 既有形狀。
  const fields: FieldError[] = [];
  for (const b of blockers) {
    if (typeof b.field === "string") {
      fields.push({ field: b.field, reason: b.message });
    }
  }
  throw new AppError(
    "VALIDATION_ERROR",
    400,
    "尚未符合完成條件，請檢查標示項目後再試一次。",
    fields,
    { blockers }
  );
}

/**
 * Completes a MAINTENANCE draft: state-machine gate → completeness
 * validation (two-phase, §9.3) → period official-mileage query (SAME
 * transaction, AC-14) → calculation + capacity guard → snapshot write →
 * status transition — all inside ONE SERIALIZABLE transaction (AC-25: any
 * failure at any step rolls back everything, including the snapshot write in
 * the SAME transaction attempt).
 *
 * Concurrency (B-30): SERIALIZABLE + retry-on-conflict, identical pattern to
 * `updateMaintenanceDraft`/`completeTravelApplication`. A concurrent
 * `DELETE /attachments/:id` racing this function's `attachmentCount` read
 * forms the same write-skew shape already documented for
 * `completeTravelApplication` vs `deleteAttachment` (see
 * `lifecycle-service.ts`'s `deleteAttachment` doc comment) — Postgres SSI
 * detects the cycle and aborts one side; the aborted side retries against a
 * fresh snapshot. Two concurrent completions of the same draft: the loser's
 * retry re-reads `status=COMPLETED` (written by the winner) and
 * `assertTransition` throws 403 FORBIDDEN.
 */
export async function completeMaintenanceApplication(
  prisma: PrismaClient,
  id: string,
  options: CompleteMaintenanceApplicationOptions = {}
): Promise<MaintenanceApplicationRecord> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= COMPLETE_MAINTENANCE_MAX_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          // Table name quoted for Postgres case-sensitivity — same pattern as
          // updateMaintenanceDraft/completeTravelApplication's row lock.
          await tx.$queryRaw`SELECT "id" FROM "Application" WHERE "id" = ${id} FOR UPDATE`;

          const existing = await tx.application.findUniqueOrThrow({
            where: { id },
            select: {
              status: true,
              ownerId: true,
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

          // Step ①: state-machine gate (single source of truth). Non-DRAFT
          // (already COMPLETED, or the theoretically-unreachable VOIDED) →
          // 403 FORBIDDEN.
          assertTransition(existing.status, "COMPLETED");

          const maintenance = existing.maintenance;

          // FW-1: 附件計數於完成交易內現算（FOR UPDATE 鎖後同 tx count）——
          // 不得沿用交易外的 DTO 結果（write-skew 防禦，B-30）。
          const attachmentCount = await tx.attachment.count({
            where: { refType: "MAINTENANCE", refId: id, status: "LINKED" },
          });

          // Step ②（第一段，§9.3）：officialKm=null 完全抑制第 9/11 項——
          // 尚未查詢期間公務里程即可判定之結構性條件（1~8、10）。非空即拒
          // 絕，不執行下方的期間里程查詢。
          const firstPassBlockers = computeMaintenanceBlockers({
            lastMaintenanceDate: maintenance?.lastMaintenanceDate ?? null,
            currentMaintenanceDate: maintenance?.currentMaintenanceDate ?? null,
            lastOdometerKm: maintenance?.lastOdometerKm ?? null,
            currentOdometerKm: maintenance?.currentOdometerKm ?? null,
            actualCost: maintenance?.actualCost ?? null,
            attachmentCount,
            officialKm: null,
          });

          if (firstPassBlockers.length > 0) {
            throwMaintenanceBlockersError(firstPassBlockers);
          }

          // firstPassBlockers.length===0 已保證五欄皆非 null 且順序合法
          // （§7.4 第 1~8 項全通過）。
          const lastMaintenanceDate = maintenance?.lastMaintenanceDate as Date;
          const currentMaintenanceDate = maintenance?.currentMaintenanceDate as Date;
          const lastOdometerKm = maintenance?.lastOdometerKm as Prisma.Decimal;
          const currentOdometerKm = maintenance?.currentOdometerKm as Prisma.Decimal;
          const actualCost = maintenance?.actualCost as Prisma.Decimal;

          // Step ③: 期間公務里程查詢——AC-14 明文：唯一呼叫點，同一交易
          // （FW-3），ownerId 恆為擁有人（絕不為操作者）。
          const { totalKm } = await sumOfficialMileage(tx, {
            ownerId: existing.ownerId,
            dateFrom: lastMaintenanceDate,
            dateTo: currentMaintenanceDate,
          });

          // Step ④: 計算引擎（T2，逐字複用）+ 容量守門（與草稿/預覽共用同一
          // predicate，FW-4：勿另寫）。
          const result = calculateMaintenance({
            lastOdometerKm,
            currentOdometerKm,
            officialKm: totalKm,
            actualCost,
          });

          if (!result.calculable) {
            // Unreachable in practice: firstPassBlockers 已保證
            // currentOdometerKm > lastOdometerKm（ODOMETER_ORDER_INVALID 已
            // 擋下相反情形），故 intervalKm 恆為正且有限。Defensive only。
            throw new AppError("INTERNAL_ERROR", 500, "計算結果異常，請聯絡管理員");
          }

          const overCapacity = isMaintenanceCalculationOverCapacity(result);

          // Step ②（第二段，§9.3）：officialKm 已查詢，重算 blockers 以取得
          // 第 9（OFFICIAL_KM_EXCEEDS_INTERVAL）/11（AMOUNT_OUT_OF_RANGE）
          // 項——交易內重算（FW-6），不沿用 DRAFT DTO 之舊快照。任一超容量／
          // 比例超出 → 400，寫入前拒絕（絕不寫入部分快照）。
          const secondPassBlockers = computeMaintenanceBlockers({
            lastMaintenanceDate,
            currentMaintenanceDate,
            lastOdometerKm,
            currentOdometerKm,
            actualCost,
            attachmentCount,
            officialKm: totalKm,
            amountOutOfRange: overCapacity,
          });

          if (secondPassBlockers.length > 0) {
            throwMaintenanceBlockersError(secondPassBlockers);
          }

          // Step ⑤a: 快照寫入（FW-5，顯式定精度）。
          const calculatedAt = new Date();
          const snapshotRawAmount = new Prisma.Decimal(
            (result.rawAmount as Prisma.Decimal).toFixed(4)
          );
          const snapshotRatio = new Prisma.Decimal(result.ratioString as string);

          await tx.maintenanceApplication.update({
            where: { applicationId: id },
            data: {
              snapshotIntervalKm: result.intervalKm,
              snapshotOfficialKm: result.officialKm,
              snapshotRatio,
              snapshotRawAmount,
              calculatedAt,
            },
          });

          // TEST-ONLY injection point — see
          // `CompleteMaintenanceApplicationOptions` doc comment. Everything
          // written above (the snapshot) must roll back together with the
          // status flip below if this throws.
          options.__testOnlyFailAfterSnapshotWrite?.();

          // Step ⑤b: Application status transition — LAST write.
          await tx.application.update({
            where: { id },
            data: {
              status: "COMPLETED",
              totalAmount: result.amount,
              completedAt: calculatedAt,
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

      // Business errors (403/400/etc.) and the test-only injected error
      // propagate immediately — never retried.
      if (err instanceof AppError) {
        throw err;
      }

      if (!isRetryableTransactionConflict(err)) {
        throw err;
      }

      if (attempt >= COMPLETE_MAINTENANCE_MAX_RETRIES) {
        throw new AppError(
          "SERVICE_UNAVAILABLE",
          503,
          "系統忙碌，請稍後再試（完成申請時發生資料庫並發衝突，已重試多次仍未成功）"
        );
      }
      await sleep(retryBackoffMs(attempt));
    }
  }

  // Unreachable (loop always returns or throws) — satisfies TypeScript control-flow analysis.
  throw lastError;
}
