/**
 * Maintenance application service — PHASE-006-T4／T5
 *
 * Spec §2 群組 B（AC-02/03/04/05）、群組 D／E（AC-11~20）、§7.2
 * `MaintenanceApplicationDto`／`MaintenanceComputedDto`、§7.3（引擎呼叫）、
 * §9.1「草稿儲存」、§9.2「分攤預覽」、§16 D1(a)（子表模式）/D6(a)（generic
 * complete/內嵌 computed／stateless preview 端點）/D7(a)（僅本人完成）/
 * D11(a)（不另存 snapshotActualCost）。
 *
 * Owns the DB-touching half of the maintenance draft CRUD vertical;
 * `routes.ts` (Fastify plugin) is the thin HTTP layer that calls into this
 * module — same split as `travel-service.ts` + `applications/routes.ts`
 * (T4 Packet「複用既有模式」義務).
 *
 * T4 範圍（Packet 明文）：僅草稿 CRUD＋欄位驗證＋狀態／授權守門（AC-02~05）。
 * T5 範圍（本次擴充）：期間公務里程接線（`computeMaintenanceComputed`，唯一
 * 呼叫 `sumOfficialMileage` 之處，AC-11~15）＋草稿 DTO／預覽端點之 `computed`
 * 填充（AC-16~20 之接線層）。仍**不含**：
 *   - 完成流程與快照寫入（T7）——`snapshot` 恆為 `null`（本 Task 從不轉換
 *     `status` 至 `COMPLETED`；AC-04 測試以直接 `prisma.application.update`
 *     建立 COMPLETED fixture，模擬「未來由 T7 完成」的既有列）。
 *   - 附件關聯（T6）——`attachments` 恆為 `[]`（PUT 不接受 `attachmentIds[]`，
 *     没有任何程式路徑可以把附件關聯到保養申請；`attachmentCount` 傳給
 *     `computeMaintenanceBlockers` 恆為 `0`，故第 10 項
 *     `MAINTENANCE_ATTACHMENT_REQUIRED` 恆出現於五欄齊備但無附件的 DRAFT
 *     之 blockers）。
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
 * 傳遞五個業務欄位；`computeMaintenanceComputed`／`calculateMaintenance`
 * （T2）之 `intervalKm` 為同一公式之獨立計算，兩者互不依賴、互不覆寫。
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { type PrismaLike, sumOfficialMileage } from "../mileage/mileage-engine.js";
import { AppError } from "../platform/errors.js";
import { assertApplicationMutable } from "./application-state-machine.js";
import type { Blocker } from "./maintenance-blockers.js";
import { computeMaintenanceBlockers } from "./maintenance-blockers.js";
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
// computeMaintenanceComputed (§7.2 MaintenanceComputedDto, §7.3 引擎呼叫,
// §9.2 分攤預覽, AC-11~15) — PHASE-006-T5
//
// 唯一呼叫 `sumOfficialMileage` 之處（AC-14：不得在任何檔案重寫過濾條件或
// 加總邏輯）。`db` 之型別為 `PrismaLike`（`PrismaClient | Prisma.TransactionClient`，
// 沿 mileage-engine.ts 既有簽章），使本函式未來（T7）可於同一交易 `tx` 內呼叫。
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

const NOT_CALCULABLE_RESULT: MaintenanceComputedResult = {
  dto: {
    calculable: false,
    intervalKm: null,
    officialKm: null,
    officialApplicationCount: null,
    ratio: null,
    ratioPercent: null,
    rawAmount: null,
    amount: null,
    blockingCodes: [],
  },
  officialKmForBlockers: null,
  amountOutOfRange: false,
  hasAllFields: false,
};

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
    return NOT_CALCULABLE_RESULT;
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
        blockingCodes: [],
      },
      // AC-08 已於上游擋下此輸入（本函式獨立防禦）；此處與 fieldLevelBlockers
      // 之互斥語意呼應，抑制第 9/11 項（見 maintenance-blockers.ts 檔頭）。
      officialKmForBlockers: null,
      amountOutOfRange: false,
      hasAllFields: true,
    };
  }

  const overCapacity = isMaintenanceCalculationOverCapacity(result);
  // AC-18 明文：以 O 與 I 之 Decimal 直接比較，不得以取整後之 ratio 比較。
  const officialExceedsInterval = result.officialKm.greaterThan(result.intervalKm);

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
  computed: MaintenanceComputedDto | null;
  snapshot: null;
}

/**
 * Builds the response DTO for a MAINTENANCE application.
 *
 * `attachments`：本 Task 恆為 `[]`（T6 範圍，見檔頭說明）。
 * `snapshot`：本 Task 恆為 `null`（T7 範圍——完成流程尚未接線；即使 fixture
 * 直接以 `prisma` 寫入 `status=COMPLETED`，本函式仍不讀取任何
 * `snapshot*` 欄位，因為 DTO 目前完全不宣告這些欄位對應的原始資料——
 * AC-04/AC-05 測試只驗證 403/404，不驗證 COMPLETED 的 `snapshot` 內容）。
 * `completionBlockers`：僅 DRAFT 才計算（COMPLETED 為 `null`，§7.2 明文）。
 *
 * `computed`（PHASE-006-T5 起）：呼叫端（見下方 `buildMaintenanceApplicationDto`）
 * 一次呼叫 `computeMaintenanceComputed` 取得期間公務里程與計算結果後，經
 * `computed` 參數傳入——本函式本身**不**碰 DB（T4 即審 FW-T5 節義務：DTO
 * builder 不得偷查 DB）。`computed` 省略、為 `null`，或 `hasAllFields=false`
 * （五欄尚未齊備，連嘗試計算都沒有——沿 §4「分攤預覽」五態表之 Empty 狀態，
 * 與 T4「空 body → computed=null」既有行為逐位元相容）時，對外 `computed`
 * 欄位維持 `null`；`completionBlockers` 之 `officialKm`/`amountOutOfRange`
 * 亦沿用第一段語意（`null`/`false`）。五欄齊備後（無論是否 `calculable`）
 * `computed` 欄位即為非 `null` 之 `MaintenanceComputedDto` 物件。
 */
export function toMaintenanceApplicationDto(
  application: MaintenanceApplicationRecord,
  computed: MaintenanceComputedResult | null = null
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

    attachments: [],
    completionBlockers,
    computed: isDraft && computed?.hasAllFields ? computed.dto : null,
    snapshot: null,
  };
}

// ---------------------------------------------------------------------------
// buildMaintenanceApplicationDto — routes.ts 呼叫的薄編排層（T5）
//
// 「呼叫端一次取得後傳入」之呼叫端本體：COMPLETED 申請**不**查詢期間公務
// 里程（呼應 AC-28 之精神——已完成申請讀取不應觸發任何期間里程查詢；正式
// spy 零重查驗證屬 T8，本函式之設計已提前滿足該不變式）。
// ---------------------------------------------------------------------------

export async function buildMaintenanceApplicationDto(
  db: PrismaLike,
  application: MaintenanceApplicationRecord
): Promise<MaintenanceApplicationDto> {
  if (application.status !== "DRAFT") {
    return toMaintenanceApplicationDto(application, null);
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

  return toMaintenanceApplicationDto(application, computed);
}
