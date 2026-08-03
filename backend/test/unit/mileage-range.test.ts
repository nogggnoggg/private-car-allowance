/**
 * PHASE-005-T1 — 區間驗證與過濾條件純函式單元測試
 *
 * 對象：`parseMileageRange`、`buildOfficialMileageWhere`（backend/src/mileage/mileage-range.ts）
 * 兩者皆為純函式，不碰 DB。
 *
 * Spec 依據：docs/specs/PHASE-005.md §7.3（引擎介面）、§11.1（單元測試策略）、
 * AC-01（起訖含當日）、AC-02（依 tripDate 歸屬）、AC-03~06（過濾條件）、
 * AC-08（起>迄拒絕／dateFrom==dateTo 合法）、AC-11（Decimal 精度，本檔僅涉及型別與鍵名）、
 * AC-15~17（缺漏／格式/起迄倒置之欄位定位）。
 */
import { describe, expect, it } from "vitest";
import {
  type OfficialMileageParams,
  buildOfficialMileageWhere,
  parseMileageRange,
} from "../../src/mileage/mileage-range.js";

describe("parseMileageRange", () => {
  // ── 合法案例 ─────────────────────────────────────────────────────────
  it("accepts dateFrom < dateTo with no errors", () => {
    const result = parseMileageRange({ dateFrom: "2026-03-01", dateTo: "2026-03-31" });
    expect(result.errors).toEqual([]);
    expect(result.dateFrom).toEqual(new Date(Date.UTC(2026, 2, 1)));
    expect(result.dateTo).toEqual(new Date(Date.UTC(2026, 2, 31)));
  });

  it("① accepts dateFrom == dateTo (single-day statistics) — reverse discriminator for '>=' misuse", () => {
    const result = parseMileageRange({ dateFrom: "2026-03-15", dateTo: "2026-03-15" });
    expect(result.errors).toEqual([]);
    expect(result.dateFrom).toEqual(new Date(Date.UTC(2026, 2, 15)));
    expect(result.dateTo).toEqual(new Date(Date.UTC(2026, 2, 15)));
  });

  // ── AC-08/AC-17: 起 > 迄拒絕 ─────────────────────────────────────────
  it("② rejects dateFrom = dateTo + 1 day (minimal 1-day inversion) with dateRange field error", () => {
    const result = parseMileageRange({ dateFrom: "2026-03-02", dateTo: "2026-03-01" });
    expect(result.errors).toContainEqual({
      field: "dateRange",
      reason: expect.any(String),
    });
    expect(result.dateFrom).toBeNull();
    expect(result.dateTo).toBeNull();
  });

  it("rejects a larger inversion (dateFrom far after dateTo)", () => {
    const result = parseMileageRange({ dateFrom: "2026-06-01", dateTo: "2026-01-01" });
    expect(result.errors.some((e) => e.field === "dateRange")).toBe(true);
  });

  it("does not execute or return any numeric value when range is inverted (dateFrom/dateTo both null)", () => {
    const result = parseMileageRange({ dateFrom: "2026-03-02", dateTo: "2026-03-01" });
    expect(result.dateFrom).toBeNull();
    expect(result.dateTo).toBeNull();
  });

  // ── AC-15/D5(a): 缺漏 dateFrom/dateTo，各自可定位 ────────────────────
  it("③ missing dateFrom → locatable error on field 'dateFrom', dateTo still parsed", () => {
    const result = parseMileageRange({ dateTo: "2026-03-31" });
    expect(result.errors).toContainEqual({ field: "dateFrom", reason: expect.any(String) });
    expect(result.errors.some((e) => e.field === "dateTo")).toBe(false);
  });

  it("missing dateTo → locatable error on field 'dateTo', dateFrom still parsed", () => {
    const result = parseMileageRange({ dateFrom: "2026-03-01" });
    expect(result.errors).toContainEqual({ field: "dateTo", reason: expect.any(String) });
    expect(result.errors.some((e) => e.field === "dateFrom")).toBe(false);
  });

  it("missing both dateFrom and dateTo → two separate locatable errors, not a combined dateRange error", () => {
    const result = parseMileageRange({});
    expect(result.errors).toContainEqual({ field: "dateFrom", reason: expect.any(String) });
    expect(result.errors).toContainEqual({ field: "dateTo", reason: expect.any(String) });
    expect(result.errors.some((e) => e.field === "dateRange")).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it("empty string dateFrom is treated as missing (locatable dateFrom error)", () => {
    const result = parseMileageRange({ dateFrom: "", dateTo: "2026-03-31" });
    expect(result.errors).toContainEqual({ field: "dateFrom", reason: expect.any(String) });
  });

  it("empty string dateTo is treated as missing (locatable dateTo error)", () => {
    const result = parseMileageRange({ dateFrom: "2026-03-01", dateTo: "" });
    expect(result.errors).toContainEqual({ field: "dateTo", reason: expect.any(String) });
  });

  // ── AC-16: 格式錯誤 ──────────────────────────────────────────────────
  it.each(["2026-13-01", "2026/03/01", "abc", "2026-3-1", "2026-02-30"])(
    "④ malformed dateFrom %s → 400-locatable field error on 'dateFrom'",
    (bad) => {
      const result = parseMileageRange({ dateFrom: bad, dateTo: "2026-03-31" });
      expect(result.errors).toContainEqual({ field: "dateFrom", reason: expect.any(String) });
      expect(result.dateFrom).toBeNull();
    }
  );

  it.each(["2026-13-01", "2026/03/01", "abc", "2026-3-1", "2026-02-30"])(
    "malformed dateTo %s → 400-locatable field error on 'dateTo'",
    (bad) => {
      const result = parseMileageRange({ dateFrom: "2026-03-01", dateTo: bad });
      expect(result.errors).toContainEqual({ field: "dateTo", reason: expect.any(String) });
      expect(result.dateTo).toBeNull();
    }
  );

  // ── ⑤ 回傳全部欄位錯誤而非第一項 ─────────────────────────────────────
  it("⑤ returns ALL field errors at once (both dateFrom and dateTo malformed), not just the first", () => {
    const result = parseMileageRange({ dateFrom: "2026/03/01", dateTo: "abc" });
    expect(result.errors).toContainEqual({ field: "dateFrom", reason: expect.any(String) });
    expect(result.errors).toContainEqual({ field: "dateTo", reason: expect.any(String) });
    expect(result.errors).toHaveLength(2);
  });

  it("does not report a dateRange inversion error when either date is malformed (cannot compare invalid dates)", () => {
    const result = parseMileageRange({ dateFrom: "abc", dateTo: "2026-01-01" });
    expect(result.errors.some((e) => e.field === "dateRange")).toBe(false);
  });

  it("produces UTC-midnight Date objects on success (no local-timezone drift)", () => {
    const result = parseMileageRange({ dateFrom: "2026-01-01", dateTo: "2026-12-31" });
    expect(result.dateFrom?.getUTCHours()).toBe(0);
    expect(result.dateTo?.getUTCHours()).toBe(0);
  });
});

describe("buildOfficialMileageWhere", () => {
  const baseParams: OfficialMileageParams = {
    ownerId: "user-abc-123",
    dateFrom: new Date(Date.UTC(2026, 2, 1)),
    dateTo: new Date(Date.UTC(2026, 2, 31)),
  };

  it("① status is exactly the literal 'COMPLETED' (not a negated DRAFT check — AC-04 discriminator)", () => {
    const where = buildOfficialMileageWhere(baseParams);
    expect(where.status).toBe("COMPLETED");
  });

  it("② type is exactly the literal 'TRAVEL'", () => {
    const where = buildOfficialMileageWhere(baseParams);
    expect(where.type).toBe("TRAVEL");
  });

  it("③ tripDate range uses 'gte'/'lte' keys exactly (not 'gt'/'lt') — precise key-name assertion", () => {
    const where = buildOfficialMileageWhere(baseParams);
    const travel = where.travel as { tripDate: Record<string, unknown> };
    expect(Object.keys(travel.tripDate).sort()).toEqual(["gte", "lte"]);
    expect(travel.tripDate.gte).toEqual(baseParams.dateFrom);
    expect(travel.tripDate.lte).toEqual(baseParams.dateTo);
    expect(travel.tripDate.gt).toBeUndefined();
    expect(travel.tripDate.lt).toBeUndefined();
  });

  it("④ ownerId comes from params, not any hardcoded/default value", () => {
    const where = buildOfficialMileageWhere(baseParams);
    expect(where.ownerId).toBe("user-abc-123");

    const otherWhere = buildOfficialMileageWhere({ ...baseParams, ownerId: "user-xyz-999" });
    expect(otherWhere.ownerId).toBe("user-xyz-999");
  });

  it("accepts dateFrom == dateTo (single-day range) and reflects it in gte/lte identically", () => {
    const singleDay = new Date(Date.UTC(2026, 2, 15));
    const where = buildOfficialMileageWhere({
      ownerId: "user-abc-123",
      dateFrom: singleDay,
      dateTo: singleDay,
    });
    const travel = where.travel as { tripDate: { gte: Date; lte: Date } };
    expect(travel.tripDate.gte).toEqual(singleDay);
    expect(travel.tripDate.lte).toEqual(singleDay);
  });

  it("where object has exactly the closed key set {ownerId, type, status, travel} — no stray keys", () => {
    const where = buildOfficialMileageWhere(baseParams);
    expect(Object.keys(where).sort()).toEqual(["ownerId", "status", "travel", "type"]);
  });

  it("does not filter by createdAt/completedAt/primaryDate (AC-02 attribution discriminator)", () => {
    const where = buildOfficialMileageWhere(baseParams);
    expect(where).not.toHaveProperty("createdAt");
    expect(where).not.toHaveProperty("completedAt");
    expect(where).not.toHaveProperty("primaryDate");
  });

  it("does not exclude by a negated status set (e.g. { not: 'DRAFT' }) that would let VOIDED leak through", () => {
    const where = buildOfficialMileageWhere(baseParams);
    expect(typeof where.status).toBe("string");
    expect(where.status).not.toEqual({ not: "DRAFT" });
  });
});
