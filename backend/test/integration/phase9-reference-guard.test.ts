/**
 * Integration tests for PHASE-009-T8 — 參數引用保護之作廢語意（AC-18 / §16 D2(a)）
 *
 * ── 規範來源（逐字） ─────────────────────────────────────────────────────
 *   Spec §12 AC-18（`docs/specs/PHASE-009.md` :201）：
 *     「`parameterHasReferences` 之 `status` 條件由 `"COMPLETED"` 改為
 *      `{ in: ["COMPLETED", "VOIDED"] }`，五種 `ParameterType`（`FUEL`／
 *      `FUEL_PRICE`／`FUEL_CONSUMPTION`／`ETC`／`DEPRECIATION`）逐型別驗證：
 *      (a) 引用來源申請被作廢後，該參數版本仍判定為「已被引用」（改回
 *      `COMPLETED` only 之 mutant 必紅）；(b) 僅被草稿引用者仍判定為「未被
 *      引用」（草稿無快照，行為不變）；(c) 既有 `COMPLETED` 之正向判定逐型別
 *      零弱化。」
 *   §16 D2(a)（人類 Spec Gate 2026-08-07 裁定）：作廢改變的是**統計有效性**，
 *   不改變**歷史存在性**；統計面 `= COMPLETED`（單值）／引用面
 *   `∈ {COMPLETED, VOIDED}` 之不同步為**設計意圖**（§9.3）。
 *   B-34（:380）：參數版本僅被**已作廢**申請引用 → 仍判定為「已被引用」。
 *
 * ── 修復前紅燈實證（TDD 順序） ────────────────────────────────────────────
 *   本檔先於 `reference-guard.ts` 之修改寫成。base `4233333` 之實作為
 *   `application: { status: "COMPLETED" }`（兩處 `where`），故
 *   `AC-18(a)` 一條紅（五型別逐一皆回 `false`，首個失敗為 `FUEL`），
 *   `AC-18(b)`／`AC-18(c)` 兩條綠（該兩條之語意於修改前後皆須成立——(c) 正是
 *   「零弱化」之守門，(b) 正是「草稿行為不變」之守門）。逐字輸出見 Handoff。
 *
 * ── 三個資料集（各自獨占年份，避免與其他測試檔之全域參數版本時間軸互撞） ──
 *   全域表 `FuelParameterVersion`／`EtcParameterVersion`／
 *   `DepreciationParameterVersion` 皆 `@@unique([effectiveFrom])`，
 *   `FuelPriceVersion` 為 `@@unique([fuelType, effectiveFrom])`，
 *   `UserFuelConsumptionVersion` 為 `@@unique([userId, effectiveFrom])`。
 *   沿既有「每檔認領自己未被使用之日曆年」慣例（`phase4-reference-protection`
 *   認領 2045~2048、`phase7-snapshot-immutability` 認領 2085~2097、
 *   `phase7-on-behalf` 記載「2040~2075 已用罄」），本檔另起 **2190~2193**
 *   （全 repo `grep -rn "219[0-9]"` 實查：測試樹與 `e2e/` 零命中，且高於現有
 *   最大年份 2187）：
 *
 *     2190  SET_VOIDED    —— 真實完成 → **真實作廢**（AC-18(a) 之引用來源）
 *     2191  SET_COMPLETED —— 真實完成，**不作廢**（AC-18(c) 之正向對照）
 *     2192  SET_DRAFT     —— 僅建立草稿，從未完成（AC-18(b)）
 *     2193  SET_ORPHAN    —— 只有參數版本、零申請（三條 `it` 之共用鑑別力否定組，
 *                            使任一條都不可能是「永遠 true」）
 *
 * ── FW 核銷（Packet「上游 FW 核銷」逐項） ────────────────────────────────
 *   1. **作廢一律走真實流程**（AC-16／AC-17 同族原則）：本檔將申請轉
 *      `VOIDED` 之**唯一**手段為 `POST /applications/:id/void`（T4 端點，內走
 *      T3 `voidApplication`）。全檔**零** `prisma.application.update(`——狀態
 *      寫入面零直寫（`grep -c "application.update(" ` 本檔＝0；唯一之
 *      `prisma.travelApplication.update` 為 FW-3 之 legacy 欄例外，見下）。
 *   2. **完成一律走真實流程**（沿 PHASE-007 T9 即審 FW-2）：差旅四型別之快照欄
 *      （`fuelPriceVersionId`／`fuelConsumptionVersionId`／
 *      `etcParameterVersionId`）與折舊之 `depreciationParameterVersionId`
 *      一律由 `completeTravelApplication`／`completeDepreciationApplication`
 *      經 `POST /applications/:id/complete` 寫入，本檔**絕不**直寫該四欄。
 *   3. **例外：`"FUEL"` 之 legacy 欄**（`TravelApplication.fuelParameterVersionId`）
 *      ——PHASE-005a-T7 起**全 repo 零寫入路徑**（`reference-guard.ts` 檔頭
 *      :13~:24「never backfilled」；`grep -rn "fuelParameterVersionId" src/` 僅
 *      命中 `reference-guard.ts` 之讀取與 `travel-service.ts` 之
 *      `hasLegacyFuelReference` 讀取）。該型別之引用來源**只可能**是
 *      pre-T7 之歷史列，沒有任何真實流程可產生之。故本檔以
 *      `prisma.travelApplication.update({ data: { fuelParameterVersionId } })`
 *      在一筆**經真實流程完成**之差旅上補寫該 legacy 欄，模擬歷史列；
 *      **狀態欄仍由真實作廢端點寫入**，FW-1 之語意不受影響。此為據實論證之
 *      fixture 成本例外，不擴及其他四型別。
 *   4. **T2 FW（AC-05(a) 白名單）**：本檔之程式面變更落在 `reference-guard.ts`
 *      之**讀取面** `where` 條件，不新增任何 `status` 寫入點。
 *   5. fixture 慣例：`mustChangePassword: false` 顯式；`loginName` 以 RUN_ID
 *      前綴；清理嚴格限於本檔自建之 id／前綴，絕無 `deleteMany({})`。
 */
import { FuelType, Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import type { ParameterType } from "../../src/parameters/reference-guard.js";
import { parameterHasReferences } from "../../src/parameters/reference-guard.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p9t8_";
const PASSWORD = "ReferenceGuardVoidTest99!";

/** 本檔認領之四個日曆年（見檔頭）。 */
const YEAR_VOIDED = 2190;
const YEAR_COMPLETED = 2191;
const YEAR_DRAFT = 2192;
const YEAR_ORPHAN = 2193;

/** 折舊申請之年度總里程（沿 phase7-snapshot-immutability 之量級）。 */
const ANNUAL_TOTAL_KM = "16384.0";

/**
 * 五個 `ParameterType` 之封閉集合。任何一型別被遺漏或新增，三條 `it` 之
 * `toEqual` 逐字比對即紅（AC-18「五種 `ParameterType` 逐型別」之守門）。
 */
const ALL_PARAMETER_TYPES = [
  "FUEL",
  "FUEL_PRICE",
  "FUEL_CONSUMPTION",
  "ETC",
  "DEPRECIATION",
] as const satisfies readonly ParameterType[];

/** 一組「五型別各一個參數版本」之 fixture。 */
interface VersionSet {
  FUEL: string;
  FUEL_PRICE: string;
  FUEL_CONSUMPTION: string;
  ETC: string;
  DEPRECIATION: string;
}

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

describeWithDb("PHASE-009-T8 — 參數引用保護之作廢語意（AC-18 / D2(a)）", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let ownerCookie: string;
  let adminId: string;

  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdLegacyFuelVersionIds: string[] = [];
  const createdFuelPriceVersionIds: string[] = [];
  const createdConsumptionVersionIds: string[] = [];
  const createdEtcVersionIds: string[] = [];
  const createdDepreciationVersionIds: string[] = [];

  /** 三組資料集之版本 id（`beforeAll` 建立）。 */
  let voidedSet: VersionSet;
  let completedSet: VersionSet;
  let draftSet: VersionSet;
  let orphanSet: VersionSet;

  /** SET_VOIDED／SET_DRAFT 之申請 id，供斷言前的狀態前提檢查。 */
  let voidedTravelId: string;
  let voidedDepreciationId: string;
  let completedTravelId: string;
  let completedDepreciationId: string;
  let draftTravelId: string;
  let draftDepreciationId: string;

  function trackApp(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Fixture helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 為某一認領年份建立五型別各一個參數版本（生效日一律 `${year}-01-01`）。
   *
   * `FUEL` 之 legacy 表（`FuelParameterVersion`）於 PHASE-005a-T7 後已無任何
   * 讀寫路徑會選中它（新模型走 `FuelPriceVersion` × `UserFuelConsumptionVersion`
   * 雙鏈），此處建立僅為讓 `parameterHasReferences("FUEL", …)` 有一個真實存在
   * 的版本 id 可問（該函式不做存在性檢查，但以真實列提問較貼近實況）。
   */
  async function createVersionSet(year: number): Promise<VersionSet> {
    const effectiveFrom = new Date(`${year}-01-01T00:00:00.000Z`);

    const legacyFuel = await prisma.fuelParameterVersion.create({
      data: { unitPrice: new Prisma.Decimal("2.0000"), effectiveFrom, createdById: adminId },
    });
    createdLegacyFuelVersionIds.push(legacyFuel.id);

    const fuelPrice = await prisma.fuelPriceVersion.create({
      data: {
        fuelType: FuelType.GASOLINE_95,
        pricePerLiter: new Prisma.Decimal("30.0000"),
        effectiveFrom,
        createdById: adminId,
      },
    });
    createdFuelPriceVersionIds.push(fuelPrice.id);

    const consumption = await prisma.userFuelConsumptionVersion.create({
      data: {
        userId: ownerId,
        fuelType: FuelType.GASOLINE_95,
        kmPerLiter: new Prisma.Decimal("10.0000"),
        effectiveFrom,
        basisNote: `p9t8 測試 fixture：${year} 年油耗`,
        createdById: adminId,
      },
    });
    createdConsumptionVersionIds.push(consumption.id);

    const etc = await prisma.etcParameterVersion.create({
      data: { unitPrice: new Prisma.Decimal("1.5000"), effectiveFrom, createdById: adminId },
    });
    createdEtcVersionIds.push(etc.id);

    const depreciation = await prisma.depreciationParameterVersion.create({
      data: {
        vehiclePrice: new Prisma.Decimal("600000.00"),
        usefulLifeYears: 5,
        effectiveFrom,
        createdById: adminId,
      },
    });
    createdDepreciationVersionIds.push(depreciation.id);

    return {
      FUEL: legacyFuel.id,
      FUEL_PRICE: fuelPrice.id,
      FUEL_CONSUMPTION: consumption.id,
      ETC: etc.id,
      DEPRECIATION: depreciation.id,
    };
  }

  /** 經真實端點建立差旅草稿。 */
  async function createTravelDraft(): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/travel",
      headers: { cookie: ownerCookie },
      payload: {},
    });
    expect(resp.statusCode).toBe(201);
    return trackApp(resp.json<{ application: { id: string } }>().application.id);
  }

  /** 直接建立一張 `LINKED` 附件（免上傳來回；沿既有測試慣例）。 */
  async function linkAttachment(refType: "TRIP_SEGMENT" | "DEPRECIATION", refId: string) {
    const attachment = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `att/p9t8-${RUN_ID}/${createdAttachmentIds.length}.jpg`,
        mimeType: "image/jpeg",
        byteSize: 256,
        originalFilename: "proof.jpg",
        uploaderId: ownerId,
        ownerId,
        refType,
        refId,
        linkedAt: new Date(),
      },
    });
    createdAttachmentIds.push(attachment.id);
    return attachment.id;
  }

  /**
   * 經**真實完成流程**建立一筆已完成差旅（`POST /applications/:id/complete`）。
   * 完成後 `fuelPriceVersionId`／`fuelConsumptionVersionId`／
   * `etcParameterVersionId` 三欄由 `completeTravelApplication` 寫入。
   */
  async function completeTravel(year: number): Promise<string> {
    const applicationId = await createTravelDraft();
    const putSegments = await app.inject({
      method: "PUT",
      url: `/applications/travel/${applicationId}`,
      headers: { cookie: ownerCookie },
      payload: {
        segments: [
          {
            origin: "甲地",
            destination: "乙地",
            totalKm: "30.00",
            highwayKm: "10.00",
            attachmentIds: [],
          },
        ],
      },
    });
    expect(putSegments.statusCode).toBe(200);
    const segmentId = putSegments.json<{ application: { segments: { id: string }[] } }>()
      .application.segments[0].id;
    await linkAttachment("TRIP_SEGMENT", segmentId);

    const putMeta = await app.inject({
      method: "PUT",
      url: `/applications/travel/${applicationId}`,
      headers: { cookie: ownerCookie },
      payload: { tripDate: `${year}-06-01`, purpose: `p9t8 AC-18 fixture ${year}` },
    });
    expect(putMeta.statusCode).toBe(200);

    const complete = await app.inject({
      method: "POST",
      url: `/applications/${applicationId}/complete`,
      headers: { cookie: ownerCookie },
    });
    expect(complete.statusCode, `差旅完成流程應成功：${complete.body}`).toBe(200);
    return applicationId;
  }

  /** 經真實端點建立差旅草稿（帶出差日期，但**從不**完成 → 無任何快照欄）。 */
  async function draftTravel(year: number): Promise<string> {
    const applicationId = await createTravelDraft();
    const put = await app.inject({
      method: "PUT",
      url: `/applications/travel/${applicationId}`,
      headers: { cookie: ownerCookie },
      payload: { tripDate: `${year}-06-01`, purpose: `p9t8 AC-18(b) 草稿 ${year}` },
    });
    expect(put.statusCode).toBe(200);
    return applicationId;
  }

  /** 經真實端點建立折舊草稿（附證明附件，使其可完成）。 */
  async function draftDepreciation(year: number): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/depreciation",
      headers: { cookie: ownerCookie },
      payload: { applicationYear: year, annualTotalKm: ANNUAL_TOTAL_KM },
    });
    expect(resp.statusCode, `折舊草稿建立應成功：${resp.body}`).toBe(201);
    const id = trackApp(resp.json<{ application: { id: string } }>().application.id);
    await linkAttachment("DEPRECIATION", id);
    return id;
  }

  /** 經**真實完成流程**完成折舊（寫入 `depreciationParameterVersionId`）。 */
  async function completeDepreciation(year: number): Promise<string> {
    const id = await draftDepreciation(year);
    const complete = await app.inject({
      method: "POST",
      url: `/applications/${id}/complete`,
      headers: { cookie: ownerCookie },
    });
    expect(complete.statusCode, `折舊完成流程應成功：${complete.body}`).toBe(200);
    return id;
  }

  /**
   * 經**真實作廢端點**作廢（FW-1）。本檔轉 `VOIDED` 之唯一手段。
   */
  async function voidViaEndpoint(applicationId: string, reason: string): Promise<void> {
    const resp = await app.inject({
      method: "POST",
      url: `/applications/${applicationId}/void`,
      headers: { cookie: ownerCookie },
      payload: { reason },
    });
    expect(resp.statusCode, `作廢端點應成功：${resp.body}`).toBe(200);
    const status = (await prisma.application.findUniqueOrThrow({ where: { id: applicationId } }))
      .status;
    expect(status, "作廢後狀態必須是 VOIDED（真實流程之實證）").toBe("VOIDED");
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    const owner = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}owner_${RUN_ID}`,
        displayName: "P9T8 擁有人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}admin_${RUN_ID}`,
        displayName: "P9T8 管理員",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    ownerId = owner.id;
    adminId = admin.id;
    createdUserIds.push(owner.id, admin.id);

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
    ownerCookie = await loginUser(app, owner.loginName, PASSWORD);

    // ── SET_VOIDED（2072）：真實完成 → 真實作廢 ──────────────────────────
    voidedSet = await createVersionSet(YEAR_VOIDED);
    voidedTravelId = await completeTravel(YEAR_VOIDED);
    // FW-3 之 legacy 例外：`"FUEL"` 之引用來源於 PHASE-005a-T7 後已無寫入
    // 路徑，只能以直寫模擬 pre-T7 歷史列（狀態欄仍由真實端點寫入）。
    await prisma.travelApplication.update({
      where: { applicationId: voidedTravelId },
      data: { fuelParameterVersionId: voidedSet.FUEL },
    });
    voidedDepreciationId = await completeDepreciation(YEAR_VOIDED);
    await voidViaEndpoint(voidedTravelId, "p9t8 AC-18(a)：差旅作廢後仍屬歷史內容");
    await voidViaEndpoint(voidedDepreciationId, "p9t8 AC-18(a)：折舊作廢後仍屬歷史內容");

    // ── SET_COMPLETED（2073）：真實完成，不作廢 ──────────────────────────
    completedSet = await createVersionSet(YEAR_COMPLETED);
    completedTravelId = await completeTravel(YEAR_COMPLETED);
    await prisma.travelApplication.update({
      where: { applicationId: completedTravelId },
      data: { fuelParameterVersionId: completedSet.FUEL },
    });
    completedDepreciationId = await completeDepreciation(YEAR_COMPLETED);

    // ── SET_DRAFT（2074）：只有草稿，從未完成 ────────────────────────────
    draftSet = await createVersionSet(YEAR_DRAFT);
    draftTravelId = await draftTravel(YEAR_DRAFT);
    draftDepreciationId = await draftDepreciation(YEAR_DRAFT);

    // ── SET_ORPHAN（2075）：只有版本、零申請 ─────────────────────────────
    orphanSet = await createVersionSet(YEAR_ORPHAN);
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (!prisma) return;
    if (createdAttachmentIds.length > 0) {
      await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
    }
    if (createdApplicationIds.length > 0) {
      await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
    }
    if (createdUserIds.length > 0) {
      // 保險網：清理範圍嚴格限於本檔自建之兩個使用者。
      await prisma.attachment.deleteMany({ where: { ownerId: { in: createdUserIds } } });
      await prisma.application.deleteMany({ where: { ownerId: { in: createdUserIds } } });
      await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.auditLog.deleteMany({
        where: { OR: [{ actorId: { in: createdUserIds } }, { targetId: { in: createdUserIds } }] },
      });
    }
    if (createdConsumptionVersionIds.length > 0) {
      await prisma.userFuelConsumptionVersion.deleteMany({
        where: { id: { in: createdConsumptionVersionIds } },
      });
    }
    if (createdFuelPriceVersionIds.length > 0) {
      await prisma.fuelPriceVersion.deleteMany({
        where: { id: { in: createdFuelPriceVersionIds } },
      });
    }
    if (createdLegacyFuelVersionIds.length > 0) {
      await prisma.fuelParameterVersion.deleteMany({
        where: { id: { in: createdLegacyFuelVersionIds } },
      });
    }
    if (createdEtcVersionIds.length > 0) {
      await prisma.etcParameterVersion.deleteMany({ where: { id: { in: createdEtcVersionIds } } });
    }
    if (createdDepreciationVersionIds.length > 0) {
      await prisma.depreciationParameterVersion.deleteMany({
        where: { id: { in: createdDepreciationVersionIds } },
      });
    }
    await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
    await prisma.$disconnect();
  }, 60_000);

  /** 五型別逐一查詢，回傳 `{ 型別: 判定 }` 之全等可比對物件。 */
  async function judgeAll(set: VersionSet): Promise<Record<ParameterType, boolean>> {
    const entries = await Promise.all(
      ALL_PARAMETER_TYPES.map(
        async (type) => [type, await parameterHasReferences(prisma, type, set[type])] as const
      )
    );
    return Object.fromEntries(entries) as Record<ParameterType, boolean>;
  }

  // ===========================================================================
  // AC-18(a) — 引用來源被作廢後仍判定為「已被引用」
  // ===========================================================================

  it("AC-18(a): 五型別逐一——引用來源被作廢後仍判定為已被引用（COMPLETED-only mutant 必紅）", async () => {
    // 前提：兩筆引用來源皆確實為 VOIDED（`voidViaEndpoint` 已逐筆斷言，此處
    // 於 `it` 內再次確認，避免 fixture 與斷言之間有其他測試改動狀態）。
    const travel = await prisma.application.findUniqueOrThrow({ where: { id: voidedTravelId } });
    const depreciation = await prisma.application.findUniqueOrThrow({
      where: { id: voidedDepreciationId },
    });
    expect(travel.status).toBe("VOIDED");
    expect(depreciation.status).toBe("VOIDED");

    // 前提：五個引用欄確實持有本組版本 id（四欄由真實完成流程寫入，legacy
    // `fuelParameterVersionId` 由 FW-3 之例外直寫模擬歷史列）。
    const travelRow = await prisma.travelApplication.findUniqueOrThrow({
      where: { applicationId: voidedTravelId },
    });
    expect(travelRow.fuelParameterVersionId).toBe(voidedSet.FUEL);
    expect(travelRow.fuelPriceVersionId).toBe(voidedSet.FUEL_PRICE);
    expect(travelRow.fuelConsumptionVersionId).toBe(voidedSet.FUEL_CONSUMPTION);
    expect(travelRow.etcParameterVersionId).toBe(voidedSet.ETC);
    const depreciationRow = await prisma.depreciationApplication.findUniqueOrThrow({
      where: { applicationId: voidedDepreciationId },
    });
    expect(depreciationRow.depreciationParameterVersionId).toBe(voidedSet.DEPRECIATION);

    // 主張：五型別**逐一**仍判定為「已被引用」（D2(a)／B-34）。
    // `toEqual` 全等比對——任一型別漏改（如只改差旅面而漏折舊面）即紅，
    // 且失敗訊息直接指出是哪一個型別。
    await expect(judgeAll(voidedSet)).resolves.toEqual({
      FUEL: true,
      FUEL_PRICE: true,
      FUEL_CONSUMPTION: true,
      ETC: true,
      DEPRECIATION: true,
    });

    // 鑑別力：同一組斷言對「零申請引用」之孤兒版本必須全為 false——否則
    // `{ in: [...] }` 之放寬若被寫成「移除 status 條件且忽略欄位」即無人攔截。
    await expect(judgeAll(orphanSet)).resolves.toEqual({
      FUEL: false,
      FUEL_PRICE: false,
      FUEL_CONSUMPTION: false,
      ETC: false,
      DEPRECIATION: false,
    });
  });

  // ===========================================================================
  // AC-18(b) — 僅被草稿引用者仍判定為「未被引用」（行為不變）
  // ===========================================================================

  it("AC-18(b): 僅被草稿引用者仍判定為未被引用", async () => {
    // 前提：兩筆申請確實為 DRAFT，且五個快照欄皆為 null（草稿無快照）。
    const travel = await prisma.application.findUniqueOrThrow({ where: { id: draftTravelId } });
    const depreciation = await prisma.application.findUniqueOrThrow({
      where: { id: draftDepreciationId },
    });
    expect(travel.status).toBe("DRAFT");
    expect(depreciation.status).toBe("DRAFT");

    const travelRow = await prisma.travelApplication.findUniqueOrThrow({
      where: { applicationId: draftTravelId },
    });
    expect(travelRow.fuelParameterVersionId).toBeNull();
    expect(travelRow.fuelPriceVersionId).toBeNull();
    expect(travelRow.fuelConsumptionVersionId).toBeNull();
    expect(travelRow.etcParameterVersionId).toBeNull();
    const depreciationRow = await prisma.depreciationApplication.findUniqueOrThrow({
      where: { applicationId: draftDepreciationId },
    });
    expect(depreciationRow.depreciationParameterVersionId).toBeNull();

    // 主張：草稿確實「用到」該年度版本（出差日期／申請年度落在生效區間），
    // 但因無快照 → 五型別逐一仍判「未被引用」。放寬 `status` 集合不得誤傷。
    await expect(judgeAll(draftSet)).resolves.toEqual({
      FUEL: false,
      FUEL_PRICE: false,
      FUEL_CONSUMPTION: false,
      ETC: false,
      DEPRECIATION: false,
    });
  });

  // ===========================================================================
  // AC-18(c) — 既有 COMPLETED 之正向判定逐型別零弱化
  // ===========================================================================

  it("AC-18(c): 既有 COMPLETED 正向判定逐型別零弱化", async () => {
    const travel = await prisma.application.findUniqueOrThrow({ where: { id: completedTravelId } });
    const depreciation = await prisma.application.findUniqueOrThrow({
      where: { id: completedDepreciationId },
    });
    expect(travel.status).toBe("COMPLETED");
    expect(depreciation.status).toBe("COMPLETED");

    const travelRow = await prisma.travelApplication.findUniqueOrThrow({
      where: { applicationId: completedTravelId },
    });
    expect(travelRow.fuelParameterVersionId).toBe(completedSet.FUEL);
    expect(travelRow.fuelPriceVersionId).toBe(completedSet.FUEL_PRICE);
    expect(travelRow.fuelConsumptionVersionId).toBe(completedSet.FUEL_CONSUMPTION);
    expect(travelRow.etcParameterVersionId).toBe(completedSet.ETC);
    const depreciationRow = await prisma.depreciationApplication.findUniqueOrThrow({
      where: { applicationId: completedDepreciationId },
    });
    expect(depreciationRow.depreciationParameterVersionId).toBe(completedSet.DEPRECIATION);

    // 主張：`COMPLETED` 之正向判定逐型別維持 true。
    // 反向 mutant（把條件改成 `{ in: ["VOIDED"] }`）於此必紅——雙向極性。
    await expect(judgeAll(completedSet)).resolves.toEqual({
      FUEL: true,
      FUEL_PRICE: true,
      FUEL_CONSUMPTION: true,
      ETC: true,
      DEPRECIATION: true,
    });

    // 鑑別力：孤兒版本仍為 false（本條亦不可能是「永遠 true」）。
    await expect(judgeAll(orphanSet)).resolves.toEqual({
      FUEL: false,
      FUEL_PRICE: false,
      FUEL_CONSUMPTION: false,
      ETC: false,
      DEPRECIATION: false,
    });
  });
});
