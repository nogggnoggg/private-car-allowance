/**
 * E2E 共用 helper — PHASE-011-T17／AC-29(b)（D16-3）
 *
 * ---------------------------------------------------------------------------
 * 規範出處（`docs/specs/PHASE-011.md` :435 逐字）
 * ---------------------------------------------------------------------------
 * 「E2E 共用 helper 抽取（D-5）：**射程限定**——僅抽取 login／`API_BASE` 直
 *   呼播種／`RUN_ID` 三類；**不得**觸動任何 spec 之播種日常數（會與 AC-02 之
 *   哨兵不變式互撞）。抽取後 E2E **55/55** 全綠。」
 *
 * ---------------------------------------------------------------------------
 * 抽取範圍與保守原則
 * ---------------------------------------------------------------------------
 * 只抽**逐字元全等**之樣板區塊（實查結果，見 Task Handoff 逐檔清單），三類：
 *   1. `loginAsAdmin`——9 個 spec 檔逐字相同。
 *   2. `generateRunSuffix`——8 個 spec 檔之 `RUN_ID`／`suffix` 賦值運算式逐字
 *      相同（`${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`）；
 *      本函式**不**含任何播種日或參數版本常數，純粹是「產生一個亂數後綴」
 *      之工具，與 AC-02 之播種日哨兵不變式零關聯。
 *   3. `uploadAttachment`——2 個逐字相同之 4 檔（`audit-log.spec.ts`／
 *      `void-application.spec.ts` 為 3 參數、預設 `image/jpeg`；
 *      `report-pdf.spec.ts`／`report-print-layout.spec.ts` 為 4 參數、顯式
 *      `mimeType`）。本檔以「第 4 參數帶預設值」之單一函式涵蓋兩種既有呼叫
 *      形態，兩者呼叫端之行為**逐字不變**（3 參數呼叫時預設值與原 3 參數版
 *      本之硬編碼 `"image/jpeg"` 相同）。
 *
 * **不**抽取之候選（實查後判定非逐字重複，保守原則下不動）：
 *   `loginAsStaff`（5 檔雖大致同形，但涉及模組層級可變旗標
 *   `staffPasswordAlreadyChanged` 之跨呼叫狀態，且另兩檔
 *   `depreciation-allowance.spec.ts`／`maintenance-allowance.spec.ts` 之錯誤
 *   訊息字面不同，非逐字重複）；`createSyntheticUser`／`seedCompletedTravel`
 *   等播種函式（各檔之合成使用者命名前綴、顯示名稱、業務欄位皆為該檔專屬，
 *   非逐字重複）。
 *
 * `E2E_ADMIN`／`BASE`／`API_BASE` 三個字面值於各呼叫端 spec 檔仍各自保留一
 * 份宣告（供該檔內其餘程式碼使用，非本次抽取範圍）；本檔內部另有一份相同字
 * 面值供三個 helper 自身使用，兩者數值逐字相同，純屬平行存在、無需 import
 * 對齊（皆為公開之 E2E 測試帳號與本機開發位址，非 secrets）。
 */
import type { Page } from "@playwright/test";

const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";
const E2E_ADMIN = { loginName: "e2eadmin", password: "E2eAdmin@456!" };

/** 以 `E2E_ADMIN` 帳密經登入頁登入，等待導離 `/login`。9 個 spec 檔逐字同形。 */
export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.waitForURL(`${BASE}/login`);
  await page.fill("#loginName", E2E_ADMIN.loginName);
  await page.fill("#password", E2E_ADMIN.password);
  await page.click('button:has-text("登入")');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
}

/**
 * 產生單次執行之隨機後綴（時間戳 base36 ＋ 0-999 亂數），供合成使用者名／
 * `RUN_ID` 隔離用。8 個 spec 檔之賦值運算式逐字相同；每次呼叫皆重新取樣。
 */
export function generateRunSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

/**
 * 以 `multipart/form-data` 直呼 `POST /attachments` 播種一筆附件，回傳
 * `attachment.id`。`mimeType` 預設 `"image/jpeg"`（沿 3 參數呼叫端既有硬編
 * 碼值），4 參數呼叫端顯式帶入，行為與原兩份逐字實作相同。
 */
export async function uploadAttachment(
  page: Page,
  buffer: Buffer,
  name: string,
  mimeType = "image/jpeg"
): Promise<string> {
  const res = await page.request.post(`${API_BASE}/attachments`, {
    multipart: { file: { name, mimeType, buffer } },
  });
  if (!res.ok())
    throw new Error(`E2E 上傳附件失敗（${name}）: ${res.status()} ${await res.text()}`);
  const { attachment } = (await res.json()) as { attachment: { id: string } };
  return attachment.id;
}
