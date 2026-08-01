/**
 * Attachment access service — PHASE-003-T5
 *
 * Implements the authorization and retrieval logic for:
 *   GET /attachments/:id/content
 *   GET /attachments/:id/thumbnail
 *
 * Security contract (Spec §4.6, Done-When T5):
 *   1. requireAuth is enforced at the route layer (not here).
 *   2. This service queries DB for attachment.ownerId and calls
 *      assertOwnershipOrAdmin(currentUser, ownerId). Authorization is based
 *      SOLELY on the DB record — never on request parameters.
 *   3. 404 NOT_FOUND if attachment id does not exist.
 *   4. 403 FORBIDDEN (D6 definite) if non-owner non-admin requests.
 *   5. storage.get() throws if the key is missing (file lost after record exists).
 *      Behaviour: re-throw as 404 NOT_FOUND + error log (does not expose key).
 *
 * D5 thumbnail fallback:
 *   If thumbnailKey is null, /thumbnail falls back to original bytes (storageKey).
 *   This matches the Spec decision: "sharp 失敗→前端拿原圖" — the endpoint returns
 *   original bytes rather than 404 so the frontend always gets something useful.
 *
 * Log safety (§9.4):
 *   Errors are logged via sanitizeForLog; storageKey and volume paths are NOT
 *   included in error response bodies or log messages.
 */

import type { PrismaClient } from "@prisma/client";
import { type CurrentUser, assertOwnershipOrAdmin } from "../auth/middleware.js";
import { AppError } from "../platform/errors.js";
import { sanitizeForLog } from "../platform/log-sanitize.js";
import type { Storage } from "../storage/index.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface AttachmentBytes {
  /** Raw file bytes */
  bytes: Buffer;
  /** MIME type to set as Content-Type */
  mimeType: string;
}

// ---------------------------------------------------------------------------
// Shared attachment lookup + authorization
// ---------------------------------------------------------------------------

/**
 * Fetch the DB record for the attachment, verify ownership, return the record.
 * Throws AppError on 404 (not found) or 403 (forbidden).
 *
 * Authorization: reads ownerId from DB; never trusts request parameters.
 */
async function fetchAndAuthorize(
  prisma: PrismaClient,
  attachmentId: string,
  currentUser: CurrentUser
) {
  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    select: {
      id: true,
      storageKey: true,
      thumbnailKey: true,
      mimeType: true,
      ownerId: true,
    },
  });

  if (!attachment) {
    throw new AppError("NOT_FOUND", 404, "找不到附件");
  }

  // Authorization: assertOwnershipOrAdmin uses DB ownerId (not request params)
  // Throws FORBIDDEN (403) if neither owner nor admin.
  assertOwnershipOrAdmin(currentUser, attachment.ownerId);

  return attachment;
}

// ---------------------------------------------------------------------------
// Public service functions
// ---------------------------------------------------------------------------

/**
 * Retrieve the original attachment bytes for GET /attachments/:id/content.
 *
 * @param prisma       - PrismaClient
 * @param storage      - Storage implementation
 * @param attachmentId - Attachment id from route param
 * @param currentUser  - Authenticated user (from requireAuth)
 * @param log          - Logger (for error logging without exposing key)
 * @returns            AttachmentBytes { bytes, mimeType }
 * @throws AppError 404 if not found; 403 if not authorized; 404 if file missing
 */
export async function getAttachmentContent(
  prisma: PrismaClient,
  storage: Storage,
  attachmentId: string,
  currentUser: CurrentUser,
  log: { error: (obj: Record<string, unknown>, msg: string) => void }
): Promise<AttachmentBytes> {
  const attachment = await fetchAndAuthorize(prisma, attachmentId, currentUser);

  // Retrieve bytes from storage
  // If storage.get throws, the file is missing despite a DB record existing.
  // Decision: return 404 NOT_FOUND + error log (do not expose storageKey).
  let rawResult: Buffer | NodeJS.ReadableStream;
  try {
    rawResult = await storage.get(attachment.storageKey);
  } catch (err) {
    const errMsg = err instanceof Error ? sanitizeForLog(err.message) : "unknown error";
    log.error(
      { attachmentId, errMsg },
      "Attachment file missing from storage despite DB record existing"
    );
    throw new AppError("NOT_FOUND", 404, "附件檔案不存在");
  }

  // LocalVolumeStorage.get returns Buffer; coerce if ReadableStream for safety
  const bytes = Buffer.isBuffer(rawResult)
    ? rawResult
    : await streamToBuffer(rawResult as NodeJS.ReadableStream);

  return { bytes, mimeType: attachment.mimeType };
}

/**
 * Retrieve thumbnail bytes for GET /attachments/:id/thumbnail.
 * Falls back to original bytes if thumbnailKey is null (D5 fallback).
 *
 * @param prisma       - PrismaClient
 * @param storage      - Storage implementation
 * @param attachmentId - Attachment id from route param
 * @param currentUser  - Authenticated user (from requireAuth)
 * @param log          - Logger
 * @returns            AttachmentBytes { bytes, mimeType }
 * @throws AppError 404 if not found; 403 if not authorized; 404 if file missing
 */
export async function getAttachmentThumbnail(
  prisma: PrismaClient,
  storage: Storage,
  attachmentId: string,
  currentUser: CurrentUser,
  log: { error: (obj: Record<string, unknown>, msg: string) => void }
): Promise<AttachmentBytes> {
  const attachment = await fetchAndAuthorize(prisma, attachmentId, currentUser);

  // D5 fallback: if thumbnailKey is null, serve original bytes
  const keyToFetch = attachment.thumbnailKey ?? attachment.storageKey;

  let rawResult: Buffer | NodeJS.ReadableStream;
  try {
    rawResult = await storage.get(keyToFetch);
  } catch (err) {
    const errMsg = err instanceof Error ? sanitizeForLog(err.message) : "unknown error";
    log.error(
      { attachmentId, errMsg },
      "Attachment file missing from storage despite DB record existing"
    );
    throw new AppError("NOT_FOUND", 404, "附件檔案不存在");
  }

  const bytes = Buffer.isBuffer(rawResult)
    ? rawResult
    : await streamToBuffer(rawResult as NodeJS.ReadableStream);

  return { bytes, mimeType: attachment.mimeType };
}

// ---------------------------------------------------------------------------
// Internal utility
// ---------------------------------------------------------------------------

/** Collect a ReadableStream into a Buffer (used if storage returns a stream) */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    );
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
