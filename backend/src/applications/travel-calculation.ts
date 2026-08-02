/**
 * Travel allowance calculation engine — PHASE-004-T6
 *
 * Pure function, no DB, no IO, no side effects, no floating-point
 * intermediary. Spec §1.1 第 6 點、§2 群組 F（AC-37~44）、§5 邊界 B-02/B-03/
 * B-06/B-07/B-08、§8.1 `TravelComputedDto`、§9「金額預覽（stateless）」
 * 計算虛擬碼、§17.1 D4（取整前金額 `Decimal(14,4)`、最終金額 `Int`、
 * `ROUND_HALF_UP`、禁浮點中介、`Decimal` 建構一律傳字串）。
 *
 * 計算語意（逐字實作，不得自行優化順序 — Spec §9 虛擬碼）：
 *   segFuel = totalKm × fuelUnitPrice          （未取整）
 *   segEtc  = highwayKm × etcUnitPrice         （未取整）
 *   segRaw  = segFuel + segEtc                 （先相加）
 *   segAmt  = ROUND_HALF_UP(segRaw, 0)         （再取整；非銀行家）
 *   totalAmount    = Σ segAmt                  （加總已取整值，AC-41）
 *   totalRawAmount = Σ segRaw                  （取整前總和，供快照）
 *   totalKm        = Σ totalKm                 （高速里程不重複加，AC-42）
 *
 * 本模組刻意「不做輸入驗證」（驗證屬 T5 `trip-validation.ts`；本引擎假設
 * 輸入已合法）。本模組刻意「不接線」（不新增 route、不碰 DB；接線屬 T7/T8）。
 *
 * 浮點中介聲明：本檔全程僅使用 `Prisma.Decimal`（decimal.js）的
 * `.times()` / `.plus()` / `.toDecimalPlaces()` 進行運算。`Decimal.toNumber()`
 * 僅在下列兩處使用，且皆發生於「已透過 `ROUND_HALF_UP` 取整為整數之後」：
 *   1. 各段 `amount`：`rawAmount.toDecimalPlaces(0, ROUND_HALF_UP).toNumber()`
 *   2. 整筆 `totalAmount`：以 `Decimal` 累加各段已取整值後，於回傳前一次性
 *      `.toNumber()`
 * 全程無 `Number()`／`parseFloat`／浮點算術參與金額或里程的計算過程。
 */

import { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CalcSegmentInput {
  segmentId: string | null; // 預覽時未儲存的段落為 null
  segmentIndex: number;
  totalKm: Prisma.Decimal; // 已通過驗證的有效值
  highwayKm: Prisma.Decimal;
}

export interface CalcSegmentResult {
  segmentId: string | null;
  segmentIndex: number;
  fuelAmount: Prisma.Decimal; // 取整前
  etcAmount: Prisma.Decimal; // 取整前
  rawAmount: Prisma.Decimal; // 取整前（fuel + etc）
  amount: number; // 取整後（新臺幣整數）
}

export interface CalcResult {
  segments: CalcSegmentResult[];
  totalKm: Prisma.Decimal; // Σ 各段 totalKm（高速不重複加）
  totalRawAmount: Prisma.Decimal; // Σ 各段 rawAmount（取整前）
  totalAmount: number; // Σ 各段 amount（已取整後加總）
}

export interface CalculateTravelInput {
  segments: ReadonlyArray<CalcSegmentInput>;
  fuelUnitPrice: Prisma.Decimal;
  etcUnitPrice: Prisma.Decimal;
}

// ---------------------------------------------------------------------------
// calculateTravel
// ---------------------------------------------------------------------------

/**
 * Compute per-segment and whole-application travel allowance amounts.
 *
 * Pure function (AC-44): no DB/IO/`Date.now()`/randomness; identical input
 * yields identical output; input objects are never mutated (all arithmetic
 * uses `Prisma.Decimal`, whose operations always return new instances).
 *
 * Empty `segments` → `{ segments: [], totalKm: 0, totalRawAmount: 0,
 * totalAmount: 0 }`; never throws, never returns NaN.
 */
export function calculateTravel(input: CalculateTravelInput): CalcResult {
  const { segments, fuelUnitPrice, etcUnitPrice } = input;

  const segmentResults: CalcSegmentResult[] = [];
  let totalKm = new Prisma.Decimal("0");
  let totalRawAmountDecimal = new Prisma.Decimal("0");
  let totalAmountDecimal = new Prisma.Decimal("0");

  for (const segment of segments) {
    // segFuel = totalKm × fuelUnitPrice（未取整）
    const fuelAmount = segment.totalKm.times(fuelUnitPrice);
    // segEtc = highwayKm × etcUnitPrice（未取整）
    const etcAmount = segment.highwayKm.times(etcUnitPrice);
    // segRaw = segFuel + segEtc（先相加）
    const rawAmount = fuelAmount.plus(etcAmount);
    // segAmt = ROUND_HALF_UP(segRaw, 0)（再取整；非銀行家）
    const amountDecimal = rawAmount.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);

    segmentResults.push({
      segmentId: segment.segmentId,
      segmentIndex: segment.segmentIndex,
      fuelAmount,
      etcAmount,
      rawAmount,
      // toNumber() only after rounding to an integer Decimal above.
      amount: amountDecimal.toNumber(),
    });

    // totalKm = Σ totalKm（高速里程不重複加：highwayKm 從不參與此加總）
    totalKm = totalKm.plus(segment.totalKm);
    // totalRawAmount = Σ segRaw（取整前總和，供快照）
    totalRawAmountDecimal = totalRawAmountDecimal.plus(rawAmount);
    // totalAmount = Σ segAmt（加總「已取整」值，非加總 rawAmount 再取整）
    totalAmountDecimal = totalAmountDecimal.plus(amountDecimal);
  }

  return {
    segments: segmentResults,
    totalKm,
    totalRawAmount: totalRawAmountDecimal,
    // toNumber() only after summing already-rounded integer Decimals above.
    totalAmount: totalAmountDecimal.toNumber(),
  };
}
