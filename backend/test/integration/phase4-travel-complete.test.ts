/**
 * Integration tests for PHASE-004-T8 — 差旅完成流程 + 快照（最高風險 Task）
 *
 * Covers Spec §2 群組 H（AC-49/50/52/53/54）、AC-43、AC-48、群組 I（AC-58/59
 * 的完成端點面向）、D4（金額語意）、D6(c)（snapshot 含單價）、D7/C4
 * （completionBlockers 單一權威）、D13（403 FORBIDDEN 文案）、D14(i)（400
 * VALIDATION_ERROR + fields[] + details.blockers[]）、D17（本 Phase 不提供
 * 管理員代完成）。
 *
 * TDD: written to exercise the REAL HTTP route `POST /applications/:id/complete`
 * (routes.ts) and the exported `completeTravelApplication` service function
 * (travel-service.ts, called directly only for the AC-53 atomicity test, which
 * needs the test-only `__testOnlyFailAfterSnapshotWrite` injection option that
 * has no HTTP-level equivalent). First run (before this Task's implementation
 * existed) was RED — 404 on every `/applications/:id/complete` call (route did
 * not exist) and a compile error importing `completeTravelApplication` (export
 * did not exist). See Task Handoff for the captured first-run RED output.
 *
 * Test discipline (Spec §11.0 / Packet C5):
 *   - loginName prefix "p4tc_" + per-run random suffix (跨檔跨 fork 撞名防護)。
 *   - cleanup scoped to this suite's own tracked application/attachment/
 *     parameter-version ids + loginName prefix; NEVER deleteMany({}) globally.
 *   - synthetic data only (虛構人名、地名、出差目的)。
 *   - FuelParameterVersion/EtcParameterVersion `effectiveFrom` is a GLOBAL
 *     table across the whole test DB (no per-file scoping in
 *     `resolveTravelParameters`'s `findMany`) — every describe block below
 *     claims its OWN unused calendar year (2034~2040), mirroring the existing
 *     convention in phase4-travel-draft.test.ts (2032) and
 *     phase4-travel-preview.test.ts (2031), so this file's scenarios resolve
 *     deterministically regardless of what other test files concurrently
 *     have in the shared table.
 */
import { FuelType, Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeTravelApplication } from "../../src/applications/travel-service.js";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";
import { dateBeforeAnyKnownParameterVersion } from "./_param-version-floor-date.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Shared helpers (pattern per phase4-travel-draft.test.ts)
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
const LOGIN_PREFIX = "p4tc_";
const PASSWORD = "TravelCompleteTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;
const MCP_LOGIN = `${LOGIN_PREFIX}mcp_${RUN_ID}`;

const NONEXISTENT_ID = "p4tc-nonexistent-application-id-000000";

interface BlockerJson {
  code: string;
  field?: string;
  segmentId?: string;
  segmentIndex?: number;
  message: string;
}
interface ErrorJson {
  error: {
    code: string;
    message: string;
    fields?: { field: string; reason: string }[];
    details?: { blockers?: BlockerJson[]; missing?: string[]; tripDate?: string | null };
  };
}
interface SegmentSnapshotJson {
  fuelAmount: string;
  etcAmount: string;
  rawAmount: string;
  amount: number;
}
interface SegmentJson {
  id: string;
  sortOrder: number;
  origin: string | null;
  destination: string | null;
  totalKm: string | null;
  highwayKm: string | null;
  snapshot: SegmentSnapshotJson | null;
}
interface TravelSnapshotJson {
  fuelUnitPrice: string;
  etcUnitPrice: string;
  fuelParameterVersionId: string | null;
  etcParameterVersionId: string;
  fuelPriceVersionId: string | null;
  fuelConsumptionVersionId: string | null;
  totalKm: string;
  totalRawAmount: string;
  totalAmount: number;
  calculatedAt: string;
}
interface ApplicationJson {
  id: string;
  status: string;
  tripDate: string | null;
  purpose: string | null;
  segments: SegmentJson[];
  completionBlockers: BlockerJson[];
  computed: unknown | null;
  snapshot: TravelSnapshotJson | null;
  completedAt: string | null;
}

describeWithDb("PHASE-004-T8 — 差旅完成流程 + 快照", () => {
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
        storageKey: `p4tc-synthetic-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
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
   * PHASE-005a-T7: 新模型下油資單價依「擁有人（`ownerId`）油耗版本 → 該油種
   * 油價版本」雙鏈推導（不再直讀 `FuelParameterVersion`，該表已由 D1(a) 凍結
   * 為唯讀）。為保留本檔既有精確金額斷言（單價 5 → 段金額 = km × 5 等），
   * 以 `kmPerLiter="1.0000"` 讓推導結果 `ROUND_HALF_UP(pricePerLiter ÷ 1, 0)`
   * 恰等於原「每公里單價」數值——刻意的測試等價技巧，非改變 AC-18 公式本身。
   */
  async function createParamVersions(
    effectiveFrom: string,
    fuelPrice: string,
    etcPrice: string
  ): Promise<{ fuelVersionId: string; etcVersionId: string; consumptionId: string }> {
    const consumption = await prisma.userFuelConsumptionVersion.create({
      data: {
        userId: ownerId,
        fuelType: FuelType.GASOLINE_95,
        kmPerLiter: new Prisma.Decimal("1.0000"),
        effectiveFrom: new Date(effectiveFrom),
        basisNote: "p4t8 測試 fixture：kmPerLiter=1 使推導單價等於原每公里單價",
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
        unitPrice: new Prisma.Decimal(etcPrice),
        effectiveFrom: new Date(effectiveFrom),
        createdById: ownerId,
      },
    });
    createdFuelVersionIds.push(fuel.id);
    createdEtcVersionIds.push(etc.id);
    createdConsumptionIds.push(consumption.id);
    return { fuelVersionId: fuel.id, etcVersionId: etc.id, consumptionId: consumption.id };
  }

  async function createDraft(cookie: string, payload: Record<string, unknown> = {}) {
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

  async function completeHttp(cookie: string | undefined, id: string, payload?: unknown) {
    return app.inject({
      method: "POST",
      url: `/applications/${id}/complete`,
      headers: cookie ? { cookie } : {},
      payload,
    });
  }

  /**
   * Build a fully completable draft: owner-created, N segments each with one
   * LINKED attachment, tripDate/purpose set. Returns the application id and
   * ordered segment ids.
   */
  async function buildCompletableDraft(
    cookie: string,
    ownerIdForAttachments: string,
    input: {
      tripDate: string;
      purpose: string;
      segments: { origin: string; destination: string; totalKm: string; highwayKm: string }[];
    }
  ): Promise<{ applicationId: string; segmentIds: string[] }> {
    const applicationId = await createDraft(cookie, {});
    const putResp = await putSegments(
      cookie,
      applicationId,
      input.segments.map((s) => ({ ...s, attachmentIds: [] }))
    );
    expect(putResp.statusCode).toBe(200);
    const segmentIds = putResp
      .json<{ application: { segments: { id: string }[] } }>()
      .application.segments.map((s) => s.id);
    for (const segId of segmentIds) {
      await createLinkedAttachment(segId, ownerIdForAttachments);
    }
    const finalPut = await app.inject({
      method: "PUT",
      url: `/applications/travel/${applicationId}`,
      headers: { cookie },
      payload: { tripDate: input.tripDate, purpose: input.purpose },
    });
    expect(finalPut.statusCode).toBe(200);
    return { applicationId, segmentIds };
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);

    const owner = await prisma.user.create({
      data: {
        loginName: OWNER_LOGIN,
        displayName: "P4T8 擁有人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const other = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "P4T8 他人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "P4T8 管理員",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const mcp = await prisma.user.create({
      data: {
        loginName: MCP_LOGIN,
        displayName: "P4T8 待改密使用者",
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
      if (createdConsumptionIds.length > 0) {
        await prisma.userFuelConsumptionVersion.deleteMany({
          where: { id: { in: createdConsumptionIds } },
        });
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
  // AC-49/50 — 完整資料可完成 + 快照保存（成功路徑，含金額語意基本驗證）
  // ===========================================================================

  describe("AC-49/50 — 完整資料可完成 + 快照保存", () => {
    const FUEL_DATE = "2034-01-01";
    let fuelVersionId: string;
    let etcVersionId: string;
    let consumptionId: string;

    beforeAll(async () => {
      if (!DB_URL) return;
      const v = await createParamVersions(FUEL_DATE, "5.0000", "2.0000");
      fuelVersionId = v.fuelVersionId;
      etcVersionId = v.etcVersionId;
      consumptionId = v.consumptionId;
    });

    it("200，status=COMPLETED，回傳後端正式計算結果並正確保存所有快照欄位", async () => {
      const { applicationId, segmentIds } = await buildCompletableDraft(ownerCookie, ownerId, {
        tripDate: "2034-06-01",
        purpose: "台北出差核心成功案例",
        segments: [
          { origin: "台北", destination: "新竹", totalKm: "100.00", highwayKm: "40.00" },
          { origin: "新竹", destination: "台中", totalKm: "50.00", highwayKm: "10.00" },
        ],
      });

      const resp = await completeHttp(ownerCookie, applicationId);
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: ApplicationJson }>();
      const application = body.application;

      expect(application.status).toBe("COMPLETED");
      expect(application.completedAt).not.toBeNull();
      expect(application.completionBlockers).toEqual([]);
      expect(application.computed).toBeNull(); // D8: COMPLETED 不回 computed

      expect(application.snapshot).not.toBeNull();
      const snap = application.snapshot as TravelSnapshotJson;
      expect(snap.fuelUnitPrice).toBe("5.0000");
      expect(snap.etcUnitPrice).toBe("2.0000");
      // PHASE-005a-T7（§8.4 判別欄位）：新模型完成之申請，舊模型引用
      // 恆為 null；新模型引用（fuelPriceVersionId/fuelConsumptionVersionId）
      // 才是本次完成實際使用的來源版本。
      expect(snap.fuelParameterVersionId).toBeNull();
      expect(snap.fuelPriceVersionId).toBe(fuelVersionId);
      expect(snap.fuelConsumptionVersionId).toBe(consumptionId);
      expect(snap.etcParameterVersionId).toBe(etcVersionId);
      expect(snap.totalKm).toBe("150.00");
      expect(snap.totalRawAmount).toBe("850.0000");
      expect(snap.totalAmount).toBe(850);
      expect(typeof snap.calculatedAt).toBe("string");

      const seg1 = application.segments.find((s) => s.id === segmentIds[0]);
      const seg2 = application.segments.find((s) => s.id === segmentIds[1]);
      expect(seg1?.snapshot).toEqual({
        fuelAmount: "500.0000",
        etcAmount: "80.0000",
        rawAmount: "580.0000",
        amount: 580,
      });
      expect(seg2?.snapshot).toEqual({
        fuelAmount: "250.0000",
        etcAmount: "20.0000",
        rawAmount: "270.0000",
        amount: 270,
      });

      // DB 直查驗證（不只信任 API 回應）
      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect(dbApp.status).toBe("COMPLETED");
      expect(dbApp.totalAmount).toBe(850);
      expect(dbApp.completedAt).not.toBeNull();

      // 重新 GET 亦回相同快照（非僅完成當下回應正確、之後讀取又不同）
      const getResp = await app.inject({
        method: "GET",
        url: `/applications/travel/${applicationId}`,
        headers: { cookie: ownerCookie },
      });
      expect(getResp.statusCode).toBe(200);
      const getSnap = getResp.json<{ application: ApplicationJson }>().application.snapshot;
      expect(getSnap?.totalAmount).toBe(850);
    });
  });

  // ===========================================================================
  // AC-47 — 缺參數不得完成（409 PARAMETER_NOT_AVAILABLE，與 400 完全獨立）
  // ===========================================================================

  describe("AC-47 — 缺參數不得完成", () => {
    it("出差日期無任何有效油資/ETC 版本 → 409 PARAMETER_NOT_AVAILABLE，details.missing=[FUEL_CONSUMPTION,ETC]（B-05），狀態不變", async () => {
      // PHASE-004-R3（機制 B 修復）：原寫死 "2020-01-01"（註解自承「早於全域
      // 任何已知版本」——一個從未被驗證過的假設，見 Task Handoff「機制 B 根因
      // 與證據」）改為當場查詢 DB 真實狀態動態算出，恆早於現存所有版本，不論
      // 平行執行的其他測試檔用什麼年份。
      const tripDate = await dateBeforeAnyKnownParameterVersion(prisma);
      const { applicationId } = await buildCompletableDraft(ownerCookie, ownerId, {
        tripDate,
        purpose: "缺參數測試",
        segments: [{ origin: "A", destination: "B", totalKm: "10.00", highwayKm: "0.00" }],
      });

      const resp = await completeHttp(ownerCookie, applicationId);
      expect(resp.statusCode).toBe(409);
      const body = resp.json<ErrorJson>();
      expect(body.error.code).toBe("PARAMETER_NOT_AVAILABLE");
      expect(body.error.details?.missing).toEqual(
        expect.arrayContaining(["FUEL_CONSUMPTION", "ETC"])
      );

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect(dbApp.status).toBe("DRAFT");
      expect(dbApp.totalAmount).toBeNull();
    });
  });

  // ===========================================================================
  // AC-48 — 完成後新增參數版本不改變歷史金額（快照不變性，最高優先鑑別力測試）
  // ===========================================================================

  describe("AC-48 — 快照不變性", () => {
    const V1_DATE = "2035-01-01";
    const V2_DATE = "2035-03-01"; // 早於 tripDate、晚於 V1 —— 若曾重算，findEffectiveVersion 必改選 V2
    const TRIP_DATE = "2035-06-01";

    it("完成 → 新增更早生效日的新版本（單價不同）→ 重讀單價/各段金額/整筆金額完全不變", async () => {
      const v1 = await createParamVersions(V1_DATE, "5.0000", "2.0000");

      const { applicationId, segmentIds } = await buildCompletableDraft(ownerCookie, ownerId, {
        tripDate: TRIP_DATE,
        purpose: "快照不變性測試",
        segments: [{ origin: "X", destination: "Y", totalKm: "20.00", highwayKm: "10.00" }],
      });

      const completeResp = await completeHttp(ownerCookie, applicationId);
      expect(completeResp.statusCode).toBe(200);
      const before = completeResp.json<{ application: ApplicationJson }>().application;
      expect(before.snapshot?.fuelUnitPrice).toBe("5.0000");
      expect(before.snapshot?.etcUnitPrice).toBe("2.0000");
      expect(before.snapshot?.totalAmount).toBe(120); // 20*5 + 10*2 = 120
      expect(before.segments[0].snapshot?.amount).toBe(120);

      // 新增一個「更早生效日」且單價明顯不同的後續版本——若完成後重讀時曾經
      // 重算，findEffectiveVersion 對 TRIP_DATE 必然改選這個新版本。
      await createParamVersions(V2_DATE, "9.9999", "8.8888");

      const getResp = await app.inject({
        method: "GET",
        url: `/applications/travel/${applicationId}`,
        headers: { cookie: ownerCookie },
      });
      expect(getResp.statusCode).toBe(200);
      const after = getResp.json<{ application: ApplicationJson }>().application;

      expect(after.snapshot?.fuelUnitPrice).toBe("5.0000"); // 非 9.9999
      expect(after.snapshot?.etcUnitPrice).toBe("2.0000"); // 非 8.8888
      expect(after.snapshot?.fuelParameterVersionId).toBeNull(); // 新模型：舊欄位恆 null
      expect(after.snapshot?.fuelPriceVersionId).toBe(v1.fuelVersionId);
      expect(after.snapshot?.etcParameterVersionId).toBe(v1.etcVersionId);
      expect(after.snapshot?.totalAmount).toBe(120); // 非重算後的值
      const seg = after.segments.find((s) => s.id === segmentIds[0]);
      expect(seg?.snapshot?.amount).toBe(120);
      expect(seg?.snapshot?.fuelAmount).toBe("100.0000");
      expect(seg?.snapshot?.etcAmount).toBe("20.0000");
    });
  });

  // ===========================================================================
  // 金額語意鑑別力（AC-39/40/41）——先加再取整、half-up 非 half-even、
  // Σ 已取整金額非「先加未取整再取整」
  // ===========================================================================

  describe("金額語意鑑別力（AC-39/40/41，經真實完成端點驗證，非僅單元測試）", () => {
    const MONEY_DATE = "2036-01-01";

    it("段內先加再取整（0.4+0.4→1 非 0）+ half-up（2.5→3 非 2）+ 整筆為 Σ 已取整（4 非 3）", async () => {
      await createParamVersions(MONEY_DATE, "5.0000", "5.0000");

      const { applicationId, segmentIds } = await buildCompletableDraft(ownerCookie, ownerId, {
        tripDate: "2036-06-01",
        purpose: "金額語意鑑別力",
        segments: [
          // fuel=0.08*5=0.4000, etc=0.08*5=0.4000, raw=0.8000 → round=1
          // （若誤為「各自取整再相加」：round(0.4)+round(0.4)=0+0=0）
          { origin: "M1", destination: "M1-to", totalKm: "0.08", highwayKm: "0.08" },
          // fuel=0.5*5=2.5000, etc=0, raw=2.5000 → half-up round=3
          // （half-even 會得 2，因 2 為偶數）
          { origin: "M2", destination: "M2-to", totalKm: "0.50", highwayKm: "0.00" },
        ],
      });

      const resp = await completeHttp(ownerCookie, applicationId);
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: ApplicationJson }>().application;

      const seg1 = application.segments.find((s) => s.id === segmentIds[0]);
      const seg2 = application.segments.find((s) => s.id === segmentIds[1]);
      expect(seg1?.snapshot?.rawAmount).toBe("0.8000");
      expect(seg1?.snapshot?.amount).toBe(1); // AC-39 鑑別力：非 0
      expect(seg2?.snapshot?.rawAmount).toBe("2.5000");
      expect(seg2?.snapshot?.amount).toBe(3); // AC-40 鑑別力：half-up，非 half-even 的 2

      // AC-41 鑑別力：整筆 = Σ 各段已取整 = 1+3 = 4；
      // 若誤為「Σ 各段取整前」再取整：round(0.8+2.5)=round(3.3)=3（非 4）。
      expect(application.snapshot?.totalRawAmount).toBe("3.3000");
      expect(application.snapshot?.totalAmount).toBe(4);
    });
  });

  // ===========================================================================
  // AC-43 — 任一段資料無效則整筆不得完成，前面的段亦不得落地任何快照
  // ===========================================================================

  describe("AC-43 — 部分落地防護", () => {
    it("3 段中第 3 段 highwayKm>totalKm → 400，前 2 段（有效）與第 3 段（無效）snapshot 全為 null", async () => {
      const { applicationId, segmentIds } = await buildCompletableDraft(ownerCookie, ownerId, {
        tripDate: "2020-02-02", // 不需真實參數——會在②完整性驗證就被擋下，不會走到③參數檢查
        purpose: "部分落地防護測試",
        segments: [
          { origin: "P1", destination: "P1-to", totalKm: "10.00", highwayKm: "0.00" },
          { origin: "P2", destination: "P2-to", totalKm: "10.00", highwayKm: "0.00" },
          { origin: "P3", destination: "P3-to", totalKm: "10.00", highwayKm: "15.00" }, // 無效
        ],
      });

      const resp = await completeHttp(ownerCookie, applicationId);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorJson>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      const codes = (body.error.details?.blockers ?? []).map((b) => b.code);
      expect(codes).toContain("SEGMENT_HIGHWAY_GT_TOTAL");

      const segmentRows = await prisma.tripSegment.findMany({
        where: { id: { in: segmentIds } },
      });
      expect(segmentRows).toHaveLength(3);
      for (const row of segmentRows) {
        expect(row.snapshotFuelAmount).toBeNull();
        expect(row.snapshotEtcAmount).toBeNull();
        expect(row.snapshotRawAmount).toBeNull();
        expect(row.snapshotAmount).toBeNull();
      }

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect(dbApp.status).toBe("DRAFT");
      expect(dbApp.totalAmount).toBeNull();
      expect(dbApp.completedAt).toBeNull();
    });
  });

  // ===========================================================================
  // AC-52 — 必要欄位不完整則拒絕並列出全部未通過項（非只回第一項）
  // ===========================================================================

  describe("AC-52 — 全部錯誤項", () => {
    it("同時缺出差目的、第2段缺附件、第3段里程無效 → 回應同時含三項，各自可定位", async () => {
      const applicationId = await createDraft(ownerCookie, {});
      const putResp = await putSegments(ownerCookie, applicationId, [
        { origin: "Q1", destination: "Q1-to", totalKm: "10.00", highwayKm: "0.00" },
        { origin: "Q2", destination: "Q2-to", totalKm: "10.00", highwayKm: "0.00" }, // 缺附件
        { origin: "Q3", destination: "Q3-to", totalKm: "10.00", highwayKm: "15.00" }, // 里程無效
      ]);
      expect(putResp.statusCode).toBe(200);
      const segs = putResp.json<{ application: { segments: { id: string }[] } }>().application
        .segments;
      await createLinkedAttachment(segs[0].id, ownerId);
      // segs[1]: 刻意不建立附件
      await createLinkedAttachment(segs[2].id, ownerId);

      await app.inject({
        method: "PUT",
        url: `/applications/travel/${applicationId}`,
        headers: { cookie: ownerCookie },
        payload: { tripDate: "2020-03-03", purpose: null }, // purpose 缺
      });

      const resp = await completeHttp(ownerCookie, applicationId);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorJson>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      const blockers = body.error.details?.blockers ?? [];
      expect(blockers).toHaveLength(3);
      const codes = blockers.map((b) => b.code);
      expect(codes).toEqual(
        expect.arrayContaining([
          "PURPOSE_REQUIRED",
          "SEGMENT_ATTACHMENT_REQUIRED",
          "SEGMENT_HIGHWAY_GT_TOTAL",
        ])
      );
      const attBlocker = blockers.find((b) => b.code === "SEGMENT_ATTACHMENT_REQUIRED");
      expect(attBlocker?.segmentId).toBe(segs[1].id);
      const mileageBlocker = blockers.find((b) => b.code === "SEGMENT_HIGHWAY_GT_TOTAL");
      expect(mileageBlocker?.segmentId).toBe(segs[2].id);
    });
  });

  // ===========================================================================
  // AC-54 — 完成端點忽略任何金額 body
  // ===========================================================================

  describe("AC-54 — body 金額忽略", () => {
    const FUEL_DATE = "2037-01-01";

    it("body 帶 totalAmount=999999 → 落地金額為後端計算值（非 999999）", async () => {
      await createParamVersions(FUEL_DATE, "5.0000", "2.0000");
      const { applicationId } = await buildCompletableDraft(ownerCookie, ownerId, {
        tripDate: "2037-06-01",
        purpose: "金額忽略測試",
        segments: [{ origin: "R1", destination: "R1-to", totalKm: "10.00", highwayKm: "0.00" }],
      });

      const resp = await completeHttp(ownerCookie, applicationId, {
        totalAmount: 999999,
        amount: 999999,
        fuelAmount: "999999.0000",
      });
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: ApplicationJson }>().application;
      expect(application.snapshot?.totalAmount).toBe(50); // 10*5 = 50
      expect(application.snapshot?.totalAmount).not.toBe(999999);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect(dbApp.totalAmount).toBe(50);
    });
  });

  // ===========================================================================
  // AC-53 — 完成為原子操作（雙向：注入失敗 → 全部不落地；反向 → 成功路徑全部落地）
  // ===========================================================================

  describe("AC-53 — 原子性（雙向鑑別力）", () => {
    const FUEL_DATE = "2038-01-01";

    it("快照寫入後、狀態轉換前注入失敗 → status 仍 DRAFT，所有 snapshot 欄位仍為 null，附件仍可修改", async () => {
      await createParamVersions(FUEL_DATE, "5.0000", "2.0000");
      const { applicationId, segmentIds } = await buildCompletableDraft(ownerCookie, ownerId, {
        tripDate: "2038-06-01",
        purpose: "原子性鑑別力（失敗切點）",
        segments: [{ origin: "S1", destination: "S1-to", totalKm: "10.00", highwayKm: "0.00" }],
      });

      const injectedMessage = "PHASE-004-T8-INJECTED-ATOMICITY-TEST-FAILURE";
      await expect(
        completeTravelApplication(prisma, applicationId, {
          __testOnlyFailAfterSnapshotWrite: () => {
            throw new Error(injectedMessage);
          },
        })
      ).rejects.toThrow(injectedMessage);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect(dbApp.status).toBe("DRAFT");
      expect(dbApp.totalAmount).toBeNull();
      expect(dbApp.completedAt).toBeNull();

      const dbTravel = await prisma.travelApplication.findUniqueOrThrow({
        where: { applicationId },
      });
      expect(dbTravel.fuelUnitPrice).toBeNull();
      expect(dbTravel.etcUnitPrice).toBeNull();
      expect(dbTravel.fuelParameterVersionId).toBeNull();
      expect(dbTravel.etcParameterVersionId).toBeNull();
      expect(dbTravel.snapshotTotalKm).toBeNull();
      expect(dbTravel.snapshotRawAmount).toBeNull();
      expect(dbTravel.calculatedAt).toBeNull();

      const dbSegment = await prisma.tripSegment.findUniqueOrThrow({
        where: { id: segmentIds[0] },
      });
      expect(dbSegment.snapshotFuelAmount).toBeNull();
      expect(dbSegment.snapshotEtcAmount).toBeNull();
      expect(dbSegment.snapshotRawAmount).toBeNull();
      expect(dbSegment.snapshotAmount).toBeNull();

      // 附件仍可修改（草稿未鎖定）——證明失敗後容器狀態仍是 draft，非
      // "completed"（否則這個 PUT 會被 assertApplicationMutable 擋成 403）。
      const mutateResp = await putSegments(ownerCookie, applicationId, [
        { id: segmentIds[0], attachmentIds: [] },
      ]);
      expect(mutateResp.statusCode).toBe(200);
    });

    it("反向：不注入失敗（正常呼叫 completeTravelApplication）→ 全部正確落地", async () => {
      const { applicationId, segmentIds } = await buildCompletableDraft(ownerCookie, ownerId, {
        tripDate: "2038-06-02",
        purpose: "原子性鑑別力（成功路徑）",
        segments: [{ origin: "S2", destination: "S2-to", totalKm: "10.00", highwayKm: "0.00" }],
      });

      const record = await completeTravelApplication(prisma, applicationId);
      expect(record.status).toBe("COMPLETED");
      expect(record.totalAmount).toBe(50); // 10*5=50
      expect(record.completedAt).not.toBeNull();
      expect(record.travel?.fuelUnitPrice?.toString()).toBe("5");
      expect(record.travel?.etcUnitPrice?.toString()).toBe("2");
      expect(record.travel?.calculatedAt).not.toBeNull();

      const dbSegment = await prisma.tripSegment.findUniqueOrThrow({
        where: { id: segmentIds[0] },
      });
      expect(dbSegment.snapshotAmount).toBe(50);
    });
  });

  // ===========================================================================
  // AC-59 — 已完成的業務欄位與附件皆凍結（端到端：走真實完成流程，非 DB 捷徑）
  // ===========================================================================

  describe("AC-59 — 完成後凍結生效（真實完成流程 + 逐項嘗試）", () => {
    const FUEL_DATE = "2039-01-01";
    let applicationId: string;
    let segmentId: string;
    let attachmentId: string;

    beforeAll(async () => {
      if (!DB_URL) return;
      await createParamVersions(FUEL_DATE, "5.0000", "2.0000");
      const built = await buildCompletableDraft(ownerCookie, ownerId, {
        tripDate: "2039-06-01",
        purpose: "凍結測試原始目的",
        segments: [{ origin: "F1", destination: "F1-to", totalKm: "10.00", highwayKm: "0.00" }],
      });
      applicationId = built.applicationId;
      segmentId = built.segmentIds[0];

      const completeResp = await completeHttp(ownerCookie, applicationId);
      expect(completeResp.statusCode).toBe(200);
      const application = completeResp.json<{ application: ApplicationJson }>().application;
      const seg = application.segments.find((s) => s.id === segmentId);
      const attRows = await prisma.attachment.findMany({
        where: { refType: "TRIP_SEGMENT", refId: seg?.id },
      });
      attachmentId = attRows[0]?.id ?? "";
    });

    it("PUT 變更出差日期 → 403 FORBIDDEN", async () => {
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${applicationId}`,
        headers: { cookie: ownerCookie },
        payload: { tripDate: "2039-07-01" },
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<ErrorJson>().error.code).toBe("FORBIDDEN");
    });

    it("PUT 變更出差目的 → 403 FORBIDDEN，原目的未變", async () => {
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${applicationId}`,
        headers: { cookie: ownerCookie },
        payload: { purpose: "竄改目的" },
      });
      expect(resp.statusCode).toBe(403);
      const row = await prisma.travelApplication.findUniqueOrThrow({ where: { applicationId } });
      expect(row.purpose).toBe("凍結測試原始目的");
    });

    it("PUT 變更既有段落欄位 → 403 FORBIDDEN", async () => {
      const resp = await putSegments(ownerCookie, applicationId, [
        { id: segmentId, origin: "竄改起點" },
      ]);
      expect(resp.statusCode).toBe(403);
    });

    it("PUT 新增行程段 → 403 FORBIDDEN", async () => {
      const resp = await putSegments(ownerCookie, applicationId, [
        { id: segmentId },
        { origin: "新段", destination: "新段-to", totalKm: "5", highwayKm: "0", attachmentIds: [] },
      ]);
      expect(resp.statusCode).toBe(403);
    });

    it("PUT 刪除所有行程段（segments: []）→ 403 FORBIDDEN，段落未刪除", async () => {
      const resp = await putSegments(ownerCookie, applicationId, []);
      expect(resp.statusCode).toBe(403);
      const row = await prisma.tripSegment.findUnique({ where: { id: segmentId } });
      expect(row).not.toBeNull();
    });

    it("PUT 變更段落附件關聯（attachmentIds）→ 403 FORBIDDEN", async () => {
      const resp = await putSegments(ownerCookie, applicationId, [
        { id: segmentId, attachmentIds: [] },
      ]);
      expect(resp.statusCode).toBe(403);
    });

    it("DELETE 附件 → 403 FORBIDDEN，附件仍 LINKED", async () => {
      expect(attachmentId).not.toBe("");
      const resp = await app.inject({
        method: "DELETE",
        url: `/attachments/${attachmentId}`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(403);
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      expect(row.status).toBe("LINKED");
    });

    it("再次 POST complete（雙重完成）→ 403 FORBIDDEN，D13 文案", async () => {
      const resp = await completeHttp(ownerCookie, applicationId);
      expect(resp.statusCode).toBe(403);
      const body = resp.json<ErrorJson>();
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toContain("已完成的申請不可修改");
      expect(body.error.message).toContain("建立修正版");
    });
  });

  // ===========================================================================
  // D17 — 管理員不得代完成；權限矩陣
  // ===========================================================================

  describe("D17 — 管理員不得代完成 + 權限矩陣", () => {
    const FUEL_DATE = "2040-01-01";

    beforeAll(async () => {
      if (!DB_URL) return;
      await createParamVersions(FUEL_DATE, "5.0000", "2.0000");
      // PHASE-005a-T7: 本 describe 有一條案例是「管理員完成自己擁有的申請」
      // （非代操作），故 adminId 本身也需要一筆油耗版本（createParamVersions
      // 只為共用的 ownerId 建立）。
      const adminConsumption = await prisma.userFuelConsumptionVersion.create({
        data: {
          userId: adminId,
          fuelType: FuelType.GASOLINE_95,
          kmPerLiter: new Prisma.Decimal("1.0000"),
          effectiveFrom: new Date(FUEL_DATE),
          basisNote: "p4t8 D17 fixture：管理員完成自己擁有的申請",
          createdById: adminId,
        },
      });
      createdConsumptionIds.push(adminConsumption.id);
    });

    it("他人一般使用者呼叫 complete → 403 FORBIDDEN，狀態不變", async () => {
      const applicationId = await createDraft(ownerCookie, {});
      const resp = await completeHttp(otherCookie, applicationId);
      expect(resp.statusCode).toBe(403);
      expect(resp.json<ErrorJson>().error.code).toBe("FORBIDDEN");
      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect(dbApp.status).toBe("DRAFT");
    });

    it("管理員（非擁有人）呼叫 complete → 403 FORBIDDEN（D17：本 Phase 不提供代完成）", async () => {
      const { applicationId } = await buildCompletableDraft(ownerCookie, ownerId, {
        tripDate: "2040-06-01",
        purpose: "D17 測試——管理員不得代完成",
        segments: [{ origin: "D1", destination: "D1-to", totalKm: "10.00", highwayKm: "0.00" }],
      });

      const resp = await completeHttp(adminCookie, applicationId);
      expect(resp.statusCode).toBe(403);
      expect(resp.json<ErrorJson>().error.code).toBe("FORBIDDEN");

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect(dbApp.status).toBe("DRAFT");
      expect(dbApp.totalAmount).toBeNull();
    });

    it("管理員完成「自己擁有」的差旅（非代操作）→ 200（證明擋的是「非擁有人」而非「ADMIN 角色」）", async () => {
      const { applicationId } = await buildCompletableDraft(adminCookie, adminId, {
        tripDate: "2040-06-02",
        purpose: "管理員完成自己的申請",
        segments: [{ origin: "D2", destination: "D2-to", totalKm: "10.00", highwayKm: "0.00" }],
      });

      const resp = await completeHttp(adminCookie, applicationId);
      expect(resp.statusCode).toBe(200);
      expect(resp.json<{ application: ApplicationJson }>().application.status).toBe("COMPLETED");
    });

    it("未登入呼叫 complete → 401 UNAUTHORIZED", async () => {
      const applicationId = await createDraft(ownerCookie, {});
      const resp = await completeHttp(undefined, applicationId);
      expect(resp.statusCode).toBe(401);
      expect(resp.json<ErrorJson>().error.code).toBe("UNAUTHORIZED");
    });

    it("強制改密使用者呼叫 complete → 403 PASSWORD_CHANGE_REQUIRED（早於資源存在性判定）", async () => {
      const resp = await completeHttp(mcpCookie, NONEXISTENT_ID);
      expect(resp.statusCode).toBe(403);
      expect(resp.json<ErrorJson>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    });

    it("不存在的資源 id → 404 NOT_FOUND", async () => {
      const resp = await completeHttp(ownerCookie, NONEXISTENT_ID);
      expect(resp.statusCode).toBe(404);
      expect(resp.json<ErrorJson>().error.code).toBe("NOT_FOUND");
    });
  });
});
