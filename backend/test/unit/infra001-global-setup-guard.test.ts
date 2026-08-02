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
 *   - 護欄被整段刪除 → 函式會繼續往下跑。本測試環境的 `DATABASE_URL` 實際上
 *     一定有值（vitest 會自動載入 `backend/.env`），若不做任何處理，護欄被刪
 *     時函式會一路跑到 `DROP SCHEMA ... CASCADE`，砍掉當前 worker 正在用的
 *     schema——測試最終仍會因為沒有 throw 而紅，但代價是真的執行了破壞性
 *     DDL。為了讓「護欄被刪」這個突變路徑保持無害，本測試在 `beforeEach`
 *     暫時移除 `process.env.DATABASE_URL`（`Reflect.deleteProperty`），讓
 *     globalSetup 即使跳過
 *     production 檢查，也會落入 `isolationMode() === "off" || !databaseUrl`
 *     的提早 `return` 分支而不會觸碰任何 DB；`afterEach` 還原原值。
 *   - 護欄條件被改壞（例如打字錯成別的環境變數名）→ 本測試把 `NODE_ENV` 設為
 *     `"production"` 後仍不會觸發 throw，同樣落入上面的 `return` 路徑而不紅。
 *   - 護欄訊息被改到不含 "production" 字樣 → `toThrow(/production/)` 的正則
 *     比對失敗。
 *
 * 不觸發任何 DDL：正常路徑下護欄在 `throw` 之後函式立即返回（reject），不會
 * 執行到後面任何一行讀取 `DATABASE_URL`、建立 `PrismaClient`、或
 * `DROP/CREATE SCHEMA` 的程式碼；即使護欄被突變刪除，上述的 `DATABASE_URL`
 * 暫時移除也確保函式提早 `return`，同樣不觸碰任何 DB——這正是本測試存在的
 * 意義（確認 DDL 真的被擋在最前面，且鑑別過程本身也不會意外造成破壞）。
 *
 * Test discipline: 不觸碰真實 DB、`NODE_ENV`／`DATABASE_URL` 變更以
 * `beforeEach`/`afterEach` 成對暫存與還原，避免污染同一 worker 行程內的其他
 * 測試。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import globalSetup from "../setup/global-setup.js";

describe("INFRA-001-R2 (M-1) global-setup NODE_ENV=production guard — AC-06", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    // 讓「護欄被突變刪除」的路徑也無害：若沒有這行，護欄被刪時函式會用真實
    // DATABASE_URL 一路跑到 DROP SCHEMA CASCADE。移除後，即使護欄失效，
    // globalSetup 也會在 `!databaseUrl` 分支提早 return，測試以乾淨紅燈
    // （沒有 throw）失敗，而不會執行任何 DDL。
    // 用 `Reflect.deleteProperty` 而非 `delete` 運算子：兩者行為一致，但
    // 前者不觸發 biome `lint/performance/noDelete`；用 `= undefined` 則會
    // 把字串 `"undefined"` 寫入 `process.env`（AR-1），並非真正移除該 key。
    Reflect.deleteProperty(process.env, "DATABASE_URL");
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      Reflect.deleteProperty(process.env, "NODE_ENV");
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalDatabaseUrl === undefined) {
      Reflect.deleteProperty(process.env, "DATABASE_URL");
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('rejects with an actionable "production" message before touching DATABASE_URL or any DB connection', async () => {
    await expect(globalSetup()).rejects.toThrow(/production/);
  });

  it("rejects with an Error instance carrying the DROP/CREATE SCHEMA DDL rationale in its message", async () => {
    await expect(globalSetup()).rejects.toThrow(/DDL/);
  });
});
