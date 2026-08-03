/**
 * Integration tests for PHASE-005a-T3:
 *   Fuel price version API — per fuel type (create + list)
 *
 * TDD: written BEFORE route registration — expect RED first, then GREEN
 * after `fuel-price-service.ts` + `routes.ts` registration land.
 *
 * Spec §2.A（PHASE-005a.md）:
 *   AC-01 依油種建立油價版本 — 201 + DTO，四油種皆可各自建立
 *   AC-02 同油種重疊拒絕並指出衝突 — 409 PARAMETER_PERIOD_OVERLAP + details.conflictVersion；
 *         並發衝突亦須回 409 而非 500（DB @@unique 最後防線）
 *   AC-03 跨油種時間軸互相獨立 — 四油種同一 effectiveFrom 皆可 201
 *   AC-05 油種列舉封閉 — 非四項列舉之任何值 → 400 VALIDATION_ERROR fields=[fuelType]，
 *         不得 500、不得建立任何列
 *   AC-06 油價欄位驗證：格式層四道 ＋ 值域層 — 逐字 reason 文案、邊界正例
 *
 * Requires a running Postgres instance with migrations applied.
 * DATABASE_URL env var must be set; tests skip otherwise.
 *
 * Isolation: all rows created here use effectiveFrom in sentinel range
 * 2098-01-01..2098-12-31 (distinct from PHASE-003a's 2099-* fuel/etc range
 * and PHASE-005a's own migration-safety fixtures) and loginName prefix
 * "t3fuelprice_"; cleanup is scoped to these, no global deleteMany.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import * as fuelPriceService from "../../src/parameters/fuel-price-service.js";
import * as parameterValidation from "../../src/parameters/parameter-validation.js";
import * as parameterVersionEngine from "../../src/parameters/parameter-version-engine.js";
import { buildServer } from "../../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Blank comments and string/template literals to equal-length whitespace
 * (newlines preserved) so the structural regexes below only ever see real
 * code. Same convention as `test/unit/fuel-price-engine.test.ts` §3
 * (originally `chore003-string-fidelity.test.ts` §1).
 */
function blankCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += blank(src[i]);
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " ";
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += blank(src[i]);
        i++;
      }
      out += " ";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Like `blankCommentsAndStrings` but leaves string/template literal CONTENTS
 * intact — only comments are blanked. Needed for the import-wiring structural
 * checks below: an `import { x } from "./y.js"` line's module-specifier is a
 * string literal, so fully blanking strings (as `blankCommentsAndStrings`
 * does) would erase the very path text `"./parameter-validation.js"` those
 * checks need to see. Comments are still stripped so a stray comment
 * mentioning the same identifiers cannot false-positive the match.
 */
function blankCommentsOnly(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += blank(src[i]);
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0];
}

async function loginUser(
  app: FastifyInstance,
  loginName: string,
  password: string
): Promise<string> {
  const resp = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { loginName, password },
  });
  if (resp.statusCode !== 200) {
    throw new Error(`Login failed with status ${resp.statusCode}: ${resp.body}`);
  }
  return extractCookieHeader(resp.headers["set-cookie"]);
}

const SUFFIX = Date.now();
const PASSWORD = "AdminTest99!";

const ADMIN_LOGIN = `t3fuelprice_admin_${SUFFIX}`;
const USER_LOGIN = `t3fuelprice_user_${SUFFIX}`;
const MCP_ADMIN_LOGIN = `t3fuelprice_mcp_${SUFFIX}`;

// Sentinel effectiveFrom range for cleanup isolation (distinct from other test files)
const DATE_PREFIX_START = new Date("2098-01-01");
const DATE_PREFIX_END = new Date("2098-12-31");

interface TestUsers {
  adminId: string;
  userId: string;
  mcpAdminId: string;
}

async function setupUsers(prisma: PrismaClient): Promise<TestUsers> {
  const hash = await hashPassword(PASSWORD);

  const admin = await prisma.user.create({
    data: {
      loginName: ADMIN_LOGIN,
      displayName: "T3 FuelPrice Admin",
      passwordHash: hash,
      role: "ADMIN",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const user = await prisma.user.create({
    data: {
      loginName: USER_LOGIN,
      displayName: "T3 FuelPrice Normal User",
      passwordHash: hash,
      role: "USER",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const mcpAdmin = await prisma.user.create({
    data: {
      loginName: MCP_ADMIN_LOGIN,
      displayName: "T3 FuelPrice MCP Admin",
      passwordHash: hash,
      role: "ADMIN",
      isActive: true,
      mustChangePassword: true,
    },
  });

  return { adminId: admin.id, userId: user.id, mcpAdminId: mcpAdmin.id };
}

async function cleanupAll(prisma: PrismaClient, userIds: string[]): Promise<void> {
  await prisma.fuelPriceVersion.deleteMany({
    where: {
      effectiveFrom: {
        gte: DATE_PREFIX_START,
        lte: DATE_PREFIX_END,
      },
    },
  });

  if (userIds.length > 0) {
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({
      where: {
        OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }],
      },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

const FOUR_FUEL_TYPES = ["GASOLINE_92", "GASOLINE_95", "GASOLINE_98", "DIESEL"] as const;

// ---------------------------------------------------------------------------
// §0 複用實證（import 斷言）— Done When #2
// ---------------------------------------------------------------------------

describe("PHASE-005a-T3 複用實證 — service must import shared validation/overlap functions, not reimplement them", () => {
  const SERVICE_SRC_PATH = path.resolve(BACKEND_ROOT, "src/parameters/fuel-price-service.ts");
  const rawServiceSource = fs.readFileSync(SERVICE_SRC_PATH, "utf8");
  // Comments-only blanking: import module-specifiers are string literals, so
  // fully blanking strings (blankCommentsAndStrings) would erase the very
  // path text these checks need to see; blankCommentsOnly strips comments
  // (avoiding false positives from a stray comment mentioning the same
  // identifiers) while preserving the real import statement text.
  const importCheckSource = blankCommentsOnly(rawServiceSource);
  const blankedServiceSource = blankCommentsAndStrings(rawServiceSource);

  // Import-wiring proof: the SOURCE TEXT of fuel-price-service.ts must itself
  // contain an `import { parseParameterDecimalField, ... } from
  // "./parameter-validation.js"` (and equivalently for checkNoOverlap). This
  // is a real structural check on the file's own code — unlike the
  // pre-fix version of this test, it actually reads and parses
  // fuel-price-service.ts's source rather than only checking runtime
  // module exports (which cannot distinguish "imports the shared function"
  // from "happens to export a same-named private copy").
  const IMPORT_VALIDATION_PATTERN =
    /import\s*(?:type\s*)?\{[^}]*\bparseParameterDecimalField\b[^}]*\}\s*from\s*"\.\/parameter-validation\.js"/;
  const IMPORT_OVERLAP_PATTERN =
    /import\s*(?:type\s*)?\{[^}]*\bcheckNoOverlap\b[^}]*\}\s*from\s*"\.\/parameter-version-engine\.js"/;
  // A private reimplementation of the format gate would need its own
  // anchored decimal-format regex literal (e.g. /^\d{1,6}(\.\d{1,4})?$/-shaped).
  // The real file must contain none — the format gate is entirely delegated
  // to parseParameterDecimalField.
  const ANCHORED_REGEX_LITERAL_PATTERN = /\/\^[^/\n]*\$\//g;

  it("fuel-price-service.ts re-exports/uses parameter-validation.ts's parseParameterDecimalField and UNIT_PRICE_CAPACITY (not a private reimplementation)", () => {
    expect(typeof parameterValidation.parseParameterDecimalField).toBe("function");
    expect(parameterValidation.UNIT_PRICE_CAPACITY).toEqual({ scale: 4, integerDigits: 6 });
    expect(typeof fuelPriceService.createFuelPriceVersion).toBe("function");
  });

  it("checkNoOverlap (parameter-version-engine.ts) is a pure function usable independently — sanity import check", () => {
    expect(typeof parameterVersionEngine.checkNoOverlap).toBe("function");
    const result = parameterVersionEngine.checkNoOverlap(
      [{ id: "x", effectiveFrom: "2098-06-01" }],
      "2098-06-01"
    );
    expect(result.ok).toBe(false);
  });

  it("Structural proof (M-1): fuel-price-service.ts's own source imports parseParameterDecimalField from parameter-validation.ts (not a private copy)", () => {
    expect(importCheckSource).toMatch(IMPORT_VALIDATION_PATTERN);
  });

  it("Structural proof (M-1): fuel-price-service.ts's own source imports checkNoOverlap from parameter-version-engine.ts (not a private copy)", () => {
    expect(importCheckSource).toMatch(IMPORT_OVERLAP_PATTERN);
  });

  it("Negative control (M-1): fuel-price-service.ts defines no anchored decimal-format regex literal of its own (would indicate a private reimplementation of the format gate)", () => {
    expect([...blankedServiceSource.matchAll(ANCHORED_REGEX_LITERAL_PATTERN)]).toEqual([]);
  });

  it("Scanner self-proof (M-1 discriminating power): a synthetic mutation that deletes both imports and inlines a private decimal-parsing copy fails every structural-proof assertion above", () => {
    const mutatedSource = blankCommentsAndStrings(
      [
        'import type { Prisma, PrismaClient } from "@prisma/client";',
        'import { FuelType } from "@prisma/client";',
        "// import removed: parseParameterDecimalField/UNIT_PRICE_CAPACITY reimplemented privately below",
        "const UNIT_PRICE_CAPACITY = { scale: 4, integerDigits: 6 };",
        "function parseParameterDecimalField(value, field, capacity) {",
        "  const DECIMAL_PATTERN = /^\\d{1,6}(\\.\\d{1,4})?$/;",
        "  return { ok: true, value };",
        "}",
        "function checkNoOverlap(existing, effectiveFrom) {",
        "  return { ok: true };",
        "}",
      ].join("\n")
    );
    expect(mutatedSource).not.toMatch(IMPORT_VALIDATION_PATTERN);
    expect(mutatedSource).not.toMatch(IMPORT_OVERLAP_PATTERN);
    expect([...mutatedSource.matchAll(ANCHORED_REGEX_LITERAL_PATTERN)].length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AR-2（Review）: P2002 branch is not guaranteed to be hit by the concurrent
// HTTP test below (race outcome is non-deterministic under `Promise.all`).
// This stub test forces the branch deterministically via a fake `prisma`
// whose `tx.fuelPriceVersion.create` throws a P2002-shaped error, and
// asserts `createFuelPriceVersion` translates it to 409
// PARAMETER_PERIOD_OVERLAP rather than letting it propagate as a 500.
// ---------------------------------------------------------------------------

describe("PHASE-005a-T3 AR-2 stub — P2002 unique-constraint branch is deterministically covered", () => {
  it("tx.fuelPriceVersion.create() rejecting with a P2002-shaped error is translated to AppError PARAMETER_PERIOD_OVERLAP (httpStatus 409), never left to propagate as a 500", async () => {
    const fakeTx = {
      fuelPriceVersion: {
        findMany: async () => [],
        create: async () => {
          throw { code: "P2002" };
        },
      },
    };
    const fakePrisma = {
      $transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
    } as unknown as PrismaClient;

    await expect(
      fuelPriceService.createFuelPriceVersion(fakePrisma, {
        fuelType: "GASOLINE_95",
        pricePerLiter: "30.0000",
        effectiveFrom: "2098-03-01",
        createdById: "stub-user-id",
      })
    ).rejects.toMatchObject({
      code: "PARAMETER_PERIOD_OVERLAP",
      httpStatus: 409,
    });
  });
});

// ---------------------------------------------------------------------------
// AC-01 / AC-03: create per fuel type, four fuel types share the same date
// ---------------------------------------------------------------------------

describeWithDb("POST /parameters/fuel-price", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let users: TestUsers;
  let adminCookie: string;
  let userCookie: string;
  let mcpCookie: string;

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    users = await setupUsers(prisma);
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    adminCookie = await loginUser(app, ADMIN_LOGIN, PASSWORD);
    userCookie = await loginUser(app, USER_LOGIN, PASSWORD);
    mcpCookie = await loginUser(app, MCP_ADMIN_LOGIN, PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await cleanupAll(prisma, [users.adminId, users.userId, users.mcpAdminId]);
      await prisma.$disconnect();
    }
  });

  it("AC-01 建立油價版本 > creates a version for each of the four fuel types (201, DTO shape key by key)", async () => {
    for (const fuelType of FOUR_FUEL_TYPES) {
      const resp = await app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        headers: { cookie: adminCookie },
        payload: { fuelType, pricePerLiter: "30.0000", effectiveFrom: "2098-01-01" },
      });
      expect(resp.statusCode).toBe(201);
      const body = resp.json<{ version: Record<string, unknown> }>();
      expect(body.version.id).toBeDefined();
      expect(body.version.fuelType).toBe(fuelType);
      expect(String(body.version.pricePerLiter)).toBe("30.0000");
      expect(body.version.effectiveFrom).toBe("2098-01-01");
      expect(body.version.createdAt).toBeDefined();
      expect(body.version.createdById).toBeUndefined();
      // DB row exists for this fuel type
      const row = await prisma.fuelPriceVersion.findFirst({
        where: { fuelType: fuelType as never, effectiveFrom: new Date("2098-01-01") },
      });
      expect(row).not.toBeNull();
    }
  });

  it("AC-03 跨油種時間軸獨立 > all four fuel types may share the same effectiveFrom (201 each)", async () => {
    const results: number[] = [];
    for (const fuelType of FOUR_FUEL_TYPES) {
      const resp = await app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        headers: { cookie: adminCookie },
        payload: { fuelType, pricePerLiter: "25.0000", effectiveFrom: "2098-02-01" },
      });
      results.push(resp.statusCode);
    }
    expect(results).toEqual([201, 201, 201, 201]);

    const rows = await prisma.fuelPriceVersion.findMany({
      where: { effectiveFrom: new Date("2098-02-01") },
    });
    expect(rows.length).toBe(4);
    expect(new Set(rows.map((r) => r.fuelType)).size).toBe(4);
  });

  it("AC-03 跨油種時間軸獨立 > four concurrent effective versions coexist and are independently retrievable", async () => {
    const responses = await Promise.all(
      FOUR_FUEL_TYPES.map((fuelType) =>
        app.inject({
          method: "POST",
          url: "/parameters/fuel-price",
          headers: { cookie: adminCookie },
          payload: { fuelType, pricePerLiter: "26.0000", effectiveFrom: "2098-02-15" },
        })
      )
    );
    expect(responses.map((r) => r.statusCode)).toEqual([201, 201, 201, 201]);

    const listResp = await app.inject({
      method: "GET",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
    });
    const body = listResp.json<{ versions: Record<string, unknown>[] }>();
    const matching = body.versions.filter((v) => v.effectiveFrom === "2098-02-15");
    expect(matching.length).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // AC-02 同油種重疊拒絕
  // ---------------------------------------------------------------------------

  it("AC-02 同油種重疊 > same fuelType + same effectiveFrom returns 409 with details.conflictVersion", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "GASOLINE_95", pricePerLiter: "30.0000", effectiveFrom: "2098-03-01" },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{ version: { id: string } }>();

    const second = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "GASOLINE_95", pricePerLiter: "31.0000", effectiveFrom: "2098-03-01" },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json<{
      error: {
        code: string;
        details?: { conflictVersion?: { id: string; effectiveFrom: string } };
      };
    }>();
    expect(body.error.code).toBe("PARAMETER_PERIOD_OVERLAP");
    expect(body.error.details?.conflictVersion?.id).toBe(firstBody.version.id);
    expect(body.error.details?.conflictVersion?.effectiveFrom).toBe("2098-03-01");
  });

  it("AC-02 同油種重疊 > a DIFFERENT fuelType with the same effectiveFrom is unaffected by the conflict above (cross-check AC-03)", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "DIESEL", pricePerLiter: "20.0000", effectiveFrom: "2098-03-01" },
    });
    expect(resp.statusCode).toBe(201);
  });

  it("AC-02 同油種重疊 > concurrent duplicate create resolves to exactly one 201 and one 409 (never 500)", async () => {
    const [r1, r2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        headers: { cookie: adminCookie },
        payload: { fuelType: "GASOLINE_98", pricePerLiter: "1", effectiveFrom: "2098-03-10" },
      }),
      app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        headers: { cookie: adminCookie },
        payload: { fuelType: "GASOLINE_98", pricePerLiter: "2", effectiveFrom: "2098-03-10" },
      }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const failed = r1.statusCode === 409 ? r1 : r2;
    expect(failed.json<{ error: { code: string } }>().error.code).toBe("PARAMETER_PERIOD_OVERLAP");
  });

  // ---------------------------------------------------------------------------
  // AC-05 油種列舉封閉
  // ---------------------------------------------------------------------------

  const invalidFuelTypes: { label: string; value: unknown }[] = [
    { label: '"GASOLINE_91" (unknown enum-shaped string)', value: "GASOLINE_91" },
    { label: '"98" (bare number-as-string)', value: "98" },
    { label: '"" (empty string)', value: "" },
    { label: "null", value: null },
    { label: "42 (number)", value: 42 },
    { label: "{} (object)", value: {} },
    { label: "[] (array)", value: [] },
  ];

  it.each(invalidFuelTypes)(
    "AC-05 油種列舉封閉 > fuelType=$label returns 400 locating fuelType (never 500)",
    async ({ value }) => {
      const resp = await app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        headers: { cookie: adminCookie },
        payload: { fuelType: value, pricePerLiter: "30.0000", effectiveFrom: "2098-04-01" },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.fields?.some((f) => f.field === "fuelType")).toBe(true);

      // must not create any row
      const rows = await prisma.fuelPriceVersion.findMany({
        where: { effectiveFrom: new Date("2098-04-01") },
      });
      expect(rows.length).toBe(0);
    }
  );

  it("AC-05 油種列舉封閉 > missing fuelType field returns 400 locating fuelType", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { pricePerLiter: "30.0000", effectiveFrom: "2098-04-02" },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.fields?.some((f) => f.field === "fuelType")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC-06 油價欄位驗證：格式層四道 ＋ 值域層（順序決定 reason）
  // ---------------------------------------------------------------------------

  const orderedGateTable: {
    label: string;
    value: unknown;
    expectedReason: string;
  }[] = [
    {
      label: "true (not string/number)",
      value: true,
      expectedReason: "必須為有效的數值（字串或數字）",
    },
    {
      label: "[] (not string/number)",
      value: [],
      expectedReason: "必須為有效的數值（字串或數字）",
    },
    {
      label: "{} (not string/number)",
      value: {},
      expectedReason: "必須為有效的數值（字串或數字）",
    },
    {
      label: "null (not string/number)",
      value: null,
      expectedReason: "必須為有效的數值（字串或數字）",
    },
    { label: '"" (empty string)', value: "", expectedReason: "必須為有效的數值" },
    { label: '"   " (all whitespace)', value: "   ", expectedReason: "必須為有效的數值" },
    {
      label: '"1e5" (exponent literal)',
      value: "1e5",
      expectedReason: "必須為有效的十進位數值（不接受指數記號）",
    },
    {
      label: '".5" (missing integer part)',
      value: ".5",
      expectedReason: "必須為有效的十進位數值（不接受指數記號）",
    },
    {
      label: '"19." (missing fractional part)',
      value: "19.",
      expectedReason: "必須為有效的十進位數值（不接受指數記號）",
    },
    {
      label: '"+19.9" (leading plus)',
      value: "+19.9",
      expectedReason: "必須為有效的十進位數值（不接受指數記號）",
    },
    {
      label: '"0x10" (hex literal)',
      value: "0x10",
      expectedReason: "必須為有效的十進位數值（不接受指數記號）",
    },
    {
      label: '"Infinity"',
      value: "Infinity",
      expectedReason: "必須為有效的十進位數值（不接受指數記號）",
    },
    { label: '"NaN"', value: "NaN", expectedReason: "必須為有效的十進位數值（不接受指數記號）" },
    { label: '"abc"', value: "abc", expectedReason: "必須為有效的十進位數值（不接受指數記號）" },
    {
      label: '"1.23456" (5 decimal places, >4)',
      value: "1.23456",
      expectedReason: "最多允許 4 位小數",
    },
    {
      label: '"1000000" (magnitude ≥ 1e6)',
      value: "1000000",
      expectedReason: "數值超出可儲存範圍（整數部分最多 6 位）",
    },
    { label: "-1 (negative)", value: -1, expectedReason: "單價不得小於 0" },
  ];

  it.each(orderedGateTable)(
    "AC-06 油價欄位驗證（格式層四道＋值域） > ordered gate table: $label returns its own reason",
    async ({ value, expectedReason }) => {
      const resp = await app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "GASOLINE_92",
          pricePerLiter: value,
          effectiveFrom: "2098-05-01",
        },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{
        error: { code: string; fields?: { field: string; reason: string }[] };
      }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      const field = body.error.fields?.find((f) => f.field === "pricePerLiter");
      expect(field).toBeDefined();
      expect(field?.reason).toBe(expectedReason);
    }
  );

  const boundaryPositives: { label: string; value: unknown; effectiveFrom: string }[] = [
    { label: "0 (number zero)", value: 0, effectiveFrom: "2098-06-10" },
    {
      label: '"999999.9999" (max magnitude, 4 dp)',
      value: "999999.9999",
      effectiveFrom: "2098-06-11",
    },
    {
      label: '" 30.5 " (leading/trailing whitespace, trimmed)',
      value: " 30.5 ",
      effectiveFrom: "2098-06-12",
    },
  ];

  it.each(boundaryPositives)(
    "AC-06 油價欄位驗證（格式層四道＋值域） > boundary positive: $label is accepted (201)",
    async ({ value, effectiveFrom }) => {
      const resp = await app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        headers: { cookie: adminCookie },
        payload: { fuelType: "GASOLINE_92", pricePerLiter: value, effectiveFrom },
      });
      expect(resp.statusCode).toBe(201);
    }
  );

  // ---------------------------------------------------------------------------
  // effectiveFrom validation (shared contract, not a numbered AC in §2.A but
  // required by §7.5 error contract table)
  // ---------------------------------------------------------------------------

  it("missing effectiveFrom → 400 VALIDATION_ERROR fields=[effectiveFrom]", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "GASOLINE_92", pricePerLiter: "10.0000" },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.fields?.some((f) => f.field === "effectiveFrom")).toBe(true);
  });

  it("invalid effectiveFrom='2098-13-01' → 400 VALIDATION_ERROR fields=[effectiveFrom]", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "GASOLINE_92", pricePerLiter: "10.0000", effectiveFrom: "2098-13-01" },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.fields?.some((f) => f.field === "effectiveFrom")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Authorization matrix (subset relevant to T3; full 15-cell matrix is T5/AC-36)
  // ---------------------------------------------------------------------------

  it("USER role → 403 FORBIDDEN on POST /parameters/fuel-price", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: userCookie },
      payload: { fuelType: "GASOLINE_92", pricePerLiter: "10.0000", effectiveFrom: "2098-07-01" },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
  });

  it("unauthenticated → 401 UNAUTHORIZED on POST /parameters/fuel-price", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      payload: { fuelType: "GASOLINE_92", pricePerLiter: "10.0000", effectiveFrom: "2098-07-01" },
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  it("mustChangePassword admin → 403 PASSWORD_CHANGE_REQUIRED on POST /parameters/fuel-price", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: mcpCookie },
      payload: { fuelType: "GASOLINE_92", pricePerLiter: "10.0000", effectiveFrom: "2098-07-01" },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  // ---------------------------------------------------------------------------
  // AuditLog (比照 PHASE-003a 慣例；完整稽核合約屬 T5，本測試僅驗證 T3 建立
  // 路徑確實寫入一列，action 沿用既有 PARAMETER_VERSION_CREATED)
  // ---------------------------------------------------------------------------

  it("successful create writes one AuditLog row with action=PARAMETER_VERSION_CREATED and parameterType=FUEL_PRICE", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "GASOLINE_95", pricePerLiter: "12.3400", effectiveFrom: "2098-08-01" },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ version: { id: string } }>();

    const logs = await prisma.auditLog.findMany({
      where: { targetLabel: `FUEL_PRICE#${body.version.id}` },
    });
    expect(logs.length).toBe(1);
    expect(logs[0].action).toBe("PARAMETER_VERSION_CREATED");
    expect(logs[0].actorId).toBe(users.adminId);
    const summary = logs[0].summary as Record<string, unknown>;
    expect(summary.parameterType).toBe("FUEL_PRICE");
    expect(summary.fuelType).toBe("GASOLINE_95");
    // must never contain password/token/cookie substrings
    const serialized = JSON.stringify(logs[0]);
    expect(serialized.toLowerCase()).not.toContain("password");
    expect(serialized.toLowerCase()).not.toContain("token");
  });
});

// ---------------------------------------------------------------------------
// GET /parameters/fuel-price
// ---------------------------------------------------------------------------

describeWithDb("GET /parameters/fuel-price", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let users: TestUsers;
  let adminCookie: string;
  let userCookie: string;
  let mcpCookie: string;

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    users = await setupUsers(prisma);
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    adminCookie = await loginUser(app, ADMIN_LOGIN, PASSWORD);
    userCookie = await loginUser(app, USER_LOGIN, PASSWORD);
    mcpCookie = await loginUser(app, MCP_ADMIN_LOGIN, PASSWORD);

    // Seed: two fuel types, two dates each
    await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "GASOLINE_92", pricePerLiter: "28.0000", effectiveFrom: "2098-09-05" },
    });
    await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "GASOLINE_92", pricePerLiter: "27.0000", effectiveFrom: "2098-09-01" },
    });
    await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "DIESEL", pricePerLiter: "22.0000", effectiveFrom: "2098-09-01" },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await cleanupAll(prisma, [users.adminId, users.userId, users.mcpAdminId]);
      await prisma.$disconnect();
    }
  });

  it("returns all versions across fuel types when fuelType not specified", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ versions: Record<string, unknown>[] }>();
    const sentinel = body.versions.filter(
      (v) =>
        typeof v.effectiveFrom === "string" &&
        v.effectiveFrom >= "2098-09-01" &&
        v.effectiveFrom <= "2098-09-30"
    );
    expect(sentinel.length).toBe(3);
  });

  it("filters by fuelType query param, sorted by effectiveFrom ascending", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/fuel-price?fuelType=GASOLINE_92",
      headers: { cookie: adminCookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ versions: { fuelType: string; effectiveFrom: string }[] }>();
    const sentinel = body.versions.filter(
      (v) => v.effectiveFrom >= "2098-09-01" && v.effectiveFrom <= "2098-09-30"
    );
    expect(sentinel.length).toBe(2);
    expect(sentinel.every((v) => v.fuelType === "GASOLINE_92")).toBe(true);
    expect(sentinel[0].effectiveFrom).toBe("2098-09-01");
    expect(sentinel[1].effectiveFrom).toBe("2098-09-05");
  });

  it("fuelType query param with a non-enum value → 400 VALIDATION_ERROR (never 500)", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/fuel-price?fuelType=GASOLINE_91",
      headers: { cookie: adminCookie },
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it("AR-4 duplicate fuelType query key (?fuelType=GASOLINE_95&fuelType=DIESEL) → 400 VALIDATION_ERROR (never 500)", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/fuel-price?fuelType=GASOLINE_95&fuelType=DIESEL",
      headers: { cookie: adminCookie },
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it("USER role → 403 FORBIDDEN on GET /parameters/fuel-price", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/fuel-price",
      headers: { cookie: userCookie },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
  });

  it("unauthenticated → 401 on GET /parameters/fuel-price", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/fuel-price",
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  it("mustChangePassword admin → 403 on GET /parameters/fuel-price", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/fuel-price",
      headers: { cookie: mcpCookie },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });
});
