/**
 * INFRA-002 — 常設 schema drift guard（AC-01(h)）＋ 破壞性 DML 靜態掃描
 * （T1 即審 AR-1 承接）。
 *
 * 不綁定任何特定 Phase：本檔對「當下 `prisma/schema.prisma` 與
 * `prisma/migrations/` 全部目錄」做比對，往後每新增一個 migration 目錄
 * （下一個 Phase、下一次修訂）本檔自動涵蓋，不需要為每個 Phase 另建一份
 * 對應的 drift 測試。
 *
 * 手法沿用 PHASE-007-R1 M2 段已建立、且經 T1 即審重驗證的既有作法
 * （backend/test/integration/phase7-migration-safety.test.ts :2118 一帶；
 * 該檔本身**零改動零刪除**——本檔是它的常設化、去 Phase 化版本）：
 *
 *   `prisma migrate diff --from-migrations <migrations dir>
 *     --to-schema-datamodel <schema.prisma> --shadow-database-url <scratch>
 *     --exit-code`
 *
 * exit code 0 代表「migrations 目錄逐一套用後的狀態」與「schema.prisma 之
 * datamodel」完全一致（無漂移）。這條路徑攔截的是 information_schema 逐欄
 * 斷言攔不住的一類問題：schema.prisma 的宣告與已提交的 migration SQL
 * 不一致，但兩者「巧合地」在既有測試的取樣點上表現相同（PHASE-007-R1 的
 * mutant 驗證曾實測到這個漏洞——schema 端把 scale 改壞，DDL 端維持原樣，
 * 全套既有安全網測試仍綠，直到跑這條 `migrate diff` 才現形）。
 *
 * 【關鍵陷阱（T1 即審 FW-2 實測，治理級警示）】`--shadow-database-url` 之
 * 影子 schema **不會自動 DROP**（reviewer 實測遺留 16 張表）——本檔一律以
 * `try/finally` 主動 `DROP SCHEMA ... CASCADE`，並在測試內查詢
 * `pg_catalog.pg_namespace` 驗證清理確實成功（而不只是「發了 DROP 指令」）。
 *
 * 命名：影子 schema 一律使用 `infra002_drift_` 前綴，刻意落在
 * `test/setup/db-isolation.ts` 之 `WORKER_SCHEMA_PATTERN`
 * （`^vitest_w[0-9]+$`）之外，避免與 INFRA-001 per-worker 孤兒清理正則
 * 誤判互撞——與 phase7/phase8 安全網檔既有之 scratch-schema 紀律一致。
 *
 * TDD／紅燈自證（AC-01(h)）：實作後，暫時以 `git stash` 修改
 * `backend/prisma/schema.prisma`（`Report.sequence` 型別由 `Int` 改為
 * `String`——不影響任何其他既有測試檔之取樣點，僅本檔之 drift guard 可見）
 * 重跑本檔之 drift-guard `it`，紅燈訊息為 prisma 回報之 diff 內容
 * （`AlterTable`／型別不符），隨即 `git stash pop` 還原、重跑確認回綠。
 * 逐字紅燈輸出見本 Task Handoff。
 *
 * Requires a running Postgres instance; DATABASE_URL must be set (skips
 * otherwise, matching the rest of the suite's `describeWithDb` convention).
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSchema } from "../setup/db-isolation.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Paths / constants
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const REAL_MIGRATIONS_DIR = path.join(BACKEND_ROOT, "prisma", "migrations");
const PRISMA_CLI_ENTRY = path.join(BACKEND_ROOT, "node_modules", "prisma", "build", "index.js");

const RUN_ID = `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

// ---------------------------------------------------------------------------
// AC-01(h): drift guard helpers
// ---------------------------------------------------------------------------

/**
 * 執行 `prisma migrate diff --exit-code`：比對「migrations 目錄逐一套用後的
 * 狀態」與「`schema.prisma` 之 datamodel」。exit 0 ＝ 完全無差異。刻意不寫死
 * 任何一個 Phase 的路徑——`--from-migrations`／`--to-schema-datamodel` 一律指向
 * 「當下」的 `prisma/migrations`／`prisma/schema.prisma`，所以本函式與未來
 * 新增的 migration 目錄天然相容。
 */
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

async function dropSchema(admin: PrismaClient, schema: string): Promise<void> {
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

// ---------------------------------------------------------------------------
// T1 即審 AR-1: 破壞性 DML 靜態掃描（涵蓋全部 migration；常設，非某一 Phase 檔）
// ---------------------------------------------------------------------------

/**
 * 逐筆豁免白名單：目前為空——2026-08-06 對 `prisma/migrations` 全量掃描
 * （`grep -rniE "DELETE FROM|TRUNCATE"` 遞迴每個 migration 目錄下的
 * `migration.sql`）確認尚無任何既有 migration 合法出現 `DELETE FROM` /
 * `TRUNCATE`。日後若有
 * migration 需要合法使用（例如一次性資料遷移腳本），須在此逐筆列出 migration
 * 目錄名稱與依據（`{ "<migration 目錄>": "<依據，含 Task/Spec 出處>" }`），
 * 不得整段停用或弱化掃描本身。
 */
const DESTRUCTIVE_ALLOWLIST: Readonly<Record<string, string>> = {};

/** 純函式：在一段 SQL 文字中找出破壞性 DML 語句（大小寫不敏感）。 */
function findDestructiveStatements(sql: string): string[] {
  return [...sql.matchAll(/\b(DELETE\s+FROM|TRUNCATE)\b/gi)].map((m) => m[0]);
}

interface DestructiveScanViolation {
  migrationDir: string;
  matches: string[];
}

/** 對 `migrationsDir` 下每個 migration 目錄之 `migration.sql` 執行破壞性 DML 掃描。 */
function scanMigrationsForDestructiveStatements(
  migrationsDir: string,
  allowlist: Readonly<Record<string, string>>
): DestructiveScanViolation[] {
  const dirs = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const violations: DestructiveScanViolation[] = [];
  for (const dir of dirs) {
    if (Object.hasOwn(allowlist, dir)) continue;
    const sqlPath = path.join(migrationsDir, dir, "migration.sql");
    if (!fs.existsSync(sqlPath)) continue;
    const matches = findDestructiveStatements(fs.readFileSync(sqlPath, "utf8"));
    if (matches.length > 0) {
      violations.push({ migrationDir: dir, matches });
    }
  }
  return violations;
}

describe("INFRA-002 — 破壞性 DML 靜態掃描（T1 即審 AR-1 承接）", () => {
  it("prisma/migrations 下沒有任何一個 migration.sql（白名單外）含 DELETE FROM / TRUNCATE", () => {
    const violations = scanMigrationsForDestructiveStatements(
      REAL_MIGRATIONS_DIR,
      DESTRUCTIVE_ALLOWLIST
    );
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("mutant 自證: findDestructiveStatements 對 DELETE FROM / TRUNCATE 有鑑別力，一般 DDL 不誤判", () => {
    expect(findDestructiveStatements('DELETE FROM "Report" WHERE 1=1;')).toEqual(["DELETE FROM"]);
    expect(findDestructiveStatements('TRUNCATE "Report";')).toEqual(["TRUNCATE"]);
    // control — 一般 DDL（CREATE / ALTER ADD COLUMN）零誤判。
    expect(findDestructiveStatements('CREATE TABLE "X" ("id" TEXT NOT NULL);')).toEqual([]);
    expect(findDestructiveStatements('ALTER TABLE "X" ADD COLUMN "y" TEXT;')).toEqual([]);
  });

  it("allowlist 自證: 白名單命中之目錄即使含破壞性語句亦被跳過（以暫存目錄操作，不觸碰真實 migrations 目錄）", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "infra002-ar1-allowlist-"));
    try {
      const fakeDir = "fake_migration_for_test";
      fs.mkdirSync(path.join(tmpDir, fakeDir));
      fs.writeFileSync(path.join(tmpDir, fakeDir, "migration.sql"), 'DELETE FROM "X";', "utf8");

      // 未豁免 → 必須被抓到。
      expect(scanMigrationsForDestructiveStatements(tmpDir, {})).toEqual([
        { migrationDir: fakeDir, matches: ["DELETE FROM"] },
      ]);
      // 白名單命中 → 跳過。
      expect(
        scanMigrationsForDestructiveStatements(tmpDir, {
          [fakeDir]: "test fixture — 非真實 migration，僅供自證",
        })
      ).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-01(h): drift guard（常設，不綁 Phase）
// ---------------------------------------------------------------------------

describeWithDb("INFRA-002 — schema drift guard (AC-01(h))", () => {
  let admin: PrismaClient;

  beforeAll(async () => {
    if (!DB_URL) return;
    admin = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await admin.$connect();
  });

  afterAll(async () => {
    if (!DB_URL) return;
    if (admin) await admin.$disconnect();
  });

  it("schema.prisma 與 prisma/migrations 逐一套用後之狀態完全一致（prisma migrate diff --exit-code = 0）；影子 schema 用畢即清", async () => {
    const shadowSchema = `infra002_drift_${RUN_ID}`;
    const shadowUrl = withSchema(DB_URL as string, shadowSchema);
    try {
      const { code, stdout, stderr } = await runMigrateDiff(shadowUrl);
      expect(
        code,
        `schema.prisma 與 prisma/migrations 有漂移\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
      ).toBe(0);
    } finally {
      // FW-2 陷阱：`--shadow-database-url` 之影子 schema 不會自動 DROP
      // （reviewer 於 T1 即審實測遺留 16 表）——此處主動清理。
      await dropSchema(admin, shadowSchema);
    }

    // 驗證清理確實成功（而非僅是「發了 DROP 指令」）：清理後
    // pg_catalog.pg_namespace 不應再含該影子 schema。
    const remaining = await admin.$queryRawUnsafe<Array<{ nspname: string }>>(
      "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = $1",
      shadowSchema
    );
    expect(remaining, `影子 schema "${shadowSchema}" 清理後仍殘留`).toHaveLength(0);
  });
});
