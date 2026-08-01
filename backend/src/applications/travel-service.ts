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
 *   - TODO(PHASE-004-T4): segments diff（新增/更新/刪除/排序）於 updateTravelDraft 接入
 *   - TODO(PHASE-004-T7): computed（草稿即算預覽）與 missingParameters 於
 *     toTravelApplicationDto 接入
 *   - TODO(PHASE-004-T8): 完成快照（segment.snapshot / 頂層 snapshot）於
 *     toTravelApplicationDto 接入
 *   - TODO(PHASE-004-T11): segment.attachments（AttachmentDto[]）於
 *     toTravelApplicationDto 接入；目前僅正確計算 attachmentCount 供
 *     completionBlockers 使用，不回傳完整附件物件
 */

import type { ApplicationStatus, Prisma, PrismaClient } from "@prisma/client";
import { formatUtcDate } from "../parameters/parameter-service.js";
import type { Blocker } from "./completion-blockers.js";
import { computeCompletionBlockers } from "./completion-blockers.js";

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

export async function updateTravelDraft(
  prisma: PrismaClient,
  id: string,
  patch: UpdateTravelDraftPatch
): Promise<TravelApplicationRecord> {
  const existing = await prisma.application.findUniqueOrThrow({
    where: { id },
    select: { createdAt: true, travel: { select: { tripDate: true, purpose: true } } },
  });

  const nextTripDate = Object.prototype.hasOwnProperty.call(patch, "tripDate")
    ? (patch.tripDate ?? null)
    : (existing.travel?.tripDate ?? null);
  const nextPurpose = Object.prototype.hasOwnProperty.call(patch, "purpose")
    ? (patch.purpose ?? null)
    : (existing.travel?.purpose ?? null);

  const primaryDate = derivePrimaryDate(nextTripDate, existing.createdAt);

  // TODO(PHASE-004-T4): segments diff（以 id 對齊：更新既有段／新增無 id 段／
  // 刪除未出現段並 detach 其 LINKED 附件）於此接入；本 Task 的 PUT 完全不處理
  // request body 的 `segments` 欄位（型別上容許存在，內容一律忽略）。

  return prisma.application.update({
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
    include: travelApplicationInclude,
  });
}

// ---------------------------------------------------------------------------
// deleteApplication (AC-05)
// ---------------------------------------------------------------------------

/**
 * Deletes an Application row. DB-level Cascade removes TravelApplication and
 * TripSegment rows (schema §7.1). Attachment detach-on-cascade-delete (AC-05:
 * LINKED→TEMP for segment attachments) is NOT handled here — this Task's
 * scope only covers 0-segment drafts in its own tests (T11 owns the
 * attachment detach-on-segment-delete wiring); deleting a draft with zero
 * segments has no attachments to detach.
 */
export async function deleteApplication(prisma: PrismaClient, id: string): Promise<void> {
  await prisma.application.delete({ where: { id } });
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
  computed: unknown | null; // TODO(PHASE-004-T7): TravelComputedDto
  snapshot: unknown | null; // TODO(PHASE-004-T8): TravelSnapshotDto
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
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

  const completionBlockers: Blocker[] =
    application.status === "DRAFT"
      ? computeCompletionBlockers({
          tripDate: application.travel?.tripDate ?? null,
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
          missingParameters: [], // TODO(PHASE-004-T7): 依 tripDate 查參數版本後填入
        })
      : [];

  return {
    id: application.id,
    type: "TRAVEL",
    status: application.status,
    ownerId: application.ownerId,
    ownerDisplayName: application.owner.displayName,
    createdById: application.createdById,
    createdByDisplayName: application.createdBy.displayName,
    onBehalf: application.createdById !== application.ownerId,
    tripDate: application.travel?.tripDate ? formatUtcDate(application.travel.tripDate) : null,
    purpose: application.travel?.purpose ?? null,
    segments: segmentDtos,
    completionBlockers,
    computed: null, // TODO(PHASE-004-T7)
    snapshot: null, // TODO(PHASE-004-T8)
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),
    completedAt: application.completedAt ? application.completedAt.toISOString() : null,
  };
}
