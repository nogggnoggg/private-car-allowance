/**
 * Unit tests: PHASE-003-T4 — Attachment quantity-limit engine
 *
 * Spec AC-10/11/12 §13-T4:
 *   - canLink(currentCount, limit): pure, no DB, no application-type hardcoding
 *   - Required case matrix: (2,3)→allow, (3,3)→reject, (4,5)→allow, (5,5)→reject,
 *     (0,1)→allow, (1,1)→reject
 *   - Boundary behaviour: limit=0 → always reject; negative inputs → documented
 *
 * Boundary decisions (T4 definitive):
 *   limit=0  → always reject (zero slots = never allow any attachment)
 *   count<0  → treated as 0 (defensive: negative count is nonsensical, behave as empty)
 *   limit<0  → always reject (invalid upper-bound treated as 0-slot restriction)
 */

import { describe, expect, it } from "vitest";
import { canLink } from "../../src/attachment/attachment-limit-engine.js";

describe("canLink — attachment quantity limit engine (AC-10/11/12)", () => {
  // ── Required acceptance cases ──────────────────────────────────────────

  it("(2, 3) → allows: count below limit", () => {
    expect(canLink(2, 3)).toBe(true);
  });

  it("(3, 3) → rejects: count equals limit", () => {
    expect(canLink(3, 3)).toBe(false);
  });

  it("(4, 5) → allows: count below limit", () => {
    expect(canLink(4, 5)).toBe(true);
  });

  it("(5, 5) → rejects: count equals limit", () => {
    expect(canLink(5, 5)).toBe(false);
  });

  it("(0, 1) → allows: zero count below limit of 1", () => {
    expect(canLink(0, 1)).toBe(true);
  });

  it("(1, 1) → rejects: count equals limit of 1", () => {
    expect(canLink(1, 1)).toBe(false);
  });

  // ── Additional sanity cases ────────────────────────────────────────────

  it("(0, 3) → allows: zero count, limit 3", () => {
    expect(canLink(0, 3)).toBe(true);
  });

  it("(2, 5) → allows: count well below limit", () => {
    expect(canLink(2, 5)).toBe(true);
  });

  it("(6, 5) → rejects: count exceeds limit (defensive: should not happen, but must reject)", () => {
    expect(canLink(6, 5)).toBe(false);
  });

  // ── Boundary behaviour: limit = 0 ─────────────────────────────────────
  // Definitive decision: limit=0 means "no attachments allowed" → always reject

  it("(0, 0) limit=0 → rejects: zero slots defined", () => {
    expect(canLink(0, 0)).toBe(false);
  });

  it("(1, 0) limit=0 → rejects: count above zero-slot limit", () => {
    expect(canLink(1, 0)).toBe(false);
  });

  // ── Boundary behaviour: negative inputs ───────────────────────────────
  // Definitive decision:
  //   count<0  → treated as 0 (defensive normalisation)
  //   limit<0  → always reject (invalid bound → no slots)

  it("(-1, 3) negative count → treated as 0, allows (0 < 3)", () => {
    expect(canLink(-1, 3)).toBe(true);
  });

  it("(-5, 0) negative count with limit=0 → rejects (0 < 0 is false)", () => {
    expect(canLink(-5, 0)).toBe(false);
  });

  it("(0, -1) negative limit → rejects (no valid slots)", () => {
    expect(canLink(0, -1)).toBe(false);
  });

  it("(-1, -1) both negative → rejects (negative limit = no slots)", () => {
    expect(canLink(-1, -1)).toBe(false);
  });

  // ── No hardcoded type dependency (AC-12) ──────────────────────────────
  // Verified by using arbitrary integer limits (not 3 or 5 specifically)

  it("works with any integer limit — limit 7: (6,7)→allow, (7,7)→reject", () => {
    expect(canLink(6, 7)).toBe(true);
    expect(canLink(7, 7)).toBe(false);
  });

  it("works with limit 1 (tightest valid bound)", () => {
    expect(canLink(0, 1)).toBe(true);
    expect(canLink(1, 1)).toBe(false);
  });
});
