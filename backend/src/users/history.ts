/**
 * userHasHistory — PHASE-002-T9 extensible judgment point.
 * Closed out in PHASE-004-T15 (AC-92 / AD-US-04).
 *
 * Spec §4.6 / AC-23 / D7 (PHASE-002) + PHASE-004 §2 AC-92:
 *   Determines whether a user has any "history" that should prevent deletion.
 *   "History" is defined as: any `Application` row owned by the user
 *   (申請/報表資料) — DRAFT or COMPLETED both count (AC-92; VOIDED is not
 *   reachable in this Phase per AC-58, but would count too since it is still
 *   an Application row owned by the user).
 *
 *   In PHASE-002, no such data tables existed yet, so this always returned
 *   false. PHASE-004-T15 wires it to the real `Application` table added by
 *   PHASE-004-T1.
 *
 * Query shape (existence check, not a full-table scan):
 *   `prisma.application.count({ where: { ownerId: userId } }) > 0`
 *   — matches the PHASE-004 §10.2 pseudocode contract exactly. `ownerId` is
 *   the leading column of `Application`'s `[ownerId, status, primaryDate]`
 *   and `[ownerId, primaryDate]` indexes (schema.prisma), so this query is
 *   an index scan, not a table scan (C4).
 *
 * Design (injectable for testability per Spec §9):
 *   - Default export: `userHasHistory(prisma, userId)` — uses the production
 *     check (real `Application` count as of PHASE-004-T15).
 *   - `makeUserHasHistory(checker)` — factory accepting a custom async
 *     checker function, used in tests to stub "has history = true"
 *     (see `admin-users.test.ts` — that test builds its own Fastify
 *     instance with an injected stub and does not exercise this
 *     production checker at all, so it is unaffected by this change).
 */

import type { PrismaClient } from "@prisma/client";

/**
 * The shape of a pluggable history checker.
 * Given a userId and PrismaClient, returns true if the user has history.
 */
export type HistoryChecker = (prisma: PrismaClient, userId: string) => Promise<boolean>;

/**
 * Production history checker — PHASE-004-T15: real `Application` count.
 *
 * Any `Application` row owned by the user counts as history, regardless of
 * `status` (DRAFT or COMPLETED both count — AC-92). Deleting the Application
 * row itself (e.g. by an out-of-band cleanup) makes the user deletable again;
 * this function has no notion of "was ever deleted", only current rows.
 */
const productionHistoryChecker: HistoryChecker = async (
  prisma: PrismaClient,
  userId: string
): Promise<boolean> => {
  const count = await prisma.application.count({ where: { ownerId: userId } });
  return count > 0;
};

/**
 * Factory: create a `userHasHistory` function backed by a custom checker.
 * Used in tests to inject a stub that returns true for the "has history" branch.
 */
export function makeUserHasHistory(
  checker: HistoryChecker = productionHistoryChecker
): (prisma: PrismaClient, userId: string) => Promise<boolean> {
  return (prisma, userId) => checker(prisma, userId);
}

/**
 * Default production instance.
 * Admin routes use this directly; tests use makeUserHasHistory() with a stub.
 */
export const userHasHistory = makeUserHasHistory(productionHistoryChecker);
