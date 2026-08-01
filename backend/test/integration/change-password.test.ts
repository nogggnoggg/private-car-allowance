/**
 * Integration tests for PHASE-002-T7T8:
 *   POST /me/password — shared endpoint for forced password change (AC-03/13) and
 *   self-initiated password change (AC-10/11/12)
 *
 * TDD: tests written BEFORE implementation — expect RED first, then GREEN.
 *
 * Requires a running Postgres instance with migrations applied.
 * DATABASE_URL env var must be set; tests skip otherwise.
 *
 * AC covered: AC-03, AC-04, AC-08, AC-09, AC-10, AC-11, AC-12, AC-13
 * Spec §4.5.3, §5.1, D10
 */

import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireAuth, requirePasswordChanged } from "../../src/auth/middleware.js";
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
  return str.split(";")[0]; // "sid=<token>"
}

/** Login and return the cookie header string ("sid=<token>") */
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

/** POST /me/password with optional cookie */
async function changePassword(
  app: FastifyInstance,
  cookieHeader: string | undefined,
  currentPassword: string,
  newPassword: string
) {
  return app.inject({
    method: "POST",
    url: "/me/password",
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    payload: { currentPassword, newPassword },
  });
}

// ---------------------------------------------------------------------------
// T7T8-01: Unauthenticated access — 401
// ---------------------------------------------------------------------------

describeWithDb("POST /me/password — unauthenticated (AC-05)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    if (!DB_URL) return;
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("no cookie → 401 UNAUTHORIZED", async () => {
    const resp = await changePassword(app, undefined, "AnyPassword1!", "NewPassword1!");
    expect(resp.statusCode).toBe(401);
    const body = resp.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("bogus token → 401 UNAUTHORIZED", async () => {
    const resp = await changePassword(app, "sid=bogustoken", "AnyPassword1!", "NewPassword1!");
    expect(resp.statusCode).toBe(401);
    const body = resp.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// T7T8-02: currentPassword wrong — 401 (AC-10, Spec 4.5.3)
// ---------------------------------------------------------------------------

describeWithDb("POST /me/password — wrong currentPassword (AC-10)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const USER_LOGIN = `t7t8_wrong_pw_${Date.now()}`;
  const CORRECT_PASSWORD = "CorrectHorse99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(CORRECT_PASSWORD);
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "Wrong PW Test User",
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

  it("AC-10: wrong currentPassword → 401 UNAUTHORIZED with message '目前密碼不正確'", async () => {
    const cookie = await loginUser(app, USER_LOGIN, CORRECT_PASSWORD);
    const resp = await changePassword(app, cookie, "WrongPassword99!", "NewPassword99!");
    expect(resp.statusCode).toBe(401);
    const body = resp.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toBe("目前密碼不正確");
  });

  it("AC-10: wrong currentPassword does NOT change the password", async () => {
    const cookie = await loginUser(app, USER_LOGIN, CORRECT_PASSWORD);
    await changePassword(app, cookie, "WrongPassword99!", "NewPassword99!");

    // Old password should still work
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: USER_LOGIN, password: CORRECT_PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// T7T8-03: newPassword validation failures (AC-09)
// ---------------------------------------------------------------------------

describeWithDb("POST /me/password — newPassword validation (AC-09)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const USER_LOGIN = `t7t8_newpw_val_${Date.now()}`;
  const CURRENT_PASSWORD = "CurrentHorse99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(CURRENT_PASSWORD);
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "Validation Test User",
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

  it("AC-09: newPassword < 10 chars → 400 VALIDATION_ERROR with fields[newPassword]", async () => {
    const cookie = await loginUser(app, USER_LOGIN, CURRENT_PASSWORD);
    const resp = await changePassword(app, cookie, CURRENT_PASSWORD, "Short1!");
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{
      error: { code: string; fields: Array<{ field: string; reason: string }> };
    }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.fields).toBeDefined();
    const pwField = body.error.fields.find((f) => f.field === "newPassword");
    expect(pwField).toBeDefined();
    expect(pwField?.reason).toContain("10");
  });

  it("AC-09: weak newPassword → 400 VALIDATION_ERROR with fields[newPassword]", async () => {
    const cookie = await loginUser(app, USER_LOGIN, CURRENT_PASSWORD);
    // "password123" is a common weak password likely in the top-10k list
    const resp = await changePassword(app, cookie, CURRENT_PASSWORD, "password123");
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{
      error: { code: string; fields: Array<{ field: string; reason: string }> };
    }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.fields).toBeDefined();
    const pwField = body.error.fields.find((f) => f.field === "newPassword");
    expect(pwField).toBeDefined();
    expect(pwField?.reason).toContain("弱密碼");
  });
});

// ---------------------------------------------------------------------------
// T7T8-04: new password same as current — 400 VALIDATION_ERROR (AC-11)
// ---------------------------------------------------------------------------

describeWithDb("POST /me/password — new same as current (AC-11)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const USER_LOGIN = `t7t8_same_pw_${Date.now()}`;
  const CURRENT_PASSWORD = "SamePassword99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(CURRENT_PASSWORD);
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "Same PW Test User",
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

  it("AC-11: newPassword same as currentPassword → 400 VALIDATION_ERROR with fields[newPassword]", async () => {
    const cookie = await loginUser(app, USER_LOGIN, CURRENT_PASSWORD);
    const resp = await changePassword(app, cookie, CURRENT_PASSWORD, CURRENT_PASSWORD);
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{
      error: { code: string; fields: Array<{ field: string; reason: string }> };
    }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.fields).toBeDefined();
    const pwField = body.error.fields.find((f) => f.field === "newPassword");
    expect(pwField).toBeDefined();
    // Reason should indicate "different password" requirement
    expect(pwField?.reason).toContain("不同");
  });
});

// ---------------------------------------------------------------------------
// T7T8-05: successful self-initiated password change (AC-08/12)
// ---------------------------------------------------------------------------

describeWithDb("POST /me/password — successful self change (AC-08/12)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const USER_LOGIN = `t7t8_success_${Date.now()}`;
  const CURRENT_PASSWORD = "CurrentHorse99!";
  const NEW_PASSWORD = "NewValidHorse99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(CURRENT_PASSWORD);
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "Success Test User",
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

  it("successful change → 200 { ok: true }", async () => {
    const cookie = await loginUser(app, USER_LOGIN, CURRENT_PASSWORD);
    const resp = await changePassword(app, cookie, CURRENT_PASSWORD, NEW_PASSWORD);
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });

  it("AC-08: DB passwordHash is not plaintext and differs from original hash", async () => {
    // Reset user for this test
    const loginOld = `t7t8_hash_${Date.now()}`;
    const oldPassword = "OldPassword99!";
    const newPassword = "NewPassword99!!";
    const oldHash = await hashPassword(oldPassword);

    const user = await prisma.user.create({
      data: {
        loginName: loginOld,
        displayName: "Hash Test User",
        passwordHash: oldHash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    const cookie = await loginUser(app, loginOld, oldPassword);
    await changePassword(app, cookie, oldPassword, newPassword);

    const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
    // Not plaintext
    expect(updatedUser?.passwordHash).not.toBe(newPassword);
    expect(updatedUser?.passwordHash).not.toBe(oldPassword);
    // Different from old hash
    expect(updatedUser?.passwordHash).not.toBe(oldHash);
    // Is an argon2id hash (starts with $argon2id$)
    expect(updatedUser?.passwordHash).toMatch(/^\$argon2id\$/);

    // Cleanup
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("AC-12: after change, old password login fails (unified 401)", async () => {
    const loginOld = `t7t8_old_fail_${Date.now()}`;
    const oldPassword = "OldHorse99!";
    const newPassword = "NewHorse99!!x";
    const oldHash = await hashPassword(oldPassword);

    await prisma.user.create({
      data: {
        loginName: loginOld,
        displayName: "Old PW Fail User",
        passwordHash: oldHash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    const cookie = await loginUser(app, loginOld, oldPassword);
    const changeResp = await changePassword(app, cookie, oldPassword, newPassword);
    expect(changeResp.statusCode).toBe(200);

    // Try old password
    const loginOldResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: loginOld, password: oldPassword },
    });
    expect(loginOldResp.statusCode).toBe(401);
    const body = loginOldResp.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
    // Unified login error message
    expect(body.error.message).toBe("帳號或密碼錯誤，或此帳號目前無法登入");

    // Cleanup
    const user = await prisma.user.findUnique({ where: { loginName: loginOld } });
    if (user) {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("AC-12: after change, new password login succeeds", async () => {
    const loginNew = `t7t8_new_ok_${Date.now()}`;
    const oldPassword = "OldValid99!";
    const newPassword = "NewValid99!!x";
    const oldHash = await hashPassword(oldPassword);

    await prisma.user.create({
      data: {
        loginName: loginNew,
        displayName: "New PW Success User",
        passwordHash: oldHash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    const cookie = await loginUser(app, loginNew, oldPassword);
    const changeResp = await changePassword(app, cookie, oldPassword, newPassword);
    expect(changeResp.statusCode).toBe(200);

    // New password should work
    const loginNewResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: loginNew, password: newPassword },
    });
    expect(loginNewResp.statusCode).toBe(200);

    // Cleanup
    const user = await prisma.user.findUnique({ where: { loginName: loginNew } });
    if (user) {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("mustChangePassword is set to false after successful change (AC-13 shared)", async () => {
    const loginMcp = `t7t8_mcp_${Date.now()}`;
    const tempPassword = "TempPassword99!";
    const newPassword = "NewPassword99!!x";
    const hash = await hashPassword(tempPassword);

    const user = await prisma.user.create({
      data: {
        loginName: loginMcp,
        displayName: "MustChange User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: true,
      },
    });

    const cookie = await loginUser(app, loginMcp, tempPassword);
    const changeResp = await changePassword(app, cookie, tempPassword, newPassword);
    expect(changeResp.statusCode).toBe(200);

    // DB should show mustChangePassword = false
    const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updatedUser?.mustChangePassword).toBe(false);

    // Cleanup
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
});

// ---------------------------------------------------------------------------
// T7T8-06: D10 — change does NOT revoke current session (or other sessions)
// ---------------------------------------------------------------------------

describeWithDb("POST /me/password — D10: sessions not revoked after change", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const USER_LOGIN = `t7t8_sessions_${Date.now()}`;
  const CURRENT_PASSWORD = "SessionHorse99!";
  const NEW_PASSWORD = "NewSessionHorse99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(CURRENT_PASSWORD);
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "Session Test User",
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

  it("D10: current session still valid after password change (not revoked)", async () => {
    // Login and change password
    const cookie = await loginUser(app, USER_LOGIN, CURRENT_PASSWORD);
    const changeResp = await changePassword(app, cookie, CURRENT_PASSWORD, NEW_PASSWORD);
    expect(changeResp.statusCode).toBe(200);

    // The same session should still be valid (D10: no revocation)
    const meResp = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie },
    });
    expect(meResp.statusCode).toBe(200);
  });

  it("D10: a second session (simulate other device) is also still valid after change", async () => {
    // Reset user password back to CURRENT_PASSWORD for this test
    const resetUser = `t7t8_two_sess_${Date.now()}`;
    const oldPw = "TwoDeviceHorse99!";
    const newPw = "NewTwoDevice99!!";
    const hash = await hashPassword(oldPw);

    await prisma.user.create({
      data: {
        loginName: resetUser,
        displayName: "Two Session Test",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    // Login from "device 1"
    const cookie1 = await loginUser(app, resetUser, oldPw);
    // Login from "device 2" (second session)
    const cookie2 = await loginUser(app, resetUser, oldPw);

    // Change password using device 1
    const changeResp = await changePassword(app, cookie1, oldPw, newPw);
    expect(changeResp.statusCode).toBe(200);

    // Device 2 session should still be valid (D10)
    const meResp2 = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: cookie2 },
    });
    expect(meResp2.statusCode).toBe(200);

    // Device 1 session should also still be valid (D10)
    const meResp1 = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: cookie1 },
    });
    expect(meResp1.statusCode).toBe(200);

    // Cleanup
    const user = await prisma.user.findUnique({ where: { loginName: resetUser } });
    if (user) {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

// ---------------------------------------------------------------------------
// T7T8-07: Forced password change full integration (AC-03/04/13)
//   mustChangePassword user → login → access guarded route 403 →
//   POST /me/password → access guarded route 200
// ---------------------------------------------------------------------------

describeWithDb("POST /me/password — forced change integration flow (AC-03/04/13)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const USER_LOGIN = `t7t8_forced_${Date.now()}`;
  const TEMP_PASSWORD = "TempPassword99!";
  const NEW_PASSWORD = "NewValidPassword99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(TEMP_PASSWORD);
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "Forced Change User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: true,
      },
    });

    // Build server with a test route that requires requirePasswordChanged
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });

    // Register a test route that requires password to be changed (like protected endpoints)
    app.get(
      "/test/needs-pw-changed-t7t8",
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
      await prisma.session.deleteMany({ where: { user: { loginName: USER_LOGIN } } });
      await prisma.user.deleteMany({ where: { loginName: USER_LOGIN } });
      await prisma.$disconnect();
    }
  });

  it("AC-03: mustChangePassword user login returns redirect=change-password-forced", async () => {
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: USER_LOGIN, password: TEMP_PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const body = loginResp.json<{ redirect: string }>();
    expect(body.redirect).toBe("change-password-forced");
  });

  it("AC-04: before change, session cannot access requirePasswordChanged route → 403", async () => {
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: USER_LOGIN, password: TEMP_PASSWORD },
    });
    const cookie = extractCookieHeader(loginResp.headers["set-cookie"]);

    const resp = await app.inject({
      method: "GET",
      url: "/test/needs-pw-changed-t7t8",
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("AC-13: POST /me/password is accessible even with mustChangePassword=true session", async () => {
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: USER_LOGIN, password: TEMP_PASSWORD },
    });
    const cookie = extractCookieHeader(loginResp.headers["set-cookie"]);

    // Should be able to POST /me/password (no requirePasswordChanged on this route)
    const resp = await changePassword(app, cookie, TEMP_PASSWORD, NEW_PASSWORD);
    expect(resp.statusCode).toBe(200);
    expect(resp.json<{ ok: boolean }>().ok).toBe(true);
  });

  it("AC-13: after change, can access requirePasswordChanged route (mustChangePassword=false)", async () => {
    // Need to change password first (only done once per user, so use a fresh user)
    const freshLogin = `t7t8_forced_ok_${Date.now()}`;
    const freshTempPw = "FreshTempPw99!";
    const freshNewPw = "FreshNewPw99!!x";
    const hash = await hashPassword(freshTempPw);

    await prisma.user.create({
      data: {
        loginName: freshLogin,
        displayName: "Fresh Forced User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: true,
      },
    });

    // Login
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: freshLogin, password: freshTempPw },
    });
    const cookie = extractCookieHeader(loginResp.headers["set-cookie"]);

    // Before change: 403 on protected route
    const before = await app.inject({
      method: "GET",
      url: "/test/needs-pw-changed-t7t8",
      headers: { cookie },
    });
    expect(before.statusCode).toBe(403);

    // Change password
    const changeResp = await changePassword(app, cookie, freshTempPw, freshNewPw);
    expect(changeResp.statusCode).toBe(200);

    // After change: 200 on protected route (mustChangePassword=false now)
    const after = await app.inject({
      method: "GET",
      url: "/test/needs-pw-changed-t7t8",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json<{ ok: boolean }>().ok).toBe(true);

    // Cleanup
    const user = await prisma.user.findUnique({ where: { loginName: freshLogin } });
    if (user) {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("AC-13: after forced change, temp password no longer works for login", async () => {
    const freshLogin2 = `t7t8_forced_fail_${Date.now()}`;
    const freshTempPw = "FreshTemp2Pw99!";
    const freshNewPw = "FreshNew2Pw99!!";
    const hash = await hashPassword(freshTempPw);

    await prisma.user.create({
      data: {
        loginName: freshLogin2,
        displayName: "Forced Fail User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: true,
      },
    });

    // Login and change password
    const cookie = await loginUser(app, freshLogin2, freshTempPw);
    const changeResp = await changePassword(app, cookie, freshTempPw, freshNewPw);
    expect(changeResp.statusCode).toBe(200);

    // Old temp password should fail on next login
    const loginWithTempResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: freshLogin2, password: freshTempPw },
    });
    expect(loginWithTempResp.statusCode).toBe(401);
    const body = loginWithTempResp.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toBe("帳號或密碼錯誤，或此帳號目前無法登入");

    // Cleanup
    const user = await prisma.user.findUnique({ where: { loginName: freshLogin2 } });
    if (user) {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

// ---------------------------------------------------------------------------
// T7T8-08: missing request body fields → 400 VALIDATION_ERROR
// ---------------------------------------------------------------------------

describeWithDb("POST /me/password — missing fields (400)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const USER_LOGIN = `t7t8_missing_${Date.now()}`;
  const PASSWORD = "MissingTest99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "Missing Fields User",
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

  it("missing currentPassword → 400 VALIDATION_ERROR", async () => {
    const cookie = await loginUser(app, USER_LOGIN, PASSWORD);
    const resp = await app.inject({
      method: "POST",
      url: "/me/password",
      headers: { cookie },
      payload: { newPassword: "NewPassword99!" },
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it("missing newPassword → 400 VALIDATION_ERROR", async () => {
    const cookie = await loginUser(app, USER_LOGIN, PASSWORD);
    const resp = await app.inject({
      method: "POST",
      url: "/me/password",
      headers: { cookie },
      payload: { currentPassword: PASSWORD },
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });
});
