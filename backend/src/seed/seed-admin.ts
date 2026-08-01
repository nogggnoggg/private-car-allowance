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

export async function runSeedAdmin(
  env: Record<string, string | undefined> = process.env
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

  const prisma = new PrismaClient();

  try {
    await prisma.$connect();

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
    await prisma.$disconnect();
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
