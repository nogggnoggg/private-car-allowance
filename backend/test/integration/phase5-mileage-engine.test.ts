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

/**
 * PHASE-005-T3 — 純字串十進位加總（無浮點中介，D3(a) 精神延伸至測試斷言）。
 * 只處理最多 2 位小數的字串（本檔全部固定金額語意值），以「分」為整數單位累加
 * 再格式化回字串，並比照 `decimal.js`（Prisma `Decimal` 內部使用）預設
 * `toString()` 慣例去除小數尾端多餘的 0（見既有測試 "10.00" → "10"）。
 */
function sumDecimalStrings(values: string[]): string {
  const totalCents = values.reduce((acc, raw) => {
    const [intPartRaw, fracPartRaw = ""] = raw.split(".");
    const negative = intPartRaw.startsWith("-");
    const intAbs = intPartRaw.replace("-", "");
    const frac = `${fracPartRaw}00`.slice(0, 2);
    const cents = Number(intAbs) * 100 + Number(frac);
    return acc + (negative ? -cents : cents);
  }, 0);

  const negative = totalCents < 0;
  const abs = Math.abs(totalCents);
  const intPart = Math.floor(abs / 100);
  const fracPart = String(abs % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fracPart.length > 0 ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

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

  // ===========================================================================
  // PHASE-005-T3 — 引擎完整性與複用介面
  // ===========================================================================

  // -----------------------------------------------------------------------
  // AC-09 — 無有效差旅回 0（四情境：空／僅草稿／僅作廢／僅他人或非差旅）
  // -----------------------------------------------------------------------

  it("AC-09(a): empty range with zero applications returns Decimal 0 / count 0", async () => {
    const result = await sumOfficialMileage(prisma, {
      ownerId: ownerA.id,
      dateFrom: new Date("2026-11-01"),
      dateTo: new Date("2026-11-10"),
    });

    expect(result.totalKm.toString()).toBe("0");
    expect(result.applicationCount).toBe(0);
  });

  it("AC-09(b): only a DRAFT travel exists in range — still returns Decimal 0 / count 0", async () => {
    const dateFrom = new Date("2026-11-11");
    const dateTo = new Date("2026-11-20");

    await createTravelApplication({
      ownerId: ownerA.id,
      createdById: ownerA.id,
      status: "DRAFT",
      primaryDate: "2026-11-15",
      tripDate: "2026-11-15",
      snapshotTotalKm: "500.00",
    });

    const result = await sumOfficialMileage(prisma, { ownerId: ownerA.id, dateFrom, dateTo });

    expect(result.totalKm.toString()).toBe("0");
    expect(result.applicationCount).toBe(0);
  });

  it("AC-09(c): only a VOIDED travel exists in range — still returns Decimal 0 / count 0", async () => {
    const dateFrom = new Date("2026-11-21");
    const dateTo = new Date("2026-11-30");

    await createTravelApplication({
      ownerId: ownerA.id,
      createdById: ownerA.id,
      status: "VOIDED",
      primaryDate: "2026-11-25",
      tripDate: "2026-11-25",
      snapshotTotalKm: "600.00",
    });

    const result = await sumOfficialMileage(prisma, { ownerId: ownerA.id, dateFrom, dateTo });

    expect(result.totalKm.toString()).toBe("0");
    expect(result.applicationCount).toBe(0);
  });

  it("AC-09(d): only another owner's travel and only a non-travel type exist for ownerA — Decimal 0 / count 0", async () => {
    const dateFrom = new Date("2026-12-01");
    const dateTo = new Date("2026-12-10");

    // 他人（ownerB）之已完成差旅——絕不可外洩進 ownerA 的統計。
    await createTravelApplication({
      ownerId: ownerB.id,
      createdById: ownerB.id,
      status: "COMPLETED",
      primaryDate: "2026-12-05",
      tripDate: "2026-12-05",
      snapshotTotalKm: "700.00",
    });
    // ownerA 本人之列，但非差旅類型——無 TravelApplication 子列。
    await createTravelApplication({
      ownerId: ownerA.id,
      createdById: ownerA.id,
      type: "MAINTENANCE",
      status: "COMPLETED",
      primaryDate: "2026-12-06",
    });

    const result = await sumOfficialMileage(prisma, { ownerId: ownerA.id, dateFrom, dateTo });

    expect(result.totalKm.toString()).toBe("0");
    expect(result.applicationCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // AC-10 — 統計涵蓋完整區間，非單頁（101 筆 > PAGE_SIZE_MAX=100）
  // -----------------------------------------------------------------------

  it("AC-10: sums the FULL range across 101 distinct-valued COMPLETED travels (> PAGE_SIZE_MAX)", async () => {
    const dateFrom = new Date("2026-09-01");
    const dateTo = new Date("2026-09-10");
    const ROWS = 101;

    const values: string[] = [];
    const applicationRows: Array<Record<string, unknown>> = [];
    const travelRows: Array<Record<string, unknown>> = [];

    for (let i = 1; i <= ROWS; i++) {
      const id = `p5t3_ac10_${RUN_ID}_${i}`;
      // 第 i 筆 totalKm = 1.00 + i × 0.01（i=1..101）：101 個互異值，鑑別「取
      // 子集」的錯誤實作。
      const cents = 100 + i;
      const value = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
      values.push(value);
      createdApplicationIds.push(id);

      applicationRows.push({
        id,
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: ownerA.id,
        createdById: ownerA.id,
        primaryDate: new Date("2026-09-05"),
      });
      travelRows.push({
        applicationId: id,
        tripDate: new Date("2026-09-05"),
        snapshotTotalKm: value,
      });
    }

    // 批次寫入（createMany）：避免 101 筆逐筆 create 拖慢測試。
    await prisma.application.createMany({ data: applicationRows });
    await prisma.travelApplication.createMany({ data: travelRows });

    const expectedSum = sumDecimalStrings(values);
    expect(expectedSum).toBe("152.51"); // 對 fixture 自身數學的獨立校驗

    const result = await sumOfficialMileage(prisma, { ownerId: ownerA.id, dateFrom, dateTo });

    expect(result.applicationCount).toBe(ROWS);
    expect(result.totalKm.toString()).toBe(expectedSum);
  });

  // -----------------------------------------------------------------------
  // AC-12 — 可複用、可於交易內呼叫之唯讀介面
  // -----------------------------------------------------------------------

  it("AC-12: runs correctly inside prisma.$transaction and performs zero writes", async () => {
    const dateFrom = new Date("2026-10-01");
    const dateTo = new Date("2026-10-10");

    await createTravelApplication({
      ownerId: ownerA.id,
      createdById: ownerA.id,
      status: "COMPLETED",
      primaryDate: "2026-10-05",
      tripDate: "2026-10-05",
      snapshotTotalKm: "42.00",
    });

    const countBefore = await prisma.application.count();

    const txResult = await prisma.$transaction(
      // biome-ignore lint/suspicious/noExplicitAny: tx client, dynamic import
      async (tx: any) => sumOfficialMileage(tx, { ownerId: ownerA.id, dateFrom, dateTo })
    );

    const countAfter = await prisma.application.count();

    expect(txResult.totalKm.toString()).toBe("42");
    expect(txResult.applicationCount).toBe(1);
    // 唯讀：交易前後資料列數（全域，非僅本情境）零變化；不自行開啟巢狀交易
    // （若有，`prisma.$transaction` 回呼本身即已正常完成、未拋出巢狀交易錯誤）。
    expect(countAfter).toBe(countBefore);
  });

  // -----------------------------------------------------------------------
  // AC-13 — 快照與段加總一致性不變式
  // -----------------------------------------------------------------------

  it("AC-13: snapshotTotalKm equals the exact sum of TripSegment.totalKm for a multi-segment COMPLETED travel", async () => {
    const segments = [
      { totalKm: "12.34", highwayKm: "0.00" },
      { totalKm: "7.66", highwayKm: "1.00" },
      { totalKm: "0.50", highwayKm: "0.00" },
    ];
    const expectedSnapshot = sumDecimalStrings(segments.map((s) => s.totalKm));
    expect(expectedSnapshot).toBe("20.5");

    const application = await createTravelApplication({
      ownerId: ownerA.id,
      createdById: ownerA.id,
      status: "COMPLETED",
      primaryDate: "2026-12-15",
      tripDate: "2026-12-15",
      snapshotTotalKm: expectedSnapshot,
      segments,
    });

    const fetched = await prisma.travelApplication.findUniqueOrThrow({
      where: { applicationId: application.id },
      include: { segments: true },
    });

    const segmentSum = sumDecimalStrings(
      // biome-ignore lint/suspicious/noExplicitAny: dynamic Prisma model shape
      fetched.segments.map((s: any) => s.totalKm.toString())
    );

    expect(fetched.snapshotTotalKm?.toString()).toBe(expectedSnapshot);
    expect(segmentSum).toBe(fetched.snapshotTotalKm?.toString());
  });

  // -----------------------------------------------------------------------
  // AC-33 — 聚合於 DB 層完成（查詢數常數斷言：3 筆與 101 筆情境同查詢數）
  // -----------------------------------------------------------------------

  it("AC-33: aggregation runs in a constant number of SQL queries, independent of row count (3 vs 101)", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const countingClient = new PrismaClient({
      datasources: { db: { url: DB_URL } },
      log: [{ level: "query", emit: "event" }],
    });
    await countingClient.$connect();

    let queryCount = 0;
    countingClient.$on("query", () => {
      queryCount++;
    });

    try {
      // 小情境：3 筆。
      const smallFrom = new Date("2027-01-01");
      const smallTo = new Date("2027-01-10");
      for (const day of ["03", "04", "05"]) {
        await createTravelApplication({
          ownerId: ownerA.id,
          createdById: ownerA.id,
          status: "COMPLETED",
          primaryDate: `2027-01-${day}`,
          tripDate: `2027-01-${day}`,
          snapshotTotalKm: "1.00",
        });
      }

      // 大情境：101 筆（批次寫入）。
      const largeFrom = new Date("2027-02-01");
      const largeTo = new Date("2027-02-10");
      const applicationRows: Array<Record<string, unknown>> = [];
      const travelRows: Array<Record<string, unknown>> = [];
      for (let i = 1; i <= 101; i++) {
        const id = `p5t3_ac33_${RUN_ID}_${i}`;
        createdApplicationIds.push(id);
        applicationRows.push({
          id,
          type: "TRAVEL",
          status: "COMPLETED",
          ownerId: ownerA.id,
          createdById: ownerA.id,
          primaryDate: new Date("2027-02-05"),
        });
        travelRows.push({
          applicationId: id,
          tripDate: new Date("2027-02-05"),
          snapshotTotalKm: "1.00",
        });
      }
      await prisma.application.createMany({ data: applicationRows });
      await prisma.travelApplication.createMany({ data: travelRows });

      queryCount = 0;
      const smallResult = await sumOfficialMileage(countingClient, {
        ownerId: ownerA.id,
        dateFrom: smallFrom,
        dateTo: smallTo,
      });
      const smallQueryCount = queryCount;

      queryCount = 0;
      const largeResult = await sumOfficialMileage(countingClient, {
        ownerId: ownerA.id,
        dateFrom: largeFrom,
        dateTo: largeTo,
      });
      const largeQueryCount = queryCount;

      expect(smallResult.applicationCount).toBe(3);
      expect(largeResult.applicationCount).toBe(101);

      // 常數（不隨資料筆數增長）：3 筆與 101 筆情境的查詢數必須相等，且為一
      // 個小常數（單一 `aggregate()` 實作應為 1）。
      expect(smallQueryCount).toBeGreaterThan(0);
      expect(smallQueryCount).toBeLessThanOrEqual(2);
      expect(largeQueryCount).toBe(smallQueryCount);
    } finally {
      await countingClient.$disconnect();
    }
  });
});
