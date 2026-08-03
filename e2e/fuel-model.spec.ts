/**
 * E2E: 油資模型修正（按油種油價 + 按使用者油耗） — PHASE-005a-T13 Gate E2E
 * （Spec §11.4，六情境；§18 為裁定權威）
 *
 * 涵蓋 Spec §11.4 全部 6 條情境：
 *   1. 管理員建立四油種油價版本 → 版本列表按油種正確呈現。
 *   2. 管理員為 staff01 建立油耗版本（含依據備註）→ 列表顯示 CURRENT。
 *   3. staff01 登入 → 個人頁看到油種／油耗／生效日，且無編輯入口。
 *   4. staff01 建差旅草稿 → 刪除其油耗版本前先建一筆缺油耗之情境（以未建
 *      油耗之第二帳號）→ 完成被擋且提示為「建立油耗資料」。
 *   5. staff01 完成差旅 → 金額等於以推導單價手算之值；報表區塊可見快照
 *      三來源值——**已知缺口（AR-3，見下方 JSDoc）**：前端
 *      `TravelSnapshotDto`／`TravelApplicationPage.tsx` 快照區塊目前未接
 *      `snapshotFuelType`/`snapshotFuelPricePerLiter`/`snapshotFuelConsumption`
 *      三欄（`frontend/src/api/applications.ts` 之 `TravelSnapshotDto` 無此三
 *      欄；後端 `travel-service.ts` 已回傳，見 GET 回應之
 *      `snapshotFuelType`/`snapshotFuelPricePerLiter`/`snapshotFuelConsumption`
 *      三鍵）。本檔僅驗證「金額等於推導單價手算之值」（情境5之可落地部分），
 *      三來源值之顯示驗證**予以省略**並在此註記——此為 Spec 層裁定缺口，
 *      非本 Task 應自行擴充顯示功能補齊（Packet Stop Condition 明文禁止）。
 *   6. 375px 無水平溢位（油價頁 `/admin/parameters`、油耗維護頁
 *      `/admin/users/:userId/fuel-consumption`、個人區塊 HomePage）。
 *
 * 安全測試（Spec §11.5）覆蓋歸屬盤點（本檔不重複覆蓋）：
 *   - 一般使用者對油耗端點 403 + zero-write：`AC-36`
 *     （backend/test/integration/phase5a-fuel-consumption-authz.test.ts，
 *     5 身分 × 3 欄=15 格，Spec §12 表列 GREEN）已覆蓋。
 *   - 偽造 cookie → 401：`backend/test/integration/auth.test.ts`
 *     （"GET /me with invalid/bogus cookie returns 401"）與
 *     `backend/test/integration/middleware.test.ts`（"AC-05: bogus/invalid
 *     token → 401 UNAUTHORIZED"）——`requireAuth` 為全站共用中介層，
 *     此二檔對其之覆蓋對本 Phase 新增端點同樣成立（同一函式、同一驗證邏輯，
 *     未因路由不同而分岔）。
 *   - 停用帳號 → 401：`phase5a-fuel-consumption-authz.test.ts`
 *     （"AC-36[停用帳號 × …] → 401 UNAUTHORIZED" 三條）已覆蓋。
 *   - 陣列型 query 鍵 → 400（B-11）：`backend/test/integration/
 *     phase5a-fuel-price.test.ts`（"AR-4 duplicate fuelType query key
 *     (?fuelType=GASOLINE_95&fuelType=DIESEL) → 400 VALIDATION_ERROR"）
 *     已覆蓋。
 *   - 回應原文掃描（password/token/SQL/絕對路徑）：`phase5a-contract.test.ts`
 *     `AC-34` logStream 掃描（6 條）＋`A-6` console.error 掃描已覆蓋。
 *
 * Topology / Test account: 同 mileage-statistics.spec.ts（e2eadmin，見該檔
 * 檔頭）。本檔另以 `POST /admin/users`（既有 PHASE-002 端點）建立 staff01
 * 合成使用者（情境2~5 對象）與第二個「無油耗」合成使用者（情境4 對象）。
 */

import { type Page, expect, test } from "@playwright/test";

const E2E_ADMIN = { loginName: "e2eadmin", password: "E2eAdmin@456!" };
const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";

/** Minimal valid 1x1 JPEG (real FF D8 FF header) — 同既有 e2e specs 慣例。 */
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

// ---------------------------------------------------------------------------
// 固定資料 —— 四油種油價（情境1）、staff01 之油耗與所屬油種（情境2~5）。
// effectiveFrom 一律早於任何本檔使用之出差日期，避免「查無有效版本」。
// ---------------------------------------------------------------------------
const PARAM_EFFECTIVE_FROM = "2020-01-01";
const STAFF_FUEL_TYPE = "GASOLINE_95";
const FUEL_PRICE_BY_TYPE: Record<string, string> = {
  GASOLINE_92: "27.0000",
  GASOLINE_95: "30.0000", // staff01 所屬油種——手算基準（情境5）
  GASOLINE_98: "32.0000",
  DIESEL: "24.0000",
};
const FUEL_TYPE_LABEL: Record<string, string> = {
  GASOLINE_92: "92 無鉛汽油",
  GASOLINE_95: "95 無鉛汽油",
  GASOLINE_98: "98 無鉛汽油",
  DIESEL: "柴油",
};
const STAFF_KM_PER_LITER = "10.0000";
const STAFF_BASIS_NOTE = "依原廠公告油耗核對（PHASE-005a-T13 E2E 合成資料）";
// T13R 修復：`ensureEtcParameterCovers` 為「先查後建」（同 covers 慣例）——若
// dev DB 已有涵蓋 `TRIP_DATE` 之 ETC 版本（跨 session 持久，非本檔可控），
// 本檔不會建立這裡假設的 1.8，屆時實際生效單價會是既有版本之值。故不可再
// 假設固定 1.8／固定手算 390——情境5 改為在建立/確認 ETC 版本覆蓋後，實際
// 查詢當時生效之 ETC 單價，動態計算 EXPECTED_AMOUNT（見情境5 test body），
// 而非在此寫死常數。
const ETC_UNIT_PRICE_IF_CREATING = 1.8;

// 情境5 手算基準：fuelUnitPrice = ROUND_HALF_UP(30.0000 ÷ 10.0000) = 3（整數 NTD/km）。
const STAFF_FUEL_UNIT_PRICE = 3;
const TRIP_TOTAL_KM = "100.00";
const TRIP_HIGHWAY_KM = "50.00";

function isoDateMonthsAgo(months: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}
const TRIP_DATE = isoDateMonthsAgo(2);

let staffUserId = "";
let staffLoginName = "";
let staffDisplayName = "";
/** T13R：beforeAll 以管理員身分查得之實際生效 ETC 單價（見 getEffectiveEtcUnitPrice）。 */
let resolvedEtcUnitPrice = 0;
const STAFF_TEMP_PASSWORD = "E2eFuelStaff@789!";
const STAFF_NEW_PASSWORD = "E2eFuelStaffChanged1!";

let noConsumptionUserId = "";
let noConsumptionLoginName = "";
let noConsumptionDisplayName = "";
const NO_CONS_TEMP_PASSWORD = "E2eFuelNoCons@789!";
const NO_CONS_NEW_PASSWORD = "E2eFuelNoConsChanged1!";

const createdApplicationIds: string[] = [];
const createdAttachmentIds: string[] = [];

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.waitForURL(`${BASE}/login`);
  await page.fill("#loginName", E2E_ADMIN.loginName);
  await page.fill("#password", E2E_ADMIN.password);
  await page.click('button:has-text("登入")');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
}

/**
 * T13R 修復：dev DB 為跨多次 E2E 執行共用之持久化資料庫，且油價版本無 DELETE
 * 端點（財務參數歷史不可變）——今晚稍早之全套執行已可能建立過本檔四油種於
 * `PARAM_EFFECTIVE_FROM` 的版本，重複執行本情境會 409
 * `PARAMETER_PERIOD_OVERLAP`（`checkNoOverlap` 僅比對「同油種＋同一天」，見
 * `backend/src/parameters/parameter-version-engine.ts`）。以「先查後建」
 * （查詢是否已存在**恰好同一生效日**之版本）取代無條件建立，取得對持久 DB
 * 的冪等性——若已存在，略過表單送出，只驗證清單呈現（本檔固定使用同一組
 * `FUEL_PRICE_BY_TYPE` 常數，故重跑必得相同期望值，非巧合）。
 */
async function fuelPriceVersionExists(
  page: Page,
  fuelType: string,
  effectiveFrom: string
): Promise<boolean> {
  const res = await page.request.get(`${API_BASE}/parameters/fuel-price?fuelType=${fuelType}`);
  const { versions } = (await res.json()) as { versions: { effectiveFrom: string }[] };
  return versions.some((v) => v.effectiveFrom === effectiveFrom);
}

/**
 * 情境2 之冪等守衛（同上方 fuelPriceVersionExists 之「先查後建」策略）。
 * `staffUserId` 每次執行皆為全新合成使用者（見 `createSyntheticUser`），實務上
 * 不可能已有油耗版本；此守衛仍加上以與情境1同型處理、防禦未來若合成使用者
 * 建立策略調整導致的意外重複執行。
 */
async function fuelConsumptionVersionExists(
  page: Page,
  userId: string,
  effectiveFrom: string
): Promise<boolean> {
  const res = await page.request.get(`${API_BASE}/users/${userId}/fuel-consumption`);
  const { versions } = (await res.json()) as { versions: { effectiveFrom: string }[] };
  return versions.some((v) => v.effectiveFrom === effectiveFrom);
}

async function ensureEtcParameterCovers(page: Page, dateStr: string): Promise<void> {
  const res = await page.request.get(`${API_BASE}/parameters/etc`);
  const { versions } = (await res.json()) as { versions: { effectiveFrom: string }[] };
  const covers = versions.some((v) => v.effectiveFrom <= dateStr);
  if (!covers) {
    const createRes = await page.request.post(`${API_BASE}/parameters/etc`, {
      data: { unitPrice: ETC_UNIT_PRICE_IF_CREATING, effectiveFrom: PARAM_EFFECTIVE_FROM },
    });
    if (!createRes.ok()) {
      throw new Error(`E2E 設定 ETC 參數失敗: ${createRes.status()} ${await createRes.text()}`);
    }
  }
}

/**
 * T13R 修復：回傳 `dateStr` 當日實際生效之 ETC 單價（呼叫端須先確認已由
 * `ensureEtcParameterCovers` 確保覆蓋）——ETC 為全站單一時間軸（無油種分區），
 * dev DB 可能已由本檔以外之來源（跨 session 持久、或同一整套執行中先跑的
 * 其他 spec 檔）建立覆蓋 `dateStr` 的版本，故不可假設固定單價，一律以「目前
 * 生效日 ≤ dateStr 中最晚者」查詢實際值（同 `findEffectiveVersion` 之選版
 * 邏輯，此處以純資料重寫，不呼叫後端純函式）。
 */
async function getEffectiveEtcUnitPrice(page: Page, dateStr: string): Promise<number> {
  const res = await page.request.get(`${API_BASE}/parameters/etc`);
  const { versions } = (await res.json()) as {
    versions: { effectiveFrom: string; unitPrice: string }[];
  };
  const candidates = versions.filter((v) => v.effectiveFrom <= dateStr);
  if (candidates.length === 0) {
    throw new Error(`E2E 前置假設破壞：查無涵蓋 ${dateStr} 之 ETC 版本`);
  }
  candidates.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return Number(candidates[0].unitPrice);
}

/** 以 API 建立一個合成使用者，回傳 { id, loginName, displayName }。 */
async function createSyntheticUser(
  page: Page,
  namePrefix: string,
  tempPassword: string
): Promise<{ id: string; loginName: string; displayName: string }> {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const loginName = `e2e-${namePrefix}-${suffix}`;
  const displayName = `T13${namePrefix}使用者${suffix}`;
  const res = await page.request.post(`${API_BASE}/admin/users`, {
    data: { loginName, displayName, temporaryPassword: tempPassword },
  });
  if (!res.ok()) {
    throw new Error(`E2E 建立合成使用者失敗: ${res.status()} ${await res.text()}`);
  }
  const { user } = (await res.json()) as { user: { id: string } };
  return { id: user.id, loginName, displayName };
}

/** 以 API 登入並完成強制改密（若尚未改過）。 */
async function loginAndForceChangePassword(
  page: Page,
  loginName: string,
  tempPassword: string,
  newPassword: string
): Promise<void> {
  const loginRes = await page.request.post(`${API_BASE}/auth/login`, {
    data: { loginName, password: tempPassword },
  });
  if (!loginRes.ok()) {
    throw new Error(`E2E 使用者登入失敗: ${loginRes.status()} ${await loginRes.text()}`);
  }
  const changeRes = await page.request.post(`${API_BASE}/me/password`, {
    data: { currentPassword: tempPassword, newPassword },
  });
  if (!changeRes.ok()) {
    throw new Error(`E2E 使用者強制改密失敗: ${changeRes.status()} ${await changeRes.text()}`);
  }
}

/**
 * staff01 帳號被情境3/5/6 共用（同一真實 DB 使用者，跨測試持久化密碼狀態，
 * 不同於各自獨立的 browser context/cookie）。強制改密是「一次性」狀態轉移
 * ——若每個情境各自呼叫 `loginAndForceChangePassword`，第二次呼叫時目前密碼
 * 已是 `STAFF_NEW_PASSWORD` 而非 `STAFF_TEMP_PASSWORD`，會登入失敗。以模組層
 * 旗標追蹤是否已完成改密，之後的情境改直接以新密碼登入。
 */
let staffPasswordAlreadyChanged = false;
async function loginAsStaff(page: Page): Promise<void> {
  if (staffPasswordAlreadyChanged) {
    const res = await page.request.post(`${API_BASE}/auth/login`, {
      data: { loginName: staffLoginName, password: STAFF_NEW_PASSWORD },
    });
    if (!res.ok()) {
      throw new Error(`E2E staff01 登入失敗: ${res.status()} ${await res.text()}`);
    }
    return;
  }
  await loginAndForceChangePassword(page, staffLoginName, STAFF_TEMP_PASSWORD, STAFF_NEW_PASSWORD);
  staffPasswordAlreadyChanged = true;
}

test.describe("油資模型修正 — PHASE-005a Gate E2E（Spec §11.4）", () => {
  // 情境3/5/6 共用同一 staff01 真實帳號、依序累積前置狀態（改密、建立草稿）；
  // 以 serial 模式保證執行順序與 workers:1/fullyParallel:false 的既有慣例一致
  // （見 playwright.config.ts），避免未來設定調整後順序被打亂。
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await loginAsAdmin(adminPage);
    await ensureEtcParameterCovers(adminPage, TRIP_DATE);
    // T13R：GET /parameters/etc 為 admin-only，情境5執行時 page 已切換為
    // staff01 身分，故改於此（仍持有管理員 cookie 之 adminPage）先查好實際
    // 生效之 ETC 單價，供情境5動態計算手算基準使用（見該 test 之 JSDoc）。
    resolvedEtcUnitPrice = await getEffectiveEtcUnitPrice(adminPage, TRIP_DATE);

    const staff = await createSyntheticUser(adminPage, "staff01", STAFF_TEMP_PASSWORD);
    staffUserId = staff.id;
    staffLoginName = staff.loginName;
    staffDisplayName = staff.displayName;

    const noCons = await createSyntheticUser(adminPage, "nocons", NO_CONS_TEMP_PASSWORD);
    noConsumptionUserId = noCons.id;
    noConsumptionLoginName = noCons.loginName;
    noConsumptionDisplayName = noCons.displayName;

    // 前置確認（T13R）：第二帳號須確實「無油耗資料」——`createSyntheticUser`
    // 剛建立全新合成使用者，正常情況下必為空；以真實查詢（管理員權限，GET
    // /users/:userId/fuel-consumption 為 admin-only）取代假設，若前輪執行造成
    // 非預期污染會在此明確失敗，而非讓情境4靜默通過。
    const consRes = await adminPage.request.get(
      `${API_BASE}/users/${noConsumptionUserId}/fuel-consumption`
    );
    const { versions: noConsVersions } = (await consRes.json()) as { versions: unknown[] };
    if (noConsVersions.length !== 0) {
      throw new Error(
        `E2E 前置假設破壞：合成使用者 ${noConsumptionUserId} 應無油耗資料，實際卻有 ${noConsVersions.length} 筆`
      );
    }

    await adminContext.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsAdmin(page);

    for (const attId of createdAttachmentIds) {
      await page.request.delete(`${API_BASE}/attachments/${attId}`).catch(() => {});
    }
    // 已完成申請不可刪除（AC-06）；合成使用者一旦完成申請即恆有申請歷史，
    // 刪除使用者會 409（既有不可逆業務規則，同 mileage-statistics.spec.ts
    // 之 cleanup 註解）——best-effort 嘗試，失敗則忽略，不影響本檔通過與否。
    if (staffUserId) {
      await page.request.delete(`${API_BASE}/admin/users/${staffUserId}`).catch(() => {});
    }
    if (noConsumptionUserId) {
      await page.request.delete(`${API_BASE}/admin/users/${noConsumptionUserId}`).catch(() => {});
    }

    await context.close();
  });

  // ---- 情境1：管理員建立四油種油價版本 → 版本列表按油種正確呈現 ----
  test("情境1：管理員建立四油種油價版本→版本列表按油種正確呈現", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE}/admin/parameters`);
    await page.waitForURL(`${BASE}/admin/parameters`);

    for (const [fuelType, pricePerLiter] of Object.entries(FUEL_PRICE_BY_TYPE)) {
      // 冪等守衛：持久 dev DB 可能已由先前執行建立過同油種＋同生效日之版本
      // （見上方 fuelPriceVersionExists 註解）——已存在則略過表單送出。
      if (await fuelPriceVersionExists(page, fuelType, PARAM_EFFECTIVE_FROM)) {
        continue;
      }
      await page.selectOption("#fuel-fuelType", fuelType);
      await page.fill("#fuel-pricePerLiter", pricePerLiter);
      await page.fill("#fuel-effectiveFrom", PARAM_EFFECTIVE_FROM);
      await page.click('.param-form-card button:has-text("建立")');
      await expect(page.locator(".param-form-card .success-block")).toBeVisible({
        timeout: 10000,
      });
    }

    // 四油種各自分組呈現，且各自的價格出現在正確的分組內（AC-29）。
    for (const [fuelType, pricePerLiter] of Object.entries(FUEL_PRICE_BY_TYPE)) {
      const label = FUEL_TYPE_LABEL[fuelType];
      const group = page.locator(".fuel-price-group", { has: page.locator(`h4:text("${label}")`) });
      await expect(group.locator(`table[aria-label="${label} 油價版本清單"]`)).toBeVisible();
      await expect(group.getByText(pricePerLiter)).toBeVisible();
      await expect(group.getByText(PARAM_EFFECTIVE_FROM)).toBeVisible();
    }
  });

  // ---- 情境2：管理員為 staff01 建立油耗版本（含依據備註）→ 列表顯示 CURRENT ----
  test("情境2：管理員為staff01建立油耗版本（含依據備註）→列表顯示CURRENT", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE}/admin/users/${staffUserId}/fuel-consumption`);
    await page.waitForURL(`${BASE}/admin/users/${staffUserId}/fuel-consumption`);
    await expect(page.locator("h1")).toContainText(staffDisplayName);

    if (!(await fuelConsumptionVersionExists(page, staffUserId, PARAM_EFFECTIVE_FROM))) {
      await page.selectOption("#fc-fuelType", STAFF_FUEL_TYPE);
      await page.fill("#fc-kmPerLiter", STAFF_KM_PER_LITER);
      await page.fill("#fc-effectiveFrom", PARAM_EFFECTIVE_FROM);
      await page.fill("#fc-basisNote", STAFF_BASIS_NOTE);
      await page.click('button:has-text("建立")');
    } else {
      await page.reload();
      await page.waitForURL(`${BASE}/admin/users/${staffUserId}/fuel-consumption`);
    }

    const row = page.locator("table[aria-label='油耗版本清單'] tbody tr", {
      hasText: STAFF_BASIS_NOTE,
    });
    await expect(row).toHaveCount(1, { timeout: 10000 });
    await expect(row.locator(".status-badge")).toContainText("目前生效");
    await expect(row).toContainText(PARAM_EFFECTIVE_FROM);
    await expect(row).toContainText(FUEL_TYPE_LABEL[STAFF_FUEL_TYPE]);
  });

  // ---- 情境3：staff01 登入 → 個人頁看到油種／油耗／生效日，且無編輯入口 ----
  test("情境3：staff01登入→個人頁看到油種／油耗／生效日，且無編輯入口", async ({ page }) => {
    await loginAsStaff(page);
    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);

    const section = page.locator(".my-fuel-consumption-section");
    await expect(section).toBeVisible();
    await expect(section).toContainText(FUEL_TYPE_LABEL[STAFF_FUEL_TYPE]);
    await expect(section).toContainText(STAFF_KM_PER_LITER);
    await expect(section).toContainText(PARAM_EFFECTIVE_FROM);

    // AC-31 ③：無任何新增／修改／刪除入口——本區塊不存在任何 button/input/a。
    expect(await section.locator("button").count()).toBe(0);
    expect(await section.locator("input").count()).toBe(0);
    expect(await section.locator("a").count()).toBe(0);
  });

  // ---- 情境4：staff01 建差旅草稿；以「未建油耗之第二帳號」重現缺油耗 → 完成被擋 ----
  test("情境4：以未建油耗之第二帳號建差旅草稿→完成被擋且提示為「建立油耗資料」", async ({
    page,
  }) => {
    await loginAndForceChangePassword(
      page,
      noConsumptionLoginName,
      NO_CONS_TEMP_PASSWORD,
      NO_CONS_NEW_PASSWORD
    );
    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);
    await page.click('a:has-text("新增差旅補助")');
    await page.waitForURL(/\/applications\/travel\/(?!new)[^/]+$/, { timeout: 15000 });
    const url = new URL(page.url());
    const draftId = url.pathname.split("/").pop() as string;
    createdApplicationIds.push(draftId);

    const suffix = Date.now().toString(36);
    const purpose = `情境4缺油耗測試${suffix}`;
    await page.fill("#trip-date", TRIP_DATE);
    await page.fill("#trip-purpose", purpose);

    await page.click('button:has-text("新增行程段")');
    const segment = page.locator(".trip-segment").first();
    await segment.getByLabel("出發地點").fill("台北");
    await segment.getByLabel("到達地點").fill("桃園");
    await segment.getByLabel("總里程（公里）").fill(TRIP_TOTAL_KM);
    await segment.getByLabel("高速里程（公里）").fill(TRIP_HIGHWAY_KM);

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      segment.locator('button:has-text("選擇圖片")').click(),
    ]);
    await fileChooser.setFiles({
      name: "trip-photo.jpg",
      mimeType: "image/jpeg",
      buffer: MINIMAL_JPEG,
    });
    const uploadedImg = segment.locator('img[alt="trip-photo.jpg"]');
    await expect(uploadedImg).toBeVisible({ timeout: 15000 });
    const src = await uploadedImg.getAttribute("src");
    const match = src?.match(/\/api\/attachments\/([^/]+)\/thumbnail/);
    if (match?.[1]) createdAttachmentIds.push(match[1]);

    await page.click('button:has-text("儲存草稿")');
    await expect(page.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });

    // 缺油耗提示先於嘗試完成即已可見（草稿頁「尚未完成項目」區塊照實顯示
    // completionBlockers，見 backend/src/applications/completion-blockers.ts
    // 之 FUEL_CONSUMPTION_NOT_AVAILABLE 逐字文案「出差日期缺少您的車輛油耗
    // 資料，請聯絡管理員建立」——T13R 修正：原斷言 `/建立油耗資料/` 誤植，與
    // 此逐字文案不符，前端 AC-32 自身之對應訊息因 AR-4 去重機制恆被抑制
    // （儲存後之 completionBlockers 恆含 FUEL_CONSUMPTION_NOT_AVAILABLE，見
    // 該檔 buildCompletionBlockers），故本頁實際只會顯示此區塊之訊息）。
    await expect(page.getByText(/車輛油耗資料/)).toBeVisible({ timeout: 10000 });

    // 嘗試完成 → 被擋（C4 二次確認）。前端對 `PARAMETER_NOT_AVAILABLE` 一律
    // 顯示固定泛用文案（TravelApplicationPage.tsx `handleComplete` 之
    // `apiErr.code === "PARAMETER_NOT_AVAILABLE"` 分支，不論後端
    // `details.missing` 內容為何，恆顯示同一段文字）——T13R 修正：原斷言
    // `/油耗資料/` 誤植，與此固定文案不符（同 travel-application.spec.ts
    // 情境2 之既有斷言逐字一致，屬既有、非本 Task 改動之前端行為）。
    await page.click('button:has-text("完成申請")');
    const confirmDialog = page.getByRole("dialog", { name: "確認完成申請" });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.locator('button:has-text("確認完成")').click();
    await expect(confirmDialog.locator(".error-block")).toContainText(
      "該出差日期尚無有效補助參數，請聯絡管理員設定。",
      { timeout: 10000 }
    );

    // 未完成——仍為草稿頁面（未跳轉、未變成唯讀檢視）。
    await expect(page.locator("h1")).toContainText("差旅補助申請（草稿）");
  });

  // ---- 情境5：staff01 完成差旅 → 金額等於以推導單價手算之值 ----
  test("情境5：staff01完成差旅→金額等於以推導單價手算之值", async ({ page }) => {
    await loginAsStaff(page);
    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);
    await page.click('a:has-text("新增差旅補助")');
    await page.waitForURL(/\/applications\/travel\/(?!new)[^/]+$/, { timeout: 15000 });
    const url = new URL(page.url());
    const draftId = url.pathname.split("/").pop() as string;
    createdApplicationIds.push(draftId);

    const suffix = Date.now().toString(36);
    const purpose = `情境5完成差旅測試${suffix}`;
    await page.fill("#trip-date", TRIP_DATE);
    await page.fill("#trip-purpose", purpose);

    await page.click('button:has-text("新增行程段")');
    const segment = page.locator(".trip-segment").first();
    await segment.getByLabel("出發地點").fill("台北");
    await segment.getByLabel("到達地點").fill("新竹");
    await segment.getByLabel("總里程（公里）").fill(TRIP_TOTAL_KM);
    await segment.getByLabel("高速里程（公里）").fill(TRIP_HIGHWAY_KM);

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      segment.locator('button:has-text("選擇圖片")').click(),
    ]);
    await fileChooser.setFiles({
      name: "trip-photo.jpg",
      mimeType: "image/jpeg",
      buffer: MINIMAL_JPEG,
    });
    const uploadedImg = segment.locator('img[alt="trip-photo.jpg"]');
    await expect(uploadedImg).toBeVisible({ timeout: 15000 });
    const src = await uploadedImg.getAttribute("src");
    const match = src?.match(/\/api\/attachments\/([^/]+)\/thumbnail/);
    if (match?.[1]) createdAttachmentIds.push(match[1]);

    // T13R 修復：ETC 為全站單一時間軸，dev DB 可能已有涵蓋 TRIP_DATE 的既有
    // 版本（非本檔建立、單價非本檔可控，見 getEffectiveEtcUnitPrice 之
    // JSDoc）——手算基準須以「實際生效之 ETC 單價」動態計算，不可假設固定值。
    // fuelUnitPrice=3 為本檔自建之油耗/油價版本推導而得，恆固定（見上方常數
    // 註解）；ETC 部分改用 beforeAll（管理員身分）已查得之 resolvedEtcUnitPrice
    // ——GET /parameters/etc 為 admin-only，本 test 此時之 page 已切換為
    // staff01 身分，不可在此以 page 直接查詢。
    const expectedAmount = Math.round(
      STAFF_FUEL_UNIT_PRICE * Number(TRIP_TOTAL_KM) + resolvedEtcUnitPrice * Number(TRIP_HIGHWAY_KM)
    );

    // 預覽金額（草稿階段之後端試算，D8）先確認非 0（§11.3 不自算鑑別之
    // 真實佐證——若前端自算，因前端從不知道 fuelUnitPrice=3，不可能巧合
    // 得出與後端一致之值）。
    const previewSection = page.locator("section[aria-labelledby='preview-total-heading']");
    await expect(previewSection.locator("strong")).toContainText(`合計金額：${expectedAmount}`, {
      timeout: 10000,
    });

    await page.click('button:has-text("儲存草稿")');
    await expect(page.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });

    await page.click('button:has-text("完成申請")');
    const confirmDialog = page.getByRole("dialog", { name: "確認完成申請" });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.locator('button:has-text("確認完成")').click();

    await expect(page.locator("h1")).toContainText("差旅補助申請（已完成）", { timeout: 10000 });

    // 快照區塊：金額等於手算值（AC-19/25：後端唯一權威、恰兩處取整）。
    // 注意（AR-3 已知缺口，見檔頭 JSDoc）：快照三來源值
    // （snapshotFuelType/snapshotFuelPricePerLiter/snapshotFuelConsumption）
    // 目前前端未接線顯示，故本測試不驗證該三值之呈現，僅驗證金額。
    const snapshotSection = page.locator("section[aria-labelledby='snapshot-heading']");
    await expect(snapshotSection).toBeVisible();
    await expect(snapshotSection).toContainText(String(expectedAmount));
  });

  // ---- 情境6：375px 無水平溢位（三個畫面） ----
  test("情境6：響應式375px——油價頁／油耗維護頁／個人區塊body皆無水平溢位", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    // 油價頁（管理員）。
    await loginAsAdmin(page);
    await page.goto(`${BASE}/admin/parameters`);
    await page.waitForURL(`${BASE}/admin/parameters`);
    await expect(page.locator("#fuel-fuelType")).toBeVisible();
    const paramsOverflow = await page.evaluate(
      () => document.body.scrollWidth <= window.innerWidth
    );
    expect(paramsOverflow).toBe(true);

    // 油耗維護頁（管理員）。
    await page.goto(`${BASE}/admin/users/${staffUserId}/fuel-consumption`);
    await page.waitForURL(`${BASE}/admin/users/${staffUserId}/fuel-consumption`);
    await expect(page.locator("#fc-fuelType")).toBeVisible();
    const fuelConsumptionOverflow = await page.evaluate(
      () => document.body.scrollWidth <= window.innerWidth
    );
    expect(fuelConsumptionOverflow).toBe(true);

    // 個人區塊（staff01 登出管理員後登入——避免 /login 偵測既有 session 自動導回）。
    await page.request.post(`${API_BASE}/auth/logout`).catch(() => {});
    await loginAsStaff(page);
    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);
    await expect(page.locator(".my-fuel-consumption-section")).toBeVisible();
    const homeOverflow = await page.evaluate(() => document.body.scrollWidth <= window.innerWidth);
    expect(homeOverflow).toBe(true);
  });
});
