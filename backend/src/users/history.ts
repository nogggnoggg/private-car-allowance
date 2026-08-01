/**
 * userHasHistory — PHASE-002-T9 extensible judgment point.
 *
 * Spec §4.6 / AC-23 / D7:
 *   Determines whether a user has any "history" that should prevent deletion.
 *   "History" is defined as: application/report data owned by the user
 *   (申請/報表資料).
 *
 *   In PHASE-002, no such data tables exist yet (PHASE-004+).
 *   Therefore this function currently always returns false — all users
 *   are considered to have no history and can be hard-deleted.
 *
 * Extensibility:
 *   PHASE-004+ will extend the `getHistoryCount` dependency to query
 *   application/report tables. Tests inject a stub via the factory
 *   function to verify the "has history → reject delete" branch.
 *
 * Design (injectable for testability per Spec §9):
 *   - Default export: `userHasHistory(prisma, userId)` — uses the production
 *     check (always false in this Phase).
 *   - `makeUserHasHistory(checker)` — factory accepting a custom async
 *     checker function, used in tests to stub "has history = true".
 */

import type { PrismaClient } from "@prisma/client";

/**
 * The shape of a pluggable history checker.
 * Given a userId and PrismaClient, returns true if the user has history.
 */
export type HistoryChecker = (prisma: PrismaClient, userId: string) => Promise<boolean>;

/**
 * Production history checker — PHASE-002: always returns false.
 *
 * PHASE-004+: replace body with queries to application/report tables.
 * Example:
 *   const count = await prisma.application.count({ where: { userId } });
 *   return count > 0;
 */
const productionHistoryChecker: HistoryChecker = async (
  _prisma: PrismaClient,
  _userId: string
): Promise<boolean> => {
  // No application/report tables in PHASE-002 → no history.
  return false;
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
