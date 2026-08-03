/**
 * Integration tests for PHASE-003a-T3:
 *   Fuel and ETC parameter version API (create + list)
 *
 * TDD: tests written BEFORE implementation — expect RED first, then GREEN.
 *
 * Requires a running Postgres instance with migrations applied.
 * DATABASE_URL env var must be set; tests skip otherwise.
 *
 * AC covered (from PHASE-003a Spec §2):
 *   AC-01: Create fuel parameter, unitPrice ≥ 0 → 201 + DTO
 *   AC-02: Create ETC parameter, unitPrice ≥ 0 → 201 + DTO
 *   AC-03: unitPrice < 0 → 400 VALIDATION_ERROR fields=[unitPrice]
 *   AC-06: missing/invalid effectiveFrom → 400 VALIDATION_ERROR fields=[effectiveFrom]
 *   AC-07: overlapping effectiveFrom → 409 PARAMETER_PERIOD_OVERLAP + conflictVersion
 *   AC-09 boundary: adjacent (different) day → 201 allowed
 *   AC-16: USER role → 403 FORBIDDEN
 *   AC-17: unauthenticated → 401 UNAUTHORIZED
 *   AC-19: list sorted by effectiveFrom; DTO excludes sensitive fields
 *
 * Permission matrix (§8.2):
 *   POST/GET /parameters/fuel and /parameters/etc:
 *     admin → 201/200
 *     USER → 403
 *     unauthenticated → 401
 *     mustChangePassword admin → 403 PASSWORD_CHANGE_REQUIRED
 *
 * Isolation:
 *   All DB rows created in this file use loginName prefix "t3param_" and
 *   effectiveFrom dates in a sentinel range (2099-01-* for fuel, 2099-02-* for ETC).
 *   Cleanup is scoped to these prefixes / date ranges; no global deleteMany.
 */

import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

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

// Sentinel login name prefix for cleanup isolation
const ADMIN_LOGIN = `t3param_admin_${SUFFIX}`;
const USER_LOGIN = `t3param_user_${SUFFIX}`;
const MCP_ADMIN_LOGIN = `t3param_mcp_${SUFFIX}`;

// Sentinel effectiveFrom date ranges for cleanup isolation
// Fuel: 2099-01-XX, ETC: 2099-02-XX
const FUEL_DATE_PREFIX_START = new Date("2099-01-01");
const FUEL_DATE_PREFIX_END = new Date("2099-01-31");
const ETC_DATE_PREFIX_START = new Date("2099-02-01");
const ETC_DATE_PREFIX_END = new Date("2099-02-28");

interface TestUsers {
  adminId: string;
  userId: string;
  mcpAdminId: string;
}

// ---------------------------------------------------------------------------
// DB setup / teardown
// ---------------------------------------------------------------------------

async function setupUsers(prisma: PrismaClient): Promise<TestUsers> {
  const hash = await hashPassword(PASSWORD);

  const admin = await prisma.user.create({
    data: {
      loginName: ADMIN_LOGIN,
      displayName: "T3 Admin",
      passwordHash: hash,
      role: "ADMIN",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const user = await prisma.user.create({
    data: {
      loginName: USER_LOGIN,
      displayName: "T3 Normal User",
      passwordHash: hash,
      role: "USER",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const mcpAdmin = await prisma.user.create({
    data: {
      loginName: MCP_ADMIN_LOGIN,
      displayName: "T3 MCP Admin",
      passwordHash: hash,
      role: "ADMIN",
      isActive: true,
      mustChangePassword: true, // mustChangePassword admin
    },
  });

  return { adminId: admin.id, userId: user.id, mcpAdminId: mcpAdmin.id };
}

async function cleanupAll(prisma: PrismaClient, userIds: string[]): Promise<void> {
  // Clean up parameter versions created in sentinel date ranges
  await prisma.fuelParameterVersion.deleteMany({
    where: {
      effectiveFrom: {
        gte: FUEL_DATE_PREFIX_START,
        lte: FUEL_DATE_PREFIX_END,
      },
    },
  });
  // PHASE-005a-T3b: AC-37(e) 移轉之並發／精度 it 改打 /parameters/fuel-price，
  // 於同一哨兵日期區間（2099-01-*）寫入 FuelPriceVersion，須同步清理。
  await prisma.fuelPriceVersion.deleteMany({
    where: {
      effectiveFrom: {
        gte: FUEL_DATE_PREFIX_START,
        lte: FUEL_DATE_PREFIX_END,
      },
    },
  });
  await prisma.etcParameterVersion.deleteMany({
    where: {
      effectiveFrom: {
        gte: ETC_DATE_PREFIX_START,
        lte: ETC_DATE_PREFIX_END,
      },
    },
  });

  // Clean up sessions and users
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
// POST /parameters/fuel（D1(a) 凍結後）— AC-37(a)(b)
//
// PHASE-005a-T3b（§16 D1(a)、Spec §2.H AC-37）: route 已移除，故三種身分
// （管理員／一般使用者／未登入）皆為 404，且零寫入。原 PHASE-003a 之
// AC-01/03/06/07/09/16/17（寫入路徑覆蓋）由 PHASE-005a AC-01/02/03/05/06
// （`/parameters/fuel-price`，§12 已 GREEN）承接；本 describe 僅保留
// AC-37(a)(b) 之 404／零寫入斷言，見 Spec §2.H AC-37(e) 第一、二列。
// ---------------------------------------------------------------------------

describeWithDb("POST /parameters/fuel（D1(a) 凍結後）", () => {
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

  // AC-37(a): route 不存在 → preHandler 鏈不執行 → 三種身分皆 404（無授權判定）
  it("AC-37(a) 管理員／一般使用者／未登入三種身分皆回 404 NOT_FOUND（統一錯誤形狀，不新增 ErrorCode）", async () => {
    const identities: { label: string; cookie?: string }[] = [
      { label: "管理員", cookie: adminCookie },
      { label: "一般使用者", cookie: userCookie },
      { label: "未登入", cookie: undefined },
    ];

    for (const { cookie } of identities) {
      const resp = await app.inject({
        method: "POST",
        url: "/parameters/fuel",
        headers: cookie ? { cookie } : {},
        payload: { unitPrice: "3.5000", effectiveFrom: "2099-01-01" }, // 合法 body
      });
      expect(resp.statusCode).toBe(404);
      const body = resp.json<{
        error: { code: string; message: string; requestId?: string };
      }>();
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.requestId).toBeDefined();
    }

    // 判定語意鑑別：畸形 body（含 mustChangePassword 身分）亦同為 404，
    // 證明 preHandler 鏈（含 requirePasswordChanged）確實未執行。
    const malformed = await app.inject({
      method: "POST",
      url: "/parameters/fuel",
      headers: { cookie: mcpCookie },
      payload: { totally: "malformed", nested: { x: 1 } },
    });
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
  });

  // AC-37(b): 三種身分之請求前後，FuelParameterVersion 列數與最大 createdAt 全等
  it("AC-37(b) 三種身分之請求前後 FuelParameterVersion 列數與最大 createdAt 全等（零寫入）", async () => {
    async function snapshot(): Promise<{ count: number; maxCreatedAt: number }> {
      const rows = await prisma.fuelParameterVersion.findMany({ select: { createdAt: true } });
      const maxCreatedAt = rows.reduce((max, r) => Math.max(max, r.createdAt.getTime()), 0);
      return { count: rows.length, maxCreatedAt };
    }

    const before = await snapshot();

    await app.inject({
      method: "POST",
      url: "/parameters/fuel",
      headers: { cookie: adminCookie },
      payload: { unitPrice: "3.5000", effectiveFrom: "2099-01-01" },
    });
    await app.inject({
      method: "POST",
      url: "/parameters/fuel",
      headers: { cookie: userCookie },
      payload: { unitPrice: "3.5000", effectiveFrom: "2099-01-01" },
    });
    await app.inject({
      method: "POST",
      url: "/parameters/fuel",
      payload: { unitPrice: "3.5000", effectiveFrom: "2099-01-01" },
    });

    const after = await snapshot();
    expect(after.count).toBe(before.count);
    expect(after.maxCreatedAt).toBe(before.maxCreatedAt);
  });
});

// ---------------------------------------------------------------------------
// GET /parameters/fuel (AC-19)
// ---------------------------------------------------------------------------

describeWithDb("GET /parameters/fuel", () => {
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

  // AC-19: list returns all versions sorted by effectiveFrom; DTO excludes sensitive fields
  it("AC-19: admin gets 200 list sorted by effectiveFrom, no sensitive fields", async () => {
    // AC-37(c): POST /parameters/fuel 已移除，播種改為直寫 FuelParameterVersion
    // （繞過已移除之端點）；GET 之斷言以下逐字不變（AC-37(c) 主要證據）。
    await prisma.fuelParameterVersion.create({
      data: {
        unitPrice: "7",
        effectiveFrom: new Date("2099-01-15"),
        createdById: users.adminId,
      },
    });
    await prisma.fuelParameterVersion.create({
      data: {
        unitPrice: "5",
        effectiveFrom: new Date("2099-01-10"),
        createdById: users.adminId,
      },
    });

    const resp = await app.inject({
      method: "GET",
      url: "/parameters/fuel",
      headers: { cookie: adminCookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ versions: Record<string, unknown>[] }>();
    expect(Array.isArray(body.versions)).toBe(true);
    expect(body.versions.length).toBeGreaterThanOrEqual(2);

    // Check sort order: earlier effectiveFrom first
    const sentinelVersions = body.versions.filter(
      (v) =>
        typeof v.effectiveFrom === "string" &&
        v.effectiveFrom >= "2099-01-01" &&
        v.effectiveFrom <= "2099-01-31"
    );
    expect(sentinelVersions.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < sentinelVersions.length; i++) {
      const curr = String(sentinelVersions[i].effectiveFrom ?? "");
      const prev = String(sentinelVersions[i - 1].effectiveFrom ?? "");
      expect(curr >= prev).toBe(true);
    }

    // DTO structure: id, unitPrice, effectiveFrom, createdAt — no createdById
    for (const v of body.versions) {
      expect(v.id).toBeDefined();
      expect(v.unitPrice).toBeDefined();
      expect(v.effectiveFrom).toBeDefined();
      expect(v.createdAt).toBeDefined();
      expect(v.createdById).toBeUndefined();
    }
  });

  // AC-16: USER role → 403 FORBIDDEN on GET
  it("AC-16: USER role → 403 FORBIDDEN on GET /parameters/fuel", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/fuel",
      headers: { cookie: userCookie },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
  });

  // AC-17: unauthenticated → 401
  it("AC-17: unauthenticated → 401 on GET /parameters/fuel", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/fuel",
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  // mustChangePassword admin → 403
  it("mustChangePassword admin → 403 PASSWORD_CHANGE_REQUIRED on GET /parameters/fuel", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/fuel",
      headers: { cookie: mcpCookie },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// POST /parameters/etc (AC-02, AC-03, AC-06, AC-07)
// ---------------------------------------------------------------------------

describeWithDb("POST /parameters/etc", () => {
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

  // AC-02: valid ETC parameter → 201 + DTO
  it("AC-02: admin creates ETC parameter → 201 with DTO", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/etc",
      headers: { cookie: adminCookie },
      payload: { unitPrice: "2.5000", effectiveFrom: "2099-02-01" },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ version: Record<string, unknown> }>();
    expect(body.version).toBeDefined();
    expect(body.version.id).toBeDefined();
    expect(body.version.effectiveFrom).toBe("2099-02-01");
    expect(String(body.version.unitPrice)).toBe("2.5000");
    expect(body.version.createdAt).toBeDefined();
    expect(body.version.createdById).toBeUndefined();
  });

  // AC-02 boundary: unitPrice=0 → allowed
  it("AC-02 boundary: unitPrice=0 → 201 for ETC", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/etc",
      headers: { cookie: adminCookie },
      payload: { unitPrice: 0, effectiveFrom: "2099-02-02" },
    });
    expect(resp.statusCode).toBe(201);
  });

  // AC-03: unitPrice < 0 → 400
  it("AC-03: unitPrice=-1 → 400 VALIDATION_ERROR fields=[unitPrice] for ETC", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/etc",
      headers: { cookie: adminCookie },
      payload: { unitPrice: -1, effectiveFrom: "2099-02-10" },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const fields = body.error.fields ?? [];
    expect(fields.some((f) => f.field === "unitPrice")).toBe(true);
  });

  // AC-06: missing effectiveFrom
  it("AC-06: missing effectiveFrom → 400 for ETC", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/etc",
      headers: { cookie: adminCookie },
      payload: { unitPrice: 5 },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const fields = body.error.fields ?? [];
    expect(fields.some((f) => f.field === "effectiveFrom")).toBe(true);
  });

  // AC-07: duplicate effectiveFrom → 409 PARAMETER_PERIOD_OVERLAP
  it("AC-07: duplicate effectiveFrom → 409 PARAMETER_PERIOD_OVERLAP for ETC", async () => {
    await app.inject({
      method: "POST",
      url: "/parameters/etc",
      headers: { cookie: adminCookie },
      payload: { unitPrice: 2, effectiveFrom: "2099-02-05" },
    });

    const resp = await app.inject({
      method: "POST",
      url: "/parameters/etc",
      headers: { cookie: adminCookie },
      payload: { unitPrice: 3, effectiveFrom: "2099-02-05" },
    });
    expect(resp.statusCode).toBe(409);
    const body = resp.json<{
      error: {
        code: string;
        details?: { conflictVersion?: { id: string; effectiveFrom: string } };
      };
    }>();
    expect(body.error.code).toBe("PARAMETER_PERIOD_OVERLAP");
    expect(body.error.details?.conflictVersion?.effectiveFrom).toBe("2099-02-05");
  });

  // AC-16: USER → 403
  it("AC-16: USER role → 403 FORBIDDEN on POST /parameters/etc", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/etc",
      headers: { cookie: userCookie },
      payload: { unitPrice: 3, effectiveFrom: "2099-02-15" },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
  });

  // AC-17: unauthenticated → 401
  it("AC-17: unauthenticated → 401 on POST /parameters/etc", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/etc",
      payload: { unitPrice: 3, effectiveFrom: "2099-02-15" },
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  // mustChangePassword → 403
  it("mustChangePassword admin → 403 PASSWORD_CHANGE_REQUIRED on POST /parameters/etc", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/etc",
      headers: { cookie: mcpCookie },
      payload: { unitPrice: 3, effectiveFrom: "2099-02-15" },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// GET /parameters/etc (AC-19)
// ---------------------------------------------------------------------------

describeWithDb("GET /parameters/etc", () => {
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

  // AC-19: list returns versions sorted by effectiveFrom
  it("AC-19: admin gets 200 ETC list sorted by effectiveFrom", async () => {
    await app.inject({
      method: "POST",
      url: "/parameters/etc",
      headers: { cookie: adminCookie },
      payload: { unitPrice: 9, effectiveFrom: "2099-02-15" },
    });
    await app.inject({
      method: "POST",
      url: "/parameters/etc",
      headers: { cookie: adminCookie },
      payload: { unitPrice: 8, effectiveFrom: "2099-02-10" },
    });

    const resp = await app.inject({
      method: "GET",
      url: "/parameters/etc",
      headers: { cookie: adminCookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ versions: Record<string, unknown>[] }>();
    expect(Array.isArray(body.versions)).toBe(true);

    const sentinelVersions = body.versions.filter(
      (v) =>
        typeof v.effectiveFrom === "string" &&
        v.effectiveFrom >= "2099-02-01" &&
        v.effectiveFrom <= "2099-02-28"
    );
    expect(sentinelVersions.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < sentinelVersions.length; i++) {
      const curr = String(sentinelVersions[i].effectiveFrom ?? "");
      const prev = String(sentinelVersions[i - 1].effectiveFrom ?? "");
      expect(curr >= prev).toBe(true);
    }

    // DTO check
    for (const v of body.versions) {
      expect(v.createdById).toBeUndefined();
    }
  });

  // AC-16: USER → 403
  it("AC-16: USER role → 403 on GET /parameters/etc", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/etc",
      headers: { cookie: userCookie },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
  });

  // AC-17: unauthenticated → 401
  it("AC-17: unauthenticated → 401 on GET /parameters/etc", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/etc",
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  // mustChangePassword → 403
  it("mustChangePassword admin → 403 on GET /parameters/etc", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/etc",
      headers: { cookie: mcpCookie },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// Concurrent defense: two POST with same effectiveFrom → second gets 409 not 500
// ---------------------------------------------------------------------------

describeWithDb("Concurrent defense: DB unique constraint → 409 not 500", () => {
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
      await cleanupAll(prisma, [users.adminId, users.userId, users.mcpAdminId]);
      await prisma.$disconnect();
    }
  });

  // Test: two sequential requests with same date — second must get 409, not 500
  // (This tests both service-layer overlap check and DB unique constraint fallback)
  // AC-37(e): POST /parameters/fuel 已移除；同語意移轉至 /parameters/fuel-price
  // （與 AC-02 之並發 it 覆蓋重複，屬淨增覆蓋，非重複刪減）。
  it("two sequential requests with same fuel-price date → second gets 409 PARAMETER_PERIOD_OVERLAP", async () => {
    const [r1, r2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        headers: { cookie: adminCookie },
        payload: { fuelType: "GASOLINE_95", pricePerLiter: 1, effectiveFrom: "2099-01-25" },
      }),
      app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        headers: { cookie: adminCookie },
        payload: { fuelType: "GASOLINE_95", pricePerLiter: 2, effectiveFrom: "2099-01-25" },
      }),
    ]);

    const statuses = [r1.statusCode, r2.statusCode].sort();
    // One should be 201, one should be 409 — never 500
    expect(statuses).toEqual([201, 409]);
    const failedResp = r1.statusCode === 409 ? r1 : r2;
    expect(failedResp.json<{ error: { code: string } }>().error.code).toBe(
      "PARAMETER_PERIOD_OVERLAP"
    );
  });

  it("two sequential requests with same ETC date → second gets 409 PARAMETER_PERIOD_OVERLAP", async () => {
    const [r1, r2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/parameters/etc",
        headers: { cookie: adminCookie },
        payload: { unitPrice: 1, effectiveFrom: "2099-02-25" },
      }),
      app.inject({
        method: "POST",
        url: "/parameters/etc",
        headers: { cookie: adminCookie },
        payload: { unitPrice: 2, effectiveFrom: "2099-02-25" },
      }),
    ]);

    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const failedResp = r1.statusCode === 409 ? r1 : r2;
    expect(failedResp.json<{ error: { code: string } }>().error.code).toBe(
      "PARAMETER_PERIOD_OVERLAP"
    );
  });
});

// ---------------------------------------------------------------------------
// Precision / DTO round-trip
// ---------------------------------------------------------------------------

describeWithDb("Precision: unitPrice Decimal round-trip", () => {
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
      await cleanupAll(prisma, [users.adminId, users.userId, users.mcpAdminId]);
      await prisma.$disconnect();
    }
  });

  // AC-37(e): POST /parameters/fuel 已移除，播種移轉至 /parameters/fuel-price；
  // 精度斷言逐字保留（欄位名 unitPrice → pricePerLiter）。
  it("pricePerLiter=1.2345 stored and returned without float imprecision", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "GASOLINE_95", pricePerLiter: "1.2345", effectiveFrom: "2099-01-28" },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ version: { pricePerLiter: string } }>();
    expect(String(body.version.pricePerLiter)).toBe("1.2345");
  });

  it("GET list: pricePerLiter precision is preserved after round-trip", async () => {
    await app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "GASOLINE_95", pricePerLiter: "3.1415", effectiveFrom: "2099-01-29" },
    });

    const listResp = await app.inject({
      method: "GET",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
    });
    expect(listResp.statusCode).toBe(200);
    const body = listResp.json<{
      versions: { pricePerLiter: string; effectiveFrom: string }[];
    }>();
    const v = body.versions.find((x) => x.effectiveFrom === "2099-01-29");
    expect(v).toBeDefined();
    expect(String(v?.pricePerLiter)).toBe("3.1415");
  });
});
