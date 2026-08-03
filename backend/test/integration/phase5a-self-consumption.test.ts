/**
 * Integration tests for PHASE-005a-T6:
 *   GET /me/fuel-consumption — self read-only current fuel-consumption version
 *
 * Spec §2.C AC-15/16/17, §7.3, §16 D7(a).
 *
 * TDD: written BEFORE the `/me/fuel-consumption` route existed on
 * `fuelConsumptionPlugin` — first run was RED (404, route not registered).
 * GREEN after the route landed (this same Task, same commit as the route).
 *
 * Coverage:
 *   AC-15 — logged-in user with a today-effective version → 200
 *           { current: { fuelType, kmPerLiter, effectiveFrom } }, exact
 *           key-set whitelist (top-level keys === ["current"]; current's
 *           inner keys === ["fuelType","kmPerLiter","effectiveFrom"]) — never
 *           basisNote/id/createdById/state/userId, never history/future rows.
 *   AC-16 — zero versions, and versions-all-in-the-future, both → 200
 *           { current: null } (never 404/500/empty-string/NaN).
 *   AC-17 — query-string userId, JSON-body userId, and an extra path segment
 *           can never surface another user's data: the response with such
 *           tampering attached is byte-identical to the response without it,
 *           and a discriminating control user (a DIFFERENT user with their
 *           OWN today-effective version) never appears in the caller's
 *           response.
 *   AC-36 — 5-cell self-read-only column of the matrix (未登入 401 / PCR 403 /
 *           一般使用者 200(自己) / 管理員 200(自己) / 停用帳號 401).
 *
 * Requires a running Postgres instance with migrations applied.
 * DATABASE_URL env var must be set; tests skip otherwise.
 *
 * Isolation: every fixture user created here uses loginName prefix
 * "t6selfconsumption_"; `UserFuelConsumptionVersion` rows are scoped by
 * `userId` — cleanup deletes by userId, no global deleteMany.
 */

import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Shared helpers (identical convention to phase5a-fuel-consumption-authz.test.ts)
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

/** YYYY-MM-DD (UTC) offset from today by `days` (may be negative). */
function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const SUFFIX = Date.now();
const PASSWORD = "AdminTest99!";

const ADMIN_LOGIN = `t6selfconsumption_admin_${SUFFIX}`;
const MCP_ADMIN_LOGIN = `t6selfconsumption_mcpadmin_${SUFFIX}`;
const USER1_LOGIN = `t6selfconsumption_user1_${SUFFIX}`;
const USER2_LOGIN = `t6selfconsumption_user2_${SUFFIX}`; // AC-17 discriminating control
const DEACTIVATED_LOGIN = `t6selfconsumption_deact_${SUFFIX}`;
const EMPTY_USER_LOGIN = `t6selfconsumption_empty_${SUFFIX}`; // AC-16 zero versions
const FUTURE_ONLY_LOGIN = `t6selfconsumption_futureonly_${SUFFIX}`; // AC-16 future-only

interface TestUsers {
  adminId: string;
  mcpAdminId: string;
  user1Id: string;
  user2Id: string;
  deactivatedId: string;
  emptyUserId: string;
  futureOnlyUserId: string;
}

async function setupUsers(prisma: PrismaClient): Promise<TestUsers> {
  const hash = await hashPassword(PASSWORD);

  const admin = await prisma.user.create({
    data: {
      loginName: ADMIN_LOGIN,
      displayName: "T6 Admin",
      passwordHash: hash,
      role: "ADMIN",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const mcpAdmin = await prisma.user.create({
    data: {
      loginName: MCP_ADMIN_LOGIN,
      displayName: "T6 MCP Admin",
      passwordHash: hash,
      role: "ADMIN",
      isActive: true,
      mustChangePassword: true,
    },
  });

  const user1 = await prisma.user.create({
    data: {
      loginName: USER1_LOGIN,
      displayName: "T6 Normal User 1 (self)",
      passwordHash: hash,
      role: "USER",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const user2 = await prisma.user.create({
    data: {
      loginName: USER2_LOGIN,
      displayName: "T6 Normal User 2 (discriminating control)",
      passwordHash: hash,
      role: "USER",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const deactivated = await prisma.user.create({
    data: {
      loginName: DEACTIVATED_LOGIN,
      displayName: "T6 To-Be-Deactivated User",
      passwordHash: hash,
      role: "USER",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const emptyUser = await prisma.user.create({
    data: {
      loginName: EMPTY_USER_LOGIN,
      displayName: "T6 Zero-Version User",
      passwordHash: hash,
      role: "USER",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const futureOnlyUser = await prisma.user.create({
    data: {
      loginName: FUTURE_ONLY_LOGIN,
      displayName: "T6 Future-Only-Version User",
      passwordHash: hash,
      role: "USER",
      isActive: true,
      mustChangePassword: false,
    },
  });

  return {
    adminId: admin.id,
    mcpAdminId: mcpAdmin.id,
    user1Id: user1.id,
    user2Id: user2.id,
    deactivatedId: deactivated.id,
    emptyUserId: emptyUser.id,
    futureOnlyUserId: futureOnlyUser.id,
  };
}

async function cleanupAll(prisma: PrismaClient, userIds: string[]): Promise<void> {
  if (userIds.length > 0) {
    await prisma.userFuelConsumptionVersion.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

// ---------------------------------------------------------------------------
// Shared app/users across all describes in this file
// ---------------------------------------------------------------------------

describeWithDb("PHASE-005a-T6 — GET /me/fuel-consumption", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let users: TestUsers;
  let adminCookie: string;
  let mcpCookie: string;
  let user1Cookie: string;
  let user2Cookie: string;
  let deactivatedCookie: string;
  let emptyUserCookie: string;
  let futureOnlyCookie: string;

  const USER1_EFFECTIVE_FROM = isoDateOffset(-10);
  const USER1_FUEL_TYPE = "GASOLINE_95";
  const USER1_KM_PER_LITER = "12.3400";

  const USER2_EFFECTIVE_FROM = isoDateOffset(-20);
  const USER2_FUEL_TYPE = "DIESEL";
  const USER2_KM_PER_LITER = "8.7600"; // deliberately distinct from user1's value

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    users = await setupUsers(prisma);
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    adminCookie = await loginUser(app, ADMIN_LOGIN, PASSWORD);
    mcpCookie = await loginUser(app, MCP_ADMIN_LOGIN, PASSWORD);
    user1Cookie = await loginUser(app, USER1_LOGIN, PASSWORD);
    user2Cookie = await loginUser(app, USER2_LOGIN, PASSWORD);
    emptyUserCookie = await loginUser(app, EMPTY_USER_LOGIN, PASSWORD);
    futureOnlyCookie = await loginUser(app, FUTURE_ONLY_LOGIN, PASSWORD);

    // Login while still active, THEN deactivate.
    deactivatedCookie = await loginUser(app, DEACTIVATED_LOGIN, PASSWORD);
    await prisma.user.update({
      where: { id: users.deactivatedId },
      data: { isActive: false },
    });

    // Seed user1's today-effective version (via the already-GREEN admin
    // write endpoint from T5 — out of scope for T6 but the only sanctioned
    // way to create rows).
    const user1Resp = await app.inject({
      method: "POST",
      url: `/users/${users.user1Id}/fuel-consumption`,
      headers: { cookie: adminCookie },
      payload: {
        fuelType: USER1_FUEL_TYPE,
        kmPerLiter: USER1_KM_PER_LITER,
        effectiveFrom: USER1_EFFECTIVE_FROM,
        basisNote: "T6 AC-15 fixture (user1, must never leak basisNote)",
      },
    });
    if (user1Resp.statusCode !== 201) {
      throw new Error(`Fixture setup failed for user1: ${user1Resp.statusCode} ${user1Resp.body}`);
    }

    // Seed user2's DIFFERENT today-effective version — AC-17 discriminating
    // control: if the route ever leaked another user's data, this distinct
    // fuelType/kmPerLiter/effectiveFrom would surface in user1's response.
    const user2Resp = await app.inject({
      method: "POST",
      url: `/users/${users.user2Id}/fuel-consumption`,
      headers: { cookie: adminCookie },
      payload: {
        fuelType: USER2_FUEL_TYPE,
        kmPerLiter: USER2_KM_PER_LITER,
        effectiveFrom: USER2_EFFECTIVE_FROM,
        basisNote: "T6 AC-17 discriminating control (user2, must never leak to user1)",
      },
    });
    if (user2Resp.statusCode !== 201) {
      throw new Error(`Fixture setup failed for user2: ${user2Resp.statusCode} ${user2Resp.body}`);
    }

    // Seed futureOnlyUser's version with effectiveFrom strictly in the
    // future — AC-16's second empty-state scenario.
    const futureResp = await app.inject({
      method: "POST",
      url: `/users/${users.futureOnlyUserId}/fuel-consumption`,
      headers: { cookie: adminCookie },
      payload: {
        fuelType: "GASOLINE_92",
        kmPerLiter: "15.0000",
        effectiveFrom: isoDateOffset(30),
        basisNote: "T6 AC-16 future-only fixture",
      },
    });
    if (futureResp.statusCode !== 201) {
      throw new Error(
        `Fixture setup failed for futureOnlyUser: ${futureResp.statusCode} ${futureResp.body}`
      );
    }
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await cleanupAll(prisma, [
        users.adminId,
        users.mcpAdminId,
        users.user1Id,
        users.user2Id,
        users.deactivatedId,
        users.emptyUserId,
        users.futureOnlyUserId,
      ]);
      await prisma.$disconnect();
    }
  });

  // -------------------------------------------------------------------------
  // AC-15 — self read, exact key-set whitelist
  // -------------------------------------------------------------------------

  describe("AC-15 自身唯讀 — 今日有生效版本", () => {
    it("returns exactly { current: { fuelType, kmPerLiter, effectiveFrom } } for the current version (key-set equality)", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/me/fuel-consumption",
        headers: { cookie: user1Cookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ current: Record<string, unknown> | null }>();

      // Top-level key-set whitelist: exactly ["current"].
      expect(Object.keys(body).sort()).toEqual(["current"]);

      expect(body.current).not.toBeNull();
      const current = body.current as Record<string, unknown>;

      // Inner key-set whitelist: exactly these three keys — one extra key
      // is a fail (§7.3 鍵集合封閉).
      expect(Object.keys(current).sort()).toEqual(
        ["effectiveFrom", "fuelType", "kmPerLiter"].sort()
      );

      expect(current.fuelType).toBe(USER1_FUEL_TYPE);
      expect(current.kmPerLiter).toBe(USER1_KM_PER_LITER);
      expect(current.effectiveFrom).toBe(USER1_EFFECTIVE_FROM);
    });

    it("never exposes basisNote / id / createdById / state / userId / other users' data", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/me/fuel-consumption",
        headers: { cookie: user1Cookie },
      });
      expect(resp.statusCode).toBe(200);
      const raw = resp.body;

      // Sensitive/forbidden-field substring scan on the raw serialized body.
      expect(raw).not.toContain("basisNote");
      expect(raw).not.toContain("createdById");
      expect(raw).not.toContain('"id"');
      expect(raw).not.toContain('"state"');
      expect(raw).not.toContain('"userId"');

      // AC-17 discriminating-control values must never appear either.
      expect(raw).not.toContain(USER2_KM_PER_LITER);
      expect(raw).not.toContain(USER2_EFFECTIVE_FROM);
    });
  });

  // -------------------------------------------------------------------------
  // AC-16 — empty state
  // -------------------------------------------------------------------------

  describe("AC-16 空狀態", () => {
    it("user without any version returns 200 { current: null } (not 404)", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/me/fuel-consumption",
        headers: { cookie: emptyUserCookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ current: unknown }>();
      expect(Object.keys(body).sort()).toEqual(["current"]);
      expect(body.current).toBeNull();
    });

    it("only-future versions also yield current: null", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/me/fuel-consumption",
        headers: { cookie: futureOnlyCookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ current: unknown }>();
      expect(body.current).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // AC-17 — cannot become a channel for other users' data
  // -------------------------------------------------------------------------

  describe("AC-17 不得成為他人資料通道", () => {
    it("baseline: user1's own response (for byte-identical comparison below)", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/me/fuel-consumption",
        headers: { cookie: user1Cookie },
      });
      expect(resp.statusCode).toBe(200);
      expect(resp.json<{ current: { fuelType: string } }>().current?.fuelType).toBe(
        USER1_FUEL_TYPE
      );
    });

    it("query-string userId tampering (?userId=他人) never returns another user's data — response identical to baseline", async () => {
      const baseline = await app.inject({
        method: "GET",
        url: "/me/fuel-consumption",
        headers: { cookie: user1Cookie },
      });
      const tampered = await app.inject({
        method: "GET",
        url: `/me/fuel-consumption?userId=${users.user2Id}`,
        headers: { cookie: user1Cookie },
      });
      expect(tampered.statusCode).toBe(200);
      expect(tampered.body).toBe(baseline.body);

      const body = tampered.json<{ current: { fuelType: string; kmPerLiter: string } }>();
      expect(body.current?.fuelType).toBe(USER1_FUEL_TYPE);
      expect(body.current?.kmPerLiter).not.toBe(USER2_KM_PER_LITER);
    });

    it("query-string ownerId tampering (?ownerId=他人) never returns another user's data — response identical to baseline", async () => {
      const baseline = await app.inject({
        method: "GET",
        url: "/me/fuel-consumption",
        headers: { cookie: user1Cookie },
      });
      const tampered = await app.inject({
        method: "GET",
        url: `/me/fuel-consumption?ownerId=${users.user2Id}`,
        headers: { cookie: user1Cookie },
      });
      expect(tampered.statusCode).toBe(200);
      expect(tampered.body).toBe(baseline.body);
    });

    // SF-2（T6R 即審澄清）: Fastify 不解析 GET 方法的 body（wire 探針證實：
    // 未登入 + 此處同款畸形/夾帶 body 一律先被判 401，從未進入 body 解析或
    // handler 邏輯）——本測試對「body 是否真的影響回應」這件事本身不具
    // 鑑別力（對任何實作恆綠）。保留本測試僅為釘住「夾帶 body 不改變回應」
    // 之現狀；此現狀的真正保證來源是**結構性**的兩層防線：(1) handler
    // 完全不讀取 request.body 的任何欄位（見上方 handler 實作與檔頭 JSDoc），
    // (2) Fastify 框架層對 GET 請求根本不解析 body——兩者疊加，而非本測試
    // 提供的執行期驗證。
    it("GET body 向量在 wire 層即不可達（Fastify 不解析 GET body）；本測試僅釘住『夾帶 body 不改變回應』之現狀", async () => {
      const baseline = await app.inject({
        method: "GET",
        url: "/me/fuel-consumption",
        headers: { cookie: user1Cookie },
      });
      const tampered = await app.inject({
        method: "GET",
        url: "/me/fuel-consumption",
        headers: { cookie: user1Cookie, "content-type": "application/json" },
        payload: { userId: users.user2Id, ownerId: users.user2Id },
      });
      expect(tampered.statusCode).toBe(200);
      expect(tampered.body).toBe(baseline.body);
    });

    it("path tampering (/me/fuel-consumption/他人ID) is structurally unreachable — 404, not another user's data", async () => {
      const resp = await app.inject({
        method: "GET",
        url: `/me/fuel-consumption/${users.user2Id}`,
        headers: { cookie: user1Cookie },
      });
      // No such route is registered (no :userId/:id path param on /me/fuel-consumption)
      // — Fastify's own 404, not a business-logic decision, and definitely
      // not another user's data.
      expect(resp.statusCode).toBe(404);
      expect(resp.body).not.toContain(USER2_KM_PER_LITER);
      expect(resp.body).not.toContain(USER2_EFFECTIVE_FROM);
    });

    it("discriminating control: user2 reading their OWN self endpoint gets user2's data (proves the route works at all, and user1/user2 are genuinely distinct fixtures)", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/me/fuel-consumption",
        headers: { cookie: user2Cookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ current: { fuelType: string; kmPerLiter: string } }>();
      expect(body.current?.fuelType).toBe(USER2_FUEL_TYPE);
      expect(body.current?.kmPerLiter).toBe(USER2_KM_PER_LITER);
    });
  });

  // -------------------------------------------------------------------------
  // AC-36 — 5-cell self-read-only column
  // -------------------------------------------------------------------------

  describe("AC-36 授權矩陣（自身唯讀欄 × 5 身分 = 5 必要格，T6 補齊）", () => {
    it("AC-36[未登入 × 自身唯讀] → 401 UNAUTHORIZED", async () => {
      const resp = await app.inject({ method: "GET", url: "/me/fuel-consumption" });
      expect(resp.statusCode).toBe(401);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
    });

    it("AC-36[PCR × 自身唯讀] → 403 PASSWORD_CHANGE_REQUIRED", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/me/fuel-consumption",
        headers: { cookie: mcpCookie },
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    });

    it("AC-36[一般使用者 × 自身唯讀] → 200 (自己)", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/me/fuel-consumption",
        headers: { cookie: user1Cookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ current: { fuelType: string } }>();
      expect(body.current?.fuelType).toBe(USER1_FUEL_TYPE);
    });

    it("AC-36[管理員 × 自身唯讀] → 200 (自己，即使管理員本身無版本亦回 current: null 而非錯誤)", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/me/fuel-consumption",
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ current: unknown }>();
      expect(Object.keys(body).sort()).toEqual(["current"]);
      expect(body.current).toBeNull();
    });

    it("AC-36[停用帳號 × 自身唯讀] → 401 UNAUTHORIZED", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/me/fuel-consumption",
        headers: { cookie: deactivatedCookie },
      });
      expect(resp.statusCode).toBe(401);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
    });
  });
});
