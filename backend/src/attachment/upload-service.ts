/**
 * Attachment upload service — PHASE-003-T3
 *
 * Implements the full upload pipeline per Spec §4.3/§4.4:
 *   1. Stream multipart file field "file".
 *   2. Accumulate bytes; abort with PAYLOAD_TOO_LARGE if limit exceeded.
 *   3. Read leading bytes; detect MIME via magic bytes (no trust of client headers).
 *   4. Reject non-whitelist MIME with UNSUPPORTED_MEDIA_TYPE.
 *   5. Generate storage keys (att/<cuid>/original, att/<cuid>/thumb).
 *   6. storage.put original bytes.
 *   7. Produce thumbnail via sharp (D5 — fallback to thumbnailKey=null on failure).
 *   8. storage.put thumbnail (if produced).
 *   9. createAttachment(TEMP) in DB.
 *  10. Compensation delete of written storage keys if any post-put step fails.
 *
 * Owner rule (D3 definite; extended PHASE-004-T11 D11): ownerId defaults to the
 * uploading user, but the calling route (routes.ts) may resolve a different,
 * ADMIN-authorized `ownerId` (on-behalf upload) and pass it through explicitly
 * via `UploadOptions.ownerId`. `uploaderId` is ALWAYS the authenticated caller
 * — never client-supplied, never overridden here.
 *
 * Log safety (§9.4): errors logged via sanitizeForLog; no volume paths or raw bytes.
 */

import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { AppError } from "../platform/errors.js";
import { sanitizeForLog } from "../platform/log-sanitize.js";
import type { Storage } from "../storage/index.js";
import { createAttachment } from "./attachment-service.js";
import { detectMimeType } from "./detect-mime.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadResult {
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

export interface UploadOptions {
  /** Authenticated user performing the upload (always the actual caller) */
  uploaderId: string;
  /**
   * Resource owner (PHASE-004-T11 D11). Optional — defaults to `uploaderId`
   * when omitted (D3 default, and what every PHASE-003 caller of this
   * function still does). `routes.ts`'s `POST /attachments` handler always
   * resolves and passes this explicitly (self, or an ADMIN-authorized
   * on-behalf owner from `?ownerId=`) — the authorization decision belongs
   * entirely to the route layer; this module never makes it.
   */
  ownerId?: string;
  /** Max bytes allowed; from env ATTACHMENT_MAX_BYTES */
  maxBytes: number;
  /** Thumbnail long-side pixel limit; from env ATTACHMENT_THUMBNAIL_MAX_PX */
  thumbnailMaxPx: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of bytes to read from stream for magic-byte detection */
const MAGIC_HEADER_BYTES = 12;

// ---------------------------------------------------------------------------
// Storage key generation
// ---------------------------------------------------------------------------

/**
 * Generate a random alphanumeric ID (24 hex chars) suitable for storage keys.
 * Uses Node.js built-in crypto — no external dependency.
 * The character set [a-f0-9] is a subset of the LocalVolumeStorage key whitelist [a-zA-Z0-9_-].
 */
export function generateStorageId(): string {
  return randomBytes(12).toString("hex");
}

/**
 * Generate a pair of storage keys for a new attachment.
 * Keys are system-generated and never contain user input.
 * Format: att/<id>/original and att/<id>/thumb (Spec §4.1, T2 whitelist).
 */
export function generateStorageKeys(id: string): { originalKey: string; thumbKey: string } {
  return {
    originalKey: `att/${id}/original`,
    thumbKey: `att/${id}/thumb`,
  };
}

// ---------------------------------------------------------------------------
// Thumbnail production (D5: sharp with fallback to null)
// ---------------------------------------------------------------------------

/**
 * Attempt to produce a thumbnail using sharp.
 * Returns the thumbnail Buffer on success, null on any failure (non-fatal per D5).
 * Failure is logged at warn level without exposing volume paths.
 */
async function produceThumbnail(
  bytes: Buffer,
  mimeType: string,
  thumbnailMaxPx: number,
  log: { warn: (msg: string) => void }
): Promise<Buffer | null> {
  try {
    // Dynamic import to allow graceful fallback if sharp is not loadable
    const sharp = (await import("sharp")).default;
    const thumbnail = await sharp(bytes)
      .resize(thumbnailMaxPx, thumbnailMaxPx, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .toBuffer();
    return thumbnail;
  } catch (err) {
    const msg = err instanceof Error ? sanitizeForLog(err.message) : "unknown error";
    log.warn(`Thumbnail production failed (non-fatal, D5 fallback): ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main upload function
// ---------------------------------------------------------------------------

/**
 * Process a multipart upload request.
 *
 * Reads the `file` field from a @fastify/multipart request, performs all
 * validation, storage writes, and DB record creation per Spec §4.4.
 *
 * Throws AppError for validation failures; propagates unexpected errors
 * (the route handler wraps them in the Fastify error handler).
 *
 * @param request   Fastify request (must have multipart parsed)
 * @param prisma    PrismaClient instance
 * @param storage   Storage implementation instance
 * @param options   Upload configuration (uploader, limits)
 * @returns         UploadResult (AttachmentDto fields)
 */
export async function processUpload(
  request: FastifyRequest,
  prisma: PrismaClient,
  storage: Storage,
  options: UploadOptions
): Promise<UploadResult> {
  const { uploaderId, maxBytes, thumbnailMaxPx } = options;
  const ownerId = options.ownerId ?? uploaderId; // D3 default when route doesn't override (D11)

  // Step 1: Get the multipart file field
  // @fastify/multipart attaches .file() on the request for single-file mode
  // biome-ignore lint/suspicious/noExplicitAny: fastify-multipart runtime typing
  const req = request as any;

  let filePart: {
    filename: string;
    file: import("node:stream").Readable & { bytesRead?: number; truncated?: boolean };
    fieldname: string;
  } | null = null;

  try {
    filePart = await req.file();
  } catch {
    // No multipart data at all
    throw new AppError("VALIDATION_ERROR", 400, "請提供上傳檔案（欄位名稱：file）");
  }

  if (!filePart) {
    throw new AppError("VALIDATION_ERROR", 400, "請提供上傳檔案（欄位名稱：file）");
  }

  // Extract filename and stream once so subsequent code has no null uncertainty
  const originalFilename = filePart.filename || "upload";
  const fileStream = filePart.file;

  // Step 2: Accumulate stream bytes, checking size limit as we go
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let sizeLimitExceeded = false;

  await new Promise<void>((resolve, reject) => {
    fileStream.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        sizeLimitExceeded = true;
        // Destroy stream to stop reading; resolve so we can throw AppError
        fileStream.destroy();
        resolve();
        return;
      }
      chunks.push(chunk);
    });

    fileStream.on("end", () => resolve());
    fileStream.on("error", (err) => reject(err));
    fileStream.on("close", () => {
      // Stream destroyed (size exceeded); resolve is idempotent
      resolve();
    });
  });

  // Step 3: Check size limit
  if (sizeLimitExceeded) {
    throw new AppError("PAYLOAD_TOO_LARGE", 413, "檔案超過大小上限，請上傳較小的檔案");
  }

  // Combine chunks into a single buffer
  const fileBuffer = Buffer.concat(chunks);

  // Step 4: Empty file check + magic-byte detection
  if (fileBuffer.length === 0) {
    throw new AppError(
      "UNSUPPORTED_MEDIA_TYPE",
      415,
      "不支援的檔案格式，請上傳 JPEG、PNG 或 WebP 圖片"
    );
  }

  const headerBuf = fileBuffer.subarray(0, MAGIC_HEADER_BYTES);
  const detectedMime = detectMimeType(headerBuf);

  if (!detectedMime) {
    throw new AppError(
      "UNSUPPORTED_MEDIA_TYPE",
      415,
      "不支援的檔案格式，請上傳 JPEG、PNG 或 WebP 圖片"
    );
  }

  // Step 5: Generate storage keys (system-generated, no user input)
  const storageId = generateStorageId();
  const { originalKey, thumbKey } = generateStorageKeys(storageId);

  // Track what has been written to storage for compensation on failure
  const writtenKeys: string[] = [];

  try {
    // Step 6: Write original to storage
    await storage.put(originalKey, fileBuffer, detectedMime);
    writtenKeys.push(originalKey);

    // Step 7: Produce thumbnail (non-fatal if it fails — D5 fallback)
    const log = {
      warn: (msg: string) => request.log.warn(msg),
    };
    const thumbnailBuffer = await produceThumbnail(fileBuffer, detectedMime, thumbnailMaxPx, log);

    // Step 8: Write thumbnail to storage (if produced)
    let actualThumbKey: string | undefined;
    if (thumbnailBuffer) {
      await storage.put(thumbKey, thumbnailBuffer, detectedMime);
      writtenKeys.push(thumbKey);
      actualThumbKey = thumbKey;
    }

    // Step 9: Create DB record (TEMP status)
    const attachment = await createAttachment(prisma, {
      storageKey: originalKey,
      thumbnailKey: actualThumbKey,
      mimeType: detectedMime,
      byteSize: fileBuffer.length,
      originalFilename,
      uploaderId,
      ownerId, // D3 default (= uploaderId) or D11 on-behalf owner, resolved by routes.ts
      status: "TEMP",
    });

    // Step 10: Return DTO (no storageKey/absolute paths exposed)
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
  } catch (err) {
    // Compensation: delete any storage keys already written (avoid orphan files)
    for (const key of writtenKeys) {
      try {
        await storage.delete(key);
      } catch (deleteErr) {
        // Log but do not mask the original error
        const deleteMsg =
          deleteErr instanceof Error ? sanitizeForLog(deleteErr.message) : "unknown error";
        request.log.warn(`Compensation delete failed for key (log-safe): ${deleteMsg}`);
      }
    }

    // Re-throw AppErrors (validation failures) directly
    if (err instanceof AppError) {
      throw err;
    }

    // Unexpected failures become INTERNAL_ERROR
    const errMsg = err instanceof Error ? sanitizeForLog(err.message) : "unknown error";
    request.log.error({ errMsg }, "Unexpected error during attachment upload");
    throw new AppError("INTERNAL_ERROR", 500, "系統發生錯誤，請稍後再試");
  }
}
