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
 *     與參數選版／單價（T7）。**PHASE-007-T6 已落地其年度里程部分、
 *     PHASE-007-T7 已落地參數選版／單價與申請 DTO 之接入**（見
 *     `computeDepreciationComputed`／`buildDepreciationApplicationDto`）。
 *     `calculable` 一律以 `pure.calculable && !overCapacity` 合成，**不得**由
 *     `completionBlockers.length === 0` 反推（T3 即審 FW-3：附件缺漏會抑制
 *     第 3/4 碼，空清單 ≠ 可計算）。
 *   - `duplicateYearNotice`（AC-07）：**PHASE-007-T5 已落地**（見
 *     `computeDuplicateYearNotice`／`buildDepreciationApplicationDto`）。
 *   - 完成流程與快照寫入（AC-27~30）：屬 T9；本檔只讀取快照欄位組 DTO。
 *   - 附件上限 5 之正式斷言、完成鎖定、跨使用者掛入之封閉（AC-23/25/26）：
 *     屬 T8。本檔已於對帳時傳入上限常數與三道 per-attachment 檢查（沿保養
 *     既有模式），T8 只需補齊測試與 `deriveContainerState` 之擴充。
 *
 * ── 兩段式 blocker 之呼叫紀律（T3 即審 FW-5；T7 更新） ──────────────────
 *   `officialKm`／`annualDepreciation` **同給或同不給**（PHASE-007-R6a 之收斂
 *   後名稱；§20.5 兩段式）——結構性第一段未通過（年度缺漏／非整數，或年度總
 *   里程缺漏／`≤0`）時兩者皆未查詢，`computeDepreciationBlockers` 完全抑制第
 *   4~6 碼；第一段通過時兩者皆由 `computeDepreciationComputedResult` 一次查得
 *   後同時傳入。`annualTotalKm` 則為**使用者申報之申請資料**（§20.7.1 之欄
 *   值），非查詢結果，於第一段即需持有。本檔是全案唯一的折舊 blocker 與 `computed` 組裝點（`routes.ts` 之
 *   三個折舊端點一律經 `buildDepreciationApplicationDto`，不得各自補算）。
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
import { AppError, type FieldError } from "../platform/errors.js";
import { assertApplicationMutable, assertTransition } from "./application-state-machine.js";
import { type VoidInfoDto, resolveVoidInfo } from "./application-void.js";
import type { Blocker } from "./depreciation-blockers.js";
import {
  computeDepreciationBlockers,
  isOfficialKmExceedsAnnualTotalKm,
} from "./depreciation-blockers.js";
import {
  calculateDepreciation,
  isDepreciationCalculationOverCapacity,
} from "./depreciation-calculation.js";
import {
  type ResolvedDepreciationParameters,
  resolveDepreciationParameters,
} from "./depreciation-parameters.js";
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
  /**
   * PHASE-007-R5（AC-48(a)）：**使用者申報之申請資料**，應予採用——請求 body
   * 之值原樣寫入 `DepreciationApplication.annualTotalKm`（`Decimal(9,1)`）。
   *
   * 與 CLAUDE.md「後端不得採用前端提交的金額」不衝突：後者約束「計算結果」
   * （`officialKm`／`ratio`／`amount`／快照欄，本檔一律不讀取），本欄約束
   * 「申請輸入資料」，與保養之 `actualCost` 同型（AC-48 消歧義註記，人類已於
   * US Gate 明文批准）。
   *
   * 格式／精度／值域驗證（AC-47）**100% 落在 `routes.ts` 之
   * `parseAnnualTotalKmField`**（沿 `applicationYear` 之既有分層）；本檔只收
   * 已驗證之 `Prisma.Decimal | null`，不重複驗證、也不自行放寬。
   */
  annualTotalKm?: Prisma.Decimal | null;
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
            // AC-48(a)：原樣採用（`?? null` 僅處理「key 缺省」，不改變任何已
            // 驗證之值）。全部快照欄一律不寫入（保持 `null`，AC-02）。
            annualTotalKm: input.annualTotalKm ?? null,
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
  /** PHASE-007-R5（AC-48(a)）：三態語意同 `applicationYear`；語意說明見
   *  `CreateDepreciationDraftInput.annualTotalKm`。 */
  annualTotalKm?: Prisma.Decimal | null;
  attachmentIds?: string[];
}

/** T11 代修改稽核 hook 之 before 快照（於同一交易嘗試內新鮮讀取，非交易外過期讀取）。 */
export interface DepreciationDraftUpdateAuditContext {
  ownerId: string;
  ownerLoginName: string;
  before: {
    applicationYear: number | null;
    /**
     * PHASE-007-R8b（AC-35 欄位摘要完整性）：年度總里程之**修改前**值。
     *
     * 與 `applicationYear` 同源——皆取自 `updateDepreciationDraft` 於本次交易嘗試
     * 內 `SELECT … FOR UPDATE` 之後的**新鮮讀取**（見該函式 `existing`），
     * **不是**呼叫端於交易外先取的過期值。稽核前值一旦混用兩種讀取時點，同一份
     * `summary` 內就會出現兩種一致性語意，併發下必寫出錯誤的前值。
     */
    annualTotalKm: Prisma.Decimal | null;
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
              depreciation: { select: { applicationYear: true, annualTotalKm: true } },
            },
          });

          // M-2：交易內以新鮮讀取再驗一次可變性（TOCTOU 競態防禦）。
          assertApplicationMutable(existing.status);

          const nextApplicationYear = hasKey(patch, "applicationYear")
            ? (patch.applicationYear ?? null)
            : (existing.depreciation?.applicationYear ?? null);

          // AC-48(a)：三態語意——key 缺席＝不變（沿用交易內新鮮讀取之現值，
          // 非交易外過期值）、`null`＝清空（草稿寬容，AC-53(a)）、有值＝設定。
          const nextAnnualTotalKm = hasKey(patch, "annualTotalKm")
            ? (patch.annualTotalKm ?? null)
            : (existing.depreciation?.annualTotalKm ?? null);

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
                  annualTotalKm: nextAnnualTotalKm,
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
                  // R8b：與上一行同源之交易內新鮮讀取（:398 之 select 已含此欄，
                  // 故不新增任何查詢）。
                  annualTotalKm: existing.depreciation?.annualTotalKm ?? null,
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
 * §20.6 `DepreciationComputedDto`（修訂後形狀，取代 §7.2）。
 *
 * 修訂段異動（PHASE-007-R5）：
 *   ★ 新增 `annualDepreciation`（2dp，`deriveAnnualDepreciation` 逐字）
 *   ★ 新增 `annualTotalKm`（1dp，申請資料原樣回傳）
 *   ★ 新增 `ratio`（6dp）／`ratioPercent`（4dp）——**顯示用**，絕不參與金額
 *     （AC-50(b)(c)；金額一律由 `calculateDepreciation` 之先乘後除求得）
 *   ✗ 移除 `perKmUnitPrice`（每公里單價已退出申請計算，裁定①）
 *
 * §20.6 揭露面不變式：本型別**不含** `vehiclePrice`／`usefulLifeYears`／
 * `estimatedAnnualKm`／`depreciationParameterVersionId`（Q6 已將年限之遮蔽固化
 * 為契約——每年折舊費用 × 年限 ＝ 車價）。
 */
export interface DepreciationComputedDto {
  calculable: boolean;
  /** ★ 每年折舊費用（2 位小數）；無可用參數／推導失敗時 `null`。 */
  annualDepreciation: string | null;
  officialKm: string | null;
  officialApplicationCount: number | null;
  /** ★ 年度總里程（1 位小數）——申請資料原樣回傳，未輸入時 `null`。 */
  annualTotalKm: string | null;
  /** ★ 公務比例（6 位小數，顯示用）。 */
  ratio: string | null;
  /** ★ 公務比例百分比（4 位小數，顯示用）。 */
  ratioPercent: string | null;
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
  /**
   * 該車年度總里程（使用者申報之申請資料；§20.7.1 之 `DepreciationApplication
   * .annualTotalKm` 欄）。**草稿 DTO 路徑**由呼叫端原樣傳入該申請列之欄值
   * （`Prisma.Decimal | null`，不轉型、不代填）。
   *
   * **省略 ＝ 呼叫端未持有該值**（PHASE-007-R6a 之當前唯一情形：`POST
   * /applications/depreciation/preview` 之 request body 尚未帶此欄——預覽端點
   * 之語意變更授權在 R6 本體）。省略時一律以 `null` 進入
   * `computeDepreciationBlockers`，落入第 2 碼 `ANNUAL_TOTAL_KM_REQUIRED`
   * （AC-53(a) 之草稿寬容語意），**絕不**以任何佔位值續算金額。
   */
  annualTotalKm?: Prisma.Decimal | null;
}

/**
 * 「每年折舊費用」之取得（PHASE-007-R6；AC-49(a)(b)(c)）。
 *
 * **本檔零推導、零第二個呼叫點**：除法由 R4a 之 `deriveAnnualDepreciation`
 * 承擔，而**呼叫它的唯一位置**是 `depreciation-parameters.ts` 之
 * `resolveDepreciationParameters`（選版與推導同一次完成）。本檔一律取用其
 * 回傳之 `annualDepreciation` 欄位——如此「判定所依據的每年費用」與
 * 「`derivationFailed`／`missing` 所描述的失敗原因」不可能分歧。
 *
 * `null` 之兩個來源皆折為同一語意「該年度無可用之每年折舊費用」→
 * `computeDepreciationBlockers` 之第 4 碼 `PARAMETER_NOT_AVAILABLE`：
 *   ① 查無該年 1/1 之有效版本（`version === null`）；
 *   ② `deriveAnnualDepreciation` 回 `ok:false`（車價 ≤0／年限 ≤0／非有限值
 *      ——AC-49(e) 逐字「視同缺參數」，絕不 500、絕不以 0 繼續計算）。
 * 兩者之區辨資訊由 `resolveDepreciationParameters` 之 `missing`／
 * `derivationFailed` 持有（完成端點 409 `details.missing` 之來源）。
 */

/**
 * `computeDepreciationComputed` 之內部完整結果：DTO ＋ 供 DTO 之
 * `completionBlockers` 第二段使用的原始 `Decimal` 值。
 *
 * 兩者必須來自**同一次查詢**（同一組 `officialKm`／`annualDepreciation`），否則
 * `computed` 與 `completionBlockers` 可能各自看到不同的參數狀態——那正是
 * 「預覽說可以、完成才擋」反模式的溫床（AC-16(b)）。
 */
interface DepreciationComputedResult {
  dto: DepreciationComputedDto;
  /** `null` ＝ 本次未查詢（§20.5 兩段式之「尚未查詢」語意）。 */
  officialKm: Prisma.Decimal | null;
  /**
   * 每年折舊費用（PHASE-007-R6a）。`null` ＝ 已查詢但無有效參數／推導失敗
   * （AC-18），或本次未查詢。取代舊模型之 `perKmUnitPrice`——後者已不再是
   * `computeDepreciationBlockers` 之輸入（R3）。
   */
  annualDepreciation: Prisma.Decimal | null;
}

/**
 * 型別窄化用的薄包裝：判準**完全委派**給 `computeDepreciationBlockers` 之第
 * 一段（單一事實來源），此處只是把「無結構性 blocker」翻譯成 TypeScript 看得
 * 懂的 `applicationYear is number`，本身不含任何自己的判定。
 */
function hasUsableYear(
  structuralBlockers: Blocker[],
  applicationYear: number | null
): applicationYear is number {
  return structuralBlockers.length === 0 && applicationYear !== null;
}

/**
 * 取整前金額之 DTO 呈現（§7.2：`rawAmount` 為 4 位小數字串）。
 *
 * **T2 即審 FW-4 紀律**：真實 `rawAmount` ＝ `officialKm`(2dp) ×
 * `perKmUnitPrice`(4dp) 最多 6 位小數，故轉為 §7.2 之 4 位小數字串時必然發生
 * 一次量化——此處**顯式**指定 `ROUND_HALF_UP`（不依賴 decimal.js 的預設值）。
 * 這是**純呈現**用的量化：量化值**絕不**回餵 `amount`（`amount` 一律取自
 * `calculateDepreciation` 以未量化之 `rawAmount` 算出的結果，AC-20「取整恰一
 * 處」）。整合測試以 `1234.49995 → rawAmount "1234.5000" 而 amount 1234` 之
 * kill case 鎖定（回餵之實作必得 1235）。
 */
function formatRawAmount(rawAmount: Prisma.Decimal): string {
  return rawAmount.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);
}

/**
 * 年度總里程之 DTO 呈現（§20.6：`annualTotalKm` 為 **1 位小數**字串）。
 *
 * 純呈現，零量化風險：欄位為 `Decimal(9,1)`、且 `parseAnnualTotalKmField`
 * （AC-47(b)）已於寫入前把小數位限死在 1 位，故 `toFixed(1)` 對持久值恆為
 * 無損定寬（不會發生第二次捨入）。定寬而非 `toString()`：`20000` 與 `20000.0`
 * 在 wire 上必須是同一個字面（DTO 契約為固定小數位字串）。
 */
function formatAnnualTotalKm(annualTotalKm: Prisma.Decimal | null): string | null {
  return annualTotalKm === null ? null : annualTotalKm.toFixed(1);
}

/**
 * `ratioPercent` 之百分比乘數（§20.6：`ratioPercent = ratio × 100`，4 位小數）。
 * `Prisma.Decimal` 建構一律以字串字面（D4 bright-line）。
 */
const PERCENT_MULTIPLIER = new Prisma.Decimal("100");

/** `ratio` 之顯示位數（6 位小數；對應 `snapshotRatio Decimal(9,6)`）。 */
const RATIO_DISPLAY_SCALE = 6;

/** `ratioPercent` 之顯示位數（4 位小數；比照保養之 `ratioPercentString`）。 */
const RATIO_PERCENT_DISPLAY_SCALE = 4;

/**
 * 計算折舊補貼之 `computed`（§7.2 `DepreciationComputedDto`）與其原始 Decimal
 * 值（§9.2 唯讀路徑之完整實作）。
 *
 *   ① 結構性第一段（`computeDepreciationBlockers`）：`applicationYear` 缺漏或
 *      非整數 → `[YEAR_REQUIRED]`，**不查 DB**（§9.2 逐字）。
 *   ② `sumOfficialMileage(db, { ownerId, YYYY-01-01, YYYY-12-31 })`（唯讀聚合）
 *      → `officialKm`（2 位小數字串）與 `officialApplicationCount`
 *      （AC-13：後者僅供顯示，**絕不**進入金額計算）。
 *   ③ `resolveDepreciationParameters`（選版 → `deriveDepreciation` → 4 位小數
 *      單價）；查無版本或推導失敗一律 `perKmUnitPrice = null` → 第 3 碼。
 *   ④ `calculateDepreciation` ＋ `isDepreciationCalculationOverCapacity`
 *      （T2 純函式，全案唯一之金額與容量判定）。
 *
 * `calculable` ＝ `result.calculable && !overCapacity`（T3 即審 FW-3 逐字：
 * **不得**由 `blockingCodes.length === 0` 反推——附件缺漏會抑制第 3/4 碼，
 * 空清單 ≠ 可計算）。
 *
 * 唯讀：本函式只呼叫聚合與 `findMany`，無任何 `.create`／`.update`／
 * `.delete`（§9.2 零寫入不變式）。
 */
async function computeDepreciationComputedResult(
  db: PrismaLike,
  input: ComputeDepreciationComputedInput
): Promise<DepreciationComputedResult> {
  const { ownerId, applicationYear } = input;
  const annualTotalKm = input.annualTotalKm ?? null;

  // ① 第一段：結構性判定一律經純函式（T6 即審 FW-1；非整數／`NaN`／
  //    `±Infinity` 由該函式之 `Number.isInteger()` 守門保守轉為 `YEAR_REQUIRED`，
  //    本檔不再持有第二份判準）。§20.5：結構性非空即拒絕、**不查詢**年度里程
  //    與參數——`annualTotalKm` 缺漏（第 2 碼）於此即早退，故預覽／草稿在未輸
  //    入年度總里程前不會產生任何 DB 查詢。
  const structuralBlockers = computeDepreciationBlockers({
    applicationYear,
    annualTotalKm,
  });

  // `annualTotalKm === null` 之子句**不是**第二份判定：`null` 必使上方純函式
  // 產生第 2 碼、`structuralBlockers` 必非空，故該子句恆被前一子句涵蓋，僅為
  // TypeScript 之型別收窄（型別述詞一次只能收窄一個參數）。
  if (!hasUsableYear(structuralBlockers, applicationYear) || annualTotalKm === null) {
    return {
      dto: {
        calculable: false,
        annualDepreciation: null,
        officialKm: null,
        officialApplicationCount: null,
        // §20.6：申請資料**原樣回傳**——年度缺漏但總里程已填時仍如實呈現
        // （AC-53(b) 只要求未輸入時金額面全 `null`，未要求抹除已輸入之申報值）。
        annualTotalKm: formatAnnualTotalKm(annualTotalKm),
        ratio: null,
        ratioPercent: null,
        rawAmount: null,
        amount: null,
        blockingCodes: structuralBlockers.map((blocker) => blocker.code),
      },
      officialKm: null,
      annualDepreciation: null,
    };
  }

  // ② AC-09/14：引擎唯一呼叫點；`ownerId` 逐次由呼叫端傳入之擁有人。
  const { dateFrom, dateTo } = depreciationYearRange(applicationYear);
  const { totalKm, applicationCount } = await sumOfficialMileage(db, {
    ownerId,
    dateFrom,
    dateTo,
  });

  // ③ AC-15/18/49：選版（`depreciation-parameters.ts`，不重寫選版）＋每年折舊
  //    費用（同一函式內經 `deriveAnnualDepreciation` 推導，不重寫推導）。
  // 修訂後之申請路徑**完全不觸碰** `deriveDepreciation`／每公里單價（裁定①、
  // AC-49(c) 之負向 spy 即釘住此性質）。
  const { annualDepreciation } = await resolveDepreciationParameters(db, applicationYear);

  // 第二段：`officialKm`／`annualDepreciation` 同給（§20.5）。
  const blockingCodes = computeDepreciationBlockers({
    applicationYear,
    annualTotalKm,
    officialKm: totalKm,
    annualDepreciation,
  }).map((blocker) => blocker.code);

  if (annualDepreciation === null) {
    // AC-16(b)／AC-18：查無有效參數或推導失敗——金額面全 `null`，年度里程
    // 仍如實回報（使用者看得到「該年度有多少公務里程」，只是還算不出金額）。
    return {
      dto: {
        calculable: false,
        annualDepreciation: null,
        officialKm: totalKm.toFixed(2),
        officialApplicationCount: applicationCount,
        annualTotalKm: formatAnnualTotalKm(annualTotalKm),
        // 比例與金額同屬「算不出來」——`calculateDepreciation` 之呼叫需要每年
        // 折舊費用，故此路徑不呼叫它（§20.5 FW-1：缺參數路徑絕不觸發比例／容量
        // 判定），比例欄一律 `null`，**絕不**以 0 或任何佔位值填充。
        ratio: null,
        ratioPercent: null,
        rawAmount: null,
        amount: null,
        blockingCodes,
      },
      officialKm: totalKm,
      annualDepreciation: null,
    };
  }

  // ④ 金額與容量：全案唯一之計算與判定（R2）。
  const result = calculateDepreciation({ annualDepreciation, officialKm: totalKm, annualTotalKm });
  const overCapacity = isDepreciationCalculationOverCapacity(result);
  // AC-52(c)(d)：比例守門之判定式為**單一事實來源**——一律呼叫
  // `depreciation-blockers.ts` 匯出之 `isOfficialKmExceedsAnnualTotalKm`，
  // **不得**在本檔就地重寫任何 `greaterThan` 比較（006 T5R SF-1 雙份漂移教訓；
  // 本檔全域無任何 `greaterThan`／`lessThan`，由整合測試以原始碼掃描守門）。
  //
  // 為什麼 `calculable` 必須把它算進去：`calculateDepreciation` 對比例 >100%
  // 仍**忠實計算**（設計如此，見該檔檔頭），容量亦可能通過——若只以
  // `result.calculable && !overCapacity` 合成，草稿／預覽會出現
  // 「`blockingCodes` 有 `OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM` 但
  // `calculable=true` 還附帶金額」的自相矛盾狀態，正是 AC-52(d) 明文禁止的
  // 「預覽說可以、完成才擋」反模式。
  const officialKmExceeds = isOfficialKmExceedsAnnualTotalKm(totalKm, annualTotalKm);
  // T3 即審 FW-3：合成而非反推（**不得**由 `blockingCodes.length === 0` 反推）。
  const calculable = result.calculable && !overCapacity && !officialKmExceeds;

  return {
    dto: {
      calculable,
      // §20.6：每年折舊費用逐字呈現（2 位小數，`deriveAnnualDepreciation` 之
      // 契約值），**不再取整**（AC-51(b)：本 Phase 之取整恰一處，即最終金額）。
      annualDepreciation: annualDepreciation.toFixed(2),
      officialKm: totalKm.toFixed(2),
      officialApplicationCount: applicationCount,
      annualTotalKm: formatAnnualTotalKm(annualTotalKm),
      // AC-50(b)：顯示字串取自 R2 之計算結果（本檔零除法、零第二份精度規則）；
      // 兩者**不回流金額**（AC-50(c)：`rawAmount` 一律先乘後除）。
      ratio: result.ratioString,
      ratioPercent: result.ratioPercentString,
      // 超出容量時不呈現金額（沿 PHASE-006 `computeMaintenanceComputed` 之既有
      // 處置：不可計算即不給數字，避免前端顯示一個存不進去的金額）。
      rawAmount: calculable && result.rawAmount !== null ? formatRawAmount(result.rawAmount) : null,
      amount: calculable ? result.amount : null,
      blockingCodes,
    },
    officialKm: totalKm,
    annualDepreciation,
  };
}

/**
 * `POST /applications/depreciation/preview` 之服務入口（§9.2）——回傳 §7.2 之
 * `DepreciationComputedDto`。完整語意見
 * `computeDepreciationComputedResult` 之文件註解。
 */
export async function computeDepreciationComputed(
  db: PrismaLike,
  input: ComputeDepreciationComputedInput
): Promise<DepreciationComputedDto> {
  return (await computeDepreciationComputedResult(db, input)).dto;
}

/**
 * §20.6 `DepreciationSnapshotDto`（修訂後形狀，取代 §7.2）。**刻意不含**
 * `vehiclePrice`／`usefulLifeYears`／`estimatedAnnualKm`／
 * `depreciationParameterVersionId`（§16 D8 ＋ Q6：推導值與版本 id 仍持久化於
 * DB，但於任何折舊申請 DTO 皆不外露）。
 *
 * AC-56：`model` 為新舊模型之判別結果，由 `snapshotAnnualTotalKm` 推導——
 * 新模型欄於 `LEGACY` 列一律 `null`、舊模型欄（`perKmUnitPrice`）於 `CURRENT`
 * 列一律 `null`。**舊模型列一律以快照原值呈現，不得以新模型重算**
 * （BE-US-14 第 3 條逐字）。
 */
export interface DepreciationSnapshotDto {
  model: "CURRENT" | "LEGACY";
  // ── 新模型欄（LEGACY 列為 null）──
  annualDepreciation: string | null; // 2 位小數
  annualTotalKm: string | null; // 1 位小數
  ratio: string | null; // 6 位小數
  ratioPercent: string | null; // 4 位小數
  // ── 舊模型欄（CURRENT 列為 null）──
  perKmUnitPrice: string | null; // 4 位小數
  // ── 兩模型共有 ──
  officialKm: string; // 2 位小數
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
  /** ★ §20.6：年度總里程（1 位小數字串；使用者申報之申請資料，AC-48(a)）。 */
  annualTotalKm: string | null;

  duplicateYearNotice: { count: number; hasCompleted: boolean } | null;

  attachments: AttachmentDto[];
  completionBlockers: Blocker[] | null;
  computed: DepreciationComputedDto | null;
  snapshot: DepreciationSnapshotDto | null;
  /** PHASE-009-T3（§7.2）：未作廢恆為 null。 */
  void: VoidInfoDto | null;
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
    depreciation.snapshotRawAmount == null ||
    depreciation.calculatedAt == null ||
    application.totalAmount == null
  ) {
    return null;
  }

  // AC-56(a) 判別（**單一判準**，逐字）：
  //   新模型列：`snapshotAnnualTotalKm != null`
  //   舊模型列：`snapshotPerKmUnitPrice != null` 且 `snapshotAnnualTotalKm == null`
  // 兩者皆 `null` 之 `COMPLETED` 列不屬任一模型（草稿列之判別條件），無從如實
  // 揭露 `model`——沿本函式既有之保守處置優雅回 `null`（不猜、不 500）。
  const snapshotAnnualTotalKm = depreciation.snapshotAnnualTotalKm;
  const snapshotPerKmUnitPrice = depreciation.snapshotPerKmUnitPrice;
  if (snapshotAnnualTotalKm == null && snapshotPerKmUnitPrice == null) {
    return null;
  }
  const isCurrentModel = snapshotAnnualTotalKm != null;

  // AC-56(c)：舊模型列**零重算**——本函式只做定精度字串化，沒有任何算式；
  // `ratioPercent` 亦僅由已持久化之 `snapshotRatio` 乘 100 呈現（`Decimal`
  // 全程，零浮點中介），**不**由 `officialKm ÷ annualTotalKm` 重算。
  const snapshotRatio = depreciation.snapshotRatio;

  return {
    model: isCurrentModel ? "CURRENT" : "LEGACY",
    annualDepreciation:
      isCurrentModel && depreciation.snapshotAnnualDepreciation != null
        ? depreciation.snapshotAnnualDepreciation.toFixed(2)
        : null,
    annualTotalKm: isCurrentModel ? formatAnnualTotalKm(snapshotAnnualTotalKm) : null,
    ratio:
      isCurrentModel && snapshotRatio != null ? snapshotRatio.toFixed(RATIO_DISPLAY_SCALE) : null,
    ratioPercent:
      isCurrentModel && snapshotRatio != null
        ? snapshotRatio.times(PERCENT_MULTIPLIER).toFixed(RATIO_PERCENT_DISPLAY_SCALE)
        : null,
    perKmUnitPrice:
      !isCurrentModel && snapshotPerKmUnitPrice != null ? snapshotPerKmUnitPrice.toFixed(4) : null,
    officialKm: depreciation.snapshotOfficialKm.toFixed(2),
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
 * 文）。`officialKm`／`perKmUnitPrice` 由 `computed`（同一次查詢之結果，見
 * `DepreciationComputedResult`）原樣轉入——年度不可用時兩者為 `null`（尚未
 * 查詢，第 3、4 碼被抑制），年度可用時兩者同給（第二段）。附件計數 ＝
 * `attachments.length`（本函式之呼叫端只查 `status="LINKED"` 之附件）。
 *
 * 注意兩段式之必然結果（T3 即審 FW-3，非缺陷）：草稿零附件時第 2 碼會**抑制**
 * 第 3/4 碼，故 `completionBlockers` 可能不含 `PARAMETER_NOT_AVAILABLE`；但
 * `computed.calculable=false` 與 `computed.blockingCodes` 一律如實反映不可
 * 計算之真因（AC-16(b) 之反模式封閉靠 `computed`，不靠 blocker 清單）。
 *
 * 完成交易內之附件計數**不得**沿用本處之交易外結果（T3 即審 FW-10：須於
 * `FOR UPDATE` 鎖列後同 `tx` 現算）——該義務落在 T9 之完成流程。
 */
export function toDepreciationApplicationDto(
  application: DepreciationApplicationRecord,
  attachments: AttachmentDto[] = [],
  duplicateYearNotice: { count: number; hasCompleted: boolean } | null = null,
  computed: DepreciationComputedResult | null = null,
  voidInfo: VoidInfoDto | null = null
): DepreciationApplicationDto {
  const depreciation = application.depreciation;
  const isDraft = application.status === "DRAFT";

  const completionBlockers = isDraft
    ? computeDepreciationBlockers({
        applicationYear: depreciation?.applicationYear ?? null,
        // §20.7.1：真值來源為該申請列之欄值（未輸入 ＝ `null` → 第 2 碼，
        // AC-53(a)）。與 `computed` 同源——`buildDepreciationApplicationDto`
        // 以同一個 `application.depreciation.annualTotalKm` 餵入兩者。
        annualTotalKm: depreciation?.annualTotalKm ?? null,
        officialKm: computed?.officialKm ?? null,
        annualDepreciation: computed?.annualDepreciation ?? null,
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
    // AC-48(a)：申請資料原樣回傳（1 位小數定寬字串）。
    annualTotalKm: formatAnnualTotalKm(depreciation?.annualTotalKm ?? null),

    duplicateYearNotice,

    attachments,
    completionBlockers,
    // §7.2：`computed` 僅 `DRAFT` 才有（呼叫端於 `COMPLETED` 一律不計算，
    // 故此處為 `null`）。
    computed: computed?.dto ?? null,
    snapshot: buildSnapshotDto(application),
    void: voidInfo,
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
 * "DEPRECIATION"`、`refId = Application.id`，§16 D2(a)）、`duplicateYearNotice`
 * （AC-07）與 `computed`（AC-09~18）後組裝 DTO。`DRAFT`／`COMPLETED` 皆查附件
 * ——已完成之折舊詳情頁仍需顯示證明縮圖與重複提示。
 *
 * **查詢面（T6 即審 FW-5 之據實揭露）**：本函式為折舊 DTO 的**單一組裝點**，
 * `routes.ts` 之 POST／GET／PUT 三處一律經此，不得各自補算。每次呼叫之查詢：
 *   - `attachment.findMany`（既有）
 *   - `depreciationApplication.findMany`（既有，`duplicateYearNotice`）
 *   - **`DRAFT` 才有**：`sumOfficialMileage`（引擎內部之一次聚合查詢，+1）
 *     ＋ `depreciationParameterVersion.findMany`（選版，+1）
 *   - `COMPLETED`：上述兩項 **+0**（`computed` 為 `null`，§7.2；已完成之數字
 *     一律取自快照，不重算——AC-31 之讀取路徑零重算即由此保證）。
 * `toDepreciationApplicationDto` 本身**不碰 DB**（006 T4 即審 FW-T6 節義務）。
 */
export async function buildDepreciationApplicationDto(
  db: PrismaLike,
  application: DepreciationApplicationRecord
): Promise<DepreciationApplicationDto> {
  const attachmentRows = await db.attachment.findMany({
    where: { refType: "DEPRECIATION", refId: application.id, status: "LINKED" },
  });
  const applicationYear = application.depreciation?.applicationYear ?? null;
  const duplicateYearNotice = await computeDuplicateYearNotice(
    db,
    application.id,
    application.ownerId,
    applicationYear
  );
  // PHASE-009-T3：作廢資訊之解析需查 DB（`voidedById` 無 FK）——本函式本就
  // 是「查 DB 的那一層」，`toDepreciationApplicationDto` 保持純函式不變。
  const voidInfo = await resolveVoidInfo(db, application);
  const computed =
    application.status === "DRAFT"
      ? await computeDepreciationComputedResult(db, {
          // AC-14：恆為擁有人（代操作時亦然），絕不為操作者。
          ownerId: application.ownerId,
          applicationYear,
          // §20.7.1：使用者申報值，原樣傳遞（`Prisma.Decimal | null`）。
          annualTotalKm: application.depreciation?.annualTotalKm ?? null,
        })
      : null;
  return toDepreciationApplicationDto(
    application,
    attachmentRows.map(toAttachmentDto),
    duplicateYearNotice,
    computed,
    voidInfo
  );
}

// ---------------------------------------------------------------------------
// completeDepreciationApplication — PHASE-007-T9（AC-27/28/29/30；AC-16/18 之
// 完成端點 409 段）
//
// §9.3「完成與快照寫入」逐字流程，單一 SERIALIZABLE 交易（含重試）：
//   ① `SELECT ... FOR UPDATE` → `assertTransition(status → COMPLETED)`
//      → 非 DRAFT → 403（狀態機為單一事實來源，本檔不自寫狀態判定）
//   ② `attachmentCount` 於 **tx 內 `FOR UPDATE` 之後現算**（AC-24 整合層；
//      T8 即審 FW-3 逐字：**絕不**沿用交易外 DTO 之 `attachments.length`——
//      那是 write-skew 缺口：交易外讀到 1 張、交易內該張已被刪除）。
//      `computeDepreciationBlockers`（第一段，`officialKm` 省略）→ 非空即
//      400，**不**執行 ③④（§9.3「②與③④之順序不可對調」逐字）。
//   ③ `sumOfficialMileage(tx, …)` — 同一交易（AC-27），`ownerId` 恆為擁有人。
//   ④ `resolveDepreciationParameters(tx, …)` — **於交易內重新解析**
//      （T7 即審 FW-2：不得沿用 builder 於交易外之結果；三個版本值供快照）。
//   ⑤ 第二段 blocker：`PARAMETER_NOT_AVAILABLE` → **409**（§7.5／§16 D5(a)）；
//      其餘（`AMOUNT_OUT_OF_RANGE`）→ **400**，兩者皆於**任何寫入之前**拒絕。
//   ⑥a `DepreciationApplication` 8 個快照欄（顯式定精度）
//   ⑥b `Application.status/totalAmount/completedAt`（最後一筆寫入）
//
// 授權（§16 D9(a)：**僅擁有人本人**）不在本函式判定——`routes.ts` 於呼叫前已
// 完成嚴格 `actor.id === ownerId` 判定（與 `completeTravelApplication`／
// `completeMaintenanceApplication` 同型分工；本函式沒有 owner/admin 之分，
// 故不可能因本檔改動而放行管理員代完成）。
//
// ── 容量判定之單一決策點（T7 即審 FW-4） ──────────────────────────────────
// 本流程**不**另行呼叫 `isDepreciationCalculationOverCapacity`：容量是否超出
// 的判定**只發生一次**，即 `computeDepreciationBlockers` 第二段內部（T3 已將
// 該 predicate 收為其唯一呼叫點）。第二段回空陣列 ⇒ 容量已通過 ⇒ 才建構供寫
// 入用的**唯一** `calculateDepreciation` 結果物件 `result`，`snapshotRawAmount`
// 與 `totalAmount` 一律取自該同一物件（`result.amount` 直接寫入，**禁止**二次
// 取整、**禁止**由 4dp `rawAmount` 反推——AC-28 逐字）。純函式對同一組
// `officialKm`／`perKmUnitPrice` 參考恆為同值，故「判定所依據的金額」與「寫入
// 的金額」不可能分歧（`depreciation-blockers.ts` 為本 Task 之 Forbidden 檔，
// 無法改為旗標注入式而省去其內部那次呼叫）。
//
// ── 4dp 量化不會造成 Postgres 22003（T2 即審 FW-6 之窄窗） ────────────────
// `snapshotRawAmount` 寫入前以 `formatRawAmount` 顯式量化為 4dp，理論上
// `rawAmount ∈ [1e10−5e-5, 1e10)` 會被量化為恰好 `1e10` 而溢出
// `Decimal(14,4)`。該窗**不可達**：同一 `result` 之 `amount ＝ round(rawAmount)`
// 於此窗恆為 `10000000000`，遠超 `int4`（2147483647），故容量判定必先以
// `AMOUNT_OUT_OF_RANGE` 於寫入前拒絕。此性質由整合測試以窄窗案例
// （officialKm 4199999.79 × perKmUnitPrice 2380.9525 ＝ 9999999999.999975）
// 實證為 400 而非 500。
// ---------------------------------------------------------------------------

export interface CompleteDepreciationApplicationOptions {
  /**
   * TEST-ONLY 失敗切點（AC-30 原子性鑑別力測試需要）：於快照寫入（⑥a）之後、
   * 狀態轉換（⑥b）之前呼叫。預設 no-op；生產路徑（`routes.ts`）從不傳入此
   * 選項——與 `completeTravelApplication`／`completeMaintenanceApplication` 之
   * `__testOnlyFailAfterSnapshotWrite` 同型。
   */
  __testOnlyFailAfterSnapshotWrite?: () => void;
}

const COMPLETE_DEPRECIATION_MAX_RETRIES = 6;

/**
 * 快照寫入之顯式定精度（AC-55(c)）——scale 一律取自 §20.7.1 之 DDL，零魔術數。
 *
 * `snapshotRatio` 之 scale 不另立常數：其值一律取自
 * `calculateDepreciation().ratioString`（已由 `RATIO_DISPLAY_SCALE` 量化至
 * 6dp），與 `computed.ratio` 之對外呈現**同一份**實作。
 */
/** `snapshotAnnualDepreciation Decimal(12,2)`。 */
const SNAPSHOT_ANNUAL_DEPRECIATION_SCALE = 2;
/** `snapshotAnnualTotalKm Decimal(9,1)`。 */
const SNAPSHOT_ANNUAL_TOTAL_KM_SCALE = 1;

/**
 * 完成中該申請被刪除（`P2025`）之偵測（AC-30 逐字：「`P2025`（完成中被刪）
 * 不得以 500 呈現」）。形狀沿 `admin/routes.ts` 之既有 `isRecordNotFound`。
 */
function isRecordNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

/**
 * §7.5 完成端點之 400 拒絕形狀：`VALIDATION_ERROR` ＋ `fields[]`（僅具欄位
 * 路徑者）＋ `details.blockers[]`（**永遠是完整清單**），沿 PHASE-004 D14(i)／
 * PHASE-006 `throwMaintenanceBlockersError` 之既有形狀。
 */
function throwDepreciationBlockersError(blockers: Blocker[]): never {
  const fields: FieldError[] = [];
  for (const blocker of blockers) {
    if (typeof blocker.field === "string") {
      fields.push({ field: blocker.field, reason: blocker.message });
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
 * §7.5／§16 D5(a)：缺參數於**完成端點**為 409 `PARAMETER_NOT_AVAILABLE` ＋
 * `details.missing` ＋ `details.applicationYear`（沿差旅既有形狀）。
 *
 * 兩來源之**訊息逐字互異**（AC-16(a)／AC-18；T3 即審 FW-6）：
 *   - 該年 1/1 查無有效版本  → `missing = ["DEPRECIATION"]`
 *     → 管理員該做的事是「**建立**折舊參數」
 *   - 版本存在但 `deriveAnnualDepreciation` 回 `ok:false`
 *     → `missing = ["DEPRECIATION_DERIVATION_FAILED"]`
 *     → 管理員該做的事是「**檢查既有版本的車價與折舊年限**」
 * 兩者於草稿／預覽面被 §7.5 折為同一 blocker code（`PARAMETER_NOT_AVAILABLE`），
 * 但本層必須保留區辨——區辨依據為 `resolved.derivationFailed`（**不是**在本檔
 * 重新判斷版本是否存在）。
 *
 * `missing` 一律以**新陣列**組裝（T7 即審 FW-1）：絕不把
 * `resolveDepreciationParameters` 之回傳陣列直接放進 `details`，亦絕不對其
 * `push`——回傳值之壽命超出本次呼叫時，變異會污染其他呼叫端。
 */
function throwDepreciationParameterNotAvailable(
  resolved: ResolvedDepreciationParameters,
  applicationYear: number
): never {
  const missing = resolved.derivationFailed ? ["DEPRECIATION_DERIVATION_FAILED"] : ["DEPRECIATION"];
  const message = resolved.derivationFailed
    ? "該年度之折舊參數設定值無法推導每年折舊費用，請聯絡管理員檢查折舊參數設定。"
    : "該年度尚無有效折舊參數，請聯絡管理員設定。";
  throw new AppError("PARAMETER_NOT_AVAILABLE", 409, message, undefined, {
    missing,
    applicationYear,
  });
}

/**
 * 完成一筆折舊草稿：狀態機守門 → 完成度（兩段式，§9.3）→ 年度公務里程（同一
 * 交易）→ 參數選版與單價（同一交易）→ 計算與容量守門 → 快照寫入 → 狀態轉換，
 * 全部落在**單一 `SERIALIZABLE` 交易**內（AC-30：任一步驟失敗即全部回滾，
 * 含同一次嘗試中已寫入的快照）。
 *
 * 併發（AC-33 之實作面）：`SERIALIZABLE` ＋ 衝突重試，與
 * `updateDepreciationDraft`／`completeMaintenanceApplication` 同型。同一草稿之
 * 兩個完成請求：敗方之重試以新鮮快照重讀到 `status=COMPLETED`（勝方所寫），
 * `assertTransition` 拋 403。與 `DELETE /attachments/:id` 之競態則為既有的
 * write-skew 形狀——Postgres SSI 偵測到環即中止一方，中止方重試。
 */
export async function completeDepreciationApplication(
  prisma: PrismaClient,
  id: string,
  options: CompleteDepreciationApplicationOptions = {}
): Promise<DepreciationApplicationRecord> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= COMPLETE_DEPRECIATION_MAX_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          // Table name quoted for Postgres case-sensitivity — 與
          // `updateDepreciationDraft`／`completeMaintenanceApplication` 同一
          // 鎖列模式。
          await tx.$queryRaw`SELECT "id" FROM "Application" WHERE "id" = ${id} FOR UPDATE`;

          const existing = await tx.application.findUniqueOrThrow({
            where: { id },
            select: {
              status: true,
              ownerId: true,
              // `annualTotalKm`（§20.7.1）與 `applicationYear` 於**同一次讀取**
              // ——`FOR UPDATE` 鎖列之後，故完成所依據的年度總里程必為鎖定當下
              // 之持久值（AC-27）。
              depreciation: { select: { applicationYear: true, annualTotalKm: true } },
            },
          });

          // ①：狀態機守門（單一事實來源）。非 DRAFT（已完成，或理論不可達之
          // VOIDED）→ 403 FORBIDDEN。
          assertTransition(existing.status, "COMPLETED");

          const applicationYear = existing.depreciation?.applicationYear ?? null;
          const annualTotalKm = existing.depreciation?.annualTotalKm ?? null;

          // ②（第一段，§20.5）：`officialKm` 省略 ＝「尚未查詢」，完全抑制第
          // 4~6 碼。非空即拒絕，**不**執行 ③④。年度為 `null`／非整數一律在
          // 此以 400 `YEAR_REQUIRED` 拒絕（T7 即審 FW-3：**絕不**映射為 409
          // ——沒有年度就沒有「該年度無參數」之語意）；年度總里程缺漏／`≤0`
          // 同理以 400 拒絕（AC-53：草稿可存，完成才擋）。
          //
          // AC-54（PHASE-007-R6a 之連動）：附件計數已不再是
          // `computeDepreciationBlockers` 之輸入（R3 退場 `DEPRECIATION_
          // ATTACHMENT_REQUIRED`），故本流程原先於此處之 `tx.attachment.count`
          // 查詢隨呼叫端收斂而失去唯一消費者，一併移除（其結果從未用於其他
          // 判定或寫入）。附件上限 5（AC-23）與完成後鎖定（AC-25）屬附件層，
          // 不在本流程。
          const structuralBlockers = computeDepreciationBlockers({
            applicationYear,
            annualTotalKm,
          });
          if (structuralBlockers.length > 0) {
            throwDepreciationBlockersError(structuralBlockers);
          }
          if (
            applicationYear === null ||
            !Number.isInteger(applicationYear) ||
            annualTotalKm === null
          ) {
            // 不可達：第一段之 `YEAR_REQUIRED`／`ANNUAL_TOTAL_KM_REQUIRED` 已涵
            // 蓋此條件（判準同源於 `computeDepreciationBlockers`）。此處僅為型別
            // 窄化，不含第二份判定。
            throw new AppError("INTERNAL_ERROR", 500, "計算結果異常，請聯絡管理員");
          }

          // ③：年度公務里程——引擎唯一呼叫點，同一交易；`ownerId` 恆為
          //     `Application.ownerId`（絕不為操作者）。
          const { dateFrom, dateTo } = depreciationYearRange(applicationYear);
          const { totalKm } = await sumOfficialMileage(tx, {
            ownerId: existing.ownerId,
            dateFrom,
            dateTo,
          });

          // ④：選版——交易內重新解析（T7 即審 FW-2）＋每年折舊費用（AC-49；
          //     推導唯一實作為 `deriveAnnualDepreciation`，本檔零算式、零呼叫
          //     `deriveDepreciation`——AC-49(c) 之負向 spy 涵蓋完成路徑）。
          const resolved = await resolveDepreciationParameters(tx, applicationYear);
          const { annualDepreciation } = resolved;

          // ⑤（第二段，§20.5）：`officialKm`／`annualDepreciation` 同給。容量
          //     判定於此函式內部發生**恰一次**（見檔頭「單一決策點」說明）。
          const secondPassBlockers = computeDepreciationBlockers({
            applicationYear,
            annualTotalKm,
            officialKm: totalKm,
            annualDepreciation,
          });
          if (secondPassBlockers.length > 0) {
            // T7 即審 FW-3：完成端點之錯誤映射**不得**複用 `computed`／草稿之
            // `blockingCodes`——一律由本次交易內重算之 blocker 決定：
            // `PARAMETER_NOT_AVAILABLE` → 409（§16 D5(a)），其餘 → 400。
            if (secondPassBlockers.some((b) => b.code === "PARAMETER_NOT_AVAILABLE")) {
              throwDepreciationParameterNotAvailable(resolved, applicationYear);
            }
            throwDepreciationBlockersError(secondPassBlockers);
          }

          const { version } = resolved;
          if (version === null || annualDepreciation === null) {
            // 不可達：第二段為空 ⇒ 第 4 碼未產生 ⇒ 版本與每年折舊費用必非 null。
            throw new AppError("INTERNAL_ERROR", 500, "計算結果異常，請聯絡管理員");
          }

          // 供寫入之**唯一** `calculateDepreciation` 結果物件。
          const result = calculateDepreciation({
            annualDepreciation,
            officialKm: totalKm,
            annualTotalKm,
          });
          if (result.rawAmount === null || result.amount === null || result.ratioString === null) {
            // 不可達：非有限值會使容量 predicate 回 `true` → 第 4 碼 → 上方
            // 已於寫入前拒絕。三者於 `calculateDepreciation` 同進同退
            // （`calculable=false` ⇒ 全 `null`），此處僅為型別窄化。
            throw new AppError("INTERNAL_ERROR", 500, "計算結果異常，請聯絡管理員");
          }

          // ⑥a：**9 個快照欄**（AC-55(a) 逐字），**顯式定精度**（AC-55(c)：
          //      `toFixed(scale)` 後以字串建構 `Decimal`，防裁尾零與 Postgres
          //      對超 scale 小數之**靜默四捨五入**——T1 FW-3：Postgres 不報錯，
          //      故服務層定精度為承重需求，不可依賴 DB 捨入）。
          //      五個 `Decimal` 欄之 scale 逐一對應 §20.7.1 之 DDL：
          //        snapshotVehiclePrice       Decimal(12,2)
          //        snapshotAnnualDepreciation Decimal(12,2)
          //        snapshotOfficialKm         Decimal(12,2)
          //        snapshotAnnualTotalKm      Decimal(9,1)
          //        snapshotRatio              Decimal(9,6)
          //        snapshotRawAmount          Decimal(14,4)
          //      前四者之來源天然即為該 scale（參數表 2dp／引擎 2dp／里程和
          //      2dp／`parseAnnualTotalKmField` 1dp），故量化為無損；
          //      `snapshotRatio`（全精度除法，可為無窮循環小數）與
          //      `snapshotRawAmount`（2dp×2dp÷1dp）則必然發生量化，一律走與
          //      DTO 呈現**同一份**實作（`ratioString` 由 `calculateDepreciation`
          //      產出、`formatRawAmount` 為既有函式），勿寫第二份。
          //
          // AC-55(b) 舊二欄恆 `null`（**兩欄皆明文寫 `null`，不是省略**——
          // 省略會讓「順手寫入」之 mutant 與正確實作在 diff 上難以區辨，明文
          // `null` 則使該意圖成為可讀的契約）：
          //   - `snapshotPerKmUnitPrice`：修訂後之申請路徑**零呼叫**
          //     `deriveDepreciation`（AC-49(c)），每公里單價結構性不可得；
          //   - `snapshotEstimatedAnnualKm`：參數版本之 `estimatedAnnualKm` 已
          //     為凍結唯讀欄（§20.7.5），歷史版本雖仍帶原值，**絕不**順手抄進
          //     新模型快照（AC-56(a) 之判別依賴此不變式）。
          // 兩者一律 `null`，**絕不**以 0 或任何佔位值填充。
          const calculatedAt = new Date();
          await tx.depreciationApplication.update({
            where: { applicationId: id },
            data: {
              snapshotVehiclePrice: new Prisma.Decimal(version.vehiclePrice.toFixed(2)),
              snapshotUsefulLifeYears: version.usefulLifeYears,
              snapshotAnnualDepreciation: new Prisma.Decimal(
                result.annualDepreciation.toFixed(SNAPSHOT_ANNUAL_DEPRECIATION_SCALE)
              ),
              snapshotOfficialKm: new Prisma.Decimal(result.officialKm.toFixed(2)),
              snapshotAnnualTotalKm: new Prisma.Decimal(
                result.annualTotalKm.toFixed(SNAPSHOT_ANNUAL_TOTAL_KM_SCALE)
              ),
              // `ratioString` 為 `calculateDepreciation` 已以顯式 `ROUND_HALF_UP`
              // 量化至 6dp 之字串（AC-50(b)），與 `computed.ratio` 之對外呈現
              // 同一來源；此處直接還原為 `Decimal` 寫入，不重算、不二次量化。
              snapshotRatio: new Prisma.Decimal(result.ratioString),
              snapshotRawAmount: new Prisma.Decimal(formatRawAmount(result.rawAmount)),
              calculatedAt,
              depreciationParameterVersionId: version.id,
              // ── 凍結唯讀（舊模型）：新模型列恆 `null`，AC-55(b) ──
              snapshotEstimatedAnnualKm: null,
              snapshotPerKmUnitPrice: null,
            },
          });

          // TEST-ONLY 注入點——見 `CompleteDepreciationApplicationOptions`。
          // 上方寫入的快照必須與下方狀態轉換一同回滾。
          options.__testOnlyFailAfterSnapshotWrite?.();

          // ⑥b：狀態轉換 —— 最後一筆寫入。`totalAmount` 直接取
          //      `result.amount`（AC-55(d)：不得二次取整、不得由 4dp
          //      `snapshotRawAmount` 反推、不得經 `snapshotRatio`）。
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
            include: depreciationApplicationInclude,
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (err) {
      lastError = err;

      // 業務錯誤（403/400/409/…）與測試注入之錯誤一律立即上拋，永不重試。
      if (err instanceof AppError) {
        throw err;
      }

      // AC-30：完成中該申請被刪除 → 404，**不得**以 500 呈現。
      if (isRecordNotFound(err)) {
        throw new AppError("NOT_FOUND", 404, "找不到指定的申請");
      }

      if (!isRetryableTransactionConflict(err)) {
        throw err;
      }

      if (attempt >= COMPLETE_DEPRECIATION_MAX_RETRIES) {
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
