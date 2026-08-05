/**
 * Integration tests for PHASE-007-T6:
 *   年度公務里程接線（`sumOfficialMileage` 引擎複用）＋ 折舊預覽端點之授權面。
 *
 * Spec `docs/specs/PHASE-007.md` §2 AC-09／AC-10／AC-11／AC-12（本 Task 範圍；
 * **AC-13／AC-14 之正式實名斷言依 Spec Gate 裁定切出為 T6b**，本檔只覆蓋 T6
 * Done When 明列之「`ownerId` 恆為擁有人之對照組」與「預覽零寫入實證」）、
 * §7.1（`POST /applications/depreciation/preview` → `{ preview:
 * DepreciationComputedDto }`）、§7.3（引擎逐字呼叫形狀）、§9.2（補貼預覽之
 * 唯讀路徑與零寫入不變式）、§16 D13(a)（stateless preview）。
 *
 * TDD: written BEFORE `depreciation-service.ts` 之引擎接線
 * （`computeDepreciationComputed`）與 `routes.ts` 之
 * `/applications/depreciation/preview` 端點存在；第一輪預期為紅（未知路由
 * 404、spy 零呼叫）。見 Task Handoff 之 RED 輸出。
 *
 * AC-09「突變自證」技法（沿 PHASE-005a-T8 `phase5a-travel-complete.test.ts`
 * 與 PHASE-006-T5 `phase6-official-mileage.test.ts` 之既有慣例）：以 `vi.mock`
 * 包裝 `mileage-engine.js` 之**真實實作**為 `vi.fn`（行為不變，只加可觀測
 * 性）。若 `depreciation-service.ts` 改為「移除 import、自行複製一份私有加總
 * 邏輯」，本檔對 spy 呼叫次數／參數之斷言會觀察到 0 次呼叫而必然轉紅——這即是
 * 「刪除 import 改為私有複製必紅」的具體實現。
 *
 * ── PHASE-007-T6b（本檔第二批，追加於 T6 之 18 條之後） ────────────────
 *   Gate 裁定將 AC-13／AC-14 自 T6 切出為獨立 Task（Spec §15 T6/T9 之 AC 數
 *   說明，處置 (i)）。本批為**純測試 Task，零 src 變更**：所釘住的全部是
 *   `sumOfficialMileage` 之**既有**行為（D2(a) `count`／`SUM` 不對稱）與 T6
 *   已落地之 `resolveOwnerId` 授權面，非新行為。
 *
 *   「紅燈」以突變自證替代（Packet 明示）：見各 `it` 上方之 MUTANT 註記，
 *   每條均列出「把斷言改成相反語意即紅」之具體形式，Handoff 附實跑輸出。
 *
 *   已知限制之清償（T6R S-1 登記 → **PHASE-007-T7 已處置**）：AC-13「金額只
 *   用 `totalKm`」原以不變式形式釘住，但因本檔零播種參數版本，該比較實際上
 *   是 `null` 對 `null`。T7 已於本檔 `beforeAll` 播種一筆
 *   `effectiveFrom = 2000-01-01` 之折舊參數版本（早於本檔全部查詢年度之
 *   1/1），使該不變式改以**真實金額**比較；並新增互補之正向鑑別（同筆數、
 *   異里程 ⇒ 金額必異）。
 *   AC-14 之「草稿 DTO 側 `computed`」斷言由 T7 之
 *   `phase7-depreciation-parameters.test.ts` 補齊（該檔具備參數與里程 fixture）。
 *
 * Test discipline (Spec §11.0 / Packet):
 *   - loginName prefix "p7t6_" + per-run random suffix；synthetic data only.
 *   - cleanup scoped to this suite's own tracked application ids + loginName
 *     prefix；NEVER deleteMany({}) globally.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { computeDepreciationComputed } from "../../src/applications/depreciation-service.js";
import { hashPassword } from "../../src/auth/password.js";
import * as mileageEngine from "../../src/mileage/mileage-engine.js";
import { buildServer } from "../../src/server.js";

// AC-09 突變自證：包裝真實實作為 spy，行為不變，只加可觀測性（見檔頭說明）。
vi.mock("../../src/mileage/mileage-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mileage/mileage-engine.js")>();
  return {
    ...actual,
    sumOfficialMileage: vi.fn(actual.sumOfficialMileage),
  };
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const DEPRECIATION_SERVICE_SRC_PATH = path.resolve(
  BACKEND_ROOT,
  "src/applications/depreciation-service.ts"
);

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
const LOGIN_PREFIX = "p7t6_";
const PASSWORD = "AnnualMileageTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;

/**
 * 各測試專用年度（同一 suite 內互不干擾；跨 suite 天然以 ownerId 隔離）。
 *
 * 刻意彼此相隔 ≥3 年：AC-10 之四點邊界會於「前一年」與「次年」各種下一筆
 * 誘餌列，若年度相鄰，該誘餌會落入另一測試的統計區間而互相污染。
 */
const YEAR_WIRING = 2060;
const YEAR_BOUNDARY = 2071;
const YEAR_ATTRIBUTION = 2082;
const YEAR_ELIGIBILITY = 2093;
const YEAR_CONTRAST = 2054;
const YEAR_PREVIEW_MISC = 2045;

// T6b（AC-13／AC-14）專用年度；同樣彼此相隔 ≥3 年，且與上方 T6 年度相隔 ≥3。
const YEAR_NULL_SNAPSHOT = 2036;
const YEAR_NULL_ONLY = 2033;
const YEAR_COUNT_NEUTRAL_B = 2030;
const YEAR_COUNT_NEUTRAL_A = 2027;
const YEAR_AC14_CONTRAST = 2021;
const YEAR_ON_BEHALF = 2018;
const YEAR_AC14_MISC = 2015;

/**
 * PHASE-007-T7（T6 即審 FW-3）：本檔播種**一筆**折舊參數版本，生效日早於本檔
 * 全部查詢年度之 1/1（最早為 2015），使 AC-13 之金額面斷言由「`null` 對
 * `null`」升級為**真實金額**之正向鑑別（T6R S-1 登記之鑑別力邊界即由此清償）。
 *
 * 單一版本 ⇒ 本檔任一年度所選中的版本恆為同一版、單價恆為 `6.0000`，故所有
 * 既有斷言（年度區間、歸屬、資格、`ownerId` 解析）之語意完全不受影響——本次
 * 播種只讓金額面**從恆 `null` 變成可比較的真實值**。
 */
const PARAM_EFFECTIVE_FROM = "2000-01-01";
const PARAM_ANNUAL_DEPRECIATION = "120000.00"; // 600000 ÷ 5（§20.3 AC-49(a)）
/** FW-3 正向鑑別專用年度（與上方各年度相隔 ≥3）。 */
const YEAR_AMOUNT_A = 2012;
const YEAR_AMOUNT_B = 2009;

/**
 * PHASE-007-R6（§20.11.2 之 R6 列逐字：「**僅播種與 computed 形狀之機械連動**
 * （AC-09~14 語意不變）」）：`DepreciationComputedDto` 依 §20.6 由七鍵改為十鍵
 * ——移除 `perKmUnitPrice`，新增 `annualDepreciation`／`annualTotalKm`／
 * `ratio`／`ratioPercent`。本檔之年度區間、歸屬、資格、`ownerId` 解析等語意
 * **零變更**。
 */
type PreviewDto = {
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

/**
 * 本檔全部預覽之年度總里程（§20.6：預覽 body 新增 `annualTotalKm`）。
 *
 * 取 `20000.0` 使 `每年折舊費用 ÷ 年度總里程 ＝ 120000.00 ÷ 20000.0 ＝ 6`
 * 元/公里——修訂前後之金額基準逐值相同，故本檔既有金額斷言（600／1500 …）
 * **零改動**即成立，機械連動的範圍被壓到最小。本檔各年度之 `officialKm` 皆
 * 遠小於此值，比例守門（AC-52）不會被觸發。
 */
const ANNUAL_TOTAL_KM = "20000.0";

describeWithDb("PHASE-007-T6 — 年度公務里程接線（引擎複用）＋ 預覽授權", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let otherId: string;
  let adminId: string;

  let ownerCookie: string;
  let otherCookie: string;
  let adminCookie: string;

  const createdApplicationIds: string[] = [];
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
        displayName: "P7T6 擁有人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const other = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "P7T6 他人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "P7T6 管理員",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });

    ownerId = owner.id;
    otherId = other.id;
    adminId = admin.id;

    // FW-3（見上方常數說明）：單一折舊參數版本，生效日早於本檔全部查詢年度。
    await prisma.depreciationParameterVersion.create({
      data: {
        vehiclePrice: "600000.00",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: new Date(`${PARAM_EFFECTIVE_FROM}T00:00:00.000Z`),
        createdById: adminId,
      },
    });

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    ownerCookie = await loginUser(app, OWNER_LOGIN, PASSWORD);
    otherCookie = await loginUser(app, OTHER_LOGIN, PASSWORD);
    adminCookie = await loginUser(app, ADMIN_LOGIN, PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
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
  // Fixture helpers（沿 phase6-official-mileage.test.ts 之 createTravelRow 同型）
  // ===========================================================================

  /**
   * 直接建立一筆 Application 列（不經 API，以控制精確狀態／型別／日期）。
   *
   * `segments` 提供時建立對應 `TripSegment` 列，且 `snapshotTotalKm` 一律由
   * `Σ segments[].totalKm` 推導（AC-12 高速里程不重複加總之真實 fixture）。
   * `createdAt` 提供時顯式寫入（AC-11 之鑑別欄位）。
   */
  async function createApplicationRow(opts: {
    ownerId: string;
    type?: "TRAVEL" | "MAINTENANCE" | "DEPRECIATION";
    status: "DRAFT" | "COMPLETED" | "VOIDED";
    primaryDate: string;
    tripDate?: string | null;
    snapshotTotalKm?: string | null;
    createdAt?: string;
    segments?: Array<{ totalKm: string; highwayKm: string }>;
  }): Promise<string> {
    const type = opts.type ?? "TRAVEL";
    const hasTravel = type === "TRAVEL";
    const snapshotTotalKmValue = opts.segments
      ? opts.segments
          .reduce((acc, seg) => acc.plus(new Prisma.Decimal(seg.totalKm)), new Prisma.Decimal("0"))
          .toFixed(2)
      : (opts.snapshotTotalKm ?? undefined);
    const application = await prisma.application.create({
      data: {
        type,
        status: opts.status,
        ownerId: opts.ownerId,
        createdById: opts.ownerId,
        primaryDate: new Date(opts.primaryDate),
        ...(opts.createdAt ? { createdAt: new Date(opts.createdAt) } : {}),
        ...(hasTravel
          ? {
              travel: {
                create: {
                  tripDate:
                    opts.tripDate === undefined
                      ? new Date(opts.primaryDate)
                      : opts.tripDate === null
                        ? undefined
                        : new Date(opts.tripDate),
                  snapshotTotalKm: snapshotTotalKmValue,
                },
              },
            }
          : {}),
      },
    });
    track(application.id);
    if (opts.segments) {
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
    }
    return application.id;
  }

  /**
   * §20.6：預覽 body 新增 `annualTotalKm`。除非呼叫端顯式覆寫，一律帶入
   * `ANNUAL_TOTAL_KM`——「不帶」是 AC-53(b) 之專屬情境，屬
   * `phase7-depreciation-parameters.test.ts`（R6 之 AC-53 段）之覆蓋範圍。
   */
  async function previewRequest(cookie: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/applications/depreciation/preview",
      headers: { cookie },
      payload: { annualTotalKm: ANNUAL_TOTAL_KM, ...payload },
    });
  }

  async function previewOk(cookie: string, payload: Record<string, unknown>): Promise<PreviewDto> {
    const resp = await previewRequest(cookie, payload);
    expect(resp.statusCode).toBe(200);
    return resp.json<{ preview: PreviewDto }>().preview;
  }

  // ===========================================================================
  // AC-09 — 引擎複用（import 接線斷言 ＋ 活體突變自證）
  // ===========================================================================

  describe("AC-09: annual mileage goes through sumOfficialMileage — import wiring asserted from source, with live mutation self-proof", () => {
    it("depreciation-service imports sumOfficialMileage from mileage-engine.js (source-level import assertion)", () => {
      const rawSource = fs.readFileSync(DEPRECIATION_SERVICE_SRC_PATH, "utf8");
      expect(rawSource).toMatch(
        /import\s*\{[^}]*sumOfficialMileage[^}]*\}\s*from\s*["']\.\.\/mileage\/mileage-engine\.js["']/
      );
    });

    it("depreciation-service contains no private re-implementation of the aggregation (no travelApplication.aggregate call of its own)", () => {
      const rawSource = fs.readFileSync(DEPRECIATION_SERVICE_SRC_PATH, "utf8");
      expect(rawSource).not.toMatch(/travelApplication\s*\.\s*aggregate/);
    });

    it("mutant self-proof: a preview call actually invokes the real (spied) sumOfficialMileage export — a private in-file re-implementation would leave the spy uncalled and this assertion red", async () => {
      const spy = vi.mocked(mileageEngine.sumOfficialMileage);
      const callsBefore = spy.mock.calls.length;

      const preview = await previewOk(ownerCookie, { applicationYear: YEAR_WIRING });
      expect(preview.officialKm).not.toBeNull();
      expect(spy.mock.calls.length).toBe(callsBefore + 1);

      const lastCall = spy.mock.calls.at(-1) as unknown as [
        unknown,
        { ownerId: string; dateFrom: Date; dateTo: Date },
      ];
      // §7.3 逐字呼叫形狀：ownerId ＋ [YYYY-01-01, YYYY-12-31]（UTC 建構）。
      expect(lastCall[1].ownerId).toBe(ownerId);
      expect(lastCall[1].dateFrom.toISOString().slice(0, 10)).toBe(`${YEAR_WIRING}-01-01`);
      expect(lastCall[1].dateTo.toISOString().slice(0, 10)).toBe(`${YEAR_WIRING}-12-31`);
    });

    it("§9.2 逐字：applicationYear 未提供／為 null → calculable=false ＋ [YEAR_REQUIRED]，且完全不呼叫引擎（不查 DB）", async () => {
      const spy = vi.mocked(mileageEngine.sumOfficialMileage);

      const callsBeforeMissing = spy.mock.calls.length;
      const missing = await previewOk(ownerCookie, {});
      expect(missing.calculable).toBe(false);
      expect(missing.blockingCodes).toEqual(["YEAR_REQUIRED"]);
      expect(missing.officialKm).toBeNull();
      expect(missing.officialApplicationCount).toBeNull();
      expect(spy.mock.calls.length).toBe(callsBeforeMissing);

      const callsBeforeNull = spy.mock.calls.length;
      const explicitNull = await previewOk(ownerCookie, { applicationYear: null });
      expect(explicitNull.calculable).toBe(false);
      expect(explicitNull.blockingCodes).toEqual(["YEAR_REQUIRED"]);
      expect(spy.mock.calls.length).toBe(callsBeforeNull);
    });
  });

  // ===========================================================================
  // AC-10 — 年度區間之四點邊界（起訖含當日）
  // ===========================================================================

  describe("AC-10: Jan 1 and Dec 31 trips are included; Dec 31 of the previous year and Jan 1 of the next year are excluded", () => {
    it("四點邊界：本年 01-01 與 12-31 納入；前一年 12-31 與次年 01-01 不納入", async () => {
      const y = YEAR_BOUNDARY;
      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${y - 1}-12-31`,
        tripDate: `${y - 1}-12-31`,
        snapshotTotalKm: "1000.00",
      });
      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${y}-01-01`,
        tripDate: `${y}-01-01`,
        snapshotTotalKm: "11.00",
      });
      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${y}-12-31`,
        tripDate: `${y}-12-31`,
        snapshotTotalKm: "22.00",
      });
      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${y + 1}-01-01`,
        tripDate: `${y + 1}-01-01`,
        snapshotTotalKm: "2000.00",
      });

      const preview = await previewOk(ownerCookie, { applicationYear: y });
      expect(preview.officialKm).toBe("33.00");
      expect(preview.officialApplicationCount).toBe(2);
    });

    it("B-06 閏年（2024）：2/29 之差旅正常納入，區間仍為 01-01~12-31", async () => {
      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2024-02-29",
        tripDate: "2024-02-29",
        snapshotTotalKm: "29.00",
      });

      const spy = vi.mocked(mileageEngine.sumOfficialMileage);
      const preview = await previewOk(ownerCookie, { applicationYear: 2024 });
      expect(preview.officialKm).toBe("29.00");

      const lastCall = spy.mock.calls.at(-1) as unknown as [
        unknown,
        { dateFrom: Date; dateTo: Date },
      ];
      expect(lastCall[1].dateFrom.toISOString().slice(0, 10)).toBe("2024-01-01");
      expect(lastCall[1].dateTo.toISOString().slice(0, 10)).toBe("2024-12-31");
    });
  });

  // ===========================================================================
  // AC-11 — 依出差日期歸屬（非建立日期），兩向各一
  // ===========================================================================

  describe("AC-11: attribution follows tripDate, not createdAt (both directions)", () => {
    it("createdAt 落於該年但 tripDate 不在該年 → 不納入；createdAt 不在該年但 tripDate 在該年 → 納入", async () => {
      const y = YEAR_ATTRIBUTION;

      // 方向 ①：createdAt 在該年、tripDate 在前一年 → 不納入。
      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${y - 1}-06-15`,
        tripDate: `${y - 1}-06-15`,
        createdAt: `${y}-03-01T00:00:00.000Z`,
        snapshotTotalKm: "500.00",
      });

      // 方向 ②：createdAt 在次年、tripDate 在該年 → 納入。
      const includedId = await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${y}-06-15`,
        tripDate: `${y}-06-15`,
        createdAt: `${y + 1}-03-01T00:00:00.000Z`,
        snapshotTotalKm: "77.00",
      });

      // createdAt 之相異值確實已寫入（鑑別力自證：若 createdAt 未生效，
      // 本測試對「歸屬依 tripDate」之鑑別即不成立）。
      const includedRow = await prisma.application.findUniqueOrThrow({
        where: { id: includedId },
        select: { createdAt: true },
      });
      expect(includedRow.createdAt.toISOString().slice(0, 4)).toBe(String(y + 1));

      const preview = await previewOk(ownerCookie, { applicationYear: y });
      expect(preview.officialKm).toBe("77.00");
      expect(preview.officialApplicationCount).toBe(1);
    });
  });

  // ===========================================================================
  // AC-12 — 僅擁有人之已完成未作廢差旅；高速里程不重複加總
  // ===========================================================================

  describe("AC-12: only COMPLETED non-voided TRAVEL of the owner counts; highway km is never double-counted", () => {
    it("DRAFT／VOIDED 差旅、他人差旅、MAINTENANCE／DEPRECIATION 申請皆不納入", async () => {
      const y = YEAR_ELIGIBILITY;
      const d = `${y}-05-05`;

      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: d,
        tripDate: d,
        snapshotTotalKm: "40.00",
      });
      await createApplicationRow({
        ownerId,
        status: "DRAFT",
        primaryDate: d,
        tripDate: d,
        snapshotTotalKm: "111.00",
      });
      await createApplicationRow({
        ownerId,
        status: "VOIDED",
        primaryDate: d,
        tripDate: d,
        snapshotTotalKm: "222.00",
      });
      await createApplicationRow({
        ownerId: otherId,
        status: "COMPLETED",
        primaryDate: d,
        tripDate: d,
        snapshotTotalKm: "333.00",
      });
      await createApplicationRow({
        ownerId,
        type: "MAINTENANCE",
        status: "COMPLETED",
        primaryDate: d,
      });
      await createApplicationRow({
        ownerId,
        type: "DEPRECIATION",
        status: "COMPLETED",
        primaryDate: d,
      });

      const preview = await previewOk(ownerCookie, { applicationYear: y });
      expect(preview.officialKm).toBe("40.00");
      expect(preview.officialApplicationCount).toBe(1);
    });

    it("高速里程不重複加總：含 highwayKm == totalKm 之真實段落，officialKm 恰為 Σ snapshotTotalKm", async () => {
      const y = YEAR_ELIGIBILITY;
      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${y}-08-08`,
        tripDate: `${y}-08-08`,
        segments: [
          { totalKm: "8.34", highwayKm: "8.34" }, // 全程高速
          { totalKm: "4.00", highwayKm: "1.00" }, // 部分高速
        ],
      });

      // 40.00（前一測試之唯一合格列）＋ 12.34 ＝ 52.34；若高速里程被二次加總，
      // 將出現 61.68 之類的值而必紅。
      const preview = await previewOk(ownerCookie, { applicationYear: y });
      expect(preview.officialKm).toBe("52.34");
      expect(preview.officialApplicationCount).toBe(2);
    });
  });

  // ===========================================================================
  // 預覽端點行為（T6 接線面）
  //   — 零寫入不變式（§9.2）／`resolveOwnerId` fail-closed ／授權先於格式驗證
  //   — `ownerId` 恆為擁有人之對照組（T6 Done When；AC-14 之正式實名斷言屬 T6b）
  // ===========================================================================

  describe("預覽端點行為（T6 接線面：零寫入／授權／ownerId 對照組）", () => {
    it("零寫入不變式：預覽呼叫前後 Application／DepreciationApplication 資料列總數皆不變", async () => {
      const applicationsBefore = await prisma.application.count();
      const depreciationBefore = await prisma.depreciationApplication.count();

      await previewOk(ownerCookie, { applicationYear: YEAR_PREVIEW_MISC });

      expect(await prisma.application.count()).toBe(applicationsBefore);
      expect(await prisma.depreciationApplication.count()).toBe(depreciationBefore);
    });

    it("resolveOwnerId fail-closed：一般使用者帶他人 ownerId → 403，且回應不含任何數值（B-28）", async () => {
      const resp = await previewRequest(ownerCookie, {
        ownerId: otherId,
        applicationYear: YEAR_PREVIEW_MISC,
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
      expect(resp.body).not.toContain("officialKm");
    });

    it("B-29：一般使用者帶自己的 ownerId → 200（等同不帶）", async () => {
      const withOwnerId = await previewOk(ownerCookie, {
        ownerId,
        applicationYear: YEAR_BOUNDARY,
      });
      const withoutOwnerId = await previewOk(ownerCookie, { applicationYear: YEAR_BOUNDARY });
      expect(withOwnerId).toEqual(withoutOwnerId);
    });

    it("授權先於格式驗證：一般使用者帶他人 ownerId ＋ 畸形 applicationYear → 仍為 403（不是 400）", async () => {
      const resp = await previewRequest(ownerCookie, {
        ownerId: otherId,
        applicationYear: "not-a-year",
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    });

    it("格式驗證仍在場：畸形 applicationYear（不帶他人 ownerId）→ 400 VALIDATION_ERROR", async () => {
      const resp = await previewRequest(ownerCookie, { applicationYear: "not-a-year" });
      expect(resp.statusCode).toBe(400);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
    });

    it("未登入 → 401（§6.1 授權矩陣第 5 列）", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/depreciation/preview",
        payload: { applicationYear: YEAR_PREVIEW_MISC },
      });
      expect(resp.statusCode).toBe(401);
    });

    it("ownerId 對照組：管理員預覽擁有人之年度里程 → 引擎收到擁有人 id（絕非管理員），且管理員本人之差旅不影響該值", async () => {
      const y = YEAR_CONTRAST;
      // 管理員本人於該年有差旅；擁有人於該年沒有任何差旅。
      await createApplicationRow({
        ownerId: adminId,
        status: "COMPLETED",
        primaryDate: `${y}-04-04`,
        tripDate: `${y}-04-04`,
        snapshotTotalKm: "999.00",
      });

      const spy = vi.mocked(mileageEngine.sumOfficialMileage);
      const callsBefore = spy.mock.calls.length;

      const preview = await previewOk(adminCookie, { ownerId, applicationYear: y });
      expect(spy.mock.calls.length).toBe(callsBefore + 1);

      const lastCall = spy.mock.calls.at(-1) as unknown as [unknown, { ownerId: string }];
      expect(lastCall[1].ownerId).toBe(ownerId);
      expect(lastCall[1].ownerId).not.toBe(adminId);

      // 對照組本體：擁有人該年無差旅 → 0.00（管理員自己的 999.00 未被誤用）。
      expect(preview.officialKm).toBe("0.00");
      expect(preview.officialApplicationCount).toBe(0);

      // 反向對照：管理員預覽自己 → 999.00（證明資料確實存在，非「查無資料」假綠）。
      const adminOwn = await previewOk(adminCookie, { ownerId: adminId, applicationYear: y });
      expect(adminOwn.officialKm).toBe("999.00");
    });

    it("PCR（mustChangePassword）身分 → 403 PASSWORD_CHANGE_REQUIRED（§6.1 授權矩陣第 5 列）", async () => {
      const pcrLogin = `${LOGIN_PREFIX}pcr_${RUN_ID}`;
      const pcrPassword = "AnnualMileagePcr99!";
      await prisma.user.create({
        data: {
          loginName: pcrLogin,
          displayName: "P7T6 需改密碼",
          passwordHash: await hashPassword(pcrPassword),
          role: "USER",
          isActive: true,
          mustChangePassword: true,
        },
      });
      const cookie = await loginUser(app, pcrLogin, pcrPassword);

      const resp = await previewRequest(cookie, { applicationYear: YEAR_PREVIEW_MISC });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    });

    it("otherId 之獨立性自證：他人以自己的身分預覽同一年度 → 200（403 僅來自「帶他人 ownerId」而非端點不可用）", async () => {
      const preview = await previewOk(otherCookie, { applicationYear: YEAR_PREVIEW_MISC });
      expect(preview.officialKm).toBe("0.00");
    });
  });

  // ===========================================================================
  // PHASE-007-T6b
  // AC-13 — D2(a) `count`／`SUM` 不對稱之折舊處置（Spec §2 AC-13 逐字、B-13）
  // ===========================================================================

  describe("AC-13: a null snapshot row is counted by applicationCount but ignored by totalKm; only totalKm feeds the amount", () => {
    /**
     * `null` 快照 fixture（Packet 明示，沿 PHASE-006 AC-15 同型手法）：已完成
     * 差旅之 `snapshotTotalKm` 直寫 `null`（`createApplicationRow` 收到
     * `null` 時該欄留空，DB 端即為 `NULL`）。
     */
    it("已完成差旅之 snapshotTotalKm 為 null 時：officialApplicationCount 計入該列、officialKm 忽略該列", async () => {
      const y = YEAR_NULL_SNAPSHOT;

      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${y}-03-03`,
        tripDate: `${y}-03-03`,
        snapshotTotalKm: "60.00",
      });
      const nullRowId = await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${y}-09-09`,
        tripDate: `${y}-09-09`,
        snapshotTotalKm: null,
      });

      // fixture 自證：該列之 snapshotTotalKm 確實為 DB 層 NULL（若 fixture 實
      // 際寫入了 0.00，本測試對「SUM 忽略 null」之鑑別力即不成立）。
      const nullRow = await prisma.travelApplication.findUniqueOrThrow({
        where: { applicationId: nullRowId },
        select: { snapshotTotalKm: true },
      });
      expect(nullRow.snapshotTotalKm).toBeNull();

      const preview = await previewOk(ownerCookie, { applicationYear: y });

      // MUTANT：把下一行改為 `toBe(1)`（「count 不計入 null 列」）即紅——
      // 本斷言釘住的正是引擎既有之不對稱行為本身。
      expect(preview.officialApplicationCount).toBe(2);
      // MUTANT：把下一行改為 `"0.00"` 或任何含該列貢獻的值即紅。
      expect(preview.officialKm).toBe("60.00");
    });

    it("極端外觀（B-13 逐字）：該年只有一筆 null 快照之已完成差旅 → 筆數 1 而里程 0.00（偏差方向保守：偏低、不溢付）", async () => {
      const y = YEAR_NULL_ONLY;

      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${y}-07-07`,
        tripDate: `${y}-07-07`,
        snapshotTotalKm: null,
      });

      const preview = await previewOk(ownerCookie, { applicationYear: y });
      expect(preview.officialApplicationCount).toBe(1);
      expect(preview.officialKm).toBe("0.00");
    });

    /**
     * AC-13 後半逐字：「折舊之任何金額計算一律只使用 `totalKm`；
     * `applicationCount` 純供顯示，**不得**參與分子、分母或任何推導」。
     *
     * 不變式形式：兩個年度之 `officialKm` 完全相同、`officialApplicationCount`
     * 相異（1 vs 3）時，**全部金額面欄位必須逐欄全等**。若任何實作把
     * `applicationCount` 帶進金額推導（例如以之為分母求平均、或以之為「有無
     * 資料」之判準），兩者必產生可觀測差異而必紅。
     *
     * **鑑別力邊界（T6R S-1 登記，PHASE-007-T7 已清償）**：本斷言原為
     * `null` 對 `null` 之比較。T7（本次）已於 `beforeAll` 播種一筆
     * `effectiveFrom = 2000-01-01` 之折舊參數版本，故三個金額面欄位皆為**真實
     * 值**（單價 `6.0000`、`rawAmount "600.0000"`、`amount 600`），本不變式
     * 因而具備正向鑑別力：任何把 `applicationCount` 帶進金額推導的實作，兩年
     * 之金額必然分歧而必紅。
     */
    it("applicationCount 不參與任何金額推導：officialKm 相同而筆數相異（1 vs 3）時，全部金額面欄位逐欄全等", async () => {
      const yA = YEAR_COUNT_NEUTRAL_A;
      const yB = YEAR_COUNT_NEUTRAL_B;

      // A 年：單一筆 100.00。
      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${yA}-06-06`,
        tripDate: `${yA}-06-06`,
        snapshotTotalKm: "100.00",
      });

      // B 年：同樣是 100.00 之 totalKm，但另有兩筆 null 快照列（筆數 3）。
      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${yB}-06-06`,
        tripDate: `${yB}-06-06`,
        snapshotTotalKm: "100.00",
      });
      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${yB}-06-07`,
        tripDate: `${yB}-06-07`,
        snapshotTotalKm: null,
      });
      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${yB}-06-08`,
        tripDate: `${yB}-06-08`,
        snapshotTotalKm: null,
      });

      const a = await previewOk(ownerCookie, { applicationYear: yA });
      const b = await previewOk(ownerCookie, { applicationYear: yB });

      // 前提自證：兩年之 totalKm 相同、筆數確實相異（否則本不變式無鑑別力）。
      expect(a.officialKm).toBe("100.00");
      expect(b.officialKm).toBe("100.00");
      expect(a.officialApplicationCount).toBe(1);
      expect(b.officialApplicationCount).toBe(3);

      // 金額面逐欄全等（`officialApplicationCount` 為唯一允許相異之欄位）。
      expect(b.annualDepreciation).toEqual(a.annualDepreciation);
      expect(b.ratio).toEqual(a.ratio);
      expect(b.rawAmount).toEqual(a.rawAmount);
      expect(b.amount).toEqual(a.amount);
      expect(b.calculable).toEqual(a.calculable);
      expect(b.blockingCodes).toEqual(a.blockingCodes);
      expect({ ...b, officialApplicationCount: a.officialApplicationCount }).toEqual(a);

      // 鑑別力自證（T7 播種後）：比較的確實是真實金額，而非 null 對 null。
      expect(a.annualDepreciation).toBe(PARAM_ANNUAL_DEPRECIATION);
      expect(a.rawAmount).toBe("600.0000");
      expect(a.amount).toBe(600);
      expect(a.calculable).toBe(true);
    });

    /**
     * FW-3 之正向鑑別（與上一條互補）：**同筆數、異里程 ⇒ 金額必異**。
     *
     * 上一條證明「筆數不影響金額」，本條證明「里程確實影響金額」——兩條合起來
     * 才排除「金額根本沒有真的用到 `totalKm`」這一類假綠（例如實作把金額寫死
     * 或誤用常數）。
     */
    it("同 applicationCount 而 totalKm 相異 ⇒ 金額相異（里程確實進入金額計算）", async () => {
      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${YEAR_AMOUNT_A}-05-05`,
        tripDate: `${YEAR_AMOUNT_A}-05-05`,
        snapshotTotalKm: "100.00",
      });
      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${YEAR_AMOUNT_B}-05-05`,
        tripDate: `${YEAR_AMOUNT_B}-05-05`,
        snapshotTotalKm: "250.00",
      });

      const a = await previewOk(ownerCookie, { applicationYear: YEAR_AMOUNT_A });
      const b = await previewOk(ownerCookie, { applicationYear: YEAR_AMOUNT_B });

      // 前提自證：筆數相同（1 vs 1），里程相異。
      expect(a.officialApplicationCount).toBe(1);
      expect(b.officialApplicationCount).toBe(1);
      expect(a.officialKm).toBe("100.00");
      expect(b.officialKm).toBe("250.00");

      // 100.00 × 6.0000 = 600；250.00 × 6.0000 = 1500。
      expect(a.amount).toBe(600);
      expect(b.amount).toBe(1500);
      expect(b.amount).not.toEqual(a.amount);
      expect(b.rawAmount).toBe("1500.0000");
    });
  });

  // ===========================================================================
  // PHASE-007-T6b
  // AC-14 — `ownerId` 恆為擁有人；預覽 `resolveOwnerId` fail-closed
  // ===========================================================================

  describe("AC-14: ownerId is always the application owner; preview resolves ownerId fail-closed (403 for another user) and authorises before field validation", () => {
    /**
     * 代操作草稿列（管理員代建）——`POST /admin/users/:userId/applications/
     * depreciation` 屬 T10（AC-34）尚未落地，故此處以 DB fixture 直建等價
     * 資料形狀：`ownerId` ＝ 擁有人、`createdById` ＝ 操作者（管理員）。
     */
    async function createOnBehalfDepreciationDraft(applicationYear: number): Promise<string> {
      const application = await prisma.application.create({
        data: {
          type: "DEPRECIATION",
          status: "DRAFT",
          ownerId,
          createdById: adminId,
          primaryDate: new Date(Date.UTC(applicationYear, 11, 31)),
          depreciation: { create: { applicationYear } },
        },
      });
      track(application.id);
      return application.id;
    }

    it("代操作草稿之年度里程以擁有人計算：computeDepreciationComputed 收到 Application.ownerId（絕非 createdById）", async () => {
      const y = YEAR_ON_BEHALF;

      // 擁有人與操作者於同一年度各有差旅，且金額顯著相異（鑑別力來源）。
      await createApplicationRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: `${y}-02-02`,
        tripDate: `${y}-02-02`,
        snapshotTotalKm: "88.00",
      });
      await createApplicationRow({
        ownerId: adminId,
        status: "COMPLETED",
        primaryDate: `${y}-02-02`,
        tripDate: `${y}-02-02`,
        snapshotTotalKm: "777.00",
      });

      const draftId = await createOnBehalfDepreciationDraft(y);

      // 006 T8 MF-1 教訓：代操作夾帶一律以**頂層純量**斷言（不比整包物件）。
      const draftRow = await prisma.application.findUniqueOrThrow({
        where: { id: draftId },
        select: { ownerId: true, createdById: true },
      });
      expect(draftRow.ownerId).toBe(ownerId);
      expect(draftRow.createdById).toBe(adminId);
      expect(draftRow.ownerId).not.toBe(draftRow.createdById);

      // 服務函式面：以草稿之擁有人計算 → 擁有人的 88.00。
      const byOwner = await computeDepreciationComputed(prisma, {
        annualTotalKm: new Prisma.Decimal(ANNUAL_TOTAL_KM),
        ownerId: draftRow.ownerId,
        applicationYear: y,
      });
      // MUTANT：把上一行的 `draftRow.ownerId` 改為 `draftRow.createdById`
      // （即「以操作者計算」之錯誤實作）→ 下一行得到 "777.00" 而必紅。
      expect(byOwner.officialKm).toBe("88.00");
      expect(byOwner.officialApplicationCount).toBe(1);

      // 鑑別力自證：操作者於同年度確實有一筆顯著相異的里程（非「查無資料」假綠）。
      const byOperator = await computeDepreciationComputed(prisma, {
        annualTotalKm: new Prisma.Decimal(ANNUAL_TOTAL_KM),
        ownerId: draftRow.createdById,
        applicationYear: y,
      });
      expect(byOperator.officialKm).toBe("777.00");

      // 端點面：管理員以該草稿之擁有人預覽 → 同為擁有人之值。
      const preview = await previewOk(adminCookie, {
        ownerId: draftRow.ownerId,
        applicationYear: y,
      });
      expect(preview.officialKm).toBe("88.00");
    });

    it("對照組（AC-14 括號逐字）：管理員本人該年有差旅、擁有人無差旅 → 擁有人之里程為 0.00", async () => {
      const y = YEAR_AC14_CONTRAST;
      await createApplicationRow({
        ownerId: adminId,
        status: "COMPLETED",
        primaryDate: `${y}-10-10`,
        tripDate: `${y}-10-10`,
        snapshotTotalKm: "555.00",
      });

      const forOwner = await previewOk(adminCookie, { ownerId, applicationYear: y });
      expect(forOwner.officialKm).toBe("0.00");
      expect(forOwner.officialApplicationCount).toBe(0);

      // 反向對照：同一年度、同一端點，管理員查自己 → 555.00（資料確實存在）。
      const forAdmin = await previewOk(adminCookie, { ownerId: adminId, applicationYear: y });
      expect(forAdmin.officialKm).toBe("555.00");
    });

    it("B-28 fail-closed：一般使用者帶他人 ownerId → 403 FORBIDDEN，不靜默降級為自己，且回應不含任何數值", async () => {
      const y = YEAR_AC14_MISC;
      await createApplicationRow({
        ownerId: otherId,
        status: "COMPLETED",
        primaryDate: `${y}-01-20`,
        tripDate: `${y}-01-20`,
        snapshotTotalKm: "444.00",
      });

      const resp = await previewRequest(ownerCookie, { ownerId: otherId, applicationYear: y });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
      // 不洩漏他人里程：回應本文不得出現任何數值欄位或該值本身。
      expect(resp.body).not.toContain("officialKm");
      expect(resp.body).not.toContain("444");
      // 「不靜默降級為自己」：若實作把 ownerId 降級為呼叫者，會得到 200。
      expect(resp.statusCode).not.toBe(200);
    });

    it("B-29／B-30：一般使用者帶自己的 ownerId → 200（等同不帶）；管理員指定他人 ownerId → 200", async () => {
      const y = YEAR_ON_BEHALF;

      const selfExplicit = await previewOk(ownerCookie, { ownerId, applicationYear: y });
      const selfImplicit = await previewOk(ownerCookie, { applicationYear: y });
      expect(selfExplicit).toEqual(selfImplicit);
      expect(selfExplicit.officialKm).toBe("88.00");

      const adminForOther = await previewOk(adminCookie, {
        ownerId: otherId,
        applicationYear: y,
      });
      expect(adminForOther.officialKm).toBe("0.00");
    });

    it("授權先於欄位格式驗證（§6.1 明文、沿 PHASE-005 B-26／006 §6.1）：他人 ownerId ＋ 畸形 applicationYear → 403 而非 400", async () => {
      const resp = await previewRequest(ownerCookie, {
        ownerId: otherId,
        applicationYear: "not-a-year",
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");

      // 判定順序自證：同一畸形年度、不帶他人 ownerId → 400（證明格式驗證確實
      // 在場，403 是「先授權」而非「該 body 根本不會被驗證」）。
      const sameBodySelf = await previewRequest(ownerCookie, { applicationYear: "not-a-year" });
      expect(sameBodySelf.statusCode).toBe(400);
      expect(sameBodySelf.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ===========================================================================
  // T6R S-2 — 服務層之非整數年度守門（與純函式同一判準）
  //
  // `routes.ts` 之 `parseApplicationYearField` 於 HTTP 面已擋下非整數年度，
  // 但 `computeDepreciationComputed` 是 **exported 服務函式**：T7／T9 之呼叫端
  // 若由別處（例如 DB 讀出之 `applicationYear`、或未來的內部批次）取得年度，
  // 就不再有該道 HTTP 驗證。`depreciation-blockers.ts:92-94` 對同一語意採
  // `Number.isInteger()` 守門（`NaN`／`Invalid Date` 推導視同缺漏），本服務層
  // 必須採**同一判準**，否則非有限值會直接落入 `Date.UTC(NaN, ...)` →
  // Prisma 驗證錯誤（500），而非保守地回 `YEAR_REQUIRED`。
  // ===========================================================================

  describe("T6R S-2：非整數／非有限之 applicationYear 守門（與 depreciation-blockers 同一判準）", () => {
    it("NaN → YEAR_REQUIRED，不拋錯、引擎零呼叫", async () => {
      const spy = vi.mocked(mileageEngine.sumOfficialMileage);
      const callsBefore = spy.mock.calls.length;

      const computed = await computeDepreciationComputed(prisma, {
        annualTotalKm: new Prisma.Decimal(ANNUAL_TOTAL_KM),
        ownerId,
        applicationYear: Number.NaN,
      });

      expect(computed.calculable).toBe(false);
      expect(computed.blockingCodes).toEqual(["YEAR_REQUIRED"]);
      expect(computed.officialKm).toBeNull();
      expect(computed.officialApplicationCount).toBeNull();
      expect(spy.mock.calls.length).toBe(callsBefore);
    });

    it("Infinity → YEAR_REQUIRED，不拋錯、引擎零呼叫", async () => {
      const spy = vi.mocked(mileageEngine.sumOfficialMileage);
      const callsBefore = spy.mock.calls.length;

      const computed = await computeDepreciationComputed(prisma, {
        annualTotalKm: new Prisma.Decimal(ANNUAL_TOTAL_KM),
        ownerId,
        applicationYear: Number.POSITIVE_INFINITY,
      });

      expect(computed.calculable).toBe(false);
      expect(computed.blockingCodes).toEqual(["YEAR_REQUIRED"]);
      expect(spy.mock.calls.length).toBe(callsBefore);
    });

    it("非整數（2025.7）→ YEAR_REQUIRED，不得靜默截斷為 2025 而回傳里程", async () => {
      const spy = vi.mocked(mileageEngine.sumOfficialMileage);
      const callsBefore = spy.mock.calls.length;

      const computed = await computeDepreciationComputed(prisma, {
        annualTotalKm: new Prisma.Decimal(ANNUAL_TOTAL_KM),
        ownerId,
        applicationYear: 2025.7,
      });

      expect(computed.calculable).toBe(false);
      expect(computed.blockingCodes).toEqual(["YEAR_REQUIRED"]);
      expect(computed.officialKm).toBeNull();
      // 靜默截斷之反證：若實作把 2025.7 交給 `Date.UTC`（截斷為 2025），
      // 引擎會被呼叫一次而本斷言必紅。
      expect(spy.mock.calls.length).toBe(callsBefore);
    });
  });
});
