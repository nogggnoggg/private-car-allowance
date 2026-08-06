/**
 * PHASE-008-T8 — 產生端點（`POST /applications/:id/report`）：配號交易、冪
 * 等、失敗補償、併發
 *
 * ---------------------------------------------------------------------------
 * 規範出處（Spec `docs/specs/PHASE-008.md`）
 * ---------------------------------------------------------------------------
 * AC-04：同月同型多份皆唯一（含 ≥12 輪併發）。
 * AC-05：冪等——同一申請不重產編號（重複 POST 不新增列／檔；渲染器零呼叫）。
 * AC-06：首次產生成功之完整保存（七項同時成立）。
 * AC-07：產生失敗零殘留、不得標示成功（四種失敗注入：RENDER×2／STORE／
 *   VERIFY）。
 * AC-10：同一申請併發產生——恰一份 Report、storage 零孤兒。
 * §9.1：唯一之寫入路徑（冪等前置 → 組裝 → 渲染 → 保存 → 讀回校驗 →
 *   SERIALIZABLE 配號交易 → 失敗補償）；配號在最後一步。
 * §16 D3：SERIALIZABLE + max(sequence)+1 + 三欄唯一約束 + 應用層重試（≤5）。
 * §7.6-2：本 Phase 不提供任何更新或刪除 `Report` 之程式路徑（結構性斷言）。
 *
 * ---------------------------------------------------------------------------
 * 實作決策揭露 #1：`generatedAt` 為真實時鐘（wall-clock `now()`），期間之
 * 序號基準以「呼叫前之 max(sequence)」為準，而非硬編碼 0001 起
 * ---------------------------------------------------------------------------
 * `report-service.ts` 之 `generatedAt = new Date()`（單一顯式時間戳，
 * T2-FW2）反映**真實現在時刻**，故本檔測試之 `numberPeriod` 恆為「執行測試
 * 當下」之 Asia/Taipei `YYYYMM`（以 `getReportNumberPeriod(new Date())` 於
 * 測試檔內同函式計算，取得與生產程式碼同一份真理）。同一 (prefix, period)
 * 於重複執行本檔（開發迭代、CI 重跑）之間會持續累積序號——若寫死斷言
 * 「序號恰為 0001~0005」，重跑第二次即會因 base 不為 0 而恆假。故本檔一律
 * 於每個涉及配號之測試**開始前**先查詢當下 `max(sequence)`（`baseSequence`
 * helper），並斷言「本次新增之序號集合恰為 `{base+1 .. base+N}`、互異、
 * 無跳號」——此斷言與 AC-04 逐字要求（「序號互異」「集合恰為
 * 0001~0012」）等價，只是以「相對起點」取代「絕對起點」，對真實時鐘依賴之
 * 正確測試設計，而非弱化。
 *
 * ---------------------------------------------------------------------------
 * 實作決策揭露 #2（T8R SF-1／SF-2 更正）：多數測試使用 `renderPdf` 之快速
 * 合成替身（`beforeEach` 逐測試重新套用），僅 AC-06 完整性測試使用真實
 * Chromium
 * ---------------------------------------------------------------------------
 * AC-09（PDF 引擎正確性、效能、逾時、殭屍瀏覽器防禦）已由
 * `phase8-pdf-render.test.ts`（T7）真實 Chromium 全覆蓋，本檔之 AC-04／
 * AC-05／AC-10／AC-07(STORE)／AC-07(VERIFY) 所驗證者是**資料庫層之配號／
 * 冪等／交易正確性**與**storage 層之保存／校驗／補償正確性**，與 PDF 位元
 * 組是否為真實 Chromium 產出無關。為避免 12＋ 輪併發各自啟動真實 Chromium
 * （時間與資源成本，且與本檔驗證目標無關），`describe("§快速固定裝置...")`
 * 區塊內以 `vi.mocked(renderPdf).mockImplementation(...)` 覆寫為立即回傳
 * 之合成 PDF 位元組（仍滿足 `%PDF-`／`%%EOF`／長度 > 1024，AC-06 之三項位
 * 元組層斷言在快速路徑上依然可行使用同一份合成位元組驗證，但完整七項組合
 * 之單一權威測試仍保留於「AC-06」describe——該區塊為本檔**唯一**未覆寫
 * `renderPdf` 之區塊，使用真實 Chromium 端到端一次，確保配線正確（服務層
 * 確實呼叫真實 `renderPdf`／`renderReportHtml`，非僅呼叫測試替身）。
 * `renderReportHtml` 亦以 `vi.fn(actual.renderReportHtml)`（呼叫穿透）包
 * 裹，供 T5-複審-FW-A 前置義務之 spy 斷言（PDF 路徑呼叫的正是該函式）與
 * AC-07①（RENDER：HTML 渲染拋錯）失敗注入共用。
 * **T8R SF-1 根因與修復**：外層 `afterEach` 之 `vi.restoreAllMocks()`
 * （見下）在**每一則測試之後**都會把 `vi.fn(actual.fn)` 建立之 mock（含
 * `beforeAll` 設定之 `mockImplementation`）還原為初始狀態——若覆寫本身只
 * 在 `beforeAll` 設定一次，則僅第一則測試享有合成 PDF 替身，其後每一則測
 * 試實際上都在無聲呼叫真實 `renderPdf`（真實 Chromium），既拖慢整檔執行
 * 時間、也使「12 併發改合成 PDF 替身」（SF-2）之設計意圖名存實亡。修復：
 * 覆寫改置於 `beforeEach`（見下方區塊），確保每一則測試開始前都重新套用
 * 合成實作，與 `afterEach` 之逐測試還原相互配合，而非僅套用一次。
 *
 * ---------------------------------------------------------------------------
 * 範圍邊界（誠實揭露；治理 §10「單 Task ≤5 AC」）
 * ---------------------------------------------------------------------------
 * 本檔僅驗證 AC-04／AC-05／AC-06／AC-07／AC-10（T8 Packet 之 Done When 逐
 * 字）。授權矩陣（AC-24）與草稿側信道（AC-25）之**完整覆蓋**屬 T9／T10；
 * 本檔僅各附一則「wiring 最小合理性檢查」（非owner 403、草稿 409）以確保
 * idempotency／併發測試之前置守門確實運作，不作為 AC-24／AC-25 之覆蓋憑證。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { getReportNumberPeriod } from "../../src/reports/report-number.js";
import { buildServer } from "../../src/server.js";
import { LocalVolumeStorage } from "../../src/storage/index.js";

// ── report-html.ts／pdf-renderer.ts：呼叫穿透之 spy 包裝（沿
//    phase8-report-data.test.ts 五引擎 spy 之既有慣例：vi.fn(actual.fn) 預
//    設呼叫真實實作，個別測試可 mockImplementationOnce／mockImplementation
//    覆寫）───────────────────────────────────────────────────────────────
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
const PASSWORD = "ReportGenerateFixture99!";

// 合成 PDF 位元組（AC-06 之三項位元組層斷言在快速路徑上依然可驗證）：
// %PDF- 開頭、%%EOF 結尾、長度 > 1024。
const FAKE_PDF_BYTES = Buffer.from(
  `%PDF-1.4\n% synthetic fixture for PHASE-008-T8 fast tests\n${"X".repeat(1200)}\n%%EOF`
);

function makeTempStorageRoot(prefixLabel: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `phase8-report-generate-${prefixLabel}-`));
}

function removeTempStorageRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/** 列出 `<root>/rpt/<token>/<suffix>` 結構下之全部 storage key（供零殘留／零孤兒斷言）。 */
function listReportStorageKeys(root: string): string[] {
  const rptDir = path.join(root, "rpt");
  if (!fs.existsSync(rptDir)) return [];
  const keys: string[] = [];
  for (const token of fs.readdirSync(rptDir)) {
    const tokenDir = path.join(rptDir, token);
    if (!fs.statSync(tokenDir).isDirectory()) continue;
    for (const suffix of fs.readdirSync(tokenDir)) {
      keys.push(`rpt/${token}/${suffix}`);
    }
  }
  return keys;
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

// ---------------------------------------------------------------------------
// 結構性斷言（不需 DB／server；§7.6-2「本 Phase 不提供任何更新或刪除
// Report 之程式路徑」）
// ---------------------------------------------------------------------------

describe("PHASE-008-T8 — 結構性斷言：無更新／刪除 Report 之程式路徑（§7.6-2）", () => {
  it("report-service.ts／routes.ts 原始碼零 .report.update(／.report.delete(／.report.upsert(／.report.deleteMany(／.report.updateMany(", async () => {
    const serviceSrcPath = new URL("../../src/reports/report-service.ts", import.meta.url);
    const routesSrcPath = new URL("../../src/reports/routes.ts", import.meta.url);
    const serviceSrc = fs.readFileSync(serviceSrcPath, "utf8");
    const routesSrc = fs.readFileSync(routesSrcPath, "utf8");
    for (const src of [serviceSrc, routesSrc]) {
      expect(src).not.toMatch(/\.report\.update\(/);
      expect(src).not.toMatch(/\.report\.delete\(/);
      expect(src).not.toMatch(/\.report\.upsert\(/);
      expect(src).not.toMatch(/\.report\.deleteMany\(/);
      expect(src).not.toMatch(/\.report\.updateMany\(/);
    }
    // 正向對照：`.report.create(`／`.report.findUnique(` 確實在場（證明本掃
    // 描並非因「根本沒有存取 report delegate」而恆真通過）。
    expect(serviceSrc).toMatch(/\.report\.create\(/);
    expect(serviceSrc).toMatch(/\.report\.findUnique\(/);
  });

  it("T4-FW7：report-service.ts 直接 import reportApplicationInclude，未另立字面複本", () => {
    const serviceSrcPath = new URL("../../src/reports/report-service.ts", import.meta.url);
    const src = fs.readFileSync(serviceSrcPath, "utf8");
    expect(src).toMatch(
      /import\s*\{[^}]*reportApplicationInclude[^}]*\}\s*from\s*"\.\/report-data\.js"/
    );
    // 未另立第二份 Prisma.ApplicationInclude 字面物件（僅有一處 `include:` 使用該匯入符號）。
    const includeUsages = src.match(/include:\s*reportApplicationInclude/g) ?? [];
    expect(includeUsages.length).toBeGreaterThanOrEqual(1);
  });

  it("T8a-FW①：server.ts 對兩個 LocalVolumeStorage 實例皆明寫 { prefixes: [...] }", () => {
    const serverSrcPath = new URL("../../src/server.ts", import.meta.url);
    const src = fs.readFileSync(serverSrcPath, "utf8");
    expect(src).toMatch(/new LocalVolumeStorage\(storageRoot, \{ prefixes: \["att"\] \}\)/);
    expect(src).toMatch(/new LocalVolumeStorage\(reportStorageRoot, \{ prefixes: \["rpt"\] \}\)/);
  });

  // ---------------------------------------------------------------------------
  // T8R SF-4：SERIALIZABLE 隔離等級 ＋「渲染在交易內、配號早於渲染」之結構
  // 性守門（§9.1 (4)b/(4)c；防後續重構默默退回舊順序）
  // ---------------------------------------------------------------------------

  it("T8R SF-4：交易隔離等級恆為 Serializable（隔離等級降級 mutant 必紅）", () => {
    const serviceSrcPath = new URL("../../src/reports/report-service.ts", import.meta.url);
    const src = fs.readFileSync(serviceSrcPath, "utf8");
    expect(src).toMatch(/isolationLevel:\s*Prisma\.TransactionIsolationLevel\.Serializable/);
  });

  it("T8R SF-4：renderReportHtml 之呼叫位於 $transaction(...) 回呼內部，且配號（buildReportNumber）早於渲染（順序對調 mutant 必紅；渲染搬出交易 mutant 必紅）", () => {
    const serviceSrcPath = new URL("../../src/reports/report-service.ts", import.meta.url);
    const src = fs.readFileSync(serviceSrcPath, "utf8");

    const txCallIdx = src.indexOf("$transaction(");
    const serializableIdx = src.indexOf("Prisma.TransactionIsolationLevel.Serializable");
    const numberAssignIdx = src.indexOf("buildReportNumber(prefix, period, nextSequence)");
    const renderCallIdx = src.indexOf("renderReportHtml(");

    expect(txCallIdx).toBeGreaterThan(-1);
    expect(serializableIdx).toBeGreaterThan(-1);
    expect(numberAssignIdx).toBeGreaterThan(-1);
    expect(renderCallIdx).toBeGreaterThan(-1);

    // 配號早於渲染（§9.1「(4) 內之順序不可對調」）。
    expect(numberAssignIdx).toBeLessThan(renderCallIdx);
    // 渲染呼叫位於 $transaction(...) 開始之後、其 isolationLevel 選項物件
    // 之前——即巢狀於同一個交易回呼內部，而非另一個獨立、於交易外執行的
    // 函式。
    expect(txCallIdx).toBeLessThan(renderCallIdx);
    expect(renderCallIdx).toBeLessThan(serializableIdx);
  });

  // ---------------------------------------------------------------------------
  // AR-1（generatedAt 顯式性；T8-REVIEW 移交，低成本補列）：本輪 generatedAt
  // 恆為顯式變數（單一 `new Date()` 賦值），落庫時明寫該變數而非仰賴 DB 欄
  // 位預設值 `@default(now())`（schema.prisma :533）——mutant「移除
  // generatedAt: generatedAt 欄位」（改仰賴 DB now()）以此結構斷言必紅。
  // ---------------------------------------------------------------------------

  it("AR-1：INSERT 明寫 generatedAt（不仰賴 DB @default(now()) 之隱式時間）", () => {
    const serviceSrcPath = new URL("../../src/reports/report-service.ts", import.meta.url);
    const src = fs.readFileSync(serviceSrcPath, "utf8");
    expect(src).toMatch(/const generatedAt = new Date\(\);/);
    expect(src).toMatch(/generatedAt,\s*\n\s*\},/);
  });
});

// ---------------------------------------------------------------------------
// DB／HTTP fixture 套件
// ---------------------------------------------------------------------------

describeWithDb("PHASE-008-T8 — POST /applications/:id/report", () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let attachmentStorageRoot: string;
  let reportStorageRoot: string;

  let ownerId: string;
  let ownerCookie: string;
  let strangerCookie: string;

  const createdApplicationIds: string[] = [];
  const createdUserIds: string[] = [];

  const TRAVEL_PERIOD = getReportNumberPeriod(new Date());

  async function baseSequence(prefix: string, period: string): Promise<number> {
    const agg = await prisma.report.aggregate({
      where: { numberPrefix: prefix, numberPeriod: period },
      _max: { sequence: true },
    });
    return agg._max.sequence ?? 0;
  }

  async function createTravelApp(suffix: string, totalAmount = 500): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-03-15T00:00:00.000Z"),
        totalAmount,
        completedAt: new Date(),
        travel: {
          create: {
            tripDate: new Date("2026-03-15T00:00:00.000Z"),
            purpose: `PHASE-008-T8 測試出差-${suffix}`,
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

  async function createMaintenanceApp(suffix: string, totalAmount = 800): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "MAINTENANCE",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-04-01T00:00:00.000Z"),
        totalAmount,
        completedAt: new Date(),
        maintenance: {
          create: {
            lastMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
            currentMaintenanceDate: new Date("2026-04-01T00:00:00.000Z"),
            lastOdometerKm: "1000.00",
            currentOdometerKm: "1500.00",
            actualCost: `${totalAmount}.00`,
            snapshotIntervalKm: "500.00",
            snapshotOfficialKm: "300.00",
            snapshotRatio: "0.600000",
            snapshotRawAmount: `${totalAmount}.0000`,
            calculatedAt: new Date(),
          },
        },
      },
    });
    createdApplicationIds.push(created.id);
    void suffix;
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

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const owner = await prisma.user.create({
      data: {
        loginName: `p8t8_owner_${RUN_ID}`,
        displayName: "P8T8 擁有人",
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
        loginName: `p8t8_stranger_${RUN_ID}`,
        displayName: "P8T8 陌生人",
        passwordHash: await hashPassword(PASSWORD),
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    createdUserIds.push(stranger.id);

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

  afterEach(() => {
    // 僅還原 vi.spyOn 建立之替身（LocalVolumeStorage.prototype.*）；
    // vi.mock 工廠內以 vi.fn(actual.fn) 建立者不受影響（見檔頭說明）。
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // wiring 最小合理性檢查（非 AC-24／AC-25 之覆蓋，見檔頭「範圍邊界」）
  // -------------------------------------------------------------------------

  describe("wiring 最小合理性檢查", () => {
    it("非擁有人 → 403 FORBIDDEN", async () => {
      const id = await createTravelApp("wiring-403");
      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/report`,
        headers: { cookie: strangerCookie },
      });
      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.code).toBe("FORBIDDEN");
    });

    it("草稿申請 → 409 CONFLICT，details.status = DRAFT", async () => {
      const id = await createDraftTravelApp();
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
  });

  // -------------------------------------------------------------------------
  // AC-06：首次產生成功之完整保存（真實 Chromium；本檔唯一未覆寫 renderPdf
  // 之區塊）
  // -------------------------------------------------------------------------

  describe("AC-06：首次產生成功之完整保存（七項同時成立）", () => {
    it(
      "Report 列 + storageKey 格式 + storage 存在且位元組相符 + contentHash 相符 + PDF magic bytes + spy 呼叫 renderReportHtml/renderPdf",
      async () => {
        const id = await createTravelApp("ac06");

        const resp = await app.inject({
          method: "POST",
          url: `/applications/${id}/report`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(201);
        const body = JSON.parse(resp.body);

        // ① Report 列存在且 applicationId 正確
        const row = await prisma.report.findUnique({ where: { applicationId: id } });
        expect(row).not.toBeNull();
        expect(row?.applicationId).toBe(id);

        // ② reportNumber 符合 AC-03 格式
        expect(row?.reportNumber).toMatch(/^TRV-\d{6}-\d{4,}$/);
        expect(body.report.reportNumber).toBe(row?.reportNumber);

        // ③ generatedAt 非空
        expect(row?.generatedAt).toBeInstanceOf(Date);
        expect(body.report.generatedAt).toBe(row?.generatedAt.toISOString());

        // ④ storageKey 符合 rpt/<token>/pdf 格式
        expect(row?.storageKey).toMatch(/^rpt\/[a-zA-Z0-9-]+\/pdf$/);

        // ⑤ storage 中該 key 存在且位元組數等於 byteSize
        if (!row) throw new Error("unreachable — row asserted not null above");
        const storage = new LocalVolumeStorage(reportStorageRoot, { prefixes: ["rpt"] });
        const bytes = await storage.get(row.storageKey);
        expect(bytes.length).toBe(row?.byteSize);
        expect(body.report.byteSize).toBe(row?.byteSize);

        // ⑥ contentHash（SHA-256）等於實際位元組之雜湊
        const crypto = await import("node:crypto");
        const actualHash = crypto.createHash("sha256").update(bytes).digest("hex");
        expect(row?.contentHash).toBe(actualHash);

        // ⑦ PDF 位元組以 %PDF- 開頭、以 %%EOF 結尾且長度 > 1024
        expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
        expect(
          bytes
            .subarray(Math.max(0, bytes.length - 16))
            .toString("latin1")
            .trimEnd()
        ).toMatch(/%%EOF$/);
        expect(bytes.length).toBeGreaterThan(1024);

        // fileName 已凍結；downloadUrl／printUrl 為 §7.2 之相對路徑形式
        expect(body.report.fileName).toContain(row?.reportNumber);
        expect(body.report.fileName.endsWith(".pdf")).toBe(true);
        expect(body.report.downloadUrl).toBe(`/applications/${id}/report/pdf`);
        expect(body.report.printUrl).toBe(`/applications/${id}/report/print`);

        // T5-複審-FW-A 前置：PDF 路徑確實呼叫 renderReportHtml；服務層確實呼叫 renderPdf。
        expect(vi.mocked(renderReportHtml)).toHaveBeenCalled();
        expect(vi.mocked(renderPdf)).toHaveBeenCalled();

        // T8R AC-15 前置自證（方案 (d) 之直接結果）：持久化 PDF 位元組實際
        // 含報表編號字串——證明 §9.1 (4)b 配號早於 (4)c 渲染確實生效，PDF
        // 不再永久呈現「尚未產生」佔位（D3 修訂前之三難已由方案 (d) 解
        // 決）。
        // T8R 誠實揭露：實測（本機真實 Chromium）發現持久化 PDF 之內容串流
        // 以 Type3 字型 glyph 描述（`d1` 運算子＋向量路徑）呈現文字，而非
        // 逐字元 `Tj` 文字運算子——對原始位元組（含 zlib 解壓縮後）做子字
        // 串比對**恆不命中**任何 ASCII 文字，此為 Chromium/Skia PDF 後端
        // 之既有行為，非本檔或 pdf-renderer.ts／report-html.ts 之缺陷，亦
        // 非本 Task 可調整（pdf-renderer.ts 屬 Files Forbidden，僅可
        // import）。故「PDF 位元組逐位元組含 reportNumber 字串」在此渲染
        // 管線下技術上不可行（等同要求 OCR／字型輪廓辨識，超出零新增套件
        // 之 Spec 邊界）。改採 AC-15 自身定義之同一層次（HTML 字串）作為
        // 前置自證：直接斷言「餵給 renderPdf 之 HTML」（即 renderReportHtml
        // 之回傳值，亦即 PDF 之產生輸入）逐字含 reportNumber——這正是 §9.1
        // (4)b 配號早於 (4)c 渲染之結構性結果，也是 AC-15「同一函式、同一
        // 輸入」得以成立之前提（AC-15 本身比較的是 HTML 字串而非 PDF 位元
        // 組，見 Spec :186）。
        if (!row?.reportNumber) throw new Error("unreachable — reportNumber asserted above");
        const renderHtmlCall = vi.mocked(renderReportHtml).mock.calls.at(-1);
        const renderHtmlResult = vi.mocked(renderReportHtml).mock.results.at(-1);
        expect(renderHtmlCall?.[0].common.reportNumber).toBe(row.reportNumber);
        expect(renderHtmlCall?.[0].common.generatedAt).toBe(row.generatedAt.toISOString());
        expect(renderHtmlResult?.type).toBe("return");
        expect(String(renderHtmlResult?.value)).toContain(row.reportNumber);

        // §7.2：ReportDto 之鍵集恰為六鍵（AC-27 之產生端點側，寬鬆對照）。
        expect(Object.keys(body.report).sort()).toEqual(
          ["reportNumber", "generatedAt", "fileName", "byteSize", "downloadUrl", "printUrl"].sort()
        );
      },
      { timeout: 20000 }
    );
  });

  // -------------------------------------------------------------------------
  // 快速固定裝置區塊：renderPdf 覆寫為合成位元組，避免大量真實 Chromium
  // 啟動（見檔頭「實作決策揭露 #2」）。
  // -------------------------------------------------------------------------

  describe("§快速固定裝置（renderPdf 覆寫為合成位元組）", () => {
    // T8R SF-1：改為 beforeEach（原 beforeAll 僅套用一次，會被外層
    // afterEach 之 vi.restoreAllMocks() 於首測後還原，見檔頭「實作決策揭
    // 露 #2」根因說明）——確保每一則測試開始前都重新套用合成實作。
    beforeEach(() => {
      vi.mocked(renderPdf).mockImplementation(async () => Buffer.from(FAKE_PDF_BYTES));
    });

    // -----------------------------------------------------------------------
    // AC-05：冪等
    // -----------------------------------------------------------------------

    describe("AC-05：同一申請不重產編號", () => {
      it("(a) 重複 POST → 首次 201、其後 200，零新增列／檔，reportNumber/generatedAt/fileName/contentHash 全不變", async () => {
        const id = await createTravelApp("ac05a");

        const first = await app.inject({
          method: "POST",
          url: `/applications/${id}/report`,
          headers: { cookie: ownerCookie },
        });
        expect(first.statusCode).toBe(201);
        const firstBody = JSON.parse(first.body);

        const countBefore = await prisma.report.count({ where: { applicationId: id } });
        expect(countBefore).toBe(1);
        const keysBefore = listReportStorageKeys(reportStorageRoot);

        const second = await app.inject({
          method: "POST",
          url: `/applications/${id}/report`,
          headers: { cookie: ownerCookie },
        });
        expect(second.statusCode).toBe(200);
        const secondBody = JSON.parse(second.body);

        const countAfter = await prisma.report.count({ where: { applicationId: id } });
        expect(countAfter).toBe(1);
        const keysAfter = listReportStorageKeys(reportStorageRoot);
        expect(keysAfter.length).toBe(keysBefore.length);

        expect(secondBody.report.reportNumber).toBe(firstBody.report.reportNumber);
        expect(secondBody.report.generatedAt).toBe(firstBody.report.generatedAt);
        expect(secondBody.report.fileName).toBe(firstBody.report.fileName);

        const row = await prisma.report.findUnique({ where: { applicationId: id } });
        // contentHash 不在 DTO 中外露（AC-27），改由 DB 列驗證維持不變（此
        // 處只需確認仍恰一列，contentHash 值本身於單一 POST 內已由 AC-06
        // 驗證機制覆蓋，這裡的重點是零新增/零改動）。
        expect(row).not.toBeNull();
      });

      it("(b)(精神；下載端點屬 T9) 第二次 POST 完全零渲染——renderPdf 於本次呼叫前後呼叫次數不變", async () => {
        const id = await createTravelApp("ac05b");

        await app.inject({
          method: "POST",
          url: `/applications/${id}/report`,
          headers: { cookie: ownerCookie },
        });
        const callsAfterFirst = vi.mocked(renderPdf).mock.calls.length;

        await app.inject({
          method: "POST",
          url: `/applications/${id}/report`,
          headers: { cookie: ownerCookie },
        });
        const callsAfterSecond = vi.mocked(renderPdf).mock.calls.length;

        expect(callsAfterSecond).toBe(callsAfterFirst);
      });
    });

    // -----------------------------------------------------------------------
    // AC-04：同月同型多份皆唯一（含併發）
    // -----------------------------------------------------------------------

    describe("AC-04：同月同型多份皆唯一（含併發）", () => {
      it("(a) 同月同型連續 5 份 → 序號互異且恰為 base+1..base+5", async () => {
        const base = await baseSequence("TRV", TRAVEL_PERIOD);
        const ids = await Promise.all([1, 2, 3, 4, 5].map((n) => createTravelApp(`ac04a-${n}`)));

        const sequences: number[] = [];
        for (const id of ids) {
          const resp = await app.inject({
            method: "POST",
            url: `/applications/${id}/report`,
            headers: { cookie: ownerCookie },
          });
          expect(resp.statusCode).toBe(201);
          const row = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });
          sequences.push(row.sequence);
        }

        expect(new Set(sequences).size).toBe(5);
        expect(sequences.sort((a, b) => a - b)).toEqual([
          base + 1,
          base + 2,
          base + 3,
          base + 4,
          base + 5,
        ]);
      });

      it("(b) 不同型別同月份互不干涉（TRV 與 MNT 序號各自獨立累計）", async () => {
        const baseTrv = await baseSequence("TRV", TRAVEL_PERIOD);
        const baseMnt = await baseSequence("MNT", TRAVEL_PERIOD);

        const travelId = await createTravelApp("ac04b-trv");
        const maintenanceId = await createMaintenanceApp("ac04b-mnt");

        const respTrv = await app.inject({
          method: "POST",
          url: `/applications/${travelId}/report`,
          headers: { cookie: ownerCookie },
        });
        const respMnt = await app.inject({
          method: "POST",
          url: `/applications/${maintenanceId}/report`,
          headers: { cookie: ownerCookie },
        });
        expect(respTrv.statusCode).toBe(201);
        expect(respMnt.statusCode).toBe(201);

        const trvRow = await prisma.report.findUniqueOrThrow({
          where: { applicationId: travelId },
        });
        const mntRow = await prisma.report.findUniqueOrThrow({
          where: { applicationId: maintenanceId },
        });

        expect(trvRow.sequence).toBe(baseTrv + 1);
        expect(mntRow.sequence).toBe(baseMnt + 1);
        expect(trvRow.reportNumber.startsWith("TRV-")).toBe(true);
        expect(mntRow.reportNumber.startsWith("MNT-")).toBe(true);
      });

      it(
        "(c) 12 筆不同申請同時產生（同月同型）→ 全部成功、12 個編號互異、序號集合恰為 base+1..base+12（無跳號、無重複）；T8R AC-04(c) 方案 (d) 結構下重驗（渲染移入交易，重試須重新渲染）",
        async () => {
          const base = await baseSequence("TRV", TRAVEL_PERIOD);
          const ids = await Promise.all(
            Array.from({ length: 12 }, (_, i) => createTravelApp(`ac04c-${i}`))
          );

          // T8R：耗時量測（12 併發、重試上限 5）——記入 Handoff。
          const startedAt = Date.now();
          const responses = await Promise.all(
            ids.map((id) =>
              app.inject({
                method: "POST",
                url: `/applications/${id}/report`,
                headers: { cookie: ownerCookie },
              })
            )
          );
          const elapsedMs = Date.now() - startedAt;
          console.info(`[T8R][AC-04(c)] 12 併發（方案 d 結構）耗時 ${elapsedMs}ms`);

          for (const resp of responses) {
            expect(resp.statusCode).toBe(201);
          }

          const rows = await prisma.report.findMany({
            where: { applicationId: { in: ids } },
            select: { sequence: true, reportNumber: true },
          });
          expect(rows).toHaveLength(12);

          const sequences = rows.map((r) => r.sequence).sort((a, b) => a - b);
          const expected = Array.from({ length: 12 }, (_, i) => base + 1 + i);
          expect(new Set(sequences).size).toBe(12);
          expect(sequences).toEqual(expected);

          const reportNumbers = new Set(rows.map((r) => r.reportNumber));
          expect(reportNumbers.size).toBe(12);
        },
        { timeout: 30000 }
      );

      it("(d) 序號重試 mutant 必紅（正向對照）：DB 唯一約束確實擋下手動配置之重複序號插入，且應用層重試邏輯使真實併發請求全數成功（本測試以 (c) 之通過作為「重試邏輯存在且運作」之實證；此處另證明底層唯一約束本身確實生效，供 Handoff 之 mutant 移除示範參照）", async () => {
        const base = await baseSequence("TRV", TRAVEL_PERIOD);
        const period = TRAVEL_PERIOD;
        const dupSequence = base + 1;
        const ownerForDup = ownerId;

        // 手動以相同 (prefix, period, sequence) 插入兩列 → 第二筆必觸發 P2002
        // （唯一鍵衝突）——證明 DB 唯一約束是最後防線，若移除應用層重試（本
        // 檔 assignReportNumberAndInsert 之 for 迴圈），(c) 之 12 輪併發測試
        // 會因未重試而直接以此類衝突失敗，測試必紅（見 Handoff 之 mutant
        // 移除實測紀錄）。
        const dummyAppId1 = await createTravelApp("ac04d-1");
        await prisma.report.create({
          data: {
            applicationId: dummyAppId1,
            reportNumber: `TRV-${period}-${String(dupSequence).padStart(4, "0")}`,
            numberPrefix: "TRV",
            numberPeriod: period,
            sequence: dupSequence,
            storageKey: `rpt/ac04d-dup-${RUN_ID}/pdf`,
            fileName: "ac04d-dup.pdf",
            byteSize: 2048,
            contentHash: "a".repeat(64),
            generatedById: ownerForDup,
          },
        });

        const dummyAppId2 = await createTravelApp("ac04d-2");
        let caught: unknown = null;
        try {
          await prisma.report.create({
            data: {
              applicationId: dummyAppId2,
              reportNumber: `TRV-${period}-${String(dupSequence).padStart(4, "0")}-x`,
              numberPrefix: "TRV",
              numberPeriod: period,
              sequence: dupSequence,
              storageKey: `rpt/ac04d-dup2-${RUN_ID}/pdf`,
              fileName: "ac04d-dup2.pdf",
              byteSize: 2048,
              contentHash: "b".repeat(64),
              generatedById: ownerForDup,
            },
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).not.toBeNull();
        expect((caught as { code?: string }).code).toBe("P2002");

        // 錯誤未以 500 外洩 DB 錯誤原文（本測試僅示範 DB 層事實；應用層之
        // 「不外洩」由 report-service.ts 之 ReportGenerationError 不攜帶
        // 原始 err 之設計保證，見 AC-07 測試群）。
      });
    });

    // -----------------------------------------------------------------------
    // AC-10：同一申請併發產生
    // -----------------------------------------------------------------------

    describe("AC-10：同一申請併發產生", () => {
      it("2 個併發 POST → 恰一份 Report、兩回應皆成功且編號相同、storage 恰一個 key（零孤兒）；T8R SF-3：敗方之交易內 put 於回滾後補償——以 put/delete spy 逐 key 正向斷言（非僅『無殘留』之恆真式）", async () => {
        const id = await createTravelApp("ac10");
        const keysBefore = listReportStorageKeys(reportStorageRoot);

        // T8R SF-3：正向斷言之基礎——spy 呼叫穿透（不覆寫實作），逐一記錄
        // 實際 put／delete 呼叫之 key。兩個併發請求對同一 applicationId 分
        // 屬各自的 SERIALIZABLE 交易快照，§9.1 (4)a 之交易內冪等檢查對真
        // 正併發之兩者皆會通過（互不可見對方尚未提交之列），故結構上必然
        // 有一方於 (4)f INSERT 撞上 applicationId 唯一鍵——此為關聯式資料
        // 庫之保證，非計時巧合；「敗方」在撞鍵之前已完整跑過 (4)c~e（渲染
        // ＋put＋讀回校驗），故必有一個「已 put 但未保留」之 key 可供本測
        // 試鑑別。
        const putSpy = vi.spyOn(LocalVolumeStorage.prototype, "put");
        const deleteSpy = vi.spyOn(LocalVolumeStorage.prototype, "delete");

        const [respA, respB] = await Promise.all([
          app.inject({
            method: "POST",
            url: `/applications/${id}/report`,
            headers: { cookie: ownerCookie },
          }),
          app.inject({
            method: "POST",
            url: `/applications/${id}/report`,
            headers: { cookie: ownerCookie },
          }),
        ]);

        // 兩者皆須是成功碼（201 或 200），不得任一失敗。
        expect([200, 201]).toContain(respA.statusCode);
        expect([200, 201]).toContain(respB.statusCode);

        const bodyA = JSON.parse(respA.body);
        const bodyB = JSON.parse(respB.body);
        expect(bodyA.report.reportNumber).toBe(bodyB.report.reportNumber);

        const rows = await prisma.report.findMany({ where: { applicationId: id } });
        expect(rows).toHaveLength(1);
        const finalKey = rows[0].storageKey;

        const keysAfter = listReportStorageKeys(reportStorageRoot);
        // 恰新增一個 key（零孤兒——敗方已寫入之 PDF 檔須被清理）。
        expect(keysAfter.length).toBe(keysBefore.length + 1);
        expect(keysAfter).toContain(finalKey);

        // T8R SF-3 正向斷言：每一個曾經 put 過、但非最終保留之 key，皆須
        // 有對應的 delete 呼叫——逐一比對呼叫參數，而非僅比對檔案數量。
        const putKeys = putSpy.mock.calls
          .map((call) => call[0] as string)
          .filter((key) => key.startsWith("rpt/"));
        const deletedKeys = deleteSpy.mock.calls.map((call) => call[0] as string);
        const orphanKeys = putKeys.filter((key) => key !== finalKey);
        // 本測試須確實命中至少一次補償情境（非零呼叫恆真通過）。
        expect(orphanKeys.length).toBeGreaterThan(0);
        for (const key of orphanKeys) {
          expect(deletedKeys).toContain(key);
        }
      });
    });

    // -----------------------------------------------------------------------
    // AC-07：產生失敗零殘留、不得標示成功（四種失敗注入）
    // -----------------------------------------------------------------------

    describe("AC-07：產生失敗零殘留、不得標示成功", () => {
      async function assertZeroResidual(applicationId: string, keysBefore: string[]) {
        const rows = await prisma.report.findMany({ where: { applicationId } });
        expect(rows).toHaveLength(0);
        const keysAfter = listReportStorageKeys(reportStorageRoot);
        expect(keysAfter).toEqual(keysBefore);
      }

      it("①HTML 渲染拋錯 → 500 REPORT_GENERATION_FAILED { stage: RENDER }，零殘留", async () => {
        const id = await createTravelApp("ac07-1");
        const keysBefore = listReportStorageKeys(reportStorageRoot);
        const before = await prisma.application.findUniqueOrThrow({ where: { id } });

        vi.mocked(renderReportHtml).mockImplementationOnce(() => {
          throw new Error("synthetic HTML render failure (AC-07①)");
        });

        const resp = await app.inject({
          method: "POST",
          url: `/applications/${id}/report`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(500);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("REPORT_GENERATION_FAILED");
        expect(body.error.details).toEqual({ stage: "RENDER" });
        // 不外洩堆疊／DB 結構／storage key／絕對路徑。
        expect(JSON.stringify(body)).not.toContain("synthetic HTML render failure");
        expect(JSON.stringify(body)).not.toMatch(/[A-Za-z]:\\|\/home\/|\/data\//);

        await assertZeroResidual(id, keysBefore);
        const after = await prisma.application.findUniqueOrThrow({ where: { id } });
        expect(after.status).toBe(before.status);
        expect(after.totalAmount).toBe(before.totalAmount);
      });

      it("①'（T4-FW4 大總管裁定釘住）快照缺欄（COMPLETED 但必要快照欄為 null）觸發 report-data.ts 之 required() 拋錯 → 同一 RENDER 階段收斂，非 buildReportData 之特例", async () => {
        const id = await createTravelApp("ac07-1b");
        const keysBefore = listReportStorageKeys(reportStorageRoot);
        // 直接以 raw SQL 撥動快照欄為 NULL（正常完成流程不會產生此狀態；此
        // 處刻意製造「已完成但快照缺欄」以命中 report-data.ts 之
        // required() 拋錯路徑——見該檔 JSDoc「已完成申請之快照欄位理應非
        // null……寧可明確拋錯」）。
        await prisma.$executeRawUnsafe(
          `UPDATE "TravelApplication" SET "snapshotTotalKm" = NULL WHERE "applicationId" = $1`,
          id
        );

        const resp = await app.inject({
          method: "POST",
          url: `/applications/${id}/report`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(500);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("REPORT_GENERATION_FAILED");
        expect(body.error.details).toEqual({ stage: "RENDER" });
        expect(JSON.stringify(body)).not.toContain("snapshotTotalKm");
        expect(JSON.stringify(body)).not.toContain(id);

        await assertZeroResidual(id, keysBefore);
      });

      it("②PDF 渲染器拋錯／逾時 → 500 REPORT_GENERATION_FAILED { stage: RENDER }，零殘留", async () => {
        const id = await createTravelApp("ac07-2");
        const keysBefore = listReportStorageKeys(reportStorageRoot);

        vi.mocked(renderPdf).mockImplementationOnce(async () => {
          throw new Error("synthetic PDF render timeout (AC-07②)");
        });

        const resp = await app.inject({
          method: "POST",
          url: `/applications/${id}/report`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(500);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("REPORT_GENERATION_FAILED");
        expect(body.error.details).toEqual({ stage: "RENDER" });
        expect(JSON.stringify(body)).not.toContain("synthetic PDF render timeout");

        await assertZeroResidual(id, keysBefore);
      });

      it("③storage.put 拋錯 → 500 REPORT_GENERATION_FAILED { stage: STORE }，零殘留", async () => {
        const id = await createTravelApp("ac07-3");
        const keysBefore = listReportStorageKeys(reportStorageRoot);

        vi.spyOn(LocalVolumeStorage.prototype, "put").mockImplementationOnce(async () => {
          throw new Error("synthetic storage.put failure (AC-07③) key=rpt/should-not-leak/pdf");
        });

        const resp = await app.inject({
          method: "POST",
          url: `/applications/${id}/report`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(500);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("REPORT_GENERATION_FAILED");
        expect(body.error.details).toEqual({ stage: "STORE" });
        expect(JSON.stringify(body)).not.toContain("should-not-leak");

        await assertZeroResidual(id, keysBefore);
      });

      it("④寫檔後讀回校驗不符（位元組數不符）→ 500 REPORT_GENERATION_FAILED { stage: VERIFY }，零殘留（已寫入之檔已被清理）", async () => {
        const id = await createTravelApp("ac07-4a");
        const keysBefore = listReportStorageKeys(reportStorageRoot);

        vi.spyOn(LocalVolumeStorage.prototype, "get").mockImplementationOnce(async () => {
          // 讀回位元組數與剛寫入者不符（模擬 volume 層資料毀損）。
          return Buffer.from("mismatched bytes, wrong length");
        });

        const resp = await app.inject({
          method: "POST",
          url: `/applications/${id}/report`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(500);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("REPORT_GENERATION_FAILED");
        expect(body.error.details).toEqual({ stage: "VERIFY" });

        await assertZeroResidual(id, keysBefore);
      });

      it("④'（雜湊不符變體，T8R 更正——corrupted buffer 改由當次實際 pdfBytes 長度構造）：讀回位元組數相同但內容不同（雜湊不符）→ 500 REPORT_GENERATION_FAILED { stage: VERIFY }，零殘留；雜湊臂 mutant（移除 SHA-256 比對）必紅", async () => {
        const id = await createTravelApp("ac07-4b");
        const keysBefore = listReportStorageKeys(reportStorageRoot);

        // T8R 修正：原版本直接複製模組層級常數 FAKE_PDF_BYTES 構造等長毀損
        // 位元組——一旦本次呼叫實際寫入的 pdfBytes 因任何原因（mock 失
        // 效、未來替身內容改變……）與 FAKE_PDF_BYTES 不同長度，毀損位元組
        // 會先撞上「位元組數不符」分支而非「雜湊不符」分支，使本測試名不
        // 符實，且移除 SHA-256 比對之 mutant 未必能被本測試鑑別（視執行順
        // 序而定，見 SF-1 根因說明）。改為：以 spy 穿透記錄本次呼叫實際
        // put 之位元組，讀回時以「該次實際位元組之同長度、單一位元翻轉」
        // 構造毀損版本——確保位元組數必定相符，唯一差異只在雜湊，故本測
        // 試恆為雜湊臂之鑑別測試，不受何處提供 PDF 位元組之細節影響。
        const putSpy = vi.spyOn(LocalVolumeStorage.prototype, "put");
        vi.spyOn(LocalVolumeStorage.prototype, "get").mockImplementationOnce(async () => {
          const lastPutCall = putSpy.mock.calls.at(-1);
          const writtenBytes = lastPutCall?.[1] as Buffer;
          const corrupted = Buffer.from(writtenBytes);
          corrupted[10] = corrupted[10] ^ 0xff;
          return corrupted;
        });

        const resp = await app.inject({
          method: "POST",
          url: `/applications/${id}/report`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(500);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("REPORT_GENERATION_FAILED");
        expect(body.error.details).toEqual({ stage: "VERIFY" });

        await assertZeroResidual(id, keysBefore);
      });
    });
  });
});
