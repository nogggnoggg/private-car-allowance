/**
 * Integration tests for PHASE-007-T5:
 *   年度語意——`Application.primaryDate` 推導（AC-06）、`duplicateYearNotice`
 *   重複申請提示（AC-07）、無 DB 唯一約束之等效檢查（AC-08）。
 *
 * TDD：`duplicateYearNotice` 於 T4 現況恆回 `null`（見
 * `depreciation-service.ts` `toDepreciationApplicationDto` 之 T5 留白註解），
 * 故本檔首輪為 RED（AC-07 相關斷言：期待非 null 卻收到 null）。首輪 RED 輸出
 * 見 Task Handoff。
 *
 * AC covered（PHASE-007 Spec §2）：AC-06、AC-07、AC-08。
 *
 * 刻意不在本檔覆蓋（後續 Task 之範圍，見 Spec §15）：
 *   - AC-08 逐字之「兩筆皆可完成（皆 200）」——完成流程屬 T9（本檔尚無可呼叫
 *     的 DEPRECIATION 完成端點）；本檔只覆蓋「不設 DB 唯一約束、連續建立兩筆
 *     同年度申請皆 201（不得 409）」之可測部分，該部分即為本 AC 於 T5 範圍
 *     內之全部字面要求（§15 T5 列 Done When 未提及完成）。
 *
 * Test discipline（Spec §11.0 / Packet）：
 *   - loginName prefix "p7t5_" ＋ per-run random suffix；
 *   - 清理僅限本套件自行追蹤之 id 與 loginName 前綴，絕不 deleteMany({})；
 *   - 全程合成資料。
 */
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0];
}

async function loginUser(
  app: FastifyInstance,
  loginName: string,
  password: string
): Promise<string> {
  const resp = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { loginName, password },
  });
  if (resp.statusCode !== 200) {
    throw new Error(`Login failed for ${loginName}: ${resp.statusCode} ${resp.body}`);
  }
  return extractCookieHeader(resp.headers["set-cookie"]);
}

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p7t5_";
const PASSWORD = "DepreciationYearTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;

describeWithDb("PHASE-007-T5 — 年度語意：primaryDate 推導 ＋ 重複提示 ＋ 無唯一約束", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let otherId: string;

  let ownerCookie: string;
  let otherCookie: string;

  const createdApplicationIds: string[] = [];

  function track(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  async function createDraft(cookie: string, payload: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/applications/depreciation",
      headers: { cookie },
      payload,
    });
  }

  async function createOwnerDraft(
    payload: Record<string, unknown> = {},
    cookie: string = ownerCookie
  ) {
    const resp = await createDraft(cookie, payload);
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ application: Record<string, unknown> & { id: string } }>();
    track(body.application.id);
    return body.application;
  }

  async function putDraft(cookie: string, id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/applications/depreciation/${id}`,
      headers: { cookie },
      payload,
    });
  }

  async function getDraft(cookie: string, id: string) {
    return app.inject({
      method: "GET",
      url: `/applications/depreciation/${id}`,
      headers: { cookie },
    });
  }

  /** 直接以 Prisma 把狀態撥為 COMPLETED（不經完成流程——完成流程屬 T9）。 */
  async function markCompleted(applicationId: string) {
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: "COMPLETED", completedAt: new Date(), totalAmount: 5000 },
    });
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);

    const owner = await prisma.user.create({
      data: {
        loginName: OWNER_LOGIN,
        displayName: "P7T5 擁有人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const other = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "P7T5 他人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });

    ownerId = owner.id;
    otherId = other.id;

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    ownerCookie = await loginUser(app, OWNER_LOGIN, PASSWORD);
    otherCookie = await loginUser(app, OTHER_LOGIN, PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      if (createdApplicationIds.length > 0) {
        await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
      }
      const userIds = [ownerId, otherId].filter(Boolean);
      if (userIds.length > 0) {
        await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.auditLog.deleteMany({
          where: { OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }] },
        });
      }
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
  });

  // ===========================================================================
  // AC-06 — primaryDate 推導
  // ===========================================================================

  describe("AC-06: primaryDate is derived from applicationYear (YYYY-12-31) and falls back to the creation date when the year is null", () => {
    it("applicationYear 有值（建立）→ primaryDate ＝ 該年 12-31", async () => {
      const application = await createOwnerDraft({ applicationYear: 2023 });
      expect(application.applicationYear).toBe(2023);
      expect(application.primaryDate).toBe("2023-12-31");
    });

    it("applicationYear 為 null（建立，缺省 body）→ primaryDate ＝ 建立當日", async () => {
      const before = new Date();
      const application = await createOwnerDraft({});
      expect(application.applicationYear).toBeNull();
      const expected = before.toISOString().slice(0, 10);
      expect(application.primaryDate).toBe(expected);
    });

    it("applicationYear 邊界值 1900／2999（建立）→ primaryDate ＝ 對應年 12-31", async () => {
      const min = await createOwnerDraft({ applicationYear: 1900 });
      expect(min.primaryDate).toBe("1900-12-31");

      const max = await createOwnerDraft({ applicationYear: 2999 });
      expect(max.primaryDate).toBe("2999-12-31");
    });

    it("PUT 更新年度（null → 有值）→ primaryDate 同步更新為該年 12-31（同一交易）", async () => {
      const application = await createOwnerDraft({});
      expect(application.primaryDate).not.toBe("2030-12-31");

      const resp = await putDraft(ownerCookie, application.id as string, {
        applicationYear: 2030,
      });
      expect(resp.statusCode).toBe(200);
      const updated = resp.json<{ application: Record<string, unknown> }>().application;
      expect(updated.applicationYear).toBe(2030);
      expect(updated.primaryDate).toBe("2030-12-31");
    });

    it("PUT 更新年度（有值 → null）→ primaryDate 回退為建立當日", async () => {
      const application = await createOwnerDraft({ applicationYear: 2028 });
      expect(application.primaryDate).toBe("2028-12-31");

      const before = new Date();
      const resp = await putDraft(ownerCookie, application.id as string, {
        applicationYear: null,
      });
      expect(resp.statusCode).toBe(200);
      const updated = resp.json<{ application: Record<string, unknown> }>().application;
      expect(updated.applicationYear).toBeNull();
      const expected = before.toISOString().slice(0, 10);
      expect(updated.primaryDate).toBe(expected);
    });

    it("年度為 null 之草稿：GET 全路徑不 500，primaryDate 為有效日期字串", async () => {
      const application = await createOwnerDraft({});
      const resp = await getDraft(ownerCookie, application.id as string);
      expect(resp.statusCode).toBe(200);
      const fetched = resp.json<{ application: Record<string, unknown> }>().application;
      expect(fetched.primaryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  // ===========================================================================
  // AC-07 — duplicateYearNotice
  // ===========================================================================

  describe("AC-07: duplicateYearNotice counts same-owner same-year applications excluding self, and is null when applicationYear is null", () => {
    it("applicationYear 為 null（建立）→ duplicateYearNotice 為 null", async () => {
      const application = await createOwnerDraft({});
      expect(application.duplicateYearNotice).toBeNull();
    });

    it("無其他同年度申請 → duplicateYearNotice ＝ { count: 0, hasCompleted: false }（非 null、非缺鍵）", async () => {
      const application = await createOwnerDraft({ applicationYear: 2021 });
      expect(application.duplicateYearNotice).not.toBeNull();
      expect(application).toHaveProperty("duplicateYearNotice");
      expect(application.duplicateYearNotice).toEqual({ count: 0, hasCompleted: false });
    });

    it("排除自身：單筆同年度申請之 GET 回應中不把自己算進 count", async () => {
      const application = await createOwnerDraft({ applicationYear: 2022 });
      const resp = await getDraft(ownerCookie, application.id as string);
      const fetched = resp.json<{ application: Record<string, unknown> }>().application;
      expect(fetched.duplicateYearNotice).toEqual({ count: 0, hasCompleted: false });
    });

    it("同 owner 同年度：1 筆 DRAFT + 1 筆 COMPLETED（排除自身）→ count=2, hasCompleted=true（B-15 同型，簡化為 2 筆對照）", async () => {
      const first = await createOwnerDraft({ applicationYear: 2019 });
      const second = await createOwnerDraft({ applicationYear: 2019 });
      await markCompleted(second.id as string);

      const respFirst = await getDraft(ownerCookie, first.id as string);
      const fetchedFirst = respFirst.json<{ application: Record<string, unknown> }>().application;
      // 排除自身（first），只看到 second（COMPLETED）。
      expect(fetchedFirst.duplicateYearNotice).toEqual({ count: 1, hasCompleted: true });
    });

    it("B-15：同年度已有 1 筆 COMPLETED ＋ 2 筆 DRAFT（含自身）→ 從第三筆視角 count=2, hasCompleted=true（排除自身）", async () => {
      const completed = await createOwnerDraft({ applicationYear: 2017 });
      await markCompleted(completed.id as string);
      const draftA = await createOwnerDraft({ applicationYear: 2017 });
      const draftB = await createOwnerDraft({ applicationYear: 2017 });

      const resp = await getDraft(ownerCookie, draftB.id as string);
      const fetched = resp.json<{ application: Record<string, unknown> }>().application;
      expect(fetched.duplicateYearNotice).toEqual({ count: 2, hasCompleted: true });
    });

    it("不同 owner 同年度不互相計入", async () => {
      const ownerApp = await createOwnerDraft({ applicationYear: 2016 });
      await createOwnerDraft({ applicationYear: 2016 }, otherCookie);

      const resp = await getDraft(ownerCookie, ownerApp.id as string);
      const fetched = resp.json<{ application: Record<string, unknown> }>().application;
      expect(fetched.duplicateYearNotice).toEqual({ count: 0, hasCompleted: false });
    });

    it("不同年度不互相計入", async () => {
      const app2014 = await createOwnerDraft({ applicationYear: 2014 });
      await createOwnerDraft({ applicationYear: 2015 });

      const resp = await getDraft(ownerCookie, app2014.id as string);
      const fetched = resp.json<{ application: Record<string, unknown> }>().application;
      expect(fetched.duplicateYearNotice).toEqual({ count: 0, hasCompleted: false });
    });

    it("PUT 把年度從 null 改為有值 → 回應之 duplicateYearNotice 隨新年度即時反映（非殘留 null）", async () => {
      const other = await createOwnerDraft({ applicationYear: 2013 });
      const application = await createOwnerDraft({});
      expect(application.duplicateYearNotice).toBeNull();

      const resp = await putDraft(ownerCookie, application.id as string, {
        applicationYear: 2013,
      });
      expect(resp.statusCode).toBe(200);
      const updated = resp.json<{ application: Record<string, unknown> }>().application;
      expect(updated.duplicateYearNotice).toEqual({ count: 1, hasCompleted: false });
      expect(other.applicationYear).toBe(2013);
    });
  });

  // ===========================================================================
  // AC-08 — 無 DB 唯一約束
  // ===========================================================================

  describe("AC-08: two applications for the same owner and year are both created (201) and both can be completed — no uniqueness constraint", () => {
    it("連續建立兩筆同 owner 同年度申請皆 201（不得 409），且為相異列", async () => {
      const first = await createDraft(ownerCookie, { applicationYear: 2011 });
      expect(first.statusCode).toBe(201);
      const firstBody = first.json<{ application: Record<string, unknown> & { id: string } }>()
        .application;
      track(firstBody.id);

      const second = await createDraft(ownerCookie, { applicationYear: 2011 });
      expect(second.statusCode).toBe(201);
      const secondBody = second.json<{ application: Record<string, unknown> & { id: string } }>()
        .application;
      track(secondBody.id);

      expect(firstBody.id).not.toBe(secondBody.id);
    });

    it("突變自證：`@@unique([ownerId, applicationYear])` 之等效條件檢查——同 owner 同年度於 DB 上確實並存 2 筆非作廢列（若日後施加唯一約束，第二筆 create 即失敗，本斷言必轉紅）", async () => {
      const ownerRows = await createOwnerDraft({ applicationYear: 2010 });
      await createOwnerDraft({ applicationYear: 2010 });

      const rows = await prisma.depreciationApplication.findMany({
        where: {
          applicationYear: 2010,
          application: { ownerId, status: { not: "VOIDED" } },
        },
      });
      // 等效於「(ownerId, applicationYear) 唯一」之反例：must find >= 2 rows.
      // 若該唯一約束確實存在，上面第二次 createOwnerDraft 呼叫本身就會先失敗
      // （P2002），本斷言永遠不會被執行到 — 即該 mutant 之等效檢查點。
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(ownerRows.applicationYear).toBe(2010);
    });
  });
});
