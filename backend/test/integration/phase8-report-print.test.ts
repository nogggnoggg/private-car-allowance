/**
 * PHASE-008-T10 — 列印端點（`GET /applications/:id/report/print`）：同一版
 * 型 wire 斷言、授權矩陣（產生／列印兩列）、狀態守門、安全標頭
 *
 * ---------------------------------------------------------------------------
 * 規範出處（Spec `docs/specs/PHASE-008.md`）
 * ---------------------------------------------------------------------------
 * AC-15（端點側）：列印端點回傳之 HTML 與產生 PDF 時所使用之 HTML **字串全
 *   等**——同一 `ReportData` 輸入形狀（已產生報表時皆以持久化之
 *   `{ reportNumber, generatedAt }` 為 meta）餵入同一函式
 *   `renderReportHtml`；「PDF 走另一份模板」之 mutant 必紅（見 §F）。
 * AC-16(c)：列印端點回應含 `Content-Type: text/html; charset=utf-8`、
 *   `X-Content-Type-Options: nosniff`、`Cache-Control: no-store`、
 *   `Content-Security-Policy: default-src 'none'; img-src data:;
 *   style-src 'unsafe-inline'` 四項安全標頭逐字在場（見 §H）。
 * AC-24：4 端點 × 5 身分 ＝ 20 格授權矩陣——本檔完整覆蓋**產生／列印兩
 *   列**（§A／§B，各 5 格，狀態碼 ＋ 回應鍵集）；並回補 T9
 *   （`phase8-report-download.test.ts`）查詢／下載兩列之**回應鍵集**與
 *   **401 零洩漏掃描**（§C；T9 即審 AR-2）。401／403 回應一律不含任何報表
 *   編號／檔名／金額／姓名。
 * AC-25（修訂後，SPEC-REV-T9）：草稿申請之產生與列印兩端點 409 CONFLICT ＋
 *   `details.status`（§D）；他人草稿與他人已完成（未產生）之回應**逐字相
 *   同**（403 FORBIDDEN，授權先於狀態，見 §E——Mutant I「授權／狀態守門順
 *   序對調」之必殺測試）。
 * AC-11／§3.2：未產生報表之已完成申請，列印版仍可預覽（報表編號／產生時
 *   間呈現「尚未產生」佔位），零 DB 寫入、零 renderPdf 呼叫（見 §G）。
 * §11.2／T5 FW-1（端點層再驗）：列印端點之實際 HTTP 回應零 storageKey／
 *   attachmentId 值、零 `rpt/`／`att/` 字樣（見 §I；T5 之 `report-html.
 *   test.ts` 僅驗證純函式輸出，本檔驗證經 HTTP 層之真實回應）。
 *
 * ---------------------------------------------------------------------------
 * 上游必引義務核銷（Packet 逐條）
 * ---------------------------------------------------------------------------
 * 1. T5 複審 FW-A（綁定義務）：§F 之 wire 斷言為「列印端點」與「產生時所用
 *    （持久化 PDF 之來源）HTML」字串全等，兩者**各自獨立**呼叫
 *    `buildReportData`／`embedImages`／`renderReportHtml`（見
 *    `routes.ts` 檔頭），非重用同一次呼叫結果。
 * 2. T8 即審 mutant I（必殺義務）：§E 之側信道測試 ＋ §J 之結構性原始碼順
 *    序斷言雙重守門，任一守門被移除或對調皆使對應測試轉紅（紅燈實證見
 *    Task Handoff）。
 * 3. AC-24 二十格：§A／§B（產生／列印，本檔）＋ §C（回補查詢／下載兩列之
 *    鍵集與 401 掃描）合計覆蓋全部 20 格；401／403 之字面掃描逐格施作。
 * 4. 端點不對稱刻意保留：本檔**不**對下載／查詢端點之草稿施加 409 守門
 *    （沿 SPEC-REV-T9；見 `phase8-report-download.test.ts` 之
 *    `AC-25（SPEC-REV-T9）` 區塊，本檔不重複）。
 * 5. 授權順序紀律：`assertOwnershipOrAdmin` 於申請存在性之後、狀態守門之
 *    前——§J 以原始碼字串位置鑑別；產生端點之判定順序歷史即如此（T8 既
 *    有），本檔延伸覆蓋列印端點並雙端點共同守門。
 * 6. T5 FW-1 wire 複核：§I。
 * 7. AC-16(c)：§H，CSP 與其餘三標頭逐字斷言。
 * 8. 未產生報表即可列印之語意：§G（§3.2「200 text/html」＋ AC-11「報表編
 *    號（已產生時）」既有字面之落地確認）。
 *
 * ---------------------------------------------------------------------------
 * 範圍邊界（誠實揭露；沿既有 phase8-report-*.test.ts 慣例）
 * ---------------------------------------------------------------------------
 * 本檔僅驗證 T10 Packet 之 Done When：AC-15（端點側）／AC-16(c)／AC-24（產
 * 生／列印兩列 ＋ 回補查詢／下載兩列之鍵集與 401 掃描）／AC-25。三型
 * （差旅／保養／折舊）之列印版內容完整性（AC-11~AC-19）屬 T4／T5（純函式
 * 層，`report-html.test.ts`／`phase8-report-data.test.ts`），本檔僅以差旅
 * fixture 驗證端點層之配線與授權，不重複三型內容斷言。
 *
 * ---------------------------------------------------------------------------
 * 渲染器 mock 策略（沿既有 phase8-report-*.test.ts 之既有慣例：`beforeEach`
 * 逐測試重新套用，避免外層 `afterEach` 之 `vi.restoreAllMocks()` 使合成替
 * 身僅第一則測試生效）
 * ---------------------------------------------------------------------------
 * `renderPdf` 以合成替身（`FAKE_PDF_BYTES`）取代真實 Chromium——本檔驗證的
 * 是列印端點與授權／狀態守門邏輯，與 PDF 位元組是否為真實 Chromium 產出無
 * 關（AC-09 之真實 Chromium 覆蓋屬 T7；AC-06 端到端一次覆蓋屬 T8）。
 * `renderReportHtml` 維持 `vi.fn(actual.renderReportHtml)`（呼叫穿透）——
 * AC-15 之 wire 斷言（§F）需要真實渲染結果，且藉此攔截「產生時傳入
 * `renderPdf` 之 HTML」（`vi.mocked(renderPdf).mock.calls[0][0]`）供跨路徑
 * 比對。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";
import { LocalVolumeStorage } from "../../src/storage/index.js";

// ── report-html.ts／pdf-renderer.ts：呼叫穿透之 spy 包裝（沿既有 phase8-
//    report-*.test.ts 慣例）──────────────────────────────────────────────
vi.mock("../../src/reports/report-html.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/reports/report-html.js")>();
  return { ...actual, renderReportHtml: vi.fn(actual.renderReportHtml) };
});
vi.mock("../../src/reports/pdf-renderer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/reports/pdf-renderer.js")>();
  return { ...actual, renderPdf: vi.fn(actual.renderPdf) };
});

import { renderPdf } from "../../src/reports/pdf-renderer.js";
import { renderReportHtml } from "../../src/reports/report-html.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "ReportPrintFixture99!";

const EXPECTED_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

// 合成 PDF 位元組（AC-06 之三項位元組層特徵在快速路徑上仍可驗證）：
// %PDF- 開頭、%%EOF 結尾、長度 > 1024。
const FAKE_PDF_BYTES = Buffer.from(
  `%PDF-1.4\n% synthetic fixture for PHASE-008-T10 print tests\n${"X".repeat(1200)}\n%%EOF`
);

function makeTempStorageRoot(prefixLabel: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `phase8-report-print-${prefixLabel}-`));
}

function removeTempStorageRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

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

const ERROR_KEY_SET = ["code", "message", "requestId"].sort();

describeWithDb(
  "PHASE-008-T10 — GET /applications/:id/report/print ＋ 授權矩陣（產生／列印兩列）＋ AC-25",
  () => {
    let prisma: PrismaClient;
    let app: FastifyInstance;
    let attachmentStorageRoot: string;
    let reportStorageRoot: string;

    let ownerId: string;
    let ownerCookie: string;
    let strangerCookie: string;
    let adminCookie: string;
    let mustChangeCookie: string;

    const createdApplicationIds: string[] = [];
    const createdUserIds: string[] = [];

    async function createTravelApp(
      ownerIdForApp: string,
      suffix: string,
      totalAmount = 500
    ): Promise<string> {
      const created = await prisma.application.create({
        data: {
          type: "TRAVEL",
          status: "COMPLETED",
          ownerId: ownerIdForApp,
          createdById: ownerIdForApp,
          primaryDate: new Date("2026-03-20T00:00:00.000Z"),
          totalAmount,
          completedAt: new Date(),
          travel: {
            create: {
              tripDate: new Date("2026-03-20T00:00:00.000Z"),
              purpose: `PHASE-008-T10 測試出差-${suffix}`,
              fuelUnitPrice: "2.3456",
              etcUnitPrice: "1.2345",
              snapshotTotalKm: "60.00",
              snapshotRawAmount: `${totalAmount}.0000`,
              calculatedAt: new Date(),
              segments: {
                create: [
                  {
                    sortOrder: 0,
                    origin: "台北",
                    destination: "新竹",
                    totalKm: "60.00",
                    highwayKm: "50.00",
                    snapshotFuelAmount: "140.0000",
                    snapshotEtcAmount: "60.0000",
                    snapshotRawAmount: `${totalAmount}.0000`,
                    snapshotAmount: totalAmount,
                  },
                ],
              },
            },
          },
        },
      });
      createdApplicationIds.push(created.id);
      return created.id;
    }

    /** AC-25：DRAFT 申請（結構性恆無 Report 列，沿既有慣例）。 */
    async function createDraftTravelApp(ownerIdForApp: string): Promise<string> {
      const created = await prisma.application.create({
        data: {
          type: "TRAVEL",
          status: "DRAFT",
          ownerId: ownerIdForApp,
          createdById: ownerIdForApp,
          primaryDate: new Date("2026-03-20T00:00:00.000Z"),
        },
      });
      createdApplicationIds.push(created.id);
      return created.id;
    }

    /** 產生報表（HTTP，等同使用者操作），回傳 `{ statusCode, body }`。 */
    async function generateReportViaHttp(
      id: string,
      cookie: string
    ): Promise<{ statusCode: number; body: { report: Record<string, unknown> } }> {
      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/report`,
        headers: { cookie },
      });
      return { statusCode: resp.statusCode, body: JSON.parse(resp.body) };
    }

    beforeAll(async () => {
      if (!DB_URL) return;
      prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
      await prisma.$connect();

      const owner = await prisma.user.create({
        data: {
          loginName: `p8t10_owner_${RUN_ID}`,
          displayName: "P8T10 擁有人",
          passwordHash: await hashPassword(PASSWORD),
          role: "USER",
          isActive: true,
          mustChangePassword: false,
        },
      });
      ownerId = owner.id;
      createdUserIds.push(owner.id);

      const stranger = await prisma.user.create({
        data: {
          loginName: `p8t10_stranger_${RUN_ID}`,
          displayName: "P8T10 陌生人",
          passwordHash: await hashPassword(PASSWORD),
          role: "USER",
          isActive: true,
          mustChangePassword: false,
        },
      });
      createdUserIds.push(stranger.id);

      const admin = await prisma.user.create({
        data: {
          loginName: `p8t10_admin_${RUN_ID}`,
          displayName: "P8T10 管理員",
          passwordHash: await hashPassword(PASSWORD),
          role: "ADMIN",
          isActive: true,
          mustChangePassword: false,
        },
      });
      createdUserIds.push(admin.id);

      const mustChangeUser = await prisma.user.create({
        data: {
          loginName: `p8t10_mustchg_${RUN_ID}`,
          displayName: "P8T10 待改密",
          passwordHash: await hashPassword(PASSWORD),
          role: "USER",
          isActive: true,
          mustChangePassword: true,
        },
      });
      createdUserIds.push(mustChangeUser.id);

      attachmentStorageRoot = makeTempStorageRoot("att");
      reportStorageRoot = makeTempStorageRoot("rpt");

      app = await buildServer({
        databaseUrl: DB_URL,
        storageRoot: attachmentStorageRoot,
        reportStorageRoot,
      });
      await app.ready();

      ownerCookie = await loginUser(app, owner.loginName, PASSWORD);
      strangerCookie = await loginUser(app, stranger.loginName, PASSWORD);
      adminCookie = await loginUser(app, admin.loginName, PASSWORD);
      mustChangeCookie = await loginUser(app, mustChangeUser.loginName, PASSWORD);
    });

    afterAll(async () => {
      if (!prisma) return;
      await app.close();
      await prisma.attachment.deleteMany({ where: { uploaderId: { in: createdUserIds } } });
      await prisma.report.deleteMany({ where: { applicationId: { in: createdApplicationIds } } });
      await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
      if (createdUserIds.length > 0) {
        await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      }
      await prisma.$disconnect();
      removeTempStorageRoot(attachmentStorageRoot);
      removeTempStorageRoot(reportStorageRoot);
    });

    // T8R SF-1 同型修正：置於 beforeEach（非 beforeAll），確保每一則測試開始
    // 前都重新套用合成實作，不受外層 afterEach 之 vi.restoreAllMocks() 影響。
    beforeEach(() => {
      vi.mocked(renderPdf).mockImplementation(async () => Buffer.from(FAKE_PDF_BYTES));
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // -------------------------------------------------------------------------
    // §A AC-24：授權矩陣 — 產生端點（5 格）
    // -------------------------------------------------------------------------

    describe("§A AC-24：授權矩陣 — 產生端點（POST /applications/:id/report，5 格）", () => {
      let appId: string;
      let generatedReportNumber: string;
      let generatedFileName: string;

      beforeAll(async () => {
        appId = await createTravelApp(ownerId, "authz-gen-matrix", 741);
        const gen = await generateReportViaHttp(appId, ownerCookie);
        expect(gen.statusCode).toBe(201);
        generatedReportNumber = gen.body.report.reportNumber as string;
        generatedFileName = gen.body.report.fileName as string;
      });

      it("格1 未登入 → 401 UNAUTHORIZED，鍵集恰 {code,message,requestId}，零洩漏", async () => {
        const resp = await app.inject({ method: "POST", url: `/applications/${appId}/report` });
        expect(resp.statusCode).toBe(401);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("UNAUTHORIZED");
        expect(Object.keys(body.error).sort()).toEqual(ERROR_KEY_SET);
        expect(resp.body).not.toContain(generatedReportNumber);
        expect(resp.body).not.toContain(generatedFileName);
        expect(resp.body).not.toContain("741");
        expect(resp.body).not.toContain("P8T10 擁有人");
      });

      it("格2 需強制改密 → 403 PASSWORD_CHANGE_REQUIRED，鍵集，零洩漏", async () => {
        const resp = await app.inject({
          method: "POST",
          url: `/applications/${appId}/report`,
          headers: { cookie: mustChangeCookie },
        });
        expect(resp.statusCode).toBe(403);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
        expect(Object.keys(body.error).sort()).toEqual(ERROR_KEY_SET);
        expect(resp.body).not.toContain(generatedReportNumber);
        expect(resp.body).not.toContain(generatedFileName);
        expect(resp.body).not.toContain("741");
        expect(resp.body).not.toContain("P8T10 擁有人");
      });

      it("格3 本人（擁有人）→ 200（冪等回既有），鍵集恰六鍵，編號與 beforeAll 相同", async () => {
        const resp = await app.inject({
          method: "POST",
          url: `/applications/${appId}/report`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(200);
        const body = JSON.parse(resp.body);
        expect(Object.keys(body.report).sort()).toEqual(
          ["reportNumber", "generatedAt", "fileName", "byteSize", "downloadUrl", "printUrl"].sort()
        );
        expect(body.report.reportNumber).toBe(generatedReportNumber);
      });

      it("格4 他人（一般使用者）→ 403 FORBIDDEN，鍵集，零洩漏", async () => {
        const resp = await app.inject({
          method: "POST",
          url: `/applications/${appId}/report`,
          headers: { cookie: strangerCookie },
        });
        expect(resp.statusCode).toBe(403);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("FORBIDDEN");
        expect(Object.keys(body.error).sort()).toEqual(ERROR_KEY_SET);
        expect(resp.body).not.toContain(generatedReportNumber);
        expect(resp.body).not.toContain(generatedFileName);
        expect(resp.body).not.toContain("741");
        expect(resp.body).not.toContain("P8T10 擁有人");
      });

      it("格5 管理員 → 200（代行冪等），鍵集恰六鍵，編號相同（可見面不擴張）", async () => {
        const resp = await app.inject({
          method: "POST",
          url: `/applications/${appId}/report`,
          headers: { cookie: adminCookie },
        });
        expect(resp.statusCode).toBe(200);
        const body = JSON.parse(resp.body);
        expect(Object.keys(body.report).sort()).toEqual(
          ["reportNumber", "generatedAt", "fileName", "byteSize", "downloadUrl", "printUrl"].sort()
        );
        expect(body.report.reportNumber).toBe(generatedReportNumber);
      });
    });

    // -------------------------------------------------------------------------
    // §B AC-24：授權矩陣 — 列印端點（5 格）
    // -------------------------------------------------------------------------

    describe("§B AC-24：授權矩陣 — 列印端點（GET /applications/:id/report/print，5 格）", () => {
      let appId: string;
      let generatedReportNumber: string;

      beforeAll(async () => {
        appId = await createTravelApp(ownerId, "authz-print-matrix", 852);
        const gen = await generateReportViaHttp(appId, ownerCookie);
        expect(gen.statusCode).toBe(201);
        generatedReportNumber = gen.body.report.reportNumber as string;
      });

      it("格1 未登入 → 401 UNAUTHORIZED，鍵集，零洩漏，非 text/html", async () => {
        const resp = await app.inject({
          method: "GET",
          url: `/applications/${appId}/report/print`,
        });
        expect(resp.statusCode).toBe(401);
        expect(resp.headers["content-type"]).not.toMatch(/text\/html/);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("UNAUTHORIZED");
        expect(Object.keys(body.error).sort()).toEqual(ERROR_KEY_SET);
        expect(resp.body).not.toContain(generatedReportNumber);
        expect(resp.body).not.toContain("852");
        expect(resp.body).not.toContain("P8T10 擁有人");
      });

      it("格2 需強制改密 → 403 PASSWORD_CHANGE_REQUIRED，鍵集，零洩漏", async () => {
        const resp = await app.inject({
          method: "GET",
          url: `/applications/${appId}/report/print`,
          headers: { cookie: mustChangeCookie },
        });
        expect(resp.statusCode).toBe(403);
        expect(resp.headers["content-type"]).not.toMatch(/text\/html/);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
        expect(Object.keys(body.error).sort()).toEqual(ERROR_KEY_SET);
        expect(resp.body).not.toContain(generatedReportNumber);
        expect(resp.body).not.toContain("852");
        expect(resp.body).not.toContain("P8T10 擁有人");
      });

      it("格3 本人（擁有人）→ 200 text/html，內文含報表編號與擁有人姓名（本人可見，非洩漏）", async () => {
        const resp = await app.inject({
          method: "GET",
          url: `/applications/${appId}/report/print`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(200);
        expect(resp.headers["content-type"]).toBe("text/html; charset=utf-8");
        expect(resp.body).toContain(generatedReportNumber);
        expect(resp.body).toContain("P8T10 擁有人");
      });

      it("格4 他人（一般使用者）→ 403 FORBIDDEN，鍵集，零洩漏，非 text/html", async () => {
        const resp = await app.inject({
          method: "GET",
          url: `/applications/${appId}/report/print`,
          headers: { cookie: strangerCookie },
        });
        expect(resp.statusCode).toBe(403);
        expect(resp.headers["content-type"]).not.toMatch(/text\/html/);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("FORBIDDEN");
        expect(Object.keys(body.error).sort()).toEqual(ERROR_KEY_SET);
        expect(resp.body).not.toContain(generatedReportNumber);
        expect(resp.body).not.toContain("852");
        expect(resp.body).not.toContain("P8T10 擁有人");
      });

      it("格5 管理員 → 200 text/html（可見面不擴張）", async () => {
        const resp = await app.inject({
          method: "GET",
          url: `/applications/${appId}/report/print`,
          headers: { cookie: adminCookie },
        });
        expect(resp.statusCode).toBe(200);
        expect(resp.headers["content-type"]).toBe("text/html; charset=utf-8");
        expect(resp.body).toContain(generatedReportNumber);
      });
    });

    // -------------------------------------------------------------------------
    // §C AC-24 回補（T9 即審 AR-2/AR-3）：查詢／下載端點之 401/403 回應鍵集
    // 與零洩漏掃描（狀態碼已由 phase8-report-download.test.ts 覆蓋，本區塊補
    // 「回應鍵集」與「401 掃描」兩項缺口）
    // -------------------------------------------------------------------------

    describe("§C AC-24 回補（T9 AR-2/AR-3）：查詢／下載端點之 401/403 鍵集與零洩漏掃描", () => {
      let appId: string;
      let generatedReportNumber: string;
      let generatedFileName: string;

      beforeAll(async () => {
        appId = await createTravelApp(ownerId, "ac24-backfill", 963);
        const gen = await generateReportViaHttp(appId, ownerCookie);
        expect(gen.statusCode).toBe(201);
        generatedReportNumber = gen.body.report.reportNumber as string;
        generatedFileName = gen.body.report.fileName as string;
      });

      it("查詢端點：未登入 → 401，鍵集恰 {code,message,requestId}，零洩漏", async () => {
        const resp = await app.inject({ method: "GET", url: `/applications/${appId}/report` });
        expect(resp.statusCode).toBe(401);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("UNAUTHORIZED");
        expect(Object.keys(body.error).sort()).toEqual(ERROR_KEY_SET);
        expect(resp.body).not.toContain(generatedReportNumber);
        expect(resp.body).not.toContain(generatedFileName);
        expect(resp.body).not.toContain("963");
        expect(resp.body).not.toContain("P8T10 擁有人");
      });

      it("查詢端點：他人 → 403，鍵集恰 {code,message,requestId}，零洩漏", async () => {
        const resp = await app.inject({
          method: "GET",
          url: `/applications/${appId}/report`,
          headers: { cookie: strangerCookie },
        });
        expect(resp.statusCode).toBe(403);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("FORBIDDEN");
        expect(Object.keys(body.error).sort()).toEqual(ERROR_KEY_SET);
        expect(resp.body).not.toContain(generatedReportNumber);
        expect(resp.body).not.toContain(generatedFileName);
        expect(resp.body).not.toContain("963");
        expect(resp.body).not.toContain("P8T10 擁有人");
      });

      it("下載端點：未登入 → 401，鍵集恰 {code,message,requestId}，零洩漏", async () => {
        const resp = await app.inject({
          method: "GET",
          url: `/applications/${appId}/report/pdf`,
        });
        expect(resp.statusCode).toBe(401);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("UNAUTHORIZED");
        expect(Object.keys(body.error).sort()).toEqual(ERROR_KEY_SET);
        expect(resp.body).not.toContain(generatedReportNumber);
        expect(resp.body).not.toContain(generatedFileName);
        expect(resp.body).not.toContain("963");
        expect(resp.body).not.toContain("P8T10 擁有人");
      });

      it("下載端點：他人 → 403，鍵集恰 {code,message,requestId}，零洩漏", async () => {
        const resp = await app.inject({
          method: "GET",
          url: `/applications/${appId}/report/pdf`,
          headers: { cookie: strangerCookie },
        });
        expect(resp.statusCode).toBe(403);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("FORBIDDEN");
        expect(Object.keys(body.error).sort()).toEqual(ERROR_KEY_SET);
        expect(resp.body).not.toContain(generatedReportNumber);
        expect(resp.body).not.toContain(generatedFileName);
        expect(resp.body).not.toContain("963");
        expect(resp.body).not.toContain("P8T10 擁有人");
      });
    });

    // -------------------------------------------------------------------------
    // §D AC-25：草稿狀態守門 — 產生與列印兩端點 409 CONFLICT + details.status
    // -------------------------------------------------------------------------

    describe("§D AC-25：草稿申請 — 產生與列印兩端點 409 CONFLICT + details.status", () => {
      it("產生端點：草稿申請 → 409 CONFLICT，details.status = DRAFT", async () => {
        const id = await createDraftTravelApp(ownerId);
        const resp = await app.inject({
          method: "POST",
          url: `/applications/${id}/report`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(409);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("CONFLICT");
        expect(body.error.details).toEqual({ status: "DRAFT" });
      });

      it("列印端點：草稿申請 → 409 CONFLICT，details.status = DRAFT", async () => {
        const id = await createDraftTravelApp(ownerId);
        const resp = await app.inject({
          method: "GET",
          url: `/applications/${id}/report/print`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(409);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("CONFLICT");
        expect(body.error.details).toEqual({ status: "DRAFT" });
      });
    });

    // -------------------------------------------------------------------------
    // §E AC-25 側信道（mutant I 必殺）：他人草稿 vs 他人已完成（未產生）→
    // 產生／列印兩端點皆 403 FORBIDDEN，碼與訊息逐字相同（授權先於狀態）
    // -------------------------------------------------------------------------

    describe("§E AC-25 側信道（mutant I 必殺）：他人草稿 vs 他人已完成未產生 → 403 逐字相同", () => {
      it("產生端點：stranger 對他人 DRAFT 與他人 COMPLETED（未產生）皆 403 FORBIDDEN，碼與訊息逐字相同", async () => {
        const draftId = await createDraftTravelApp(ownerId);
        const completedId = await createTravelApp(ownerId, "sidechannel-gen-completed");

        const draftResp = await app.inject({
          method: "POST",
          url: `/applications/${draftId}/report`,
          headers: { cookie: strangerCookie },
        });
        const completedResp = await app.inject({
          method: "POST",
          url: `/applications/${completedId}/report`,
          headers: { cookie: strangerCookie },
        });

        // Mutant I（授權／狀態守門順序對調）必殺之關鍵：若順序被對調成先狀態
        // 後授權，草稿分支會先於授權判定回 409，此處即轉紅。
        expect(draftResp.statusCode).toBe(403);
        expect(completedResp.statusCode).toBe(403);
        const draftBody = JSON.parse(draftResp.body);
        const completedBody = JSON.parse(completedResp.body);
        expect(draftBody.error.code).toBe("FORBIDDEN");
        expect(draftBody.error.code).toBe(completedBody.error.code);
        expect(draftBody.error.message).toBe(completedBody.error.message);
        expect(draftBody.error.details).toBeUndefined();
        expect(completedBody.error.details).toBeUndefined();
      });

      it("列印端點：stranger 對他人 DRAFT 與他人 COMPLETED（未產生）皆 403 FORBIDDEN，碼與訊息逐字相同", async () => {
        const draftId = await createDraftTravelApp(ownerId);
        const completedId = await createTravelApp(ownerId, "sidechannel-print-completed");

        const draftResp = await app.inject({
          method: "GET",
          url: `/applications/${draftId}/report/print`,
          headers: { cookie: strangerCookie },
        });
        const completedResp = await app.inject({
          method: "GET",
          url: `/applications/${completedId}/report/print`,
          headers: { cookie: strangerCookie },
        });

        expect(draftResp.statusCode).toBe(403);
        expect(completedResp.statusCode).toBe(403);
        const draftBody = JSON.parse(draftResp.body);
        const completedBody = JSON.parse(completedResp.body);
        expect(draftBody.error.code).toBe("FORBIDDEN");
        expect(draftBody.error.code).toBe(completedBody.error.code);
        expect(draftBody.error.message).toBe(completedBody.error.message);
        expect(draftBody.error.details).toBeUndefined();
        expect(completedBody.error.details).toBeUndefined();
      });
    });

    // -------------------------------------------------------------------------
    // §F AC-15：列印端點與持久化 PDF 之 HTML 字串全等（wire 層；PDF 走另一份
    // 模板之 mutant 必紅）
    // -------------------------------------------------------------------------

    describe("§F AC-15：列印端點與產生時傳入 renderPdf 之 HTML 字串全等", () => {
      it("已產生報表之申請：兩條路徑各自獨立計算，wire 層字串全等（非重用同一次呼叫結果）", async () => {
        const id = await createTravelApp(ownerId, "ac15-wire");

        const gen = await generateReportViaHttp(id, ownerCookie);
        expect(gen.statusCode).toBe(201);

        // 產生路徑實際傳入 renderPdf 之 HTML（(4)d 之輸出，持久化 PDF 之來
        // 源）——非列印端點之回應，兩者接下來各自獨立取得。
        const renderPdfCalls = vi.mocked(renderPdf).mock.calls;
        expect(renderPdfCalls.length).toBe(1);
        const htmlUsedForPdf = renderPdfCalls[0]?.[0] as string;
        expect(typeof htmlUsedForPdf).toBe("string");
        expect(htmlUsedForPdf).toContain(gen.body.report.reportNumber as string);

        const renderHtmlCallsBeforePrint = vi.mocked(renderReportHtml).mock.calls.length;

        const printResp = await app.inject({
          method: "GET",
          url: `/applications/${id}/report/print`,
          headers: { cookie: ownerCookie },
        });
        expect(printResp.statusCode).toBe(200);

        // wire 層字串全等（非結構相等）——兩條路徑各自獨立呼叫
        // buildReportData／embedImages／renderReportHtml（見 routes.ts 檔頭
        // 「AC-15」說明），非重用同一次呼叫結果（T5 複審 FW-A 綁定義務）。
        expect(printResp.body).toBe(htmlUsedForPdf);

        // 列印端點確實再次呼叫 renderReportHtml（非快取重用產生時之輸出）。
        expect(vi.mocked(renderReportHtml).mock.calls.length).toBe(renderHtmlCallsBeforePrint + 1);
      });

      // T10R SF-1（附件排序 tiebreaker）：同段 ≥2 張附件、linkedAt 刻意相同
      // （DB 直寫同值）→ orderBy 僅 { linkedAt: "asc" } 時次序無結構保證。
      //
      // 決定性紅燈設計說明（誠實揭露）：單純「重複列印彼此比對」在本機單一
      // 微型資料表上，Postgres 對同一組未變更資料重複執行同一查詢時，即使
      // 缺 tiebreaker，其內部排序演算法對相同輸入仍是確定性的（同一輸入
      // ctid 序列 → 同一輸出），故「多次列印互相全等」在本機**不足以**可靠
      // 轉紅（已實測驗證：暫 revert 後以此手法連續 8 輪皆綠，見 Handoff）。
      // 改採「插入序刻意與 id 遞增序反向」之解耦手法：以顯式 `id` 覆寫
      // cuid 預設值，令三筆附件之**寫入順序**（c→a→b，對應實體堆積掃描
      // 序）與**id 遞增序**（a→b→c，修復後 tiebreaker 之保證輸出序）相反
      // ——缺 tiebreaker 時查詢落於 `{ linkedAt: asc }` 單鍵、tie 不解析，
      // 依 Postgres 對小表之預設循序掃描行為實際回傳的即為實體寫入序
      // （c,a,b），與規格要求之 id 遞增序（a,b,c）不符，於單次執行即可決定
      // 性驗證，不依賴任何跨次讀取之隨機性。
      it("同段 3 張附件 linkedAt 完全相同、寫入序與 id 遞增序刻意相反：輸出恆依 id 遞增序（附件排序含 id tiebreaker）", async () => {
        const id = await createTravelApp(ownerId, "ac15-wire-tiebreak");
        const [segment] = await prisma.tripSegment.findMany({
          where: { travelApplicationId: id },
        });

        const sameLinkedAt = new Date("2026-03-20T08:00:00.000Z");
        // 顯式 id：字面遞增序為 a→b→c；下方以 c→a→b 之寫入順序建立，令實體
        // 堆積（寫入）序與 id 遞增序刻意相反。
        const attachmentIds = {
          a: `p8t10tiea${RUN_ID}`,
          b: `p8t10tieb${RUN_ID}`,
          c: `p8t10tiec${RUN_ID}`,
        } as const;
        for (const label of ["c", "a", "b"] as const) {
          await prisma.attachment.create({
            data: {
              id: attachmentIds[label],
              status: "LINKED",
              storageKey: `att/p8t10-tiebreak-${RUN_ID}-${label}`,
              mimeType: "image/jpeg",
              byteSize: 1,
              originalFilename: `tiebreak-${label}.jpg`,
              uploaderId: ownerId,
              ownerId,
              refType: "TRIP_SEGMENT",
              refId: segment.id,
              linkedAt: sameLinkedAt,
            },
          });
        }

        const gen = await generateReportViaHttp(id, ownerCookie);
        expect(gen.statusCode).toBe(201);

        const renderPdfCalls = vi.mocked(renderPdf).mock.calls;
        const htmlUsedForPdf = renderPdfCalls[renderPdfCalls.length - 1]?.[0] as string;
        expect(typeof htmlUsedForPdf).toBe("string");

        const print1 = await app.inject({
          method: "GET",
          url: `/applications/${id}/report/print`,
          headers: { cookie: ownerCookie },
        });
        const print2 = await app.inject({
          method: "GET",
          url: `/applications/${id}/report/print`,
          headers: { cookie: ownerCookie },
        });
        expect(print1.statusCode).toBe(200);
        expect(print2.statusCode).toBe(200);

        // 兩次列印彼此 wire 全等，且與產生時餵 renderPdf 之 HTML 全等。
        expect(print1.body).toBe(htmlUsedForPdf);
        expect(print2.body).toBe(htmlUsedForPdf);

        // 決定性核心斷言：輸出中三張附件之 caption 恆依 id 遞增序（a,b,c）
        // 排列——與刻意相反之寫入序（c,a,b）無關。缺 id tiebreaker 時，本斷
        // 言於 revert 後之單次執行即確定性轉紅（見 Handoff 紅燈實錄）。
        const idxA = htmlUsedForPdf.indexOf("tiebreak-a.jpg");
        const idxB = htmlUsedForPdf.indexOf("tiebreak-b.jpg");
        const idxC = htmlUsedForPdf.indexOf("tiebreak-c.jpg");
        expect(idxA).toBeGreaterThan(-1);
        expect(idxB).toBeGreaterThan(-1);
        expect(idxC).toBeGreaterThan(-1);
        expect(idxA).toBeLessThan(idxB);
        expect(idxB).toBeLessThan(idxC);
      });
    });

    // -------------------------------------------------------------------------
    // §G AC-11／§3.2：尚未產生報表之已完成申請 — 列印版仍可預覽（「尚未產
    // 生」佔位），零 DB 寫入、零 renderPdf 呼叫
    // -------------------------------------------------------------------------

    describe("§G AC-11／§3.2：尚未產生報表之已完成申請 — 列印版仍可預覽，零寫入", () => {
      it("列印端點回 200 html，報表編號／產生時間呈現「尚未產生」，Report 資料表零新增列，renderPdf 零呼叫", async () => {
        const id = await createTravelApp(ownerId, "ac11-not-generated");
        const renderPdfCallsBefore = vi.mocked(renderPdf).mock.calls.length;

        const resp = await app.inject({
          method: "GET",
          url: `/applications/${id}/report/print`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(200);
        expect(resp.headers["content-type"]).toBe("text/html; charset=utf-8");
        expect(resp.body).toContain("尚未產生");

        const row = await prisma.report.findUnique({ where: { applicationId: id } });
        expect(row).toBeNull();
        expect(vi.mocked(renderPdf).mock.calls.length).toBe(renderPdfCallsBefore);
      });
    });

    // -------------------------------------------------------------------------
    // §H AC-16(c)：列印端點四個安全標頭逐字在場（CSP 移除各型之 mutant 必紅）
    // -------------------------------------------------------------------------

    describe("§H AC-16(c)：列印端點四個安全標頭逐字在場", () => {
      it("已產生報表之申請：Content-Type／X-Content-Type-Options／Cache-Control／Content-Security-Policy 四項逐字相符", async () => {
        const id = await createTravelApp(ownerId, "ac16c-headers");
        const gen = await generateReportViaHttp(id, ownerCookie);
        expect(gen.statusCode).toBe(201);

        const resp = await app.inject({
          method: "GET",
          url: `/applications/${id}/report/print`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(200);
        expect(resp.headers["content-type"]).toBe("text/html; charset=utf-8");
        expect(resp.headers["x-content-type-options"]).toBe("nosniff");
        expect(resp.headers["cache-control"]).toBe("no-store");
        expect(resp.headers["content-security-policy"]).toBe(EXPECTED_CSP);
      });

      it("尚未產生報表之申請：四項安全標頭仍逐字相符（狀態守門通過後之列印版一律套用）", async () => {
        const id = await createTravelApp(ownerId, "ac16c-headers-empty");
        const resp = await app.inject({
          method: "GET",
          url: `/applications/${id}/report/print`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(200);
        expect(resp.headers["content-type"]).toBe("text/html; charset=utf-8");
        expect(resp.headers["x-content-type-options"]).toBe("nosniff");
        expect(resp.headers["cache-control"]).toBe("no-store");
        expect(resp.headers["content-security-policy"]).toBe(EXPECTED_CSP);
      });
    });

    // -------------------------------------------------------------------------
    // §I T5 FW-1（端點層再驗）：列印端點之實際 HTTP 回應零 storageKey／
    // attachmentId 值、零 rpt/、att/ 字樣
    // -------------------------------------------------------------------------

    describe("§I T5 FW-1（端點層再驗）：列印端點實際回應零 storageKey／attachmentId／rpt-att 字樣", () => {
      it("含 1 張真實附件之差旅申請：列印回應不含該附件之 id 或 storageKey，零 rpt/、att/ 字面", async () => {
        const id = await createTravelApp(ownerId, "fw1-endpoint-recheck");
        // TravelApplication 之主鍵即為 applicationId（1:1 擴充表），故段查詢
        // 直接以外層申請 id 為 travelApplicationId 之值。
        const [segment] = await prisma.tripSegment.findMany({
          where: { travelApplicationId: id },
        });

        const rawStorage = new LocalVolumeStorage(attachmentStorageRoot, { prefixes: ["att"] });
        const sharp = (await import("sharp")).default;
        const jpegBytes = await sharp({
          create: { width: 200, height: 150, channels: 3, background: { r: 90, g: 100, b: 110 } },
        })
          .jpeg({ quality: 80 })
          .toBuffer();
        const storageKey = `att/p8t10-fw1-${RUN_ID}/original`;
        await rawStorage.put(storageKey, jpegBytes, "image/jpeg");

        const attachment = await prisma.attachment.create({
          data: {
            status: "LINKED",
            storageKey,
            mimeType: "image/jpeg",
            byteSize: jpegBytes.length,
            originalFilename: "photo.jpg",
            uploaderId: ownerId,
            ownerId,
            refType: "TRIP_SEGMENT",
            refId: segment.id,
            linkedAt: new Date(),
          },
        });

        const resp = await app.inject({
          method: "GET",
          url: `/applications/${id}/report/print`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(200);
        expect(resp.body).not.toContain(attachment.id);
        expect(resp.body).not.toContain(storageKey);
        expect(resp.body).not.toContain("rpt/");
        expect(resp.body).not.toContain("att/");
        // 正向對照：確認圖片確實被嵌入（非因缺圖而恆真通過）。
        expect(resp.body).toMatch(/data:image\/jpeg;base64,/);
      });
    });

    // -------------------------------------------------------------------------
    // §J 結構性守門：assertOwnershipOrAdmin 於申請存在性之後、狀態守門之前
    // （產生／列印兩端點；順序對調 mutant I 之原始碼層對應守門）
    // -------------------------------------------------------------------------

    describe("§J 結構性守門：授權判定早於狀態判定（產生／列印兩端點；順序對調 mutant 必紅）", () => {
      it("routes.ts：兩端點皆先 assertOwnershipOrAdmin 後 status !== COMPLETED 檢查", () => {
        const routesSrcPath = new URL("../../src/reports/routes.ts", import.meta.url);
        const src = fs.readFileSync(routesSrcPath, "utf8");

        const postHandlerStart = src.indexOf("fastify.post(");
        const printHandlerStart = src.indexOf('"/applications/:id/report/print",');
        expect(postHandlerStart).toBeGreaterThan(-1);
        expect(printHandlerStart).toBeGreaterThan(-1);
        expect(postHandlerStart).toBeLessThan(printHandlerStart);

        const postSection = src.slice(postHandlerStart, printHandlerStart);
        const printSection = src.slice(printHandlerStart);

        for (const [label, section] of [
          ["產生端點", postSection],
          ["列印端點", printSection],
        ] as const) {
          const ownershipIdx = section.indexOf("assertOwnershipOrAdmin(");
          const statusIdx = section.indexOf('application.status !== "COMPLETED"');
          expect(ownershipIdx, `${label}: assertOwnershipOrAdmin 未找到`).toBeGreaterThan(-1);
          expect(statusIdx, `${label}: 狀態檢查未找到`).toBeGreaterThan(-1);
          expect(ownershipIdx, `${label}: 授權判定須早於狀態判定`).toBeLessThan(statusIdx);
        }
      });
    });
  }
);
