/**
 * Attachment quantity-limit engine — PHASE-003-T4
 *
 * Spec AC-10/11/12 §13-T4:
 *   Provides two exports:
 *
 *   1. canLink(currentCount, limit): pure decision function.
 *      No DB access, no dependency on application type.
 *      Calling code (T6 link service layer) provides both values at call time.
 *
 *   2. countLinkedAttachments(prisma, refType, refId): repository helper.
 *      Counts LINKED (status="LINKED") attachments for a given container.
 *      Used by the T6 link service before calling canLink.
 *
 * Boundary decisions (definitive, recorded in Handoff):
 *   limit = 0  → always reject (zero slots = no attachments allowed)
 *   count < 0  → normalised to 0 (defensive; negative count is nonsensical)
 *   limit < 0  → always reject (invalid bound treated as zero-slot restriction)
 */

import type { AttachmentRefType, PrismaClient } from "@prisma/client";

/**
 * Pure decision function: can a new attachment be linked to a container?
 *
 * Returns true  when the container can accept at least one more attachment
 *   (i.e. the effective current count is strictly less than the limit).
 * Returns false when the limit is already reached or exceeded, or when the
 *   limit value is ≤ 0 (no slots configured).
 *
 * @param currentCount  Number of attachments currently LINKED to the container.
 *                      Negative values are normalised to 0.
 * @param limit         Maximum allowed attachments for this container.
 *                      Provided by the calling code; not hardcoded per type.
 *                      Values ≤ 0 cause an immediate reject.
 */
export function canLink(currentCount: number, limit: number): boolean {
  // Normalise negative count to 0 (defensive)
  const effectiveCount = currentCount < 0 ? 0 : currentCount;

  // Reject if limit is ≤ 0 (no slots or invalid)
  if (limit <= 0) {
    return false;
  }

  return effectiveCount < limit;
}

/**
 * Repository helper: count the number of LINKED attachments for a container.
 *
 * Only attachments with status="LINKED" AND the exact (refType, refId) pair
 * are counted. TEMP attachments and other containers are excluded.
 *
 * Used by the T6 link service to obtain currentCount before calling canLink.
 *
 * @param prisma   PrismaClient instance (injected by caller).
 * @param refType  The AttachmentRefType enum value identifying the container kind.
 * @param refId    The opaque string ID of the specific container instance.
 * @returns        Promise resolving to the count of LINKED attachments.
 */
export async function countLinkedAttachments(
  prisma: PrismaClient,
  refType: AttachmentRefType | string,
  refId: string
): Promise<number> {
  return prisma.attachment.count({
    where: {
      status: "LINKED",
      refType: refType as AttachmentRefType,
      refId,
    },
  });
}
