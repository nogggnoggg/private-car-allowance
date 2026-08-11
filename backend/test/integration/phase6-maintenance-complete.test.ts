/**
 * Integration tests for PHASE-006-T7:
 *   完成流程 ＋ 快照寫入 ＋ 原子性 ＋ 僅本人授權。
 *
 * AC covered (PHASE-006 Spec §2): AC-25, AC-26, AC-27, AC-18（完成端點整合層）；
 * B-30（完成 vs 刪除附件之併發）；§7.4 完成拒絕形狀（400 VALIDATION_ERROR +
 * fields[] + details.blockers[] 永遠完整清單）。
 *
 * PHASE-011-T1 更正（依 `docs/specs/PHASE-011.md` AC-01／D1=(a)）：B-30
 * 迴圈之允許拒絕碼集合擴充為 [400, 403, 409, 503]（503 為重試耗盡之既有合
 * 法契約，非缺陷）；新增第三分支終局斷言（見 `assertB30RoundOutcome`）與
 * 其 mutant 自證 it。零 `backend/src` 變更。
 *
 * TDD: written BEFORE `completeMaintenanceApplication`/`POST
 * /applications/:id/complete` 之 MAINTENANCE 分派存在——第一輪預期為紅
 * （complete 端點對 MAINTENANCE id 現況回 404，snapshot 恆為 null）。見 Task
 * Handoff 之 RED 輸出。
 *
 * AC-25 原子性鑑別力（沿 `phase4-travel-complete.test.ts` 之
 * `__testOnlyFailAfterSnapshotWrite` 既有做法）：本檔直接 import
 * `completeMaintenanceApplication`，以注入的失敗切點證明「快照寫入」與
 * 「狀態轉換」同屬一個交易——任一方失敗，兩者皆不落地。
 *
 * Test discipline (Spec §11.0 / Packet):
 *   - loginName prefix "p6t7_" + per-run random suffix.
 *   - cleanup scoped to this suite's own tracked application/attachment ids +
 *     loginName prefix; NEVER deleteMany({}) globally.
 *   - synthetic data only.
 *   - 金額類斷言一律精確等值（Spec §2 逐字要求），不使用近似比較。
 */
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { completeMaintenanceApplication } from "../../src/applications/maintenance-service.js";
import { hashPassword } from "../../src/auth/password.js";
import * as mileageEngine from "../../src/mileage/mileage-engine.js";
import { buildServer } from "../../src/server.js";

// T7R S-3 突變自證（mutant M6）：包裝真實實作為 spy，行為不變，只加可觀測性
// ——沿 `phase6-official-mileage.test.ts` 之既有慣例（見該檔檔頭說明）。
vi.mock("../../src/mileage/mileage-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mileage/mileage-engine.js")>();
  return {
    ...actual,
    sumOfficialMileage: vi.fn(actual.sumOfficialMileage),
  };
});

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
const LOGIN_PREFIX = "p6t7_";
const PASSWORD = "MaintenanceCompleteTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;
const MCP_LOGIN = `${LOGIN_PREFIX}mcp_${RUN_ID}`;

interface MaintenanceApplicationJson {
  id: string;
  status: string;
  totalAmount?: number | null;
  snapshot: {
    intervalKm: string;
    officialKm: string;
    ratio: string;
    ratioPercent: string;
    actualCost: string;
    rawAmount: string;
    totalAmount: number;
    calculatedAt: string;
  } | null;
  completionBlockers: Array<{ code: string; field?: string; message: string }> | null;
}

describeWithDb("PHASE-006-T7 — 完成流程 + 快照寫入 + 原子性 + 僅本人授權", () => {
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
        displayName: "P6T7 擁有人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const other = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "P6T7 他人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "P6T7 管理員",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const mcp = await prisma.user.create({
      data: {
        loginName: MCP_LOGIN,
        displayName: "P6T7 待改密使用者",
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
      }
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
  });

  // ===========================================================================
  // Fixture helpers
  // ===========================================================================

  async function createDraft(cookie: string): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/maintenance",
      headers: { cookie },
      payload: {},
    });
    expect(resp.statusCode).toBe(201);
    const id = resp.json<{ application: { id: string } }>().application.id;
    trackApp(id);
    return id;
  }

  async function putFields(cookie: string, id: string, fields: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/applications/maintenance/${id}`,
      headers: { cookie },
      payload: fields,
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

  /** 直接建立一筆已完成之 TRAVEL 申請（供期間公務里程之分子）。 */
  async function seedCompletedTravel(opts: {
    tripDate: string;
    segments: Array<{ totalKm: string; highwayKm: string }>;
  }): Promise<string> {
    const snapshotTotalKm = opts.segments
      .reduce((acc, seg) => acc.plus(new Prisma.Decimal(seg.totalKm)), new Prisma.Decimal("0"))
      .toFixed(2);
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date(opts.tripDate),
        completedAt: new Date(),
        totalAmount: 1,
        travel: {
          create: {
            tripDate: new Date(opts.tripDate),
            purpose: "P6T7 合成差旅（供期間公務里程分子）",
            snapshotTotalKm,
          },
        },
      },
      include: { travel: true },
    });
    trackApp(application.id);
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
    return application.id;
  }

  /** 建立一筆完成度已齊備（可完成）之保養草稿：五欄 + N 張附件。 */
  async function buildCompletableDraft(opts: {
    cookie?: string;
    lastMaintenanceDate: string;
    currentMaintenanceDate: string;
    lastOdometerKm: string;
    currentOdometerKm: string;
    actualCost: string;
    attachmentCount?: number;
  }): Promise<string> {
    const cookie = opts.cookie ?? ownerCookie;
    const id = await createDraft(cookie);
    const putResp = await putFields(cookie, id, {
      lastMaintenanceDate: opts.lastMaintenanceDate,
      currentMaintenanceDate: opts.currentMaintenanceDate,
      lastOdometerKm: opts.lastOdometerKm,
      currentOdometerKm: opts.currentOdometerKm,
      actualCost: opts.actualCost,
    });
    expect(putResp.statusCode).toBe(200);

    const attachmentCount = opts.attachmentCount ?? 1;
    if (attachmentCount > 0) {
      const ids: string[] = [];
      for (let i = 0; i < attachmentCount; i++) {
        ids.push(await uploadTemp(cookie, `p6t7-${i}.jpg`));
      }
      const linkResp = await putFields(cookie, id, { attachmentIds: ids });
      expect(linkResp.statusCode).toBe(200);
    }
    return id;
  }

  async function completeHttp(cookie: string, id: string) {
    return app.inject({
      method: "POST",
      url: `/applications/${id}/complete`,
      headers: { cookie },
    });
  }

  async function getApp(cookie: string, id: string) {
    return app.inject({
      method: "GET",
      url: `/applications/maintenance/${id}`,
      headers: { cookie },
    });
  }

  // ===========================================================================
  // AC-25/AC-26 — 完成成功全鏈 + 快照齊備 + 雙重可重現性
  // ===========================================================================

  describe("AC-25/AC-26 完成成功 > 快照齊備且可雙重重現", () => {
    it("五欄齊備 + 1 張附件 + 期間內一筆已完成差旅 → 200，snapshot 五項 + rawAmount + calculatedAt 齊備，且由三項來源值重算精確重現 rawAmount 與最終金額", async () => {
      await seedCompletedTravel({
        tripDate: "2050-01-15",
        segments: [{ totalKm: "40.00", highwayKm: "10.00" }],
      });

      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2050-01-01",
        currentMaintenanceDate: "2050-02-01",
        lastOdometerKm: "1000.00",
        currentOdometerKm: "1100.00", // intervalKm = 100.00
        actualCost: "1000.00",
      });

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: MaintenanceApplicationJson }>().application;

      expect(application.status).toBe("COMPLETED");
      const snapshot = application.snapshot;
      expect(snapshot).not.toBeNull();
      expect(snapshot?.intervalKm).toBe("100.00");
      expect(snapshot?.officialKm).toBe("40.00"); // highwayKm 不重複加總
      expect(snapshot?.ratio).toBe("0.400000");
      expect(snapshot?.ratioPercent).toBe("40.0000");
      expect(snapshot?.actualCost).toBe("1000.00");
      expect(snapshot?.rawAmount).toBe("400.0000"); // 1000*40/100 = 400 恰整
      expect(snapshot?.totalAmount).toBe(400);
      expect(snapshot?.calculatedAt).toBeTruthy();
      expect(application.completionBlockers).toBeNull();

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.totalAmount).toBe(400);
      expect(dbApp.completedAt).not.toBeNull();

      // 雙重可重現性（AC-26）：由快照三項來源值（實際費用、公務里程、區間里程）
      // 精確重算 rawAmount 與最終金額。
      const recomputedRaw = new Prisma.Decimal(snapshot?.actualCost as string)
        .times(new Prisma.Decimal(snapshot?.officialKm as string))
        .div(new Prisma.Decimal(snapshot?.intervalKm as string));
      expect(recomputedRaw.toFixed(4)).toBe(snapshot?.rawAmount);
      const recomputedAmount = recomputedRaw
        .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
        .toNumber();
      expect(recomputedAmount).toBe(snapshot?.totalAmount);

      // 完成後讀取不再出現 completionBlockers/computed（DRAFT 才有）。
      const getResp = await getApp(ownerCookie, id);
      expect(getResp.statusCode).toBe(200);
      const readBack = getResp.json<{ application: MaintenanceApplicationJson }>().application;
      expect(readBack.completionBlockers).toBeNull();
      expect(readBack.snapshot?.totalAmount).toBe(400);

      // 狀態機守門（mutant witness）：對已完成之申請再次呼叫完成 → 403，
      // 快照與 totalAmount 逐位元不變（不得雙重完成、不得覆寫快照）。
      const secondCompleteResp = await completeHttp(ownerCookie, id);
      expect(secondCompleteResp.statusCode).toBe(403);
      const dbAppAfterSecond = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbAppAfterSecond.totalAmount).toBe(400);
    });
  });

  // ===========================================================================
  // AC-25 — 原子性（交易切點回滾）
  // ===========================================================================

  describe("AC-25 原子性 — 交易切點回滾", () => {
    it("快照寫入後、狀態轉換前注入失敗 → status 仍 DRAFT，全部快照欄位仍為 null", async () => {
      await seedCompletedTravel({
        tripDate: "2051-01-15",
        segments: [{ totalKm: "10.00", highwayKm: "0.00" }],
      });
      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2051-01-01",
        currentMaintenanceDate: "2051-02-01",
        lastOdometerKm: "500.00",
        currentOdometerKm: "600.00",
        actualCost: "200.00",
      });

      const injectedMessage = "PHASE-006-T7-INJECTED-ATOMICITY-TEST-FAILURE";
      await expect(
        completeMaintenanceApplication(prisma, id, {
          __testOnlyFailAfterSnapshotWrite: () => {
            throw new Error(injectedMessage);
          },
        })
      ).rejects.toThrow(injectedMessage);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.status).toBe("DRAFT");
      expect(dbApp.totalAmount).toBeNull();
      expect(dbApp.completedAt).toBeNull();

      const dbMaintenance = await prisma.maintenanceApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      expect(dbMaintenance.snapshotIntervalKm).toBeNull();
      expect(dbMaintenance.snapshotOfficialKm).toBeNull();
      expect(dbMaintenance.snapshotRatio).toBeNull();
      expect(dbMaintenance.snapshotRawAmount).toBeNull();
      expect(dbMaintenance.calculatedAt).toBeNull();
    });

    it("反向：不注入失敗（正常呼叫 completeMaintenanceApplication）→ 全部正確落地", async () => {
      await seedCompletedTravel({
        tripDate: "2051-03-15",
        segments: [{ totalKm: "20.00", highwayKm: "0.00" }],
      });
      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2051-03-01",
        currentMaintenanceDate: "2051-04-01",
        lastOdometerKm: "700.00",
        currentOdometerKm: "800.00",
        actualCost: "300.00",
      });

      const record = await completeMaintenanceApplication(prisma, id);
      expect(record.status).toBe("COMPLETED");
      expect(record.totalAmount).toBe(60); // 300*20/100=60
      expect(record.completedAt).not.toBeNull();
      expect(record.maintenance?.snapshotIntervalKm?.toString()).toBe("100");
      expect(record.maintenance?.snapshotOfficialKm?.toString()).toBe("20");
    });
  });

  // ===========================================================================
  // AC-27 — 完成僅本人（管理員代完成 403，DB 零寫入；本人成功對照）
  // ===========================================================================

  describe("AC-27 完成僅本人", () => {
    it("管理員（非擁有人）完成他人保養草稿 → 403 FORBIDDEN，DB 零寫入", async () => {
      await seedCompletedTravel({
        tripDate: "2052-01-15",
        segments: [{ totalKm: "10.00", highwayKm: "0.00" }],
      });
      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2052-01-01",
        currentMaintenanceDate: "2052-02-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "100.00",
        actualCost: "500.00",
      });

      const before = await prisma.application.findUniqueOrThrow({ where: { id } });

      const resp = await completeHttp(adminCookie, id);
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");

      const after = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe("DRAFT");
      expect(after.totalAmount).toBeNull();
      expect(after.completedAt).toBeNull();
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

      // 對照組：擁有人本人完成 → 200 成功。
      const ownerResp = await completeHttp(ownerCookie, id);
      expect(ownerResp.statusCode).toBe(200);
    });

    it("一般他人（非擁有人）完成 → 403", async () => {
      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2052-03-01",
        currentMaintenanceDate: "2052-04-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "100.00",
        actualCost: "500.00",
      });
      const resp = await completeHttp(otherCookie, id);
      expect(resp.statusCode).toBe(403);
    });

    it("未登入 → 401", async () => {
      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2052-05-01",
        currentMaintenanceDate: "2052-06-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "100.00",
        actualCost: "500.00",
      });
      const resp = await app.inject({ method: "POST", url: `/applications/${id}/complete` });
      expect(resp.statusCode).toBe(401);
    });

    it("mustChangePassword → 403 PASSWORD_CHANGE_REQUIRED", async () => {
      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2052-07-01",
        currentMaintenanceDate: "2052-08-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "100.00",
        actualCost: "500.00",
      });
      const resp = await completeHttp(mcpCookie, id);
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    });
  });

  // ===========================================================================
  // AC-18（完成端點整合層）— 比例 > 100% 阻擋；O==I 對照成功
  // ===========================================================================

  describe("AC-18 完成端點", () => {
    it("ratio above 100% returns 400 with details.blockers containing OFFICIAL_KM_EXCEEDS_INTERVAL and the 檢查差旅、日期或里程資料 wording", async () => {
      await seedCompletedTravel({
        tripDate: "2053-01-15",
        segments: [{ totalKm: "60.00", highwayKm: "0.00" }], // O=60 > I=50
      });
      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2053-01-01",
        currentMaintenanceDate: "2053-02-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "50.00", // intervalKm=50
        actualCost: "500.00",
      });

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{
        error: { code: string; details?: { blockers?: Array<{ code: string; message: string }> } };
      }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      const blockers = body.error.details?.blockers ?? [];
      const item = blockers.find((b) => b.code === "OFFICIAL_KM_EXCEEDS_INTERVAL");
      expect(item).toBeDefined();
      expect(item?.message).toContain("檢查差旅、日期或里程資料");

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.status).toBe("DRAFT");
      const dbMaintenance = await prisma.maintenanceApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      expect(dbMaintenance.snapshotIntervalKm).toBeNull();
    });

    it("officialKm == intervalKm（恰 100%）→ 完成成功（對照組）", async () => {
      await seedCompletedTravel({
        tripDate: "2053-03-15",
        segments: [{ totalKm: "50.00", highwayKm: "0.00" }], // O=50 == I=50
      });
      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2053-03-01",
        currentMaintenanceDate: "2053-04-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "50.00",
        actualCost: "500.00",
      });

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: MaintenanceApplicationJson }>().application;
      expect(application.snapshot?.ratio).toBe("1.000000");
      expect(application.snapshot?.totalAmount).toBe(500); // 500*50/50=500
    });
  });

  // ===========================================================================
  // AC-22（完成段）— 零附件 400 阻擋；恰 1 張成功（已由 AC-25/26 案例覆蓋）
  // ===========================================================================

  describe("AC-22 完成段", () => {
    it("零附件 → 400，details.blockers 含 MAINTENANCE_ATTACHMENT_REQUIRED", async () => {
      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2054-01-01",
        currentMaintenanceDate: "2054-02-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "100.00",
        actualCost: "500.00",
        attachmentCount: 0,
      });

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{
        error: { code: string; details?: { blockers?: Array<{ code: string }> } };
      }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      const codes = (body.error.details?.blockers ?? []).map((b) => b.code);
      expect(codes).toContain("MAINTENANCE_ATTACHMENT_REQUIRED");

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.status).toBe("DRAFT");
    });
  });

  // ===========================================================================
  // AC-19（完成段接線）— 容量守門：超容量拒絕（絕不寫快照）；合法大額正例成功
  // ===========================================================================

  describe("AC-19 容量守門（完成端點）", () => {
    it("金額超出可儲存範圍（rawAmount/amount 超 int4）→ 400 AMOUNT_OUT_OF_RANGE，快照零寫入", async () => {
      await seedCompletedTravel({
        tripDate: "2055-01-15",
        segments: [{ totalKm: "100.00", highwayKm: "0.00" }], // O == I == 100（恰 100%，不觸發 AC-18）
      });
      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2055-01-01",
        currentMaintenanceDate: "2055-02-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "100.00",
        // rawAmount = 3,000,000,000.00 * 100 / 100 = 3,000,000,000 —
        // 超過 int4 上界 2,147,483,647（AC-19 容量守門，非 AC-18 比例阻擋）。
        actualCost: "3000000000.00",
      });

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{
        error: { code: string; details?: { blockers?: Array<{ code: string }> } };
      }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      const codes = (body.error.details?.blockers ?? []).map((b) => b.code);
      expect(codes).toContain("AMOUNT_OUT_OF_RANGE");

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.status).toBe("DRAFT");
      expect(dbApp.totalAmount).toBeNull();
      const dbMaintenance = await prisma.maintenanceApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      expect(dbMaintenance.snapshotRawAmount).toBeNull();
    });

    it("邊界正例：合法大額組合（低於容量上界）完成成功，防誤殺", async () => {
      await seedCompletedTravel({
        tripDate: "2055-03-15",
        segments: [{ totalKm: "100.00", highwayKm: "0.00" }],
      });
      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2055-03-01",
        currentMaintenanceDate: "2055-04-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "100.00",
        // rawAmount = 2,000,000,000 — 低於 int4 上界 2,147,483,647。
        actualCost: "2000000000.00",
      });

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: MaintenanceApplicationJson }>().application;
      expect(application.snapshot?.totalAmount).toBe(2000000000);
    });
  });

  // ===========================================================================
  // T7R 複審修復 — S-2（mutant M2 kill）/ S-3（mutant M6 kill）
  // ===========================================================================

  describe("T7R S-2 — 最終金額取整層級整合層鑑別（mutant M2 kill）", () => {
    it("actualCost=99999.00, officialKm=1.00, intervalKm=200000.00 → rawAmount=0.499995 恰在 0.5 進位邊界下側：totalAmount 必為 0（非由 4dp snapshotRawAmount='0.5000' 反推取整得 1）", async () => {
      await seedCompletedTravel({
        tripDate: "2058-01-15",
        segments: [{ totalKm: "1.00", highwayKm: "0.00" }], // officialKm=1.00
      });
      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2058-01-01",
        currentMaintenanceDate: "2058-02-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "200000.00", // intervalKm=200000.00
        actualCost: "99999.00",
      });

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: MaintenanceApplicationJson }>().application;

      // rawAmount = 99999 * 1 / 200000 = 0.499995 → toFixed(4) = "0.5000"
      // （5 位小數 9 進位第 4 位），但正解 totalAmount 必須以未取整之
      // 0.499995 四捨五入（0.5 進位）為 0，而非把已取整的 4dp 字串
      // "0.5000" 再解讀為 0.5 而進位成 1（M2 之存活形狀）。
      expect(application.snapshot?.rawAmount).toBe("0.5000");
      expect(application.snapshot?.totalAmount).toBe(0);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.totalAmount).toBe(0);
    });
  });

  describe("T7R S-3 — 完成路徑同 tx 呼叫引擎鑑別（mutant M6 kill）", () => {
    it("completeMaintenanceApplication 呼叫 sumOfficialMileage 之首引數為交易客戶端（tx），非頂層 PrismaClient（M6：改傳頂層 prisma 必紅）", async () => {
      await seedCompletedTravel({
        tripDate: "2059-01-15",
        segments: [{ totalKm: "10.00", highwayKm: "0.00" }],
      });
      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2059-01-01",
        currentMaintenanceDate: "2059-02-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "100.00",
        actualCost: "200.00",
      });

      const spy = vi.mocked(mileageEngine.sumOfficialMileage);
      const callsBefore = spy.mock.calls.length;

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      expect(spy.mock.calls.length).toBe(callsBefore + 1);

      const lastCall = spy.mock.calls.at(-1) as unknown as [object, unknown];
      // `Prisma.TransactionClient` 型別上即不含 `$transaction`（denylist），
      // 頂層 `PrismaClient` 則有——以此區分「同一交易內之 tx」與「頂層
      // prisma 實例」，不依賴物件參照比較（tx 每次交易皆為新代理物件）。
      expect((lastCall[0] as { $transaction?: unknown }).$transaction).toBeUndefined();
      expect(lastCall[0]).not.toBe(prisma);
    });
  });

  // ===========================================================================
  // blockers 完整清單 — 多重違反回全部 + fields[] 五路徑
  // ===========================================================================

  describe("blockers 完整清單（多重違反）", () => {
    it("多重結構性違反（日期順序 + 里程表順序 + 費用 ≤ 0 + 零附件）→ 400 details.blockers 含全部四碼，fields[] 對應可定位項", async () => {
      const id = await createDraft(ownerCookie);
      const putResp = await putFields(ownerCookie, id, {
        lastMaintenanceDate: "2056-02-01",
        currentMaintenanceDate: "2056-01-01", // 順序顛倒
        lastOdometerKm: "100.00",
        currentOdometerKm: "50.00", // 順序顛倒
        actualCost: "-1.00", // ≤0
      });
      expect(putResp.statusCode).toBe(200);

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{
        error: {
          code: string;
          fields?: Array<{ field: string; reason: string }>;
          details?: { blockers?: Array<{ code: string; field?: string }> };
        };
      }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      const codes = (body.error.details?.blockers ?? []).map((b) => b.code);
      expect(codes).toEqual(
        expect.arrayContaining([
          "MAINTENANCE_DATE_ORDER_INVALID",
          "ODOMETER_ORDER_INVALID",
          "ACTUAL_COST_INVALID",
          "MAINTENANCE_ATTACHMENT_REQUIRED",
        ])
      );
      // AC-18/AC-19（第 9/11 項）在此不應出現——第 1~8 項未全通過，兩段式第
      // 二段（期間公務里程查詢）從未執行。
      expect(codes).not.toContain("OFFICIAL_KM_EXCEEDS_INTERVAL");
      expect(codes).not.toContain("AMOUNT_OUT_OF_RANGE");

      const fieldPaths = (body.error.fields ?? []).map((f) => f.field);
      expect(fieldPaths).toEqual(
        expect.arrayContaining(["currentMaintenanceDate", "currentOdometerKm", "actualCost"])
      );

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.status).toBe("DRAFT");
    });
  });

  // ===========================================================================
  // B-30 — 併發：完成 vs 刪除附件
  // ===========================================================================

  describe("B-30 併發（完成 vs 刪除附件）", () => {
    // T8R 複審 AR-3 移交待辦：原本單輪 if/else 條件式斷言可能靜默只覆蓋兩種
    // 終局（完成方勝出／刪除方勝出）之一，無法確認兩側皆曾真正被覆蓋到。改為
    // N 輪迴圈（N≥10，比照 `phase6-snapshot-immutability.test.ts` 之
    // 「AC-29 併發完成（N 輪迴圈，AR-3 精神）」同一原則）：每輪各自建立獨立
    // 草稿＋附件＋期間差旅，逐輪重跑「完成 vs 刪除附件」並各自斷言終局合法；
    // 另加輪間 jitter（隨機微延遲、交替讓哪一方先發起）提高兩側交錯情境皆
    // 出現的機率。既有斷言意圖（絕不 500、恰一方效果生效、不得雙重完成／
    // 雙重快照）維持不變。
    //
    // PHASE-011-T1（依 Spec AC-01／D1=(a)）：`completeMaintenanceApplication`
    // 於序列化衝突重試 6 次後拋 `SERVICE_UNAVAILABLE`/503 是**既有且刻意設計
    // 之契約**（重試耗盡之誠實回應），非本迴圈之缺陷——`maintenance-service.ts`
    // :1218 一帶。人類 Spec Gate 裁定 D1=(a)：擴充允許碼集為
    // `[400, 403, 409, 503]`，並新增第三分支終局斷言（503 時終局須為
    // `DRAFT` ∧ `totalAmount` null，且附件狀態須與該輪刪除方之回應一致——
    // 不得「503 但已寫入快照」殘留）。此為**擴大鑑別力**（多驗一種終局形
    // 狀），非放寬既有斷言（絕不 500、恰一方生效之意圖逐字保留）。零
    // `backend/src` 變更（AC-01(e)）。
    const CONCURRENCY_ROUNDS = 12;

    function jitter(): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
    }

    /**
     * 單輪終局斷言（自 loop 抽出為純函式，供主迴圈與下方 mutant 自證共用）：
     * 不做任何 DB／HTTP I/O，只依已取得之結果與快照做斷言。抽出理由：讓
     * AC-01(b) 新增之第三分支得以用偽造情境獨立驗證鑑別力（見下方
     * `it("mutant 自證..."）`），而不必依賴真實併發競態才能觸發 503 分支。
     */
    function assertB30RoundOutcome(
      completeSettled: PromiseSettledResult<unknown>,
      deleteSettled: PromiseSettledResult<{ statusCode: number }>,
      dbApp: { status: string; totalAmount: unknown },
      dbAttachment: { status: string }
    ): void {
      // 絕不 500：complete 若失敗只能是業務 AppError（400/403/409/503——
      // 依 D1=(a) 503 為既有合法契約），刪除回應只能是 200/403/409，皆非 500。
      if (completeSettled.status === "rejected") {
        const err = completeSettled.reason as { httpStatus?: number };
        expect(err.httpStatus).not.toBe(500);
        expect([400, 403, 409, 503]).toContain(err.httpStatus);
      }
      if (deleteSettled.status === "fulfilled") {
        expect(deleteSettled.value.statusCode).not.toBe(500);
      }

      const got503 =
        completeSettled.status === "rejected" &&
        (completeSettled.reason as { httpStatus?: number }).httpStatus === 503;

      // 終局狀態必為下列三者之一（恰一方之效果生效，不得雙重完成／雙重快照）：
      if (dbApp.status === "COMPLETED") {
        // 完成方勝出：附件仍是 LINKED（完成鎖定，AC-23 既有行為，刪除方應已被擋 403）。
        expect(dbAttachment.status).toBe("LINKED");
        expect(dbApp.totalAmount).not.toBeNull();
      } else if (got503) {
        // 第三分支（AC-01(b)，新增）：完成方因重試耗盡得 503 → 終局須為
        // DRAFT ∧ totalAmount null，且附件狀態須與該輪刪除方之回應一致——
        // 不得出現「503 但已寫入快照」之殘留。
        expect(dbApp.status).toBe("DRAFT");
        expect(dbApp.totalAmount).toBeNull();
        if (deleteSettled.status === "fulfilled" && deleteSettled.value.statusCode === 200) {
          expect(dbAttachment.status).toBe("TEMP");
        } else {
          expect(dbAttachment.status).toBe("LINKED");
        }
      } else {
        // 刪除方勝出：附件已 detach 回 TEMP，完成因零附件被 400 擋下，status 仍 DRAFT。
        expect(dbApp.status).toBe("DRAFT");
        expect(dbApp.totalAmount).toBeNull();
      }
    }

    it("mutant 自證：第三分支對「503 但已寫入快照／附件狀態不一致」之殘留必紅（鑑別力驗證，不改真實程式，不做 DB／HTTP I/O）", () => {
      const forged503: PromiseSettledResult<unknown> = {
        status: "rejected",
        reason: { httpStatus: 503 },
      };
      const forgedDeleteOk: PromiseSettledResult<{ statusCode: number }> = {
        status: "fulfilled",
        value: { statusCode: 200 },
      };
      const forgedDeleteBlocked: PromiseSettledResult<{ statusCode: number }> = {
        status: "fulfilled",
        value: { statusCode: 403 },
      };

      // ① 偽造「503 但仍寫入 totalAmount」之殘留情境 → 第三分支必紅。
      expect(() =>
        assertB30RoundOutcome(
          forged503,
          forgedDeleteOk,
          { status: "DRAFT", totalAmount: 999 },
          { status: "TEMP" }
        )
      ).toThrow();

      // ② 偽造「503 但附件狀態與刪除方回應不一致」（刪除已成功卻仍是
      //    LINKED）→ 亦必紅。
      expect(() =>
        assertB30RoundOutcome(
          forged503,
          forgedDeleteOk,
          { status: "DRAFT", totalAmount: null },
          { status: "LINKED" }
        )
      ).toThrow();

      // ③ 正向對照（防過緊）：刪除方亦失敗（403）時附件應仍是 LINKED——
      //    合法之 503 終局，不得誤紅。
      expect(() =>
        assertB30RoundOutcome(
          forged503,
          forgedDeleteBlocked,
          { status: "DRAFT", totalAmount: null },
          { status: "LINKED" }
        )
      ).not.toThrow();

      // ④ 正向對照（防過緊）：刪除方成功且附件已 detach 回 TEMP——合法之
      //    503 終局，不得誤紅。
      expect(() =>
        assertB30RoundOutcome(
          forged503,
          forgedDeleteOk,
          { status: "DRAFT", totalAmount: null },
          { status: "TEMP" }
        )
      ).not.toThrow();
    });

    it(`${CONCURRENCY_ROUNDS} 輪：同一保養草稿完成 vs 刪除其唯一附件同時發生 → 每輪皆恰一方成功語意上一致，不得 500`, async () => {
      for (let round = 0; round < CONCURRENCY_ROUNDS; round++) {
        const month = String((round % 9) + 1).padStart(2, "0");
        await seedCompletedTravel({
          tripDate: `2057-${month}-15`,
          segments: [{ totalKm: "10.00", highwayKm: "0.00" }],
        });
        const id = await createDraft(ownerCookie);
        const putResp = await putFields(ownerCookie, id, {
          lastMaintenanceDate: `2057-${month}-01`,
          currentMaintenanceDate: `2057-${month}-28`,
          lastOdometerKm: "0.00",
          currentOdometerKm: "100.00",
          actualCost: `${200 + round}.00`,
        });
        expect(putResp.statusCode).toBe(200);
        const attachmentId = await uploadTemp(ownerCookie, `b30-${round}.jpg`);
        const linkResp = await putFields(ownerCookie, id, { attachmentIds: [attachmentId] });
        expect(linkResp.statusCode).toBe(200);

        // 輪間交替：偶數輪讓「完成」先發起、奇數輪讓「刪除」先發起（各自
        // jitter 一個隨機微延遲），提高交錯率而非固定同一種發起順序。
        const [completeSettled, deleteSettled] = await Promise.allSettled([
          (async () => {
            if (round % 2 === 1) await jitter();
            return completeMaintenanceApplication(prisma, id);
          })(),
          (async () => {
            if (round % 2 === 0) await jitter();
            return app.inject({
              method: "DELETE",
              url: `/attachments/${attachmentId}`,
              headers: { cookie: ownerCookie },
            });
          })(),
        ]);

        // 終局狀態必為下列三者之一（恰一方之效果生效，不得雙重完成 / 雙重快照）：
        const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
        const dbAttachment = await prisma.attachment.findUniqueOrThrow({
          where: { id: attachmentId },
        });

        assertB30RoundOutcome(completeSettled, deleteSettled, dbApp, dbAttachment);
      }
    });
  });
});
