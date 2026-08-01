/**
 * Integration tests for PHASE-004-T3:
 *   差旅草稿 CRUD 端點 + 授權隔離 + completionBlockers 接線 + primaryDate 推導
 *   + tripDate/purpose 三態語意。
 *
 * TDD: written to exercise the real HTTP routes registered by buildServer().
 * First run (before routes.ts/server.ts wiring existed) was RED — 404 on
 * every /applications/* path (unknown route). See Task Handoff for the
 * captured first-run RED output.
 *
 * AC covered (PHASE-004 Spec §2):
 *   AC-01, AC-02, AC-03, AC-04, AC-06, AC-07, AC-72~77, AC-79a
 *   + D9 primaryDate ≥5 cases, tripDate/purpose 三態, D14(ii) purpose 500/501
 *     boundary, tripDate 非法值。
 *
 * Test discipline (Spec §11.0 / Packet):
 *   - loginName prefix "p4t3_" + per-run random suffix (跨檔跨 fork 撞名防護)
 *   - cleanup scoped to this suite's own tracked application ids + loginName
 *     prefix; NEVER deleteMany({}) globally.
 *   - synthetic data only (虛構人名、地名、出差目的)
 */
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Shared helpers (pattern per phase3a-parameter-fuel-etc.test.ts)
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

// Per-process random suffix (PHASE-004-R1 discipline) — avoids cross-file/fork collisions.
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p4t3_";
const PASSWORD = "TravelDraftTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;
const MCP_LOGIN = `${LOGIN_PREFIX}mcp_${RUN_ID}`;

const NONEXISTENT_ID = "p4t3-nonexistent-application-id-000000";

describeWithDb("PHASE-004-T3 — 差旅草稿 CRUD + 授權隔離", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let otherId: string;
  let adminId: string;
  let mcpId: string;

  let ownerCookie: string;
  let otherCookie: string;
  let adminCookie: string;
  let mcpCookie: string;

  // Track application ids created by this suite for scoped cleanup.
  const createdApplicationIds: string[] = [];

  function track(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  async function createDraft(cookie: string, payload: Record<string, unknown> = {}) {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/travel",
      headers: { cookie },
      payload,
    });
    return resp;
  }

  async function createOwnerDraft(payload: Record<string, unknown> = {}) {
    const resp = await createDraft(ownerCookie, payload);
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ application: { id: string } }>();
    track(body.application.id);
    return body.application as Record<string, unknown> & { id: string };
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);

    const owner = await prisma.user.create({
      data: {
        loginName: OWNER_LOGIN,
        displayName: "P4T3 擁有人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const other = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "P4T3 他人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "P4T3 管理員",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const mcp = await prisma.user.create({
      data: {
        loginName: MCP_LOGIN,
        displayName: "P4T3 待改密使用者",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: true,
      },
    });

    ownerId = owner.id;
    otherId = other.id;
    adminId = admin.id;
    mcpId = mcp.id;

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    ownerCookie = await loginUser(app, OWNER_LOGIN, PASSWORD);
    otherCookie = await loginUser(app, OTHER_LOGIN, PASSWORD);
    adminCookie = await loginUser(app, ADMIN_LOGIN, PASSWORD);
    mcpCookie = await loginUser(app, MCP_LOGIN, PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      if (createdApplicationIds.length > 0) {
        await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
      }
      const userIds = [ownerId, otherId, adminId, mcpId].filter(Boolean);
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
  // AC-01: 建立差旅草稿
  // ===========================================================================

  describe("AC-01 — POST /applications/travel", () => {
    it("建立草稿（空 body）→ 201, status=DRAFT, ownerId=createdById=self, 空 segments, 有 completionBlockers", async () => {
      const resp = await createDraft(ownerCookie, {});
      expect(resp.statusCode).toBe(201);
      const body = resp.json<{ application: Record<string, unknown> }>();
      const application = body.application;
      track(application.id as string);

      expect(application.type).toBe("TRAVEL");
      expect(application.status).toBe("DRAFT");
      expect(application.ownerId).toBe(ownerId);
      expect(application.createdById).toBe(ownerId);
      expect(application.segments).toEqual([]);
      expect(Array.isArray(application.completionBlockers)).toBe(true);
      expect((application.completionBlockers as unknown[]).length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // AC-02 / AC-03: 部分資料保存 + completionBlockers 隨資料變化, HTTP 200
  // ===========================================================================

  describe("AC-02/AC-03 — PUT 部分保存 + completionBlockers 隨資料變化", () => {
    it("僅填出差目的、未填出差日期、未新增行程段 → PUT 200 保存成功", async () => {
      const draft = await createOwnerDraft({});
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { purpose: "台中客戶拜訪" },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: Record<string, unknown> }>();
      expect(body.application.purpose).toBe("台中客戶拜訪");
      expect(body.application.tripDate).toBeNull();
    });

    it("blockers 隨資料完整度變化，且 HTTP 仍為 200", async () => {
      const draft = await createOwnerDraft({});
      const initialBlockerCodes = (draft.completionBlockers as { code: string }[]).map(
        (b) => b.code
      );
      expect(initialBlockerCodes).toContain("TRIP_DATE_REQUIRED");
      expect(initialBlockerCodes).toContain("PURPOSE_REQUIRED");
      expect(initialBlockerCodes).toContain("SEGMENT_REQUIRED");

      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { tripDate: "2026-05-10", purpose: "填寫完整目的" },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: Record<string, unknown> }>();
      const codes = (body.application.completionBlockers as { code: string }[]).map((b) => b.code);
      expect(codes).not.toContain("TRIP_DATE_REQUIRED");
      expect(codes).not.toContain("PURPOSE_REQUIRED");
      // SEGMENT_REQUIRED still present (still 0 segments — T4 not implemented)
      expect(codes).toContain("SEGMENT_REQUIRED");
    });
  });

  // ===========================================================================
  // AC-04: 重新開啟草稿還原資料
  // ===========================================================================

  describe("AC-04 — GET 還原 tripDate/purpose", () => {
    it("儲存後重新讀取，tripDate/purpose 與儲存時一致", async () => {
      const draft = await createOwnerDraft({});
      await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { tripDate: "2026-06-15", purpose: "新竹分公司會議" },
      });

      const resp = await app.inject({
        method: "GET",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: Record<string, unknown> }>();
      expect(body.application.tripDate).toBe("2026-06-15");
      expect(body.application.purpose).toBe("新竹分公司會議");
    });
  });

  // ===========================================================================
  // AC-06: 已完成申請不可修改/刪除（403 FORBIDDEN，資料不變）
  // ===========================================================================

  describe("AC-06 — 已完成申請拒改/拒刪（403 FORBIDDEN）", () => {
    async function markCompleted(applicationId: string) {
      await prisma.application.update({
        where: { id: applicationId },
        data: { status: "COMPLETED", completedAt: new Date(), totalAmount: 1234 },
      });
    }

    it("PUT 已完成申請 → 403 FORBIDDEN，訊息符合 D13 文案，資料未變更", async () => {
      const draft = await createOwnerDraft({ tripDate: "2026-07-01", purpose: "原始目的" });
      await markCompleted(draft.id);

      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { purpose: "嘗試竄改的目的" },
      });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toContain("已完成的申請不可修改");
      expect(body.error.message).toContain("建立修正版");

      const stillThere = await prisma.travelApplication.findUnique({
        where: { applicationId: draft.id },
      });
      expect(stillThere?.purpose).toBe("原始目的");
    });

    it("DELETE 已完成申請 → 403 FORBIDDEN，資料未刪除", async () => {
      const draft = await createOwnerDraft({ tripDate: "2026-07-02", purpose: "另一筆" });
      await markCompleted(draft.id);

      const resp = await app.inject({
        method: "DELETE",
        url: `/applications/${draft.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");

      const stillThere = await prisma.application.findUnique({ where: { id: draft.id } });
      expect(stillThere).not.toBeNull();
    });
  });

  // ===========================================================================
  // AC-07: 草稿 totalAmount 為 null
  // ===========================================================================

  describe("AC-07 — 草稿 totalAmount 為 null", () => {
    it("草稿 Application.totalAmount 為 null（DB 直查）", async () => {
      const draft = await createOwnerDraft({ purpose: "測試金額" });
      const row = await prisma.application.findUnique({ where: { id: draft.id } });
      expect(row?.totalAmount).toBeNull();
    });
  });

  // ===========================================================================
  // 刪除草稿（AC-05 基本情形：0 段草稿）
  // ===========================================================================

  describe("刪除草稿", () => {
    it("擁有人刪除自己的草稿 → 200 { ok: true }，之後 GET 得 404", async () => {
      const draft = await createOwnerDraft({});
      const delResp = await app.inject({
        method: "DELETE",
        url: `/applications/${draft.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(delResp.statusCode).toBe(200);
      expect(delResp.json()).toEqual({ ok: true });

      // Remove from tracked cleanup list — already gone.
      const idx = createdApplicationIds.indexOf(draft.id);
      if (idx >= 0) createdApplicationIds.splice(idx, 1);

      const getResp = await app.inject({
        method: "GET",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(getResp.statusCode).toBe(404);
    });
  });

  // ===========================================================================
  // AC-72~77 / AC-85: 權限矩陣（GET/PUT/DELETE × {擁有者/他人/管理員/未登入/待改密} × {存在/不存在}）
  // ===========================================================================

  describe("權限矩陣", () => {
    describe("GET /applications/travel/:id", () => {
      it("擁有者 → 200", async () => {
        const draft = await createOwnerDraft({});
        const resp = await app.inject({
          method: "GET",
          url: `/applications/travel/${draft.id}`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(200);
      });

      it("他人一般使用者 → 403，body 不含任何業務欄位", async () => {
        const draft = await createOwnerDraft({ tripDate: "2026-08-01", purpose: "機密出差目的" });
        const resp = await app.inject({
          method: "GET",
          url: `/applications/travel/${draft.id}`,
          headers: { cookie: otherCookie },
        });
        expect(resp.statusCode).toBe(403);
        const body = resp.json<Record<string, unknown>>();
        const raw = JSON.stringify(body);
        expect(raw).not.toContain("機密出差目的");
        expect(body.purpose).toBeUndefined();
        expect(body.tripDate).toBeUndefined();
        expect(body.totalAmount).toBeUndefined();
        expect(body.segments).toBeUndefined();
        expect(body.ownerDisplayName).toBeUndefined();
        expect(body.application).toBeUndefined();
      });

      it("管理員 → 200", async () => {
        const draft = await createOwnerDraft({});
        const resp = await app.inject({
          method: "GET",
          url: `/applications/travel/${draft.id}`,
          headers: { cookie: adminCookie },
        });
        expect(resp.statusCode).toBe(200);
      });

      it("未登入 → 401", async () => {
        const draft = await createOwnerDraft({});
        const resp = await app.inject({
          method: "GET",
          url: `/applications/travel/${draft.id}`,
        });
        expect(resp.statusCode).toBe(401);
        expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
      });

      it("強制改密使用者 → 403 PASSWORD_CHANGE_REQUIRED", async () => {
        const draft = await createOwnerDraft({});
        const resp = await app.inject({
          method: "GET",
          url: `/applications/travel/${draft.id}`,
          headers: { cookie: mcpCookie },
        });
        expect(resp.statusCode).toBe(403);
        expect(resp.json<{ error: { code: string } }>().error.code).toBe(
          "PASSWORD_CHANGE_REQUIRED"
        );
      });

      it("不存在資源 → 404", async () => {
        const resp = await app.inject({
          method: "GET",
          url: `/applications/travel/${NONEXISTENT_ID}`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(404);
      });
    });

    describe("PUT /applications/travel/:id", () => {
      it("擁有者 → 200", async () => {
        const draft = await createOwnerDraft({});
        const resp = await app.inject({
          method: "PUT",
          url: `/applications/travel/${draft.id}`,
          headers: { cookie: ownerCookie },
          payload: { purpose: "擁有者更新" },
        });
        expect(resp.statusCode).toBe(200);
      });

      it("他人一般使用者 → 403，body 不含業務欄位", async () => {
        const draft = await createOwnerDraft({ purpose: "原始資料" });
        const resp = await app.inject({
          method: "PUT",
          url: `/applications/travel/${draft.id}`,
          headers: { cookie: otherCookie },
          payload: { purpose: "他人嘗試竄改" },
        });
        expect(resp.statusCode).toBe(403);
        const body = resp.json<Record<string, unknown>>();
        expect(body.purpose).toBeUndefined();
        expect(body.segments).toBeUndefined();
      });

      it("管理員 → 200（可代修改草稿）", async () => {
        const draft = await createOwnerDraft({});
        const resp = await app.inject({
          method: "PUT",
          url: `/applications/travel/${draft.id}`,
          headers: { cookie: adminCookie },
          payload: { purpose: "管理員代修改" },
        });
        expect(resp.statusCode).toBe(200);
      });

      it("未登入 → 401", async () => {
        const draft = await createOwnerDraft({});
        const resp = await app.inject({
          method: "PUT",
          url: `/applications/travel/${draft.id}`,
          payload: { purpose: "x" },
        });
        expect(resp.statusCode).toBe(401);
      });

      it("強制改密使用者 → 403 PASSWORD_CHANGE_REQUIRED", async () => {
        const draft = await createOwnerDraft({});
        const resp = await app.inject({
          method: "PUT",
          url: `/applications/travel/${draft.id}`,
          headers: { cookie: mcpCookie },
          payload: { purpose: "x" },
        });
        expect(resp.statusCode).toBe(403);
        expect(resp.json<{ error: { code: string } }>().error.code).toBe(
          "PASSWORD_CHANGE_REQUIRED"
        );
      });

      it("不存在資源 → 404", async () => {
        const resp = await app.inject({
          method: "PUT",
          url: `/applications/travel/${NONEXISTENT_ID}`,
          headers: { cookie: ownerCookie },
          payload: { purpose: "x" },
        });
        expect(resp.statusCode).toBe(404);
      });
    });

    describe("DELETE /applications/:id", () => {
      it("擁有者 → 200", async () => {
        const draft = await createOwnerDraft({});
        const resp = await app.inject({
          method: "DELETE",
          url: `/applications/${draft.id}`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(200);
        const idx = createdApplicationIds.indexOf(draft.id);
        if (idx >= 0) createdApplicationIds.splice(idx, 1);
      });

      it("他人一般使用者 → 403，資料未刪除", async () => {
        const draft = await createOwnerDraft({});
        const resp = await app.inject({
          method: "DELETE",
          url: `/applications/${draft.id}`,
          headers: { cookie: otherCookie },
        });
        expect(resp.statusCode).toBe(403);
        const body = resp.json<Record<string, unknown>>();
        expect(body.purpose).toBeUndefined();
        const stillThere = await prisma.application.findUnique({ where: { id: draft.id } });
        expect(stillThere).not.toBeNull();
      });

      it("管理員 → 200（可代刪除）", async () => {
        const draft = await createOwnerDraft({});
        const resp = await app.inject({
          method: "DELETE",
          url: `/applications/${draft.id}`,
          headers: { cookie: adminCookie },
        });
        expect(resp.statusCode).toBe(200);
        const idx = createdApplicationIds.indexOf(draft.id);
        if (idx >= 0) createdApplicationIds.splice(idx, 1);
      });

      it("未登入 → 401", async () => {
        const draft = await createOwnerDraft({});
        const resp = await app.inject({
          method: "DELETE",
          url: `/applications/${draft.id}`,
        });
        expect(resp.statusCode).toBe(401);
      });

      it("強制改密使用者 → 403 PASSWORD_CHANGE_REQUIRED", async () => {
        const draft = await createOwnerDraft({});
        const resp = await app.inject({
          method: "DELETE",
          url: `/applications/${draft.id}`,
          headers: { cookie: mcpCookie },
        });
        expect(resp.statusCode).toBe(403);
        expect(resp.json<{ error: { code: string } }>().error.code).toBe(
          "PASSWORD_CHANGE_REQUIRED"
        );
      });

      it("不存在資源 → 404", async () => {
        const resp = await app.inject({
          method: "DELETE",
          url: `/applications/${NONEXISTENT_ID}`,
          headers: { cookie: ownerCookie },
        });
        expect(resp.statusCode).toBe(404);
      });
    });
  });

  // ===========================================================================
  // 不採信請求體識別（§6.2 資料隔離不變式 1, AC-79a）
  // ===========================================================================

  describe("不採信請求體識別", () => {
    it("POST body 帶 ownerId=<他人> → 建立出的申請 ownerId 仍為呼叫者本人", async () => {
      const resp = await createDraft(ownerCookie, {
        ownerId: otherId,
        createdById: otherId,
        purpose: "測試 owner 忽略",
      });
      expect(resp.statusCode).toBe(201);
      const body = resp.json<{ application: Record<string, unknown> }>();
      track(body.application.id as string);
      expect(body.application.ownerId).toBe(ownerId);
      expect(body.application.createdById).toBe(ownerId);
    });

    it("PUT body 帶 ownerId/createdById/status → 一律忽略，DB 不變", async () => {
      const draft = await createOwnerDraft({ purpose: "原始" });
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: {
          purpose: "更新後",
          ownerId: otherId,
          createdById: otherId,
          status: "COMPLETED",
        },
      });
      expect(resp.statusCode).toBe(200);
      const row = await prisma.application.findUnique({ where: { id: draft.id } });
      expect(row?.ownerId).toBe(ownerId);
      expect(row?.createdById).toBe(ownerId);
      expect(row?.status).toBe("DRAFT");
    });

    it("PUT body 帶 totalAmount/amount/fuelAmount → 一律忽略，DB totalAmount 仍為 null", async () => {
      const draft = await createOwnerDraft({});
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { totalAmount: 999999, amount: 999999, fuelAmount: "999999.0000" },
      });
      expect(resp.statusCode).toBe(200);
      const row = await prisma.application.findUnique({ where: { id: draft.id } });
      expect(row?.totalAmount).toBeNull();
    });
  });

  // ===========================================================================
  // primaryDate 推導（D9） ≥5 案例
  // ===========================================================================

  describe("primaryDate 推導（D9）", () => {
    it("案例1: 建立時 tripDate 有值 → primaryDate = tripDate", async () => {
      const draft = await createOwnerDraft({ tripDate: "2026-09-10" });
      const row = await prisma.application.findUnique({ where: { id: draft.id } });
      expect(row?.primaryDate.toISOString().slice(0, 10)).toBe("2026-09-10");
    });

    it("案例2: 建立時未填 tripDate → primaryDate = 建立日期（UTC 日粒度）", async () => {
      const draft = await createOwnerDraft({});
      const row = await prisma.application.findUnique({ where: { id: draft.id } });
      const createdDatePart = row?.createdAt.toISOString().slice(0, 10);
      expect(row?.primaryDate.toISOString().slice(0, 10)).toBe(createdDatePart);
    });

    it("案例3: PUT 首次設定 tripDate → primaryDate 更新為該 tripDate", async () => {
      const draft = await createOwnerDraft({});
      await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { tripDate: "2026-09-20" },
      });
      const row = await prisma.application.findUnique({ where: { id: draft.id } });
      expect(row?.primaryDate.toISOString().slice(0, 10)).toBe("2026-09-20");
    });

    it("案例4: PUT 清空 tripDate（null）→ primaryDate 回退為建立日期，非「今日」", async () => {
      const draft = await createOwnerDraft({ tripDate: "2026-09-25" });
      const createdRow = await prisma.application.findUnique({ where: { id: draft.id } });
      const createdDatePart = createdRow?.createdAt.toISOString().slice(0, 10);

      await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { tripDate: null },
      });
      const row = await prisma.application.findUnique({ where: { id: draft.id } });
      expect(row?.primaryDate.toISOString().slice(0, 10)).toBe(createdDatePart);
    });

    it("案例5: 未來出差日期不被截斷", async () => {
      const draft = await createOwnerDraft({ tripDate: "2030-12-31" });
      const row = await prisma.application.findUnique({ where: { id: draft.id } });
      expect(row?.primaryDate.toISOString().slice(0, 10)).toBe("2030-12-31");
    });

    it("案例6（每次 PUT 都重新推導，非只算一次）: 先設定再清空再重設，皆正確反映最新值", async () => {
      const draft = await createOwnerDraft({});
      await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { tripDate: "2026-10-01" },
      });
      let row = await prisma.application.findUnique({ where: { id: draft.id } });
      expect(row?.primaryDate.toISOString().slice(0, 10)).toBe("2026-10-01");

      await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { tripDate: "2026-10-15" },
      });
      row = await prisma.application.findUnique({ where: { id: draft.id } });
      expect(row?.primaryDate.toISOString().slice(0, 10)).toBe("2026-10-15");
    });
  });

  // ===========================================================================
  // tripDate/purpose 三態語意
  // ===========================================================================

  describe("tripDate/purpose 三態語意", () => {
    it("欄位缺席 = 不變", async () => {
      const draft = await createOwnerDraft({ tripDate: "2026-11-01", purpose: "原始目的" });
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: {},
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: Record<string, unknown> }>();
      expect(body.application.tripDate).toBe("2026-11-01");
      expect(body.application.purpose).toBe("原始目的");
    });

    it("null = 清空", async () => {
      const draft = await createOwnerDraft({ tripDate: "2026-11-02", purpose: "原始目的2" });
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { tripDate: null, purpose: null },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: Record<string, unknown> }>();
      expect(body.application.tripDate).toBeNull();
      expect(body.application.purpose).toBeNull();
    });

    it("有值 = 設定", async () => {
      const draft = await createOwnerDraft({});
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { tripDate: "2026-11-03", purpose: "新設定的目的" },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: Record<string, unknown> }>();
      expect(body.application.tripDate).toBe("2026-11-03");
      expect(body.application.purpose).toBe("新設定的目的");
    });
  });

  // ===========================================================================
  // purpose 長度邊界（D14(ii)）
  // ===========================================================================

  describe("purpose 長度邊界（D14(ii)：≤500 字）", () => {
    it("501 字 → 400 VALIDATION_ERROR", async () => {
      const draft = await createOwnerDraft({});
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { purpose: "字".repeat(501) },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect((body.error.fields ?? []).some((f) => f.field === "purpose")).toBe(true);
    });

    it("500 字（邊界）→ 200 允許", async () => {
      const draft = await createOwnerDraft({});
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { purpose: "字".repeat(500) },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: Record<string, unknown> }>();
      expect((body.application.purpose as string).length).toBe(500);
    });
  });

  // ===========================================================================
  // tripDate 非法值
  // ===========================================================================

  describe("tripDate 非法值 → 400 VALIDATION_ERROR", () => {
    const invalidDates = ["2026-13-01", "2026-02-30", "20260201", "2026-2-1"];

    for (const invalid of invalidDates) {
      it(`tripDate="${invalid}" → 400`, async () => {
        const draft = await createOwnerDraft({});
        const resp = await app.inject({
          method: "PUT",
          url: `/applications/travel/${draft.id}`,
          headers: { cookie: ownerCookie },
          payload: { tripDate: invalid },
        });
        expect(resp.statusCode).toBe(400);
        const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
        expect(body.error.code).toBe("VALIDATION_ERROR");
        expect((body.error.fields ?? []).some((f) => f.field === "tripDate")).toBe(true);
      });
    }

    it("建立時 tripDate 非法值 → 400（POST 亦驗證）", async () => {
      const resp = await createDraft(ownerCookie, { tripDate: "not-a-date" });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ===========================================================================
  // PHASE-004-T5 — segments[] 格式驗證接點（僅格式驗證，不做 diff/寫入，T4 之前）
  // ===========================================================================

  describe("PUT segments[] 格式驗證（T5：里程/地點格式；T4 之前 segments 內容仍被忽略）", () => {
    it("segments[0].totalKm='12.345'（超過 2 位小數）→ 400 VALIDATION_ERROR，fields 含 segments[0].totalKm", async () => {
      const draft = await createOwnerDraft({});
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: {
          segments: [
            {
              origin: "台北市政府",
              destination: "新竹科學園區",
              totalKm: "12.345",
              highwayKm: "5",
              attachmentIds: [],
            },
          ],
        },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect((body.error.fields ?? []).some((f) => f.field === "segments[0].totalKm")).toBe(true);
    });

    it("origin 201 字 → 400 VALIDATION_ERROR，fields 含 segments[0].origin", async () => {
      const draft = await createOwnerDraft({});
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: {
          segments: [
            {
              origin: "地".repeat(201),
              destination: "新竹科學園區",
              totalKm: "10",
              highwayKm: "5",
              attachmentIds: [],
            },
          ],
        },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect((body.error.fields ?? []).some((f) => f.field === "segments[0].origin")).toBe(true);
    });

    it("合法 2 位小數里程 + 合法地點 → 不因格式被拒（200，內容不斷言，T4 尚未接 diff）", async () => {
      const draft = await createOwnerDraft({});
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: {
          segments: [
            {
              origin: "台北市政府",
              destination: "新竹科學園區",
              totalKm: "12.35",
              highwayKm: "5.00",
              attachmentIds: [],
            },
          ],
        },
      });
      expect(resp.statusCode).toBe(200);
    });

    it("多段中第 2 段格式不合法 → 400，fields 定位到 segments[1]", async () => {
      const draft = await createOwnerDraft({});
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: {
          segments: [
            {
              origin: "台北市政府",
              destination: "新竹科學園區",
              totalKm: "10",
              highwayKm: "5",
              attachmentIds: [],
            },
            {
              origin: "新竹科學園區",
              destination: "台中市政府",
              totalKm: "abc",
              highwayKm: "5",
              attachmentIds: [],
            },
          ],
        },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
      expect((body.error.fields ?? []).some((f) => f.field === "segments[1].totalKm")).toBe(true);
    });

    it("highwayKm 為負值（格式層允許通過，業務層留給 T8）→ 不因格式被拒（200）", async () => {
      const draft = await createOwnerDraft({});
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: {
          segments: [
            {
              origin: "台北市政府",
              destination: "新竹科學園區",
              totalKm: "10",
              highwayKm: "-1",
              attachmentIds: [],
            },
          ],
        },
      });
      expect(resp.statusCode).toBe(200);
    });

    it("沒有 segments 欄位 → 不受影響，PUT 仍 200（既有 T3 行為）", async () => {
      const draft = await createOwnerDraft({});
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { purpose: "沒有 segments 欄位" },
      });
      expect(resp.statusCode).toBe(200);
    });
  });
});
