/**
 * Depreciation (年度折舊補貼) applications API client — PHASE-007-T13／R9
 *
 * Mirrors `frontend/src/api/maintenance.ts`'s existing pattern for the
 * MAINTENANCE vertical (relative `/api/...` URLs, `credentials: "include"`,
 * `parseApiResponse` for typed errors). Frontend-owned DTO copies kept in
 * sync with `backend/src/applications/depreciation-service.ts`'s
 * `DepreciationApplicationDto`/`DepreciationComputedDto`/
 * `DepreciationSnapshotDto`（Spec §20.6，取代 §7.2）— no shared package
 * between backend/frontend in this repo, same as the MAINTENANCE/TRAVEL
 * types above.
 *
 * PHASE-007-R9（折舊模型修訂段，§20.6 逐字讀後端源）: DTO 形狀改造——
 *   ✗ 移除 `perKmUnitPrice`（`DepreciationComputedDto`；每公里單價退出申請
 *     計算，裁定①）
 *   ★ 新增 `annualDepreciation`（每年折舊費用，2dp）、`annualTotalKm`
 *     （年度總里程，1dp，`DepreciationComputedDto`／`DepreciationApplicationDto`
 *     皆新增）、`ratio`（6dp，顯示用）、`ratioPercent`（4dp，顯示用）
 *   `DepreciationSnapshotDto` 同步改造為 §20.6 之 9 欄形狀，並新增 `model`
 *   （`"CURRENT"|"LEGACY"`，AC-56 判別結果；`perKmUnitPrice` 僅 `LEGACY`
 *   列非 `null`，本頁刻意不渲染——AC-59(c) 負向斷言）。
 *
 * §20.10（三推導值不外露，取代 §6.3／§16 D8）: `DepreciationComputedDto` 與
 * `DepreciationSnapshotDto` 皆不含 `vehiclePrice`／`usefulLifeYears`／
 * `estimatedAnnualKm`／`depreciationParameterVersionId`——本檔逐欄核對
 * 後端 §20.6 之 DTO 形狀，刻意不宣告這些欄位（避免前端誤以為可用）。
 *
 * AC-59(b)（後端權威／前端零自算）: none of the request bodies below ever
 * carry a computed value (`officialKm`/`annualDepreciation`/`ratio`/
 * `ratioPercent`/`rawAmount`/`amount`) — every displayed number in
 * `DepreciationApplicationPage` comes straight from a response body defined
 * here, never computed client-side。
 *
 * FW-5／B-02（T4 三裁定②）：`applicationYear` 於 wire 上僅收 JSON
 * number（或 `null`）——呼叫端（`DepreciationApplicationPage`）負責把
 * `<input type="number">` 的字串值轉為 `number` 才送出，**不得**以字串傳輸
 * （與其餘 Decimal 欄位之字串慣例不同，因 `applicationYear` 為 `Int`）。
 *
 * PHASE-007-R9（T13 慣例延續）：`annualTotalKm`（新欄）於 wire 上亦以 JSON
 * number（或 `null`）送出（1dp；後端 `parseAnnualTotalKmField` 同時接受
 * `string`／`number`，本頁選擇與 `applicationYear` 一致之 number wire，
 * 呼叫端於送出前以 `Number()` 轉換空字串以外之輸入）。
 */

import { parseApiResponse } from "../types/api.js";
import type {
  ApplicationStatusDto,
  BlockerDto,
  RevisionLinkDto,
  SupersedesLinkDto,
  VoidInfoDto,
} from "./applications.js";
import type { AttachmentDto } from "./attachments.js";

// ---------------------------------------------------------------------------
// DTO shapes (§7.2) — kept in sync with backend/src/applications/depreciation-service.ts
// ---------------------------------------------------------------------------

export interface DepreciationComputedDto {
  calculable: boolean;
  annualDepreciation: string | null; // ★ 每年折舊費用，2 位小數；無可用參數／推導失敗時 null
  officialKm: string | null; // 2 位小數，未取整（sumOfficialMileage.totalKm）
  officialApplicationCount: number | null; // 僅供顯示（AC-13），不得參與任何計算
  annualTotalKm: string | null; // ★ 年度總里程，1 位小數；申請資料原樣回傳，未輸入時 null
  ratio: string | null; // ★ 公務比例，6 位小數（顯示用）
  ratioPercent: string | null; // ★ 公務比例百分比，4 位小數（顯示用）
  rawAmount: string | null; // 4 位小數，取整前
  amount: number | null; // 新臺幣整數，取整後
  blockingCodes: string[]; // 不可計算之原因代碼（§20.5.1，六碼）
}

export interface DepreciationSnapshotDto {
  model: "CURRENT" | "LEGACY"; // ★ AC-56 判別結果
  // ── 新模型欄（LEGACY 列為 null）──
  annualDepreciation: string | null; // 2 位小數
  annualTotalKm: string | null; // 1 位小數
  ratio: string | null; // 6 位小數
  ratioPercent: string | null; // 4 位小數
  // ── 舊模型欄（CURRENT 列為 null）── AC-59(c)：本頁刻意不渲染此欄。
  perKmUnitPrice: string | null; // 4 位小數
  // ── 兩模型共有 ──
  officialKm: string; // 2 位小數
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
  annualTotalKm: string | null; // ★ 年度總里程（1 位小數字串；使用者申報之申請資料，AC-48(a)）

  duplicateYearNotice: { count: number; hasCompleted: boolean } | null; // AC-07

  attachments: AttachmentDto[];
  completionBlockers: BlockerDto[] | null; // DRAFT 才有；COMPLETED 為 null
  computed: DepreciationComputedDto | null; // DRAFT 才有
  snapshot: DepreciationSnapshotDto | null; // COMPLETED 才有
  void: VoidInfoDto | null; // PHASE-009 §7.2：VOIDED 才非 null
  supersedes: SupersedesLinkDto | null; // 本筆為修正版時指向原申請（四鍵）
  supersededBy: RevisionLinkDto | null; // 本筆已有修正版時指向該修正版（三鍵）
}

// ---------------------------------------------------------------------------
// POST /applications/depreciation (AC-02) — body 全選填
// ---------------------------------------------------------------------------

export interface DepreciationDraftFields {
  applicationYear?: number | null; // JSON number｜null（FW-5／B-02：不得傳字串）
  annualTotalKm?: number | null; // ★ R9：JSON number｜null，1dp（AC-47／AC-58）
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
