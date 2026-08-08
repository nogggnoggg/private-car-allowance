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
 * PHASE-005a-T7 複審 SF-4 必辦：wire 值域自 `"FUEL"|"ETC"` 改為下列六碼
 * （§16 D5(a)、§18 T8R 權威清單）。前三者為「查無版本」缺參數；後三者為
 * 版本齊備但無法計算（AC-20 單價超容量／T7R SF-1 資料毀損／AR-2 金額超容量）。
 * 與 backend `travel-parameters.ts`（`MissingParameter`）/`travel-service.ts`
 * （`PreviewMissingCode`）同形，本檔為前端獨立副本（無共用 package）。
 */
export type MissingParameterCode = "FUEL_PRICE" | "FUEL_CONSUMPTION" | "ETC";
export type PreviewMissingCode =
  | MissingParameterCode
  | "FUEL_UNIT_PRICE_OUT_OF_RANGE"
  | "FUEL_DATA_CORRUPTED"
  | "AMOUNT_OUT_OF_RANGE";

/**
 * D6(c): draft/preview `computed` deliberately has NO unit-price fields —
 * only the已完成 snapshot (`TravelSnapshotDto` below) carries them.
 */
export interface TravelComputedDto {
  parameterAvailable: boolean;
  missingParameters: PreviewMissingCode[];
  totalKm: string;
  segments: TravelComputedSegmentDto[];
  totalRawAmount: string;
  totalAmount: number;
}

/** D6(c): 已完成申請的快照 — the ONE place unit prices are exposed. */
export interface TravelSnapshotDto {
  fuelUnitPrice: string;
  etcUnitPrice: string;
  /**
   * PHASE-005a-T7 複審 SF-4：舊模型（`FuelParameterVersion`）引用；新模型
   * 完成之申請恆為 `null`（§8.4 判別欄位）。既有舊模型已完成申請仍回傳原值。
   */
  fuelParameterVersionId: string | null;
  etcParameterVersionId: string;
  /** 新模型（`FuelPriceVersion`）引用；舊模型申請為 `null`。 */
  fuelPriceVersionId: string | null;
  /** 新模型（`UserFuelConsumptionVersion`）引用；舊模型申請為 `null`。 */
  fuelConsumptionVersionId: string | null;
  totalKm: string;
  totalRawAmount: string;
  totalAmount: number;
  calculatedAt: string; // ISO
}

/**
 * 作廢資訊（PHASE-009 §7.2）——三型詳情 DTO 共用之新增鍵 `void` 之型別。
 * **未作廢恆為 `null`**，此即 AC-33 Empty 態「未作廢詳情頁零作廢資訊區塊」
 * 之呈現依據（詳情頁以 `application.void && (...)` 條件渲染）。
 *
 * 與後端 `backend/src/applications/application-void.ts` 之同名 interface
 * 同形（前端獨立副本，本 repo 無 backend/frontend 共用 package）。
 * `voidedByDisplayName` 於後端解析不到該使用者時為 `"—"`；`voidedById`
 * **恆不外露**（§8.3），故本型別刻意沒有該欄。
 */
export interface VoidInfoDto {
  reason: string;
  voidedAt: string; // ISO8601
  voidedByDisplayName: string;
  /**
   * PHASE-009-T15c（AC-41／Mock Gate 定案③）：作廢當時金額＝該申請**完成時
   * 保存**之最終整筆金額（新臺幣整數）。呈現面（詳情頁「作廢資訊」區塊末列，
   * 整數原樣、`null` → `—`）屬 T15d，本鍵僅為型別鏡像。
   */
  totalAmount: number | null;
}

/**
 * 版本關聯之最小投影（PHASE-009 §7.2；AC-12(b)(c)）——**雙向皆由後端單一
 * `supersedesId` 欄位推導**，前端不得自行拼湊第二條關聯來源。
 *
 * `supersededBy` 側為本三鍵；`supersedes` 側為 `SupersedesLinkDto`（四鍵，
 * 多 `reportNumber`）。此不對稱為 AC-12(b) 原文，非疏漏——修正版頁需以
 * 「原編號或原日期」標示來源（AC-32(c)），原申請頁只需指向修正版。
 *
 * 與後端 `backend/src/applications/routes.ts` 之同名 interface 同形（前端
 * 獨立副本，本 repo 無 backend/frontend 共用 package）。
 */
export interface RevisionLinkDto {
  id: string;
  status: ApplicationStatusDto;
  primaryDate: string; // YYYY-MM-DD
}

/** §7.2：`supersedes` 側之四鍵投影（原申請未產生報表時 `reportNumber` 為 null）。 */
export interface SupersedesLinkDto extends RevisionLinkDto {
  reportNumber: string | null;
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
  void: VoidInfoDto | null; // PHASE-009 §7.2：VOIDED 才非 null
  supersedes: SupersedesLinkDto | null; // 本筆為修正版時指向原申請
  supersededBy: RevisionLinkDto | null; // 本筆已有修正版時指向該修正版
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
  /**
   * PHASE-009 §7.2（T16pre 後端落地：`application-query.ts` 之
   * `toApplicationListItemDto`，`supersedesId != null`）。列表徽章用之**純顯示**
   * 旗標——列表刻意**不**外露 `supersedesId`（T16pre FW-2：徽章不需要跳轉能力，
   * 跳轉走詳情端點之 `supersedes` 投影），故本鍵為 boolean 而非 id。
   */
  isRevision: boolean;
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

// ---------------------------------------------------------------------------
// POST /applications/:id/void (PHASE-009 §7.3, AC-29)
//
// Body 恆為 `{ reason }`（其餘鍵後端一律忽略）。錯誤形狀由後端權威：
//   400 VALIDATION_ERROR + fields[{ field: "reason", reason }]
//   409 CONFLICT + details.status ∈ {"DRAFT","VOIDED"}
// 皆由 `parseApiResponse` 轉成 thrown `ApiError`，呈現責任在呼叫端
// （VoidApplicationDialog）。
//
// 回應之 `application` 為**型別分派**之詳情 DTO（差旅／保養／折舊三型之一），
// 故以型別參數表達而不寫死 `TravelApplicationDto`——三型詳情頁各自以自己的
// DTO 型別呼叫（T15）。此處刻意不做 trim：後端 `void-reason.ts` 為驗證與
// trim 的唯一事實來源（B-03），前端 trim 會讓兩處各有一份規則。
// ---------------------------------------------------------------------------

export async function apiVoidApplication<TApplication = unknown>(
  id: string,
  reason: string
): Promise<{ application: TApplication }> {
  const res = await fetch(`/api/applications/${id}/void`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ reason }),
  });
  return parseApiResponse<{ application: TApplication }>(res);
}

// ---------------------------------------------------------------------------
// POST /applications/:id/revision (PHASE-009 §7.3, AC-32)
//
// §7.3 逐字：「Body：無（一律忽略）」。因此本函式**不送 body、亦不宣告
// `Content-Type`**——沿 `apiCompleteApplication` 之 PHASE-004-R8 修復先例：
// 宣告 JSON 卻送空 body 會讓 Fastify 的預設 JSON parser 在 auth preHandler
// 之前丟 wire-level 錯誤，落入全域 error handler 的未知例外分支變成 500
// INTERNAL_ERROR（見 backend/test/integration/
// phase4-r8-wire-level-empty-json-body.test.ts）。沒有 body 就不該宣告 body
// 型別；不得改為送假 body 繞過。
//
// 錯誤形狀由後端權威（§7.5），皆由 `parseApiResponse` 轉成 thrown `ApiError`：
//   400 VALIDATION_ERROR（擁有人已停用；`fields[{ field:"userId" }]` —— 該
//       `field` 對不到本頁任何輸入欄，故呼叫端必須顯示 `message` 本身，不得
//       只做逐欄標紅而靜默吞錯，T7b 即審 AR-2）
//   409 CONFLICT + details.status ∈ {"DRAFT","VOIDED"}
//   409 CONFLICT + details.existingRevisionId（已有修正版）
//
// 回應之 `application` 為**型別分派**之新草稿詳情 DTO（§7.3 之 201），故以
// 型別參數表達而不寫死 `TravelApplicationDto`（沿 `apiVoidApplication` 形狀）。
// ---------------------------------------------------------------------------

export async function apiCreateRevision<TApplication = unknown>(
  id: string
): Promise<{ application: TApplication }> {
  const res = await fetch(`/api/applications/${id}/revision`, {
    method: "POST",
    credentials: "include",
  });
  return parseApiResponse<{ application: TApplication }>(res);
}
