/**
 * Annual depreciation allowance calculation engine — PHASE-007-R2（折舊模型修訂段）
 *
 * Pure function: no DB, no IO, no `Date.now()`, no randomness, no side
 * effects, no floating-point intermediary. Spec `docs/specs/PHASE-007.md`
 * §20.4（修訂後計算語意，取代 §7.4）、§20.7.2（容量與精度之推導依據）、
 * §2 修訂段 AC-21／AC-22(判定層)／AC-50／AC-51。
 *
 * 計算語意（§20.4.1 ③④⑤⑥ 逐字實作，不得自行優化順序）：
 *   annualDepreciation = new Prisma.Decimal(derived.annualDepreciation)  ← 呼叫端還原
 *                        （`deriveAnnualDepreciation` 之 2 位小數字串；本模組直接收
 *                          `Prisma.Decimal`，**不得**經 `Number()`／`parseFloat`
 *                          還原 —— AC-51(a)）
 *   ratio              = officialKm.div(annualTotalKm)          // 全精度，僅供顯示與快照
 *   ratioString        = ratio.toFixed(6, ROUND_HALF_UP)        // 6 位小數（顯示）
 *   ratioPercentString = ratio.times(100).toFixed(4, ROUND_HALF_UP)  // 4 位小數（顯示）
 *   rawAmount          = annualDepreciation.times(officialKm).div(annualTotalKm)
 *                                                               // **先乘後除**，未取整
 *   amount             = rawAmount.toDecimalPlaces(0, ROUND_HALF_UP).toNumber()
 *                                                               // 全案唯一取整處
 *
 * §20.4.1「禁止」段逐字，本檔一律不得出現：
 *   ✗ 以 `annualDepreciation.times(ratio)` 求 `rawAmount`（引入第二次捨入；
 *     AC-50(c)。R2 已以窮舉搜尋證明其可差 1 元——kill case
 *     `10004.17 × 99995.00 ÷ 100041.7`：正確 `10000`，mutant `9999`）；
 *   ✗ 先取整 `ratio`（6dp／4dp 顯示字串**不回流計算**）；
 *   ✗ 先取整 `officialKm`；
 *   ✗ 先取整 `rawAmount` 至 2 位；
 *   ✗ 對 `annualDepreciation` 二次取整（其 2dp 取整已發生於參數推導引擎內部，
 *     §20.4.2 責任分界表）；
 *   ✗ 以浮點運算任一步。
 * 四者各有 kill case（`backend/test/unit/depreciation-calculation.test.ts` §2／§3）。
 *
 * AC-51(b)(d)「取整恰一處」之實作承諾：本檔全域僅有**一次**
 * `.toDecimalPlaces()` 呼叫（即最終金額，且為 `toDecimalPlaces(0, …)`），由測試
 * 以原始碼掃描機械守護；`.toFixed()` 恰兩次且**僅**用於 `ratio` 之顯示字串。
 *
 * AC-21 取整方向：一般四捨五入 `ROUND_HALF_UP`（0.5 進位、away from zero），
 * **非銀行家取整**（`ROUND_HALF_EVEN`）——CLAUDE.md 金額計算規則。
 *
 * 三重守門（AC-50(d)；005a T2 SF-1／006 T2R MF-1 同型）：
 *   ① 三個輸入各以 `.isFinite()` 守門（`NaN` 與 `±Infinity` 皆回 false）；
 *   ② `annualTotalKm ≤ 0` 之除零守門（**先**經 ① 排除 `NaN` 後才做比較——
 *      `Prisma.Decimal` 與 `NaN` 的任何比較恆為 `false`，若把比較式當成唯一守門
 *      就會靜默穿透，那正是 005a SF-1 的根因）；
 *   ③ 計算所得之 `ratio` 與 `rawAmount` 本身仍須為有限值（獨立第三道防線）。
 * 任一守門觸發 → `calculable=false`，且 `ratio`／`ratioString`／
 * `ratioPercentString`／`rawAmount`／`amount` **一律 `null`**——**絕不**回傳
 * `NaN`／`Infinity` 金額、**絕不**靜默回傳看似合法的 `0`、**絕不**拋錯（純函式
 * 零 IO，錯誤語意由呼叫端決定，此處只回報狀態）。
 *
 * 本模組刻意「不做完成度驗證」（屬 `depreciation-blockers.ts`）、刻意「不接線」
 * （不新增 route、不碰 DB）、刻意「不對輸入做業務值域驗證」（年度與里程值域屬
 * 驗證層）。特別注意：**比例 > 100% 之守門不在本檔**——`officialKm > annualTotalKm`
 * 屬 blocker `OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM`（AC-52），本檔對該情形仍忠實
 * 計算（比例 > 1、金額 > 每年折舊費用），由呼叫端擋下。容量 predicate
 * （`isDepreciationCalculationOverCapacity`）亦僅判定、不拋錯、不截斷。
 *
 * 浮點中介聲明：本檔全程僅使用 `Prisma.Decimal`（decimal.js）的 `.times()`
 * ／`.div()`／`.pow()`／`.abs()`／`.toDecimalPlaces()`／`.toFixed()`
 * ／`.isFinite()`／`.greaterThan()`／`.greaterThanOrEqualTo()` 進行運算。
 * `Decimal.toNumber()` 全檔僅在**一處**使用：最終金額，且發生於 `ROUND_HALF_UP`
 * 取整為整數**之後**（int4 容量常數之上下界由 `2 ** 31` 之整數冪直接得出，
 * 未經 `Decimal`，故不需降轉）。全程無 `Number()`／`parseFloat`／`parseInt`
 * ／浮點算術參與金額、比例或里程的計算過程（由測試 §8 之清單驅動掃描機械守護）。
 */

import { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CalculateDepreciationInput {
  /**
   * 每年折舊費用（`deriveAnnualDepreciation` 之 2 位小數字串還原而得；
   * §20.4.1 ③）。本模組**不得**對其再次取整（AC-51(b)）。
   */
  annualDepreciation: Prisma.Decimal;
  /** 年度公務里程（`sumOfficialMileage` 之 `totalKm`；AC-13：`applicationCount` 絕不進入計算）。 */
  officialKm: Prisma.Decimal;
  /** 該車年度總里程（使用者申報之申請資料；AC-47／AC-48）。 */
  annualTotalKm: Prisma.Decimal;
}

export interface CalculateDepreciationResult {
  /** 原樣傳回（未再次取整——AC-51(b)；供容量 predicate 與快照使用）。 */
  annualDepreciation: Prisma.Decimal;
  /** 原樣傳回（未取整）。 */
  officialKm: Prisma.Decimal;
  /** 原樣傳回（未取整）。 */
  annualTotalKm: Prisma.Decimal;
  /** `false` 當任一輸入非有限值、`annualTotalKm ≤ 0`，或計算結果非有限值。 */
  calculable: boolean;
  /** AC-50(a)：公務比例，**全精度未取整**；`calculable=false` 時為 `null`。 */
  ratio: Prisma.Decimal | null;
  /** AC-50(b)：比例之 6 位小數顯示字串（**不回流計算**）；不可計算時 `null`。 */
  ratioString: string | null;
  /** AC-50(b)：比例百分比之 4 位小數顯示字串（**不回流計算**）；不可計算時 `null`。 */
  ratioPercentString: string | null;
  /** AC-51(a)：取整前補貼金額（先乘後除）；`calculable=false` 時為 `null`。 */
  rawAmount: Prisma.Decimal | null;
  /** AC-21／AC-51(a)：`ROUND_HALF_UP(rawAmount, 0)`；`calculable=false` 時為 `null`。 */
  amount: number | null;
}

// ---------------------------------------------------------------------------
// 顯示精度常數（§20.4.1 ④ 逐字；比照 `MaintenanceApplication` 之既有精度組）
// ---------------------------------------------------------------------------

/** `ratio` 之顯示位數（6 位小數；對應 `snapshotRatio Decimal(9,6)`）。 */
const RATIO_DISPLAY_SCALE = 6;

/** `ratioPercent` 之顯示位數（4 位小數；比照保養之 `ratioPercentString`）。 */
const RATIO_PERCENT_DISPLAY_SCALE = 4;

/** 百分比乘數。`Prisma.Decimal` 建構一律以字串字面（D4 bright-line）。 */
const PERCENT_MULTIPLIER = new Prisma.Decimal("100");

// ---------------------------------------------------------------------------
// calculateDepreciation
// ---------------------------------------------------------------------------

/**
 * `calculable=false` 之回傳形狀：三個輸入原樣回傳，其餘欄位一律 `null`
 * （§20.4.1 除零守門逐字：「`calculable=false`，其餘欄位 `null`」）。
 */
function notCalculable(input: CalculateDepreciationInput): CalculateDepreciationResult {
  return {
    annualDepreciation: input.annualDepreciation,
    officialKm: input.officialKm,
    annualTotalKm: input.annualTotalKm,
    calculable: false,
    ratio: null,
    ratioString: null,
    ratioPercentString: null,
    rawAmount: null,
    amount: null,
  };
}

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
  const { annualDepreciation, officialKm, annualTotalKm } = input;

  // 守門 ①（AC-50(d)）：三個輸入本身須為有限值。`.isFinite()` 對 `NaN` 與
  // `±Infinity` 皆回 false。**必須先於守門 ②**——見檔頭說明。
  if (!annualDepreciation.isFinite() || !officialKm.isFinite() || !annualTotalKm.isFinite()) {
    return notCalculable(input);
  }

  // 守門 ②（AC-50(d) 除零）：`annualTotalKm ≤ 0` → 不可計算。此時 `annualTotalKm`
  // 已確定為有限值，比較式安全。
  if (!annualTotalKm.greaterThan(0)) {
    return notCalculable(input);
  }

  // §20.4.1 ④：公務比例（全精度，**僅供顯示與快照**，絕不參與金額計算）。
  const ratio = officialKm.div(annualTotalKm);

  // §20.4.1 ⑤：rawAmount = 每年折舊費用 × 年度公務里程 ÷ 年度總里程。
  // **先乘後除**（不得寫成 `annualDepreciation.times(ratio)`——AC-50(c)）；未取整。
  const rawAmount = annualDepreciation.times(officialKm).div(annualTotalKm);

  // 守門 ③：計算結果本身仍須為有限值（獨立第三道防線，確保未來若守門 ①②
  // 被改動，`NaN`／`Infinity` 仍不會穿透到 `amount`）。
  if (!ratio.isFinite() || !rawAmount.isFinite()) {
    return notCalculable(input);
  }

  // §20.4.1 ⑥：全案唯一一處取整 —— ROUND_HALF_UP 至整數（新臺幣）。
  const amount = rawAmount.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();

  return {
    annualDepreciation,
    officialKm,
    annualTotalKm,
    calculable: true,
    ratio,
    ratioString: ratio.toFixed(RATIO_DISPLAY_SCALE, Prisma.Decimal.ROUND_HALF_UP),
    ratioPercentString: ratio
      .times(PERCENT_MULTIPLIER)
      .toFixed(RATIO_PERCENT_DISPLAY_SCALE, Prisma.Decimal.ROUND_HALF_UP),
    rawAmount,
    amount,
  };
}

// ---------------------------------------------------------------------------
// AC-22(a) — 容量 predicate（判定層；接線屬 blockers／service）
//
// T1 即審 FW-1 義務：容量閾值一律由**欄位精度**推導，不得寫魔術數，且常數
// 之 `precision`／`scale` 須能與**實際套用之 migration DDL** 逐值比對
// （對照測試見 `depreciation-calculation.test.ts` §7；新 4 欄之 DDL 位於
// M2 ALTER 型 migration，既有欄位位於 M1 建表 migration）。
// ---------------------------------------------------------------------------

/** 十進位基數。`Prisma.Decimal` 建構一律以字串字面（D4 bright-line）。 */
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
 * 折舊各欄位之容量規格 —— **值一律取自 §20.7.1／M1＋M2 migration DDL，零魔術數**。
 *
 * 匯出供測試以 migration SQL 逐欄對照（T1 即審 FW-1），亦供呼叫端在需要時引用
 * 同一組常數，避免第二份心智模型。
 *
 * §20.7.2 之判定集合（六項）：`snapshotAnnualDepreciation`、`snapshotOfficialKm`、
 * `snapshotAnnualTotalKm`、`snapshotRatio`、`snapshotRawAmount`、`totalAmount`。
 * `snapshotPerKmUnitPrice` 為**凍結唯讀**之舊模型欄（新模型不寫入），其常數
 * **保留**（舊模型列之 DDL 形狀仍須可被對照守護），但**已退出判定集合**。
 */
export const DEPRECIATION_COLUMN_CAPACITY = {
  /** `DepreciationApplication.snapshotAnnualDepreciation` — `DECIMAL(12,2)` → `|v| < 1e10`（§20.7.2）。 */
  snapshotAnnualDepreciation: {
    precision: 12,
    scale: 2,
    bound: decimalCapacityBound(12, 2),
  },
  /** `DepreciationApplication.snapshotOfficialKm` — `DECIMAL(12,2)` → `|v| < 1e10`。 */
  snapshotOfficialKm: {
    precision: 12,
    scale: 2,
    bound: decimalCapacityBound(12, 2),
  },
  /** `DepreciationApplication.snapshotAnnualTotalKm` — `DECIMAL(9,1)` → `|v| < 1e8`（§20.7.2）。 */
  snapshotAnnualTotalKm: {
    precision: 9,
    scale: 1,
    bound: decimalCapacityBound(9, 1),
  },
  /** `DepreciationApplication.snapshotRatio` — `DECIMAL(9,6)` → `|v| < 1e3`（比照保養）。 */
  snapshotRatio: {
    precision: 9,
    scale: 6,
    bound: decimalCapacityBound(9, 6),
  },
  /** `DepreciationApplication.snapshotRawAmount` — `DECIMAL(14,4)` → `|v| < 1e10`。 */
  snapshotRawAmount: {
    precision: 14,
    scale: 4,
    bound: decimalCapacityBound(14, 4),
  },
  /**
   * `DepreciationApplication.snapshotPerKmUnitPrice` — `DECIMAL(14,4)` → `|v| < 1e10`。
   * **凍結唯讀**（舊模型欄，新模型不寫入）：常數保留供 DDL 對照，**不參與**
   * `isDepreciationCalculationOverCapacity` 之判定（§20.7.2）。
   */
  snapshotPerKmUnitPrice: {
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
 * AC-22(a) 容量 predicate：`calculateDepreciation` 之輸出（每年折舊費用、年度
 * 公務里程、年度總里程、公務比例、取整前金額、最終金額）任一項超出其目標資料庫
 * 欄位容量 → `true`。判定集合逐字依 §20.7.2。
 *
 * 純函式、零 IO、**絕不拋錯**——僅回報布林判定，由呼叫端決定如何轉換為 blocker
 * code `AMOUNT_OUT_OF_RANGE`／4xx 回應（AC-22(b)(c)）。**絕不**在此處靜默截斷
 * 任何欄位值：`calculateDepreciation` 的回傳值完全不受本 predicate 影響。
 *
 * T1 即審 FW-2：`Decimal(p,s)` 溢位於 Postgres 為 SQLSTATE `22003`，未守門即成
 * 500。本 predicate 即為寫入前的判定來源。
 *
 * `calculable=false`（守門已觸發）→ 回 `true`：不可計算之結果無法存入任何數值
 * 欄位，語意上即「超出可儲存範圍」。此舉同時保證呼叫端之不變式
 * 「`calculable=false ⇒ blockingCodes 至少一項`」在折舊之 blocker 清單下可被滿足。
 *
 * ※ §20.7.2 明示：新公式下 `snapshotRawAmount` 之溢位不再可達（比例 >100% 已由
 *   AC-52 擋下），但 **`amount` 仍可超 `int4`**（車價 ≥ 2.15e9 且比例接近 1 時），
 *   故本守門與其測試**一律保留**。
 */
export function isDepreciationCalculationOverCapacity(
  result: CalculateDepreciationResult
): boolean {
  if (
    !result.calculable ||
    result.ratio === null ||
    result.rawAmount === null ||
    result.amount === null
  ) {
    return true;
  }
  return (
    exceedsDecimalCapacity(
      result.annualDepreciation,
      DEPRECIATION_COLUMN_CAPACITY.snapshotAnnualDepreciation.bound
    ) ||
    exceedsDecimalCapacity(
      result.officialKm,
      DEPRECIATION_COLUMN_CAPACITY.snapshotOfficialKm.bound
    ) ||
    exceedsDecimalCapacity(
      result.annualTotalKm,
      DEPRECIATION_COLUMN_CAPACITY.snapshotAnnualTotalKm.bound
    ) ||
    exceedsDecimalCapacity(result.ratio, DEPRECIATION_COLUMN_CAPACITY.snapshotRatio.bound) ||
    exceedsDecimalCapacity(
      result.rawAmount,
      DEPRECIATION_COLUMN_CAPACITY.snapshotRawAmount.bound
    ) ||
    exceedsInt4Capacity(result.amount)
  );
}
