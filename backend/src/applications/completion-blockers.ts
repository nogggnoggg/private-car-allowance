/**
 * Completion blockers generator — PHASE-004-T3 + T5 (里程 blockers 併入)
 *
 * Spec §2 群組 A（AC-01~03/07）、C（AC-14~18，T5 併入）、D（AC-24）、G
 * （AC-46）、§8.1 `BlockerDto`, §11.1 完成項清單。Pure function, zero IO —
 * no prisma client instance, no env access, no DB/network/filesystem calls,
 * same shape as `application-state-machine.ts` (T2).
 *
 * Consumed by:
 *   - T3 差旅 GET/PUT DTO 建構（DRAFT 狀態的 `completionBlockers` 欄位）
 *   - T8 完成流程（`POST /applications/:id/complete` 之守門判斷）——本函式回傳
 *     的陣列非空即拒絕完成（AC-52：回傳全部未通過項，非只回第一項）
 *
 * Rules implemented directly in this module:
 *   TRIP_DATE_REQUIRED / PURPOSE_REQUIRED / SEGMENT_REQUIRED /
 *   SEGMENT_LOCATION_REQUIRED / SEGMENT_ATTACHMENT_REQUIRED /
 *   PARAMETER_NOT_AVAILABLE
 * Mileage business rules (SEGMENT_TOTAL_KM_REQUIRED/INVALID,
 * SEGMENT_HIGHWAY_KM_REQUIRED/INVALID, SEGMENT_HIGHWAY_GT_TOTAL) are
 * implemented in `trip-validation.ts`'s `validateSegmentMileage` (PHASE-004-T5)
 * and merged in per-segment below (TODO(PHASE-004-T5) marker removed —
 * this extension point is now complete).
 *
 * 輸出順序（Packet 明文要求，供 UI 與測試穩定依賴）：
 *   1. 申請層級（依序）：TRIP_DATE_REQUIRED → PURPOSE_REQUIRED →
 *      SEGMENT_REQUIRED → PARAMETER_NOT_AVAILABLE
 *   2. 段落層級：依 `sortOrder` 由小到大；同一段內順序為
 *      SEGMENT_LOCATION_REQUIRED（origin 後 destination）→ 里程 blockers
 *      （T5，validateSegmentMileage 回傳順序）→ SEGMENT_ATTACHMENT_REQUIRED
 */

import type { Prisma } from "@prisma/client";
import { validateSegmentMileage } from "./trip-validation.js";

/** 單一行程段的完成度判斷輸入。 */
export interface BlockerSegmentInput {
  id: string;
  sortOrder: number;
  origin: string | null;
  destination: string | null;
  /** T5：里程業務規則之輸入（Prisma.Decimal，草稿階段可為 null）。 */
  totalKm: Prisma.Decimal | null;
  /** T5：同上。 */
  highwayKm: Prisma.Decimal | null;
  /** 該段目前 LINKED 附件數；T11 之前由呼叫端算出或給 0。 */
  attachmentCount: number;
}

/**
 * PHASE-005a-T7（D5(a) 已批）：`"FUEL"` → `"FUEL_PRICE"`，並新增
 * `"FUEL_CONSUMPTION"`。與 `travel-parameters.ts` 之 `MissingParameter`
 * 同形（本檔為 pure function，刻意不 import 該模組以維持零耦合，見檔頭）。
 */
export type MissingParameter = "FUEL_PRICE" | "FUEL_CONSUMPTION" | "ETC";

export interface BlockerInput {
  tripDate: Date | null;
  purpose: string | null;
  segments: ReadonlyArray<BlockerSegmentInput>;
  /** 缺少的參數類別；T7 之前呼叫端一律傳空陣列。 */
  missingParameters: ReadonlyArray<MissingParameter>;
}

export interface Blocker {
  code: string;
  field?: string;
  segmentId?: string;
  segmentIndex?: number;
  message: string; // zh-TW
}

/** 純空白／null／undefined 一律視為缺（PURPOSE_REQUIRED 的 AC-52 邊界案例）。 */
function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0;
}

const PARAMETER_LABELS: Record<MissingParameter, string> = {
  FUEL_PRICE: "油資",
  FUEL_CONSUMPTION: "油資",
  ETC: "ETC",
};

/**
 * 計算差旅草稿的「尚未完成項」清單（後端唯一權威，D7）。
 * 回傳全部未通過項（AC-52），不可只回第一項；輸出順序穩定可預期。
 */
export function computeCompletionBlockers(input: BlockerInput): Blocker[] {
  const blockers: Blocker[] = [];

  // ── 申請層級 ─────────────────────────────────────────────────────────
  if (input.tripDate === null) {
    blockers.push({
      code: "TRIP_DATE_REQUIRED",
      field: "tripDate",
      message: "請填寫出差日期",
    });
  }

  if (isBlank(input.purpose)) {
    blockers.push({
      code: "PURPOSE_REQUIRED",
      field: "purpose",
      message: "請填寫出差目的",
    });
  }

  if (input.segments.length === 0) {
    blockers.push({
      code: "SEGMENT_REQUIRED",
      message: "至少需要一個行程段",
    });
  }

  // PHASE-005a-T7（AC-21 明文要求）：缺油耗須有可區分的獨立 blocker code
  // `FUEL_CONSUMPTION_NOT_AVAILABLE`（草稿階段之提示，與完成端點 409 的
  // `details.missing` 是不同的層級/命名空間——各自獨立，互不影響）。其餘缺項
  // （FUEL_PRICE／ETC）沿用既有合併呈現，維持既有測試之組合訊息行為不變。
  if (input.missingParameters.includes("FUEL_CONSUMPTION")) {
    blockers.push({
      code: "FUEL_CONSUMPTION_NOT_AVAILABLE",
      message: "出差日期缺少您的車輛油耗資料，請聯絡管理員建立",
    });
  }

  const otherMissing = input.missingParameters.filter((p) => p !== "FUEL_CONSUMPTION");
  if (otherMissing.length > 0) {
    const labels = otherMissing.map((p) => PARAMETER_LABELS[p]).join("、");
    blockers.push({
      code: "PARAMETER_NOT_AVAILABLE",
      message: `出差日期缺少有效的${labels}補助參數，請聯絡管理員設定`,
    });
  }

  // ── 段落層級：依 sortOrder 由小到大（輸入陣列順序不保證，須自行排序） ──
  const orderedSegments = [...input.segments].sort((a, b) => a.sortOrder - b.sortOrder);

  orderedSegments.forEach((segment, segmentIndex) => {
    if (isBlank(segment.origin)) {
      blockers.push({
        code: "SEGMENT_LOCATION_REQUIRED",
        field: `segments[${segmentIndex}].origin`,
        segmentId: segment.id,
        segmentIndex,
        message: `第 ${segmentIndex + 1} 段缺少出發地點`,
      });
    }

    if (isBlank(segment.destination)) {
      blockers.push({
        code: "SEGMENT_LOCATION_REQUIRED",
        field: `segments[${segmentIndex}].destination`,
        segmentId: segment.id,
        segmentIndex,
        message: `第 ${segmentIndex + 1} 段缺少到達地點`,
      });
    }

    // T5：里程規則 blockers 併入（AC-14~18）。插入位置：同一段內，
    // SEGMENT_LOCATION_REQUIRED 之後、SEGMENT_ATTACHMENT_REQUIRED 之前，
    // 以維持「同段內問題集中呈現」的順序。
    blockers.push(
      ...validateSegmentMileage({
        id: segment.id,
        sortOrder: segmentIndex,
        totalKm: segment.totalKm,
        highwayKm: segment.highwayKm,
      })
    );

    if (segment.attachmentCount < 1) {
      blockers.push({
        code: "SEGMENT_ATTACHMENT_REQUIRED",
        segmentId: segment.id,
        segmentIndex,
        message: `第 ${segmentIndex + 1} 段缺少 Google Maps 截圖`,
      });
    }
  });

  return blockers;
}
