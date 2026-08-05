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
 * 可重跑驗證（直擊實際建構子 Prisma.Decimal，而非其底層 decimal.js，
 * 確保驗證的是本專案實際使用的路徑）：
 *   node -e "const {Prisma}=require('@prisma/client'); console.log(new Prisma.Decimal(0.1).toString()===new Prisma.Decimal('0.1').toString())"
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

/**
 * PHASE-007-R4a（Spec §20.3 AC-49(a)）：每年折舊費用之推導輸入。
 * 修訂後模型不再需要 `estimatedAnnualKm`——每公里單價已退出申請路徑。
 */
export type AnnualDepreciationInput = {
  vehiclePrice: Prisma.Decimal | string | number;
  usefulLifeYears: number;
};

export type AnnualDepreciationResult = { ok: true; annualDepreciation: string } | { ok: false };

// ---------------------------------------------------------------------------
// 單一內部推導（AC-49(b)）
// ---------------------------------------------------------------------------

/**
 * 每年折舊費用之取整規模（Spec §20.3 AC-49(a) 逐字：2 位小數）。
 *
 * 以具名常數而非裸字面持有，使「2dp → 4dp」之取整規模 mutant 只有**單一
 * 施加點**，且該點同時支配 `toDecimalPlaces` 與定寬字串之 `toFixed`——
 * 若只改其中之一，輸出字串寬度不變而 mutant 不可觀測（假綠）。
 */
const ANNUAL_DEPRECIATION_SCALE = 2;

/**
 * `vehiclePrice ÷ usefulLifeYears` 之**唯一**實作（AC-49(b) 單一事實來源；
 * 禁止第二份拷貝——006 T5R SF-1 雙份漂移教訓，以原始碼結構性斷言守門）。
 *
 * 同時回傳「未取整的完整精度商」與「2dp 定寬字串」兩者：
 *  - `annualRaw` 供 `deriveDepreciation` 作為 `perKmUnitPrice` 之分子
 *    （既有 D3 選擇，行為凍結不得更動）；
 *  - `annualDepreciation` 為 `ROUND_HALF_UP(商, 2)` 之定寬字串。
 *
 * 值域保護沿既有 AC-14：`vehiclePrice ≤ 0`、`usefulLifeYears` 非有限值或 `≤ 0`
 * → `{ ok: false }`；`vehiclePrice` 不可解析為 Decimal 時捕捉例外後同樣回
 * `{ ok: false }`，絕不拋出。
 *
 * ※ 本函式**不**檢查 `vehiclePrice` 之有限性，以保持 `deriveDepreciation`
 *   行為逐位元凍結（AC-49(d)）；該檢查由 `deriveAnnualDepreciation` 於商的
 *   層級施加（見該函式說明）。
 */
function deriveAnnualCore(
  vehiclePrice: Prisma.Decimal | string | number,
  usefulLifeYears: number
): { ok: true; annualRaw: Prisma.Decimal; annualDepreciation: string } | { ok: false } {
  let price: Prisma.Decimal;
  try {
    price = new Prisma.Decimal(toDecimalConstructorArg(vehiclePrice));
  } catch {
    return { ok: false };
  }

  if (price.lte(0) || !Number.isFinite(usefulLifeYears) || usefulLifeYears <= 0) {
    return { ok: false };
  }

  // 保留完整精度的商（perKmUnitPrice 之分子；見 D3 說明）。
  const annualRaw = price.dividedBy(usefulLifeYears);

  // round_half_up to 2 decimal places (D3, CLAUDE.md: 一般四捨五入 0.5 進位)
  const annualDecimal = annualRaw.toDecimalPlaces(
    ANNUAL_DEPRECIATION_SCALE,
    Prisma.Decimal.ROUND_HALF_UP
  );

  return {
    ok: true,
    annualRaw,
    // 定寬字串（toFixed 保留尾零）
    annualDepreciation: annualDecimal.toFixed(ANNUAL_DEPRECIATION_SCALE),
  };
}

// ---------------------------------------------------------------------------
// deriveAnnualDepreciation（PHASE-007-R4a）
// ---------------------------------------------------------------------------

/**
 * Derive the annual depreciation expense from vehicle price and useful life.
 *
 * Spec §20.3 AC-49(a) 逐字：
 *   annualDepreciation = ROUND_HALF_UP(vehiclePrice ÷ usefulLifeYears, 2)
 * 與既有 `deriveDepreciation` 之 `annualDepreciation` 語意**完全一致**——
 * 兩者共用 `deriveAnnualCore` 這一份推導（AC-49(b)）。
 *
 * 回傳 `{ ok: false }` 當：
 *  - `vehiclePrice ≤ 0` 或不可解析為 Decimal；
 *  - `usefulLifeYears` 非有限值或 `≤ 0`；
 *  - `vehiclePrice` 為非有限值（`NaN`／`±Infinity`）——此時商亦非有限值，
 *    於商的層級一次擋下（沿 R2／R3 之同型守門：非有限值一律 `ok:false`，
 *    絕不外洩 `"NaN"`／`"Infinity"` 字面、絕不拋錯）。
 */
export function deriveAnnualDepreciation(input: AnnualDepreciationInput): AnnualDepreciationResult {
  const core = deriveAnnualCore(input.vehiclePrice, input.usefulLifeYears);
  if (!core.ok) return { ok: false };
  if (!core.annualRaw.isFinite()) return { ok: false };
  return { ok: true, annualDepreciation: core.annualDepreciation };
}

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
  const { estimatedAnnualKm } = input;

  // Validate integer constraints (D8: usefulLifeYears and estimatedAnnualKm must be integers)
  // Note: this check is in the engine as well (service layer also validates, belt-and-suspenders)
  // However, the engine only handles the ≤ 0 check per AC-14; integer check is service-layer only.
  // The engine's contract (AC-14) only specifies ≤ 0 → { ok: false }.

  // vehiclePrice 之 Decimal 轉換、vehiclePrice/usefulLifeYears 之 ≤0 值域保護，
  // 以及 annualDepreciation 之推導，一律委由共用內部推導（AC-49(b)）。
  // 行為與 003a 原實作逐位元相同（AC-49(d) 凍結）。
  const core = deriveAnnualCore(input.vehiclePrice, input.usefulLifeYears);
  if (!core.ok) return { ok: false };

  // Validate: estimatedAnnualKm must be > 0 (AC-14)
  if (!Number.isFinite(estimatedAnnualKm) || estimatedAnnualKm <= 0) {
    return { ok: false };
  }

  // Compute perKmUnitPrice using the UNROUNDED intermediate value (annualRaw) as numerator
  // to reduce accumulated rounding error (Spec §4.4, Task Packet note)
  const perKmRaw = core.annualRaw.dividedBy(estimatedAnnualKm);

  // round_half_up to 4 decimal places (D3)
  const perKmDecimal = perKmRaw.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);

  return {
    ok: true,
    // Fixed-width decimal strings (toFixed ensures trailing zeros are included)
    annualDepreciation: core.annualDepreciation,
    perKmUnitPrice: perKmDecimal.toFixed(4),
  };
}
