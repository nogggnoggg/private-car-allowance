/**
 * E2E: 修正版端到端 Gate — PHASE-009-T17（AC-36 ＋ AC-34 之版本關係區塊面）
 * （Spec `docs/specs/PHASE-009.md` §2.I AC-36 :247、§2.H AC-34 :241、§15 T17 :868）
 *
 * AC-36（:247 逐字）：「已完成差旅 → 建立修正版 → 新草稿含複製之欄位與附件 →
 * 修改後完成 → 產生報表得**新編號** → 原申請詳情顯示版本關係且其報表編號未
 * 變。」
 *
 * AC-34（:241）之四面中，本檔負責**版本關係區塊**（`supersedes` 側與
 * `supersededBy` 側各量一次）——其餘三面（作廢確認對話框／作廢資訊區塊／已作
 * 廢列印版）由 `e2e/void-application.spec.ts` 負責。兩檔合計覆蓋 AC-34 四面。
 *
 * ---------------------------------------------------------------------------
 * 兩個測試
 * ---------------------------------------------------------------------------
 *   1. `AC-36: 修正版端到端（已完成差旅→建立修正版→新草稿含複製欄位與附件→
 *      修改後完成→產生報表得新編號→原申請版本關係且原編號未變）`
 *   2. `AC-34: 375px——版本關係區塊（原申請側／修正版側）無水平溢位`
 *
 * ---------------------------------------------------------------------------
 * FW 核銷（Packet 逐項；與 void-application.spec.ts 同一組規則）
 * ---------------------------------------------------------------------------
 *   FW-1（T16／T14 即審，`exact: true`）：本檔所有 `getByRole` 之 `name` 一律
 *     `exact: true`。**本檔為該規則之關鍵現場**——「檢視修正版」（版本關係區
 *     塊之正常連結）與「檢視既有修正版」（409「已有修正版」錯誤區塊之連結）
 *     互為子字串（`TravelApplicationPage.tsx` :113 與 :788），非 exact 命中
 *     時 `getByRole("link", { name: "檢視修正版" })` 會在兩者並存時 strict
 *     mode violation、或在只剩錯誤區塊時誤判為成功。
 *
 *   FW-2（T7 即審，新編號**直接**斷言）：「產生報表得新編號」以
 *     `expect(revisionReportNumber).not.toBe(originalReportNumber)` **直接**
 *     比對兩個報表編號字串，不以任何投影值（如 `isRevision` 徽章、序號尾碼、
 *     `supersedes.reportNumber`）替代——投影值相等性與「編號確實不同」是兩件
 *     事，替代即失去鑑別力。另斷言原申請之報表編號於修正版產生報表**之後**
 *     逐字未變（AC-36 末句）。
 *
 *   FW-5（T13 §K 慣例）：版本關係文案一律於
 *     `section[aria-labelledby='version-relation-heading']` **區塊內**比對，
 *     不用整頁 `getByText`——「修正版」三字亦出現於列表徽章與附件提示文案，
 *     全頁比對會恆真。
 *
 *   FW-7（播種冪等）：合成使用者名以 `RUN_ID`（時間戳 ＋ 亂數）為後綴，每次
 *     執行皆為全新使用者；全域參數一律「先查後建」（`ensure*Covers`）。
 *     `afterAll` 刪除該使用者——但本檔之合成使用者名下恆有**已完成**申請
 *     （原申請與修正版兩筆皆完成；不可刪除，AC-06／CLAUDE.md「已完成申請不
 *     可修改」），`userHasHistory` 使 `DELETE /admin/users/:id` **恆 409**，
 *     故該清理為 **best-effort**（`.catch(() => {})`），實務上使用者列必然殘
 *     留。此為既有不可逆業務規則、非本檔缺陷（沿 `mileage-statistics.spec.ts`
 *     :307-310 與 `admin-applications.spec.ts` 之 cleanup 註解同義）；本檔重
 *     跑不與前次殘留互撞**由 `RUN_ID` 隔離保證**，而非由刪除保證，殘留素材
 *     之最終清理靠 **Phase 邊界之 dev DB 重置**。
 *
 *   FW-8（既有 44 條基準線）：見 `void-application.spec.ts` 檔頭與 Handoff。
 *
 * ---------------------------------------------------------------------------
 * 「新草稿含複製之欄位與附件」之斷言設計
 * ---------------------------------------------------------------------------
 *   · 欄位：於新草稿**編輯表單**逐欄讀 `inputValue()`（出差日期／出差目的／
 *     段落四欄），與原申請播種值逐字比對——讀表單值而非唯讀 dd，因為新草稿
 *     走的是 `DRAFT` 編輯分支。
 *   · 附件：新草稿之段落縮圖 `alt` 為原檔名（複製保留 `originalFilename`）；
 *     另以 API 讀兩筆之 DTO，斷言附件 `id` **不同**——證明是**複製**而非共用
 *     同一列（共用時原申請的不可變性會被修正版的編輯破壞，AC-14 之語意）。
 */

import { type Page, expect, test } from "@playwright/test";

const E2E_ADMIN = { loginName: "e2eadmin", password: "E2eAdmin@456!" };
const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";

// ---------------------------------------------------------------------------
// 日期／參數（沿 report-pdf.spec.ts／void-application.spec.ts 慣例）
// ---------------------------------------------------------------------------
function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
const TRIP_DATE = isoDateDaysAgo(25);
const PARAM_EFFECTIVE_FROM = "2020-06-01";
const FUEL_TYPE = "GASOLINE_92";
const FUEL_KM_PER_LITER = "10.0000";
const FUEL_PRICE_PER_LITER = "65.0000";
const ETC_UNIT_PRICE = 1.8;
const FUEL_BASIS_NOTE = "PHASE-009-T17 E2E 合成資料（修正版 Gate E2E 播種用）";

const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const STAFF_TEMP_PASSWORD = "TempPw@2026Rev!";
const STAFF_NEW_PASSWORD = "NewPw@2026Rev!";

/** 原申請之播種值（複製斷言之期望值）。 */
const ORIGINAL_PURPOSE = `PHASE-009-T17 修正版 Gate 原申請目的（${RUN_ID}）`;
const ORIGINAL_SEGMENT = {
  origin: "T17原起點",
  destination: "T17原終點",
  totalKm: "50.00",
  highwayKm: "10.00",
};
/** 修正版之修改值（「修改後完成」）。 */
const REVISED_TOTAL_KM = "80.00";

/** AC-32(c)／D15 之重複計入提醒（`TravelApplicationPage.tsx` :68 逐字）。 */
const DUPLICATE_COUNT_WARNING =
  "本申請仍為已完成狀態。若未作廢，本申請與修正版將同時計入里程與金額統計；如需避免重複計入，請於本頁作廢本申請。";

const ATTACHMENT_FILENAME = "t17-rev.jpg";

// ---------------------------------------------------------------------------
// Auth / 播種 helpers
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
  const loginName = `e2e-rev-${RUN_ID}`;
  const res = await page.request.post(`${API_BASE}/admin/users`, {
    data: {
      loginName,
      displayName: `T17修正版使用者${RUN_ID}`,
      temporaryPassword: STAFF_TEMP_PASSWORD,
    },
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
// 合成圖片（procedural；沿 report-pdf.spec.ts）
// ---------------------------------------------------------------------------

async function makeNoiseJpeg(width: number, height: number, seed: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  let x = seed | 0 || 1;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    raw[i] = (x >>> 0) & 0xff;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

// ---------------------------------------------------------------------------
// 播種：一筆已完成之差旅（1 段 ＋ 1 張證明）
// ---------------------------------------------------------------------------

async function seedCompletedTravel(page: Page): Promise<string> {
  const createRes = await page.request.post(`${API_BASE}/applications/travel`, { data: {} });
  if (!createRes.ok()) throw new Error(`E2E 播種差旅建立失敗: ${createRes.status()}`);
  const { application } = (await createRes.json()) as { application: { id: string } };
  const tripId = application.id;

  const buf = await makeNoiseJpeg(600, 400, 0x1703);
  const upRes = await page.request.post(`${API_BASE}/attachments`, {
    multipart: { file: { name: ATTACHMENT_FILENAME, mimeType: "image/jpeg", buffer: buf } },
  });
  if (!upRes.ok()) throw new Error(`E2E 上傳附件失敗: ${upRes.status()} ${await upRes.text()}`);
  const { attachment } = (await upRes.json()) as { attachment: { id: string } };

  const putRes = await page.request.put(`${API_BASE}/applications/travel/${tripId}`, {
    data: {
      tripDate: TRIP_DATE,
      purpose: ORIGINAL_PURPOSE,
      segments: [{ ...ORIGINAL_SEGMENT, attachmentIds: [attachment.id] }],
    },
  });
  if (!putRes.ok())
    throw new Error(`E2E 播種差旅段落設定失敗: ${putRes.status()} ${await putRes.text()}`);

  const completeRes = await page.request.post(`${API_BASE}/applications/${tripId}/complete`);
  if (!completeRes.ok())
    throw new Error(`E2E 播種差旅完成失敗: ${completeRes.status()} ${await completeRes.text()}`);
  return tripId;
}

// ---------------------------------------------------------------------------
// 讀取 helpers
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

async function measureOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

/** 讀取差旅申請 DTO 之段落附件 id 清單（複製 vs 共用之判別用）。 */
async function readSegmentAttachmentIds(page: Page, applicationId: string): Promise<string[]> {
  const res = await page.request.get(`${API_BASE}/applications/travel/${applicationId}`);
  if (!res.ok()) throw new Error(`E2E 讀取差旅 DTO 失敗: ${res.status()} ${await res.text()}`);
  const { application } = (await res.json()) as {
    application: { segments: { attachments: { id: string }[] }[] };
  };
  return application.segments.flatMap((s) => s.attachments.map((a) => a.id));
}

/** 於（已登入之）詳情頁按「產生正式報表」並回傳報表編號。 */
async function generateReport(page: Page, detailPath: string): Promise<string> {
  await page.goto(`${BASE}${detailPath}`, { waitUntil: "load" });
  await page.waitForURL(`${BASE}${detailPath}`);
  const reportSection = page.locator("section[aria-labelledby='report-heading']");
  await expect(reportSection.getByText("尚未產生正式報表")).toBeVisible({ timeout: 10000 });
  await reportSection.getByRole("button", { name: "產生正式報表", exact: true }).click();
  const reportDl = reportSection.locator("dl.detail-list");
  await expect(reportDl).toBeVisible({ timeout: 15000 });
  const number = (await readDetailList(reportDl)).報表編號 ?? "";
  expect(number).toMatch(/^TRV-\d{6}-\d{4,5}$/);
  return number;
}

/** 讀取已產生報表之編號（不觸發產生）。 */
async function readReportNumber(page: Page, detailPath: string): Promise<string> {
  await page.goto(`${BASE}${detailPath}`, { waitUntil: "load" });
  await page.waitForURL(`${BASE}${detailPath}`);
  const reportDl = page.locator("section[aria-labelledby='report-heading'] dl.detail-list");
  await expect(reportDl).toBeVisible({ timeout: 10000 });
  return (await readDetailList(reportDl)).報表編號 ?? "";
}

// ---------------------------------------------------------------------------
// 共用播種狀態
// ---------------------------------------------------------------------------

let staffUserId: string;
let staffLoginName: string;
let originalAppId: string;
let originalReportNumber: string;
/** 測試 1 建立之修正版 id；測試 2（AC-34）重用同一對申請。 */
let revisionAppId: string;

test.describe("修正版端到端 Gate — PHASE-009-T17（AC-36／AC-34）", () => {
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
    originalAppId = await seedCompletedTravel(staffPage);
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
  // 測試 1（AC-36）：修正版端到端
  // -------------------------------------------------------------------------
  test("AC-36: 修正版端到端（已完成差旅→建立修正版→新草稿含複製欄位與附件→修改後完成→產生報表得新編號→原申請版本關係且原編號未變）", async ({
    page,
  }) => {
    await loginAsStaff(page, staffLoginName);

    const originalDetailPath = `/applications/travel/${originalAppId}`;

    // ---- 1. 原申請：產生報表，記下原編號 ----
    await test.step("原申請產生報表", async () => {
      originalReportNumber = await generateReport(page, originalDetailPath);
    });

    // 原申請之附件 id（複製 vs 共用之對照組）。
    const originalAttachmentIds = await readSegmentAttachmentIds(page, originalAppId);
    expect(originalAttachmentIds).toHaveLength(1);

    // ---- 2. 建立修正版（UI 入口；AC-32(a)(b)） ----
    await test.step("建立修正版 → 導向新草稿頁", async () => {
      await page.goto(`${BASE}${originalDetailPath}`, { waitUntil: "load" });
      // AC-32(a)：佔位文案已被真實入口取代（T16）。
      await expect(page.getByText("功能將於後續版本提供")).toHaveCount(0);
      await page.getByRole("button", { name: "建立修正版", exact: true }).click();
      await page.waitForURL(
        (url) =>
          url.pathname.startsWith("/applications/travel/") &&
          !url.pathname.endsWith(`/${originalAppId}`),
        { timeout: 15000 }
      );
      revisionAppId = page.url().split("/").pop() as string;
      expect(revisionAppId).not.toBe(originalAppId);
      await expect(page.locator("h1")).toHaveText("差旅補助申請（草稿）");
    });

    // ---- 3. 新草稿含複製之欄位與附件 ----
    await test.step("新草稿含複製之欄位與附件", async () => {
      // 版本關係（`supersedes` 側）——FW-5：區塊內比對。
      const versionSection = page.locator("section[aria-labelledby='version-relation-heading']");
      await expect(versionSection).toBeVisible();
      await expect(versionSection).toContainText(`本申請為 ${originalReportNumber} 之修正版`);
      // FW-1：exact——「檢視原申請」。
      await expect(
        versionSection.getByRole("link", { name: "檢視原申請", exact: true })
      ).toHaveAttribute("href", originalDetailPath);
      // 修正版側**不**顯示重複計入提醒（AC-32(c) 之「僅 supersededBy 側」）。
      await expect(versionSection).not.toContainText(DUPLICATE_COUNT_WARNING);

      // 欄位：讀編輯表單之實際值。
      await expect(page.locator("#trip-date")).toHaveValue(TRIP_DATE);
      await expect(page.locator("#trip-purpose")).toHaveValue(ORIGINAL_PURPOSE);
      const segment = page.locator(".trip-segment").first();
      await expect(page.locator(".trip-segment")).toHaveCount(1);
      await expect(segment.getByLabel("出發地點")).toHaveValue(ORIGINAL_SEGMENT.origin);
      await expect(segment.getByLabel("到達地點")).toHaveValue(ORIGINAL_SEGMENT.destination);
      await expect(segment.getByLabel("總里程（公里）")).toHaveValue(ORIGINAL_SEGMENT.totalKm);
      await expect(segment.getByLabel("高速里程（公里）")).toHaveValue(ORIGINAL_SEGMENT.highwayKm);

      // 附件：縮圖在場且檔名保留。
      await expect(segment.locator(`img[alt="${ATTACHMENT_FILENAME}"]`)).toBeVisible({
        timeout: 15000,
      });
      // 附件為**複製**而非共用同一列——id 不同（原申請之不可變性不因修正版
      // 之編輯而被破壞）。
      const revisionAttachmentIds = await readSegmentAttachmentIds(page, revisionAppId);
      expect(revisionAttachmentIds).toHaveLength(1);
      expect(revisionAttachmentIds[0]).not.toBe(originalAttachmentIds[0]);
    });

    // ---- 4. 修改後完成 ----
    await test.step("修改總里程後儲存並完成", async () => {
      const segment = page.locator(".trip-segment").first();
      await segment.getByLabel("總里程（公里）").fill(REVISED_TOTAL_KM);
      await page.getByRole("button", { name: "儲存草稿", exact: true }).click();
      await expect(page.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });

      await page.getByRole("button", { name: "完成申請", exact: true }).click();
      // T17R **S-1**（即審）：本行原缺 `exact: true`，與檔頭 FW-1「本檔所有
      // `getByRole` 之 `name` 一律 exact」之全覆蓋宣稱不符（銷帳主張失真）。
      const confirmDialog = page.getByRole("dialog", { name: "確認完成申請", exact: true });
      await expect(confirmDialog).toBeVisible();
      await confirmDialog.getByRole("button", { name: "確認完成", exact: true }).click();
      await expect(page.locator("h1")).toHaveText("差旅補助申請（已完成）", { timeout: 15000 });

      // 修改確實落地（總里程為改後值，非複製值）。
      const snapshot = await readDetailList(
        page.locator("section[aria-labelledby='snapshot-heading']")
      );
      expect(snapshot.總里程).toBe(REVISED_TOTAL_KM);
    });

    // ---- 5. 修正版產生報表 → 新編號（FW-2：直接比對兩個編號字串） ----
    await test.step("修正版產生報表得新編號", async () => {
      const revisionReportNumber = await generateReport(
        page,
        `/applications/travel/${revisionAppId}`
      );
      expect(revisionReportNumber).not.toBe(originalReportNumber);
    });

    // ---- 6. 原申請詳情：版本關係在場、報表編號未變 ----
    await test.step("原申請顯示版本關係且其報表編號未變", async () => {
      const stillOriginal = await readReportNumber(page, originalDetailPath);
      expect(stillOriginal).toBe(originalReportNumber);

      const versionSection = page.locator("section[aria-labelledby='version-relation-heading']");
      await expect(versionSection).toBeVisible();
      await expect(versionSection).toContainText("已建立修正版");
      // FW-1：exact——「檢視修正版」不得誤命中「檢視既有修正版」。
      await expect(
        versionSection.getByRole("link", { name: "檢視修正版", exact: true })
      ).toHaveAttribute("href", `/applications/travel/${revisionAppId}`);
      // AC-32(c)／D15：`supersededBy` 側之重複計入提醒逐字在場（原申請仍為
      // 已完成、未作廢）。
      await expect(versionSection.locator(".warn-text")).toHaveText(DUPLICATE_COUNT_WARNING);
      // 原申請未因建立修正版而自動作廢（D15(a)）。
      await expect(page.locator("h1")).toHaveText("差旅補助申請（已完成）");
    });
  });

  // -------------------------------------------------------------------------
  // 測試 2（AC-34）：375px 版本關係區塊零溢位（兩側各一）
  // -------------------------------------------------------------------------
  test("AC-34: 375px——版本關係區塊（原申請側／修正版側）無水平溢位", async ({ browser }) => {
    const context = await browser.newContext({
      timezoneId: "Asia/Taipei",
      locale: "zh-TW",
      viewport: { width: 375, height: 800 },
    });
    const page = await context.newPage();
    await loginAsStaff(page, staffLoginName);

    const surfaces: { label: string; path: string; mustContain: string }[] = [
      {
        label: "原申請側（supersededBy ＋ 重複計入提醒）",
        path: `/applications/travel/${originalAppId}`,
        mustContain: "已建立修正版",
      },
      {
        label: "修正版側（supersedes）",
        path: `/applications/travel/${revisionAppId}`,
        mustContain: `本申請為 ${originalReportNumber} 之修正版`,
      },
    ];

    for (const surface of surfaces) {
      await test.step(surface.label, async () => {
        await page.goto(`${BASE}${surface.path}`, { waitUntil: "load" });
        const versionSection = page.locator("section[aria-labelledby='version-relation-heading']");
        await expect(versionSection).toBeVisible({ timeout: 10000 });
        // 內容可讀：關鍵文案在場。
        await expect(versionSection).toContainText(surface.mustContain);
        const { scrollWidth, clientWidth } = await measureOverflow(page);
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
        // 區塊本身亦不得超出視埠右緣。
        const box = await versionSection.boundingBox();
        if (!box) throw new Error("E2E 量測失敗：版本關係區塊無 bounding box");
        expect(box.x + box.width).toBeLessThanOrEqual(clientWidth + 1);
      });
    }

    await context.close();
  });
});
