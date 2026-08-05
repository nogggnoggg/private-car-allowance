/**
 * PHASE-007-R2 — `calculateDepreciation` ＋ `isDepreciationCalculationOverCapacity`
 * （修訂段：AC-21／AC-22(判定層)／AC-50／AC-51）
 *
 * ---------------------------------------------------------------------------
 * 規範出處（Spec `docs/specs/PHASE-007.md`，修訂段 §20 於衝突處覆蓋 §1~§17）
 * ---------------------------------------------------------------------------
 * §20.4.1 公式（逐字）：
 *   ③ annualDepreciation = new Prisma.Decimal(derived.annualDepreciation)  // 2 位小數字串
 *   ④ ratio       = officialKm.div(annualTotalKm)                 // 全精度，**僅供顯示與快照**
 *     ratioString        = ratio.toFixed(6, ROUND_HALF_UP)        // 6 位小數
 *     ratioPercentString = ratio.times(100).toFixed(4, ROUND_HALF_UP)   // 4 位小數
 *   ⑤ rawAmount = annualDepreciation.times(officialKm).div(annualTotalKm)   // **先乘後除**，未取整
 *   ⑥ amount    = rawAmount.toDecimalPlaces(0, ROUND_HALF_UP).toNumber()    // 全案唯一取整處
 * §20.4.1 禁止段逐字：「以 `annualDepreciation.times(ratio)` 求 `rawAmount`（引入第二次
 *   捨入）、先取整 `ratio`、先取整 `officialKm`、先取整 `rawAmount` 至 2 位、對
 *   `annualDepreciation` 二次取整、以浮點運算任一步。」
 * §20.4.1 除零守門逐字：「`annualTotalKm ≤ 0` 或任一輸入非有限值 → `calculable=false`，
 *   其餘欄位 `null`（AC-50(d)）。」
 * §20.4.2：本 Phase 之取整**恰一處**（最終金額）；每年折舊費用之 2dp 取整發生在引擎內。
 * §20.4.3：PRIMARY／SECONDARY kill case、`ROUND_HALF_UP` kill pair、邊界正例。
 * AC-50(a)~(d)、AC-51(a)~(d)、AC-21（`ROUND_HALF_UP` 紀律不變）、AC-22(a)(d)。
 * §20.7.2：容量 predicate 之判定集合更新為 `snapshotOfficialKm`／`snapshotAnnualTotalKm`／
 *   `snapshotAnnualDepreciation`／`snapshotRatio`／`snapshotRawAmount`／`totalAmount`；
 *   `snapshotPerKmUnitPrice`「**退出容量 predicate 之判定集合**（新模型不寫入）」。
 *
 * ---------------------------------------------------------------------------
 * 鑑別力設計（§20.12 R2 列 Done When 硬性項）
 * ---------------------------------------------------------------------------
 * 1. §20.4.3 PRIMARY kill case（單一數對同時鑑別四種取整層級 mutant）——
 *      A=100000.00 ／ O=1001.66 ／ I=12345.6 → raw=8113.4979263867288751 → 8113
 *      mutant A（ratio 先取整 6dp）→ 8114 ✗   mutant B（ratio 先取整 4dp）→ 8110 ✗
 *      mutant C（raw 先取整 2dp）  → 8114 ✗   mutant D（officialKm 先取整）→ 8116 ✗
 * 2. §20.4.3 SECONDARY kill case（比例先取整之獨立鑑別）——
 *      A=100000.00 ／ O=4000.09 ／ I=20000.0 → raw=20000.45 → 20000；mutant A → 20001 ✗
 * 3. §20.4.3 `ROUND_HALF_UP` kill pair——
 *      row 1（鑑別）：O=4000.10 → raw=20000.5 → 20001；`ROUND_HALF_EVEN` mutant → 20000 ✗
 *      row 2（配對，證 away-from-zero）：O=4000.30 → raw=20001.5 → 20002（half-even 亦得
 *      20002，不鑑別；兩列合起來才證明「away from zero」而非「一律進位」）
 * 4. **`.times(ratio)` mutant 之 kill 數對（AC-50(c)；§20.4.3「R2 之回填義務」）**——
 *      本 Task 以窮舉搜尋產生（搜尋構造與範圍見下方 §2 之註解）：
 *        A=10004.17 ／ O=99995.00 ／ I=100041.7 → raw **恰為** 9999.5 → **10000**
 *        mutant `annualDepreciation.times(ratio)` → 9999.4999999999999999 → **9999** ✗
 *      成立原理：`Prisma.Decimal`（decimal.js）之 `precision = 20` 有效位數；先取
 *      `ratio = O/I` 為無盡小數時已在第 20 位發生捨入，再乘回 `A` 即失去「恰為 .5」
 *      之邊界，於最終 `ROUND_HALF_UP` 差 1 元。
 * 5. 三重守門：`isFinite`（三輸入）／`annualTotalKm ≤ 0` 除零／結果非有限值。
 * 6. 容量常數 ↔ **實際套用之 migration DDL** 對照（T1 即審 FW-1）——新 4 欄之 DDL
 *    來自 **M2（ALTER 型）**，既有 2 欄來自 M1（CREATE 型），讀取器須橫跨兩檔並在
 *    命中數 ≠ 1 時 fail-loud。
 *
 * ---------------------------------------------------------------------------
 * Mutant 自證（實際執行紀錄見 Handoff）
 * ---------------------------------------------------------------------------
 *   M1 `ROUND_HALF_UP` → `ROUND_HALF_EVEN`（最終金額取整處）
 *   M2 `rawAmount` 先取整至 2 位小數
 *   M3 `officialKm` 先取整為整數再進入公式
 *   M4 `rawAmount` 改以 `annualDepreciation.times(ratio)` 求值（AC-50(c) 直接對象）
 *   M5 `ratio` 先取整至 6dp（顯示值回流計算）
 *   M6 三重守門整段刪除
 *
 * ---------------------------------------------------------------------------
 * 測試遷移核銷（§20.11.2「`backend/test/unit/depreciation-calculation.test.ts` —
 * AC-19/20 退場、AC-21/22 改組、AC-50/51 新增」；§12R.1 AC-19／AC-20 列）
 * ---------------------------------------------------------------------------
 *   §12R.1 AC-19 列逐字：「`depreciation-calculation.test.ts` 之 AC-19 describe 依新公式
 *     改寫（浮點鑑別、純度、輸入不變性三條**語意保留**，僅換輸入組）」——三條均在場
 *     （§1）。
 *   §12R.1 AC-20 列逐字：「舊 kill case 測試刪除並以新 kill case 取代；『取整恰一處』之
 *     原始碼掃描斷言**語意保留**」——舊數對（`850.27 × 6.6667`、`1137.50 × 5.5556`、
 *     `1234.56 × 0.5001`）於新公式下不可達，依授權刪除並由 §20.4.3 新數對取代（§3）；
 *     「恰一處 `toDecimalPlaces(0, …)`」掃描保留並強化（§3）。
 *   AC-21（§12R.2）：kill pair 之輸入組依新公式重建（§4）。
 *   AC-22（§12R.2）：判定集合重整（§5、§6）。
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
 * 檔案」，供下方零浮點中介掃描逐檔驅動。**後續 Task 於本 Phase 新增 `src`
 * 檔案時，必須將其相對路徑（相對於 `backend/`）加入本陣列**，否則新檔案不會
 * 被掃描覆蓋。清單中任何檔案不存在時，`fs.readFileSync` 會直接拋錯使測試紅
 * （fail-loud），不得靜默跳過。
 */
const PHASE_007_SRC_FILES = [
  "src/applications/depreciation-calculation.ts",
  // T3 新增（PHASE-007-T3；T2 即審 FW-7 之機械義務）。
  "src/applications/depreciation-blockers.ts",
  // T4 新增（PHASE-007-T4；同一機械義務——本檔為草稿 CRUD service，雖不含
  // 金額算術，仍納入掃描以固定「本 Phase 新增 src 檔一律零浮點中介」）。
  "src/applications/depreciation-service.ts",
  // T7 新增（PHASE-007-T7；折舊參數選版與每年折舊費用還原——`new Prisma.Decimal(字串)`
  // 之還原點，正是零浮點中介最須守住的一處）。
  "src/applications/depreciation-parameters.ts",
] as const;

/**
 * AR-3（T3 即審）：`.toNumber()` 掃描逐檔化——原本只掃 `ENGINE_SRC_PATH`
 * 一檔，新增之 src 檔可自由降轉而不被發現。本表宣告每個受掃描檔案**允許**
 * 的 `.toNumber()` 次數（金額路徑之唯一合法降轉點為最終金額）。新增檔案
 * 未列於此表時預設為 0 次。
 */
const TO_NUMBER_ALLOWANCE: Record<string, number> = {
  // 最終金額，且必須緊接於 ROUND_HALF_UP 取整之後（見下方鏈式斷言）。
  "src/applications/depreciation-calculation.ts": 1,
};

const ENGINE_SRC_PATH = path.resolve(BACKEND_ROOT, PHASE_007_SRC_FILES[0]);

/** M1（開發段建表 migration）—— `snapshotOfficialKm`／`snapshotRawAmount`／
 *  `snapshotPerKmUnitPrice` 之 DDL 權威來源。 */
const M1_MIGRATION_SQL_PATH = path.resolve(
  BACKEND_ROOT,
  "prisma/migrations/20260804120000_phase7_depreciation_model/migration.sql"
);

/** M2（修訂段 ALTER 型 migration，R1 落地）—— 新 4 欄之 DDL 權威來源。 */
const M2_MIGRATION_SQL_PATH = path.resolve(
  BACKEND_ROOT,
  "prisma/migrations/20260805090000_phase7_depreciation_revision/migration.sql"
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

/** §20.4.3 之輸入三元組簡寫（A ＝ 每年折舊費用、O ＝ 年度公務里程、I ＝ 年度總里程）。 */
function calc(A: string, O: string, I: string): CalculateDepreciationResult {
  return calculateDepreciation({
    annualDepreciation: d(A),
    officialKm: d(O),
    annualTotalKm: d(I),
  });
}

const HALF_UP = Prisma.Decimal.ROUND_HALF_UP;

// ---------------------------------------------------------------------------
// §1 AC-51(a)／§20.4.1 ⑤⑥ 公式：
//     rawAmount = annualDepreciation × officialKm ÷ annualTotalKm（先乘後除，未取整）
//     amount    = ROUND_HALF_UP(rawAmount, 0)
//
// （§12R.1 AC-19 列授權之改寫：浮點鑑別、純度、輸入不變性三條語意保留，僅換輸入組）
// ---------------------------------------------------------------------------

describe("calculateDepreciation — AC-51(a) rawAmount = annualDepreciation × officialKm ÷ annualTotalKm (multiply-then-divide, unrounded), amount = ROUND_HALF_UP(raw, 0)", () => {
  const rows: Array<{
    annualDepreciation: string;
    officialKm: string;
    annualTotalKm: string;
    rawAmount: string;
    amount: number;
    note: string;
  }> = [
    {
      annualDepreciation: "100000.00",
      officialKm: "0.00",
      annualTotalKm: "12345.6",
      rawAmount: "0",
      amount: 0,
      note: "§20.4.3 邊界正例：年度公務里程 0 → 補貼 0 元（B-09 不變，允許完成）",
    },
    {
      annualDepreciation: "100000.00",
      officialKm: "12345.6",
      annualTotalKm: "12345.6",
      rawAmount: "100000",
      amount: 100000,
      note: "§20.4.3 邊界正例：比例恰 100%（Q4）→ 金額等於每年折舊費用全額",
    },
    {
      annualDepreciation: "100000.00",
      officialKm: "6000.00",
      annualTotalKm: "12000.0",
      rawAmount: "50000",
      amount: 50000,
      note: "一般案例：比例恰 50%",
    },
    {
      annualDepreciation: "150000.00",
      officialKm: "3000.00",
      annualTotalKm: "20000.0",
      rawAmount: "22500",
      amount: 22500,
      note: "一般案例：終止小數，raw 精確可讀",
    },
    {
      annualDepreciation: "100000.00",
      officialKm: "1.00",
      annualTotalKm: "30000.0",
      rawAmount: "3.3333333333333333333",
      amount: 3,
      note: "無盡小數：先乘後除之全精度保留至 decimal.js 之 20 有效位數，小數部分 < 0.5 → 捨",
    },
    {
      annualDepreciation: "0.01",
      officialKm: "1.00",
      annualTotalKm: "1.0",
      rawAmount: "0.01",
      amount: 0,
      note: "邊界：每年折舊費用之最小正值（2dp），全精度保留於 rawAmount",
    },
  ];

  it.each(rows)(
    "A=$annualDepreciation × O=$officialKm ÷ I=$annualTotalKm → rawAmount=$rawAmount, amount=$amount ($note)",
    ({ annualDepreciation, officialKm, annualTotalKm, rawAmount, amount }) => {
      const result = calc(annualDepreciation, officialKm, annualTotalKm);
      expect(result.calculable).toBe(true);
      expect(result.rawAmount?.toString()).toBe(rawAmount);
      expect(result.amount).toBe(amount);
      // 三個輸入原樣回傳（供快照與容量 predicate 使用，未取整）
      expect(result.annualDepreciation.toString()).toBe(d(annualDepreciation).toString());
      expect(result.officialKm.toString()).toBe(d(officialKm).toString());
      expect(result.annualTotalKm.toString()).toBe(d(annualTotalKm).toString());
    }
  );

  it("AC-51(a) the function is pure: identical input yields identical output and never mutates the input Decimals", () => {
    const annualDepreciation = d("100000.00");
    const officialKm = d("1001.66");
    const annualTotalKm = d("12345.6");
    const first = calculateDepreciation({ annualDepreciation, officialKm, annualTotalKm });
    const second = calculateDepreciation({ annualDepreciation, officialKm, annualTotalKm });
    expect(first.rawAmount?.toString()).toBe(second.rawAmount?.toString());
    expect(first.ratio?.toString()).toBe(second.ratio?.toString());
    expect(first.amount).toBe(second.amount);
    expect(annualDepreciation.toString()).toBe("100000");
    expect(officialKm.toString()).toBe("1001.66");
    expect(annualTotalKm.toString()).toBe("12345.6");
  });

  it("AC-51(a) floating-point discriminator: A=100.0000 × O=0.07 ÷ I=1.0 is exactly 7 (an IEEE754 double intermediary produces 7.000000000000001)", () => {
    const result = calc("100.0000", "0.07", "1.0");
    expect(result.rawAmount?.toString()).toBe("7");
    // 對照：浮點路徑的實際產物（證明本斷言具鑑別力，而非「夠接近」）
    expect((100 * 0.07).toString()).toBe("7.000000000000001");
    expect(result.rawAmount?.toString()).not.toBe((100 * 0.07).toString());
    expect(result.amount).toBe(7);
  });

  it("AC-51(a) annualDepreciation is restored from the engine's fixed 2-decimal string with no Number()/parseFloat mediation (engine reachability of the PRIMARY kill case)", () => {
    // §20.4.3 引擎可達性檢查逐字：「`annualDepreciation="100000.00"` ＝
    // `deriveAnnualDepreciation({ vehiclePrice: "300000.00", usefulLifeYears: 3 })`
    // 之實際輸出（已驗）」。`deriveAnnualDepreciation` 屬 R4a；其每年費用語意與
    // 既有 `deriveDepreciation.annualDepreciation` **完全一致**（AC-49(a) 逐字），
    // 故本 Task 以既有引擎之同一欄位證明可達性。
    const derived = deriveDepreciation({
      vehiclePrice: new Prisma.Decimal("300000.00"),
      usefulLifeYears: 3,
      estimatedAnnualKm: 15000,
    });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.annualDepreciation).toBe("100000.00");

    // §20.4.1 ③：以 `new Prisma.Decimal(字串)` 還原，逐位元保留 2 位小數語意。
    const annualDepreciation = new Prisma.Decimal(derived.annualDepreciation);
    const result = calculateDepreciation({
      annualDepreciation,
      officialKm: d("1001.66"),
      annualTotalKm: d("12345.6"),
    });
    expect(result.rawAmount?.toString()).toBe("8113.4979263867288751");
    expect(result.amount).toBe(8113);
  });

  it("AC-51(b) annualDepreciation is never re-rounded: a 2-decimal source value passes through byte-for-byte into the result", () => {
    const result = calc("0.01", "1.00", "1.0");
    // 若對每年折舊費用再取整（例如至整數）→ 0 → rawAmount 0；本列以完整字串鑑別。
    expect(result.annualDepreciation.toString()).toBe("0.01");
    expect(result.rawAmount?.toString()).toBe("0.01");
  });
});

// ---------------------------------------------------------------------------
// §2 AC-50 公務比例（顯示值，不參與金額）
// ---------------------------------------------------------------------------

describe("calculateDepreciation — AC-50(a)(b) ratio = officialKm ÷ annualTotalKm at full precision; ratioString(6dp)/ratioPercentString(4dp) are display-only", () => {
  const rows: Array<{
    annualDepreciation: string;
    officialKm: string;
    annualTotalKm: string;
    ratio: string;
    ratioString: string;
    ratioPercentString: string;
    note: string;
  }> = [
    {
      annualDepreciation: "100000.00",
      officialKm: "1001.66",
      annualTotalKm: "12345.6",
      ratio: "0.081134979263867288751",
      ratioString: "0.081135",
      ratioPercentString: "8.1135",
      note: "§20.4.3 PRIMARY：全精度 ratio 與 6dp／4dp 顯示字串逐字",
    },
    {
      annualDepreciation: "100000.00",
      officialKm: "12345.6",
      annualTotalKm: "12345.6",
      ratio: "1",
      ratioString: "1.000000",
      ratioPercentString: "100.0000",
      note: "§20.4.3 邊界正例：比例恰 100%（顯示字串補足位數）",
    },
    {
      annualDepreciation: "100000.00",
      officialKm: "0.00",
      annualTotalKm: "12345.6",
      ratio: "0",
      ratioString: "0.000000",
      ratioPercentString: "0.0000",
      note: "§20.4.3 邊界正例：公務里程 0",
    },
    {
      annualDepreciation: "100000.00",
      officialKm: "4000.09",
      annualTotalKm: "20000.0",
      ratio: "0.2000045",
      ratioString: "0.200005",
      ratioPercentString: "20.0005",
      note: "§20.4.3 SECONDARY：6dp 顯示發生 ROUND_HALF_UP 進位（0.2000045 → 0.200005）",
    },
  ];

  it.each(rows)(
    "O=$officialKm ÷ I=$annualTotalKm → ratio=$ratio, ratioString=$ratioString, ratioPercentString=$ratioPercentString ($note)",
    ({ annualDepreciation, officialKm, annualTotalKm, ratio, ratioString, ratioPercentString }) => {
      const result = calc(annualDepreciation, officialKm, annualTotalKm);
      expect(result.calculable).toBe(true);
      expect(result.ratio?.toString()).toBe(ratio);
      expect(result.ratioString).toBe(ratioString);
      expect(result.ratioPercentString).toBe(ratioPercentString);
    }
  );

  it("AC-50(a) ratio is NOT pre-rounded: the full-precision ratio keeps far more digits than the 6dp display string", () => {
    const result = calc("100000.00", "1001.66", "12345.6");
    expect(result.ratio?.toString()).toBe("0.081134979263867288751");
    expect(result.ratio?.toString()).not.toBe(result.ratioString);
    expect((result.ratioString as string).length).toBeLessThan(
      (result.ratio as Prisma.Decimal).toString().length
    );
  });

  it("AC-50(b) ratioPercentString is exactly ratio × 100 at 4dp (比照 MaintenanceApplication 之既有精度組)", () => {
    const result = calc("100000.00", "1001.66", "12345.6");
    const expected = (result.ratio as Prisma.Decimal)
      .times(new Prisma.Decimal("100"))
      .toFixed(4, HALF_UP);
    expect(result.ratioPercentString).toBe(expected);
    expect(result.ratioPercentString).toBe("8.1135");
  });
});

describe("calculateDepreciation — AC-50(c) the ratio NEVER feeds the amount (kill case for the `.times(ratio)` mutant)", () => {
  /**
   * §20.4.3「R2 之回填義務」之交付：`.times(ratio)` mutant 之鑑別數對。
   *
   * **窮舉搜尋之構造與範圍（Handoff 同步記載）**：
   *   令 `A = a/100`（2dp）、`O = 5k`（k 為奇數，整數里程，2dp 合法）、
   *   `I = a/10`（1dp），則 `raw = A·O/I = k/2` **恆為 .5 結尾之精確值**，
   *   且 `ratio = O/I = 50k/a` 於 `a` 含 2、5 以外之質因數時為無盡小數。
   *   於 `k = 19999`（使 raw 之尾數趨近 9999.5，最大化 20 有效位數之 ulp 效應）、
   *   `a ∈ [10·O, 10·O + 400000)`（即 `I ∈ [99995.0, 139995.0)`，滿足
   *   `O ≤ I`（AC-52 比例 ≤ 100%）、`I < 1e8`（Decimal(9,1)）、
   *   `A < 1e10`（Decimal(12,2)））之範圍內掃描 4165 組，**命中 5 組**，
   *   取字典序第一組為本測試之 kill case。
   *
   * 結論：`.times(ratio)` mutant **在合法值域內可達且可鑑別**，故本節以實際
   * 數對（而非結構性斷言）落地 AC-50(c)。§3 另有原始碼層之結構性掃描作為
   * 第二道防線。
   */
  const A = "10004.17";
  const O = "99995.00";
  const I = "100041.7";

  it("KILL CASE — A=10004.17 × O=99995.00 ÷ I=100041.7 → raw is EXACTLY 9999.5 → amount=10000, while `annualDepreciation.times(ratio)` yields 9999.4999999999999999 → 9999 (must go red)", () => {
    const result = calc(A, O, I);
    expect(result.calculable).toBe(true);
    expect(result.rawAmount?.toString()).toBe("9999.5");
    expect(result.amount).toBe(10000);

    // mutant：以 `annualDepreciation.times(ratio)` 求 rawAmount（§20.4.1 禁止段第一項）
    const mutant = d(A).times(result.ratio as Prisma.Decimal);
    expect(mutant.toString()).toBe("9999.4999999999999999");
    expect(mutant.toDecimalPlaces(0, HALF_UP).toNumber()).toBe(9999);
    expect(mutant.toDecimalPlaces(0, HALF_UP).toNumber()).not.toBe(result.amount);
  });

  it("KILL CASE 自證：the mutant's divergence comes from decimal.js's 20-significant-digit precision on the intermediate ratio, not from a test artefact", () => {
    expect(Prisma.Decimal.precision).toBe(20);
    const ratio = d(O).div(d(I));
    // ratio 為無盡小數，已在第 20 有效位數捨入 → 乘回 A 時失去「恰為 .5」之邊界。
    expect(ratio.toString()).toBe("0.99953319465782768585");
    expect(d(A).times(d(O)).div(d(I)).toString()).toBe("9999.5");
    expect(d(A).times(ratio).toString()).toBe("9999.4999999999999999");
  });

  it("KILL CASE 可達性：A=10004.17 is a genuine engine output (vehiclePrice 30012.51 ÷ usefulLifeYears 3 at 2dp)", () => {
    const derived = deriveDepreciation({
      vehiclePrice: new Prisma.Decimal("30012.51"),
      usefulLifeYears: 3,
      estimatedAnnualKm: 15000,
    });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.annualDepreciation).toBe("10004.17");
  });

  it("AC-50(c) 結構性斷言（第二道防線）：the implementation never multiplies by the ratio nor by its display strings", () => {
    const blanked = blankCommentsAndStrings(fs.readFileSync(ENGINE_SRC_PATH, "utf8"));
    expect(blanked).not.toMatch(/\.times\(\s*ratio\s*\)/);
    expect(blanked).not.toMatch(/\.times\(\s*ratioString\s*\)/);
    expect(blanked).not.toMatch(/\.times\(\s*ratioPercentString\s*\)/);
    // 正向：rawAmount 必須以「先乘後除」求值（AC-51(a) 逐字）。
    expect(blanked).toMatch(
      /annualDepreciation\s*\.times\(\s*officialKm\s*\)\s*\.div\(\s*annualTotalKm\s*\)/
    );
    // 掃描器鑑別力自證：合成的 mutant 片段必被上述樣式命中。
    const mutantSnippet = blankCommentsAndStrings(
      "const rawAmount = annualDepreciation.times(ratio);"
    );
    expect(mutantSnippet).toMatch(/\.times\(\s*ratio\s*\)/);
  });
});

// ---------------------------------------------------------------------------
// §3 AC-51(b)(c)(d) 取整層級：全 Phase 恰一處取整（最終金額）
//     §20.4.3 PRIMARY／SECONDARY kill case
// ---------------------------------------------------------------------------

/** §20.4.3 之四種取整層級 mutant，逐一以獨立算式重現（不改動實作即可比對）。 */
function mutantAmounts(A: string, O: string, I: string) {
  const a = d(A);
  const o = d(O);
  const i = d(I);
  const ratio = o.div(i);
  const raw = a.times(o).div(i);
  return {
    /** mutant A：先取整比例至 6dp 再相乘。 */
    ratio6: a
      .times(d(ratio.toFixed(6, HALF_UP)))
      .toDecimalPlaces(0, HALF_UP)
      .toNumber(),
    /** mutant B：先取整比例至 4dp 再相乘。 */
    ratio4: a
      .times(d(ratio.toFixed(4, HALF_UP)))
      .toDecimalPlaces(0, HALF_UP)
      .toNumber(),
    /** mutant C：先取整 rawAmount 至 2dp。 */
    raw2: raw.toDecimalPlaces(2, HALF_UP).toDecimalPlaces(0, HALF_UP).toNumber(),
    /** mutant D：先取整 officialKm 至整數。 */
    okmInt: a.times(o.toDecimalPlaces(0, HALF_UP)).div(i).toDecimalPlaces(0, HALF_UP).toNumber(),
  };
}

describe("calculateDepreciation — AC-51(c) §20.4.3 PRIMARY kill case discriminates ALL FOUR rounding-layer mutants", () => {
  const A = "100000.00";
  const O = "1001.66";
  const I = "12345.6";

  it("PRIMARY — A=100000.00 × O=1001.66 ÷ I=12345.6 → raw=8113.4979263867288751 → amount=8113", () => {
    const result = calc(A, O, I);
    expect(result.rawAmount?.toString()).toBe("8113.4979263867288751");
    expect(result.amount).toBe(8113);
    expect(result.ratioString).toBe("0.081135");
    expect(result.ratioPercentString).toBe("8.1135");
  });

  it("PRIMARY mutant A — pre-rounding the ratio to 6dp yields 8114 (≠ 8113, must go red)", () => {
    const result = calc(A, O, I);
    expect(mutantAmounts(A, O, I).ratio6).toBe(8114);
    expect(mutantAmounts(A, O, I).ratio6).not.toBe(result.amount);
  });

  it("PRIMARY mutant B — pre-rounding the ratio to 4dp yields 8110 (≠ 8113, must go red)", () => {
    const result = calc(A, O, I);
    expect(mutantAmounts(A, O, I).ratio4).toBe(8110);
    expect(mutantAmounts(A, O, I).ratio4).not.toBe(result.amount);
  });

  it("PRIMARY mutant C — pre-rounding rawAmount to 2dp yields 8114 (≠ 8113, must go red)", () => {
    const result = calc(A, O, I);
    expect(mutantAmounts(A, O, I).raw2).toBe(8114);
    expect(mutantAmounts(A, O, I).raw2).not.toBe(result.amount);
  });

  it("PRIMARY mutant D — pre-rounding officialKm to an integer yields 8116 (≠ 8113, must go red)", () => {
    const result = calc(A, O, I);
    expect(mutantAmounts(A, O, I).okmInt).toBe(8116);
    expect(mutantAmounts(A, O, I).okmInt).not.toBe(result.amount);
  });
});

describe("calculateDepreciation — AC-51(c) §20.4.3 SECONDARY kill case (independent discrimination of a pre-rounded ratio)", () => {
  const A = "100000.00";
  const O = "4000.09";
  const I = "20000.0";

  it("SECONDARY — A=100000.00 × O=4000.09 ÷ I=20000.0 → raw=20000.45 → amount=20000", () => {
    const result = calc(A, O, I);
    expect(result.rawAmount?.toString()).toBe("20000.45");
    expect(result.amount).toBe(20000);
  });

  it("SECONDARY mutant A — pre-rounding the ratio to 6dp yields 20001 (≠ 20000, must go red); mutant C is deliberately blind here (raw is exactly 2dp)", () => {
    const result = calc(A, O, I);
    const mutants = mutantAmounts(A, O, I);
    expect(mutants.ratio6).toBe(20001);
    expect(mutants.ratio6).not.toBe(result.amount);
    // §20.4.3 明文：「`rawAmount` 恰為 2dp，故 mutant C 於此列不鑑別」——明文
    // 記錄，避免誤以為單列足以覆蓋四種 mutant。
    expect(mutants.raw2).toBe(20000);
    expect(mutants.raw2).toBe(result.amount);
  });
});

describe("calculateDepreciation — AC-51(b)(d) rounding happens exactly once (source-level scan)", () => {
  it("AC-51(d) source-level scan: exactly one toDecimalPlaces() call exists in the implementation (the final amount)", () => {
    const blanked = blankCommentsAndStrings(fs.readFileSync(ENGINE_SRC_PATH, "utf8"));
    const occurrences = blanked.match(/\.toDecimalPlaces\(/g) ?? [];
    expect(occurrences.length).toBe(1);
    // 且該處必為 `toDecimalPlaces(0, …)`（取整為整數），不得是 2dp／6dp 之預先取整。
    expect(blanked).toMatch(/\.toDecimalPlaces\(\s*0\s*,/);
  });

  it("AC-51(a) source-level scan (T2 即審 AR-2 補強): exactly one .toNumber() call exists and it sits immediately after the ROUND_HALF_UP rounding — kills a 'real double intermediary' mutant", () => {
    const blanked = blankCommentsAndStrings(fs.readFileSync(ENGINE_SRC_PATH, "utf8"));
    const occurrences = blanked.match(/\.toNumber\(/g) ?? [];
    expect(occurrences.length).toBe(1);
    expect(blanked).toMatch(/\.toDecimalPlaces\([^)]*\)\.toNumber\(\)/);
    // 掃描器鑑別力自證：合成的 double 中介片段必被計為 3 次且不匹配取整鏈。
    const doubleIntermediary = blankCommentsAndStrings(
      "const raw = annualDepreciation.toNumber() * officialKm.toNumber() / annualTotalKm.toNumber();"
    );
    expect((doubleIntermediary.match(/\.toNumber\(/g) ?? []).length).toBe(3);
    expect(doubleIntermediary).not.toMatch(/\.toDecimalPlaces\([^)]*\)\.toNumber\(\)/);
  });

  it("AC-51(d) source-level scan: the only toFixed() calls are the two DISPLAY strings (6dp ratio, 4dp percent) — never on the amount path", () => {
    const blanked = blankCommentsAndStrings(fs.readFileSync(ENGINE_SRC_PATH, "utf8"));
    expect((blanked.match(/\.toFixed\(/g) ?? []).length).toBe(2);
    // 方法鏈可能被 formatter 折行，故先把「點號周邊的空白」收斂回單一鏈式字串，
    // 再逐一比對受詞——兩處皆以 `ratio` 為受詞（顯示值），且皆不參與
    // `rawAmount`／`amount`。
    const chained = blanked.replace(/\s*\.\s*/g, ".");
    const toFixedCalls = chained.match(/[\w$.()[\]]+\.toFixed\([^)]*\)/g) ?? [];
    expect(toFixedCalls.length).toBe(2);
    for (const call of toFixedCalls) {
      expect(call).toMatch(/^ratio(\.times\(PERCENT_MULTIPLIER\))?\.toFixed\(/);
    }
    expect(chained).not.toMatch(/rawAmount\.toFixed\(/);
    expect(chained).not.toMatch(/amount\s*=\s*[^;]*\.toFixed\(/);
    // 掃描器鑑別力自證：合成的「對金額 toFixed」片段必被上述受詞斷言拒絕。
    const mutantChained = blankCommentsAndStrings(
      "const amount = rawAmount.toFixed(0, Prisma.Decimal.ROUND_HALF_UP);"
    ).replace(/\s*\.\s*/g, ".");
    expect(mutantChained).toMatch(/rawAmount\.toFixed\(/);
  });

  it("AC-51(d) source-level scan: no round()/trunc()/ceil()/floor()/Math.* rounding anywhere", () => {
    const blanked = blankCommentsAndStrings(fs.readFileSync(ENGINE_SRC_PATH, "utf8"));
    expect(blanked.match(/\.(round|trunc|ceil|floor)\(/g)).toBeNull();
    expect(blanked.match(/Math\./g)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §4 AC-21 取整方向：ROUND_HALF_UP（0.5 進位、away from zero），非銀行家
//     §20.4.3「`ROUND_HALF_UP` kill pair（取代 AC-21 之舊數對）」
// ---------------------------------------------------------------------------

describe("calculateDepreciation — AC-21 rounding is ROUND_HALF_UP (away from zero), never ROUND_HALF_EVEN", () => {
  it("kill pair row 1 (鑑別) — A=100000.00 × O=4000.10 ÷ I=20000.0 → raw=20000.5 → amount=20001 (ROUND_HALF_EVEN mutant yields 20000, must go red)", () => {
    const result = calc("100000.00", "4000.10", "20000.0");
    expect(result.rawAmount?.toString()).toBe("20000.5");
    expect(result.amount).toBe(20001);
    // 反例自證：half-even 於本列確實得 20000（證明本列具鑑別力）
    const halfEven = d("20000.5").toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_EVEN).toNumber();
    expect(halfEven).toBe(20000);
    expect(halfEven).not.toBe(result.amount);
  });

  it("kill pair row 2 (配對，證 away-from-zero) — A=100000.00 × O=4000.30 ÷ I=20000.0 → raw=20001.5 → amount=20002 (half-even also yields 20002: pairs with row 1 to prove 'away from zero', not 'always down')", () => {
    const result = calc("100000.00", "4000.30", "20000.0");
    expect(result.rawAmount?.toString()).toBe("20001.5");
    expect(result.amount).toBe(20002);
    // 本列對 half-even 不鑑別（half-even 亦得 20002）——明文記錄。
    expect(d("20001.5").toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_EVEN).toNumber()).toBe(20002);
  });

  it("minimal discriminating pair — raw just below .5 rounds down, raw exactly .5 rounds up", () => {
    const below = calc("100000.00", "4000.09", "20000.0");
    expect(below.rawAmount?.toString()).toBe("20000.45");
    expect(below.amount).toBe(20000);

    const at = calc("100000.00", "4000.10", "20000.0");
    expect(at.rawAmount?.toString()).toBe("20000.5");
    expect(at.amount).toBe(20001);
  });

  it("half-up applies away from zero for negative raw amounts too (defensive: never silently 0, never NaN)", () => {
    // 負公務里程於本 Phase 不可達（`sumOfficialMileage` 之 SUM ≥ 0），但若真的
    // 發生，函式必須忠實回報負值——**不得**靜默回 0（005a T2 SF-1「絕不靜默回
    // 0」之直接對象），亦不得回 NaN。
    const result = calc("100000.00", "-0.10", "20000.0");
    expect(result.calculable).toBe(true);
    expect(result.rawAmount?.toString()).toBe("-0.5");
    expect(result.amount).toBe(-1); // away from zero
    expect(result.amount).not.toBe(0);
    expect(Number.isNaN(result.amount as number)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §5 AC-50(d)／§20.4.1 除零守門 —— 三重守門
//     （005a T2 SF-1／006 T2R MF-1 同型；「絕不除以零、絕不回 NaN／Infinity、
//       絕不靜默回 0」逐字）
// ---------------------------------------------------------------------------

/** `calculable=false` 之回傳形狀：其餘欄位一律 `null`（§20.4.1 逐字）。 */
function expectNotCalculable(result: CalculateDepreciationResult): void {
  expect(result.calculable).toBe(false);
  expect(result.ratio).toBeNull();
  expect(result.ratioString).toBeNull();
  expect(result.ratioPercentString).toBeNull();
  expect(result.rawAmount).toBeNull();
  expect(result.amount).toBeNull();
  // 絕不靜默回 0（005a T2 SF-1 逐字）
  expect(result.amount).not.toBe(0);
}

describe("calculateDepreciation — AC-50(d) triple guard: non-finite inputs and annualTotalKm ≤ 0 (never divides by zero, never returns NaN/Infinity, never silently returns 0, never throws)", () => {
  const nonFinite: Array<{ label: string; value: Prisma.Decimal }> = [
    { label: "NaN", value: d("NaN") },
    { label: "+Infinity", value: d("Infinity") },
    { label: "-Infinity", value: d("-Infinity") },
  ];

  it.each(nonFinite)(
    "guard 1a — annualDepreciation = $label → calculable=false, all derived fields null",
    ({ value }) => {
      expectNotCalculable(
        calculateDepreciation({
          annualDepreciation: value,
          officialKm: d("1001.66"),
          annualTotalKm: d("12345.6"),
        })
      );
    }
  );

  it.each(nonFinite)(
    "guard 1b — officialKm = $label → calculable=false, all derived fields null",
    ({ value }) => {
      expectNotCalculable(
        calculateDepreciation({
          annualDepreciation: d("100000.00"),
          officialKm: value,
          annualTotalKm: d("12345.6"),
        })
      );
    }
  );

  it.each(nonFinite)(
    "guard 1c — annualTotalKm = $label → calculable=false, all derived fields null",
    ({ value }) => {
      expectNotCalculable(
        calculateDepreciation({
          annualDepreciation: d("100000.00"),
          officialKm: d("1001.66"),
          annualTotalKm: value,
        })
      );
    }
  );

  const nonPositiveTotals = ["0", "0.0", "-0.1", "-20000.0"];

  it.each(nonPositiveTotals)(
    "guard 2 (除零) — annualTotalKm = %s (≤ 0) → calculable=false, all derived fields null (never Infinity, never NaN)",
    (total) => {
      const result = calc("100000.00", "1001.66", total);
      expectNotCalculable(result);
    }
  );

  it("guard 2 自證：a naked division by zero would have produced Infinity — the guard is what prevents it from reaching `amount`", () => {
    // decimal.js 對 x/0 拋 DivisionByZero？否——`Prisma.Decimal` 之 div(0) 回
    // `Infinity`（非有限值）。本列固定「若無守門會發生什麼」，證明守門有意義。
    expect(d("1001.66").div(d("0")).isFinite()).toBe(false);
    expect(d("1001.66").div(d("0")).toString()).toBe("Infinity");
    // 而函式回傳形狀完全不含該非有限值。
    const result = calc("100000.00", "1001.66", "0");
    expect(result.rawAmount).toBeNull();
    expect(result.amount).toBeNull();
  });

  it("NaN never leaks into a truthy-looking comparison: the guard is `.isFinite()`, not a comparison (005a T2 SF-1 根因)", () => {
    // `Decimal` 與 NaN 的比較恆為 false，故「以比較式當守門」會靜默穿透。
    expect(d("NaN").greaterThan(0)).toBe(false);
    expect(d("NaN").lessThanOrEqualTo(0)).toBe(false);
    const result = calculateDepreciation({
      annualDepreciation: d("NaN"),
      officialKm: d("NaN"),
      annualTotalKm: d("NaN"),
    });
    expectNotCalculable(result);
    expect(result.annualTotalKm.isNaN()).toBe(true);
  });

  it("guard 3 — the computed ratio/rawAmount are themselves checked for finiteness before the final rounding", () => {
    // 極端但有限之輸入：分母極小、分子極大 → 乘除結果仍為有限值，函式忠實回報。
    const result = calc("9999999999.99", "9999999999.99", "0.1");
    expect(result.calculable).toBe(true);
    expect(result.rawAmount?.isFinite()).toBe(true);
    expect(Number.isFinite(result.amount as number)).toBe(true);
  });

  it("never throws for any non-finite / extreme input combination (3^6 sweep)", () => {
    const extremes = [d("NaN"), d("Infinity"), d("-Infinity"), d("0"), d("1e30"), d("-1e30")];
    for (const a of extremes) {
      for (const o of extremes) {
        for (const i of extremes) {
          expect(() =>
            calculateDepreciation({ annualDepreciation: a, officialKm: o, annualTotalKm: i })
          ).not.toThrow();
        }
      }
    }
  });

  it("invariant sweep — whenever calculable=false, EVERY derived field is null (no partial results leak)", () => {
    const values = [d("NaN"), d("Infinity"), d("-Infinity"), d("0"), d("-1"), d("100000.00")];
    let sawNotCalculable = false;
    for (const a of values) {
      for (const o of values) {
        for (const i of values) {
          const result = calculateDepreciation({
            annualDepreciation: a,
            officialKm: o,
            annualTotalKm: i,
          });
          if (!result.calculable) {
            sawNotCalculable = true;
            expect(result.ratio).toBeNull();
            expect(result.ratioString).toBeNull();
            expect(result.ratioPercentString).toBeNull();
            expect(result.rawAmount).toBeNull();
            expect(result.amount).toBeNull();
          } else {
            expect(result.ratio).not.toBeNull();
            expect(result.ratioString).not.toBeNull();
            expect(result.ratioPercentString).not.toBeNull();
            expect(result.rawAmount).not.toBeNull();
            expect(result.amount).not.toBeNull();
          }
        }
      }
    }
    expect(sawNotCalculable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §6 AC-22(a)(d) 容量 predicate（判定層）—— §20.7.2 之新判定集合
// ---------------------------------------------------------------------------

function syntheticResult(
  overrides: Partial<CalculateDepreciationResult>
): CalculateDepreciationResult {
  return {
    annualDepreciation: d("1"),
    officialKm: d("1"),
    annualTotalKm: d("1"),
    calculable: true,
    ratio: d("1"),
    ratioString: "1.000000",
    ratioPercentString: "100.0000",
    rawAmount: d("1"),
    amount: 1,
    ...overrides,
  };
}

describe("isDepreciationCalculationOverCapacity — AC-22(a)(d) §20.7.2 判定集合重整（六項），boundary positives included (no false kills, no silent truncation)", () => {
  it("a normal result is within capacity", () => {
    expect(isDepreciationCalculationOverCapacity(calc("100000.00", "1001.66", "12345.6"))).toBe(
      false
    );
  });

  /** §20.7.2 之判定集合：五個 Decimal 欄位 ＋ `totalAmount`（int4）。 */
  const decimalBoundaries: Array<{
    field: "annualDepreciation" | "officialKm" | "annualTotalKm" | "ratio" | "rawAmount";
    constantKey:
      | "snapshotAnnualDepreciation"
      | "snapshotOfficialKm"
      | "snapshotAnnualTotalKm"
      | "snapshotRatio"
      | "snapshotRawAmount";
    justUnder: string;
    atBound: string;
    column: string;
  }> = [
    {
      field: "annualDepreciation",
      constantKey: "snapshotAnnualDepreciation",
      justUnder: "9999999999.99",
      atBound: "10000000000",
      column: "snapshotAnnualDepreciation Decimal(12,2)",
    },
    {
      field: "officialKm",
      constantKey: "snapshotOfficialKm",
      justUnder: "9999999999.99",
      atBound: "10000000000",
      column: "snapshotOfficialKm Decimal(12,2)",
    },
    {
      field: "annualTotalKm",
      constantKey: "snapshotAnnualTotalKm",
      justUnder: "99999999.9",
      atBound: "100000000",
      column: "snapshotAnnualTotalKm Decimal(9,1)",
    },
    {
      field: "ratio",
      constantKey: "snapshotRatio",
      justUnder: "999.999999",
      atBound: "1000",
      column: "snapshotRatio Decimal(9,6)",
    },
    {
      field: "rawAmount",
      constantKey: "snapshotRawAmount",
      justUnder: "9999999999.9999",
      atBound: "10000000000",
      column: "snapshotRawAmount Decimal(14,4)",
    },
  ];

  it.each(decimalBoundaries)(
    "$field just under its bound ($justUnder) is within capacity ($column boundary positive)",
    ({ field, justUnder }) => {
      const result = syntheticResult({
        [field]: d(justUnder),
      } as Partial<CalculateDepreciationResult>);
      expect(isDepreciationCalculationOverCapacity(result)).toBe(false);
    }
  );

  it.each(decimalBoundaries)(
    "$field at exactly its bound ($atBound) is over capacity ($column)",
    ({ field, atBound }) => {
      const result = syntheticResult({
        [field]: d(atBound),
      } as Partial<CalculateDepreciationResult>);
      expect(isDepreciationCalculationOverCapacity(result)).toBe(true);
    }
  );

  it.each(decimalBoundaries)(
    "$field at exactly −(its bound) is over capacity (abs() is used)",
    ({ field, atBound }) => {
      const result = syntheticResult({
        [field]: d(`-${atBound}`),
      } as Partial<CalculateDepreciationResult>);
      expect(isDepreciationCalculationOverCapacity(result)).toBe(true);
    }
  );

  it("each bound equals 10^(precision − scale) of its target column (零魔術數，AC-22(a))", () => {
    for (const { constantKey } of decimalBoundaries) {
      const constant = DEPRECIATION_COLUMN_CAPACITY[constantKey];
      expect(constant.bound.toString()).toBe(
        new Prisma.Decimal("10").pow(constant.precision - constant.scale).toString()
      );
    }
  });

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

  it("§20.7.2 — `amount` 超 int4 於新模型仍可達（車價 ≥ 2.15e9 且比例接近 1），故 AMOUNT_OUT_OF_RANGE 之守門一律保留", () => {
    // 每年折舊費用 3,000,000,000.00（車價 9e9 ÷ 3 年）、比例 ~100%。
    const result = calc("3000000000.00", "20000.00", "20000.0");
    expect(result.calculable).toBe(true);
    expect(result.amount).toBe(3000000000);
    expect(isDepreciationCalculationOverCapacity(result)).toBe(true);
  });

  it("§20.7.2 — `snapshotPerKmUnitPrice` 已退出判定集合：a legacy-only column no longer participates in the verdict (its DDL constant is retained for the frozen legacy rows)", () => {
    // 常數保留（凍結唯讀欄仍為 Decimal(14,4)），但 predicate 不再引用它。
    expect(DEPRECIATION_COLUMN_CAPACITY.snapshotPerKmUnitPrice.precision).toBe(14);
    expect(DEPRECIATION_COLUMN_CAPACITY.snapshotPerKmUnitPrice.scale).toBe(4);
    const blanked = blankCommentsAndStrings(fs.readFileSync(ENGINE_SRC_PATH, "utf8"));
    const predicateStart = blanked.indexOf("export function isDepreciationCalculationOverCapacity");
    expect(predicateStart).toBeGreaterThan(-1);
    expect(blanked.slice(predicateStart)).not.toMatch(/snapshotPerKmUnitPrice/);
  });

  it("FW-2 — an over-capacity input is REJECTED by the predicate, never thrown (Postgres 22003 numeric overflow would otherwise surface as a 500)", () => {
    const overflowing = calc("9999999999.99", "9999999999.99", "0.1");
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
    const result = calc("9999999999.99", "9999999999.99", "0.1");
    const rawBefore = result.rawAmount?.toString();
    const amountBefore = result.amount;
    const ratioBefore = result.ratio?.toString();
    isDepreciationCalculationOverCapacity(result);
    expect(result.rawAmount?.toString()).toBe(rawBefore);
    expect(result.amount).toBe(amountBefore);
    expect(result.ratio?.toString()).toBe(ratioBefore);
  });

  it("a non-calculable result is reported as over capacity — no finite column can hold it, so the caller raises AMOUNT_OUT_OF_RANGE", () => {
    const result = calc("100000.00", "1001.66", "0");
    expect(result.calculable).toBe(false);
    expect(isDepreciationCalculationOverCapacity(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §7 T1 即審 FW-1 —— 容量常數 ↔ **實際套用之 DDL** 之對照
//
// 背景（PROJECT_STATE「T1 即審 FW」）：reviewer 已證「只改 schema.prisma 而不
// 動 migration，全套測試仍全綠」——故容量常數若僅綁 schema.prisma 之心智模型
// 即為空頭承諾。本節以**實際套用到 Postgres 的 DDL（migration SQL）**為權威
// 來源，並同時要求 schema.prisma 與該 DDL 一致：
//   ① 常數 ≠ migration DDL 精度 → 紅（常數脫鉤）
//   ② schema.prisma ≠ migration DDL → 紅（schema-only 改動不再靜默通過）
// 修訂段增補：新 4 欄之 DDL 位於 **M2（ALTER 型）**，既有欄位位於 M1（CREATE
// 型），故讀取器須橫跨兩檔且在命中數 ≠ 1 時 fail-loud。
// 本層刻意不連 DB（單元層零 IO，§11.1「不需 DB」）；`information_schema` 之
// 實查已由 R1 之 `phase7-migration-safety.test.ts`（整合層）覆蓋，兩層合起來
// 構成完整鏈：常數 ↔ migration DDL ↔ 實際 DB 欄位。
// ---------------------------------------------------------------------------

function extractCreateTableBody(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE "${table}" (`);
  if (start < 0) throw new Error(`CREATE TABLE "${table}" not found`);
  const end = sql.indexOf("\n);", start);
  if (end < 0) throw new Error(`end of CREATE TABLE "${table}" not found`);
  return sql.slice(start, end);
}

function extractAlterTableBody(sql: string, table: string): string {
  const start = sql.indexOf(`ALTER TABLE "${table}"`);
  if (start < 0) return "";
  const end = sql.indexOf(";", start);
  if (end < 0) throw new Error(`end of ALTER TABLE "${table}" not found`);
  return sql.slice(start, end);
}

/**
 * 由**實際套用之 migration DDL**（M1 建表 ＋ M2 ALTER）讀出某欄之
 * `DECIMAL(p,s)`。命中數必須恰為 1——0 次（欄位不存在／拼錯）與 2 次
 * （同欄被兩份 migration 宣告，代表 migration 序列有誤）皆 fail-loud。
 */
function readAppliedDecimalPrecision(
  sources: Array<{ label: string; body: string }>,
  column: string
): { precision: number; scale: number } {
  const pattern = new RegExp(`"${column}"\\s+DECIMAL\\((\\d+),\\s*(\\d+)\\)`, "i");
  const hits = sources
    .map(({ label, body }) => ({ label, match: body.match(pattern) }))
    .filter((hit) => hit.match !== null);
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one applied DDL for column "${column}", found ${hits.length} (${hits
        .map((h) => h.label)
        .join(", ")})`
    );
  }
  const match = hits[0].match as RegExpMatchArray;
  return { precision: Number.parseInt(match[1], 10), scale: Number.parseInt(match[2], 10) };
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

describe("T1 FW-1 — capacity constants are pinned to the ACTUAL applied DDL (M1 CREATE ＋ M2 ALTER), not to a schema.prisma mental model", () => {
  const m1Sql = fs.readFileSync(M1_MIGRATION_SQL_PATH, "utf8");
  const m2Sql = fs.readFileSync(M2_MIGRATION_SQL_PATH, "utf8");
  const schemaPrisma = fs.readFileSync(SCHEMA_PRISMA_PATH, "utf8");

  const appliedSources = [
    { label: "M1 CREATE TABLE", body: extractCreateTableBody(m1Sql, "DepreciationApplication") },
    { label: "M2 ALTER TABLE", body: extractAlterTableBody(m2Sql, "DepreciationApplication") },
  ];

  /**
   * 全部受常數表管轄之 Decimal 欄位（含已退出 predicate 判定集合但**仍須**維持
   * DDL 形狀斷言之 `snapshotPerKmUnitPrice`——R1 即審 FW-⑦ 明令勿誤刪）。
   */
  const decimalColumns = [
    { constantKey: "snapshotAnnualDepreciation", column: "snapshotAnnualDepreciation" },
    { constantKey: "snapshotOfficialKm", column: "snapshotOfficialKm" },
    { constantKey: "snapshotAnnualTotalKm", column: "snapshotAnnualTotalKm" },
    { constantKey: "snapshotRatio", column: "snapshotRatio" },
    { constantKey: "snapshotRawAmount", column: "snapshotRawAmount" },
    { constantKey: "snapshotPerKmUnitPrice", column: "snapshotPerKmUnitPrice" },
  ] as const;

  it("sanity: both migration DDLs being read are the real ones", () => {
    expect(m1Sql).toContain('CREATE TABLE "DepreciationApplication"');
    expect(m2Sql).toContain('ALTER TABLE "DepreciationApplication"');
    expect(appliedSources[1].body).toContain('ADD COLUMN     "snapshotRatio" DECIMAL(9,6)');
  });

  it.each(decimalColumns)(
    "$column — named constant precision/scale equals the DECIMAL(p,s) in the applied migration DDL",
    ({ constantKey, column }) => {
      const ddl = readAppliedDecimalPrecision(appliedSources, column);
      const constant = DEPRECIATION_COLUMN_CAPACITY[constantKey];
      expect({ precision: constant.precision, scale: constant.scale }).toEqual(ddl);
    }
  );

  it.each(decimalColumns)(
    "$column — schema.prisma @db.Decimal(p,s) equals the applied migration DDL (a schema-only edit can no longer pass silently)",
    ({ column }) => {
      const ddl = readAppliedDecimalPrecision(appliedSources, column);
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

  it("§20.7.2 逐字對照：the four revision columns carry exactly the precisions the Spec mandates ((9,1)/(12,2)/(9,6))", () => {
    expect(readAppliedDecimalPrecision(appliedSources, "snapshotAnnualTotalKm")).toEqual({
      precision: 9,
      scale: 1,
    });
    expect(readAppliedDecimalPrecision(appliedSources, "snapshotAnnualDepreciation")).toEqual({
      precision: 12,
      scale: 2,
    });
    expect(readAppliedDecimalPrecision(appliedSources, "snapshotRatio")).toEqual({
      precision: 9,
      scale: 6,
    });
    // `annualTotalKm`（業務欄，非快照欄）之 DDL 亦為 Decimal(9,1)。
    expect(readAppliedDecimalPrecision(appliedSources, "annualTotalKm")).toEqual({
      precision: 9,
      scale: 1,
    });
  });

  it("Application.totalAmount is INTEGER (int4) in the applied DDL, and the int4 bounds are derived from its 32-bit width", () => {
    const phase4Sql = fs.readFileSync(PHASE4_MIGRATION_SQL_PATH, "utf8");
    const applicationBody = extractCreateTableBody(phase4Sql, "Application");
    expect(applicationBody).toMatch(/"totalAmount"\s+INTEGER/);
    expect(DEPRECIATION_COLUMN_CAPACITY.totalAmount.bits).toBe(32);
    expect(DEPRECIATION_COLUMN_CAPACITY.totalAmount.max).toBe(2147483647);
    expect(DEPRECIATION_COLUMN_CAPACITY.totalAmount.min).toBe(-2147483648);
  });

  it("FW-1 self-proof: the DDL reader has discriminating power across BOTH migrations — a poisoned M1 CREATE and a poisoned M2 ALTER each yield a different precision", () => {
    const poisonedM1 = m1Sql.replace(
      '"snapshotRawAmount" DECIMAL(14,4)',
      '"snapshotRawAmount" DECIMAL(16,4)'
    );
    expect(poisonedM1).not.toBe(m1Sql);
    expect(
      readAppliedDecimalPrecision(
        [
          {
            label: "M1(poisoned)",
            body: extractCreateTableBody(poisonedM1, "DepreciationApplication"),
          },
          appliedSources[1],
        ],
        "snapshotRawAmount"
      )
    ).toEqual({ precision: 16, scale: 4 });

    const poisonedM2 = m2Sql.replace(
      '"snapshotRatio" DECIMAL(9,6)',
      '"snapshotRatio" DECIMAL(9,4)'
    );
    expect(poisonedM2).not.toBe(m2Sql);
    expect(
      readAppliedDecimalPrecision(
        [
          appliedSources[0],
          {
            label: "M2(poisoned)",
            body: extractAlterTableBody(poisonedM2, "DepreciationApplication"),
          },
        ],
        "snapshotRatio"
      )
    ).toEqual({ precision: 9, scale: 4 });
  });

  it("FW-1 self-proof: a missing column throws instead of silently passing, and a duplicated declaration also throws (fail-loud on hit count ≠ 1)", () => {
    expect(() => readAppliedDecimalPrecision(appliedSources, "noSuchColumn")).toThrow(/found 0/);
    const duplicated = [
      appliedSources[0],
      { label: "duplicate", body: '"snapshotRawAmount" DECIMAL(14,4)' },
    ];
    expect(() => readAppliedDecimalPrecision(duplicated, "snapshotRawAmount")).toThrow(/found 2/);
  });

  it("FW-1 self-proof: the schema.prisma reader has discriminating power (poisoned schema yields a different precision)", () => {
    // 注意：`snapshotRawAmount Decimal(14,4)` 在 schema.prisma 中不只一處
    // （`TravelApplication`／`MaintenanceApplication` 亦有同名同精度欄位），
    // 故投毒必須限定在 `DepreciationApplication` 模型區塊內。
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
// §8 零浮點中介掃描（清單驅動：PHASE_007_SRC_FILES）
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

describe("AC-51(a) 零浮點中介 — PHASE-007 source files contain no Number()/parseFloat/parseInt on the amount path", () => {
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

    it("AR-3（逐檔化）：`.toNumber()` 之出現次數不超過本檔之明文額度（未列表之檔案一律 0 次）", () => {
      const occurrences = blanked.match(/\.toNumber\(/g) ?? [];
      expect(occurrences.length).toBe(TO_NUMBER_ALLOWANCE[relativePath] ?? 0);
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
    // 以「挖空註解／字串後」的原始碼定位真正的程式碼建構處。挖空後字串字面
    // 內容成為等長空白，故引數呈現為空字串——正是「引數是字串字面」的證據
    // （變數或裸數字會原樣存活）。本檔恰有兩處：十進位基數 "10"（推導容量
    // 上界 10^(precision − scale)）與百分比乘數 "100"（ratioPercentString）。
    const codeArgs = findDecimalConstructorArgs(blanked);
    expect(codeArgs).toEqual(["", ""]);

    // 於同一 byte offset 回讀原始碼，確認兩處引數確實是 `"10"` 與 `"100"`。
    const offsets = [...blanked.matchAll(DECIMAL_CONSTRUCTOR_PATTERN)].map((m) => m.index ?? -1);
    expect(offsets.length).toBe(2);
    const originals = offsets.map(
      (offset) =>
        (rawSource.slice(offset).match(/^new Prisma\.Decimal\("(\d+)"\)/) as RegExpMatchArray)[1]
    );
    expect(originals.sort()).toEqual(["10", "100"]);
  });

  it("scanner self-proof (discriminating power): a synthetic legacy snippet using Number() as an intermediary must be caught; Number( inside comments/strings must not false-positive", () => {
    const oldImplementation = blankCommentsAndStrings(
      [
        "function calcDepreciation(annual, km, total) {",
        "  const annualNum = Number(annual);",
        "  const kmNum = parseFloat(km);",
        "  return Math.round(annualNum * kmNum / total);",
        "}",
      ].join("\n")
    );
    expect(findCoercionCalls(oldImplementation)).toEqual(["Number(annual)", "parseFloat(km)"]);

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
    // AR-2（T3 即審）：**全等**斷言而非 `toContain`——新增 src 檔卻忘了登記
    // 時，`toContain` 不會轉紅（清單只增不減亦通過），全等則必紅並強制實作者
    // 於同一 commit 內補登記。
    expect([...PHASE_007_SRC_FILES]).toEqual([
      "src/applications/depreciation-calculation.ts",
      "src/applications/depreciation-blockers.ts",
      "src/applications/depreciation-service.ts",
      "src/applications/depreciation-parameters.ts",
    ]);
    expect(PHASE_007_SRC_FILES.length).toBeGreaterThan(0);
    expect(() =>
      fs.readFileSync(path.resolve(BACKEND_ROOT, "src/applications/no-such-file.ts"), "utf8")
    ).toThrow();
  });
});
