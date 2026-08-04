/**
 * Integration tests for PHASE-006-T4:
 *   保養草稿 CRUD 端點 + 欄位驗證（gate table）+ 狀態/授權守門。
 *
 * TDD: written to exercise the real HTTP routes registered by buildServer().
 * First run (before maintenance-service.ts/routes.ts wiring existed) was RED
 * — 404 on every /applications/maintenance path (unknown route). See Task
 * Handoff for the captured first-run RED output.
 *
 * AC covered (PHASE-006 Spec §2): AC-02, AC-03, AC-04, AC-05; B-21~B-23,
 * B-34, B-35（無 query，NA）；§6.1 授權矩陣「403 先於 400」判定順序。
 *
 * Test discipline (Spec §11.0 / Packet):
 *   - loginName prefix "p6t4_" + per-run random suffix.
 *   - cleanup scoped to this suite's own tracked application ids + loginName
 *     prefix; NEVER deleteMany({}) globally.
 *   - synthetic data only.
 */
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

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

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p6t4_";
const PASSWORD = "MaintenanceDraftTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;
const MCP_LOGIN = `${LOGIN_PREFIX}mcp_${RUN_ID}`;

const NONEXISTENT_ID = "p6t4-nonexistent-application-id-000000";

describeWithDb("PHASE-006-T4 — 保養草稿 CRUD + 欄位驗證 + 授權隔離", () => {
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

  const createdApplicationIds: string[] = [];
  function track(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  async function createDraft(cookie: string, payload: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/applications/maintenance",
      headers: { cookie },
      payload,
    });
  }

  async function createOwnerDraft(payload: Record<string, unknown> = {}) {
    const resp = await createDraft(ownerCookie, payload);
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ application: Record<string, unknown> & { id: string } }>();
    track(body.application.id);
    return body.application;
  }

  async function putDraft(cookie: string, id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/applications/maintenance/${id}`,
      headers: { cookie },
      payload,
    });
  }

  async function markCompleted(applicationId: string) {
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: "COMPLETED", completedAt: new Date(), totalAmount: 5000 },
    });
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);

    const owner = await prisma.user.create({
      data: {
        loginName: OWNER_LOGIN,
        displayName: "P6T4 擁有人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const other = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "P6T4 他人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "P6T4 管理員",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const mcp = await prisma.user.create({
      data: {
        loginName: MCP_LOGIN,
        displayName: "P6T4 待改密使用者",
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
  // AC-02 — POST/PUT 允許部分資料 + 三態語意
  // ===========================================================================

  describe("POST /applications/maintenance > AC-02 creates a DRAFT with an empty body (all five fields null, blockers listed)", () => {
    it("空 body → 201, status=DRAFT, ownerId=createdById=self, 五欄皆 null, completionBlockers 非空", async () => {
      const resp = await createDraft(ownerCookie, {});
      expect(resp.statusCode).toBe(201);
      const body = resp.json<{ application: Record<string, unknown> }>();
      const application = body.application;
      track(application.id as string);

      expect(application.type).toBe("MAINTENANCE");
      expect(application.status).toBe("DRAFT");
      expect(application.ownerId).toBe(ownerId);
      expect(application.createdById).toBe(ownerId);
      expect(application.lastMaintenanceDate).toBeNull();
      expect(application.currentMaintenanceDate).toBeNull();
      expect(application.lastOdometerKm).toBeNull();
      expect(application.currentOdometerKm).toBeNull();
      expect(application.actualCost).toBeNull();
      expect(application.attachments).toEqual([]);
      expect(application.computed).toBeNull();
      expect(application.snapshot).toBeNull();

      const codes = (application.completionBlockers as { code: string }[]).map((b) => b.code);
      expect(codes).toEqual([
        "LAST_MAINTENANCE_DATE_REQUIRED",
        "CURRENT_MAINTENANCE_DATE_REQUIRED",
        "LAST_ODOMETER_REQUIRED",
        "CURRENT_ODOMETER_REQUIRED",
        "ACTUAL_COST_REQUIRED",
        "MAINTENANCE_ATTACHMENT_REQUIRED",
      ]);
    });

    it("POST 帶 ownerId/createdById 於 body → 一律忽略，owner 恆為呼叫者本人", async () => {
      const resp = await createDraft(ownerCookie, { ownerId: otherId, createdById: otherId });
      expect(resp.statusCode).toBe(201);
      const body = resp.json<{ application: Record<string, unknown> }>();
      track(body.application.id as string);
      expect(body.application.ownerId).toBe(ownerId);
      expect(body.application.createdById).toBe(ownerId);
    });
  });

  describe("PUT /applications/maintenance/:id > AC-02 partial update keeps unspecified fields unchanged (three-state key semantics)", () => {
    it("只帶 actualCost → 200；其餘四欄不受影響", async () => {
      const draft = await createOwnerDraft({
        lastMaintenanceDate: "2026-01-01",
        currentMaintenanceDate: "2026-02-01",
        lastOdometerKm: "1000",
        currentOdometerKm: "1500",
      });
      const resp = await putDraft(ownerCookie, draft.id as string, { actualCost: "888.50" });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: Record<string, unknown> }>();
      expect(body.application.lastMaintenanceDate).toBe("2026-01-01");
      expect(body.application.currentMaintenanceDate).toBe("2026-02-01");
      expect(body.application.lastOdometerKm).toBe("1000.00");
      expect(body.application.currentOdometerKm).toBe("1500.00");
      expect(body.application.actualCost).toBe("888.50");
    });

    it("三態：key 缺席＝不變、key=null＝清空、key 有值＝設定（逐欄）", async () => {
      const draft = await createOwnerDraft({
        lastMaintenanceDate: "2026-03-01",
        currentMaintenanceDate: "2026-04-01",
        lastOdometerKm: "100",
        currentOdometerKm: "200",
        actualCost: "500",
      });

      // 缺席 = 不變
      const r1 = await putDraft(ownerCookie, draft.id as string, {});
      expect(r1.statusCode).toBe(200);
      const b1 = r1.json<{ application: Record<string, unknown> }>();
      expect(b1.application.lastMaintenanceDate).toBe("2026-03-01");
      expect(b1.application.actualCost).toBe("500.00");

      // null = 清空
      const r2 = await putDraft(ownerCookie, draft.id as string, {
        lastMaintenanceDate: null,
        actualCost: null,
      });
      expect(r2.statusCode).toBe(200);
      const b2 = r2.json<{ application: Record<string, unknown> }>();
      expect(b2.application.lastMaintenanceDate).toBeNull();
      expect(b2.application.actualCost).toBeNull();
      expect(b2.application.currentMaintenanceDate).toBe("2026-04-01"); // 未提及＝不變

      // 有值 = 設定
      const r3 = await putDraft(ownerCookie, draft.id as string, {
        lastMaintenanceDate: "2026-05-01",
        actualCost: "999.99",
      });
      expect(r3.statusCode).toBe(200);
      const b3 = r3.json<{ application: Record<string, unknown> }>();
      expect(b3.application.lastMaintenanceDate).toBe("2026-05-01");
      expect(b3.application.actualCost).toBe("999.99");
    });

    it("completionBlockers 隨欄位完整度變化", async () => {
      const draft = await createOwnerDraft({});
      const initialCodes = (draft.completionBlockers as { code: string }[]).map((b) => b.code);
      expect(initialCodes).toContain("LAST_ODOMETER_REQUIRED");

      const resp = await putDraft(ownerCookie, draft.id as string, {
        lastMaintenanceDate: "2026-01-01",
        currentMaintenanceDate: "2026-01-02",
        lastOdometerKm: "1000",
        currentOdometerKm: "1100",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: Record<string, unknown> }>();
      const codes = (body.application.completionBlockers as { code: string }[]).map((b) => b.code);
      // 五欄皆合法齊備，且未接線期間公務里程（officialKm=null，第一段）
      // → 僅剩結構性第 10 項（附件必要）。
      expect(codes).toEqual(["MAINTENANCE_ATTACHMENT_REQUIRED"]);
    });
  });

  // ===========================================================================
  // AC-03 — 分層 gate table：格式四道 → 容量層 → 值域層；絕不 500
  // ===========================================================================

  describe("PUT /applications/maintenance/:id > AC-03 ordered gate table: $label returns its own reason (400, never 500)", () => {
    const cases: { label: string; field: string; value: unknown }[] = [
      { label: "date 非 YYYY-MM-DD 格式", field: "lastMaintenanceDate", value: "20260101" },
      { label: "date 非法曆日", field: "currentMaintenanceDate", value: "2026-02-30" },
      { label: "date 型別錯誤（數字）", field: "lastMaintenanceDate", value: 20260101 },
      { label: "odometer 非數字字串", field: "lastOdometerKm", value: "abc" },
      { label: "odometer 千分位", field: "lastOdometerKm", value: "1,000" },
      { label: "odometer 科學記號", field: "currentOdometerKm", value: "1e2" },
      { label: "odometer 超過 2 位小數", field: "lastOdometerKm", value: "12.345" },
      { label: "odometer 容量超出（1e8）", field: "currentOdometerKm", value: "100000000" },
      // 注意：JSON 無法傳輸實際的 NaN/Infinity 數字字面值（JSON.stringify 會將
      // 其序列化為 null，等同「清空」而非「非法值」）——故 HTTP 層以字串
      // "NaN"/"Infinity" 驗證 NaN/Infinity 防禦（純函式層之數字型別防禦已由
      // trip-validation.test.ts 之單元測試覆蓋，見該檔 Number.NaN 案例）。
      { label: "odometer NaN 字串", field: "lastOdometerKm", value: "NaN" },
      { label: "odometer Infinity 字串", field: "currentOdometerKm", value: "Infinity" },
      { label: "odometer 型別錯誤（陣列）", field: "lastOdometerKm", value: [] },
      { label: "actualCost 非數字字串", field: "actualCost", value: "not-a-number" },
      { label: "actualCost 千分位", field: "actualCost", value: "1,234.00" },
      { label: "actualCost 科學記號", field: "actualCost", value: "1e5" },
      { label: "actualCost 超過 2 位小數", field: "actualCost", value: "100.005" },
      { label: "actualCost 容量超出（1e10）", field: "actualCost", value: "10000000000" },
      { label: "actualCost NaN 字串", field: "actualCost", value: "NaN" },
      { label: "actualCost Infinity 字串", field: "actualCost", value: "Infinity" },
      { label: "actualCost 型別錯誤（布林）", field: "actualCost", value: true },
    ];

    for (const { label, field, value } of cases) {
      it(`${label} → 400 VALIDATION_ERROR，fields[] 定位到 ${field}`, async () => {
        const draft = await createOwnerDraft({});
        const resp = await putDraft(ownerCookie, draft.id as string, { [field]: value });
        expect(resp.statusCode).toBe(400);
        const body = resp.json<{
          error: { code: string; fields?: { field: string; reason: string }[] };
        }>();
        expect(body.error.code).toBe("VALIDATION_ERROR");
        const match = (body.error.fields ?? []).find((f) => f.field === field);
        expect(match).toBeDefined();
        expect(match?.reason.length).toBeGreaterThan(0);
      });
    }

    it("多欄同時不合法 → fields[] 全部回報（非只回第一項）", async () => {
      const draft = await createOwnerDraft({});
      const resp = await putDraft(ownerCookie, draft.id as string, {
        lastOdometerKm: "abc",
        actualCost: "1e5",
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{ error: { fields?: { field: string }[] } }>();
      const fields = (body.error.fields ?? []).map((f) => f.field);
      expect(fields).toContain("lastOdometerKm");
      expect(fields).toContain("actualCost");
    });
  });

  describe("PUT /applications/maintenance/:id > AC-03 boundary positives are accepted (0.01 cost, 0.01 km, leading/trailing spaces trimmed)", () => {
    it("actualCost=0.01（最小合法值格式層）→ 200", async () => {
      const draft = await createOwnerDraft({});
      const resp = await putDraft(ownerCookie, draft.id as string, { actualCost: "0.01" });
      expect(resp.statusCode).toBe(200);
      expect(resp.json<{ application: Record<string, unknown> }>().application.actualCost).toBe(
        "0.01"
      );
    });

    it("odometer=0.01（最小正值）→ 200", async () => {
      const draft = await createOwnerDraft({});
      const resp = await putDraft(ownerCookie, draft.id as string, { lastOdometerKm: "0.01" });
      expect(resp.statusCode).toBe(200);
      expect(resp.json<{ application: Record<string, unknown> }>().application.lastOdometerKm).toBe(
        "0.01"
      );
    });

    it("actualCost 容量邊界（1e10 - 0.01，恰通過）→ 200", async () => {
      const draft = await createOwnerDraft({});
      const resp = await putDraft(ownerCookie, draft.id as string, { actualCost: "9999999999.99" });
      expect(resp.statusCode).toBe(200);
    });

    it("odometer 前後空白 trim 後判定 → 200，儲存值不含空白", async () => {
      const draft = await createOwnerDraft({});
      const resp = await putDraft(ownerCookie, draft.id as string, {
        lastOdometerKm: "  123.45  ",
      });
      expect(resp.statusCode).toBe(200);
      expect(resp.json<{ application: Record<string, unknown> }>().application.lastOdometerKm).toBe(
        "123.45"
      );
    });

    it("date 邊界曆日（閏年 2028-02-29）→ 200", async () => {
      const draft = await createOwnerDraft({});
      const resp = await putDraft(ownerCookie, draft.id as string, {
        lastMaintenanceDate: "2028-02-29",
      });
      expect(resp.statusCode).toBe(200);
      expect(
        resp.json<{ application: Record<string, unknown> }>().application.lastMaintenanceDate
      ).toBe("2028-02-29");
    });
  });

  // ===========================================================================
  // AC-04 — 已完成不可修改（403 FORBIDDEN，DB 零寫入）
  // ===========================================================================

  describe("AC-04 completed maintenance rejects PUT with 403 and the verbatim 已完成的申請不可修改，請建立修正版 message (zero DB writes)", () => {
    it("PUT 已完成申請 → 403，訊息逐字符合，資料未變更", async () => {
      const draft = await createOwnerDraft({ actualCost: "111.00" });
      await markCompleted(draft.id as string);

      const resp = await putDraft(ownerCookie, draft.id as string, { actualCost: "999.00" });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toBe("已完成的申請不可修改，請建立修正版");

      const stillThere = await prisma.maintenanceApplication.findUnique({
        where: { applicationId: draft.id as string },
      });
      expect(stillThere?.actualCost?.toFixed(2)).toBe("111.00");
    });

    it("… > and rejects DELETE with 403", async () => {
      const draft = await createOwnerDraft({ actualCost: "222.00" });
      await markCompleted(draft.id as string);

      const resp = await app.inject({
        method: "DELETE",
        url: `/applications/${draft.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");

      const stillThere = await prisma.application.findUnique({ where: { id: draft.id as string } });
      expect(stillThere).not.toBeNull();
      expect(stillThere?.status).toBe("COMPLETED");
    });
  });

  // ===========================================================================
  // AC-05 — 授權隔離
  // ===========================================================================

  describe("AC-05 授權隔離 > another normal user gets 403 on GET/PUT/DELETE and no business field leaks", () => {
    it("他人 GET → 403，body 不含業務欄位", async () => {
      const draft = await createOwnerDraft({ actualCost: "333.00" });
      const resp = await app.inject({
        method: "GET",
        url: `/applications/maintenance/${draft.id}`,
        headers: { cookie: otherCookie },
      });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<Record<string, unknown>>();
      expect(body.actualCost).toBeUndefined();
      expect(body.application).toBeUndefined();
      expect(body.lastOdometerKm).toBeUndefined();
    });

    it("他人 PUT → 403，body 不含業務欄位，DB 未變", async () => {
      const draft = await createOwnerDraft({ actualCost: "444.00" });
      const resp = await putDraft(otherCookie, draft.id as string, { actualCost: "0.01" });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<Record<string, unknown>>();
      expect(body.actualCost).toBeUndefined();

      const row = await prisma.maintenanceApplication.findUnique({
        where: { applicationId: draft.id as string },
      });
      expect(row?.actualCost?.toFixed(2)).toBe("444.00");
    });

    it("他人 DELETE → 403，資料未刪除", async () => {
      const draft = await createOwnerDraft({});
      const resp = await app.inject({
        method: "DELETE",
        url: `/applications/${draft.id}`,
        headers: { cookie: otherCookie },
      });
      expect(resp.statusCode).toBe(403);
      const stillThere = await prisma.application.findUnique({ where: { id: draft.id as string } });
      expect(stillThere).not.toBeNull();
    });

    it("管理員 GET/PUT → 200（可代讀/代修改草稿）", async () => {
      const draft = await createOwnerDraft({});
      const getResp = await app.inject({
        method: "GET",
        url: `/applications/maintenance/${draft.id}`,
        headers: { cookie: adminCookie },
      });
      expect(getResp.statusCode).toBe(200);

      const putResp = await putDraft(adminCookie, draft.id as string, { actualCost: "1.00" });
      expect(putResp.statusCode).toBe(200);
    });

    it("… > unauthenticated → 401", async () => {
      const draft = await createOwnerDraft({});
      const getResp = await app.inject({
        method: "GET",
        url: `/applications/maintenance/${draft.id}`,
      });
      expect(getResp.statusCode).toBe(401);

      const putResp = await app.inject({
        method: "PUT",
        url: `/applications/maintenance/${draft.id}`,
        payload: { actualCost: "1.00" },
      });
      expect(putResp.statusCode).toBe(401);

      const delResp = await app.inject({
        method: "DELETE",
        url: `/applications/${draft.id}`,
      });
      expect(delResp.statusCode).toBe(401);
    });

    it("… > mustChangePassword → 403 PASSWORD_CHANGE_REQUIRED", async () => {
      const draft = await createOwnerDraft({});
      const getResp = await app.inject({
        method: "GET",
        url: `/applications/maintenance/${draft.id}`,
        headers: { cookie: mcpCookie },
      });
      expect(getResp.statusCode).toBe(403);
      expect(getResp.json<{ error: { code: string } }>().error.code).toBe(
        "PASSWORD_CHANGE_REQUIRED"
      );

      const putResp = await putDraft(mcpCookie, draft.id as string, {});
      expect(putResp.statusCode).toBe(403);
      expect(putResp.json<{ error: { code: string } }>().error.code).toBe(
        "PASSWORD_CHANGE_REQUIRED"
      );
    });

    it("不存在資源 → 404（GET/PUT）", async () => {
      const getResp = await app.inject({
        method: "GET",
        url: `/applications/maintenance/${NONEXISTENT_ID}`,
        headers: { cookie: ownerCookie },
      });
      expect(getResp.statusCode).toBe(404);

      const putResp = await putDraft(ownerCookie, NONEXISTENT_ID, { actualCost: "1.00" });
      expect(putResp.statusCode).toBe(404);
    });

    it("… > B-34: :id pointing at a TRAVEL application returns 404, never leaks its type", async () => {
      const travelResp = await app.inject({
        method: "POST",
        url: "/applications/travel",
        headers: { cookie: ownerCookie },
        payload: {},
      });
      expect(travelResp.statusCode).toBe(201);
      const travelId = travelResp.json<{ application: { id: string } }>().application.id;
      track(travelId);

      const resp = await app.inject({
        method: "GET",
        url: `/applications/maintenance/${travelId}`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(404);
      const raw = JSON.stringify(resp.json());
      expect(raw).not.toContain("TRAVEL");
    });
  });

  // ===========================================================================
  // 判定順序：403（授權）先於 400（格式驗證）
  // ===========================================================================

  describe("判定順序：403 先於 400", () => {
    it("他人 PUT 帶格式錯誤的 body（畸形值）→ 仍為 403（不因 body 是否合法而洩漏是否存在授權問題）", async () => {
      const draft = await createOwnerDraft({});
      const resp = await putDraft(otherCookie, draft.id as string, {
        actualCost: "not-a-number-at-all",
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    });

    it("已完成申請被他人 PUT（同時違反授權與已完成不可變）→ 403 FORBIDDEN（授權優先於狀態機/格式）", async () => {
      const draft = await createOwnerDraft({});
      await markCompleted(draft.id as string);
      const resp = await putDraft(otherCookie, draft.id as string, { actualCost: "bad-value" });
      expect(resp.statusCode).toBe(403);
    });
  });

  // ===========================================================================
  // 不採信請求體識別（§6.2 資料隔離不變式 1）
  // ===========================================================================

  describe("不採信請求體識別", () => {
    it("PUT body 帶 status/totalAmount/ownerId → 一律忽略，DB 不變", async () => {
      const draft = await createOwnerDraft({ actualCost: "100.00" });
      const resp = await putDraft(ownerCookie, draft.id as string, {
        status: "COMPLETED",
        totalAmount: 999999,
        ownerId: otherId,
        createdById: otherId,
      });
      expect(resp.statusCode).toBe(200);
      const row = await prisma.application.findUnique({ where: { id: draft.id as string } });
      expect(row?.status).toBe("DRAFT");
      expect(row?.totalAmount).toBeNull();
      expect(row?.ownerId).toBe(ownerId);
      expect(row?.createdById).toBe(ownerId);
    });
  });
});
