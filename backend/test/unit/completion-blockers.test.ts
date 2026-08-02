/**
 * Unit tests for PHASE-004-T3 — completionBlockers pure function generator.
 *
 * Spec §2 群組 A/D/G (AC-03/12/20/24/46/52), §8.1 BlockerDto, §11.1.
 * TDD: written BEFORE `completion-blockers.ts` exists — expected to fail RED first
 * (module not found), then implement to GREEN.
 *
 * Discriminating power requirement (AC-52 / Packet):
 *   Every case with multiple missing items must assert the FULL blocker list,
 *   not just the first — a naive "return on first failure" implementation
 *   would fail these tests.
 *
 * This module is pure (zero IO) — no DB, no prisma. Mileage-rule blockers
 * (totalKm ≤ 0 / highwayKm < 0 / highwayKm > totalKm) were originally OUT of
 * scope for T3 (reserved for PHASE-004-T5) — the tests below this point
 * (added by T5) exercise the now-merged mileage blockers.
 *
 * PHASE-004-T5 note (the ONE fixture change in this file — see Task
 * Handoff for full justification): the shared `segment()` factory's
 * `totalKm`/`highwayKm` defaults were `null` under T3 (that field was
 * unconsumed then). Now that T5 wires `validateSegmentMileage` in,
 * `totalKm: null` / `highwayKm: null` legitimately produce
 * SEGMENT_TOTAL_KM_REQUIRED / SEGMENT_HIGHWAY_KM_REQUIRED blockers (per
 * this Task's Packet spec). Leaving the old `null` defaults would silently
 * break every pre-existing T3 test that relies on `segment()`'s default
 * being "fully valid" (e.g. the very first test in this file: "fully valid
 * input returns an empty array"), NOT because those tests' assertions were
 * touched, but because the meaning of "fully valid" now legitimately
 * includes mileage. The fix is to change the DEFAULT to an actually-valid
 * mileage pair (`totalKm=10`, `highwayKm=5`) — every existing `it(...)`
 * body and assertion below is byte-for-byte unchanged; only this shared
 * fixture default moved from "unused placeholder" to "a valid value",
 * which is what keeps every pre-existing assertion passing unmodified.
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  type BlockerInput,
  type BlockerSegmentInput,
  computeCompletionBlockers,
} from "../../src/applications/completion-blockers.js";

function decimal(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function segment(overrides: Partial<BlockerSegmentInput> = {}): BlockerSegmentInput {
  return {
    id: "seg-1",
    sortOrder: 0,
    origin: "台北市政府",
    destination: "新竹科學園區",
    // T5: valid by default (totalKm>0, 0<=highwayKm<=totalKm) — see file-header note.
    totalKm: decimal("10"),
    highwayKm: decimal("5"),
    attachmentCount: 1,
    ...overrides,
  };
}

function baseInput(overrides: Partial<BlockerInput> = {}): BlockerInput {
  return {
    tripDate: new Date("2026-05-01"),
    purpose: "客戶拜訪",
    segments: [segment()],
    missingParameters: [],
    ...overrides,
  };
}

describe("computeCompletionBlockers — PHASE-004-T3", () => {
  it("fully valid input returns an empty array", () => {
    expect(computeCompletionBlockers(baseInput())).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // TRIP_DATE_REQUIRED
  // -------------------------------------------------------------------------
  it("tripDate=null → TRIP_DATE_REQUIRED with field=tripDate", () => {
    const blockers = computeCompletionBlockers(baseInput({ tripDate: null }));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ code: "TRIP_DATE_REQUIRED", field: "tripDate" });
    expect(blockers[0].message).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // PURPOSE_REQUIRED — null / empty / whitespace-only all count as missing
  // -------------------------------------------------------------------------
  it("purpose=null → PURPOSE_REQUIRED", () => {
    const blockers = computeCompletionBlockers(baseInput({ purpose: null }));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ code: "PURPOSE_REQUIRED", field: "purpose" });
  });

  it("purpose='' (empty string) → PURPOSE_REQUIRED", () => {
    const blockers = computeCompletionBlockers(baseInput({ purpose: "" }));
    expect(blockers.some((b) => b.code === "PURPOSE_REQUIRED")).toBe(true);
  });

  it("purpose='   ' (whitespace-only) → PURPOSE_REQUIRED (纯空白視為缺)", () => {
    const blockers = computeCompletionBlockers(baseInput({ purpose: "   " }));
    expect(blockers.some((b) => b.code === "PURPOSE_REQUIRED")).toBe(true);
  });

  it("purpose with real content and surrounding whitespace → no PURPOSE_REQUIRED", () => {
    const blockers = computeCompletionBlockers(baseInput({ purpose: "  出差開會  " }));
    expect(blockers.some((b) => b.code === "PURPOSE_REQUIRED")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // SEGMENT_REQUIRED (0 段, AC-12)
  // -------------------------------------------------------------------------
  it("0 segments → SEGMENT_REQUIRED, no segment-level blockers produced", () => {
    const blockers = computeCompletionBlockers(baseInput({ segments: [] }));
    expect(blockers).toHaveLength(1);
    expect(blockers[0].code).toBe("SEGMENT_REQUIRED");
  });

  // -------------------------------------------------------------------------
  // SEGMENT_LOCATION_REQUIRED (AC-20) — segmentId/segmentIndex/field mapping
  // -------------------------------------------------------------------------
  it("segment missing origin only → one SEGMENT_LOCATION_REQUIRED with correct segmentId/segmentIndex/field", () => {
    const seg = segment({ id: "seg-A", sortOrder: 0, origin: null });
    const blockers = computeCompletionBlockers(baseInput({ segments: [seg] }));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      code: "SEGMENT_LOCATION_REQUIRED",
      segmentId: "seg-A",
      segmentIndex: 0,
    });
    expect(blockers[0].field).toContain("origin");
  });

  it("segment missing destination only → one SEGMENT_LOCATION_REQUIRED for destination", () => {
    const seg = segment({ id: "seg-B", sortOrder: 0, destination: "" });
    const blockers = computeCompletionBlockers(baseInput({ segments: [seg] }));
    expect(blockers).toHaveLength(1);
    expect(blockers[0].code).toBe("SEGMENT_LOCATION_REQUIRED");
    expect(blockers[0].field).toContain("destination");
  });

  it("segment missing BOTH origin and destination → two SEGMENT_LOCATION_REQUIRED blockers (not just one)", () => {
    const seg = segment({ id: "seg-C", sortOrder: 0, origin: "  ", destination: null });
    const blockers = computeCompletionBlockers(baseInput({ segments: [seg] }));
    const locationBlockers = blockers.filter((b) => b.code === "SEGMENT_LOCATION_REQUIRED");
    expect(locationBlockers).toHaveLength(2);
    expect(locationBlockers.some((b) => b.field?.includes("origin"))).toBe(true);
    expect(locationBlockers.some((b) => b.field?.includes("destination"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // SEGMENT_ATTACHMENT_REQUIRED (AC-24)
  // -------------------------------------------------------------------------
  it("segment with attachmentCount=0 → SEGMENT_ATTACHMENT_REQUIRED with segmentId/segmentIndex", () => {
    const seg = segment({ id: "seg-D", sortOrder: 0, attachmentCount: 0 });
    const blockers = computeCompletionBlockers(baseInput({ segments: [seg] }));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      code: "SEGMENT_ATTACHMENT_REQUIRED",
      segmentId: "seg-D",
      segmentIndex: 0,
    });
  });

  it("segment with attachmentCount>=1 → no SEGMENT_ATTACHMENT_REQUIRED", () => {
    const seg = segment({ attachmentCount: 3 });
    const blockers = computeCompletionBlockers(baseInput({ segments: [seg] }));
    expect(blockers.some((b) => b.code === "SEGMENT_ATTACHMENT_REQUIRED")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // segmentIndex correct mapping across multiple segments (第 2 段有問題)
  // -------------------------------------------------------------------------
  it("only the 2nd of 3 segments is missing attachments → segmentIndex=1 (not 0)", () => {
    const segs = [
      segment({ id: "s0", sortOrder: 0, attachmentCount: 1 }),
      segment({ id: "s1", sortOrder: 1, attachmentCount: 0 }),
      segment({ id: "s2", sortOrder: 2, attachmentCount: 1 }),
    ];
    const blockers = computeCompletionBlockers(baseInput({ segments: segs }));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ segmentId: "s1", segmentIndex: 1 });
  });

  // -------------------------------------------------------------------------
  // PARAMETER_NOT_AVAILABLE (AC-46)
  // -------------------------------------------------------------------------
  it("missingParameters=['FUEL'] → PARAMETER_NOT_AVAILABLE mentioning 油資", () => {
    const blockers = computeCompletionBlockers(baseInput({ missingParameters: ["FUEL"] }));
    expect(blockers).toHaveLength(1);
    expect(blockers[0].code).toBe("PARAMETER_NOT_AVAILABLE");
    expect(blockers[0].message).toContain("油資");
  });

  it("missingParameters=['ETC'] → PARAMETER_NOT_AVAILABLE mentioning ETC", () => {
    const blockers = computeCompletionBlockers(baseInput({ missingParameters: ["ETC"] }));
    expect(blockers).toHaveLength(1);
    expect(blockers[0].code).toBe("PARAMETER_NOT_AVAILABLE");
    expect(blockers[0].message).toContain("ETC");
  });

  it("missingParameters=['FUEL','ETC'] → blocker(s) mention both categories", () => {
    const blockers = computeCompletionBlockers(baseInput({ missingParameters: ["FUEL", "ETC"] }));
    const paramBlockers = blockers.filter((b) => b.code === "PARAMETER_NOT_AVAILABLE");
    expect(paramBlockers.length).toBeGreaterThanOrEqual(1);
    const combinedMessage = paramBlockers.map((b) => b.message).join(" ");
    expect(combinedMessage).toContain("油資");
    expect(combinedMessage).toContain("ETC");
  });

  it("missingParameters=[] → no PARAMETER_NOT_AVAILABLE blocker", () => {
    const blockers = computeCompletionBlockers(baseInput({ missingParameters: [] }));
    expect(blockers.some((b) => b.code === "PARAMETER_NOT_AVAILABLE")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Multiple missing items → MUST return ALL, not just the first (AC-52 core)
  // -------------------------------------------------------------------------
  it("multiple missing items at once → returns ALL blockers, not just the first", () => {
    const blockers = computeCompletionBlockers(
      baseInput({
        tripDate: null,
        purpose: null,
        segments: [segment({ id: "s0", origin: null, attachmentCount: 0 })],
        missingParameters: ["FUEL"],
      })
    );
    const codes = blockers.map((b) => b.code);
    expect(codes).toContain("TRIP_DATE_REQUIRED");
    expect(codes).toContain("PURPOSE_REQUIRED");
    expect(codes).toContain("SEGMENT_LOCATION_REQUIRED");
    expect(codes).toContain("SEGMENT_ATTACHMENT_REQUIRED");
    expect(codes).toContain("PARAMETER_NOT_AVAILABLE");
    // must be strictly more than 1 — proves it's not a "return first blocker only" implementation
    expect(blockers.length).toBeGreaterThan(1);
  });

  // -------------------------------------------------------------------------
  // Output order stability (Packet requirement): application-level first,
  // then segment-level ordered by sortOrder — regardless of input array order.
  // -------------------------------------------------------------------------
  it("output order is stable: application-level blockers precede segment-level blockers", () => {
    const blockers = computeCompletionBlockers(
      baseInput({
        tripDate: null,
        purpose: null,
        segments: [segment({ id: "s0", origin: null })],
      })
    );
    const codes = blockers.map((b) => b.code);
    const tripDateIdx = codes.indexOf("TRIP_DATE_REQUIRED");
    const purposeIdx = codes.indexOf("PURPOSE_REQUIRED");
    const locationIdx = codes.indexOf("SEGMENT_LOCATION_REQUIRED");
    expect(tripDateIdx).toBeGreaterThanOrEqual(0);
    expect(purposeIdx).toBeGreaterThanOrEqual(0);
    expect(locationIdx).toBeGreaterThanOrEqual(0);
    expect(tripDateIdx).toBeLessThan(locationIdx);
    expect(purposeIdx).toBeLessThan(locationIdx);
  });

  it("segment-level blockers are ordered by sortOrder, even if the input array order differs", () => {
    // Input array intentionally out of sortOrder order: sortOrder=1 first, sortOrder=0 second.
    const segs = [
      segment({ id: "high-sort", sortOrder: 1, attachmentCount: 0 }),
      segment({ id: "low-sort", sortOrder: 0, attachmentCount: 0 }),
    ];
    const blockers = computeCompletionBlockers(baseInput({ segments: segs }));
    const attachmentBlockers = blockers.filter((b) => b.code === "SEGMENT_ATTACHMENT_REQUIRED");
    expect(attachmentBlockers).toHaveLength(2);
    // First in output must be the one with the LOWER sortOrder (low-sort, sortOrder=0)
    expect(attachmentBlockers[0].segmentId).toBe("low-sort");
    expect(attachmentBlockers[0].segmentIndex).toBe(0);
    expect(attachmentBlockers[1].segmentId).toBe("high-sort");
    expect(attachmentBlockers[1].segmentIndex).toBe(1);
  });

  it("calling twice with the same input produces identical output (pure function, deterministic)", () => {
    const input = baseInput({ tripDate: null, segments: [segment({ origin: null })] });
    const first = computeCompletionBlockers(input);
    const second = computeCompletionBlockers(input);
    expect(first).toEqual(second);
  });

  // ===========================================================================
  // PHASE-004-T5 — 里程 blockers 併入（AC-14~18）
  // ===========================================================================

  describe("里程 blockers 併入（T5，AC-14~18）", () => {
    it("totalKm=0 → SEGMENT_TOTAL_KM_INVALID 併入輸出", () => {
      const seg = segment({ id: "s0", totalKm: decimal("0"), highwayKm: decimal("0") });
      const blockers = computeCompletionBlockers(baseInput({ segments: [seg] }));
      expect(blockers.some((b) => b.code === "SEGMENT_TOTAL_KM_INVALID")).toBe(true);
    });

    it("highwayKm > totalKm → SEGMENT_HIGHWAY_GT_TOTAL 併入輸出，帶正確 segmentId/segmentIndex", () => {
      const seg = segment({
        id: "s0",
        sortOrder: 0,
        totalKm: decimal("5"),
        highwayKm: decimal("6"),
      });
      const blockers = computeCompletionBlockers(baseInput({ segments: [seg] }));
      const b = blockers.find((x) => x.code === "SEGMENT_HIGHWAY_GT_TOTAL");
      expect(b).toBeDefined();
      expect(b?.segmentId).toBe("s0");
      expect(b?.segmentIndex).toBe(0);
    });

    it("totalKm 與 highwayKm 皆有效（highwayKm==totalKm）→ 不含任何里程 blocker", () => {
      const seg = segment({ totalKm: decimal("10.00"), highwayKm: decimal("10.00") });
      const blockers = computeCompletionBlockers(baseInput({ segments: [seg] }));
      expect(blockers.some((b) => b.code.startsWith("SEGMENT_TOTAL_KM"))).toBe(false);
      expect(blockers.some((b) => b.code.startsWith("SEGMENT_HIGHWAY"))).toBe(false);
    });

    it("多重問題同時回全部：缺日期 + 某段里程無效（totalKm=0）+ 某段缺附件 → 全部 code 都出現", () => {
      const blockers = computeCompletionBlockers(
        baseInput({
          tripDate: null,
          segments: [
            segment({
              id: "s0",
              sortOrder: 0,
              totalKm: decimal("0"),
              highwayKm: decimal("0"),
              attachmentCount: 0,
            }),
          ],
        })
      );
      const codes = blockers.map((b) => b.code);
      expect(codes).toContain("TRIP_DATE_REQUIRED");
      expect(codes).toContain("SEGMENT_TOTAL_KM_INVALID");
      expect(codes).toContain("SEGMENT_ATTACHMENT_REQUIRED");
    });

    it("併入後段落內順序：SEGMENT_LOCATION_REQUIRED → 里程 blockers → SEGMENT_ATTACHMENT_REQUIRED", () => {
      const seg = segment({
        id: "s0",
        sortOrder: 0,
        origin: null,
        totalKm: decimal("0"),
        highwayKm: decimal("0"),
        attachmentCount: 0,
      });
      const blockers = computeCompletionBlockers(baseInput({ segments: [seg] }));
      const codes = blockers.map((b) => b.code);
      const locationIdx = codes.indexOf("SEGMENT_LOCATION_REQUIRED");
      const kmIdx = codes.indexOf("SEGMENT_TOTAL_KM_INVALID");
      const attachmentIdx = codes.indexOf("SEGMENT_ATTACHMENT_REQUIRED");
      expect(locationIdx).toBeGreaterThanOrEqual(0);
      expect(kmIdx).toBeGreaterThan(locationIdx);
      expect(attachmentIdx).toBeGreaterThan(kmIdx);
    });

    it("完整輸出順序穩定（多段、多類別問題混合）", () => {
      const segs = [
        segment({
          id: "s0",
          sortOrder: 0,
          origin: null,
          totalKm: decimal("0"),
          highwayKm: decimal("0"),
          attachmentCount: 0,
        }),
        segment({
          id: "s1",
          sortOrder: 1,
          totalKm: decimal("10"),
          highwayKm: decimal("11"),
          attachmentCount: 1,
        }),
      ];
      const blockers = computeCompletionBlockers(
        baseInput({ tripDate: null, purpose: null, segments: segs, missingParameters: ["FUEL"] })
      );
      const codes = blockers.map((b) => b.code);
      // Application-level blockers first, in fixed order; then per-segment
      // blocks ordered by sortOrder, each internally ordered
      // location → mileage → attachment.
      expect(codes[0]).toBe("TRIP_DATE_REQUIRED");
      expect(codes[1]).toBe("PURPOSE_REQUIRED");
      expect(codes[2]).toBe("PARAMETER_NOT_AVAILABLE");
      // segment s0 block: location required, then km invalid, then attachment required
      const s0Codes = blockers.filter((b) => b.segmentId === "s0").map((b) => b.code);
      expect(s0Codes).toEqual([
        "SEGMENT_LOCATION_REQUIRED",
        "SEGMENT_TOTAL_KM_INVALID",
        "SEGMENT_ATTACHMENT_REQUIRED",
      ]);
      // segment s1 block: only highway-gt-total (totalKm/highwayKm both valid otherwise, attachment present)
      const s1Codes = blockers.filter((b) => b.segmentId === "s1").map((b) => b.code);
      expect(s1Codes).toEqual(["SEGMENT_HIGHWAY_GT_TOTAL"]);
      // s0's block entirely precedes s1's block in the flat array
      const lastS0Index = blockers.map((b) => b.segmentId).lastIndexOf("s0");
      const firstS1Index = blockers.map((b) => b.segmentId).indexOf("s1");
      expect(lastS0Index).toBeLessThan(firstS1Index);
    });

    it("calling twice with mileage-invalid input produces identical output (pure, deterministic)", () => {
      const input = baseInput({
        segments: [segment({ totalKm: decimal("0"), highwayKm: decimal("-1") })],
      });
      const first = computeCompletionBlockers(input);
      const second = computeCompletionBlockers(input);
      expect(first).toEqual(second);
    });
  });
});
