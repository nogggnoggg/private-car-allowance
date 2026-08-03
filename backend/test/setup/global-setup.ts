/**
 * INFRA-001-T1 — vitest `globalSetup`：per-worker schema 供裝。
 *
 * 執行時機：vitest 主行程，測試開始前一次（D3，Spec §4.3）。職責：
 *
 *   1. fail-closed 護欄：`NODE_ENV=production` 時拒絕執行任何 DDL（AC-06）。
 *   2. 隔離未啟用（`TEST_DB_ISOLATION=off` 或 `DATABASE_URL` 未設）時完全
 *      不動作，不建立、不刪除任何 schema（AC-04/AC-05）。
 *   3. 孤兒清理：編號超出本次 `maxForks` 的既有 `^vitest_w[0-9]+$` schema，
 *      一律 drop（AC-09）。
 *   4. 對 `1..maxForks` 每個編號**按需重建**（AC-09，2026-08-03 修訂，人類
 *      批准第四選項）：schema 既有且 migration 狀態與 `prisma/migrations/`
 *      目錄吻合 ⇒ 沿用，不 drop 不 spawn CLI；不吻合或不存在 ⇒ drop 後
 *      `prisma migrate deploy` 重建。比對邏輯見 `db-isolation.ts` 的
 *      `schemaMigrationStateMatches`（純函式，可單獨單元測試）。
 *   5. 全程守護 `public` schema 的表數不變（AC-09），並把量測結果寫入一個
 *      暫存狀態檔，供 `infra001-isolation-self-check.test.ts` 讀取斷言。
 *
 * 不做 lazy 建立（D3）：setupFiles 只驗證 schema 存在，不建立 —— 避免 N 個
 * worker 同時 spawn Prisma CLI 的競態。
 *
 * fail-safe（INFRA-001b-T1 Packet 明示）：任何比對「不確定」（含 SQL 查詢失
 * 敗、schema 不存在、表不存在等一切非乾淨吻合的情形）一律當作「不吻合」，
 * 觸發重建 —— 絕不能「不確定卻沿用」。見 `readWorkerMigrationRows()`。
 *
 * `backend/src/**` 永不 import 這個模組（AC-18）。
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { MigrationDirChecksum, ProvisionedMigrationRow } from "./db-isolation.js";
import {
  WORKER_SCHEMA_PATTERN,
  isolationMode,
  schemaMigrationStateMatches,
  withSchema,
  workerSchemaName,
} from "./db-isolation.js";
import { computeMaxForks } from "./max-forks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const PRISMA_CLI_ENTRY = path.join(BACKEND_ROOT, "node_modules", "prisma", "build", "index.js");
const MIGRATIONS_DIR = path.join(BACKEND_ROOT, "prisma", "migrations");

/** 供 `infra001-isolation-self-check.test.ts` 讀取 AC-09 的 before/after 證據。 */
const STATE_FILE_PATH = path.join(os.tmpdir(), "infra001-vitest-isolation-state.json");

const MIGRATE_DEPLOY_CONCURRENCY = 4;

export interface Infra001IsolationState {
  maxForks: number;
  migrationsDirCount: number;
  publicTableCountBefore: number;
  publicTableCountAfter: number;
  setupDurationMs: number;
  /**
   * INFRA-001b-T1（AC-09 按需重建）：本次 run 中，1..maxForks 內有幾個 schema
   * 因 migration 狀態吻合而被沿用（未執行任何 DDL）。新欄位，向後相容——既有
   * 讀者（`infra001-isolation-self-check.test.ts` 的 AC-09 斷言）只讀
   * `maxForks`／`publicTableCountBefore`，不受影響。
   */
  reusedSchemaCount: number;
  /** 本次 run 中，1..maxForks 內有幾個 schema 因不吻合或不存在而被 drop 重建。 */
  rebuiltSchemaCount: number;
  /** 本次 run 中，編號超出 maxForks 的孤兒 schema 被移除的數量。 */
  orphanSchemaRemovedCount: number;
}

/**
 * 動態讀取 migration 目錄數（不寫死 7）——排除 `migration_lock.toml` 等非目錄項目。
 * Exported so `infra001-isolation-self-check.test.ts` can assert AC-07
 * (`_prisma_migrations` 已完成筆數 = 此值) against the same single source of
 * truth this module used during provisioning, instead of duplicating the
 * directory-scan logic in the test file.
 */
export function countMigrationDirs(): number {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).length;
}

/**
 * INFRA-001b-T1 — AC-09 按需重建：讀取 `prisma/migrations/` 下每個目錄的
 * `migration.sql`，計算其 sha256 十六進位雜湊值。
 *
 * 演算法查證（2026-08-03，實測）：對本機既有 7 個 migration 各自計算
 * `sha256(fs.readFileSync(migration.sql))` 並與既有 `_prisma_migrations.
 * checksum` 逐一比對，**7/7 完全相符**（例如 `20260801083343_init` 兩者皆為
 * `b6179a80ffdb3f6fe81fdee3ed7c835aca26940478b4d36035b789b2b0abb2ac`）——證實
 * Prisma 5.22 的 checksum 就是未加鹽的 migration.sql 內容 sha256 十六進位字
 * 串，可穩定重現。故採用「全量 checksum 比對」作為主策略，未退回到 Packet
 * 提及的「僅比對 migration_name 集合＋finished_at＋rolled_back_at」較弱策略
 * （後者仍作為每一列的必要條件之一，見 `schemaMigrationStateMatches`，只是
 * checksum 相符是額外的第四個必要條件，不是替代方案）。
 *
 * Exported for direct reuse by integration tests that need to construct the
 * exact same "expected" side of the comparison this module uses in
 * production, instead of duplicating the directory-scan + hashing logic.
 */
export function readMigrationDirsWithChecksum(): MigrationDirChecksum[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const migrationSqlPath = path.join(MIGRATIONS_DIR, entry.name, "migration.sql");
      const content = fs.readFileSync(migrationSqlPath);
      const checksum = crypto.createHash("sha256").update(content).digest("hex");
      return { name: entry.name, checksum };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 依規則命名的 schema，其餘一律禁止被 DDL 觸碰（D6）。 */
function assertIsWorkerSchemaName(name: string): void {
  if (!WORKER_SCHEMA_PATTERN.test(name)) {
    throw new Error(
      `[INFRA-001 globalSetup] 內部不變式違反：試圖對非 worker schema 名稱 "${name}" 執行 DDL。這是一個實作錯誤（應只對 ^vitest_w[0-9]+$ 操作），已中止以保護其餘資料。`
    );
  }
}

async function countPublicBaseTables(admin: PrismaClient): Promise<number> {
  const rows = await admin.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT count(*)::bigint AS count FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  return Number(rows[0]?.count ?? 0);
}

/** 列出資料庫中所有符合命名規則的既有 worker schema（無論是否在本次 1..maxForks 範圍內）。 */
async function listExistingWorkerSchemas(admin: PrismaClient): Promise<string[]> {
  const rows = await admin.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname ~ '^vitest_w[0-9]+$'`
  );
  return rows.map((r) => r.nspname);
}

/**
 * INFRA-001b-T1 — AC-09 按需重建：對指定 worker schema 讀取 `_prisma_migrations`
 * 的比對用欄位。
 *
 * fail-safe 的關鍵之處：回傳 `undefined`（而非空陣列）代表「查詢本身失敗」——
 * 可能是 schema 不存在、`_prisma_migrations` 表不存在、或任何其他不確定情
 * 形。呼叫端必須把 `undefined` 一律當作「不吻合」處理，**絕不能**把它當成
 * 「空陣列」餵給 `schemaMigrationStateMatches`（空陣列在語意上是「schema 存
 * 在但沒有任何 migration 紀錄」，與「查詢失敗、什麼都不知道」是不同的兩件
 * 事；`prisma/migrations/` 目錄非空，所以就算真的餵空陣列，
 * `schemaMigrationStateMatches` 也會因長度不等而回傳 false —— 但這裡刻意用
 * `undefined` 讓「不確定」的語意在型別層面就與「確定為空」分開，避免日後誤用）。
 */
async function readWorkerMigrationRows(
  admin: PrismaClient,
  schema: string
): Promise<ProvisionedMigrationRow[] | undefined> {
  assertIsWorkerSchemaName(schema);
  try {
    const rows = await admin.$queryRawUnsafe<ProvisionedMigrationRow[]>(
      `SELECT migration_name, checksum, finished_at, rolled_back_at FROM "${schema}"."_prisma_migrations"`
    );
    return rows;
  } catch {
    // Any failure — schema doesn't exist, `_prisma_migrations` table doesn't
    // exist (schema exists but was never migrated), transient connection
    // hiccup, whatever — is "uncertain". Fail-safe direction (Packet):
    // uncertain ⇒ treated as not-matching ⇒ rebuild. Never surface the error
    // here and never let the caller mistake this for "confirmed empty".
    return undefined;
  }
}

async function dropWorkerSchema(admin: PrismaClient, schema: string): Promise<void> {
  assertIsWorkerSchemaName(schema);
  // Identifier interpolation is safe here: `schema` is only ever a value that
  // has just been validated against WORKER_SCHEMA_PATTERN above (either read
  // back from pg_namespace, i.e. already a real existing identifier, or
  // produced by our own `workerSchemaName()`), never user/CLI-supplied text.
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

function resolvePrismaBinaryInvocation(): { command: string; args: string[] } {
  if (!fs.existsSync(PRISMA_CLI_ENTRY)) {
    throw new Error(
      `[INFRA-001 globalSetup] 找不到 Prisma CLI 進入點：${PRISMA_CLI_ENTRY}。請確認 backend 的 node_modules 已安裝（npm install）。`
    );
  }
  // Invoke the resolved JS entry point directly via `node`, bypassing the
  // node_modules/.bin/prisma(.cmd|.ps1) shim entirely (NFR-4). This sidesteps
  // Windows' refusal to `spawn()` a `.cmd` file without `shell: true`, and
  // behaves identically on Linux (CI) and Windows (dev machine) — no `npx`
  // (D3: avoid a registry lookup on every worker).
  return { command: process.execPath, args: [PRISMA_CLI_ENTRY, "migrate", "deploy"] };
}

function migrateDeployForSchema(schemaDatabaseUrl: string): Promise<void> {
  const { command, args } = resolvePrismaBinaryInvocation();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: schemaDatabaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
        resolve();
        return;
      }
      reject(
        new Error(
          `[INFRA-001 globalSetup] "prisma migrate deploy" 對 schema 供裝失敗（exit code ${code}）。\n` +
            `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
        )
      );
    });
  });
}

export type ProvisionSchemaAction = "reused" | "rebuilt";

export interface ProvisionSchemaResult {
  schema: string;
  action: ProvisionSchemaAction;
}

/**
 * INFRA-001b-T1 — AC-09 按需重建：對單一 worker schema 做「吻合則沿用、否則
 * drop 重建」的完整決策 + 動作，是 globalSetup 主流程對 `1..maxForks` 逐一呼
 * 叫的核心單位。
 *
 * 抽成獨立、可從外部（含整合測試）直接呼叫的函式，原因有二：
 *
 *   1. 讓 globalSetup 本體只負責「編排」（孤兒清理 + 對 1..maxForks 逐一呼叫
 *      這個函式 + 守護 public 表數不變），決策與動作邏輯的正確性可以獨立驗
 *      證，不必每次都跑一輪完整的 14 個（或更多）schema 供裝。
 *   2. 讓 integration 測試能在**不呼叫完整 `globalSetup()` 進而觸碰所有
 *      1..maxForks 現行 worker schema**的前提下，針對「吻合⇒沿用」
 *      「不吻合⇒重建」這兩個分支各自造一個獨立、不與任何其他並行執行中的
 *      測試檔共用的 schema 來驗證——見
 *      `infra001-isolation-self-check.test.ts` 的 AC-09 新增測試對此取捨的
 *      說明：直接對 1..maxForks 範圍內、可能正被其他 worker 使用中的 schema
 *      做故意破壞性的「動一筆 checksum」實驗，在預設並行度下有摧毀其他測試
 *      檔資料的風險，因此改用一個獨立、超出 1..maxForks 範圍、只有本測試自
 *      己知道的 schema 名稱來練習同一段生產程式碼路徑。
 */
export async function provisionWorkerSchema(
  admin: PrismaClient,
  databaseUrl: string,
  schema: string,
  expectedDirs: readonly MigrationDirChecksum[]
): Promise<ProvisionSchemaResult> {
  assertIsWorkerSchemaName(schema);

  const actualRows = await readWorkerMigrationRows(admin, schema);
  // fail-safe: `actualRows === undefined` 代表「不確定」（查詢失敗、schema
  // 不存在等），一律視為不吻合 —— 絕不能把 undefined 誤當成「已確認為空」而
  // 短路成沿用。
  const matches = actualRows !== undefined && schemaMigrationStateMatches(expectedDirs, actualRows);

  if (matches) {
    return { schema, action: "reused" };
  }

  // 不吻合或不存在：drop（IF EXISTS，對「本來就不存在」的情形是安全的
  // no-op）後重新 `migrate deploy`。
  await dropWorkerSchema(admin, schema);
  const schemaUrl = withSchema(databaseUrl, schema);
  await migrateDeployForSchema(schemaUrl);
  return { schema, action: "rebuilt" };
}

/** 帶上限的並行執行（D3：cap = 4，避免 advisory lock 爭用）。 */
async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

export default async function globalSetup(): Promise<void> {
  // AC-06: production 護欄 — 這是本回合唯一具破壞性的動作（DROP SCHEMA
  // CASCADE），在還沒讀任何其他設定之前就先擋。
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      '[INFRA-001 globalSetup] NODE_ENV="production"：拒絕執行任何 DDL（DROP/CREATE SCHEMA）。' +
        "本 globalSetup 只應在測試環境執行。"
    );
  }

  const mode = isolationMode(process.env);
  const databaseUrl = process.env.DATABASE_URL;

  // 「隔離啟用」＝ TEST_DB_ISOLATION 未設或為 schema，且 DATABASE_URL 已設
  // （Spec §3 定義）。任一條件不成立時，globalSetup 完全不動作：不建立、
  // 不刪除任何 schema（AC-04/AC-05）。
  if (mode === "off" || !databaseUrl) {
    return;
  }

  const startedAt = Date.now();
  const maxForks = computeMaxForks();
  const migrationsDirCount = countMigrationDirs();
  const expectedDirs = readMigrationDirsWithChecksum();

  const admin = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const publicTableCountBefore = await countPublicBaseTables(admin);

    // AC-09（按需重建）：先分流既有 schema —— 編號在 [1, maxForks] 內的進入
    // 「逐一比對，吻合則沿用、否則重建」的路徑；編號超出 maxForks 的一律視為
    // 孤兒，不參與比對，直接 drop（不對 public 或任何其他 schema 做任何動
    // 作，D6）。
    const existingSchemas = await listExistingWorkerSchemas(admin);
    const orphanSchemas: string[] = [];
    for (const schema of existingSchemas) {
      const match = /^vitest_w([0-9]+)$/.exec(schema);
      const poolId = match ? Number(match[1]) : Number.NaN;
      const isInRange = Number.isInteger(poolId) && poolId >= 1 && poolId <= maxForks;
      if (!isInRange) {
        orphanSchemas.push(schema);
      }
    }

    for (const schema of orphanSchemas) {
      await dropWorkerSchema(admin, schema);
    }

    // 對 1..maxForks 並行（cap 4）逐一決策：吻合 ⇒ 沿用（零 DDL）；不吻合或
    // 不存在 ⇒ drop 後 `prisma migrate deploy` 重建。
    const poolIds = Array.from({ length: maxForks }, (_, i) => i + 1);
    let reusedSchemaCount = 0;
    let rebuiltSchemaCount = 0;
    await runWithConcurrencyLimit(poolIds, MIGRATE_DEPLOY_CONCURRENCY, async (poolId) => {
      const schema = workerSchemaName(poolId);
      const result = await provisionWorkerSchema(admin, databaseUrl, schema, expectedDirs);
      if (result.action === "reused") {
        reusedSchemaCount += 1;
      } else {
        rebuiltSchemaCount += 1;
      }
    });

    const publicTableCountAfter = await countPublicBaseTables(admin);
    if (publicTableCountAfter !== publicTableCountBefore) {
      throw new Error(
        `[INFRA-001 globalSetup] 不變式違反：public schema 的表數在供裝前後改變了 （before=${publicTableCountBefore}, after=${publicTableCountAfter}）。globalSetup 只應對 ^vitest_w[0-9]+$ schema 執行 DDL —— 這代表有實作缺陷，已中止。`
      );
    }

    const state: Infra001IsolationState = {
      maxForks,
      migrationsDirCount,
      publicTableCountBefore,
      publicTableCountAfter,
      setupDurationMs: Date.now() - startedAt,
      reusedSchemaCount,
      rebuiltSchemaCount,
      orphanSchemaRemovedCount: orphanSchemas.length,
    };
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), "utf8");
    console.log(
      `[INFRA-001 globalSetup] 供裝完成：maxForks=${maxForks}，耗時 ${state.setupDurationMs}ms（沿用 ${reusedSchemaCount}／重建 ${rebuiltSchemaCount}／移除孤兒 ${orphanSchemas.length}）。`
    );
  } finally {
    await admin.$disconnect();
  }
}

export function readInfra001IsolationState(): Infra001IsolationState | undefined {
  if (!fs.existsSync(STATE_FILE_PATH)) return undefined;
  return JSON.parse(fs.readFileSync(STATE_FILE_PATH, "utf8")) as Infra001IsolationState;
}
