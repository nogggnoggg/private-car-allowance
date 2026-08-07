/**
 * Integration test: PHASE-005-T6 — 回應白名單、後端權威、錯誤合約與日誌安全
 *
 * TDD: 本檔於 `backend/src/mileage/routes.ts` 的 T6 修復**之前**寫成——
 * AC-19 的「重複 query 鍵 → 400（非 500）」一組首輪預期 RED（修復前 ADMIN
 * 帶重複 `ownerId` 會 500 PrismaClientValidationError，詳見下方測試前的
 * 紅燈實證註解）。
 *
 * 涵蓋（docs/specs/PHASE-005.md）：
 *  - AC-19 後端權威：`totalKm`／`amount` 等偽造欄位（query 或 body）一律被
 *    忽略，回應為後端計算值；統計端點為 GET，不因夾帶欄位而改變輸出或 500。
 *  - AC-19 ／ T6-AR-1：陣列型／重複 query 鍵（`ownerId`／`dateFrom`／
 *    `dateTo`）→ 400 `VALIDATION_ERROR`，絕不 500。
 *  - AC-20 本 Phase 不新增 `ErrorCode`（結構性斷言：`errors.ts` 聯集未擴充、
 *    `src/mileage/**` 內未出現任何非既有聯集成員的錯誤碼字面量）。
 *  - AC-26 回應鍵為封閉白名單（`Object.keys` 全等，200 路徑）。
 *  - AC-34 錯誤格式統一（`{error:{code,message,requestId,fields?}}`，逐鍵）
 *    且日誌不含密碼／token／session cookie／SQL／絕對路徑。
 *
 * 測試紀律（Spec §11.0 / CLAUDE.md）：
 *  - 合成資料；`loginName` 前綴 `p5t6`（與 T4 的 `p5t4`、T5 的 `p5t5` 不同，
 *    互不干擾清理）。
 *  - 清理一律以本套件自建之 id／前綴精確比對；**禁用**全域 `deleteMany({})`。
 *  - 出差日期一律落在本套件專屬年份（2049），與其他測試檔零重疊。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";
import { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p5t6";
const PASSWORD = "MileageContract99!";

const RANGE_FROM = "2049-05-01";
const RANGE_TO = "2049-05-31";
const OWNER_TOTAL = "88.50";

interface MileageSummaryBody {
  totalKm?: unknown;
  applicationCount?: unknown;
  appliedFilters?: { dateFrom?: unknown; dateTo?: unknown; ownerId?: unknown };
  error?: { code?: string; message?: string; requestId?: string; fields?: unknown };
}

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0];
}

// ---------------------------------------------------------------------------
// AC-20 — 結構性斷言：不碰 DB，故置於 describeWithDb 之外，恆執行。
// ---------------------------------------------------------------------------

describe("AC-20 結構性斷言：本 Phase 不新增 ErrorCode", () => {
  const errorsSrc = fs.readFileSync(path.join(__dirname, "../../src/platform/errors.ts"), "utf-8");

  /** `errors.ts` 的 `ErrorCode` 聯集定案成員（PHASE-001~CHORE-002 累積），本
   * Phase（005）Done When 要求聯集**未擴充**——與此陣列不符即紅。 */
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
    "REPORT_GENERATION_FAILED",
  ].sort();

  it("errors.ts ErrorCode union is exactly the known baseline (no new/removed member)", () => {
    // 逐行的行內註解本身可能含有 `;`（如 AC-47); body includes…」），單純找
    // 「第一個 `;`」會提前截斷聯集。真正的聯集終止符是「引號緊接分號」
    // （`"SERVICE_UNAVAILABLE";`）——TS 字面量結尾才會有這個相鄰組合，註解
    // 內的分號前面是括號或文字，不會緊貼引號。
    const unionMatch = /export type ErrorCode =([\s\S]*?";)/.exec(errorsSrc);
    expect(unionMatch, "ErrorCode union declaration not found").toBeTruthy();
    const unionBody = unionMatch?.[1] ?? "";
    // R5-B1（T6 複審 AR-1）：原本以「行首縮排後緊接 `|` 與字面量」為錨定
    // （`^\s*\|\s*"..."`），但同一行追加成員（如 `| "A" | "B";`）時，第二個
    // 起的成員不在行首，會被漏數（假陰性）。改法：先去除行內註解（`//...`），
    // 再不設行首錨定、直接掃全 unionBody 中每一個 `"(A-Z_)"` 字面量——聯集
    // 本體內唯一會出現大寫加底線字串字面量的地方就是成員本身（範例資料如
    // `("FUEL"|"ETC")[]` 在行內註解中，已被去註解移除，不會誤入）。
    const unionBodyNoComments = unionBody.replace(/\/\/.*$/gm, "");
    const members = [...unionBodyNoComments.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
    expect(members).toEqual(KNOWN_ERROR_CODES);
  });

  it("src/mileage/** references only ErrorCode literals from the known baseline", () => {
    const mileageDir = path.join(__dirname, "../../src/mileage");
    const files = fs.readdirSync(mileageDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    const usedCodes = new Set<string>();
    for (const file of files) {
      const content = fs.readFileSync(path.join(mileageDir, file), "utf-8");
      for (const m of content.matchAll(/new AppError\(\s*"([A-Z_]+)"/g)) {
        usedCodes.add(m[1]);
      }
    }
    // R5-B2（T6 複審 AR-2）：本掃描目錄僅 `src/mileage/**`，實際只涵蓋
    // VALIDATION_ERROR（`routes.ts` 兩處字面量）；授權相關的 FORBIDDEN 拋出點
    // 在 `src/applications/application-query.ts`（`resolveOwnerId`，被
    // `routes.ts` 引用執行），不在本掃描目錄內、故不會被此處收集到
    // `usedCodes`。此斷言僅證明「掃描邏輯本身有掃到東西」（非假陰性防呆），
    // 不代表涵蓋 FORBIDDEN。
    expect(usedCodes.size).toBeGreaterThan(0);
    for (const code of usedCodes) {
      expect(KNOWN_ERROR_CODES, `unexpected new ErrorCode literal: ${code}`).toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------
// 端點整合測試
// ---------------------------------------------------------------------------

function buildUrl(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) usp.set(key, value);
  }
  const qs = usp.toString();
  return qs.length > 0 ? `/statistics/mileage?${qs}` : "/statistics/mileage";
}

/** 手刻重複鍵 query string（`URLSearchParams`/`buildUrl` 無法表達同名鍵重複）。 */
function buildUrlWithDuplicateKey(
  baseParams: Record<string, string>,
  dupKey: "ownerId" | "dateFrom" | "dateTo",
  dupValues: [string, string]
): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(baseParams)) {
    if (key === dupKey) continue;
    usp.set(key, value);
  }
  usp.append(dupKey, dupValues[0]);
  usp.append(dupKey, dupValues[1]);
  return `/statistics/mileage?${usp.toString()}`;
}

describeWithDb("PHASE-005-T6 — GET /statistics/mileage 契約：白名單／後端權威／錯誤格式", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let adminId: string;
  let ownerCookie: string;
  let adminCookie: string;

  const createdApplicationIds: string[] = [];

  async function cleanupSyntheticData() {
    if (createdApplicationIds.length > 0) {
      await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
    }
    const candidates = await prisma.user.findMany({
      where: { loginName: { startsWith: LOGIN_PREFIX } },
      select: { id: true, loginName: true },
    });
    const ownUserIds = candidates
      .filter((u) => u.loginName.startsWith(LOGIN_PREFIX))
      .map((u) => u.id);
    if (ownUserIds.length > 0) {
      await prisma.application.deleteMany({ where: { ownerId: { in: ownUserIds } } });
      await prisma.session.deleteMany({ where: { userId: { in: ownUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: ownUserIds } } });
    }
    createdApplicationIds.length = 0;
  }

  async function createUser(
    suffix: string,
    opts: { role?: "USER" | "ADMIN" } = {}
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}${suffix}${RUN_ID}`,
        displayName: `P5T6 ${suffix}`,
        passwordHash: await hashPassword(PASSWORD),
        role: opts.role ?? "USER",
        mustChangePassword: false,
      },
    });
    return user.id;
  }

  async function login(suffix: string): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName: `${LOGIN_PREFIX}${suffix}${RUN_ID}`, password: PASSWORD },
    });
    if (resp.statusCode !== 200) {
      throw new Error(`Login failed for ${suffix}: ${resp.statusCode} ${resp.body}`);
    }
    return extractCookieHeader(resp.headers["set-cookie"]);
  }

  async function createCompletedTravel(opts: {
    ownerId: string;
    tripDate: string;
    segments: Array<{ totalKm: string; highwayKm: string }>;
  }): Promise<void> {
    const snapshot = opts.segments.reduce(
      (acc, seg) => acc.plus(new Prisma.Decimal(seg.totalKm)),
      new Prisma.Decimal("0")
    );
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: opts.ownerId,
        createdById: opts.ownerId,
        primaryDate: new Date(opts.tripDate),
        travel: {
          create: {
            tripDate: new Date(opts.tripDate),
            purpose: "合成測試：契約與錯誤合約",
            snapshotTotalKm: snapshot,
          },
        },
      },
    });
    createdApplicationIds.push(application.id);
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

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    await cleanupSyntheticData();

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "silent" });
    await app.ready();

    ownerId = await createUser("owner");
    adminId = await createUser("admin", { role: "ADMIN" });
    ownerCookie = await login("owner");
    adminCookie = await login("admin");

    await createCompletedTravel({
      ownerId,
      tripDate: "2049-05-10",
      segments: [{ totalKm: OWNER_TOTAL, highwayKm: "0.00" }],
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await cleanupSyntheticData();
      await prisma.$disconnect();
    }
  });

  // -------------------------------------------------------------------------
  // AC-26 — 回應白名單（Object.keys 全等）
  // -------------------------------------------------------------------------

  describe("AC-26 回應白名單（Object.keys 全等，200 路徑）", () => {
    it("top-level body keys are EXACTLY [totalKm, applicationCount, appliedFilters] — no more, no less", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }),
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(
        ["appliedFilters", "applicationCount", "totalKm"].sort()
      );
    });

    it("appliedFilters keys are EXACTLY [dateFrom, dateTo, ownerId]", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }),
        headers: { cookie: ownerCookie },
      });
      const body = resp.json() as MileageSummaryBody;
      expect(Object.keys(body.appliedFilters as object).sort()).toEqual(
        ["dateFrom", "dateTo", "ownerId"].sort()
      );
    });

    it("no leaked sensitive terms in the raw response body (price/amount/purpose/location/displayName/loginName/path)", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }),
        headers: { cookie: ownerCookie },
      });
      const raw = resp.body;
      for (const forbidden of [
        "purpose",
        "amount",
        "unitPrice",
        "displayName",
        "loginName",
        "attachment",
        "合成測試",
      ]) {
        expect(raw).not.toContain(forbidden);
      }
    });
  });

  // -------------------------------------------------------------------------
  // AC-19 — 後端權威：偽造欄位一律忽略
  // -------------------------------------------------------------------------

  describe("AC-19 後端權威：夾帶 totalKm/amount 等欄位一律忽略，統計端點不因此 500", () => {
    it("query string carrying totalKm=999999 and amount=... is ignored — response is the real backend value", async () => {
      const resp = await app.inject({
        method: "GET",
        url: `${buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO })}&totalKm=999999&amount=888888`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as MileageSummaryBody;
      expect(body.totalKm).toBe(OWNER_TOTAL);
      expect(body.totalKm).not.toBe("999999");
      expect(resp.body).not.toContain("888888");
    });

    it("a JSON body carrying totalKm/amount on this GET endpoint is likewise ignored, still 200", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }),
        headers: { cookie: ownerCookie, "content-type": "application/json" },
        payload: { totalKm: "999999", amount: "888888" },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as MileageSummaryBody;
      expect(body.totalKm).toBe(OWNER_TOTAL);
    });
  });

  // -------------------------------------------------------------------------
  // AC-19 / T6-AR-1 — 陣列型／重複 query 鍵 → 400（非 500）
  // -------------------------------------------------------------------------
  //
  // 紅燈實證（修復前，本 Task 開工時人工重現，記錄於 Handoff）：
  //   ADMIN 帶 `?ownerId=x&ownerId=y` → 500
  //   {"error":{"code":"INTERNAL_ERROR", ...}}（PrismaClientValidationError，
  //   log 含 Prisma 查詢結構與檔案絕對路徑）。修復後應為 400 VALIDATION_ERROR。

  describe("AC-19／T6-AR-1 陣列型／重複 query 鍵 → 400 VALIDATION_ERROR，絕不 500", () => {
    it("duplicate ownerId key as ADMIN → 400 (not 500) — the exact bug reported by T4-AR-1", async () => {
      const url = buildUrlWithDuplicateKey({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }, "ownerId", [
        ownerId,
        adminId,
      ]);
      const resp = await app.inject({ method: "GET", url, headers: { cookie: adminCookie } });
      expect(resp.statusCode).toBe(400);
      expect(resp.statusCode).not.toBe(500);
      const body = resp.json() as MileageSummaryBody;
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expect(body.error?.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "ownerId" })])
      );
    });

    it("duplicate ownerId key as USER → 400 (not the silent-403 path, not 500)", async () => {
      const url = buildUrlWithDuplicateKey({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }, "ownerId", [
        ownerId,
        adminId,
      ]);
      const resp = await app.inject({ method: "GET", url, headers: { cookie: ownerCookie } });
      expect(resp.statusCode).toBe(400);
      expect(resp.statusCode).not.toBe(500);
      expect((resp.json() as MileageSummaryBody).error?.code).toBe("VALIDATION_ERROR");
    });

    it("R5-B3: duplicate ownerId key with the SAME value twice (?ownerId=self&ownerId=self) as USER → still 400, not 200 — proves the rejection is about the array shape itself, independent of the ownerId value(s) carried", async () => {
      const url = buildUrlWithDuplicateKey({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }, "ownerId", [
        ownerId,
        ownerId,
      ]);
      const resp = await app.inject({ method: "GET", url, headers: { cookie: ownerCookie } });
      expect(resp.statusCode).toBe(400);
      expect(resp.statusCode).not.toBe(500);
      const body = resp.json() as MileageSummaryBody;
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expect(body.error?.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "ownerId" })])
      );
    });

    it("duplicate dateFrom key → 400 with fields[].field === 'dateFrom', never 500", async () => {
      const url = buildUrlWithDuplicateKey({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }, "dateFrom", [
        "2049-05-01",
        "2049-05-02",
      ]);
      const resp = await app.inject({ method: "GET", url, headers: { cookie: ownerCookie } });
      expect(resp.statusCode).toBe(400);
      expect(resp.statusCode).not.toBe(500);
      const fields = (resp.json() as MileageSummaryBody).error?.fields as Array<{
        field: string;
      }>;
      expect(fields.map((f) => f.field)).toContain("dateFrom");
    });

    it("duplicate dateTo key → 400 with fields[].field === 'dateTo', never 500", async () => {
      const url = buildUrlWithDuplicateKey({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }, "dateTo", [
        "2049-05-01",
        "2049-05-02",
      ]);
      const resp = await app.inject({ method: "GET", url, headers: { cookie: ownerCookie } });
      expect(resp.statusCode).toBe(400);
      expect(resp.statusCode).not.toBe(500);
      const fields = (resp.json() as MileageSummaryBody).error?.fields as Array<{
        field: string;
      }>;
      expect(fields.map((f) => f.field)).toContain("dateTo");
    });

    it("response body for the duplicate-key 400 leaks no application data (Object.keys === ['error'])", async () => {
      const url = buildUrlWithDuplicateKey({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }, "ownerId", [
        ownerId,
        adminId,
      ]);
      const resp = await app.inject({ method: "GET", url, headers: { cookie: adminCookie } });
      const body = resp.json() as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["error"]);
      expect(resp.body).not.toContain(OWNER_TOTAL);
    });
  });

  // -------------------------------------------------------------------------
  // AC-34 — 錯誤格式統一 + 逐鍵斷言
  // -------------------------------------------------------------------------

  describe("AC-34 錯誤格式統一且不外洩（逐鍵）", () => {
    async function expectUnifiedErrorShape(resp: { json: () => unknown }, hasFields: boolean) {
      const body = resp.json() as MileageSummaryBody;
      expect(body.error).toBeDefined();
      const errorObj = body.error as Record<string, unknown>;
      const expectedKeys = hasFields
        ? ["code", "fields", "message", "requestId"]
        : ["code", "message", "requestId"];
      expect(Object.keys(errorObj).sort()).toEqual(expectedKeys.sort());
      expect(typeof errorObj.code).toBe("string");
      expect(typeof errorObj.message).toBe("string");
      expect(typeof errorObj.requestId).toBe("string");
      // 不得含堆疊、SQL、內部路徑。
      const messageStr = JSON.stringify(body);
      expect(messageStr).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // 堆疊行樣式
      expect(messageStr).not.toMatch(/[A-Za-z]:\\\\?[\w\\/. -]+\.ts/); // Windows 絕對路徑
      expect(messageStr).not.toMatch(/\/(home|usr|Users)\/[\w./-]+/); // POSIX 絕對路徑
      expect(messageStr.toUpperCase()).not.toMatch(/\bSELECT\b|\bINSERT\b|\bPRISMA/);
    }

    it("VALIDATION_ERROR (duplicate key) has the unified shape with fields", async () => {
      const url = buildUrlWithDuplicateKey({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }, "ownerId", [
        ownerId,
        adminId,
      ]);
      const resp = await app.inject({ method: "GET", url, headers: { cookie: ownerCookie } });
      await expectUnifiedErrorShape(resp, true);
    });

    it("FORBIDDEN (another owner) has the unified shape without fields", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO, ownerId: adminId }),
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(403);
      await expectUnifiedErrorShape(resp, false);
    });

    it("UNAUTHORIZED (no session) has the unified shape without fields", async () => {
      const resp = await app.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }),
      });
      expect(resp.statusCode).toBe(401);
      await expectUnifiedErrorShape(resp, false);
    });
  });

  // -------------------------------------------------------------------------
  // AC-34 — 日誌安全（logStream 攔截）
  // -------------------------------------------------------------------------

  describe("AC-34 日誌安全：錯誤路徑 log 不含密碼/token/cookie/SQL/絕對路徑", () => {
    let logApp: FastifyInstance;
    let logLines: string[];
    let logOwnerCookie: string;

    beforeAll(async () => {
      if (!DB_URL) return;
      const stream = new Writable({
        write(chunk: Buffer, _enc, done) {
          logLines.push(chunk.toString());
          done();
        },
      });
      logLines = [];
      // R5-B4（T6 複審 AR-4）：本 describe 斷言「log 不含敏感資訊」，其前提是
      // log 確實有輸出可供檢查；若執行環境未設 `LOG_LEVEL`（預設 "info"）
      // 以外的值，測試仍會通過，但一旦環境變數被設為更安靜的層級，log 產出
      // 減少甚至為零，斷言會在「無假警訊」的假象下失去偵測力。顯式傳入
      // `logLevel: "info"` 消除對執行環境 `LOG_LEVEL` 的隱性依賴。
      logApp = await buildServer({ databaseUrl: DB_URL, logStream: stream, logLevel: "info" });
      await logApp.ready();

      const loginResp = await logApp.inject({
        method: "POST",
        url: "/auth/login",
        payload: { loginName: `${LOGIN_PREFIX}owner${RUN_ID}`, password: PASSWORD },
      });
      logOwnerCookie = extractCookieHeader(loginResp.headers["set-cookie"]);
      logLines.length = 0; // 只看本 describe 觸發的錯誤路徑之 log，登入本身的 log 不列入

      // 觸發三種錯誤路徑：陣列型 400、他人 ownerId 403、未登入 401。
      const dupUrl = buildUrlWithDuplicateKey(
        { dateFrom: RANGE_FROM, dateTo: RANGE_TO },
        "ownerId",
        [ownerId, adminId]
      );
      await logApp.inject({ method: "GET", url: dupUrl, headers: { cookie: logOwnerCookie } });
      await logApp.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO, ownerId: adminId }),
        headers: { cookie: logOwnerCookie },
      });
      await logApp.inject({
        method: "GET",
        url: buildUrl({ dateFrom: RANGE_FROM, dateTo: RANGE_TO }),
      });
    });

    afterAll(async () => {
      if (logApp) await logApp.close();
    });

    it("no log line contains the session cookie value", () => {
      const combined = logLines.join("\n");
      const cookieValue = logOwnerCookie.split("=")[1];
      expect(cookieValue.length).toBeGreaterThan(0);
      expect(combined).not.toContain(cookieValue);
    });

    it("no log line contains 'password=' or a bearer token pattern", () => {
      const combined = logLines.join("\n");
      expect(combined.toLowerCase()).not.toContain("password=");
      expect(combined).not.toMatch(/Bearer\s+[\w.-]+/);
    });

    it("no log line contains SQL keywords or Prisma query structure", () => {
      const combined = logLines.join("\n");
      expect(combined.toUpperCase()).not.toMatch(/\bSELECT\b|\bINSERT\b|\bFROM\s+"?\w+"?\s+WHERE/);
      expect(combined).not.toContain("PrismaClientValidationError");
    });

    it("no log line contains a Windows or POSIX absolute source path", () => {
      const combined = logLines.join("\n");
      expect(combined).not.toMatch(/[A-Za-z]:\\\\?[\w\\/. -]+\.ts/);
      expect(combined).not.toMatch(/\/(home|usr|Users)\/[\w./-]+\.ts/);
    });

    it("the 400/403/401 responses are still logged (not silently swallowed)", () => {
      const infoOrWarnLines = logLines
        .map((l) => {
          try {
            return JSON.parse(l.trim()) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((o) => o !== null);
      expect(infoOrWarnLines.length).toBeGreaterThan(0);
    });
  });
});
