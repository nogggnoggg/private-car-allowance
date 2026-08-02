/**
 * Integration test for INFRA-001-T2 — AC-12 行程級中斷殘留自癒。
 *
 * 情境：`PROJECT_STATE.md` L121 所述的 R6 self-heal 缺口——一個測試行程被中途
 * 砍斷（例如 CI runner 逾時、開發者 Ctrl-C），留下一組會爆 FK 的殘留：一個
 * `User` + 其名下 `Application` + 引用該使用者的 `AuditLog`，且從未執行任何
 * `afterAll` 清理。下一次有測試檔跑在同一個 worker schema 時，這組殘留原封不
 * 動地還在裡面。
 *
 * 本測試直接呼叫 `setup-file.ts` 匯出的 `truncateWorkerSchema()`——也就是
 * `setup-file.ts` 以 root `beforeAll` 註冊、每個測試檔開始前真正執行的那個
 * 函式——來模擬「下一個測試檔的 root beforeAll」，而不需要真的建立第二個實體
 * 檔案。這樣測到的是 T2 實際生產路徑的 TRUNCATE 邏輯本身，而非重新實作一份
 * 平行的驗證邏輯。
 *
 * Skip 語意（比照 `infra001-isolation-self-check.test.ts`）：僅在
 * `DATABASE_URL` 未設或 `TEST_DB_ISOLATION` 被明示設為 `off` 時 skip。
 *
 * 合成資料紀律：`loginName` 使用 `infra001_` 前綴，`passwordHash` 為明顯非
 * 真實常數字串，不呼叫 argon2 / `src/auth/**`。
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shouldSkipIsolationOnlyTests } from "../setup/db-isolation.js";
import { truncateWorkerSchema } from "../setup/setup-file.js";

const DB_URL = process.env.DATABASE_URL;
const isolationOptedOut = shouldSkipIsolationOnlyTests(process.env);
const describeIsolation = DB_URL && !isolationOptedOut ? describe : describe.skip;

describeIsolation("INFRA-001-T2 — AC-12 行程級中斷殘留自癒", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("注入 User+Application+AuditLog 殘留後，TRUNCATE 仍能歸零且 FK 依賴的插入不爆", async () => {
    // 1. 模擬行程級中斷殘留：User + 其名下 Application + 引用該 User 的
    //    AuditLog——PROJECT_STATE.md L121 所述會爆 FK 的形狀，刻意不清理。
    const residueUser = await prisma.user.create({
      data: {
        loginName: "infra001_residue_crash_user",
        displayName: "INFRA-001 AC-12 模擬殘留使用者",
        passwordHash: "infra001-synthetic-not-a-real-hash",
        role: "ADMIN",
      },
    });
    await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: residueUser.id,
        createdById: residueUser.id,
        primaryDate: new Date("2031-01-01"),
      },
    });
    await prisma.auditLog.create({
      data: {
        action: "USER_CREATED",
        actorId: residueUser.id,
        targetId: residueUser.id,
        targetLabel: residueUser.loginName,
      },
    });

    // sanity check：殘留確實落地，避免這個測試因為根本沒插入資料而假通過。
    const [userCountBefore, appCountBefore, auditCountBefore] = await Promise.all([
      prisma.user.count(),
      prisma.application.count(),
      prisma.auditLog.count(),
    ]);
    expect(userCountBefore).toBeGreaterThan(0);
    expect(appCountBefore).toBeGreaterThan(0);
    expect(auditCountBefore).toBeGreaterThan(0);

    // 2. 模擬「下一個測試檔」的 root beforeAll：直接呼叫 setup-file.ts 真正
    //    註冊執行的同一個 truncateWorkerSchema()。
    await truncateWorkerSchema(prisma);

    // 3. AC-10/AC-12 核心斷言：三張表（連同其餘業務表）皆歸零，證明結構性
    //    自癒——不因 FK 依賴而部分失敗或需要特定清空順序。
    const [userCountAfter, appCountAfter, auditCountAfter] = await Promise.all([
      prisma.user.count(),
      prisma.application.count(),
      prisma.auditLog.count(),
    ]);
    expect(userCountAfter).toBe(0);
    expect(appCountAfter).toBe(0);
    expect(auditCountAfter).toBe(0);

    // 4. 「FK 依賴的插入不會爆」：TRUNCATE ... CASCADE 必須真的清空了所有
    //    referencing 表，否則重建同一組 FK 鏈會因孤兒外鍵或唯一鍵殘留而失敗。
    const freshUser = await prisma.user.create({
      data: {
        loginName: "infra001_residue_selfheal_fresh_user",
        displayName: "INFRA-001 AC-12 自癒後新資料",
        passwordHash: "infra001-synthetic-not-a-real-hash",
        role: "USER",
      },
    });
    const freshApp = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: freshUser.id,
        createdById: freshUser.id,
        primaryDate: new Date("2031-01-02"),
      },
    });
    await prisma.auditLog.create({
      data: {
        action: "USER_CREATED",
        actorId: freshUser.id,
        targetId: freshUser.id,
        targetLabel: freshUser.loginName,
      },
    });

    expect(freshApp.ownerId).toBe(freshUser.id);
  });
});
