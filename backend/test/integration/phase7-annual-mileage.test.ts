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

type PreviewDto = {
  calculable: boolean;
  officialKm: string | null;
  officialApplicationCount: number | null;
  perKmUnitPrice: string | null;
  rawAmount: string | null;
  amount: number | null;
  blockingCodes: string[];
};

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

  async function previewRequest(cookie: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/applications/depreciation/preview",
      headers: { cookie },
      payload,
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
});
