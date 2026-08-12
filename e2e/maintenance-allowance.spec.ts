/**
 * E2E: 保養費用分攤 — PHASE-006-T14 Gate E2E（Spec §11.4、§15 T14）
 *
 * 涵蓋：
 *   - AC-41（情境1~6，六 it）：Spec §2 AC-41 逐字八步驟——
 *     ①播種一筆該期間內之已完成差旅 → ②建立保養草稿（部分欄位）→
 *     ③補齊四欄 → ④上傳 1 張證明 → ⑤預覽顯示四值 → ⑥完成 →
 *     ⑦詳情顯示快照四值且附件無刪除入口 → ⑧再次嘗試修改得 403。
 *     六個 it 依序累積同一筆保養草稿之前置狀態（同一合成使用者、同一
 *     applicationId），以 `test.describe.configure({ mode: "serial" })`
 *     保證執行順序（同 fuel-model.spec.ts 既有慣例，與
 *     playwright.config.ts 的 `fullyParallel: false` / `workers: 1` 一致）。
 *   - AC-38（情境7，375px）：保養表單／預覽區塊／證明區塊（同一頁面，三者
 *     皆為同一 DOM 文件的區塊，非獨立路由）與保養詳情頁（獨立路由）之
 *     `body.scrollWidth <= window.innerWidth`。
 *
 * 播種冪等（沿 PHASE-005a T13R 教訓）：合成使用者以隨機後綴建立（每次執行
 * 皆為全新使用者，業務資料天然不衝突，同 fuel-model.spec.ts 既有作法）；
 * 全域參數版本（油價／ETC）無 DELETE 端點，故一律「先查後建」，重複執行
 * 整套 E2E 不會因既有版本而 409 PARAMETER_PERIOD_OVERLAP。
 *
 * 金額手算（測試端獨立計算，§11.3/§11「前端零自算」之 E2E 對應鑑別）：
 *   lastOdometerKm=10000.00, currentOdometerKm=11000.00 → intervalKm=1000.00
 *   （唯一一筆已完成差旅之）totalKm=250.00 → officialKm=250.00
 *   ratio=250.00÷1000.00=0.250000 → ratioPercent="25.0000"
 *   actualCost=4000.00 → rawAmount=4000×250÷1000=1000.0000 →
 *   amount=ROUND_HALF_UP(1000.0000,0)=1000（整數，無條件無取整歧義）
 * 上述選值刻意避開 `.5` 取整邊界，讓手算鏈在整數運算下即可精確重現，不依賴
 * 任何後端內部推導細節（比照 PHASE-005a-T13R 之選值原則）。
 *
 * Topology / Test account：大總管已啟動之 dev 拓撲（backend :3000、
 * Vite :5173）；管理員帳號沿用既有 E2E 慣例（e2eadmin，同其他 e2e 檔）；
 * 合成保養使用者以 `e2e-maint-<random>` 命名。
 */

import { type Page, expect, test } from "@playwright/test";
import { generateRunSuffix, loginAsAdmin } from "./helpers";

const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";

// ---------------------------------------------------------------------------
// 日期（動態相對日期，避免寫死日曆日期隨系統時間推移而失效——同
// travel-application.spec.ts SUCCESS_TRIP_DATE 之既有教訓/註解）。
// ---------------------------------------------------------------------------
function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
const MAINT_LAST_DATE = isoDateDaysAgo(60);
const MAINT_CURRENT_DATE = isoDateDaysAgo(0);
const TRIP_DATE = isoDateDaysAgo(30); // 落在 [MAINT_LAST_DATE, MAINT_CURRENT_DATE] 區間內（含端點）

const PARAM_EFFECTIVE_FROM = "2020-06-01"; // 早於 TRIP_DATE，沿既有慣例之固定生效日
const FUEL_TYPE = "GASOLINE_92";
const FUEL_KM_PER_LITER = "10.0000";
const FUEL_PRICE_PER_LITER = "65.0000";
const ETC_UNIT_PRICE = 1.8;
const FUEL_BASIS_NOTE = "PHASE-006-T14 E2E 合成資料（保養 Gate E2E 播種用）";

// 手算基準值（見檔頭 JSDoc）
const LAST_ODOMETER_KM = "10000.00";
const CURRENT_ODOMETER_KM = "11000.00";
const ACTUAL_COST = "4000.00";
const TRIP_TOTAL_KM = "250.00";
const TRIP_HIGHWAY_KM = "200.00";
const EXPECTED_INTERVAL_KM = "1000.00";
const EXPECTED_OFFICIAL_KM = "250.00";
const EXPECTED_RATIO_PERCENT = "25.0000";
const EXPECTED_AMOUNT = "1000";

// ---------------------------------------------------------------------------
// Helpers（沿 fuel-model.spec.ts / travel-application.spec.ts 既有模式）
// ---------------------------------------------------------------------------

async function createSyntheticUser(
  page: Page,
  tempPassword: string
): Promise<{ id: string; loginName: string }> {
  const suffix = generateRunSuffix();
  const loginName = `e2e-maint-${suffix}`;
  const displayName = `T14保養使用者${suffix}`;
  const res = await page.request.post(`${API_BASE}/admin/users`, {
    data: { loginName, displayName, temporaryPassword: tempPassword },
  });
  if (!res.ok()) {
    throw new Error(`E2E 建立合成使用者失敗: ${res.status()} ${await res.text()}`);
  }
  const { user } = (await res.json()) as { user: { id: string } };
  return { id: user.id, loginName };
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
    data: { fuelType, pricePerLiter: FUEL_PRICE_PER_LITER, effectiveFrom: PARAM_EFFECTIVE_FROM },
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
    data: { unitPrice: ETC_UNIT_PRICE, effectiveFrom: PARAM_EFFECTIVE_FROM },
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
      effectiveFrom: PARAM_EFFECTIVE_FROM,
      basisNote: FUEL_BASIS_NOTE,
    },
  });
  if (!createRes.ok()) {
    throw new Error(`E2E 設定油耗版本失敗: ${createRes.status()} ${await createRes.text()}`);
  }
}

/**
 * staffPassword 一次性狀態轉移（同 fuel-model.spec.ts 既有教訓：合成使用者
 * 跨 it 共用同一真實帳號，第二次呼叫時原本的臨時密碼已失效）。
 */
let staffPasswordAlreadyChanged = false;
const STAFF_TEMP_PASSWORD = "TempPw@2026Maint!";
const STAFF_NEW_PASSWORD = "NewPw@2026Maint!";

async function loginAsStaff(page: Page, loginName: string): Promise<void> {
  if (staffPasswordAlreadyChanged) {
    const res = await page.request.post(`${API_BASE}/auth/login`, {
      data: { loginName, password: STAFF_NEW_PASSWORD },
    });
    if (!res.ok()) {
      throw new Error(`E2E 合成保養使用者登入失敗: ${res.status()} ${await res.text()}`);
    }
    return;
  }
  const loginRes = await page.request.post(`${API_BASE}/auth/login`, {
    data: { loginName, password: STAFF_TEMP_PASSWORD },
  });
  if (!loginRes.ok()) {
    throw new Error(
      `E2E 合成保養使用者首次登入失敗: ${loginRes.status()} ${await loginRes.text()}`
    );
  }
  const changeRes = await page.request.post(`${API_BASE}/me/password`, {
    data: { currentPassword: STAFF_TEMP_PASSWORD, newPassword: STAFF_NEW_PASSWORD },
  });
  if (!changeRes.ok()) {
    throw new Error(
      `E2E 合成保養使用者強制改密失敗: ${changeRes.status()} ${await changeRes.text()}`
    );
  }
  staffPasswordAlreadyChanged = true;
}

/**
 * 播種①：以 API 建立並完成一筆單段差旅（`TRIP_TOTAL_KM`），落在保養區間
 * `[MAINT_LAST_DATE, MAINT_CURRENT_DATE]` 內——非本測試之驗證標的（差旅本身
 * 之計算已由 PHASE-004/005a Gate E2E 覆蓋），純粹作為期間公務里程之播種資料，
 * 故以 API 直接建立而非走差旅 UI（縮短本檔執行時間、避免與保養本身的 UI
 * 走查混淆）。呼叫端須已以合成使用者身分登入（`page` cookie）。
 */
async function seedCompletedTravel(page: Page): Promise<void> {
  const createRes = await page.request.post(`${API_BASE}/applications/travel`, { data: {} });
  if (!createRes.ok()) {
    throw new Error(`E2E 播種差旅建立失敗: ${createRes.status()} ${await createRes.text()}`);
  }
  const { application } = (await createRes.json()) as { application: { id: string } };
  const tripId = application.id;

  // 差旅完成需每段皆有 Google Maps 截圖（SEGMENT_ATTACHMENT_REQUIRED，非本
  // Task 驗證標的，純播種所需的前置條件）——先上傳一張再於段落 PUT 內關聯。
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
      purpose: "PHASE-006-T14 保養 Gate E2E 播種差旅",
      segments: [
        {
          origin: "台北總公司",
          destination: "新竹辦事處",
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

/** `<dl class="detail-list">` 內 `dt`/`dd` 依序配對讀出（同 travel-application.spec.ts 既有慣例）。 */
async function readDetailList(scope: ReturnType<Page["locator"]>): Promise<Record<string, string>> {
  const dts = await scope.locator("dt").allTextContents();
  const dds = await scope.locator("dd").allTextContents();
  const result: Record<string, string> = {};
  dts.forEach((k, i) => {
    result[k] = dds[i] ?? "";
  });
  return result;
}

// ---------------------------------------------------------------------------
// 模組層共用狀態（六 it 依序累積同一筆保養草稿之前置狀態）
// ---------------------------------------------------------------------------
let staffUserId: string;
let staffLoginName: string;
let maintenanceApplicationId: string;

test.describe("保養費用分攤 — PHASE-006 Gate E2E", () => {
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
  });

  test.afterAll(async ({ browser }) => {
    // Best-effort：合成使用者一旦完成過差旅/保養申請即恆有申請歷史，刪除會
    // 409（既有不可逆業務規則，同 fuel-model.spec.ts 既有 cleanup 註解）。
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsAdmin(page);
    if (staffUserId) {
      await page.request.delete(`${API_BASE}/admin/users/${staffUserId}`).catch(() => {});
    }
    await context.close();
  });

  // -------------------------------------------------------------------------
  // 情境1（AC-41 ①②）：播種一筆期間內已完成差旅 → 建立保養草稿（部分欄位：
  // 僅填「上次保養日期」）
  // -------------------------------------------------------------------------
  test("情境1：播種一筆期間內之已完成差旅→建立保養草稿（部分欄位：僅填上次保養日期）", async ({
    page,
  }) => {
    await loginAsStaff(page, staffLoginName);
    await seedCompletedTravel(page);

    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);
    await page.click('a:has-text("新增保養費用申請")');
    await page.waitForURL(/\/applications\/maintenance\/(?!new)[^/]+$/, { timeout: 15000 });
    await expect(page.locator("h1")).toContainText("保養費用申請（草稿）");

    const url = new URL(page.url());
    maintenanceApplicationId = url.pathname.split("/").pop() as string;

    await page.fill("#last-maintenance-date", MAINT_LAST_DATE);
    await page.click('button:has-text("儲存草稿")');
    await expect(page.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });
  });

  // -------------------------------------------------------------------------
  // 情境2（AC-41 ③）：補齊其餘四欄（本次保養日期／上次里程表／本次里程表／
  // 本次實際保養費用）並儲存
  // -------------------------------------------------------------------------
  test("情境2：補齊本次保養日期／上次里程表／本次里程表／實際保養費用四欄並儲存", async ({
    page,
  }) => {
    await loginAsStaff(page, staffLoginName);
    await page.goto(`${BASE}/applications/maintenance/${maintenanceApplicationId}`);
    await page.waitForURL(`${BASE}/applications/maintenance/${maintenanceApplicationId}`);
    await expect(page.locator("#last-maintenance-date")).toHaveValue(MAINT_LAST_DATE);

    await page.fill("#current-maintenance-date", MAINT_CURRENT_DATE);
    await page.fill("#last-odometer-km", LAST_ODOMETER_KM);
    await page.fill("#current-odometer-km", CURRENT_ODOMETER_KM);
    await page.fill("#actual-cost", ACTUAL_COST);

    await page.click('button:has-text("儲存草稿")');
    await expect(page.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });
  });

  // -------------------------------------------------------------------------
  // 情境3（AC-41 ④）：上傳 1 張保養證明（FW 必辦：上傳完成後再點「儲存草稿」
  // ——完成鈕之附件缺項判定讀取已存 completionBlockers，「已上傳但尚未儲存
  // 草稿」時完成鈕仍停用）
  // -------------------------------------------------------------------------
  test("情境3：上傳一張保養證明並儲存草稿", async ({ page }) => {
    await loginAsStaff(page, staffLoginName);
    await page.goto(`${BASE}/applications/maintenance/${maintenanceApplicationId}`);
    await page.waitForURL(`${BASE}/applications/maintenance/${maintenanceApplicationId}`);

    const jpegBuffer = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ]);
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.click('button:has-text("選擇圖片")'),
    ]);
    await fileChooser.setFiles({
      name: "maintenance-proof.jpg",
      mimeType: "image/jpeg",
      buffer: jpegBuffer,
    });

    const uploadedImg = page.locator('img[alt="maintenance-proof.jpg"]');
    await expect(uploadedImg).toBeVisible({ timeout: 15000 });

    // AR-1（FW 必辦）：上傳完成後再點「儲存草稿」，避免上傳/儲存競態。
    await page.click('button:has-text("儲存草稿")');
    await expect(page.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });
  });

  // -------------------------------------------------------------------------
  // 情境4（AC-41 ⑤）：預覽顯示保養區間總里程／期間公務里程／公務使用比例／
  // 公司分攤金額四值（後端權威值，見檔頭手算基準）
  // -------------------------------------------------------------------------
  test("情境4：預覽顯示保養區間總里程／期間公務里程／公務使用比例／公司分攤金額四值", async ({
    page,
  }) => {
    await loginAsStaff(page, staffLoginName);
    await page.goto(`${BASE}/applications/maintenance/${maintenanceApplicationId}`);
    await page.waitForURL(`${BASE}/applications/maintenance/${maintenanceApplicationId}`);

    const previewSection = page.locator("section[aria-labelledby='preview-heading']");
    await expect(previewSection.locator("dt")).toHaveCount(4, { timeout: 10000 });
    const preview = await readDetailList(previewSection);
    expect(preview.保養區間總里程).toBe(EXPECTED_INTERVAL_KM);
    expect(preview.期間公務里程).toBe(EXPECTED_OFFICIAL_KM);
    expect(preview.公務使用比例).toBe(`${EXPECTED_RATIO_PERCENT}%`);
    expect(preview.公司分攤金額).toBe(EXPECTED_AMOUNT);
  });

  // -------------------------------------------------------------------------
  // 情境5（AC-41 ⑥⑦）：完成申請（C4 二次確認）→ 詳情顯示快照四值，且附件
  // 區塊無任何上傳／刪除入口（負向斷言）
  // -------------------------------------------------------------------------
  test("情境5：完成申請→詳情顯示快照四值且附件無刪除入口", async ({ page }) => {
    await loginAsStaff(page, staffLoginName);
    await page.goto(`${BASE}/applications/maintenance/${maintenanceApplicationId}`);
    await page.waitForURL(`${BASE}/applications/maintenance/${maintenanceApplicationId}`);

    await page.click('button:has-text("完成申請")');
    const confirmDialog = page.getByRole("dialog", { name: "確認完成申請" });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.locator('button:has-text("確認完成")').click();

    await expect(page.locator("h1")).toContainText("保養費用申請（已完成）", { timeout: 10000 });

    const snapshotSection = page.locator("section[aria-labelledby='snapshot-heading']");
    await expect(snapshotSection).toBeVisible();
    const snapshot = await readDetailList(snapshotSection);
    expect(snapshot.保養區間總里程).toBe(EXPECTED_INTERVAL_KM);
    expect(snapshot.期間公務里程).toBe(EXPECTED_OFFICIAL_KM);
    expect(snapshot.公務使用比例).toBe(`${EXPECTED_RATIO_PERCENT}%`);
    expect(snapshot.公司分攤金額).toBe(EXPECTED_AMOUNT);

    // 附件區塊：僅唯讀縮圖清單，無任何上傳／刪除入口（AC-36 COMPLETED 分支之
    // 負向斷言，同 MaintenanceApplicationPage.tsx COMPLETED 分支之明文設計）。
    const attachmentsSection = page.locator(
      "section[aria-labelledby='maintenance-attachments-heading']"
    );
    await expect(attachmentsSection.locator('img[alt="maintenance-proof.jpg"]')).toBeVisible();
    expect(await page.locator('input[type="file"]').count()).toBe(0);
    expect(await attachmentsSection.getByRole("button", { name: /刪除/ }).count()).toBe(0);
    expect(await attachmentsSection.getByRole("button", { name: /選擇圖片/ }).count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 情境6（AC-41 ⑧）：再次嘗試修改（PUT）已完成之保養申請 → 403，零寫入
  // （沿 AC-04 既有不可變語意）
  // -------------------------------------------------------------------------
  test("情境6：再次嘗試修改已完成之保養申請→403", async ({ page }) => {
    await loginAsStaff(page, staffLoginName);

    const res = await page.request.put(
      `${API_BASE}/applications/maintenance/${maintenanceApplicationId}`,
      { data: { actualCost: "9999.99" } }
    );
    expect(res.status()).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("已完成的申請不可修改，請建立修正版");

    // 確認真的沒有被寫入（金額仍是快照值，非上面嘗試送出的 9999.99）。
    const getRes = await page.request.get(
      `${API_BASE}/applications/maintenance/${maintenanceApplicationId}`
    );
    expect(getRes.ok()).toBe(true);
    const { application } = (await getRes.json()) as {
      application: { actualCost: string; snapshot: { totalAmount: number } };
    };
    expect(application.actualCost).toBe(ACTUAL_COST);
    expect(application.snapshot.totalAmount).toBe(Number(EXPECTED_AMOUNT));
  });

  // -------------------------------------------------------------------------
  // 情境7（AC-38）：375px 無水平溢位——保養表單／預覽區塊／證明區塊（同一
  // 草稿頁面之三個區塊）與保養詳情頁（獨立路由，複用情境5已完成之申請）。
  // -------------------------------------------------------------------------
  test("情境7：響應式 375px——保養表單／預覽／證明／詳情 body 皆無水平溢位", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAsStaff(page, staffLoginName);

    // 保養表單／預覽區塊／證明區塊：建立一筆新草稿以同時檢視三者（同一 DOM
    // 文件，非獨立路由）。
    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);
    await page.click('a:has-text("新增保養費用申請")');
    await page.waitForURL(/\/applications\/maintenance\/(?!new)[^/]+$/, { timeout: 15000 });
    await expect(page.locator("h1")).toContainText("保養費用申請（草稿）");
    await expect(page.locator("section[aria-labelledby='maintenance-form-heading']")).toBeVisible();
    await expect(page.locator("section[aria-labelledby='preview-heading']")).toBeVisible();
    await expect(
      page.locator("section[aria-labelledby='maintenance-attachments-heading']")
    ).toBeVisible();

    const draftOverflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth);
    expect(draftOverflow).toBe(false);

    // 保養詳情（已完成，獨立路由）：複用情境5建立的已完成申請。
    await page.goto(`${BASE}/applications/maintenance/${maintenanceApplicationId}`);
    await page.waitForURL(`${BASE}/applications/maintenance/${maintenanceApplicationId}`);
    await expect(page.locator("h1")).toContainText("保養費用申請（已完成）");

    const detailOverflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth);
    expect(detailOverflow).toBe(false);
  });
});
