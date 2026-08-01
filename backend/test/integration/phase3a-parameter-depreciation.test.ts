/**
 * Integration tests for PHASE-003a-T4:
 *   Depreciation parameter version API (create + list)
 *
 * TDD: tests written BEFORE implementation — expect RED first, then GREEN.
 *
 * Requires a running Postgres instance with migrations applied.
 * DATABASE_URL env var must be set; tests skip otherwise.
 *
 * AC covered (from PHASE-003a Spec §2):
 *   AC-04: Create depreciation parameter, all three values > 0 → 201 + DTO with derived
 *   AC-05: Any value ≤ 0 → 400 VALIDATION_ERROR, fields point exact violating field(s);
 *          response must NOT contain derived
 *   AC-06: missing/invalid effectiveFrom → 400 VALIDATION_ERROR fields=[effectiveFrom]
 *   AC-08: overlapping effectiveFrom → 409 PARAMETER_PERIOD_OVERLAP + conflictVersion
 *   AC-12: derived.annualDepreciation = round_half_up(vehiclePrice / usefulLifeYears, 2)
 *   AC-13: derived.perKmUnitPrice = round_half_up(vehiclePrice/usefulLifeYears/estimatedAnnualKm, 4)
 *   AC-16: USER role → 403 FORBIDDEN
 *   AC-17: unauthenticated → 401 UNAUTHORIZED
 *   AC-19: GET list sorted by effectiveFrom; each version contains derived
 *
 * Permission matrix (§8.2):
 *   POST/GET /parameters/depreciation:
 *     admin → 201/200
 *     USER → 403
 *     unauthenticated → 401
 *     mustChangePassword admin → 403 PASSWORD_CHANGE_REQUIRED
 *
 * Isolation:
 *   All DB rows created in this file use loginName prefix "t4dep_" and
 *   effectiveFrom dates in sentinel range (2099-03-* for depreciation).
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
// Shared helpers (mirrored from T3 test, scoped to depreciation)
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
const ADMIN_LOGIN = `t4dep_admin_${SUFFIX}`;
const USER_LOGIN = `t4dep_user_${SUFFIX}`;
const MCP_ADMIN_LOGIN = `t4dep_mcp_${SUFFIX}`;

// Sentinel effectiveFrom date ranges for cleanup isolation
// Depreciation: 2099-03-XX
const DEP_DATE_START = new Date("2099-03-01");
const DEP_DATE_END = new Date("2099-03-31");

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
      displayName: "T4 Dep Admin",
      passwordHash: hash,
      role: "ADMIN",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const user = await prisma.user.create({
    data: {
      loginName: USER_LOGIN,
      displayName: "T4 Dep Normal User",
      passwordHash: hash,
      role: "USER",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const mcpAdmin = await prisma.user.create({
    data: {
      loginName: MCP_ADMIN_LOGIN,
      displayName: "T4 Dep MCP Admin",
      passwordHash: hash,
      role: "ADMIN",
      isActive: true,
      mustChangePassword: true,
    },
  });

  return { adminId: admin.id, userId: user.id, mcpAdminId: mcpAdmin.id };
}

async function cleanupAll(prisma: PrismaClient, userIds: string[]): Promise<void> {
  // Clean up depreciation versions in sentinel date range
  await prisma.depreciationParameterVersion.deleteMany({
    where: {
      effectiveFrom: {
        gte: DEP_DATE_START,
        lte: DEP_DATE_END,
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
// POST /parameters/depreciation (AC-04, AC-05, AC-06, AC-08)
// ---------------------------------------------------------------------------

describeWithDb("POST /parameters/depreciation", () => {
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

  // AC-04: all three values > 0 → 201 + DTO with derived
  it("AC-04: admin creates depreciation → 201 with DTO including derived", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: "500000.00",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2099-03-01",
      },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ version: Record<string, unknown> }>();
    expect(body.version).toBeDefined();
    expect(body.version.id).toBeDefined();
    expect(body.version.effectiveFrom).toBe("2099-03-01");
    // vehiclePrice should be 2 decimal places string
    expect(String(body.version.vehiclePrice)).toBe("500000.00");
    expect(body.version.usefulLifeYears).toBe(5);
    expect(body.version.estimatedAnnualKm).toBe(20000);
    expect(body.version.createdAt).toBeDefined();
    // DTO must NOT expose createdById
    expect(body.version.createdById).toBeUndefined();

    // Must include derived (AC-04, AC-12, AC-13)
    const derived = body.version.derived as
      | { annualDepreciation: string; perKmUnitPrice: string }
      | undefined;
    expect(derived).toBeDefined();
    // 500000 / 5 = 100000.00
    expect(derived?.annualDepreciation).toBe("100000.00");
    // 500000 / 5 / 20000 = 5.0000
    expect(derived?.perKmUnitPrice).toBe("5.0000");
  });

  // AC-12/13: verify derived calculation with non-trivial values
  it("AC-12/13: derived calculation with rounding — vehiclePrice=100000, years=3, km=20000", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: "100000.00",
        usefulLifeYears: 3,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2099-03-02",
      },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{
      version: { derived: { annualDepreciation: string; perKmUnitPrice: string } };
    }>();
    // 100000 / 3 = 33333.333... → round_half_up(2) = 33333.33
    expect(body.version.derived.annualDepreciation).toBe("33333.33");
    // 100000 / 3 / 20000 = 1.6666... → round_half_up(4) = 1.6667
    expect(body.version.derived.perKmUnitPrice).toBe("1.6667");
  });

  // AC-05: vehiclePrice = 0 → 400 VALIDATION_ERROR, fields=[vehiclePrice]
  it("AC-05: vehiclePrice=0 → 400 VALIDATION_ERROR fields=[vehiclePrice], no derived", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 0,
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2099-03-10",
      },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{
      error: { code: string; fields?: { field: string }[] };
      version?: unknown;
    }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const fields = body.error.fields ?? [];
    expect(fields.some((f) => f.field === "vehiclePrice")).toBe(true);
    // Response must NOT contain derived or version
    expect(body.version).toBeUndefined();
  });

  // AC-05: vehiclePrice < 0 → 400 VALIDATION_ERROR
  it("AC-05: vehiclePrice=-100 → 400 VALIDATION_ERROR fields=[vehiclePrice]", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: -100,
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2099-03-10",
      },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const fields = body.error.fields ?? [];
    expect(fields.some((f) => f.field === "vehiclePrice")).toBe(true);
  });

  // AC-05: usefulLifeYears = 0 → 400 VALIDATION_ERROR, fields=[usefulLifeYears]
  it("AC-05: usefulLifeYears=0 → 400 VALIDATION_ERROR fields=[usefulLifeYears]", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 500000,
        usefulLifeYears: 0,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2099-03-10",
      },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const fields = body.error.fields ?? [];
    expect(fields.some((f) => f.field === "usefulLifeYears")).toBe(true);
  });

  // AC-05: usefulLifeYears < 0
  it("AC-05: usefulLifeYears=-1 → 400 VALIDATION_ERROR fields=[usefulLifeYears]", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 500000,
        usefulLifeYears: -1,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2099-03-10",
      },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const fields = body.error.fields ?? [];
    expect(fields.some((f) => f.field === "usefulLifeYears")).toBe(true);
  });

  // AC-05: estimatedAnnualKm = 0
  it("AC-05: estimatedAnnualKm=0 → 400 VALIDATION_ERROR fields=[estimatedAnnualKm]", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 500000,
        usefulLifeYears: 5,
        estimatedAnnualKm: 0,
        effectiveFrom: "2099-03-10",
      },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const fields = body.error.fields ?? [];
    expect(fields.some((f) => f.field === "estimatedAnnualKm")).toBe(true);
  });

  // AC-05: multiple violations → all violating fields indicated
  it("AC-05: vehiclePrice=0 AND usefulLifeYears=0 → 400, both fields indicated", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 0,
        usefulLifeYears: 0,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2099-03-10",
      },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const fields = body.error.fields ?? [];
    expect(fields.some((f) => f.field === "vehiclePrice")).toBe(true);
    expect(fields.some((f) => f.field === "usefulLifeYears")).toBe(true);
  });

  // AC-05: non-integer usefulLifeYears → 400
  it("AC-05: usefulLifeYears=2.5 (non-integer) → 400 VALIDATION_ERROR fields=[usefulLifeYears]", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 500000,
        usefulLifeYears: 2.5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2099-03-10",
      },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const fields = body.error.fields ?? [];
    expect(fields.some((f) => f.field === "usefulLifeYears")).toBe(true);
  });

  // AC-05: non-integer estimatedAnnualKm → 400
  it("AC-05: estimatedAnnualKm=1234.5 (non-integer) → 400 VALIDATION_ERROR fields=[estimatedAnnualKm]", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 500000,
        usefulLifeYears: 5,
        estimatedAnnualKm: 1234.5,
        effectiveFrom: "2099-03-10",
      },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const fields = body.error.fields ?? [];
    expect(fields.some((f) => f.field === "estimatedAnnualKm")).toBe(true);
  });

  // AC-06: missing effectiveFrom → 400
  it("AC-06: missing effectiveFrom → 400 VALIDATION_ERROR fields=[effectiveFrom]", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 500000,
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
      },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const fields = body.error.fields ?? [];
    expect(fields.some((f) => f.field === "effectiveFrom")).toBe(true);
  });

  // AC-06: invalid effectiveFrom string → 400
  it("AC-06: invalid effectiveFrom='not-a-date' → 400 VALIDATION_ERROR fields=[effectiveFrom]", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 500000,
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "not-a-date",
      },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const fields = body.error.fields ?? [];
    expect(fields.some((f) => f.field === "effectiveFrom")).toBe(true);
  });

  // AC-08: duplicate effectiveFrom → 409 PARAMETER_PERIOD_OVERLAP + conflictVersion
  it("AC-08: duplicate effectiveFrom → 409 PARAMETER_PERIOD_OVERLAP with conflictVersion", async () => {
    // First create
    const first = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 500000,
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2099-03-05",
      },
    });
    expect(first.statusCode).toBe(201);

    // Second create with same date → overlap
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 600000,
        usefulLifeYears: 6,
        estimatedAnnualKm: 25000,
        effectiveFrom: "2099-03-05",
      },
    });
    expect(resp.statusCode).toBe(409);
    const body = resp.json<{
      error: {
        code: string;
        details?: { conflictVersion?: { id: string; effectiveFrom: string } };
      };
    }>();
    expect(body.error.code).toBe("PARAMETER_PERIOD_OVERLAP");
    expect(body.error.details).toBeDefined();
    expect(body.error.details?.conflictVersion).toBeDefined();
    expect(body.error.details?.conflictVersion?.effectiveFrom).toBe("2099-03-05");
  });

  // AC-08: adjacent day (different date) → 201 allowed
  it("AC-08: adjacent effectiveFrom (next day) → 201 allowed", async () => {
    // Create 2099-03-20
    const first = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 500000,
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2099-03-20",
      },
    });
    expect(first.statusCode).toBe(201);

    // Create 2099-03-21 (next day, non-overlapping)
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 600000,
        usefulLifeYears: 6,
        estimatedAnnualKm: 25000,
        effectiveFrom: "2099-03-21",
      },
    });
    expect(resp.statusCode).toBe(201);
  });

  // AC-16: USER role → 403 FORBIDDEN
  it("AC-16: USER role → 403 FORBIDDEN", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: userCookie },
      payload: {
        vehiclePrice: 500000,
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2099-03-15",
      },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
  });

  // AC-17: unauthenticated → 401 UNAUTHORIZED
  it("AC-17: unauthenticated → 401 UNAUTHORIZED", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      payload: {
        vehiclePrice: 500000,
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2099-03-15",
      },
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  // mustChangePassword admin → 403 PASSWORD_CHANGE_REQUIRED
  it("mustChangePassword admin → 403 PASSWORD_CHANGE_REQUIRED", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: mcpCookie },
      payload: {
        vehiclePrice: 500000,
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2099-03-15",
      },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// GET /parameters/depreciation (AC-19)
// ---------------------------------------------------------------------------

describeWithDb("GET /parameters/depreciation", () => {
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

  // AC-19: list returns all versions sorted by effectiveFrom, each with derived
  it("AC-19: admin gets 200 list sorted by effectiveFrom, each version has derived", async () => {
    // Create two versions in reverse order to verify sort
    await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: "500000.00",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2099-03-15",
      },
    });
    await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: "600000.00",
        usefulLifeYears: 6,
        estimatedAnnualKm: 25000,
        effectiveFrom: "2099-03-10",
      },
    });

    const resp = await app.inject({
      method: "GET",
      url: "/parameters/depreciation",
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
        v.effectiveFrom >= "2099-03-01" &&
        v.effectiveFrom <= "2099-03-31"
    );
    expect(sentinelVersions.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < sentinelVersions.length; i++) {
      const curr = String(sentinelVersions[i].effectiveFrom ?? "");
      const prev = String(sentinelVersions[i - 1].effectiveFrom ?? "");
      expect(curr >= prev).toBe(true);
    }

    // Each version must have derived with annualDepreciation and perKmUnitPrice
    for (const v of sentinelVersions) {
      expect(v.id).toBeDefined();
      expect(v.vehiclePrice).toBeDefined();
      expect(v.usefulLifeYears).toBeDefined();
      expect(v.estimatedAnnualKm).toBeDefined();
      expect(v.effectiveFrom).toBeDefined();
      expect(v.createdAt).toBeDefined();
      expect(v.createdById).toBeUndefined(); // must not expose internal field
      const derived = v.derived as
        | { annualDepreciation: string; perKmUnitPrice: string }
        | undefined;
      expect(derived).toBeDefined();
      expect(derived?.annualDepreciation).toBeDefined();
      expect(derived?.perKmUnitPrice).toBeDefined();
    }
  });

  // Verify specific derived values in list (AC-12/13)
  it("AC-19: list derived values are correct for each version", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      versions: {
        vehiclePrice: string;
        usefulLifeYears: number;
        estimatedAnnualKm: number;
        effectiveFrom: string;
        derived: { annualDepreciation: string; perKmUnitPrice: string };
      }[];
    }>();

    // Find the version created in this test suite (2099-03-10)
    const v10 = body.versions.find((v) => v.effectiveFrom === "2099-03-10");
    if (v10) {
      // vehiclePrice=600000, years=6, km=25000
      // annualDepreciation = 600000 / 6 = 100000.00
      // perKmUnitPrice = 100000 / 25000 = 4.0000
      expect(v10.derived.annualDepreciation).toBe("100000.00");
      expect(v10.derived.perKmUnitPrice).toBe("4.0000");
    }

    const v15 = body.versions.find((v) => v.effectiveFrom === "2099-03-15");
    if (v15) {
      // vehiclePrice=500000, years=5, km=20000
      // annualDepreciation = 500000 / 5 = 100000.00
      // perKmUnitPrice = 100000 / 20000 = 5.0000
      expect(v15.derived.annualDepreciation).toBe("100000.00");
      expect(v15.derived.perKmUnitPrice).toBe("5.0000");
    }
  });

  // AC-16: USER role → 403 FORBIDDEN on GET
  it("AC-16: USER role → 403 FORBIDDEN on GET /parameters/depreciation", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/depreciation",
      headers: { cookie: userCookie },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
  });

  // AC-17: unauthenticated → 401
  it("AC-17: unauthenticated → 401 on GET /parameters/depreciation", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/depreciation",
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  // mustChangePassword admin → 403
  it("mustChangePassword admin → 403 PASSWORD_CHANGE_REQUIRED on GET /parameters/depreciation", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/parameters/depreciation",
      headers: { cookie: mcpCookie },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// Precision: vehiclePrice Decimal round-trip (D8)
// ---------------------------------------------------------------------------

describeWithDb("Precision: vehiclePrice Decimal round-trip (D8)", () => {
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

  it("vehiclePrice=123456.78 stored and returned without float imprecision", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: "123456.78",
        usefulLifeYears: 5,
        estimatedAnnualKm: 25000,
        effectiveFrom: "2099-03-28",
      },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ version: { vehiclePrice: string } }>();
    expect(String(body.version.vehiclePrice)).toBe("123456.78");
  });

  it("GET list: vehiclePrice precision is preserved after round-trip", async () => {
    await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: "987654.32",
        usefulLifeYears: 7,
        estimatedAnnualKm: 15000,
        effectiveFrom: "2099-03-29",
      },
    });

    const listResp = await app.inject({
      method: "GET",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
    });
    expect(listResp.statusCode).toBe(200);
    const body = listResp.json<{
      versions: { vehiclePrice: string; effectiveFrom: string }[];
    }>();
    const v = body.versions.find((x) => x.effectiveFrom === "2099-03-29");
    expect(v).toBeDefined();
    expect(String(v?.vehiclePrice)).toBe("987654.32");
  });

  it("derived is consistent across two calls (pure function, D7)", async () => {
    const post = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: "300000.00",
        usefulLifeYears: 4,
        estimatedAnnualKm: 30000,
        effectiveFrom: "2099-03-30",
      },
    });
    expect(post.statusCode).toBe(201);
    const postBody = post.json<{
      version: {
        effectiveFrom: string;
        derived: { annualDepreciation: string; perKmUnitPrice: string };
      };
    }>();

    const getResp = await app.inject({
      method: "GET",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
    });
    const getBody = getResp.json<{
      versions: {
        effectiveFrom: string;
        derived: { annualDepreciation: string; perKmUnitPrice: string };
      }[];
    }>();
    const v = getBody.versions.find((x) => x.effectiveFrom === "2099-03-30");
    expect(v).toBeDefined();
    // Both calls must return the same derived values
    expect(v?.derived.annualDepreciation).toBe(postBody.version.derived.annualDepreciation);
    expect(v?.derived.perKmUnitPrice).toBe(postBody.version.derived.perKmUnitPrice);
  });
});

// ---------------------------------------------------------------------------
// Concurrent defense: two POST with same effectiveFrom → second gets 409 not 500
// ---------------------------------------------------------------------------

describeWithDb("Concurrent defense: DB unique constraint → 409 not 500 (depreciation)", () => {
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

  it("two concurrent depreciation POSTs with same date → one 201, one 409 (never 500)", async () => {
    const [r1, r2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/parameters/depreciation",
        headers: { cookie: adminCookie },
        payload: {
          vehiclePrice: 500000,
          usefulLifeYears: 5,
          estimatedAnnualKm: 20000,
          effectiveFrom: "2099-03-25",
        },
      }),
      app.inject({
        method: "POST",
        url: "/parameters/depreciation",
        headers: { cookie: adminCookie },
        payload: {
          vehiclePrice: 600000,
          usefulLifeYears: 6,
          estimatedAnnualKm: 25000,
          effectiveFrom: "2099-03-25",
        },
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
});
