/**
 * Magic-byte MIME type detection — PHASE-003-T3 (Spec §4.2, D5).
 *
 * Self-written, zero-dependency detection for the three supported formats:
 *   - JPEG:  FF D8 FF  (first 3 bytes)
 *   - PNG:   89 50 4E 47 0D 0A 1A 0A  (first 8 bytes)
 *   - WebP:  RIFF....WEBP  (bytes 0-3 = 52 49 46 46; bytes 8-11 = 57 45 42 50)
 *
 * Any other content is rejected — the function returns null.
 * Trusts only the actual byte content; ignores filename extension and
 * the Content-Type header provided by the client (AC-02, security core).
 *
 * The returned MIME string is the authoritative type used for DB storage
 * and the Content-Type response header.
 */

/** Supported MIME types for attachments (Spec §4.2 whitelist) */
export type SupportedMimeType = "image/jpeg" | "image/png" | "image/webp";

/** Minimum bytes required for WebP detection (needs bytes 0–11) */
const MIN_BYTES_FOR_DETECTION = 12;

/**
 * Detect the MIME type of a file from its leading bytes.
 *
 * @param header  A Buffer containing at least the first bytes of the file.
 *                Caller should pass at least 12 bytes; fewer bytes may
 *                result in null even for valid images.
 * @returns       The detected MIME type string, or null if not a supported format.
 */
export function detectMimeType(header: Buffer): SupportedMimeType | null {
  if (!Buffer.isBuffer(header) || header.length < 3) {
    return null;
  }

  // JPEG: FF D8 FF (first 3 bytes)
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A (first 8 bytes)
  if (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  ) {
    return "image/png";
  }

  // WebP: RIFF (bytes 0-3) + WEBP (bytes 8-11)
  // RIFF = 52 49 46 46; WEBP = 57 45 42 50
  if (
    header.length >= MIN_BYTES_FOR_DETECTION &&
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x57 &&
    header[9] === 0x45 &&
    header[10] === 0x42 &&
    header[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

/**
 * Build the minimum valid magic-byte header for a given MIME type.
 * Exported for use in tests only — do not use in production code.
 *
 * @param mimeType  One of the three supported types.
 * @param totalSize Total buffer size to return (padded with zeros after the magic bytes).
 *                  Defaults to MIN_BYTES_FOR_DETECTION.
 */
export function buildMinimalHeader(
  mimeType: SupportedMimeType,
  totalSize = MIN_BYTES_FOR_DETECTION
): Buffer {
  const buf = Buffer.alloc(totalSize, 0);

  switch (mimeType) {
    case "image/jpeg":
      buf[0] = 0xff;
      buf[1] = 0xd8;
      buf[2] = 0xff;
      break;
    case "image/png":
      buf[0] = 0x89;
      buf[1] = 0x50;
      buf[2] = 0x4e;
      buf[3] = 0x47;
      buf[4] = 0x0d;
      buf[5] = 0x0a;
      buf[6] = 0x1a;
      buf[7] = 0x0a;
      break;
    case "image/webp":
      // RIFF
      buf[0] = 0x52;
      buf[1] = 0x49;
      buf[2] = 0x46;
      buf[3] = 0x46;
      // bytes 4-7: file size (synthetic, not validated)
      buf[4] = 0x00;
      buf[5] = 0x00;
      buf[6] = 0x00;
      buf[7] = 0x00;
      // WEBP
      buf[8] = 0x57;
      buf[9] = 0x45;
      buf[10] = 0x42;
      buf[11] = 0x50;
      break;
  }

  return buf;
}
