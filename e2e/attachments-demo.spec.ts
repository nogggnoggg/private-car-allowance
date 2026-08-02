/**
 * E2E: Attachment Demo Page — PHASE-003 T7 Integration Gate
 *
 * AC-19: Upload a valid image → thumbnail preview appears
 * AC-20: Select >10MB or non-image file → error message shown, no success report
 * AC-21: After linking, delete → reload does not show the attachment
 *
 * Topology:
 *   Vite dev server: http://localhost:5173 (proxies /api → backend:3000)
 *   Backend:         http://localhost:3000
 *   Database:        postgresql://testuser:test@localhost:55434/app_test
 *
 * Test account: e2eadmin / E2eAdmin@456! (seeded by running seed-admin.ts before E2E)
 * Data cleanup: performed in afterAll via backend API calls (synthetic data only).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Page, expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Credentials — synthetic test data
// ---------------------------------------------------------------------------
const E2E_USER = { loginName: "e2eadmin", password: "E2eAdmin@456!" };
const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";

// ---------------------------------------------------------------------------
// Minimal valid image buffers (real magic bytes)
// ---------------------------------------------------------------------------

/** Minimal valid 1x1 JPEG (real FF D8 FF header) */
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

// PHASE-004-T13: MINIMAL_PNG / pngFixture removed along with the AC-21 test
// that used them (migrated to e2e/travel-application.spec.ts — see the
// pointer comment where that test used to be, below). The remaining tests in
// this file (AC-19/20) only ever used jpegFixture / inline buffers.

// ---------------------------------------------------------------------------
// File fixtures written to temp dir
// ---------------------------------------------------------------------------
let tmpDir: string;
let jpegFixture: string;

// ---------------------------------------------------------------------------
// Collect attachment IDs for cleanup
// ---------------------------------------------------------------------------
const createdAttachmentIds: string[] = [];

// ---------------------------------------------------------------------------
// Auth helper: login via UI and navigate to /attachments-demo
// ---------------------------------------------------------------------------
async function loginAndGoToDemo(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.waitForURL(`${BASE}/login`);

  // Fill login form using the known IDs from LoginPage.tsx
  await page.fill("#loginName", E2E_USER.loginName);
  await page.fill("#password", E2E_USER.password);
  await page.click('button:has-text("登入")');

  // Wait for redirect away from login
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
  await page.goto(`${BASE}/attachments-demo`);
  await page.waitForURL(`${BASE}/attachments-demo`, { timeout: 10000 });
  // Wait for page to be interactive
  await expect(page.locator("h1")).toContainText("附件功能驗收頁");
}

// ---------------------------------------------------------------------------
// Cleanup helper: delete attachment via backend API using page.request context
// ---------------------------------------------------------------------------
async function cleanupAttachments(page: Page): Promise<void> {
  for (const id of createdAttachmentIds) {
    try {
      await page.request.delete(`${API_BASE}/attachments/${id}`);
    } catch {
      // best-effort cleanup — ignore individual failures
    }
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------
test.beforeAll(async () => {
  // Create temp fixture files
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-att-"));
  jpegFixture = path.join(tmpDir, "test-photo.jpg");

  fs.writeFileSync(jpegFixture, MINIMAL_JPEG);
});

test.afterAll(async () => {
  // Clean up fixture files
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("附件驗收頁 — PHASE-003 Gate E2E", () => {
  // Cleanup created attachments after each test so tests are independent
  test.afterEach(async ({ page }) => {
    await cleanupAttachments(page);
    createdAttachmentIds.length = 0;
  });

  /**
   * AC-19: Upload valid JPEG → thumbnail preview <img> appears
   */
  test("AC-19: 上傳合法 JPEG 圖片 → 顯示縮圖預覽", async ({ page }) => {
    await loginAndGoToDemo(page);

    // Intercept file chooser triggered by the upload button
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.click('button:has-text("選擇圖片")'),
    ]);
    await fileChooser.setFiles(jpegFixture);

    // Wait for thumbnail to appear (AC-19) — check in uploader section
    const img = page.locator('img[alt="test-photo.jpg"]').first();
    await expect(img).toBeVisible({ timeout: 15000 });

    // Verify the src points to the thumbnail endpoint.
    // Frontend converts backend-relative "/attachments/:id/thumbnail"
    // → "/api/attachments/:id/thumbnail" (via toFrontendUrl) for Vite proxy routing.
    const src = await img.getAttribute("src");
    expect(src).toMatch(/\/api\/attachments\/.+\/thumbnail/);

    // Record attachment ID for cleanup
    const match = src?.match(/\/api\/attachments\/([^/]+)\/thumbnail/);
    if (match?.[1]) createdAttachmentIds.push(match[1]);
  });

  /**
   * AC-20: Select >10 MB file → client-side error, no success, no thumbnail
   */
  test("AC-20: 選擇超過 10MB 的檔案 → 顯示大小限制訊息，不誤報成功", async ({ page }) => {
    await loginAndGoToDemo(page);

    // Create an 11MB file in-memory via setFiles buffer
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.click('button:has-text("選擇圖片")'),
    ]);
    await fileChooser.setFiles({
      name: "too-big.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.alloc(11 * 1024 * 1024, 0),
    });

    // Error alert should show (AC-20) — should appear quickly (client-side check)
    const alert = page.locator('[role="alert"]').first();
    await expect(alert).toBeVisible({ timeout: 5000 });
    await expect(alert).toContainText("大小超過上限");

    // No thumbnail — upload request should NOT have been sent
    await expect(page.locator('img[alt="too-big.jpg"]')).not.toBeVisible();
  });

  /**
   * AC-20: Select PDF (non-image MIME type) → client-side format error, no success
   */
  test("AC-20: 選擇非支援格式（PDF MIME）→ 顯示格式限制訊息，不誤報成功", async ({ page }) => {
    await loginAndGoToDemo(page);

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.click('button:has-text("選擇圖片")'),
    ]);
    await fileChooser.setFiles({
      name: "document.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 synthetic pdf for testing"),
    });

    const alert = page.locator('[role="alert"]').first();
    await expect(alert).toBeVisible({ timeout: 5000 });
    await expect(alert).toContainText("格式不支援");

    await expect(page.locator('img[alt="document.pdf"]')).not.toBeVisible();
  });

  // AC-21 was originally verified here: "上傳 PNG → 關聯 → 刪除 → 重新載入不顯示".
  // MIGRATED in PHASE-004-T13 to e2e/travel-application.spec.ts (see that
  // file's header comment for the full before/after coverage mapping).
  // Rationale: the scenario relied on the public `POST /attachments/:id/link`
  // endpoint and this page's "關聯"/「已關聯附件清單」 UI, both of which were
  // removed in PHASE-004-T11 (D12, AR-D 閉環 — that endpoint let a caller
  // self-supply `limit`/`refId`/`containerState`, a real authorization bypass
  // once PHASE-004 has real completed applications). There is no equivalent
  // "link" action left on THIS page to test — attachment linking is now
  // exclusively driven by the real travel draft form's `PUT
  // /applications/travel/:id` (`attachmentIds[]`, D15), which is what the
  // migrated scenario exercises instead, with STRONGER coverage (it also
  // proves the link survives a page reload via real backend persistence,
  // which this demo page never did — it never fetched a server-side linked
  // list back).
});
