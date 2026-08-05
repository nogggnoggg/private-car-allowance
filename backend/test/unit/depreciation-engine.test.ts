/**
 * Unit tests: PHASE-003a-T4 — Depreciation engine (pure function, no DB)
 *
 * Spec §2 AC-12/13/14, §4.4 D3 (精度定案), §8.1
 *
 * TDD: written BEFORE the engine module exists; first run must be RED.
 *
 * Engine under test:
 *   deriveDepreciation({ vehiclePrice, usefulLifeYears, estimatedAnnualKm })
 *     Returns:
 *       { ok: true; annualDepreciation: string; perKmUnitPrice: string }
 *       | { ok: false }
 *
 * D3 精度定案（已批准）:
 *   - annualDepreciation = round_half_up(vehiclePrice / usefulLifeYears, 2 位)
 *   - perKmUnitPrice = round_half_up(未取整每年費用 / estimatedAnnualKm, 4 位)
 *   - 取整方向：一般四捨五入 0.5 進位（round half up），非銀行家取整（非 half-even）
 *   - 不用浮點，用 Prisma Decimal（decimal.js）
 *   - 回傳為固定位數字串：annualDepreciation 2 位、perKmUnitPrice 4 位
 *
 * 鑑別力反向驗證（見 Handoff）：
 *   - 若取整改成 half-even（銀行家取整），.5 邊界案例測試會轉紅
 *   - 若 annualDepreciation 改為 4 位精度，精度驗證測試會轉紅
 *   - 若 perKmUnitPrice 改為 2 位精度，精度驗證測試會轉紅
 *   - 若未擋 ≤0，0 年限測試會回 NaN/Infinity 而轉紅
 *   - 若 perKmUnitPrice 分子改用已取整 annualDepreciation，累積誤差案例測試會轉紅
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  deriveAnnualDepreciation,
  deriveDepreciation,
} from "../../src/parameters/depreciation-engine.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Check that a string represents a decimal with exactly `places` decimal places.
 */
function hasDecimalPlaces(str: string, places: number): boolean {
  const match = /^-?\d+\.(\d+)$/.exec(str);
  if (!match) return places === 0;
  return match[1].length === places;
}

// ─── AC-14: 任一值 ≤ 0 → { ok: false }（不回 NaN/Infinity，不丟例外）─────────────

describe("deriveDepreciation — 值域保護 ≤0 → ok:false (AC-14)", () => {
  it("vehiclePrice=0 → { ok: false }（不除以 0）", () => {
    const result = deriveDepreciation({
      vehiclePrice: 0,
      usefulLifeYears: 5,
      estimatedAnnualKm: 20000,
    });
    expect(result.ok).toBe(false);
  });

  it("vehiclePrice < 0 → { ok: false }", () => {
    const result = deriveDepreciation({
      vehiclePrice: -100000,
      usefulLifeYears: 5,
      estimatedAnnualKm: 20000,
    });
    expect(result.ok).toBe(false);
  });

  it("usefulLifeYears=0 → { ok: false }（0 年限不得除以 0，不回 NaN/Infinity）", () => {
    const result = deriveDepreciation({
      vehiclePrice: 500000,
      usefulLifeYears: 0,
      estimatedAnnualKm: 20000,
    });
    expect(result.ok).toBe(false);
    // 明確確認沒有 annualDepreciation/perKmUnitPrice 欄位（不推導）
    if (!result.ok) {
      expect((result as Record<string, unknown>).annualDepreciation).toBeUndefined();
      expect((result as Record<string, unknown>).perKmUnitPrice).toBeUndefined();
    }
  });

  it("usefulLifeYears < 0 → { ok: false }", () => {
    const result = deriveDepreciation({
      vehiclePrice: 500000,
      usefulLifeYears: -3,
      estimatedAnnualKm: 20000,
    });
    expect(result.ok).toBe(false);
  });

  it("estimatedAnnualKm=0 → { ok: false }（不除以 0）", () => {
    const result = deriveDepreciation({
      vehiclePrice: 500000,
      usefulLifeYears: 5,
      estimatedAnnualKm: 0,
    });
    expect(result.ok).toBe(false);
  });

  it("estimatedAnnualKm < 0 → { ok: false }", () => {
    const result = deriveDepreciation({
      vehiclePrice: 500000,
      usefulLifeYears: 5,
      estimatedAnnualKm: -1000,
    });
    expect(result.ok).toBe(false);
  });

  it("全部為 0 → { ok: false }", () => {
    const result = deriveDepreciation({
      vehiclePrice: 0,
      usefulLifeYears: 0,
      estimatedAnnualKm: 0,
    });
    expect(result.ok).toBe(false);
  });

  it("返回結果為 { ok: false }，不拋例外（即使除以 0 情境）", () => {
    expect(() => {
      deriveDepreciation({ vehiclePrice: 500000, usefulLifeYears: 0, estimatedAnnualKm: 20000 });
    }).not.toThrow();
  });
});

// ─── AC-12/13: 三值皆 > 0 時正確推導，回傳 ok:true ────────────────────────────

describe("deriveDepreciation — 正常推導 (AC-12/13)", () => {
  // Case 1: 整除案例（車價 ÷ 年限恰整除，每年費用 ÷ 年里程亦整除）
  it("整除案例：vehiclePrice=100000, years=5, km=20000 → annualDepreciation='20000.00', perKmUnitPrice='1.0000'", () => {
    const result = deriveDepreciation({
      vehiclePrice: 100000,
      usefulLifeYears: 5,
      estimatedAnnualKm: 20000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.annualDepreciation).toBe("20000.00");
      expect(result.perKmUnitPrice).toBe("1.0000");
    }
  });

  // Case 2: 需要 2 位小數的每年費用
  it("非整除案例：vehiclePrice=100000, years=3, km=20000 → annualDepreciation='33333.33'", () => {
    // 100000 / 3 = 33333.3333... → round_half_up 2 位 = 33333.33
    // perKmUnitPrice: 100000/3/20000 = 1.6666... → round_half_up 4 位 = 1.6667
    const result = deriveDepreciation({
      vehiclePrice: 100000,
      usefulLifeYears: 3,
      estimatedAnnualKm: 20000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.annualDepreciation).toBe("33333.33");
      // perKmUnitPrice 以未取整每年費用計算：
      // 100000/3 = 33333.333333.../20000 = 1.66666... → round_half_up(4) = 1.6667
      expect(result.perKmUnitPrice).toBe("1.6667");
    }
  });

  // Case 3: 需要 4 位小數的每公里單價
  it("每公里單價需 4 位：vehiclePrice=500000, years=5, km=30000", () => {
    // 500000 / 5 = 100000.00 (整除)
    // 100000 / 30000 = 3.333333... → round_half_up(4) = 3.3333
    const result = deriveDepreciation({
      vehiclePrice: 500000,
      usefulLifeYears: 5,
      estimatedAnnualKm: 30000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.annualDepreciation).toBe("100000.00");
      expect(result.perKmUnitPrice).toBe("3.3333");
    }
  });

  // Case 4: 車價精度（Decimal 字串輸入）
  it("vehiclePrice 為 Decimal 字串：'123456.78', years=5, km=25000", () => {
    // 123456.78 / 5 = 24691.356 → round_half_up(2) = 24691.36
    // 123456.78 / 5 / 25000 = 0.987654240 → round_half_up(4) = 0.9877
    const result = deriveDepreciation({
      vehiclePrice: "123456.78",
      usefulLifeYears: 5,
      estimatedAnnualKm: 25000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.annualDepreciation).toBe("24691.36");
      expect(result.perKmUnitPrice).toBe("0.9877");
    }
  });

  // Case 5: Decimal 物件輸入（vehiclePrice 為 Prisma.Decimal）
  it("vehiclePrice 為 Prisma.Decimal 物件輸入", () => {
    const price = new Prisma.Decimal("200000.00");
    const result = deriveDepreciation({
      vehiclePrice: price,
      usefulLifeYears: 4,
      estimatedAnnualKm: 10000,
    });
    // 200000 / 4 = 50000.00
    // 200000 / 4 / 10000 = 5.0000
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.annualDepreciation).toBe("50000.00");
      expect(result.perKmUnitPrice).toBe("5.0000");
    }
  });

  // Case 6: 大數值不失真
  it("大數值：vehiclePrice=9999999.99, years=10, km=50000 → 不失真", () => {
    // 9999999.99 / 10 = 999999.999 → round_half_up(2) = 1000000.00
    // 9999999.99 / 10 / 50000 = 19.999999.../1 = 20.0 → round_half_up(4) = 20.0000
    const result = deriveDepreciation({
      vehiclePrice: "9999999.99",
      usefulLifeYears: 10,
      estimatedAnnualKm: 50000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.annualDepreciation).toBe("1000000.00");
      expect(result.perKmUnitPrice).toBe("20.0000");
    }
  });
});

// ─── 精度格式驗證：固定位數字串輸出 ──────────────────────────────────────────────

describe("deriveDepreciation — 輸出精度格式（固定位數字串）", () => {
  it("annualDepreciation 一律 2 位小數字串", () => {
    const result = deriveDepreciation({
      vehiclePrice: 500000,
      usefulLifeYears: 5,
      estimatedAnnualKm: 20000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(hasDecimalPlaces(result.annualDepreciation, 2)).toBe(true);
    }
  });

  it("perKmUnitPrice 一律 4 位小數字串", () => {
    const result = deriveDepreciation({
      vehiclePrice: 500000,
      usefulLifeYears: 5,
      estimatedAnnualKm: 20000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(hasDecimalPlaces(result.perKmUnitPrice, 4)).toBe(true);
    }
  });

  it("整除案例 annualDepreciation 仍輸出 2 位小數（含尾零）", () => {
    // 100000 / 5 = 20000 → 應輸出 '20000.00' 非 '20000'
    const result = deriveDepreciation({
      vehiclePrice: 100000,
      usefulLifeYears: 5,
      estimatedAnnualKm: 20000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.annualDepreciation).toBe("20000.00");
    }
  });

  it("整除案例 perKmUnitPrice 仍輸出 4 位小數（含尾零）", () => {
    // 100000/5/20000 = 1 → 應輸出 '1.0000' 非 '1'
    const result = deriveDepreciation({
      vehiclePrice: 100000,
      usefulLifeYears: 5,
      estimatedAnnualKm: 20000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.perKmUnitPrice).toBe("1.0000");
    }
  });
});

// ─── .5 邊界證明 round-half-up 非 half-even（鑑別力關鍵）────────────────────────

describe("deriveDepreciation — .5 邊界案例，證明 round-half-up 非 half-even", () => {
  /**
   * round-half-up vs half-even (banker's rounding) 差異：
   * - round-half-up: 0.5 進位（恆進位）
   * - half-even:     末位為偶數時捨去（0.5 時可能捨去）
   *
   * 測試案例：找使 annualDepreciation 的最後一位剛好落在 .5 的數字。
   * 方法：vehiclePrice = 10.005, years = 1
   *   → annualDepreciation = 10.005 / 1 = 10.005
   *   → round_half_up(2): 10.01（.005 的第 3 位 = 5，進位 → .01）
   *   → half-even(2):      10.00（因為第 2 位 0 是偶數，捨去 → .00）
   * 此案例能區分兩種取整。
   *
   * 注意：Prisma Decimal 的 toDecimalPlaces 需明確使用 ROUND_HALF_UP 才能通過。
   */

  it(".5 邊界 — annualDepreciation: vehiclePrice=10.005, years=1 → '10.01' (half-up，非 half-even 的 '10.00')", () => {
    const result = deriveDepreciation({
      vehiclePrice: "10.005",
      usefulLifeYears: 1,
      estimatedAnnualKm: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // round-half-up: 10.005 → 10.01
      // half-even:     10.005 → 10.00 (digit 0 is even, truncate)
      expect(result.annualDepreciation).toBe("10.01");
    }
  });

  it(".5 邊界 — annualDepreciation 另一案例: vehiclePrice=10.015, years=1 → '10.02' (half-up)", () => {
    // 10.015 → round_half_up(2) → 10.02
    // half-even: 10.015 → 10.02（此處 half-even 與 half-up 相同，因 1 是奇數進位）
    // 換案例驗 annualDepreciation 另一邊界
    const result = deriveDepreciation({
      vehiclePrice: "10.015",
      usefulLifeYears: 1,
      estimatedAnnualKm: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // round-half-up: 10.015 → 10.02
      expect(result.annualDepreciation).toBe("10.02");
    }
  });

  it(".5 邊界 — perKmUnitPrice: vehiclePrice=1, years=1, km=8000 → '0.0001' 測試精度", () => {
    // 1 / 1 = 1; 1 / 8000 = 0.000125 → round_half_up(4) = 0.0001 or 0.0002?
    // 0.000125 的第 5 位 = 2，捨去 → round_half_up(4) = 0.0001
    // 這不是 .5 邊界案例，改用其他
    // 直接測一個更清楚的案例
    const result = deriveDepreciation({
      vehiclePrice: 1,
      usefulLifeYears: 1,
      estimatedAnnualKm: 8000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 1 / 8000 = 0.0001250000 → round_half_up(4) = 0.0001 (5th digit=2, truncate)
      expect(result.perKmUnitPrice).toBe("0.0001");
    }
  });

  it(".5 邊界 — perKmUnitPrice .5 at 4th decimal: vehiclePrice=3, years=1, km=60000", () => {
    // 3 / 60000 = 0.000050000 → 第 5 位=0，round_half_up(4) = 0.0001
    // 改用: 3/1/60000 = 0.00005 → round_half_up(4) = 0.0001 (第4位是0, 第5位是5 → 進位)
    // half-even: 0.00005 → 0.0000 (digit 4 is 0, even, so truncate) vs half-up: 0.0001
    const result = deriveDepreciation({
      vehiclePrice: 3,
      usefulLifeYears: 1,
      estimatedAnnualKm: 60000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 3 / 1 = 3.00 (annualDepreciation)
      // 3 / 60000 = 0.00005 (raw exact)
      // round_half_up(4): 0.0001 (5th significant fractional digit = 5 → round up)
      // half-even: 0.0000 (4th fractional digit = 0 is even → truncate)
      expect(result.annualDepreciation).toBe("3.00");
      expect(result.perKmUnitPrice).toBe("0.0001");
    }
  });

  it(".5 邊界 — perKmUnitPrice 更明確案例: vehiclePrice=1, years=1, km=2000", () => {
    // 1/2000 = 0.0005 → round_half_up(4) = 0.0005 (恰好 .5 邊界在第4位？)
    // 0.0005：第 5 位 = 0，round_half_up(4) = 0.0005 (不需進位)
    // 用 vehiclePrice=1, km=4000: 1/4000 = 0.00025 → 第 5 位 = 5
    // round_half_up(4) = 0.0003 (進位); half-even = 0.0002 (2 是偶數，捨去)
    const result = deriveDepreciation({
      vehiclePrice: 1,
      usefulLifeYears: 1,
      estimatedAnnualKm: 4000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // annualDepreciation = 1 / 1 = 1.00
      expect(result.annualDepreciation).toBe("1.00");
      // perKmUnitPrice = 1 / 4000 = 0.00025
      // round_half_up(4): 4th decimal = 2, 5th = 5 → round up → 0.0003
      // half-even: 4th decimal = 2 (even) → truncate → 0.0002
      expect(result.perKmUnitPrice).toBe("0.0003");
    }
  });

  it(".5 邊界 — perKmUnitPrice: vehiclePrice=1, years=1, km=12000", () => {
    // 1/12000 = 0.0000833333... → round_half_up(4) = 0.0001
    // 第 5 位 = 8 → 進位，round_half_up 與 half-even 相同（非 .5 邊界）
    // 換成能區分的案例
    // vehiclePrice=3, years=1, km=20000: 3/20000 = 0.00015
    // 第 5 位 = 5 → round_half_up(4) = 0.0002; half-even: 4th digit = 1 (odd) → 進位 → 0.0002 (相同)
    // 再換: vehiclePrice=1, years=1, km=20000: 1/20000 = 0.00005
    // 第 5 位 = 5 → round_half_up(4) = 0.0001; half-even: 4th digit = 0 (even) → 捨去 → 0.0000 (不同!)
    const result = deriveDepreciation({
      vehiclePrice: 1,
      usefulLifeYears: 1,
      estimatedAnnualKm: 20000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.annualDepreciation).toBe("1.00");
      // 1 / 20000 = 0.00005 (exact)
      // round_half_up(4) = 0.0001 (5th decimal = 5 → round up 4th decimal from 0 to 1)
      // half-even(4) = 0.0000 (4th decimal = 0, even → truncate)
      expect(result.perKmUnitPrice).toBe("0.0001");
    }
  });
});

// ─── 未取整分子 vs 已取整分子的差異標示 ────────────────────────────────────────────

describe("deriveDepreciation — perKmUnitPrice 分子取整選擇（累積誤差示範）", () => {
  /**
   * Spec §4.4 / Task Packet 明確說明：
   * - annualDepreciation 顯示 2 位（供 UI 顯示用）
   * - perKmUnitPrice 的分子建議用「未先取整的每年費用」以減少累積誤差
   *
   * 此測試標示「兩者差異」的案例：
   *   vehiclePrice=100000, years=3, km=20000
   *   - 未取整分子: 100000/3/20000 = 1.666666... → round_half_up(4) = 1.6667
   *   - 已取整分子: 33333.33/20000 = 1.666665 → round_half_up(4) = 1.6667 (此案例相同)
   *
   * 尋找差異明顯的案例：
   *   vehiclePrice=10, years=3, km=3
   *   - 未取整: 10/3/3 = 1.111111... → round_half_up(4) = 1.1111
   *   - 已取整: round_half_up(10/3, 2) = 3.33; 3.33/3 = 1.11 → round_half_up(4) = 1.1100
   *   → 差異：1.1111 vs 1.1100（本實作應為 1.1111）
   */

  it("累積誤差示範：vehiclePrice=10, years=3, km=3 — 未取整分子得 '1.1111'（取整分子得 '1.1100'）", () => {
    const result = deriveDepreciation({
      vehiclePrice: 10,
      usefulLifeYears: 3,
      estimatedAnnualKm: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // annualDepreciation: 10/3 = 3.3333... → round_half_up(2) = 3.33
      expect(result.annualDepreciation).toBe("3.33");
      // perKmUnitPrice（未取整分子）: 10/3/3 = 1.1111... → round_half_up(4) = 1.1111
      // perKmUnitPrice（已取整分子）: 3.33/3 = 1.11 → 1.1100 (差異!)
      expect(result.perKmUnitPrice).toBe("1.1111");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE-007-R4a — deriveAnnualDepreciation（Spec §20.3 AC-49、§20.13 D15）
//
// 以上所有 `deriveDepreciation` describe 為 **003a 凍結證明**（AC-49(d)）：
// 零改動、零 skip、全綠 —— 含 `10/3/3 → perKmUnitPrice "1.1111"` kill case。
// 以下為新增之 `deriveAnnualDepreciation` 覆蓋，不得改動上方任何一行。
//
// AC-49(a) 逐字：
//   deriveAnnualDepreciation({ vehiclePrice, usefulLifeYears })
//     → { ok: true; annualDepreciation: string /* 2dp */ } | { ok: false }
//   公式 = ROUND_HALF_UP(vehiclePrice ÷ usefulLifeYears, 2)
//   （與既有 deriveDepreciation 之 annualDepreciation 語意**完全一致**）
// AC-49(b)：兩者共用**同一內部推導**；禁止第二份 `vehiclePrice ÷ usefulLifeYears`
//   實作（006 T5R SF-1 雙份漂移教訓），以原始碼結構性斷言守門。
// ═══════════════════════════════════════════════════════════════════════════

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_SRC_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "src",
  "parameters",
  "depreciation-engine.ts"
);

/**
 * 將註解與字串／樣板字面「挖空」為等長空白（換行保留），使後續的語彙掃描
 * 只看得到真正的程式碼。做法沿用 CHORE-003-T3／PHASE-005a
 * （`fuel-price-engine.test.ts` §3）／PHASE-006（`maintenance-calculation.test.ts`
 * §5）／PHASE-007-T2（`depreciation-calculation.test.ts` §8）之既有慣例。
 *
 * ※ AR-1 已登記之「掃描 helper 多份拷貝抽共用」技術債（PHASE-011）——本檔
 *   為第五份；抽共用會跨 Phase 改既有測試檔，超出本 Task 之 Files Allowed。
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

/**
 * 移除所有空白，使「引數清單被 formatter 折行」不影響語彙比對
 * （沿 `depreciation-calculation.test.ts` §8「方法鏈可能被 formatter 折行，
 * 故先把點號周邊的空白收斂回單一鏈式字串」之同型手法，強度再進一階）。
 * 僅用於已挖空註解與字串字面之程式碼。
 */
function compactWhitespace(blankedCode: string): string {
  return blankedCode.replace(/\s+/g, "");
}

// ─── AC-49(a) 正常推導 ＋ 值域保護 ────────────────────────────────────────────

describe("AC-49: deriveAnnualDepreciation returns 車價÷年限 at 2dp and rejects ≤0 inputs", () => {
  it("整除案例：vehiclePrice=100000, usefulLifeYears=5 → '20000.00'（含尾零，恆 2 位）", () => {
    const result = deriveAnnualDepreciation({ vehiclePrice: 100000, usefulLifeYears: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.annualDepreciation).toBe("20000.00");
      expect(hasDecimalPlaces(result.annualDepreciation, 2)).toBe(true);
    }
  });

  it("非整除案例：vehiclePrice=100000, usefulLifeYears=3 → '33333.33'（2dp mutant kill：4dp 得 '33333.3333'）", () => {
    const result = deriveAnnualDepreciation({ vehiclePrice: 100000, usefulLifeYears: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.annualDepreciation).toBe("33333.33");
      expect(hasDecimalPlaces(result.annualDepreciation, 2)).toBe(true);
      // MUTANT（scale 2 → 4）：本斷言於 4dp 實作下必紅。
      expect(result.annualDepreciation).not.toBe("33333.3333");
    }
  });

  it("三型輸入（number／字串／Prisma.Decimal）逐字同值：'123456.78' ÷ 5 → '24691.36'", () => {
    const expected = "24691.36";
    const asString = deriveAnnualDepreciation({
      vehiclePrice: "123456.78",
      usefulLifeYears: 5,
    });
    const asDecimal = deriveAnnualDepreciation({
      vehiclePrice: new Prisma.Decimal("123456.78"),
      usefulLifeYears: 5,
    });
    const asNumber = deriveAnnualDepreciation({
      vehiclePrice: 123456.78,
      usefulLifeYears: 5,
    });
    expect(asString.ok).toBe(true);
    expect(asDecimal.ok).toBe(true);
    expect(asNumber.ok).toBe(true);
    if (asString.ok && asDecimal.ok && asNumber.ok) {
      expect(asString.annualDepreciation).toBe(expected);
      expect(asDecimal.annualDepreciation).toBe(expected);
      expect(asNumber.annualDepreciation).toBe(expected);
    }
  });

  it("大數值不失真：vehiclePrice=9999999.99, usefulLifeYears=10 → '1000000.00'", () => {
    const result = deriveAnnualDepreciation({
      vehiclePrice: "9999999.99",
      usefulLifeYears: 10,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 9999999.99 / 10 = 999999.999 → round_half_up(2) = 1000000.00
      expect(result.annualDepreciation).toBe("1000000.00");
    }
  });

  it("vehiclePrice=0 → { ok: false }（不除以 0、不回 '0.00'）", () => {
    expect(deriveAnnualDepreciation({ vehiclePrice: 0, usefulLifeYears: 5 })).toEqual({
      ok: false,
    });
  });

  it("vehiclePrice < 0 → { ok: false }", () => {
    expect(deriveAnnualDepreciation({ vehiclePrice: -1, usefulLifeYears: 5 })).toEqual({
      ok: false,
    });
    expect(deriveAnnualDepreciation({ vehiclePrice: "-0.01", usefulLifeYears: 5 })).toEqual({
      ok: false,
    });
  });

  it("usefulLifeYears=0 → { ok: false }（絕不除以 0、絕不回 'Infinity'）", () => {
    const result = deriveAnnualDepreciation({ vehiclePrice: 100000, usefulLifeYears: 0 });
    expect(result).toEqual({ ok: false });
    expect(JSON.stringify(result)).not.toContain("Infinity");
  });

  it("usefulLifeYears < 0 → { ok: false }", () => {
    expect(deriveAnnualDepreciation({ vehiclePrice: 100000, usefulLifeYears: -3 })).toEqual({
      ok: false,
    });
  });

  it("兩值皆 0 → { ok: false }", () => {
    expect(deriveAnnualDepreciation({ vehiclePrice: 0, usefulLifeYears: 0 })).toEqual({
      ok: false,
    });
  });
});

// ─── 非有限值與不可解析輸入：ok:false，絕不拋錯（沿 R2/R3 同型守門）─────────────

describe("AC-49(a) deriveAnnualDepreciation — 非有限值與不可解析輸入一律 ok:false，絕不拋錯", () => {
  const NON_FINITE_CASES: Array<{
    label: string;
    input: { vehiclePrice: Prisma.Decimal | string | number; usefulLifeYears: number };
  }> = [
    { label: "vehiclePrice=NaN", input: { vehiclePrice: Number.NaN, usefulLifeYears: 5 } },
    {
      label: "vehiclePrice=Infinity",
      input: { vehiclePrice: Number.POSITIVE_INFINITY, usefulLifeYears: 5 },
    },
    {
      label: "vehiclePrice=-Infinity",
      input: { vehiclePrice: Number.NEGATIVE_INFINITY, usefulLifeYears: 5 },
    },
    {
      label: "vehiclePrice=Decimal('NaN')",
      input: { vehiclePrice: new Prisma.Decimal(Number.NaN), usefulLifeYears: 5 },
    },
    { label: "usefulLifeYears=NaN", input: { vehiclePrice: 100000, usefulLifeYears: Number.NaN } },
    {
      label: "usefulLifeYears=Infinity",
      input: { vehiclePrice: 100000, usefulLifeYears: Number.POSITIVE_INFINITY },
    },
    { label: "vehiclePrice='abc'（不可解析）", input: { vehiclePrice: "abc", usefulLifeYears: 5 } },
    { label: "vehiclePrice=''（空字串）", input: { vehiclePrice: "", usefulLifeYears: 5 } },
  ];

  it.each(NON_FINITE_CASES)("$label → { ok: false } 且不拋例外", ({ input }) => {
    let result: ReturnType<typeof deriveAnnualDepreciation> | undefined;
    expect(() => {
      result = deriveAnnualDepreciation(input);
    }).not.toThrow();
    expect(result).toEqual({ ok: false });
    // 絕不以 "NaN"／"Infinity" 字面外洩（R2/R3 同型陷阱）。
    expect(JSON.stringify(result)).not.toContain("NaN");
    expect(JSON.stringify(result)).not.toContain("Infinity");
  });
});

// ─── ROUND_HALF_UP（非 half-even）逐字 ────────────────────────────────────────

describe("AC-49(a) deriveAnnualDepreciation — 取整為 ROUND_HALF_UP，非銀行家取整", () => {
  /**
   * 鑑別案例（half-even mutant 之 kill case）：10.005 於 2dp 之保留位為 `0`
   * （偶數），half-even 捨去得 "10.00"，half-up 進位得 "10.01" → 兩者相異。
   * 已於 R4a mutant 實跑證實：ROUND_HALF_UP → ROUND_HALF_EVEN 時本條必紅。
   */
  it(".5 邊界（鑑別案例）：vehiclePrice='10.005', usefulLifeYears=1 → '10.01'（half-even 得 '10.00' 而必紅）", () => {
    const result = deriveAnnualDepreciation({ vehiclePrice: "10.005", usefulLifeYears: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.annualDepreciation).toBe("10.01");
      expect(result.annualDepreciation).not.toBe("10.00");
    }
  });

  /**
   * 非鑑別案例（誠實標註）：10.015 於 2dp 之保留位為 `1`（奇數），half-even
   * 亦進位得 "10.02"——與 half-up **同值**，故本條**不**具 half-even 鑑別力
   * （R4a mutant 實跑：M4 下本條仍綠）。保留之目的為 .5 邊界之進位向覆蓋，
   * 鑑別力由上一條與結構性斷言承擔。
   */
  it(".5 邊界（進位向覆蓋；對 half-even 無鑑別力）：vehiclePrice='10.015', usefulLifeYears=1 → '10.02'", () => {
    const result = deriveAnnualDepreciation({ vehiclePrice: "10.015", usefulLifeYears: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.annualDepreciation).toBe("10.02");
    }
  });

  it(".5 邊界（由除法產生）：vehiclePrice='20.01', usefulLifeYears=2 → '10.01'（10.005 → half-up）", () => {
    const result = deriveAnnualDepreciation({ vehiclePrice: "20.01", usefulLifeYears: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.annualDepreciation).toBe("10.01");
    }
  });
});

// ─── AC-49(b) 單一內部推導：行為等價 ＋ 原始碼結構性斷言 ───────────────────────

describe("AC-49(b) deriveAnnualDepreciation 與 deriveDepreciation 共用單一內部推導", () => {
  /**
   * 行為層等價：對同一組 (vehiclePrice, usefulLifeYears)，兩函式之
   * `annualDepreciation` 必**逐字**相同（AC-49(a)「語意完全一致」）。
   * `estimatedAnnualKm` 取任意合法值，不影響每年費用。
   */
  const EQUIVALENCE_CASES: Array<{
    vehiclePrice: Prisma.Decimal | string | number;
    usefulLifeYears: number;
  }> = [
    { vehiclePrice: 100000, usefulLifeYears: 5 },
    { vehiclePrice: 100000, usefulLifeYears: 3 },
    { vehiclePrice: "123456.78", usefulLifeYears: 5 },
    { vehiclePrice: 10, usefulLifeYears: 3 },
    { vehiclePrice: "10.005", usefulLifeYears: 1 },
    { vehiclePrice: "10.015", usefulLifeYears: 1 },
    { vehiclePrice: "9999999.99", usefulLifeYears: 10 },
    { vehiclePrice: 1, usefulLifeYears: 7 },
    { vehiclePrice: "500000", usefulLifeYears: 5 },
    { vehiclePrice: new Prisma.Decimal("87654.321"), usefulLifeYears: 6 },
  ];

  it.each(EQUIVALENCE_CASES)(
    "等價：vehiclePrice=$vehiclePrice, usefulLifeYears=$usefulLifeYears — 兩函式之 annualDepreciation 逐字相同",
    ({ vehiclePrice, usefulLifeYears }) => {
      const annualOnly = deriveAnnualDepreciation({ vehiclePrice, usefulLifeYears });
      const full = deriveDepreciation({
        vehiclePrice,
        usefulLifeYears,
        estimatedAnnualKm: 20000,
      });
      expect(annualOnly.ok).toBe(true);
      expect(full.ok).toBe(true);
      if (annualOnly.ok && full.ok) {
        expect(annualOnly.annualDepreciation).toBe(full.annualDepreciation);
        expect(hasDecimalPlaces(annualOnly.annualDepreciation, 2)).toBe(true);
      }
    }
  );

  it("結構性斷言：`vehiclePrice ÷ usefulLifeYears` 於實作中恰一份（禁止第二份拷貝）", () => {
    const blanked = blankCommentsAndStrings(fs.readFileSync(ENGINE_SRC_PATH, "utf8"));
    // 收斂方法鏈周邊空白，避免 formatter 折行影響比對。
    const chained = blanked.replace(/\s*\.\s*/g, ".");
    const byYears = chained.match(/\.dividedBy\(usefulLifeYears\)/g) ?? [];
    expect(byYears.length).toBe(1);
    // 除法別名（`.div(`）不得出現，否則第二份實作可繞過上面的計數。
    expect((chained.match(/\.div\(/g) ?? []).length).toBe(0);
    // 全檔除法總數恰 2：每年費用一次 ＋ deriveDepreciation 之每公里單價一次。
    expect((chained.match(/\.dividedBy\(/g) ?? []).length).toBe(2);
    // 掃描器鑑別力自證：合成之第二份拷貝片段必被上述樣式計數命中。
    const mutantSnippet = blankCommentsAndStrings(
      "const copy = price.dividedBy(usefulLifeYears);"
    ).replace(/\s*\.\s*/g, ".");
    expect((mutantSnippet.match(/\.dividedBy\(usefulLifeYears\)/g) ?? []).length).toBe(1);
  });

  it("結構性斷言：2dp 之取整規模為單一具名常數（恰一處 toDecimalPlaces 用於每年費用）", () => {
    const blanked = blankCommentsAndStrings(fs.readFileSync(ENGINE_SRC_PATH, "utf8"));
    const compact = compactWhitespace(blanked);
    // 具名常數恰一處宣告，且逐字為 2（AC-49(a) 之「2dp 逐字」）。
    const declarations = blanked.match(/const\s+ANNUAL_DEPRECIATION_SCALE\s*=\s*2\s*;/g) ?? [];
    expect(declarations.length).toBe(1);
    // 每年費用之取整與定寬字串一律引用該常數，實作中不得出現裸 `2` 字面。
    expect((compact.match(/\.toDecimalPlaces\(ANNUAL_DEPRECIATION_SCALE,/g) ?? []).length).toBe(1);
    expect((compact.match(/\.toFixed\(ANNUAL_DEPRECIATION_SCALE\)/g) ?? []).length).toBe(1);
    expect((compact.match(/\.toDecimalPlaces\(2,/g) ?? []).length).toBe(0);
    expect((compact.match(/\.toFixed\(2\)/g) ?? []).length).toBe(0);
  });

  it("結構性斷言：每年費用之取整模式逐字為 ROUND_HALF_UP（不得為 half-even）", () => {
    const compact = compactWhitespace(
      blankCommentsAndStrings(fs.readFileSync(ENGINE_SRC_PATH, "utf8"))
    );
    expect(compact).toMatch(
      /\.toDecimalPlaces\(ANNUAL_DEPRECIATION_SCALE,Prisma\.Decimal\.ROUND_HALF_UP\)/
    );
    expect(compact).not.toMatch(/ROUND_HALF_EVEN/);
  });
});
