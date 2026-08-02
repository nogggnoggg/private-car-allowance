/**
 * Integration tests for PHASE-004-T9:
 *   個人綜合紀錄查詢 `GET /applications` — 日期／類型／狀態／關鍵字篩選、
 *   分頁、排序、授權隔離。
 *
 * TDD: written to exercise the real HTTP route registered by buildServer().
 * First run (before routes.ts wiring existed) is expected RED — 404 on every
 * `GET /applications` call (unknown route) until this Task's route/service
 * code lands.
 *
 * AC covered (PHASE-004 Spec §2, Packet Done When):
 *   AC-60~71, AC-74, AC-76, AC-84, AC-91.
 *
 * Test discipline (Spec §11.0 / Packet C5):
 *   - loginName prefix "p4t9_" + per-run random suffix (跨檔跨 fork 撞名防護)
 *   - EVERY test group uses its own dedicated owner user(s) — this file never
 *     asserts a global/table-wide count. All assertions are scoped to
 *     Application rows created by THIS suite for a specific owner id, so the
 *     ~700+ residual DRAFT rows left behind by other test files (C5 硬性約束
 *     明文警告) cannot affect any assertion here.
 *   - cleanup scoped to this suite's own tracked application ids + loginName
 *     prefix; NEVER deleteMany({}) globally.
 *   - synthetic data only (虛構人名、地名、出差目的)
 *   - Application rows are created DIRECTLY via prisma (not through the
 *     travel-draft HTTP endpoints) so `primaryDate`/`createdAt`/`status`/
 *     `totalAmount`/snapshot fields can be fully controlled without any
 *     dependency on fuel/ETC parameter versions (this endpoint never touches
 *     the parameters tables at all).
 */
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultDateFrom } from "../../src/applications/application-query.js";
import { hashPassword } from "../../src/auth/password.js";
import { formatUtcDate } from "../../src/parameters/parameter-service.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Shared helpers (pattern per phase4-travel-draft.test.ts)
// ---------------------------------------------------------------------------

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0];
}

async function loginUser(
  app: FastifyInstance,
  loginName: string,
  password: string
): Promise<string> {
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

function buildQuery(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) usp.set(key, String(value));
  }
  const qs = usp.toString();
  return qs.length > 0 ? `/applications?${qs}` : "/applications";
}

interface ListItem {
  id: string;
  type: string;
  status: string;
  primaryDate: string;
  tripDate: string | null;
  title: string | null;
  totalKm: string | null;
  totalAmount: number | null;
  segmentCount: number | null;
  ownerId: string;
  ownerDisplayName: string;
  onBehalf: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ListResponse {
  items: ListItem[];
  page: number;
  pageSize: number;
  total: number;
  appliedFilters: {
    dateFrom: string | null;
    dateTo: string | null;
    type: string | null;
    status: string | null;
    keyword: string | null;
    ownerId: string;
  };
}

// Per-process random suffix (PHASE-004-R1 discipline) — avoids cross-file/fork collisions.
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p4t9_";
const PASSWORD = "AppQueryTest99!";

describeWithDb("PHASE-004-T9 — GET /applications 綜合紀錄查詢", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  // Users shared by the authorization-matrix group.
  let ownerId: string;
  let otherId: string;
  let adminId: string;
  let mcpId: string;
  let ownerCookie: string;
  let otherCookie: string;
  let adminCookie: string;
  let mcpCookie: string;

  // Dedicated owners per test group (see file header — isolation discipline).
  let pagingOwnerId: string;
  let pagingOwnerCookie: string;
  let boundaryOwnerId: string;
  let boundaryOwnerCookie: string;
  let keywordOwnerId: string;
  let keywordOwnerCookie: string;
  let emptyOwnerId: string;
  let emptyOwnerCookie: string;
  let andOwnerId: string;
  let andOwnerCookie: string;
  let dtoOwnerId: string;
  let dtoOwnerCookie: string;
  let wildcardOwnerId: string;
  let wildcardOwnerCookie: string;

  const createdApplicationIds: string[] = [];
  function track(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  async function createUser(
    loginSuffix: string,
    opts: Partial<{ role: "USER" | "ADMIN"; mustChangePassword: boolean }> = {}
  ) {
    const hash = await hashPassword(PASSWORD);
    return prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}${loginSuffix}_${RUN_ID}`,
        displayName: `P4T9 ${loginSuffix}`,
        passwordHash: hash,
        role: opts.role ?? "USER",
        isActive: true,
        mustChangePassword: opts.mustChangePassword ?? false,
      },
    });
  }

  /** Directly-created synthetic Application row — full control over primaryDate/createdAt/status/snapshot. */
  async function createApp(opts: {
    ownerId: string;
    createdById?: string;
    type?: "TRAVEL" | "MAINTENANCE" | "DEPRECIATION";
    status?: "DRAFT" | "COMPLETED" | "VOIDED";
    primaryDate: string;
    createdAt?: Date;
    tripDate?: string | null;
    purpose?: string | null;
    totalAmount?: number | null;
    snapshotTotalKm?: string | null;
    withTravel?: boolean; // default true when type TRAVEL
  }) {
    const type = opts.type ?? "TRAVEL";
    const isTravel = type === "TRAVEL";
    const withTravel = opts.withTravel ?? isTravel;

    const application = await prisma.application.create({
      data: {
        type,
        status: opts.status ?? "DRAFT",
        ownerId: opts.ownerId,
        createdById: opts.createdById ?? opts.ownerId,
        primaryDate: new Date(opts.primaryDate),
        totalAmount: opts.totalAmount ?? null,
        completedAt: opts.status === "COMPLETED" ? new Date() : null,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        ...(withTravel
          ? {
              travel: {
                create: {
                  tripDate:
                    opts.tripDate !== undefined && opts.tripDate !== null
                      ? new Date(opts.tripDate)
                      : null,
                  purpose: opts.purpose ?? null,
                  snapshotTotalKm: opts.snapshotTotalKm ?? null,
                },
              },
            }
          : {}),
      },
    });
    track(application.id);
    return application;
  }

  async function getList(cookie: string, params: Record<string, string | number | undefined> = {}) {
    return app.inject({
      method: "GET",
      url: buildQuery(params),
      headers: { cookie },
    });
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const owner = await createUser("owner");
    const other = await createUser("other");
    const admin = await createUser("admin", { role: "ADMIN" });
    const mcp = await createUser("mcp", { mustChangePassword: true });
    const pagingOwner = await createUser("paging");
    const boundaryOwner = await createUser("boundary");
    const keywordOwner = await createUser("keyword");
    const emptyOwner = await createUser("empty");
    const andOwner = await createUser("and");
    const dtoOwner = await createUser("dto");
    const wildcardOwner = await createUser("wildcard");

    ownerId = owner.id;
    otherId = other.id;
    adminId = admin.id;
    mcpId = mcp.id;
    pagingOwnerId = pagingOwner.id;
    boundaryOwnerId = boundaryOwner.id;
    keywordOwnerId = keywordOwner.id;
    emptyOwnerId = emptyOwner.id;
    andOwnerId = andOwner.id;
    dtoOwnerId = dtoOwner.id;
    wildcardOwnerId = wildcardOwner.id;

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    ownerCookie = await loginUser(app, owner.loginName, PASSWORD);
    otherCookie = await loginUser(app, other.loginName, PASSWORD);
    adminCookie = await loginUser(app, admin.loginName, PASSWORD);
    mcpCookie = await loginUser(app, mcp.loginName, PASSWORD);
    pagingOwnerCookie = await loginUser(app, pagingOwner.loginName, PASSWORD);
    boundaryOwnerCookie = await loginUser(app, boundaryOwner.loginName, PASSWORD);
    keywordOwnerCookie = await loginUser(app, keywordOwner.loginName, PASSWORD);
    emptyOwnerCookie = await loginUser(app, emptyOwner.loginName, PASSWORD);
    andOwnerCookie = await loginUser(app, andOwner.loginName, PASSWORD);
    dtoOwnerCookie = await loginUser(app, dtoOwner.loginName, PASSWORD);
    wildcardOwnerCookie = await loginUser(app, wildcardOwner.loginName, PASSWORD);

    // AC-84 fixture: owner has 2 TRAVEL applications; other has 1 — used to
    // prove admin-scoped ownerId query returns ONLY owner's rows.
    await createApp({ ownerId, primaryDate: "2026-01-10", purpose: "P4T9 擁有人行程一" });
    await createApp({ ownerId, primaryDate: "2026-01-11", purpose: "P4T9 擁有人行程二" });
    await createApp({ ownerId: otherId, primaryDate: "2026-01-12", purpose: "P4T9 他人行程" });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      if (createdApplicationIds.length > 0) {
        await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
      }
      const userIds = [
        ownerId,
        otherId,
        adminId,
        mcpId,
        pagingOwnerId,
        boundaryOwnerId,
        keywordOwnerId,
        emptyOwnerId,
        andOwnerId,
        dtoOwnerId,
        wildcardOwnerId,
      ].filter(Boolean);
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
  // 授權矩陣（AC-74、AC-76、AC-84）
  // ===========================================================================

  describe("授權矩陣", () => {
    it("AC-74: 一般使用者帶他人 ownerId → 403 FORBIDDEN，不回任何資料", async () => {
      const resp = await getList(ownerCookie, { ownerId: otherId });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");
      const raw = JSON.stringify(resp.json());
      expect(raw).not.toContain("他人行程");
    });

    it("反向案例: 一般使用者帶自身 ownerId → 200，只回自己的資料", async () => {
      const resp = await getList(ownerCookie, { ownerId, type: "TRAVEL" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) {
        expect(item.ownerId).toBe(ownerId);
      }
      expect(body.appliedFilters.ownerId).toBe(ownerId);
    });

    it("反向案例: 一般使用者省略 ownerId → 200，只回自己的資料", async () => {
      const resp = await getList(ownerCookie, { type: "TRAVEL" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) {
        expect(item.ownerId).toBe(ownerId);
      }
      expect(body.appliedFilters.ownerId).toBe(ownerId);
    });

    it("AC-84: 管理員帶 ownerId=<擁有人> → 只回該擁有人的、且符合條件的紀錄（他人資料不外洩）", async () => {
      const resp = await getList(adminCookie, { ownerId, type: "TRAVEL" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.length).toBe(2);
      for (const item of body.items) {
        expect(item.ownerId).toBe(ownerId);
      }
      expect(body.items.some((i) => i.title === "P4T9 他人行程")).toBe(false);
    });

    it("管理員省略 ownerId → 200，預設為自己（D10），不含其他任何使用者資料", async () => {
      const resp = await getList(adminCookie, {});
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.appliedFilters.ownerId).toBe(adminId);
      for (const item of body.items) {
        expect(item.ownerId).toBe(adminId);
      }
    });

    it("未登入 → 401 UNAUTHORIZED", async () => {
      const resp = await app.inject({ method: "GET", url: "/applications" });
      expect(resp.statusCode).toBe(401);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
    });

    it("AC-76: 強制改密使用者 → 403 PASSWORD_CHANGE_REQUIRED", async () => {
      const resp = await getList(mcpCookie, {});
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    });
  });

  // ===========================================================================
  // AC-67 分頁穩定性：同日多筆跨頁不重複、不遺漏
  // ===========================================================================

  describe("AC-67 分頁穩定性", () => {
    it("5 筆相同 primaryDate 且相同 createdAt（強制以 id 全序區分）→ pageSize=2 跨 3 頁合併，恰好 5 筆、無重複、無遺漏", async () => {
      const sameDate = "2026-04-15";
      const sameCreatedAt = new Date("2026-04-15T10:00:00.000Z");
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const a = await createApp({
          ownerId: pagingOwnerId,
          primaryDate: sameDate,
          createdAt: sameCreatedAt,
          purpose: `P4T9 分頁鑑別力第${i}筆`,
        });
        created.push(a.id);
      }

      const collected: string[] = [];
      for (const page of [1, 2, 3]) {
        const resp = await getList(pagingOwnerCookie, { page, pageSize: 2, type: "TRAVEL" });
        expect(resp.statusCode).toBe(200);
        const body = resp.json<ListResponse>();
        expect(body.total).toBe(5);
        for (const item of body.items) collected.push(item.id);
      }

      // 無重複
      expect(new Set(collected).size).toBe(collected.length);
      // 無遺漏 + 剛好涵蓋全部 5 筆自建資料（非全域計數，符合 C5）
      expect(new Set(collected)).toEqual(new Set(created));
      expect(collected).toHaveLength(5);
    });
  });

  // ===========================================================================
  // AC-61 起訖含當日邊界
  // ===========================================================================

  describe("AC-61 起訖含當日邊界", () => {
    const boundaryDate = "2026-03-01";

    beforeAll(async () => {
      await createApp({
        ownerId: boundaryOwnerId,
        primaryDate: boundaryDate,
        purpose: "P4T9 邊界測試筆",
      });
    });

    it("dateFrom = primaryDate 當日 → 包含該筆", async () => {
      const resp = await getList(boundaryOwnerCookie, {
        dateFrom: boundaryDate,
        type: "TRAVEL",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.some((i) => i.primaryDate === boundaryDate)).toBe(true);
    });

    it("dateFrom = primaryDate 次日 → 排除該筆", async () => {
      const resp = await getList(boundaryOwnerCookie, {
        dateFrom: "2026-03-02",
        type: "TRAVEL",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.some((i) => i.primaryDate === boundaryDate)).toBe(false);
    });

    it("dateTo = primaryDate 當日 → 包含該筆", async () => {
      const resp = await getList(boundaryOwnerCookie, {
        dateFrom: "2026-01-01",
        dateTo: boundaryDate,
        type: "TRAVEL",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.some((i) => i.primaryDate === boundaryDate)).toBe(true);
    });

    it("dateTo = primaryDate 前一日 → 排除該筆", async () => {
      const resp = await getList(boundaryOwnerCookie, {
        dateFrom: "2026-01-01",
        dateTo: "2026-02-28",
        type: "TRAVEL",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.some((i) => i.primaryDate === boundaryDate)).toBe(false);
    });
  });

  // ===========================================================================
  // AC-62 起日晚於迄日 → 400
  // ===========================================================================

  describe("AC-62 起日晚於迄日", () => {
    it("dateFrom > dateTo → 400 VALIDATION_ERROR", async () => {
      const resp = await getList(ownerCookie, { dateFrom: "2026-05-10", dateTo: "2026-05-01" });
      expect(resp.statusCode).toBe(400);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ===========================================================================
  // AC-60 未提供日期 → 預設近一年、不設上界、appliedFilters 明示
  // ===========================================================================

  describe("AC-60 預設近一年（appliedFilters 可驗證）", () => {
    it("未提供 dateFrom/dateTo → appliedFilters.dateFrom = 今日-1年（含當日），dateTo = null", async () => {
      const before = new Date();
      const resp = await getList(emptyOwnerCookie, {});
      const after = new Date();
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();

      const expectedFromBefore = formatUtcDate(defaultDateFrom(before));
      const expectedFromAfter = formatUtcDate(defaultDateFrom(after));
      // 極端情況下 before/after 可能跨日界（機率極低），兩者其一必命中。
      expect([expectedFromBefore, expectedFromAfter]).toContain(body.appliedFilters.dateFrom);
      expect(body.appliedFilters.dateTo).toBeNull();
    });
  });

  // ===========================================================================
  // AC-69 無任何紀錄 → items: [], total: 0（非錯誤）
  // ===========================================================================

  describe("AC-69 無任何紀錄", () => {
    it("使用者從未建立任何申請 → 200 { items: [], total: 0 }", async () => {
      const resp = await getList(emptyOwnerCookie, {});
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  // ===========================================================================
  // AC-70 篩選後無結果 → 200 + 空清單（非錯誤）
  // ===========================================================================

  describe("AC-70 篩選後無結果", () => {
    it("status=COMPLETED（該擁有人只有 DRAFT）→ 200 + 空清單", async () => {
      await createApp({ ownerId: boundaryOwnerId, primaryDate: "2026-03-05", status: "DRAFT" });
      const resp = await getList(boundaryOwnerCookie, { status: "COMPLETED" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  // ===========================================================================
  // AC-71 尚未實作之類型查詢相容行為（200 + 空清單，非 400）
  // ===========================================================================

  describe("AC-71 MAINTENANCE/DEPRECIATION 查詢相容行為", () => {
    it("type=MAINTENANCE → 200 + items: []（非 400）", async () => {
      const resp = await getList(ownerCookie, { type: "MAINTENANCE" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items).toEqual([]);
    });

    it("type=DEPRECIATION → 200 + items: []（非 400）", async () => {
      const resp = await getList(ownerCookie, { type: "DEPRECIATION" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items).toEqual([]);
    });
  });

  // ===========================================================================
  // AC-65 分頁參數：clamp vs 400
  // ===========================================================================

  describe("AC-65 分頁參數", () => {
    it("pageSize=101 → clamp 至 100，不報錯（200）", async () => {
      const resp = await getList(ownerCookie, { pageSize: 101 });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.pageSize).toBe(100);
    });

    it("pageSize=0 → 400 VALIDATION_ERROR", async () => {
      const resp = await getList(ownerCookie, { pageSize: 0 });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect((body.error.fields ?? []).some((f) => f.field === "pageSize")).toBe(true);
    });

    it("page=0 → 400 VALIDATION_ERROR", async () => {
      const resp = await getList(ownerCookie, { page: 0 });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect((body.error.fields ?? []).some((f) => f.field === "page")).toBe(true);
    });

    it("page=1.5（非整數）→ 400 VALIDATION_ERROR", async () => {
      const resp = await getList(ownerCookie, { page: "1.5" });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect((body.error.fields ?? []).some((f) => f.field === "page")).toBe(true);
    });

    it("page/pageSize 未提供 → 預設 page=1, pageSize=20", async () => {
      const resp = await getList(ownerCookie, {});
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(20);
    });
  });

  // ===========================================================================
  // AC-66「全部紀錄」仍分頁且限制單次筆數
  // ===========================================================================

  describe("AC-66 全部紀錄仍分頁", () => {
    it("不套日期（僅 pageSize 極小）→ 仍以分頁回傳，單次筆數 ≤ pageSize", async () => {
      const resp = await getList(pagingOwnerCookie, { pageSize: 2, type: "TRAVEL" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.length).toBeLessThanOrEqual(2);
      expect(typeof body.total).toBe("number");
    });
  });

  // ===========================================================================
  // AC-64 關鍵字比對出差目的
  // ===========================================================================

  describe("AC-64 關鍵字比對出差目的", () => {
    beforeAll(async () => {
      await createApp({
        ownerId: keywordOwnerId,
        primaryDate: "2026-06-01",
        purpose: "台中客戶拜訪 ABC Corp",
      });
      await createApp({
        ownerId: keywordOwnerId,
        primaryDate: "2026-06-02",
        purpose: "台北內部教育訓練",
      });
    });

    it("關鍵字部分比對命中（中文）", async () => {
      const resp = await getList(keywordOwnerCookie, { keyword: "客戶", type: "TRAVEL" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.length).toBe(1);
      expect(body.items[0].title).toContain("客戶");
    });

    it("不分大小寫（查詢小寫命中內容中大寫片段）", async () => {
      const resp = await getList(keywordOwnerCookie, { keyword: "abc corp", type: "TRAVEL" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.length).toBe(1);
      expect(body.items[0].title).toContain("ABC Corp");
    });

    it("空字串視同未提供 → 不套用關鍵字條件（回全部）", async () => {
      const resp = await getList(keywordOwnerCookie, { keyword: "", type: "TRAVEL" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.total).toBe(2);
      expect(body.appliedFilters.keyword).toBeNull();
    });

    it("純空白視同未提供 → 不套用關鍵字條件（回全部）", async () => {
      const resp = await getList(keywordOwnerCookie, { keyword: "   ", type: "TRAVEL" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.total).toBe(2);
      expect(body.appliedFilters.keyword).toBeNull();
    });

    it("無命中 → 200 + 空清單（非錯誤）", async () => {
      const resp = await getList(keywordOwnerCookie, {
        keyword: "完全不存在的關鍵字xyz",
        type: "TRAVEL",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items).toEqual([]);
    });
  });

  // ===========================================================================
  // B-23 關鍵字含 SQL LIKE 萬用字元（`%`、`_`）須視為字面字元（Spec §5 B-23、
  // §11.5）。Prisma 的 `contains` 已參數化（無注入風險），但預設**不**跳脫
  // pattern 內的 `%`/`_`——這兩者在 PostgreSQL ILIKE 裡本身就是萬用字元，會
  // 被解讀為「任意字元序列／任一字元」而非字面比對。
  //
  // 鑑別力設計：wildcardOwner 底下建立 4 筆申請，僅 1 筆的出差目的含 `%`、僅
  // 1 筆含 `_`，其餘 2 筆兩者皆無。修復前，關鍵字 `%` 會被組成 pattern
  // `%%%`（等價於單一萬用字元 `%`），命中「全部」4 筆非 null purpose；修復後
  // 應只命中恰好 1 筆。`_` 同理。
  // ===========================================================================

  describe("B-23 關鍵字含 SQL 萬用字元須視為字面比對", () => {
    const percentPurpose = "達成率100%專案檢討會議";
    const underscorePurpose = "客戶_A_案件檢討會議";
    const plainPurposeOne = "一般部門週會記錄";
    const plainPurposeTwo = "月度盤點作業說明";

    beforeAll(async () => {
      await createApp({
        ownerId: wildcardOwnerId,
        primaryDate: "2026-09-01",
        purpose: percentPurpose,
      });
      await createApp({
        ownerId: wildcardOwnerId,
        primaryDate: "2026-09-02",
        purpose: underscorePurpose,
      });
      await createApp({
        ownerId: wildcardOwnerId,
        primaryDate: "2026-09-03",
        purpose: plainPurposeOne,
      });
      await createApp({
        ownerId: wildcardOwnerId,
        primaryDate: "2026-09-04",
        purpose: plainPurposeTwo,
      });
    });

    it("正向：目的含 `%`，關鍵字 `%` 能命中該筆", async () => {
      const resp = await getList(wildcardOwnerCookie, { keyword: "%", type: "TRAVEL" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.some((i) => i.title === percentPurpose)).toBe(true);
    });

    it("正向：目的含 `%`，關鍵字 `100%`（字面片段含 `%`）能命中該筆", async () => {
      const resp = await getList(wildcardOwnerCookie, { keyword: "100%", type: "TRAVEL" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.some((i) => i.title === percentPurpose)).toBe(true);
    });

    it("反向：關鍵字 `%` 不得命中不含 `%` 的目的（修復前 `%` 會被組成萬用 pattern `%%%`，命中全部 4 筆——此測試修復前必紅）", async () => {
      const resp = await getList(wildcardOwnerCookie, { keyword: "%", type: "TRAVEL" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      const titles = body.items.map((i) => i.title);
      expect(titles).not.toContain(plainPurposeOne);
      expect(titles).not.toContain(plainPurposeTwo);
      expect(titles).not.toContain(underscorePurpose);
      // 恰好只命中含 % 的那一筆（比對集合大小，杜絕「剛好沒抽到」的僥倖）。
      expect(body.items).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it("正向：目的含 `_`，關鍵字 `_` 能命中該筆", async () => {
      const resp = await getList(wildcardOwnerCookie, { keyword: "_", type: "TRAVEL" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items.some((i) => i.title === underscorePurpose)).toBe(true);
    });

    it("反向：關鍵字 `_` 不得命中不含 `_` 的目的（修復前 `_` 會被當作單一字元萬用，命中全部 4 筆——此測試修復前必紅）", async () => {
      const resp = await getList(wildcardOwnerCookie, { keyword: "_", type: "TRAVEL" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      const titles = body.items.map((i) => i.title);
      expect(titles).not.toContain(plainPurposeOne);
      expect(titles).not.toContain(plainPurposeTwo);
      expect(titles).not.toContain(percentPurpose);
      expect(body.items).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it("跳脫字元本身（`\\`）不影響一般關鍵字比對（無 `\\` 的目的仍可用一般字串命中）", async () => {
      const resp = await getList(wildcardOwnerCookie, { keyword: "檢討會議", type: "TRAVEL" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      const titles = body.items.map((i) => i.title);
      expect(titles).toContain(percentPurpose);
      expect(titles).toContain(underscorePurpose);
      expect(titles).not.toContain(plainPurposeOne);
      expect(titles).not.toContain(plainPurposeTwo);
    });
  });

  // ===========================================================================
  // AC-63 多條件同時套用（AND 語意）
  // ===========================================================================

  describe("AC-63 多條件 AND 語意", () => {
    beforeAll(async () => {
      // 只有第一筆同時符合：type=TRAVEL, status=COMPLETED, keyword=出差,
      // primaryDate 落在指定區間內。其餘三筆各缺一個條件。
      await createApp({
        ownerId: andOwnerId,
        primaryDate: "2026-07-10",
        status: "COMPLETED",
        purpose: "AND條件出差測試",
        totalAmount: 1000,
      });
      await createApp({
        ownerId: andOwnerId,
        primaryDate: "2026-07-10",
        status: "DRAFT", // 狀態不符
        purpose: "AND條件出差測試",
      });
      await createApp({
        ownerId: andOwnerId,
        primaryDate: "2026-01-01", // 日期不符（超出區間）
        status: "COMPLETED",
        purpose: "AND條件出差測試",
        totalAmount: 500,
      });
      await createApp({
        ownerId: andOwnerId,
        primaryDate: "2026-07-11",
        status: "COMPLETED",
        purpose: "與關鍵字無關的目的",
        totalAmount: 700,
      });
    });

    it("同時套用 type + status + keyword + 日期區間 → 僅回同時符合全部條件者", async () => {
      const resp = await getList(andOwnerCookie, {
        type: "TRAVEL",
        status: "COMPLETED",
        keyword: "出差",
        dateFrom: "2026-07-01",
        dateTo: "2026-07-31",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].title).toBe("AND條件出差測試");
      expect(body.items[0].status).toBe("COMPLETED");
      expect(body.items[0].totalAmount).toBe(1000);
    });
  });

  // ===========================================================================
  // AC-68 每筆含 type/status；不適用於該類型之欄位回 null
  // ===========================================================================

  describe("AC-68 類型標籤／狀態／不適用欄位", () => {
    it("TRAVEL 草稿：type/status 正確，已完成才有的欄位為 null", async () => {
      await createApp({
        ownerId: dtoOwnerId,
        primaryDate: "2026-08-01",
        status: "DRAFT",
        purpose: "DTO草稿測試",
      });
      const resp = await getList(dtoOwnerCookie, { type: "TRAVEL", status: "DRAFT" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      const item = body.items.find((i) => i.title === "DTO草稿測試");
      expect(item).toBeDefined();
      expect(item?.type).toBe("TRAVEL");
      expect(item?.status).toBe("DRAFT");
      expect(item?.totalKm).toBeNull(); // 草稿未完成，里程快照不適用
      expect(item?.totalAmount).toBeNull(); // 草稿金額不適用
      expect(item?.segmentCount).toBe(0);
    });

    it("TRAVEL 已完成：totalKm/totalAmount 有值", async () => {
      await createApp({
        ownerId: dtoOwnerId,
        primaryDate: "2026-08-02",
        status: "COMPLETED",
        purpose: "DTO完成測試",
        totalAmount: 2345,
        snapshotTotalKm: "88.50",
      });
      const resp = await getList(dtoOwnerCookie, { type: "TRAVEL", status: "COMPLETED" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      const item = body.items.find((i) => i.title === "DTO完成測試");
      expect(item).toBeDefined();
      expect(item?.totalKm).toBe("88.50");
      expect(item?.totalAmount).toBe(2345);
    });

    it("非差旅類型（無子表資料）：tripDate/title/totalKm/segmentCount 一律 null，不顯示錯誤資料", async () => {
      await createApp({
        ownerId: dtoOwnerId,
        type: "MAINTENANCE",
        status: "DRAFT",
        primaryDate: "2026-08-03",
        withTravel: false,
      });
      const resp = await getList(dtoOwnerCookie, { type: "MAINTENANCE" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      expect(body.items).toHaveLength(1);
      const item = body.items[0];
      expect(item.type).toBe("MAINTENANCE");
      expect(item.status).toBe("DRAFT");
      expect(item.tripDate).toBeNull();
      expect(item.title).toBeNull();
      expect(item.totalKm).toBeNull();
      expect(item.segmentCount).toBeNull();
    });
  });

  // ===========================================================================
  // AC-67 排序：primaryDate DESC 基本檢驗（不同日期時的宏觀順序）
  // ===========================================================================

  describe("AC-67 排序：primaryDate DESC", () => {
    it("不同 primaryDate 時，較新日期排在前面", async () => {
      const resp = await getList(andOwnerCookie, { type: "TRAVEL", pageSize: 100 });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<ListResponse>();
      const dates = body.items.map((i) => i.primaryDate);
      const sorted = [...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      expect(dates).toEqual(sorted);
    });
  });
});
