/**
 * Unit tests: PHASE-004-T6 — 差旅補助計算引擎（travel-calculation.ts）
 *
 * Pure function, no DB, no IO. Spec §1.1 第 6 點、§2 群組 F（AC-37~44）、
 * §5 邊界 B-02/B-03/B-06/B-07/B-08、§8.1 `TravelComputedDto`、§9「金額預覽
 * （stateless）」計算虛擬碼、§11.1「計算引擎 ≥ 25 案例」六項鑑別力、
 * §17.1 D4（取整前 `Decimal(14,4)`、最終 `Int`、`ROUND_HALF_UP`、禁浮點）。
 *
 * TDD: written BEFORE `travel-calculation.ts` exists; first run must be RED
 * (module not found).
 *
 * 計算語意（逐字，§9 虛擬碼）：
 *   segFuel = totalKm × fuelUnitPrice          （未取整）
 *   segEtc  = highwayKm × etcUnitPrice         （未取整）
 *   segRaw  = segFuel + segEtc                 （先相加）
 *   segAmt  = ROUND_HALF_UP(segRaw, 0)         （再取整；非銀行家）
 *   totalAmount    = Σ segAmt                  （加總已取整值）
 *   totalRawAmount = Σ segRaw                  （取整前總和，供快照）
 *   totalKm        = Σ totalKm                 （高速里程不重複加）
 *
 * ── 六項鑑別力自證（若實作寫成下列錯誤版，對應測試會轉紅）──────────────────
 *
 * ①「先相加再取整」非「各自取整再相加」
 *    案例：fuelAmount=0.4、etcAmount=0.4 → rawAmount=0.8 → amount=1
 *    錯誤版（各自取整再相加）：round(0.4)+round(0.4) = 0+0 = 0 → 測試「鑑別力①」轉紅
 *
 * ② round-half-up 非 half-even（銀行家取整）
 *    案例：rawAmount=2.5 → amount=3（half-even 會得偶數 2，因 2 為偶數捨去）
 *    錯誤版（half-even）：2.5 → 2 → 測試「鑑別力②」轉紅
 *    （3.5→4 兩法一致，僅作一致性佐證，非鑑別關鍵點）
 *
 * ③ 整筆 = Σ 各段「已取整」金額，非「先加未取整再取整」
 *    案例：三段各 rawAmount=0.5 → 各段 amount=1 → totalAmount=3
 *    錯誤版（先加未取整再取整）：Σraw=1.5 → round(1.5)=2 → 測試「鑑別力③」轉紅
 *
 * ④ 總里程 = Σ 各段 totalKm，高速里程不重複加
 *    案例：單段 totalKm=10, highwayKm=10 → result.totalKm=10
 *    錯誤版（誤把 highwayKm 也計入總里程）：10+10=20 → 測試「鑑別力④」轉紅
 *
 * ⑤ 精度：單價 4 位小數 × 里程 2 位小數之乘積須精確（Decimal，非浮點）
 *    案例：fuelUnitPrice="5.1234" × totalKm="12.35" = 63.27399（精確值）
 *    錯誤版（改用浮點 Number 相乘）：JS float64 對此類乘積可能失真
 *    （即使本例恰巧不失真，浮點實作在其他組合仍會失真；本測試以精確
 *    Decimal 相等斷言把任何浮點中介都攔下）→ 測試「鑑別力⑤」轉紅
 *
 * ⑥ 空段陣列 → 金額 0、不拋例外、不回 NaN
 *    案例：segments=[] → totalAmount=0, totalKm=0, totalRawAmount=0, segments=[]
 *    錯誤版（未防禦空陣列，例如對 reduce 沒給初始值）：拋例外或回 NaN
 *    → 測試「鑑別力⑥」轉紅
 */

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  type CalcSegmentInput,
  calculateTravel,
} from "../../src/applications/travel-calculation.js";

// ─── helpers ──────────────────────────────────────────────────────────────

const D = (v: string | number): Prisma.Decimal => new Prisma.Decimal(v);

function seg(
  segmentId: string | null,
  segmentIndex: number,
  totalKm: string,
  highwayKm: string
): CalcSegmentInput {
  return {
    segmentId,
    segmentIndex,
    totalKm: D(totalKm),
    highwayKm: D(highwayKm),
  };
}

// ─── AC-37/38: 單段 fuelAmount / etcAmount 未取整 ──────────────────────────

describe("calculateTravel — AC-37/38: 單段 fuelAmount/etcAmount（未取整）", () => {
  it("fuelAmount = totalKm × fuelUnitPrice（未取整）", () => {
    const result = calculateTravel({
      segments: [seg("s1", 0, "10", "0")],
      fuelUnitPrice: D("1.2345"),
      etcUnitPrice: D("0"),
    });
    expect(result.segments[0].fuelAmount.equals(D("12.345"))).toBe(true);
  });

  it("etcAmount = highwayKm × etcUnitPrice（未取整）", () => {
    const result = calculateTravel({
      segments: [seg("s1", 0, "5", "4")],
      fuelUnitPrice: D("0"),
      etcUnitPrice: D("2.5"),
    });
    expect(result.segments[0].etcAmount.equals(D("10"))).toBe(true);
    expect(result.segments[0].fuelAmount.equals(D("0"))).toBe(true);
  });
});

// ─── 鑑別力① AC-39：先相加再取整 ────────────────────────────────────────────

describe("calculateTravel — 鑑別力①（AC-39）先相加再取整，非各自取整再相加", () => {
  it("fuelAmount=0.4, etcAmount=0.4 → rawAmount=0.8 → amount=1（錯誤版得 0）", () => {
    // totalKm=2 × fuelUnitPrice=0.2 = 0.4；highwayKm=1 × etcUnitPrice=0.4 = 0.4
    const result = calculateTravel({
      segments: [seg("s1", 0, "2", "1")],
      fuelUnitPrice: D("0.2"),
      etcUnitPrice: D("0.4"),
    });
    const s = result.segments[0];
    expect(s.fuelAmount.equals(D("0.4"))).toBe(true);
    expect(s.etcAmount.equals(D("0.4"))).toBe(true);
    expect(s.rawAmount.equals(D("0.8"))).toBe(true);
    expect(s.amount).toBe(1);
  });
});

// ─── 鑑別力② AC-40：round-half-up 非 half-even ─────────────────────────────

describe("calculateTravel — 鑑別力②（AC-40）round-half-up 非 half-even（銀行家取整）", () => {
  it("rawAmount=2.5 → amount=3（half-even 會得偶數 2，此為關鍵鑑別點）", () => {
    const result = calculateTravel({
      segments: [seg("s1", 0, "1", "0")],
      fuelUnitPrice: D("2.5"),
      etcUnitPrice: D("0"),
    });
    expect(result.segments[0].rawAmount.equals(D("2.5"))).toBe(true);
    expect(result.segments[0].amount).toBe(3);
  });

  it("rawAmount=3.5 → amount=4（一致性佐證：half-even 對此案例亦得 4）", () => {
    const result = calculateTravel({
      segments: [seg("s1", 0, "1", "0")],
      fuelUnitPrice: D("3.5"),
      etcUnitPrice: D("0"),
    });
    expect(result.segments[0].amount).toBe(4);
  });

  it("round-half-up 邊界之下（2.49 → 2）、之上（2.51 → 3）皆正確捨入", () => {
    const below = calculateTravel({
      segments: [seg("s1", 0, "1", "0")],
      fuelUnitPrice: D("2.49"),
      etcUnitPrice: D("0"),
    });
    const above = calculateTravel({
      segments: [seg("s1", 0, "1", "0")],
      fuelUnitPrice: D("2.51"),
      etcUnitPrice: D("0"),
    });
    expect(below.segments[0].amount).toBe(2);
    expect(above.segments[0].amount).toBe(3);
  });
});

// ─── 鑑別力③ AC-41：整筆 = Σ 已取整金額 ────────────────────────────────────

describe("calculateTravel — 鑑別力③（AC-41）整筆 = Σ 各段已取整金額", () => {
  it("三段各 rawAmount=0.5 → 各段 amount=1 → totalAmount=3（錯誤版「先加未取整再取整」得 2）", () => {
    const result = calculateTravel({
      segments: [seg("s1", 0, "1", "0"), seg("s2", 1, "1", "0"), seg("s3", 2, "1", "0")],
      fuelUnitPrice: D("0.5"),
      etcUnitPrice: D("0"),
    });
    expect(result.segments.map((s) => s.amount)).toEqual([1, 1, 1]);
    expect(result.totalAmount).toBe(3);
    // totalRawAmount 仍為 Σ 未取整值 = 1.5（供快照，非取整後總和）
    expect(result.totalRawAmount.equals(D("1.5"))).toBe(true);
  });

  it("totalRawAmount = Σ 各段 rawAmount（取整前），非 Σ 取整後 amount", () => {
    // 兩段各 rawAmount=0.3 → 各段 amount=round(0.3)=0 → totalAmount=0
    // 但 totalRawAmount 應為 0.6，證明不是拿 amount 加總
    const result = calculateTravel({
      segments: [seg("s1", 0, "1", "0"), seg("s2", 1, "1", "0")],
      fuelUnitPrice: D("0.3"),
      etcUnitPrice: D("0"),
    });
    expect(result.segments.map((s) => s.amount)).toEqual([0, 0]);
    expect(result.totalAmount).toBe(0);
    expect(result.totalRawAmount.equals(D("0.6"))).toBe(true);
  });
});

// ─── 鑑別力④ AC-42：高速里程不重複加 ───────────────────────────────────────

describe("calculateTravel — 鑑別力④（AC-42）總里程不重複加高速里程", () => {
  it("單段 totalKm=10, highwayKm=10 → result.totalKm=10（非 20）", () => {
    const result = calculateTravel({
      segments: [seg("s1", 0, "10", "10")],
      fuelUnitPrice: D("1"),
      etcUnitPrice: D("1"),
    });
    expect(result.totalKm.equals(D("10"))).toBe(true);
  });

  it("多段混合：totalKm 各為 10 與 3.33，highwayKm 各非 0 → totalKm=13.33", () => {
    const result = calculateTravel({
      segments: [seg("s1", 0, "10", "5"), seg("s2", 1, "3.33", "1.11")],
      fuelUnitPrice: D("1"),
      etcUnitPrice: D("1"),
    });
    expect(result.totalKm.equals(D("13.33"))).toBe(true);
  });
});

// ─── 鑑別力⑤ 精度：4 位小數單價 × 2 位小數里程 ─────────────────────────────

describe("calculateTravel — 鑑別力⑤ 精度（Decimal 精確，非浮點）", () => {
  it("fuelUnitPrice='5.1234' × totalKm='12.35' → fuelAmount 精確為 63.27399", () => {
    const result = calculateTravel({
      segments: [seg("s1", 0, "12.35", "0")],
      fuelUnitPrice: D("5.1234"),
      etcUnitPrice: D("0"),
    });
    const s = result.segments[0];
    expect(s.fuelAmount.equals(D("63.27399"))).toBe(true);
    expect(s.rawAmount.equals(D("63.27399"))).toBe(true);
    expect(s.amount).toBe(63);
  });

  it("大數值精度不失真：totalKm='123456.78' × fuelUnitPrice='1.2345' → 152407.39491", () => {
    const result = calculateTravel({
      segments: [seg("s1", 0, "123456.78", "0")],
      fuelUnitPrice: D("1.2345"),
      etcUnitPrice: D("0"),
    });
    expect(result.segments[0].fuelAmount.equals(D("152407.39491"))).toBe(true);
    expect(result.segments[0].amount).toBe(152407);
  });

  it("油資與 ETC 皆有小數，rawAmount 精確加總：7.25×1.1111 + 3.10×2.2222 = 14.944295", () => {
    const result = calculateTravel({
      segments: [seg("s1", 0, "7.25", "3.10")],
      fuelUnitPrice: D("1.1111"),
      etcUnitPrice: D("2.2222"),
    });
    const s = result.segments[0];
    expect(s.fuelAmount.equals(D("8.055475"))).toBe(true);
    expect(s.etcAmount.equals(D("6.88882"))).toBe(true);
    expect(s.rawAmount.equals(D("14.944295"))).toBe(true);
    expect(s.amount).toBe(15);
  });
});

// ─── 鑑別力⑥ 空段陣列 ─────────────────────────────────────────────────────

describe("calculateTravel — 鑑別力⑥ 空段陣列：金額 0，不拋例外，不回 NaN", () => {
  it("segments=[] → totalAmount=0, totalKm=0, totalRawAmount=0, segments=[]", () => {
    const result = calculateTravel({
      segments: [],
      fuelUnitPrice: D("1.2345"),
      etcUnitPrice: D("2.5"),
    });
    expect(result.segments).toEqual([]);
    expect(result.totalAmount).toBe(0);
    expect(result.totalKm.equals(D("0"))).toBe(true);
    expect(result.totalRawAmount.equals(D("0"))).toBe(true);
  });

  it("空段陣列呼叫不拋例外", () => {
    expect(() =>
      calculateTravel({ segments: [], fuelUnitPrice: D("0"), etcUnitPrice: D("0") })
    ).not.toThrow();
  });

  it("空段陣列結果無 NaN（totalAmount 為有效數字）", () => {
    const result = calculateTravel({
      segments: [],
      fuelUnitPrice: D("1"),
      etcUnitPrice: D("1"),
    });
    expect(Number.isNaN(result.totalAmount)).toBe(false);
    expect(Number.isFinite(result.totalAmount)).toBe(true);
  });
});

// ─── B-02: highwayKm=0 → etcAmount=0 ───────────────────────────────────────

describe("calculateTravel — B-02: highwayKm=0 → etcAmount=0，金額僅來自油資", () => {
  it("highwayKm=0，etcUnitPrice 非 0 → etcAmount 仍為 0", () => {
    const result = calculateTravel({
      segments: [seg("s1", 0, "10", "0")],
      fuelUnitPrice: D("1"),
      etcUnitPrice: D("5"),
    });
    const s = result.segments[0];
    expect(s.etcAmount.equals(D("0"))).toBe(true);
    expect(s.fuelAmount.equals(D("10"))).toBe(true);
    expect(s.amount).toBe(10);
  });
});

// ─── B-03: highwayKm == totalKm ────────────────────────────────────────────

describe("calculateTravel — B-03: highwayKm == totalKm", () => {
  it("highwayKm=totalKm=8 → 油資與 ETC 皆正常計入，totalKm 仍只計一次", () => {
    const result = calculateTravel({
      segments: [seg("s1", 0, "8", "8")],
      fuelUnitPrice: D("1"),
      etcUnitPrice: D("1"),
    });
    const s = result.segments[0];
    expect(s.fuelAmount.equals(D("8"))).toBe(true);
    expect(s.etcAmount.equals(D("8"))).toBe(true);
    expect(s.rawAmount.equals(D("16"))).toBe(true);
    expect(s.amount).toBe(16);
    expect(result.totalKm.equals(D("8"))).toBe(true);
  });
});

// ─── 單價為 0（合法） ────────────────────────────────────────────────────

describe("calculateTravel — 單價為 0（003a 允許 ≥0）→ 金額 0", () => {
  it("fuelUnitPrice=0, etcUnitPrice=0 → 各段與整筆金額皆 0", () => {
    const result = calculateTravel({
      segments: [seg("s1", 0, "100", "50")],
      fuelUnitPrice: D("0"),
      etcUnitPrice: D("0"),
    });
    expect(result.segments[0].amount).toBe(0);
    expect(result.totalAmount).toBe(0);
  });
});

// ─── 多段混合整筆加總 ───────────────────────────────────────────────────

describe("calculateTravel — 多段混合（不同里程、不同結果）之整筆加總", () => {
  it("兩段不同里程 → 各段金額不同，totalAmount/totalKm/totalRawAmount 正確加總", () => {
    const result = calculateTravel({
      segments: [seg("a", 0, "10", "5"), seg("b", 1, "3.33", "1.11")],
      fuelUnitPrice: D("2"),
      etcUnitPrice: D("3"),
    });
    // segA: fuel=20, etc=15, raw=35, amount=35
    // segB: fuel=6.66, etc=3.33, raw=9.99, amount=round_half_up(9.99)=10
    expect(result.segments[0].amount).toBe(35);
    expect(result.segments[1].rawAmount.equals(D("9.99"))).toBe(true);
    expect(result.segments[1].amount).toBe(10);
    expect(result.totalAmount).toBe(45);
    expect(result.totalKm.equals(D("13.33"))).toBe(true);
    expect(result.totalRawAmount.equals(D("44.99"))).toBe(true);
  });
});

// ─── segmentId：null（預覽）與有值皆正確回傳 ────────────────────────────

describe("calculateTravel — segmentId 透傳（null 與有值）", () => {
  it("segmentId=null（預覽情境）→ 輸出 segmentId 亦為 null", () => {
    const result = calculateTravel({
      segments: [seg(null, 0, "10", "0")],
      fuelUnitPrice: D("1"),
      etcUnitPrice: D("1"),
    });
    expect(result.segments[0].segmentId).toBeNull();
  });

  it("segmentId 有值 → 輸出 segmentId 原樣透傳", () => {
    const result = calculateTravel({
      segments: [seg("segment-xyz-123", 0, "10", "0")],
      fuelUnitPrice: D("1"),
      etcUnitPrice: D("1"),
    });
    expect(result.segments[0].segmentId).toBe("segment-xyz-123");
  });
});

// ─── segmentIndex 與輸入一一對應 ──────────────────────────────────────────

describe("calculateTravel — segmentIndex 與輸入一一對應", () => {
  it("多段輸出 segmentIndex 依輸入順序原樣對應", () => {
    const result = calculateTravel({
      segments: [seg("a", 0, "1", "0"), seg("b", 1, "1", "0"), seg("c", 2, "1", "0")],
      fuelUnitPrice: D("1"),
      etcUnitPrice: D("1"),
    });
    expect(result.segments.map((s) => s.segmentIndex)).toEqual([0, 1, 2]);
  });

  it("segmentIndex 為輸入透傳值，非重新計算的位置（單段 segmentIndex=5 仍原樣輸出）", () => {
    const result = calculateTravel({
      segments: [seg("only", 5, "1", "0")],
      fuelUnitPrice: D("1"),
      etcUnitPrice: D("1"),
    });
    expect(result.segments[0].segmentIndex).toBe(5);
  });
});

// ─── AC-44：純函式，相同輸入恆同輸出 ────────────────────────────────────

describe("calculateTravel — AC-44 純函式：相同輸入呼叫兩次，結果完全相同", () => {
  it("同一輸入呼叫兩次 → totalAmount/totalKm/totalRawAmount/segments 完全相同", () => {
    const input = {
      segments: [seg("a", 0, "10.55", "3.21"), seg("b", 1, "7.77", "0")],
      fuelUnitPrice: D("1.2345"),
      etcUnitPrice: D("6.789"),
    };
    const r1 = calculateTravel(input);
    const r2 = calculateTravel(input);

    expect(r1.totalAmount).toBe(r2.totalAmount);
    expect(r1.totalKm.equals(r2.totalKm)).toBe(true);
    expect(r1.totalRawAmount.equals(r2.totalRawAmount)).toBe(true);
    expect(r1.segments.length).toBe(r2.segments.length);
    for (let i = 0; i < r1.segments.length; i++) {
      expect(r1.segments[i].amount).toBe(r2.segments[i].amount);
      expect(r1.segments[i].rawAmount.equals(r2.segments[i].rawAmount)).toBe(true);
      expect(r1.segments[i].fuelAmount.equals(r2.segments[i].fuelAmount)).toBe(true);
      expect(r1.segments[i].etcAmount.equals(r2.segments[i].etcAmount)).toBe(true);
      expect(r1.segments[i].segmentId).toBe(r2.segments[i].segmentId);
      expect(r1.segments[i].segmentIndex).toBe(r2.segments[i].segmentIndex);
    }
  });
});

// ─── 輸入物件未被變更（no mutation） ─────────────────────────────────────

describe("calculateTravel — 純函式：輸入物件未被變更（no mutation）", () => {
  it("呼叫後，輸入段落之 Decimal 值（totalKm/highwayKm）與單價維持不變", () => {
    const segments = [seg("a", 0, "10.55", "3.21"), seg("b", 1, "7.77", "1.10")];
    const fuelUnitPrice = D("1.2345");
    const etcUnitPrice = D("6.789");

    // 深比較快照（呼叫前）
    const beforeSnapshot = segments.map((s) => ({
      segmentId: s.segmentId,
      segmentIndex: s.segmentIndex,
      totalKm: s.totalKm.toString(),
      highwayKm: s.highwayKm.toString(),
    }));
    const fuelBefore = fuelUnitPrice.toString();
    const etcBefore = etcUnitPrice.toString();

    calculateTravel({ segments, fuelUnitPrice, etcUnitPrice });

    const afterSnapshot = segments.map((s) => ({
      segmentId: s.segmentId,
      segmentIndex: s.segmentIndex,
      totalKm: s.totalKm.toString(),
      highwayKm: s.highwayKm.toString(),
    }));

    expect(afterSnapshot).toEqual(beforeSnapshot);
    expect(fuelUnitPrice.toString()).toBe(fuelBefore);
    expect(etcUnitPrice.toString()).toBe(etcBefore);
  });
});

// ─── amount / totalAmount 型別：整數 number ────────────────────────────

describe("calculateTravel — amount 與 totalAmount 一律為整數 number", () => {
  it("各段 amount 恆為整數（Number.isInteger）", () => {
    const result = calculateTravel({
      segments: [seg("a", 0, "10.55", "3.21"), seg("b", 1, "7.77", "1.10")],
      fuelUnitPrice: D("1.2345"),
      etcUnitPrice: D("6.789"),
    });
    for (const s of result.segments) {
      expect(Number.isInteger(s.amount)).toBe(true);
    }
    expect(Number.isInteger(result.totalAmount)).toBe(true);
  });
});
