/**
 * Integration tests for PHASE-005a-T4:
 *   User fuel-consumption version SERVICE layer — create + list (direct calls)
 *
 * Scope note (Packet PHASE-005a-T4): route registration, the 15-cell
 * authorization matrix, and audit-log writing are T5's responsibility. This
 * file calls `fuel-consumption-service.ts`'s exported functions DIRECTLY
 * against a real Postgres instance — it does NOT go through Fastify/HTTP.
 *
 * TDD: written BEFORE `fuel-consumption-service.ts` existed — first run was
 * RED (module not found / TS compile failure). GREEN after the service
 * landed.
 *
 * Spec §2.B（PHASE-005a.md）:
 *   AC-07 管理員為指定使用者建立油耗版本 — 成功建立、createdById=操作管理員；
 *         userId 不存在 → 404 NOT_FOUND（不洩漏帳號存在與否以外之資訊）
 *   AC-08 油耗 ≤ 0 拒絕並指出欄位 — 0/"0"/-1/"-0.0001" → 400 kmPerLiter
 *         "油耗必須大於 0"；"0.0001" 邊界正例 → 成功
 *   AC-09 依據備註必填 — 缺/null/""/全空白 → 400 basisNote "請填寫核對依據"；
 *         長度 > 500 字（§16 D3(c-1)）→ 400 同欄位
 *   AC-10 同使用者重疊拒絕、跨使用者互不干涉 — 同使用者同 effectiveFrom → 409
 *         PARAMETER_PERIOD_OVERLAP + details.conflictVersion；跨使用者互不
 *         干涉；並發雙寫恰一成功一 409（絕不 500／未捕捉例外）
 *   AC-11 油耗欄位驗證：格式層四道 ＋ 值域層 — 順序與文案沿用 AC-06 六道，
 *         值域層改為「必須大於 0」，必須複用 parseParameterDecimalField
 *
 * Requires a running Postgres instance with migrations applied.
 * DATABASE_URL env var must be set; tests skip otherwise.
 *
 * Isolation: all rows created here use effectiveFrom in sentinel range
 * 2097-01-01..2097-12-31 (distinct from PHASE-003a's 2099-* range and
 * PHASE-005a-T3's 2098-* fuel-price range) and loginName prefix
 * "t4fuelconsumption_"; cleanup is scoped to these, no global deleteMany.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import * as parameterValidation from "../../src/parameters/parameter-validation.js";
import * as parameterVersionEngine from "../../src/parameters/parameter-version-engine.js";
import * as fuelConsumptionService from "../../src/users/fuel-consumption-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Blanking helpers (identical convention to phase5a-fuel-price.test.ts §0 /
// test/unit/fuel-price-engine.test.ts §3 — originally chore003-string-fidelity)
// ---------------------------------------------------------------------------

/** Blank comments and string/template literal CONTENTS to equal-length whitespace. */
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

/** Like `blankCommentsAndStrings` but leaves string/template literal CONTENTS intact — only comments stripped. Needed to see import module-specifiers. */
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

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SUFFIX = Date.now();
const PASSWORD = "AdminTest99!";

const ADMIN_LOGIN = `t4fuelconsumption_admin_${SUFFIX}`;
const TARGET_A_LOGIN = `t4fuelconsumption_targeta_${SUFFIX}`;
const TARGET_B_LOGIN = `t4fuelconsumption_targetb_${SUFFIX}`;
const INACTIVE_LOGIN = `t4fuelconsumption_inactive_${SUFFIX}`;

const DATE_PREFIX_START = new Date("2097-01-01");
const DATE_PREFIX_END = new Date("2097-12-31");

interface TestUsers {
  adminId: string;
  targetAId: string;
  targetBId: string;
  inactiveId: string;
}

async function setupUsers(prisma: PrismaClient): Promise<TestUsers> {
  const hash = await hashPassword(PASSWORD);

  const admin = await prisma.user.create({
    data: {
      loginName: ADMIN_LOGIN,
      displayName: "T4 FuelConsumption Admin",
      passwordHash: hash,
      role: "ADMIN",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const targetA = await prisma.user.create({
    data: {
      loginName: TARGET_A_LOGIN,
      displayName: "T4 FuelConsumption Target A",
      passwordHash: hash,
      role: "USER",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const targetB = await prisma.user.create({
    data: {
      loginName: TARGET_B_LOGIN,
      displayName: "T4 FuelConsumption Target B",
      passwordHash: hash,
      role: "USER",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const inactive = await prisma.user.create({
    data: {
      loginName: INACTIVE_LOGIN,
      displayName: "T4 FuelConsumption Inactive Target",
      passwordHash: hash,
      role: "USER",
      isActive: false,
      mustChangePassword: false,
    },
  });

  return {
    adminId: admin.id,
    targetAId: targetA.id,
    targetBId: targetB.id,
    inactiveId: inactive.id,
  };
}

async function cleanupAll(prisma: PrismaClient, userIds: string[]): Promise<void> {
  await prisma.userFuelConsumptionVersion.deleteMany({
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

// ---------------------------------------------------------------------------
// §0 複用實證（import 斷言）— Done When #2
// ---------------------------------------------------------------------------

describe("PHASE-005a-T4 複用實證 — service must import shared validation/overlap functions, not reimplement them", () => {
  const SERVICE_SRC_PATH = path.resolve(BACKEND_ROOT, "src/users/fuel-consumption-service.ts");
  const rawServiceSource = fs.readFileSync(SERVICE_SRC_PATH, "utf8");
  const importCheckSource = blankCommentsOnly(rawServiceSource);
  const blankedServiceSource = blankCommentsAndStrings(rawServiceSource);

  const IMPORT_VALIDATION_PATTERN =
    /import\s*(?:type\s*)?\{[^}]*\bparseParameterDecimalField\b[^}]*\}\s*from\s*"\.\.\/parameters\/parameter-validation\.js"/;
  const IMPORT_OVERLAP_PATTERN =
    /import\s*(?:type\s*)?\{[^}]*\bcheckNoOverlap\b[^}]*\}\s*from\s*"\.\.\/parameters\/parameter-version-engine\.js"/;
  const ANCHORED_REGEX_LITERAL_PATTERN = /\/\^[^/\n]*\$\//g;

  it("fuel-consumption-service.ts re-exports/uses parameter-validation.ts's parseParameterDecimalField and UNIT_PRICE_CAPACITY (not a private reimplementation)", () => {
    expect(typeof parameterValidation.parseParameterDecimalField).toBe("function");
    expect(parameterValidation.UNIT_PRICE_CAPACITY).toEqual({ scale: 4, integerDigits: 6 });
    expect(typeof fuelConsumptionService.createFuelConsumptionVersion).toBe("function");
  });

  it("checkNoOverlap (parameter-version-engine.ts) is a pure function usable independently — sanity import check", () => {
    expect(typeof parameterVersionEngine.checkNoOverlap).toBe("function");
    const result = parameterVersionEngine.checkNoOverlap(
      [{ id: "x", effectiveFrom: "2097-06-01" }],
      "2097-06-01"
    );
    expect(result.ok).toBe(false);
  });

  it("Structural proof (M-1): fuel-consumption-service.ts's own source imports parseParameterDecimalField from parameter-validation.ts (not a private copy)", () => {
    expect(importCheckSource).toMatch(IMPORT_VALIDATION_PATTERN);
  });

  it("Structural proof (M-1): fuel-consumption-service.ts's own source imports checkNoOverlap from parameter-version-engine.ts (not a private copy)", () => {
    expect(importCheckSource).toMatch(IMPORT_OVERLAP_PATTERN);
  });

  it("Negative control (M-1): fuel-consumption-service.ts defines no anchored decimal-format regex literal of its own (would indicate a private reimplementation of the format gate)", () => {
    expect([...blankedServiceSource.matchAll(ANCHORED_REGEX_LITERAL_PATTERN)]).toEqual([]);
  });

  it("Scanner self-proof (M-1 discriminating power): a synthetic mutation that deletes both imports and inlines a private decimal-parsing copy fails every structural-proof assertion above, while the real (unmutated) source passes both (paired positive control)", () => {
    const mutatedSource = blankCommentsOnly(
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

    // Positive control (paired): the real, unmutated source MUST match both.
    expect(importCheckSource).toMatch(IMPORT_VALIDATION_PATTERN);
    expect(importCheckSource).toMatch(IMPORT_OVERLAP_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// AR-2-style stub: P2002 branch is not guaranteed to be hit by the concurrent
// test below (race outcome is non-deterministic under Promise.all). This stub
// forces the branch deterministically via a fake prisma whose
// tx.userFuelConsumptionVersion.create throws a P2002-shaped error, and
// asserts createFuelConsumptionVersion translates it to 409
// PARAMETER_PERIOD_OVERLAP rather than letting it propagate as a 500.
// ---------------------------------------------------------------------------

describe("PHASE-005a-T4 P2002 stub — unique-constraint branch is deterministically covered", () => {
  it("tx.userFuelConsumptionVersion.create() rejecting with a P2002-shaped error is translated to AppError PARAMETER_PERIOD_OVERLAP (httpStatus 409), never left to propagate as a 500", async () => {
    const fakeTx = {
      userFuelConsumptionVersion: {
        findMany: async () => [],
        create: async () => {
          throw { code: "P2002" };
        },
      },
    };
    const fakePrisma = {
      user: {
        findUnique: async () => ({ id: "stub-target-user-id" }),
      },
      $transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
    } as unknown as PrismaClient;

    await expect(
      fuelConsumptionService.createFuelConsumptionVersion(fakePrisma, {
        userId: "stub-target-user-id",
        fuelType: "GASOLINE_95",
        kmPerLiter: "12.0000",
        effectiveFrom: "2097-03-01",
        basisNote: "行照核對紀錄",
        createdById: "stub-admin-id",
      })
    ).rejects.toMatchObject({
      code: "PARAMETER_PERIOD_OVERLAP",
      httpStatus: 409,
    });
  });
});

// ---------------------------------------------------------------------------
// Main DB-backed suite
// ---------------------------------------------------------------------------

describeWithDb(
  "fuel-consumption-service.ts — createFuelConsumptionVersion / listFuelConsumptionVersions",
  () => {
    let prisma: PrismaClient;
    let users: TestUsers;

    beforeAll(async () => {
      if (!DB_URL) return;
      prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
      await prisma.$connect();
      users = await setupUsers(prisma);
    });

    afterAll(async () => {
      if (prisma) {
        await cleanupAll(prisma, [
          users.adminId,
          users.targetAId,
          users.targetBId,
          users.inactiveId,
        ]);
        await prisma.$disconnect();
      }
    });

    // -------------------------------------------------------------------------
    // AC-07
    // -------------------------------------------------------------------------

    it("AC-07 管理員建立油耗版本 > admin creates a version for a target user (createdById = admin, DB row exists)", async () => {
      const dto = await fuelConsumptionService.createFuelConsumptionVersion(prisma, {
        userId: users.targetAId,
        fuelType: "GASOLINE_95",
        kmPerLiter: "12.0000",
        effectiveFrom: "2097-01-01",
        basisNote: "依行照核對",
        createdById: users.adminId,
      });

      expect(dto.id).toBeDefined();
      expect(dto.userId).toBe(users.targetAId);
      expect(dto.fuelType).toBe("GASOLINE_95");
      expect(dto.kmPerLiter).toBe("12.0000");
      expect(dto.effectiveFrom).toBe("2097-01-01");
      expect(dto.basisNote).toBe("依行照核對");
      expect(dto.createdById).toBe(users.adminId);

      const row = await prisma.userFuelConsumptionVersion.findUnique({ where: { id: dto.id } });
      expect(row).not.toBeNull();
      expect(row?.userId).toBe(users.targetAId);
      expect(row?.createdById).toBe(users.adminId);
    });

    it("AC-07 管理員建立油耗版本 > allowed for an isActive=false target user (B-12: historical data maintenance)", async () => {
      const dto = await fuelConsumptionService.createFuelConsumptionVersion(prisma, {
        userId: users.inactiveId,
        fuelType: "DIESEL",
        kmPerLiter: "8.0000",
        effectiveFrom: "2097-01-02",
        basisNote: "已停用帳號之歷史油耗資料",
        createdById: users.adminId,
      });
      expect(dto.userId).toBe(users.inactiveId);
    });

    it("AC-07 管理員建立油耗版本 > unknown userId returns 404 NOT_FOUND (never 500, message reveals nothing beyond existence)", async () => {
      await expect(
        fuelConsumptionService.createFuelConsumptionVersion(prisma, {
          userId: "nonexistent-user-id-t4",
          fuelType: "GASOLINE_95",
          kmPerLiter: "12.0000",
          effectiveFrom: "2097-01-03",
          basisNote: "依行照核對",
          createdById: users.adminId,
        })
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        httpStatus: 404,
      });

      const rows = await prisma.userFuelConsumptionVersion.findMany({
        where: { effectiveFrom: new Date("2097-01-03") },
      });
      expect(rows.length).toBe(0);
    });

    // -------------------------------------------------------------------------
    // AC-08 油耗必須大於 0
    // -------------------------------------------------------------------------

    const invalidKmPerLiter: { label: string; value: unknown }[] = [
      { label: "0 (number zero)", value: 0 },
      { label: '"0" (string zero)', value: "0" },
      { label: "-1 (negative)", value: -1 },
      { label: '"-0.0001" (smallest negative)', value: "-0.0001" },
    ];

    it.each(invalidKmPerLiter)(
      "AC-08 油耗必須大於 0 > kmPerLiter=$label returns 400 locating kmPerLiter with reason 油耗必須大於 0 (never 500, no row created)",
      async ({ value }) => {
        await expect(
          fuelConsumptionService.createFuelConsumptionVersion(prisma, {
            userId: users.targetAId,
            fuelType: "GASOLINE_92",
            kmPerLiter: value,
            effectiveFrom: "2097-01-10",
            basisNote: "依行照核對",
            createdById: users.adminId,
          })
        ).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
          httpStatus: 400,
          fields: [{ field: "kmPerLiter", reason: "油耗必須大於 0" }],
        });

        const rows = await prisma.userFuelConsumptionVersion.findMany({
          where: { effectiveFrom: new Date("2097-01-10") },
        });
        expect(rows.length).toBe(0);
      }
    );

    it('AC-08 油耗必須大於 0 > "0.0001" (smallest representable positive) is accepted', async () => {
      const dto = await fuelConsumptionService.createFuelConsumptionVersion(prisma, {
        userId: users.targetAId,
        fuelType: "GASOLINE_92",
        kmPerLiter: "0.0001",
        effectiveFrom: "2097-01-11",
        basisNote: "依行照核對",
        createdById: users.adminId,
      });
      expect(dto.kmPerLiter).toBe("0.0001");
    });

    // -------------------------------------------------------------------------
    // AC-09 依據備註必填
    // -------------------------------------------------------------------------

    const invalidBasisNote: { label: string; value: unknown }[] = [
      { label: "missing field (undefined)", value: undefined },
      { label: "null", value: null },
      { label: '"" (empty string)', value: "" },
      { label: '"   " (all whitespace)', value: "   " },
    ];

    it.each(invalidBasisNote)(
      "AC-09 依據備註必填 > basisNote=$label returns 400 locating basisNote with reason 請填寫核對依據 (no row created)",
      async ({ value }) => {
        await expect(
          fuelConsumptionService.createFuelConsumptionVersion(prisma, {
            userId: users.targetAId,
            fuelType: "GASOLINE_92",
            kmPerLiter: "10.0000",
            effectiveFrom: "2097-01-20",
            basisNote: value,
            createdById: users.adminId,
          })
        ).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
          httpStatus: 400,
          fields: [{ field: "basisNote", reason: "請填寫核對依據" }],
        });

        const rows = await prisma.userFuelConsumptionVersion.findMany({
          where: { effectiveFrom: new Date("2097-01-20") },
        });
        expect(rows.length).toBe(0);
      }
    );

    it("AC-09 依據備註必填 > basisNote of exactly 500 chars is accepted (boundary positive)", async () => {
      const note500 = "核".repeat(500);
      const dto = await fuelConsumptionService.createFuelConsumptionVersion(prisma, {
        userId: users.targetAId,
        fuelType: "GASOLINE_92",
        kmPerLiter: "10.0000",
        effectiveFrom: "2097-01-21",
        basisNote: note500,
        createdById: users.adminId,
      });
      expect(dto.basisNote.length).toBe(500);
    });

    it("AC-09 依據備註必填 > basisNote of 501 chars (over-length) returns 400 locating basisNote (§16 D3(c-1))", async () => {
      const note501 = "核".repeat(501);
      await expect(
        fuelConsumptionService.createFuelConsumptionVersion(prisma, {
          userId: users.targetAId,
          fuelType: "GASOLINE_92",
          kmPerLiter: "10.0000",
          effectiveFrom: "2097-01-22",
          basisNote: note501,
          createdById: users.adminId,
        })
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        httpStatus: 400,
        fields: [{ field: "basisNote" }],
      });

      const rows = await prisma.userFuelConsumptionVersion.findMany({
        where: { effectiveFrom: new Date("2097-01-22") },
      });
      expect(rows.length).toBe(0);
    });

    it("AC-09 依據備註必填 > leading/trailing whitespace is trimmed before storage (B-13)", async () => {
      const dto = await fuelConsumptionService.createFuelConsumptionVersion(prisma, {
        userId: users.targetAId,
        fuelType: "GASOLINE_92",
        kmPerLiter: "10.0000",
        effectiveFrom: "2097-01-23",
        basisNote: "  依行照核對  ",
        createdById: users.adminId,
      });
      expect(dto.basisNote).toBe("依行照核對");
    });

    // -------------------------------------------------------------------------
    // AC-10 同使用者重疊拒絕、跨使用者互不干涉
    // -------------------------------------------------------------------------

    it("AC-10 同使用者重疊 > same user + same effectiveFrom → PARAMETER_PERIOD_OVERLAP with conflictVersion", async () => {
      const first = await fuelConsumptionService.createFuelConsumptionVersion(prisma, {
        userId: users.targetAId,
        fuelType: "GASOLINE_92",
        kmPerLiter: "10.0000",
        effectiveFrom: "2097-02-01",
        basisNote: "依行照核對",
        createdById: users.adminId,
      });

      await expect(
        fuelConsumptionService.createFuelConsumptionVersion(prisma, {
          userId: users.targetAId,
          fuelType: "DIESEL",
          kmPerLiter: "9.0000",
          effectiveFrom: "2097-02-01",
          basisNote: "第二次核對",
          createdById: users.adminId,
        })
      ).rejects.toMatchObject({
        code: "PARAMETER_PERIOD_OVERLAP",
        httpStatus: 409,
        details: { conflictVersion: { id: first.id, effectiveFrom: "2097-02-01" } },
      });
    });

    it("AC-10 跨使用者互不干涉 > different user + same effectiveFrom succeeds", async () => {
      const dto = await fuelConsumptionService.createFuelConsumptionVersion(prisma, {
        userId: users.targetBId,
        fuelType: "GASOLINE_92",
        kmPerLiter: "11.0000",
        effectiveFrom: "2097-02-01",
        basisNote: "使用者 B 核對",
        createdById: users.adminId,
      });
      expect(dto.userId).toBe(users.targetBId);
      expect(dto.effectiveFrom).toBe("2097-02-01");
    });

    it("AC-10 並發雙寫 > concurrent duplicate create for the same user + effectiveFrom resolves to exactly one success and one 409 (never 500/uncaught)", async () => {
      const attempt = (kmPerLiter: string) =>
        fuelConsumptionService.createFuelConsumptionVersion(prisma, {
          userId: users.targetAId,
          fuelType: "GASOLINE_98",
          kmPerLiter,
          effectiveFrom: "2097-02-15",
          basisNote: "並發測試核對",
          createdById: users.adminId,
        });

      const results = await Promise.allSettled([attempt("10.0000"), attempt("11.0000")]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const rejection = rejected[0] as PromiseRejectedResult;
      expect(rejection.reason).toMatchObject({
        code: "PARAMETER_PERIOD_OVERLAP",
        httpStatus: 409,
      });

      const rows = await prisma.userFuelConsumptionVersion.findMany({
        where: { userId: users.targetAId, effectiveFrom: new Date("2097-02-15") },
      });
      expect(rows.length).toBe(1);
    });

    // -------------------------------------------------------------------------
    // AC-11 油耗欄位驗證：格式層四道 ＋ 值域層（同 AC-06 六道，值域改為 >0）
    // -------------------------------------------------------------------------

    const orderedGateTable: {
      label: string;
      value: unknown;
      expectedReason: string;
      effectiveFrom: string;
    }[] = [
      {
        label: "true (not string/number)",
        value: true,
        expectedReason: "必須為有效的數值（字串或數字）",
        effectiveFrom: "2097-03-01",
      },
      {
        label: "[] (not string/number)",
        value: [],
        expectedReason: "必須為有效的數值（字串或數字）",
        effectiveFrom: "2097-03-02",
      },
      {
        label: "{} (not string/number)",
        value: {},
        expectedReason: "必須為有效的數值（字串或數字）",
        effectiveFrom: "2097-03-03",
      },
      {
        label: "null (not string/number)",
        value: null,
        expectedReason: "必須為有效的數值（字串或數字）",
        effectiveFrom: "2097-03-04",
      },
      {
        label: '"" (empty string)',
        value: "",
        expectedReason: "必須為有效的數值",
        effectiveFrom: "2097-03-05",
      },
      {
        label: '"   " (all whitespace)',
        value: "   ",
        expectedReason: "必須為有效的數值",
        effectiveFrom: "2097-03-06",
      },
      {
        label: '"1e1" (exponent literal)',
        value: "1e1",
        expectedReason: "必須為有效的十進位數值（不接受指數記號）",
        effectiveFrom: "2097-03-07",
      },
      {
        label: '".5" (missing integer part)',
        value: ".5",
        expectedReason: "必須為有效的十進位數值（不接受指數記號）",
        effectiveFrom: "2097-03-08",
      },
      {
        label: '"19." (missing fractional part)',
        value: "19.",
        expectedReason: "必須為有效的十進位數值（不接受指數記號）",
        effectiveFrom: "2097-03-09",
      },
      {
        label: '"+19.9" (leading plus)',
        value: "+19.9",
        expectedReason: "必須為有效的十進位數值（不接受指數記號）",
        effectiveFrom: "2097-03-10",
      },
      {
        label: '"0x10" (hex literal)',
        value: "0x10",
        expectedReason: "必須為有效的十進位數值（不接受指數記號）",
        effectiveFrom: "2097-03-11",
      },
      {
        label: '"Infinity"',
        value: "Infinity",
        expectedReason: "必須為有效的十進位數值（不接受指數記號）",
        effectiveFrom: "2097-03-12",
      },
      {
        label: '"NaN"',
        value: "NaN",
        expectedReason: "必須為有效的十進位數值（不接受指數記號）",
        effectiveFrom: "2097-03-13",
      },
      {
        label: '"abc"',
        value: "abc",
        expectedReason: "必須為有效的十進位數值（不接受指數記號）",
        effectiveFrom: "2097-03-14",
      },
      {
        label: '" 15.5 " (whitespace-trimmed, valid literal — control row, not an error case)',
        value: " 15.5 ",
        expectedReason: "__ACCEPT__",
        effectiveFrom: "2097-03-15",
      },
      {
        label: '"1.23456" (5 decimal places, >4)',
        value: "1.23456",
        expectedReason: "最多允許 4 位小數",
        effectiveFrom: "2097-03-16",
      },
      {
        label: '"1000000" (magnitude ≥ 1e6)',
        value: "1000000",
        expectedReason: "數值超出可儲存範圍（整數部分最多 6 位）",
        effectiveFrom: "2097-03-17",
      },
      {
        label: "-1 (negative, range layer)",
        value: -1,
        expectedReason: "油耗必須大於 0",
        effectiveFrom: "2097-03-18",
      },
      {
        label: "0 (zero, range layer)",
        value: 0,
        expectedReason: "油耗必須大於 0",
        effectiveFrom: "2097-03-19",
      },
    ];

    it.each(orderedGateTable)(
      "AC-11 油耗欄位驗證（格式層四道＋值域） > ordered gate table: $label",
      async ({ value, expectedReason, effectiveFrom }) => {
        if (expectedReason === "__ACCEPT__") {
          const dto = await fuelConsumptionService.createFuelConsumptionVersion(prisma, {
            userId: users.targetAId,
            fuelType: "GASOLINE_92",
            kmPerLiter: value,
            effectiveFrom,
            basisNote: "依行照核對",
            createdById: users.adminId,
          });
          expect(dto.kmPerLiter).toBe("15.5000");
          return;
        }

        await expect(
          fuelConsumptionService.createFuelConsumptionVersion(prisma, {
            userId: users.targetAId,
            fuelType: "GASOLINE_92",
            kmPerLiter: value,
            effectiveFrom,
            basisNote: "依行照核對",
            createdById: users.adminId,
          })
        ).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
          httpStatus: 400,
          fields: [{ field: "kmPerLiter", reason: expectedReason }],
        });
      }
    );

    it("AC-11 油耗欄位驗證 > ordered gate table mirrors the parameter contract, with 油耗必須大於 0 as the range-layer reason (mutant tripwire: swapping in AC-06's 單價不得小於 0 wording must fail this test)", async () => {
      await expect(
        fuelConsumptionService.createFuelConsumptionVersion(prisma, {
          userId: users.targetAId,
          fuelType: "GASOLINE_92",
          kmPerLiter: -5,
          effectiveFrom: "2097-03-31",
          basisNote: "依行照核對",
          createdById: users.adminId,
        })
      ).rejects.toMatchObject({
        fields: [{ field: "kmPerLiter", reason: "油耗必須大於 0" }],
      });
    });

    // -------------------------------------------------------------------------
    // effectiveFrom validation (shared contract, same as fuel-price-service.ts)
    // -------------------------------------------------------------------------

    it("missing effectiveFrom → VALIDATION_ERROR fields=[effectiveFrom]", async () => {
      await expect(
        fuelConsumptionService.createFuelConsumptionVersion(prisma, {
          userId: users.targetAId,
          fuelType: "GASOLINE_92",
          kmPerLiter: "10.0000",
          effectiveFrom: undefined,
          basisNote: "依行照核對",
          createdById: users.adminId,
        })
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        httpStatus: 400,
        fields: [{ field: "effectiveFrom" }],
      });
    });

    it("invalid effectiveFrom='2097-13-01' → VALIDATION_ERROR fields=[effectiveFrom]", async () => {
      await expect(
        fuelConsumptionService.createFuelConsumptionVersion(prisma, {
          userId: users.targetAId,
          fuelType: "GASOLINE_92",
          kmPerLiter: "10.0000",
          effectiveFrom: "2097-13-01",
          basisNote: "依行照核對",
          createdById: users.adminId,
        })
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        httpStatus: 400,
        fields: [{ field: "effectiveFrom" }],
      });
    });

    it("unknown fuelType → VALIDATION_ERROR fields=[fuelType] (never 500)", async () => {
      await expect(
        fuelConsumptionService.createFuelConsumptionVersion(prisma, {
          userId: users.targetAId,
          fuelType: "GASOLINE_91",
          kmPerLiter: "10.0000",
          effectiveFrom: "2097-04-01",
          basisNote: "依行照核對",
          createdById: users.adminId,
        })
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        httpStatus: 400,
        fields: [{ field: "fuelType" }],
      });
    });

    // -------------------------------------------------------------------------
    // listFuelConsumptionVersions
    // -------------------------------------------------------------------------

    it("listFuelConsumptionVersions > returns [] for a user with no versions (never 404, never throws)", async () => {
      const extraUser = await prisma.user.create({
        data: {
          loginName: `t4fuelconsumption_empty_${SUFFIX}`,
          displayName: "T4 FuelConsumption Empty",
          passwordHash: await hashPassword(PASSWORD),
          role: "USER",
          isActive: true,
          mustChangePassword: false,
        },
      });
      try {
        const versions = await fuelConsumptionService.listFuelConsumptionVersions(
          prisma,
          extraUser.id
        );
        expect(versions).toEqual([]);
      } finally {
        await prisma.user.delete({ where: { id: extraUser.id } });
      }
    });

    it("listFuelConsumptionVersions > returns this user's versions sorted by effectiveFrom ascending, excluding other users' versions", async () => {
      const versions = await fuelConsumptionService.listFuelConsumptionVersions(
        prisma,
        users.targetAId
      );
      const sentinel = versions.filter(
        (v) => v.effectiveFrom >= "2097-01-01" && v.effectiveFrom <= "2097-01-23"
      );
      expect(sentinel.length).toBeGreaterThan(0);
      expect(sentinel.every((v) => v.userId === users.targetAId)).toBe(true);
      const sorted = [...sentinel].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
      expect(sentinel.map((v) => v.effectiveFrom)).toEqual(sorted.map((v) => v.effectiveFrom));

      // Cross-user isolation: none of targetB's rows leak into targetA's list.
      expect(sentinel.every((v) => v.userId !== users.targetBId)).toBe(true);
    });
  }
);
