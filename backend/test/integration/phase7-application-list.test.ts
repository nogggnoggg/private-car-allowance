/**
 * Integration tests for PHASE-007-T12:
 *   綜合列表之折舊列映射＋類型/期間篩選（AC-36/37）。
 *
 * TDD: exercises the real HTTP route `GET /applications` (already wired by
 * PHASE-004-T9, extended for MAINTENANCE by PHASE-006-T10) after adding
 * depreciation-row support to `application-query.ts`. Before this Task's
 * change, depreciation rows always had `title=null`.
 *
 * AC covered (PHASE-007 Spec §2):
 *   AC-36（三型混合全序排序、折舊列 type/status/title 映射、不適用欄位
 *   null；title＝§16 D2 裁定形式：「年度折舊 YYYY」／年度 null 時
 *   「年度折舊（未指定年度）」）
 *   AC-37（type=DEPRECIATION 篩選、日期區間含當日邊界、keyword 天然不匹配
 *   折舊列——同型 D9 已知限制之延伸）
 *
 * FW（Task Context Packet）:
 *   - T11 即審 FW-1：混合全序測試必須含一列 applicationYear=null 之折舊列
 *     （primaryDate=建立日）。
 *   - T11 即審 FW-2：onBehalf 用 DTO 既有欄位，本檔不重算，僅斷言既有欄位
 *     值符合 createdById!==ownerId 之既有語意。
 *   - T10/T8 即審 FW：列表路徑不呼叫 buildDepreciationApplicationDto，僅走
 *     application-query.ts 既有列表路徑（本檔以直接 prisma 造列，不經由
 *     折舊草稿端點，天然不會誤用該 builder）。
 *   - 年度資源：另起 2130+（2040-2125 已佔用，見
 *     phase7-snapshot-immutability.test.ts 檔頭配置表）。
 *
 * Test discipline (Spec §11.0 / Packet，沿 phase6-application-list.test.ts
 * 同型):
 *   - loginName prefix "p7t12_" + per-run random suffix。
 *   - EVERY test group uses its own dedicated owner user(s)；無全域/全表
 *     count 斷言。
 *   - cleanup scoped to this suite's own tracked application ids + loginName
 *     prefix；絕不 deleteMany({}) 全域。
 *   - synthetic data only。
 *   - Application/DepreciationApplication rows created DIRECTLY via prisma
 *     (not through the depreciation-draft HTTP endpoints) so
 *     `primaryDate`/`createdAt`/`status`/`applicationYear` can be fully
 *     controlled，且天然不觸碰 buildDepreciationApplicationDto。
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

function buildQuery(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) usp.set(key, String(value));
  }
  const qs = usp.toString();
  return qs.length > 0 ? `/applications?${qs}` : "/applications";
}

interface ListItem {
  id: string;
  type: string;
  status: string;
  primaryDate: string;
  tripDate: string | null;
  title: string | null;
  totalKm: string | null;
  totalAmount: number | null;
  segmentCount: number | null;
  ownerId: string;
  ownerDisplayName: string;
  onBehalf: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ListResponse {
  items: ListItem[];
  page: number;
  pageSize: number;
  total: number;
  appliedFilters: {
    dateFrom: string | null;
    dateTo: string | null;
    type: string | null;
    status: string | null;
    keyword: string | null;
    ownerId: string;
  };
}

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p7t12_";
const PASSWORD = "P7T12ListTest99!";

describeWithDb("PHASE-007-T12 — GET /applications 折舊列映射與篩選", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let mixedOwnerId: string;
  let mixedOwnerCookie: string;
  let filterOwnerId: string;
  let filterOwnerCookie: string;
  let adminId: string;
  let adminCookie: string;
  let onBehalfCreatedById: string;

  const createdApplicationIds: string[] = [];
  function track(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  async function createUser(loginSuffix: string, opts: Partial<{ role: "USER" | "ADMIN" }> = {}) {
    const hash = await hashPassword(PASSWORD);
    return prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}${loginSuffix}_${RUN_ID}`,
        displayName: `P7T12 ${loginSuffix}`,
        passwordHash: hash,
        role: opts.role ?? "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
  }

  /** 直接建立差旅 Application（含子表），供混合排序情境使用。 */
  async function createTravelApp(opts: {
    ownerId: string;
    primaryDate: string;
    createdAt?: Date;
    purpose?: string | null;
    status?: "DRAFT" | "COMPLETED" | "VOIDED";
  }) {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: opts.status ?? "DRAFT",
        ownerId: opts.ownerId,
        createdById: opts.ownerId,
        primaryDate: new Date(opts.primaryDate),
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        travel: { create: { purpose: opts.purpose ?? null } },
      },
    });
    track(application.id);
    return application;
  }

  /** 直接建立折舊 Application（含 DepreciationApplication 子表），完整控制
   * `primaryDate`/`createdAt`/`applicationYear`/status，供 AC-36/37 情境
   * 使用；刻意不經由折舊草稿端點，天然不呼叫 buildDepreciationApplicationDto
   * （T10/T8 即審 FW）。 */
  async function createDepreciationApp(opts: {
    ownerId: string;
    createdById?: string;
    primaryDate: string;
    createdAt?: Date;
    applicationYear?: number | null;
    status?: "DRAFT" | "COMPLETED" | "VOIDED";
    totalAmount?: number | null;
  }) {
    const application = await prisma.application.create({
      data: {
        type: "DEPRECIATION",
        status: opts.status ?? "DRAFT",
        ownerId: opts.ownerId,
        createdById: opts.createdById ?? opts.ownerId,
        primaryDate: new Date(opts.primaryDate),
        totalAmount: opts.totalAmount ?? null,
        completedAt: opts.status === "COMPLETED" ? new Date() : null,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        depreciation: {
          create: {
            applicationYear: opts.applicationYear === undefined ? null : opts.applicationYear,
          },
        },
      },
    });
    track(application.id);
    return application;
  }

  async function getList(cookie: string, params: Record<string, string | number | undefined> = {}) {
    return app.inject({ method: "GET", url: buildQuery(params), headers: { cookie } });
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const mixedOwner = await createUser("mixed");
    const filterOwner = await createUser("filter");
    const admin = await createUser("admin", { role: "ADMIN" });

    mixedOwnerId = mixedOwner.id;
    filterOwnerId = filterOwner.id;
    adminId = admin.id;
    onBehalfCreatedById = admin.id;

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    mixedOwnerCookie = await loginUser(app, mixedOwner.loginName, PASSWORD);
    filterOwnerCookie = await loginUser(app, filterOwner.loginName, PASSWORD);
    adminCookie = await loginUser(app, admin.loginName, PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      if (createdApplicationIds.length > 0) {
        await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
      }
      const userIds = [mixedOwnerId, filterOwnerId, adminId].filter(Boolean);
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
  // AC-36：混合全序排序 + 折舊列映射
  // ===========================================================================

  describe("AC-36 綜合列表", () => {
    it("depreciation, maintenance-shaped travel, and travel rows are interleaved in primaryDate DESC, createdAt DESC, id DESC order — including a null-year depreciation row", async () => {
      // 鑑別力設計：三筆共用「相同 primaryDate、相同 createdAt」，逼迫 id
      // DESC 才能決定順序（比照 PHASE-006 AC-32 同型手法）；另有一筆不同
      // primaryDate 之折舊列驗證跨類型的 primaryDate DESC 排序。
      // FW-1：其中一筆折舊列 applicationYear=null，primaryDate=建立日
      // （沿 §16 D2 null fallback 語意），確保全序穩定性不只在有年度樣本上
      // 被驗證。
      const sameDate = "2130-01-15";
      const sameCreatedAt = new Date("2130-01-15T09:00:00.000Z");

      const laterDepreciation = await createDepreciationApp({
        ownerId: mixedOwnerId,
        primaryDate: "2130-02-01",
        applicationYear: 2129,
      });
      const travelA = await createTravelApp({
        ownerId: mixedOwnerId,
        primaryDate: sameDate,
        createdAt: sameCreatedAt,
        purpose: "P7T12 混合排序差旅A",
      });
      const depreciationNullYear = await createDepreciationApp({
        ownerId: mixedOwnerId,
        primaryDate: sameDate,
        createdAt: sameCreatedAt,
        applicationYear: null,
      });
      const depreciationB = await createDepreciationApp({
        ownerId: mixedOwnerId,
        primaryDate: sameDate,
        createdAt: sameCreatedAt,
        applicationYear: 2130,
      });

      const resp = await getList(mixedOwnerCookie, {
        dateFrom: "2130-01-01",
        dateTo: "2130-02-28",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();

      const relevantIds = new Set([
        laterDepreciation.id,
        travelA.id,
        depreciationNullYear.id,
        depreciationB.id,
      ]);
      const ordered = body.items.filter((i) => relevantIds.has(i.id)).map((i) => i.id);

      const sameKeyIds = [travelA.id, depreciationNullYear.id, depreciationB.id].sort((a, b) =>
        a < b ? 1 : a > b ? -1 : 0
      );
      expect(ordered).toEqual([laterDepreciation.id, ...sameKeyIds]);

      // FW-1 附帶斷言：null-year 折舊列的 title 走「未指定年度」分支。
      const nullYearItem = body.items.find((i) => i.id === depreciationNullYear.id);
      expect(nullYearItem?.title).toBe("年度折舊（未指定年度）");
    });

    it("depreciation rows carry type=DEPRECIATION and the correct status", async () => {
      const draft = await createDepreciationApp({
        ownerId: mixedOwnerId,
        primaryDate: "2130-03-01",
        applicationYear: 2130,
        status: "DRAFT",
      });
      const completed = await createDepreciationApp({
        ownerId: mixedOwnerId,
        primaryDate: "2130-03-02",
        applicationYear: 2130,
        status: "COMPLETED",
        totalAmount: 5678,
      });

      const resp = await getList(mixedOwnerCookie, {
        type: "DEPRECIATION",
        dateFrom: "2130-03-01",
        dateTo: "2130-03-02",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();

      const draftItem = body.items.find((i) => i.id === draft.id);
      const completedItem = body.items.find((i) => i.id === completed.id);
      expect(draftItem).toBeDefined();
      expect(completedItem).toBeDefined();
      expect(draftItem?.type).toBe("DEPRECIATION");
      expect(draftItem?.status).toBe("DRAFT");
      expect(completedItem?.type).toBe("DEPRECIATION");
      expect(completedItem?.status).toBe("COMPLETED");
      expect(completedItem?.totalAmount).toBe(5678);
      expect(draftItem?.totalAmount).toBeNull();
    });

    it("title carries '年度折舊 YYYY' when applicationYear is set", async () => {
      const app1 = await createDepreciationApp({
        ownerId: mixedOwnerId,
        primaryDate: "2130-04-01",
        applicationYear: 2130,
      });

      const resp = await getList(mixedOwnerCookie, {
        type: "DEPRECIATION",
        dateFrom: "2130-04-01",
        dateTo: "2130-04-01",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      const item = body.items.find((i) => i.id === app1.id);
      expect(item).toBeDefined();
      expect(item?.title).toBe("年度折舊 2130");
    });

    it("fields not applicable to depreciation are null (rendered as — by the frontend)", async () => {
      const app1 = await createDepreciationApp({
        ownerId: mixedOwnerId,
        primaryDate: "2130-04-02",
        applicationYear: 2130,
      });

      const resp = await getList(mixedOwnerCookie, {
        type: "DEPRECIATION",
        dateFrom: "2130-04-02",
        dateTo: "2130-04-02",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      const item = body.items.find((i) => i.id === app1.id);
      expect(item).toBeDefined();
      expect(item?.totalKm).toBeNull();
      expect(item?.segmentCount).toBeNull();
      expect(item?.tripDate).toBeNull();
    });

    it("onBehalf uses the existing createdById!==ownerId derivation (FW-2: not recomputed by the list layer)", async () => {
      const app1 = await createDepreciationApp({
        ownerId: mixedOwnerId,
        createdById: onBehalfCreatedById,
        primaryDate: "2130-04-03",
        applicationYear: 2130,
      });

      const resp = await getList(mixedOwnerCookie, {
        type: "DEPRECIATION",
        dateFrom: "2130-04-03",
        dateTo: "2130-04-03",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      const item = body.items.find((i) => i.id === app1.id);
      expect(item).toBeDefined();
      expect(item?.onBehalf).toBe(true);
    });
  });

  // ===========================================================================
  // AC-37：類型與期間篩選
  // ===========================================================================

  describe("AC-37 篩選", () => {
    beforeAll(async () => {
      await createTravelApp({
        ownerId: filterOwnerId,
        primaryDate: "2130-06-15",
        purpose: "P7T12 篩選用差旅",
      });
      await createDepreciationApp({
        ownerId: filterOwnerId,
        primaryDate: "2130-06-15",
        applicationYear: 2130,
      });
    });

    it("type=DEPRECIATION returns only depreciation rows", async () => {
      const resp = await getList(filterOwnerCookie, {
        type: "DEPRECIATION",
        dateFrom: "2130-06-01",
        dateTo: "2130-06-30",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) {
        expect(item.type).toBe("DEPRECIATION");
      }
    });

    it("primaryDate drives the date-range filter (inclusive on both ends)", async () => {
      const boundaryDate = "2130-07-20";
      const boundaryApp = await createDepreciationApp({
        ownerId: filterOwnerId,
        primaryDate: boundaryDate,
        applicationYear: 2130,
      });

      const includeResp = await getList(filterOwnerCookie, {
        type: "DEPRECIATION",
        dateFrom: boundaryDate,
        dateTo: boundaryDate,
      });
      expect(includeResp.statusCode).toBe(200);
      expect(includeResp.json<ListResponse>().items.some((i) => i.id === boundaryApp.id)).toBe(
        true
      );

      const excludeBeforeResp = await getList(filterOwnerCookie, {
        type: "DEPRECIATION",
        dateFrom: "2130-06-01",
        dateTo: "2130-07-19", // 迄日前一日 → 排除
      });
      expect(excludeBeforeResp.statusCode).toBe(200);
      expect(
        excludeBeforeResp.json<ListResponse>().items.some((i) => i.id === boundaryApp.id)
      ).toBe(false);

      const excludeAfterResp = await getList(filterOwnerCookie, {
        type: "DEPRECIATION",
        dateFrom: "2130-07-21", // 起日次日 → 排除
        dateTo: "2130-08-01",
      });
      expect(excludeAfterResp.statusCode).toBe(200);
      expect(excludeAfterResp.json<ListResponse>().items.some((i) => i.id === boundaryApp.id)).toBe(
        false
      );
    });

    it("admin can filter by ownerId to see only that user's depreciation rows", async () => {
      const resp = await getList(adminCookie, {
        type: "DEPRECIATION",
        ownerId: filterOwnerId,
        dateFrom: "2130-06-01",
        dateTo: "2130-06-30",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) {
        expect(item.ownerId).toBe(filterOwnerId);
        expect(item.type).toBe("DEPRECIATION");
      }
    });

    it("AC-37 known limitation: keyword filtering never matches depreciation rows (no searchable text column)", async () => {
      const resp = await getList(filterOwnerCookie, {
        type: "DEPRECIATION",
        keyword: "折舊",
        dateFrom: "2130-06-01",
        dateTo: "2130-06-30",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items).toEqual([]);
    });
  });
});
