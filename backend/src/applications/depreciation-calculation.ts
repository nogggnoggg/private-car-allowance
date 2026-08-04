/**
 * Annual depreciation allowance calculation engine — PHASE-007-T2
 *
 * Pure function: no DB, no IO, no `Date.now()`, no randomness, no side
 * effects, no floating-point intermediary. Spec `docs/specs/PHASE-007.md`
 * §2（AC-19／AC-20／AC-21／AC-22 判定層）、§7.4 計算五步驟、§8.3 欄位容量
 * 與精度之推導依據、§16 D6(a)（單價精度來源）／D11（容量守門呈現形狀）。
 *
 * 計算語意（Spec §7.4 ③④⑤ 逐字實作，不得自行優化順序）：
 *   perKmUnitPrice = new Prisma.Decimal(derived.perKmUnitPrice)  ← 呼叫端還原
 *                    （PHASE-003a `deriveDepreciation` 之 4 位小數字串；
 *                      本模組直接收 `Prisma.Decimal`，**不得**經 `Number()`／
 *                      `parseFloat` 還原 —— AC-19）
 *   rawAmount      = officialKm.times(perKmUnitPrice)             （AC-19，未取整）
 *   amount         = rawAmount.toDecimalPlaces(0, ROUND_HALF_UP).toNumber()
 *                                                                 （AC-19/20/21）
 *
 * AC-20「取整恰一處」之實作承諾：本檔全域僅有**一次** `.toDecimalPlaces()`
 * 呼叫（即上方最終金額），由測試以原始碼掃描機械守護。**禁止**下列改寫：
 *   ✗ 先對 `officialKm` 取整為整數再相乘；
 *   ✗ 先將 `rawAmount` 取整至 2 位小數再取整為整數；
 *   ✗ 對 `perKmUnitPrice` 再次取整（其 4 位小數取整已發生於 PHASE-003a
 *     引擎內部，本 Phase 不得重複）。
 * 三者各有 kill case（`backend/test/unit/depreciation-calculation.test.ts` §3）。
 *
 * AC-21 取整方向：一般四捨五入 `ROUND_HALF_UP`（0.5 進位、away from zero），
 * **非銀行家取整**（`ROUND_HALF_EVEN`）——CLAUDE.md 金額計算規則。
 *
 * 防禦（005a T2 SF-1／006 T2R MF-1 同型）：`officialKm`／`perKmUnitPrice`／
 * 相乘結果三處各以 `.isFinite()` 守門（`NaN` 與 `±Infinity` 皆回 false）。
 * 非有限輸入一律回 `calculable=false`＋`rawAmount=null`＋`amount=null`——
 * **絕不**回傳 `NaN`／`Infinity` 金額、**絕不**靜默回傳看似合法的 `0`、
 * **絕不**拋錯（純函式零 IO，錯誤語意由呼叫端決定，此處只回報狀態）。
 * 特別注意：`Prisma.Decimal` 與 `NaN` 的任何比較恆為 `false`，故守門一律以
 * `.isFinite()` 為之，**不得**改寫為 `value.greaterThan(0)` 之類的比較式
 * （那正是 005a SF-1 的靜默穿透根因）。
 *
 * 本模組刻意「不做完成度驗證」（屬 T3 `depreciation-blockers.ts`）、刻意
 * 「不接線」（不新增 route、不碰 DB；接線屬 T6/T7/T9）、刻意「不對輸入做
 * 業務值域驗證」（年度值域屬 T4 驗證層）。容量 predicate
 * （`isDepreciationCalculationOverCapacity`）亦僅判定、不拋錯、不截斷——由
 * 呼叫端（T3/T7/T9）決定如何轉換為 blocker code `AMOUNT_OUT_OF_RANGE`／4xx。
 *
 * 浮點中介聲明：本檔全程僅使用 `Prisma.Decimal`（decimal.js）的 `.times()`
 * ／`.pow()`／`.abs()`／`.toDecimalPlaces()`／`.isFinite()`／
 * `.greaterThanOrEqualTo()` 進行運算。`Decimal.toNumber()` 僅在兩處使用：
 * (1) 最終金額，且發生於 `ROUND_HALF_UP` 取整為整數**之後**；(2) 容量常數
 * 之整數上界（由欄位精度推導之 10 的冪，恆為精確整數）。全程無 `Number()`
 * ／`parseFloat`／`parseInt`／浮點算術參與金額或里程的計算過程（由測試
 * §7 之清單驅動掃描機械守護）。
 */

import { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CalculateDepreciationInput {
  /** 年度公務里程（`sumOfficialMileage` 之 `totalKm`；AC-13：`applicationCount` 絕不進入計算）。 */
  officialKm: Prisma.Decimal;
  /** 每公里補助單價（PHASE-003a `deriveDepreciation` 之 4 位小數輸出還原而得）。 */
  perKmUnitPrice: Prisma.Decimal;
}

export interface CalculateDepreciationResult {
  /** 原樣傳回（供容量 predicate 與快照使用，未取整）。 */
  officialKm: Prisma.Decimal;
  /** 原樣傳回（未再次取整——AC-20）。 */
  perKmUnitPrice: Prisma.Decimal;
  /** `false` 僅當任一輸入或其乘積為非有限值（`NaN`／`±Infinity`）。 */
  calculable: boolean;
  /** AC-19：取整前補貼金額；`calculable=false` 時為 `null`。 */
  rawAmount: Prisma.Decimal | null;
  /** AC-19/21：`ROUND_HALF_UP(rawAmount, 0)`；`calculable=false` 時為 `null`。 */
  amount: number | null;
}

// ---------------------------------------------------------------------------
// calculateDepreciation
// ---------------------------------------------------------------------------

/**
 * Compute the annual depreciation allowance for a single application.
 *
 * Pure function: identical input yields identical output; the input
 * `Prisma.Decimal` values are never mutated (all arithmetic returns new
 * `Decimal` instances). Never throws, never returns `NaN`/`Infinity`.
 */
export function calculateDepreciation(
  input: CalculateDepreciationInput
): CalculateDepreciationResult {
  const { officialKm, perKmUnitPrice } = input;

  // 守門 ①②（AC-19 防禦）：兩個輸入本身須為有限值。`.isFinite()` 對 `NaN`
  // 與 `±Infinity` 皆回 false。
  if (!officialKm.isFinite() || !perKmUnitPrice.isFinite()) {
    return { officialKm, perKmUnitPrice, calculable: false, rawAmount: null, amount: null };
  }

  // AC-19 §7.4 ④：rawAmount = 年度公務里程 × 每公里單價（Decimal 乘法，不取整）。
  const rawAmount = officialKm.times(perKmUnitPrice);

  // 守門 ③：乘積本身仍須為有限值（例如 `0 × Infinity = NaN`；雖已被守門 ①②
  // 涵蓋，此處為獨立第三道防線，確保未來若守門 ①② 被改動，`NaN` 仍不會
  // 穿透到 `amount`）。
  if (!rawAmount.isFinite()) {
    return { officialKm, perKmUnitPrice, calculable: false, rawAmount: null, amount: null };
  }

  // AC-19/20/21 §7.4 ⑤：全 Phase 唯一一處取整 —— ROUND_HALF_UP 至整數（新臺幣）。
  const amount = rawAmount.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();

  return { officialKm, perKmUnitPrice, calculable: true, rawAmount, amount };
}

// ---------------------------------------------------------------------------
// AC-22(a) — 容量 predicate（判定層；接線屬 T3/T7/T9）
//
// T1 即審 FW-1 義務：容量閾值一律由**欄位精度**推導，不得寫魔術數，且常數
// 之 `precision`／`scale` 須能與**實際套用之 migration DDL** 逐值比對
// （對照測試見 `depreciation-calculation.test.ts` §6）。
// ---------------------------------------------------------------------------

/** 十進位基數。唯一的 `Prisma.Decimal` 建構處（D4 bright-line：字串字面）。 */
const DECIMAL_RADIX = new Prisma.Decimal("10");

/**
 * 由 `DECIMAL(precision, scale)` 推導可容納之絕對值上界（開區間）：
 * 整數位數 ＝ `precision − scale`，故 `|v| < 10^(precision − scale)`。
 */
function decimalCapacityBound(precision: number, scale: number): Prisma.Decimal {
  return DECIMAL_RADIX.pow(precision - scale);
}

/** Postgres `int4` 之位元寬度（`Application.totalAmount INTEGER`）。 */
const INT4_BITS = 32;

/**
 * 折舊快照各欄位之容量規格 —— **值一律取自 §8.2／migration DDL，零魔術數**。
 *
 * 匯出供測試以 migration SQL 逐欄對照（T1 即審 FW-1），亦供 T3/T7/T9 之
 * 呼叫端在需要時引用同一組常數，避免第二份心智模型。
 */
export const DEPRECIATION_COLUMN_CAPACITY = {
  /** `DepreciationApplication.snapshotOfficialKm` — `DECIMAL(12,2)` → `|v| < 1e10`。 */
  snapshotOfficialKm: {
    precision: 12,
    scale: 2,
    bound: decimalCapacityBound(12, 2),
  },
  /** `DepreciationApplication.snapshotPerKmUnitPrice` — `DECIMAL(14,4)` → `|v| < 1e10`（§8.3 容量缺口 #1）。 */
  snapshotPerKmUnitPrice: {
    precision: 14,
    scale: 4,
    bound: decimalCapacityBound(14, 4),
  },
  /** `DepreciationApplication.snapshotRawAmount` — `DECIMAL(14,4)` → `|v| < 1e10`（§8.3 容量缺口 #2）。 */
  snapshotRawAmount: {
    precision: 14,
    scale: 4,
    bound: decimalCapacityBound(14, 4),
  },
  /** `Application.totalAmount` — `INTEGER`（int4）。 */
  totalAmount: {
    bits: INT4_BITS,
    max: 2 ** (INT4_BITS - 1) - 1,
    min: -(2 ** (INT4_BITS - 1)),
  },
} as const;

function exceedsDecimalCapacity(value: Prisma.Decimal, bound: Prisma.Decimal): boolean {
  return !value.isFinite() || value.abs().greaterThanOrEqualTo(bound);
}

function exceedsInt4Capacity(value: number): boolean {
  const { min, max } = DEPRECIATION_COLUMN_CAPACITY.totalAmount;
  return !Number.isFinite(value) || value < min || value > max;
}

/**
 * AC-22(a) 容量 predicate：`calculateDepreciation` 之輸出（年度公務里程、
 * 每公里單價、取整前金額、最終金額）任一項超出其目標資料庫欄位容量 → `true`。
 *
 * 純函式、零 IO、**絕不拋錯**——僅回報布林判定，由呼叫端（T3/T7/T9）決定
 * 如何轉換為 blocker code `AMOUNT_OUT_OF_RANGE`／4xx 回應（AC-22(b)(c)）。
 * **絕不**在此處靜默截斷任何欄位值：`calculateDepreciation` 的回傳值完全不
 * 受本 predicate 影響，即使超出容量，`rawAmount`／`amount` 仍是真實計算值。
 *
 * T1 即審 FW-2：`Decimal(14,4)` 溢位於 Postgres 為 SQLSTATE `22003`，未守門
 * 即成 500。本 predicate 即為寫入前的判定來源，測試以「超容量輸入 → 回
 * `true` 而非拋錯」之負向測試鎖定。
 *
 * `calculable=false`（非有限值守門已觸發）→ 回 `true`：非有限值無法存入任何
 * 數值欄位，語意上即「超出可儲存範圍」。此舉同時保證 T3 之不變式
 * 「`calculable=false ⇒ blockingCodes 至少一項`」（§7.5）在折舊四碼清單
 * （`YEAR_REQUIRED`／`DEPRECIATION_ATTACHMENT_REQUIRED`／
 * `PARAMETER_NOT_AVAILABLE`／`AMOUNT_OUT_OF_RANGE`）下可被滿足——折舊**沒有**
 * 對應「不可計算」的第五個碼，故不可比照 PHASE-006 之 predicate 於
 * `calculable=false` 時回 `false`（該 Phase 另有除零專屬碼）。
 */
export function isDepreciationCalculationOverCapacity(
  result: CalculateDepreciationResult
): boolean {
  if (!result.calculable || result.rawAmount === null || result.amount === null) {
    return true;
  }
  return (
    exceedsDecimalCapacity(
      result.officialKm,
      DEPRECIATION_COLUMN_CAPACITY.snapshotOfficialKm.bound
    ) ||
    exceedsDecimalCapacity(
      result.perKmUnitPrice,
      DEPRECIATION_COLUMN_CAPACITY.snapshotPerKmUnitPrice.bound
    ) ||
    exceedsDecimalCapacity(
      result.rawAmount,
      DEPRECIATION_COLUMN_CAPACITY.snapshotRawAmount.bound
    ) ||
    exceedsInt4Capacity(result.amount)
  );
}
