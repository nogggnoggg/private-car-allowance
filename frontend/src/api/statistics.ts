/**
 * Mileage statistics (區間公務里程統計) API client — PHASE-005-T7
 *
 * Wraps `GET /statistics/mileage` (backend/src/mileage/routes.ts, T4/D4(a)).
 * Mirrors the existing frontend/src/api/{applications,parameters}.ts pattern:
 * relative `/api/...` URL (nginx / Vite dev proxy), `credentials: "include"`
 * for the session cookie, and `parseApiResponse` to turn non-2xx responses
 * into a thrown `ApiError`.
 *
 * D3(a)/D7(a) (Spec §7.2): response shape is a CLOSED whitelist —
 * `totalKm` (Decimal string, fixed 2 decimals, unrounded), `applicationCount`,
 * `appliedFilters.{dateFrom,dateTo,ownerId}`. No `segments`/`items`/amounts —
 * do not add fields here without a Spec change.
 *
 * AC-30 (CLAUDE.md「前端預覽僅供參考，後端不得採用前端提交的金額」；
 * PHASE-004 §11.3 慣例): callers must display `totalKm` verbatim from this
 * response — never derive it by summing `ApplicationListItemDto.totalKm`
 * from `apiListApplications` (frontend/src/api/applications.ts). This module
 * intentionally exposes no summing helper.
 */

import { parseApiResponse } from "../types/api.js";

// ---------------------------------------------------------------------------
// DTO shape (§7.2) — kept in sync with backend/src/mileage/routes.ts.
// ---------------------------------------------------------------------------

export interface MileageSummaryResponse {
  /** 公務總里程；Decimal 字串，固定 2 位小數，未取整（AC-11）。無資料為 "0.00"（AC-09）。 */
  totalKm: string;
  /** 納入統計之已完成差旅筆數（D7(a)）。 */
  applicationCount: number;
  /** 後端實際套用值（AC-18）。 */
  appliedFilters: {
    dateFrom: string; // YYYY-MM-DD
    dateTo: string; // YYYY-MM-DD
    ownerId: string;
  };
}

// ---------------------------------------------------------------------------
// GET /statistics/mileage (§7.1)
// ---------------------------------------------------------------------------

export interface MileageSummaryQuery {
  /** D5(a)：起訖皆必填——本 client 不套用任何預設值。 */
  dateFrom: string;
  dateTo: string;
  /** 一般使用者省略即為自己；管理員可指定被檢視使用者（AC-24）。 */
  ownerId?: string;
}

function buildQueryString(query: MileageSummaryQuery): string {
  const params = new URLSearchParams();
  params.set("dateFrom", query.dateFrom);
  params.set("dateTo", query.dateTo);
  if (query.ownerId) params.set("ownerId", query.ownerId);
  return `?${params.toString()}`;
}

export async function apiGetMileageSummary(
  query: MileageSummaryQuery
): Promise<MileageSummaryResponse> {
  const res = await fetch(`/api/statistics/mileage${buildQueryString(query)}`, {
    credentials: "include",
  });
  return parseApiResponse<MileageSummaryResponse>(res);
}
