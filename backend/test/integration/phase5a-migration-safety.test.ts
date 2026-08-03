/**
 * Integration tests for PHASE-005a-T1 — Schema + migration safety net.
 *
 * TDD: written BEFORE the T1 implementation existed (schema.prisma had no
 * `FuelType` enum, no `FuelPriceVersion`/`UserFuelConsumptionVersion` tables,
 * no `TravelApplication` five-column extension, no `AuditAction` new value,
 * and `history.ts` did not check `UserFuelConsumptionVersion`). First run was
 * RED for multiple independent reasons: TypeScript failed to compile
 * (`prisma.fuelPriceVersion` / `prisma.userFuelConsumptionVersion` did not
 * exist on the generated client), and the two new migration directories this
 * file spawns `prisma migrate deploy` against did not exist on disk yet.
 *
 * Covers Spec §8 (資料模型與 migration), AC-27 (§2.E), §15 Task T1's three
 * Done When items:
 *   1. migration 前後舊列逐欄位值比對全同（本檔用「既有 DB」情境，對一個只套
 *      用 PHASE-004 為止（不含本 Phase）migration 的 scratch schema 寫入一筆
 *      舊模型完整已完成差旅，再對同一 schema 套用本 Phase 剩餘的 migration，
 *      逐欄位比對前後完全相同）。
 *   2. `prisma migrate deploy` 於乾淨 DB（全新 scratch schema，套用全部
 *      migration）與既有 DB（上述漸進套用）皆成功。
 *   3. 帳號刪除守門測試涵蓋 `UserFuelConsumptionVersion`（只有油耗版本、無
 *      `Application` 的使用者，刪除應得到 409 CONFLICT 而非撞 FK Restrict
 *      的 500）。
 *
 * Requires a running Postgres instance; DATABASE_URL must be set (skips
 * otherwise, matching the rest of the suite's `describeWithDb` convention).
 *
 * Design note: this file provisions its OWN dedicated scratch schemas (names
 * outside the `^vitest_w[0-9]+$` pattern reserved for INFRA-001's per-worker
 * pool — see test/setup/global-setup.ts), so it never collides with, and is
 * never touched by, that mechanism's orphan-schema cleanup. Everything this
 * file creates is dropped again in its own `afterAll`.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";
import { withSchema } from "../setup/db-isolation.js";
import { countMigrationDirs } from "../setup/global-setup.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Paths / constants
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const REAL_SCHEMA_PATH = path.join(BACKEND_ROOT, "prisma", "schema.prisma");
const REAL_MIGRATIONS_DIR = path.join(BACKEND_ROOT, "prisma", "migrations");
const PRISMA_CLI_ENTRY = path.join(BACKEND_ROOT, "node_modules", "prisma", "build", "index.js");

/**
 * The migration directories that existed immediately before this Phase
 * (base commit a1c3c26, branch phase-005a) — i.e. the full PHASE-004 state.
 * Used to reconstruct an "existing DB, pre-PHASE-005a" scratch schema so this
 * file can exercise the REAL incremental `prisma migrate deploy` upgrade path
 * (not just a from-scratch rebuild), matching how this migration would
 * actually be rolled out against a production database.
 */
const BASELINE_MIGRATION_DIRS = [
  "20260801083343_init",
  "20260801101310_phase2_auth",
  "20260801125729_phase3_attachment",
  "20260801153708_phase3a_parameter_versions",
  "20260801162126_phase3a_parameter_audit_action",
  "20260801181153_phase4_application_models",
  "20260802092851_phase4_application_audit_actions",
];

const RUN_ID = `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runMigrateDeploy(
  schemaPath: string,
  databaseUrl: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [PRISMA_CLI_ENTRY, "migrate", "deploy", "--schema", schemaPath],
      {
        cwd: BACKEND_ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `prisma migrate deploy failed (exit ${code}) schema=${schemaPath} databaseUrl-schema-param=${new URL(databaseUrl).searchParams.get("schema")}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
        )
      );
    });
  });
}

/**
 * Builds a temp directory containing a copy of the real schema.prisma plus
 * ONLY the pre-PHASE-005a migration directories, so `prisma migrate deploy`
 * against it reproduces "an existing DB that has PHASE-004 applied but not
 * yet PHASE-005a" — without touching the real `prisma/migrations/` directory
 * (which stays untouched for every other concurrently-running test file /
 * the shared per-worker schemas).
 */
function buildBaselineMigrationsFixture(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase5a-t1-baseline-"));
  fs.copyFileSync(REAL_SCHEMA_PATH, path.join(tmpDir, "schema.prisma"));
  const migrationsOut = path.join(tmpDir, "migrations");
  fs.mkdirSync(migrationsOut);
  fs.copyFileSync(
    path.join(REAL_MIGRATIONS_DIR, "migration_lock.toml"),
    path.join(migrationsOut, "migration_lock.toml")
  );
  for (const dir of BASELINE_MIGRATION_DIRS) {
    const dest = path.join(migrationsOut, dir);
    fs.mkdirSync(dest);
    fs.copyFileSync(
      path.join(REAL_MIGRATIONS_DIR, dir, "migration.sql"),
      path.join(dest, "migration.sql")
    );
  }
  return tmpDir;
}

/** Canonicalize a raw-query row for deep-equality comparison across two reads. */
// biome-ignore lint/suspicious/noExplicitAny: raw SQL rows are untyped by nature
function canonicalizeRow(row: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      out[key] = value.toISOString();
    } else if (value !== null && typeof value === "object" && typeof value.toFixed === "function") {
      // Prisma.Decimal-like
      out[key] = value.toString();
    } else {
      out[key] = value;
    }
  }
  return out;
}

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0];
}

async function dropSchema(admin: PrismaClient, schema: string): Promise<void> {
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

// ===========================================================================
// AC-27 + Done When #1/#2: existing-DB incremental migration safety net
// ===========================================================================

describeWithDb("PHASE-005a-T1 migration safety net — existing DB (AC-27)", () => {
  const schema = `phase5a_t1_existing_${RUN_ID}`;
  let existingUrl: string;
  let admin: PrismaClient;
  let baselineDir: string;

  const OWNER_ID = `p5a_t1_owner_${RUN_ID}`;
  const APPLICATION_ID = `p5a_t1_app_${RUN_ID}`;
  const LOGIN_NAME = `p5a_t1_owner_${RUN_ID}`;
  const PASSWORD = "OldModelFixture99!";
  const LEGACY_FUEL_VERSION_ID = `p5a_t1_legacy_fuel_ver_${RUN_ID}`;
  const LEGACY_ETC_VERSION_ID = `p5a_t1_legacy_etc_ver_${RUN_ID}`;
  const TRIP_DATE = new Date("2033-05-01T00:00:00.000Z");

  let beforeRow: Record<string, unknown>;

  beforeAll(async () => {
    if (!DB_URL) return;
    admin = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await admin.$connect();
    await dropSchema(admin, schema);

    existingUrl = withSchema(DB_URL, schema);

    // Step 1: reconstruct "existing DB, pre-PHASE-005a" by deploying only the
    // baseline (PHASE-004-and-earlier) migrations onto a brand-new schema.
    baselineDir = buildBaselineMigrationsFixture();
    await runMigrateDeploy(path.join(baselineDir, "schema.prisma"), existingUrl);

    // Step 2: write a complete old-model COMPLETED travel application via raw
    // SQL (the baseline schema physically lacks the five new columns, so the
    // real generated Prisma Client — built from the CURRENT schema — cannot
    // be used for this insert; a plain SQL INSERT naming only the
    // baseline columns is schema-agnostic and works against either state).
    const scratchClient = new PrismaClient({ datasources: { db: { url: existingUrl } } });
    try {
      const now = new Date();
      const passwordHash = await hashPassword(PASSWORD);
      await scratchClient.$executeRaw`
        INSERT INTO "User"
          (id, "loginName", "displayName", "employeeNumber", "passwordHash", role,
           "isActive", "mustChangePassword", "failedLoginCount", "lockedUntil",
           "createdAt", "updatedAt")
        VALUES
          (${OWNER_ID}, ${LOGIN_NAME}, 'Old Model Owner (Fixture)', NULL, ${passwordHash},
           'USER'::"Role", true, false, 0, NULL, ${now}, ${now})
      `;
      await scratchClient.$executeRaw`
        INSERT INTO "Application"
          (id, type, status, "ownerId", "createdById", "primaryDate", "totalAmount",
           "completedAt", "createdAt", "updatedAt")
        VALUES
          (${APPLICATION_ID}, 'TRAVEL'::"ApplicationType", 'COMPLETED'::"ApplicationStatus",
           ${OWNER_ID}, ${OWNER_ID}, ${TRIP_DATE}, 1234, ${now}, ${now}, ${now})
      `;
      await scratchClient.$executeRaw`
        INSERT INTO "TravelApplication"
          ("applicationId", "tripDate", purpose, "fuelUnitPrice", "etcUnitPrice",
           "fuelParameterVersionId", "etcParameterVersionId", "snapshotTotalKm",
           "snapshotRawAmount", "calculatedAt")
        VALUES
          (${APPLICATION_ID}, ${TRIP_DATE}, 'Old model synthetic business trip',
           3.5000, 5.0000, ${LEGACY_FUEL_VERSION_ID}, ${LEGACY_ETC_VERSION_ID},
           120.50, 725.7500, ${now})
      `;

      // Capture the "before" snapshot — every column that physically exists
      // right now (baseline-only; the new five columns don't exist yet).
      const rows = await scratchClient.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM "TravelApplication" WHERE "applicationId" = $1`,
        APPLICATION_ID
      );
      expect(rows).toHaveLength(1);
      beforeRow = canonicalizeRow(rows[0]);
      // Sanity: the fixture really is "old model shaped" per the baseline
      // schema (no new columns exist yet to even be null).
      expect(beforeRow.fuelParameterVersionId).toBe(LEGACY_FUEL_VERSION_ID);
      expect("fuelPriceVersionId" in beforeRow).toBe(false);
    } finally {
      await scratchClient.$disconnect();
    }

    // Step 3: apply the REST of this Phase's migrations (M1~M5, real schema +
    // real migrations dir) on top of the same schema — the actual "existing
    // DB gets upgraded" path (Done When #2, "既有 DB" clause).
    await runMigrateDeploy(REAL_SCHEMA_PATH, existingUrl);
  });

  afterAll(async () => {
    if (!DB_URL) return;
    await dropSchema(admin, schema);
    await admin.$disconnect();
    if (baselineDir) fs.rmSync(baselineDir, { recursive: true, force: true });
  });

  it("Done When #2: prisma migrate deploy succeeds incrementally against an existing (pre-Phase) DB", () => {
    // beforeAll would have thrown (failing this whole describe block) if
    // either `runMigrateDeploy` call rejected — this assertion just makes
    // the success condition explicit and independently checkable.
    expect(beforeRow).toBeDefined();
  });

  it("AC-27 / Done When #1: every pre-existing column is byte-for-byte unchanged after migration", async () => {
    const client = new PrismaClient({ datasources: { db: { url: existingUrl } } });
    try {
      const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM "TravelApplication" WHERE "applicationId" = $1`,
        APPLICATION_ID
      );
      expect(rows).toHaveLength(1);
      const afterRow = canonicalizeRow(rows[0]);

      // Every column present BEFORE migration must have the exact same value
      // AFTER migration (the migration is new-columns-only — Spec §8.6
      // hard requirement).
      for (const [key, value] of Object.entries(beforeRow)) {
        expect(afterRow[key], `column "${key}" changed across migration`).toEqual(value);
      }
    } finally {
      await client.$disconnect();
    }
  });

  it("AC-27: the five new columns are NULL (zero backfill) and §8.4 discriminator reads as OLD model", async () => {
    const client = new PrismaClient({ datasources: { db: { url: existingUrl } } });
    try {
      const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT "snapshotFuelType", "snapshotFuelPricePerLiter", "snapshotFuelConsumption",
                "fuelPriceVersionId", "fuelConsumptionVersionId", "fuelParameterVersionId"
         FROM "TravelApplication" WHERE "applicationId" = $1`,
        APPLICATION_ID
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.snapshotFuelType).toBeNull();
      expect(row.snapshotFuelPricePerLiter).toBeNull();
      expect(row.snapshotFuelConsumption).toBeNull();
      expect(row.fuelPriceVersionId).toBeNull();
      expect(row.fuelConsumptionVersionId).toBeNull();

      // §8.4 discriminator: old model row ⇔ fuelParameterVersionId != null
      // AND fuelPriceVersionId == null.
      expect(row.fuelParameterVersionId).not.toBeNull();
      expect(row.fuelPriceVersionId).toBeNull();
    } finally {
      await client.$disconnect();
    }
  });

  it("AC-27: GET the migrated application still returns 200 with a non-null snapshot", async () => {
    let app: FastifyInstance | undefined;
    try {
      app = await buildServer({ databaseUrl: existingUrl, logLevel: "error" });
      await app.ready();

      const loginResp = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { loginName: LOGIN_NAME, password: PASSWORD },
      });
      expect(loginResp.statusCode).toBe(200);
      const cookie = extractCookieHeader(loginResp.headers["set-cookie"]);

      const resp = await app.inject({
        method: "GET",
        url: `/applications/travel/${APPLICATION_ID}`,
        headers: { cookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: { snapshot: unknown } }>();
      expect(body.application.snapshot).not.toBeNull();
    } finally {
      if (app) await app.close();
    }
  });
});

// ===========================================================================
// Done When #2 — clean DB
// ===========================================================================

describeWithDb("PHASE-005a-T1 migration safety net — clean DB", () => {
  const schema = `phase5a_t1_clean_${RUN_ID}`;
  let cleanUrl: string;
  let admin: PrismaClient;

  beforeAll(async () => {
    if (!DB_URL) return;
    admin = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await admin.$connect();
    await dropSchema(admin, schema);
    cleanUrl = withSchema(DB_URL, schema);
  });

  afterAll(async () => {
    if (!DB_URL) return;
    await dropSchema(admin, schema);
    await admin.$disconnect();
  });

  it("Done When #2: prisma migrate deploy succeeds end-to-end against a brand-new empty DB", async () => {
    await runMigrateDeploy(REAL_SCHEMA_PATH, cleanUrl);

    const client = new PrismaClient({ datasources: { db: { url: cleanUrl } } });
    try {
      const migrationRows = await client.$queryRawUnsafe<
        Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
      >(`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`);
      expect(migrationRows).toHaveLength(countMigrationDirs());
      for (const row of migrationRows) {
        expect(row.finished_at).not.toBeNull();
        expect(row.rolled_back_at).toBeNull();
      }

      // Spot-check the new schema objects exist and are queryable.
      await expect(client.fuelPriceVersion.count()).resolves.toBe(0);
      await expect(client.userFuelConsumptionVersion.count()).resolves.toBe(0);

      // Restricted to THIS schema's own type (pg_type/pg_enum are cluster-wide
      // catalogs — every other worker/scratch schema has its own same-named
      // "FuelType"/"AuditAction" enum, so this must be scoped by typnamespace
      // to avoid aggregating labels across all of them).
      const enumRows = await client.$queryRawUnsafe<Array<{ enumlabel: string }>>(
        `SELECT e.enumlabel FROM pg_enum e
         JOIN pg_type t ON e.enumtypid = t.oid
         JOIN pg_namespace n ON t.typnamespace = n.oid
         WHERE t.typname = 'FuelType' AND n.nspname = '${schema}'
         ORDER BY e.enumlabel`
      );
      expect(enumRows.map((r) => r.enumlabel).sort()).toEqual([
        "DIESEL",
        "GASOLINE_92",
        "GASOLINE_95",
        "GASOLINE_98",
      ]);

      const auditActionRows = await client.$queryRawUnsafe<Array<{ enumlabel: string }>>(
        `SELECT e.enumlabel FROM pg_enum e
         JOIN pg_type t ON e.enumtypid = t.oid
         JOIN pg_namespace n ON t.typnamespace = n.oid
         WHERE t.typname = 'AuditAction' AND n.nspname = '${schema}'
           AND e.enumlabel = 'USER_FUEL_CONSUMPTION_VERSION_CREATED'`
      );
      expect(auditActionRows).toHaveLength(1);
    } finally {
      await client.$disconnect();
    }
  });
});

// ===========================================================================
// Done When #3 — account deletion guard covers the new table
// ===========================================================================

describeWithDb("PHASE-005a-T1 account deletion guard covers UserFuelConsumptionVersion", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const PASSWORD = "AdminTest99!";
  const ADMIN_LOGIN = `p5a_t1_admin_${RUN_ID}`;
  const VICTIM_LOGIN = `p5a_t1_victim_${RUN_ID}`;
  let adminId: string;
  let victimId: string;

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "T1 Admin",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    adminId = admin.id;

    const victim = await prisma.user.create({
      data: {
        loginName: VICTIM_LOGIN,
        displayName: "T1 Fuel-Consumption-Only Victim",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    victimId = victim.id;

    // The victim has ONLY a UserFuelConsumptionVersion, no Application at
    // all — this is exactly the gap Spec §8.2's note describes: without the
    // T1 history.ts fix, this user would pass the old Application-only guard
    // and then hit a raw FK Restrict violation (500) on delete.
    await prisma.userFuelConsumptionVersion.create({
      data: {
        userId: victimId,
        fuelType: "GASOLINE_95",
        kmPerLiter: "12.5000",
        effectiveFrom: new Date("2033-01-01T00:00:00.000Z"),
        basisNote: "Fixture: synthetic vehicle logbook reading",
        createdById: adminId,
      },
    });

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await prisma.userFuelConsumptionVersion.deleteMany({ where: { userId: victimId } });
      await prisma.session.deleteMany({
        where: { user: { loginName: { in: [ADMIN_LOGIN, VICTIM_LOGIN] } } },
      });
      await prisma.user.deleteMany({ where: { loginName: { in: [ADMIN_LOGIN, VICTIM_LOGIN] } } });
      await prisma.$disconnect();
    }
  });

  function extractCookie(setCookieHeader: string | string[] | undefined): string {
    if (!setCookieHeader) throw new Error("No Set-Cookie header");
    const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    return str.split(";")[0];
  }

  it("409 CONFLICT (not 500) when deleting a user who has only a fuel-consumption version", async () => {
    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: ADMIN_LOGIN, password: PASSWORD },
    });
    expect(loginResp.statusCode).toBe(200);
    const cookie = extractCookie(loginResp.headers["set-cookie"]);

    const resp = await app.inject({
      method: "DELETE",
      url: `/admin/users/${victimId}`,
      headers: { cookie },
    });

    expect(resp.statusCode).toBe(409);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("CONFLICT");

    // The user must still exist — the guard fired BEFORE any delete attempt.
    const stillThere = await prisma.user.findUnique({ where: { id: victimId } });
    expect(stillThere).not.toBeNull();
  });
});
