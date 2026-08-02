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
 * Extension points left for later Tasks (Packet 明文要求，勿移除標記)：
 *   - TODO(PHASE-004-T8): 完成快照（segment.snapshot / 頂層 snapshot）於
 *     toTravelApplicationDto 接入
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
import type { Blocker } from "./completion-blockers.js";
import { computeCompletionBlockers } from "./completion-blockers.js";
import { computeSegmentDiff } from "./segment-diff.js";
import { type CalcSegmentInput, calculateTravel } from "./travel-calculation.js";
import { type ResolvedParameters, resolveTravelParameters } from "./travel-parameters.js";

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
  owner: { select: { displayName: true } },
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
// createTravelDraft (AC-01)
// ---------------------------------------------------------------------------

export interface CreateTravelDraftInput {
  ownerId: string;
  createdById: string;
  tripDate?: Date | null;
  purpose?: string | null;
}

/**
 * Creates a new TRAVEL draft (Application + TravelApplication, 1:1) in a
 * single Prisma nested write (Prisma wraps nested create in one atomic
 * operation — see T1 model test for the same pattern).
 *
 * owner is ALWAYS supplied by the caller from `request.currentUser` /
 * `:userId` (admin on-behalf, T10) — never from request body (AC-79a,
 * §6.2 資料隔離不變式 1).
 */
export async function createTravelDraft(
  prisma: PrismaClient,
  input: CreateTravelDraftInput
): Promise<TravelApplicationRecord> {
  const tripDate = input.tripDate ?? null;
  const purpose = input.purpose ?? null;
  const primaryDate = derivePrimaryDate(tripDate, new Date());

  return prisma.application.create({
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
 * those checks belong to the caller. Reaching this function at all already
 * implies the application is DRAFT (routes.ts's `assertApplicationMutable`
 * ran before `updateTravelDraft` was ever called), so the injected
 * containerState would always be 'draft' — encoding that as "no check needed
 * here" rather than threading a constant through is deliberate (§9: "草稿階段
 * 必為 'draft'，因 assertApplicationMutable 已在前面擋掉非草稿").
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
  segments?: ReadonlyArray<SegmentPatch>
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
              ownerId: true,
              createdAt: true,
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

          return tx.application.findUniqueOrThrow({
            where: { id },
            include: travelApplicationInclude,
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (err) {
      lastError = err;

      // Business errors (404/403/409/etc.) propagate immediately — never retried.
      if (err instanceof AppError) {
        throw err;
      }

      // Serialization failures can surface two different ways here:
      //   - P2034: Prisma's own write-conflict/deadlock code for ordinary
      //     Prisma Client operations (same as `linkAttachment`'s retry check,
      //     lifecycle-service.ts).
      //   - P2010 wrapping Postgres SQLSTATE 40001 ("could not serialize
      //     access due to concurrent update"): surfaces THROUGH `$queryRaw`
      //     (the `SELECT ... FOR UPDATE` lock above) because raw queries
      //     report the underlying DB error via Prisma's generic "raw query
      //     failed" code rather than P2034.
      const isP2034 = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";
      const isP2010SerializationFailure =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2010" &&
        (err.meta as { code?: string } | undefined)?.code === "40001";
      const isPrismaSerializationError = isP2034 || isP2010SerializationFailure;
      if (!isPrismaSerializationError) {
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
 */
export async function deleteApplication(prisma: PrismaClient, id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
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
  });
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
  } | null; // TODO(PHASE-004-T8): 完成快照
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
  snapshot: unknown | null; // TODO(PHASE-004-T8): TravelSnapshotDto
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

export interface TravelComputedDto {
  parameterAvailable: boolean;
  missingParameters: ("FUEL" | "ETC")[];
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
  const fuelUnitPrice = resolved.fuelUnitPrice ?? new Prisma.Decimal(0);
  const etcUnitPrice = resolved.etcUnitPrice ?? new Prisma.Decimal(0);

  const calcSegments: CalcSegmentInput[] = segments.map((s) => ({
    segmentId: s.segmentId,
    segmentIndex: s.segmentIndex,
    totalKm: s.totalKm ?? new Prisma.Decimal(0),
    highwayKm: s.highwayKm ?? new Prisma.Decimal(0),
  }));

  const result = calculateTravel({ segments: calcSegments, fuelUnitPrice, etcUnitPrice });

  return {
    parameterAvailable: resolved.missing.length === 0,
    missingParameters: [...resolved.missing],
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
    snapshot: null, // TODO(PHASE-004-T8)
  }));

  // PHASE-004-T7: resolve parameters ONCE for DRAFT (§10.2 perf note — avoid
  // a second findMany round-trip) and share the result between
  // completionBlockers' missingParameters and the computed preview below.
  // COMPLETED applications never resolve current parameters — computed=null
  // and completionBlockers=[] (they read the immutable snapshot instead, T8).
  const tripDate = application.travel?.tripDate ?? null;
  const resolvedParameters =
    application.status === "DRAFT" ? await resolveTravelParameters(prisma, tripDate) : null;

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
    snapshot: null, // TODO(PHASE-004-T8)
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),
    completedAt: application.completedAt ? application.completedAt.toISOString() : null,
  };
}
