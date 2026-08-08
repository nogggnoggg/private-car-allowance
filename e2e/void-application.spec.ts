/**
 * E2E: 作廢端到端 Gate — PHASE-009-T17（AC-35 ＋ AC-34 之作廢側三面）
 * （Spec `docs/specs/PHASE-009.md` §2.I AC-35 :245、§2.H AC-34 :241、§15 T17 :868）
 *
 * AC-35（:245 逐字）：「差旅 ＋ 另一型（保養或折舊）各一：完成 → 產生報表 →
 * 作廢（二次確認 ＋ 原因）→ 列表顯示已作廢 → 詳情顯示原因／操作者／時間 →
 * 列印版顯示作廢標示 → 下載 PDF（依 D4 之裁定語意）→ 區間里程統計不含該筆。
 * 草稿無作廢入口之負向。」
 *
 * AC-34（:241 逐字）：「375px 下：作廢確認對話框、作廢資訊區塊、版本關係區
 * 塊、已作廢列印版**皆無水平溢位**且內容可讀。」
 *   → 四面之中，**版本關係區塊**須有 `supersedes`／`supersededBy` 之申請對才
 *     存在，其自然落點在 `e2e/revision.spec.ts`（該檔已建立修正版對）；本檔
 *     負責其餘三面（作廢確認對話框／作廢資訊區塊／已作廢列印版）。兩檔合計
 *     覆蓋 AC-34 四面。
 *
 * ---------------------------------------------------------------------------
 * 四個測試
 * ---------------------------------------------------------------------------
 *   1. `AC-35: 差旅端到端（完成→產生報表→作廢→列表已作廢→詳情三項→列印版
 *      標示→下載作廢版→區間里程統計排除）`
 *   2. `AC-35: 保養端到端（完成→產生報表→作廢→列表已作廢→詳情三項→列印版
 *      標示→下載作廢版）`——AC-35 之「另一型」取保養。
 *   3. `AC-35: 草稿無作廢入口（負向）`
 *   4. `AC-34: 375px——作廢確認對話框／作廢資訊區塊／已作廢列印版無水平溢位`
 *
 * ---------------------------------------------------------------------------
 * FW 核銷（Packet 逐項）
 * ---------------------------------------------------------------------------
 *   FW-1（T16／T14 即審，`exact: true`）：`getByRole(name)` 預設為**子字串**
 *     比對——「下載 PDF」會誤命中「下載 PDF（作廢版）」、「檢視修正版」會誤命
 *     中「檢視既有修正版」。本檔所有 `getByRole` 之 `name` 一律 `exact: true`。
 *     作廢前後之下載連結文案刻意不同（`ReportSection.tsx` :179），正是本規則
 *     必須存在的原因：作廢後若仍以「下載 PDF」非 exact 命中，會在文案迴歸時
 *     靜默通過。
 *
 *   FW-2（T12b 即審 FW-6，作廢版位元組）：AC-35 之「下載 PDF」不得沿用
 *     PHASE-008 之 `%PDF-` 前綴斷言——該斷言在「端點錯回原檔」時**恆真**。
 *     本檔改以**三段位元組級斷言**：
 *       (a) 作廢**前**先下載一次原始報表 PDF，保留其位元組 `bytesOriginal`；
 *       (b) 作廢**後**下載，斷言 `Buffer.compare(bytesOriginal, bytesVoided)
 *           !== 0`——端點若回原檔則必紅（此為 FW-6 所指之鑑別力來源）；
 *       (c) 作廢後**再下載一次**，斷言兩次位元組全等——證明回傳的是已保存之
 *           `VoidedReportFile` 產物而非每次重新渲染（AC-21(b)／PHASE-008
 *           AC-08 之「零渲染」紀律於作廢後仍成立）。
 *     另斷言 `Content-Disposition` 之建議檔名於作廢前後**逐字不變**（AC-21(d)
 *     之對外語意：報表編號與檔名不因作廢而改）。
 *     **未採 PDF 文字擷取**（見 FW-4）。
 *
 *   FW-3（T15d 即審）：作廢資訊 `dl` 現為**四列**（作廢原因／作廢操作者／
 *     作廢時間／作廢當時金額，`TravelApplicationPage.tsx` :678-686）。本檔以
 *     `readDetailList` 之 **dt 文字 → dd 值**對應查表（沿 `report-pdf.spec.ts`
 *     :380 既有 helper 之同一手法），**零 `nth()` 索引**——列數再變動亦不影響。
 *
 *   FW-4（T11 即審）：`.void-banner` 於 375px 零溢位（測試 4）已覆蓋。
 *     「PDF 文字擷取含『已作廢』」之可行性**實查結果：不採**——e2e 既有先例
 *     `report-print-layout.spec.ts` :540 之 `extractPdfTextPerPage` **未
 *     `export`**（該檔為 spec 檔，跨 spec 檔 import 會連帶註冊其測試），複製
 *     其 ~200 行 ToUnicode／FlateDecode 解析進本檔既超出本 Task 之 diff 預算，
 *     亦與該檔頭自載之限制（字型子集 CMap 覆蓋不完整、擷取可能漏字）相衝突。
 *     依 Packet FW-4 之明文備案「無則位元組級斷言替代並記載」，改以 FW-2 之
 *     三段位元組級斷言承擔 PDF 面之鑑別力；作廢標示之**內容**面則由列印版
 *     HTML 之 `.void-banner` 逐字斷言承擔（同一 `renderReportHtml` 輸出，
 *     PDF 即該 HTML 之 Chromium 列印產物）。
 *
 *   FW-5（T13 §K 慣例，statusLabel 假陽性紀律）：作廢標示一律**在區塊內**
 *     比對——列印版用 `page.locator(".void-banner")` 為 scope、詳情頁用
 *     `section[aria-labelledby='void-info-heading']` 為 scope、列表用該筆
 *     所在 `<tr>` 之 `.status-badge` 為 scope，**不**用整頁 `getByText("已作
 *     廢")`（頁面他處亦有「已作廢」字樣，例如 h1「差旅補助申請（已作廢）」
 *     與唯讀提示，全頁比對會恆真）。
 *
 *   FW-6（AC-35 統計格）：以首頁「區間公務總里程統計」查詢面實查——作廢
 *     **前**查得 `50.00 公里／共 1 筆`、作廢**後**同一區間查得 `0.00 公里`。
 *     合成使用者名下僅本檔播種之單筆差旅，故該統計恆為封閉可預期值（沿
 *     `mileage-statistics.spec.ts` 之隔離策略）。
 *
 *   FW-7（播種冪等）：合成使用者名以 `RUN_ID`（時間戳 ＋ 亂數）為後綴，每次
 *     執行皆為全新使用者；全域參數一律「先查後建」（`ensure*Covers`），重跑
 *     不互撞、不重複寫入。`afterAll` 刪除該使用者。
 *
 *   FW-8（既有 44 條基準線）：本 Task 動工前已於同一 dev 拓撲實跑 `npx
 *     playwright test`，44 passed（見 Handoff `Test Results`），零紅、零既有
 *     spec 變更。
 *
 * ---------------------------------------------------------------------------
 * Topology / Test account
 * ---------------------------------------------------------------------------
 * 大總管已啟動之 dev 拓撲（backend :3000、Vite :5173、`t1-pg`）；管理員帳號
 * 沿既有 E2E 慣例（`e2eadmin`）；合成使用者以 `e2e-void-<RUN_ID>` 命名。
 * 播種與斷言慣例沿 `report-pdf.spec.ts`（PHASE-008-T15）／
 * `mileage-statistics.spec.ts`（PHASE-005-T8）既有寫法。
 */

import { readFile } from "node:fs/promises";
import { type Page, expect, test } from "@playwright/test";

const E2E_ADMIN = { loginName: "e2eadmin", password: "E2eAdmin@456!" };
const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";

// ---------------------------------------------------------------------------
// 日期／年度（動態相對值，沿 report-pdf.spec.ts 慣例）
// ---------------------------------------------------------------------------
function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
const TRIP_DATE = isoDateDaysAgo(20);
const RANGE_FROM = isoDateDaysAgo(30);
const RANGE_TO = isoDateDaysAgo(10);
const MAINT_LAST_DATE = isoDateDaysAgo(40);
const MAINT_CURRENT_DATE = isoDateDaysAgo(0);
const PARAM_EFFECTIVE_FROM = "2020-06-01";
const FUEL_TYPE = "GASOLINE_92";
const FUEL_KM_PER_LITER = "10.0000";
const FUEL_PRICE_PER_LITER = "65.0000";
const ETC_UNIT_PRICE = 1.8;
const FUEL_BASIS_NOTE = "PHASE-009-T17 E2E 合成資料（作廢 Gate E2E 播種用）";

/** FW-6：本檔唯一一筆差旅之總里程；統計斷言之封閉期望值。 */
const TRAVEL_TOTAL_KM = "50.00";

/** 作廢原因（逐字斷言用；刻意含中文與數字以與他處文案區隔）。 */
const VOID_REASON_TRAVEL = "T17 差旅重複申報，作廢原申請";
const VOID_REASON_MAINT = "T17 保養金額有誤，作廢原申請";

// ---------------------------------------------------------------------------
// FW-7：播種冪等——單次執行之唯一識別
// ---------------------------------------------------------------------------
const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

const STAFF_TEMP_PASSWORD = "TempPw@2026Void!";
const STAFF_NEW_PASSWORD = "NewPw@2026Void!";

// ---------------------------------------------------------------------------
// Auth / 播種 helpers（沿 report-pdf.spec.ts 既有慣例：API 直接播種）
// ---------------------------------------------------------------------------

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.waitForURL(`${BASE}/login`);
  await page.fill("#loginName", E2E_ADMIN.loginName);
  await page.fill("#password", E2E_ADMIN.password);
  await page.click('button:has-text("登入")');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
}

async function createSyntheticUser(page: Page): Promise<{ id: string; loginName: string }> {
  const loginName = `e2e-void-${RUN_ID}`;
  const displayName = `T17作廢使用者${RUN_ID}`;
  const res = await page.request.post(`${API_BASE}/admin/users`, {
    data: { loginName, displayName, temporaryPassword: STAFF_TEMP_PASSWORD },
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
// 合成圖片（procedural；真實可解碼位元組——沿 report-pdf.spec.ts）
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

async function makeNoiseJpeg(width: number, height: number, seed: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const rnd = makeXorshift32(seed);
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(rnd() * 256) & 0xff;
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function uploadAttachment(page: Page, buffer: Buffer, name: string): Promise<string> {
  const res = await page.request.post(`${API_BASE}/attachments`, {
    multipart: { file: { name, mimeType: "image/jpeg", buffer } },
  });
  if (!res.ok())
    throw new Error(`E2E 上傳附件失敗（${name}）: ${res.status()} ${await res.text()}`);
  const { attachment } = (await res.json()) as { attachment: { id: string } };
  return attachment.id;
}

// ---------------------------------------------------------------------------
// 播種（純 API；「產生報表」與「作廢」皆由測試以 UI 觸發，忠實走 AC-35 流程）
// ---------------------------------------------------------------------------

/** 播種一筆完成之差旅申請（1 段 50.00 公里，1 張證明）。 */
async function seedCompletedTravel(page: Page, purposeSuffix: string): Promise<string> {
  const createRes = await page.request.post(`${API_BASE}/applications/travel`, { data: {} });
  if (!createRes.ok()) throw new Error(`E2E 播種差旅建立失敗: ${createRes.status()}`);
  const { application } = (await createRes.json()) as { application: { id: string } };
  const tripId = application.id;

  const buf = await makeNoiseJpeg(600, 400, 0x1701);
  const attachmentId = await uploadAttachment(page, buf, "t17-trip.jpg");

  const putRes = await page.request.put(`${API_BASE}/applications/travel/${tripId}`, {
    data: {
      tripDate: TRIP_DATE,
      purpose: `PHASE-009-T17 作廢 Gate 出差目的（${purposeSuffix}）`,
      segments: [
        {
          origin: "T17起點",
          destination: "T17終點",
          totalKm: TRAVEL_TOTAL_KM,
          highwayKm: "10.00",
          attachmentIds: [attachmentId],
        },
      ],
    },
  });
  if (!putRes.ok())
    throw new Error(`E2E 播種差旅段落設定失敗: ${putRes.status()} ${await putRes.text()}`);

  const completeRes = await page.request.post(`${API_BASE}/applications/${tripId}/complete`);
  if (!completeRes.ok())
    throw new Error(`E2E 播種差旅完成失敗: ${completeRes.status()} ${await completeRes.text()}`);
  return tripId;
}

/** 播種一筆完成之保養申請（1 張證明）。 */
async function seedCompletedMaintenance(page: Page): Promise<string> {
  const createRes = await page.request.post(`${API_BASE}/applications/maintenance`, { data: {} });
  if (!createRes.ok()) throw new Error(`E2E 播種保養建立失敗: ${createRes.status()}`);
  const { application } = (await createRes.json()) as { application: { id: string } };
  const maintId = application.id;

  const buf = await makeNoiseJpeg(600, 400, 0x1702);
  const attachmentId = await uploadAttachment(page, buf, "t17-maint.jpg");

  const putRes = await page.request.put(`${API_BASE}/applications/maintenance/${maintId}`, {
    data: {
      lastMaintenanceDate: MAINT_LAST_DATE,
      currentMaintenanceDate: MAINT_CURRENT_DATE,
      lastOdometerKm: "10000.00",
      currentOdometerKm: "10500.00",
      actualCost: "2000.00",
      attachmentIds: [attachmentId],
    },
  });
  if (!putRes.ok())
    throw new Error(`E2E 播種保養欄位設定失敗: ${putRes.status()} ${await putRes.text()}`);

  const completeRes = await page.request.post(`${API_BASE}/applications/${maintId}/complete`);
  if (!completeRes.ok())
    throw new Error(`E2E 播種保養完成失敗: ${completeRes.status()} ${await completeRes.text()}`);
  return maintId;
}

// ---------------------------------------------------------------------------
// 讀取 helpers
// ---------------------------------------------------------------------------

/**
 * FW-3：`dl` 之 **dt 文字 → dd 值**對應表（沿 `report-pdf.spec.ts` :380）。
 * 以標籤查表而非 `nth()` 索引——作廢資訊 `dl` 由三列（T15）擴為四列（T15d）
 * 後，索引式定位即失效，標籤式不受影響。
 */
async function readDetailList(scope: ReturnType<Page["locator"]>): Promise<Record<string, string>> {
  const dts = await scope.locator("dt").allTextContents();
  const dds = await scope.locator("dd").allTextContents();
  const result: Record<string, string> = {};
  dts.forEach((k, i) => {
    result[k] = dds[i] ?? "";
  });
  return result;
}

async function measureOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

/** 於（已登入之）`page` 上，以首頁區間公務總里程查詢區塊送出查詢（FW-6）。 */
async function queryMileageSummary(page: Page, dateFrom: string, dateTo: string): Promise<void> {
  await page.fill("#mileage-dateFrom", dateFrom);
  await page.fill("#mileage-dateTo", dateTo);
  await page.click('button:has-text("查詢")');
}

/** 下載一次 PDF 並回傳 { bytes, filename }（FW-1：連結名一律 exact）。 */
async function downloadReportPdf(
  page: Page,
  scope: ReturnType<Page["locator"]>,
  linkName: string
): Promise<{ bytes: Buffer; filename: string }> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    scope.getByRole("link", { name: linkName, exact: true }).click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error("E2E 下載失敗：Playwright 未回傳本地檔案路徑");
  return { bytes: await readFile(path), filename: download.suggestedFilename() };
}

// ---------------------------------------------------------------------------
// 作廢共用流程（AC-35 之一型；差旅／保養各呼叫一次）
// ---------------------------------------------------------------------------

interface VoidFlowResult {
  reportNumber: string;
}

async function exerciseVoidEndToEnd(
  page: Page,
  applicationId: string,
  detailPath: string,
  /** 頁面 h1 之型別詞：差旅為「差旅補助申請」、保養為「保養費用申請」（實查）。 */
  h1Prefix: "差旅補助申請" | "保養費用申請",
  reportPrefix: "TRV" | "MNT",
  voidReason: string
): Promise<VoidFlowResult> {
  const reportSection = page.locator("section[aria-labelledby='report-heading']");

  // ---- 1. 完成 → 產生報表（UI 觸發） ----
  await page.goto(`${BASE}${detailPath}`, { waitUntil: "load" });
  await page.waitForURL(`${BASE}${detailPath}`);
  await expect(page.locator("h1")).toHaveText(`${h1Prefix}（已完成）`);

  await expect(reportSection.getByText("尚未產生正式報表")).toBeVisible({ timeout: 10000 });
  await reportSection.getByRole("button", { name: "產生正式報表", exact: true }).click();

  const reportDl = reportSection.locator("dl.detail-list");
  await expect(reportDl).toBeVisible({ timeout: 15000 });
  const reportNumber = (await readDetailList(reportDl)).報表編號;
  expect(reportNumber).toMatch(new RegExp(`^${reportPrefix}-\\d{6}-\\d{4,5}$`));

  // ---- 2. FW-2(a)：作廢前先取得原始報表 PDF 之位元組與檔名 ----
  const original = await downloadReportPdf(page, reportSection, "下載 PDF");
  expect(original.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(original.filename).toContain(reportNumber);

  // ---- 3. 作廢（二次確認 ＋ 必填原因；AC-29） ----
  await page.getByRole("button", { name: "作廢", exact: true }).click();
  const dialog = page.locator(".dialog-overlay dialog.dialog-box");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("h3")).toHaveText("確認作廢申請");

  // AC-29(c)：原因空白時確認鈕停用（前端第一道）。
  const confirmBtn = dialog.getByRole("button", { name: "確認作廢", exact: true });
  await expect(confirmBtn).toBeDisabled();
  await dialog.locator("#void-reason").fill(voidReason);
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();

  // 作廢成功 → 本頁換為已作廢唯讀呈現。
  await expect(page.locator("h1")).toHaveText(`${h1Prefix}（已作廢）`, { timeout: 15000 });
  await expect(dialog).toHaveCount(0);

  // ---- 4. 詳情顯示原因／操作者／時間（AC-30(c)；FW-3 標籤查表、FW-5 區塊內比對） ----
  const voidInfoSection = page.locator("section[aria-labelledby='void-info-heading']");
  await expect(voidInfoSection).toBeVisible();
  await expect(voidInfoSection.locator("#void-info-heading")).toHaveText("作廢資訊");
  const voidFields = await readDetailList(voidInfoSection.locator("dl.detail-list"));
  expect(voidFields.作廢原因).toBe(voidReason);
  expect(voidFields.作廢操作者).toBe(`T17作廢使用者${RUN_ID}`);
  // 作廢時間：AC-30(c)「時間格式與既有『計算時間』同一長相」——三型詳情頁
  // 皆以 `new Date(...).toLocaleString("zh-TW")` 呈現（`TravelApplication
  // Page.tsx` :684 與同頁快照之「計算時間」:764 同一寫法），於
  // `test.use({ locale: "zh-TW", timezoneId: "Asia/Taipei" })` 下之長相為
  // `YYYY/M/D 上午|下午H:MM:SS`。刻意**不**用 `new Date(...)` 反解析——該
  // 在地化字串非 Date 可解析格式（首輪實跑即以此紅燈揭露），且時刻本身不可
  // 預測，故只斷言**長相**（沿 report-pdf.spec.ts FW-3「不比對時間字面」之
  // 紀律，但比「非空」更有鑑別力：ISO 字面或空值皆必紅）。
  expect(voidFields.作廢時間).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2} \S*\d{1,2}:\d{2}:\d{2}$/);

  // AC-31(b)：已作廢頁零「作廢」／零「建立修正版」入口（負向）。
  await expect(page.getByRole("button", { name: "作廢", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "建立修正版", exact: true })).toHaveCount(0);

  // ---- 5. 列表顯示已作廢（FW-5：於該筆之 <tr> 內比對 .status-badge） ----
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  const row = page.locator("table.app-list-table tbody tr", {
    has: page.locator(`a[href$="${applicationId}"]`),
  });
  await expect(row).toHaveCount(1, { timeout: 10000 });
  await expect(row.locator(".status-badge")).toHaveText("已作廢");

  // AC-30(b)：狀態篩選選「已作廢」仍可查得該筆。
  await page.selectOption("#filter-status", "VOIDED");
  await page.getByRole("button", { name: "套用篩選", exact: true }).click();
  await expect(row).toHaveCount(1, { timeout: 10000 });
  await expect(row.locator(".status-badge")).toHaveText("已作廢");

  // ---- 6. 列印版顯示作廢標示（FW-5：`.void-banner` 區塊內比對） ----
  await page.goto(`${API_BASE}/applications/${applicationId}/report/print`, { waitUntil: "load" });
  const banner = page.locator(".void-banner");
  await expect(banner).toHaveCount(1);
  await expect(banner.locator(".void-banner-title")).toHaveText("已作廢");
  await expect(banner).toContainText(voidReason);
  await expect(banner).toContainText(`T17作廢使用者${RUN_ID}`);

  // ---- 7. 下載 PDF（依 D4：回作廢版位元組；FW-2(b)(c)） ----
  await page.goto(`${BASE}${detailPath}`, { waitUntil: "load" });
  await expect(reportSection.locator("dl.detail-list")).toBeVisible({ timeout: 10000 });
  // FW-1：作廢後之連結文案為「下載 PDF（作廢版）」；exact 命中，非子字串。
  await expect(reportSection.getByRole("link", { name: "下載 PDF", exact: true })).toHaveCount(0);
  const voided1 = await downloadReportPdf(page, reportSection, "下載 PDF（作廢版）");
  expect(voided1.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  // (b) 與原始報表位元組**不同**——端點若錯回原檔則必紅。
  expect(Buffer.compare(original.bytes, voided1.bytes)).not.toBe(0);
  // AC-21(d)：報表編號與建議檔名不因作廢而改。
  expect(voided1.filename).toBe(original.filename);
  // (c) 重複下載位元組全等——證明回傳已保存產物而非重新渲染。
  const voided2 = await downloadReportPdf(page, reportSection, "下載 PDF（作廢版）");
  expect(Buffer.compare(voided1.bytes, voided2.bytes)).toBe(0);

  // AC-31(d)：已作廢報表區塊零「產生正式報表」按鈕。
  await expect(
    reportSection.getByRole("button", { name: "產生正式報表", exact: true })
  ).toHaveCount(0);

  return { reportNumber };
}

// ---------------------------------------------------------------------------
// 共用播種狀態
// ---------------------------------------------------------------------------

let staffUserId: string;
let staffLoginName: string;
let travelAppId: string;
let maintAppId: string;
/** 測試 4（AC-34 對話框量測）專用：保持 `COMPLETED`，量測後取消、零狀態變更。 */
let dialogAppId: string;

test.describe("作廢端到端 Gate — PHASE-009-T17（AC-35／AC-34）", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ timezoneId: "Asia/Taipei", locale: "zh-TW" });

  test.beforeAll(async ({ browser }) => {
    const adminContext = await browser.newContext({ timezoneId: "Asia/Taipei", locale: "zh-TW" });
    const adminPage = await adminContext.newPage();
    await loginAsAdmin(adminPage);

    const staff = await createSyntheticUser(adminPage);
    staffUserId = staff.id;
    staffLoginName = staff.loginName;

    await ensureFuelPriceCovers(adminPage, FUEL_TYPE, TRIP_DATE);
    await ensureEtcCovers(adminPage, TRIP_DATE);
    await ensureFuelConsumptionCovers(adminPage, staffUserId, TRIP_DATE);
    await adminContext.close();

    const staffContext = await browser.newContext({ timezoneId: "Asia/Taipei", locale: "zh-TW" });
    const staffPage = await staffContext.newPage();
    await loginAsStaff(staffPage, staffLoginName);

    travelAppId = await seedCompletedTravel(staffPage, "主情境");
    maintAppId = await seedCompletedMaintenance(staffPage);
    await staffContext.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ timezoneId: "Asia/Taipei", locale: "zh-TW" });
    const page = await context.newPage();
    await loginAsAdmin(page);
    if (staffUserId) {
      await page.request.delete(`${API_BASE}/admin/users/${staffUserId}`).catch(() => {});
    }
    await context.close();
  });

  // -------------------------------------------------------------------------
  // 測試 1：差旅端到端（含 FW-6 統計排除）
  // -------------------------------------------------------------------------
  test("AC-35: 差旅端到端（完成→產生報表→作廢→列表已作廢→詳情三項→列印版標示→下載作廢版→區間里程統計排除）", async ({
    page,
  }) => {
    await loginAsStaff(page, staffLoginName);

    // FW-6 前置：作廢**前**之區間統計含本筆（50.00 公里／共 1 筆）。
    await test.step("作廢前：區間里程統計含本筆", async () => {
      await page.goto(`${BASE}/`, { waitUntil: "load" });
      await queryMileageSummary(page, RANGE_FROM, RANGE_TO);
      await expect(page.locator(".mileage-summary-value")).toContainText(
        `公務總里程 ${TRAVEL_TOTAL_KM} 公里`,
        { timeout: 10000 }
      );
      await expect(page.locator(".mileage-summary-meta")).toContainText("共 1 筆");
    });

    await test.step("作廢全鏈", async () => {
      await exerciseVoidEndToEnd(
        page,
        travelAppId,
        `/applications/travel/${travelAppId}`,
        "差旅補助申請",
        "TRV",
        VOID_REASON_TRAVEL
      );
    });

    // FW-6：作廢**後**同一區間之統計不含本筆（AC-15~AC-17 之 E2E 面）。
    await test.step("作廢後：區間里程統計不含本筆", async () => {
      await page.goto(`${BASE}/`, { waitUntil: "load" });
      await queryMileageSummary(page, RANGE_FROM, RANGE_TO);
      await expect(page.locator(".mileage-summary-value")).toContainText("0.00 公里", {
        timeout: 10000,
      });
      await expect(page.locator(".mileage-summary-value")).not.toContainText(TRAVEL_TOTAL_KM);
    });
  });

  // -------------------------------------------------------------------------
  // 測試 2：保養端到端（AC-35 之「另一型」）
  // -------------------------------------------------------------------------
  test("AC-35: 保養端到端（完成→產生報表→作廢→列表已作廢→詳情三項→列印版標示→下載作廢版）", async ({
    page,
  }) => {
    await loginAsStaff(page, staffLoginName);
    await exerciseVoidEndToEnd(
      page,
      maintAppId,
      `/applications/maintenance/${maintAppId}`,
      "保養費用申請",
      "MNT",
      VOID_REASON_MAINT
    );
  });

  // -------------------------------------------------------------------------
  // 測試 3：草稿無作廢入口（負向）
  // -------------------------------------------------------------------------
  test("AC-35: 草稿無作廢入口（負向）", async ({ page }) => {
    await loginAsStaff(page, staffLoginName);

    const createRes = await page.request.post(`${API_BASE}/applications/travel`, { data: {} });
    if (!createRes.ok()) throw new Error(`E2E 播種草稿失敗: ${createRes.status()}`);
    const { application } = (await createRes.json()) as { application: { id: string } };
    const draftId = application.id;

    await page.goto(`${BASE}/applications/travel/${draftId}`, { waitUntil: "load" });
    await page.waitForURL(`${BASE}/applications/travel/${draftId}`);
    await expect(page.locator("h1")).toHaveText("差旅補助申請（草稿）");

    // 前端層：零作廢入口、零對話框、零作廢資訊區塊。
    await expect(page.getByRole("button", { name: "作廢", exact: true })).toHaveCount(0);
    await expect(page.locator(".dialog-overlay")).toHaveCount(0);
    await expect(page.locator("section[aria-labelledby='void-info-heading']")).toHaveCount(0);

    // 後端層：作廢端點對草稿 409（入口確實不可達，非僅前端隱藏）。
    const voidRes = await page.request.post(`${API_BASE}/applications/${draftId}/void`, {
      data: { reason: "T17 草稿負向探針" },
    });
    expect(voidRes.status()).toBe(409);
    const voidBody = (await voidRes.json()) as {
      error: { code: string; details?: { status?: string } };
    };
    expect(voidBody.error.code).toBe("CONFLICT");
    expect(voidBody.error.details?.status).toBe("DRAFT");

    // 探針零寫入：草稿仍為 DRAFT。
    const getRes = await page.request.get(`${API_BASE}/applications/travel/${draftId}`);
    expect(getRes.status()).toBe(200);
    const getBody = (await getRes.json()) as { application: { status: string } };
    expect(getBody.application.status).toBe("DRAFT");

    await page.request.delete(`${API_BASE}/applications/${draftId}`).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // 測試 4（AC-34）：375px 三面零溢位
  // -------------------------------------------------------------------------
  test("AC-34: 375px——作廢確認對話框／作廢資訊區塊／已作廢列印版無水平溢位", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      timezoneId: "Asia/Taipei",
      locale: "zh-TW",
      viewport: { width: 375, height: 800 },
    });
    const page = await context.newPage();
    await loginAsStaff(page, staffLoginName);

    // 對話框量測需一筆**仍為 COMPLETED** 之申請（測試 1／2 已把兩筆作廢）。
    dialogAppId = await seedCompletedTravel(page, "375px 對話框量測");

    await test.step("作廢確認對話框（含長原因文字）", async () => {
      await page.goto(`${BASE}/applications/travel/${dialogAppId}`, { waitUntil: "load" });
      await page.getByRole("button", { name: "作廢", exact: true }).click();
      const dialog = page.locator(".dialog-overlay dialog.dialog-box");
      await expect(dialog).toBeVisible();
      // 內容可讀：標題與必填提示在場。
      await expect(dialog.locator("h3")).toHaveText("確認作廢申請");
      await expect(dialog.locator("label[for='void-reason']")).toHaveText("作廢原因");
      // 填入長原因（不換行之連續字元最易撐破容器）。
      await dialog.locator("#void-reason").fill("作廢原因壓力測試".repeat(12));
      const { scrollWidth, clientWidth } = await measureOverflow(page);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      // 取消：零狀態變更（本筆仍為已完成，供本檔重跑時之乾淨語意）。
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator("h1")).toHaveText("差旅補助申請（已完成）");
    });

    await test.step("作廢資訊區塊（已作廢詳情頁）", async () => {
      await page.goto(`${BASE}/applications/travel/${travelAppId}`, { waitUntil: "load" });
      const voidInfoSection = page.locator("section[aria-labelledby='void-info-heading']");
      await expect(voidInfoSection).toBeVisible({ timeout: 10000 });
      // 內容可讀：四列標籤皆在場（FW-3 標籤式，非索引式）。
      const fields = await readDetailList(voidInfoSection.locator("dl.detail-list"));
      expect(Object.keys(fields)).toEqual(["作廢原因", "作廢操作者", "作廢時間", "作廢當時金額"]);
      const { scrollWidth, clientWidth } = await measureOverflow(page);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    });

    await test.step("已作廢列印版（.void-banner）", async () => {
      await page.goto(`${API_BASE}/applications/${travelAppId}/report/print`, {
        waitUntil: "load",
      });
      const banner = page.locator(".void-banner");
      await expect(banner).toHaveCount(1);
      await expect(banner.locator(".void-banner-title")).toHaveText("已作廢");
      const { scrollWidth, clientWidth } = await measureOverflow(page);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      // FW-4：`.void-banner` 本身亦不得超出視埠寬度。
      const bannerBox = await banner.boundingBox();
      if (!bannerBox) throw new Error("E2E 量測失敗：.void-banner 無 bounding box");
      expect(bannerBox.x + bannerBox.width).toBeLessThanOrEqual(clientWidth + 1);
    });

    await context.close();
  });
});
