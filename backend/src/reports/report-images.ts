/**
 * 證明圖片嵌入 — PHASE-008-T6（FE-US-23③；跨 Phase 追蹔 T4 預告義務）
 *
 * Spec `docs/specs/PHASE-008.md` AC-13(a)、§9.1 步驟 (3)、§16 D16（sharp 降尺
 * 寸為列印用派生圖，長邊上限 `REPORT_IMAGE_MAX_PX` 預設 1600、不放大小圖、
 * 不持久化，以 `data:` URI 嵌入）。
 *
 * ---------------------------------------------------------------------------
 * 分工（與 T4 `report-data.ts`、T5 `report-html.ts` 之邊界）
 * ---------------------------------------------------------------------------
 * T4 之 `buildReportData` 只讀出附件殼（`attachmentId`／`storageKey`／
 * `mimeType`／`originalFilename`），`dataUri` 恆 `null`、`missing` 恆
 * `false`。本檔之 {@link embedImages} 是 §9.1 (2)(3) 之間的下一步：讀取
 * `storageKey` 對應之位元組、以 sharp 降尺寸、組成 `data:` URI 填入，並清空
 * `storageKey`（下方「storageKey 清空」節）。T5 之 `renderReportHtml` 純函式
 * 只讀 `dataUri`／`missing`，一律不讀 `storageKey`（FW-1），亦恆信任
 * `dataUri` 已是合法 `data:` 開頭字串（FW-2；本檔為唯一保證點，見下方測試）。
 *
 * ---------------------------------------------------------------------------
 * 回傳新物件（不就地改寫）
 * ---------------------------------------------------------------------------
 * {@link embedImages} 回傳全新的 `ReportData`（含全新的 `travel`／
 * `maintenance`／`depreciation`／`segments`／`attachments` 巢狀物件與陣
 * 列）；輸入之 `ReportData` 與其巢狀物件一律不被修改。理由：`ReportData` 若
 * 被上游（T8 `report-service.ts`）於同一次請求中重複讀取或用於日誌／稽核，
 * 就地改寫會造成別名副作用（同一物件在呼叫端與本函式間共享可變狀態，難以推
 * 理）；回傳新物件是更安全的預設值，成本僅為淺層物件展開（不需要深拷貝整個
 * `ReportData`，因為未觸及的子樹——如 `common`——原樣重用同一參照）。
 *
 * ---------------------------------------------------------------------------
 * `missing` 語意（呼應 T4 檔頭「`dataUri`／`missing` 由 T6 之 `embedImages`
 * 填入」）
 * ---------------------------------------------------------------------------
 * T4 之預設 `missing: false` 代表「尚未嘗試讀取」，非「檔案確定存在」。本檔
 * 對每張圖片恰執行一次讀取嘗試：成功 → `dataUri` 填入、`missing` 維持
 * `false`；失敗（`storage.get` 拋出，或後續 sharp 解碼/降尺寸失敗——沿
 * `upload-service.ts produceThumbnail` D5 之「sharp 失敗即非致命 fallback」
 * 先例，兩者統一視為「圖片無法使用」）→ `dataUri: null`、`missing: true`
 * （B-10；T5 之 `renderImage` 依此二欄擇一渲染佔位說明）。
 *
 * ---------------------------------------------------------------------------
 * storageKey 清空（一次消滅 T4 AR-3 洩漏面）
 * ---------------------------------------------------------------------------
 * 每張圖片無論嵌入成功或失敗，`storageKey` 皆於處理後清為 `""`
 * （`ReportImage.storageKey` 型別為 `string`，定義於 T4 `report-data.ts`，
 * 本檔僅 import、不得放寬為 `string | null`）——嵌入是 `storageKey` 於本流
 * 程中唯一的使用點，處理完畢後該值不再需要，清空可消滅其被下游（例如未來
 * 的日誌／序列化／除錯輸出）意外攜出的洩漏面。此決策為 T4/T5 Gate 移交之
 * 「建議採用」選項；`backend/test/integration/phase8-report-data.test.ts`
 * 既有之 ReportImage 鍵集斷言（`buildReportData` 直接輸出、never 呼叫本檔
 * `embedImages`）之鍵集合不受影響——鍵集斷言比對的是鍵「名稱」而非「值」，
 * 型別維持 `storageKey: string` 未變，故該檔未隨本 Task 修改（Handoff 記錄
 * 此判斷，供複審核銷）。
 *
 * ---------------------------------------------------------------------------
 * mimeType（沿既有 `detect-mime.ts` 封閉聯集，不重寫偵測邏輯）
 * ---------------------------------------------------------------------------
 * `ReportImage.mimeType` 是附件上傳當下已由 `detect-mime.ts`
 * （PHASE-003-T3）以 magic bytes 偵測並持久化之信任值（三型封閉聯集：
 * `image/jpeg`／`image/png`／`image/webp`）。本檔 `data:` URI 之 MIME 前綴
 * 直接原樣使用該欄位，不重新偵測、不新增第二套偵測邏輯（僅 import
 * {@link SupportedMimeType} 作型別標註，不執行任何偵測函式呼叫）。
 *
 * ---------------------------------------------------------------------------
 * 日誌零 key（B-10；§9.4 既有紀律之延伸）
 * ---------------------------------------------------------------------------
 * `storage.get` 失敗時，其 `Error.message`（見 `LocalVolumeStorage.get`）逐
 * 字包含 `storageKey`（例：`Storage key not found: "rpt/xxx/pdf"`）。本檔
 * **刻意不將 `err.message`（甚至整個 `err` 物件）寫入任何 log 呼叫**
 * （`sanitizeForLog` 僅清除憑證樣式字串，不清除 storage key，不足以滿足本
 * 檔義務）——僅記錄 `attachmentId`（非敏感之內部識別碼，非 storage
 * key）與固定字面訊息，確保 log 輸出結構性地零 `storageKey` 值、零
 * `rpt/`／`att/` 子字串（測試以「日誌洩 key」mutant——改記 `err.message`
 * ——實證此為結構性保證而非巧合，見 Task Handoff）。
 */

import type { SupportedMimeType } from "../attachment/detect-mime.js";
import type { Storage } from "../storage/index.js";
import type {
  DepreciationReportBody,
  MaintenanceReportBody,
  ReportData,
  ReportImage,
  TravelReportBody,
} from "./report-data.js";

// ---------------------------------------------------------------------------
// 日誌介面（沿 access-service.ts 既有形狀；本檔僅記錄 attachmentId ＋ 錯誤類
// 別名稱，不含 storage key，見檔頭「日誌零 key」）
// ---------------------------------------------------------------------------

export interface EmbedImagesLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
}

// ---------------------------------------------------------------------------
// 位元組讀取（沿 access-service.ts streamToBuffer 之既有形狀；Storage.get 之
// 回傳型別容許 Buffer | NodeJS.ReadableStream，該檔之實作為私有函式無法
// import，於此重寫等價之最小工具）
// ---------------------------------------------------------------------------

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// 降尺寸（D16：長邊上限、不放大小圖、嵌入位元組 ≤ 原圖）
// ---------------------------------------------------------------------------

/**
 * 先以 `sharp(...).metadata()` 讀出原圖尺寸（不重編碼）判斷長邊是否已在上限
 * 內：若已在上限內，原樣回傳輸入位元組——結構性保證「不放大」與「嵌入位元
 * 組 = 原圖（必然 ≤ 原圖）」，不倚賴 sharp 重編碼後之位元組數比較（重編碼即
 * 使未縮放亦可能因編碼參數差異而改變位元組數）。僅當長邊超過上限時才呼叫
 * `.resize(maxPx, maxPx, { fit: "inside", withoutEnlargement: true })`
 * （沿 `upload-service.ts produceThumbnail` 既有慣例之同一組 sharp 參數）
 * 降尺寸；此分支之輸出長邊必然 ≤ maxPx。
 */
async function resizeForEmbed(bytes: Buffer, maxPx: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const metadata = await sharp(bytes).metadata();
  const longEdge = Math.max(metadata.width ?? 0, metadata.height ?? 0);
  if (longEdge > 0 && longEdge <= maxPx) {
    return bytes;
  }
  return sharp(bytes).resize(maxPx, maxPx, { fit: "inside", withoutEnlargement: true }).toBuffer();
}

// ---------------------------------------------------------------------------
// 單張圖片嵌入
// ---------------------------------------------------------------------------

async function embedOne(
  storage: Storage,
  img: ReportImage,
  maxPx: number,
  log: EmbedImagesLogger
): Promise<ReportImage> {
  let bytes: Buffer;
  try {
    const raw = await storage.get(img.storageKey);
    bytes = Buffer.isBuffer(raw) ? raw : await streamToBuffer(raw);
  } catch {
    // B-10：來源檔遺失（DB 有列、檔案無）。日誌零 key（見檔頭）。
    log.error(
      { attachmentId: img.attachmentId },
      "Report image missing from storage despite DB record existing"
    );
    return { ...img, storageKey: "", dataUri: null, missing: true };
  }

  try {
    const embedded = await resizeForEmbed(bytes, maxPx);
    const mimeType: SupportedMimeType | string = img.mimeType;
    const dataUri = `data:${mimeType};base64,${embedded.toString("base64")}`;
    return { ...img, storageKey: "", dataUri, missing: false };
  } catch {
    // sharp 解碼/降尺寸失敗（例如位元組損毀）——沿 D5「sharp 失敗即非致命
    // fallback」先例，視為圖片無法使用，不中止整份報表。不含 storage key。
    log.error(
      { attachmentId: img.attachmentId },
      "Report image failed to process (sharp) despite bytes being readable"
    );
    return { ...img, storageKey: "", dataUri: null, missing: true };
  }
}

async function embedList(
  storage: Storage,
  images: ReportImage[],
  maxPx: number,
  log: EmbedImagesLogger
): Promise<ReportImage[]> {
  return Promise.all(images.map((img) => embedOne(storage, img, maxPx, log)));
}

// ---------------------------------------------------------------------------
// 入口（§9.1 步驟 (3)；回傳全新物件，見檔頭）
// ---------------------------------------------------------------------------

/**
 * 將 `ReportData` 內所有 `ReportImage` 之 `dataUri`／`missing` 填入（原樣讀
 * 出後之下一步；§9.1／§9.2 共用同一實作）。回傳全新物件，輸入不被修改。
 *
 * @param storage 讀取附件原始位元組之 storage 實例（`att` 前綴實例，AC-13
 *                之圖片來源恆為附件，非 `rpt` 報表檔）。
 * @param data    `buildReportData`（T4）之輸出。
 * @param maxPx   長邊上限像素（`REPORT_IMAGE_MAX_PX`，預設 1600；由呼叫端
 *                自 `config/env.ts` 讀入後傳入，本檔不讀環境變數，沿
 *                `produceThumbnail(bytes, mimeType, thumbnailMaxPx, log)`
 *                既有之「呼叫端傳參」慣例）。
 * @param log     錯誤日誌（不含 storage key，見檔頭）。
 */
export async function embedImages(
  storage: Storage,
  data: ReportData,
  maxPx: number,
  log: EmbedImagesLogger
): Promise<ReportData> {
  if (data.kind === "TRAVEL") {
    const segments = await Promise.all(
      data.travel.segments.map(async (segment) => ({
        ...segment,
        attachments: await embedList(storage, segment.attachments, maxPx, log),
      }))
    );
    const travel: TravelReportBody = { ...data.travel, segments };
    return { ...data, travel };
  }

  if (data.kind === "MAINTENANCE") {
    const attachments = await embedList(storage, data.maintenance.attachments, maxPx, log);
    const maintenance: MaintenanceReportBody = { ...data.maintenance, attachments };
    return { ...data, maintenance };
  }

  const attachments = await embedList(storage, data.depreciation.attachments, maxPx, log);
  const depreciation: DepreciationReportBody = { ...data.depreciation, attachments };
  return { ...data, depreciation };
}
