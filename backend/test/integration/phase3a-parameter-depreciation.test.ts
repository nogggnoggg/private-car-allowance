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
 *   AC-04: Create depreciation parameter, both values > 0 → 201 + DTO with derived
 *   AC-05: Any value ≤ 0 → 400 VALIDATION_ERROR, fields point exact violating field(s);
 *          response must NOT contain derived
 *   AC-06: missing/invalid effectiveFrom → 400 VALIDATION_ERROR fields=[effectiveFrom]
 *   AC-08: overlapping effectiveFrom → 409 PARAMETER_PERIOD_OVERLAP + conflictVersion
 *   AC-12: derived.annualDepreciation = round_half_up(vehiclePrice / usefulLifeYears, 2)
 *   AC-16: USER role → 403 FORBIDDEN
 *   AC-17: unauthenticated → 401 UNAUTHORIZED
 *   AC-19: GET list sorted by effectiveFrom; each version contains derived
 *
 * PHASE-007-R4b（Spec §20.3 AC-57、§20.7.5、§20.13 D20/D21/D22）——折舊參數縮欄
 * （凍結式）之測試遷移。**依已批准之 US 修訂更新既有斷言，非弱化測試**
 * （§20.11.1「測試遷移」之定義；005a §16 D1(a) 同型授權）：
 *   AC-57(a): POST 請求欄位集合縮為 { vehiclePrice, usefulLifeYears, effectiveFrom }；
 *             夾帶 estimatedAnnualKm **不採用**（新列該欄寫 NULL）且**不回 400**（D20）
 *   AC-57(b): 建立回應不含 estimatedAnnualKm／perKmUnitPrice 之值；含 annualDepreciation
 *   AC-57(c): GET 對歷史版本（estimatedAnnualKm != null）回原值與其 perKmUnitPrice
 *             （唯讀）；對新版本該二欄為 null
 *   AC-57(e): estimatedAnnualKm 之 ≤0／整數性驗證隨欄位退場而移除
 *             （原兩例 400 遷移為 201＋NULL，鑑別意圖以更強形式保留）
 *   PHASE-003a AC-13（perKmUnitPrice 之推導）於新版本已無適用對象；其引擎
 *   `deriveDepreciation` 行為凍結（AC-49(c)(d)），覆蓋面由歷史版本唯讀正例續存。
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

  // AC-04（PHASE-007-R4b／AC-57(a)(b) 後）：請求欄位集合縮為
  // `{ vehiclePrice, usefulLifeYears, effectiveFrom }`，兩值 > 0 → 201 + DTO with derived
  it("AC-04: admin creates depreciation → 201 with DTO including derived", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: "500000.00",
        usefulLifeYears: 5,
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
    // AC-57(a)/(c)：新版本之 `estimatedAnnualKm` 一律為 null（欄位已退場）
    expect(body.version.estimatedAnnualKm).toBeNull();
    expect(body.version.createdAt).toBeDefined();
    // DTO must NOT expose createdById
    expect(body.version.createdById).toBeUndefined();

    // Must include derived (AC-04, AC-12)
    const derived = body.version.derived as
      | { annualDepreciation: string; perKmUnitPrice: string | null }
      | undefined;
    expect(derived).toBeDefined();
    // 500000 / 5 = 100000.00
    expect(derived?.annualDepreciation).toBe("100000.00");
    // AC-57(b)：每公里補助單價已自新版本退場（無來源可推導）
    expect(derived?.perKmUnitPrice).toBeNull();
  });

  // AC-12: verify derived calculation with non-trivial values
  it("AC-12: derived calculation with rounding — vehiclePrice=100000, years=3", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: "100000.00",
        usefulLifeYears: 3,
        effectiveFrom: "2099-03-02",
      },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{
      version: { derived: { annualDepreciation: string; perKmUnitPrice: string | null } };
    }>();
    // 100000 / 3 = 33333.333... → round_half_up(2) = 33333.33
    expect(body.version.derived.annualDepreciation).toBe("33333.33");
    // AC-57(b)：perKmUnitPrice 退場
    expect(body.version.derived.perKmUnitPrice).toBeNull();
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
        effectiveFrom: "2099-03-10",
      },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const fields = body.error.fields ?? [];
    expect(fields.some((f) => f.field === "usefulLifeYears")).toBe(true);
  });

  // AC-57(e)（原「AC-05: estimatedAnnualKm=0 → 400」之 Spec 授權遷移）：
  // `estimatedAnnualKm` 之 `≤0` 驗證隨欄位退場而移除——**依 Spec 更新斷言，
  // 非弱化測試**（PHASE-007 Spec §20.3 AC-57(e)，比照 005a §16 D1(a) 授權）。
  // 原鑑別意圖（「非法的年里程值不得靜默寫入資料庫」）以更強的形式保留：
  // 該值**根本不再被寫入**（欄位為 NULL），故本例斷言 201＋NULL 而非 400。
  it("AC-57(e): 夾帶 estimatedAnnualKm=0（原 ≤0 違規值）→ 201，且該欄不被採用（DB 寫 NULL）", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 500000,
        usefulLifeYears: 5,
        estimatedAnnualKm: 0,
        effectiveFrom: "2099-03-11",
      },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ version: { id: string; estimatedAnnualKm: unknown } }>();
    expect(body.version.estimatedAnnualKm).toBeNull();

    const row = await prisma.depreciationParameterVersion.findUnique({
      where: { id: body.version.id },
    });
    expect(row?.estimatedAnnualKm).toBeNull();
  });

  // AC-57(e)（原「AC-05: estimatedAnnualKm=1234.5（非整數）→ 400」之 Spec 授權遷移；
  // 同上，整數性驗證隨欄位退場而移除，且非整數值同樣不可能抵達 DB）
  it("AC-57(e): 夾帶 estimatedAnnualKm=1234.5（原非整數違規值）→ 201，且該欄不被採用（DB 寫 NULL）", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: 500000,
        usefulLifeYears: 5,
        estimatedAnnualKm: 1234.5,
        effectiveFrom: "2099-03-12",
      },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ version: { id: string; estimatedAnnualKm: unknown } }>();
    expect(body.version.estimatedAnnualKm).toBeNull();

    const row = await prisma.depreciationParameterVersion.findUnique({
      where: { id: body.version.id },
    });
    expect(row?.estimatedAnnualKm).toBeNull();
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
        effectiveFrom: "2099-03-10",
      },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const fields = body.error.fields ?? [];
    expect(fields.some((f) => f.field === "usefulLifeYears")).toBe(true);
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
        effectiveFrom: "2099-03-15",
      },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  // -------------------------------------------------------------------------
  // AC-57 折舊參數縮欄（凍結式）—— PHASE-007-R4b
  // -------------------------------------------------------------------------

  it("AC-57 折舊參數縮欄（凍結式）: POST no longer accepts estimatedAnnualKm (夾帶不採用，欄位寫 NULL) and no longer returns perKmUnitPrice", async () => {
    // (1) 縮欄後之正常請求：僅三欄
    const clean = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: "1200000.00",
        usefulLifeYears: 6,
        effectiveFrom: "2099-03-06",
      },
    });
    expect(clean.statusCode).toBe(201);
    const cleanBody = clean.json<{
      version: {
        id: string;
        estimatedAnnualKm: unknown;
        derived: { annualDepreciation: string; perKmUnitPrice: unknown };
      };
    }>();
    // AC-57(b)：含 annualDepreciation——**數值級**斷言（1200000 / 6 = 200000.00）。
    // 僅斷言「鍵存在」會讓推導失敗之 fail-open（"0.00"）靜默通過。
    expect(cleanBody.version.derived.annualDepreciation).toBe("200000.00");
    // AC-57(b)：不含 estimatedAnnualKm 與 perKmUnitPrice 之值
    expect(cleanBody.version.estimatedAnnualKm).toBeNull();
    expect(cleanBody.version.derived.perKmUnitPrice).toBeNull();
    // 回應之鍵集封閉：不得出現任何頂層 estimatedAnnualKm 以外的洩漏鍵
    expect(Object.keys(cleanBody.version.derived).sort()).toEqual([
      "annualDepreciation",
      "perKmUnitPrice",
    ]);

    // (2) D20：夾帶 estimatedAnnualKm → **不採用**、**不回 400**、DB 寫 NULL
    const smuggled = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: "1200000.00",
        usefulLifeYears: 6,
        estimatedAnnualKm: 99999,
        effectiveFrom: "2099-03-07",
      },
    });
    expect(smuggled.statusCode).toBe(201);
    const smuggledBody = smuggled.json<{
      version: {
        id: string;
        estimatedAnnualKm: unknown;
        derived: { annualDepreciation: string; perKmUnitPrice: unknown };
      };
    }>();
    expect(smuggledBody.version.estimatedAnnualKm).toBeNull();
    expect(smuggledBody.version.derived.perKmUnitPrice).toBeNull();
    expect(smuggledBody.version.derived.annualDepreciation).toBe("200000.00");

    // 持久層證明：夾帶值 99999 絕不得落地
    const row = await prisma.depreciationParameterVersion.findUnique({
      where: { id: smuggledBody.version.id },
    });
    expect(row).not.toBeNull();
    expect(row?.estimatedAnnualKm).toBeNull();

    // (3) 稽核 summary 亦不含該欄（欄位集合縮欄；summary 與回應 DTO 為兩份契約，
    //     但兩者皆不得持有一個永遠為 null 的退場欄）
    const audit = await prisma.auditLog.findFirst({
      where: { targetLabel: `DEPRECIATION#${smuggledBody.version.id}` },
    });
    expect(audit).not.toBeNull();
    expect(Object.keys(audit?.summary as Record<string, unknown>).sort()).toEqual([
      "effectiveFrom",
      "parameterType",
      "usefulLifeYears",
      "vehiclePrice",
    ]);
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
    // AC-57(c)：本 describe 之版本皆由縮欄後之端點建立（＝新版本），故
    // `estimatedAnnualKm` 與 `derived.perKmUnitPrice` 必為 **null**（非僅「已定義」——
    // `toBeDefined()` 對 null 恆真，無鑑別力）。
    for (const v of sentinelVersions) {
      expect(v.id).toBeDefined();
      expect(v.vehiclePrice).toBeDefined();
      expect(v.usefulLifeYears).toBeDefined();
      expect(v.effectiveFrom).toBeDefined();
      expect(v.createdAt).toBeDefined();
      expect(v.createdById).toBeUndefined(); // must not expose internal field
      const derived = v.derived as
        | { annualDepreciation: string; perKmUnitPrice: string | null }
        | undefined;
      expect(derived).toBeDefined();
      expect(typeof derived?.annualDepreciation).toBe("string");
      if (v.estimatedAnnualKm === null) {
        expect(derived?.perKmUnitPrice).toBeNull();
      } else {
        // 歷史版本（本 describe 內由 AC-57 唯讀測試播種者）：兩欄同時為原值
        expect(typeof derived?.perKmUnitPrice).toBe("string");
      }
    }
  });

  // Verify specific derived values in list (AC-12；AC-57(b)(c) 後 perKmUnitPrice 為 null)
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
        estimatedAnnualKm: number | null;
        effectiveFrom: string;
        derived: { annualDepreciation: string; perKmUnitPrice: string | null };
      }[];
    }>();

    // Find the version created in this test suite (2099-03-10)
    const v10 = body.versions.find((v) => v.effectiveFrom === "2099-03-10");
    expect(v10).toBeDefined();
    // vehiclePrice=600000, years=6 → annualDepreciation = 600000 / 6 = 100000.00
    expect(v10?.derived.annualDepreciation).toBe("100000.00");
    expect(v10?.estimatedAnnualKm).toBeNull();
    expect(v10?.derived.perKmUnitPrice).toBeNull();

    const v15 = body.versions.find((v) => v.effectiveFrom === "2099-03-15");
    expect(v15).toBeDefined();
    // vehiclePrice=500000, years=5 → annualDepreciation = 500000 / 5 = 100000.00
    expect(v15?.derived.annualDepreciation).toBe("100000.00");
    expect(v15?.estimatedAnnualKm).toBeNull();
    expect(v15?.derived.perKmUnitPrice).toBeNull();
  });

  // -------------------------------------------------------------------------
  // AC-57(c) 歷史版本唯讀 —— PHASE-007-R4b
  // -------------------------------------------------------------------------

  it("AC-57: GET still returns the original estimatedAnnualKm/perKmUnitPrice for legacy versions (read-only) and null for new versions", async () => {
    // 歷史版本（縮欄前建立者）：直接播種一列帶 estimatedAnnualKm 的資料。
    // 縮欄後之端點已無從產生此形狀，故以 prisma 播種為唯一可行手段
    // （欄位為 nullable，Prisma client 型別可表達此列，無須 raw SQL）。
    const legacy = await prisma.depreciationParameterVersion.create({
      data: {
        vehiclePrice: "600000.00",
        usefulLifeYears: 6,
        estimatedAnnualKm: 25000,
        effectiveFrom: new Date("2099-03-18"),
        createdById: users.adminId,
      },
    });

    // 新版本（縮欄後由端點建立）
    const created = await app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: {
        vehiclePrice: "600000.00",
        usefulLifeYears: 6,
        effectiveFrom: "2099-03-19",
      },
    });
    expect(created.statusCode).toBe(201);

    const resp = await app.inject({
      method: "GET",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      versions: {
        id: string;
        effectiveFrom: string;
        estimatedAnnualKm: number | null;
        derived: { annualDepreciation: string; perKmUnitPrice: string | null };
      }[];
    }>();

    // 正例：歷史版本回**原值**與其 perKmUnitPrice（唯讀）
    const legacyDto = body.versions.find((v) => v.id === legacy.id);
    expect(legacyDto).toBeDefined();
    expect(legacyDto?.estimatedAnnualKm).toBe(25000);
    // 600000 / 6 = 100000.00；100000 / 25000 = 4.0000（原值，不得被重算為 null）
    expect(legacyDto?.derived.annualDepreciation).toBe("100000.00");
    expect(legacyDto?.derived.perKmUnitPrice).toBe("4.0000");

    // 負例：同車價／同年限之**新版本**該二欄為 null——
    // 兩列的 annualDepreciation 相同而該二欄互異，證明差異來自「列的 estimatedAnnualKm
    // 是否為 NULL」，而非車價／年限。
    const newDto = body.versions.find((v) => v.effectiveFrom === "2099-03-19");
    expect(newDto).toBeDefined();
    expect(newDto?.estimatedAnnualKm).toBeNull();
    expect(newDto?.derived.annualDepreciation).toBe("100000.00");
    expect(newDto?.derived.perKmUnitPrice).toBeNull();
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
        effectiveFrom: "2099-03-30",
      },
    });
    expect(post.statusCode).toBe(201);
    const postBody = post.json<{
      version: {
        effectiveFrom: string;
        derived: { annualDepreciation: string; perKmUnitPrice: string | null };
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
        derived: { annualDepreciation: string; perKmUnitPrice: string | null };
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
