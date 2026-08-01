/**
 * Integration tests for PHASE-002-T9/T10:
 *   Admin user management endpoints + audit writing
 *
 * TDD: tests written BEFORE implementation — expect RED first, then GREEN.
 *
 * Requires a running Postgres instance with migrations applied.
 * DATABASE_URL env var must be set; tests skip otherwise.
 *
 * AC covered:
 *   AC-17, AC-18, AC-19, AC-20, AC-21, AC-22, AC-23 (T9)
 *   AC-24 (requireAdmin gate)
 *   AC-26, AC-27 (T10 — audit write + password never in audit)
 *   D7/D8/D9/D11
 *
 * Spec §5.2, §4.5.4, §4.6, §7
 */

import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminPlugin } from "../../src/admin/routes.js";
import { requireAdmin, requireAuth, requirePasswordChanged } from "../../src/auth/middleware.js";
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

// Unique suffix to isolate tests from concurrent runs
const SUFFIX = Date.now();

// ---------------------------------------------------------------------------
// Test data factory
// ---------------------------------------------------------------------------

interface TestUsers {
  admin: { loginName: string; id: string };
  user: { loginName: string; id: string };
}

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

async function setupAdminAndUser(
  prisma: PrismaClient,
  suffix: string | number
): Promise<TestUsers> {
  const ADMIN_LOGIN = `t9_admin_${suffix}`;
  const USER_LOGIN = `t9_user_${suffix}`;
  const PASSWORD = "AdminTest99!";

  const hash = await hashPassword(PASSWORD);

  const admin = await prisma.user.create({
    data: {
      loginName: ADMIN_LOGIN,
      displayName: "Admin User",
      passwordHash: hash,
      role: "ADMIN",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const user = await prisma.user.create({
    data: {
      loginName: USER_LOGIN,
      displayName: "Normal User",
      passwordHash: hash,
      role: "USER",
      isActive: true,
      mustChangePassword: false,
    },
  });

  return {
    admin: { loginName: ADMIN_LOGIN, id: admin.id },
    user: { loginName: USER_LOGIN, id: user.id },
  };
}

async function cleanupUsers(prisma: PrismaClient, loginNames: string[]) {
  await prisma.session.deleteMany({
    where: { user: { loginName: { in: loginNames } } },
  });
  // Delete AuditLog rows referencing these users to avoid FK constraint
  const users = await prisma.user.findMany({
    where: { loginName: { in: loginNames } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
  }
  await prisma.user.deleteMany({ where: { loginName: { in: loginNames } } });
}

// ---------------------------------------------------------------------------
// AC-17: GET /admin/users
// ---------------------------------------------------------------------------

describeWithDb("GET /admin/users (AC-17)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let testUsers: TestUsers;
  const PASSWORD = "AdminTest99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    testUsers = await setupAdminAndUser(prisma, `list_${SUFFIX}`);
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await cleanupUsers(prisma, [testUsers.admin.loginName, testUsers.user.loginName]);
      await prisma.$disconnect();
    }
  });

  it("AC-17: admin gets 200 with users array (no passwordHash)", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const resp = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ users: Record<string, unknown>[] }>();
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users.length).toBeGreaterThanOrEqual(2);
    for (const u of body.users) {
      expect(u.passwordHash).toBeUndefined();
      expect(u.id).toBeDefined();
      expect(u.loginName).toBeDefined();
      expect(u.role).toBeDefined();
      expect(u.isActive).toBeDefined();
    }
  });

  it("AC-24: USER role → 403 FORBIDDEN", async () => {
    const cookie = await loginUser(app, testUsers.user.loginName, PASSWORD);
    const resp = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
  });

  it("no cookie → 401 UNAUTHORIZED", async () => {
    const resp = await app.inject({ method: "GET", url: "/admin/users" });
    expect(resp.statusCode).toBe(401);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  it("mustChangePassword ADMIN → 403 PASSWORD_CHANGE_REQUIRED", async () => {
    const mcp = await prisma.user.create({
      data: {
        loginName: `t9_mcp_${SUFFIX}`,
        displayName: "MCP Admin",
        passwordHash: await hashPassword(PASSWORD),
        role: "ADMIN",
        isActive: true,
        mustChangePassword: true,
      },
    });
    const cookie = await loginUser(app, mcp.loginName, PASSWORD);
    const resp = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    // Cleanup
    await prisma.session.deleteMany({ where: { userId: mcp.id } });
    await prisma.user.delete({ where: { id: mcp.id } });
  });
});

// ---------------------------------------------------------------------------
// AC-18/19: POST /admin/users — create user
// ---------------------------------------------------------------------------

describeWithDb("POST /admin/users (AC-18/19)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let testUsers: TestUsers;
  const PASSWORD = "AdminTest99!";
  const createdLogins: string[] = [];

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    testUsers = await setupAdminAndUser(prisma, `create_${SUFFIX}`);
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await cleanupUsers(prisma, [
        testUsers.admin.loginName,
        testUsers.user.loginName,
        ...createdLogins,
      ]);
      await prisma.$disconnect();
    }
  });

  it("AC-18: creates user with 201, mustChangePassword=true, role=USER", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const newLogin = `t9_new_${SUFFIX}_1`;
    createdLogins.push(newLogin);

    const resp = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: { cookie },
      payload: {
        loginName: newLogin,
        displayName: "New User",
        temporaryPassword: "TempPass123!",
      },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ user: Record<string, unknown> }>();
    expect(body.user.loginName).toBe(newLogin);
    expect(body.user.role).toBe("USER");
    expect(body.user.mustChangePassword).toBe(true);
    expect(body.user.isActive).toBe(true);
    expect(body.user.passwordHash).toBeUndefined();
  });

  it("AC-18: employeeNumber is optional (null if omitted)", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const newLogin = `t9_new_${SUFFIX}_2`;
    createdLogins.push(newLogin);

    const resp = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: { cookie },
      payload: {
        loginName: newLogin,
        displayName: "No EmpNum",
        temporaryPassword: "TempPass123!",
      },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ user: Record<string, unknown> }>();
    expect(body.user.employeeNumber).toBeNull();
  });

  it("AC-18: employeeNumber can be provided", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const newLogin = `t9_new_${SUFFIX}_3`;
    createdLogins.push(newLogin);

    const resp = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: { cookie },
      payload: {
        loginName: newLogin,
        displayName: "With EmpNum",
        employeeNumber: "EMP001",
        temporaryPassword: "TempPass123!",
      },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ user: Record<string, unknown> }>();
    expect(body.user.employeeNumber).toBe("EMP001");
  });

  it("AC-19: duplicate loginName → 409 CONFLICT", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);

    // Try to create with existing loginName
    const resp = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: { cookie },
      payload: {
        loginName: testUsers.user.loginName, // already exists
        displayName: "Duplicate User",
        temporaryPassword: "TempPass123!",
      },
    });
    expect(resp.statusCode).toBe(409);
    const body = resp.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("CONFLICT");
  });

  it("AC-18: weak temporaryPassword → 400 VALIDATION_ERROR with fields", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);

    const resp = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: { cookie },
      payload: {
        loginName: `t9_weak_${SUFFIX}`,
        displayName: "Weak Pw User",
        temporaryPassword: "short",
      },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<{ error: { code: string; fields?: Array<{ field: string }> } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(body.error.fields)).toBe(true);
    const fieldNames = body.error.fields?.map((f) => f.field) ?? [];
    expect(fieldNames).toContain("temporaryPassword");
  });
});

// ---------------------------------------------------------------------------
// AC-20: POST /admin/users/:id/deactivate
// ---------------------------------------------------------------------------

describeWithDb("POST /admin/users/:id/deactivate (AC-20/D8)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let testUsers: TestUsers;
  const PASSWORD = "AdminTest99!";
  const extraLogins: string[] = [];

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    testUsers = await setupAdminAndUser(prisma, `deact_${SUFFIX}`);
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await cleanupUsers(prisma, [
        testUsers.admin.loginName,
        testUsers.user.loginName,
        ...extraLogins,
      ]);
      await prisma.$disconnect();
    }
  });

  it("AC-20: deactivate sets isActive=false and returns 200 { user }", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const resp = await app.inject({
      method: "POST",
      url: `/admin/users/${testUsers.user.id}/deactivate`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ user: { isActive: boolean } }>();
    expect(body.user.isActive).toBe(false);

    // Reactivate for cleanup
    await prisma.user.update({ where: { id: testUsers.user.id }, data: { isActive: true } });
  });

  it("AC-20: session of deactivated user becomes 401 immediately", async () => {
    // Login as the target user first
    const targetLogin = `t9_deact_target_${SUFFIX}`;
    extraLogins.push(targetLogin);
    const hash = await hashPassword(PASSWORD);
    const targetUser = await prisma.user.create({
      data: {
        loginName: targetLogin,
        displayName: "Target User",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });

    // Target user logs in
    const targetCookie = await loginUser(app, targetLogin, PASSWORD);

    // Confirm target session works
    const meResp1 = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: targetCookie },
    });
    expect(meResp1.statusCode).toBe(200);

    // Admin deactivates the target user
    const adminCookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const deactResp = await app.inject({
      method: "POST",
      url: `/admin/users/${targetUser.id}/deactivate`,
      headers: { cookie: adminCookie },
    });
    expect(deactResp.statusCode).toBe(200);

    // Target user's existing session should now be 401
    const meResp2 = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: targetCookie },
    });
    expect(meResp2.statusCode).toBe(401);
  });

  it("D8: admin cannot deactivate themselves → 409 CONFLICT", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const resp = await app.inject({
      method: "POST",
      url: `/admin/users/${testUsers.admin.id}/deactivate`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(409);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("CONFLICT");
  });

  it("404 for non-existent user id", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const resp = await app.inject({
      method: "POST",
      url: "/admin/users/nonexistent_id_xyz/deactivate",
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(404);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// AC-21: POST /admin/users/:id/activate
// ---------------------------------------------------------------------------

describeWithDb("POST /admin/users/:id/activate (AC-21)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let testUsers: TestUsers;
  const PASSWORD = "AdminTest99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    testUsers = await setupAdminAndUser(prisma, `act_${SUFFIX}`);
    // Start with the normal user deactivated
    await prisma.user.update({ where: { id: testUsers.user.id }, data: { isActive: false } });
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await cleanupUsers(prisma, [testUsers.admin.loginName, testUsers.user.loginName]);
      await prisma.$disconnect();
    }
  });

  it("AC-21: activate sets isActive=true, returns 200 { user }", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const resp = await app.inject({
      method: "POST",
      url: `/admin/users/${testUsers.user.id}/activate`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ user: { isActive: boolean } }>();
    expect(body.user.isActive).toBe(true);
  });

  it("AC-21: after activate, deactivated user can login again", async () => {
    // User is now active from previous test
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: testUsers.user.loginName, password: PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
  });

  it("404 for non-existent user id", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const resp = await app.inject({
      method: "POST",
      url: "/admin/users/nonexistent_id_xyz/activate",
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(404);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// AC-22: POST /admin/users/:id/reset-password
// ---------------------------------------------------------------------------

describeWithDb("POST /admin/users/:id/reset-password (AC-22)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let testUsers: TestUsers;
  const PASSWORD = "AdminTest99!";
  const NEW_TEMP_PASSWORD = "NewTemp1234!";
  const extraLogins: string[] = [];

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    testUsers = await setupAdminAndUser(prisma, `reset_${SUFFIX}`);
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await cleanupUsers(prisma, [
        testUsers.admin.loginName,
        testUsers.user.loginName,
        ...extraLogins,
      ]);
      await prisma.$disconnect();
    }
  });

  it("AC-22: resets password, sets mustChangePassword=true, returns 200 { user }", async () => {
    const adminCookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const resp = await app.inject({
      method: "POST",
      url: `/admin/users/${testUsers.user.id}/reset-password`,
      headers: { cookie: adminCookie },
      payload: { temporaryPassword: NEW_TEMP_PASSWORD },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ user: { mustChangePassword: boolean } }>();
    expect(body.user.mustChangePassword).toBe(true);
    // passwordHash must never appear
    expect((body.user as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it("AC-22: existing sessions of reset user become 401 immediately", async () => {
    const targetLogin = `t9_reset_target_${SUFFIX}`;
    extraLogins.push(targetLogin);
    const hash = await hashPassword(PASSWORD);
    const targetUser = await prisma.user.create({
      data: {
        loginName: targetLogin,
        displayName: "Reset Target",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });

    // Target logs in
    const targetCookie = await loginUser(app, targetLogin, PASSWORD);
    // Verify session works
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/me",
          headers: { cookie: targetCookie },
        })
      ).statusCode
    ).toBe(200);

    // Admin resets password
    const adminCookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    await app.inject({
      method: "POST",
      url: `/admin/users/${targetUser.id}/reset-password`,
      headers: { cookie: adminCookie },
      payload: { temporaryPassword: NEW_TEMP_PASSWORD },
    });

    // Old session → 401
    const meResp = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: targetCookie },
    });
    expect(meResp.statusCode).toBe(401);
  });

  it("AC-22: new temporary password allows login (then forced change)", async () => {
    // testUsers.user now has mustChangePassword=true and password = NEW_TEMP_PASSWORD
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: testUsers.user.loginName, password: NEW_TEMP_PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const body = loginResp.json<{ redirect: string }>();
    expect(body.redirect).toBe("change-password-forced");
  });

  it("AC-22: weak temporaryPassword → 400 VALIDATION_ERROR", async () => {
    const adminCookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const resp = await app.inject({
      method: "POST",
      url: `/admin/users/${testUsers.user.id}/reset-password`,
      headers: { cookie: adminCookie },
      payload: { temporaryPassword: "short" },
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it("404 for non-existent user id", async () => {
    const adminCookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const resp = await app.inject({
      method: "POST",
      url: "/admin/users/nonexistent_id_xyz/reset-password",
      headers: { cookie: adminCookie },
      payload: { temporaryPassword: NEW_TEMP_PASSWORD },
    });
    expect(resp.statusCode).toBe(404);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// AC-23: DELETE /admin/users/:id — conditional delete
// ---------------------------------------------------------------------------

describeWithDb("DELETE /admin/users/:id (AC-23/D7/D8)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let testUsers: TestUsers;
  const PASSWORD = "AdminTest99!";
  const extraLogins: string[] = [];

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    testUsers = await setupAdminAndUser(prisma, `del_${SUFFIX}`);
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      // Some users may already be deleted by tests; clean up remaining
      await cleanupUsers(prisma, [
        testUsers.admin.loginName,
        testUsers.user.loginName,
        ...extraLogins,
      ]);
      await prisma.$disconnect();
    }
  });

  it("AC-23: delete user with no history → 200 { ok: true }", async () => {
    const deleteTarget = `t9_del_target_${SUFFIX}`;
    extraLogins.push(deleteTarget);
    const hash = await hashPassword(PASSWORD);
    const targetUser = await prisma.user.create({
      data: {
        loginName: deleteTarget,
        displayName: "Delete Target",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });

    const adminCookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const resp = await app.inject({
      method: "DELETE",
      url: `/admin/users/${targetUser.id}`,
      headers: { cookie: adminCookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);

    // Confirm the user is gone
    const gone = await prisma.user.findUnique({ where: { id: targetUser.id } });
    expect(gone).toBeNull();
    // Remove from cleanup list (already deleted)
    extraLogins.splice(extraLogins.indexOf(deleteTarget), 1);
  });

  it("AC-23: Session of deleted user cascades (no orphan sessions)", async () => {
    const cascadeTarget = `t9_del_cascade_${SUFFIX}`;
    const hash = await hashPassword(PASSWORD);
    const targetUser = await prisma.user.create({
      data: {
        loginName: cascadeTarget,
        displayName: "Cascade Target",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });

    // Target logs in (creates a session)
    const targetCookie = await loginUser(app, cascadeTarget, PASSWORD);
    // Verify session token is in DB
    const crypto = await import("node:crypto");
    const rawToken = targetCookie.replace("sid=", "");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const sessionBefore = await prisma.session.findUnique({ where: { sessionToken: tokenHash } });
    expect(sessionBefore).not.toBeNull();

    // Admin deletes the user
    const adminCookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const resp = await app.inject({
      method: "DELETE",
      url: `/admin/users/${targetUser.id}`,
      headers: { cookie: adminCookie },
    });
    expect(resp.statusCode).toBe(200);

    // Session should be gone (cascade delete)
    const sessionAfter = await prisma.session.findUnique({ where: { sessionToken: tokenHash } });
    expect(sessionAfter).toBeNull();
  });

  it("D8: admin cannot delete themselves → 409 CONFLICT", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const resp = await app.inject({
      method: "DELETE",
      url: `/admin/users/${testUsers.admin.id}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(409);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("CONFLICT");
  });

  it("404 for non-existent user id", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const resp = await app.inject({
      method: "DELETE",
      url: "/admin/users/nonexistent_id_xyz",
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(404);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
  });

  it("AC-23: userHasHistory=true → 409 CONFLICT (tested via custom server with stub)", async () => {
    // Build a special server with hasHistory injected as always-true stub
    // We register the adminPlugin directly on a fresh Fastify instance
    // that has the stub history checker.
    const Fastify = (await import("fastify")).default;
    const fastifyCookie = (await import("@fastify/cookie")).default;
    const { registerErrorHandlers } = await import("../../src/platform/error-handler.js");
    const { getPrismaClient } = await import("../../src/db/prisma.js");

    const stubApp = Fastify({ logger: false });
    const stubPrisma = getPrismaClient(DB_URL);
    registerErrorHandlers(stubApp);
    await stubApp.register(fastifyCookie);
    // Register auth plugin so login works
    const { authPlugin } = await import("../../src/auth/routes.js");
    await stubApp.register(authPlugin, { prisma: stubPrisma });
    // Register admin plugin with stub hasHistory=true
    await stubApp.register(adminPlugin, {
      prisma: stubPrisma,
      hasHistory: async () => true,
    });
    await stubApp.ready();

    // Create a victim user
    const victimLogin = `t9_hist_victim_${SUFFIX}`;
    const hash = await hashPassword(PASSWORD);
    const victim = await prisma.user.create({
      data: {
        loginName: victimLogin,
        displayName: "History Victim",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });

    try {
      // Login as admin (using the shared app for login, but hit stubApp for delete)
      const adminCookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
      const resp = await stubApp.inject({
        method: "DELETE",
        url: `/admin/users/${victim.id}`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(409);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("CONFLICT");
    } finally {
      // Cleanup
      await prisma.session.deleteMany({ where: { userId: victim.id } });
      await prisma.user.delete({ where: { id: victim.id } });
      await stubApp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T10: Audit writing (AC-26/27)
// ---------------------------------------------------------------------------

describeWithDb("Audit writing — T10 (AC-26/27)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let testUsers: TestUsers;
  const PASSWORD = "AdminTest99!";
  const auditTestLogins: string[] = [];

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    testUsers = await setupAdminAndUser(prisma, `audit_${SUFFIX}`);
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      // Clean up all audit logs referencing test users before deleting users
      const loginNames = [testUsers.admin.loginName, testUsers.user.loginName, ...auditTestLogins];
      await cleanupUsers(prisma, loginNames);
      await prisma.$disconnect();
    }
  });

  async function getLatestAudit(action: string, actorId: string) {
    return prisma.auditLog.findFirst({
      where: { action: action as import("@prisma/client").AuditAction, actorId },
      orderBy: { createdAt: "desc" },
    });
  }

  it("AC-26: USER_CREATED — audit row written after POST /admin/users", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const newLogin = `t9_audit_new_${SUFFIX}`;
    auditTestLogins.push(newLogin);

    await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: { cookie },
      payload: {
        loginName: newLogin,
        displayName: "Audit New User",
        temporaryPassword: "AuditPass123!",
      },
    });

    const log = await getLatestAudit("USER_CREATED", testUsers.admin.id);
    expect(log).not.toBeNull();
    expect(log?.action).toBe("USER_CREATED");
    expect(log?.actorId).toBe(testUsers.admin.id);
    expect(log?.targetLabel).toBe(newLogin);
    expect(log?.targetId).not.toBeNull();

    // AC-27: password must not appear in summary
    const summaryStr = JSON.stringify(log?.summary ?? {});
    expect(summaryStr).not.toMatch(/password/i);
    expect(summaryStr).not.toMatch(/temporaryPassword/i);
    expect(summaryStr).not.toMatch(/passwordHash/i);
    expect(summaryStr).not.toMatch(/argon2/i);
  });

  it("AC-26: USER_DEACTIVATED — audit row written after deactivate", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    await app.inject({
      method: "POST",
      url: `/admin/users/${testUsers.user.id}/deactivate`,
      headers: { cookie },
    });

    const log = await getLatestAudit("USER_DEACTIVATED", testUsers.admin.id);
    expect(log).not.toBeNull();
    expect(log?.action).toBe("USER_DEACTIVATED");
    expect(log?.targetId).toBe(testUsers.user.id);
    expect(log?.targetLabel).toBe(testUsers.user.loginName);
    const summaryObj = log?.summary as Record<string, unknown>;
    expect(summaryObj?.isActive).toBeDefined();

    // AC-27: no password in summary
    const summaryStr = JSON.stringify(summaryObj ?? {});
    expect(summaryStr).not.toMatch(/password/i);

    // Re-activate for later tests
    await prisma.user.update({ where: { id: testUsers.user.id }, data: { isActive: true } });
  });

  it("AC-26: USER_ACTIVATED — audit row written after activate", async () => {
    // First deactivate, then activate
    await prisma.user.update({ where: { id: testUsers.user.id }, data: { isActive: false } });

    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    await app.inject({
      method: "POST",
      url: `/admin/users/${testUsers.user.id}/activate`,
      headers: { cookie },
    });

    const log = await getLatestAudit("USER_ACTIVATED", testUsers.admin.id);
    expect(log).not.toBeNull();
    expect(log?.action).toBe("USER_ACTIVATED");
    expect(log?.targetId).toBe(testUsers.user.id);
    expect(log?.targetLabel).toBe(testUsers.user.loginName);

    const summaryStr = JSON.stringify(log?.summary ?? {});
    expect(summaryStr).not.toMatch(/password/i);
  });

  it("AC-26/27: USER_PASSWORD_RESET — audit row must not contain password", async () => {
    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    const resetPassword = "ResetPass456!";
    await app.inject({
      method: "POST",
      url: `/admin/users/${testUsers.user.id}/reset-password`,
      headers: { cookie },
      payload: { temporaryPassword: resetPassword },
    });

    const log = await getLatestAudit("USER_PASSWORD_RESET", testUsers.admin.id);
    expect(log).not.toBeNull();
    expect(log?.action).toBe("USER_PASSWORD_RESET");
    expect(log?.targetId).toBe(testUsers.user.id);
    expect(log?.targetLabel).toBe(testUsers.user.loginName);

    // AC-27: MUST NOT contain the temporary password or any password field
    const summaryStr = JSON.stringify(log?.summary ?? {});
    expect(summaryStr).not.toContain(resetPassword);
    expect(summaryStr).not.toMatch(/temporaryPassword/i);
    expect(summaryStr).not.toMatch(/passwordHash/i);
    expect(summaryStr).not.toMatch(/argon2/i);

    // Reset the user's password back so they can still login
    const rehash = await hashPassword(PASSWORD);
    await prisma.user.update({
      where: { id: testUsers.user.id },
      data: { passwordHash: rehash, mustChangePassword: false },
    });
  });

  it("AC-26/27: USER_DELETED — targetId=null, targetLabel preserved, no password in audit", async () => {
    const deleteLogin = `t9_audit_del_${SUFFIX}`;
    const hash = await hashPassword(PASSWORD);
    const deleteTarget = await prisma.user.create({
      data: {
        loginName: deleteLogin,
        displayName: "Audit Delete Target",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });

    const cookie = await loginUser(app, testUsers.admin.loginName, PASSWORD);
    await app.inject({
      method: "DELETE",
      url: `/admin/users/${deleteTarget.id}`,
      headers: { cookie },
    });

    const log = await getLatestAudit("USER_DELETED", testUsers.admin.id);
    expect(log).not.toBeNull();
    expect(log?.action).toBe("USER_DELETED");
    // targetId must be null (user was deleted)
    expect(log?.targetId).toBeNull();
    // targetLabel must still contain the loginName snapshot
    expect(log?.targetLabel).toBe(deleteLogin);

    const summaryStr = JSON.stringify(log?.summary ?? {});
    expect(summaryStr).not.toMatch(/password/i);
    expect(summaryStr).not.toMatch(/passwordHash/i);
    // The snapshot loginName should be in the summary
    expect(summaryStr).toContain(deleteLogin);
  });
});

// ---------------------------------------------------------------------------
// seed:admin (Spec §13.1-1 / D9)
// ---------------------------------------------------------------------------

describeWithDb("seed:admin function (Spec §13.1-1/D9)", () => {
  let prisma: PrismaClient;
  const seedLogins: string[] = [];

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    if (prisma) {
      await cleanupUsers(prisma, seedLogins);
      await prisma.$disconnect();
    }
  });

  it("creates admin when no ADMIN exists and valid env is provided", async () => {
    // Use a unique login to avoid collision
    const uniqueLogin = `seed_admin_${SUFFIX}`;
    seedLogins.push(uniqueLogin);

    // Ensure no ADMIN with this login exists
    await prisma.user.deleteMany({ where: { loginName: uniqueLogin } });

    // Temporarily ensure no admins exist for this test
    // We can't delete all ADMINs as they may be from other tests
    // Instead, use a dedicated test DB path — but we don't have one.
    // Strategy: test the "already has ADMIN" path and "no ADMIN" path separately
    // by deleting and creating as needed.

    // To test "no ADMIN" we need a DB with no ADMIN at all.
    // Since we cannot guarantee that, we test the "already has ADMIN" path
    // and the input validation path; and for "no ADMIN", we use a separate
    // PrismaClient pointing to the test DB and verify the function creates.

    // Actually: let's just call runSeedAdmin with env and verify behavior.
    // If there are no ADMINs, it should create. If there are, it should not.
    // We can delete all ADMIN users temporarily for this test.
    const existingAdmins = await prisma.user.findMany({ where: { role: "ADMIN" } });

    // Temporarily change all admins to USER so we can test creation
    for (const a of existingAdmins) {
      await prisma.user.update({ where: { id: a.id }, data: { role: "USER" } });
    }

    try {
      // Import and call the seed function directly
      const { runSeedAdmin } = await import("../../src/seed/seed-admin.js");

      // We need to use the test DB URL for the seed function.
      // runSeedAdmin uses process.env.DATABASE_URL by default.
      // Temporarily set DATABASE_URL to the test URL.
      const originalDbUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = DB_URL;

      try {
        await runSeedAdmin({
          SEED_ADMIN_LOGIN: uniqueLogin,
          SEED_ADMIN_PASSWORD: "SeedAdmin123!",
        });
      } finally {
        process.env.DATABASE_URL = originalDbUrl;
      }

      // Verify the admin was created
      const created = await prisma.user.findUnique({ where: { loginName: uniqueLogin } });
      expect(created).not.toBeNull();
      expect(created?.role).toBe("ADMIN");
      expect(created?.mustChangePassword).toBe(true);
      expect(created?.isActive).toBe(true);
    } finally {
      // Restore original admins
      for (const a of existingAdmins) {
        await prisma.user.update({ where: { id: a.id }, data: { role: "ADMIN" } });
      }
    }
  });

  it("does NOT create a second admin if ADMIN already exists (no-op)", async () => {
    const secondSeedLogin = `seed_admin_second_${SUFFIX}`;

    // Ensure at least one ADMIN exists
    const existingAdmin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
    expect(existingAdmin).not.toBeNull(); // there should be at least one from previous test or other tests

    const { runSeedAdmin } = await import("../../src/seed/seed-admin.js");
    const originalDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = DB_URL;

    try {
      await runSeedAdmin({
        SEED_ADMIN_LOGIN: secondSeedLogin,
        SEED_ADMIN_PASSWORD: "SeedAdmin456!",
      });
    } finally {
      process.env.DATABASE_URL = originalDbUrl;
    }

    // secondSeedLogin must NOT have been created
    const notCreated = await prisma.user.findUnique({ where: { loginName: secondSeedLogin } });
    expect(notCreated).toBeNull();
  });

  it("exits (throws) if SEED_ADMIN_LOGIN is missing", async () => {
    const { runSeedAdmin } = await import("../../src/seed/seed-admin.js");
    // process.exit(1) will be called — we need to intercept it
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null | undefined) => {
        throw new Error(`process.exit called with ${_code}`);
      });
    try {
      await expect(runSeedAdmin({ SEED_ADMIN_PASSWORD: "SeedAdmin789!" })).rejects.toThrow(
        "process.exit called with 1"
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("exits (throws) if SEED_ADMIN_PASSWORD is missing", async () => {
    const { runSeedAdmin } = await import("../../src/seed/seed-admin.js");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null | undefined) => {
        throw new Error(`process.exit called with ${_code}`);
      });
    try {
      await expect(runSeedAdmin({ SEED_ADMIN_LOGIN: "admintest" })).rejects.toThrow(
        "process.exit called with 1"
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("exits (throws) if SEED_ADMIN_PASSWORD does not meet rules", async () => {
    const { runSeedAdmin } = await import("../../src/seed/seed-admin.js");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null | undefined) => {
        throw new Error(`process.exit called with ${_code}`);
      });
    try {
      await expect(
        runSeedAdmin({ SEED_ADMIN_LOGIN: "admintest", SEED_ADMIN_PASSWORD: "short" })
      ).rejects.toThrow("process.exit called with 1");
    } finally {
      exitSpy.mockRestore();
    }
  });
});
