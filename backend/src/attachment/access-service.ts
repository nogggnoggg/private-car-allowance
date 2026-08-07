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
 * Log safety (§9.4; AR-4 修復 2026-08-07):
 *   storage.get() 失敗時的 catch 區塊**結構性地不持有** err（不讀取
 *   err.message，也不轉呼叫 sanitizeForLog）——`LocalVolumeStorage.get()` 之
 *   「not found」錯誤訊息逐字內嵌 storageKey（見 local-volume-storage.ts），
 *   而 `sanitizeForLog` 僅清除憑證樣式字串（`password=`／連線字串），不清除
 *   路徑或 key（見 log-sanitize.ts 檔頭），故「持有 err.message 後嘗試清
 *   洗」不足以防止洩漏。防線改為「持有後清洗」之對照做法——日誌僅含
 *   `{ attachmentId }` 與固定訊息，不含 err 之任何欄位（比照
 *   `report-service.ts`／`routes.ts` 之 B-28 同型先例）。錯誤回應本身自始
 *   即不含 storageKey 或路徑（僅 404 + 固定中文訊息），本次修復僅變更日誌內
 *   容，不變更對外錯誤契約。
 */

import type { PrismaClient } from "@prisma/client";
import { type CurrentUser, assertOwnershipOrAdmin } from "../auth/middleware.js";
import { AppError } from "../platform/errors.js";
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
  } catch {
    // AR-4 修復：不讀取 err/err.message（逐字含 storageKey，見檔頭「Log
    // safety」）。日誌僅含 attachmentId，結構性地不持有原始錯誤。
    log.error({ attachmentId }, "Attachment file missing from storage despite DB record existing");
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
  } catch {
    // AR-4 修復：見 getAttachmentContent 同型說明。
    log.error({ attachmentId }, "Attachment file missing from storage despite DB record existing");
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
