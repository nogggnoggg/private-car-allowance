/**
 * Integration tests for PHASE-007-T15 — 錯誤合約＋`ErrorCode` 結構性斷言＋
 * 日誌安全（AC-43/44），沿 PHASE-006-T13（`phase6-contract.test.ts`）之成功
 * 模式，改覆蓋本 Phase（折舊）新增之端點。**純測試 Task，零 src 變更。**
 *
 * 涵蓋範圍（Task Context Packet「錯誤碼盤點」＋ Spec §11.2 逐字列舉之對象）:
 *   - POST/GET/PUT /applications/depreciation(/:id)（T4）
 *   - POST /applications/depreciation/preview（T6）
 *   - POST /applications/:id/complete（DEPRECIATION 分派，T9）
 *   - DELETE /applications/:id（折舊路徑）
 *   - POST /admin/users/:userId/applications/depreciation（T11，管理員代建立）
 *   - GET /applications（折舊列/篩選錯誤路徑，T12）
 *
 * AC-43（Spec §2/§7.6 逐字）: **不新增任何 `ErrorCode`**：`ErrorCode` 聯集與
 *   基線**全等**（BOGUS mutant 必紅）；本 Phase 使用之碼見 §7.6（12 碼，見下方
 *   `KNOWN_ERROR_CODES`）。錯誤回應頂層鍵集合封閉（`code`／`message`／
 *   `fields?`／`details?`）。
 *
 * AC-44（Spec §2 逐字）: 折舊相關路徑之 `logStream` 掃描**不得**出現密碼、
 *   token、session cookie、附件位元組；錯誤回應不外洩堆疊／DB 結構／Prisma
 *   錯誤原文。
 *
 * ── §7.6 頂層鍵集斷言之範圍澄清（AC-43 原文 vs 系統既有基線，Handoff 已列入
 *    Warnings 據實回報）────────────────────────────────────────────────────
 * AC-43 逐字僅列 `code`／`message`／`fields?`／`details?` 四鍵，未提及
 * `requestId`。惟 `backend/src/platform/errors.ts` 檔頭明文「Spec 5.2
 * (authoritative shape): { error: { code, message, requestId, fields? } }」，
 * `error-handler.ts` 之 `buildErrorBody` 對**每一筆**錯誤回應恆寫入
 * `requestId`（PHASE-001 建立、PHASE-003a/004/005a/006 之 contract test
 * 全數比照斷言為必要鍵——`phase6-contract.test.ts` 即為此例）。本檔比照既有
 * 系統基線，將 `requestId` 併入頂層鍵集斷言（`code`／`message`／`requestId`
 * 恆存在，`fields?`／`details?` 依情境）——此為既有系統性文檔缺字，非本檔
 * 自行擴權，亦非發現真實程式缺陷（不觸發 Stop Condition）。
 *
 * FW-1（T12~T14 複審）: 前端 `DepreciationApplicationPage.tsx` 硬相依
 *   `details.blockers[].message`（非 `.code`，見該檔第 299~301 行型別標
 *   `{ blockers?: { message: string }[] }`）——本檔完成端點 400 測試逐一斷言
 *   `details.blockers[]` 內每筆 `.message` 為非空字串，使後端若靜默改形狀
 *   （如把 `message` 改名／移除）本檔必紅。`details.missing`／
 *   `details.applicationYear`（409 `PARAMETER_NOT_AVAILABLE`）之形狀依 Spec
 *   §7.5／§16 D5(a) 明文釘樁；惟複審實查（見 Handoff Warnings）
 *   `DepreciationApplicationPage.tsx`／`TravelApplicationPage.tsx`／
 *   `MaintenanceApplicationPage.tsx` 三檔完成端點錯誤處理**均未**實際讀取
 *   `.details.missing`／`.details.applicationYear`（僅讀 `apiErr.code` 與
 *   `apiErr.message` 兜底）——本檔仍依 Spec 契約釘樁該形狀（非因 FE 依賴），
 *   差異已列入 Handoff Warnings。
 *
 * FW-2（T12~T14 複審）: 文案雙份零守護——`depreciation-blockers.ts` 四則
 *   zh-TW 訊息 ↔ `DepreciationApplicationPage.tsx` 之
 *   `BLOCKING_CODE_MESSAGES` 表，讀兩檔原始碼字面值逐一比對（結構性掃描，
 *   非執行前端程式）。兩檔同屬本 monorepo（非跨 workspace 邊界之技術限制），
 *   可直接讀取比對，故不記為已知限制。
 *
 * FW-3（T12~T14 複審）: BOGUS mutant 涵蓋前端實際依賴之兩碼
 *   `TOO_MANY_ATTACHMENTS`（PUT 附件對帳，AC-23 上限 5）／
 *   `PARAMETER_NOT_AVAILABLE`（完成端點，AC-16/18）——本檔以真實 HTTP 呼叫
 *   觸發兩者，並將其納入「PHASE-007 src 僅用基線字面值」之使用碼集合。
 *
 * T11 即審 FW（T15 段）: 代操作端點（`POST
 *   /admin/users/:userId/applications/depreciation`）之錯誤碼盤點涵蓋
 *   401/403/404/400；本檔**不**新增 `additionalProperties:false`（會使既有
 *   夾帶矩陣測試全紅，Forbidden）。`503 SERVICE_UNAVAILABLE`
 *   為交易衝突重試耗盡之罕見路徑（`depreciation-service.ts` 兩處），無法以
 *   一般整合測試穩定觸發（同 `phase6-contract.test.ts` 慣例不現場觸發），
 *   僅由下方「PHASE-007 src 僅用基線字面值」之靜態掃描涵蓋，記為已知限制。
 *
 * T10 即審 FW（T15 段）: 雙完成敗方固定 **403 非 409**——本檔未涵蓋併發雙完成
 *   情境（該情境已於 `phase7-snapshot-immutability.test.ts` 覆蓋），本檔錯誤
 *   碼盤點不誤列該情境之碼。
 *
 * T9 FW-7: 本 Phase 錯誤碼零新增之確認——下方 `KNOWN_ERROR_CODES` 與
 *   PHASE-006 基線（`phase6-contract.test.ts` 之同名陣列）逐項比對後全等，
 *   §7.6 亦明文「本 Phase 不新增任何 ErrorCode」。
 *
 * A-6 慣例（PHASE-005a）: console.error 不在 pino logStream 內——本檔不涉及
 * console.error 路徑，故不另立獨立 describe。
 *
 * 已知盲點（AR-1，沿用 phase5a-contract 慣例明文記載）: 日誌之絕對路徑正則
 * 對 CJK／容器路徑可能失效——沿慣例即可，PHASE-011 候選，不在本 Task 範圍
 * 內修復。
 *
 * TDD（純測試 Task 語意）: AC-43/AC-44 之守門邏輯（`errors.ts` 聯集、各端點
 * 既有錯誤處理）已由先前 Task（T4~T11）落地完成——本 Task 純新增測試覆蓋既有
 * 行為，並以「暫改 `errors.ts` 聯集／暫改本檔 `KNOWN_ERROR_CODES`」證明結構性
 * 斷言本身具鑑別力（見 Task Handoff 之 mutant RED 證據；本檔內容不含該暫改，
 * 暫改與復原僅發生於驗證階段，未進入最終 diff）。
 *
 * 測試紀律（Spec §11.0/§11.2）: 合成資料；`loginName` 前綴 `t15contract_`
 * （與既有測試檔前綴互不重疊）；折舊年度落在本套件專屬年份（2140~2144，
 * 依 FW「另起 2140+」裁定，與其他 phase7 測試檔之 2009~2099 範圍零重疊）；
 * 清理一律以本套件自建 id／前綴精確比對，禁用全域 `deleteMany({})`。
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
const REPO_ROOT = path.resolve(BACKEND_ROOT, "..");

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "t15contract_";
const PASSWORD = "T15ContractTest99!";
// 本套件專屬年份範圍（2140~2144）——FW「另起 2140+」裁定，避免與其他 phase7
// 測試檔（2009~2099）撞號，且確保該年度天然無有效折舊參數版本（用於觸發
// PARAMETER_NOT_AVAILABLE，不需另建/凍結參數版本）。
const SENTINEL_YEAR_NO_PARAMETER = 2141;

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
 * §7.6 統一形狀斷言：`Object.keys(error)` 與 `hasFields`/`hasDetails` 精確
 * 相符（封閉集合，非子集合）——見檔頭「§7.6 頂層鍵集斷言之範圍澄清」，
 * `requestId` 恆視為必要鍵。並掃描整份回應 body 之 JSON 字串化文字，確認不含
 * 堆疊行樣式、Windows/POSIX 絕對路徑、SQL 關鍵字（AC-43 尾句：「錯誤回應不
 * 外洩堆疊／DB 結構／Prisma 錯誤原文」）。
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
// AC-43 — 結構性斷言（不碰 DB，恆執行）
// ---------------------------------------------------------------------------

describe("AC-43 ErrorCode 聯集全等 + 本 Phase src 僅用基線字面值", () => {
  const errorsSrc = fs.readFileSync(path.join(BACKEND_ROOT, "src/platform/errors.ts"), "utf-8");

  /** `errors.ts` 之 `ErrorCode` 聯集定案成員（PHASE-001~PHASE-007 累積現況，
   * 由本 Task 開工前逐字讀取 `src/platform/errors.ts` 確認——PHASE-007 全程
   * 未新增任何 ErrorCode 成員，§7.6 明文列舉之 12 碼與此陣列全等）。與此陣列
   * 不符即紅——本 Task Done When「ErrorCode 聯集全等（BOGUS mutant 必紅）」
   * 之對象。 */
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

  it("errors.ts ErrorCode union equals the known baseline", () => {
    const unionMatch = /export type ErrorCode =([\s\S]*?";)/.exec(errorsSrc);
    expect(unionMatch, "ErrorCode union declaration not found").toBeTruthy();
    const unionBody = unionMatch?.[1] ?? "";
    const unionBodyNoComments = unionBody.replace(/\/\/.*$/gm, "");
    const members = [...unionBodyNoComments.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
    expect(members).toEqual(KNOWN_ERROR_CODES);
  });

  // 本 Phase（PHASE-007）新增／涉及之 src 檔——逐檔掃描 `new AppError("XXX"`
  // 字面量，斷言全部落在既有聯集內。Blocker 碼（YEAR_REQUIRED 等 §7.5 四碼）
  // 非 ErrorCode 字面量（不經 `new AppError(` 構造，見
  // `depreciation-blockers.ts`），本掃描規則精準只抓 ErrorCode 之用法，不誤判
  // blocker 碼值。含共用路由檔（`routes.ts`／`admin/routes.ts`／
  // `attachment/lifecycle-service.ts`）——沿 `phase6-contract.test.ts` 慣例，
  // 全檔掃描（非僅折舊區塊），因 TOO_MANY_ATTACHMENTS（FW-3）定義於共用附件
  // 生命週期檔，非折舊專屬檔。
  const PHASE_007_SRC_FILES = [
    "src/applications/depreciation-service.ts",
    "src/applications/depreciation-calculation.ts",
    "src/applications/depreciation-blockers.ts",
    "src/applications/depreciation-parameters.ts",
    "src/applications/routes.ts",
    "src/admin/routes.ts",
    "src/attachment/routes.ts",
    "src/attachment/lifecycle-service.ts",
  ];

  it("PHASE-007 source references only baseline ErrorCode literals", () => {
    const usedCodes = new Set<string>();
    let sawAtLeastOneFile = 0;
    for (const rel of PHASE_007_SRC_FILES) {
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
    // FW-3：前端實際依賴之兩碼必須確實出現於本掃描——若掃描檔案清單漏列相關
    // 檔案，此斷言先於 baseline 比對紅燈，及早暴露掃描盲點。
    expect(usedCodes).toContain("PARAMETER_NOT_AVAILABLE");
    expect(usedCodes).toContain("TOO_MANY_ATTACHMENTS");
    for (const code of usedCodes) {
      expect(KNOWN_ERROR_CODES).toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------
// FW-2 — 文案雙份零守護：depreciation-blockers.ts 四則 zh-TW 訊息 ↔
// DepreciationApplicationPage.tsx 之 BLOCKING_CODE_MESSAGES 表，結構性掃描
// 兩檔原始碼字面值（不執行前端程式）。
// ---------------------------------------------------------------------------

describe("FW-2 文案雙份零守護：後端 blocker 訊息 ↔ 前端 BLOCKING_CODE_MESSAGES 表", () => {
  const blockersSrc = fs.readFileSync(
    path.join(BACKEND_ROOT, "src/applications/depreciation-blockers.ts"),
    "utf-8"
  );
  const pageSrc = fs.readFileSync(
    path.join(REPO_ROOT, "frontend/src/pages/DepreciationApplicationPage.tsx"),
    "utf-8"
  );

  /** 逐一從 `depreciation-blockers.ts` 摘出 `code: "XXX", ... message: "..."`
   * 或反序 `message: "...", ... code: "XXX"` 皆不假設順序——改為分別解析
   * 「code → 該區塊內第一個 message」的鄰近配對，與檔案實際寫法（code 先於
   * message，同一物件字面量內）一致。 */
  function extractBackendBlockerMessages(src: string): Record<string, string> {
    const result: Record<string, string> = {};
    const blockRe = /code:\s*"([A-Z_]+)"[\s\S]{0,120}?message:\s*"([^"]+)"/g;
    for (const m of src.matchAll(blockRe)) {
      result[m[1]] = m[2];
    }
    return result;
  }

  function extractFrontendBlockingCodeMessages(src: string): Record<string, string> {
    const tableMatch = /BLOCKING_CODE_MESSAGES[\s\S]*?=\s*\{([\s\S]*?)\n\};/.exec(src);
    expect(tableMatch, "BLOCKING_CODE_MESSAGES table not found in frontend page").toBeTruthy();
    const body = tableMatch?.[1] ?? "";
    const result: Record<string, string> = {};
    for (const m of body.matchAll(/([A-Z_]+):\s*"([^"]+)"/g)) {
      result[m[1]] = m[2];
    }
    return result;
  }

  /**
   * §20.5.2「blocker code 聯集（折舊）」之**修訂後聯集**（公開契約）：
   *   退場 1：`DEPRECIATION_ATTACHMENT_REQUIRED`（AC-54(b)）
   *   新增 3：`ANNUAL_TOTAL_KM_REQUIRED`、`ANNUAL_TOTAL_KM_INVALID`、
   *           `OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM`
   * 順序沿 §20.5.1 之固定順序（1~6）。
   *
   * **本斷言依 Spec 更新，非弱化測試**（§20.5.2 逐字授權）。
   */
  const REVISED_BLOCKER_CODES = [
    "YEAR_REQUIRED",
    "ANNUAL_TOTAL_KM_REQUIRED",
    "ANNUAL_TOTAL_KM_INVALID",
    "PARAMETER_NOT_AVAILABLE",
    "OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM",
    "AMOUNT_OUT_OF_RANGE",
  ];

  // 後端側與前端側拆為兩條（PHASE-007-R7）：R7 只授權後端層，前端文案表之
  // 縮欄／新增屬 **R9／R10**（跨層禁令）。拆條後兩層之紅可各自歸因，不會互相
  // 遮蔽。
  it("後端 blocker code 聯集恰為 §20.5.2 之修訂後六碼（退場 1、新增 3）", () => {
    const backend = extractBackendBlockerMessages(blockersSrc);
    expect(Object.keys(backend).sort()).toEqual([...REVISED_BLOCKER_CODES].sort());
    expect(Object.keys(backend)).not.toContain("DEPRECIATION_ATTACHMENT_REQUIRED");
  });

  it("六則 blocker 訊息之後端字面值與前端字面值逐碼逐字相等（§20.5.2 修訂後聯集）", () => {
    const backend = extractBackendBlockerMessages(blockersSrc);
    const frontend = extractFrontendBlockingCodeMessages(pageSrc);

    const expectedCodes = REVISED_BLOCKER_CODES;
    expect(Object.keys(backend).sort()).toEqual([...expectedCodes].sort());
    expect(Object.keys(frontend).sort()).toEqual([...expectedCodes].sort());
    for (const code of expectedCodes) {
      expect(frontend[code], `message mismatch for ${code}`).toBe(backend[code]);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-43 — 端點錯誤合約（每端點代表性錯誤路徑，逐類至少一例）
// ---------------------------------------------------------------------------

describeWithDb("AC-43 — PHASE-007 折舊端點錯誤合約", () => {
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
        displayName: `T15 ${labelSuffix}`,
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

  /**
   * PHASE-007-R7：`annualTotalKm`（§20.7.1／AC-47）為修訂後之必要申請資料，
   * 完成端點缺之即以第 2 碼 `ANNUAL_TOTAL_KM_REQUIRED` 於 400 拒絕。故需要走到
   * 「結構性全過」之錯誤路徑（例如 409 缺參數）者，須一併帶入該欄。
   */
  async function createDepreciationDraftViaApi(
    cookie: string,
    applicationYear?: number,
    annualTotalKm?: string
  ) {
    const payload: Record<string, unknown> = {};
    if (applicationYear !== undefined) payload.applicationYear = applicationYear;
    if (annualTotalKm !== undefined) payload.annualTotalKm = annualTotalKm;
    const resp = await app.inject({
      method: "POST",
      url: "/applications/depreciation",
      headers: { cookie },
      payload,
    });
    expect(resp.statusCode).toBe(201);
    const id = resp.json<{ application: { id: string } }>().application.id;
    createdApplicationIds.push(id);
    return id;
  }

  function buildMultipartBody(
    filename: string,
    content: Buffer
  ): { body: Buffer; contentType: string } {
    const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
    const CRLF = "\r\n";
    const header = `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`;
    const footer = `${CRLF}--${boundary}--${CRLF}`;
    return {
      body: Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  function makeJpegBytes(size = 64): Buffer {
    // 合成的最小合法 JPEG magic header ＋ padding（非真實影像）。
    const buf = Buffer.alloc(size, 0xaa);
    buf[0] = 0xff;
    buf[1] = 0xd8;
    buf[2] = 0xff;
    return buf;
  }

  async function uploadTemp(cookie: string, filename: string): Promise<string> {
    const { body, contentType } = buildMultipartBody(filename, makeJpegBytes());
    const resp = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { cookie, "content-type": contentType },
      payload: body,
    });
    expect(resp.statusCode).toBe(201);
    const id = resp.json<{ attachment: { id: string } }>().attachment.id;
    createdAttachmentIds.push(id);
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
  // POST /applications/depreciation
  // -------------------------------------------------------------------------
  describe("POST /applications/depreciation", () => {
    it("401 UNAUTHORIZED (no session) — unified shape, no fields", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/depreciation",
        payload: {},
      });
      expect(resp.statusCode).toBe(401);
      expectUnifiedErrorShape(resp.json());
    });

    it("400 VALIDATION_ERROR (non-numeric applicationYear) — unified shape with fields", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/depreciation",
        headers: { cookie: userCookie },
        payload: { applicationYear: "not-a-number" },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expectUnifiedErrorShape(body, { hasFields: true });
    });
  });

  // -------------------------------------------------------------------------
  // GET /applications/depreciation/:id
  // -------------------------------------------------------------------------
  describe("GET /applications/depreciation/:id", () => {
    it("404 NOT_FOUND (unknown id) — unified shape", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/applications/depreciation/00000000-0000-0000-0000-000000000000",
        headers: { cookie: userCookie },
      });
      expect(resp.statusCode).toBe(404);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("NOT_FOUND");
      expectUnifiedErrorShape(body);
    });

    it("403 FORBIDDEN (non-owner, non-admin) — unified shape", async () => {
      const id = await createDepreciationDraftViaApi(userCookie);
      const resp = await app.inject({
        method: "GET",
        url: `/applications/depreciation/${id}`,
        headers: { cookie: otherUserCookie },
      });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("FORBIDDEN");
      expectUnifiedErrorShape(body);
    });
  });

  // -------------------------------------------------------------------------
  // PUT /applications/depreciation/:id
  // -------------------------------------------------------------------------
  describe("PUT /applications/depreciation/:id", () => {
    it("404 NOT_FOUND (unknown id) — unified shape", async () => {
      const resp = await app.inject({
        method: "PUT",
        url: "/applications/depreciation/00000000-0000-0000-0000-000000000000",
        headers: { cookie: userCookie },
        payload: { applicationYear: 2027 },
      });
      expect(resp.statusCode).toBe(404);
      expectUnifiedErrorShape(resp.json());
    });

    it("403 FORBIDDEN (non-owner, non-admin) — unified shape", async () => {
      const id = await createDepreciationDraftViaApi(userCookie);
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/depreciation/${id}`,
        headers: { cookie: otherUserCookie },
        payload: { applicationYear: 2027 },
      });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("FORBIDDEN");
      expectUnifiedErrorShape(body);
    });

    it("400 VALIDATION_ERROR (applicationYear not an integer) — unified shape with fields", async () => {
      const id = await createDepreciationDraftViaApi(userCookie);
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/depreciation/${id}`,
        headers: { cookie: userCookie },
        payload: { applicationYear: 2027.5 },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expectUnifiedErrorShape(body, { hasFields: true });
    });

    // FW-3：前端實際依賴之 TOO_MANY_ATTACHMENTS（AC-23 上限 5）——第 6 張觸發
    // 409，且沿真實 `linkAttachmentTx`／`canLink` 路徑（非重寫上限邏輯）。
    it("409 TOO_MANY_ATTACHMENTS (6th attachment exceeds AC-23 limit of 5) — unified shape, no fields/details", async () => {
      const id = await createDepreciationDraftViaApi(userCookie);
      const five = [
        await uploadTemp(userCookie, "t15-a1.jpg"),
        await uploadTemp(userCookie, "t15-a2.jpg"),
        await uploadTemp(userCookie, "t15-a3.jpg"),
        await uploadTemp(userCookie, "t15-a4.jpg"),
        await uploadTemp(userCookie, "t15-a5.jpg"),
      ];
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/applications/depreciation/${id}`,
            headers: { cookie: userCookie },
            payload: { attachmentIds: five },
          })
        ).statusCode
      ).toBe(200);

      const sixth = await uploadTemp(userCookie, "t15-a6.jpg");
      const resp = await app.inject({
        method: "PUT",
        url: `/applications/depreciation/${id}`,
        headers: { cookie: userCookie },
        payload: { attachmentIds: [...five, sixth] },
      });
      expect(resp.statusCode).toBe(409);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("TOO_MANY_ATTACHMENTS");
      expectUnifiedErrorShape(body);
    });
  });

  // -------------------------------------------------------------------------
  // POST /applications/depreciation/preview
  // -------------------------------------------------------------------------
  describe("POST /applications/depreciation/preview", () => {
    it("400 VALIDATION_ERROR (applicationYear out of range) — unified shape with fields", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/depreciation/preview",
        headers: { cookie: userCookie },
        payload: { applicationYear: 3000 },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expectUnifiedErrorShape(body, { hasFields: true });
    });

    it("401 UNAUTHORIZED (no session) — unified shape", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/depreciation/preview",
        payload: {},
      });
      expect(resp.statusCode).toBe(401);
      expectUnifiedErrorShape(resp.json());
    });

    it("403 FORBIDDEN (non-admin supplies another user's ownerId) — unified shape", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/applications/depreciation/preview",
        headers: { cookie: userCookie },
        payload: { ownerId: otherUserId },
      });
      expect(resp.statusCode).toBe(403);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("FORBIDDEN");
      expectUnifiedErrorShape(body);
    });
  });

  // -------------------------------------------------------------------------
  // POST /applications/:id/complete（DEPRECIATION 分派）
  // -------------------------------------------------------------------------
  describe("POST /applications/:id/complete（DEPRECIATION 分派）", () => {
    it("400 VALIDATION_ERROR (empty draft, all fields missing) — unified shape with fields + details.blockers[].message (FW-1)", async () => {
      const id = await createDepreciationDraftViaApi(userCookie);
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
      // FW-1：前端 `details.blockers[].message` 為硬相依（非 `.code`）——逐筆
      // 釘住 `.message` 為非空字串，後端若靜默改形狀本斷言必紅。
      for (const blocker of details.blockers as Record<string, unknown>[]) {
        expect(typeof blocker.message).toBe("string");
        expect((blocker.message as string).length).toBeGreaterThan(0);
      }
      // §20.5.2（修訂段）：`DEPRECIATION_ATTACHMENT_REQUIRED` 退場（AC-54(b)）、
      // `ANNUAL_TOTAL_KM_REQUIRED` 新增（AC-53(c)）——**依 Spec 更新斷言**。
      const codes = (details.blockers as { code: string }[]).map((b) => b.code).sort();
      expect(codes).toEqual(["ANNUAL_TOTAL_KM_REQUIRED", "YEAR_REQUIRED"].sort());
      expect(codes).not.toContain("DEPRECIATION_ATTACHMENT_REQUIRED");
    });

    it("403 FORBIDDEN (caller is not the owner, §16 D9(a) owner-only — even ADMIN) — unified shape", async () => {
      const id = await createDepreciationDraftViaApi(userCookie);
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

    // FW-3：前端實際依賴之 PARAMETER_NOT_AVAILABLE（AC-16/18）——本套件專屬
    // 年份（2140+）天然無有效折舊參數版本，觸發 §16 D5(a) 之 409 拒絕形狀。
    it("409 PARAMETER_NOT_AVAILABLE (sentinel year has no parameter version) — unified shape with details.missing + details.applicationYear (FW-1, Spec §7.5/§16 D5(a))", async () => {
      const id = await createDepreciationDraftViaApi(
        userCookie,
        SENTINEL_YEAR_NO_PARAMETER,
        "10000.0"
      );
      const attachmentId = await uploadTemp(userCookie, "t15-param.jpg");
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/applications/depreciation/${id}`,
            headers: { cookie: userCookie },
            payload: { attachmentIds: [attachmentId] },
          })
        ).statusCode
      ).toBe(200);

      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/complete`,
        headers: { cookie: userCookie },
      });
      expect(resp.statusCode).toBe(409);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("PARAMETER_NOT_AVAILABLE");
      expectUnifiedErrorShape(body, { hasDetails: true });
      const details = body.error?.details as { missing?: unknown; applicationYear?: unknown };
      expect(Array.isArray(details.missing)).toBe(true);
      expect((details.missing as unknown[]).length).toBeGreaterThan(0);
      expect(details.applicationYear).toBe(SENTINEL_YEAR_NO_PARAMETER);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /applications/:id（折舊路徑）
  // -------------------------------------------------------------------------
  describe("DELETE /applications/:id（折舊路徑）", () => {
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
      const id = await createDepreciationDraftViaApi(userCookie);
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
  // POST /admin/users/:userId/applications/depreciation — 管理員代建立
  // -------------------------------------------------------------------------
  describe("POST /admin/users/:userId/applications/depreciation", () => {
    it("401 UNAUTHORIZED (no session) — unified shape", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/admin/users/${userId}/applications/depreciation`,
        payload: {},
      });
      expect(resp.statusCode).toBe(401);
      expectUnifiedErrorShape(resp.json());
    });

    it("403 FORBIDDEN (non-admin caller) — unified shape", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/admin/users/${otherUserId}/applications/depreciation`,
        headers: { cookie: userCookie },
        payload: {},
      });
      expect(resp.statusCode).toBe(403);
      expectUnifiedErrorShape(resp.json());
    });

    it("404 NOT_FOUND (unknown userId) — unified shape", async () => {
      const resp = await app.inject({
        method: "POST",
        url: "/admin/users/00000000-0000-0000-0000-000000000000/applications/depreciation",
        headers: { cookie: adminCookie },
        payload: {},
      });
      expect(resp.statusCode).toBe(404);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("NOT_FOUND");
      expectUnifiedErrorShape(body);
    });

    it("400 VALIDATION_ERROR (invalid applicationYear) — unified shape with fields", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/admin/users/${otherUserId}/applications/depreciation`,
        headers: { cookie: adminCookie },
        payload: { applicationYear: "not-a-number" },
      });
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expectUnifiedErrorShape(body, { hasFields: true });
    });
  });

  // -------------------------------------------------------------------------
  // GET /applications（折舊篩選）
  // -------------------------------------------------------------------------
  describe("GET /applications（折舊篩選）", () => {
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
  // AC-44 — 日誌安全（logStream 攔截）。六類掃描沿 phase5a-contract／
  // phase6-contract 之既有正則慣例（cookie／password+bearer+secret+hash／
  // SQL+Prisma／絕對路徑／業務敏感內容／不靜默）。第 5 類改以「附件位元組」
  // 為對象（AC-44 原文明列之第四類敏感內容，折舊完成流程涉及真實檔案上傳，
  // 與保養/差旅之 basisNote/actualCost 純數值代理不同，本 Phase 有真實對象可
  // 直接驗證）：合成 JPEG 內嵌一段本套件專屬 ASCII marker，斷言該 marker 不
  // 出現於任何 log 行。
  // -------------------------------------------------------------------------
  describe("AC-44 日誌安全：logStream 六類掃描", () => {
    let logApp: FastifyInstance;
    let logLines: string[];
    let logAdminCookie: string;
    const ATTACHMENT_BYTES_MARKER = `T15-ATTACHMENT-BYTES-MARKER-${RUN_ID}`;

    function makeMarkedJpegBytes(): Buffer {
      const markerBuf = Buffer.from(ATTACHMENT_BYTES_MARKER, "ascii");
      const header = Buffer.from([0xff, 0xd8, 0xff]);
      const padding = Buffer.alloc(32, 0xaa);
      return Buffer.concat([header, markerBuf, padding]);
    }

    function buildMultipartBodyFor(
      filename: string,
      content: Buffer
    ): { body: Buffer; contentType: string } {
      const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
      const CRLF = "\r\n";
      const header = `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`;
      const footer = `${CRLF}--${boundary}--${CRLF}`;
      return {
        body: Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]),
        contentType: `multipart/form-data; boundary=${boundary}`,
      };
    }

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
      await logApp.inject({ method: "GET", url: "/applications/depreciation/nonexistent" }); // 401 (no cookie)
      await logApp.inject({
        method: "POST",
        url: "/applications/depreciation",
        headers: { cookie: logAdminCookie },
        payload: { applicationYear: "not-a-number" },
      }); // 400
      await logApp.inject({
        method: "GET",
        url: "/applications/depreciation/00000000-0000-0000-0000-000000000000",
        headers: { cookie: logAdminCookie },
      }); // 404
      await logApp.inject({
        method: "POST",
        url: "/admin/users/00000000-0000-0000-0000-000000000000/applications/depreciation",
        headers: { cookie: logAdminCookie },
        payload: {},
      }); // 404

      // 建立草稿並上傳含 marker 之附件（成功路徑），確認附件位元組內容不入
      // 日誌（AC-44：「附件位元組」）。
      const created = await logApp.inject({
        method: "POST",
        url: "/applications/depreciation",
        headers: { cookie: logAdminCookie },
        payload: {},
      });
      expect(created.statusCode).toBe(201);
      const createdId = created.json<{ application: { id: string } }>().application.id;
      createdApplicationIds.push(createdId);

      const { body: multipartBody, contentType } = buildMultipartBodyFor(
        "t15-marker.jpg",
        makeMarkedJpegBytes()
      );
      const uploadResp = await logApp.inject({
        method: "POST",
        url: "/attachments",
        headers: { cookie: logAdminCookie, "content-type": contentType },
        payload: multipartBody,
      });
      expect(uploadResp.statusCode).toBe(201);
      const attachmentId = uploadResp.json<{ attachment: { id: string } }>().attachment.id;
      createdAttachmentIds.push(attachmentId);

      const linkResp = await logApp.inject({
        method: "PUT",
        url: `/applications/depreciation/${createdId}`,
        headers: { cookie: logAdminCookie },
        payload: { attachmentIds: [attachmentId] },
      });
      expect(linkResp.statusCode).toBe(200);

      // 對其他使用者之草稿觸發 403（同時驗證 403 路徑之 log 不外洩 marker）。
      const otherLoginResp = await logApp.inject({
        method: "POST",
        url: "/auth/login",
        payload: { loginName: `${LOGIN_PREFIX}other_${RUN_ID}`, password: PASSWORD },
      });
      const otherCookie = extractCookieHeader(otherLoginResp.headers["set-cookie"]);
      await logApp.inject({
        method: "GET",
        url: `/applications/depreciation/${createdId}`,
        headers: { cookie: otherCookie },
      }); // 403

      // TOO_MANY_ATTACHMENTS 409 路徑：已有 5 張再加第 6 張（同時驗證 409 路徑
      // 之 log 不外洩 marker）。
      const draft2 = await logApp.inject({
        method: "POST",
        url: "/applications/depreciation",
        headers: { cookie: logAdminCookie },
        payload: {},
      });
      const draft2Id = draft2.json<{ application: { id: string } }>().application.id;
      createdApplicationIds.push(draft2Id);
      const sixIds: string[] = [];
      for (let i = 0; i < 6; i++) {
        const { body: mb, contentType: ct } = buildMultipartBodyFor(
          `t15-log-${i}.jpg`,
          makeMarkedJpegBytes()
        );
        const up = await logApp.inject({
          method: "POST",
          url: "/attachments",
          headers: { cookie: logAdminCookie, "content-type": ct },
          payload: mb,
        });
        const aid = up.json<{ attachment: { id: string } }>().attachment.id;
        createdAttachmentIds.push(aid);
        sixIds.push(aid);
      }
      await logApp.inject({
        method: "PUT",
        url: `/applications/depreciation/${draft2Id}`,
        headers: { cookie: logAdminCookie },
        payload: { attachmentIds: sixIds },
      }); // 409 TOO_MANY_ATTACHMENTS
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

    it("no log line contains 'password=', a bearer token pattern, 'secret', or 'hash' (word-boundary)", () => {
      const combined = logLines.join("\n");
      expect(combined.toLowerCase()).not.toContain("password=");
      expect(combined).not.toMatch(/Bearer\s+[\w.-]+/);
      expect(combined.toLowerCase()).not.toContain("secret");
      expect(combined).not.toMatch(/\bhash\b/i);
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

    it("attachment byte content (marker) never appears in application logs (success/403/409 paths alike)", () => {
      const combined = logLines.join("\n");
      expect(combined).not.toContain(ATTACHMENT_BYTES_MARKER);
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
