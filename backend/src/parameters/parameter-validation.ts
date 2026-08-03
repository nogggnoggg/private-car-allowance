/**
 * Parameter field validation — CHORE-003-T1
 *
 * PHASE-003a Spec §14（ACTIVE）：參數欄位容量、精度與字串保真之修訂後驗證合約。
 * 涵蓋 §14.2 之格式層（型別 → 十進位字面 → 小數位 → 欄位容量量級）與 §14.5
 * AC-21~AC-28、AC-32。CD 裁定（§13 修訂列，2026-08-03 人類 leonchih）：
 *   - CD-1(a)：字串前後空白 `.trim()` 後判定；全空白仍為 400。
 *   - CD-2(a)：只收標準十進位字面，指數記號／前導 `+`／`.5`／`19.`／`0x10`
 *     ／`Infinity`／`NaN` 一律拒絕。
 *   - CD-3(a)：折舊整數欄位（`usefulLifeYears`／`estimatedAnnualKm`）之 int4
 *     容量守門納入。
 *
 * Pure functions, zero IO —— 無 prisma client、無 env、無 DB／network／filesystem。
 * 與 `applications/trip-validation.ts` **同形但不共用**（§14.7 備註：PHASE-004
 * 領域回歸面過大，本回合不抽共用模組）。本檔為**葉節點模組**，不 import
 * `parameters` 內任何他檔，故 `parameter-service.ts` 與 `depreciation-engine.ts`
 * 皆可 import 而不形成循環依賴。
 *
 * 分層邊界（§14.2）：
 *   - 本模組＝**格式層**。回 400 `VALIDATION_ERROR` 之 `FieldError`。
 *   - **值域層**（`unitPrice ≥ 0`、`vehiclePrice > 0`、整數欄位 `> 0` 且為整數）
 *     維持在 `parameter-service.ts`，本回合語意不變（AC-03／AC-05／AC-30）。
 *     因此本模組**刻意放行**負值與 0——它們是格式合法、值域非法。
 *   - 「必填」缺值檢查（`undefined`／`null`／`""` → `單價為必填`）維持在
 *     `routes.ts`，本模組的 `null`／`undefined` 分支僅為最後守門。
 *
 * `Decimal` 建構規則（D4 bright-line）：一律以**字串**建構 `Prisma.Decimal`；
 * `number` 輸入以 `.toString()`（JS 自身最短往返轉換）進入同一管線，本層
 * 不引入任何新的浮點中介（AR-5）。
 */

import { Prisma } from "@prisma/client";
import type { FieldError } from "../platform/errors.js";

// ---------------------------------------------------------------------------
// 欄位容量常數（綁 `prisma/schema.prisma` 之欄位定義推導，不寫死魔術數）
// ---------------------------------------------------------------------------

/** 單一 `Decimal(precision, scale)` 欄位的容量描述。 */
export interface DecimalColumnCapacity {
  /** 小數位上限＝欄位 scale。 */
  readonly scale: number;
  /** 整數部分位數上限＝precision − scale；量級上限為 10^integerDigits（不含）。 */
  readonly integerDigits: number;
}

/**
 * 由 PostgreSQL `numeric(precision, scale)` 定義推導欄位容量。
 * 例：`Decimal(10, 4)` → scale 4、整數部分 6 位（量級 < 10^6）。
 */
export function decimalColumnCapacity(precision: number, scale: number): DecimalColumnCapacity {
  return { scale, integerDigits: precision - scale };
}

/** `FuelParameterVersion.unitPrice` / `EtcParameterVersion.unitPrice`：`Decimal @db.Decimal(10, 4)`。 */
export const UNIT_PRICE_CAPACITY: DecimalColumnCapacity = decimalColumnCapacity(10, 4);

/** `DepreciationParameterVersion.vehiclePrice`：`Decimal @db.Decimal(12, 2)`。 */
export const DEPRECIATION_VEHICLE_PRICE_CAPACITY: DecimalColumnCapacity = decimalColumnCapacity(
  12,
  2
);

/** PostgreSQL `integer`（int4）之上界；`usefulLifeYears`／`estimatedAnnualKm` 為 `Int`。 */
export const INT4_MAX = 2 ** 31 - 1; // 2147483647

/**
 * 嚴格十進位字面：可選前導 `-`、整數部至少一位、可選 `.` + 至少一位小數。
 *
 * CD-2(a)：**不接受**指數記號（`1e5`）、前導 `+`、缺整數部（`.5`）、缺小數部
 * （`19.`）、十六進位（`0x10`）、`Infinity`／`NaN`。後兩者尤為關鍵——
 * `new Prisma.Decimal("Infinity")` **不會拋錯**，且其 `.decimalPlaces()` 回傳
 * `NaN`（`NaN > scale` 為 `false`），故單靠小數位檢查**擋不住**，必須由本
 * pattern（與下方 `isFinite` 防呆）攔截，否則 §14.3 B-14 之 500 依舊存在。
 */
export const PARAMETER_DECIMAL_LITERAL_PATTERN = /^-?\d+(\.\d+)?$/;

// ---------------------------------------------------------------------------
// reason 文案（§14.2 文案表；zh-TW，面向使用者，不外洩內部細節）
// ---------------------------------------------------------------------------

const REASON_TYPE = "必須為有效的數值（字串或數字）";
const REASON_EMPTY = "必須為有效的數值";
const REASON_LITERAL = "必須為有效的十進位數值（不接受指數記號）";
const reasonScale = (scale: number) => `最多允許 ${scale} 位小數`;
const reasonMagnitude = (integerDigits: number) =>
  `數值超出可儲存範圍（整數部分最多 ${integerDigits} 位）`;
const REASON_INT_CAPACITY = `數值超出可儲存範圍（最大 ${INT4_MAX}）`;

// ---------------------------------------------------------------------------
// parseParameterDecimalField — 格式層四道守門（AC-21~27、AC-32）
// ---------------------------------------------------------------------------

export type ParseParameterDecimalFieldResult =
  | { ok: true; value: Prisma.Decimal }
  | { ok: false; error: FieldError };

/**
 * 解析參數金額欄位（`unitPrice`／`vehiclePrice`），依 §14.2 之**固定順序**
 * 逐道守門，先命中者決定 `reason`（AC-32 決定性要求）：
 *
 *   1. **型別**：非 string 亦非 number（boolean／array／object／null／undefined）
 *      → `必須為有效的數值（字串或數字）`（AC-26）。
 *   2. **字面**：字串先 `.trim()`（CD-1(a)）；trim 後為空 → `必須為有效的數值`
 *      （AC-27，廢止 `Number("   ") === 0` 之靜默寫入）；否則須符合
 *      `PARAMETER_DECIMAL_LITERAL_PATTERN`（AC-25）。`number` 以 `.toString()`
 *      進入同一 pattern，故 `NaN`／`Infinity`／`1e-7`／`1e21` 皆於此攔下。
 *   3. **小數位**：以 `Prisma.Decimal#decimalPlaces()`（**正規化後的值**，尾隨零
 *      已被剝除）與欄位 scale 比較——`"19.90000"` 報 1 而非 5，故通過；
 *      沿用 `parseKmField` 之同一決策（AC-23／AC-24）。
 *   4. **量級**：絕對值 ≥ 10^integerDigits → 拒絕，於進入 DB 前擋下原本會變成
 *      500 的欄位容量溢位（AC-21／AC-22）。
 *
 * **不做值域判定**：負值與 0 於此放行，由 `parameter-service.ts` 的既有值域層
 * （AC-03／AC-05）處理，語意不變（AC-30）。
 */
export function parseParameterDecimalField(
  value: unknown,
  field: string,
  capacity: DecimalColumnCapacity
): ParseParameterDecimalFieldResult {
  // 1. 型別
  let literal: string;
  if (typeof value === "number") {
    // number 路徑：以 JS 自身最短往返字串轉換進入同一管線（D4／AR-5）。
    // 非有限值（NaN／±Infinity）的 toString() 不符字面 pattern，於步驟 2 攔下。
    literal = value.toString();
  } else if (typeof value === "string") {
    // 2a. CD-1(a)：前後空白為傳輸層雜訊，trim 後值完全保真。
    literal = value.trim();
    if (literal.length === 0) {
      return { ok: false, error: { field, reason: REASON_EMPTY } };
    }
  } else {
    return { ok: false, error: { field, reason: REASON_TYPE } };
  }

  // 2b. 字面（CD-2(a)）
  if (!PARAMETER_DECIMAL_LITERAL_PATTERN.test(literal)) {
    return { ok: false, error: { field, reason: REASON_LITERAL } };
  }

  // D4 bright-line：一律以字串建構 Prisma.Decimal。
  let decimalValue: Prisma.Decimal;
  try {
    decimalValue = new Prisma.Decimal(literal);
  } catch {
    return { ok: false, error: { field, reason: REASON_LITERAL } };
  }

  // 防呆（縱深防禦）：pattern 已排除 Infinity／NaN，此處再以 isFinite 顯式確認。
  // 若日後有人放寬 pattern，這道守門可避免 §14.3 B-14 的 500 路徑復活——
  // 單靠下方的 decimalPlaces() 比較**無法**擋下它們（NaN > scale 為 false）。
  if (!decimalValue.isFinite()) {
    return { ok: false, error: { field, reason: REASON_LITERAL } };
  }

  // 3. 小數位（以正規化後的值判定，尾隨零不算精度）
  if (decimalValue.decimalPlaces() > capacity.scale) {
    return { ok: false, error: { field, reason: reasonScale(capacity.scale) } };
  }

  // 4. 欄位容量量級：|value| ≥ 10^integerDigits 無法儲存
  const magnitudeLimit = new Prisma.Decimal(`1${"0".repeat(capacity.integerDigits)}`);
  if (decimalValue.abs().greaterThanOrEqualTo(magnitudeLimit)) {
    return {
      ok: false,
      error: { field, reason: reasonMagnitude(capacity.integerDigits) },
    };
  }

  return { ok: true, value: decimalValue };
}

// ---------------------------------------------------------------------------
// parseParameterIntField — int4 容量守門（AC-28）
// ---------------------------------------------------------------------------

export type ParseParameterIntFieldResult =
  | { ok: true; value: number | null }
  | { ok: false; error: FieldError };

/**
 * 折舊整數欄位（`usefulLifeYears`／`estimatedAnnualKm`）之 **int4 容量**守門
 * （CD-3(a)／AC-28）。`≥ 2^31` 之整數（`2147483648`、`3e9`、`1e21` —— 三者
 * `Number.isInteger` 皆為 `true`，故現行值域檢查放行）在此被攔下，消滅其
 * 非 400 路徑。
 *
 * **刻意只做容量一件事**（AC-30 零回歸）：整數性與 `> 0` 之判定與文案
 * （`必須為整數且大於 0`／`必須大於 0`）為既有值域層，本回合不變，故：
 *   - 有限 number 且 ≤ `INT4_MAX` → `{ ok: true, value }`（原值原樣回傳，
 *     含 `2.5`／`0`／`-1` 這類**格式合法、值域非法**者，交既有值域層判定）。
 *   - 非 number 或非有限值（`"5"`／`null`／`true`／`NaN`／`Infinity`）→
 *     `{ ok: true, value: null }`，表示「容量守門不適用」，一律交既有值域層
 *     判定，其行為與文案完全不變。
 *
 * 下界（`< -2147483648`）不另設守門：負值必先被既有值域層以 `必須大於 0`
 * 擋為 400，永遠不會抵達 DB，無 500 之虞；此處若改以絕對值判定反而會改寫
 * 既有負值案例的 `reason`（超出本回合批准範圍）。
 */
export function parseParameterIntField(
  value: unknown,
  field: string
): ParseParameterIntFieldResult {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: true, value: null };
  }
  if (value > INT4_MAX) {
    return { ok: false, error: { field, reason: REASON_INT_CAPACITY } };
  }
  return { ok: true, value };
}
