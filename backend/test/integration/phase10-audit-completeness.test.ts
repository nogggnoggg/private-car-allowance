/**
 * Integration test: PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）
 *
 * 涵蓋（`docs/specs/PHASE-010.md` §2 C 段）：
 *   · **AC-07** 七類事件端到端齊備回歸
 *       (a) 以真實 HTTP 端點逐一觸發 AD-US-14① 之七類事件，每類至少一條，
 *           斷言恰產生對應 `action` 之稽核列且 `actorId`／`targetLabel`／
 *           `createdAt` 齊備；
 *       (b) 每類事件之稽核列皆可經 `GET /admin/audit-logs` 取回並通過 AC-04；
 *       (c) 負向對照（防恆真）：本人自建草稿 → 零新增稽核列。
 *   · **AC-08** 代操作稽核之完整性回歸
 *       (a) 作廢類：管理員代他人作廢／本人作廢兩身分；
 *       (b) 修正版類三向邊界（代他人 → 一條；本人 → 零；管理員對自己 → 零）；
 *       (c) 兩類 `summary` 皆通過 AC-06 扁平化並於列表可讀（作廢原因逐字）。
 *   · **AC-09** 密碼與敏感資料不入稽核之全表回歸
 *       (a) DB 全表 `targetLabel`／`summary` 遞迴掃描；
 *       (b) wire 面（`GET /admin/audit-logs` 完整回應 body）同批掃描；
 *       (c) `USER_PASSWORD_RESET` 之 `summary` 封閉單鍵 `{mustChangePassword:true}`；
 *       (d) `USER_DELETED` 之 `targetId` 為 `null`、`targetLabel` 為刪除前快照。
 *   · **上游 FW-1（T2 即審）**：T2 之 AC-01(d) 三表快照中 `Application` 表全程
 *     為空（該分支恆真）。本檔建立真實申請，於此補一次「呼叫
 *     `GET /admin/audit-logs` 前後 `AuditLog`／`User`／`Application` 三表逐欄
 *     不變」且**三表皆非空**之快照，補齊 AC-01(d) 之實質性。
 *   · **上游 FW-2（T2 即審）／FW-7（T1 即審）**：`changes` 直傳 DB 原值零過濾
 *     ——`summary` 任何欄位原樣上 wire。AC-09(b) 之 **wire 面掃描**是該路徑的
 *     唯一守門，本檔刻意不將其降級為只掃 DB 端（見 AC-09 區塊）。
 *   · **T2 關閉確認 AR-1（措辭面）**：T2 測試檔 :559 之註解「三表確實非空」與
 *     其實際情形不符（`Application` 表在該分支恆空）。**本檔之 FW-1 快照即其
 *     實質補齊**；依 Packet Forbidden，本 Task **不修改** T2 測試檔，僅於此
 *     記載對應關係。
 *
 * ---------------------------------------------------------------------------
 * 本檔之「真實端點」紀律（Spec §11.0 #4／Packet Done When 逐字）
 * ---------------------------------------------------------------------------
 * 「被驗證之狀態」＝**稽核列**。故本檔**零** `prisma.auditLog.create`／raw SQL
 * 直寫：全部 22 列稽核列一律由真實 HTTP 端點產生（下方 `seedAllEvents()` 逐一
 * 標註端點）。此為 Done When 之硬性條件，其機械證據為**全檔零
 * `auditLog.create`／`createMany`／raw SQL 插入**。〔精確射程，勿讀成「`auditLog`
 * 完全不出現」：本檔另有 `cleanupSyntheticData()` 之兩處 `auditLog.deleteMany`
 * （beforeAll 之前置清理，只刪不建、不產生任何被驗證之稽核列），以及各斷言之
 * `findMany`／`count` 讀取。〕
 *
 * **前置狀態**（非被驗證之狀態）之構造沿既有先例：作廢（AC-07(a)⑤）與修正版
 * （AC-08(b)）之前置條件是「一筆 `COMPLETED` 申請」，其構造以
 * `prisma.application.create` 直寫完成快照——與 `phase9-void.test.ts`
 * （`createCompletedTravel`）、`phase9-revision.test.ts`、`phase8-contract.test.ts`
 * 之既有慣例逐字同型。理由：完成流程本身（參數解析／引擎計算／附件齊備）已由
 * PHASE-004／006／007 之測試覆蓋，且完成端點為 owner-only、需另備三型參數與
 * 附件，於本 Task 重跑一次不會增加任何稽核面的鑑別力，只會把預算從「七類 ×
 * 端到端」稀釋掉。**被驗證的事件（作廢／修正版）本身仍是真實端點呼叫。**
 *
 * ---------------------------------------------------------------------------
 * 敏感資料掃描器：兩具、職責分離（AC-09(a)(b)）
 * ---------------------------------------------------------------------------
 * 1. `assertNoSecretLiterals` —— **無任何允許集**。比對的是本次執行**實際使用
 *    過**的祕密字面：四組明文密碼、argon2 雜湊前綴 `$argon2`、兩枚 session
 *    token 原字面。掃描對象為 `AuditLog` **全表全欄**與 wire 面**完整 body**
 *    （含原始 body 字串）。這一具是 AC-09(a)(b) 的主守門。
 * 2. `assertNoSensitiveContent` —— 沿既有 `phase4-on-behalf-audit.test.ts` :109
 *    ／`phase6-on-behalf.test.ts` :110 之**同型遞迴掃描器**（`FORBIDDEN_PATTERNS`
 *    逐字複製），對 `targetLabel`／`summary` 與 wire body 之鍵與字串值逐一比對
 *    通用命名啟發式。
 *
 *    〔**封閉允許集**，誠實揭露〕該啟發式含 `/password/i`，而 Spec 明文要求之
 *    兩個字面本身即含 "password"：`USER_PASSWORD_RESET`（`AuditAction` enum 值，
 *    `schema.prisma` :34）與 `mustChangePassword`（AC-09(c) 明文之封閉單鍵，
 *    `admin/routes.ts` 之 `USER_PASSWORD_RESET` summary）。允許集恰含這**兩個
 *    完整字面**（非子字串、非模式），且其正當性由 AC-09(c) 之 `toEqual` 封閉
 *    斷言承擔——該斷言禁止 `summary` 出現**除 `mustChangePassword` 以外的任何
 *    鍵**（含全部密碼相關鍵），嚴格強於本啟發式對該列所能提供的保護。
 *
 *    兩具掃描器皆自帶鑑別力自證（見「掃描器鑑別力自證」一節）：對合成陽性樣本
 *    必拋，證明「零命中」不是恆真。
 *
 * ---------------------------------------------------------------------------
 * 測試紀律（§11.0／`CLAUDE.md`）
 * ---------------------------------------------------------------------------
 *   · 全程合成資料（虛構人名、地名、出差目的、密碼）；零真實個資／secrets。
 *   · `loginName` 前綴 `p10t3`（**刻意不含 `_`／`%`**，可安全用於 Prisma
 *     `startsWith`＝SQL LIKE）＋ 每次執行之隨機 `RUN_ID`。
 *   · 清理一律以本檔前綴／id 精確比對；**禁用**全域 `deleteMany({})`。
 *   · 參數版本 `effectiveFrom` 一律落在年份 **2053**——實查（本次 grep）全
 *     `backend/test/**` 無第二處以 2053 作 `effectiveFrom`，故三張全域參數表
 *     （`FuelPriceVersion`／`EtcParameterVersion`／`DepreciationParameterVersion`）
 *     之唯一鍵零撞。〔誠實補記：`phase6-maintenance-complete.test.ts` 與
 *     `phase7-depreciation-complete.test.ts` 亦使用 2053 作**申請日期**，那是不同
 *     的表、無唯一鍵，且 INFRA-001 之 per-worker schema ＋ per-file `DELETE`
 *     已使跨檔資料碰撞結構上不可能——年份慣例為前隔離時代之殘留防線，本檔沿用
 *     而不倚賴。〕
 *   · 本檔為**純測試 Task**：`backend/src` 零 diff（Packet Done When 明載）。
 */

import { type AuditAction, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** 刻意不含 `_`／`%`：可安全用於 Prisma `startsWith`（編譯為 SQL LIKE）。 */
const LOGIN_PREFIX = "p10t3";

// ---------------------------------------------------------------------------
// 合成祕密（AC-09(a)：本檔「測試中使用之明文密碼字串」之全集）
// 刻意選用高辨識度、不可能自然出現於任何業務欄位之字面，使「零命中」為有意義
// 之陳述而非因字面過短而恆真。
// ---------------------------------------------------------------------------
const ADMIN_PASSWORD = "Qv7-Marrow-Thistle-9";
const OWNER_PASSWORD = "Wb3-Kestrel-Lantern-8";
/** `POST /admin/users` 之 `temporaryPassword`（四位新帳號共用）。 */
const CREATED_USER_PASSWORD = "Nf5-Cobalt-Verbena-7";
/** `POST /admin/users/:id/reset-password` 之 `temporaryPassword`。 */
const RESET_PASSWORD = "Hs2-Juniper-Falcon-6";
/** argon2 編碼字串之固定前綴（`$argon2id$v=19$...`）。 */
const ARGON2_PREFIX = "$argon2";

// ---------------------------------------------------------------------------
// 合成業務文字（AC-08(c) 之「逐字可見」斷言對象）
// ---------------------------------------------------------------------------
const VOID_REASON_SELF = "合成作廢原因：本人誤植里程數";
const VOID_REASON_ADMIN = "合成作廢原因：管理員代為更正單據";
const BASIS_NOTE_FIRST = "合成依據備註：原廠型錄標示值";
const BASIS_NOTE_SECOND = "合成依據備註：連續三次加油實測平均";
const TRAVEL_PURPOSE = "合成出差目的：北區客戶年度拜訪";
const TRAVEL_PURPOSE_UPDATED = "合成出差目的：北區客戶年度拜訪（代修訂）";
const SELF_TRAVEL_PURPOSE = "合成出差目的：本人自建草稿（負向對照）";

/** 本檔專屬參數年份（與其他 integration 檔零重疊）。 */
const PARAM_YEAR = 2053;

// ---------------------------------------------------------------------------
// 契約常數（與 T2 之 `phase10-audit-query.test.ts` 同源，刻意各自宣告——
// 兩檔互為獨立守門，不共用常數以免一處被改動即雙雙失去鑑別力）
// ---------------------------------------------------------------------------

/** `AuditLogListItemDto` 之封閉鍵集（AC-04(a)，多一鍵必紅）。 */
const ITEM_KEYS = [
  "action",
  "actorDisplayName",
  "changes",
  "createdAt",
  "id",
  "targetDisplayName",
  "targetLabel",
].sort();

/** `AuditLogListResponse` 之封閉鍵集（AC-01(b)）。 */
const RESPONSE_KEYS = ["items", "page", "pageSize", "total"].sort();

// ---------------------------------------------------------------------------
// wire DTO 型別
// ---------------------------------------------------------------------------

interface AuditChangeDto {
  field: string;
  before: string | null;
  after: string | null;
}

interface AuditLogListItemDto {
  id: string;
  action: string;
  createdAt: string;
  actorDisplayName: string;
  targetLabel: string;
  targetDisplayName: string | null;
  changes: AuditChangeDto[];
}

interface AuditLogListBody {
  items: AuditLogListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

interface ApplicationJson {
  id: string;
  status: string;
  ownerId: string;
  createdById: string;
}

// ===========================================================================
// 掃描器（1）：祕密字面遞迴掃描 — 無允許集
// ===========================================================================

/**
 * 遞迴走訪任意 JSON 值的所有 key/value，逐一斷言不含本次執行使用過之任何祕密
 * 字面（明文密碼、`$argon2` 前綴、session token）。
 *
 * 與掃描器（2）刻意分離：這一具比對的是**實際祕密的字面**，不是命名啟發式，
 * 故**沒有任何允許集**——任何一處命中即為真實洩漏。
 */
function assertNoSecretLiterals(value: unknown, path: string, secrets: readonly string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    for (const secret of secrets) {
      expect(
        value.includes(secret),
        `secret literal leaked at ${path}: ${JSON.stringify(secret.slice(0, 12))}…`
      ).toBe(false);
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (value instanceof Date) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecretLiterals(item, `${path}[${i}]`, secrets));
    return;
  }
  if (typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      for (const secret of secrets) {
        expect(key.includes(secret), `secret literal leaked in key at ${path}.${key}`).toBe(false);
      }
      assertNoSecretLiterals(v, `${path}.${key}`, secrets);
    }
  }
}

// ===========================================================================
// 掃描器（2）：通用命名啟發式遞迴掃描 — 同型複製自既有站點
// ===========================================================================

/**
 * 逐字沿 `phase4-on-behalf-audit.test.ts` :109／`phase6-on-behalf.test.ts` :110
 * 之既有 `FORBIDDEN_PATTERNS`（治理限制：不得新增 `test/support` 檔，故沿
 * PHASE-008 T5R 之本地複本先例；`import` 不可行——兩處既有站點皆為 test 檔內
 * 之未匯出區域函式）。
 */
const FORBIDDEN_PATTERNS = [
  /password/i,
  /passwordHash/i,
  /\btoken\b/i,
  /cookie/i,
  /\bhash\b/i,
  /secret/i,
];

/**
 * **封閉允許集**（見檔頭「敏感資料掃描器」之完整理由）：恰兩個**完整字面**。
 * 兩者皆為 Spec／schema 明文要求之識別字，且其內容封閉性另由 AC-09(c) 之
 * `toEqual` 斷言承擔（嚴格強於本啟發式）。
 */
const HEURISTIC_ALLOWED_LITERALS = new Set(["mustChangePassword", "USER_PASSWORD_RESET"]);

function assertNoSensitiveContent(
  value: unknown,
  path: string,
  allowed: ReadonlySet<string> = new Set()
): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (allowed.has(value)) return;
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(value, `value at ${path} matched forbidden pattern ${pattern}`).not.toMatch(pattern);
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (value instanceof Date) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSensitiveContent(item, `${path}[${i}]`, allowed));
    return;
  }
  if (typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (!allowed.has(key)) {
        for (const pattern of FORBIDDEN_PATTERNS) {
          expect(key, `key at ${path}.${key} matched forbidden pattern ${pattern}`).not.toMatch(
            pattern
          );
        }
      }
      assertNoSensitiveContent(v, `${path}.${key}`, allowed);
    }
  }
}

// ===========================================================================
// 事件矩陣型別（AC-07(a) 之七類 × 逐格）
// ===========================================================================

interface EventCase {
  /** 人類可讀之格標籤（失敗訊息用）。 */
  label: string;
  action: AuditAction;
  /** 觸發之真實端點（記載用，非斷言）。 */
  endpoint: string;
  /** 本格預期之稽核列數（恰等於，非「至少」）。 */
  expectedCount: number;
  expectedActorId: string;
  expectedTargetId: string | null;
  expectedTargetLabel: string;
}

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0];
}

// ===========================================================================

describeWithDb("PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  // ── 引導用身分（直寫；**非**被驗證之稽核事件）───────────────────────────
  let adminId: string;
  let adminLogin: string;
  let ownerId: string;
  let ownerLogin: string;
  let adminCookie: string;
  let ownerCookie: string;
  /** session token 原字面（AC-09(a) 之掃描對象）。 */
  const sessionTokens: string[] = [];

  // ── 經真實端點建立之帳號（AC-07(a)①~③、AD-US-04③）──────────────────────
  interface CreatedUser {
    id: string;
    loginName: string;
  }
  let uCreated: CreatedUser;
  let uToggle: CreatedUser;
  let uReset: CreatedUser;
  let uDeleted: CreatedUser;

  // ── 參數版本 id（AC-07(a)⑥）───────────────────────────────────────────
  let fuelPriceVersionId: string;
  let etcVersionId: string;
  let depreciationVersionId: string;

  // ── 代操作草稿 id（AC-07(a)④）─────────────────────────────────────────
  let onBehalfTravelId: string;
  let onBehalfMaintenanceId: string;
  let onBehalfDepreciationId: string;

  // ── 作廢／修正版（AC-07(a)⑤、AC-08）───────────────────────────────────
  let voidedBySelfId: string;
  let voidedByAdminId: string;
  let revisionSourceOnBehalfId: string;
  let revisionOnBehalfNewId: string;
  let revisionSourceSelfId: string;
  let revisionSourceAdminOwnId: string;

  let voidedBySelfAt: string;
  let voidedByAdminAt: string;

  // ── 負向對照之量測（AC-07(c)／AC-08(b)）────────────────────────────────
  /** 本人自建＋自改三型草稿之稽核列 delta（AC-07(c)：必為 0）。 */
  let selfDraftAuditDelta = -1;
  /** 管理員經代操作端點對「自己」建立草稿之 delta（C3 邊界：必為 0）。 */
  let adminSelfDraftAuditDelta = -1;
  /** 管理員代他人建修正版之 delta（AC-08(b)：必為 1）。 */
  let revisionOnBehalfDelta = -1;
  /** 本人建修正版之 delta（AC-08(b)：必為 0）。 */
  let revisionSelfDelta = -1;
  /** 管理員對自己申請建修正版之 delta（AC-08(b) 三向第三格：必為 0）。 */
  let revisionAdminOwnDelta = -1;
  /** 本人自建之草稿 id（用於「無任何稽核列指涉之」之補強斷言）。 */
  const selfCreatedApplicationIds: string[] = [];

  /** AC-07(a) 之逐格矩陣（`beforeAll` 播種完成後組裝）。 */
  let eventMatrix: EventCase[] = [];

  /** 本次執行使用過之全部祕密字面（AC-09(a)）。 */
  let SECRETS: string[] = [];

  /**
   * 全表預期 action 分佈（AC-07(a) 之「恰產生」＋零額外稽核列之封閉守門）。
   * 任一端點多寫或少寫一列，此表即紅。
   */
  const EXPECTED_ACTION_COUNTS: Record<AuditAction, number> = {
    USER_CREATED: 4,
    USER_DEACTIVATED: 1,
    USER_ACTIVATED: 1,
    USER_PASSWORD_RESET: 1,
    USER_DELETED: 1,
    PARAMETER_VERSION_CREATED: 3,
    APPLICATION_CREATED_ON_BEHALF: 4, // 三型代建草稿 3 ＋ 代建修正版 1
    APPLICATION_UPDATED_ON_BEHALF: 3,
    USER_FUEL_CONSUMPTION_VERSION_CREATED: 2,
    APPLICATION_VOIDED: 2,
  };
  const EXPECTED_TOTAL_ROWS = Object.values(EXPECTED_ACTION_COUNTS).reduce((a, b) => a + b, 0);

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  async function cleanupSyntheticData(): Promise<void> {
    const own = await prisma.user.findMany({
      where: { loginName: { startsWith: LOGIN_PREFIX } },
      select: { id: true },
    });
    const ids = own.map((u) => u.id);
    if (ids.length === 0) return;
    // `AuditLog.actorId` 為 `ON DELETE RESTRICT`：稽核列必須先於使用者刪除。
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { targetId: { in: ids } } });
    // `Application.supersedesId` 為 `ON DELETE RESTRICT`：先解除版本關聯。
    await prisma.application.updateMany({
      where: { ownerId: { in: ids } },
      data: { supersedesId: null },
    });
    await prisma.application.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.application.deleteMany({ where: { createdById: { in: ids } } });
    await prisma.userFuelConsumptionVersion.deleteMany({ where: { userId: { in: ids } } });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  /** 引導身分：直寫（非稽核事件；沿 T2 `createUser` 慣例）。 */
  async function bootstrapUser(
    suffix: string,
    role: "USER" | "ADMIN",
    password: string
  ): Promise<{ id: string; loginName: string }> {
    const loginName = `${LOGIN_PREFIX}${suffix}${RUN_ID}`;
    const user = await prisma.user.create({
      data: {
        loginName,
        displayName: `P10T3 ${suffix}`,
        passwordHash: await hashPassword(password),
        role,
        isActive: true,
        mustChangePassword: false,
      },
    });
    return { id: user.id, loginName };
  }

  async function login(loginName: string, password: string): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName, password },
    });
    if (resp.statusCode !== 200) {
      throw new Error(`Login failed for ${loginName}: ${resp.statusCode} ${resp.body}`);
    }
    const cookie = extractCookieHeader(resp.headers["set-cookie"]);
    // session token 原字面（`name=value` 之 value 部分）——AC-09(a) 掃描對象。
    const rawToken = cookie.slice(cookie.indexOf("=") + 1);
    if (rawToken.length < 16) {
      throw new Error(`Unexpected session cookie shape for ${loginName}`);
    }
    sessionTokens.push(rawToken);
    return cookie;
  }

  /** 送出請求並在非預期狀態碼時立刻拋（避免斷言誤讀「零稽核列」）。 */
  async function callOk(
    method: "POST" | "PUT" | "DELETE",
    url: string,
    cookie: string,
    payload?: Record<string, unknown>,
    expectedStatus = 201
  ): Promise<Record<string, unknown>> {
    const resp = await app.inject({
      method,
      url,
      headers: { cookie },
      ...(payload !== undefined ? { payload } : {}),
    });
    if (resp.statusCode !== expectedStatus) {
      throw new Error(
        `${method} ${url} → ${resp.statusCode} (expected ${expectedStatus}): ${resp.body}`
      );
    }
    return resp.json() as Record<string, unknown>;
  }

  async function auditCount(): Promise<number> {
    return prisma.auditLog.count();
  }

  /** 直寫一筆已完成差旅申請（**前置狀態**，非被驗證之稽核狀態——見檔頭）。 */
  async function createCompletedTravel(owner: string, suffix: string): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: owner,
        createdById: owner,
        primaryDate: new Date(`${PARAM_YEAR}-05-12T00:00:00.000Z`),
        totalAmount: 1500,
        completedAt: new Date(`${PARAM_YEAR}-05-12T08:00:00.000Z`),
        travel: {
          create: {
            tripDate: new Date(`${PARAM_YEAR}-05-12T00:00:00.000Z`),
            purpose: `合成出差目的：完成快照前置-${suffix}`,
            fuelUnitPrice: "2.3456",
            etcUnitPrice: "1.2345",
            fuelParameterVersionId: `p10t3-fpv-${suffix}`,
            etcParameterVersionId: `p10t3-epv-${suffix}`,
            snapshotTotalKm: "240.75",
            snapshotRawAmount: "1500.0000",
            calculatedAt: new Date(`${PARAM_YEAR}-05-12T08:00:00.000Z`),
            snapshotFuelType: "GASOLINE_95",
            snapshotFuelPricePerLiter: "31.5000",
            snapshotFuelConsumption: "12.5000",
            fuelPriceVersionId: `p10t3-fpricev-${suffix}`,
            fuelConsumptionVersionId: `p10t3-fcv-${suffix}`,
            segments: {
              create: [
                {
                  sortOrder: 0,
                  origin: "合成起點甲",
                  destination: "合成迄點乙",
                  totalKm: "140.50",
                  highwayKm: "100.00",
                  snapshotFuelAmount: "540.0000",
                  snapshotEtcAmount: "160.0000",
                  snapshotRawAmount: "700.0000",
                  snapshotAmount: 700,
                },
                {
                  sortOrder: 1,
                  origin: "合成起點乙",
                  destination: "合成迄點丙",
                  totalKm: "100.25",
                  highwayKm: "80.00",
                  snapshotFuelAmount: "620.0000",
                  snapshotEtcAmount: "180.0000",
                  snapshotRawAmount: "800.0000",
                  snapshotAmount: 800,
                },
              ],
            },
          },
        },
      },
    });
    return created.id;
  }

  /**
   * 以真實 HTTP 端點播種七類事件（**唯一**之稽核列來源）。
   * 每一步之註解逐字標明其對應之 AC-07(a) 小項與端點。
   */
  async function seedAllEvents(): Promise<void> {
    // ── ① 新增帳號 → USER_CREATED（POST /admin/users）× 4 ─────────────────
    async function createUserViaEndpoint(suffix: string): Promise<CreatedUser> {
      const loginName = `${LOGIN_PREFIX}${suffix}${RUN_ID}`;
      const body = await callOk("POST", "/admin/users", adminCookie, {
        loginName,
        displayName: `P10T3 ${suffix}`,
        employeeNumber: `EMP-${suffix}`,
        temporaryPassword: CREATED_USER_PASSWORD,
      });
      const user = (body as { user: { id: string } }).user;
      return { id: user.id, loginName };
    }
    uCreated = await createUserViaEndpoint("new");
    uToggle = await createUserViaEndpoint("tog");
    uReset = await createUserViaEndpoint("rst");
    uDeleted = await createUserViaEndpoint("del");

    // ── ② 停用／啟用 → USER_DEACTIVATED／USER_ACTIVATED ───────────────────
    await callOk("POST", `/admin/users/${uToggle.id}/deactivate`, adminCookie, undefined, 200);
    await callOk("POST", `/admin/users/${uToggle.id}/activate`, adminCookie, undefined, 200);

    // ── ③ 密碼重設 → USER_PASSWORD_RESET ──────────────────────────────────
    await callOk(
      "POST",
      `/admin/users/${uReset.id}/reset-password`,
      adminCookie,
      { temporaryPassword: RESET_PASSWORD },
      200
    );

    // ── AD-US-04③ 永久刪除 → USER_DELETED（無任何歷史資料，可刪）──────────
    await callOk("DELETE", `/admin/users/${uDeleted.id}`, adminCookie, undefined, 200);

    // ── ⑥ 參數異動 → PARAMETER_VERSION_CREATED（三類 parameterType 逐一）──
    const fuelPriceBody = await callOk("POST", "/parameters/fuel-price", adminCookie, {
      fuelType: "GASOLINE_95",
      pricePerLiter: "31.5000",
      effectiveFrom: `${PARAM_YEAR}-01-01`,
    });
    fuelPriceVersionId = (fuelPriceBody as { version: { id: string } }).version.id;

    const etcBody = await callOk("POST", "/parameters/etc", adminCookie, {
      unitPrice: "1.2000",
      effectiveFrom: `${PARAM_YEAR}-01-01`,
    });
    etcVersionId = (etcBody as { version: { id: string } }).version.id;

    const depBody = await callOk("POST", "/parameters/depreciation", adminCookie, {
      vehiclePrice: "600000.00",
      usefulLifeYears: 5,
      effectiveFrom: `${PARAM_YEAR}-01-01`,
    });
    depreciationVersionId = (depBody as { version: { id: string } }).version.id;

    // ── ⑦ 油耗資料異動 → USER_FUEL_CONSUMPTION_VERSION_CREATED × 2 ────────
    // 兩筆：第二筆之 `summary.before` 非 null，使 AC-06 之「巢狀混合形」
    // （`{before:{...}, after:{...}, basisNote}`）於 wire 面實際在場，AC-09(b)
    // 之掃描因而涵蓋該形狀（FW-2／FW-7 之直傳路徑）。
    await callOk("POST", `/users/${ownerId}/fuel-consumption`, adminCookie, {
      fuelType: "GASOLINE_95",
      kmPerLiter: "12.0000",
      effectiveFrom: `${PARAM_YEAR}-02-01`,
      basisNote: BASIS_NOTE_FIRST,
    });
    await callOk("POST", `/users/${ownerId}/fuel-consumption`, adminCookie, {
      fuelType: "DIESEL",
      kmPerLiter: "14.5000",
      effectiveFrom: `${PARAM_YEAR}-06-01`,
      basisNote: BASIS_NOTE_SECOND,
    });

    // ── ④ 代操作（代建立三型草稿）→ APPLICATION_CREATED_ON_BEHALF × 3 ─────
    const travelCreated = await callOk(
      "POST",
      `/admin/users/${ownerId}/applications/travel`,
      adminCookie,
      { tripDate: `${PARAM_YEAR}-03-05`, purpose: TRAVEL_PURPOSE }
    );
    onBehalfTravelId = (travelCreated as { application: ApplicationJson }).application.id;

    const maintenanceCreated = await callOk(
      "POST",
      `/admin/users/${ownerId}/applications/maintenance`,
      adminCookie,
      {
        lastMaintenanceDate: `${PARAM_YEAR}-01-10`,
        currentMaintenanceDate: `${PARAM_YEAR}-03-10`,
        lastOdometerKm: "1000.00",
        currentOdometerKm: "1500.00",
        actualCost: "3200.00",
      }
    );
    onBehalfMaintenanceId = (maintenanceCreated as { application: ApplicationJson }).application.id;

    const depreciationCreated = await callOk(
      "POST",
      `/admin/users/${ownerId}/applications/depreciation`,
      adminCookie,
      { applicationYear: PARAM_YEAR, annualTotalKm: "12345.0" }
    );
    onBehalfDepreciationId = (depreciationCreated as { application: ApplicationJson }).application
      .id;

    // ── ④ 代操作（代修改三型草稿）→ APPLICATION_UPDATED_ON_BEHALF × 3 ─────
    await callOk(
      "PUT",
      `/applications/travel/${onBehalfTravelId}`,
      adminCookie,
      { purpose: TRAVEL_PURPOSE_UPDATED },
      200
    );
    await callOk(
      "PUT",
      `/applications/maintenance/${onBehalfMaintenanceId}`,
      adminCookie,
      { actualCost: "3500.00" },
      200
    );
    await callOk(
      "PUT",
      `/applications/depreciation/${onBehalfDepreciationId}`,
      adminCookie,
      { annualTotalKm: "23456.0" },
      200
    );

    // ── (c) 負向對照：本人自建＋自改三型草稿 → 零新增稽核列 ────────────────
    // 量測方式為「操作前後之全表 `count()` 差值」——不是「查不到某條件的列」，
    // 故任何一處多寫（即使 action／targetLabel 與預期不同）都會被抓到。
    {
      const before = await auditCount();

      const selfTravel = await callOk("POST", "/applications/travel", ownerCookie, {
        tripDate: `${PARAM_YEAR}-04-02`,
        purpose: SELF_TRAVEL_PURPOSE,
      });
      const selfTravelId = (selfTravel as { application: ApplicationJson }).application.id;
      selfCreatedApplicationIds.push(selfTravelId);

      const selfMaintenance = await callOk("POST", "/applications/maintenance", ownerCookie, {
        lastMaintenanceDate: `${PARAM_YEAR}-01-15`,
        currentMaintenanceDate: `${PARAM_YEAR}-04-15`,
        lastOdometerKm: "2000.00",
        currentOdometerKm: "2600.00",
        actualCost: "1800.00",
      });
      const selfMaintenanceId = (selfMaintenance as { application: ApplicationJson }).application
        .id;
      selfCreatedApplicationIds.push(selfMaintenanceId);

      const selfDepreciation = await callOk("POST", "/applications/depreciation", ownerCookie, {
        applicationYear: PARAM_YEAR - 1,
        annualTotalKm: "9876.0",
      });
      const selfDepreciationId = (selfDepreciation as { application: ApplicationJson }).application
        .id;
      selfCreatedApplicationIds.push(selfDepreciationId);

      // 自改三型（AC-86 既有刻意行為之另一半）
      await callOk(
        "PUT",
        `/applications/travel/${selfTravelId}`,
        ownerCookie,
        { purpose: `${SELF_TRAVEL_PURPOSE}（自改）` },
        200
      );
      await callOk(
        "PUT",
        `/applications/maintenance/${selfMaintenanceId}`,
        ownerCookie,
        { actualCost: "1900.00" },
        200
      );
      await callOk(
        "PUT",
        `/applications/depreciation/${selfDepreciationId}`,
        ownerCookie,
        { annualTotalKm: "9900.0" },
        200
      );

      selfDraftAuditDelta = (await auditCount()) - before;
    }

    // ── (c) 延伸：管理員經**代操作端點**對自己建立草稿（C3 邊界）→ 零 ──────
    {
      const before = await auditCount();
      const adminSelf = await callOk(
        "POST",
        `/admin/users/${adminId}/applications/travel`,
        adminCookie,
        { tripDate: `${PARAM_YEAR}-04-20`, purpose: "合成出差目的：管理員自建（C3 邊界）" }
      );
      selfCreatedApplicationIds.push(
        (adminSelf as { application: ApplicationJson }).application.id
      );
      adminSelfDraftAuditDelta = (await auditCount()) - before;
    }

    // ── ⑤ 作廢 → APPLICATION_VOIDED（本人與管理員各一條）───────────────────
    voidedBySelfId = await createCompletedTravel(ownerId, "voidself");
    await callOk(
      "POST",
      `/applications/${voidedBySelfId}/void`,
      ownerCookie,
      { reason: VOID_REASON_SELF },
      200
    );
    voidedByAdminId = await createCompletedTravel(ownerId, "voidadmin");
    await callOk(
      "POST",
      `/applications/${voidedByAdminId}/void`,
      adminCookie,
      { reason: VOID_REASON_ADMIN },
      200
    );
    const voidedRows = await prisma.application.findMany({
      where: { id: { in: [voidedBySelfId, voidedByAdminId] } },
      select: { id: true, voidedAt: true },
    });
    voidedBySelfAt =
      voidedRows.find((r) => r.id === voidedBySelfId)?.voidedAt?.toISOString() ?? "MISSING";
    voidedByAdminAt =
      voidedRows.find((r) => r.id === voidedByAdminId)?.voidedAt?.toISOString() ?? "MISSING";

    // ── AC-08(b) 修正版三向邊界（逐格量測 delta）──────────────────────────
    // 第一向：管理員代他人建修正版 → 一條 APPLICATION_CREATED_ON_BEHALF
    revisionSourceOnBehalfId = await createCompletedTravel(ownerId, "revonbehalf");
    {
      const before = await auditCount();
      const created = await callOk(
        "POST",
        `/applications/${revisionSourceOnBehalfId}/revision`,
        adminCookie,
        undefined,
        201
      );
      revisionOnBehalfNewId = (created as { application: ApplicationJson }).application.id;
      revisionOnBehalfDelta = (await auditCount()) - before;
    }

    // 第二向：本人建修正版 → 零稽核列（PHASE-009 AC-26(c) 既有）
    revisionSourceSelfId = await createCompletedTravel(ownerId, "revself");
    {
      const before = await auditCount();
      await callOk(
        "POST",
        `/applications/${revisionSourceSelfId}/revision`,
        ownerCookie,
        undefined,
        201
      );
      revisionSelfDelta = (await auditCount()) - before;
    }

    // 第三向：管理員對**自己之申請**建修正版 → 零稽核列（PHASE-009 T7R）
    revisionSourceAdminOwnId = await createCompletedTravel(adminId, "revadminown");
    {
      const before = await auditCount();
      await callOk(
        "POST",
        `/applications/${revisionSourceAdminOwnId}/revision`,
        adminCookie,
        undefined,
        201
      );
      revisionAdminOwnDelta = (await auditCount()) - before;
    }
  }

  /** 以管理員身分取回完整稽核列表（單頁足以容納本檔全部列）。 */
  async function fetchWire(): Promise<{ body: AuditLogListBody; raw: string }> {
    const resp = await app.inject({
      method: "GET",
      url: "/admin/audit-logs?page=1&pageSize=100",
      headers: { cookie: adminCookie },
    });
    if (resp.statusCode !== 200) {
      throw new Error(`GET /admin/audit-logs → ${resp.statusCode}: ${resp.body}`);
    }
    return { body: resp.json() as AuditLogListBody, raw: resp.body };
  }

  /** 三表全欄快照（FW-1：`JSON.stringify` 逐欄；Decimal／Date 皆有穩定序列化）。 */
  async function snapshotThreeTables() {
    const [users, applications, auditLogs] = await Promise.all([
      prisma.user.findMany({ orderBy: { id: "asc" } }),
      prisma.application.findMany({ orderBy: { id: "asc" } }),
      prisma.auditLog.findMany({ orderBy: { id: "asc" } }),
    ]);
    return {
      users: JSON.stringify(users),
      applications: JSON.stringify(applications),
      auditLogs: JSON.stringify(auditLogs),
      counts: {
        users: users.length,
        applications: applications.length,
        auditLogs: auditLogs.length,
      },
    };
  }

  // -------------------------------------------------------------------------

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    await cleanupSyntheticData();

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "silent" });
    await app.ready();

    const admin = await bootstrapUser("admin", "ADMIN", ADMIN_PASSWORD);
    adminId = admin.id;
    adminLogin = admin.loginName;
    const owner = await bootstrapUser("owner", "USER", OWNER_PASSWORD);
    ownerId = owner.id;
    ownerLogin = owner.loginName;

    adminCookie = await login(adminLogin, ADMIN_PASSWORD);
    ownerCookie = await login(ownerLogin, OWNER_PASSWORD);

    SECRETS = [
      ADMIN_PASSWORD,
      OWNER_PASSWORD,
      CREATED_USER_PASSWORD,
      RESET_PASSWORD,
      ARGON2_PREFIX,
      ...sessionTokens,
    ];

    await seedAllEvents();

    // ── AC-07(a) 之逐格矩陣（播種後組裝，值取自實際回應／DB）─────────────
    eventMatrix = [
      {
        label: "①新增帳號",
        action: "USER_CREATED",
        endpoint: "POST /admin/users",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: uCreated.id,
        expectedTargetLabel: uCreated.loginName,
      },
      {
        // 同一端點之其餘三次呼叫（帳號分別供 ②③、AD-US-04③ 使用）——刻意逐格
        // 列出而非以「至少一條」帶過：矩陣須涵蓋全表，否則「零額外稽核列」之
        // 封閉守門（本檔 `matchedRowIds.size` 斷言）即失效。
        label: "①新增帳號（供②停用／啟用之對象）",
        action: "USER_CREATED",
        endpoint: "POST /admin/users",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: uToggle.id,
        expectedTargetLabel: uToggle.loginName,
      },
      {
        label: "①新增帳號（供③密碼重設之對象）",
        action: "USER_CREATED",
        endpoint: "POST /admin/users",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: uReset.id,
        expectedTargetLabel: uReset.loginName,
      },
      {
        // 該帳號其後被永久刪除：`AuditLog.targetId` 之 FK 為 `ON DELETE SET
        // NULL`（`20260801101310_phase2_auth/migration.sql`），故此列之
        // `targetId` 於刪除後已為 `null`，而 `targetLabel` 快照續存（AD-US-04③
        // 之可追溯性依據）。
        label: "①新增帳號（其後被永久刪除；targetId 經 SET NULL 後為 null）",
        action: "USER_CREATED",
        endpoint: "POST /admin/users",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: null,
        expectedTargetLabel: uDeleted.loginName,
      },
      {
        label: "②停用帳號",
        action: "USER_DEACTIVATED",
        endpoint: "POST /admin/users/:id/deactivate",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: uToggle.id,
        expectedTargetLabel: uToggle.loginName,
      },
      {
        label: "②啟用帳號（對稱事件，AC-07(a)② 併測）",
        action: "USER_ACTIVATED",
        endpoint: "POST /admin/users/:id/activate",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: uToggle.id,
        expectedTargetLabel: uToggle.loginName,
      },
      {
        label: "③密碼重設",
        action: "USER_PASSWORD_RESET",
        endpoint: "POST /admin/users/:id/reset-password",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: uReset.id,
        expectedTargetLabel: uReset.loginName,
      },
      {
        label: "④代操作—代建立差旅草稿",
        action: "APPLICATION_CREATED_ON_BEHALF",
        endpoint: "POST /admin/users/:userId/applications/travel",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: ownerId,
        expectedTargetLabel: `${ownerLogin}#${onBehalfTravelId}`,
      },
      {
        label: "④代操作—代建立保養草稿",
        action: "APPLICATION_CREATED_ON_BEHALF",
        endpoint: "POST /admin/users/:userId/applications/maintenance",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: ownerId,
        expectedTargetLabel: `${ownerLogin}#${onBehalfMaintenanceId}`,
      },
      {
        label: "④代操作—代建立折舊草稿",
        action: "APPLICATION_CREATED_ON_BEHALF",
        endpoint: "POST /admin/users/:userId/applications/depreciation",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: ownerId,
        expectedTargetLabel: `${ownerLogin}#${onBehalfDepreciationId}`,
      },
      {
        label: "④代操作—代修改差旅草稿",
        action: "APPLICATION_UPDATED_ON_BEHALF",
        endpoint: "PUT /applications/travel/:id",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: ownerId,
        expectedTargetLabel: `${ownerLogin}#${onBehalfTravelId}`,
      },
      {
        label: "④代操作—代修改保養草稿",
        action: "APPLICATION_UPDATED_ON_BEHALF",
        endpoint: "PUT /applications/maintenance/:id",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: ownerId,
        expectedTargetLabel: `${ownerLogin}#${onBehalfMaintenanceId}`,
      },
      {
        label: "④代操作—代修改折舊草稿",
        action: "APPLICATION_UPDATED_ON_BEHALF",
        endpoint: "PUT /applications/depreciation/:id",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: ownerId,
        expectedTargetLabel: `${ownerLogin}#${onBehalfDepreciationId}`,
      },
      {
        label: "⑤作廢—本人",
        action: "APPLICATION_VOIDED",
        endpoint: "POST /applications/:id/void（本人）",
        expectedCount: 1,
        expectedActorId: ownerId,
        expectedTargetId: ownerId,
        expectedTargetLabel: `${ownerLogin}#${voidedBySelfId}`,
      },
      {
        label: "⑤作廢—管理員代他人",
        action: "APPLICATION_VOIDED",
        endpoint: "POST /applications/:id/void（管理員）",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: ownerId,
        expectedTargetLabel: `${ownerLogin}#${voidedByAdminId}`,
      },
      {
        label: "⑥參數異動—油價（FUEL_PRICE）",
        action: "PARAMETER_VERSION_CREATED",
        endpoint: "POST /parameters/fuel-price",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: null,
        expectedTargetLabel: `FUEL_PRICE#${fuelPriceVersionId}`,
      },
      {
        label: "⑥參數異動—ETC",
        action: "PARAMETER_VERSION_CREATED",
        endpoint: "POST /parameters/etc",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: null,
        expectedTargetLabel: `ETC#${etcVersionId}`,
      },
      {
        label: "⑥參數異動—折舊",
        action: "PARAMETER_VERSION_CREATED",
        endpoint: "POST /parameters/depreciation",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: null,
        expectedTargetLabel: `DEPRECIATION#${depreciationVersionId}`,
      },
      {
        label: "⑦油耗資料異動（同一對象兩版本）",
        action: "USER_FUEL_CONSUMPTION_VERSION_CREATED",
        endpoint: "POST /users/:userId/fuel-consumption",
        expectedCount: 2,
        expectedActorId: adminId,
        expectedTargetId: ownerId,
        expectedTargetLabel: ownerLogin,
      },
      {
        label: "AD-US-04③ 永久刪除帳號",
        action: "USER_DELETED",
        endpoint: "DELETE /admin/users/:id",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: null, // FK `ON DELETE SET NULL`／寫入時即為 null
        expectedTargetLabel: uDeleted.loginName,
      },
      {
        label: "④代操作—代建立修正版（AC-08(b) 第一向）",
        action: "APPLICATION_CREATED_ON_BEHALF",
        endpoint: "POST /applications/:id/revision（管理員代他人）",
        expectedCount: 1,
        expectedActorId: adminId,
        expectedTargetId: ownerId,
        expectedTargetLabel: `${ownerLogin}#${revisionOnBehalfNewId}`,
      },
    ];
  }, 120_000);

  afterAll(async () => {
    if (!DB_URL) return;
    await app?.close();
    await prisma?.$disconnect();
  });

  // =========================================================================
  // AC-07 — 七類事件端到端齊備回歸
  // =========================================================================

  describe("AC-07 — 七類事件端到端齊備回歸（AD-US-14①／BE-US-31）", () => {
    it("AC-07: 七類事件經真實端點觸發後稽核列齊備且可經檢視端點取回", async () => {
      // ── (a) DB 面：逐格恰產生對應 action 之稽核列，四要素齊備 ────────────
      const allRows = await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
      expect(allRows.length).toBe(EXPECTED_TOTAL_ROWS);

      const displayNames = new Map(
        (await prisma.user.findMany({ select: { id: true, displayName: true } })).map((u) => [
          u.id,
          u.displayName,
        ])
      );

      // ── (b) wire 面：同一批列可經 GET /admin/audit-logs 取回 ─────────────
      const { body } = await fetchWire();
      expect(Object.keys(body).sort()).toEqual(RESPONSE_KEYS);
      expect(body.total).toBe(EXPECTED_TOTAL_ROWS);
      expect(body.items.length).toBe(EXPECTED_TOTAL_ROWS);
      const wireById = new Map(body.items.map((i) => [i.id, i]));

      // 矩陣格數自證：漏一格（例如把某一類從矩陣拿掉）此處即紅。
      expect(eventMatrix.length).toBe(21);

      const matchedRowIds = new Set<string>();
      for (const cell of eventMatrix) {
        const rows = allRows.filter(
          (r) => r.action === cell.action && r.targetLabel === cell.expectedTargetLabel
        );
        expect(rows.length, `${cell.label}（${cell.endpoint}）之稽核列數`).toBe(cell.expectedCount);

        for (const row of rows) {
          matchedRowIds.add(row.id);

          // (a) actorId／targetLabel／createdAt 齊備
          expect(row.actorId, `${cell.label} actorId`).toBe(cell.expectedActorId);
          expect(row.targetId, `${cell.label} targetId`).toBe(cell.expectedTargetId);
          expect(row.targetLabel, `${cell.label} targetLabel`).toBe(cell.expectedTargetLabel);
          expect(row.targetLabel.length, `${cell.label} targetLabel 非空`).toBeGreaterThan(0);
          expect(row.createdAt, `${cell.label} createdAt`).toBeInstanceOf(Date);
          expect(Number.isNaN(row.createdAt.getTime())).toBe(false);

          // (b) 可經檢視端點取回並通過 AC-04
          const item = wireById.get(row.id);
          expect(item, `${cell.label} 之列未出現於 GET /admin/audit-logs`).toBeDefined();
          if (!item) continue;
          // AC-04(a) 鍵集封閉（多一鍵必紅）
          expect(Object.keys(item).sort(), `${cell.label} DTO 鍵集`).toEqual(ITEM_KEYS);
          expect(item.action).toBe(row.action);
          // AC-04(b) 操作者以 displayName 呈現，內部識別值不外露
          expect(item.actorDisplayName).toBe(displayNames.get(row.actorId));
          expect(item).not.toHaveProperty("actorId");
          expect(item).not.toHaveProperty("targetId");
          // AC-04(c) 受影響資料＝targetLabel（＋ targetDisplayName）
          expect(item.targetLabel).toBe(row.targetLabel);
          expect(item.targetDisplayName).toBe(
            row.targetId === null ? null : (displayNames.get(row.targetId) ?? null)
          );
          // AC-04(e) ISO 8601 UTC 字串
          expect(item.createdAt).toBe(row.createdAt.toISOString());
          expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          expect(Array.isArray(item.changes)).toBe(true);
        }
      }

      // 矩陣涵蓋全表：沒有任何一列落在矩陣之外（防「額外事件被默默寫入」）。
      expect(matchedRowIds.size).toBe(EXPECTED_TOTAL_ROWS);
    });

    it("AC-07(a): 全表 action 分佈恰等於七類事件之預期計數（零額外／零缺漏稽核列）", async () => {
      const rows = await prisma.auditLog.findMany({ select: { action: true } });
      const actual: Record<string, number> = {};
      for (const r of rows) actual[r.action] = (actual[r.action] ?? 0) + 1;
      expect(actual).toEqual(EXPECTED_ACTION_COUNTS);
      // 十個 `AuditAction` 值逐一在場（AC-04(d) 之本檔實質對照：全部由真實端點
      // 產生，非直寫播種）。
      expect(Object.keys(actual).sort()).toEqual(
        (Object.keys(EXPECTED_ACTION_COUNTS) as AuditAction[]).sort()
      );
    });

    it("AC-07(a)⑥: PARAMETER_VERSION_CREATED 之 summary.parameterType 三值逐一在場", async () => {
      const rows = await prisma.auditLog.findMany({
        where: { action: "PARAMETER_VERSION_CREATED" },
      });
      expect(rows.length).toBe(3);
      const types = rows
        .map((r) => (r.summary as Record<string, unknown> | null)?.parameterType)
        .sort();
      expect(types).toEqual(["DEPRECIATION", "ETC", "FUEL_PRICE"]);
    });

    it("AC-07(a)⑤: 作廢由本人與管理員各寫一條（BE-US-31② 之兩身分皆寫）", async () => {
      const rows = await prisma.auditLog.findMany({ where: { action: "APPLICATION_VOIDED" } });
      expect(rows.length).toBe(2);

      const selfRow = rows.find(
        (r) => (r.summary as Record<string, unknown> | null)?.applicationId === voidedBySelfId
      );
      const adminRow = rows.find(
        (r) => (r.summary as Record<string, unknown> | null)?.applicationId === voidedByAdminId
      );
      expect(selfRow).toBeDefined();
      expect(adminRow).toBeDefined();
      // 本人作廢：actorId === targetId（若沿用「本人豁免」而跳過寫入即紅）
      expect(selfRow?.actorId).toBe(ownerId);
      expect(selfRow?.targetId).toBe(ownerId);
      // 管理員代作廢：actorId ≠ targetId
      expect(adminRow?.actorId).toBe(adminId);
      expect(adminRow?.targetId).toBe(ownerId);
      expect(adminRow?.actorId).not.toBe(adminRow?.targetId);
    });

    it("AC-07(c): 本人自建草稿零稽核列（防恆真負向對照）", async () => {
      // 量測為「三型自建＋三型自改」前後之**全表計數差**——這正是 (a)④ 之計數
      // 斷言「確實有牙」的證明：同一組端點（PUT 三型）在代操作身分下寫了 3 列
      // （見矩陣），在本人身分下必須寫 0 列。
      expect(selfDraftAuditDelta).toBe(0);

      // 補強：全表無任何一列指涉本人自建之申請 id（即使 action／targetLabel
      // 與預期不同亦會被抓到）。
      const rows = await prisma.auditLog.findMany({ select: { summary: true, targetLabel: true } });
      for (const appId of selfCreatedApplicationIds) {
        const hit = rows.some(
          (r) =>
            (r.summary as Record<string, unknown> | null)?.applicationId === appId ||
            r.targetLabel.includes(appId)
        );
        expect(hit, `本人自建之申請 ${appId} 不應出現於任何稽核列`).toBe(false);
      }
    });

    it("AC-07(c) 延伸: 管理員經代操作端點對自己建立草稿 → 零稽核列（C3 邊界）", () => {
      expect(adminSelfDraftAuditDelta).toBe(0);
    });

    it("FW-1（T2 即審）: GET /admin/audit-logs 呼叫前後 AuditLog／User／Application 三表逐欄不變，且三表皆非空", async () => {
      const before = await snapshotThreeTables();
      // 三表皆非空——T2 之 AC-01(d) 於 `Application` 表恆空之分支上為恆真，
      // 本斷言即其實質補齊（Packet FW-1）。
      expect(before.counts.users).toBeGreaterThan(0);
      expect(before.counts.applications).toBeGreaterThan(0);
      expect(before.counts.auditLogs).toBeGreaterThan(0);

      await fetchWire();

      const after = await snapshotThreeTables();
      expect(after.counts).toEqual(before.counts);
      expect(after.users).toBe(before.users);
      expect(after.applications).toBe(before.applications);
      expect(after.auditLogs).toBe(before.auditLogs);
    });
  });

  // =========================================================================
  // AC-08 — 代操作稽核之完整性回歸（PHASE-009 移交④）
  // =========================================================================

  describe("AC-08 — 代操作稽核之完整性回歸", () => {
    it("AC-08: 代操作稽核完整性 — 作廢與修正版兩類（含三向零稽核邊界）", async () => {
      // ── (a) 作廢類：兩身分皆寫，summary 為封閉四鍵 ───────────────────────
      const voidRows = await prisma.auditLog.findMany({ where: { action: "APPLICATION_VOIDED" } });
      expect(voidRows.length).toBe(2);

      const adminVoid = voidRows.find(
        (r) => (r.summary as Record<string, unknown> | null)?.applicationId === voidedByAdminId
      );
      expect(adminVoid).toBeDefined();
      expect(adminVoid?.actorId).toBe(adminId);
      expect(adminVoid?.targetId).toBe(ownerId);
      expect(adminVoid?.targetLabel).toBe(`${ownerLogin}#${voidedByAdminId}`);
      // 封閉四鍵（`toEqual`）——多寫一鍵（如夾帶 voidedById／ownerId）必紅。
      expect(adminVoid?.summary).toEqual({
        applicationId: voidedByAdminId,
        type: "TRAVEL",
        reason: VOID_REASON_ADMIN,
        voidedAt: voidedByAdminAt,
      });

      const selfVoid = voidRows.find(
        (r) => (r.summary as Record<string, unknown> | null)?.applicationId === voidedBySelfId
      );
      expect(selfVoid).toBeDefined();
      expect(selfVoid?.actorId).toBe(ownerId);
      expect(selfVoid?.targetId).toBe(ownerId);
      expect(selfVoid?.summary).toEqual({
        applicationId: voidedBySelfId,
        type: "TRAVEL",
        reason: VOID_REASON_SELF,
        voidedAt: voidedBySelfAt,
      });

      // ── (b) 修正版類三向 ─────────────────────────────────────────────────
      // 第一向：管理員代他人 → 恰一條 APPLICATION_CREATED_ON_BEHALF，含 revisionOf
      expect(revisionOnBehalfDelta).toBe(1);
      const revisionRows = await prisma.auditLog.findMany({
        where: { action: "APPLICATION_CREATED_ON_BEHALF" },
      });
      const revisionRow = revisionRows.filter(
        (r) => (r.summary as Record<string, unknown> | null)?.revisionOf !== undefined
      );
      expect(revisionRow.length).toBe(1);
      expect(revisionRow[0].actorId).toBe(adminId);
      expect(revisionRow[0].targetId).toBe(ownerId);
      expect(revisionRow[0].targetLabel).toBe(`${ownerLogin}#${revisionOnBehalfNewId}`);
      expect(revisionRow[0].summary).toEqual({
        applicationId: revisionOnBehalfNewId,
        type: "TRAVEL",
        revisionOf: revisionSourceOnBehalfId,
      });

      // 第二向：本人建修正版 → 零稽核列（PHASE-009 AC-26(c) 既有）
      expect(revisionSelfDelta).toBe(0);
      // 第三向：管理員對自己之申請建修正版 → 零稽核列（PHASE-009 T7R 三向封閉）
      expect(revisionAdminOwnDelta).toBe(0);
      // 兩個「零」向之來源申請不得出現於任何稽核列之 revisionOf
      const revisionOfValues = revisionRows.map(
        (r) => (r.summary as Record<string, unknown> | null)?.revisionOf
      );
      expect(revisionOfValues).not.toContain(revisionSourceSelfId);
      expect(revisionOfValues).not.toContain(revisionSourceAdminOwnId);
    });

    it("AC-08(c): 兩類 summary 經 AC-06 扁平化後於列表可讀（作廢原因逐字可見、revisionOf 在場、鍵守恆）", async () => {
      const { body } = await fetchWire();
      const rows = await prisma.auditLog.findMany();
      const rowById = new Map(rows.map((r) => [r.id, r]));

      function changesOf(predicate: (r: (typeof rows)[number]) => boolean): AuditChangeDto[] {
        const row = rows.find(predicate);
        expect(row).toBeDefined();
        const item = body.items.find((i) => i.id === row?.id);
        expect(item).toBeDefined();
        return item?.changes ?? [];
      }

      // 作廢（管理員代他人）——BE-US-31② 之終點：作廢原因逐字可見。
      const adminVoidChanges = changesOf(
        (r) =>
          r.action === "APPLICATION_VOIDED" &&
          (r.summary as Record<string, unknown> | null)?.applicationId === voidedByAdminId
      );
      expect(adminVoidChanges).toContainEqual({
        field: "reason",
        before: null,
        after: VOID_REASON_ADMIN,
      });
      expect(adminVoidChanges).toContainEqual({
        field: "applicationId",
        before: null,
        after: voidedByAdminId,
      });
      expect(adminVoidChanges).toContainEqual({ field: "type", before: null, after: "TRAVEL" });

      // 作廢（本人）——同樣逐字可見。
      const selfVoidChanges = changesOf(
        (r) =>
          r.action === "APPLICATION_VOIDED" &&
          (r.summary as Record<string, unknown> | null)?.applicationId === voidedBySelfId
      );
      expect(selfVoidChanges).toContainEqual({
        field: "reason",
        before: null,
        after: VOID_REASON_SELF,
      });

      // 修正版——`revisionOf` 在場且可讀。
      const revisionChanges = changesOf(
        (r) =>
          r.action === "APPLICATION_CREATED_ON_BEHALF" &&
          (r.summary as Record<string, unknown> | null)?.revisionOf !== undefined
      );
      expect(revisionChanges).toContainEqual({
        field: "revisionOf",
        before: null,
        after: revisionSourceOnBehalfId,
      });

      // AC-06(d) 鍵守恆：兩類之 `summary` 頂層鍵集合 ⊆ `changes` 之 field 集合。
      for (const item of body.items) {
        const row = rowById.get(item.id);
        if (!row) continue;
        if (row.action !== "APPLICATION_VOIDED" && row.action !== "APPLICATION_CREATED_ON_BEHALF") {
          continue;
        }
        const summaryKeys = Object.keys((row.summary ?? {}) as Record<string, unknown>);
        const fields = item.changes.map((c) => c.field);
        for (const key of summaryKeys) {
          expect(fields, `${row.action} 之 summary 鍵 ${key} 於 changes 遺失`).toContain(key);
        }
        // AC-06(f)：值之字串化不得產生 `"[object Object]"`。
        for (const c of item.changes) {
          expect(c.before ?? "").not.toContain("[object Object]");
          expect(c.after ?? "").not.toContain("[object Object]");
        }
      }
    });
  });

  // =========================================================================
  // AC-09 — 密碼與敏感資料不入稽核之全表回歸
  // =========================================================================

  describe("AC-09 — 密碼與敏感資料不入稽核之全表回歸", () => {
    it("AC-09: 密碼與敏感資料不入稽核 — DB 全表 ＋ wire 面雙掃描", async () => {
      // 掃描器輸入之非空自證（防「掃了空集合」型恆真）：四組明文密碼 ＋
      // `$argon2` 前綴 ＋ 兩枚 session token ＝ 7 個字面。
      expect(SECRETS.length).toBe(7);
      expect(sessionTokens.length).toBe(2);

      // ── (a) DB 全表 ─────────────────────────────────────────────────────
      const rows = await prisma.auditLog.findMany();
      expect(rows.length).toBe(EXPECTED_TOTAL_ROWS);
      for (const row of rows) {
        // 祕密字面：**全欄**掃描（強於 AC-09(a) 所要求之 targetLabel／summary）
        assertNoSecretLiterals(row, `auditLog[${row.id}]`, SECRETS);
        // 通用啟發式：AC-09(a) 明列之兩欄
        assertNoSensitiveContent(
          row.targetLabel,
          `auditLog[${row.id}].targetLabel`,
          HEURISTIC_ALLOWED_LITERALS
        );
        assertNoSensitiveContent(
          row.summary,
          `auditLog[${row.id}].summary`,
          HEURISTIC_ALLOWED_LITERALS
        );
      }

      // ── (b) wire 面（AC-06 之 `changes` 為新揭露面）───────────────────────
      // FW-2／FW-7：`changes` 直傳 DB 原值零過濾，本掃描是該路徑之唯一守門，
      // **不得**降級為只掃 DB 端——故此處掃的是解析後之完整 body **與**未解析
      // 之原始回應字串（後者連鍵名、編碼後之字面一併涵蓋）。
      const { body, raw } = await fetchWire();
      expect(body.items.length).toBe(EXPECTED_TOTAL_ROWS);
      assertNoSecretLiterals(body, "wire", SECRETS);
      assertNoSensitiveContent(body, "wire", HEURISTIC_ALLOWED_LITERALS);
      for (const secret of SECRETS) {
        expect(raw.includes(secret), "secret literal leaked in raw response body").toBe(false);
      }
      // 巢狀混合形（`{before:{...}, after:{...}, basisNote}`）確實在場——否則
      // 上面的 wire 掃描會漏掉本 Phase 最複雜的揭露面。
      const fuelItems = body.items.filter(
        (i) => i.action === "USER_FUEL_CONSUMPTION_VERSION_CREATED"
      );
      expect(fuelItems.length).toBe(2);
      const withBefore = fuelItems.filter(
        (i) => i.changes.find((c) => c.field === "before")?.after !== null
      );
      expect(withBefore.length).toBe(1);
      expect(fuelItems.every((i) => i.changes.some((c) => c.field === "basisNote"))).toBe(true);
    });

    it("AC-09(c): USER_PASSWORD_RESET 之 summary 為封閉單鍵 {mustChangePassword:true}（加鍵 mutant 必紅）", async () => {
      const rows = await prisma.auditLog.findMany({ where: { action: "USER_PASSWORD_RESET" } });
      expect(rows.length).toBe(1);
      // 封閉單鍵：加入**任何**密碼相關鍵（temporaryPassword／newPassword／
      // passwordHash…）之 mutant 於此必紅。
      expect(rows[0].summary).toEqual({ mustChangePassword: true });
      expect(Object.keys(rows[0].summary as Record<string, unknown>)).toEqual([
        "mustChangePassword",
      ]);
      expect(rows[0].actorId).toBe(adminId);
      expect(rows[0].targetId).toBe(uReset.id);
      expect(rows[0].targetLabel).toBe(uReset.loginName);

      // wire 面同樣只有一欄，且其值不攜帶任何密碼內容。
      const { body } = await fetchWire();
      const item = body.items.find((i) => i.id === rows[0].id);
      expect(item).toBeDefined();
      expect(item?.changes).toEqual([{ field: "mustChangePassword", before: null, after: "true" }]);
    });

    it("AC-09(d): USER_DELETED 之稽核列 targetId 為 null、targetLabel 為刪除前快照且不含敏感資料", async () => {
      const rows = await prisma.auditLog.findMany({ where: { action: "USER_DELETED" } });
      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row.targetId).toBeNull();
      expect(row.targetLabel).toBe(uDeleted.loginName);
      expect(row.actorId).toBe(adminId);
      // 目標使用者確實已不存在（AD-US-04③ 之永久刪除）
      const gone = await prisma.user.findUnique({ where: { id: uDeleted.id } });
      expect(gone).toBeNull();
      // 敏感資料雙掃
      assertNoSecretLiterals(row, "USER_DELETED", SECRETS);
      assertNoSensitiveContent(row.summary, "USER_DELETED.summary", HEURISTIC_ALLOWED_LITERALS);

      // wire 面：target 已刪除 → `targetDisplayName` 為 null，`targetLabel`
      // 仍為刪除前快照（AC-04(c)）。
      const { body } = await fetchWire();
      const item = body.items.find((i) => i.id === row.id);
      expect(item).toBeDefined();
      expect(item?.targetDisplayName).toBeNull();
      expect(item?.targetLabel).toBe(uDeleted.loginName);
    });

    it("掃描器鑑別力自證：兩具掃描器對合成陽性樣本必拋（防恆真）", () => {
      // （1）祕密字面掃描器——值命中
      expect(() =>
        assertNoSecretLiterals({ note: `prefix ${RESET_PASSWORD} suffix` }, "$", SECRETS)
      ).toThrow();
      // （1）祕密字面掃描器——巢狀陣列內命中
      expect(() =>
        assertNoSecretLiterals({ a: [{ b: `${ARGON2_PREFIX}id$v=19$...` }] }, "$", SECRETS)
      ).toThrow();
      // （1）祕密字面掃描器——session token 命中
      expect(() => assertNoSecretLiterals({ t: sessionTokens[0] }, "$", SECRETS)).toThrow();
      // （1）零命中之陰性樣本不得誤報
      expect(() =>
        assertNoSecretLiterals({ ok: "合成內容：完全無祕密" }, "$", SECRETS)
      ).not.toThrow();

      // （2）通用啟發式——鍵命中（允許集為封閉字面，不含 temporaryPassword）
      expect(() =>
        assertNoSensitiveContent({ temporaryPassword: "x" }, "$", HEURISTIC_ALLOWED_LITERALS)
      ).toThrow();
      expect(() =>
        assertNoSensitiveContent({ passwordHash: "x" }, "$", HEURISTIC_ALLOWED_LITERALS)
      ).toThrow();
      // （2）通用啟發式——值命中
      expect(() =>
        assertNoSensitiveContent({ note: "session token leaked" }, "$", HEURISTIC_ALLOWED_LITERALS)
      ).toThrow();
      // （2）允許集**恰為兩個完整字面**：子字串型的規避不被放行
      expect(() =>
        assertNoSensitiveContent({ mustChangePasswordExtra: true }, "$", HEURISTIC_ALLOWED_LITERALS)
      ).toThrow();
      expect(() =>
        assertNoSensitiveContent({ field: "mustChangePassword" }, "$", HEURISTIC_ALLOWED_LITERALS)
      ).not.toThrow();
    });
  });
});
