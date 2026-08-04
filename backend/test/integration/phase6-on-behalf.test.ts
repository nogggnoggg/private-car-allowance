/**
 * Integration tests for PHASE-006-T9 — 代操作（代建立／代修改）＋ 稽核
 * （AC-30/31）。
 *
 * Covers Spec §2 群組 K：
 *   AC-30: 管理員 A 代建立（`POST /admin/users/:userId/applications/maintenance`）
 *     或代修改（`PUT /applications/maintenance/:id`）使用者 U 之保養草稿 →
 *     `ownerId=U`、`createdById=A`；寫入 `AuditLog`（
 *     `action=APPLICATION_CREATED_ON_BEHALF`／`APPLICATION_UPDATED_ON_BEHALF`，
 *     `actorId=A`、`targetId=U`、`targetLabel=U.loginName#applicationId`，
 *     `summary` 為重要欄位前後摘要且不含密碼／token）；稽核與業務同一交易
 *     （失敗一併回滾）；`userId` 不存在 → 404，不得建立任何列。
 *   AC-31: U 之保養申請已完成時，管理員 A 嘗試 PUT → 403 FORBIDDEN，訊息含
 *     「請建立修正版」，DB 零寫入。
 *
 * TDD: written BEFORE `POST /admin/users/:userId/applications/maintenance`
 * existed and BEFORE `createMaintenanceDraft`/`updateMaintenanceDraft` accepted
 * `onCreated`/`onUpdated` hooks — first run RED（見 Task Handoff 之 RED 輸出）。
 *
 * 沿用既有先例：`phase4-on-behalf-audit.test.ts`（同型 AC-82/83/86 覆蓋、
 * 直接呼叫 service 函式注入失敗以證明原子性回滾）、
 * `phase6-maintenance-complete.test.ts`（`buildCompletableDraft` 建立可完成
 * 草稿之附件/欄位 fixture）、`phase6-snapshot-immutability.test.ts`
 * （`buildInjectedForbiddenFields`-style 頂層純量夾帶矩陣，T8R MF-1 教訓：
 * 夾帶值必須為頂層純量，巢狀物件對 `not.toBe` 恆真、碰不到「後端直接讀
 * body 並寫入 DB」這種最自然的持久化 mutant）。
 *
 * Test discipline (Spec §11.0 / Packet):
 *   - loginName prefix "p6t9_" + per-run random suffix。
 *   - cleanup 僅限本次 RUN_ID 範圍內追蹤之 application/attachment id +
 *     loginName prefix + AuditLog（`targetLabel: { contains: RUN_ID }`）；
 *     嚴禁全域 deleteMany({})。
 *   - synthetic data only。
 */
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMaintenanceDraft,
  updateMaintenanceDraft,
} from "../../src/applications/maintenance-service.js";
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
const LOGIN_PREFIX = "p6t9_";
const PASSWORD = "P6T9OnBehalfTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const MCP_LOGIN = `${LOGIN_PREFIX}mcp_${RUN_ID}`;

interface ErrorJson {
  error: { code: string; message: string };
}
interface MaintenanceApplicationJson {
  id: string;
  status: string;
  ownerId: string;
  createdById: string;
  onBehalf: boolean;
  lastMaintenanceDate: string | null;
  currentMaintenanceDate: string | null;
  lastOdometerKm: string | null;
  currentOdometerKm: string | null;
  actualCost: string | null;
}

// ---------------------------------------------------------------------------
// 逐鍵斷言：遞迴走訪任意 JSON 值的所有 key/value，逐一斷言不含敏感內容
// （同 phase4-on-behalf-audit.test.ts 既有慣例，非只用一次 stringify+regex）。
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

describeWithDb("PHASE-006-T9 — 代操作（代建立／代修改）＋ 稽核（AC-30/31）", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let adminId: string;
  let otherId: string;
  let mcpId: string;

  let ownerCookie: string;
  let adminCookie: string;
  let otherCookie: string;
  let mcpCookie: string;

  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  function trackApp(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }
  function trackAttachment(id: string): string {
    createdAttachmentIds.push(id);
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
        displayName: "P6T9 一般使用者（代操作目標）",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "P6T9 管理員",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const other = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "P6T9 非管理員（授權矩陣負向）",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const mcp = await prisma.user.create({
      data: {
        loginName: MCP_LOGIN,
        displayName: "P6T9 待改密管理員（PCR 403）",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: true,
      },
    });

    ownerId = owner.id;
    adminId = admin.id;
    otherId = other.id;
    mcpId = mcp.id;

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
      if (createdAttachmentIds.length > 0) {
        await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
      }
      if (createdApplicationIds.length > 0) {
        await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
      }
      // AuditLog cleanup: targetLabel is `${ownerLoginName}#${applicationId}` —
      // ownerLoginName 恆含本次 RUN_ID，故 `contains: RUN_ID` 精準限定本次執行
      // 寫入的列（Packet C4：嚴禁全域 deleteMany({})）。
      await prisma.auditLog.deleteMany({ where: { targetLabel: { contains: RUN_ID } } });
      const userIds = [ownerId, adminId, otherId, mcpId].filter(Boolean);
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
    cookie: string,
    userId: string,
    payload: Record<string, unknown> = {}
  ) {
    return app.inject({
      method: "POST",
      url: `/admin/users/${userId}/applications/maintenance`,
      headers: { cookie },
      payload,
    });
  }

  async function createOwnDraft(cookie: string, payload: Record<string, unknown> = {}) {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/maintenance",
      headers: { cookie },
      payload,
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ application: MaintenanceApplicationJson }>();
    trackApp(body.application.id);
    return body.application.id;
  }

  async function putFields(cookie: string, id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/applications/maintenance/${id}`,
      headers: { cookie },
      payload,
    });
  }

  async function completeHttp(cookie: string, id: string) {
    return app.inject({
      method: "POST",
      url: `/applications/${id}/complete`,
      headers: { cookie },
    });
  }

  function buildMultipartBody(
    filename: string,
    content: Buffer
  ): { body: Buffer; contentType: string } {
    const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
    const CRLF = "\r\n";
    const header = `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`;
    const footer = `${CRLF}--${boundary}--${CRLF}`;
    return {
      body: Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  function makeJpegBytes(size = 64): Buffer {
    const buf = Buffer.alloc(size, 0xaa);
    buf[0] = 0xff;
    buf[1] = 0xd8;
    buf[2] = 0xff;
    return buf;
  }

  async function uploadTemp(cookie: string, filename: string): Promise<string> {
    const { body, contentType } = buildMultipartBody(filename, makeJpegBytes());
    const resp = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { cookie, "content-type": contentType },
      payload: body,
    });
    expect(resp.statusCode).toBe(201);
    const id = resp.json<{ attachment: { id: string } }>().attachment.id;
    trackAttachment(id);
    return id;
  }

  /** 建立一筆完成度已齊備（可完成）之保養草稿：五欄 + 1 張附件（沿 phase6-maintenance-complete.test.ts 之既有 fixture）。 */
  async function buildCompletableDraft(
    cookie: string,
    fields: {
      lastMaintenanceDate: string;
      currentMaintenanceDate: string;
      lastOdometerKm: string;
      currentOdometerKm: string;
      actualCost: string;
    }
  ): Promise<string> {
    const id = await createOwnDraft(cookie);
    const putResp = await putFields(cookie, id, fields);
    expect(putResp.statusCode).toBe(200);
    const attachmentId = await uploadTemp(cookie, "p6t9-proof.jpg");
    const linkResp = await putFields(cookie, id, { attachmentIds: [attachmentId] });
    expect(linkResp.statusCode).toBe(200);
    return id;
  }

  /** 建立並完成一筆保養申請（owner 為 `ownerCookieForBuild`）。 */
  async function buildCompletedApplication(ownerCookieForBuild: string): Promise<string> {
    const id = await buildCompletableDraft(ownerCookieForBuild, {
      lastMaintenanceDate: "2091-01-01",
      currentMaintenanceDate: "2091-02-01",
      lastOdometerKm: "0.00",
      currentOdometerKm: "10.00",
      actualCost: "100.00",
    });
    const completeResp = await completeHttp(ownerCookieForBuild, id);
    expect(completeResp.statusCode).toBe(200);
    return id;
  }

  // ===========================================================================
  // Required Test #1 — AC-30 代建立
  // ===========================================================================

  describe("AC-30 代建立 — 管理員代建立保養草稿成功 → ownerId/createdById 分離 + 寫入 AuditLog", () => {
    it("POST /admin/users/:userId/applications/maintenance → 201，ownerId=U、createdById=admin，AuditLog action/actorId/targetId/targetLabel/summary 精確", async () => {
      const resp = await onBehalfCreate(adminCookie, ownerId, {
        lastMaintenanceDate: "2091-03-01",
        currentMaintenanceDate: "2091-04-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "50.00",
        actualCost: "300.00",
      });
      expect(resp.statusCode).toBe(201);
      const application = resp.json<{ application: MaintenanceApplicationJson }>().application;
      trackApp(application.id);

      expect(application.ownerId).toBe(ownerId);
      expect(application.createdById).toBe(adminId);
      expect(application.onBehalf).toBe(true);

      const log = await prisma.auditLog.findFirst({
        where: { action: "APPLICATION_CREATED_ON_BEHALF", targetId: ownerId, actorId: adminId },
        orderBy: { createdAt: "desc" },
      });
      expect(log).not.toBeNull();
      expect(log?.actorId).toBe(adminId);
      expect(log?.targetId).toBe(ownerId);
      expect(log?.actorId).not.toBe(log?.targetId);
      expect(log?.targetLabel).toBe(`${OWNER_LOGIN}#${application.id}`);

      // AR-1：以 count（非僅 findFirst）確認恰好 1 列——防止重試/重放路徑
      // 對同一次代建立重複寫入稽核列（targetLabel 帶 applicationId，本次執行
      // 唯一）。
      const auditRowCount = await prisma.auditLog.count({
        where: { targetLabel: `${OWNER_LOGIN}#${application.id}` },
      });
      expect(auditRowCount).toBe(1);

      const summary = log?.summary as Record<string, unknown>;
      expect(summary.applicationId).toBe(application.id);
      expect(summary.type).toBe("MAINTENANCE");
      expect(summary.lastMaintenanceDate).toBe("2091-03-01");
      expect(summary.currentMaintenanceDate).toBe("2091-04-01");
      expect(summary.lastOdometerKm).toBe("0.00");
      expect(summary.currentOdometerKm).toBe("50.00");
      expect(summary.actualCost).toBe("300.00");

      assertNoSensitiveContent(log?.targetLabel, "auditLog.targetLabel");
      assertNoSensitiveContent(log?.summary, "auditLog.summary");
    });
  });

  // ===========================================================================
  // Required Test #2 — AC-30 代修改
  // ===========================================================================

  describe("AC-30 代修改 — 管理員代修改他人草稿成功 → 寫入 AuditLog，summary 含前後摘要", () => {
    it("PUT /applications/maintenance/:id（admin 對 U 之草稿）→ 200，action=APPLICATION_UPDATED_ON_BEHALF，summary 含重要欄位變更前後值", async () => {
      const applicationId = await createOwnDraft(ownerCookie, {});

      const resp = await putFields(adminCookie, applicationId, {
        lastMaintenanceDate: "2091-05-01",
        currentMaintenanceDate: "2091-06-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "20.00",
        actualCost: "150.00",
      });
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: MaintenanceApplicationJson }>().application;
      expect(application.ownerId).toBe(ownerId);
      // 建立者不變（此草稿為擁有人自建，代修改不改寫 createdById）——
      // `onBehalf` 定義為 `createdById !== ownerId`，此處兩者相等，故為 false；
      // 「代修改」的證據落在下方 AuditLog 斷言（actorId=admin、targetId=owner）。
      expect(application.createdById).toBe(ownerId);
      expect(application.onBehalf).toBe(false);

      const log = await prisma.auditLog.findFirst({
        where: {
          action: "APPLICATION_UPDATED_ON_BEHALF",
          targetId: ownerId,
          actorId: adminId,
          targetLabel: `${OWNER_LOGIN}#${applicationId}`,
        },
        orderBy: { createdAt: "desc" },
      });
      expect(log).not.toBeNull();
      expect(log?.actorId).toBe(adminId);
      expect(log?.targetId).toBe(ownerId);

      // AR-1：count===1，防重試/重放對同一次代修改重複寫入稽核列。
      const auditRowCount = await prisma.auditLog.count({
        where: { targetLabel: `${OWNER_LOGIN}#${applicationId}` },
      });
      expect(auditRowCount).toBe(1);

      const summary = log?.summary as {
        applicationId: string;
        type: string;
        lastMaintenanceDate: { before: string | null; after: string | null };
        currentMaintenanceDate: { before: string | null; after: string | null };
        lastOdometerKm: { before: string | null; after: string | null };
        currentOdometerKm: { before: string | null; after: string | null };
        actualCost: { before: string | null; after: string | null };
      };
      expect(summary.applicationId).toBe(applicationId);
      expect(summary.type).toBe("MAINTENANCE");
      expect(summary.lastMaintenanceDate.before).toBeNull();
      expect(summary.lastMaintenanceDate.after).toBe("2091-05-01");
      expect(summary.currentMaintenanceDate.before).toBeNull();
      expect(summary.currentMaintenanceDate.after).toBe("2091-06-01");
      expect(summary.lastOdometerKm.before).toBeNull();
      expect(summary.lastOdometerKm.after).toBe("0.00");
      expect(summary.currentOdometerKm.before).toBeNull();
      expect(summary.currentOdometerKm.after).toBe("20.00");
      expect(summary.actualCost.before).toBeNull();
      expect(summary.actualCost.after).toBe("150.00");

      assertNoSensitiveContent(log?.targetLabel, "auditLog.targetLabel");
      assertNoSensitiveContent(log?.summary, "auditLog.summary");
    });
  });

  // ===========================================================================
  // Required Test #3 — 鑑別力：本人修改自己草稿不寫 ON_BEHALF 稽核
  // ===========================================================================

  describe("鑑別力 — 使用者本人修改自己的草稿不產生 ON_BEHALF 稽核", () => {
    it("擁有人自己 PUT 自己的草稿 → 200，不寫入 APPLICATION_UPDATED_ON_BEHALF", async () => {
      const applicationId = await createOwnDraft(ownerCookie, {});

      const countBefore = await prisma.auditLog.count({
        where: { action: "APPLICATION_UPDATED_ON_BEHALF", targetId: ownerId },
      });

      const resp = await putFields(ownerCookie, applicationId, {
        actualCost: "50.00",
      });
      expect(resp.statusCode).toBe(200);

      const countAfter = await prisma.auditLog.count({
        where: { action: "APPLICATION_UPDATED_ON_BEHALF", targetId: ownerId },
      });
      expect(countAfter).toBe(countBefore);

      const log = await prisma.auditLog.findFirst({
        where: { targetLabel: { contains: applicationId } },
      });
      expect(log).toBeNull();
    });

    it("管理員代自己建立（:userId=自己）→ 201，不算代操作，不寫 APPLICATION_CREATED_ON_BEHALF（C3 邊界）", async () => {
      const countBefore = await prisma.auditLog.count({
        where: { action: "APPLICATION_CREATED_ON_BEHALF", targetId: adminId },
      });

      const resp = await onBehalfCreate(adminCookie, adminId, { actualCost: "10.00" });
      expect(resp.statusCode).toBe(201);
      const application = resp.json<{ application: MaintenanceApplicationJson }>().application;
      trackApp(application.id);

      const countAfter = await prisma.auditLog.count({
        where: { action: "APPLICATION_CREATED_ON_BEHALF", targetId: adminId },
      });
      expect(countAfter).toBe(countBefore);

      const log = await prisma.auditLog.findFirst({
        where: { targetLabel: { contains: application.id } },
      });
      expect(log).toBeNull();
    });
  });

  // ===========================================================================
  // Required Test #4 — userId 不存在 → 404，零列建立
  // ===========================================================================

  describe("AC-30 — :userId 不存在 → 404，不得建立任何列", () => {
    it("代建立指向不存在之 userId → 404，Application/AuditLog 皆零新增", async () => {
      const bogusUserId = "clnonexistentuseridxxxxxxxxxx01";

      const appCountBefore = await prisma.application.count();
      const auditCountBefore = await prisma.auditLog.count();

      const resp = await onBehalfCreate(adminCookie, bogusUserId, { actualCost: "1.00" });
      expect(resp.statusCode).toBe(404);

      const appCountAfter = await prisma.application.count();
      const auditCountAfter = await prisma.auditLog.count();
      expect(appCountAfter).toBe(appCountBefore);
      expect(auditCountAfter).toBe(auditCountBefore);
    });
  });

  // ===========================================================================
  // Required Test #5 — 同交易回滾（真 DB 注入失敗，非 stub）
  // ===========================================================================

  describe("同交易回滾 — 稽核寫入失敗 → 主體變更真實 rollback（非 stub）", () => {
    it("createMaintenanceDraft: onCreated 注入失敗 → 交易整體 rollback，DB 查無該申請", async () => {
      // sentinel 值需為合法 Decimal 字面量——RUN_ID 混雜英數字元不可直接嵌入
      // 小數位，改以其字元碼加總推導出一個穩定但獨特的兩位小數尾碼。
      const runIdDigitSum = RUN_ID.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 100;
      const sentinelCost = new Prisma.Decimal(`999999.${String(runIdDigitSum).padStart(2, "0")}`);
      const injectedMessage = `P6T9-INJECTED-CREATE-AUDIT-FAILURE-${RUN_ID}`;
      // SF-1（T9 即審 mutant M4b：`onCreated(tx, …)` → `onCreated(prisma, …)`
      // 全套存活）：hook 若拿到「交易外」的 client，用它寫入的這列 sentinel
      // AuditLog 會在主體 insert rollback 後仍然殘留——藉此釘死 hook 必須
      // 收到「同一筆交易」的 tx，而非外層 prisma。
      const sentinelTargetLabel = `P6T9-SENTINEL-CREATE#${RUN_ID}`;

      await expect(
        createMaintenanceDraft(
          prisma,
          {
            ownerId,
            createdById: adminId,
            actualCost: sentinelCost,
          },
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

      const stray = await prisma.maintenanceApplication.findFirst({
        where: { actualCost: sentinelCost },
      });
      expect(stray).toBeNull();

      const strayAudit = await prisma.auditLog.findFirst({
        where: { targetLabel: sentinelTargetLabel },
      });
      expect(strayAudit).toBeNull();
    });

    it("updateMaintenanceDraft: onUpdated 注入失敗 → 交易整體 rollback，欄位仍為修改前的值", async () => {
      const applicationId = await createOwnDraft(ownerCookie, { actualCost: "77.00" });
      const before = await prisma.maintenanceApplication.findUniqueOrThrow({
        where: { applicationId },
      });

      const injectedMessage = `P6T9-INJECTED-UPDATE-AUDIT-FAILURE-${RUN_ID}`;
      // SF-1（同型 M4b，`updateMaintenanceDraft` 側）：sentinel 列殘留即代表
      // hook 拿到的是交易外 client。
      const sentinelTargetLabel = `P6T9-SENTINEL-UPDATE#${RUN_ID}`;

      await expect(
        updateMaintenanceDraft(
          prisma,
          applicationId,
          { actualCost: new Prisma.Decimal("999.00") },
          async (txClient) => {
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

      const after = await prisma.maintenanceApplication.findUniqueOrThrow({
        where: { applicationId },
      });
      expect(after.actualCost?.toFixed(2)).toBe(before.actualCost?.toFixed(2));
      expect(after.actualCost?.toFixed(2)).not.toBe("999.00");

      // 未寫入任何對應 AuditLog（同交易回滾涵蓋稽核本身）。
      const log = await prisma.auditLog.findFirst({
        where: { targetLabel: { contains: applicationId } },
      });
      expect(log).toBeNull();

      const strayAudit = await prisma.auditLog.findFirst({
        where: { targetLabel: sentinelTargetLabel },
      });
      expect(strayAudit).toBeNull();
    });
  });

  // ===========================================================================
  // FW-4（T4/T6/T7/T8 即審移交）— 管理員代掛附件：附件 ownerId 須為 U
  // （PROBE-6 既有行為：管理員以自己擁有之附件掛 U 的容器 → 403，`reconcileMaintenanceAttachments`
  // 既有的 `attachment.ownerId !== applicationOwnerId` 檢查——本測試僅在
  // 「代操作」情境下確認該既有語意延續，非重寫該檢查本身）。
  // ===========================================================================

  describe("FW-4 — 管理員代修改草稿時掛自己（而非 U）擁有之附件 → 403，不落地", () => {
    it("admin PUT U 之草稿並帶入 admin 自己的附件 id → 403 FORBIDDEN，草稿附件關聯未變", async () => {
      const applicationId = await createOwnDraft(ownerCookie, {});
      const adminOwnAttachmentId = await uploadTemp(adminCookie, "p6t9-admin-own.jpg");

      const resp = await putFields(adminCookie, applicationId, {
        attachmentIds: [adminOwnAttachmentId],
      });
      expect(resp.statusCode).toBe(403);

      const linked = await prisma.attachment.count({
        where: { refType: "MAINTENANCE", refId: applicationId, status: "LINKED" },
      });
      expect(linked).toBe(0);

      // 附件本身仍為 TEMP（未被誤 link），且仍歸屬管理員自己。
      const att = await prisma.attachment.findUniqueOrThrow({
        where: { id: adminOwnAttachmentId },
      });
      expect(att.status).toBe("TEMP");
      expect(att.ownerId).toBe(adminId);
    });
  });

  // ===========================================================================
  // Required Test #6 — AC-31 管理員不得直接修改已完成之保養申請
  // ===========================================================================

  describe("AC-31 — 管理員 PUT 已完成的保養申請 → 403，DB 零寫入", () => {
    it("admin PUT on a COMPLETED maintenance → 403 FORBIDDEN，訊息含「請建立修正版」，欄位與稽核筆數皆未變", async () => {
      const applicationId = await buildCompletedApplication(ownerCookie);

      const before = await prisma.maintenanceApplication.findUniqueOrThrow({
        where: { applicationId },
      });
      const auditCountBefore = await prisma.auditLog.count({
        where: { action: "APPLICATION_UPDATED_ON_BEHALF", targetId: ownerId },
      });

      const resp = await putFields(adminCookie, applicationId, {
        actualCost: "999999.00",
      });
      expect(resp.statusCode).toBe(403);
      const errorJson = resp.json<ErrorJson>();
      expect(errorJson.error.code).toBe("FORBIDDEN");
      expect(errorJson.error.message).toContain("請建立修正版");

      const after = await prisma.maintenanceApplication.findUniqueOrThrow({
        where: { applicationId },
      });
      expect(after.actualCost?.toFixed(2)).toBe(before.actualCost?.toFixed(2));

      const auditCountAfter = await prisma.auditLog.count({
        where: { action: "APPLICATION_UPDATED_ON_BEHALF", targetId: ownerId },
      });
      expect(auditCountAfter).toBe(auditCountBefore);
    });
  });

  // ===========================================================================
  // Required Test #7 — D7(a) 負向：admin 代操作端點不得完成他人保養
  // ===========================================================================

  describe("D7(a) 負向 — 管理員對 U 之草稿呼叫 complete 端點 → 403（僅本人可完成）", () => {
    it("admin 對 U 已齊備之草稿 POST /applications/:id/complete → 403，草稿仍為 DRAFT", async () => {
      const applicationId = await buildCompletableDraft(ownerCookie, {
        lastMaintenanceDate: "2092-01-01",
        currentMaintenanceDate: "2092-02-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "30.00",
        actualCost: "200.00",
      });

      const resp = await completeHttp(adminCookie, applicationId);
      expect(resp.statusCode).toBe(403);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect(dbApp.status).toBe("DRAFT");
    });
  });

  // ===========================================================================
  // Required Test #8 — 頂層純量夾帶（ownerId/createdById）
  // ===========================================================================

  describe("頂層純量夾帶 — body 夾帶 ownerId/createdById 一律忽略", () => {
    const INJECTION_VALUES: Array<{ label: string; value: unknown }> = [
      { label: "他人 id 字串", value: "some-other-user-id-string" },
      { label: "null", value: null },
      { label: "數字", value: 12345 },
    ];

    it.each(INJECTION_VALUES)(
      "代建立 body 夾帶頂層純量 ownerId/createdById（$label）→ 忽略，ownerId 仍=U、createdById 仍=admin",
      async ({ value }) => {
        const resp = await onBehalfCreate(adminCookie, ownerId, {
          ownerId: value,
          createdById: value,
          actualCost: "88.00",
        });
        expect(resp.statusCode).toBe(201);
        const application = resp.json<{ application: MaintenanceApplicationJson }>().application;
        trackApp(application.id);
        expect(application.ownerId).toBe(ownerId);
        expect(application.createdById).toBe(adminId);
      }
    );

    it.each(INJECTION_VALUES)(
      "代修改 body 夾帶頂層純量 ownerId/createdById（$label）→ 忽略，ownerId/createdById 不變",
      async ({ value }) => {
        const applicationId = await createOwnDraft(ownerCookie, {});
        const resp = await putFields(adminCookie, applicationId, {
          ownerId: value,
          createdById: value,
          actualCost: "66.00",
        });
        expect(resp.statusCode).toBe(200);
        const application = resp.json<{ application: MaintenanceApplicationJson }>().application;
        expect(application.ownerId).toBe(ownerId);
        expect(application.createdById).toBe(ownerId);
      }
    );
  });

  // ===========================================================================
  // Required Test #9 — 授權矩陣
  // ===========================================================================

  describe("授權矩陣 — 非管理員/未登入/待改密", () => {
    it("非管理員（一般使用者）打代建立端點 → 403", async () => {
      const resp = await onBehalfCreate(otherCookie, ownerId, {});
      expect(resp.statusCode).toBe(403);
    });

    it("未登入打代建立端點 → 401", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/admin/users/${ownerId}/applications/maintenance`,
        payload: {},
      });
      expect(resp.statusCode).toBe(401);
    });

    it("已登入但待改密（PCR）之管理員打代建立端點 → 403", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/admin/users/${ownerId}/applications/maintenance`,
        headers: { cookie: mcpCookie },
        payload: {},
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<ErrorJson>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    });
  });

  // ===========================================================================
  // Required Test #10 — mutant 鑑別力：targetLabel 精確格式
  // ===========================================================================

  describe("Mutant 鑑別力 — targetLabel 精確為 `loginName#applicationId`（非其他串接順序/分隔）", () => {
    it("targetLabel 恰為 `${OWNER_LOGIN}#${applicationId}`，非 `applicationId#loginName` 或以其他字元分隔", async () => {
      const resp = await onBehalfCreate(adminCookie, ownerId, { actualCost: "5.00" });
      expect(resp.statusCode).toBe(201);
      const application = resp.json<{ application: MaintenanceApplicationJson }>().application;
      trackApp(application.id);

      const log = await prisma.auditLog.findFirst({
        where: { action: "APPLICATION_CREATED_ON_BEHALF", targetId: ownerId, actorId: adminId },
        orderBy: { createdAt: "desc" },
      });
      expect(log?.targetLabel).toBe(`${OWNER_LOGIN}#${application.id}`);
      // 殺掉「反向串接」或「用其他分隔符」之 mutant：
      expect(log?.targetLabel).not.toBe(`${application.id}#${OWNER_LOGIN}`);
      expect(log?.targetLabel).not.toContain("#undefined");
      expect(log?.targetLabel?.split("#").length).toBe(2);
    });
  });
});
