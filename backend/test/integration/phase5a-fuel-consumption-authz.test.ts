/**
 * Integration tests for PHASE-005a-T5:
 *   User fuel-consumption ROUTE layer — authorization matrix, audit, state
 *
 * Spec §2.B AC-12/13/14, §2.G AC-36, §7.2, §16 D7(a)/D8(a).
 *
 * TDD: written BEFORE `fuel-consumption-routes.ts` was registered in
 * `server.ts` — first run was RED (404, route not registered). GREEN after
 * the plugin landed.
 *
 * Coverage:
 *   AC-12 — GET list: ascending by effectiveFrom (out-of-order insertion,
 *           AR-5 discriminating power), HISTORICAL/CURRENT/FUTURE relative to
 *           today, empty array (not 404) for a user with no versions, 404 for
 *           an unknown userId.
 *   AC-13 — normal users (including userId=self) get 403 FORBIDDEN on every
 *           write endpoint, zero DB writes (row count + max(createdAt)
 *           unchanged — this table has no `updatedAt` column, being
 *           append-only, so count+max(createdAt) is the available proxy for
 *           "zero writes"), 401 unauthenticated, 403 PASSWORD_CHANGE_REQUIRED
 *           for mustChangePassword=true, and no side-channel between a
 *           malformed and a well-formed body when authorization fails first.
 *   AC-14 — AuditLog row per successful create; before/after exact shape;
 *           before=null for the first version; the AR-5-adjacent "before"
 *           strict-less-than discriminating test (new version created
 *           EARLIER than an existing one must get before=null, not the
 *           existing version's own snapshot — see hook warning in the
 *           Packet); no password/token/cookie substrings; rollback stub
 *           (audit failure aborts the whole create).
 *   AC-36 — 15-cell authorization matrix for T5's three columns (write
 *           other's, write own, read other's via the admin GET endpoint).
 *   AR-4  — P2002 with `meta.target` pointing at an unrelated constraint is
 *           NOT translated to 409 (rethrown as-is), proving the fix does not
 *           over-eagerly swallow unrelated unique-constraint errors.
 *
 * Requires a running Postgres instance with migrations applied.
 * DATABASE_URL env var must be set; tests skip otherwise.
 *
 * Isolation: every fixture user created here uses loginName prefix
 * "t5fuelconsumption_"; `UserFuelConsumptionVersion` rows are scoped by
 * `userId` (not a global date range) since the table already has an owner
 * column — cleanup deletes by userId, no global deleteMany.
 */

import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";
import * as fuelConsumptionService from "../../src/users/fuel-consumption-service.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Shared helpers (identical convention to phase5a-fuel-price.test.ts /
// phase5a-fuel-consumption.test.ts)
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

const ADMIN_LOGIN = `t5fuelconsumption_admin_${SUFFIX}`;
const MCP_ADMIN_LOGIN = `t5fuelconsumption_mcpadmin_${SUFFIX}`;
const USER1_LOGIN = `t5fuelconsumption_user1_${SUFFIX}`;
const USER2_LOGIN = `t5fuelconsumption_user2_${SUFFIX}`;
const DEACTIVATED_LOGIN = `t5fuelconsumption_deact_${SUFFIX}`;

interface TestUsers {
  adminId: string;
  mcpAdminId: string;
  user1Id: string;
  user2Id: string;
  deactivatedId: string;
}

async function setupUsers(prisma: PrismaClient): Promise<TestUsers> {
  const hash = await hashPassword(PASSWORD);

  const admin = await prisma.user.create({
    data: {
      loginName: ADMIN_LOGIN,
      displayName: "T5 Admin",
      passwordHash: hash,
      role: "ADMIN",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const mcpAdmin = await prisma.user.create({
    data: {
      loginName: MCP_ADMIN_LOGIN,
      displayName: "T5 MCP Admin",
      passwordHash: hash,
      role: "ADMIN",
      isActive: true,
      mustChangePassword: true,
    },
  });

  const user1 = await prisma.user.create({
    data: {
      loginName: USER1_LOGIN,
      displayName: "T5 Normal User 1",
      passwordHash: hash,
      role: "USER",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const user2 = await prisma.user.create({
    data: {
      loginName: USER2_LOGIN,
      displayName: "T5 Normal User 2 (target)",
      passwordHash: hash,
      role: "USER",
      isActive: true,
      mustChangePassword: false,
    },
  });

  // Created active so login succeeds; deactivated AFTER login in the test
  // that needs the "停用帳號" row (Spec §2.G row 5) — mirrors
  // middleware.test.ts's "Spec-4.7 double-check" pattern.
  const deactivated = await prisma.user.create({
    data: {
      loginName: DEACTIVATED_LOGIN,
      displayName: "T5 To-Be-Deactivated Admin",
      passwordHash: hash,
      role: "ADMIN",
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

describeWithDb("PHASE-005a-T5 — /users/:userId/fuel-consumption route layer", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let users: TestUsers;
  let adminCookie: string;
  let mcpCookie: string;
  let user1Cookie: string;
  let deactivatedCookie: string;

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

    // Login while still active, THEN deactivate (Spec row: 停用帳號 → 401
    // across every column, regardless of what role the account used to be).
    deactivatedCookie = await loginUser(app, DEACTIVATED_LOGIN, PASSWORD);
    await prisma.user.update({
      where: { id: users.deactivatedId },
      data: { isActive: false },
    });
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
      ]);
      await prisma.$disconnect();
    }
  });

  // -------------------------------------------------------------------------
  // AC-36 — 15-cell authorization matrix (T5's three columns: 油耗寫入(他人)
  // / 油耗寫入(自己) / 油耗讀取(他人，管理端點))
  // -------------------------------------------------------------------------

  describe("AC-36 授權矩陣（T5 三欄 × 5 身分 = 15 必要格）", () => {
    // ---- Row: 未登入 ----

    it("AC-36[未登入 × 油耗寫入(他人)] → 401 UNAUTHORIZED", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/users/${users.user2Id}/fuel-consumption`,
        payload: {
          fuelType: "GASOLINE_95",
          kmPerLiter: "12.0000",
          effectiveFrom: "2026-02-01",
          basisNote: "matrix",
        },
      });
      expect(resp.statusCode).toBe(401);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
    });

    it("AC-36[未登入 × 油耗寫入(自己)] → 401 UNAUTHORIZED", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/users/${users.user1Id}/fuel-consumption`,
        payload: {
          fuelType: "GASOLINE_95",
          kmPerLiter: "12.0000",
          effectiveFrom: "2026-02-02",
          basisNote: "matrix",
        },
      });
      expect(resp.statusCode).toBe(401);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
    });

    it("AC-36[未登入 × 油耗讀取(他人，管理端點)] → 401 UNAUTHORIZED", async () => {
      const resp = await app.inject({
        method: "GET",
        url: `/users/${users.user2Id}/fuel-consumption`,
      });
      expect(resp.statusCode).toBe(401);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
    });

    // ---- Row: mustChangePassword=true ----

    it("AC-36[PCR × 油耗寫入(他人)] → 403 PASSWORD_CHANGE_REQUIRED", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/users/${users.user2Id}/fuel-consumption`,
        headers: { cookie: mcpCookie },
        payload: {
          fuelType: "GASOLINE_95",
          kmPerLiter: "12.0000",
          effectiveFrom: "2026-02-03",
          basisNote: "matrix",
        },
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    });

    it("AC-36[PCR × 油耗寫入(自己)] → 403 PASSWORD_CHANGE_REQUIRED", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/users/${users.mcpAdminId}/fuel-consumption`,
        headers: { cookie: mcpCookie },
        payload: {
          fuelType: "GASOLINE_95",
          kmPerLiter: "12.0000",
          effectiveFrom: "2026-02-04",
          basisNote: "matrix",
        },
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    });

    it("AC-36[PCR × 油耗讀取(他人，管理端點)] → 403 PASSWORD_CHANGE_REQUIRED", async () => {
      const resp = await app.inject({
        method: "GET",
        url: `/users/${users.user2Id}/fuel-consumption`,
        headers: { cookie: mcpCookie },
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    });

    // ---- Row: 一般使用者 (bold cells — AC-13's core, with zero-write proof) ----

    it("AC-36[一般使用者 × 油耗寫入(他人)] → 403 FORBIDDEN, zero DB writes", async () => {
      const before = await prisma.userFuelConsumptionVersion.aggregate({
        where: { userId: users.user2Id },
        _count: true,
        _max: { createdAt: true },
      });

      const resp = await app.inject({
        method: "POST",
        url: `/users/${users.user2Id}/fuel-consumption`,
        headers: { cookie: user1Cookie },
        payload: {
          fuelType: "GASOLINE_95",
          kmPerLiter: "12.0000",
          effectiveFrom: "2026-02-05",
          basisNote: "matrix",
        },
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");

      const after = await prisma.userFuelConsumptionVersion.aggregate({
        where: { userId: users.user2Id },
        _count: true,
        _max: { createdAt: true },
      });
      expect(after._count).toBe(before._count);
      expect(after._max.createdAt).toEqual(before._max.createdAt);
    });

    it("AC-36[一般使用者 × 油耗寫入(自己)] → 403 FORBIDDEN (含 userId=自己), zero DB writes", async () => {
      const before = await prisma.userFuelConsumptionVersion.aggregate({
        where: { userId: users.user1Id },
        _count: true,
        _max: { createdAt: true },
      });

      const resp = await app.inject({
        method: "POST",
        url: `/users/${users.user1Id}/fuel-consumption`,
        headers: { cookie: user1Cookie },
        payload: {
          fuelType: "GASOLINE_95",
          kmPerLiter: "12.0000",
          effectiveFrom: "2026-02-06",
          basisNote: "matrix",
        },
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");

      const after = await prisma.userFuelConsumptionVersion.aggregate({
        where: { userId: users.user1Id },
        _count: true,
        _max: { createdAt: true },
      });
      expect(after._count).toBe(before._count);
      expect(after._max.createdAt).toEqual(before._max.createdAt);
    });

    it("AC-36[一般使用者 × 油耗讀取(他人，管理端點)] → 403 FORBIDDEN", async () => {
      const resp = await app.inject({
        method: "GET",
        url: `/users/${users.user2Id}/fuel-consumption`,
        headers: { cookie: user1Cookie },
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    });

    // ---- Row: 管理員 ----

    it("AC-36[管理員 × 油耗寫入(他人)] → 201", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/users/${users.user2Id}/fuel-consumption`,
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "GASOLINE_95",
          kmPerLiter: "12.0000",
          effectiveFrom: "2026-02-07",
          basisNote: "matrix admin writes for user2",
        },
      });
      expect(resp.statusCode).toBe(201);
    });

    it("AC-36[管理員 × 油耗寫入(自己)] → 201 (管理員可為自己建立)", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/users/${users.adminId}/fuel-consumption`,
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "GASOLINE_95",
          kmPerLiter: "12.0000",
          effectiveFrom: "2026-02-08",
          basisNote: "matrix admin writes for self",
        },
      });
      expect(resp.statusCode).toBe(201);
    });

    it("AC-36[管理員 × 油耗讀取(他人，管理端點)] → 200", async () => {
      const resp = await app.inject({
        method: "GET",
        url: `/users/${users.user2Id}/fuel-consumption`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ versions: unknown[] }>();
      expect(Array.isArray(body.versions)).toBe(true);
    });

    // ---- Row: 停用帳號 ----

    it("AC-36[停用帳號 × 油耗寫入(他人)] → 401 UNAUTHORIZED", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/users/${users.user2Id}/fuel-consumption`,
        headers: { cookie: deactivatedCookie },
        payload: {
          fuelType: "GASOLINE_95",
          kmPerLiter: "12.0000",
          effectiveFrom: "2026-02-09",
          basisNote: "matrix",
        },
      });
      expect(resp.statusCode).toBe(401);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
    });

    it("AC-36[停用帳號 × 油耗寫入(自己)] → 401 UNAUTHORIZED", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/users/${users.deactivatedId}/fuel-consumption`,
        headers: { cookie: deactivatedCookie },
        payload: {
          fuelType: "GASOLINE_95",
          kmPerLiter: "12.0000",
          effectiveFrom: "2026-02-10",
          basisNote: "matrix",
        },
      });
      expect(resp.statusCode).toBe(401);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
    });

    it("AC-36[停用帳號 × 油耗讀取(他人，管理端點)] → 401 UNAUTHORIZED", async () => {
      const resp = await app.inject({
        method: "GET",
        url: `/users/${users.user2Id}/fuel-consumption`,
        headers: { cookie: deactivatedCookie },
      });
      expect(resp.statusCode).toBe(401);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
    });
  });

  // -------------------------------------------------------------------------
  // AC-13 — judgment order / no side channel
  // -------------------------------------------------------------------------

  describe("AC-13 判定順序：授權失敗回應不得因輸入合法與否而有差異", () => {
    it("malformed body as a normal user still returns 403, never 400 (no side channel)", async () => {
      const malformedResp = await app.inject({
        method: "POST",
        url: `/users/${users.user2Id}/fuel-consumption`,
        headers: { cookie: user1Cookie },
        payload: {
          fuelType: 12345,
          kmPerLiter: {},
          effectiveFrom: null,
          basisNote: [],
        },
      });
      expect(malformedResp.statusCode).toBe(403);
      const malformedBody = malformedResp.json<{ error: { code: string; message: string } }>();
      expect(malformedBody.error.code).toBe("FORBIDDEN");

      const legalResp = await app.inject({
        method: "POST",
        url: `/users/${users.user2Id}/fuel-consumption`,
        headers: { cookie: user1Cookie },
        payload: {
          fuelType: "GASOLINE_95",
          kmPerLiter: "12.0000",
          effectiveFrom: "2026-02-11",
          basisNote: "well-formed",
        },
      });
      expect(legalResp.statusCode).toBe(403);
      const legalBody = legalResp.json<{ error: { code: string; message: string } }>();
      expect(legalBody.error.code).toBe("FORBIDDEN");

      // No side channel: identical status code, error code, and message
      // regardless of whether the body was malformed or well-formed.
      expect(malformedResp.statusCode).toBe(legalResp.statusCode);
      expect(malformedBody.error.code).toBe(legalBody.error.code);
      expect(malformedBody.error.message).toBe(legalBody.error.message);
    });

    it("missing body entirely (no Content-Type/payload) as a normal user still returns 403, never 400/500", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/users/${users.user2Id}/fuel-consumption`,
        headers: { cookie: user1Cookie },
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    });
  });

  // -------------------------------------------------------------------------
  // AC-12 — list, ascending sort, HISTORICAL/CURRENT/FUTURE state
  // -------------------------------------------------------------------------

  describe("AC-12 版本清單（管理員視角）", () => {
    it("a user with no versions returns 200 with an empty array (not 404)", async () => {
      // user1 has not had any consumption version created for it in this
      // describe block (only user2/admin/mcpAdmin were targeted above).
      const resp = await app.inject({
        method: "GET",
        url: `/users/${users.user1Id}/fuel-consumption`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ versions: unknown[] }>();
      expect(body.versions).toEqual([]);
    });

    it("unknown userId → 404 NOT_FOUND", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/users/does-not-exist-xyz/fuel-consumption",
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(404);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
    });

    it("returns HISTORICAL / CURRENT / FUTURE states relative to today, ascending by effectiveFrom (AR-5: created out of order)", async () => {
      const stateHash = Date.now();
      const stateUserLogin = `t5fuelconsumption_state_${stateHash}`;
      const hash = await hashPassword(PASSWORD);
      const stateUser = await prisma.user.create({
        data: {
          loginName: stateUserLogin,
          displayName: "T5 State User",
          passwordHash: hash,
          role: "USER",
          isActive: true,
          mustChangePassword: false,
        },
      });

      const pastDate = "2020-01-01"; // definitely HISTORICAL
      const currentDate = isoDateOffset(-30); // latest version <= today → CURRENT
      const futureDate = isoDateOffset(30); // FUTURE

      // AR-5: insert deliberately OUT OF ORDER (future, then past, then
      // current) to give the ascending-sort assertion real discriminating
      // power — a implementation that merely echoes insertion order would
      // fail this test.
      await app.inject({
        method: "POST",
        url: `/users/${stateUser.id}/fuel-consumption`,
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "DIESEL",
          kmPerLiter: "8.0000",
          effectiveFrom: futureDate,
          basisNote: "future",
        },
      });
      await app.inject({
        method: "POST",
        url: `/users/${stateUser.id}/fuel-consumption`,
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "GASOLINE_92",
          kmPerLiter: "9.0000",
          effectiveFrom: pastDate,
          basisNote: "past",
        },
      });
      await app.inject({
        method: "POST",
        url: `/users/${stateUser.id}/fuel-consumption`,
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "GASOLINE_95",
          kmPerLiter: "10.0000",
          effectiveFrom: currentDate,
          basisNote: "current",
        },
      });

      const resp = await app.inject({
        method: "GET",
        url: `/users/${stateUser.id}/fuel-consumption`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{
        versions: Array<{
          id: string;
          fuelType: string;
          kmPerLiter: string;
          effectiveFrom: string;
          basisNote: string;
          createdAt: string;
          createdById: string;
          state: string;
        }>;
      }>();

      expect(body.versions.length).toBe(3);
      // Ascending order by effectiveFrom, independent of insertion order.
      expect(body.versions[0].effectiveFrom).toBe(pastDate);
      expect(body.versions[1].effectiveFrom).toBe(currentDate);
      expect(body.versions[2].effectiveFrom).toBe(futureDate);

      expect(body.versions[0].state).toBe("HISTORICAL");
      expect(body.versions[1].state).toBe("CURRENT");
      expect(body.versions[2].state).toBe("FUTURE");

      // Full-shape check (§7.2 DTO + state, AC-12).
      for (const row of body.versions) {
        expect(Object.keys(row).sort()).toEqual(
          [
            "id",
            "userId",
            "fuelType",
            "kmPerLiter",
            "effectiveFrom",
            "basisNote",
            "createdAt",
            "createdById",
            "state",
          ].sort()
        );
      }

      await prisma.userFuelConsumptionVersion.deleteMany({ where: { userId: stateUser.id } });
      await prisma.auditLog.deleteMany({
        where: { OR: [{ actorId: stateUser.id }, { targetId: stateUser.id }] },
      });
      await prisma.user.delete({ where: { id: stateUser.id } });
    });
  });

  // -------------------------------------------------------------------------
  // AC-14 — audit
  // -------------------------------------------------------------------------

  describe("AC-14 油耗異動稽核", () => {
    it("one AuditLog row per successful create, with actor/target/before(null)/after/basisNote", async () => {
      const auditHash = Date.now();
      const auditUserLogin = `t5fuelconsumption_audit1_${auditHash}`;
      const hash = await hashPassword(PASSWORD);
      const auditUser = await prisma.user.create({
        data: {
          loginName: auditUserLogin,
          displayName: "T5 Audit Target 1",
          passwordHash: hash,
          role: "USER",
          isActive: true,
          mustChangePassword: false,
        },
      });

      const resp = await app.inject({
        method: "POST",
        url: `/users/${auditUser.id}/fuel-consumption`,
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "GASOLINE_98",
          kmPerLiter: "11.5000",
          effectiveFrom: "2026-03-01",
          basisNote: "first version, audit test",
        },
      });
      expect(resp.statusCode).toBe(201);
      const body = resp.json<{ version: { id: string } }>();

      const logs = await prisma.auditLog.findMany({ where: { targetId: auditUser.id } });
      expect(logs.length).toBe(1);
      expect(logs[0].action).toBe("USER_FUEL_CONSUMPTION_VERSION_CREATED");
      expect(logs[0].actorId).toBe(users.adminId);
      expect(logs[0].targetId).toBe(auditUser.id);
      expect(logs[0].targetLabel).toBe(auditUserLogin);

      const summary = logs[0].summary as {
        before: unknown;
        after: { fuelType: string; kmPerLiter: string; effectiveFrom: string };
        basisNote: string;
      };
      expect(summary.before).toBeNull();
      expect(summary.after).toEqual({
        fuelType: "GASOLINE_98",
        kmPerLiter: "11.5000",
        effectiveFrom: "2026-03-01",
      });
      expect(summary.basisNote).toBe("first version, audit test");

      // Sensitive-key scan (CLAUDE.md / AC-14).
      const serialized = JSON.stringify(logs[0]).toLowerCase();
      expect(serialized).not.toContain("password");
      expect(serialized).not.toContain("token");
      expect(serialized).not.toContain("cookie");

      // 2nd version, LATER effectiveFrom → before should equal the first
      // version's snapshot.
      const resp2 = await app.inject({
        method: "POST",
        url: `/users/${auditUser.id}/fuel-consumption`,
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "DIESEL",
          kmPerLiter: "7.2500",
          effectiveFrom: "2026-05-01",
          basisNote: "second version, later date",
        },
      });
      expect(resp2.statusCode).toBe(201);

      const logs2 = await prisma.auditLog.findMany({
        where: { targetId: auditUser.id, action: "USER_FUEL_CONSUMPTION_VERSION_CREATED" },
        orderBy: { createdAt: "asc" },
      });
      expect(logs2.length).toBe(2);
      const summary2 = logs2[1].summary as { before: unknown };
      expect(summary2.before).toEqual({
        fuelType: "GASOLINE_98",
        kmPerLiter: "11.5000",
        effectiveFrom: "2026-03-01",
      });

      await prisma.userFuelConsumptionVersion.deleteMany({ where: { userId: auditUser.id } });
      await prisma.auditLog.deleteMany({ where: { targetId: auditUser.id } });
      await prisma.user.delete({ where: { id: auditUser.id } });
      void body; // (id asserted implicitly via logs lookup by targetId above)
    });

    it("AR-5-adjacent discriminator: a new version created EARLIER than an existing version gets before=null (strict '<', not the existing version's own snapshot)", async () => {
      const hash2 = Date.now();
      const login2 = `t5fuelconsumption_audit2_${hash2}`;
      const hash = await hashPassword(PASSWORD);
      const targetUser = await prisma.user.create({
        data: {
          loginName: login2,
          displayName: "T5 Audit Target 2 (strict-before)",
          passwordHash: hash,
          role: "USER",
          isActive: true,
          mustChangePassword: false,
        },
      });

      // Step 1: create a LATER version first.
      const laterResp = await app.inject({
        method: "POST",
        url: `/users/${targetUser.id}/fuel-consumption`,
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "GASOLINE_92",
          kmPerLiter: "13.0000",
          effectiveFrom: "2026-06-15",
          basisNote: "later version created first",
        },
      });
      expect(laterResp.statusCode).toBe(201);

      // Step 2: create an EARLIER version (chronologically before the one
      // above, even though it is created second). Its `before` MUST be
      // null: nothing is effective before 2026-01-01 for this user. A buggy
      // hook that (a) fails to exclude the just-created row from its
      // "existing versions" query AND (b) queries findEffectiveVersion with
      // the new version's OWN effectiveFrom (not effectiveFrom − 1 day)
      // would wrongly self-match and report `before` as this very version's
      // own values instead of null.
      const earlierResp = await app.inject({
        method: "POST",
        url: `/users/${targetUser.id}/fuel-consumption`,
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "DIESEL",
          kmPerLiter: "6.0000",
          effectiveFrom: "2026-01-01",
          basisNote: "earlier version created second",
        },
      });
      expect(earlierResp.statusCode).toBe(201);

      const logs = await prisma.auditLog.findMany({
        where: { targetId: targetUser.id, action: "USER_FUEL_CONSUMPTION_VERSION_CREATED" },
        orderBy: { createdAt: "asc" },
      });
      expect(logs.length).toBe(2);

      const earlierVersionLog = logs[1]; // second create() call, chronologically
      const summary = earlierVersionLog.summary as {
        before: unknown;
        after: { fuelType: string; kmPerLiter: string; effectiveFrom: string };
      };
      expect(summary.after.effectiveFrom).toBe("2026-01-01");
      expect(summary.before).toBeNull();

      await prisma.userFuelConsumptionVersion.deleteMany({ where: { userId: targetUser.id } });
      await prisma.auditLog.deleteMany({ where: { targetId: targetUser.id } });
      await prisma.user.delete({ where: { id: targetUser.id } });
    });

    it("stub: onCreated (audit) hook throwing aborts the whole create — transaction rolls back, error propagates (not swallowed)", async () => {
      const auditFailure = new Error("stub audit write failure");

      const fakeTx = {
        userFuelConsumptionVersion: {
          findMany: async () => [],
          create: async (args: { data: Record<string, unknown> }) => ({
            id: "stub-version-id",
            userId: args.data.userId,
            fuelType: args.data.fuelType,
            kmPerLiter: args.data.kmPerLiter,
            effectiveFrom: args.data.effectiveFrom,
            basisNote: args.data.basisNote,
            createdById: args.data.createdById,
            createdAt: new Date(),
          }),
        },
      };
      const fakePrisma = {
        user: { findUnique: async () => ({ id: "stub-user-id" }) },
        $transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
      } as unknown as PrismaClient;

      await expect(
        fuelConsumptionService.createFuelConsumptionVersion(
          fakePrisma,
          {
            userId: "stub-user-id",
            fuelType: "GASOLINE_95",
            kmPerLiter: "10.0000",
            effectiveFrom: "2026-04-01",
            basisNote: "rollback stub",
            createdById: "stub-admin-id",
          },
          async () => {
            throw auditFailure;
          }
        )
      ).rejects.toThrow(auditFailure);
    });
  });

  // -------------------------------------------------------------------------
  // AR-4 — P2002 meta-based discrimination stub
  // -------------------------------------------------------------------------

  describe("AR-4 — P2002 unique-constraint mapping is scoped to this table's own key", () => {
    it("P2002 with meta.target pointing at an UNRELATED constraint is rethrown as-is, NOT translated to 409 PARAMETER_PERIOD_OVERLAP", async () => {
      const unrelatedError = Object.assign(new Error("stub unrelated unique violation"), {
        code: "P2002",
        meta: { target: "Session_token_key" },
      });

      const fakeTx = {
        userFuelConsumptionVersion: {
          findMany: async () => [],
          create: async () => {
            throw unrelatedError;
          },
        },
      };
      const fakePrisma = {
        user: { findUnique: async () => ({ id: "stub-user-id" }) },
        $transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
      } as unknown as PrismaClient;

      await expect(
        fuelConsumptionService.createFuelConsumptionVersion(fakePrisma, {
          userId: "stub-user-id",
          fuelType: "GASOLINE_95",
          kmPerLiter: "10.0000",
          effectiveFrom: "2026-04-02",
          basisNote: "AR-4 stub",
          createdById: "stub-admin-id",
        })
      ).rejects.toBe(unrelatedError);
    });

    it("P2002 with meta.target pointing at THIS table's own key IS translated to 409 PARAMETER_PERIOD_OVERLAP", async () => {
      const ownError = Object.assign(new Error("stub own unique violation"), {
        code: "P2002",
        meta: { target: "UserFuelConsumptionVersion_userId_effectiveFrom_key" },
      });

      const fakeTx = {
        userFuelConsumptionVersion: {
          findMany: async () => [],
          create: async () => {
            throw ownError;
          },
        },
      };
      const fakePrisma = {
        user: { findUnique: async () => ({ id: "stub-user-id" }) },
        $transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
      } as unknown as PrismaClient;

      await expect(
        fuelConsumptionService.createFuelConsumptionVersion(fakePrisma, {
          userId: "stub-user-id",
          fuelType: "GASOLINE_95",
          kmPerLiter: "10.0000",
          effectiveFrom: "2026-04-03",
          basisNote: "AR-4 stub",
          createdById: "stub-admin-id",
        })
      ).rejects.toMatchObject({ code: "PARAMETER_PERIOD_OVERLAP", httpStatus: 409 });
    });
  });
});
