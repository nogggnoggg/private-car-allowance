/**
 * PHASE-008-T11 — 錯誤合約與日誌安全（AC-28／AC-29）
 *
 * ---------------------------------------------------------------------------
 * 規範出處（Spec `docs/specs/PHASE-008.md`）
 * ---------------------------------------------------------------------------
 * AC-28：`ErrorCode` 聯集全等（基線 ＋ 本 Phase 新增之 `REPORT_GENERATION_FAILED`，
 *   多一碼／少一碼必紅；BOGUS mutant 必紅）；四端點之錯誤表（§7.5）逐格斷
 *   言：401／403 PASSWORD_CHANGE_REQUIRED／403 FORBIDDEN／404 NOT_FOUND／
 *   409 CONFLICT／500 REPORT_GENERATION_FAILED 各有正例；錯誤回應不外洩堆
 *   疊、DB 結構、storage key 或絕對路徑。
 * AC-29（NFR-US-16）：以 `logStream` 掃描：日誌不含 storageKey、volume 絕對
 *   路徑、session cookie／token、密碼、PDF 位元組或其 base64 片段、以及折
 *   舊之車價／折舊年限；`requestId` 在場可供追查；渲染失敗之日誌含可追查
 *   識別但不含上述任一。反向探針（刻意寫入敏感字串）證明掃描非恆真。
 * §7.5：新增 `REPORT_GENERATION_FAILED`（500）＋ `details.stage ∈ {RENDER,
 *   STORE, VERIFY, PERSIST}`（封閉四值）；409 列（D11）僅適用產生／列印兩
 *   端點——SPEC-REV-T9 修訂後，下載／查詢兩端點不做狀態守門（下載尚未產
 *   生一律 404、查詢一律 200 `{report:null}`，不帶 `details.status`）。
 * §15 T11 列：`ErrorCode` 聯集全等（BOGUS mutant 必紅）；四端點錯誤表逐
 *   格；七類日誌掃描 ＋ 反向探針。
 * §11.1 pdf-renderer 列：本檔不涉及 PDF 引擎選項組裝（該範圍屬
 *   `phase8-pdf-render.test.ts`）；本檔僅以 `pdf-renderer.ts` 之路徑名列
 *   入 PHASE_008_SRC_FILES 結構清單（見下）。
 *
 * ---------------------------------------------------------------------------
 * 六項累積移交（Task Packet 逐項核銷）
 * ---------------------------------------------------------------------------
 * 1. §A：`errors.ts` 之 `ErrorCode` 聯集新增 `REPORT_GENERATION_FAILED`；聯
 *    集全等測試（基線＋新碼；多/少一碼必紅；BOGUS mutant 必紅——見 Task
 *    Handoff 附驗證階段暫改復原之紅燈證據，沿 `phase7-contract.test.ts`
 *    既有慣例，不將暫改烙入本檔最終內容）。§A 第二則測試複核 T8/T9/T10
 *    routes.ts／report-service.ts 之 `buildErrorBody("REPORT_GENERATION_
 *    FAILED", ...)` 繞道字面——確認新增聯集成員後該繞道原樣可用（`code`
 *    參數型別為 `string`，不需修改呼叫端；本檔驗證階段已另行執行 `tsc
 *    --noEmit` 確認零型別錯誤，見 Task Handoff）。
 * 2. §D-2：四端點 404 契約（不存在申請 id）——T10 即審 AR-1「B-03 產生／
 *    列印零測試（M11/M12 穿透）」之直接關閉：四端點對不存在之申請 id 皆
 *    404 NOT_FOUND，逐格斷言。
 * 3. §E：`logStream` 七類掃描擴充——禁字含 `rpt/`、`att/`（storage key 前
 *    綴，非僅特定實例值）、report／attachment volume 絕對路徑、session
 *    cookie／token、密碼、折舊車價／折舊年限（PDF 位元組／base64 片段以
 *    「零 `%PDF-` 樣式字串」之負向確認併入同一測試，理由見 §E 檔頭）；列
 *    印路徑（`GET .../report/print`，`embedImages` 之 logger 走
 *    `request.log.error`）納入掃描範圍（非僅產生／下載路徑）。
 * 4. §C／§D-6：`details.stage` 四值封閉——結構性斷言 `ReportFailureStage`
 *    型別聯集恰為四值；`PERSIST` 分支（`report-service.ts` 之
 *    `generateReport` 外層 catch，重試耗盡或不可重試之 DB 衝突）現實務上
 *    僅由機率性併發探針（`phase8-report-generate.test.ts` MF-3）觸及、非
 *    確定性——本檔以 `prisma.$transaction` 之最小 Proxy 攔截（僅覆寫
 *    `$transaction`，其餘方法透傳真實 `PrismaClient`）確定性補一例：注入
 *    一個非 Prisma、非可重試之泛用 `Error`，使 `generateOnceWithRetry` 於
 *    首次嘗試即判定不可重試並拋出，`generateReport` 外層 catch 轉譯為
 *    `ReportGenerationError("PERSIST")`——純測試檔手法，未修改
 *    `report-service.ts`（Forbidden）。
 * 5. §D-7：下載端點兩種 404 訊息逐字——B-27「尚未產生正式報表」（無
 *    `Report` 列）／B-28「報表檔案遺失」（`Report` 列在、storage 檔案缺）
 *    各一正例，逐字比對（非僅比對 `code`）。
 * 6. §B：`PHASE_008_SRC_FILES` 結構清單（T4 即審 FW-5「T11 PHASE_008_
 *    SRC_FILES 清單＋日誌掃描擴 storageKey 與折舊字面」之落地）——八檔
 *    （`report-number.ts`／`report-filename.ts`／`report-data.ts`／
 *    `report-html.ts`／`report-images.ts`／`pdf-renderer.ts`／
 *    `report-service.ts`／`routes.ts`）之固定清單與 `backend/src/reports/`
 *    目錄之實際 `.ts` 檔案清單 `toEqual` 自證（新增／刪除 src 檔而未同步
 *    更新本清單即紅）。**不觸碰** `phase7-contract.test.ts` 之
 *    `PHASE_007_SRC_FILES`（Forbidden，零 diff）。
 *
 * ---------------------------------------------------------------------------
 * §7.5 表格對齊（409 列限產生／列印；下載／查詢不適用之負向確認）
 * ---------------------------------------------------------------------------
 * SPEC-REV-T9（2026-08-06 人類裁定）修訂後：`409 CONFLICT + details.status`
 * 僅作用於**產生**與**列印**兩端點；下載／查詢兩端點對同一 DRAFT 申請**不**
 * 回 409——下載回 `404 NOT_FOUND`（B-27 同一列，不帶 `details`）、查詢回
 * `200 { report: null }`（非錯誤）。§D-5 對同一筆 DRAFT 申請四端點逐一驗
 * 證此表格對齊，含下載／查詢之負向確認（明確斷言其 statusCode **不是**
 * 409、body **不含** `details.status`）。
 *
 * ---------------------------------------------------------------------------
 * TDD 與紀律（Spec §11.0）
 * ---------------------------------------------------------------------------
 * 本檔開工前 `errors.ts` 之 `ErrorCode` 聯集尚未收錄 `REPORT_GENERATION_
 * FAILED`（T8/T9/T10 皆繞道 `buildErrorBody` 字面量，見各檔檔頭）——§A 第
 * 一則測試在 `errors.ts` 修改前執行必為紅燈（斷言 14 碼聯集，實際僅 13
 * 碼）；修改後轉綠。BOGUS mutant／聯集增減 mutant 之紅燈證據見 Task
 * Handoff（暫改 `errors.ts` 或本檔 `KNOWN_ERROR_CODES` 並復原，不進入最終
 * diff，沿 `phase7-contract.test.ts` 既有慣例）。禁止 spawn 任何
 * subagent；合成資料；`loginName` 前綴 `p8t11_`，與既有測試檔前綴互不重
 * 疊；清理一律以本套件自建 id 精確比對，禁用全域 `deleteMany({})`。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";
import { LocalVolumeStorage } from "../../src/storage/index.js";

// ── report-html.ts／pdf-renderer.ts：呼叫穿透之 spy 包裝（沿
//    phase8-report-generate.test.ts 之既有慣例：預設呼叫真實實作，個別測
//    試可 mockImplementationOnce 覆寫以注入單次失敗）───────────────────────
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
import { type ReportServiceDeps, generateReport } from "../../src/reports/report-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p8t11_";
const PASSWORD = "T11ContractFixtureP@ss99";

// 合成 PDF 位元組（%PDF- 開頭／%%EOF 結尾／長度 > 1024）——本檔不驗證 PDF
// 引擎本身（屬 phase8-pdf-render.test.ts），故全檔以合成替身取代真實
// Chromium，僅換取端點配線之速度。
const FAKE_PDF_BYTES = Buffer.from(
  `%PDF-1.4\n% synthetic fixture for PHASE-008-T11 contract tests\n${"X".repeat(1200)}\n%%EOF`
);

function makeTempStorageRoot(prefixLabel: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `phase8-contract-${prefixLabel}-`));
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

async function loginUser(app: FastifyInstance, loginName: string, password: string) {
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

/**
 * log 行本身為 JSON 序列化字串——若欲比對之值含反斜線（Windows 絕對路
 * 徑），該值出現於 log 行內時反斜線會被 JSON 序列化跳脫為兩個反斜線；直
 * 接以原始字串（單反斜線）比對會在 Windows 上恆真式地找不到（vacuous
 * pass，無論是否真的洩漏）。以 `JSON.stringify` 還原「該值出現在 JSON 字
 * 串內時的實際位元組序列」再比對，跨平台皆正確（POSIX 路徑無反斜線，兩
 * 者等價，行為不變）。本檔§E 之反向探針即實測發現此陷阱（見 Task
 * Handoff）——修復前之天真 `.toContain(rawPath)` 比對對 Windows 絕對路
 * 徑恆假，本 helper 為直接修復。
 */
function toLogSearchable(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    fields?: unknown;
    details?: unknown;
  };
}

/**
 * §7.5 尾句：錯誤回應不外洩堆疊、DB 結構、storage key 或絕對路徑（沿
 * `phase7-contract.test.ts` 之 `expectUnifiedErrorShape` 既有慣例，改為本
 * 檔獨立複本——各 Phase 之 contract 測試檔慣例上各自持有一份，非共用抽
 * 象，避免跨 Phase 測試檔之隱性耦合）。
 */
function expectNoLeakage(body: ErrorBody) {
  expect(body.error).toBeDefined();
  const errorObj = body.error as Record<string, unknown>;
  expect(typeof errorObj.code).toBe("string");
  expect(typeof errorObj.message).toBe("string");
  expect(typeof errorObj.requestId).toBe("string");
  expect((errorObj.requestId as string).length).toBeGreaterThan(0);

  const serialized = JSON.stringify(body);
  expect(serialized).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // 堆疊行樣式
  expect(serialized).not.toMatch(/[A-Za-z]:\\\\?[\w\\/. -]+\.ts/); // Windows 絕對路徑
  expect(serialized).not.toMatch(/\/(home|usr|Users)\/[\w./-]+/); // POSIX 絕對路徑
  expect(serialized.toUpperCase()).not.toMatch(/\bSELECT\b|\bINSERT\b|\bPRISMACLIENT/i);
  expect(serialized).not.toMatch(/\brpt\//); // storage key 前綴（報表）
  expect(serialized).not.toMatch(/\batt\//); // storage key 前綴（附件）
}

// ===========================================================================
// §A — AC-28 結構性：ErrorCode 聯集全等 ＋ PHASE-008 reports/ src 僅用基線
// 字面值（不需 DB，恆執行）
// ===========================================================================

describe("AC-28 結構性 — ErrorCode 聯集全等 + PHASE-008 reports/ src 僅用基線字面值", () => {
  const errorsSrc = fs.readFileSync(path.join(BACKEND_ROOT, "src/platform/errors.ts"), "utf-8");

  /** 基線（PHASE-001~PHASE-007 累積，見 `phase7-contract.test.ts` 同名陣
   * 列）＋ 本 Phase（PHASE-008）新增之恰一碼 `REPORT_GENERATION_FAILED`
   * （§7.5／D5）。與此陣列不符即紅——本 Task Done When「ErrorCode 聯集全
   * 等（BOGUS mutant 必紅）」之對象。 */
  const KNOWN_ERROR_CODES = [
    "VALIDATION_ERROR",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "PASSWORD_CHANGE_REQUIRED",
    "NOT_FOUND",
    "UNSUPPORTED_MEDIA_TYPE",
    "PAYLOAD_TOO_LARGE",
    "CONFLICT",
    "TOO_MANY_ATTACHMENTS",
    "PARAMETER_PERIOD_OVERLAP",
    "PARAMETER_NOT_AVAILABLE",
    "INTERNAL_ERROR",
    "SERVICE_UNAVAILABLE",
    "REPORT_GENERATION_FAILED",
  ].sort();

  it("errors.ts ErrorCode union equals the known baseline + REPORT_GENERATION_FAILED", () => {
    const unionMatch = /export type ErrorCode =([\s\S]*?";)/.exec(errorsSrc);
    expect(unionMatch, "ErrorCode union declaration not found").toBeTruthy();
    const unionBody = unionMatch?.[1] ?? "";
    const unionBodyNoComments = unionBody.replace(/\/\/.*$/gm, "");
    const members = [...unionBodyNoComments.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
    expect(members).toEqual(KNOWN_ERROR_CODES);
  });

  // 本 Phase（PHASE-008）之 `src/reports/` 八檔——逐檔掃描 `new AppError(
  // "XXX"` 與 `buildErrorBody("XXX"`（後者為 T8/T9/T10 之既有繞道字面量，
  // 見各檔檔頭「錯誤碼與日誌安全」），斷言全部落在既有聯集內，且
  // REPORT_GENERATION_FAILED 確實被使用（非僅存在於聯集卻無呼叫端）。
  const PHASE_008_REPORTS_SRC_FILES = [
    "src/reports/report-number.ts",
    "src/reports/report-filename.ts",
    "src/reports/report-data.ts",
    "src/reports/report-html.ts",
    "src/reports/report-images.ts",
    "src/reports/pdf-renderer.ts",
    "src/reports/report-service.ts",
    "src/reports/routes.ts",
  ];

  it("PHASE-008 reports/ 原始碼僅使用基線 ErrorCode 字面值（含 buildErrorBody 繞道），且 REPORT_GENERATION_FAILED 確實被使用", () => {
    const usedCodes = new Set<string>();
    let sawAtLeastOneFile = 0;
    for (const rel of PHASE_008_REPORTS_SRC_FILES) {
      const abs = path.join(BACKEND_ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      sawAtLeastOneFile++;
      const content = fs.readFileSync(abs, "utf-8");
      for (const m of content.matchAll(/new AppError\(\s*"([A-Z_]+)"/g)) {
        usedCodes.add(m[1]);
      }
      for (const m of content.matchAll(/buildErrorBody\(\s*"([A-Z_]+)"/g)) {
        usedCodes.add(m[1]);
      }
    }
    expect(sawAtLeastOneFile).toBe(PHASE_008_REPORTS_SRC_FILES.length);
    expect(usedCodes.size).toBeGreaterThan(0);
    expect(usedCodes).toContain("REPORT_GENERATION_FAILED");
    for (const code of usedCodes) {
      expect(KNOWN_ERROR_CODES).toContain(code);
    }
  });
});

// ===========================================================================
// §B — PHASE_008_SRC_FILES 結構清單（T4 即審 FW-5；自證，不動 PHASE-007 清單）
// ===========================================================================

describe("PHASE_008_SRC_FILES 結構清單自證（T4 即審 FW-5）", () => {
  /** 固定八檔清單（相對 `backend/src/reports/` 之檔名，不含路徑前綴）。 */
  const PHASE_008_SRC_FILES = [
    "report-number.ts",
    "report-filename.ts",
    "report-data.ts",
    "report-html.ts",
    "report-images.ts",
    "pdf-renderer.ts",
    "report-service.ts",
    "routes.ts",
  ];

  it("固定八檔清單與 backend/src/reports/ 目錄之實際 .ts 檔案清單逐一相符（新增/刪除 src 檔而未同步更新本清單即紅）", () => {
    const reportsDir = path.join(BACKEND_ROOT, "src/reports");
    const actualFiles = fs
      .readdirSync(reportsDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .sort();
    expect([...PHASE_008_SRC_FILES].sort()).toEqual(actualFiles);
    // 正向對照：清單非空（非因目錄不存在而恆真通過）。
    expect(actualFiles.length).toBe(8);
  });
});

// ===========================================================================
// §C — details.stage 值域封閉（結構；不需 DB）
// ===========================================================================

describe("details.stage 四值封閉（結構）", () => {
  it("ReportFailureStage 型別聯集恰為 RENDER/STORE/VERIFY/PERSIST 四值（多一/少一值必紅）", () => {
    const src = fs.readFileSync(path.join(BACKEND_ROOT, "src/reports/report-service.ts"), "utf-8");
    const match = /export type ReportFailureStage =([\s\S]*?;)/.exec(src);
    expect(match, "ReportFailureStage type declaration not found").toBeTruthy();
    const body = match?.[1] ?? "";
    const values = [...body.matchAll(/"([A-Z]+)"/g)].map((m) => m[1]);
    expect(values).toEqual(["RENDER", "STORE", "VERIFY", "PERSIST"]);
  });
});

// ===========================================================================
// §D — DB／HTTP fixture 套件：四端點錯誤合約（§7.5 逐格）
// ===========================================================================

describeWithDb(
  "PHASE-008-T11 — 四端點錯誤合約（§7.5；四端點皆 /applications/:id/report...）",
  () => {
    let prisma: PrismaClient;
    let app: FastifyInstance;
    let attachmentStorageRoot: string;
    let reportStorageRoot: string;

    let ownerId: string;
    let ownerCookie: string;
    let strangerCookie: string;
    let mustChangeCookie: string;

    const createdApplicationIds: string[] = [];
    const createdUserIds: string[] = [];

    const NONEXISTENT_ID = "00000000-0000-0000-0000-000000000000";

    async function createUser(labelSuffix: string, opts: { mustChangePassword?: boolean } = {}) {
      const loginName = `${LOGIN_PREFIX}${labelSuffix}_${RUN_ID}`;
      const user = await prisma.user.create({
        data: {
          loginName,
          displayName: `T11 ${labelSuffix}`,
          passwordHash: await hashPassword(PASSWORD),
          role: "USER",
          isActive: true,
          mustChangePassword: opts.mustChangePassword ?? false,
        },
      });
      createdUserIds.push(user.id);
      const cookie = await loginUser(app, loginName, PASSWORD);
      return { id: user.id, cookie };
    }

    async function createCompletedTravelApp(suffix: string): Promise<string> {
      const created = await prisma.application.create({
        data: {
          type: "TRAVEL",
          status: "COMPLETED",
          ownerId,
          createdById: ownerId,
          primaryDate: new Date("2026-03-15T00:00:00.000Z"),
          totalAmount: 500,
          completedAt: new Date(),
          travel: {
            create: {
              tripDate: new Date("2026-03-15T00:00:00.000Z"),
              purpose: `PHASE-008-T11 測試出差-${suffix}`,
              fuelUnitPrice: "2.3456",
              etcUnitPrice: "1.2345",
              snapshotTotalKm: "60.00",
              snapshotRawAmount: "500.0000",
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
                    snapshotRawAmount: "500.0000",
                    snapshotAmount: 500,
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

    async function createDraftTravelApp(): Promise<string> {
      const created = await prisma.application.create({
        data: {
          type: "TRAVEL",
          status: "DRAFT",
          ownerId,
          createdById: ownerId,
          primaryDate: new Date("2026-03-15T00:00:00.000Z"),
        },
      });
      createdApplicationIds.push(created.id);
      return created.id;
    }

    async function generateReportViaHttp(id: string, cookie: string) {
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

      attachmentStorageRoot = makeTempStorageRoot("att-d");
      reportStorageRoot = makeTempStorageRoot("rpt-d");

      app = await buildServer({
        databaseUrl: DB_URL,
        storageRoot: attachmentStorageRoot,
        reportStorageRoot,
        logLevel: "error",
      });
      await app.ready();

      const owner = await createUser("owner");
      ownerId = owner.id;
      ownerCookie = owner.cookie;
      const stranger = await createUser("stranger");
      strangerCookie = stranger.cookie;
      const mustChange = await createUser("mustchg", { mustChangePassword: true });
      mustChangeCookie = mustChange.cookie;
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

    // 沿 T8R SF-1 慣例：置於 beforeEach，避免任一測試之
    // mockImplementationOnce 殘留影響後續測試。
    beforeEach(() => {
      vi.mocked(renderPdf).mockImplementation(async () => Buffer.from(FAKE_PDF_BYTES));
    });

    // -------------------------------------------------------------------------
    // §D-1：401 UNAUTHORIZED（B-30；四端點一致，未登入呼叫）
    // -------------------------------------------------------------------------
    describe("§D-1 — 401 UNAUTHORIZED（B-30：未登入呼叫四端點，回應不含任何業務值）", () => {
      it("四端點皆 401，unified shape，body 不含業務值", async () => {
        const id = NONEXISTENT_ID; // 判定順序：401 先於任何存在性/授權判定
        const results = await Promise.all([
          app.inject({ method: "POST", url: `/applications/${id}/report` }),
          app.inject({ method: "GET", url: `/applications/${id}/report` }),
          app.inject({ method: "GET", url: `/applications/${id}/report/print` }),
          app.inject({ method: "GET", url: `/applications/${id}/report/pdf` }),
        ]);
        for (const resp of results) {
          expect(resp.statusCode).toBe(401);
          const body = JSON.parse(resp.body) as ErrorBody;
          expect(body.error?.code).toBe("UNAUTHORIZED");
          expectNoLeakage(body);
        }
      });
    });

    // -------------------------------------------------------------------------
    // §D-2：403 PASSWORD_CHANGE_REQUIRED（B-29；四端點一致，見 D8）
    // -------------------------------------------------------------------------
    describe("§D-2 — 403 PASSWORD_CHANGE_REQUIRED（B-29：需強制改密之使用者呼叫四端點，四端點一致）", () => {
      it("四端點皆 403 PASSWORD_CHANGE_REQUIRED（先於申請存在性判定——判定順序②）", async () => {
        const id = NONEXISTENT_ID; // 判定順序②：requirePasswordChanged 早於存在性檢查
        const headers = { cookie: mustChangeCookie };
        const results = await Promise.all([
          app.inject({ method: "POST", url: `/applications/${id}/report`, headers }),
          app.inject({ method: "GET", url: `/applications/${id}/report`, headers }),
          app.inject({ method: "GET", url: `/applications/${id}/report/print`, headers }),
          app.inject({ method: "GET", url: `/applications/${id}/report/pdf`, headers }),
        ]);
        for (const resp of results) {
          expect(resp.statusCode).toBe(403);
          const body = JSON.parse(resp.body) as ErrorBody;
          expect(body.error?.code).toBe("PASSWORD_CHANGE_REQUIRED");
          expectNoLeakage(body);
        }
      });
    });

    // -------------------------------------------------------------------------
    // §D-3：404 NOT_FOUND（不存在之申請 id；T10 即審 AR-1「B-03 產生／列印零
    // 測試（M11/M12 穿透）」之直接關閉——四端點皆須覆蓋，非僅下載／查詢）
    // -------------------------------------------------------------------------
    describe("§D-3 — 404 NOT_FOUND（不存在之申請 id；四端點，M11/M12 穿透封閉）", () => {
      it("四端點對不存在之申請 id 皆 404 NOT_FOUND，unified shape，不帶 details", async () => {
        const id = NONEXISTENT_ID;
        const headers = { cookie: ownerCookie };
        const results = await Promise.all([
          app.inject({ method: "POST", url: `/applications/${id}/report`, headers }),
          app.inject({ method: "GET", url: `/applications/${id}/report`, headers }),
          app.inject({ method: "GET", url: `/applications/${id}/report/print`, headers }),
          app.inject({ method: "GET", url: `/applications/${id}/report/pdf`, headers }),
        ]);
        for (const resp of results) {
          expect(resp.statusCode).toBe(404);
          const body = JSON.parse(resp.body) as ErrorBody;
          expect(body.error?.code).toBe("NOT_FOUND");
          expect(body.error?.details).toBeUndefined();
          expectNoLeakage(body);
        }
      });
    });

    // -------------------------------------------------------------------------
    // §D-4：403 FORBIDDEN（他人資料；四端點）——回應不含任何報表編號、檔
    // 名、金額或姓名。
    // -------------------------------------------------------------------------
    describe("§D-4 — 403 FORBIDDEN（他人資料，四端點；回應零業務值）", () => {
      it("四端點對他人之草稿申請皆 403 FORBIDDEN，回應不含金額/姓名等業務值", async () => {
        const id = await createDraftTravelApp(); // owner 所有
        const headers = { cookie: strangerCookie };
        const results = await Promise.all([
          app.inject({ method: "POST", url: `/applications/${id}/report`, headers }),
          app.inject({ method: "GET", url: `/applications/${id}/report`, headers }),
          app.inject({ method: "GET", url: `/applications/${id}/report/print`, headers }),
          app.inject({ method: "GET", url: `/applications/${id}/report/pdf`, headers }),
        ]);
        for (const resp of results) {
          expect(resp.statusCode).toBe(403);
          const body = JSON.parse(resp.body) as ErrorBody;
          expect(body.error?.code).toBe("FORBIDDEN");
          expectNoLeakage(body);
          expect(resp.body).not.toContain("500"); // totalAmount 不會為此值，僅防呆
          expect(resp.body).not.toContain("T11 owner");
        }
      });
    });

    // -------------------------------------------------------------------------
    // §D-5：409 CONFLICT（產生／列印，草稿）＋ 下載／查詢不適用之負向確認
    // （§7.5 修訂後表格對齊；SPEC-REV-T9）
    // -------------------------------------------------------------------------
    describe("§D-5 — 409 CONFLICT（B-01：草稿產生/列印）＋ 下載/查詢不適用（§7.5 修訂後對齊）", () => {
      it("產生與列印對同一 DRAFT 申請皆 409 CONFLICT + details.status='DRAFT'；下載/查詢對同一 DRAFT 申請一律不是 409（下載 404 不帶 details、查詢 200 report:null）", async () => {
        const id = await createDraftTravelApp();
        const headers = { cookie: ownerCookie };

        const genResp = await app.inject({
          method: "POST",
          url: `/applications/${id}/report`,
          headers,
        });
        expect(genResp.statusCode).toBe(409);
        const genBody = JSON.parse(genResp.body) as ErrorBody;
        expect(genBody.error?.code).toBe("CONFLICT");
        expect((genBody.error?.details as { status?: string } | undefined)?.status).toBe("DRAFT");
        expectNoLeakage(genBody);

        const printResp = await app.inject({
          method: "GET",
          url: `/applications/${id}/report/print`,
          headers,
        });
        expect(printResp.statusCode).toBe(409);
        const printBody = JSON.parse(printResp.body) as ErrorBody;
        expect(printBody.error?.code).toBe("CONFLICT");
        expect((printBody.error?.details as { status?: string } | undefined)?.status).toBe("DRAFT");
        expectNoLeakage(printBody);

        // 負向確認：下載端點對同一 DRAFT 申請「不」回 409（回 404，且不帶
        // details——與 B-27「尚未產生報表即下載」同一列，逐字相同語意）。
        const downloadResp = await app.inject({
          method: "GET",
          url: `/applications/${id}/report/pdf`,
          headers,
        });
        expect(downloadResp.statusCode).not.toBe(409);
        expect(downloadResp.statusCode).toBe(404);
        const downloadBody = JSON.parse(downloadResp.body) as ErrorBody;
        expect(downloadBody.error?.code).toBe("NOT_FOUND");
        expect(downloadBody.error?.details).toBeUndefined();

        // 負向確認：查詢端點對同一 DRAFT 申請「不」回 409（回 200，
        // report:null，非錯誤）。
        const queryResp = await app.inject({
          method: "GET",
          url: `/applications/${id}/report`,
          headers,
        });
        expect(queryResp.statusCode).not.toBe(409);
        expect(queryResp.statusCode).toBe(200);
        const queryBody = JSON.parse(queryResp.body) as { report: unknown };
        expect(queryBody.report).toBeNull();
      });
    });

    // -------------------------------------------------------------------------
    // §D-6：500 REPORT_GENERATION_FAILED（正例＋details.stage='RENDER'）
    // -------------------------------------------------------------------------
    describe("§D-6 — 500 REPORT_GENERATION_FAILED（正例，details.stage='RENDER'，不外洩堆疊/路徑/storage key）", () => {
      it("renderReportHtml 於交易內拋錯 → 500 REPORT_GENERATION_FAILED { stage: RENDER }，unified shape 零洩漏", async () => {
        const id = await createCompletedTravelApp("d6-render");
        vi.mocked(renderReportHtml).mockImplementationOnce(() => {
          throw new Error("T11 injected render failure — should never leak into response/log");
        });

        const resp = await app.inject({
          method: "POST",
          url: `/applications/${id}/report`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(500);
        const body = JSON.parse(resp.body) as ErrorBody;
        expect(body.error?.code).toBe("REPORT_GENERATION_FAILED");
        expect((body.error?.details as { stage?: string } | undefined)?.stage).toBe("RENDER");
        expectNoLeakage(body);
        expect(resp.body).not.toContain("T11 injected render failure");

        // 零殘留：本輪失敗未寫入 Report 列。
        const row = await prisma.report.findUnique({ where: { applicationId: id } });
        expect(row).toBeNull();
      });
    });

    // -------------------------------------------------------------------------
    // §D-6b：details.stage='PERSIST'（確定性注入；PERSIST 分支先前零覆
    // 蓋——見檔頭項目 4）。直接呼叫 generateReport()（繞過 HTTP 層），以
    // Proxy 攔截 prisma.$transaction（僅覆寫該一個方法，其餘方法透傳真實
    // PrismaClient，不修改 src）。
    // -------------------------------------------------------------------------
    describe("§D-6b — details.stage='PERSIST'（確定性注入，取代先前僅機率性 MF-3 之覆蓋）", () => {
      function makeTransactionFailingPrisma(real: PrismaClient): PrismaClient {
        return new Proxy(real, {
          get(target, prop, _receiver) {
            if (prop === "$transaction") {
              return async () => {
                // 泛用、非 Prisma 之錯誤——非 P2002（classifyReportP2002 回
                // null）、非 P2024/P2028（isRetryableTransactionConflict 回
                // false）——generateOnceWithRetry 於首次嘗試即判定不可重
                // 試，立即拋出；generateReport 外層 catch 轉譯為
                // ReportGenerationError("PERSIST")。
                throw new Error("T11 injected non-retryable transaction failure (PERSIST probe)");
              };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === "function"
              ? (value as (...a: unknown[]) => unknown).bind(target)
              : value;
          },
        }) as PrismaClient;
      }

      it("prisma.$transaction 拋出非可重試之泛用錯誤 → generateReport 拋出 ReportGenerationError{stage:PERSIST}（單次嘗試即確定發生，非機率性）", async () => {
        const id = await createCompletedTravelApp("d6b-persist");
        const failingPrisma = makeTransactionFailingPrisma(prisma);
        const deps: ReportServiceDeps = {
          prisma: failingPrisma,
          attachmentStorage: new LocalVolumeStorage(attachmentStorageRoot, { prefixes: ["att"] }),
          reportStorage: new LocalVolumeStorage(reportStorageRoot, { prefixes: ["rpt"] }),
          imageMaxPx: 1600,
          pdfTimeoutMs: 8000,
          log: { error: () => {} },
        };

        let caught: { name?: string; stage?: string } | undefined;
        try {
          await generateReport(deps, id, ownerId);
        } catch (err) {
          caught = err as { name?: string; stage?: string };
        }
        expect(caught?.name).toBe("ReportGenerationError");
        expect(caught?.stage).toBe("PERSIST");

        // 零殘留：本輪未寫入 Report 列（真實 prisma 之 $transaction 從未被
        // 呼叫，故亦無回滾之必要——結構上必然零殘留）。
        const row = await prisma.report.findUnique({ where: { applicationId: id } });
        expect(row).toBeNull();
      });
    });

    // -------------------------------------------------------------------------
    // §D-7：下載端點兩種 404 訊息逐字（B-27／B-28）
    // -------------------------------------------------------------------------
    describe("§D-7 — 下載端點兩種 404 訊息逐字（B-27「尚未產生正式報表」／B-28「報表檔案遺失」）", () => {
      it("B-27：尚未產生報表即下載 → 404 訊息逐字「尚未產生正式報表」", async () => {
        const id = await createCompletedTravelApp("d7-b27");
        const resp = await app.inject({
          method: "GET",
          url: `/applications/${id}/report/pdf`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(404);
        const body = JSON.parse(resp.body) as ErrorBody;
        expect(body.error?.code).toBe("NOT_FOUND");
        expect(body.error?.message).toBe("尚未產生正式報表");
        expectNoLeakage(body);
      });

      it("B-28：已產生但 storage 檔案遺失 → 404 訊息逐字「報表檔案遺失」，不得 500", async () => {
        const id = await createCompletedTravelApp("d7-b28");
        const gen = await generateReportViaHttp(id, ownerCookie);
        expect(gen.statusCode).toBe(201);

        const row = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });
        const filePath = path.join(reportStorageRoot, ...row.storageKey.split("/"));
        expect(fs.existsSync(filePath)).toBe(true);
        fs.unlinkSync(filePath);

        const resp = await app.inject({
          method: "GET",
          url: `/applications/${id}/report/pdf`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(404);
        const body = JSON.parse(resp.body) as ErrorBody;
        expect(body.error?.code).toBe("NOT_FOUND");
        expect(body.error?.message).toBe("報表檔案遺失");
        expectNoLeakage(body);
      });
    });
  }
);

// ===========================================================================
// §E — AC-29：logStream 七類敏感值掃描 ＋ 反向探針 ＋ 列印路徑納入掃描範圍
// ===========================================================================
//
// 七類（依 AC-29 逐字「storageKey、volume 絕對路徑、session cookie／
// token、密碼、PDF 位元組或其 base64 片段、以及折舊之車價／折舊年限」
// ＋ Task Packet「禁字含 rpt/、att/」之落地拆分）：
//   1. `rpt/`（報表 storage key 前綴——掃描前綴字面本身，非僅特定實例
//      值，更嚴格，涵蓋任何實例）
//   2. `att/`（附件 storage key 前綴，同上）
//   3. report volume 絕對路徑（`reportStorageRoot`）
//   4. attachment volume 絕對路徑（`attachmentStorageRoot`）
//   5. session cookie／token（實際登入取得之 cookie 值）
//   6. 密碼（本套件明文密碼常數）
//   7. 折舊車價／折舊年限（本套件專屬標記值；PDF 位元組／base64 片段以
//      「零 `%PDF-` 樣式字串」之負向確認併入同一測試——本套件從未把 PDF
//      位元組交給 logger，兩者同屬「不應出現於日誌之二進位/業務內容」一
//      類，分開各立一則測試對鑑別力無額外貢獻，故合併）
//
// 列印路徑納入掃描範圍：`GET .../report/print` 對缺附件檔案之申請會觸發
// `embedImages` 之 `log.error({ attachmentId }, ...)`（經 `routes.ts` 之
// `request.log.error` 呼叫）——本套件之折舊 fixture 之附件 storageKey 僅
// 存在於 DB、never 寫入磁碟，確保產生與列印兩路徑皆會踩中此分支。
// ===========================================================================

describeWithDb("PHASE-008-T11 — AC-29 logStream 七類敏感值掃描 + 反向探針", () => {
  let prisma: PrismaClient;
  let logApp: FastifyInstance;
  let logLines: string[];
  let attachmentStorageRoot: string;
  let reportStorageRoot: string;

  let ownerId: string;
  let ownerCookie: string;
  let strangerCookie: string;

  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];
  const createdUserIds: string[] = [];

  // 本套件專屬標記值——刻意選用不易與時間戳/隨機 id 巧合重疊之字面值。
  // T11 驗證階段實測發現：3 位數字（原初稿 947）曾與 13 位毫秒時間戳之連
  // 續子字串巧合相符（`...099474...` 含 "947"），造成掃描測試偶發假紅
  // （非真洩漏）——8 位數字之碰撞機率降至可忽略（Int4 容量足夠，欄位本
  // 身無業務範圍驗證，純測試合成值）。
  const VEHICLE_PRICE_MARKER = "918273.64";
  const USEFUL_LIFE_YEARS_MARKER = 84213579;
  let reportStorageKey = "";
  let attachmentStorageKeyMarker = "";

  async function createUser(labelSuffix: string) {
    const loginName = `${LOGIN_PREFIX}log_${labelSuffix}_${RUN_ID}`;
    const user = await prisma.user.create({
      data: {
        loginName,
        displayName: `T11Log ${labelSuffix}`,
        passwordHash: await hashPassword(PASSWORD),
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    createdUserIds.push(user.id);
    const cookie = await loginUser(logApp, loginName, PASSWORD);
    return { id: user.id, cookie, loginName };
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    attachmentStorageRoot = makeTempStorageRoot("att-e");
    reportStorageRoot = makeTempStorageRoot("rpt-e");

    const capture = makeLogCapture();
    logLines = capture.lines;

    logApp = await buildServer({
      databaseUrl: DB_URL,
      storageRoot: attachmentStorageRoot,
      reportStorageRoot,
      logStream: capture.stream,
      logLevel: "info",
    });
    await logApp.ready();

    const owner = await createUser("owner");
    ownerId = owner.id;
    ownerCookie = owner.cookie;
    const stranger = await createUser("stranger");
    strangerCookie = stranger.cookie;

    vi.mocked(renderPdf).mockImplementation(async () => Buffer.from(FAKE_PDF_BYTES));

    // 折舊申請（COMPLETED）— 車價/折舊年限標記值 + 一張證明附件（DB 有
    // 列、storageKey 從未寫入磁碟 → embedImages 之 missing 分支必觸發，
    // 印路徑與產生路徑皆同）。
    attachmentStorageKeyMarker = `att/p8t11log-${RUN_ID}/marker.jpg`;
    const depApp = await prisma.application.create({
      data: {
        type: "DEPRECIATION",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-12-31T00:00:00.000Z"),
        totalAmount: 40000,
        completedAt: new Date(),
        depreciation: {
          create: {
            applicationYear: 2026,
            annualTotalKm: "20000.0",
            snapshotVehiclePrice: VEHICLE_PRICE_MARKER,
            snapshotUsefulLifeYears: USEFUL_LIFE_YEARS_MARKER,
            snapshotAnnualDepreciation: "70000.00",
            snapshotOfficialKm: "10000.00",
            snapshotAnnualTotalKm: "20000.0",
            snapshotRatio: "0.500000",
            snapshotRawAmount: "40000.0000",
            calculatedAt: new Date(),
            depreciationParameterVersionId: `p8t11-param-${RUN_ID}`,
          },
        },
      },
    });
    createdApplicationIds.push(depApp.id);

    const attachment = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: attachmentStorageKeyMarker,
        mimeType: "image/jpeg",
        byteSize: 12345,
        originalFilename: "t11-marker-proof.jpg",
        uploaderId: ownerId,
        ownerId,
        refType: "DEPRECIATION",
        refId: depApp.id,
        linkedAt: new Date(),
      },
    });
    createdAttachmentIds.push(attachment.id);

    logLines.length = 0; // 只看以下觸發之日誌行

    // (0) RENDER 失敗正例（AC-29「渲染失敗之日誌含可追查識別但不含上述任
    // 一」子句之唯一覆蓋——先前僅成功路徑進入 logLines）：必須在下方 (1)
    // 之成功產生**之前**執行——depApp 此刻尚無 Report 列，不會命中冪等短
    // 路（`existingPre` 直接回傳既有列、不呼叫 renderReportHtml，見
    // report-service.ts:691-693），故仍會真正走到渲染。注入一次
    // renderReportHtml 拋錯，觸發 routes.ts 之 `request.log.error({
    // stage, applicationId }, ...)`，使該失敗日誌行進入掃描窗；誘餌訊息
    // 含 storage key 前綴字面與 Windows 絕對路徑樣式，證明失敗路徑本身
    // 不會把攔截到的錯誤內容原樣寫入日誌（routes.ts 刻意不記錄
    // err.message，見檔頭第 67 行）——下方七類掃描自然涵蓋。
    vi.mocked(renderReportHtml).mockImplementationOnce(() => {
      throw new Error("誘餌：含 rpt/fake-key 與 C:\\fake\\abs\\path 之訊息");
    });
    const renderFailResp = await logApp.inject({
      method: "POST",
      url: `/applications/${depApp.id}/report`,
      headers: { cookie: ownerCookie },
    });
    expect(renderFailResp.statusCode).toBe(500);
    const renderFailBody = JSON.parse(renderFailResp.body) as { error?: { code?: string } };
    expect(renderFailBody.error?.code).toBe("REPORT_GENERATION_FAILED");

    // (1) 產生報表（成功路徑；附件 missing 分支必觸發；配得 rpt storageKey）。
    const genResp = await logApp.inject({
      method: "POST",
      url: `/applications/${depApp.id}/report`,
      headers: { cookie: ownerCookie },
    });
    expect(genResp.statusCode).toBe(201);
    const genBody = JSON.parse(genResp.body) as { report: { reportNumber: string } };
    expect(genBody.report.reportNumber).toBeTruthy();
    const row = await prisma.report.findUniqueOrThrow({ where: { applicationId: depApp.id } });
    reportStorageKey = row.storageKey;

    // (2) 列印路徑（列印路徑納入掃描範圍——embedImages 之 missing 分支
    // 經由 request.log.error 再次觸發，本次來自列印端點而非產生端點）。
    const printResp = await logApp.inject({
      method: "GET",
      url: `/applications/${depApp.id}/report/print`,
      headers: { cookie: ownerCookie },
    });
    expect(printResp.statusCode).toBe(200);

    // (3) B-28：storage 檔案遺失後下載（觸發「檔案遺失」錯誤日誌路徑）。
    const filePath = path.join(reportStorageRoot, ...reportStorageKey.split("/"));
    expect(fs.existsSync(filePath)).toBe(true);
    fs.unlinkSync(filePath);
    const downloadMissingResp = await logApp.inject({
      method: "GET",
      url: `/applications/${depApp.id}/report/pdf`,
      headers: { cookie: ownerCookie },
    });
    expect(downloadMissingResp.statusCode).toBe(404);

    // (4) 403（他人存取）／404（不存在 id）／401（未登入）——代表性錯誤路
    // 徑，確保掃描對象涵蓋各種錯誤回應形態，非僅成功路徑。
    await logApp.inject({
      method: "GET",
      url: `/applications/${depApp.id}/report`,
      headers: { cookie: strangerCookie },
    }); // 403
    await logApp.inject({
      method: "GET",
      url: "/applications/00000000-0000-0000-0000-000000000000/report",
      headers: { cookie: ownerCookie },
    }); // 404
    await logApp.inject({ method: "GET", url: `/applications/${depApp.id}/report` }); // 401
  });

  afterAll(async () => {
    if (!prisma) return;
    await logApp.close();
    if (createdAttachmentIds.length > 0) {
      await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
    }
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

  it("1／7：報表 storage key 前綴 rpt/ 不入日誌（含本次實際配得之 storageKey）", () => {
    const combined = logLines.join("\n");
    expect(combined).not.toMatch(/\brpt\//);
    expect(reportStorageKey.length).toBeGreaterThan(0);
    expect(combined).not.toContain(reportStorageKey);
  });

  it("2／7：附件 storage key 前綴 att/ 不入日誌（含本次實際使用之標記 storageKey）", () => {
    const combined = logLines.join("\n");
    expect(combined).not.toMatch(/\batt\//);
    expect(combined).not.toContain(attachmentStorageKeyMarker);
  });

  it("3／7：report volume 絕對路徑不入日誌", () => {
    const combined = logLines.join("\n");
    expect(combined).not.toContain(toLogSearchable(reportStorageRoot));
  });

  it("4／7：attachment volume 絕對路徑不入日誌", () => {
    const combined = logLines.join("\n");
    expect(combined).not.toContain(toLogSearchable(attachmentStorageRoot));
  });

  it("5／7：session cookie／token 不入日誌", () => {
    const combined = logLines.join("\n");
    const cookieValue = ownerCookie.split("=")[1];
    expect(cookieValue.length).toBeGreaterThan(0);
    expect(combined).not.toContain(cookieValue);
    const strangerCookieValue = strangerCookie.split("=")[1];
    expect(combined).not.toContain(strangerCookieValue);
  });

  it("6／7：密碼不入日誌", () => {
    const combined = logLines.join("\n");
    expect(combined).not.toContain(PASSWORD);
    expect(combined.toLowerCase()).not.toContain("password=");
  });

  it("7／7：折舊車價／折舊年限不入日誌（全身分一致，AC-18(b)/AC-29）；PDF 位元組／base64 片段亦零出現（本套件從未將位元組交給 logger）", () => {
    const combined = logLines.join("\n");
    expect(combined).not.toContain(VEHICLE_PRICE_MARKER);
    expect(combined).not.toContain(String(USEFUL_LIFE_YEARS_MARKER));
    expect(combined).not.toMatch(/%PDF-/);
    expect(combined).not.toContain(FAKE_PDF_BYTES.toString("base64").slice(0, 40));
  });

  it("反向探針：直接寫入七類敏感字串至同一 logStream，證明掃描機制非恆真（若日誌真的洩漏，上方 7 則測試必能偵測）", () => {
    const before = logLines.length;
    const probeMarkers = [
      "rpt/probe-token/pdf",
      "att/probe-token/pdf",
      reportStorageRoot,
      attachmentStorageRoot,
      ownerCookie.split("=")[1],
      PASSWORD,
      VEHICLE_PRICE_MARKER,
    ];
    for (const marker of probeMarkers) {
      logApp.log.error({ probe: marker }, "T11 AC-29 reverse probe — intentional leak simulation");
    }
    const newLines = logLines.slice(before);
    const combinedNew = newLines.join("\n");
    expect(newLines.length).toBeGreaterThan(0);
    for (const marker of probeMarkers) {
      expect(combinedNew).toContain(toLogSearchable(marker));
    }
  });

  it("requestId 在場可供追查（渲染失敗之日誌行含可追查識別 requestId 與 stage；一般錯誤路徑之日誌行亦含 requestId）", () => {
    const parsedLines = logLines
      .map((l) => {
        try {
          return JSON.parse(l.trim()) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((o): o is Record<string, unknown> => o !== null);
    expect(parsedLines.length).toBeGreaterThan(0);

    // RENDER 失敗正例（beforeAll 步驟 (0) 之注入）：該行本身須含可追查識
    // 別（requestId）與 stage——AC-29「渲染失敗之日誌含可追查識別」子句
    // 之直接斷言對象（先前僅以「任一行含 requestId」之寬鬆斷言覆蓋，未
    // 曾真的有 RENDER 失敗行進入掃描窗，見 beforeAll 步驟 (0) 註解）。
    const renderFailureLine = parsedLines.find((o) => o.stage === "RENDER");
    expect(renderFailureLine, "RENDER 失敗之日誌行未進入 logStream 掃描窗").toBeTruthy();
    expect(typeof renderFailureLine?.requestId).toBe("string");
    expect((renderFailureLine?.requestId as string).length).toBeGreaterThan(0);

    const withRequestId = parsedLines.filter((o) => typeof o.requestId === "string");
    expect(withRequestId.length).toBeGreaterThan(0);
  });
});
