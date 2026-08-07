/**
 * E2E: 報表 Gate（三型端到端 ＋ 375px 響應式）— PHASE-008-T15
 * （Spec `docs/specs/PHASE-008.md` §2.I AC-35／AC-36、§12 :838~839 測試名）
 *
 * AC-35（:271 逐字）：「`e2e/report-pdf.spec.ts`：三型各一情境，完成申請 →
 * 產生報表 → 畫面顯示編號 → 開啟列印版（斷言關鍵值在場）→ 下載 PDF（斷言下
 * 載檔名與 `%PDF-` 開頭）→ 再次下載內容一致；另含「草稿無報表入口」之負向
 * 情境。」
 * AC-36（:273 逐字）：「列印版與三型詳情頁之報表區塊於 375px 無水平溢位
 * （`document.scrollWidth <= clientWidth`）。」
 *
 * ---------------------------------------------------------------------------
 * 三個測試（逐字對應 §12 :838~839 測試名）
 * ---------------------------------------------------------------------------
 *   1. `AC-35: 三型端到端（完成→產生→顯示編號→列印版→下載→重下一致）`——三型
 *      各以 `test.step` 涵蓋，供本次結果之單一測試名符合 §12 逐字要求。
 *   2. `AC-35: 草稿無報表入口（負向）`
 *   3. `AC-36: 列印版與三型詳情頁報表區塊於 375px 無水平溢位`——重用測試 1
 *      三型已產生之報表（serial 模式下先於本測試執行，見下）。
 *
 * ---------------------------------------------------------------------------
 * FW 核銷（Packet 逐項）
 * ---------------------------------------------------------------------------
 *   FW-1（播種）：三型皆以 API 直接播種（`page.request`），不經 UI 表單；折
 *     舊型別**不需**依賴任何差旅資料——`officialKm=0` 時 `annualTotalKm>0`
 *     即可計算（`0/annualTotalKm=0%`，`calculable=true`，見
 *     `depreciation-calculation.ts` 除零守門與 `depreciation-blockers.ts`
 *     第 5 碼僅在 `officialKm > annualTotalKm` 時觸發），故本檔折舊 fixture
 *     零額外差旅依賴（與 `depreciation-allowance.spec.ts` 之情境 1 不同、但
 *     不牴觸——彼檔為驗證 AC-59 之「非零 officialKm」情境，本檔僅需一筆可完
 *     成之折舊申請）。「產生報表」步驟仍以 UI 按鈕觸發（非 API），忠實走
 *     AC-35 之使用者流程字面。
 *   FW-2（時區決定性）：`test.use({ timezoneId: "Asia/Taipei", locale:
 *     "zh-TW" })`；`beforeAll`／`afterAll` 內另以 `browser.newContext()` 建
 *     立之管理員／清理 context 亦逐一傳入同組選項。
 *   FW-3（斷言用字）：報表編號逐字比對正則 `^{PREFIX}-\d{6}-\d{4,5}$`；不比
 *     對任何時間之 ISO 字面（本檔不斷言「產生時間」之顯示格式——該格式化
 *     邏輯已由 AC-30／AC-11 之單元／整合測試覆蓋，非本檔職責）。
 *   FW-4（GET→Success 再釘）：三型步驟內產生報表後 `page.reload()` 重讀詳情
 *     頁，斷言報表編號 dd 仍逐字相同。
 *   FW-5（真實 fetch）：全檔零 `page.route`／零 fetch stub；`page.request.*`
 *     為播種與後端直接探針之既有慣例（非攔截），cookie／credentials 走真實
 *     路徑。
 *   FW-6（375px 溢位候選）：AC-36 測試於「報表已產生（Success 態，dd 含兩
 *     `btn-sm` 並排 ＋ 完整報表編號）」之狀態下量測三型詳情頁報表區塊，非
 *     Empty 態。
 *   FW-7（下載）：`page.waitForEvent("download")` 配對點擊「下載 PDF」連
 *     結；`suggestedFilename()` 斷言安全檔名格式（型別標籤前綴 ＋ 含報表編
 *     號 ＋ `.pdf` 副檔名 ＋ 不含 `/`、`\`、CR、LF）；讀本地下載檔位元組斷言
 *     `%PDF-` 開頭；同一詳情頁再次點擊下載，兩次位元組以 `Buffer.compare`
 *     逐位元組比對。
 *   FW-8（列印版量測慣例）：AC-36 之列印版量測直連 `http://localhost:3000`
 *     （與 `report-print-layout.spec.ts` 同慣例）；AC-35 端到端流程之列印版
 *     步驟改為**真實點擊**「檢視列印版」連結（`target="_blank"`），驗證該
 *     連結本身確實可開啟且內容正確——經 Vite `/api` 代理導向 5173 origin，
 *     與 T14 之直連後端慣例不同型但互不牴觸（AC-35 之驗收語意是「點擊該連
 *     結」，非純量測寬度）。
 *
 * ---------------------------------------------------------------------------
 * 負向情境設計（AC-35「草稿無報表入口」）
 * ---------------------------------------------------------------------------
 * 前端層：草稿詳情頁之 `ReportSection`（`status !== "COMPLETED"`）回傳
 * `null`——斷言 `#report-heading` 不存在、「產生正式報表」文字不存在。
 * 後端層（AC-25 修訂後語意，Spec :241）：另以三端點直接探針佐證入口確實不
 * 可達——`POST .../report` → 409 CONFLICT + `details.status`；
 * `GET .../report/print` → 409 CONFLICT + `details.status`；
 * `GET .../report/pdf` → 404 NOT_FOUND（草稿與「已完成但未產生報表」之下載
 * 端點回應語意統一，Spec :241 逐字）。
 *
 * ---------------------------------------------------------------------------
 * Topology / Test account
 * ---------------------------------------------------------------------------
 * 大總管已啟動之 dev 拓撲（backend :3000、Vite :5173、`t1-pg`）；管理員帳號
 * 沿用既有 E2E 慣例（`e2eadmin`）；合成使用者以 `e2e-rptpdf-<random>` 命名。
 * 播種與斷言慣例沿 `report-print-layout.spec.ts`（PHASE-008-T14）／
 * `depreciation-allowance.spec.ts`（PHASE-007-R12）既有寫法（`readDetailList`
 * 之 dt/dd 對應 helper 逐字複用同一手法，見下）。
 */

import { readFile } from "node:fs/promises";
import { type Page, expect, test } from "@playwright/test";

const E2E_ADMIN = { loginName: "e2eadmin", password: "E2eAdmin@456!" };
const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";

// ---------------------------------------------------------------------------
// 日期／年度（動態相對值，避免寫死日曆日期隨系統時間推移而失效）
// ---------------------------------------------------------------------------
function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
const TRIP_DATE = isoDateDaysAgo(20);
const MAINT_LAST_DATE = isoDateDaysAgo(40);
const MAINT_CURRENT_DATE = isoDateDaysAgo(0);
const APPLICATION_YEAR = new Date().getUTCFullYear();
const PARAM_EFFECTIVE_FROM = "2020-06-01";
const FUEL_TYPE = "GASOLINE_92";
const FUEL_KM_PER_LITER = "10.0000";
const FUEL_PRICE_PER_LITER = "65.0000";
const ETC_UNIT_PRICE = 1.8;
const FUEL_BASIS_NOTE = "PHASE-008-T15 E2E 合成資料（報表 Gate E2E 播種用）";
const BASE_VEHICLE_PRICE = "600000";
const BASE_USEFUL_LIFE_YEARS = 5;
const ANNUAL_TOTAL_KM = "1000"; // FW-1：officialKm=0 亦可計算（0/1000=0%）。

// ---------------------------------------------------------------------------
// §7.2／report-number.ts：三型前綴（AC-02 已於單元測試覆蓋，本檔僅供格式斷言）
// ---------------------------------------------------------------------------
const REPORT_TYPE_LABEL: Record<"TRAVEL" | "MAINTENANCE" | "DEPRECIATION", string> = {
  TRAVEL: "差旅",
  MAINTENANCE: "保養",
  DEPRECIATION: "折舊",
};
const REPORT_PREFIX: Record<"TRAVEL" | "MAINTENANCE" | "DEPRECIATION", string> = {
  TRAVEL: "TRV",
  MAINTENANCE: "MNT",
  DEPRECIATION: "DEP",
};

// ---------------------------------------------------------------------------
// Auth / 播種 helpers（沿 report-print-layout.spec.ts／depreciation-
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
  const loginName = `e2e-rptpdf-${suffix}`;
  const displayName = `T15報表使用者${suffix}`;
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

async function ensureDepreciationCovers(page: Page, applicationYear: number): Promise<void> {
  const queryDateStr = `${applicationYear}-01-01`;
  const res = await page.request.get(`${API_BASE}/parameters/depreciation`);
  if (!res.ok()) throw new Error(`E2E 讀取折舊參數版本失敗: ${res.status()} ${await res.text()}`);
  const { versions } = (await res.json()) as { versions: { effectiveFrom: string }[] };
  if (versions.some((v) => v.effectiveFrom <= queryDateStr)) return;
  const createRes = await page.request.post(`${API_BASE}/parameters/depreciation`, {
    data: {
      vehiclePrice: BASE_VEHICLE_PRICE,
      usefulLifeYears: BASE_USEFUL_LIFE_YEARS,
      effectiveFrom: PARAM_EFFECTIVE_FROM,
    },
  });
  if (!createRes.ok())
    throw new Error(`E2E 設定基準折舊參數失敗: ${createRes.status()} ${await createRes.text()}`);
}

let staffPasswordAlreadyChanged = false;
const STAFF_TEMP_PASSWORD = "TempPw@2026Rpt!";
const STAFF_NEW_PASSWORD = "NewPw@2026Rpt!";

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
// 合成圖片（procedural；真實可解碼位元組）
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

// ---------------------------------------------------------------------------
// 三型完成申請播種（FW-1：純 API，不經 UI 表單；產生報表步驟留給各測試以
// UI 按鈕觸發，忠實走 AC-35 之使用者流程字面）
// ---------------------------------------------------------------------------

/** 播種一筆完成之差旅申請（1 段，1 張證明）。 */
async function seedTravelFixture(page: Page): Promise<string> {
  const createRes = await page.request.post(`${API_BASE}/applications/travel`, { data: {} });
  if (!createRes.ok()) throw new Error(`E2E 播種差旅建立失敗: ${createRes.status()}`);
  const { application } = (await createRes.json()) as { application: { id: string } };
  const tripId = application.id;

  const buf = await makeNoiseJpeg(600, 400, 0x1001);
  const attachmentId = await uploadAttachment(page, buf, "trip-photo.jpg", "image/jpeg");

  const putRes = await page.request.put(`${API_BASE}/applications/travel/${tripId}`, {
    data: {
      tripDate: TRIP_DATE,
      purpose: "PHASE-008-T15 E2E 端到端出差目的",
      segments: [
        {
          origin: "T15起點",
          destination: "T15終點",
          totalKm: "50.00",
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
async function seedMaintenanceFixture(page: Page): Promise<string> {
  const createRes = await page.request.post(`${API_BASE}/applications/maintenance`, { data: {} });
  if (!createRes.ok()) throw new Error(`E2E 播種保養建立失敗: ${createRes.status()}`);
  const { application } = (await createRes.json()) as { application: { id: string } };
  const maintId = application.id;

  const buf = await makeNoiseJpeg(600, 400, 0x2001);
  const attachmentId = await uploadAttachment(page, buf, "maint-photo.jpg", "image/jpeg");

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

/**
 * 播種一筆完成之年度折舊補貼申請（FW-1：零額外差旅依賴——`officialKm=0` 於
 * `annualTotalKm>0` 下仍 `calculable=true`，見檔頭說明）。
 */
async function seedDepreciationFixture(page: Page): Promise<string> {
  const createRes = await page.request.post(`${API_BASE}/applications/depreciation`, { data: {} });
  if (!createRes.ok()) throw new Error(`E2E 播種折舊建立失敗: ${createRes.status()}`);
  const { application } = (await createRes.json()) as { application: { id: string } };
  const depId = application.id;

  const putRes = await page.request.put(`${API_BASE}/applications/depreciation/${depId}`, {
    data: { applicationYear: APPLICATION_YEAR, annualTotalKm: ANNUAL_TOTAL_KM },
  });
  if (!putRes.ok())
    throw new Error(`E2E 播種折舊欄位設定失敗: ${putRes.status()} ${await putRes.text()}`);

  const completeRes = await page.request.post(`${API_BASE}/applications/${depId}/complete`);
  if (!completeRes.ok())
    throw new Error(`E2E 播種折舊完成失敗: ${completeRes.status()} ${await completeRes.text()}`);

  return depId;
}

// ---------------------------------------------------------------------------
// 讀取 helpers（沿 depreciation-allowance.spec.ts 既有慣例：dt/dd 依序對應）
// ---------------------------------------------------------------------------

async function readDetailList(scope: ReturnType<Page["locator"]>): Promise<Record<string, string>> {
  const dts = await scope.locator("dt").allTextContents();
  const dds = await scope.locator("dd").allTextContents();
  const result: Record<string, string> = {};
  dts.forEach((k, i) => {
    result[k] = dds[i] ?? "";
  });
  return result;
}

/** 列印版 `.field-label`／`.field-value` 依序對應（`report-html.ts` `field()`）。 */
async function readPrintFields(page: Page): Promise<Record<string, string>> {
  const labels = await page.locator(".field-label").allTextContents();
  const values = await page.locator(".field-value").allTextContents();
  const result: Record<string, string> = {};
  labels.forEach((k, i) => {
    result[k] = values[i] ?? "";
  });
  return result;
}

async function measureOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

// ---------------------------------------------------------------------------
// AC-35 主流程：三型各一 test.step（FW-4：GET→Success 再釘／FW-7：下載＋
// 重下一致／FW-8：真實點擊「檢視列印版」）
// ---------------------------------------------------------------------------

async function exerciseReportEndToEnd(
  page: Page,
  detailPath: string,
  type: "TRAVEL" | "MAINTENANCE" | "DEPRECIATION"
): Promise<string> {
  const typeLabel = REPORT_TYPE_LABEL[type];
  const prefix = REPORT_PREFIX[type];

  await page.goto(`${BASE}${detailPath}`, { waitUntil: "load" });
  await page.waitForURL(`${BASE}${detailPath}`);

  const reportSection = page.locator("section[aria-labelledby='report-heading']");
  await expect(reportSection.locator("#report-heading")).toHaveText("報表");

  // Empty 態：產生按鈕在場（尚未產生）。
  await expect(reportSection.getByText("尚未產生正式報表")).toBeVisible({ timeout: 10000 });
  const generateBtn = reportSection.getByRole("button", { name: "產生正式報表" });
  await expect(generateBtn).toBeVisible();
  await generateBtn.click();

  // 畫面顯示編號。
  const reportDl = reportSection.locator("dl.detail-list");
  await expect(reportDl).toBeVisible({ timeout: 15000 });
  const fields = await readDetailList(reportDl);
  const reportNumber = fields.報表編號;
  expect(reportNumber).toMatch(new RegExp(`^${prefix}-\\d{6}-\\d{4,5}$`));

  // FW-4：GET→Success 再釘——reload 詳情頁後編號仍逐字在場。
  await page.reload({ waitUntil: "load" });
  const reportDlAfterReload = reportSection.locator("dl.detail-list");
  await expect(reportDlAfterReload).toBeVisible({ timeout: 10000 });
  const fieldsAfterReload = await readDetailList(reportDlAfterReload);
  expect(fieldsAfterReload.報表編號).toBe(reportNumber);

  // 開啟列印版（真實點擊 target="_blank" 連結；斷言關鍵值在場）。
  const [printPage] = await Promise.all([
    page.context().waitForEvent("page"),
    reportSection.getByRole("link", { name: "檢視列印版" }).click(),
  ]);
  await printPage.waitForLoadState("load");
  await expect(printPage.locator("h1")).toHaveText(`${typeLabel}報表`);
  const printFields = await readPrintFields(printPage);
  expect(printFields.報表編號).toBe(reportNumber);
  await printPage.close();

  // 下載 PDF：檔名安全格式（含編號）＋ %PDF- 開頭。
  const [download1] = await Promise.all([
    page.waitForEvent("download"),
    reportSection.getByRole("link", { name: "下載 PDF" }).click(),
  ]);
  const filename1 = download1.suggestedFilename();
  expect(filename1.startsWith(`${typeLabel}_`)).toBe(true);
  expect(filename1.endsWith(".pdf")).toBe(true);
  expect(filename1).toContain(reportNumber);
  expect(filename1).not.toMatch(/[\\/\r\n]/);
  const path1 = await download1.path();
  if (!path1) throw new Error("E2E 下載失敗：Playwright 未回傳本地檔案路徑");
  const bytes1 = await readFile(path1);
  expect(bytes1.subarray(0, 5).toString("latin1")).toBe("%PDF-");

  // 再次下載：內容逐位元組一致。
  const [download2] = await Promise.all([
    page.waitForEvent("download"),
    reportSection.getByRole("link", { name: "下載 PDF" }).click(),
  ]);
  const path2 = await download2.path();
  if (!path2) throw new Error("E2E 重下失敗：Playwright 未回傳本地檔案路徑");
  const bytes2 = await readFile(path2);
  expect(Buffer.compare(bytes1, bytes2)).toBe(0);

  return reportNumber;
}

// ---------------------------------------------------------------------------
// 共用播種狀態（beforeAll 播種三型完成申請一次；測試 1 產生報表後之
// applicationId 供測試 3〔AC-36〕重用同一批已產生報表之申請）
// ---------------------------------------------------------------------------

let staffUserId: string;
let staffLoginName: string;
let travelAppId: string;
let maintAppId: string;
let depAppId: string;

test.describe("報表 Gate — PHASE-008-T15（AC-35／AC-36）", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ timezoneId: "Asia/Taipei", locale: "zh-TW" });

  test.beforeAll(async ({ browser }) => {
    const adminContext = await browser.newContext({
      timezoneId: "Asia/Taipei",
      locale: "zh-TW",
    });
    const adminPage = await adminContext.newPage();
    await loginAsAdmin(adminPage);

    const staff = await createSyntheticUser(adminPage, STAFF_TEMP_PASSWORD);
    staffUserId = staff.id;
    staffLoginName = staff.loginName;

    await ensureFuelPriceCovers(adminPage, FUEL_TYPE, TRIP_DATE);
    await ensureEtcCovers(adminPage, TRIP_DATE);
    await ensureFuelConsumptionCovers(adminPage, staffUserId, TRIP_DATE);
    await ensureDepreciationCovers(adminPage, APPLICATION_YEAR);
    await adminContext.close();

    const staffContext = await browser.newContext({
      timezoneId: "Asia/Taipei",
      locale: "zh-TW",
    });
    const staffPage = await staffContext.newPage();
    await loginAsStaff(staffPage, staffLoginName);

    travelAppId = await seedTravelFixture(staffPage);
    maintAppId = await seedMaintenanceFixture(staffPage);
    depAppId = await seedDepreciationFixture(staffPage);

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

  // ---------------------------------------------------------------------------
  // AC-35: 三型端到端
  // ---------------------------------------------------------------------------
  test("AC-35: 三型端到端（完成→產生→顯示編號→列印版→下載→重下一致）", async ({ page }) => {
    await loginAsStaff(page, staffLoginName);

    await test.step("差旅", async () => {
      await exerciseReportEndToEnd(page, `/applications/travel/${travelAppId}`, "TRAVEL");
    });

    await test.step("保養", async () => {
      await exerciseReportEndToEnd(page, `/applications/maintenance/${maintAppId}`, "MAINTENANCE");
    });

    await test.step("折舊", async () => {
      await exerciseReportEndToEnd(page, `/applications/depreciation/${depAppId}`, "DEPRECIATION");
    });
  });

  // ---------------------------------------------------------------------------
  // AC-35: 草稿無報表入口（負向）
  // ---------------------------------------------------------------------------
  test("AC-35: 草稿無報表入口（負向）", async ({ page }) => {
    await loginAsStaff(page, staffLoginName);

    const createRes = await page.request.post(`${API_BASE}/applications/travel`, { data: {} });
    if (!createRes.ok()) throw new Error(`E2E 播種草稿失敗: ${createRes.status()}`);
    const { application } = (await createRes.json()) as { application: { id: string } };
    const draftId = application.id;

    // 前端層：整個報表區塊不渲染。
    await page.goto(`${BASE}/applications/travel/${draftId}`, { waitUntil: "load" });
    await page.waitForURL(`${BASE}/applications/travel/${draftId}`);
    await expect(page.locator("#report-heading")).toHaveCount(0);
    await expect(page.getByText("產生正式報表")).toHaveCount(0);

    // 後端層（AC-25 修訂後語意，Spec :241）：三端點直接探針。
    const generateRes = await page.request.post(`${API_BASE}/applications/${draftId}/report`);
    expect(generateRes.status()).toBe(409);
    const generateBody = (await generateRes.json()) as {
      error: { code: string; details?: { status?: string } };
    };
    expect(generateBody.error.code).toBe("CONFLICT");
    expect(generateBody.error.details?.status).toBe("DRAFT");

    const printRes = await page.request.get(`${API_BASE}/applications/${draftId}/report/print`);
    expect(printRes.status()).toBe(409);
    const printBody = (await printRes.json()) as {
      error: { code: string; details?: { status?: string } };
    };
    expect(printBody.error.code).toBe("CONFLICT");
    expect(printBody.error.details?.status).toBe("DRAFT");

    const pdfRes = await page.request.get(`${API_BASE}/applications/${draftId}/report/pdf`);
    expect(pdfRes.status()).toBe(404);
    const pdfBody = (await pdfRes.json()) as { error: { code: string } };
    expect(pdfBody.error.code).toBe("NOT_FOUND");

    await page.request.delete(`${API_BASE}/applications/${draftId}`).catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // AC-36: 375px 無水平溢位（重用測試 1 已產生報表之三型申請）
  // ---------------------------------------------------------------------------
  test("AC-36: 列印版與三型詳情頁報表區塊於 375px 無水平溢位", async ({ browser }) => {
    const context = await browser.newContext({
      timezoneId: "Asia/Taipei",
      locale: "zh-TW",
      viewport: { width: 375, height: 800 },
    });
    const page = await context.newPage();
    await loginAsStaff(page, staffLoginName);

    const surfaces: {
      label: string;
      detailPath: string;
      printPath: string;
    }[] = [
      {
        label: "差旅",
        detailPath: `/applications/travel/${travelAppId}`,
        printPath: `/applications/${travelAppId}/report/print`,
      },
      {
        label: "保養",
        detailPath: `/applications/maintenance/${maintAppId}`,
        printPath: `/applications/${maintAppId}/report/print`,
      },
      {
        label: "折舊",
        detailPath: `/applications/depreciation/${depAppId}`,
        printPath: `/applications/${depAppId}/report/print`,
      },
    ];

    for (const surface of surfaces) {
      await test.step(`${surface.label}：詳情頁報表區塊（Success 態）`, async () => {
        await page.goto(`${BASE}${surface.detailPath}`, { waitUntil: "load" });
        await page.waitForURL(`${BASE}${surface.detailPath}`);
        const reportSection = page.locator("section[aria-labelledby='report-heading']");
        await expect(reportSection.locator("dl.detail-list")).toBeVisible({ timeout: 10000 });
        const { scrollWidth, clientWidth } = await measureOverflow(page);
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      });

      await test.step(`${surface.label}：列印版（FW-8 直連後端）`, async () => {
        await page.goto(`${API_BASE}${surface.printPath}`, { waitUntil: "load" });
        const { scrollWidth, clientWidth } = await measureOverflow(page);
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      });
    }

    await context.close();
  });
});
