/**
 * Integration tests for PHASE-004-T12 — 代操作稽核（AC-82/83/86）
 *
 * Covers Spec §2 群組 K：
 *   AC-82: 管理員代建立或代修改草稿成功 → 寫入 AuditLog
 *     （action ∈ {APPLICATION_CREATED_ON_BEHALF, APPLICATION_UPDATED_ON_BEHALF}，
 *     actorId=管理員、targetId=擁有人、targetLabel=擁有人 loginName 快照 +
 *     申請識別、summary=申請 id/類型/重要欄位變更前後摘要）。
 *   AC-83: 稽核與主體同交易（原子性，雙向）——稽核寫入失敗 → 主體 rollback；
 *     操作被拒（403/400/409）→ 不寫任何稽核。
 *   AC-86: 使用者對自己草稿的建立/儲存/刪除 → 不產生 AuditLog（+ C3 邊界：
 *     管理員操作「自己」的申請＝自己操作，非代操作，同樣不寫）。
 *
 * TDD: written to exercise the REAL HTTP routes (`POST
 * /admin/users/:userId/applications/travel`, `PUT /applications/travel/:id`,
 * `DELETE /applications/:id`) registered by buildServer(), PLUS the exported
 * `createTravelDraft`/`updateTravelDraft` service functions called DIRECTLY
 * (only for the AC-83 positive-atomicity tests, which need a controllable
 * failure injection point with no HTTP-level equivalent — same established
 * pattern as `phase3a-parameter-audit.test.ts`'s `onCreated`-throws tests and
 * `phase4-travel-complete.test.ts`'s `__testOnlyFailAfterSnapshotWrite`).
 * First run (before this Task's `AuditAction` enum values / hook wiring
 * existed) was RED — see Task Handoff for the captured first-run RED output.
 *
 * Test discipline (Spec §11.0 / Packet C4):
 *   - loginName prefix "p4t12_" + per-run random suffix（跨檔跨 fork 撞名防護）。
 *   - FuelParameterVersion/EtcParameterVersion `effectiveFrom` 為全域表——本檔
 *     使用尚未被其他 phase4 測試檔占用的年份 2043（既有慣例：T3=2032、
 *     preview=2031、T8=2034~2040、T10=2042、reference-protection=2045~2048）。
 *   - AuditLog 清理限定 targetLabel 含本次 RUN_ID（targetLabel 格式為
 *     `${ownerLoginName}#${applicationId}`，loginName 本身即含 RUN_ID，故
 *     `contains: RUN_ID` 精準限定本檔本次執行寫入的列，不影響其他測試檔或
 *     並行執行的同檔案），嚴禁全域 deleteMany({})。
 *   - synthetic data only（虛構人名、地名、出差目的）。
 */
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTravelDraft, updateTravelDraft } from "../../src/applications/travel-service.js";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Shared helpers (pattern per phase4-admin-on-behalf.test.ts)
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

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p4t12_";
const PASSWORD = "P4T12AuditTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;

const FUEL_DATE = "2043-01-01";

interface ErrorJson {
  error: { code: string; message: string };
}
interface ApplicationJson {
  id: string;
  status: string;
  ownerId: string;
  createdById: string;
  onBehalf: boolean;
  tripDate: string | null;
  purpose: string | null;
  segments: { id: string }[];
}

// ---------------------------------------------------------------------------
// 逐鍵斷言：遞迴走訪任意 JSON 值的所有 key/value，逐一斷言不含敏感內容
// （Packet C2：不是只用一次 JSON.stringify 後的整體 regex，而是逐鍵檢查）。
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

describeWithDb("PHASE-004-T12 — 代操作稽核（AC-82/83/86）", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let adminId: string;
  let ownerCookie: string;
  let adminCookie: string;

  const createdApplicationIds: string[] = [];
  const createdFuelVersionIds: string[] = [];
  const createdEtcVersionIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  function track(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  async function onBehalfCreate(
    cookie: string,
    userId: string,
    payload: Record<string, unknown> = {}
  ) {
    return app.inject({
      method: "POST",
      url: `/admin/users/${userId}/applications/travel`,
      headers: { cookie },
      payload,
    });
  }

  async function createOwnDraft(cookie: string, payload: Record<string, unknown> = {}) {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/travel",
      headers: { cookie },
      payload,
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ application: ApplicationJson }>();
    track(body.application.id);
    return body.application.id;
  }

  async function putDraft(cookie: string, id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/applications/travel/${id}`,
      headers: { cookie },
      payload,
    });
  }

  async function deleteDraft(cookie: string, id: string) {
    return app.inject({
      method: "DELETE",
      url: `/applications/${id}`,
      headers: { cookie },
    });
  }

  async function completeHttp(cookie: string, id: string) {
    return app.inject({
      method: "POST",
      url: `/applications/${id}/complete`,
      headers: { cookie },
    });
  }

  async function createParamVersions(): Promise<void> {
    const fuel = await prisma.fuelParameterVersion.create({
      data: { unitPrice: "5.0000", effectiveFrom: new Date(FUEL_DATE), createdById: ownerId },
    });
    const etc = await prisma.etcParameterVersion.create({
      data: { unitPrice: "2.0000", effectiveFrom: new Date(FUEL_DATE), createdById: ownerId },
    });
    createdFuelVersionIds.push(fuel.id);
    createdEtcVersionIds.push(etc.id);
  }

  async function createLinkedAttachment(segmentId: string, forOwnerId: string) {
    const att = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `p4t12-synthetic-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
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

  /** Build a completed application owned by `forOwnerId`. */
  async function buildCompletedApplication(
    ownerCookieForBuild: string,
    forOwnerId: string
  ): Promise<string> {
    await createParamVersions();
    const applicationId = await createOwnDraft(ownerCookieForBuild, {});
    const putResp = await putDraft(ownerCookieForBuild, applicationId, {
      tripDate: FUEL_DATE,
      purpose: "P4T12 已完成情境（用於 AC-83 反向拒絕測試）",
      segments: [
        {
          origin: "起點",
          destination: "終點",
          totalKm: "10.00",
          highwayKm: "0.00",
          attachmentIds: [],
        },
      ],
    });
    expect(putResp.statusCode).toBe(200);
    const segmentId = putResp.json<{ application: ApplicationJson }>().application.segments[0].id;
    await createLinkedAttachment(segmentId, forOwnerId);

    const completeResp = await completeHttp(ownerCookieForBuild, applicationId);
    expect(completeResp.statusCode).toBe(200);
    return applicationId;
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    const owner = await prisma.user.create({
      data: {
        loginName: OWNER_LOGIN,
        displayName: "P4T12 一般使用者（代操作目標）",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "P4T12 管理員",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    ownerId = owner.id;
    adminId = admin.id;

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    ownerCookie = await loginUser(app, OWNER_LOGIN, PASSWORD);
    adminCookie = await loginUser(app, ADMIN_LOGIN, PASSWORD);
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
      if (createdFuelVersionIds.length > 0) {
        await prisma.fuelParameterVersion.deleteMany({
          where: { id: { in: createdFuelVersionIds } },
        });
      }
      if (createdEtcVersionIds.length > 0) {
        await prisma.etcParameterVersion.deleteMany({
          where: { id: { in: createdEtcVersionIds } },
        });
      }
      // AuditLog cleanup: targetLabel is `${ownerLoginName}#${applicationId}` —
      // ownerLoginName always contains this run's RUN_ID, so `contains: RUN_ID`
      // precisely scopes cleanup to rows THIS run wrote (never global
      // deleteMany({}), Packet C4).
      await prisma.auditLog.deleteMany({ where: { targetLabel: { contains: RUN_ID } } });
      const userIds = [ownerId, adminId].filter(Boolean);
      if (userIds.length > 0) {
        await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      }
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
  });

  // ===========================================================================
  // Required Test #1 — AC-82 代建立
  // ===========================================================================

  describe("AC-82 代建立 — 管理員代建立草稿成功 → 寫入 AuditLog", () => {
    it("action=APPLICATION_CREATED_ON_BEHALF、actorId=管理員、targetId=擁有人、targetLabel 含擁有人 loginName + 申請識別、summary 含申請 id/類型", async () => {
      const resp = await onBehalfCreate(adminCookie, ownerId, {
        tripDate: "2043-02-01",
        purpose: "P4T12 AC-82 代建立",
      });
      expect(resp.statusCode).toBe(201);
      const applicationId = resp.json<{ application: ApplicationJson }>().application.id;
      track(applicationId);

      const log = await prisma.auditLog.findFirst({
        where: { action: "APPLICATION_CREATED_ON_BEHALF", targetId: ownerId, actorId: adminId },
        orderBy: { createdAt: "desc" },
      });
      expect(log).not.toBeNull();
      expect(log?.actorId).toBe(adminId);
      expect(log?.targetId).toBe(ownerId);
      expect(log?.actorId).not.toBe(log?.targetId);
      expect(log?.targetLabel).toBe(`${OWNER_LOGIN}#${applicationId}`);
      expect(log?.targetLabel).toContain(OWNER_LOGIN);
      expect(log?.targetLabel).toContain(applicationId);

      const summary = log?.summary as Record<string, unknown>;
      expect(summary?.applicationId).toBe(applicationId);
      expect(summary?.type).toBe("TRAVEL");
    });
  });

  // ===========================================================================
  // Required Test #2 — AC-82 代修改
  // ===========================================================================

  describe("AC-82 代修改 — 管理員代修改他人草稿成功 → 寫入 AuditLog", () => {
    it("action=APPLICATION_UPDATED_ON_BEHALF，summary 含重要欄位變更前後摘要", async () => {
      // 擁有人自己先建一份草稿（初始 purpose=null，tripDate=null）。
      const applicationId = await createOwnDraft(ownerCookie, {});

      const resp = await putDraft(adminCookie, applicationId, {
        tripDate: "2043-02-05",
        purpose: "P4T12 AC-82 代修改後的目的",
        segments: [
          {
            origin: "甲地",
            destination: "乙地",
            totalKm: "8.00",
            highwayKm: "2.00",
            attachmentIds: [],
          },
        ],
      });
      expect(resp.statusCode).toBe(200);

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

      const summary = log?.summary as {
        applicationId: string;
        type: string;
        tripDate: { before: string | null; after: string | null };
        purpose: { before: string | null; after: string | null };
        segmentsCount: { before: number; after: number };
      };
      expect(summary.applicationId).toBe(applicationId);
      expect(summary.type).toBe("TRAVEL");
      // 重要欄位變更前後摘要 — tripDate/purpose 從 null 變為有值；segmentsCount 0→1。
      expect(summary.tripDate.before).toBeNull();
      expect(summary.tripDate.after).toBe("2043-02-05");
      expect(summary.purpose.before).toBeNull();
      expect(summary.purpose.after).toBe("P4T12 AC-82 代修改後的目的");
      expect(summary.segmentsCount.before).toBe(0);
      expect(summary.segmentsCount.after).toBe(1);
    });
  });

  // ===========================================================================
  // Required Test #3 — AC-83 原子性（正向：注入稽核寫入失敗 → 申請不落地）
  // ===========================================================================

  describe("AC-83 原子性（正向）— 稽核寫入失敗 → 主體變更 rollback", () => {
    it("createTravelDraft: onCreated 注入失敗 → 交易整體 rollback，DB 查無該申請", async () => {
      const sentinelPurpose = `P4T12-ATOMIC-CREATE-INJECT-${RUN_ID}`;
      const injectedMessage = `P4T12-INJECTED-CREATE-AUDIT-FAILURE-${RUN_ID}`;

      await expect(
        createTravelDraft(
          prisma,
          {
            ownerId,
            createdById: adminId,
            tripDate: new Date("2043-02-10"),
            purpose: sentinelPurpose,
          },
          async () => {
            throw new Error(injectedMessage);
          }
        )
      ).rejects.toThrow(injectedMessage);

      // 申請不落地：查無任何以此 sentinel purpose 建立的 TravelApplication。
      const stray = await prisma.travelApplication.findFirst({
        where: { purpose: sentinelPurpose },
      });
      expect(stray).toBeNull();
    });

    it("updateTravelDraft: onUpdated 注入失敗 → 交易整體 rollback，欄位仍為修改前的值", async () => {
      const applicationId = await createOwnDraft(ownerCookie, {
        purpose: "P4T12 原子性注入前的原始 purpose",
      });
      const before = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      const beforeTravel = await prisma.travelApplication.findUniqueOrThrow({
        where: { applicationId },
      });

      const injectedMessage = `P4T12-INJECTED-UPDATE-AUDIT-FAILURE-${RUN_ID}`;

      await expect(
        updateTravelDraft(
          prisma,
          applicationId,
          { purpose: "P4T12 這個值不應該落地" },
          undefined,
          async () => {
            throw new Error(injectedMessage);
          }
        )
      ).rejects.toThrow(injectedMessage);

      const after = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      const afterTravel = await prisma.travelApplication.findUniqueOrThrow({
        where: { applicationId },
      });
      expect(afterTravel.purpose).toBe(beforeTravel.purpose);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });
  });

  // ===========================================================================
  // Required Test #4 — AC-83 原子性（反向：操作被拒 → 不寫任何稽核）
  // ===========================================================================

  describe("AC-83 原子性（反向）— 操作被拒（403）→ 不寫任何稽核", () => {
    it("管理員代修改『已完成』申請 → 403，自建範圍內 AuditLog 筆數未變", async () => {
      const applicationId = await buildCompletedApplication(ownerCookie, ownerId);

      const countBefore = await prisma.auditLog.count({
        where: { actorId: adminId, action: "APPLICATION_UPDATED_ON_BEHALF" },
      });

      const resp = await putDraft(adminCookie, applicationId, {
        purpose: "P4T12 嘗試修改已完成（應被拒絕，不應寫入稽核）",
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<ErrorJson>().error.code).toBe("FORBIDDEN");

      const countAfter = await prisma.auditLog.count({
        where: { actorId: adminId, action: "APPLICATION_UPDATED_ON_BEHALF" },
      });
      expect(countAfter).toBe(countBefore);

      const noLog = await prisma.auditLog.findFirst({
        where: {
          targetLabel: `${OWNER_LOGIN}#${applicationId}`,
          action: "APPLICATION_UPDATED_ON_BEHALF",
        },
      });
      expect(noLog).toBeNull();
    });
  });

  // ===========================================================================
  // Required Test #5 — AC-86 鑑別力（使用者對自己草稿之常態操作不寫稽核）
  // ===========================================================================

  describe("AC-86 — 使用者對自己草稿的建立/儲存/刪除不寫稽核", () => {
    it("擁有人自建草稿 → 自建範圍內 AuditLog 筆數未增加", async () => {
      const countBefore = await prisma.auditLog.count({
        where: { OR: [{ actorId: ownerId }, { targetId: ownerId }] },
      });

      const applicationId = await createOwnDraft(ownerCookie, {
        purpose: "P4T12 AC-86 自建草稿",
      });

      const countAfter = await prisma.auditLog.count({
        where: { OR: [{ actorId: ownerId }, { targetId: ownerId }] },
      });
      expect(countAfter).toBe(countBefore);

      // 明確查無以此 applicationId 為 target 的任何 AuditLog（雙重確認）。
      const log = await prisma.auditLog.findFirst({
        where: { targetLabel: { contains: applicationId } },
      });
      expect(log).toBeNull();
    });

    it("擁有人自己 PUT 儲存自己的草稿 → 自建範圍內 AuditLog 筆數未增加", async () => {
      const applicationId = await createOwnDraft(ownerCookie, {});

      const countBefore = await prisma.auditLog.count({
        where: { OR: [{ actorId: ownerId }, { targetId: ownerId }] },
      });

      const resp = await putDraft(ownerCookie, applicationId, {
        tripDate: "2043-02-15",
        purpose: "P4T12 AC-86 自己儲存",
        segments: [
          {
            origin: "起",
            destination: "迄",
            totalKm: "3.00",
            highwayKm: "0.00",
            attachmentIds: [],
          },
        ],
      });
      expect(resp.statusCode).toBe(200);

      const countAfter = await prisma.auditLog.count({
        where: { OR: [{ actorId: ownerId }, { targetId: ownerId }] },
      });
      expect(countAfter).toBe(countBefore);

      const log = await prisma.auditLog.findFirst({
        where: { targetLabel: { contains: applicationId } },
      });
      expect(log).toBeNull();
    });

    it("擁有人自己刪除自己的草稿 → 自建範圍內 AuditLog 筆數未增加", async () => {
      const applicationId = await createOwnDraft(ownerCookie, {
        purpose: "P4T12 AC-86 自己刪除",
      });

      const countBefore = await prisma.auditLog.count({
        where: { OR: [{ actorId: ownerId }, { targetId: ownerId }] },
      });

      const resp = await deleteDraft(ownerCookie, applicationId);
      expect(resp.statusCode).toBe(200);
      // 刪除成功後不需再追蹤清理（列已不存在）——但保留在 createdApplicationIds
      // 中不影響 afterAll 的 deleteMany（deleteMany 對不存在的 id 是 no-op）。

      const countAfter = await prisma.auditLog.count({
        where: { OR: [{ actorId: ownerId }, { targetId: ownerId }] },
      });
      expect(countAfter).toBe(countBefore);
    });
  });

  // ===========================================================================
  // Required Test #6 — C3 邊界：管理員操作「自己」的申請 → 不算代操作
  // ===========================================================================

  describe("C3 邊界 — actorId === ownerId 即非代操作（管理員操作自己的申請）", () => {
    it("管理員透過代操作端點『代自己』建立（:userId=自己）→ 不寫 APPLICATION_CREATED_ON_BEHALF", async () => {
      const countBefore = await prisma.auditLog.count({
        where: { actorId: adminId, action: "APPLICATION_CREATED_ON_BEHALF", targetId: adminId },
      });

      const resp = await onBehalfCreate(adminCookie, adminId, {
        purpose: "P4T12 C3 管理員代自己建立",
      });
      expect(resp.statusCode).toBe(201);
      const applicationId = resp.json<{ application: ApplicationJson }>().application.id;
      track(applicationId);

      const countAfter = await prisma.auditLog.count({
        where: { actorId: adminId, action: "APPLICATION_CREATED_ON_BEHALF", targetId: adminId },
      });
      expect(countAfter).toBe(countBefore);

      const log = await prisma.auditLog.findFirst({
        where: { targetLabel: { contains: applicationId } },
      });
      expect(log).toBeNull();
    });

    it("管理員 PUT 自己的草稿 → 不寫 APPLICATION_UPDATED_ON_BEHALF", async () => {
      const applicationId = await createOwnDraft(adminCookie, {});

      const countBefore = await prisma.auditLog.count({
        where: { actorId: adminId, action: "APPLICATION_UPDATED_ON_BEHALF", targetId: adminId },
      });

      const resp = await putDraft(adminCookie, applicationId, {
        purpose: "P4T12 C3 管理員修改自己的草稿",
      });
      expect(resp.statusCode).toBe(200);

      const countAfter = await prisma.auditLog.count({
        where: { actorId: adminId, action: "APPLICATION_UPDATED_ON_BEHALF", targetId: adminId },
      });
      expect(countAfter).toBe(countBefore);

      const log = await prisma.auditLog.findFirst({
        where: { targetLabel: { contains: applicationId } },
      });
      expect(log).toBeNull();
    });
  });

  // ===========================================================================
  // Required Test #7 — 稽核安全逐鍵斷言
  // ===========================================================================

  describe("稽核安全 — summary/targetLabel 逐鍵斷言不含密碼/token/cookie/secret", () => {
    it("代建立 + 代修改所寫入的 AuditLog 逐鍵走訪皆不含敏感內容", async () => {
      const createResp = await onBehalfCreate(adminCookie, ownerId, {
        tripDate: "2043-02-20",
        purpose: "P4T12 AC-90 安全檢查用代建立",
      });
      expect(createResp.statusCode).toBe(201);
      const createdId = createResp.json<{ application: ApplicationJson }>().application.id;
      track(createdId);

      const putResp = await putDraft(adminCookie, createdId, {
        purpose: "P4T12 AC-90 安全檢查用代修改",
        segments: [
          {
            origin: "起點X",
            destination: "終點Y",
            totalKm: "6.00",
            highwayKm: "1.00",
            attachmentIds: [],
          },
        ],
      });
      expect(putResp.statusCode).toBe(200);

      const logs = await prisma.auditLog.findMany({
        where: { targetLabel: `${OWNER_LOGIN}#${createdId}` },
      });
      expect(logs.length).toBeGreaterThanOrEqual(2); // 代建立 + 代修改各一筆

      for (const log of logs) {
        assertNoSensitiveContent(log.targetLabel, `auditLog(${log.id}).targetLabel`);
        assertNoSensitiveContent(log.summary, `auditLog(${log.id}).summary`);
      }
    });
  });
});
