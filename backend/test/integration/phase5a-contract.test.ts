/**
 * Integration tests for PHASE-005a-T12 — 錯誤格式統一且不外洩（AC-34）、
 * 不新增未列 ErrorCode（AC-35）。
 *
 * 涵蓋範圍（Task Context Packet「本 Phase 新增之錯誤路徑範圍」逐字列舉）:
 *   - POST/GET /parameters/fuel-price（油價，T3）
 *   - POST/GET /users/:userId/fuel-consumption（油耗，T5）
 *   - GET /me/fuel-consumption（自身唯讀，T6）
 *   - POST /parameters/fuel（舊端點凍結 404，T3b）
 *   - POST /applications/:id/complete（PARAMETER_NOT_AVAILABLE 409 含
 *     details.missing 六碼、FUEL_DATA_CORRUPTED 情境，T7/T8）
 *
 * AC-34（Spec §2 逐字）: Then 所有錯誤回應為
 *   `{ error: { code, message, requestId, fields? } }`；不得含堆疊、DB 結構、
 *   SQL、絕對路徑；日誌不含密碼／token／session cookie／依據備註以外之個資。
 *
 * AC-35（Spec §2 逐字）: Then 錯誤路徑僅使用既有 ErrorCode 聯集
 *   （platform/errors.ts）。以結構性斷言（列舉聯集全等）守門。
 *
 * A-6（PROJECT_STATE T8R 移交義務）: T7R 引入之 `console.error` sanitized
 *   告警**不在 pino logStream 內**——logStream 掃描抓不到 console.error 輸出。
 *   本檔對 console.error 路徑另以 spy 驗證其輸出不含敏感內容（見
 *   `describe("A-6 console.error ...")`），logStream 掃描（下方）明文記載
 *   此為其已知涵蓋邊界，不宣稱涵蓋 console.error。
 *
 * TDD: 本檔於本 Task 開工時，AC-34/AC-35 之守門邏輯（`errors.ts` 聯集、各
 * 端點既有錯誤處理）已由先前 Task（T3~T8R）落地完成——本 Task 純新增測試
 * 覆蓋既有行為，並以「暫改 errors.ts 聯集」證明結構性斷言本身具鑑別力
 * （見 Task Handoff 之 mutant RED 證據；本檔內容不含該暫改，暫改與復原僅
 * 發生於驗證階段，未進入最終 diff）。
 *
 * 測試紀律（Spec §11.0 / §11.2）: 合成資料；`loginName` 前綴 `t12contract_`
 * （與既有測試檔前綴互不重疊）；出差日期與參數生效日落在本套件專屬年份
 * （2079~2081），與其他測試檔零重疊；清理一律以本套件自建 id／前綴精確
 * 比對，禁用全域 `deleteMany({})`。
 */

import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { FuelType, Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "t12contract_";
const PASSWORD = "T12ContractTest99!";
const YEAR = "2079"; // sentinel year, distinct from all other test files' ranges

interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    fields?: unknown;
    details?: unknown;
  };
}

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

/**
 * AC-34 統一形狀斷言：`Object.keys(error)` 與 `hasFields`/`hasDetails` 精確
 * 相符（封閉集合，非子集合），並掃描整份回應 body 之 JSON 字串化文字，
 * 確認不含堆疊行樣式、Windows/POSIX 絕對路徑、SQL 關鍵字。
 */
function expectUnifiedErrorShape(
  body: ErrorBody,
  opts: { hasFields?: boolean; hasDetails?: boolean } = {}
) {
  expect(body.error).toBeDefined();
  const errorObj = body.error as Record<string, unknown>;
  const expectedKeys = ["code", "message", "requestId"];
  if (opts.hasFields) expectedKeys.push("fields");
  if (opts.hasDetails) expectedKeys.push("details");
  expect(Object.keys(errorObj).sort()).toEqual(expectedKeys.sort());
  expect(typeof errorObj.code).toBe("string");
  expect(typeof errorObj.message).toBe("string");
  expect(typeof errorObj.requestId).toBe("string");
  expect((errorObj.requestId as string).length).toBeGreaterThan(0);

  const serialized = JSON.stringify(body);
  expect(serialized).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // 堆疊行樣式
  expect(serialized).not.toMatch(/[A-Za-z]:\\\\?[\w\\/. -]+\.ts/); // Windows 絕對路徑
  expect(serialized).not.toMatch(/\/(home|usr|Users)\/[\w./-]+/); // POSIX 絕對路徑
  expect(serialized.toUpperCase()).not.toMatch(/\bSELECT\b|\bINSERT\b|\bPRISMACLIENT/i);
}

// ---------------------------------------------------------------------------
// AC-35 — 結構性斷言（不碰 DB，恆執行）
// ---------------------------------------------------------------------------

describe("AC-35 不新增 ErrorCode", () => {
  const errorsSrc = fs.readFileSync(path.join(BACKEND_ROOT, "src/platform/errors.ts"), "utf-8");

  /** `errors.ts` 之 `ErrorCode` 聯集定案成員（PHASE-001~PHASE-005a 累積現況，
   * 由本 Task 開工前逐字讀取 `src/platform/errors.ts` 確認）。與此陣列不符
   * 即紅——本 Task Done When「ErrorCode 聯集全等斷言全等全綠」之對象。 */
  const KNOWN_ERROR_CODES = [
    "VALIDATION_ERROR",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "PASSWORD_CHANGE_REQUIRED",
    "NOT_FOUND",
    "UNSUPPORTED_MEDIA_TYPE",
    "PAYLOAD_TOO_LARGE",
    "CONFLICT",
    "TOO_MANY_ATTACHMENTS",
    "PARAMETER_PERIOD_OVERLAP",
    "PARAMETER_NOT_AVAILABLE",
    "INTERNAL_ERROR",
    "SERVICE_UNAVAILABLE",
  ].sort();

  it("errors.ts ErrorCode union equals the known baseline", () => {
    const unionMatch = /export type ErrorCode =([\s\S]*?";)/.exec(errorsSrc);
    expect(unionMatch, "ErrorCode union declaration not found").toBeTruthy();
    const unionBody = unionMatch?.[1] ?? "";
    const unionBodyNoComments = unionBody.replace(/\/\/.*$/gm, "");
    const members = [...unionBodyNoComments.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
    expect(members).toEqual(KNOWN_ERROR_CODES);
  });

  // 本 Phase（PHASE-005a）新增／修改之 src 檔——逐檔掃描 `new AppError("XXX"`
  // 字面量，斷言全部落在既有聯集內。details.missing 之六碼
  // （FUEL_CONSUMPTION/FUEL_PRICE/ETC/FUEL_UNIT_PRICE_OUT_OF_RANGE/
  // FUEL_DATA_CORRUPTED/AMOUNT_OUT_OF_RANGE）非 ErrorCode 字面量（不經
  // `new AppError(` 構造），本掃描規則精準只抓 ErrorCode 之用法，不誤判
  // details 內碼值。
  const PHASE_005A_SRC_FILES = [
    "src/parameters/fuel-price-service.ts",
    "src/parameters/routes.ts",
    "src/users/fuel-consumption-service.ts",
    "src/users/fuel-consumption-routes.ts",
    "src/applications/travel-parameters.ts",
    "src/applications/travel-service.ts",
    "src/applications/completion-blockers.ts",
  ];

  it("PHASE-005a source references only baseline ErrorCode literals", () => {
    const usedCodes = new Set<string>();
    let sawAtLeastOneFile = 0;
    for (const rel of PHASE_005A_SRC_FILES) {
      const abs = path.join(BACKEND_ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      sawAtLeastOneFile++;
      const content = fs.readFileSync(abs, "utf-8");
      for (const m of content.matchAll(/new AppError\(\s*"([A-Z_]+)"/g)) {
        usedCodes.add(m[1]);
      }
    }
    expect(sawAtLeastOneFile).toBeGreaterThan(0);
    expect(usedCodes.size).toBeGreaterThan(0);
    for (const code of usedCodes) {
      expect(KNOWN_ERROR_CODES).toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-34 — 端點錯誤合約（每端點代表性錯誤路徑，逐類至少一例）
// ---------------------------------------------------------------------------

describeWithDb("AC-34/AC-35 — PHASE-005a 新增端點錯誤合約", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const createdUserIds: string[] = [];
  const createdPriceIds: string[] = [];
  const createdConsumptionIds: string[] = [];
  const createdEtcIds: string[] = [];
  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  let adminId: string;
  let adminCookie: string;
  let userId: string;
  let userCookie: string;
  let otherUserId: string;

  async function createUser(labelSuffix: string, role: "ADMIN" | "USER") {
    const loginName = `${LOGIN_PREFIX}${labelSuffix}_${RUN_ID}`;
    const user = await prisma.user.create({
      data: {
        loginName,
        displayName: `T12 ${labelSuffix}`,
        passwordHash: await hashPassword(PASSWORD),
        role,
        isActive: true,
        mustChangePassword: false,
      },
    });
    createdUserIds.push(user.id);
    const cookie = await loginUser(app, loginName, PASSWORD);
    return { id: user.id, cookie };
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    const admin = await createUser("admin", "ADMIN");
    adminId = admin.id;
    adminCookie = admin.cookie;
    const user = await createUser("user", "USER");
    userId = user.id;
    userCookie = user.cookie;
    const other = await createUser("other", "USER");
    otherUserId = other.id;
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
      if (createdConsumptionIds.length > 0) {
        await prisma.userFuelConsumptionVersion.deleteMany({
          where: { id: { in: createdConsumptionIds } },
        });
      }
      if (createdEtcIds.length > 0) {
        await prisma.etcParameterVersion.deleteMany({ where: { id: { in: createdEtcIds } } });
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

  // -------------------------------------------------------------------------
  // POST /parameters/fuel-price
  // -------------------------------------------------------------------------
  describe("POST /parameters/fuel-price", () => {
    it("401 UNAUTHORIZED (no session) — unified shape, no fields", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        payload: { fuelType: "DIESEL", pricePerLiter: "30.0000", effectiveFrom: `${YEAR}-01-01` },
      });
      expect(resp.statusCode).toBe(401);
      expectUnifiedErrorShape(resp.json());
    });

    it("403 FORBIDDEN (non-admin) — unified shape, no fields", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        headers: { cookie: userCookie },
        payload: { fuelType: "DIESEL", pricePerLiter: "30.0000", effectiveFrom: `${YEAR}-01-01` },
      });
      expect(resp.statusCode).toBe(403);
      expectUnifiedErrorShape(resp.json());
    });

    it("400 VALIDATION_ERROR (invalid fuelType enum) — unified shape with fields", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "UNKNOWN_FUEL",
          pricePerLiter: "30.0000",
          effectiveFrom: `${YEAR}-01-02`,
        },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expectUnifiedErrorShape(body, { hasFields: true });
    });

    it("409 PARAMETER_PERIOD_OVERLAP (same fuel type, same effectiveFrom) — unified shape with details", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "GASOLINE_92",
          pricePerLiter: "30.0000",
          effectiveFrom: `${YEAR}-02-01`,
        },
      });
      expect(created.statusCode).toBe(201);
      createdPriceIds.push(created.json<{ version: { id: string } }>().version.id);

      const resp = await app.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "GASOLINE_92",
          pricePerLiter: "31.0000",
          effectiveFrom: `${YEAR}-02-01`,
        },
      });
      expect(resp.statusCode).toBe(409);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("PARAMETER_PERIOD_OVERLAP");
      expectUnifiedErrorShape(body, { hasDetails: true });
    });
  });

  // -------------------------------------------------------------------------
  // GET /parameters/fuel-price
  // -------------------------------------------------------------------------
  describe("GET /parameters/fuel-price", () => {
    it("400 VALIDATION_ERROR (invalid fuelType query) — unified shape with fields", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/parameters/fuel-price?fuelType=NOT_A_FUEL",
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expectUnifiedErrorShape(body, { hasFields: true });
    });

    it("401 UNAUTHORIZED (no session) — unified shape, no fields", async () => {
      const resp = await app.inject({ method: "GET", url: "/parameters/fuel-price" });
      expect(resp.statusCode).toBe(401);
      expectUnifiedErrorShape(resp.json());
    });
  });

  // -------------------------------------------------------------------------
  // POST /parameters/fuel — 舊端點凍結 404（AD-US-11 修訂 / D1(a) / AC-37）
  // -------------------------------------------------------------------------
  describe("POST /parameters/fuel（舊端點已移除，恆 404）", () => {
    it("404 NOT_FOUND for admin — unified shape", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/parameters/fuel",
        headers: { cookie: adminCookie },
        payload: { unitPrice: 3, effectiveFrom: `${YEAR}-01-01` },
      });
      expect(resp.statusCode).toBe(404);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("NOT_FOUND");
      expectUnifiedErrorShape(body);
    });

    it("404 NOT_FOUND for normal user — unified shape", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/parameters/fuel",
        headers: { cookie: userCookie },
        payload: {},
      });
      expect(resp.statusCode).toBe(404);
      expectUnifiedErrorShape(resp.json());
    });

    it("404 NOT_FOUND for unauthenticated — unified shape", async () => {
      const resp = await app.inject({ method: "POST", url: "/parameters/fuel", payload: {} });
      expect(resp.statusCode).toBe(404);
      expectUnifiedErrorShape(resp.json());
    });
  });

  // -------------------------------------------------------------------------
  // POST /users/:userId/fuel-consumption
  // -------------------------------------------------------------------------
  describe("POST /users/:userId/fuel-consumption", () => {
    it("401 UNAUTHORIZED (no session) — unified shape", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/users/${userId}/fuel-consumption`,
        payload: {
          fuelType: "DIESEL",
          kmPerLiter: "10.0000",
          effectiveFrom: `${YEAR}-01-01`,
          basisNote: "n",
        },
      });
      expect(resp.statusCode).toBe(401);
      expectUnifiedErrorShape(resp.json());
    });

    it("403 FORBIDDEN (non-admin) — unified shape", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/users/${otherUserId}/fuel-consumption`,
        headers: { cookie: userCookie },
        payload: {
          fuelType: "DIESEL",
          kmPerLiter: "10.0000",
          effectiveFrom: `${YEAR}-01-01`,
          basisNote: "n",
        },
      });
      expect(resp.statusCode).toBe(403);
      expectUnifiedErrorShape(resp.json());
    });

    it("400 VALIDATION_ERROR (kmPerLiter<=0) — unified shape with fields", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/users/${otherUserId}/fuel-consumption`,
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "DIESEL",
          kmPerLiter: "0",
          effectiveFrom: `${YEAR}-01-01`,
          basisNote: "測試依據",
        },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expectUnifiedErrorShape(body, { hasFields: true });
    });

    it("404 NOT_FOUND (unknown userId) — unified shape", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/users/00000000-0000-0000-0000-000000000000/fuel-consumption",
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "DIESEL",
          kmPerLiter: "10.0000",
          effectiveFrom: `${YEAR}-01-01`,
          basisNote: "測試依據",
        },
      });
      expect(resp.statusCode).toBe(404);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("NOT_FOUND");
      expectUnifiedErrorShape(body);
    });

    it("409 PARAMETER_PERIOD_OVERLAP (same user, same effectiveFrom) — unified shape with details", async () => {
      const created = await app.inject({
        method: "POST",
        url: `/users/${otherUserId}/fuel-consumption`,
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "DIESEL",
          kmPerLiter: "10.0000",
          effectiveFrom: `${YEAR}-03-01`,
          basisNote: "T12 overlap fixture 依據備註",
        },
      });
      expect(created.statusCode).toBe(201);
      createdConsumptionIds.push(created.json<{ version: { id: string } }>().version.id);

      const resp = await app.inject({
        method: "POST",
        url: `/users/${otherUserId}/fuel-consumption`,
        headers: { cookie: adminCookie },
        payload: {
          fuelType: "DIESEL",
          kmPerLiter: "12.0000",
          effectiveFrom: `${YEAR}-03-01`,
          basisNote: "T12 overlap fixture 依據備註 2",
        },
      });
      expect(resp.statusCode).toBe(409);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("PARAMETER_PERIOD_OVERLAP");
      expectUnifiedErrorShape(body, { hasDetails: true });
    });
  });

  // -------------------------------------------------------------------------
  // GET /users/:userId/fuel-consumption
  // -------------------------------------------------------------------------
  describe("GET /users/:userId/fuel-consumption", () => {
    it("404 NOT_FOUND (unknown userId) — unified shape", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/users/00000000-0000-0000-0000-000000000000/fuel-consumption",
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(404);
      expectUnifiedErrorShape(resp.json());
    });

    it("403 FORBIDDEN (non-admin) — unified shape", async () => {
      const resp = await app.inject({
        method: "GET",
        url: `/users/${otherUserId}/fuel-consumption`,
        headers: { cookie: userCookie },
      });
      expect(resp.statusCode).toBe(403);
      expectUnifiedErrorShape(resp.json());
    });
  });

  // -------------------------------------------------------------------------
  // GET /me/fuel-consumption — 唯一錯誤路徑為 401（結構上無 403/404，見
  // src/users/fuel-consumption-routes.ts 檔頭 T6 JSDoc）
  // -------------------------------------------------------------------------
  describe("GET /me/fuel-consumption", () => {
    it("401 UNAUTHORIZED (no session) — unified shape", async () => {
      const resp = await app.inject({ method: "GET", url: "/me/fuel-consumption" });
      expect(resp.statusCode).toBe(401);
      expectUnifiedErrorShape(resp.json());
    });
  });

  // -------------------------------------------------------------------------
  // POST /applications/:id/complete — PARAMETER_NOT_AVAILABLE 409（六碼值域，
  // details.missing）
  // -------------------------------------------------------------------------
  describe("POST /applications/:id/complete — PARAMETER_NOT_AVAILABLE", () => {
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

    async function buildSegment(
      cookie: string,
      ownerIdForAttachments: string,
      id: string,
      tripDate: string
    ) {
      const putSeg = await app.inject({
        method: "PUT",
        url: `/applications/travel/${id}`,
        headers: { cookie },
        payload: {
          segments: [
            {
              origin: "A",
              destination: "B",
              totalKm: "10.00",
              highwayKm: "0.00",
              attachmentIds: [],
            },
          ],
        },
      });
      expect(putSeg.statusCode).toBe(200);
      const segId = putSeg.json<{ application: { segments: { id: string }[] } }>().application
        .segments[0].id;
      const att = await prisma.attachment.create({
        data: {
          status: "LINKED",
          storageKey: `t12contract-synthetic-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
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
      const putMeta = await app.inject({
        method: "PUT",
        url: `/applications/travel/${id}`,
        headers: { cookie },
        payload: { tripDate, purpose: "T12 contract PARAMETER_NOT_AVAILABLE" },
      });
      expect(putMeta.statusCode).toBe(200);
    }

    it("409 PARAMETER_NOT_AVAILABLE (no fuel/etc parameter at all for trip date) — unified shape with details.missing", async () => {
      const id = await createDraft(userCookie);
      await buildSegment(userCookie, userId, id, `${YEAR}-12-01`);

      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/complete`,
        headers: { cookie: userCookie },
      });
      expect(resp.statusCode).toBe(409);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("PARAMETER_NOT_AVAILABLE");
      expectUnifiedErrorShape(body, { hasDetails: true });
      const details = body.error?.details as { missing?: string[]; tripDate?: string | null };
      expect(Array.isArray(details.missing)).toBe(true);
      expect((details.missing as string[]).length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // AC-34 — 日誌安全（logStream 攔截）。範圍限定聲明：本 describe 只驗證
  // pino logStream 之輸出；`console.error`（A-6）另有獨立 describe（見下方），
  // 本掃描明文不涵蓋 console.error。
  // -------------------------------------------------------------------------
  describe("AC-34 日誌安全：logStream 掃描（不含 console.error，見 A-6 獨立驗證）", () => {
    let logApp: FastifyInstance;
    let logLines: string[];
    let logAdminCookie: string;
    const BASIS_NOTE_SENTINEL = `T12-BASIS-NOTE-SENTINEL-${RUN_ID}`;

    beforeAll(async () => {
      if (!DB_URL) return;
      const stream = new Writable({
        write(chunk: Buffer, _enc, done) {
          logLines.push(chunk.toString());
          done();
        },
      });
      logLines = [];
      logApp = await buildServer({ databaseUrl: DB_URL, logStream: stream, logLevel: "info" });
      await logApp.ready();

      const loginResp = await logApp.inject({
        method: "POST",
        url: "/auth/login",
        payload: { loginName: `${LOGIN_PREFIX}admin_${RUN_ID}`, password: PASSWORD },
      });
      logAdminCookie = extractCookieHeader(loginResp.headers["set-cookie"]);
      logLines.length = 0; // 只看本 describe 觸發之錯誤路徑/寫入之 log

      // 觸發代表性錯誤路徑：401/403/400/404/409。
      await logApp.inject({ method: "GET", url: "/parameters/fuel-price" }); // 401
      await logApp.inject({
        method: "POST",
        url: "/parameters/fuel-price",
        headers: { cookie: logAdminCookie },
        payload: { fuelType: "BOGUS", pricePerLiter: "1.0000", effectiveFrom: `${YEAR}-04-01` },
      }); // 400
      await logApp.inject({
        method: "GET",
        url: "/users/00000000-0000-0000-0000-000000000000/fuel-consumption",
        headers: { cookie: logAdminCookie },
      }); // 404
      await logApp.inject({
        method: "POST",
        url: "/parameters/fuel",
        headers: { cookie: logAdminCookie },
        payload: {},
      }); // 404 (frozen)

      // basisNote 寫入操作（成功路徑），確認依據備註內容不入日誌。
      const created = await logApp.inject({
        method: "POST",
        url: `/users/${otherUserId}/fuel-consumption`,
        headers: { cookie: logAdminCookie },
        payload: {
          fuelType: "GASOLINE_95",
          kmPerLiter: "15.0000",
          effectiveFrom: `${YEAR}-05-01`,
          basisNote: BASIS_NOTE_SENTINEL,
        },
      });
      expect(created.statusCode).toBe(201);
      createdConsumptionIds.push(created.json<{ version: { id: string } }>().version.id);

      // 重複同一 effectiveFrom 觸發 409（overlap，同時驗證 basisNote 不外洩於
      // 409 路徑之 log）。
      await logApp.inject({
        method: "POST",
        url: `/users/${otherUserId}/fuel-consumption`,
        headers: { cookie: logAdminCookie },
        payload: {
          fuelType: "GASOLINE_95",
          kmPerLiter: "16.0000",
          effectiveFrom: `${YEAR}-05-01`,
          basisNote: `${BASIS_NOTE_SENTINEL}-second`,
        },
      });
    });

    afterAll(async () => {
      if (logApp) await logApp.close();
    });

    it("no log line contains the session cookie value", () => {
      const combined = logLines.join("\n");
      const cookieValue = logAdminCookie.split("=")[1];
      expect(cookieValue.length).toBeGreaterThan(0);
      expect(combined).not.toContain(cookieValue);
    });

    it("no log line contains 'password=' or a bearer token pattern", () => {
      const combined = logLines.join("\n");
      expect(combined.toLowerCase()).not.toContain("password=");
      expect(combined).not.toMatch(/Bearer\s+[\w.-]+/);
    });

    it("no log line contains SQL keywords or Prisma error class names", () => {
      const combined = logLines.join("\n");
      expect(combined.toUpperCase()).not.toMatch(/\bSELECT\b|\bINSERT\b|\bFROM\s+"?\w+"?\s+WHERE/);
      expect(combined).not.toContain("PrismaClientValidationError");
      expect(combined).not.toContain("PrismaClientUnknownRequestError");
    });

    it("no log line contains a Windows or POSIX absolute source path", () => {
      const combined = logLines.join("\n");
      expect(combined).not.toMatch(/[A-Za-z]:\\\\?[\w\\/. -]+\.ts/);
      expect(combined).not.toMatch(/\/(home|usr|Users)\/[\w./-]+\.ts/);
    });

    it("basisNote content never appears in application logs (success or 409 path alike)", () => {
      const combined = logLines.join("\n");
      expect(combined).not.toContain(BASIS_NOTE_SENTINEL);
    });

    it("the triggered error responses are still logged (not silently swallowed)", () => {
      const parsedLines = logLines
        .map((l) => {
          try {
            return JSON.parse(l.trim()) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((o) => o !== null);
      expect(parsedLines.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // A-6 — console.error 路徑獨立驗證（不在 pino logStream 內，PROJECT_STATE
  // T8R 移交義務）: 觸發 FUEL_DATA_CORRUPTED（deriveFuelUnitPrice 之
  // RangeError，見 src/applications/travel-parameters.ts 該段
  // console.error），以 vi.spyOn 攔截，斷言其輸出只含
  // fuelConsumptionVersionId/fuelPriceVersionId/fuelType/errorName 四鍵，
  // 不含 stack、原始例外 message、basisNote 或任何個資。
  // -------------------------------------------------------------------------
  describe("A-6 console.error 路徑之獨立驗證（logStream 掃描不到 console.error）", () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let corruptOwnerId: string;
    let corruptOwnerCookie: string;

    beforeEach(async () => {
      if (!DB_URL) return;
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const owner = await createUser(`corrupt${Math.random().toString(36).slice(2, 6)}`, "USER");
      corruptOwnerId = owner.id;
      corruptOwnerCookie = owner.cookie;

      // 直接繞過 service 層驗證（僅 route 層把關 >0），模擬既有資料毀損：
      // kmPerLiter=0 → deriveFuelUnitPrice 對此 throw RangeError。
      const consumption = await prisma.userFuelConsumptionVersion.create({
        data: {
          userId: corruptOwnerId,
          fuelType: FuelType.DIESEL,
          kmPerLiter: new Prisma.Decimal("0"),
          effectiveFrom: new Date(`${YEAR}-06-01`),
          basisNote: `T12 A-6 毀損資料防護測試（不得外洩，sentinel ${RUN_ID}）`,
          createdById: corruptOwnerId,
        },
      });
      createdConsumptionIds.push(consumption.id);
      const price = await prisma.fuelPriceVersion.create({
        data: {
          fuelType: FuelType.DIESEL,
          pricePerLiter: new Prisma.Decimal("10.0000"),
          effectiveFrom: new Date(`${YEAR}-06-01`),
          createdById: corruptOwnerId,
        },
      });
      createdPriceIds.push(price.id);
      const etc = await prisma.etcParameterVersion.create({
        data: {
          unitPrice: new Prisma.Decimal("2.0000"),
          effectiveFrom: new Date(`${YEAR}-06-01`),
          createdById: corruptOwnerId,
        },
      });
      createdEtcIds.push(etc.id);
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    it("preview endpoint triggers console.error with sanitized args only (no stack/basisNote/raw message)", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/travel/preview",
        headers: { cookie: corruptOwnerCookie },
        payload: { tripDate: `${YEAR}-06-02`, segments: [{ totalKm: "10.00", highwayKm: "0.00" }] },
      });
      expect(resp.statusCode).toBe(200); // 草稿/預覽可存，僅完成被擋（Q3 裁定）

      expect(consoleErrorSpy).toHaveBeenCalled();
      const allArgs = consoleErrorSpy.mock.calls.flat();
      const serializedArgs = allArgs
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join("\n");

      // 逐鍵白名單驗證：sanitized 物件僅含四鍵（結構性檢查，而非黑名單字串
      // 排除——即使欄位改名或新增，本斷言仍能抓到白名單以外的鍵）。
      const structuredArg = allArgs.find(
        (a) => typeof a === "object" && a !== null && "errorName" in (a as Record<string, unknown>)
      ) as Record<string, unknown> | undefined;
      expect(structuredArg, "sanitized console.error structured payload not found").toBeTruthy();
      expect(Object.keys(structuredArg as Record<string, unknown>).sort()).toEqual(
        ["errorName", "fuelConsumptionVersionId", "fuelPriceVersionId", "fuelType"].sort()
      );

      // 黑名單補強：不得含 basisNote 內容、原生 RangeError message、堆疊行樣式。
      expect(serializedArgs).not.toContain("A-6 毀損資料防護測試");
      expect(serializedArgs).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
      expect(serializedArgs).not.toMatch(/[A-Za-z]:\\\\?[\w\\/. -]+\.ts/);
      expect(serializedArgs).not.toMatch(/\/(home|usr|Users)\/[\w./-]+\.ts/);
    });
  });
});
