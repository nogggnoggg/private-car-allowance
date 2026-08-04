/**
 * Integration tests for PHASE-007-T11／T11b — 折舊代操作（代建立＋代修改）
 * ＋ 稽核（AC-34／AC-35 全面）。
 *
 * Covers Spec §2 群組 J：
 *   - **AC-34** `POST /admin/users/:userId/applications/depreciation`（管理員
 *     限定）→ **201**，`ownerId = :userId`、`createdById` ＝ 管理員、
 *     `onBehalf=true`；一般使用者 → **403**；`:userId` 不存在 → **404**；
 *     `:userId` 已停用 → **400 VALIDATION_ERROR**（006 §18 SF-4 裁定 (a) 之
 *     一致性義務，文案沿差旅／保養既有端點）。稽核
 *     `APPLICATION_CREATED_ON_BEHALF`、`summary.type = "DEPRECIATION"`，
 *     **與業務寫入同交易**（回滾時稽核亦不留，以真交易而非 stub 證明）。
 *   - **AC-35** 管理員 `PUT /applications/depreciation/:id` 於他人草稿 →
 *     **200** 且寫 `APPLICATION_UPDATED_ON_BEHALF`（`summary.type =
 *     "DEPRECIATION"`，含 `applicationYear` 變更前後值，不含密碼／token／
 *     session）；本人自建／自改**不寫稽核**（沿 PHASE-004 AC-86）；管理員修改
 *     **已完成**申請 → **403**（AD-US-08 第 3 條）。**不新增 `AuditAction`**。
 *   - **AC-29／§16 D9(a)** 無代完成路徑之負向斷言（三候選路徑 404 ＋
 *     `admin/routes.ts` 不得出現 complete 動詞之結構性掃描）。
 *
 * ── AC-35 稽核面之落地歷程（誠實記錄，勿據舊註解推論現況） ────────────────
 *   AC-35 之稽核 hook 唯一正當落點為 `backend/src/applications/routes.ts` 之
 *   PUT depreciation handler（呼叫端為唯一持有 `actorId` 者；service 層刻意
 *   無 actor 概念以免新增夾帶面）。該檔原不在 T11 之 Files Allowed（Spec §15
 *   T11 檔案清單漏列），故 T11 交付時 AC-35 稽核面暫缺、由 implementer 以
 *   BLOCKED 回報；大總管裁定 (a) 後以 **T11b-LITE** 限縮授權補齊（見 Spec §18
 *   2026-08-05「§15 T11 檔案清單勘誤」列）。**現況：AC-34／AC-35 皆已全面落地
 *   並由本檔覆蓋**（代修改稽核見「AC-35 代修改」段 :521-602 一帶）。
 *
 * TDD: T11 之測試寫在 `POST /admin/users/:userId/applications/depreciation`
 * 存在之前（首輪 RED：404 route not found）；T11b 之三條代修改稽核斷言寫在
 * `onUpdated` hook 接線之前（RED：稽核列數 0）。兩份 RED 輸出見各自 Handoff。
 *
 * 沿用既有先例：`phase6-on-behalf.test.ts`（AC-30/31 同型全套覆蓋、直接呼叫
 * service 注入失敗以證交易回滾、sentinel AuditLog 釘死 hook 收到的是 `tx`
 * 而非交易外 `prisma`）、`phase4-on-behalf-audit.test.ts`（逐鍵敏感內容掃描）。
 *
 * Test discipline (Spec §11.0 / Packet):
 *   - loginName prefix "p7t11_" + per-run random suffix。
 *   - 年度資源：既有 phase7 測試檔已用罄 2040~2075（T9 FW）與 2085~2090
 *     （`phase7-snapshot-immutability.test.ts` 獨佔），本檔另起 **2101+**
 *     區間，且所有申請均掛於本次執行獨有之 owner。
 *   - cleanup 僅限本次 RUN_ID 範圍內之 application/attachment id ＋ loginName
 *     prefix ＋ AuditLog（`targetLabel: { contains: RUN_ID }`）；嚴禁全域
 *     `deleteMany({})`。
 *   - synthetic data only。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDepreciationDraft,
  updateDepreciationDraft,
} from "../../src/applications/depreciation-service.js";
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
const LOGIN_PREFIX = "p7t11_";
const PASSWORD = "P7T11OnBehalfTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const MCP_LOGIN = `${LOGIN_PREFIX}mcp_${RUN_ID}`;
const INACTIVE_LOGIN = `${LOGIN_PREFIX}inactive_${RUN_ID}`;

interface ErrorJson {
  error: { code: string; message: string; fields?: { field: string; reason: string }[] };
}
interface DepreciationApplicationJson {
  id: string;
  type: string;
  status: string;
  ownerId: string;
  createdById: string;
  onBehalf: boolean;
  primaryDate: string;
  applicationYear: number | null;
}

// ---------------------------------------------------------------------------
// 逐鍵斷言：遞迴走訪任意 JSON 值的所有 key/value（同
// `phase4-on-behalf-audit.test.ts`／`phase6-on-behalf.test.ts` 既有慣例，
// 非只用一次 stringify+regex）。
// ---------------------------------------------------------------------------

const FORBIDDEN_PATTERNS = [
  /password/i,
  /passwordHash/i,
  /\btoken\b/i,
  /cookie/i,
  /\bhash\b/i,
  /secret/i,
];

function assertNoSensitiveContent(value: unknown, path: string): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(value, `value at ${path} matched forbidden pattern ${pattern}`).not.toMatch(pattern);
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSensitiveContent(item, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(key, `key at ${path}.${key} matched forbidden pattern ${pattern}`).not.toMatch(
          pattern
        );
      }
      assertNoSensitiveContent(v, `${path}.${key}`);
    }
  }
}

describeWithDb("PHASE-007-T11 — 折舊代操作（代建立）＋ 稽核（AC-34/35）", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let adminId: string;
  let otherId: string;
  let mcpId: string;
  let inactiveId: string;

  let ownerCookie: string;
  let adminCookie: string;
  let otherCookie: string;
  let mcpCookie: string;

  const createdApplicationIds: string[] = [];

  function trackApp(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);

    const owner = await prisma.user.create({
      data: {
        loginName: OWNER_LOGIN,
        displayName: "P7T11 一般使用者（代操作目標）",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "P7T11 管理員",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const other = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "P7T11 非管理員（授權矩陣負向）",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const mcp = await prisma.user.create({
      data: {
        loginName: MCP_LOGIN,
        displayName: "P7T11 待改密管理員（PCR 403）",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: true,
      },
    });
    const inactive = await prisma.user.create({
      data: {
        loginName: INACTIVE_LOGIN,
        displayName: "P7T11 停用使用者（SF-4 代建立擋下）",
        passwordHash: hash,
        role: "USER",
        isActive: false,
        mustChangePassword: false,
      },
    });

    ownerId = owner.id;
    adminId = admin.id;
    otherId = other.id;
    mcpId = mcp.id;
    inactiveId = inactive.id;

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    ownerCookie = await loginUser(app, OWNER_LOGIN, PASSWORD);
    adminCookie = await loginUser(app, ADMIN_LOGIN, PASSWORD);
    otherCookie = await loginUser(app, OTHER_LOGIN, PASSWORD);
    mcpCookie = await loginUser(app, MCP_LOGIN, PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      if (createdApplicationIds.length > 0) {
        await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
      }
      // AuditLog cleanup: targetLabel 為 `${ownerLoginName}#${applicationId}`
      // 或本檔之 sentinel 標籤，兩者皆含本次 RUN_ID（Packet：嚴禁全域
      // deleteMany({})）。
      await prisma.auditLog.deleteMany({ where: { targetLabel: { contains: RUN_ID } } });
      const userIds = [ownerId, adminId, otherId, mcpId, inactiveId].filter(Boolean);
      if (userIds.length > 0) {
        await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      }
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
  });

  // ===========================================================================
  // Fixture helpers
  // ===========================================================================

  async function onBehalfCreate(
    cookie: string | undefined,
    userId: string,
    payload: Record<string, unknown> = {}
  ) {
    return app.inject({
      method: "POST",
      url: `/admin/users/${userId}/applications/depreciation`,
      headers: cookie ? { cookie } : {},
      payload,
    });
  }

  async function createOwnDraft(
    cookie: string,
    payload: Record<string, unknown> = {}
  ): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/depreciation",
      headers: { cookie },
      payload,
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ application: DepreciationApplicationJson }>();
    return trackApp(body.application.id);
  }

  async function putDepreciation(cookie: string, id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/applications/depreciation/${id}`,
      headers: { cookie },
      payload,
    });
  }

  /** 本次執行之全域基準：Application 與 AuditLog 於本檔涉及之使用者範圍內筆數。 */
  async function countScoped(): Promise<{ applications: number; audits: number }> {
    const applications = await prisma.application.count({
      where: { ownerId: { in: [ownerId, adminId, otherId, inactiveId] } },
    });
    const audits = await prisma.auditLog.count({
      where: { targetId: { in: [ownerId, adminId, otherId, inactiveId] } },
    });
    return { applications, audits };
  }

  // ===========================================================================
  // AC-34 — 代建立成功：ownerId/createdById 分離 ＋ 同交易稽核
  // ===========================================================================

  describe("AC-34 代建立 — 201，ownerId=U、createdById=admin，AuditLog 欄位精確", () => {
    it("POST /admin/users/:userId/applications/depreciation → 201，owner/creator 分離且 AuditLog action/actorId/targetId/targetLabel/summary 精確", async () => {
      const resp = await onBehalfCreate(adminCookie, ownerId, { applicationYear: 2101 });
      expect(resp.statusCode).toBe(201);
      const application = resp.json<{ application: DepreciationApplicationJson }>().application;
      trackApp(application.id);

      expect(application.type).toBe("DEPRECIATION");
      expect(application.status).toBe("DRAFT");
      expect(application.ownerId).toBe(ownerId);
      expect(application.createdById).toBe(adminId);
      expect(application.onBehalf).toBe(true);
      expect(application.applicationYear).toBe(2101);

      // DB 層（非僅 DTO）確認 owner/creator 分離。
      const row = await prisma.application.findUniqueOrThrow({
        where: { id: application.id },
        include: { depreciation: true },
      });
      expect(row.ownerId).toBe(ownerId);
      expect(row.createdById).toBe(adminId);
      expect(row.ownerId).not.toBe(row.createdById);
      expect(row.depreciation?.applicationYear).toBe(2101);

      const log = await prisma.auditLog.findFirst({
        where: { action: "APPLICATION_CREATED_ON_BEHALF", targetId: ownerId, actorId: adminId },
        orderBy: { createdAt: "desc" },
      });
      expect(log).not.toBeNull();
      expect(log?.actorId).toBe(adminId);
      expect(log?.targetId).toBe(ownerId);
      expect(log?.actorId).not.toBe(log?.targetId);
      expect(log?.targetLabel).toBe(`${OWNER_LOGIN}#${application.id}`);

      // 恰 1 列——防止重試／重放路徑對同一次代建立重複寫入稽核
      // （targetLabel 帶 applicationId，本次執行唯一；沿 006 AR-1）。
      const auditRowCount = await prisma.auditLog.count({
        where: { targetLabel: `${OWNER_LOGIN}#${application.id}` },
      });
      expect(auditRowCount).toBe(1);

      const summary = log?.summary as Record<string, unknown>;
      expect(summary.applicationId).toBe(application.id);
      expect(summary.type).toBe("DEPRECIATION");
      expect(summary.applicationYear).toBe(2101);

      assertNoSensitiveContent(log?.targetLabel, "auditLog.targetLabel");
      assertNoSensitiveContent(log?.summary, "auditLog.summary");
    });

    it("body 全選填：`{}` → 201，applicationYear 為 null，summary.applicationYear 亦為 null", async () => {
      const resp = await onBehalfCreate(adminCookie, ownerId, {});
      expect(resp.statusCode).toBe(201);
      const application = resp.json<{ application: DepreciationApplicationJson }>().application;
      trackApp(application.id);

      expect(application.applicationYear).toBeNull();
      expect(application.ownerId).toBe(ownerId);
      expect(application.createdById).toBe(adminId);

      const log = await prisma.auditLog.findFirst({
        where: { targetLabel: `${OWNER_LOGIN}#${application.id}` },
      });
      expect(log).not.toBeNull();
      expect((log?.summary as Record<string, unknown>).applicationYear).toBeNull();
    });

    it("`applicationYear: null` 顯式傳入 → 201（不因 null 而拒絕）", async () => {
      const resp = await onBehalfCreate(adminCookie, ownerId, { applicationYear: null });
      expect(resp.statusCode).toBe(201);
      const application = resp.json<{ application: DepreciationApplicationJson }>().application;
      trackApp(application.id);
      expect(application.applicationYear).toBeNull();
    });
  });

  // ===========================================================================
  // FW-4／FW-6／FW-9（T4/T6/T8 即審移交）— 年度驗證必須沿用
  // `parseApplicationYearField`，不得於 admin 端點自建解析
  // ===========================================================================

  describe("FW（安全地雷）— 年度值域驗證沿用 parseApplicationYearField，不得自建解析", () => {
    it("applicationYear=50 → 400 VALIDATION_ERROR（若端點自建 Date.UTC 解析會靜默映射為 1950 並 201）", async () => {
      const before = await countScoped();
      const resp = await onBehalfCreate(adminCookie, ownerId, { applicationYear: 50 });
      expect(resp.statusCode).toBe(400);
      const err = resp.json<ErrorJson>();
      expect(err.error.code).toBe("VALIDATION_ERROR");
      expect(err.error.fields?.[0]?.field).toBe("applicationYear");

      const after = await countScoped();
      expect(after.applications).toBe(before.applications);
      expect(after.audits).toBe(before.audits);
    });

    it.each([
      ["下界外 1899", 1899],
      ["上界外 3000", 3000],
      ["非整數 2101.5", 2101.5],
      ["NaN 之替身 0", 0],
    ])("applicationYear 非法（%s）→ 400 VALIDATION_ERROR 且零寫入", async (_label, value) => {
      const before = await countScoped();
      const resp = await onBehalfCreate(adminCookie, ownerId, { applicationYear: value });
      expect(resp.statusCode).toBe(400);
      expect(resp.json<ErrorJson>().error.code).toBe("VALIDATION_ERROR");
      const after = await countScoped();
      expect(after.applications).toBe(before.applications);
      expect(after.audits).toBe(before.audits);
    });

    it('applicationYear 為字串 "2101" → 400（型別層守門，不得寬鬆轉型）', async () => {
      const resp = await onBehalfCreate(adminCookie, ownerId, { applicationYear: "2101" });
      expect(resp.statusCode).toBe(400);
      expect(resp.json<ErrorJson>().error.fields?.[0]?.field).toBe("applicationYear");
    });

    it.each([
      ["下界 1900", 1900, "1900-12-31"],
      ["1950（0-99 映射之對照組：50 被擋、1950 通過）", 1950, "1950-12-31"],
      ["上界 2999", 2999, "2999-12-31"],
    ])(
      "applicationYear 合法邊界（%s）→ 201 且 primaryDate 為該年 12-31",
      async (_label, value, expectedPrimaryDate) => {
        const resp = await onBehalfCreate(adminCookie, ownerId, { applicationYear: value });
        expect(resp.statusCode).toBe(201);
        const application = resp.json<{ application: DepreciationApplicationJson }>().application;
        trackApp(application.id);
        expect(application.applicationYear).toBe(value);
        expect(application.primaryDate).toBe(expectedPrimaryDate);
      }
    );
  });

  // ===========================================================================
  // AC-34 — :userId 不存在 → 404；:userId 停用 → 400（006 §18 SF-4 裁定 (a)）
  // ===========================================================================

  describe("AC-34／B-27 — :userId 不存在 → 404，不得建立任何列", () => {
    it("代建立指向不存在之 userId → 404，Application/AuditLog 皆零新增", async () => {
      const before = await countScoped();
      const resp = await onBehalfCreate(adminCookie, "00000000-0000-4000-8000-000000000000", {
        applicationYear: 2102,
      });
      expect(resp.statusCode).toBe(404);
      expect(resp.json<ErrorJson>().error.code).toBe("NOT_FOUND");
      const after = await countScoped();
      expect(after.applications).toBe(before.applications);
      expect(after.audits).toBe(before.audits);
    });
  });

  describe("AC-34／B-26（006 §18 SF-4 裁定 (a)）— :userId 已停用 → 400 VALIDATION_ERROR", () => {
    it("代建立指向已停用之 userId → 400，訊息與差旅／保養代建立端點逐字相同，且零寫入", async () => {
      const before = await countScoped();
      const resp = await onBehalfCreate(adminCookie, inactiveId, { applicationYear: 2103 });
      expect(resp.statusCode).toBe(400);
      const err = resp.json<ErrorJson>();
      expect(err.error.code).toBe("VALIDATION_ERROR");
      expect(err.error.message).toBe("指定的使用者已停用，無法代其建立申請");
      expect(err.error.fields).toEqual([{ field: "userId", reason: "指定的使用者已停用" }]);

      const after = await countScoped();
      expect(after.applications).toBe(before.applications);
      expect(after.audits).toBe(before.audits);
    });

    it("啟用者代建立仍 201（正例不誤殺）", async () => {
      const resp = await onBehalfCreate(adminCookie, ownerId, { applicationYear: 2104 });
      expect(resp.statusCode).toBe(201);
      trackApp(resp.json<{ application: DepreciationApplicationJson }>().application.id);
    });

    it("停用判定先於欄位格式驗證：停用 userId ＋ 非法 applicationYear → 仍為停用之 400（userId 欄）", async () => {
      const resp = await onBehalfCreate(adminCookie, inactiveId, { applicationYear: "bogus" });
      expect(resp.statusCode).toBe(400);
      expect(resp.json<ErrorJson>().error.fields).toEqual([
        { field: "userId", reason: "指定的使用者已停用" },
      ]);
    });
  });

  // ===========================================================================
  // C3 邊界 — 管理員代自己建立＝自己操作，不寫稽核（沿 PHASE-004 AC-86）
  // ===========================================================================

  describe("C3 邊界 — 管理員代自己建立（:userId＝自己）不算代操作", () => {
    it("→ 201，onBehalf=false，且不寫 APPLICATION_CREATED_ON_BEHALF", async () => {
      const resp = await onBehalfCreate(adminCookie, adminId, { applicationYear: 2105 });
      expect(resp.statusCode).toBe(201);
      const application = resp.json<{ application: DepreciationApplicationJson }>().application;
      trackApp(application.id);

      expect(application.ownerId).toBe(adminId);
      expect(application.createdById).toBe(adminId);
      expect(application.onBehalf).toBe(false);

      const log = await prisma.auditLog.findFirst({
        where: { targetLabel: `${ADMIN_LOGIN}#${application.id}` },
      });
      expect(log).toBeNull();
    });
  });

  // ===========================================================================
  // AC-35 — 代修改稽核（PHASE-007-T11b）＋ 本人自改不寫稽核 ＋ 已完成 403
  // ===========================================================================

  describe("AC-35 代修改 — 管理員 PUT 他人草稿 → 200 且寫 APPLICATION_UPDATED_ON_BEHALF", () => {
    it("PUT /applications/depreciation/:id（admin 對 U 之草稿）→ 200，AuditLog action/actorId/targetId/targetLabel/summary（含前後值）精確", async () => {
      const id = await createOwnDraft(ownerCookie, { applicationYear: 2120 });

      const resp = await putDepreciation(adminCookie, id, { applicationYear: 2121 });
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: DepreciationApplicationJson }>().application;
      expect(application.applicationYear).toBe(2121);
      // 代修改**不**改變擁有人／建立者（僅稽核留下操作者）。
      expect(application.ownerId).toBe(ownerId);
      expect(application.createdById).toBe(ownerId);

      const log = await prisma.auditLog.findFirst({
        where: { action: "APPLICATION_UPDATED_ON_BEHALF", targetLabel: { contains: id } },
        orderBy: { createdAt: "desc" },
      });
      expect(log).not.toBeNull();
      expect(log?.action).toBe("APPLICATION_UPDATED_ON_BEHALF");
      expect(log?.actorId).toBe(adminId);
      expect(log?.targetId).toBe(ownerId);
      expect(log?.actorId).not.toBe(log?.targetId);
      expect(log?.targetLabel).toBe(`${OWNER_LOGIN}#${id}`);

      // 恰 1 列——`updateDepreciationDraft` 為 SERIALIZABLE ＋ 可重試迴圈，
      // hook 必須落在「成功提交的那一次嘗試」內，重試不得累積多列稽核。
      const auditRowCount = await prisma.auditLog.count({
        where: { action: "APPLICATION_UPDATED_ON_BEHALF", targetLabel: `${OWNER_LOGIN}#${id}` },
      });
      expect(auditRowCount).toBe(1);

      const summary = log?.summary as Record<string, unknown>;
      expect(summary.applicationId).toBe(id);
      expect(summary.type).toBe("DEPRECIATION");
      expect(summary.applicationYear).toEqual({ before: 2120, after: 2121 });

      assertNoSensitiveContent(log?.targetLabel, "auditLog.targetLabel");
      assertNoSensitiveContent(log?.summary, "auditLog.summary");
    });

    it("前後值忠實反映兩個方向：null → 值、值 → null", async () => {
      const id = await createOwnDraft(ownerCookie, {});

      const first = await putDepreciation(adminCookie, id, { applicationYear: 2122 });
      expect(first.statusCode).toBe(200);
      const second = await putDepreciation(adminCookie, id, { applicationYear: null });
      expect(second.statusCode).toBe(200);

      const logs = await prisma.auditLog.findMany({
        where: { action: "APPLICATION_UPDATED_ON_BEHALF", targetLabel: `${OWNER_LOGIN}#${id}` },
        orderBy: { createdAt: "asc" },
      });
      expect(logs.length).toBe(2);
      expect((logs[0].summary as Record<string, unknown>).applicationYear).toEqual({
        before: null,
        after: 2122,
      });
      expect((logs[1].summary as Record<string, unknown>).applicationYear).toEqual({
        before: 2122,
        after: null,
      });
    });

    it("鑑別力：同一草稿先由 admin 代改（+1 列）、再由擁有人自改（不再 +1）", async () => {
      const id = await createOwnDraft(ownerCookie, { applicationYear: 2123 });

      expect((await putDepreciation(adminCookie, id, { applicationYear: 2124 })).statusCode).toBe(
        200
      );
      const afterOnBehalf = await prisma.auditLog.count({
        where: { targetLabel: `${OWNER_LOGIN}#${id}` },
      });
      expect(afterOnBehalf).toBe(1);

      expect((await putDepreciation(ownerCookie, id, { applicationYear: 2125 })).statusCode).toBe(
        200
      );
      const afterSelfEdit = await prisma.auditLog.count({
        where: { targetLabel: `${OWNER_LOGIN}#${id}` },
      });
      expect(afterSelfEdit).toBe(1);
    });
  });

  describe("AC-35 — 本人自建／自改不寫稽核（沿 PHASE-004 AC-86）", () => {
    it("擁有人自建折舊草稿 → 不產生任何 ON_BEHALF 稽核列", async () => {
      const id = await createOwnDraft(ownerCookie, { applicationYear: 2106 });
      const logs = await prisma.auditLog.count({
        where: {
          action: { in: ["APPLICATION_CREATED_ON_BEHALF", "APPLICATION_UPDATED_ON_BEHALF"] },
          targetLabel: { contains: id },
        },
      });
      expect(logs).toBe(0);
    });

    it("擁有人自己 PUT 自己的草稿 → 200，且不產生任何 ON_BEHALF 稽核列", async () => {
      const id = await createOwnDraft(ownerCookie, { applicationYear: 2107 });
      const resp = await putDepreciation(ownerCookie, id, { applicationYear: 2108 });
      expect(resp.statusCode).toBe(200);
      expect(
        resp.json<{ application: DepreciationApplicationJson }>().application.applicationYear
      ).toBe(2108);

      const logs = await prisma.auditLog.count({
        where: {
          action: { in: ["APPLICATION_CREATED_ON_BEHALF", "APPLICATION_UPDATED_ON_BEHALF"] },
          targetLabel: { contains: id },
        },
      });
      expect(logs).toBe(0);
    });
  });

  describe("AC-35 — 管理員修改已完成之折舊申請 → 403（AD-US-08 第 3 條）", () => {
    it("admin PUT 於 COMPLETED 折舊申請 → 403 FORBIDDEN，欄位未變且無稽核列", async () => {
      const id = await createOwnDraft(ownerCookie, { applicationYear: 2109 });
      // 本斷言只針對「狀態機守門先於任何寫入」，不涉快照語意——故以 Prisma
      // 直接推進狀態（完成流程之真實 fixture 由
      // `phase7-depreciation-complete.test.ts` 涵蓋）。
      await prisma.application.update({ where: { id }, data: { status: "COMPLETED" } });

      const resp = await putDepreciation(adminCookie, id, { applicationYear: 2110 });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<ErrorJson>().error.code).toBe("FORBIDDEN");

      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      expect(row.applicationYear).toBe(2109);

      const logs = await prisma.auditLog.count({ where: { targetLabel: { contains: id } } });
      expect(logs).toBe(0);
    });
  });

  // ===========================================================================
  // 授權矩陣（§6.1 第 7 列）— 一般使用者 403／未登入 401／PCR 403
  // ===========================================================================

  describe("授權矩陣 — 非管理員／未登入／待改密", () => {
    it("非管理員（一般使用者）打代建立端點 → 403", async () => {
      const resp = await onBehalfCreate(otherCookie, ownerId, { applicationYear: 2111 });
      expect(resp.statusCode).toBe(403);
    });

    it("未登入打代建立端點 → 401", async () => {
      const resp = await onBehalfCreate(undefined, ownerId, { applicationYear: 2111 });
      expect(resp.statusCode).toBe(401);
    });

    it("已登入但待改密（PCR）之管理員打代建立端點 → 403", async () => {
      const resp = await onBehalfCreate(mcpCookie, ownerId, { applicationYear: 2111 });
      expect(resp.statusCode).toBe(403);
    });

    it("判定順序：授權（403）先於欄位格式驗證（400）——非管理員帶非法 body 仍為 403", async () => {
      const before = await countScoped();
      const resp = await onBehalfCreate(otherCookie, ownerId, { applicationYear: "bogus" });
      expect(resp.statusCode).toBe(403);
      const after = await countScoped();
      expect(after.applications).toBe(before.applications);
      expect(after.audits).toBe(before.audits);
    });

    it("判定順序：授權（403）先於目標使用者存在性（404）——非管理員帶不存在 userId 仍為 403", async () => {
      const resp = await onBehalfCreate(otherCookie, "00000000-0000-4000-8000-000000000000", {});
      expect(resp.statusCode).toBe(403);
    });
  });

  // ===========================================================================
  // 頂層純量夾帶（006 T8 MF-1 教訓）— body 之識別／金額／狀態欄位一律不採用
  // ===========================================================================

  describe("頂層純量夾帶 — ownerId／createdById／status／totalAmount／type 一律忽略", () => {
    it("代建立 body 夾帶上述頂層純量 → 201 且 DB 值與未夾帶之對照組一致", async () => {
      const resp = await onBehalfCreate(adminCookie, ownerId, {
        applicationYear: 2112,
        ownerId: otherId,
        createdById: otherId,
        status: "COMPLETED",
        totalAmount: 999999,
        type: "TRAVEL",
        onBehalf: false,
        primaryDate: "1999-01-01",
      });
      expect(resp.statusCode).toBe(201);
      const application = resp.json<{ application: DepreciationApplicationJson }>().application;
      trackApp(application.id);

      const row = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
      expect(row.ownerId).toBe(ownerId);
      expect(row.createdById).toBe(adminId);
      expect(row.status).toBe("DRAFT");
      expect(row.type).toBe("DEPRECIATION");
      expect(row.totalAmount).toBeNull();
      expect(row.primaryDate.toISOString().slice(0, 10)).toBe("2112-12-31");
    });
  });

  // ===========================================================================
  // 同交易回滾（真交易，非 stub）— Packet Done When 之硬性要求
  // ===========================================================================

  describe("同交易回滾 — 稽核寫入失敗 → 主體變更真實 rollback（非 stub）", () => {
    it("createDepreciationDraft: onCreated 注入失敗 → 交易整體 rollback，DB 查無該申請與 sentinel 稽核列", async () => {
      const sentinelYear = 2201;
      const injectedMessage = `P7T11-INJECTED-CREATE-AUDIT-FAILURE-${RUN_ID}`;
      // hook 若拿到「交易外」的 client（`onCreated(prisma, …)` mutant），用它
      // 寫入的 sentinel AuditLog 會在主體 insert rollback 後仍然殘留——藉此
      // 釘死 hook 必須收到同一筆交易的 `tx`（沿 006 T9 SF-1／M4b）。
      const sentinelTargetLabel = `P7T11-SENTINEL-CREATE#${RUN_ID}`;

      await expect(
        createDepreciationDraft(
          prisma,
          { ownerId, createdById: adminId, applicationYear: sentinelYear },
          async (txClient) => {
            await txClient.auditLog.create({
              data: {
                action: "APPLICATION_CREATED_ON_BEHALF",
                actorId: adminId,
                targetId: ownerId,
                targetLabel: sentinelTargetLabel,
              },
            });
            throw new Error(injectedMessage);
          }
        )
      ).rejects.toThrow(injectedMessage);

      const stray = await prisma.depreciationApplication.findFirst({
        where: { applicationYear: sentinelYear, application: { ownerId } },
      });
      expect(stray).toBeNull();

      const strayAudit = await prisma.auditLog.findFirst({
        where: { targetLabel: sentinelTargetLabel },
      });
      expect(strayAudit).toBeNull();
    });

    it("updateDepreciationDraft: onUpdated 注入失敗 → 交易整體 rollback，applicationYear 仍為修改前的值", async () => {
      const id = await createOwnDraft(ownerCookie, { applicationYear: 2113 });
      const injectedMessage = `P7T11-INJECTED-UPDATE-AUDIT-FAILURE-${RUN_ID}`;
      const sentinelTargetLabel = `P7T11-SENTINEL-UPDATE#${RUN_ID}`;

      await expect(
        updateDepreciationDraft(
          prisma,
          id,
          { applicationYear: 2114 },
          async (txClient, context) => {
            // context 攜帶之 before 快照必須為交易內新鮮讀取之修改前值。
            expect(context.ownerId).toBe(ownerId);
            expect(context.ownerLoginName).toBe(OWNER_LOGIN);
            expect(context.before.applicationYear).toBe(2113);
            await txClient.auditLog.create({
              data: {
                action: "APPLICATION_UPDATED_ON_BEHALF",
                actorId: adminId,
                targetId: ownerId,
                targetLabel: sentinelTargetLabel,
              },
            });
            throw new Error(injectedMessage);
          }
        )
      ).rejects.toThrow(injectedMessage);

      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      expect(row.applicationYear).toBe(2113);

      const strayAudit = await prisma.auditLog.findFirst({
        where: { targetLabel: sentinelTargetLabel },
      });
      expect(strayAudit).toBeNull();
    });
  });

  // ===========================================================================
  // §16 D9(a)／AC-29 — 無代完成路徑（負向 ＋ 結構性掃描）
  // ===========================================================================

  describe("§16 D9(a) — 管理員代操作端點不提供代完成路徑", () => {
    it("admin 對他人草稿呼叫 POST /applications/:id/complete → 403（僅本人可完成），草稿仍為 DRAFT", async () => {
      const id = await createOwnDraft(ownerCookie, { applicationYear: 2115 });
      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/complete`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(403);
      const row = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("DRAFT");
    });

    it.each([
      "/admin/users/:userId/applications/depreciation/:id/complete",
      "/admin/applications/:id/complete",
      "/admin/users/:userId/applications/:id/complete",
    ])("代完成候選路徑 %s → 404（路徑不存在）", async (template) => {
      const id = await createOwnDraft(ownerCookie, { applicationYear: 2116 });
      const url = template.replace(":userId", ownerId).replace(":id", id);
      const resp = await app.inject({
        method: "POST",
        url,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(404);
      const row = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("DRAFT");
    });

    it("結構性掃描：admin/routes.ts 之路由註冊字串不得出現 complete 動詞", () => {
      const adminRoutesPath = fileURLToPath(new URL("../../src/admin/routes.ts", import.meta.url));
      const source = readFileSync(adminRoutesPath, "utf8");
      // 逐行取出路由註冊之路徑字面量（fastify.get/post/put/delete("…")），
      // 對整份原始碼掃描會被中文註解裡的說明字誤傷，故只掃路徑本身。
      const routePaths = [...source.matchAll(/fastify\.(get|post|put|delete)\(\s*"([^"]+)"/g)].map(
        (m) => m[2]
      );
      expect(routePaths.length).toBeGreaterThan(0);
      for (const path of routePaths) {
        expect(
          path,
          `admin route "${path}" 含 complete 動詞（§16 D9(a) 禁止代完成路徑）`
        ).not.toMatch(/complete/i);
      }
    });
  });

  // ===========================================================================
  // SF-1（T11 即審）— 路由層稽核 hook 必須用交易 client `tx`，不得用外層
  // `prisma`（結構性掃描）
  // ===========================================================================

  describe("SF-1 — 兩個路由層稽核 hook 皆以 tx.auditLog.create 寫入（結構性掃描）", () => {
    // ─────────────────────────────────────────────────────────────────────
    // 證據性質之誠實聲明（勿高估本段強度）：
    //
    // 這是**結構性（原始碼字面）證據，不是行為性證據**。「同交易回滾」段之
    // sentinel 測試（直呼 service 並注入失敗）能真正殺死 service 層的
    // `onCreated(prisma, …)`／`onUpdated(prisma, …)` mutant，因為那裡的 hook
    // 由測試自己提供；但**路由層 hook 主體**內把 `tx.auditLog.create` 改成
    // `prisma.auditLog.create`（reviewer M4／M4b）在全套 2256 條下零紅存活——
    // 該 mutant 只在「業務寫入於 hook 之後失敗並回滾」時才有可觀測差異，而
    // 路由層 hook 是交易內最後一步、其後無失敗點，故行為上不可達。
    //
    // runtime 觀測（spy `prisma.auditLog.create`）亦不可行：`buildServer` 內部
    // 自建 PrismaClient，測試持有的 client 與其非同一實例，delegate spy 恆零
    // 觀測（PHASE-007-T10 W-1 已就同一限制作成裁定並實證）。
    //
    // 因此本段以原始碼掃描補上這道縫：改壞即紅（M4 重放已實證），代價是它綁在
    // 字面寫法上——重構 hook 寫法時請一併更新本段，而非刪除它。
    // ─────────────────────────────────────────────────────────────────────

    /** 擷取指定 src 檔中，折舊代操作 hook 之整段賦值（`const onX: OnDepreciation… ? … : undefined;`）。 */
    function extractDepreciationHookBlock(
      relativePath: string,
      declaration: string
    ): { source: string; block: string } {
      const absolutePath = fileURLToPath(new URL(relativePath, import.meta.url));
      const source = readFileSync(absolutePath, "utf8");
      const pattern = new RegExp(`${declaration}[\\s\\S]*?\\n\\s*: undefined;`);
      const match = source.match(pattern);
      // 防恆真：擷取失敗（重構改名／改寫法）必須讓本段紅燈，不得靜默略過而
      // 使下方 `not.toMatch` 對空字串恆真。
      expect(
        match,
        `無法於 ${relativePath} 擷取 hook 區塊（宣告樣式 "${declaration}" 已變更？請更新本掃描而非刪除）`
      ).not.toBeNull();
      const block = match?.[0] ?? "";
      expect(block.length).toBeGreaterThan(0);
      return { source, block };
    }

    it("admin/routes.ts 之 onCreated（AC-34）區塊：出現 tx.auditLog.create、不出現 prisma.auditLog.create", () => {
      const { block } = extractDepreciationHookBlock(
        "../../src/admin/routes.ts",
        "const onCreated: OnDepreciationDraftCreated"
      );

      expect(block).toContain("tx.auditLog.create");
      expect(
        block,
        "AC-34 稽核 hook 以交易外 prisma 寫入 → 主體回滾時將殘留孤兒稽核列"
      ).not.toMatch(/prisma\.auditLog\.create/);
      // hook 內只應有這一處寫入，避免日後夾帶第二個（可能用錯 client 的）寫入點。
      expect(block.match(/auditLog\.create/g)?.length).toBe(1);
    });

    it("applications/routes.ts 之 onUpdated（AC-35）區塊：出現 tx.auditLog.create、不出現 prisma.auditLog.create", () => {
      const { block } = extractDepreciationHookBlock(
        "../../src/applications/routes.ts",
        "const onUpdated: OnDepreciationDraftUpdated"
      );

      expect(block).toContain("tx.auditLog.create");
      expect(
        block,
        "AC-35 稽核 hook 以交易外 prisma 寫入 → 主體回滾時將殘留孤兒稽核列"
      ).not.toMatch(/prisma\.auditLog\.create/);
      expect(block.match(/auditLog\.create/g)?.length).toBe(1);
    });
  });

  // ===========================================================================
  // Mutant 鑑別力 — targetLabel 格式精確
  // ===========================================================================

  describe("Mutant 鑑別力 — targetLabel 恰為 `loginName#applicationId`", () => {
    it("非 `applicationId#loginName`、非其他分隔字元，且恰含一個 `#`", async () => {
      const resp = await onBehalfCreate(adminCookie, ownerId, { applicationYear: 2117 });
      expect(resp.statusCode).toBe(201);
      const application = resp.json<{ application: DepreciationApplicationJson }>().application;
      trackApp(application.id);

      const log = await prisma.auditLog.findFirst({
        where: { targetLabel: { contains: application.id } },
      });
      expect(log?.targetLabel).toBe(`${OWNER_LOGIN}#${application.id}`);
      expect(log?.targetLabel).not.toBe(`${application.id}#${OWNER_LOGIN}`);
      expect(log?.targetLabel?.split("#").length).toBe(2);
      expect(log?.targetLabel?.startsWith(OWNER_LOGIN)).toBe(true);
    });
  });
});
