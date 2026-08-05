/**
 * E2E: 年度折舊補貼 — PHASE-007-T16 Gate E2E（Spec §15 T16、§2 AC-45/46）
 *
 * 涵蓋：
 *   - AC-45（情境1~6，六 it）：完整走一筆折舊——登入 → 新增折舊申請 → 選年度 →
 *     看到年度公務里程／單價／補貼金額 → 上傳證明 → 完成 → 列表出現已完成
 *     折舊列且金額一致；管理員改參數後重看該筆金額與單價不變。六個 it 依序
 *     累積同一筆折舊草稿之前置狀態（同一合成使用者、同一 applicationId），以
 *     `test.describe.configure({ mode: "serial" })` 保證執行順序（同
 *     maintenance-allowance.spec.ts／fuel-model.spec.ts 既有慣例，與
 *     playwright.config.ts 的 `fullyParallel: false` / `workers: 1` 一致）。
 *   - AC-46（情境7，375px）：折舊表單／預覽／證明區塊（同一草稿頁面之三個
 *     區塊，非獨立路由）與列表頁（HomePage）之 `body.scrollWidth <=
 *     window.innerWidth`；額外覆蓋已完成詳情頁（COMPLETED 快照區，FW-6 候選
 *     ②：兩個超長 dt——比 AC-46 條文列舉之四畫面多一道防線，非減少）。
 *
 * FW-4 播種順序鐵律（本檔逐字落地）：選年度 → 上傳證明 → 儲存草稿（等待
 * 「草稿已儲存。」出現）→ 完成。上傳附件本身即令表單 dirty（
 * DepreciationApplicationPage.tsx `updateAttachments` 明文），情境3先斷言
 * 「上傳後、儲存前」完成鈕為 disabled，再點擊「儲存草稿」並等待成功文案，
 * 避免「上傳後直接完成」卡死且訊息不指向真因之既有教訓（保養 T14 FW-4 同型）。
 *
 * FW-5（375px 之外的另一處 debounce 鑑別）：草稿頁預覽為 D8 300ms debounce
 * stateless 呼叫，情境2一律以「三值（年度公務里程／折舊每公里補助單價／
 * 年度補貼金額）文字出現」為 wait 條件（Playwright `expect(...).toHaveText`
 * 之輪詢重試天然涵蓋 debounce 等待，不使用固定 `waitForTimeout` 睡眠）。
 *
 * FW-7（AC-45 後半）：管理員改參數後之「不變」斷言一律讀 COMPLETED 詳情頁的
 * 快照區（`section[aria-labelledby='snapshot-heading']`），不讀草稿預覽區
 * （草稿預覽為即時計算、本就會反映新參數，讀錯區塊會讓本斷言恆真通過而失去
 * 意義）。
 *
 * 播種冪等（沿 PHASE-005a T13R／006 AR-4 教訓）：
 *   - 合成使用者以隨機後綴建立（每次執行皆為全新使用者，同 fuel-model.spec.ts
 *     既有作法），故 `officialKm` 恆為本次播種之單筆差旅里程，不受其他次
 *     E2E 執行殘留資料影響。
 *   - 折舊參數版本無 DELETE 端點，故「基準版本」一律「先查後建」（僅在
 *     `applicationYear`-01-01 尚無任何覆蓋版本時才建立），重複執行整套 E2E
 *     不會因既有版本而 409 PARAMETER_PERIOD_OVERLAP。
 *   - 情境6（FW-7 改參數）刻意每次執行皆新增一個「更新」版本——`effectiveFrom`
 *     一律取「現有覆蓋該年 1/1 之版本中最大值之次日」（嚴格遞增，見
 *     `createUpdatedDepreciationVersion` 檔頭說明），車價則由當次基準單價反推
 *     `baseline + 1.0000`（整數位小數運算，見 `updatedVehiclePriceDifferentFrom`
 *     檔頭說明）——兩者皆為**確定性**推導，不依賴時間戳/隨機數巧合，徹底避免
 *     「新版本被歷史累積版本蓋過而選版不變」或「新舊單價巧合相同」兩種曾
 *     實測踩過的假性失敗。**因此本檔之「金額與單價不變」斷言刻意不依賴任何
 *     寫死的手算數字**：情境2先動態讀出
 *     當次計算之基準單價／金額（可能因先前執行已累積之「更新」版本而不同於
 *     基準版本之理論值），情境6僅斷言「COMPLETED 快照區之值＝情境2/4 讀出之
 *     基準值」與「新草稿之即時預覽單價≠基準單價」（證明參數確實已變、但
 *     不影響已完成申請），全程零手算鎖定——折舊金額公式之手算鑑別已由
 *     T15（合約／整合測試）與 T2（純函式單元測試）覆蓋，非本檔職責
 *     （AC-45 條文本身亦僅要求「看到」與「不變」，未要求手算重現）。
 *     全域參數版本本即只增不減（無 DELETE 端點），與其餘 E2E 累積資料同一
 *     慣例（006 AR-4）。
 *
 * Topology / Test account：implementer 本機驗證於 backend :3000（tsx watch）
 * + Vite :5173（`npm run dev`）+ 既有 dev DB（`t1-pg` 容器，
 * `postgresql://testuser:test@localhost:55432/app_test`，與其餘既有 e2e 檔
 * 共用之同一 dev 拓撲；`playwright.config.ts` 檔頭 55434 為過期敘述，見
 * PROJECT_STATE.md T8 揭露事項，實際沿用 55432）；管理員帳號沿用既有 E2E
 * 慣例（e2eadmin，同其他 e2e 檔）；合成折舊使用者以 `e2e-depr-<random>`
 * 命名。最終證據輪由大總管親跑於 dev 拓撲（Packet Done When 明文）。
 */

import { type Page, expect, test } from "@playwright/test";

const E2E_ADMIN = { loginName: "e2eadmin", password: "E2eAdmin@456!" };
const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";

// ---------------------------------------------------------------------------
// 動態相對日期／年度（避免寫死日曆日期隨系統時間推移而失效——同
// travel-application.spec.ts SUCCESS_TRIP_DATE 之既有教訓：本檔於 R8F 揭露之
// D9(iii)「申請紀錄列表預設 dateFrom = 今日 − 1 年」下額外印證——若寫死一個
// 遙遠過去年度，該筆折舊申請之 primaryDate（該年 12-31）會落在列表預設區間
// 之外，AC-45「列表出現已完成折舊列」即恆假失敗。故 `APPLICATION_YEAR` 一律
// 由 `TRIP_DATE`（相對今日回溯 30 天）反推當下年度，確保：①落在列表預設
// 1 年窗內；②差旅日期恆為過去（非未來）。
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

// 基準折舊參數版本（僅在 APPLICATION_YEAR-01-01 尚無覆蓋版本時才建立，先查後建）
const BASE_PARAM_EFFECTIVE_FROM = "2020-06-01";
const BASE_VEHICLE_PRICE = "600000";
const BASE_USEFUL_LIFE_YEARS = 5;
const BASE_ESTIMATED_ANNUAL_KM = 12000;

// 播種差旅完成所需之其餘全域參數（油價／ETC／油耗，同 maintenance-allowance.spec.ts
// 既有理由：完成差旅需可計算金額，三者缺一即 409 PARAMETER_NOT_AVAILABLE）。
const FUEL_TYPE = "GASOLINE_92";
const FUEL_KM_PER_LITER = "10.0000";
const FUEL_PRICE_PER_LITER = "65.0000";
const ETC_UNIT_PRICE = 1.8;
const FUEL_BASIS_NOTE = "PHASE-007-T16 E2E 合成資料（折舊 Gate E2E 播種用）";

/** `YYYY-MM-DD` 字串 + 1 天（UTC 日粒度，同 depreciationYearRange 之既有慣例）。 */
function addOneDayUtc(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * FW-7 情境6用：由「當次基準單價」反推一個保證推導出 `baseline + 1.0000`
 * 之車價（整數位小數運算，避免浮點誤差），確保「新草稿即時預覽單價確實已變」
 * 這條控制組斷言恆為真——不依賴任何隨機/時間戳巧合（早期版本以
 * `Date.now() % 900000` 決定車價，經三輪重跑驗證後發現：當跨次執行推導值
 * 精度粒度僅 6（60000×0.0001）時，兩次執行之隨機車價仍有機率落入同一 4 位
 * 小數單價，讓控制組斷言假性失敗——現改為確定性反推，徹底消除此邊界風險）。
 */
function updatedVehiclePriceDifferentFrom(baselinePerKmUnitPrice: string): string {
  const baselineTenThousandths = Math.round(Number(baselinePerKmUnitPrice) * 10000);
  const newTenThousandths = baselineTenThousandths + 10000; // +1.0000，保證與基準不同
  const newVehiclePrice =
    (newTenThousandths * BASE_USEFUL_LIFE_YEARS * BASE_ESTIMATED_ANNUAL_KM) / 10000;
  return String(newVehiclePrice);
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
  const displayName = `T16折舊使用者${suffix}`;
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
      estimatedAnnualKm: BASE_ESTIMATED_ANNUAL_KM,
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
 * FW-7 情境6：新增一個「更新」折舊參數版本。`effectiveFrom` 一律取「現有全部
 * 覆蓋 `APPLICATION_YEAR-01-01` 之版本中最大 `effectiveFrom` 之次日」——
 * **嚴格遞增**，保證此新版本必為 `findEffectiveVersion` 之新選中版本（比任何
 * 歷史累積版本都更接近查詢日），從而使「新草稿即時預覽單價確實已變」這條
 * 控制組斷言恆為真。早期版本以「執行時間戳雜湊出落在固定 213 天窗內之日期」
 * 決定 `effectiveFrom`——經多輪重跑驗證後發現：該窗會被歷次執行累積的版本
 * 佔滿，新版本之 `effectiveFrom` 未必大於既有最大值，選版邏輯因此仍選中舊
 * 版本，讓控制組斷言假性失敗——現改為「查最大值＋1 天」，因 `APPLICATION_YEAR`
 * 逐年遞增（動態年度）而窗口本身逐年變寬，不會再被佔滿。
 */
async function createUpdatedDepreciationVersion(
  page: Page,
  baselinePerKmUnitPrice: string
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
      vehiclePrice: updatedVehiclePriceDifferentFrom(baselinePerKmUnitPrice),
      usefulLifeYears: BASE_USEFUL_LIFE_YEARS,
      estimatedAnnualKm: BASE_ESTIMATED_ANNUAL_KM,
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
 * `APPLICATION_YEAR` 年度區間內——非本測試之驗證標的（差旅本身之計算已由
 * PHASE-004/005a Gate E2E 覆蓋），純粹作為年度公務里程之播種資料，故以 API
 * 直接建立而非走差旅 UI（同 maintenance-allowance.spec.ts 既有理由）。
 * 呼叫端須已以合成使用者身分登入（`page` cookie）。
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
      purpose: "PHASE-007-T16 折舊 Gate E2E 播種差旅",
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

// ---------------------------------------------------------------------------
// 模組層共用狀態（六 it 依序累積同一筆折舊草稿之前置狀態）
// ---------------------------------------------------------------------------
let staffUserId: string;
let staffLoginName: string;
let depreciationApplicationId: string;
let baselinePerKmUnitPrice: string;
let baselineAmount: string;

test.describe("年度折舊補貼 — PHASE-007 Gate E2E", () => {
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
  // 情境1（AC-45 ①②③，FW-4 順序第一步「選年度」）：播種一筆該年度內之已完成
  // 差旅 → 建立折舊草稿 → 選擇申請年度 → 儲存草稿
  // -------------------------------------------------------------------------
  test("情境1：播種一筆年度內之已完成差旅→建立折舊草稿→選擇申請年度並儲存", async ({ page }) => {
    await loginAsStaff(page, staffLoginName);
    await seedCompletedTravel(page);

    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);
    await page.click('a:has-text("新增年度折舊補貼申請")');
    await page.waitForURL(/\/applications\/depreciation\/(?!new)[^/]+$/, { timeout: 15000 });
    await expect(page.locator("h1")).toContainText("年度折舊補貼申請（草稿）");

    const url = new URL(page.url());
    depreciationApplicationId = url.pathname.split("/").pop() as string;

    await page.fill("#application-year", String(APPLICATION_YEAR));
    await page.click('button:has-text("儲存草稿")');
    await expect(page.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });
  });

  // -------------------------------------------------------------------------
  // 情境2（AC-45 ③，FW-5：預覽 debounce——以三值文字出現為 wait 條件）：
  // 預覽顯示年度公務里程／折舊每公里補助單價／年度補貼金額三值
  // -------------------------------------------------------------------------
  test("情境2：預覽顯示年度公務里程／折舊每公里補助單價／年度補貼金額三值", async ({ page }) => {
    await loginAsStaff(page, staffLoginName);
    await page.goto(`${BASE}/applications/depreciation/${depreciationApplicationId}`);
    await page.waitForURL(`${BASE}/applications/depreciation/${depreciationApplicationId}`);

    const previewSection = page.locator("section[aria-labelledby='preview-heading']");
    // FW-5：以「年度公務里程」dd 文字出現且等於播種值為 wait 條件（涵蓋 D8
    // 300ms debounce），而非固定 sleep。
    await expect(previewSection.locator("dl.detail-list dt").nth(0)).toHaveText("年度公務里程", {
      timeout: 10000,
    });
    await expect(previewSection.locator("dl.detail-list dd").nth(0)).toHaveText(
      `${EXPECTED_OFFICIAL_KM} 公里`,
      { timeout: 10000 }
    );

    await expect(previewSection.locator("dt")).toHaveCount(3);
    const preview = await readDetailList(previewSection);
    expect(preview.年度公務里程).toBe(`${EXPECTED_OFFICIAL_KM} 公里`);
    expect(preview.折舊每公里補助單價).toMatch(/^\d+\.\d{4}$/);
    expect(preview.年度補貼金額).toMatch(/^\d+$/);

    baselinePerKmUnitPrice = preview.折舊每公里補助單價;
    baselineAmount = preview.年度補貼金額;
  });

  // -------------------------------------------------------------------------
  // 情境3（AC-45 ④，FW-4 第二／三步「上傳證明 → 儲存草稿」）：上傳一張折舊
  // 證明——上傳完成後、儲存草稿前，完成鈕須為 disabled（dirty 鎖）；儲存後
  // 等待「草稿已儲存。」出現，完成鈕才恢復可用。
  // -------------------------------------------------------------------------
  test("情境3：上傳一張折舊證明（上傳後完成鈕鎖定）並儲存草稿", async ({ page }) => {
    await loginAsStaff(page, staffLoginName);
    await page.goto(`${BASE}/applications/depreciation/${depreciationApplicationId}`);
    await page.waitForURL(`${BASE}/applications/depreciation/${depreciationApplicationId}`);

    const jpegBuffer = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ]);
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.click('button:has-text("選擇圖片")'),
    ]);
    await fileChooser.setFiles({
      name: DEPRECIATION_PROOF_FILENAME,
      mimeType: "image/jpeg",
      buffer: jpegBuffer,
    });

    const uploadedImg = page.locator(`img[alt="${DEPRECIATION_PROOF_FILENAME}"]`);
    await expect(uploadedImg).toBeVisible({ timeout: 15000 });

    // FW-4 鐵律：上傳後、儲存前——完成鈕仍為 disabled（表單 dirty）。
    const completeBtn = page.getByRole("button", { name: "完成申請" });
    await expect(completeBtn).toBeDisabled();

    await page.click('button:has-text("儲存草稿")');
    await expect(page.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });

    // 儲存成功、無其餘阻擋項後——完成鈕恢復可用。
    await expect(completeBtn).toBeEnabled();
  });

  // -------------------------------------------------------------------------
  // 情境4（AC-45 ⑤⑥）：完成申請（C4 二次確認）→ 詳情顯示快照三值（與情境2
  // 之草稿預覽一致）且附件區塊無任何上傳／刪除入口（負向斷言）
  // -------------------------------------------------------------------------
  test("情境4：完成申請→詳情顯示快照且與草稿預覽一致、附件無刪除入口", async ({ page }) => {
    await loginAsStaff(page, staffLoginName);
    await page.goto(`${BASE}/applications/depreciation/${depreciationApplicationId}`);
    await page.waitForURL(`${BASE}/applications/depreciation/${depreciationApplicationId}`);

    await page.click('button:has-text("完成申請")');
    const confirmDialog = page.getByRole("dialog", { name: "確認完成申請" });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.locator('button:has-text("確認完成")').click();

    await expect(page.locator("h1")).toContainText("年度折舊補貼申請（已完成）", {
      timeout: 10000,
    });

    const snapshotSection = page.locator("section[aria-labelledby='snapshot-heading']");
    await expect(snapshotSection).toBeVisible();
    const snapshot = await readDetailList(snapshotSection);
    expect(snapshot.年度公務里程).toBe(`${EXPECTED_OFFICIAL_KM} 公里`);
    expect(snapshot.折舊每公里補助單價).toBe(baselinePerKmUnitPrice);
    expect(snapshot["年度補貼金額（四捨五入後，實際核發）"]).toBe(baselineAmount);

    // 附件區塊：僅唯讀縮圖清單，無任何上傳／刪除入口（AC-42 COMPLETED 分支
    // 之負向斷言，同 MaintenanceApplicationPage COMPLETED 分支既有慣例）。
    const attachmentsSection = page.locator(
      "section[aria-labelledby='depreciation-attachments-heading']"
    );
    await expect(
      attachmentsSection.locator(`img[alt="${DEPRECIATION_PROOF_FILENAME}"]`)
    ).toBeVisible();
    expect(await page.locator('input[type="file"]').count()).toBe(0);
    expect(await attachmentsSection.getByRole("button", { name: /刪除/ }).count()).toBe(0);
    expect(await attachmentsSection.getByRole("button", { name: /選擇圖片/ }).count()).toBe(0);
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

    // 確認真的沒有被寫入（申請年度仍是原值，非上面嘗試送出的 +1）。
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
  // 情境6（AC-45 後半／FW-7）：列表出現已完成折舊列且金額一致；管理員改參數
  // 後重看該筆金額與單價不變（讀 COMPLETED 快照區，非草稿預覽區）。
  // -------------------------------------------------------------------------
  test("情境6：列表金額一致；管理員改參數後重看該筆金額與單價不變", async ({ page, browser }) => {
    await loginAsStaff(page, staffLoginName);

    // AC-45「列表出現已完成折舊列且金額一致」——HomePage 之申請列表，以
    // 「折舊補貼」type 標籤篩出所有折舊列，確認其中至少一列含本筆之金額。
    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);
    const depreciationRows = page.locator(".app-list-table tbody tr", { hasText: "折舊補貼" });
    await expect(depreciationRows.first()).toBeVisible({ timeout: 10000 });
    const rowsText = await depreciationRows.allTextContents();
    expect(rowsText.some((t) => t.includes(baselineAmount))).toBe(true);

    // FW-7：管理員新增一個「更新」折舊參數版本（每次執行皆不同 effectiveFrom）。
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await loginAsAdmin(adminPage);
    await createUpdatedDepreciationVersion(adminPage, baselinePerKmUnitPrice);
    await adminContext.close();

    // 控制組：新草稿之即時預覽單價，此刻應已反映新參數（≠ 情境2之基準單價），
    // 證明參數確實已變——但緊接著的關鍵斷言是「已完成申請不受影響」。
    const previewRes = await page.request.post(`${API_BASE}/applications/depreciation/preview`, {
      data: { applicationYear: APPLICATION_YEAR },
    });
    expect(previewRes.ok()).toBe(true);
    const { preview: livePreview } = (await previewRes.json()) as {
      preview: { perKmUnitPrice: string | null };
    };
    expect(livePreview.perKmUnitPrice).not.toBe(baselinePerKmUnitPrice);

    // 關鍵斷言（FW-7）：重新載入已完成之折舊詳情頁，快照區之單價與金額仍與
    // 情境2/4 讀出之基準值相同——完全不受管理員剛才的參數變更影響。
    await page.goto(`${BASE}/applications/depreciation/${depreciationApplicationId}`);
    await page.waitForURL(`${BASE}/applications/depreciation/${depreciationApplicationId}`);
    await expect(page.locator("h1")).toContainText("年度折舊補貼申請（已完成）");

    const snapshotSection = page.locator("section[aria-labelledby='snapshot-heading']");
    const snapshotAfterChange = await readDetailList(snapshotSection);
    expect(snapshotAfterChange.折舊每公里補助單價).toBe(baselinePerKmUnitPrice);
    expect(snapshotAfterChange["年度補貼金額（四捨五入後，實際核發）"]).toBe(baselineAmount);
  });

  // -------------------------------------------------------------------------
  // 情境7（AC-46）：375px 無水平溢位——折舊表單／預覽／證明區塊（同一草稿
  // 頁面之三個區塊）、列表頁（HomePage），以及已完成詳情頁（FW-6 候選②
  // 「COMPLETED 快照區兩個超長 dt」，額外覆蓋，比條文列舉多一道防線）。
  // -------------------------------------------------------------------------
  test("情境7：響應式 375px——折舊表單／預覽／證明／列表／已完成詳情皆無水平溢位", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAsStaff(page, staffLoginName);

    // 折舊表單／預覽區塊／證明區塊：建立一筆新草稿以同時檢視三者（同一 DOM
    // 文件，非獨立路由）。
    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);

    // AC-46（列表畫面）：HomePage 本身（含 btn-row 之新增申請入口與申請列表）
    // 於 375px 無水平溢位——FW-6 候選①（btn-row 三顆 primary 鈕，含新鈕標籤
    // 較長）之靜態防線見 index.css `.btn-row { flex-wrap: wrap; }`（既有樣式，
    // 未動之而涵蓋）。
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

    // 清理本情境建立之新草稿（避免累積無意義之空草稿；best-effort，非本情境
    // 驗證標的）。
    const url = new URL(page.url());
    const scratchId = url.pathname.split("/").pop() as string;
    await page.request.delete(`${API_BASE}/applications/${scratchId}`).catch(() => {});

    // 已完成詳情（FW-6 候選②，額外覆蓋）：複用情境4/6 已完成之申請，快照區
    // 含兩個超長 dt（「四捨五入前金額（僅供對照，非實際核發金額）」／
    // 「年度補貼金額（四捨五入後，實際核發）」）。
    await page.goto(`${BASE}/applications/depreciation/${depreciationApplicationId}`);
    await page.waitForURL(`${BASE}/applications/depreciation/${depreciationApplicationId}`);
    await expect(page.locator("h1")).toContainText("年度折舊補貼申請（已完成）");

    const detailOverflow = await hasHorizontalOverflow(page);
    expect(detailOverflow).toBe(false);
  });
});
