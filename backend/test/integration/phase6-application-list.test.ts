/**
 * Integration tests for PHASE-006-T10:
 *   綜合列表之保養列映射＋類型/期間篩選（AC-32/33）。
 *
 * TDD: exercises the real HTTP route `GET /applications` (already wired by
 * PHASE-004-T9) after adding maintenance-row support to
 * `application-query.ts`. Before this Task's change, maintenance rows always
 * had `title=null` (D9(a) not yet applied) and the array-query-key guards
 * below did not exist for `keyword`/`ownerId` on this endpoint.
 *
 * AC covered (PHASE-006 Spec §2):
 *   AC-32（混合全序排序、保養列 type/status/title 映射、不適用欄位 null、
 *   DRAFT 保養未填日期時 primaryDate 回退建立日期）
 *   AC-33（type=MAINTENANCE 篩選、日期區間含當日邊界、管理員 ownerId、
 *   一般使用者帶他人 403、keyword 不匹配保養——D9 已知限制之現狀釘住）
 *   B-11/B-35 同型（陣列 query 鍵 400 不 500，沿 PHASE-005 T6-AR-1 之既有收斂）
 *
 * Test discipline (Spec §11.0 / Packet):
 *   - loginName prefix "p6t10_" + per-run random suffix.
 *   - EVERY test group uses its own dedicated owner user(s); no global/table
 *     -wide count assertions (residual rows from other suites must not
 *     affect any assertion here — same discipline as
 *     phase4-application-query.test.ts).
 *   - cleanup scoped to this suite's own tracked application ids + loginName
 *     prefix; NEVER deleteMany({}) globally.
 *   - synthetic data only.
 *   - Application/MaintenanceApplication rows created DIRECTLY via prisma
 *     (not through the maintenance-draft HTTP endpoints) so
 *     `primaryDate`/`createdAt`/`status`/dates can be fully controlled.
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

/** 手刻重複鍵 query string（`URLSearchParams`/`buildQuery` 無法表達同名鍵重複，比照
 * phase5-mileage-contract.test.ts `buildUrlWithDuplicateKey` 之既有慣例）。 */
function buildQueryWithDuplicateKey(
  baseParams: Record<string, string>,
  dupKey: string,
  dupValues: [string, string]
): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(baseParams)) {
    if (key === dupKey) continue;
    usp.set(key, value);
  }
  usp.append(dupKey, dupValues[0]);
  usp.append(dupKey, dupValues[1]);
  return `/applications?${usp.toString()}`;
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

interface ErrorBody {
  error: { code: string; fields?: { field: string }[] };
}

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p6t10_";
const PASSWORD = "P6T10ListTest99!";

describeWithDb("PHASE-006-T10 — GET /applications 保養列映射與篩選", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let mixedOwnerId: string;
  let mixedOwnerCookie: string;
  let filterOwnerId: string;
  let filterOwnerCookie: string;
  let otherId: string;
  let adminId: string;
  let adminCookie: string;

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
        displayName: `P6T10 ${loginSuffix}`,
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

  /** 直接建立保養 Application（含 MaintenanceApplication 子表），完整控制
   * `primaryDate`/`createdAt`/兩個保養日期/status，供 AC-32/33 情境使用。 */
  async function createMaintenanceApp(opts: {
    ownerId: string;
    primaryDate: string;
    createdAt?: Date;
    lastMaintenanceDate?: string | null;
    currentMaintenanceDate?: string | null;
    status?: "DRAFT" | "COMPLETED" | "VOIDED";
    totalAmount?: number | null;
  }) {
    const application = await prisma.application.create({
      data: {
        type: "MAINTENANCE",
        status: opts.status ?? "DRAFT",
        ownerId: opts.ownerId,
        createdById: opts.ownerId,
        primaryDate: new Date(opts.primaryDate),
        totalAmount: opts.totalAmount ?? null,
        completedAt: opts.status === "COMPLETED" ? new Date() : null,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        maintenance: {
          create: {
            lastMaintenanceDate:
              opts.lastMaintenanceDate !== undefined && opts.lastMaintenanceDate !== null
                ? new Date(opts.lastMaintenanceDate)
                : null,
            currentMaintenanceDate:
              opts.currentMaintenanceDate !== undefined && opts.currentMaintenanceDate !== null
                ? new Date(opts.currentMaintenanceDate)
                : null,
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
    const other = await createUser("other");
    const admin = await createUser("admin", { role: "ADMIN" });

    mixedOwnerId = mixedOwner.id;
    filterOwnerId = filterOwner.id;
    otherId = other.id;
    adminId = admin.id;

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
      const userIds = [mixedOwnerId, filterOwnerId, otherId, adminId].filter(Boolean);
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
  // AC-32：混合全序排序 + 保養列映射
  // ===========================================================================

  describe("AC-32 綜合列表", () => {
    it("maintenance and travel rows are interleaved in primaryDate DESC, createdAt DESC, id DESC order", async () => {
      // 鑑別力設計：兩筆差旅、兩筆保養共用「相同 primaryDate、相同
      // createdAt」，逼迫 id DESC 才能決定順序（比照 PHASE-004 AC-67 分頁
      // 穩定性測試手法）；另有一筆不同 primaryDate 之保養列驗證跨類型的
      // primaryDate DESC 排序。
      const sameDate = "2027-01-15";
      const sameCreatedAt = new Date("2027-01-15T09:00:00.000Z");

      const laterMaintenance = await createMaintenanceApp({
        ownerId: mixedOwnerId,
        primaryDate: "2027-02-01",
        lastMaintenanceDate: "2027-01-01",
        currentMaintenanceDate: "2027-02-01",
      });
      const travelA = await createTravelApp({
        ownerId: mixedOwnerId,
        primaryDate: sameDate,
        createdAt: sameCreatedAt,
        purpose: "P6T10 混合排序差旅A",
      });
      const maintenanceA = await createMaintenanceApp({
        ownerId: mixedOwnerId,
        primaryDate: sameDate,
        createdAt: sameCreatedAt,
        lastMaintenanceDate: "2026-12-01",
        currentMaintenanceDate: sameDate,
      });
      const travelB = await createTravelApp({
        ownerId: mixedOwnerId,
        primaryDate: sameDate,
        createdAt: sameCreatedAt,
        purpose: "P6T10 混合排序差旅B",
      });

      const resp = await getList(mixedOwnerCookie, {
        dateFrom: "2027-01-01",
        dateTo: "2027-02-28",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();

      const relevantIds = new Set([laterMaintenance.id, travelA.id, maintenanceA.id, travelB.id]);
      const ordered = body.items.filter((i) => relevantIds.has(i.id)).map((i) => i.id);

      // 全域全序中，較新 primaryDate（2027-02-01）恆排在前；同 primaryDate/
      // createdAt 三筆之相對順序須恰好等於 id DESC（字串比較）。
      const sameKeyIds = [travelA.id, maintenanceA.id, travelB.id].sort((a, b) =>
        a < b ? 1 : a > b ? -1 : 0
      );
      expect(ordered).toEqual([laterMaintenance.id, ...sameKeyIds]);
    });

    it("maintenance rows carry type=MAINTENANCE and the correct status", async () => {
      const draft = await createMaintenanceApp({
        ownerId: mixedOwnerId,
        primaryDate: "2027-03-01",
        lastMaintenanceDate: "2027-02-01",
        currentMaintenanceDate: "2027-03-01",
        status: "DRAFT",
      });
      const completed = await createMaintenanceApp({
        ownerId: mixedOwnerId,
        primaryDate: "2027-03-02",
        lastMaintenanceDate: "2027-02-02",
        currentMaintenanceDate: "2027-03-02",
        status: "COMPLETED",
        totalAmount: 1234,
      });

      const resp = await getList(mixedOwnerCookie, {
        type: "MAINTENANCE",
        dateFrom: "2027-03-01",
        dateTo: "2027-03-02",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();

      const draftItem = body.items.find((i) => i.id === draft.id);
      const completedItem = body.items.find((i) => i.id === completed.id);
      expect(draftItem).toBeDefined();
      expect(completedItem).toBeDefined();
      expect(draftItem?.type).toBe("MAINTENANCE");
      expect(draftItem?.status).toBe("DRAFT");
      expect(completedItem?.type).toBe("MAINTENANCE");
      expect(completedItem?.status).toBe("COMPLETED");
      // D9(a)：已完成保養列顯示分攤金額（既有欄位，語意「最終申報金額」）。
      expect(completedItem?.totalAmount).toBe(1234);
      expect(draftItem?.totalAmount).toBeNull();
    });

    it("fields not applicable to maintenance are null (rendered as — by the frontend); title carries the maintenance period", async () => {
      const app1 = await createMaintenanceApp({
        ownerId: mixedOwnerId,
        primaryDate: "2027-04-01",
        lastMaintenanceDate: "2027-03-01",
        currentMaintenanceDate: "2027-04-01",
      });

      const resp = await getList(mixedOwnerCookie, {
        type: "MAINTENANCE",
        dateFrom: "2027-04-01",
        dateTo: "2027-04-01",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      const item = body.items.find((i) => i.id === app1.id);
      expect(item).toBeDefined();
      // D9(a) 已批映射：title = 保養期間字串。
      expect(item?.title).toBe("保養 2027-03-01 ~ 2027-04-01");
      // totalKm/segmentCount 維持 null（D9(a)：語意與差旅不同，混用會誤導）。
      expect(item?.totalKm).toBeNull();
      expect(item?.segmentCount).toBeNull();
      expect(item?.tripDate).toBeNull();
    });

    it("maintenance row missing either date has title=null rather than a half-formed string", async () => {
      const onlyLast = await createMaintenanceApp({
        ownerId: mixedOwnerId,
        primaryDate: "2027-04-05",
        lastMaintenanceDate: "2027-03-05",
        currentMaintenanceDate: null,
      });
      const onlyCurrent = await createMaintenanceApp({
        ownerId: mixedOwnerId,
        primaryDate: "2027-04-06",
        lastMaintenanceDate: null,
        currentMaintenanceDate: "2027-04-06",
      });

      const resp = await getList(mixedOwnerCookie, {
        type: "MAINTENANCE",
        dateFrom: "2027-04-05",
        dateTo: "2027-04-06",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.find((i) => i.id === onlyLast.id)?.title).toBeNull();
      expect(body.items.find((i) => i.id === onlyCurrent.id)?.title).toBeNull();
    });

    it("DRAFT maintenance with no dates filled falls back primaryDate to the creation date (derivePrimaryDate convention)", async () => {
      // 沿 `derivePrimaryDate` 慣例：未填 currentMaintenanceDate 時，Application
      // .primaryDate 於建立當下即回退為建立日期——本測試直接以該回退後的日期
      // 建立資料列（模擬 maintenance-service.ts 之既有既定行為），驗證列表
      // 端讀出的 primaryDate 與 title 皆符合「未填日期」的一致外觀。
      const fallbackCreatedAt = new Date("2027-04-10T03:00:00.000Z");
      const draft = await createMaintenanceApp({
        ownerId: mixedOwnerId,
        primaryDate: "2027-04-10", // == createdAt 的日粒度（derivePrimaryDate 回退值）
        createdAt: fallbackCreatedAt,
        lastMaintenanceDate: null,
        currentMaintenanceDate: null,
      });

      const resp = await getList(mixedOwnerCookie, {
        dateFrom: "2027-04-10",
        dateTo: "2027-04-10",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      const item = body.items.find((i) => i.id === draft.id);
      expect(item).toBeDefined();
      expect(item?.primaryDate).toBe("2027-04-10");
      expect(item?.title).toBeNull();
      expect(item?.status).toBe("DRAFT");
    });
  });

  // ===========================================================================
  // AC-33：類型與期間篩選
  // ===========================================================================

  describe("AC-33 篩選", () => {
    beforeAll(async () => {
      await createTravelApp({
        ownerId: filterOwnerId,
        primaryDate: "2027-06-15",
        purpose: "P6T10 篩選用差旅",
      });
      await createMaintenanceApp({
        ownerId: filterOwnerId,
        primaryDate: "2027-06-15",
        lastMaintenanceDate: "2027-05-15",
        currentMaintenanceDate: "2027-06-15",
      });
    });

    it("type=MAINTENANCE returns only maintenance rows", async () => {
      const resp = await getList(filterOwnerCookie, {
        type: "MAINTENANCE",
        dateFrom: "2027-06-01",
        dateTo: "2027-06-30",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) {
        expect(item.type).toBe("MAINTENANCE");
      }
    });

    it("primaryDate equals the current maintenance date and drives the date-range filter (inclusive on both ends)", async () => {
      const boundaryDate = "2027-07-20";
      const boundaryApp = await createMaintenanceApp({
        ownerId: filterOwnerId,
        primaryDate: boundaryDate,
        lastMaintenanceDate: "2027-06-20",
        currentMaintenanceDate: boundaryDate,
      });

      const includeResp = await getList(filterOwnerCookie, {
        type: "MAINTENANCE",
        dateFrom: boundaryDate,
        dateTo: boundaryDate,
      });
      expect(includeResp.statusCode).toBe(200);
      expect(includeResp.json<ListResponse>().items.some((i) => i.id === boundaryApp.id)).toBe(
        true
      );

      const excludeBeforeResp = await getList(filterOwnerCookie, {
        type: "MAINTENANCE",
        dateFrom: "2027-06-01",
        dateTo: "2027-07-19", // 迄日前一日 → 排除
      });
      expect(excludeBeforeResp.statusCode).toBe(200);
      expect(
        excludeBeforeResp.json<ListResponse>().items.some((i) => i.id === boundaryApp.id)
      ).toBe(false);

      const excludeAfterResp = await getList(filterOwnerCookie, {
        type: "MAINTENANCE",
        dateFrom: "2027-07-21", // 起日次日 → 排除
        dateTo: "2027-08-01",
      });
      expect(excludeAfterResp.statusCode).toBe(200);
      expect(excludeAfterResp.json<ListResponse>().items.some((i) => i.id === boundaryApp.id)).toBe(
        false
      );
    });

    it("admin can filter by ownerId to see only that user's maintenance rows", async () => {
      const resp = await getList(adminCookie, {
        type: "MAINTENANCE",
        ownerId: filterOwnerId,
        dateFrom: "2027-06-01",
        dateTo: "2027-06-30",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) {
        expect(item.ownerId).toBe(filterOwnerId);
        expect(item.type).toBe("MAINTENANCE");
      }
    });

    it("a normal user passing another ownerId gets 403 (never a silent downgrade)", async () => {
      const resp = await getList(filterOwnerCookie, {
        type: "MAINTENANCE",
        ownerId: adminId,
      });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<ErrorBody>();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("D9 known limitation: keyword filtering never matches maintenance rows (only TravelApplication.purpose is compared)", async () => {
      const resp = await getList(filterOwnerCookie, {
        type: "MAINTENANCE",
        keyword: "保養",
        dateFrom: "2027-06-01",
        dateTo: "2027-06-30",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items).toEqual([]);
    });
  });

  // ===========================================================================
  // B-11/B-35 同型：陣列 query 鍵 → 400（非 500）
  // ===========================================================================

  describe("B-11／B-35 陣列型／重複 query 鍵 → 400 VALIDATION_ERROR，絕不 500", () => {
    it("duplicate ownerId key as ADMIN → 400 (not 500)", async () => {
      const url = buildQueryWithDuplicateKey({ type: "MAINTENANCE" }, "ownerId", [
        filterOwnerId,
        mixedOwnerId,
      ]);
      const resp = await app.inject({ method: "GET", url, headers: { cookie: adminCookie } });
      expect(resp.statusCode).toBe(400);
      expect(resp.statusCode).not.toBe(500);
      const body = resp.json<ErrorBody>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "ownerId" })])
      );
    });

    it("duplicate ownerId key as USER → 400 (not a silent 403/200), never 500", async () => {
      const url = buildQueryWithDuplicateKey({ type: "MAINTENANCE" }, "ownerId", [
        filterOwnerId,
        adminId,
      ]);
      const resp = await app.inject({
        method: "GET",
        url,
        headers: { cookie: filterOwnerCookie },
      });
      expect(resp.statusCode).toBe(400);
      expect(resp.statusCode).not.toBe(500);
      expect(resp.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");
    });

    it("duplicate keyword key → 400 with fields[].field === 'keyword', never 500", async () => {
      const url = buildQueryWithDuplicateKey({ type: "MAINTENANCE" }, "keyword", ["保養", "維修"]);
      const resp = await app.inject({
        method: "GET",
        url,
        headers: { cookie: filterOwnerCookie },
      });
      expect(resp.statusCode).toBe(400);
      expect(resp.statusCode).not.toBe(500);
      const body = resp.json<ErrorBody>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "keyword" })])
      );
    });
  });
});
