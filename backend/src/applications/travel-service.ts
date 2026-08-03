/**
 * Travel application service — PHASE-004-T3
 *
 * Spec §2 群組 A（AC-01~07）、§8.1 DTO、§8.2 差旅端點、§9 Data Flow「建立草稿」
 * 「儲存草稿」、§17.1 D9（primaryDate）。
 *
 * Owns the DB-touching half of the travel draft CRUD vertical; `routes.ts`
 * (Fastify plugin) is the thin HTTP layer that calls into this module,
 * mirroring the parameters/parameter-service.ts + parameters/routes.ts split
 * (T3 Packet §Required Context 4).
 *
 * PHASE-004-T8（本次擴充，完成流程 + 快照，AC-49~54/43/48/59）：
 *   - `completeTravelApplication`：狀態機守門 → 完整性驗證（`completion-blockers.ts`
 *     同一份純函式，D7/C4）→ 參數可用性（獨立 409，AC-47）→ 計算引擎（T6
 *     `calculateTravel` 原樣重用，C1）→ 段落/申請快照寫入 → 狀態轉換，單一
 *     SERIALIZABLE 交易（AC-53 原子性；B-29 併發以重試+`assertTransition`
 *     收斂）。
 *   - `toTravelApplicationDto`：`TripSegmentDto.snapshot`/`TravelApplicationDto.snapshot`
 *     已接入真實快照資料（COMPLETED 專用，讀欄位非重算，AC-48）。
 *     `TODO(PHASE-004-T8)` 標記已移除。
 *
 * PHASE-004-T4（本次擴充）：`updateTravelDraft` 的 `segments` 整份 PUT diff
 * 語意（D15）+ 刪段連帶 detach（D16）+ `deleteApplication` 的 AC-05 補完，
 * 皆已接入，見下方個別函式的文件註解。
 *
 * PHASE-004-T7（本次擴充）：`computed`（草稿即算預覽）與
 * `completionBlockers` 的 `missingParameters` 已接入 `toTravelApplicationDto`
 * （見 `formatTravelComputed` 與呼叫端）。`TODO(PHASE-004-T7)` 標記已移除。
 *
 * PHASE-004-T11（本次擴充，AR-D 閉環 + D11/D12）：
 *   - `SegmentPatch.attachmentIds`：`PUT` 每段的附件對帳（新增 → link、
 *     移除 → detach）已接入 `updateTravelDraft`，於同一交易內完成
 *     （`reconcileSegmentAttachments`，Spec §9「儲存草稿」步驟④）。
 *   - `TripSegmentDto.attachments`：已填入真實 `AttachmentDto[]`
 *     （`getSegmentAttachments`），`TODO(PHASE-004-T11)` 標記已移除。
 *
 * PHASE-004-T11R2（B-30 修復回合，取代 T11 與 T11R 的錯誤診斷；Spec §17 D19，
 * 使用者 2026-08-02 批准）：
 *   - 真正的根因不是併發控制機制本身，而是 `computeAttachmentDeltas`（附件
 *     link/detach 的差集運算）曾經在**交易外**、以一次性的 `prisma`（非 `tx`）
 *     讀取算好，兩個併發請求各自對著同一份「舊」LINKED 集合算出自己的
 *     toRemove/toLink，於是都只 link、都沒 detach 對方——最終可能超過上限。
 *     修法：baseline 一律在交易內、對本次 attempt 當下的 `tx` 現算（見
 *     `updateTravelDraft` 交易本體），SERIALIZABLE 下每次交易嘗試（含 retry）
 *     天然拿到當次的最新快照，不再有交易外的過期基準。
 *   - D19「併發整份 PUT＝最後寫入者贏」：兩個併發整份 PUT 各自宣告合法附件集合
 *     時皆回 200；後手在其（重試後的新鮮）快照下正確算出「detach 前手多出的、
 *     link 自己要的」，最終該段附件數恆等於後手宣告的數量，不超過上限。
 *   - SERIALIZABLE 保留：`Step 5` 對任何送出的既有段落一律執行
 *     `tx.tripSegment.update`，這是兩個併發 PUT 若命中同一段落時，會真正寫入
 *     同一列的必然操作——Postgres 對此的並發衝突偵測（`could not serialize
 *     access due to concurrent update`）是標準、無條件的 MVCC 行為，不依賴任何
 *     顯式鎖，交易任一方因而在 `FOR UPDATE`／後續寫入時收到 P2034/P2010(40001)，
 *     以新交易重試、在新鮮快照下正確算出最終狀態。
 *   - Advisory lock 已移除（原 T11 加入、T11R 誤判為關鍵機制）：baseline 移入
 *     交易內之後，鎖已無必要——上述真實列寫入衝突已足夠讓兩個併發 PUT 正確
 *     序列化，不需要額外的 `pg_advisory_xact_lock`。
 *
 * D6 授權邊界（最高優先，Spec §17.1 D6(c)）：`TravelComputedDto` **刻意不含**
 * `fuelUnitPrice`/`etcUnitPrice`/`fuelParameterVersionId`/`etcParameterVersionId`
 * 欄位——不是「有欄位但留空」，是型別上根本不存在這些 key，從編譯期杜絕任何
 * 程式路徑意外把單價寫進草稿/預覽回應。Spec §8.1 `TravelComputedDto` 上的
 * `fuelUnitPrice?`/`etcUnitPrice?`（帶 `?`）僅表示「是否回傳見 D6」——D6(c)
 * 定案為「草稿/預覽不含單價；已完成 snapshot 含單價」，故本 Phase 的
 * `TravelComputedDto`（草稿/預覽專用）完全不宣告這兩個欄位；單價只會出現在
 * T8 的 `TravelSnapshotDto`（已完成專用，讀快照非重算）。
 */

import type { ApplicationStatus, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  type AttachmentDto,
  detachAttachmentsByIdsTx,
  detachAttachmentsByRefTx,
  linkAttachmentTx,
  toDto as toAttachmentDto,
} from "../attachment/lifecycle-service.js";
import { formatUtcDate } from "../parameters/parameter-service.js";
import { AppError } from "../platform/errors.js";
import type { FieldError } from "../platform/errors.js";
import { assertApplicationMutable, assertTransition } from "./application-state-machine.js";
import type { Blocker } from "./completion-blockers.js";
import { computeCompletionBlockers } from "./completion-blockers.js";
import { computeSegmentDiff } from "./segment-diff.js";
import { type CalcResult, type CalcSegmentInput, calculateTravel } from "./travel-calculation.js";
import {
  type MissingParameter,
  type ResolvedParameters,
  assertParametersAvailable,
  resolveTravelParameters,
} from "./travel-parameters.js";

// ---------------------------------------------------------------------------
// SEGMENT_ATTACHMENT_LIMIT — PHASE-004-T11 (AC-22, Spec §10.4)
// ---------------------------------------------------------------------------

/**
 * Per-segment attachment cap. Business constant, NOT an environment variable
 * (Spec §10.4 明文：「附件上限 3 為業務常數而非環境設定」) — the client cannot
 * supply or override this value; `PUT /applications/travel/:id`'s body never
 * carries a `limit` field for segments at all (only `attachmentIds[]`), so
 * there is no code path through which a client value could reach
 * `linkAttachmentTx`.
 */
export const SEGMENT_ATTACHMENT_LIMIT = 3;

// ---------------------------------------------------------------------------
// Date helpers (D9 primaryDate derivation)
// ---------------------------------------------------------------------------

/** Truncate a Date to its UTC day-part (day granularity, matches @db.Date semantics). */
export function utcDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * D9 primaryDate 推導規則：
 *   - tripDate 有值 → primaryDate = tripDate
 *   - tripDate 為 null → primaryDate = 該申請 createdAt 的「日期部分」（UTC 日粒度）
 * `createdAtFallback` 於建立時為「現在」（DB createdAt 尚未產生前的近似值，
 * 兩者同日的機率在正常操作下恆成立）；於更新時為既有 Application.createdAt。
 */
export function derivePrimaryDate(tripDate: Date | null, createdAtFallback: Date): Date {
  if (tripDate !== null) return tripDate;
  return utcDateOnly(createdAtFallback);
}

// ---------------------------------------------------------------------------
// Prisma include shape shared by create/read/update
// ---------------------------------------------------------------------------

const travelApplicationInclude = {
  // loginName（PHASE-004-T12 新增）: 供 on-behalf 稽核 hook 組 targetLabel
  // 用（AC-82：「擁有人 loginName 快照 + 申請識別」）——loginName 本身非敏感
  // 資料（非密碼/token），沿用既有 displayName 的同一個 select 物件擴充，
  // 不新增查詢往返。
  owner: { select: { displayName: true, loginName: true } },
  createdBy: { select: { displayName: true } },
  travel: {
    include: {
      segments: { orderBy: { sortOrder: "asc" as const } },
    },
  },
} satisfies Prisma.ApplicationInclude;

type TravelApplicationRecord = Prisma.ApplicationGetPayload<{
  include: typeof travelApplicationInclude;
}>;

// ---------------------------------------------------------------------------
// PHASE-004-T12 audit hooks — AC-82/83/86
//
// Both `createTravelDraft` and `updateTravelDraft` accept an OPTIONAL hook
// invoked INSIDE the same transaction that writes the primary Application/
// TravelApplication/TripSegment rows (mirrors `parameters/parameter-service.ts`'s
// `onCreated` pattern, T5/PHASE-003a precedent — see that file's header
// comment). The hook is deliberately typed to accept `Prisma.TransactionClient`
// (the type Prisma's own `$transaction` callback already produces — no local
// hand-rolled `Omit<PrismaClient, ...>` alias needed, unlike
// parameter-service.ts, since this file already uses `Prisma.TransactionClient`
// elsewhere, e.g. `computeAttachmentDeltas`).
//
// Callers (admin/routes.ts, applications/routes.ts) decide WHETHER to pass a
// hook at all — this file has no knowledge of "who is calling" (actorId) or
// "is this on-behalf" (AC-86/C3: `actorId !== ownerId`). A caller that omits
// the hook gets ZERO audit writes for that call, satisfying AC-86 (self
// create/update never audited) simply by never constructing a hook in that
// code path — there is no separate "skip audit" flag to get wrong.
//
// Atomicity (AC-83): the hook runs INSIDE the transaction, using the SAME
// `tx` handle as every other write in this function. If the hook throws
// (e.g. a genuine DB write failure, or a test-injected failure), the
// exception propagates out of the `prisma.$transaction(...)` callback exactly
// like any other error raised mid-transaction — Prisma rolls back the WHOLE
// transaction, including the Application/TravelApplication/TripSegment writes
// that already ran earlier in the SAME attempt. Nothing partial can land.
// ---------------------------------------------------------------------------

export type OnTravelDraftCreated = (
  tx: Prisma.TransactionClient,
  application: TravelApplicationRecord
) => Promise<void>;

/** Before-state snapshot passed to `OnTravelDraftUpdated`, read fresh inside the same transaction attempt (never a stale pre-transaction read — see `updateTravelDraft`'s existing SERIALIZABLE re-read discipline). */
export interface TravelDraftUpdateAuditContext {
  ownerId: string;
  ownerLoginName: string;
  before: {
    tripDate: Date | null;
    purpose: string | null;
    segmentsCount: number;
  };
}

export type OnTravelDraftUpdated = (
  tx: Prisma.TransactionClient,
  context: TravelDraftUpdateAuditContext,
  application: TravelApplicationRecord
) => Promise<void>;

// ---------------------------------------------------------------------------
// createTravelDraft (AC-01)
// ---------------------------------------------------------------------------

export interface CreateTravelDraftInput {
  ownerId: string;
  createdById: string;
  tripDate?: Date | null;
  purpose?: string | null;
}

/**
 * Creates a new TRAVEL draft (Application + TravelApplication, 1:1).
 *
 * owner is ALWAYS supplied by the caller from `request.currentUser` /
 * `:userId` (admin on-behalf, T10) — never from request body (AC-79a,
 * §6.2 資料隔離不變式 1).
 *
 * PHASE-004-T12（本次擴充，AC-82/83）: previously a single Prisma nested
 * write (Prisma already wraps a nested `create` in one atomic operation on
 * its own — see T1 model test for that prior pattern). Now explicitly
 * wrapped in `prisma.$transaction` so the OPTIONAL `onCreated` audit hook
 * (see this file's header "PHASE-004-T12 audit hooks" section) can run in
 * the SAME transaction as the insert — required for AC-83's atomicity
 * ("稽核寫入失敗 → 主體變更 rollback"). Default (unspecified) isolation
 * level is intentionally UNCHANGED from before this Task: this function has
 * no read-then-write race to protect against (a single `create`, no
 * existing-row read to go stale) — explicit `$transaction` wrapping changes
 * NOTHING about concurrent-safety here, only adds the hook's atomicity.
 * `onCreated` defaults to a no-op when omitted (the general
 * `POST /applications/travel` self-create route never passes one — AC-86:
 * self-service create is NEVER audited).
 */
export async function createTravelDraft(
  prisma: PrismaClient,
  input: CreateTravelDraftInput,
  onCreated?: OnTravelDraftCreated
): Promise<TravelApplicationRecord> {
  const tripDate = input.tripDate ?? null;
  const purpose = input.purpose ?? null;
  const primaryDate = derivePrimaryDate(tripDate, new Date());

  return prisma.$transaction(async (tx) => {
    const application = await tx.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: input.ownerId,
        createdById: input.createdById,
        primaryDate,
        travel: {
          create: {
            tripDate,
            purpose,
          },
        },
      },
      include: travelApplicationInclude,
    });

    if (onCreated) {
      await onCreated(tx, application);
    }

    return application;
  });
}

// ---------------------------------------------------------------------------
// getTravelApplication (AC-04)
// ---------------------------------------------------------------------------

/**
 * Reads a TRAVEL application by id, segments ordered by sortOrder asc.
 * Returns null if not found OR the application is not a TRAVEL type
 * (defensive — this Task only ever creates TRAVEL rows, but /applications/travel/:id
 * must not leak non-travel rows even if another Phase later reuses the id space).
 */
export async function getTravelApplication(
  prisma: PrismaClient,
  id: string
): Promise<TravelApplicationRecord | null> {
  const application = await prisma.application.findUnique({
    where: { id },
    include: travelApplicationInclude,
  });
  if (!application || application.type !== "TRAVEL" || !application.travel) {
    return null;
  }
  return application;
}

// ---------------------------------------------------------------------------
// getApplicationForAuth — lightweight fetch for DELETE /applications/:id
// (type-agnostic; DELETE is a generic endpoint across all Application types)
// ---------------------------------------------------------------------------

export interface ApplicationAuthRow {
  id: string;
  ownerId: string;
  status: ApplicationStatus;
}

export async function getApplicationForAuth(
  prisma: PrismaClient,
  id: string
): Promise<ApplicationAuthRow | null> {
  const application = await prisma.application.findUnique({
    where: { id },
    select: { id: true, ownerId: true, status: true },
  });
  return application;
}

// ---------------------------------------------------------------------------
// updateTravelDraft (AC-02/03/04, D9, tripDate/purpose 三態語意)
// ---------------------------------------------------------------------------

/**
 * `tripDate`/`purpose` 三態語意（§8.2）：
 *   - key 缺席（未出現於 `patch` 物件上）= 不變
 *   - key 存在但值為 `null`           = 清空
 *   - key 存在且有值                  = 設定
 * 呼叫端（routes.ts）以 `"tripDate" in patch` 判斷是否要帶入該 key，藉此把
 * HTTP body 的三態原封不動地傳遞下來，不在此處做「undefined 視為缺席」的
 * 二次判斷（因為 `patch.tripDate = undefined` 在 JS 物件上與「key 不存在」
 * 語意不同，呼叫端已經用 `in` 操作子正確處理，此處直接信任 key 存在與否）。
 *
 * primaryDate 每次呼叫都重新推導（不可只在建立時算一次）——套用既有
 * `Application.createdAt` 作為 tripDate 清空時的回退基準（D9）。
 */
export interface UpdateTravelDraftPatch {
  tripDate?: Date | null;
  purpose?: string | null;
}

// ---------------------------------------------------------------------------
// segments diff — PHASE-004-T4 (AC-08~13, D15, D16)
// ---------------------------------------------------------------------------

/**
 * One `segments[]` entry from the `PUT` body, ALREADY format-validated and
 * parsed by `routes.ts` (`totalKm`/`highwayKm` as `Prisma.Decimal`,
 * `origin`/`destination` as plain strings) — this module never re-parses
 * raw request values (Packet: 複用 T5 `parseKmField`/`parseLocationField`,
 * 不重寫解析).
 *
 * Per-field three-state semantics, mirroring `UpdateTravelDraftPatch`'s
 * tripDate/purpose convention (§8.2 「`tripDate`/`purpose` 的三態」, extended
 * here to each segment field since `SegmentInput`'s fields are declared the
 * same optional-nullable shape `field?: T | null`):
 *   - key absent from the object     = 不變（UPDATE 保留既有值；CREATE 視為
 *     null，因新段沒有「既有值」可保留）
 *   - key present with value `null`  = 清空
 *   - key present with a value       = 設定
 * Presence is tested via `Object.prototype.hasOwnProperty`, exactly like
 * `updateTravelDraft`'s own patch handling above.
 *
 * `attachmentIds`（PHASE-004-T11 新增）：三態語意與其他欄位一致——
 *   - key 缺席              = 不對帳該段附件（保留既有 LINKED 關聯不動）
 *   - key 存在（含空陣列 `[]`） = 該段附件的完整目標集合；與目前 LINKED 集合
 *     做差集：新增者 → link、移除者 → detach（見 `reconcileSegmentAttachments`）
 * 這與 Spec §8.2 `SegmentInput.attachmentIds` 宣告為必填（無 `?`）字面上不同，
 * 但為與本檔其餘欄位一致的三態慣例的合理延伸：既有 T4 測試已大量出現「只帶
 * `{id}` 更新既有段、完全不提 `attachmentIds`」的請求（例如排序調整），若把
 * 缺席視為「清空所有附件」會在使用者只是調整順序時意外解除所有附件關聯，
 * 屬未在任何 AC 中要求的破壞性副作用；「缺席=不動」與 D15 對 `tripDate`/
 * `purpose`/各段其他欄位的既有三態慣例完全一致。
 */
export interface SegmentPatch {
  id?: string;
  origin?: string | null;
  destination?: string | null;
  totalKm?: Prisma.Decimal | null;
  highwayKm?: Prisma.Decimal | null;
  attachmentIds?: string[];
}

function hasKey(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

interface ExistingSegmentRow {
  id: string;
  origin: string | null;
  destination: string | null;
  totalKm: Prisma.Decimal | null;
  highwayKm: Prisma.Decimal | null;
}

/** Resolve one field's next value under the three-state rule described above. */
function resolveSegmentField<K extends keyof SegmentPatch>(
  patch: SegmentPatch,
  key: K,
  previous: ExistingSegmentRow[K & keyof ExistingSegmentRow] | null
): SegmentPatch[K] extends undefined ? never : NonNullable<SegmentPatch[K]> | null {
  if (hasKey(patch, key)) {
    return (patch[key] ?? null) as never;
  }
  return (previous ?? null) as never;
}

/**
 * `tripDate`/`purpose`/`patch` 三態語意（同上一段函式）；`segments` 欄位缺席
 * = 段落完全不變（三態，維持 T3 既有 array-level 語意）；`segments: []` =
 * 刪光所有段落（AC-12）。
 *
 * 單一 `prisma.$transaction` 內完成（D15/D16、Packet Done When 3）：
 *   1. 讀取現有段落（含欄位值，供 UPDATE 三態合併與 detach 用 id 清單）
 *   2. `computeSegmentDiff`（純函式；未知/他人 segment id 或重複 id → 拋
 *      `AppError`，交易自動 rollback，PUT 完全不落地 — 見下方 routes.ts
 *      call site 對 403/404 選擇的說明）
 *   3. 刪除 `toDeleteIds` 段落
 *   4. 對 `toDeleteIds` 呼叫 `detachAttachmentsByRefTx`（同交易內，D16：
 *      只做 DB、不做 storage IO）
 *   5. 更新 `toUpdate`（欄位三態合併 + `sortOrder`）；`attachmentIds` key 存在
 *      者記入 `attachmentPlans`（PHASE-004-T11）
 *   6. 建立 `toCreate`（欄位 + `sortOrder`，逐筆 `create` 以取得新段真實 id）；
 *      `attachmentIds` key 存在者以新段 id 記入 `attachmentPlans`（T11）
 *   6.5. 附件對帳：對 `attachmentPlans` 中每段，於**交易內**（`tx`）現算
 *      `computeAttachmentDeltas`，將目前 LINKED 集合與請求集合做差集 → 先
 *      detach 全部「移除者」（跨所有段落一次做完，讓同一次 PUT 內把附件從 A
 *      段移到 B 段的情境可行）→ 再 link 全部「新增者」（含擁有權一致性
 *      AC-30、409 CONFLICT B-17、409 TOO_MANY_ATTACHMENTS AC-22，
 *      `SEGMENT_ATTACHMENT_LIMIT` 為後端常數）。D19：兩個併發整份 PUT 對同一
 *      段落各自宣告合法集合時皆回 200，最後提交者的宣告為準（見下方
 *      PHASE-004-T11R2 說明）。
 *   7. 更新 `tripDate`/`purpose`/`primaryDate`
 * 任一步驟失敗 → Prisma 自動 rollback 整個交易，含步驟 3/4/6.5 的刪除/detach/
 * link（交易原子性 — Packet Done When 3/4「交易任一步失敗 → 全部不落地」）。
 *
 * PHASE-004-T11R2（B-30/D19，見檔頭同名段落）：`computeAttachmentDeltas` 於
 * Step 6.5 一律傳入 `tx`（交易內連線），在每次交易嘗試（含 retry）當下重算——
 * 不再於交易外預先算好、跨 retry 共用同一份基準。交易隔離等級為 SERIALIZABLE；
 * 沒有 advisory lock。並發正確性來自：Step 5 對任一送出的既有段落一律
 * `tx.tripSegment.update`，兩個併發 PUT 若命中同一段落即會真正競爭同一列的
 * 寫入，Postgres 對此的 MVCC 並發衝突偵測（`could not serialize access due to
 * concurrent update`）是無條件觸發的，交易一方因而在寫入或 `FOR UPDATE` 時
 * 收到 P2034/P2010(40001)，交由下方 retry 迴圈以全新交易（全新快照）重跑，
 * 這次 Step 6.5 的 `computeAttachmentDeltas` 便會看到前手已提交的最新狀態，
 * 正確算出「detach 前手多出的、link 自己要的」，收斂到 D19 要求的最終狀態。
 *
 * `SELECT ... FOR UPDATE`（鎖住整筆 `Application` 列，見交易本體）補強保護
 * 不涉及 `segments` 的併發寫入（例如兩個 PUT 都只改 `tripDate`/`purpose`）：
 * Step 7 一律寫入 `Application` 列，同樣的 MVCC 衝突偵測機制在那裡也成立。
 *
 * 重試次數與退避：`UPDATE_DRAFT_MAX_RETRIES`=6 次 + 指數退避（含隨機抖動，
 * 避免多個重試者同步撞期），退避公式：retry 前等待
 * `min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2**attempt) + jitter`。重試只在
 * Postgres 回報的真正序列化失敗（P2034 / SQLSTATE 40001）時才會發生——交易
 * 已 abort、無任何寫入落地，故加入延遲重試在語意上安全。
 */
const UPDATE_DRAFT_MAX_RETRIES = 6;
const RETRY_BACKOFF_BASE_MS = 15;
const RETRY_BACKOFF_CAP_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter for serialization-failure retries (see doc comment above). */
function retryBackoffMs(attempt: number): number {
  const exp = Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

/**
 * PHASE-004-R4: is `err` a transient, retry-eligible Postgres transaction
 * conflict raised by a concurrent SERIALIZABLE transaction? Shared by all
 * three retry loops in this file (`updateTravelDraft`,
 * `completeTravelApplication`, `deleteApplication`).
 *
 * Discovered while writing this round's REQUIRED concurrency tests
 * (`phase4-concurrency-freeze.test.ts`, genuine `Promise.allSettled` races
 * between `updateTravelDraft`/`deleteApplication` and
 * `completeTravelApplication`): a real Postgres DEADLOCK (SQLSTATE 40P01,
 * "deadlock detected") can occur when `updateTravelDraft`'s `SELECT ...
 * FOR UPDATE` on the `Application` row and `completeTravelApplication`'s
 * ordinary `tx.tripSegment.update`/`tx.application.update` calls form a lock
 * -wait cycle (A holds the Application row lock, waiting on a TripSegment row
 * B already holds; B is waiting on the Application row A holds). Postgres's
 * deadlock detector aborts one side with 40P01 — this is DIFFERENT from a
 * SERIALIZABLE serialization failure (40001) and was NOT previously
 * recognized as retryable by ANY of this file's three retry loops, so a real
 * concurrent PUT-vs-complete deadlock would have propagated as an unhandled
 * error instead of being retried like every other transient conflict here.
 *
 * Three distinct shapes this can arrive in (all observed or documented):
 *   - P2034: Prisma's own conflict code for ordinary (non-raw) Prisma Client
 *     operations — the ORIGINAL case this file's retry loops already handled.
 *   - P2010 wrapping Postgres SQLSTATE 40001 or 40P01: surfaces through
 *     `$queryRaw` (the `SELECT ... FOR UPDATE` lock in `updateTravelDraft`/
 *     `deleteApplication`) because raw queries report the underlying DB error
 *     via Prisma's generic "raw query failed" code rather than P2034.
 *   - `PrismaClientUnknownRequestError` with "deadlock detected" in its
 *     message: observed via `completeTravelApplication`'s ORDINARY (non-raw)
 *     `tx.application.update` call when IT is the deadlock victim — Prisma
 *     5.x does not map this case to a `PrismaClientKnownRequestError` code at
 *     all, so the two `P2xxx` checks above cannot catch it; the message must
 *     be inspected directly.
 *
 * Retrying on 40P01 (in addition to 40001) is standard practice for
 * SERIALIZABLE transactions — NOT a lowering of isolation level, NOT an
 * increase to any function's retry COUNT (still 6, unchanged), and NOT a
 * test-weakening move: it recognizes an additional legitimate,
 * already-transient Postgres error class as retry-eligible, exactly the way
 * 40001 already was.
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

/** One segment's attachment reconciliation target, gathered while creating/updating segments. */
interface SegmentAttachmentPlan {
  segmentId: string;
  requestedIds: string[];
}

/** A fixed, already-decided set of link/detach operations for one segment. */
interface SegmentAttachmentDelta {
  segmentId: string;
  toLink: string[];
  toRemove: string[];
}

/**
 * Compute the ADD/REMOVE delta for each planned segment against its CURRENT
 * `LINKED` set (one DB read).
 *
 * A PURE diff step — no writes. PHASE-004-T11R2 (Spec §17 D19; see
 * `updateTravelDraft`'s doc comment for the full account): `updateTravelDraft`
 * calls this with `tx` — ALWAYS inside its own transaction, and freshly on
 * EVERY attempt including retries. This is deliberate: a previous version of
 * this function was called with a plain (non-transactional) `PrismaClient`
 * ONCE before the retry loop even started, so every retry reused the SAME
 * stale delta — under concurrent PUTs to the same segment, both sides could
 * compute "add my attachment" against the SAME pre-race LINKED set without
 * ever computing "remove the other side's addition", letting the segment's
 * count exceed its limit. Calling this fresh, inside `tx`, on every attempt
 * fixes that: a transaction that had to retry (because a concurrent PUT it
 * raced against already committed and wrote a conflicting row — see
 * `updateTravelDraft`'s doc comment for why that conflict is guaranteed to
 * surface) gets a FRESH SERIALIZABLE snapshot on its new attempt, so this
 * function correctly sees the other side's already-committed LINKED set and
 * computes the RIGHT delta: detach whatever no longer belongs, link whatever
 * this attempt's own request still wants (Spec §17 D19 "最後寫入者贏").
 */
async function computeAttachmentDeltas(
  tx: Prisma.TransactionClient,
  plans: ReadonlyArray<SegmentAttachmentPlan>
): Promise<SegmentAttachmentDelta[]> {
  if (plans.length === 0) return [];

  const segmentIds = plans.map((p) => p.segmentId);
  const currentRows = await tx.attachment.findMany({
    where: { refType: "TRIP_SEGMENT", refId: { in: segmentIds }, status: "LINKED" },
    select: { id: true, refId: true },
  });
  const currentBySegment = new Map<string, Set<string>>();
  for (const row of currentRows) {
    if (!row.refId) continue;
    const set = currentBySegment.get(row.refId) ?? new Set<string>();
    set.add(row.id);
    currentBySegment.set(row.refId, set);
  }

  return plans.map((plan) => {
    const current = currentBySegment.get(plan.segmentId) ?? new Set<string>();
    const requested = new Set(plan.requestedIds);
    const toRemove = [...current].filter((existingId) => !requested.has(existingId));
    const toLink = plan.requestedIds.filter((attachmentId) => !current.has(attachmentId));
    return { segmentId: plan.segmentId, toLink, toRemove };
  });
}

/**
 * Apply a delta (add/remove lists per segment — see `computeAttachmentDeltas`,
 * called fresh inside `tx` on every attempt, PHASE-004-T11R2) within the
 * caller's transaction (`tx`).
 *
 * Two-pass design (detach-all-first, then link-all) so that moving an
 * attachment from segment A to segment B WITHIN THE SAME `PUT` works: if A's
 * detach ran only after B's link attempt, B would see the attachment still
 * `LINKED` (to A) and incorrectly reject with 409 CONFLICT. Detaching every
 * "removed from this segment" attachment first (across ALL planned segments)
 * makes it TEMP again before any segment's "added" pass runs.
 *
 * Per-attachment checks on the "link" pass (Spec §9 step ④, Done When 4):
 *   1. attachment not found              → 404 NOT_FOUND (B-32)
 *   2. attachment.ownerId !== applicationOwnerId → 403 FORBIDDEN (AC-30)
 *   3. attachment.status !== 'TEMP'      → 409 CONFLICT (B-17 — still LINKED
 *      elsewhere, e.g. referenced by two segments in the same submission)
 *   4. linkAttachmentTx (limit=SEGMENT_ATTACHMENT_LIMIT) → 409
 *      TOO_MANY_ATTACHMENTS if a SINGLE request's own declared set exceeds
 *      the cap (AC-22) — unaffected by D19 (D19 only concerns two DIFFERENT
 *      concurrent requests each declaring a valid set).
 * Any thrown AppError propagates out of the caller's transaction, rolling
 * back everything (including the detach pass) — Done When 4's "超限 →
 * 整份儲存 rollback".
 *
 * `containerState` is NOT a parameter here — `linkAttachmentTx` (unlike the
 * full `linkAttachment`) has no containerState/ownership gate of its own;
 * those checks belong to the caller. Reaching this function at all implies
 * the application is DRAFT — PHASE-004-R4 (M-2 修復): this is now guaranteed
 * by `updateTravelDraft`'s OWN in-transaction `assertApplicationMutable(existing.status)`
 * call (see that function's doc comment), not merely by routes.ts's outer,
 * pre-transaction check. Before R4, this comment described the outer check
 * ALONE as sufficient — that was the exact TOCTOU gap M-2 closed: a
 * concurrent `completeTravelApplication` could commit AFTER routes.ts's
 * outer check passed but BEFORE this transaction's writes, leaving the outer
 * check's DRAFT read stale. The in-transaction re-check now makes the
 * "reaching here implies DRAFT" invariant actually hold for the ATTEMPT that
 * reaches this function, not just for the caller's earlier, separate read.
 */
async function applyAttachmentDeltas(
  tx: Prisma.TransactionClient,
  applicationOwnerId: string,
  deltas: ReadonlyArray<SegmentAttachmentDelta>
): Promise<void> {
  if (deltas.length === 0) return;

  // Pass 1: detach every "removed from this segment" attachment, across ALL
  // planned segments, BEFORE any linking (see doc comment: enables within-PUT
  // moves between segments of the same application).
  const allToRemove = deltas.flatMap((d) => d.toRemove);
  if (allToRemove.length > 0) {
    await detachAttachmentsByIdsTx(tx, allToRemove);
  }

  // Pass 2: link every "added to this segment" attachment. Fresh per-attempt
  // validation (existence/ownership/status/capacity) — see doc comment for
  // why this is what makes the B-30 race resolve correctly even though
  // `toLink` itself is a cached, fixed list across retries.
  for (const delta of deltas) {
    for (const attachmentId of delta.toLink) {
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

      await linkAttachmentTx(tx, {
        attachmentId,
        refType: "TRIP_SEGMENT",
        refId: delta.segmentId,
        limit: SEGMENT_ATTACHMENT_LIMIT,
      });
    }
  }
}

export async function updateTravelDraft(
  prisma: PrismaClient,
  id: string,
  patch: UpdateTravelDraftPatch,
  segments?: ReadonlyArray<SegmentPatch>,
  onUpdated?: OnTravelDraftUpdated
): Promise<TravelApplicationRecord> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= UPDATE_DRAFT_MAX_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          // Pessimistic per-application lock: SELECT ... FOR UPDATE on the
          // Application row being saved. First statement of the transaction.
          //
          // Guards concurrent writes that DON'T touch `segments` at all (e.g.
          // two PUTs that only change `tripDate`/`purpose`) — Step 7 below
          // always writes this same row regardless, so this lock mainly
          // avoids an unnecessary blocking wait turning into a guaranteed
          // P2034 for that narrower case. For the `segments`/`attachmentIds`
          // race (D19, Spec §17), see this function's doc comment — the real
          // protection there comes from Step 5's unconditional
          // `tx.tripSegment.update`, not from this lock.
          //
          // Table name is unquoted-default (`Application`, no `@@map` in
          // schema.prisma) — quoted here for Postgres case-sensitivity.
          await tx.$queryRaw`SELECT "id" FROM "Application" WHERE "id" = ${id} FOR UPDATE`;

          const existing = await tx.application.findUniqueOrThrow({
            where: { id },
            select: {
              status: true,
              ownerId: true,
              createdAt: true,
              // owner.loginName（PHASE-004-T12 新增）: 供 on-behalf 稽核 hook
              // 組 targetLabel 用，讀自本次交易嘗試的新鮮快照（非交易外的過期
              // 讀取——與本函式其餘欄位一致的原則）。
              owner: { select: { loginName: true } },
              travel: {
                select: {
                  tripDate: true,
                  purpose: true,
                  segments: {
                    select: {
                      id: true,
                      origin: true,
                      destination: true,
                      totalKm: true,
                      highwayKm: true,
                    },
                  },
                },
              },
            },
          });

          // PHASE-004-R4 (M-2, High): re-validate mutability INSIDE this
          // transaction, on the FRESH row this attempt just read — do not
          // trust routes.ts's outer, pre-transaction `assertApplicationMutable`
          // call alone. That outer check reads `status` before this
          // transaction even opens; a concurrent `completeTravelApplication`
          // can commit `status=COMPLETED` in the window between the outer
          // check and this line, which the outer check has no way to see.
          // Throwing here (AppError) is caught by the retry loop below and
          // re-thrown immediately without retry (business errors are never
          // retried — see the catch block's `err instanceof AppError` check),
          // so a losing concurrent PUT gets a clean 403, no partial writes.
          assertApplicationMutable(existing.status);

          const nextTripDate = hasKey(patch, "tripDate")
            ? (patch.tripDate ?? null)
            : (existing.travel?.tripDate ?? null);
          const nextPurpose = hasKey(patch, "purpose")
            ? (patch.purpose ?? null)
            : (existing.travel?.purpose ?? null);

          const primaryDate = derivePrimaryDate(nextTripDate, existing.createdAt);

          if (segments !== undefined) {
            const existingSegments: ExistingSegmentRow[] = existing.travel?.segments ?? [];
            const existingById = new Map(existingSegments.map((s) => [s.id, s]));

            // Step 2: pure diff — id 對齊 + sortOrder 重寫（0..n-1）+ 未知/重複 id
            // 拒絕（AppError → 交易 rollback）。
            const diff = computeSegmentDiff<SegmentPatch>({
              existing: existingSegments.map((s) => ({ id: s.id })),
              submitted: segments,
            });

            // Step 3+4: 刪除 + detach（同交易；D16 只做 DB，不做 storage IO）。
            if (diff.toDeleteIds.length > 0) {
              await detachAttachmentsByRefTx(tx, "TRIP_SEGMENT", diff.toDeleteIds);
              await tx.tripSegment.deleteMany({ where: { id: { in: diff.toDeleteIds } } });
            }

            const attachmentPlans: SegmentAttachmentPlan[] = [];

            // Step 5: 更新既有段（欄位三態合併 + sortOrder 重寫）。
            for (const u of diff.toUpdate) {
              const previous = existingById.get(u.id);
              await tx.tripSegment.update({
                where: { id: u.id },
                data: {
                  sortOrder: u.sortOrder,
                  origin: resolveSegmentField(u.data, "origin", previous?.origin ?? null),
                  destination: resolveSegmentField(
                    u.data,
                    "destination",
                    previous?.destination ?? null
                  ),
                  totalKm: resolveSegmentField(u.data, "totalKm", previous?.totalKm ?? null),
                  highwayKm: resolveSegmentField(u.data, "highwayKm", previous?.highwayKm ?? null),
                },
              });
              if (hasKey(u.data, "attachmentIds")) {
                attachmentPlans.push({
                  segmentId: u.id,
                  requestedIds: u.data.attachmentIds ?? [],
                });
              }
            }

            // Step 6: 新增段（缺席欄位 = null，因新段無既有值可保留）。逐筆
            // `create`（非 `createMany`）以取得每個新段的真實 id ——
            // `attachmentIds` 對帳（Step 6.5）需要用新段 id 當 refId。
            for (const c of diff.toCreate) {
              const created = await tx.tripSegment.create({
                data: {
                  travelApplicationId: id,
                  sortOrder: c.sortOrder,
                  origin: c.data.origin ?? null,
                  destination: c.data.destination ?? null,
                  totalKm: c.data.totalKm ?? null,
                  highwayKm: c.data.highwayKm ?? null,
                },
              });
              if (hasKey(c.data, "attachmentIds")) {
                attachmentPlans.push({
                  segmentId: created.id,
                  requestedIds: c.data.attachmentIds ?? [],
                });
              }
            }

            // Step 6.5: 附件對帳。Delta 一律在交易內、對本次 attempt 現算
            // （PHASE-004-T11R2，D19 修法核心——見本函式檔頭文件註解）：不論是
            // 既有段落還是本次新建的段落，`computeAttachmentDeltas(tx, ...)`
            // 都用同一次呼叫、同一份 `tx` 快照計算，沒有交易外的過期基準。
            const deltas = await computeAttachmentDeltas(tx, attachmentPlans);
            await applyAttachmentDeltas(tx, existing.ownerId, deltas);
          }

          // Step 7: tripDate/purpose/primaryDate（沿用既有邏輯）。
          await tx.application.update({
            where: { id },
            data: {
              primaryDate,
              travel: {
                update: {
                  tripDate: nextTripDate,
                  purpose: nextPurpose,
                },
              },
            },
          });

          const after = await tx.application.findUniqueOrThrow({
            where: { id },
            include: travelApplicationInclude,
          });

          // PHASE-004-T12 audit hook (AC-82/83/86): only invoked when the
          // CALLER supplied one (routes.ts decides based on
          // `actorId !== existing.ownerId`, C3 — this function itself has no
          // notion of "who is calling"). Runs on THIS attempt's `tx`, after
          // every primary write and BEFORE the transaction commits — a throw
          // here rolls back everything written above in the SAME attempt
          // (AC-83 atomicity). "before" is the FRESH in-transaction snapshot
          // read at the top of this attempt (`existing`), never a stale
          // pre-transaction read.
          if (onUpdated) {
            await onUpdated(
              tx,
              {
                ownerId: existing.ownerId,
                ownerLoginName: existing.owner.loginName,
                before: {
                  tripDate: existing.travel?.tripDate ?? null,
                  purpose: existing.travel?.purpose ?? null,
                  segmentsCount: existing.travel?.segments.length ?? 0,
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

      // Business errors (404/403/409/etc.) propagate immediately — never retried.
      if (err instanceof AppError) {
        throw err;
      }

      // Transient Postgres transaction conflicts (serialization failure
      // 40001, or a genuine deadlock 40P01 — see `isRetryableTransactionConflict`'s
      // doc comment for the three shapes this can arrive in and why 40P01 was
      // added in PHASE-004-R4) are retried; everything else propagates.
      if (!isRetryableTransactionConflict(err)) {
        throw err;
      }

      if (attempt >= UPDATE_DRAFT_MAX_RETRIES) {
        // Retries exhausted. A real D19 "last writer wins" race resolves
        // within a handful of retries: the loser's write conflicts with the
        // winner's already-committed write (Step 5's `tx.tripSegment.update`,
        // or Step 7's `tx.application.update`), gets a fresh transaction on
        // retry, and correctly recomputes its attachment delta against the
        // winner's now-visible state (this function's doc comment). Reaching
        // actual exhaustion here means repeated conflicts kept occurring for
        // some OTHER reason (e.g. broader contention on this Application row
        // from unrelated concurrent activity, or a genuine deadlock) —
        // surface the existing, honest `SERVICE_UNAVAILABLE` code instead —
        // no new ErrorCode introduced (Packet: 不得新增 ErrorCode).
        throw new AppError(
          "SERVICE_UNAVAILABLE",
          503,
          "系統忙碌，請稍後再試（儲存時發生資料庫並發衝突，已重試多次仍未成功）"
        );
      }
      // else: back off (see retryBackoffMs doc comment) then retry with a
      // fresh transaction.
      await sleep(retryBackoffMs(attempt));
    }
  }

  // Unreachable (loop always returns or throws) — satisfies TypeScript control-flow analysis.
  throw lastError;
}

// ---------------------------------------------------------------------------
// deleteApplication (AC-05)
// ---------------------------------------------------------------------------

/**
 * Deletes an Application row. DB-level Cascade removes TravelApplication and
 * TripSegment rows (schema §7.1) — but Cascade does NOT clear
 * `Attachment.refId` (it is a weak reference, no FK, by design — D1/D11-b),
 * so any `LINKED` attachment belonging to one of this application's
 * segments would otherwise become an orphan pointing at a row that no
 * longer exists. PHASE-004-T4 (AC-05 補完): detach those attachments FIRST,
 * in the SAME transaction that deletes the Application row, so a detach
 * failure rolls back the deletion too (and vice versa).
 *
 * `TripSegment.travelApplicationId` IS `Application.id` (schema §7.1:
 * `TravelApplication.applicationId` is both its own `@id` and the FK target
 * for `TripSegment.travelApplicationId`), so segments can be looked up
 * directly by `id` without an extra join through `TravelApplication`.
 * Non-TRAVEL applications (no `TripSegment` rows can reference their id)
 * simply yield an empty `segments` array here — safe no-op.
 *
 * PHASE-004-R4 (M-2, High): mutability is re-validated INSIDE this
 * transaction (fresh `status` read via `SELECT ... FOR UPDATE` +
 * `assertApplicationMutable`), not trusted from routes.ts's outer,
 * pre-transaction `assertApplicationMutable` call alone — mirrors
 * `updateTravelDraft`'s identical fix and the same rationale: the outer
 * check reads `status` before this transaction opens, and a concurrent
 * `completeTravelApplication` can commit in the window between that read
 * and this transaction's delete. Isolation raised from the previous
 * (unspecified/default) level to SERIALIZABLE + retry-on-conflict, the same
 * pattern used by `updateTravelDraft`/`completeTravelApplication` — this is
 * a RAISE, not a lowering (the Packet forbids lowering isolation, not
 * raising it): the previous default level could not otherwise guarantee
 * that a `DELETE` blocked behind a concurrent `complete`'s row lock
 * re-observes the post-commit `status` before proceeding (plain
 * `SELECT`/`DELETE` under READ COMMITTED does not re-check a value read
 * earlier in the same transaction). The `FOR UPDATE` lock on the
 * `Application` row is the SAME row `completeTravelApplication`'s final
 * write (`tx.application.update`, Step ⑤c) touches, so the two are
 * guaranteed to conflict under concurrent execution — whichever commits
 * second gets a serialization failure and retries against the other's
 * now-committed state.
 */
const DELETE_APPLICATION_MAX_RETRIES = 6;

export async function deleteApplication(prisma: PrismaClient, id: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= DELETE_APPLICATION_MAX_RETRIES; attempt++) {
    try {
      await prisma.$transaction(
        async (tx) => {
          // Table name quoted for Postgres case-sensitivity (unquoted-default,
          // no @@map in schema.prisma) — same pattern as updateTravelDraft's
          // own FOR UPDATE lock, above.
          await tx.$queryRaw`SELECT "id" FROM "Application" WHERE "id" = ${id} FOR UPDATE`;

          const existing = await tx.application.findUniqueOrThrow({
            where: { id },
            select: { status: true },
          });
          assertApplicationMutable(existing.status); // AC-06/56/59: 已完成 → 403 FORBIDDEN

          const segments = await tx.tripSegment.findMany({
            where: { travelApplicationId: id },
            select: { id: true },
          });
          if (segments.length > 0) {
            await detachAttachmentsByRefTx(
              tx,
              "TRIP_SEGMENT",
              segments.map((s) => s.id)
            );
          }
          await tx.application.delete({ where: { id } });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
      return;
    } catch (err) {
      lastError = err;

      // Business errors (404/403/etc.) propagate immediately — never retried
      // (mirrors updateTravelDraft/completeTravelApplication).
      if (err instanceof AppError) {
        throw err;
      }

      if (!isRetryableTransactionConflict(err)) {
        throw err;
      }

      if (attempt >= DELETE_APPLICATION_MAX_RETRIES) {
        throw new AppError(
          "SERVICE_UNAVAILABLE",
          503,
          "系統忙碌，請稍後再試（刪除申請時發生資料庫並發衝突，已重試多次仍未成功）"
        );
      }
      await sleep(retryBackoffMs(attempt));
    }
  }

  // Unreachable (loop always returns or throws) — satisfies TypeScript control-flow analysis.
  throw lastError;
}

// ---------------------------------------------------------------------------
// completeTravelApplication (PHASE-004-T8) — AC-49~54/43/48/59, §9「完成申請」
// ---------------------------------------------------------------------------

/**
 * Count currently-`LINKED` attachments per segment, WITHIN the caller's
 * transaction (`tx`) — the completion-flow equivalent of `getSegmentAttachments`
 * (which reads outside any transaction for DTO building). Only counts are
 * needed here (feeding `computeCompletionBlockers`'s `attachmentCount`), not
 * full `AttachmentDto[]`.
 */
async function getSegmentAttachmentCountsTx(
  tx: Prisma.TransactionClient,
  segmentIds: string[]
): Promise<Map<string, number>> {
  if (segmentIds.length === 0) return new Map();
  const rows = await tx.attachment.findMany({
    where: { refType: "TRIP_SEGMENT", refId: { in: segmentIds }, status: "LINKED" },
    select: { refId: true },
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.refId) continue;
    counts.set(row.refId, (counts.get(row.refId) ?? 0) + 1);
  }
  return counts;
}

export interface CompleteTravelApplicationOptions {
  /**
   * TEST-ONLY injection point (AC-53 原子性鑑別力測試需要一個可控的失敗切點）：
   * invoked inside the completion transaction AFTER every snapshot write
   * (segment `snapshotFuel/Etc/Raw/Amount` + `TravelApplication` 單價/版本 id/
   * `snapshotTotalKm`/`snapshotRawAmount`/`calculatedAt`) but BEFORE the
   * `Application` status flip (`status=COMPLETED`/`totalAmount`/`completedAt`)
   * — i.e. exactly the cut point the Packet's Required Test #1 names ("快照
   * 寫入後、狀態轉換前"). Throwing here lets a test prove the whole sequence
   * is one atomic transaction: everything written before the throw must roll
   * back together with the (never-reached) status flip.
   *
   * Default is a no-op. `routes.ts` (the only production caller) NEVER passes
   * this option — production behavior is 100% unaffected by this seam's
   * existence. Named with a `__testOnly` prefix so its purpose and blast
   * radius are unmistakable at every call site.
   */
  __testOnlyFailAfterSnapshotWrite?: () => void;
}

/** Retry budget for SERIALIZABLE conflicts, mirroring `updateTravelDraft`'s pattern (B-29). */
const COMPLETE_MAX_RETRIES = 6;

// ---------------------------------------------------------------------------
// PHASE-005a-T8 — storage-capacity guard (T2 複審 AR-2 邊界表義務)
//
// `deriveFuelUnitPrice`'s AC-20 guard (§16 D4(a)) only bounds `fuelUnitPrice`
// itself (`|U| < 1e6`, the `TravelApplication.fuelUnitPrice Decimal(10,4)`
// column). It says nothing about the DERIVED amounts `calculateTravel`
// produces from `U` and a segment's `totalKm`: `totalKm` is only bounded by
// its OWN column (`TripSegment.totalKm Decimal(10,2)`, |v| < 1e8) and has NO
// upper business-rule bound (`trip-validation.ts` only rejects `<= 0`). A
// segment with `totalKm` near 1e8 and a `fuelUnitPrice` near the (valid,
// AC-20-passing) ceiling of ~1e6 yields `segFuel = totalKm * fuelUnitPrice`
// near 1e14 — far beyond `TripSegment.snapshotFuelAmount`/`snapshotRawAmount`
// and `TravelApplication.snapshotRawAmount`'s `Decimal(14,4)` capacity
// (|v| < 1e10), and `Application.totalAmount`/`TripSegment.snapshotAmount`
// (both Postgres `int4`, i.e. `Int`) have an even smaller ceiling
// (2,147,483,647). Without this guard, such a combination would pass AC-20's
// check, pass `calculateTravel` (a pure function with no capacity notion of
// its own — Spec AC-19 explicitly forbids touching it), and then fail at the
// `tx.tripSegment.update`/`tx.travelApplication.update`/`tx.application.update`
// write with a raw Postgres "numeric field overflow" (Decimal columns) or a
// silently-wrapping/truncating integer write (the `Int` columns) — i.e.
// exactly the "500 or silent truncation" class of failure AC-20/D4(a) already
// ruled unacceptable for the narrower `fuelUnitPrice` case.
//
// Treatment (implementer decision, no new product/Spec decision — same class
// of risk already adjudicated by the human Spec Gate for AC-20/D4(a), applied
// here to the DERIVED amounts one arithmetic step downstream): reject BEFORE
// any write, same error code (`PARAMETER_NOT_AVAILABLE`, 409 — AC-35: no new
// `ErrorCode`), with a `details.missing` code (`AMOUNT_OUT_OF_RANGE`)
// distinguishable from `FUEL_UNIT_PRICE_OUT_OF_RANGE`/`FUEL_DATA_CORRUPTED`.
// Called immediately after `calculateTravel` returns (pure, no IO) and BEFORE
// Step ⑤a's first `tx.tripSegment.update` — so on rejection, the transaction
// has not written anything yet (no partial snapshot, matching AC-53's
// atomicity discipline by construction, not by rollback).
// ---------------------------------------------------------------------------

/** Exclusive upper bound (as `Prisma.Decimal`) for `Decimal(P,4)`/`Decimal(P,2)` columns with 10 integer digits (`snapshotFuelAmount`/`snapshotEtcAmount`/`snapshotRawAmount` @ `Decimal(14,4)`, `snapshotTotalKm` @ `Decimal(12,2)`, `TravelApplication.snapshotRawAmount` @ `Decimal(14,4)`) — all share the same 10-digit integer part, hence the same bound. */
const DECIMAL_CAPACITY_BOUND = new Prisma.Decimal("10000000000"); // 1e10

/** Postgres `int4` bounds — `Application.totalAmount` / `TripSegment.snapshotAmount`. */
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

function exceedsDecimalCapacity(value: Prisma.Decimal): boolean {
  return value.abs().greaterThanOrEqualTo(DECIMAL_CAPACITY_BOUND);
}

function exceedsInt4Capacity(value: number): boolean {
  return value < INT4_MIN || value > INT4_MAX || !Number.isFinite(value);
}

/**
 * AR-2 邊界守門：在任何快照寫入之前，確認 `calculateTravel` 之輸出（段金額、
 * 整筆金額、總里程）皆落在對應資料庫欄位容量內。任一項超出容量 → 409
 * `PARAMETER_NOT_AVAILABLE`（複用既有 ErrorCode，AC-35 仍成立），
 * `details.missing` 追加 `AMOUNT_OUT_OF_RANGE`；**絕不** 500、**絕不**靜默
 * 截斷寫入。
 */
function assertCalculationWithinStorageCapacity(result: CalcResult): void {
  const overflow =
    exceedsDecimalCapacity(result.totalRawAmount) ||
    exceedsDecimalCapacity(result.totalKm) ||
    exceedsInt4Capacity(result.totalAmount) ||
    result.segments.some(
      (s) =>
        exceedsDecimalCapacity(s.fuelAmount) ||
        exceedsDecimalCapacity(s.etcAmount) ||
        exceedsDecimalCapacity(s.rawAmount) ||
        exceedsInt4Capacity(s.amount)
    );

  if (overflow) {
    throw new AppError(
      "PARAMETER_NOT_AVAILABLE",
      409,
      "計算結果超出可儲存之金額範圍，請聯絡管理員檢查里程與參數設定",
      undefined,
      { missing: ["AMOUNT_OUT_OF_RANGE"] }
    );
  }
}

/**
 * Completes a TRAVEL draft: state-machine gate → completeness validation
 * (§9 step②, shares `computeCompletionBlockers` with the draft-view
 * `completionBlockers` field per D7/C4 — NOT a second validation
 * implementation) → parameter availability (§9 step③, independent 409 check,
 * NOT folded into step②'s blockers — see inline comment) → calculation
 * (reuses `calculateTravel`, T6, verbatim — C1) → snapshot writes → status
 * transition, all inside ONE SERIALIZABLE transaction (AC-53: any failure at
 * any step rolls back everything, including earlier snapshot writes in the
 * SAME transaction attempt).
 *
 * D17 / Packet Out of Scope: this function has NO owner/admin distinction —
 * authorization (owner-only, no admin-on-behalf) is `routes.ts`'s
 * responsibility, resolved BEFORE this function is ever called.
 *
 * Concurrency (B-29): SERIALIZABLE + retry-on-conflict, identical pattern to
 * `updateTravelDraft`. Two concurrent completions of the same draft: both
 * read `status=DRAFT` in their own snapshot, both attempt to write the same
 * `Application`/`TripSegment` rows — Postgres aborts the loser with a
 * serialization failure at commit; the loser retries with a FRESH
 * transaction, re-reads (now `status=COMPLETED`, written by the winner), and
 * `assertTransition` throws 403 FORBIDDEN (D13 message) — satisfying "落敗方
 * 得 403/409，不得雙重完成或雙重快照" without any bespoke conditional-update
 * mechanism.
 */
export async function completeTravelApplication(
  prisma: PrismaClient,
  id: string,
  options: CompleteTravelApplicationOptions = {}
): Promise<TravelApplicationRecord> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= COMPLETE_MAX_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const existing = await tx.application.findUniqueOrThrow({
            where: { id },
            include: travelApplicationInclude,
          });

          // Step ①: state-machine gate (AC-55~59, T2 single source of truth).
          // Non-DRAFT (already COMPLETED, or the theoretically-unreachable
          // VOIDED) → 403 FORBIDDEN, D13 message.
          assertTransition(existing.status, "COMPLETED");

          const segments = existing.travel?.segments ?? [];
          const tripDate = existing.travel?.tripDate ?? null;
          const purpose = existing.travel?.purpose ?? null;

          const attachmentCounts = await getSegmentAttachmentCountsTx(
            tx,
            segments.map((s) => s.id)
          );

          // Step ②: completeness validation — SAME pure function as the
          // draft-view `completionBlockers` field (D7/C4: single authority,
          // never a second implementation). `missingParameters` is
          // DELIBERATELY `[]` here: Spec §9's completion flow lists step②
          // (400 VALIDATION_ERROR + `details.blockers[]`, AC-52) and step③
          // (409 PARAMETER_NOT_AVAILABLE, AC-47) as two INDEPENDENT checks
          // with two DIFFERENT error codes — folding missing-parameter
          // blockers into this 400 response would make AC-47's 409 case
          // unreachable whenever parameters are ALSO missing (structural
          // completeness is checked first; parameter availability is step③,
          // below, entirely on its own).
          const blockers = computeCompletionBlockers({
            tripDate,
            purpose,
            segments: segments.map((s) => ({
              id: s.id,
              sortOrder: s.sortOrder,
              origin: s.origin,
              destination: s.destination,
              totalKm: s.totalKm,
              highwayKm: s.highwayKm,
              attachmentCount: attachmentCounts.get(s.id) ?? 0,
            })),
            missingParameters: [],
          });

          if (blockers.length > 0) {
            // D14(i): 400 VALIDATION_ERROR + fields[] (only entries that
            // carry a field path — SEGMENT_REQUIRED/SEGMENT_ATTACHMENT_REQUIRED
            // have none) + details.blockers[] (ALWAYS the full list, AC-52 —
            // "回應列出全部未通過項，非只回第一項", every item incl. those
            // without a `field`, each still carrying `segmentId` when
            // applicable for precise UI positioning).
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

          // Step ③: parameter availability — independent 409 check (AC-47),
          // see step② comment above for why this is NOT folded into the 400
          // response. `tx` passed through (resolveTravelParameters accepts
          // PrismaClientOrTx) so this reads inside the SAME transaction.
          // PHASE-005a-T7: 油耗一律以擁有人（`existing.ownerId`）解析——AC-23
          // 代操作以擁有人資料為準，絕不可傳操作者本人 id。
          const resolved = await resolveTravelParameters(tx, tripDate, existing.ownerId);
          assertParametersAvailable(resolved, tripDate);

          // assertParametersAvailable already guarantees fuelUnitPrice/
          // etcUnitPrice/fuelPriceVersionId/fuelConsumptionVersionId/
          // etcVersionId are non-null and fuelUnitPriceOutOfRange is false
          // (its checks are exhaustive over exactly this state) — narrow
          // here instead of a bare `!` assertion.
          if (
            resolved.fuelUnitPrice === null ||
            resolved.etcUnitPrice === null ||
            resolved.fuelPriceVersionId === null ||
            resolved.fuelConsumptionVersionId === null ||
            resolved.etcVersionId === null
          ) {
            // Unreachable — defensive only.
            throw new AppError(
              "PARAMETER_NOT_AVAILABLE",
              409,
              "該出差日期尚無有效補助參數，請聯絡管理員設定。"
            );
          }
          const fuelUnitPrice = resolved.fuelUnitPrice;
          const etcUnitPrice = resolved.etcUnitPrice;

          // Step ④: calculation engine — T6's `calculateTravel` verbatim
          // (C1: 不得另寫一套). `totalKm`/`highwayKm` are non-null and
          // business-valid here because blockers.length===0 above already
          // proved it (SEGMENT_TOTAL_KM_REQUIRED/INVALID and
          // SEGMENT_HIGHWAY_KM_REQUIRED/INVALID/GT_TOTAL would otherwise be
          // present).
          const calcSegments: CalcSegmentInput[] = segments.map((s) => ({
            segmentId: s.id,
            segmentIndex: s.sortOrder,
            totalKm: s.totalKm as Prisma.Decimal,
            highwayKm: s.highwayKm as Prisma.Decimal,
          }));
          const result = calculateTravel({ segments: calcSegments, fuelUnitPrice, etcUnitPrice });

          // T2 複審 AR-2 邊界守門：在任何快照寫入前確認結果落在欄位容量內
          // （見上方 `assertCalculationWithinStorageCapacity` doc comment）。
          assertCalculationWithinStorageCapacity(result);

          // Step ⑤a: per-segment snapshot (取整前 fuel/etc/raw + 取整後 amount).
          const resultBySegmentId = new Map(result.segments.map((s) => [s.segmentId, s]));
          for (const segment of segments) {
            const segResult = resultBySegmentId.get(segment.id);
            if (!segResult) {
              // Unreachable: calcSegments was built 1:1 from `segments` above.
              throw new AppError("INTERNAL_ERROR", 500, "計算結果與行程段不一致");
            }
            await tx.tripSegment.update({
              where: { id: segment.id },
              data: {
                snapshotFuelAmount: segResult.fuelAmount,
                snapshotEtcAmount: segResult.etcAmount,
                snapshotRawAmount: segResult.rawAmount,
                snapshotAmount: segResult.amount,
              },
            });
          }

          const calculatedAt = new Date();

          // Step ⑤b: TravelApplication snapshot (單價/版本 id/總里程/整筆取整前金額/計算時間).
          // PHASE-005a-T7: 單價來源改為 resolveTravelParameters 之推導取整值；
          // `fuelParameterVersionId`（舊模型，`FuelParameterVersion` 表）刻意
          // 保持不寫（維持 null，§8.4 判別欄位）——新模型只寫
          // `fuelPriceVersionId`/`fuelConsumptionVersionId`。
          // 三項來源快照值（snapshotFuelType/PricePerLiter/Consumption，AC-25）
          // 由本 Task（T8）接線寫入——`resolved` 已由 `resolveTravelParameters`
          // 附帶解出（T7），此處只是首次落地寫入快照欄位。
          await tx.travelApplication.update({
            where: { applicationId: id },
            data: {
              fuelUnitPrice,
              etcUnitPrice,
              fuelPriceVersionId: resolved.fuelPriceVersionId,
              fuelConsumptionVersionId: resolved.fuelConsumptionVersionId,
              etcParameterVersionId: resolved.etcVersionId,
              snapshotTotalKm: result.totalKm,
              snapshotRawAmount: result.totalRawAmount,
              snapshotFuelType: resolved.snapshotFuelType,
              snapshotFuelPricePerLiter: resolved.snapshotFuelPricePerLiter,
              snapshotFuelConsumption: resolved.snapshotFuelConsumption,
              calculatedAt,
            },
          });

          // TEST-ONLY injection point — see `CompleteTravelApplicationOptions`
          // doc comment. Everything written above (segment snapshots +
          // TravelApplication snapshot) must roll back together with the
          // status flip below if this throws.
          options.__testOnlyFailAfterSnapshotWrite?.();

          // Step ⑤c: Application status transition — LAST write (AC-49/50/54).
          // Body-supplied amounts are never read anywhere in this function —
          // AC-54's "忽略任何金額 body" holds because there is no code path
          // that ever touches request.body at all.
          await tx.application.update({
            where: { id },
            data: {
              totalAmount: result.totalAmount,
              completedAt: calculatedAt,
              status: "COMPLETED",
            },
          });

          // Step ⑥: attachment lock — no Attachment row is touched here.
          // `deriveContainerState` (attachment/lifecycle-service.ts, T11)
          // reads `Application.status` fresh on every request; once this
          // transaction commits, it resolves 'completed' automatically
          // (AC-59). Not this Task's file to modify (Packet Files Forbidden).

          return tx.application.findUniqueOrThrow({
            where: { id },
            include: travelApplicationInclude,
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (err) {
      lastError = err;

      // Business errors (403/400/409/etc.) and the test-only injected error
      // propagate immediately — never retried (a test-injected failure is a
      // plain Error, not a Prisma serialization error, so it also falls
      // through to the `throw err` below on its first and only attempt).
      if (err instanceof AppError) {
        throw err;
      }

      if (!isRetryableTransactionConflict(err)) {
        throw err;
      }

      if (attempt >= COMPLETE_MAX_RETRIES) {
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

// ---------------------------------------------------------------------------
// Per-segment LINKED attachments (PHASE-004-T11) — replaces the T3-era
// count-only `getLinkedAttachmentCounts`: now returns the full `AttachmentDto[]`
// per segment (Spec §8.1 `TripSegmentDto.attachments`), and the count used by
// `completionBlockers` (`SEGMENT_ATTACHMENT_REQUIRED`) is simply each list's
// length — one query serves both purposes, no more separate count-only path.
// ---------------------------------------------------------------------------

async function getSegmentAttachments(
  prisma: PrismaClient,
  segmentIds: string[]
): Promise<Map<string, AttachmentDto[]>> {
  if (segmentIds.length === 0) return new Map();
  const rows = await prisma.attachment.findMany({
    where: { refType: "TRIP_SEGMENT", refId: { in: segmentIds }, status: "LINKED" },
    select: {
      id: true,
      status: true,
      mimeType: true,
      byteSize: true,
      originalFilename: true,
      refType: true,
      refId: true,
    },
    orderBy: { linkedAt: "asc" },
  });
  const bySegment = new Map<string, AttachmentDto[]>();
  for (const row of rows) {
    if (!row.refId) continue;
    const list = bySegment.get(row.refId) ?? [];
    list.push(toAttachmentDto(row));
    bySegment.set(row.refId, list);
  }
  return bySegment;
}

// ---------------------------------------------------------------------------
// DTO shapes (§8.1)
// ---------------------------------------------------------------------------

export interface TripSegmentDto {
  id: string;
  sortOrder: number;
  origin: string | null;
  destination: string | null;
  totalKm: string | null;
  highwayKm: string | null;
  attachments: AttachmentDto[];
  snapshot: {
    fuelAmount: string;
    etcAmount: string;
    rawAmount: string;
    amount: number;
  } | null; // 僅 COMPLETED（PHASE-004-T8，讀 TripSegment 的 snapshot* 欄位，非重算）
}

/**
 * PHASE-004-T8: 僅 COMPLETED 申請回傳（讀 `TravelApplication` 的快照欄位 +
 * `Application.totalAmount`，非重算——AC-48 快照不變性的 DTO 層對應）。
 * D6(c)：草稿/預覽從不回傳單價（見 `TravelComputedDto` 上方註解）；本介面
 * 唯一存在的理由就是「已完成申請可回傳自己的計算依據」，故單價欄位在此
 * 刻意存在，與 `TravelComputedDto` 刻意不存在互為對照。
 */
export interface TravelSnapshotDto {
  fuelUnitPrice: string;
  etcUnitPrice: string;
  /**
   * PHASE-005a-T8（AC-25 逐欄可讀）：完成當下之油種／每公升油價／車輛油耗
   * 快照——新模型申請恆非 `null`；AC-27 既有舊模型已完成申請恆為 `null`
   * （這三欄位由本 Phase 新增，migration 對舊列一律留 `NULL`，零回填）。
   */
  snapshotFuelType: string | null;
  snapshotFuelPricePerLiter: string | null;
  snapshotFuelConsumption: string | null;
  /**
   * PHASE-005a-T7: 舊模型（`FuelParameterVersion`）引用；新模型完成之申請
   * 恆為 `null`（§8.4 判別欄位——完成流程只寫新模型欄位）。既有舊模型已完成
   * 申請仍回傳原值（AC-27 快照零影響）。
   */
  fuelParameterVersionId: string | null;
  etcParameterVersionId: string;
  /** PHASE-005a-T7 新增：新模型（`FuelPriceVersion`）引用；舊模型申請為 `null`。 */
  fuelPriceVersionId: string | null;
  /** PHASE-005a-T7 新增：新模型（`UserFuelConsumptionVersion`）引用；舊模型申請為 `null`。 */
  fuelConsumptionVersionId: string | null;
  totalKm: string;
  totalRawAmount: string;
  totalAmount: number;
  calculatedAt: string; // ISO
}

export interface TravelApplicationDto {
  id: string;
  type: "TRAVEL";
  status: ApplicationStatus;
  ownerId: string;
  ownerDisplayName: string;
  createdById: string;
  createdByDisplayName: string;
  onBehalf: boolean;
  tripDate: string | null;
  purpose: string | null;
  segments: TripSegmentDto[];
  completionBlockers: Blocker[];
  computed: TravelComputedDto | null; // DRAFT：即算預覽；COMPLETED：null（D8）
  snapshot: TravelSnapshotDto | null; // COMPLETED：快照；DRAFT：null（PHASE-004-T8）
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// TravelComputedDto (§8.1) — PHASE-004-T7
//
// D6(c)：草稿/預覽 computed 不含單價 —— 型別上刻意不宣告 fuelUnitPrice /
// etcUnitPrice / fuelParameterVersionId / etcParameterVersionId（見上方檔頭
// 註解）。同一份計算函式（D8）供 toTravelApplicationDto（草稿讀取/儲存）與
// POST /applications/travel/preview（routes.ts）共用。
// ---------------------------------------------------------------------------

export interface TravelComputedSegmentDto {
  segmentId: string | null;
  segmentIndex: number;
  fuelAmount: string; // 取整前
  etcAmount: string; // 取整前
  rawAmount: string; // 取整前（油資+ETC）
  amount: number; // 取整後（整數）
}

/**
 * PHASE-005a-T8（T7 複審 SF-2 必辦）：`missingParameters` 除既有
 * `MissingParameter`（查無版本）外，追加兩個「版本齊備但無法計算」代碼——
 * `FUEL_UNIT_PRICE_OUT_OF_RANGE`（AC-20/D4(a)）與 `FUEL_DATA_CORRUPTED`
 * （T7R SF-1）。修法前 out-of-range/data-corrupted 兩情境下
 * `parameterAvailable` 恆為 `true`、`missingParameters=[]`，以單價 0 算出
 * 看似合理的金額——形成「預覽說可以、完成 409」的不一致，違反 §16 D4(a)
 * 「草稿仍可存，預覽顯示不可計算」與 FE-US-10 第四條。
 */
export type PreviewMissingCode =
  | MissingParameter
  | "FUEL_UNIT_PRICE_OUT_OF_RANGE"
  | "FUEL_DATA_CORRUPTED";

export interface TravelComputedDto {
  parameterAvailable: boolean;
  missingParameters: PreviewMissingCode[];
  totalKm: string;
  segments: TravelComputedSegmentDto[];
  totalRawAmount: string;
  totalAmount: number;
}

/** One normalized segment input for the shared computed-formatting step below. */
export interface ComputedSegmentInput {
  segmentId: string | null;
  segmentIndex: number;
  totalKm: Prisma.Decimal | null;
  highwayKm: Prisma.Decimal | null;
}

/**
 * Pure formatting/calculation step, given an ALREADY-resolved
 * `ResolvedParameters` (caller does the one DB round-trip via
 * `resolveTravelParameters`, see §10.2 perf note — do not re-resolve per
 * caller). Reused by both `toTravelApplicationDto` (draft) and the
 * `/applications/travel/preview` route (routes.ts) — this is the "同一組
 * 計算函式" D8 requires.
 *
 * 缺參數時的呈現選擇（Packet §Done When 3 要求說明；本函式即為該實作點）：
 * 缺少的那一類單價視為 0（`Prisma.Decimal(0)`），**不是**把整筆金額全部歸
 * 零。理由：若出差日期只缺 ETC 版本（油資版本齊備），使用者填的總里程仍能
 * 即時看到油資部分的正確試算金額，只有 ETC 部分顯示 0——這比「整筆一律顯示
 * 0」更能準確反映「哪一部分尚未有計算依據」，且與 `missingParameters` 一起
 * 呈現時語意一致（AC-46/47 只擋「完成」，不擋「預覽/草稿仍要盡量準確呈現」）。
 * `parameterAvailable=false` 仍會回傳，前端可依此顯示提示文案而非直接採信
 * 金額為最終值。里程為 null 的段落一律視為 0 計算（AC-31/32 精神：欄位有值
 * 才有對應金額；草稿/預覽本就允許不完整資料）。
 */
export function formatTravelComputed(
  resolved: ResolvedParameters,
  segments: ReadonlyArray<ComputedSegmentInput>
): TravelComputedDto {
  const fuelUnitPrice = resolved.fuelUnitPrice ?? new Prisma.Decimal("0");
  const etcUnitPrice = resolved.etcUnitPrice ?? new Prisma.Decimal("0");

  const calcSegments: CalcSegmentInput[] = segments.map((s) => ({
    segmentId: s.segmentId,
    segmentIndex: s.segmentIndex,
    totalKm: s.totalKm ?? new Prisma.Decimal("0"),
    highwayKm: s.highwayKm ?? new Prisma.Decimal("0"),
  }));

  const result = calculateTravel({ segments: calcSegments, fuelUnitPrice, etcUnitPrice });

  // PHASE-005a-T8（SF-2）：out-of-range／data-corrupted 兩情境下單價實為 0
  // 佔位（見上方 `fuelUnitPrice`/`etcUnitPrice ?? 0`），此時算出的金額**不得**
  // 被當作最終值呈現——`parameterAvailable=false` 且 `missingParameters`
  // 追加對應代碼，前端（T11，Out of Scope）據此顯示「油資無法計算」而非
  // 金額 0。
  const missingParameters: PreviewMissingCode[] = [...resolved.missing];
  if (resolved.fuelDataCorrupted) {
    missingParameters.push("FUEL_DATA_CORRUPTED");
  } else if (resolved.fuelUnitPriceOutOfRange) {
    missingParameters.push("FUEL_UNIT_PRICE_OUT_OF_RANGE");
  }

  return {
    parameterAvailable:
      resolved.missing.length === 0 &&
      !resolved.fuelUnitPriceOutOfRange &&
      !resolved.fuelDataCorrupted,
    missingParameters,
    totalKm: result.totalKm.toFixed(2),
    segments: result.segments.map((s) => ({
      segmentId: s.segmentId,
      segmentIndex: s.segmentIndex,
      fuelAmount: s.fuelAmount.toFixed(4),
      etcAmount: s.etcAmount.toFixed(4),
      rawAmount: s.rawAmount.toFixed(4),
      amount: s.amount,
    })),
    totalRawAmount: result.totalRawAmount.toFixed(4),
    totalAmount: result.totalAmount,
  };
}

// ---------------------------------------------------------------------------
// toTravelApplicationDto (§8.1)
// ---------------------------------------------------------------------------

export async function toTravelApplicationDto(
  prisma: PrismaClient,
  application: TravelApplicationRecord
): Promise<TravelApplicationDto> {
  const segments = application.travel?.segments ?? [];
  const attachmentsBySegment = await getSegmentAttachments(
    prisma,
    segments.map((s) => s.id)
  );

  const segmentDtos: TripSegmentDto[] = segments.map((s) => ({
    id: s.id,
    sortOrder: s.sortOrder,
    origin: s.origin,
    destination: s.destination,
    totalKm: s.totalKm !== null ? s.totalKm.toFixed(2) : null,
    highwayKm: s.highwayKm !== null ? s.highwayKm.toFixed(2) : null,
    attachments: attachmentsBySegment.get(s.id) ?? [],
    // PHASE-004-T8: 僅 COMPLETED 段落非 null（四個 snapshot* 欄位由完成流程
    // 同一交易寫入，草稿階段恆為 null——見 completeTravelApplication Step ⑤a）。
    snapshot:
      s.snapshotFuelAmount !== null &&
      s.snapshotEtcAmount !== null &&
      s.snapshotRawAmount !== null &&
      s.snapshotAmount !== null
        ? {
            fuelAmount: s.snapshotFuelAmount.toFixed(4),
            etcAmount: s.snapshotEtcAmount.toFixed(4),
            rawAmount: s.snapshotRawAmount.toFixed(4),
            amount: s.snapshotAmount,
          }
        : null,
  }));

  // PHASE-004-T7: resolve parameters ONCE for DRAFT (§10.2 perf note — avoid
  // a second findMany round-trip) and share the result between
  // completionBlockers' missingParameters and the computed preview below.
  // COMPLETED applications never resolve current parameters — computed=null
  // and completionBlockers=[] (they read the immutable snapshot instead, T8).
  const tripDate = application.travel?.tripDate ?? null;
  // PHASE-005a-T7: 油耗一律以「該申請之擁有人」解析（AC-23），非讀取者本人。
  const resolvedParameters =
    application.status === "DRAFT"
      ? await resolveTravelParameters(prisma, tripDate, application.ownerId)
      : null;

  const completionBlockers: Blocker[] =
    application.status === "DRAFT" && resolvedParameters
      ? computeCompletionBlockers({
          tripDate,
          purpose: application.travel?.purpose ?? null,
          segments: segments.map((s) => ({
            id: s.id,
            sortOrder: s.sortOrder,
            origin: s.origin,
            destination: s.destination,
            totalKm: s.totalKm,
            highwayKm: s.highwayKm,
            attachmentCount: attachmentsBySegment.get(s.id)?.length ?? 0,
          })),
          missingParameters: resolvedParameters.missing,
          // PHASE-005a-T8（SF-2）：草稿層級同樣暴露 out-of-range／data-corrupted，
          // 與 `computed.missingParameters`（formatTravelComputed）呈現一致。
          fuelUnitPriceOutOfRange: resolvedParameters.fuelUnitPriceOutOfRange,
          fuelDataCorrupted: resolvedParameters.fuelDataCorrupted,
        })
      : [];

  const computed: TravelComputedDto | null = resolvedParameters
    ? formatTravelComputed(
        resolvedParameters,
        segments.map((s) => ({
          segmentId: s.id,
          segmentIndex: s.sortOrder,
          totalKm: s.totalKm,
          highwayKm: s.highwayKm,
        }))
      )
    : null;

  // PHASE-004-T8: 僅 COMPLETED 且快照欄位齊備時非 null——讀 `TravelApplication`
  // 的快照欄位 + `Application.totalAmount`，絕不重新查詢參數表或重算
  // （AC-48 快照不變性：即使日後新增更早生效日的參數版本，這裡讀到的仍是
  // 完成當下寫入的值，因為完全不呼叫 resolveTravelParameters/calculateTravel）。
  //
  // PHASE-005a-T7（§8.4 判別欄位）: 「油資版本引用」二擇一齊備即視為已有快照——
  // 舊模型（`fuelParameterVersionId`，AC-27 既有已完成申請）或新模型
  // （`fuelPriceVersionId`，本 Phase 起新完成之申請）。兩者恆不同時非 null。
  const travel = application.travel;
  const hasLegacyFuelReference = travel?.fuelParameterVersionId != null;
  const hasNewFuelReference = travel?.fuelPriceVersionId != null;
  const snapshot: TravelSnapshotDto | null =
    application.status === "COMPLETED" &&
    travel?.fuelUnitPrice != null &&
    travel?.etcUnitPrice != null &&
    (hasLegacyFuelReference || hasNewFuelReference) &&
    travel?.etcParameterVersionId != null &&
    travel?.snapshotTotalKm != null &&
    travel?.snapshotRawAmount != null &&
    travel?.calculatedAt != null &&
    application.totalAmount != null
      ? {
          fuelUnitPrice: travel.fuelUnitPrice.toFixed(4),
          etcUnitPrice: travel.etcUnitPrice.toFixed(4),
          fuelParameterVersionId: travel.fuelParameterVersionId,
          etcParameterVersionId: travel.etcParameterVersionId,
          fuelPriceVersionId: travel.fuelPriceVersionId,
          fuelConsumptionVersionId: travel.fuelConsumptionVersionId,
          snapshotFuelType: travel.snapshotFuelType,
          snapshotFuelPricePerLiter: travel.snapshotFuelPricePerLiter
            ? travel.snapshotFuelPricePerLiter.toFixed(4)
            : null,
          snapshotFuelConsumption: travel.snapshotFuelConsumption
            ? travel.snapshotFuelConsumption.toFixed(4)
            : null,
          totalKm: travel.snapshotTotalKm.toFixed(2),
          totalRawAmount: travel.snapshotRawAmount.toFixed(4),
          totalAmount: application.totalAmount,
          calculatedAt: travel.calculatedAt.toISOString(),
        }
      : null;

  return {
    id: application.id,
    type: "TRAVEL",
    status: application.status,
    ownerId: application.ownerId,
    ownerDisplayName: application.owner.displayName,
    createdById: application.createdById,
    createdByDisplayName: application.createdBy.displayName,
    onBehalf: application.createdById !== application.ownerId,
    tripDate: tripDate ? formatUtcDate(tripDate) : null,
    purpose: application.travel?.purpose ?? null,
    segments: segmentDtos,
    completionBlockers,
    computed,
    snapshot,
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),
    completedAt: application.completedAt ? application.completedAt.toISOString() : null,
  };
}
