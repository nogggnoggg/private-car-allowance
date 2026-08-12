/**
 * E2E: 區間公務里程統計 — PHASE-005-T8 Gate E2E（Spec §11.4，六情境）
 *
 * 涵蓋 Spec §11.4 全部 6 條情境（本檔為該節的落地）：
 *   1. 使用者登入 → 建 2 筆差旅並完成（不同出差日期）→ 統計區塊選擇涵蓋兩筆
 *      之區間 → 顯示正確總里程。
 *   2. 邊界：把起日設為兩筆之間的日期 → 只剩一筆之里程。
 *   3. 起 > 迄 → 顯示區間錯誤提示，不顯示數值。
 *   4. 空區間 → 顯示 `0.00 公里` 與說明文案。
 *   5. 管理員：進入 `/admin/users/:userId/applications` → 選區間 → 顯示該
 *      使用者統計（非管理員自己，AC-31）。
 *   6. 響應式：375px viewport 下 `document.body.scrollWidth <= window.innerWidth`
 *      （AC-32），HomePage 與管理員頁各驗一次。
 *
 * 隔離策略：情境1/2/4 都以查詢「自己」的統計為準（`MileageSummarySection`
 * 省略 `ownerId` → 後端預設 `appliedFilters.ownerId = actor.id`，AC-25），
 * 而後端聚合本就以 `ownerId` 精確篩選（PHASE-005 引擎層 AC-06）——因此只要
 * 使用一個**全新建立的合成使用者**（過去從無任何差旅紀錄），無論 DB 內其他
 * E2E／既有資料筆數多寡，該使用者名下的統計恆為「只含本檔建立的 2 筆」，
 * 情境4的「空區間」也不需要挑選特別冷門的日期——只要日期範圍不落在情境1/2
 * 建立的兩個出差日期即可，因為 ownerId 本身已提供完整隔離（沿用
 * `e2e/admin-applications.spec.ts`／`e2e/data-isolation.spec.ts` 之合成使用者
 * 慣例）。
 *
 * Topology / Test account: 同 attachments-demo.spec.ts（e2eadmin，見該檔檔頭）。
 * 本檔額外以 `POST /admin/users`（既有 PHASE-002 端點）建立一個專屬合成使用
 * 者作為統計對象，並透過 `page.request`（與該 context 之 `page.goto` 共用
 * cookie jar）以 API 完成登入、強制改密、建立與完成差旅——不透過 UI 表單，
 * 只有「統計查詢」本身才透過真實瀏覽器操作（這是本檔唯一需要真人瀏覽器行
 * 為佐證的部分：AC-31 之 ownerId 綁定、AC-32 之版面溢位，皆非 jsdom 單元測
 * 試能證明）。
 */

import { type Page, expect, test } from "@playwright/test";
import { loginAsAdmin } from "./helpers";

const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";

/** Minimal valid 1x1 JPEG (real FF D8 FF header) — 同 travel-application.spec.ts。 */
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

// ---------------------------------------------------------------------------
// 出差日期／參數覆蓋 —— T-1（較早）、T-2（較晚，T-1 之後 2 天）。
// 兩者皆須有有效油資／ETC 參數版本覆蓋（否則無法「完成」）。
// ---------------------------------------------------------------------------
const TRIP_DATE_1 = "2027-05-10"; // 較早的一筆
const TRIP_DATE_2 = "2027-05-12"; // 較晚的一筆（與 T-1 相差 2 天）
const BOUNDARY_DATE = "2027-05-11"; // 恰在兩者之間（情境2：起日設為此日）
const RANGE_FROM = "2027-05-01";
const RANGE_TO = "2027-05-31";
const EMPTY_FROM = "2020-01-01"; // 空區間（不含 T-1/T-2，且 ownerId 隔離已足夠，不需刻意挑冷門日）
const EMPTY_TO = "2020-01-02";

const PARAM_EFFECTIVE_FROM = "2021-01-01";
const PARAM_ETC_UNIT_PRICE = 1.5;

// ---------------------------------------------------------------------------
// PHASE-005a-T13R：新油資模型播種（AC-37(e)，同 travel-application.spec.ts／
// admin-applications.spec.ts 之理由）——本檔統計數值以「里程」為準（totalKm
// 加總），與油資金額無關，故播種數值無需與任何舊制單價換算等值，僅需使
// 完成流程之油資解析不再缺項即可。刻意選用與另二檔不同的油種（DIESEL）。
// ---------------------------------------------------------------------------
const NEW_MODEL_EFFECTIVE_FROM = PARAM_EFFECTIVE_FROM;
const NEW_MODEL_FUEL_TYPE = "DIESEL";
const NEW_MODEL_KM_PER_LITER = "10.0000";
const NEW_MODEL_PRICE_PER_LITER = "50.0000";
const NEW_MODEL_BASIS_NOTE = "PHASE-005a-T13R E2E 合成資料（新油資模型播種）";

// Trip 1: totalKm 50.00；Trip 2: totalKm 70.00 → 合計 120.00（情境1）。
const TRIP_1_TOTAL_KM = "50.00";
const TRIP_1_HIGHWAY_KM = "30.00";
const TRIP_2_TOTAL_KM = "70.00";
const TRIP_2_HIGHWAY_KM = "40.00";

let targetUserId = "";
let targetDisplayName = "";
let targetLoginName = "";
const TARGET_PASSWORD = "E2eMileageT8@789!";
const createdApplicationIds: string[] = [];
const createdAttachmentIds: string[] = [];

// CHORE-E2E-BOOTSTRAP：`POST /parameters/fuel` 已於 PHASE-005a-T3b（§16
// D1(a)、AC-37）退場回 404——油資本身之覆蓋改由下方 `ensureFuelModelCoversDate`
// 負責（新模型：擁有人油耗版本 → 對應油種油價版本），本函式僅餘 ETC。
async function ensureParametersCoverDate(page: Page, dateStr: string): Promise<void> {
  const etcRes = await page.request.get(`${API_BASE}/parameters/etc`);
  const { versions: etcVersions } = (await etcRes.json()) as {
    versions: { effectiveFrom: string }[];
  };
  const covers = (versions: { effectiveFrom: string }[]) =>
    versions.some((v) => v.effectiveFrom <= dateStr);

  if (!covers(etcVersions)) {
    const res = await page.request.post(`${API_BASE}/parameters/etc`, {
      data: { unitPrice: PARAM_ETC_UNIT_PRICE, effectiveFrom: PARAM_EFFECTIVE_FROM },
    });
    if (!res.ok()) throw new Error(`E2E 設定 ETC 參數失敗: ${res.status()} ${await res.text()}`);
  }
}

/**
 * 以 API 建立一筆已完成的差旅（呼叫者本人為 owner）。回傳建立的 application id。
 * 需先滿足 SEGMENT_ATTACHMENT_REQUIRED（每段須至少一張附件）才能完成。
 */
async function createCompletedTrip(
  page: Page,
  opts: { tripDate: string; purpose: string; totalKm: string; highwayKm: string }
): Promise<string> {
  const createRes = await page.request.post(`${API_BASE}/applications/travel`, { data: {} });
  if (!createRes.ok()) {
    throw new Error(`建立草稿失敗: ${createRes.status()} ${await createRes.text()}`);
  }
  const { application } = (await createRes.json()) as { application: { id: string } };
  const appId = application.id;
  createdApplicationIds.push(appId);

  const uploadRes = await page.request.post(`${API_BASE}/attachments`, {
    multipart: {
      file: { name: "mileage-e2e.jpg", mimeType: "image/jpeg", buffer: MINIMAL_JPEG },
    },
  });
  if (!uploadRes.ok()) {
    throw new Error(`上傳附件失敗: ${uploadRes.status()} ${await uploadRes.text()}`);
  }
  const { attachment } = (await uploadRes.json()) as { attachment: { id: string } };
  createdAttachmentIds.push(attachment.id);

  const putRes = await page.request.put(`${API_BASE}/applications/travel/${appId}`, {
    data: {
      tripDate: opts.tripDate,
      purpose: opts.purpose,
      segments: [
        {
          origin: "台北",
          destination: "新竹",
          totalKm: opts.totalKm,
          highwayKm: opts.highwayKm,
          attachmentIds: [attachment.id],
        },
      ],
    },
  });
  if (!putRes.ok()) {
    throw new Error(`填表失敗: ${putRes.status()} ${await putRes.text()}`);
  }

  const completeRes = await page.request.post(`${API_BASE}/applications/${appId}/complete`);
  if (!completeRes.ok()) {
    throw new Error(`完成申請失敗: ${completeRes.status()} ${await completeRes.text()}`);
  }

  return appId;
}

/**
 * PHASE-005a-T13R：確保指定使用者於 `dateStr` 有新模型油資可解析——擁有人之
 * 油耗版本，以及對應油種之油價版本，皆先查後建（idempotent，同
 * `ensureParametersCoverDate` 之理由）。呼叫端須先以管理員身分登入（兩個端點
 * 皆為 admin-only）。
 */
async function ensureFuelModelCoversDate(
  page: Page,
  userId: string,
  dateStr: string
): Promise<void> {
  const consRes = await page.request.get(`${API_BASE}/users/${userId}/fuel-consumption`);
  if (!consRes.ok()) {
    throw new Error(`E2E 讀取油耗版本失敗: ${consRes.status()} ${await consRes.text()}`);
  }
  const { versions: consVersions } = (await consRes.json()) as {
    versions: { effectiveFrom: string }[];
  };
  if (!consVersions.some((v) => v.effectiveFrom <= dateStr)) {
    const res = await page.request.post(`${API_BASE}/users/${userId}/fuel-consumption`, {
      data: {
        fuelType: NEW_MODEL_FUEL_TYPE,
        kmPerLiter: NEW_MODEL_KM_PER_LITER,
        effectiveFrom: NEW_MODEL_EFFECTIVE_FROM,
        basisNote: NEW_MODEL_BASIS_NOTE,
      },
    });
    if (!res.ok()) {
      throw new Error(`E2E 設定油耗版本失敗: ${res.status()} ${await res.text()}`);
    }
  }

  const priceRes = await page.request.get(
    `${API_BASE}/parameters/fuel-price?fuelType=${NEW_MODEL_FUEL_TYPE}`
  );
  if (!priceRes.ok()) {
    throw new Error(`E2E 讀取油價版本失敗: ${priceRes.status()} ${await priceRes.text()}`);
  }
  const { versions: priceVersions } = (await priceRes.json()) as {
    versions: { effectiveFrom: string }[];
  };
  if (!priceVersions.some((v) => v.effectiveFrom <= dateStr)) {
    const res = await page.request.post(`${API_BASE}/parameters/fuel-price`, {
      data: {
        fuelType: NEW_MODEL_FUEL_TYPE,
        pricePerLiter: NEW_MODEL_PRICE_PER_LITER,
        effectiveFrom: NEW_MODEL_EFFECTIVE_FROM,
      },
    });
    if (!res.ok()) {
      throw new Error(`E2E 設定油價版本失敗: ${res.status()} ${await res.text()}`);
    }
  }
}

/** 於（已登入之）`page` 上，於區間公務總里程查詢區塊填入日期並送出查詢。 */
async function queryMileageSummary(page: Page, dateFrom: string, dateTo: string): Promise<void> {
  await page.fill("#mileage-dateFrom", dateFrom);
  await page.fill("#mileage-dateTo", dateTo);
  await page.click('button:has-text("查詢")');
}

test.describe("區間公務里程統計 — PHASE-005 Gate E2E（Spec §11.4）", () => {
  test.beforeAll(async ({ browser }) => {
    // 1. 以管理員身分建立專屬合成使用者 + 確保參數覆蓋兩個出差日期。
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await loginAsAdmin(adminPage);
    await ensureParametersCoverDate(adminPage, TRIP_DATE_1);
    await ensureParametersCoverDate(adminPage, TRIP_DATE_2);

    const suffix = Date.now().toString(36);
    targetLoginName = `e2e-t8-${suffix}`;
    targetDisplayName = `T8統計目標使用者${suffix}`;
    const createUserRes = await adminPage.request.post(`${API_BASE}/admin/users`, {
      data: {
        loginName: targetLoginName,
        displayName: targetDisplayName,
        temporaryPassword: TARGET_PASSWORD,
      },
    });
    if (!createUserRes.ok()) {
      throw new Error(
        `E2E 建立合成使用者失敗: ${createUserRes.status()} ${await createUserRes.text()}`
      );
    }
    const { user } = (await createUserRes.json()) as { user: { id: string } };
    targetUserId = user.id;

    // PHASE-005a-T13R：完成流程之油資解析改為擁有人（此為 targetUserId，非
    // 管理員本人）之新模型油耗＋對應油種油價（AC-23）。
    await ensureFuelModelCoversDate(adminPage, targetUserId, TRIP_DATE_1);
    await ensureFuelModelCoversDate(adminPage, targetUserId, TRIP_DATE_2);

    await adminContext.close();

    // 2. 以該使用者身分（獨立 context，強制改密後）建立 2 筆已完成差旅
    //    （不同出差日期，AC-01 情境所需）。
    const targetContext = await browser.newContext();
    const targetPage = await targetContext.newPage();
    const loginRes = await targetPage.request.post(`${API_BASE}/auth/login`, {
      data: { loginName: targetLoginName, password: TARGET_PASSWORD },
    });
    if (!loginRes.ok()) {
      throw new Error(`E2E 目標使用者登入失敗: ${loginRes.status()} ${await loginRes.text()}`);
    }
    const changePasswordRes = await targetPage.request.post(`${API_BASE}/me/password`, {
      data: { currentPassword: TARGET_PASSWORD, newPassword: "E2eMileageT8Changed1!" },
    });
    if (!changePasswordRes.ok()) {
      throw new Error(
        `E2E 目標使用者強制改密失敗: ${changePasswordRes.status()} ${await changePasswordRes.text()}`
      );
    }

    await createCompletedTrip(targetPage, {
      tripDate: TRIP_DATE_1,
      purpose: `T8情境1較早一筆${suffix}`,
      totalKm: TRIP_1_TOTAL_KM,
      highwayKm: TRIP_1_HIGHWAY_KM,
    });
    await createCompletedTrip(targetPage, {
      tripDate: TRIP_DATE_2,
      purpose: `T8情境1較晚一筆${suffix}`,
      totalKm: TRIP_2_TOTAL_KM,
      highwayKm: TRIP_2_HIGHWAY_KM,
    });

    await targetContext.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsAdmin(page);

    for (const attId of createdAttachmentIds) {
      await page.request.delete(`${API_BASE}/attachments/${attId}`).catch(() => {});
    }
    // 已完成申請不可刪除（AC-06，403，見 CLAUDE.md「已完成申請不可修改」），
    // 故該使用者恆有申請歷史，刪除使用者也會 409——這是既有「不可逆」業務
    // 規則（同 e2e/admin-applications.spec.ts 之 cleanup 註解），非本測試缺
    // 陷；仍以合成資料 best-effort 嘗試刪除，失敗則忽略。
    if (targetUserId) {
      await page.request.delete(`${API_BASE}/admin/users/${targetUserId}`).catch(() => {});
    }

    await context.close();
  });

  // ---- 情境1：涵蓋兩筆之區間 → 顯示正確總里程 ----
  test("情境1：使用者登入→建2筆差旅並完成（不同出差日期）→統計區塊選擇涵蓋兩筆之區間→顯示正確總里程", async ({
    page,
  }) => {
    const loginRes = await page.request.post(`${API_BASE}/auth/login`, {
      data: { loginName: targetLoginName, password: "E2eMileageT8Changed1!" },
    });
    expect(loginRes.ok()).toBe(true);

    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);

    await queryMileageSummary(page, RANGE_FROM, RANGE_TO);

    await expect(page.locator(".mileage-summary-value")).toContainText("公務總里程 120.00 公里", {
      timeout: 10000,
    });
    await expect(page.locator(".mileage-summary-meta")).toContainText("共 2 筆");
  });

  // ---- 情境2：邊界——起日設為兩筆之間 → 只剩一筆之里程 ----
  test("情境2：邊界——把起日設為兩筆之間的日期→只剩一筆之里程", async ({ page }) => {
    const loginRes = await page.request.post(`${API_BASE}/auth/login`, {
      data: { loginName: targetLoginName, password: "E2eMileageT8Changed1!" },
    });
    expect(loginRes.ok()).toBe(true);

    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);

    await queryMileageSummary(page, BOUNDARY_DATE, RANGE_TO);

    await expect(page.locator(".mileage-summary-value")).toContainText("公務總里程 70.00 公里", {
      timeout: 10000,
    });
    await expect(page.locator(".mileage-summary-meta")).toContainText("共 1 筆");
  });

  // ---- 情境3：起 > 迄 → 顯示區間錯誤提示，不顯示數值 ----
  test("情境3：起>迄→顯示區間錯誤提示，不顯示數值", async ({ page }) => {
    const loginRes = await page.request.post(`${API_BASE}/auth/login`, {
      data: { loginName: targetLoginName, password: "E2eMileageT8Changed1!" },
    });
    expect(loginRes.ok()).toBe(true);

    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);

    await queryMileageSummary(page, TRIP_DATE_2, TRIP_DATE_1);

    await expect(page.getByText("起日不可晚於迄日，請重新選擇日期區間。")).toBeVisible();
    await expect(page.locator(".mileage-summary-value")).toHaveCount(0);
  });

  // ---- 情境4：空區間 → 顯示 0.00 公里 + 說明文案 ----
  test("情境4：空區間→顯示0.00公里與說明文案", async ({ page }) => {
    const loginRes = await page.request.post(`${API_BASE}/auth/login`, {
      data: { loginName: targetLoginName, password: "E2eMileageT8Changed1!" },
    });
    expect(loginRes.ok()).toBe(true);

    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);

    await queryMileageSummary(page, EMPTY_FROM, EMPTY_TO);

    await expect(page.locator(".mileage-summary-value")).toContainText("0.00 公里", {
      timeout: 10000,
    });
    await expect(page.getByText("此區間無已完成的差旅紀錄")).toBeVisible();
  });

  // ---- 情境5（AC-31）：管理員檢視指定使用者統計，非管理員自己 ----
  test("情境5（AC-31）：管理員進入/admin/users/:userId/applications→選區間→顯示該使用者統計（非管理員自己）", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE}/admin/users/${targetUserId}/applications`);
    await page.waitForURL(`${BASE}/admin/users/${targetUserId}/applications`);
    await expect(page.locator("h1")).toContainText(targetDisplayName);

    // 請求本身之 ownerId 精確等於路由 :userId（AC-31 之字面斷言）。
    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes("/statistics/mileage")),
      queryMileageSummary(page, RANGE_FROM, RANGE_TO),
    ]);
    expect(request.url()).toContain(`ownerId=${targetUserId}`);

    // 顯示值須為該使用者的統計（120.00，情境1驗過之真實合計），非管理員
    // 自己的資料（管理員在同一區間內從未建立這兩筆合成差旅，數值不可能巧合
    // 相同——這正是 AC-31 之「非管理員自己」鑑別點）。
    await expect(page.locator(".mileage-summary-value")).toContainText("公務總里程 120.00 公里", {
      timeout: 10000,
    });
    await expect(page.locator(".mileage-summary-meta")).toContainText("共 2 筆");
  });

  // ---- 情境6（AC-32）：響應式，375px 無水平溢位 ----
  test("情境6（AC-32）：響應式375px——HomePage與管理員頁body皆無水平溢位", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    // HomePage（個人統計）。
    const loginRes = await page.request.post(`${API_BASE}/auth/login`, {
      data: { loginName: targetLoginName, password: "E2eMileageT8Changed1!" },
    });
    expect(loginRes.ok()).toBe(true);

    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);
    await expect(page.locator("#mileage-dateFrom")).toBeVisible();

    const homeOverflow = await page.evaluate(() => document.body.scrollWidth <= window.innerWidth);
    expect(homeOverflow).toBe(true);

    // 管理員頁（統計 + 申請紀錄）。先登出目標使用者 session，否則
    // `/login` 路由會偵測到既有 session 而自動導回首頁（RouteGuard 的既有
    // 行為），永遠等不到登入表單。
    await page.request.post(`${API_BASE}/auth/logout`).catch(() => {});
    await loginAsAdmin(page);
    await page.goto(`${BASE}/admin/users/${targetUserId}/applications`);
    await page.waitForURL(`${BASE}/admin/users/${targetUserId}/applications`);
    await expect(page.locator("#mileage-dateFrom")).toBeVisible();

    const adminOverflow = await page.evaluate(() => document.body.scrollWidth <= window.innerWidth);
    expect(adminOverflow).toBe(true);
  });
});
