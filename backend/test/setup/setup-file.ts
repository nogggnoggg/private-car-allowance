/**
 * INFRA-001-T1 — vitest `setupFiles`：per-worker URL 改寫 + schema 存在性驗證。
 *
 * 執行時機：每個測試檔的 fork worker 行程內，測試檔模組被 import **之前**
 * （已由 R-1 實驗於真實執行中確認，見 Task Handoff）。
 *
 * 職責（T1 範圍，**不含 TRUNCATE** —— per-file 清空是 T2 的工作）：
 *   1. 若隔離未啟用（`TEST_DB_ISOLATION=off` 或 `DATABASE_URL` 未設）：什麼都
 *      不做，`describeWithDb` 的既有 skip 行為與修復前完全一致（AC-04/AC-05）。
 *   2. 否則：呼叫 `resolveWorkerDatabaseUrl()` 改寫 `process.env.DATABASE_URL`
 *      → 指向本 worker 的專屬 schema。純函式層的 fail-closed（AC-03 a/b）
 *      已由 `resolveWorkerDatabaseUrl()` 涵蓋（`VITEST_POOL_ID` 缺席/非正整數
 *      即拋錯，不回退）。
 *   3. 驗證目標 schema 確實已被 `global-setup.ts` 供裝（AC-03(c)）——不存在
 *      即拋出含 schema 名與修復建議的可行動錯誤，**絕不**回退到未改寫的
 *      `DATABASE_URL`。
 *
 * 這一步的正確性是整個方案的支點（Spec §5.3）：若順序不如預期，既有 29 個
 * integration 檔的模組頂層 `const DB_URL = process.env.DATABASE_URL` 會讀到
 * 舊值、隔離完全失效——這正是為何 AC-01/AC-14 必須是「實跑斷言」而非推論。
 *
 * `backend/src/**` 永不 import 這個模組（AC-18）。
 */
import { PrismaClient } from "@prisma/client";
import { isolationMode, resolveWorkerDatabaseUrl } from "./db-isolation.js";

/**
 * Exported (not just used internally) so
 * `test/integration/infra001-isolation-self-check.test.ts` can exercise
 * AC-03(c) directly against a deliberately-nonexistent schema name, without
 * needing to fabricate a whole separate vitest run. Re-importing this module
 * from a test file does not re-run its top-level side effects a second time
 * within the same worker process — Node's ESM module cache means the
 * `setupFiles`-triggered import and this later import resolve to the same
 * cached module instance.
 */
export async function verifyWorkerSchemaExists(databaseUrl: string, schema: string): Promise<void> {
  const probe = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const rows = await probe.$queryRawUnsafe<Array<{ exists: boolean }>>(
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS exists",
      schema
    );
    if (!rows[0]?.exists) {
      throw new Error(
        `[INFRA-001 setup-file] 目標 schema "${schema}" 在資料庫中不存在（AC-03c fail-closed）。這通常表示：(a) global-setup 尚未執行或執行失敗，(b) 你以 CLI 覆寫了 --pool-options.forks.maxForks 使其超過供裝時的上限，或 (c) 直接單獨執行本測試檔而繞過了 globalSetup。請重跑完整測試套件（讓 globalSetup 供裝）、或確認 maxForks 未被覆寫。絕不會回退到未改寫的 DATABASE_URL。`
      );
    }
  } finally {
    await probe.$disconnect();
  }
}

const isolationEnabled =
  isolationMode(process.env) === "schema" && Boolean(process.env.DATABASE_URL);

if (isolationEnabled) {
  const rewritten = resolveWorkerDatabaseUrl(process.env);
  if (!rewritten) {
    // resolveWorkerDatabaseUrl 只在 DATABASE_URL 未設時回傳 undefined，
    // 而上面的 isolationEnabled 檢查已排除這個情形——防禦性寫法，理論上
    // 不可達。
    throw new Error("[INFRA-001 setup-file] 內部不變式違反：隔離已啟用但改寫結果為 undefined。");
  }

  process.env.DATABASE_URL = rewritten;

  const schemaMatch = new URL(rewritten).searchParams.get("schema");
  if (!schemaMatch) {
    throw new Error("[INFRA-001 setup-file] 內部不變式違反：改寫後的 URL 缺少 schema 參數。");
  }

  // vitest 的 setupFiles 支援 top-level await（ESM）。這一步必須在測試檔
  // import 之前完成同步等待，否則後面 import 的測試檔可能在 schema 驗證完
  // 成前就已讀取 process.env.DATABASE_URL ——但因為同一個 setupFiles 模組
  // 內部所有程式碼都在此 await 完成前不會 return，vitest 會等待整個
  // setupFiles 模組的 top-level Promise resolve 後才繼續 import 測試檔。
  await verifyWorkerSchemaExists(rewritten, schemaMatch);
}
