/**
 * Maintenance (保養) applications API client — PHASE-006-T11
 *
 * Mirrors `frontend/src/api/applications.ts`'s existing pattern for the
 * TRAVEL vertical (relative `/api/...` URLs, `credentials: "include"`,
 * `parseApiResponse` for typed errors). Frontend-owned DTO copies kept in
 * sync with `backend/src/applications/maintenance-service.ts`'s
 * `MaintenanceApplicationDto`/`MaintenanceComputedDto`/`MaintenanceSnapshotDto`
 * (§7.2) — no shared package between backend/frontend in this repo, same as
 * the TRAVEL types above.
 *
 * AC-35/AC-20（後端權威）: none of the request bodies below ever carry a
 * computed value (`intervalKm`/`officialKm`/`ratio`/`ratioPercent`/
 * `rawAmount`/`amount`) — every displayed number in `MaintenanceApplicationPage`
 * comes straight from a response body defined here, never computed
 * client-side (§11.3 不自算鑑別).
 */

import { parseApiResponse } from "../types/api.js";
import type { ApplicationStatusDto, BlockerDto } from "./applications.js";
import type { AttachmentDto } from "./attachments.js";

// ---------------------------------------------------------------------------
// DTO shapes (§7.2) — kept in sync with backend/src/applications/maintenance-service.ts
// ---------------------------------------------------------------------------

export interface MaintenanceComputedDto {
  calculable: boolean;
  intervalKm: string | null; // 2 位小數，未取整
  officialKm: string | null; // 2 位小數，未取整
  officialApplicationCount: number | null; // 僅供顯示（AC-15(b)），不得參與任何計算
  ratio: string | null; // 6 位小數（比值）
  ratioPercent: string | null; // 4 位小數（百分比）
  rawAmount: string | null; // 4 位小數，取整前
  amount: number | null; // 新臺幣整數，取整後
  blockingCodes: string[]; // 不可計算之原因代碼（§7.4）
}

export interface MaintenanceSnapshotDto {
  intervalKm: string; // 2 位小數
  officialKm: string; // 2 位小數
  ratio: string; // 6 位小數
  ratioPercent: string; // 4 位小數
  actualCost: string; // 2 位小數（＝完成當時之欄位值）
  rawAmount: string; // 4 位小數，取整前
  totalAmount: number; // 整數（＝ Application.totalAmount）
  calculatedAt: string; // ISO8601
}

export interface MaintenanceApplicationDto {
  id: string;
  type: "MAINTENANCE";
  status: ApplicationStatusDto;
  ownerId: string;
  ownerDisplayName: string;
  createdById: string;
  onBehalf: boolean;
  primaryDate: string; // YYYY-MM-DD
  createdAt: string; // ISO8601
  updatedAt: string; // ISO8601

  lastMaintenanceDate: string | null; // YYYY-MM-DD
  currentMaintenanceDate: string | null;
  lastOdometerKm: string | null; // Decimal 字串，2 位小數
  currentOdometerKm: string | null;
  actualCost: string | null;

  attachments: AttachmentDto[];
  completionBlockers: BlockerDto[] | null; // DRAFT 才有；COMPLETED 為 null
  computed: MaintenanceComputedDto | null; // DRAFT 且五欄齊備才有；否則 null
  snapshot: MaintenanceSnapshotDto | null; // COMPLETED 才有
}

// ---------------------------------------------------------------------------
// POST /applications/maintenance (AC-02) — body 全選填
// ---------------------------------------------------------------------------

export interface MaintenanceDraftFields {
  lastMaintenanceDate?: string | null; // YYYY-MM-DD
  currentMaintenanceDate?: string | null;
  lastOdometerKm?: string | null;
  currentOdometerKm?: string | null;
  actualCost?: string | null;
  /**
   * PHASE-006-T12：宣告式全集（比照 travel `SegmentInput.attachmentIds`）——
   * 呼叫方須送出「這筆申請目前應關聯的完整附件 id 清單」，後端據此對帳
   * link/unlink（`reconcileMaintenanceAttachments`，T6）。呼叫方須先去重
   * （AR-3：重複 id 會撞上後端「附件已關聯」409，屬前端可預防之誤導訊息）。
   */
  attachmentIds?: string[];
}

export async function apiCreateMaintenanceDraft(
  body: MaintenanceDraftFields = {}
): Promise<{ application: MaintenanceApplicationDto }> {
  const res = await fetch("/api/applications/maintenance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return parseApiResponse<{ application: MaintenanceApplicationDto }>(res);
}

// ---------------------------------------------------------------------------
// GET /applications/maintenance/:id (AC-05, B-34)
// ---------------------------------------------------------------------------

export async function apiGetMaintenanceDraft(
  id: string
): Promise<{ application: MaintenanceApplicationDto }> {
  const res = await fetch(`/api/applications/maintenance/${id}`, { credentials: "include" });
  return parseApiResponse<{ application: MaintenanceApplicationDto }>(res);
}

// ---------------------------------------------------------------------------
// PUT /applications/maintenance/:id — 三態語意（§8.2；key 缺席=不變）
// ---------------------------------------------------------------------------

export async function apiUpdateMaintenanceDraft(
  id: string,
  body: MaintenanceDraftFields
): Promise<{ application: MaintenanceApplicationDto }> {
  const res = await fetch(`/api/applications/maintenance/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return parseApiResponse<{ application: MaintenanceApplicationDto }>(res);
}

// ---------------------------------------------------------------------------
// POST /applications/maintenance/preview (D8/D6(a)) — stateless, debounce
// 300ms on the CALLER side (see MaintenanceApplicationPage.tsx).
// ---------------------------------------------------------------------------

export async function apiPreviewMaintenance(
  body: MaintenanceDraftFields
): Promise<{ preview: MaintenanceComputedDto }> {
  const res = await fetch("/api/applications/maintenance/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return parseApiResponse<{ preview: MaintenanceComputedDto }>(res);
}

// ---------------------------------------------------------------------------
// POST /applications/:id/complete (§9.3, AC-25~27) — existing generic
// type-dispatching endpoint (see applications.ts's `apiCompleteApplication`
// for the TRAVEL-typed equivalent); this is the MAINTENANCE-typed copy so
// callers get a correctly-typed `MaintenanceApplicationDto` back instead of
// casting. 不送 body（同 travel 版本理由：AC-54 之既有 wire-level 教訓，
// 見 applications.ts 文件註解）。
// ---------------------------------------------------------------------------

export async function apiCompleteMaintenanceApplication(
  id: string
): Promise<{ application: MaintenanceApplicationDto }> {
  const res = await fetch(`/api/applications/${id}/complete`, {
    method: "POST",
    credentials: "include",
  });
  return parseApiResponse<{ application: MaintenanceApplicationDto }>(res);
}
