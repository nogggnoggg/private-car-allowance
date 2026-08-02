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
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
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
