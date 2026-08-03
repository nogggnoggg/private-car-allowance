/**
 * Fuel unit price derivation — PHASE-005a-T2
 *
 * Pure function, no DB, no IO, no side effects, no floating-point
 * intermediary. Spec §2.D AC-18（單價推導公式與取整）、AC-20（欄位容量守門）、
 * AC-28（零浮點中介之結構性守門）、§15 T2 列、§16 D4（推導處加容量守門，已批）。
 *
 * 本模組刻意「不接線」（不新增 route、不碰 DB、不改任何既有 service）—— 接線
 * 屬 T7/T8。`kmPerLiter > 0` 之值域把關屬 AC-08／T4 之 service 層責任（**尚未
 * 實作**——`parameter-validation.ts` 為格式層，目前刻意放行 0 與負值，不構成
 * 值域把關）；本函式對「除以零、負值、非有限（`NaN`／`Infinity`）」等會使商
 * 無意義或無法追蹤之輸入做防禦性拋錯（見 `assertPositiveDivisor` 與推導後之
 * 有限性後置檢查），不吞錯、不回傳 `NaN`、不讓非有限值逃逸。
 *
 * T7/T8 接線義務：`deriveFuelUnitPrice` 之任何 `throw`（`RangeError`）代表資料
 * 已毀損之防禦性失敗，不得以 500 面向使用者——接線處須攔截並轉為適當的
 * 4xx／內部告警，不得讓例外直接穿透至 HTTP 回應。
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
 * `.div()` / `.abs()` / `.toDecimalPlaces()` / `.greaterThanOrEqualTo()` /
 * `.isFinite()` / `.isNaN()` / `.lessThanOrEqualTo()`；
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
 * 防禦性守門：`kmPerLiter` 必須為「有限」且為正值，否則商無意義（除以零／
 * 負值）或不可追蹤（`NaN`／`Infinity` 除數會使 decimal.js 靜默產出 `NaN`
 * 或 `0`，穿透至呼叫端）。值域 `>0` 之業務驗證屬 AC-08／T4 之 service 層
 * 責任（尚未實作）；本檢查是本引擎的最後一道防線，非上游把關的重複。
 */
function assertPositiveDivisor(kmPerLiter: Prisma.Decimal): void {
  if (!kmPerLiter.isFinite() || kmPerLiter.lessThanOrEqualTo(0)) {
    throw new RangeError(
      `deriveFuelUnitPrice: kmPerLiter must be a finite positive number, received "${kmPerLiter.toString()}"`
    );
  }
}

/**
 * 防禦性後置檢查：推導結果 `unitPrice` 必須為有限數值。`kmPerLiter` 已由
 * `assertPositiveDivisor` 把關為有限正值，但 `pricePerLiter` 本身若為非有限
 * （`NaN`／`Infinity`）字串構造而成，除法仍會產出非有限商，且不觸發前述
 * 守門。此處 fail-loud：非有限來源必為資料毀損（不是正常的「超出欄位容量」
 * 情境，AC-20 的 `out_of_range` 僅處理有限但過大的商），故選擇 `throw` 而非
 * 映射為 `out_of_range`，避免以捏造的 409 掩蓋真正的資料完整性問題。
 */
function assertFiniteResult(
  unitPrice: Prisma.Decimal,
  pricePerLiter: Prisma.Decimal,
  kmPerLiter: Prisma.Decimal
): void {
  if (unitPrice.isNaN() || !unitPrice.isFinite()) {
    throw new RangeError(
      `deriveFuelUnitPrice: derived unitPrice is not finite (pricePerLiter="${pricePerLiter.toString()}", kmPerLiter="${kmPerLiter.toString()}")`
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
 * @param kmPerLiter 車輛油耗（km/L），`Prisma.Decimal` 或字串；必須為有限正值
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

  assertFiniteResult(unitPrice, price, consumption);

  if (unitPrice.abs().greaterThanOrEqualTo(FUEL_UNIT_PRICE_CAPACITY_LIMIT)) {
    return { status: "out_of_range", reason: "FUEL_UNIT_PRICE_OUT_OF_RANGE" };
  }

  return { status: "ok", unitPrice };
}
