/**
 * CHORE-003-T2 — 參數欄位容量／精度／字串保真守門之整合測試（I 層）
 *
 * PHASE-003a Spec §14（ACTIVE）AC-21~AC-28（I 層）、AC-30（本檔補充鑑別，主證為
 * 既有 `phase3a-parameter-*.test.ts` 四檔）、AC-31。
 *
 * TDD：本檔於接線（`parameter-service.ts` 接入 T1 的 `parameter-validation.ts`）
 * **之前**先寫、先跑、確認 RED，再實作至 GREEN。RED 實證見 Task Handoff。
 *
 * 走真實 route（`app.inject`）+ 真實 Postgres，覆蓋 §14.3 行為對照表之
 * B-05~B-26 各列，並以「DB 無新增列」斷言證明拒絕發生在持久化之前。
 *
 * CD 裁定（§14.4，2026-08-03 人類 leonchih）：
 *   - CD-1(a)：字串前後空白 `.trim()` 後判定；全空白仍為 400。
 *   - CD-2(a)：只收標準十進位字面（`^-?\d+(\.\d+)?$`）。
 *   - CD-3(a)：折舊整數欄位之 int4 容量守門納入本回合。
 *
 * 隔離：
 *   - `loginName` 前綴 `c3t2_`（與 `t3param_`／`p5t*`／`chore002_` 皆不同）。
 *   - `effectiveFrom` 哨兵區間 **2097-01-* / 2097-02-* / 2097-03-***（全套檢索
 *     顯示 2097 年未被任何既有測試使用；2098／2099 已被 chore002／phase3a 佔用）。
 *   - 清理僅針對上述前綴與日期區間，無全域 `deleteMany`。
 *   - 合成資料，無真實個資／密碼／secrets。
 */

import { Writable } from "node:stream";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 文案常數（§14.2 文案表逐字；寫成常數以避免各處手抄漂移）
// ---------------------------------------------------------------------------

const REASON_TYPE = "必須為有效的數值（字串或數字）";
const REASON_EMPTY = "必須為有效的數值";
const REASON_LITERAL = "必須為有效的十進位數值（不接受指數記號）";
const REASON_SCALE_4 = "最多允許 4 位小數";
const REASON_SCALE_2 = "最多允許 2 位小數";
const REASON_MAGNITUDE_6 = "數值超出可儲存範圍（整數部分最多 6 位）";
const REASON_MAGNITUDE_10 = "數值超出可儲存範圍（整數部分最多 10 位）";
const REASON_INT_CAPACITY = "數值超出可儲存範圍（最大 2147483647）";
// §14.2 表列為「不變」之既有值域層文案（AC-30 反向斷言用）
const REASON_UNIT_PRICE_NEGATIVE = "單價不得小於 0";
const REASON_GT_ZERO = "必須大於 0";
const REASON_INT_GT_ZERO = "必須為整數且大於 0";
// REASON_UNIT_PRICE_REQUIRED（"單價為必填"）已隨 AC-37(e) 移除：該文案由舊
// POST /parameters/fuel route 之就地必填檢查產生，/parameters/fuel-price 無
// 此分支（見下方 pricePerLiter 缺欄位／null／'' it 之更新說明）。

// ---------------------------------------------------------------------------
// 共用 helper
// ---------------------------------------------------------------------------

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0];
}

const SUFFIX = Date.now();
const PASSWORD = "AdminTest99!";
const LOGIN_PREFIX = "c3t2_";
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${SUFFIX}`;

const SENTINEL_START = new Date("2097-01-01");
const SENTINEL_END = new Date("2097-03-31");

// 400 情境共用日期（不會建立任何列，故可重複使用；每次斷言該日期下 count === 0）
const FUEL_REJECT_DATE = "2097-01-20";
const ETC_REJECT_DATE = "2097-02-20";
const DEP_REJECT_DATE = "2097-03-20";

type ErrorBody = {
  error: {
    code: string;
    message: string;
    requestId?: string;
    fields?: { field: string; reason: string }[];
  };
};

type VersionBody = { version: Record<string, unknown> };

// ---------------------------------------------------------------------------
// 測試主體
// ---------------------------------------------------------------------------

describeWithDb("CHORE-003-T2 參數欄位容量／精度／字串保真（I 層）", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let adminId: string;
  let adminCookie: string;

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "CHORE-003 T2 Admin",
        passwordHash: await hashPassword(PASSWORD),
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    adminId = admin.id;

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    const loginResp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: ADMIN_LOGIN, password: PASSWORD },
    });
    if (loginResp.statusCode !== 200) {
      throw new Error(`Login failed: ${loginResp.statusCode} ${loginResp.body}`);
    }
    adminCookie = extractCookieHeader(loginResp.headers["set-cookie"]);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      const range = { effectiveFrom: { gte: SENTINEL_START, lte: SENTINEL_END } };
      // PHASE-005a-T3b（AC-37(e)）: postFuel 改指 /parameters/fuel-price，
      // 寫入表由 FuelParameterVersion 改為 FuelPriceVersion。
      await prisma.fuelPriceVersion.deleteMany({ where: range });
      await prisma.etcParameterVersion.deleteMany({ where: range });
      await prisma.depreciationParameterVersion.deleteMany({ where: range });
      if (adminId) {
        await prisma.session.deleteMany({ where: { userId: adminId } });
        await prisma.auditLog.deleteMany({
          where: { OR: [{ actorId: adminId }, { targetId: adminId }] },
        });
        await prisma.user.deleteMany({ where: { id: adminId } });
      }
      await prisma.$disconnect();
    }
  });

  // -------------------------------------------------------------------------
  // 請求 helper
  // -------------------------------------------------------------------------

  /**
   * PHASE-005a-T3b（Spec §2.H AC-37(e)）: POST /parameters/fuel 已移除
   * （§16 D1(a)）；本 helper 改指 POST /parameters/fuel-price。payload 之
   * `unitPrice` 欄位已由呼叫端全數改為 `pricePerLiter`；`fuelType` 於此
   * 統一補上預設值 "GASOLINE_95"，除非呼叫端自行覆寫。
   */
  async function postFuel(payload: unknown) {
    return app.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: adminCookie },
      payload: { fuelType: "GASOLINE_95", ...(payload as Record<string, unknown>) },
    });
  }

  async function postEtc(payload: unknown) {
    return app.inject({
      method: "POST",
      url: "/parameters/etc",
      headers: { cookie: adminCookie },
      payload: payload as Record<string, unknown>,
    });
  }

  async function postDep(payload: unknown) {
    return app.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: adminCookie },
      payload: payload as Record<string, unknown>,
    });
  }

  /** 折舊端點：除受測欄位外一律使用合法值，確保 `fields` 只反映受測欄位。 */
  function depPayload(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      vehiclePrice: "600000.00",
      usefulLifeYears: 5,
      estimatedAnnualKm: 20000,
      effectiveFrom: DEP_REJECT_DATE,
      ...overrides,
    };
  }

  // PHASE-005a-T3b（AC-37(e)）: postFuel 改指 /parameters/fuel-price；
  // 零寫入斷言改查 FuelPriceVersion（固定 fuelType "GASOLINE_95"，見 postFuel）。
  async function countFuelAt(dateStr: string): Promise<number> {
    return prisma.fuelPriceVersion.count({
      where: { fuelType: "GASOLINE_95", effectiveFrom: new Date(dateStr) },
    });
  }
  async function countEtcAt(dateStr: string): Promise<number> {
    return prisma.etcParameterVersion.count({ where: { effectiveFrom: new Date(dateStr) } });
  }
  async function countDepAt(dateStr: string): Promise<number> {
    return prisma.depreciationParameterVersion.count({
      where: { effectiveFrom: new Date(dateStr) },
    });
  }

  /** 斷言統一 400 錯誤形狀，並回傳 fields（AC-31 形狀要求）。 */
  function expectValidationError(
    resp: { statusCode: number; json: <T>() => T },
    field: string,
    reason: string
  ): void {
    expect(resp.statusCode).toBe(400);
    const body = resp.json<ErrorBody>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.requestId).toBeDefined();
    expect(body.error.fields).toBeDefined();
    expect(body.error.fields).toContainEqual({ field, reason });
  }

  // =========================================================================
  // AC-21 — unitPrice 量級上限綁欄位容量（B-16 / B-17）
  // =========================================================================

  describe("AC-21 unitPrice ≥1e6 → 400（含 999999.9999 → 201 上界鑑別）", () => {
    it("上界內最大值 '999999.9999' → 201 且原值存入（B-16，證明上限非寫小一個數量級）", async () => {
      const resp = await postFuel({ pricePerLiter: "999999.9999", effectiveFrom: "2097-01-01" });
      expect(resp.statusCode).toBe(201);
      expect(String(resp.json<VersionBody>().version.pricePerLiter)).toBe("999999.9999");
    });

    it("上界 '1000000'（1e6）→ 400 量級文案 且 DB 無新增列（B-17，原為 500）", async () => {
      const resp = await postFuel({ pricePerLiter: "1000000", effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(resp, "pricePerLiter", REASON_MAGNITUDE_6);
      expect(await countFuelAt(FUEL_REJECT_DATE)).toBe(0);
    });

    it("number 型別 1000000 → 400 量級文案（string／number 同一管線）", async () => {
      const resp = await postFuel({ pricePerLiter: 1000000, effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(resp, "pricePerLiter", REASON_MAGNITUDE_6);
      expect(await countFuelAt(FUEL_REJECT_DATE)).toBe(0);
    });

    it("'12345678.9' → 400 量級文案（AC-21 明列案例）", async () => {
      const resp = await postFuel({ pricePerLiter: "12345678.9", effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(resp, "pricePerLiter", REASON_MAGNITUDE_6);
    });

    it("'-1000000' → 400 **量級**文案而非「單價不得小於 0」（AC-21／AC-32：格式層先於值域層）", async () => {
      const resp = await postFuel({ pricePerLiter: "-1000000", effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(resp, "pricePerLiter", REASON_MAGNITUDE_6);
      const fields = resp.json<ErrorBody>().error.fields ?? [];
      expect(fields.some((f) => f.reason === REASON_UNIT_PRICE_NEGATIVE)).toBe(false);
      expect(await countFuelAt(FUEL_REJECT_DATE)).toBe(0);
    });

    it("ETC 端點同守門：'999999.9999' → 201；'1000000' → 400 且 DB 無新增列", async () => {
      const ok = await postEtc({ unitPrice: "999999.9999", effectiveFrom: "2097-02-01" });
      expect(ok.statusCode).toBe(201);
      expect(String(ok.json<VersionBody>().version.unitPrice)).toBe("999999.9999");

      const bad = await postEtc({ unitPrice: "1000000", effectiveFrom: ETC_REJECT_DATE });
      expectValidationError(bad, "unitPrice", REASON_MAGNITUDE_6);
      expect(await countEtcAt(ETC_REJECT_DATE)).toBe(0);
    });
  });

  // =========================================================================
  // AC-22 — vehiclePrice 量級上限（B-22 / B-23）
  // =========================================================================

  describe("AC-22 vehiclePrice ≥1e10 → 400（含 9999999999.99 → 201 上界鑑別）", () => {
    it("上界內最大值 '9999999999.99' → 201 且原值存入（B-22）", async () => {
      const resp = await postDep(
        depPayload({ vehiclePrice: "9999999999.99", effectiveFrom: "2097-03-01" })
      );
      expect(resp.statusCode).toBe(201);
      expect(String(resp.json<VersionBody>().version.vehiclePrice)).toBe("9999999999.99");
    });

    it("上界 '10000000000'（1e10）→ 400 量級文案、DB 無新增列、回應不含 derived（B-23，原為 500）", async () => {
      const resp = await postDep(depPayload({ vehiclePrice: "10000000000" }));
      expectValidationError(resp, "vehiclePrice", REASON_MAGNITUDE_10);
      expect(await countDepAt(DEP_REJECT_DATE)).toBe(0);
      // AC-05 紀律：無效輸入不進行折舊推導
      expect(resp.json<Record<string, unknown>>().version).toBeUndefined();
    });
  });

  // =========================================================================
  // AC-23 — unitPrice 精度（B-05 / B-15）
  // =========================================================================

  describe("AC-23 unitPrice >4 位小數 → 400；尾隨零 '19.90000' → 201", () => {
    it("'0.0000001' → 400 小數位文案 且 DB 無新增列（B-15，原為靜默存 0.0000）", async () => {
      const resp = await postFuel({ pricePerLiter: "0.0000001", effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(resp, "pricePerLiter", REASON_SCALE_4);
      expect(await countFuelAt(FUEL_REJECT_DATE)).toBe(0);
    });

    it("'1.23456' → 400 小數位文案", async () => {
      const resp = await postFuel({ pricePerLiter: "1.23456", effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(resp, "pricePerLiter", REASON_SCALE_4);
    });

    it("number 0.00001 → 400 小數位文案（number 路徑同守門）", async () => {
      const resp = await postFuel({ pricePerLiter: 0.00001, effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(resp, "pricePerLiter", REASON_SCALE_4);
    });

    it("尾隨零 '19.90000' → 201 且存 19.9000（鑑別關鍵：小數位以正規化後的值判定，非字面字元數）", async () => {
      const resp = await postFuel({ pricePerLiter: "19.90000", effectiveFrom: "2097-01-02" });
      expect(resp.statusCode).toBe(201);
      expect(String(resp.json<VersionBody>().version.pricePerLiter)).toBe("19.9000");
    });

    it("恰為上界 4 位小數 '1.2345' → 201（證明用的是 > 而非 >=）", async () => {
      const resp = await postFuel({ pricePerLiter: "1.2345", effectiveFrom: "2097-01-03" });
      expect(resp.statusCode).toBe(201);
      expect(String(resp.json<VersionBody>().version.pricePerLiter)).toBe("1.2345");
    });
  });

  // =========================================================================
  // AC-24 — vehiclePrice 精度（B-21）
  // =========================================================================

  describe("AC-24 vehiclePrice >2 位小數 → 400；'600000.500' → 201", () => {
    it("'600000.005' → 400 小數位文案 且 DB 無新增列（B-21，原為靜默進位存 600000.01）", async () => {
      const resp = await postDep(depPayload({ vehiclePrice: "600000.005" }));
      expectValidationError(resp, "vehiclePrice", REASON_SCALE_2);
      expect(await countDepAt(DEP_REJECT_DATE)).toBe(0);
    });

    it("'600000.00' → 201", async () => {
      const resp = await postDep(
        depPayload({ vehiclePrice: "600000.00", effectiveFrom: "2097-03-02" })
      );
      expect(resp.statusCode).toBe(201);
      expect(String(resp.json<VersionBody>().version.vehiclePrice)).toBe("600000.00");
    });

    it("'600000.5' → 201 存 600000.50", async () => {
      const resp = await postDep(
        depPayload({ vehiclePrice: "600000.5", effectiveFrom: "2097-03-03" })
      );
      expect(resp.statusCode).toBe(201);
      expect(String(resp.json<VersionBody>().version.vehiclePrice)).toBe("600000.50");
    });

    it("'600000.05' → 201 存 600000.05", async () => {
      const resp = await postDep(
        depPayload({ vehiclePrice: "600000.05", effectiveFrom: "2097-03-04" })
      );
      expect(resp.statusCode).toBe(201);
      expect(String(resp.json<VersionBody>().version.vehiclePrice)).toBe("600000.05");
    });

    it("尾隨零 '600000.500' → 201 存 600000.50（判定基於值而非字面）", async () => {
      const resp = await postDep(
        depPayload({ vehiclePrice: "600000.500", effectiveFrom: "2097-03-05" })
      );
      expect(resp.statusCode).toBe(201);
      expect(String(resp.json<VersionBody>().version.vehiclePrice)).toBe("600000.50");
    });
  });

  // =========================================================================
  // AC-25 — 非十進位字面（B-04 / B-12 / B-13 / B-14）
  // =========================================================================

  describe("AC-25 非十進位字面 → 400（Infinity／1e400 斷言為 400 而非 500）", () => {
    const literals = ["abc", "1e5", ".5", "19.", "+19.9", "0x10", "Infinity", "NaN"];

    for (const literal of literals) {
      it(`unitPrice ${JSON.stringify(literal)} → 400 字面文案 且 DB 無新增列`, async () => {
        const resp = await postFuel({ pricePerLiter: literal, effectiveFrom: FUEL_REJECT_DATE });
        expectValidationError(resp, "pricePerLiter", REASON_LITERAL);
        expect(await countFuelAt(FUEL_REJECT_DATE)).toBe(0);
      });
    }

    it("number 1e-7 → 400 字面文案（toString() 為 '1e-7'，指數記號）", async () => {
      const resp = await postFuel({ pricePerLiter: 1e-7, effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(resp, "pricePerLiter", REASON_LITERAL);
    });

    it("number 1e21 → 400 字面文案（toString() 為 '1e+21'）", async () => {
      const resp = await postFuel({ pricePerLiter: 1e21, effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(resp, "pricePerLiter", REASON_LITERAL);
    });

    it("JSON number 1e400（解析為 Infinity）→ **400 而非 500**（B-14 消滅 500 的核心證據）", async () => {
      // AC-37(e): POST /parameters/fuel 已移除，直打 /parameters/fuel-price。
      const resp = await app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        payload: `{"fuelType":"GASOLINE_95","pricePerLiter":1e400,"effectiveFrom":"${FUEL_REJECT_DATE}"}`,
      });
      expect(resp.statusCode).not.toBe(500);
      expectValidationError(resp, "pricePerLiter", REASON_LITERAL);
      expect(await countFuelAt(FUEL_REJECT_DATE)).toBe(0);
    });

    it("'Infinity' → **400 而非 500**（B-14；小數位檢查單獨擋不住它，須靠字面／isFinite 守門）", async () => {
      const resp = await postFuel({ pricePerLiter: "Infinity", effectiveFrom: FUEL_REJECT_DATE });
      expect(resp.statusCode).not.toBe(500);
      expect(resp.statusCode).toBe(400);
      expect(await countFuelAt(FUEL_REJECT_DATE)).toBe(0);
    });

    it("vehiclePrice '1e5' → 400 字面文案（折舊端點同守門）", async () => {
      const resp = await postDep(depPayload({ vehiclePrice: "1e5" }));
      expectValidationError(resp, "vehiclePrice", REASON_LITERAL);
      expect(await countDepAt(DEP_REJECT_DATE)).toBe(0);
    });

    it("vehiclePrice 'abc' → 400 字面文案（B-19 文案變更；狀態碼與 field 不變）", async () => {
      const resp = await postDep(depPayload({ vehiclePrice: "abc" }));
      expectValidationError(resp, "vehiclePrice", REASON_LITERAL);
    });
  });

  // =========================================================================
  // AC-26 — 非數值型別（B-08 / B-09 / B-10 / B-11）
  // =========================================================================

  describe("AC-26 boolean／array／object → 400 且 DB 無新增列", () => {
    const cases: { label: string; value: unknown }[] = [
      { label: "true（原靜默存 1.0000）", value: true },
      { label: "false（原靜默存 0.0000）", value: false },
      { label: "[]（原靜默存 0.0000）", value: [] },
      { label: '["5"]（原靜默存 5.0000）', value: ["5"] },
      { label: "{}", value: {} },
    ];

    for (const { label, value } of cases) {
      it(`unitPrice ${label} → 400 型別文案 且 DB 無新增列`, async () => {
        const resp = await postFuel({ pricePerLiter: value, effectiveFrom: FUEL_REJECT_DATE });
        expectValidationError(resp, "pricePerLiter", REASON_TYPE);
        expect(await countFuelAt(FUEL_REJECT_DATE)).toBe(0);
      });
    }

    it("vehiclePrice true → 400 型別文案 且 DB 無新增列", async () => {
      const resp = await postDep(depPayload({ vehiclePrice: true }));
      expectValidationError(resp, "vehiclePrice", REASON_TYPE);
      expect(await countDepAt(DEP_REJECT_DATE)).toBe(0);
    });
  });

  // =========================================================================
  // AC-27 — 前後空白字串（CD-1(a)；B-06 / B-07 / B-20）
  // =========================================================================

  describe("AC-27 前後空白字串處置（CD-1(a)）；全空白 → 400", () => {
    it("unitPrice ' 19.9 ' → 201 存 19.9000（B-06 不變，trim 後值完全保真）", async () => {
      const resp = await postFuel({ pricePerLiter: " 19.9 ", effectiveFrom: "2097-01-04" });
      expect(resp.statusCode).toBe(201);
      expect(String(resp.json<VersionBody>().version.pricePerLiter)).toBe("19.9000");
    });

    it("vehiclePrice ' 600000 ' → 201 存 600000.00（B-20，CD-1(a) 明文批准之放寬）", async () => {
      const resp = await postDep(
        depPayload({ vehiclePrice: " 600000 ", effectiveFrom: "2097-03-06" })
      );
      expect(resp.statusCode).toBe(201);
      expect(String(resp.json<VersionBody>().version.vehiclePrice)).toBe("600000.00");
    });

    it("unitPrice '   '（全空白）→ 400 空值文案 且 DB 無新增列（B-07，原 Number('   ')===0 靜默存 0.0000）", async () => {
      const resp = await postFuel({ pricePerLiter: "   ", effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(resp, "pricePerLiter", REASON_EMPTY);
      expect(await countFuelAt(FUEL_REJECT_DATE)).toBe(0);
    });

    it("unitPrice ' abc ' → 400 字面文案（trim 後仍非十進位字面）", async () => {
      const resp = await postFuel({ pricePerLiter: " abc ", effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(resp, "pricePerLiter", REASON_LITERAL);
    });
  });

  // =========================================================================
  // AC-28 — 折舊整數欄位 int4 容量（CD-3(a)；B-24 / B-25）
  // =========================================================================

  describe("AC-28 折舊整數欄位 ≥2^31 → 400（2147483647 → 201 上界鑑別）", () => {
    it("usefulLifeYears = 2147483647 → 201（上界內最大，B-24）", async () => {
      const resp = await postDep(
        depPayload({ usefulLifeYears: 2147483647, effectiveFrom: "2097-03-07" })
      );
      expect(resp.statusCode).toBe(201);
      expect(resp.json<VersionBody>().version.usefulLifeYears).toBe(2147483647);
    });

    it("estimatedAnnualKm = 2147483647 → 201（上界內最大，B-24）", async () => {
      const resp = await postDep(
        depPayload({ estimatedAnnualKm: 2147483647, effectiveFrom: "2097-03-08" })
      );
      expect(resp.statusCode).toBe(201);
      expect(resp.json<VersionBody>().version.estimatedAnnualKm).toBe(2147483647);
    });

    it("usefulLifeYears = 2147483648（2^31）→ 400 int 容量文案 且 DB 無新增列（B-25，原為非 400）", async () => {
      const resp = await postDep(depPayload({ usefulLifeYears: 2147483648 }));
      expectValidationError(resp, "usefulLifeYears", REASON_INT_CAPACITY);
      expect(await countDepAt(DEP_REJECT_DATE)).toBe(0);
    });

    it("estimatedAnnualKm = 2147483648 → 400 int 容量文案 且 DB 無新增列（兩欄位各守一次）", async () => {
      const resp = await postDep(depPayload({ estimatedAnnualKm: 2147483648 }));
      expectValidationError(resp, "estimatedAnnualKm", REASON_INT_CAPACITY);
      expect(await countDepAt(DEP_REJECT_DATE)).toBe(0);
    });

    it("usefulLifeYears = 3e9 → 400 int 容量文案（Number.isInteger 為 true，現行值域檢查放行）", async () => {
      const resp = await postDep(depPayload({ usefulLifeYears: 3e9 }));
      expectValidationError(resp, "usefulLifeYears", REASON_INT_CAPACITY);
    });

    it("estimatedAnnualKm = 1e21 → 400 int 容量文案", async () => {
      const resp = await postDep(depPayload({ estimatedAnnualKm: 1e21 }));
      expectValidationError(resp, "estimatedAnnualKm", REASON_INT_CAPACITY);
    });

    it("usefulLifeYears = 2147483648.5 → 只回容量文案，不同時回「必須為整數且大於 0」（per-field first-hit）", async () => {
      const resp = await postDep(depPayload({ usefulLifeYears: 2147483648.5 }));
      expectValidationError(resp, "usefulLifeYears", REASON_INT_CAPACITY);
      const fields = resp.json<ErrorBody>().error.fields ?? [];
      expect(fields.filter((f) => f.field === "usefulLifeYears")).toHaveLength(1);
    });
  });

  // =========================================================================
  // AC-30 — 既有行為零回歸（本檔補充鑑別；主證為既有 phase3a 四檔）
  // =========================================================================

  describe("AC-30 既有成功／值域／必填行為零回歸（補充鑑別）", () => {
    it("unitPrice = 0（值域下界）→ 201 存 0.0000，不得被新的格式層誤擋", async () => {
      const resp = await postFuel({ pricePerLiter: 0, effectiveFrom: "2097-01-05" });
      expect(resp.statusCode).toBe(201);
      expect(String(resp.json<VersionBody>().version.pricePerLiter)).toBe("0.0000");
    });

    it("unitPrice '3.5000' → 201 存 3.5000（精度上界內）", async () => {
      const resp = await postFuel({ pricePerLiter: "3.5000", effectiveFrom: "2097-01-06" });
      expect(resp.statusCode).toBe(201);
      expect(String(resp.json<VersionBody>().version.pricePerLiter)).toBe("3.5000");
    });

    it("Decimal round-trip：'3.1415' 建立後由 GET 列表取回仍為 3.1415", async () => {
      // AC-37(e): 播種與讀取皆改指 /parameters/fuel-price
      // （GET /parameters/fuel 唯讀查舊表，本測試資料已不在該表）。
      const created = await postFuel({ pricePerLiter: "3.1415", effectiveFrom: "2097-01-07" });
      expect(created.statusCode).toBe(201);
      const listResp = await app.inject({
        method: "GET",
        url: "/parameters/fuel-price?fuelType=GASOLINE_95",
        headers: { cookie: adminCookie },
      });
      expect(listResp.statusCode).toBe(200);
      const versions = listResp.json<{ versions: Record<string, unknown>[] }>().versions;
      const row = versions.find((v) => v.effectiveFrom === "2097-01-07");
      expect(row).toBeDefined();
      expect(String(row?.pricePerLiter)).toBe("3.1415");
    });

    it("pricePerLiter = -1 → 400 且 field/reason 為既有值域層之「單價不得小於 0」（不變）", async () => {
      const resp = await postFuel({ pricePerLiter: -1, effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(resp, "pricePerLiter", REASON_UNIT_PRICE_NEGATIVE);
    });

    it("pricePerLiter = -0.5 → 400「單價不得小於 0」（負值且格式合法者仍走值域層）", async () => {
      const resp = await postFuel({ pricePerLiter: "-0.5", effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(resp, "pricePerLiter", REASON_UNIT_PRICE_NEGATIVE);
    });

    // AC-37(e) 唯一文案例外：「單價為必填」由舊 route 之就地必填檢查（routes.ts:156-160）
    // 產生；/parameters/fuel-price 無此分支，缺／null／'' 一律走
    // parseParameterDecimalField（已批准之 AC-06 文案，見 phase5a-fuel-price.test.ts
    // 之 ordered gate table）。嚴禁為了讓舊斷言通過而在新端點加回必填分支。
    it("pricePerLiter 缺欄位／null → 400「必須為有效的數值（字串或數字）」；'' → 400「必須為有效的數值」（AC-06 文案；B-03 舊必填分支已隨端點凍結移除）", async () => {
      const missing = await postFuel({ effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(missing, "pricePerLiter", REASON_TYPE);

      const nullResp = await postFuel({ pricePerLiter: null, effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(nullResp, "pricePerLiter", REASON_TYPE);

      const emptyResp = await postFuel({ pricePerLiter: "", effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(emptyResp, "pricePerLiter", REASON_EMPTY);
    });

    it("vehiclePrice = 0 / -100 → 400「必須大於 0」（既有值域層文案不變）", async () => {
      const zero = await postDep(depPayload({ vehiclePrice: 0 }));
      expectValidationError(zero, "vehiclePrice", REASON_GT_ZERO);

      const negative = await postDep(depPayload({ vehiclePrice: -100 }));
      expectValidationError(negative, "vehiclePrice", REASON_GT_ZERO);
    });

    it("usefulLifeYears = 2.5 → 400「必須為整數且大於 0」；= 0 → 400「必須大於 0」（不變）", async () => {
      const fractional = await postDep(depPayload({ usefulLifeYears: 2.5 }));
      expectValidationError(fractional, "usefulLifeYears", REASON_INT_GT_ZERO);

      const zero = await postDep(depPayload({ usefulLifeYears: 0 }));
      expectValidationError(zero, "usefulLifeYears", REASON_GT_ZERO);
    });

    it("重疊 effectiveFrom 仍為 409 PARAMETER_PERIOD_OVERLAP + details.conflictVersion（不變）", async () => {
      const first = await postFuel({ pricePerLiter: "2.5", effectiveFrom: "2097-01-09" });
      expect(first.statusCode).toBe(201);
      const dup = await postFuel({ pricePerLiter: "2.6", effectiveFrom: "2097-01-09" });
      expect(dup.statusCode).toBe(409);
      const body = dup.json<{ error: { code: string; details?: Record<string, unknown> } }>();
      expect(body.error.code).toBe("PARAMETER_PERIOD_OVERLAP");
      expect(body.error.details).toBeDefined();
    });

    it("未登入 → 401；成功路徑之稽核列仍寫入（不變）", async () => {
      // AC-37(e): 未登入呼叫改打 /parameters/fuel-price（授權鏈與 401 行為不變）。
      const anon = await app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        payload: { fuelType: "GASOLINE_95", pricePerLiter: "1.0", effectiveFrom: "2097-01-10" },
      });
      expect(anon.statusCode).toBe(401);

      const created = await postFuel({ pricePerLiter: "1.0", effectiveFrom: "2097-01-10" });
      expect(created.statusCode).toBe(201);
      const versionId = String(created.json<VersionBody>().version.id);
      // targetLabel 隨端點遷移由 FUEL#<id> 改為 FUEL_PRICE#<id>（routes.ts 稽核 hook 實查）。
      const auditCount = await prisma.auditLog.count({
        where: { actorId: adminId, targetLabel: `FUEL_PRICE#${versionId}` },
      });
      expect(auditCount).toBe(1);
    });
  });

  // =========================================================================
  // AC-32（I 層補充）— 檢查順序決定性與多欄位彙總
  // =========================================================================

  describe("AC-32（I 層補充）多重違規之順序決定性；折舊多欄位彙總", () => {
    it("unitPrice '-0.0000001'（負值＋超精度）→ 小數位文案（順序：小數位先於值域）", async () => {
      const resp = await postFuel({ pricePerLiter: "-0.0000001", effectiveFrom: FUEL_REJECT_DATE });
      expectValidationError(resp, "pricePerLiter", REASON_SCALE_4);
    });

    it("vehiclePrice '600000.005' 且 usefulLifeYears = 0 → fields 同時含兩欄位（AC-05 彙總行為不變）", async () => {
      const resp = await postDep(depPayload({ vehiclePrice: "600000.005", usefulLifeYears: 0 }));
      expect(resp.statusCode).toBe(400);
      const fields = resp.json<ErrorBody>().error.fields ?? [];
      expect(fields).toContainEqual({ field: "vehiclePrice", reason: REASON_SCALE_2 });
      expect(fields).toContainEqual({ field: "usefulLifeYears", reason: REASON_GT_ZERO });
    });
  });

  // =========================================================================
  // AC-31 — 錯誤形狀與不外洩（回應 body）
  // =========================================================================

  describe("AC-31 原 500 情境之回應不外洩 DB／驅動層原文", () => {
    /** 驅動層／DB 內部訊息片段（大小寫不敏感比對）。 */
    const LEAK_FRAGMENTS = [
      "numeric field overflow",
      "out of range",
      "22003",
      "PrismaClient",
      "Invalid `prisma",
      "DecimalError",
      "node_modules",
      "@prisma/client",
      "INSERT INTO",
      "select ",
      "at Object.",
      "\\backend\\src",
      "/backend/src",
      "numeric(",
      "Decimal(10, 4)",
      "Decimal(12, 2)",
      "int4",
    ];

    function expectNoLeak(raw: string): void {
      const lower = raw.toLowerCase();
      for (const frag of LEAK_FRAGMENTS) {
        expect(lower.includes(frag.toLowerCase())).toBe(false);
      }
    }

    it("B-14 'Infinity'：400，body 為統一形狀且不含驅動層訊息片段", async () => {
      const resp = await postFuel({ pricePerLiter: "Infinity", effectiveFrom: FUEL_REJECT_DATE });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(Object.keys(body)).toEqual(["error"]);
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("輸入資料有誤，請檢查標示欄位。");
      expect(body.error.requestId).toBeDefined();
      expectNoLeak(resp.body);
    });

    it("B-17 '1000000'：400，body 不含驅動層訊息片段", async () => {
      const resp = await postFuel({ pricePerLiter: "1000000", effectiveFrom: FUEL_REJECT_DATE });
      expect(resp.statusCode).toBe(400);
      expectNoLeak(resp.body);
    });

    it("B-23 vehiclePrice '10000000000'：400，body 不含驅動層訊息片段", async () => {
      const resp = await postDep(depPayload({ vehiclePrice: "10000000000" }));
      expect(resp.statusCode).toBe(400);
      expectNoLeak(resp.body);
    });

    it("三端點於全部新增之 400 情境皆不產生 500（狀態碼掃描）", async () => {
      const fuelInputs: unknown[] = [
        "1000000",
        "0.0000001",
        "Infinity",
        "NaN",
        "1e5",
        ".5",
        "19.",
        "+19.9",
        "0x10",
        "   ",
        true,
        false,
        [],
        {},
        1e21,
        1e-7,
      ];
      for (const value of fuelInputs) {
        const fuelResp = await postFuel({ pricePerLiter: value, effectiveFrom: FUEL_REJECT_DATE });
        expect({ value, status: fuelResp.statusCode }).toEqual({ value, status: 400 });
        const etcResp = await postEtc({ unitPrice: value, effectiveFrom: ETC_REJECT_DATE });
        expect({ value, status: etcResp.statusCode }).toEqual({ value, status: 400 });
      }

      const depInputs: Record<string, unknown>[] = [
        { vehiclePrice: "10000000000" },
        { vehiclePrice: "600000.005" },
        { vehiclePrice: "Infinity" },
        { vehiclePrice: [] },
        { usefulLifeYears: 2147483648 },
        { estimatedAnnualKm: 2147483648 },
      ];
      for (const overrides of depInputs) {
        const resp = await postDep(depPayload(overrides));
        expect({ overrides, status: resp.statusCode }).toEqual({ overrides, status: 400 });
      }
    });
  });
});

// ===========================================================================
// AC-31 — 日誌不外洩（logStream 攔截；獨立 app 實例）
// ===========================================================================

describeWithDb("CHORE-003-T2 AC-31 日誌不外洩 DB／驅動層原文", () => {
  let logApp: FastifyInstance;
  let prisma: PrismaClient;
  let logAdminId: string;
  let logCookie: string;
  let logLines: string[] = [];

  const LOG_ADMIN_LOGIN = `${LOGIN_PREFIX}logadmin_${SUFFIX}`;

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const admin = await prisma.user.create({
      data: {
        loginName: LOG_ADMIN_LOGIN,
        displayName: "CHORE-003 T2 Log Admin",
        passwordHash: await hashPassword(PASSWORD),
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    logAdminId = admin.id;

    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(chunk.toString());
        callback();
      },
    });

    // logLevel 顯式設為 "info"：本 describe 斷言「log 不含 DB 原文」，其前提是
    // log 確實有輸出可供檢查；不可依賴執行環境的 LOG_LEVEL（沿用 phase5 AR-4 手法）。
    logApp = await buildServer({ databaseUrl: DB_URL, logStream: stream, logLevel: "info" });
    await logApp.ready();

    const loginResp = await logApp.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: LOG_ADMIN_LOGIN, password: PASSWORD },
    });
    logCookie = extractCookieHeader(loginResp.headers["set-cookie"]);
    logLines = []; // 只看下列三個錯誤路徑的 log

    // B-14 / B-17 / B-23 三個原 500 情境
    // AC-37(e): POST /parameters/fuel 已移除，改打 /parameters/fuel-price。
    await logApp.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: logCookie },
      payload: { fuelType: "GASOLINE_95", pricePerLiter: "Infinity", effectiveFrom: "2097-01-25" },
    });
    await logApp.inject({
      method: "POST",
      url: "/parameters/fuel-price",
      headers: { cookie: logCookie },
      payload: { fuelType: "GASOLINE_95", pricePerLiter: "1000000", effectiveFrom: "2097-01-26" },
    });
    await logApp.inject({
      method: "POST",
      url: "/parameters/depreciation",
      headers: { cookie: logCookie },
      payload: {
        vehiclePrice: "10000000000",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2097-03-25",
      },
    });
  });

  afterAll(async () => {
    if (logApp) await logApp.close();
    if (prisma) {
      const range = { effectiveFrom: { gte: SENTINEL_START, lte: SENTINEL_END } };
      // PHASE-005a-T3b（AC-37(e)）: postFuel 改指 /parameters/fuel-price，
      // 寫入表由 FuelParameterVersion 改為 FuelPriceVersion。
      await prisma.fuelPriceVersion.deleteMany({ where: range });
      await prisma.depreciationParameterVersion.deleteMany({ where: range });
      if (logAdminId) {
        await prisma.session.deleteMany({ where: { userId: logAdminId } });
        await prisma.auditLog.deleteMany({
          where: { OR: [{ actorId: logAdminId }, { targetId: logAdminId }] },
        });
        await prisma.user.deleteMany({ where: { id: logAdminId } });
      }
      await prisma.$disconnect();
    }
  });

  it("前提成立：三個錯誤路徑確實產生了 log 輸出", () => {
    expect(logLines.length).toBeGreaterThan(0);
  });

  it("log 不含 DB／驅動層錯誤原文（numeric field overflow／out of range／22003／Prisma 查詢結構）", () => {
    const combined = logLines.join("\n").toLowerCase();
    for (const frag of [
      "numeric field overflow",
      "out of range",
      "22003",
      "invalid `prisma",
      "decimalerror",
      "insert into",
    ]) {
      expect(combined.includes(frag)).toBe(false);
    }
  });

  it("log 不含 SQL 關鍵字組合與絕對來源路徑", () => {
    const combined = logLines.join("\n");
    expect(/[A-Za-z]:\\[^"\s]*\\src\\/.test(combined)).toBe(false);
    expect(combined.includes("node_modules")).toBe(false);
  });

  it("三個請求仍被記錄為 400（未被靜默吞掉，且無 500）", () => {
    const combined = logLines.join("\n");
    expect(combined.includes('"statusCode":400')).toBe(true);
    expect(combined.includes('"statusCode":500')).toBe(false);
  });
});
