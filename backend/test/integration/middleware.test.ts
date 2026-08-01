/**
 * Integration tests for PHASE-002-T5/T6:
 *   requireAuth, requirePasswordChanged, requireAdmin preHandlers
 *   assertOwnershipOrAdmin pure function (unit)
 *
 * TDD: tests written BEFORE implementation — expect RED first, then GREEN.
 *
 * Requires a running Postgres instance with migrations applied.
 * DATABASE_URL env var must be set; tests skip otherwise.
 *
 * AC covered: AC-04, AC-05, AC-06, AC-24, AC-25
 * Spec §4.7, §4.7.1, §4.8
 *
 * Strategy:
 *   - Integration tests register temporary test routes on the Fastify instance
 *     BEFORE calling app.ready() (Fastify 5 disallows route registration after ready).
 *   - Each describe block builds its own server with the test routes pre-registered.
 *   - Unit tests for assertOwnershipOrAdmin require no DB.
 */

import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertOwnershipOrAdmin,
  requireAdmin,
  requireAuth,
  requirePasswordChanged,
} from "../../src/auth/middleware.js";
import { hashPassword } from "../../src/auth/password.js";
import { AppError } from "../../src/platform/errors.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0]; // "sid=<token>"
}

// ---------------------------------------------------------------------------
// Unit tests: assertOwnershipOrAdmin (no DB)
// ---------------------------------------------------------------------------

describe("assertOwnershipOrAdmin — unit (AC-25)", () => {
  it("ADMIN actor passes regardless of resourceOwnerId", () => {
    const actor = { id: "admin-1", role: "ADMIN" as const };
    // Should NOT throw
    expect(() => assertOwnershipOrAdmin(actor, "some-other-user-id")).not.toThrow();
  });

  it("USER actor passes when id matches resourceOwnerId", () => {
    const actor = { id: "user-1", role: "USER" as const };
    expect(() => assertOwnershipOrAdmin(actor, "user-1")).not.toThrow();
  });

  it("USER actor with different resourceOwnerId throws FORBIDDEN AppError", () => {
    const actor = { id: "user-1", role: "USER" as const };
    expect(() => assertOwnershipOrAdmin(actor, "user-2")).toThrow(AppError);
    try {
      assertOwnershipOrAdmin(actor, "user-2");
    } catch (e) {
      expect((e as AppError).code).toBe("FORBIDDEN");
      expect((e as AppError).httpStatus).toBe(403);
    }
  });

  it("ADMIN with same id also passes", () => {
    const actor = { id: "admin-1", role: "ADMIN" as const };
    expect(() => assertOwnershipOrAdmin(actor, "admin-1")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: requireAuth (AC-05, AC-06, Spec 4.7)
// ---------------------------------------------------------------------------

describeWithDb("requireAuth preHandler (AC-05/06/Spec-4.7)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const USER_LOGIN = `t5_auth_${Date.now()}`;
  const USER_PASSWORD = "AuthTest99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(USER_PASSWORD);
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "Auth Test User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    // Build server WITHOUT calling ready() yet — routes must be added before ready()
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });

    // Register test route BEFORE ready() (Fastify 5 requirement)
    app.get("/test/protected", { preHandler: [requireAuth(prisma)] }, async (request, reply) => {
      return reply.status(200).send({
        ok: true,
        userId: request.currentUser.id,
        role: request.currentUser.role,
        mustChangePassword: request.currentUser.mustChangePassword,
        isActive: request.currentUser.isActive,
      });
    });

    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await prisma.session.deleteMany({ where: { user: { loginName: USER_LOGIN } } });
      await prisma.user.deleteMany({ where: { loginName: USER_LOGIN } });
      await prisma.$disconnect();
    }
  });

  it("AC-05: no cookie → 401 UNAUTHORIZED", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/test/protected",
    });
    expect(resp.statusCode).toBe(401);
    const body = resp.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("AC-05: bogus/invalid token → 401 UNAUTHORIZED", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/test/protected",
      headers: { cookie: "sid=completelyinvalidtoken" },
    });
    expect(resp.statusCode).toBe(401);
    const body = resp.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("AC-06: expired session → 401 UNAUTHORIZED", async () => {
    // Login to get a real token
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: USER_LOGIN, password: USER_PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const cookieHeader = extractCookieHeader(loginResp.headers["set-cookie"]);
    const rawToken = cookieHeader.replace("sid=", "");

    // Expire the session in DB
    const crypto = await import("node:crypto");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await prisma.session.updateMany({
      where: { sessionToken: tokenHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const resp = await app.inject({
      method: "GET",
      url: "/test/protected",
      headers: { cookie: cookieHeader },
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  it("valid session → 200 with currentUser mounted", async () => {
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: USER_LOGIN, password: USER_PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const cookieHeader = extractCookieHeader(loginResp.headers["set-cookie"]);

    const resp = await app.inject({
      method: "GET",
      url: "/test/protected",
      headers: { cookie: cookieHeader },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      ok: boolean;
      userId: string;
      role: string;
      mustChangePassword: boolean;
      isActive: boolean;
    }>();
    expect(body.ok).toBe(true);
    expect(body.userId).toBeTypeOf("string");
    expect(body.role).toBe("USER");
    expect(body.mustChangePassword).toBe(false);
    expect(body.isActive).toBe(true);
  });

  it("Spec-4.7 double-check: session valid but user deactivated → 401 (isActive double-guard)", async () => {
    // Create a separate user to deactivate
    const deactivatedLogin = `t5_deact_${Date.now()}`;
    const hash = await hashPassword(USER_PASSWORD);
    const deactUser = await prisma.user.create({
      data: {
        loginName: deactivatedLogin,
        displayName: "Deactivated User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    // Login to get a valid session
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: deactivatedLogin, password: USER_PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const cookieHeader = extractCookieHeader(loginResp.headers["set-cookie"]);

    // Deactivate the user directly in DB (session is still technically not revoked)
    // In real T9 flow, deactivation would revoke sessions too.
    // Here we test the double-guard: requireAuth checks user.isActive from DB,
    // even if the session itself isn't revoked.
    await prisma.user.update({
      where: { id: deactUser.id },
      data: { isActive: false },
    });

    const resp = await app.inject({
      method: "GET",
      url: "/test/protected",
      headers: { cookie: cookieHeader },
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");

    // Cleanup
    await prisma.session.deleteMany({ where: { userId: deactUser.id } });
    await prisma.user.delete({ where: { id: deactUser.id } });
  });
});

// ---------------------------------------------------------------------------
// Integration: requirePasswordChanged (AC-04)
// ---------------------------------------------------------------------------

describeWithDb("requirePasswordChanged preHandler (AC-04)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const MUST_CHANGE_LOGIN = `t5_mcp_${Date.now()}`;
  const NO_CHANGE_LOGIN = `t5_ncp_${Date.now()}`;
  const PASSWORD = "MustChange99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    await prisma.user.create({
      data: {
        loginName: MUST_CHANGE_LOGIN,
        displayName: "Must Change User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: true,
      },
    });
    await prisma.user.create({
      data: {
        loginName: NO_CHANGE_LOGIN,
        displayName: "No Change User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });

    // Register test route BEFORE ready()
    app.get(
      "/test/needs-pw-changed",
      { preHandler: [requireAuth(prisma), requirePasswordChanged] },
      async (_request, reply) => {
        return reply.status(200).send({ ok: true });
      }
    );

    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await prisma.session.deleteMany({
        where: {
          user: { loginName: { in: [MUST_CHANGE_LOGIN, NO_CHANGE_LOGIN] } },
        },
      });
      await prisma.user.deleteMany({
        where: {
          loginName: { in: [MUST_CHANGE_LOGIN, NO_CHANGE_LOGIN] },
        },
      });
      await prisma.$disconnect();
    }
  });

  it("AC-04: mustChangePassword=true session accessing protected route → 403 PASSWORD_CHANGE_REQUIRED", async () => {
    // Login with mustChangePassword user
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: MUST_CHANGE_LOGIN, password: PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const cookieHeader = extractCookieHeader(loginResp.headers["set-cookie"]);

    const resp = await app.inject({
      method: "GET",
      url: "/test/needs-pw-changed",
      headers: { cookie: cookieHeader },
    });
    expect(resp.statusCode).toBe(403);
    const body = resp.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("mustChangePassword=false session → passes through (200)", async () => {
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: NO_CHANGE_LOGIN, password: PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const cookieHeader = extractCookieHeader(loginResp.headers["set-cookie"]);

    const resp = await app.inject({
      method: "GET",
      url: "/test/needs-pw-changed",
      headers: { cookie: cookieHeader },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json<{ ok: boolean }>().ok).toBe(true);
  });

  it("AC-04: no cookie (no auth) → 401 (requireAuth fires before requirePasswordChanged)", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/test/needs-pw-changed",
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  it("AC-04: Spec 4.7.1 — requireAuth uses User live value (mustChangePassword), not session snapshot", async () => {
    // Simulate: user logs in with mustChangePassword=false, then admin sets it to true in DB.
    // requireAuth should reflect the LIVE user value, so next protected request → 403.
    const liveValueLogin = `t5_live_${Date.now()}`;
    const hash = await hashPassword(PASSWORD);
    const liveUser = await prisma.user.create({
      data: {
        loginName: liveValueLogin,
        displayName: "Live Value User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    // Login (mustChangePassword=false at time of login)
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: liveValueLogin, password: PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const cookieHeader = extractCookieHeader(loginResp.headers["set-cookie"]);

    // Confirm it passes initially
    const resp1 = await app.inject({
      method: "GET",
      url: "/test/needs-pw-changed",
      headers: { cookie: cookieHeader },
    });
    expect(resp1.statusCode).toBe(200);

    // Now simulate admin forcing mustChangePassword=true on the live user
    await prisma.user.update({
      where: { id: liveUser.id },
      data: { mustChangePassword: true },
    });

    // requireAuth loads User live value → mustChangePassword=true → requirePasswordChanged blocks
    const resp2 = await app.inject({
      method: "GET",
      url: "/test/needs-pw-changed",
      headers: { cookie: cookieHeader },
    });
    expect(resp2.statusCode).toBe(403);
    expect(resp2.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");

    // Cleanup
    await prisma.session.deleteMany({ where: { userId: liveUser.id } });
    await prisma.user.delete({ where: { id: liveUser.id } });
  });
});

// ---------------------------------------------------------------------------
// Integration: requireAdmin (AC-24)
// ---------------------------------------------------------------------------

describeWithDb("requireAdmin preHandler (AC-24)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const ADMIN_LOGIN = `t6_admin_${Date.now()}`;
  const USER_LOGIN = `t6_user_${Date.now()}`;
  const PASSWORD = "AdminTest99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);

    // Create admin user
    await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "Admin User",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });

    // Create normal user
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "Normal User",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });

    // Register test admin-only route BEFORE ready()
    app.get(
      "/test/admin-only",
      { preHandler: [requireAuth(prisma), requirePasswordChanged, requireAdmin] },
      async (_request, reply) => {
        return reply.status(200).send({ ok: true, isAdmin: true });
      }
    );

    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await prisma.session.deleteMany({
        where: { user: { loginName: { in: [ADMIN_LOGIN, USER_LOGIN] } } },
      });
      await prisma.user.deleteMany({
        where: { loginName: { in: [ADMIN_LOGIN, USER_LOGIN] } },
      });
      await prisma.$disconnect();
    }
  });

  it("AC-24: USER role accessing admin route → 403 FORBIDDEN", async () => {
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: USER_LOGIN, password: PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const cookieHeader = extractCookieHeader(loginResp.headers["set-cookie"]);

    const resp = await app.inject({
      method: "GET",
      url: "/test/admin-only",
      headers: { cookie: cookieHeader },
    });
    expect(resp.statusCode).toBe(403);
    const body = resp.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("AC-24: ADMIN role accessing admin route → 200", async () => {
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: ADMIN_LOGIN, password: PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const cookieHeader = extractCookieHeader(loginResp.headers["set-cookie"]);

    const resp = await app.inject({
      method: "GET",
      url: "/test/admin-only",
      headers: { cookie: cookieHeader },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ ok: boolean; isAdmin: boolean }>();
    expect(body.ok).toBe(true);
    expect(body.isAdmin).toBe(true);
  });

  it("AC-24: no cookie → 401 (requireAuth fires before requireAdmin)", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/test/admin-only",
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// Integration: Spec 5.1 — /me and /auth/logout use requireAuth but NOT requirePasswordChanged
// These routes should be accessible even when mustChangePassword=true
// ---------------------------------------------------------------------------

describeWithDb("Spec 5.1 — /me and /auth/logout accessible during mustChangePassword", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const FORCE_LOGIN = `t5_force_${Date.now()}`;
  const PASSWORD = "ForceTest99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    await prisma.user.create({
      data: {
        loginName: FORCE_LOGIN,
        displayName: "Force Change User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: true,
      },
    });

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await prisma.session.deleteMany({ where: { user: { loginName: FORCE_LOGIN } } });
      await prisma.user.deleteMany({ where: { loginName: FORCE_LOGIN } });
      await prisma.$disconnect();
    }
  });

  it("Spec-5.1: mustChangePassword user can GET /me (requireAuth only, no requirePasswordChanged)", async () => {
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: FORCE_LOGIN, password: PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const cookieHeader = extractCookieHeader(loginResp.headers["set-cookie"]);

    const resp = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: cookieHeader },
    });
    // Must succeed — /me does NOT require password change
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ user: { mustChangePassword: boolean } }>();
    expect(body.user.mustChangePassword).toBe(true);
  });

  it("Spec-5.1: mustChangePassword user can POST /auth/logout (requireAuth only)", async () => {
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: FORCE_LOGIN, password: PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const cookieHeader = extractCookieHeader(loginResp.headers["set-cookie"]);

    const resp = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: cookieHeader },
    });
    // Must succeed — /auth/logout does NOT require password change
    expect(resp.statusCode).toBe(200);
    expect(resp.json<{ ok: boolean }>().ok).toBe(true);
  });
});
