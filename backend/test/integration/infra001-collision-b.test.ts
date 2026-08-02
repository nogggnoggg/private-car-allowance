/**
 * Integration test for INFRA-001-T2 — AC-13 鑑別力測試（file B of a pair).
 *
 * 與 `infra001-collision-a.test.ts` 使用**完全相同**的寫死 `loginName`
 * （`infra001_fixed_collision`，無 RUN_ID、無隨機後綴）建立 User，並**刻意不
 * 清理**。兩檔皆須通過，各自斷言 `count === 1`。
 *
 * 這個常數刻意在兩檔各自重複宣告為字面值（而非從對方 import），以確保兩檔在
 * 模組層級互不依賴——每一檔獨立驗證同一件事：不論執行順序或落在哪個
 * worker，per-file TRUNCATE 都讓本檔從乾淨的 schema 起跑。完整鑑別力論證見
 * `infra001-collision-a.test.ts` 檔頭。
 *
 * 合成資料紀律：同 `infra001-collision-a.test.ts`。
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shouldSkipIsolationOnlyTests } from "../setup/db-isolation.js";

const DB_URL = process.env.DATABASE_URL;
const isolationOptedOut = shouldSkipIsolationOnlyTests(process.env);
const describeIsolation = DB_URL && !isolationOptedOut ? describe : describe.skip;

/** AC-13：與 `infra001-collision-a.test.ts` 完全相同的寫死值。 */
const FIXED_COLLISION_LOGIN_NAME = "infra001_fixed_collision";

describeIsolation("INFRA-001-T2 — AC-13 collision pair (file B)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  });

  afterAll(async () => {
    // AC-13 明文要求「刻意不清理」——這裡只斷開連線，不刪除建立的 User。
    await prisma.$disconnect();
  });

  it("AC-13 (file B): 以固定 loginName 建立 User 且不清理，count === 1", async () => {
    await prisma.user.create({
      data: {
        loginName: FIXED_COLLISION_LOGIN_NAME,
        displayName: "INFRA-001 AC-13 collision B",
        passwordHash: "infra001-synthetic-not-a-real-hash",
        role: "USER",
      },
    });

    const count = await prisma.user.count({ where: { loginName: FIXED_COLLISION_LOGIN_NAME } });
    expect(count).toBe(1);
  });
});
