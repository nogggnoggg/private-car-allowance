/**
 * E2E: 報表列印版面機械驗證 — PHASE-008-T14（Spec §11.4、§12、§15 T14）
 *
 * AC-13(b)／AC-14／AC-34：
 *   - AC-13(b)：列印媒體模擬下，每張證明圖片之 `getBoundingClientRect().width`
 *     ≤ 內容區寬度，`right` ≤ 內容區右緣 + 1px 容差；文件 `scrollWidth` ≤
 *     頁面內容寬度（無水平溢位）。內容區寬度基準＝178mm（A4 210mm − @page
 *     16mm×2；T7R FW-4 核銷）換算 px（178×96/25.4 ≈ 673px）——實測面採 **DOM
 *     ＋列印媒體模擬**（`emulateMedia({media:"print"})`＋固定 viewport 寬度
 *     ＝內容區寬度），因 `max-width:100%` 是否生效與是否實際分頁無關（純寬度
 *     約束，非分頁行為）。
 *   - AC-14：多頁 fixture（6 段差旅，含一張未降尺寸＋需轉正之超大索引色 PNG）
 *     下，每個 `.avoid-break` 區塊之內容不得被頁面邊界切開。
 *   - AC-34：列印版含桌面列印提示（螢幕可見）；`@media print` 下隱藏；PDF
 *     文字擷取亦不含該提示文字。
 *
 * ---------------------------------------------------------------------------
 * 方法論澄清（T14 實測結論；記錄供後續維護者與 reviewer 核對）
 * ---------------------------------------------------------------------------
 * Spec §11.4「版面驗證之方法論說明」原假設「DOM ＋ 列印媒體模擬」對 AC-14
 * （多頁不重疊、`break-inside: avoid` 之 mutant 必紅）亦可行，理由是「這正是
 * 產生 PDF 的同一個排版引擎（Chromium）」。**實測結果此假設對 AC-14 不成
 * 立**：`page.emulateMedia({media:"print"})` 於一般（未進入真實列印管線的）
 * Playwright 分頁上，**不會**觸發 Blink 的分頁／分片（fragmentation）排版
 * ——`@page` 僅在真實列印管線（`page.pdf()`／實際列印）才生效；一般分頁上
 * `getBoundingClientRect()` 的結果在有無 `break-inside: avoid` 兩種情況下
 * **逐位元組相同**（已以獨立探針腳本驗證：同一 fixture 移除
 * `break-inside: avoid` 前後，8 個區塊之 top/bottom 完全不變）。故 AC-14
 * 不可能以「DOM 連續流佈局 ＋ `floor(y/頁面內容高度)` 桶分」量測出對
 * `break-inside: avoid` 的鑑別力。
 *
 * 本檔對 AC-14 改採**真實 PDF 分頁**（後端實際產生之正式 PDF，`page.pdf()`
 * 之真實列印管線，`preferCSSPageSize: true` 已忠實套用 `@page` 尺寸與邊
 * 距——見 `pdf-renderer.ts`）＋**零新依賴**之輕量 PDF 內容流幾何擷取（僅用
 * Node 內建 `zlib`，解壓 `FlateDecode` 內容流；解析路徑建構運算子
 * `m`/`l`/`c`／圖形狀態運算子 `cm`/`q`/`Q`／繪製運算子 `S`/`Do` 等，追蹔
 * CTM 矩陣堆疊，將路徑點與影像 XObject 之置放矩形換算為頁面座標）。
 *
 * ---------------------------------------------------------------------------
 * T14b 修訂（大總管裁定，PROJECT_STATE `64314f0`）：字型無關之幾何訊號
 * ---------------------------------------------------------------------------
 * T14 初版曾嘗試以「fixture 自訂之唯一文字值」為錨點、透過 `ToUnicode` CMap
 * 還原逐頁文字來判定頁索引——**實測失敗**：本機（Windows，`Noto Sans TC`
 * 缺裝，經 `font-family` 回退鏈）下 Chromium/Skia 對此文件內嵌**大量細碎的
 * 字型子集**（單頁 70+ 個），其 `ToUnicode` CMap 對部分字元（含一次性自訂
 * 錨點文字）之覆蓋不完整（物件級 dump 逐一驗證：`SEGORIGIN1` 之 `S` 字元
 * glyph code 於對應字型之 CMap 內完全無條目），造成錨點比對不可靠，且無法
 * 排除與正式容器（已裝字型）之字型內嵌管線不同構。
 *
 * 【PHASE-009-T18／AC-40(a) 更正（記載型，零斷言變更）】上段原記「Chromium
 * /Skia 對此文件改採逐字元 `/Subtype /Type3` 字型內嵌」——**該技術敘述失
 * 準**。PHASE-008 **T8R2 SF-7** 之實測結論為：文字係以**子集字型**繪製，內
 * 容流中為正常之 `Tj`／`TJ` 文字運算子並帶 `ToUnicode` CMap，**非** `Type3`
 * 之向量化描繪——亦即**文字原則上可還原**，只是本機回退鏈下之子集 CMap 覆
 * 蓋不完整使**逐字錨點**不可靠。此區別對後續 Phase 有實質後果（若誤信
 * 「已向量化」，會錯誤地認定 PDF 文字層不存在而放棄一切文字面斷言），故逐
 * 字更正。**本更正不改變**上述「改採字型無關之幾何訊號」之裁定與理由——不
 * 可靠的是**逐字元錨點**，與是否 `Type3` 無關；本檔之量測方法、斷言與期望
 * 值一律零變更。
 *
 * T14b 改採**兩類字型完全無關之幾何訊號**（大總管裁定；不改 AC-14 語意、
 * 零新依賴、字型無關使前述環境分歧疑慮就地中和——幾何運算子〔路徑座標／
 * CTM／XObject 置放〕在任何字型下皆逐位元組相同）：
 *
 *   1. **`.segment` 邊框路徑**（`report-html.ts` :295 `border: 1px solid
 *      #d1d5db`）——PDF 內容流中為一段「`m` 起筆 → 4 組 `l`+`c`（含
 *      border-radius 之貝茲角）→ 回到起點」之單一封閉子路徑，以
 *      `S`（stroke）繪製、顏色即該邊框灰階值（`RG 0.8196 0.8353 0.8588`）。
 *      每個 `.segment` 對應**恰一個**此類子路徑；若 `break-inside: avoid`
 *      失效致區塊被頁面邊界切開，該子路徑之起訖點不再重合（不再是封閉迴
 *      圈），或整體不再以單一子路徑之姿態存在——故「全文件封閉子路徑總數
 *      是否恆等於段落數」即為 mutant 鑑別訊號（已實測驗證：正常渲染下每
 *      個候選子路徑之起訖點座標逐一致、點數量固定）。
 *   2. **`.image-block` 之 `Do` 影像置放**——`/Xn Do` 前之 `cm` 直接給出該
 *      影像於頁面座標之精確置放矩形（`a`/`d` 為寬高縮放、`e`/`f` 為原
 *      點），與字型完全無涉。
 *
 * 以此重建每頁 `.segment`／`.image-block` 之矩形清單，斷言：①全文件封閉
 * 子路徑總數與段落數相符（頁索引一致性之直接證據——不完整或分裂之子路徑
 * 不計入，故總數短少即代表切割發生）；②同頁內任兩矩形（含影像）不重疊。
 * `.reconciliation` 無邊框亦無影像，本技術**無法**直接量測其頁索引——已
 * 記入 Handoff 之範圍限制（該區塊為單行小區塊，於 fixture 中緊跟於一般欄
 * 位之後，非本測試之量測對象；FE-US-23④ 之核心風險——多欄位/多圖區塊之
 * 切割——已由 `.segment`／`.image-block` 兩類完整覆蓋）。
 *
 * 此為**測試策略之延續裁量**（沿用 Spec §11.4 註記「測試策略裁量（spec-
 * writer 可自主範圍）」之同一授權層級，經大總管 T14b 裁定——本檔僅改變
 * 「如何在 PDF 中取證」的技術手段，未變更 AC-14 之驗收語意、未放寬任何斷
 * 言、未新增 npm 依賴、未修改 Spec）。AC-13(b) 因其本質是「單一元素寬度是
 * 否超出容器」（與是否真正分頁無關），維持 Spec 原述之 DOM＋列印媒體模擬
 * 量測，不受本澄清影響。
 *
 * AC-34 之「PDF 文字擷取」層仍沿用零依賴之 `ToUnicode` 文字擷取工具（僅需
 * 判定提示文字**不存在**——遺漏解碼只會讓已渲染文字被誤判為不存在，不會
 * 把未渲染文字誤判為存在，故該字型限制不影響此層斷言之正確方向，見下方
 * `extractPdfTextPerPage`）。
 *
 * ---------------------------------------------------------------------------
 * Mutant 自證（未進入本檔——依 Packet「暫改 report-html.ts→紅→還原
 * byte-identical 證明」之既定 TDD 手法，於 implementer 開發階段以 Edit ＋
 * 重跑本檔＋還原完成，實際輸出見 Task Handoff，不寫入自我變異之程式碼於
 * 本檔——避免測試於一般執行時就地竄改原始碼之脆弱性與風險）
 * ---------------------------------------------------------------------------
 *
 * Boundary fixtures 涵蓋：
 *   - B-11（保養 5 張證明，上限）：AC-13(b) 內以獨立 `test.step` 涵蓋。
 *   - B-23（差旅 500 字出差目的 ＋ 長地名 200 字）：併入 AC-14 之 6 段差旅
 *     fixture（其中一段之出發地即為 200 字長地名，`purpose` 為 500 字）。
 *   - FW-2（未降尺寸＋需轉正之大圖，索引色 PNG＋EXIF orientation 6）：併入
 *     同一 6 段差旅 fixture 之其中一段證明圖片。
 *
 * Topology / Test account：大總管已啟動之 dev 拓撲（backend :3000、
 * Vite :5173、`t1-pg`）；管理員帳號沿用既有 E2E 慣例（e2eadmin）；合成使
 * 用者以 `e2e-print-<random>` 命名。E2E 播種順序鐵律（PHASE-007 T16
 * FW-④）：本檔以 API 直接播種（沿 `maintenance-allowance.spec.ts`／
 * `depreciation-allowance.spec.ts` 既有慣例），不經 UI 表單。
 */

import { inflateSync } from "node:zlib";
import { type Page, expect, test } from "@playwright/test";

const E2E_ADMIN = { loginName: "e2eadmin", password: "E2eAdmin@456!" };
const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";

// ---------------------------------------------------------------------------
// FW-1：內容區寬度基準＝178mm（210mm − 16mm×2）換算 px（96dpi：1mm = 96/25.4px）
// ---------------------------------------------------------------------------
const CONTENT_WIDTH_PX = Math.round((178 * 96) / 25.4); // 673

// ---------------------------------------------------------------------------
// 日期（動態相對日期，避免寫死日曆日期隨系統時間推移而失效）
// ---------------------------------------------------------------------------
function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
const TRIP_DATE = isoDateDaysAgo(30);
const MAINT_LAST_DATE = isoDateDaysAgo(40);
const MAINT_CURRENT_DATE = isoDateDaysAgo(0);
const PARAM_EFFECTIVE_FROM = "2020-06-01";
const FUEL_TYPE = "GASOLINE_92";
const FUEL_KM_PER_LITER = "10.0000";
const FUEL_PRICE_PER_LITER = "65.0000";
const ETC_UNIT_PRICE = 1.8;
const FUEL_BASIS_NOTE = "PHASE-008-T14 E2E 合成資料（列印版面 Gate E2E 播種用）";

// ---------------------------------------------------------------------------
// 6 段差旅 fixture 之逐段錨點值（AC-14 起訖點；B-23 長地名併入第 3 段）
// ---------------------------------------------------------------------------
const LONG_ORIGIN_PREFIX = "SEGORIGIN3LONG";
const LONG_ORIGIN = `${LONG_ORIGIN_PREFIX}${"甲".repeat(200 - LONG_ORIGIN_PREFIX.length)}`;
const LONG_PURPOSE = "本次出差目的說明文字".repeat(50).slice(0, 500); // 500 字（B-23）

interface SegmentPlan {
  origin: string;
  destination: string;
  totalKm: string;
  highwayKm: string; // 唯一值，作為該段之終點錨點
}

const SEGMENT_PLANS: SegmentPlan[] = [
  { origin: "SEGORIGIN1", destination: "終點1", totalKm: "61.11", highwayKm: "11.11" },
  { origin: "SEGORIGIN2", destination: "終點2", totalKm: "72.22", highwayKm: "22.22" },
  { origin: LONG_ORIGIN, destination: "終點3", totalKm: "83.33", highwayKm: "33.33" },
  { origin: "SEGORIGIN4", destination: "終點4", totalKm: "94.44", highwayKm: "44.44" }, // 大圖段
  { origin: "SEGORIGIN5", destination: "終點5", totalKm: "105.55", highwayKm: "55.55" },
  { origin: "SEGORIGIN6", destination: "終點6", totalKm: "116.66", highwayKm: "66.66" },
];
const BIG_IMAGE_SEGMENT_INDEX = 3; // SEGORIGIN4（0-based）：FW-2 大圖段

// ---------------------------------------------------------------------------
// 桌面列印提示（逐字沿用 report-html.ts PRINT_HINT_TEXT 之值；AC-34）
// ---------------------------------------------------------------------------
const PRINT_HINT_TEXT = "建議以桌面裝置列印";

// ---------------------------------------------------------------------------
// Auth / 播種 helpers（沿 maintenance-allowance.spec.ts／depreciation-
// allowance.spec.ts 既有慣例：API 直接播種、先查後建全域參數）
// ---------------------------------------------------------------------------

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.waitForURL(`${BASE}/login`);
  await page.fill("#loginName", E2E_ADMIN.loginName);
  await page.fill("#password", E2E_ADMIN.password);
  await page.click('button:has-text("登入")');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
}

async function createSyntheticUser(
  page: Page,
  tempPassword: string
): Promise<{ id: string; loginName: string }> {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const loginName = `e2e-print-${suffix}`;
  const displayName = `T14列印使用者${suffix}`;
  const res = await page.request.post(`${API_BASE}/admin/users`, {
    data: { loginName, displayName, temporaryPassword: tempPassword },
  });
  if (!res.ok()) throw new Error(`E2E 建立合成使用者失敗: ${res.status()} ${await res.text()}`);
  const { user } = (await res.json()) as { user: { id: string } };
  return { id: user.id, loginName };
}

async function ensureFuelPriceCovers(page: Page, fuelType: string, dateStr: string): Promise<void> {
  const res = await page.request.get(`${API_BASE}/parameters/fuel-price?fuelType=${fuelType}`);
  if (!res.ok()) throw new Error(`E2E 讀取油價版本失敗: ${res.status()} ${await res.text()}`);
  const { versions } = (await res.json()) as { versions: { effectiveFrom: string }[] };
  if (versions.some((v) => v.effectiveFrom <= dateStr)) return;
  const createRes = await page.request.post(`${API_BASE}/parameters/fuel-price`, {
    data: { fuelType, pricePerLiter: FUEL_PRICE_PER_LITER, effectiveFrom: PARAM_EFFECTIVE_FROM },
  });
  if (!createRes.ok())
    throw new Error(`E2E 設定油價版本失敗: ${createRes.status()} ${await createRes.text()}`);
}

async function ensureEtcCovers(page: Page, dateStr: string): Promise<void> {
  const res = await page.request.get(`${API_BASE}/parameters/etc`);
  if (!res.ok()) throw new Error(`E2E 讀取 ETC 參數失敗: ${res.status()} ${await res.text()}`);
  const { versions } = (await res.json()) as { versions: { effectiveFrom: string }[] };
  if (versions.some((v) => v.effectiveFrom <= dateStr)) return;
  const createRes = await page.request.post(`${API_BASE}/parameters/etc`, {
    data: { unitPrice: ETC_UNIT_PRICE, effectiveFrom: PARAM_EFFECTIVE_FROM },
  });
  if (!createRes.ok())
    throw new Error(`E2E 設定 ETC 參數失敗: ${createRes.status()} ${await createRes.text()}`);
}

async function ensureFuelConsumptionCovers(
  page: Page,
  userId: string,
  dateStr: string
): Promise<void> {
  const res = await page.request.get(`${API_BASE}/users/${userId}/fuel-consumption`);
  if (!res.ok()) throw new Error(`E2E 讀取油耗版本失敗: ${res.status()} ${await res.text()}`);
  const { versions } = (await res.json()) as { versions: { effectiveFrom: string }[] };
  if (versions.some((v) => v.effectiveFrom <= dateStr)) return;
  const createRes = await page.request.post(`${API_BASE}/users/${userId}/fuel-consumption`, {
    data: {
      fuelType: FUEL_TYPE,
      kmPerLiter: FUEL_KM_PER_LITER,
      effectiveFrom: PARAM_EFFECTIVE_FROM,
      basisNote: FUEL_BASIS_NOTE,
    },
  });
  if (!createRes.ok())
    throw new Error(`E2E 設定油耗版本失敗: ${createRes.status()} ${await createRes.text()}`);
}

let staffPasswordAlreadyChanged = false;
const STAFF_TEMP_PASSWORD = "TempPw@2026Print!";
const STAFF_NEW_PASSWORD = "NewPw@2026Print!";

async function loginAsStaff(page: Page, loginName: string): Promise<void> {
  if (staffPasswordAlreadyChanged) {
    const res = await page.request.post(`${API_BASE}/auth/login`, {
      data: { loginName, password: STAFF_NEW_PASSWORD },
    });
    if (!res.ok()) throw new Error(`E2E 合成使用者登入失敗: ${res.status()} ${await res.text()}`);
    return;
  }
  const loginRes = await page.request.post(`${API_BASE}/auth/login`, {
    data: { loginName, password: STAFF_TEMP_PASSWORD },
  });
  if (!loginRes.ok())
    throw new Error(`E2E 合成使用者首次登入失敗: ${loginRes.status()} ${await loginRes.text()}`);
  const changeRes = await page.request.post(`${API_BASE}/me/password`, {
    data: { currentPassword: STAFF_TEMP_PASSWORD, newPassword: STAFF_NEW_PASSWORD },
  });
  if (!changeRes.ok())
    throw new Error(`E2E 合成使用者強制改密失敗: ${changeRes.status()} ${await changeRes.text()}`);
  staffPasswordAlreadyChanged = true;
}

// ---------------------------------------------------------------------------
// 合成圖片產生器（procedural；真實可解碼位元組，供 sharp 實際降尺寸邏輯驗
// 證——沿 phase8-report-images.test.ts 既有手法）
// ---------------------------------------------------------------------------

function makeXorshift32(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
}

function makeNoiseRaw(width: number, height: number, channels: number, seed: number): Buffer {
  const rnd = makeXorshift32(seed);
  const buf = Buffer.alloc(width * height * channels);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(rnd() * 256) & 0xff;
  return buf;
}

async function makeNoiseJpeg(width: number, height: number, seed: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const raw = makeNoiseRaw(width, height, 3, seed);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

function makeGridMapRaw(width: number, height: number, channels: number): Buffer {
  const buf = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * channels;
      const isLine = x % 2 === 0 || y % 2 === 0;
      const v = isLine ? 30 : 235;
      buf[off] = v;
      buf[off + 1] = v;
      buf[off + 2] = v;
    }
  }
  return buf;
}

/**
 * FW-2：未降尺寸＋需轉正之大圖 fixture ── 索引色地圖型 PNG（2400×1800）＋
 * EXIF `orientation` 6。長邊 2400 > `REPORT_IMAGE_MAX_PX`（1600），`resize`
 * 前 `.rotate()` 觸發；索引色 PNG 之重編碼實測膨脹（沿 T6R2 AR-12 先例），
 * 「取小者」閘門改用原圖位元組、像素尺寸保留原始 2400×1800（未降尺寸）——
 * 版面面之溢出防線完全依賴 CSS `max-width:100%`（AC-13(b) 之直接關聯情境）。
 */
async function makeBigOrientedIndexPng(
  width: number,
  height: number,
  orientation: number
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const raw = makeGridMapRaw(width, height, 3);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .withMetadata({ orientation })
    .png({ palette: true })
    .toBuffer();
}

async function uploadAttachment(
  page: Page,
  buffer: Buffer,
  name: string,
  mimeType: string
): Promise<string> {
  const res = await page.request.post(`${API_BASE}/attachments`, {
    multipart: { file: { name, mimeType, buffer } },
  });
  if (!res.ok())
    throw new Error(`E2E 上傳附件失敗（${name}）: ${res.status()} ${await res.text()}`);
  const { attachment } = (await res.json()) as { attachment: { id: string } };
  return attachment.id;
}

/** 播種 6 段差旅（AC-14 多頁 fixture；含 B-23 長地名/長出差目的、FW-2 大圖）並完成。 */
async function seedTravelFixture(page: Page): Promise<string> {
  const createRes = await page.request.post(`${API_BASE}/applications/travel`, { data: {} });
  if (!createRes.ok()) throw new Error(`E2E 播種差旅建立失敗: ${createRes.status()}`);
  const { application } = (await createRes.json()) as { application: { id: string } };
  const tripId = application.id;

  const segments = [];
  for (let i = 0; i < SEGMENT_PLANS.length; i++) {
    const plan = SEGMENT_PLANS[i];
    let attachmentId: string;
    if (i === BIG_IMAGE_SEGMENT_INDEX) {
      const buf = await makeBigOrientedIndexPng(2400, 1800, 6);
      attachmentId = await uploadAttachment(page, buf, `seg${i}-big-oriented.png`, "image/png");
    } else {
      const buf = await makeNoiseJpeg(1000, 700, 0x1000 + i);
      attachmentId = await uploadAttachment(page, buf, `seg${i}-photo.jpg`, "image/jpeg");
    }
    segments.push({
      origin: plan.origin,
      destination: plan.destination,
      totalKm: plan.totalKm,
      highwayKm: plan.highwayKm,
      attachmentIds: [attachmentId],
    });
  }

  const putRes = await page.request.put(`${API_BASE}/applications/travel/${tripId}`, {
    data: { tripDate: TRIP_DATE, purpose: LONG_PURPOSE, segments },
  });
  if (!putRes.ok())
    throw new Error(`E2E 播種差旅段落設定失敗: ${putRes.status()} ${await putRes.text()}`);

  const completeRes = await page.request.post(`${API_BASE}/applications/${tripId}/complete`);
  if (!completeRes.ok())
    throw new Error(`E2E 播種差旅完成失敗: ${completeRes.status()} ${await completeRes.text()}`);

  return tripId;
}

/** 播種保養申請（B-11：5 張證明，上限）並完成。 */
async function seedMaintenanceFixture(page: Page): Promise<string> {
  const createRes = await page.request.post(`${API_BASE}/applications/maintenance`, { data: {} });
  if (!createRes.ok()) throw new Error(`E2E 播種保養建立失敗: ${createRes.status()}`);
  const { application } = (await createRes.json()) as { application: { id: string } };
  const maintId = application.id;

  const attachmentIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const buf = await makeNoiseJpeg(500, 400, 0x2000 + i);
    attachmentIds.push(await uploadAttachment(page, buf, `maint-${i}.jpg`, "image/jpeg"));
  }

  const putRes = await page.request.put(`${API_BASE}/applications/maintenance/${maintId}`, {
    data: {
      lastMaintenanceDate: MAINT_LAST_DATE,
      currentMaintenanceDate: MAINT_CURRENT_DATE,
      lastOdometerKm: "10000.00",
      currentOdometerKm: "11000.00",
      actualCost: "4000.00",
      attachmentIds,
    },
  });
  if (!putRes.ok())
    throw new Error(`E2E 播種保養欄位設定失敗: ${putRes.status()} ${await putRes.text()}`);

  const completeRes = await page.request.post(`${API_BASE}/applications/${maintId}/complete`);
  if (!completeRes.ok())
    throw new Error(`E2E 播種保養完成失敗: ${completeRes.status()} ${await completeRes.text()}`);

  return maintId;
}

/** 產生正式報表（冪等，200/201 皆視為成功）。 */
async function ensureReportGenerated(page: Page, applicationId: string): Promise<void> {
  const res = await page.request.post(`${API_BASE}/applications/${applicationId}/report`);
  if (!res.ok()) throw new Error(`E2E 產生報表失敗: ${res.status()} ${await res.text()}`);
}

async function downloadReportPdf(page: Page, applicationId: string): Promise<Buffer> {
  const res = await page.request.get(`${API_BASE}/applications/${applicationId}/report/pdf`);
  if (!res.ok()) throw new Error(`E2E 下載報表 PDF 失敗: ${res.status()} ${await res.text()}`);
  return await res.body();
}

// ---------------------------------------------------------------------------
// 零新依賴 PDF 文字擷取（僅用 Node 內建 zlib；解壓 FlateDecode 內容流與各字
// 型 ToUnicode CMap，將 Tj/TJ 之十六進位字串還原為 Unicode，按頁分割回傳）
// ---------------------------------------------------------------------------

interface PdfObj {
  dict: string;
  streamRaw: Buffer | null;
}

function splitPdfObjects(pdf: string): Map<number, PdfObj> {
  const objs = new Map<number, PdfObj>();
  const objRe = /(\d+)\s+\d+\s+obj\b/g;
  const positions: { num: number; start: number }[] = [];
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: 標準 regex 迭代慣用寫法
  while ((m = objRe.exec(pdf))) positions.push({ num: Number(m[1]), start: objRe.lastIndex });
  for (const { num, start } of positions) {
    const end = pdf.indexOf("endobj", start);
    if (end === -1) continue;
    const body = pdf.slice(start, end);
    const sIdx = body.indexOf("stream");
    if (sIdx !== -1) {
      let dataStart = sIdx + "stream".length;
      if (body[dataStart] === "\r") dataStart++;
      if (body[dataStart] === "\n") dataStart++;
      const eIdx = body.lastIndexOf("endstream");
      const dict = body.slice(0, sIdx);
      const streamStr = body.slice(dataStart, eIdx).replace(/[\r\n]+$/, "");
      objs.set(num, { dict, streamRaw: Buffer.from(streamStr, "latin1") });
    } else {
      objs.set(num, { dict: body, streamRaw: null });
    }
  }
  return objs;
}

function maybeInflate(dict: string, raw: Buffer): string {
  if (/FlateDecode/.test(dict)) {
    try {
      return inflateSync(raw).toString("latin1");
    } catch {
      return raw.toString("latin1");
    }
  }
  return raw.toString("latin1");
}

function hexToUtf16(hex: string): string {
  let out = "";
  for (let i = 0; i < hex.length; i += 4)
    out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
  return out;
}

function parseToUnicodeCMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let mm: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: 標準 regex 迭代慣用寫法
    while ((mm = re.exec(block))) map.set(mm[1].toUpperCase().padStart(4, "0"), hexToUtf16(mm[2]));
  }
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let mm: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: 標準 regex 迭代慣用寫法
    while ((mm = re.exec(block))) {
      const lo = Number.parseInt(mm[1], 16);
      const hi = Number.parseInt(mm[2], 16);
      const dstBase = Number.parseInt(mm[3], 16);
      for (let c = lo; c <= hi; c++) {
        map.set(
          c.toString(16).toUpperCase().padStart(mm[1].length, "0"),
          String.fromCharCode(dstBase + (c - lo))
        );
      }
    }
  }
  return map;
}

function resolveRef(dict: string, key: string): number | null {
  const m = dict.match(new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`));
  return m ? Number(m[1]) : null;
}

function decodeHexWithFont(
  hex: string,
  fontName: string | null,
  fontCmaps: Map<string, Map<string, string>>
): string {
  const cmap = fontName ? fontCmaps.get(fontName) : undefined;
  let out = "";
  for (let i = 0; i < hex.length; i += 4) {
    const code = hex
      .slice(i, i + 4)
      .toUpperCase()
      .padStart(4, "0");
    out += cmap?.get(code) ?? "";
  }
  return out;
}

/**
 * 回傳每一頁的文字內容（依 `/Pages /Kids` 之頁序；解不出頁樹時退回物件出現
 * 順序）。零新 npm 依賴——僅用 `node:zlib` 之 `inflateSync`。
 */
function extractPdfTextPerPage(pdfBytes: Buffer): string[] {
  const pdf = pdfBytes.toString("latin1");
  const objs = splitPdfObjects(pdf);

  const pageNums: number[] = [];
  const catalogEntry = [...objs.entries()].find(([, o]) => /\/Type\s*\/Catalog/.test(o.dict));
  if (catalogEntry) {
    const pagesRef = resolveRef(catalogEntry[1].dict, "Pages");
    if (pagesRef !== null) {
      const walk = (num: number): void => {
        const o = objs.get(num);
        if (!o) return;
        if (/\/Type\s*\/Pages\b/.test(o.dict)) {
          const kidsMatch = o.dict.match(/\/Kids\s*\[([^\]]*)\]/);
          if (kidsMatch) {
            const re = /(\d+)\s+0\s+R/g;
            let mm: RegExpExecArray | null;
            // biome-ignore lint/suspicious/noAssignInExpressions: 標準 regex 迭代慣用寫法
            while ((mm = re.exec(kidsMatch[1]))) walk(Number(mm[1]));
          }
        } else if (/\/Type\s*\/Page\b/.test(o.dict)) {
          pageNums.push(num);
        }
      };
      walk(pagesRef);
    }
  }
  if (pageNums.length === 0) {
    for (const [num, o] of objs) if (/\/Type\s*\/Page\b/.test(o.dict)) pageNums.push(num);
  }

  const pages: string[] = [];
  for (const pageNum of pageNums) {
    const obj = objs.get(pageNum);
    if (!obj) continue;
    let resourcesDict = obj.dict;
    const resRefMatch = obj.dict.match(/\/Resources\s+(\d+)\s+0\s+R/);
    if (resRefMatch) {
      const resObj = objs.get(Number(resRefMatch[1]));
      if (resObj) resourcesDict = resObj.dict;
    }
    const fontBlockMatch = resourcesDict.match(/\/Font\s*<<([\s\S]*?)>>/);
    const fontNameToObj = new Map<string, number>();
    if (fontBlockMatch) {
      const re = /\/(\w+)\s+(\d+)\s+0\s+R/g;
      let mm: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: 標準 regex 迭代慣用寫法
      while ((mm = re.exec(fontBlockMatch[1]))) fontNameToObj.set(mm[1], Number(mm[2]));
    }
    const fontCmaps = new Map<string, Map<string, string>>();
    for (const [name, fontObjNum] of fontNameToObj) {
      const fontObj = objs.get(fontObjNum);
      if (!fontObj) continue;
      const cmapRef = resolveRef(fontObj.dict, "ToUnicode");
      if (cmapRef === null) continue;
      const cmapObj = objs.get(cmapRef);
      if (!cmapObj?.streamRaw) continue;
      fontCmaps.set(name, parseToUnicodeCMap(maybeInflate(cmapObj.dict, cmapObj.streamRaw)));
    }

    const contentsMatch = obj.dict.match(/\/Contents\s+(\d+)\s+0\s+R|\/Contents\s*\[([^\]]*)\]/);
    const contentObjNums: number[] = [];
    if (contentsMatch) {
      if (contentsMatch[1]) contentObjNums.push(Number(contentsMatch[1]));
      else if (contentsMatch[2]) {
        const re = /(\d+)\s+0\s+R/g;
        let mm: RegExpExecArray | null;
        // biome-ignore lint/suspicious/noAssignInExpressions: 標準 regex 迭代慣用寫法
        while ((mm = re.exec(contentsMatch[2]))) contentObjNums.push(Number(mm[1]));
      }
    }

    let pageText = "";
    for (const cNum of contentObjNums) {
      const cObj = objs.get(cNum);
      if (!cObj?.streamRaw) continue;
      const content = maybeInflate(cObj.dict, cObj.streamRaw);
      let currentFont: string | null = null;
      const tokenRe =
        /\/(\w+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]*)>\s*Tj|\[((?:<[0-9A-Fa-f]*>|\([^)]*\)|[-\d.]+|\s)*)\]\s*TJ/g;
      let tm: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: 標準 regex 迭代慣用寫法
      while ((tm = tokenRe.exec(content))) {
        if (tm[1]) currentFont = tm[1];
        else if (tm[2] !== undefined) pageText += decodeHexWithFont(tm[2], currentFont, fontCmaps);
        else if (tm[3] !== undefined) {
          const hexRe = /<([0-9A-Fa-f]*)>/g;
          let hm: RegExpExecArray | null;
          // biome-ignore lint/suspicious/noAssignInExpressions: 標準 regex 迭代慣用寫法
          while ((hm = hexRe.exec(tm[3])))
            pageText += decodeHexWithFont(hm[1], currentFont, fontCmaps);
        }
      }
    }
    pages.push(pageText);
  }
  return pages;
}

// ---------------------------------------------------------------------------
// T14b：字型無關之幾何擷取（.segment 邊框封閉子路徑／.image-block 之 Do
// 置放矩形）——見檔頭「T14b 修訂」說明。僅用路徑座標與 CTM 矩陣運算，零
// ToUnicode／零字型解析依賴。
// ---------------------------------------------------------------------------

/** PDF `cm` 矩陣 `[a, b, c, d, e, f]`（`x' = a·x + c·y + e`；`y' = b·x + d·y + f`）。 */
type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m1`（新 `cm` operand）疊加於既有 CTM `m2` 之上（PDF 規格：CTM' = m1 × CTM）。 */
function matMul(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}
function applyMat(m: Matrix, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = m;
  return [a * x + c * y + e, b * x + d * y + f];
}

interface GeomRect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}
function rectOf(points: [number, number][]): GeomRect {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}
function geomOverlap(a: GeomRect, b: GeomRect): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

/** `.segment` 邊框顏色（`report-html.ts` :295 `border-color: #d1d5db`）之 PDF `RG` 三元值，含容差比對。 */
const BORDER_RG: [number, number, number] = [0xd1 / 255, 0xd5 / 255, 0xdb / 255];
function isBorderColor(rgb: [number, number, number] | null): boolean {
  if (!rgb) return false;
  return rgb.every((v, i) => Math.abs(v - BORDER_RG[i]) < 0.01);
}

/**
 * PHASE-008-T14R SF-1：`.print-hint` 邊框顏色（`report-html.ts` :301
 * `border: 1px solid #f59e0b`）之 PDF `RG` 三元值 ≈ `0.961 0.620 0.043`。
 * AC-34 之既有 ToUnicode 文字擷取斷言對此提示文字之鑑別力恆真（reviewer
 * 合併複審實測：提示渲染進 PDF 時 `HINT_FOUND` 仍為 false，見該提示所在
 * `Type3` 字型子集 `ToUnicode` CMap 覆蓋不完整，同 T14b 檔頭說明之限制）；
 * 本值改採字型無關之幾何訊號——`.print-hint` 為 `display:none`（列印媒
 * 體）時，其邊框描邊色理應**完全不出現**於任何頁面內容流。
 */
const HINT_BORDER_RG: [number, number, number] = [0xf5 / 255, 0x9e / 255, 0x0b / 255];
function isHintBorderColor(rgb: [number, number, number] | null): boolean {
  if (!rgb) return false;
  return rgb.every((v, i) => Math.abs(v - HINT_BORDER_RG[i]) < 0.01);
}

interface PageGeometry {
  /** `.segment` 邊框之封閉子路徑矩形（僅計入起訖點重合者，見檔頭說明）。 */
  segmentRects: GeomRect[];
  /** `.image-block` 內 `<img>` 之 `Do` 置放矩形。 */
  imageRects: GeomRect[];
  /** SF-1：本頁內容流是否曾以 `.print-hint` 邊框色描邊（正常 PDF 應恆 false）。 */
  hintBorderStrokeSeen: boolean;
}

/**
 * 逐頁擷取 `.segment` 邊框封閉子路徑矩形與 `.image-block` 影像置放矩形。
 * 獨立於 {@link extractPdfTextPerPage} 之頁／內容物件解析（刻意不共用，
 * 保持兩條擷取路徑互不干擾、各自可獨立驗證）。
 */
function extractPageGeometry(pdfBytes: Buffer): PageGeometry[] {
  const pdf = pdfBytes.toString("latin1");
  const objs = splitPdfObjects(pdf);

  const pageNums: number[] = [];
  const catalogEntry = [...objs.entries()].find(([, o]) => /\/Type\s*\/Catalog/.test(o.dict));
  if (catalogEntry) {
    const pagesRef = resolveRef(catalogEntry[1].dict, "Pages");
    if (pagesRef !== null) {
      const walk = (num: number): void => {
        const o = objs.get(num);
        if (!o) return;
        if (/\/Type\s*\/Pages\b/.test(o.dict)) {
          const kidsMatch = o.dict.match(/\/Kids\s*\[([^\]]*)\]/);
          if (kidsMatch) {
            const re = /(\d+)\s+0\s+R/g;
            let mm: RegExpExecArray | null;
            // biome-ignore lint/suspicious/noAssignInExpressions: 標準 regex 迭代慣用寫法
            while ((mm = re.exec(kidsMatch[1]))) walk(Number(mm[1]));
          }
        } else if (/\/Type\s*\/Page\b/.test(o.dict)) {
          pageNums.push(num);
        }
      };
      walk(pagesRef);
    }
  }
  if (pageNums.length === 0) {
    for (const [num, o] of objs) if (/\/Type\s*\/Page\b/.test(o.dict)) pageNums.push(num);
  }

  const result: PageGeometry[] = [];
  for (const pageNum of pageNums) {
    const obj = objs.get(pageNum);
    const segmentRects: GeomRect[] = [];
    const imageRects: GeomRect[] = [];
    let hintBorderStrokeSeen = false;
    if (!obj) {
      result.push({ segmentRects, imageRects, hintBorderStrokeSeen });
      continue;
    }
    const contentsMatch = obj.dict.match(/\/Contents\s+(\d+)\s+0\s+R|\/Contents\s*\[([^\]]*)\]/);
    const contentObjNums: number[] = [];
    if (contentsMatch) {
      if (contentsMatch[1]) contentObjNums.push(Number(contentsMatch[1]));
      else if (contentsMatch[2]) {
        const re = /(\d+)\s+0\s+R/g;
        let mm: RegExpExecArray | null;
        // biome-ignore lint/suspicious/noAssignInExpressions: 標準 regex 迭代慣用寫法
        while ((mm = re.exec(contentsMatch[2]))) contentObjNums.push(Number(mm[1]));
      }
    }

    for (const cNum of contentObjNums) {
      const cObj = objs.get(cNum);
      if (!cObj?.streamRaw) continue;
      const content = maybeInflate(cObj.dict, cObj.streamRaw);

      const tokenRe =
        /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm\b|(-?[\d.]+)\s+(-?[\d.]+)\s+m\b|(-?[\d.]+)\s+(-?[\d.]+)\s+l\b|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+c\b|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+RG\b|(?:^|\s)(q)(?=\s)|(?:^|\s)(Q)(?=\s)|(?:^|\s)(f\*|f|F|S|s|B\*|B|b\*|b|n)(?=\s)/g;

      let ctm: Matrix = IDENTITY;
      const ctmStack: Matrix[] = [];
      let currentRG: [number, number, number] | null = null;
      let currentPoints: [number, number][] = [];
      let currentStartsWithBorderColor = false;

      const flush = (painted: boolean): void => {
        if (currentPoints.length >= 2) {
          const [sx, sy] = currentPoints[0];
          const [ex, ey] = currentPoints[currentPoints.length - 1];
          const closed = Math.abs(sx - ex) < 0.6 && Math.abs(sy - ey) < 0.6;
          if (painted && closed && currentStartsWithBorderColor) {
            segmentRects.push(rectOf(currentPoints));
          }
        }
        currentPoints = [];
        currentStartsWithBorderColor = false;
      };

      let tm: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: 標準 regex 迭代慣用寫法
      while ((tm = tokenRe.exec(content))) {
        if (tm[1] !== undefined) {
          const nums = [tm[1], tm[2], tm[3], tm[4], tm[5], tm[6]].map(Number) as Matrix;
          ctm = matMul(nums, ctm);
        } else if (tm[7] !== undefined) {
          flush(false); // 新 m 開啟新子路徑（未經繪製之前段落若有殘留一併捨棄）
          currentPoints = [applyMat(ctm, Number(tm[7]), Number(tm[8]))];
          currentStartsWithBorderColor = isBorderColor(currentRG);
        } else if (tm[9] !== undefined) {
          currentPoints.push(applyMat(ctm, Number(tm[9]), Number(tm[10])));
        } else if (tm[11] !== undefined) {
          const nums = [tm[11], tm[12], tm[13], tm[14], tm[15], tm[16]].map(Number);
          currentPoints.push(applyMat(ctm, nums[0], nums[1]));
          currentPoints.push(applyMat(ctm, nums[2], nums[3]));
          currentPoints.push(applyMat(ctm, nums[4], nums[5]));
        } else if (tm[17] !== undefined) {
          currentRG = [Number(tm[17]), Number(tm[18]), Number(tm[19])];
        } else if (tm[20] === "q") {
          ctmStack.push(ctm);
        } else if (tm[21] === "Q") {
          ctm = ctmStack.pop() ?? ctm;
        } else if (tm[22] !== undefined) {
          flush(true);
          // SF-1：與 segmentRects 之子路徑機制無關——只要「當前描邊色」曾
          // 於任一繪製運算子觸發時等於 .print-hint 邊框色，即代表該元素
          // 曾實際生成內容流（列印媒體隱藏規則失效）。
          if (isHintBorderColor(currentRG)) hintBorderStrokeSeen = true;
        }
      }
      flush(false);

      // .image-block 之 Do 置放（獨立於路徑掃描，重新掃一次以取得 Do 前之
      // CTM——避免與上方路徑迴圈之狀態機交錯，邏輯各自單純）。
      let ctm2: Matrix = IDENTITY;
      const ctmStack2: Matrix[] = [];
      const doRe =
        /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm\b|(?:^|\s)(q)(?=\s)|(?:^|\s)(Q)(?=\s)|\/(\w+)\s+Do\b/g;
      let dm: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: 標準 regex 迭代慣用寫法
      while ((dm = doRe.exec(content))) {
        if (dm[1] !== undefined) {
          const nums = [dm[1], dm[2], dm[3], dm[4], dm[5], dm[6]].map(Number) as Matrix;
          ctm2 = matMul(nums, ctm2);
        } else if (dm[7] === "q") {
          ctmStack2.push(ctm2);
        } else if (dm[8] === "Q") {
          ctm2 = ctmStack2.pop() ?? ctm2;
        } else if (dm[9] !== undefined) {
          const corners: [number, number][] = [
            applyMat(ctm2, 0, 0),
            applyMat(ctm2, 1, 0),
            applyMat(ctm2, 1, 1),
            applyMat(ctm2, 0, 1),
          ];
          imageRects.push(rectOf(corners));
        }
      }
    }
    result.push({ segmentRects, imageRects, hintBorderStrokeSeen });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 共用播種狀態（beforeAll 播種一次，三個 AC 測試共用同一組 fixture ＋ 已下載
// 之真實 PDF——避免重複觸發後端真實 Chromium 渲染）
// ---------------------------------------------------------------------------

let staffLoginName: string;
let staffUserId: string;
let travelAppId: string;
let maintAppId: string;
let travelPdfPagesText: string[];
let travelPdfGeometry: PageGeometry[];
let maintPdfGeometry: PageGeometry[];

test.describe("報表列印版面機械驗證 — PHASE-008-T14 Gate E2E", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await loginAsAdmin(adminPage);

    const staff = await createSyntheticUser(adminPage, STAFF_TEMP_PASSWORD);
    staffUserId = staff.id;
    staffLoginName = staff.loginName;

    await ensureFuelPriceCovers(adminPage, FUEL_TYPE, TRIP_DATE);
    await ensureEtcCovers(adminPage, TRIP_DATE);
    await ensureFuelConsumptionCovers(adminPage, staffUserId, TRIP_DATE);
    await adminContext.close();

    const staffContext = await browser.newContext();
    const staffPage = await staffContext.newPage();
    await loginAsStaff(staffPage, staffLoginName);

    travelAppId = await seedTravelFixture(staffPage);
    maintAppId = await seedMaintenanceFixture(staffPage);

    await ensureReportGenerated(staffPage, travelAppId);
    await ensureReportGenerated(staffPage, maintAppId);

    const travelPdf = await downloadReportPdf(staffPage, travelAppId);
    // 完整性防線（AC-06 已於 T8 覆蓋，此處僅作為本檔 fixture 之基本健全檢
    // 查，不重複斷言 AC-06 之完整義務）。
    expect(travelPdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    travelPdfPagesText = extractPdfTextPerPage(travelPdf);
    travelPdfGeometry = extractPageGeometry(travelPdf);
    // AC-14 fixture 前提：足以產生 ≥ 2 頁。
    expect(travelPdfPagesText.length).toBeGreaterThanOrEqual(2);

    // SF-2：保養 PDF（B-11：5 圖單一 .images 區段，avoid-break 最高密度情
    // 境）——僅差下載解析，此處補下載＋幾何擷取，供 AC-14 測試內之影像置放
    // 矩形斷言使用。
    const maintPdf = await downloadReportPdf(staffPage, maintAppId);
    expect(maintPdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    maintPdfGeometry = extractPageGeometry(maintPdf);

    await staffContext.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsAdmin(page);
    if (staffUserId) {
      await page.request.delete(`${API_BASE}/admin/users/${staffUserId}`).catch(() => {});
    }
    await context.close();
  });

  // ---------------------------------------------------------------------------
  // AC-13(b)
  // ---------------------------------------------------------------------------
  test("AC-13(b): 列印媒體下每張圖寬度與右緣不超出內容區、文件無水平溢位（移除 max-width:100% 之 mutant 必紅）", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsStaff(page, staffLoginName);
    await page.setViewportSize({ width: CONTENT_WIDTH_PX, height: 1400 });

    await test.step("差旅報表（6 段，含 FW-2 未降尺寸大圖）之圖片不溢出", async () => {
      await page.goto(`${API_BASE}/applications/${travelAppId}/report/print`, {
        waitUntil: "load",
      });
      await page.emulateMedia({ media: "print" });

      const measured = await page.evaluate(() => {
        const imgs = Array.from(
          document.querySelectorAll<HTMLImageElement>(".image-block img.report-image")
        );
        return {
          images: imgs.map((img) => {
            const r = img.getBoundingClientRect();
            return {
              width: r.width,
              right: r.right,
              naturalMax: Math.max(img.naturalWidth, img.naturalHeight),
            };
          }),
          scrollWidth: document.documentElement.scrollWidth,
        };
      });

      expect(measured.images.length).toBeGreaterThanOrEqual(SEGMENT_PLANS.length);
      // FW-2 大圖（原始像素 2400×1800，未降尺寸；EXIF orientation 6 使瀏覽器
      // `naturalWidth`/`naturalHeight` 依 `image-orientation: from-image` 互
      // 換，故取兩者較大值判斷）確實在場——佐證本測試涵蓋該邊界（否則
      // max-width:100% 之鑑別力主要來源即缺席）。
      expect(measured.images.some((i) => i.naturalMax >= 2000)).toBe(true);
      for (const img of measured.images) {
        expect(img.width).toBeLessThanOrEqual(CONTENT_WIDTH_PX + 1);
        expect(img.right).toBeLessThanOrEqual(CONTENT_WIDTH_PX + 1);
      }
      expect(measured.scrollWidth).toBeLessThanOrEqual(CONTENT_WIDTH_PX + 1);
    });

    await test.step("保養報表（B-11：5 張證明上限）之圖片不溢出", async () => {
      await page.goto(`${API_BASE}/applications/${maintAppId}/report/print`, { waitUntil: "load" });
      await page.emulateMedia({ media: "print" });

      const measured = await page.evaluate(() => {
        const imgs = Array.from(
          document.querySelectorAll<HTMLImageElement>(".image-block img.report-image")
        );
        return {
          count: imgs.length,
          images: imgs.map((img) => {
            const r = img.getBoundingClientRect();
            return { width: r.width, right: r.right };
          }),
          scrollWidth: document.documentElement.scrollWidth,
        };
      });

      expect(measured.count).toBe(5);
      for (const img of measured.images) {
        expect(img.width).toBeLessThanOrEqual(CONTENT_WIDTH_PX + 1);
        expect(img.right).toBeLessThanOrEqual(CONTENT_WIDTH_PX + 1);
      }
      expect(measured.scrollWidth).toBeLessThanOrEqual(CONTENT_WIDTH_PX + 1);
    });

    await context.close();
  });

  // ---------------------------------------------------------------------------
  // AC-34
  // ---------------------------------------------------------------------------
  test("AC-34: 列印版於 375px 可閱讀且含桌面列印提示；該提示於列印媒體與 PDF 文字中皆不出現", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsStaff(page, staffLoginName);

    // --- 375px 螢幕媒體：提示可見且逐字在場，無水平溢位 ---
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${API_BASE}/applications/${travelAppId}/report/print`, { waitUntil: "load" });
    const hintLocator = page.locator(".print-hint");
    await expect(hintLocator).toHaveText(PRINT_HINT_TEXT);
    await expect(hintLocator).toBeVisible();
    const screenScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(screenScrollWidth).toBeLessThanOrEqual(375 + 1);

    // --- 列印媒體模擬：提示隱藏 ---
    await page.emulateMedia({ media: "print" });
    await expect(hintLocator).toBeHidden();

    await context.close();

    // --- PDF 文字擷取：提示文字不出現於任何一頁（輔助斷言——見下方 SF-1
    //     說明，本層對此提示文字之鑑別力有限，不可單獨作為 AC-34 之唯一
    //     防線） ---
    for (const pageText of travelPdfPagesText) {
      expect(pageText).not.toContain(PRINT_HINT_TEXT);
    }

    // --- PHASE-008-T14R SF-1：PDF 幾何層（字型無關，主防線）——正常 PDF
    //     全文件不應出現 .print-hint 邊框色之描邊路徑。上方 ToUnicode 文
    //     字擷取斷言經 reviewer 合併複審實測為恆真（提示渲染進 PDF 時
    //     HINT_FOUND 仍為 false，見 extractPdfTextPerPage 之 Type3 字型子
    //     集 ToUnicode CMap 覆蓋不完整限制，同 T14b 檔頭說明），故以此幾何
    //     訊號補上真正之鑑別力（`@media print { .print-hint { display:
    //     none } }` 失效之 mutant 必紅，見 Task Handoff）。 ---
    expect(travelPdfGeometry.some((g) => g.hintBorderStrokeSeen)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // AC-14（T14b：字型無關幾何訊號，見檔頭「T14b 修訂」）
  // ---------------------------------------------------------------------------
  test("AC-14: 多頁 fixture 下每個不可分割區塊之頁索引一致且任兩區塊矩形不重疊（移除 break-inside: avoid 之 mutant 必紅）", async () => {
    const allSegmentRects: { page: number; rect: GeomRect }[] = [];
    const allImageRects: { page: number; rect: GeomRect }[] = [];
    travelPdfGeometry.forEach((g, page) => {
      for (const rect of g.segmentRects) allSegmentRects.push({ page, rect });
      for (const rect of g.imageRects) allImageRects.push({ page, rect });
    });

    // --- 頁索引一致性：全文件「封閉」邊框子路徑總數須恰等於段落數。未經保
    //     護之切割會使該段落之邊框路徑起訖點不再重合（不計入 flush 之
    //     `closed` 判定），故總數短少即為切割之直接證據（見檔頭 T14b 說
    //     明）。 ---
    expect(
      allSegmentRects.length,
      `全文件應偵測到恰 ${SEGMENT_PLANS.length} 個完整（起訖點重合）之 .segment 邊框子路徑；` +
        `實得 ${allSegmentRects.length}（逐頁：${travelPdfGeometry.map((g) => g.segmentRects.length).join(",")}）`
    ).toBe(SEGMENT_PLANS.length);

    // --- 影像置放矩形亦須每段恰一張（.image-block 之 Do 呼叫，字型無關）---
    expect(allImageRects.length).toBe(SEGMENT_PLANS.length);

    // --- 任兩矩形（同頁內，含 segment 與 image）不重疊 ---
    const byPage = new Map<number, GeomRect[]>();
    for (const { page, rect } of [...allSegmentRects, ...allImageRects]) {
      const list = byPage.get(page) ?? [];
      list.push(rect);
      byPage.set(page, list);
    }
    for (const [page, rects] of byPage) {
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          expect(geomOverlap(rects[i], rects[j]), `第 ${page} 頁區塊 #${i} 與 #${j} 不得重疊`).toBe(
            false
          );
        }
      }
    }

    // --- PHASE-008-T14R SF-2（B-11 保養報表：5 圖單一 .images 區段，每張
    //     ≈468×374pt 一頁僅容 2 張，avoid-break 最高密度情境）---
    const maintByPage = new Map<number, GeomRect[]>();
    let maintTotalImageRects = 0;
    maintPdfGeometry.forEach((g, page) => {
      maintTotalImageRects += g.imageRects.length;
      if (g.imageRects.length > 0) maintByPage.set(page, g.imageRects);
    });
    expect(maintTotalImageRects).toBe(5);
    for (const [page, rects] of maintByPage) {
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          expect(
            geomOverlap(rects[i], rects[j]),
            `保養報表第 ${page} 頁圖片 #${i} 與 #${j} 不得重疊`
          ).toBe(false);
        }
      }
    }
  });
});
