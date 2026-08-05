/**
 * E2E: 年度折舊補貼（新模型）— PHASE-007-R12 Gate E2E
 * （取代 T16 舊模型版本；Spec §20.12 R12 列、§20.3 AC-45/46/47/48/52/53/58/59/60/61）
 *
 * 涵蓋（Packet 六情境對應）：
 *   - 情境1（①）：完整走流程——播種一筆年度內已完成差旅 → 建立折舊草稿 →
 *     選年度 → 輸入該車年度總里程 → 儲存草稿 → 預覽出現五值 → **不上傳證明**
 *     即完成 → 詳情快照五值與預覽一致（AC-59(a)(b) 零自算鑑別）。
 *   - 情境2（②）：年度總里程小於年度公務里程（比例>100%）→ 預覽顯示錯誤
 *     （`error-block`／`role="alert"`）＋固定文案；儲存後完成鈕停用
 *     （AC-52／AC-60）。
 *   - 情境3（③）：未輸入年度總里程 → 預覽不顯示金額 0，顯示「請輸入該車
 *     年度總里程」；儲存後完成鈕停用（AC-53(a)(d)）。
 *   - 情境4（④）：管理員新增折舊參數版本後，已完成申請之快照五值（逐字）
 *     不受影響——讀 COMPLETED 快照區，非草稿預覽區（AC-49、FW-7 沿舊版教訓）。
 *   - 情境5：已完成之折舊申請不可修改（403，不可變性回歸，沿 AC-04 既有語意）。
 *   - 情境6：列表出現已完成折舊列且金額一致（AC-45）。
 *   - 情境7（⑤）：管理員參數頁「折舊參數」區塊縮欄——建立表單僅三個可輸入
 *     欄位（車價／折舊年限／生效日期，`estimatedAnnualKm` 已退場）；新版本
 *     歷史列之「預估年里程」／「每公里單價」唯讀顯示「—」（AC-57/AC-61）。
 *   - 情境8（⑥）：375px 無水平溢位——折舊表單／預覽／證明（同一草稿頁）、
 *     列表頁、已完成詳情頁、管理員參數頁，共四類畫面（AC-46）。
 *
 * FW-4（新模型播種順序，取代 T16 舊 FW-4——證明改為選填，AC-54(b)）：
 * 選年度 → 輸入年度總里程 → 儲存草稿（等待「草稿已儲存。」出現）→ 完成，
 * **中途不上傳任何證明**——這正是本次「不上傳證明即完成」之必測反轉。上傳
 * 附件本身仍會令表單 dirty（`DepreciationApplicationPage.tsx` 之
 * `updateAttachments` 明文）；本檔情境1刻意全程不觸碰上傳，避免落入舊版
 * 「上傳後完成鈕鎖定」陷阱（該教訓已隨附件選填化而與本檔情境1路徑無涉，
 * 附件相關之 dirty-lock 行為仍由 MaintenanceApplicationPage／006 型 E2E
 * 覆蓋，非本檔職責）。
 *
 * FW-5（預覽 300ms debounce）：一律以「新模型五值文字出現」為 wait 條件
 * （Playwright `expect(...).toHaveText` 之輪詢重試天然涵蓋 debounce 等待），
 * 不使用固定 `waitForTimeout` 睡眠。
 *
 * FW-7（AC-49 之「不變」斷言）：管理員改參數後之「不變」斷言一律讀
 * COMPLETED 詳情頁的快照區（`section[aria-labelledby='snapshot-heading']`），
 * 不讀草稿預覽區（草稿預覽為即時計算、本就會反映新參數，讀錯區塊會讓本
 * 斷言恆真通過而失去意義）。
 *
 * 播種冪等（沿 PHASE-005a T13R／006 AR-4 教訓）：
 *   - 合成使用者以隨機後綴建立（每次執行皆為全新使用者），故 `officialKm`
 *     恆為本次播種之單筆差旅里程，不受其他次 E2E 執行殘留資料影響。
 *   - 折舊參數版本無 DELETE 端點，故「基準版本」一律「先查後建」（僅在
 *     `applicationYear`-01-01 尚無任何覆蓋版本時才建立）。
 *   - 情境4（FW-7 改參數）與情境7（縮欄查核）刻意每次執行皆新增一個版本，
 *     `effectiveFrom` 一律取「確定性推導」（詳見各自 helper 檔頭），不依賴
 *     時間戳/隨機數巧合造成之假性失敗。
 *
 * Topology / Test account：backend :3000（tsx watch）+ Vite :5173（`npm run
 * dev`）+ 既有 dev DB（`t1-pg` 容器，
 * `postgresql://testuser:test@localhost:55432/app_test`，與其餘既有 e2e 檔
 * 共用之同一 dev 拓撲）；管理員帳號沿用既有 E2E 慣例（e2eadmin）；合成折舊
 * 使用者以 `e2e-depr-<random>` 命名。最終證據輪由大總管親跑於 dev 拓撲
 * （Packet Done When 明文）。
 */

import { type Page, expect, test } from "@playwright/test";

const E2E_ADMIN = { loginName: "e2eadmin", password: "E2eAdmin@456!" };
const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";

// ---------------------------------------------------------------------------
// 動態相對日期／年度（避免寫死日曆日期隨系統時間推移而失效——同
// travel-application.spec.ts SUCCESS_TRIP_DATE 之既有教訓）。
// ---------------------------------------------------------------------------
function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
const TRIP_DATE = isoDateDaysAgo(30);
const APPLICATION_YEAR = Number(TRIP_DATE.slice(0, 4));
const TRIP_TOTAL_KM = "300.00";
const TRIP_HIGHWAY_KM = "250.00";
const EXPECTED_OFFICIAL_KM = "300.00"; // 全新合成使用者，該年度僅此一筆已完成差旅

// 情境1（正常流程）年度總里程——大於 officialKm（300），比例 <100%。
const ANNUAL_TOTAL_KM_NORMAL = "1200";
// 情境2（比例>100%）年度總里程——小於 officialKm（300）。
const ANNUAL_TOTAL_KM_EXCEEDS = "50";

// 基準折舊參數版本（僅在 APPLICATION_YEAR-01-01 尚無覆蓋版本時才建立，先查後建）。
// PHASE-007-R4b：建立端點已縮欄為三個可輸入欄位，`estimatedAnnualKm` 不再傳送。
const BASE_PARAM_EFFECTIVE_FROM = "2020-06-01";
const BASE_VEHICLE_PRICE = "600000";
const BASE_USEFUL_LIFE_YEARS = 5;

// 播種差旅完成所需之其餘全域參數（油價／ETC／油耗，同 maintenance-allowance.spec.ts
// 既有理由：完成差旅需可計算金額，三者缺一即 409 PARAMETER_NOT_AVAILABLE）。
const FUEL_TYPE = "GASOLINE_92";
const FUEL_KM_PER_LITER = "10.0000";
const FUEL_PRICE_PER_LITER = "65.0000";
const ETC_UNIT_PRICE = 1.8;
const FUEL_BASIS_NOTE = "PHASE-007-R12 E2E 合成資料（折舊 Gate E2E 播種用）";

/** `YYYY-MM-DD` 字串 + 1 天（UTC 日粒度，同 depreciationYearRange 之既有慣例）。 */
function addOneDayUtc(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * FW-7 情境4用：由「當次基準每年折舊費用（2dp 字串）」反推一個保證推導出
 * `baseline + 1000.00` 之車價（分為單位之整數運算，避免浮點誤差），確保
 * 「新草稿即時預覽之每年折舊費用確實已變」這條控制組斷言恆為真——不依賴
 * 任何隨機/時間戳巧合（同 T16 舊版 `updatedVehiclePriceDifferentFrom` 之
 * 教訓：新舊值需嚴格不同，且新版本必須是選版邏輯之最新中選者）。
 * `annualDepreciation = vehiclePrice / usefulLifeYears`（未取整前之精確值，
 * `deriveAnnualDepreciation` 之定義），故 `vehiclePrice = annualDepreciation
 * × usefulLifeYears` 反推後之取整前精確值恰為 `baseline + 1000.00`。
 */
function updatedVehiclePriceDifferentFrom(baselineAnnualDepreciation: string): string {
  const baselineCents = Math.round(Number(baselineAnnualDepreciation) * 100);
  const newCents = baselineCents + 100000; // +1000.00，保證與基準不同
  const newVehiclePrice = (newCents * BASE_USEFUL_LIFE_YEARS) / 100;
  return newVehiclePrice.toFixed(2);
}

const DEPRECIATION_PROOF_FILENAME = "depreciation-proof.jpg";

// ---------------------------------------------------------------------------
// Helpers（沿 maintenance-allowance.spec.ts / fuel-model.spec.ts 既有模式）
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
  const loginName = `e2e-depr-${suffix}`;
  const displayName = `R12折舊使用者${suffix}`;
  const res = await page.request.post(`${API_BASE}/admin/users`, {
    data: { loginName, displayName, temporaryPassword: tempPassword },
  });
  if (!res.ok()) {
    throw new Error(`E2E 建立合成使用者失敗: ${res.status()} ${await res.text()}`);
  }
  const { user } = (await res.json()) as { user: { id: string } };
  return { id: user.id, loginName };
}

/** 先查後建：確保折舊參數覆蓋 `該年 1/1`（管理員權限）。僅在查無任何覆蓋版本時才建立。 */
async function ensureDepreciationCovers(page: Page, applicationYear: number): Promise<void> {
  const queryDateStr = `${applicationYear}-01-01`;
  const res = await page.request.get(`${API_BASE}/parameters/depreciation`);
  if (!res.ok()) {
    throw new Error(`E2E 讀取折舊參數版本失敗: ${res.status()} ${await res.text()}`);
  }
  const { versions } = (await res.json()) as { versions: { effectiveFrom: string }[] };
  if (versions.some((v) => v.effectiveFrom <= queryDateStr)) return;
  const createRes = await page.request.post(`${API_BASE}/parameters/depreciation`, {
    data: {
      vehiclePrice: BASE_VEHICLE_PRICE,
      usefulLifeYears: BASE_USEFUL_LIFE_YEARS,
      effectiveFrom: BASE_PARAM_EFFECTIVE_FROM,
    },
  });
  if (!createRes.ok()) {
    throw new Error(`E2E 設定基準折舊參數失敗: ${createRes.status()} ${await createRes.text()}`);
  }
}

/** 先查後建：確保 `fuelType` 之油價版本覆蓋 `dateStr`（管理員權限）。 */
async function ensureFuelPriceCovers(page: Page, fuelType: string, dateStr: string): Promise<void> {
  const res = await page.request.get(`${API_BASE}/parameters/fuel-price?fuelType=${fuelType}`);
  if (!res.ok()) {
    throw new Error(`E2E 讀取油價版本失敗: ${res.status()} ${await res.text()}`);
  }
  const { versions } = (await res.json()) as { versions: { effectiveFrom: string }[] };
  if (versions.some((v) => v.effectiveFrom <= dateStr)) return;
  const createRes = await page.request.post(`${API_BASE}/parameters/fuel-price`, {
    data: {
      fuelType,
      pricePerLiter: FUEL_PRICE_PER_LITER,
      effectiveFrom: BASE_PARAM_EFFECTIVE_FROM,
    },
  });
  if (!createRes.ok()) {
    throw new Error(`E2E 設定油價版本失敗: ${createRes.status()} ${await createRes.text()}`);
  }
}

/** 先查後建：確保 ETC 補助參數覆蓋 `dateStr`（管理員權限）。 */
async function ensureEtcCovers(page: Page, dateStr: string): Promise<void> {
  const res = await page.request.get(`${API_BASE}/parameters/etc`);
  if (!res.ok()) {
    throw new Error(`E2E 讀取 ETC 參數失敗: ${res.status()} ${await res.text()}`);
  }
  const { versions } = (await res.json()) as { versions: { effectiveFrom: string }[] };
  if (versions.some((v) => v.effectiveFrom <= dateStr)) return;
  const createRes = await page.request.post(`${API_BASE}/parameters/etc`, {
    data: { unitPrice: ETC_UNIT_PRICE, effectiveFrom: BASE_PARAM_EFFECTIVE_FROM },
  });
  if (!createRes.ok()) {
    throw new Error(`E2E 設定 ETC 參數失敗: ${createRes.status()} ${await createRes.text()}`);
  }
}

/** 為指定使用者建立油耗版本（合成使用者為全新帳號，先查應恆為空，仍先查後建以防萬一）。 */
async function ensureFuelConsumptionCovers(
  page: Page,
  userId: string,
  dateStr: string
): Promise<void> {
  const res = await page.request.get(`${API_BASE}/users/${userId}/fuel-consumption`);
  if (!res.ok()) {
    throw new Error(`E2E 讀取油耗版本失敗: ${res.status()} ${await res.text()}`);
  }
  const { versions } = (await res.json()) as { versions: { effectiveFrom: string }[] };
  if (versions.some((v) => v.effectiveFrom <= dateStr)) return;
  const createRes = await page.request.post(`${API_BASE}/users/${userId}/fuel-consumption`, {
    data: {
      fuelType: FUEL_TYPE,
      kmPerLiter: FUEL_KM_PER_LITER,
      effectiveFrom: BASE_PARAM_EFFECTIVE_FROM,
      basisNote: FUEL_BASIS_NOTE,
    },
  });
  if (!createRes.ok()) {
    throw new Error(`E2E 設定油耗版本失敗: ${createRes.status()} ${await createRes.text()}`);
  }
}

/**
 * FW-7 情境4用：新增一個「更新」折舊參數版本。`effectiveFrom` 一律取「現有
 * 全部覆蓋 `APPLICATION_YEAR-01-01` 之版本中最大 `effectiveFrom` 之次日」——
 * **嚴格遞增**，保證此新版本必為 `findEffectiveVersion` 之新選中版本。
 */
async function createUpdatedDepreciationVersion(
  page: Page,
  baselineAnnualDepreciation: string
): Promise<void> {
  const boundary = `${APPLICATION_YEAR}-01-01`;
  const listRes = await page.request.get(`${API_BASE}/parameters/depreciation`);
  if (!listRes.ok()) {
    throw new Error(`E2E 讀取折舊參數版本失敗: ${listRes.status()} ${await listRes.text()}`);
  }
  const { versions } = (await listRes.json()) as { versions: { effectiveFrom: string }[] };
  const covering = versions.filter((v) => v.effectiveFrom <= boundary);
  const maxEffectiveFrom = covering.reduce(
    (max, v) => (v.effectiveFrom > max ? v.effectiveFrom : max),
    BASE_PARAM_EFFECTIVE_FROM
  );
  const nextEffectiveFrom = addOneDayUtc(maxEffectiveFrom);
  const effectiveFrom = nextEffectiveFrom <= boundary ? nextEffectiveFrom : boundary;

  const res = await page.request.post(`${API_BASE}/parameters/depreciation`, {
    data: {
      vehiclePrice: updatedVehiclePriceDifferentFrom(baselineAnnualDepreciation),
      usefulLifeYears: BASE_USEFUL_LIFE_YEARS,
      effectiveFrom,
    },
  });
  if (!res.ok()) {
    throw new Error(`E2E 設定更新折舊參數失敗: ${res.status()} ${await res.text()}`);
  }
}

/**
 * staffPassword 一次性狀態轉移（同 maintenance-allowance.spec.ts 既有教訓：
 * 合成使用者跨 it 共用同一真實帳號，第二次呼叫時原本的臨時密碼已失效）。
 */
let staffPasswordAlreadyChanged = false;
const STAFF_TEMP_PASSWORD = "TempPw@2026Depr!";
const STAFF_NEW_PASSWORD = "NewPw@2026Depr!";

async function loginAsStaff(page: Page, loginName: string): Promise<void> {
  if (staffPasswordAlreadyChanged) {
    const res = await page.request.post(`${API_BASE}/auth/login`, {
      data: { loginName, password: STAFF_NEW_PASSWORD },
    });
    if (!res.ok()) {
      throw new Error(`E2E 合成折舊使用者登入失敗: ${res.status()} ${await res.text()}`);
    }
    return;
  }
  const loginRes = await page.request.post(`${API_BASE}/auth/login`, {
    data: { loginName, password: STAFF_TEMP_PASSWORD },
  });
  if (!loginRes.ok()) {
    throw new Error(
      `E2E 合成折舊使用者首次登入失敗: ${loginRes.status()} ${await loginRes.text()}`
    );
  }
  const changeRes = await page.request.post(`${API_BASE}/me/password`, {
    data: { currentPassword: STAFF_TEMP_PASSWORD, newPassword: STAFF_NEW_PASSWORD },
  });
  if (!changeRes.ok()) {
    throw new Error(
      `E2E 合成折舊使用者強制改密失敗: ${changeRes.status()} ${await changeRes.text()}`
    );
  }
  staffPasswordAlreadyChanged = true;
}

/**
 * 播種：以 API 建立並完成一筆單段差旅（`TRIP_TOTAL_KM`），落在
 * `APPLICATION_YEAR` 年度區間內——非本測試之驗證標的，純粹作為年度公務
 * 里程之播種資料，故以 API 直接建立而非走差旅 UI（同 maintenance-allowance.spec.ts
 * 既有理由）。呼叫端須已以合成使用者身分登入（`page` cookie）。
 */
async function seedCompletedTravel(page: Page): Promise<void> {
  const createRes = await page.request.post(`${API_BASE}/applications/travel`, { data: {} });
  if (!createRes.ok()) {
    throw new Error(`E2E 播種差旅建立失敗: ${createRes.status()} ${await createRes.text()}`);
  }
  const { application } = (await createRes.json()) as { application: { id: string } };
  const tripId = application.id;

  const uploadRes = await page.request.post(`${API_BASE}/attachments`, {
    multipart: {
      file: {
        name: "seed-trip-photo.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from([
          0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
          0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
        ]),
      },
    },
  });
  if (!uploadRes.ok()) {
    throw new Error(`E2E 播種差旅截圖上傳失敗: ${uploadRes.status()} ${await uploadRes.text()}`);
  }
  const { attachment } = (await uploadRes.json()) as { attachment: { id: string } };

  const putRes = await page.request.put(`${API_BASE}/applications/travel/${tripId}`, {
    data: {
      tripDate: TRIP_DATE,
      purpose: "PHASE-007-R12 折舊 Gate E2E 播種差旅",
      segments: [
        {
          origin: "台北總公司",
          destination: "台中辦事處",
          totalKm: TRIP_TOTAL_KM,
          highwayKm: TRIP_HIGHWAY_KM,
          attachmentIds: [attachment.id],
        },
      ],
    },
  });
  if (!putRes.ok()) {
    throw new Error(`E2E 播種差旅段落設定失敗: ${putRes.status()} ${await putRes.text()}`);
  }

  const completeRes = await page.request.post(`${API_BASE}/applications/${tripId}/complete`);
  if (!completeRes.ok()) {
    throw new Error(`E2E 播種差旅完成失敗: ${completeRes.status()} ${await completeRes.text()}`);
  }
}

/** `<dl class="detail-list">` 內 `dt`/`dd` 依序配對讀出（同 maintenance-allowance.spec.ts 既有慣例）。 */
async function readDetailList(scope: ReturnType<Page["locator"]>): Promise<Record<string, string>> {
  const dts = await scope.locator("dt").allTextContents();
  const dds = await scope.locator("dd").allTextContents();
  const result: Record<string, string> = {};
  dts.forEach((k, i) => {
    result[k] = dds[i] ?? "";
  });
  return result;
}

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.body.scrollWidth > window.innerWidth);
}

/** 建立一筆新草稿並導向其編輯頁（同 HomePage「新增年度折舊補貼申請」入口）。回傳草稿 id。 */
async function createDraftViaUi(page: Page): Promise<string> {
  await page.goto(`${BASE}/`);
  await page.waitForURL(`${BASE}/`);
  await page.click('a:has-text("新增年度折舊補貼申請")');
  await page.waitForURL(/\/applications\/depreciation\/(?!new)[^/]+$/, { timeout: 15000 });
  await expect(page.locator("h1")).toContainText("年度折舊補貼申請（草稿）");
  const url = new URL(page.url());
  return url.pathname.split("/").pop() as string;
}

// ---------------------------------------------------------------------------
// 模組層共用狀態（多 it 依序累積同一筆折舊草稿之前置狀態）
// ---------------------------------------------------------------------------
let staffUserId: string;
let staffLoginName: string;
let depreciationApplicationId: string;
let baselineFive: {
  annualDepreciation: string;
  officialKm: string;
  annualTotalKm: string;
  ratioPercent: string;
  amount: string;
};

test.describe("年度折舊補貼（新模型）— PHASE-007-R12 Gate E2E", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await loginAsAdmin(adminPage);

    const staff = await createSyntheticUser(adminPage, STAFF_TEMP_PASSWORD);
    staffUserId = staff.id;
    staffLoginName = staff.loginName;

    await ensureDepreciationCovers(adminPage, APPLICATION_YEAR);
    await ensureFuelPriceCovers(adminPage, FUEL_TYPE, TRIP_DATE);
    await ensureEtcCovers(adminPage, TRIP_DATE);
    await ensureFuelConsumptionCovers(adminPage, staffUserId, TRIP_DATE);

    await adminContext.close();
  });

  test.afterAll(async ({ browser }) => {
    // Best-effort：合成使用者一旦完成過差旅/折舊申請即恆有申請歷史，刪除會
    // 409（既有不可逆業務規則，同 maintenance-allowance.spec.ts 既有 cleanup 註解）。
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsAdmin(page);
    if (staffUserId) {
      await page.request.delete(`${API_BASE}/admin/users/${staffUserId}`).catch(() => {});
    }
    await context.close();
  });

  // -------------------------------------------------------------------------
  // 情境1（Packet ①）：完整走流程——播種差旅 → 建立草稿 → 選年度＋輸入年度
  // 總里程 → 儲存草稿 → 預覽五值 → 不上傳證明即完成 → 快照五值一致。
  // -------------------------------------------------------------------------
  test("情境1：完整走新模型流程——輸入年度總里程、不上傳證明即完成、快照五值一致", async ({
    page,
  }) => {
    await loginAsStaff(page, staffLoginName);
    await seedCompletedTravel(page);

    depreciationApplicationId = await createDraftViaUi(page);

    await page.fill("#application-year", String(APPLICATION_YEAR));
    await page.fill("#annual-total-km", ANNUAL_TOTAL_KM_NORMAL);
    await page.click('button:has-text("儲存草稿")');
    await expect(page.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });

    // FW-5：以「五值」文字出現為 wait 條件（涵蓋 D8 300ms debounce）。
    const previewSection = page.locator("section[aria-labelledby='preview-heading']");
    await expect(previewSection.locator("dl.detail-list dt").nth(0)).toHaveText("每年折舊費用", {
      timeout: 10000,
    });
    await expect(previewSection.locator("dt")).toHaveCount(5);
    const preview = await readDetailList(previewSection);
    expect(preview.每年折舊費用).toMatch(/^\d+\.\d{2}$/);
    expect(preview.年度公務里程).toBe(`${EXPECTED_OFFICIAL_KM} 公里`);
    expect(preview.年度總里程).toMatch(/^\d+\.\d 公里$/);
    expect(preview.公務比例).toMatch(/^\d+(\.\d{4})?%$/);
    expect(preview.年度補貼金額).toMatch(/^\d+$/);

    // AC-58 負向斷言：年度公務里程無任何可輸入／覆寫欄位。
    expect(await page.locator("#official-km").count()).toBe(0);

    // 完成鈕未被停用（無 blocker）。
    const completeBtn = page.getByRole("button", { name: "完成申請" });
    await expect(completeBtn).toBeEnabled();

    // ★ 關鍵反轉：全程未觸碰「選擇圖片」/上傳流程，直接完成。
    await completeBtn.click();
    const confirmDialog = page.getByRole("dialog", { name: "確認完成申請" });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.locator('button:has-text("確認完成")').click();

    await expect(page.locator("h1")).toContainText("年度折舊補貼申請（已完成）", {
      timeout: 10000,
    });

    const snapshotSection = page.locator("section[aria-labelledby='snapshot-heading']");
    await expect(snapshotSection).toBeVisible();
    const snapshot = await readDetailList(snapshotSection);
    expect(snapshot.每年折舊費用).toBe(preview.每年折舊費用);
    expect(snapshot.年度公務里程).toBe(preview.年度公務里程);
    expect(snapshot.年度總里程).toBe(preview.年度總里程);
    expect(snapshot.公務比例).toBe(preview.公務比例);
    expect(snapshot["年度補貼金額（四捨五入後，實際核發）"]).toBe(preview.年度補貼金額);

    baselineFive = {
      annualDepreciation: preview.每年折舊費用,
      officialKm: preview.年度公務里程,
      annualTotalKm: preview.年度總里程,
      ratioPercent: preview.公務比例,
      amount: preview.年度補貼金額,
    };

    // 折舊證明區塊：零附件之唯讀空狀態，無任何上傳／刪除入口（AC-54(b)／AC-42）。
    const attachmentsSection = page.locator(
      "section[aria-labelledby='depreciation-attachments-heading']"
    );
    await expect(attachmentsSection.locator("text=尚無證明")).toBeVisible();
    expect(await page.locator('input[type="file"]').count()).toBe(0);
    expect(await attachmentsSection.getByRole("button", { name: /刪除/ }).count()).toBe(0);
    expect(await attachmentsSection.getByRole("button", { name: /選擇圖片/ }).count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 情境2（Packet ②）：年度總里程小於年度公務里程（比例>100%）→ 預覽顯示
  // 錯誤區塊＋固定文案；儲存後完成鈕停用。
  // -------------------------------------------------------------------------
  test("情境2：年度總里程小於年度公務里程（比例>100%）擋完成並顯示提示", async ({ page }) => {
    await loginAsStaff(page, staffLoginName);
    const scratchId = await createDraftViaUi(page);

    await page.fill("#application-year", String(APPLICATION_YEAR));
    await page.fill("#annual-total-km", ANNUAL_TOTAL_KM_EXCEEDS);

    const previewSection = page.locator("section[aria-labelledby='preview-heading']");
    const errorBlock = previewSection.locator(".error-block");
    await expect(errorBlock).toBeVisible({ timeout: 10000 });
    await expect(errorBlock).toContainText("年度公務里程大於年度總里程，請檢查年度總里程");
    await expect(errorBlock).toHaveAttribute("role", "alert");
    // 五值 dl 不應出現在不可計算狀態（AC-52(d) 反模式禁止）。
    await expect(previewSection.locator("dl.detail-list")).toHaveCount(0);

    await page.click('button:has-text("儲存草稿")');
    await expect(page.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });

    // 儲存後，`application.completionBlockers` 已反映此違規——完成鈕停用。
    const completeBtn = page.getByRole("button", { name: "完成申請" });
    await expect(completeBtn).toBeDisabled();
    await expect(page.getByText("年度公務里程大於年度總里程，請檢查年度總里程")).toBeVisible();

    // Best-effort 清理本情境建立之草稿（避免累積無意義之測試資料）。
    await page.request.delete(`${API_BASE}/applications/${scratchId}`).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // 情境3（Packet ③）：未輸入年度總里程 → 不顯示金額 0，顯示「請輸入該車
  // 年度總里程」；儲存後完成鈕停用。
  // -------------------------------------------------------------------------
  test("情境3：未輸入年度總里程——不顯示 0 元，完成鈕停用", async ({ page }) => {
    await loginAsStaff(page, staffLoginName);
    const scratchId = await createDraftViaUi(page);

    await page.fill("#application-year", String(APPLICATION_YEAR));
    // annual-total-km 刻意留空。

    const previewSection = page.locator("section[aria-labelledby='preview-heading']");
    await expect(previewSection.locator("text=請輸入該車年度總里程")).toBeVisible({
      timeout: 10000,
    });
    // 不可計算狀態下五值 dl 不出現，故頁面不含任何 amount=0 之呈現。
    await expect(previewSection.locator("dl.detail-list")).toHaveCount(0);
    expect(await page.getByText(/^0$/).count()).toBe(0);

    await page.click('button:has-text("儲存草稿")');
    await expect(page.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });

    const completeBtn = page.getByRole("button", { name: "完成申請" });
    await expect(completeBtn).toBeDisabled();
    await expect(page.getByText("請輸入該車年度總里程")).toBeVisible();

    await page.request.delete(`${API_BASE}/applications/${scratchId}`).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // 情境4（Packet ④／FW-7）：管理員新增折舊參數版本後，重看已完成申請之
  // 快照五值（逐字）不受影響——讀 COMPLETED 快照區，非草稿預覽區。
  // -------------------------------------------------------------------------
  test("情境4：管理員改參數後，已完成申請之快照五值逐字不變", async ({ page, browser }) => {
    await loginAsStaff(page, staffLoginName);

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await loginAsAdmin(adminPage);
    await createUpdatedDepreciationVersion(adminPage, baselineFive.annualDepreciation);
    await adminContext.close();

    // 控制組：新草稿之即時預覽，此刻應已反映新參數（每年折舊費用 ≠ 基準值），
    // 證明參數確實已變——但緊接著的關鍵斷言是「已完成申請不受影響」。
    const previewRes = await page.request.post(`${API_BASE}/applications/depreciation/preview`, {
      data: { applicationYear: APPLICATION_YEAR, annualTotalKm: Number(ANNUAL_TOTAL_KM_NORMAL) },
    });
    expect(previewRes.ok()).toBe(true);
    const { preview: livePreview } = (await previewRes.json()) as {
      preview: { annualDepreciation: string | null };
    };
    expect(livePreview.annualDepreciation).not.toBe(baselineFive.annualDepreciation);

    // 關鍵斷言（FW-7）：重新載入已完成之折舊詳情頁，快照區之五值仍與情境1
    // 讀出之基準值逐字相同——完全不受管理員剛才的參數變更影響。
    await page.goto(`${BASE}/applications/depreciation/${depreciationApplicationId}`);
    await page.waitForURL(`${BASE}/applications/depreciation/${depreciationApplicationId}`);
    await expect(page.locator("h1")).toContainText("年度折舊補貼申請（已完成）");

    const snapshotSection = page.locator("section[aria-labelledby='snapshot-heading']");
    const snapshotAfterChange = await readDetailList(snapshotSection);
    expect(snapshotAfterChange.每年折舊費用).toBe(baselineFive.annualDepreciation);
    expect(snapshotAfterChange.年度公務里程).toBe(baselineFive.officialKm);
    expect(snapshotAfterChange.年度總里程).toBe(baselineFive.annualTotalKm);
    expect(snapshotAfterChange.公務比例).toBe(baselineFive.ratioPercent);
    expect(snapshotAfterChange["年度補貼金額（四捨五入後，實際核發）"]).toBe(baselineFive.amount);
  });

  // -------------------------------------------------------------------------
  // 情境5（不可變性，沿 AC-04 既有不可變語意）：再次嘗試修改（PUT）已完成之
  // 折舊申請 → 403，零寫入
  // -------------------------------------------------------------------------
  test("情境5：再次嘗試修改已完成之折舊申請→403", async ({ page }) => {
    await loginAsStaff(page, staffLoginName);

    const res = await page.request.put(
      `${API_BASE}/applications/depreciation/${depreciationApplicationId}`,
      { data: { applicationYear: APPLICATION_YEAR + 1 } }
    );
    expect(res.status()).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("已完成的申請不可修改，請建立修正版");

    const getRes = await page.request.get(
      `${API_BASE}/applications/depreciation/${depreciationApplicationId}`
    );
    expect(getRes.ok()).toBe(true);
    const { application } = (await getRes.json()) as {
      application: { applicationYear: number };
    };
    expect(application.applicationYear).toBe(APPLICATION_YEAR);
  });

  // -------------------------------------------------------------------------
  // 情境6（AC-45）：列表出現已完成折舊列且金額一致。
  // -------------------------------------------------------------------------
  test("情境6：列表出現已完成折舊列且金額一致", async ({ page }) => {
    await loginAsStaff(page, staffLoginName);

    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);
    const depreciationRows = page.locator(".app-list-table tbody tr", { hasText: "折舊補貼" });
    await expect(depreciationRows.first()).toBeVisible({ timeout: 10000 });
    const rowsText = await depreciationRows.allTextContents();
    expect(rowsText.some((t) => t.includes(baselineFive.amount))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 情境7（Packet ⑤／AC-57／AC-61）：管理員參數頁「折舊參數」區塊縮欄——
  // 建立表單僅三個可輸入欄位；新版本歷史列之「預估年里程」／「每公里單價」
  // 唯讀顯示「—」。
  // -------------------------------------------------------------------------
  test("情境7：管理員參數頁折舊參數區塊縮欄——建立三欄＋歷史唯讀「—」", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE}/admin/parameters`);
    await page.waitForURL(`${BASE}/admin/parameters`);

    const section = page.locator("section[aria-labelledby='depreciation-heading']");
    await expect(section).toBeVisible();

    // 縮欄後之建立表單：僅車價／折舊年限／生效日期三個可輸入欄位；
    // `estimatedAnnualKm`（AC-57(a)）已退場，不應出現任何相關輸入元素。
    await expect(section.locator("#dep-vehiclePrice")).toBeVisible();
    await expect(section.locator("#dep-usefulLifeYears")).toBeVisible();
    await expect(section.locator("#dep-effectiveFrom")).toBeVisible();
    expect(await section.locator("#dep-estimatedAnnualKm").count()).toBe(0);
    expect(await section.locator('input[name="estimatedAnnualKm"]').count()).toBe(0);

    // 以確定性（時間戳推導）之極早期日期建立一個新版本，避免與既有 2020+
    // 版本重疊，同時避免多輪重跑撞期（同 depreciationYearRange 之既有慣例）。
    const now = Date.now();
    const scratchYear = 1900 + (now % 50);
    const scratchMonth = String((Math.floor(now / 1000) % 12) + 1).padStart(2, "0");
    const scratchDay = String((now % 27) + 1).padStart(2, "0");
    const scratchEffectiveFrom = `${scratchYear}-${scratchMonth}-${scratchDay}`;

    await section.locator("#dep-vehiclePrice").fill("100000");
    await section.locator("#dep-usefulLifeYears").fill("5");
    await section.locator("#dep-effectiveFrom").fill(scratchEffectiveFrom);
    await section.locator('button:has-text("建立")').click();
    await expect(section.getByText("折舊參數版本建立成功。")).toBeVisible({ timeout: 10000 });

    const newRow = section.locator("table.param-table tbody tr", { hasText: scratchEffectiveFrom });
    await expect(newRow).toBeVisible({ timeout: 10000 });
    const cells = await newRow.locator("td").allTextContents();
    // 欄序：生效日期／車價／折舊年限／預估年里程／每年折舊費用／每公里單價／建立時間
    expect(cells[3]).toBe("—"); // 預估年里程
    expect(cells[5]).toBe("—"); // 每公里單價
  });

  // -------------------------------------------------------------------------
  // 情境8（Packet ⑥／AC-46）：375px 無水平溢位——折舊表單／預覽／證明區塊
  // （同一草稿頁面之三個區塊）、列表頁、已完成詳情頁、管理員參數頁。
  // -------------------------------------------------------------------------
  test("情境8：響應式 375px——折舊表單／預覽／證明／列表／已完成詳情／參數頁皆無水平溢位", async ({
    page,
    browser,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAsStaff(page, staffLoginName);

    // 畫面①②③：折舊表單／預覽區塊／證明區塊（同一 DOM 文件，非獨立路由）。
    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);
    expect(await hasHorizontalOverflow(page)).toBe(false);

    await page.click('a:has-text("新增年度折舊補貼申請")');
    await page.waitForURL(/\/applications\/depreciation\/(?!new)[^/]+$/, { timeout: 15000 });
    await expect(page.locator("h1")).toContainText("年度折舊補貼申請（草稿）");
    await expect(
      page.locator("section[aria-labelledby='depreciation-form-heading']")
    ).toBeVisible();
    await expect(page.locator("section[aria-labelledby='preview-heading']")).toBeVisible();
    await expect(
      page.locator("section[aria-labelledby='depreciation-attachments-heading']")
    ).toBeVisible();

    const draftOverflow = await hasHorizontalOverflow(page);
    expect(draftOverflow).toBe(false);

    // 清理本情境建立之新草稿（best-effort，非本情境驗證標的）。
    const url = new URL(page.url());
    const scratchId = url.pathname.split("/").pop() as string;
    await page.request.delete(`${API_BASE}/applications/${scratchId}`).catch(() => {});

    // 畫面④：已完成詳情（複用情境1/4 已完成之申請，快照區含兩個超長 dt）。
    await page.goto(`${BASE}/applications/depreciation/${depreciationApplicationId}`);
    await page.waitForURL(`${BASE}/applications/depreciation/${depreciationApplicationId}`);
    await expect(page.locator("h1")).toContainText("年度折舊補貼申請（已完成）");
    const detailOverflow = await hasHorizontalOverflow(page);
    expect(detailOverflow).toBe(false);

    // 畫面⑤（新增覆蓋，比 AC-46 條文列舉多一道防線）：管理員參數頁。獨立
    // context（同情境4/6 既有慣例）——避免與同一 page 之 staff session 互相
    // 覆寫 cookie（`loginAsAdmin` 之 `/login` 頁在已登入狀態下會被應用程式
    // 導回首頁，導致 `#loginName` 逾時等不到）。
    const adminContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const adminPage = await adminContext.newPage();
    await loginAsAdmin(adminPage);
    await adminPage.goto(`${BASE}/admin/parameters`);
    await adminPage.waitForURL(`${BASE}/admin/parameters`);
    const paramsOverflow = await hasHorizontalOverflow(adminPage);
    expect(paramsOverflow).toBe(false);
    await adminContext.close();
  });
});
