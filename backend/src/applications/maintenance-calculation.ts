/**
 * Maintenance allowance calculation engine — PHASE-006-T2
 *
 * Pure function, no DB, no IO, no side effects, no floating-point
 * intermediary. Spec §2（AC-06、AC-16、AC-17、AC-19）、§7.2
 * `MaintenanceComputedDto`、§9.2/9.3 計算虛擬碼、§16 D3（精度組）/D4(a)
 * （`ROUND_HALF_UP`、單一取整、禁浮點中介）/D10（容量守門）。
 *
 * 計算語意（逐字實作，不得自行優化順序 — Spec §2 AC-06/16/17）：
 *   intervalKm = currentOdometerKm − lastOdometerKm     （AC-06，未取整）
 *   ratio      = officialKm ÷ intervalKm                （AC-16，Decimal.div 全精度，未取整）
 *   ratioString / ratioPercentString                    （AC-16，對外顯示用固定小數字串；
 *                                                          僅供顯示與快照，**不參與**金額計算）
 *   rawAmount  = actualCost × officialKm ÷ intervalKm    （AC-17(a)，直接以此順序計算，
 *                                                          **不** 透過已取整之 ratio 相乘，
 *                                                          避免第二處取整 — 見 AC-17(d) kill case）
 *   amount     = ROUND_HALF_UP(rawAmount, 0)             （AC-17(b)/(c)，全案唯一一處取整）
 *
 * 防禦（AC-16）：`intervalKm ≤ 0`（含 0）在業務上不應發生（AC-08 已於上游
 * 完成度檢查擋下），但本函式仍獨立防禦——回傳 `calculable=false`，**絕不**
 * 除以零、**絕不**回傳 `NaN`/`Infinity`、**絕不**拋錯（純函式零 IO，錯誤語意
 * 由呼叫端決定，此處只回報狀態）。
 *
 * 本模組刻意「不做輸入驗證」（完成度驗證屬 T3 `maintenance-blockers.ts`；
 * 本引擎假設輸入已合法）。本模組刻意「不接線」（不新增 route、不碰 DB；
 * 接線屬 T7/T8）。容量 predicate（`isMaintenanceCalculationOverCapacity`）
 * 亦僅判定、不拋錯——由呼叫端（T3/T7/T8）決定如何轉換為 blocker code
 * `AMOUNT_OUT_OF_RANGE`／4xx 回應。
 *
 * 浮點中介聲明：本檔全程僅使用 `Prisma.Decimal`（decimal.js）的
 * `.minus()` / `.div()` / `.times()` / `.toDecimalPlaces()` / `.toFixed()`
 * 進行運算。`Decimal.toNumber()` 僅在下列一處使用，且發生於「已透過
 * `ROUND_HALF_UP` 取整為整數之後」：`rawAmount.toDecimalPlaces(0,
 * ROUND_HALF_UP).toNumber()`。全程無 `Number()`／`parseFloat`／`parseInt`／
 * 浮點算術參與金額或里程的計算過程。
 */

import { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CalculateMaintenanceInput {
  lastOdometerKm: Prisma.Decimal; // L，已通過驗證的有效值
  currentOdometerKm: Prisma.Decimal; // C，已通過驗證的有效值
  officialKm: Prisma.Decimal; // O（期間公務里程，`sumOfficialMileage` 之結果）
  actualCost: Prisma.Decimal; // P（實際保養費用）
}

export interface CalculateMaintenanceResult {
  intervalKm: Prisma.Decimal; // AC-06：C − L，未取整
  officialKm: Prisma.Decimal; // 原樣傳回（供容量 predicate 與快照使用，未取整）
  calculable: boolean; // false 僅當 intervalKm ≤ 0（AC-16 除零防禦）
  ratio: Prisma.Decimal | null; // AC-16：O ÷ I，全精度未取整；calculable=false 時為 null
  ratioString: string | null; // AC-16：固定 6 位小數字串（對外顯示／快照用）
  ratioPercentString: string | null; // AC-16：固定 4 位小數字串 ＝ ratio × 100
  rawAmount: Prisma.Decimal | null; // AC-17(a)：取整前金額；calculable=false 時為 null
  amount: number | null; // AC-17(b)：ROUND_HALF_UP(rawAmount, 0)；calculable=false 時為 null
}

// ---------------------------------------------------------------------------
// calculateMaintenance
// ---------------------------------------------------------------------------

/**
 * Compute maintenance-cost-sharing amounts for a single application.
 *
 * Pure function: no DB/IO/`Date.now()`/randomness; identical input yields
 * identical output; input `Prisma.Decimal` values are never mutated (all
 * arithmetic returns new `Decimal` instances).
 *
 * `intervalKm ≤ 0`（含剛好 0）→ `calculable=false`，其餘欄位為 `null`；
 * never throws, never returns `NaN`/`Infinity`.
 */
export function calculateMaintenance(input: CalculateMaintenanceInput): CalculateMaintenanceResult {
  const { lastOdometerKm, currentOdometerKm, officialKm, actualCost } = input;

  // AC-06: intervalKm = C − L（Decimal 減法，全程無浮點中介，不取整）。
  const intervalKm = currentOdometerKm.minus(lastOdometerKm);

  // AC-16 防禦：intervalKm ≤ 0 視為不可計算（AC-08 應已於上游擋下此輸入，
  // 此處為獨立第二道防線）——絕不除以零、絕不回 NaN/Infinity、絕不拋錯。
  if (!intervalKm.greaterThan(0)) {
    return {
      intervalKm,
      officialKm,
      calculable: false,
      ratio: null,
      ratioString: null,
      ratioPercentString: null,
      rawAmount: null,
      amount: null,
    };
  }

  // AC-16: 比例 = O ÷ I（Decimal.div，全精度，不預先取整）。此值僅供對外顯示
  // 字串與快照使用，**不**參與下方 rawAmount 的計算（見下方 AC-17(a) 註記）。
  const ratio = officialKm.div(intervalKm);
  const ratioString = ratio.toFixed(6, Prisma.Decimal.ROUND_HALF_UP);
  const ratioPercentString = ratio.times(100).toFixed(4, Prisma.Decimal.ROUND_HALF_UP);

  // AC-17(a): raw = P × O ÷ I —— 直接以 actualCost、officialKm、intervalKm
  // 三者計算，**不** 透過上面已存在的 `ratio` 變數相乘。若改為
  // `actualCost.times(ratio)`（`ratio` 為未取整之全精度值仍可接受，但一旦
  // `ratio` 先被取整為 6 位小數再相乘，即引入第二處取整，違反 AC-17(c)
  // 「全案取整恰一處」——AC-17(d) kill case 即專門鑑別此錯誤實作路徑）。
  const rawAmount = actualCost.times(officialKm).div(intervalKm);

  // AC-17(b)/(c): 全案唯一一處取整 —— ROUND_HALF_UP 至整數（新臺幣）。
  const amount = rawAmount.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();

  return {
    intervalKm,
    officialKm,
    calculable: true,
    ratio,
    ratioString,
    ratioPercentString,
    rawAmount,
    amount,
  };
}

// ---------------------------------------------------------------------------
// AC-19 — 容量 predicate（判定層；接線屬 T8）
//
// T1 即審 AR-6 義務：容量守門閾值由 schema 欄位精度推導，不得寫魔術數；
// `snapshotRatio Decimal(9,6)` 上界 <1000 亦須一併涵蓋（供 T7/T8 呼叫）。
// ---------------------------------------------------------------------------

/**
 * `MaintenanceApplication.snapshotIntervalKm` / `snapshotOfficialKm` 皆為
 * `Decimal(12,2)`（precision 12、scale 2 → 10 位整數）——上界
 * `|v| < 10^10`，由欄位精度推導（非魔術數）。
 */
const KM_CAPACITY_BOUND = new Prisma.Decimal("10000000000"); // 1e10 — Decimal(12,2)

/**
 * `MaintenanceApplication.snapshotRatio` 為 `Decimal(9,6)`（precision 9、
 * scale 6 → 3 位整數）——上界 `|v| < 10^3`。
 */
const RATIO_CAPACITY_BOUND = new Prisma.Decimal("1000"); // 1e3 — Decimal(9,6)

/**
 * `MaintenanceApplication.snapshotRawAmount` 為 `Decimal(14,4)`（precision 14、
 * scale 4 → 10 位整數）——上界 `|v| < 10^10`（與 `KM_CAPACITY_BOUND` 剛好同值，
 * 但欄位語意不同，故獨立命名）。
 */
const RAW_AMOUNT_CAPACITY_BOUND = new Prisma.Decimal("10000000000"); // 1e10 — Decimal(14,4)

/** Postgres `int4` 邊界（`Application.totalAmount`）。 */
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

function exceedsDecimalCapacity(value: Prisma.Decimal, bound: Prisma.Decimal): boolean {
  return value.abs().greaterThanOrEqualTo(bound);
}

function exceedsInt4Capacity(value: number): boolean {
  return !Number.isFinite(value) || value < INT4_MIN || value > INT4_MAX;
}

/**
 * AC-19 容量 predicate：`calculateMaintenance` 之輸出（區間里程、公務里程、
 * 比例、取整前金額、最終金額）任一項超出其目標資料庫欄位容量 → `true`。
 *
 * 純函式、零 IO、絕不拋錯——僅回報布林判定，由呼叫端（T3/T7/T8）決定如何
 * 轉換為 blocker code `AMOUNT_OUT_OF_RANGE`／4xx 回應，**絕不**在此處靜默
 * 截斷任何欄位值（`calculateMaintenance` 之回傳值本身完全未受此 predicate
 * 影響，即使超出容量，`rawAmount`/`amount` 仍是真實計算值）。
 *
 * `calculable=false`（除零防禦已觸發）時直接回 `false`——容量判定與「不可
 * 計算」是兩個獨立、互斥的失敗模式，呼叫端以不同 blocker code 分別回報。
 */
export function isMaintenanceCalculationOverCapacity(result: CalculateMaintenanceResult): boolean {
  if (!result.calculable) {
    return false;
  }
  return (
    exceedsDecimalCapacity(result.intervalKm, KM_CAPACITY_BOUND) ||
    exceedsDecimalCapacity(result.officialKm, KM_CAPACITY_BOUND) ||
    exceedsDecimalCapacity(result.ratio as Prisma.Decimal, RATIO_CAPACITY_BOUND) ||
    exceedsDecimalCapacity(result.rawAmount as Prisma.Decimal, RAW_AMOUNT_CAPACITY_BOUND) ||
    exceedsInt4Capacity(result.amount as number)
  );
}
