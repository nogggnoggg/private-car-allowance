/**
 * PHASE-006-T2 — `calculateMaintenance` ＋ `isMaintenanceCalculationOverCapacity`
 * （AC-06／AC-16／AC-17／AC-19）
 *
 * Spec §2：
 *   AC-06 保養區間里程公式 — intervalKm = C − L（Decimal 減法，不取整）。
 *   AC-16 公務比例公式 — ratio = O ÷ I（Decimal.div，全精度），對外以 ratio
 *     （6 位小數字串）與 ratioPercent（4 位小數字串 ＝ ratio × 100）回傳；
 *     I ≤ 0 一律視為不可計算，絕不除以零／NaN／Infinity。
 *   AC-17 分攤金額 — raw = P × O ÷ I（過程不取整任何中間值），
 *     amount = ROUND_HALF_UP(raw, 0)（全案唯一一處取整，非銀行家）。
 *   AC-19 容量守門 — raw／amount／intervalKm／officialKm／ratio 任一項超出
 *     目標欄位容量（`Decimal(14,4)`／`Decimal(12,2)`／`Decimal(9,6)` 之
 *     `|v| ≥ 1e10`／`1e3`；`Int`/int4 之 `> 2147483647` 或 `< -2147483648`）
 *     → predicate 回 true，絕不靜默截斷。
 *
 * 鑑別力（Spec §2 AC-17(d) 註記）：
 *   取整規則 kill pair：`P=2.00,O=1,I=4`（raw=0.5 → 1，銀行家為 0）與
 *   `P=6.00,O=1,I=4`（raw=1.5 → 2，銀行家亦為 2）成對出現方具鑑別力。
 *   取整層級 kill case：`P=1500000.00,O=2,I=3` → raw=1000000 exactly → 1000000；
 *   若先將 ratio 取整為 6 位小數（0.666667）再乘則得 1000000.5 → 1000001（必紅）。
 *
 * Mutant 自證（Handoff 記錄）：本檔撰寫完成、全綠後，暫時將
 * `maintenance-calculation.ts` 之 `Prisma.Decimal.ROUND_HALF_UP`（金額取整處）
 * 改為 `Prisma.Decimal.ROUND_HALF_EVEN`，重跑本檔，確認且僅確認取整 kill
 * pair 之第一列（`0.5 → 1`）轉紅；另將 `rawAmount` 計算式改為
 * `actualCost.times(ratioString 或 ratio.toDecimalPlaces(6, ROUND_HALF_UP))`
 * （模擬「先取整比例再乘」），重跑，確認取整層級 kill case 轉紅；兩者皆
 * 還原後全部復綠。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  type CalculateMaintenanceResult,
  calculateMaintenance,
  isMaintenanceCalculationOverCapacity,
} from "../../src/applications/maintenance-calculation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

/**
 * PHASE_006_SRC_FILES — 沿 PHASE-005a `PHASE_005A_SRC_FILES` 慣例建立之獨立
 * 清單（本 Phase 專用）。**T3/T4/T5/T7/T8 等後續 Task 於本 Phase 新增 `src`
 * 檔案時，必須將其相對路徑（相對於 `backend/`）加入本陣列**，否則新檔案
 * 不會被下方 AC-28 同型結構性掃描覆蓋。清單中任何檔案不存在時，
 * `fs.readFileSync` 會直接拋錯使測試紅（fail-loud），不得靜默跳過。
 */
const PHASE_006_SRC_FILES = ["src/applications/maintenance-calculation.ts"] as const;

const ENGINE_SRC_PATH = path.resolve(BACKEND_ROOT, PHASE_006_SRC_FILES[0]);

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

// ---------------------------------------------------------------------------
// §1 AC-06 intervalKm 精確驗表
// ---------------------------------------------------------------------------

describe("calculateMaintenance — AC-06 intervalKm equals current − last odometer (exact Decimal table)", () => {
  const rows: Array<{ last: string; current: string; expected: string; note: string }> = [
    { last: "10000.00", current: "10050.00", expected: "50", note: "一般整數里程差" },
    { last: "0.00", current: "0.01", expected: "0.01", note: "邊界 B-04：最小正值" },
    { last: "9999999998.00", current: "9999999999.00", expected: "1", note: "邊界：極小區間 = 1" },
    { last: "12345.67", current: "12399.99", expected: "54.32", note: "非整數里程表讀值" },
  ];

  it.each(rows)(
    "last=$last, current=$current → intervalKm=$expected ($note)",
    ({ last, current, expected }) => {
      const result = calculateMaintenance({
        lastOdometerKm: d(last),
        currentOdometerKm: d(current),
        officialKm: d("0"),
        actualCost: d("0"),
      });
      expect(result.intervalKm.toFixed(2)).toBe(d(expected).toFixed(2));
    }
  );

  it("minimal positive interval 0.01 is computed, not rejected", () => {
    const result = calculateMaintenance({
      lastOdometerKm: d("500.00"),
      currentOdometerKm: d("500.01"),
      officialKm: d("0"),
      actualCost: d("0"),
    });
    expect(result.calculable).toBe(true);
    expect(result.intervalKm.toFixed(2)).toBe("0.01");
  });
});

// ---------------------------------------------------------------------------
// §2 AC-16 公務比例精確驗表 ＋ 除零防禦
// ---------------------------------------------------------------------------

describe("calculateMaintenance — AC-16 ratio = officialKm ÷ intervalKm (exact six-decimal table)", () => {
  const rows: Array<{
    interval: string;
    official: string;
    expectedRatio: string;
    expectedPercent: string;
    note: string;
  }> = [
    {
      interval: "100.00",
      official: "0.00",
      expectedRatio: "0.000000",
      expectedPercent: "0.0000",
      note: "零公務里程",
    },
    {
      interval: "100.00",
      official: "100.00",
      expectedRatio: "1.000000",
      expectedPercent: "100.0000",
      note: "恰 100%",
    },
    {
      interval: "3.00",
      official: "1.00",
      expectedRatio: "0.333333",
      expectedPercent: "33.3333",
      note: "1/3 循環",
    },
    {
      interval: "7.00",
      official: "1.00",
      expectedRatio: "0.142857",
      expectedPercent: "14.2857",
      note: "1/7 循環",
    },
  ];

  it.each(rows)(
    "interval=$interval, official=$official → ratio=$expectedRatio, ratioPercent=$expectedPercent ($note)",
    ({ interval, official, expectedRatio, expectedPercent }) => {
      const result = calculateMaintenance({
        lastOdometerKm: d("0"),
        currentOdometerKm: d(interval),
        officialKm: d(official),
        actualCost: d("0"),
      });
      expect(result.ratioString).toBe(expectedRatio);
      expect(result.ratioPercentString).toBe(expectedPercent);
    }
  );

  it("ratio and ratioPercent are consistent (percent = ratio × 100) and both are strings", () => {
    const result = calculateMaintenance({
      lastOdometerKm: d("0"),
      currentOdometerKm: d("40.00"),
      officialKm: d("13.00"),
      actualCost: d("0"),
    });
    expect(typeof result.ratioString).toBe("string");
    expect(typeof result.ratioPercentString).toBe("string");
    expect(result.ratio).not.toBeNull();
    const percentFromRatio = (result.ratio as Prisma.Decimal)
      .times(100)
      .toFixed(4, Prisma.Decimal.ROUND_HALF_UP);
    expect(result.ratioPercentString).toBe(percentFromRatio);
  });

  it("intervalKm = 0 never divides by zero, never returns NaN/Infinity — reported as not calculable", () => {
    const result = calculateMaintenance({
      lastOdometerKm: d("100.00"),
      currentOdometerKm: d("100.00"),
      officialKm: d("10.00"),
      actualCost: d("500.00"),
    });
    expect(result.calculable).toBe(false);
    expect(result.ratio).toBeNull();
    expect(result.ratioString).toBeNull();
    expect(result.ratioPercentString).toBeNull();
    expect(result.rawAmount).toBeNull();
    expect(result.amount).toBeNull();
  });

  it("negative intervalKm (current < last, should already be blocked upstream by AC-08) is also reported as not calculable — defensive, never throws", () => {
    const result = calculateMaintenance({
      lastOdometerKm: d("100.00"),
      currentOdometerKm: d("50.00"),
      officialKm: d("10.00"),
      actualCost: d("500.00"),
    });
    expect(result.calculable).toBe(false);
    expect(result.amount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §2.5 T2R MF-1 — NaN/Infinity 輸入防禦（除 intervalKm≤0 以外之非有限值守門）
// ---------------------------------------------------------------------------

describe("calculateMaintenance — T2R MF-1: NaN/Infinity inputs never produce NaN/Infinity amounts or silent zeros", () => {
  it("officialKm = NaN is reported as not calculable — never NaN ratio/amount", () => {
    const result = calculateMaintenance({
      lastOdometerKm: d("0"),
      currentOdometerKm: d("100.00"),
      officialKm: new Prisma.Decimal(Number.NaN),
      actualCost: d("500.00"),
    });
    expect(result.calculable).toBe(false);
    expect(result.ratio).toBeNull();
    expect(result.ratioString).toBeNull();
    expect(result.ratioPercentString).toBeNull();
    expect(result.rawAmount).toBeNull();
    expect(result.amount).toBeNull();
  });

  it("actualCost = Infinity is reported as not calculable — never an Infinity amount", () => {
    const result = calculateMaintenance({
      lastOdometerKm: d("0"),
      currentOdometerKm: d("100.00"),
      officialKm: d("10.00"),
      actualCost: new Prisma.Decimal(Number.POSITIVE_INFINITY),
    });
    expect(result.calculable).toBe(false);
    expect(result.rawAmount).toBeNull();
    expect(result.amount).toBeNull();
  });

  it("currentOdometerKm = Infinity yields a non-finite intervalKm — reported as not calculable, never a silent zero amount", () => {
    const result = calculateMaintenance({
      lastOdometerKm: d("100.00"),
      currentOdometerKm: new Prisma.Decimal(Number.POSITIVE_INFINITY),
      officialKm: d("10.00"),
      actualCost: d("500.00"),
    });
    expect(result.intervalKm.isFinite()).toBe(false);
    expect(result.calculable).toBe(false);
    expect(result.ratio).toBeNull();
    expect(result.rawAmount).toBeNull();
    expect(result.amount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §3 AC-17 分攤金額：驗表 ＋ 取整 kill pair ＋ 取整層級 kill case ＋ 浮點鑑別
// ---------------------------------------------------------------------------

describe("calculateMaintenance — AC-17 amount = ROUND_HALF_UP(cost × officialKm ÷ intervalKm, 0)", () => {
  const rows: Array<{
    cost: string;
    official: string;
    interval: string;
    expected: number;
    note: string;
  }> = [
    { cost: "100.00", official: "1", interval: "2", expected: 50, note: "整除" },
    {
      cost: "1500000.00",
      official: "2",
      interval: "3",
      expected: 1000000,
      note: "取整層級 kill case",
    },
    {
      cost: "40431.36",
      official: "0.25",
      interval: "1.92",
      expected: 5265,
      note: "T2R SF-1 kill case：`actualCost.times(ratio)` 全精度相乘會得 5264（受限 precision=20 之捨入路徑不同，見下方 mutant 對照測試），直接三值計算須為 5265",
    },
  ];

  it.each(rows)(
    "cost=$cost, official=$official, interval=$interval → amount=$expected ($note)",
    ({ cost, official, interval, expected }) => {
      const result = calculateMaintenance({
        lastOdometerKm: d("0"),
        currentOdometerKm: d(interval),
        officialKm: d(official),
        actualCost: d(cost),
      });
      expect(result.amount).toBe(expected);
    }
  );

  it("AC-17(d) rounding kill pair: 0.5 → 1 and 1.5 → 2 together discriminate HALF_UP from banker's rounding", () => {
    const half = calculateMaintenance({
      lastOdometerKm: d("0"),
      currentOdometerKm: d("4"),
      officialKm: d("1"),
      actualCost: d("2.00"),
    });
    expect(half.rawAmount?.toFixed(4)).toBe("0.5000");
    // ROUND_HALF_UP(0.5, 0) = 1 — banker's rounding (ROUND_HALF_EVEN) would give 0.
    expect(half.amount).toBe(1);

    const oneAndHalf = calculateMaintenance({
      lastOdometerKm: d("0"),
      currentOdometerKm: d("4"),
      officialKm: d("1"),
      actualCost: d("6.00"),
    });
    expect(oneAndHalf.rawAmount?.toFixed(4)).toBe("1.5000");
    // Both HALF_UP and HALF_EVEN give 2 here — this row alone has no
    // discriminating power; only paired with the 0.5 → 1 row above does the
    // pair distinguish HALF_UP from banker's rounding.
    expect(oneAndHalf.amount).toBe(2);
  });

  it("AC-17(d) rounding-LEVEL kill case: cost=1500000, official=2, interval=3 → exactly 1000000 (pre-rounding the ratio to 6dp would yield 1000001)", () => {
    const result = calculateMaintenance({
      lastOdometerKm: d("0"),
      currentOdometerKm: d("3"),
      officialKm: d("2"),
      actualCost: d("1500000.00"),
    });
    // Correct implementation: raw = cost × official ÷ interval, computed
    // directly — 1500000 × 2 ÷ 3 = 1000000 exactly (no repeating decimal).
    expect(result.rawAmount?.toFixed(4)).toBe("1000000.0000");
    expect(result.amount).toBe(1000000);

    // Demonstrate the wrong "pre-round the ratio, then multiply" mutant path
    // WITHOUT touching production code: ratio = 2/3 rounded to 6dp is
    // "0.666667"; cost × 0.666667 = 1000000.5 → ROUND_HALF_UP → 1000001,
    // one off from the correct answer. This proves the kill case has
    // discriminating power — a real regression to this mutant would fail the
    // assertion above (`amount === 1000000`), not merely produce a "close
    // enough" value.
    const wrongRatio = new Prisma.Decimal("2")
      .div("3")
      .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
    const wrongRaw = new Prisma.Decimal("1500000.00").times(wrongRatio);
    const wrongAmount = wrongRaw.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
    expect(wrongAmount).toBe(1000001);
    expect(wrongAmount).not.toBe(result.amount);
  });

  it("T2R SF-1 kill case: cost=40431.36, official=0.25, interval=1.92 → 5265 (proves `actualCost.times(ratio)` mutant C is NOT equivalent, off by 1)", () => {
    const result = calculateMaintenance({
      lastOdometerKm: d("0"),
      currentOdometerKm: d("1.92"),
      officialKm: d("0.25"),
      actualCost: d("40431.36"),
    });
    // Correct implementation: raw = cost × official ÷ interval, computed
    // directly (no intermediate `ratio` multiplication).
    expect(result.rawAmount?.toFixed(4)).toBe("5264.5000");
    expect(result.amount).toBe(5265);

    // Demonstrate mutant C ("pre-divide into `ratio`, then multiply")
    // WITHOUT touching production code. Even though `ratio` here is the
    // *unrounded* full-precision quotient (not rounded to 6dp), it is still
    // NOT equivalent to computing cost × official ÷ interval directly —
    // `Prisma.Decimal`/decimal.js division is bounded by a fixed significant
    // -digit precision (default 20), so `O ÷ I` already incurs rounding at
    // that precision before the subsequent multiplication by `cost`, and the
    // two rounding paths ("multiply then divide" vs. "divide then multiply")
    // can disagree by 1 unit at the final ROUND_HALF_UP step.
    const mutantRatio = new Prisma.Decimal("0.25").div("1.92");
    const mutantRaw = new Prisma.Decimal("40431.36").times(mutantRatio);
    const mutantAmount = mutantRaw.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
    expect(mutantRaw.toString()).not.toBe(result.rawAmount?.toString());
    expect(mutantAmount).toBe(5264);
    expect(mutantAmount).not.toBe(result.amount);
  });

  it("AC-17(c) rounding happens exactly once (source-level scan: a single toDecimalPlaces call on the amount path)", () => {
    // Blanked (comments/strings stripped) so doc-comment mentions of
    // `.toDecimalPlaces()` (prose, not code) don't inflate the count.
    const rawSource = fs.readFileSync(ENGINE_SRC_PATH, "utf8");
    const blanked = blankCommentsAndStrings(rawSource);
    const occurrences = blanked.match(/\.toDecimalPlaces\(/g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  it("floating-point discriminator: cost=0.10, official=2, interval=10 computes exactly via Decimal (no IEEE754 double intermediary)", () => {
    const result = calculateMaintenance({
      lastOdometerKm: d("0"),
      currentOdometerKm: d("10"),
      officialKm: d("2"),
      actualCost: d("0.10"),
    });
    // 0.10 × 2 ÷ 10 = 0.02 exactly. A float64 intermediary for 0.1 would risk
    // an artifact like 0.020000000000000004; Decimal must be exact.
    expect(result.rawAmount?.toFixed(4)).toBe("0.0200");
    expect(result.amount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §4 AC-19 容量 predicate（含邊界正例，防守門誤殺）
// ---------------------------------------------------------------------------

function syntheticResult(
  overrides: Partial<CalculateMaintenanceResult>
): CalculateMaintenanceResult {
  return {
    intervalKm: d("1"),
    officialKm: d("1"),
    calculable: true,
    ratio: d("1"),
    ratioString: "1.000000",
    ratioPercentString: "100.0000",
    rawAmount: d("1"),
    amount: 1,
    ...overrides,
  };
}

describe("calculateMaintenance — AC-19 capacity guard: rawAmount ≥ 1e10 or amount beyond int4 is reported, never silently truncated", () => {
  it("rawAmount just under 1e10 is calculable (boundary positive)", () => {
    const result = syntheticResult({ rawAmount: d("9999999999.9999"), amount: 1 });
    expect(isMaintenanceCalculationOverCapacity(result)).toBe(false);
  });

  it("rawAmount at exactly 1e10 is over capacity", () => {
    const result = syntheticResult({ rawAmount: d("10000000000"), amount: 1 });
    expect(isMaintenanceCalculationOverCapacity(result)).toBe(true);
  });

  it("amount at int4 max (2147483647) is calculable (boundary positive)", () => {
    const result = syntheticResult({ amount: 2147483647 });
    expect(isMaintenanceCalculationOverCapacity(result)).toBe(false);
  });

  it("amount one beyond int4 max (2147483648) is over capacity", () => {
    const result = syntheticResult({ amount: 2147483648 });
    expect(isMaintenanceCalculationOverCapacity(result)).toBe(true);
  });

  it("amount at int4 min (-2147483648) is calculable; one beyond (-2147483649) is over capacity", () => {
    expect(isMaintenanceCalculationOverCapacity(syntheticResult({ amount: -2147483648 }))).toBe(
      false
    );
    expect(isMaintenanceCalculationOverCapacity(syntheticResult({ amount: -2147483649 }))).toBe(
      true
    );
  });

  it("intervalKm/officialKm just under 1e10 are calculable; at exactly 1e10 are over capacity (Decimal(12,2))", () => {
    expect(
      isMaintenanceCalculationOverCapacity(syntheticResult({ intervalKm: d("9999999999.99") }))
    ).toBe(false);
    expect(
      isMaintenanceCalculationOverCapacity(syntheticResult({ intervalKm: d("10000000000") }))
    ).toBe(true);
    expect(
      isMaintenanceCalculationOverCapacity(syntheticResult({ officialKm: d("9999999999.99") }))
    ).toBe(false);
    expect(
      isMaintenanceCalculationOverCapacity(syntheticResult({ officialKm: d("10000000000") }))
    ).toBe(true);
  });

  it("ratio just under 1000 is calculable; at exactly 1000 is over capacity (Decimal(9,6), T1 AR-6 obligation)", () => {
    expect(isMaintenanceCalculationOverCapacity(syntheticResult({ ratio: d("999.999999") }))).toBe(
      false
    );
    expect(isMaintenanceCalculationOverCapacity(syntheticResult({ ratio: d("1000") }))).toBe(true);
  });

  it("boundary positives just inside capacity are calculable end-to-end (real calculateMaintenance run, not synthetic)", () => {
    const result = calculateMaintenance({
      lastOdometerKm: d("0"),
      currentOdometerKm: d("100000.00"),
      officialKm: d("50000.00"),
      actualCost: d("2000000000.00"),
    });
    expect(result.calculable).toBe(true);
    expect(result.amount).toBeLessThanOrEqual(2147483647);
    expect(isMaintenanceCalculationOverCapacity(result)).toBe(false);
  });

  it("an over-capacity amount is reported by the predicate but NOT silently truncated by calculateMaintenance itself", () => {
    const result = calculateMaintenance({
      lastOdometerKm: d("0"),
      currentOdometerKm: d("1"),
      officialKm: d("1"),
      actualCost: d("9999999999.00"),
    });
    expect(result.calculable).toBe(true);
    // The true (uncapped) computed value is preserved — not clamped/truncated.
    expect(result.amount).toBe(9999999999);
    expect(isMaintenanceCalculationOverCapacity(result)).toBe(true);
  });

  it("calculable=false results are never reported as over-capacity (two independent, mutually exclusive failure modes)", () => {
    const result = calculateMaintenance({
      lastOdometerKm: d("100.00"),
      currentOdometerKm: d("100.00"),
      officialKm: d("10.00"),
      actualCost: d("500.00"),
    });
    expect(result.calculable).toBe(false);
    expect(isMaintenanceCalculationOverCapacity(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §5 AC-28 同型結構性掃描（清單驅動：PHASE_006_SRC_FILES）
// ---------------------------------------------------------------------------

/**
 * 將註解與字串／樣板字面「挖空」為等長空白（換行保留），使後續的語彙掃描
 * 只看得到真正的程式碼。做法沿用 CHORE-003-T3／PHASE-005a
 * （`backend/test/unit/fuel-price-engine.test.ts` §3）之既有慣例。
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

describe("AC-28 零浮點中介 — PHASE-006 source files contain no Number()/parseFloat/parseInt on the amount path", () => {
  // 掃描迴圈逐檔驅動 PHASE_006_SRC_FILES；清單目前僅一項
  // （`maintenance-calculation.ts`），T3/T4/T5/T7/T8 新增 src 檔案時必須加入
  // 清單，describe.each 確保未來新增項目時自動被覆蓋，且任一路徑不存在時
  // fs.readFileSync 會拋錯使該檔案的整組測試紅（不會靜默跳過）。
  describe.each(PHASE_006_SRC_FILES)("scanned file: %s", (relativePath) => {
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

  // 檔案專屬（非泛用）斷言：僅適用於 maintenance-calculation.ts 之精確內容
  // 驗證，取自 PHASE_006_SRC_FILES[0]（本 Phase 目前唯一項目）。
  const rawSource = fs.readFileSync(ENGINE_SRC_PATH, "utf8");
  const blanked = blankCommentsAndStrings(rawSource);

  it("scan sanity: blanking preserves a recognizable code skeleton (not scanning an empty string)", () => {
    expect(blanked).toContain("export function calculateMaintenance");
    expect(blanked).toContain("toDecimalPlaces");
    // Chinese prose that lives only in comments must not survive blanking.
    expect(blanked).not.toContain("欄位容量");
  });

  it("every Prisma.Decimal construction in this file takes a string literal or an existing Prisma.Decimal-typed value (D4 bright-line)", () => {
    const args = findDecimalConstructorArgs(rawSource);
    // Four named constants (KM/RATIO/RAW_AMOUNT capacity bounds) — all string
    // literals; no bare-number or expression construction anywhere else.
    expect(args).toEqual(['"10000000000"', '"1000"', '"10000000000"']);
  });

  // T2R SF-2 — 逐字移植自
  // backend/test/unit/fuel-price-engine.test.ts:333-354（scanner self-proof）。
  it("scanner self-proof (discriminating power): a synthetic legacy snippet using Number() as an intermediary must be caught; Number( inside comments/strings must not false-positive", () => {
    const oldImplementation = blankCommentsAndStrings(
      [
        "function deriveFuelUnitPrice(p, c) {",
        "  const priceNum = Number(p);",
        "  const kmNum = Number(c);",
        "  return Math.round(priceNum / kmNum);",
        "}",
      ].join("\n")
    );
    expect(findCoercionCalls(oldImplementation)).toEqual(["Number(p)", "Number(c)"]);

    const commentOnly = blankCommentsAndStrings(
      [
        "// 這一步刻意不使用 Number(input) 中介",
        "/* 舊路徑：const x = Number(y); */",
        'const message = "Number(unsafe) 僅是文案";',
        "const safe = toDecimal(input);",
      ].join("\n")
    );
    expect(findCoercionCalls(commentOnly)).toEqual([]);
  });
});
