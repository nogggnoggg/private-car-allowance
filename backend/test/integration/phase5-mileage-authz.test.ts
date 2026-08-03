/**
 * Integration test: PHASE-005-T5 — 統計端點權限矩陣完整覆蓋 + `appliedFilters`
 *
 * 涵蓋（docs/specs/PHASE-005.md）：
 *  - AC-18 `appliedFilters` 回報**實際套用值**（`dateFrom`／`dateTo`／`ownerId`
 *    三欄逐一驗證，含管理員代查時 `ownerId === U`、未指定時 `=== actor.id`）。
 *  - AC-21 未登入被拒 → 401 `UNAUTHORIZED`，回應**不含任何數值欄位**。
 *  - AC-22 強制改密使用者被拒 → 403 `PASSWORD_CHANGE_REQUIRED`。
 *  - AC-24 管理員指定使用者 → **只回該使用者**統計；`appliedFilters.ownerId === U`。
 *  - AC-25 管理員未指定使用者 → 預設自己；`appliedFilters.ownerId === actor.id`。
 *  - B-22 管理員指定不存在之 `ownerId` → 200 + 0（不洩漏帳號是否存在）。
 *
 * 與 T4（`phase5-mileage-endpoint.test.ts`）的關係：T4 已覆蓋 AC-23（不靜默降級）
 * 與 B-26（403 先於 400）之個別情境；本檔的職責是把 Spec §11 測試策略表所列的
 * **{擁有者、他人一般使用者、管理員、未登入、`mustChangePassword`} ×
 * {未帶 `ownerId`、帶自己、帶他人}** 權限矩陣**系統性逐格**表達完整（另加一列
 * 停用帳號作為 §6.1 `requireAuth` 之 `isActive` 雙重防護的落地）。與 T4 重疊的
 * 斷言刻意保留——矩陣的完整性優先於去重。
 *
 * ── 權限矩陣（Spec §6.1 授權矩陣 + §11 測試策略表；逐格對照下方 describe）──
 *
 * | # | 角色（actor）              | 未帶 ownerId              | 帶自己 ownerId            | 帶他人 ownerId                    |
 * |---|---------------------------|---------------------------|---------------------------|-----------------------------------|
 * | 1 | 擁有者（USER）             | 200 · 自己的統計          | 200 · 自己的統計（B-23）  | 403 `FORBIDDEN`（AC-23）          |
 * | 2 | 他人一般使用者（USER）     | 200 · 自己的統計          | 200 · 自己的統計（B-23）  | 403 `FORBIDDEN`（AC-23，鏡像）    |
 * | 3 | 管理員（ADMIN）            | 200 · 自己（AC-25）       | 200 · 自己（AC-25）       | 200 · **該使用者**（AC-24）       |
 * | 4 | 未登入                     | 401 `UNAUTHORIZED`        | 401 `UNAUTHORIZED`        | 401 `UNAUTHORIZED`（AC-21）       |
 * | 5 | `mustChangePassword=true` | 403 `PASSWORD_CHANGE_REQUIRED` | 403 同左             | 403 同左（**非** `FORBIDDEN`）    |
 * | 6 | 停用帳號（`isActive=false`）| 401 `UNAUTHORIZED`       | 401 `UNAUTHORIZED`        | 401 `UNAUTHORIZED`                |
 *
 * 每一格的 4xx 皆逐鍵斷言 body **只有** `error`——`totalKm`／`applicationCount`／
 * `appliedFilters` 一律不得出現，且回應原文不得含任何一位使用者的里程數值
 * （靜默降級與跨使用者洩漏的實作必紅）。
 *
 * 測試紀律（Spec §11.0 / CLAUDE.md）：
 *  - 合成資料；`loginName` 前綴 `p5t5`（**刻意不含底線**，避免 SQL LIKE `_`
 *    萬用字元陷阱；且與 T4 的 `p5t4` 前綴不同 → 兩檔的前綴清理不互刪）。
 *  - 清理一律以本套件自建之 id／前綴精確比對；**禁用**全域 `deleteMany({})`。
 *  - 出差日期一律落在本套件專屬年份（2048），與其他測試檔零重疊。
 *  - 每位使用者的里程總額**兩兩相異**（111.25／222.50／333.75／444.00），
 *    使「只回該使用者統計」可用精確等值驗證，任何混入必紅。
 */
import { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** 刻意不含 `_`／`%`：可安全用於 Prisma `startsWith`（編譯為 SQL LIKE）。 */
const LOGIN_PREFIX = "p5t5";
const PASSWORD = "MileageAuthz99!";

/** 本套件專屬年份，與其他 integration 測試檔零重疊。 */
const RANGE_FROM = "2048-04-01";
const RANGE_TO = "2048-04-30";

/** 各使用者之區間內公務總里程（兩兩相異，供精確等值鑑別跨使用者混入）。 */
const OWNER_TOTAL = "111.25";
const OTHER_TOTAL = "222.50";
const ADMIN_TOTAL = "333.75";
const PWD_TOTAL = "444.00";
/** 出現在任何 4xx 回應中即代表數值洩漏。 */
const ALL_TOTALS = [OWNER_TOTAL, OTHER_TOTAL, ADMIN_TOTAL, PWD_TOTAL];

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

describeWithDb("PHASE-005-T5 — GET /statistics/mileage 權限矩陣 + appliedFilters", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let otherId: string;
  let adminId: string;
  let pwdId: string;
  let disabledId: string;

  let ownerCookie: string;
  let otherCookie: string;
  let adminCookie: string;
  let pwdCookie: string;
  let disabledCookie: string;

  const createdApplicationIds: string[] = [];

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
  }

  async function createUser(
    suffix: string,
    opts: { role?: "USER" | "ADMIN" } = {}
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}${suffix}${RUN_ID}`,
        displayName: `P5T5 ${suffix}`,
        passwordHash: await hashPassword(PASSWORD),
        role: opts.role ?? "USER",
        mustChangePassword: false,
      },
    });
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

  /** 建立一筆已完成差旅（`snapshotTotalKm` 與段落 `totalKm` 逐筆一致）。 */
  async function createCompletedTravel(opts: {
    ownerId: string;
    tripDate: string;
    segments: Array<{ totalKm: string; highwayKm: string }>;
  }): Promise<void> {
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
            purpose: "合成測試：權限矩陣",
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
  }

  /** 4xx 共用斷言：body 逐鍵只有 `error`，且原文不含任何使用者的里程數值。 */
  function expectNoDataLeak(resp: { body: string; json: () => unknown }, expectedCode: string) {
    const body = resp.json() as MileageSummaryBody;
    expect(body.error?.code).toBe(expectedCode);
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.totalKm).toBeUndefined();
    expect(body.applicationCount).toBeUndefined();
    expect(body.appliedFilters).toBeUndefined();
    for (const total of ALL_TOTALS) {
      expect(resp.body).not.toContain(total);
    }
  }

  /** 200 共用斷言：精確等值 + `appliedFilters` 三欄。 */
  function expectSummary(
    resp: { json: () => unknown },
    expected: { totalKm: string; applicationCount: number; ownerId: string }
  ) {
    const body = resp.json() as MileageSummaryBody;
    expect(body.totalKm).toBe(expected.totalKm);
    expect(body.applicationCount).toBe(expected.applicationCount);
    expect(body.appliedFilters).toEqual({
      dateFrom: RANGE_FROM,
      dateTo: RANGE_TO,
      ownerId: expected.ownerId,
    });
  }

  async function get(params: Record<string, string | undefined>, cookie?: string) {
    return app.inject({
      method: "GET",
      url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO, ...params }),
      ...(cookie ? { headers: { cookie } } : {}),
    });
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
    adminId = await createUser("admin", { role: "ADMIN" });
    pwdId = await createUser("pwd");
    disabledId = await createUser("disabled");

    ownerCookie = await login("owner");
    otherCookie = await login("other");
    adminCookie = await login("admin");
    // 先以正常狀態登入取得 session，再翻旗標／停用——`requireAuth` 依 Spec
    // §4.7.1 讀 User 的**即時值**（非 session 快照），此順序正是該語意的落地。
    pwdCookie = await login("pwd");
    disabledCookie = await login("disabled");

    // owner：40.25 + 71.00 = 111.25（兩筆）
    await createCompletedTravel({
      ownerId,
      tripDate: "2048-04-05",
      segments: [{ totalKm: "40.25", highwayKm: "10.00" }],
    });
    await createCompletedTravel({
      ownerId,
      tripDate: "2048-04-20",
      segments: [
        { totalKm: "51.00", highwayKm: "0.00" },
        { totalKm: "20.00", highwayKm: "20.00" },
      ],
    });
    // other / admin / pwd：各一筆，總額兩兩相異
    await createCompletedTravel({
      ownerId: otherId,
      tripDate: "2048-04-10",
      segments: [{ totalKm: OTHER_TOTAL, highwayKm: "0.00" }],
    });
    await createCompletedTravel({
      ownerId: adminId,
      tripDate: "2048-04-15",
      segments: [{ totalKm: ADMIN_TOTAL, highwayKm: "0.00" }],
    });
    await createCompletedTravel({
      ownerId: pwdId,
      tripDate: "2048-04-12",
      segments: [{ totalKm: PWD_TOTAL, highwayKm: "0.00" }],
    });

    await prisma.user.update({ where: { id: pwdId }, data: { mustChangePassword: true } });
    await prisma.user.update({ where: { id: disabledId }, data: { isActive: false } });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await cleanupSyntheticData();
      await prisma.$disconnect();
    }
  });

  // =========================================================================
  // 矩陣列 1 — 擁有者（USER）
  // =========================================================================

  describe("矩陣列 1／擁有者（USER）", () => {
    it("[1×未帶 ownerId] 200 with own statistics only", async () => {
      const resp = await get({}, ownerCookie);
      expect(resp.statusCode).toBe(200);
      expectSummary(resp, { totalKm: OWNER_TOTAL, applicationCount: 2, ownerId });
    });

    it("[1×帶自己 ownerId] 200, identical to omitting it (B-23)", async () => {
      const resp = await get({ ownerId }, ownerCookie);
      expect(resp.statusCode).toBe(200);
      expectSummary(resp, { totalKm: OWNER_TOTAL, applicationCount: 2, ownerId });
    });

    it("[1×帶他人 ownerId] 403 FORBIDDEN, no numeric field, no silent downgrade (AC-23)", async () => {
      const resp = await get({ ownerId: otherId }, ownerCookie);
      expect(resp.statusCode).toBe(403);
      // `expectNoDataLeak` 同時排除他人的 222.50 與自己的 111.25（靜默降級必紅）。
      expectNoDataLeak(resp, "FORBIDDEN");
    });
  });

  // =========================================================================
  // 矩陣列 2 — 他人一般使用者（USER）；與列 1 互為鏡像，證明判定對稱、非硬編碼
  // =========================================================================

  describe("矩陣列 2／他人一般使用者（USER）", () => {
    it("[2×未帶 ownerId] 200 with own statistics only", async () => {
      const resp = await get({}, otherCookie);
      expect(resp.statusCode).toBe(200);
      expectSummary(resp, { totalKm: OTHER_TOTAL, applicationCount: 1, ownerId: otherId });
    });

    it("[2×帶自己 ownerId] 200, identical to omitting it (B-23)", async () => {
      const resp = await get({ ownerId: otherId }, otherCookie);
      expect(resp.statusCode).toBe(200);
      expectSummary(resp, { totalKm: OTHER_TOTAL, applicationCount: 1, ownerId: otherId });
    });

    it("[2×帶他人 ownerId] 403 FORBIDDEN — mirror of row 1, no numeric field", async () => {
      const resp = await get({ ownerId }, otherCookie);
      expect(resp.statusCode).toBe(403);
      expectNoDataLeak(resp, "FORBIDDEN");
    });

    it("[2×帶管理員 ownerId] 403 FORBIDDEN — 管理員資料同樣受保護", async () => {
      const resp = await get({ ownerId: adminId }, otherCookie);
      expect(resp.statusCode).toBe(403);
      expectNoDataLeak(resp, "FORBIDDEN");
    });
  });

  // =========================================================================
  // 矩陣列 3 — 管理員（ADMIN）：AC-24 / AC-25 / B-22
  // =========================================================================

  describe("矩陣列 3／管理員（ADMIN）", () => {
    it("[3×未帶 ownerId] AC-25 defaults to self — appliedFilters.ownerId === actor.id", async () => {
      const resp = await get({}, adminCookie);
      expect(resp.statusCode).toBe(200);
      expectSummary(resp, { totalKm: ADMIN_TOTAL, applicationCount: 1, ownerId: adminId });
      // 反向鑑別：未指定時**不得**成為「全體合計」或任一他人數值。
      const body = resp.json() as MileageSummaryBody;
      expect(body.totalKm).not.toBe(OWNER_TOTAL);
      expect(body.totalKm).not.toBe(OTHER_TOTAL);
    });

    it("[3×帶自己 ownerId] AC-25 same as omitting it", async () => {
      const resp = await get({ ownerId: adminId }, adminCookie);
      expect(resp.statusCode).toBe(200);
      expectSummary(resp, { totalKm: ADMIN_TOTAL, applicationCount: 1, ownerId: adminId });
    });

    it("[3×帶他人 ownerId=U] AC-24 returns ONLY U's statistics (two distinct users)", async () => {
      // U = owner（111.25／2 筆）
      const asOwner = await get({ ownerId }, adminCookie);
      expect(asOwner.statusCode).toBe(200);
      expectSummary(asOwner, { totalKm: OWNER_TOTAL, applicationCount: 2, ownerId });
      // 精確等值已排除「混入管理員自己 333.75」「混入 other 222.50」「全體合計」。
      expect(asOwner.body).not.toContain(ADMIN_TOTAL);
      expect(asOwner.body).not.toContain(OTHER_TOTAL);

      // U = other（222.50／1 筆）——換一位使用者仍精確對應，證明非硬編碼。
      const asOther = await get({ ownerId: otherId }, adminCookie);
      expect(asOther.statusCode).toBe(200);
      expectSummary(asOther, { totalKm: OTHER_TOTAL, applicationCount: 1, ownerId: otherId });
      expect(asOther.body).not.toContain(OWNER_TOTAL);
      expect(asOther.body).not.toContain(ADMIN_TOTAL);
    });

    it("[3×帶不存在的 ownerId] B-22 → 200 + 0，不洩漏帳號是否存在", async () => {
      const ghostId = `${LOGIN_PREFIX}ghost${RUN_ID}`;
      const resp = await get({ ownerId: ghostId }, adminCookie);
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as MileageSummaryBody;
      expect(body.totalKm).toBe("0.00");
      expect(body.applicationCount).toBe(0);
      expect(body.appliedFilters?.ownerId).toBe(ghostId);
      // 與「存在但無資料」之回應形狀完全相同 → 不構成帳號存在性的側信道。
      expect(resp.statusCode).not.toBe(404);
      expect(body.error).toBeUndefined();
    });
  });

  // =========================================================================
  // 矩陣列 4 — 未登入（AC-21）
  // =========================================================================

  describe("矩陣列 4／未登入（AC-21）", () => {
    it("[4×未帶 ownerId] 401 UNAUTHORIZED with no numeric fields", async () => {
      const resp = await get({});
      expect(resp.statusCode).toBe(401);
      expectNoDataLeak(resp, "UNAUTHORIZED");
    });

    it("[4×帶自己 ownerId] 401 — 帶 id 不構成身分", async () => {
      const resp = await get({ ownerId });
      expect(resp.statusCode).toBe(401);
      expectNoDataLeak(resp, "UNAUTHORIZED");
    });

    it("[4×帶他人 ownerId] 401 — 認證先於授權，非 403", async () => {
      const resp = await get({ ownerId: adminId });
      expect(resp.statusCode).toBe(401);
      expectNoDataLeak(resp, "UNAUTHORIZED");
      // 反向鑑別：未登入不得因 `ownerId` 差異而回不同錯誤碼。
      expect((resp.json() as MileageSummaryBody).error?.code).not.toBe("FORBIDDEN");
    });
  });

  // =========================================================================
  // 矩陣列 5 — 強制改密（AC-22）
  // =========================================================================

  describe("矩陣列 5／強制改密 mustChangePassword=true（AC-22）", () => {
    it("[5×未帶 ownerId] 403 PASSWORD_CHANGE_REQUIRED with no numeric fields", async () => {
      const resp = await get({}, pwdCookie);
      expect(resp.statusCode).toBe(403);
      expectNoDataLeak(resp, "PASSWORD_CHANGE_REQUIRED");
      // 反向鑑別：此使用者**自己有** 444.00 的資料，仍不得回傳。
      expect(resp.body).not.toContain(PWD_TOTAL);
    });

    it("[5×帶自己 ownerId] 403 PASSWORD_CHANGE_REQUIRED", async () => {
      const resp = await get({ ownerId: pwdId }, pwdCookie);
      expect(resp.statusCode).toBe(403);
      expectNoDataLeak(resp, "PASSWORD_CHANGE_REQUIRED");
    });

    it("[5×帶他人 ownerId] 403 PASSWORD_CHANGE_REQUIRED — 中介層先於 resolveOwnerId", async () => {
      const resp = await get({ ownerId }, pwdCookie);
      expect(resp.statusCode).toBe(403);
      expectNoDataLeak(resp, "PASSWORD_CHANGE_REQUIRED");
      // 順序固定：`requirePasswordChanged` 在 route handler 之前 → 不是 FORBIDDEN。
      expect((resp.json() as MileageSummaryBody).error?.code).not.toBe("FORBIDDEN");
    });
  });

  // =========================================================================
  // 矩陣列 6 — 停用帳號（§6.1 `requireAuth` 之 isActive 即時值防護）
  // =========================================================================

  describe("矩陣列 6／停用帳號 isActive=false", () => {
    it("[6×未帶 ownerId] 401 UNAUTHORIZED — session 仍在，但 isActive 即時值為權威", async () => {
      const resp = await get({}, disabledCookie);
      expect(resp.statusCode).toBe(401);
      expectNoDataLeak(resp, "UNAUTHORIZED");
    });

    it("[6×帶自己 ownerId] 401 UNAUTHORIZED", async () => {
      const resp = await get({ ownerId: disabledId }, disabledCookie);
      expect(resp.statusCode).toBe(401);
      expectNoDataLeak(resp, "UNAUTHORIZED");
    });

    it("[6×帶他人 ownerId] 401 UNAUTHORIZED（非 403）", async () => {
      const resp = await get({ ownerId }, disabledCookie);
      expect(resp.statusCode).toBe(401);
      expectNoDataLeak(resp, "UNAUTHORIZED");
      expect((resp.json() as MileageSummaryBody).error?.code).not.toBe("FORBIDDEN");
    });
  });

  // =========================================================================
  // AC-18 — appliedFilters 回報**實際套用值**（三欄逐一）
  // =========================================================================

  describe("AC-18 appliedFilters 回報實際套用值", () => {
    it("appliedFilters reports the effective dateFrom/dateTo/ownerId", async () => {
      const resp = await get({}, ownerCookie);
      expect(resp.statusCode).toBe(200);
      const filters = (resp.json() as MileageSummaryBody).appliedFilters;

      // 三欄逐一：型別、格式（YYYY-MM-DD）、值。
      expect(typeof filters?.dateFrom).toBe("string");
      expect(typeof filters?.dateTo).toBe("string");
      expect(typeof filters?.ownerId).toBe("string");
      expect(filters?.dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(filters?.dateTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(filters?.dateFrom).toBe(RANGE_FROM);
      expect(filters?.dateTo).toBe(RANGE_TO);
      expect(filters?.ownerId).toBe(ownerId);
      // 鍵集合封閉（AC-26 之 appliedFilters 子物件）。
      expect(Object.keys(filters as object).sort()).toEqual(["dateFrom", "dateTo", "ownerId"]);
    });

    it("echoes the ACTUAL range requested, not a default one (AC-01 可由回應自證)", async () => {
      // 窄區間：只涵蓋 2048-04-05 那筆（40.25），與寬區間的 111.25 明確可分。
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: "2048-04-05", dateTo: "2048-04-05" }),
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as MileageSummaryBody;
      expect(body.appliedFilters).toEqual({
        dateFrom: "2048-04-05",
        dateTo: "2048-04-05",
        ownerId,
      });
      // 回報的區間確實是被套用的那一個（若實作套了別的區間，數值必不符）。
      expect(body.totalKm).toBe("40.25");
      expect(body.applicationCount).toBe(1);
    });

    it("admin proxy query reports ownerId === U (AC-24 可由回應自證)", async () => {
      const resp = await get({ ownerId: otherId }, adminCookie);
      expect(resp.statusCode).toBe(200);
      const filters = (resp.json() as MileageSummaryBody).appliedFilters;
      expect(filters?.ownerId).toBe(otherId);
      expect(filters?.ownerId).not.toBe(adminId);
    });

    it("admin query without ownerId reports ownerId === actor.id (AC-25 可由回應自證)", async () => {
      const resp = await get({}, adminCookie);
      expect(resp.statusCode).toBe(200);
      const filters = (resp.json() as MileageSummaryBody).appliedFilters;
      expect(filters?.ownerId).toBe(adminId);
      expect(filters?.ownerId).not.toBe(ownerId);
      expect(filters?.ownerId).not.toBe(otherId);
    });
  });
});
