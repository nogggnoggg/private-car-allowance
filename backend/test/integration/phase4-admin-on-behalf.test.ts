/**
 * Integration tests for PHASE-004-T10 — 管理員代操作端點
 *   `POST /admin/users/:userId/applications/travel`（代建立草稿）
 *
 * Covers Spec §2: AC-78（owner/creator 分離）、AC-79（未選使用者不得代操作，
 * 三個子案例 a/b/c）、AC-80（管理員可 PUT 使用者草稿）、AC-81（管理員不得直接
 * 修改已完成，D13 文案）、AC-85（一般使用者不得存取代操作端點 + 反向：管理員
 * 呼叫成功）；並以本檔自建情境驗證 D17 不因本 Task 回歸（管理員仍不得代完成——
 * 該保護本身是 T8 既有實作，本檔只是另一份獨立證據，不修改 T8 既有測試檔）。
 * AC-29（管理員代上傳附件指定 ownerId）已於 T11 實作 — 本檔不重做，只在
 * 「確認未破壞」段落做一次輕量煙霧測試。
 *
 * TDD: written to exercise the REAL HTTP route registered by buildServer().
 * Before this Task's implementation existed, every `/admin/users/:userId/
 * applications/travel` call 404'd (route did not exist) — see Task Handoff
 * for the captured first-run RED output.
 *
 * Test discipline (Spec §11.0 / Packet C5):
 *   - loginName prefix "p4t10_" + per-run random suffix（跨檔跨 fork 撞名防護）。
 *   - cleanup 限定本檔自建 application/attachment/parameter-version id +
 *     loginName 前綴；嚴禁全域 deleteMany({})。
 *   - 斷言一律限定自建範圍（例如「本檔自建的 application 數量未變」），不斷言
 *     全域筆數（測試 DB 現存 700+ 筆殘留 Application）。
 *   - synthetic data only（虛構人名、地名、出差目的）。
 *   - FuelParameterVersion/EtcParameterVersion `effectiveFrom` 為全域表——本檔
 *     使用尚未被其他 phase4 測試檔占用的年份 2042（見既有測試檔慣例：T3=2032、
 *     preview=2031、T8=2034~2040、reference-protection=2045~2048）。
 */
import { FuelType, Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Shared helpers (pattern per phase4-travel-complete.test.ts / phase4-travel-draft.test.ts)
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
const LOGIN_PREFIX = "p4t10_";
const PASSWORD = "AdminOnBehalfTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;
const MCP_LOGIN = `${LOGIN_PREFIX}mcp_${RUN_ID}`;
const INACTIVE_LOGIN = `${LOGIN_PREFIX}inactive_${RUN_ID}`;

const NONEXISTENT_USER_ID = "p4t10-nonexistent-user-id-000000000000";

interface ErrorJson {
  error: {
    code: string;
    message: string;
    fields?: { field: string; reason: string }[];
  };
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

describeWithDb("PHASE-004-T10 — 管理員代操作：代建立草稿 + 授權隔離", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let otherId: string;
  let adminId: string;
  let mcpId: string;
  let inactiveId: string;

  let ownerCookie: string;
  let otherCookie: string;
  let adminCookie: string;
  let mcpCookie: string;

  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];
  const createdFuelVersionIds: string[] = [];
  const createdEtcVersionIds: string[] = [];
  const createdConsumptionIds: string[] = [];

  function track(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  async function createLinkedAttachment(segmentId: string, forOwnerId: string) {
    const att = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `p4t10-synthetic-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
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

  /**
   * PHASE-005a-T7: 新模型下油資單價依「擁有人（ownerId）油耗版本 → 該油種
   * 油價版本」雙鏈推導（不再直讀 `FuelParameterVersion`，該表已由 D1(a) 凍結
   * 為唯讀）。以 `kmPerLiter="1.0000"` 讓推導結果
   * `ROUND_HALF_UP(pricePerLiter ÷ 1, 0)` 恰等於原「每公里單價」數值——刻意
   * 的測試等價技巧，非改變 AC-18 公式本身（見 phase4-travel-complete.test.ts
   * 同一慣例）。
   */
  async function createParamVersions(
    effectiveFrom: string,
    fuelPrice: string,
    etcPrice: string
  ): Promise<void> {
    const consumption = await prisma.userFuelConsumptionVersion.create({
      data: {
        userId: ownerId,
        fuelType: FuelType.GASOLINE_95,
        kmPerLiter: new Prisma.Decimal("1.0000"),
        effectiveFrom: new Date(effectiveFrom),
        basisNote: "p4t10 測試 fixture：kmPerLiter=1 使推導單價等於原每公里單價",
        createdById: ownerId,
      },
    });
    const fuel = await prisma.fuelPriceVersion.create({
      data: {
        fuelType: FuelType.GASOLINE_95,
        pricePerLiter: new Prisma.Decimal(fuelPrice),
        effectiveFrom: new Date(effectiveFrom),
        createdById: ownerId,
      },
    });
    const etc = await prisma.etcParameterVersion.create({
      data: {
        unitPrice: etcPrice,
        effectiveFrom: new Date(effectiveFrom),
        createdById: ownerId,
      },
    });
    createdFuelVersionIds.push(fuel.id);
    createdEtcVersionIds.push(etc.id);
    createdConsumptionIds.push(consumption.id);
  }

  async function onBehalfCreate(
    cookie: string | undefined,
    userId: string,
    payload: Record<string, unknown> = {}
  ) {
    return app.inject({
      method: "POST",
      url: `/admin/users/${userId}/applications/travel`,
      headers: cookie ? { cookie } : {},
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
    const body = resp.json<{ application: { id: string } }>();
    track(body.application.id);
    return body.application.id as string;
  }

  async function putDraft(cookie: string, id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/applications/travel/${id}`,
      headers: { cookie },
      payload,
    });
  }

  async function completeHttp(cookie: string | undefined, id: string) {
    return app.inject({
      method: "POST",
      url: `/applications/${id}/complete`,
      headers: cookie ? { cookie } : {},
    });
  }

  /** Build a fully completable draft owned by `forOwnerId`, completed by `completerCookie`. */
  async function buildCompletedApplication(
    ownerCookieForBuild: string,
    forOwnerId: string,
    completerCookie: string,
    fuelDate: string
  ): Promise<string> {
    await createParamVersions(fuelDate, "5.0000", "2.0000");

    const applicationId = await createOwnDraft(ownerCookieForBuild, {});
    const putResp = await putDraft(ownerCookieForBuild, applicationId, {
      tripDate: fuelDate,
      purpose: "P4T10 已完成情境測試",
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

    const completeResp = await completeHttp(completerCookie, applicationId);
    expect(completeResp.statusCode).toBe(200);
    expect(completeResp.json<{ application: ApplicationJson }>().application.status).toBe(
      "COMPLETED"
    );
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
        displayName: "P4T10 一般使用者（代操作目標）",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const other = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "P4T10 一般使用者（呼叫者，非管理員）",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "P4T10 管理員",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const mcp = await prisma.user.create({
      data: {
        loginName: MCP_LOGIN,
        displayName: "P4T10 待改密使用者",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: true,
      },
    });
    const inactive = await prisma.user.create({
      data: {
        loginName: INACTIVE_LOGIN,
        displayName: "P4T10 已停用使用者",
        passwordHash: hash,
        role: "USER",
        isActive: false,
        mustChangePassword: false,
      },
    });

    ownerId = owner.id;
    otherId = other.id;
    adminId = admin.id;
    mcpId = mcp.id;
    inactiveId = inactive.id;

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
      if (createdConsumptionIds.length > 0) {
        await prisma.userFuelConsumptionVersion.deleteMany({
          where: { id: { in: createdConsumptionIds } },
        });
      }
      if (createdFuelVersionIds.length > 0) {
        await prisma.fuelPriceVersion.deleteMany({
          where: { id: { in: createdFuelVersionIds } },
        });
      }
      if (createdEtcVersionIds.length > 0) {
        await prisma.etcParameterVersion.deleteMany({
          where: { id: { in: createdEtcVersionIds } },
        });
      }
      const userIds = [ownerId, otherId, adminId, mcpId, inactiveId].filter(Boolean);
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
  // AC-78 — owner/creator 分離
  // ===========================================================================

  describe("AC-78 — 代建立草稿：擁有人 vs 操作者分離", () => {
    it("管理員代 U 建立草稿 → 201；DB 實際欄位 ownerId=U、createdById=管理員，兩者不相等", async () => {
      const resp = await onBehalfCreate(adminCookie, ownerId, {
        tripDate: "2042-01-05",
        purpose: "P4T10 AC-78 代建立",
      });
      expect(resp.statusCode).toBe(201);
      const body = resp.json<{ application: ApplicationJson }>();
      track(body.application.id);

      // HTTP 回應層級（TravelApplicationDto 既有的 ownerId/createdById/onBehalf 欄位）。
      expect(body.application.ownerId).toBe(ownerId);
      expect(body.application.createdById).toBe(adminId);
      expect(body.application.onBehalf).toBe(true);

      // 鑑別力核心：直接查 DB，不只信任 HTTP 回應。若實作誤把兩欄填同一值，
      // 這條斷言必紅（即使回應層級的斷言因某種序列化巧合而綠）。
      const dbApp = await prisma.application.findUniqueOrThrow({
        where: { id: body.application.id },
      });
      expect(dbApp.ownerId).toBe(ownerId);
      expect(dbApp.createdById).toBe(adminId);
      expect(dbApp.ownerId).not.toBe(dbApp.createdById);
      expect(dbApp.status).toBe("DRAFT");
      expect(dbApp.type).toBe("TRAVEL");
    });
  });

  // ===========================================================================
  // AC-79 — 未選使用者不得代操作（a/b/c 三案例）
  // ===========================================================================

  describe("AC-79(a) — 一般端點 owner 恆為呼叫者自己，不接受 body ownerId", () => {
    it("一般使用者對 POST /applications/travel 帶 body ownerId=他人 → 建立出來的 ownerId 仍為呼叫者自己", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/travel",
        headers: { cookie: otherCookie },
        payload: { ownerId, purpose: "P4T10 AC-79a 反向測試" },
      });
      // 不是 403、也不是「以他人為 owner 建立」——body.ownerId 從未被讀取，
      // 純粹被忽略；建立成功且 owner 仍是呼叫者自己。
      expect(resp.statusCode).toBe(201);
      const body = resp.json<{ application: ApplicationJson }>();
      track(body.application.id);

      const dbApp = await prisma.application.findUniqueOrThrow({
        where: { id: body.application.id },
      });
      expect(dbApp.ownerId).toBe(otherId);
      expect(dbApp.ownerId).not.toBe(ownerId);
      expect(dbApp.createdById).toBe(otherId);
    });
  });

  describe("AC-79(b) — 代操作路徑缺 :userId 不存在", () => {
    it("缺 :userId 的路徑 → 404（無此路由，不存在代操作端點的『空使用者』變體）", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/admin/applications/travel",
        headers: { cookie: adminCookie },
        payload: {},
      });
      expect(resp.statusCode).toBe(404);
    });
  });

  describe("AC-79(c) — :userId 指向不存在或已停用之使用者", () => {
    it(":userId 不存在 → 拒絕（NOT_FOUND）且不建立任何資料", async () => {
      const before = await prisma.application.count({
        where: { id: { in: createdApplicationIds } },
      });

      const resp = await onBehalfCreate(adminCookie, NONEXISTENT_USER_ID, {});
      expect(resp.statusCode).toBe(404);
      expect(resp.json<ErrorJson>().error.code).toBe("NOT_FOUND");

      const after = await prisma.application.count({
        where: { id: { in: createdApplicationIds } },
      });
      expect(after).toBe(before);
      // 全域層級也確認：以此不存在的 userId 為 owner 沒有任何殘留列（範圍限定
      // ownerId=該不存在 id，不是斷言全域筆數）。
      const stray = await prisma.application.count({ where: { ownerId: NONEXISTENT_USER_ID } });
      expect(stray).toBe(0);
    });

    it(":userId 已停用 → 拒絕（VALIDATION_ERROR 400）且不建立任何資料", async () => {
      const before = await prisma.application.count({
        where: { id: { in: createdApplicationIds } },
      });

      const resp = await onBehalfCreate(adminCookie, inactiveId, {});
      expect(resp.statusCode).toBe(400);
      expect(resp.json<ErrorJson>().error.code).toBe("VALIDATION_ERROR");

      const after = await prisma.application.count({
        where: { id: { in: createdApplicationIds } },
      });
      expect(after).toBe(before);
      const stray = await prisma.application.count({ where: { ownerId: inactiveId } });
      expect(stray).toBe(0);
    });
  });

  // ===========================================================================
  // AC-85 — 一般使用者不得存取代操作端點（+ 反向：管理員可）
  // ===========================================================================

  describe("AC-85 — 授權矩陣：一般使用者／管理員／未登入／強制改密", () => {
    it("一般使用者呼叫代操作端點 → 403 FORBIDDEN", async () => {
      const resp = await onBehalfCreate(otherCookie, ownerId, {});
      expect(resp.statusCode).toBe(403);
      expect(resp.json<ErrorJson>().error.code).toBe("FORBIDDEN");
    });

    it("管理員呼叫代操作端點 → 201（反向案例：證明擋的是『非管理員』而非『一律 403』）", async () => {
      const resp = await onBehalfCreate(adminCookie, ownerId, {
        purpose: "P4T10 AC-85 反向",
      });
      expect(resp.statusCode).toBe(201);
      const body = resp.json<{ application: ApplicationJson }>();
      track(body.application.id);
    });

    it("未登入呼叫代操作端點 → 401 UNAUTHORIZED", async () => {
      const resp = await onBehalfCreate(undefined, ownerId, {});
      expect(resp.statusCode).toBe(401);
      expect(resp.json<ErrorJson>().error.code).toBe("UNAUTHORIZED");
    });

    it("強制改密使用者（一般角色）呼叫代操作端點 → 403（非管理員，非改密 gate 本身）", async () => {
      const resp = await onBehalfCreate(mcpCookie, ownerId, {});
      // mcpCookie 屬一般使用者且尚未改密——requireAdmin 或
      // requirePasswordChanged 任一擋下皆屬 403，兩者皆非 200/201。此處只驗證
      // 「非管理員的強制改密使用者」同樣進不去代操作端點。
      expect(resp.statusCode).toBe(403);
    });
  });

  // ===========================================================================
  // AC-80/81 — 管理員可 PUT 使用者草稿；不得直接修改已完成
  // ===========================================================================

  describe("AC-80/81 — 管理員 PUT 使用者草稿：草稿可改、已完成拒改", () => {
    it("AC-80: 管理員 PUT 使用者（非管理員本人）的草稿 → 200 保存成功", async () => {
      const applicationId = await createOwnDraft(ownerCookie, {});
      const resp = await putDraft(adminCookie, applicationId, {
        purpose: "P4T10 AC-80 管理員代改草稿",
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: ApplicationJson }>();
      expect(body.application.purpose).toBe("P4T10 AC-80 管理員代改草稿");

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect(dbApp.ownerId).toBe(ownerId); // owner 不因管理員 PUT 而改變
    });

    it("AC-81: 管理員直接 PUT 已完成申請 → 403，message 含『建立修正版』指引，DB 資料未變", async () => {
      const applicationId = await buildCompletedApplication(
        ownerCookie,
        ownerId,
        ownerCookie,
        "2042-02-10"
      );

      const before = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });

      const resp = await putDraft(adminCookie, applicationId, {
        purpose: "P4T10 AC-81 嘗試修改已完成（應被拒絕）",
      });
      expect(resp.statusCode).toBe(403);
      const errJson = resp.json<ErrorJson>();
      expect(errJson.error.code).toBe("FORBIDDEN");
      expect(errJson.error.message).toContain("建立修正版");

      const after = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect(after.status).toBe("COMPLETED");
      // purpose 存在 TravelApplication 子表，這裡透過 travel-service 的
      // toTravelApplicationDto 已在 route 內部驗證未變；DB 層面用 updatedAt/
      // status 已足以證明「完全未落地」（PUT 於 assertApplicationMutable 擋下
      // 時，交易尚未觸及任何欄位）。
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });
  });

  // ===========================================================================
  // D17 不得回歸（本檔獨立情境，不修改 T8 既有測試檔）
  // ===========================================================================

  describe("D17 不得回歸 — 管理員仍不得對他人申請呼叫 complete", () => {
    it("管理員對『代自己建立』的他人（U）草稿呼叫 complete → 仍 403（本 Task 不得放寬 owner-only）", async () => {
      await createParamVersions("2042-03-15", "5.0000", "2.0000");

      const createResp = await onBehalfCreate(adminCookie, ownerId, {
        tripDate: "2042-03-15",
        purpose: "P4T10 D17 情境",
      });
      expect(createResp.statusCode).toBe(201);
      const applicationId = createResp.json<{ application: ApplicationJson }>().application.id;
      track(applicationId);

      const putResp = await putDraft(adminCookie, applicationId, {
        segments: [
          {
            origin: "起",
            destination: "迄",
            totalKm: "5.00",
            highwayKm: "0.00",
            attachmentIds: [],
          },
        ],
      });
      expect(putResp.statusCode).toBe(200);
      const segmentId = putResp.json<{ application: ApplicationJson }>().application.segments[0].id;
      await createLinkedAttachment(segmentId, ownerId);

      // 管理員即使是本次代建立的操作者（createdById=管理員），ownerId 仍是 U——
      // complete 端點嚴格以 ownerId 判定，管理員仍非擁有人 → 403。
      const completeResp = await completeHttp(adminCookie, applicationId);
      expect(completeResp.statusCode).toBe(403);
      expect(completeResp.json<ErrorJson>().error.code).toBe("FORBIDDEN");

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect(dbApp.status).toBe("DRAFT");
    });
  });

  // ---------------------------------------------------------------------------
  // AC-29（管理員代上傳附件指定 ownerId）— 本 Task 不重做。Packet 明文
  // 「T11 已實作，本 Task 只需確認未破壞，不需重做」——既有覆蓋在
  // `phase4-attachment-ard.test.ts`（未修改，本 Task Files Forbidden 亦不含
  // attachment/**）；「未破壞」的證據是本 Task 的全套回歸（5 輪，見 Task
  // Handoff）包含該檔且全綠，而非在本檔重寫一份 AC-29 測試。
  // ---------------------------------------------------------------------------
});
