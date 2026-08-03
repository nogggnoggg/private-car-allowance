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
 *  - AC-07 加總各段總里程且不重複加高速：35.75 精確值，經**真實完成流程**
 *    （`completeTravelApplication`）產生（PHASE-005-R1 M-2 修復——原版直接寫入
 *    `snapshotTotalKm` 字面值為套套邏輯，見下方測試內註解）。
 *  - D2(a) defensive check：全表不存在 status=COMPLETED AND snapshotTotalKm IS
 *    NULL（PHASE-005-R1 M-2 修復——原版僅查自建 id）。
 *  - D3(a) Decimal 保真：10.01 × 3 = 30.03，無浮點失真。
 *  - 同 DB 連跑兩輪全綠（自我修復清理 + 精確範圍隔離的 tripDate 區間）。
 *
 * PHASE-005-R1（期中 Review REQUEST_CHANGES 修復，全部為測試層修復，零 src
 * 變更 — 詳見各測試內的 M-1/M-2/S-1/S-3 標記與說明）：
 *  - M-1① AC-01 四點邊界：dateFrom−1／dateFrom／dateTo／dateTo+1 各一筆
 *    COMPLETED，精確斷言恰納入中間兩筆（`tripDate`，非 `primaryDate`）。
 *  - M-1② AC-02 歸屬日期：primaryDate/createdAt 落區間內但 tripDate 落區間外
 *    → 不納入；反之 → 納入（`$executeRaw` 覆寫 `createdAt`，故意跨月份）。
 *  - M-2 AC-07/AC-13/D2(a) 由套套邏輯改為有鑑別力版本（見上）。
 *  - S-1 AC-33：新增 SQL 文字斷言（`SUM(`/`COUNT(` 皆須在場，不得為
 *    `findMany()+reduce`），查詢數上界收緊為 `toBe(1)`（本實作實測恰 1 次）。
 *  - S-3：於四點邊界測試中加入 `SHOW TimeZone` 明文斷言（UTC/Etc/UTC），把
 *    「起訖含當日語意依賴 DB session TimeZone=UTC」的隱含環境假設變成可失敗
 *    守門（reviewer 實測 Asia/Taipei session 下 dateFrom 當日會被排除——修復
 *    該行為本身需要動 `mileage-range.ts`，超出本回合 Files Allowed 範圍，故
 *    本回合只把假設變得可見，不改變行為）。
 *
 * Test discipline (Spec §11.0 / CLAUDE.md): cleanup scoped to this suite's own
 * synthetic data only (loginName prefix "p5t2_" + tracked application ids);
 * NEVER deleteMany({}) globally. LOGIN_PREFIX 之 SQL LIKE `_` 萬用字元教訓
 * （PHASE-004 R6）：清理一律以追蹤 id 陣列 + JS 字面 startsWith 精確篩選，
 * 不倚賴 Prisma `startsWith` 之 SQL LIKE 語意做權威判定。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeTravelApplication } from "../../src/applications/travel-service.js";

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
  const createdAttachmentIds: string[] = [];
  const createdFuelVersionIds: string[] = [];
  const createdEtcVersionIds: string[] = [];

  async function cleanupSyntheticData() {
    if (createdAttachmentIds.length > 0) {
      await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
    }
    if (createdApplicationIds.length > 0) {
      await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
    }
    if (createdFuelVersionIds.length > 0) {
      await prisma.fuelParameterVersion.deleteMany({
        where: { id: { in: createdFuelVersionIds } },
      });
    }
    if (createdEtcVersionIds.length > 0) {
      await prisma.etcParameterVersion.deleteMany({ where: { id: { in: createdEtcVersionIds } } });
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
  // PHASE-005-R1 M-2 helpers — 真實完成流程（`completeTravelApplication`）所需
  // 之油資/ETC 參數版本與段落附件。年份 2044 為本套件專屬、跨其他 integration
  // 測試檔未使用之年份（FuelParameterVersion/EtcParameterVersion 為全域共用
  // 表，見 phase4-travel-complete.test.ts 檔頭同一教訓）。
  // -----------------------------------------------------------------------

  async function createParamVersions(
    effectiveFrom: string,
    fuelPrice: string,
    etcPrice: string
  ): Promise<{ fuelVersionId: string; etcVersionId: string }> {
    const fuel = await prisma.fuelParameterVersion.create({
      data: {
        unitPrice: fuelPrice,
        effectiveFrom: new Date(effectiveFrom),
        createdById: ownerA.id,
      },
    });
    const etc = await prisma.etcParameterVersion.create({
      data: {
        unitPrice: etcPrice,
        effectiveFrom: new Date(effectiveFrom),
        createdById: ownerA.id,
      },
    });
    createdFuelVersionIds.push(fuel.id);
    createdEtcVersionIds.push(etc.id);
    return { fuelVersionId: fuel.id, etcVersionId: etc.id };
  }

  async function createLinkedAttachment(segmentId: string, forOwnerId: string) {
    const att = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `p5t2-synth-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
        mimeType: "image/jpeg",
        byteSize: 123,
        originalFilename: "synthetic.jpg",
        uploaderId: forOwnerId,
        ownerId: forOwnerId,
        refType: "TRIP_SEGMENT",
        refId: segmentId,
        linkedAt: new Date(),
      },
    });
    createdAttachmentIds.push(att.id);
    return att;
  }

  /**
   * 建立一筆「可被 `completeTravelApplication` 真實完成」的草稿：擁有人、出差
   * 目的、每段皆有起訖地點與一張已連結附件——完整性驗證（AC-52 同一
   * `computeCompletionBlockers`）與參數可用性檢查皆會通過。呼叫方須自行先
   * 呼叫 `createParamVersions`，確保 `tripDate` 落在其 `effectiveFrom` 之後。
   */
  async function createCompletableTravelApplication(opts: {
    ownerId: string;
    primaryDate: string;
    tripDate: string;
    purpose: string;
    segments: Array<{ totalKm: string; highwayKm: string }>;
  }): Promise<string> {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: opts.ownerId,
        createdById: opts.ownerId,
        primaryDate: new Date(opts.primaryDate),
        travel: {
          create: {
            tripDate: new Date(opts.tripDate),
            purpose: opts.purpose,
          },
        },
      },
    });
    createdApplicationIds.push(application.id);

    for (const [i, seg] of opts.segments.entries()) {
      const segment = await prisma.tripSegment.create({
        data: {
          travelApplicationId: application.id,
          sortOrder: i,
          origin: `p5r1-origin-${i}`,
          destination: `p5r1-dest-${i}`,
          totalKm: seg.totalKm,
          highwayKm: seg.highwayKm,
        },
      });
      await createLinkedAttachment(segment.id, opts.ownerId);
    }

    return application.id;
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

  it("sums to exactly 35.75 for a travel whose snapshot reflects segment totals without double-counting highway (PHASE-005-R1 M-2: real completion flow, not a hand-written fixture)", async () => {
    // M-2 修復：原版直接對 `snapshotTotalKm` 寫入字面值 "35.75"，而引擎從不
    // 讀 TripSegment——這使得 35.75 vs 53.75 的鑑別在任何實作下都不可能觸發
    // （寫什麼字面值，讀回來就是什麼，與 sumOfficialMileage 的加總邏輯正確與
    // 否完全無關）。改為透過 `completeTravelApplication`（PHASE-004 生產程式，
    // 非測試自建）真正計算並落地快照，此時 35.75 vs 53.75 的鑑別力才是真實的
    // ——若生產程式誤把 highway 重複相加，這裡會如實得到 53.75 並讓斷言失敗。
    const dateFrom = new Date("2044-07-01");
    const dateTo = new Date("2044-07-10");

    await createParamVersions("2044-01-01", "5.0000", "2.0000");

    // Segments: (10.00, hw 10.00), (5.50, hw 0.00), (20.25, hw 8.00).
    // Σ totalKm = 35.75. Wrong implementations would yield 53.75 (total+hw),
    // 18.00 (hw only), or 17.75 (total-hw) — asserted exactly below.
    const applicationId = await createCompletableTravelApplication({
      ownerId: ownerA.id,
      primaryDate: "2044-07-05",
      tripDate: "2044-07-05",
      purpose: "PHASE-005-R1 M-2 AC-07 真實完成流程鑑別力測試",
      segments: [
        { totalKm: "10.00", highwayKm: "10.00" },
        { totalKm: "5.50", highwayKm: "0.00" },
        { totalKm: "20.25", highwayKm: "8.00" },
      ],
    });

    const completed = await completeTravelApplication(prisma, applicationId);
    expect(completed.status).toBe("COMPLETED");

    // DB round-trip: the snapshot really is 35.75, computed by production
    // code — not authored by this test.
    const dbTravel = await prisma.travelApplication.findUniqueOrThrow({
      where: { applicationId },
    });
    expect(dbTravel.snapshotTotalKm?.toString()).toBe("35.75");

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

  it("invariant (PHASE-005-R1 M-2, global): no COMPLETED travel application in this schema has a null snapshotTotalKm", async () => {
    // M-2 修復：原版以 `id: { in: createdApplicationIds }` 限定，只查自建
    // 列——本套件自建的 COMPLETED 列本就全部手動寫入 snapshotTotalKm，這條
    // 斷言在任何實作下都不可能失敗。改為不限定 id 的全表掃描；per-worker
    // schema 隔離 + 本檔 setupFiles 之 per-file TRUNCATE（見 vitest.config.ts
    // INFRA-001 註解）保證本檔執行期間，這個 schema 內只有本檔自己的資料，
    // 全表掃描不會誤觸其他測試檔的殘留列。
    const offenders = await prisma.application.findMany({
      where: {
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

  it("AC-13 (PHASE-005-R1 M-2, global invariant scan): every segment-bearing COMPLETED travel in this schema has snapshotTotalKm == Σ TripSegment.totalKm", async () => {
    // M-2 修復：原版對「自建一列、寫入的快照與寫入的段落」做比較——快照
    // 字面值與段落字面值皆由同一個 `sumDecimalStrings` 呼叫產生、寫入同一個
    // helper，這只證明「DB 寫入什麼、讀回來就是什麼」的 round-trip，並未驗證
    // 「快照是否真的等於段落之和」這件事本身（快照從未經由計算得出）。改為
    // 不限定 id 的全表不變式掃描：涵蓋本檔目前為止所有測試建立的 COMPLETED
    // 列，包含上面 AC-07 測試中「經 `completeTravelApplication` 真實計算」
    // 的那一筆——只有這一筆的快照是生產程式算出來的，其餘本檔測試建立的
    // COMPLETED 列多數無段落（0 段，見下方 skip 理由）。per-worker schema
    // 隔離保證全表掃描不誤觸其他測試檔的資料（同上一測試理由）。
    const completedTravels = await prisma.travelApplication.findMany({
      where: { application: { status: "COMPLETED" } },
      include: { segments: true },
    });

    // Sanity: 若這裡是空陣列，代表掃描範圍本身有問題（例如查詢寫錯、schema
    // 隔離失效），而非「不變式碰巧成立」。
    expect(completedTravels.length).toBeGreaterThan(0);

    let checkedWithSegments = 0;
    for (const travel of completedTravels) {
      if (travel.segments.length === 0) {
        // B-15（Spec §16）：本檔多數 COMPLETED fixture 為測試其他 AC（狀態
        // 過濾、擁有人隔離等）以 `createTravelApplication` 直接寫入
        // snapshotTotalKm、不建立真實段落——這是已知的測試捷徑，不是「0 段
        // 異常資料」，此不變式僅對「確實有段落」的列有意義，故略過。
        continue;
      }
      checkedWithSegments++;
      const segmentSum = sumDecimalStrings(
        travel.segments.map((s) => s.totalKm?.toString() ?? "0")
      );
      expect(travel.snapshotTotalKm?.toString()).toBe(segmentSum);
    }

    // Sanity: 至少要有一筆「有段落」的列被實際檢查過（否則上面的迴圈是空轉，
    // 不變式從未被真正驗證）。
    expect(checkedWithSegments).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // AC-33 — 聚合於 DB 層完成（查詢數常數斷言：3 筆與 101 筆情境同查詢數）
  // -----------------------------------------------------------------------

  it("AC-33: aggregation runs in a constant number of SQL queries, independent of row count (3 vs 101), and is a real SQL SUM/COUNT — not findMany()+reduce (PHASE-005-R1 S-1)", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const countingClient = new PrismaClient({
      datasources: { db: { url: DB_URL } },
      log: [{ level: "query", emit: "event" }],
    });
    await countingClient.$connect();

    // S-1 修復：原版只數查詢「次數」——`findMany()` 讀出命中集合再於 JS 端
    // `reduce()` 加總，同樣恰好是 1 次 SQL 查詢，會被原本的次數斷言誤判為
    // 通過（AC-33 真正要求的是「聚合在 DB 層完成」，不是「只發一次查詢」）。
    // 改為額外收集每次查詢的 SQL 文字，斷言其中含真正的 `SUM(`/`COUNT(`
    // 聚合函式——`findMany()` 產生的 SQL 不會有這兩個關鍵字。
    const queryTexts: string[] = [];
    let queryCount = 0;
    countingClient.$on("query", (e: { query: string }) => {
      queryCount++;
      queryTexts.push(e.query);
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
      queryTexts.length = 0;
      const smallResult = await sumOfficialMileage(countingClient, {
        ownerId: ownerA.id,
        dateFrom: smallFrom,
        dateTo: smallTo,
      });
      const smallQueryCount = queryCount;
      const smallQueryTexts = [...queryTexts];

      queryCount = 0;
      queryTexts.length = 0;
      const largeResult = await sumOfficialMileage(countingClient, {
        ownerId: ownerA.id,
        dateFrom: largeFrom,
        dateTo: largeTo,
      });
      const largeQueryCount = queryCount;
      const largeQueryTexts = [...queryTexts];

      expect(smallResult.applicationCount).toBe(3);
      expect(largeResult.applicationCount).toBe(101);

      // 常數（不隨資料筆數增長）：3 筆與 101 筆情境的查詢數必須相等，且恰為
      // 1（S-1 修復：本實作實測恰 1 次 SQL，收緊上界，不再留 ≤2 的模糊空間）。
      expect(smallQueryCount).toBe(1);
      expect(largeQueryCount).toBe(smallQueryCount);

      // S-1 修復核心：查詢文字須含真正的 SQL SUM(/COUNT( 聚合函式——
      // `findMany()+reduce()` 產生的 SQL 絕不會含這兩個關鍵字，即使查詢次數
      // 同樣恰為 1 也會在這裡被鑑別出來。
      const smallCombined = smallQueryTexts.join("\n");
      const largeCombined = largeQueryTexts.join("\n");
      expect(smallCombined).toMatch(/\bSUM\(/i);
      expect(smallCombined).toMatch(/\bCOUNT\(/i);
      expect(largeCombined).toMatch(/\bSUM\(/i);
      expect(largeCombined).toMatch(/\bCOUNT\(/i);
    } finally {
      await countingClient.$disconnect();
    }
  });

  // ===========================================================================
  // PHASE-005-R1 M-1 — AC-01 四點邊界 + AC-02 歸屬日期（tripDate vs
  // primaryDate/createdAt）+ S-3 TimeZone 守門
  //
  // Review 原文：現況整合層無法分辨「以 `Application.primaryDate` 過濾」與
  // 「以 `TravelApplication.tripDate` 過濾」（既有 fixture 之 primaryDate 恆等於
  // tripDate），亦無 off-by-one 行為斷言。下方兩組測試補上這兩項鑑別力。
  // ===========================================================================

  describe("M-1① — AC-01 四點邊界（tripDate 精確 gte/lte，非近似值）", () => {
    it("dateFrom−1／dateTo+1 不納入；dateFrom／dateTo 精確納入（bit-exact）", async () => {
      // S-3 守門：起訖含當日語意（AC-01/02）的 gte/lte 比較，實際上依賴 DB
      // session 之 TimeZone=UTC（reviewer 實測：Asia/Taipei session 下
      // `travel.tripDate >= dateFrom` 之 timestamptz 比較會把 dateFrom 當日排
      // 除，見檔頭 S-3 說明）。把這個隱含環境假設變成一條明文、可失敗的守
      // 門——若未來測試/部署環境的 DB session TimeZone 漂移離開 UTC，先在這裡
      // 失敗，而不是讓下面的邊界斷言以令人困惑的 off-by-one 面貌失敗。
      const tzRows = await prisma.$queryRawUnsafe("SHOW TimeZone");
      const sessionTimeZone = tzRows[0]?.TimeZone;
      expect(["UTC", "Etc/UTC"]).toContain(sessionTimeZone);

      const dateFrom = new Date("2045-01-10");
      const dateTo = new Date("2045-01-20");

      await createTravelApplication({
        ownerId: ownerA.id,
        createdById: ownerA.id,
        status: "COMPLETED",
        primaryDate: "2045-01-09",
        tripDate: "2045-01-09", // dateFrom − 1 日
        snapshotTotalKm: "901.00",
      });
      await createTravelApplication({
        ownerId: ownerA.id,
        createdById: ownerA.id,
        status: "COMPLETED",
        primaryDate: "2045-01-10",
        tripDate: "2045-01-10", // dateFrom 當日
        snapshotTotalKm: "10.00",
      });
      await createTravelApplication({
        ownerId: ownerA.id,
        createdById: ownerA.id,
        status: "COMPLETED",
        primaryDate: "2045-01-20",
        tripDate: "2045-01-20", // dateTo 當日
        snapshotTotalKm: "20.00",
      });
      await createTravelApplication({
        ownerId: ownerA.id,
        createdById: ownerA.id,
        status: "COMPLETED",
        primaryDate: "2045-01-21",
        tripDate: "2045-01-21", // dateTo + 1 日
        snapshotTotalKm: "902.00",
      });

      const result = await sumOfficialMileage(prisma, { ownerId: ownerA.id, dateFrom, dateTo });

      // 精確值斷言（非「> 0」之類的近似）：恰納入中間兩筆 10.00+20.00=30.00。
      // 邊界外兩筆（901.00/902.00）刻意取遠大於 30 的值——若任一筆被誤納
      // 入，結果會明顯偏離 30，鑑別力充分；若兩筆都被誤納入，applicationCount
      // 亦會偏離 2。
      expect(result.totalKm.toString()).toBe("30");
      expect(result.applicationCount).toBe(2);
    });
  });

  describe("M-1② — AC-02 依「出差日期」歸屬區間（非 Application.primaryDate/createdAt）", () => {
    it("primaryDate/createdAt 落區間內、tripDate 落區間外（刻意跨月份）→ 不納入", async () => {
      const dateFrom = new Date("2045-06-01");
      const dateTo = new Date("2045-06-10");

      const application = await createTravelApplication({
        ownerId: ownerA.id,
        createdById: ownerA.id,
        status: "COMPLETED",
        primaryDate: "2045-06-05", // 落區間內
        tripDate: "2045-09-05", // 刻意落在不同月份、區間外
        snapshotTotalKm: "77.00",
      });
      // `createdAt` 為 `@default(now())`，測試執行當下必然落在 2045-06 之
      // 外；為了明確驗證「即使 createdAt 落區間內也不納入」（而非僅是「剛好
      // 沒落在區間內」的巧合），以 `$executeRaw` 明確覆寫成落區間內的值。
      await prisma.$executeRaw`UPDATE "Application" SET "createdAt" = ${new Date(
        "2045-06-05T00:00:00.000Z"
      )} WHERE id = ${application.id}`;

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
      expect(dbApp.createdAt.getUTCFullYear()).toBe(2045);
      expect(dbApp.createdAt.getUTCMonth()).toBe(5); // 0-indexed：6 月

      const result = await sumOfficialMileage(prisma, { ownerId: ownerA.id, dateFrom, dateTo });

      expect(result.totalKm.toString()).toBe("0");
      expect(result.applicationCount).toBe(0);
    });

    it("tripDate 落區間內、primaryDate/createdAt 落區間外（刻意跨月份）→ 納入", async () => {
      const dateFrom = new Date("2045-07-01");
      const dateTo = new Date("2045-07-10");

      const application = await createTravelApplication({
        ownerId: ownerA.id,
        createdById: ownerA.id,
        status: "COMPLETED",
        primaryDate: "2045-10-05", // 刻意落在不同月份、區間外
        tripDate: "2045-07-05", // 落區間內
        snapshotTotalKm: "88.00",
      });
      await prisma.$executeRaw`UPDATE "Application" SET "createdAt" = ${new Date(
        "2045-10-05T00:00:00.000Z"
      )} WHERE id = ${application.id}`;

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
      expect(dbApp.createdAt.getUTCMonth()).toBe(9); // 0-indexed：10 月，區間外

      const result = await sumOfficialMileage(prisma, { ownerId: ownerA.id, dateFrom, dateTo });

      expect(result.totalKm.toString()).toBe("88");
      expect(result.applicationCount).toBe(1);
    });
  });
});
