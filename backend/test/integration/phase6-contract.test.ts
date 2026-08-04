/**
 * Integration tests for PHASE-006-T13 — 錯誤合約＋ErrorCode 結構性斷言＋
 * 日誌安全（AC-39/40），沿 PHASE-005a-T12（phase5a-contract.test.ts）之成功
 * 模式，改覆蓋本 Phase（保養）新增之端點。
 *
 * 涵蓋範圍（Task Context Packet「本 Phase 端點清單」逐字列舉）:
 *   - POST/GET/PUT /applications/maintenance(/:id)（T4/T6）
 *   - POST /applications/maintenance/preview（T5）
 *   - POST /applications/:id/complete（MAINTENANCE 分派，T7）
 *   - DELETE /applications/:id（保養路徑）
 *   - POST /admin/users/:userId/applications/maintenance（T9，管理員代建立）
 *   - GET /applications（保養列/篩選錯誤路徑，T9/T10）
 *   - PUT /applications/maintenance/:id 之 attachmentIds 對帳（409 CONFLICT，
 *     代表附件相關保養情境；AC-24 已於他檔覆蓋授權，本檔僅形狀掃描）
 *
 * AC-39（Spec §2 逐字）: `platform/errors.ts` 之 ErrorCode 聯集與現有基線
 *   全等（新增/刪除任一成員必紅）；本 Phase 之 src 檔僅引用基線成員之字面值。
 *
 * AC-40（Spec §2 逐字）: 本 Phase 全部端點之 401/403/400/404/409 路徑回應
 *   形狀統一 `{ error: { code, message, requestId, fields?, details? } }`
 *   （頂層鍵集合封閉）；日誌不含 cookie 值/password=/bearer pattern/SQL 關鍵
 *   字/Prisma 類名/絕對路徑；錯誤仍有日誌（不靜默）。
 *
 * A-6 慣例（PHASE-005a）: console.error 不在 pino logStream 內——本檔不涉及
 * console.error 路徑（本 Phase 無等價於 travel-parameters.ts 之
 * FUEL_DATA_CORRUPTED console.error 分支），故不另立獨立 describe。
 *
 * 已知盲點（AR-1，沿用 phase5a-contract 慣例明文記載）: 日誌之絕對路徑正則
 * 對 CJK／容器路徑可能失效——沿慣例即可，PHASE-011 候選，不在本 Task 範圍
 * 內修復。
 *
 * TDD: 本檔於本 Task 開工時，AC-39/AC-40 之守門邏輯（`errors.ts` 聯集、各
 * 端點既有錯誤處理）已由先前 Task（T4~T12）落地完成——本 Task 純新增測試
 * 覆蓋既有行為，並以「暫改 errors.ts 聯集」證明結構性斷言本身具鑑別力（見
 * Task Handoff 之 mutant RED 證據；本檔內容不含該暫改，暫改與復原僅發生於
 * 驗證階段，未進入最終 diff）。
 *
 * 測試紀律（Spec §11.0 / §11.2）: 合成資料；`loginName` 前綴
 * `t13contract_`（與既有測試檔前綴互不重疊）；保養日期落在本套件專屬年份
 * （2082~2083），與其他測試檔零重疊；清理一律以本套件自建 id／前綴精確
 * 比對，禁用全域 `deleteMany({})`。
 */

import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "t13contract_";
const PASSWORD = "T13ContractTest99!";
const YEAR = "2082"; // sentinel year, distinct from all other test files' ranges

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
 * AC-40 統一形狀斷言：`Object.keys(error)` 與 `hasFields`/`hasDetails` 精確
 * 相符（封閉集合，非子集合），並掃描整份回應 body 之 JSON 字串化文字，確認
 * 不含堆疊行樣式、Windows/POSIX 絕對路徑、SQL 關鍵字。
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
// AC-39 — 結構性斷言（不碰 DB，恆執行）
// ---------------------------------------------------------------------------

describe("AC-39 ErrorCode 聯集全等 + 本 Phase src 僅用基線字面值", () => {
  const errorsSrc = fs.readFileSync(path.join(BACKEND_ROOT, "src/platform/errors.ts"), "utf-8");

  /** `errors.ts` 之 `ErrorCode` 聯集定案成員（PHASE-001~PHASE-006 累積現況，
   * 由本 Task 開工前逐字讀取 `src/platform/errors.ts` 確認——PHASE-006 全程
   * 未新增任何 ErrorCode 成員）。與此陣列不符即紅——本 Task Done When
   * 「ErrorCode 聯集全等（BOGUS mutant 必紅）」之對象。 */
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

  // 本 Phase（PHASE-006）新增／修改之 src 檔——逐檔掃描 `new AppError("XXX"`
  // 字面量，斷言全部落在既有聯集內。Blocker 碼（LAST_MAINTENANCE_DATE_
  // REQUIRED 等 §7.4 十一碼）非 ErrorCode 字面量（不經 `new AppError(`
  // 構造，見 maintenance-blockers.ts），本掃描規則精準只抓 ErrorCode 之
  // 用法，不誤判 blocker 碼值。
  const PHASE_006_SRC_FILES = [
    "src/applications/maintenance-service.ts",
    "src/applications/maintenance-calculation.ts",
    "src/applications/maintenance-blockers.ts",
    "src/applications/trip-validation.ts",
    "src/applications/application-query.ts",
    "src/applications/routes.ts",
    "src/admin/routes.ts",
    "src/attachment/routes.ts",
    "src/attachment/lifecycle-service.ts",
  ];

  it("PHASE-006 source references only baseline ErrorCode literals", () => {
    const usedCodes = new Set<string>();
    let sawAtLeastOneFile = 0;
    for (const rel of PHASE_006_SRC_FILES) {
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
// AC-40 — 端點錯誤合約（每端點代表性錯誤路徑，逐類至少一例）
// ---------------------------------------------------------------------------

describeWithDb("AC-40 — PHASE-006 保養端點錯誤合約", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const createdUserIds: string[] = [];
  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  let adminId: string;
  let adminCookie: string;
  let userId: string;
  let userCookie: string;
  let otherUserId: string;
  let otherUserCookie: string;

  async function createUser(labelSuffix: string, role: "ADMIN" | "USER") {
    const loginName = `${LOGIN_PREFIX}${labelSuffix}_${RUN_ID}`;
    const user = await prisma.user.create({
      data: {
        loginName,
        displayName: `T13 ${labelSuffix}`,
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

  async function createMaintenanceDraftViaApi(cookie: string) {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/maintenance",
      headers: { cookie },
      payload: {},
    });
    expect(resp.statusCode).toBe(201);
    const id = resp.json<{ application: { id: string } }>().application.id;
    createdApplicationIds.push(id);
    return id;
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
    otherUserCookie = other.cookie;
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
  // POST /applications/maintenance
  // -------------------------------------------------------------------------
  describe("POST /applications/maintenance", () => {
    it("401 UNAUTHORIZED (no session) — unified shape, no fields", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/maintenance",
        payload: {},
      });
      expect(resp.statusCode).toBe(401);
      expectUnifiedErrorShape(resp.json());
    });

    it("400 VALIDATION_ERROR (non-numeric actualCost) — unified shape with fields", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/maintenance",
        headers: { cookie: userCookie },
        payload: { actualCost: "not-a-number" },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expectUnifiedErrorShape(body, { hasFields: true });
    });
  });

  // -------------------------------------------------------------------------
  // GET /applications/maintenance/:id
  // -------------------------------------------------------------------------
  describe("GET /applications/maintenance/:id", () => {
    it("404 NOT_FOUND (unknown id) — unified shape", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/applications/maintenance/00000000-0000-0000-0000-000000000000",
        headers: { cookie: userCookie },
      });
      expect(resp.statusCode).toBe(404);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("NOT_FOUND");
      expectUnifiedErrorShape(body);
    });

    it("403 FORBIDDEN (non-owner, non-admin) — unified shape", async () => {
      const id = await createMaintenanceDraftViaApi(userCookie);
      const resp = await app.inject({
        method: "GET",
        url: `/applications/maintenance/${id}`,
        headers: { cookie: otherUserCookie },
      });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("FORBIDDEN");
      expectUnifiedErrorShape(body);
    });
  });

  // -------------------------------------------------------------------------
  // PUT /applications/maintenance/:id
  // -------------------------------------------------------------------------
  describe("PUT /applications/maintenance/:id", () => {
    it("404 NOT_FOUND (unknown id) — unified shape", async () => {
      const resp = await app.inject({
        method: "PUT",
        url: "/applications/maintenance/00000000-0000-0000-0000-000000000000",
        headers: { cookie: userCookie },
        payload: { actualCost: "100.00" },
      });
      expect(resp.statusCode).toBe(404);
      expectUnifiedErrorShape(resp.json());
    });

    it("403 FORBIDDEN (non-owner, non-admin) — unified shape", async () => {
      const id = await createMaintenanceDraftViaApi(userCookie);
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/maintenance/${id}`,
        headers: { cookie: otherUserCookie },
        payload: { actualCost: "100.00" },
      });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("FORBIDDEN");
      expectUnifiedErrorShape(body);
    });

    it("400 VALIDATION_ERROR (lastOdometerKm not a decimal string) — unified shape with fields", async () => {
      const id = await createMaintenanceDraftViaApi(userCookie);
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/maintenance/${id}`,
        headers: { cookie: userCookie },
        payload: { lastOdometerKm: "not-a-decimal" },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expectUnifiedErrorShape(body, { hasFields: true });
    });

    // 附件相關保養情境（代表路徑）——attachmentIds 對帳遇到「非 TEMP」附件
    // （已關聯／已連結他處）觸發 409 CONFLICT（見 maintenance-service.ts
    // `reconcileMaintenanceAttachments`：`attachment.status !== "TEMP"`）。
    it("409 CONFLICT (attachmentIds references a non-TEMP attachment) — unified shape, no fields/details", async () => {
      const id = await createMaintenanceDraftViaApi(userCookie);
      const linkedAttachment = await prisma.attachment.create({
        data: {
          status: "LINKED",
          storageKey: `t13contract-synthetic-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
          mimeType: "image/jpeg",
          byteSize: 123,
          originalFilename: "synthetic.jpg",
          uploaderId: userId,
          ownerId: userId,
          refType: "MAINTENANCE",
          refId: "00000000-0000-0000-0000-000000000000",
          linkedAt: new Date(),
        },
      });
      createdAttachmentIds.push(linkedAttachment.id);

      const resp = await app.inject({
        method: "PUT",
        url: `/applications/maintenance/${id}`,
        headers: { cookie: userCookie },
        payload: { attachmentIds: [linkedAttachment.id] },
      });
      expect(resp.statusCode).toBe(409);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("CONFLICT");
      expectUnifiedErrorShape(body);
    });
  });

  // -------------------------------------------------------------------------
  // POST /applications/maintenance/preview
  // -------------------------------------------------------------------------
  describe("POST /applications/maintenance/preview", () => {
    it("400 VALIDATION_ERROR (currentOdometerKm too many decimal places) — unified shape with fields", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/maintenance/preview",
        headers: { cookie: userCookie },
        payload: { currentOdometerKm: "100.001" },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expectUnifiedErrorShape(body, { hasFields: true });
    });

    it("401 UNAUTHORIZED (no session) — unified shape", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/maintenance/preview",
        payload: {},
      });
      expect(resp.statusCode).toBe(401);
      expectUnifiedErrorShape(resp.json());
    });
  });

  // -------------------------------------------------------------------------
  // POST /applications/:id/complete — MAINTENANCE 分派
  // -------------------------------------------------------------------------
  describe("POST /applications/:id/complete（MAINTENANCE 分派）", () => {
    it("400 VALIDATION_ERROR (empty draft, all fields missing) — unified shape with fields + details.blockers", async () => {
      const id = await createMaintenanceDraftViaApi(userCookie);
      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/complete`,
        headers: { cookie: userCookie },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expectUnifiedErrorShape(body, { hasFields: true, hasDetails: true });
      const details = body.error?.details as { blockers?: unknown[] };
      expect(Array.isArray(details.blockers)).toBe(true);
      expect((details.blockers as unknown[]).length).toBeGreaterThan(0);
    });

    it("403 FORBIDDEN (caller is not the owner, D7(a) owner-only — even ADMIN) — unified shape", async () => {
      const id = await createMaintenanceDraftViaApi(userCookie);
      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/complete`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("FORBIDDEN");
      expectUnifiedErrorShape(body);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /applications/:id（保養路徑）
  // -------------------------------------------------------------------------
  describe("DELETE /applications/:id（保養路徑）", () => {
    it("404 NOT_FOUND (unknown id) — unified shape", async () => {
      const resp = await app.inject({
        method: "DELETE",
        url: "/applications/00000000-0000-0000-0000-000000000000",
        headers: { cookie: userCookie },
      });
      expect(resp.statusCode).toBe(404);
      expectUnifiedErrorShape(resp.json());
    });

    it("403 FORBIDDEN (non-owner, non-admin) — unified shape", async () => {
      const id = await createMaintenanceDraftViaApi(userCookie);
      const resp = await app.inject({
        method: "DELETE",
        url: `/applications/${id}`,
        headers: { cookie: otherUserCookie },
      });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("FORBIDDEN");
      expectUnifiedErrorShape(body);
    });
  });

  // -------------------------------------------------------------------------
  // POST /admin/users/:userId/applications/maintenance — 管理員代建立
  // -------------------------------------------------------------------------
  describe("POST /admin/users/:userId/applications/maintenance", () => {
    it("401 UNAUTHORIZED (no session) — unified shape", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/admin/users/${userId}/applications/maintenance`,
        payload: {},
      });
      expect(resp.statusCode).toBe(401);
      expectUnifiedErrorShape(resp.json());
    });

    it("403 FORBIDDEN (non-admin caller) — unified shape", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/admin/users/${otherUserId}/applications/maintenance`,
        headers: { cookie: userCookie },
        payload: {},
      });
      expect(resp.statusCode).toBe(403);
      expectUnifiedErrorShape(resp.json());
    });

    it("404 NOT_FOUND (unknown userId) — unified shape", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/admin/users/00000000-0000-0000-0000-000000000000/applications/maintenance",
        headers: { cookie: adminCookie },
        payload: {},
      });
      expect(resp.statusCode).toBe(404);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("NOT_FOUND");
      expectUnifiedErrorShape(body);
    });

    it("400 VALIDATION_ERROR (invalid actualCost) — unified shape with fields", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/admin/users/${otherUserId}/applications/maintenance`,
        headers: { cookie: adminCookie },
        payload: { actualCost: "not-a-number" },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expectUnifiedErrorShape(body, { hasFields: true });
    });
  });

  // -------------------------------------------------------------------------
  // GET /applications（保養列/篩選錯誤路徑）
  // -------------------------------------------------------------------------
  describe("GET /applications（保養篩選）", () => {
    it("400 VALIDATION_ERROR (invalid type filter) — unified shape with fields", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/applications?type=BOGUS",
        headers: { cookie: userCookie },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expectUnifiedErrorShape(body, { hasFields: true });
    });

    it("403 FORBIDDEN (non-admin queries another user's ownerId) — unified shape", async () => {
      const resp = await app.inject({
        method: "GET",
        url: `/applications?ownerId=${otherUserId}`,
        headers: { cookie: userCookie },
      });
      expect(resp.statusCode).toBe(403);
      expectUnifiedErrorShape(resp.json());
    });

    it("401 UNAUTHORIZED (no session) — unified shape", async () => {
      const resp = await app.inject({ method: "GET", url: "/applications" });
      expect(resp.statusCode).toBe(401);
      expectUnifiedErrorShape(resp.json());
    });
  });

  // -------------------------------------------------------------------------
  // AC-40 — 日誌安全（logStream 攔截）。六類掃描沿 phase5a-contract 之正則。
  // 保養無 basisNote 欄位（Packet 明文）——代表性敏感值改用 actualCost 之
  // sentinel 數值（本套件專屬、極不可能自然出現於其他任何 log 輸出）。
  // -------------------------------------------------------------------------
  describe("AC-40 日誌安全：logStream 六類掃描", () => {
    let logApp: FastifyInstance;
    let logLines: string[];
    let logAdminCookie: string;
    // Decimal(12,2) 容量內、極不常見之 sentinel 數值——用以驗證業務數值本身
    // 不會逐字出現在非預期的 log 欄位中（比照 phase5a-contract 的
    // BASIS_NOTE_SENTINEL 手法，數值版）。
    const ACTUAL_COST_SENTINEL = "8765432.10";

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
      await logApp.inject({ method: "GET", url: "/applications/maintenance/nonexistent" }); // 401 (no cookie)
      await logApp.inject({
        method: "POST",
        url: "/applications/maintenance",
        headers: { cookie: logAdminCookie },
        payload: { actualCost: "not-a-number" },
      }); // 400
      await logApp.inject({
        method: "GET",
        url: "/applications/maintenance/00000000-0000-0000-0000-000000000000",
        headers: { cookie: logAdminCookie },
      }); // 404
      await logApp.inject({
        method: "POST",
        url: "/admin/users/00000000-0000-0000-0000-000000000000/applications/maintenance",
        headers: { cookie: logAdminCookie },
        payload: {},
      }); // 404

      // 建立含 sentinel actualCost 之草稿（成功路徑），確認業務數值不入日誌。
      const created = await logApp.inject({
        method: "POST",
        url: "/applications/maintenance",
        headers: { cookie: logAdminCookie },
        payload: { actualCost: ACTUAL_COST_SENTINEL },
      });
      expect(created.statusCode).toBe(201);
      const createdId = created.json<{ application: { id: string } }>().application.id;
      createdApplicationIds.push(createdId);

      // 對其他使用者之草稿觸發 403（同時驗證 403 路徑之 log 不外洩 sentinel）。
      const otherLoginResp = await logApp.inject({
        method: "POST",
        url: "/auth/login",
        payload: { loginName: `${LOGIN_PREFIX}other_${RUN_ID}`, password: PASSWORD },
      });
      const otherCookie = extractCookieHeader(otherLoginResp.headers["set-cookie"]);
      await logApp.inject({
        method: "GET",
        url: `/applications/maintenance/${createdId}`,
        headers: { cookie: otherCookie },
      }); // 403

      // CONFLICT 409 路徑：attachmentIds 指向非 TEMP 附件。
      const linkedAttachment = await prisma.attachment.create({
        data: {
          status: "LINKED",
          storageKey: `t13contract-log-${RUN_ID}`,
          mimeType: "image/jpeg",
          byteSize: 123,
          originalFilename: "synthetic.jpg",
          uploaderId: adminId,
          ownerId: adminId,
          refType: "MAINTENANCE",
          refId: "00000000-0000-0000-0000-000000000000",
          linkedAt: new Date(),
        },
      });
      createdAttachmentIds.push(linkedAttachment.id);
      await logApp.inject({
        method: "PUT",
        url: `/applications/maintenance/${createdId}`,
        headers: { cookie: logAdminCookie },
        payload: { attachmentIds: [linkedAttachment.id] },
      }); // 409
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

    it("actualCost sentinel value never appears in application logs (success/403/409 paths alike)", () => {
      const combined = logLines.join("\n");
      expect(combined).not.toContain(ACTUAL_COST_SENTINEL);
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
});
