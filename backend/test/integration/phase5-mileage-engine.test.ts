/**
 * Integration test: PHASE-005-T2 — `sumOfficialMileage` DB 聚合引擎
 * TDD: written BEFORE `mileage-engine.ts` exists; expected to fail first.
 *
 * Requires a running Postgres instance with migrations already applied.
 * If DATABASE_URL is not set, tests are skipped with an explanatory message.
 *
 * Covers Spec §15 T2 Done When + AC-03/04/05/06/07（docs/specs/PHASE-005.md）：
 *  - AC-03 僅計已完成：同區間 DRAFT（含已填里程）不計入。
 *  - AC-04 排除已作廢：VOIDED 不計入（鑑別 `status != 'DRAFT'` 誤植）。
 *  - Done When 反向斷言組：DRAFT 999.00 + VOIDED 888.00 併存 → 結果恰 10.00。
 *  - AC-05 僅計差旅類型：MAINTENANCE/DEPRECIATION（無子表）不計入，且不拋錯。
 *  - AC-06 僅計指定擁有人：A/B 隔離，含 B 由代操作（createdBy=admin）建立之情境。
 *  - AC-07 加總各段總里程且不重複加高速：35.75 精確值（數值鑑別）。
 *  - D2(a) defensive check：不存在 status=COMPLETED AND snapshotTotalKm IS NULL。
 *  - D3(a) Decimal 保真：10.01 × 3 = 30.03，無浮點失真。
 *  - 同 DB 連跑兩輪全綠（自我修復清理 + 精確範圍隔離的 tripDate 區間）。
 *
 * Test discipline (Spec §11.0 / CLAUDE.md): cleanup scoped to this suite's own
 * synthetic data only (loginName prefix "p5t2_" + tracked application ids);
 * NEVER deleteMany({}) globally. LOGIN_PREFIX 之 SQL LIKE `_` 萬用字元教訓
 * （PHASE-004 R6）：清理一律以追蹤 id 陣列 + JS 字面 startsWith 精確篩選，
 * 不倚賴 Prisma `startsWith` 之 SQL LIKE 語意做權威判定。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.DATABASE_URL;

const describeWithDb = DB_URL ? describe : describe.skip;

const LOGIN_PREFIX = "p5t2_";
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

describeWithDb("PHASE-005-T2 — sumOfficialMileage", () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import for test isolation
  let prisma: any;
  // biome-ignore lint/suspicious/noExplicitAny: module under test, dynamic import
  let sumOfficialMileage: any;
  let ownerA: { id: string };
  let ownerB: { id: string };
  let admin: { id: string };

  const createdApplicationIds: string[] = [];
  const createdUserIds: string[] = [];

  async function cleanupSyntheticData() {
    if (createdApplicationIds.length > 0) {
      await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
    }

    // Over-broad, SQL-LIKE-safe pre-filter bound (no literal "_" reached yet),
    // narrowed by exact JS `.startsWith()` before deleting — see file header.
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
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    ({ sumOfficialMileage } = await import("../../src/mileage/mileage-engine.js"));

    // Self-healing: remove any residual rows from previous failed runs.
    await cleanupSyntheticData();

    ownerA = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}ownera_${RUN_ID}`,
        displayName: "P5T2 Owner A",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
      },
    });
    createdUserIds.push(ownerA.id);
    ownerB = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}ownerb_${RUN_ID}`,
        displayName: "P5T2 Owner B",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
      },
    });
    createdUserIds.push(ownerB.id);
    admin = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}admin_${RUN_ID}`,
        displayName: "P5T2 Admin",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
        role: "ADMIN",
      },
    });
    createdUserIds.push(admin.id);
  });

  afterAll(async () => {
    if (prisma) {
      await cleanupSyntheticData();
      await prisma.$disconnect();
    }
  });

  async function createTravelApplication(opts: {
    ownerId: string;
    createdById: string;
    type?: "TRAVEL" | "MAINTENANCE" | "DEPRECIATION";
    status: "DRAFT" | "COMPLETED" | "VOIDED";
    primaryDate: string;
    tripDate?: string;
    snapshotTotalKm?: string;
    segments?: Array<{ totalKm: string; highwayKm: string }>;
  }) {
    const type = opts.type ?? "TRAVEL";
    const hasTravel = type === "TRAVEL";
    const application = await prisma.application.create({
      data: {
        type,
        status: opts.status,
        ownerId: opts.ownerId,
        createdById: opts.createdById,
        primaryDate: new Date(opts.primaryDate),
        ...(hasTravel
          ? {
              travel: {
                create: {
                  tripDate: opts.tripDate ? new Date(opts.tripDate) : undefined,
                  snapshotTotalKm: opts.snapshotTotalKm ?? undefined,
                },
              },
            }
          : {}),
      },
      include: { travel: true },
    });
    createdApplicationIds.push(application.id);

    if (hasTravel && opts.segments) {
      for (const [i, seg] of opts.segments.entries()) {
        await prisma.tripSegment.create({
          data: {
            travelApplicationId: application.id,
            sortOrder: i,
            totalKm: seg.totalKm,
            highwayKm: seg.highwayKm,
          },
        });
      }
    }

    return application;
  }

  // -----------------------------------------------------------------------
  // AC-03 / AC-04 / Done-When 反向斷言組
  // -----------------------------------------------------------------------

  it("counts only COMPLETED travel; DRAFT and VOIDED are fully excluded (reverse assertion, bit-exact)", async () => {
    const dateFrom = new Date("2026-05-01");
    const dateTo = new Date("2026-05-10");

    await createTravelApplication({
      ownerId: ownerA.id,
      createdById: ownerA.id,
      status: "COMPLETED",
      primaryDate: "2026-05-05",
      tripDate: "2026-05-05",
      snapshotTotalKm: "10.00",
    });

    const baseline = await sumOfficialMileage(prisma, { ownerId: ownerA.id, dateFrom, dateTo });
    expect(baseline.totalKm.toString()).toBe("10");
    expect(baseline.applicationCount).toBe(1);

    // Add a DRAFT with filled-in mileage (AC-03) and a VOIDED row (AC-04) in
    // the very same range. Both must be completely inert.
    await createTravelApplication({
      ownerId: ownerA.id,
      createdById: ownerA.id,
      status: "DRAFT",
      primaryDate: "2026-05-06",
      tripDate: "2026-05-06",
      snapshotTotalKm: "999.00",
    });
    await createTravelApplication({
      ownerId: ownerA.id,
      createdById: ownerA.id,
      status: "VOIDED",
      primaryDate: "2026-05-07",
      tripDate: "2026-05-07",
      snapshotTotalKm: "888.00",
    });

    const afterNoise = await sumOfficialMileage(prisma, { ownerId: ownerA.id, dateFrom, dateTo });

    // Done When: 999.00 + 888.00 併存下結果恰 10.00.
    expect(afterNoise.totalKm.toString()).toBe("10");
    expect(afterNoise.applicationCount).toBe(1);
    // Reverse assertion: bit-exact identical to the pre-noise baseline.
    expect(afterNoise.totalKm.toString()).toBe(baseline.totalKm.toString());
    expect(afterNoise.applicationCount).toBe(baseline.applicationCount);
  });

  // -----------------------------------------------------------------------
  // AC-05 僅計差旅類型
  // -----------------------------------------------------------------------

  it("excludes MAINTENANCE / DEPRECIATION applications without throwing (no travel sub-table)", async () => {
    const dateFrom = new Date("2026-05-01");
    const dateTo = new Date("2026-05-10");

    // Same range as the AC-03/04 case above — proves the noise does not
    // change the result and confirms cross-scenario isolation by ownerId
    // is not what's protecting this assertion (same owner, same range).
    await createTravelApplication({
      ownerId: ownerA.id,
      createdById: ownerA.id,
      type: "MAINTENANCE",
      status: "COMPLETED",
      primaryDate: "2026-05-08",
    });
    await createTravelApplication({
      ownerId: ownerA.id,
      createdById: ownerA.id,
      type: "DEPRECIATION",
      status: "COMPLETED",
      primaryDate: "2026-05-09",
    });

    const call = () => sumOfficialMileage(prisma, { ownerId: ownerA.id, dateFrom, dateTo });
    await expect(call()).resolves.not.toThrow();
    const result = await call();

    // ownerA in this range also has the 10.00 COMPLETED TRAVEL row from the
    // previous test (same suite run) — MAINTENANCE/DEPRECIATION must not add
    // to it.
    expect(result.totalKm.toString()).toBe("10");
    expect(result.applicationCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // AC-06 僅計指定擁有人
  // -----------------------------------------------------------------------

  it("isolates by ownerId — B's mileage (including on-behalf-created) never leaks into A's total", async () => {
    const dateFrom = new Date("2026-06-01");
    const dateTo = new Date("2026-06-10");

    await createTravelApplication({
      ownerId: ownerA.id,
      createdById: ownerA.id,
      status: "COMPLETED",
      primaryDate: "2026-06-05",
      tripDate: "2026-06-05",
      snapshotTotalKm: "15.00",
    });
    // B's application created on-behalf by admin — owner is still B.
    await createTravelApplication({
      ownerId: ownerB.id,
      createdById: admin.id,
      status: "COMPLETED",
      primaryDate: "2026-06-05",
      tripDate: "2026-06-05",
      snapshotTotalKm: "777.00",
    });

    const resultA = await sumOfficialMileage(prisma, { ownerId: ownerA.id, dateFrom, dateTo });
    const resultB = await sumOfficialMileage(prisma, { ownerId: ownerB.id, dateFrom, dateTo });

    expect(resultA.totalKm.toString()).toBe("15");
    expect(resultA.applicationCount).toBe(1);
    expect(resultB.totalKm.toString()).toBe("777");
    expect(resultB.applicationCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // AC-07 加總各段總里程且不重複加高速（35.75 數值鑑別）
  // -----------------------------------------------------------------------

  it("sums to exactly 35.75 for a travel whose snapshot reflects segment totals without double-counting highway", async () => {
    const dateFrom = new Date("2026-07-01");
    const dateTo = new Date("2026-07-10");

    // Segments: (10.00, hw 10.00), (5.50, hw 0.00), (20.25, hw 8.00).
    // Σ totalKm = 35.75. Wrong implementations would yield 53.75 (total+hw),
    // 18.00 (hw only), or 17.75 (total-hw) — asserted exactly below.
    const segments = [
      { totalKm: "10.00", highwayKm: "10.00" },
      { totalKm: "5.50", highwayKm: "0.00" },
      { totalKm: "20.25", highwayKm: "8.00" },
    ];

    await createTravelApplication({
      ownerId: ownerA.id,
      createdById: ownerA.id,
      status: "COMPLETED",
      primaryDate: "2026-07-05",
      tripDate: "2026-07-05",
      // D2(a): 聚合來源為快照，測試依 AC-50 語意（完成時 snapshotTotalKm =
      // Σ 各段 totalKm）自行寫入該值。
      snapshotTotalKm: "35.75",
      segments,
    });

    const result = await sumOfficialMileage(prisma, { ownerId: ownerA.id, dateFrom, dateTo });

    expect(result.totalKm.toString()).toBe("35.75");
    expect(result.totalKm.toString()).not.toBe("53.75");
    expect(result.totalKm.toString()).not.toBe("18");
    expect(result.totalKm.toString()).not.toBe("17.75");
    expect(result.applicationCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // D3(a) Decimal 保真：10.01 × 3 = 30.03，無浮點失真
  // -----------------------------------------------------------------------

  it("preserves decimal precision across multiple rows: 10.01 + 10.01 + 10.01 = 30.03 exactly", async () => {
    const dateFrom = new Date("2026-08-01");
    const dateTo = new Date("2026-08-10");

    for (const day of ["03", "04", "05"]) {
      await createTravelApplication({
        ownerId: ownerA.id,
        createdById: ownerA.id,
        status: "COMPLETED",
        primaryDate: `2026-08-${day}`,
        tripDate: `2026-08-${day}`,
        snapshotTotalKm: "10.01",
      });
    }

    const result = await sumOfficialMileage(prisma, { ownerId: ownerA.id, dateFrom, dateTo });

    expect(result.totalKm.toString()).toBe("30.03");
    expect(result.applicationCount).toBe(3);
  });

  // -----------------------------------------------------------------------
  // D2(a) defensive check — 不存在 status=COMPLETED AND snapshotTotalKm IS NULL
  // -----------------------------------------------------------------------

  it("invariant: no COMPLETED travel application created by this suite has a null snapshotTotalKm", async () => {
    const offenders = await prisma.application.findMany({
      where: {
        id: { in: createdApplicationIds },
        type: "TRAVEL",
        status: "COMPLETED",
        travel: { snapshotTotalKm: null },
      },
      select: { id: true },
    });

    expect(offenders).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // 同 DB 連跑兩輪 — 空區間回傳 0 且不拋錯（無殘留列時亦成立）
  // -----------------------------------------------------------------------

  it("returns totalKm 0 and applicationCount 0 for a range with no matching rows", async () => {
    const result = await sumOfficialMileage(prisma, {
      ownerId: ownerA.id,
      dateFrom: new Date("2099-01-01"),
      dateTo: new Date("2099-01-31"),
    });

    expect(result.totalKm.toString()).toBe("0");
    expect(result.applicationCount).toBe(0);
  });
});
