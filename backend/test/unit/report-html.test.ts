/**
 * PHASE-008-T5 — `report-html.ts`（列印版 HTML 版型純函式）
 *
 * ---------------------------------------------------------------------------
 * 規範出處（Spec `docs/specs/PHASE-008.md`）
 * ---------------------------------------------------------------------------
 * §2.D AC-11（三型必含項目逐字標題與值，缺任一項必紅）；AC-12（行程段
 *   `sortOrder` 升冪 ＋ 每段截圖恰為該段附件，段—圖錯置 mutant 必紅）；
 *   AC-15 純函式側（同輸入兩次呼叫 `toEqual`）；AC-16(a)（零 `<script`、零
 *   `on*=`、零外部資源、圖片皆 `data:` URI）；AC-16(b)（3 payload × 5 插值
 *   點皆跳脫，移除跳脫之 mutant 必紅）。
 * §7.4：`renderReportHtml` 為純函式，無 IO、無 DB、無隨機、無時鐘。
 * §16 D8：後端產生列印版 HTML（本 Task 僅涵蓋純函式，接線於 T10）。
 * §16 D16：證明圖片以 `data:` URI 嵌入（`sharp` 降尺寸於 T6，本檔僅原樣渲染
 *   `ReportImage.dataUri`）。
 * Packet 上游義務：FW-1（輸出零 `storageKey`／`attachmentId` 值、零
 *   `rpt/`／`att/` 字樣）；FW-6（日期格式化不寫第五份——本檔零日期重新格式
 *   化，原樣呈現 `ReportData` 已組裝之字串）；T2 FW-4（不重算報表編號，僅原
 *   樣渲染 `common.reportNumber`）。
 *
 * ---------------------------------------------------------------------------
 * 鑑別力設計（本檔）
 * ---------------------------------------------------------------------------
 * 1. AC-11：三型（CURRENT 模型）各一測試，逐項 `toContain` 標題文字與對應
 *    值；任一項被刪除即紅（Handoff 附實測紅燈）。
 * 2. AC-12：3 段 fixture（輸入刻意非 `sortOrder` 順序），以正則抽出
 *    `.segment` 與 `.segment-images` 兩組區塊，逐塊比對「序號」與該段專屬
 *    `dataUri`；「取首段之圖給所有段」與「反序」兩個 mutant 之紅燈實證見
 *    Handoff（手動暫改 `report-html.ts` 後重跑本檔）。
 * 3. AC-15：三型各建構一份 fixture，呼叫兩次 `toEqual`。
 * 4. AC-16(a)：以含至少一張圖片、一段行程之完整 fixture，正則掃描零
 *    `<script`、零 `on\w+=`、零 `<link`、零 `http(s)://`／`//` 開頭之
 *    `src`／`href`／`url(`、零 `@import`；正向斷言 `<img src="data:` 在場。
 * 5. AC-16(b)：3 payload（`<script>alert(1)</script>`、
 *    `"><img src=x onerror=alert(1)>`、`&amp;`）× 5 插值點（申請人姓名、
 *    出差目的、出發地、到達地、附件原始檔名）＝15 格逐一斷言：輸出不含原始
 *    危險子字串、且含 `escapeHtml(payload)` 之跳脫結果；`escapeHtml` 亦有
 *    直接單元測試（`&amp;` 雙重跳脫：驗證 `&` 優先跳脫，結果為
 *    `&amp;amp;`）。
 * 6. FW-1：fixture 之 `storageKey`／`attachmentId` 刻意設為可辨識字面值
 *    （含 `att/` 前綴），斷言輸出逐字不含之；並掃描全文零 `rpt/`／`att/`
 *    子字串。
 * 7. 樣式規則在場（AC-13(a) 結構前提／AC-14 結構前提／AC-34 樣式前提）：
 *    `max-width: 100%`、`break-inside: avoid`、`@media print` 區塊內
 *    `.print-hint { display: none; }`、螢幕內容含 `.print-hint` 文字。
 * 8. B-09（零附件）：折舊 fixture 之 `attachments: []` 不 crash 且顯示
 *    「無證明圖片」而非空白。
 * 9. MF-1（PHASE-008-T5R；AC-17(a)(b) 逐字）：LEGACY 六欄（差旅油種／每公升
 *    油價／車輛油耗；折舊每年折舊費用／年度總里程／公務比例）恆常渲染、值
 *    以「—」呈現——正向斷言三標籤在場＋值恰為「—」（逐字比對整個 field 區
 *    塊，鑑別 `dash()`→`String()` 之 mutant）。AC-17 資料側之完整覆蓋仍屬
 *    T4 `phase8-report-data.test.ts`。
 * 10. MF-2（T5R）：折舊／差旅 `.reconciliation avoid-break` 區塊以
 *    `extractReconciliationBlock` 擷取內容後逐字比對完整算式子字串（fixture
 *    刻意令 `totalAmount` 與三來源值之真實運算結果不同，鑑別「真算術」
 *    mutant；區塊不存在即失敗，鑑別「清空」mutant）；另補
 *    `blankCommentsAndStrings` 結構性掃描（零 `.times(`／`.div(`／`.plus(`／
 *    `.minus(`）。
 * 11. SF-2（T5R；AC-11「取整前總額之對帳列」）：差旅取整前總額改以
 *    `.reconciliation avoid-break` 區塊呈現（比照折舊同一結構），純字串串接
 *    零算術。
 * 12. SF-3（T5R）：`renderImage()` 之 `dataUri` 屬性上下文——惡意 dataUri
 *    （`" onerror="alert(1)`）不得產生可執行 `on*=` 屬性、引號已跳脫（鑑別
 *    M11）。
 * 13. SF-4（T5R；§7.4 純函式零時鐘零隨機）：`blankCommentsAndStrings` 結構
 *    性掃描零 `Date.now(`／`new Date(`／`Math.random(`（鑑別 M14「同毫秒繞
 *    過」——AC-15 之 `toEqual` 測試因兩次呼叫時間差過小而無鑑別力，須由本結
 *    構性掃描補強）。
 * 14. PHASE-008-MOCK-R1（Mock Gate 三裁定之呈現面落地；Spec AC-11 修訂引註）：
 *    ⒜【裁-2】共通項計數由「8 個欄位列」改為「7 個欄位列 ＋ 1 個類型大標
 *    題」——「報表標題」欄位列之負向斷言（`not.toContain`）＋ `<h1>` 大標題
 *    正向斷言。⒝【裁-1】「產生時間」／「申請建立時間」改台北時區中文在地化
 *    （`report-labels.ts` `formatTaipeiDateTime`）——`report-labels.ts` 直接
 *    單元測試（含跨日邊界、上午／下午兩側）＋ `renderReportHtml` 整合層之格
 *    式化值正向斷言＋原始 ISO 字面值負向斷言。⒞【裁-3】差旅油種改中文名稱
 *    （`getFuelTypeLabel`）——四值逐字對照＋列舉代碼（`GASOLINE_92` 等）不
 *    在場之負向斷言；LEGACY「—」呈現不變（正向斷言沿用既有 MF-1 套件）。三
 *    類 mutant（還原報表標題欄位列／移除時間格式化／油種顯示列舉代碼）之紅
 *    燈實證見 Task Handoff。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ApplicationType, FuelType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type {
  DepreciationReportBody,
  MaintenanceReportBody,
  ReportCommon,
  ReportData,
  ReportImage,
  TravelReportBody,
  TravelSegmentReport,
} from "../../src/reports/report-data.js";
import { escapeHtml, renderReportHtml } from "../../src/reports/report-html.js";
import { formatTaipeiDateTime, getFuelTypeLabel } from "../../src/reports/report-labels.js";

// ---------------------------------------------------------------------------
// Fixture 建構器（合成資料，零 DB）
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

function makeImage(
  id: string,
  dataUri: string | null,
  overrides: Partial<ReportImage> = {}
): ReportImage {
  return {
    attachmentId: id,
    storageKey: `att/${id}/orig`,
    mimeType: "image/jpeg",
    originalFilename: `${id}.jpg`,
    dataUri,
    missing: false,
    ...overrides,
  };
}

function makeSegment(overrides: Partial<TravelSegmentReport> = {}): TravelSegmentReport {
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

/** 3 段（輸入刻意非 sortOrder 順序：3, 1, 2），每段各一張可辨識圖片。 */
function makeThreeSegments(): TravelSegmentReport[] {
  return [
    makeSegment({
      sortOrder: 3,
      origin: "第三段出發地C",
      destination: "第三段到達地C",
      totalKm: "30.00",
      highwayKm: "10.00",
      segmentAmount: 300,
      attachments: [makeImage("seg3img", "data:image/png;base64,SEG3DATAXXXX")],
    }),
    makeSegment({
      sortOrder: 1,
      origin: "第一段出發地A",
      destination: "第一段到達地A",
      totalKm: "10.00",
      highwayKm: "5.00",
      segmentAmount: 100,
      attachments: [makeImage("seg1img", "data:image/png;base64,SEG1DATAXXXX")],
    }),
    makeSegment({
      sortOrder: 2,
      origin: "第二段出發地B",
      destination: "第二段到達地B",
      totalKm: "20.00",
      highwayKm: "8.00",
      segmentAmount: 200,
      attachments: [makeImage("seg2img", "data:image/png;base64,SEG2DATAXXXX")],
    }),
  ];
}

function makeTravelBody(overrides: Partial<TravelReportBody> = {}): TravelReportBody {
  return {
    model: "CURRENT",
    tripDate: "2026-08-01",
    purpose: "拜訪客戶洽談合約",
    segments: makeThreeSegments(),
    totalKm: "60.00",
    preRoundingTotal: "1234.5678",
    fuelUnitPrice: "2.5000",
    etcUnitPrice: "1.2000",
    fuelType: "GASOLINE_95",
    fuelPricePerLiter: "30.5000",
    fuelConsumption: "12.3400",
    ...overrides,
  };
}

function travelData(overrides: {
  common?: Partial<ReportCommon>;
  travel?: Partial<TravelReportBody>;
}): Extract<ReportData, { kind: "TRAVEL" }> {
  return {
    kind: "TRAVEL",
    common: makeCommon({ typeLabel: "差旅", ...overrides.common }),
    travel: makeTravelBody(overrides.travel),
  };
}

function makeMaintenanceBody(
  overrides: Partial<MaintenanceReportBody> = {}
): MaintenanceReportBody {
  return {
    lastMaintenanceDate: "2026-05-01",
    currentMaintenanceDate: "2026-08-01",
    lastOdometerKm: "10000.00",
    currentOdometerKm: "10500.00",
    intervalKm: "500.00",
    officialKm: "300.00",
    ratioPercent: "60.0000",
    actualCost: "3000.00",
    companyAmount: 1800,
    attachments: [makeImage("mnt1", "data:image/png;base64,MNTDATAXXXX")],
    ...overrides,
  };
}

function maintenanceData(overrides: {
  common?: Partial<ReportCommon>;
  maintenance?: Partial<MaintenanceReportBody>;
}): Extract<ReportData, { kind: "MAINTENANCE" }> {
  return {
    kind: "MAINTENANCE",
    common: makeCommon({ typeLabel: "保養", reportNumber: "MNT-202608-0001", ...overrides.common }),
    maintenance: makeMaintenanceBody(overrides.maintenance),
  };
}

function makeDepreciationBody(
  overrides: Partial<DepreciationReportBody> = {}
): DepreciationReportBody {
  return {
    model: "CURRENT",
    applicationYear: 2026,
    annualDepreciation: "12000.00",
    annualTotalKm: "20000.0",
    ratioPercent: "50.0000",
    perKmUnitPrice: null,
    officialKm: "10000.00",
    attachments: [makeImage("dep1", "data:image/png;base64,DEPDATAXXXX")],
    ...overrides,
  };
}

function depreciationData(overrides: {
  common?: Partial<ReportCommon>;
  depreciation?: Partial<DepreciationReportBody>;
}): Extract<ReportData, { kind: "DEPRECIATION" }> {
  return {
    kind: "DEPRECIATION",
    common: makeCommon({
      typeLabel: "折舊",
      reportNumber: "DEP-202608-0001",
      totalAmount: 6000,
      ...overrides.common,
    }),
    depreciation: makeDepreciationBody(overrides.depreciation),
  };
}

// ---------------------------------------------------------------------------
// escapeHtml — 直接單元測試
// ---------------------------------------------------------------------------

describe("escapeHtml — 唯一跳脫函式", () => {
  it("跳脫 & < > \" '", () => {
    expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("& 優先跳脫，避免雙重跳脫錯位：輸入 '&amp;' → '&amp;amp;'", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("<script>alert(1)</script> → 逐字元跳脫，零原始標籤", () => {
    const result = escapeHtml("<script>alert(1)</script>");
    expect(result).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(result).not.toContain("<script");
  });

  it('"><img src=x onerror=alert(1)> → 逐字元跳脫，零屬性逃逸', () => {
    const result = escapeHtml('"><img src=x onerror=alert(1)>');
    expect(result).toBe("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  });

  it("非字串類插值（純數字字面）不受影響", () => {
    expect(escapeHtml("12345")).toBe("12345");
  });
});

// ---------------------------------------------------------------------------
// report-labels.ts — 直接單元測試（PHASE-008-MOCK-R1；裁-1／裁-3）
// ---------------------------------------------------------------------------

describe("getFuelTypeLabel（裁-3）— 四值逐字對照", () => {
  it("GASOLINE_92 → 「92 無鉛汽油」", () => {
    expect(getFuelTypeLabel("GASOLINE_92")).toBe("92 無鉛汽油");
  });

  it("GASOLINE_95 → 「95 無鉛汽油」", () => {
    expect(getFuelTypeLabel("GASOLINE_95")).toBe("95 無鉛汽油");
  });

  it("GASOLINE_98 → 「98 無鉛汽油」", () => {
    expect(getFuelTypeLabel("GASOLINE_98")).toBe("98 無鉛汽油");
  });

  it("DIESEL → 「柴油」", () => {
    expect(getFuelTypeLabel("DIESEL")).toBe("柴油");
  });
});

describe("formatTaipeiDateTime（裁-1）— DTO 給定 ISO 值 → 期望顯示字串", () => {
  it("上午側：2026-08-06T03:00:00.000Z（+8h＝台北 11:00）→ 「2026/8/6 上午11:00」", () => {
    expect(formatTaipeiDateTime("2026-08-06T03:00:00.000Z")).toBe("2026/8/6 上午11:00");
  });

  it("與前端「計算時間」同一長相之範例：2026-08-06T01:23:00.000Z（+8h＝台北 9:23）→ 「2026/8/6 上午9:23」", () => {
    expect(formatTaipeiDateTime("2026-08-06T01:23:00.000Z")).toBe("2026/8/6 上午9:23");
  });

  it("下午側：2026-08-06T09:05:00.000Z（+8h＝台北 17:05）→ 「2026/8/6 下午5:05」", () => {
    expect(formatTaipeiDateTime("2026-08-06T09:05:00.000Z")).toBe("2026/8/6 下午5:05");
  });

  it("跨日邊界：2026-08-06T16:00:00.000Z（+8h＝台北隔日 00:00）→ 「2026/8/7 上午12:00」", () => {
    expect(formatTaipeiDateTime("2026-08-06T16:00:00.000Z")).toBe("2026/8/7 上午12:00");
  });

  it("正午邊界：2026-08-06T04:00:00.000Z（+8h＝台北 12:00）→ 「2026/8/6 下午12:00」", () => {
    expect(formatTaipeiDateTime("2026-08-06T04:00:00.000Z")).toBe("2026/8/6 下午12:00");
  });

  it("分鐘補零：2026-08-06T03:05:00.000Z（+8h＝台北 11:05）→ 分鐘固定 2 位「05」", () => {
    expect(formatTaipeiDateTime("2026-08-06T03:05:00.000Z")).toBe("2026/8/6 上午11:05");
  });
});

// ---------------------------------------------------------------------------
// AC-11 — 三型必含項目逐字標題與值
// ---------------------------------------------------------------------------

describe("AC-11 — 三型列印版必含逐字標題與值", () => {
  it("差旅：共通 7 欄位列 ＋ 1 類型大標題〔裁-2〕＋ 差旅專屬全數在場", () => {
    const data = travelData({});
    const html = renderReportHtml(data);

    // 共通（裁-2：「報表標題」欄位列不再以標籤＋值呈現，資訊改由 <h1> 承載）
    expect(html).not.toContain("報表標題");
    expect(html).toContain("<h1>差旅報表</h1>");
    expect(html).toContain("報表編號");
    expect(html).toContain(data.common.reportNumber as string);
    expect(html).toContain("產生時間");
    // 裁-1：「產生時間」以台北時區中文在地化格式呈現，原始 ISO 字面值不出現。
    expect(html).toContain(formatTaipeiDateTime(data.common.generatedAt as string));
    expect(html).not.toContain(data.common.generatedAt as string);
    expect(html).toContain("申請人姓名");
    expect(html).toContain(data.common.ownerDisplayName);
    expect(html).toContain("申請類型");
    expect(html).toContain("差旅");
    expect(html).toContain("申請狀態");
    expect(html).toContain(data.common.statusLabel);
    expect(html).toContain("申請建立時間");
    // 裁-1：「申請建立時間」同批同一格式化，原始 ISO 字面值不出現。
    expect(html).toContain(formatTaipeiDateTime(data.common.createdAt));
    expect(html).not.toContain(data.common.createdAt);
    expect(html).toContain("最終金額");
    expect(html).toContain(String(data.common.totalAmount));

    // 差旅專屬
    const travel = data.travel;
    expect(html).toContain("出差日期");
    expect(html).toContain(travel.tripDate as string);
    expect(html).toContain("出差目的");
    expect(html).toContain(travel.purpose as string);
    expect(html).toContain("序號");
    expect(html).toContain("出發地");
    expect(html).toContain("到達地");
    expect(html).toContain("總里程");
    expect(html).toContain("高速里程");
    expect(html).toContain("段金額");
    expect(html).toContain(travel.totalKm);
    expect(html).toContain("油資每公里單價");
    expect(html).toContain(travel.fuelUnitPrice);
    expect(html).toContain("ETC 每公里單價");
    expect(html).toContain(travel.etcUnitPrice);
    expect(html).toContain("油種");
    // 裁-3：油種以中文名稱呈現，列舉代碼字面值不出現。
    expect(html).toContain(getFuelTypeLabel(travel.fuelType as FuelType));
    expect(html).not.toContain(travel.fuelType as string);
    expect(html).toContain("每公升油價");
    expect(html).toContain(travel.fuelPricePerLiter as string);
    expect(html).toContain("車輛油耗");
    expect(html).toContain(travel.fuelConsumption as string);
    expect(html).toContain("取整前總額");
    expect(html).toContain(travel.preRoundingTotal);
    expect(html).toContain("各段證明截圖");
    for (const seg of travel.segments) {
      for (const att of seg.attachments) {
        expect(html).toContain(att.dataUri as string);
      }
    }
  });

  it("保養：共通 7 欄位列 ＋ 1 類型大標題〔裁-2〕＋ 保養專屬全數在場", () => {
    const data = maintenanceData({});
    const html = renderReportHtml(data);
    const maintenance = data.maintenance;

    expect(html).not.toContain("報表標題");
    expect(html).toContain("<h1>保養報表</h1>");
    expect(html).toContain("報表編號");
    expect(html).toContain(data.common.reportNumber as string);
    expect(html).toContain("產生時間");
    expect(html).toContain("申請人姓名");
    expect(html).toContain(data.common.ownerDisplayName);
    expect(html).toContain("申請類型");
    expect(html).toContain("保養");
    expect(html).toContain("申請狀態");
    expect(html).toContain("申請建立時間");
    expect(html).toContain("最終金額");
    expect(html).toContain(String(data.common.totalAmount));

    expect(html).toContain("上次保養日期");
    expect(html).toContain(maintenance.lastMaintenanceDate as string);
    expect(html).toContain("本次保養日期");
    expect(html).toContain(maintenance.currentMaintenanceDate as string);
    expect(html).toContain("上次里程表");
    expect(html).toContain(maintenance.lastOdometerKm as string);
    expect(html).toContain("本次里程表");
    expect(html).toContain(maintenance.currentOdometerKm as string);
    expect(html).toContain("保養區間總里程");
    expect(html).toContain(maintenance.intervalKm);
    expect(html).toContain("期間公務里程");
    expect(html).toContain(maintenance.officialKm);
    expect(html).toContain("公務使用比例");
    expect(html).toContain(maintenance.ratioPercent);
    expect(html).toContain("實際費用");
    expect(html).toContain(maintenance.actualCost);
    expect(html).toContain("公司分攤金額");
    expect(html).toContain(String(maintenance.companyAmount));
    expect(html).toContain("證明圖片");
    for (const att of maintenance.attachments) {
      expect(html).toContain(att.dataUri as string);
    }
  });

  it("折舊（CURRENT）：共通 7 欄位列 ＋ 1 類型大標題〔裁-2〕＋ 折舊專屬五值全數在場", () => {
    const data = depreciationData({});
    const html = renderReportHtml(data);
    const depreciation = data.depreciation;

    expect(html).not.toContain("報表標題");
    expect(html).toContain("<h1>折舊報表</h1>");
    expect(html).toContain("報表編號");
    expect(html).toContain(data.common.reportNumber as string);
    expect(html).toContain("產生時間");
    expect(html).toContain("申請人姓名");
    expect(html).toContain("申請類型");
    expect(html).toContain("折舊");
    expect(html).toContain("申請狀態");
    expect(html).toContain("申請建立時間");
    expect(html).toContain("最終金額");

    expect(html).toContain("申請年度");
    expect(html).toContain(String(depreciation.applicationYear));
    expect(html).toContain("每年折舊費用");
    expect(html).toContain(depreciation.annualDepreciation as string);
    expect(html).toContain("年度公務里程");
    expect(html).toContain(depreciation.officialKm);
    expect(html).toContain("年度總里程");
    expect(html).toContain(depreciation.annualTotalKm as string);
    expect(html).toContain("公務比例");
    expect(html).toContain(depreciation.ratioPercent as string);
    expect(html).toContain("補貼金額");
    expect(html).toContain(String(data.common.totalAmount));
    expect(html).toContain("證明圖片");
    for (const att of depreciation.attachments) {
      expect(html).toContain(att.dataUri as string);
    }
  });

  it("折舊禁列（AC-18(b) 之落地防線）：車價／折舊年限／預估年度行駛公里數／折舊參數版本 id 之字面字串零出現", () => {
    const html = renderReportHtml(depreciationData({}));
    expect(html).not.toContain("車價");
    expect(html).not.toContain("折舊年限");
    expect(html).not.toContain("預估年度行駛公里數");
    expect(html).not.toContain("折舊參數版本");
  });

  it("折舊 CURRENT 對帳列（AC-18(c)）：以三來源值呈現算式", () => {
    const data = depreciationData({});
    const html = renderReportHtml(data);
    expect(html).toContain("計算依據");
    expect(html).toContain(data.depreciation.annualDepreciation as string);
    expect(html).toContain(data.depreciation.annualTotalKm as string);
    expect(html).toContain(String(data.common.totalAmount));
  });

  // -------------------------------------------------------------------------
  // MF-2① — .reconciliation 區塊內完整算式子字串逐字（鑑別「真算術」與「清空」
  // 兩種 mutant；沿用 `.reconciliation avoid-break` 為唯一 marker 之區塊擷取
  // 手法，同 AC-12 之 `splitByMarker`）。
  // -------------------------------------------------------------------------

  /** 擷取文件中第一個 `.reconciliation avoid-break` 區塊之內容（不含外層 div）。 */
  function extractReconciliationBlock(html: string): string | null {
    const match = html.match(/<div class="reconciliation avoid-break">([\s\S]*?)<\/div>/);
    return match ? (match[1] ?? "") : null;
  }

  it("折舊 CURRENT 對帳列（MF-2①）：.reconciliation 區塊內完整算式子字串逐字（M4 真算術／M21 清空皆須紅）", () => {
    // 刻意令 totalAmount 與三來源值之真實除法結果（12000.00×10000.00÷20000.0
    // ＝6000）不同——若 mutant 改為「真的算一次」而非原樣顯示 totalAmount，
    // 輸出會變成 6000 而非 9999，逐字比對即可鑑別；同一 mutant 若只是巧合地
    // 使兩者相等，將無法被舊版（僅檢查各值個別出現）之測試鑑別。
    const data = depreciationData({
      common: { totalAmount: 9999 },
      depreciation: {
        annualDepreciation: "12000.00",
        annualTotalKm: "20000.0",
        officialKm: "10000.00",
      },
    });
    const html = renderReportHtml(data);
    const block = extractReconciliationBlock(html);
    expect(block).not.toBeNull();
    expect(block).toContain("12000.00 × 10000.00 ÷ 20000.0 = 9999");
  });

  it("差旅取整前總額對帳列（SF-2；AC-11「取整前總額之對帳列」）：.reconciliation 區塊內完整算式子字串逐字", () => {
    const data = travelData({
      common: { totalAmount: 9999 },
      travel: { preRoundingTotal: "1234.5678" },
    });
    const html = renderReportHtml(data);
    const block = extractReconciliationBlock(html);
    expect(block).not.toBeNull();
    expect(block).toContain("取整前總額 1234.5678 → 四捨五入 → 最終金額 9999");
  });
});

// ---------------------------------------------------------------------------
// AC-12 — 段序升冪與段—圖對應
// ---------------------------------------------------------------------------

/**
 * 以固定 marker 切分文件為「該 marker 之後至下一個 marker（或文件結尾）」之
 * 區塊陣列（`String.prototype.split` 天然依左至右出現順序切分，恰可用於驗證
 * 依序渲染之相鄰區塊；比對非貪婪正則單一 `</div>` 更可靠——後者會在區塊內第
 * 一個巢狀 `</div>`（如 `.field` 自身之收尾）即提前終止，無法涵蓋整個區塊）。
 */
function splitByMarker(html: string, marker: string): string[] {
  return html.split(marker).slice(1);
}

describe("AC-12 — 行程段 sortOrder 升冪呈現且每段截圖恰為該段附件", () => {
  it("3 段（輸入非 sortOrder 順序）：資訊區塊依 1,2,3 升冪呈現", () => {
    const html = renderReportHtml(travelData({}));
    const infoBlocks = splitByMarker(html, '<div class="segment avoid-break">');
    expect(infoBlocks).toHaveLength(3);
    expect(infoBlocks[0]).toContain("第一段出發地A");
    expect(infoBlocks[1]).toContain("第二段出發地B");
    expect(infoBlocks[2]).toContain("第三段出發地C");
  });

  it("3 段：每個 segment-images 區塊僅含該段自身之 dataUri（段—圖錯置 mutant 之鑑別基礎）", () => {
    const html = renderReportHtml(travelData({}));
    const imageBlocks = splitByMarker(html, '<div class="segment-images">');
    expect(imageBlocks).toHaveLength(3);
    expect(imageBlocks[0]).toContain("SEG1DATAXXXX");
    expect(imageBlocks[0]).not.toContain("SEG2DATAXXXX");
    expect(imageBlocks[0]).not.toContain("SEG3DATAXXXX");
    expect(imageBlocks[1]).toContain("SEG2DATAXXXX");
    expect(imageBlocks[1]).not.toContain("SEG1DATAXXXX");
    expect(imageBlocks[1]).not.toContain("SEG3DATAXXXX");
    expect(imageBlocks[2]).toContain("SEG3DATAXXXX");
    expect(imageBlocks[2]).not.toContain("SEG1DATAXXXX");
    expect(imageBlocks[2]).not.toContain("SEG2DATAXXXX");
  });

  it("整體字串序：SEG1 早於 SEG2 早於 SEG3（升冪之總體不變式）", () => {
    const html = renderReportHtml(travelData({}));
    const idx1 = html.indexOf("SEG1DATAXXXX");
    const idx2 = html.indexOf("SEG2DATAXXXX");
    const idx3 = html.indexOf("SEG3DATAXXXX");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
  });
});

// ---------------------------------------------------------------------------
// AC-15 — 純函式：同輸入兩次呼叫 toEqual
// ---------------------------------------------------------------------------

describe("AC-15（純函式側）— 同一 ReportData 輸入之兩次呼叫結果 toEqual", () => {
  it("差旅", () => {
    const data = travelData({});
    expect(renderReportHtml(data)).toEqual(renderReportHtml(data));
  });

  it("保養", () => {
    const data = maintenanceData({});
    expect(renderReportHtml(data)).toEqual(renderReportHtml(data));
  });

  it("折舊", () => {
    const data = depreciationData({});
    expect(renderReportHtml(data)).toEqual(renderReportHtml(data));
  });

  it("兩個各自獨立建構、內容相同之輸入物件，結果亦 toEqual（非物件參考比較之巧合）", () => {
    const a = travelData({});
    const b = travelData({});
    expect(renderReportHtml(a)).toEqual(renderReportHtml(b));
  });
});

// ---------------------------------------------------------------------------
// AC-16(a) — 自足文件：零 script、零外部資源
// ---------------------------------------------------------------------------

describe("AC-16(a) — 列印版為自足文件", () => {
  const html = renderReportHtml(travelData({}));

  it("零 <script", () => {
    expect(/<script/i.test(html)).toBe(false);
  });

  it("零 on*= 事件屬性", () => {
    expect(/<[^>]+\son\w+\s*=/i.test(html)).toBe(false);
  });

  it("零 <link 標籤", () => {
    expect(/<link/i.test(html)).toBe(false);
  });

  it("零 http(s):// 或 // 開頭之 src／href", () => {
    expect(/(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(html)).toBe(false);
  });

  it("零 url( 外部資源（CSS）", () => {
    expect(/url\(\s*["']?(?:https?:)?\/\//i.test(html)).toBe(false);
  });

  it("零 @import", () => {
    expect(html).not.toContain("@import");
  });

  it('正向：圖片皆為 data: URI（至少一張 <img src="data: 在場）', () => {
    expect(/<img[^>]+src="data:/.test(html)).toBe(true);
  });

  it("零 <img src= 使用非 data: 前綴", () => {
    const srcs = [...html.matchAll(/<img[^>]+src="([^"]*)"/g)].map((m) => m[1]);
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) {
      expect(src.startsWith("data:")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-16(b) — 3 payload × 5 插值點，皆跳脫
// ---------------------------------------------------------------------------

describe("AC-16(b) — 3 payload × 5 插值點逐格跳脫", () => {
  const PAYLOADS = ["<script>alert(1)</script>", '"><img src=x onerror=alert(1)>', "&amp;"];

  function expectEscapedAndSafe(html: string, payload: string): void {
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('"><img src=x onerror=alert(1)>');
    expect(html).toContain(escapeHtml(payload));
  }

  for (const payload of PAYLOADS) {
    it(`payload=${JSON.stringify(payload)} — 申請人姓名`, () => {
      const html = renderReportHtml(travelData({ common: { ownerDisplayName: payload } }));
      expectEscapedAndSafe(html, payload);
    });

    it(`payload=${JSON.stringify(payload)} — 出差目的`, () => {
      const html = renderReportHtml(travelData({ travel: { purpose: payload } }));
      expectEscapedAndSafe(html, payload);
    });

    it(`payload=${JSON.stringify(payload)} — 出發地`, () => {
      const html = renderReportHtml(
        travelData({ travel: { segments: [makeSegment({ origin: payload })] } })
      );
      expectEscapedAndSafe(html, payload);
    });

    it(`payload=${JSON.stringify(payload)} — 到達地`, () => {
      const html = renderReportHtml(
        travelData({ travel: { segments: [makeSegment({ destination: payload })] } })
      );
      expectEscapedAndSafe(html, payload);
    });

    it(`payload=${JSON.stringify(payload)} — 附件原始檔名`, () => {
      const html = renderReportHtml(
        travelData({
          travel: {
            segments: [
              makeSegment({
                attachments: [
                  makeImage("x1", "data:image/png;base64,ABC", { originalFilename: payload }),
                ],
              }),
            ],
          },
        })
      );
      expectEscapedAndSafe(html, payload);
    });
  }
});

// ---------------------------------------------------------------------------
// SF-3 — 屬性上下文跳脫：惡意 dataUri（`<img src>` 屬性逃逸 payload）
// ---------------------------------------------------------------------------

describe("SF-3 — dataUri 屬性上下文跳脫（M11 鑑別：屬性逃逸 payload 不得產生真實屬性逃逸）", () => {
  it('惡意 dataUri（data:image/png;base64,AAA" onerror="alert(1)）之 src 屬性值恰為完整跳脫結果（引號未逃逸）', () => {
    const maliciousDataUri = 'data:image/png;base64,AAA" onerror="alert(1)';
    const html = renderReportHtml(
      travelData({
        travel: {
          segments: [makeSegment({ attachments: [makeImage("x2", maliciousDataUri)] })],
        },
      })
    );
    // 原始危險子字串（含未跳脫之 "）不得逐字出現。
    expect(html).not.toContain(maliciousDataUri);
    // 以樸素之「至第一個真實 " 為止」正則擷取 src 屬性值：若 escapeHtml 遭
    // 移除（mutant M11），payload 中間的原始 `"` 會提前截斷擷取結果（僅得
    // `data:image/png;base64,AAA`），與完整跳脫結果不相等，藉此鑑別。
    const match = html.match(/src="([^"]*)"/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(escapeHtml(maliciousDataUri));
  });
});

// ---------------------------------------------------------------------------
// FW-1（大總管授權順帶；T14 AC-34／AC-36 前提）— <head> viewport meta
// ---------------------------------------------------------------------------

describe("FW-1（大總管授權順帶）— <head> 含 viewport meta（T14 前提）", () => {
  it('<meta name="viewport" content="width=device-width, initial-scale=1"> 在場', () => {
    const html = renderReportHtml(travelData({}));
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  });
});

// ---------------------------------------------------------------------------
// FW-1（T4 移交）— 輸出零 storageKey／attachmentId 值、零 rpt/、att/ 字樣
// ---------------------------------------------------------------------------

describe("FW-1（T4 移交）— 輸出零 storageKey／attachmentId 值、零 rpt/、att/ 字樣", () => {
  // 注意：fixture 之 attachmentId／檔名刻意使用互不重疊之字面值（不像
  // makeImage 預設之 `${id}.jpg` 會使 id 巧合地成為檔名子字串），確保「零
  // attachmentId 值」之斷言不會被合法呈現之檔名意外滿足。
  it("差旅：fixture 之 storageKey／attachmentId 逐字不出現於輸出", () => {
    const img = makeImage("clxyz999SECRETID", "data:image/png;base64,ABC", {
      originalFilename: "photo-front.jpg",
    });
    const html = renderReportHtml(
      travelData({ travel: { segments: [makeSegment({ attachments: [img] })] } })
    );
    expect(html).not.toContain(img.storageKey);
    expect(html).not.toContain(img.attachmentId);
    expect(html).not.toContain("rpt/");
    expect(html).not.toContain("att/");
  });

  it("保養／折舊：同一防線", () => {
    const mntImg = makeImage("mntSECRET", "data:image/png;base64,ABC", {
      originalFilename: "receipt.jpg",
    });
    const depImg = makeImage("depSECRET", "data:image/png;base64,ABC", {
      originalFilename: "vehicle.jpg",
    });
    const mntHtml = renderReportHtml(maintenanceData({ maintenance: { attachments: [mntImg] } }));
    const depHtml = renderReportHtml(depreciationData({ depreciation: { attachments: [depImg] } }));
    for (const html of [mntHtml, depHtml]) {
      expect(html).not.toContain("rpt/");
      expect(html).not.toContain("att/");
    }
    expect(mntHtml).not.toContain(mntImg.storageKey);
    expect(mntHtml).not.toContain(mntImg.attachmentId);
    expect(depHtml).not.toContain(depImg.storageKey);
    expect(depHtml).not.toContain(depImg.attachmentId);
  });
});

// ---------------------------------------------------------------------------
// 樣式規則在場（AC-13(a)／AC-14 結構前提、AC-34 樣式前提）
// ---------------------------------------------------------------------------

describe("樣式規則在場（量測面延後至 T14；本檔僅靜態斷言規則存在）", () => {
  const html = renderReportHtml(travelData({}));

  it("AC-13(a) 結構前提：.image-block img 含 max-width: 100%", () => {
    expect(html).toMatch(/\.image-block img\.report-image\s*\{[^}]*max-width:\s*100%/);
  });

  it("AC-14 結構前提：avoid-break class 之 CSS 規則為 break-inside: avoid", () => {
    expect(html).toMatch(/\.avoid-break\s*\{\s*break-inside:\s*avoid;?\s*\}/);
  });

  it("AC-14 結構前提：不可分割區塊（.segment／.image-block／.reconciliation）皆掛 avoid-break class", () => {
    expect(html).toContain('class="segment avoid-break"');
    expect(html).toContain('class="image-block avoid-break"');
    const depHtml = renderReportHtml(depreciationData({}));
    expect(depHtml).toContain('class="reconciliation avoid-break"');
  });

  it("AC-34 樣式前提：.print-hint 於 @media print 區塊內 display: none", () => {
    const printBlock = html.match(/@media print\s*\{([\s\S]*?)\}\s*@page/);
    expect(printBlock).not.toBeNull();
    expect(printBlock?.[1]).toMatch(/\.print-hint\s*\{\s*display:\s*none;?\s*\}/);
  });

  it("AC-34 樣式前提：桌面列印提示逐字在場（螢幕內容）", () => {
    expect(html).toContain("建議以桌面裝置列印");
    expect(html).toContain('class="print-hint"');
  });
});

// ---------------------------------------------------------------------------
// B-09 — 零附件不 crash，顯示「無證明圖片」
// ---------------------------------------------------------------------------

describe("B-09 — 零附件之已完成申請：證明區顯示說明文字而非空白或錯誤", () => {
  it("折舊零附件", () => {
    const html = renderReportHtml(depreciationData({ depreciation: { attachments: [] } }));
    expect(html).toContain("無證明圖片");
  });

  it("保養零附件", () => {
    const html = renderReportHtml(maintenanceData({ maintenance: { attachments: [] } }));
    expect(html).toContain("無證明圖片");
  });

  it("差旅段零附件（B-22：歷史資料理論上不可達，仍需防禦）", () => {
    const html = renderReportHtml(
      travelData({ travel: { segments: [makeSegment({ attachments: [] })] } })
    );
    expect(html).toContain("無截圖");
  });
});

// ---------------------------------------------------------------------------
// MF-1／SF-5 — LEGACY 六欄恆常渲染，值以「—」呈現（AC-17(a)(b) 逐字；B-19
// :352／B-20 :353／§8.4 :560；即審裁定：整列省略為 Spec 誤讀，正解為「—」
// 呈現，省略會使 LEGACY 折舊／差旅違反 AC-11 逐字必含）。測試名據實反映本檔
// 之正向斷言（取代原「不出現」之反向斷言——原測試鎖住的是誤讀後之錯誤行
// 為）。AC-17 資料側之完整覆蓋仍屬 T4 `phase8-report-data.test.ts`；本檔僅
// 驗證版型層之呈現正確。
// ---------------------------------------------------------------------------

describe("MF-1 — LEGACY 六欄（差旅新三欄／折舊 CURRENT 專屬三欄）恆常渲染，值以「—」呈現", () => {
  it("差旅 LEGACY：油種／每公升油價／車輛油耗三欄標籤恆在場，值恰為「—」（非省略、非 null／NaN／undefined）", () => {
    const html = renderReportHtml(
      travelData({
        travel: {
          model: "LEGACY",
          fuelType: null,
          fuelPricePerLiter: null,
          fuelConsumption: null,
        },
      })
    );
    // 正向：三標籤在場（AC-11 逐字必含，不因 LEGACY 而省略）
    expect(html).toContain("油種");
    expect(html).toContain("每公升油價");
    expect(html).toContain("車輛油耗");
    // 正向：三欄之 field-value 恰為「—」（逐字比對整個 field 區塊——防
    // `dash()` 被替換為 `String()` 之 mutant：`String(null)` 會產生 "null"
    // 而非 "—"，逐字比對可鑑別）。
    expect(html).toContain(
      '<span class="field-label">油種</span><span class="field-value">—</span>'
    );
    expect(html).toContain(
      '<span class="field-label">每公升油價</span><span class="field-value">—</span>'
    );
    expect(html).toContain(
      '<span class="field-label">車輛油耗</span><span class="field-value">—</span>'
    );
    expect(html).not.toContain(">null<");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });

  it("折舊 LEGACY：每年折舊費用／年度總里程／公務比例三欄標籤恆在場，值恰為「—」（AC-17(b) 同一紀律）", () => {
    const html = renderReportHtml(
      depreciationData({
        depreciation: {
          model: "LEGACY",
          annualDepreciation: null,
          annualTotalKm: null,
          ratioPercent: null,
          perKmUnitPrice: "5.4321",
        },
      })
    );
    expect(html).not.toContain(">null<");
    expect(html).not.toContain("NaN");
    expect(html).toContain("折舊每公里單價");
    expect(html).toContain("5.4321");
    // 正向：CURRENT 專屬三欄標籤恆在場（不因 LEGACY 而省略）
    expect(html).toContain("每年折舊費用");
    expect(html).toContain("年度總里程");
    expect(html).toContain("公務比例");
    // 正向：三欄之 field-value 恰為「—」（同上 dash()→String() mutant 守門）
    expect(html).toContain(
      '<span class="field-label">每年折舊費用</span><span class="field-value">—</span>'
    );
    expect(html).toContain(
      '<span class="field-label">年度總里程</span><span class="field-value">—</span>'
    );
    expect(html).toContain(
      '<span class="field-label">公務比例</span><span class="field-value">—</span>'
    );
    // CURRENT 專屬對帳列不應出現（LEGACY 無三來源值可用）
    expect(html).not.toContain("計算依據");
    // 兩模型共有欄位仍在場
    expect(html).toContain("年度公務里程");
    expect(html).toContain("補貼金額");
  });
});

// ---------------------------------------------------------------------------
// MF-2②／SF-4 — report-html.ts 結構性掃描（AC-17(c) 版型檔零算術；§7.4 純
// 函式零時鐘零隨機——鑑別 M14 之「時鐘繞過」mutant）
// ---------------------------------------------------------------------------

/**
 * 沿用 `phase8-report-data.test.ts`（T4）之 `blankCommentsAndStrings` 手法
 * ——逐字元掃描原始碼，將註解與字串／模板字面值內容替換為空白（僅保留程式
 * 碼結構本身），避免檔案自身 JSDoc 註解中出現的說明性文字（例如本檔
 * `report-html.ts` 檔頭之 AC-16(a) 段落逐字寫出 `` `Date.now()` ``／
 * `` `new Date()` `` 作為「不得呼叫」之說明）造成掃描假陽性。
 *
 * 未直接 `import` `phase8-report-data.test.ts` 之 `blankCommentsAndStrings`
 * ——本專案 `vitest.config.ts` 未設定 `test.isolate: false`（維持 Vitest
 * 預設 `isolate: true`）：每個測試檔各自取得全新模組登錄表，`import` 另一個
 * `*.test.ts` 檔會使其模組頂層程式碼（含全部 `describe`／`it`）在**本檔**
 * 的模組登錄表內重新執行一次——`phase8-report-data.test.ts` 之
 * `describeWithDb` 依真實 `DATABASE_URL` 決定是否為 `describe.skip`，而本
 * 專案 `test/setup/setup-file.ts` 會在測試檔模組 import **之前**改寫
 * `process.env.DATABASE_URL` 指向真實已供裝之 worker schema（見該檔檔頭說
 * 明），故該掛檔案之整個 T4 DB 整合套件會被巢狀掛進本檔執行一次——這既與本
 * 檔 docblock 明文宣告之「zero DB、zero IO」矛盾，也會使「全套」測試計數失
 * 真（重複計入）。Packet 之「或抽共用」路徑因 Files Allowed 未涵蓋新增檔案
 * 而不可行，故採本地複本作為此技術限制下的務實解法，已於 Task Handoff 向
 * 複審揭露。
 *
 * 與來源版本之**唯一**差異（非逐字複本，故據實揭露）：新增正則字面值辨識
 * （`REGEX_CANNOT_PRECEDE` 與對應分支）。本檔 `escapeHtml()` 內含
 * `.replace(/"/g, ...)`／`.replace(/'/g, ...)` 等正則字面值，其內部之
 * `"`／`'` 字元會被原版（僅辨識字串／模板字面值、不辨識正則字面值）之樸素
 * 逐字元掃描誤判為字串起點，導致自該點起、直到檔案結尾之大量真實程式碼被
 * 誤判為「字串內容」而整段清空——**此時掃描結果雖仍不含 `Date.now(` 等目標
 * 子字串，但那是因為整段程式碼被誤清空、不是因為原始碼真的乾淨**，等同不
 * 具鑑別力的偽陽性安全感（已用暫改 `report-html.ts` 加入
 * `const _now = Date.now();` 之獨立實驗證實：原版對此檔案會誤判整段清空、
 * 完全偵測不到新增的 `Date.now(`；修法後之版本能正確偵測，見 Task
 * Handoff）。修法為標準「正則字面值 vs 除法運算子」消歧法：`/` 前一個非空白
 * 實際程式字元若為英數字／`)`／`]`／`_`／`$`／引號，判定為除法（跳過）；否
 * 則判定為正則字面值起點，比照字串處理（掃到下一個未跳脫 `/` 為止，並吞掉
 * 其後之旗標字母）。
 */
const REGEX_CANNOT_PRECEDE = /[A-Za-z0-9_$)\]"'`]/;

function blankCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let lastCode = "";
  const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += blank(src[i]);
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "/" && !REGEX_CANNOT_PRECEDE.test(lastCode)) {
      out += " ";
      i++;
      while (i < n && src[i] !== "/" && src[i] !== "\n") {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += blank(src[i]);
        i++;
      }
      out += " ";
      i++;
      while (i < n && /[a-z]/i.test(src[i])) {
        out += " ";
        i++;
      }
      lastCode = "/";
      continue;
    }
    if (c === "`") {
      out += " ";
      i++;
      while (i < n && src[i] !== "`") {
        out += blank(src[i]);
        i++;
      }
      out += " ";
      i++;
      lastCode = "`";
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out += " ";
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += blank(src[i]);
        i++;
      }
      out += " ";
      i++;
      lastCode = quote;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastCode = c;
    i++;
  }
  return out;
}

const REPORT_HTML_SRC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/reports/report-html.ts"
);

describe("MF-2②／SF-4 — report-html.ts 結構性掃描", () => {
  const src = blankCommentsAndStrings(fs.readFileSync(REPORT_HTML_SRC_PATH, "utf8"));

  it("AC-17(c)：零 .times(/.div(/.plus(/.minus(（版型檔零算術）", () => {
    expect(src).not.toMatch(/\.times\(/);
    expect(src).not.toMatch(/\.div\(/);
    expect(src).not.toMatch(/\.plus\(/);
    expect(src).not.toMatch(/\.minus\(/);
  });

  it("SF-4／§7.4：零 Date.now(/new Date(/Math.random(（純函式零時鐘零隨機；鑑別 M14）", () => {
    expect(src).not.toMatch(/Date\.now\(/);
    expect(src).not.toMatch(/new Date\(/);
    expect(src).not.toMatch(/Math\.random\(/);
  });
});

// ---------------------------------------------------------------------------
// ApplicationType 型別覆蓋自證（避免測試檔本身之 fixture 型別漂移，非 AC 直接
// 對應，純粹確保 fixture 建構器與 @prisma/client 之 ApplicationType 同步）
// ---------------------------------------------------------------------------

describe("fixture 型別自證", () => {
  it("三型 kind 值恰為 ApplicationType 之三個成員", () => {
    const kinds: ApplicationType[] = ["TRAVEL", "MAINTENANCE", "DEPRECIATION"];
    expect(kinds).toEqual(["TRAVEL", "MAINTENANCE", "DEPRECIATION"]);
  });
});
