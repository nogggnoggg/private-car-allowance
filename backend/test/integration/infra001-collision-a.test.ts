/**
 * Integration test for INFRA-001-T2 — AC-13 鑑別力測試（file A of a pair).
 *
 * 與 `infra001-collision-b.test.ts` 使用**完全相同**的寫死 `loginName`
 * （`infra001_fixed_collision`，無 RUN_ID、無隨機後綴）建立 User，並**刻意不
 * 清理**。兩檔皆須通過，各自斷言 `count === 1`。
 *
 * 鑑別力（Spec §3 AC-13 / §9.2）：關閉隔離後（`TEST_DB_ISOLATION=off`），兩檔
 * 共用同一個 `public` schema，後執行者必然踩 `loginName` 的 `@unique` 約束
 * （P2002）→ 紅。與執行順序、worker 配置無關（同 worker 則先後衝突，異 worker
 * 則並發衝突）。啟用隔離後，per-file TRUNCATE（`setup-file.ts` 的 root
 * `beforeAll`）在每一檔開始時清空本 worker schema，使兩檔各自從零起跑，因此
 * 兩檔都能通過且各自 `count === 1` —— 這正是 per-file 清空機制存在的證明，
 * 而非單純「隔離啟用就一定過」的偶然結果。
 *
 * 這一檔本身**不清理**建立的 User（AC-13 明文要求），依賴下一個測試檔的
 * root `beforeAll` TRUNCATE 來清空 —— 這也同時是 AC-12（行程級中斷殘留自癒）
 * 機制在真實測試套件執行序列中的一次自然演練。
 *
 * Skip 語意（比照 `infra001-isolation-self-check.test.ts`）：僅在
 * `DATABASE_URL` 未設或 `TEST_DB_ISOLATION` 被明示設為 `off` 時 skip，不因
 * 「隔離看起來沒生效」而 skip。
 *
 * 合成資料紀律：`loginName` 使用 `infra001_` 前綴（AC-13 要求的固定值本身即
 * 此前綴），`passwordHash` 為明顯非真實常數字串，不呼叫 argon2 / `src/auth/**`。
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shouldSkipIsolationOnlyTests } from "../setup/db-isolation.js";

const DB_URL = process.env.DATABASE_URL;
const isolationOptedOut = shouldSkipIsolationOnlyTests(process.env);
const describeIsolation = DB_URL && !isolationOptedOut ? describe : describe.skip;

/** AC-13：兩檔必須使用完全相同的寫死值，無 RUN_ID、無隨機後綴。 */
const FIXED_COLLISION_LOGIN_NAME = "infra001_fixed_collision";

describeIsolation("INFRA-001-T2 — AC-13 collision pair (file A)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  });

  afterAll(async () => {
    // AC-13 明文要求「刻意不清理」——這裡只斷開連線，不刪除建立的 User。
    await prisma.$disconnect();
  });

  it("AC-13 (file A): 以固定 loginName 建立 User 且不清理，count === 1", async () => {
    await prisma.user.create({
      data: {
        loginName: FIXED_COLLISION_LOGIN_NAME,
        displayName: "INFRA-001 AC-13 collision A",
        passwordHash: "infra001-synthetic-not-a-real-hash",
        role: "USER",
      },
    });

    const count = await prisma.user.count({ where: { loginName: FIXED_COLLISION_LOGIN_NAME } });
    expect(count).toBe(1);
  });
});
