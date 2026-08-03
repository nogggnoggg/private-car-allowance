/**
 * Depreciation derivation engine — PHASE-003a-T4
 *
 * Pure function, no DB dependency.
 * Spec §2 AC-12/13/14, §4.4 D3 (精度定案，已批准), §8.1
 *
 * D3 精度定案（人類 2026-08-01 批准）:
 *   - annualDepreciation = round_half_up(vehiclePrice / usefulLifeYears, 2 位小數)
 *   - perKmUnitPrice = round_half_up(vehiclePrice / usefulLifeYears / estimatedAnnualKm, 4 位小數)
 *     ※ perKmUnitPrice 的分子使用「未先取整的每年費用」（即 vehiclePrice / usefulLifeYears 的完整精度），
 *       以減少累積誤差（見下方 perKmUnitPrice 計算說明）。
 *   - 取整方向：一般四捨五入 0.5 進位（round half up，away from zero），非銀行家取整（非 half-even）。
 *   - 使用 Prisma Decimal（decimal.js），不用浮點運算。
 *   - 回傳為固定位數字串：annualDepreciation 2 位、perKmUnitPrice 4 位。
 *
 * perKmUnitPrice 分子取整選擇（待 reviewer 確認點）:
 *   本實作採「以未先取整到 2 位的每年費用」為 perKmUnitPrice 的分子，
 *   即：raw = vehiclePrice / usefulLifeYears（保留完整 Decimal 精度）；
 *       perKmUnitPrice = round_half_up(raw / estimatedAnnualKm, 4)。
 *   理由：減少累積取整誤差；Spec §4.4 建議「顯示層各自取整」而非強制先取整再除。
 *   差異案例：vehiclePrice=10, years=3, km=3
 *     - 未取整分子：10/3/3 = 1.1111... → 1.1111
 *     - 已取整分子：round(10/3,2)=3.33; 3.33/3=1.11 → 1.1100（差異）
 *   此選擇影響 PHASE-007 最終補貼金額精度，故標記為待 reviewer 確認點。
 *
 * 值域保護（AC-14）:
 *   三值（vehiclePrice / usefulLifeYears / estimatedAnnualKm）任一 ≤ 0 → 回 { ok: false }
 *   不拋未捕捉例外、不回 NaN/Infinity（避免除以 0）。
 */

import { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// D4 bright-line: number → Decimal-safe constructor arg
// ---------------------------------------------------------------------------

/**
 * Prepares the `new Prisma.Decimal(...)` constructor argument for
 * `input.vehiclePrice`, closing the "number 變數建構" D4 gap (Spec D8:
 * 一律非浮點) — mirrors `toDecimalConstructorArg` in parameter-service.ts.
 *
 * - `Prisma.Decimal` instance / string: passed through unchanged — no float
 *   mediation occurs for either.
 * - number: converted via `String(value)` rather than handed directly to the
 *   constructor.
 *
 * 本版 decimal.js 的建構子對 number 引數內部已先做 toString() 才解析，
 * 因此 `new Decimal(value)` 與 `new Decimal(String(value))` 對所有 number
 * 皆為恆等變換（含科學記號輸入 —— decimal.js 完整支援解析 "1e+21" 這類
 * 字面值）。此函式仍保留「一律先字串化」這一步，不是為了修正當前版本的
 * 行為差異（沒有差異），而是讓 D4 bright-line（一律非浮點）不依賴這個
 * 實作細節本身 —— 未來若更換十進位運算函式庫或升版、且新版建構子改為
 * 直接讀取 number 的二進位值，這裡的轉換仍會保護既有行為不變。
 *
 * 可重跑驗證（本版 decimal.js 對 number 與 String(number) 恆等）：
 *   node -e "const {Decimal}=require('decimal.js'); const v=0.1; console.log(new Decimal(v).toString()===new Decimal(String(v)).toString())"
 *   → true
 *
 * 同形雙拷貝說明（AR-1）：此 helper 與 parameter-service.ts 的
 * toDecimalConstructorArg 邏輯相同但各自持有一份，理由是 import 環——
 * parameter-service.ts 已 import 本檔（depreciation-engine.ts）的
 * deriveDepreciation，若本檔反向 import parameter-service.ts 的共用邏輯會
 * 形成循環依賴。修改任一份的轉換邏輯時，須同步檢查並修改另一份。
 */
function toDecimalConstructorArg(value: Prisma.Decimal | string | number): Prisma.Decimal | string {
  if (typeof value !== "number") return value;
  return String(value);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DepreciationInput = {
  vehiclePrice: Prisma.Decimal | string | number;
  usefulLifeYears: number;
  estimatedAnnualKm: number;
};

export type DepreciationResult =
  | { ok: true; annualDepreciation: string; perKmUnitPrice: string }
  | { ok: false };

// ---------------------------------------------------------------------------
// deriveDepreciation
// ---------------------------------------------------------------------------

/**
 * Derive annual depreciation and per-km unit price from depreciation parameters.
 *
 * Calculation (D3, approved 2026-08-01):
 *   annualDepreciation = round_half_up(vehiclePrice / usefulLifeYears, 2)
 *   perKmUnitPrice     = round_half_up(vehiclePrice / usefulLifeYears / estimatedAnnualKm, 4)
 *   (perKmUnitPrice uses the unrounded intermediate value to minimise accumulated error)
 *
 * Returns { ok: false } if any input is ≤ 0 (AC-14, AC-05).
 */
export function deriveDepreciation(input: DepreciationInput): DepreciationResult {
  const { usefulLifeYears, estimatedAnnualKm } = input;

  // Validate integer constraints (D8: usefulLifeYears and estimatedAnnualKm must be integers)
  // Note: this check is in the engine as well (service layer also validates, belt-and-suspenders)
  // However, the engine only handles the ≤ 0 check per AC-14; integer check is service-layer only.
  // The engine's contract (AC-14) only specifies ≤ 0 → { ok: false }.

  // Convert vehiclePrice to Decimal
  let price: Prisma.Decimal;
  try {
    price = new Prisma.Decimal(toDecimalConstructorArg(input.vehiclePrice));
  } catch {
    return { ok: false };
  }

  // Validate: all three values must be > 0 (AC-14)
  if (
    price.lte(0) ||
    !Number.isFinite(usefulLifeYears) ||
    usefulLifeYears <= 0 ||
    !Number.isFinite(estimatedAnnualKm) ||
    estimatedAnnualKm <= 0
  ) {
    return { ok: false };
  }

  // Compute annualDepreciation = vehiclePrice / usefulLifeYears
  // Keep full precision for the intermediate value (used as numerator for perKmUnitPrice)
  const annualRaw = price.dividedBy(usefulLifeYears);

  // round_half_up to 2 decimal places (D3, CLAUDE.md: 一般四捨五入 0.5 進位)
  const annualDecimal = annualRaw.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

  // Compute perKmUnitPrice using the UNROUNDED intermediate value (annualRaw) as numerator
  // to reduce accumulated rounding error (Spec §4.4, Task Packet note)
  const perKmRaw = annualRaw.dividedBy(estimatedAnnualKm);

  // round_half_up to 4 decimal places (D3)
  const perKmDecimal = perKmRaw.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);

  return {
    ok: true,
    // Fixed-width decimal strings (toFixed ensures trailing zeros are included)
    annualDepreciation: annualDecimal.toFixed(2),
    perKmUnitPrice: perKmDecimal.toFixed(4),
  };
}
