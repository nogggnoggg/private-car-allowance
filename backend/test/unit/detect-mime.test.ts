/**
 * Unit tests: magic-byte MIME type detection — PHASE-003-T3
 *
 * Spec §4.2, §9.1, AC-02/03/05 (core security: prevent disguised file extension).
 * All tests use synthetic minimal-header fixtures (no real images) per
 * CLAUDE.md §禁止事項 (only synthetic data in tests).
 *
 * Coverage:
 *   - Each supported format (JPEG/PNG/WebP): accept with correct magic bytes
 *   - Each format with disguised extension (valid extension, wrong magic bytes): reject
 *   - PDF, GIF, BMP, SVG, empty buffer: reject
 *   - Edge cases: buffer too short, null bytes only, text content
 */
import { describe, expect, it } from "vitest";
import { buildMinimalHeader, detectMimeType } from "../../src/attachment/detect-mime.js";

// ───────────────────────────────────────────────────────────────
// Helpers — synthetic magic-byte fixtures
// ───────────────────────────────────────────────────────────────

/** PDF magic bytes: %PDF- = 25 50 44 46 2D */
function pdfHeader(size = 12): Buffer {
  const buf = Buffer.alloc(size, 0);
  buf[0] = 0x25; // %
  buf[1] = 0x50; // P
  buf[2] = 0x44; // D
  buf[3] = 0x46; // F
  buf[4] = 0x2d; // -
  return buf;
}

/** GIF magic bytes: GIF89a = 47 49 46 38 39 61 */
function gifHeader(size = 12): Buffer {
  const buf = Buffer.alloc(size, 0);
  buf[0] = 0x47; // G
  buf[1] = 0x49; // I
  buf[2] = 0x46; // F
  buf[3] = 0x38; // 8
  buf[4] = 0x39; // 9
  buf[5] = 0x61; // a
  return buf;
}

/** BMP magic bytes: BM = 42 4D */
function bmpHeader(size = 12): Buffer {
  const buf = Buffer.alloc(size, 0);
  buf[0] = 0x42; // B
  buf[1] = 0x4d; // M
  return buf;
}

/** Null bytes — represent empty/zero-content files */
function nullBytes(size = 12): Buffer {
  return Buffer.alloc(size, 0);
}

/** Text content — "Hello, World!" */
function textContent(): Buffer {
  return Buffer.from("Hello, World!\n", "utf-8");
}

/** Executable/ELF magic: 7F 45 4C 46 */
function elfHeader(size = 12): Buffer {
  const buf = Buffer.alloc(size, 0);
  buf[0] = 0x7f;
  buf[1] = 0x45; // E
  buf[2] = 0x4c; // L
  buf[3] = 0x46; // F
  return buf;
}

// ───────────────────────────────────────────────────────────────
// Tests: accept valid formats
// ───────────────────────────────────────────────────────────────

describe("detectMimeType — accept valid formats (AC-01)", () => {
  it("detects JPEG from FF D8 FF magic bytes", () => {
    const header = buildMinimalHeader("image/jpeg");
    expect(detectMimeType(header)).toBe("image/jpeg");
  });

  it("detects PNG from 89 50 4E 47 0D 0A 1A 0A magic bytes", () => {
    const header = buildMinimalHeader("image/png");
    expect(detectMimeType(header)).toBe("image/png");
  });

  it("detects WebP from RIFF....WEBP magic bytes", () => {
    const header = buildMinimalHeader("image/webp");
    expect(detectMimeType(header)).toBe("image/webp");
  });

  it("detects JPEG when buffer is larger than minimal header", () => {
    // Real JPEG would have many more bytes
    const largeHeader = Buffer.alloc(1024, 0);
    largeHeader[0] = 0xff;
    largeHeader[1] = 0xd8;
    largeHeader[2] = 0xff;
    largeHeader[3] = 0xe0; // APP0 marker
    expect(detectMimeType(largeHeader)).toBe("image/jpeg");
  });

  it("detects PNG when buffer is larger than minimal header", () => {
    const largeHeader = Buffer.alloc(1024, 0);
    largeHeader[0] = 0x89;
    largeHeader[1] = 0x50;
    largeHeader[2] = 0x4e;
    largeHeader[3] = 0x47;
    largeHeader[4] = 0x0d;
    largeHeader[5] = 0x0a;
    largeHeader[6] = 0x1a;
    largeHeader[7] = 0x0a;
    expect(detectMimeType(largeHeader)).toBe("image/png");
  });

  it("detects WebP with realistic file size bytes in positions 4-7", () => {
    const header = Buffer.alloc(12, 0);
    // RIFF
    header[0] = 0x52;
    header[1] = 0x49;
    header[2] = 0x46;
    header[3] = 0x46;
    // File size (little-endian, e.g. 1234 bytes = 0xD2 0x04 0x00 0x00)
    header[4] = 0xd2;
    header[5] = 0x04;
    header[6] = 0x00;
    header[7] = 0x00;
    // WEBP
    header[8] = 0x57;
    header[9] = 0x45;
    header[10] = 0x42;
    header[11] = 0x50;
    expect(detectMimeType(header)).toBe("image/webp");
  });
});

// ───────────────────────────────────────────────────────────────
// Tests: reject disguised extensions (AC-02 — core security)
// ───────────────────────────────────────────────────────────────

describe("detectMimeType — reject disguised extensions (AC-02, core security)", () => {
  it("rejects PDF content disguised with .jpg extension", () => {
    // Caller would have a file named "receipt.jpg" but it's actually a PDF
    const header = pdfHeader();
    expect(detectMimeType(header)).toBeNull();
  });

  it("rejects PDF content disguised with .png extension", () => {
    const header = pdfHeader();
    expect(detectMimeType(header)).toBeNull();
  });

  it("rejects PDF content disguised with .webp extension", () => {
    const header = pdfHeader();
    expect(detectMimeType(header)).toBeNull();
  });

  it("rejects GIF content disguised with .jpg extension", () => {
    const header = gifHeader();
    expect(detectMimeType(header)).toBeNull();
  });

  it("rejects ELF/executable content disguised with .jpg extension", () => {
    const header = elfHeader();
    expect(detectMimeType(header)).toBeNull();
  });

  it("rejects text content disguised with .jpg extension", () => {
    const header = textContent();
    expect(detectMimeType(header)).toBeNull();
  });

  it("rejects JPEG magic bytes disguised as part of wrong RIFF container (not WEBP)", () => {
    // RIFF header but says "AAAA" instead of "WEBP" at offset 8
    const header = Buffer.alloc(12, 0);
    header[0] = 0x52; // R
    header[1] = 0x49; // I
    header[2] = 0x46; // F
    header[3] = 0x46; // F
    // bytes 4-7: size
    // bytes 8-11: "AAAA" — NOT WEBP
    header[8] = 0x41;
    header[9] = 0x41;
    header[10] = 0x41;
    header[11] = 0x41;
    expect(detectMimeType(header)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────
// Tests: reject unsupported formats (AC-03)
// ───────────────────────────────────────────────────────────────

describe("detectMimeType — reject unsupported formats (AC-03)", () => {
  it("rejects PDF", () => {
    expect(detectMimeType(pdfHeader())).toBeNull();
  });

  it("rejects GIF", () => {
    expect(detectMimeType(gifHeader())).toBeNull();
  });

  it("rejects BMP", () => {
    expect(detectMimeType(bmpHeader())).toBeNull();
  });

  it("rejects text content (SVG-like, XML-like)", () => {
    const svgLike = Buffer.from('<?xml version="1.0"?><svg>', "utf-8");
    expect(detectMimeType(svgLike)).toBeNull();
  });

  it("rejects ELF executable", () => {
    expect(detectMimeType(elfHeader())).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────
// Tests: reject empty / zero-byte / too-short buffers (AC-05)
// ───────────────────────────────────────────────────────────────

describe("detectMimeType — reject empty or zero-byte content (AC-05)", () => {
  it("rejects empty buffer (0 bytes)", () => {
    expect(detectMimeType(Buffer.alloc(0))).toBeNull();
  });

  it("rejects buffer with only 1 byte (too short for any magic)", () => {
    expect(detectMimeType(Buffer.from([0xff]))).toBeNull();
  });

  it("rejects buffer with only 2 bytes (too short for JPEG 3-byte magic)", () => {
    expect(detectMimeType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it("rejects null-byte-only buffer (no valid magic)", () => {
    expect(detectMimeType(nullBytes(12))).toBeNull();
  });

  it("rejects buffer that has JPEG first byte but only 2 bytes total", () => {
    // 0xFF 0xD8 — missing third byte 0xFF
    expect(detectMimeType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────
// Tests: partial / almost-matching magic (edge cases)
// ───────────────────────────────────────────────────────────────

describe("detectMimeType — edge cases (partial magic, wrong byte)", () => {
  it("rejects buffer where only first 2 JPEG bytes match (third byte is wrong)", () => {
    const buf = Buffer.from([0xff, 0xd8, 0x00]); // third byte must be 0xFF
    expect(detectMimeType(buf)).toBeNull();
  });

  it("rejects buffer where PNG magic has one wrong byte", () => {
    const buf = Buffer.alloc(12, 0);
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    buf[4] = 0x0d;
    buf[5] = 0x0a;
    buf[6] = 0x1a;
    buf[7] = 0x00; // should be 0x0A
    expect(detectMimeType(buf)).toBeNull();
  });

  it("rejects buffer where WebP has correct RIFF but wrong at offset 8", () => {
    const buf = Buffer.alloc(12, 0);
    buf[0] = 0x52; // R
    buf[1] = 0x49; // I
    buf[2] = 0x46; // F
    buf[3] = 0x46; // F
    // size bytes 4-7: zeros
    buf[8] = 0x57; // W
    buf[9] = 0x45; // E
    buf[10] = 0x42; // B
    buf[11] = 0x00; // should be 0x50 (P)
    expect(detectMimeType(buf)).toBeNull();
  });

  it("rejects buffer of length 11 (too short for WebP 12-byte check)", () => {
    // WebP needs 12 bytes; 11 should not match WebP
    const buf = Buffer.alloc(11, 0);
    buf[0] = 0x52;
    buf[1] = 0x49;
    buf[2] = 0x46;
    buf[3] = 0x46;
    buf[8] = 0x57;
    buf[9] = 0x45;
    buf[10] = 0x42;
    // buf[11] doesn't exist
    expect(detectMimeType(buf)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────
// Tests: buildMinimalHeader helper (for test utility integrity)
// ───────────────────────────────────────────────────────────────

describe("buildMinimalHeader — test utility correctness", () => {
  it("buildMinimalHeader('image/jpeg') produces correct JPEG magic bytes", () => {
    const buf = buildMinimalHeader("image/jpeg");
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
    expect(buf[2]).toBe(0xff);
  });

  it("buildMinimalHeader('image/png') produces correct PNG magic bytes", () => {
    const buf = buildMinimalHeader("image/png");
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50); // P
    expect(buf[2]).toBe(0x4e); // N
    expect(buf[3]).toBe(0x47); // G
    expect(buf[4]).toBe(0x0d);
    expect(buf[5]).toBe(0x0a);
    expect(buf[6]).toBe(0x1a);
    expect(buf[7]).toBe(0x0a);
  });

  it("buildMinimalHeader('image/webp') produces correct WebP magic bytes", () => {
    const buf = buildMinimalHeader("image/webp");
    // RIFF
    expect(buf[0]).toBe(0x52); // R
    expect(buf[1]).toBe(0x49); // I
    expect(buf[2]).toBe(0x46); // F
    expect(buf[3]).toBe(0x46); // F
    // WEBP
    expect(buf[8]).toBe(0x57); // W
    expect(buf[9]).toBe(0x45); // E
    expect(buf[10]).toBe(0x42); // B
    expect(buf[11]).toBe(0x50); // P
  });

  it("buildMinimalHeader with custom size produces buffer of that size", () => {
    const buf = buildMinimalHeader("image/jpeg", 100);
    expect(buf.length).toBe(100);
    // Magic bytes still correct
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
    expect(buf[2]).toBe(0xff);
  });
});
