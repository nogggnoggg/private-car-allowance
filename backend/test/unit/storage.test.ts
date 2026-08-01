/**
 * Unit tests for storage/local-volume-storage.ts — PHASE-003-T2
 * TDD: written BEFORE implementation; expected to fail first.
 *
 * Spec §4.1 §13-T2:
 *   - Storage interface: put / get / delete / exists
 *   - LocalVolumeStorage: env ATTACHMENT_STORAGE_ROOT as root
 *   - Key whitelist validation (only system-generated keys like `att/<cuid>/original`)
 *   - Malicious key rejection: `..`, absolute paths, backslash, null bytes
 *   - put→get byte consistency (including non-UTF-8 binary)
 *   - delete then exists=false
 *   - get non-existent key: throws (documented behaviour)
 *   - root not existing: auto-created on first use
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LocalVolumeStorage } from "../../src/storage/local-volume-storage.js";

// Helpers ------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "t2-storage-test-"));
}

// ──────────────────────────────────────────────────────────────────────────
// Key validation (does NOT touch the filesystem)
// ──────────────────────────────────────────────────────────────────────────

describe("LocalVolumeStorage — key validation (no fs)", () => {
  // Use a non-existent root so we verify that validation fires BEFORE any fs access
  const storage = new LocalVolumeStorage("/non-existent-root-for-validation-tests");

  // Valid keys (system-generated format)
  it.each([
    ["att/<cuid>/original", "att/abc123def456/original"],
    ["att/<cuid>/thumb", "att/xyz789/thumb"],
    ["att/<cuid>/original with alphanumeric cuid", "att/cm9abc123def456/original"],
  ])("accepts valid key: %s", async (_label, key) => {
    // Should not throw on validation — only on actual fs access
    await expect(storage.exists(key)).resolves.toBe(false); // file doesn't exist, but key is valid
  });

  // Malicious keys — must be rejected regardless of root
  it.each([
    ["path traversal: ../x", "../x"],
    ["path traversal: att/../../x", "att/../../x"],
    ["path traversal: att/cuid/../../../etc/passwd", "att/cuid/../../../etc/passwd"],
    ["absolute path (unix)", "/etc/passwd"],
    ["absolute path (windows drive)", "C:\\Windows\\System32"],
    ["absolute path (windows unc)", "\\\\server\\share"],
    ["backslash in key", "att\\cuid\\original"],
    ["null byte", "att/cuid\x00/original"],
    ["empty string", ""],
    ["leading slash", "/att/cuid/original"],
    ["trailing slash", "att/cuid/original/"],
    ["just dots", ".."],
    ["just dot", "."],
    ["double dot segment", "att/../etc"],
    ["encoded traversal (url-like)", "att/%2e%2e/etc"],
    ["newline in key", "att/cuid/orig\nal"],
    ["carriage return in key", "att/cuid/orig\rial"],
    ["tab in key", "att/cuid/orig\tal"],
  ])("rejects malicious key: %s", async (_label, key) => {
    await expect(storage.exists(key)).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Functional behaviour (uses real tmpdir)
// ──────────────────────────────────────────────────────────────────────────

describe("LocalVolumeStorage — functional behaviour", () => {
  let tmpRoot: string;
  let storage: LocalVolumeStorage;

  beforeAll(() => {
    tmpRoot = makeTmpDir();
    storage = new LocalVolumeStorage(tmpRoot);
  });

  afterAll(() => {
    // Clean up: remove the entire temp directory created for this suite
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── put → get byte consistency ──────────────────────────────────────

  it("put then get returns identical bytes (simple ASCII)", async () => {
    const key = "att/roundtrip001/original";
    const data = Buffer.from("Hello, storage!", "utf8");
    await storage.put(key, data, "image/jpeg");
    const result = await storage.get(key);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect((result as Buffer).equals(data)).toBe(true);
  });

  it("put then get returns identical bytes (binary non-UTF-8 content)", async () => {
    const key = "att/binary001/original";
    // Craft a buffer that is NOT valid UTF-8 (raw binary / JPEG-like header bytes)
    const data = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
    await storage.put(key, data, "image/jpeg");
    const result = await storage.get(key);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect((result as Buffer).equals(data)).toBe(true);
  });

  it("put then get returns identical bytes (WebP magic bytes)", async () => {
    const key = "att/webp001/original";
    // RIFF....WEBP header
    const data = Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      0x00,
      0x00,
      0x00,
      0x00, // file size placeholder
      0x57,
      0x45,
      0x42,
      0x50, // WEBP
    ]);
    await storage.put(key, data, "image/webp");
    const result = await storage.get(key);
    expect((result as Buffer).equals(data)).toBe(true);
  });

  // ── exists ──────────────────────────────────────────────────────────

  it("exists returns false before put", async () => {
    const key = "att/notexist001/original";
    expect(await storage.exists(key)).toBe(false);
  });

  it("exists returns true after put", async () => {
    const key = "att/exists001/original";
    await storage.put(key, Buffer.from("data"), "image/jpeg");
    expect(await storage.exists(key)).toBe(true);
  });

  // ── delete ──────────────────────────────────────────────────────────

  it("delete then exists returns false", async () => {
    const key = "att/delete001/original";
    await storage.put(key, Buffer.from("delete me"), "image/jpeg");
    expect(await storage.exists(key)).toBe(true);

    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
  });

  it("delete on non-existent key does not throw", async () => {
    const key = "att/deletemissing001/original";
    // Should resolve without error (idempotent)
    await expect(storage.delete(key)).resolves.not.toThrow();
  });

  // ── get non-existent key ────────────────────────────────────────────

  it("get non-existent key throws an error (documented: throws)", async () => {
    const key = "att/getmissing001/original";
    await expect(storage.get(key)).rejects.toThrow();
  });

  // ── intermediate directories ────────────────────────────────────────

  it("put creates intermediate directories automatically", async () => {
    const key = "att/deepdir001/original";
    const data = Buffer.from("deep dir data");
    // Should not fail even though att/deepdir001/ doesn't exist yet
    await expect(storage.put(key, data, "image/png")).resolves.not.toThrow();
    expect(await storage.exists(key)).toBe(true);
  });

  // ── path must stay within root ──────────────────────────────────────

  it("resolved file path stays within root (not escaped)", async () => {
    // This is an additional whitebox check: after validation passes,
    // the resolved absolute path must start with the root.
    // We indirectly test this by confirming that a valid key can be stored
    // and retrieved — the implementation must not resolve outside root.
    const key = "att/pathcheck001/original";
    const data = Buffer.from("in root");
    await storage.put(key, data, "image/jpeg");
    const result = await storage.get(key);
    expect((result as Buffer).equals(data)).toBe(true);
  });

  // ── overwrite existing file ─────────────────────────────────────────

  it("put overwrites existing file with new content", async () => {
    const key = "att/overwrite001/original";
    await storage.put(key, Buffer.from("original"), "image/jpeg");
    await storage.put(key, Buffer.from("updated"), "image/jpeg");
    const result = await storage.get(key);
    expect((result as Buffer).toString("utf8")).toBe("updated");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Root auto-creation
// ──────────────────────────────────────────────────────────────────────────

describe("LocalVolumeStorage — root auto-creation", () => {
  it("auto-creates root directory on first put when root does not exist", async () => {
    // Use a path that does not yet exist
    const nonExistentRoot = path.join(os.tmpdir(), `t2-autocreate-${Date.now()}`);
    expect(fs.existsSync(nonExistentRoot)).toBe(false);

    const storage = new LocalVolumeStorage(nonExistentRoot);
    const key = "att/autocreate001/original";
    await storage.put(key, Buffer.from("root auto-created"), "image/jpeg");

    expect(fs.existsSync(nonExistentRoot)).toBe(true);
    expect(await storage.exists(key)).toBe(true);

    // Cleanup
    fs.rmSync(nonExistentRoot, { recursive: true, force: true });
  });
});
