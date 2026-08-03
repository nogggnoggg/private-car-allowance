/**
 * Integration tests for PHASE-005a-T7:
 *   `resolveTravelParameters` 改造（擁有人油耗 → 該油種油價 雙鏈解析）＋
 *   缺參數區分（AC-21/22）＋代操作（AC-23）＋ `POST /applications/travel/preview`
 *   之可選 `ownerId`（§16 D6(a)）。
 *
 * Spec §2.A AC-04、§2.D AC-21/22/23、§7.4、§9.2 Data Flow、§16 D4(a)/D5(a)/D6(a)。
 *
 * TDD: written BEFORE `travel-parameters.ts`/`completion-blockers.ts`/
 * `travel-service.ts`/`routes.ts` 之 PHASE-005a-T7 改造存在——第一次執行預期
 * RED（新模型解析尚未接線／`resolveTravelParameters` 簽章尚未接受 `ownerId`）。
 * 見 Task Handoff 之 RED/GREEN 證據。
 *
 * Isolation: 本檔所有列使用 sentinel 年份區段 2051-01-01..2051-12-31（未被
 * PHASE-003a/004/005/005a 既有測試檔使用，見 Handoff 之 grep 佐證）；
 * loginName 前綴 "t7resolve_" + per-run 亂數字尾；cleanup 僅限本檔自建 id，
 * 嚴禁 deleteMany({}) 全域刪除；全程合成資料。
 */
import { FuelType, Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { computeCompletionBlockers } from "../../src/applications/completion-blockers.js";
import {
  assertParametersAvailable,
  resolveTravelParameters,
} from "../../src/applications/travel-parameters.js";
import { hashPassword } from "../../src/auth/password.js";
import { deriveFuelUnitPrice } from "../../src/parameters/fuel-price-engine.js";
import { buildServer } from "../../src/server.js";

// PHASE-005a-T7R SF-1：`deriveFuelUnitPrice` 之未知例外（非 RangeError）必須
// rethrow，不得吞掉——測試需要在單一案例中臨時替換其實作為擲出 TypeError，
// 其餘全部測試須維持真實推導行為。`vi.mock` + `importOriginal` 保留真實實作
// 作為預設值，僅在該案例以 `mockImplementationOnce` 覆寫一次。
vi.mock("../../src/parameters/fuel-price-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/parameters/fuel-price-engine.js")>();
  return {
    ...actual,
    deriveFuelUnitPrice: vi.fn(actual.deriveFuelUnitPrice),
  };
});

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0];
}

async function loginUser(app: FastifyInstance, loginName: string, password: string) {
  const resp = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { loginName, password },
  });
  if (resp.statusCode !== 200) {
    throw new Error(`Login failed for ${loginName}: ${resp.statusCode} ${resp.body}`);
  }
  return extractCookieHeader(resp.headers["set-cookie"]);
}

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "t7resolve_";
const PASSWORD = "T7ResolveTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const CONSUMPTIONLESS_LOGIN = `${LOGIN_PREFIX}fixedconsumption_${RUN_ID}`;
const NO_CONSUMPTION_LOGIN = `${LOGIN_PREFIX}noconsumption_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;

describeWithDb("PHASE-005a-T7 — resolveTravelParameters 雙鏈解析 + AC-04/21/22/23", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let otherId: string;
  let consumptionlessId: string;
  let noConsumptionId: string;
  let adminId: string;

  let ownerCookie: string;
  let adminCookie: string;

  const createdApplicationIds: string[] = [];
  const createdConsumptionIds: string[] = [];
  const createdPriceIds: string[] = [];
  const createdEtcIds: string[] = [];

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);

    const owner = await prisma.user.create({
      data: {
        loginName: OWNER_LOGIN,
        displayName: "T7 擁有人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const other = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "T7 他人（有油耗，不得洩漏）",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const consumptionless = await prisma.user.create({
      data: {
        loginName: CONSUMPTIONLESS_LOGIN,
        displayName: "T7 固定油耗使用者（AC-04/22 用）",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const noConsumption = await prisma.user.create({
      data: {
        loginName: NO_CONSUMPTION_LOGIN,
        displayName: "T7 完全無油耗使用者（AC-21 用）",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "T7 管理員（自身有互異油耗）",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });

    ownerId = owner.id;
    otherId = other.id;
    consumptionlessId = consumptionless.id;
    noConsumptionId = noConsumption.id;
    adminId = admin.id;

    // ── ETC：涵蓋整個 2051 年區段，讓 ETC 不成為本檔任何案例的變因 ──
    const etc = await prisma.etcParameterVersion.create({
      data: {
        unitPrice: new Prisma.Decimal("2.0000"),
        effectiveFrom: new Date("2051-01-01"),
        createdById: ownerId,
      },
    });
    createdEtcIds.push(etc.id);

    // ── AC-22 鑑別力：其他三油種（92/98/DIESEL）皆有 2051-01-01 生效之油價，
    //    僅 GASOLINE_95（owner/consumptionless 的擁有人油種）刻意缺 ──
    for (const fuelType of [FuelType.GASOLINE_92, FuelType.GASOLINE_98, FuelType.DIESEL]) {
      const v = await prisma.fuelPriceVersion.create({
        data: {
          fuelType,
          pricePerLiter: new Prisma.Decimal("10.0000"),
          effectiveFrom: new Date("2051-01-01"),
          createdById: ownerId,
        },
      });
      createdPriceIds.push(v.id);
    }

    // ── AC-04 鑑別力：GASOLINE_95 兩版本（30.0000 @ 2051-03-01, 35.0000 @
    //    2051-06-01——刻意晚於其他三油種的 2051-01-01，讓 AC-22 有一個「其他
    //    三油種已生效、GASOLINE_95 尚未生效」的窗口）＋ DIESEL 於同區段另有
    //    獨立時間軸（99.0000 @ 2051-06-01，刻意與 GASOLINE_95 數值不同，
    //    證明互不干涉）。consumptionless 使用者之油耗固定 kmPerLiter=1.0000，
    //    讓推導單價 = pricePerLiter（測試等價技巧，非改變 AC-18 公式）。
    const g95v1 = await prisma.fuelPriceVersion.create({
      data: {
        fuelType: FuelType.GASOLINE_95,
        pricePerLiter: new Prisma.Decimal("30.0000"),
        effectiveFrom: new Date("2051-03-01"),
        createdById: ownerId,
      },
    });
    const g95v2 = await prisma.fuelPriceVersion.create({
      data: {
        fuelType: FuelType.GASOLINE_95,
        pricePerLiter: new Prisma.Decimal("35.0000"),
        effectiveFrom: new Date("2051-06-01"),
        createdById: ownerId,
      },
    });
    createdPriceIds.push(g95v1.id, g95v2.id);
    const dieselExtra = await prisma.fuelPriceVersion.create({
      data: {
        fuelType: FuelType.DIESEL,
        pricePerLiter: new Prisma.Decimal("99.0000"),
        effectiveFrom: new Date("2051-06-01"),
        createdById: ownerId,
      },
    });
    createdPriceIds.push(dieselExtra.id);

    // consumptionless 使用者：固定油耗版本，生效日遠早於本檔所有查詢日期
    // （用於 AC-04/22——確保這些測試案例中「consumption 一律可解析」，唯一
    // 變因是 GASOLINE_95 的油價版本是否存在）。
    const cl = await prisma.userFuelConsumptionVersion.create({
      data: {
        userId: consumptionlessId,
        fuelType: FuelType.GASOLINE_95,
        kmPerLiter: new Prisma.Decimal("1.0000"),
        effectiveFrom: new Date("2010-01-01"),
        basisNote: "t7resolve AC-04/22 fixture：kmPerLiter=1，生效日遠早於測試查詢日期",
        createdById: ownerId,
      },
    });
    createdConsumptionIds.push(cl.id);

    // ── AC-21 鑑別力：other 使用者「有」有效油耗（GASOLINE_92），owner 完全
    //    沒有任何油耗版本——驗證 owner 完成/預覽缺油耗時，other 的油耗數值
    //    絕不出現在結果中（無 fallback）。
    const otherConsumption = await prisma.userFuelConsumptionVersion.create({
      data: {
        userId: otherId,
        fuelType: FuelType.GASOLINE_92,
        kmPerLiter: new Prisma.Decimal("7.0000"),
        effectiveFrom: new Date("2051-01-01"),
        basisNote: "t7resolve AC-21 對照組：other 使用者的油耗，不得洩漏給 owner",
        createdById: ownerId,
      },
    });
    createdConsumptionIds.push(otherConsumption.id);

    // ── AC-23 鑑別力：admin 與 owner 皆有 GASOLINE_95 油耗，但 kmPerLiter
    //    刻意互異，令推導單價互異（owner: 35÷5=7；admin: 35÷3=11.67→12，
    //    ROUND_HALF_UP）。單價來源沿用 AC-04 的 GASOLINE_95 版本組——AC-23
    //    使用專屬出差日期 "2051-09-01"/"2051-09-02"，屆時有效版本仍是
    //    35.0000（沒有比 2051-06-01 更晚的 GASOLINE_95 版本），owner/admin
    //    的單價互異純粹來自 kmPerLiter 不同。
    const ownerConsumption = await prisma.userFuelConsumptionVersion.create({
      data: {
        userId: ownerId,
        fuelType: FuelType.GASOLINE_95,
        kmPerLiter: new Prisma.Decimal("5.0000"),
        effectiveFrom: new Date("2051-01-01"),
        basisNote: "t7resolve AC-23：owner 油耗",
        createdById: ownerId,
      },
    });
    createdConsumptionIds.push(ownerConsumption.id);
    const adminConsumption = await prisma.userFuelConsumptionVersion.create({
      data: {
        userId: adminId,
        fuelType: FuelType.GASOLINE_95,
        kmPerLiter: new Prisma.Decimal("3.0000"),
        effectiveFrom: new Date("2051-01-01"),
        basisNote: "t7resolve AC-23：admin 自身油耗（互異，不得出現於代操作結果）",
        createdById: ownerId,
      },
    });
    createdConsumptionIds.push(adminConsumption.id);

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    ownerCookie = await loginUser(app, OWNER_LOGIN, PASSWORD);
    adminCookie = await loginUser(app, ADMIN_LOGIN, PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      if (createdApplicationIds.length > 0) {
        await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
      }
      if (createdConsumptionIds.length > 0) {
        await prisma.userFuelConsumptionVersion.deleteMany({
          where: { id: { in: createdConsumptionIds } },
        });
      }
      if (createdPriceIds.length > 0) {
        await prisma.fuelPriceVersion.deleteMany({ where: { id: { in: createdPriceIds } } });
      }
      if (createdEtcIds.length > 0) {
        await prisma.etcParameterVersion.deleteMany({ where: { id: { in: createdEtcIds } } });
      }
      const userIds = [ownerId, otherId, consumptionlessId, noConsumptionId, adminId].filter(
        Boolean
      );
      if (userIds.length > 0) {
        await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.auditLog.deleteMany({
          where: { OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }] },
        });
      }
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
  });

  // ===========================================================================
  // AC-04 — 依出差日期取同油種有效版本、未來版本不影響現行；DIESEL 不干擾 GASOLINE_95
  // ===========================================================================

  describe("AC-04 依出差日期取同油種有效版本", () => {
    it("four-point boundary (before / on / after effectiveFrom) selects the right version", async () => {
      const before = await resolveTravelParameters(
        prisma,
        new Date("2050-12-31"),
        consumptionlessId
      );
      expect(before.missing).toContain("FUEL_PRICE");
      expect(before.fuelUnitPrice).toBeNull();

      const justBefore = await resolveTravelParameters(
        prisma,
        new Date("2051-05-31"),
        consumptionlessId
      );
      expect(justBefore.missing).toEqual([]);
      expect(justBefore.fuelUnitPrice?.toString()).toBe("30"); // 30 ÷ 1 = 30

      const onBoundary = await resolveTravelParameters(
        prisma,
        new Date("2051-06-01"),
        consumptionlessId
      );
      expect(onBoundary.missing).toEqual([]);
      expect(onBoundary.fuelUnitPrice?.toString()).toBe("35"); // B-09 含當日

      const after = await resolveTravelParameters(
        prisma,
        new Date("2051-06-02"),
        consumptionlessId
      );
      expect(after.missing).toEqual([]);
      expect(after.fuelUnitPrice?.toString()).toBe("35");
    });

    it("DIESEL versions never affect the GASOLINE_95 result", async () => {
      // consumptionless 使用者的油種固定為 GASOLINE_95；即使 DIESEL 在同一
      // 出差日期有完全不同（99.0000 @ 2051-06-01）的版本組合，結果必須只反映
      // GASOLINE_95 自己的時間軸（35，非任何與 99 相關的數值）。
      const resolved = await resolveTravelParameters(
        prisma,
        new Date("2051-06-02"),
        consumptionlessId
      );
      expect(resolved.snapshotFuelType).toBe("GASOLINE_95");
      expect(resolved.fuelUnitPrice?.toString()).toBe("35");
      expect(resolved.fuelUnitPrice?.toString()).not.toBe("99");
    });
  });

  // ===========================================================================
  // AC-21 — 缺油耗：草稿可存、完成被擋、提示可區分、絕不 fallback 他人資料
  // ===========================================================================

  describe("AC-21 缺油耗", () => {
    const TRIP_DATE = new Date("2051-02-01");

    it("PHASE-005a-T7R SF-1修復: draft's computeCompletionBlockers includes FUEL_CONSUMPTION_NOT_AVAILABLE (owner has no consumption version at all)", async () => {
      // 直建列保留為 fixture（證明草稿本身可正常建立，缺油耗不阻擋草稿儲存）；
      // 真正的鑑別力斷言改為對 computeCompletionBlockers 的實際輸出斷言
      // （SF-3 修復前，本測試僅建立列卻從未讀取／斷言 blockers，過度宣稱）。
      const application = await prisma.application.create({
        data: {
          type: "TRAVEL",
          status: "DRAFT",
          ownerId: noConsumptionId,
          createdById: noConsumptionId,
          primaryDate: TRIP_DATE,
          travel: {
            create: {
              tripDate: TRIP_DATE,
              purpose: "AC-21 缺油耗草稿測試",
            },
          },
        },
      });
      createdApplicationIds.push(application.id);

      const resolved = await resolveTravelParameters(prisma, TRIP_DATE, noConsumptionId);
      expect(resolved.missing).toEqual(["FUEL_CONSUMPTION"]);
      // B-05：油種未知，不得同時回報油價缺項。
      expect(resolved.missing).not.toContain("FUEL_PRICE");
      // 絕不 fallback：other 使用者的油耗（kmPerLiter=7）完全不影響 owner 的結果。
      expect(resolved.snapshotFuelConsumption).toBeNull();
      expect(resolved.fuelUnitPrice).toBeNull();

      const blockers = computeCompletionBlockers({
        tripDate: TRIP_DATE,
        purpose: "AC-21 缺油耗草稿測試",
        segments: [],
        missingParameters: resolved.missing,
      });
      expect(blockers.map((b) => b.code)).toContain("FUEL_CONSUMPTION_NOT_AVAILABLE");
    });

    it("assertParametersAvailable throws 409 with details.missing containing FUEL_CONSUMPTION (message differs verbatim from missing-price)", () => {
      const resolved = {
        fuelUnitPrice: null,
        etcUnitPrice: new Prisma.Decimal("2"),
        fuelPriceVersionId: null,
        fuelConsumptionVersionId: null,
        etcVersionId: "etc-1",
        snapshotFuelType: null,
        snapshotFuelPricePerLiter: null,
        snapshotFuelConsumption: null,
        fuelUnitPriceOutOfRange: false,
        fuelDataCorrupted: false,
        missing: ["FUEL_CONSUMPTION"] as const,
      };
      let caught: unknown;
      try {
        assertParametersAvailable(resolved as never, TRIP_DATE);
      } catch (err) {
        caught = err;
      }
      const err = caught as {
        code: string;
        httpStatus: number;
        userMessage: string;
        details?: { missing?: string[] };
      };
      expect(err.code).toBe("PARAMETER_NOT_AVAILABLE");
      expect(err.httpStatus).toBe(409);
      expect(err.userMessage).toBe("請聯絡管理員建立油耗資料");
      expect(err.userMessage).not.toBe("請聯絡管理員設定參數");
      expect(err.details?.missing).toContain("FUEL_CONSUMPTION");
    });

    it("another user's effective consumption value never appears in the result (no fallback) — real DB round-trip", async () => {
      // noConsumption 使用者完全沒有油耗版本；other 有（kmPerLiter=7.0000,
      // GASOLINE_92）。若實作曾經 fallback 到「隨便挑一筆油耗」，這裡會意外
      // 解析出 GASOLINE_92 或 kmPerLiter=7 的痕跡。
      const resolved = await resolveTravelParameters(prisma, TRIP_DATE, noConsumptionId);
      expect(resolved.missing).toEqual(["FUEL_CONSUMPTION"]);
      expect(resolved.snapshotFuelType).not.toBe("GASOLINE_92");
      expect(resolved.snapshotFuelConsumption).toBeNull();
    });
  });

  // ===========================================================================
  // AC-22 — 缺該油種油價（其他三油種皆有）：完成被擋，提示為「設定參數」
  // ===========================================================================

  describe("AC-22 缺該油種油價", () => {
    it("the other three fuel types having prices does not satisfy the owner's fuel type (GASOLINE_95 has no price at this date)", async () => {
      // consumptionless 使用者的油耗油種為 GASOLINE_95。查詢日期 2051-02-01
      // 落在「其他三油種（92/98/DIESEL）已生效（2051-01-01 起）」與
      // 「GASOLINE_95 尚未生效（最早 2051-03-01）」之間的窗口——若實作誤以
      // 「任一油種有版本」判定，本測試必紅（AC-22 鑑別力核心）。
      const g95NotYetEffective = new Date("2051-02-01");
      const resolved = await resolveTravelParameters(prisma, g95NotYetEffective, consumptionlessId);
      expect(resolved.missing).toEqual(["FUEL_PRICE"]);
      expect(resolved.missing).not.toContain("FUEL_CONSUMPTION");
    });

    it("the 409 message differs verbatim from the missing-consumption message", () => {
      const resolved = {
        fuelUnitPrice: null,
        etcUnitPrice: new Prisma.Decimal("2"),
        fuelPriceVersionId: null,
        fuelConsumptionVersionId: "consumption-1",
        etcVersionId: "etc-1",
        snapshotFuelType: "GASOLINE_95" as const,
        snapshotFuelPricePerLiter: null,
        snapshotFuelConsumption: new Prisma.Decimal("1"),
        fuelUnitPriceOutOfRange: false,
        fuelDataCorrupted: false,
        missing: ["FUEL_PRICE"] as const,
      };
      let caught: unknown;
      try {
        assertParametersAvailable(resolved as never, new Date("2050-01-01"));
      } catch (err) {
        caught = err;
      }
      const err = caught as { userMessage: string };
      expect(err.userMessage).toBe("請聯絡管理員設定參數");
      expect(err.userMessage).not.toBe("請聯絡管理員建立油耗資料");
    });
  });

  // ===========================================================================
  // AC-23 — 代操作以擁有人資料為準（管理員與擁有人推導單價刻意互異）
  // ===========================================================================

  describe("AC-23 代操作以擁有人資料為準", () => {
    it("resolving with the OWNER's id yields the owner's derived price, not the admin's (distinct derived prices)", async () => {
      const TRIP_DATE = new Date("2051-09-01"); // GASOLINE_95 於此日期有效版本仍是 35（無更晚版本）

      const ownerResolved = await resolveTravelParameters(prisma, TRIP_DATE, ownerId);
      const adminResolved = await resolveTravelParameters(prisma, TRIP_DATE, adminId);

      // owner: kmPerLiter=5.0000 → 35 ÷ 5 = 7；admin: kmPerLiter=3.0000 → 35 ÷ 3 = 11.67→12
      // 精確等值斷言（Spec §2.D 金額語意類 AC 一律精確比較，禁止近似）。
      const ownerExpected = deriveFuelUnitPrice("35.0000", "5.0000");
      const adminExpected = deriveFuelUnitPrice("35.0000", "3.0000");
      expect(ownerExpected.status).toBe("ok");
      expect(adminExpected.status).toBe("ok");
      if (ownerExpected.status === "ok" && adminExpected.status === "ok") {
        expect(ownerResolved.fuelUnitPrice?.toString()).toBe(ownerExpected.unitPrice.toString());
        expect(adminResolved.fuelUnitPrice?.toString()).toBe(adminExpected.unitPrice.toString());
        // 鑑別力核心：兩者刻意互異。
        expect(ownerResolved.fuelUnitPrice?.toString()).not.toBe(
          adminResolved.fuelUnitPrice?.toString()
        );
      }
    });

    it("admin acting on behalf via completion resolution uses the OWNER's consumption id, never the admin's", async () => {
      const TRIP_DATE = new Date("2051-09-02");
      const resolved = await resolveTravelParameters(prisma, TRIP_DATE, ownerId);
      const ownerConsumptionRow = await prisma.userFuelConsumptionVersion.findFirstOrThrow({
        where: { userId: ownerId },
      });
      const adminConsumptionRow = await prisma.userFuelConsumptionVersion.findFirstOrThrow({
        where: { userId: adminId },
      });
      expect(resolved.fuelConsumptionVersionId).toBe(ownerConsumptionRow.id);
      expect(resolved.fuelConsumptionVersionId).not.toBe(adminConsumptionRow.id);
    });
  });

  // ===========================================================================
  // D6(a) — POST /applications/travel/preview 之可選 ownerId
  // ===========================================================================

  describe("D6(a) 預覽端點之可選 ownerId", () => {
    it("一般使用者帶他人 ownerId → 403（fail-closed，不靜默降級）", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/travel/preview",
        headers: { cookie: ownerCookie },
        payload: {
          ownerId: adminId,
          tripDate: "2051-09-01",
          segments: [{ totalKm: "10", highwayKm: "0" }],
        },
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    });

    it("管理員帶擁有人 ownerId → 使用擁有人資料（金額與 owner 直接預覽一致，非 admin 自身數值）", async () => {
      const ownPreviewAsAdmin = await app.inject({
        method: "POST",
        url: "/applications/travel/preview",
        headers: { cookie: adminCookie },
        payload: {
          tripDate: "2051-09-01",
          segments: [{ totalKm: "10", highwayKm: "0" }],
        },
      });
      const onBehalfPreview = await app.inject({
        method: "POST",
        url: "/applications/travel/preview",
        headers: { cookie: adminCookie },
        payload: {
          ownerId,
          tripDate: "2051-09-01",
          segments: [{ totalKm: "10", highwayKm: "0" }],
        },
      });
      const ownerDirectPreview = await app.inject({
        method: "POST",
        url: "/applications/travel/preview",
        headers: { cookie: ownerCookie },
        payload: {
          tripDate: "2051-09-01",
          segments: [{ totalKm: "10", highwayKm: "0" }],
        },
      });

      expect(ownPreviewAsAdmin.statusCode).toBe(200);
      expect(onBehalfPreview.statusCode).toBe(200);
      expect(ownerDirectPreview.statusCode).toBe(200);

      const adminAmount = ownPreviewAsAdmin.json<{ preview: { totalAmount: number } }>().preview
        .totalAmount;
      const onBehalfAmount = onBehalfPreview.json<{ preview: { totalAmount: number } }>().preview
        .totalAmount;
      const ownerDirectAmount = ownerDirectPreview.json<{ preview: { totalAmount: number } }>()
        .preview.totalAmount;

      // 代操作預覽金額必須等於擁有人自己看到的金額，且刻意與 admin 自身數值不同
      // （admin: 35÷3=12 → 10*12=120；owner: 35÷5=7 → 10*7=70）。
      expect(onBehalfAmount).toBe(ownerDirectAmount);
      expect(onBehalfAmount).not.toBe(adminAmount);
    });
  });

  // ===========================================================================
  // T2 複審 AR-D 義務 — deriveFuelUnitPrice 之 throw 不得以 500 面向使用者
  // ===========================================================================

  describe("deriveFuelUnitPrice throw 之防護（T2 AR-D 義務、D4(a)、PHASE-005a-T7R SF-1）", () => {
    it("資料毀損情境（kmPerLiter<=0 繞過上游驗證直接寫入 DB）→ resolveTravelParameters 不拋出，回傳 fuelDataCorrupted=true（非 fuelUnitPriceOutOfRange），非 500", async () => {
      const corruptOwner = await prisma.user.create({
        data: {
          loginName: `${LOGIN_PREFIX}corrupt_${RUN_ID}`,
          displayName: "T7 毀損資料使用者",
          passwordHash: await hashPassword(PASSWORD),
          role: "USER",
          isActive: true,
          mustChangePassword: false,
        },
      });
      try {
        // 直接繞過 service 層驗證（AC-08 只在 route 層把關 >0），模擬既有資料
        // 毀損情境：kmPerLiter=0（deriveFuelUnitPrice 本身會對此 throw RangeError）。
        const corruptConsumption = await prisma.userFuelConsumptionVersion.create({
          data: {
            userId: corruptOwner.id,
            fuelType: FuelType.GASOLINE_95,
            kmPerLiter: new Prisma.Decimal("0"),
            effectiveFrom: new Date("2051-01-01"),
            basisNote: "t7resolve 毀損資料防護測試（繞過上游驗證）",
            createdById: ownerId,
          },
        });
        createdConsumptionIds.push(corruptConsumption.id);

        let resolved: Awaited<ReturnType<typeof resolveTravelParameters>> | undefined;
        let threw: unknown;
        try {
          resolved = await resolveTravelParameters(prisma, new Date("2051-09-01"), corruptOwner.id);
        } catch (err) {
          threw = err;
        }
        expect(threw).toBeUndefined();
        expect(resolved).toBeDefined();
        // PHASE-005a-T7R SF-1：資料毀損（RangeError）與「推導正常但超出欄位
        // 容量」是不同維度——前者為 fuelDataCorrupted，後者才是
        // fuelUnitPriceOutOfRange。本情境（kmPerLiter=0）屬前者。
        expect(resolved?.fuelDataCorrupted).toBe(true);
        expect(resolved?.fuelUnitPriceOutOfRange).toBe(false);
        expect(resolved?.fuelUnitPrice).toBeNull();

        // 完成流程之守門（assertParametersAvailable）同樣不得拋出未攔截例外，
        // 必須是可行動的 409，而非裸露的 RangeError 或 500；訊息與代碼皆須與
        // 「超出可計算範圍」情境逐字不同（SF-1 可行動性要求）。
        if (!resolved) throw new Error("resolved must be defined (asserted above)");
        let caught: unknown;
        try {
          assertParametersAvailable(resolved, new Date("2051-09-01"));
        } catch (err) {
          caught = err;
        }
        const err = caught as {
          code: string;
          httpStatus: number;
          userMessage: string;
          details?: { missing?: string[] };
        };
        expect(err).toBeDefined();
        expect(err.code).toBe("PARAMETER_NOT_AVAILABLE");
        expect(err.httpStatus).toBe(409);
        expect(err.userMessage).toBe("油耗資料異常，請聯絡管理員檢查該使用者之油耗版本");
        expect(err.userMessage).not.toContain("超出可計算範圍");
        expect(err.details?.missing).toContain("FUEL_DATA_CORRUPTED");
        expect(err.details?.missing).not.toContain("FUEL_UNIT_PRICE_OUT_OF_RANGE");
      } finally {
        // UserFuelConsumptionVersion.user 為 onDelete: Restrict（AD-US-04 歷史
        // 資料保護延伸，§8.2 明文）——刪除使用者前必須先移除其油耗版本，否則
        // 會撞 FK 約束（見 T1 Done When：userHasHistory 已涵蓋本表）。
        await prisma.userFuelConsumptionVersion.deleteMany({
          where: { userId: corruptOwner.id },
        });
        await prisma.session.deleteMany({ where: { userId: corruptOwner.id } });
        await prisma.user.delete({ where: { id: corruptOwner.id } });
      }
    });

    it("非 RangeError 之未知例外（TypeError）不得被吞掉 —— 傳播出去，非 409（fail-loud）", async () => {
      const mocked = vi.mocked(deriveFuelUnitPrice);
      // mockImplementationOnce：僅覆寫下一次呼叫，之後自動還原為真實實作
      // （vi.mock 工廠內以 vi.fn(actual.deriveFuelUnitPrice) 設定之預設值），
      // 不影響本檔其餘任何測試案例。
      mocked.mockImplementationOnce(() => {
        throw new TypeError("t7resolve SF-1：模擬未知例外（非資料毀損 RangeError）");
      });
      // owner @ 2051-09-01：consumption(kmPerLiter=5) 與 price(35.0000) 皆
      // 有效，會進入 deriveFuelUnitPrice 呼叫路徑（見 AC-23 fixture）。
      await expect(
        resolveTravelParameters(prisma, new Date("2051-09-01"), ownerId)
      ).rejects.toThrow(TypeError);
    });
  });
});
