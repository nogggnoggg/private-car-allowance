/**
 * 列印版 HTML 版型純函式 — PHASE-008-T5（FE-US-23）
 *
 * Pure function: no DB, no IO, no side effects, no random, **no clock read**
 * （`generatedAt` 一律由 `ReportData.common.generatedAt` 傳入，不呼叫
 * `Date.now()`／`new Date()` 取得目前時間）。同一輸入兩次呼叫之結果
 * `toEqual`（AC-15 純函式側）。
 * Spec `docs/specs/PHASE-008.md` §2.D AC-11／AC-12／AC-15（純函式側）／
 * AC-16(a)(b)、§7.4（同一版型契約）、§16 D8（後端產生列印版 HTML，
 * `setContent` 零網路零認證）、D16（圖片以 `data:` URI 嵌入）。
 *
 * ---------------------------------------------------------------------------
 * AC-16 自足文件與跳脫（安全，本檔核心義務）
 * ---------------------------------------------------------------------------
 * (a) 零 `<script`、零 `on*=` 事件屬性、零外部資源參照（無 `<link>`、無
 *     `http://`／`https://`／`//` 開頭之 `src`／`href`／`url()`）；所有圖片
 *     皆為 `data:` URI（由呼叫端 `ReportImage.dataUri` 提供，本檔不讀
 *     `storageKey`）；零 `@import`、零外部字型參照（CJK 字型由容器安裝，
 *     T7b；本檔僅使用 `font-family` 通用字型堆疊，不引用任何 `@font-face`
 *     或外部 URL）。
 * (b) **所有**來自資料之插值一律經**單一** {@link escapeHtml} 處理。實際插值
 *     呼叫點（PHASE-008-T5R SF-3 更正——原註解「僅兩個插值輸出點」為誤述，
 *     下列為本檔真實 7 處）：
 *     1. `field()` `rawValue`（開放值——申請人姓名、出差目的、出發地、到達
 *        地等 AC-16(b) 之 4/5 payload 標靶皆經此路徑，移除即可鑑別）。
 *     2. `renderImage()` `img.originalFilename`（圖說；開放值，AC-16(b) 第
 *        5 個 payload 標靶）。
 *     3. `renderImage()` `dataUri`（`<img src>` 屬性上下文；開放值——T5R
 *        SF-3 新增屬性逃逸 payload 測試專門鑑別此點，移除即可紅）。
 *     4. `common.typeLabel`（`<h1>`／`<title>` 共用同一值，計一點；閉集，僅
 *        「差旅」／「保養」／「折舊」三個字面值，移除**無**鑑別力）。
 *     5. 折舊對帳列（`annualDepreciation`／`officialKm`／`annualTotalKm`／
 *        `totalAmount` 四次呼叫共組單一算式輸出，計一點；閉集——皆為定精度
 *        數字字面字串，非任意字串，移除亦**無**鑑別力，惟 T5R MF-2 已補結
 *        構性掃描與清空／真算術 mutant 測試守住此列存在與內容）。
 *     6. 差旅對帳列（`preRoundingTotal`／`totalAmount`，T5R SF-2 新增；閉
 *        集，理由同上）。
 *     7. `titleSuffix` 之 `common.reportNumber`（`<title>`；開放值——伺服器
 *        產生但非固定字面集合，移除有鑑別力）。
 *     `PRINT_HINT_TEXT`（`.print-hint`）不計入——其為硬編碼 UI 常數，非
 *     `ReportData` 之資料插值。
 *
 * ---------------------------------------------------------------------------
 * FW-1（T4 移交，本檔延續）：輸出零 storageKey／attachmentId 值、零 `rpt/`／
 * `att/` 字樣
 * ---------------------------------------------------------------------------
 * `ReportImage.storageKey`／`attachmentId` 兩欄本檔**一律不讀取**（僅讀
 * `dataUri`／`missing`／`mimeType`(未使用)／`originalFilename`），故輸出
 * HTML 結構性地不含這兩個內部識別值。
 *
 * ---------------------------------------------------------------------------
 * FW-6（期中複審 AR-2 移交；【修訂（PHASE-008-MOCK-R1；Mock Gate 裁-1）】限縮範圍）
 * ---------------------------------------------------------------------------
 * `ReportData` 內之日期／時間欄位（`tripDate`／`createdAt`／`generatedAt`／
 * 各保養日期等）在 `report-data.ts`（T4）已組裝為定格式字串（`YYYY-MM-DD`
 * 或 ISO8601），本檔原則上**原樣呈現、零重新解析**——**僅**共通區塊之
 * `common.generatedAt`／`common.createdAt` 兩欄依 Mock Gate 裁-1 經
 * {@link formatTaipeiDateTime}（`report-labels.ts`，唯一格式化來源）轉為
 * 台北時區中文在地化字串；**其餘全部日期／時間欄位**（`tripDate`、各保養日
 * 期等）**零重新格式化**之紀律不變，不新增第二個格式化函式。
 *
 * ---------------------------------------------------------------------------
 * T2 FW-4（不重算／不重組報表編號）
 * ---------------------------------------------------------------------------
 * `common.reportNumber` 為呼叫端已產生之字串，本檔僅原樣渲染，不做任何組
 * 裝、驗證或重算。
 *
 * ---------------------------------------------------------------------------
 * AC-12 段序與段—圖對應
 * ---------------------------------------------------------------------------
 * 差旅行程段以 `sortOrder` **升冪**排序後渲染（`[...segments].sort(...)`，
 * 不假設輸入已排序）；每段之證明截圖**恰為** `segment.attachments`（T4 已
 * 依 `refId` 分組，本檔僅原樣渲染該陣列，不跨段混用）。
 *
 * ---------------------------------------------------------------------------
 * AC-13(a)／AC-14 結構前提（量測面延後至 T14）
 * ---------------------------------------------------------------------------
 * `.image-block img` 樣式含 `max-width: 100%`；每個不可分割區塊（行程段卡
 * 片 `.segment`、單張圖片容器 `.image-block`、折舊對帳列
 * `.reconciliation`）皆加 `avoid-break` class，對應 CSS 規則
 * `break-inside: avoid`。本檔僅保證**規則在場**，實際列印媒體下之量測（頁
 * 索引、矩形不重疊）為 T14（`e2e/report-print-layout.spec.ts`）之範圍。
 *
 * ---------------------------------------------------------------------------
 * 桌面列印提示（FE-US-27④／AC-34 樣式前提）
 * ---------------------------------------------------------------------------
 * 文件含 `.print-hint` 提示元素（螢幕顯示），並以 `@media print { .print-hint
 * { display: none; } }` 於列印媒體隱藏。實際可視性驗證（375px 螢幕可讀、
 * 列印媒體與 PDF 文字擷取皆不出現）為 T14／T15 之範圍，本檔僅提供規則。
 */

import type {
  DepreciationReportBody,
  MaintenanceReportBody,
  ReportCommon,
  ReportData,
  ReportImage,
  TravelReportBody,
  TravelSegmentReport,
} from "./report-data.js";
import { formatTaipeiDateTime, getFuelTypeLabel } from "./report-labels.js";

// ---------------------------------------------------------------------------
// AC-16(b)：唯一跳脫函式（先跳脫 `&`，避免破壞後續跳脫實體）
// ---------------------------------------------------------------------------

/** 所有來自 `ReportData` 之插值皆須經此函式，無第二個跳脫實作。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** LEGACY／缺值欄位之呈現：`null` → 「—」，避免顯示 `null`／`NaN`／空白亂碼。 */
function dash(value: string | null): string {
  return value === null ? "—" : value;
}

/** 通用「標籤 ＋ 值」列；`rawValue` 一律經 {@link escapeHtml}（唯一插值出口之一）。 */
function field(label: string, rawValue: string): string {
  return `<div class="field"><span class="field-label">${label}</span><span class="field-value">${escapeHtml(
    rawValue
  )}</span></div>`;
}

// ---------------------------------------------------------------------------
// 證明圖片（AC-13(a) 結構前提；FW-1：零 storageKey／attachmentId）
// ---------------------------------------------------------------------------

/** 單張圖片：`missing` 或 `dataUri` 缺值 → 佔位說明（B-10），不中止整份報表。 */
function renderImage(img: ReportImage): string {
  const caption = `<p class="image-caption">${escapeHtml(img.originalFilename)}</p>`;
  const dataUri = img.dataUri;
  if (img.missing || !dataUri) {
    return `<div class="image-block avoid-break"><p class="image-missing">（原始圖片無法讀取，本報表仍照常產生）</p>${caption}</div>`;
  }
  return `<div class="image-block avoid-break"><img class="report-image" src="${escapeHtml(
    dataUri
  )}" alt="附件證明圖片" />${caption}</div>`;
}

/** 圖片清單；空陣列（B-09）以文字說明取代空白。 */
function renderImages(images: ReportImage[], emptyLabel: string): string {
  if (images.length === 0) {
    return `<p class="image-empty">${emptyLabel}</p>`;
  }
  return images.map(renderImage).join("\n");
}

// ---------------------------------------------------------------------------
// 共通區塊（AC-11 修訂後：共通 7 個欄位列 ＋ 1 個類型大標題〔裁-2〕）
// ---------------------------------------------------------------------------

function renderCommonHeader(common: ReportCommon): string {
  return `<header class="report-header">
<h1>${escapeHtml(common.typeLabel)}報表</h1>
${field("報表編號", common.reportNumber ?? "尚未產生")}
${field("產生時間", common.generatedAt ? formatTaipeiDateTime(common.generatedAt) : "尚未產生")}
${field("申請人姓名", common.ownerDisplayName)}
${field("申請類型", common.typeLabel)}
${field("申請狀態", common.statusLabel)}
${field("申請建立時間", formatTaipeiDateTime(common.createdAt))}
${field("最終金額（新臺幣整數）", String(common.totalAmount))}
</header>`;
}

// ---------------------------------------------------------------------------
// 差旅（AC-11／AC-12）
// ---------------------------------------------------------------------------

function renderSegmentField(segment: TravelSegmentReport): string {
  return `<div class="segment avoid-break">
${field("序號", String(segment.sortOrder))}
${field("出發地", segment.origin ?? "—")}
${field("到達地", segment.destination ?? "—")}
${field("總里程", segment.totalKm)}
${field("高速里程", segment.highwayKm)}
${field("段金額", String(segment.segmentAmount))}
</div>`;
}

function renderSegmentImages(segment: TravelSegmentReport): string {
  return `<div class="segment-images">
${field("序號", String(segment.sortOrder))}
${renderImages(segment.attachments, "無截圖")}
</div>`;
}

function renderTravelBody(body: TravelReportBody, totalAmount: number): string {
  // AC-12：升冪排序，不假設輸入已排序。
  const orderedSegments = [...body.segments].sort((a, b) => a.sortOrder - b.sortOrder);
  // MF-1（Spec AC-17(a)／B-19 :352／§8.4 :560）：LEGACY 列亦恆常渲染新三欄，
  // 值以「—」呈現（`dash()`），而非整列省略——省略會使 LEGACY 差旅違反
  // AC-11 逐字必含（該三欄本就是「差旅」必含項目清單的一部分，不因模型而
  // 消失）。
  // 裁-3：油種以中文名稱呈現（`FuelType` 列舉代碼不得外流）；LEGACY 之「—」
  // 呈現優先於翻譯（`dash()` 語意不變，`null` 恆不進入 `getFuelTypeLabel`）。
  const currentFields = `${field("油種", body.fuelType === null ? "—" : getFuelTypeLabel(body.fuelType))}
${field("每公升油價", dash(body.fuelPricePerLiter))}
${field("車輛油耗", dash(body.fuelConsumption))}`;
  // SF-2（AC-11「取整前總額之對帳列」；比照下方折舊 `.reconciliation
  // avoid-break` 區塊同一結構）：純字串串接（零算術）呈現取整前總額→最終
  // 金額，取代先前降級為普通欄位的呈現。
  const reconciliation = `<div class="reconciliation avoid-break">
<span class="field-label">計算依據</span>
<span class="field-value">取整前總額 ${escapeHtml(body.preRoundingTotal)} → 四捨五入 → 最終金額 ${escapeHtml(
    String(totalAmount)
  )}</span>
</div>`;

  return `<section class="section travel-section">
${field("出差日期", body.tripDate ?? "—")}
${field("出差目的", body.purpose ?? "—")}
<h2>各段</h2>
${orderedSegments.map(renderSegmentField).join("\n")}
${field("總里程", body.totalKm)}
${field("油資每公里單價", body.fuelUnitPrice)}
${field("ETC 每公里單價", body.etcUnitPrice)}
${currentFields}
${reconciliation}
<h2>各段證明截圖</h2>
${orderedSegments.map(renderSegmentImages).join("\n")}
</section>`;
}

// ---------------------------------------------------------------------------
// 保養（AC-11／AC-19）
// ---------------------------------------------------------------------------

function renderMaintenanceBody(body: MaintenanceReportBody): string {
  return `<section class="section maintenance-section">
${field("上次保養日期", body.lastMaintenanceDate ?? "—")}
${field("本次保養日期", body.currentMaintenanceDate ?? "—")}
${field("上次里程表", body.lastOdometerKm ?? "—")}
${field("本次里程表", body.currentOdometerKm ?? "—")}
${field("保養區間總里程", body.intervalKm)}
${field("期間公務里程", body.officialKm)}
${field("公務使用比例", body.ratioPercent)}
${field("實際費用", body.actualCost)}
${field("公司分攤金額", String(body.companyAmount))}
<h2>證明圖片</h2>
<div class="images">${renderImages(body.attachments, "無證明圖片")}</div>
</section>`;
}

// ---------------------------------------------------------------------------
// 折舊（AC-11／AC-18；LEGACY 雙軌之顯示層防禦——AC-17 資料側已於 T4 覆蓋）
// ---------------------------------------------------------------------------

function renderDepreciationBody(body: DepreciationReportBody, totalAmount: number): string {
  // AC-18(c)：對帳列以三來源值呈現算式，僅 CURRENT 模型有此三值。
  const reconciliation =
    body.model === "CURRENT"
      ? `<div class="reconciliation avoid-break">
<span class="field-label">計算依據</span>
<span class="field-value">${escapeHtml(body.annualDepreciation ?? "—")} × ${escapeHtml(
          body.officialKm
        )} ÷ ${escapeHtml(body.annualTotalKm ?? "—")} = ${escapeHtml(String(totalAmount))}</span>
</div>`
      : "";
  const legacyField =
    body.model === "LEGACY" ? field("折舊每公里單價", dash(body.perKmUnitPrice)) : "";
  // MF-1（Spec AC-17(b)／B-20 :353／§8.4 :560）：LEGACY 列亦恆常渲染 CURRENT
  // 專屬三欄，值以「—」呈現（`dash()`），而非整列省略——與差旅 AC-17(a) 同
  // 一紀律，省略會使 LEGACY 折舊違反 AC-11 逐字必含。移除 `as string` cast
  // （`dash()` 接受 `string | null`，順帶封住 CURRENT 側若異常為 null 時
  // `escapeHtml(null)` 之潛在 500 面）。
  const currentOnlyFields = `${field("每年折舊費用", dash(body.annualDepreciation))}
${field("年度總里程", dash(body.annualTotalKm))}
${field("公務比例", dash(body.ratioPercent))}`;

  return `<section class="section depreciation-section">
${field("申請年度", body.applicationYear !== null ? String(body.applicationYear) : "—")}
${currentOnlyFields}
${field("年度公務里程", body.officialKm)}
${field("補貼金額", String(totalAmount))}
${legacyField}
${reconciliation}
<h2>證明圖片</h2>
<div class="images">${renderImages(body.attachments, "無證明圖片")}</div>
</section>`;
}

// ---------------------------------------------------------------------------
// 樣式（inline `<style>`；AC-16(a) 自足文件、AC-13(a)／AC-14 結構前提、AC-34 提示規則）
// ---------------------------------------------------------------------------

const PRINT_HINT_TEXT = "建議以桌面裝置列印";

const STYLE = `* { box-sizing: border-box; }
body { font-family: "Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif; margin: 24px; color: #111827; line-height: 1.5; }
h1 { font-size: 20px; }
h2 { font-size: 16px; margin-top: 20px; }
.field { display: flex; gap: 8px; margin: 2px 0; }
.field-label { font-weight: 600; min-width: 9em; }
.field-value { white-space: pre-wrap; word-break: break-word; }
.segment { border: 1px solid #d1d5db; border-radius: 4px; padding: 8px 12px; margin: 8px 0; }
.image-block { max-width: 100%; overflow: hidden; margin: 8px 0; }
.image-block img.report-image { max-width: 100%; height: auto; display: block; }
.image-caption { font-size: 12px; color: #4b5563; margin: 4px 0 0; word-break: break-all; }
.avoid-break { break-inside: avoid; }
.reconciliation { margin: 8px 0; }
.print-hint { background: #fef3c7; border: 1px solid #f59e0b; padding: 8px 12px; margin-bottom: 16px; }
@media print {
  .print-hint { display: none; }
}
@page { size: A4; margin: 16mm; }`;

// ---------------------------------------------------------------------------
// 入口（§7.4：與 PDF 同一版型契約——唯一模板、唯一函式）
// ---------------------------------------------------------------------------

/**
 * 三型列印版 HTML 純函式（AC-15：同輸入兩次呼叫結果 `toEqual`）。
 * `GET /report/print` 直接回傳此字串；`POST /report` 之 PDF 產生以
 * `page.setContent(此字串)` 使用**同一函式、同一輸入**（T10 接線）。
 */
export function renderReportHtml(data: ReportData): string {
  const bodyHtml =
    data.kind === "TRAVEL"
      ? renderTravelBody(data.travel, data.common.totalAmount)
      : data.kind === "MAINTENANCE"
        ? renderMaintenanceBody(data.maintenance)
        : renderDepreciationBody(data.depreciation, data.common.totalAmount);

  const titleSuffix = data.common.reportNumber ? ` ${escapeHtml(data.common.reportNumber)}` : "";

  return `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.common.typeLabel)}報表${titleSuffix}</title>
<style>${STYLE}</style>
</head>
<body>
<p class="print-hint">${escapeHtml(PRINT_HINT_TEXT)}</p>
${renderCommonHeader(data.common)}
${bodyHtml}
</body>
</html>`;
}
