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
 *           application: { status: { in: ["COMPLETED", "VOIDED"] } },
 *           fuelParameterVersionId | fuelPriceVersionId
 *             | fuelConsumptionVersionId | etcParameterVersionId: versionId,
 *         },
 *       }) > 0
 *
 * "Referenced" means: referenced by a COMPLETED **or VOIDED** travel
 * application's snapshot (the `VOIDED` half is PHASE-009-T8 / §16 D2(a) —
 * see `REFERENCING_STATUSES` below for the reasoning; it read `COMPLETED`
 * only through PHASE-008, while `VOIDED` was still unreachable). A DRAFT
 * travel application never has any of these snapshot columns populated —
 * they are only written by `completeTravelApplication` — so filtering on the
 * version-id column alone would already be draft-safe today. The explicit
 * status filter is kept because it is part of the documented contract and is
 * defensive against any future path that might otherwise leave a stale
 * version id on a row that is neither completed nor voided.
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
 *           application: { status: { in: ["COMPLETED", "VOIDED"] } },
 *           depreciationParameterVersionId: versionId,
 *         },
 *       }) > 0
 *
 * `DepreciationApplication` is 1:1 with `Application` (`applicationId` is its
 * primary key), exactly like `TravelApplication`. A DRAFT depreciation
 * application never has that column populated — it is written only by the
 * completion transaction — so the explicit status filter is again defensive
 * rather than load-bearing, and is kept for the same reason.
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
 * PHASE-009-T8 (Spec §16 **D2(a)**, human-approved at the 2026-08-07 Spec
 * Gate; AC-18): the status condition of *both* `where` clauses below.
 *
 * Until PHASE-009 `VOIDED` was unreachable, so `status: "COMPLETED"` was
 * exactly equivalent to "has a completion snapshot". PHASE-009-T3/T4 made
 * voiding real, and PHASE-007-T10's review had already flagged what that
 * turns the filter into: a voided application keeps its full snapshot, can
 * still have its official PDF downloaded, and stays inside the audit trail —
 * yet a `COMPLETED`-only filter would report its parameter version as
 * "unreferenced" and therefore overwritable, silently making that historical
 * record un-explainable. BE-US-19④ ("must not overwrite the historical
 * content that is already referenced") protects *historical content*, and
 * voiding changes an application's **statistical validity**, not its
 * **historical existence**.
 *
 * The divergence from the statistics side is deliberate and load-bearing
 * (Spec §9.3 / §13 #4): statistics filter on `status = 'COMPLETED'` (single
 * value — voided rows must drop out of sums), reference protection filters on
 * `status ∈ {COMPLETED, VOIDED}`. **Do not "unify" the two** — they answer
 * different questions and PHASE-009 AC-16/AC-17 (statistics) and AC-18
 * (reference protection) guard each side separately.
 *
 * Option (c) of D2 — dropping the status condition entirely — was rejected
 * even though it is semantically equivalent today (drafts never write a
 * snapshot column): it removes the only explicit statement of intent, so a
 * future change that lets drafts carry a version id would silently break it.
 *
 * Also note this is a one-way commitment (Spec §17.1 #3): reverting to
 * `COMPLETED`-only is a pure code change, but any parameter version
 * overwritten in the meantime cannot be recovered at the data layer.
 */
const REFERENCING_STATUSES: Prisma.EnumApplicationStatusFilter<"Application"> = {
  in: ["COMPLETED", "VOIDED"],
};

/**
 * Given a parameter version's type and id, returns true iff it is
 * referenced by at least one COMPLETED **or VOIDED** application's snapshot
 * (AC-93 for the travel types; PHASE-007 AC-33 for `"DEPRECIATION"`; the
 * `VOIDED` half is PHASE-009 AC-18 / D2(a)). Returns false for versions with
 * no such reference — including versions only referenced by DRAFT
 * applications, which never carry a snapshot.
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
        application: { status: REFERENCING_STATUSES },
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
      application: { status: REFERENCING_STATUSES },
      ...versionIdFilter,
    },
  });

  return count > 0;
}
