/**
 * Integration tests for PHASE-004-T7:
 *   POST /applications/travel/preview（stateless 金額預覽）
 *
 * TDD: written to exercise the real HTTP route registered by buildServer().
 * First run (before the route existed) was RED — 404 on the unknown path.
 * See Task Handoff for the captured first-run RED output.
 *
 * AC covered (PHASE-004 Spec §2):
 *   AC-31~36（金額預覽）、AC-45~47（部分：呈現，非完成端點的擋）、
 *   §5 邊界 B-09~B-12、§17.1 D6（草稿/預覽不含單價）、D8（stateless 預覽）。
 *
 * Test discipline (Spec §11.0 / Packet):
 *   - loginName prefix "p4t7_" + per-run random suffix.
 *   - FuelParameterVersion/EtcParameterVersion effectiveFrom 使用本檔專屬的
 *     2031 年區段（Packet 指定範圍），避開 PHASE-003a 既有測試的 2099
 *     sentinel range 與其他 PHASE-004 測試檔使用的 2026/2030 年份，防止撞
 *     `@@unique([effectiveFrom])`（全域唯一鍵，見 Task Handoff 說明）。
 *   - cleanup 限定自建的 FuelParameterVersion/EtcParameterVersion id + 本檔
 *     loginName 前綴；嚴禁 deleteMany({}) 全域刪除。
 *   - synthetic data only。
 */
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";
import { dateBeforeAnyKnownParameterVersion } from "./_param-version-floor-date.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Shared helpers (pattern per phase3a-parameter-fuel-etc.test.ts / phase4-travel-draft.test.ts)
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
const LOGIN_PREFIX = "p4t7_";
const PASSWORD = "TravelPreviewTest99!";

const USER_LOGIN = `${LOGIN_PREFIX}user_${RUN_ID}`;
const MCP_LOGIN = `${LOGIN_PREFIX}mcp_${RUN_ID}`;

// Sentinel effectiveFrom range: 2031-01-01 / 2031-03-01（Packet 指定「本檔專屬
// 年份區段（例如 2031~2032 年）」，避開 003a 的 2099 sentinel 與其他檔案的
// 2026/2030 年份）。
const FUEL_V1_DATE = "2031-01-01"; // unitPrice 5.0000
const FUEL_V2_DATE = "2031-03-01"; // unitPrice 8.0000（AC-45 當日邊界案例）
const ETC_V1_DATE = "2031-01-01"; // unitPrice 2.0000（涵蓋全部查詢日期，只讓 fuel 版本變化）

describeWithDb("PHASE-004-T7 — POST /applications/travel/preview（stateless 金額預覽）", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let userId: string;
  let mcpId: string;
  let userCookie: string;
  let mcpCookie: string;

  let fuelV1Id: string;
  let fuelV2Id: string;
  let etcV1Id: string;

  async function preview(cookie: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/applications/travel/preview",
      headers: { cookie },
      payload,
    });
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);

    const user = await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "P4T7 使用者",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const mcp = await prisma.user.create({
      data: {
        loginName: MCP_LOGIN,
        displayName: "P4T7 待改密使用者",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: true,
      },
    });
    userId = user.id;
    mcpId = mcp.id;

    // createdById 無外鍵（PHASE-003a T1 定案），此處沿用自建使用者 id 即可。
    const fuelV1 = await prisma.fuelParameterVersion.create({
      data: {
        unitPrice: new Prisma.Decimal("5.0000"),
        effectiveFrom: new Date(FUEL_V1_DATE),
        createdById: userId,
      },
    });
    const fuelV2 = await prisma.fuelParameterVersion.create({
      data: {
        unitPrice: new Prisma.Decimal("8.0000"),
        effectiveFrom: new Date(FUEL_V2_DATE),
        createdById: userId,
      },
    });
    const etcV1 = await prisma.etcParameterVersion.create({
      data: {
        unitPrice: new Prisma.Decimal("2.0000"),
        effectiveFrom: new Date(ETC_V1_DATE),
        createdById: userId,
      },
    });
    fuelV1Id = fuelV1.id;
    fuelV2Id = fuelV2.id;
    etcV1Id = etcV1.id;

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    userCookie = await loginUser(app, USER_LOGIN, PASSWORD);
    mcpCookie = await loginUser(app, MCP_LOGIN, PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      const fuelIds = [fuelV1Id, fuelV2Id].filter(Boolean);
      if (fuelIds.length > 0) {
        await prisma.fuelParameterVersion.deleteMany({ where: { id: { in: fuelIds } } });
      }
      const etcIds = [etcV1Id].filter(Boolean);
      if (etcIds.length > 0) {
        await prisma.etcParameterVersion.deleteMany({ where: { id: { in: etcIds } } });
      }
      const userIds = [userId, mcpId].filter(Boolean);
      if (userIds.length > 0) {
        await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      }
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
  });

  // ===========================================================================
  // AC-45 依出差日期取有效版本（含當日）— B-09/B-10/B-11 鑑別力
  // ===========================================================================

  describe("AC-45 — 含當日邊界鑑別力", () => {
    it("tripDate=2031-02-28（v2 前一日）→ 選用 v1（單價 5），parameterAvailable=true", async () => {
      const resp = await preview(userCookie, {
        tripDate: "2031-02-28",
        segments: [{ totalKm: "10", highwayKm: "5" }],
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{
        preview: {
          parameterAvailable: boolean;
          missingParameters: string[];
          segments: { fuelAmount: string; etcAmount: string; rawAmount: string; amount: number }[];
          totalAmount: number;
        };
      }>();
      expect(body.preview.parameterAvailable).toBe(true);
      expect(body.preview.missingParameters).toEqual([]);
      expect(body.preview.segments[0].fuelAmount).toBe("50.0000"); // 10 × 5
      expect(body.preview.segments[0].etcAmount).toBe("10.0000"); // 5 × 2
      expect(body.preview.segments[0].rawAmount).toBe("60.0000");
      expect(body.preview.segments[0].amount).toBe(60);
      expect(body.preview.totalAmount).toBe(60);
    });

    it("tripDate=2031-03-01（v2 生效當日，B-09 含當日）→ 選用 v2（單價 8）", async () => {
      const resp = await preview(userCookie, {
        tripDate: "2031-03-01",
        segments: [{ totalKm: "10", highwayKm: "5" }],
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{
        preview: { segments: { fuelAmount: string; amount: number }[]; totalAmount: number };
      }>();
      expect(body.preview.segments[0].fuelAmount).toBe("80.0000"); // 10 × 8
      expect(body.preview.segments[0].amount).toBe(90); // 80 + 10
      expect(body.preview.totalAmount).toBe(90);
    });

    it("tripDate 早於全域現存所有版本（B-11）→ 查無，missingParameters=['FUEL','ETC']，仍 200", async () => {
      // PHASE-004-R3（機制 B 修復）：不再寫死一個「猜測早於所有版本」的日期
      // （原 "2030-12-31" 假設不成立——`phase3a-parameter-model.test.ts` 建立
      // 的 2026 年版本 <= 2030-12-31，若該檔平行執行中尚未 afterAll 清理，
      // `findEffectiveVersion` 會選中它，parameterAvailable 意外變 true，
      // 詳見 Task Handoff「機制 B 根因與證據」）。改為當場查詢 DB 真實狀態、
      // 動態算出一個保證早於「現存所有」版本的日期——這是對當下事實的驗證，
      // 不是對其他測試檔案日期慣例的假設，不論平行 fork 排程或未來新增測試檔
      // 用什麼年份皆恆成立。
      const tripDate = await dateBeforeAnyKnownParameterVersion(prisma);
      const resp = await preview(userCookie, {
        tripDate,
        segments: [{ totalKm: "10", highwayKm: "5" }],
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{
        preview: {
          parameterAvailable: boolean;
          missingParameters: string[];
          segments: { amount: number }[];
        };
      }>();
      expect(body.preview.parameterAvailable).toBe(false);
      expect(body.preview.missingParameters).toEqual(["FUEL", "ETC"]);
      // 缺參數呈現選擇（見 travel-service.ts formatTravelComputed 文件註解）：
      // 缺少的單價視為 0 計算 —— 此案例 FUEL 與 ETC 皆缺，故金額為 0。
      expect(body.preview.segments[0].amount).toBe(0);
    });
  });

  // ===========================================================================
  // AC-31/32/33 — 單段預覽顯示油資/ETC/取整後金額
  // ===========================================================================

  describe("AC-31/32/33 — 單段預覽欄位", () => {
    it("回傳 { fuelAmount, etcAmount, rawAmount, amount }，amount 為整數", async () => {
      const resp = await preview(userCookie, {
        tripDate: "2031-02-28",
        segments: [{ totalKm: "1", highwayKm: "0" }],
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{
        preview: {
          segments: { fuelAmount: string; etcAmount: string; rawAmount: string; amount: number }[];
        };
      }>();
      const seg = body.preview.segments[0];
      expect(seg.fuelAmount).toBe("5.0000");
      expect(seg.etcAmount).toBe("0.0000");
      expect(seg.rawAmount).toBe("5.0000");
      expect(typeof seg.amount).toBe("number");
      expect(Number.isInteger(seg.amount)).toBe(true);
      expect(seg.amount).toBe(5);
    });
  });

  // ===========================================================================
  // AC-34 — 多段預覽加總各段取整後金額
  // ===========================================================================

  describe("AC-34 — 多段加總", () => {
    it("totalAmount = Σ segments[].amount（先各段取整、再加總）", async () => {
      const resp = await preview(userCookie, {
        tripDate: "2031-02-28",
        segments: [
          { totalKm: "10", highwayKm: "5" }, // amount 60
          { totalKm: "1", highwayKm: "0" }, // amount 5
        ],
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{
        preview: { segments: { amount: number }[]; totalAmount: number; totalKm: string };
      }>();
      expect(body.preview.segments).toHaveLength(2);
      expect(body.preview.segments[0].amount).toBe(60);
      expect(body.preview.segments[1].amount).toBe(5);
      expect(body.preview.totalAmount).toBe(65);
      expect(body.preview.totalKm).toBe("11.00"); // 10 + 1，高速不重複加
    });
  });

  // ===========================================================================
  // AC-36 — 預覽為唯讀（鑑別力：逐表 count 斷言）
  // ===========================================================================

  describe("AC-36 — 預覽唯讀鑑別力", () => {
    it("呼叫預覽前後，該使用者的 Application/TripSegment/Attachment 筆數完全相同", async () => {
      // Scoped to this test's own dedicated user (unique per-run loginName
      // suffix) rather than a global table count — a global count would be
      // flaky under vitest's concurrent test-file execution (other
      // integration suites legitimately create Application/Attachment rows
      // for THEIR OWN users at the same wall-clock time). Scoping to
      // `ownerId = userId` (and TripSegment via its Application's ownerId)
      // still fully catches the real regression this AC guards against: the
      // preview endpoint silently calling createTravelDraft (or anything
      // else that writes a row attributed to the calling user).
      const appCountBefore = await prisma.application.count({ where: { ownerId: userId } });
      const segmentCountBefore = await prisma.tripSegment.count({
        where: { travel: { application: { ownerId: userId } } },
      });
      const attachmentCountBefore = await prisma.attachment.count({ where: { ownerId: userId } });

      const resp = await preview(userCookie, {
        tripDate: "2031-02-28",
        segments: [
          { totalKm: "10", highwayKm: "5" },
          { totalKm: "3", highwayKm: "1" },
        ],
      });
      expect(resp.statusCode).toBe(200);

      const appCountAfter = await prisma.application.count({ where: { ownerId: userId } });
      const segmentCountAfter = await prisma.tripSegment.count({
        where: { travel: { application: { ownerId: userId } } },
      });
      const attachmentCountAfter = await prisma.attachment.count({ where: { ownerId: userId } });

      expect(appCountAfter).toBe(appCountBefore);
      expect(segmentCountAfter).toBe(segmentCountBefore);
      expect(attachmentCountAfter).toBe(attachmentCountBefore);
    });
  });

  // ===========================================================================
  // D6 鑑別力 — 預覽回應絕不含單價欄位
  // ===========================================================================

  describe("D6 — 預覽回應不含單價欄位", () => {
    it("body 逐鍵斷言不含 fuelUnitPrice/etcUnitPrice/fuelParameterVersionId/etcParameterVersionId", async () => {
      const resp = await preview(userCookie, {
        tripDate: "2031-02-28",
        segments: [{ totalKm: "10", highwayKm: "5" }],
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<Record<string, unknown>>();
      const preview_ = body.preview as Record<string, unknown>;
      expect(preview_.fuelUnitPrice).toBeUndefined();
      expect(preview_.etcUnitPrice).toBeUndefined();
      expect(preview_.fuelParameterVersionId).toBeUndefined();
      expect(preview_.etcParameterVersionId).toBeUndefined();
      // 段落層級也不含（防禦性：確保沒有把單價塞進 segments[] 物件）
      const seg = (preview_.segments as Record<string, unknown>[])[0];
      expect(seg.fuelUnitPrice).toBeUndefined();
      expect(seg.etcUnitPrice).toBeUndefined();
      // 全文字串亦不含這些 key 名稱，作為最後防線
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("fuelUnitPrice");
      expect(raw).not.toContain("etcUnitPrice");
      expect(raw).not.toContain("fuelParameterVersionId");
      expect(raw).not.toContain("etcParameterVersionId");
    });
  });

  // ===========================================================================
  // 缺參數呈現 + 三態/邊界輸入
  // ===========================================================================

  describe("缺參數與邊界輸入", () => {
    it("tripDate 缺席（undefined）→ 視為兩者皆缺，仍 200（不查 DB 亦不拋錯）", async () => {
      const resp = await preview(userCookie, {
        segments: [{ totalKm: "10", highwayKm: "5" }],
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{
        preview: { parameterAvailable: boolean; missingParameters: string[] };
      }>();
      expect(body.preview.parameterAvailable).toBe(false);
      expect(body.preview.missingParameters).toEqual(["FUEL", "ETC"]);
    });

    it("tripDate=null（清空）→ 視為兩者皆缺，仍 200", async () => {
      const resp = await preview(userCookie, {
        tripDate: null,
        segments: [{ totalKm: "10", highwayKm: "5" }],
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ preview: { parameterAvailable: boolean } }>();
      expect(body.preview.parameterAvailable).toBe(false);
    });

    it("段落欄位缺席（totalKm/highwayKm 皆未提供）→ 視為 0 計算，不拋錯", async () => {
      const resp = await preview(userCookie, {
        tripDate: "2031-02-28",
        segments: [{}],
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{
        preview: { segments: { fuelAmount: string; etcAmount: string; amount: number }[] };
      }>();
      expect(body.preview.segments[0].fuelAmount).toBe("0.0000");
      expect(body.preview.segments[0].etcAmount).toBe("0.0000");
      expect(body.preview.segments[0].amount).toBe(0);
    });

    it("空 segments 陣列 → 200，totalAmount=0，不拋錯", async () => {
      const resp = await preview(userCookie, { tripDate: "2031-02-28", segments: [] });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ preview: { segments: unknown[]; totalAmount: number } }>();
      expect(body.preview.segments).toEqual([]);
      expect(body.preview.totalAmount).toBe(0);
    });
  });

  // ===========================================================================
  // 里程格式錯誤 → 400
  // ===========================================================================

  describe("里程格式錯誤", () => {
    it("totalKm 超過 2 位小數 → 400 VALIDATION_ERROR，fields 定位到 segments[0].totalKm", async () => {
      const resp = await preview(userCookie, {
        tripDate: "2031-02-28",
        segments: [{ totalKm: "12.345", highwayKm: "5" }],
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{ error: { code: string; fields?: { field: string }[] } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect((body.error.fields ?? []).some((f) => f.field === "segments[0].totalKm")).toBe(true);
    });

    it("segments 非陣列 → 400 VALIDATION_ERROR", async () => {
      const resp = await preview(userCookie, {
        tripDate: "2031-02-28",
        segments: "not-an-array",
      });
      expect(resp.statusCode).toBe(400);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
    });

    it("tripDate 非法值 → 400 VALIDATION_ERROR", async () => {
      const resp = await preview(userCookie, {
        tripDate: "not-a-date",
        segments: [{ totalKm: "1", highwayKm: "0" }],
      });
      expect(resp.statusCode).toBe(400);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ===========================================================================
  // 權限
  // ===========================================================================

  describe("權限", () => {
    it("未登入 → 401 UNAUTHORIZED", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/travel/preview",
        payload: { tripDate: "2031-02-28", segments: [] },
      });
      expect(resp.statusCode).toBe(401);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
    });

    it("強制改密使用者 → 403 PASSWORD_CHANGE_REQUIRED", async () => {
      const resp = await preview(mcpCookie, { tripDate: "2031-02-28", segments: [] });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    });
  });
});
