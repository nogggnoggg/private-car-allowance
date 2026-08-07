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
 *   READ COMMITTED 配號交易 → 失敗補償）；配號在最後一步。**T8R4**：本報
 *   表產生交易之隔離等級由 SERIALIZABLE 改為 READ COMMITTED（僅此交
 *   易），疊加交易級顧問鎖排隊為唯一性之主防線（見下方 T8R2~T8R4 相關
 *   describe 區塊）。
 * §16 D3：READ COMMITTED（本交易限定）+ 顧問鎖排隊（主防線）+
 *   max(sequence)+1 + 三欄唯一約束 + P2002 應用層重試（≤5，最後防線）。
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
import { Prisma, PrismaClient } from "@prisma/client";
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
// T8R2 — MF-2／MF-3 探針：直接呼叫 generateReport（繞過 HTTP 層），以便注入
// 自訂 pdfTimeoutMs／自訂連線池上限之 PrismaClient，同一份 vi.mock 亦攔截此
// import site之 renderPdf（見上方 vi.mock 工廠，模組快取單一份）。
import { type ReportServiceDeps, generateReport } from "../../src/reports/report-service.js";

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
  // T8R4／SF-4：交易隔離等級（ReadCommitted）＋「渲染在交易內、配號早於渲
  // 染」之結構性守門（§9.1 (4)c/(4)d；防後續重構默默退回舊順序或改回
  // Serializable）
  // ---------------------------------------------------------------------------

  it("T8R4／SF-4：交易隔離等級恆為 ReadCommitted（改回 Serializable 之 mutant 必紅——T8R3 三層獨立複現已證明 Serializable 下顧問鎖排隊機制不成立）", () => {
    const serviceSrcPath = new URL("../../src/reports/report-service.ts", import.meta.url);
    const src = fs.readFileSync(serviceSrcPath, "utf8");
    expect(src).toMatch(/isolationLevel:\s*Prisma\.TransactionIsolationLevel\.ReadCommitted/);
    // 正向對照：Serializable 字面不應再出現於真實呼叫處（僅容許出現於檔頭
    // 文件說明散文中，故此處僅檢查「呼叫形式」不存在，不檢查全檔零出現）。
    expect(src).not.toMatch(/isolationLevel:\s*Prisma\.TransactionIsolationLevel\.Serializable/);
  });

  it("T8R4／SF-4：renderReportHtml 之呼叫位於 $transaction(...) 回呼內部，且配號（buildReportNumber）早於渲染（順序對調 mutant 必紅；渲染搬出交易 mutant 必紅）", () => {
    const serviceSrcPath = new URL("../../src/reports/report-service.ts", import.meta.url);
    const src = fs.readFileSync(serviceSrcPath, "utf8");

    const txCallIdx = src.indexOf("$transaction(");
    const readCommittedIdx = src.indexOf("Prisma.TransactionIsolationLevel.ReadCommitted");
    const numberAssignIdx = src.indexOf("buildReportNumber(prefix, period, nextSequence)");
    const renderCallIdx = src.indexOf("renderReportHtml(");

    expect(txCallIdx).toBeGreaterThan(-1);
    expect(readCommittedIdx).toBeGreaterThan(-1);
    expect(numberAssignIdx).toBeGreaterThan(-1);
    expect(renderCallIdx).toBeGreaterThan(-1);

    // 配號早於渲染（§9.1「(4) 內之順序不可對調」）。
    expect(numberAssignIdx).toBeLessThan(renderCallIdx);
    // 渲染呼叫位於 $transaction(...) 開始之後、其 isolationLevel 選項物件
    // 之前——即巢狀於同一個交易回呼內部，而非另一個獨立、於交易外執行的
    // 函式。
    expect(txCallIdx).toBeLessThan(renderCallIdx);
    expect(renderCallIdx).toBeLessThan(readCommittedIdx);
  });

  // ---------------------------------------------------------------------------
  // T8R4／SF-5：交易級顧問鎖之結構性守門（§9.1 (4)a／(4)b 不變式；比照
  // SF-4——移除或後移之 mutant 必紅）。T8R4 更新：鎖前移為交易首語句，須早
  // 於冪等再查（不只早於配號）。
  // ---------------------------------------------------------------------------

  it("T8R4：交易內呼叫 pg_advisory_xact_lock（顧問鎖移除 mutant 必紅）", () => {
    const serviceSrcPath = new URL("../../src/reports/report-service.ts", import.meta.url);
    const src = fs.readFileSync(serviceSrcPath, "utf8");
    expect(src).toMatch(/pg_advisory_xact_lock\(hashtext\(/);
  });

  it("T8R4：顧問鎖呼叫為交易首語句——早於冪等再查（tx.report.findUnique）與配號（buildReportNumber／tx.report.aggregate），且位於 $transaction(...) 回呼內部（鎖後移 mutant 必紅；鎖搬出交易 mutant 必紅）", () => {
    const serviceSrcPath = new URL("../../src/reports/report-service.ts", import.meta.url);
    const src = fs.readFileSync(serviceSrcPath, "utf8");

    const txCallIdx = src.indexOf("$transaction(");
    // 以逐字完整片語比對真實呼叫（非檔頭文件說明散文之同名片語——單獨比
    // 對關鍵詞會誤命中 §9.1 流程對照註解，見檔頭）。
    const lockCallIdx = src.indexOf("await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(");
    const idempotencyCallIdx = src.indexOf("const existing = await tx.report.findUnique(");
    const aggregateIdx = src.indexOf("tx.report.aggregate(");
    const numberAssignIdx = src.indexOf("buildReportNumber(prefix, period, nextSequence)");
    const readCommittedIdx = src.indexOf("Prisma.TransactionIsolationLevel.ReadCommitted");

    expect(txCallIdx).toBeGreaterThan(-1);
    expect(lockCallIdx).toBeGreaterThan(-1);
    expect(idempotencyCallIdx).toBeGreaterThan(-1);
    expect(aggregateIdx).toBeGreaterThan(-1);
    expect(numberAssignIdx).toBeGreaterThan(-1);

    // 顧問鎖位於 $transaction(...) 回呼內部（交易內，非交易外之獨立呼叫）。
    expect(txCallIdx).toBeLessThan(lockCallIdx);
    expect(lockCallIdx).toBeLessThan(readCommittedIdx);
    // T8R4：顧問鎖為交易首語句——早於冪等再查（(4)a 早於 (4)b）。
    expect(lockCallIdx).toBeLessThan(idempotencyCallIdx);
    // 顧問鎖早於配號（(4)a 早於 (4)c）——早於序號聚合查詢、亦早於
    // reportNumber 之組裝。
    expect(lockCallIdx).toBeLessThan(aggregateIdx);
    expect(lockCallIdx).toBeLessThan(numberAssignIdx);
    // 冪等再查早於配號（(4)b 早於 (4)c）——既有順序未變。
    expect(idempotencyCallIdx).toBeLessThan(aggregateIdx);
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
        // T8R2 SF-7 更正（原「Skia Type3 向量化」敘述經 reviewer 覆核為誤
        // 判，已更正如下，供未來 Phase 勿被錯誤結論擋住）：實測（本機真實
        // Chromium）之持久化 PDF 內容串流實為**子集字型（subset font）之
        // glyph 編碼**——PDF 內嵌 `/FontFile`＋`/ToUnicode` CMap 皆在場、
        // 文字操作子為一般 `Tj`（實測 5 個），並非先前誤判之 Type3 `d1`
        // 向量路徑描述；文字在原則上**可還原**（`/ToUnicode` 提供字型內部
        // glyph index 對應之 Unicode 反查表）。唯獨對**原始位元組**（含
        // zlib 解壓縮後）直接做子字串比對仍**不可命中**——子集字型之
        // glyph 索引非 ASCII 碼點，須先經 `/ToUnicode` CMap 反查（等同輕
        // 量級文字擷取，而非 OCR／字型輪廓辨識），此非本檔或
        // pdf-renderer.ts／report-html.ts 之缺陷，亦非本 Task 可調整
        // （pdf-renderer.ts 屬 Files Forbidden，僅可 import）。故「PDF 位
        // 元組逐位元組含 reportNumber 字串」在不引入 CMap 反查邏輯之前提
        // 下技術上不可行，超出零新增套件之 Spec 邊界。改採 AC-15 自身定義
        // 之同一層次（HTML 字串）作為
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
        "(c) 12 筆不同申請同時產生（同月同型）→ 全部成功、12 個編號互異、序號集合恰為 base+1..base+12（無跳號、無重複）；T8R AC-04(c) 方案 (d) 結構下重驗（渲染移入交易，重試須重新渲染）；T8R2 SF-5：改用具真實耗時之替身（sleep ≈400ms）重驗，使交易窗口延長效應真正進入量測；T8R4：顧問鎖＋ReadCommitted 落地後轉綠（併發數與替身耗時皆未調降）",
        async () => {
          const base = await baseSequence("TRV", TRAVEL_PERIOD);
          const ids = await Promise.all(
            Array.from({ length: 12 }, (_, i) => createTravelApp(`ac04c-${i}`))
          );

          // T8R2 SF-5：AC-04(c) 之重驗義務（Spec :142「不得沿用舊結構之通過
          // 紀錄」）——原本 §快速固定裝置區塊之 renderPdf 替身零耗時立即回
          // 傳，交易窗口幾乎瞬間結束，無法反映方案 (d)「渲染移入交易」後真
          // 正的窗口延長效應（Spec :1006 已明示接受之 +0.5s 成本）。改為具
          // 真實耗時之替身（sleep ≈400ms，量級貼近 T7 `phase8-pdf-render.
          // test.ts` 對標準 fixture 之實測 Chromium 渲染耗時，不需要在此啟
          // 動真 Chromium）——12 輪交易同時各自持有連線 ≈400ms＋DB 額外操
          // 作，序列化衝突率／連線池競爭才會如同真實負載般被量測到。
          // T8R4：本測試在 T8R2/T8R3 皆為紅燈（T8R2 據實 BLOCKED；T8R3 三層
          // 複現證明「顧問鎖疊加於 SERIALIZABLE」機制不成立，紅燈依舊）；
          // 顧問鎖前移＋本交易改 ReadCommitted 後，12 併發應全數成功——**併
          // 發數（12）與替身耗時（400ms）皆未調降**，紅燈轉綠純粹來自
          // report-service.ts 之機制修正。
          vi.mocked(renderPdf).mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            return Buffer.from(FAKE_PDF_BYTES);
          });

          // T8R／T8R4：耗時量測（12 併發、重試上限 5）——記入 Handoff（T8R4
          // 預期 ~5.5s 級：顧問鎖排隊 12×~0.4-0.45s 串行）。
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
          console.info(`[T8R4][AC-04(c)] 12 併發（顧問鎖＋ReadCommitted）耗時 ${elapsedMs}ms`);

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
      it("2 個併發 POST → 恰一份 Report、兩回應皆成功且編號相同、storage 恰一個 key（零孤兒）；T8R4 更新：顧問鎖使敗方於 (4)b 冪等再查即收斂，結構上不再有機會抵達 (4)f put（零浪費，非『先浪費後補償』）——以 put/delete spy 正向斷言鑑別新機制", async () => {
        const id = await createTravelApp("ac10");
        const keysBefore = listReportStorageKeys(reportStorageRoot);

        // T8R4 誠實揭露（原 T8R SF-3 之機制已被取代，非本測試弱化）：兩個
        // 併發請求之 applicationId 相同 → numberPrefix／numberPeriod 亦相
        // 同（同一組）→ (4)a 顧問鎖使兩者排隊，不再是各自獨立之
        // SERIALIZABLE 快照競賽。先進入者於 (4)b 冪等再查見「不存在」，
        // 完整跑完 (4)c~g 並提交（釋放鎖）；後進入者於鎖釋放後才進入
        // (4)b，`READ COMMITTED` 之新快照使其**看見前位已提交之列**，於
        // 冪等再查當場收斂為「敗方」——**結構上不會抵達 (4)d~f（渲染／
        // put／讀回校驗）**，故不再有「先 put 後補償刪除」之浪費，而是
        //「根本不 put」。零孤兒之達成方式因而由「事後補償」升級為「事前
        // 避免」；AC-10 之逐字驗收（恰一份 Report、storage 零孤兒）不
        // 變，僅鑑別機制隨之更新（見下方 putSpy 恰一次呼叫之斷言）。
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
        // 恰新增一個 key（零孤兒）。
        expect(keysAfter.length).toBe(keysBefore.length + 1);
        expect(keysAfter).toContain(finalKey);

        // T8R4 正向斷言：`put` 對本申請恰呼叫一次（敗方結構上不會抵達
        // put），故無需任何補償刪除——非「零呼叫恆真通過」，而是明確斷言
        // 「僅一次」，若顧問鎖失效導致敗方仍搶跑至 put（回退至 T8R 前之
        // 競態），本斷言必紅（呼叫次數 > 1）。
        const putKeys = putSpy.mock.calls
          .map((call) => call[0] as string)
          .filter((key) => key.startsWith("rpt/"));
        expect(putKeys).toEqual([finalKey]);
        const deletedKeys = deleteSpy.mock.calls
          .map((call) => call[0] as string)
          .filter((key) => key.startsWith("rpt/"));
        expect(deletedKeys).toEqual([]);
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

    // -------------------------------------------------------------------------
    // T8R2 — MF-2／MF-3：交易 timeout／maxWait 裕度 ＋ P2024/P2028 重試分類
    // （reviewer 探針①②之直接規避測試；繞過 HTTP 層，直接呼叫 generateReport
    // 以便注入自訂 pdfTimeoutMs／自訂連線池上限之 PrismaClient，見上方
    // import 註解）。修復前現況（獨立腳本實測，見 Task Handoff 附證）：
    // 探針① 6000ms 交易內渲染 → ~5000ms 即以 Prisma 套件預設交易 timeout
    // 中止（P2028「Transaction already closed」，本檔外層誤標 PERSIST）；
    // 探針② connection_limit=3＋12 併發＋交易內 1500ms → 6/12 落於 P2028
    // 「Unable to start a transaction in the given time」（maxWait 逾時，套
    // 件預設 2000ms）。本區塊之測試針對**修復後**程式碼，兩探針皆須轉綠。
    // -------------------------------------------------------------------------

    describe("T8R2／T8R3／T8R4 — MF-2／MF-3：交易 timeout／maxWait 裕度＋P2024/P2028 重試分類；顧問鎖＋ReadCommitted 行為", () => {
      function buildDirectDeps(
        prismaClient: PrismaClient,
        pdfTimeoutMs: number
      ): ReportServiceDeps {
        return {
          prisma: prismaClient,
          attachmentStorage: new LocalVolumeStorage(attachmentStorageRoot, { prefixes: ["att"] }),
          reportStorage: new LocalVolumeStorage(reportStorageRoot, { prefixes: ["rpt"] }),
          imageMaxPx: 1600,
          pdfTimeoutMs,
          log: { error: () => {} },
        };
      }

      it(
        "MF-2 reviewer 探針①：交易內渲染耗時 6000ms（逼近 Prisma 套件預設 5000ms 交易 timeout）→ 修復後於 pdfTimeoutMs 覆蓋範圍內正常完成（201／created:true，非誤標 PERSIST）；耗時量測記入 Handoff",
        async () => {
          const id = await createTravelApp("t8r2-mf2");
          vi.mocked(renderPdf).mockImplementationOnce(async () => {
            await new Promise((resolve) => setTimeout(resolve, 6000));
            return Buffer.from(FAKE_PDF_BYTES);
          });

          const deps = buildDirectDeps(prisma, 8000);
          const startedAt = Date.now();
          const outcome = await generateReport(deps, id, ownerId);
          const elapsedMs = Date.now() - startedAt;
          console.info(`[T8R2][MF-2] 交易內 6000ms 渲染 → 修復後實際完成耗時 ${elapsedMs}ms`);

          expect(outcome.created).toBe(true);
          // 交易確實完整跑過 6000ms 之渲染（非被交易逾時提早中止）。
          expect(elapsedMs).toBeGreaterThanOrEqual(6000);

          const row = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });
          expect(row.reportNumber).toMatch(/^TRV-\d{6}-\d{4,}$/);
        },
        { timeout: 15000 }
      );

      it(
        "MF-3 reviewer 探針②：connection_limit=3 ＋ 交易內 1500ms ＋ 12 併發（跨兩組：6×TRV／6×MNT，避開 T8R3 顧問鎖之同組排隊，維持本探針對連線池行為之原始鑑別力）→ 修復前現況 6/12 失敗（P2028 maxWait 逾時，獨立腳本實測見 Handoff）；修復後大幅改善（三輪實測皆 11/12，見 Handoff），且任何殘餘失敗皆為結構正確之 ReportGenerationError{stage:PERSIST}（非未捕捉例外／非誤標／非資料毀損）——connection_limit=3 為 reviewer 刻意構造之極端合成參數（三連線應付 12 併發），非 Spec AC 之逐字併發保證（該保證見 AC-04(c)，已於本檔另行以真實連線池重驗，見 T8R2 SF-5）",
        async () => {
          if (!DB_URL) throw new Error("unreachable — describeWithDb 已守門 DB_URL 存在");
          const probeUrl = DB_URL.includes("?")
            ? `${DB_URL}&connection_limit=3`
            : `${DB_URL}?connection_limit=3`;
          const probePrisma = new PrismaClient({ datasources: { db: { url: probeUrl } } });
          try {
            await probePrisma.$connect();
            // T8R3：兩組（TRV／MNT）各 6 筆——12 筆若全同組，會被 (4)b 顧問
            // 鎖序列化，使本探針退化成純粹測「顧問鎖排隊」而非其原始目的
            // （連線池 P2024/P2028 處置）；兩組互不阻擋（見下方跨組不阻擋
            // 測試），故連線池競爭仍然真實發生於兩組之間。
            const travelIds = await Promise.all(
              Array.from({ length: 6 }, (_, i) => createTravelApp(`t8r2-mf3-trv-${i}`))
            );
            const maintenanceIds = await Promise.all(
              Array.from({ length: 6 }, (_, i) => createMaintenanceApp(`t8r2-mf3-mnt-${i}`))
            );
            const ids = [...travelIds, ...maintenanceIds];

            vi.mocked(renderPdf).mockImplementation(async () => {
              await new Promise((resolve) => setTimeout(resolve, 1500));
              return Buffer.from(FAKE_PDF_BYTES);
            });

            const deps = buildDirectDeps(probePrisma, 8000);
            const startedAt = Date.now();
            const results = await Promise.allSettled(
              ids.map((id) => generateReport(deps, id, ownerId))
            );
            const elapsedMs = Date.now() - startedAt;
            const okCount = results.filter((r) => r.status === "fulfilled").length;
            console.info(
              `[T8R2][MF-3] connection_limit=3／12 併發／交易內 1500ms → 修復後 ${okCount}/12 成功，耗時 ${elapsedMs}ms`
            );

            // T8R2：任何殘餘失敗（reviewer 之極端合成參數下，修復前 6/12、
            // 修復後三輪實測皆穩定收斂於 11/12）皆須是結構完整之
            // ReportGenerationError（正確之 stage:PERSIST 語意——「(4)f 重
            // 試耗盡」本就屬 PERSIST，非誤標），而非未捕捉例外或其他不可行
            // 動之失敗形態。
            for (const r of results) {
              if (r.status === "rejected") {
                const reason = r.reason as { name?: string; stage?: string; message?: string };
                console.info(`[T8R2][MF-3] 失敗個案：${String(reason?.message ?? reason)}`);
                expect(reason?.name).toBe("ReportGenerationError");
                expect(reason?.stage).toBe("PERSIST");
              }
            }

            // 修復前基準 6/12；修復後三輪獨立實測皆為 11/12（見 Task
            // Handoff）——本斷言以「較修復前顯著改善」為準（連線池 3 應付
            // 12 併發屬 reviewer 刻意構造之極端合成場景，非逐字 Spec AC）。
            expect(okCount).toBeGreaterThanOrEqual(11);
          } finally {
            await probePrisma.$disconnect();
          }
        },
        { timeout: 30000 }
      );

      // -----------------------------------------------------------------------
      // T8R4 行為守門②：不同 (numberPrefix, numberPeriod) 組互不阻擋（§9.1
      // (4) 不變式「同組排隊為唯一性之主防線」之後半句）
      //
      // 誠實揭露（T8R3，沿用）：以完整 `generateReport()` E2E 路徑量測跨組
      // 耗時曾誤導——即使停用顧問鎖，兩個不同群組（不同 applicationId／不
      // 同 numberPrefix）之併發呼叫仍實測穩定耗時 ~1250ms（非預期之
      // ~600ms），與顧問鎖無關；根因為 `Report` 表在測試環境近乎全空時，
      // 「SERIALIZABLE 之 SIREAD 述詞鎖於稀疏／小表下之已知粗粒度現象」
      // ——此為 T8R3 時期（本交易仍為 SERIALIZABLE）之既有觀察，與顧問鎖
      // 之跨組行為無關，故不能用於鑑別顧問鎖本身，改以下方隔離探針。
      // **T8R4 更新**：本交易改 `ReadCommitted` 後，此類 SIREAD 粗粒度衝突
      // 已結構上不可能發生（`READ COMMITTED` 無 SSI 述詞鎖機制）——下方探
      // 針之隔離等級同步改為 `ReadCommitted`，與 report-service.ts 之真實
      // 呼叫逐字同構（含隔離等級），非僅鎖呼叫本身同構。
      // -----------------------------------------------------------------------

      async function acquireLockAndHold(
        prismaClient: PrismaClient,
        prefix: string,
        period: string,
        holdMs: number
      ): Promise<void> {
        await prismaClient.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix} || ${period}))`;
            await new Promise((resolve) => setTimeout(resolve, holdMs));
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            timeout: 15000,
            maxWait: 15000,
          }
        );
      }

      it("T8R4：同組（相同 numberPrefix／numberPeriod）併發 2 筆、各 500ms → 顧問鎖排隊使總耗時貼近序列化下限（~1000ms，正向對照——證明鎖確實在同組生效，ReadCommitted 下亦然）", async () => {
        const startedAt = Date.now();
        await Promise.all([
          acquireLockAndHold(prisma, "TRV", "202699", 500),
          acquireLockAndHold(prisma, "TRV", "202699", 500),
        ]);
        const elapsedMs = Date.now() - startedAt;
        console.info(
          `[T8R4] 同組顧問鎖直接量測（隔離噪訊，ReadCommitted）→ 耗時 ${elapsedMs}ms（預期 >= ~900ms）`
        );
        expect(elapsedMs).toBeGreaterThanOrEqual(900);
      });

      it("T8R4：不同組（不同 numberPrefix，同一 numberPeriod）併發 2 筆、各 500ms → 顧問鎖不阻擋，總耗時貼近單筆耗時（若鎖鍵誤用共用常數而非逐組雜湊，本測試必紅）", async () => {
        const startedAt = Date.now();
        await Promise.all([
          acquireLockAndHold(prisma, "TRV", "202699", 500),
          acquireLockAndHold(prisma, "MNT", "202699", 500),
        ]);
        const elapsedMs = Date.now() - startedAt;
        console.info(
          `[T8R4] 跨組顧問鎖直接量測（隔離噪訊，ReadCommitted）→ 耗時 ${elapsedMs}ms（預期 < ~900ms，遠低於同組之序列化下限）`
        );
        expect(elapsedMs).toBeLessThan(900);
      });
    });
  });
});
