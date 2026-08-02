/**
 * seed:admin — PHASE-002-T9 / Spec §13.1-1 / D9.
 *
 * Creates the initial ADMIN user when none exists.
 * Reads credentials from environment variables:
 *   SEED_ADMIN_LOGIN    — the admin's loginName (required)
 *   SEED_ADMIN_PASSWORD — the admin's initial password (required, must pass rules)
 *
 * Behaviour:
 *   - If any ADMIN user already exists → prints a message and exits cleanly (no-op).
 *   - If no ADMIN exists → creates one with mustChangePassword=true, role=ADMIN.
 *   - If env vars are missing → prints an error and exits with code 1.
 *   - Passwords are NEVER written to stdout or logs.
 *
 * Usage:
 *   SEED_ADMIN_LOGIN=admin SEED_ADMIN_PASSWORD=Secure1234! npx tsx src/seed/seed-admin.ts
 *   (via npm script: npm run seed:admin)
 */

import { PrismaClient } from "@prisma/client";
import { validateNewPassword } from "../auth/password-rules.js";
import { hashPassword } from "../auth/password.js";

/**
 * Minimal shape of the Prisma operations runSeedAdmin actually needs.
 *
 * This exists solely so tests (PHASE-004-R2) can inject a stub client and
 * exercise the "no ADMIN exists -> create" / "ADMIN exists -> no-op"
 * branches without mutating real rows in the shared integration-test
 * database (which is queried by many parallel test-file workers and
 * caused cross-file flakiness — see admin-users.test.ts history).
 *
 * Not used in production: when no override is supplied, runSeedAdmin
 * creates and owns a real PrismaClient exactly as before.
 */
export interface SeedAdminPrismaLike {
  user: {
    findFirst: (args: { where: { role: "ADMIN" } }) => Promise<{ id: string } | null>;
    create: (args: {
      data: {
        loginName: string;
        displayName: string;
        passwordHash: string;
        role: "ADMIN";
        isActive: boolean;
        mustChangePassword: boolean;
      };
    }) => Promise<unknown>;
  };
}

export interface SeedAdminDeps {
  /**
   * Test-only Prisma client override. Omit in production usage — the
   * default behaviour (own PrismaClient, connect/disconnect) is
   * unchanged for real deployments and the CLI entry point below.
   */
  prisma?: SeedAdminPrismaLike;
}

export async function runSeedAdmin(
  env: Record<string, string | undefined> = process.env,
  deps: SeedAdminDeps = {}
): Promise<void> {
  const loginName = env.SEED_ADMIN_LOGIN;
  const password = env.SEED_ADMIN_PASSWORD;

  // Validate required env vars
  if (!loginName || loginName.trim() === "") {
    console.error("[seed:admin] ERROR: SEED_ADMIN_LOGIN environment variable is required.");
    process.exit(1);
  }
  if (!password || password.trim() === "") {
    console.error("[seed:admin] ERROR: SEED_ADMIN_PASSWORD environment variable is required.");
    process.exit(1);
  }

  // Validate password rules before connecting to DB
  const validation = validateNewPassword(password);
  if (!validation.valid) {
    const reasons = (validation.fields ?? []).map((f) => f.reason).join("; ");
    console.error(
      `[seed:admin] ERROR: SEED_ADMIN_PASSWORD does not meet password rules: ${reasons}`
    );
    process.exit(1);
  }

  // deps.prisma is test-only (see SeedAdminDeps above). In production
  // (deps omitted), we create and own a real PrismaClient exactly as
  // the original implementation did — connect before use, disconnect
  // in `finally`. When a test injects a stub, we neither connect nor
  // disconnect it (that's the test's responsibility, if applicable).
  //
  // Assigned via if/else (rather than `?? (realClient as unknown as
  // SeedAdminPrismaLike)`) so the `prisma` assignment is a genuine
  // structural check of `PrismaClient` against `SeedAdminPrismaLike` —
  // no `unknown` cast, no non-null assertion (forbidden by biome
  // lint/style/noNonNullAssertion).
  let realClient: PrismaClient | undefined;
  let prisma: SeedAdminPrismaLike;
  if (deps.prisma) {
    prisma = deps.prisma;
  } else {
    realClient = new PrismaClient();
    prisma = realClient;
  }

  try {
    if (realClient) {
      await realClient.$connect();
    }

    // Check if any ADMIN user already exists
    const existingAdmin = await prisma.user.findFirst({
      where: { role: "ADMIN" },
    });

    if (existingAdmin) {
      console.log("[seed:admin] An ADMIN user already exists. No action taken.");
      return;
    }

    // Hash the password (never log it)
    const passwordHash = await hashPassword(password);

    await prisma.user.create({
      data: {
        loginName: loginName.trim(),
        displayName: "系統管理員",
        passwordHash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: true,
      },
    });

    console.log(`[seed:admin] Admin user created: ${loginName.trim()} (mustChangePassword=true)`);
  } finally {
    if (realClient) {
      await realClient.$disconnect();
    }
  }
}

// Only run when executed as the entry point (not when imported in tests)
// Using import.meta.url === process.argv[1] pattern with tsx
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("seed-admin.ts") || process.argv[1].endsWith("seed-admin.js"));

if (isMain) {
  runSeedAdmin().catch((err) => {
    console.error(
      "[seed:admin] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  });
}
