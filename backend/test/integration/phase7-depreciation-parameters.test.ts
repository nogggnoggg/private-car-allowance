/**
 * Integration tests for PHASE-007-R6（折舊模型修訂段——計算接線）:
 *   折舊參數選版（該年度 1/1 有效版本）＋ **每年折舊費用**（PHASE-007-R4a
 *   `deriveAnnualDepreciation`）＋ `computed` 之完整接入（預覽端點、草稿 DTO、
 *   完成端點）＋ 比例守門三處一致。
 *
 * Spec `docs/specs/PHASE-007.md`：
 *   §2 AC-15（選版四情境，語意不變）、AC-18(整合層)（推導失敗視同缺參數）、
 *   §20.3 AC-49(整合層)（每年費用之來源、`deriveAnnualDepreciation` import
 *   突變自證、`deriveDepreciation` **負向 spy**）、AC-51(整合層)（§20.4.3 之
 *   PRIMARY／SECONDARY／`ROUND_HALF_UP` kill case 與取整層級）、AC-52(整合層)
 *   （比例 >100% 之三處一致與邊界）、AC-53(整合層)（未輸入年度總里程）；
 *   §20.4（修訂後計算語意）、§20.5（六碼固定順序與兩段式）、§20.6（修訂後
 *   `DepreciationComputedDto` **十鍵**形狀、揭露面不變式）、§20.8.1／§20.8.2。
 *
 * ── 本檔之測試遷移授權（§20.11.2 之 R6 列逐字） ──────────────────────────
 *   「AC-17 退場→AC-49；AC-51/52 整合層」。AC-17（每公里單價）已隨裁定①退出
 *   申請路徑，本檔原 §2「AC-17」describe 之斷言依 Spec 更新為 AC-49（每年折舊
 *   費用）——**依 Spec 更新斷言，非弱化測試**（§20.11.1 之明文授權）。原
 *   `deriveDepreciation` 之正向 spy 反轉為 **負向 spy（呼叫數 ＝ 0）**，鑑別
 *   力不減反增（AC-49(c)）。
 *
 * ── 本 Task 明示未涵蓋（據實揭露，非遺漏） ────────────────────────────────
 *   9 欄快照之逐位元斷言、證明選填之反轉、舊模型列唯讀（AC-54~56）屬 **R7**；
 *   本檔對完成端點只覆蓋 R6 之義務（比例守門三處一致之第三處、缺參數 409、
 *   AC-53(c) 之零寫入），不覆蓋快照欄集合。
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
 * AC-49(c)「活體突變自證」技法（沿 PHASE-007-T6 對 `mileage-engine.js` 之既有
 * 慣例）：以 `vi.mock` 包裝 `depreciation-engine.js` 之**真實實作**為 `vi.fn`
 * （行為不變，只加可觀測性）。
 *
 *   - `deriveAnnualDepreciation`：**正向** spy。若 `depreciation-parameters.ts`
 *     改為「移除 import、自行複製一份 `車價 ÷ 年限` 的推導」，本檔對呼叫次數／
 *     引數之斷言會觀察到 0 次呼叫而必然轉紅（＝「刪除 import 改私有複製必紅」）。
 *   - `deriveDepreciation`：**負向** spy（AC-49(c) 逐字：「完成與預覽全程呼叫
 *     次數 ＝ 0」）。修訂後之申請路徑不得再觸碰每公里單價引擎。
 */
vi.mock("../../src/parameters/depreciation-engine.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/parameters/depreciation-engine.js")>();
  return {
    ...actual,
    deriveDepreciation: vi.fn(actual.deriveDepreciation),
    deriveAnnualDepreciation: vi.fn(actual.deriveAnnualDepreciation),
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
 * **修訂後之申請路徑只消費「每年折舊費用 ＝ ROUND_HALF_UP(車價 ÷ 年限, 2)」**
 * （AC-49(a)）；`estimatedAnnualKm` 只是歷史欄位（AC-57(c) 之唯讀保留），對
 * 申請計算**零影響**。
 *
 *   V1  2040-06-15  (10.00, 3, km 3)          → annualDepreciation "3.33"
 *   V2  2050-01-01  (600000.00, 5, km 20000)  → "120000.00"
 *   V3  2050-07-01  (300000.00, 6, km 30000)  → "50000.00"
 *   V4  2060-01-02  (1.00, 1, km 10000)       → "1.00"
 *   V5  2070-01-01  (0.00, 5, km 20000)       → deriveAnnualDepreciation ok:false（AC-49(e)）
 *   V6  2080-01-01  (600000.00, 5, km 20000)  → "120000.00"
 *   V7  2100-01-01  (300000.00, 3, km **null**) → "100000.00"
 *       ★ V7 為 **AC-57 縮欄後之新版本形狀**（`estimatedAnnualKm` 為 `NULL`）。
 *         舊實作以 `estimatedAnnualKm ?? 0` 餵 `deriveDepreciation`，會使該版本
 *         被誤判為 `DEPRECIATION_DERIVATION_FAILED`；本檔 §4 以正例釘死此回歸。
 *         其每年費用 `100000.00` 同時是 §20.4.3 全部 kill case 之引擎可達來源。
 *
 * 查詢年度 → 期望選中版本（`findEffectiveVersion(全部版本, YYYY-01-01)`）：
 *   2039 → 無（全部版本皆晚於 2039-01-01）      AC-15 ④
 *   2041 → V1（前一年之版本，最近一版）          AC-15 ③
 *   2050 → V2（生效日恰為 1/1，含當日）          AC-15 ①
 *   2051 → V3（2050 年中途之新版本，次年才生效）  AC-15 ②
 *   2060 → V3（V4 生效日為 01-02，不被選中）      AC-15 ②
 *   2061 → V4
 *   2070 → V5（推導失敗）                        AC-49(e)
 *   2081/2084/2087/2090/2093 → V6
 *   ≥2101 → V7
 */
const VERSIONS = [
  { key: "V1", effectiveFrom: "2040-06-15", vehiclePrice: "10.00", years: 3, km: 3 },
  { key: "V2", effectiveFrom: "2050-01-01", vehiclePrice: "600000.00", years: 5, km: 20000 },
  { key: "V3", effectiveFrom: "2050-07-01", vehiclePrice: "300000.00", years: 6, km: 30000 },
  { key: "V4", effectiveFrom: "2060-01-02", vehiclePrice: "1.00", years: 1, km: 10000 },
  { key: "V5", effectiveFrom: "2070-01-01", vehiclePrice: "0.00", years: 5, km: 20000 },
  { key: "V6", effectiveFrom: "2080-01-01", vehiclePrice: "600000.00", years: 5, km: 20000 },
  { key: "V7", effectiveFrom: "2100-01-01", vehiclePrice: "300000.00", years: 3, km: null },
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
const YEAR_NO_ANNUAL_TOTAL_KM = 2093;

// §20.4.3 kill case 專用年度（皆選中 V7，每年折舊費用 "100000.00"）。
const YEAR_PRIMARY_KILL = 2101;
const YEAR_SECONDARY_KILL = 2104;
const YEAR_HALF_UP_ROW1 = 2107;
const YEAR_HALF_UP_ROW2 = 2110;
const YEAR_RATIO_EXACTLY_100 = 2113;
const YEAR_OFFICIAL_KM_ZERO = 2116;
const YEAR_RATIO_EXCEEDS = 2119;
const YEAR_RAW_QUANTISATION = 2122;
const YEAR_SHRUNK_VERSION = 2125;

/** V6 之每年折舊費用（600000.00 ÷ 5）。 */
const V6_ANNUAL = "120000.00";
/** V7 之每年折舊費用（300000.00 ÷ 3）——§20.4.3 全部 kill case 之來源。 */
const V7_ANNUAL = "100000.00";

/**
 * 本檔多數金額斷言採用之年度總里程。搭配 V6 之 `120000.00` 恰使
 * `每年費用 ÷ 年度總里程 ＝ 6 元/公里`，與修訂前之 fixture 金額等值——語意
 * 已改（先乘後除、比例不參與），但金額基準保持可讀。
 */
const ANNUAL_TOTAL_KM_20000 = "20000.0";

type ComputedDto = {
  calculable: boolean;
  annualDepreciation: string | null;
  officialKm: string | null;
  officialApplicationCount: number | null;
  annualTotalKm: string | null;
  ratio: string | null;
  ratioPercent: string | null;
  rawAmount: string | null;
  amount: number | null;
  blockingCodes: string[];
};

type BlockerDto = { code: string; field?: string; message: string };

type ApplicationDto = {
  id: string;
  status: string;
  annualTotalKm: string | null;
  computed: ComputedDto | null;
  completionBlockers: BlockerDto[] | null;
  snapshot: Record<string, unknown> | null;
};

describeWithDb("PHASE-007-R6 — 折舊參數選版 ＋ 每年折舊費用 ＋ computed 完整接入", () => {
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

  /**
   * §20.6：預覽 body 新增 `annualTotalKm`（端點總表之唯一異動）。未顯式指定時
   * 一律帶入 `ANNUAL_TOTAL_KM_20000`——「不帶」是 AC-53(b) 之專屬情境，由該段
   * 之測試以 `annualTotalKm: null` 明示表達。
   */
  async function previewOk(cookie: string, payload: Record<string, unknown>): Promise<ComputedDto> {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/depreciation/preview",
      headers: { cookie },
      payload: { annualTotalKm: ANNUAL_TOTAL_KM_20000, ...payload },
    });
    expect(resp.statusCode).toBe(200);
    return resp.json<{ preview: ComputedDto }>().preview;
  }

  /** 建立折舊草稿（經真實端點），可選擇同時關聯 n 張證明附件。 */
  async function createDraft(
    applicationYear: number | null,
    opts: { annualTotalKm?: string | null; attachmentCount?: number } = {}
  ): Promise<ApplicationDto> {
    const annualTotalKm =
      opts.annualTotalKm === undefined ? ANNUAL_TOTAL_KM_20000 : opts.annualTotalKm;
    const created = await app.inject({
      method: "POST",
      url: "/applications/depreciation",
      headers: { cookie: ownerCookie },
      payload: { applicationYear, annualTotalKm },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json<{ application: ApplicationDto }>().application;
    track(draft.id);

    const attachmentCount = opts.attachmentCount ?? 0;
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

  function completeRequest(cookie: string, id: string) {
    return app.inject({
      method: "POST",
      url: `/applications/${id}/complete`,
      headers: { cookie },
    });
  }

  function blockerCodes(blockers: BlockerDto[] | null): string[] {
    return (blockers ?? []).map((b) => b.code);
  }

  // ===========================================================================
  // §1 AC-15 — 依申請年度 1/1 選版（`findEffectiveVersion`，含當日；語意不變）
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
      expect(preview.annualDepreciation).toBe(V6_ANNUAL);
    });

    it("② 年度中途（YYYY-07-01）之新版本不影響當年計算，次年才生效（BE-US-16 第 3 條）", async () => {
      const thisYear = await previewOk(ownerCookie, { applicationYear: YEAR_EXACT_JAN1 });
      const nextYear = await previewOk(ownerCookie, { applicationYear: YEAR_MID_YEAR_NEXT });
      // MUTANT：若選版誤以「年度內最後一版」為準，本年即得 "50000.00" 而必紅。
      expect(thisYear.annualDepreciation).toBe("120000.00");
      expect(nextYear.annualDepreciation).toBe("50000.00");
    });

    it("② 生效日為 YYYY-01-02 之版本不被選中（差一日之邊界）", async () => {
      const sameYear = await previewOk(ownerCookie, { applicationYear: YEAR_JAN2_EXCLUDED });
      const nextYear = await previewOk(ownerCookie, { applicationYear: YEAR_TINY_PRICE });
      expect(sameYear.annualDepreciation).toBe("50000.00");
      expect(nextYear.annualDepreciation).toBe("1.00");
    });

    it("③ 生效日為前一年之版本被選中（最近一版）", async () => {
      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_PREVIOUS_VERSION });
      expect(preview.annualDepreciation).toBe("3.33");
    });

    it("④ 全部版本皆晚於該年 1/1 → 查無有效版本（每年折舊費用 null）", async () => {
      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_NO_VERSION });
      // §20.11.2 R5 移交遷移：原斷言之 `perKmUnitPrice` 依 §20.6 改為
      // `annualDepreciation`（每公里單價已自 computed 移除）。
      expect(preview.annualDepreciation).toBeNull();
      expect(preview.rawAmount).toBeNull();
      expect(preview.amount).toBeNull();
      expect(preview.ratio).toBeNull();
      expect(preview.ratioPercent).toBeNull();
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
  // §2 AC-49(整合層) — 每年折舊費用一律取自 `deriveAnnualDepreciation`（2dp），
  //                     且申請路徑 **零呼叫** `deriveDepreciation`
  // ===========================================================================

  describe("AC-49: annualDepreciation comes verbatim from deriveAnnualDepreciation (2dp); deriveDepreciation is never called on the application path", () => {
    it("AC-49(c) 接線斷言：depreciation-parameters.ts import deriveAnnualDepreciation，且**不再** import deriveDepreciation、無任何私有推導算式", () => {
      const source = fs.readFileSync(PARAMETERS_SRC_PATH, "utf8");
      expect(source).toMatch(
        /import\s*\{[^}]*deriveAnnualDepreciation[^}]*\}\s*from\s*["']\.\.\/parameters\/depreciation-engine\.js["']/
      );
      // 負向：每公里單價引擎已退出申請路徑（import 層即不得殘留）。
      expect(source).not.toMatch(/import\s*\{[^}]*\bderiveDepreciation\b[^}]*\}\s*from/);
      // 私有複製反證：本檔不得出現 `車價 ÷ 年限` 之任何除法。
      expect(source).not.toMatch(/dividedBy|\bdiv\s*\(/);
      // 過渡碼反證（R1 即審 S-2）：`estimatedAnnualKm ?? 0` 之佔位值一律零殘留。
      expect(source).not.toMatch(/estimatedAnnualKm\s*\?\?/);
    });

    it("AC-49(c) 活體突變自證：一次預覽確實呼叫真實（被 spy 包裝之）deriveAnnualDepreciation，且引數恰為所選版本之車價與年限（無 estimatedAnnualKm）", async () => {
      const spy = vi.mocked(depreciationEngine.deriveAnnualDepreciation);
      spy.mockClear();

      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_PREVIOUS_VERSION });

      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0][0];
      expect(arg.vehiclePrice?.toString()).toBe("10");
      expect(arg.usefulLifeYears).toBe(3);
      expect(arg).not.toHaveProperty("estimatedAnnualKm");
      expect(preview.annualDepreciation).toBe("3.33");
    });

    it("AC-49(c) 負向 spy：預覽 → 草稿 DTO → 完成之全程，deriveDepreciation 呼叫次數恰為 0", async () => {
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_AMOUNT}-04-04`,
        snapshotTotalKm: "1000.00",
      });

      const negativeSpy = vi.mocked(depreciationEngine.deriveDepreciation);
      const positiveSpy = vi.mocked(depreciationEngine.deriveAnnualDepreciation);
      negativeSpy.mockClear();
      positiveSpy.mockClear();

      await previewOk(ownerCookie, { applicationYear: YEAR_AMOUNT });
      const draft = await createDraft(YEAR_AMOUNT);
      await getApplication(ownerCookie, draft.id);
      const completed = await completeRequest(ownerCookie, draft.id);
      expect(completed.statusCode).toBe(200);

      // 鑑別力自證：新引擎確實被走過（若兩者皆 0，本測試對「零呼叫」即無意義）。
      expect(positiveSpy.mock.calls.length).toBeGreaterThan(0);
      // AC-49(c) 逐字：完成與預覽全程 `deriveDepreciation` 呼叫次數 ＝ 0。
      expect(negativeSpy).toHaveBeenCalledTimes(0);
    });

    it('AC-49(a) kill case：vehiclePrice=10, usefulLifeYears=3 → "3.33"（2dp 逐字；4dp 之 "3.3333" 必紅）', async () => {
      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_PREVIOUS_VERSION });
      expect(preview.annualDepreciation).toBe("3.33");
      expect(preview.annualDepreciation).not.toBe("3.3333");
    });

    it("AC-51(b)：每年折舊費用於本 Phase 不得再次取整——50000.00 原樣呈現，1.00 亦保留 2dp 定寬", async () => {
      const mid = await previewOk(ownerCookie, { applicationYear: YEAR_MID_YEAR_NEXT });
      const tiny = await previewOk(ownerCookie, { applicationYear: YEAR_TINY_PRICE });
      expect(mid.annualDepreciation).toBe("50000.00");
      expect(tiny.annualDepreciation).toBe("1.00");
      expect(tiny.annualDepreciation).not.toBe("1");
    });
  });

  // ===========================================================================
  // §3 AC-16(整合層) — 缺參數於「預覽」「草稿」「完成」三處一致（反模式封閉）
  // ===========================================================================

  describe("AC-16(b): a year with no effective version is blocked identically in preview, in the draft DTO, and at completion", () => {
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
      // §20.5 FW-1：缺每年費用之路徑絕不觸發比例／容量判定 → 比例欄一律 null。
      expect(preview.ratio).toBeNull();
      expect(preview.ratioPercent).toBeNull();
    });

    it("草稿 DTO：completionBlockers 含 PARAMETER_NOT_AVAILABLE，且 computed.calculable=false（不得「預覽說可以、完成才擋」）", async () => {
      const draft = await createDraft(YEAR_NO_VERSION, { attachmentCount: 1 });
      expect(blockerCodes(draft.completionBlockers)).toEqual(["PARAMETER_NOT_AVAILABLE"]);
      expect(draft.computed).not.toBeNull();
      expect(draft.computed?.calculable).toBe(false);
      expect(draft.computed?.blockingCodes).toEqual(["PARAMETER_NOT_AVAILABLE"]);
      expect(draft.computed?.annualDepreciation).toBeNull();
    });

    it("完成端點（第三處）：缺參數 → 409 PARAMETER_NOT_AVAILABLE ＋ details.missing=['DEPRECIATION']，且零寫入", async () => {
      const draft = await createDraft(YEAR_NO_VERSION);
      const resp = await completeRequest(ownerCookie, draft.id);
      expect(resp.statusCode).toBe(409);
      const body = resp.json<{
        error: { code: string; details?: { missing?: string[]; applicationYear?: number } };
      }>();
      expect(body.error.code).toBe("PARAMETER_NOT_AVAILABLE");
      expect(body.error.details?.missing).toEqual(["DEPRECIATION"]);
      expect(body.error.details?.applicationYear).toBe(YEAR_NO_VERSION);

      const row = await prisma.application.findUniqueOrThrow({
        where: { id: draft.id },
        select: { status: true, totalAmount: true },
      });
      expect(row.status).toBe("DRAFT");
      expect(row.totalAmount).toBeNull();
    });

    it("AC-49(c) 之互補：參數齊備之草稿 computed.calculable=true，且不因 completionBlockers 空與否而反推", async () => {
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_NO_ANNUAL_TOTAL_KM}-03-03`,
        snapshotTotalKm: "200.00",
      });

      const draft = await createDraft(YEAR_NO_ANNUAL_TOTAL_KM);
      expect(blockerCodes(draft.completionBlockers)).toEqual([]);
      expect(draft.computed?.calculable).toBe(true);
      expect(draft.computed?.blockingCodes).toEqual([]);
      expect(draft.computed?.annualDepreciation).toBe(V6_ANNUAL);
      // 120000.00 × 200.00 ÷ 20000.0 ＝ 1200
      expect(draft.computed?.amount).toBe(1200);
    });

    it("年度為 null 之草稿：computed 只回 [YEAR_REQUIRED]（尚未查詢里程與參數）", async () => {
      const draft = await createDraft(null, { attachmentCount: 1 });
      expect(draft.computed?.blockingCodes).toEqual(["YEAR_REQUIRED"]);
      expect(draft.computed?.officialKm).toBeNull();
      expect(draft.computed?.annualDepreciation).toBeNull();
      // §20.6：申請資料原樣回傳（年度缺漏不抹除已申報之總里程）。
      expect(draft.computed?.annualTotalKm).toBe("20000.0");
      expect(blockerCodes(draft.completionBlockers)).toEqual(["YEAR_REQUIRED"]);
    });
  });

  // ===========================================================================
  // §4 AC-18／AC-49(e)(整合層) — 推導失敗視同缺參數；縮欄新版本**不得**誤判
  // ===========================================================================

  describe("AC-49(e): deriveAnnualDepreciation returning ok:false is treated as a missing parameter — never 500, never a zero annual expense", () => {
    it("推導失敗之年度（車價 0）：預覽 200（絕不 500）、calculable=false、每年費用 null、blockingCodes=[PARAMETER_NOT_AVAILABLE]", async () => {
      const spy = vi.mocked(depreciationEngine.deriveAnnualDepreciation);
      spy.mockClear();

      const preview = await previewOk(ownerCookie, {
        applicationYear: YEAR_DERIVATION_FAILED,
      });

      expect(preview.calculable).toBe(false);
      expect(preview.annualDepreciation).toBeNull();
      expect(preview.amount).toBeNull();
      expect(preview.blockingCodes).toEqual(["PARAMETER_NOT_AVAILABLE"]);

      // 鑑別力自證：確實走到推導（版本有被選中）且推導確實回 ok:false，
      // 而非「查無版本」之另一條路徑。
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.results[0].value).toEqual({ ok: false });
      // 「絕不以每年費用 0 完成」：0 元之靜默放行必使上一段斷言轉紅。
      expect(preview.annualDepreciation).not.toBe("0.00");
    });

    it("service 層保留「查無版本」與「推導失敗」兩來源之區辨資訊（完成端點 409 details.missing 之來源）", async () => {
      const noVersion = await resolveDepreciationParameters(prisma, YEAR_NO_VERSION);
      const derivationFailed = await resolveDepreciationParameters(prisma, YEAR_DERIVATION_FAILED);

      expect(noVersion.annualDepreciation).toBeNull();
      expect(noVersion.version).toBeNull();
      expect(noVersion.derivationFailed).toBe(false);
      expect(noVersion.missing).toEqual(["DEPRECIATION"]);

      expect(derivationFailed.annualDepreciation).toBeNull();
      expect(derivationFailed.version).not.toBeNull();
      expect(derivationFailed.derivationFailed).toBe(true);
      expect(derivationFailed.missing).toEqual(["DEPRECIATION_DERIVATION_FAILED"]);

      // 兩來源必須可區分（若實作把兩者折成同一形狀，本斷言必紅）。
      expect(derivationFailed.missing).not.toEqual(noVersion.missing);
    });

    it("完成端點：推導失敗 → 409 ＋ details.missing=['DEPRECIATION_DERIVATION_FAILED']（與缺版本之訊息逐字互異）", async () => {
      const draft = await createDraft(YEAR_DERIVATION_FAILED);
      const resp = await completeRequest(ownerCookie, draft.id);
      expect(resp.statusCode).toBe(409);
      const body = resp.json<{
        error: { code: string; message: string; details?: { missing?: string[] } };
      }>();
      expect(body.error.code).toBe("PARAMETER_NOT_AVAILABLE");
      expect(body.error.details?.missing).toEqual(["DEPRECIATION_DERIVATION_FAILED"]);

      const noVersionDraft = await createDraft(YEAR_NO_VERSION);
      const noVersionResp = await completeRequest(ownerCookie, noVersionDraft.id);
      expect(noVersionResp.statusCode).toBe(409);
      const noVersionBody = noVersionResp.json<{ error: { message: string } }>();
      expect(body.error.message).not.toBe(noVersionBody.error.message);
    });

    /**
     * **R1 即審 S-2 ＋ R6a 移交之回歸釘死**：`estimatedAnnualKm` 為 `NULL` 之
     * 縮欄新版本（AC-57）**不得**再被判為 `DEPRECIATION_DERIVATION_FAILED`。
     *
     * MUTANT：把 `deriveAnnualDepreciation` 換回
     * `deriveDepreciation({ …, estimatedAnnualKm: version.estimatedAnnualKm ?? 0 })`
     * （即修復前之過渡碼），本測試三條斷言全紅——縮欄版本會全數劣化為缺參數。
     */
    it("R1 即審 S-2：estimatedAnnualKm 為 NULL 之縮欄新版本仍可正常推導每年折舊費用（絕不誤判為 DERIVATION_FAILED）", async () => {
      const resolved = await resolveDepreciationParameters(prisma, YEAR_SHRUNK_VERSION);
      expect(resolved.version?.estimatedAnnualKm).toBeNull();
      expect(resolved.derivationFailed).toBe(false);
      expect(resolved.missing).toEqual([]);
      expect(resolved.annualDepreciation?.toFixed(2)).toBe(V7_ANNUAL);

      await createCompletedTravel({
        ownerId,
        date: `${YEAR_SHRUNK_VERSION}-06-06`,
        snapshotTotalKm: "1000.00",
      });
      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_SHRUNK_VERSION });
      expect(preview.calculable).toBe(true);
      expect(preview.blockingCodes).toEqual([]);
      expect(preview.annualDepreciation).toBe(V7_ANNUAL);
      // 100000.00 × 1000.00 ÷ 20000.0 ＝ 5000
      expect(preview.amount).toBe(5000);
    });

    /**
     * T7 即審 SF-1（reviewer PROBE-7 實測之潛伏缺陷）：`missing` 陣列**絕不可**
     * 跨呼叫共用同一參考（呼叫端對回傳值 `push` 是 §20.4.1 ② 之預期用法）。
     */
    it("T7 即審 SF-1：每次呼叫回傳全新的 missing 陣列——變異其一不得污染既有結果或後續呼叫", async () => {
      const first = await resolveDepreciationParameters(prisma, YEAR_NO_VERSION);
      const second = await resolveDepreciationParameters(prisma, YEAR_NO_VERSION);

      expect(second.missing).toEqual(first.missing);
      expect(second.missing).not.toBe(first.missing);
      expect(second).not.toBe(first);

      first.missing.push("DEPRECIATION_DERIVATION_FAILED");

      expect(second.missing).toEqual(["DEPRECIATION"]);
      const third = await resolveDepreciationParameters(prisma, YEAR_NO_VERSION);
      expect(third.missing).toEqual(["DEPRECIATION"]);
      const nullYear = await resolveDepreciationParameters(prisma, null);
      expect(nullYear.missing).toEqual(["DEPRECIATION"]);
      const failed = await resolveDepreciationParameters(prisma, YEAR_DERIVATION_FAILED);
      expect(failed.missing).toEqual(["DEPRECIATION_DERIVATION_FAILED"]);
    });
  });

  // ===========================================================================
  // §5 AC-51(整合層) — §20.4.3 之 kill case 於真實端點成立
  // ===========================================================================

  describe("AC-51: the §20.4.3 kill cases hold end-to-end (rounding happens exactly once, at the final amount)", () => {
    it("PRIMARY kill case：100000.00 ／ 1001.66 ／ 12345.6 → rawAmount 8113.4979…、amount 8113（四種取整層級 mutant 各得 8114／8110／8114／8116 而必紅）", async () => {
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_PRIMARY_KILL}-04-04`,
        snapshotTotalKm: "1001.66",
      });

      const preview = await previewOk(ownerCookie, {
        applicationYear: YEAR_PRIMARY_KILL,
        annualTotalKm: "12345.6",
      });

      expect(preview.annualDepreciation).toBe(V7_ANNUAL);
      expect(preview.officialKm).toBe("1001.66");
      expect(preview.annualTotalKm).toBe("12345.6");
      expect(preview.ratio).toBe("0.081135");
      expect(preview.ratioPercent).toBe("8.1135");
      expect(preview.rawAmount).toBe("8113.4979");
      expect(preview.amount).toBe(8113);
      // 四種 mutant 之期望值（§20.4.3 表）逐一反證。
      expect(preview.amount).not.toBe(8114); // A：先取整比例至 6dp／C：先取整 rawAmount 至 2dp
      expect(preview.amount).not.toBe(8110); // B：先取整比例至 4dp
      expect(preview.amount).not.toBe(8116); // D：先取整 officialKm 至整數
      expect(preview.calculable).toBe(true);
      expect(preview.blockingCodes).toEqual([]);
    });

    it("SECONDARY kill case（比例先取整之獨立鑑別）：100000.00 ／ 4000.09 ／ 20000.0 → rawAmount 20000.4500、amount 20000（比例 6dp mutant 得 20001）", async () => {
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_SECONDARY_KILL}-05-05`,
        snapshotTotalKm: "4000.09",
      });

      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_SECONDARY_KILL });
      expect(preview.rawAmount).toBe("20000.4500");
      expect(preview.amount).toBe(20000);
      expect(preview.amount).not.toBe(20001);
    });

    it("ROUND_HALF_UP kill pair row 1（鑑別）：100000.00 ／ 4000.10 ／ 20000.0 → rawAmount 20000.5、amount 20001（ROUND_HALF_EVEN mutant 得 20000）", async () => {
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_HALF_UP_ROW1}-05-05`,
        snapshotTotalKm: "4000.10",
      });

      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_HALF_UP_ROW1 });
      expect(preview.rawAmount).toBe("20000.5000");
      expect(preview.amount).toBe(20001);
      expect(preview.amount).not.toBe(20000);
    });

    it("ROUND_HALF_UP kill pair row 2（配對，證 away-from-zero）：100000.00 ／ 4000.30 ／ 20000.0 → rawAmount 20001.5、amount 20002", async () => {
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_HALF_UP_ROW2}-05-05`,
        snapshotTotalKm: "4000.30",
      });

      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_HALF_UP_ROW2 });
      expect(preview.rawAmount).toBe("20001.5000");
      expect(preview.amount).toBe(20002);
    });

    /**
     * 取整層級之第二道鑑別（沿本檔 T2 即審 FW-4 之既有 kill case 形式，
     * 依修訂後公式重新取數對）：`rawAmount` 之 DTO 呈現量化為 4dp 後恰跨越
     * `.5`，而 `amount` 一律取自**未量化**之 `rawAmount`。
     *
     *   100000.00 × 2000.11 ÷ 20000.1 ＝ 10000.49997500125…
     *   → DTO `rawAmount` 顯示 "10000.5000"（4dp ROUND_HALF_UP）
     *   → `amount` ＝ ROUND_HALF_UP(10000.49997500125, 0) ＝ **10000**
     *   MUTANT：以量化後之 4dp 值回餵取整必得 10001 而紅。
     */
    it("kill case（4dp 呈現量化不得回餵）：100000.00 ／ 2000.11 ／ 20000.1 → rawAmount 顯示 10000.5000 而 amount 仍為 10000", async () => {
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_RAW_QUANTISATION}-08-08`,
        snapshotTotalKm: "2000.11",
      });

      const preview = await previewOk(ownerCookie, {
        applicationYear: YEAR_RAW_QUANTISATION,
        annualTotalKm: "20000.1",
      });
      expect(preview.officialKm).toBe("2000.11");
      expect(preview.rawAmount).toBe("10000.5000");
      expect(preview.amount).toBe(10000);
      expect(preview.amount).not.toBe(10001);
      expect(preview.calculable).toBe(true);
    });

    it("邊界正例（§20.4.3）：年度公務里程為 0 → ratio 0.000000、rawAmount 0.0000、amount 0（仍可計算）", async () => {
      const preview = await previewOk(ownerCookie, {
        applicationYear: YEAR_OFFICIAL_KM_ZERO,
        annualTotalKm: "12345.6",
      });
      expect(preview.officialKm).toBe("0.00");
      expect(preview.ratio).toBe("0.000000");
      expect(preview.ratioPercent).toBe("0.0000");
      expect(preview.rawAmount).toBe("0.0000");
      expect(preview.amount).toBe(0);
      expect(preview.calculable).toBe(true);
      expect(preview.blockingCodes).toEqual([]);
    });

    it("AC-13 等價斷言：有效參數下 officialKm 相同而 applicationCount 相異 → 全部金額面欄位逐欄全等（且為真實非 null 值）", async () => {
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

      expect(a.officialKm).toBe("100.00");
      expect(b.officialKm).toBe("100.00");
      expect(a.officialApplicationCount).toBe(1);
      expect(b.officialApplicationCount).toBe(3);
      expect(a.amount).toBe(600);
      expect(a.rawAmount).toBe("600.0000");

      expect(b.annualDepreciation).toEqual(a.annualDepreciation);
      expect(b.ratio).toEqual(a.ratio);
      expect(b.rawAmount).toEqual(a.rawAmount);
      expect(b.amount).toEqual(a.amount);
      expect(b.calculable).toEqual(a.calculable);
      expect({ ...b, officialApplicationCount: a.officialApplicationCount }).toEqual(a);
    });
  });

  // ===========================================================================
  // §6 AC-52(整合層) — 比例 >100% 之守門「三處一致」與邊界
  // ===========================================================================

  describe("AC-52: officialKm > annualTotalKm is blocked identically in the draft DTO, the preview, and at completion", () => {
    it("AC-52(c) 結構性守門：depreciation-service.ts 由 depreciation-blockers.js import isOfficialKmExceedsAnnualTotalKm，且不就地重寫任何 greaterThan／lessThan 比較", () => {
      const source = fs.readFileSync(SERVICE_SRC_PATH, "utf8");
      expect(source).toMatch(
        /import\s*\{[^}]*isOfficialKmExceedsAnnualTotalKm[^}]*\}\s*from\s*["']\.\/depreciation-blockers\.js["']/
      );
      // 就地重寫之反證（AC-52(c) 逐字「service 層不得就地重寫」）：本檔不得
      // 出現任何 `Decimal` 之大小比較呼叫——比例守門一律走上方匯入之 predicate。
      expect(source).not.toMatch(
        /\.(greaterThan|greaterThanOrEqualTo|lessThan|lessThanOrEqualTo|gt|gte|lt|lte)\s*\(/
      );
    });

    it("AC-52(d) 三處一致：同一 fixture 於草稿 DTO／預覽／完成端點同步暴露 OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM 且 calculable=false", async () => {
      // 12345.61 > 12345.6（恰大 0.01）。
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_RATIO_EXCEEDS}-07-07`,
        snapshotTotalKm: "12345.61",
      });

      // ① 預覽
      const preview = await previewOk(ownerCookie, {
        applicationYear: YEAR_RATIO_EXCEEDS,
        annualTotalKm: "12345.6",
      });
      expect(preview.calculable).toBe(false);
      expect(preview.blockingCodes).toEqual(["OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM"]);
      expect(preview.amount).toBeNull();
      expect(preview.rawAmount).toBeNull();

      // ② 草稿 DTO（completionBlockers ＋ computed 同步）
      const draft = await createDraft(YEAR_RATIO_EXCEEDS, { annualTotalKm: "12345.6" });
      expect(blockerCodes(draft.completionBlockers)).toEqual([
        "OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM",
      ]);
      expect(draft.completionBlockers?.[0].field).toBe("annualTotalKm");
      expect(draft.computed?.calculable).toBe(false);
      expect(draft.computed?.blockingCodes).toEqual(["OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM"]);

      // ③ 完成端點 → 400 VALIDATION_ERROR ＋ fields[] ＋ details.blockers[]
      const resp = await completeRequest(ownerCookie, draft.id);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{
        error: {
          code: string;
          fields?: Array<{ field: string }>;
          details?: { blockers?: BlockerDto[] };
        };
      }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.fields?.map((f) => f.field)).toContain("annualTotalKm");
      expect(body.error.details?.blockers?.map((b) => b.code)).toEqual([
        "OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM",
      ]);

      // 寫入前拒絕：狀態與金額欄零變更。
      const row = await prisma.application.findUniqueOrThrow({
        where: { id: draft.id },
        select: { status: true, totalAmount: true },
      });
      expect(row.status).toBe("DRAFT");
      expect(row.totalAmount).toBeNull();
    });

    it("AC-52(b) 邊界：officialKm == annualTotalKm（比例恰 100%）→ 允許完成，ratio 1.000000／ratioPercent 100.0000", async () => {
      await createCompletedTravel({
        ownerId,
        date: `${YEAR_RATIO_EXACTLY_100}-07-07`,
        snapshotTotalKm: "12345.60",
      });

      const preview = await previewOk(ownerCookie, {
        applicationYear: YEAR_RATIO_EXACTLY_100,
        annualTotalKm: "12345.6",
      });
      // MUTANT：把 `>` 改為 `>=` → 此處必得 blocker 而紅。
      expect(preview.blockingCodes).toEqual([]);
      expect(preview.calculable).toBe(true);
      expect(preview.ratio).toBe("1.000000");
      expect(preview.ratioPercent).toBe("100.0000");
      expect(preview.rawAmount).toBe("100000.0000");
      expect(preview.amount).toBe(100000);

      const draft = await createDraft(YEAR_RATIO_EXACTLY_100, { annualTotalKm: "12345.6" });
      expect(blockerCodes(draft.completionBlockers)).toEqual([]);
      const resp = await completeRequest(ownerCookie, draft.id);
      expect(resp.statusCode).toBe(200);
    });
  });

  // ===========================================================================
  // §7 AC-53(整合層) — 未輸入年度總里程
  // ===========================================================================

  describe("AC-53: a draft without annualTotalKm saves fine, previews as not-calculable, and is blocked at completion with zero writes", () => {
    it("AC-53(a)(b)：草稿寬容（201）＋ computed.calculable=false ＋ [ANNUAL_TOTAL_KM_REQUIRED]，且 amount／rawAmount／ratio 皆 null", async () => {
      const draft = await createDraft(YEAR_AMOUNT, { annualTotalKm: null });
      expect(draft.annualTotalKm).toBeNull();
      expect(draft.computed?.calculable).toBe(false);
      expect(draft.computed?.blockingCodes).toEqual(["ANNUAL_TOTAL_KM_REQUIRED"]);
      expect(draft.computed?.amount).toBeNull();
      expect(draft.computed?.rawAmount).toBeNull();
      expect(draft.computed?.ratio).toBeNull();
      expect(draft.computed?.ratioPercent).toBeNull();
      expect(blockerCodes(draft.completionBlockers)).toEqual(["ANNUAL_TOTAL_KM_REQUIRED"]);
    });

    it("AC-53(b)：預覽 body 未帶 annualTotalKm → 同樣 [ANNUAL_TOTAL_KM_REQUIRED]，且不查詢年度里程（§20.8.1 逐字）", async () => {
      const spy = vi.mocked(mileageEngine.sumOfficialMileage);
      spy.mockClear();

      const resp = await app.inject({
        method: "POST",
        url: "/applications/depreciation/preview",
        headers: { cookie: ownerCookie },
        payload: { applicationYear: YEAR_AMOUNT },
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: ComputedDto }>().preview;
      expect(preview.calculable).toBe(false);
      expect(preview.blockingCodes).toEqual(["ANNUAL_TOTAL_KM_REQUIRED"]);
      expect(preview.officialKm).toBeNull();
      expect(preview.annualTotalKm).toBeNull();
      expect(spy).toHaveBeenCalledTimes(0);
    });

    it("AC-53(c)：完成端點 → 400 VALIDATION_ERROR ＋ fields[annualTotalKm] ＋ details.blockers[]，且零寫入（status 仍 DRAFT、全部快照欄仍 null）", async () => {
      const draft = await createDraft(YEAR_AMOUNT, { annualTotalKm: null });
      const resp = await completeRequest(ownerCookie, draft.id);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{
        error: {
          code: string;
          fields?: Array<{ field: string }>;
          details?: { blockers?: BlockerDto[] };
        };
      }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.fields?.map((f) => f.field)).toEqual(["annualTotalKm"]);
      expect(body.error.details?.blockers?.map((b) => b.code)).toEqual([
        "ANNUAL_TOTAL_KM_REQUIRED",
      ]);

      const application = await prisma.application.findUniqueOrThrow({
        where: { id: draft.id },
        select: { status: true, totalAmount: true, completedAt: true },
      });
      expect(application.status).toBe("DRAFT");
      expect(application.totalAmount).toBeNull();
      expect(application.completedAt).toBeNull();

      const child = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: draft.id },
      });
      expect(child.snapshotVehiclePrice).toBeNull();
      expect(child.snapshotUsefulLifeYears).toBeNull();
      expect(child.snapshotAnnualDepreciation).toBeNull();
      expect(child.snapshotOfficialKm).toBeNull();
      expect(child.snapshotAnnualTotalKm).toBeNull();
      expect(child.snapshotRatio).toBeNull();
      expect(child.snapshotRawAmount).toBeNull();
      expect(child.calculatedAt).toBeNull();
      expect(child.depreciationParameterVersionId).toBeNull();
    });
  });

  // ===========================================================================
  // §8 §9.2／§20.8.1 — 預覽零寫入不變式
  // ===========================================================================

  describe("§20.8.1: the preview path never writes", () => {
    it("預覽（可計算之完整路徑）前後 Application／DepreciationApplication 資料列總數皆不變", async () => {
      const applicationsBefore = await prisma.application.count();
      const depreciationBefore = await prisma.depreciationApplication.count();

      await previewOk(ownerCookie, { applicationYear: YEAR_AMOUNT });
      await previewOk(ownerCookie, {
        applicationYear: YEAR_PRIMARY_KILL,
        annualTotalKm: "12345.6",
      });

      expect(await prisma.application.count()).toBe(applicationsBefore);
      expect(await prisma.depreciationApplication.count()).toBe(depreciationBefore);
    });
  });

  // ===========================================================================
  // §9 §20.6 揭露面 — computed 十鍵；推導三值與版本 id 不外露
  // ===========================================================================

  describe("§20.6 disclosure: no depreciation DTO ever exposes vehiclePrice / usefulLifeYears / estimatedAnnualKm / version id", () => {
    it("預覽 DTO 之鍵集恰為 §20.6 之十鍵（perKmUnitPrice 已移除），且不含推導三值與版本 id", async () => {
      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_EXACT_JAN1 });
      expect(Object.keys(preview).sort()).toEqual(
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
      for (const forbidden of [
        "vehiclePrice",
        "usefulLifeYears",
        "estimatedAnnualKm",
        "depreciationParameterVersionId",
        "versionId",
        "perKmUnitPrice",
      ]) {
        expect(preview as Record<string, unknown>).not.toHaveProperty(forbidden);
      }
    });

    it("草稿 DTO 之 wire 位元組不得出現推導三值之欄位名，且 computed 之序列化不含所選版本之車價（300000）", async () => {
      const draft = await createDraft(YEAR_PRIMARY_KILL, {
        annualTotalKm: "12345.6",
        attachmentCount: 1,
      });
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
      expect(resp.body).not.toContain("perKmUnitPrice");

      // 值：僅掃描 `computed` 之序列化（cuid 與 ISO 時戳含隨機／時間相依之數字
      // 串，對整份 body 的數值子字串掃描是不決定性的斷言）。
      const computedJson = JSON.stringify(
        resp.json<{ application: ApplicationDto }>().application.computed
      );
      expect(computedJson).not.toContain("300000");
      expect(computedJson).toContain(V7_ANNUAL);
    });
  });

  // ===========================================================================
  // §10 T6 即審 FW-5 — DTO 接入後之查詢面（DRAFT +1／COMPLETED +0）與單一組裝點
  // ===========================================================================

  describe("FW-5: the DTO builder is the single assembly point; DRAFT costs exactly one aggregate + one derivation, COMPLETED costs zero", () => {
    it("GET DRAFT → sumOfficialMileage +1 且 deriveAnnualDepreciation +1；GET COMPLETED → 兩者皆 +0 且 computed 為 null", async () => {
      const draft = await createDraft(YEAR_AMOUNT);

      const mileageSpy = vi.mocked(mileageEngine.sumOfficialMileage);
      const deriveSpy = vi.mocked(depreciationEngine.deriveAnnualDepreciation);

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
      // POST／GET／PUT／complete／void 五處呼叫（`await buildDepreciationApplicationDto(...)`）
      // ——`void` 一處為 PHASE-009-T4 新增之作廢端點折舊分支（機械連動：僅更
      // 新計數基線，鑑別性零弱化——五處仍全部經同一單一組裝點）。
      const builderCalls = source.match(/await buildDepreciationApplicationDto\(/g) ?? [];
      expect(builderCalls.length).toBe(5);
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
  // §11 AC-14 — 代操作草稿之 computed 以擁有人計算
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

      const application = await prisma.application.create({
        data: {
          type: "DEPRECIATION",
          status: "DRAFT",
          ownerId,
          createdById: adminId,
          primaryDate: new Date(Date.UTC(YEAR_ON_BEHALF, 11, 31)),
          depreciation: {
            create: { applicationYear: YEAR_ON_BEHALF, annualTotalKm: ANNUAL_TOTAL_KM_20000 },
          },
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
      // 金額面亦以擁有人里程為準：120000.00 × 88.00 ÷ 20000.0 ＝ 528。
      expect(asAdmin.computed?.amount).toBe(528);

      const asOwner = await getApplication(ownerCookie, application.id);
      expect(asOwner.computed).toEqual(asAdmin.computed);
    });
  });
});
