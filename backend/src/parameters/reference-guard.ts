/**
 * parameterHasReferences — PHASE-004-T15 closes out the PHASE-003a §4.7
 * reserved contract (BE-US-19 / AC-93).
 *
 * PHASE-003a §4.7 defined the interface contract but had no reference
 * source yet (no completed applications existed), so it was documented as
 * "returns false in this Phase". PHASE-004-T8 started writing completion
 * snapshots (`TravelApplication.fuelParameterVersionId` /
 * `etcParameterVersionId`, `TravelApplication` is 1:1 with `Application`),
 * so this Task wires the real query.
 *
 * Contract (PHASE-004 Spec §10.2 pseudocode, verbatim):
 *   parameterHasReferences("FUEL"|"ETC", versionId)
 *     → prisma.travelApplication.count({
 *         where: {
 *           application: { status: "COMPLETED" },
 *           fuelParameterVersionId | etcParameterVersionId: versionId,
 *         },
 *       }) > 0
 *
 * "Referenced" means: referenced by a COMPLETED travel application's
 * snapshot. A DRAFT travel application never has `fuelParameterVersionId` /
 * `etcParameterVersionId` populated — those columns are only written by
 * `completeTravelApplication` (T8) — so filtering on the version-id column
 * alone would already be draft-safe today. The explicit
 * `application: { status: "COMPLETED" }` filter is kept because it is part
 * of the documented contract and is defensive against any future path that
 * might otherwise leave a stale version id on a non-completed row.
 *
 * Query efficiency (C4): equality filter on `fuelParameterVersionId` /
 * `etcParameterVersionId` uses the respective single-column index declared
 * in schema.prisma (`@@index([fuelParameterVersionId])` /
 * `@@index([etcParameterVersionId])`); `count` is used (not a full fetch)
 * per the Spec's own pseudocode, matching the `userHasHistory` sibling
 * pattern (`backend/src/users/history.ts`).
 */

import type { Prisma, PrismaClient } from "@prisma/client";

/** Accepts either a plain PrismaClient or a `$transaction` callback's `tx` param. */
export type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

export type ParameterType = "FUEL" | "ETC";

/**
 * Given a parameter version's type and id, returns true iff it is
 * referenced by at least one COMPLETED travel application's snapshot
 * (AC-93). Returns false for versions with no such reference — including
 * versions only referenced by DRAFT applications, which never carry a
 * snapshot.
 */
export async function parameterHasReferences(
  prisma: PrismaClientOrTx,
  type: ParameterType,
  versionId: string
): Promise<boolean> {
  const versionIdFilter =
    type === "FUEL" ? { fuelParameterVersionId: versionId } : { etcParameterVersionId: versionId };

  const count = await prisma.travelApplication.count({
    where: {
      application: { status: "COMPLETED" },
      ...versionIdFilter,
    },
  });

  return count > 0;
}
