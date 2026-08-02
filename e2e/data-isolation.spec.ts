/**
 * E2E: 資料隔離 — PHASE-004-R7（S-3 情境3）Gate E2E
 *
 * Spec §11.4 項3：「使用者 B 以直連 URL 存取 A 的申請與附件 → 皆不得取得」。
 * 這條情境在 PHASE-004 終審前完全未落地（reviewer 逐條核對後確認缺席）——
 * AC-72/73/75 在 integration 層已有紮實覆蓋（見
 * backend/test/integration/*.test.ts），但「真實瀏覽器直連 URL、真實 React
 * 頁面渲染 permission-denied、畫面全文不含 A 的業務資料」這件事只有 E2E
 * 能證明。本檔新增、獨立於既有 3 個 E2E 檔案。
 *
 * Topology / Test account: 同 travel-application.spec.ts（e2eadmin 作為使用者
 * A；使用者 B 為本檔於 `POST /admin/users` 合成建立、測後清理）。
 *
 * 授權背景（供理解斷言依據）：
 *   - `GET /applications/travel/:id`：先 404（不存在）／存在則
 *     `assertOwnershipOrAdmin` 判定，非擁有人非管理員 → 403 FORBIDDEN
 *     （backend/src/applications/routes.ts）。前端 `TravelApplicationPage.tsx`
 *     將 403/401 一律導向 `permission-denied` 態（`.permission-denied-block`，
 *     文字「您沒有權限檢視或編輯這筆申請。」）。
 *   - `GET /attachments/:id/thumbnail`：`requireAuth`（無
 *     `requirePasswordChanged`，D8）+ `assertOwnershipOrAdmin`（D6），非擁有人
 *     非管理員 → 403 FORBIDDEN（backend/src/attachment/access-service.ts）。
 *   - 使用者 B 以 `POST /admin/users` 建立，預設 `mustChangePassword=true`
 *     （backend/src/admin/routes.ts）。若不先解除，前端 `RequireAuth`
 *     （frontend/src/components/RouteGuard.tsx）會把任何路徑都導向
 *     `/change-password-forced`，混淆「資料隔離 403」與「強制改密」兩件事。
 *     本檔以 `POST /me/password`（既有自助端點，非繞過）在 B 首次登入後立即
 *     解除，讓後續導向真正落在授權判定路徑上。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";

const E2E_ADMIN = { loginName: "e2eadmin", password: "E2eAdmin@456!" };
const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";

/** Minimal valid 1x1 JPEG (real FF D8 FF header) — 同其餘 E2E 檔慣例。 */
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

let tmpDir: string;
let jpegFixture: string;

test.beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-isolation-"));
  jpegFixture = path.join(tmpDir, "a-secret-photo.jpg");
  fs.writeFileSync(jpegFixture, MINIMAL_JPEG);
});

test.afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

test.describe("資料隔離 — PHASE-004-R7 S-3 情境3 Gate E2E", () => {
  test("使用者 B 直連 URL 存取使用者 A 的申請與附件 → 皆被拒，畫面不含 A 的業務資料", async ({
    browser,
  }) => {
    const suffix = Date.now().toString(36);
    const secretPurpose = `A的機密出差目的-${suffix}`;
    const secretOrigin = `A的祕密出發地-${suffix}`;
    const secretDestination = `A的祕密目的地-${suffix}`;

    // ---- Context A（e2eadmin）：建立草稿 + 一段行程 + 上傳附件 ----
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    let appId = "";
    let attachmentId = "";

    try {
      await pageA.goto(`${BASE}/login`);
      await pageA.waitForURL(`${BASE}/login`);
      await pageA.fill("#loginName", E2E_ADMIN.loginName);
      await pageA.fill("#password", E2E_ADMIN.password);
      await pageA.click('button:has-text("登入")');
      await pageA.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });

      await pageA.goto(`${BASE}/`);
      await pageA.waitForURL(`${BASE}/`);
      await pageA.click('a:has-text("新增差旅補助")');
      await pageA.waitForURL(/\/applications\/travel\/(?!new)[^/]+$/, { timeout: 15000 });
      appId = new URL(pageA.url()).pathname.split("/").pop() as string;

      await pageA.fill("#trip-purpose", secretPurpose);

      await pageA.click('button:has-text("新增行程段")');
      const segment = pageA.locator(".trip-segment").first();
      await segment.getByLabel("出發地點").fill(secretOrigin);
      await segment.getByLabel("到達地點").fill(secretDestination);
      await segment.getByLabel("總里程（公里）").fill("50");
      await segment.getByLabel("高速里程（公里）").fill("10");

      const [fileChooser] = await Promise.all([
        pageA.waitForEvent("filechooser"),
        segment.locator('button:has-text("選擇圖片")').click(),
      ]);
      await fileChooser.setFiles(jpegFixture);
      const uploadedImg = segment.locator('img[alt="a-secret-photo.jpg"]');
      await expect(uploadedImg).toBeVisible({ timeout: 15000 });
      const src = await uploadedImg.getAttribute("src");
      const match = src?.match(/\/api\/attachments\/([^/]+)\/thumbnail/);
      if (!match?.[1]) {
        throw new Error("情境3設定失敗：無法從縮圖 src 擷取附件 id");
      }
      attachmentId = match[1];

      await pageA.click('button:has-text("儲存草稿")');
      await expect(pageA.getByText("草稿已儲存。")).toBeVisible({ timeout: 10000 });

      // ---- 建立使用者 B（透過 A 的管理員 session）----
      const bLoginName = `e2e-iso-b-${suffix}`;
      const bTempPassword = "E2eIsoB@789!";
      const createBRes = await pageA.request.post(`${API_BASE}/admin/users`, {
        data: {
          loginName: bLoginName,
          displayName: `隔離測試B${suffix}`,
          temporaryPassword: bTempPassword,
        },
      });
      expect(createBRes.ok()).toBe(true);
      const { user: userB } = (await createBRes.json()) as { user: { id: string } };

      // ---- Context B：登入 → 解除強制改密 → 直連 URL 存取 A 的資源 ----
      const contextB = await browser.newContext();
      const pageB = await contextB.newPage();
      try {
        await pageB.goto(`${BASE}/login`);
        await pageB.waitForURL(`${BASE}/login`);
        await pageB.fill("#loginName", bLoginName);
        await pageB.fill("#password", bTempPassword);
        await pageB.click('button:has-text("登入")');
        // mustChangePassword=true → RouteGuard 導向 /change-password-forced（而非 /login 之外任意頁）。
        await pageB.waitForURL(`${BASE}/change-password-forced`, { timeout: 15000 });

        const changePasswordRes = await pageB.request.post(`${API_BASE}/me/password`, {
          data: { currentPassword: bTempPassword, newPassword: "E2eIsoBChanged1!" },
        });
        expect(changePasswordRes.ok()).toBe(true);

        // 直連 URL 存取 A 的申請頁 → permission-denied，且畫面全文不含 A 的業務資料。
        await pageB.goto(`${BASE}/applications/travel/${appId}`);
        await expect(pageB.locator(".permission-denied-block")).toBeVisible({ timeout: 10000 });
        const bodyText = await pageB.locator("body").innerText();
        expect(bodyText).not.toContain(secretPurpose);
        expect(bodyText).not.toContain(secretOrigin);
        expect(bodyText).not.toContain(secretDestination);

        // 直連存取 A 的附件縮圖 → 403 FORBIDDEN，回應內容也不含 A 的業務資料。
        const attResp = await pageB.request.get(
          `${API_BASE}/attachments/${attachmentId}/thumbnail`
        );
        expect(attResp.status()).toBe(403);
        const attBody = await attResp.text();
        expect(attBody).toContain("FORBIDDEN");
        expect(attBody).not.toContain(secretPurpose);
        expect(attBody).not.toContain(secretOrigin);
        expect(attBody).not.toContain(secretDestination);
      } finally {
        // ---- 清理使用者 B（本身無任何申請歷史，可完整刪除）----
        await pageA.request.delete(`${API_BASE}/admin/users/${userB.id}`).catch(() => {});
        await contextB.close();
      }
    } finally {
      // ---- 清理 A 建立的合成資料（草稿尚未完成，可完整刪除）----
      if (attachmentId) {
        await pageA.request.delete(`${API_BASE}/attachments/${attachmentId}`).catch(() => {});
      }
      if (appId) {
        await pageA.request.delete(`${API_BASE}/applications/${appId}`).catch(() => {});
      }
      await contextA.close();
    }
  });
});
