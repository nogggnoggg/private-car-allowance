/**
 * Integration test: PHASE-003a-T1 — Parameter version data models + migration invariants.
 * TDD: written BEFORE schema change; expected to fail first (tables do not exist).
 *
 * Requires a running Postgres instance with migrations already applied.
 * If DATABASE_URL is not set, tests are skipped with an explanatory message.
 *
 * Covers Done-When invariants (Spec §3.1 / §4.3/D4 / §4.4/D8):
 *  1. Three tables can each create/read back one version.
 *  2. Decimal precision (unitPrice / vehiclePrice) — write-read consistency, no float distortion.
 *  3. effectiveFrom @db.Date is day-granularity (same-day different times → same date).
 *  4. @@unique([effectiveFrom]) — duplicate effectiveFrom in same table throws.
 *  5. usefulLifeYears / estimatedAnnualKm are Int (non-decimal).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.DATABASE_URL;

const describeWithDb = DB_URL ? describe : describe.skip;

// Sentinel createdById values used exclusively by this test file.
// Used for scoped cleanup — never collide with other test files.
const OWN_CREATOR_ID = "p3a_t1_synthetic_creator";

describeWithDb(
  "PHASE-003a-T1 — FuelParameterVersion / EtcParameterVersion / DepreciationParameterVersion models",
  () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import for test isolation
    let prisma: any;

    beforeAll(async () => {
      if (!DB_URL) return;
      const { PrismaClient } = await import("@prisma/client");
      prisma = new PrismaClient({
        datasources: { db: { url: DB_URL } },
      });
      await prisma.$connect();

      // Self-healing: remove any residual rows from previous failed runs
      // so that unique-key constraints don't fire during this run.
      // Scoped to our sentinel createdById — never touches other test data.
      await prisma.fuelParameterVersion.deleteMany({
        where: { createdById: OWN_CREATOR_ID },
      });
      await prisma.etcParameterVersion.deleteMany({
        where: { createdById: OWN_CREATOR_ID },
      });
      await prisma.depreciationParameterVersion.deleteMany({
        where: { createdById: OWN_CREATOR_ID },
      });
    });

    afterAll(async () => {
      if (prisma) {
        // Scoped cleanup: only delete rows created by this test suite
        // (identified by the sentinel createdById value).
        await prisma.fuelParameterVersion.deleteMany({
          where: { createdById: OWN_CREATOR_ID },
        });
        await prisma.etcParameterVersion.deleteMany({
          where: { createdById: OWN_CREATOR_ID },
        });
        await prisma.depreciationParameterVersion.deleteMany({
          where: { createdById: OWN_CREATOR_ID },
        });
        await prisma.$disconnect();
      }
    });

    // -----------------------------------------------------------------------
    // Invariant 1a: FuelParameterVersion — create and read back
    // -----------------------------------------------------------------------

    it("FuelParameterVersion: can create and read back one version", async () => {
      const effectiveFrom = new Date("2026-01-01");

      const version = await prisma.fuelParameterVersion.create({
        data: {
          unitPrice: "3.5000",
          effectiveFrom,
          createdById: OWN_CREATOR_ID,
        },
      });

      expect(version.id).toBeTypeOf("string");
      expect(version.id.length).toBeGreaterThan(0);
      expect(version.createdById).toBe(OWN_CREATOR_ID);
      expect(version.createdAt).toBeInstanceOf(Date);

      // Read back
      const found = await prisma.fuelParameterVersion.findUnique({
        where: { id: version.id },
      });
      expect(found).not.toBeNull();
      expect(found.id).toBe(version.id);
    });

    // -----------------------------------------------------------------------
    // Invariant 1b: EtcParameterVersion — create and read back
    // -----------------------------------------------------------------------

    it("EtcParameterVersion: can create and read back one version", async () => {
      const effectiveFrom = new Date("2026-02-01");

      const version = await prisma.etcParameterVersion.create({
        data: {
          unitPrice: "2.0000",
          effectiveFrom,
          createdById: OWN_CREATOR_ID,
        },
      });

      expect(version.id).toBeTypeOf("string");
      expect(version.createdById).toBe(OWN_CREATOR_ID);
      expect(version.createdAt).toBeInstanceOf(Date);

      const found = await prisma.etcParameterVersion.findUnique({
        where: { id: version.id },
      });
      expect(found).not.toBeNull();
      expect(found.id).toBe(version.id);
    });

    // -----------------------------------------------------------------------
    // Invariant 1c: DepreciationParameterVersion — create and read back
    // -----------------------------------------------------------------------

    it("DepreciationParameterVersion: can create and read back one version", async () => {
      const effectiveFrom = new Date("2026-03-01");

      const version = await prisma.depreciationParameterVersion.create({
        data: {
          vehiclePrice: "500000.00",
          usefulLifeYears: 5,
          estimatedAnnualKm: 20000,
          effectiveFrom,
          createdById: OWN_CREATOR_ID,
        },
      });

      expect(version.id).toBeTypeOf("string");
      expect(version.usefulLifeYears).toBe(5);
      expect(version.estimatedAnnualKm).toBe(20000);
      expect(version.createdById).toBe(OWN_CREATOR_ID);
      expect(version.createdAt).toBeInstanceOf(Date);

      const found = await prisma.depreciationParameterVersion.findUnique({
        where: { id: version.id },
      });
      expect(found).not.toBeNull();
      expect(found.id).toBe(version.id);
    });

    // -----------------------------------------------------------------------
    // Invariant 2a: Decimal precision — FuelParameterVersion unitPrice
    // Write-read consistency, no float distortion (D8: Decimal(10,4))
    // -----------------------------------------------------------------------

    it("FuelParameterVersion: unitPrice Decimal write-read consistent (3.1416)", async () => {
      const effectiveFrom = new Date("2026-04-01");

      const version = await prisma.fuelParameterVersion.create({
        data: {
          unitPrice: "3.1416",
          effectiveFrom,
          createdById: OWN_CREATOR_ID,
        },
      });

      // Prisma returns Decimal objects; toString() gives exact representation.
      expect(version.unitPrice.toString()).toBe("3.1416");

      // Read back from DB and verify no float distortion
      const found = await prisma.fuelParameterVersion.findUnique({
        where: { id: version.id },
      });
      expect(found.unitPrice.toString()).toBe("3.1416");
    });

    it("EtcParameterVersion: unitPrice Decimal write-read consistent (1.5)", async () => {
      const effectiveFrom = new Date("2026-05-01");

      const version = await prisma.etcParameterVersion.create({
        data: {
          unitPrice: "1.5000",
          effectiveFrom,
          createdById: OWN_CREATOR_ID,
        },
      });

      // Decimal(10,4) write-read must not introduce float distortion.
      // Prisma's Decimal (decimal.js) normalises trailing zeros on toString(),
      // so "1.5000" → "1.5" is correct behaviour; we assert exact equality via equals().
      // The Prisma Decimal object's .equals() method compares numerically without float error.
      expect(version.unitPrice.equals("1.5")).toBe(true);

      const found = await prisma.etcParameterVersion.findUnique({
        where: { id: version.id },
      });
      expect(found.unitPrice.equals("1.5")).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Invariant 2b: Decimal precision — DepreciationParameterVersion vehiclePrice
    // D8: vehiclePrice Decimal(12,2)
    // -----------------------------------------------------------------------

    it("DepreciationParameterVersion: vehiclePrice Decimal write-read consistent (123456.78)", async () => {
      const effectiveFrom = new Date("2026-06-01");

      const version = await prisma.depreciationParameterVersion.create({
        data: {
          vehiclePrice: "123456.78",
          usefulLifeYears: 6,
          estimatedAnnualKm: 15000,
          effectiveFrom,
          createdById: OWN_CREATOR_ID,
        },
      });

      expect(version.vehiclePrice.toString()).toBe("123456.78");

      const found = await prisma.depreciationParameterVersion.findUnique({
        where: { id: version.id },
      });
      expect(found.vehiclePrice.toString()).toBe("123456.78");
    });

    // -----------------------------------------------------------------------
    // Invariant 3: effectiveFrom @db.Date is day-granularity
    // Same-day different times → stored as same date (no time component).
    // -----------------------------------------------------------------------

    it("FuelParameterVersion: effectiveFrom @db.Date normalises to day granularity", async () => {
      // Use a distinct date not used elsewhere in this test file
      const dateWithMidnight = new Date("2026-07-01T00:00:00.000Z");
      const dateWithTime = new Date("2026-07-01T15:30:45.123Z");

      // Create with the midnight version
      const v1 = await prisma.fuelParameterVersion.create({
        data: {
          unitPrice: "4.0000",
          effectiveFrom: dateWithMidnight,
          createdById: OWN_CREATOR_ID,
        },
      });

      // The stored effectiveFrom should represent date-only (no time component).
      // PostgreSQL DATE type stores no time; Prisma returns midnight UTC for @db.Date.
      const readBack = await prisma.fuelParameterVersion.findUnique({
        where: { id: v1.id },
      });

      // The date part must match "2026-07-01" regardless of what time was supplied.
      const stored = readBack.effectiveFrom;
      expect(stored).toBeInstanceOf(Date);
      // Verify the calendar date (year/month/day) in UTC
      expect(stored.getUTCFullYear()).toBe(2026);
      expect(stored.getUTCMonth()).toBe(6); // 0-indexed: July = 6
      expect(stored.getUTCDate()).toBe(1);

      // dateWithTime (2026-07-01T15:30:45) should also normalise to 2026-07-01.
      // Since @@unique([effectiveFrom]) is in place, we verify by reading the v1 record —
      // and separately confirm that the @db.Date column dropped the time component.
      // We test this by checking that v1's stored date equals a new Date at same UTC day.
      const expectedDate = new Date("2026-07-01T00:00:00.000Z");
      expect(stored.getUTCFullYear()).toBe(expectedDate.getUTCFullYear());
      expect(stored.getUTCMonth()).toBe(expectedDate.getUTCMonth());
      expect(stored.getUTCDate()).toBe(expectedDate.getUTCDate());

      // Additional: confirm that hour/minute/second components are zeroed (pure date)
      // PostgreSQL DATE returns midnight UTC, so time parts should be 0.
      expect(stored.getUTCHours()).toBe(0);
      expect(stored.getUTCMinutes()).toBe(0);
      expect(stored.getUTCSeconds()).toBe(0);

      // Also verify that dateWithTime would conflict (same day = same @db.Date),
      // proving the @db.Date normalisation is real and effectiveFrom @@unique acts on date not datetime.
      // We expect this second insert to throw due to @@unique([effectiveFrom]).
      await expect(
        prisma.fuelParameterVersion.create({
          data: {
            unitPrice: "4.5000",
            effectiveFrom: dateWithTime, // same calendar day, different time
            createdById: OWN_CREATOR_ID,
          },
        })
      ).rejects.toThrow();
    });

    // -----------------------------------------------------------------------
    // Invariant 4: @@unique([effectiveFrom]) — D4 concurrency guard
    // Duplicate effectiveFrom in same table must throw unique key error.
    // Discriminant test: this test MUST FAIL (go red) if @@unique is removed.
    // -----------------------------------------------------------------------

    it("FuelParameterVersion: @@unique([effectiveFrom]) rejects duplicate effectiveFrom", async () => {
      const effectiveFrom = new Date("2026-08-01");

      // First insert succeeds
      await prisma.fuelParameterVersion.create({
        data: {
          unitPrice: "5.0000",
          effectiveFrom,
          createdById: OWN_CREATOR_ID,
        },
      });

      // Second insert with same effectiveFrom must throw
      await expect(
        prisma.fuelParameterVersion.create({
          data: {
            unitPrice: "5.5000",
            effectiveFrom, // same date — must conflict
            createdById: OWN_CREATOR_ID,
          },
        })
      ).rejects.toThrow();
    });

    it("EtcParameterVersion: @@unique([effectiveFrom]) rejects duplicate effectiveFrom", async () => {
      const effectiveFrom = new Date("2026-08-01");

      await prisma.etcParameterVersion.create({
        data: {
          unitPrice: "3.0000",
          effectiveFrom,
          createdById: OWN_CREATOR_ID,
        },
      });

      await expect(
        prisma.etcParameterVersion.create({
          data: {
            unitPrice: "3.5000",
            effectiveFrom,
            createdById: OWN_CREATOR_ID,
          },
        })
      ).rejects.toThrow();
    });

    it("DepreciationParameterVersion: @@unique([effectiveFrom]) rejects duplicate effectiveFrom", async () => {
      const effectiveFrom = new Date("2026-08-01");

      await prisma.depreciationParameterVersion.create({
        data: {
          vehiclePrice: "800000.00",
          usefulLifeYears: 8,
          estimatedAnnualKm: 25000,
          effectiveFrom,
          createdById: OWN_CREATOR_ID,
        },
      });

      await expect(
        prisma.depreciationParameterVersion.create({
          data: {
            vehiclePrice: "900000.00",
            usefulLifeYears: 9,
            estimatedAnnualKm: 30000,
            effectiveFrom,
            createdById: OWN_CREATOR_ID,
          },
        })
      ).rejects.toThrow();
    });

    // -----------------------------------------------------------------------
    // Invariant 4b: @@unique is per-table (same effectiveFrom in different tables is OK)
    // -----------------------------------------------------------------------

    it("same effectiveFrom in different tables (Fuel vs Etc) is allowed — unique is per table", async () => {
      const effectiveFrom = new Date("2026-09-01");

      // Both creates should succeed (unique constraint is per-table, not cross-table)
      const fuel = await prisma.fuelParameterVersion.create({
        data: {
          unitPrice: "6.0000",
          effectiveFrom,
          createdById: OWN_CREATOR_ID,
        },
      });

      const etc = await prisma.etcParameterVersion.create({
        data: {
          unitPrice: "4.0000",
          effectiveFrom,
          createdById: OWN_CREATOR_ID,
        },
      });

      expect(fuel.id).toBeTypeOf("string");
      expect(etc.id).toBeTypeOf("string");
      // Both share same effectiveFrom date — no conflict across tables
      expect(fuel.effectiveFrom.getUTCFullYear()).toBe(2026);
      expect(etc.effectiveFrom.getUTCFullYear()).toBe(2026);
    });

    // -----------------------------------------------------------------------
    // Invariant 5: usefulLifeYears and estimatedAnnualKm are Int (non-decimal)
    // -----------------------------------------------------------------------

    it("DepreciationParameterVersion: usefulLifeYears is Int (integer read-back)", async () => {
      const effectiveFrom = new Date("2026-10-01");

      const version = await prisma.depreciationParameterVersion.create({
        data: {
          vehiclePrice: "600000.00",
          usefulLifeYears: 7,
          estimatedAnnualKm: 18000,
          effectiveFrom,
          createdById: OWN_CREATOR_ID,
        },
      });

      // Must be an integer (number), not a Decimal or string
      expect(typeof version.usefulLifeYears).toBe("number");
      expect(Number.isInteger(version.usefulLifeYears)).toBe(true);
      expect(version.usefulLifeYears).toBe(7);
    });

    it("DepreciationParameterVersion: estimatedAnnualKm is Int (integer read-back)", async () => {
      const effectiveFrom = new Date("2026-11-01");

      const version = await prisma.depreciationParameterVersion.create({
        data: {
          vehiclePrice: "750000.00",
          usefulLifeYears: 10,
          estimatedAnnualKm: 22000,
          effectiveFrom,
          createdById: OWN_CREATOR_ID,
        },
      });

      expect(typeof version.estimatedAnnualKm).toBe("number");
      expect(Number.isInteger(version.estimatedAnnualKm)).toBe(true);
      expect(version.estimatedAnnualKm).toBe(22000);
    });

    // -----------------------------------------------------------------------
    // Invariant 5b: DepreciationParameterVersion does NOT have derived fields
    // (D7: derived values are not persisted)
    // -----------------------------------------------------------------------

    it("DepreciationParameterVersion: no derived fields (annualDepreciation / perKmUnitPrice) persisted", async () => {
      const effectiveFrom = new Date("2026-12-01");

      const version = await prisma.depreciationParameterVersion.create({
        data: {
          vehiclePrice: "400000.00",
          usefulLifeYears: 4,
          estimatedAnnualKm: 16000,
          effectiveFrom,
          createdById: OWN_CREATOR_ID,
        },
      });

      // Model must NOT have annualDepreciation or perKmUnitPrice columns
      expect(version).not.toHaveProperty("annualDepreciation");
      expect(version).not.toHaveProperty("perKmUnitPrice");
    });
  }
);
