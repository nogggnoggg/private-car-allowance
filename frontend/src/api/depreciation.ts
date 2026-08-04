/**
 * Depreciation (年度折舊補貼) applications API client — PHASE-007-T13
 *
 * Mirrors `frontend/src/api/maintenance.ts`'s existing pattern for the
 * MAINTENANCE vertical (relative `/api/...` URLs, `credentials: "include"`,
 * `parseApiResponse` for typed errors). Frontend-owned DTO copies kept in
 * sync with `backend/src/applications/depreciation-service.ts`'s
 * `DepreciationApplicationDto`/`DepreciationComputedDto`/
 * `DepreciationSnapshotDto`（Spec §7.2）— no shared package between
 * backend/frontend in this repo, same as the MAINTENANCE/TRAVEL types above.
 *
 * §16 D8／AC-39（三推導值不外露）: `DepreciationComputedDto` 與
 * `DepreciationSnapshotDto` 皆不含 `vehiclePrice`／`usefulLifeYears`／
 * `estimatedAnnualKm`／`depreciationParameterVersionId`——本檔逐欄核對
 * 後端 §7.2 之 DTO 形狀，刻意不宣告這些欄位（避免前端誤以為可用）。
 *
 * AC-39（後端權威／前端零自算）: none of the request bodies below ever
 * carry a computed value (`officialKm`/`perKmUnitPrice`/`rawAmount`/
 * `amount`) — every displayed number in `DepreciationApplicationPage` comes
 * straight from a response body defined here, never computed client-side。
 *
 * FW-5／B-02（T4 三裁定②）：`applicationYear` 於 wire 上僅收 JSON
 * number（或 `null`）——呼叫端（`DepreciationApplicationPage`）負責把
 * `<input type="number">` 的字串值轉為 `number` 才送出，**不得**以字串傳輸
 * （與其餘 Decimal 欄位之字串慣例不同，因 `applicationYear` 為 `Int`）。
 */

import { parseApiResponse } from "../types/api.js";
import type { ApplicationStatusDto, BlockerDto } from "./applications.js";
import type { AttachmentDto } from "./attachments.js";

// ---------------------------------------------------------------------------
// DTO shapes (§7.2) — kept in sync with backend/src/applications/depreciation-service.ts
// ---------------------------------------------------------------------------

export interface DepreciationComputedDto {
  calculable: boolean;
  officialKm: string | null; // 2 位小數，未取整（sumOfficialMileage.totalKm）
  officialApplicationCount: number | null; // 僅供顯示（AC-13），不得參與任何計算
  perKmUnitPrice: string | null; // 4 位小數（deriveDepreciation 之回傳，逐字）
  rawAmount: string | null; // 4 位小數，取整前
  amount: number | null; // 新臺幣整數，取整後
  blockingCodes: string[]; // 不可計算之原因代碼（§7.5）
}

export interface DepreciationSnapshotDto {
  officialKm: string; // 2 位小數
  perKmUnitPrice: string; // 4 位小數
  rawAmount: string; // 4 位小數，取整前
  totalAmount: number; // 整數（＝ Application.totalAmount）
  calculatedAt: string; // ISO8601
}

export interface DepreciationApplicationDto {
  id: string;
  type: "DEPRECIATION";
  status: ApplicationStatusDto;
  ownerId: string;
  ownerDisplayName: string;
  createdById: string;
  onBehalf: boolean;
  primaryDate: string; // YYYY-MM-DD
  createdAt: string; // ISO8601
  updatedAt: string; // ISO8601

  applicationYear: number | null; // 申請年度（西元年整數）

  duplicateYearNotice: { count: number; hasCompleted: boolean } | null; // AC-07

  attachments: AttachmentDto[];
  completionBlockers: BlockerDto[] | null; // DRAFT 才有；COMPLETED 為 null
  computed: DepreciationComputedDto | null; // DRAFT 才有
  snapshot: DepreciationSnapshotDto | null; // COMPLETED 才有
}

// ---------------------------------------------------------------------------
// POST /applications/depreciation (AC-02) — body 全選填
// ---------------------------------------------------------------------------

export interface DepreciationDraftFields {
  applicationYear?: number | null; // JSON number｜null（FW-5／B-02：不得傳字串）
}

export async function apiCreateDepreciationDraft(
  body: DepreciationDraftFields = {}
): Promise<{ application: DepreciationApplicationDto }> {
  const res = await fetch("/api/applications/depreciation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return parseApiResponse<{ application: DepreciationApplicationDto }>(res);
}

// ---------------------------------------------------------------------------
// GET /applications/depreciation/:id (AC-05)
// ---------------------------------------------------------------------------

export async function apiGetDepreciationDraft(
  id: string
): Promise<{ application: DepreciationApplicationDto }> {
  const res = await fetch(`/api/applications/depreciation/${id}`, { credentials: "include" });
  return parseApiResponse<{ application: DepreciationApplicationDto }>(res);
}

// ---------------------------------------------------------------------------
// PUT /applications/depreciation/:id — 三態語意（key 缺席=不變；含 null=清空）
// ---------------------------------------------------------------------------

export interface DepreciationUpdateFields extends DepreciationDraftFields {
  /**
   * PHASE-007-T14：宣告式全集（比照保養／差旅既有慣例）。
   * `DepreciationApplicationPage` 之 `buildSaveRequestBody` 於送出前以
   * `Set` 去重（B-22／T8 即審 FW-11 裁定 A）。
   */
  attachmentIds?: string[];
}

export async function apiUpdateDepreciationDraft(
  id: string,
  body: DepreciationUpdateFields
): Promise<{ application: DepreciationApplicationDto }> {
  const res = await fetch(`/api/applications/depreciation/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return parseApiResponse<{ application: DepreciationApplicationDto }>(res);
}

// ---------------------------------------------------------------------------
// POST /applications/depreciation/preview (§9.2) — stateless, debounce
// 300ms on the CALLER side (see DepreciationApplicationPage.tsx).
// ---------------------------------------------------------------------------

export async function apiPreviewDepreciation(
  body: DepreciationDraftFields
): Promise<{ preview: DepreciationComputedDto }> {
  const res = await fetch("/api/applications/depreciation/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return parseApiResponse<{ preview: DepreciationComputedDto }>(res);
}

// ---------------------------------------------------------------------------
// POST /applications/:id/complete (§9.3, AC-27~30) — existing generic
// type-dispatching endpoint (see applications.ts's `apiCompleteApplication`
// for the TRAVEL-typed equivalent, maintenance.ts's
// `apiCompleteMaintenanceApplication` for the MAINTENANCE-typed copy); this
// is the DEPRECIATION-typed copy so callers get a correctly-typed
// `DepreciationApplicationDto` back instead of casting. 不送 body（同
// travel/maintenance 版本理由：AC-54 之既有 wire-level 教訓）。
// ---------------------------------------------------------------------------

export async function apiCompleteDepreciationApplication(
  id: string
): Promise<{ application: DepreciationApplicationDto }> {
  const res = await fetch(`/api/applications/${id}/complete`, {
    method: "POST",
    credentials: "include",
  });
  return parseApiResponse<{ application: DepreciationApplicationDto }>(res);
}
