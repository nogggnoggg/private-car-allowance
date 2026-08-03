import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Integration tests for PHASE-005a-T8 — 差旅完成流程快照擴充 ＋ 取整層級 ＋
 * 不可變 ＋ 後端權威（後端鏈最終 Task）。
 *
 * Spec §2.D AC-19/24、§2.E AC-25/26、§9.3、§16 D4(a)（逐字引用見 Task
 * Context Packet；此處只複述測試需要的關鍵數值）：
 *
 *   AC-19 — segFuel = K×U（未取整）→ segEtc = H×E（未取整）→ segRaw = segFuel+segEtc
 *     （先相加）→ segAmt = ROUND_HALF_UP(segRaw, 0)；totalAmount = Σ segAmt。
 *     取整恰兩處（單價推導 AC-18 ＋ 本條）。鑑別例：K=0.50, U=3, H=0.25,
 *     E=2.0000 → segFuel=1.5、segEtc=0.5、segRaw=2.0、segAmt=2；若先各自取整
 *     （segFuel→2、segEtc→1）則得 3 → 必紅。`calculateTravel` 演算法零改動
 *     （本 Task 只改 fuelUnitPrice 之來源）。
 *   AC-20 — 推導單價 |U| ≥ 1e6 → 依 D4(a) 回 409，絕不 500、絕不靜默截斷。
 *   AC-24 — body/query 夾帶 fuelUnitPrice/pricePerLiter/kmPerLiter/amount/
 *     totalAmount（合法或畸形值皆然）→ 一律忽略；輸出恆為後端計算值；不得因
 *     夾帶而 500。
 *   AC-25 — 完成快照含 snapshotFuelType/snapshotFuelPricePerLiter/
 *     snapshotFuelConsumption/fuelUnitPrice/etcUnitPrice/snapshotRawAmount/
 *     Application.totalAmount ＋ fuelPriceVersionId/fuelConsumptionVersionId/
 *     etcParameterVersionId。可重現性：以快照三來源值獨立重算
 *     ROUND_HALF_UP(price÷consumption,0) 斷言等於 fuelUnitPrice；再以
 *     fuelUnitPrice×里程重算段金額斷言等於 snapshotAmount。
 *   AC-26 — 完成後新增油價/油耗版本（更早或更晚生效）→ 快照逐位元不變；GET
 *     不重新解析（不呼叫 resolveTravelParameters）。
 *   T7 複審 SF-2 — out-of-range/data-corrupted 兩情境下 DTO（草稿/預覽）須
 *     暴露 parameterAvailable=false，不得以單價 0 顯示金額為最終值。
 *   T2 複審 AR-2 — 段金額/totalAmount 溢位邊界：不得 500、不得靜默截斷。
 *
 * TDD: written BEFORE this Task's `travel-service.ts`/`completion-blockers.ts`
 * changes existed — first run RED（新快照欄位未寫入、SF-2 DTO 狀態未接線、
 * AR-2 守門不存在）。見 Task Handoff 之 RED/GREEN 證據。
 *
 * Isolation: 本檔使用 sentinel 年份區段 2061~2067（未被既有測試檔使用，見
 * Handoff 之 grep 佐證）；loginName 前綴 "t8complete_" + per-run 亂數字尾；
 * 每個 describe 使用獨立 owner 使用者與獨立年份，避免跨 describe 之全域
 * FuelPriceVersion/EtcParameterVersion 資料互相干擾；cleanup 僅限本檔自建
 * id，嚴禁 deleteMany({}) 全域刪除；全程合成資料。
 */
import { FuelType, Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as travelParameters from "../../src/applications/travel-parameters.js";
import { hashPassword } from "../../src/auth/password.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

// PHASE-005a-T8 SF-2/AC-26 鑑別力：需要對 `resolveTravelParameters` 設 spy
// （呼叫次數斷言），保留真實實作作為預設值（僅 wrap，行為不變）。
vi.mock("../../src/applications/travel-parameters.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/applications/travel-parameters.js")>();
  return {
    ...actual,
    resolveTravelParameters: vi.fn(actual.resolveTravelParameters),
  };
});

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0];
}

async function loginUser(app: FastifyInstance, loginName: string, password: string) {
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
const LOGIN_PREFIX = "t8complete_";
const PASSWORD = "T8CompleteTest99!";

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
  snapshotFuelType: string | null;
  snapshotFuelPricePerLiter: string | null;
  snapshotFuelConsumption: string | null;
  totalKm: string;
  totalRawAmount: string;
  totalAmount: number;
  calculatedAt: string;
}
interface ComputedJson {
  parameterAvailable: boolean;
  missingParameters: string[];
  totalAmount: number;
}
interface ApplicationJson {
  id: string;
  status: string;
  segments: SegmentJson[];
  completionBlockers: BlockerJson[];
  computed: ComputedJson | null;
  snapshot: TravelSnapshotJson | null;
}

// ---------------------------------------------------------------------------
// §0 AC-19 實作約束鑑別力: calculateTravel 零改動（sha256 blob hash 比對；
// 不需 DB，恆執行）。此雜湊值於本 Task 撰寫測試之時、任何本 Task 的原始碼
// 編輯之前，由 `node -e "crypto.createHash('sha256')..."` 對
// `src/applications/travel-calculation.ts` 之現有內容算出（等同 T2 之基準版
// 本——AC-19 明文禁止本 Task 改動該檔任何一行，若日後（本 Task 或誤觸）
// 修改該檔哪怕一個字元，本測試必紅）。
// ---------------------------------------------------------------------------
describe("AC-19 取整恰兩處", () => {
  it("calculateTravel is reused verbatim — only the fuelUnitPrice source changed", () => {
    const src = fs.readFileSync(
      path.resolve(BACKEND_ROOT, "src/applications/travel-calculation.ts"),
      "utf8"
    );
    const hash = crypto.createHash("sha256").update(src, "utf8").digest("hex");
    expect(hash).toBe("9aab8129ebb17aabac0fcd709cfcd7c6fceb2521b87dc02daab1b95dba9c560c");
  });
});

describeWithDb("PHASE-005a-T8 — 差旅完成流程快照擴充 ＋ 取整層級 ＋ 不可變 ＋ 後端權威", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdConsumptionIds: string[] = [];
  const createdPriceIds: string[] = [];
  const createdEtcIds: string[] = [];

  async function createOwner(labelSuffix: string): Promise<{ id: string; cookie: string }> {
    const loginName = `${LOGIN_PREFIX}${labelSuffix}_${RUN_ID}`;
    const user = await prisma.user.create({
      data: {
        loginName,
        displayName: `T8 擁有人 ${labelSuffix}`,
        passwordHash: await hashPassword(PASSWORD),
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    createdUserIds.push(user.id);
    const cookie = await loginUser(app, loginName, PASSWORD);
    return { id: user.id, cookie };
  }

  async function createEtc(effectiveFrom: string, unitPrice: string, byUserId: string) {
    const etc = await prisma.etcParameterVersion.create({
      data: {
        unitPrice: new Prisma.Decimal(unitPrice),
        effectiveFrom: new Date(effectiveFrom),
        createdById: byUserId,
      },
    });
    createdEtcIds.push(etc.id);
    return etc;
  }

  async function createConsumption(
    ownerId: string,
    fuelType: FuelType,
    kmPerLiter: string,
    effectiveFrom: string
  ) {
    const c = await prisma.userFuelConsumptionVersion.create({
      data: {
        userId: ownerId,
        fuelType,
        kmPerLiter: new Prisma.Decimal(kmPerLiter),
        effectiveFrom: new Date(effectiveFrom),
        basisNote: "t8complete 測試 fixture",
        createdById: ownerId,
      },
    });
    createdConsumptionIds.push(c.id);
    return c;
  }

  async function createPrice(
    fuelType: FuelType,
    pricePerLiter: string,
    effectiveFrom: string,
    byUserId: string
  ) {
    const p = await prisma.fuelPriceVersion.create({
      data: {
        fuelType,
        pricePerLiter: new Prisma.Decimal(pricePerLiter),
        effectiveFrom: new Date(effectiveFrom),
        createdById: byUserId,
      },
    });
    createdPriceIds.push(p.id);
    return p;
  }

  async function createDraft(cookie: string) {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/travel",
      headers: { cookie },
      payload: {},
    });
    expect(resp.statusCode).toBe(201);
    const id = resp.json<{ application: { id: string } }>().application.id;
    createdApplicationIds.push(id);
    return id;
  }

  async function completeHttp(cookie: string, id: string, payload?: unknown) {
    return app.inject({
      method: "POST",
      url: `/applications/${id}/complete`,
      headers: { cookie },
      payload,
    });
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    app = await import("../../src/server.js").then((m) =>
      m.buildServer({ databaseUrl: DB_URL, logLevel: "error" })
    );
    await app.ready();
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
      if (createdPriceIds.length > 0) {
        await prisma.fuelPriceVersion.deleteMany({ where: { id: { in: createdPriceIds } } });
      }
      if (createdEtcIds.length > 0) {
        await prisma.etcParameterVersion.deleteMany({ where: { id: { in: createdEtcIds } } });
      }
      if (createdConsumptionIds.length > 0) {
        await prisma.userFuelConsumptionVersion.deleteMany({
          where: { id: { in: createdConsumptionIds } },
        });
      }
      if (createdUserIds.length > 0) {
        await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
        await prisma.auditLog.deleteMany({
          where: {
            OR: [{ actorId: { in: createdUserIds } }, { targetId: { in: createdUserIds } }],
          },
        });
      }
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
  });

  /** Save segments (with a synthetic LINKED attachment each) + tripDate/purpose in two PUTs. */
  async function buildSegmentsWithAttachments(
    cookie: string,
    ownerIdForAttachments: string,
    id: string,
    tripDate: string,
    purpose: string,
    segments: { origin: string; destination: string; totalKm: string; highwayKm: string }[]
  ) {
    const putSeg = await app.inject({
      method: "PUT",
      url: `/applications/travel/${id}`,
      headers: { cookie },
      payload: { segments: segments.map((s) => ({ ...s, attachmentIds: [] })) },
    });
    expect(putSeg.statusCode).toBe(200);
    const segmentIds = putSeg
      .json<{ application: { segments: { id: string }[] } }>()
      .application.segments.map((s) => s.id);

    for (const segId of segmentIds) {
      const att = await prisma.attachment.create({
        data: {
          status: "LINKED",
          storageKey: `t8complete-synthetic-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
          mimeType: "image/jpeg",
          byteSize: 123,
          originalFilename: "synthetic.jpg",
          uploaderId: ownerIdForAttachments,
          ownerId: ownerIdForAttachments,
          refType: "TRIP_SEGMENT",
          refId: segId,
          linkedAt: new Date(),
        },
      });
      createdAttachmentIds.push(att.id);
    }

    const putMeta = await app.inject({
      method: "PUT",
      url: `/applications/travel/${id}`,
      headers: { cookie },
      payload: { tripDate, purpose },
    });
    expect(putMeta.statusCode).toBe(200);
    return segmentIds;
  }

  // =========================================================================
  // AC-19 鑑別力（金額語意）— 0.50/0.25 取整例
  // =========================================================================
  describe("AC-19 取整恰兩處（整合層）", () => {
    const YEAR = "2061";
    let ownerId: string;
    let ownerCookie: string;

    beforeAll(async () => {
      if (!DB_URL) return;
      const owner = await createOwner("ac19");
      ownerId = owner.id;
      ownerCookie = owner.cookie;
      await createConsumption(ownerId, FuelType.GASOLINE_92, "10.0000", `${YEAR}-01-01`);
      await createPrice(FuelType.GASOLINE_92, "30.0000", `${YEAR}-01-01`, ownerId); // U = 30/10 = 3
      await createEtc(`${YEAR}-01-01`, "2.0000", ownerId); // E = 2.0000
    });

    it("segRaw = fuel + etc is rounded once (0.50km × 3 + 0.25km × 2.0000 → 2, not 3)", async () => {
      const id = await createDraft(ownerCookie);
      await buildSegmentsWithAttachments(
        ownerCookie,
        ownerId,
        id,
        `${YEAR}-06-01`,
        "AC-19 鑑別例",
        [{ origin: "A", destination: "B", totalKm: "0.50", highwayKm: "0.25" }]
      );

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: ApplicationJson }>().application;

      // segFuel = 0.50 * 3 = 1.5；segEtc = 0.25 * 2.0000 = 0.5；segRaw = 2.0；
      // segAmt = ROUND_HALF_UP(2.0, 0) = 2。若先各自取整
      // （segFuel→2、segEtc→1，2+1=3）則此斷言必紅（Spec 明文鑑別力）。
      expect(application.segments[0].snapshot?.rawAmount).toBe("2.0000");
      expect(application.segments[0].snapshot?.amount).toBe(2);
      expect(application.snapshot?.totalAmount).toBe(2);
      expect(application.snapshot?.totalAmount).not.toBe(3);
    });
  });

  // =========================================================================
  // AC-20 容量守門（整合層，PENDING → 本 Task 落地）
  // =========================================================================
  describe("AC-20 容量守門", () => {
    const YEAR = "2062";
    let ownerId: string;
    let ownerCookie: string;

    beforeAll(async () => {
      if (!DB_URL) return;
      const owner = await createOwner("ac20");
      ownerId = owner.id;
      ownerCookie = owner.cookie;
      // Spec §2.D AC-20 例：P=999999.9999, C=0.0001 → U ≈ 9.9999999e9（|U| ≥ 1e6）。
      await createConsumption(ownerId, FuelType.GASOLINE_95, "0.0001", `${YEAR}-01-01`);
      await createPrice(FuelType.GASOLINE_95, "999999.9999", `${YEAR}-01-01`, ownerId);
      await createEtc(`${YEAR}-01-01`, "2.0000", ownerId);
    });

    it("an overflowing price/consumption combination is rejected per D4, never 500", async () => {
      const id = await createDraft(ownerCookie);
      await buildSegmentsWithAttachments(
        ownerCookie,
        ownerId,
        id,
        `${YEAR}-06-01`,
        "AC-20 容量守門",
        [{ origin: "A", destination: "B", totalKm: "10.00", highwayKm: "0.00" }]
      );

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(409);
      expect(resp.statusCode).not.toBe(500);
      const body = resp.json<ErrorJson>();
      expect(body.error.code).toBe("PARAMETER_NOT_AVAILABLE");
      expect(body.error.details?.missing).toContain("FUEL_UNIT_PRICE_OUT_OF_RANGE");

      // 未落地任何快照（不得靜默截斷寫入）。
      const dbTravel = await prisma.travelApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      expect(dbTravel.fuelUnitPrice).toBeNull();
      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.status).toBe("DRAFT");
      expect(dbApp.totalAmount).toBeNull();
    });

    it("SF-2: draft GET exposes parameterAvailable=false + FUEL_UNIT_PRICE_OUT_OF_RANGE via completionBlockers and computed (never amount 0 as final)", async () => {
      const id = await createDraft(ownerCookie);
      await buildSegmentsWithAttachments(
        ownerCookie,
        ownerId,
        id,
        `${YEAR}-06-02`,
        "AC-20 SF-2 草稿",
        [{ origin: "A", destination: "B", totalKm: "10.00", highwayKm: "0.00" }]
      );

      const getResp = await app.inject({
        method: "GET",
        url: `/applications/travel/${id}`,
        headers: { cookie: ownerCookie },
      });
      expect(getResp.statusCode).toBe(200);
      const application = getResp.json<{ application: ApplicationJson }>().application;

      expect(application.computed?.parameterAvailable).toBe(false);
      expect(application.computed?.missingParameters).toContain("FUEL_UNIT_PRICE_OUT_OF_RANGE");
      const blockerCodes = application.completionBlockers.map((b) => b.code);
      expect(blockerCodes).toContain("FUEL_UNIT_PRICE_OUT_OF_RANGE");
    });

    it("SF-2: preview endpoint exposes parameterAvailable=false + FUEL_UNIT_PRICE_OUT_OF_RANGE (never amount 0 as final)", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/travel/preview",
        headers: { cookie: ownerCookie },
        payload: {
          tripDate: `${YEAR}-06-03`,
          segments: [{ totalKm: "10.00", highwayKm: "0.00" }],
        },
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: ComputedJson }>().preview;
      expect(preview.parameterAvailable).toBe(false);
      expect(preview.missingParameters).toContain("FUEL_UNIT_PRICE_OUT_OF_RANGE");
    });
  });

  // =========================================================================
  // SF-2: 資料毀損情境（kmPerLiter<=0 繞過上游驗證）
  // =========================================================================
  describe("SF-2 資料毀損情境（FUEL_DATA_CORRUPTED）", () => {
    const YEAR = "2067";
    let ownerId: string;
    let ownerCookie: string;

    beforeAll(async () => {
      if (!DB_URL) return;
      const owner = await createOwner("sf2corrupt");
      ownerId = owner.id;
      ownerCookie = owner.cookie;
      // 直接繞過 service 層驗證（僅在 route 層把關 >0），模擬既有資料毀損：
      // kmPerLiter=0（deriveFuelUnitPrice 本身對此 throw RangeError）。
      await prisma.userFuelConsumptionVersion
        .create({
          data: {
            userId: ownerId,
            fuelType: FuelType.DIESEL,
            kmPerLiter: new Prisma.Decimal("0"),
            effectiveFrom: new Date(`${YEAR}-01-01`),
            basisNote: "t8complete 毀損資料防護測試（繞過上游驗證）",
            createdById: ownerId,
          },
        })
        .then((c) => createdConsumptionIds.push(c.id));
      await createPrice(FuelType.DIESEL, "10.0000", `${YEAR}-01-01`, ownerId);
      await createEtc(`${YEAR}-01-01`, "2.0000", ownerId);
    });

    it("completion → 409 PARAMETER_NOT_AVAILABLE with FUEL_DATA_CORRUPTED, never 500", async () => {
      const id = await createDraft(ownerCookie);
      await buildSegmentsWithAttachments(ownerCookie, ownerId, id, `${YEAR}-06-01`, "SF-2 毀損", [
        { origin: "A", destination: "B", totalKm: "10.00", highwayKm: "0.00" },
      ]);
      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(409);
      const body = resp.json<ErrorJson>();
      expect(body.error.details?.missing).toContain("FUEL_DATA_CORRUPTED");
      expect(body.error.details?.missing).not.toContain("FUEL_UNIT_PRICE_OUT_OF_RANGE");
    });

    it("SF-2: draft GET + preview both expose FUEL_DATA_CORRUPTED, parameterAvailable=false", async () => {
      const id = await createDraft(ownerCookie);
      await buildSegmentsWithAttachments(
        ownerCookie,
        ownerId,
        id,
        `${YEAR}-06-02`,
        "SF-2 草稿毀損",
        [{ origin: "A", destination: "B", totalKm: "10.00", highwayKm: "0.00" }]
      );
      const getResp = await app.inject({
        method: "GET",
        url: `/applications/travel/${id}`,
        headers: { cookie: ownerCookie },
      });
      const application = getResp.json<{ application: ApplicationJson }>().application;
      expect(application.computed?.parameterAvailable).toBe(false);
      expect(application.computed?.missingParameters).toContain("FUEL_DATA_CORRUPTED");
      expect(application.completionBlockers.map((b) => b.code)).toContain("FUEL_DATA_CORRUPTED");

      const previewResp = await app.inject({
        method: "POST",
        url: "/applications/travel/preview",
        headers: { cookie: ownerCookie },
        payload: { tripDate: `${YEAR}-06-03`, segments: [{ totalKm: "10.00", highwayKm: "0.00" }] },
      });
      const preview = previewResp.json<{ preview: ComputedJson }>().preview;
      expect(preview.parameterAvailable).toBe(false);
      expect(preview.missingParameters).toContain("FUEL_DATA_CORRUPTED");
    });
  });

  // =========================================================================
  // AC-24 後端權威
  // =========================================================================
  describe("AC-24 後端權威", () => {
    const YEAR = "2063";
    let ownerId: string;
    let ownerCookie: string;

    beforeAll(async () => {
      if (!DB_URL) return;
      const owner = await createOwner("ac24");
      ownerId = owner.id;
      ownerCookie = owner.cookie;
      await createConsumption(ownerId, FuelType.GASOLINE_98, "10.0000", `${YEAR}-01-01`);
      await createPrice(FuelType.GASOLINE_98, "30.0000", `${YEAR}-01-01`, ownerId); // U = 3
      await createEtc(`${YEAR}-01-01`, "2.0000", ownerId);
    });

    it("body carrying fuelUnitPrice / pricePerLiter / kmPerLiter / totalAmount is ignored, response is the backend value", async () => {
      const id = await createDraft(ownerCookie);
      await buildSegmentsWithAttachments(ownerCookie, ownerId, id, `${YEAR}-06-01`, "AC-24 夾帶", [
        { origin: "A", destination: "B", totalKm: "10.00", highwayKm: "5.00" },
      ]);
      // 正確答案：segFuel = 10*3=30；segEtc=5*2=10；segRaw=40；segAmt=40。
      const resp = await completeHttp(ownerCookie, id, {
        fuelUnitPrice: "999",
        pricePerLiter: "999999.9999",
        kmPerLiter: "0.0001",
        amount: 999999,
        totalAmount: 999999,
      });
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: ApplicationJson }>().application;
      expect(application.snapshot?.fuelUnitPrice).toBe("3.0000");
      expect(application.snapshot?.totalAmount).toBe(40);
      expect(application.snapshot?.totalAmount).not.toBe(999999);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.totalAmount).toBe(40);
    });

    it("malformed injected field VALUES (still a JSON object body) never cause a 500", async () => {
      // AC-24 逐字：body 夾帶之欄位「合法或畸形值皆然」——聚焦於欄位本身的值
      // 畸形（型別錯誤、NaN、巢狀物件、陣列），而非 HTTP body 頂層形狀本身
      // （頂層非物件屬 Fastify content-type/body-parser 層級議題，見下一個
      // 獨立斷言，僅要求非 500，不要求 200）。
      const malformedPayloads: Record<string, unknown>[] = [
        { fuelUnitPrice: { nested: true } },
        { totalAmount: [1, 2, 3] },
        { pricePerLiter: null, kmPerLiter: Number.NaN },
        { amount: "not-a-number", fuelUnitPrice: "Infinity" },
        {},
      ];

      for (const payload of malformedPayloads) {
        const id = await createDraft(ownerCookie);
        await buildSegmentsWithAttachments(
          ownerCookie,
          ownerId,
          id,
          `${YEAR}-06-02`,
          "AC-24 畸形夾帶",
          [{ origin: "A", destination: "B", totalKm: "10.00", highwayKm: "5.00" }]
        );
        const resp = await completeHttp(ownerCookie, id, payload);
        expect(resp.statusCode).toBe(200);
        expect(resp.statusCode).not.toBe(500);
        const application = resp.json<{ application: ApplicationJson }>().application;
        expect(application.snapshot?.totalAmount).toBe(40);
      }
    });

    it("a non-object top-level request body (null / string / array) still never causes a 500", async () => {
      const topLevelPayloads: unknown[] = [null, "a plain JSON string body", [1, 2, 3]];
      for (const payload of topLevelPayloads) {
        const id = await createDraft(ownerCookie);
        await buildSegmentsWithAttachments(
          ownerCookie,
          ownerId,
          id,
          `${YEAR}-06-03`,
          "AC-24 頂層非物件 body",
          [{ origin: "A", destination: "B", totalKm: "10.00", highwayKm: "5.00" }]
        );
        const resp = await app.inject({
          method: "POST",
          url: `/applications/${id}/complete`,
          headers: { cookie: ownerCookie, "content-type": "application/json" },
          payload: JSON.stringify(payload),
        });
        expect(resp.statusCode).not.toBe(500);
      }
    });
  });

  // =========================================================================
  // AC-25 快照七項＋版本 id（可重現性）
  // =========================================================================
  describe("AC-25 快照七項＋版本 id", () => {
    const YEAR = "2064";
    let ownerId: string;
    let ownerCookie: string;
    let priceVersionId: string;
    let consumptionVersionId: string;
    let etcVersionId: string;

    beforeAll(async () => {
      if (!DB_URL) return;
      const owner = await createOwner("ac25");
      ownerId = owner.id;
      ownerCookie = owner.cookie;
      const consumption = await createConsumption(
        ownerId,
        FuelType.GASOLINE_92,
        "10.0000",
        `${YEAR}-01-01`
      );
      consumptionVersionId = consumption.id;
      const price = await createPrice(FuelType.GASOLINE_92, "45.0000", `${YEAR}-01-01`, ownerId); // 45/10=4.5→5（AC-18 鑑別例，非銀行家）
      priceVersionId = price.id;
      const etc = await createEtc(`${YEAR}-01-01`, "2.0000", ownerId);
      etcVersionId = etc.id;
    });

    it("snapshot stores fuelType / pricePerLiter / consumption / derived unit price / etc / raw / total", async () => {
      const id = await createDraft(ownerCookie);
      await buildSegmentsWithAttachments(ownerCookie, ownerId, id, `${YEAR}-06-01`, "AC-25 快照", [
        { origin: "A", destination: "B", totalKm: "20.00", highwayKm: "10.00" },
      ]);
      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const snap = resp.json<{ application: ApplicationJson }>().application.snapshot;
      expect(snap).not.toBeNull();
      const s = snap as TravelSnapshotJson;

      expect(s.snapshotFuelType).toBe("GASOLINE_92");
      expect(s.snapshotFuelPricePerLiter).toBe("45.0000");
      expect(s.snapshotFuelConsumption).toBe("10.0000");
      expect(s.fuelUnitPrice).toBe("5.0000"); // ROUND_HALF_UP(45/10,0)=5
      expect(s.etcUnitPrice).toBe("2.0000");
      // segFuel=20*5=100；segEtc=10*2=20；segRaw=120。
      expect(s.totalRawAmount).toBe("120.0000");
      expect(s.totalAmount).toBe(120);
      expect(s.fuelPriceVersionId).toBe(priceVersionId);
      expect(s.fuelConsumptionVersionId).toBe(consumptionVersionId);
      expect(s.etcParameterVersionId).toBe(etcVersionId);
      expect(s.fuelParameterVersionId).toBeNull(); // 新模型：舊欄位恆 null
    });

    it("recomputing ROUND_HALF_UP(price ÷ consumption) from the snapshot reproduces fuelUnitPrice exactly", async () => {
      const id = await createDraft(ownerCookie);
      await buildSegmentsWithAttachments(ownerCookie, ownerId, id, `${YEAR}-06-02`, "AC-25 重算", [
        { origin: "A", destination: "B", totalKm: "20.00", highwayKm: "10.00" },
      ]);
      const resp = await completeHttp(ownerCookie, id);
      const s = resp.json<{ application: ApplicationJson }>().application
        .snapshot as TravelSnapshotJson;

      // 「若僅存單價，本斷言不可能成立」——本測試獨立以快照的
      // snapshotFuelPricePerLiter/snapshotFuelConsumption 重算，證明三來源值
      // 皆確實被保存且彼此一致（Q8 之機械證明）。
      const recomputed = new Prisma.Decimal(s.snapshotFuelPricePerLiter as string)
        .div(new Prisma.Decimal(s.snapshotFuelConsumption as string))
        .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
      expect(recomputed.toFixed(4)).toBe(s.fuelUnitPrice);
    });

    it("recomputing segment amounts from the snapshot reproduces snapshotAmount exactly", async () => {
      const id = await createDraft(ownerCookie);
      await buildSegmentsWithAttachments(
        ownerCookie,
        ownerId,
        id,
        `${YEAR}-06-03`,
        "AC-25 段重算",
        [
          { origin: "A", destination: "B", totalKm: "20.00", highwayKm: "10.00" },
          { origin: "B", destination: "C", totalKm: "3.00", highwayKm: "1.00" },
        ]
      );
      const resp = await completeHttp(ownerCookie, id);
      const application = resp.json<{ application: ApplicationJson }>().application;
      const s = application.snapshot as TravelSnapshotJson;
      const unitPrice = new Prisma.Decimal(s.fuelUnitPrice);
      const etcUnitPrice = new Prisma.Decimal(s.etcUnitPrice);

      for (const seg of application.segments) {
        const totalKm = new Prisma.Decimal(seg.totalKm as string);
        const highwayKm = new Prisma.Decimal(seg.highwayKm as string);
        const rawAmount = totalKm.times(unitPrice).plus(highwayKm.times(etcUnitPrice));
        const amount = rawAmount.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
        expect(seg.snapshot?.rawAmount).toBe(rawAmount.toFixed(4));
        expect(seg.snapshot?.amount).toBe(amount);
      }
    });
  });

  // =========================================================================
  // AC-26 快照不可變
  // =========================================================================
  describe("AC-26 快照不可變", () => {
    const YEAR = "2065";
    let ownerId: string;
    let ownerCookie: string;
    let applicationId: string;
    let snapshotBefore: TravelSnapshotJson;
    let segmentsBefore: SegmentJson[];

    beforeAll(async () => {
      if (!DB_URL) return;
      const owner = await createOwner("ac26");
      ownerId = owner.id;
      ownerCookie = owner.cookie;
      await createConsumption(ownerId, FuelType.DIESEL, "10.0000", `${YEAR}-01-01`);
      await createPrice(FuelType.DIESEL, "20.0000", `${YEAR}-01-01`, ownerId); // U=2
      await createEtc(`${YEAR}-01-01`, "2.0000", ownerId);

      applicationId = await createDraft(ownerCookie);
      await buildSegmentsWithAttachments(
        ownerCookie,
        ownerId,
        applicationId,
        `${YEAR}-06-15`,
        "AC-26 完成後不受後續版本影響",
        [{ origin: "A", destination: "B", totalKm: "10.00", highwayKm: "5.00" }]
      );
      const completeResp = await completeHttp(ownerCookie, applicationId);
      expect(completeResp.statusCode).toBe(200);
      const completedApplication = completeResp.json<{ application: ApplicationJson }>()
        .application;
      snapshotBefore = completedApplication.snapshot as TravelSnapshotJson;
      // S-3（T8 即審複審）：Spec AC-26 明列「各段 snapshot*」亦須逐位元不變，
      // 不只申請層級的 `snapshot`——一併保存段落陣列供下方比對。
      segmentsBefore = completedApplication.segments;
    });

    it("adding an earlier-effective price or consumption version leaves the completed snapshot bit-identical", async () => {
      // 新版本 effectiveFrom 早於出差日期（YEAR-06-15）且晚於原版本
      // （YEAR-01-01），數值刻意互異——若 GET 走重算路徑，會被本次新增的
      // 版本取代，斷言必紅。
      await createPrice(FuelType.DIESEL, "999.0000", `${YEAR}-03-01`, ownerId);
      await createConsumption(ownerId, FuelType.DIESEL, "1.0000", `${YEAR}-04-01`);

      const getResp = await app.inject({
        method: "GET",
        url: `/applications/travel/${applicationId}`,
        headers: { cookie: ownerCookie },
      });
      expect(getResp.statusCode).toBe(200);
      const applicationAfter = getResp.json<{ application: ApplicationJson }>().application;
      const snapshotAfter = applicationAfter.snapshot as TravelSnapshotJson;

      expect(snapshotAfter).toEqual(snapshotBefore);
      // S-3（T8 即審複審）：各段 snapshot* 亦須逐位元不變（Spec AC-26 明列
      // 「各段 snapshot*」，非只申請層級 `snapshot`）。
      expect(applicationAfter.segments).toEqual(segmentsBefore);
    });

    it("GET of a completed application performs no parameter resolution (positive control: DRAFT GET does)", async () => {
      const spy = vi.mocked(travelParameters.resolveTravelParameters);

      // S-2（T8 即審複審）：正對照——先 GET 一筆 DRAFT（必然呼叫
      // resolveTravelParameters，計數 +1），證明 spy 攔截確實生效、非恆綠；
      // 再 GET 已完成申請，計數應為 +0。若 vi.mock 攔截失效，兩次呼叫都不會
      // 改變 spy 計數，下方 +1 斷言會先失敗，避免「呼叫次數差 0」單獨作為
      // 唯一斷言時的恆真風險。
      const draftId = await createDraft(ownerCookie);
      const callsBeforeDraft = spy.mock.calls.length;
      const draftGetResp = await app.inject({
        method: "GET",
        url: `/applications/travel/${draftId}`,
        headers: { cookie: ownerCookie },
      });
      expect(draftGetResp.statusCode).toBe(200);
      expect(spy.mock.calls.length).toBe(callsBeforeDraft + 1);

      const callsBeforeCompleted = spy.mock.calls.length;
      const getResp = await app.inject({
        method: "GET",
        url: `/applications/travel/${applicationId}`,
        headers: { cookie: ownerCookie },
      });
      expect(getResp.statusCode).toBe(200);

      expect(spy.mock.calls.length).toBe(callsBeforeCompleted);
    });
  });

  // =========================================================================
  // T2 複審 AR-2 邊界表義務 — 段金額/totalAmount 溢位邊界
  // =========================================================================
  describe("AR-2 邊界：段金額／totalAmount 溢位", () => {
    const YEAR = "2066";
    let ownerId: string;
    let ownerCookie: string;

    beforeAll(async () => {
      if (!DB_URL) return;
      const owner = await createOwner("ar2");
      ownerId = owner.id;
      ownerCookie = owner.cookie;
      // U = 999999（在 AC-20 容量內，< 1e6），但搭配欄位容量上限的 totalKm
      // （99999999.99，Decimal(10,2) 容量上限）時，segFuel ≈ 9.9999e13，
      // 遠超 Decimal(14,4) 容量（|v|<1e10）。
      await createConsumption(ownerId, FuelType.GASOLINE_92, "1.0000", `${YEAR}-01-01`);
      await createPrice(FuelType.GASOLINE_92, "999999.0000", `${YEAR}-01-01`, ownerId); // U=999999
      await createEtc(`${YEAR}-01-01`, "0.0000", ownerId);
    });

    it("an amount overflowing the snapshot Decimal/Int columns is rejected, never 500, never silently truncated", async () => {
      const id = await createDraft(ownerCookie);
      await buildSegmentsWithAttachments(ownerCookie, ownerId, id, `${YEAR}-06-01`, "AR-2 溢位", [
        { origin: "A", destination: "B", totalKm: "99999999.99", highwayKm: "0.00" },
      ]);
      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(409);
      expect(resp.statusCode).not.toBe(500);
      const body = resp.json<ErrorJson>();
      expect(body.error.code).toBe("PARAMETER_NOT_AVAILABLE");
      expect(body.error.details?.missing).toEqual(["AMOUNT_OUT_OF_RANGE"]);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.status).toBe("DRAFT");
      expect(dbApp.totalAmount).toBeNull();
      const segs = await prisma.tripSegment.findMany({ where: { travelApplicationId: id } });
      for (const seg of segs) {
        expect(seg.snapshotAmount).toBeNull();
      }
    });
  });

  // =========================================================================
  // T8 即審 S-1 修復：AMOUNT_OUT_OF_RANGE 須接進草稿/預覽（SF-2 反模式復發）
  // =========================================================================
  describe("S-1 修復：草稿/預覽亦暴露 AMOUNT_OUT_OF_RANGE（不得只在完成時 409）", () => {
    const YEAR = "2068";
    let ownerId: string;
    let ownerCookie: string;

    beforeAll(async () => {
      if (!DB_URL) return;
      const owner = await createOwner("s1range");
      ownerId = owner.id;
      ownerCookie = owner.cookie;
      // 與 AR-2 同一鑑別組合：U=999999（<1e6，AC-20 容量內），totalKm 為
      // Decimal(10,2) 容量上限 → segFuel 遠超 Decimal(14,4) 容量。
      await createConsumption(ownerId, FuelType.GASOLINE_92, "1.0000", `${YEAR}-01-01`);
      await createPrice(FuelType.GASOLINE_92, "999999.0000", `${YEAR}-01-01`, ownerId); // U=999999
      await createEtc(`${YEAR}-01-01`, "0.0000", ownerId);
    });

    it("draft GET exposes parameterAvailable=false + AMOUNT_OUT_OF_RANGE, amount not shown as huge final value", async () => {
      const id = await createDraft(ownerCookie);
      await buildSegmentsWithAttachments(
        ownerCookie,
        ownerId,
        id,
        `${YEAR}-06-01`,
        "S-1 草稿溢位",
        [{ origin: "A", destination: "B", totalKm: "99999999.99", highwayKm: "0.00" }]
      );

      const getResp = await app.inject({
        method: "GET",
        url: `/applications/travel/${id}`,
        headers: { cookie: ownerCookie },
      });
      expect(getResp.statusCode).toBe(200);
      const application = getResp.json<{ application: ApplicationJson }>().application;

      expect(application.computed?.parameterAvailable).toBe(false);
      expect(application.computed?.missingParameters).toContain("AMOUNT_OUT_OF_RANGE");
      expect(application.computed?.totalAmount).not.toBeGreaterThan(0);
      const blockerCodes = application.completionBlockers.map((b) => b.code);
      expect(blockerCodes).toContain("AMOUNT_OUT_OF_RANGE");
    });

    it("preview endpoint exposes parameterAvailable=false + AMOUNT_OUT_OF_RANGE, amount not shown as huge final value", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/travel/preview",
        headers: { cookie: ownerCookie },
        payload: {
          tripDate: `${YEAR}-06-02`,
          segments: [{ totalKm: "99999999.99", highwayKm: "0.00" }],
        },
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: ComputedJson }>().preview;
      expect(preview.parameterAvailable).toBe(false);
      expect(preview.missingParameters).toContain("AMOUNT_OUT_OF_RANGE");
      expect(preview.totalAmount).not.toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // T8 即審 AR-2 補正例：合法大額（不超容量）完成成功之邊界值（防守門誤殺）
  // =========================================================================
  describe("AR-2 邊界正例：合法大額完成成功（防守門誤殺）", () => {
    const YEAR = "2069";
    let ownerId: string;
    let ownerCookie: string;

    beforeAll(async () => {
      if (!DB_URL) return;
      const owner = await createOwner("ar2boundary");
      ownerId = owner.id;
      ownerCookie = owner.cookie;
      // U=1000（遠低於 AC-20 之 1e6 上限），totalKm=100000.00 →
      // segFuel=100,000,000，遠低於 Decimal(14,4) 容量（|v|<1e10）與 int4 上限
      // ——刻意選擇「大但合法」的組合，證明守門只擋真正超容量，不誤殺一般
      // 大額差旅。
      await createConsumption(ownerId, FuelType.GASOLINE_92, "1.0000", `${YEAR}-01-01`);
      await createPrice(FuelType.GASOLINE_92, "1000.0000", `${YEAR}-01-01`, ownerId); // U=1000
      await createEtc(`${YEAR}-01-01`, "0.0000", ownerId);
    });

    it("a large-but-legal amount completes successfully (not rejected as overflow)", async () => {
      const id = await createDraft(ownerCookie);
      await buildSegmentsWithAttachments(
        ownerCookie,
        ownerId,
        id,
        `${YEAR}-06-01`,
        "AR-2 邊界正例",
        [{ origin: "A", destination: "B", totalKm: "100000.00", highwayKm: "0.00" }]
      );
      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: ApplicationJson }>();
      expect(body.application.status).toBe("COMPLETED");
      expect(body.application.snapshot?.totalAmount).toBe(100000000);
    });
  });
});
