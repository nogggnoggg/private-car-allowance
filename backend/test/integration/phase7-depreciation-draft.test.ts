/**
 * Integration tests for PHASE-007-T4:
 *   折舊草稿 CRUD 端點 ＋ 欄位驗證（分層 gate table）＋ 狀態／授權守門
 *   ＋ 草稿刪除之 `refType='DEPRECIATION'` 附件 detach。
 *
 * TDD：本檔先於 `depreciation-service.ts`／`routes.ts` 之接線寫成，首輪為 RED
 * （`/applications/depreciation` 路由尚不存在 → 404）。首輪 RED 輸出見 Task
 * Handoff。
 *
 * AC covered（PHASE-007 Spec §2）：AC-02、AC-03、AC-04、AC-05；§6.1 授權矩陣
 * 第 1~4 列（8 欄 × 5 身分之本 Task 相關格）；§7.5 第 1、2 碼（草稿階段兩段式
 * 第一段）；§16 D3(a) 年度值域 [1900, 2999]（T3 即審 FW-1：值域 100% 落本
 * 驗證層，blocker 層不擋、DB 無 CHECK）；T3 即審 FW-2（`fields[].field` 沿用
 * 字面 `"applicationYear"`）。
 *
 * 刻意不在本檔覆蓋（後續 Task 之範圍，見 Spec §15）：
 *   - `primaryDate` 之年度推導與 `duplicateYearNotice`（AC-06/07，T5）
 *   - 年度公務里程與 `computed` 之填充（AC-09~14，T6；AC-15~18，T7）
 *   - 附件上限 5、完成鎖定、跨使用者掛入（AC-23/25/26，T8）
 *   - 完成流程與快照寫入（AC-27~30，T9）
 *
 * Test discipline（Spec §11.0 / Packet）：
 *   - loginName prefix "p7t4_" ＋ per-run random suffix；
 *   - 清理僅限本套件自行追蹤之 id 與 loginName 前綴，絕不 deleteMany({})；
 *   - 全程合成資料。
 */
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateDepreciationDraft } from "../../src/applications/depreciation-service.js";
import { hashPassword } from "../../src/auth/password.js";
import { AppError } from "../../src/platform/errors.js";
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
const LOGIN_PREFIX = "p7t4_";
const PASSWORD = "DepreciationDraftTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;
const MCP_LOGIN = `${LOGIN_PREFIX}mcp_${RUN_ID}`;

const NONEXISTENT_ID = "p7t4-nonexistent-application-id-000000";

/** §16 D3(a)（人類已批准）：年度值域 [1900, 2999]，起訖含當值。 */
const YEAR_MIN = 1900;
const YEAR_MAX = 2999;

describeWithDb("PHASE-007-T4 — 折舊草稿 CRUD ＋ 欄位驗證 ＋ 狀態／授權守門", () => {
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
  const createdAttachmentIds: string[] = [];

  function track(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  async function createDraft(cookie: string, payload: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/applications/depreciation",
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
      url: `/applications/depreciation/${id}`,
      headers: { cookie },
      payload,
    });
  }

  async function getDraft(cookie: string, id: string) {
    return app.inject({
      method: "GET",
      url: `/applications/depreciation/${id}`,
      headers: { cookie },
    });
  }

  async function deleteApplicationHttp(cookie: string, id: string) {
    return app.inject({
      method: "DELETE",
      url: `/applications/${id}`,
      headers: { cookie },
    });
  }

  /**
   * 直接以 Prisma 把狀態撥為 COMPLETED（不經完成流程——完成流程屬 T9）。
   * 快照欄位刻意維持 `null`，用以固定「COMPLETED 但無快照 → DTO `snapshot`
   * 為 `null`、不得 500」之既有慣例（006 T7R S-1 同型）。
   */
  async function markCompleted(applicationId: string) {
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: "COMPLETED", completedAt: new Date(), totalAmount: 5000 },
    });
  }

  /** 建立一張屬於指定擁有人之 TEMP 附件（合成資料）。 */
  async function createTempAttachment(attachmentOwnerId: string): Promise<string> {
    const suffix = `${RUN_ID}_${createdAttachmentIds.length}`;
    const attachment = await prisma.attachment.create({
      data: {
        status: "TEMP",
        storageKey: `p7t4/${suffix}.jpg`,
        mimeType: "image/jpeg",
        byteSize: 1024,
        originalFilename: `proof-${suffix}.jpg`,
        uploaderId: attachmentOwnerId,
        ownerId: attachmentOwnerId,
      },
    });
    createdAttachmentIds.push(attachment.id);
    return attachment.id;
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);

    const owner = await prisma.user.create({
      data: {
        loginName: OWNER_LOGIN,
        displayName: "P7T4 擁有人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const other = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "P7T4 他人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "P7T4 管理員",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const mcp = await prisma.user.create({
      data: {
        loginName: MCP_LOGIN,
        displayName: "P7T4 待改密使用者",
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
  // AC-02 — POST 建立草稿（body 全選填）
  // ===========================================================================

  describe("AC-02: POST /applications/depreciation creates a DRAFT with all-null snapshot columns and ignores body-supplied ownerId/status/totalAmount", () => {
    it("空 body → 201，status=DRAFT、owner=createdBy=本人、applicationYear 為 null、快照欄全 null", async () => {
      const resp = await createDraft(ownerCookie, {});
      expect(resp.statusCode).toBe(201);
      const application = resp.json<{ application: Record<string, unknown> }>().application;
      track(application.id as string);

      expect(application.type).toBe("DEPRECIATION");
      expect(application.status).toBe("DRAFT");
      expect(application.ownerId).toBe(ownerId);
      expect(application.createdById).toBe(ownerId);
      expect(application.onBehalf).toBe(false);
      expect(application.applicationYear).toBeNull();
      // PHASE-007-R5（AC-02／§20.6）：新增之申請資料欄，未輸入時為 null。
      expect(application.annualTotalKm).toBeNull();
      expect(application.attachments).toEqual([]);
      expect(application.snapshot).toBeNull();

      // DB 層：`Application.totalAmount` 與**修訂後 11 個快照欄**（9 欄新模型
      // ＋ 2 欄凍結唯讀）逐欄 null（AC-02 逐字；§12R.2 AC-02 列：「『全部快照欄
      // 為 null』之逐欄斷言須含新增 4 欄」）。
      const parent = await prisma.application.findUnique({
        where: { id: application.id as string },
      });
      expect(parent?.type).toBe("DEPRECIATION");
      expect(parent?.status).toBe("DRAFT");
      expect(parent?.totalAmount).toBeNull();

      const child = await prisma.depreciationApplication.findUnique({
        where: { applicationId: application.id as string },
      });
      expect(child).not.toBeNull();
      expect(child?.applicationYear).toBeNull();
      expect(child?.annualTotalKm).toBeNull();
      expect(child?.snapshotVehiclePrice).toBeNull();
      expect(child?.snapshotUsefulLifeYears).toBeNull();
      expect(child?.snapshotAnnualDepreciation).toBeNull();
      expect(child?.snapshotOfficialKm).toBeNull();
      expect(child?.snapshotAnnualTotalKm).toBeNull();
      expect(child?.snapshotRatio).toBeNull();
      expect(child?.snapshotRawAmount).toBeNull();
      expect(child?.calculatedAt).toBeNull();
      expect(child?.depreciationParameterVersionId).toBeNull();
      // 凍結唯讀之舊模型二欄（AC-55(b)）：草稿列亦恆為 null。
      expect(child?.snapshotEstimatedAnnualKm).toBeNull();
      expect(child?.snapshotPerKmUnitPrice).toBeNull();
    });

    it("空 body → completionBlockers ＝ [YEAR_REQUIRED, ANNUAL_TOTAL_KM_REQUIRED]（§20.5.1 兩段式第一段，順序穩定）", async () => {
      const application = await createOwnerDraft({});
      const blockers = application.completionBlockers as { code: string; field?: string }[];
      // §20.5.1 之修訂後固定順序：第 1 碼年度、第 2 碼年度總里程。
      // `DEPRECIATION_ATTACHMENT_REQUIRED` 已於修訂段退場（AC-54(b)）。
      expect(blockers.map((b) => b.code)).toEqual(["YEAR_REQUIRED", "ANNUAL_TOTAL_KM_REQUIRED"]);
      expect(blockers.map((b) => b.code)).not.toContain("DEPRECIATION_ATTACHMENT_REQUIRED");
      // 第 4~6 碼於草稿階段完全被抑制（§20.5 兩段式：officialKm／
      // annualDepreciation 同不給）。
      expect(blockers.map((b) => b.code)).not.toContain("PARAMETER_NOT_AVAILABLE");
      expect(blockers.map((b) => b.code)).not.toContain("AMOUNT_OUT_OF_RANGE");
      // AC-47(e)／FW-2：欄位路徑逐字。
      expect(blockers.find((b) => b.code === "ANNUAL_TOTAL_KM_REQUIRED")?.field).toBe(
        "annualTotalKm"
      );
    });

    it("帶 applicationYear → 201 且如實保存（DTO 與 DB 皆為 number）", async () => {
      const application = await createOwnerDraft({ applicationYear: 2025 });
      expect(application.applicationYear).toBe(2025);
      const child = await prisma.depreciationApplication.findUnique({
        where: { applicationId: application.id as string },
      });
      expect(child?.applicationYear).toBe(2025);
    });

    it("body 夾帶 ownerId／createdById／status／totalAmount → 一律不採用（DB 層斷言）", async () => {
      const resp = await createDraft(ownerCookie, {
        ownerId: otherId,
        createdById: otherId,
        status: "COMPLETED",
        totalAmount: 999999,
      });
      expect(resp.statusCode).toBe(201);
      const application = resp.json<{ application: Record<string, unknown> }>().application;
      track(application.id as string);

      const parent = await prisma.application.findUnique({
        where: { id: application.id as string },
      });
      expect(parent?.ownerId).toBe(ownerId);
      expect(parent?.createdById).toBe(ownerId);
      expect(parent?.status).toBe("DRAFT");
      expect(parent?.totalAmount).toBeNull();
    });

    it("管理員自建 → 201，owner ＝ 管理員自己（本端點無 ownerId 參數）", async () => {
      const resp = await createDraft(adminCookie, {});
      expect(resp.statusCode).toBe(201);
      const application = resp.json<{ application: Record<string, unknown> }>().application;
      track(application.id as string);
      expect(application.ownerId).toBe(adminId);
      expect(application.createdById).toBe(adminId);
    });
  });

  // ===========================================================================
  // AC-03 — applicationYear 分層 gate table（型別／格式／小數／值域）
  // ===========================================================================

  describe("AC-03: applicationYear validation gate table — type/format/range, with fields[].field asserted", () => {
    // 型別層之逐字文案（本端點只收 JSON number 或 null——理由見
    // `routes.ts` 之 `parseApplicationYearField` 檔內註解 (a)(b)(c)）。
    const TYPE_REASON = "必須為整數年份（數字或 null）";

    const invalidCases: { label: string; value: unknown; exactReason?: string }[] = [
      // ── 型別層 ──
      { label: "布林值", value: true, exactReason: TYPE_REASON },
      { label: "陣列", value: [], exactReason: TYPE_REASON },
      { label: "物件", value: { year: 2025 }, exactReason: TYPE_REASON },
      { label: "數值字串（合法年份但型別為字串）", value: "2025", exactReason: TYPE_REASON },
      { label: "非數值字串", value: "abc", exactReason: TYPE_REASON },
      { label: "空字串", value: "", exactReason: TYPE_REASON },
      { label: "純空白字串", value: "   ", exactReason: TYPE_REASON },
      { label: "千分位字串", value: "2,025", exactReason: TYPE_REASON },
      { label: "科學記號字串", value: "2e3", exactReason: TYPE_REASON },
      { label: "NaN 字串", value: "NaN", exactReason: TYPE_REASON },
      { label: "Infinity 字串", value: "Infinity", exactReason: TYPE_REASON },
      { label: "全形數字字串", value: "２０２５", exactReason: TYPE_REASON },
      // ── 小數層 ──
      {
        label: "含小數（數字）",
        value: 2025.5,
        exactReason: "必須為整數年份（不得含小數）",
      },
      {
        label: "極小小數偏移（2025.0000001）",
        value: 2025.0000001,
        exactReason: "必須為整數年份（不得含小數）",
      },
      // ── 值域層（§16 D3(a)：[1900, 2999]）──
      {
        label: "低於下界（1899）",
        value: YEAR_MIN - 1,
        exactReason: `申請年度必須介於 ${YEAR_MIN} 與 ${YEAR_MAX} 之間`,
      },
      {
        label: "高於上界（3000）",
        value: YEAR_MAX + 1,
        exactReason: `申請年度必須介於 ${YEAR_MIN} 與 ${YEAR_MAX} 之間`,
      },
      {
        label: "零",
        value: 0,
        exactReason: `申請年度必須介於 ${YEAR_MIN} 與 ${YEAR_MAX} 之間`,
      },
      {
        label: "負數",
        value: -2025,
        exactReason: `申請年度必須介於 ${YEAR_MIN} 與 ${YEAR_MAX} 之間`,
      },
      {
        label: "int4 上界（2147483647）",
        value: 2147483647,
        exactReason: `申請年度必須介於 ${YEAR_MIN} 與 ${YEAR_MAX} 之間`,
      },
      {
        label: "超出 int4（2147483648）",
        value: 2147483648,
        exactReason: `申請年度必須介於 ${YEAR_MIN} 與 ${YEAR_MAX} 之間`,
      },
    ];

    // POST 與 PUT 共用同一份驗證路徑——兩端點各跑一遍同一張表（006 T4R SF-1
    // 教訓：僅測 PUT 會讓「POST 少一道守門」之 mutant 存活）。
    for (const { label, value, exactReason } of invalidCases) {
      it(`POST applicationYear=${label} → 400 VALIDATION_ERROR，fields[].field 逐字為 "applicationYear"`, async () => {
        const resp = await createDraft(ownerCookie, { applicationYear: value });
        expect(resp.statusCode).toBe(400);
        const body = resp.json<{
          error: { code: string; fields?: { field: string; reason: string }[] };
        }>();
        expect(body.error.code).toBe("VALIDATION_ERROR");
        // FW-2：欄位路徑為字面 "applicationYear"（與 blocker 層一致）。
        const fields = body.error.fields ?? [];
        expect(fields.map((f) => f.field)).toContain("applicationYear");
        const match = fields.find((f) => f.field === "applicationYear");
        if (exactReason !== undefined) {
          expect(match?.reason).toBe(exactReason);
        } else {
          expect((match?.reason ?? "").length).toBeGreaterThan(0);
        }
      });

      it(`PUT applicationYear=${label} → 400 VALIDATION_ERROR，fields[].field 逐字為 "applicationYear"，DB 不變`, async () => {
        const draft = await createOwnerDraft({ applicationYear: 2020 });
        const resp = await putDraft(ownerCookie, draft.id as string, { applicationYear: value });
        expect(resp.statusCode).toBe(400);
        const body = resp.json<{
          error: { code: string; fields?: { field: string; reason: string }[] };
        }>();
        expect(body.error.code).toBe("VALIDATION_ERROR");
        const fields = body.error.fields ?? [];
        expect(fields.map((f) => f.field)).toContain("applicationYear");
        if (exactReason !== undefined) {
          expect(fields.find((f) => f.field === "applicationYear")?.reason).toBe(exactReason);
        }
        const child = await prisma.depreciationApplication.findUnique({
          where: { applicationId: draft.id as string },
        });
        expect(child?.applicationYear).toBe(2020);
      });
    }

    // 值域正例（含邊界恰通過；上下界 ±1 之拒絕已在上表）
    const validCases: { label: string; value: unknown; expected: number | null }[] = [
      { label: "下界 1900（恰通過）", value: YEAR_MIN, expected: YEAR_MIN },
      { label: "上界 2999（恰通過）", value: YEAR_MAX, expected: YEAR_MAX },
      { label: "下界＋1（1901）", value: YEAR_MIN + 1, expected: YEAR_MIN + 1 },
      { label: "上界－1（2998）", value: YEAR_MAX - 1, expected: YEAR_MAX - 1 },
      { label: "一般年度 2026", value: 2026, expected: 2026 },
      { label: "null（清空／未選擇）", value: null, expected: null },
    ];

    for (const { label, value, expected } of validCases) {
      it(`POST applicationYear=${label} → 201 且保存為 ${expected}`, async () => {
        const application = await createOwnerDraft({ applicationYear: value });
        expect(application.applicationYear).toBe(expected);
        const child = await prisma.depreciationApplication.findUnique({
          where: { applicationId: application.id as string },
        });
        expect(child?.applicationYear).toBe(expected);
      });

      it(`PUT applicationYear=${label} → 200 且保存為 ${expected}`, async () => {
        const draft = await createOwnerDraft({});
        const resp = await putDraft(ownerCookie, draft.id as string, { applicationYear: value });
        expect(resp.statusCode).toBe(200);
        expect(
          resp.json<{ application: Record<string, unknown> }>().application.applicationYear
        ).toBe(expected);
        const child = await prisma.depreciationApplication.findUnique({
          where: { applicationId: draft.id as string },
        });
        expect(child?.applicationYear).toBe(expected);
      });
    }

    it("PUT 三態語意：key 缺席＝不變、key=null＝清空、key 有值＝設定", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2024 });

      // key 缺席 = 不變
      const r1 = await putDraft(ownerCookie, draft.id as string, {});
      expect(r1.statusCode).toBe(200);
      expect(r1.json<{ application: Record<string, unknown> }>().application.applicationYear).toBe(
        2024
      );

      // key = null = 清空
      const r2 = await putDraft(ownerCookie, draft.id as string, { applicationYear: null });
      expect(r2.statusCode).toBe(200);
      expect(
        r2.json<{ application: Record<string, unknown> }>().application.applicationYear
      ).toBeNull();

      // key 有值 = 設定
      const r3 = await putDraft(ownerCookie, draft.id as string, { applicationYear: 2027 });
      expect(r3.statusCode).toBe(200);
      expect(r3.json<{ application: Record<string, unknown> }>().application.applicationYear).toBe(
        2027
      );
    });

    it("completionBlockers 隨年度填寫而變（YEAR_REQUIRED 消失，ANNUAL_TOTAL_KM_REQUIRED 仍在）", async () => {
      const draft = await createOwnerDraft({});
      expect((draft.completionBlockers as { code: string }[]).map((b) => b.code)).toContain(
        "YEAR_REQUIRED"
      );

      const resp = await putDraft(ownerCookie, draft.id as string, { applicationYear: 2025 });
      expect(resp.statusCode).toBe(200);
      const codes = (
        resp.json<{ application: Record<string, unknown> }>().application.completionBlockers as {
          code: string;
        }[]
      ).map((b) => b.code);
      // §20.5.1：第 1 碼消失後，仍缺年度總里程 → 第 2 碼（修訂後之第二個結構性
      // 條件；舊模型之附件碼已退場，AC-54(b)）。
      expect(codes).toEqual(["ANNUAL_TOTAL_KM_REQUIRED"]);
    });

    it("attachmentIds 格式錯誤（非字串陣列）→ 400，fields[].field 為 attachmentIds", async () => {
      const draft = await createOwnerDraft({});
      const resp = await putDraft(ownerCookie, draft.id as string, { attachmentIds: "not-array" });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect((body.error.fields ?? []).map((f) => f.field)).toContain("attachmentIds");
    });

    it("同時多欄不合法 → fields[] 全部回報（非只回第一項）", async () => {
      const draft = await createOwnerDraft({});
      const resp = await putDraft(ownerCookie, draft.id as string, {
        applicationYear: "abc",
        attachmentIds: 123,
      });
      expect(resp.statusCode).toBe(400);
      const fields = (
        resp.json<{ error: { fields?: { field: string }[] } }>().error.fields ?? []
      ).map((f) => f.field);
      expect(fields).toContain("applicationYear");
      expect(fields).toContain("attachmentIds");
    });
  });

  // ===========================================================================
  // AC-47 — annualTotalKm 分層 gate table（型別／小數 1 位／≤0／容量）
  //          **POST 與 PUT 兩端點各一組**（AC-47 逐字；006 T4R SF-1 教訓）
  // ===========================================================================

  describe("AC-47: annualTotalKm validation gate table — type/decimal-places(≤1)/≤0/capacity, with fields[].field asserted", () => {
    const DECIMAL_REASON = "最多允許 1 位小數";
    const POSITIVE_REASON = "年度總里程必須大於 0";
    const CAPACITY_REASON = "數值超出可儲存範圍（整數部分最多 8 位）";

    const invalidCases: { label: string; value: unknown; exactReason?: string }[] = [
      // ── (a) 型別層 ──
      { label: "布林值", value: true },
      { label: "陣列", value: [20000] },
      { label: "物件", value: { km: 20000 } },
      { label: "非數值字串", value: "abc" },
      { label: "空字串", value: "" },
      { label: "純空白字串", value: "   " },
      { label: "千分位字串", value: "20,000" },
      { label: "科學記號字串", value: "2e4" },
      { label: "NaN 字串", value: "NaN" },
      { label: "Infinity 字串", value: "Infinity" },
      { label: "全形數字字串", value: "２００００" },
      // ── (b) 精度層（裁定 D：小數最多 1 位；不得靜默取整）──
      { label: "2 位小數（12345.67）", value: 12345.67, exactReason: DECIMAL_REASON },
      { label: "2 位小數字串（'12345.67'）", value: "12345.67", exactReason: DECIMAL_REASON },
      { label: "3 位小數（12345.678）", value: 12345.678, exactReason: DECIMAL_REASON },
      // ── (c) 值域層（裁定 E：0／負數當場 400）──
      { label: "零（0）", value: 0, exactReason: POSITIVE_REASON },
      { label: "零（字串 '0.0'）", value: "0.0", exactReason: POSITIVE_REASON },
      { label: "負數（-1）", value: -1, exactReason: POSITIVE_REASON },
      { label: "負數（-0.1）", value: -0.1, exactReason: POSITIVE_REASON },
      // ── (d) 容量層（Decimal(9,1)：整數部分最多 8 位）──
      { label: "恰達上界（100000000）", value: 100000000, exactReason: CAPACITY_REASON },
      {
        label: "恰達上界之 1dp 寫法（'100000000.0'）",
        value: "100000000.0",
        exactReason: CAPACITY_REASON,
      },
    ];

    for (const { label, value, exactReason } of invalidCases) {
      it(`POST annualTotalKm=${label} → 400 VALIDATION_ERROR，fields[].field 逐字為 "annualTotalKm"`, async () => {
        const resp = await createDraft(ownerCookie, { annualTotalKm: value });
        expect(resp.statusCode).toBe(400);
        const body = resp.json<{
          error: { code: string; fields?: { field: string; reason: string }[] };
        }>();
        expect(body.error.code).toBe("VALIDATION_ERROR");
        // AC-47(e)：欄位路徑明文斷言（006 T3 AR-2／FW-5 教訓）。
        const fields = body.error.fields ?? [];
        expect(fields.map((f) => f.field)).toContain("annualTotalKm");
        const match = fields.find((f) => f.field === "annualTotalKm");
        if (exactReason !== undefined) {
          expect(match?.reason).toBe(exactReason);
        } else {
          expect((match?.reason ?? "").length).toBeGreaterThan(0);
        }
      });

      it(`PUT annualTotalKm=${label} → 400 VALIDATION_ERROR，fields[].field 逐字為 "annualTotalKm"，DB 不變`, async () => {
        const draft = await createOwnerDraft({ annualTotalKm: "12345.6" });
        const resp = await putDraft(ownerCookie, draft.id as string, { annualTotalKm: value });
        expect(resp.statusCode).toBe(400);
        const body = resp.json<{
          error: { code: string; fields?: { field: string; reason: string }[] };
        }>();
        expect(body.error.code).toBe("VALIDATION_ERROR");
        const fields = body.error.fields ?? [];
        expect(fields.map((f) => f.field)).toContain("annualTotalKm");
        if (exactReason !== undefined) {
          expect(fields.find((f) => f.field === "annualTotalKm")?.reason).toBe(exactReason);
        }
        const child = await prisma.depreciationApplication.findUnique({
          where: { applicationId: draft.id as string },
        });
        expect(child?.annualTotalKm?.toFixed(1)).toBe("12345.6");
      });
    }

    // 邊界正例（AC-47(b)(d)：小數 1 位與容量之「恰通過」四點）
    const validCases: { label: string; value: unknown; expected: string | null }[] = [
      { label: "1 位小數（12345.6）", value: 12345.6, expected: "12345.6" },
      { label: "無小數（12345）", value: 12345, expected: "12345.0" },
      { label: "1 位小數字串（'12345.6'）", value: "12345.6", expected: "12345.6" },
      { label: "尾隨零字串（'12345.60'）", value: "12345.60", expected: "12345.6" },
      { label: "容量上界內（99999999.9，恰通過）", value: "99999999.9", expected: "99999999.9" },
      { label: "容量上界內（99999999.8）", value: "99999999.8", expected: "99999999.8" },
      { label: "最小正值（0.1）", value: "0.1", expected: "0.1" },
      { label: "null（草稿寬容，AC-53(a)）", value: null, expected: null },
    ];

    for (const { label, value, expected } of validCases) {
      it(`POST annualTotalKm=${label} → 201 且保存為 ${expected}`, async () => {
        const application = await createOwnerDraft({ annualTotalKm: value });
        expect(application.annualTotalKm).toBe(expected);
        const child = await prisma.depreciationApplication.findUnique({
          where: { applicationId: application.id as string },
        });
        expect(child?.annualTotalKm === null ? null : child?.annualTotalKm.toFixed(1)).toBe(
          expected
        );
      });

      it(`PUT annualTotalKm=${label} → 200 且保存為 ${expected}`, async () => {
        const draft = await createOwnerDraft({});
        const resp = await putDraft(ownerCookie, draft.id as string, { annualTotalKm: value });
        expect(resp.statusCode).toBe(200);
        expect(
          resp.json<{ application: Record<string, unknown> }>().application.annualTotalKm
        ).toBe(expected);
        const child = await prisma.depreciationApplication.findUnique({
          where: { applicationId: draft.id as string },
        });
        expect(child?.annualTotalKm === null ? null : child?.annualTotalKm.toFixed(1)).toBe(
          expected
        );
      });
    }

    it("PUT 三態語意：key 缺席＝不變、key=null＝清空（草稿寬容）、key 有值＝設定", async () => {
      const draft = await createOwnerDraft({ annualTotalKm: "15000.5" });

      const r1 = await putDraft(ownerCookie, draft.id as string, {});
      expect(r1.statusCode).toBe(200);
      expect(r1.json<{ application: Record<string, unknown> }>().application.annualTotalKm).toBe(
        "15000.5"
      );

      const r2 = await putDraft(ownerCookie, draft.id as string, { annualTotalKm: null });
      expect(r2.statusCode).toBe(200);
      expect(
        r2.json<{ application: Record<string, unknown> }>().application.annualTotalKm
      ).toBeNull();

      const r3 = await putDraft(ownerCookie, draft.id as string, { annualTotalKm: "22222.2" });
      expect(r3.statusCode).toBe(200);
      expect(r3.json<{ application: Record<string, unknown> }>().application.annualTotalKm).toBe(
        "22222.2"
      );
    });

    it("AC-53(a)：未輸入年度總里程之草稿建立與更新皆成功（201／200），且 blocker 為 ANNUAL_TOTAL_KM_REQUIRED", async () => {
      const created = await createOwnerDraft({ applicationYear: 2131 });
      expect(created.annualTotalKm).toBeNull();
      const codes = (created.completionBlockers as { code: string; field?: string }[]).map(
        (b) => b.code
      );
      expect(codes).toEqual(["ANNUAL_TOTAL_KM_REQUIRED"]);

      const resp = await putDraft(ownerCookie, created.id as string, { applicationYear: 2132 });
      expect(resp.statusCode).toBe(200);
      const updated = resp.json<{ application: Record<string, unknown> }>().application;
      expect(updated.annualTotalKm).toBeNull();
      expect((updated.completionBlockers as { code: string }[]).map((b) => b.code)).toEqual([
        "ANNUAL_TOTAL_KM_REQUIRED",
      ]);
    });

    it("annualTotalKm 與 applicationYear 同時不合法 → fields[] 兩欄皆回報（非只回第一項）", async () => {
      const resp = await createDraft(ownerCookie, {
        applicationYear: "abc",
        annualTotalKm: "12345.67",
      });
      expect(resp.statusCode).toBe(400);
      const fields = (
        resp.json<{ error: { fields?: { field: string }[] } }>().error.fields ?? []
      ).map((f) => f.field);
      expect(fields).toContain("applicationYear");
      expect(fields).toContain("annualTotalKm");
    });

    it("AC-47(f)：授權先於格式驗證——他人以畸形 annualTotalKm PUT → 403（不得洩漏為 400）", async () => {
      const draft = await createOwnerDraft({ annualTotalKm: "10000.0" });
      const resp = await putDraft(otherCookie, draft.id as string, { annualTotalKm: "1.234" });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
      const child = await prisma.depreciationApplication.findUnique({
        where: { applicationId: draft.id as string },
      });
      expect(child?.annualTotalKm?.toFixed(1)).toBe("10000.0");
    });

    it("AC-47(f)：未登入 ＋ 畸形 annualTotalKm → 401（認證先於一切）", async () => {
      const draft = await createOwnerDraft({});
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/depreciation/${draft.id as string}`,
        payload: { annualTotalKm: "1.234" },
      });
      expect(resp.statusCode).toBe(401);
    });

    it("AC-47(f)：已完成申請 ＋ 畸形 annualTotalKm → 403（狀態機守門先於 400 格式驗證）", async () => {
      const draft = await createOwnerDraft({ annualTotalKm: "10000.0" });
      await markCompleted(draft.id as string);
      const resp = await putDraft(ownerCookie, draft.id as string, { annualTotalKm: "-5" });
      expect(resp.statusCode).toBe(403);
    });
  });

  // ===========================================================================
  // AC-48 — annualTotalKm 為「申請資料」應予採用（建立／更新面）
  // ===========================================================================

  describe("AC-48: annualTotalKm is 申請資料 and IS adopted from the request body, while officialKm/ratio/amount are never adopted (same-request contrast matrix)", () => {
    it("AC-48(a)：POST 之 annualTotalKm 寫入 DB 之值與請求值逐位元相同，DTO 為固定 1 位小數字串", async () => {
      const application = await createOwnerDraft({
        applicationYear: 2133,
        annualTotalKm: "12345.6",
      });
      expect(application.annualTotalKm).toBe("12345.6");
      const child = await prisma.depreciationApplication.findUnique({
        where: { applicationId: application.id as string },
      });
      // 逐位元：DB 值以 Decimal 精確比較（非 number 近似）。
      expect(child?.annualTotalKm?.equals(new Prisma.Decimal("12345.6"))).toBe(true);
      expect(child?.annualTotalKm?.toFixed(1)).toBe("12345.6");
    });

    it("AC-48(a)：PUT 之 annualTotalKm 同樣逐位元入庫（含 1dp 尾數不被靜默取整）", async () => {
      const draft = await createOwnerDraft({});
      const resp = await putDraft(ownerCookie, draft.id as string, { annualTotalKm: "99999999.9" });
      expect(resp.statusCode).toBe(200);
      expect(resp.json<{ application: Record<string, unknown> }>().application.annualTotalKm).toBe(
        "99999999.9"
      );
      const child = await prisma.depreciationApplication.findUnique({
        where: { applicationId: draft.id as string },
      });
      expect(child?.annualTotalKm?.equals(new Prisma.Decimal("99999999.9"))).toBe(true);
    });

    // AC-48(b)：同一請求之對照矩陣。夾帶值一律為**頂層純量**且與正確值可鑑別
    // （006 T8 MF-1 教訓：夾帶巢狀物件無法鑑別「讀了但忽略」與「根本沒讀」）。
    const SMUGGLED = {
      officialKm: "987654.32",
      ratio: "0.999999",
      ratioPercent: "99.9999",
      annualDepreciation: "123456.78",
      rawAmount: "8888.8888",
      amount: 8888,
      totalAmount: 999999,
      snapshotOfficialKm: "555.55",
      snapshotAnnualTotalKm: "777.7",
      snapshotRatio: "0.777777",
      snapshotAnnualDepreciation: "777777.77",
      snapshotRawAmount: "7777.7777",
    } as const;

    it("AC-48(b)：POST 同一請求夾帶 annualTotalKm（採用）＋ officialKm／ratio／amount 等（一律不採用）→ 與未夾帶之對照組逐位元相同", async () => {
      const withSmuggled = await createOwnerDraft({
        applicationYear: 2134,
        annualTotalKm: "12345.6",
        ...SMUGGLED,
      });
      const control = await createOwnerDraft({
        applicationYear: 2134,
        annualTotalKm: "12345.6",
      });

      // 採用面：annualTotalKm 確實入庫。
      const smuggledRow = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: withSmuggled.id as string },
      });
      const controlRow = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: control.id as string },
      });
      expect(smuggledRow.annualTotalKm?.equals(new Prisma.Decimal("12345.6"))).toBe(true);

      // 不採用面：DB 層逐欄與對照組全等（且皆為 null）。
      const fingerprint = (row: typeof smuggledRow) => ({
        applicationYear: row.applicationYear,
        annualTotalKm: row.annualTotalKm?.toFixed(1) ?? null,
        snapshotVehiclePrice: row.snapshotVehiclePrice?.toFixed(2) ?? null,
        snapshotUsefulLifeYears: row.snapshotUsefulLifeYears,
        snapshotAnnualDepreciation: row.snapshotAnnualDepreciation?.toFixed(2) ?? null,
        snapshotOfficialKm: row.snapshotOfficialKm?.toFixed(2) ?? null,
        snapshotAnnualTotalKm: row.snapshotAnnualTotalKm?.toFixed(1) ?? null,
        snapshotRatio: row.snapshotRatio?.toFixed(6) ?? null,
        snapshotRawAmount: row.snapshotRawAmount?.toFixed(4) ?? null,
        calculatedAt: row.calculatedAt,
        depreciationParameterVersionId: row.depreciationParameterVersionId,
        snapshotEstimatedAnnualKm: row.snapshotEstimatedAnnualKm,
        snapshotPerKmUnitPrice: row.snapshotPerKmUnitPrice?.toFixed(4) ?? null,
      });
      expect(fingerprint(smuggledRow)).toEqual(fingerprint(controlRow));

      const smuggledParent = await prisma.application.findUniqueOrThrow({
        where: { id: withSmuggled.id as string },
      });
      expect(smuggledParent.totalAmount).toBeNull();
      expect(smuggledParent.status).toBe("DRAFT");
    });

    it("AC-48(b)：PUT 同一請求之採用／不採用對照矩陣（DB 層指紋全等）", async () => {
      const target = await createOwnerDraft({ applicationYear: 2135 });
      const control = await createOwnerDraft({ applicationYear: 2135 });

      expect(
        (
          await putDraft(ownerCookie, target.id as string, {
            annualTotalKm: "23456.7",
            ...SMUGGLED,
          })
        ).statusCode
      ).toBe(200);
      expect(
        (await putDraft(ownerCookie, control.id as string, { annualTotalKm: "23456.7" })).statusCode
      ).toBe(200);

      const targetRow = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: target.id as string },
      });
      const controlRow = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: control.id as string },
      });
      expect(targetRow.annualTotalKm?.equals(new Prisma.Decimal("23456.7"))).toBe(true);
      expect(targetRow.snapshotOfficialKm).toBeNull();
      expect(targetRow.snapshotAnnualTotalKm).toBeNull();
      expect(targetRow.snapshotRatio).toBeNull();
      expect(targetRow.snapshotAnnualDepreciation).toBeNull();
      expect(targetRow.snapshotRawAmount).toBeNull();
      expect(targetRow.snapshotPerKmUnitPrice).toBeNull();
      // 對照組（未夾帶）之全欄指紋與夾帶組逐位元相同——`applicationId` 為兩列
      // 之天然差異，故排除後比較其餘所有欄位（不逐欄列舉，避免將來新增欄位時
      // 漏掉）。
      const fingerprintOf = (row: Record<string, unknown>) =>
        Object.entries(row)
          .filter(([key]) => key !== "applicationId")
          .map(([key, value]) => [key, value === null ? null : String(value)])
          .sort();
      expect(fingerprintOf(targetRow)).toEqual(fingerprintOf(controlRow));

      const parent = await prisma.application.findUniqueOrThrow({
        where: { id: target.id as string },
      });
      expect(parent.totalAmount).toBeNull();
    });
  });

  // ===========================================================================
  // §20.6 DTO 鍵集封閉（三型 DTO；R5 Done When 逐字）
  // ===========================================================================

  describe("§20.6 DTO 鍵集封閉：三型 DTO 皆不外露車價／年限／預估年里程／版本 id", () => {
    it("DepreciationApplicationDto 之鍵集全等於 §20.6 宣告（含新增之 annualTotalKm）", async () => {
      const application = await createOwnerDraft({
        applicationYear: 2136,
        annualTotalKm: "16000.0",
      });
      expect(Object.keys(application).sort()).toEqual(
        [
          "id",
          "type",
          "status",
          "ownerId",
          "ownerDisplayName",
          "createdById",
          "onBehalf",
          "primaryDate",
          "createdAt",
          "updatedAt",
          "applicationYear",
          "annualTotalKm",
          "duplicateYearNotice",
          "attachments",
          "completionBlockers",
          "computed",
          "snapshot",
          "void", // PHASE-009-T3b-LITE（§7.2，Spec Gate 已批准之 AC；三型 DTO 受控擴充）
        ].sort()
      );
      for (const forbidden of [
        "vehiclePrice",
        "usefulLifeYears",
        "estimatedAnnualKm",
        "depreciationParameterVersionId",
      ]) {
        expect(application).not.toHaveProperty(forbidden);
      }
    });

    it("DepreciationSnapshotDto 之鍵集全等於 §20.6 宣告（車價／年限／版本 id 不在其中）", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2137, annualTotalKm: "16000.0" });
      await markCompleted(draft.id as string);
      await prisma.depreciationApplication.update({
        where: { applicationId: draft.id as string },
        data: {
          snapshotVehiclePrice: "600000.00",
          snapshotUsefulLifeYears: 5,
          snapshotAnnualDepreciation: "120000.00",
          snapshotOfficialKm: "800.00",
          snapshotAnnualTotalKm: "16000.0",
          snapshotRatio: "0.050000",
          snapshotRawAmount: "6000.0000",
          calculatedAt: new Date("2026-03-04T05:06:07.000Z"),
          depreciationParameterVersionId: "p7r5-version-id",
        },
      });
      const resp = await getDraft(ownerCookie, draft.id as string);
      expect(resp.statusCode).toBe(200);
      const snapshot = resp.json<{ application: { snapshot: Record<string, unknown> } }>()
        .application.snapshot;
      expect(Object.keys(snapshot).sort()).toEqual(
        [
          "model",
          "annualDepreciation",
          "annualTotalKm",
          "ratio",
          "ratioPercent",
          "perKmUnitPrice",
          "officialKm",
          "rawAmount",
          "totalAmount",
          "calculatedAt",
        ].sort()
      );
    });
  });

  // ===========================================================================
  // AC-04 — 僅 DRAFT 可改；COMPLETED → 403（外層 ＋ 交易內二次守門）
  //         ＋ attachmentIds[] 對帳於同一交易內完成
  // ===========================================================================

  describe("AC-04: PUT rejects COMPLETED at both the outer guard and inside the transaction (FOR UPDATE re-check)", () => {
    it("本人 PUT 已完成申請 → 403，訊息逐字為「已完成的申請不可修改，請建立修正版」，DB 不變", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2021 });
      await markCompleted(draft.id as string);

      const resp = await putDraft(ownerCookie, draft.id as string, { applicationYear: 2022 });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toBe("已完成的申請不可修改，請建立修正版");

      const child = await prisma.depreciationApplication.findUnique({
        where: { applicationId: draft.id as string },
      });
      expect(child?.applicationYear).toBe(2021);
    });

    it("本人 PUT 已完成申請＋畸形 body → 仍為 403（狀態機守門先於 400 格式驗證）", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2021 });
      await markCompleted(draft.id as string);

      const resp = await putDraft(ownerCookie, draft.id as string, {
        applicationYear: "definitely-not-a-year",
      });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toBe("已完成的申請不可修改，請建立修正版");
    });

    it("交易內二次守門（M-2）：繞過路由層外層檢查直接呼叫 service → 仍 403", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2021 });
      await markCompleted(draft.id as string);

      // 模擬「外層檢查通過後、交易開啟前該申請才被完成」之 TOCTOU 競態：
      // 直接呼叫 service（外層 assertApplicationMutable 完全未執行），交易內
      // `FOR UPDATE` 後之新鮮讀取必須再擋一次。
      // T4 即審 AR-3：不只斷言「有拋 AppError」——釘住 403 FORBIDDEN 與逐字
      // 訊息，否則任何其他 AppError（例如 404／503）都會讓本測試恆綠。
      const error = await updateDepreciationDraft(prisma, draft.id as string, {
        applicationYear: 2099,
      }).then(
        () => null,
        (err: unknown) => err
      );
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.httpStatus).toBe(403);
      expect(appError.code).toBe("FORBIDDEN");
      expect(appError.userMessage).toBe("已完成的申請不可修改，請建立修正版");

      const child = await prisma.depreciationApplication.findUnique({
        where: { applicationId: draft.id as string },
      });
      expect(child?.applicationYear).toBe(2021);
    });

    it("attachmentIds[] 對帳：關聯 → 顯示於 DTO；改為 [] → 全部 detach 回 TEMP", async () => {
      // PHASE-007-R5：年度總里程一併播種——第一段（第 1、2 碼）全通過才會推進
      // 到第二段，本條之鑑別力（「兩段式確實推進」）因此得以保留。
      const draft = await createOwnerDraft({ applicationYear: 2025, annualTotalKm: 20000 });
      const a1 = await createTempAttachment(ownerId);
      const a2 = await createTempAttachment(ownerId);

      const linkResp = await putDraft(ownerCookie, draft.id as string, { attachmentIds: [a1, a2] });
      expect(linkResp.statusCode).toBe(200);
      const linked = linkResp.json<{ application: Record<string, unknown> }>().application;
      expect((linked.attachments as { id: string }[]).map((a) => a.id).sort()).toEqual(
        [a1, a2].sort()
      );
      // §20.5 第一段全通過後即進入第二段（本檔未播種折舊參數版本，故第 4 碼
      // `PARAMETER_NOT_AVAILABLE` 出現）——**第 1、2 碼消失**這件事本身即為
      // 「第一段全通過」之證據。附件已與完成度脫鉤（AC-54(b)），故附件之
      // link／detach 對 blocker 清單零影響。
      const linkedCodes = (linked.completionBlockers as { code: string }[]).map((b) => b.code);
      expect(linkedCodes).toEqual(["PARAMETER_NOT_AVAILABLE"]);
      expect(linkedCodes).not.toContain("DEPRECIATION_ATTACHMENT_REQUIRED");
      expect(linkedCodes).not.toContain("YEAR_REQUIRED");
      expect(linkedCodes).not.toContain("ANNUAL_TOTAL_KM_REQUIRED");

      const rows = await prisma.attachment.findMany({ where: { id: { in: [a1, a2] } } });
      for (const row of rows) {
        expect(row.status).toBe("LINKED");
        expect(row.refType).toBe("DEPRECIATION");
        expect(row.refId).toBe(draft.id);
      }

      const detachResp = await putDraft(ownerCookie, draft.id as string, { attachmentIds: [] });
      expect(detachResp.statusCode).toBe(200);
      expect(
        detachResp.json<{ application: Record<string, unknown> }>().application.attachments
      ).toEqual([]);
      const afterRows = await prisma.attachment.findMany({ where: { id: { in: [a1, a2] } } });
      for (const row of afterRows) {
        expect(row.status).toBe("TEMP");
        expect(row.refType).toBeNull();
        expect(row.refId).toBeNull();
      }
    });

    it("attachmentIds[] 含不存在之 id → 404 且整份 PUT 回滾（年度欄位不變）", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      const resp = await putDraft(ownerCookie, draft.id as string, {
        applicationYear: 2026,
        attachmentIds: ["p7t4-no-such-attachment"],
      });
      expect(resp.statusCode).toBe(404);

      const child = await prisma.depreciationApplication.findUnique({
        where: { applicationId: draft.id as string },
      });
      expect(child?.applicationYear).toBe(2025);
    });

    // T4 即審 SF-1（mutant M13 之鑑別測試）：上一條只送「單一不存在 id」，
    // 404 於任何附件寫入之前就拋出，故即使對帳走的是**非交易** client 也不會
    // 留下痕跡——不具鑑別力。本條送「合法 id 在前、不存在 id 在後」之混合批次：
    // 合法附件先被 link，隨後第二個 id 才觸發 404。唯有對帳與業務欄位寫入處於
    // 同一交易，那次 link 才會被一併回滾。M13（reconcile 改用非交易 client）下，
    // 該合法附件會殘留為 LINKED 且指向一個已回滾的申請狀態（部分關聯損毀，
    // B-25 同類），本條必紅。
    it("attachmentIds[] 混合批次（合法 id ＋ 不存在 id）→ 404，且先前已 link 之合法附件一併回滾為 TEMP（AC-04「同一交易內完成」之鑑別測試）", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      const legit = await createTempAttachment(ownerId);

      const resp = await putDraft(ownerCookie, draft.id as string, {
        applicationYear: 2026,
        attachmentIds: [legit, "p7t4-no-such-attachment-mixed"],
      });
      expect(resp.statusCode).toBe(404);

      const row = await prisma.attachment.findUnique({ where: { id: legit } });
      expect(row?.status).toBe("TEMP");
      expect(row?.refType).toBeNull();
      expect(row?.refId).toBeNull();
      expect(row?.linkedAt).toBeNull();

      const child = await prisma.depreciationApplication.findUnique({
        where: { applicationId: draft.id as string },
      });
      expect(child?.applicationYear).toBe(2025);
    });

    it("attachmentIds key 缺席 → 不對帳（既有關聯不受影響）", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      const a1 = await createTempAttachment(ownerId);
      expect(
        (await putDraft(ownerCookie, draft.id as string, { attachmentIds: [a1] })).statusCode
      ).toBe(200);

      const resp = await putDraft(ownerCookie, draft.id as string, { applicationYear: 2026 });
      expect(resp.statusCode).toBe(200);
      const row = await prisma.attachment.findUnique({ where: { id: a1 } });
      expect(row?.status).toBe("LINKED");
      expect(row?.refId).toBe(draft.id);
    });
  });

  // ===========================================================================
  // AC-05 — GET / DELETE
  // ===========================================================================

  describe("AC-05: GET returns blockers+computed for DRAFT and snapshot for COMPLETED; DELETE detaches DEPRECIATION attachments in the same transaction; wrong-type id is 404", () => {
    it("GET DRAFT → 200，completionBlockers 非 null、snapshot 為 null", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025, annualTotalKm: 20000 });
      const resp = await getDraft(ownerCookie, draft.id as string);
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: Record<string, unknown> }>().application;
      expect(application.status).toBe("DRAFT");
      expect(application.completionBlockers).not.toBeNull();
      expect(application.snapshot).toBeNull();
      // PHASE-007-R5（§20.6）：`DepreciationComputedDto` 之修訂後鍵集——
      // 新增 `annualDepreciation`／`annualTotalKm`／`ratio`／`ratioPercent`，
      // **移除** `perKmUnitPrice`（舊模型之每公里單價已退出申請計算，裁定①）。
      // 本檔未播種折舊參數版本，故此處為「查無有效參數」之情境：
      // `calculable=false` ＋ 第 4 碼，年度里程仍如實回報（本檔亦無差旅）。
      const computed = application.computed as Record<string, unknown> | null;
      expect(computed).not.toBeNull();
      expect(Object.keys(computed ?? {}).sort()).toEqual(
        [
          "amount",
          "annualDepreciation",
          "annualTotalKm",
          "blockingCodes",
          "calculable",
          "officialApplicationCount",
          "officialKm",
          "ratio",
          "ratioPercent",
          "rawAmount",
        ].sort()
      );
      expect(computed).not.toHaveProperty("perKmUnitPrice");
      expect(computed?.calculable).toBe(false);
      expect(computed?.blockingCodes).toEqual(["PARAMETER_NOT_AVAILABLE"]);
      expect(computed?.officialKm).toBe("0.00");
      expect(computed?.officialApplicationCount).toBe(0);
      // 申請資料原樣回傳（1 位小數字串，§20.6）。
      expect(computed?.annualTotalKm).toBe("20000.0");
      expect(computed?.annualDepreciation).toBeNull();
      // §16 D8(a)／§20.6 揭露面不變式：推導三值與版本 id 一律不外露。
      for (const forbidden of [
        "vehiclePrice",
        "usefulLifeYears",
        "estimatedAnnualKm",
        "depreciationParameterVersionId",
      ]) {
        expect(computed ?? {}).not.toHaveProperty(forbidden);
      }
    });

    it("GET COMPLETED（新模型快照欄已寫入）→ 200，snapshot 非 null（model=CURRENT）、completionBlockers 為 null", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025, annualTotalKm: 20000 });
      await markCompleted(draft.id as string);
      // 快照欄之正式寫入屬 R7；此處以合成值直寫，只驗 DTO 之讀取映射（§20.6）。
      await prisma.depreciationApplication.update({
        where: { applicationId: draft.id as string },
        data: {
          snapshotVehiclePrice: "600000.00",
          snapshotUsefulLifeYears: 5,
          snapshotAnnualDepreciation: "120000.00",
          snapshotOfficialKm: "1000.00",
          snapshotAnnualTotalKm: "20000.0",
          snapshotRatio: "0.050000",
          snapshotRawAmount: "6000.0000",
          calculatedAt: new Date("2026-01-02T03:04:05.000Z"),
        },
      });

      const resp = await getDraft(ownerCookie, draft.id as string);
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: Record<string, unknown> }>().application;
      expect(application.status).toBe("COMPLETED");
      expect(application.completionBlockers).toBeNull();
      // §20.6 逐字：`COMPLETED` 之 `computed` 為 `null`（已完成之數字一律取自
      // 快照，讀取路徑零重算）。
      expect(application.computed).toBeNull();
      // §20.6 `DepreciationSnapshotDto` 修訂後形狀；AC-56(a)：
      // `snapshotAnnualTotalKm != null` ⇒ 新模型（`model="CURRENT"`），舊模型欄
      // （`perKmUnitPrice`）為 null。
      expect(application.snapshot).toEqual({
        model: "CURRENT",
        annualDepreciation: "120000.00",
        annualTotalKm: "20000.0",
        ratio: "0.050000",
        ratioPercent: "5.0000",
        perKmUnitPrice: null,
        officialKm: "1000.00",
        rawAmount: "6000.0000",
        totalAmount: 5000,
        calculatedAt: "2026-01-02T03:04:05.000Z",
      });
    });

    it("GET COMPLETED（舊模型列）→ snapshot.model=LEGACY，perKmUnitPrice 為原值、新模型四欄為 null（AC-56(a)(c)）", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      await markCompleted(draft.id as string);
      await prisma.depreciationApplication.update({
        where: { applicationId: draft.id as string },
        data: {
          snapshotVehiclePrice: "600000.00",
          snapshotUsefulLifeYears: 5,
          snapshotEstimatedAnnualKm: 20000,
          snapshotPerKmUnitPrice: "6.0000",
          snapshotOfficialKm: "1000.00",
          snapshotRawAmount: "6000.0000",
          calculatedAt: new Date("2026-01-02T03:04:05.000Z"),
        },
      });

      const resp = await getDraft(ownerCookie, draft.id as string);
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: Record<string, unknown> }>().application;
      // 舊模型列一律以快照原值呈現、不得以新模型重算（BE-US-14 第 3 條逐字）。
      expect(application.snapshot).toEqual({
        model: "LEGACY",
        annualDepreciation: null,
        annualTotalKm: null,
        ratio: null,
        ratioPercent: null,
        perKmUnitPrice: "6.0000",
        officialKm: "1000.00",
        rawAmount: "6000.0000",
        totalAmount: 5000,
        calculatedAt: "2026-01-02T03:04:05.000Z",
      });
    });

    it("§16 D8／§20.6 揭露面不變式：DTO 之 snapshot 不外露 vehiclePrice／usefulLifeYears／estimatedAnnualKm／版本 id", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025, annualTotalKm: 18000 });
      await markCompleted(draft.id as string);
      await prisma.depreciationApplication.update({
        where: { applicationId: draft.id as string },
        data: {
          snapshotVehiclePrice: "777777.77",
          snapshotUsefulLifeYears: 7,
          snapshotAnnualDepreciation: "111111.11",
          snapshotOfficialKm: "1234.56",
          snapshotAnnualTotalKm: "18000.0",
          snapshotRatio: "0.068586",
          snapshotRawAmount: "8077.7345",
          calculatedAt: new Date("2026-02-03T00:00:00.000Z"),
          depreciationParameterVersionId: "p7t4-version-id",
        },
      });

      const resp = await getDraft(ownerCookie, draft.id as string);
      expect(resp.statusCode).toBe(200);
      const raw = JSON.stringify(resp.json());
      expect(raw).not.toContain("777777.77");
      expect(raw).not.toContain("vehiclePrice");
      // Q6：`usefulLifeYears` 之遮蔽已固化為契約（每年折舊費用 × 年限 ＝ 車價）。
      expect(raw).not.toContain("usefulLifeYears");
      expect(raw).not.toContain("estimatedAnnualKm");
      expect(raw).not.toContain("p7t4-version-id");
    });

    it("status=COMPLETED 但快照欄仍全 null → GET 200 且 snapshot 為 null（不 500）", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      await markCompleted(draft.id as string);
      const resp = await getDraft(ownerCookie, draft.id as string);
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: Record<string, unknown> }>().application;
      expect(application.status).toBe("COMPLETED");
      expect(application.snapshot).toBeNull();
    });

    it("DELETE 折舊草稿 → 200，父列刪除、子列連帶刪除，且附件於同一交易內 detach 回 TEMP", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      const a1 = await createTempAttachment(ownerId);
      const a2 = await createTempAttachment(ownerId);
      expect(
        (await putDraft(ownerCookie, draft.id as string, { attachmentIds: [a1, a2] })).statusCode
      ).toBe(200);

      const resp = await deleteApplicationHttp(ownerCookie, draft.id as string);
      expect(resp.statusCode).toBe(200);
      expect(resp.json<{ ok: boolean }>().ok).toBe(true);

      expect(await prisma.application.findUnique({ where: { id: draft.id as string } })).toBeNull();
      expect(
        await prisma.depreciationApplication.findUnique({
          where: { applicationId: draft.id as string },
        })
      ).toBeNull();

      // B-25 補洞：不得留下指向已刪除申請之孤兒 LINKED 附件。
      const rows = await prisma.attachment.findMany({ where: { id: { in: [a1, a2] } } });
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.status).toBe("TEMP");
        expect(row.refType).toBeNull();
        expect(row.refId).toBeNull();
      }
    });

    it("DELETE 已完成折舊 → 403，資料仍在", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      await markCompleted(draft.id as string);
      const resp = await deleteApplicationHttp(ownerCookie, draft.id as string);
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
      const still = await prisma.application.findUnique({ where: { id: draft.id as string } });
      expect(still?.status).toBe("COMPLETED");
    });

    it("不存在之 id → GET/PUT 404；DELETE 404", async () => {
      expect((await getDraft(ownerCookie, NONEXISTENT_ID)).statusCode).toBe(404);
      expect(
        (await putDraft(ownerCookie, NONEXISTENT_ID, { applicationYear: 2025 })).statusCode
      ).toBe(404);
      expect((await deleteApplicationHttp(ownerCookie, NONEXISTENT_ID)).statusCode).toBe(404);
    });

    it("型別不符之 id（TRAVEL 申請）→ GET/PUT 404，且回應不洩漏其型別", async () => {
      const travelResp = await app.inject({
        method: "POST",
        url: "/applications/travel",
        headers: { cookie: ownerCookie },
        payload: {},
      });
      expect(travelResp.statusCode).toBe(201);
      const travelId = travelResp.json<{ application: { id: string } }>().application.id;
      track(travelId);

      const getResp = await getDraft(ownerCookie, travelId);
      expect(getResp.statusCode).toBe(404);
      expect(JSON.stringify(getResp.json())).not.toContain("TRAVEL");

      const putResp = await putDraft(ownerCookie, travelId, { applicationYear: 2025 });
      expect(putResp.statusCode).toBe(404);
      expect(JSON.stringify(putResp.json())).not.toContain("TRAVEL");
    });

    it("既有 TRAVEL／MAINTENANCE 之 DELETE detach 行為零回歸（折舊分支不影響他型）", async () => {
      const maintResp = await app.inject({
        method: "POST",
        url: "/applications/maintenance",
        headers: { cookie: ownerCookie },
        payload: {},
      });
      expect(maintResp.statusCode).toBe(201);
      const maintId = maintResp.json<{ application: { id: string } }>().application.id;
      track(maintId);

      const a1 = await createTempAttachment(ownerId);
      const linkResp = await app.inject({
        method: "PUT",
        url: `/applications/maintenance/${maintId}`,
        headers: { cookie: ownerCookie },
        payload: { attachmentIds: [a1] },
      });
      expect(linkResp.statusCode).toBe(200);

      expect((await deleteApplicationHttp(ownerCookie, maintId)).statusCode).toBe(200);
      const row = await prisma.attachment.findUnique({ where: { id: a1 } });
      expect(row?.status).toBe("TEMP");
      expect(row?.refType).toBeNull();
    });
  });

  // ===========================================================================
  // §6.1 授權矩陣（第 1~4 列）× 狀態 × body 之分層 gate table
  // ===========================================================================

  describe("§6.1 授權矩陣 — 身分 × 端點 gate table（草稿四端點）", () => {
    it("未登入 → POST/GET/PUT/DELETE 皆 401", async () => {
      const draft = await createOwnerDraft({});
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/applications/depreciation",
            payload: {},
          })
        ).statusCode
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/applications/depreciation/${draft.id}`,
          })
        ).statusCode
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/applications/depreciation/${draft.id}`,
            payload: { applicationYear: 2025 },
          })
        ).statusCode
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/applications/${draft.id}`,
          })
        ).statusCode
      ).toBe(401);
    });

    it("mustChangePassword → POST/GET/PUT/DELETE 皆 403 PASSWORD_CHANGE_REQUIRED", async () => {
      const draft = await createOwnerDraft({});
      for (const resp of [
        await createDraft(mcpCookie, {}),
        await getDraft(mcpCookie, draft.id as string),
        await putDraft(mcpCookie, draft.id as string, { applicationYear: 2025 }),
        await deleteApplicationHttp(mcpCookie, draft.id as string),
      ]) {
        expect(resp.statusCode).toBe(403);
        expect(resp.json<{ error: { code: string } }>().error.code).toBe(
          "PASSWORD_CHANGE_REQUIRED"
        );
      }
    });

    it("一般使用者存取他人草稿 → GET/PUT/DELETE 皆 403 且不洩漏業務欄位", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });

      const getResp = await getDraft(otherCookie, draft.id as string);
      expect(getResp.statusCode).toBe(403);
      const getBody = getResp.json<Record<string, unknown>>();
      expect(getBody.application).toBeUndefined();
      expect(JSON.stringify(getBody)).not.toContain("2025");

      const putResp = await putDraft(otherCookie, draft.id as string, { applicationYear: 2026 });
      expect(putResp.statusCode).toBe(403);
      const child = await prisma.depreciationApplication.findUnique({
        where: { applicationId: draft.id as string },
      });
      expect(child?.applicationYear).toBe(2025);

      const delResp = await deleteApplicationHttp(otherCookie, draft.id as string);
      expect(delResp.statusCode).toBe(403);
      expect(
        await prisma.application.findUnique({ where: { id: draft.id as string } })
      ).not.toBeNull();
    });

    it("管理員 → GET/PUT 他人草稿 200；DELETE 他人草稿 200", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      expect((await getDraft(adminCookie, draft.id as string)).statusCode).toBe(200);
      expect(
        (await putDraft(adminCookie, draft.id as string, { applicationYear: 2026 })).statusCode
      ).toBe(200);

      const deletable = await createOwnerDraft({});
      expect((await deleteApplicationHttp(adminCookie, deletable.id as string)).statusCode).toBe(
        200
      );
    });

    it("管理員 PUT 他人已完成折舊 → 403（AD-US-08 第 3 條）", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      await markCompleted(draft.id as string);
      const resp = await putDraft(adminCookie, draft.id as string, { applicationYear: 2026 });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    });
  });

  // ===========================================================================
  // 判定順序：授權（403）先於格式驗證（400）——§6.1 明文，須有明文測試
  // ===========================================================================

  describe("判定順序：403 先於 400", () => {
    it("他人 PUT ＋ 畸形 body → 403 FORBIDDEN（不因 body 合法與否而改變）", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      const resp = await putDraft(otherCookie, draft.id as string, {
        applicationYear: "definitely-not-a-year",
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    });

    it("他人 PUT 已完成申請 ＋ 畸形 body → 403（授權 → 狀態機 → 格式，三層皆不得洩漏為 400）", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      await markCompleted(draft.id as string);
      const resp = await putDraft(otherCookie, draft.id as string, { applicationYear: 3000 });
      expect(resp.statusCode).toBe(403);
    });

    it("未登入 ＋ 畸形 body → 401（認證先於一切）", async () => {
      const draft = await createOwnerDraft({});
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/depreciation/${draft.id}`,
        payload: { applicationYear: "definitely-not-a-year" },
      });
      expect(resp.statusCode).toBe(401);
    });

    it("PCR ＋ 畸形 body → 403 PASSWORD_CHANGE_REQUIRED（非 400）", async () => {
      const resp = await createDraft(mcpCookie, { applicationYear: "definitely-not-a-year" });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    });
  });

  // ===========================================================================
  // 不採信請求體識別（§6.2 資料隔離不變式 1）
  // ===========================================================================

  describe("不採信請求體識別", () => {
    it("PUT body 夾帶 status／totalAmount／ownerId／createdById → 一律不採用（DB 層斷言）", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      const resp = await putDraft(ownerCookie, draft.id as string, {
        applicationYear: 2026,
        status: "COMPLETED",
        totalAmount: 999999,
        ownerId: otherId,
        createdById: otherId,
      });
      expect(resp.statusCode).toBe(200);
      const parent = await prisma.application.findUnique({ where: { id: draft.id as string } });
      expect(parent?.status).toBe("DRAFT");
      expect(parent?.totalAmount).toBeNull();
      expect(parent?.ownerId).toBe(ownerId);
      expect(parent?.createdById).toBe(ownerId);
    });

    it("PUT body 夾帶快照欄位（snapshotOfficialKm 等）→ 一律不採用", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      const resp = await putDraft(ownerCookie, draft.id as string, {
        snapshotOfficialKm: "99999.99",
        snapshotPerKmUnitPrice: "9.9999",
        snapshotRawAmount: "1.0000",
        calculatedAt: "2020-01-01T00:00:00.000Z",
      });
      expect(resp.statusCode).toBe(200);
      const child = await prisma.depreciationApplication.findUnique({
        where: { applicationId: draft.id as string },
      });
      expect(child?.snapshotOfficialKm).toBeNull();
      expect(child?.snapshotPerKmUnitPrice).toBeNull();
      expect(child?.snapshotRawAmount).toBeNull();
      expect(child?.calculatedAt).toBeNull();
    });
  });
});
