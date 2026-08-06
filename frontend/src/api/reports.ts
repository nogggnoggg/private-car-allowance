/**
 * Reports (正式報表) API client — PHASE-008-T12
 *
 * Wraps the two report endpoints needed by the frontend (§7.1)：
 *   - `GET  /applications/:id/report`  — 查詢報表資訊（§3.4；尚未產生為
 *     `{ report: null }`，非 404）
 *   - `POST /applications/:id/report`  — 產生正式報表（§3.1；冪等，body 一律
 *     忽略——同 `apiCompleteApplication` 慣例，不宣告 Content-Type，避免空
 *     JSON body 的 wire-level 錯誤，見 api/applications.ts 同型註解）
 *
 * `printUrl`／`downloadUrl` 兩端點（列印版 HTML／下載 PDF）不在本檔提供 fetch
 * 包裝——依 AC-32 設計為 `<a>` 導覽（列印版 `target="_blank"`；下載為一般
 * 導覽觸發瀏覽器下載），而非 fetch 呼叫，故僅需 `toFrontendUrl()`
 * （沿用 api/attachments.ts 既有慣例）將 DTO 的後端相對路徑轉為前端可用 URL。
 */

import { parseApiResponse } from "../types/api.js";

/** §7.2 — 鍵集封閉為此六鍵（AC-27，後端負責）。 */
export interface ReportDto {
  reportNumber: string;
  generatedAt: string; // ISO8601（前端逐字顯示，不重新格式化，AC-30）
  fileName: string;
  byteSize: number;
  downloadUrl: string; // 後端相對路徑，需經 toFrontendUrl() 加 /api 前綴
  printUrl: string; // 後端相對路徑，需經 toFrontendUrl() 加 /api 前綴
}

/** GET /api/applications/:id/report（§3.4） */
export async function apiGetReport(applicationId: string): Promise<{ report: ReportDto | null }> {
  const res = await fetch(`/api/applications/${applicationId}/report`, {
    credentials: "include",
  });
  return parseApiResponse<{ report: ReportDto | null }>(res);
}

/** POST /api/applications/:id/report（§3.1；冪等，body 一律忽略） */
export async function apiGenerateReport(applicationId: string): Promise<{ report: ReportDto }> {
  const res = await fetch(`/api/applications/${applicationId}/report`, {
    method: "POST",
    credentials: "include",
  });
  return parseApiResponse<{ report: ReportDto }>(res);
}
