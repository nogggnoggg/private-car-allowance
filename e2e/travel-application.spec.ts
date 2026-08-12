/**
 * E2E: 差旅補助申請 — PHASE-004-T13
 *
 * Gate 前必須關閉的 Known Issue（Spec §17 測試策略澄清 2026-08-02，PHASE-004-T11
 * 之延續）: `e2e/attachments-demo.spec.ts` 原 AC-21 情境（上傳 → 用公開
 * `POST /attachments/:id/link` 端點關聯 → 刪除 → 重新載入不顯示）依賴
 * PHASE-004-T11（D12）已移除的公開 link 端點，UI 上的「關聯」按鈕與
 * 「已關聯附件清單」區塊亦已隨之移除，該情境自 T11 起即為紅燈。當時裁定
 * 「因對應 UI 尚未存在，遷移延後至 T13」——本檔即為該遷移的落地。
 *
 * 覆蓋對照（原情境 → 本檔新情境，覆蓋強度）：
 *   原：上傳 → 點「關聯」按鈕（呼叫已移除的公開 link 端點）→ 刪除 → 重新載入
 *       （demo 頁本就不會在重新載入後保留關聯狀態，因為它從不對後端持久化）
 *   新：上傳（TEMP）→ 儲存差旅草稿（PUT /applications/travel/:id 的
 *       attachmentIds[]，D15 之整份儲存語意，內部呼叫服務層 linkAttachment）
 *       → 重新載入 → 驗證附件「確實」透過真實後端關聯持久化（原情境做不到
 *       這一步，因為 demo 頁從未把關聯狀態送回後端）→ 刪除附件（C4 二次
 *       確認）→ 重新載入 → 驗證不再顯示。
 *   覆蓋強度：**更強**——新情境額外證明了關聯狀態經過真實後端持久化這件事
 *   （原情境的「reload 不顯示」純粹是因為 demo 頁本就沒有任何持久化，而非
 *   證明了刪除生效）。
 *
 * Topology / Test account: 同 attachments-demo.spec.ts（e2eadmin，見該檔檔頭）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Locator, type Page, expect, test } from "@playwright/test";

const E2E_USER = { loginName: "e2eadmin", password: "E2eAdmin@456!" };
const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";

// ---------------------------------------------------------------------------
// PHASE-004-R7 (S-3)：情境1/2 共用的補助參數設定
//
// `1999-05-05` 早於 `PARAM_EFFECTIVE_FROM`，用於情境2「缺參數路徑」——只要
// 本檔（及其他 E2E 檔）從未以 `<= 1999-05-05` 的 `effectiveFrom` 建立版本，
// 該日期便永遠查無有效版本（`findEffectiveVersion` 對早於最早版本生效日的
// 查詢日一律回 `null`，見 backend/src/parameters/parameter-version-engine.ts）。
// 情境2從未導向清單頁（只驗證草稿頁的拒絕訊息），故不受下方 AC-60 回溯窗
// 影響，維持固定日期即可。
//
// `SUCCESS_TRIP_DATE` 用於情境1「完整完成路徑」，除了需要有版本覆蓋，情境1
// 最後一步還會導向清單頁、以關鍵字篩選找回剛完成的這筆申請（AC-64）。清單
// 端點在未帶 `dateFrom` 時，後端套用 AC-60／D9(iii) 的預設回溯窗
// `dateFrom = 今日 − 1 年`（見 backend/src/applications/application-query.ts
// 的 `defaultDateFrom`）——若 `SUCCESS_TRIP_DATE` 是寫死的日曆日期，會隨著
// 系統時間往前推移，遲早晚於「今日 − 1 年」而被這個預設回溯窗篩掉，讓情境1
// 的清單斷言查無此筆而非本身邏輯有誤（PHASE-004-R8F 實際重現過這個劣化：
// 寫死的 "2025-03-10" 在系統時間來到 2026-08-02 後即失效）。改為「今日往前
// 2 個月」動態計算，確保恆落在一年回溯窗內、且留有約 10 個月的邊界餘裕，
// 不會再次被同一機制劣化。**不得改回固定日曆日期**。
// ---------------------------------------------------------------------------
function isoDateMonthsAgo(months: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}
const SUCCESS_TRIP_DATE = isoDateMonthsAgo(2);
const NO_PARAM_TRIP_DATE = "1999-05-05";
const PARAM_EFFECTIVE_FROM = "2020-06-01";
const PARAM_ETC_UNIT_PRICE = 1.8;

// ---------------------------------------------------------------------------
// PHASE-005a-T13R：新油資模型播種（AC-37(e)，後端 T7 起油資解析改為「擁有人
// 油耗版本 → 對應油種油價版本」雙鏈解析，見
// backend/src/applications/travel-parameters.ts）。本檔完成路徑（情境1）之
// 出差日期 `SUCCESS_TRIP_DATE` 須額外有登入者（e2eadmin 本人，本檔草稿皆為
// 自建自完成）的油耗版本，以及對應油種的油價版本，否則「油資無法計算」擋下
// 完成。`NEW_MODEL_EFFECTIVE_FROM` 沿用既有 `PARAM_EFFECTIVE_FROM`（晚於
// `NO_PARAM_TRIP_DATE`），刻意**不**覆蓋情境2之出差日期，維持該情境「查無
// 有效參數」之既有斷言不變。本檔未對完成金額做具體數字斷言（僅
// `/合計金額：\d+/` 與 `>0`），故播種數值無需與任何舊制單價換算等值。
// ---------------------------------------------------------------------------
const NEW_MODEL_EFFECTIVE_FROM = PARAM_EFFECTIVE_FROM;
const NEW_MODEL_FUEL_TYPE = "GASOLINE_92";
const NEW_MODEL_KM_PER_LITER = "10.0000";
const NEW_MODEL_PRICE_PER_LITER = "65.0000";
const NEW_MODEL_BASIS_NOTE = "PHASE-005a-T13R E2E 合成資料（新油資模型播種）";

/**
 * 確保 ETC 補助參數至少有一版本覆蓋 `dateStr`（若缺，於
 * `PARAM_EFFECTIVE_FROM` 建立一版）。先查後建（idempotent）——`backend`
 * 是跨多次 E2E 執行共用的持久化 dev DB，且參數版本沒有 DELETE 端點（財務
 * 參數歷史不可變，AC-07 之精神），故重複執行本函式不得因「已存在」而
 * 409（PARAMETER_PERIOD_OVERLAP）。呼叫端須先以管理員身分登入（`page` 的
 * cookie 需已通過 `requireAuth`/`requireAdmin`）。
 *
 * CHORE-E2E-BOOTSTRAP：`POST /parameters/fuel` 已於 PHASE-005a-T3b（§16
 * D1(a)、AC-37）退場回 404——油資本身之覆蓋改由 `ensureFuelModelCoversDate`
 * 負責（新模型：擁有人油耗版本 → 對應油種油價版本），本函式僅餘 ETC。
 */
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
    if (!res.ok()) {
      throw new Error(`E2E 設定 ETC 參數失敗: ${res.status()} ${await res.text()}`);
    }
  }
}

/** 回傳目前登入者（`page` 之 cookie）的使用者 id（`GET /me`）。 */
async function getCurrentUserId(page: Page): Promise<string> {
  const res = await page.request.get(`${API_BASE}/me`);
  if (!res.ok()) {
    throw new Error(`E2E 讀取目前使用者失敗: ${res.status()} ${await res.text()}`);
  }
  const { user } = (await res.json()) as { user: { id: string } };
  return user.id;
}

/**
 * PHASE-005a-T13R：確保指定使用者（`userId`）於 `dateStr` 有新模型油資可解析
 * ——擁有人之油耗版本，以及對應油種之油價版本，皆先查後建（idempotent，同
 * `ensureParametersCoverDate` 之理由：跨檔共用持久化 dev DB、版本無 DELETE
 * 端點）。呼叫端須先以管理員身分登入（兩個端點皆為 admin-only）。
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

/** `<dl class="detail-list">` 內 `dt`/`dd` 依序配對讀出（唯讀檢視頁的快照區塊）。 */
async function readDetailList(scope: Locator): Promise<Record<string, string>> {
  const dts = await scope.locator("dt").allTextContents();
  const dds = await scope.locator("dd").allTextContents();
  const result: Record<string, string> = {};
  dts.forEach((k, i) => {
    result[k] = dds[i] ?? "";
  });
  return result;
}

/** Minimal valid 1x1 JPEG (real FF D8 FF header) */
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

let tmpDir: string;
let jpegFixture: string;

const createdApplicationIds: string[] = [];

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.waitForURL(`${BASE}/login`);
  await page.fill("#loginName", E2E_USER.loginName);
  await page.fill("#password", E2E_USER.password);
  await page.click('button:has-text("登入")');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
}

/** 從首頁點「新增差旅補助」→ 等候導向真正的草稿 id → 回傳該 id。 */
async function createDraftViaUI(page: Page): Promise<string> {
  await page.goto(`${BASE}/`);
  await page.waitForURL(`${BASE}/`);
  await page.click('a:has-text("新增差旅補助")');
  await page.waitForURL(/\/applications\/travel\/(?!new)[^/]+$/, { timeout: 15000 });
  const url = new URL(page.url());
  const id = url.pathname.split("/").pop() as string;
  createdApplicationIds.push(id);
  return id;
}

test.beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-travel-"));
  jpegFixture = path.join(tmpDir, "trip-photo.jpg");
  fs.writeFileSync(jpegFixture, MINIMAL_JPEG);
});

test.afterAll(async () => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

test.describe("差旅補助申請 — PHASE-004 Gate E2E", () => {
  test.afterEach(async ({ page }) => {
    // Best-effort cleanup of synthetic drafts created during the test run.
    for (const id of createdApplicationIds) {
      try {
        await page.request.delete(`${API_BASE}/applications/${id}`);
      } catch {
        // ignore — draft may already be gone (e.g. delete test)
      }
    }
    createdApplicationIds.length = 0;
  });

  /**
   * 遷移自 attachments-demo.spec.ts 原 AC-21（見檔頭覆蓋對照）：
   * 上傳 → 關聯到行程段（整份儲存）→ 重新載入驗證持久化 → 刪除（二次確認）
   * → 重新載入驗證不再顯示。
   */
  test("上傳附件關聯到行程段並儲存 → 重新載入仍顯示（真實持久化）→ 刪除 → 重新載入不再顯示", async ({
    page,
  }) => {
    await login(page);
    const id = await createDraftViaUI(page);

    await expect(page.locator("h1")).toContainText("差旅補助申請（草稿）");

    // 新增一個行程段
    await page.click('button:has-text("新增行程段")');
    await expect(page.getByText("第 1 段")).toBeVisible();

    const segment = page.locator(".trip-segment").first();
    await segment.getByLabel("出發地點").fill("台北總公司");
    await segment.getByLabel("到達地點").fill("台中辦事處");
    await segment.getByLabel("總里程（公里）").fill("150");
    await segment.getByLabel("高速里程（公里）").fill("120");

    // 上傳截圖（TEMP 附件）
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      segment.locator('button:has-text("選擇圖片")').click(),
    ]);
    await fileChooser.setFiles(jpegFixture);

    const uploadedImg = segment.locator('img[alt="trip-photo.jpg"]');
    await expect(uploadedImg).toBeVisible({ timeout: 15000 });

    // 儲存草稿 → PUT 的 attachmentIds[] 觸發後端 linkAttachment（D15）
    await page.click('button:has-text("儲存草稿")');
    await expect(page.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });

    // 重新載入 → 驗證附件關聯「真的」被後端持久化（原 demo 頁做不到這一步）
    await page.reload();
    await page.waitForURL(`${BASE}/applications/travel/${id}`);
    await expect(page.locator('img[alt="trip-photo.jpg"]')).toBeVisible({ timeout: 10000 });

    // 刪除附件 → 需二次確認（C4）
    await page.click('button[aria-label="刪除 trip-photo.jpg"]');
    await expect(page.getByRole("dialog", { name: "確認刪除附件" })).toBeVisible();
    await page.click('dialog[aria-label="確認刪除附件"] button:has-text("確認刪除")');
    await expect(page.locator('img[alt="trip-photo.jpg"]')).not.toBeVisible({ timeout: 10000 });

    // 儲存後，重新載入確認刪除已持久化，不再顯示
    await page.click('button:has-text("儲存草稿")');
    await expect(page.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });
    await page.reload();
    await page.waitForURL(`${BASE}/applications/travel/${id}`);
    await expect(page.locator('img[alt="trip-photo.jpg"]')).not.toBeVisible({ timeout: 5000 });
  });

  /**
   * AC-87/88/89（375px）：多段表單為垂直堆疊的獨立區塊（非橫向表格）、
   * 檔案輸入具影像 accept、頁面 body 不得水平溢位。真實瀏覽器才能量測
   * scrollWidth，故本項於 E2E 而非 jsdom 單元測試驗證（Spec §11.4 項 5）。
   */
  test("響應式（375px）：多段表單垂直堆疊、影像 accept、body 無水平溢位（AC-87/88/89）", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page);
    await createDraftViaUI(page);

    await page.click('button:has-text("新增行程段")');
    await page.click('button:has-text("新增行程段")');
    await expect(page.getByText("第 2 段")).toBeVisible();

    // AC-87: 每段為獨立區塊，非橫向表格。
    const segmentList = page.locator(".trip-segment-list");
    await expect(segmentList).toBeVisible();
    expect(await segmentList.locator("table").count()).toBe(0);
    expect(await page.locator(".trip-segment").count()).toBe(2);

    // AC-88: 檔案輸入具影像型別 accept，行動瀏覽器可自相簿選檔。
    const fileInput = page.locator(".trip-segment").first().locator('input[type="file"]');
    await expect(fileInput).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");

    // AC-89: body 不得水平溢位（寬元素須自身可捲動，不撐開整個頁面）。
    const overflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);

    // 回到首頁列表頁同樣驗證無水平溢位（AC-89 涵蓋列表頁）。
    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);
    const listOverflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth);
    expect(listOverflow).toBe(false);
  });

  /**
   * PHASE-004-R7（S-3，Spec §11.4 項1）：原情境只落地到「上傳/儲存/reload」，
   * 「預覽金額顯示」「完成」「列表顯示已完成與正式金額」三段缺口由本測試補齊。
   */
  test("情境1：建草稿→2段→各段上傳→預覽金額顯示→儲存→完成→列表顯示「已完成」與正式金額", async ({
    page,
  }) => {
    await login(page);
    await ensureParametersCoverDate(page, SUCCESS_TRIP_DATE);
    const selfUserId = await getCurrentUserId(page);
    await ensureFuelModelCoversDate(page, selfUserId, SUCCESS_TRIP_DATE);

    const id = await createDraftViaUI(page);
    await expect(page.locator("h1")).toContainText("差旅補助申請（草稿）");

    const suffix = Date.now().toString(36);
    const purpose = `情境1完成路徑測試${suffix}`;
    await page.fill("#trip-date", SUCCESS_TRIP_DATE);
    await page.fill("#trip-purpose", purpose);

    const segmentDefs = [
      { origin: "台北總公司", destination: "台中辦事處", totalKm: "150", highwayKm: "120" },
      { origin: "台中辦事處", destination: "高雄分公司", totalKm: "200", highwayKm: "180" },
    ];

    for (let i = 0; i < segmentDefs.length; i++) {
      await page.click('button:has-text("新增行程段")');
    }
    await expect(page.getByText("第 2 段")).toBeVisible();

    const segments = page.locator(".trip-segment");
    const uploadedAttachmentIds: string[] = [];
    for (const [i, def] of segmentDefs.entries()) {
      const seg = segments.nth(i);
      await seg.getByLabel("出發地點").fill(def.origin);
      await seg.getByLabel("到達地點").fill(def.destination);
      await seg.getByLabel("總里程（公里）").fill(def.totalKm);
      await seg.getByLabel("高速里程（公里）").fill(def.highwayKm);

      const [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        seg.locator('button:has-text("選擇圖片")').click(),
      ]);
      await fileChooser.setFiles(jpegFixture);
      const uploadedImg = seg.locator('img[alt="trip-photo.jpg"]');
      await expect(uploadedImg).toBeVisible({ timeout: 15000 });
      const src = await uploadedImg.getAttribute("src");
      const match = src?.match(/\/api\/attachments\/([^/]+)\/thumbnail/);
      if (match?.[1]) uploadedAttachmentIds.push(match[1]);
    }

    try {
      // 預覽金額顯示（原情境缺口之一）——debounce 300ms 後，後端 stateless
      // preview 端點（D8）回傳的合計金額須顯示在畫面上（非前端自算，C1）。
      const previewSection = page.locator("section[aria-labelledby='preview-total-heading']");
      const previewAmountEl = previewSection.locator("strong");
      await expect(previewAmountEl).toContainText("合計金額：", { timeout: 10000 });
      const previewText = (await previewAmountEl.innerText()).trim();
      expect(previewText).toMatch(/合計金額：\d+/);

      await page.click('button:has-text("儲存草稿")');
      await expect(page.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });

      // 完成（原情境缺口之二）——C4 需二次確認。
      await page.click('button:has-text("完成申請")');
      const confirmDialog = page.getByRole("dialog", { name: "確認完成申請" });
      await expect(confirmDialog).toBeVisible();
      await confirmDialog.locator('button:has-text("確認完成")').click();

      await expect(page.locator("h1")).toContainText("差旅補助申請（已完成）", { timeout: 10000 });
      const snapshotSection = page.locator("section[aria-labelledby='snapshot-heading']");
      await expect(snapshotSection).toBeVisible();
      const snapshotDetails = await readDetailList(snapshotSection);
      const snapshotAmountText = snapshotDetails.整筆金額;
      expect(snapshotAmountText).toBeDefined();
      expect(Number(snapshotAmountText)).toBeGreaterThan(0);

      // 列表顯示「已完成」與正式金額（原情境缺口之三）——以關鍵字篩選鎖定本筆
      // （AC-64），避免受 DB 內既有殘留紀錄的分頁/排序影響（C5 測試隔離紀律：
      // 本檔在共用 dev DB 上執行，不得依賴「第一頁看得到」這種脆弱假設）。
      await page.goto(`${BASE}/`);
      await page.waitForURL(`${BASE}/`);
      await page.fill("#filter-keyword", purpose);
      await page.click('button:has-text("套用篩選")');

      const row = page.locator(".app-list-table tbody tr", { hasText: purpose });
      await expect(row).toHaveCount(1, { timeout: 10000 });
      await expect(row.locator(".status-badge")).toContainText("已完成");
      const amountCellText = (await row.locator("td").nth(5).innerText()).trim();
      expect(amountCellText).toBe(snapshotAmountText);
    } finally {
      // 若完成失敗（草稿仍為 DRAFT），附件仍為可刪除的 TEMP/LINKED 狀態，
      // best-effort 清理，避免殘留於共用 dev DB（若已完成，刪除會 403，
      // 屬 AC-06 之既有不可逆語意，非本測試需處理的情況）。
      for (const attId of uploadedAttachmentIds) {
        await page.request.delete(`${API_BASE}/attachments/${attId}`).catch(() => {});
      }
    }
  });

  /**
   * PHASE-004-R7（S-3，Spec §11.4 項2）：缺參數路徑——原情境完全未落地。
   * 出差日期落在「無任何油資／ETC 版本覆蓋」的區間 → 草稿仍可儲存（結構完
   * 整性與參數可用性是獨立的兩層檢查，見 travel-service.ts 完成流程步驟②/
   * ③ 的分工註解）→ 完成被拒（實際為 409 PARAMETER_NOT_AVAILABLE）。
   * 斷言文字取自 TravelApplicationPage.tsx `handleComplete` 的
   * `PARAMETER_NOT_AVAILABLE` 分支之實際顯示文字，非臆造。
   */
  test("情境2：缺參數路徑——出差日期無對應參數版本 → 可存草稿 → 完成被拒並顯示提示", async ({
    page,
  }) => {
    await login(page);
    await createDraftViaUI(page);
    await expect(page.locator("h1")).toContainText("差旅補助申請（草稿）");

    const suffix = Date.now().toString(36);
    const purpose = `情境2缺參數測試${suffix}`;
    await page.fill("#trip-date", NO_PARAM_TRIP_DATE);
    await page.fill("#trip-purpose", purpose);

    await page.click('button:has-text("新增行程段")');
    const segment = page.locator(".trip-segment").first();
    await segment.getByLabel("出發地點").fill("台北");
    await segment.getByLabel("到達地點").fill("桃園");
    await segment.getByLabel("總里程（公里）").fill("40");
    await segment.getByLabel("高速里程（公里）").fill("30");

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      segment.locator('button:has-text("選擇圖片")').click(),
    ]);
    await fileChooser.setFiles(jpegFixture);
    const uploadedImg = segment.locator('img[alt="trip-photo.jpg"]');
    await expect(uploadedImg).toBeVisible({ timeout: 15000 });
    const src = await uploadedImg.getAttribute("src");
    const match = src?.match(/\/api\/attachments\/([^/]+)\/thumbnail/);
    const uploadedAttachmentId = match?.[1];

    try {
      // 可存草稿。
      await page.click('button:has-text("儲存草稿")');
      await expect(page.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });

      // 完成被拒，畫面顯示可理解的 zh-TW 提示（畫面實際文字，見上方檔案註解）。
      await page.click('button:has-text("完成申請")');
      const confirmDialog = page.getByRole("dialog", { name: "確認完成申請" });
      await expect(confirmDialog).toBeVisible();
      await confirmDialog.locator('button:has-text("確認完成")').click();
      await expect(confirmDialog.locator(".error-block")).toContainText(
        "該出差日期尚無有效補助參數，請聯絡管理員設定。",
        { timeout: 10000 }
      );

      // 未完成——仍為草稿頁面（未跳轉、未變成唯讀檢視），證明「完成被拒」是真的擋下了。
      await expect(page.locator("h1")).toContainText("差旅補助申請（草稿）");
    } finally {
      if (uploadedAttachmentId) {
        await page.request
          .delete(`${API_BASE}/attachments/${uploadedAttachmentId}`)
          .catch(() => {});
      }
    }
  });
});
