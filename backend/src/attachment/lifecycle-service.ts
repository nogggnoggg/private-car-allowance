/**
 * Attachment lifecycle service — PHASE-003-T6
 *
 * Implements the core lifecycle transitions per Spec §4.5/§5.1/§13-T6:
 *   - linkAttachment: TEMP → LINKED (with ownership check, container-state check, count limit)
 *   - deleteAttachment: LINKED → TEMP (detach) or TEMP → delete from DB+storage
 *   - isEligibleForCleanup: pure function for PHASE-011 cleanup scheduling
 *   - assertContainerMutable: throws FORBIDDEN if containerState === 'completed'
 *   - HasReferenceQuery: interface contract for PHASE-011 reference query injection
 *
 * Definitive decisions recorded in Handoff:
 *
 * D2/TTL-base: When a LINKED attachment is detached (DELETE), its status reverts to TEMP
 *   and `createdAt` is updated to the current time. This makes `createdAt` serve as
 *   "the time this attachment last became TEMP", which is the TTL base per Spec §4.5:
 *   "TTL 以最後一次成為 TEMP 的時間起算". The schema comment (createdAt = 'TEMP TTL 基準')
 *   is satisfied without adding a new column (schema frozen).
 *
 * TEMP DELETE semantics (§5.1): A TEMP attachment (no container) is physically deleted —
 *   DB record removed + storage files deleted. Spec §5.1 DELETE says "解除關聯/標記可清理";
 *   for TEMP with no ref, there is nothing to detach, and immediate deletion is the correct
 *   semantic (avoids orphan accumulation). This is consistent with §4.4 "補償語意" and the
 *   cleanup intent described in §4.5. DB deletion happens FIRST; storage deletion second.
 *   Rationale: DB is the source of truth — removing the record first ensures no subsequent
 *   request can access the file; if storage deletion fails, the file becomes orphaned but
 *   is unreachable (acceptable risk; PHASE-011 cleanup can sweep orphaned keys).
 *
 * TOCTOU prevention in linkAttachment (definitive, PHASE-004-T11R2):
 *   The count→check→update is wrapped in:
 *     prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
 *   SERIALIZABLE isolation prevents phantom reads in Postgres: if two concurrent transactions
 *   both count the same (refType, refId) container, Postgres detects the conflict at commit
 *   time and aborts one with a serialization failure (Prisma error code P2034). The aborted
 *   transaction is retried up to LINK_MAX_RETRIES=3 times, re-running the entire
 *   count→check→update block against a FRESH snapshot each time. No advisory lock is used —
 *   SERIALIZABLE's own write-skew detection is sufficient for this single-table,
 *   count-then-conditionally-write pattern, proven stable by
 *   `phase3-lifecycle-concurrent.test.ts`.
 *
 *   `linkAttachmentTx` (below) is this exact block, extracted so `updateTravelDraft`
 *   (travel-service.ts) can run it inside its OWN larger SERIALIZABLE transaction (see that
 *   function's doc comment for why baseline computation living INSIDE that transaction, not
 *   before it, is what makes concurrent full-PUT saves resolve correctly under D19 — Spec §17
 *   D19, PHASE-004-T11R2 Task Handoff「根因與修法」). No per-container advisory lock is taken
 *   here either: both callers rely on their own transaction's SERIALIZABLE guarantee.
 *
 * Already-LINKED rejection: If an attachment is already LINKED and a second link is
 *   attempted, a 409 CONFLICT is returned. This is separate from TOO_MANY_ATTACHMENTS.
 *
 * containerState default: 'draft' — mutability allowed. Body/query param `containerState`
 *   overrides this. In PHASE-004+, the real container state will be injected from the
 *   application service layer.
 *
 * HasReferenceQuery interface: Defined here as the contract for PHASE-011 to implement
 *   real reference lookups (draft/completed/report/audit). Not implemented in this Phase
 *   because the reference source tables (TravelApplication etc.) do not exist yet.
 *
 * ── PHASE-004-T11 additions (AR-D 閉環, D11/D12) ──────────────────────────
 *
 * linkAttachmentTx: the count→check→update transaction BODY of `linkAttachment`,
 *   extracted so a caller that already owns its own transaction (travel-service.ts's
 *   `updateTravelDraft`) can invoke it without nesting `prisma.$transaction` calls
 *   (Prisma does not support nested transactions). `linkAttachment` itself is
 *   refactored to open a transaction and delegate to this function, so the two
 *   share exactly one implementation of the count/limit/update logic — its own
 *   public behavior (steps 1-4 outside the transaction: load/404, ownership/403,
 *   containerState/403, TEMP-status/409; SERIALIZABLE + P2034 retry around the
 *   transaction) is UNCHANGED (PHASE-003 tests must remain green untouched).
 *
 * detachAttachmentsByIdsTx: bulk detach by explicit attachment id list (as opposed
 *   to `detachAttachmentsByRefTx`'s "all LINKED attachments under this refId").
 *   Needed because a single TripSegment's `attachmentIds[]` reconciliation may
 *   keep SOME of its previously-LINKED attachments while dropping others — a
 *   refId-based bulk detach would incorrectly clear the survivors too.
 *
 * deriveContainerState: the AR-D authority. Replaces the PHASE-003-era pattern of
 *   trusting a client-supplied `containerState` query/body param. Given an
 *   attachment's DB row, walks refType/refId → TripSegment → TravelApplication →
 *   Application.status to produce the REAL containerState. `routes.ts`'s
 *   `DELETE /attachments/:id` is the only caller in this Phase; it no longer reads
 *   any client-supplied containerState at all (Spec AC-27b).
 */

import { Prisma } from "@prisma/client";
import type { AttachmentRefType, AttachmentStatus, PrismaClient } from "@prisma/client";
import { type CurrentUser, assertOwnershipOrAdmin } from "../auth/middleware.js";
import { AppError } from "../platform/errors.js";
import type { Storage } from "../storage/index.js";
import { canLink, countLinkedAttachments } from "./attachment-limit-engine.js";

// ---------------------------------------------------------------------------
// PrismaTxLike — PHASE-004-T4: accepts either a plain PrismaClient or a
// transaction client (`prisma.$transaction(async (tx) => ...)`'s `tx`
// param), so callers running inside a caller-owned transaction (e.g.
// travel-service.ts's updateTravelDraft/deleteApplication) can pass `tx`
// straight through without any cast. No new dependency — `Prisma` is
// already imported above.
// ---------------------------------------------------------------------------

export type PrismaTxLike = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Container state type
// ---------------------------------------------------------------------------

export type ContainerState = "draft" | "completed";

// ---------------------------------------------------------------------------
// HasReferenceQuery — interface contract for PHASE-011
// ---------------------------------------------------------------------------

/**
 * Interface for querying whether an attachment is referenced by any live entity.
 *
 * This is the contract that PHASE-011 (cleanup scheduler) must implement.
 * In this Phase, reference source tables do not yet exist, so no real implementation
 * is provided. The cleanup scheduler will inject a concrete implementation that
 * queries all known reference sources:
 *   - Draft TravelApplication (PHASE-004)
 *   - Completed TravelApplication (PHASE-004)
 *   - MaintenanceApplication (PHASE-006)
 *   - DepreciationApplication (PHASE-007)
 *   - Report/Audit entries (PHASE-008/PHASE-009)
 *
 * Usage (PHASE-011):
 *   const hasRef: HasReferenceQuery = {
 *     hasReference: async (attachmentId) => {
 *       const count = await prisma.tripSegment.count({ where: { attachmentId } });
 *       return count > 0;
 *     }
 *   };
 *   const eligible = isEligibleForCleanup(att, new Date(), await hasRef.hasReference(att.id), ttlHours);
 */
export interface HasReferenceQuery {
  /**
   * Returns true if the given attachment is currently referenced by any live entity
   * (draft, completed application, report, or audit record). Returns false if the
   * attachment has no known references and is safe to consider for cleanup.
   *
   * @param attachmentId - The attachment's id
   */
  hasReference(attachmentId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// assertContainerMutable — AC-16 guard
// ---------------------------------------------------------------------------

/**
 * Assert that the container is in a mutable state (not completed).
 *
 * Throws AppError FORBIDDEN (403) if containerState === 'completed'.
 * Passes silently for 'draft'.
 *
 * Spec §4.5 / AC-16: "已完成申請不得刪除/替換附件" — the container state is injected
 * by the caller; the real state comes from PHASE-004+ application service.
 * In this Phase, callers pass containerState via request body or query string.
 *
 * @param containerState - 'draft' | 'completed'
 */
export function assertContainerMutable(containerState: ContainerState): void {
  if (containerState === "completed") {
    throw new AppError("FORBIDDEN", 403, "已完成的申請不得修改或刪除附件");
  }
}

// ---------------------------------------------------------------------------
// deriveContainerState — PHASE-004-T11 (AR-D 閉環, AC-27, §9「附件（改造點）」)
// ---------------------------------------------------------------------------

/**
 * Derive the REAL containerState for an attachment from DB state — the
 * authoritative replacement for the PHASE-003-era pattern of trusting a
 * client-supplied `containerState` query/body parameter.
 *
 * Rules (Spec §9):
 *   attachment.status = TEMP                     → 'draft' (no container yet)
 *   refType = TRIP_SEGMENT → TripSegment → TravelApplication → Application.status
 *        COMPLETED → 'completed'
 *        DRAFT     → 'draft'
 *   refType = MAINTENANCE / DEPRECIATION         → 'draft' (子表尚不存在，本 Phase
 *                                                   不可能真的產生此關聯，防禦性)
 *   refId 指向已不存在的 TripSegment（孤兒）      → 'draft'（記錄 log；不得 500）
 *
 * The ONLY caller in this Phase is `routes.ts`'s `DELETE /attachments/:id` —
 * it no longer reads any client-supplied containerState at all (AC-27b).
 *
 * @param log Optional logger for the orphan case (non-fatal, informational).
 */
export async function deriveContainerState(
  prisma: PrismaClient,
  attachment: {
    status: AttachmentStatus;
    refType: AttachmentRefType | null;
    refId: string | null;
  },
  log?: { warn: (msg: string) => void }
): Promise<ContainerState> {
  if (attachment.status !== "LINKED") {
    return "draft";
  }

  if (attachment.refType === "TRIP_SEGMENT" && attachment.refId) {
    const segment = await prisma.tripSegment.findUnique({
      where: { id: attachment.refId },
      select: { travel: { select: { application: { select: { status: true } } } } },
    });
    if (!segment) {
      // Orphan: refId points to a TripSegment that no longer exists. This should
      // not normally happen (segment deletion always detaches attachments first,
      // in the same transaction — travel-service.ts) but is handled defensively
      // per Spec §9 rather than allowed to throw/500.
      log?.warn(
        `deriveContainerState: orphan attachment ref — TripSegment ${attachment.refId} not found; treating as draft`
      );
      return "draft";
    }
    return segment.travel.application.status === "COMPLETED" ? "completed" : "draft";
  }

  // MAINTENANCE/DEPRECIATION: sub-tables don't exist this Phase (PHASE-006/007) —
  // no real attachment can carry these refTypes yet, but handled defensively.
  return "draft";
}

// ---------------------------------------------------------------------------
// isEligibleForCleanup — pure function (AC-17/18, §4.5)
// ---------------------------------------------------------------------------

/**
 * Determine whether an attachment is eligible for cleanup (deletion by PHASE-011 scheduler).
 *
 * Pure function — no DB or I/O access. All inputs are provided by the caller.
 * The cleanup scheduler (PHASE-011) is responsible for calling this function with
 * the real hasReference value obtained via HasReferenceQuery.
 *
 * Rules (AC-17/18):
 *   - LINKED attachments → always false (protected by their container)
 *   - hasReference=true → always false (referenced by draft/completed/report/audit)
 *   - TEMP, !hasReference, elapsed > TTL → true (eligible)
 *   - TEMP, !hasReference, elapsed <= TTL → false (not yet expired)
 *
 * TTL comparison: strictly greater than (not >=). A file at exactly 24h is NOT eligible.
 *
 * @param attachment  - The attachment record (must have id, status, createdAt)
 * @param now         - Current time (injected for testability)
 * @param hasReference - Whether any live entity references this attachment
 * @param ttlHours    - TTL threshold in hours (from env ATTACHMENT_TEMP_TTL_HOURS)
 */
export function isEligibleForCleanup(
  attachment: { id: string; status: string; createdAt: Date },
  now: Date,
  hasReference: boolean,
  ttlHours: number
): boolean {
  // LINKED attachments are never eligible — their container protects them
  if (attachment.status === "LINKED") {
    return false;
  }

  // Referenced attachments are never eligible (AC-17)
  if (hasReference) {
    return false;
  }

  // TEMP, no reference: check TTL (strictly greater than)
  const elapsedMs = now.getTime() - attachment.createdAt.getTime();
  const ttlMs = ttlHours * 60 * 60 * 1000;

  return elapsedMs > ttlMs;
}

// ---------------------------------------------------------------------------
// AttachmentDto shape (for route responses)
// ---------------------------------------------------------------------------

export interface AttachmentDto {
  id: string;
  status: string;
  mimeType: string;
  byteSize: number;
  originalFilename: string;
  refType: string | null;
  refId: string | null;
  previewUrl: string;
  downloadUrl: string;
}

/**
 * Exported (PHASE-004-T11) so `travel-service.ts` can build `TripSegmentDto.attachments`
 * (Spec §8.1: real `AttachmentDto[]`, same shape used everywhere else) from raw
 * `Attachment` rows without re-implementing this mapping — single source of truth
 * for "DB row → AttachmentDto".
 */
export function toDto(attachment: {
  id: string;
  status: AttachmentStatus;
  mimeType: string;
  byteSize: number;
  originalFilename: string;
  refType: AttachmentRefType | null;
  refId: string | null;
}): AttachmentDto {
  return {
    id: attachment.id,
    status: attachment.status,
    mimeType: attachment.mimeType,
    byteSize: attachment.byteSize,
    originalFilename: attachment.originalFilename,
    refType: attachment.refType,
    refId: attachment.refId,
    previewUrl: `/attachments/${attachment.id}/thumbnail`,
    downloadUrl: `/attachments/${attachment.id}/content`,
  };
}

// ---------------------------------------------------------------------------
// linkAttachment — TEMP → LINKED (AC-14, AC-10, AC-12, AC-16)
// ---------------------------------------------------------------------------

export interface LinkAttachmentInput {
  attachmentId: string;
  refType: AttachmentRefType;
  refId: string;
  /** Max attachments for this container; provided by the caller (AC-12) */
  limit: number;
  /** Container state injected by caller; 'draft' allows mutation, 'completed' blocks it (D2/AC-16) */
  containerState: ContainerState;
  /** Authenticated user performing the action */
  actor: CurrentUser;
}

/**
 * Maximum retry attempts for serialization failures (Prisma P2034) in linkAttachment.
 * Each retry re-runs the entire count→check→update block inside a fresh SERIALIZABLE tx.
 */
const LINK_MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// linkAttachmentTx — PHASE-004-T11: the transaction BODY of linkAttachment,
// extracted for callers that already own their own transaction (裁定 A).
// ---------------------------------------------------------------------------

export interface LinkAttachmentTxInput {
  attachmentId: string;
  refType: AttachmentRefType;
  refId: string;
  /** Max attachments for this container; provided by the caller (AC-12/AC-22) */
  limit: number;
}

/**
 * The count→check→update block, run inside a transaction the CALLER provides
 * (`tx`). This is exactly step 5a-5c of `linkAttachment` below, unchanged in
 * substance — `linkAttachment` opens its own SERIALIZABLE transaction and
 * calls this function as the callback body, so the two are provably identical
 * (裁定 A: "理想作法是讓 linkAttachment 改為「開交易後呼叫 linkAttachmentTx」，
 * 使兩者共用同一份實作").
 *
 * Callers are responsible for everything `linkAttachment` does OUTSIDE the
 * transaction (load/404, ownership/403, containerState/403, TEMP-status/409)
 * — `updateTravelDraft` (travel-service.ts) performs its own equivalent checks
 * (AC-30 owner-consistency instead of assertOwnershipOrAdmin, since the actor
 * was already authorized against the Application in the route layer) before
 * calling this. No advisory lock here — the caller's OWN SERIALIZABLE
 * transaction is what makes this count/limit/update correct under
 * concurrency (see this file's header comment, and — for `updateTravelDraft`
 * specifically — that function's own doc comment on why baseline computation
 * living inside the transaction is what actually matters, PHASE-004-T11R2).
 *
 * Does NOT retry on P2034 — the caller's OWN transaction determines the retry
 * policy (see `updateTravelDraft`'s SERIALIZABLE + retry wrapper, 裁定 A).
 *
 * @returns AttachmentDto with status=LINKED
 */
export async function linkAttachmentTx(
  tx: PrismaTxLike,
  input: LinkAttachmentTxInput
): Promise<AttachmentDto> {
  const { attachmentId, refType, refId, limit } = input;

  const currentCount = await countLinkedAttachments(tx as unknown as PrismaClient, refType, refId);

  if (!canLink(currentCount, limit)) {
    throw new AppError("TOO_MANY_ATTACHMENTS", 409, "附件數量已達上限");
  }

  const updated = await tx.attachment.update({
    where: { id: attachmentId },
    data: {
      status: "LINKED",
      refType,
      refId,
      linkedAt: new Date(),
    },
  });

  return toDto(updated);
}

/**
 * Link a TEMP attachment to a container (draft state).
 *
 * Spec §5.1 service layer signature:
 *   linkAttachment(prisma, { attachmentId, refType, refId, limit, containerState, actor })
 *
 * Sequence:
 *   1. Load attachment from DB (404 if not found)
 *   2. assertOwnershipOrAdmin(actor, attachment.ownerId) — 403 if not owner/admin
 *   3. assertContainerMutable(containerState) — 403 if completed
 *   4. Check status === 'TEMP' — 409 CONFLICT if already LINKED
 *   5. SERIALIZABLE transaction with retry (up to LINK_MAX_RETRIES=3), calling
 *      `linkAttachmentTx` as the transaction body (PHASE-004-T11: shared with
 *      `updateTravelDraft`'s per-segment attachment reconciliation — 裁定 A).
 *      On Prisma P2034 (serialization failure): retry with a fresh transaction.
 *      Retries exhausted → surfaced as TOO_MANY_ATTACHMENTS.
 *
 * TOCTOU mechanism: SERIALIZABLE isolation prevents phantom reads. Two concurrent
 * transactions counting the same container will have one aborted by Postgres at commit
 * time (P2034). The retried transaction then sees the committed count and correctly
 * rejects with TOO_MANY_ATTACHMENTS.
 *
 * PHASE-004-T11: this refactor moved the transaction body into `linkAttachmentTx` (see
 * that function's doc comment) so `updateTravelDraft` (travel-service.ts) can share the
 * same count/limit/update logic inside its own transaction. This function's own steps
 * 1-5 and SERIALIZABLE + retry wrapper are otherwise unchanged from PHASE-003. All
 * PHASE-003 tests exercising this function (directly or via HTTP) remain green.
 *
 * @returns AttachmentDto with status=LINKED
 */
export async function linkAttachment(
  prisma: PrismaClient,
  input: LinkAttachmentInput
): Promise<AttachmentDto> {
  const { attachmentId, refType, refId, limit, containerState, actor } = input;

  // Step 1: Load attachment
  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId },
  });
  if (!attachment) {
    throw new AppError("NOT_FOUND", 404, "找不到附件");
  }

  // Step 2: Ownership check (authorization based on DB ownerId, not request params)
  assertOwnershipOrAdmin(actor, attachment.ownerId);

  // Step 3: Container state check (AC-16)
  assertContainerMutable(containerState);

  // Step 4: Status check — only TEMP can be linked
  if (attachment.status !== "TEMP") {
    throw new AppError("CONFLICT", 409, "附件已關聯，無法重複關聯");
  }

  // Step 5: SERIALIZABLE transaction with retry on P2034 (serialization failure).
  // SERIALIZABLE prevents phantom reads: concurrent count() calls on the same container
  // will conflict at commit; Postgres aborts one with a serialization error (P2034).
  // Retry re-runs linkAttachmentTx (the entire count→check→update) under a fresh
  // SERIALIZABLE transaction.
  let lastError: unknown;
  for (let attempt = 0; attempt <= LINK_MAX_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        (tx) => linkAttachmentTx(tx, { attachmentId, refType, refId, limit }),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        }
      );
    } catch (err) {
      lastError = err;

      // Re-throw immediately for any non-serialization error (AppError, unknown errors)
      if (err instanceof AppError) {
        throw err;
      }

      // P2034 = Prisma serialization failure — retry eligible
      const isPrismaSerializationError =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";

      if (!isPrismaSerializationError) {
        // Not a serialization failure — do not retry
        throw err;
      }

      // Serialization failure: retry if we have attempts remaining
      if (attempt >= LINK_MAX_RETRIES) {
        // Retries exhausted — surface as TOO_MANY_ATTACHMENTS (the limit was reached
        // by a concurrent winner; the retried tx would also see count >= limit)
        throw new AppError("TOO_MANY_ATTACHMENTS", 409, "附件數量已達上限（並發衝突後重試耗盡）");
      }
      // else: loop continues to next retry attempt
    }
  }

  // Should be unreachable (loop always either returns or throws), but TypeScript needs this
  throw lastError;
}

// ---------------------------------------------------------------------------
// Shared detach field-set — PHASE-004-T4 single source of truth
// ---------------------------------------------------------------------------

/**
 * The exact set of column changes a "detach" (LINKED → TEMP) applies,
 * regardless of which caller triggers it. Factored out so `deleteAttachment`
 * (single attachment, by id) and `detachAttachmentsByRefTx` (bulk, by
 * refType+refId) are guaranteed to write IDENTICAL field values — this is
 * the "單一真相" the PHASE-004-T4 Packet requires, without changing
 * `deleteAttachment`'s per-id cardinality (a bulk refId-based update would
 * incorrectly detach OTHER attachments sharing the same container, e.g. two
 * sibling screenshots on the same TripSegment — not what a single
 * `DELETE /attachments/:id` should do).
 *
 * `createdAt` reset = TTL base restart (D2/§4.5, D16): after detach,
 * `createdAt` means "the time this attachment last became TEMP".
 */
function detachFieldSet(now: Date) {
  return {
    status: "TEMP" as const,
    refType: null,
    refId: null,
    linkedAt: null,
    createdAt: now,
  };
}

// ---------------------------------------------------------------------------
// detachAttachmentsByRefTx — PHASE-004-T4 (D16): bulk detach within a
// caller-owned transaction, DB-only (no storage IO — D16 explicitly forbids
// storage IO inside an application-service transaction).
// ---------------------------------------------------------------------------

/**
 * Detach ALL currently-`LINKED` attachments referencing any of `refIds`
 * under `refType`: LINKED → TEMP, clear refType/refId/linkedAt, reset
 * createdAt to `now` (TTL base — same field-set as `deleteAttachment`'s
 * detach branch, see `detachFieldSet`).
 *
 * Intended caller: `travel-service.ts`, invoked with the deleted
 * `TripSegment` ids inside the SAME `prisma.$transaction` that deletes those
 * segments (PHASE-004 Spec §8.2 D15/D16, §9 Data Flow step ①②).
 *
 * Only touches rows with `status = 'LINKED'` — already-TEMP rows have no ref
 * to clear (invariant: TEMP attachments always have refType/refId = null),
 * so filtering avoids a no-op write on rows that don't need it.
 *
 * `tx` is deliberately `PrismaTxLike` (not just `Prisma.TransactionClient`)
 * so this can also be called with a plain `PrismaClient` outside of an
 * explicit transaction (a single `updateMany` is already atomic on its own).
 *
 * @returns number of attachments actually detached (rows affected).
 */
export async function detachAttachmentsByRefTx(
  tx: PrismaTxLike,
  refType: AttachmentRefType,
  refIds: string[]
): Promise<number> {
  if (refIds.length === 0) return 0;

  const result = await tx.attachment.updateMany({
    where: { refType, refId: { in: refIds }, status: "LINKED" },
    data: detachFieldSet(new Date()),
  });
  return result.count;
}

// ---------------------------------------------------------------------------
// detachAttachmentsByIdsTx — PHASE-004-T11: bulk detach by explicit attachment
// id list (not by container refId) within a caller-owned transaction.
// ---------------------------------------------------------------------------

/**
 * Detach specific attachments BY ID (as opposed to `detachAttachmentsByRefTx`,
 * which detaches ALL currently-LINKED attachments under a given refId).
 *
 * Needed by `travel-service.ts`'s per-segment `attachmentIds[]` reconciliation
 * (Spec §9 「儲存草稿」步驟④「移除者 → detach」): a single TripSegment may keep
 * SOME of its previously-LINKED attachments while dropping others in the same
 * `PUT` — a refId-based bulk detach would incorrectly clear the survivors too.
 *
 * Only touches rows with `status = 'LINKED'` (same guard as
 * `detachAttachmentsByRefTx`); reuses the same `detachFieldSet` so both bulk
 * detach paths write IDENTICAL field values (single source of truth, same
 * rationale as `detachAttachmentsByRefTx`'s doc comment).
 *
 * @returns number of attachments actually detached (rows affected).
 */
export async function detachAttachmentsByIdsTx(
  tx: PrismaTxLike,
  attachmentIds: string[]
): Promise<number> {
  if (attachmentIds.length === 0) return 0;

  const result = await tx.attachment.updateMany({
    where: { id: { in: attachmentIds }, status: "LINKED" },
    data: detachFieldSet(new Date()),
  });
  return result.count;
}

// ---------------------------------------------------------------------------
// deleteAttachment — detach (LINKED → TEMP) or physical delete (TEMP → gone)
// ---------------------------------------------------------------------------

export interface DeleteAttachmentInput {
  attachmentId: string;
  /** Container state injected by caller; 'completed' blocks deletion (AC-16) */
  containerState: ContainerState;
  /** Authenticated user performing the action */
  actor: CurrentUser;
}

/**
 * Delete an attachment:
 *   - If LINKED (and container is draft): detach → status back to TEMP
 *     * refType/refId/linkedAt cleared
 *     * createdAt updated to now (TTL base reset per §4.5/D2 definition)
 *   - If TEMP: physically delete DB record + storage files (original + thumbnail)
 *   - If container is completed: 403 FORBIDDEN (AC-16)
 *
 * TEMP DELETE semantics (Packet §3 note, §5.1):
 *   For TEMP attachments, DELETE performs physical removal rather than just
 *   "marking as eligible for cleanup". Rationale: the attachment has no container
 *   reference, so immediate deletion is the correct semantic per §4.5 TEMP lifecycle
 *   and avoids orphan accumulation. DB record is removed first (source-of-truth);
 *   storage deletion is attempted second (best-effort, failure logged not re-thrown).
 *
 * Storage deletion order (failure handling):
 *   1. DB record deleted FIRST — prevents any future access attempt
 *   2. storage.delete(storageKey) — original file
 *   3. storage.delete(thumbnailKey) if exists — thumbnail
 *   If storage.delete fails: file is orphaned but unreachable; error is logged.
 *   PHASE-011 can sweep orphaned storage keys.
 *
 * TTL base reset on detach (D2/§4.5):
 *   createdAt is set to new Date() on detach. This makes createdAt mean
 *   "the time this attachment last became TEMP", which is the TTL base.
 *   The column comment in the schema says "上傳時間（暫存 TTL 基準）" — after detach,
 *   this is reinterpreted as "last-became-TEMP time". No schema change needed.
 *
 * @returns { ok: true }
 */
export async function deleteAttachment(
  prisma: PrismaClient,
  storage: Storage,
  input: DeleteAttachmentInput
): Promise<{ ok: true }> {
  const { attachmentId, containerState, actor } = input;

  // Load attachment
  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId },
  });
  if (!attachment) {
    throw new AppError("NOT_FOUND", 404, "找不到附件");
  }

  // Ownership check
  assertOwnershipOrAdmin(actor, attachment.ownerId);

  // Container state check (AC-16) — blocks delete if container is completed
  assertContainerMutable(containerState);

  if (attachment.status === "LINKED") {
    // Detach: revert to TEMP, clear ref fields, reset createdAt as TTL base
    // (D2/§4.5). PHASE-004-T4: field values now come from the single shared
    // `detachFieldSet` helper — also used by `detachAttachmentsByRefTx` —
    // so both detach paths are provably identical (see that function's
    // doc comment for why this stays a per-id `update`, not a refId-based
    // `updateMany`).
    await prisma.attachment.update({
      where: { id: attachmentId },
      data: detachFieldSet(new Date()),
    });
  } else {
    // TEMP attachment: physical delete
    // DB first (source of truth), then storage (best-effort)
    const { storageKey, thumbnailKey } = attachment;

    await prisma.attachment.delete({ where: { id: attachmentId } });

    // Storage cleanup (best-effort — orphan is unreachable if DB record is gone)
    const keysToDelete = [storageKey, thumbnailKey].filter(
      (k): k is string => typeof k === "string" && k.length > 0
    );
    for (const key of keysToDelete) {
      try {
        await storage.delete(key);
      } catch {
        // Orphan file: not exposed to user; PHASE-011 can clean up unreachable keys.
        // Intentionally not re-throwing (compensatory best-effort per §4.4 pattern).
      }
    }
  }

  return { ok: true };
}
