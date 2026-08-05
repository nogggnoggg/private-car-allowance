/**
 * Unit tests — CHORE-003-T1
 *
 * PHASE-003a Spec §14（ACTIVE）：參數欄位容量、精度與字串保真。
 * 涵蓋 AC-21~AC-28 之 U（unit，零 IO）層與 AC-32（檢查順序決定性 + 多欄位彙總）。
 *
 * CD 裁定（§13 修訂列，2026-08-03 人類 leonchih）：
 *   CD-1(a) 前後空白 trim 後判定；CD-2(a) 非標準十進位字面一律 400；
 *   CD-3(a) 折舊整數欄位 int4 容量納入本回合。
 *
 * 本檔為純函式測試，不連 DB、不起 server。I 層（wire-level 400 合約、
 * DB 無新增列、日誌不外洩）屬 CHORE-003-T2/T3，不在本檔範圍。
 */

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  DEPRECIATION_VEHICLE_PRICE_CAPACITY,
  INT4_MAX,
  PARAMETER_DECIMAL_LITERAL_PATTERN,
  UNIT_PRICE_CAPACITY,
  decimalColumnCapacity,
  parseParameterDecimalField,
  parseParameterIntField,
} from "../../src/parameters/parameter-validation.js";

// ---------------------------------------------------------------------------
// helpers（測試專用；不進入正式碼）
// ---------------------------------------------------------------------------

function expectOk(result: ReturnType<typeof parseParameterDecimalField>): Prisma.Decimal {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function expectError(result: ReturnType<typeof parseParameterDecimalField>): {
  field: string;
  reason: string;
} {
  if (result.ok) {
    throw new Error(`expected error, got ok: ${result.value.toString()}`);
  }
  return result.error;
}

const unitPrice = (value: unknown) =>
  parseParameterDecimalField(value, "unitPrice", UNIT_PRICE_CAPACITY);
const vehiclePrice = (value: unknown) =>
  parseParameterDecimalField(value, "vehiclePrice", DEPRECIATION_VEHICLE_PRICE_CAPACITY);

// ---------------------------------------------------------------------------
// 容量常數來源（§14.7 備註：上限常數須綁欄位容量推導，不得寫死無來源魔術數）
// ---------------------------------------------------------------------------

describe("容量常數綁 Prisma 欄位定義推導（§14.7 實作備註）", () => {
  it("decimalColumnCapacity(precision, scale) 推導整數位數 = precision - scale", () => {
    expect(decimalColumnCapacity(10, 4)).toEqual({ scale: 4, integerDigits: 6 });
    expect(decimalColumnCapacity(12, 2)).toEqual({ scale: 2, integerDigits: 10 });
  });

  it("unitPrice 綁 Decimal(10,4)、vehiclePrice 綁 Decimal(12,2)、整數欄位綁 int4", () => {
    expect(UNIT_PRICE_CAPACITY).toEqual(decimalColumnCapacity(10, 4));
    expect(DEPRECIATION_VEHICLE_PRICE_CAPACITY).toEqual(decimalColumnCapacity(12, 2));
    expect(INT4_MAX).toBe(2 ** 31 - 1);
  });
});

// ---------------------------------------------------------------------------
// AC-21
// ---------------------------------------------------------------------------

describe("AC-21 unitPrice ≥1e6 → 400（含 999999.9999 → 201 上界鑑別）", () => {
  it('上界內最大值 "999999.9999" 通過且值保真', () => {
    expect(expectOk(unitPrice("999999.9999")).toFixed(4)).toBe("999999.9999");
  });

  it('恰為上界 "1000000" 被拒（捕捉 > 與 >= 之誤用）', () => {
    expect(expectError(unitPrice("1000000"))).toEqual({
      field: "unitPrice",
      reason: "數值超出可儲存範圍（整數部分最多 6 位）",
    });
  });

  it('number 型別 1000000、字串 "12345678.9" 同樣被拒', () => {
    expect(expectError(unitPrice(1000000)).reason).toBe("數值超出可儲存範圍（整數部分最多 6 位）");
    expect(expectError(unitPrice("12345678.9")).reason).toBe(
      "數值超出可儲存範圍（整數部分最多 6 位）"
    );
  });

  it('負向同樣以絕對值判定："-1000000" 被拒、"-999999.9999" 通過格式層', () => {
    expect(expectError(unitPrice("-1000000")).reason).toBe(
      "數值超出可儲存範圍（整數部分最多 6 位）"
    );
    // 負值本身屬值域層（AC-03 `單價不得小於 0`，不在本模組），格式層放行。
    expect(expectOk(unitPrice("-999999.9999")).toFixed(4)).toBe("-999999.9999");
  });

  it("error.field 精確回傳呼叫端指定之欄位名", () => {
    expect(
      expectError(parseParameterDecimalField("1000000", "unitPrice", UNIT_PRICE_CAPACITY)).field
    ).toBe("unitPrice");
  });
});

// ---------------------------------------------------------------------------
// AC-22
// ---------------------------------------------------------------------------

describe("AC-22 vehiclePrice ≥1e10 → 400（含 9999999999.99 → 201 上界鑑別）", () => {
  it('上界內最大值 "9999999999.99" 通過且值保真', () => {
    expect(expectOk(vehiclePrice("9999999999.99")).toFixed(2)).toBe("9999999999.99");
  });

  it('恰為上界 "10000000000" 被拒', () => {
    expect(expectError(vehiclePrice("10000000000"))).toEqual({
      field: "vehiclePrice",
      reason: "數值超出可儲存範圍（整數部分最多 10 位）",
    });
  });

  it("量級文案依欄位容量而異（6 位 vs 10 位），不共用同一字串", () => {
    expect(expectError(unitPrice("1000000")).reason).not.toBe(
      expectError(vehiclePrice("10000000000")).reason
    );
  });
});

// ---------------------------------------------------------------------------
// AC-23
// ---------------------------------------------------------------------------

describe('AC-23 unitPrice >4 位小數 → 400；尾隨零 "19.90000" → 201', () => {
  it('"0.0000001"、"1.23456"、number 0.00001 皆被拒（不再靜默截斷為 0.0000）', () => {
    for (const value of ["0.0000001", "1.23456", 0.00001]) {
      expect(expectError(unitPrice(value))).toEqual({
        field: "unitPrice",
        reason: "最多允許 4 位小數",
      });
    }
  });

  it('尾隨零 "19.90000" 通過並存 19.9000（以值而非字面字元數判定）', () => {
    const value = expectOk(unitPrice("19.90000"));
    expect(value.decimalPlaces()).toBe(1);
    expect(value.toFixed(4)).toBe("19.9000");
  });

  it('恰為上界 4 位小數 "1.2345"、以及 "3.5000"／0 通過', () => {
    expect(expectOk(unitPrice("1.2345")).toFixed(4)).toBe("1.2345");
    expect(expectOk(unitPrice("3.5000")).toFixed(4)).toBe("3.5000");
    expect(expectOk(unitPrice(0)).toFixed(4)).toBe("0.0000");
  });
});

// ---------------------------------------------------------------------------
// AC-24
// ---------------------------------------------------------------------------

describe('AC-24 vehiclePrice >2 位小數 → 400；"600000.500" → 201', () => {
  it('"600000.005" 被拒（不再靜默進位為 600000.01）', () => {
    expect(expectError(vehiclePrice("600000.005"))).toEqual({
      field: "vehiclePrice",
      reason: "最多允許 2 位小數",
    });
  });

  it('"600000.00"／"600000.5"／"600000.05" 通過', () => {
    expect(expectOk(vehiclePrice("600000.00")).toFixed(2)).toBe("600000.00");
    expect(expectOk(vehiclePrice("600000.5")).toFixed(2)).toBe("600000.50");
    expect(expectOk(vehiclePrice("600000.05")).toFixed(2)).toBe("600000.05");
  });

  it('尾隨零 "600000.500" 通過，證明判定基於值而非字面', () => {
    const value = expectOk(vehiclePrice("600000.500"));
    expect(value.decimalPlaces()).toBe(1);
    expect(value.toFixed(2)).toBe("600000.50");
  });

  it('小數位上限隨欄位 scale 變動："1.234" 於 unitPrice 通過、於 vehiclePrice 被拒', () => {
    expect(expectOk(unitPrice("1.234")).toFixed(4)).toBe("1.2340");
    expect(expectError(vehiclePrice("1.234")).reason).toBe("最多允許 2 位小數");
  });
});

// ---------------------------------------------------------------------------
// AC-25
// ---------------------------------------------------------------------------

describe("AC-25 非十進位字面 → 400（Infinity／1e400 斷言為 400 而非 500）", () => {
  const LITERAL_REASON = "必須為有效的十進位數值（不接受指數記號）";

  it('字串 "abc"／"1e5"／".5"／"19."／"+19.9"／"0x10" 一律被拒（CD-2(a)）', () => {
    for (const value of ["abc", "1e5", ".5", "19.", "+19.9", "0x10", "1,000", "--1", "1.2.3"]) {
      expect(expectError(unitPrice(value)), `input=${value}`).toEqual({
        field: "unitPrice",
        reason: LITERAL_REASON,
      });
    }
  });

  it('字串 "Infinity"／"NaN"／"-Infinity" 被拒（原 500 路徑消滅）', () => {
    for (const value of ["Infinity", "NaN", "-Infinity"]) {
      expect(expectError(unitPrice(value)).reason, `input=${value}`).toBe(LITERAL_REASON);
    }
  });

  it("number 型別 1e-7／1e21／1e400(=Infinity)／NaN／-Infinity 被拒", () => {
    // 以 JSON.parse 產生 1e400，忠實重現 wire 路徑（request body 內的 JSON number）
    const jsonOneE400 = JSON.parse("1e400") as number;
    expect(jsonOneE400).toBe(Number.POSITIVE_INFINITY);

    for (const value of [1e-7, 1e21, jsonOneE400, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(expectError(unitPrice(value)).reason, `input=${String(value)}`).toBe(LITERAL_REASON);
    }
  });

  it('vehiclePrice 同樣適用（"abc" 由格式層攔截，取代舊 catch 分支文案）', () => {
    expect(expectError(vehiclePrice("abc"))).toEqual({
      field: "vehiclePrice",
      reason: LITERAL_REASON,
    });
  });

  it("防呆證明：小數位檢查單獨無法擋下 Infinity／NaN，故字面 pattern 為必要守門", () => {
    // CD-2 實作警示：Prisma.Decimal 接受 "Infinity"／"NaN" 且不拋錯。
    const inf = new Prisma.Decimal("Infinity");
    const nan = new Prisma.Decimal("NaN");
    expect(Number.isNaN(inf.decimalPlaces())).toBe(true);
    expect(Number.isNaN(nan.decimalPlaces())).toBe(true);
    // 若僅以 decimalPlaces() > scale 判定，兩者皆會漏放（NaN > 4 === false）
    expect(inf.decimalPlaces() > UNIT_PRICE_CAPACITY.scale).toBe(false);
    expect(nan.decimalPlaces() > UNIT_PRICE_CAPACITY.scale).toBe(false);
    // 守門仍在：pattern 直接拒絕，且整體函式亦拒絕
    expect(PARAMETER_DECIMAL_LITERAL_PATTERN.test("Infinity")).toBe(false);
    expect(PARAMETER_DECIMAL_LITERAL_PATTERN.test("NaN")).toBe(false);
    expect(unitPrice("Infinity").ok).toBe(false);
    expect(unitPrice("NaN").ok).toBe(false);
  });

  it("pattern 只收標準十進位字面（正例／反例對照）", () => {
    for (const literal of ["0", "-0", "19", "19.9", "-19.90000", "999999.9999"]) {
      expect(PARAMETER_DECIMAL_LITERAL_PATTERN.test(literal), `literal=${literal}`).toBe(true);
    }
    for (const literal of ["", " 19.9", "+19", ".5", "19.", "1e5", "0x10", "Infinity"]) {
      expect(PARAMETER_DECIMAL_LITERAL_PATTERN.test(literal), `literal=${literal}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-26
// ---------------------------------------------------------------------------

describe("AC-26 boolean／array／object → 400（U 層：型別守門）", () => {
  const TYPE_REASON = "必須為有效的數值（字串或數字）";

  it("true／false 被拒（現行分別靜默存 1.0000／0.0000）", () => {
    expect(expectError(unitPrice(true))).toEqual({ field: "unitPrice", reason: TYPE_REASON });
    expect(expectError(unitPrice(false))).toEqual({ field: "unitPrice", reason: TYPE_REASON });
  });

  it('[]／["5"]／{} 被拒（現行分別靜默存 0.0000／5.0000）', () => {
    for (const value of [[], ["5"], {}, { value: 5 }]) {
      expect(expectError(unitPrice(value)).reason, `input=${JSON.stringify(value)}`).toBe(
        TYPE_REASON
      );
    }
  });

  it("null／undefined 亦不被視為數值（必填檢查在上游 route 層，此處為最後守門）", () => {
    expect(expectError(unitPrice(null)).reason).toBe(TYPE_REASON);
    expect(expectError(unitPrice(undefined)).reason).toBe(TYPE_REASON);
  });

  it("vehiclePrice 同樣適用", () => {
    expect(expectError(vehiclePrice(true))).toEqual({ field: "vehiclePrice", reason: TYPE_REASON });
  });
});

// ---------------------------------------------------------------------------
// AC-27
// ---------------------------------------------------------------------------

describe("AC-27 前後空白字串處置（CD-1(a) trim 後判定）；全空白 → 400", () => {
  it('" 19.9 " trim 後通過並存 19.9000（值完全保真）', () => {
    expect(expectOk(unitPrice(" 19.9 ")).toFixed(4)).toBe("19.9000");
  });

  it('" 600000 "（vehiclePrice）trim 後通過並存 600000.00（B-20 唯一放寬）', () => {
    expect(expectOk(vehiclePrice(" 600000 ")).toFixed(2)).toBe("600000.00");
  });

  it('全空白 "   "／"\\t\\n" 被拒（廢止 Number("   ")===0 之靜默寫入）', () => {
    for (const value of ["   ", "\t\n", " "]) {
      expect(expectError(unitPrice(value)), `input=${JSON.stringify(value)}`).toEqual({
        field: "unitPrice",
        reason: "必須為有效的數值",
      });
    }
  });

  it('空字串 "" 被拒', () => {
    expect(expectError(unitPrice("")).reason).toBe("必須為有效的數值");
  });

  it('" abc " 被拒（trim 後仍非十進位字面）', () => {
    expect(expectError(unitPrice(" abc ")).reason).toBe("必須為有效的十進位數值（不接受指數記號）");
  });

  it('內部空白 "1 9.9" 被拒（trim 僅去頭尾）', () => {
    expect(expectError(unitPrice("1 9.9")).reason).toBe("必須為有效的十進位數值（不接受指數記號）");
  });
});

// ---------------------------------------------------------------------------
// AC-28
// ---------------------------------------------------------------------------

// PHASE-007-R4b（Spec §20.3 AC-57(a)(e)）：折舊建立端點已縮欄，`estimatedAnnualKm`
// 不再是其請求欄位。`parseParameterIntField` 為**通用**純函式——`field` 僅是呼叫端
// 傳入的標籤字串，函式對其零語意假設——故本 describe 保留以該名稱為標籤的案例，
// 用意是證明「同一守門對任意 int 欄位標籤行為一致、`field` 精確回填」，覆蓋面與
// 斷言數量零減損（無任何案例被刪除／skip／弱化）。折舊路徑實際適用者為
// `usefulLifeYears`（見下方各例）。
describe("AC-28 折舊整數欄位 ≥2^31 → 400（2147483647 → 201 上界鑑別）", () => {
  const CAPACITY_REASON = "數值超出可儲存範圍（最大 2147483647）";

  it("上界內最大值 2147483647 通過（兩個欄位標籤各測）", () => {
    for (const field of ["usefulLifeYears", "estimatedAnnualKm"]) {
      const result = parseParameterIntField(2147483647, field);
      expect(result.ok, `field=${field}`).toBe(true);
      if (result.ok) expect(result.value).toBe(2147483647);
    }
  });

  it("恰為上界 2147483648 被拒（兩個欄位標籤各測，field 精確定位）", () => {
    for (const field of ["usefulLifeYears", "estimatedAnnualKm"]) {
      const result = parseParameterIntField(2147483648, field);
      expect(result.ok, `field=${field}`).toBe(false);
      if (!result.ok) expect(result.error).toEqual({ field, reason: CAPACITY_REASON });
    }
  });

  it("3e9 與 1e21（Number.isInteger 皆為 true，現行值域檢查放行）被拒", () => {
    for (const value of [3e9, 1e21]) {
      expect(Number.isInteger(value), `input=${value}`).toBe(true);
      const result = parseParameterIntField(value, "usefulLifeYears");
      expect(result.ok, `input=${value}`).toBe(false);
      if (!result.ok) expect(result.error.reason).toBe(CAPACITY_REASON);
    }
  });

  it("既有值域案例（2.5／0／-1／5）不被本容量守門攔截，交由既有值域層判定（AC-30 零回歸）", () => {
    for (const value of [2.5, 0, -1, 5, 2147483646]) {
      const result = parseParameterIntField(value, "usefulLifeYears");
      expect(result.ok, `input=${value}`).toBe(true);
      if (result.ok) expect(result.value).toBe(value);
    }
  });

  it("非 number 型別與非有限值不改變既有值域層行為（回傳 value=null 表示不適用）", () => {
    for (const value of ["5", null, undefined, true, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = parseParameterIntField(value, "usefulLifeYears");
      expect(result.ok, `input=${String(value)}`).toBe(true);
      if (result.ok) expect(result.value).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-32
// ---------------------------------------------------------------------------

describe("AC-32 多重違規之 reason 順序決定性；折舊多欄位彙總", () => {
  it("型別優先於一切：true 回型別文案而非字面／量級文案", () => {
    expect(expectError(unitPrice(true)).reason).toBe("必須為有效的數值（字串或數字）");
  });

  it('字面優先於量級："1e21"（非十進位字面＋超量級）回字面文案', () => {
    expect(expectError(unitPrice("1e21")).reason).toBe("必須為有效的十進位數值（不接受指數記號）");
  });

  it('小數位優先於量級："1000000.000001"（超量級＋6 位有效小數）回小數位文案', () => {
    expect(expectError(unitPrice("1000000.000001")).reason).toBe("最多允許 4 位小數");
  });

  it('尾隨零不構成小數位違規："1000000.00000" 正規化後回量級文案（值判定而非字面）', () => {
    expect(new Prisma.Decimal("1000000.00000").decimalPlaces()).toBe(0);
    expect(expectError(unitPrice("1000000.00000")).reason).toBe(
      "數值超出可儲存範圍（整數部分最多 6 位）"
    );
  });

  it('小數位優先於值域："-0.0000001"（負值＋超精度）回小數位文案，負值留給值域層', () => {
    expect(expectError(unitPrice("-0.0000001")).reason).toBe("最多允許 4 位小數");
  });

  it('量級優先於值域："-1000000"（負值＋超量級）回量級文案', () => {
    expect(expectError(unitPrice("-1000000")).reason).toBe(
      "數值超出可儲存範圍（整數部分最多 6 位）"
    );
  });

  it('空白字串優先於字面："   " 回「必須為有效的數值」而非字面文案', () => {
    expect(expectError(unitPrice("   ")).reason).toBe("必須為有效的數值");
  });

  it("同一輸入重複呼叫結果完全一致（決定性）", () => {
    const first = unitPrice("1e21");
    const second = unitPrice("1e21");
    expect(first).toEqual(second);
  });

  it("折舊多欄位彙總：vehiclePrice 與 usefulLifeYears 同時違規時 fields 同時包含兩者", () => {
    const fields: { field: string; reason: string }[] = [];

    const price = vehiclePrice("600000.005");
    if (!price.ok) fields.push(price.error);

    const years = parseParameterIntField(2147483648, "usefulLifeYears");
    if (!years.ok) fields.push(years.error);

    const km = parseParameterIntField(120000, "estimatedAnnualKm");
    if (!km.ok) fields.push(km.error);

    expect(fields).toEqual([
      { field: "vehiclePrice", reason: "最多允許 2 位小數" },
      { field: "usefulLifeYears", reason: "數值超出可儲存範圍（最大 2147483647）" },
    ]);
    expect(fields.map((f) => f.field)).toContain("vehiclePrice");
    expect(fields.map((f) => f.field)).toContain("usefulLifeYears");
  });

  // R4b 後折舊建立端點僅二欄；本例續以三個標籤驗證「各欄位各自回報、不彼此吞噬」
  // 之彙總語意（AC-32），標籤數與斷言數維持不變。
  it("多個整數欄位同時格式違規：三個欄位皆各自回報，不彼此吞噬", () => {
    const fields: { field: string; reason: string }[] = [];
    const price = vehiclePrice("Infinity");
    if (!price.ok) fields.push(price.error);
    for (const [field, value] of [
      ["usefulLifeYears", 3e9],
      ["estimatedAnnualKm", 1e21],
    ] as const) {
      const result = parseParameterIntField(value, field);
      if (!result.ok) fields.push(result.error);
    }

    expect(fields).toEqual([
      { field: "vehiclePrice", reason: "必須為有效的十進位數值（不接受指數記號）" },
      { field: "usefulLifeYears", reason: "數值超出可儲存範圍（最大 2147483647）" },
      { field: "estimatedAnnualKm", reason: "數值超出可儲存範圍（最大 2147483647）" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 零 IO / 純函式性質（與 trip-validation.ts 同形）
// ---------------------------------------------------------------------------

describe("純函式性質（葉節點模組，零 IO）", () => {
  it('回傳之 Decimal 由字串建構，D4 bright-line 保真（"0.1" 與 number 0.1 一致）', () => {
    expect(expectOk(unitPrice("0.1")).toFixed(4)).toBe("0.1000");
    expect(expectOk(unitPrice(0.1)).toFixed(4)).toBe("0.1000");
    expect(expectOk(unitPrice("0.1")).equals(expectOk(unitPrice(0.1)))).toBe(true);
  });

  it("成功結果為 Prisma.Decimal 實例", () => {
    expect(expectOk(unitPrice("3.5"))).toBeInstanceOf(Prisma.Decimal);
  });
});
