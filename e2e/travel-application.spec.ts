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
import { type Page, expect, test } from "@playwright/test";

const E2E_USER = { loginName: "e2eadmin", password: "E2eAdmin@456!" };
const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";

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
});
