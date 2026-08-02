/**
 * Unit test for INFRA-001-R2 (S-3) — `backend/test/setup/setup-file.ts`
 * 的 `truncateWorkerSchema`：查到 0 張業務表時的 fail-closed 行為。
 *
 * 背景：本 worker schema 由 global-setup 以 `prisma migrate deploy` 供裝，
 * 必然含 11 張業務表（Spec §3 AC-08）——查到 0 張不是「這個 schema 剛好沒
 * 資料」，而是 `current_schema()`/`search_path` 失效的訊號（例如
 * `resolveWorkerDatabaseUrl` 改寫失敗卻未拋錯、或 `schema=` 參數被覆寫）。
 * 修復前的程式碼在這個分支靜默 `return`，會讓後續清空動作「看似成功」但其
 * 實完全沒有清空到正確的 schema——比清空失敗更危險的靜默資料污染。
 *
 * 這裡不連真實 DB：`truncateWorkerSchema` 的參數型別已收斂為
 * `WorkerSchemaSqlExecutor`（只需要 `$queryRawUnsafe`/`$executeRawUnsafe`），
 * 讓本測試可以注入一個假物件，讓「表清單查詢回傳 0 筆」這個情境可控重現，
 * 不需要在測試環境裡真的搭一個空 schema。
 *
 * 鑑別力：把 setup-file.ts 的 `if (tables.length === 0) return;` 改回去（即
 * S-3 修復前的行為），本測試的 `rejects.toThrow(...)` 斷言會失敗——
 * `truncateWorkerSchema` 會 resolve 而不是 reject，因為它會在讀到空陣列後
 * 直接安靜返回。同時第二個測試用 spy 證明：0 張表的情境下絕不會呼叫
 * `$executeRawUnsafe`（不會對錯的 schema 動任何 DELETE/TRUNCATE）。
 *
 * Test discipline: 全程使用手刻假物件，不觸碰真實 DB、不 import
 * db-isolation.ts / global-setup.ts。
 */
import { describe, expect, it, vi } from "vitest";
import { type WorkerSchemaSqlExecutor, truncateWorkerSchema } from "../setup/setup-file.js";

function makeFakeExecutor(
  queryImpl: (query: string) => unknown
): WorkerSchemaSqlExecutor & { $executeRawUnsafe: ReturnType<typeof vi.fn> } {
  const executeSpy = vi.fn(async () => 0);
  return {
    $queryRawUnsafe: async (query: string) => queryImpl(query) as never,
    $executeRawUnsafe: executeSpy,
  };
}

describe("INFRA-001-R2 (S-3) truncateWorkerSchema — 0-table fail-closed guard", () => {
  it("throws an actionable error mentioning search_path/current_schema when the table list is empty", async () => {
    const fake = makeFakeExecutor(() => []);

    await expect(truncateWorkerSchema(fake)).rejects.toThrow(/current_schema|search_path/);
  });

  it("never issues a DELETE/TRUNCATE (`$executeRawUnsafe`) when the table list is empty", async () => {
    const fake = makeFakeExecutor(() => []);

    await expect(truncateWorkerSchema(fake)).rejects.toThrow();
    expect(fake.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("sanity check: a non-empty table list still proceeds to DELETE (guard is 0-specific, not overzealous)", async () => {
    const fake = makeFakeExecutor((query) => {
      if (query.includes("pg_tables")) {
        return [{ tablename: "OnlyTable" }];
      }
      // Foreign-key edge lookup: no FKs, single table trivially sorts.
      return [];
    });

    await expect(truncateWorkerSchema(fake)).resolves.toBeUndefined();
    expect(fake.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(fake.$executeRawUnsafe).toHaveBeenCalledWith('DELETE FROM "OnlyTable"');
  });
});
