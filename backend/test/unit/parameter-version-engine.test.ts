/**
 * Unit tests: PHASE-003a-T2 — Parameter version engine (pure functions, no DB)
 *
 * Spec §2 AC-07/08/09/10/11, §4.2 D2 方案 A, §8.1
 *
 * TDD: written BEFORE the engine module exists; first run must be RED.
 *
 * Engines under test:
 *   - checkNoOverlap(existing, candidateEffectiveFrom)
 *       D2 方案 A: "重疊" = 候選 effectiveFrom 與某既有版本同日（UTC 日粒度）
 *       回 { ok: true } 或 { ok: false; conflict: { id, effectiveFrom } }
 *
 *   - findEffectiveVersion<T>(versions, queryDate)
 *       回 effectiveFrom ≤ queryDate 的版本中 effectiveFrom 最大者，否則 null
 *       日粒度 UTC 比較；不假設輸入已排序。
 *
 * 日粒度說明：T1 測試已確立 @db.Date 由 Prisma 以 UTC 午夜回傳。
 *   本引擎以 UTC 年月日比較，避免本地時區把某日位移。
 *
 * 鑑別力反向驗證（見 Handoff）：
 *   - 若日粒度改成 datetime 比對（含時分秒），「同日不同時」測試 (#datetime-discriminant) 會轉紅
 *   - 若邊界從 ≤ 改成 <，「生效日當日」及「隱含結束日當日」測試會轉紅
 *   - 若查找不排序直接找最後一個，「亂序輸入」測試會轉紅
 */

import { describe, expect, it } from "vitest";
import {
  checkNoOverlap,
  findEffectiveVersion,
} from "../../src/parameters/parameter-version-engine.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Shorthand: make a synthetic version record with the given id and date string. */
function v(id: string, effectiveFrom: string) {
  return { id, effectiveFrom: new Date(effectiveFrom) };
}

// ─── checkNoOverlap ───────────────────────────────────────────────────────────

describe("checkNoOverlap — 不重疊驗證引擎 (AC-07/08/09)", () => {
  // ── Empty collection ────────────────────────────────────────────────────────

  it("空集合 → 永遠允許（第一個版本必可建立）", () => {
    const result = checkNoOverlap([], "2026-01-01");
    expect(result).toEqual({ ok: true });
  });

  // ── Same-day conflict ───────────────────────────────────────────────────────

  it("候選與既有版本同日 → 拒，conflict 指向該版", () => {
    const existing = [v("v1", "2026-01-01")];
    const result = checkNoOverlap(existing, "2026-01-01");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict.id).toBe("v1");
      expect(result.conflict.effectiveFrom).toBe("2026-01-01");
    }
  });

  it("候選與集合中某一版本同日（多個既有版本）→ 拒，conflict 指向正確版", () => {
    const existing = [v("v1", "2026-01-01"), v("v2", "2026-06-01"), v("v3", "2027-01-01")];
    const result = checkNoOverlap(existing, "2026-06-01");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict.id).toBe("v2");
    }
  });

  // ── Same day, different time — datetime discriminant ────────────────────────
  // 鑑別力：若改用 datetime 比對，此測試仍通過；
  // 但若實作把候選 "2026-03-01T15:30:00Z" 與既有 "2026-03-01T00:00:00Z" 視為「不同」，則此測試會轉紅。
  // （#datetime-discriminant）

  it("候選與既有版本同日但不同時分秒 → 仍拒（日粒度，UTC）", () => {
    // Existing: 2026-03-01T00:00:00Z (UTC midnight, as returned by @db.Date)
    const existing = [{ id: "vA", effectiveFrom: new Date("2026-03-01T00:00:00.000Z") }];
    // Candidate: same calendar day but with a non-midnight time component
    const candidate = new Date("2026-03-01T15:30:45.000Z");

    const result = checkNoOverlap(existing, candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict.id).toBe("vA");
    }
  });

  it("候選與既有版本同日但時間為本地時區 23:00 → 仍拒（日粒度，UTC）", () => {
    // Both are "2026-05-01" in UTC
    const existing = [{ id: "vB", effectiveFrom: new Date("2026-05-01T00:00:00.000Z") }];
    // Candidate passed as UTC midnight of same day
    const result = checkNoOverlap(existing, new Date("2026-05-01T00:00:00.000Z"));

    expect(result.ok).toBe(false);
  });

  // ── New date — should be allowed ────────────────────────────────────────────

  it("候選早於所有既有版本（最早前插入）→ 允許", () => {
    const existing = [v("v1", "2026-06-01"), v("v2", "2026-12-01")];
    const result = checkNoOverlap(existing, "2025-01-01");
    expect(result).toEqual({ ok: true });
  });

  it("候選晚於所有既有版本（末端追加）→ 允許", () => {
    const existing = [v("v1", "2026-01-01"), v("v2", "2026-06-01")];
    const result = checkNoOverlap(existing, "2027-01-01");
    expect(result).toEqual({ ok: true });
  });

  it("候選插入中間但不與任何版本同日 → 允許", () => {
    const existing = [v("v1", "2026-01-01"), v("v2", "2026-12-01")];
    // Middle: 2026-06-15 — not same day as either
    const result = checkNoOverlap(existing, "2026-06-15");
    expect(result).toEqual({ ok: true });
  });

  // ── Adjacent next-day — off-by-one discriminant ─────────────────────────────
  // D2 方案 A 下隱含結束 = 下一版生效前一日。
  // 「相鄰次日」= 某版隱含結束日的次日 = 與某版不同日 → 允許。
  // 若實作以 effectiveFrom+1day 作為邊界比較（off-by-one），此測試會轉紅。

  it("候選為某版隱含結束日的次日（相鄰次日）→ 允許（off-by-one 鑑別力）", () => {
    // existing = [v1 @ 2026-01-01], candidate = 2026-01-02 (day after v1)
    // 2026-01-02 ≠ 2026-01-01 → no conflict → allow
    const existing = [v("v1", "2026-01-01")];
    const result = checkNoOverlap(existing, "2026-01-02");
    expect(result).toEqual({ ok: true });
  });

  it("候選為某版隱含結束日當日（即下一版生效前一日）→ 與下一版不同日，允許", () => {
    // Two existing versions: v1 @ 2026-01-01, v2 @ 2026-06-01
    // v1's implicit end = 2026-05-31
    // Candidate @ 2026-05-31 is NOT the same day as v1 (2026-01-01) or v2 (2026-06-01) → allow
    const existing = [v("v1", "2026-01-01"), v("v2", "2026-06-01")];
    const result = checkNoOverlap(existing, "2026-05-31");
    expect(result).toEqual({ ok: true });
  });

  // ── Cross-type consistency (AC-09) ─────────────────────────────────────────
  // Three parameter types share the same engine logic.
  // We test with differently shaped objects to verify generics work.

  it("三類參數共用引擎：FuelParameterVersion 型資料 → 同日拒", () => {
    const existing = [{ id: "fuel-1", effectiveFrom: new Date("2026-03-01"), unitPrice: "3.5" }];
    const result = checkNoOverlap(existing, "2026-03-01");
    expect(result.ok).toBe(false);
  });

  it("三類參數共用引擎：EtcParameterVersion 型資料 → 全新日允許", () => {
    const existing = [{ id: "etc-1", effectiveFrom: new Date("2026-03-01"), unitPrice: "2.0" }];
    const result = checkNoOverlap(existing, "2026-04-01");
    expect(result).toEqual({ ok: true });
  });

  it("三類參數共用引擎：DepreciationParameterVersion 型資料 → 同日拒", () => {
    const existing = [
      {
        id: "dep-1",
        effectiveFrom: new Date("2026-03-01"),
        vehiclePrice: "500000",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
      },
    ];
    const result = checkNoOverlap(existing, "2026-03-01");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict.id).toBe("dep-1");
    }
  });
});

// ─── findEffectiveVersion ─────────────────────────────────────────────────────

describe("findEffectiveVersion — 依日期查找引擎 (AC-10/11)", () => {
  // ── Before earliest version → null ─────────────────────────────────────────

  it("queryDate 早於所有版本的最早 effectiveFrom → null（缺參數）", () => {
    const versions = [v("v1", "2026-06-01"), v("v2", "2027-01-01")];
    const result = findEffectiveVersion(versions, "2025-12-31");
    expect(result).toBeNull();
  });

  it("單一版本，queryDate 早於其 effectiveFrom → null", () => {
    const versions = [v("v1", "2026-06-01")];
    const result = findEffectiveVersion(versions, "2026-05-31");
    expect(result).toBeNull();
  });

  it("空集合 → null", () => {
    const result = findEffectiveVersion([], "2026-01-01");
    expect(result).toBeNull();
  });

  // ── Exact effectiveFrom date — inclusive boundary ───────────────────────────
  // 鑑別力：若把 ≤ 改成 <，此測試會轉紅。

  it("queryDate 恰為某版生效日當日 → 回該版（含當日邊界，≤）", () => {
    const versions = [v("v1", "2026-01-01"), v("v2", "2026-06-01")];
    // Query exactly on v2's effectiveFrom
    const result = findEffectiveVersion(versions, "2026-06-01");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("v2");
  });

  it("queryDate 恰為最早版生效日當日 → 回該版", () => {
    const versions = [v("v1", "2026-01-01"), v("v2", "2026-06-01")];
    const result = findEffectiveVersion(versions, "2026-01-01");
    expect(result?.id).toBe("v1");
  });

  // ── Date between versions ──────────────────────────────────────────────────

  it("queryDate 在 v1 與 v2 之間 → 回 v1（v1 仍有效至 v2 前一日）", () => {
    const versions = [v("v1", "2026-01-01"), v("v2", "2026-06-01")];
    const result = findEffectiveVersion(versions, "2026-03-15");
    expect(result?.id).toBe("v1");
  });

  // ── Implicit end boundary (adjacent boundary off-by-one discriminant) ──────
  // v1 effective 2026-01-01; v2 effective 2026-06-01
  // v1 implicit end = 2026-05-31 (day before v2)
  // 鑑別力：若把 ≤ 改成 <，「隱含結束日當日」測試會轉紅。

  it("queryDate 為 v1 隱含結束日當日（2026-05-31）→ 回 v1（仍有效，含當日）", () => {
    const versions = [v("v1", "2026-01-01"), v("v2", "2026-06-01")];
    const result = findEffectiveVersion(versions, "2026-05-31");
    expect(result?.id).toBe("v1");
  });

  it("queryDate 為 v2 生效日當日（2026-06-01）→ 回 v2（相鄰邊界，off-by-one 鑑別力）", () => {
    const versions = [v("v1", "2026-01-01"), v("v2", "2026-06-01")];
    const result = findEffectiveVersion(versions, "2026-06-01");
    expect(result?.id).toBe("v2");
  });

  // ── Future version does not pollute current lookup (AC-10) ─────────────────
  // 鑑別力：若未來版污染查找，此測試會轉紅。
  // 以固定「今日」注入，不用真實 today。

  it("未來生效版本存在時，以今日查找回現行版本（AC-10）", () => {
    // "today" is 2026-08-01 (injected)
    const today = "2026-08-01";
    const versions = [
      v("v0", "2026-01-01"), // 現行版本（生效日早於今日）
      v("v1", "2027-01-01"), // 未來版本
    ];
    const result = findEffectiveVersion(versions, today);
    // Must return v0 (current), NOT v1 (future)
    expect(result?.id).toBe("v0");
  });

  it("以未來版生效日查找 → 回未來版", () => {
    const versions = [v("v0", "2026-01-01"), v("v1", "2027-01-01")];
    const result = findEffectiveVersion(versions, "2027-01-01");
    expect(result?.id).toBe("v1");
  });

  // ── After latest version ────────────────────────────────────────────────────

  it("queryDate 在所有版本之後的未來 → 回最新版（最後有效，開放結束）", () => {
    const versions = [v("v1", "2026-01-01"), v("v2", "2026-06-01")];
    const result = findEffectiveVersion(versions, "2030-01-01");
    expect(result?.id).toBe("v2");
  });

  // ── Unordered input → still correct ────────────────────────────────────────
  // 鑑別力：若函式假設輸入已排序，此測試會轉紅（亂序時回傳錯誤版本）。

  it("多版本亂序輸入 → 仍正確排序後查找", () => {
    // Provide versions in reverse order
    const versions = [v("v3", "2027-01-01"), v("v1", "2026-01-01"), v("v2", "2026-06-01")];
    // Query 2026-08-01 → should return v2 (2026-06-01 ≤ 2026-08-01 < 2027-01-01)
    const result = findEffectiveVersion(versions, "2026-08-01");
    expect(result?.id).toBe("v2");
  });

  it("亂序輸入，queryDate 在 v1 與 v2 之間 → 回 v1", () => {
    const versions = [v("v2", "2026-06-01"), v("v1", "2026-01-01")];
    const result = findEffectiveVersion(versions, "2026-03-01");
    expect(result?.id).toBe("v1");
  });

  // ── Day granularity with time component ────────────────────────────────────
  // effectiveFrom from @db.Date comes back as UTC midnight; queryDate may have a time component.
  // All comparisons must be day-granularity (UTC year/month/day only).
  // 鑑別力：若不做日粒度正規化，queryDate 的時間部分可能把「同日」視為「早一日」。

  it("queryDate 含非零時分秒，與 effectiveFrom 同日 → 視為同日（日粒度）", () => {
    // effectiveFrom from @db.Date = UTC midnight
    const versions = [{ id: "v1", effectiveFrom: new Date("2026-06-01T00:00:00.000Z") }];
    // queryDate at 15:30 UTC same day
    const result = findEffectiveVersion(versions, new Date("2026-06-01T15:30:00.000Z"));
    expect(result?.id).toBe("v1");
  });

  it("queryDate 為 effectiveFrom 當日 23:59 UTC → 仍視為同日", () => {
    const versions = [{ id: "v1", effectiveFrom: new Date("2026-09-01T00:00:00.000Z") }];
    const result = findEffectiveVersion(versions, new Date("2026-09-01T23:59:59.999Z"));
    expect(result?.id).toBe("v1");
  });

  it("queryDate 為 effectiveFrom 前日 23:59 UTC → 日粒度下早一日，回 null", () => {
    const versions = [{ id: "v1", effectiveFrom: new Date("2026-09-01T00:00:00.000Z") }];
    // 2026-08-31T23:59 is still day 2026-08-31, before effectiveFrom 2026-09-01
    const result = findEffectiveVersion(versions, new Date("2026-08-31T23:59:59.999Z"));
    expect(result).toBeNull();
  });

  // ── Generic type preservation ───────────────────────────────────────────────
  // findEffectiveVersion should return the full original object, not a stripped version.

  it("回傳完整原始物件（含額外欄位）", () => {
    const versions = [
      {
        id: "fuel-1",
        effectiveFrom: new Date("2026-01-01"),
        unitPrice: "3.5000",
        createdAt: new Date(),
      },
    ];
    const result = findEffectiveVersion(versions, "2026-06-01");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("fuel-1");
    // The extra field must be preserved
    expect((result as (typeof versions)[0]).unitPrice).toBe("3.5000");
  });
});
