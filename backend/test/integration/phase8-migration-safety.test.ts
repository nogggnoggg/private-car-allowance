/**
 * Integration tests for PHASE-008-T1 — `Report` schema + migration safety net.
 *
 * TDD: written against a schema/migration state that did not yet exist
 * (schema.prisma had no `Report` model, `Application` had no `report` reverse
 * relation, and no `20260806090000_phase8_report_model` migration directory
 * existed on disk). Redness was verified mechanically by temporarily
 * reverting `backend/prisma/schema.prisma` (git stash) and moving the new
 * migration directory aside, regenerating the Prisma client against that
 * reverted schema, and re-running this file: 10 of 19 `it`s in the "clean DB"
 * and "existing DB" blocks went red — `relation "Report" does not exist`
 * (raw SQL against the not-yet-created table), `Cannot read properties of
 * undefined (reading 'create')` (`client.report` is absent from a client
 * generated without the model — `tsc --noEmit` does not cover `test/`, so
 * this surfaces at runtime, not compile time), and `ENOENT` (the migration
 * directory this file reads did not exist). The remaining 9 passed
 * vacuously (they exercise pre-existing tables/enums/AR-1 columns untouched
 * by this Task). Reverted afterwards, matching the PHASE-006/007-T1 "TDD
 * safety net" precedent this file follows structurally (§ below "Existing
 * Patterns"). See Task Handoff for the exact stash/restore transcript.
 *
 * Covers Spec docs/specs/PHASE-008.md §8 (資料模型與 migration) and §15 Task
 * T1's Done When, i.e. AC-01(a)~(g):
 *   (a) Report 表逐欄相符 §8.1；四個唯一約束＋一個一般索引；FK ON DELETE RESTRICT。
 *   (b) 九表值比對＋零-ALTER 靜態掃描覆蓋 15 表；migration SQL 零 ALTER 於既有表／
 *       零 DROP／零 INSERT・UPDATE／零 ALTER TYPE。
 *   (c) 乾淨 DB 與既有 DB 各一輪 migrate deploy 成功、重跑冪等；Report 表在既有
 *       DB 上為空表。
 *   (d) `Application.report Report?` 為零 DDL 虛擬關聯（Application 欄位集合
 *       前後全等）。
 *   (e) 零 enum 異動（七個既有 enum 之標籤集合前後全等）。
 *   (f) 表數 15→16（本檔自身之一份斷言；四處既有測試檔之連動見下方「AC-01(f)
 *       表數連動」章節末的 Handoff 附註——本檔不改動那四個檔案，那四個檔案的
 *       Edit 是這個 Task 的另一半，記在 Handoff）。
 *   (g)（AR-1 移交結案）`RATIO_DISPLAY_SCALE` ↔ `snapshotRatio` 之
 *       `numeric_scale` 對照（折舊、保養各一組），雙側 mutant 自證。
 *
 * FW-8 確認（Spec §8.5）：本 Phase migration 為純 `CREATE TABLE` ＋ 純
 * `CREATE INDEX` ＋ 一個 `ADD CONSTRAINT`，對既有表零 `ALTER`——故「既有列零
 * 改寫」的 fixture 可安全沿用 PHASE-007-T1（M1 段）之既有手法：用 CURRENT
 * schema.prisma 產生的一般 Prisma Client 寫入 baseline fixture（因為這些既有
 * 表在 migration 前後的欄位集合逐字相同），不需要 PHASE-007-R1（M2，ALTER
 * 型）那種 raw SQL fixture。
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
const SRC_DIR = path.join(BACKEND_ROOT, "src");

/** T1 即審 FW-1 承接（§8.3）：`history.ts` 之路徑，及其零 diff 之權威來源。 */
const HISTORY_TS_PATH = path.join(SRC_DIR, "users", "history.ts");
/**
 * §8.3 明文宣告：本 Phase 對 `backend/src/users/history.ts` 零變更
 * （該檔自 PHASE-005a-T1 的 `35b30e7` 起未再變動）。此值為
 * PHASE-008-T1b 開工當下該檔內容的 SHA-256（`sha256(fs.readFileSync(...,
 * "utf8"))`，十六進位）——任何一個位元組的改動都會使下方比對變紅。
 */
const HISTORY_TS_EXPECTED_SHA256 =
  "62f4841dc02d851460e46c8d747bfcffdd38a8dbeb7ff96ed57c0ca347221e89";

/**
 * The migration directories that existed immediately before this Phase
 * (branch phase-008, base commit 92eed7f) — i.e. the full PHASE-007 (incl.
 * R1 revision) state. Used to reconstruct an "existing DB, pre-PHASE-008"
 * scratch schema so this file can exercise the REAL incremental
 * `prisma migrate deploy` upgrade path.
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
  "20260804120000_phase7_depreciation_model",
  "20260805090000_phase7_depreciation_revision",
];

/** The one migration directory this Task adds (AC-01, §8.5). */
const NEW_MIGRATION_DIR = "20260806090000_phase8_report_model";

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
 * ONLY the pre-PHASE-008 migration directories, so `prisma migrate deploy`
 * against it reproduces "an existing DB that has PHASE-007 applied but not
 * yet PHASE-008" — without touching the real `prisma/migrations/` directory.
 */
function buildBaselineMigrationsFixture(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase8-t1-baseline-"));
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
  // migration that ADDs a column to one of these tables would silently pass
  // this check, since the new key is invisible to a loop keyed off `before`.
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

/**
 * T1 即審 AR-1 承接（phase8 檔內部分）：純函式，統計一段 migration SQL 文字含
 * 幾條語句（先去除 `-- ...` 行註解，再以 `;` 切割、濾除空白片段）。
 *
 * 目的：§8.5 逐字斷言（`CREATE TABLE` 恰 1、`CREATE UNIQUE INDEX` 恰 4……）
 * 各自獨立比對「特定關鍵字」的出現次數，對「注入一條完全不含這些關鍵字的
 * 新語句」（例如 `CREATE TYPE ... AS ENUM (...);`）沒有防禦力——那類語句不會
 * 讓任何一條既有逐項斷言變紅，卻會讓語句總數多出一條。這條總數鎖是最後一道
 * 防線（封 M10 型：注入 DELETE FROM 之類的破壞性語句／M12 型：注入一條不在
 * 既有關鍵字清單內的全新語句類型）。
 */
function countSqlStatements(sql: string): number {
  const withoutLineComments = sql
    .split("\n")
    .map((line) => (line.trim().startsWith("--") ? "" : line))
    .join("\n");
  return withoutLineComments
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0).length;
}

// ===========================================================================
// AC-01(b)/(c)/(d): existing-DB incremental migration safety net —
// column-for-column zero-rewrite check across nine representative tables
// spanning every model family (auth, application core, travel, maintenance,
// depreciation, parameter versioning, attachment).
// ===========================================================================

describeWithDb("PHASE-008-T1 migration safety net — existing DB", () => {
  const schema = `phase8_t1_existing_${RUN_ID}`;
  let existingUrl: string;
  let admin: PrismaClient;
  let baselineDir: string;
  let client: PrismaClient;

  const OWNER_ID = `p8_t1_owner_${RUN_ID}`;
  const LOGIN_NAME = `p8_t1_owner_${RUN_ID}`;
  const TRAVEL_APPLICATION_ID = `p8_t1_app_travel_${RUN_ID}`;
  const MAINTENANCE_APPLICATION_ID = `p8_t1_app_maint_${RUN_ID}`;
  const DEPRECIATION_APPLICATION_ID = `p8_t1_app_dep_${RUN_ID}`;
  const TRIP_SEGMENT_ID = `p8_t1_seg_${RUN_ID}`;
  const FUEL_VERSION_ID = `p8_t1_fuel_ver_${RUN_ID}`;
  const CONSUMPTION_VERSION_ID = `p8_t1_consumption_ver_${RUN_ID}`;
  const ATTACHMENT_ID = `p8_t1_attachment_${RUN_ID}`;
  const TRIP_DATE = new Date("2034-05-01T00:00:00.000Z");

  /** Before-migration snapshots for all nine representative tables. */
  let beforeUserRow: Record<string, unknown>;
  let beforeTravelAppRow: Record<string, unknown>;
  let beforeTravelRow: Record<string, unknown>;
  let beforeSegmentRow: Record<string, unknown>;
  let beforeMaintenanceAppRow: Record<string, unknown>;
  let beforeMaintenanceRow: Record<string, unknown>;
  let beforeDepreciationAppRow: Record<string, unknown>;
  let beforeDepreciationRow: Record<string, unknown>;
  let beforeFuelVersionRow: Record<string, unknown>;
  let beforeConsumptionVersionRow: Record<string, unknown>;
  let beforeAttachmentRow: Record<string, unknown>;

  beforeAll(async () => {
    if (!DB_URL) return;
    admin = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await admin.$connect();
    await dropSchema(admin, schema);

    existingUrl = withSchema(DB_URL, schema);

    // Step 1: reconstruct "existing DB, pre-PHASE-008" by deploying only the
    // baseline (PHASE-007-and-earlier) migrations onto a brand-new schema.
    baselineDir = buildBaselineMigrationsFixture();
    await runMigrateDeploy(path.join(baselineDir, "schema.prisma"), existingUrl);

    // Step 2: write representative rows using the ordinary
    // (CURRENT-schema-generated) typed Prisma Client — safe here because this
    // Task's migration only CREATEs a brand-new table; it does not touch a
    // single column of any of these nine tables.
    client = new PrismaClient({ datasources: { db: { url: existingUrl } } });

    await client.user.create({
      data: {
        id: OWNER_ID,
        loginName: LOGIN_NAME,
        displayName: "Phase8 T1 Owner (Fixture)",
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
        id: TRAVEL_APPLICATION_ID,
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
        applicationId: TRAVEL_APPLICATION_ID,
        tripDate: TRIP_DATE,
        purpose: "Pre-Phase-008 synthetic business trip",
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
        id: TRIP_SEGMENT_ID,
        travelApplicationId: TRAVEL_APPLICATION_ID,
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

    await client.application.create({
      data: {
        id: DEPRECIATION_APPLICATION_ID,
        type: "DEPRECIATION",
        status: "COMPLETED",
        ownerId: OWNER_ID,
        createdById: OWNER_ID,
        primaryDate: TRIP_DATE,
        totalAmount: 5678,
        completedAt: new Date(),
      },
    });
    await client.depreciationApplication.create({
      data: {
        applicationId: DEPRECIATION_APPLICATION_ID,
        applicationYear: 2034,
        annualTotalKm: new Prisma.Decimal("20000.0"),
        snapshotVehiclePrice: new Prisma.Decimal("600000.00"),
        snapshotUsefulLifeYears: 5,
        snapshotAnnualDepreciation: new Prisma.Decimal("120000.00"),
        snapshotOfficialKm: new Prisma.Decimal("10000.00"),
        snapshotAnnualTotalKm: new Prisma.Decimal("20000.0"),
        snapshotRatio: new Prisma.Decimal("0.500000"),
        snapshotRawAmount: new Prisma.Decimal("60000.0000"),
        calculatedAt: new Date(),
        depreciationParameterVersionId: `p8_t1_dep_ver_${RUN_ID}`,
      },
    });

    // Attachment: representative lifecycle-state row (LINKED, referencing the
    // TripSegment above).
    await client.attachment.create({
      data: {
        id: ATTACHMENT_ID,
        status: "LINKED",
        storageKey: `p8_t1_storage_${RUN_ID}`,
        thumbnailKey: `p8_t1_thumb_${RUN_ID}`,
        mimeType: "image/jpeg",
        byteSize: 123456,
        originalFilename: "phase8-t1-fixture.jpg",
        uploaderId: OWNER_ID,
        ownerId: OWNER_ID,
        refType: "TRIP_SEGMENT",
        refId: TRIP_SEGMENT_ID,
        linkedAt: new Date(),
      },
    });

    // Capture the "before" snapshots across all nine representative tables.
    beforeUserRow = canonicalizeRow(
      (
        await client.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "User" WHERE id = $1`,
          OWNER_ID
        )
      )[0]
    );
    beforeTravelAppRow = canonicalizeRow(
      (
        await client.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "Application" WHERE id = $1`,
          TRAVEL_APPLICATION_ID
        )
      )[0]
    );
    beforeTravelRow = canonicalizeRow(
      (
        await client.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "TravelApplication" WHERE "applicationId" = $1`,
          TRAVEL_APPLICATION_ID
        )
      )[0]
    );
    beforeSegmentRow = canonicalizeRow(
      (
        await client.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "TripSegment" WHERE id = $1`,
          TRIP_SEGMENT_ID
        )
      )[0]
    );
    beforeMaintenanceAppRow = canonicalizeRow(
      (
        await client.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "Application" WHERE id = $1`,
          MAINTENANCE_APPLICATION_ID
        )
      )[0]
    );
    beforeMaintenanceRow = canonicalizeRow(
      (
        await client.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "MaintenanceApplication" WHERE "applicationId" = $1`,
          MAINTENANCE_APPLICATION_ID
        )
      )[0]
    );
    beforeDepreciationAppRow = canonicalizeRow(
      (
        await client.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "Application" WHERE id = $1`,
          DEPRECIATION_APPLICATION_ID
        )
      )[0]
    );
    beforeDepreciationRow = canonicalizeRow(
      (
        await client.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "DepreciationApplication" WHERE "applicationId" = $1`,
          DEPRECIATION_APPLICATION_ID
        )
      )[0]
    );
    beforeFuelVersionRow = canonicalizeRow(
      (
        await client.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "FuelPriceVersion" WHERE id = $1`,
          FUEL_VERSION_ID
        )
      )[0]
    );
    beforeConsumptionVersionRow = canonicalizeRow(
      (
        await client.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "UserFuelConsumptionVersion" WHERE id = $1`,
          CONSUMPTION_VERSION_ID
        )
      )[0]
    );
    beforeAttachmentRow = canonicalizeRow(
      (
        await client.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "Attachment" WHERE id = $1`,
          ATTACHMENT_ID
        )
      )[0]
    );

    // Step 3: apply the REST of this Phase's migrations (real schema + real
    // migrations dir, i.e. the new Report migration) on top of the same
    // schema — the actual "existing DB gets upgraded" path.
    await runMigrateDeploy(REAL_SCHEMA_PATH, existingUrl);
  });

  afterAll(async () => {
    if (!DB_URL) return;
    if (client) await client.$disconnect();
    await dropSchema(admin, schema);
    await admin.$disconnect();
    if (baselineDir) fs.rmSync(baselineDir, { recursive: true, force: true });
  });

  it("AC-01(c): prisma migrate deploy succeeds incrementally against an existing (pre-Phase) DB", () => {
    expect(beforeUserRow).toBeDefined();
    expect(beforeTravelAppRow).toBeDefined();
    expect(beforeTravelRow).toBeDefined();
    expect(beforeSegmentRow).toBeDefined();
    expect(beforeMaintenanceAppRow).toBeDefined();
    expect(beforeMaintenanceRow).toBeDefined();
    expect(beforeDepreciationAppRow).toBeDefined();
    expect(beforeDepreciationRow).toBeDefined();
    expect(beforeFuelVersionRow).toBeDefined();
    expect(beforeConsumptionVersionRow).toBeDefined();
    expect(beforeAttachmentRow).toBeDefined();
  });

  it("AC-01(b): every pre-existing column, across all nine representative tables, is byte-for-byte unchanged after migration", async () => {
    const checks: Array<[string, string, Record<string, unknown>, unknown]> = [
      ["User", `SELECT * FROM "User" WHERE id = $1`, beforeUserRow, OWNER_ID],
      [
        "Application/Travel",
        `SELECT * FROM "Application" WHERE id = $1`,
        beforeTravelAppRow,
        TRAVEL_APPLICATION_ID,
      ],
      [
        "TravelApplication",
        `SELECT * FROM "TravelApplication" WHERE "applicationId" = $1`,
        beforeTravelRow,
        TRAVEL_APPLICATION_ID,
      ],
      [
        "TripSegment",
        `SELECT * FROM "TripSegment" WHERE id = $1`,
        beforeSegmentRow,
        TRIP_SEGMENT_ID,
      ],
      [
        "Application/Maintenance",
        `SELECT * FROM "Application" WHERE id = $1`,
        beforeMaintenanceAppRow,
        MAINTENANCE_APPLICATION_ID,
      ],
      [
        "MaintenanceApplication",
        `SELECT * FROM "MaintenanceApplication" WHERE "applicationId" = $1`,
        beforeMaintenanceRow,
        MAINTENANCE_APPLICATION_ID,
      ],
      [
        "Application/Depreciation",
        `SELECT * FROM "Application" WHERE id = $1`,
        beforeDepreciationAppRow,
        DEPRECIATION_APPLICATION_ID,
      ],
      [
        "DepreciationApplication",
        `SELECT * FROM "DepreciationApplication" WHERE "applicationId" = $1`,
        beforeDepreciationRow,
        DEPRECIATION_APPLICATION_ID,
      ],
      [
        "FuelPriceVersion",
        `SELECT * FROM "FuelPriceVersion" WHERE id = $1`,
        beforeFuelVersionRow,
        FUEL_VERSION_ID,
      ],
      [
        "UserFuelConsumptionVersion",
        `SELECT * FROM "UserFuelConsumptionVersion" WHERE id = $1`,
        beforeConsumptionVersionRow,
        CONSUMPTION_VERSION_ID,
      ],
      [
        "Attachment",
        `SELECT * FROM "Attachment" WHERE id = $1`,
        beforeAttachmentRow,
        ATTACHMENT_ID,
      ],
    ];

    for (const [label, sql, before, id] of checks) {
      const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(sql, id);
      expect(rows, label).toHaveLength(1);
      assertRowUnchanged(label, before, canonicalizeRow(rows[0]));
    }
  });

  it("AC-01(b) 突變自證: the zero-rewrite comparator is discriminating — a single rewritten value, and a single ADDed column, each make it red", () => {
    // Both mutants are applied to a LOCAL copy of a real captured row, so no
    // DB state is touched.
    const rewritten = { ...beforeTravelRow, snapshotTotalKm: "999.99" };
    expect(() => assertRowUnchanged("mutant/rewrite", beforeTravelRow, rewritten)).toThrow();

    const addedColumn = { ...beforeTravelAppRow, someNewColumn: null };
    expect(() =>
      assertRowUnchanged("mutant/add-column", beforeTravelAppRow, addedColumn)
    ).toThrow();

    // Control — the unmutated row must still pass, proving the comparator is
    // not simply throwing unconditionally.
    expect(() =>
      assertRowUnchanged("control", beforeTravelAppRow, { ...beforeTravelAppRow })
    ).not.toThrow();
  });

  it("AC-01(c): the new Report table exists and is empty (零回填) after migrating an existing DB", async () => {
    const rows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "Report"`
    );
    expect(Number(rows[0]?.count ?? -1)).toBe(0);
  });

  it("AC-01(c): re-running migrate deploy against the already-upgraded existing DB is idempotent (no-op, still succeeds)", async () => {
    await runMigrateDeploy(REAL_SCHEMA_PATH, existingUrl);

    const migrationRows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`
    );
    expect(Number(migrationRows[0]?.count ?? -1)).toBe(countMigrationDirs());

    const rows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "Report"`
    );
    expect(Number(rows[0]?.count ?? -1)).toBe(0);

    // Existing rows still intact after the idempotent re-run too.
    const appRows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "Application" WHERE id = $1`,
      TRAVEL_APPLICATION_ID
    );
    expect(appRows).toHaveLength(1);
    assertRowUnchanged("Application/idempotent", beforeTravelAppRow, canonicalizeRow(appRows[0]));
  });
});

// ===========================================================================
// AC-01(a)/(c)/(d)/(e)/(f): clean DB + new table shape + constraints + FK +
// enum union baseline + zero-ALTER static check + Application 欄位集合零 DDL。
// ===========================================================================

describeWithDb("PHASE-008-T1 migration safety net — clean DB", () => {
  const schema = `phase8_t1_clean_${RUN_ID}`;
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

  it("AC-01(c): prisma migrate deploy succeeds end-to-end against a brand-new empty DB, and is idempotent on re-run", async () => {
    const migrationRows = await client.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
    >(`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`);
    expect(migrationRows).toHaveLength(countMigrationDirs());
    for (const row of migrationRows) {
      expect(row.finished_at).not.toBeNull();
      expect(row.rolled_back_at).toBeNull();
    }
    expect(migrationRows.map((r) => r.migration_name)).toContain(NEW_MIGRATION_DIR);

    await expect(client.report.count()).resolves.toBe(0);

    // Idempotency: a second deploy is a no-op and still exits 0.
    await runMigrateDeploy(REAL_SCHEMA_PATH, cleanUrl);
    const afterRows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "_prisma_migrations"`
    );
    expect(Number(afterRows[0]?.count ?? -1)).toBe(countMigrationDirs());
  });

  it("AC-01(f) 表數 15→16 — Report is the 16th business table", async () => {
    const tableRows = await client.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`
    );
    expect(tableRows.length).toBe(16);
    expect(tableRows.map((r) => r.table_name)).toContain("Report");
  });

  it("AC-01(a): the new table's column set, nullability and numeric precision match Spec §8.1 逐欄", async () => {
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
        WHERE table_schema = current_schema() AND table_name = 'Report'`
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
        "id",
        "applicationId",
        "reportNumber",
        "numberPrefix",
        "numberPeriod",
        "sequence",
        "storageKey",
        "fileName",
        "byteSize",
        "contentHash",
        "generatedById",
        "generatedAt",
      ].sort()
    );

    // §8.1: every column is NOT NULL (no `?` in the model) — the report is
    // either fully written in one transaction or not written at all (AC-06/07).
    for (const col of Object.keys(actual)) {
      expect(actual[col].is_nullable, `column ${col} must be NOT NULL`).toBe("NO");
    }

    for (const col of [
      "id",
      "applicationId",
      "reportNumber",
      "storageKey",
      "fileName",
      "contentHash",
      "generatedById",
    ] as const) {
      expect(actual[col], `column ${col}`).toEqual({
        data_type: "text",
        is_nullable: "NO",
        numeric: null,
      });
    }
    // numberPrefix/numberPeriod: plain text columns (not enums — §8.2 推導).
    for (const col of ["numberPrefix", "numberPeriod"] as const) {
      expect(actual[col], `column ${col}`).toEqual({
        data_type: "text",
        is_nullable: "NO",
        numeric: null,
      });
    }
    for (const col of ["sequence", "byteSize"] as const) {
      expect(actual[col], `column ${col}`).toEqual({
        data_type: "integer",
        is_nullable: "NO",
        numeric: [32, 0],
      });
    }
    expect(actual.generatedAt).toEqual({
      data_type: "timestamp without time zone",
      is_nullable: "NO",
      numeric: null,
    });
  });

  it("AC-01(a): the new table's PK, FK (onDelete: Restrict), four unique constraints and one general index exist", async () => {
    const constraintRows = await client.$queryRawUnsafe<
      Array<{ conname: string; contype: string; confdeltype: string | null }>
    >(
      `SELECT c.conname, c.contype::text AS contype, c.confdeltype::text AS confdeltype
         FROM pg_constraint c
         JOIN pg_class t ON c.conrelid = t.oid
         JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE n.nspname = current_schema() AND t.relname = 'Report'`
    );
    expect(constraintRows.some((r) => r.contype === "p")).toBe(true);
    const fk = constraintRows.find((r) => r.contype === "f");
    expect(fk).toBeDefined();
    // 'r' = ON DELETE RESTRICT (Spec §8.1/§8.2 relation onDelete: Restrict).
    expect(fk?.confdeltype).toBe("r");

    const indexRows = await client.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'Report'`
    );
    const indexNames = indexRows.map((r) => r.indexname);

    // Four unique indexes (§8.1/§8.2): applicationId, reportNumber,
    // storageKey, (numberPrefix, numberPeriod, sequence).
    expect(indexNames).toContain("Report_applicationId_key");
    expect(indexNames).toContain("Report_reportNumber_key");
    expect(indexNames).toContain("Report_storageKey_key");
    expect(indexNames).toContain("Report_numberPrefix_numberPeriod_sequence_key");
    // One general (non-unique) index for the max(sequence) query.
    expect(indexNames).toContain("Report_numberPrefix_numberPeriod_idx");

    // Exclude the PK-backing index ("Report_pkey") — §8.1/§8.2's "four unique
    // constraints" refers to the four `@unique`/`@@unique` attributes, not the
    // `@id` primary key (already asserted separately above via `contype = 'p'`).
    const nonPkIndexRows = indexRows.filter((r) => r.indexname !== "Report_pkey");
    const uniqueCount = nonPkIndexRows.filter((r) =>
      r.indexdef.includes("CREATE UNIQUE INDEX")
    ).length;
    expect(uniqueCount).toBe(4);
    const generalCount = nonPkIndexRows.filter(
      (r) => !r.indexdef.includes("CREATE UNIQUE INDEX")
    ).length;
    expect(generalCount).toBe(1);
  });

  it("AC-01(b): the migration SQL performs zero ALTER on any pre-existing table, zero DROP/INSERT/UPDATE/ALTER TYPE", () => {
    const sql = fs.readFileSync(
      path.join(REAL_MIGRATIONS_DIR, NEW_MIGRATION_DIR, "migration.sql"),
      "utf8"
    );

    // Every ALTER TABLE in this migration must target the brand-new table
    // only (Prisma emits the FK as `ALTER TABLE "Report" ADD CONSTRAINT ...`).
    // Any ALTER against Application / TravelApplication / ... would be a
    // §8.5 violation.
    const alterTargets = [...sql.matchAll(/ALTER TABLE\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(alterTargets).size).toBeLessThanOrEqual(1);
    for (const target of alterTargets) {
      expect(target).toBe("Report");
    }

    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+"/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/ALTER TYPE/i);
    expect(sql).toMatch(/CREATE TABLE "Report"/);

    // §8.5 逐字：僅一個 CREATE TABLE、四個 CREATE UNIQUE INDEX、一個 CREATE
    // INDEX（非 UNIQUE）、一個 ALTER TABLE ADD CONSTRAINT ... FOREIGN KEY。
    expect((sql.match(/CREATE TABLE/gi) ?? []).length).toBe(1);
    expect((sql.match(/CREATE UNIQUE INDEX/gi) ?? []).length).toBe(4);
    // "CREATE INDEX" also matches inside "CREATE UNIQUE INDEX" lines, so
    // subtract those to get the count of plain (non-unique) CREATE INDEX.
    const createIndexTotal = (sql.match(/CREATE (?:UNIQUE )?INDEX/gi) ?? []).length;
    expect(createIndexTotal - 4).toBe(1);
    expect((sql.match(/ADD CONSTRAINT/gi) ?? []).length).toBe(1);
    expect((sql.match(/FOREIGN KEY/gi) ?? []).length).toBe(1);
  });

  // ===========================================================================
  // T1 即審 AR-1 承接（phase8 檔內部分）：語句總數鎖死——上面的逐項關鍵字比對
  // 各自獨立，對「注入一條不含任何既有關鍵字的全新語句」沒有防禦力（見
  // `countSqlStatements` 之說明）；此鎖為最後一道防線。
  // ===========================================================================

  it("T1 即審 AR-1: migration.sql 恰為 7 條語句（封 M10/M12 型穿透——任何被注入之額外語句，即使不含既有關鍵字，總數鎖仍會變紅）", () => {
    const sql = fs.readFileSync(
      path.join(REAL_MIGRATIONS_DIR, NEW_MIGRATION_DIR, "migration.sql"),
      "utf8"
    );
    expect(countSqlStatements(sql)).toBe(7);
  });

  it("T1 即審 AR-1 mutant 自證: 注入一條 DELETE FROM（M10 型）或一條 CREATE TYPE（M12 型，不含任何既有關鍵字比對）皆使語句總數鎖變紅", () => {
    const realSql = fs.readFileSync(
      path.join(REAL_MIGRATIONS_DIR, NEW_MIGRATION_DIR, "migration.sql"),
      "utf8"
    );
    const realCount = countSqlStatements(realSql);
    expect(realCount).toBe(7); // control — 真實內容本身即為 7。

    // M10 型：注入破壞性 DML。
    const withDelete = `${realSql}\nDELETE FROM "Report";\n`;
    expect(countSqlStatements(withDelete)).not.toBe(realCount);

    // M12 型：注入一條「既有逐項關鍵字比對」完全偵測不到的全新語句類型
    // （注入片段本身不含 CREATE TABLE / CREATE (UNIQUE) INDEX / ADD
    // CONSTRAINT / FOREIGN KEY 任一關鍵字）——證明總數鎖是這類穿透的最後防線。
    const injectedStatement = "CREATE TYPE \"InjectedEnum\" AS ENUM ('A');";
    expect(injectedStatement).not.toMatch(
      /CREATE TABLE|CREATE (?:UNIQUE )?INDEX|ADD CONSTRAINT|FOREIGN KEY/
    );
    const withCreateType = `${realSql}\n${injectedStatement}\n`;
    expect(countSqlStatements(withCreateType)).not.toBe(realCount);
  });

  // ===========================================================================
  // T1 即審 AR-2 承接：`Report.generatedAt` 之 `datetime_precision`／
  // `column_default` 對照（§8.1 `generatedAt DateTime @default(now())`）。
  // ===========================================================================

  /**
   * DDL 側 `datetime_precision`／`column_default` ↔ 期望值之比較器。雙側
   * mutant 自證（下方 it）以此函式為受測對象，不直接改動真實 DB。
   */
  function assertGeneratedAtDefaultMatches(
    label: string,
    ddlDatetimePrecision: number | null,
    ddlColumnDefault: string | null
  ): void {
    expect(ddlDatetimePrecision, `${label}: datetime_precision`).toBe(3);
    expect(ddlColumnDefault, `${label}: column_default`).toContain("CURRENT_TIMESTAMP");
  }

  it("T1 即審 AR-2: Report.generatedAt 之 datetime_precision=3 ∧ column_default 含 CURRENT_TIMESTAMP", async () => {
    const rows = await client.$queryRawUnsafe<
      Array<{ datetime_precision: number | null; column_default: string | null }>
    >(
      `SELECT datetime_precision, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'Report' AND column_name = 'generatedAt'`
    );
    expect(rows).toHaveLength(1);
    assertGeneratedAtDefaultMatches(
      "Report.generatedAt",
      rows[0].datetime_precision,
      rows[0].column_default
    );
  });

  it("T1 即審 AR-2 mutant 自證: 錯誤的 datetime_precision，或缺少 CURRENT_TIMESTAMP 之 default，各自獨立使比較器變紅", () => {
    expect(() =>
      assertGeneratedAtDefaultMatches("mutant/precision=6", 6, "CURRENT_TIMESTAMP")
    ).toThrow();
    expect(() => assertGeneratedAtDefaultMatches("mutant/default=null", 3, null)).toThrow();
    // control — 兩側皆為真實值時不拋錯，證明比較器不是恆真拋錯。
    expect(() => assertGeneratedAtDefaultMatches("control", 3, "CURRENT_TIMESTAMP")).not.toThrow();
  });

  it("AC-01(a): a fully-populated row writes and reads back byte-for-byte (every column is required — no draft/null state exists for Report)", async () => {
    const owner = await client.user.create({
      data: {
        loginName: `p8_t1_clean_owner_${RUN_ID}`,
        displayName: "Phase8 T1 Clean Owner (Fixture)",
        passwordHash: "not-a-real-hash-synthetic-fixture",
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const app = await client.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: owner.id,
        createdById: owner.id,
        primaryDate: new Date("2034-06-01T00:00:00.000Z"),
        totalAmount: 999,
        completedAt: new Date(),
      },
    });

    const report = await client.report.create({
      data: {
        applicationId: app.id,
        reportNumber: "TRV-203406-0001",
        numberPrefix: "TRV",
        numberPeriod: "203406",
        sequence: 1,
        storageKey: `rpt/${RUN_ID}/pdf`,
        fileName: "TRV-203406-0001.pdf",
        byteSize: 204800,
        contentHash: "a".repeat(64),
        generatedById: owner.id,
      },
    });

    expect(report.reportNumber).toBe("TRV-203406-0001");
    expect(report.sequence).toBe(1);
    expect(report.byteSize).toBe(204800);

    const reread = await client.report.findUniqueOrThrow({ where: { applicationId: app.id } });
    expect(reread).toEqual(report);

    // Reverse relation (AC-01(d)): `Application.report` resolves to this row.
    const appWithReport = await client.application.findUniqueOrThrow({
      where: { id: app.id },
      include: { report: true },
    });
    expect(appWithReport.report?.id).toBe(report.id);
  });

  it("AC-01(a): FK onDelete: Restrict — deleting an Application that has a Report is rejected by the DB", async () => {
    const owner = await client.user.create({
      data: {
        loginName: `p8_t1_restrict_owner_${RUN_ID}`,
        displayName: "Phase8 T1 Restrict Owner (Fixture)",
        passwordHash: "not-a-real-hash-synthetic-fixture",
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const app = await client.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: owner.id,
        createdById: owner.id,
        primaryDate: new Date("2034-06-02T00:00:00.000Z"),
        totalAmount: 1,
        completedAt: new Date(),
      },
    });
    await client.report.create({
      data: {
        applicationId: app.id,
        reportNumber: `TRV-203406-RESTRICT-${RUN_ID}`,
        numberPrefix: "TRV",
        numberPeriod: "203406",
        sequence: 9001,
        storageKey: `rpt/${RUN_ID}-restrict/pdf`,
        fileName: "restrict-fixture.pdf",
        byteSize: 1024,
        contentHash: "b".repeat(64),
        generatedById: owner.id,
      },
    });

    let caught: unknown = null;
    try {
      await client.application.delete({ where: { id: app.id } });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    // Prisma surfaces FK restrict violations as P2003 (or an equivalent
    // constraint-violation error) — assert on the underlying mechanism, not
    // just "something threw", so a schema regression to Cascade/SetNull would
    // be caught even if the error still throws for another reason.
    expect((caught as { code?: string }).code === "P2003" || String(caught).includes("23503")).toBe(
      true
    );

    // Application must still exist — the delete must not have partially
    // succeeded.
    const stillThere = await client.application.findUnique({ where: { id: app.id } });
    expect(stillThere).not.toBeNull();
  });

  it("AC-01(a): the four unique constraints each independently reject a collision (applicationId / reportNumber / storageKey / prefix+period+sequence)", async () => {
    const owner = await client.user.create({
      data: {
        loginName: `p8_t1_unique_owner_${RUN_ID}`,
        displayName: "Phase8 T1 Unique Owner (Fixture)",
        passwordHash: "not-a-real-hash-synthetic-fixture",
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });

    async function makeApp() {
      return client.application.create({
        data: {
          type: "TRAVEL",
          status: "COMPLETED",
          ownerId: owner.id,
          createdById: owner.id,
          primaryDate: new Date("2034-06-03T00:00:00.000Z"),
          totalAmount: 1,
          completedAt: new Date(),
        },
      });
    }

    const baseApp = await makeApp();
    await client.report.create({
      data: {
        applicationId: baseApp.id,
        reportNumber: `TRV-203406-UNIQ-${RUN_ID}`,
        numberPrefix: "TRV",
        numberPeriod: "203406",
        sequence: 8001,
        storageKey: `rpt/${RUN_ID}-uniq/pdf`,
        fileName: "unique-fixture.pdf",
        byteSize: 1024,
        contentHash: "c".repeat(64),
        generatedById: owner.id,
      },
    });

    async function expectUniqueViolation(create: () => Promise<unknown>): Promise<void> {
      let caught: unknown = null;
      try {
        await create();
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      expect(
        (caught as { code?: string }).code === "P2002" || String(caught).includes("23505")
      ).toBe(true);
    }

    // (1) applicationId collision — same applicationId as baseApp's report.
    await expectUniqueViolation(() =>
      client.report.create({
        data: {
          applicationId: baseApp.id,
          reportNumber: `TRV-203406-UNIQ2-${RUN_ID}`,
          numberPrefix: "TRV",
          numberPeriod: "203406",
          sequence: 8002,
          storageKey: `rpt/${RUN_ID}-uniq2/pdf`,
          fileName: "unique-fixture-2.pdf",
          byteSize: 1024,
          contentHash: "d".repeat(64),
          generatedById: owner.id,
        },
      })
    );

    // (2) reportNumber collision — different applicationId, same reportNumber.
    const app2 = await makeApp();
    await expectUniqueViolation(() =>
      client.report.create({
        data: {
          applicationId: app2.id,
          reportNumber: `TRV-203406-UNIQ-${RUN_ID}`,
          numberPrefix: "TRV",
          numberPeriod: "203406",
          sequence: 8003,
          storageKey: `rpt/${RUN_ID}-uniq3/pdf`,
          fileName: "unique-fixture-3.pdf",
          byteSize: 1024,
          contentHash: "e".repeat(64),
          generatedById: owner.id,
        },
      })
    );

    // (3) storageKey collision.
    const app3 = await makeApp();
    await expectUniqueViolation(() =>
      client.report.create({
        data: {
          applicationId: app3.id,
          reportNumber: `TRV-203406-UNIQ4-${RUN_ID}`,
          numberPrefix: "TRV",
          numberPeriod: "203406",
          sequence: 8004,
          storageKey: `rpt/${RUN_ID}-uniq/pdf`,
          fileName: "unique-fixture-4.pdf",
          byteSize: 1024,
          contentHash: "f".repeat(64),
          generatedById: owner.id,
        },
      })
    );

    // (4) (numberPrefix, numberPeriod, sequence) collision.
    const app4 = await makeApp();
    await expectUniqueViolation(() =>
      client.report.create({
        data: {
          applicationId: app4.id,
          reportNumber: `TRV-203406-UNIQ5-${RUN_ID}`,
          numberPrefix: "TRV",
          numberPeriod: "203406",
          sequence: 8001,
          storageKey: `rpt/${RUN_ID}-uniq5/pdf`,
          fileName: "unique-fixture-5.pdf",
          byteSize: 1024,
          contentHash: "0".repeat(64),
          generatedById: owner.id,
        },
      })
    );
  });

  it("AC-01(d): `Application.report Report?` is a zero-DDL virtual relation — the Application column set is unchanged from PHASE-007", async () => {
    const columnRows = await client.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'Application'`
    );
    // Closed-set: PHASE-007's Application scalar columns, unchanged (no
    // "reportId" or similar DDL added by the new relation field).
    expect(columnRows.map((r) => r.column_name).sort()).toEqual(
      [
        "id",
        "type",
        "status",
        "ownerId",
        "createdById",
        "primaryDate",
        "totalAmount",
        "completedAt",
        "createdAt",
        "updatedAt",
      ].sort()
    );
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

  // =========================================================================
  // AC-01(g)（AR-1 移交結案）: `RATIO_DISPLAY_SCALE` ↔ `snapshotRatio` 之
  // `numeric_scale` 對照。雙側 mutant 自證：常數改為 4，或 DDL 改為 (9,4)，
  // 任一側必紅。
  //
  // `RATIO_DISPLAY_SCALE` 在 depreciation-calculation.ts / depreciation-
  // service.ts 兩檔各自宣告為模組內未匯出的 `const`（非公開 API），故無法
  // import 取值——沿 PHASE-007 T1 即審 FW-1「以實際套用之來源（此處為原始碼
  // 檔案文字，而非心智模型）為權威來源」之作法，改以正則靜態讀取原始碼中的
  // 字面值。保養顯示層（maintenance-calculation.ts / maintenance-service.ts）
  // 未設具名常數，直接以字面 `6` 呼叫 `.toFixed(6, ...)`，故以相同手法讀取該
  // 字面值。
  // =========================================================================

  function readNamedConstant(filePath: string, constantName: string): number {
    const source = fs.readFileSync(filePath, "utf8");
    const pattern = new RegExp(`const\\s+${constantName}\\s*=\\s*(\\d+)\\s*;`);
    const match = source.match(pattern);
    if (!match) {
      throw new Error(`const ${constantName} not found in ${filePath}`);
    }
    return Number.parseInt(match[1], 10);
  }

  /** 讀 `maintenance-calculation.ts` 之 `ratio.toFixed(6, ...)` 字面顯示位數。 */
  function readMaintenanceRatioToFixedScale(filePath: string, callSitePattern: RegExp): number {
    const source = fs.readFileSync(filePath, "utf8");
    const match = source.match(callSitePattern);
    if (!match) {
      throw new Error(
        `ratio toFixed call site not found in ${filePath} (pattern ${callSitePattern})`
      );
    }
    return Number.parseInt(match[1], 10);
  }

  /**
   * 常數/字面值 ↔ DDL `numeric_scale` 對照之核心比較器。雙側 mutant 自證
   * （下方 it）以此函式為受測對象——不直接改動真實原始碼或 DB，而是把
   * mutant 值餵給同一函式，證明任一側錯誤都會被判定為不相符。
   */
  function assertScaleMatches(label: string, sourceScale: number, ddlScale: number): void {
    expect(sourceScale, `${label}: source display scale ↔ DDL numeric_scale mismatch`).toBe(
      ddlScale
    );
  }

  it("AC-01(g): DepreciationApplication.snapshotRatio numeric_scale equals RATIO_DISPLAY_SCALE in both depreciation-calculation.ts and depreciation-service.ts", async () => {
    const columnRows = await client.$queryRawUnsafe<Array<{ numeric_scale: number | null }>>(
      `SELECT numeric_scale FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'DepreciationApplication'
          AND column_name = 'snapshotRatio'`
    );
    expect(columnRows).toHaveLength(1);
    const ddlScale = columnRows[0].numeric_scale;
    expect(ddlScale).not.toBeNull();

    const calcScale = readNamedConstant(
      path.join(SRC_DIR, "applications", "depreciation-calculation.ts"),
      "RATIO_DISPLAY_SCALE"
    );
    const serviceScale = readNamedConstant(
      path.join(SRC_DIR, "applications", "depreciation-service.ts"),
      "RATIO_DISPLAY_SCALE"
    );

    assertScaleMatches("depreciation-calculation.ts", calcScale, ddlScale as number);
    assertScaleMatches("depreciation-service.ts", serviceScale, ddlScale as number);
  });

  it("AC-01(g): MaintenanceApplication.snapshotRatio numeric_scale equals the display scale in maintenance-calculation.ts and maintenance-service.ts", async () => {
    const columnRows = await client.$queryRawUnsafe<Array<{ numeric_scale: number | null }>>(
      `SELECT numeric_scale FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'MaintenanceApplication'
          AND column_name = 'snapshotRatio'`
    );
    expect(columnRows).toHaveLength(1);
    const ddlScale = columnRows[0].numeric_scale;
    expect(ddlScale).not.toBeNull();

    const calcScale = readMaintenanceRatioToFixedScale(
      path.join(SRC_DIR, "applications", "maintenance-calculation.ts"),
      /const ratioString = ratio\.toFixed\((\d+),/
    );
    const serviceScale = readMaintenanceRatioToFixedScale(
      path.join(SRC_DIR, "applications", "maintenance-service.ts"),
      /snapshotRatio\.toFixed\((\d+)\)/
    );

    assertScaleMatches("maintenance-calculation.ts", calcScale, ddlScale as number);
    assertScaleMatches("maintenance-service.ts", serviceScale, ddlScale as number);
  });

  it("AC-01(g) 雙側 mutant 自證: a constant changed to 4, or a DDL changed to scale 4, each independently make the comparator red", () => {
    // Side A — the source constant is wrong (mutant: RATIO_DISPLAY_SCALE = 4)
    // while the DDL is the real, unmutated value (6).
    expect(() => assertScaleMatches("mutant/constant=4", 4, 6)).toThrow();

    // Side B — the DDL is wrong (mutant: snapshotRatio DECIMAL(9,4)) while the
    // source constant is the real, unmutated value (6).
    expect(() => assertScaleMatches("mutant/ddl=(9,4)", 6, 4)).toThrow();

    // Control — both sides real and equal (6/6) must not throw, proving the
    // comparator isn't unconditionally red.
    expect(() => assertScaleMatches("control", 6, 6)).not.toThrow();
  });

  it("AC-01(g) 讀取器鑑別力自證: readNamedConstant / readMaintenanceRatioToFixedScale actually parse the live source files (not a hardcoded stub)", () => {
    // If either reader were replaced with `return 6` regardless of file
    // content, this would still pass the assertions above vacuously. Prove
    // each reader is truly parsing file text by pointing it at a synthetic
    // temp file with a DIFFERENT value and checking it comes back different.
    const tmpFile = path.join(os.tmpdir(), `p8-t1-ar1-reader-probe-${RUN_ID}.ts`);
    try {
      fs.writeFileSync(tmpFile, "const RATIO_DISPLAY_SCALE = 9;\n", "utf8");
      expect(readNamedConstant(tmpFile, "RATIO_DISPLAY_SCALE")).toBe(9);

      fs.writeFileSync(
        tmpFile,
        "const ratioString = ratio.toFixed(9, Prisma.Decimal.ROUND_HALF_UP);\n",
        "utf8"
      );
      expect(
        readMaintenanceRatioToFixedScale(tmpFile, /const ratioString = ratio\.toFixed\((\d+),/)
      ).toBe(9);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });
});

// ===========================================================================
// T1 即審 FW-1 承接 — §11.2 末列「刪除守門回歸」，併入本檔（Spec §11.2 :708）:
//
//   「§8.3：有報表之使用者刪除仍 409 CONFLICT；history.ts 零 diff 之結構性
//   斷言」
//
// Spec §8.3 原文（逐字）：「`Report` 無 `User` FK，且每一份 `Report` 必依附於
// 一筆 `Application`（`ownerId` FK 為 `Restrict`）——既有 `userHasHistory` 之
// `application.count({ where: { ownerId } })` 已完整涵蓋。**本 Phase 不修改
// `backend/src/users/history.ts`**；以測試固定此推論（有報表之使用者刪除 →
// 仍為 `409 CONFLICT`，且錯誤來源為 Application 而非 FK 例外）。」
//
// 與 admin-users.test.ts 既有之「AC-23: userHasHistory=true → 409 CONFLICT
// (tested via custom server with stub)」差異化：既有測試以**注入的 stub**
// 強制 checker 回傳 true，驗證的是「route 層讀到 true 時會 409」；本段用真實
// `productionHistoryChecker`（不注入任何 stub）、真實 `Report`/`Application`
// 列，驗證的是「Report 這個新表本身不需要、也沒有另立一條刪除守門路徑——
// 既有的 `Application.count` 路徑已天然涵蓋」這個 §8.3 的結構性推論本身。
// 兩者鑑別面不同、互不取代。
//
// 本段自建獨立 scratch schema（同本檔既有紀律），透過真實
// `DELETE /admin/users/:id` 路由驗證契約面；`history.ts` 零 diff 以 SHA-256
// 內容雜湊固定（見上方 `HISTORY_TS_EXPECTED_SHA256`）。
// ===========================================================================

describeWithDb("T1 即審 FW-1 承接 — §8.3 刪除守門回歸", () => {
  const schema = `phase8_t1b_fw1_${RUN_ID}`;
  let scratchUrl: string;
  let admin: PrismaClient;
  let prisma: PrismaClient;
  let app: FastifyInstance;

  const ADMIN_LOGIN = `p8_t1b_admin_${RUN_ID}`;
  const REPORT_OWNER_LOGIN = `p8_t1b_report_owner_${RUN_ID}`;
  const CLEAN_USER_LOGIN = `p8_t1b_clean_user_${RUN_ID}`;
  const PASSWORD = "T1bFw1Test99!";

  let reportOwnerId: string;
  let cleanUserId: string;

  async function loginAndGetCookie(loginName: string): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName, password: PASSWORD },
    });
    if (resp.statusCode !== 200) {
      throw new Error(`Login failed for ${loginName}: ${resp.statusCode} ${resp.body}`);
    }
    const setCookie = resp.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!raw) throw new Error("No Set-Cookie header on login response");
    return raw.split(";")[0];
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    admin = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await admin.$connect();
    await dropSchema(admin, schema);
    scratchUrl = withSchema(DB_URL, schema);
    await runMigrateDeploy(REAL_SCHEMA_PATH, scratchUrl);

    prisma = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
    const passwordHash = await hashPassword(PASSWORD);

    await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "T1b FW-1 Admin (Fixture)",
        passwordHash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });

    const reportOwner = await prisma.user.create({
      data: {
        loginName: REPORT_OWNER_LOGIN,
        displayName: "T1b FW-1 Report Owner (Fixture)",
        passwordHash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    reportOwnerId = reportOwner.id;

    const cleanUser = await prisma.user.create({
      data: {
        loginName: CLEAN_USER_LOGIN,
        displayName: "T1b FW-1 Clean User (Fixture, no history)",
        passwordHash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    cleanUserId = cleanUser.id;

    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: reportOwnerId,
        createdById: reportOwnerId,
        primaryDate: new Date("2034-06-04T00:00:00.000Z"),
        totalAmount: 1,
        completedAt: new Date(),
      },
    });
    await prisma.report.create({
      data: {
        applicationId: application.id,
        reportNumber: `TRV-203406-FW1-${RUN_ID}`,
        numberPrefix: "TRV",
        numberPeriod: "203406",
        sequence: 9101,
        storageKey: `rpt/${RUN_ID}-fw1/pdf`,
        fileName: "fw1-fixture.pdf",
        byteSize: 1024,
        contentHash: "1".repeat(64),
        generatedById: reportOwnerId,
      },
    });

    // 真實 productionHistoryChecker（不注入 stub，`buildServer` 走預設值）。
    app = await buildServer({ databaseUrl: scratchUrl, logLevel: "error" });
    await app.ready();
  });

  afterAll(async () => {
    if (!DB_URL) return;
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
    await dropSchema(admin, schema);
    await admin.$disconnect();
  });

  it("§8.3: Report 唯一的 FK 指向 Application，沒有指向 User 的 FK", async () => {
    const fkRows = await prisma.$queryRawUnsafe<Array<{ confrelid_name: string }>>(
      `SELECT rel.relname AS confrelid_name
         FROM pg_constraint c
         JOIN pg_class t ON c.conrelid = t.oid
         JOIN pg_namespace n ON t.relnamespace = n.oid
         JOIN pg_class rel ON c.confrelid = rel.oid
        WHERE n.nspname = current_schema() AND t.relname = 'Report' AND c.contype = 'f'`
    );
    expect(fkRows.map((r) => r.confrelid_name)).toEqual(["Application"]);
  });

  it("§8.3 契約面: DELETE /admin/users/:id — 使用者的申請已產生 Report 時，刪除仍為 409 CONFLICT（真實 productionHistoryChecker，非 stub）", async () => {
    const cookie = await loginAndGetCookie(ADMIN_LOGIN);
    const resp = await app.inject({
      method: "DELETE",
      url: `/admin/users/${reportOwnerId}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(409);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe("CONFLICT");

    // 使用者必須仍然存在——刪除未部分成功。
    const stillThere = await prisma.user.findUnique({ where: { id: reportOwnerId } });
    expect(stillThere).not.toBeNull();
  });

  it("§8.3 契約面 control: 沒有任何申請／報表的使用者可正常刪除（200），證明上一則斷言具鑑別力（並非路由對這兩個使用者恆回 409）", async () => {
    const cookie = await loginAndGetCookie(ADMIN_LOGIN);
    const resp = await app.inject({
      method: "DELETE",
      url: `/admin/users/${cleanUserId}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);

    const stillThere = await prisma.user.findUnique({ where: { id: cleanUserId } });
    expect(stillThere).toBeNull();
  });

  it("§8.3: backend/src/users/history.ts 為零 diff（Spec §8.3 明文宣告本 Phase 對此檔零變更）——內容 SHA-256 固定值比對", () => {
    const content = fs.readFileSync(HISTORY_TS_PATH, "utf8");
    const actualHash = crypto.createHash("sha256").update(content).digest("hex");
    expect(
      actualHash,
      "backend/src/users/history.ts 內容已變更——Spec §8.3 明文宣告本 Phase 對此檔零變更"
    ).toBe(HISTORY_TS_EXPECTED_SHA256);
  });

  it("§8.3 mutant 自證: SHA-256 零 diff 比對對內容變動有鑑別力（任一位元組改動即變紅；未變動內容維持綠燈）", () => {
    const realContent = fs.readFileSync(HISTORY_TS_PATH, "utf8");
    const realHash = crypto.createHash("sha256").update(realContent).digest("hex");
    expect(realHash).toBe(HISTORY_TS_EXPECTED_SHA256); // control — 真實內容本身即比對相符。

    const mutatedHash = crypto
      .createHash("sha256")
      .update(`${realContent}\n// mutant: a single appended comment line\n`)
      .digest("hex");
    expect(mutatedHash).not.toBe(HISTORY_TS_EXPECTED_SHA256);
  });
});
