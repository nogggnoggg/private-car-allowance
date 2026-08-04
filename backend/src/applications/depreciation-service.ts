/**
 * Annual depreciation application service — PHASE-007-T4
 *
 * Spec `docs/specs/PHASE-007.md` §2 群組 B（AC-02/03/04/05）、§6.1 授權矩陣
 * 第 1~4 列、§7.1 端點總表、§7.2 `DepreciationApplicationDto`／
 * `DepreciationSnapshotDto`、§7.5（草稿階段之兩段式第一段）、§9.1「草稿儲存
 * （含附件對帳）」、§16 D1(a)（子表模式）／D2(a)（`primaryDate` 推導、附件容器
 * ＝ `refId = Application.id`）／D8（推導三值不外露）。
 *
 * 分工（沿 `travel-service.ts` ＋ `applications/routes.ts`、
 * `maintenance-service.ts` 之既有切法）：本檔擁有折舊草稿的 DB 面，
 * `routes.ts`（Fastify plugin）是薄 HTTP 層，負責認證／授權／欄位格式驗證後
 * 呼叫本檔。授權判定一律在 `routes.ts`（以 DB 載入之 `ownerId` 為權威），本檔
 * 不知道「誰在呼叫」。
 *
 * ── 本 Task（T4）範圍 ───────────────────────────────────────────────────
 *   建立／讀取／更新折舊草稿、`attachmentIds[]` 對帳（AC-04 逐字：「於同一
 *   交易內完成」）、SERIALIZABLE ＋ `FOR UPDATE` ＋ 交易內二次守門（006 M-2
 *   紀律）、DTO 組裝（含 `completionBlockers` 與 `snapshot` 之讀取映射）。
 *
 * ── 本 Task 明示留白（不提前實作半套，Packet FW-3 認知） ────────────────
 *   - `computed`（`DepreciationComputedDto`）：其內容需要年度公務里程（T6）
 *     與參數選版／單價（T7）。**PHASE-007-T6 已落地其年度里程部分**
 *     （`computeDepreciationComputed`，供 `POST /applications/depreciation/
 *     preview` 使用）；申請 DTO 之 `computed` 欄位仍恆回 `null`，其填充屬
 *     T7（Spec §15 T7 列「預覽端點 ＋ `computed`」）。T7 落地時必須以
 *     `pure.calculable && !overCapacity` 合成 `calculable`，**不得**由
 *     `completionBlockers.length === 0` 反推（T3 即審 FW-3：附件缺漏會抑制
 *     第 3/4 碼，空清單 ≠ 可計算）。
 *   - `duplicateYearNotice`（AC-07）：**PHASE-007-T5 已落地**（見
 *     `computeDuplicateYearNotice`／`buildDepreciationApplicationDto`）。
 *   - 完成流程與快照寫入（AC-27~30）：屬 T9；本檔只讀取快照欄位組 DTO。
 *   - 附件上限 5 之正式斷言、完成鎖定、跨使用者掛入之封閉（AC-23/25/26）：
 *     屬 T8。本檔已於對帳時傳入上限常數與三道 per-attachment 檢查（沿保養
 *     既有模式），T8 只需補齊測試與 `deriveContainerState` 之擴充。
 *
 * ── 兩段式 blocker 之呼叫紀律（T3 即審 FW-5） ──────────────────────────
 *   草稿階段尚未查詢年度里程與參數，故 `officialKm`／`perKmUnitPrice`
 *   **同不給**（兩者皆省略），使 `computeDepreciationBlockers` 完全抑制第
 *   3、4 碼。這是本檔唯一的 blocker 組裝點（單一組裝點義務）。
 *
 * ── 年度值域 ───────────────────────────────────────────────────────────
 *   `[1900, 2999]`（§16 D3(a)）之驗證 **100% 落在 `routes.ts` 的
 *   `parseApplicationYearField`**（T1 FW-4：DB 無 CHECK；T3 FW-1：blocker 層
 *   不擋）。本檔只收已驗證之 `number | null`，不重複驗證、也不自行放寬。
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
import { AppError } from "../platform/errors.js";
import { assertApplicationMutable } from "./application-state-machine.js";
import type { Blocker } from "./depreciation-blockers.js";
import { computeDepreciationBlockers } from "./depreciation-blockers.js";
import { utcDateOnly } from "./travel-service.js";

// ---------------------------------------------------------------------------
// Prisma include shape shared by create/read/update
// ---------------------------------------------------------------------------

const depreciationApplicationInclude = {
  owner: { select: { displayName: true, loginName: true } },
  createdBy: { select: { displayName: true } },
  depreciation: true,
} satisfies Prisma.ApplicationInclude;

export type DepreciationApplicationRecord = Prisma.ApplicationGetPayload<{
  include: typeof depreciationApplicationInclude;
}>;

// ---------------------------------------------------------------------------
// DEPRECIATION_ATTACHMENT_LIMIT — Spec AC-23（上限 5，後端常數，不得由用戶端
// 提供）。常數定義於此、於對帳時傳給既有 `linkAttachmentTx`（上限邏輯本身
// 一律沿用既有 `canLink`，本 Phase 不重寫）。AC-23 之正式斷言屬 T8。
// ---------------------------------------------------------------------------

export const DEPRECIATION_ATTACHMENT_LIMIT = 5;

// ---------------------------------------------------------------------------
// primaryDate 推導（§16 D2(a)，人類已批准）
//
//   applicationYear 有值 → 該年 12-31（UTC 日粒度，@db.Date 語意）
//   applicationYear 為 null → 建立日（沿 PHASE-004 差旅之 `derivePrimaryDate`
//     同一 fallback 語意；此處不直接複用該函式，因其入參為「日期」而折舊只有
//     「年度」，需先由年度構造出 12-31）。
//
// AC-06 之正式測試屬 T5；此處落地是因為 `Application.primaryDate` 為
// NOT NULL，建立時必須寫入一個語意正確的值——寫入已知錯誤的值再於 T5 修正
// 會在期間留下語意錯誤的資料列。
// ---------------------------------------------------------------------------

export function deriveDepreciationPrimaryDate(
  applicationYear: number | null,
  createdAtFallback: Date
): Date {
  if (applicationYear === null) {
    return utcDateOnly(createdAtFallback);
  }
  // 月份索引 11 ＝ 12 月；日 31。以 UTC 建構（006 T1 AR-6③／T3 AR-3 之
  // `utcDateOnly` UTC 慣例，不得以本地時區建構）。
  return new Date(Date.UTC(applicationYear, 11, 31));
}

// ---------------------------------------------------------------------------
// createDepreciationDraft (AC-02)
// ---------------------------------------------------------------------------

export interface CreateDepreciationDraftInput {
  ownerId: string;
  createdById: string;
  applicationYear?: number | null;
}

/**
 * 建立折舊草稿（`Application` ＋ `DepreciationApplication`，1:1）。
 *
 * §7.1「body 全選填」——`applicationYear` 可缺省或為 `null`（AC-02：不因缺
 * 欄位而拒絕）；全部快照欄位一律不寫入（保持 `null`）。
 *
 * `ownerId`／`createdById` 恆由呼叫端提供（自建＝自己；T11 代建立＝指定使用
 * 者），本檔從不讀取 request body 之任何識別值（§6.2 資料隔離不變式 1）。
 *
 * `onCreated`（OPTIONAL，T11 代操作稽核 hook）沿 `createMaintenanceDraft`
 * 之既有形狀預留：hook 於**同一交易**內執行，失敗即回滾整筆建立。自助建立
 * （`POST /applications/depreciation`）從不傳入 hook——本人自建不寫稽核
 * （沿 PHASE-004 AC-86）。
 */
export type OnDepreciationDraftCreated = (
  tx: Prisma.TransactionClient,
  application: DepreciationApplicationRecord
) => Promise<void>;

export async function createDepreciationDraft(
  prisma: PrismaClient,
  input: CreateDepreciationDraftInput,
  onCreated?: OnDepreciationDraftCreated
): Promise<DepreciationApplicationRecord> {
  const applicationYear = input.applicationYear ?? null;
  const primaryDate = deriveDepreciationPrimaryDate(applicationYear, new Date());

  return prisma.$transaction(async (tx) => {
    const application = await tx.application.create({
      data: {
        type: "DEPRECIATION",
        status: "DRAFT",
        ownerId: input.ownerId,
        createdById: input.createdById,
        primaryDate,
        depreciation: {
          create: {
            applicationYear,
          },
        },
      },
      include: depreciationApplicationInclude,
    });

    if (onCreated) {
      await onCreated(tx, application);
    }

    return application;
  });
}

// ---------------------------------------------------------------------------
// getDepreciationApplication (AC-05)
// ---------------------------------------------------------------------------

/**
 * 依 id 讀取折舊申請。不存在、型別非 `DEPRECIATION`、或子列缺席時一律回
 * `null`（呼叫端轉 404）——`:id` 指向差旅／保養申請時必須 404 且不得洩漏其
 * 型別（沿 `getMaintenanceApplication` 之 B-34 同型防禦）。
 */
export async function getDepreciationApplication(
  prisma: PrismaClient,
  id: string
): Promise<DepreciationApplicationRecord | null> {
  const application = await prisma.application.findUnique({
    where: { id },
    include: depreciationApplicationInclude,
  });
  if (!application || application.type !== "DEPRECIATION" || !application.depreciation) {
    return null;
  }
  return application;
}

// ---------------------------------------------------------------------------
// updateDepreciationDraft (AC-04, §9.1)
// ---------------------------------------------------------------------------

/**
 * 三態語意（沿 `UpdateMaintenanceDraftPatch` 既有慣例）：
 *   - key 缺席（未出現於 `patch` 物件上）＝ 不變
 *   - key 存在但值為 `null`               ＝ 清空
 *   - key 存在且有值                      ＝ 設定
 *
 * `attachmentIds` 之語意與其他欄位不同：這是一個**宣告式全集**——key 缺席
 * ＝不對帳（不動任何附件關聯）；key 存在＝把目前 `LINKED` 集合與此陣列做差
 * 集，多出者 detach、缺少者 link。無「清空」之 `null` 值——空陣列 `[]` 本身
 * 即代表「全部 detach」。
 */
export interface UpdateDepreciationDraftPatch {
  applicationYear?: number | null;
  attachmentIds?: string[];
}

/** T11 代修改稽核 hook 之 before 快照（於同一交易嘗試內新鮮讀取，非交易外過期讀取）。 */
export interface DepreciationDraftUpdateAuditContext {
  ownerId: string;
  ownerLoginName: string;
  before: {
    applicationYear: number | null;
  };
}

export type OnDepreciationDraftUpdated = (
  tx: Prisma.TransactionClient,
  context: DepreciationDraftUpdateAuditContext,
  application: DepreciationApplicationRecord
) => Promise<void>;

/**
 * 單容器宣告式附件對帳（§9.1 步驟「附件對帳」）。
 *
 * `DepreciationApplication` 恰有一個附件容器（`refId = Application.id` 本身，
 * §16 D2(a)），故差集即為單純的集合差——與 `maintenance-service.ts` 之
 * `reconcileMaintenanceAttachments` 同型（該函式為 `refType=MAINTENANCE`
 * 專屬且未匯出，此處為同一組規則對 `refType=DEPRECIATION` 的獨立套用，不是
 * 第二套業務規則：上限判定仍一律走既有 `linkAttachmentTx`／`canLink`）。
 *
 * 必須與 `updateDepreciationDraft` 的業務欄位寫入處於**同一交易**，使此處拋
 * 出的 404／403／409 一併回滾整份 PUT（AC-04 逐字：「`attachmentIds[]` 對帳
 * 於同一交易內完成」）。
 */
async function reconcileDepreciationAttachments(
  tx: Prisma.TransactionClient,
  applicationId: string,
  applicationOwnerId: string,
  requestedIds: string[]
): Promise<void> {
  const currentRows = await tx.attachment.findMany({
    where: { refType: "DEPRECIATION", refId: applicationId, status: "LINKED" },
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

    // 上限 5（AC-23）：`linkAttachmentTx` 於同一交易內每次呼叫都重算該容器
    // 的即時 `LINKED` 計數，故單次 PUT 宣告 6 個新 id 時第 6 次會看到 5 而
    // 丟出 `TOO_MANY_ATTACHMENTS`，整個交易回滾。
    await linkAttachmentTx(tx, {
      attachmentId,
      refType: "DEPRECIATION",
      refId: applicationId,
      limit: DEPRECIATION_ATTACHMENT_LIMIT,
    });
  }
}

function hasKey(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * PHASE-004-R4 同型紀律：沿用 `travel-service.ts`／`maintenance-service.ts`
 * 既有的交易衝突判定條件（三種訊號形狀之完整理由見 `travel-service.ts` 檔頭）。
 * 該函式未匯出且 Files Allowed 未涵蓋將其改為 export，故此處為「同一份規則的
 * 獨立小型複本」（交易衝突偵測，非欄位驗證，不觸犯「不得第二套驗證實作」）。
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
 * 更新折舊草稿之 `applicationYear` ＋ `primaryDate` ＋ 附件對帳（§9.1）。
 *
 * SERIALIZABLE ＋ `SELECT ... FOR UPDATE` ＋ 重試（§10.3 NFR「所有寫入路徑
 * SERIALIZABLE ＋ 重試」）：交易內以新鮮讀取重新 `assertApplicationMutable`
 * （006 M-2 紀律，AC-04 逐字「外層快速失敗 ＋ 交易內 `FOR UPDATE` 後二次守
 * 門」）——不僅信任 `routes.ts` 於交易開啟前的外層檢查。
 */
export async function updateDepreciationDraft(
  prisma: PrismaClient,
  id: string,
  patch: UpdateDepreciationDraftPatch,
  onUpdated?: OnDepreciationDraftUpdated
): Promise<DepreciationApplicationRecord> {
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
              owner: { select: { loginName: true } },
              depreciation: { select: { applicationYear: true } },
            },
          });

          // M-2：交易內以新鮮讀取再驗一次可變性（TOCTOU 競態防禦）。
          assertApplicationMutable(existing.status);

          const nextApplicationYear = hasKey(patch, "applicationYear")
            ? (patch.applicationYear ?? null)
            : (existing.depreciation?.applicationYear ?? null);

          const primaryDate = deriveDepreciationPrimaryDate(
            nextApplicationYear,
            existing.createdAt
          );

          await tx.application.update({
            where: { id },
            data: {
              primaryDate,
              depreciation: {
                update: {
                  applicationYear: nextApplicationYear,
                },
              },
            },
          });

          if (hasKey(patch, "attachmentIds")) {
            await reconcileDepreciationAttachments(
              tx,
              id,
              existing.ownerId,
              patch.attachmentIds ?? []
            );
          }

          const after = await tx.application.findUniqueOrThrow({
            where: { id },
            include: depreciationApplicationInclude,
          });

          // T11 代操作稽核 hook：僅在呼叫端（`routes.ts`／`admin/routes.ts`
          // 依 `actorId !== ownerId` 判定）傳入時執行，且於本次嘗試的同一
          // `tx` 上、全部主要寫入之後、commit 之前——拋錯即一併回滾。
          if (onUpdated) {
            await onUpdated(
              tx,
              {
                ownerId: existing.ownerId,
                ownerLoginName: existing.owner.loginName,
                before: {
                  applicationYear: existing.depreciation?.applicationYear ?? null,
                },
              },
              after
            );
          }

          return after;
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
// DTO（§7.2）
// ---------------------------------------------------------------------------

/**
 * §7.2 `DepreciationComputedDto`。本 Task 不填充（恆 `null`）——形狀先行宣告
 * 以固定對外契約；T6（年度里程）／T7（參數與單價）落地其內容。
 */
export interface DepreciationComputedDto {
  calculable: boolean;
  officialKm: string | null;
  officialApplicationCount: number | null;
  perKmUnitPrice: string | null;
  rawAmount: string | null;
  amount: number | null;
  blockingCodes: string[];
}

// ---------------------------------------------------------------------------
// 年度公務里程接線（PHASE-007-T6；AC-09~12、§7.3、§9.2）
//
// 引擎複用（AC-09）：年度里程一律經 `sumOfficialMileage`（PHASE-005 引擎，
// 全案唯一實作）取得——本檔**不得**自行複製任何加總／過濾邏輯，
// `mileage-engine.ts`／`mileage-range.ts` 於本 Phase 零 diff。
// ---------------------------------------------------------------------------

/**
 * 由申請年度推導引擎查詢區間（§7.3）：`[YYYY-01-01, YYYY-12-31]`，**起訖含
 * 當日**（含當日語意本身由 `buildOfficialMileageWhere` 之 `gte`/`lte` 保證，
 * 本函式只負責兩個端點日期）。
 *
 * UTC 建構（006 T1 AR-6③／T3 AR-3 之 `utcDateOnly` UTC 慣例）：**不得**以本地
 * 時區建構，否則東八區會使 01-01 之查詢下界落到前一年 12-31T16:00Z。
 */
export function depreciationYearRange(applicationYear: number): {
  dateFrom: Date;
  dateTo: Date;
} {
  return {
    dateFrom: new Date(Date.UTC(applicationYear, 0, 1)),
    dateTo: new Date(Date.UTC(applicationYear, 11, 31)),
  };
}

export interface ComputeDepreciationComputedInput {
  /**
   * 年度里程之歸屬人。**恆為 `Application.ownerId`**（代操作時亦然），由呼叫端
   * （`routes.ts` 之 `resolveOwnerId`／DB 載入之 `ownerId`）決定——本函式從不
   * 知道「誰在呼叫」，故不可能誤用操作者身分（AC-14 之結構性保證）。
   */
  ownerId: string;
  /** 申請年度；`null` ＝ 尚未選擇（§9.2：不查 DB）。值域驗證屬 `routes.ts`。 */
  applicationYear: number | null;
}

/**
 * 計算折舊補貼預覽之 `computed`（§7.2 `DepreciationComputedDto`）。
 *
 * 本 Task（T6）落地其**年度公務里程**部分（§9.2 前半，AC-09~12）：
 *   `applicationYear == null` → `calculable=false` ＋ `[YEAR_REQUIRED]`，
 *     **不查 DB**（§9.2 逐字）；
 *   否則 → `sumOfficialMileage(db, { ownerId, YYYY-01-01, YYYY-12-31 })`
 *     （唯讀聚合，零寫入）→ `officialKm`（2 位小數字串）與
 *     `officialApplicationCount`（AC-13：後者僅供顯示，**絕不**進入金額計算）。
 *
 * ── T7 之接線縫（明示留白，不提前實作半套） ──────────────────────────────
 * §9.2 後半（`findEffectiveVersion` 選版 → `deriveDepreciation` → 單價 →
 * `calculateDepreciation` → 容量判定）屬 **T7**。在 T7 落地之前，本函式**沒有
 * 任何取得每公里單價的程式路徑**，故 `perKmUnitPrice` 恆為不可得——即 §7.5
 * 第 3 碼之觸發條件「該年度尚無有效折舊參數」於此 commit 為**恆真**，據此回
 * `PARAMETER_NOT_AVAILABLE` 並保持 §7.5 不變式「`calculable=false ⇒
 * blockingCodes 至少一項」成立。T7 只需將下方標示之常數 `null` 換成真實選版
 * 結果，並依 T3 即審 FW-3 以 `pure.calculable && !overCapacity` 合成
 * `calculable`（**不得**由 `blockingCodes.length` 反推）。
 *
 * 唯讀：本函式只呼叫聚合查詢，無任何 `.create`／`.update`／`.delete`
 * （§9.2 零寫入不變式）。
 */
export async function computeDepreciationComputed(
  db: PrismaLike,
  input: ComputeDepreciationComputedInput
): Promise<DepreciationComputedDto> {
  const { ownerId, applicationYear } = input;

  if (applicationYear === null) {
    return {
      calculable: false,
      officialKm: null,
      officialApplicationCount: null,
      perKmUnitPrice: null,
      rawAmount: null,
      amount: null,
      blockingCodes: ["YEAR_REQUIRED"],
    };
  }

  const { dateFrom, dateTo } = depreciationYearRange(applicationYear);
  // AC-09/14：唯一呼叫點；`ownerId` 逐次由呼叫端傳入之擁有人，無任何預設值。
  const { totalKm, applicationCount } = await sumOfficialMileage(db, {
    ownerId,
    dateFrom,
    dateTo,
  });

  // T7 接線縫：參數選版與單價推導尚未落地 ⇒ 單價恆不可得（見上方文件註解）。
  const perKmUnitPrice: string | null = null;

  return {
    calculable: false,
    officialKm: totalKm.toFixed(2),
    officialApplicationCount: applicationCount,
    perKmUnitPrice,
    rawAmount: null,
    amount: null,
    blockingCodes: ["PARAMETER_NOT_AVAILABLE"],
  };
}

/**
 * §7.2 `DepreciationSnapshotDto`。**刻意不含** `vehiclePrice`／
 * `usefulLifeYears`／`estimatedAnnualKm`／`depreciationParameterVersionId`
 * （§16 D8：推導三值與版本 id 仍持久化於 DB，但於任何折舊申請 DTO 皆不外露）。
 */
export interface DepreciationSnapshotDto {
  officialKm: string; // 2 位小數
  perKmUnitPrice: string; // 4 位小數
  rawAmount: string; // 4 位小數
  totalAmount: number; // 整數（＝ Application.totalAmount）
  calculatedAt: string; // ISO8601
}

export interface DepreciationApplicationDto {
  id: string;
  type: "DEPRECIATION";
  status: string;
  ownerId: string;
  ownerDisplayName: string;
  createdById: string;
  onBehalf: boolean;
  primaryDate: string;
  createdAt: string;
  updatedAt: string;

  applicationYear: number | null;

  duplicateYearNotice: { count: number; hasCompleted: boolean } | null;

  attachments: AttachmentDto[];
  completionBlockers: Blocker[] | null;
  computed: DepreciationComputedDto | null;
  snapshot: DepreciationSnapshotDto | null;
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * 建構 `DepreciationSnapshotDto`。僅 `status="COMPLETED"` **且**相關欄位皆
 * 已寫入時非 `null`——逐欄 `!= null` 守門後才組裝（沿 `travel-service.ts`／
 * `maintenance-service.ts` 之 T7R S-1 既有慣例）：測試或既有資料若僅以
 * Prisma 撥動 `status` 而未經完成流程寫入快照，必須優雅回 `null`，不得因
 * 於 `null` 上呼叫 `.toFixed()` 而 500。
 *
 * 顯式定精度（`toFixed(scale)`）沿 §7.2 之固定小數位字串契約。
 */
function buildSnapshotDto(
  application: DepreciationApplicationRecord
): DepreciationSnapshotDto | null {
  const depreciation = application.depreciation;
  if (
    application.status !== "COMPLETED" ||
    !depreciation ||
    depreciation.snapshotOfficialKm == null ||
    depreciation.snapshotPerKmUnitPrice == null ||
    depreciation.snapshotRawAmount == null ||
    depreciation.calculatedAt == null ||
    application.totalAmount == null
  ) {
    return null;
  }
  return {
    officialKm: depreciation.snapshotOfficialKm.toFixed(2),
    perKmUnitPrice: depreciation.snapshotPerKmUnitPrice.toFixed(4),
    rawAmount: depreciation.snapshotRawAmount.toFixed(4),
    totalAmount: application.totalAmount,
    calculatedAt: depreciation.calculatedAt.toISOString(),
  };
}

/**
 * 建構折舊申請之回應 DTO。
 *
 * `attachments`：由呼叫端（`buildDepreciationApplicationDto`）一次查得真實
 * `LINKED` 附件後傳入——本函式**不**碰 DB（006 T4 即審 FW-T6 節義務：DTO
 * builder 不得偷查 DB）。
 *
 * `completionBlockers`：僅 `DRAFT` 才計算（`COMPLETED` 為 `null`，§7.2 明
 * 文）。草稿階段為兩段式第一段——`officialKm`／`perKmUnitPrice` **同不給**
 * （T3 即審 FW-5），第 3、4 碼完全被抑制。附件計數 ＝ `attachments.length`
 * （本函式之呼叫端只查 `status="LINKED"` 之附件）。
 *
 * 完成交易內之附件計數**不得**沿用本處之交易外結果（T3 即審 FW-10：須於
 * `FOR UPDATE` 鎖列後同 `tx` 現算）——該義務落在 T9 之完成流程。
 */
export function toDepreciationApplicationDto(
  application: DepreciationApplicationRecord,
  attachments: AttachmentDto[] = [],
  duplicateYearNotice: { count: number; hasCompleted: boolean } | null = null
): DepreciationApplicationDto {
  const depreciation = application.depreciation;
  const isDraft = application.status === "DRAFT";

  const completionBlockers = isDraft
    ? computeDepreciationBlockers({
        applicationYear: depreciation?.applicationYear ?? null,
        attachmentCount: attachments.length,
        // FW-5：草稿階段兩者同不給（尚未查詢）。
      })
    : null;

  return {
    id: application.id,
    type: "DEPRECIATION",
    status: application.status,
    ownerId: application.ownerId,
    ownerDisplayName: application.owner.displayName,
    createdById: application.createdById,
    onBehalf: application.createdById !== application.ownerId,
    primaryDate: formatDate(application.primaryDate),
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),

    applicationYear: depreciation?.applicationYear ?? null,

    duplicateYearNotice,

    attachments,
    completionBlockers,
    // AC-09~18（年度里程／參數／單價）屬 T6/T7——本 Task 明示留白。
    computed: null,
    snapshot: buildSnapshotDto(application),
  };
}

/**
 * §16 D4(a)（AC-07）：同 `ownerId`、同 `applicationYear`、排除自身、狀態 ∈
 * {`DRAFT`,`COMPLETED`}（未來之 `VOIDED` 天然排除——本 Phase `VOIDED` 尚不可
 * 達，見 §16 D4 附註 9）之筆數與是否已有 `COMPLETED`。
 *
 * `applicationYear` 為 `null` 時回 `null`（無年度即無重複語意，AC-07 逐字）。
 *
 * **不倚賴 DB 唯一約束**（T1 即審 FW-4 認知，AC-08）：本查詢單純計數既存列，
 * 即使將來同 `(ownerId, applicationYear)` 有任意筆數之列也不會拋錯——這正是
 * AC-08「無唯一約束」之查詢面對應。
 */
export async function computeDuplicateYearNotice(
  db: PrismaLike,
  applicationId: string,
  ownerId: string,
  applicationYear: number | null
): Promise<{ count: number; hasCompleted: boolean } | null> {
  if (applicationYear === null) {
    return null;
  }
  const rows = await db.depreciationApplication.findMany({
    where: {
      applicationYear,
      applicationId: { not: applicationId },
      application: { ownerId, status: { in: ["DRAFT", "COMPLETED"] } },
    },
    select: { application: { select: { status: true } } },
  });
  return {
    count: rows.length,
    hasCompleted: rows.some((row) => row.application.status === "COMPLETED"),
  };
}

/**
 * `routes.ts` 呼叫的薄編排層：一次查得真實 `LINKED` 附件（`refType=
 * "DEPRECIATION"`、`refId = Application.id`，§16 D2(a)）與 `duplicateYearNotice`
 * （AC-07）後組裝 DTO。`DRAFT`／`COMPLETED` 皆查——已完成之折舊詳情頁仍需顯示
 * 證明縮圖與重複提示。
 */
export async function buildDepreciationApplicationDto(
  db: PrismaLike,
  application: DepreciationApplicationRecord
): Promise<DepreciationApplicationDto> {
  const attachmentRows = await db.attachment.findMany({
    where: { refType: "DEPRECIATION", refId: application.id, status: "LINKED" },
  });
  const duplicateYearNotice = await computeDuplicateYearNotice(
    db,
    application.id,
    application.ownerId,
    application.depreciation?.applicationYear ?? null
  );
  return toDepreciationApplicationDto(
    application,
    attachmentRows.map(toAttachmentDto),
    duplicateYearNotice
  );
}
