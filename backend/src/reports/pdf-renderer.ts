/**
 * PDF 渲染器 — PHASE-008-T7（BE-US-27；NFR-US-14④）
 *
 * Spec `docs/specs/PHASE-008.md` AC-09(a)(b)、§9.1 步驟 (5)、§10-2~4、
 * §16 D4（PDF 執行環境：同容器、每次請求啟動用畢即關）。
 *
 * ---------------------------------------------------------------------------
 * D4(a) 每次請求啟動、用畢即關（推薦方案，已批准）
 * ---------------------------------------------------------------------------
 * 不採「常駐瀏覽器實例」（D4 選項 b）——避免殭屍瀏覽器與跨請求狀態污染
 * （§10-4）。每次呼叫 {@link renderPdf} 皆 `chromium.launch()` 一個全新實
 * 例，`try/finally` 保證**無論成功、渲染逾時或任何例外**，`browser.close()`
 * 皆會被呼叫（AC-09(b)：逾時須明確錯誤且不懸掛、不留殭屍瀏覽器）。
 *
 * ---------------------------------------------------------------------------
 * 啟動參數（§16 D4 附帶批准之安全取捨，人類已明示接受）
 * ---------------------------------------------------------------------------
 * `--no-sandbox`：容器內以非 root 執行時 Chromium sandbox 需要額外核心權
 * 限；本用途僅載入呼叫端已產生、零腳本、零外部資源之 HTML（T5
 * `renderReportHtml` 之 AC-16(a) 結構性守門保證），攻擊面已封閉，故關閉
 * sandbox 之殘餘風險可接受——此為人類已明示批准之安全取捨，**不得因後續重
 * 構而靜默移除**。
 * `--disable-dev-shm-usage`：容器內 `/dev/shm` 常受限，避免 Chromium 因共
 * 享記憶體不足而崩潰。
 *
 * ---------------------------------------------------------------------------
 * `setContent` 之 `waitUntil` 選擇（FW 移交：T5 已保證 HTML 自足、零網路
 * 請求，本檔 setContent 不需網路容忍）
 * ---------------------------------------------------------------------------
 * 選用 `"load"`（較保守的完整值）而非 `"domcontentloaded"`：本文件所有圖片
 * 皆為 `data:` URI（T6 `embedImages` 保證），瀏覽器仍需解碼／繪製這些內嵌
 * 位元組才算 `load` 完成；由於零外部網路請求，`"load"` 不會因等待網路資源
 * 而延遲或懸掛，卻能確保 `page.pdf()` 擷取時圖片已就緒——避免用
 * `"domcontentloaded"` 可能在圖片解碼完成前就擷取快照而漏圖的風險。
 *
 * ---------------------------------------------------------------------------
 * 本檔不讀環境變數（沿 T6 `report-images.ts` D16 之既有慣例，§9.1 (3)）
 * ---------------------------------------------------------------------------
 * `timeoutMs`（對應 `REPORT_PDF_TIMEOUT_MS`，預設 30000）一律由呼叫端傳
 * 入；本檔零 `process.env` 讀取，維持純粹、易於零 env 注入測試。
 *
 * ---------------------------------------------------------------------------
 * 逾時實作方式（重要：`page.pdf()` 本身無 `timeout` 參數）
 * ---------------------------------------------------------------------------
 * Playwright 之 `page.pdf()` API **不接受** `timeout` 選項（其底層以
 * `kNoTimeout` 呼叫協定層，實測與型別定義皆確認——見 Handoff 附證）；只有
 * `page.setContent()` 等可操作動作支援 `timeout`。故本檔以外部
 * `Promise.race`（{@link withTimeout}）包住整段渲染（`setContent` ＋
 * `pdf`），確保**即使 `page.pdf()` 本身卡住，整個 `renderPdf()` 呼叫仍會
 * 在 `options.timeoutMs` 內以明確錯誤 reject**（AC-09(b)）；`setContent`
 * 額外傳入 `{ timeout: options.timeoutMs }` 作第一道防線（結構性可測）。
 * 逾時後被放棄的內部渲染 promise 會隨 `finally` 區塊之 `browser.close()`
 * 強制終止而自然收斂（不留殭屍瀏覽器）。
 *
 * ---------------------------------------------------------------------------
 * 輸出校驗（§9.1 步驟 (5)：「校驗：%PDF- 開頭、%%EOF 結尾、length > 0」）
 * ---------------------------------------------------------------------------
 * `page.pdf()` 於正常路徑理論上必產生合法 PDF 位元組；本檔仍主動校驗開頭
 * `%PDF-`、結尾 `%%EOF`（去除尾端空白後比對）與非零長度，任一不符即拋出明
 * 確錯誤——防禦性守門，避免 Chromium 行為異常時靜默回傳損毀位元組（見測
 * 試檔「PDF 校驗跳過」mutant 自證）。
 */
import { type Browser, chromium } from "playwright";

/**
 * Chromium 啟動參數（Spec §16 D4 附帶批准；不得移除）。
 */
const LAUNCH_ARGS = ["--no-sandbox", "--disable-dev-shm-usage"] as const;

export interface RenderPdfOptions {
  /** 逾時毫秒數（呼叫端傳入，通常取自 `REPORT_PDF_TIMEOUT_MS`）。 */
  timeoutMs: number;
}

/**
 * 將自足 HTML（零外部資源，見 `report-html.ts` AC-16(a)）渲染為 PDF 位元
 * 組。每次呼叫啟動全新 Chromium 實例，回傳前必關閉（D4(a)）。
 *
 * @throws 逾時（整段渲染超過 `options.timeoutMs`，見上方「逾時實作方式」）
 *   或輸出位元組未通過 `%PDF-`／`%%EOF`／非零長度校驗時，拋出明確錯誤
 *   （AC-09(b)）。瀏覽器於任一失敗路徑皆確實關閉（`finally`），不懸掛、
 *   不殘留殭屍瀏覽器。
 */
export async function renderPdf(html: string, options: RenderPdfOptions): Promise<Buffer> {
  const browser: Browser = await chromium.launch({
    args: [...LAUNCH_ARGS],
    timeout: options.timeoutMs,
  });
  try {
    const pdfBytes = await withTimeout(
      renderOnce(browser, html, options.timeoutMs),
      options.timeoutMs
    );
    assertValidPdfBytes(pdfBytes);
    return pdfBytes;
  } finally {
    await browser.close();
  }
}

/** `renderPdf` 之實際渲染步驟：`setContent` → `pdf()`。抽出供 {@link withTimeout} 包裹。 */
async function renderOnce(browser: Browser, html: string, timeoutMs: number): Promise<Buffer> {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load", timeout: timeoutMs });
  return page.pdf({ preferCSSPageSize: true });
}

/**
 * 以計時器包住 `promise`：逾時即以明確錯誤 reject。`promise` 本身不會被
 * 取消（Playwright 無此能力），但其之後的解決／拒絕已無外部觀察者——呼叫
 * 端之 `finally` 區塊會 `browser.close()`，使該未完成操作隨瀏覽器程序終
 * 止而自然收斂（AC-09(b) 不留殭屍瀏覽器）。
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`PDF render exceeded ${timeoutMs}ms timeout`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * §9.1 步驟 (5) 之渲染層輸出校驗：`%PDF-` 開頭、`%%EOF` 結尾、長度 > 0。
 * 不符即拋出明確錯誤（供上游 T8 映射為 `REPORT_GENERATION_FAILED`，
 * `details.stage = "RENDER"`；本檔不知曉、不依賴該錯誤碼常數）。
 */
function assertValidPdfBytes(bytes: Buffer): void {
  if (bytes.length === 0) {
    throw new Error("PDF render produced zero-length output");
  }
  const head = bytes.subarray(0, 5).toString("latin1");
  if (head !== "%PDF-") {
    throw new Error("PDF render output does not start with %PDF- signature");
  }
  const tail = bytes
    .subarray(Math.max(0, bytes.length - 16))
    .toString("latin1")
    .trimEnd();
  if (!tail.endsWith("%%EOF")) {
    throw new Error("PDF render output does not end with %%EOF marker");
  }
}
