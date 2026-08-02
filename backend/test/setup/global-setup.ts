/**
 * INFRA-001-T1 — vitest `globalSetup`：per-worker schema 供裝。
 *
 * 執行時機：vitest 主行程，測試開始前一次（D3，Spec §4.3）。職責：
 *
 *   1. fail-closed 護欄：`NODE_ENV=production` 時拒絕執行任何 DDL（AC-06）。
 *   2. 隔離未啟用（`TEST_DB_ISOLATION=off` 或 `DATABASE_URL` 未設）時完全
 *      不動作，不建立、不刪除任何 schema（AC-04/AC-05）。
 *   3. 孤兒清理：drop 所有符合 `^vitest_w[0-9]+$` 的既有 schema（含編號超出
 *      本次 `maxForks` 的孤兒）（AC-09）。
 *   4. 為 `1..maxForks` 每個編號並行（cap 4）spawn `prisma migrate deploy`
 *      供裝全新 schema（D3）。
 *   5. 全程守護 `public` schema 的表數不變（AC-09），並把量測結果寫入一個
 *      暫存狀態檔，供 `infra001-isolation-self-check.test.ts` 讀取斷言。
 *
 * 不做 lazy 建立（D3）：setupFiles 只驗證 schema 存在，不建立 —— 避免 N 個
 * worker 同時 spawn Prisma CLI 的競態。
 *
 * `backend/src/**` 永不 import 這個模組（AC-18）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  WORKER_SCHEMA_PATTERN,
  isolationMode,
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

async function listOrphanWorkerSchemas(admin: PrismaClient): Promise<string[]> {
  const rows = await admin.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname ~ '^vitest_w[0-9]+$'`
  );
  return rows.map((r) => r.nspname);
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

  const admin = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const publicTableCountBefore = await countPublicBaseTables(admin);

    // AC-09: 孤兒清理 — drop 所有符合命名規則的既有 schema，含編號超出本次
    // maxForks 的孤兒；不對 public 或任何其他 schema 做任何動作（D6）。
    const orphanSchemas = await listOrphanWorkerSchemas(admin);
    for (const schema of orphanSchemas) {
      await dropWorkerSchema(admin, schema);
    }

    // 為 1..maxForks 並行（cap 4）供裝全新 schema。
    const poolIds = Array.from({ length: maxForks }, (_, i) => i + 1);
    await runWithConcurrencyLimit(poolIds, MIGRATE_DEPLOY_CONCURRENCY, async (poolId) => {
      const schema = workerSchemaName(poolId);
      const schemaUrl = withSchema(databaseUrl, schema);
      await migrateDeployForSchema(schemaUrl);
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
    };
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), "utf8");
    console.log(
      `[INFRA-001 globalSetup] 供裝完成：maxForks=${maxForks}，耗時 ${state.setupDurationMs}ms。`
    );
  } finally {
    await admin.$disconnect();
  }
}

export function readInfra001IsolationState(): Infra001IsolationState | undefined {
  if (!fs.existsSync(STATE_FILE_PATH)) return undefined;
  return JSON.parse(fs.readFileSync(STATE_FILE_PATH, "utf8")) as Infra001IsolationState;
}
