/**
 * Integration tests for PHASE-008-T17:
 *   綜合查詢 `keyword` 擴充比對報表編號（AC-38／FE-US-05④）。
 *
 * 規範出處（逐字）：
 *   AC-38（Spec :263）：「綜合查詢之 `keyword` 除既有之差旅出差目的外，另比
 *   對 `Report.reportNumber`（大小寫不敏感、`%`／`_`／`\` 已跳脫）；三型申請
 *   皆可由其報表編號查得；未產生報表之申請不受影響；既有 `keyword` 測試零
 *   改動。」
 *   §15 T17 Done When：「三型皆可由編號查得；既有 `keyword` 測試零改動；
 *   LIKE 萬用字元跳脫沿既有 `escapeLikePattern`」。
 *
 * TDD: exercises the real HTTP route `GET /applications`（PHASE-004-T9 既有
 * 路由，本 Task 僅擴充 `buildApplicationWhere` 的 keyword 條件為 OR）。
 *
 * Test discipline（沿 phase7-application-list.test.ts／phase8-report-
 * generate.test.ts 同型）:
 *   - loginName prefix "p8t17_" + per-run random suffix。
 *   - 本檔專屬 owner user(s)；無全域/全表 count 斷言。
 *   - cleanup scoped to this suite's own tracked application/report ids +
 *     loginName prefix；絕不 deleteMany({}) 全域。
 *   - synthetic data only。
 *   - Application/Report rows created DIRECTLY via prisma（不經由報表產生端
 *     點——本檔僅驗證查詢端 OR 條件，不涉及配號交易本身）。
 *   - `numberPeriod` 使用未被其他測試檔佔用之保留期間 "204509"（見
 *     `grep -rn "numberPeriod:" test/integration/*.test.ts` 已知佔用列表：
 *     phase8-migration-safety.test.ts 用 "203406"；phase8-report-
 *     generate.test.ts 用執行當下真實 YYYYMM），避免 (numberPrefix,
 *     numberPeriod, sequence) 三欄唯一約束與其他檔案的殘留列衝突。
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
}

interface ListResponse {
  items: ListItem[];
  total: number;
}

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p8t17_";
const PASSWORD = "P8T17KeywordTest99!";

// 保留期間（見檔頭說明）——本檔專用，避免與其他檔案的序號空間衝突。
const PERIOD = "204509";
function seq(n: number): string {
  return String(n).padStart(4, "0");
}

describeWithDb("PHASE-008-T17 — GET /applications keyword 擴充比對報表編號（AC-38）", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let ownerCookie: string;
  let otherId: string;
  let otherCookie: string;

  const createdApplicationIds: string[] = [];
  const createdReportIds: string[] = [];
  function track(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  async function createUser(loginSuffix: string) {
    const hash = await hashPassword(PASSWORD);
    return prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}${loginSuffix}_${RUN_ID}`,
        displayName: `P8T17 ${loginSuffix}`,
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
  }

  async function createTravelApp(opts: {
    ownerId: string;
    purpose?: string | null;
    primaryDate?: string;
  }) {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: opts.ownerId,
        createdById: opts.ownerId,
        primaryDate: new Date(opts.primaryDate ?? "2130-01-15"),
        travel: { create: { purpose: opts.purpose ?? null } },
      },
    });
    track(application.id);
    return application;
  }

  async function createMaintenanceApp(opts: { ownerId: string; primaryDate?: string }) {
    const application = await prisma.application.create({
      data: {
        type: "MAINTENANCE",
        status: "DRAFT",
        ownerId: opts.ownerId,
        createdById: opts.ownerId,
        primaryDate: new Date(opts.primaryDate ?? "2130-01-15"),
        maintenance: { create: {} },
      },
    });
    track(application.id);
    return application;
  }

  async function createDepreciationApp(opts: { ownerId: string; primaryDate?: string }) {
    const application = await prisma.application.create({
      data: {
        type: "DEPRECIATION",
        status: "DRAFT",
        ownerId: opts.ownerId,
        createdById: opts.ownerId,
        primaryDate: new Date(opts.primaryDate ?? "2130-01-15"),
        depreciation: { create: { applicationYear: null } },
      },
    });
    track(application.id);
    return application;
  }

  /** 直接建立 Report 列（比照 phase8-report-generate.test.ts AC-04(d) 之
   * dummy-row 手法，繞過配號交易——本檔只驗證查詢端 OR 條件是否命中，不涉及
   * 產生流程本身）。 */
  async function createReport(opts: {
    applicationId: string;
    prefix: "TRV" | "MNT" | "DEP";
    sequence: number;
    generatedById: string;
  }) {
    const reportNumber = `${opts.prefix}-${PERIOD}-${seq(opts.sequence)}`;
    const report = await prisma.report.create({
      data: {
        applicationId: opts.applicationId,
        reportNumber,
        numberPrefix: opts.prefix,
        numberPeriod: PERIOD,
        sequence: opts.sequence,
        storageKey: `rpt/p8t17-${opts.prefix}-${opts.sequence}-${RUN_ID}/pdf`,
        fileName: `${reportNumber}.pdf`,
        byteSize: 2048,
        contentHash:
          opts.prefix === "TRV"
            ? "a".repeat(64)
            : opts.prefix === "MNT"
              ? "b".repeat(64)
              : "c".repeat(64),
        generatedById: opts.generatedById,
      },
    });
    createdReportIds.push(report.id);
    return report;
  }

  async function getList(cookie: string, params: Record<string, string | number | undefined>) {
    return app.inject({ method: "GET", url: buildQuery(params), headers: { cookie } });
  }

  // 本檔共用 fixtures（beforeAll 一次建立，各測試僅查詢，不互相干擾——
  // reportNumber/purpose 皆彼此互斥的字面內容，見下方建立順序之註解）。
  let travelWithReport: { id: string };
  let maintenanceWithReport: { id: string };
  let depreciationWithReport: { id: string };
  let travelNoReport: { id: string };
  let otherTravelWithReport: { id: string };

  let travelReportNumber: string;
  let maintenanceReportNumber: string;
  let depreciationReportNumber: string;
  let otherReportNumber: string;

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const owner = await createUser("owner");
    const other = await createUser("other");
    ownerId = owner.id;
    otherId = other.id;

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    ownerCookie = await loginUser(app, owner.loginName, PASSWORD);
    otherCookie = await loginUser(app, other.loginName, PASSWORD);

    travelWithReport = await createTravelApp({
      ownerId,
      purpose: "P8T17 客戶拜訪業務洽談",
    });
    maintenanceWithReport = await createMaintenanceApp({ ownerId });
    depreciationWithReport = await createDepreciationApp({ ownerId });
    travelNoReport = await createTravelApp({
      ownerId,
      purpose: "P8T17 未產生報表之出差目的AC38",
    });
    otherTravelWithReport = await createTravelApp({
      ownerId: otherId,
      purpose: "P8T17 他人出差目的",
    });

    const travelReport = await createReport({
      applicationId: travelWithReport.id,
      prefix: "TRV",
      sequence: 11,
      generatedById: ownerId,
    });
    const maintenanceReport = await createReport({
      applicationId: maintenanceWithReport.id,
      prefix: "MNT",
      sequence: 12,
      generatedById: ownerId,
    });
    const depreciationReport = await createReport({
      applicationId: depreciationWithReport.id,
      prefix: "DEP",
      sequence: 13,
      generatedById: ownerId,
    });
    const otherReport = await createReport({
      applicationId: otherTravelWithReport.id,
      prefix: "TRV",
      sequence: 21,
      generatedById: otherId,
    });

    travelReportNumber = travelReport.reportNumber;
    maintenanceReportNumber = maintenanceReport.reportNumber;
    depreciationReportNumber = depreciationReport.reportNumber;
    otherReportNumber = otherReport.reportNumber;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      if (createdReportIds.length > 0) {
        await prisma.report.deleteMany({ where: { id: { in: createdReportIds } } });
      }
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
  // 1. 三型各一：以完整編號查得恰該筆
  // ===========================================================================

  describe("AC-38：三型皆可由完整報表編號查得", () => {
    it("TRAVEL：以完整 reportNumber 查得恰該筆", async () => {
      const resp = await getList(ownerCookie, {
        keyword: travelReportNumber,
        dateFrom: "2100-01-01",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as ListResponse;
      expect(body.items.map((i) => i.id)).toEqual([travelWithReport.id]);
    });

    it("MAINTENANCE：以完整 reportNumber 查得恰該筆", async () => {
      const resp = await getList(ownerCookie, {
        keyword: maintenanceReportNumber,
        dateFrom: "2100-01-01",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as ListResponse;
      expect(body.items.map((i) => i.id)).toEqual([maintenanceWithReport.id]);
    });

    it("DEPRECIATION：以完整 reportNumber 查得恰該筆", async () => {
      const resp = await getList(ownerCookie, {
        keyword: depreciationReportNumber,
        dateFrom: "2100-01-01",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as ListResponse;
      expect(body.items.map((i) => i.id)).toEqual([depreciationWithReport.id]);
    });
  });

  // ===========================================================================
  // 2. 部分編號／大小寫變體
  // ===========================================================================

  describe("AC-38：部分編號與大小寫不敏感比對", () => {
    it("部分編號（期間段，如 'TRV-2045'）查得該筆", async () => {
      const resp = await getList(ownerCookie, {
        keyword: `TRV-${PERIOD}`,
        dateFrom: "2100-01-01",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as ListResponse;
      expect(body.items.map((i) => i.id)).toEqual([travelWithReport.id]);
    });

    it("序號段（如 '0012'）查得該筆（MNT）", async () => {
      const resp = await getList(ownerCookie, {
        keyword: seq(12),
        dateFrom: "2100-01-01",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as ListResponse;
      expect(body.items.map((i) => i.id)).toEqual([maintenanceWithReport.id]);
    });

    it("大小寫變體（小寫 'trv-'）仍查得該筆", async () => {
      const resp = await getList(ownerCookie, {
        keyword: travelReportNumber.toLowerCase(),
        dateFrom: "2100-01-01",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as ListResponse;
      expect(body.items.map((i) => i.id)).toEqual([travelWithReport.id]);
    });
  });

  // ===========================================================================
  // 3. LIKE 萬用字元注入負向（`%`/`_`/`\` 已跳脫，跳脫有牙）
  // ===========================================================================

  describe("AC-38：LIKE 萬用字元注入負向", () => {
    it("keyword 'TRV-______-%' 不得命中任何申請（跳脫使其為字面比對，而非萬用樣式）", async () => {
      // 若未跳脫，'______'（6 個底線）會比對任意 6 字元、'%' 比對任意長度，
      // 使此 pattern 實質等同於「TRV- 開頭、第 11 字元為 -」——
      // travelReportNumber（"TRV-204509-0011"）恰好符合此結構，會被誤命中。
      // 有跳脫時三者皆為字面字元，資料庫中不存在字面含 6 個底線的
      // reportNumber，故必為 0 筆。
      const resp = await getList(ownerCookie, {
        keyword: "TRV-______-%",
        dateFrom: "2100-01-01",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as ListResponse;
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("keyword 含字面 '%' 不命中任何 reportNumber（reportNumber 字元集不含 '%'）", async () => {
      const resp = await getList(ownerCookie, {
        keyword: "204509-%",
        dateFrom: "2100-01-01",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as ListResponse;
      expect(body.items).toEqual([]);
    });
  });

  // ===========================================================================
  // 4. 未產生報表之申請不受影響
  // ===========================================================================

  describe("AC-38：未產生報表之申請不受影響", () => {
    it("既有 keyword 行為（出差目的比對）不受影響", async () => {
      const resp = await getList(ownerCookie, {
        keyword: "未產生報表之出差目的AC38",
        dateFrom: "2100-01-01",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as ListResponse;
      expect(body.items.map((i) => i.id)).toEqual([travelNoReport.id]);
    });

    it("以編號樣式查詢不誤傷未產生報表之申請（不會被錯誤地帶入結果）", async () => {
      const resp = await getList(ownerCookie, {
        keyword: "TRV-204509-9999",
        dateFrom: "2100-01-01",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as ListResponse;
      expect(body.items).toEqual([]);
    });
  });

  // ===========================================================================
  // 5. 授權範圍維持——他人申請不因編號命中而外洩
  // ===========================================================================

  describe("AC-38：授權範圍維持", () => {
    it("以他人之完整 reportNumber 查詢，owner 查無此筆（ownerId 範圍未被 OR 條件繞過）", async () => {
      const resp = await getList(ownerCookie, {
        keyword: otherReportNumber,
        dateFrom: "2100-01-01",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as ListResponse;
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("該他人以自己身份查詢同一編號，查得恰該筆（證明資料確實存在，只是 owner 查不到）", async () => {
      const resp = await getList(otherCookie, {
        keyword: otherReportNumber,
        dateFrom: "2100-01-01",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as ListResponse;
      expect(body.items.map((i) => i.id)).toEqual([otherTravelWithReport.id]);
    });
  });
});
