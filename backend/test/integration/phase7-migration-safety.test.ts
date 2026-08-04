/**
 * Integration tests for PHASE-007-T1 — Schema + migration safety net.
 *
 * TDD: written BEFORE the T1 implementation existed (schema.prisma had no
 * `DepreciationApplication` model, `Application` had no `depreciation` reverse
 * relation, and no `20260804*_phase7_depreciation_model` migration directory
 * existed on disk). First run was RED because TypeScript failed to compile
 * (`prisma.depreciationApplication` did not exist on the generated client) and
 * the migration this file expects on disk did not exist.
 *
 * Covers Spec docs/specs/PHASE-007.md §8 (資料模型與 migration) and §15 Task
 * T1's Done When:
 *   "既有／乾淨 DB 皆 migrate 成功；八表逐欄零改寫；鍵集全等（ADD COLUMN
 *    mutant 必紅）；enum 聯集全等；infra001 連動處逐一實查"
 * i.e. AC-01 (a)~(f).
 *
 * Like PHASE-006-T1 (and unlike PHASE-005a-T1, which ALTERed
 * `TravelApplication` and added an `AuditAction` value), this Task's migration
 * is CREATE-TABLE-only (§8.4 M1: 零 ALTER、零回填 on any pre-existing table) —
 * so every column of the eight representative tables below is already present,
 * identically, in both the pre-PHASE-007 baseline (all migrations through
 * PHASE-006) and the post-PHASE-007 state, and the ordinary generated Prisma
 * Client can safely be used for both the "before" writes and the "after"
 * reads. Only raw `SELECT *` is used for the column-for-column comparison
 * itself, so that any accidental rewrite this Task's migration should be
 * structurally incapable of causing is still caught.
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
 * (branch phase-007, base commit 84f0cfa) — i.e. the full PHASE-006 state.
 * Used to reconstruct an "existing DB, pre-PHASE-007" scratch schema so this
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
  "20260804001701_phase6_maintenance_model",
];

/** The one migration directory this Task adds (AC-01, §8.4 M1). */
const NEW_MIGRATION_DIR = "20260804120000_phase7_depreciation_model";

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
 * ONLY the pre-PHASE-007 migration directories, so `prisma migrate deploy`
 * against it reproduces "an existing DB that has PHASE-006 applied but not yet
 * PHASE-007" — without touching the real `prisma/migrations/` directory.
 */
function buildBaselineMigrationsFixture(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase7-t1-baseline-"));
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
  // Closed-set guard (AC-01(b) 鍵集全等): also assert the column SET itself is
  // unchanged, not just the values under `before`'s keys — otherwise a
  // migration that ADDs a column (even NOT NULL DEFAULT ...) to one of these
  // tables would silently pass this check, since the new key is invisible to a
  // loop keyed off `before`.
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
// AC-01(b)/(c)/(d): existing-DB incremental migration safety net —
// column-for-column zero-rewrite check across the EIGHT tables the AC names
// (PHASE-006's seven + MaintenanceApplication).
// ===========================================================================

describeWithDb("PHASE-007-T1 migration safety net — existing DB", () => {
  const schema = `phase7_t1_existing_${RUN_ID}`;
  let existingUrl: string;
  let admin: PrismaClient;
  let baselineDir: string;
  let client: PrismaClient;

  const OWNER_ID = `p7_t1_owner_${RUN_ID}`;
  const LOGIN_NAME = `p7_t1_owner_${RUN_ID}`;
  const APPLICATION_ID = `p7_t1_app_${RUN_ID}`;
  const MAINTENANCE_APPLICATION_ID = `p7_t1_mapp_${RUN_ID}`;
  const TRIP_SEGMENT_ID_1 = `p7_t1_seg1_${RUN_ID}`;
  const TRIP_SEGMENT_ID_2 = `p7_t1_seg2_${RUN_ID}`;
  const FUEL_VERSION_ID = `p7_t1_fuel_ver_${RUN_ID}`;
  const CONSUMPTION_VERSION_ID = `p7_t1_consumption_ver_${RUN_ID}`;
  const ATTACHMENT_ID = `p7_t1_attachment_${RUN_ID}`;
  const TRIP_DATE = new Date("2034-05-01T00:00:00.000Z");

  /** Before-migration snapshots for all eight representative tables. */
  let beforeApplicationRow: Record<string, unknown>;
  let beforeTravelRow: Record<string, unknown>;
  let beforeSegmentRows: Record<string, unknown>[];
  let beforeMaintenanceRow: Record<string, unknown>;
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

    // Step 1: reconstruct "existing DB, pre-PHASE-007" by deploying only the
    // baseline (PHASE-006-and-earlier) migrations onto a brand-new schema.
    baselineDir = buildBaselineMigrationsFixture();
    await runMigrateDeploy(path.join(baselineDir, "schema.prisma"), existingUrl);

    // Step 2: write representative rows across the eight tables using the
    // ordinary (CURRENT-schema-generated) typed Prisma Client — safe here
    // because this Task's migration only CREATEs a brand-new table; it does
    // not touch a single column of any of these eight tables, so their shape
    // in the baseline DB and the post-migration DB is identical.
    client = new PrismaClient({ datasources: { db: { url: existingUrl } } });

    await client.user.create({
      data: {
        id: OWNER_ID,
        loginName: LOGIN_NAME,
        displayName: "Phase7 T1 Owner (Fixture)",
        passwordHash: "not-a-real-hash-synthetic-fixture",
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });

    await client.fuelPriceVersion.create({
      data: {
        id: FUEL_VERSION_ID,
        fuelType: "GASOLINE_95",
        pricePerLiter: new Prisma.Decimal("32.7000"),
        effectiveFrom: TRIP_DATE,
        createdById: OWNER_ID,
      },
    });

    await client.userFuelConsumptionVersion.create({
      data: {
        id: CONSUMPTION_VERSION_ID,
        userId: OWNER_ID,
        fuelType: "GASOLINE_95",
        kmPerLiter: new Prisma.Decimal("14.5600"),
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
        purpose: "Pre-Phase-007 synthetic business trip",
        fuelUnitPrice: new Prisma.Decimal("3.5000"),
        etcUnitPrice: new Prisma.Decimal("5.0000"),
        snapshotFuelType: "GASOLINE_95",
        snapshotFuelPricePerLiter: new Prisma.Decimal("32.7000"),
        snapshotFuelConsumption: new Prisma.Decimal("14.5600"),
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

    // MaintenanceApplication (the 8th table, added to AC-01(b)'s list by this
    // Phase): a COMPLETED row with every snapshot column populated, so a
    // rewrite of any of them would be caught.
    await client.application.create({
      data: {
        id: MAINTENANCE_APPLICATION_ID,
        type: "MAINTENANCE",
        status: "COMPLETED",
        ownerId: OWNER_ID,
        createdById: OWNER_ID,
        primaryDate: TRIP_DATE,
        totalAmount: 4321,
        completedAt: new Date(),
      },
    });
    await client.maintenanceApplication.create({
      data: {
        applicationId: MAINTENANCE_APPLICATION_ID,
        lastMaintenanceDate: new Date("2034-01-10T00:00:00.000Z"),
        currentMaintenanceDate: TRIP_DATE,
        lastOdometerKm: new Prisma.Decimal("10000.00"),
        currentOdometerKm: new Prisma.Decimal("15500.55"),
        actualCost: new Prisma.Decimal("8800.25"),
        snapshotIntervalKm: new Prisma.Decimal("5500.55"),
        snapshotOfficialKm: new Prisma.Decimal("2750.25"),
        snapshotRatio: new Prisma.Decimal("0.500000"),
        snapshotRawAmount: new Prisma.Decimal("4400.1250"),
        calculatedAt: new Date(),
      },
    });

    // Attachment: representative lifecycle-state row (LINKED, referencing the
    // first TripSegment above) — covers AC-01(b)'s explicit Attachment table.
    await client.attachment.create({
      data: {
        id: ATTACHMENT_ID,
        status: "LINKED",
        storageKey: `p7_t1_storage_${RUN_ID}`,
        thumbnailKey: `p7_t1_thumb_${RUN_ID}`,
        mimeType: "image/jpeg",
        byteSize: 123456,
        originalFilename: "phase7-t1-fixture.jpg",
        uploaderId: OWNER_ID,
        ownerId: OWNER_ID,
        refType: "TRIP_SEGMENT",
        refId: TRIP_SEGMENT_ID_1,
        linkedAt: new Date(),
      },
    });

    // Capture the "before" snapshots across all eight representative tables.
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

    const maintenanceRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "MaintenanceApplication" WHERE "applicationId" = $1`,
      MAINTENANCE_APPLICATION_ID
    );
    expect(maintenanceRows).toHaveLength(1);
    beforeMaintenanceRow = canonicalizeRow(maintenanceRows[0]);

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
    // migrations dir, i.e. the new M1) on top of the same schema — the actual
    // "existing DB gets upgraded" path.
    await runMigrateDeploy(REAL_SCHEMA_PATH, existingUrl);
  });

  afterAll(async () => {
    if (!DB_URL) return;
    if (client) await client.$disconnect();
    await dropSchema(admin, schema);
    await admin.$disconnect();
    if (baselineDir) fs.rmSync(baselineDir, { recursive: true, force: true });
  });

  it("AC-01(b): prisma migrate deploy succeeds incrementally against an existing (pre-Phase) DB", () => {
    expect(beforeApplicationRow).toBeDefined();
    expect(beforeTravelRow).toBeDefined();
    expect(beforeSegmentRows).toHaveLength(2);
    expect(beforeMaintenanceRow).toBeDefined();
    expect(beforeFuelVersionRow).toBeDefined();
    expect(beforeConsumptionVersionRow).toBeDefined();
    expect(beforeUserRow).toBeDefined();
    expect(beforeAttachmentRow).toBeDefined();
  });

  it("AC-01(b): every pre-existing column, across all eight representative tables, is byte-for-byte unchanged after migration", async () => {
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

    const maintenanceRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "MaintenanceApplication" WHERE "applicationId" = $1`,
      MAINTENANCE_APPLICATION_ID
    );
    expect(maintenanceRows).toHaveLength(1);
    assertRowUnchanged(
      "MaintenanceApplication",
      beforeMaintenanceRow,
      canonicalizeRow(maintenanceRows[0])
    );

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

  it("AC-01(b) 突變自證: the zero-rewrite comparator is discriminating — a single rewritten value, and a single ADDed column, each make it red", () => {
    // Guards against the previous test being vacuously green (e.g. if
    // `assertRowUnchanged` were ever weakened to a no-op, or the "before"
    // snapshot were captured after the migration instead of before it).
    // Both mutants are applied to a LOCAL copy of a real captured row, so no
    // DB state is touched.

    // Mutant 1 — rewrite one existing column's value.
    const rewritten = { ...beforeTravelRow, snapshotTotalKm: "999.99" };
    expect(() => assertRowUnchanged("mutant/rewrite", beforeTravelRow, rewritten)).toThrow();

    // Mutant 2 — ADD COLUMN (the closed-set guard; invisible to a loop keyed
    // off `before`'s keys alone).
    const addedColumn = { ...beforeApplicationRow, someNewColumn: null };
    expect(() =>
      assertRowUnchanged("mutant/add-column", beforeApplicationRow, addedColumn)
    ).toThrow();

    // Control — the unmutated row must still pass, proving the comparator is
    // not simply throwing unconditionally.
    expect(() =>
      assertRowUnchanged("control", beforeApplicationRow, { ...beforeApplicationRow })
    ).not.toThrow();
  });

  it("AC-01(c): the new DepreciationApplication table exists and is empty (零回填) after migrating an existing DB", async () => {
    const rows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "DepreciationApplication"`
    );
    expect(Number(rows[0]?.count ?? -1)).toBe(0);
  });

  it("AC-01(d): re-running migrate deploy against the already-upgraded existing DB is idempotent (no-op, still succeeds)", async () => {
    await runMigrateDeploy(REAL_SCHEMA_PATH, existingUrl);

    const migrationRows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`
    );
    expect(Number(migrationRows[0]?.count ?? -1)).toBe(countMigrationDirs());

    // Still empty, and the eight tables' rows still intact.
    const rows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "DepreciationApplication"`
    );
    expect(Number(rows[0]?.count ?? -1)).toBe(0);

    const appRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "Application" WHERE id = $1`,
      APPLICATION_ID
    );
    expect(appRows).toHaveLength(1);
    assertRowUnchanged("Application/idempotent", beforeApplicationRow, canonicalizeRow(appRows[0]));
  });
});

// ===========================================================================
// AC-01(a)/(c)/(d)/(e): clean DB + new table shape + precision round-trip +
// enum union baseline + zero-ALTER static check.
// ===========================================================================

describeWithDb("PHASE-007-T1 migration safety net — clean DB", () => {
  const schema = `phase7_t1_clean_${RUN_ID}`;
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

  it("AC-01(a)/(d): prisma migrate deploy succeeds end-to-end against a brand-new empty DB, and is idempotent on re-run", async () => {
    const migrationRows = await client.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
    >(`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`);
    expect(migrationRows).toHaveLength(countMigrationDirs());
    for (const row of migrationRows) {
      expect(row.finished_at).not.toBeNull();
      expect(row.rolled_back_at).toBeNull();
    }
    expect(migrationRows.map((r) => r.migration_name)).toContain(NEW_MIGRATION_DIR);

    await expect(client.depreciationApplication.count()).resolves.toBe(0);

    // Idempotency: a second deploy is a no-op and still exits 0.
    await runMigrateDeploy(REAL_SCHEMA_PATH, cleanUrl);
    const afterRows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "_prisma_migrations"`
    );
    expect(Number(afterRows[0]?.count ?? -1)).toBe(countMigrationDirs());
  });

  it("AC-01(f) 表數 14→15 — DepreciationApplication is the 15th business table", async () => {
    const tableRows = await client.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`
    );
    expect(tableRows.length).toBe(15);
    expect(tableRows.map((r) => r.table_name)).toContain("DepreciationApplication");
  });

  it("AC-01(a): the new table's column set, nullability and numeric precision match Spec §8.2 逐欄", async () => {
    const columnRows = await client.$queryRawUnsafe<
      Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        numeric_precision: number | null;
        numeric_scale: number | null;
      }>
    >(
      `SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'DepreciationApplication'`
    );

    const actual = Object.fromEntries(
      columnRows.map((r) => [
        r.column_name,
        {
          data_type: r.data_type,
          is_nullable: r.is_nullable,
          numeric: r.numeric_precision === null ? null : [r.numeric_precision, r.numeric_scale],
        },
      ])
    );

    // Closed-set: the column set itself is asserted, so an extra column added
    // to the new table (or a renamed one) turns this red.
    expect(Object.keys(actual).sort()).toEqual(
      [
        "applicationId",
        "applicationYear",
        "snapshotVehiclePrice",
        "snapshotUsefulLifeYears",
        "snapshotEstimatedAnnualKm",
        "snapshotPerKmUnitPrice",
        "snapshotOfficialKm",
        "snapshotRawAmount",
        "calculatedAt",
        "depreciationParameterVersionId",
      ].sort()
    );

    expect(actual.applicationId).toEqual({
      data_type: "text",
      is_nullable: "NO",
      numeric: null,
    });
    // Spec §8.3: applicationYear / usefulLifeYears / estimatedAnnualKm are int4
    // (business range is narrowed by the validation layer, §16 D3(a)).
    for (const col of [
      "applicationYear",
      "snapshotUsefulLifeYears",
      "snapshotEstimatedAnnualKm",
    ] as const) {
      expect(actual[col], `column ${col}`).toEqual({
        data_type: "integer",
        is_nullable: "YES",
        numeric: [32, 0],
      });
    }
    // Spec §8.3: Decimal(12,2) — same as the source DepreciationParameterVersion
    // .vehiclePrice and MaintenanceApplication.snapshotOfficialKm.
    for (const col of ["snapshotVehiclePrice", "snapshotOfficialKm"] as const) {
      expect(actual[col], `column ${col}`).toEqual({
        data_type: "numeric",
        is_nullable: "YES",
        numeric: [12, 2],
      });
    }
    // Spec §8.3 容量缺口 #1: the unit price is Decimal(14,4), NOT the travel
    // Decimal(10,4) — a (10,4) column would be an artificial capacity gap
    // (perKmUnitPrice's theoretical upper bound is ~1e10, > 1e6).
    for (const col of ["snapshotPerKmUnitPrice", "snapshotRawAmount"] as const) {
      expect(actual[col], `column ${col}`).toEqual({
        data_type: "numeric",
        is_nullable: "YES",
        numeric: [14, 4],
      });
    }
    expect(actual.calculatedAt).toEqual({
      data_type: "timestamp without time zone",
      is_nullable: "YES",
      numeric: null,
    });
    expect(actual.depreciationParameterVersionId).toEqual({
      data_type: "text",
      is_nullable: "YES",
      numeric: null,
    });
  });

  it("AC-01(a): the new table's PK, FK (onDelete: Cascade) and the two §8.2 indexes exist", async () => {
    const constraintRows = await client.$queryRawUnsafe<
      Array<{ conname: string; contype: string; confdeltype: string | null }>
    >(
      `SELECT c.conname, c.contype::text AS contype, c.confdeltype::text AS confdeltype
         FROM pg_constraint c
         JOIN pg_class t ON c.conrelid = t.oid
         JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE n.nspname = current_schema() AND t.relname = 'DepreciationApplication'`
    );
    expect(constraintRows.some((r) => r.contype === "p")).toBe(true);
    const fk = constraintRows.find((r) => r.contype === "f");
    expect(fk).toBeDefined();
    // 'c' = ON DELETE CASCADE (Spec §8.2 relation onDelete: Cascade).
    expect(fk?.confdeltype).toBe("c");

    const indexRows = await client.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'DepreciationApplication'`
    );
    const indexNames = indexRows.map((r) => r.indexname);
    expect(indexNames).toContain("DepreciationApplication_applicationYear_idx");
    expect(indexNames).toContain("DepreciationApplication_depreciationParameterVersionId_idx");
  });

  it("AC-01(c): the migration SQL performs zero ALTER on any pre-existing table (Application 父表零 ALTER)", () => {
    const sql = fs.readFileSync(
      path.join(REAL_MIGRATIONS_DIR, NEW_MIGRATION_DIR, "migration.sql"),
      "utf8"
    );

    // Every ALTER TABLE in this migration must target the brand-new table only
    // (Prisma emits the FK as `ALTER TABLE "DepreciationApplication" ADD
    // CONSTRAINT ...`). Any ALTER against Application / TravelApplication /
    // ... would be a §8.4 violation.
    const alterTargets = [...sql.matchAll(/ALTER TABLE\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(alterTargets).size).toBeLessThanOrEqual(1);
    for (const target of alterTargets) {
      expect(target).toBe("DepreciationApplication");
    }

    // 零回填: no data-moving statements at all.
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+"/i);
    // 不新增 enum 值 (AC-01(e)) — statically, at the SQL level too.
    expect(sql).not.toMatch(/ALTER TYPE/i);
    expect(sql).toMatch(/CREATE TABLE "DepreciationApplication"/);
  });

  it("AC-01(a): full-null draft row writes and reads back (all optional columns null)", async () => {
    const owner = await client.user.create({
      data: {
        loginName: `p7_t1_clean_owner_${RUN_ID}`,
        displayName: "Phase7 T1 Clean Owner (Fixture)",
        passwordHash: "not-a-real-hash-synthetic-fixture",
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const app = await client.application.create({
      data: {
        type: "DEPRECIATION",
        status: "DRAFT",
        ownerId: owner.id,
        createdById: owner.id,
        primaryDate: new Date("2034-06-01T00:00:00.000Z"),
      },
    });

    const draft = await client.depreciationApplication.create({
      data: { applicationId: app.id },
    });

    expect(draft.applicationYear).toBeNull();
    expect(draft.snapshotVehiclePrice).toBeNull();
    expect(draft.snapshotUsefulLifeYears).toBeNull();
    expect(draft.snapshotEstimatedAnnualKm).toBeNull();
    expect(draft.snapshotPerKmUnitPrice).toBeNull();
    expect(draft.snapshotOfficialKm).toBeNull();
    expect(draft.snapshotRawAmount).toBeNull();
    expect(draft.calculatedAt).toBeNull();
    expect(draft.depreciationParameterVersionId).toBeNull();

    const reread = await client.depreciationApplication.findUniqueOrThrow({
      where: { applicationId: app.id },
    });
    expect(reread).toEqual(draft);
  });

  it("AC-01(a) 精度往返: Decimal(12,2) / Decimal(14,4) boundary values round-trip byte-for-byte", async () => {
    const owner = await client.user.create({
      data: {
        loginName: `p7_t1_clean_precision_owner_${RUN_ID}`,
        displayName: "Phase7 T1 Precision Owner (Fixture)",
        passwordHash: "not-a-real-hash-synthetic-fixture",
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const app = await client.application.create({
      data: {
        type: "DEPRECIATION",
        status: "COMPLETED",
        ownerId: owner.id,
        createdById: owner.id,
        primaryDate: new Date("2034-12-31T00:00:00.000Z"),
        totalAmount: 2147483647,
        completedAt: new Date(),
      },
    });

    await client.depreciationApplication.create({
      data: {
        applicationId: app.id,
        applicationYear: 2034,
        // Decimal(12,2) upper boundary
        snapshotVehiclePrice: new Prisma.Decimal("9999999999.99"),
        snapshotOfficialKm: new Prisma.Decimal("9999999999.99"),
        snapshotUsefulLifeYears: 2147483647,
        snapshotEstimatedAnnualKm: 2147483647,
        // Decimal(14,4) upper boundary — Spec §8.3 容量缺口 #1: this value is
        // NOT representable in the travel-style Decimal(10,4), so this
        // assertion also kills a (10,4) mutant.
        snapshotPerKmUnitPrice: new Prisma.Decimal("9999999999.9999"),
        snapshotRawAmount: new Prisma.Decimal("9999999999.9999"),
        calculatedAt: new Date("2034-12-31T10:20:30.123Z"),
        depreciationParameterVersionId: `p7_t1_dep_ver_${RUN_ID}`,
      },
    });

    const reread = await client.depreciationApplication.findUniqueOrThrow({
      where: { applicationId: app.id },
    });

    // .toFixed(scale) (not .toString(), which trims trailing zeros) proves the
    // DB actually stored and returned the full DECIMAL(p,s) scale.
    expect(reread.snapshotVehiclePrice?.toFixed(2)).toBe("9999999999.99");
    expect(reread.snapshotOfficialKm?.toFixed(2)).toBe("9999999999.99");
    expect(reread.snapshotPerKmUnitPrice?.toFixed(4)).toBe("9999999999.9999");
    expect(reread.snapshotRawAmount?.toFixed(4)).toBe("9999999999.9999");
    expect(reread.applicationYear).toBe(2034);
    expect(reread.snapshotUsefulLifeYears).toBe(2147483647);
    expect(reread.snapshotEstimatedAnnualKm).toBe(2147483647);
    expect(reread.depreciationParameterVersionId).toBe(`p7_t1_dep_ver_${RUN_ID}`);

    // Trailing-zero / scale-truncation guard: a value whose scale must be
    // preserved exactly (003a's 4dp unit price, §16 D6).
    const app2 = await client.application.create({
      data: {
        type: "DEPRECIATION",
        status: "COMPLETED",
        ownerId: owner.id,
        createdById: owner.id,
        primaryDate: new Date("2033-12-31T00:00:00.000Z"),
        totalAmount: 0,
        completedAt: new Date(),
      },
    });
    await client.depreciationApplication.create({
      data: {
        applicationId: app2.id,
        applicationYear: 2033,
        snapshotPerKmUnitPrice: new Prisma.Decimal("1.1000"),
        snapshotOfficialKm: new Prisma.Decimal("0.00"),
        snapshotRawAmount: new Prisma.Decimal("0.0000"),
      },
    });
    const reread2 = await client.depreciationApplication.findUniqueOrThrow({
      where: { applicationId: app2.id },
    });
    expect(reread2.snapshotPerKmUnitPrice?.toFixed(4)).toBe("1.1000");
    expect(reread2.snapshotOfficialKm?.toFixed(2)).toBe("0.00");
    expect(reread2.snapshotRawAmount?.toFixed(4)).toBe("0.0000");
  });

  it("AC-01(a): applicationYear 之業務值域邊界 1900/2999 皆可持久化（DB 層不設限，收斂於驗證層）", async () => {
    const owner = await client.user.create({
      data: {
        loginName: `p7_t1_clean_year_owner_${RUN_ID}`,
        displayName: "Phase7 T1 Year Owner (Fixture)",
        passwordHash: "not-a-real-hash-synthetic-fixture",
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    for (const year of [1900, 2999]) {
      const app = await client.application.create({
        data: {
          type: "DEPRECIATION",
          status: "DRAFT",
          ownerId: owner.id,
          createdById: owner.id,
          primaryDate: new Date(Date.UTC(year, 11, 31)),
        },
      });
      const row = await client.depreciationApplication.create({
        data: { applicationId: app.id, applicationYear: year },
      });
      expect(row.applicationYear).toBe(year);
    }
  });

  it("AC-01(c): DepreciationApplication rows cascade-delete with their parent Application (無孤兒子列)", async () => {
    const owner = await client.user.create({
      data: {
        loginName: `p7_t1_clean_cascade_owner_${RUN_ID}`,
        displayName: "Phase7 T1 Cascade Owner (Fixture)",
        passwordHash: "not-a-real-hash-synthetic-fixture",
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const app = await client.application.create({
      data: {
        type: "DEPRECIATION",
        status: "DRAFT",
        ownerId: owner.id,
        createdById: owner.id,
        primaryDate: new Date("2034-06-02T00:00:00.000Z"),
      },
    });
    await client.depreciationApplication.create({ data: { applicationId: app.id } });

    await client.application.delete({ where: { id: app.id } });

    await expect(
      client.depreciationApplication.findUnique({ where: { applicationId: app.id } })
    ).resolves.toBeNull();
  });

  it("AC-01(e) enum union baseline — all seven enums exactly match the pre-T1 set (no silent additions)", async () => {
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
    expect((await enumLabels("AttachmentStatus")).sort()).toEqual(["LINKED", "TEMP"].sort());
    expect((await enumLabels("Role")).sort()).toEqual(["ADMIN", "USER"].sort());
    expect((await enumLabels("FuelType")).sort()).toEqual(
      ["DIESEL", "GASOLINE_92", "GASOLINE_95", "GASOLINE_98"].sort()
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
