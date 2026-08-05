/**
 * Unit tests for PHASE-004-T5 — trip-validation.ts pure functions.
 *
 * Spec §2 群組 C (AC-14~21), §5 B-01~B-05/B-31, §8.1 BlockerDto, §8.2
 * SegmentInput, §11.1 里程驗證 ≥15 案例, §17.1 D5 (Decimal(10,2), 超位數拒絕,
 * 不設業務上限), D14(ii) (地點 ≤200 字).
 *
 * TDD: written BEFORE trip-validation.ts exists — expected to fail RED first
 * (module not found), then implement to GREEN.
 *
 * Zero IO — no DB, no prisma client instance beyond the `Prisma.Decimal`
 * value type import.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  parseAnnualTotalKmField,
  parseKmField,
  parseLocationField,
  validateSegmentMileage,
} from "../../src/applications/trip-validation.js";

function decimal(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

// ---------------------------------------------------------------------------
// parseKmField — format-level (儲存時即拒絕，AC-19)
// ---------------------------------------------------------------------------

describe("parseKmField — 格式性驗證（AC-19, D5）", () => {
  it("null → ok, value=null（草稿可空）", () => {
    const result = parseKmField(null, "segments[0].totalKm");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it("字串 '12.3'（1 位小數）→ ok", () => {
    const result = parseKmField("12.3", "segments[0].totalKm");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.toString()).toBe("12.3");
  });

  it("字串 '12.35'（2 位小數）→ ok", () => {
    const result = parseKmField("12.35", "segments[0].totalKm");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.toString()).toBe("12.35");
  });

  it("字串 '12.345'（3 位小數）→ 拒絕，reason 明確指出「最多 2 位小數」", () => {
    const result = parseKmField("12.345", "segments[1].totalKm");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("segments[1].totalKm");
      expect(result.error.reason).toContain("2 位小數");
    }
  });

  it("字串 '12.340'（尾隨零，本實作採用：以 Decimal 正規化值判斷小數位，等同 12.34）→ ok，且正規化後不含尾隨零", () => {
    const result = parseKmField("12.340", "segments[0].totalKm");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.toString()).toBe("12.34");
  });

  it("精度：parseKmField('12.35') 後 .toString() 仍為 '12.35'（無浮點中介失真）", () => {
    const result = parseKmField("12.35", "segments[0].totalKm");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.toString()).toBe("12.35");
  });

  it("精度：容易在浮點下失真的值 '0.1' 往返不失真", () => {
    const result = parseKmField("0.1", "segments[0].totalKm");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.toString()).toBe("0.1");
  });

  it("數字 12.35（number 型別）→ ok，等同字串輸入", () => {
    const result = parseKmField(12.35, "segments[0].totalKm");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.toString()).toBe("12.35");
  });

  it("負值在格式層被允許通過（負值屬業務規則，由 validateSegmentMileage 擋）", () => {
    const result = parseKmField("-0.01", "segments[0].totalKm");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.toString()).toBe("-0.01");
  });

  it("0 在格式層通過", () => {
    const result = parseKmField("0", "segments[0].totalKm");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.toString()).toBe("0");
  });

  it("非數值字串 'abc' → 拒絕", () => {
    const result = parseKmField("abc", "segments[0].totalKm");
    expect(result.ok).toBe(false);
  });

  it("空字串 '' → 拒絕", () => {
    const result = parseKmField("", "segments[0].totalKm");
    expect(result.ok).toBe(false);
  });

  it("純空白字串 ' ' → 拒絕", () => {
    const result = parseKmField(" ", "segments[0].totalKm");
    expect(result.ok).toBe(false);
  });

  it("NaN（number）→ 拒絕", () => {
    const result = parseKmField(Number.NaN, "segments[0].totalKm");
    expect(result.ok).toBe(false);
  });

  it("Infinity（number）→ 拒絕", () => {
    const result = parseKmField(Number.POSITIVE_INFINITY, "segments[0].totalKm");
    expect(result.ok).toBe(false);
  });

  it("-Infinity（number）→ 拒絕", () => {
    const result = parseKmField(Number.NEGATIVE_INFINITY, "segments[0].totalKm");
    expect(result.ok).toBe(false);
  });

  it("超過 Decimal(10,2) 容量之值（8 位整數以上）→ 拒絕並給明確 reason", () => {
    const result = parseKmField("100000000", "segments[0].totalKm"); // 1e8，超過 Decimal(10,2) 可容納的 8 位整數部分
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBeTruthy();
  });

  it("Decimal(10,2) 容量邊界內之值（8 位整數，最大合法值）→ ok", () => {
    const result = parseKmField("99999999.99", "segments[0].totalKm");
    expect(result.ok).toBe(true);
  });

  it("布林值 true → 拒絕", () => {
    const result = parseKmField(true, "segments[0].totalKm");
    expect(result.ok).toBe(false);
  });

  it("物件 {} → 拒絕", () => {
    const result = parseKmField({}, "segments[0].totalKm");
    expect(result.ok).toBe(false);
  });

  it("陣列 [] → 拒絕", () => {
    const result = parseKmField([], "segments[0].totalKm");
    expect(result.ok).toBe(false);
  });

  it("undefined → 拒絕（與 null 不同語意：undefined 非合法草稿留空表示）", () => {
    const result = parseKmField(undefined, "segments[0].totalKm");
    expect(result.ok).toBe(false);
  });

  it("科學記號字串 '1e2' → 拒絕（非本規格接受之十進位格式）", () => {
    const result = parseKmField("1e2", "segments[0].totalKm");
    expect(result.ok).toBe(false);
  });

  it("error.field 使用傳入的 field 名稱", () => {
    const result = parseKmField("12.345", "segments[2].highwayKm");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe("segments[2].highwayKm");
  });
});

// ---------------------------------------------------------------------------
// parseAnnualTotalKmField — PHASE-007-R5（AC-47；裁定 D／裁定 E）
//
// `DepreciationApplication.annualTotalKm`（`Decimal(9,1)`，§20.7.1）之欄位層
// 解析器。與 `parseKmField`／`parseActualCostField` **共用同一份**
// `parseDecimalField` 實作（AC-47 之「不新增第二套驗證實作」；本檔 §
// 「複用結構性證明」以原始碼掃描機械守護），僅四個參數不同：
//   小數位上限 1（裁定 D）／容量上界 10^8（`Decimal(9,1)` 推導）／
//   容量文案／**正值要求**（裁定 E：`0` 與負數當場 400，不延後到完成階段）。
// ---------------------------------------------------------------------------

const ANNUAL_TOTAL_KM_FIELD = "annualTotalKm";

describe("parseAnnualTotalKmField — 年度總里程欄位驗證（AC-47；裁定 D／E）", () => {
  // ── AC-47(a) 型別層 ────────────────────────────────────────────────────
  describe("AC-47(a) 型別：number／數值字串／null 接受；其餘一律拒絕", () => {
    it("null → ok, value=null（草稿寬容，AC-47(c)／AC-53(a)）", () => {
      const result = parseAnnualTotalKmField(null, ANNUAL_TOTAL_KM_FIELD);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBeNull();
    });

    it("JSON number 12345.6 → ok，值逐位元保真", () => {
      const result = parseAnnualTotalKmField(12345.6, ANNUAL_TOTAL_KM_FIELD);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value?.toString()).toBe("12345.6");
    });

    it("數值字串 '12345.6' → ok，值逐位元保真", () => {
      const result = parseAnnualTotalKmField("12345.6", ANNUAL_TOTAL_KM_FIELD);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value?.toString()).toBe("12345.6");
    });

    const rejectedTypes: { label: string; value: unknown }[] = [
      { label: "布林 true", value: true },
      { label: "布林 false", value: false },
      { label: "物件", value: { km: 1000 } },
      { label: "陣列", value: [1000] },
      { label: "非數值字串", value: "abc" },
      { label: "空字串", value: "" },
      { label: "純空白字串", value: "   " },
      { label: "千分位字串", value: "12,345.6" },
      { label: "科學記號字串", value: "1.23456e4" },
      { label: "全形數字字串", value: "１２３４５" },
      { label: "undefined", value: undefined },
    ];

    for (const { label, value } of rejectedTypes) {
      it(`${label} → 拒絕，且 error.field 逐字為 "annualTotalKm"`, () => {
        const result = parseAnnualTotalKmField(value, ANNUAL_TOTAL_KM_FIELD);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.field).toBe("annualTotalKm");
          expect(result.error.reason.length).toBeGreaterThan(0);
        }
      });
    }
  });

  // ── AC-47(b) 精度（裁定 D：小數最多 1 位，不得靜默取整）────────────────
  describe("AC-47(b) 精度：小數位 > 1 → 400（裁定 D，不得靜默取整）", () => {
    it("12345.67（2 位小數）→ 拒絕，reason 明確指出「最多允許 1 位小數」", () => {
      const result = parseAnnualTotalKmField("12345.67", ANNUAL_TOTAL_KM_FIELD);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.field).toBe("annualTotalKm");
        expect(result.error.reason).toBe("最多允許 1 位小數");
      }
    });

    it("12345.6（1 位小數）→ 通過（AC-47(b) 逐字）", () => {
      const result = parseAnnualTotalKmField("12345.6", ANNUAL_TOTAL_KM_FIELD);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value?.toString()).toBe("12345.6");
    });

    it("12345（無小數）→ 通過（AC-47(b) 逐字）", () => {
      const result = parseAnnualTotalKmField("12345", ANNUAL_TOTAL_KM_FIELD);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value?.toString()).toBe("12345");
    });

    it("12345.60（尾隨零）→ 通過（Decimal 正規化後為 1 位，沿 parseKmField 既有語意）", () => {
      const result = parseAnnualTotalKmField("12345.60", ANNUAL_TOTAL_KM_FIELD);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value?.toString()).toBe("12345.6");
    });

    it("12345.678（3 位小數）→ 拒絕（不得靜默取整為 12345.7）", () => {
      const result = parseAnnualTotalKmField("12345.678", ANNUAL_TOTAL_KM_FIELD);
      expect(result.ok).toBe(false);
    });

    it("JSON number 亦受同一小數位守門（12345.67 之 number 型別）", () => {
      const result = parseAnnualTotalKmField(12345.67, ANNUAL_TOTAL_KM_FIELD);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.reason).toBe("最多允許 1 位小數");
    });
  });

  // ── AC-47(c) 值域（裁定 E：0／負數／非有限值當場 400）──────────────────
  describe("AC-47(c) 值域：0／負數／NaN／Infinity 當場 400（裁定 E，不延後到完成階段）", () => {
    const rejectedValues: { label: string; value: unknown; exactReason?: string }[] = [
      { label: "0（number）", value: 0, exactReason: "年度總里程必須大於 0" },
      { label: "0（字串）", value: "0", exactReason: "年度總里程必須大於 0" },
      { label: "0.0（字串）", value: "0.0", exactReason: "年度總里程必須大於 0" },
      { label: "-0.1（number）", value: -0.1, exactReason: "年度總里程必須大於 0" },
      { label: "-1（字串）", value: "-1", exactReason: "年度總里程必須大於 0" },
      { label: "NaN（number）", value: Number.NaN },
      { label: "Infinity（number）", value: Number.POSITIVE_INFINITY },
      { label: "-Infinity（number）", value: Number.NEGATIVE_INFINITY },
      { label: "'NaN'（字串字面）", value: "NaN" },
      { label: "'Infinity'（字串字面）", value: "Infinity" },
    ];

    for (const { label, value, exactReason } of rejectedValues) {
      it(`${label} → 拒絕，error.field 逐字為 "annualTotalKm"`, () => {
        const result = parseAnnualTotalKmField(value, ANNUAL_TOTAL_KM_FIELD);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.field).toBe("annualTotalKm");
          if (exactReason !== undefined) expect(result.error.reason).toBe(exactReason);
        }
      });
    }

    it("0.1（最小正值之一）→ 通過（≤0 守門不得誤擋正值）", () => {
      const result = parseAnnualTotalKmField("0.1", ANNUAL_TOTAL_KM_FIELD);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value?.toString()).toBe("0.1");
    });
  });

  // ── AC-47(d) 容量（Decimal(9,1) → 整數部分最多 8 位；邊界四點）─────────
  describe("AC-47(d) 容量：|v| ≥ 1e8 → 400（Decimal(9,1) 推導，邊界四點）", () => {
    const boundaryCases: { label: string; value: string; ok: boolean }[] = [
      { label: "99999999.8（界內）", value: "99999999.8", ok: true },
      { label: "99999999.9（最大合法值，恰通過）", value: "99999999.9", ok: true },
      { label: "100000000（恰達上界，拒絕）", value: "100000000", ok: false },
      { label: "100000000.0（恰達上界之 1dp 寫法，拒絕）", value: "100000000.0", ok: false },
    ];

    for (const { label, value, ok } of boundaryCases) {
      it(`${label} → ${ok ? "通過" : "拒絕"}`, () => {
        const result = parseAnnualTotalKmField(value, ANNUAL_TOTAL_KM_FIELD);
        expect(result.ok).toBe(ok);
        if (!result.ok) {
          expect(result.error.field).toBe("annualTotalKm");
          expect(result.error.reason).toBe("數值超出可儲存範圍（整數部分最多 8 位）");
        }
      });
    }
  });

  // ── 精度保真（零浮點中介）─────────────────────────────────────────────
  it("精度：'0.1' 往返不失真（Decimal 建構自字串字面，無浮點中介）", () => {
    const result = parseAnnualTotalKmField("0.1", ANNUAL_TOTAL_KM_FIELD);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.equals(decimal("0.1"))).toBe(true);
  });

  it("回傳型別為 Prisma.Decimal（非 number；下游一律以 Decimal 續算）", () => {
    const result = parseAnnualTotalKmField("12345.6", ANNUAL_TOTAL_KM_FIELD);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeInstanceOf(Prisma.Decimal);
  });

  it("error.field 使用傳入的 field 名稱（呼叫端決定路徑）", () => {
    const result = parseAnnualTotalKmField("1.23", "someOther.path");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe("someOther.path");
  });
});

// ---------------------------------------------------------------------------
// 複用結構性證明（AC-47／§20.12 R5 Done When 逐字：「複用 `parseDecimalField`
// （不新增第二套驗證實作）之結構性證明」）
//
// 原始碼掃描而非行為斷言：行為相同無法排除「複製一份判斷式」之實作（006 T5R
// SF-1 雙份漂移教訓）。以下四條把「單一實作」釘在結構上——任何把
// `parseAnnualTotalKmField` 改為自帶正規表示式／自帶小數位比較／自帶容量比較
// 的 mutant 都會使其中至少一條必紅。
// ---------------------------------------------------------------------------

describe("結構性證明：parseAnnualTotalKmField 複用 parseDecimalField，不新增第二套驗證實作", () => {
  const TRIP_VALIDATION_SRC = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../src/applications/trip-validation.ts"
  );
  const source = readFileSync(TRIP_VALIDATION_SRC, "utf8");

  function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it("全檔恰有一份 `parseDecimalField` 函式定義（單一驗證實作）", () => {
    expect(countOccurrences(source, "function parseDecimalField")).toBe(1);
  });

  it("全檔恰有一處十進位字面樣式比對（`DECIMAL_LITERAL_PATTERN.test`）", () => {
    expect(countOccurrences(source, "DECIMAL_LITERAL_PATTERN.test")).toBe(1);
  });

  it("全檔恰有一處小數位比較（`decimalPlaces()`）與一處容量比較（`greaterThanOrEqualTo(options.magnitudeLimit)`）", () => {
    expect(countOccurrences(source, "decimalValue.decimalPlaces()")).toBe(1);
    expect(countOccurrences(source, "greaterThanOrEqualTo(options.magnitudeLimit)")).toBe(1);
  });

  it("`parseAnnualTotalKmField` 之函式本體只做一次 `parseDecimalField(...)` 委派（無自帶判斷式）", () => {
    const marker = "export function parseAnnualTotalKmField";
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    // 取該函式起點之後的第一個 `\n}` 為函式結尾（本檔一律頂層函式、無巢狀）。
    const end = source.indexOf("\n}", start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(countOccurrences(body, "parseDecimalField(")).toBe(1);
    // 不得自帶任何格式／小數位／容量／值域判斷式。
    for (const forbidden of [
      "DECIMAL_LITERAL_PATTERN",
      "decimalPlaces()",
      "new Prisma.Decimal(",
      "typeof value",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// parseLocationField — 格式層（D14(ii) ≤200 字）
// ---------------------------------------------------------------------------

describe("parseLocationField — 格式性驗證（D14(ii)）", () => {
  it("null → ok, value=null", () => {
    const result = parseLocationField(null, "segments[0].origin");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it("空字串 '' → ok（純空白/空字串視為有值，業務層以 blocker 擋）", () => {
    const result = parseLocationField("", "segments[0].origin");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("");
  });

  it("純空白 ' ' → ok，原樣保留（不 trim）", () => {
    const result = parseLocationField(" ", "segments[0].origin");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(" ");
  });

  it("200 字（邊界）→ ok", () => {
    const value = "地".repeat(200);
    const result = parseLocationField(value, "segments[0].origin");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.length).toBe(200);
  });

  it("201 字 → 拒絕", () => {
    const value = "地".repeat(201);
    const result = parseLocationField(value, "segments[0].origin");
    expect(result.ok).toBe(false);
  });

  it("非字串非 null（number）→ 拒絕", () => {
    const result = parseLocationField(123, "segments[0].origin");
    expect(result.ok).toBe(false);
  });

  it("非字串非 null（物件）→ 拒絕", () => {
    const result = parseLocationField({ a: 1 }, "segments[0].origin");
    expect(result.ok).toBe(false);
  });

  it("undefined → 拒絕", () => {
    const result = parseLocationField(undefined, "segments[0].origin");
    expect(result.ok).toBe(false);
  });

  it("正常地點文字 → ok，原值保留", () => {
    const result = parseLocationField("台北市政府", "segments[0].origin");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("台北市政府");
  });
});

// ---------------------------------------------------------------------------
// validateSegmentMileage — 業務層（完成時擋，AC-14~18）
// ---------------------------------------------------------------------------

describe("validateSegmentMileage — 業務規則（完成時擋，AC-14~18）", () => {
  it("totalKm=0 → SEGMENT_TOTAL_KM_INVALID（含 0，AC-14）", () => {
    const blockers = validateSegmentMileage({
      id: "seg-1",
      sortOrder: 0,
      totalKm: decimal("0"),
      highwayKm: decimal("0"),
    });
    const codes = blockers.map((b) => b.code);
    expect(codes).toContain("SEGMENT_TOTAL_KM_INVALID");
  });

  it("totalKm=-0.01（負值）→ SEGMENT_TOTAL_KM_INVALID", () => {
    const blockers = validateSegmentMileage({
      id: "seg-1",
      sortOrder: 0,
      totalKm: decimal("-0.01"),
      highwayKm: decimal("0"),
    });
    expect(blockers.some((b) => b.code === "SEGMENT_TOTAL_KM_INVALID")).toBe(true);
  });

  it("totalKm=0.01（最小正值）→ 不含 SEGMENT_TOTAL_KM_INVALID", () => {
    const blockers = validateSegmentMileage({
      id: "seg-1",
      sortOrder: 0,
      totalKm: decimal("0.01"),
      highwayKm: decimal("0"),
    });
    expect(blockers.some((b) => b.code === "SEGMENT_TOTAL_KM_INVALID")).toBe(false);
  });

  it("totalKm=null → SEGMENT_TOTAL_KM_REQUIRED", () => {
    const blockers = validateSegmentMileage({
      id: "seg-1",
      sortOrder: 0,
      totalKm: null,
      highwayKm: decimal("0"),
    });
    expect(blockers.some((b) => b.code === "SEGMENT_TOTAL_KM_REQUIRED")).toBe(true);
  });

  it("highwayKm=-0.01 → SEGMENT_HIGHWAY_KM_INVALID（AC-15）", () => {
    const blockers = validateSegmentMileage({
      id: "seg-1",
      sortOrder: 0,
      totalKm: decimal("10"),
      highwayKm: decimal("-0.01"),
    });
    expect(blockers.some((b) => b.code === "SEGMENT_HIGHWAY_KM_INVALID")).toBe(true);
  });

  it("highwayKm=0 → 允許（AC-17，不含 SEGMENT_HIGHWAY_KM_INVALID）", () => {
    const blockers = validateSegmentMileage({
      id: "seg-1",
      sortOrder: 0,
      totalKm: decimal("10"),
      highwayKm: decimal("0"),
    });
    expect(blockers).toEqual([]);
  });

  it("highwayKm==totalKm（10.00/10.00）→ 允許（AC-18，`≤` 含等於）", () => {
    const blockers = validateSegmentMileage({
      id: "seg-1",
      sortOrder: 0,
      totalKm: decimal("10.00"),
      highwayKm: decimal("10.00"),
    });
    expect(blockers).toEqual([]);
  });

  it("highwayKm=totalKm+0.01（最小差值，鑑別 off-by-one）→ SEGMENT_HIGHWAY_GT_TOTAL（AC-16/B-04）", () => {
    const blockers = validateSegmentMileage({
      id: "seg-1",
      sortOrder: 0,
      totalKm: decimal("10.00"),
      highwayKm: decimal("10.01"),
    });
    expect(blockers.some((b) => b.code === "SEGMENT_HIGHWAY_GT_TOTAL")).toBe(true);
  });

  it("highwayKm > totalKm 拒絕：指出對應行程段（segmentId/segmentIndex）", () => {
    const blockers = validateSegmentMileage({
      id: "seg-XYZ",
      sortOrder: 2,
      totalKm: decimal("5"),
      highwayKm: decimal("6"),
    });
    const blocker = blockers.find((b) => b.code === "SEGMENT_HIGHWAY_GT_TOTAL");
    expect(blocker).toBeDefined();
    expect(blocker?.segmentId).toBe("seg-XYZ");
    expect(blocker?.segmentIndex).toBe(2);
  });

  it("highwayKm=null → SEGMENT_HIGHWAY_KM_REQUIRED", () => {
    const blockers = validateSegmentMileage({
      id: "seg-1",
      sortOrder: 0,
      totalKm: decimal("10"),
      highwayKm: null,
    });
    expect(blockers.some((b) => b.code === "SEGMENT_HIGHWAY_KM_REQUIRED")).toBe(true);
  });

  it("完全有效的段落 → 回傳空陣列", () => {
    const blockers = validateSegmentMileage({
      id: "seg-1",
      sortOrder: 0,
      totalKm: decimal("10.50"),
      highwayKm: decimal("3.20"),
    });
    expect(blockers).toEqual([]);
  });

  it("回傳全部違規項而非第一項：totalKm=0 且 highwayKm=-1 同時違規 → 兩個 code 都出現", () => {
    const blockers = validateSegmentMileage({
      id: "seg-1",
      sortOrder: 0,
      totalKm: decimal("0"),
      highwayKm: decimal("-1"),
    });
    const codes = blockers.map((b) => b.code);
    expect(codes).toContain("SEGMENT_TOTAL_KM_INVALID");
    expect(codes).toContain("SEGMENT_HIGHWAY_KM_INVALID");
    expect(blockers.length).toBeGreaterThanOrEqual(2);
  });

  it("totalKm=null 且 highwayKm=null → 兩個 REQUIRED code 都出現", () => {
    const blockers = validateSegmentMileage({
      id: "seg-1",
      sortOrder: 0,
      totalKm: null,
      highwayKm: null,
    });
    const codes = blockers.map((b) => b.code);
    expect(codes).toContain("SEGMENT_TOTAL_KM_REQUIRED");
    expect(codes).toContain("SEGMENT_HIGHWAY_KM_REQUIRED");
  });

  it("每個 blocker 帶 message（zh-TW，非空）", () => {
    const blockers = validateSegmentMileage({
      id: "seg-1",
      sortOrder: 0,
      totalKm: decimal("0"),
      highwayKm: decimal("-1"),
    });
    for (const b of blockers) {
      expect(b.message).toBeTruthy();
      expect(typeof b.message).toBe("string");
    }
  });

  it("比較一律以 Decimal 進行：totalKm=0.1+0.2 等價值不因浮點誤差誤判（10.30 vs 10.3）", () => {
    const blockers = validateSegmentMileage({
      id: "seg-1",
      sortOrder: 0,
      totalKm: decimal("10.30"),
      highwayKm: decimal("10.3"),
    });
    // highwayKm == totalKm numerically → allowed
    expect(blockers.some((b) => b.code === "SEGMENT_HIGHWAY_GT_TOTAL")).toBe(false);
  });
});
