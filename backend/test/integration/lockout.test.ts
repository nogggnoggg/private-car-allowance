/**
 * Integration tests for PHASE-002-T4: Login failure lockout
 *
 * TDD: tests written BEFORE implementation (RED first, then GREEN).
 *
 * AC covered: AC-14, AC-15, AC-16
 * Spec §4.5 (登入失敗鎖定規則), Done When conditions for T4
 *
 * Requires a running Postgres instance with migrations applied.
 * DATABASE_URL env var must be set; tests skip otherwise.
 *
 * Strategy:
 *   - Uses the default LOGIN_MAX_FAILURES=5 and LOGIN_LOCK_MINUTES=15
 *   - Uses DB direct manipulation to simulate time passage (lockedUntil in the past)
 *   - All tests use unique loginName prefixes to avoid cross-test interference
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

/** Canonical unified 401 message (Spec 4.5.1 / AC-02) */
const UNIFIED_401_MESSAGE = "帳號或密碼錯誤，或此帳號目前無法登入";
const UNIFIED_401_CODE = "UNAUTHORIZED";

async function doLogin(app: FastifyInstance, loginName: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { loginName, password },
  });
}

// ---------------------------------------------------------------------------
// AC-14: 連續失敗 5 次鎖定
// AC-15: 鎖定期間正確密碼亦拒
// AC-16: 失敗計數與重置規則
// ---------------------------------------------------------------------------

describeWithDb("Login lockout — AC-14/15/16 (T4)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const CORRECT_PASSWORD = "CorrectHorse99!";
  const WRONG_PASSWORD = "WrongHorse99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
  });

  // Helper: create a fresh user with unique name
  async function createUser(loginSuffix: string, extra?: Record<string, unknown>) {
    const loginName = `t4_${loginSuffix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const hash = await hashPassword(CORRECT_PASSWORD);
    const user = await prisma.user.create({
      data: {
        loginName,
        displayName: `T4 ${loginSuffix}`,
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
        ...extra,
      },
    });
    return { loginName, userId: user.id };
  }

  // Cleanup helper
  async function deleteUser(loginName: string) {
    await prisma.session.deleteMany({ where: { user: { loginName } } });
    await prisma.user.deleteMany({ where: { loginName } });
  }

  // -------------------------------------------------------------------------
  // AC-14: After LOGIN_MAX_FAILURES wrong attempts, account is locked
  // -------------------------------------------------------------------------

  it("AC-14: after LOGIN_MAX_FAILURES wrong attempts, lockedUntil is set in DB", async () => {
    const { loginName, userId } = await createUser("ac14_lock");
    try {
      // Perform LOGIN_MAX_FAILURES wrong password attempts (default = 5)
      for (let i = 0; i < 5; i++) {
        const resp = await doLogin(app, loginName, WRONG_PASSWORD);
        expect(resp.statusCode).toBe(401);
      }

      // Check DB: lockedUntil should be in the future, failedLoginCount >= 5
      const user = await prisma.user.findUnique({ where: { id: userId } });
      expect(user).not.toBeNull();
      expect(user?.lockedUntil).not.toBeNull();
      expect(user?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
      expect(user?.failedLoginCount).toBeGreaterThanOrEqual(5);
    } finally {
      await deleteUser(loginName);
    }
  });

  it("AC-14: failedLoginCount increments on each wrong password attempt", async () => {
    const { loginName, userId } = await createUser("ac14_count");
    try {
      // Do 3 wrong attempts
      for (let i = 0; i < 3; i++) {
        await doLogin(app, loginName, WRONG_PASSWORD);
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      expect(user).not.toBeNull();
      expect(user?.failedLoginCount).toBe(3);
      expect(user?.lockedUntil).toBeNull(); // not yet locked
    } finally {
      await deleteUser(loginName);
    }
  });

  // -------------------------------------------------------------------------
  // AC-15: Correct password rejected during lockout window
  // -------------------------------------------------------------------------

  it("AC-15: during lockout, correct password still returns unified 401", async () => {
    const { loginName } = await createUser("ac15_correct");
    try {
      // Exhaust failures to trigger lock
      for (let i = 0; i < 5; i++) {
        await doLogin(app, loginName, WRONG_PASSWORD);
      }

      // Now try correct password — should still be rejected
      const resp = await doLogin(app, loginName, CORRECT_PASSWORD);
      expect(resp.statusCode).toBe(401);
      const body = resp.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe(UNIFIED_401_CODE);
      expect(body.error.message).toBe(UNIFIED_401_MESSAGE);
      // No cookie should be set
      expect(resp.headers["set-cookie"]).toBeUndefined();
    } finally {
      await deleteUser(loginName);
    }
  });

  it("AC-15: locked and unlocked failures give word-for-word identical error body", async () => {
    const { loginName } = await createUser("ac15_identical");
    try {
      // First get a normal failure response (before any lock)
      const normalFail = await doLogin(app, loginName, WRONG_PASSWORD);
      const normalBody = normalFail.json<{ error: { code: string; message: string } }>();

      // Trigger lock
      for (let i = 0; i < 4; i++) {
        await doLogin(app, loginName, WRONG_PASSWORD);
      }

      // Now account is locked — try correct password
      const lockedFail = await doLogin(app, loginName, CORRECT_PASSWORD);
      const lockedBody = lockedFail.json<{ error: { code: string; message: string } }>();

      // Must be identical
      expect(normalFail.statusCode).toBe(401);
      expect(lockedFail.statusCode).toBe(401);
      expect(normalBody.error.code).toBe(lockedBody.error.code);
      expect(normalBody.error.message).toBe(lockedBody.error.message);
    } finally {
      await deleteUser(loginName);
    }
  });

  it("AC-15: lockout does NOT extend lockedUntil on repeated attempts (no infinite lock)", async () => {
    const { loginName, userId } = await createUser("ac15_noextend");
    try {
      // Trigger lock
      for (let i = 0; i < 5; i++) {
        await doLogin(app, loginName, WRONG_PASSWORD);
      }

      const userAfterLock = await prisma.user.findUnique({ where: { id: userId } });
      // biome-ignore lint/style/noNonNullAssertion: user existence already verified by prior login logic
      const lockedUntilAfterLock = userAfterLock!.lockedUntil!.getTime();

      // Wait a tiny bit, then try again (should NOT extend the lock)
      await new Promise((res) => setTimeout(res, 50));
      await doLogin(app, loginName, CORRECT_PASSWORD);
      await doLogin(app, loginName, WRONG_PASSWORD);

      const userAfterRetry = await prisma.user.findUnique({ where: { id: userId } });
      // biome-ignore lint/style/noNonNullAssertion: still locked
      const lockedUntilAfterRetry = userAfterRetry!.lockedUntil!.getTime();

      // lockedUntil must not have increased
      expect(lockedUntilAfterRetry).toBe(lockedUntilAfterLock);
    } finally {
      await deleteUser(loginName);
    }
  });

  // -------------------------------------------------------------------------
  // AC-16: Successful login resets failedLoginCount and lockedUntil
  // -------------------------------------------------------------------------

  it("AC-16: successful login resets failedLoginCount=0 and lockedUntil=null", async () => {
    const { loginName, userId } = await createUser("ac16_reset");
    try {
      // Fail a few times (not enough to lock)
      for (let i = 0; i < 3; i++) {
        await doLogin(app, loginName, WRONG_PASSWORD);
      }
      const userBeforeSuccess = await prisma.user.findUnique({ where: { id: userId } });
      expect(userBeforeSuccess?.failedLoginCount).toBe(3);

      // Now succeed
      const resp = await doLogin(app, loginName, CORRECT_PASSWORD);
      expect(resp.statusCode).toBe(200);

      const userAfterSuccess = await prisma.user.findUnique({ where: { id: userId } });
      expect(userAfterSuccess?.failedLoginCount).toBe(0);
      expect(userAfterSuccess?.lockedUntil).toBeNull();
    } finally {
      await deleteUser(loginName);
    }
  });

  // -------------------------------------------------------------------------
  // AC-16: lockedUntil expired → count resets, account treated as unlocked
  // Simulate by directly setting lockedUntil to the past in DB
  // -------------------------------------------------------------------------

  it("AC-16: after lockedUntil expires (past), correct password can log in", async () => {
    const { loginName, userId } = await createUser("ac16_expired");
    try {
      // Manually set user to locked with lockedUntil in the past
      await prisma.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: 5,
          lockedUntil: new Date(Date.now() - 1000), // 1 second ago = expired
        },
      });

      // Correct password should now work (lock expired)
      const resp = await doLogin(app, loginName, CORRECT_PASSWORD);
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ redirect: string }>();
      expect(body.redirect).toBe("home");

      // failedLoginCount and lockedUntil should be cleared
      const userAfter = await prisma.user.findUnique({ where: { id: userId } });
      expect(userAfter?.failedLoginCount).toBe(0);
      expect(userAfter?.lockedUntil).toBeNull();
    } finally {
      await deleteUser(loginName);
    }
  });

  it("AC-16: after lock expires, wrong password restarts count from 1 (not cumulative)", async () => {
    const { loginName, userId } = await createUser("ac16_restart");
    try {
      // Set user to post-lock state (lockedUntil in past)
      await prisma.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: 5,
          lockedUntil: new Date(Date.now() - 1000), // expired
        },
      });

      // Do ONE wrong password attempt after lock expires
      const resp = await doLogin(app, loginName, WRONG_PASSWORD);
      expect(resp.statusCode).toBe(401);

      // Count should be 1 (not 6 = old 5 + 1)
      const userAfter = await prisma.user.findUnique({ where: { id: userId } });
      expect(userAfter?.failedLoginCount).toBe(1);
      expect(userAfter?.lockedUntil).toBeNull(); // not locked yet (needs 5 more)
    } finally {
      await deleteUser(loginName);
    }
  });

  // -------------------------------------------------------------------------
  // Non-existent account: no DB row created (Spec 4.5.1)
  // -------------------------------------------------------------------------

  it("Non-existent account login failure does NOT create a new User row", async () => {
    const nonExistentLogin = `t4_neverexists_${Date.now()}`;

    const resp = await doLogin(app, nonExistentLogin, WRONG_PASSWORD);
    expect(resp.statusCode).toBe(401);

    // Global user.count() before/after comparison is racy across parallel
    // test files sharing one DB; the requirement is precisely "no row was
    // created for this loginName", which findUnique verifies race-free.
    const user = await prisma.user.findUnique({ where: { loginName: nonExistentLogin } });
    expect(user).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Disabled account: per Spec 4.5 literal ("密碼錯誤 → +1"),
  // disabled account check occurs BEFORE password verify → no "密碼錯誤" event
  // → failedLoginCount does NOT increment for disabled accounts
  // -------------------------------------------------------------------------

  it("Disabled account login does not increment failedLoginCount (not a password-wrong event)", async () => {
    const { loginName, userId } = await createUser("ac_disabled", { isActive: false });
    try {
      // Initial count should be 0
      const userBefore = await prisma.user.findUnique({ where: { id: userId } });
      expect(userBefore?.failedLoginCount).toBe(0);
      expect(userBefore?.lockedUntil).toBeNull();

      // Attempt login on disabled account (correct password)
      const resp = await doLogin(app, loginName, CORRECT_PASSWORD);
      expect(resp.statusCode).toBe(401);
      const body = resp.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe(UNIFIED_401_CODE);
      expect(body.error.message).toBe(UNIFIED_401_MESSAGE);

      // Count must remain unchanged
      const userAfter = await prisma.user.findUnique({ where: { id: userId } });
      expect(userAfter?.failedLoginCount).toBe(0);
      expect(userAfter?.lockedUntil).toBeNull();
    } finally {
      await deleteUser(loginName);
    }
  });

  it("Disabled account wrong password also does not increment failedLoginCount", async () => {
    const { loginName, userId } = await createUser("ac_disabled_wrong", { isActive: false });
    try {
      await doLogin(app, loginName, WRONG_PASSWORD);
      await doLogin(app, loginName, WRONG_PASSWORD);

      const userAfter = await prisma.user.findUnique({ where: { id: userId } });
      expect(userAfter?.failedLoginCount).toBe(0);
      expect(userAfter?.lockedUntil).toBeNull();
    } finally {
      await deleteUser(loginName);
    }
  });

  // -------------------------------------------------------------------------
  // Already-locked account: correct password still gives unified 401 (AC-15)
  // DB-manipulated locked state (not triggered via wrong passwords)
  // -------------------------------------------------------------------------

  it("AC-15: DB-set future lockedUntil + correct password → unified 401, no session", async () => {
    const { loginName, userId } = await createUser("ac15_dbset");
    try {
      // Directly set locked state via DB (simulates being locked)
      await prisma.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: 5,
          lockedUntil: new Date(Date.now() + 15 * 60 * 1000), // 15 min from now
        },
      });

      const resp = await doLogin(app, loginName, CORRECT_PASSWORD);
      expect(resp.statusCode).toBe(401);
      const body = resp.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe(UNIFIED_401_CODE);
      expect(body.error.message).toBe(UNIFIED_401_MESSAGE);
      expect(resp.headers["set-cookie"]).toBeUndefined();

      // DB state: lockedUntil should NOT have been changed (lock not extended)
      const userAfter = await prisma.user.findUnique({ where: { id: userId } });
      expect(userAfter?.lockedUntil).not.toBeNull();
    } finally {
      await deleteUser(loginName);
    }
  });

  // -------------------------------------------------------------------------
  // env LOGIN_MAX_FAILURES / LOGIN_LOCK_MINUTES defaults confirmed
  // Default values are 5 and 15 per Spec §8
  // -------------------------------------------------------------------------

  it("env defaults: LOGIN_MAX_FAILURES=5 and LOGIN_LOCK_MINUTES=15", async () => {
    const { loginName, userId } = await createUser("ac_defaults");
    try {
      // Fail 4 times — should NOT be locked yet
      for (let i = 0; i < 4; i++) {
        await doLogin(app, loginName, WRONG_PASSWORD);
      }
      const userAt4 = await prisma.user.findUnique({ where: { id: userId } });
      expect(userAt4?.lockedUntil).toBeNull();
      expect(userAt4?.failedLoginCount).toBe(4);

      // Fail 5th time — should now be locked
      await doLogin(app, loginName, WRONG_PASSWORD);
      const userAt5 = await prisma.user.findUnique({ where: { id: userId } });
      expect(userAt5?.lockedUntil).not.toBeNull();

      // lockedUntil should be approximately 15 minutes from now
      // biome-ignore lint/style/noNonNullAssertion: lockedUntil is not null (asserted above)
      const lockDiffMinutes = (userAt5!.lockedUntil!.getTime() - Date.now()) / (1000 * 60);
      expect(lockDiffMinutes).toBeGreaterThan(14.9);
      expect(lockDiffMinutes).toBeLessThan(15.1);
    } finally {
      await deleteUser(loginName);
    }
  });
});
