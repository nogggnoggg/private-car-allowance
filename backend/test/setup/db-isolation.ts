/**
 * INFRA-001-T1 — per-worker schema 隔離：純函式層。
 *
 * 這個模組刻意不碰 DB、不碰檔案系統，讓 AC-02～AC-06 可以用純單元測試涵蓋
 * （見 backend/test/unit/infra001-db-isolation.test.ts）。
 *
 * 讀取來源（依 Spec §5.1）：
 *   - `env.DATABASE_URL`        — 基礎連線字串（未改寫前）
 *   - `env.TEST_DB_ISOLATION`   — 開關：未設＝`"schema"`；`"off"`＝完全還原；
 *                                  其他值一律拋錯（D5，不得靜默當成 off）
 *   - `env.VITEST_POOL_ID`      — tinypool 的行程槽位編號（D2），1..maxForks
 *
 * `backend/src/**` 永不 import 這個模組（AC-18 以結構性斷言檢查）。
 */

export type IsolationMode = "schema" | "off";

/** 讀 env 的最小形狀，避免直接依賴 `NodeJS.ProcessEnv`（維持純函式、可測試性）。 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/** schema 命名規則的單一事實來源。AC-09 的孤兒清理 regex 依此推導。 */
export const WORKER_SCHEMA_PATTERN = /^vitest_w[0-9]+$/;

/**
 * 解析 `TEST_DB_ISOLATION` 開關。
 *
 * - 未設定 → `"schema"`（預設啟用隔離）
 * - `"schema"` / `"off"` → 原樣回傳
 * - 其他任何值 → 拋錯（D5：不得靜默當成 `off`，否則設定被打錯字就悄悄關閉隔離）
 */
export function isolationMode(env: EnvLike): IsolationMode {
  const raw = env.TEST_DB_ISOLATION;
  if (raw === undefined) return "schema";
  if (raw === "schema" || raw === "off") return raw;
  throw new Error(
    `TEST_DB_ISOLATION="${raw}" 不是有效值。允許值僅為 "schema"（預設，可省略）或 "off"（完全還原修復前行為）。請修正此環境變數，或直接移除以使用預設值。`
  );
}

/**
 * `off` 模式下，INFRA-001 自身的隔離專屬測試（AC-13/14/15 所屬檔案）是否應該
 * skip。
 *
 * AC-05 的鑑別力核心：**只有在明示 `TEST_DB_ISOLATION === "off"` 時才回報
 * true**。缺席或無效值都必須回報 false —— 否則設定被誤刪時這些測試會自己
 * 躲開，鑑別力歸零。無效值交由呼叫端的 `isolationMode()` 拋錯處理，這裡只
 * 需確認「不是 off 就不 skip」。
 */
export function shouldSkipIsolationOnlyTests(env: EnvLike): boolean {
  return env.TEST_DB_ISOLATION === "off";
}

/** `vitest_w<N>` 命名規則的唯一產生點。 */
export function workerSchemaName(poolId: number): string {
  return `vitest_w${poolId}`;
}

/**
 * 解析並驗證 `VITEST_POOL_ID`。fail-closed（AC-03 a/b）：缺席或非正整數一律
 * 拋出含可行動訊息的錯誤，絕不回退為某個預設 id。
 */
export function parseWorkerPoolId(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    throw new Error(
      "VITEST_POOL_ID 未設定，無法決定 per-worker schema。" +
        "這通常表示目前不是在 vitest 的 forks pool 行程內執行（例如直接用 " +
        "node/tsx 執行此模組），或 vitest 版本改變了 worker 身分傳遞機制。" +
        "若確實要停用隔離，請明確設定 TEST_DB_ISOLATION=off，而不是依賴此錯誤。"
    );
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `VITEST_POOL_ID="${raw}" 不是正整數，無法決定 per-worker schema。預期值域為 1..maxForks（tinypool 的行程槽位編號）。`
    );
  }
  return parsed;
}

/**
 * 隔離啟用時，把 `DATABASE_URL` 改寫為指向本 worker 專屬 schema 的 URL。
 *
 * 三種輸入形狀（AC-02）：
 *   1. 無 query string                → 附加 `?schema=vitest_w<N>`
 *   2. 已有其他 query 參數            → 保留原參數，追加 `schema=vitest_w<N>`
 *   3. 已有 `schema=` 參數            → 覆蓋為 `vitest_w<N>`（其餘參數保留）
 *
 * fail-closed（AC-03/AC-04/AC-05）：
 *   - `DATABASE_URL` 未設 → 回傳 `undefined`，不拋錯（AC-04；讓既有
 *     `describeWithDb` 的 skip 行為維持不變）。
 *   - `TEST_DB_ISOLATION` 為無效值 → 拋錯（由 `isolationMode()` 拋出）。
 *   - `TEST_DB_ISOLATION=off` → 原樣回傳輸入 URL，不做任何改寫。
 *   - 隔離啟用但 `VITEST_POOL_ID` 缺席/非正整數 → 拋錯（由
 *     `parseWorkerPoolId()` 拋出），**絕不**回退到未改寫的 `DATABASE_URL`。
 *
 * 目標 schema 是否存在於 DB 中（AC-03(c)）不是這個純函式的職責 —— 那需要
 * 一次 DB 查詢，由 `setup-file.ts` 在改寫後另行驗證。
 */
export function resolveWorkerDatabaseUrl(env: EnvLike): string | undefined {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) return undefined;

  const mode = isolationMode(env);
  if (mode === "off") return databaseUrl;

  const poolId = parseWorkerPoolId(env.VITEST_POOL_ID);
  const schema = workerSchemaName(poolId);

  return withSchema(databaseUrl, schema);
}

/**
 * 把任意 PostgreSQL 連線字串的 `schema` query 參數改寫為指定值，保留其餘所有
 * 參數與 URL 其他部分不變（新增或覆蓋，視原本是否已有 `schema=` 而定）。
 *
 * 抽成獨立函式供 `global-setup.ts` 重用 —— 它需要為 `1..maxForks` 逐一組出
 * 供裝用的 URL，但供裝時尚無 `VITEST_POOL_ID`（globalSetup 跑在主行程，
 * 不在任何 fork worker 內），因此不能經由 `resolveWorkerDatabaseUrl()`。
 */
export function withSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("schema", schema);
  return url.toString();
}
