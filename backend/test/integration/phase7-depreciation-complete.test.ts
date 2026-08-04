/**
 * Integration tests for PHASE-007-T9:
 *   折舊完成流程 ＋ 快照寫入 ＋ 原子性 ＋ 僅本人授權。
 *
 * AC covered (PHASE-007 Spec §2 群組 H)：AC-27（單一 SERIALIZABLE 交易之
 * §9.3 步驟順序）、AC-28（8 欄快照 ＋ 顯式定精度 ＋ `amount` 不由 4dp
 * `rawAmount` 反推）、AC-29（僅擁有人本人可完成，管理員亦 403）、AC-30
 * （切點回滾 ＋ `P2025` 不得 500）；併 AC-16／AC-18 之**完成端點 409 段**
 * （§7.5 拒絕形狀、§16 D5(a)）。
 *
 * **不在本檔範圍**（Gate 裁定切出）：AC-22／AC-24 之整合層正式斷言屬 T9b；
 * AC-31/32/33（快照不可變、後端權威、雙完成併發）屬 T10。本檔僅就 T9 之
 * Done When 與 FW 指派項落地必要證據。
 *
 * Test discipline (Spec §11.0 / Packet)：
 *   - loginName 前綴 "p7t9_" ＋ 每次執行之隨機後綴。
 *   - cleanup 僅限本檔追蹤之 id ＋ loginName 前綴；**絕不** `deleteMany({})`。
 *   - 一律合成資料（合成附件列，無真實影像、無真實個資）。
 *
 * ── 修復前紅燈實證（TDD 順序，Packet 明列） ──────────────────────────────
 *   本 Task 動工時 `POST /applications/:id/complete` 只分派 MAINTENANCE 與
 *   TRAVEL 兩型；折舊 id 落入 TRAVEL 分支 → `getTravelApplication` 回 `null`
 *   → 404。首條紅燈原文（逐字記錄於 Handoff）：
 *       AssertionError: expected 404 to be 200
 *   實作分派分支後轉綠，並永久留存為回歸守門
 *   （見 `describe("AC-27 …")` 之「折舊申請經 generic 完成端點分派」）。
 *
 * ── 參數版本階梯（全域資料，`findEffectiveVersion` 取「生效日 ≤ 查詢日之最新
 *    者」，故一個版本會沿用至下一個版本生效為止） ─────────────────────────
 *   年度 < 2049          → 查無版本        → 409 missing=["DEPRECIATION"]
 *   2049 ≤ 年度 ≤ 2060   → V_BASE   perKm 6.0000
 *   2061 ≤ 年度 ≤ 2069   → V_KILL   perKm 2468.9999（AC-28 反推 kill case）
 *   2070             → V_NARROW perKm 2380.9525（4dp 量化窄窗）
 *   2071 ≤ 年度          → V_BAD    vehiclePrice 0 → `deriveDepreciation`
 *                                     回 ok:false → 409 missing=
 *                                     ["DEPRECIATION_DERIVATION_FAILED"]
 *
 * **每個測試使用互不重複的申請年度**：年度公務里程由該年度全部已完成差旅列
 * 加總而得，共用年度會使各測試互相污染金額斷言。
 */
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeDepreciationApplication } from "../../src/applications/depreciation-service.js";
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
const LOGIN_PREFIX = "p7t9_";
const PASSWORD = "DepreciationCompleteTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;

/** §8.2 DDL 之 scale，供快照精度斷言逐欄比對（零魔術數：與 Spec 表格逐值一致）。 */
const SNAPSHOT_SCALE = {
  vehiclePrice: 2,
  perKmUnitPrice: 4,
  officialKm: 2,
  rawAmount: 4,
} as const;

type BlockerDto = { code: string; field?: string; message: string };

type SnapshotDto = {
  officialKm: string;
  perKmUnitPrice: string;
  rawAmount: string;
  totalAmount: number;
  calculatedAt: string;
};

type ApplicationDto = {
  id: string;
  status: string;
  applicationYear: number | null;
  completionBlockers: BlockerDto[] | null;
  computed: unknown;
  snapshot: SnapshotDto | null;
};

type ErrorBody = {
  error: {
    code: string;
    message: string;
    fields?: { field: string; reason: string }[];
    details?: Record<string, unknown>;
  };
};

describeWithDb("PHASE-007-T9 — 折舊完成流程 ＋ 快照 ＋ 原子性 ＋ 僅本人授權", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let otherId: string;
  let adminId: string;

  let ownerCookie: string;
  let otherCookie: string;
  let adminCookie: string;

  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  function trackApp(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    const mkUser = (loginName: string, displayName: string, role: "USER" | "ADMIN") =>
      prisma.user.create({
        data: {
          loginName,
          displayName,
          passwordHash: hash,
          role,
          isActive: true,
          mustChangePassword: false,
        },
      });

    const owner = await mkUser(OWNER_LOGIN, "P7T9 擁有人", "USER");
    const other = await mkUser(OTHER_LOGIN, "P7T9 他人", "USER");
    const admin = await mkUser(ADMIN_LOGIN, "P7T9 管理員", "ADMIN");
    ownerId = owner.id;
    otherId = other.id;
    adminId = admin.id;

    // 參數版本階梯（見檔頭）。
    const versions = [
      { effectiveFrom: "2049-01-01", vehiclePrice: "600000.00", years: 5, km: 20000 },
      { effectiveFrom: "2061-01-01", vehiclePrice: "246899.99", years: 4, km: 25 },
      { effectiveFrom: "2070-01-01", vehiclePrice: "9523.81", years: 2, km: 2 },
      // `deriveDepreciation` 之 `ok:false` 來源（AC-18）：車價 ≤ 0。端點層擋得
      // 住此輸入，故以直寫 DB 構造——這正是 AC-18 所指之「理論不可達但一旦
      // 發生一律視同缺參數」情境。
      { effectiveFrom: "2071-01-01", vehiclePrice: "0.00", years: 5, km: 20000 },
    ];
    for (const v of versions) {
      await prisma.depreciationParameterVersion.create({
        data: {
          vehiclePrice: v.vehiclePrice,
          usefulLifeYears: v.years,
          estimatedAnnualKm: v.km,
          effectiveFrom: new Date(`${v.effectiveFrom}T00:00:00.000Z`),
          createdById: adminId,
        },
      });
    }

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    ownerCookie = await loginUser(app, OWNER_LOGIN, PASSWORD);
    otherCookie = await loginUser(app, OTHER_LOGIN, PASSWORD);
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
      const userIds = [ownerId, otherId, adminId].filter(Boolean);
      if (userIds.length > 0) {
        await prisma.depreciationParameterVersion.deleteMany({
          where: { createdById: { in: userIds } },
        });
        await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      }
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
  });

  // ===========================================================================
  // Fixture helpers
  // ===========================================================================

  /** 已完成差旅列（年度公務里程之來源；直寫 DB 以精確控制年度與里程）。 */
  async function seedCompletedTravel(opts: {
    forOwnerId?: string;
    date: string;
    snapshotTotalKm: string;
  }): Promise<string> {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: opts.forOwnerId ?? ownerId,
        createdById: opts.forOwnerId ?? ownerId,
        primaryDate: new Date(`${opts.date}T00:00:00.000Z`),
        travel: {
          create: {
            tripDate: new Date(`${opts.date}T00:00:00.000Z`),
            snapshotTotalKm: opts.snapshotTotalKm,
          },
        },
      },
    });
    return trackApp(application.id);
  }

  /** 直接建立一張 `refType=DEPRECIATION` 的 `LINKED` 附件（免上傳來回）。 */
  async function linkProof(applicationId: string, forOwnerId = ownerId): Promise<string> {
    const attachment = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `p7t9/${RUN_ID}-${createdAttachmentIds.length}.jpg`,
        mimeType: "image/jpeg",
        byteSize: 256,
        originalFilename: "proof.jpg",
        uploaderId: forOwnerId,
        ownerId: forOwnerId,
        refType: "DEPRECIATION",
        refId: applicationId,
        linkedAt: new Date(),
      },
    });
    createdAttachmentIds.push(attachment.id);
    return attachment.id;
  }

  /** 經真實端點建立折舊草稿。 */
  async function createDraft(
    applicationYear: number | null,
    cookie = ownerCookie
  ): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/depreciation",
      headers: { cookie },
      payload: applicationYear === null ? {} : { applicationYear },
    });
    expect(resp.statusCode).toBe(201);
    return trackApp(resp.json<{ application: { id: string } }>().application.id);
  }

  /** 建立「可完成」之草稿：年度 ＋ 至少一張證明。 */
  async function createCompletableDraft(
    applicationYear: number,
    cookie = ownerCookie,
    forOwnerId = ownerId
  ): Promise<string> {
    const id = await createDraft(applicationYear, cookie);
    await linkProof(id, forOwnerId);
    return id;
  }

  function completeHttp(cookie: string, id: string) {
    return app.inject({
      method: "POST",
      url: `/applications/${id}/complete`,
      headers: { cookie },
    });
  }

  function getHttp(cookie: string, id: string) {
    return app.inject({
      method: "GET",
      url: `/applications/depreciation/${id}`,
      headers: { cookie },
    });
  }

  /**
   * 全表資料列計數快照（T6 即審 FW-9：失敗路徑之零寫入一律以全表計數前後全等
   * 證明，而非只看目標列）。涵蓋 10 張與本流程可能相關之表。
   */
  async function tableCounts(): Promise<Record<string, number>> {
    const [
      user,
      session,
      auditLog,
      attachment,
      application,
      travelApplication,
      tripSegment,
      maintenanceApplication,
      depreciationApplication,
      depreciationParameterVersion,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.session.count(),
      prisma.auditLog.count(),
      prisma.attachment.count(),
      prisma.application.count(),
      prisma.travelApplication.count(),
      prisma.tripSegment.count(),
      prisma.maintenanceApplication.count(),
      prisma.depreciationApplication.count(),
      prisma.depreciationParameterVersion.count(),
    ]);
    return {
      user,
      session,
      auditLog,
      attachment,
      application,
      travelApplication,
      tripSegment,
      maintenanceApplication,
      depreciationApplication,
      depreciationParameterVersion,
    };
  }

  // ===========================================================================
  // AC-27 — 完成流程（分派、單一交易、§9.3 步驟順序）
  // ===========================================================================

  describe("AC-27 完成流程與 §9.3 步驟順序", () => {
    it("折舊申請經 generic 完成端點分派 → 200（修復前為 404：落入 TRAVEL 分支）", async () => {
      await seedCompletedTravel({ date: "2049-06-01", snapshotTotalKm: "100.00" });
      const id = await createCompletableDraft(2049);

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);

      const dto = resp.json<{ application: ApplicationDto }>().application;
      expect(dto.status).toBe("COMPLETED");
      // 100.00 km × 6.0000 元/km = 600
      expect(dto.snapshot?.totalAmount).toBe(600);
    });

    it("完成回應不夾帶 computed，且 completionBlockers 為 null（COMPLETED 之正式契約）", async () => {
      await seedCompletedTravel({ date: "2050-03-01", snapshotTotalKm: "250.00" });
      const id = await createCompletableDraft(2050);

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const dto = resp.json<{ application: ApplicationDto }>().application;
      expect(dto.computed).toBeNull();
      expect(dto.completionBlockers).toBeNull();

      // 事後重讀亦然。
      const readBack = (await getHttp(ownerCookie, id)).json<{ application: ApplicationDto }>()
        .application;
      expect(readBack.computed).toBeNull();
      expect(readBack.completionBlockers).toBeNull();
    });

    it("狀態機守門：對已完成之申請再次完成 → 403，快照與 totalAmount 逐位元不變", async () => {
      await seedCompletedTravel({ date: "2051-05-01", snapshotTotalKm: "10.00" });
      const id = await createCompletableDraft(2051);
      expect((await completeHttp(ownerCookie, id)).statusCode).toBe(200);

      const before = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      const beforeApp = await prisma.application.findUniqueOrThrow({ where: { id } });

      const second = await completeHttp(ownerCookie, id);
      expect(second.statusCode).toBe(403);
      expect(second.json<ErrorBody>().error.code).toBe("FORBIDDEN");

      const after = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      const afterApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(after.snapshotRawAmount?.toString()).toBe(before.snapshotRawAmount?.toString());
      expect(after.calculatedAt?.getTime()).toBe(before.calculatedAt?.getTime());
      expect(afterApp.totalAmount).toBe(beforeApp.totalAmount);
      expect(afterApp.completedAt?.getTime()).toBe(beforeApp.completedAt?.getTime());
    });

    it("②先於③④：年度缺漏 ＋ 零證明 → 400 且僅結構性兩碼（第 3/4 碼被抑制，未查詢里程與參數）", async () => {
      const id = await createDraft(null);

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      const codes = (body.error.details?.blockers as BlockerDto[]).map((b) => b.code);
      expect(codes).toEqual(["YEAR_REQUIRED", "DEPRECIATION_ATTACHMENT_REQUIRED"]);
      expect(codes).not.toContain("PARAMETER_NOT_AVAILABLE");
      expect(body.error.fields).toEqual([{ field: "applicationYear", reason: "請選擇申請年度" }]);
    });

    it("②先於③④之鑑別：年度**無參數** ＋ 零證明 → 400 且不含 PARAMETER_NOT_AVAILABLE（結構性未過即不查參數）", async () => {
      // 2040 早於最早版本生效日 → 若先查參數必得第 3 碼；正確實作應被抑制。
      const id = await createDraft(2040);

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(400);
      const codes = (resp.json<ErrorBody>().error.details?.blockers as BlockerDto[]).map(
        (b) => b.code
      );
      expect(codes).toEqual(["DEPRECIATION_ATTACHMENT_REQUIRED"]);
    });

    it("年度為 null 一律 400 YEAR_REQUIRED，**不得**映射為 409（FW：無年度即無『該年度無參數』語意）", async () => {
      const id = await createDraft(null);
      await linkProof(id);

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.code).not.toBe("PARAMETER_NOT_AVAILABLE");
      expect((body.error.details?.blockers as BlockerDto[]).map((b) => b.code)).toEqual([
        "YEAR_REQUIRED",
      ]);
    });

    it("附件計數於 tx 內現算：交易外曾有 1 張、完成前被刪 → 400 DEPRECIATION_ATTACHMENT_REQUIRED（不採 DTO 之 attachments.length）", async () => {
      await seedCompletedTravel({ date: "2053-02-01", snapshotTotalKm: "50.00" });
      const id = await createDraft(2053);
      const attachmentId = await linkProof(id);

      // 交易外之 DTO 讀取（此時計數為 1，草稿看似可完成）。
      const draft = (await getHttp(ownerCookie, id)).json<{ application: ApplicationDto }>()
        .application;
      expect(draft.completionBlockers).toEqual([]);

      // 完成之前附件被刪除 → 交易內現算必為 0。
      await prisma.attachment.delete({ where: { id: attachmentId } });

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(400);
      expect(
        (resp.json<ErrorBody>().error.details?.blockers as BlockerDto[]).map((b) => b.code)
      ).toEqual(["DEPRECIATION_ATTACHMENT_REQUIRED"]);
      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.status).toBe("DRAFT");
    });

    it("年度里程以擁有人為準且落在該年度：跨年度之差旅不計入（引擎唯一呼叫點，同一交易）", async () => {
      // 年度內 120.00；前一年 999.00（不得計入）；他人 777.00（不得計入）。
      await seedCompletedTravel({ date: "2052-07-01", snapshotTotalKm: "120.00" });
      await seedCompletedTravel({ date: "2048-12-31", snapshotTotalKm: "999.00" });
      await seedCompletedTravel({
        forOwnerId: otherId,
        date: "2052-07-02",
        snapshotTotalKm: "777.00",
      });
      const id = await createCompletableDraft(2052);

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const snapshot = resp.json<{ application: ApplicationDto }>().application.snapshot;
      expect(snapshot?.officialKm).toBe("120.00");
      expect(snapshot?.totalAmount).toBe(720); // 120 × 6
    });
  });

  // ===========================================================================
  // AC-28 — 快照 8 欄 ＋ 顯式定精度 ＋ amount 不由 rawAmount 反推
  // ===========================================================================

  describe("AC-28 快照欄位與精度", () => {
    it("8 個快照欄位全部寫入且值正確（含 DTO 不外露之三推導值與版本 id）", async () => {
      await seedCompletedTravel({ date: "2054-08-01", snapshotTotalKm: "333.33" });
      const id = await createCompletableDraft(2054);

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);

      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      const version = await prisma.depreciationParameterVersion.findFirstOrThrow({
        where: { effectiveFrom: new Date("2049-01-01T00:00:00.000Z") },
      });

      expect(row.snapshotVehiclePrice?.toFixed(2)).toBe("600000.00");
      expect(row.snapshotUsefulLifeYears).toBe(5);
      expect(row.snapshotEstimatedAnnualKm).toBe(20000);
      expect(row.snapshotPerKmUnitPrice?.toFixed(4)).toBe("6.0000");
      expect(row.snapshotOfficialKm?.toFixed(2)).toBe("333.33");
      expect(row.snapshotRawAmount?.toFixed(4)).toBe("1999.9800");
      expect(row.calculatedAt).not.toBeNull();
      expect(row.depreciationParameterVersionId).toBe(version.id);

      // 最終金額只落在 Application.totalAmount（不重複持久化）。
      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.totalAmount).toBe(2000); // 1999.98 → 2000
      expect(dbApp.completedAt?.getTime()).toBe(row.calculatedAt?.getTime());

      // §16 D8(a)：DTO 不外露三推導值與版本 id。
      const bodyText = resp.body;
      expect(bodyText).not.toContain("vehiclePrice");
      expect(bodyText).not.toContain("usefulLifeYears");
      expect(bodyText).not.toContain("estimatedAnnualKm");
      expect(bodyText).not.toContain(version.id);
    });

    it("顯式定精度：四個 Decimal 快照欄之小數位與 §8.2 DDL scale 逐欄相符（不裁尾零）", async () => {
      await seedCompletedTravel({ date: "2055-09-01", snapshotTotalKm: "10.00" });
      const id = await createCompletableDraft(2055);
      expect((await completeHttp(ownerCookie, id)).statusCode).toBe(200);

      // 以 raw SQL 讀取字串表示，確認 Postgres 端之 scale（Decimal 物件之
      // toString 會裁尾零，故不足以證明）。
      const rows = await prisma.$queryRaw<
        {
          snapshotVehiclePrice: string;
          snapshotPerKmUnitPrice: string;
          snapshotOfficialKm: string;
          snapshotRawAmount: string;
        }[]
      >`SELECT "snapshotVehiclePrice"::text AS "snapshotVehiclePrice",
               "snapshotPerKmUnitPrice"::text AS "snapshotPerKmUnitPrice",
               "snapshotOfficialKm"::text AS "snapshotOfficialKm",
               "snapshotRawAmount"::text AS "snapshotRawAmount"
          FROM "DepreciationApplication" WHERE "applicationId" = ${id}`;
      const row = rows[0];
      const decimals = (s: string) => (s.split(".")[1] ?? "").length;
      expect(decimals(row.snapshotVehiclePrice)).toBe(SNAPSHOT_SCALE.vehiclePrice);
      expect(decimals(row.snapshotPerKmUnitPrice)).toBe(SNAPSHOT_SCALE.perKmUnitPrice);
      expect(decimals(row.snapshotOfficialKm)).toBe(SNAPSHOT_SCALE.officialKm);
      expect(decimals(row.snapshotRawAmount)).toBe(SNAPSHOT_SCALE.rawAmount);
      expect(row.snapshotRawAmount).toBe("60.0000");
    });

    it("kill case：rawAmount 量化為 1234.5000 但 totalAmount 為 1234（amount 絕不由 4dp rawAmount 反推）", async () => {
      // 2061 年 → perKm 2468.9999；officialKm 0.50 → raw = 1234.49995
      await seedCompletedTravel({ date: "2061-04-01", snapshotTotalKm: "0.50" });
      const id = await createCompletableDraft(2061);

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const snapshot = resp.json<{ application: ApplicationDto }>().application.snapshot;

      expect(snapshot?.perKmUnitPrice).toBe("2468.9999");
      expect(snapshot?.rawAmount).toBe("1234.5000"); // 4dp ROUND_HALF_UP 之量化
      // 反推實作（round(1234.5000) = 1235）必紅；正確實作取未量化之
      // rawAmount（1234.49995）→ 1234。
      expect(snapshot?.totalAmount).toBe(1234);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.totalAmount).toBe(1234);
    });

    it("快照 rawAmount 與獨立重算之乘積逐位元一致（判定所依據之金額 ＝ 寫入之金額）", async () => {
      await seedCompletedTravel({ date: "2056-04-01", snapshotTotalKm: "1234.56" });
      const id = await createCompletableDraft(2056);
      expect((await completeHttp(ownerCookie, id)).statusCode).toBe(200);

      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });

      const recomputedRaw = (row.snapshotOfficialKm as Prisma.Decimal).times(
        row.snapshotPerKmUnitPrice as Prisma.Decimal
      );
      expect(recomputedRaw.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4)).toBe(
        row.snapshotRawAmount?.toFixed(4)
      );
      expect(recomputedRaw.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber()).toBe(
        dbApp.totalAmount
      );
    });
  });

  // ===========================================================================
  // 完成端點之 409（AC-16／AC-18 之完成端點段，§7.5／§16 D5(a)）
  // ===========================================================================

  describe("完成端點 409 PARAMETER_NOT_AVAILABLE（兩來源逐字互異）", () => {
    it('查無有效版本 → 409 ＋ details.missing=["DEPRECIATION"] ＋ details.applicationYear', async () => {
      const id = await createCompletableDraft(2040);

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(409);
      const body = resp.json<ErrorBody>();
      expect(body.error.code).toBe("PARAMETER_NOT_AVAILABLE");
      expect(body.error.details?.missing).toEqual(["DEPRECIATION"]);
      expect(body.error.details?.applicationYear).toBe(2040);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.status).toBe("DRAFT");
      expect(dbApp.totalAmount).toBeNull();
    });

    it('版本存在但推導失敗 → 409 ＋ details.missing=["DEPRECIATION_DERIVATION_FAILED"]，訊息與前者逐字互異', async () => {
      const missingId = await createCompletableDraft(2041);
      const failedId = await createCompletableDraft(2075);

      const missingResp = await completeHttp(ownerCookie, missingId);
      const failedResp = await completeHttp(ownerCookie, failedId);

      expect(missingResp.statusCode).toBe(409);
      expect(failedResp.statusCode).toBe(409);

      const missingBody = missingResp.json<ErrorBody>();
      const failedBody = failedResp.json<ErrorBody>();

      expect(missingBody.error.details?.missing).toEqual(["DEPRECIATION"]);
      expect(failedBody.error.details?.missing).toEqual(["DEPRECIATION_DERIVATION_FAILED"]);
      expect(failedBody.error.details?.applicationYear).toBe(2075);

      // 逐字互異（兩種情境之管理員行動不同）。
      expect(failedBody.error.message).not.toBe(missingBody.error.message);
      expect(failedBody.error.message.length).toBeGreaterThan(0);
      expect(missingBody.error.message.length).toBeGreaterThan(0);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id: failedId } });
      expect(dbApp.status).toBe("DRAFT");
    });

    it("missing 陣列不跨呼叫共用參考：連續兩次缺參數完成之 details.missing 逐次獨立且穩定", async () => {
      const first = await createCompletableDraft(2042);
      const second = await createCompletableDraft(2043);

      const r1 = await completeHttp(ownerCookie, first);
      const r2 = await completeHttp(ownerCookie, second);
      expect(r1.json<ErrorBody>().error.details?.missing).toEqual(["DEPRECIATION"]);
      expect(r2.json<ErrorBody>().error.details?.missing).toEqual(["DEPRECIATION"]);
    });

    it("缺參數之 409 失敗路徑：全表資料列計數前後全等（零寫入）", async () => {
      const id = await createCompletableDraft(2044);
      const before = await tableCounts();

      expect((await completeHttp(ownerCookie, id)).statusCode).toBe(409);

      expect(await tableCounts()).toEqual(before);
    });
  });

  // ===========================================================================
  // AMOUNT_OUT_OF_RANGE → 400（寫入前拒絕；4dp 量化窄窗不成 500）
  // ===========================================================================

  describe("AMOUNT_OUT_OF_RANGE 之完成端點拒絕", () => {
    it("金額超出 int4 → 400 VALIDATION_ERROR ＋ blockers=[AMOUNT_OUT_OF_RANGE]，全表零寫入", async () => {
      // 2066 → perKm 2468.9999；officialKm 400000000.00 → raw 約 9.88e11，同時
      // 超出 `snapshotRawAmount` 之 1e10 與 `totalAmount` 之 int4 上限。
      await seedCompletedTravel({ date: "2066-01-05", snapshotTotalKm: "400000000.00" });
      const id = await createCompletableDraft(2066);

      const before = await tableCounts();
      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect((body.error.details?.blockers as BlockerDto[]).map((b) => b.code)).toEqual([
        "AMOUNT_OUT_OF_RANGE",
      ]);

      expect(await tableCounts()).toEqual(before);
      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      expect(row.snapshotRawAmount).toBeNull();
      expect(row.calculatedAt).toBeNull();
    });

    it("4dp 量化窄窗（rawAmount 9999999999.999975 → 量化後恰為 1e10）→ 400 而非 500（Postgres 22003 不可達）", async () => {
      // 2070 → perKm 2380.9525；officialKm 4199999.79
      //   raw = 9999999999.999975 ∈ [1e10−5e-5, 1e10)  ← Decimal(14,4) 之量化窄窗
      //   amount = round(raw) = 10000000000 > int4  ← 容量判定必先於量化拒絕
      await seedCompletedTravel({ date: "2070-05-05", snapshotTotalKm: "4199999.79" });
      const id = await createCompletableDraft(2070);

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).not.toBe(500);
      expect(resp.statusCode).toBe(400);
      expect(
        (resp.json<ErrorBody>().error.details?.blockers as BlockerDto[]).map((b) => b.code)
      ).toEqual(["AMOUNT_OUT_OF_RANGE"]);

      // 窄窗前提之自證：本案例之未量化 rawAmount 確實落在窄窗內。
      const raw = new Prisma.Decimal("4199999.79").times(new Prisma.Decimal("2380.9525"));
      expect(raw.toFixed(6)).toBe("9999999999.999975");
      expect(raw.lessThan(new Prisma.Decimal("1e10"))).toBe(true);
      expect(raw.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4)).toBe(
        "10000000000.0000"
      );

      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      expect(row.snapshotRawAmount).toBeNull();
    });
  });

  // ===========================================================================
  // AC-29 — 完成僅本人（管理員亦 403）
  // ===========================================================================

  describe("AC-29 完成授權：僅擁有人本人", () => {
    it("管理員完成他人折舊草稿 → 403 FORBIDDEN、DB 零寫入；對照組本人 → 200", async () => {
      await seedCompletedTravel({ date: "2057-02-02", snapshotTotalKm: "30.00" });
      const id = await createCompletableDraft(2057);

      const before = await prisma.application.findUniqueOrThrow({ where: { id } });
      const counts = await tableCounts();

      const adminResp = await completeHttp(adminCookie, id);
      expect(adminResp.statusCode).toBe(403);
      expect(adminResp.json<ErrorBody>().error.code).toBe("FORBIDDEN");

      expect(await tableCounts()).toEqual(counts);
      const after = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe("DRAFT");
      expect(after.totalAmount).toBeNull();
      expect(after.completedAt).toBeNull();
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

      // 對照組：本人完成 → 200。
      const ownerResp = await completeHttp(ownerCookie, id);
      expect(ownerResp.statusCode).toBe(200);
      expect(
        ownerResp.json<{ application: ApplicationDto }>().application.snapshot?.totalAmount
      ).toBe(180);
    });

    it("一般他人完成 → 403（不因資源存在與否洩漏）", async () => {
      await seedCompletedTravel({ date: "2058-02-02", snapshotTotalKm: "30.00" });
      const id = await createCompletableDraft(2058);

      const resp = await completeHttp(otherCookie, id);
      expect(resp.statusCode).toBe(403);
      expect(resp.json<ErrorBody>().error.code).toBe("FORBIDDEN");
      expect((await prisma.application.findUniqueOrThrow({ where: { id } })).status).toBe("DRAFT");
    });

    it("管理員代操作端點不提供代完成路徑（負向斷言）", async () => {
      await seedCompletedTravel({ date: "2059-02-02", snapshotTotalKm: "30.00" });
      const id = await createCompletableDraft(2059);

      for (const url of [
        `/admin/applications/${id}/complete`,
        `/admin/users/${ownerId}/applications/${id}/complete`,
        `/admin/users/${ownerId}/applications/depreciation/${id}/complete`,
      ]) {
        const resp = await app.inject({ method: "POST", url, headers: { cookie: adminCookie } });
        expect(resp.statusCode).toBe(404);
      }
      expect((await prisma.application.findUniqueOrThrow({ where: { id } })).status).toBe("DRAFT");
    });
  });

  // ===========================================================================
  // AC-30 — 原子性（切點回滾、P2025 不得 500）
  // ===========================================================================

  describe("AC-30 原子性", () => {
    it("快照寫入後、狀態轉換前注入失敗 → 全交易回滾（status 仍 DRAFT、8 欄全 null、totalAmount 仍 null、附件仍可刪）", async () => {
      await seedCompletedTravel({ date: "2060-10-10", snapshotTotalKm: "80.00" });
      const id = await createDraft(2060);
      const attachmentId = await linkProof(id);

      const injectedMessage = "PHASE-007-T9-INJECTED-ATOMICITY-TEST-FAILURE";
      await expect(
        completeDepreciationApplication(prisma, id, {
          __testOnlyFailAfterSnapshotWrite: () => {
            throw new Error(injectedMessage);
          },
        })
      ).rejects.toThrow(injectedMessage);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.status).toBe("DRAFT");
      expect(dbApp.totalAmount).toBeNull();
      expect(dbApp.completedAt).toBeNull();

      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      expect(row.snapshotVehiclePrice).toBeNull();
      expect(row.snapshotUsefulLifeYears).toBeNull();
      expect(row.snapshotEstimatedAnnualKm).toBeNull();
      expect(row.snapshotPerKmUnitPrice).toBeNull();
      expect(row.snapshotOfficialKm).toBeNull();
      expect(row.snapshotRawAmount).toBeNull();
      expect(row.calculatedAt).toBeNull();
      expect(row.depreciationParameterVersionId).toBeNull();

      // 附件仍可刪（容器仍為草稿）。
      const delResp = await app.inject({
        method: "DELETE",
        url: `/attachments/${attachmentId}`,
        headers: { cookie: ownerCookie },
      });
      expect(delResp.statusCode).toBe(200);
    });

    it("反向對照：不注入失敗 → 快照與狀態全部正確落地", async () => {
      await seedCompletedTravel({ date: "2062-11-11", snapshotTotalKm: "90.00" });
      const id = await createCompletableDraft(2062);

      const record = await completeDepreciationApplication(prisma, id);
      expect(record.status).toBe("COMPLETED");
      // 90.00 × 2468.9999 = 222209.9910
      expect(record.totalAmount).toBe(222210);
      expect(record.completedAt).not.toBeNull();
      expect(record.depreciation?.snapshotOfficialKm?.toFixed(2)).toBe("90.00");
      expect(record.depreciation?.snapshotRawAmount?.toFixed(4)).toBe("222209.9910");
    });

    it("P2025（完成中被刪）→ 404 AppError，不得以 500 呈現", async () => {
      const id = await createCompletableDraft(2049);
      await prisma.application.delete({ where: { id } });

      let caught: unknown;
      try {
        await completeDepreciationApplication(prisma, id);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).httpStatus).toBe(404);
      expect((caught as AppError).code).toBe("NOT_FOUND");
      expect((caught as AppError).httpStatus).not.toBe(500);
    });
  });

  // ===========================================================================
  // T8 移交（AC-25 真實流程重驗）＋ T5 移交（AC-08 兩筆皆可完成）
  // ===========================================================================

  describe("跨 Task 移交項", () => {
    it("經真實完成端點完成之折舊，其證明附件 DELETE → 403（AC-25 真實流程重驗）", async () => {
      await seedCompletedTravel({ date: "2063-06-06", snapshotTotalKm: "60.00" });
      const id = await createDraft(2063);
      const attachmentId = await linkProof(id);

      // 完成前可刪之對照（另一張）。
      const spareId = await linkProof(id);
      const spareDel = await app.inject({
        method: "DELETE",
        url: `/attachments/${spareId}`,
        headers: { cookie: ownerCookie },
      });
      expect(spareDel.statusCode).toBe(200);

      expect((await completeHttp(ownerCookie, id)).statusCode).toBe(200);

      const delResp = await app.inject({
        method: "DELETE",
        url: `/attachments/${attachmentId}`,
        headers: { cookie: ownerCookie },
      });
      expect(delResp.statusCode).toBe(403);
      const still = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      expect(still.status).toBe("LINKED");
      expect(still.refId).toBe(id);
    });

    it("AC-08：同一擁有人同年度兩筆折舊申請**皆可完成**（皆 200，無唯一約束）", async () => {
      await seedCompletedTravel({ date: "2064-06-06", snapshotTotalKm: "70.00" });
      const first = await createCompletableDraft(2064);
      const second = await createCompletableDraft(2064);

      const r1 = await completeHttp(ownerCookie, first);
      const r2 = await completeHttp(ownerCookie, second);
      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      // 70.00 × 2468.9999 = 172829.9930
      expect(r1.json<{ application: ApplicationDto }>().application.snapshot?.totalAmount).toBe(
        172830
      );
      expect(r2.json<{ application: ApplicationDto }>().application.snapshot?.totalAmount).toBe(
        172830
      );
    });

    it("完成 vs 刪除證明附件之併發：12 輪皆恰一方成功，且不得 500", async () => {
      await seedCompletedTravel({ date: "2065-06-06", snapshotTotalKm: "40.00" });

      for (let round = 0; round < 12; round++) {
        const id = await createDraft(2065);
        const attachmentId = await linkProof(id);

        const [completeResp, deleteResp] = await Promise.all([
          completeHttp(ownerCookie, id),
          app.inject({
            method: "DELETE",
            url: `/attachments/${attachmentId}`,
            headers: { cookie: ownerCookie },
          }),
        ]);

        expect(completeResp.statusCode, `round ${round} complete`).toBeLessThan(500);
        expect(deleteResp.statusCode, `round ${round} delete`).toBeLessThan(500);

        const completeOk = completeResp.statusCode === 200;
        const deleteOk = deleteResp.statusCode === 200;
        expect(
          [completeOk, deleteOk].filter(Boolean).length,
          `round ${round}: complete=${completeResp.statusCode} delete=${deleteResp.statusCode}`
        ).toBe(1);

        // 事後 DB 狀態與勝方一致。
        const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
        const linked = await prisma.attachment.count({
          where: { refType: "DEPRECIATION", refId: id, status: "LINKED" },
        });
        if (completeOk) {
          expect(dbApp.status).toBe("COMPLETED");
          expect(dbApp.totalAmount).toBe(98760); // 40.00 × 2468.9999 = 98759.9960
          expect(linked).toBe(1);
        } else {
          expect(dbApp.status).toBe("DRAFT");
          expect(dbApp.totalAmount).toBeNull();
          expect(linked).toBe(0);
        }
      }
    });
  });
});
