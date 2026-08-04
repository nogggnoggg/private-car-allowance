/**
 * Integration tests for PHASE-007-T7:
 *   折舊參數選版（該年度 1/1 有效版本）＋ 每公里單價套用（PHASE-003a
 *   `deriveDepreciation`）＋ `computed` 之完整接入（預覽端點與草稿 DTO）。
 *
 * Spec `docs/specs/PHASE-007.md`：
 *   §2 AC-15（選版四情境）、AC-16(整合層)（缺參數於草稿／預覽同步暴露）、
 *   AC-17（單價來源：4 位小數 `perKmUnitPrice`，不重寫推導）、AC-18(整合層)
 *   （`deriveDepreciation` 回 `ok:false` 視同缺參數，絕不 500）；
 *   §7.2（`DepreciationComputedDto` 七鍵形狀）、§7.4（計算五步驟）、
 *   §7.5（四碼固定順序與兩段式）、§9.2（預覽唯讀路徑）、
 *   §16 D5(a)／D6(a)（單價精度來源）／D8(a)（推導三值與版本 id 不外露）／
 *   D14(a)（`count`／`SUM` 不對稱）。
 *
 * TDD：本檔先於 `depreciation-parameters.ts` 與 `depreciation-service.ts` 之
 * 參數接線寫成，首輪為 RED（模組不存在 → import 失敗）。首輪 RED 輸出見 Task
 * Handoff。
 *
 * ── 本 Task 明示未涵蓋（據實揭露，非遺漏） ────────────────────────────────
 *   完成端點（`POST /applications/:id/complete`）之折舊分派屬 **T9**（Spec
 *   §15 T9 列）。故 AC-16 之「缺參數於**完成端點** 409」與 AC-18 之「兩來源
 *   訊息逐字互異 ＋ `details.missing` 區辨」於本 Task **無法**以端點測試覆蓋
 *   ——本檔改以 service 層之 `resolveDepreciationParameters` 回傳形狀釘住
 *   「兩來源之區辨資訊確實保留且可區分」（T3 即審 FW-6 之本層義務），端點面
 *   之 409 形狀由 T9 補齊。
 *
 * Test discipline（Spec §11.0 / Packet）：
 *   - loginName prefix "p7t7_" ＋ per-run random suffix；全程合成資料；
 *   - 清理僅限本套件自行追蹤之 id 與 loginName 前綴，絕不 deleteMany({})。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveDepreciationParameters } from "../../src/applications/depreciation-parameters.js";
import { hashPassword } from "../../src/auth/password.js";
import * as mileageEngine from "../../src/mileage/mileage-engine.js";
import * as depreciationEngine from "../../src/parameters/depreciation-engine.js";
import { buildServer } from "../../src/server.js";

/**
 * AC-17「突變自證」技法（沿 PHASE-007-T6 對 `mileage-engine.js` 之既有慣例）：
 * 以 `vi.mock` 包裝 `depreciation-engine.js` 之**真實實作**為 `vi.fn`（行為
 * 不變，只加可觀測性）。若 `depreciation-parameters.ts` 改為「移除 import、
 * 自行複製一份 `車價 ÷ 年限 ÷ 年里程` 的推導」，本檔對 spy 呼叫次數／參數之
 * 斷言會觀察到 0 次呼叫而必然轉紅——這即是「刪除 import 改私有複製必紅」。
 */
vi.mock("../../src/parameters/depreciation-engine.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/parameters/depreciation-engine.js")>();
  return {
    ...actual,
    deriveDepreciation: vi.fn(actual.deriveDepreciation),
  };
});

/** FW-5：DTO 接入後之聚合查詢次數（DRAFT +1／COMPLETED +0）以此 spy 釘住。 */
vi.mock("../../src/mileage/mileage-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mileage/mileage-engine.js")>();
  return {
    ...actual,
    sumOfficialMileage: vi.fn(actual.sumOfficialMileage),
  };
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const PARAMETERS_SRC_PATH = path.resolve(
  BACKEND_ROOT,
  "src/applications/depreciation-parameters.ts"
);
const SERVICE_SRC_PATH = path.resolve(BACKEND_ROOT, "src/applications/depreciation-service.ts");
const ROUTES_SRC_PATH = path.resolve(BACKEND_ROOT, "src/applications/routes.ts");

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
const LOGIN_PREFIX = "p7t7_";
const PASSWORD = "DepreciationParamsTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;

/**
 * 折舊參數版本時間軸（本檔之唯一 fixture 來源；per-file TRUNCATE 隔離，
 * 不繼承他檔資料）。
 *
 *   V1  2040-06-15  (10.00, 3, 3)          → perKmUnitPrice "1.1111"（AC-17 kill case）
 *   V2  2050-01-01  (600000.00, 5, 20000)  → "6.0000"
 *   V3  2050-07-01  (300000.00, 6, 30000)  → "1.6667"
 *   V4  2060-01-02  (1.00, 1, 10000)       → "0.0001"
 *   V5  2070-01-01  (0.00, 5, 20000)       → deriveDepreciation 回 ok:false（AC-18）
 *   V6  2080-01-01  (600000.00, 5, 20000)  → "6.0000"
 *
 * 查詢年度 → 期望選中版本（`findEffectiveVersion(全部版本, YYYY-01-01)`）：
 *   2039 → 無（全部版本皆晚於 2039-01-01）      AC-15 ④
 *   2041 → V1（前一年之版本，最近一版）          AC-15 ③
 *   2050 → V2（生效日恰為 1/1，含當日）          AC-15 ①
 *   2051 → V3（2050 年中途之新版本，次年才生效）  AC-15 ②
 *   2060 → V3（V4 生效日為 01-02，不被選中）      AC-15 ②
 *   2061 → V4
 *   2070 → V5（推導失敗）                        AC-18
 *   2081/2084/2085 → V6
 */
const VERSIONS = [
  { key: "V1", effectiveFrom: "2040-06-15", vehiclePrice: "10.00", years: 3, km: 3 },
  { key: "V2", effectiveFrom: "2050-01-01", vehiclePrice: "600000.00", years: 5, km: 20000 },
  { key: "V3", effectiveFrom: "2050-07-01", vehiclePrice: "300000.00", years: 6, km: 30000 },
  { key: "V4", effectiveFrom: "2060-01-02", vehiclePrice: "1.00", years: 1, km: 10000 },
  { key: "V5", effectiveFrom: "2070-01-01", vehiclePrice: "0.00", years: 5, km: 20000 },
  { key: "V6", effectiveFrom: "2080-01-01", vehiclePrice: "600000.00", years: 5, km: 20000 },
] as const;

const YEAR_NO_VERSION = 2039;
const YEAR_PREVIOUS_VERSION = 2041;
const YEAR_EXACT_JAN1 = 2050;
const YEAR_MID_YEAR_NEXT = 2051;
const YEAR_JAN2_EXCLUDED = 2060;
const YEAR_TINY_PRICE = 2061;
const YEAR_DERIVATION_FAILED = 2070;
const YEAR_AMOUNT = 2081;
const YEAR_COUNT_NEUTRAL_A = 2084;
const YEAR_COUNT_NEUTRAL_B = 2087;
const YEAR_ON_BEHALF = 2090;
const YEAR_NO_ATTACHMENT = 2093;

type ComputedDto = {
  calculable: boolean;
  officialKm: string | null;
  officialApplicationCount: number | null;
  perKmUnitPrice: string | null;
  rawAmount: string | null;
  amount: number | null;
  blockingCodes: string[];
};

type BlockerDto = { code: string; field?: string; message: string };

type ApplicationDto = {
  id: string;
  status: string;
  computed: ComputedDto | null;
  completionBlockers: BlockerDto[] | null;
  snapshot: Record<string, unknown> | null;
};

describeWithDb("PHASE-007-T7 — 折舊參數選版 ＋ 單價套用 ＋ computed 完整接入", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let adminId: string;
  let ownerCookie: string;
  let adminCookie: string;

  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  function track(id: string): string {
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
        displayName: "P7T7 擁有人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "P7T7 管理員",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    ownerId = owner.id;
    adminId = admin.id;

    for (const version of VERSIONS) {
      await prisma.depreciationParameterVersion.create({
        data: {
          vehiclePrice: version.vehiclePrice,
          usefulLifeYears: version.years,
          estimatedAnnualKm: version.km,
          effectiveFrom: new Date(`${version.effectiveFrom}T00:00:00.000Z`),
          createdById: adminId,
        },
      });
    }

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
      const userIds = [ownerId, adminId].filter(Boolean);
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

  /** 建立一筆已完成差旅列（直寫 DB，以精確控制歸屬年度與里程）。 */
  async function createCompletedTravel(opts: {
    ownerId: string;
    date: string;
    snapshotTotalKm: string | null;
  }): Promise<string> {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: opts.ownerId,
        createdById: opts.ownerId,
        primaryDate: new Date(opts.date),
        travel: {
          create: {
            tripDate: new Date(opts.date),
            ...(opts.snapshotTotalKm === null ? {} : { snapshotTotalKm: opts.snapshotTotalKm }),
          },
        },
      },
    });
    return track(application.id);
  }

  async function createTempAttachment(attachmentOwnerId: string): Promise<string> {
    const suffix = `${RUN_ID}_${createdAttachmentIds.length}`;
    const attachment = await prisma.attachment.create({
      data: {
        status: "TEMP",
        storageKey: `p7t7/${suffix}.jpg`,
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

  async function previewOk(cookie: string, payload: Record<string, unknown>): Promise<ComputedDto> {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/depreciation/preview",
      headers: { cookie },
      payload,
    });
    expect(resp.statusCode).toBe(200);
    return resp.json<{ preview: ComputedDto }>().preview;
  }

  /** 建立折舊草稿（經真實端點），可選擇同時關聯 n 張證明附件。 */
  async function createDraft(
    applicationYear: number | null,
    attachmentCount = 0
  ): Promise<ApplicationDto> {
    const created = await app.inject({
      method: "POST",
      url: "/applications/depreciation",
      headers: { cookie: ownerCookie },
      payload: { applicationYear },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json<{ application: ApplicationDto }>().application;
    track(draft.id);

    if (attachmentCount > 0) {
      const ids: string[] = [];
      for (let i = 0; i < attachmentCount; i++) {
        ids.push(await createTempAttachment(ownerId));
      }
      const updated = await app.inject({
        method: "PUT",
        url: `/applications/depreciation/${draft.id}`,
        headers: { cookie: ownerCookie },
        payload: { attachmentIds: ids },
      });
      expect(updated.statusCode).toBe(200);
      return updated.json<{ application: ApplicationDto }>().application;
    }
    return draft;
  }

  async function getApplication(cookie: string, id: string): Promise<ApplicationDto> {
    const resp = await app.inject({
      method: "GET",
      url: `/applications/depreciation/${id}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    return resp.json<{ application: ApplicationDto }>().application;
  }

  function blockerCodes(blockers: BlockerDto[] | null): string[] {
    return (blockers ?? []).map((b) => b.code);
  }

  // ===========================================================================
  // §1 AC-15 — 依申請年度 1/1 選版（`findEffectiveVersion`，含當日）
  // ===========================================================================

  describe("AC-15: the version effective on Jan 1 of the application year is selected via findEffectiveVersion", () => {
    it("接線斷言：depreciation-parameters.ts 由 parameter-version-engine.js import findEffectiveVersion（不自行實作選版）", () => {
      const source = fs.readFileSync(PARAMETERS_SRC_PATH, "utf8");
      expect(source).toMatch(
        /import\s*\{[^}]*findEffectiveVersion[^}]*\}\s*from\s*["']\.\.\/parameters\/parameter-version-engine\.js["']/
      );
      // 私有複製反證：本檔不得自行做日期排序／比較選版。
      expect(source).not.toMatch(/\.sort\s*\(/);
    });

    it("AC-15 逐字：全部版本 findMany 後以純函式選版——不得在 DB 層以 effectiveFrom: { lte } 先過濾", () => {
      const source = fs.readFileSync(PARAMETERS_SRC_PATH, "utf8");
      expect(source).toMatch(/depreciationParameterVersion\.findMany\(/);
      expect(source).not.toMatch(/lte/);
      expect(source).not.toMatch(/orderBy/);
    });

    it("① 生效日恰為 YYYY-01-01 之版本被選中（含當日）", async () => {
      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_EXACT_JAN1 });
      expect(preview.perKmUnitPrice).toBe("6.0000");
    });

    it("② 年度中途（YYYY-07-01）之新版本不影響當年計算，次年才生效（BE-US-16 第 3 條）", async () => {
      const thisYear = await previewOk(ownerCookie, { applicationYear: YEAR_EXACT_JAN1 });
      const nextYear = await previewOk(ownerCookie, { applicationYear: YEAR_MID_YEAR_NEXT });
      // MUTANT：若選版誤以「年度內最後一版」為準，本年即得 "1.6667" 而必紅。
      expect(thisYear.perKmUnitPrice).toBe("6.0000");
      expect(nextYear.perKmUnitPrice).toBe("1.6667");
    });

    it("② 生效日為 YYYY-01-02 之版本不被選中（差一日之邊界）", async () => {
      const sameYear = await previewOk(ownerCookie, { applicationYear: YEAR_JAN2_EXCLUDED });
      const nextYear = await previewOk(ownerCookie, { applicationYear: YEAR_TINY_PRICE });
      expect(sameYear.perKmUnitPrice).toBe("1.6667");
      expect(nextYear.perKmUnitPrice).toBe("0.0001");
    });

    it("③ 生效日為前一年之版本被選中（最近一版）", async () => {
      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_PREVIOUS_VERSION });
      expect(preview.perKmUnitPrice).toBe("1.1111");
    });

    it("④ 全部版本皆晚於該年 1/1 → 查無有效版本（單價 null）", async () => {
      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_NO_VERSION });
      expect(preview.perKmUnitPrice).toBeNull();
      expect(preview.rawAmount).toBeNull();
      expect(preview.amount).toBeNull();
    });

    it("選版查詢日為該年 1/1（UTC 建構）：service 層 resolveDepreciationParameters 回傳之版本恰為期望版本", async () => {
      const exact = await resolveDepreciationParameters(prisma, YEAR_EXACT_JAN1);
      const previous = await resolveDepreciationParameters(prisma, YEAR_PREVIOUS_VERSION);
      const none = await resolveDepreciationParameters(prisma, YEAR_NO_VERSION);

      expect(exact.version?.effectiveFrom.toISOString().slice(0, 10)).toBe("2050-01-01");
      expect(previous.version?.effectiveFrom.toISOString().slice(0, 10)).toBe("2040-06-15");
      expect(none.version).toBeNull();
    });
  });

  // ===========================================================================
  // §2 AC-17 — 單價一律取自 PHASE-003a `deriveDepreciation`（4 位小數）
  // ===========================================================================

  describe("AC-17: perKmUnitPrice comes verbatim from deriveDepreciation (4dp) — import wiring + live mutation self-proof", () => {
    it("接線斷言：depreciation-parameters.ts 由 parameters/depreciation-engine.js import deriveDepreciation，且無任何私有推導算式", () => {
      const source = fs.readFileSync(PARAMETERS_SRC_PATH, "utf8");
      expect(source).toMatch(
        /import\s*\{[^}]*deriveDepreciation[^}]*\}\s*from\s*["']\.\.\/parameters\/depreciation-engine\.js["']/
      );
      // 私有複製反證：本檔不得出現 `車價 ÷ 年限 ÷ 年里程` 之任何除法。
      expect(source).not.toMatch(/dividedBy|\bdiv\s*\(/);
    });

    it("活體突變自證：一次預覽確實呼叫真實（被 spy 包裝之）deriveDepreciation，且引數為所選版本之三值", async () => {
      const spy = vi.mocked(depreciationEngine.deriveDepreciation);
      spy.mockClear();

      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_PREVIOUS_VERSION });

      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0][0];
      expect(arg.vehiclePrice?.toString()).toBe("10");
      expect(arg.usefulLifeYears).toBe(3);
      expect(arg.estimatedAnnualKm).toBe(3);
      expect(preview.perKmUnitPrice).toBe("1.1111");
    });

    it('kill case（Spec AC-17 逐字）：vehiclePrice=10, usefulLifeYears=3, estimatedAnnualKm=3 → "1.1111"（以已取整之每年費用 3.33 為分子會得 "1.1100"，必紅）', async () => {
      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_PREVIOUS_VERSION });
      expect(preview.perKmUnitPrice).toBe("1.1111");
      expect(preview.perKmUnitPrice).not.toBe("1.1100");
    });

    it("D6(a)：本 Phase 不得對單價二次取整、不得整數化——1.6667 原樣呈現（取整為 2 必紅）", async () => {
      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_MID_YEAR_NEXT });
      expect(preview.perKmUnitPrice).toBe("1.6667");
      expect(preview.perKmUnitPrice).not.toBe("2");
      expect(preview.perKmUnitPrice).not.toBe("2.0000");
    });
  });

  // ===========================================================================
  // §3 AC-16(整合層) — 缺參數於「預覽」與「草稿」同步暴露（反模式封閉）
  // ===========================================================================

  describe("AC-16(b): a year with no effective version is blocked identically in preview and in the draft DTO", () => {
    it("預覽：calculable=false ＋ blockingCodes=[PARAMETER_NOT_AVAILABLE]，年度里程仍如實回報", async () => {
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_NO_VERSION}-05-05`,
        snapshotTotalKm: "120.00",
      });

      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_NO_VERSION });
      expect(preview.calculable).toBe(false);
      expect(preview.blockingCodes).toEqual(["PARAMETER_NOT_AVAILABLE"]);
      expect(preview.officialKm).toBe("120.00");
      expect(preview.officialApplicationCount).toBe(1);
    });

    it("草稿 DTO（已有 1 張證明）：completionBlockers 含 PARAMETER_NOT_AVAILABLE，且 computed.calculable=false（不得「預覽說可以、完成才擋」）", async () => {
      const draft = await createDraft(YEAR_NO_VERSION, 1);
      expect(blockerCodes(draft.completionBlockers)).toEqual(["PARAMETER_NOT_AVAILABLE"]);
      expect(draft.computed).not.toBeNull();
      expect(draft.computed?.calculable).toBe(false);
      expect(draft.computed?.blockingCodes).toEqual(["PARAMETER_NOT_AVAILABLE"]);
      expect(draft.computed?.perKmUnitPrice).toBeNull();
    });

    it("兩段式（§7.5 逐字）：草稿零附件時第 3 碼於 completionBlockers 被抑制，但 computed 仍如實回報不可計算（空清單 ≠ 可計算）", async () => {
      const draft = await createDraft(YEAR_NO_VERSION, 0);
      expect(blockerCodes(draft.completionBlockers)).toEqual(["DEPRECIATION_ATTACHMENT_REQUIRED"]);
      expect(draft.computed?.calculable).toBe(false);
      expect(draft.computed?.blockingCodes).toEqual(["PARAMETER_NOT_AVAILABLE"]);
    });

    it("T3 即審 FW-3 逐字：草稿零附件但參數齊備 → completionBlockers 非空，而 computed.calculable 仍為 true（禁止由 blocker 清單反推可計算性）", async () => {
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_NO_ATTACHMENT}-03-03`,
        snapshotTotalKm: "200.00",
      });

      const draft = await createDraft(YEAR_NO_ATTACHMENT, 0);
      // 完成度未過（缺證明），但「金額算不算得出來」與證明無關。
      expect(blockerCodes(draft.completionBlockers)).toEqual(["DEPRECIATION_ATTACHMENT_REQUIRED"]);
      // MUTANT：若以 `completionBlockers.length === 0` 反推 `calculable`
      // （或把附件計數餵進 `computed` 路徑），此處必得 false 而紅。
      expect(draft.computed?.calculable).toBe(true);
      expect(draft.computed?.blockingCodes).toEqual([]);
      expect(draft.computed?.perKmUnitPrice).toBe("6.0000");
      expect(draft.computed?.amount).toBe(1200);
    });

    it("年度為 null 之草稿：computed 只回 [YEAR_REQUIRED]（尚未查詢里程與參數）", async () => {
      const draft = await createDraft(null, 1);
      expect(draft.computed?.blockingCodes).toEqual(["YEAR_REQUIRED"]);
      expect(draft.computed?.officialKm).toBeNull();
      expect(draft.computed?.perKmUnitPrice).toBeNull();
      expect(blockerCodes(draft.completionBlockers)).toEqual(["YEAR_REQUIRED"]);
    });
  });

  // ===========================================================================
  // §4 AC-18(整合層) — deriveDepreciation 回 ok:false 視同缺參數
  // ===========================================================================

  describe("AC-18: deriveDepreciation returning ok:false is treated as a missing parameter — never 500, never a zero unit price", () => {
    it("推導失敗之年度：預覽 200（絕不 500）、calculable=false、單價 null、blockingCodes=[PARAMETER_NOT_AVAILABLE]", async () => {
      const spy = vi.mocked(depreciationEngine.deriveDepreciation);
      spy.mockClear();

      const preview = await previewOk(ownerCookie, {
        applicationYear: YEAR_DERIVATION_FAILED,
      });

      expect(preview.calculable).toBe(false);
      expect(preview.perKmUnitPrice).toBeNull();
      expect(preview.amount).toBeNull();
      expect(preview.blockingCodes).toEqual(["PARAMETER_NOT_AVAILABLE"]);

      // 鑑別力自證：確實走到推導（版本有被選中）且推導確實回 ok:false，
      // 而非「查無版本」之另一條路徑。
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.results[0].value).toEqual({ ok: false });
      // 「絕不以單價 0 完成」：0 元單價之靜默放行必使上一段斷言轉紅。
      expect(preview.perKmUnitPrice).not.toBe("0.0000");
    });

    it("T3 即審 FW-6：service 層保留「查無版本」與「推導失敗」兩來源之區辨資訊（供 T9 之 409 details.missing 使用）", async () => {
      const noVersion = await resolveDepreciationParameters(prisma, YEAR_NO_VERSION);
      const derivationFailed = await resolveDepreciationParameters(prisma, YEAR_DERIVATION_FAILED);

      expect(noVersion.perKmUnitPrice).toBeNull();
      expect(noVersion.version).toBeNull();
      expect(noVersion.derivationFailed).toBe(false);
      expect(noVersion.missing).toEqual(["DEPRECIATION"]);

      expect(derivationFailed.perKmUnitPrice).toBeNull();
      expect(derivationFailed.version).not.toBeNull();
      expect(derivationFailed.derivationFailed).toBe(true);
      expect(derivationFailed.missing).toEqual(["DEPRECIATION_DERIVATION_FAILED"]);

      // 兩來源必須可區分（若實作把兩者折成同一形狀，本斷言必紅）。
      expect(derivationFailed.missing).not.toEqual(noVersion.missing);
    });

    /**
     * T7 即審 SF-1（reviewer PROBE-7 實測之潛伏缺陷）：`missing` 陣列**絕不可**
     * 跨呼叫共用同一參考。
     *
     * 為什麼這件事會咬人：Spec §7.4 ② 之字面就是 `missing += "DEPRECIATION_
     * DERIVATION_FAILED"`——T9 完成端點組 409 `details.missing` 時極可能直接
     * 對回傳值 `push`。若回傳的是共用常數之淺複製（`{ ...NOT_AVAILABLE }`），
     * 內層陣列仍是同一個物件，一次 `push` 會同時污染**先前已回傳**的結果與
     * **後續全部新呼叫**——症狀是「某些申請莫名多出一個 missing 代碼」，且
     * 因程序重啟即消失而極難重現。
     *
     * 本測試同時釘住兩個性質：(1) 不同呼叫之 `missing` 非同一參考；
     * (2) 對回傳值變異後，新呼叫之結果逐字不受影響。
     */
    it("T7 即審 SF-1：每次呼叫回傳全新的 missing 陣列——變異其一不得污染既有結果或後續呼叫", async () => {
      const first = await resolveDepreciationParameters(prisma, YEAR_NO_VERSION);
      const second = await resolveDepreciationParameters(prisma, YEAR_NO_VERSION);

      // (1) 值相同但**參考相異**（`{ ...常數 }` 之淺複製於此必紅）。
      expect(second.missing).toEqual(first.missing);
      expect(second.missing).not.toBe(first.missing);
      expect(second).not.toBe(first);

      // (2) 模擬 §7.4 ② 之 `missing +=`（T9 之預期用法）。
      first.missing.push("DEPRECIATION_DERIVATION_FAILED");

      // 既有結果不得被牽連。
      expect(second.missing).toEqual(["DEPRECIATION"]);
      // 後續全新呼叫亦不得帶著上一次的污染（含「查無版本」與「推導失敗」
      // 兩條 return 路徑）。
      const third = await resolveDepreciationParameters(prisma, YEAR_NO_VERSION);
      expect(third.missing).toEqual(["DEPRECIATION"]);
      const nullYear = await resolveDepreciationParameters(prisma, null);
      expect(nullYear.missing).toEqual(["DEPRECIATION"]);
      const failed = await resolveDepreciationParameters(prisma, YEAR_DERIVATION_FAILED);
      expect(failed.missing).toEqual(["DEPRECIATION_DERIVATION_FAILED"]);
    });
  });

  // ===========================================================================
  // §5 金額接線（§7.4 ④⑤；T2 即審 FW-4 之 DTO 呈現面）
  // ===========================================================================

  describe("computed amount wiring: rawAmount is quantised to 4dp for display only and never fed back into amount", () => {
    it('正向：officialKm 1000.00 × 6.0000 → rawAmount "6000.0000"、amount 6000、calculable=true、blockingCodes 空', async () => {
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_AMOUNT}-04-04`,
        snapshotTotalKm: "1000.00",
      });

      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_AMOUNT });
      expect(preview.officialKm).toBe("1000.00");
      expect(preview.perKmUnitPrice).toBe("6.0000");
      expect(preview.rawAmount).toBe("6000.0000");
      expect(preview.amount).toBe(6000);
      expect(preview.calculable).toBe(true);
      expect(preview.blockingCodes).toEqual([]);
    });

    it('kill case（T2 即審 FW-4）：officialKm 12344999.50 × 0.0001 → rawAmount 顯示 "1234.5000"（4dp ROUND_HALF_UP）而 amount 仍為 1234——量化值若回餵取整必得 1235 而紅', async () => {
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_TINY_PRICE}-08-08`,
        snapshotTotalKm: "12344999.50",
      });

      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_TINY_PRICE });
      expect(preview.officialKm).toBe("12344999.50");
      expect(preview.perKmUnitPrice).toBe("0.0001");
      // 真實 rawAmount ＝ 1234.49995（6 位小數之乘積）；DTO 顯示量化為 4 位。
      expect(preview.rawAmount).toBe("1234.5000");
      // amount 取自「未量化」之 rawAmount：ROUND_HALF_UP(1234.49995, 0) = 1234。
      expect(preview.amount).toBe(1234);
      expect(preview.amount).not.toBe(1235);
      expect(preview.calculable).toBe(true);
    });

    it("AC-13 等價斷言（T6 即審 FW-3 移交）：有效參數下 officialKm 相同而 applicationCount 相異 → 全部金額面欄位逐欄全等（且為真實非 null 值）", async () => {
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_COUNT_NEUTRAL_A}-06-06`,
        snapshotTotalKm: "100.00",
      });
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_COUNT_NEUTRAL_B}-06-06`,
        snapshotTotalKm: "100.00",
      });
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_COUNT_NEUTRAL_B}-06-07`,
        snapshotTotalKm: null,
      });
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_COUNT_NEUTRAL_B}-06-08`,
        snapshotTotalKm: null,
      });

      const a = await previewOk(ownerCookie, { applicationYear: YEAR_COUNT_NEUTRAL_A });
      const b = await previewOk(ownerCookie, { applicationYear: YEAR_COUNT_NEUTRAL_B });

      // 前提自證：兩年之 totalKm 相同、筆數確實相異，且金額為真實值（非 null
      // 對 null 之假綠——這正是 T6b 移交本 Task 的鑑別力升級義務）。
      expect(a.officialKm).toBe("100.00");
      expect(b.officialKm).toBe("100.00");
      expect(a.officialApplicationCount).toBe(1);
      expect(b.officialApplicationCount).toBe(3);
      expect(a.amount).toBe(600);
      expect(a.rawAmount).toBe("600.0000");

      expect(b.perKmUnitPrice).toEqual(a.perKmUnitPrice);
      expect(b.rawAmount).toEqual(a.rawAmount);
      expect(b.amount).toEqual(a.amount);
      expect(b.calculable).toEqual(a.calculable);
      expect({ ...b, officialApplicationCount: a.officialApplicationCount }).toEqual(a);
    });
  });

  // ===========================================================================
  // §6 §16 D8(a) — 推導三值與版本 id 不外露（負向斷言）
  // ===========================================================================

  describe("D8(a): no depreciation DTO ever exposes vehiclePrice / usefulLifeYears / estimatedAnnualKm / version id", () => {
    it("預覽 DTO 之鍵集恰為 §7.2 之七鍵，且不含推導三值與版本 id", async () => {
      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_EXACT_JAN1 });
      expect(Object.keys(preview).sort()).toEqual(
        [
          "amount",
          "blockingCodes",
          "calculable",
          "officialApplicationCount",
          "officialKm",
          "perKmUnitPrice",
          "rawAmount",
        ].sort()
      );
      for (const forbidden of [
        "vehiclePrice",
        "usefulLifeYears",
        "estimatedAnnualKm",
        "depreciationParameterVersionId",
        "versionId",
      ]) {
        expect(preview as Record<string, unknown>).not.toHaveProperty(forbidden);
      }
    });

    it("草稿 DTO 之 wire 位元組不得出現推導三值之欄位名，且 computed 之序列化不含所選版本之三值（600000／5／20000）", async () => {
      const draft = await createDraft(YEAR_AMOUNT, 1);
      const resp = await app.inject({
        method: "GET",
        url: `/applications/depreciation/${draft.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(200);
      // 欄位名：整份 wire 位元組（含 `attachments`／`duplicateYearNotice`）皆
      // 不得出現——欄位名為固定字串，此掃描是決定性的。
      expect(resp.body).not.toContain("vehiclePrice");
      expect(resp.body).not.toContain("usefulLifeYears");
      expect(resp.body).not.toContain("estimatedAnnualKm");
      expect(resp.body).not.toContain("depreciationParameterVersionId");

      // 值：僅掃描 `computed` 之序列化。**刻意不掃整份 body**——cuid 與 ISO
      // 時戳含隨機／時間相依之數字串，對數值子字串的全域掃描會是不決定性的
      // 斷言（曾實測偶發假紅）。`computed` 由本 Task 完全掌控，掃描它才是對
      // 「D8 是否外露」有鑑別力的範圍。
      const computedJson = JSON.stringify(
        resp.json<{ application: ApplicationDto }>().application.computed
      );
      expect(computedJson).not.toContain("600000");
      expect(computedJson).not.toContain("20000");
      expect(computedJson).toContain("6.0000");
    });
  });

  // ===========================================================================
  // §7 T6 即審 FW-5 — DTO 接入後之查詢面（DRAFT +1／COMPLETED +0）與單一組裝點
  // ===========================================================================

  describe("FW-5: the DTO builder is the single assembly point; DRAFT costs exactly one aggregate + one derivation, COMPLETED costs zero", () => {
    it("GET DRAFT → sumOfficialMileage +1 且 deriveDepreciation +1；GET COMPLETED → 兩者皆 +0 且 computed 為 null", async () => {
      const draft = await createDraft(YEAR_AMOUNT, 1);

      const mileageSpy = vi.mocked(mileageEngine.sumOfficialMileage);
      const deriveSpy = vi.mocked(depreciationEngine.deriveDepreciation);

      mileageSpy.mockClear();
      deriveSpy.mockClear();
      const asDraft = await getApplication(ownerCookie, draft.id);
      expect(mileageSpy).toHaveBeenCalledTimes(1);
      expect(deriveSpy).toHaveBeenCalledTimes(1);
      expect(asDraft.computed).not.toBeNull();

      await prisma.application.update({
        where: { id: draft.id },
        data: { status: "COMPLETED", completedAt: new Date(), totalAmount: 6000 },
      });

      mileageSpy.mockClear();
      deriveSpy.mockClear();
      const asCompleted = await getApplication(ownerCookie, draft.id);
      expect(mileageSpy).toHaveBeenCalledTimes(0);
      expect(deriveSpy).toHaveBeenCalledTimes(0);
      expect(asCompleted.computed).toBeNull();
      expect(asCompleted.completionBlockers).toBeNull();
    });

    it("單一組裝點：routes.ts 之折舊三端點一律經 buildDepreciationApplicationDto，且不自行 import 計算／blocker 純函式", () => {
      const source = fs.readFileSync(ROUTES_SRC_PATH, "utf8");
      // POST／GET／PUT 三處呼叫（`await buildDepreciationApplicationDto(...)`）。
      const builderCalls = source.match(/await buildDepreciationApplicationDto\(/g) ?? [];
      expect(builderCalls.length).toBe(3);
      // routes.ts 不得自行 import 金額／blocker／參數純函式（否則即出現第二個
      // 組裝點，`computed` 與 `completionBlockers` 可各自漂移）。
      const importBlock = source.slice(0, source.indexOf("export const applicationsPlugin"));
      expect(importBlock).not.toMatch(/^\s*calculateDepreciation,?$/m);
      expect(importBlock).not.toMatch(/^\s*computeDepreciationBlockers,?$/m);
      expect(importBlock).not.toMatch(/^\s*resolveDepreciationParameters,?$/m);
      expect(importBlock).not.toMatch(/depreciation-parameters\.js/);
    });

    it("DTO 組裝者本身不查 DB（`toDepreciationApplicationDto` 為純組裝，查詢一律由 build* 編排層負責）", () => {
      const source = fs.readFileSync(SERVICE_SRC_PATH, "utf8");
      const builderBody = source.slice(
        source.indexOf("export function toDepreciationApplicationDto"),
        source.indexOf("export async function computeDuplicateYearNotice")
      );
      expect(builderBody.length).toBeGreaterThan(0);
      expect(builderBody).not.toMatch(/await\s/);
      expect(builderBody).not.toMatch(/findMany|findUnique|aggregate/);
    });
  });

  // ===========================================================================
  // §8 T6b 移交 (a)（T6 即審 FW-4）— 代操作草稿之 computed 以擁有人計算
  // ===========================================================================

  describe("on-behalf drafts: computed.officialKm is always the OWNER's mileage, never the operator's", () => {
    it("代操作草稿（ownerId=擁有人、createdById=管理員）之 DTO computed.officialKm ＝ 擁有人里程", async () => {
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_ON_BEHALF}-02-02`,
        snapshotTotalKm: "88.00",
      });
      await createCompletedTravel({
        ownerId: adminId,
        date: `${YEAR_ON_BEHALF}-02-02`,
        snapshotTotalKm: "777.00",
      });

      // `POST /admin/users/:userId/applications/depreciation` 屬 T11 尚未落地，
      // 故以 DB fixture 直建等價資料形狀。
      const application = await prisma.application.create({
        data: {
          type: "DEPRECIATION",
          status: "DRAFT",
          ownerId,
          createdById: adminId,
          primaryDate: new Date(Date.UTC(YEAR_ON_BEHALF, 11, 31)),
          depreciation: { create: { applicationYear: YEAR_ON_BEHALF } },
        },
      });
      track(application.id);

      // 006 T8 MF-1 教訓：以頂層純量斷言 fixture 之代操作形狀。
      expect(application.ownerId).toBe(ownerId);
      expect(application.createdById).toBe(adminId);
      expect(application.ownerId).not.toBe(application.createdById);

      const asAdmin = await getApplication(adminCookie, application.id);
      // MUTANT：若 DTO 以操作者（管理員）計算，此處得 "777.00" 而必紅。
      expect(asAdmin.computed?.officialKm).toBe("88.00");
      expect(asAdmin.computed?.officialApplicationCount).toBe(1);
      // 金額面亦以擁有人里程為準（V6：6.0000）。
      expect(asAdmin.computed?.amount).toBe(528);

      const asOwner = await getApplication(ownerCookie, application.id);
      expect(asOwner.computed).toEqual(asAdmin.computed);
    });
  });
});
