/**
 * parameterHasReferences — PHASE-004-T15 closes out the PHASE-003a §4.7
 * reserved contract (BE-US-19 / AC-93). PHASE-005a-T7b (Spec §16 D11(a))
 * extends the type union for the new fuel model.
 *
 * PHASE-003a §4.7 defined the interface contract but had no reference
 * source yet (no completed applications existed), so it was documented as
 * "returns false in this Phase". PHASE-004-T8 started writing completion
 * snapshots (`TravelApplication.fuelParameterVersionId` /
 * `etcParameterVersionId`, `TravelApplication` is 1:1 with `Application`),
 * so this Task wires the real query.
 *
 * PHASE-005a-T7 replaced the fuel-snapshot columns going forward:
 * `completeTravelApplication` now writes `fuelPriceVersionId` /
 * `fuelConsumptionVersionId` (owner-fuel-consumption × fuel-type-price
 * dual-chain resolution) instead of the legacy `fuelParameterVersionId`.
 * The legacy column is kept only for pre-existing COMPLETED rows written
 * before T7 (never backfilled — see travel-service.ts's
 * `hasLegacyFuelReference` / `hasNewFuelReference` split). D11(a) (Spec
 * §16, human-approved 2026-08-03) extends `ParameterType` accordingly:
 * `"FUEL"` keeps its original legacy-column semantics (queries
 * `fuelParameterVersionId`, for old rows); `"FUEL_PRICE"` queries
 * `fuelPriceVersionId`; `"FUEL_CONSUMPTION"` queries
 * `fuelConsumptionVersionId`; `"ETC"` is unchanged.
 *
 * Contract (PHASE-004 Spec §10.2 pseudocode, as extended by D11(a)):
 *   parameterHasReferences("FUEL"|"FUEL_PRICE"|"FUEL_CONSUMPTION"|"ETC", versionId)
 *     → prisma.travelApplication.count({
 *         where: {
 *           application: { status: "COMPLETED" },
 *           fuelParameterVersionId | fuelPriceVersionId
 *             | fuelConsumptionVersionId | etcParameterVersionId: versionId,
 *         },
 *       }) > 0
 *
 * "Referenced" means: referenced by a COMPLETED travel application's
 * snapshot. A DRAFT travel application never has any of these snapshot
 * columns populated — they are only written by `completeTravelApplication`
 * — so filtering on the version-id column alone would already be
 * draft-safe today. The explicit `application: { status: "COMPLETED" }`
 * filter is kept because it is part of the documented contract and is
 * defensive against any future path that might otherwise leave a stale
 * version id on a non-completed row.
 *
 * PHASE-007-T10 (Spec §16 D12(a), human-approved 2026-08-04) adds
 * `"DEPRECIATION"`, closing out the remaining half of the PHASE-003a §4.7
 * promise (PHASE-004 covered the travel side only). `completeDepreciation-
 * Application` writes `DepreciationApplication.depreciationParameterVersionId`
 * as part of its 8-column completion snapshot, so the same shape applies —
 * one extra branch plus one `count`:
 *
 *   parameterHasReferences("DEPRECIATION", versionId)
 *     → prisma.depreciationApplication.count({
 *         where: {
 *           application: { status: "COMPLETED" },
 *           depreciationParameterVersionId: versionId,
 *         },
 *       }) > 0
 *
 * `DepreciationApplication` is 1:1 with `Application` (`applicationId` is its
 * primary key), exactly like `TravelApplication`. A DRAFT depreciation
 * application never has that column populated — it is written only by the
 * completion transaction — so the explicit `status: "COMPLETED"` filter is
 * again defensive rather than load-bearing, and is kept for the same reason.
 * Note the column carries **no foreign key** (PHASE-007-T1 FW-6, matching the
 * PHASE-003a convention for parameter-version references), so this query is
 * the only thing standing between an operator and an overwrite of a
 * historically-referenced version — there is no database-level guard behind it.
 *
 * Query efficiency (C4): equality filter on each snapshot column uses its
 * respective single-column index declared in schema.prisma
 * (`@@index([fuelParameterVersionId])` / `@@index([etcParameterVersionId])`
 * / `@@index([fuelPriceVersionId])` / `@@index([fuelConsumptionVersionId])`
 * / `@@index([depreciationParameterVersionId])`);
 * `count` is used (not a full fetch) per the Spec's own pseudocode, matching
 * the `userHasHistory` sibling pattern (`backend/src/users/history.ts`).
 */

import type { Prisma, PrismaClient } from "@prisma/client";

/** Accepts either a plain PrismaClient or a `$transaction` callback's `tx` param. */
export type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

/**
 * `"FUEL"` — legacy column (`fuelParameterVersionId`), retained for
 * pre-PHASE-005a-T7 COMPLETED rows only (never backfilled).
 * `"FUEL_PRICE"` / `"FUEL_CONSUMPTION"` — new-model columns written by
 * `completeTravelApplication` from PHASE-005a-T7 onward.
 * `"ETC"` — unchanged across both models.
 * `"DEPRECIATION"` — PHASE-007-T10 / D12(a); queries
 * `DepreciationApplication.depreciationParameterVersionId` (a different
 * table, not merely a different column).
 */
export type ParameterType = "FUEL" | "FUEL_PRICE" | "FUEL_CONSUMPTION" | "ETC" | "DEPRECIATION";

/**
 * Given a parameter version's type and id, returns true iff it is
 * referenced by at least one COMPLETED application's snapshot (AC-93 for the
 * travel types; PHASE-007 AC-33 for `"DEPRECIATION"`). Returns false for
 * versions with no such reference — including versions only referenced by
 * DRAFT applications, which never carry a snapshot.
 */
export async function parameterHasReferences(
  prisma: PrismaClientOrTx,
  type: ParameterType,
  versionId: string
): Promise<boolean> {
  // PHASE-007-T10: the depreciation reference lives in a different table, so
  // it branches out before the travel-column selection below rather than
  // joining that ternary chain.
  if (type === "DEPRECIATION") {
    const depreciationCount = await prisma.depreciationApplication.count({
      where: {
        application: { status: "COMPLETED" },
        depreciationParameterVersionId: versionId,
      },
    });
    return depreciationCount > 0;
  }

  const versionIdFilter: Prisma.TravelApplicationWhereInput =
    type === "FUEL"
      ? { fuelParameterVersionId: versionId }
      : type === "FUEL_PRICE"
        ? { fuelPriceVersionId: versionId }
        : type === "FUEL_CONSUMPTION"
          ? { fuelConsumptionVersionId: versionId }
          : { etcParameterVersionId: versionId };

  const count = await prisma.travelApplication.count({
    where: {
      application: { status: "COMPLETED" },
      ...versionIdFilter,
    },
  });

  return count > 0;
}
