/**
 * Integration tests for PHASE-002-T3:
 *   POST /auth/login, POST /auth/logout, GET /me
 *   Session建立/失效/Cookie安全屬性/統一登入錯誤訊息
 *
 * TDD: tests written BEFORE implementation — expect RED first, then GREEN.
 *
 * Requires a running Postgres instance with migrations applied.
 * DATABASE_URL env var must be set; tests skip otherwise.
 *
 * AC covered: AC-01, AC-02, AC-05, AC-06, AC-07, AC-28
 * Spec §4.3, §4.5.1, §5.1
 */

import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse individual cookie attributes from a Set-Cookie header string */
function parseCookieAttrs(setCookieHeader: string): Record<string, string | boolean> {
  const parts = setCookieHeader.split(";").map((p) => p.trim());
  const attrs: Record<string, string | boolean> = {};
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) {
      attrs[part.toLowerCase()] = true;
    } else {
      attrs[part.slice(0, eqIdx).toLowerCase()] = part.slice(eqIdx + 1);
    }
  }
  return attrs;
}

/** Extract the cookie value (sid=VALUE) from Set-Cookie header */
function extractCookieValue(setCookieHeader: string): string {
  const match = setCookieHeader.match(/^sid=([^;]+)/);
  if (!match) throw new Error(`No sid= found in Set-Cookie: ${setCookieHeader}`);
  return match[1];
}

// ---------------------------------------------------------------------------
// Test DB setup
// ---------------------------------------------------------------------------

describeWithDb("POST /auth/login — success and failure flows", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const ACTIVE_USER_LOGIN = `t3_active_${Date.now()}`;
  const INACTIVE_USER_LOGIN = `t3_inactive_${Date.now()}`;
  const MCHANGE_USER_LOGIN = `t3_mchange_${Date.now()}`;
  const CORRECT_PASSWORD = "CorrectHorse99!";
  const WRONG_PASSWORD = "WrongHorse99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    // Create test users
    const hash = await hashPassword(CORRECT_PASSWORD);

    await prisma.user.create({
      data: {
        loginName: ACTIVE_USER_LOGIN,
        displayName: "Active Test User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    await prisma.user.create({
      data: {
        loginName: INACTIVE_USER_LOGIN,
        displayName: "Inactive Test User",
        passwordHash: hash,
        isActive: false,
        mustChangePassword: false,
      },
    });

    await prisma.user.create({
      data: {
        loginName: MCHANGE_USER_LOGIN,
        displayName: "MustChange Test User",
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
      await prisma.session.deleteMany({
        where: {
          user: {
            loginName: {
              in: [ACTIVE_USER_LOGIN, INACTIVE_USER_LOGIN, MCHANGE_USER_LOGIN],
            },
          },
        },
      });
      await prisma.user.deleteMany({
        where: {
          loginName: {
            in: [ACTIVE_USER_LOGIN, INACTIVE_USER_LOGIN, MCHANGE_USER_LOGIN],
          },
        },
      });
      await prisma.$disconnect();
    }
  });

  // -------------------------------------------------------------------------
  // AC-01: Successful login
  // -------------------------------------------------------------------------

  it("AC-01: successful login returns 200 with user DTO and redirect=home (mustChangePassword=false)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: ACTIVE_USER_LOGIN, password: CORRECT_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ user: Record<string, unknown>; redirect: string }>();
    expect(body.user).toBeDefined();
    expect(body.redirect).toBe("home");
    expect(body.user.loginName).toBe(ACTIVE_USER_LOGIN);
    expect(body.user.displayName).toBe("Active Test User");
    expect(body.user.isActive).toBe(true);
    // passwordHash must NEVER appear in response
    expect(body.user.passwordHash).toBeUndefined();
  });

  it("AC-01: successful login sets Set-Cookie header with sid", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: ACTIVE_USER_LOGIN, password: CORRECT_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const setCookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(setCookieStr).toMatch(/^sid=/);
  });

  it("AC-03: mustChangePassword=true login returns redirect=change-password-forced", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: MCHANGE_USER_LOGIN, password: CORRECT_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ user: Record<string, unknown>; redirect: string }>();
    expect(body.redirect).toBe("change-password-forced");
    // passwordHash must not appear
    expect(body.user.passwordHash).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // AC-02: Unified 401 error — must be IDENTICAL for all failure scenarios
  // Spec 9.3.1: body / code / HTTP status must be identical (except requestId)
  // -------------------------------------------------------------------------

  /** Canonical 401 message from Spec 4.5.1 / 5.3 */
  const UNIFIED_401_MESSAGE = "帳號或密碼錯誤，或此帳號目前無法登入";
  const UNIFIED_401_CODE = "UNAUTHORIZED";

  async function getLoginResponse(loginName: string, password: string) {
    return app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName, password },
    });
  }

  it("AC-02: non-existent account returns 401 with unified message and code=UNAUTHORIZED", async () => {
    const response = await getLoginResponse(`nonexistent_${Date.now()}`, WRONG_PASSWORD);
    expect(response.statusCode).toBe(401);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe(UNIFIED_401_CODE);
    expect(body.error.message).toBe(UNIFIED_401_MESSAGE);
  });

  it("AC-02: wrong password returns 401 with unified message and code=UNAUTHORIZED", async () => {
    const response = await getLoginResponse(ACTIVE_USER_LOGIN, WRONG_PASSWORD);
    expect(response.statusCode).toBe(401);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe(UNIFIED_401_CODE);
    expect(body.error.message).toBe(UNIFIED_401_MESSAGE);
  });

  it("AC-02: disabled account returns 401 with unified message and code=UNAUTHORIZED", async () => {
    const response = await getLoginResponse(INACTIVE_USER_LOGIN, CORRECT_PASSWORD);
    expect(response.statusCode).toBe(401);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe(UNIFIED_401_CODE);
    expect(body.error.message).toBe(UNIFIED_401_MESSAGE);
  });

  it("AC-02: all three failure scenarios have IDENTICAL error body structure (except requestId)", async () => {
    const [nonExistent, wrongPw, disabled] = await Promise.all([
      getLoginResponse(`nonexistent_${Date.now()}`, WRONG_PASSWORD),
      getLoginResponse(ACTIVE_USER_LOGIN, WRONG_PASSWORD),
      getLoginResponse(INACTIVE_USER_LOGIN, CORRECT_PASSWORD),
    ]);

    const bodyNe = nonExistent.json<{
      error: { code: string; message: string; requestId: string };
    }>();
    const bodyWp = wrongPw.json<{ error: { code: string; message: string; requestId: string } }>();
    const bodyDi = disabled.json<{ error: { code: string; message: string; requestId: string } }>();

    // HTTP status all 401
    expect(nonExistent.statusCode).toBe(401);
    expect(wrongPw.statusCode).toBe(401);
    expect(disabled.statusCode).toBe(401);

    // code identical
    expect(bodyNe.error.code).toBe(UNIFIED_401_CODE);
    expect(bodyWp.error.code).toBe(UNIFIED_401_CODE);
    expect(bodyDi.error.code).toBe(UNIFIED_401_CODE);

    // message identical (word-for-word)
    expect(bodyNe.error.message).toBe(UNIFIED_401_MESSAGE);
    expect(bodyWp.error.message).toBe(UNIFIED_401_MESSAGE);
    expect(bodyDi.error.message).toBe(UNIFIED_401_MESSAGE);

    // No Set-Cookie on failure
    expect(nonExistent.headers["set-cookie"]).toBeUndefined();
    expect(wrongPw.headers["set-cookie"]).toBeUndefined();
    expect(disabled.headers["set-cookie"]).toBeUndefined();
  });

  it("AC-02: login failures do NOT set a session cookie", async () => {
    const response = await getLoginResponse(ACTIVE_USER_LOGIN, WRONG_PASSWORD);
    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // lockedUntil: T3 checks locked status (T4 will handle full locking logic)
  // -------------------------------------------------------------------------

  it("AC-02: locked account (lockedUntil in future) returns 401 with unified message", async () => {
    // Manually lock a user by setting lockedUntil to future
    const lockedLogin = `t3_locked_${Date.now()}`;
    const hash = await hashPassword(CORRECT_PASSWORD);
    await prisma.user.create({
      data: {
        loginName: lockedLogin,
        displayName: "Locked User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
        lockedUntil: new Date(Date.now() + 15 * 60 * 1000), // locked for 15 min
      },
    });

    const response = await getLoginResponse(lockedLogin, CORRECT_PASSWORD);
    expect(response.statusCode).toBe(401);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe(UNIFIED_401_CODE);
    expect(body.error.message).toBe(UNIFIED_401_MESSAGE);

    // Cleanup
    await prisma.user.delete({ where: { loginName: lockedLogin } });
  });

  // -------------------------------------------------------------------------
  // Missing fields: should return 400 VALIDATION_ERROR
  // -------------------------------------------------------------------------

  it("returns 400 VALIDATION_ERROR when loginName is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: CORRECT_PASSWORD },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 VALIDATION_ERROR when password is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: ACTIVE_USER_LOGIN },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Cookie attributes (AC-28)
// ---------------------------------------------------------------------------

describeWithDb("POST /auth/login — Cookie attributes (AC-28)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const USER_LOGIN = `t3_cookie_${Date.now()}`;
  const PASSWORD = "CookieTest99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "Cookie Test User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await prisma.session.deleteMany({ where: { user: { loginName: USER_LOGIN } } });
      await prisma.user.deleteMany({ where: { loginName: USER_LOGIN } });
      await prisma.$disconnect();
    }
  });

  it("AC-28: non-production: cookie has HttpOnly, SameSite=Lax, Path=/ but NOT Secure", async () => {
    // NODE_ENV=development (default in test)
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: USER_LOGIN, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers["set-cookie"];
    const setCookieStr = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
    expect(setCookieStr).toBeDefined();

    const attrs = parseCookieAttrs(setCookieStr);
    expect(attrs.httponly).toBe(true);
    expect((attrs.samesite as string).toLowerCase()).toBe("lax");
    expect(attrs.path).toBe("/");
    // In development, Secure must NOT be present
    expect(attrs.secure).toBeUndefined();
    // Max-Age should be set
    expect(attrs["max-age"]).toBeDefined();
    const maxAge = Number(attrs["max-age"]);
    expect(maxAge).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------

describeWithDb("GET /me", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const USER_LOGIN = `t3_me_${Date.now()}`;
  const PASSWORD = "MeTest99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "Me Test User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
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

  it("AC-05: GET /me without session cookie returns 401", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/me",
    });
    expect(response.statusCode).toBe(401);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("GET /me with valid session returns 200 with UserDto (no passwordHash)", async () => {
    // Login first
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: USER_LOGIN, password: PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const setCookie = loginResp.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
    const cookieValue = cookieStr.split(";")[0]; // "sid=<token>"

    // Now call GET /me
    const meResp = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: cookieValue },
    });
    expect(meResp.statusCode).toBe(200);
    const body = meResp.json<{ user: Record<string, unknown> }>();
    expect(body.user).toBeDefined();
    expect(body.user.loginName).toBe(USER_LOGIN);
    expect(body.user.displayName).toBe("Me Test User");
    // passwordHash must NEVER be in response
    expect(body.user.passwordHash).toBeUndefined();
    // Expected UserDto fields
    expect(body.user.id).toBeTypeOf("string");
    expect(body.user.role).toBe("USER");
    expect(body.user.isActive).toBe(true);
    expect(body.user.mustChangePassword).toBe(false);
  });

  it("GET /me with invalid/bogus cookie returns 401", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: "sid=bogustoken12345" },
    });
    expect(response.statusCode).toBe(401);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// POST /auth/logout (AC-07)
// ---------------------------------------------------------------------------

describeWithDb("POST /auth/logout", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const USER_LOGIN = `t3_logout_${Date.now()}`;
  const PASSWORD = "LogoutTest99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "Logout Test User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
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

  it("AC-07: logout without session returns 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
    });
    expect(response.statusCode).toBe(401);
  });

  it("AC-07: successful logout returns 200 { ok: true } and clears cookie", async () => {
    // Login
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: USER_LOGIN, password: PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const setCookie = loginResp.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
    const cookieHeader = cookieStr.split(";")[0]; // "sid=<token>"

    // Logout
    const logoutResp = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: cookieHeader },
    });
    expect(logoutResp.statusCode).toBe(200);
    const logoutBody = logoutResp.json<{ ok: boolean }>();
    expect(logoutBody.ok).toBe(true);

    // Verify cookie is cleared (Max-Age=0 or expired date)
    const logoutCookie = logoutResp.headers["set-cookie"];
    const logoutCookieStr = Array.isArray(logoutCookie)
      ? logoutCookie[0]
      : (logoutCookie as string);
    expect(logoutCookieStr).toBeDefined();
    const attrs = parseCookieAttrs(logoutCookieStr);
    const maxAge = Number(attrs["max-age"]);
    expect(maxAge).toBe(0);
  });

  it("AC-07: after logout, original token no longer works for GET /me", async () => {
    // Login
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: USER_LOGIN, password: PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const setCookie = loginResp.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
    const cookieHeader = cookieStr.split(";")[0];

    // Logout
    await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: cookieHeader },
    });

    // Try to use the old token
    const meResp = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: cookieHeader },
    });
    expect(meResp.statusCode).toBe(401);
    const body = meResp.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// Session expiry (AC-06)
// ---------------------------------------------------------------------------

describeWithDb("Session expiry (AC-06)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const USER_LOGIN = `t3_expiry_${Date.now()}`;
  const PASSWORD = "ExpiryTest99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "Expiry Test User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
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

  it("AC-06: expired session (expiresAt in past) returns 401 on GET /me", async () => {
    // Login to get a real session token
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: USER_LOGIN, password: PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const setCookie = loginResp.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
    const cookieHeader = cookieStr.split(";")[0];
    const rawToken = cookieHeader.replace("sid=", "");

    // Manipulate expiresAt to be in the past
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await prisma.session.updateMany({
      where: { sessionToken: tokenHash },
      data: { expiresAt: new Date(Date.now() - 1000) }, // 1 second in the past
    });

    // Now the session should be expired
    const meResp = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: cookieHeader },
    });
    expect(meResp.statusCode).toBe(401);
    const body = meResp.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// Session DB storage: token stored as SHA-256 hash (Spec 4.3)
// ---------------------------------------------------------------------------

describeWithDb("Session token storage security (Spec 4.3)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const USER_LOGIN = `t3_storage_${Date.now()}`;
  const PASSWORD = "StorageTest99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "Storage Test User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
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

  it("DB sessionToken is SHA-256 of the raw cookie token (not raw token itself)", async () => {
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: USER_LOGIN, password: PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const setCookie = loginResp.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
    const rawToken = cookieStr.split(";")[0].replace("sid=", "");

    // The DB should store SHA-256 of rawToken
    const expectedHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const session = await prisma.session.findUnique({
      where: { sessionToken: expectedHash },
    });
    expect(session).not.toBeNull();
    // Raw token must NOT be in the DB
    const sessionWithRaw = await prisma.session.findUnique({
      where: { sessionToken: rawToken },
    });
    expect(sessionWithRaw).toBeNull();
  });

  it("Session has expiresAt approx 8 hours from creation", async () => {
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: USER_LOGIN, password: PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const setCookie = loginResp.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
    const rawToken = cookieStr.split(";")[0].replace("sid=", "");
    const expectedHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const session = await prisma.session.findUnique({ where: { sessionToken: expectedHash } });
    expect(session).not.toBeNull();

    // expiresAt should be ~8 hours from now
    const diffHours = (session?.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThan(7.9);
    expect(diffHours).toBeLessThan(8.1);
  });
});

// ---------------------------------------------------------------------------
// lastSeenAt throttle update (Spec 4.3 — >5 min才寫)
// ---------------------------------------------------------------------------

describeWithDb("lastSeenAt throttle (Spec 4.3)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const USER_LOGIN = `t3_lastseen_${Date.now()}`;
  const PASSWORD = "LastSeen99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "LastSeen Test User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
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

  it("immediate second GET /me does NOT update lastSeenAt (throttle <5min)", async () => {
    // Login
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: USER_LOGIN, password: PASSWORD },
    });
    const setCookie = loginResp.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
    const rawToken = cookieStr.split(";")[0].replace("sid=", "");
    const cookieHeader = cookieStr.split(";")[0];
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    // First request: get initial lastSeenAt
    await app.inject({ method: "GET", url: "/me", headers: { cookie: cookieHeader } });
    const s1 = await prisma.session.findUnique({ where: { sessionToken: tokenHash } });

    // Second request immediately
    await app.inject({ method: "GET", url: "/me", headers: { cookie: cookieHeader } });
    const s2 = await prisma.session.findUnique({ where: { sessionToken: tokenHash } });

    // lastSeenAt should NOT have changed (throttled within 5 minutes)
    expect(s1?.lastSeenAt.getTime()).toBe(s2?.lastSeenAt.getTime());
  });
});
