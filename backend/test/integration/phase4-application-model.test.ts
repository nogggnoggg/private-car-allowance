/**
 * Integration test: PHASE-004-T1 — Application / TravelApplication / TripSegment data models
 * + migration invariants.
 * TDD: written BEFORE schema change; expected to fail first (types/tables do not exist).
 *
 * Requires a running Postgres instance with migrations already applied.
 * If DATABASE_URL is not set, tests are skipped with an explanatory message.
 *
 * Covers Done-When invariants (Spec §7.1 / §7.3 / §17.1 D1/D2/D3/D4/D5/D9/D15):
 *  1. Decimal round-trip precision — bit-exact (string comparison, no float).
 *  2. Decimal precision truncation discriminating power — declared scale actually applied.
 *  3. @db.Date day-granularity for primaryDate / tripDate.
 *  4. ApplicationStatus / ApplicationType enum values — valid accepted, invalid rejected.
 *  5. onDelete: Restrict (User -> Application) — deleting a user with an application is rejected.
 *  6. onDelete: Cascade (Application -> TravelApplication -> TripSegment).
 *  7. sortOrder can repeat (no @@unique([travelApplicationId, sortOrder]) — D15).
 *  8. totalAmount / completedAt / snapshot fields default to null (draft invariant, §7.3 不變式 2).
 *  9. ownerId !== createdById can coexist (on-behalf prerequisite).
 *
 * Test discipline (Spec §11.0 / CLAUDE.md): cleanup scoped to this suite's own synthetic data only
 * (loginName prefix "p4t1_" + tracked application ids); NEVER deleteMany({}) globally.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.DATABASE_URL;

const describeWithDb = DB_URL ? describe : describe.skip;

const LOGIN_PREFIX = "p4t1_";
// Per-run suffix (R1 dafcd21 convention) — defense in depth on top of the
// wildcard-collision fix above: keeps this suite's fixture login names
// distinguishable across runs/crashes without weakening the broad
// LOGIN_PREFIX-scoped self-heal (which still matches regardless of suffix).
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

describeWithDb("PHASE-004-T1 — Application / TravelApplication / TripSegment models", () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import for test isolation
  let prisma: any;
  let ownerUser: { id: string };
  let adminUser: { id: string };

  // Track application ids created by this suite for scoped cleanup.
  // Deleting an Application cascades to its TravelApplication + TripSegment rows.
  const createdApplicationIds: string[] = [];

  // Root cause (verified empirically — see Task Handoff): Prisma's
  // `{ startsWith: LOGIN_PREFIX }` compiles to SQL `LIKE 'LOGIN_PREFIX%'`,
  // and Postgres LIKE treats a literal `_` in the pattern as a single-
  // character WILDCARD, not a literal underscore. LOGIN_PREFIX = "p4t1_"
  // therefore also matches OTHER suites' fixed prefixes that happen to
  // extend "p4t1" with one more digit before their own underscore, e.g.
  // "p4t10_" (phase4-admin-on-behalf.test.ts) and "p4t12_"
  // (phase4-on-behalf-audit.test.ts) — the "_" absorbs their "0"/"2".
  // When those suites run concurrently (separate vitest fork workers) and
  // currently have live users owning an Application, this suite's
  // "self-heal" deleteMany(loginName startsWith "p4t1_") either (a) fails
  // with the FK violation this repair item was filed for, when the victim
  // user currently owns an Application, or (b) silently deletes a live
  // concurrent suite's users out from under it when it does not — a graver,
  // silent cross-suite corruption. Confirmed directly: a user literally
  // named "p4t10_zzztest" matches `{ loginName: { startsWith: "p4t1_" } }`.
  //
  // Fix: never rely on Prisma's SQL-LIKE `startsWith` for the authoritative
  // membership check. Use it only as a cheap, deliberately-over-broad bound
  // (safe because it can only ever return a superset, never miss a real
  // match), then filter with real JS string `.startsWith()` — which has no
  // wildcard semantics — before deleting. This also fixes the secondary gap
  // the Packet flagged: any Application owned by a resolved "own" user is
  // now deleted (not just ones this process tracked via
  // createdApplicationIds), so an untracked residual from a previously
  // crashed run of THIS suite can no longer FK-block the user delete either.
  async function cleanupSyntheticData() {
    if (createdApplicationIds.length > 0) {
      await prisma.application.deleteMany({
        where: { id: { in: createdApplicationIds } },
      });
    }

    // literalBound is guaranteed free of SQL LIKE special characters
    // ("_"/"%") since LOGIN_PREFIX's own literal separator has not been
    // reached yet — safe to hand to Prisma's startsWith as an over-broad
    // pre-filter; correctness comes from the exact JS filter below.
    const literalBound = LOGIN_PREFIX.split("_")[0];
    const candidates = await prisma.user.findMany({
      where: { loginName: { startsWith: literalBound } },
      select: { id: true, loginName: true },
    });
    const ownUserIds = candidates
      .filter((u: { loginName: string }) => u.loginName.startsWith(LOGIN_PREFIX))
      .map((u: { id: string }) => u.id);

    if (ownUserIds.length > 0) {
      await prisma.application.deleteMany({ where: { ownerId: { in: ownUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: ownUserIds } } });
    }
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({
      datasources: { db: { url: DB_URL } },
    });
    await prisma.$connect();

    // Self-healing: remove any residual rows from previous failed runs.
    await cleanupSyntheticData();

    ownerUser = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}owner_${RUN_ID}`,
        displayName: "P4T1 Owner",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
      },
    });
    adminUser = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}admin_${RUN_ID}`,
        displayName: "P4T1 Admin",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
        role: "ADMIN",
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await cleanupSyntheticData();
      await prisma.$disconnect();
    }
  });

  // -----------------------------------------------------------------------
  // Invariant: basic create/read for the three models, ownerId !== createdById
  // -----------------------------------------------------------------------

  it("creates Application(type=TRAVEL, status=DRAFT) with owner !== createdBy and reads it back", async () => {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: ownerUser.id,
        createdById: adminUser.id, // on-behalf: creator differs from owner
        primaryDate: new Date("2026-05-01"),
        travel: { create: {} },
      },
      include: { travel: true },
    });
    createdApplicationIds.push(application.id);

    expect(application.id).toBeTypeOf("string");
    expect(application.type).toBe("TRAVEL");
    expect(application.status).toBe("DRAFT");
    expect(application.ownerId).toBe(ownerUser.id);
    expect(application.createdById).toBe(adminUser.id);
    expect(application.ownerId).not.toBe(application.createdById);
    expect(application.travel).not.toBeNull();
    expect(application.travel.applicationId).toBe(application.id);

    const found = await prisma.application.findUnique({
      where: { id: application.id },
      include: { travel: true },
    });
    expect(found).not.toBeNull();
    expect(found.ownerId).toBe(ownerUser.id);
    expect(found.createdById).toBe(adminUser.id);
  });

  it("creates a TripSegment under a TravelApplication and reads it back", async () => {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: ownerUser.id,
        createdById: ownerUser.id,
        primaryDate: new Date("2026-05-02"),
        travel: { create: {} },
      },
      include: { travel: true },
    });
    createdApplicationIds.push(application.id);

    const segment = await prisma.tripSegment.create({
      data: {
        travelApplicationId: application.travel.applicationId,
        sortOrder: 0,
        origin: "台北市政府",
        destination: "新竹科學園區",
        totalKm: "23.40",
        highwayKm: "18.00",
      },
    });

    expect(segment.id).toBeTypeOf("string");
    expect(segment.origin).toBe("台北市政府");
    expect(segment.destination).toBe("新竹科學園區");

    const found = await prisma.tripSegment.findUnique({ where: { id: segment.id } });
    expect(found).not.toBeNull();
    expect(found.travelApplicationId).toBe(application.travel.applicationId);
  });

  // -----------------------------------------------------------------------
  // Invariant: ApplicationType / ApplicationStatus enum values
  // -----------------------------------------------------------------------

  it("supports all ApplicationType enum values", async () => {
    const types = ["TRAVEL", "MAINTENANCE", "DEPRECIATION"] as const;
    for (const [i, type] of types.entries()) {
      const application = await prisma.application.create({
        data: {
          type,
          status: "DRAFT",
          ownerId: ownerUser.id,
          createdById: ownerUser.id,
          primaryDate: new Date(`2026-05-1${i}`),
        },
      });
      createdApplicationIds.push(application.id);
      expect(application.type).toBe(type);
    }
  });

  it("supports all ApplicationStatus enum values", async () => {
    const statuses = ["DRAFT", "COMPLETED", "VOIDED"] as const;
    for (const [i, status] of statuses.entries()) {
      const application = await prisma.application.create({
        data: {
          type: "TRAVEL",
          status,
          ownerId: ownerUser.id,
          createdById: ownerUser.id,
          primaryDate: new Date(`2026-05-2${i}`),
        },
      });
      createdApplicationIds.push(application.id);
      expect(application.status).toBe(status);
    }
  });

  it("rejects an invalid ApplicationStatus value at the DB layer", async () => {
    await expect(
      prisma.$queryRawUnsafe(`SELECT 'BOGUS_STATUS'::"ApplicationStatus"`)
    ).rejects.toThrow();
  });

  it("rejects an invalid ApplicationType value at the DB layer", async () => {
    await expect(
      prisma.$queryRawUnsafe(`SELECT 'BOGUS_TYPE'::"ApplicationType"`)
    ).rejects.toThrow();
  });

  // -----------------------------------------------------------------------
  // Invariant: Decimal round-trip precision — bit-exact (string comparison)
  // -----------------------------------------------------------------------

  it("Decimal round-trip: totalKm / highwayKm / fuelUnitPrice / snapshotRawAmount are bit-exact", async () => {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: ownerUser.id,
        createdById: ownerUser.id,
        primaryDate: new Date("2026-06-01"),
        travel: {
          create: {
            fuelUnitPrice: "5.1234",
          },
        },
      },
      include: { travel: true },
    });
    createdApplicationIds.push(application.id);

    expect(application.travel.fuelUnitPrice.toString()).toBe("5.1234");

    const segment = await prisma.tripSegment.create({
      data: {
        travelApplicationId: application.travel.applicationId,
        sortOrder: 0,
        totalKm: "12.35",
        highwayKm: "0.05",
        snapshotRawAmount: "1234.5678",
      },
    });

    expect(segment.totalKm.toString()).toBe("12.35");
    expect(segment.highwayKm.toString()).toBe("0.05");
    expect(segment.snapshotRawAmount.toString()).toBe("1234.5678");

    // Read back fresh from DB (not the create() return value) to rule out
    // any client-side echo masking a real storage precision loss.
    const foundTravel = await prisma.travelApplication.findUnique({
      where: { applicationId: application.id },
    });
    expect(foundTravel.fuelUnitPrice.toString()).toBe("5.1234");

    const foundSegment = await prisma.tripSegment.findUnique({ where: { id: segment.id } });
    expect(foundSegment.totalKm.toString()).toBe("12.35");
    expect(foundSegment.highwayKm.toString()).toBe("0.05");
    expect(foundSegment.snapshotRawAmount.toString()).toBe("1234.5678");
  });

  // -----------------------------------------------------------------------
  // Invariant: Decimal precision truncation discriminating power (D5)
  // totalKm is Decimal(10,2) — a value with 3 decimal digits must be
  // rounded to 2 decimal digits by the DB's declared scale (round-half-up,
  // verified empirically against this Postgres instance: 12.345 -> 12.35).
  // If the column were declared with a different/looser scale (e.g. no
  // scale, or Decimal(10,4)), this assertion would fail — proving the
  // Decimal(10,2) declaration actually takes effect.
  // -----------------------------------------------------------------------

  it("Decimal(10,2) scale is actually enforced: totalKm=12.345 is rounded to 12.35 by the DB", async () => {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: ownerUser.id,
        createdById: ownerUser.id,
        primaryDate: new Date("2026-06-02"),
        travel: { create: {} },
      },
      include: { travel: true },
    });
    createdApplicationIds.push(application.id);

    const segment = await prisma.tripSegment.create({
      data: {
        travelApplicationId: application.travel.applicationId,
        sortOrder: 0,
        totalKm: "12.345", // 3 decimal digits — exceeds declared scale of 2
      },
    });

    // Must NOT remain "12.345" — the declared Decimal(10,2) scale must have
    // rounded it at the DB layer. This is the discriminant: a schema bug
    // (e.g. missing @db.Decimal(10,2), or wrong scale) would leave this at
    // "12.345" or produce a different rounded value.
    expect(segment.totalKm.toString()).not.toBe("12.345");
    expect(segment.totalKm.toString()).toBe("12.35");

    const found = await prisma.tripSegment.findUnique({ where: { id: segment.id } });
    expect(found.totalKm.toString()).toBe("12.35");
  });

  // -----------------------------------------------------------------------
  // Invariant: @db.Date day granularity for primaryDate / tripDate
  // -----------------------------------------------------------------------

  it("Application.primaryDate @db.Date normalises to day granularity (UTC midnight)", async () => {
    const dateWithTime = new Date("2026-06-15T15:30:45.123Z");

    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: ownerUser.id,
        createdById: ownerUser.id,
        primaryDate: dateWithTime,
      },
    });
    createdApplicationIds.push(application.id);

    const found = await prisma.application.findUnique({ where: { id: application.id } });
    const stored = found.primaryDate;

    expect(stored).toBeInstanceOf(Date);
    expect(stored.getUTCFullYear()).toBe(2026);
    expect(stored.getUTCMonth()).toBe(5); // 0-indexed: June = 5
    expect(stored.getUTCDate()).toBe(15);
    expect(stored.getUTCHours()).toBe(0);
    expect(stored.getUTCMinutes()).toBe(0);
    expect(stored.getUTCSeconds()).toBe(0);
  });

  it("TravelApplication.tripDate @db.Date normalises to day granularity (UTC midnight)", async () => {
    const dateWithTime = new Date("2026-06-20T09:12:34.500Z");

    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: ownerUser.id,
        createdById: ownerUser.id,
        primaryDate: new Date("2026-06-20"),
        travel: {
          create: {
            tripDate: dateWithTime,
          },
        },
      },
      include: { travel: true },
    });
    createdApplicationIds.push(application.id);

    const found = await prisma.travelApplication.findUnique({
      where: { applicationId: application.id },
    });
    const stored = found.tripDate;

    expect(stored).toBeInstanceOf(Date);
    expect(stored.getUTCFullYear()).toBe(2026);
    expect(stored.getUTCMonth()).toBe(5); // June = 5
    expect(stored.getUTCDate()).toBe(20);
    expect(stored.getUTCHours()).toBe(0);
    expect(stored.getUTCMinutes()).toBe(0);
    expect(stored.getUTCSeconds()).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Invariant: onDelete: Restrict (User -> Application)
  // -----------------------------------------------------------------------

  it("onDelete: Restrict — deleting a User who owns an Application is rejected by the DB", async () => {
    const restrictedUser = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}restrict_owner_${RUN_ID}`,
        displayName: "P4T1 Restrict Owner",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
      },
    });

    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: restrictedUser.id,
        createdById: restrictedUser.id,
        primaryDate: new Date("2026-06-25"),
      },
    });
    createdApplicationIds.push(application.id);

    let caught: unknown = null;
    try {
      await prisma.user.delete({ where: { id: restrictedUser.id } });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    // Prisma surfaces FK restrict violations as P2003 (or an equivalent
    // constraint-violation error) — assert on the underlying mechanism,
    // not just "something threw", so a schema regression to Cascade/SetNull
    // would be caught even if the error still throws for another reason.
    expect((caught as { code?: string }).code === "P2003" || String(caught).includes("23503")).toBe(
      true
    );

    // User must still exist — the delete must not have partially succeeded.
    const stillThere = await prisma.user.findUnique({ where: { id: restrictedUser.id } });
    expect(stillThere).not.toBeNull();

    // Cleanup: delete the application first (releases the FK), then the user
    // (afterAll's loginName-prefix cleanup will also catch this, but do it
    // explicitly here to keep this test self-contained).
    await prisma.application.delete({ where: { id: application.id } });
    createdApplicationIds.splice(createdApplicationIds.indexOf(application.id), 1);
    await prisma.user.delete({ where: { id: restrictedUser.id } });
  });

  // -----------------------------------------------------------------------
  // Invariant: onDelete: Cascade (Application -> TravelApplication -> TripSegment)
  // -----------------------------------------------------------------------

  it("onDelete: Cascade — deleting an Application removes its TravelApplication and TripSegments", async () => {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: ownerUser.id,
        createdById: ownerUser.id,
        primaryDate: new Date("2026-07-01"),
        travel: {
          create: {
            segments: {
              create: [
                { sortOrder: 0, origin: "A", destination: "B", totalKm: "10.00" },
                { sortOrder: 1, origin: "B", destination: "C", totalKm: "20.00" },
              ],
            },
          },
        },
      },
      include: { travel: { include: { segments: true } } },
    });

    const applicationId = application.id;
    const travelApplicationId = application.travel.applicationId;
    const segmentIds = application.travel.segments.map((s: { id: string }) => s.id);
    expect(segmentIds.length).toBe(2);

    await prisma.application.delete({ where: { id: applicationId } });

    const foundApplication = await prisma.application.findUnique({ where: { id: applicationId } });
    expect(foundApplication).toBeNull();

    const foundTravel = await prisma.travelApplication.findUnique({
      where: { applicationId: travelApplicationId },
    });
    expect(foundTravel).toBeNull();

    const foundSegments = await prisma.tripSegment.findMany({
      where: { id: { in: segmentIds } },
    });
    expect(foundSegments.length).toBe(0);

    // Already gone — do not add to createdApplicationIds cleanup list.
  });

  // -----------------------------------------------------------------------
  // Invariant: sortOrder can repeat (D15 — no @@unique on
  // (travelApplicationId, sortOrder), to allow transient duplicates during reorder)
  // -----------------------------------------------------------------------

  it("sortOrder can repeat within the same TravelApplication (no unique constraint)", async () => {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: ownerUser.id,
        createdById: ownerUser.id,
        primaryDate: new Date("2026-07-05"),
        travel: { create: {} },
      },
      include: { travel: true },
    });
    createdApplicationIds.push(application.id);

    const s1 = await prisma.tripSegment.create({
      data: {
        travelApplicationId: application.travel.applicationId,
        sortOrder: 0,
        origin: "X",
      },
    });
    // Second segment with the SAME sortOrder=0 must be allowed (no unique key).
    const s2 = await prisma.tripSegment.create({
      data: {
        travelApplicationId: application.travel.applicationId,
        sortOrder: 0,
        origin: "Y",
      },
    });

    expect(s1.sortOrder).toBe(0);
    expect(s2.sortOrder).toBe(0);
    expect(s1.id).not.toBe(s2.id);

    const segments = await prisma.tripSegment.findMany({
      where: { travelApplicationId: application.travel.applicationId },
    });
    expect(segments.length).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Invariant: totalAmount / completedAt / snapshot fields default to null
  // (draft invariant, §7.3 不變式 2)
  // -----------------------------------------------------------------------

  it("draft Application: totalAmount and completedAt default to null", async () => {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: ownerUser.id,
        createdById: ownerUser.id,
        primaryDate: new Date("2026-07-10"),
      },
    });
    createdApplicationIds.push(application.id);

    expect(application.totalAmount).toBeNull();
    expect(application.completedAt).toBeNull();
  });

  it("draft TravelApplication: all snapshot fields default to null", async () => {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: ownerUser.id,
        createdById: ownerUser.id,
        primaryDate: new Date("2026-07-11"),
        travel: { create: {} },
      },
      include: { travel: true },
    });
    createdApplicationIds.push(application.id);

    expect(application.travel.fuelUnitPrice).toBeNull();
    expect(application.travel.etcUnitPrice).toBeNull();
    expect(application.travel.fuelParameterVersionId).toBeNull();
    expect(application.travel.etcParameterVersionId).toBeNull();
    expect(application.travel.snapshotTotalKm).toBeNull();
    expect(application.travel.snapshotRawAmount).toBeNull();
    expect(application.travel.calculatedAt).toBeNull();
  });

  it("draft TripSegment: all snapshot fields default to null", async () => {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: ownerUser.id,
        createdById: ownerUser.id,
        primaryDate: new Date("2026-07-12"),
        travel: { create: {} },
      },
      include: { travel: true },
    });
    createdApplicationIds.push(application.id);

    const segment = await prisma.tripSegment.create({
      data: {
        travelApplicationId: application.travel.applicationId,
        sortOrder: 0,
      },
    });

    expect(segment.snapshotFuelAmount).toBeNull();
    expect(segment.snapshotEtcAmount).toBeNull();
    expect(segment.snapshotRawAmount).toBeNull();
    expect(segment.snapshotAmount).toBeNull();
  });
});
