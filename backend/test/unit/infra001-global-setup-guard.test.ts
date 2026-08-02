/**
 * Unit test for INFRA-001-R2 (M-1) — `backend/test/setup/global-setup.ts`
 * 的 `NODE_ENV=production` fail-closed 護欄（AC-06）。
 *
 * 這是本回合唯一具破壞性的動作（`DROP SCHEMA ... CASCADE`）的唯一守門，卻在
 * INFRA-001 全套測試中從未被實際執行過一次——本檔補上這條覆蓋。
 *
 * 鑑別力：`globalSetup()` 一開始就檢查 `process.env.NODE_ENV === "production"`
 * 並立即 throw（見 global-setup.ts:165-170），早於任何讀取 `DATABASE_URL`／
 * `computeMaxForks()`／建立 `PrismaClient` 的動作。若這條護欄被移除、被改成
 * 別的條件、或訊息文字被改到不再提及 "production"，本測試會紅：
 *   - 護欄被整段刪除 → 函式會繼續往下跑，讀取 `DATABASE_URL`（本測試環境刻意
 *     不設它——見下方 try/finally），最終直接 `return`（因為
 *     `isolationMode() === "off" || !databaseUrl` 分支）而不會 throw，
 *     `rejects.toThrow(...)` 斷言失敗。
 *   - 護欄條件被改壞（例如打字錯成別的環境變數名）→ 本測試把 `NODE_ENV` 設為
 *     `"production"` 後仍不會觸發 throw，同樣落入上面的 `return` 路徑而不紅。
 *   - 護欄訊息被改到不含 "production" 字樣 → `toThrow(/production/)` 的正則
 *     比對失敗。
 *
 * 不觸發任何 DDL：護欄在 `throw` 之後函式立即返回（reject），不會執行到後面
 * 任何一行讀取 `DATABASE_URL`、建立 `PrismaClient`、或 `DROP/CREATE SCHEMA`
 * 的程式碼——這正是本測試存在的意義（確認 DDL 真的被擋在最前面）。
 *
 * Test discipline: 不觸碰真實 DB、不改任何非本測試自己讀寫的 env var，
 * `NODE_ENV` 變更以 `finally` 確保還原，避免污染同一 worker 行程內的其他測試。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import globalSetup from "../setup/global-setup.js";

describe("INFRA-001-R2 (M-1) global-setup NODE_ENV=production guard — AC-06", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      process.env.NODE_ENV = undefined;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('rejects with an actionable "production" message before touching DATABASE_URL or any DB connection', async () => {
    await expect(globalSetup()).rejects.toThrow(/production/);
  });

  it("rejects with an Error instance carrying the DROP/CREATE SCHEMA DDL rationale in its message", async () => {
    await expect(globalSetup()).rejects.toThrow(/DDL/);
  });
});
