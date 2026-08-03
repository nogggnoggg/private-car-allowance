/**
 * Integration test: PHASE-005-T4 — 統計端點 `GET /statistics/mileage`
 *
 * TDD: 本檔於 `backend/src/mileage/routes.ts` 存在**之前**寫成，首輪預期 RED
 * （模組不存在 → import 失敗；即使 import 成功，route 未於 `server.ts` 註冊
 * 時每個請求都會是 404）。
 *
 * 涵蓋（docs/specs/PHASE-005.md）：
 *  - AC-14 個人區間統計查詢成功（200 + DTO 形狀逐鍵）。
 *  - AC-09（HTTP 層）無有效差旅 → 200、`totalKm === "0.00"`、非 `null`、非 404。
 *  - AC-15 缺 `dateFrom`／缺 `dateTo`／兩者皆缺 → 400 `VALIDATION_ERROR`，
 *    `fields` 可定位；不套用任何預設區間、不回傳數值。
 *  - AC-16 日期格式錯誤（`2026-13-01`／`2026/03/01`／`abc`／空字串）→ 400，
 *    `fields[].field` 為 `dateFrom`／`dateTo`。
 *  - AC-17 起>迄 → 400 且 `fields` 含 `{ field: "dateRange", reason: zh-TW }`。
 *  - AC-23 一般使用者自帶他人 `ownerId` → 403 `FORBIDDEN`，body 逐鍵無任何
 *    數值欄位，且**不得**靜默降級為自己的數值。
 *  - B-26 判定順序：同時帶他人 `ownerId` 與非法日期 → 恆 403（非 400）。
 *  - AC-21 方向（正式驗證屬 T5）：route `requireAuth` 自始掛載 → 未登入 401。
 *  - 里程格式化 ≥6 例（DTO 層，D3(a)：字串、固定 2 位小數、未取整）。
 *
 * 測試紀律（Spec §11.0 / CLAUDE.md）：
 *  - 合成資料；`loginName` 前綴 `p5t4`（**刻意不含底線**，避免 PHASE-004 R6
 *    的 SQL LIKE `_` 萬用字元陷阱）+ per-run 隨機碼。
 *  - 清理一律以本套件自建之 id 陣列精確比對；**禁用**全域 `deleteMany({})`。
 *  - 出差日期一律落在本套件專屬年份（2047），與其他測試檔零重疊。
 *  - 固定資料由 `prisma` 直接建立（本 Task 驗的是 route 層授權／驗證／DTO，
 *    完成流程之真實性已由 T2/T3 於引擎層以真實 `completeTravelApplication`
 *    驗證）；`snapshotTotalKm` 與其 `TripSegment.totalKm` 逐筆一致建立，
 *    使 AC-13 之快照不變式在本檔建立的資料上同樣成立。
 */
import { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { formatMileageKm } from "../../src/mileage/routes.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** 刻意不含 `_`／`%`：可安全用於 Prisma `startsWith`（編譯為 SQL LIKE）。 */
const LOGIN_PREFIX = "p5t4";
const PASSWORD = "MileageEndpoint99!";

/** 本套件專屬年份，與其他 integration 測試檔零重疊。 */
const RANGE_FROM = "2047-03-01";
const RANGE_TO = "2047-03-31";

// ---------------------------------------------------------------------------
// 里程格式化（DTO 層，D3(a)）——純函式，不需 DB，故置於 describeWithDb 之外。
// ---------------------------------------------------------------------------

describe("PHASE-005-T4 — formatMileageKm（DTO 層里程格式化，D3(a)）", () => {
  it("returns a fixed 2-decimal string for every representative Decimal (≥6 cases)", () => {
    // 陷阱（期中 Review 前瞻風險 2）：`new Prisma.Decimal("10.00").toString()`
    // 回傳 `"10"`（decimal.js 去除尾端 0）。以下 `"10.00"`／`"30.10"`／`"0.50"`
    // 三例即是此陷阱的鑑別力核心——任何以 `toString()` 實作者必紅。
    expect(formatMileageKm(new Prisma.Decimal("0"))).toBe("0.00");
    expect(formatMileageKm(new Prisma.Decimal("0.00"))).toBe("0.00");
    expect(formatMileageKm(new Prisma.Decimal("10.00"))).toBe("10.00");
    expect(formatMileageKm(new Prisma.Decimal("35.75"))).toBe("35.75");
    expect(formatMileageKm(new Prisma.Decimal("30.03"))).toBe("30.03");
    expect(formatMileageKm(new Prisma.Decimal("30.1"))).toBe("30.10");
    expect(formatMileageKm(new Prisma.Decimal("0.5"))).toBe("0.50");
    expect(formatMileageKm(new Prisma.Decimal("1234567.89"))).toBe("1234567.89");
  });

  it("returns a string type — never a JSON number (D3(a) 傳輸以字串表示 Decimal)", () => {
    const formatted = formatMileageKm(new Prisma.Decimal("35.75"));
    expect(typeof formatted).toBe("string");
    // 反向鑑別：若實作回 number，下面兩條任一必紅。
    expect(formatted).not.toBe(35.75);
    expect(JSON.parse(JSON.stringify({ totalKm: formatted })).totalKm).toBe("35.75");
  });

  it("does NOT round mileage to an integer (AC-11：本 Phase 對里程不做任何取整)", () => {
    expect(formatMileageKm(new Prisma.Decimal("30.03"))).not.toBe("30");
    expect(formatMileageKm(new Prisma.Decimal("30.03"))).not.toBe("30.00");
    expect(formatMileageKm(new Prisma.Decimal("12345.67"))).toBe("12345.67");
  });
});

// ---------------------------------------------------------------------------
// 端點整合測試
// ---------------------------------------------------------------------------

interface MileageSummaryBody {
  totalKm?: unknown;
  applicationCount?: unknown;
  appliedFilters?: { dateFrom?: unknown; dateTo?: unknown; ownerId?: unknown };
  error?: { code?: string; message?: string; requestId?: string; fields?: unknown };
}

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0];
}

function buildUrl(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) usp.set(key, value);
  }
  const qs = usp.toString();
  return qs.length > 0 ? `/statistics/mileage?${qs}` : "/statistics/mileage";
}

describeWithDb("PHASE-005-T4 — GET /statistics/mileage", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let otherId: string;
  let emptyOwnerId: string;
  let ownerCookie: string;
  let otherCookie: string;
  let emptyOwnerCookie: string;

  const createdApplicationIds: string[] = [];
  const createdUserIds: string[] = [];

  async function cleanupSyntheticData() {
    if (createdApplicationIds.length > 0) {
      await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
    }
    // LIKE-safe 前綴（不含 `_`／`%`），再以 JS 字面 startsWith 收斂為權威判定。
    const candidates = await prisma.user.findMany({
      where: { loginName: { startsWith: LOGIN_PREFIX } },
      select: { id: true, loginName: true },
    });
    const ownUserIds = candidates
      .filter((u) => u.loginName.startsWith(LOGIN_PREFIX))
      .map((u) => u.id);
    if (ownUserIds.length > 0) {
      await prisma.application.deleteMany({ where: { ownerId: { in: ownUserIds } } });
      await prisma.session.deleteMany({ where: { userId: { in: ownUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: ownUserIds } } });
    }
    createdApplicationIds.length = 0;
    createdUserIds.length = 0;
  }

  async function createUser(
    suffix: string,
    opts: { role?: "USER" | "ADMIN" } = {}
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}${suffix}${RUN_ID}`,
        displayName: `P5T4 ${suffix}`,
        passwordHash: await hashPassword(PASSWORD),
        role: opts.role ?? "USER",
        mustChangePassword: false,
      },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  async function login(suffix: string): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: `${LOGIN_PREFIX}${suffix}${RUN_ID}`, password: PASSWORD },
    });
    if (resp.statusCode !== 200) {
      throw new Error(`Login failed for ${suffix}: ${resp.statusCode} ${resp.body}`);
    }
    return extractCookieHeader(resp.headers["set-cookie"]);
  }

  /**
   * 建立一筆已完成差旅：`snapshotTotalKm` 與其段落 `totalKm` 一致（AC-13 不變式
   * 在本檔資料上同樣成立），`highwayKm` 為 `totalKm` 的一部分（不重複加）。
   */
  async function createCompletedTravel(opts: {
    ownerId: string;
    tripDate: string;
    segments: Array<{ totalKm: string; highwayKm: string }>;
  }): Promise<string> {
    const snapshot = opts.segments.reduce(
      (acc, seg) => acc.plus(new Prisma.Decimal(seg.totalKm)),
      new Prisma.Decimal("0")
    );
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: opts.ownerId,
        createdById: opts.ownerId,
        primaryDate: new Date(opts.tripDate),
        travel: {
          create: {
            tripDate: new Date(opts.tripDate),
            purpose: "合成測試：區間統計端點",
            snapshotTotalKm: snapshot,
          },
        },
      },
    });
    createdApplicationIds.push(application.id);
    for (const [i, seg] of opts.segments.entries()) {
      await prisma.tripSegment.create({
        data: {
          travelApplicationId: application.id,
          sortOrder: i,
          origin: "合成起點",
          destination: "合成迄點",
          totalKm: seg.totalKm,
          highwayKm: seg.highwayKm,
        },
      });
    }
    return application.id;
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    await cleanupSyntheticData();

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "silent" });
    await app.ready();

    ownerId = await createUser("owner");
    otherId = await createUser("other");
    emptyOwnerId = await createUser("empty");

    ownerCookie = await login("owner");
    otherCookie = await login("other");
    emptyOwnerCookie = await login("empty");

    // owner：區間內兩筆已完成差旅 → 10.00 + 25.75 = 35.75
    await createCompletedTravel({
      ownerId,
      tripDate: "2047-03-05",
      segments: [{ totalKm: "10.00", highwayKm: "10.00" }],
    });
    await createCompletedTravel({
      ownerId,
      tripDate: "2047-03-20",
      segments: [
        { totalKm: "5.50", highwayKm: "0.00" },
        { totalKm: "20.25", highwayKm: "8.00" },
      ],
    });

    // other：同區間內一筆已完成差旅（AC-23 之「不得回傳他人數值」對照組）
    await createCompletedTravel({
      ownerId: otherId,
      tripDate: "2047-03-10",
      segments: [{ totalKm: "777.00", highwayKm: "0.00" }],
    });

    // emptyOwner：刻意不建立任何申請（AC-09 HTTP 層）
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await cleanupSyntheticData();
      await prisma.$disconnect();
    }
  });

  // -------------------------------------------------------------------------
  // AC-14 — 成功查詢
  // -------------------------------------------------------------------------

  describe("AC-14 個人區間統計查詢成功", () => {
    it("authenticated user gets 200 with own range mileage", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }),
        headers: { cookie: ownerCookie },
      });

      expect(resp.statusCode).toBe(200);
      const body = resp.json() as MileageSummaryBody;
      // 精確等值（非「非零」）：10.00 + 5.50 + 20.25 = 35.75。
      // 若他人（777.00）混入得 812.75；若高速重複加得 53.75——皆必紅。
      expect(body.totalKm).toBe("35.75");
      expect(body.applicationCount).toBe(2);
    });

    it("returns the DTO shape key by key (totalKm / applicationCount / appliedFilters)", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }),
        headers: { cookie: ownerCookie },
      });

      expect(resp.statusCode).toBe(200);
      const body = resp.json() as MileageSummaryBody;
      expect(typeof body.totalKm).toBe("string");
      expect(typeof body.applicationCount).toBe("number");
      expect(body.appliedFilters).toEqual({
        dateFrom: RANGE_FROM,
        dateTo: RANGE_TO,
        ownerId,
      });
    });

    it("a normal user may pass their OWN ownerId — equivalent to omitting it (B-23)", async () => {
      const withOwn = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO, ownerId }),
        headers: { cookie: ownerCookie },
      });

      expect(withOwn.statusCode).toBe(200);
      const body = withOwn.json() as MileageSummaryBody;
      expect(body.totalKm).toBe("35.75");
      expect(body.appliedFilters?.ownerId).toBe(ownerId);
    });

    it("dateFrom == dateTo is legal (single-day statistics) and isolates that day only", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: "2047-03-05", dateTo: "2047-03-05" }),
        headers: { cookie: ownerCookie },
      });

      expect(resp.statusCode).toBe(200);
      const body = resp.json() as MileageSummaryBody;
      expect(body.totalKm).toBe("10.00");
      expect(body.applicationCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // AC-09（HTTP 層）— 無有效差旅
  // -------------------------------------------------------------------------

  describe("AC-09（HTTP 層）無有效差旅", () => {
    it('returns 200 with "0.00" when no eligible travel exists (not null, not empty string, not 404)', async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }),
        headers: { cookie: emptyOwnerCookie },
      });

      // 四斷言：200／`"0.00"`／非 null／非 404
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as MileageSummaryBody;
      expect(body.totalKm).toBe("0.00");
      expect(body.totalKm).not.toBeNull();
      expect(resp.statusCode).not.toBe(404);
      // 補強：非空字串、非 JSON number 0、筆數為 0
      expect(body.totalKm).not.toBe("");
      expect(body.totalKm).not.toBe(0);
      expect(body.applicationCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // AC-15 — 缺漏必填（D5(a)）
  // -------------------------------------------------------------------------

  describe("AC-15 缺 dateFrom / dateTo → 400", () => {
    it("missing dateFrom / dateTo returns 400 with locating fields", async () => {
      const missingFrom = await app.inject({
        method: "GET",
        url: buildUrl({ dateTo: RANGE_TO }),
        headers: { cookie: ownerCookie },
      });
      expect(missingFrom.statusCode).toBe(400);
      const fromBody = missingFrom.json() as MileageSummaryBody;
      expect(fromBody.error?.code).toBe("VALIDATION_ERROR");
      expect(fromBody.error?.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "dateFrom" })])
      );
      // 不得套用任何預設區間、不得回傳數值（AC-15 原文）
      expect(fromBody.totalKm).toBeUndefined();
      expect(fromBody.applicationCount).toBeUndefined();
      expect(fromBody.appliedFilters).toBeUndefined();

      const missingTo = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM }),
        headers: { cookie: ownerCookie },
      });
      expect(missingTo.statusCode).toBe(400);
      const toBody = missingTo.json() as MileageSummaryBody;
      expect(toBody.error?.code).toBe("VALIDATION_ERROR");
      expect(toBody.error?.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "dateTo" })])
      );
      expect(toBody.totalKm).toBeUndefined();
    });

    it("both missing returns 400 locating BOTH fields (not just the first)", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({}),
        headers: { cookie: ownerCookie },
      });

      expect(resp.statusCode).toBe(400);
      const body = resp.json() as MileageSummaryBody;
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      const fields = body.error?.fields as Array<{ field: string; reason: string }>;
      expect(fields.map((f) => f.field).sort()).toEqual(["dateFrom", "dateTo"]);
      for (const f of fields) {
        expect(typeof f.reason).toBe("string");
        expect(f.reason.length).toBeGreaterThan(0);
      }
      expect(body.totalKm).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // AC-16 — 日期格式錯誤
  // -------------------------------------------------------------------------

  describe("AC-16 日期格式錯誤 → 400", () => {
    const malformed = ["2026-13-01", "2026/03/01", "abc", ""];

    it("malformed dates return 400 VALIDATION_ERROR", async () => {
      for (const raw of malformed) {
        const resp = await app.inject({
          method: "GET",
          url: buildUrl({ dateFrom: raw, dateTo: RANGE_TO }),
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode, `dateFrom=${JSON.stringify(raw)}`).toBe(400);
        const body = resp.json() as MileageSummaryBody;
        expect(body.error?.code).toBe("VALIDATION_ERROR");
        expect(body.error?.fields).toEqual(
          expect.arrayContaining([expect.objectContaining({ field: "dateFrom" })])
        );
        expect(body.totalKm).toBeUndefined();
      }
    });

    it("malformed dateTo locates the dateTo field (not dateFrom)", async () => {
      for (const raw of malformed) {
        const resp = await app.inject({
          method: "GET",
          url: buildUrl({ dateFrom: RANGE_FROM, dateTo: raw }),
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode, `dateTo=${JSON.stringify(raw)}`).toBe(400);
        const body = resp.json() as MileageSummaryBody;
        const fields = body.error?.fields as Array<{ field: string }>;
        expect(fields.map((f) => f.field)).toContain("dateTo");
        expect(fields.map((f) => f.field)).not.toContain("dateFrom");
      }
    });
  });

  // -------------------------------------------------------------------------
  // AC-17 — 起 > 迄
  // -------------------------------------------------------------------------

  describe("AC-17 起>迄 → 400 且欄位可定位", () => {
    it('dateFrom > dateTo returns 400 with fields[].field === "dateRange"', async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: "2047-03-31", dateTo: "2047-03-01" }),
        headers: { cookie: ownerCookie },
      });

      expect(resp.statusCode).toBe(400);
      const body = resp.json() as MileageSummaryBody;
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      const fields = body.error?.fields as Array<{ field: string; reason: string }>;
      const rangeError = fields.find((f) => f.field === "dateRange");
      expect(rangeError).toBeDefined();
      // zh-TW 區間錯誤說明（非空、非英文代碼）
      expect(rangeError?.reason).toMatch(/[一-鿿]/);
      expect(body.totalKm).toBeUndefined();
    });

    it("minimal 1-day inversion (dateFrom = dateTo + 1) is rejected the same way", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: "2047-03-02", dateTo: "2047-03-01" }),
        headers: { cookie: ownerCookie },
      });

      expect(resp.statusCode).toBe(400);
      const fields = (resp.json() as MileageSummaryBody).error?.fields as Array<{ field: string }>;
      expect(fields.map((f) => f.field)).toContain("dateRange");
    });
  });

  // -------------------------------------------------------------------------
  // AC-23 — 資料隔離：不靜默降級
  // -------------------------------------------------------------------------

  describe("AC-23 一般使用者自帶他人 ownerId → 403，不靜默降級", () => {
    it("normal user passing another ownerId gets 403 and no silent downgrade to own data", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO, ownerId: otherId }),
        headers: { cookie: ownerCookie },
      });

      expect(resp.statusCode).toBe(403);
      const body = resp.json() as MileageSummaryBody;
      expect(body.error?.code).toBe("FORBIDDEN");

      // body 逐鍵：僅有 `error`，不得出現任何數值欄位（他人的 777.00，也不得
      // 靜默降級回自己的 35.75）。
      expect(Object.keys(body)).toEqual(["error"]);
      expect(body.totalKm).toBeUndefined();
      expect(body.applicationCount).toBeUndefined();
      expect(body.appliedFilters).toBeUndefined();
      expect(resp.body).not.toContain("777");
      expect(resp.body).not.toContain("35.75");
    });

    it("the other user's own request still succeeds — 403 is about the actor, not the data", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }),
        headers: { cookie: otherCookie },
      });

      expect(resp.statusCode).toBe(200);
      expect((resp.json() as MileageSummaryBody).totalKm).toBe("777.00");
    });
  });

  // -------------------------------------------------------------------------
  // B-26 — 判定順序（403 優先於 400）
  // -------------------------------------------------------------------------

  describe("B-26 判定順序：授權（403）優先於格式（400）", () => {
    it("another ownerId + malformed dates → always 403, never 400 (no format side-channel)", async () => {
      for (const raw of ["2026-13-01", "abc", ""]) {
        const resp = await app.inject({
          method: "GET",
          url: buildUrl({ dateFrom: raw, dateTo: RANGE_TO, ownerId: otherId }),
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode, `dateFrom=${JSON.stringify(raw)}`).toBe(403);
        expect((resp.json() as MileageSummaryBody).error?.code).toBe("FORBIDDEN");
      }
    });

    it("another ownerId + inverted range → 403 (not the dateRange 400)", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: "2047-03-31", dateTo: "2047-03-01", ownerId: otherId }),
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.body).not.toContain("dateRange");
    });

    it("another ownerId + missing dates → 403 (not the required-field 400)", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ ownerId: otherId }),
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(403);
      expect((resp.json() as MileageSummaryBody).error?.code).toBe("FORBIDDEN");
    });
  });

  // -------------------------------------------------------------------------
  // route 自始掛載 requireAuth（AC-21 之正式驗證屬 T5；此處證明「自始掛載」）
  // -------------------------------------------------------------------------

  describe("requireAuth + requirePasswordChanged 自始掛載", () => {
    it("unauthenticated request returns 401 with no numeric fields (never 404, never 200)", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }),
      });

      expect(resp.statusCode).toBe(401);
      const body = resp.json() as MileageSummaryBody;
      expect(body.error?.code).toBe("UNAUTHORIZED");
      expect(Object.keys(body)).toEqual(["error"]);
      expect(body.totalKm).toBeUndefined();
      expect(body.applicationCount).toBeUndefined();
    });

    it("unauthenticated request with another ownerId also returns 401 (auth before authz)", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO, ownerId: otherId }),
      });

      expect(resp.statusCode).toBe(401);
      expect(resp.body).not.toContain("777");
    });
  });
});
