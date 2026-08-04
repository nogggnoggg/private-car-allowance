/**
 * Trip mileage / location validation — PHASE-004-T5
 *
 * Spec §2 群組 C（AC-14~21）、§5 邊界條件 B-01~B-05/B-31、§8.1 `BlockerDto`、
 * §8.2 `SegmentInput`、§17.1 D5（里程 `Decimal(10,2)`、超位數 400 拒絕、
 * 不靜默取整、本 Phase 不設業務上限）、D14(ii)（地點 ≤200 字）、D7（後端
 * blockers 為權威）.
 *
 * Pure functions, zero IO — no prisma client instance, no env access, no
 * DB/network/filesystem calls. Same shape as `application-state-machine.ts`
 * (T2) and `completion-blockers.ts` (T3).
 *
 * Two layers, deliberately separate (Packet 明文，AC-19 vs AC-21 不矛盾）：
 *   - `parseKmField` / `parseLocationField` — FORMAT-level. Called at SAVE
 *     time (PUT). Rejects malformed input (>2 decimal places, non-numeric,
 *     over-length) with 400 VALIDATION_ERROR — this is a format error, not a
 *     business rule, so silently rounding it would corrupt the reporting
 *     basis without the user's knowledge (AC-19).
 *   - `validateSegmentMileage` — BUSINESS-level. Called at COMPLETE time.
 *     A well-FORMED value (e.g. totalKm = -0.01, or totalKm = 0) is still
 *     allowed to be *saved* as a draft (AC-21) — it only becomes a blocker
 *     when the user tries to complete the application.
 *
 * `Decimal` construction rule (carried over from PHASE-003a AR-3a-1 lesson,
 * reaffirmed by PHASE-004 D4/D5): construct `Prisma.Decimal` from a STRING,
 * never from a value that has already round-tripped through `Number()`. A
 * `number` input is converted via `.toString()` (JS's own shortest
 * round-trip string conversion — NOT `Number()` applied to an already
 * existing string), which is safe because the value is a primitive `number`
 * to begin with, not a string being re-parsed through a lossy path.
 */

import { Prisma } from "@prisma/client";
import type { FieldError } from "../platform/errors.js";
import type { Blocker } from "./completion-blockers.js";

// ---------------------------------------------------------------------------
// parseKmField — format-level (AC-19, D5)
// ---------------------------------------------------------------------------

/** Strict plain-decimal literal: optional leading '-', digits, optional '.' + digits. No exponent notation. */
const DECIMAL_LITERAL_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Decimal(10,2) capacity: precision 10, scale 2 → at most 8 digits before
 * the decimal point. Values whose magnitude reaches or exceeds 10^8 cannot
 * be stored and must be rejected here (with a clear reason) rather than
 * blowing up as an opaque DB error later.
 */
const KM_MAGNITUDE_LIMIT = new Prisma.Decimal("100000000"); // 10^8

/**
 * Decimal(12,2) capacity (PHASE-006-T4：`MaintenanceApplication.actualCost`):
 * precision 12, scale 2 → at most 10 digits before the decimal point.
 */
const ACTUAL_COST_MAGNITUDE_LIMIT = new Prisma.Decimal("10000000000"); // 10^10

export type ParseKmFieldResult =
  | { ok: true; value: Prisma.Decimal | null }
  | { ok: false; error: FieldError };

/**
 * PHASE-006-T4 即審義務（AC-03「不新增第二套驗證實作」＋ T1 AR-6⑤）：本函式
 * 為 `parseKmField`／`parseActualCostField` 共用的參數化實作——僅有 1 套
 * 格式／容量驗證邏輯，兩個匯出函式只是帶著不同的「容量上界」與「容量錯誤
 * 文案」呼叫同一份程式碼，而非各自複製一份判斷式。
 *
 * 分層（沿 CHORE-003／PHASE-003a §14.2 既有 gate table 慣例）：
 *   1. 型別層：非 `string`／`number`／`null` → 400
 *   2. 格式層（字面樣式）：非合法十進位字面（千分位、科學記號、非數字字串、
 *      `NaN`/`Infinity` 字串）→ 400（`DECIMAL_LITERAL_PATTERN` 不接受任何
 *      千分位逗號或指數記號，`Number.isFinite` 擋 `NaN`/`Infinity` 數字輸入）
 *   3. 小數位層：超過 `maxDecimalPlaces` → 400
 *   4. 容量層：超過 `magnitudeLimit`（欄位精度推導，非魔術數）→ 400
 */
function parseDecimalField(
  value: unknown,
  field: string,
  options: { maxDecimalPlaces: number; magnitudeLimit: Prisma.Decimal; capacityReason: string }
): ParseKmFieldResult {
  if (value === null) {
    return { ok: true, value: null };
  }

  let literal: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { ok: false, error: { field, reason: "必須為有效的數值" } };
    }
    literal = value.toString();
  } else if (typeof value === "string") {
    literal = value.trim();
    if (literal.length === 0) {
      return { ok: false, error: { field, reason: "必須為有效的數值" } };
    }
  } else {
    return { ok: false, error: { field, reason: "必須為有效的數值（字串、數字或 null）" } };
  }

  if (!DECIMAL_LITERAL_PATTERN.test(literal)) {
    return { ok: false, error: { field, reason: "必須為有效的十進位數值" } };
  }

  let decimalValue: Prisma.Decimal;
  try {
    decimalValue = new Prisma.Decimal(literal);
  } catch {
    return { ok: false, error: { field, reason: "必須為有效的十進位數值" } };
  }

  // AC-19 / B-05: 超過允許小數位 → 400 拒絕，不靜默取整。Decimal#decimalPlaces()
  // is computed on the normalized value (trailing zeros already stripped by
  // decimal.js during parsing), so "12.340" reports 2, not 3 — see Handoff.
  if (decimalValue.decimalPlaces() > options.maxDecimalPlaces) {
    return { ok: false, error: { field, reason: `最多允許 ${options.maxDecimalPlaces} 位小數` } };
  }

  // Column capacity guard — reject before it can fail at the DB layer.
  if (decimalValue.abs().greaterThanOrEqualTo(options.magnitudeLimit)) {
    return { ok: false, error: { field, reason: options.capacityReason } };
  }

  return { ok: true, value: decimalValue };
}

/**
 * Parses a mileage field (`totalKm` / `highwayKm` / PHASE-006-T4 起亦用於
 * `lastOdometerKm`/`currentOdometerKm`，皆為 `Decimal(10,2)`) per D5: accepts
 * `string`, `number`, or `null`; rejects anything else.
 *
 * Negative values are deliberately ALLOWED to pass this format-level check
 * (AC-21: a draft may store `totalKm ≤ 0`) — the ≤0 / <0 business rules are
 * enforced only at completion time (`validateSegmentMileage`／
 * `computeMaintenanceBlockers`).
 *
 * 既有匯出簽章不變（2 參數）——PHASE-006-T4 僅在內部改為呼叫參數化的
 * `parseDecimalField`，呼叫端完全無感知。
 */
export function parseKmField(value: unknown, field: string): ParseKmFieldResult {
  return parseDecimalField(value, field, {
    maxDecimalPlaces: 2,
    magnitudeLimit: KM_MAGNITUDE_LIMIT,
    capacityReason: "數值超出可儲存範圍（整數部分最多 8 位）",
  });
}

/**
 * PHASE-006-T4 新增：解析 `MaintenanceApplication.actualCost`
 * （`Decimal(12,2)`，§8.3）。與 `parseKmField` 共用同一套格式／容量驗證程式碼
 * （`parseDecimalField`），僅小數位／容量上界／容量錯誤文案不同——不是第二套
 * 驗證實作（AC-03 明文禁止）。
 */
export function parseActualCostField(value: unknown, field: string): ParseKmFieldResult {
  return parseDecimalField(value, field, {
    maxDecimalPlaces: 2,
    magnitudeLimit: ACTUAL_COST_MAGNITUDE_LIMIT,
    capacityReason: "數值超出可儲存範圍（整數部分最多 10 位）",
  });
}

// ---------------------------------------------------------------------------
// parseLocationField — format-level (D14(ii))
// ---------------------------------------------------------------------------

const LOCATION_MAX_LENGTH = 200; // D14(ii)：大總管代定，供人類事後調整

export type ParseLocationFieldResult =
  | { ok: true; value: string | null }
  | { ok: false; error: FieldError };

/**
 * Parses a location field (`origin` / `destination`) per D14(ii): `null` or
 * a string of at most 200 characters. Whitespace-only strings are NOT
 * treated specially here — they pass through unchanged (as "has a value")
 * and are caught by `completion-blockers.ts`'s `isBlank()` at completion
 * time (AC-20), consistent with the format/business split used for mileage.
 */
export function parseLocationField(value: unknown, field: string): ParseLocationFieldResult {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return { ok: false, error: { field, reason: "必須為文字或 null" } };
  }
  if (value.length > LOCATION_MAX_LENGTH) {
    return { ok: false, error: { field, reason: `長度不可超過 ${LOCATION_MAX_LENGTH} 字` } };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// validateSegmentMileage — business-level (AC-14~18, checked at completion)
// ---------------------------------------------------------------------------

export interface MileageSegmentInput {
  id: string;
  sortOrder: number;
  totalKm: Prisma.Decimal | null;
  highwayKm: Prisma.Decimal | null;
}

/**
 * Business-rule mileage validation, applied at completion time (T8 will call
 * this per segment). Returns ALL violations for the segment, not just the
 * first (mirrors `computeCompletionBlockers`'s AC-52 discipline).
 *
 * `segmentIndex` is taken directly from `segment.sortOrder` — by the D15
 * invariant, `sortOrder` is always rewritten to a contiguous `0..n-1` range
 * on every save, so it is interchangeable with "position after sorting" as
 * used by `completion-blockers.ts`.
 *
 * All comparisons use `Prisma.Decimal` methods exclusively — no floating
 * point intermediary.
 */
export function validateSegmentMileage(segment: MileageSegmentInput): Blocker[] {
  const blockers: Blocker[] = [];
  const segmentIndex = segment.sortOrder;
  const ordinal = segmentIndex + 1;

  if (segment.totalKm === null) {
    blockers.push({
      code: "SEGMENT_TOTAL_KM_REQUIRED",
      field: `segments[${segmentIndex}].totalKm`,
      segmentId: segment.id,
      segmentIndex,
      message: `第 ${ordinal} 段缺少總里程`,
    });
  } else if (segment.totalKm.lessThanOrEqualTo(0)) {
    // AC-14 / B-01: totalKm ≤ 0（含 0 與負值）
    blockers.push({
      code: "SEGMENT_TOTAL_KM_INVALID",
      field: `segments[${segmentIndex}].totalKm`,
      segmentId: segment.id,
      segmentIndex,
      message: `第 ${ordinal} 段總里程必須大於 0`,
    });
  }

  if (segment.highwayKm === null) {
    blockers.push({
      code: "SEGMENT_HIGHWAY_KM_REQUIRED",
      field: `segments[${segmentIndex}].highwayKm`,
      segmentId: segment.id,
      segmentIndex,
      message: `第 ${ordinal} 段缺少高速公路里程`,
    });
  } else if (segment.highwayKm.lessThan(0)) {
    // AC-15: highwayKm < 0
    blockers.push({
      code: "SEGMENT_HIGHWAY_KM_INVALID",
      field: `segments[${segmentIndex}].highwayKm`,
      segmentId: segment.id,
      segmentIndex,
      message: `第 ${ordinal} 段高速公路里程不得小於 0`,
    });
  } else if (segment.totalKm !== null && segment.highwayKm.greaterThan(segment.totalKm)) {
    // AC-16 / B-04: highwayKm > totalKm（`==` 含等於為允許，AC-18）
    blockers.push({
      code: "SEGMENT_HIGHWAY_GT_TOTAL",
      field: `segments[${segmentIndex}].highwayKm`,
      segmentId: segment.id,
      segmentIndex,
      message: `第 ${ordinal} 段高速公路里程不得大於總里程`,
    });
  }

  return blockers;
}
