/**
 * PHASE-007-T2 — `calculateDepreciation` ＋ `isDepreciationCalculationOverCapacity`
 * （AC-19／AC-20／AC-21／AC-22(判定層)）
 *
 * Spec `docs/specs/PHASE-007.md`：
 *   AC-19（§2 F）逐字：「`rawAmount = 年度公務里程 × perKmUnitPrice`；
 *     `amount = ROUND_HALF_UP(rawAmount, 0)`（新臺幣整數）。**全程
 *     `Prisma.Decimal`，禁止任何浮點中介**；`perKmUnitPrice` 以
 *     `new Prisma.Decimal(字串)` 還原（`deriveDepreciation` 回傳固定 4 位小數
 *     字串），**不得**經 `Number()`／`parseFloat`。」
 *   AC-20 逐字：「本 Phase 之取整**恰一處**（最終金額）。單價之 4 位小數取整
 *     發生在 **PHASE-003a 引擎內**，本 Phase **不得**再對單價取整、**不得**先
 *     取整年度里程、**不得**先取整 `rawAmount` 至 2 位小數再取整。」
 *   AC-21 逐字：「取整方向為**一般四捨五入（`ROUND_HALF_UP`，0.5 進位、
 *     away from zero），非銀行家取整**：kill pair `rawAmount=0.5 → 1` 與
 *     `rawAmount=1.5 → 2`（`ROUND_HALF_EVEN` mutant 於後者必紅）…」
 *     ※ Spec 括號內「於後者必紅」與同句 kill pair 之實際鑑別方向相反——
 *       `ROUND_HALF_EVEN` 對 `1.5` 亦得 `2`（不鑑別），對 `0.5` 得 `0`（鑑別）。
 *       本檔兩列皆在場，鑑別實際發生於**前者**（`0.5 → 1`）。差異已於 Handoff
 *       Warnings 回報（006 §2 AC-17(d) 之同型敘述亦同）。
 *   AC-22(a) 逐字：「純函式層之容量 predicate 回 `true`，**閾值由 schema 精度
 *     推導之具名常數**（**不得寫魔術數**，006 T1 AR-6 教訓）」；
 *   AC-22(d) 逐字：「邊界正例在場防誤殺（恰 `1e10 − ε` 通過／恰 `1e10` 拒絕；
 *     `2147483647` 通過／`2147483648` 拒絕）」。
 *   §7.4 ③④⑤ 計算三步；§8.3 容量推導表；§11.1 單元測試重點列。
 *
 * ---------------------------------------------------------------------------
 * 鑑別力設計（Done When 硬性項）
 * ---------------------------------------------------------------------------
 * 1. 取整 kill pair（AC-21）：`raw=0.5 → 1`（`ROUND_HALF_EVEN` mutant 得 `0`，
 *    必紅）與 `raw=1.5 → 2`（`ROUND_HALF_EVEN` 亦得 `2`，成對出現以證明兩列
 *    合起來才鑑別「away from zero」而非「一律進位」）。
 * 2. 取整層級 kill case（AC-20，本 Task 窮舉搜尋產生 —— Spec §17.1／AC-20 已
 *    自註原例 `officialKm=1234.56, perKmUnitPrice="0.5001"` **不具鑑別力**）：
 *      **主 kill case（單一數對同時殺兩種 mutant）**
 *        officialKm = 850.27（`Decimal(12,2)` 合法值）
 *        perKmUnitPrice = "6.6667"（＝ `deriveDepreciation({vehiclePrice:300000,
 *          usefulLifeYears:3, estimatedAnnualKm:15000}).perKmUnitPrice`，真實可達）
 *        rawAmount = 5668.495009  → 正確 amount = 5668
 *        mutant A（先取整 rawAmount 至 2 位 → 5668.50）→ 5669  ✗
 *        mutant B（先取整 officialKm 至整數 → 850）        → 5667  ✗
 *      **輔助 kill case（終止小數，raw 精確可讀）**
 *        officialKm = 1137.50、perKmUnitPrice = "5.5556"
 *          （＝ 300000 / 3 / 18000 之引擎輸出）
 *        rawAmount = 6319.495（精確）→ 正確 6319；mutant A → 6320；mutant B → 6322
 *      Spec 原例仍以獨立一列保留，用於證明其**只**殺 mutant B（617 vs 618）
 *      而對 mutant A 不鑑別（617 vs 617）——即 Spec §17.1 自註之複核。
 * 3. `ROUND_HALF_EVEN` mutant：見第 1 點。
 * 4. `NaN`／`Infinity` 三重守門（005a T2 SF-1／006 T2R MF-1 同型）：
 *    `officialKm`／`perKmUnitPrice`／相乘後之 `rawAmount` 三處各有負向測試。
 *
 * ---------------------------------------------------------------------------
 * Mutant 自證（實際執行紀錄見 Handoff）
 * ---------------------------------------------------------------------------
 *   M1 `ROUND_HALF_UP` → `ROUND_HALF_EVEN`（金額取整處）
 *   M2 `rawAmount` 改為 `officialKm.times(price).toDecimalPlaces(2, ROUND_HALF_UP)`
 *   M3 `rawAmount` 改為 `officialKm.toDecimalPlaces(0, ROUND_HALF_UP).times(price)`
 *   M4 三重 isFinite 守門整段刪除
 *   M5 容量常數 `DEPRECIATION_COLUMN_CAPACITY.snapshotRawAmount` 之
 *      `precision` 14 → 16（且 bound 同步改為 10^12；模擬常數與
 *      實際 DB 欄位精度脫鉤 —— T1 即審 FW-1 之直接對象）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  type CalculateDepreciationResult,
  DEPRECIATION_COLUMN_CAPACITY,
  calculateDepreciation,
  isDepreciationCalculationOverCapacity,
} from "../../src/applications/depreciation-calculation.js";
import { deriveDepreciation } from "../../src/parameters/depreciation-engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

/**
 * PHASE_007_SRC_FILES — 沿 PHASE-005a `PHASE_005A_SRC_FILES`／PHASE-006
 * `PHASE_006_SRC_FILES` 慣例建立之獨立清單（本 Phase 專用）。
 *
 * **白名單語意（逐字）**：本陣列列出「本 Phase 於 `backend/src` 新增之全部
 * 檔案」，供下方零浮點中介掃描逐檔驅動。**T3/T4/T5/T7/T8/T11 等後續 Task 於
 * 本 Phase 新增 `src` 檔案時，必須將其相對路徑（相對於 `backend/`）加入本
 * 陣列**，否則新檔案不會被掃描覆蓋。清單中任何檔案不存在時，
 * `fs.readFileSync` 會直接拋錯使測試紅（fail-loud），不得靜默跳過。
 */
const PHASE_007_SRC_FILES = [
  "src/applications/depreciation-calculation.ts",
  // T3 新增（PHASE-007-T3；T2 即審 FW-7 之機械義務）。
  "src/applications/depreciation-blockers.ts",
] as const;

const ENGINE_SRC_PATH = path.resolve(BACKEND_ROOT, PHASE_007_SRC_FILES[0]);

/** T1 之 migration DDL —— 容量常數對照測試（FW-1）之權威來源。 */
const PHASE7_MIGRATION_SQL_PATH = path.resolve(
  BACKEND_ROOT,
  "prisma/migrations/20260804120000_phase7_depreciation_model/migration.sql"
);

/** `Application.totalAmount`（int4）之 DDL 來源（PHASE-004 建表 migration）。 */
const PHASE4_MIGRATION_SQL_PATH = path.resolve(
  BACKEND_ROOT,
  "prisma/migrations/20260801181153_phase4_application_models/migration.sql"
);

const SCHEMA_PRISMA_PATH = path.resolve(BACKEND_ROOT, "prisma/schema.prisma");

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

// ---------------------------------------------------------------------------
// §1 AC-19 公式：rawAmount = officialKm × perKmUnitPrice（未取整），
//                amount = ROUND_HALF_UP(rawAmount, 0)
// ---------------------------------------------------------------------------

describe("calculateDepreciation — AC-19 rawAmount = officialKm × perKmUnitPrice, amount = ROUND_HALF_UP(raw, 0) (exact Decimal table)", () => {
  const rows: Array<{
    officialKm: string;
    perKmUnitPrice: string;
    rawAmount: string;
    amount: number;
    note: string;
  }> = [
    {
      officialKm: "0.00",
      perKmUnitPrice: "6.6667",
      rawAmount: "0",
      amount: 0,
      note: "B-09：年度里程 0 為合法結果，補貼 0 元（Spec §1.2 明確不阻擋）",
    },
    {
      officialKm: "12000.00",
      perKmUnitPrice: "6.6667",
      rawAmount: "80000.4",
      amount: 80000,
      note: "一般案例：小數部分 < 0.5 → 捨",
    },
    {
      officialKm: "12345.67",
      perKmUnitPrice: "1.0000",
      rawAmount: "12345.67",
      amount: 12346,
      note: "單價 1.0000：金額即里程之四捨五入",
    },
    {
      officialKm: "0.01",
      perKmUnitPrice: "0.0001",
      rawAmount: "0.000001",
      amount: 0,
      note: "邊界：兩欄位各自之最小正值，全精度保留於 rawAmount",
    },
    {
      officialKm: "20000.00",
      perKmUnitPrice: "0.0001",
      rawAmount: "2",
      amount: 2,
      note: "§17.1 #7 誤差上界之量級（2 萬公里 × 0.0001 = 2 元）",
    },
  ];

  it.each(rows)(
    "officialKm=$officialKm × perKmUnitPrice=$perKmUnitPrice → rawAmount=$rawAmount, amount=$amount ($note)",
    ({ officialKm, perKmUnitPrice, rawAmount, amount }) => {
      const result = calculateDepreciation({
        officialKm: d(officialKm),
        perKmUnitPrice: d(perKmUnitPrice),
      });
      expect(result.calculable).toBe(true);
      expect(result.rawAmount?.toString()).toBe(rawAmount);
      expect(result.amount).toBe(amount);
      // 輸入原樣回傳（供快照與容量 predicate 使用，未取整）
      expect(result.officialKm.toString()).toBe(new Prisma.Decimal(officialKm).toString());
      expect(result.perKmUnitPrice.toString()).toBe(new Prisma.Decimal(perKmUnitPrice).toString());
    }
  );

  it("AC-19 the function is pure: identical input yields identical output and never mutates the input Decimals", () => {
    const officialKm = d("850.27");
    const perKmUnitPrice = d("6.6667");
    const first = calculateDepreciation({ officialKm, perKmUnitPrice });
    const second = calculateDepreciation({ officialKm, perKmUnitPrice });
    expect(first.rawAmount?.toString()).toBe(second.rawAmount?.toString());
    expect(first.amount).toBe(second.amount);
    expect(officialKm.toString()).toBe("850.27");
    expect(perKmUnitPrice.toString()).toBe("6.6667");
  });

  it("AC-19 floating-point discriminator: officialKm=0.07 × perKmUnitPrice=100.0000 is exactly 7 (an IEEE754 double intermediary produces 7.000000000000001)", () => {
    const result = calculateDepreciation({
      officialKm: d("0.07"),
      perKmUnitPrice: d("100.0000"),
    });
    expect(result.rawAmount?.toString()).toBe("7");
    // 對照：浮點路徑的實際產物（證明本斷言具鑑別力，而非「夠接近」）
    expect((0.07 * 100).toString()).toBe("7.000000000000001");
    expect(result.rawAmount?.toString()).not.toBe((0.07 * 100).toString());
    expect(result.amount).toBe(7);
  });

  it("AC-19 perKmUnitPrice is restored from the engine's fixed 4-decimal string with no Number()/parseFloat mediation (10/3/3 wiring check)", () => {
    // Spec §16 D6(a) 之 10/3/3 kill case：未取整分子得 "1.1111"；
    // 若引擎改以已取整之每年費用 3.33 為分子則得 "1.1100"。
    const derived = deriveDepreciation({
      vehiclePrice: new Prisma.Decimal("10"),
      usefulLifeYears: 3,
      estimatedAnnualKm: 3,
    });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.perKmUnitPrice).toBe("1.1111");
    expect(derived.perKmUnitPrice).not.toBe("1.1100");

    // §7.4 ③：以 `new Prisma.Decimal(字串)` 還原，逐位元保留 4 位小數。
    const perKmUnitPrice = new Prisma.Decimal(derived.perKmUnitPrice);
    const result = calculateDepreciation({ officialKm: d("10000.00"), perKmUnitPrice });
    expect(result.rawAmount?.toString()).toBe("11111");
    expect(result.amount).toBe(11111);
  });
});

// ---------------------------------------------------------------------------
// §2 AC-21 取整方向：ROUND_HALF_UP（0.5 進位、away from zero），非銀行家
// ---------------------------------------------------------------------------

describe("calculateDepreciation — AC-21 rounding is ROUND_HALF_UP (away from zero), never ROUND_HALF_EVEN", () => {
  // kill pair：兩列成對出現才具鑑別力。
  //   `raw=0.5 → 1`：ROUND_HALF_EVEN 得 0（**此列鑑別 half-even mutant**）
  //   `raw=1.5 → 2`：ROUND_HALF_EVEN 亦得 2（此列**不**鑑別 half-even，但鑑別
  //                   「一律捨去」與「至偶數」以外的其他錯誤取整方向）
  it("kill pair row 1 — officialKm=1.00 × 0.5000 → raw=0.5 → amount=1 (ROUND_HALF_EVEN mutant yields 0, must go red)", () => {
    const result = calculateDepreciation({ officialKm: d("1.00"), perKmUnitPrice: d("0.5000") });
    expect(result.rawAmount?.toString()).toBe("0.5");
    expect(result.amount).toBe(1);
    // 反例自證：half-even 於本列確實得 0（證明本列具鑑別力）
    expect(d("0.5").toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_EVEN).toNumber()).toBe(0);
  });

  it("kill pair row 2 — officialKm=3.00 × 0.5000 → raw=1.5 → amount=2 (pairs with row 1: proves 'away from zero', not 'always down')", () => {
    const result = calculateDepreciation({ officialKm: d("3.00"), perKmUnitPrice: d("0.5000") });
    expect(result.rawAmount?.toString()).toBe("1.5");
    expect(result.amount).toBe(2);
    // 本列對 half-even 不鑑別（half-even 亦得 2）——明文記錄，避免誤以為單列足夠。
    expect(d("1.5").toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_EVEN).toNumber()).toBe(2);
  });

  it("minimal discriminating pair — raw=0.4999 → 0 and raw=0.5 → 1", () => {
    const below = calculateDepreciation({ officialKm: d("1.00"), perKmUnitPrice: d("0.4999") });
    expect(below.rawAmount?.toString()).toBe("0.4999");
    expect(below.amount).toBe(0);

    const at = calculateDepreciation({ officialKm: d("1.00"), perKmUnitPrice: d("0.5000") });
    expect(at.rawAmount?.toString()).toBe("0.5");
    expect(at.amount).toBe(1);
  });

  it("half-up applies away from zero for negative raw amounts too (defensive: never silently 0, never NaN)", () => {
    // 負里程於本 Phase 不可達（`sumOfficialMileage` 之 SUM ≥ 0，單價 > 0），
    // 但若真的發生，函式必須忠實回報負值——**不得**靜默回 0（005a T2 SF-1
    // 「絕不靜默回 0」之直接對象），亦不得回 NaN。
    const result = calculateDepreciation({
      officialKm: d("-1.00"),
      perKmUnitPrice: d("0.5000"),
    });
    expect(result.calculable).toBe(true);
    expect(result.rawAmount?.toString()).toBe("-0.5");
    expect(result.amount).toBe(-1); // away from zero
    expect(result.amount).not.toBe(0);
    expect(Number.isNaN(result.amount as number)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §3 AC-20 取整層級：全 Phase 恰一處取整（最終金額）
// ---------------------------------------------------------------------------

describe("calculateDepreciation — AC-20 rounding happens exactly once (final amount only)", () => {
  it("PRIMARY kill case — officialKm=1234.56 pattern replaced: 850.27 × 6.6667 → raw=5668.495009 → 5668 (mutant A 'pre-round raw to 2dp' → 5669; mutant B 'pre-round officialKm' → 5667)", () => {
    const officialKm = d("850.27");
    const perKmUnitPrice = d("6.6667");
    const result = calculateDepreciation({ officialKm, perKmUnitPrice });

    expect(result.rawAmount?.toString()).toBe("5668.495009");
    expect(result.amount).toBe(5668);

    // mutant A — 先將 rawAmount 取整至 2 位（5668.50）再取整 → 5669
    const mutantA = officialKm
      .times(perKmUnitPrice)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
      .toNumber();
    expect(mutantA).toBe(5669);
    expect(mutantA).not.toBe(result.amount);

    // mutant B — 先將 officialKm 取整至整數（850）再相乘 → 5667
    const mutantB = officialKm
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
      .times(perKmUnitPrice)
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
      .toNumber();
    expect(mutantB).toBe(5667);
    expect(mutantB).not.toBe(result.amount);
  });

  it("PRIMARY kill case price is genuinely reachable: deriveDepreciation(300000, 3, 15000).perKmUnitPrice === '6.6667'", () => {
    const derived = deriveDepreciation({
      vehiclePrice: new Prisma.Decimal("300000"),
      usefulLifeYears: 3,
      estimatedAnnualKm: 15000,
    });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.perKmUnitPrice).toBe("6.6667");
  });

  it("SECONDARY kill case (terminating decimal) — 1137.50 × 5.5556 → raw=6319.495 exactly → 6319 (mutant A → 6320; mutant B → 6322)", () => {
    const officialKm = d("1137.50");
    const perKmUnitPrice = d("5.5556");
    const result = calculateDepreciation({ officialKm, perKmUnitPrice });

    expect(result.rawAmount?.toString()).toBe("6319.495");
    expect(result.amount).toBe(6319);

    const mutantA = officialKm
      .times(perKmUnitPrice)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
      .toNumber();
    expect(mutantA).toBe(6320);
    expect(mutantA).not.toBe(result.amount);

    const mutantB = officialKm
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
      .times(perKmUnitPrice)
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
      .toNumber();
    expect(mutantB).toBe(6322);
    expect(mutantB).not.toBe(result.amount);
  });

  it("Spec §2 AC-20 / §17.1 self-note re-verified: 1234.56 × 0.5001 kills ONLY mutant B (617 vs 618) and is blind to mutant A (617 vs 617) — hence it is NOT the primary kill case", () => {
    const officialKm = d("1234.56");
    const perKmUnitPrice = d("0.5001");
    const result = calculateDepreciation({ officialKm, perKmUnitPrice });

    // ⚠ Spec 原文寫 `rawAmount = 617.404656`；實際為 `617.403456`（Spec 算術
    //   筆誤，已於 Handoff Warnings 回報）。結論值 `amount = 617` 不受影響。
    expect(result.rawAmount?.toString()).toBe("617.403456");
    expect(result.amount).toBe(617);

    const mutantA = officialKm
      .times(perKmUnitPrice)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
      .toNumber();
    expect(mutantA).toBe(617); // 不鑑別 — Spec 自註屬實
    expect(mutantA).toBe(result.amount);

    const mutantB = officialKm
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
      .times(perKmUnitPrice)
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
      .toNumber();
    expect(mutantB).toBe(618); // 鑑別 mutant B
    expect(mutantB).not.toBe(result.amount);
  });

  it("perKmUnitPrice is never re-rounded: a 4-decimal price passes through byte-for-byte into rawAmount", () => {
    const result = calculateDepreciation({
      officialKm: d("1.00"),
      perKmUnitPrice: d("0.0001"),
    });
    // 若對單價再取整（例如至 2 位）→ 0.00 → rawAmount 0，amount 0（無法與正確
    // 值區分，因兩者 amount 皆 0），故此列以 rawAmount 的完整字串鑑別。
    expect(result.rawAmount?.toString()).toBe("0.0001");
    expect(result.perKmUnitPrice.toString()).toBe("0.0001");
  });

  it("AC-20 source-level scan: exactly one toDecimalPlaces() call exists in the implementation (the final amount)", () => {
    const rawSource = fs.readFileSync(ENGINE_SRC_PATH, "utf8");
    const blanked = blankCommentsAndStrings(rawSource);
    const occurrences = blanked.match(/\.toDecimalPlaces\(/g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  it("AC-19 source-level scan (T2 即審 AR-2 補強，PHASE-007-T3): exactly one .toNumber() call exists and it sits immediately after the ROUND_HALF_UP rounding — kills a 'real double intermediary' mutant such as officialKm.toNumber() * perKmUnitPrice.toNumber()", () => {
    const rawSource = fs.readFileSync(ENGINE_SRC_PATH, "utf8");
    const blanked = blankCommentsAndStrings(rawSource);
    // 「零浮點中介」掃描原本只攔 Number()/parseFloat/parseInt，`.toNumber()`
    // 為同等威力的降轉入口（AR-2 登記之盲區）。本檔唯一合法用途為最終金額，
    // 且必須發生在取整**之後**（AC-19/20）。
    const occurrences = blanked.match(/\.toNumber\(/g) ?? [];
    expect(occurrences.length).toBe(1);
    expect(blanked).toMatch(/\.toDecimalPlaces\([^)]*\)\.toNumber\(\)/);
    // 掃描器鑑別力自證：合成的 double 中介片段必被計為 2 次且不匹配取整鏈。
    const doubleIntermediary = blankCommentsAndStrings(
      "const raw = officialKm.toNumber() * perKmUnitPrice.toNumber();"
    );
    expect((doubleIntermediary.match(/\.toNumber\(/g) ?? []).length).toBe(2);
    expect(doubleIntermediary).not.toMatch(/\.toDecimalPlaces\([^)]*\)\.toNumber\(\)/);
  });

  it("AC-20 source-level scan: no toFixed()/round()/trunc()/ceil()/floor() rounding on the amount path", () => {
    const rawSource = fs.readFileSync(ENGINE_SRC_PATH, "utf8");
    const blanked = blankCommentsAndStrings(rawSource);
    expect(blanked.match(/\.toFixed\(/g)).toBeNull();
    expect(blanked.match(/\.(round|trunc|ceil|floor)\(/g)).toBeNull();
    expect(blanked.match(/Math\./g)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §4 NaN／Infinity 三重守門（005a T2 SF-1／006 T2R MF-1 同型）
// ---------------------------------------------------------------------------

describe("calculateDepreciation — NaN/Infinity triple guard (never returns NaN/Infinity, never silently returns 0, never throws)", () => {
  const nonFinite: Array<{ label: string; value: Prisma.Decimal }> = [
    { label: "NaN", value: d("NaN") },
    { label: "+Infinity", value: d("Infinity") },
    { label: "-Infinity", value: d("-Infinity") },
  ];

  it.each(nonFinite)(
    "guard 1 — officialKm = $label → calculable=false, rawAmount/amount null",
    ({ value }) => {
      const result = calculateDepreciation({ officialKm: value, perKmUnitPrice: d("6.6667") });
      expect(result.calculable).toBe(false);
      expect(result.rawAmount).toBeNull();
      expect(result.amount).toBeNull();
      // 絕不靜默回 0（005a T2 SF-1 逐字）
      expect(result.amount).not.toBe(0);
    }
  );

  it.each(nonFinite)(
    "guard 2 — perKmUnitPrice = $label → calculable=false, rawAmount/amount null",
    ({ value }) => {
      const result = calculateDepreciation({ officialKm: d("850.27"), perKmUnitPrice: value });
      expect(result.calculable).toBe(false);
      expect(result.rawAmount).toBeNull();
      expect(result.amount).toBeNull();
      expect(result.amount).not.toBe(0);
    }
  );

  it("guard 3 — product itself non-finite (0 × Infinity = NaN) is caught by the third guard, not leaked", () => {
    // 本組合會被 guard 2 先攔下；此列直接驗證「相乘後非有限」之語意確實存在，
    // 且與 guard 1/2 一致回報（而非讓 NaN 穿透至 amount）。
    expect(d("0").times(d("Infinity")).isFinite()).toBe(false);
    const result = calculateDepreciation({ officialKm: d("0.00"), perKmUnitPrice: d("Infinity") });
    expect(result.calculable).toBe(false);
    expect(result.amount).toBeNull();
  });

  it("NaN never leaks into a truthy-looking comparison: a NaN input must not produce amount 0 or a finite rawAmount", () => {
    // 005a T2 SF-1 之根因：`Decimal` 與 NaN 的比較恆為 false，故「以比較式當
    // 守門」會靜默穿透。本列鎖定回傳形狀而非比較結果。
    const result = calculateDepreciation({ officialKm: d("NaN"), perKmUnitPrice: d("NaN") });
    expect(result.calculable).toBe(false);
    expect(result.rawAmount).toBeNull();
    expect(result.amount).toBeNull();
    expect(result.officialKm.isNaN()).toBe(true);
  });

  it("never throws for any non-finite / extreme input combination", () => {
    const extremes = [d("NaN"), d("Infinity"), d("-Infinity"), d("0"), d("1e30"), d("-1e30")];
    for (const a of extremes) {
      for (const b of extremes) {
        expect(() => calculateDepreciation({ officialKm: a, perKmUnitPrice: b })).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §5 AC-22(a)(d) 容量 predicate（判定層）
// ---------------------------------------------------------------------------

function syntheticResult(
  overrides: Partial<CalculateDepreciationResult>
): CalculateDepreciationResult {
  return {
    officialKm: d("1"),
    perKmUnitPrice: d("1"),
    calculable: true,
    rawAmount: d("1"),
    amount: 1,
    ...overrides,
  };
}

describe("isDepreciationCalculationOverCapacity — AC-22(a)(d) capacity guard with boundary positives (no false kills, no silent truncation)", () => {
  it("a normal result is within capacity", () => {
    expect(
      isDepreciationCalculationOverCapacity(
        calculateDepreciation({ officialKm: d("850.27"), perKmUnitPrice: d("6.6667") })
      )
    ).toBe(false);
  });

  const decimalBoundaries: Array<{
    field: "officialKm" | "perKmUnitPrice" | "rawAmount";
    justUnder: string;
    atBound: string;
    column: string;
  }> = [
    {
      field: "officialKm",
      justUnder: "9999999999.99",
      atBound: "10000000000",
      column: "snapshotOfficialKm Decimal(12,2)",
    },
    {
      field: "perKmUnitPrice",
      justUnder: "9999999999.9999",
      atBound: "10000000000",
      column: "snapshotPerKmUnitPrice Decimal(14,4)",
    },
    {
      field: "rawAmount",
      justUnder: "9999999999.9999",
      atBound: "10000000000",
      column: "snapshotRawAmount Decimal(14,4)",
    },
  ];

  it.each(decimalBoundaries)(
    "$field just under 1e10 ($justUnder) is within capacity ($column boundary positive)",
    ({ field, justUnder }) => {
      const result = syntheticResult({
        [field]: d(justUnder),
      } as Partial<CalculateDepreciationResult>);
      expect(isDepreciationCalculationOverCapacity(result)).toBe(false);
    }
  );

  it.each(decimalBoundaries)(
    "$field at exactly 1e10 ($atBound) is over capacity ($column)",
    ({ field, atBound }) => {
      const result = syntheticResult({
        [field]: d(atBound),
      } as Partial<CalculateDepreciationResult>);
      expect(isDepreciationCalculationOverCapacity(result)).toBe(true);
    }
  );

  it.each(decimalBoundaries)(
    "$field at exactly −1e10 is over capacity (abs() is used)",
    ({ field }) => {
      const result = syntheticResult({
        [field]: d("-10000000000"),
      } as Partial<CalculateDepreciationResult>);
      expect(isDepreciationCalculationOverCapacity(result)).toBe(true);
    }
  );

  it("amount = 2147483647 (int4 max) is within capacity", () => {
    expect(isDepreciationCalculationOverCapacity(syntheticResult({ amount: 2147483647 }))).toBe(
      false
    );
  });

  it("amount = 2147483648 (int4 max + 1) is over capacity", () => {
    expect(isDepreciationCalculationOverCapacity(syntheticResult({ amount: 2147483648 }))).toBe(
      true
    );
  });

  it("amount = -2147483648 (int4 min) is within capacity; -2147483649 is over capacity", () => {
    expect(isDepreciationCalculationOverCapacity(syntheticResult({ amount: -2147483648 }))).toBe(
      false
    );
    expect(isDepreciationCalculationOverCapacity(syntheticResult({ amount: -2147483649 }))).toBe(
      true
    );
  });

  it("FW-2 — an over-capacity input is REJECTED by the predicate, never thrown (Postgres 22003 numeric overflow would otherwise surface as a 500)", () => {
    // `Decimal(14,4)` 溢位於 DB 層為 SQLSTATE 22003；判定層必須以布林拒絕，
    // 使呼叫端能轉為 4xx `AMOUNT_OUT_OF_RANGE`（AC-22(b)），而非拋錯。
    const overflowing = calculateDepreciation({
      officialKm: d("9999999999.99"),
      perKmUnitPrice: d("9999999999.9999"),
    });
    expect(overflowing.calculable).toBe(true); // 忠實計算，不靜默截斷
    expect(overflowing.rawAmount?.greaterThan(d("10000000000"))).toBe(true);
    let threw = false;
    let over = false;
    try {
      over = isDepreciationCalculationOverCapacity(overflowing);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(over).toBe(true);
  });

  it("AC-22(b) the predicate never truncates: calculateDepreciation's returned values are unchanged by the capacity verdict", () => {
    const result = calculateDepreciation({
      officialKm: d("9999999999.99"),
      perKmUnitPrice: d("9999999999.9999"),
    });
    const rawBefore = result.rawAmount?.toString();
    const amountBefore = result.amount;
    isDepreciationCalculationOverCapacity(result);
    expect(result.rawAmount?.toString()).toBe(rawBefore);
    expect(result.amount).toBe(amountBefore);
  });

  it("a non-calculable result (non-finite input) is reported as over capacity — no finite column can hold it, so the caller raises AMOUNT_OUT_OF_RANGE (keeps T3's invariant `calculable=false ⇒ ≥1 blocker` satisfiable)", () => {
    const result = calculateDepreciation({ officialKm: d("NaN"), perKmUnitPrice: d("6.6667") });
    expect(result.calculable).toBe(false);
    expect(isDepreciationCalculationOverCapacity(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §6 T1 即審 FW-1 —— 容量常數 ↔ 實際 DB 欄位精度之對照
//
// 背景（PROJECT_STATE「T1 即審 FW」）：reviewer 已證「只改 schema.prisma 而不
// 動 migration，全套測試仍全綠」——故容量常數若僅綁 schema.prisma 之心智模型
// 即為空頭承諾。本節以**實際套用到 Postgres 的 DDL（migration SQL）**為權威
// 來源，並同時要求 schema.prisma 與該 DDL 一致：
//   ① 常數 ≠ migration DDL 精度 → 紅（常數脫鉤）
//   ② schema.prisma ≠ migration DDL → 紅（schema-only 改動不再靜默通過）
// 本層刻意不連 DB（單元層零 IO，§11.1「不需 DB」）；`information_schema` 之
// 實查已由 T1 之 `phase7-migration-safety.test.ts`（整合層，AC-01(a) 精度往返）
// 覆蓋，兩層合起來構成完整鏈：常數 ↔ migration DDL ↔ 實際 DB 欄位。
// ---------------------------------------------------------------------------

function readDdlDecimalPrecision(
  sql: string,
  table: string,
  column: string
): { precision: number; scale: number } {
  const tableBody = extractCreateTableBody(sql, table);
  const pattern = new RegExp(`"${column}"\\s+DECIMAL\\((\\d+),\\s*(\\d+)\\)`, "i");
  const match = tableBody.match(pattern);
  if (!match) {
    throw new Error(`DDL for ${table}.${column} not found or not DECIMAL(p,s)`);
  }
  return { precision: Number.parseInt(match[1], 10), scale: Number.parseInt(match[2], 10) };
}

function extractCreateTableBody(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE "${table}" (`);
  if (start < 0) throw new Error(`CREATE TABLE "${table}" not found`);
  const end = sql.indexOf("\n);", start);
  if (end < 0) throw new Error(`end of CREATE TABLE "${table}" not found`);
  return sql.slice(start, end);
}

function readSchemaPrismaDecimalPrecision(
  schema: string,
  model: string,
  field: string
): { precision: number; scale: number } {
  const modelStart = schema.indexOf(`model ${model} {`);
  if (modelStart < 0) throw new Error(`model ${model} not found in schema.prisma`);
  const modelEnd = schema.indexOf("\n}", modelStart);
  const body = schema.slice(modelStart, modelEnd);
  const pattern = new RegExp(`\\b${field}\\b[^\\n]*@db\\.Decimal\\((\\d+),\\s*(\\d+)\\)`);
  const match = body.match(pattern);
  if (!match) throw new Error(`${model}.${field} @db.Decimal(p,s) not found`);
  return { precision: Number.parseInt(match[1], 10), scale: Number.parseInt(match[2], 10) };
}

describe("T1 FW-1 — capacity constants are pinned to the ACTUAL applied DDL, not to a schema.prisma mental model", () => {
  const migrationSql = fs.readFileSync(PHASE7_MIGRATION_SQL_PATH, "utf8");
  const schemaPrisma = fs.readFileSync(SCHEMA_PRISMA_PATH, "utf8");

  const decimalColumns = [
    { constantKey: "snapshotOfficialKm", column: "snapshotOfficialKm" },
    { constantKey: "snapshotPerKmUnitPrice", column: "snapshotPerKmUnitPrice" },
    { constantKey: "snapshotRawAmount", column: "snapshotRawAmount" },
  ] as const;

  it("sanity: the migration DDL being read is the real one (contains the CREATE TABLE statement)", () => {
    expect(migrationSql).toContain('CREATE TABLE "DepreciationApplication"');
  });

  it.each(decimalColumns)(
    "$column — named constant precision/scale equals the DECIMAL(p,s) in the applied migration DDL",
    ({ constantKey, column }) => {
      const ddl = readDdlDecimalPrecision(migrationSql, "DepreciationApplication", column);
      const constant = DEPRECIATION_COLUMN_CAPACITY[constantKey];
      expect({ precision: constant.precision, scale: constant.scale }).toEqual(ddl);
    }
  );

  it.each(decimalColumns)(
    "$column — schema.prisma @db.Decimal(p,s) equals the applied migration DDL (a schema-only edit can no longer pass silently)",
    ({ column }) => {
      const ddl = readDdlDecimalPrecision(migrationSql, "DepreciationApplication", column);
      const fromSchema = readSchemaPrismaDecimalPrecision(
        schemaPrisma,
        "DepreciationApplication",
        column
      );
      expect(fromSchema).toEqual(ddl);
    }
  );

  it.each(decimalColumns)(
    "$column — the derived bound equals 10^(precision − scale), i.e. the exact number of integral digits the column can hold",
    ({ constantKey }) => {
      const constant = DEPRECIATION_COLUMN_CAPACITY[constantKey];
      const expected = new Prisma.Decimal("10").pow(constant.precision - constant.scale);
      expect(constant.bound.toString()).toBe(expected.toString());
    }
  );

  it("Application.totalAmount is INTEGER (int4) in the applied DDL, and the int4 bounds are derived from its 32-bit width", () => {
    const phase4Sql = fs.readFileSync(PHASE4_MIGRATION_SQL_PATH, "utf8");
    const applicationBody = extractCreateTableBody(phase4Sql, "Application");
    expect(applicationBody).toMatch(/"totalAmount"\s+INTEGER/);
    expect(DEPRECIATION_COLUMN_CAPACITY.totalAmount.bits).toBe(32);
    expect(DEPRECIATION_COLUMN_CAPACITY.totalAmount.max).toBe(2147483647);
    expect(DEPRECIATION_COLUMN_CAPACITY.totalAmount.min).toBe(-2147483648);
  });

  it("FW-1 self-proof: the DDL reader has discriminating power — a poisoned DDL string yields a different precision, and a missing column throws instead of silently passing", () => {
    const poisoned = migrationSql.replace(
      '"snapshotRawAmount" DECIMAL(14,4)',
      '"snapshotRawAmount" DECIMAL(16,4)'
    );
    expect(poisoned).not.toBe(migrationSql); // 確認替換確實發生
    expect(
      readDdlDecimalPrecision(poisoned, "DepreciationApplication", "snapshotRawAmount")
    ).toEqual({ precision: 16, scale: 4 });
    expect(() =>
      readDdlDecimalPrecision(migrationSql, "DepreciationApplication", "noSuchColumn")
    ).toThrow();
  });

  it("FW-1 self-proof: the schema.prisma reader has discriminating power (poisoned schema yields a different precision)", () => {
    // 注意：`snapshotRawAmount Decimal(14,4)` 在 schema.prisma 中不只一處
    // （`TravelApplication`／`MaintenanceApplication` 亦有同名同精度欄位），
    // 故投毒必須限定在 `DepreciationApplication` 模型區塊內，否則會誤改他表
    // 而讓本自證失去意義。
    const modelStart = schemaPrisma.indexOf("model DepreciationApplication {");
    const modelEnd = schemaPrisma.indexOf("\n}", modelStart);
    const poisonedBody = schemaPrisma
      .slice(modelStart, modelEnd)
      .replace(
        /(snapshotRawAmount\s+Decimal\?\s+@db\.Decimal\()14(,\s*4\))/,
        (_full, head: string, tail: string) => `${head}16${tail}`
      );
    const poisoned =
      schemaPrisma.slice(0, modelStart) + poisonedBody + schemaPrisma.slice(modelEnd);
    expect(poisoned).not.toBe(schemaPrisma);
    expect(
      readSchemaPrismaDecimalPrecision(poisoned, "DepreciationApplication", "snapshotRawAmount")
    ).toEqual({ precision: 16, scale: 4 });
  });
});

// ---------------------------------------------------------------------------
// §7 零浮點中介掃描（清單驅動：PHASE_007_SRC_FILES）
// ---------------------------------------------------------------------------

/**
 * 將註解與字串／樣板字面「挖空」為等長空白（換行保留），使後續的語彙掃描
 * 只看得到真正的程式碼。做法沿用 CHORE-003-T3／PHASE-005a
 * （`fuel-price-engine.test.ts` §3）／PHASE-006（`maintenance-calculation.test.ts`
 * §5）之既有慣例。
 *
 * ※ AR-1 已登記之「掃描 helper 多份拷貝抽共用」技術債（PHASE-011）——本檔
 *   為第四份；抽共用會跨 Phase 改既有測試檔，超出本 Task 之 Files Allowed。
 */
function blankCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += blank(src[i]);
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " ";
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += blank(src[i]);
        i++;
      }
      out += " ";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 對值做強制轉型的呼叫：`Number(...)`／`parseFloat(...)`／`parseInt(...)`。 */
const COERCION_CALL_PATTERN = /\b(Number|parseFloat|parseInt)\s*\(([^)]*)\)/g;

function findCoercionCalls(blankedCode: string): string[] {
  return [...blankedCode.matchAll(COERCION_CALL_PATTERN)].map((m) => `${m[1]}(${m[2].trim()})`);
}

/** `Prisma.Decimal` 之建構呼叫（`new Prisma.Decimal(...)`）之引數原始文字。 */
const DECIMAL_CONSTRUCTOR_PATTERN = /new\s+Prisma\.Decimal\s*\(([^)]*)\)/g;

function findDecimalConstructorArgs(blankedCode: string): string[] {
  return [...blankedCode.matchAll(DECIMAL_CONSTRUCTOR_PATTERN)].map((m) => m[1].trim());
}

describe("AC-19 零浮點中介 — PHASE-007 source files contain no Number()/parseFloat/parseInt on the amount path", () => {
  describe.each(PHASE_007_SRC_FILES)("scanned file: %s", (relativePath) => {
    const rawSource = fs.readFileSync(path.resolve(BACKEND_ROOT, relativePath), "utf8");
    const blanked = blankCommentsAndStrings(rawSource);

    it("scan sanity: blanking does not collapse the file to an empty/whitespace-only string (not scanning nothing)", () => {
      expect(blanked.trim().length).toBeGreaterThan(0);
    });

    it("contains zero Number()/parseFloat/parseInt calls", () => {
      expect(findCoercionCalls(blanked)).toEqual([]);
    });

    it("contains no unary/binary `+` numeric coercion of a variable on the amount path", () => {
      const plusCoercionPattern = /(?<![+\-.\w])\+(?!\+)[a-zA-Z_$][\w$]*/g;
      expect([...blanked.matchAll(plusCoercionPattern)]).toEqual([]);
    });
  });

  const rawSource = fs.readFileSync(ENGINE_SRC_PATH, "utf8");
  const blanked = blankCommentsAndStrings(rawSource);

  it("scan sanity: blanking preserves a recognizable code skeleton (not scanning an empty string)", () => {
    expect(blanked).toContain("export function calculateDepreciation");
    expect(blanked).toContain("toDecimalPlaces");
    // 只存在於註解的中文散文必須在挖空後消失。
    expect(blanked).not.toContain("欄位容量");
  });

  it("every Prisma.Decimal construction in this file takes a string literal (D4 bright-line: no bare-number construction)", () => {
    // 以「挖空註解／字串後」的原始碼定位真正的程式碼建構處：doc-comment 中
    // 作為說明文字出現的 `new Prisma.Decimal(...)` 不得被計入（否則掃描會被
    // 散文汙染而失去鑑別力）。挖空後字串字面內容成為等長空白，故引數呈現為
    // 空字串——正是「引數是字串字面」的證據（變數或裸數字會原樣存活）。
    const codeArgs = findDecimalConstructorArgs(blanked);
    expect(codeArgs).toEqual([""]);

    // 於同一 byte offset 回讀原始碼，確認該引數確實是 `"10"`（十進位基數，
    // 用於由欄位精度推導容量上界 10^(precision − scale)——零魔術數，AC-22(a)）。
    const offset = blanked.search(DECIMAL_CONSTRUCTOR_PATTERN);
    expect(offset).toBeGreaterThan(-1);
    expect(rawSource.slice(offset)).toMatch(/^new Prisma\.Decimal\("10"\)/);
  });

  it("scanner self-proof (discriminating power): a synthetic legacy snippet using Number() as an intermediary must be caught; Number( inside comments/strings must not false-positive", () => {
    const oldImplementation = blankCommentsAndStrings(
      [
        "function calcDepreciation(km, price) {",
        "  const kmNum = Number(km);",
        "  const priceNum = parseFloat(price);",
        "  return Math.round(kmNum * priceNum);",
        "}",
      ].join("\n")
    );
    expect(findCoercionCalls(oldImplementation)).toEqual(["Number(km)", "parseFloat(price)"]);

    const commentOnly = blankCommentsAndStrings(
      [
        "// 這一步刻意不使用 Number(input) 中介",
        "/* 舊路徑：const x = parseFloat(y); */",
        'const message = "Number(unsafe) 僅是文案";',
        "const safe = toDecimal(input);",
      ].join("\n")
    );
    expect(findCoercionCalls(commentOnly)).toEqual([]);
  });

  it("whitelist self-proof: PHASE_007_SRC_FILES drives the scan and fails loudly on a missing path (no silent skip)", () => {
    expect(PHASE_007_SRC_FILES.length).toBeGreaterThan(0);
    expect(PHASE_007_SRC_FILES).toContain("src/applications/depreciation-calculation.ts");
    expect(() =>
      fs.readFileSync(path.resolve(BACKEND_ROOT, "src/applications/no-such-file.ts"), "utf8")
    ).toThrow();
  });
});
