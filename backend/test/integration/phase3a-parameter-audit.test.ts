/**
 * Integration tests for PHASE-003a-T5:
 *   Parameter version audit write (AC-18) — PARAMETER_VERSION_CREATED
 *
 * TDD: tests written BEFORE implementation — expect RED first, then GREEN.
 *
 * Requires a running Postgres instance with migrations applied.
 * DATABASE_URL env var must be set; tests skip otherwise.
 *
 * AC covered:
 *   AC-18: Successful create of any parameter type writes one AuditLog row
 *          with actorId, action=PARAMETER_VERSION_CREATED, summary.parameterType,
 *          summary fields including effectiveFrom.
 *
 * Additional assertions:
 *   - Audit security: summary / targetLabel must NOT contain any password/hash/token/cookie key.
 *   - Atomicity (audit hook throws → version NOT created; overlap (409) → no audit row).
 *   - Non-admin / unauthenticated → no audit row created.
 *
 * Isolation (strict):
 *   - loginName prefix "t5audit_" for all test users.
 *   - effectiveFrom sentinel date ranges:
 *       Fuel:        2099-05-XX
 *       ETC:         2099-06-XX
 *       Depreciation:2099-07-XX
 *   - AuditLog cleanup: only rows where actorId IN (adminId) AND targetLabel LIKE 'FUEL#%'
 *     OR 'ETC#%' OR 'DEPRECIATION#%' created during this test run.
 *     Implemented via targetLabel prefix filter combined with actorId filter.
 *   - No global deleteMany({}).
 */

import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
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

// Sentinel login name prefixes
const ADMIN_LOGIN = `t5audit_admin_${SUFFIX}`;
const USER_LOGIN = `t5audit_user_${SUFFIX}`;

// Sentinel effectiveFrom date ranges
const FUEL_DATE_START = new Date("2099-05-01");
const FUEL_DATE_END = new Date("2099-05-31");
const ETC_DATE_START = new Date("2099-06-01");
const ETC_DATE_END = new Date("2099-06-30");
const DEP_DATE_START = new Date("2099-07-01");
const DEP_DATE_END = new Date("2099-07-31");

// targetLabel prefixes used by this test (for audit cleanup)
// PHASE-005a-T3b（AC-37(e)）: fuel 稽核覆蓋移轉至 /parameters/fuel-price，
// targetLabel 由 FUEL#<id> 改為 FUEL_PRICE#<id>（routes.ts 稽核 hook 實查）。
const AUDIT_LABEL_PREFIXES = ["FUEL_PRICE#", "ETC#", "DEPRECIATION#"];

interface TestUsers {
  adminId: string;
  userId: string;
}

// ---------------------------------------------------------------------------
// DB setup / teardown
// ---------------------------------------------------------------------------

async function setupUsers(prisma: PrismaClient): Promise<TestUsers> {
  const hash = await hashPassword(PASSWORD);

  const admin = await prisma.user.create({
    data: {
      loginName: ADMIN_LOGIN,
      displayName: "T5 Audit Admin",
      passwordHash: hash,
      role: "ADMIN",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const user = await prisma.user.create({
    data: {
      loginName: USER_LOGIN,
      displayName: "T5 Audit Normal User",
      passwordHash: hash,
      role: "USER",
      isActive: true,
      mustChangePassword: false,
    },
  });

  return { adminId: admin.id, userId: user.id };
}

async function cleanupAll(prisma: PrismaClient, userIds: string[]): Promise<void> {
  // Clean up parameter versions in sentinel date ranges
  await prisma.fuelParameterVersion.deleteMany({
    where: { effectiveFrom: { gte: FUEL_DATE_START, lte: FUEL_DATE_END } },
  });
  // PHASE-005a-T3b (Spec §2.H AC-37(e), REV2): AC-18 稽核覆蓋移轉至
  // POST /parameters/fuel-price，於同一哨兵日期區間寫入 FuelPriceVersion，須同步清理。
  await prisma.fuelPriceVersion.deleteMany({
    where: { effectiveFrom: { gte: FUEL_DATE_START, lte: FUEL_DATE_END } },
  });
  await prisma.etcParameterVersion.deleteMany({
    where: { effectiveFrom: { gte: ETC_DATE_START, lte: ETC_DATE_END } },
  });
  await prisma.depreciationParameterVersion.deleteMany({
    where: { effectiveFrom: { gte: DEP_DATE_START, lte: DEP_DATE_END } },
  });

  if (userIds.length > 0) {
    // Clean up audit logs: only rows with actorId in our test users AND
    // targetLabel matching our known prefixes (scoped, not global).
    for (const prefix of AUDIT_LABEL_PREFIXES) {
      await prisma.auditLog.deleteMany({
        where: {
          actorId: { in: userIds },
          targetLabel: { startsWith: prefix },
        },
      });
    }

    // Clean up sessions and users
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

// ---------------------------------------------------------------------------
// AC-18: Fuel price version create → AuditLog
//
// PHASE-005a-T3b（Spec §2.H AC-37(e) REV2）: POST /parameters/fuel 已移除
// （§16 D1(a)）。本 describe 之稽核契約覆蓋（AC-18：成功建立稽核列、敏感鍵
// 掃描、非管理員／未登入零稽核列、重疊 409 原子性）移轉至
// POST /parameters/fuel-price（不改寫為 404 —— 該端點之稽核形狀為淨增覆蓋，
// 非重複；理由見 AC-37(e) 表列）：
//   payload   { unitPrice, effectiveFrom } → { fuelType: "GASOLINE_95", pricePerLiter, effectiveFrom }
//   targetLabel FUEL#<id> → FUEL_PRICE#<id>
//   summary.parameterType "FUEL" → "FUEL_PRICE"；summary.unitPrice → summary.pricePerLiter
//   action 仍為 PARAMETER_VERSION_CREATED（不變）
//   409 原子性之第二次 POST 須用同一 fuelType ＋ 同一 effectiveFrom（新表唯一鍵 [fuelType, effectiveFrom]）
// ---------------------------------------------------------------------------

describeWithDb("POST /parameters/fuel-price → AuditLog (AC-18)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let users: TestUsers;
  let adminCookie: string;

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    users = await setupUsers(prisma);
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
    adminCookie = await loginUser(app, ADMIN_LOGIN, PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await cleanupAll(prisma, [users.adminId, users.userId]);
      await prisma.$disconnect();
    }
  });

  it("AC-18 fuel-price: create success → one AuditLog row with correct fields", async () => {
    const effectiveFrom = "2099-05-01";
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "GASOLINE_95", pricePerLiter: 3.5, effectiveFrom },
    });
    expect(resp.statusCode).toBe(201);
    const versionId = resp.json<{ version: { id: string } }>().version.id;

    // Query the audit log
    const log = await prisma.auditLog.findFirst({
      where: {
        actorId: users.adminId,
        action: "PARAMETER_VERSION_CREATED",
        targetLabel: `FUEL_PRICE#${versionId}`,
      },
    });

    expect(log).not.toBeNull();
    expect(log?.actorId).toBe(users.adminId);
    expect(log?.action).toBe("PARAMETER_VERSION_CREATED");
    expect(log?.targetLabel).toBe(`FUEL_PRICE#${versionId}`);

    // summary must contain parameterType, pricePerLiter, effectiveFrom
    const summary = log?.summary as Record<string, unknown>;
    expect(summary?.parameterType).toBe("FUEL_PRICE");
    expect(summary?.effectiveFrom).toBe(effectiveFrom);
    expect(summary?.pricePerLiter).toBeDefined();
  });

  it("AC-18 fuel-price security: summary and targetLabel must not contain sensitive keys", async () => {
    const effectiveFrom = "2099-05-02";
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "GASOLINE_95", pricePerLiter: 2.0, effectiveFrom },
    });
    expect(resp.statusCode).toBe(201);
    const versionId = resp.json<{ version: { id: string } }>().version.id;

    const log = await prisma.auditLog.findFirst({
      where: {
        actorId: users.adminId,
        targetLabel: `FUEL_PRICE#${versionId}`,
      },
    });
    expect(log).not.toBeNull();

    // Serialize and check for forbidden keys
    const serialized = JSON.stringify({ summary: log?.summary, targetLabel: log?.targetLabel });
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toMatch(/passwordHash/i);
    expect(serialized).not.toMatch(/\btoken\b/i);
    expect(serialized).not.toMatch(/cookie/i);
    expect(serialized).not.toMatch(/hash/i);
    expect(serialized).not.toMatch(/secret/i);
  });

  it("AC-18 fuel-price: non-admin USER create → 403, no audit row created", async () => {
    const userCookie = await loginUser(app, USER_LOGIN, PASSWORD);
    const countBefore = await prisma.auditLog.count({
      where: { actorId: users.userId, action: "PARAMETER_VERSION_CREATED" },
    });

    const resp = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: userCookie },
      payload: { fuelType: "GASOLINE_95", pricePerLiter: 1.0, effectiveFrom: "2099-05-10" },
    });
    expect(resp.statusCode).toBe(403);

    const countAfter = await prisma.auditLog.count({
      where: { actorId: users.userId, action: "PARAMETER_VERSION_CREATED" },
    });
    expect(countAfter).toBe(countBefore);
  });

  it("AC-18 fuel-price: unauthenticated create → 401, no audit row", async () => {
    // Scope to our admin user to avoid cross-test interference
    const countBefore = await prisma.auditLog.count({
      where: { actorId: users.adminId, action: "PARAMETER_VERSION_CREATED" },
    });

    const resp = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      payload: { fuelType: "GASOLINE_95", pricePerLiter: 1.0, effectiveFrom: "2099-05-11" },
    });
    expect(resp.statusCode).toBe(401);

    // No new audit row should be created (unauthenticated → rejected before reaching handler)
    const countAfter = await prisma.auditLog.count({
      where: { actorId: users.adminId, action: "PARAMETER_VERSION_CREATED" },
    });
    expect(countAfter).toBe(countBefore);
  });

  it("AC-18 fuel-price atomicity: overlap → 409, no audit row added", async () => {
    // Create one version first
    const resp1 = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "GASOLINE_95", pricePerLiter: 1.5, effectiveFrom: "2099-05-15" },
    });
    expect(resp1.statusCode).toBe(201);

    const countBefore = await prisma.auditLog.count({
      where: { actorId: users.adminId, action: "PARAMETER_VERSION_CREATED" },
    });

    // Duplicate fuelType + effectiveFrom → overlap (409)
    const resp2 = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "GASOLINE_95", pricePerLiter: 2.0, effectiveFrom: "2099-05-15" },
    });
    expect(resp2.statusCode).toBe(409);

    const countAfter = await prisma.auditLog.count({
      where: { actorId: users.adminId, action: "PARAMETER_VERSION_CREATED" },
    });
    // No new audit row should have been added
    expect(countAfter).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// AC-18: ETC parameter version create → AuditLog
// ---------------------------------------------------------------------------

describeWithDb("POST /parameters/etc → AuditLog (AC-18)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let users: TestUsers;
  let adminCookie: string;

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    users = await setupUsers(prisma);
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
    adminCookie = await loginUser(app, ADMIN_LOGIN, PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await cleanupAll(prisma, [users.adminId, users.userId]);
      await prisma.$disconnect();
    }
  });

  it("AC-18 etc: create success → one AuditLog row with correct fields", async () => {
    const effectiveFrom = "2099-06-01";
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/etc",
      headers: { cookie: adminCookie },
      payload: { unitPrice: 1.2, effectiveFrom },
    });
    expect(resp.statusCode).toBe(201);
    const versionId = resp.json<{ version: { id: string } }>().version.id;

    const log = await prisma.auditLog.findFirst({
      where: {
        actorId: users.adminId,
        action: "PARAMETER_VERSION_CREATED",
        targetLabel: `ETC#${versionId}`,
      },
    });

    expect(log).not.toBeNull();
    expect(log?.actorId).toBe(users.adminId);
    expect(log?.action).toBe("PARAMETER_VERSION_CREATED");
    expect(log?.targetLabel).toBe(`ETC#${versionId}`);

    const summary = log?.summary as Record<string, unknown>;
    expect(summary?.parameterType).toBe("ETC");
    expect(summary?.effectiveFrom).toBe(effectiveFrom);
    expect(summary?.unitPrice).toBeDefined();
  });

  it("AC-18 etc security: summary and targetLabel must not contain sensitive keys", async () => {
    const effectiveFrom = "2099-06-02";
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/etc",
      headers: { cookie: adminCookie },
      payload: { unitPrice: 0.8, effectiveFrom },
    });
    expect(resp.statusCode).toBe(201);
    const versionId = resp.json<{ version: { id: string } }>().version.id;

    const log = await prisma.auditLog.findFirst({
      where: {
        actorId: users.adminId,
        targetLabel: `ETC#${versionId}`,
      },
    });
    expect(log).not.toBeNull();

    const serialized = JSON.stringify({ summary: log?.summary, targetLabel: log?.targetLabel });
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toMatch(/\btoken\b/i);
    expect(serialized).not.toMatch(/cookie/i);
    expect(serialized).not.toMatch(/hash/i);
    expect(serialized).not.toMatch(/secret/i);
  });

  it("AC-18 etc atomicity: overlap → 409, no audit row added", async () => {
    const resp1 = await app.inject({
      method: "POST",
      url: "/parameters/etc",
      headers: { cookie: adminCookie },
      payload: { unitPrice: 0.5, effectiveFrom: "2099-06-15" },
    });
    expect(resp1.statusCode).toBe(201);

    const countBefore = await prisma.auditLog.count({
      where: { actorId: users.adminId, action: "PARAMETER_VERSION_CREATED" },
    });

    const resp2 = await app.inject({
      method: "POST",
      url: "/parameters/etc",
      headers: { cookie: adminCookie },
      payload: { unitPrice: 0.9, effectiveFrom: "2099-06-15" },
    });
    expect(resp2.statusCode).toBe(409);

    const countAfter = await prisma.auditLog.count({
      where: { actorId: users.adminId, action: "PARAMETER_VERSION_CREATED" },
    });
    expect(countAfter).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// AC-18: Depreciation parameter version create → AuditLog
// ---------------------------------------------------------------------------

describeWithDb("POST /parameters/depreciation → AuditLog (AC-18)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let users: TestUsers;
  let adminCookie: string;

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    users = await setupUsers(prisma);
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
    adminCookie = await loginUser(app, ADMIN_LOGIN, PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await cleanupAll(prisma, [users.adminId, users.userId]);
      await prisma.$disconnect();
    }
  });

  it("AC-18 depreciation: create success → one AuditLog row with correct fields", async () => {
    const effectiveFrom = "2099-07-01";
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 500000,
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom,
      },
    });
    expect(resp.statusCode).toBe(201);
    const versionId = resp.json<{ version: { id: string } }>().version.id;

    const log = await prisma.auditLog.findFirst({
      where: {
        actorId: users.adminId,
        action: "PARAMETER_VERSION_CREATED",
        targetLabel: `DEPRECIATION#${versionId}`,
      },
    });

    expect(log).not.toBeNull();
    expect(log?.actorId).toBe(users.adminId);
    expect(log?.action).toBe("PARAMETER_VERSION_CREATED");
    expect(log?.targetLabel).toBe(`DEPRECIATION#${versionId}`);

    const summary = log?.summary as Record<string, unknown>;
    expect(summary?.parameterType).toBe("DEPRECIATION");
    expect(summary?.effectiveFrom).toBe(effectiveFrom);
    expect(summary?.vehiclePrice).toBeDefined();
    expect(summary?.usefulLifeYears).toBeDefined();
    expect(summary?.estimatedAnnualKm).toBeDefined();
  });

  it("AC-18 depreciation security: summary must not contain sensitive keys", async () => {
    const effectiveFrom = "2099-07-02";
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 300000,
        usefulLifeYears: 3,
        estimatedAnnualKm: 15000,
        effectiveFrom,
      },
    });
    expect(resp.statusCode).toBe(201);
    const versionId = resp.json<{ version: { id: string } }>().version.id;

    const log = await prisma.auditLog.findFirst({
      where: {
        actorId: users.adminId,
        targetLabel: `DEPRECIATION#${versionId}`,
      },
    });
    expect(log).not.toBeNull();

    const serialized = JSON.stringify({ summary: log?.summary, targetLabel: log?.targetLabel });
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toMatch(/\btoken\b/i);
    expect(serialized).not.toMatch(/cookie/i);
    expect(serialized).not.toMatch(/hash/i);
    expect(serialized).not.toMatch(/secret/i);
  });

  it("AC-18 depreciation atomicity: overlap → 409, no audit row added", async () => {
    const resp1 = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 200000,
        usefulLifeYears: 4,
        estimatedAnnualKm: 10000,
        effectiveFrom: "2099-07-15",
      },
    });
    expect(resp1.statusCode).toBe(201);

    const countBefore = await prisma.auditLog.count({
      where: { actorId: users.adminId, action: "PARAMETER_VERSION_CREATED" },
    });

    const resp2 = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 250000,
        usefulLifeYears: 5,
        estimatedAnnualKm: 12000,
        effectiveFrom: "2099-07-15",
      },
    });
    expect(resp2.statusCode).toBe(409);

    const countAfter = await prisma.auditLog.count({
      where: { actorId: users.adminId, action: "PARAMETER_VERSION_CREATED" },
    });
    expect(countAfter).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// Atomicity: audit hook throw → version NOT created
// ---------------------------------------------------------------------------

describeWithDb("Atomicity: audit hook throw → version NOT created", () => {
  /**
   * This test verifies that if the onCreated callback (audit write) throws,
   * the version creation is also rolled back (same transaction).
   *
   * We test this by directly calling the service with a failing onCreated callback
   * and verifying the DB has no new version row afterwards.
   */
  let prisma: PrismaClient;
  let adminUser: { id: string };

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    adminUser = await prisma.user.create({
      data: {
        loginName: `t5audit_atomic_${SUFFIX}`,
        displayName: "T5 Atomicity Admin",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      // Clean up any sentinel-range versions that might have leaked
      await prisma.fuelParameterVersion.deleteMany({
        where: { effectiveFrom: { gte: FUEL_DATE_START, lte: FUEL_DATE_END } },
      });
      await prisma.etcParameterVersion.deleteMany({
        where: { effectiveFrom: { gte: ETC_DATE_START, lte: ETC_DATE_END } },
      });
      await prisma.depreciationParameterVersion.deleteMany({
        where: { effectiveFrom: { gte: DEP_DATE_START, lte: DEP_DATE_END } },
      });

      // Clean audit logs for atomic test user
      for (const prefix of AUDIT_LABEL_PREFIXES) {
        await prisma.auditLog.deleteMany({
          where: {
            actorId: adminUser.id,
            targetLabel: { startsWith: prefix },
          },
        });
      }

      await prisma.session.deleteMany({ where: { userId: adminUser.id } });
      await prisma.user.delete({ where: { id: adminUser.id } });
      await prisma.$disconnect();
    }
  });

  it("atomicity: audit hook throws → fuel version NOT persisted", async () => {
    const { createFuelVersion } = await import("../../src/parameters/parameter-service.js");

    const countBefore = await prisma.fuelParameterVersion.count({
      where: { effectiveFrom: { gte: FUEL_DATE_START, lte: FUEL_DATE_END } },
    });

    // onCreated callback that throws — should cause transaction rollback
    const failingHook = async () => {
      throw new Error("Simulated audit write failure");
    };

    await expect(
      createFuelVersion(
        prisma,
        {
          unitPrice: 5.0,
          effectiveFrom: "2099-05-20",
          createdById: adminUser.id,
        },
        failingHook
      )
    ).rejects.toThrow("Simulated audit write failure");

    const countAfter = await prisma.fuelParameterVersion.count({
      where: { effectiveFrom: { gte: FUEL_DATE_START, lte: FUEL_DATE_END } },
    });

    // The version must NOT have been persisted (transaction rolled back)
    expect(countAfter).toBe(countBefore);
  });

  it("atomicity: audit hook throws → ETC version NOT persisted", async () => {
    const { createEtcVersion } = await import("../../src/parameters/parameter-service.js");

    const countBefore = await prisma.etcParameterVersion.count({
      where: { effectiveFrom: { gte: ETC_DATE_START, lte: ETC_DATE_END } },
    });

    const failingHook = async () => {
      throw new Error("Simulated audit write failure");
    };

    await expect(
      createEtcVersion(
        prisma,
        {
          unitPrice: 1.0,
          effectiveFrom: "2099-06-20",
          createdById: adminUser.id,
        },
        failingHook
      )
    ).rejects.toThrow("Simulated audit write failure");

    const countAfter = await prisma.etcParameterVersion.count({
      where: { effectiveFrom: { gte: ETC_DATE_START, lte: ETC_DATE_END } },
    });

    expect(countAfter).toBe(countBefore);
  });

  it("atomicity: audit hook throws → depreciation version NOT persisted", async () => {
    const { createDepreciationVersion } = await import("../../src/parameters/parameter-service.js");

    const countBefore = await prisma.depreciationParameterVersion.count({
      where: { effectiveFrom: { gte: DEP_DATE_START, lte: DEP_DATE_END } },
    });

    const failingHook = async () => {
      throw new Error("Simulated audit write failure");
    };

    await expect(
      createDepreciationVersion(
        prisma,
        {
          vehiclePrice: 400000,
          usefulLifeYears: 5,
          estimatedAnnualKm: 20000,
          effectiveFrom: "2099-07-20",
          createdById: adminUser.id,
        },
        failingHook
      )
    ).rejects.toThrow("Simulated audit write failure");

    const countAfter = await prisma.depreciationParameterVersion.count({
      where: { effectiveFrom: { gte: DEP_DATE_START, lte: DEP_DATE_END } },
    });

    expect(countAfter).toBe(countBefore);
  });
});
