/**
 * PHASE-008-T9 — 查詢與下載端點（`GET /applications/:id/report`／
 * `GET /applications/:id/report/pdf`）：檔名標頭、重下一致、授權矩陣兩列
 *
 * ---------------------------------------------------------------------------
 * 規範出處（Spec `docs/specs/PHASE-008.md`）
 * ---------------------------------------------------------------------------
 * AC-08：重下提供原保存檔——連續兩次下載位元組逐位元全等、等於保存值；
 *   `Content-Type: application/pdf`；渲染器 spy 零呼叫（下載時重新渲染之
 *   mutant 必紅）。
 * AC-22：`Content-Disposition` 雙形式——ASCII fallback（僅
 *   `[A-Za-z0-9.-]`）＋ RFC 5987；標頭值不含裸 CR/LF；含 `\r\n` 姓名 fixture
 *   之 wire-level 注入封閉斷言。
 * AC-23：`fileName` 於產生時持久化並凍結——事後修改 `displayName` 再下載，
 *   檔名逐字不變（下載時即時推導之 mutant 必紅）。
 * AC-24：授權矩陣（查詢／下載兩列 × 5 身分）；他人 403 之回應不含任何報表
 *   編號／檔名／金額／姓名。
 * AC-27（DTO 側）：`ReportDto` 鍵集恰為六鍵（`toEqual` 全等，多一鍵必紅）。
 * §16 D10(a)：查詢為獨立端點，尚未產生回 `200 { report: null }`（非
 *   404）。
 * §16 D7(a)+(i)：安全檔名規則 ＋ 產生時持久化（AC-23 之前提）。
 * B-03／B-27／B-28：不存在之申請 404；尚未產生報表即下載 404；報表已產生
 *   但 storage 檔遺失 → 404 不 500，錯誤日誌不含 storage key。
 *
 * ---------------------------------------------------------------------------
 * 範圍邊界（誠實揭露；沿 phase8-report-generate.test.ts 之既有慣例）
 * ---------------------------------------------------------------------------
 * 本檔僅驗證 T9 Packet 之 Done When：AC-08／AC-22／AC-23／AC-24（下載／查詢
 * 兩列）／AC-27（DTO 側）。AC-15（同一版型）／AC-16(c)（列印安全標頭）／
 * AC-24（產生／列印兩列）／AC-25（草稿狀態守門）屬 T10（`phase8-report-
 * print.test.ts`）。查詢／下載兩端點對 DRAFT 申請**不**另立狀態守門（見
 * `routes.ts` 檔頭「查詢／下載端點不另立狀態守門」）——DRAFT 恆無 `Report`
 * 列，故其行為已由 B-27（下載 404）／D10（查詢 200 null）自然涵蓋，本檔不
 * 另建 DRAFT fixture 重複驗證。
 *
 * ---------------------------------------------------------------------------
 * 渲染器 mock 策略（沿 phase8-report-generate.test.ts SF-1 修正後之既有慣
 * 例：`beforeEach` 逐測試重新套用，避免外層 `afterEach` 之
 * `vi.restoreAllMocks()` 使合成替身僅第一則測試生效）
 * ---------------------------------------------------------------------------
 * 全檔測試皆以合成 PDF 位元組（`FAKE_PDF_BYTES`）取代真實 Chromium 產
 * 生——本檔驗證的是查詢／下載端點之讀取、標頭與授權邏輯，與 PDF 位元組是
 * 否為真實 Chromium 產出無關（AC-09 之真實 Chromium 覆蓋屬 T7；AC-06 之
 * 真實 Chromium 端到端一次覆蓋屬 T8）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

// ── report-html.ts／pdf-renderer.ts：呼叫穿透之 spy 包裝（沿
//    phase8-report-generate.test.ts 之既有慣例）─────────────────────────
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
import {
  buildReportContentDisposition,
  encodeRfc5987ValueChars,
} from "../../src/reports/report-service.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "ReportDownloadFixture99!";

// 合成 PDF 位元組（AC-06 之三項位元組層特徵在快速路徑上仍可驗證）：
// %PDF- 開頭、%%EOF 結尾、長度 > 1024。
const FAKE_PDF_BYTES = Buffer.from(
  `%PDF-1.4\n% synthetic fixture for PHASE-008-T9 download tests\n${"X".repeat(1200)}\n%%EOF`
);

function makeTempStorageRoot(prefixLabel: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `phase8-report-download-${prefixLabel}-`));
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

/** 收集日誌原始行（沿 chore001-wire-level-4xx-hardening.test.ts 之既有手法）。 */
function makeLogCapture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, stream };
}

// ---------------------------------------------------------------------------
// §A 純函式：buildReportContentDisposition／encodeRfc5987ValueChars（不需
// DB，AC-22）
// ---------------------------------------------------------------------------

describe("PHASE-008-T9 — buildReportContentDisposition（純函式，AC-22）", () => {
  it("正向：ASCII fallback 僅 [A-Za-z0-9.-]，RFC 5987 完整檔名百分比編碼", () => {
    const header = buildReportContentDisposition(
      "TRV-202608-0001",
      "差旅_王小明_2026-03-15_TRV-202608-0001.pdf"
    );
    expect(header).toContain('filename="TRV-202608-0001.pdf"');
    expect(header).toMatch(/filename\*=UTF-8''/);

    const asciiPart = header.match(/filename="([^"]+)"/)?.[1] ?? "";
    expect(asciiPart).toMatch(/^[A-Za-z0-9.-]+$/);

    const rfc5987Part = header.match(/filename\*=UTF-8''(\S+)$/)?.[1] ?? "";
    expect(decodeURIComponent(rfc5987Part)).toBe("差旅_王小明_2026-03-15_TRV-202608-0001.pdf");
  });

  it("注入封閉：fileName 含 \\r\\n 與標頭分隔字元 → 輸出零裸 CR/LF、原文不透傳（percent-encoded）", () => {
    const maliciousFileName = "差旅_王小明\r\nX-Injected: evil_2026-03-15_TRV-202608-0001.pdf";
    const header = buildReportContentDisposition("TRV-202608-0001", maliciousFileName);

    expect(header).not.toMatch(/[\r\n]/);
    expect(header).not.toContain("X-Injected:");
    expect(header).toContain("%0D%0A");
  });

  it("reportNumber 含不安全字元（結構性防線，理論上不可達）→ 拋錯而非默默放行不安全 ASCII fallback", () => {
    expect(() => buildReportContentDisposition("TRV/202608/0001", "x.pdf")).toThrow();
  });

  it("encodeRfc5987ValueChars：encodeURIComponent 未跳脫之 '()* 另補跳脫", () => {
    const encoded = encodeRfc5987ValueChars("a'b(c)d*e");
    expect(encoded).not.toMatch(/['()*]/);
    expect(encoded).toBe("a%27b%28c%29d%2Ae");
  });
});

// ---------------------------------------------------------------------------
// §B DB／HTTP fixture 套件
// ---------------------------------------------------------------------------

describeWithDb("PHASE-008-T9 — GET /applications/:id/report ／ GET .../report/pdf", () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let attachmentStorageRoot: string;
  let reportStorageRoot: string;
  let logLines: string[];

  let ownerId: string;
  let ownerCookie: string;
  let strangerCookie: string;
  let adminCookie: string;
  let mustChangeCookie: string;
  let crlfOwnerId: string;
  let crlfOwnerCookie: string;
  let emojiOwnerId: string;
  let emojiOwnerCookie: string;

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
        primaryDate: new Date("2026-03-15T00:00:00.000Z"),
        totalAmount,
        completedAt: new Date(),
        travel: {
          create: {
            tripDate: new Date("2026-03-15T00:00:00.000Z"),
            purpose: `PHASE-008-T9 測試出差-${suffix}`,
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

  /** 產生報表（HTTP，等同使用者操作），回傳 `{ id, body }`。 */
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
        loginName: `p8t9_owner_${RUN_ID}`,
        displayName: "P8T9 擁有人",
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
        loginName: `p8t9_stranger_${RUN_ID}`,
        displayName: "P8T9 陌生人",
        passwordHash: await hashPassword(PASSWORD),
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    createdUserIds.push(stranger.id);

    const admin = await prisma.user.create({
      data: {
        loginName: `p8t9_admin_${RUN_ID}`,
        displayName: "P8T9 管理員",
        passwordHash: await hashPassword(PASSWORD),
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    createdUserIds.push(admin.id);

    const mustChangeUser = await prisma.user.create({
      data: {
        loginName: `p8t9_mustchg_${RUN_ID}`,
        displayName: "P8T9 待改密",
        passwordHash: await hashPassword(PASSWORD),
        role: "USER",
        isActive: true,
        mustChangePassword: true,
      },
    });
    createdUserIds.push(mustChangeUser.id);

    // AC-22 wire-level fixture：姓名含 \r\n 與標頭分隔字元 `:`。
    const crlfOwner = await prisma.user.create({
      data: {
        loginName: `p8t9_crlf_${RUN_ID}`,
        displayName: "王小明\r\nX-Injected: evil",
        passwordHash: await hashPassword(PASSWORD),
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    crlfOwnerId = crlfOwner.id;
    createdUserIds.push(crlfOwner.id);

    // T3R/期中 FW-2 同型驗證（wire-level）：姓名含非 BMP 字元（emoji，
    // U+1F600 為代理對，非單一 UTF-16 code unit）——確認 Content-Disposition
    // 之百分比編碼整鏈不 500（encodeURIComponent 孤兒代理已於 T3
    // sanitizeDisplayName 之 Array.from 逐碼點處理封閉，本層驗證整鏈）。
    const emojiOwner = await prisma.user.create({
      data: {
        loginName: `p8t9_emoji_${RUN_ID}`,
        displayName: "王小明😀🎉",
        passwordHash: await hashPassword(PASSWORD),
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    emojiOwnerId = emojiOwner.id;
    createdUserIds.push(emojiOwner.id);

    attachmentStorageRoot = makeTempStorageRoot("att");
    reportStorageRoot = makeTempStorageRoot("rpt");

    const capture = makeLogCapture();
    logLines = capture.lines;

    app = await buildServer({
      databaseUrl: DB_URL,
      storageRoot: attachmentStorageRoot,
      reportStorageRoot,
      logStream: capture.stream,
    });
    await app.ready();

    ownerCookie = await loginUser(app, owner.loginName, PASSWORD);
    strangerCookie = await loginUser(app, stranger.loginName, PASSWORD);
    adminCookie = await loginUser(app, admin.loginName, PASSWORD);
    mustChangeCookie = await loginUser(app, mustChangeUser.loginName, PASSWORD);
    crlfOwnerCookie = await loginUser(app, crlfOwner.loginName, PASSWORD);
    emojiOwnerCookie = await loginUser(app, emojiOwner.loginName, PASSWORD);
  });

  afterAll(async () => {
    if (!prisma) return;
    await app.close();
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
  // 前都重新套用合成實作，不受外層 afterEach 之 vi.restoreAllMocks() 影響
  // （見檔頭「渲染器 mock 策略」）。
  beforeEach(() => {
    vi.mocked(renderPdf).mockImplementation(async () => Buffer.from(FAKE_PDF_BYTES));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // B-03：不存在之申請 id
  // -------------------------------------------------------------------------

  describe("B-03：不存在之申請 id", () => {
    it("查詢 → 404 NOT_FOUND", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/applications/nonexistent-app-id/report",
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(404);
      expect(JSON.parse(resp.body).error.code).toBe("NOT_FOUND");
    });

    it("下載 → 404 NOT_FOUND", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/applications/nonexistent-app-id/report/pdf",
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(404);
      expect(JSON.parse(resp.body).error.code).toBe("NOT_FOUND");
    });
  });

  // -------------------------------------------------------------------------
  // §D10／B-27：尚未產生報表
  // -------------------------------------------------------------------------

  describe("D10／B-27：尚未產生報表", () => {
    it("查詢 → 200 { report: null }（非 404）", async () => {
      const id = await createTravelApp(ownerId, "empty-query");
      const resp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(200);
      expect(JSON.parse(resp.body)).toEqual({ report: null });
    });

    it("下載 → 404 NOT_FOUND，訊息為「尚未產生正式報表」", async () => {
      const id = await createTravelApp(ownerId, "empty-download");
      const resp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report/pdf`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(404);
      const body = JSON.parse(resp.body);
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toBe("尚未產生正式報表");
    });
  });

  // -------------------------------------------------------------------------
  // AC-24：授權矩陣（查詢／下載兩列 × 5 身分）
  // -------------------------------------------------------------------------

  describe("AC-24：授權矩陣 — 查詢端點", () => {
    it("未登入 → 401 UNAUTHORIZED", async () => {
      const id = await createTravelApp(ownerId, "authz-query-401");
      const resp = await app.inject({ method: "GET", url: `/applications/${id}/report` });
      expect(resp.statusCode).toBe(401);
      expect(JSON.parse(resp.body).error.code).toBe("UNAUTHORIZED");
    });

    it("需強制改密 → 403 PASSWORD_CHANGE_REQUIRED", async () => {
      const id = await createTravelApp(ownerId, "authz-query-pwreq");
      const resp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report`,
        headers: { cookie: mustChangeCookie },
      });
      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    });

    it("本人（擁有人）→ 200，含已產生之 ReportDto", async () => {
      const id = await createTravelApp(ownerId, "authz-query-owner");
      const gen = await generateReportViaHttp(id, ownerCookie);
      expect(gen.statusCode).toBe(201);

      const resp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body);
      expect(body.report.reportNumber).toBe(gen.body.report.reportNumber);
    });

    it("他人（一般使用者）→ 403 FORBIDDEN，回應不含報表編號／檔名／金額／姓名", async () => {
      const id = await createTravelApp(ownerId, "authz-query-stranger", 987);
      const gen = await generateReportViaHttp(id, ownerCookie);
      expect(gen.statusCode).toBe(201);

      const resp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report`,
        headers: { cookie: strangerCookie },
      });
      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.code).toBe("FORBIDDEN");
      expect(resp.body).not.toContain(gen.body.report.reportNumber);
      expect(resp.body).not.toContain(gen.body.report.fileName);
      expect(resp.body).not.toContain("987");
      expect(resp.body).not.toContain("P8T9 擁有人");
    });

    it("管理員 → 200，含已產生之 ReportDto（可見面不擴張，AC-18(b) 精神同型）", async () => {
      const id = await createTravelApp(ownerId, "authz-query-admin");
      const gen = await generateReportViaHttp(id, ownerCookie);
      expect(gen.statusCode).toBe(201);

      const resp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body);
      expect(body.report.reportNumber).toBe(gen.body.report.reportNumber);
    });
  });

  describe("AC-24：授權矩陣 — 下載端點", () => {
    it("未登入 → 401 UNAUTHORIZED", async () => {
      const id = await createTravelApp(ownerId, "authz-dl-401");
      const resp = await app.inject({ method: "GET", url: `/applications/${id}/report/pdf` });
      expect(resp.statusCode).toBe(401);
      expect(JSON.parse(resp.body).error.code).toBe("UNAUTHORIZED");
    });

    it("需強制改密 → 403 PASSWORD_CHANGE_REQUIRED", async () => {
      const id = await createTravelApp(ownerId, "authz-dl-pwreq");
      const resp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report/pdf`,
        headers: { cookie: mustChangeCookie },
      });
      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    });

    it("本人（擁有人）→ 200 application/pdf", async () => {
      const id = await createTravelApp(ownerId, "authz-dl-owner");
      const gen = await generateReportViaHttp(id, ownerCookie);
      expect(gen.statusCode).toBe(201);

      const resp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report/pdf`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(200);
      expect(resp.headers["content-type"]).toBe("application/pdf");
    });

    it("他人（一般使用者）→ 403 FORBIDDEN，回應不含報表編號／檔名／金額／姓名", async () => {
      const id = await createTravelApp(ownerId, "authz-dl-stranger", 654);
      const gen = await generateReportViaHttp(id, ownerCookie);
      expect(gen.statusCode).toBe(201);

      const resp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report/pdf`,
        headers: { cookie: strangerCookie },
      });
      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.code).toBe("FORBIDDEN");
      expect(resp.headers["content-type"]).not.toBe("application/pdf");
      expect(resp.body).not.toContain(gen.body.report.reportNumber);
      expect(resp.body).not.toContain(gen.body.report.fileName);
      expect(resp.body).not.toContain("654");
      expect(resp.body).not.toContain("P8T9 擁有人");
    });

    it("管理員 → 200 application/pdf", async () => {
      const id = await createTravelApp(ownerId, "authz-dl-admin");
      const gen = await generateReportViaHttp(id, ownerCookie);
      expect(gen.statusCode).toBe(201);

      const resp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report/pdf`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(200);
      expect(resp.headers["content-type"]).toBe("application/pdf");
    });
  });

  // -------------------------------------------------------------------------
  // AC-08：重下提供原保存檔
  // -------------------------------------------------------------------------

  describe("AC-08：兩次下載位元組全等 ＋ 渲染器零呼叫", () => {
    it("兩次下載之回應位元組逐位元全等、等於保存值；Content-Type: application/pdf；renderPdf/renderReportHtml 於下載期間零額外呼叫", async () => {
      const id = await createTravelApp(ownerId, "ac08");
      const gen = await generateReportViaHttp(id, ownerCookie);
      expect(gen.statusCode).toBe(201);

      const row = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });

      const renderPdfCallsBefore = vi.mocked(renderPdf).mock.calls.length;
      const renderHtmlCallsBefore = vi.mocked(renderReportHtml).mock.calls.length;

      const first = await app.inject({
        method: "GET",
        url: `/applications/${id}/report/pdf`,
        headers: { cookie: ownerCookie },
      });
      const second = await app.inject({
        method: "GET",
        url: `/applications/${id}/report/pdf`,
        headers: { cookie: ownerCookie },
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.headers["content-type"]).toBe("application/pdf");
      expect(second.headers["content-type"]).toBe("application/pdf");

      // 逐位元全等（Buffer.equals，非字串比對——PDF 為二進位內容）。
      expect(Buffer.compare(first.rawPayload, second.rawPayload)).toBe(0);

      // 等於產生當時保存之位元組（雜湊比對）。
      const firstHash = crypto.createHash("sha256").update(first.rawPayload).digest("hex");
      expect(firstHash).toBe(row.contentHash);
      expect(first.rawPayload.length).toBe(row.byteSize);

      // 渲染器 spy 零呼叫（證明是讀檔而非重算；「下載時重新渲染」mutant 必紅）。
      expect(vi.mocked(renderPdf).mock.calls.length).toBe(renderPdfCallsBefore);
      expect(vi.mocked(renderReportHtml).mock.calls.length).toBe(renderHtmlCallsBefore);
    });
  });

  // -------------------------------------------------------------------------
  // AC-22：Content-Disposition 雙形式 wire-level（含 \r\n 姓名 fixture）
  // -------------------------------------------------------------------------

  describe("AC-22：Content-Disposition 雙形式與標頭注入封閉（端到端）", () => {
    it("正常姓名：回應同時含 ASCII fallback 與 RFC 5987 形式，且皆與保存值一致", async () => {
      const id = await createTravelApp(ownerId, "ac22-normal");
      const gen = await generateReportViaHttp(id, ownerCookie);
      expect(gen.statusCode).toBe(201);

      const row = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });

      const resp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report/pdf`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(200);

      const disposition = resp.headers["content-disposition"];
      expect(typeof disposition).toBe("string");
      const dispositionStr = disposition as string;

      expect(dispositionStr).toContain(`filename="${row.reportNumber}.pdf"`);
      expect(dispositionStr).toMatch(/filename\*=UTF-8''/);
      const rfc5987Part = dispositionStr.match(/filename\*=UTF-8''(\S+)$/)?.[1] ?? "";
      expect(decodeURIComponent(rfc5987Part)).toBe(row.fileName);
    });

    it("含 \\r\\n 之姓名 fixture：下載成功（200），回應標頭數量與內容未被注入（wire-level 斷言）", async () => {
      const id = await createTravelApp(crlfOwnerId, "ac22-crlf");
      const gen = await generateReportViaHttp(id, crlfOwnerCookie);
      expect(gen.statusCode).toBe(201);

      const row = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });
      // 前置事實：sanitizeDisplayName（T3，既有）已使檔名不含裸 \r\n 與 ':'。
      expect(row.fileName).not.toMatch(/[\r\n]/);
      expect(row.fileName).not.toContain(":");

      const resp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report/pdf`,
        headers: { cookie: crlfOwnerCookie },
      });
      expect(resp.statusCode).toBe(200);

      // 未被注入之標頭鍵（未出現任何 x-injected 之類額外標頭）。
      expect(Object.keys(resp.headers)).not.toContain("x-injected");

      // Content-Disposition 為單一字串（非陣列——未因注入而被拆成多個標頭）。
      const disposition = resp.headers["content-disposition"];
      expect(typeof disposition).toBe("string");
      const dispositionStr = disposition as string;
      expect(dispositionStr).not.toMatch(/[\r\n]/);
      expect(dispositionStr).not.toContain("X-Injected:");
      expect(dispositionStr).toContain(`filename="${row.reportNumber}.pdf"`);

      const rfc5987Part = dispositionStr.match(/filename\*=UTF-8''(\S+)$/)?.[1] ?? "";
      expect(decodeURIComponent(rfc5987Part)).toBe(row.fileName);
    });

    it("T3R/期中 FW-2 同型：含非 BMP 字元（emoji，代理對）之姓名 fixture → 下載成功（200，不 500），百分比編碼可還原、無孤兒代理", async () => {
      const id = await createTravelApp(emojiOwnerId, "ac22-emoji");
      const gen = await generateReportViaHttp(id, emojiOwnerCookie);
      expect(gen.statusCode).toBe(201);

      const row = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });

      const resp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report/pdf`,
        headers: { cookie: emojiOwnerCookie },
      });
      // 鑑別力核心：encodeURIComponent 若餵入孤兒代理（unpaired surrogate）
      // 會擲出 URIError；本斷言確認整鏈（sanitizeDisplayName → 檔名組裝 →
      // Content-Disposition 編碼）不因非 BMP 字元 500。
      expect(resp.statusCode).toBe(200);

      const disposition = resp.headers["content-disposition"];
      expect(typeof disposition).toBe("string");
      const dispositionStr = disposition as string;
      expect(dispositionStr).toContain(`filename="${row.reportNumber}.pdf"`);

      const rfc5987Part = dispositionStr.match(/filename\*=UTF-8''(\S+)$/)?.[1] ?? "";
      const decoded = decodeURIComponent(rfc5987Part);
      expect(decoded).toBe(row.fileName);
      // 正向對照：確認 fixture 確實含代理對（非本測試恆真）。
      expect(row.fileName).toMatch(/[\uD800-\uDBFF][\uDC00-\uDFFF]/);
    });
  });

  // -------------------------------------------------------------------------
  // AC-23：檔名於產生時持久化、重下一致
  // -------------------------------------------------------------------------

  describe("AC-23：檔名於產生時凍結，事後改名不影響已產生報表之下載檔名", () => {
    it("產生後修改 displayName 再下載 → Content-Disposition 之檔名逐字不變", async () => {
      const renamedOwner = await prisma.user.create({
        data: {
          loginName: `p8t9_ac23_${RUN_ID}`,
          displayName: "改名前姓名",
          passwordHash: await hashPassword(PASSWORD),
          role: "USER",
          isActive: true,
          mustChangePassword: false,
        },
      });
      createdUserIds.push(renamedOwner.id);
      const renamedOwnerCookie = await loginUser(app, renamedOwner.loginName, PASSWORD);

      const id = await createTravelApp(renamedOwner.id, "ac23");
      const gen = await generateReportViaHttp(id, renamedOwnerCookie);
      expect(gen.statusCode).toBe(201);
      const originalFileName = gen.body.report.fileName as string;
      expect(originalFileName).toContain("改名前姓名");

      const firstDownload = await app.inject({
        method: "GET",
        url: `/applications/${id}/report/pdf`,
        headers: { cookie: renamedOwnerCookie },
      });
      const firstDisposition = firstDownload.headers["content-disposition"] as string;

      await prisma.user.update({
        where: { id: renamedOwner.id },
        data: { displayName: "改名後姓名" },
      });

      const secondDownload = await app.inject({
        method: "GET",
        url: `/applications/${id}/report/pdf`,
        headers: { cookie: renamedOwnerCookie },
      });
      expect(secondDownload.statusCode).toBe(200);
      const secondDisposition = secondDownload.headers["content-disposition"] as string;

      // 「下載時即時推導檔名」之 mutant 必紅：兩次下載之 Content-Disposition
      // 逐字相同，且皆仍含改名前之姓名段（不含改名後姓名）。
      expect(secondDisposition).toBe(firstDisposition);
      expect(
        decodeURIComponent(secondDisposition.match(/filename\*=UTF-8''(\S+)$/)?.[1] ?? "")
      ).toBe(originalFileName);
      expect(secondDisposition).not.toContain(encodeURIComponent("改名後姓名"));

      // 查詢端點之 fileName 亦不變。
      const queryResp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report`,
        headers: { cookie: renamedOwnerCookie },
      });
      expect(JSON.parse(queryResp.body).report.fileName).toBe(originalFileName);
    });
  });

  // -------------------------------------------------------------------------
  // AC-27（DTO 側）：ReportDto 鍵集恰為六鍵
  // -------------------------------------------------------------------------

  describe("AC-27：ReportDto 鍵集恰為六鍵（查詢端點側，toEqual 全等）", () => {
    it("查詢端點回應之 report 鍵集恰為 { reportNumber, generatedAt, fileName, byteSize, downloadUrl, printUrl }", async () => {
      const id = await createTravelApp(ownerId, "ac27");
      const gen = await generateReportViaHttp(id, ownerCookie);
      expect(gen.statusCode).toBe(201);

      const resp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report`,
        headers: { cookie: ownerCookie },
      });
      const body = JSON.parse(resp.body);
      expect(Object.keys(body.report).sort()).toEqual(
        ["reportNumber", "generatedAt", "fileName", "byteSize", "downloadUrl", "printUrl"].sort()
      );
      expect(body.report.downloadUrl).toBe(`/applications/${id}/report/pdf`);
      expect(body.report.printUrl).toBe(`/applications/${id}/report/print`);
    });
  });

  // -------------------------------------------------------------------------
  // B-28：已產生但 storage 檔案遺失
  // -------------------------------------------------------------------------

  describe("B-28：已產生但 storage 檔案遺失", () => {
    it("下載 → 404 NOT_FOUND（不得 500），錯誤日誌不含 storage key", async () => {
      const id = await createTravelApp(ownerId, "b28");
      const gen = await generateReportViaHttp(id, ownerCookie);
      expect(gen.statusCode).toBe(201);

      const row = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });
      const filePath = path.join(reportStorageRoot, ...row.storageKey.split("/"));
      expect(fs.existsSync(filePath)).toBe(true);
      fs.unlinkSync(filePath);

      const logLineCountBefore = logLines.length;

      const resp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report/pdf`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(404);
      const body = JSON.parse(resp.body);
      expect(body.error.code).toBe("NOT_FOUND");
      // 回應不含 storage key。
      expect(resp.body).not.toContain(row.storageKey);
      expect(resp.body).not.toContain(reportStorageRoot);

      // 新增之日誌行不含 storage key 或 volume 絕對路徑（反向探針：確認掃描
      // 對象確實有新日誌產生，非恆真式通過）。
      const newLines = logLines.slice(logLineCountBefore);
      expect(newLines.length).toBeGreaterThan(0);
      for (const line of newLines) {
        expect(line).not.toContain(row.storageKey);
        expect(line).not.toContain(reportStorageRoot);
      }
    });
  });
});
