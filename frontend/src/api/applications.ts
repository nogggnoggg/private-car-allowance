/**
 * Applications (差旅) API client — PHASE-004-T13
 *
 * Wraps the travel application endpoints (§8.2). Mirrors the existing
 * frontend/src/api/{parameters,attachments}.ts pattern: relative `/api/...`
 * URLs (nginx / Vite dev proxy), `credentials: "include"` for the session
 * cookie, and `parseApiResponse` to turn non-2xx responses into a thrown
 * `ApiError`.
 *
 * D6 (Spec §17.1)：`TravelComputedDto`（草稿/預覽）型別上刻意 **不** 宣告
 * `fuelUnitPrice`/`etcUnitPrice`/`fuelParameterVersionId`/`etcParameterVersionId`
 * — those only exist on `TravelSnapshotDto` (已完成申請). Do not add them
 * here; the backend DTO does not return them for computed/preview responses
 * either (see backend/src/applications/travel-service.ts §8.1 doc comment).
 *
 * AC-35/54（後端權威）: none of the request bodies below ever carry an
 * amount field (`totalAmount`/`amount`/`fuelAmount`/…) — the backend ignores
 * any such field even if sent, so there is nothing to compute or send from
 * the frontend. All displayed amounts come from the response bodies here.
 */

import { parseApiResponse } from "../types/api.js";
import type { AttachmentDto } from "./attachments.js";

// ---------------------------------------------------------------------------
// DTO shapes (§8.1) — kept in sync with backend/src/applications/travel-service.ts
// and application-query.ts. Frontend-owned copies (no shared package between
// backend/frontend in this repo), same pattern as types/api.ts's parameter DTOs.
// ---------------------------------------------------------------------------

export type ApplicationStatusDto = "DRAFT" | "COMPLETED" | "VOIDED";
export type ApplicationTypeDto = "TRAVEL" | "MAINTENANCE" | "DEPRECIATION";

export interface BlockerDto {
  code: string;
  field?: string;
  segmentId?: string;
  segmentIndex?: number;
  message: string; // zh-TW
}

export interface TripSegmentDto {
  id: string;
  sortOrder: number;
  origin: string | null;
  destination: string | null;
  totalKm: string | null; // Decimal 字串，2 位小數
  highwayKm: string | null;
  attachments: AttachmentDto[];
  snapshot: {
    fuelAmount: string;
    etcAmount: string;
    rawAmount: string;
    amount: number;
  } | null; // 僅 COMPLETED
}

export interface TravelComputedSegmentDto {
  segmentId: string | null;
  segmentIndex: number;
  fuelAmount: string; // 取整前
  etcAmount: string; // 取整前
  rawAmount: string; // 取整前（油資+ETC）
  amount: number; // 取整後（整數）
}

/**
 * D6(c): draft/preview `computed` deliberately has NO unit-price fields —
 * only the已完成 snapshot (`TravelSnapshotDto` below) carries them.
 */
export interface TravelComputedDto {
  parameterAvailable: boolean;
  missingParameters: ("FUEL" | "ETC")[];
  totalKm: string;
  segments: TravelComputedSegmentDto[];
  totalRawAmount: string;
  totalAmount: number;
}

/** D6(c): 已完成申請的快照 — the ONE place unit prices are exposed. */
export interface TravelSnapshotDto {
  fuelUnitPrice: string;
  etcUnitPrice: string;
  fuelParameterVersionId: string;
  etcParameterVersionId: string;
  totalKm: string;
  totalRawAmount: string;
  totalAmount: number;
  calculatedAt: string; // ISO
}

export interface TravelApplicationDto {
  id: string;
  type: "TRAVEL";
  status: ApplicationStatusDto;
  ownerId: string;
  ownerDisplayName: string;
  createdById: string;
  createdByDisplayName: string;
  onBehalf: boolean;
  tripDate: string | null; // YYYY-MM-DD
  purpose: string | null;
  segments: TripSegmentDto[];
  completionBlockers: BlockerDto[]; // DRAFT 有值；COMPLETED 為 []
  computed: TravelComputedDto | null; // DRAFT：即算預覽；COMPLETED：null
  snapshot: TravelSnapshotDto | null; // COMPLETED：快照；DRAFT：null
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ApplicationListItemDto {
  id: string;
  type: ApplicationTypeDto;
  status: ApplicationStatusDto;
  primaryDate: string; // YYYY-MM-DD
  tripDate: string | null;
  title: string | null;
  totalKm: string | null;
  totalAmount: number | null;
  segmentCount: number | null;
  ownerId: string;
  ownerDisplayName: string;
  onBehalf: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationListResponse {
  items: ApplicationListItemDto[];
  page: number;
  pageSize: number;
  total: number;
  appliedFilters: {
    dateFrom: string | null;
    dateTo: string | null;
    type: ApplicationTypeDto | null;
    status: ApplicationStatusDto | null;
    keyword: string | null;
    ownerId: string;
  };
}

/** §8.2 `SegmentInput` — used in `PUT /applications/travel/:id` body. */
export interface SegmentInput {
  id?: string; // 有 id → 更新既有段；無 id → 新增
  origin?: string | null;
  destination?: string | null;
  totalKm?: string | number | null;
  highwayKm?: string | number | null;
  attachmentIds: string[]; // 該段之附件（最多 3；後端據此 link/detach）
}

// ---------------------------------------------------------------------------
// GET /applications (§8.1 ApplicationListResponse, §8.2)
// ---------------------------------------------------------------------------

export interface ApplicationListQuery {
  dateFrom?: string;
  dateTo?: string;
  type?: ApplicationTypeDto;
  status?: ApplicationStatusDto;
  keyword?: string;
  page?: number;
  pageSize?: number;
  ownerId?: string;
}

function buildListQueryString(query: ApplicationListQuery): string {
  const params = new URLSearchParams();
  if (query.dateFrom) params.set("dateFrom", query.dateFrom);
  if (query.dateTo) params.set("dateTo", query.dateTo);
  if (query.type) params.set("type", query.type);
  if (query.status) params.set("status", query.status);
  if (query.keyword) params.set("keyword", query.keyword);
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  if (query.ownerId) params.set("ownerId", query.ownerId);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function apiListApplications(
  query: ApplicationListQuery = {}
): Promise<ApplicationListResponse> {
  const res = await fetch(`/api/applications${buildListQueryString(query)}`, {
    credentials: "include",
  });
  return parseApiResponse<ApplicationListResponse>(res);
}

// ---------------------------------------------------------------------------
// POST /applications/travel (§8.2 AC-01)
// ---------------------------------------------------------------------------

export interface CreateTravelDraftRequest {
  tripDate?: string | null;
  purpose?: string | null;
}

export async function apiCreateTravelDraft(
  body: CreateTravelDraftRequest = {}
): Promise<{ application: TravelApplicationDto }> {
  const res = await fetch("/api/applications/travel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return parseApiResponse<{ application: TravelApplicationDto }>(res);
}

// ---------------------------------------------------------------------------
// POST /admin/users/:userId/applications/travel (§8.2, T10) — 管理員代建立
// 差旅草稿（AC-78/79/85）. Body shape identical to `POST /applications/travel`
// (see `apiCreateTravelDraft` above) — the ONLY difference is the URL, which
// carries `:userId` (the被代理使用者); the backend sets `ownerId=:userId`,
// `createdById=` the calling admin (T14 Packet C1: authorization is decided
// server-side by `requireAdmin` — this client function does not, and cannot,
// enforce anything; it merely calls the endpoint T10 already authorizes).
// ---------------------------------------------------------------------------

export async function apiCreateTravelDraftOnBehalf(
  userId: string,
  body: CreateTravelDraftRequest = {}
): Promise<{ application: TravelApplicationDto }> {
  const res = await fetch(`/api/admin/users/${userId}/applications/travel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return parseApiResponse<{ application: TravelApplicationDto }>(res);
}

// ---------------------------------------------------------------------------
// GET /applications/travel/:id (§8.2 AC-04)
// ---------------------------------------------------------------------------

export async function apiGetTravelDraft(
  id: string
): Promise<{ application: TravelApplicationDto }> {
  const res = await fetch(`/api/applications/travel/${id}`, { credentials: "include" });
  return parseApiResponse<{ application: TravelApplicationDto }>(res);
}

// ---------------------------------------------------------------------------
// PUT /applications/travel/:id — 整份替換（D15）
// ---------------------------------------------------------------------------

export interface UpdateTravelDraftRequest {
  tripDate?: string | null;
  purpose?: string | null;
  segments: SegmentInput[];
}

export async function apiUpdateTravelDraft(
  id: string,
  body: UpdateTravelDraftRequest
): Promise<{ application: TravelApplicationDto }> {
  const res = await fetch(`/api/applications/travel/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return parseApiResponse<{ application: TravelApplicationDto }>(res);
}

// ---------------------------------------------------------------------------
// DELETE /applications/:id (AC-05/06)
// ---------------------------------------------------------------------------

export async function apiDeleteApplication(id: string): Promise<void> {
  const res = await fetch(`/api/applications/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  await parseApiResponse<{ ok: boolean }>(res);
}

// ---------------------------------------------------------------------------
// POST /applications/travel/preview (D8, AC-31~36) — stateless, debounce 300ms
// on the CALLER side (see TravelApplicationPage.tsx).
// ---------------------------------------------------------------------------

export interface PreviewTravelSegmentInput {
  totalKm?: string | number | null;
  highwayKm?: string | number | null;
}

export interface PreviewTravelRequest {
  tripDate?: string | null;
  segments: PreviewTravelSegmentInput[];
}

export async function apiPreviewTravel(
  body: PreviewTravelRequest
): Promise<{ preview: TravelComputedDto }> {
  const res = await fetch("/api/applications/travel/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return parseApiResponse<{ preview: TravelComputedDto }>(res);
}

// ---------------------------------------------------------------------------
// POST /applications/:id/complete (AC-49~54) — body 一律忽略，故本函式不接受
// 任何參數（避免呼叫端誤以為送出的欄位有作用，§9「完成申請」body 一律忽略）。
//
// PHASE-004-R8 修復：本函式不送 body，因此**不得**宣告
// `Content-Type: application/json`——Fastify 的預設 JSON body parser 對
// 「宣告 JSON 但空 body」的請求會丟出 wire-level 錯誤（早於 auth
// preHandler），落入全域 error handler 的未知例外分支變成 500
// INTERNAL_ERROR（見 backend/test/integration/
// phase4-r8-wire-level-empty-json-body.test.ts 的重現與回歸防線）。沒有
// body 就不該宣告 body 型別；不得改為送假 body 繞過（那與 AC-54「body 一律
// 忽略」的語意衝突，且會讓下一個讀 body 的人誤解本端點吃 body）。
// ---------------------------------------------------------------------------

export async function apiCompleteApplication(
  id: string
): Promise<{ application: TravelApplicationDto }> {
  const res = await fetch(`/api/applications/${id}/complete`, {
    method: "POST",
    credentials: "include",
  });
  return parseApiResponse<{ application: TravelApplicationDto }>(res);
}
