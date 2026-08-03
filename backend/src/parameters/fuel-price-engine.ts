/**
 * Fuel unit price derivation — PHASE-005a-T2
 *
 * Pure function, no DB, no IO, no side effects, no floating-point
 * intermediary. Spec §2.D AC-18（單價推導公式與取整）、AC-20（欄位容量守門）、
 * AC-28（零浮點中介之結構性守門）、§15 T2 列、§16 D4（推導處加容量守門，已批）。
 *
 * 本模組刻意「不接線」（不新增 route、不碰 DB、不改任何既有 service）—— 接線
 * 屬 T7/T8。本模組刻意「不做上游驗證」（`kmPerLiter > 0` 等已由既有參數驗證
 * 管線 `parameter-validation.ts` 於建立版本時把關；沿用 `travel-calculation.ts`
 * 「引擎假設輸入已合法」之既有慣例），僅對「除以零或負值」這種會使商無意義
 * 的輸入做防禦性拋錯（見 `assertPositiveDivisor`），不吞錯、不回傳 NaN。
 *
 * 計算語意（逐字實作，AC-18）：
 *   unitPrice = ROUND_HALF_UP(pricePerLiter ÷ kmPerLiter, 0)   （整數，NTD）
 *
 * 容量守門（AC-20 / D4(a)）：
 *   `TravelApplication.fuelUnitPrice` 為 `Decimal(10,4)`（整數部最多 6 位，
 *   即 `|v| < 1e6`）。若推導後 `|unitPrice| ≥ 1e6`，本函式**不**拋錯、**不**
 *   靜默截斷，而是回傳 discriminated union 的 `out_of_range` 分支，交由
 *   T7/T8 於完成流程轉 409 `PARAMETER_NOT_AVAILABLE`
 *  （`details.missing` 追加 `FUEL_UNIT_PRICE_OUT_OF_RANGE`）。
 *
 * 浮點中介聲明（AC-28）：本檔全程僅使用 `Prisma.Decimal`（decimal.js）之
 * `.div()` / `.abs()` / `.toDecimalPlaces()` / `.greaterThanOrEqualTo()`；
 * `Prisma.Decimal` 建構僅發生於「輸入已為字串或既有 Decimal 實例」之處，
 * 從未以 `Number()`／`parseFloat`／`parseInt`／`+<變數>` 做數值脅制中介。
 */

import { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** `TravelApplication.fuelUnitPrice` 欄位容量：`Decimal(10,4)` ⇒ 整數部 6 位。 */
const FUEL_UNIT_PRICE_CAPACITY_LIMIT = new Prisma.Decimal("1000000");

export type FuelUnitPriceResult =
  | {
      readonly status: "ok";
      /** ROUND_HALF_UP 取整後之整數單價（NTD／km），型別為 Prisma.Decimal。 */
      readonly unitPrice: Prisma.Decimal;
    }
  | {
      readonly status: "out_of_range";
      /** D4(a) 已批之明確標記，供 T7/T8 映射至 `details.missing` 代碼。 */
      readonly reason: "FUEL_UNIT_PRICE_OUT_OF_RANGE";
    };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * 接受 `Prisma.Decimal` 實例或字串；一律以字串／既有 Decimal 建構新
 * `Prisma.Decimal`，禁止經由 `Number()` 之中介（D4 bright-line、AC-28）。
 */
function toDecimal(value: Prisma.Decimal | string): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

/**
 * 防禦性守門：`kmPerLiter` 必須為正值，否則商無意義（除以零／負值）。
 * 上游 `parameter-validation.ts` 已在建立油耗版本時把關正值，本檢查僅為
 * 本引擎之最後一道防線，避免 decimal.js 之除以零直接拋出難以追蹤的錯誤。
 */
function assertPositiveDivisor(kmPerLiter: Prisma.Decimal): void {
  if (kmPerLiter.lessThanOrEqualTo(0)) {
    throw new RangeError(
      `deriveFuelUnitPrice: kmPerLiter must be positive, received "${kmPerLiter.toString()}"`
    );
  }
}

// ---------------------------------------------------------------------------
// deriveFuelUnitPrice
// ---------------------------------------------------------------------------

/**
 * 由每公升油價與車輛油耗推導取整後之油資每公里單價（AC-18）。
 *
 * Pure function：無 DB／IO／`Date.now()`／隨機性；相同輸入恆得相同輸出；
 * 從不 mutate 輸入。
 *
 * @param pricePerLiter 每公升油價（元/L），`Prisma.Decimal` 或字串
 * @param kmPerLiter 車輛油耗（km/L），`Prisma.Decimal` 或字串；必須為正值
 * @returns 成功時 `{ status: "ok", unitPrice }`（整數 Decimal）；
 *          推導後 `|unitPrice| ≥ 10^6`（欄位容量）時
 *          `{ status: "out_of_range", reason: "FUEL_UNIT_PRICE_OUT_OF_RANGE" }`
 *          （AC-20 / D4(a)，絕不拋錯、絕不靜默截斷）
 */
export function deriveFuelUnitPrice(
  pricePerLiter: Prisma.Decimal | string,
  kmPerLiter: Prisma.Decimal | string
): FuelUnitPriceResult {
  const price = toDecimal(pricePerLiter);
  const consumption = toDecimal(kmPerLiter);

  assertPositiveDivisor(consumption);

  // unitPrice = ROUND_HALF_UP(pricePerLiter ÷ kmPerLiter, 0)（AC-18；恰一處取整）
  const unitPrice = price.div(consumption).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);

  if (unitPrice.abs().greaterThanOrEqualTo(FUEL_UNIT_PRICE_CAPACITY_LIMIT)) {
    return { status: "out_of_range", reason: "FUEL_UNIT_PRICE_OUT_OF_RANGE" };
  }

  return { status: "ok", unitPrice };
}
