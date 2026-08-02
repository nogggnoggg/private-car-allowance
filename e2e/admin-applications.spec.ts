/**
 * E2E: 管理員檢視使用者申請紀錄 + 代操作 — PHASE-004-T14 Gate E2E
 *
 * Packet 驗收指令要求「若新增情境，一併貼出」。本檔新增 2 條情境，覆蓋
 * jsdom 單元測試（`frontend/test/AdminUserApplicationsPage.test.tsx`，9 條）
 * 無法證明的兩件事：
 *   1. 真實跨頁導向 + 真實後端授權/資料隔離——`POST /admin/users/:userId/
 *      applications/travel` 建立的草稿，`ownerId` 確實是被代理使用者、而非
 *      呼叫的管理員（AC-78），且該筆紀錄透過 `GET /applications?ownerId=`
 *      在「該使用者」的清單頁可見（AC-84）——單元測試全程 mock fetch，無法
 *      證明這點；本情境用真實後端 + 真實 DB 佐證。
 *   2. 375px 下 body 不得水平溢位（AC-89 精神）——jsdom 不算版面，同
 *      `e2e/travel-application.spec.ts` 既有做法，只能在真實瀏覽器量測。
 *
 * 未於 E2E 重複涵蓋的部分（單元測試已足夠、且會員增測 E2E 帳號成本較高)：
 *   一般使用者存取 → permission denied（9 條單元測試之一已完整覆蓋，含
 *   「不呼叫任何管理端點」的鑑別力斷言）。
 *
 * Topology / Test account: 同 attachments-demo.spec.ts（e2eadmin，見該檔檔頭）。
 * 本檔另外透過 `POST /admin/users`（既有 PHASE-002 端點）在 `beforeAll` 建立
 * 一個合成的一般使用者作為代操作對象，並在 `afterAll` 清理（先刪代建立的
 * 申請、再刪該使用者——`DELETE /admin/users/:id` 於使用者尚有申請紀錄時會
 * 409，須依此順序）。
 */

import { type Page, expect, test } from "@playwright/test";

const E2E_ADMIN = { loginName: "e2eadmin", password: "E2eAdmin@456!" };
const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";

let targetUserId = "";
let targetDisplayName = "";
const createdApplicationIds: string[] = [];

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.waitForURL(`${BASE}/login`);
  await page.fill("#loginName", E2E_ADMIN.loginName);
  await page.fill("#password", E2E_ADMIN.password);
  await page.click('button:has-text("登入")');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
}

test.describe("管理員：使用者申請紀錄 + 代操作 — PHASE-004-T14 Gate E2E", () => {
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page);

    const suffix = Date.now().toString(36);
    targetDisplayName = `T14目標使用者${suffix}`;
    const res = await page.request.post(`${API_BASE}/admin/users`, {
      data: {
        loginName: `e2e-t14-${suffix}`,
        displayName: targetDisplayName,
        temporaryPassword: "E2eTarget@789!",
      },
    });
    const body = (await res.json()) as { user: { id: string } };
    targetUserId = body.user.id;

    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page);

    // 先刪代建立的申請（否則使用者仍「有歷史」，刪除使用者會 409），再刪使用者。
    for (const id of createdApplicationIds) {
      try {
        await page.request.delete(`${API_BASE}/applications/${id}`);
      } catch {
        // ignore — best-effort cleanup
      }
    }
    if (targetUserId) {
      try {
        await page.request.delete(`${API_BASE}/admin/users/${targetUserId}`);
      } catch {
        // ignore
      }
    }

    await context.close();
  });

  test("未選使用者停用代操作入口 → 選定後啟用 → 代建立差旅草稿 → 導向草稿編輯頁 → 該使用者列表可見（AC-78/79/84）", async ({
    page,
  }) => {
    await login(page);

    // 1. 一般化入口（未選使用者）→ 代操作入口停用。
    await page.goto(`${BASE}/admin/applications`);
    await page.waitForURL(`${BASE}/admin/applications`);
    const createBtn = page.getByRole("button", { name: "代建立差旅草稿" });
    await expect(createBtn).toBeDisabled();
    await expect(page.getByText("請先選擇使用者")).toBeVisible();

    // 2. 從下拉選單選定合成的目標使用者 → 入口啟用（反向案例）。
    await page.selectOption("#admin-user-select", targetUserId);
    await expect(createBtn).toBeEnabled();
    await expect(page.getByText("該使用者尚無申請紀錄。")).toBeVisible({ timeout: 10000 });

    // 3. 代建立差旅草稿 → 導向該草稿的編輯頁（AC-78）。
    await createBtn.click();
    await page.waitForURL(/\/applications\/travel\/(?!new)[^/]+$/, { timeout: 15000 });
    await expect(page.locator("h1")).toContainText("差旅補助申請（草稿）");
    const newAppId = new URL(page.url()).pathname.split("/").pop() as string;
    createdApplicationIds.push(newAppId);

    // 4. 直接以 :userId 路由回到該使用者的申請紀錄頁 → 剛建立的草稿必須出現
    //    在「該使用者」的清單（證明 ownerId=目標使用者，非管理員自己，AC-84）。
    await page.goto(`${BASE}/admin/users/${targetUserId}/applications`);
    await page.waitForURL(`${BASE}/admin/users/${targetUserId}/applications`);
    await expect(page.locator("h1")).toContainText(targetDisplayName);
    await expect(page.locator(".app-list-table")).toContainText("草稿", { timeout: 10000 });
  });

  test("響應式（375px）：管理員使用者申請紀錄頁 body 無水平溢位", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page);

    await page.goto(`${BASE}/admin/users/${targetUserId}/applications`);
    await page.waitForURL(`${BASE}/admin/users/${targetUserId}/applications`);
    await expect(page.locator("h1")).toContainText(targetDisplayName);

    const overflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});
