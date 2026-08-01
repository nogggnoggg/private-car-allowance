/**
 * Integration test: PHASE-002 data models — User, Session, AuditLog.
 * TDD: written BEFORE schema change; expected to fail first (tables do not exist).
 *
 * Requires a running Postgres instance with migrations already applied.
 * If DATABASE_URL is not set, tests are skipped with an explanatory message.
 *
 * Test DB command:
 *   docker run -d --name t1-pg -e POSTGRES_PASSWORD=test -e POSTGRES_USER=testuser \
 *     -e POSTGRES_DB=app_test -p 55432:5432 postgres:16
 * Teardown:
 *   docker rm -f t1-pg
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.DATABASE_URL;

const describeWithDb = DB_URL ? describe : describe.skip;

describeWithDb("PHASE-002 data models — User / Session / AuditLog", () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import for test isolation
  let prisma: any;

  // The set of loginNames exclusively owned by this test file.
  const OWN_LOGIN_NAMES = [
    "testuser01",
    "testuser02",
    "duplicate_user",
    "session_user",
    "token_unique_user",
    "cascade_user",
    "audit_actor",
    "audit_target",
  ];

  beforeAll(async () => {
    if (!DB_URL) return;
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({
      datasources: { db: { url: DB_URL } },
    });
    await prisma.$connect();

    // Self-healing: remove any residual rows from previous failed runs
    // so that unique-key constraints don't fire during this run.
    const residualUsers = await prisma.user.findMany({
      where: { loginName: { in: OWN_LOGIN_NAMES } },
      select: { id: true },
    });
    const residualIds = residualUsers.map((u: { id: string }) => u.id);
    if (residualIds.length > 0) {
      await prisma.auditLog.deleteMany({
        where: {
          OR: [{ actorId: { in: residualIds } }, { targetId: { in: residualIds } }],
        },
      });
      await prisma.session.deleteMany({ where: { userId: { in: residualIds } } });
      await prisma.user.deleteMany({ where: { loginName: { in: OWN_LOGIN_NAMES } } });
    }
  });

  afterAll(async () => {
    // Clean up only the rows created by this file (scoped by loginName).
    // Global deleteMany is intentionally avoided: Attachment records in other
    // test files reference User rows via FK ON DELETE RESTRICT and would block
    // a blanket user.deleteMany(), causing cascading failures across parallel runs.
    if (prisma) {
      const ownUsers = await prisma.user.findMany({
        where: { loginName: { in: OWN_LOGIN_NAMES } },
        select: { id: true },
      });
      const ownIds = ownUsers.map((u: { id: string }) => u.id);
      if (ownIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: {
            OR: [{ actorId: { in: ownIds } }, { targetId: { in: ownIds } }],
          },
        });
        await prisma.session.deleteMany({ where: { userId: { in: ownIds } } });
        await prisma.user.deleteMany({ where: { loginName: { in: OWN_LOGIN_NAMES } } });
      }
      await prisma.$disconnect();
    }
  });

  // -----------------------------------------------------------------------
  // User model
  // -----------------------------------------------------------------------

  it("can create and read back a User with all required fields", async () => {
    const user = await prisma.user.create({
      data: {
        loginName: "testuser01",
        displayName: "Test User 01",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
      },
    });

    expect(user.id).toBeTypeOf("string");
    expect(user.loginName).toBe("testuser01");
    expect(user.displayName).toBe("Test User 01");
    expect(user.employeeNumber).toBeNull();
    expect(user.role).toBe("USER");
    expect(user.isActive).toBe(true);
    expect(user.mustChangePassword).toBe(true);
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });

  it("can create a User with optional employeeNumber", async () => {
    const user = await prisma.user.create({
      data: {
        loginName: "testuser02",
        displayName: "Test User 02",
        employeeNumber: "EMP-001",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
        role: "ADMIN",
        mustChangePassword: false,
      },
    });

    expect(user.employeeNumber).toBe("EMP-001");
    expect(user.role).toBe("ADMIN");
    expect(user.mustChangePassword).toBe(false);
  });

  it("enforces loginName uniqueness — duplicate throws", async () => {
    // Create first user with the same loginName
    await prisma.user.create({
      data: {
        loginName: "duplicate_user",
        displayName: "Dupe User",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
      },
    });

    // Second create with same loginName must throw
    await expect(
      prisma.user.create({
        data: {
          loginName: "duplicate_user",
          displayName: "Dupe User 2",
          passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
        },
      })
    ).rejects.toThrow();
  });

  // -----------------------------------------------------------------------
  // Session model
  // -----------------------------------------------------------------------

  it("can create and read back a Session associated with a User", async () => {
    const user = await prisma.user.create({
      data: {
        loginName: "session_user",
        displayName: "Session User",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
      },
    });

    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const session = await prisma.session.create({
      data: {
        sessionToken: "sha256_hash_of_opaque_token_1",
        userId: user.id,
        expiresAt,
      },
    });

    expect(session.id).toBeTypeOf("string");
    expect(session.sessionToken).toBe("sha256_hash_of_opaque_token_1");
    expect(session.userId).toBe(user.id);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.lastSeenAt).toBeInstanceOf(Date);
    expect(session.revokedAt).toBeNull();
    expect(session.mustChangePassword).toBe(false);
    expect(session.expiresAt).toBeInstanceOf(Date);
  });

  it("enforces sessionToken uniqueness — duplicate throws", async () => {
    const user = await prisma.user.create({
      data: {
        loginName: "token_unique_user",
        displayName: "Token Unique User",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
      },
    });

    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await prisma.session.create({
      data: {
        sessionToken: "same_token_hash",
        userId: user.id,
        expiresAt,
      },
    });

    await expect(
      prisma.session.create({
        data: {
          sessionToken: "same_token_hash",
          userId: user.id,
          expiresAt,
        },
      })
    ).rejects.toThrow();
  });

  it("Session cascades deletion when User is deleted", async () => {
    const user = await prisma.user.create({
      data: {
        loginName: "cascade_user",
        displayName: "Cascade User",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
      },
    });

    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const session = await prisma.session.create({
      data: {
        sessionToken: "cascade_token_hash",
        userId: user.id,
        expiresAt,
      },
    });

    // Delete the user — session must be cascade-deleted
    await prisma.user.delete({ where: { id: user.id } });

    const foundSession = await prisma.session.findUnique({
      where: { id: session.id },
    });
    expect(foundSession).toBeNull();
  });

  // -----------------------------------------------------------------------
  // AuditLog model
  // -----------------------------------------------------------------------

  it("can create and read back an AuditLog for USER_CREATED action", async () => {
    // actor (admin)
    const actor = await prisma.user.create({
      data: {
        loginName: "audit_actor",
        displayName: "Audit Actor",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
        role: "ADMIN",
      },
    });

    // target (new user)
    const target = await prisma.user.create({
      data: {
        loginName: "audit_target",
        displayName: "Audit Target",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
      },
    });

    const log = await prisma.auditLog.create({
      data: {
        action: "USER_CREATED",
        actorId: actor.id,
        targetId: target.id,
        targetLabel: "audit_target",
        summary: { role: "USER" },
      },
    });

    expect(log.id).toBeTypeOf("string");
    expect(log.action).toBe("USER_CREATED");
    expect(log.actorId).toBe(actor.id);
    expect(log.targetId).toBe(target.id);
    expect(log.targetLabel).toBe("audit_target");
    expect(log.summary).toEqual({ role: "USER" });
    expect(log.createdAt).toBeInstanceOf(Date);
  });

  it("AuditLog supports null targetId (for USER_DELETED after user removed)", async () => {
    const actor = await prisma.user.findFirst({
      where: { loginName: "audit_actor" },
    });
    expect(actor).not.toBeNull();

    const log = await prisma.auditLog.create({
      data: {
        action: "USER_DELETED",
        actorId: actor.id,
        targetId: null,
        targetLabel: "deleted_user_snapshot",
        summary: { deletedLoginName: "deleted_user_snapshot" },
      },
    });

    expect(log.targetId).toBeNull();
    expect(log.targetLabel).toBe("deleted_user_snapshot");
  });

  it("AuditLog can be created with all supported AuditAction enum values", async () => {
    const actor = await prisma.user.findFirst({
      where: { loginName: "audit_actor" },
    });
    const target = await prisma.user.findFirst({
      where: { loginName: "audit_target" },
    });

    const actions = ["USER_DEACTIVATED", "USER_ACTIVATED", "USER_PASSWORD_RESET"] as const;

    for (const action of actions) {
      const log = await prisma.auditLog.create({
        data: {
          action,
          actorId: actor.id,
          targetId: target.id,
          targetLabel: "audit_target",
        },
      });
      expect(log.action).toBe(action);
    }
  });
});
