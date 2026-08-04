/**
 * Integration tests for PHASE-006-T5:
 *   期間公務里程接線（引擎複用）＋ 預覽端點 ＋ 草稿 DTO `computed` 填充。
 *
 * Spec §2 群組 D／E（AC-11~15，本 Task 主軸；AC-16~20 已由 T2/T3 之純函式
 * 覆蓋，本檔只驗證「接線後」的整合層行為）、§7.2 `MaintenanceComputedDto`、
 * §7.3（`sumOfficialMileage` 逐字呼叫形狀）、§9.2「分攤預覽」、§16 D6(a)
 * （stateless preview 端點 ＋ 草稿內嵌 `computed`）。
 *
 * TDD: written BEFORE `maintenance-service.ts`/`routes.ts` 之 T5 擴充存在
 * （引擎接線／`computeMaintenanceComputed`／`/applications/maintenance/preview`
 * 端點）；第一輪預期為紅（404 於未知路由；`computed` 恆為 `null`）。見 Task
 * Handoff 之 RED 輸出。
 *
 * AC-14 引擎複用之「突變自證」技法（沿 PHASE-005a-T8
 * `phase5a-travel-complete.test.ts` 對 `resolveTravelParameters` 之既有慣例，
 * 見該檔 `vi.mock` 區塊）：以 `vi.mock` 包裝 `mileage-engine.js` 之真實實作為
 * `vi.fn`（行為不變，只加可觀測性）。若 `maintenance-service.ts` 改為「移除
 * import、自行複製一份私有加總邏輯」，則本檔對 spy 呼叫次數／參數的斷言會
 * 觀察到 0 次呼叫而必然變紅——這就是「移除該 import 改為私有複製必紅」的
 * 具體實現方式（比對 phase5a-travel-complete.test.ts 819 行區塊之同型註解）。
 *
 * Test discipline (Spec §11.0 / Packet):
 *   - loginName prefix "p6t5_" + per-run random suffix.
 *   - cleanup scoped to this suite's own tracked application ids + loginName
 *     prefix; NEVER deleteMany({}) globally.
 *   - synthetic data only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import * as mileageEngine from "../../src/mileage/mileage-engine.js";
import { buildServer } from "../../src/server.js";

// AC-14 突變自證：包裝真實實作為 spy，行為不變，只加可觀測性（見檔頭說明）。
vi.mock("../../src/mileage/mileage-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mileage/mileage-engine.js")>();
  return {
    ...actual,
    sumOfficialMileage: vi.fn(actual.sumOfficialMileage),
  };
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const MAINTENANCE_SERVICE_SRC_PATH = path.resolve(
  BACKEND_ROOT,
  "src/applications/maintenance-service.ts"
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
const LOGIN_PREFIX = "p6t5_";
const PASSWORD = "OfficialMileageTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;

describeWithDb("PHASE-006-T5 — 期間公務里程接線 + 預覽端點 + computed 填充", () => {
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
        displayName: "P6T5 擁有人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const other = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "P6T5 他人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "P6T5 管理員",
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
  // Fixture helpers
  // ===========================================================================

  /** 直接建立一筆 TRAVEL/MAINTENANCE 之 Application 列（不經 API，控制精確狀態）。 */
  async function createTravelRow(opts: {
    ownerId: string;
    type?: "TRAVEL" | "MAINTENANCE";
    status: "DRAFT" | "COMPLETED" | "VOIDED";
    primaryDate: string;
    tripDate?: string | null;
    snapshotTotalKm?: string | null;
  }): Promise<string> {
    const type = opts.type ?? "TRAVEL";
    const hasTravel = type === "TRAVEL";
    const application = await prisma.application.create({
      data: {
        type,
        status: opts.status,
        ownerId: opts.ownerId,
        createdById: opts.ownerId,
        primaryDate: new Date(opts.primaryDate),
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
                  snapshotTotalKm: opts.snapshotTotalKm ?? undefined,
                },
              },
            }
          : {}),
      },
      include: { travel: true },
    });
    track(application.id);
    return application.id;
  }

  async function previewRequest(cookie: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/applications/maintenance/preview",
      headers: { cookie },
      payload,
    });
  }

  async function createDraftFull(cookie: string, fields: Record<string, unknown>) {
    const createResp = await app.inject({
      method: "POST",
      url: "/applications/maintenance",
      headers: { cookie },
      payload: {},
    });
    expect(createResp.statusCode).toBe(201);
    const id = createResp.json<{ application: { id: string } }>().application.id;
    track(id);

    const putResp = await app.inject({
      method: "PUT",
      url: `/applications/maintenance/${id}`,
      headers: { cookie },
      payload: fields,
    });
    expect(putResp.statusCode).toBe(200);
    return id;
  }

  async function getDraft(cookie: string, id: string) {
    return app.inject({
      method: "GET",
      url: `/applications/maintenance/${id}`,
      headers: { cookie },
    });
  }

  type PreviewDto = {
    calculable: boolean;
    intervalKm: string | null;
    officialKm: string | null;
    officialApplicationCount: number | null;
    ratio: string | null;
    ratioPercent: string | null;
    rawAmount: string | null;
    amount: number | null;
    blockingCodes: string[];
  };

  // ===========================================================================
  // AC-14 引擎複用 — import 接線斷言 + 突變自證
  // ===========================================================================

  describe("AC-14 引擎複用", () => {
    it("maintenance-service imports sumOfficialMileage from mileage-engine.js (source-level import assertion)", () => {
      const rawSource = fs.readFileSync(MAINTENANCE_SERVICE_SRC_PATH, "utf8");
      expect(rawSource).toMatch(
        /import\s*\{[^}]*sumOfficialMileage[^}]*\}\s*from\s*["']\.\.\/mileage\/mileage-engine\.js["']/
      );
    });

    it("mutant self-proof: a preview call actually invokes the real (spied) sumOfficialMileage export — a private in-file re-implementation would leave the spy uncalled and this assertion red", async () => {
      const spy = vi.mocked(mileageEngine.sumOfficialMileage);
      const callsBefore = spy.mock.calls.length;

      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: "2027-01-01",
        currentMaintenanceDate: "2027-02-01",
        lastOdometerKm: "1000",
        currentOdometerKm: "1500",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      expect(spy.mock.calls.length).toBe(callsBefore + 1);

      const lastCall = spy.mock.calls.at(-1) as unknown as [
        unknown,
        { ownerId: string; dateFrom: Date; dateTo: Date },
      ];
      expect(lastCall[1].ownerId).toBe(ownerId);
      expect(lastCall[1].dateFrom.toISOString().slice(0, 10)).toBe("2027-01-01");
      expect(lastCall[1].dateTo.toISOString().slice(0, 10)).toBe("2027-02-01");
    });

    it("ownerId passed to the engine is the application owner, never the acting admin", async () => {
      const draftId = await createDraftFull(ownerCookie, {
        lastMaintenanceDate: "2027-03-01",
        currentMaintenanceDate: "2027-04-01",
        lastOdometerKm: "2000",
        currentOdometerKm: "2500",
        actualCost: "200",
      });

      const spy = vi.mocked(mileageEngine.sumOfficialMileage);
      const callsBefore = spy.mock.calls.length;

      // 管理員代讀擁有人之草稿（AC-05 授權矩陣：管理員 GET → 200）。
      const resp = await getDraft(adminCookie, draftId);
      expect(resp.statusCode).toBe(200);
      expect(spy.mock.calls.length).toBe(callsBefore + 1);

      const lastCall = spy.mock.calls.at(-1) as unknown as [unknown, { ownerId: string }];
      expect(lastCall[1].ownerId).toBe(ownerId);
      expect(lastCall[1].ownerId).not.toBe(adminId);
    });
  });

  // ===========================================================================
  // AC-11 期間含當日
  // ===========================================================================

  describe("AC-11 期間含當日", () => {
    it("trips on the last-maintenance date and on the current-maintenance date are BOTH included", async () => {
      const D1 = "2026-06-10";
      const D2 = "2026-06-20";
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2026-06-09",
        tripDate: "2026-06-09",
        snapshotTotalKm: "10.00",
      });
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: D1,
        tripDate: D1,
        snapshotTotalKm: "20.00",
      });
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: D2,
        tripDate: D2,
        snapshotTotalKm: "30.00",
      });
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2026-06-21",
        tripDate: "2026-06-21",
        snapshotTotalKm: "40.00",
      });

      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: D1,
        currentMaintenanceDate: D2,
        lastOdometerKm: "0",
        currentOdometerKm: "100000",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.officialKm).toBe("50.00");
      expect(preview.officialApplicationCount).toBe(2);
    });

    it("trips one day outside either end are BOTH excluded (reverse assertion — same fixture as above)", async () => {
      // 覆用前一測試已種下的四筆資料集之精神：另建獨立區間 + 獨立四筆，
      // 確保本測試獨立可驗證（不依賴前一測試的執行順序）。
      const D1 = "2026-07-10";
      const D2 = "2026-07-20";
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2026-07-09",
        tripDate: "2026-07-09",
        snapshotTotalKm: "111.00",
      });
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2026-07-21",
        tripDate: "2026-07-21",
        snapshotTotalKm: "222.00",
      });

      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: D1,
        currentMaintenanceDate: D2,
        lastOdometerKm: "0",
        currentOdometerKm: "100000",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.officialKm).toBe("0.00");
      expect(preview.officialApplicationCount).toBe(0);
    });

    it("B-32: dates are compared at UTC day granularity (query uses gte/lte on @db.Date, no local-timezone drift)", async () => {
      const D1 = "2026-08-10";
      const D2 = "2026-08-10"; // 單日區間（合法：D1==D2 皆含當日）
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: D1,
        tripDate: D1,
        snapshotTotalKm: "77.00",
      });

      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: D1,
        currentMaintenanceDate: D2,
        // intervalKm 必須 > 0 才可計算；此處測的是 officialKm 之查詢本身，
        // 用最小合法正區間 0.01 即可，不影響 officialKm/count 之斷言。
        lastOdometerKm: "0",
        currentOdometerKm: "0.01",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.officialKm).toBe("77.00");
      expect(preview.officialApplicationCount).toBe(1);
    });
  });

  // ===========================================================================
  // AC-12 納入條件
  // ===========================================================================

  describe("AC-12 納入條件", () => {
    it("drafts, voided, another user's trips and non-TRAVEL applications are all excluded (0.00)", async () => {
      const D1 = "2026-09-01";
      const D2 = "2026-09-30";

      await createTravelRow({
        ownerId,
        status: "DRAFT",
        primaryDate: "2026-09-10",
        tripDate: "2026-09-10",
        snapshotTotalKm: "999.00",
      });
      await createTravelRow({
        ownerId,
        status: "VOIDED",
        primaryDate: "2026-09-11",
        tripDate: "2026-09-11",
        snapshotTotalKm: "999.00",
      });
      await createTravelRow({
        ownerId: otherId,
        status: "COMPLETED",
        primaryDate: "2026-09-12",
        tripDate: "2026-09-12",
        snapshotTotalKm: "999.00",
      });
      // 本人之保養申請（無 TravelApplication 子表）— 天然不會被
      // `travelApplication.aggregate` 命中，亦不應拋錯。
      await createTravelRow({
        ownerId,
        type: "MAINTENANCE",
        status: "COMPLETED",
        primaryDate: "2026-09-13",
      });

      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: D1,
        currentMaintenanceDate: D2,
        lastOdometerKm: "0",
        currentOdometerKm: "100000",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.officialKm).toBe("0.00");
      expect(preview.officialApplicationCount).toBe(0);
    });

    it("only COMPLETED TRAVEL owned by the application owner contributes", async () => {
      const D1 = "2026-10-01";
      const D2 = "2026-10-31";
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2026-10-15",
        tripDate: "2026-10-15",
        snapshotTotalKm: "15.00",
      });
      // 干擾資料：他人已完成差旅，同期間。
      await createTravelRow({
        ownerId: otherId,
        status: "COMPLETED",
        primaryDate: "2026-10-16",
        tripDate: "2026-10-16",
        snapshotTotalKm: "888.00",
      });

      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: D1,
        currentMaintenanceDate: D2,
        lastOdometerKm: "0",
        currentOdometerKm: "100000",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.officialKm).toBe("15.00");
      expect(preview.officialApplicationCount).toBe(1);
    });
  });

  // ===========================================================================
  // AC-13 高速里程不重複加總 + B-15/B-19/B-20
  // ===========================================================================

  describe("AC-13 高速里程不重複加總", () => {
    it("officialKm equals the exact sum of snapshotTotalKm (highwayKm is never a separate addend by construction — snapshotTotalKm is already the post-completion total, PHASE-004 AC-50)", async () => {
      const D1 = "2026-11-01";
      const D2 = "2026-11-30";
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2026-11-05",
        tripDate: "2026-11-05",
        snapshotTotalKm: "12.34",
      });
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2026-11-06",
        tripDate: "2026-11-06",
        snapshotTotalKm: "8.66",
      });

      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: D1,
        currentMaintenanceDate: D2,
        lastOdometerKm: "0",
        currentOdometerKm: "100000",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.officialKm).toBe("21.00");
      expect(preview.officialApplicationCount).toBe(2);
    });

    it("B-15: a completed trip with zero contributed km (snapshotTotalKm = 0.00, e.g. a 0-segment anomaly) contributes 0, never throws", async () => {
      const D1 = "2026-12-01";
      const D2 = "2026-12-31";
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2026-12-05",
        tripDate: "2026-12-05",
        snapshotTotalKm: "0.00",
      });
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2026-12-06",
        tripDate: "2026-12-06",
        snapshotTotalKm: "5.00",
      });

      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: D1,
        currentMaintenanceDate: D2,
        lastOdometerKm: "0",
        currentOdometerKm: "100000",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.officialKm).toBe("5.00");
      expect(preview.officialApplicationCount).toBe(2);
    });

    it("B-19: no 3-decimal value can originate from Decimal(_,2) sources — the sum always formats to exactly 2 decimals", async () => {
      const D1 = "2027-05-01";
      const D2 = "2027-05-31";
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2027-05-05",
        tripDate: "2027-05-05",
        snapshotTotalKm: "10.01",
      });
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2027-05-06",
        tripDate: "2027-05-06",
        snapshotTotalKm: "20.02",
      });
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2027-05-07",
        tripDate: "2027-05-07",
        snapshotTotalKm: "5.03",
      });

      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: D1,
        currentMaintenanceDate: D2,
        lastOdometerKm: "0",
        currentOdometerKm: "100000",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.officialKm).toBe("35.06");
      expect(preview.officialKm).toMatch(/^\d+\.\d{2}$/);
    });

    it("B-20: 101 completed trips aggregate without overflow and stay a string (not a JSON number)", async () => {
      const D1 = "2027-06-01";
      const D2 = "2027-06-30";
      const days = Array.from({ length: 28 }, (_, i) => i + 1); // 最多 28 天可用（六月），逐日一筆不足 101，改用同日多筆。
      let created = 0;
      for (let i = 0; i < 101; i++) {
        const day = days[i % days.length];
        const dateStr = `2027-06-${String(day).padStart(2, "0")}`;
        await createTravelRow({
          ownerId,
          status: "COMPLETED",
          primaryDate: dateStr,
          tripDate: dateStr,
          snapshotTotalKm: "50.00",
        });
        created++;
      }
      expect(created).toBe(101);

      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: D1,
        currentMaintenanceDate: D2,
        lastOdometerKm: "0",
        currentOdometerKm: "1000000",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.officialKm).toBe("5050.00");
      expect(typeof preview.officialKm).toBe("string");
      expect(preview.officialApplicationCount).toBe(101);
    });
  });

  // ===========================================================================
  // AC-15 D2(a) 不對稱
  // ===========================================================================

  describe("AC-15 D2(a) 不對稱", () => {
    it("a COMPLETED trip with a NULL snapshotTotalKm yields applicationCount=1 but officialKm=0.00", async () => {
      const D1 = "2027-01-01";
      const D2 = "2027-01-31";
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2027-01-15",
        tripDate: "2027-01-15",
        snapshotTotalKm: null,
      });

      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: D1,
        currentMaintenanceDate: D2,
        lastOdometerKm: "0",
        currentOdometerKm: "100000",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.officialApplicationCount).toBe(1);
      expect(preview.officialKm).toBe("0.00");
    });

    it("the amount computation uses totalKm only — applicationCount never influences ratio or amount", async () => {
      const D1 = "2027-02-01";
      const D2 = "2027-02-28";
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2027-02-10",
        tripDate: "2027-02-10",
        snapshotTotalKm: null,
      });
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2027-02-11",
        tripDate: "2027-02-11",
        snapshotTotalKm: "25.00",
      });

      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: D1,
        currentMaintenanceDate: D2,
        lastOdometerKm: "0",
        currentOdometerKm: "100",
        actualCost: "400",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.officialApplicationCount).toBe(2);
      expect(preview.officialKm).toBe("25.00");
      // ratio = 25/100 = 0.25；amount = 400 * 0.25 = 100（未受 count=2 影響）。
      expect(preview.ratio).toBe("0.250000");
      expect(preview.amount).toBe(100);
    });

    it("B-12: a draft trip with a null tripDate never throws", async () => {
      const D1 = "2027-03-01";
      const D2 = "2027-03-31";
      await createTravelRow({
        ownerId,
        status: "DRAFT",
        primaryDate: "2027-03-10",
        tripDate: null,
        snapshotTotalKm: null,
      });

      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: D1,
        currentMaintenanceDate: D2,
        lastOdometerKm: "0",
        currentOdometerKm: "100000",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.officialKm).toBe("0.00");
      expect(preview.officialApplicationCount).toBe(0);
    });
  });

  // ===========================================================================
  // 補測邊界：B-16（跨年）／B-17（極大期間）
  // ===========================================================================

  describe("補測邊界 B-16/B-17", () => {
    it("B-16: a maintenance period crossing a calendar year works normally", async () => {
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2025-12-31",
        tripDate: "2025-12-31",
        snapshotTotalKm: "42.00",
      });
      // 界外反例：區間前一日。
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2025-05-31",
        tripDate: "2025-05-31",
        snapshotTotalKm: "999.00",
      });

      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: "2025-06-01",
        currentMaintenanceDate: "2026-05-31",
        lastOdometerKm: "0",
        currentOdometerKm: "100000",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.officialKm).toBe("42.00");
      expect(preview.officialApplicationCount).toBe(1);
    });

    it("B-17: an extremely large maintenance period (1900-01-01~2999-12-31) is legal, single DB-side aggregation, no crash/truncation", async () => {
      // 獨立使用者隔離（其餘測試之 `ownerId` 於 2026~2028 年間有大量 fixture，
      // 若沿用會被本測試的極大區間一併吃進，破壞鑑別力）——沿
      // PHASE-005-T2 之既有慣例（每個易受干擾的邊界測試使用獨立擁有人）。
      const isolatedLogin = `${LOGIN_PREFIX}b17_${RUN_ID}`;
      const isolatedUser = await prisma.user.create({
        data: {
          loginName: isolatedLogin,
          displayName: "P6T5 B-17 隔離使用者",
          passwordHash: await hashPassword(PASSWORD),
          role: "USER",
          isActive: true,
          mustChangePassword: false,
        },
      });
      const isolatedCookie = await loginUser(app, isolatedLogin, PASSWORD);

      const isolatedAppId = await createTravelRow({
        ownerId: isolatedUser.id,
        status: "COMPLETED",
        primaryDate: "2500-06-15",
        tripDate: "2500-06-15",
        snapshotTotalKm: "13.00",
      });

      const resp = await previewRequest(isolatedCookie, {
        lastMaintenanceDate: "1900-01-01",
        currentMaintenanceDate: "2999-12-31",
        lastOdometerKm: "0",
        currentOdometerKm: "100000",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.officialKm).toBe("13.00");
      expect(preview.officialApplicationCount).toBe(1);

      // 先刪申請（FK Restrict 於 Application.ownerId）再刪使用者。
      await prisma.application.delete({ where: { id: isolatedAppId } });
      const idx = createdApplicationIds.indexOf(isolatedAppId);
      if (idx >= 0) createdApplicationIds.splice(idx, 1);
      await prisma.session.deleteMany({ where: { userId: isolatedUser.id } });
      await prisma.user.delete({ where: { id: isolatedUser.id } });
    });
  });

  // ===========================================================================
  // 預覽端點：零寫入 / 授權 / 授權先於格式 / AMOUNT_OUT_OF_RANGE 雙處暴露
  // ===========================================================================

  describe("預覽端點行為", () => {
    it("零寫入：預覽呼叫前後 Application 資料列總數不變", async () => {
      const before = await prisma.application.count();
      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: "2028-01-01",
        currentMaintenanceDate: "2028-02-01",
        lastOdometerKm: "1000",
        currentOdometerKm: "1500",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const after = await prisma.application.count();
      expect(after).toBe(before);
    });

    it("resolveOwnerId fail-closed：一般使用者帶他人 ownerId → 403（不靜默降級）", async () => {
      const resp = await previewRequest(ownerCookie, {
        ownerId: otherId,
        lastMaintenanceDate: "2028-01-01",
        currentMaintenanceDate: "2028-02-01",
        lastOdometerKm: "1000",
        currentOdometerKm: "1500",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    });

    it("管理員可指定任一 ownerId 進行預覽（該使用者之里程）", async () => {
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2028-03-10",
        tripDate: "2028-03-10",
        snapshotTotalKm: "9.00",
      });
      const resp = await previewRequest(adminCookie, {
        ownerId,
        lastMaintenanceDate: "2028-03-01",
        currentMaintenanceDate: "2028-03-31",
        lastOdometerKm: "0",
        currentOdometerKm: "100000",
        actualCost: "100",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.officialKm).toBe("9.00");
    });

    it("授權先於格式驗證：一般使用者帶他人 ownerId + 畸形欄位 → 仍為 403（不是 400）", async () => {
      const resp = await previewRequest(ownerCookie, {
        ownerId: otherId,
        lastOdometerKm: "abc",
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    });

    it("格式驗證仍在場：畸形欄位（不帶他人 ownerId）→ 400 VALIDATION_ERROR", async () => {
      const resp = await previewRequest(ownerCookie, { lastOdometerKm: "abc" });
      expect(resp.statusCode).toBe(400);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
    });

    it("AMOUNT_OUT_OF_RANGE：草稿 DTO 與預覽皆暴露（無「預覽說可以、完成才擋」反模式）", async () => {
      // rawAmount = 3,000,000,000 × (100/100) = 3,000,000,000 — 超出 int4
      // 上界 2,147,483,647，但未超出 actualCost 欄位容量（<1e10）與
      // Decimal(14,4) 之 rawAmount 容量（<1e10）——精準鑑別 int4 這一道守門。
      const D1 = "2028-04-01";
      const D2 = "2028-04-30";
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2028-04-15",
        tripDate: "2028-04-15",
        snapshotTotalKm: "100.00",
      });

      const fields = {
        lastMaintenanceDate: D1,
        currentMaintenanceDate: D2,
        lastOdometerKm: "0",
        currentOdometerKm: "100",
        actualCost: "3000000000.00",
      };

      const previewResp = await previewRequest(ownerCookie, fields);
      expect(previewResp.statusCode).toBe(200);
      const preview = previewResp.json<{ preview: PreviewDto }>().preview;
      expect(preview.calculable).toBe(false);
      expect(preview.blockingCodes).toContain("AMOUNT_OUT_OF_RANGE");
      expect(preview.amount).toBeNull();
      expect(preview.rawAmount).toBeNull();
      // intervalKm/officialKm/ratio 仍如實呈現（供使用者核對）。
      expect(preview.intervalKm).toBe("100.00");
      expect(preview.officialKm).toBe("100.00");

      const draftId = await createDraftFull(ownerCookie, fields);
      const draftResp = await getDraft(ownerCookie, draftId);
      expect(draftResp.statusCode).toBe(200);
      const application = draftResp.json<{
        application: { computed: PreviewDto; completionBlockers: { code: string }[] };
      }>().application;
      expect(application.computed.calculable).toBe(false);
      expect(application.computed.blockingCodes).toContain("AMOUNT_OUT_OF_RANGE");
      const blockerCodes = application.completionBlockers.map((b) => b.code);
      expect(blockerCodes).toContain("AMOUNT_OUT_OF_RANGE");
    });

    it("AR 邊界正例：合法大額組合可完成計算（防守門誤殺）", async () => {
      const D1 = "2028-05-01";
      const D2 = "2028-05-31";
      await createTravelRow({
        ownerId,
        status: "COMPLETED",
        primaryDate: "2028-05-15",
        tripDate: "2028-05-15",
        snapshotTotalKm: "100.00",
      });

      const resp = await previewRequest(ownerCookie, {
        lastMaintenanceDate: D1,
        currentMaintenanceDate: D2,
        lastOdometerKm: "0",
        currentOdometerKm: "100",
        actualCost: "2000000000.00",
      });
      expect(resp.statusCode).toBe(200);
      const preview = resp.json<{ preview: PreviewDto }>().preview;
      expect(preview.calculable).toBe(true);
      expect(preview.blockingCodes).not.toContain("AMOUNT_OUT_OF_RANGE");
      expect(preview.amount).toBe(2000000000);
    });
  });

  // ===========================================================================
  // 草稿 DTO computed 之基本行為（既有 T4 空 body → computed=null 相容性）
  // ===========================================================================

  describe("草稿 DTO computed 填充", () => {
    it("空 body 草稿之 computed 仍為 null（五欄未齊，Empty 狀態，非計算失敗）", async () => {
      const createResp = await app.inject({
        method: "POST",
        url: "/applications/maintenance",
        headers: { cookie: ownerCookie },
        payload: {},
      });
      expect(createResp.statusCode).toBe(201);
      const application = createResp.json<{ application: { id: string; computed: unknown } }>()
        .application;
      track(application.id);
      expect(application.computed).toBeNull();
    });

    it("五欄齊備、期間內無官方里程 → computed 為物件，officialKm=0.00，calculable=true", async () => {
      const draftId = await createDraftFull(ownerCookie, {
        lastMaintenanceDate: "2028-06-01",
        currentMaintenanceDate: "2028-06-30",
        lastOdometerKm: "1000",
        currentOdometerKm: "1100",
        actualCost: "500",
      });
      const resp = await getDraft(ownerCookie, draftId);
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: { computed: PreviewDto } }>().application;
      expect(application.computed).not.toBeNull();
      expect(application.computed.calculable).toBe(true);
      expect(application.computed.officialKm).toBe("0.00");
      expect(application.computed.amount).toBe(0);
    });
  });
});
