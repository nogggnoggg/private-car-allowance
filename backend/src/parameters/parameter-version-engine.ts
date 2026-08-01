/**
 * Parameter version engine — PHASE-003a-T2
 *
 * Spec §2 AC-07/08/09/10/11, §4.2 D2 方案 A, §8.1
 *
 * Two pure functions, no DB dependency — inputs are plain data structures.
 * Called by T3/T4 service layers (which supply already-fetched version arrays)
 * and by PHASE-004/007 for applying parameters to applications.
 *
 * Design decisions (D2 方案 A — 已批准):
 *   - Only effectiveFrom is persisted; the implicit end is "day before the next
 *     version's effectiveFrom". This makes "no-overlap" equivalent to
 *     "no two versions share the same effectiveFrom date (day granularity)".
 *   - All date comparisons are UTC year/month/day granularity, consistent with
 *     @db.Date → Prisma UTC-midnight convention established in T1 tests.
 *   - No external date library is introduced (native Date + UTC methods only),
 *     per Dependency Permission: 無.
 */

// ─── Day-granularity utilities ────────────────────────────────────────────────

/**
 * Normalise a Date or date string to a UTC-day numeric key (YYYYMMDD integer).
 * Two dates that fall on the same UTC calendar day produce the same key.
 *
 * Examples:
 *   "2026-01-01"                  → 20260101
 *   new Date("2026-01-01T15:30Z") → 20260101
 *   new Date("2026-01-01T00:00Z") → 20260101
 */
function toUtcDayKey(d: Date | string): number {
  const date = typeof d === "string" ? new Date(d) : d;
  // Use UTC year/month/day to avoid local timezone shifting the calendar date
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1; // 0-indexed → 1-indexed
  const day = date.getUTCDate();
  return y * 10000 + m * 100 + day;
}

/**
 * Compare two dates at UTC day granularity.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareUtcDay(a: Date | string, b: Date | string): number {
  return toUtcDayKey(a) - toUtcDayKey(b);
}

// ─── Public types ─────────────────────────────────────────────────────────────

/** Minimal shape required by both engines. T3/T4/PHASE-004/007 may pass richer types. */
export interface VersionRecord {
  id: string;
  effectiveFrom: Date | string;
}

/** Result type for checkNoOverlap */
export type NoOverlapResult =
  | { ok: true }
  | { ok: false; conflict: { id: string; effectiveFrom: string } };

// ─── checkNoOverlap ───────────────────────────────────────────────────────────

/**
 * Check whether a candidate effectiveFrom can be added to an existing set
 * of same-type parameter versions without overlap.
 *
 * Under D2 方案 A (only effectiveFrom persisted, implicit end = day before
 * next version's effectiveFrom), "overlap" degenerates to:
 *   "no two versions in the same type table share the same effectiveFrom date"
 *
 * Day granularity: candidate and existing effectiveFrom values are compared
 * at UTC year/month/day precision only; time components are ignored.
 *
 * @param existing              Array of same-type existing versions, each with
 *                              at least { id, effectiveFrom }. May be in any order.
 *                              May include extra fields (Fuel / Etc / Depreciation).
 * @param candidateEffectiveFrom The proposed new version's effectiveFrom date.
 * @returns { ok: true } if no conflict, or
 *          { ok: false; conflict: { id, effectiveFrom } } identifying the
 *          first conflicting version found (id and effectiveFrom as ISO date string
 *          "YYYY-MM-DD", for use in AC-07 error body).
 */
export function checkNoOverlap(
  existing: VersionRecord[],
  candidateEffectiveFrom: Date | string
): NoOverlapResult {
  const candidateKey = toUtcDayKey(candidateEffectiveFrom);

  for (const version of existing) {
    const existingKey = toUtcDayKey(version.effectiveFrom);
    if (existingKey === candidateKey) {
      // Conflict: candidate shares the same UTC day as this version.
      // Format effectiveFrom as "YYYY-MM-DD" for the error body.
      const d =
        typeof version.effectiveFrom === "string"
          ? new Date(version.effectiveFrom)
          : version.effectiveFrom;
      const formatted = formatUtcDate(d);
      return {
        ok: false,
        conflict: {
          id: version.id,
          effectiveFrom: formatted,
        },
      };
    }
  }

  return { ok: true };
}

// ─── findEffectiveVersion ─────────────────────────────────────────────────────

/**
 * Find the version that is effective on the given query date.
 *
 * Under D2 方案 A, the effective version for date D is:
 *   "the version with the largest effectiveFrom that is ≤ D (day granularity)"
 *
 * This is equivalent to §4.2's "effectiveFrom ≤ D ≤ implicit end" because:
 *   - The implicit end of version Vn is the day before Vn+1.effectiveFrom.
 *   - So Vn is effective for D when effectiveFrom(Vn) ≤ D < effectiveFrom(Vn+1),
 *     which is the same as "Vn is the latest version whose effectiveFrom ≤ D".
 *
 * @param versions   All same-type parameter versions. May be in any order.
 * @param queryDate  The date to query. Day granularity (UTC).
 * @returns The effective version, or null if queryDate is before the earliest
 *          effectiveFrom (i.e., no parameter has taken effect yet).
 */
export function findEffectiveVersion<T extends VersionRecord>(
  versions: T[],
  queryDate: Date | string
): T | null {
  const queryKey = toUtcDayKey(queryDate);

  // Candidates: all versions whose effectiveFrom day ≤ queryDate day
  const candidates = versions.filter((v) => toUtcDayKey(v.effectiveFrom) <= queryKey);

  if (candidates.length === 0) {
    return null;
  }

  // Among candidates, the one with the largest effectiveFrom is the active version.
  // Sort descending by effectiveFrom day key and take the first.
  candidates.sort((a, b) => compareUtcDay(b.effectiveFrom, a.effectiveFrom));

  // Non-null assertion is safe here: we checked candidates.length === 0 above.
  // TypeScript cannot narrow array indexing, so we use a null-coalescing fallback.
  return candidates[0] ?? null;
}

// ─── Internal helper ──────────────────────────────────────────────────────────

/**
 * Format a Date as "YYYY-MM-DD" using UTC components.
 * Used for the conflict error body effectiveFrom field.
 */
function formatUtcDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
