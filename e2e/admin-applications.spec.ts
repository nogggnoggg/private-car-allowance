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

/** Minimal valid 1x1 JPEG (real FF D8 FF header) — 同 travel-application.spec.ts。 */
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

// PHASE-004-R7（S-3 情境4 缺口）：需要「已完成」申請才能驗證「請建立修正版」
// 提示，故此處也需要一組有效補助參數覆蓋的出差日期。與
// travel-application.spec.ts 使用相同的 idempotent「先查後建」策略（見該檔
// `ensureParametersCoverDate` 的文件註解——理由同樣適用：跨檔共用 dev DB、
// 參數版本無 DELETE 端點）。刻意選用與該檔不同的 `effectiveFrom`/日期，避免
// 兩檔的「先查後建」在極端情況下對同一 `effectiveFrom` 產生 409（各自獨立
// 即可，不需要共用同一版本）。
const COMPLETE_GAP_TRIP_DATE = "2025-04-20";
const COMPLETE_GAP_PARAM_EFFECTIVE_FROM = "2021-01-01";
const COMPLETE_GAP_FUEL_UNIT_PRICE = 5.5;
const COMPLETE_GAP_ETC_UNIT_PRICE = 1.2;

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

async function ensureCompleteGapParametersCovered(page: Page): Promise<void> {
  const [fuelRes, etcRes] = await Promise.all([
    page.request.get(`${API_BASE}/parameters/fuel`),
    page.request.get(`${API_BASE}/parameters/etc`),
  ]);
  const { versions: fuelVersions } = (await fuelRes.json()) as {
    versions: { effectiveFrom: string }[];
  };
  const { versions: etcVersions } = (await etcRes.json()) as {
    versions: { effectiveFrom: string }[];
  };
  const covers = (versions: { effectiveFrom: string }[]) =>
    versions.some((v) => v.effectiveFrom <= COMPLETE_GAP_TRIP_DATE);

  if (!covers(fuelVersions)) {
    const res = await page.request.post(`${API_BASE}/parameters/fuel`, {
      data: {
        unitPrice: COMPLETE_GAP_FUEL_UNIT_PRICE,
        effectiveFrom: COMPLETE_GAP_PARAM_EFFECTIVE_FROM,
      },
    });
    if (!res.ok()) throw new Error(`E2E 設定油資參數失敗: ${res.status()} ${await res.text()}`);
  }
  if (!covers(etcVersions)) {
    const res = await page.request.post(`${API_BASE}/parameters/etc`, {
      data: {
        unitPrice: COMPLETE_GAP_ETC_UNIT_PRICE,
        effectiveFrom: COMPLETE_GAP_PARAM_EFFECTIVE_FROM,
      },
    });
    if (!res.ok()) throw new Error(`E2E 設定 ETC 參數失敗: ${res.status()} ${await res.text()}`);
  }
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

  /**
   * PHASE-004-R7（S-3 情境4 缺口）：Spec §11.4 項4「管理員…對 A 已完成申請
   * 按編輯 → 顯示『請建立修正版』」——本檔既有情境只落地到「檢視」與「代
   * 建立」，「已完成拒改提示」缺口由本測試補齊。
   *
   * 完成僅能由申請擁有人本人執行（D17，管理員不得代完成，見
   * backend/src/applications/routes.ts `POST /applications/:id/complete` 的
   * owner-only 判定），故本測試建立一個**專屬**（不與上方共用 `targetUserId`
   * 混用）的合成目標使用者，管理員代建立草稿＋代上傳附件＋代填表（PUT 允許
   * owner-or-admin），再切換該使用者本人的 session 完成申請，最後切回管理員
   * session 驗證唯讀檢視。
   *
   * 該使用者本人的密碼變更（`mustChangePassword` 強制流程）以
   * `POST /me/password` API 直接完成——這是 §5.1 定義的既有自助端點，非繞過
   * 授權；本測試要驗證的是「已完成拒改提示」，非密碼變更流程本身（該流程
   * 已在其他測試涵蓋）。
   */
  test("管理員代建立草稿→使用者本人完成後→管理員檢視為唯讀，顯示「請建立修正版」提示、無編輯/儲存入口", async ({
    page,
    browser,
  }) => {
    await login(page);
    await ensureCompleteGapParametersCovered(page);

    const suffix = Date.now().toString(36);
    const loginName = `e2e-t14c-${suffix}`;
    const displayName = `T14完成情境使用者${suffix}`;
    const tempPassword = "E2eComplete@789!";
    const purpose = `T14情境4完成測試${suffix}`;

    // 1. 建立專屬目標使用者。
    const createUserRes = await page.request.post(`${API_BASE}/admin/users`, {
      data: { loginName, displayName, temporaryPassword: tempPassword },
    });
    expect(createUserRes.ok()).toBe(true);
    const { user } = (await createUserRes.json()) as { user: { id: string } };
    const targetId = user.id;

    // 2. 管理員代建立草稿（AC-78）。
    const createDraftRes = await page.request.post(
      `${API_BASE}/admin/users/${targetId}/applications/travel`,
      { data: {} }
    );
    expect(createDraftRes.ok()).toBe(true);
    const { application } = (await createDraftRes.json()) as { application: { id: string } };
    const appId = application.id;
    createdApplicationIds.push(appId);

    // 3. 管理員代上傳附件（`?ownerId=` 由 ADMIN 指定他人，見
    //    backend/src/attachment/routes.ts POST /attachments 之 D11 分支）。
    const uploadRes = await page.request.post(`${API_BASE}/attachments?ownerId=${targetId}`, {
      multipart: {
        file: { name: "on-behalf-complete.jpg", mimeType: "image/jpeg", buffer: MINIMAL_JPEG },
      },
    });
    expect(uploadRes.ok()).toBe(true);
    const { attachment } = (await uploadRes.json()) as { attachment: { id: string } };

    // 4. 管理員代填表（PUT 允許 owner-or-admin，見 routes.ts `isOnBehalf` 分支）。
    const putRes = await page.request.put(`${API_BASE}/applications/travel/${appId}`, {
      data: {
        tripDate: COMPLETE_GAP_TRIP_DATE,
        purpose,
        segments: [
          {
            origin: "台北",
            destination: "新竹",
            totalKm: "80",
            highwayKm: "60",
            attachmentIds: [attachment.id],
          },
        ],
      },
    });
    expect(putRes.ok()).toBe(true);

    // 5. 切換為使用者本人 session：完成僅能由擁有人執行（D17）。
    const targetContext = await browser.newContext();
    const targetPage = await targetContext.newPage();
    try {
      const loginRes = await targetPage.request.post(`${API_BASE}/auth/login`, {
        data: { loginName, password: tempPassword },
      });
      expect(loginRes.ok()).toBe(true);

      const changePasswordRes = await targetPage.request.post(`${API_BASE}/me/password`, {
        data: { currentPassword: tempPassword, newPassword: "E2eCompleteChanged1!" },
      });
      expect(changePasswordRes.ok()).toBe(true);

      const completeRes = await targetPage.request.post(
        `${API_BASE}/applications/${appId}/complete`
      );
      expect(completeRes.ok()).toBe(true);
    } finally {
      await targetContext.close();
    }

    // 6. 管理員（UI）檢視該（已完成）申請 → 唯讀 + D13 zh-TW 文案 + 無任何
    //    編輯/儲存/完成入口（畫面實際文字，見
    //    frontend/src/pages/TravelApplicationPage.tsx COMPLETED 分支）。
    await page.goto(`${BASE}/applications/travel/${appId}`);
    await page.waitForURL(`${BASE}/applications/travel/${appId}`);
    await expect(page.locator("h1")).toContainText("差旅補助申請（已完成）", { timeout: 10000 });
    await expect(page.locator(".success-block")).toContainText(
      "如需異動，請聯絡管理員建立修正版（功能將於後續版本提供）"
    );
    await expect(page.locator('button:has-text("儲存草稿")')).toHaveCount(0);
    await expect(page.locator('button:has-text("完成申請")')).toHaveCount(0);
    await expect(page.locator("#trip-date")).toHaveCount(0);
    await expect(page.locator("#trip-purpose")).toHaveCount(0);

    // ---- cleanup（best-effort）----
    // 已完成申請不可刪除（AC-06，403），該使用者因而恆有申請歷史
    // （userHasHistory），刪除使用者也會 409——這是本 Phase「已完成不可逆」
    // 的既有業務規則（見 Spec §12 Rollback「不可逆資產」），非本測試的缺陷；
    // 兩者皆為合成資料，允許以已知、有紀錄的方式留在共用 dev DB。
    await page.request.delete(`${API_BASE}/admin/users/${targetId}`).catch(() => {});
  });
});
