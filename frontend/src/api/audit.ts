/**
 * Audit log (稽核查詢) API client — PHASE-010-T6
 *
 * Wraps the single audit endpoint（§7.1）：
 *   - `GET /admin/audit-logs` — 稽核事件列表（分頁 ＋ 篩選，管理員 only）
 *
 * `credentials: "include"` 沿既有慣例（見 `api/reports.ts`／`api/applications.ts`）；
 * 純 GET、無 body，故不宣告 `Content-Type`（同型理由見
 * `frontend/test/api-no-body-mutations.test.ts` 之檔頭說明）。
 *
 * 查詢參數形狀依 §7.3——四個篩選維度與 `page`／`pageSize` 皆為 optional；
 * 本函式僅負責組出 query string，**不**做參數驗證（後端為權威來源，
 * 400 由 `parseApiResponse` 之既有錯誤路徑承接）。篩選／分頁 UI 屬 T7 範圍，
 * 本檔僅提供 client 函式。
 */

import type { AuditAction, AuditLogListResponse } from "../types/api.js";
import { parseApiResponse } from "../types/api.js";

/** §7.3 — `GET /admin/audit-logs` 之查詢參數（皆 optional）。 */
export interface AuditLogQueryParams {
  action?: AuditAction;
  actorId?: string;
  targetId?: string;
  dateFrom?: string; // YYYY-MM-DD，含當日
  dateTo?: string; // YYYY-MM-DD，含當日
  page?: number;
  pageSize?: number;
}

/** GET /api/admin/audit-logs（§7.1／§7.3） */
export async function apiListAuditLogs(
  params: AuditLogQueryParams = {}
): Promise<AuditLogListResponse> {
  const search = new URLSearchParams();
  if (params.action !== undefined) search.set("action", params.action);
  if (params.actorId !== undefined) search.set("actorId", params.actorId);
  if (params.targetId !== undefined) search.set("targetId", params.targetId);
  if (params.dateFrom !== undefined) search.set("dateFrom", params.dateFrom);
  if (params.dateTo !== undefined) search.set("dateTo", params.dateTo);
  if (params.page !== undefined) search.set("page", String(params.page));
  if (params.pageSize !== undefined) search.set("pageSize", String(params.pageSize));

  const qs = search.toString();
  const res = await fetch(`/api/admin/audit-logs${qs ? `?${qs}` : ""}`, {
    credentials: "include",
  });
  return parseApiResponse<AuditLogListResponse>(res);
}
