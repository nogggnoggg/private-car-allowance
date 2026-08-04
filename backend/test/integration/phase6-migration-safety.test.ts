/**
 * Integration tests for PHASE-006-T1 — Schema + migration safety net.
 *
 * TDD: written BEFORE the T1 implementation existed (schema.prisma had no
 * `MaintenanceApplication` model, `Application` had no `maintenance` reverse
 * relation, and no `20260804001701_phase6_maintenance_model` migration
 * directory existed on disk). First run was RED because TypeScript failed to
 * compile (`prisma.maintenanceApplication` did not exist on the generated
 * client) and the migration directory this file references did not exist.
 *
 * Covers Spec §8 (資料模型與 migration) and §15 Task T1's Done When:
 *   "既有／乾淨 DB 皆 migrate 成功；五表逐欄零改寫；表數 13→14；enum 聯集全等基線"
 *
 * Unlike PHASE-005a-T1 (which ALTERed `TravelApplication` and added an
 * `AuditAction` enum value), this Task's migration is CREATE-TABLE-only
 * (§8.4 M1: 零 ALTER、零回填 on any pre-existing table) — so, unlike
 * `phase5a-migration-safety.test.ts`, there is no need to hand-write raw SQL
 * INSERTs against a schema-shape that predates the Phase: every column of
 * the five representative tables below is already present, identically, in
 * both the pre-Phase-006 baseline (all migrations through PHASE-005a) and the
 * post-Phase-006 state (baseline + the one new migration), so the ordinary
 * generated Prisma Client (built from the CURRENT schema.prisma, which does
 * include `MaintenanceApplication`) can be used safely for both the "before"
 * writes and the "after" reads — only raw `SELECT *` is used for the
 * column-for-column comparison itself, to catch any accidental rewrite this
 * Task's migration should be structurally incapable of causing.
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
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
 * (branch phase-006, base commit 12fc82f) — i.e. the full PHASE-005a state.
 * Used to reconstruct an "existing DB, pre-PHASE-006" scratch schema so this
 * file can exercise the REAL incremental `prisma migrate deploy` upgrade path.
 */
const BASELINE_MIGRATION_DIRS = [
  "20260801083343_init",
  "20260801101310_phase2_auth",
  "20260801125729_phase3_attachment",
  "20260801153708_phase3a_parameter_versions",
  "20260801162126_phase3a_parameter_audit_action",
  "20260801181153_phase4_application_models",
  "20260802092851_phase4_application_audit_actions",
  "20260803190000_phase5a_fuel_model",
  "20260803190100_phase5a_audit_action_fuel_consumption",
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
 * ONLY the pre-PHASE-006 migration directories, so `prisma migrate deploy`
 * against it reproduces "an existing DB that has PHASE-005a applied but not
 * yet PHASE-006" — without touching the real `prisma/migrations/` directory.
 */
function buildBaselineMigrationsFixture(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase6-t1-baseline-"));
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

function assertRowUnchanged(
  label: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): void {
  // Closed-set guard (AR-1): also assert the column SET itself is unchanged,
  // not just the values under `before`'s keys — otherwise a migration that
  // ADDs a column (even NOT NULL DEFAULT ...) to one of these tables would
  // silently pass this check, since the new key is invisible to a loop keyed
  // off `before`.
  expect(Object.keys(after).sort(), `${label}: column set changed across migration`).toEqual(
    Object.keys(before).sort()
  );
  for (const [key, value] of Object.entries(before)) {
    expect(after[key], `${label}: column "${key}" changed across migration`).toEqual(value);
  }
}

async function dropSchema(admin: PrismaClient, schema: string): Promise<void> {
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

// ===========================================================================
// Done When: existing-DB incremental migration safety net — AC-01(b) 逐欄
// zero-rewrite check, across Application/TravelApplication/TripSegment/
// Attachment/User (the five tables AC-01(b) names) plus FuelPriceVersion/
// UserFuelConsumptionVersion (kept as additional coverage beyond the AC).
// ===========================================================================

describeWithDb("PHASE-006-T1 migration safety net — existing DB", () => {
  const schema = `phase6_t1_existing_${RUN_ID}`;
  let existingUrl: string;
  let admin: PrismaClient;
  let baselineDir: string;
  let client: PrismaClient;

  const OWNER_ID = `p6_t1_owner_${RUN_ID}`;
  const LOGIN_NAME = `p6_t1_owner_${RUN_ID}`;
  const APPLICATION_ID = `p6_t1_app_${RUN_ID}`;
  const TRIP_SEGMENT_ID_1 = `p6_t1_seg1_${RUN_ID}`;
  const TRIP_SEGMENT_ID_2 = `p6_t1_seg2_${RUN_ID}`;
  const FUEL_VERSION_ID = `p6_t1_fuel_ver_${RUN_ID}`;
  const CONSUMPTION_VERSION_ID = `p6_t1_consumption_ver_${RUN_ID}`;
  const ATTACHMENT_ID = `p6_t1_attachment_${RUN_ID}`;
  const TRIP_DATE = new Date("2033-05-01T00:00:00.000Z");

  /** Before-migration snapshots for all seven representative tables. */
  let beforeApplicationRow: Record<string, unknown>;
  let beforeTravelRow: Record<string, unknown>;
  let beforeSegmentRows: Record<string, unknown>[];
  let beforeFuelVersionRow: Record<string, unknown>;
  let beforeConsumptionVersionRow: Record<string, unknown>;
  let beforeUserRow: Record<string, unknown>;
  let beforeAttachmentRow: Record<string, unknown>;

  beforeAll(async () => {
    if (!DB_URL) return;
    admin = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await admin.$connect();
    await dropSchema(admin, schema);

    existingUrl = withSchema(DB_URL, schema);

    // Step 1: reconstruct "existing DB, pre-PHASE-006" by deploying only the
    // baseline (PHASE-005a-and-earlier) migrations onto a brand-new schema.
    baselineDir = buildBaselineMigrationsFixture();
    await runMigrateDeploy(path.join(baselineDir, "schema.prisma"), existingUrl);

    // Step 2: write representative rows across the five tables using the
    // ordinary (CURRENT-schema-generated) typed Prisma Client — safe here
    // because this Task's migration only CREATEs a brand-new table; it does
    // not touch a single column of any of these five tables, so their shape
    // in the baseline DB and the post-migration DB is identical.
    client = new PrismaClient({ datasources: { db: { url: existingUrl } } });

    await client.user.create({
      data: {
        id: OWNER_ID,
        loginName: LOGIN_NAME,
        displayName: "Phase6 T1 Owner (Fixture)",
        passwordHash: "not-a-real-hash-synthetic-fixture",
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });

    await client.fuelPriceVersion.create({
      data: {
        id: FUEL_VERSION_ID,
        fuelType: "DIESEL",
        pricePerLiter: new Prisma.Decimal("31.5000"),
        effectiveFrom: TRIP_DATE,
        createdById: OWNER_ID,
      },
    });

    await client.userFuelConsumptionVersion.create({
      data: {
        id: CONSUMPTION_VERSION_ID,
        userId: OWNER_ID,
        fuelType: "DIESEL",
        kmPerLiter: new Prisma.Decimal("12.3400"),
        effectiveFrom: TRIP_DATE,
        basisNote: "Fixture: synthetic vehicle logbook reading",
        createdById: OWNER_ID,
      },
    });

    await client.application.create({
      data: {
        id: APPLICATION_ID,
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: OWNER_ID,
        createdById: OWNER_ID,
        primaryDate: TRIP_DATE,
        totalAmount: 1234,
        completedAt: new Date(),
      },
    });

    await client.travelApplication.create({
      data: {
        applicationId: APPLICATION_ID,
        tripDate: TRIP_DATE,
        purpose: "Pre-Phase-006 synthetic business trip",
        fuelUnitPrice: new Prisma.Decimal("3.5000"),
        etcUnitPrice: new Prisma.Decimal("5.0000"),
        snapshotFuelType: "DIESEL",
        snapshotFuelPricePerLiter: new Prisma.Decimal("31.5000"),
        snapshotFuelConsumption: new Prisma.Decimal("12.3400"),
        fuelPriceVersionId: FUEL_VERSION_ID,
        fuelConsumptionVersionId: CONSUMPTION_VERSION_ID,
        snapshotTotalKm: new Prisma.Decimal("120.50"),
        snapshotRawAmount: new Prisma.Decimal("725.7500"),
        calculatedAt: new Date(),
      },
    });

    await client.tripSegment.create({
      data: {
        id: TRIP_SEGMENT_ID_1,
        travelApplicationId: APPLICATION_ID,
        sortOrder: 0,
        origin: "Fixture Origin A",
        destination: "Fixture Dest A",
        totalKm: new Prisma.Decimal("70.25"),
        highwayKm: new Prisma.Decimal("10.00"),
        snapshotFuelAmount: new Prisma.Decimal("250.0000"),
        snapshotEtcAmount: new Prisma.Decimal("150.0000"),
        snapshotRawAmount: new Prisma.Decimal("400.0000"),
        snapshotAmount: 400,
      },
    });
    await client.tripSegment.create({
      data: {
        id: TRIP_SEGMENT_ID_2,
        travelApplicationId: APPLICATION_ID,
        sortOrder: 1,
        origin: "Fixture Origin B",
        destination: "Fixture Dest B",
        totalKm: new Prisma.Decimal("50.25"),
        highwayKm: new Prisma.Decimal("0.00"),
        snapshotFuelAmount: new Prisma.Decimal("200.0000"),
        snapshotEtcAmount: new Prisma.Decimal("125.7500"),
        snapshotRawAmount: new Prisma.Decimal("325.7500"),
        snapshotAmount: 326,
      },
    });

    // Attachment: representative lifecycle-state row (LINKED, referencing the
    // first TripSegment above) — covers AC-01(b)'s explicit Attachment table.
    await client.attachment.create({
      data: {
        id: ATTACHMENT_ID,
        status: "LINKED",
        storageKey: `p6_t1_storage_${RUN_ID}`,
        thumbnailKey: `p6_t1_thumb_${RUN_ID}`,
        mimeType: "image/jpeg",
        byteSize: 123456,
        originalFilename: "phase6-t1-fixture.jpg",
        uploaderId: OWNER_ID,
        ownerId: OWNER_ID,
        refType: "TRIP_SEGMENT",
        refId: TRIP_SEGMENT_ID_1,
        linkedAt: new Date(),
      },
    });

    // Capture the "before" snapshots across all seven representative tables.
    const appRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "Application" WHERE id = $1`,
      APPLICATION_ID
    );
    expect(appRows).toHaveLength(1);
    beforeApplicationRow = canonicalizeRow(appRows[0]);

    const travelRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "TravelApplication" WHERE "applicationId" = $1`,
      APPLICATION_ID
    );
    expect(travelRows).toHaveLength(1);
    beforeTravelRow = canonicalizeRow(travelRows[0]);

    const segmentRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "TripSegment" WHERE "travelApplicationId" = $1 ORDER BY "sortOrder"`,
      APPLICATION_ID
    );
    expect(segmentRows).toHaveLength(2);
    beforeSegmentRows = segmentRows.map(canonicalizeRow);

    const fuelVersionRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "FuelPriceVersion" WHERE id = $1`,
      FUEL_VERSION_ID
    );
    expect(fuelVersionRows).toHaveLength(1);
    beforeFuelVersionRow = canonicalizeRow(fuelVersionRows[0]);

    const consumptionVersionRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "UserFuelConsumptionVersion" WHERE id = $1`,
      CONSUMPTION_VERSION_ID
    );
    expect(consumptionVersionRows).toHaveLength(1);
    beforeConsumptionVersionRow = canonicalizeRow(consumptionVersionRows[0]);

    const userRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "User" WHERE id = $1`,
      OWNER_ID
    );
    expect(userRows).toHaveLength(1);
    beforeUserRow = canonicalizeRow(userRows[0]);

    const attachmentRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "Attachment" WHERE id = $1`,
      ATTACHMENT_ID
    );
    expect(attachmentRows).toHaveLength(1);
    beforeAttachmentRow = canonicalizeRow(attachmentRows[0]);

    // Step 3: apply the REST of this Phase's migrations (real schema + real
    // migrations dir, i.e. the new M1) on top of the same schema — the
    // actual "existing DB gets upgraded" path.
    await runMigrateDeploy(REAL_SCHEMA_PATH, existingUrl);
  });

  afterAll(async () => {
    if (!DB_URL) return;
    if (client) await client.$disconnect();
    await dropSchema(admin, schema);
    await admin.$disconnect();
    if (baselineDir) fs.rmSync(baselineDir, { recursive: true, force: true });
  });

  it("Done When: prisma migrate deploy succeeds incrementally against an existing (pre-Phase) DB", () => {
    expect(beforeApplicationRow).toBeDefined();
    expect(beforeTravelRow).toBeDefined();
    expect(beforeSegmentRows).toHaveLength(2);
    expect(beforeFuelVersionRow).toBeDefined();
    expect(beforeConsumptionVersionRow).toBeDefined();
    expect(beforeUserRow).toBeDefined();
    expect(beforeAttachmentRow).toBeDefined();
  });

  it("Done When: every pre-existing column, across all five representative tables, is byte-for-byte unchanged after migration", async () => {
    const appRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "Application" WHERE id = $1`,
      APPLICATION_ID
    );
    expect(appRows).toHaveLength(1);
    assertRowUnchanged("Application", beforeApplicationRow, canonicalizeRow(appRows[0]));

    const travelRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "TravelApplication" WHERE "applicationId" = $1`,
      APPLICATION_ID
    );
    expect(travelRows).toHaveLength(1);
    assertRowUnchanged("TravelApplication", beforeTravelRow, canonicalizeRow(travelRows[0]));

    const segmentRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "TripSegment" WHERE "travelApplicationId" = $1 ORDER BY "sortOrder"`,
      APPLICATION_ID
    );
    expect(segmentRows).toHaveLength(2);
    const afterSegmentRows = segmentRows.map(canonicalizeRow);
    for (let i = 0; i < beforeSegmentRows.length; i++) {
      assertRowUnchanged(`TripSegment[${i}]`, beforeSegmentRows[i], afterSegmentRows[i]);
    }

    const fuelVersionRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "FuelPriceVersion" WHERE id = $1`,
      FUEL_VERSION_ID
    );
    expect(fuelVersionRows).toHaveLength(1);
    assertRowUnchanged(
      "FuelPriceVersion",
      beforeFuelVersionRow,
      canonicalizeRow(fuelVersionRows[0])
    );

    const consumptionVersionRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "UserFuelConsumptionVersion" WHERE id = $1`,
      CONSUMPTION_VERSION_ID
    );
    expect(consumptionVersionRows).toHaveLength(1);
    assertRowUnchanged(
      "UserFuelConsumptionVersion",
      beforeConsumptionVersionRow,
      canonicalizeRow(consumptionVersionRows[0])
    );

    const userRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "User" WHERE id = $1`,
      OWNER_ID
    );
    expect(userRows).toHaveLength(1);
    assertRowUnchanged("User", beforeUserRow, canonicalizeRow(userRows[0]));

    const attachmentRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "Attachment" WHERE id = $1`,
      ATTACHMENT_ID
    );
    expect(attachmentRows).toHaveLength(1);
    assertRowUnchanged("Attachment", beforeAttachmentRow, canonicalizeRow(attachmentRows[0]));
  });

  it("the new MaintenanceApplication table exists and is empty after migrating an existing DB", async () => {
    const rows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "MaintenanceApplication"`
    );
    expect(Number(rows[0]?.count ?? -1)).toBe(0);
  });
});

// ===========================================================================
// Done When: clean DB + new table read/write + precision round-trip +
// enum union baseline
// ===========================================================================

describeWithDb("PHASE-006-T1 migration safety net — clean DB", () => {
  const schema = `phase6_t1_clean_${RUN_ID}`;
  let cleanUrl: string;
  let admin: PrismaClient;
  let client: PrismaClient;

  beforeAll(async () => {
    if (!DB_URL) return;
    admin = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await admin.$connect();
    await dropSchema(admin, schema);
    cleanUrl = withSchema(DB_URL, schema);
    await runMigrateDeploy(REAL_SCHEMA_PATH, cleanUrl);
    client = new PrismaClient({ datasources: { db: { url: cleanUrl } } });
  });

  afterAll(async () => {
    if (!DB_URL) return;
    if (client) await client.$disconnect();
    await dropSchema(admin, schema);
    await admin.$disconnect();
  });

  it("Done When: prisma migrate deploy succeeds end-to-end against a brand-new empty DB", async () => {
    const migrationRows = await client.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
    >(`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`);
    expect(migrationRows).toHaveLength(countMigrationDirs());
    for (const row of migrationRows) {
      expect(row.finished_at).not.toBeNull();
      expect(row.rolled_back_at).toBeNull();
    }

    await expect(client.maintenanceApplication.count()).resolves.toBe(0);
  });

  // PHASE-007-T1R-LITE: the business-table total moved 14→15 when PHASE-007's
  // `DepreciationApplication` was created. The count is a moving number, so it
  // is updated here rather than weakened — the discriminating part of this
  // test (MaintenanceApplication is present, i.e. PHASE-006's table survives
  // later Phases' migrations) is unchanged.
  it("Done When: MaintenanceApplication 仍在 15 張業務表中", async () => {
    const tableRows = await client.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`
    );
    expect(tableRows.length).toBe(15);
    expect(tableRows.map((r) => r.table_name)).toContain("MaintenanceApplication");
  });

  it("full-null draft row writes and reads back (all optional columns null)", async () => {
    const owner = await client.user.create({
      data: {
        loginName: `p6_t1_clean_owner_${RUN_ID}`,
        displayName: "Phase6 T1 Clean Owner (Fixture)",
        passwordHash: "not-a-real-hash-synthetic-fixture",
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const app = await client.application.create({
      data: {
        type: "MAINTENANCE",
        status: "DRAFT",
        ownerId: owner.id,
        createdById: owner.id,
        primaryDate: new Date("2033-06-01T00:00:00.000Z"),
      },
    });

    const draft = await client.maintenanceApplication.create({
      data: { applicationId: app.id },
    });

    expect(draft.lastMaintenanceDate).toBeNull();
    expect(draft.currentMaintenanceDate).toBeNull();
    expect(draft.lastOdometerKm).toBeNull();
    expect(draft.currentOdometerKm).toBeNull();
    expect(draft.actualCost).toBeNull();
    expect(draft.snapshotIntervalKm).toBeNull();
    expect(draft.snapshotOfficialKm).toBeNull();
    expect(draft.snapshotRatio).toBeNull();
    expect(draft.snapshotRawAmount).toBeNull();
    expect(draft.calculatedAt).toBeNull();

    const reread = await client.maintenanceApplication.findUniqueOrThrow({
      where: { applicationId: app.id },
    });
    expect(reread).toEqual(draft);
  });

  it("precision round-trip: 10,2 / 12,2 / 9,6 / 14,4 each preserve full scale through a write + read", async () => {
    const owner = await client.user.create({
      data: {
        loginName: `p6_t1_clean_precision_owner_${RUN_ID}`,
        displayName: "Phase6 T1 Precision Owner (Fixture)",
        passwordHash: "not-a-real-hash-synthetic-fixture",
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const app = await client.application.create({
      data: {
        type: "MAINTENANCE",
        status: "COMPLETED",
        ownerId: owner.id,
        createdById: owner.id,
        primaryDate: new Date("2033-06-15T00:00:00.000Z"),
        totalAmount: 5000,
        completedAt: new Date(),
      },
    });

    const written = await client.maintenanceApplication.create({
      data: {
        applicationId: app.id,
        lastMaintenanceDate: new Date("2033-01-15T00:00:00.000Z"),
        currentMaintenanceDate: new Date("2033-06-15T00:00:00.000Z"),
        // Decimal(10,2)
        lastOdometerKm: new Prisma.Decimal("12345.67"),
        currentOdometerKm: new Prisma.Decimal("13000.10"),
        // Decimal(12,2)
        actualCost: new Prisma.Decimal("98765432.10"),
        snapshotIntervalKm: new Prisma.Decimal("654.32"),
        snapshotOfficialKm: new Prisma.Decimal("5000.00"),
        // Decimal(9,6)
        snapshotRatio: new Prisma.Decimal("0.130864"),
        // Decimal(14,4)
        snapshotRawAmount: new Prisma.Decimal("9876543210.1234"),
        calculatedAt: new Date(),
      },
    });

    const reread = await client.maintenanceApplication.findUniqueOrThrow({
      where: { applicationId: app.id },
    });

    // .toFixed(scale) (not .toString(), which trims trailing zeros) proves the
    // DB actually stored and returned the full DECIMAL(p,s) scale.
    expect(reread.lastOdometerKm?.toFixed(2)).toBe("12345.67");
    expect(reread.currentOdometerKm?.toFixed(2)).toBe("13000.10");
    expect(reread.actualCost?.toFixed(2)).toBe("98765432.10");
    expect(reread.snapshotIntervalKm?.toFixed(2)).toBe("654.32");
    expect(reread.snapshotOfficialKm?.toFixed(2)).toBe("5000.00");
    expect(reread.snapshotRatio?.toFixed(6)).toBe("0.130864");
    expect(reread.snapshotRawAmount?.toFixed(4)).toBe("9876543210.1234");
    expect(written.applicationId).toBe(app.id);
  });

  it("enum union baseline — ApplicationType/AttachmentRefType/ApplicationStatus/AuditAction exactly match the pre-T1 set (no silent additions)", async () => {
    async function enumLabels(typeName: string): Promise<string[]> {
      const rows = await client.$queryRawUnsafe<Array<{ enumlabel: string }>>(
        `SELECT e.enumlabel FROM pg_enum e
         JOIN pg_type t ON e.enumtypid = t.oid
         JOIN pg_namespace n ON t.typnamespace = n.oid
         WHERE t.typname = $1 AND n.nspname = current_schema()
         ORDER BY e.enumlabel`,
        typeName
      );
      return rows.map((r) => r.enumlabel);
    }

    expect((await enumLabels("ApplicationType")).sort()).toEqual(
      ["DEPRECIATION", "MAINTENANCE", "TRAVEL"].sort()
    );
    expect((await enumLabels("AttachmentRefType")).sort()).toEqual(
      ["DEPRECIATION", "MAINTENANCE", "TRIP_SEGMENT"].sort()
    );
    expect((await enumLabels("ApplicationStatus")).sort()).toEqual(
      ["COMPLETED", "DRAFT", "VOIDED"].sort()
    );
    expect((await enumLabels("AuditAction")).sort()).toEqual(
      [
        "USER_CREATED",
        "USER_DEACTIVATED",
        "USER_ACTIVATED",
        "USER_PASSWORD_RESET",
        "USER_DELETED",
        "PARAMETER_VERSION_CREATED",
        "APPLICATION_CREATED_ON_BEHALF",
        "APPLICATION_UPDATED_ON_BEHALF",
        "USER_FUEL_CONSUMPTION_VERSION_CREATED",
      ].sort()
    );
  });
});
