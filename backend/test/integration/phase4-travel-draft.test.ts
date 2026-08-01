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
import { Prisma, PrismaClient } from "@prisma/client";
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

  // PHASE-004-T4: track directly-created (prisma) Attachment rows for scoped
  // cleanup — these are NOT reachable via createdApplicationIds because
  // Attachment→TripSegment is a weak reference (no FK, D1/D11-b); deleting
  // the Application does not cascade-delete Attachment rows.
  const createdAttachmentIds: string[] = [];

  /**
   * PHASE-004-T4: create a synthetic `LINKED` attachment directly via prisma
   * (Packet §Done When 5 AC-11 明文：「測試中直接以 prisma 建 Attachment 並
   * 設 refType='TRIP_SEGMENT'、refId=段id、status='LINKED'」) — bypasses the
   * real upload/link pipeline (PHASE-003, out of this Task's scope) since
   * only the detach-on-segment-delete DB effect is under test here.
   */
  async function createLinkedAttachment(segmentId: string, forOwnerId: string) {
    const att = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `p4t4-synthetic-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
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

  // PHASE-004-T4: PUT helper carrying only `segments[]` (plus optional extra
  // top-level fields, e.g. tripDate/purpose) — used by the new multi-segment
  // tests below.
  async function putSegments(
    cookie: string,
    id: string,
    segments: Record<string, unknown>[],
    extra: Record<string, unknown> = {}
  ) {
    return app.inject({
      method: "PUT",
      url: `/applications/travel/${id}`,
      headers: { cookie },
      payload: { segments, ...extra },
    });
  }

  /** Lint-friendly alternative to `x.find(...)!` (biome noNonNullAssertion). */
  function mustFind<T>(value: T | undefined, message: string): T {
    if (value === undefined) throw new Error(message);
    return value;
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
      // PHASE-004-T4: scoped cleanup of directly-created synthetic Attachment
      // rows (see createLinkedAttachment above) — must run before/independent
      // of application cleanup since there is no FK between them.
      if (createdAttachmentIds.length > 0) {
        await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
      }
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

  // ===========================================================================
  // PHASE-004-T4 — 多段行程：整份 PUT diff / sortOrder 重寫 / 刪段 detach
  // AC-08~13、AC-05 補完、交易原子性、「不屬於此申請的 segment id」處置
  // ===========================================================================

  describe("PHASE-004-T4 — 多段行程（AC-08~13, D15/D16）", () => {
    it("AC-08 新增行程段（無 id）→ 建立新 TripSegment，回傳其 id 與 sortOrder", async () => {
      const draft = await createOwnerDraft({});
      const resp = await putSegments(ownerCookie, draft.id, [
        {
          origin: "台北車站",
          destination: "新竹車站",
          totalKm: "60",
          highwayKm: "50",
          attachmentIds: [],
        },
      ]);
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: { segments: { id: string; sortOrder: number }[] } }>();
      expect(body.application.segments).toHaveLength(1);
      expect(typeof body.application.segments[0].id).toBe("string");
      expect(body.application.segments[0].id.length).toBeGreaterThan(0);
      expect(body.application.segments[0].sortOrder).toBe(0);
    });

    it("AC-09 每段四欄位可存可讀；草稿階段四欄位皆可為空", async () => {
      const draft = await createOwnerDraft({});
      const resp = await putSegments(ownerCookie, draft.id, [
        {
          origin: "台北車站",
          destination: "新竹車站",
          totalKm: "60.5",
          highwayKm: "50.25",
          attachmentIds: [],
        },
        { attachmentIds: [] }, // 四欄位全部缺席 → 新段視為 null（皆可為空）
      ]);
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{
        application: {
          segments: {
            origin: string | null;
            destination: string | null;
            totalKm: string | null;
            highwayKm: string | null;
          }[];
        };
      }>();
      expect(body.application.segments).toHaveLength(2);
      const [seg1, seg2] = body.application.segments;
      expect(seg1.origin).toBe("台北車站");
      expect(seg1.destination).toBe("新竹車站");
      expect(seg1.totalKm).toBe("60.50");
      expect(seg1.highwayKm).toBe("50.25");
      expect(seg2.origin).toBeNull();
      expect(seg2.destination).toBeNull();
      expect(seg2.totalKm).toBeNull();
      expect(seg2.highwayKm).toBeNull();
    });

    it("AC-10 排序持久化鑑別力：存 [A,B] → 改存 [B,A] → 重新 GET 順序為 [B,A]", async () => {
      const draft = await createOwnerDraft({});
      const first = await putSegments(ownerCookie, draft.id, [
        { origin: "A", destination: "A-to", totalKm: "10", highwayKm: "0", attachmentIds: [] },
        { origin: "B", destination: "B-to", totalKm: "20", highwayKm: "0", attachmentIds: [] },
      ]);
      expect(first.statusCode).toBe(200);
      const firstSegs = first.json<{
        application: { segments: { id: string; origin: string }[] };
      }>().application.segments;
      const segA = mustFind(
        firstSegs.find((s) => s.origin === "A"),
        "segment A not found"
      );
      const segB = mustFind(
        firstSegs.find((s) => s.origin === "B"),
        "segment B not found"
      );

      const second = await putSegments(ownerCookie, draft.id, [{ id: segB.id }, { id: segA.id }]);
      expect(second.statusCode).toBe(200);

      const getResp = await app.inject({
        method: "GET",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
      });
      const getBody = getResp.json<{
        application: { segments: { id: string; origin: string; sortOrder: number }[] };
      }>();
      expect(getBody.application.segments.map((s) => s.origin)).toEqual(["B", "A"]);
      expect(getBody.application.segments.map((s) => s.sortOrder)).toEqual([0, 1]);
    });

    it("AC-11 刪除行程段連帶移除未鎖定附件關聯：2 張 LINKED 附件變 TEMP、ref 欄位清空、createdAt 重置", async () => {
      const draft = await createOwnerDraft({});
      const createResp = await putSegments(ownerCookie, draft.id, [
        { origin: "X", destination: "Y", totalKm: "5", highwayKm: "0", attachmentIds: [] },
      ]);
      const segmentId = createResp.json<{ application: { segments: { id: string }[] } }>()
        .application.segments[0].id;

      const att1 = await createLinkedAttachment(segmentId, ownerId);
      const att2 = await createLinkedAttachment(segmentId, ownerId);
      const originalCreatedAt1 = att1.createdAt.getTime();
      const originalCreatedAt2 = att2.createdAt.getTime();

      await new Promise((resolve) => setTimeout(resolve, 5));

      const deleteResp = await putSegments(ownerCookie, draft.id, []); // 不再包含該段
      expect(deleteResp.statusCode).toBe(200);
      const afterBody = deleteResp.json<{ application: { segments: unknown[] } }>();
      expect(afterBody.application.segments).toEqual([]);

      const rows = await prisma.attachment.findMany({ where: { id: { in: [att1.id, att2.id] } } });
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.status).toBe("TEMP");
        expect(row.refType).toBeNull();
        expect(row.refId).toBeNull();
        expect(row.linkedAt).toBeNull();
      }
      const row1 = mustFind(
        rows.find((r) => r.id === att1.id),
        "attachment row 1 not found"
      );
      const row2 = mustFind(
        rows.find((r) => r.id === att2.id),
        "attachment row 2 not found"
      );
      expect(row1.createdAt.getTime()).toBeGreaterThan(originalCreatedAt1);
      expect(row2.createdAt.getTime()).toBeGreaterThan(originalCreatedAt2);

      // 重新載入草稿不再顯示該段與其附件
      const getResp = await app.inject({
        method: "GET",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(getResp.json<{ application: { segments: unknown[] } }>().application.segments).toEqual(
        []
      );
    });

    it("AC-12 刪到 0 段可儲存（200）", async () => {
      const draft = await createOwnerDraft({});
      await putSegments(ownerCookie, draft.id, [
        { origin: "A", destination: "B", totalKm: "1", highwayKm: "0", attachmentIds: [] },
      ]);
      const resp = await putSegments(ownerCookie, draft.id, []);
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: { segments: unknown[] } }>();
      expect(body.application.segments).toEqual([]);
    });

    it("AC-13 整份儲存以 id 對齊（端到端）：existing=[S1,S2,S3], submitted=[{id:S2},{新},{id:S1}] → S2=0/新段=1/S1=2、S3 刪除並 detach", async () => {
      const draft = await createOwnerDraft({});
      const createResp = await putSegments(ownerCookie, draft.id, [
        { origin: "S1", destination: "S1-to", totalKm: "1", highwayKm: "0", attachmentIds: [] },
        { origin: "S2", destination: "S2-to", totalKm: "2", highwayKm: "0", attachmentIds: [] },
        { origin: "S3", destination: "S3-to", totalKm: "3", highwayKm: "0", attachmentIds: [] },
      ]);
      expect(createResp.statusCode).toBe(200);
      const segs = createResp.json<{
        application: { segments: { id: string; origin: string }[] };
      }>().application.segments;
      const s1 = mustFind(
        segs.find((s) => s.origin === "S1"),
        "segment S1 not found"
      );
      const s2 = mustFind(
        segs.find((s) => s.origin === "S2"),
        "segment S2 not found"
      );
      const s3 = mustFind(
        segs.find((s) => s.origin === "S3"),
        "segment S3 not found"
      );

      const att = await createLinkedAttachment(s3.id, ownerId);

      const resp = await putSegments(ownerCookie, draft.id, [
        { id: s2.id },
        { origin: "NEW", destination: "NEW-to", totalKm: "9", highwayKm: "0", attachmentIds: [] },
        { id: s1.id },
      ]);
      expect(resp.statusCode).toBe(200);
      const after = resp.json<{
        application: { segments: { id: string; origin: string; sortOrder: number }[] };
      }>().application.segments;
      expect(after).toHaveLength(3);
      expect(after.find((s) => s.id === s2.id)?.sortOrder).toBe(0);
      expect(after.find((s) => s.origin === "NEW")?.sortOrder).toBe(1);
      expect(after.find((s) => s.id === s1.id)?.sortOrder).toBe(2);
      expect(after.some((s) => s.id === s3.id)).toBe(false);

      const attRow = await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } });
      expect(attRow.status).toBe("TEMP");
      expect(attRow.refId).toBeNull();
    });

    it("交易原子性鑑別力：submitted 後段夾帶不屬於此申請的 segment id → 全部 rollback，既有段落與附件完全未變", async () => {
      const draft = await createOwnerDraft({});
      const createResp = await putSegments(ownerCookie, draft.id, [
        {
          origin: "Keep-1",
          destination: "Keep-1-to",
          totalKm: "1",
          highwayKm: "0",
          attachmentIds: [],
        },
        {
          origin: "Keep-2",
          destination: "Keep-2-to",
          totalKm: "2",
          highwayKm: "0",
          attachmentIds: [],
        },
      ]);
      const segs = createResp.json<{
        application: { segments: { id: string; origin: string }[] };
      }>().application.segments;
      const keep1 = mustFind(
        segs.find((s) => s.origin === "Keep-1"),
        "segment Keep-1 not found"
      );
      const keep2 = mustFind(
        segs.find((s) => s.origin === "Keep-2"),
        "segment Keep-2 not found"
      );
      const att = await createLinkedAttachment(keep2.id, ownerId);

      // 另建一筆申請取得一個真實存在、但不屬於本申請的 segment id。
      const otherDraft = await createOwnerDraft({});
      const otherSegResp = await putSegments(ownerCookie, otherDraft.id, [
        {
          origin: "Other",
          destination: "Other-to",
          totalKm: "1",
          highwayKm: "0",
          attachmentIds: [],
        },
      ]);
      const foreignSegmentId = otherSegResp.json<{ application: { segments: { id: string }[] } }>()
        .application.segments[0].id;

      // 提交：keep1 合法更新在前；foreignSegmentId 在後；且完全不含 keep2 —
      // 若無交易保護，keep2 會先被判定「未出現於 submitted」而被刪除+detach，
      // 才會在陣列後段的 foreignSegmentId 踩到拒絕。
      const resp = await putSegments(ownerCookie, draft.id, [
        { id: keep1.id },
        { id: foreignSegmentId },
      ]);
      expect(resp.statusCode).toBe(403);

      const segmentsAfter = await prisma.tripSegment.findMany({
        where: { travelApplicationId: draft.id },
      });
      expect(segmentsAfter).toHaveLength(2);
      expect(segmentsAfter.some((s) => s.id === keep2.id)).toBe(true);

      const attRow = await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } });
      expect(attRow.status).toBe("LINKED");
      expect(attRow.refId).toBe(keep2.id);
    });

    it("不屬於此申請的 segment id（存在於他人自己另一筆申請）→ 403 FORBIDDEN，DB 未變", async () => {
      const draft = await createOwnerDraft({});
      const otherDraft = await createOwnerDraft({});
      const otherSegResp = await putSegments(ownerCookie, otherDraft.id, [
        {
          origin: "Other",
          destination: "Other-to",
          totalKm: "1",
          highwayKm: "0",
          attachmentIds: [],
        },
      ]);
      const foreignSegmentId = otherSegResp.json<{ application: { segments: { id: string }[] } }>()
        .application.segments[0].id;

      const resp = await putSegments(ownerCookie, draft.id, [{ id: foreignSegmentId }]);
      expect(resp.statusCode).toBe(403);
      const body = resp.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");

      const segmentsAfter = await prisma.tripSegment.findMany({
        where: { travelApplicationId: draft.id },
      });
      expect(segmentsAfter).toHaveLength(0);
    });

    it("完全不存在的 segment id（非任何申請所屬）→ 亦 403", async () => {
      const draft = await createOwnerDraft({});
      const resp = await putSegments(ownerCookie, draft.id, [
        { id: "totally-nonexistent-segment-id" },
      ]);
      expect(resp.statusCode).toBe(403);
    });

    it("重複的 segment id 於同一次提交中 → 400 VALIDATION_ERROR，DB 未變", async () => {
      const draft = await createOwnerDraft({});
      const createResp = await putSegments(ownerCookie, draft.id, [
        { origin: "Dup", destination: "Dup-to", totalKm: "1", highwayKm: "0", attachmentIds: [] },
      ]);
      const segId = createResp.json<{ application: { segments: { id: string }[] } }>().application
        .segments[0].id;

      const resp = await putSegments(ownerCookie, draft.id, [{ id: segId }, { id: segId }]);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");

      const segmentsAfter = await prisma.tripSegment.findMany({
        where: { travelApplicationId: draft.id },
      });
      expect(segmentsAfter).toHaveLength(1);
      expect(segmentsAfter[0].sortOrder).toBe(0);
    });

    it("AC-05 補完：DELETE 草稿含段落與 LINKED 附件 → 附件變 TEMP 且 ref 欄位清空", async () => {
      const draft = await createOwnerDraft({});
      const createResp = await putSegments(ownerCookie, draft.id, [
        {
          origin: "Del-1",
          destination: "Del-1-to",
          totalKm: "1",
          highwayKm: "0",
          attachmentIds: [],
        },
      ]);
      const segmentId = createResp.json<{ application: { segments: { id: string }[] } }>()
        .application.segments[0].id;
      const att = await createLinkedAttachment(segmentId, ownerId);

      const delResp = await app.inject({
        method: "DELETE",
        url: `/applications/${draft.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(delResp.statusCode).toBe(200);
      const idx = createdApplicationIds.indexOf(draft.id);
      if (idx >= 0) createdApplicationIds.splice(idx, 1);

      const attRow = await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } });
      expect(attRow.status).toBe("TEMP");
      expect(attRow.refType).toBeNull();
      expect(attRow.refId).toBeNull();
      expect(attRow.linkedAt).toBeNull();
    });
  });

  // ===========================================================================
  // PHASE-004-T7 — computed/missingParameters 接進草稿 DTO（AC-46, D6, §8.1）
  //
  // 本區塊擁有自己的 FuelParameterVersion/EtcParameterVersion 生效日區段
  // （2032 年），與本檔既有測試（2026/2030 年）及
  // phase4-travel-preview.test.ts 專用的 2031 年區段皆不重疊，避免撞全域
  // 唯一鍵 `@@unique([effectiveFrom])`（Packet 明文要求：本檔測試須使用不與
  // 其他測試檔衝突的生效日；本檔自 T3 起既有測試皆未建立任何參數版本，故此
  // 為本檔第一次、也是唯一一處建立 FuelParameterVersion/EtcParameterVersion
  // 的地方）。cleanup 限定自建版本 id，不使用 deleteMany({})。
  // ===========================================================================

  describe("PHASE-004-T7 — computed/missingParameters", () => {
    const PARAM_DATE = "2032-01-01"; // 本區塊專屬生效日：油資 6.0000 / ETC 3.0000
    const BEFORE_PARAM_DATE = "2020-06-15"; // 早於 PARAM_DATE，故必然缺參數

    let fuelVersionId: string;
    let etcVersionId: string;

    beforeAll(async () => {
      if (!DB_URL) return;
      const fuel = await prisma.fuelParameterVersion.create({
        data: {
          unitPrice: new Prisma.Decimal("6.0000"),
          effectiveFrom: new Date(PARAM_DATE),
          createdById: ownerId,
        },
      });
      const etc = await prisma.etcParameterVersion.create({
        data: {
          unitPrice: new Prisma.Decimal("3.0000"),
          effectiveFrom: new Date(PARAM_DATE),
          createdById: ownerId,
        },
      });
      fuelVersionId = fuel.id;
      etcVersionId = etc.id;
    });

    afterAll(async () => {
      if (!DB_URL) return;
      if (fuelVersionId) {
        await prisma.fuelParameterVersion.deleteMany({ where: { id: fuelVersionId } });
      }
      if (etcVersionId) {
        await prisma.etcParameterVersion.deleteMany({ where: { id: etcVersionId } });
      }
    });

    it("AC-46 缺參數仍可存草稿 → 200，completionBlockers 含 PARAMETER_NOT_AVAILABLE", async () => {
      const draft = await createOwnerDraft({});
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { tripDate: BEFORE_PARAM_DATE, purpose: "缺參數測試" },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: { completionBlockers: { code: string }[] } }>();
      expect(body.application.completionBlockers.map((b) => b.code)).toContain(
        "PARAMETER_NOT_AVAILABLE"
      );
    });

    it("參數齊備時草稿 computed 有值且金額正確（依實際建立之單價：油資6/ETC 3）", async () => {
      const draft = await createOwnerDraft({});
      await putSegments(
        ownerCookie,
        draft.id,
        [{ origin: "甲地", destination: "乙地", totalKm: "10", highwayKm: "4", attachmentIds: [] }],
        { tripDate: PARAM_DATE, purpose: "參數齊備測試" }
      );

      const resp = await app.inject({
        method: "GET",
        url: `/applications/travel/${draft.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{
        application: {
          computed: {
            parameterAvailable: boolean;
            missingParameters: string[];
            segments: {
              fuelAmount: string;
              etcAmount: string;
              rawAmount: string;
              amount: number;
            }[];
            totalAmount: number;
          } | null;
        };
      }>();
      expect(body.application.computed).not.toBeNull();
      const computed = body.application.computed as NonNullable<typeof body.application.computed>;
      expect(computed.parameterAvailable).toBe(true);
      expect(computed.missingParameters).toEqual([]);
      expect(computed.segments[0].fuelAmount).toBe("60.0000"); // 10 × 6
      expect(computed.segments[0].etcAmount).toBe("12.0000"); // 4 × 3
      expect(computed.segments[0].rawAmount).toBe("72.0000");
      expect(computed.segments[0].amount).toBe(72);
      expect(computed.totalAmount).toBe(72);
    });

    it("D6 鑑別力：草稿 GET 回應（一般使用者與管理員皆同）不含單價欄位", async () => {
      const draft = await createOwnerDraft({});
      await putSegments(
        ownerCookie,
        draft.id,
        [{ origin: "甲地", destination: "乙地", totalKm: "5", highwayKm: "1", attachmentIds: [] }],
        { tripDate: PARAM_DATE, purpose: "D6 測試" }
      );

      for (const cookie of [ownerCookie, adminCookie]) {
        const resp = await app.inject({
          method: "GET",
          url: `/applications/travel/${draft.id}`,
          headers: { cookie },
        });
        expect(resp.statusCode).toBe(200);
        const body = resp.json<Record<string, unknown>>();
        const application = body.application as Record<string, unknown>;
        const computed = application.computed as Record<string, unknown>;
        expect(computed.fuelUnitPrice).toBeUndefined();
        expect(computed.etcUnitPrice).toBeUndefined();
        expect(computed.fuelParameterVersionId).toBeUndefined();
        expect(computed.etcParameterVersionId).toBeUndefined();
        const seg = (computed.segments as Record<string, unknown>[])[0];
        expect(seg.fuelUnitPrice).toBeUndefined();
        expect(seg.etcUnitPrice).toBeUndefined();
        const raw = JSON.stringify(body);
        expect(raw).not.toContain("fuelUnitPrice");
        expect(raw).not.toContain("etcUnitPrice");
        expect(raw).not.toContain("fuelParameterVersionId");
        expect(raw).not.toContain("etcParameterVersionId");
      }
    });
  });
});
