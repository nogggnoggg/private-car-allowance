/**
 * Unit tests for storage/local-volume-storage.ts — PHASE-008-T8a (AC-26)
 *
 * Scope (Spec §9.4, §11.2, D6, AC-26):
 *   - Key whitelist is parameterised via constructor option `{ prefixes: string[] }`,
 *     default remains `["att"]` — existing `storage.test.ts` MUST stay untouched
 *     and green (verified separately by `git diff` + full run, not re-asserted here).
 *   - A `rpt`-prefixed instance accepts `rpt/<id>/<suffix>` keys and rejects the
 *     same path-traversal matrix as the existing `att` suite (rerun for `rpt`).
 *   - Cross-instance rejection: an `att`-only instance rejects `rpt/...` keys and
 *     a `rpt`-only instance rejects `att/...` keys (closed prefix set, not open).
 *   - A multi-prefix instance (`["att", "rpt"]`) accepts both — proves the
 *     whitelist is genuinely parameterised, not a hardcoded single value.
 *   - Omitting the constructor's second argument keeps the default `["att"]`
 *     behaviour (mirrors existing storage.test.ts callers unchanged).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalVolumeStorage } from "../../src/storage/local-volume-storage.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "t8a-report-storage-test-"));
}

// The same path-traversal / malformed-key matrix as backend/test/unit/storage.test.ts,
// rewritten for the `rpt` prefix per Spec §11.2 row "storage 前綴".
const TRAVERSAL_MATRIX_RPT: Array<[string, string]> = [
  ["path traversal: ../x", "../x"],
  ["path traversal: rpt/../../x", "rpt/../../x"],
  ["path traversal: rpt/id/../../../etc/passwd", "rpt/id/../../../etc/passwd"],
  ["absolute path (unix)", "/etc/passwd"],
  ["absolute path (windows drive)", "C:\\Windows\\System32"],
  ["absolute path (windows unc)", "\\\\server\\share"],
  ["backslash in key", "rpt\\id\\pdf"],
  ["null byte", "rpt/id\x00/pdf"],
  ["empty string", ""],
  ["leading slash", "/rpt/id/pdf"],
  ["trailing slash", "rpt/id/pdf/"],
  ["just dots", ".."],
  ["just dot", "."],
  ["double dot segment", "rpt/../etc"],
  ["encoded traversal (url-like)", "rpt/%2e%2e/etc"],
  ["newline in key", "rpt/id/p\ndf"],
  ["carriage return in key", "rpt/id/p\rdf"],
  ["tab in key", "rpt/id/p\tdf"],
  ["prefix embedded, not leading", "zzz/rpt/id/pdf"],
  ["prefix as substring (no separator)", "rptXYZ"],
  ["extra leading segment", "a/b/rpt/id/pdf"],
];

// ──────────────────────────────────────────────────────────────────────────
// rpt-only instance: accepts rpt/<id>/<suffix>, rejects the traversal matrix
// ──────────────────────────────────────────────────────────────────────────

describe("LocalVolumeStorage — rpt prefix (key validation, no fs)", () => {
  const storage = new LocalVolumeStorage("/non-existent-root-for-rpt-validation-tests", {
    prefixes: ["rpt"],
  });

  it.each([
    ["rpt/<uuid>/pdf", "rpt/3fa85f64-5717-4562-b3fc-2c963f66afa6/pdf"],
    ["rpt/<uuid>/pdf (short id)", "rpt/abc123/pdf"],
  ])("accepts valid key: %s", async (_label, key) => {
    await expect(storage.exists(key)).resolves.toBe(false); // key valid, file doesn't exist
  });

  it.each(TRAVERSAL_MATRIX_RPT)(
    "AC-26: rpt 前綴之路徑穿越矩陣全數拒絕: %s",
    async (_label, key) => {
      await expect(storage.exists(key)).rejects.toThrow(
        /invalid.*key|key.*invalid|reject|not allowed|illegal/i
      );
    }
  );

  it("AR-3: TRAVERSAL_MATRIX_RPT covers the full 21-row matrix (18 original + 3 anchor/boundary rows)", () => {
    expect(TRAVERSAL_MATRIX_RPT).toHaveLength(21);
  });
});

describe("LocalVolumeStorage — rpt prefix (functional, real tmpdir)", () => {
  let tmpRoot: string;
  let storage: LocalVolumeStorage;

  beforeAll(() => {
    tmpRoot = makeTmpDir();
    storage = new LocalVolumeStorage(tmpRoot, { prefixes: ["rpt"] });
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("put then get returns identical bytes for an rpt key", async () => {
    const key = "rpt/roundtrip001/pdf";
    const data = Buffer.from("%PDF-1.4 fake pdf bytes %%EOF", "utf8");
    await storage.put(key, data, "application/pdf");
    const result = await storage.get(key);
    expect((result as Buffer).equals(data)).toBe(true);
  });

  it("delete then exists returns false for an rpt key", async () => {
    const key = "rpt/delete001/pdf";
    await storage.put(key, Buffer.from("delete me"), "application/pdf");
    expect(await storage.exists(key)).toBe(true);
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Cross-instance rejection: closed prefix set, not open / shared
// ──────────────────────────────────────────────────────────────────────────

describe("AC-26: 附件實例拒 rpt 金鑰、報表實例拒 att 金鑰（跨實例互拒）", () => {
  it("an att-only instance rejects rpt/ keys", async () => {
    const attStorage = new LocalVolumeStorage("/non-existent-root-cross-1", {
      prefixes: ["att"],
    });
    await expect(attStorage.exists("rpt/abc123/pdf")).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });

  it("a rpt-only instance rejects att/ keys", async () => {
    const rptStorage = new LocalVolumeStorage("/non-existent-root-cross-2", {
      prefixes: ["rpt"],
    });
    await expect(rptStorage.exists("att/abc123/original")).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });

  it("a default (no options) instance behaves exactly like an explicit att-only instance: rejects rpt/ keys", async () => {
    const defaultStorage = new LocalVolumeStorage("/non-existent-root-cross-3");
    await expect(defaultStorage.exists("rpt/abc123/pdf")).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Multi-prefix instance: proves the whitelist is a genuine parameter, not a
// hardcoded single value with a different name.
// ──────────────────────────────────────────────────────────────────────────

describe("LocalVolumeStorage — multi-prefix instance accepts every configured prefix", () => {
  const storage = new LocalVolumeStorage("/non-existent-root-for-multi-prefix-tests", {
    prefixes: ["att", "rpt"],
  });

  it("accepts an att/ key", async () => {
    await expect(storage.exists("att/abc123/original")).resolves.toBe(false);
  });

  it("accepts a rpt/ key", async () => {
    await expect(storage.exists("rpt/abc123/pdf")).resolves.toBe(false);
  });

  it("still rejects a prefix outside the configured set", async () => {
    await expect(storage.exists("xyz/abc123/other")).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });

  it.each([
    ["prefix embedded, not leading", "zzz/rpt/id/pdf"],
    ["prefix as substring (no separator)", "attXYZ"],
    ["extra leading segment", "a/b/rpt/id/pdf"],
  ])("rejects malformed multi-prefix key: %s", async (_label, key) => {
    await expect(storage.exists(key)).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// AR-1: escapeRegExp correctness — a prefix containing a regex special char
// (".") must be matched literally, not as a regex wildcard.
// ──────────────────────────────────────────────────────────────────────────

describe("LocalVolumeStorage — prefix regex-escaping (AR-1: escapeRegExp correctness)", () => {
  const storage = new LocalVolumeStorage("/non-existent-root-for-escape-test", {
    prefixes: ["a.t"],
  });

  it("rejects abt/x/y (literal '.' must not act as a regex wildcard)", async () => {
    await expect(storage.exists("abt/x/y")).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });

  it("accepts a.t/x/y (literal dot prefix matches exactly)", async () => {
    await expect(storage.exists("a.t/x/y")).resolves.toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Default parameter: constructor's second argument omitted → prefixes ["att"]
// ──────────────────────────────────────────────────────────────────────────

describe('LocalVolumeStorage — default prefixes parameter stays ["att"]', () => {
  it("omitting the options argument accepts att/ keys (mirrors existing storage.test.ts callers)", async () => {
    const storage = new LocalVolumeStorage("/non-existent-root-for-default-param-test");
    await expect(storage.exists("att/abc123/original")).resolves.toBe(false);
  });

  it("omitting the options argument rejects rpt/ keys", async () => {
    const storage = new LocalVolumeStorage("/non-existent-root-for-default-param-test-2");
    await expect(storage.exists("rpt/abc123/pdf")).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });

  it('passing an explicit empty options object ({}) still defaults to ["att"]', async () => {
    const storage = new LocalVolumeStorage("/non-existent-root-for-default-param-test-3", {});
    await expect(storage.exists("att/abc123/original")).resolves.toBe(false);
    await expect(storage.exists("rpt/abc123/pdf")).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });
});
