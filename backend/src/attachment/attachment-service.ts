/**
 * Attachment service — minimal creation function for PHASE-003-T1.
 *
 * Responsibilities in this Task:
 *   - Enforce the LINKED invariant: if status === LINKED, both refType and refId
 *     must be provided (DB columns are nullable; application layer is the gate).
 *   - Set linkedAt when creating with status LINKED.
 *
 * Out of Scope (歸屬於 T3/T5/T6):
 *   - Storage integration, upload processing, size/mime validation.
 *   - link/detach lifecycle transitions.
 *   - Authorization checks (assertOwnershipOrAdmin).
 */

import type { AttachmentRefType, AttachmentStatus, PrismaClient } from "@prisma/client";

export interface CreateAttachmentInput {
  storageKey: string;
  thumbnailKey?: string;
  mimeType: string;
  byteSize: number;
  originalFilename: string;
  uploaderId: string;
  ownerId: string;
  /** Defaults to TEMP if omitted */
  status?: AttachmentStatus;
  /** Required when status === LINKED */
  refType?: AttachmentRefType;
  /** Required when status === LINKED */
  refId?: string;
}

/**
 * Create an Attachment record, enforcing the LINKED invariant at the
 * application layer (Spec §3.3: "LINKED 時 refType 與 refId 必填").
 *
 * Throws if status is LINKED but refType or refId is absent.
 */
export async function createAttachment(prisma: PrismaClient, input: CreateAttachmentInput) {
  const status: AttachmentStatus = input.status ?? "TEMP";

  if (status === "LINKED") {
    if (!input.refType || !input.refId) {
      throw new Error("LINKED attachment requires refType and refId");
    }
  }

  return prisma.attachment.create({
    data: {
      storageKey: input.storageKey,
      thumbnailKey: input.thumbnailKey ?? null,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      originalFilename: input.originalFilename,
      uploaderId: input.uploaderId,
      ownerId: input.ownerId,
      status,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      linkedAt: status === "LINKED" ? new Date() : null,
    },
  });
}
