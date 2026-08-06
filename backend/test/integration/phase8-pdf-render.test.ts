/**
 * PHASE-008-T7 — `pdf-renderer.ts`（Playwright 封裝：每請求啟動用畢即
 * 關、逾時、輸出校驗）
 *
 * ---------------------------------------------------------------------------
 * 規範出處（Spec `docs/specs/PHASE-008.md`）
 * ---------------------------------------------------------------------------
 * AC-09(a)：標準 fixture（差旅 3 段、每段 1 張 1600×1200 JPEG 證明）之產生
 *   端到端 ≤ 10 000 ms（於 dev 拓撲量測；量測值記入 Handoff）。
 * AC-09(b)：渲染逾時（`REPORT_PDF_TIMEOUT_MS`）觸發時，以明確錯誤收斂，不
 *   得懸掛、不留殭屍瀏覽器。
 * §9.1 步驟 (5)：`pdf = renderPdf(html, { timeoutMs })`；逾時 → 失敗路
 *   徑；校驗：`%PDF-` 開頭、`%%EOF` 結尾、`length > 0`。
 * §11.1（pdf-renderer 選項組裝，併入本檔）：逾時參數傳遞、啟動參數集合
 *   （`--no-sandbox` 等）之結構性斷言。
 * §16 D4：同容器、每次請求啟動用畢即關；`--no-sandbox --disable-dev-shm-usage`
 *   之安全取捨（已批准）。
 *
 * ---------------------------------------------------------------------------
 * 上游契約義務核銷（T5 Gate 移交）
 * ---------------------------------------------------------------------------
 * T5 `renderReportHtml` 已保證輸出零外部資源（AC-16(a)）——本檔之
 * `renderPdf` 對此 HTML 為純 pass-through（不改寫、不注入任何內容），
 * `page.setContent` 不需網路容忍。
 *
 * ---------------------------------------------------------------------------
 * 真實 Chromium 紀律（沿 phase8-report-images.test.ts 之「procedurally 產
 * 生合成資料」慣例）
 * ---------------------------------------------------------------------------
 * 本檔全程使用真實 `playwright` `chromium.launch()`（Spec 要求「真實
 * Chromium」）。結構性／mutant 斷言以 `vi.spyOn` **包裹**（非取代）真實實
 * 作——spy 內部呼叫原始方法後才回傳，故渲染行為與位元組皆為真實 Chromium
 * 產出，spy 僅用於觀察呼叫參數與副作用次數。
 */

import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPdf } from "../../src/reports/pdf-renderer.js";
import type {
  ReportCommon,
  ReportData,
  ReportImage,
  TravelReportBody,
  TravelSegmentReport,
} from "../../src/reports/report-data.js";
import { renderReportHtml } from "../../src/reports/report-html.js";

// ---------------------------------------------------------------------------
// Fixture 建構器（合成資料，零 DB；沿 report-html.test.ts／
// phase8-report-images.test.ts 既有慣例）
// ---------------------------------------------------------------------------

function makeCommon(overrides: Partial<ReportCommon> = {}): ReportCommon {
  return {
    reportNumber: "TRV-202608-0001",
    generatedAt: "2026-08-06T03:00:00.000Z",
    ownerDisplayName: "王小明",
    typeLabel: "差旅",
    statusLabel: "已完成",
    createdAt: "2026-08-01T09:00:00.000Z",
    totalAmount: 1234,
    ...overrides,
  };
}

function makeImage(id: string, dataUri: string | null): ReportImage {
  return {
    attachmentId: id,
    storageKey: `att/${id}/orig`,
    mimeType: "image/jpeg",
    originalFilename: `${id}.jpg`,
    dataUri,
    missing: false,
  };
}

function makeSegment(overrides: Partial<TravelSegmentReport>): TravelSegmentReport {
  return {
    sortOrder: 1,
    origin: "台北",
    destination: "新竹",
    totalKm: "60.00",
    highwayKm: "50.00",
    segmentAmount: 300,
    attachments: [],
    ...overrides,
  };
}

/** 產生一張真實可解碼之 JPEG（procedurally 產生，非真實照片），回傳 data URI。 */
async function makeJpegDataUri(width: number, height: number): Promise<string> {
  const sharp = (await import("sharp")).default;
  const bytes = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 30, g: 120, b: 200 },
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

function makeTravelBody(segments: TravelSegmentReport[]): TravelReportBody {
  return {
    model: "CURRENT",
    tripDate: "2026-08-01",
    purpose: "拜訪客戶洽談合約",
    segments,
    totalKm: "60.00",
    preRoundingTotal: "1234.5678",
    fuelUnitPrice: "2.5000",
    etcUnitPrice: "1.2000",
    fuelType: "GASOLINE_95",
    fuelPricePerLiter: "30.5000",
    fuelConsumption: "12.3400",
  };
}

/** AC-09(a) 標準 fixture：差旅 3 段，每段 1 張 1600×1200 JPEG 證明。 */
async function makeStandardFixtureHtml(): Promise<string> {
  const dataUri = await makeJpegDataUri(1600, 1200);
  const segments: TravelSegmentReport[] = [1, 2, 3].map((n) =>
    makeSegment({
      sortOrder: n,
      origin: `出發地${n}`,
      destination: `到達地${n}`,
      totalKm: "20.00",
      highwayKm: "10.00",
      segmentAmount: 200,
      attachments: [makeImage(`seg${n}img`, dataUri)],
    })
  );
  const data: ReportData = {
    kind: "TRAVEL",
    common: makeCommon(),
    travel: makeTravelBody(segments),
  };
  return renderReportHtml(data);
}

/** 極小 HTML，供不需效能寫實度的結構性／逾時測試使用（加速套件）。 */
function makeTinyHtml(): string {
  const data: ReportData = {
    kind: "TRAVEL",
    common: makeCommon(),
    travel: makeTravelBody([makeSegment({ sortOrder: 1, attachments: [] })]),
  };
  return renderReportHtml(data);
}

// ---------------------------------------------------------------------------
// Chromium spy 包裹器 — 包住（非取代）真實 chromium.launch，供結構性／
// mutant 斷言觀察 launch 參數、setContent/pdf 呼叫、browser.close 次數，
// 且必要時可覆寫 pdf() 之回傳位元組（模擬 Chromium 回傳異常資料）。
// ---------------------------------------------------------------------------

interface ChromiumSpyHandle {
  launchArgsCalls: string[][];
  setContentTimeouts: (number | undefined)[];
  closeCallCount: number;
}

function installChromiumSpy(pdfOverride?: (realBytes: Buffer) => Buffer): ChromiumSpyHandle {
  const handle: ChromiumSpyHandle = {
    launchArgsCalls: [],
    setContentTimeouts: [],
    closeCallCount: 0,
  };

  const realLaunch = chromium.launch.bind(chromium);

  vi.spyOn(chromium, "launch").mockImplementation(async (launchOptions) => {
    handle.launchArgsCalls.push([...(launchOptions?.args ?? [])]);
    const browser = await realLaunch(launchOptions);

    const realNewPage = browser.newPage.bind(browser);
    vi.spyOn(browser, "newPage").mockImplementation(
      async (...args: Parameters<typeof realNewPage>) => {
        const page = await realNewPage(...args);

        const realSetContent = page.setContent.bind(page);
        vi.spyOn(page, "setContent").mockImplementation(
          async (html: string, contentOptions?: { timeout?: number; waitUntil?: string }) => {
            handle.setContentTimeouts.push(contentOptions?.timeout);
            return realSetContent(html, contentOptions as never);
          }
        );

        const realPdf = page.pdf.bind(page);
        vi.spyOn(page, "pdf").mockImplementation(async (pdfOptions?: Record<string, unknown>) => {
          const realBytes = await realPdf(pdfOptions as never);
          return pdfOverride ? pdfOverride(realBytes) : realBytes;
        });

        return page;
      }
    );

    const realClose = browser.close.bind(browser);
    vi.spyOn(browser, "close").mockImplementation(async (...args: Parameters<typeof realClose>) => {
      handle.closeCallCount += 1;
      return realClose(...args);
    });

    return browser;
  });

  return handle;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC-09(a) 效能：標準 fixture 端到端 <= 10000ms
// ---------------------------------------------------------------------------

describe("AC-09(a) 效能守門", () => {
  it(
    "AC-09(a): 標準 fixture（差旅 3 段、每段 1600x1200 JPEG）之產生端到端 <= 10000ms",
    async () => {
      const html = await makeStandardFixtureHtml();

      const start = Date.now();
      const pdf = await renderPdf(html, { timeoutMs: 30000 });
      const elapsedMs = Date.now() - start;

      // 量測值輸出於 log（Spec 要求記入 Handoff）——本行為刻意保留，供人工複查。
      console.log(`[AC-09(a)] renderPdf elapsed = ${elapsedMs}ms (budget 10000ms)`);

      expect(elapsedMs).toBeLessThanOrEqual(10000);
      expect(pdf.length).toBeGreaterThan(1024);
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    },
    { timeout: 25000 }
  );
});

// ---------------------------------------------------------------------------
// AC-09(b) 逾時：明確錯誤、不懸掛、瀏覽器確實關閉
// ---------------------------------------------------------------------------

describe("AC-09(b) 逾時守門", () => {
  it(
    "AC-09(b): timeoutMs 極小時 renderPdf 以明確錯誤 reject，且 wall time 遠低於預設 30000ms（不懸掛）",
    async () => {
      const html = makeTinyHtml();

      const start = Date.now();
      await expect(renderPdf(html, { timeoutMs: 1 })).rejects.toThrow(/timeout/i);
      const elapsedMs = Date.now() - start;

      // 「不懸掛」之量測式證明：即使 timeoutMs=1，實際耗時仍遠低於預設
      // 30000ms（給予啟動與收斂緩衝，門檻設 5000ms）。
      expect(elapsedMs).toBeLessThan(5000);
    },
    { timeout: 10000 }
  );

  it(
    "AC-09(b) 殭屍瀏覽器防禦：逾時路徑 browser.close() 仍確實被呼叫恰一次（mutant「逾時不關瀏覽器」自證點）",
    async () => {
      const handle = installChromiumSpy();
      const html = makeTinyHtml();

      await expect(renderPdf(html, { timeoutMs: 1 })).rejects.toThrow(/timeout/i);

      expect(handle.closeCallCount).toBe(1);
    },
    { timeout: 10000 }
  );

  it("成功路徑 browser.close() 亦確實被呼叫恰一次（正向對照）", async () => {
    const handle = installChromiumSpy();
    const html = makeTinyHtml();

    await renderPdf(html, { timeoutMs: 30000 });

    expect(handle.closeCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §11.1 結構性斷言：啟動參數集合、逾時參數傳遞
// ---------------------------------------------------------------------------

describe("§11.1 pdf-renderer 選項組裝之結構性斷言", () => {
  it("啟動參數集合含 --no-sandbox 與 --disable-dev-shm-usage（mutant「參數移除」自證點）", async () => {
    const handle = installChromiumSpy();
    const html = makeTinyHtml();

    await renderPdf(html, { timeoutMs: 30000 });

    expect(handle.launchArgsCalls).toHaveLength(1);
    expect(handle.launchArgsCalls[0]).toEqual(
      expect.arrayContaining(["--no-sandbox", "--disable-dev-shm-usage"])
    );
  });

  it("逾時參數（options.timeoutMs）逐字傳遞至 page.setContent 之 timeout 選項", async () => {
    const handle = installChromiumSpy();
    const html = makeTinyHtml();

    await renderPdf(html, { timeoutMs: 12345 });

    expect(handle.setContentTimeouts).toEqual([12345]);
  });
});

// ---------------------------------------------------------------------------
// PDF 校驗（§9.1 步驟 5）：page.pdf() 輸出異常時 renderPdf 必拋出明確錯誤
// ---------------------------------------------------------------------------

describe("PDF 校驗（§9.1 步驟 5：%PDF- 開頭／%%EOF 結尾／非零長度）", () => {
  it("page.pdf() 回傳非合法 PDF 位元組（無 %PDF- 開頭）時，renderPdf 拋出明確錯誤（mutant「PDF 校驗跳過」自證點）", async () => {
    installChromiumSpy(() => Buffer.from("not a pdf at all, just garbage bytes"));
    const html = makeTinyHtml();

    await expect(renderPdf(html, { timeoutMs: 30000 })).rejects.toThrow(/%PDF-/);
  });

  it("page.pdf() 回傳零長度位元組時，renderPdf 拋出明確錯誤", async () => {
    installChromiumSpy(() => Buffer.alloc(0));
    const html = makeTinyHtml();

    await expect(renderPdf(html, { timeoutMs: 30000 })).rejects.toThrow(/zero-length/i);
  });

  it("page.pdf() 回傳缺 %%EOF 結尾之位元組時，renderPdf 拋出明確錯誤", async () => {
    installChromiumSpy((real) =>
      Buffer.concat([real.subarray(0, real.length - 10), Buffer.from("XXXXXXXXXX")])
    );
    const html = makeTinyHtml();

    await expect(renderPdf(html, { timeoutMs: 30000 })).rejects.toThrow(/%%EOF/);
  });

  it("真實 Chromium 正常路徑輸出通過 %PDF- 開頭／%%EOF 結尾／非零長度校驗（讀回非零長度）", async () => {
    const html = makeTinyHtml();

    const pdf = await renderPdf(html, { timeoutMs: 30000 });

    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(
      pdf
        .subarray(Math.max(0, pdf.length - 16))
        .toString("latin1")
        .trimEnd()
    ).toMatch(/%%EOF$/);
  });
});
