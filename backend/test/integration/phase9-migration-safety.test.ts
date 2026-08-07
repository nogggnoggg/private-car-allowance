/**
 * Integration tests for PHASE-009-T1 — `Application` 四個新欄 ＋（條件）
 * `VoidedReportFile` 表 ＋ `AuditAction` 新值 ＋ migration ＋ 安全網。
 *
 * TDD: written against a schema/migration state that did not yet exist
 * (schema.prisma had no `voidReason`/`voidedAt`/`voidedById`/`supersedesId`
 * on `Application`, no `VoidedReportFile` model, `AuditAction` lacked
 * `APPLICATION_VOIDED`, and neither
 * `20260807140000_phase9_void_revision_model` nor
 * `20260807140100_phase9_audit_action_voided` existed on disk). Redness
 * verified mechanically: `git stash` on `backend/prisma/schema.prisma`
 * (reverting to the PHASE-008 shape) plus temporarily moving both new
 * migration directories out of `prisma/migrations/`, regenerating the
 * Prisma Client against that reverted schema, and re-running this file —
 * every `it` in both `describe` blocks went red for one of three reasons:
 * `tsc`/runtime `Cannot read properties of undefined (reading 'create')`
 * (`client.voidedReportFile` / `application.supersedesId` absent from a
 * client generated without them), `relation "VoidedReportFile" does not
 * exist` (raw SQL against a not-yet-created table), or `ENOENT` (the two
 * migration directories this file reads did not exist). Reverted
 * afterwards via `git stash pop` and directory restore, matching the
 * PHASE-006/007/008-T1 "TDD safety net" precedent this file follows
 * structurally. See Task Handoff for the exact stash/restore transcript.
 *
 * Covers Spec docs/specs/PHASE-009.md §8（資料模型與 migration）and §15 Task
 * T1's Done When, i.e. AC-01(a)~(h):
 *   (a) Application 四個新欄之型別／可空性／無 default 逐欄符合 §8.1；
 *       `supersedesId` 之 @unique 與 FK(onDelete: Restrict)。
 *   (b) VoidedReportFile 表之欄位集合、兩個唯一約束（reportId／storageKey）
 *       與 FK(onDelete: Restrict) 逐欄符合 §8.2；migration SQL 除 Application／
 *       VoidedReportFile 外零 ALTER、零 DROP／INSERT／UPDATE。
 *   (c) 除 Application 外既有表逐欄零改寫（九表突變自證，沿 PHASE-008-T1
 *       慣例）；Application 十個原欄逐欄零改寫、四個新欄恆為 NULL（零回填）。
 *   (d) 乾淨與既有 DB 各一輪 migrate deploy 成功且冪等。
 *   (e) AuditAction 恰新增 APPLICATION_VOIDED，其餘九值聯集全等；
 *       ALTER TYPE 新值於獨立交易後方可使用（raw SQL 自證）。
 *   (f) 表數 16→17；機械連動實查（六處表數／四處 AuditAction 聯集基線／一處
 *       Application 欄位集合基線）與 Handoff 回報值相符。
 *   (g) drift guard（既有 `infra002-schema-drift.test.ts`，零改動）。
 *   (h) supersededBy／voidedFile 為零 DDL 之虛擬反向關聯欄（Application／
 *       Report 欄位集合僅各增所宣告之實體欄位）。
 *
 * FW-8/FW-9 確認（Spec §8.5）：本 Phase migration 非純 CREATE——`Application`
 * ALTER 型（本專案首度對既有表 ALTER）＋ `AuditAction` ALTER TYPE。故：
 *   - 既有 DB 之 baseline fixture 中，凡寫入 `Application` 列一律使用 raw SQL
 *     （`$executeRaw`），因為現行（含本 Phase）schema 產生的型別化 Client 在
 *     `create()` 的 RETURNING 子句會嘗試選取尚未存在於 baseline DB 的四個新
 *     欄，導致 `column does not exist`（沿 PHASE-007-R1 M2 段既有手法）。
 *   - 其餘九表（本 Phase 零 ALTER）沿用一般型別化 Client 寫入即安全（沿
 *     PHASE-007-R1／PHASE-008-T1 慣例）。
 *   - migration 後讀取 `Application` 改用**新連線**（`clientAfter`），迴避
 *     Postgres `0A000: cached plan must not change result type`（沿
 *     PHASE-007-R1 M2 段已驗證之陷阱）。
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
 * (branch phase-009, base commit acb00bb) — i.e. the full PHASE-008 state.
 * Used to reconstruct an "existing DB, pre-PHASE-009" scratch schema.
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
  "20260806090000_phase8_report_model",
];

/** The two migration directories this Task adds (AC-01, §8.5). */
const NEW_MIGRATION_DIR_TABLE = "20260807140000_phase9_void_revision_model";
const NEW_MIGRATION_DIR_ENUM = "20260807140100_phase9_audit_action_voided";

/** Application 之四個新欄（§8.1）——ALTER 型比較器之 `addedColumns` 參數。 */
const ADDED_APPLICATION_COLUMNS = ["voidReason", "voidedAt", "voidedById", "supersedesId"] as const;

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

function runMigrateDiff(
  shadowDatabaseUrl: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        PRISMA_CLI_ENTRY,
        "migrate",
        "diff",
        "--from-migrations",
        path.join("prisma", "migrations"),
        "--to-schema-datamodel",
        path.join("prisma", "schema.prisma"),
        "--shadow-database-url",
        shadowDatabaseUrl,
        "--exit-code",
      ],
      { cwd: BACKEND_ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Builds a temp directory containing a copy of the real schema.prisma plus
 * ONLY the pre-PHASE-009 migration directories, so `prisma migrate deploy`
 * against it reproduces "an existing DB that has PHASE-008 applied but not
 * yet PHASE-009" — without touching the real `prisma/migrations/` directory.
 */
function buildBaselineMigrationsFixture(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase9-t1-baseline-"));
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

/** Zero-rewrite comparator for tables this Task's migration does NOT touch. */
function assertRowUnchanged(
  label: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): void {
  expect(Object.keys(after).sort(), `${label}: column set changed across migration`).toEqual(
    Object.keys(before).sort()
  );
  for (const [key, value] of Object.entries(before)) {
    expect(after[key], `${label}: column "${key}" changed across migration`).toEqual(value);
  }
}

/**
 * ALTER 型 migration 專用比較器（沿 PHASE-007-R1 M2 段先例）：既有列之**原有
 * 欄位逐欄零改寫**，且新增欄位之集合**恰為** `addedColumns`（多一個 `ADD
 * COLUMN` 必紅）、其值於既有列**一律 `NULL`**（零回填）。
 */
function assertRowUnchangedWithAddedColumns(
  label: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  addedColumns: readonly string[]
): void {
  expect(
    Object.keys(after).sort(),
    `${label}: column set is not exactly (before ∪ addedColumns)`
  ).toEqual([...Object.keys(before), ...addedColumns].sort());
  for (const col of addedColumns) {
    expect(
      after[col],
      `${label}: newly added column "${col}" must be NULL on pre-existing rows (零回填)`
    ).toBeNull();
  }
  for (const [key, value] of Object.entries(before)) {
    expect(after[key], `${label}: column "${key}" changed across migration`).toEqual(value);
  }
}

async function dropSchema(admin: PrismaClient, schema: string): Promise<void> {
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

/**
 * 純函式：在一段 SQL 文字中統計語句數（先去除 `-- ...` 行註解，再以 `;` 切割、
 * 濾除空白片段）。沿 PHASE-008-T1 即審 AR-1 先例——逐項關鍵字比對之最後防線。
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
// AC-01(c)/(d): existing-DB incremental migration safety net — nine
// representative tables spanning every model family get a plain zero-rewrite
// check; `Application` (this Task's ALTER target) gets the ALTER-aware
// "old columns unchanged + new columns NULL" check.
// ===========================================================================

describeWithDb("PHASE-009-T1 migration safety net — existing DB", () => {
  const schema = `phase9_t1_existing_${RUN_ID}`;
  let existingUrl: string;
  let admin: PrismaClient;
  let baselineDir: string;
  /** 連線 A：migration **之前**的應用程式行程（播種與 before 快照）。 */
  let client: PrismaClient;
  /**
   * 連線 B：migration **之後**的應用程式行程。`Application` 之 `ADD COLUMN`
   * 後，沿用 migration 前那條連線重跑同一句 `SELECT *` 會撞
   * `0A000: cached plan must not change result type`（沿 PHASE-007-R1 M2
   * 段已驗證之陷阱——本 Phase 是繼該段之後第二個 ALTER 既有表的 Task）。
   */
  let clientAfter: PrismaClient;

  function db(): PrismaClient {
    return clientAfter ?? client;
  }

  async function selectOne(sql: string, ...params: unknown[]): Promise<Record<string, unknown>> {
    const rows = await db().$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);
    expect(rows).toHaveLength(1);
    return canonicalizeRow(rows[0]);
  }

  const OWNER_ID = `p9_t1_owner_${RUN_ID}`;
  const LOGIN_NAME = `p9_t1_owner_${RUN_ID}`;
  const TRAVEL_APPLICATION_ID = `p9_t1_app_travel_${RUN_ID}`;
  const MAINTENANCE_APPLICATION_ID = `p9_t1_app_maint_${RUN_ID}`;
  const DEPRECIATION_APPLICATION_ID = `p9_t1_app_dep_${RUN_ID}`;
  const TRIP_SEGMENT_ID = `p9_t1_seg_${RUN_ID}`;
  const FUEL_VERSION_ID = `p9_t1_fuel_ver_${RUN_ID}`;
  const CONSUMPTION_VERSION_ID = `p9_t1_consumption_ver_${RUN_ID}`;
  const ATTACHMENT_ID = `p9_t1_attachment_${RUN_ID}`;
  const REPORT_ID = `p9_t1_report_${RUN_ID}`;
  const TRIP_DATE = new Date("2035-05-01T00:00:00.000Z");

  /** Before-migration snapshots — nine untouched tables (plain closed-set). */
  let beforeUserRow: Record<string, unknown>;
  let beforeTravelRow: Record<string, unknown>;
  let beforeSegmentRow: Record<string, unknown>;
  let beforeMaintenanceRow: Record<string, unknown>;
  let beforeDepreciationRow: Record<string, unknown>;
  let beforeFuelVersionRow: Record<string, unknown>;
  let beforeConsumptionVersionRow: Record<string, unknown>;
  let beforeAttachmentRow: Record<string, unknown>;
  let beforeReportRow: Record<string, unknown>;

  /** Before-migration snapshots — `Application` (this Task's ALTER target). */
  let beforeTravelAppRow: Record<string, unknown>;
  let beforeMaintenanceAppRow: Record<string, unknown>;
  let beforeDepreciationAppRow: Record<string, unknown>;

  beforeAll(async () => {
    if (!DB_URL) return;
    admin = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await admin.$connect();
    await dropSchema(admin, schema);

    existingUrl = withSchema(DB_URL, schema);

    // Step 1: reconstruct "existing DB, pre-PHASE-009" by deploying only the
    // baseline (PHASE-008-and-earlier) migrations onto a brand-new schema.
    baselineDir = buildBaselineMigrationsFixture();
    await runMigrateDeploy(path.join(baselineDir, "schema.prisma"), existingUrl);

    client = new PrismaClient({ datasources: { db: { url: existingUrl } } });

    await client.user.create({
      data: {
        id: OWNER_ID,
        loginName: LOGIN_NAME,
        displayName: "Phase9 T1 Owner (Fixture)",
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

    // ── Application rows — FW-8/9: raw SQL (this Task's ALTER target;
    // the current-schema-generated typed Client would try to RETURNING the
    // four new columns, which don't exist yet on this baseline DB) ──
    const now = new Date();
    await client.$executeRaw`
      INSERT INTO "Application"
        (id, type, status, "ownerId", "createdById", "primaryDate", "totalAmount",
         "completedAt", "createdAt", "updatedAt")
      VALUES
        (${TRAVEL_APPLICATION_ID}, 'TRAVEL'::"ApplicationType", 'COMPLETED'::"ApplicationStatus",
         ${OWNER_ID}, ${OWNER_ID}, ${TRIP_DATE}, 1234, ${now}, ${now}, ${now})
    `;
    await client.$executeRaw`
      INSERT INTO "Application"
        (id, type, status, "ownerId", "createdById", "primaryDate", "totalAmount",
         "completedAt", "createdAt", "updatedAt")
      VALUES
        (${MAINTENANCE_APPLICATION_ID}, 'MAINTENANCE'::"ApplicationType", 'COMPLETED'::"ApplicationStatus",
         ${OWNER_ID}, ${OWNER_ID}, ${TRIP_DATE}, 4321, ${now}, ${now}, ${now})
    `;
    await client.$executeRaw`
      INSERT INTO "Application"
        (id, type, status, "ownerId", "createdById", "primaryDate", "totalAmount",
         "completedAt", "createdAt", "updatedAt")
      VALUES
        (${DEPRECIATION_APPLICATION_ID}, 'DEPRECIATION'::"ApplicationType", 'COMPLETED'::"ApplicationStatus",
         ${OWNER_ID}, ${OWNER_ID}, ${TRIP_DATE}, 5678, ${now}, ${now}, ${now})
    `;

    // ── The other nine tables — none touched by this Task's migration, so
    // the ordinary typed Client (current schema) is safe (沿 PHASE-007-R1/
    // PHASE-008-T1 慣例). ──
    await client.travelApplication.create({
      data: {
        applicationId: TRAVEL_APPLICATION_ID,
        tripDate: TRIP_DATE,
        purpose: "Pre-Phase-009 synthetic business trip",
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
    await client.maintenanceApplication.create({
      data: {
        applicationId: MAINTENANCE_APPLICATION_ID,
        lastMaintenanceDate: new Date("2035-01-10T00:00:00.000Z"),
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
    await client.depreciationApplication.create({
      data: {
        applicationId: DEPRECIATION_APPLICATION_ID,
        applicationYear: 2035,
        annualTotalKm: new Prisma.Decimal("20000.0"),
        snapshotVehiclePrice: new Prisma.Decimal("600000.00"),
        snapshotUsefulLifeYears: 5,
        snapshotAnnualDepreciation: new Prisma.Decimal("120000.00"),
        snapshotOfficialKm: new Prisma.Decimal("10000.00"),
        snapshotAnnualTotalKm: new Prisma.Decimal("20000.0"),
        snapshotRatio: new Prisma.Decimal("0.500000"),
        snapshotRawAmount: new Prisma.Decimal("60000.0000"),
        calculatedAt: new Date(),
        depreciationParameterVersionId: `p9_t1_dep_ver_${RUN_ID}`,
      },
    });
    await client.attachment.create({
      data: {
        id: ATTACHMENT_ID,
        status: "LINKED",
        storageKey: `p9_t1_storage_${RUN_ID}`,
        thumbnailKey: `p9_t1_thumb_${RUN_ID}`,
        mimeType: "image/jpeg",
        byteSize: 123456,
        originalFilename: "phase9-t1-fixture.jpg",
        uploaderId: OWNER_ID,
        ownerId: OWNER_ID,
        refType: "TRIP_SEGMENT",
        refId: TRIP_SEGMENT_ID,
        linkedAt: new Date(),
      },
    });
    await client.report.create({
      data: {
        id: REPORT_ID,
        applicationId: TRAVEL_APPLICATION_ID,
        reportNumber: `TRV-203505-P9T1-${RUN_ID}`,
        numberPrefix: "TRV",
        numberPeriod: "203505",
        sequence: 9101,
        storageKey: `rpt/${RUN_ID}/pdf`,
        fileName: "phase9-t1-fixture-report.pdf",
        byteSize: 204800,
        contentHash: "1".repeat(64),
        generatedById: OWNER_ID,
      },
    });

    // Step 2: capture "before" snapshots (raw `SELECT *` so the full physical
    // column set — not just the typed Client's view of it — is compared).
    beforeUserRow = await selectOne(`SELECT * FROM "User" WHERE id = $1`, OWNER_ID);
    beforeTravelAppRow = await selectOne(
      `SELECT * FROM "Application" WHERE id = $1`,
      TRAVEL_APPLICATION_ID
    );
    beforeTravelRow = await selectOne(
      `SELECT * FROM "TravelApplication" WHERE "applicationId" = $1`,
      TRAVEL_APPLICATION_ID
    );
    beforeSegmentRow = await selectOne(
      `SELECT * FROM "TripSegment" WHERE id = $1`,
      TRIP_SEGMENT_ID
    );
    beforeMaintenanceAppRow = await selectOne(
      `SELECT * FROM "Application" WHERE id = $1`,
      MAINTENANCE_APPLICATION_ID
    );
    beforeMaintenanceRow = await selectOne(
      `SELECT * FROM "MaintenanceApplication" WHERE "applicationId" = $1`,
      MAINTENANCE_APPLICATION_ID
    );
    beforeDepreciationAppRow = await selectOne(
      `SELECT * FROM "Application" WHERE id = $1`,
      DEPRECIATION_APPLICATION_ID
    );
    beforeDepreciationRow = await selectOne(
      `SELECT * FROM "DepreciationApplication" WHERE "applicationId" = $1`,
      DEPRECIATION_APPLICATION_ID
    );
    beforeFuelVersionRow = await selectOne(
      `SELECT * FROM "FuelPriceVersion" WHERE id = $1`,
      FUEL_VERSION_ID
    );
    beforeConsumptionVersionRow = await selectOne(
      `SELECT * FROM "UserFuelConsumptionVersion" WHERE id = $1`,
      CONSUMPTION_VERSION_ID
    );
    beforeAttachmentRow = await selectOne(
      `SELECT * FROM "Attachment" WHERE id = $1`,
      ATTACHMENT_ID
    );
    beforeReportRow = await selectOne(`SELECT * FROM "Report" WHERE id = $1`, REPORT_ID);

    // Sanity: the fixture really is "pre-Phase-009 shaped" — Application has
    // exactly the ten baseline columns, no void/revision columns yet exist.
    expect(Object.keys(beforeTravelAppRow).sort()).toEqual(
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

    // Step 3: apply the REST of this Phase's migrations (real schema + real
    // migrations dir, i.e. the two new PHASE-009 migrations) on top of the
    // same schema — the actual "existing DB gets upgraded" path.
    await runMigrateDeploy(REAL_SCHEMA_PATH, existingUrl);
    clientAfter = new PrismaClient({ datasources: { db: { url: existingUrl } } });
  });

  afterAll(async () => {
    if (!DB_URL) return;
    if (client) await client.$disconnect();
    if (clientAfter) await clientAfter.$disconnect();
    await dropSchema(admin, schema);
    await admin.$disconnect();
    if (baselineDir) fs.rmSync(baselineDir, { recursive: true, force: true });
  });

  it("AC-01(d): prisma migrate deploy succeeds incrementally against an existing (pre-Phase) DB; before snapshots complete", () => {
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
    expect(beforeReportRow).toBeDefined();
  });

  it("AC-01(c) 九表零改寫: every pre-existing column, across nine representative tables this migration does NOT touch, is byte-for-byte unchanged", async () => {
    const checks: Array<[string, string, Record<string, unknown>, unknown]> = [
      ["User", `SELECT * FROM "User" WHERE id = $1`, beforeUserRow, OWNER_ID],
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
        "MaintenanceApplication",
        `SELECT * FROM "MaintenanceApplication" WHERE "applicationId" = $1`,
        beforeMaintenanceRow,
        MAINTENANCE_APPLICATION_ID,
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
      ["Report", `SELECT * FROM "Report" WHERE id = $1`, beforeReportRow, REPORT_ID],
    ];

    for (const [label, sql, before, id] of checks) {
      const rows = await db().$queryRawUnsafe<Record<string, unknown>[]>(sql, id);
      expect(rows, label).toHaveLength(1);
      assertRowUnchanged(label, before, canonicalizeRow(rows[0]));
    }
  });

  it("AC-01(c) 突變自證: the nine-table zero-rewrite comparator is discriminating — a rewritten value, and an ADDed column, each make it red", () => {
    const rewritten = { ...beforeTravelRow, snapshotTotalKm: "999.99" };
    expect(() => assertRowUnchanged("mutant/rewrite", beforeTravelRow, rewritten)).toThrow();

    const addedColumn = { ...beforeAttachmentRow, someNewColumn: null };
    expect(() =>
      assertRowUnchanged("mutant/add-column", beforeAttachmentRow, addedColumn)
    ).toThrow();

    expect(() =>
      assertRowUnchanged("control", beforeAttachmentRow, { ...beforeAttachmentRow })
    ).not.toThrow();
  });

  it("AC-01(c): Application 既有列 — 原 10 欄逐欄零改寫，新增 4 欄一律 NULL（零回填；多餘 ADD COLUMN 必紅）", async () => {
    assertRowUnchangedWithAddedColumns(
      "Application/travel",
      beforeTravelAppRow,
      await selectOne(`SELECT * FROM "Application" WHERE id = $1`, TRAVEL_APPLICATION_ID),
      ADDED_APPLICATION_COLUMNS
    );
    assertRowUnchangedWithAddedColumns(
      "Application/maintenance",
      beforeMaintenanceAppRow,
      await selectOne(`SELECT * FROM "Application" WHERE id = $1`, MAINTENANCE_APPLICATION_ID),
      ADDED_APPLICATION_COLUMNS
    );
    assertRowUnchangedWithAddedColumns(
      "Application/depreciation",
      beforeDepreciationAppRow,
      await selectOne(`SELECT * FROM "Application" WHERE id = $1`, DEPRECIATION_APPLICATION_ID),
      ADDED_APPLICATION_COLUMNS
    );
  });

  it("AC-01(c) 突變自證: ALTER 型比較器具鑑別力 — 多一個 ADD COLUMN／新欄被回填／既有值被改寫／ADD COLUMN 遺漏，各自必紅", () => {
    const after = {
      ...beforeTravelAppRow,
      voidReason: null,
      voidedAt: null,
      voidedById: null,
      supersedesId: null,
    };

    expect(() =>
      assertRowUnchangedWithAddedColumns(
        "control",
        beforeTravelAppRow,
        after,
        ADDED_APPLICATION_COLUMNS
      )
    ).not.toThrow();

    expect(() =>
      assertRowUnchangedWithAddedColumns(
        "mutant/extra-add-column",
        beforeTravelAppRow,
        { ...after, somethingElse: null },
        ADDED_APPLICATION_COLUMNS
      )
    ).toThrow();

    expect(() =>
      assertRowUnchangedWithAddedColumns(
        "mutant/backfilled",
        beforeTravelAppRow,
        { ...after, voidReason: "backfilled reason" },
        ADDED_APPLICATION_COLUMNS
      )
    ).toThrow();

    expect(() =>
      assertRowUnchangedWithAddedColumns(
        "mutant/rewrite",
        beforeTravelAppRow,
        { ...after, totalAmount: 999999 },
        ADDED_APPLICATION_COLUMNS
      )
    ).toThrow();

    const { supersedesId: _omittedOnPurpose, ...missing } = after;
    expect(() =>
      assertRowUnchangedWithAddedColumns(
        "mutant/missing-add-column",
        beforeTravelAppRow,
        missing,
        ADDED_APPLICATION_COLUMNS
      )
    ).toThrow();
  });

  it("AC-01(b): the new VoidedReportFile table exists and is empty (零回填) after migrating an existing DB", async () => {
    const rows = await db().$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "VoidedReportFile"`
    );
    expect(Number(rows[0]?.count ?? -1)).toBe(0);
  });

  it("AC-01(e): AuditAction 於既有 DB 升級後含 APPLICATION_VOIDED（且僅新增此一值）", async () => {
    const rows = await db().$queryRawUnsafe<Array<{ enumlabel: string }>>(
      `SELECT e.enumlabel FROM pg_enum e
       JOIN pg_type t ON e.enumtypid = t.oid
       JOIN pg_namespace n ON t.typnamespace = n.oid
       WHERE t.typname = 'AuditAction' AND n.nspname = '${schema}'
       ORDER BY e.enumlabel`
    );
    expect(rows.map((r) => r.enumlabel).sort()).toEqual(
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
        "APPLICATION_VOIDED",
      ].sort()
    );
  });

  it("AC-01(d): re-running migrate deploy against the already-upgraded existing DB is idempotent (no-op, still succeeds)", async () => {
    await runMigrateDeploy(REAL_SCHEMA_PATH, existingUrl);

    const migrationRows = await db().$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`
    );
    expect(Number(migrationRows[0]?.count ?? -1)).toBe(countMigrationDirs());

    const rows = await db().$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "VoidedReportFile"`
    );
    expect(Number(rows[0]?.count ?? -1)).toBe(0);

    assertRowUnchangedWithAddedColumns(
      "Application/idempotent",
      beforeTravelAppRow,
      await selectOne(`SELECT * FROM "Application" WHERE id = $1`, TRAVEL_APPLICATION_ID),
      ADDED_APPLICATION_COLUMNS
    );
    assertRowUnchanged(
      "Attachment/idempotent",
      beforeAttachmentRow,
      await selectOne(`SELECT * FROM "Attachment" WHERE id = $1`, ATTACHMENT_ID)
    );
  });
});

// ===========================================================================
// AC-01(a)/(b)/(e)/(f)/(h): clean DB — new/altered shape, constraints, FKs,
// enum union baseline, zero-ALTER static check, table-count, virtual
// relations, ALTER TYPE transaction-boundary self-proof.
// ===========================================================================

describeWithDb("PHASE-009-T1 migration safety net — clean DB", () => {
  const schema = `phase9_t1_clean_${RUN_ID}`;
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

  it("AC-01(d): prisma migrate deploy succeeds end-to-end against a brand-new empty DB, and is idempotent on re-run", async () => {
    const migrationRows = await client.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
    >(`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`);
    expect(migrationRows).toHaveLength(countMigrationDirs());
    for (const row of migrationRows) {
      expect(row.finished_at).not.toBeNull();
      expect(row.rolled_back_at).toBeNull();
    }
    expect(migrationRows.map((r) => r.migration_name)).toContain(NEW_MIGRATION_DIR_TABLE);
    expect(migrationRows.map((r) => r.migration_name)).toContain(NEW_MIGRATION_DIR_ENUM);

    await expect(client.voidedReportFile.count()).resolves.toBe(0);

    await runMigrateDeploy(REAL_SCHEMA_PATH, cleanUrl);
    const afterRows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "_prisma_migrations"`
    );
    expect(Number(afterRows[0]?.count ?? -1)).toBe(countMigrationDirs());
  });

  it("AC-01(f) 表數 16→17 — VoidedReportFile is the 17th business table", async () => {
    const tableRows = await client.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`
    );
    expect(tableRows.length).toBe(17);
    expect(tableRows.map((r) => r.table_name)).toContain("VoidedReportFile");
  });

  it("AC-01(a): Application 之四個新欄 — 型別／可空性／無 default 逐欄符合 §8.1（14 欄封閉集合）", async () => {
    const columnRows = await client.$queryRawUnsafe<
      Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
        datetime_precision: number | null;
      }>
    >(
      `SELECT column_name, data_type, is_nullable, column_default, datetime_precision
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'Application'`
    );
    const byName = Object.fromEntries(columnRows.map((r) => [r.column_name, r]));

    // Closed-set (AC-01(h) 併記): the column set itself is asserted — PHASE-008
    // baseline's ten columns plus exactly the four new ones (supersededBy 之
    // 反向關聯零 DDL，故不在此集合內)。
    expect(Object.keys(byName).sort()).toEqual(
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
        "voidReason",
        "voidedAt",
        "voidedById",
        "supersedesId",
      ].sort()
    );

    for (const col of ["voidReason", "voidedById", "supersedesId"] as const) {
      expect(byName[col].data_type, `${col}: data_type`).toBe("text");
      expect(byName[col].is_nullable, `${col}: is_nullable`).toBe("YES");
      expect(byName[col].column_default, `${col}: column_default`).toBeNull();
    }
    expect(byName.voidedAt.data_type).toBe("timestamp without time zone");
    expect(byName.voidedAt.is_nullable).toBe("YES");
    expect(byName.voidedAt.column_default).toBeNull();
    expect(byName.voidedAt.datetime_precision).toBe(3);
  });

  it("AC-01(a): Application.supersedesId — 唯一約束 ＋ FK(onDelete: Restrict) 指向 Application(id)", async () => {
    const indexRows = await client.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'Application'`
    );
    expect(indexRows.map((r) => r.indexname)).toContain("Application_supersedesId_key");

    const fkRows = await client.$queryRawUnsafe<
      Array<{ conname: string; confdeltype: string; confrelid_name: string }>
    >(
      `SELECT c.conname, c.confdeltype::text AS confdeltype, ref.relname AS confrelid_name
         FROM pg_constraint c
         JOIN pg_class t ON c.conrelid = t.oid
         JOIN pg_class ref ON c.confrelid = ref.oid
         JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE n.nspname = current_schema() AND t.relname = 'Application' AND c.contype = 'f'
          AND c.conname = 'Application_supersedesId_fkey'`
    );
    expect(fkRows).toHaveLength(1);
    expect(fkRows[0].confdeltype).toBe("r"); // ON DELETE RESTRICT
    expect(fkRows[0].confrelid_name).toBe("Application"); // self-referential
  });

  it("AC-01(b): VoidedReportFile 之欄位集合／型別／可空性逐欄符合 §8.2（8 欄，全數 NOT NULL）", async () => {
    const columnRows = await client.$queryRawUnsafe<
      Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        numeric_precision: number | null;
      }>
    >(
      `SELECT column_name, data_type, is_nullable, numeric_precision
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'VoidedReportFile'`
    );
    const byName = Object.fromEntries(columnRows.map((r) => [r.column_name, r]));

    expect(Object.keys(byName).sort()).toEqual(
      [
        "id",
        "reportId",
        "storageKey",
        "fileName",
        "byteSize",
        "contentHash",
        "createdById",
        "createdAt",
      ].sort()
    );
    for (const col of Object.keys(byName)) {
      expect(byName[col].is_nullable, `column ${col} must be NOT NULL`).toBe("NO");
    }
    for (const col of [
      "id",
      "reportId",
      "storageKey",
      "fileName",
      "contentHash",
      "createdById",
    ] as const) {
      expect(byName[col].data_type, `${col}: data_type`).toBe("text");
    }
    expect(byName.byteSize.data_type).toBe("integer");
    expect(byName.createdAt.data_type).toBe("timestamp without time zone");
  });

  it("AC-01(b): VoidedReportFile 之 PK、兩個唯一約束（reportId／storageKey）、FK(onDelete: Restrict) → Report(id)", async () => {
    const constraintRows = await client.$queryRawUnsafe<
      Array<{ conname: string; contype: string; confdeltype: string | null }>
    >(
      `SELECT c.conname, c.contype::text AS contype, c.confdeltype::text AS confdeltype
         FROM pg_constraint c
         JOIN pg_class t ON c.conrelid = t.oid
         JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE n.nspname = current_schema() AND t.relname = 'VoidedReportFile'`
    );
    expect(constraintRows.some((r) => r.contype === "p")).toBe(true);
    const fk = constraintRows.find((r) => r.contype === "f");
    expect(fk).toBeDefined();
    expect(fk?.confdeltype).toBe("r");

    const indexRows = await client.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'VoidedReportFile'`
    );
    const indexNames = indexRows.map((r) => r.indexname);
    expect(indexNames).toContain("VoidedReportFile_reportId_key");
    expect(indexNames).toContain("VoidedReportFile_storageKey_key");

    const nonPkIndexRows = indexRows.filter((r) => r.indexname !== "VoidedReportFile_pkey");
    const uniqueCount = nonPkIndexRows.filter((r) =>
      r.indexdef.includes("CREATE UNIQUE INDEX")
    ).length;
    expect(uniqueCount).toBe(2);
  });

  it("AC-01(a)/(b): 三個新唯一約束各自獨立拒絕碰撞（Application.supersedesId／VoidedReportFile.reportId／VoidedReportFile.storageKey）", async () => {
    async function makeCompletedOwner(suffix: string) {
      return client.user.create({
        data: {
          loginName: `p9_t1_uniq_${suffix}_${RUN_ID}`,
          displayName: `Phase9 T1 Unique Owner ${suffix} (Fixture)`,
          passwordHash: "not-a-real-hash-synthetic-fixture",
          role: "USER",
          isActive: true,
          mustChangePassword: false,
        },
      });
    }
    async function makeCompletedApp(ownerId: string, primaryDate: Date) {
      return client.application.create({
        data: {
          type: "TRAVEL",
          status: "COMPLETED",
          ownerId,
          createdById: ownerId,
          primaryDate,
          totalAmount: 1,
          completedAt: new Date(),
        },
      });
    }
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

    // (1) Application.supersedesId collision — two DRAFT revisions pointing
    // at the same original.
    const owner1 = await makeCompletedOwner("app");
    const original = await makeCompletedApp(owner1.id, new Date("2035-06-01T00:00:00.000Z"));
    await client.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: owner1.id,
        createdById: owner1.id,
        primaryDate: new Date("2035-06-02T00:00:00.000Z"),
        supersedesId: original.id,
      },
    });
    await expectUniqueViolation(() =>
      client.application.create({
        data: {
          type: "TRAVEL",
          status: "DRAFT",
          ownerId: owner1.id,
          createdById: owner1.id,
          primaryDate: new Date("2035-06-03T00:00:00.000Z"),
          supersedesId: original.id,
        },
      })
    );

    // (2) VoidedReportFile.reportId / storageKey collisions.
    const owner2 = await makeCompletedOwner("vrf");
    const app2 = await makeCompletedApp(owner2.id, new Date("2035-06-04T00:00:00.000Z"));
    const report2 = await client.report.create({
      data: {
        applicationId: app2.id,
        reportNumber: `TRV-203506-P9UNIQ-${RUN_ID}`,
        numberPrefix: "TRV",
        numberPeriod: "203506",
        sequence: 9201,
        storageKey: `rpt/${RUN_ID}-uniq/pdf`,
        fileName: "unique-fixture.pdf",
        byteSize: 1024,
        contentHash: "2".repeat(64),
        generatedById: owner2.id,
      },
    });
    await client.voidedReportFile.create({
      data: {
        reportId: report2.id,
        storageKey: `rpt/${RUN_ID}-uniq/void.pdf`,
        fileName: "unique-fixture.pdf",
        byteSize: 512,
        contentHash: "3".repeat(64),
        createdById: owner2.id,
      },
    });

    // reportId collision — same reportId, different storageKey.
    await expectUniqueViolation(() =>
      client.voidedReportFile.create({
        data: {
          reportId: report2.id,
          storageKey: `rpt/${RUN_ID}-uniq2/void.pdf`,
          fileName: "unique-fixture.pdf",
          byteSize: 512,
          contentHash: "4".repeat(64),
          createdById: owner2.id,
        },
      })
    );

    // storageKey collision — different report, same storageKey.
    const app3 = await makeCompletedApp(owner2.id, new Date("2035-06-05T00:00:00.000Z"));
    const report3 = await client.report.create({
      data: {
        applicationId: app3.id,
        reportNumber: `TRV-203506-P9UNIQ2-${RUN_ID}`,
        numberPrefix: "TRV",
        numberPeriod: "203506",
        sequence: 9202,
        storageKey: `rpt/${RUN_ID}-uniq3/pdf`,
        fileName: "unique-fixture-2.pdf",
        byteSize: 1024,
        contentHash: "5".repeat(64),
        generatedById: owner2.id,
      },
    });
    await expectUniqueViolation(() =>
      client.voidedReportFile.create({
        data: {
          reportId: report3.id,
          storageKey: `rpt/${RUN_ID}-uniq/void.pdf`, // same as report2's
          fileName: "unique-fixture-2.pdf",
          byteSize: 512,
          contentHash: "6".repeat(64),
          createdById: owner2.id,
        },
      })
    );
  });

  it("AC-01(a): FK onDelete Restrict — deleting an Application referenced by another's supersedesId is rejected", async () => {
    const owner = await client.user.create({
      data: {
        loginName: `p9_t1_restrict_app_${RUN_ID}`,
        displayName: "Phase9 T1 Restrict App Owner (Fixture)",
        passwordHash: "not-a-real-hash-synthetic-fixture",
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const original = await client.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: owner.id,
        createdById: owner.id,
        primaryDate: new Date("2035-06-06T00:00:00.000Z"),
        totalAmount: 1,
        completedAt: new Date(),
      },
    });
    await client.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: owner.id,
        createdById: owner.id,
        primaryDate: new Date("2035-06-07T00:00:00.000Z"),
        supersedesId: original.id,
      },
    });

    let caught: unknown = null;
    try {
      await client.application.delete({ where: { id: original.id } });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as { code?: string }).code === "P2003" || String(caught).includes("23503")).toBe(
      true
    );
    const stillThere = await client.application.findUnique({ where: { id: original.id } });
    expect(stillThere).not.toBeNull();
  });

  it("AC-01(b): FK onDelete Restrict — deleting a Report that has a VoidedReportFile is rejected", async () => {
    const owner = await client.user.create({
      data: {
        loginName: `p9_t1_restrict_report_${RUN_ID}`,
        displayName: "Phase9 T1 Restrict Report Owner (Fixture)",
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
        primaryDate: new Date("2035-06-08T00:00:00.000Z"),
        totalAmount: 1,
        completedAt: new Date(),
      },
    });
    const report = await client.report.create({
      data: {
        applicationId: app.id,
        reportNumber: `TRV-203506-P9RESTRICT-${RUN_ID}`,
        numberPrefix: "TRV",
        numberPeriod: "203506",
        sequence: 9301,
        storageKey: `rpt/${RUN_ID}-restrict/pdf`,
        fileName: "restrict-fixture.pdf",
        byteSize: 1024,
        contentHash: "7".repeat(64),
        generatedById: owner.id,
      },
    });
    await client.voidedReportFile.create({
      data: {
        reportId: report.id,
        storageKey: `rpt/${RUN_ID}-restrict/void.pdf`,
        fileName: "restrict-fixture.pdf",
        byteSize: 512,
        contentHash: "8".repeat(64),
        createdById: owner.id,
      },
    });

    let caught: unknown = null;
    try {
      await client.report.delete({ where: { id: report.id } });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as { code?: string }).code === "P2003" || String(caught).includes("23503")).toBe(
      true
    );
  });

  it("AC-01(h): supersedes/supersededBy and voidedFile 為零 DDL 之虛擬反向關聯 — 讀取端可 include，寫入端於 Application/Report 皆無對應實體欄", async () => {
    const owner = await client.user.create({
      data: {
        loginName: `p9_t1_virtual_${RUN_ID}`,
        displayName: "Phase9 T1 Virtual Relation Owner (Fixture)",
        passwordHash: "not-a-real-hash-synthetic-fixture",
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const original = await client.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: owner.id,
        createdById: owner.id,
        primaryDate: new Date("2035-06-09T00:00:00.000Z"),
        totalAmount: 1,
        completedAt: new Date(),
      },
    });
    const revision = await client.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: owner.id,
        createdById: owner.id,
        primaryDate: new Date("2035-06-10T00:00:00.000Z"),
        supersedesId: original.id,
      },
    });

    const originalWithRevision = await client.application.findUniqueOrThrow({
      where: { id: original.id },
      include: { supersededBy: true },
    });
    expect(originalWithRevision.supersededBy?.id).toBe(revision.id);

    const revisionWithOriginal = await client.application.findUniqueOrThrow({
      where: { id: revision.id },
      include: { supersedes: true },
    });
    expect(revisionWithOriginal.supersedes?.id).toBe(original.id);

    // No revision yet → both sides null.
    const untouched = await client.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: owner.id,
        createdById: owner.id,
        primaryDate: new Date("2035-06-11T00:00:00.000Z"),
        totalAmount: 1,
        completedAt: new Date(),
      },
    });
    const untouchedRead = await client.application.findUniqueOrThrow({
      where: { id: untouched.id },
      include: { supersededBy: true, supersedes: true },
    });
    expect(untouchedRead.supersededBy).toBeNull();
    expect(untouchedRead.supersedes).toBeNull();

    // Report.voidedFile — zero DDL reverse relation.
    const report = await client.report.create({
      data: {
        applicationId: untouched.id,
        reportNumber: `TRV-203506-P9VDF-${RUN_ID}`,
        numberPrefix: "TRV",
        numberPeriod: "203506",
        sequence: 9401,
        storageKey: `rpt/${RUN_ID}-vdf/pdf`,
        fileName: "vdf-fixture.pdf",
        byteSize: 1024,
        contentHash: "9".repeat(64),
        generatedById: owner.id,
      },
    });
    const reportWithoutVoid = await client.report.findUniqueOrThrow({
      where: { id: report.id },
      include: { voidedFile: true },
    });
    expect(reportWithoutVoid.voidedFile).toBeNull();

    const voidedFile = await client.voidedReportFile.create({
      data: {
        reportId: report.id,
        storageKey: `rpt/${RUN_ID}-vdf/void.pdf`,
        fileName: "vdf-fixture.pdf",
        byteSize: 512,
        contentHash: "a".repeat(64),
        createdById: owner.id,
      },
    });
    const reportWithVoid = await client.report.findUniqueOrThrow({
      where: { id: report.id },
      include: { voidedFile: true },
    });
    expect(reportWithVoid.voidedFile?.id).toBe(voidedFile.id);

    // Report's own column set is untouched by the new reverse relation
    // (closed-set — "reportId" already lives on VoidedReportFile, not here).
    const reportColumnRows = await client.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'Report'`
    );
    expect(reportColumnRows.map((r) => r.column_name).sort()).toEqual(
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
  });

  it("AC-01(e): AuditAction 恰新增 APPLICATION_VOIDED — 九個既有值 ＋ 恰一個新值，聯集全等（多一／少一必紅）", async () => {
    const rows = await client.$queryRawUnsafe<Array<{ enumlabel: string }>>(
      `SELECT e.enumlabel FROM pg_enum e
       JOIN pg_type t ON e.enumtypid = t.oid
       JOIN pg_namespace n ON t.typnamespace = n.oid
       WHERE t.typname = 'AuditAction' AND n.nspname = current_schema()
       ORDER BY e.enumlabel`
    );
    const labels = rows.map((r) => r.enumlabel);
    expect(labels.sort()).toEqual(
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
        "APPLICATION_VOIDED",
      ].sort()
    );

    // 併記 D8(a) 硬約束（§8.6）：AuditAction 之新值語意為「事件」，非
    // Application 之布林旗標——本行以 enum 聯集本身即為證據，Application 側
    // 之「零 isVoided/voided 布林欄」已由上方 AC-01(a) 之 14 欄封閉集合斷言。
    expect(labels).toContain("APPLICATION_VOIDED");
  });

  it("AC-01(e): ALTER TYPE 新值於獨立交易後方可使用 — 同一交易內使用新值必失敗；獨立交易後可用（raw SQL 自證，探針值與 APPLICATION_VOIDED 無關）", async () => {
    const probeAdmin = new PrismaClient({ datasources: { db: { url: cleanUrl } } });
    try {
      // Probe 1: ADD VALUE 與「使用該值」放在同一交易 → 必失敗，且整個交易
      // （含 ADD VALUE 本身）被回滾。
      const sameTxLabel = `P9_T1_TX_PROBE_SAME_${RUN_ID}`;
      let sameTxError: unknown = null;
      try {
        await probeAdmin.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`ALTER TYPE "AuditAction" ADD VALUE '${sameTxLabel}'`);
          // PostgreSQL: "unsafe use of new value of enum type" — new
          // enum labels cannot be used in the same transaction that added
          // them.
          await tx.$executeRawUnsafe(`SELECT '${sameTxLabel}'::"AuditAction"`);
        });
      } catch (err) {
        sameTxError = err;
      }
      expect(sameTxError, "同一交易內使用新 enum 值必須失敗").not.toBeNull();

      // 整個交易（含 ADD VALUE）已回滾 — 該值不應存在於 pg_enum。
      const afterRollback = await probeAdmin.$queryRawUnsafe<Array<{ enumlabel: string }>>(
        `SELECT e.enumlabel FROM pg_enum e
         JOIN pg_type t ON e.enumtypid = t.oid
         JOIN pg_namespace n ON t.typnamespace = n.oid
         WHERE t.typname = 'AuditAction' AND n.nspname = current_schema()
           AND e.enumlabel = '${sameTxLabel}'`
      );
      expect(afterRollback, "回滾後探針值不應殘留").toHaveLength(0);

      // Probe 2: ADD VALUE 與「使用該值」分於兩個獨立交易 → 皆成功。
      const separateTxLabel = `P9_T1_TX_PROBE_SEPARATE_${RUN_ID}`;
      await probeAdmin.$executeRawUnsafe(`ALTER TYPE "AuditAction" ADD VALUE '${separateTxLabel}'`);
      const usedInNewTx = await probeAdmin.$queryRawUnsafe<Array<{ v: string }>>(
        `SELECT '${separateTxLabel}'::"AuditAction" AS v`
      );
      expect(usedInNewTx[0]?.v).toBe(separateTxLabel);
    } finally {
      await probeAdmin.$disconnect();
    }
  });

  it("AC-01(b)/(c): migration.sql（table）除 Application／VoidedReportFile 外零 ALTER，零 DROP／INSERT／UPDATE／額外 ALTER TYPE", () => {
    const sql = fs.readFileSync(
      path.join(REAL_MIGRATIONS_DIR, NEW_MIGRATION_DIR_TABLE, "migration.sql"),
      "utf8"
    );

    const alterTargets = [...sql.matchAll(/ALTER TABLE\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(alterTargets).size).toBeLessThanOrEqual(2);
    for (const target of alterTargets) {
      expect(["Application", "VoidedReportFile"]).toContain(target);
    }

    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+"/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/ALTER TYPE/i); // enum ALTER lives in the OTHER migration file
    expect(sql).toMatch(/CREATE TABLE "VoidedReportFile"/);
    expect(sql).toMatch(/ALTER TABLE "Application" ADD COLUMN/);

    // §8.5 逐字：一個 ALTER TABLE ADD COLUMN（Application）、一個 CREATE
    // TABLE、兩個 CREATE UNIQUE INDEX（VoidedReportFile）、一個 CREATE UNIQUE
    // INDEX（Application.supersedesId）、兩個 ADD CONSTRAINT ... FOREIGN KEY。
    expect((sql.match(/CREATE TABLE/gi) ?? []).length).toBe(1);
    expect((sql.match(/CREATE UNIQUE INDEX/gi) ?? []).length).toBe(3);
    expect((sql.match(/ADD CONSTRAINT/gi) ?? []).length).toBe(2);
    expect((sql.match(/FOREIGN KEY/gi) ?? []).length).toBe(2);
  });

  it("T1 即審統計鎖: migration.sql（table）恰為 7 條語句；migration.sql（enum）恰為 1 條語句（封 M10/M12 型穿透）", () => {
    const tableSql = fs.readFileSync(
      path.join(REAL_MIGRATIONS_DIR, NEW_MIGRATION_DIR_TABLE, "migration.sql"),
      "utf8"
    );
    expect(countSqlStatements(tableSql)).toBe(7);

    const enumSql = fs.readFileSync(
      path.join(REAL_MIGRATIONS_DIR, NEW_MIGRATION_DIR_ENUM, "migration.sql"),
      "utf8"
    );
    expect(countSqlStatements(enumSql)).toBe(1);
    expect(enumSql).toMatch(/ALTER TYPE "AuditAction" ADD VALUE 'APPLICATION_VOIDED'/);
  });

  it("T1 即審統計鎖 mutant 自證: 注入一條 DELETE FROM（M10 型）或一條不含既有關鍵字之新語句（M12 型）皆使語句總數鎖變紅", () => {
    const realSql = fs.readFileSync(
      path.join(REAL_MIGRATIONS_DIR, NEW_MIGRATION_DIR_TABLE, "migration.sql"),
      "utf8"
    );
    const realCount = countSqlStatements(realSql);
    expect(realCount).toBe(7);

    const withDelete = `${realSql}\nDELETE FROM "VoidedReportFile";\n`;
    expect(countSqlStatements(withDelete)).not.toBe(realCount);

    const injectedStatement = "CREATE TYPE \"InjectedEnum\" AS ENUM ('A');";
    expect(injectedStatement).not.toMatch(
      /CREATE TABLE|CREATE (?:UNIQUE )?INDEX|ADD CONSTRAINT|FOREIGN KEY|ALTER TABLE/
    );
    const withCreateType = `${realSql}\n${injectedStatement}\n`;
    expect(countSqlStatements(withCreateType)).not.toBe(realCount);
  });

  it("INFRA-002 破壞性掃描相容性: 兩個新 migration.sql 皆不含 DELETE FROM／TRUNCATE（T1b 常設掃描不誤攔）", () => {
    const tableSql = fs.readFileSync(
      path.join(REAL_MIGRATIONS_DIR, NEW_MIGRATION_DIR_TABLE, "migration.sql"),
      "utf8"
    );
    const enumSql = fs.readFileSync(
      path.join(REAL_MIGRATIONS_DIR, NEW_MIGRATION_DIR_ENUM, "migration.sql"),
      "utf8"
    );
    expect(tableSql).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE)\b/i);
    expect(enumSql).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE)\b/i);
  });

  // =========================================================================
  // AC-01(f): 機械連動實查 — 六處表數斷言／四處 AuditAction 聯集基線／一處
  // Application 欄位集合基線，實際處數與內容須與本檔（及 Handoff）回報值相符。
  //
  // Spec §8.5 之表格原列「AuditAction enum 基線」為 5 處（含
  // `phase5a-migration-safety.test.ts` :559），implementer 實查後發現該行僅為
  // 單一標籤存在性檢查（`AND e.enumlabel = 'USER_FUEL_CONSUMPTION_VERSION_
  // CREATED'`），並非九值聯集 `toEqual` 封閉斷言，故不需為 9→10 更新；本 Task
  // 之機械連動實際為 **4 處**（phase6:678／phase7:1052／phase7:2167／
  // phase8:1293）。此差異已據實回報於 Task Handoff（不弱化任何既有斷言，僅
  // 回報實查處數與 Spec 表格文字之落差）。
  // =========================================================================

  it("AC-01(f) 機械連動實查: 本 Phase 更新之基線處數與 Handoff 回報值相符", () => {
    const REPO_ROOT = path.resolve(BACKEND_ROOT, "..");

    const tableCountFiles = [
      { file: "backend/test/integration/infra001-isolation-self-check.test.ts", occurrences: 2 },
      { file: "backend/test/integration/phase6-migration-safety.test.ts", occurrences: 1 },
      { file: "backend/test/integration/phase7-migration-safety.test.ts", occurrences: 2 },
      { file: "backend/test/integration/phase8-migration-safety.test.ts", occurrences: 1 },
    ];
    let totalTableCountOccurrences = 0;
    for (const { file, occurrences } of tableCountFiles) {
      const content = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      const matches = content.match(/toBe\(17\)/g) ?? [];
      expect(matches.length, `${file}: expected ${occurrences}x toBe(17)`).toBe(occurrences);
      totalTableCountOccurrences += matches.length;
    }
    expect(totalTableCountOccurrences, "表數斷言連動總處數應為 6").toBe(6);

    const auditActionUnionFiles = [
      "backend/test/integration/phase6-migration-safety.test.ts",
      "backend/test/integration/phase7-migration-safety.test.ts", // 2 occurrences (M1 + R1/M2)
      "backend/test/integration/phase8-migration-safety.test.ts",
    ];
    let totalAuditActionOccurrences = 0;
    for (const file of auditActionUnionFiles) {
      const content = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      const matches = content.match(/APPLICATION_VOIDED/g) ?? [];
      totalAuditActionOccurrences += matches.length;
    }
    expect(totalAuditActionOccurrences, "AuditAction 聯集基線連動總處數應為 4").toBe(4);

    const applicationColumnBaselineFile =
      "backend/test/integration/phase8-migration-safety.test.ts";
    const content = fs.readFileSync(path.join(REPO_ROOT, applicationColumnBaselineFile), "utf8");
    expect(content).toMatch(/"voidReason"/);
    expect(content).toMatch(/"supersedesId"/);
  });
});
