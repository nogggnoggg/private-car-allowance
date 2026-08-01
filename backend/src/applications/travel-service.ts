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
 *   - TODO(PHASE-004-T11): segment.attachments（AttachmentDto[]）於
 *     toTravelApplicationDto 接入；目前僅正確計算 attachmentCount 供
 *     completionBlockers 使用，不回傳完整附件物件；`attachmentIds` 於
 *     `SegmentInput` 中依然完全被忽略（T11 之範圍，見 PHASE-004-T4 Packet
 *     「明確不在本 Task 範圍」）
 *
 * PHASE-004-T4（本次擴充）：`updateTravelDraft` 的 `segments` 整份 PUT diff
 * 語意（D15）+ 刪段連帶 detach（D16）+ `deleteApplication` 的 AC-05 補完，
 * 皆已接入，見下方個別函式的文件註解。
 *
 * PHASE-004-T7（本次擴充）：`computed`（草稿即算預覽）與
 * `completionBlockers` 的 `missingParameters` 已接入 `toTravelApplicationDto`
 * （見 `formatTravelComputed` 與呼叫端）。`TODO(PHASE-004-T7)` 標記已移除。
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
import { detachAttachmentsByRefTx } from "../attachment/lifecycle-service.js";
import { formatUtcDate } from "../parameters/parameter-service.js";
import type { Blocker } from "./completion-blockers.js";
import { computeCompletionBlockers } from "./completion-blockers.js";
import { computeSegmentDiff } from "./segment-diff.js";
import { type CalcSegmentInput, calculateTravel } from "./travel-calculation.js";
import { type ResolvedParameters, resolveTravelParameters } from "./travel-parameters.js";

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
 * `attachmentIds` is intentionally NOT part of this type — T11's scope
 * (Packet §Done When 3 「明確不在本 Task 範圍」).
 */
export interface SegmentPatch {
  id?: string;
  origin?: string | null;
  destination?: string | null;
  totalKm?: Prisma.Decimal | null;
  highwayKm?: Prisma.Decimal | null;
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
 *   5. 更新 `toUpdate`（欄位三態合併 + `sortOrder`）
 *   6. 建立 `toCreate`（欄位 + `sortOrder`）
 *   7. 更新 `tripDate`/`purpose`/`primaryDate`
 * 任一步驟失敗 → Prisma 自動 rollback 整個交易，含步驟 3/4 的刪除與 detach
 * （交易原子性 — Packet Done When 3「交易任一步失敗 → 全部不落地（含
 * detach）」）。
 */
export async function updateTravelDraft(
  prisma: PrismaClient,
  id: string,
  patch: UpdateTravelDraftPatch,
  segments?: ReadonlyArray<SegmentPatch>
): Promise<TravelApplicationRecord> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.application.findUniqueOrThrow({
      where: { id },
      select: {
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

      // Step 5: 更新既有段（欄位三態合併 + sortOrder 重寫）。
      for (const u of diff.toUpdate) {
        const previous = existingById.get(u.id);
        await tx.tripSegment.update({
          where: { id: u.id },
          data: {
            sortOrder: u.sortOrder,
            origin: resolveSegmentField(u.data, "origin", previous?.origin ?? null),
            destination: resolveSegmentField(u.data, "destination", previous?.destination ?? null),
            totalKm: resolveSegmentField(u.data, "totalKm", previous?.totalKm ?? null),
            highwayKm: resolveSegmentField(u.data, "highwayKm", previous?.highwayKm ?? null),
          },
        });
      }

      // Step 6: 新增段（缺席欄位 = null，因新段無既有值可保留）。
      if (diff.toCreate.length > 0) {
        await tx.tripSegment.createMany({
          data: diff.toCreate.map((c) => ({
            travelApplicationId: id,
            sortOrder: c.sortOrder,
            origin: c.data.origin ?? null,
            destination: c.data.destination ?? null,
            totalKm: c.data.totalKm ?? null,
            highwayKm: c.data.highwayKm ?? null,
          })),
        });
      }
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
  });
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
// Linked attachment counts per segment (correctly queried per Packet — not 0)
// ---------------------------------------------------------------------------

async function getLinkedAttachmentCounts(
  prisma: PrismaClient,
  segmentIds: string[]
): Promise<Map<string, number>> {
  if (segmentIds.length === 0) return new Map();
  const rows = await prisma.attachment.findMany({
    where: { refType: "TRIP_SEGMENT", refId: { in: segmentIds }, status: "LINKED" },
    select: { refId: true },
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.refId) {
      counts.set(row.refId, (counts.get(row.refId) ?? 0) + 1);
    }
  }
  return counts;
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
  attachments: unknown[]; // TODO(PHASE-004-T11): AttachmentDto[]
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
  const counts = await getLinkedAttachmentCounts(
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
    attachments: [], // TODO(PHASE-004-T11)
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
            attachmentCount: counts.get(s.id) ?? 0,
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
