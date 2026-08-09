/**
 * Integration test: PHASE-010-T2 — `GET /admin/audit-logs`（稽核查詢端點）
 *
 * 涵蓋（`docs/specs/PHASE-010.md`）：
 *   · **AC-01** 端點與回應形狀（(a) 200／(b) 四鍵封閉／(c) 零結果 200 空集／
 *     (d) 端點零寫入）
 *   · **AC-03** 全序排序與跨頁不重不漏（(a) `createdAt DESC, id DESC`／
 *     (b) 同 `createdAt` 多列跨頁聯集恰等於全集且零重複／(c) `skip`／`take` ＋
 *     獨立 `count` 之原始碼結構守門）
 *   · **AC-04** 列投影七鍵封閉（(a)~(e)，含十個 `AuditAction` 值逐一可取回）
 *   · **AC-05** 授權矩陣五格 ＋ `403` 早於 `400` 之側信道（B-20）
 *   · 邊界：B-03（`pageSize` clamp）／B-04（`page` 超出總頁數）／B-05／B-06／
 *     B-07／B-09／B-11／B-12／B-13／B-19／B-20／B-23／B-24
 *   · 上游 FW：**FW-1**（`page` 無上界 → `skip` 溢位）／**FW-2**（半開區間
 *     `gte`／`lt` 之雙向釘死）
 *
 * ---------------------------------------------------------------------------
 * 為何本檔以 `prisma.auditLog.create` 直接播種（與 §11.0 #4 之關係）
 * ---------------------------------------------------------------------------
 * §11.0 #4「真實端點優先」之射程為「**稽核齊備回歸**（AC-07／T3）與
 * **AD-US-04 回歸**（AC-12/13/14／T5）」——那兩者要證明的正是「真實操作會不會
 * 寫稽核」，故不得直寫。本檔（T2）要證明的是**查詢端點的投影、排序與授權**，
 * 其前提資料必須具備真實端點**無法構造**的性質：
 *   · AC-03(b) 要求「`createdAt` 完全相同」的多列——`createdAt` 為 `@default(now())`，
 *     真實端點無法令其相同；
 *   · AC-04(c)／B-13 要求「`target` 已被刪除（`SET NULL` 後）」之列；
 *   · FW-2 要求「當日 23:59:59.999Z 與次日 00:00:00.000Z」之毫秒級邊界列。
 * 故本檔之播種為 T2 職責所必需，且**不**用於證明任何「寫入是否發生」之命題
 * （唯一涉及寫入的斷言 AC-01(d) 是**零寫入**，方向相反）。
 *
 * 測試紀律（§11.0／`CLAUDE.md`）：
 *   · 全程合成資料；`loginName` 前綴 `p10t2`（**刻意不含 `_`／`%`**，可安全用於
 *     Prisma `startsWith`＝SQL LIKE）。
 *   · 清理一律以本套件自建之前綴／id 精確比對；**禁用**全域 `deleteMany({})`。
 *   · 每一組查詢皆以**本組專屬 actor** 之 `actorId` 收斂射程，使斷言不受同一
 *     schema 內其他資料影響（即使 per-file 清空機制未來變動亦然）。
 *   · `createdAt` 一律落在本檔專屬年份 **2049**，與其他 integration 檔零重疊。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { AuditAction } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(__dirname, "../..");

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** 刻意不含 `_`／`%`：可安全用於 Prisma `startsWith`（編譯為 SQL LIKE）。 */
const LOGIN_PREFIX = "p10t2";
const PASSWORD = "AuditQuery99!";

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

/** `AuditLogListResponse` 之封閉鍵集（AC-01(b)，多一鍵必紅）。 */
const RESPONSE_KEYS = ["items", "page", "pageSize", "total"].sort();

/** `schema.prisma` 之 `AuditAction` 全部 10 值（AC-04(d)）。 */
const ALL_ACTIONS: AuditAction[] = [
  "USER_CREATED",
  "USER_DEACTIVATED",
  "USER_ACTIVATED",
  "USER_PASSWORD_RESET",
  "USER_DELETED",
  "PARAMETER_VERSION_CREATED",
  "APPLICATION_CREATED_ON_BEHALF",
  "APPLICATION_UPDATED_ON_BEHALF",
  "USER_FUEL_CONSUMPTION_VERSION_CREATED",
  "APPLICATION_VOIDED",
];

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
  items?: AuditLogListItemDto[];
  total?: number;
  page?: number;
  pageSize?: number;
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    fields?: Array<{ field: string }>;
  };
}

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0];
}

// ===========================================================================
// 結構性斷言（不碰 DB，恆執行）
// ===========================================================================

describe("PHASE-010-T2 結構性斷言（AC-03(c)／ErrorCode 聯集）", () => {
  const routesPath = path.join(BACKEND_ROOT, "src/audit/routes.ts");

  it("AC-03(c)：分頁與計數皆於 DB 層完成——`skip`／`take` ＋ 獨立 `count` 在場，且零記憶體內切片", () => {
    const src = fs.readFileSync(routesPath, "utf-8");

    // `skip`／`take` 必須是**同一個 findMany 呼叫**的參數（交由 Prisma 編譯為
    // DB 的 `OFFSET`／`LIMIT`）——只斷言檔內某處出現 `skip` 會被「先全撈再於
    // JS 端切片」的實作矇混過去，故先抽出 findMany 區塊再逐項比對。
    const findManyBlock = src.match(/auditLog\.findMany\(\{[\s\S]*?\}\)/)?.[0] ?? "";
    expect(findManyBlock).not.toBe("");
    expect(findManyBlock).toMatch(/\bskip[,:]/);
    expect(findManyBlock).toMatch(/\btake:/);
    // 兩層全序排序鍵皆在場（AC-03(a)；移除 `id` 這層之 mutant 必紅）
    expect(findManyBlock).toMatch(
      /orderBy:\s*\[\s*\{\s*createdAt:\s*"desc"\s*\}\s*,\s*\{\s*id:\s*"desc"\s*\}\s*\]/
    );
    // 獨立 count（非以 `items.length` 或整份讀取後計數）
    expect(src).toMatch(/auditLog\.count\(/);
    // 不得把命中集合整份讀入記憶體後於 JS 端切片／過濾（B-23）
    expect(src).not.toMatch(/\.slice\(/);
    expect(src).not.toMatch(/findMany\(\{\s*where\s*\}\)/);
  });

  it("FW-2：`where` 之上界必須是 `lt`（半開區間），不得誤用 `lte`", () => {
    const src = fs.readFileSync(routesPath, "utf-8");
    expect(src).toMatch(/lt:\s*[A-Za-z.]*createdAtToExclusive/);
    expect(src).not.toMatch(/lte:/);
  });

  it("R-4：查詢端點零日誌行——不得將 `changes`／`summary` 寫入任何日誌（§6.3）", () => {
    const src = fs.readFileSync(routesPath, "utf-8");
    expect(src).not.toMatch(/\blog\.(info|warn|error|debug|trace)\(/);
    expect(src).not.toMatch(/console\./);
  });

  it("機械連動：本 Phase 零新增 `ErrorCode`——`src/audit/**` 所用之碼皆為既有聯集成員", () => {
    const errorsSrc = fs.readFileSync(path.join(BACKEND_ROOT, "src/platform/errors.ts"), "utf-8");
    const declared = [...errorsSrc.matchAll(/^\s*\|?\s*"([A-Z_]+)"/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);

    const auditDir = path.join(BACKEND_ROOT, "src/audit");
    const files = fs.readdirSync(auditDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    const usedCodes = new Set<string>();
    for (const file of files) {
      const content = fs.readFileSync(path.join(auditDir, file), "utf-8");
      for (const m of content.matchAll(/new AppError\(\s*"([A-Z_]+)"/g)) {
        usedCodes.add(m[1]);
      }
    }
    // 掃描器本身有牙（本 Task 至少會拋 VALIDATION_ERROR）
    expect(usedCodes.has("VALIDATION_ERROR")).toBe(true);
    for (const code of usedCodes) {
      expect(declared, `unexpected new ErrorCode literal: ${code}`).toContain(code);
    }
  });
});

// ===========================================================================
// 端點整合測試
// ===========================================================================

describeWithDb("PHASE-010-T2 — GET /admin/audit-logs", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let adminId: string;
  let userId: string;
  let targetUserId: string;
  let pwdId: string;
  let orderActorId: string;
  let enumActorId: string;
  let dateActorId: string;
  let shapeActorId: string;
  let bulkActorId: string;
  /** 已被刪除之目標使用者（`SET NULL` 後）之刪除前 id — B-13。 */
  let ghostTargetId: string;

  let adminCookie: string;
  let userCookie: string;
  let targetUserCookie: string;
  let pwdCookie: string;

  const ORDER_CREATED_AT = new Date("2049-03-15T08:00:00.000Z");
  const ORDER_ROW_COUNT = 5;
  const ORDER_LABEL_PREFIX = "p10t2ord";

  const DATE_FROM = "2049-07-10";
  const DATE_TO = "2049-07-12";
  /** FW-2 之四個毫秒級邊界時刻（前二必命中、後二必不命中）。 */
  const DATE_IN_LOWER = new Date("2049-07-10T00:00:00.000Z");
  const DATE_IN_UPPER = new Date("2049-07-12T23:59:59.999Z");
  const DATE_OUT_NEXT_DAY = new Date("2049-07-13T00:00:00.000Z");
  const DATE_OUT_PREV_DAY = new Date("2049-07-09T23:59:59.999Z");

  const BULK_ROW_COUNT = 120;

  const VOID_REASON = "合成作廢原因：路線重複申報";
  const BASIS_NOTE = "合成依據備註：原廠型錄";

  async function cleanupSyntheticData() {
    const candidates = await prisma.user.findMany({
      where: { loginName: { startsWith: LOGIN_PREFIX } },
      select: { id: true, loginName: true },
    });
    const ownUserIds = candidates
      .filter((u) => u.loginName.startsWith(LOGIN_PREFIX))
      .map((u) => u.id);
    if (ownUserIds.length > 0) {
      // `AuditLog.actorId` 為 `ON DELETE RESTRICT`：稽核列必須先於使用者刪除。
      await prisma.auditLog.deleteMany({ where: { actorId: { in: ownUserIds } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: ownUserIds } } });
      await prisma.session.deleteMany({ where: { userId: { in: ownUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: ownUserIds } } });
    }
  }

  async function createUser(
    suffix: string,
    opts: { role?: "USER" | "ADMIN" } = {}
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}${suffix}${RUN_ID}`,
        displayName: `P10T2 ${suffix}`,
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

  async function get(query: Record<string, string>, cookie?: string) {
    const usp = new URLSearchParams(query);
    const qs = usp.toString();
    return app.inject({
      method: "GET",
      url: qs.length > 0 ? `/admin/audit-logs?${qs}` : "/admin/audit-logs",
      ...(cookie ? { headers: { cookie } } : {}),
    });
  }

  /** 管理員身分查詢，回傳已解析之 body（200 以外即拋，避免斷言誤讀）。 */
  async function getOk(query: Record<string, string>): Promise<AuditLogListBody> {
    const resp = await get(query, adminCookie);
    if (resp.statusCode !== 200) {
      throw new Error(`expected 200, got ${resp.statusCode}: ${resp.body}`);
    }
    return resp.json() as AuditLogListBody;
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    await cleanupSyntheticData();

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "silent" });
    await app.ready();

    adminId = await createUser("admin", { role: "ADMIN" });
    userId = await createUser("user");
    targetUserId = await createUser("target");
    pwdId = await createUser("pwd");
    orderActorId = await createUser("orderact", { role: "ADMIN" });
    enumActorId = await createUser("enumact", { role: "ADMIN" });
    dateActorId = await createUser("dateact", { role: "ADMIN" });
    shapeActorId = await createUser("shapeact", { role: "ADMIN" });
    bulkActorId = await createUser("bulkact", { role: "ADMIN" });
    const ghostId = await createUser("ghost");
    ghostTargetId = ghostId;

    adminCookie = await login("admin");
    userCookie = await login("user");
    targetUserCookie = await login("target");
    pwdCookie = await login("pwd");
    await prisma.user.update({ where: { id: pwdId }, data: { mustChangePassword: true } });

    // ── 排序組（AC-03）：5 列 `createdAt` 完全相同 ─────────────────────────
    for (let i = 0; i < ORDER_ROW_COUNT; i += 1) {
      await prisma.auditLog.create({
        data: {
          action: "USER_ACTIVATED",
          actorId: orderActorId,
          targetId: targetUserId,
          targetLabel: `${ORDER_LABEL_PREFIX}${i}`,
          summary: undefined,
          createdAt: ORDER_CREATED_AT,
        },
      });
    }

    // ── enum 組（AC-04(d)）：10 值各一列 ───────────────────────────────────
    for (const [i, action] of ALL_ACTIONS.entries()) {
      await prisma.auditLog.create({
        data: {
          action,
          actorId: enumActorId,
          targetId: targetUserId,
          targetLabel: `p10t2enum-${action}`,
          summary:
            action === "APPLICATION_VOIDED"
              ? {
                  applicationId: "p10t2-app-void",
                  type: "TRAVEL",
                  reason: VOID_REASON,
                  voidedAt: "2049-05-10T00:00:00.000Z",
                }
              : { note: `合成摘要 ${action}` },
          createdAt: new Date(Date.UTC(2049, 4, 1 + i, 3, 0, 0, 0)),
        },
      });
    }

    // ── 日期組（FW-2／B-07）：四個毫秒級邊界 ──────────────────────────────
    for (const [label, createdAt] of [
      ["lower", DATE_IN_LOWER],
      ["upper", DATE_IN_UPPER],
      ["nextday", DATE_OUT_NEXT_DAY],
      ["prevday", DATE_OUT_PREV_DAY],
    ] as Array<[string, Date]>) {
      await prisma.auditLog.create({
        data: {
          action: "PARAMETER_VERSION_CREATED",
          actorId: dateActorId,
          targetId: null,
          targetLabel: `p10t2date-${label}`,
          createdAt,
        },
      });
    }

    // ── 形狀組（B-11／B-12／B-13）─────────────────────────────────────────
    await prisma.auditLog.create({
      data: {
        action: "USER_DELETED",
        actorId: shapeActorId,
        targetId: null,
        targetLabel: "p10t2shape-nullsummary",
        summary: undefined,
        createdAt: new Date("2049-09-01T00:00:00.000Z"),
      },
    });
    await prisma.auditLog.create({
      data: {
        action: "USER_FUEL_CONSUMPTION_VERSION_CREATED",
        actorId: shapeActorId,
        targetId: null,
        targetLabel: "p10t2shape-nested",
        summary: {
          before: { fuelType: "GASOLINE_95", kmPerLiter: "12.50" },
          after: { fuelType: "DIESEL", kmPerLiter: "14.00" },
          basisNote: BASIS_NOTE,
        },
        createdAt: new Date("2049-09-02T00:00:00.000Z"),
      },
    });
    await prisma.auditLog.create({
      data: {
        action: "APPLICATION_UPDATED_ON_BEHALF",
        actorId: shapeActorId,
        targetId: ghostTargetId,
        targetLabel: "p10t2shape-ghosttarget",
        summary: { purpose: { before: "合成舊目的", after: "合成新目的" } },
        createdAt: new Date("2049-09-03T00:00:00.000Z"),
      },
    });
    // `AuditLog.targetId` 為 `ON DELETE SET NULL`（實查 `20260801101310_phase2_auth/
    // migration.sql` :83）——刪除目標使用者後該列之 `targetId` 自動歸 null。
    await prisma.user.delete({ where: { id: ghostTargetId } });

    // ── 量體組（B-03 clamp ＋ B-23）：120 列 ───────────────────────────────
    await prisma.auditLog.createMany({
      data: Array.from({ length: BULK_ROW_COUNT }, (_, i) => ({
        action: "USER_CREATED" as AuditAction,
        actorId: bulkActorId,
        targetId: null,
        targetLabel: `p10t2bulk-${i}`,
        createdAt: new Date(Date.UTC(2049, 10, 1, 0, 0, 0, i)),
      })),
    });
  }, 60_000);

  afterAll(async () => {
    if (!DB_URL) return;
    await cleanupSyntheticData();
    await app?.close();
    await prisma?.$disconnect();
  });

  // -------------------------------------------------------------------------
  // AC-05 — 授權矩陣五格 ＋ 側信道（B-19／B-20）
  // -------------------------------------------------------------------------

  describe("AC-05 授權矩陣（1 端點 × 5 身分 ＝ 5 格）", () => {
    /** AC-05(c)：4xx 回應零業務值——body 逐鍵只有 `error`，且原文零稽核內容。 */
    function expectNoBusinessValue(resp: { body: string; json: () => unknown }, code: string) {
      const body = resp.json() as AuditLogListBody;
      expect(body.error?.code).toBe(code);
      expect(Object.keys(body)).toEqual(["error"]);
      expect(body.items).toBeUndefined();
      expect(body.total).toBeUndefined();
      expect(body.page).toBeUndefined();
      expect(body.pageSize).toBeUndefined();
      expect(resp.body).not.toContain(ORDER_LABEL_PREFIX);
      expect(resp.body).not.toContain(VOID_REASON);
      expect(resp.body).not.toContain("USER_PASSWORD_RESET");
    }

    it("格 1 — 未登入 → 401 UNAUTHORIZED（B-19）", async () => {
      const resp = await get({});
      expect(resp.statusCode).toBe(401);
      expectNoBusinessValue(resp, "UNAUTHORIZED");
    });

    it("格 2 — mustChangePassword → 403 PASSWORD_CHANGE_REQUIRED（B-19）", async () => {
      const resp = await get({}, pwdCookie);
      expect(resp.statusCode).toBe(403);
      expectNoBusinessValue(resp, "PASSWORD_CHANGE_REQUIRED");
    });

    it("格 3 — 一般使用者 → 403 FORBIDDEN 且零業務值", async () => {
      const resp = await get({}, userCookie);
      expect(resp.statusCode).toBe(403);
      expectNoBusinessValue(resp, "FORBIDDEN");
    });

    it("格 4 — 一般使用者且為稽核列之 target → 403 FORBIDDEN（與格 3 逐字相同）", async () => {
      // 前提自證：該使用者確實是若干稽核列之 target（否則本格恆真）。
      const asTarget = await prisma.auditLog.count({ where: { targetId: targetUserId } });
      expect(asTarget).toBeGreaterThan(0);

      const resp = await get({}, targetUserCookie);
      expect(resp.statusCode).toBe(403);
      expectNoBusinessValue(resp, "FORBIDDEN");

      const plain = await get({}, userCookie);
      expect(resp.statusCode).toBe(plain.statusCode);
      expect((resp.json() as AuditLogListBody).error?.code).toBe(
        (plain.json() as AuditLogListBody).error?.code
      );
    });

    it("格 5 — 管理員 → 200", async () => {
      const resp = await get({}, adminCookie);
      expect(resp.statusCode).toBe(200);
    });

    it("AC-05(b)／B-20 側信道：非管理員送出畸形 `page` → 403（非 400）", async () => {
      const resp = await get({ page: "abc" }, userCookie);
      expect(resp.statusCode).toBe(403);
      expect((resp.json() as AuditLogListBody).error?.code).toBe("FORBIDDEN");

      // 對照：同一畸形參數在管理員身分下確實會得到 400（證明本側信道格有牙）。
      const adminResp = await get({ page: "abc" }, adminCookie);
      expect(adminResp.statusCode).toBe(400);
      expect((adminResp.json() as AuditLogListBody).error?.code).toBe("VALIDATION_ERROR");
    });

    it("AC-05(b)／B-20 側信道：未登入送出畸形 `page` → 401（非 400）", async () => {
      const resp = await get({ page: "abc" });
      expect(resp.statusCode).toBe(401);
      expect((resp.json() as AuditLogListBody).error?.code).toBe("UNAUTHORIZED");
    });

    it("AC-05(b)／B-20 側信道：mustChangePassword 送出畸形 `page` → 403 PASSWORD_CHANGE_REQUIRED（非 400）", async () => {
      const resp = await get({ page: "abc" }, pwdCookie);
      expect(resp.statusCode).toBe(403);
      expect((resp.json() as AuditLogListBody).error?.code).toBe("PASSWORD_CHANGE_REQUIRED");
    });
  });

  // -------------------------------------------------------------------------
  // AC-01 — 端點與回應形狀
  // -------------------------------------------------------------------------

  describe("AC-01 端點與回應形狀", () => {
    it("(a)(b) 200 ＋ 回應 body 為封閉四鍵（多一鍵必紅）", async () => {
      const body = await getOk({ actorId: orderActorId });
      expect(Object.keys(body).sort()).toEqual(RESPONSE_KEYS);
      expect(body.total).toBe(ORDER_ROW_COUNT);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(20);
      expect(body.items).toHaveLength(ORDER_ROW_COUNT);
    });

    it("(c) 零結果 → 200 ＋ items: [] ＋ total: 0（非 404）——B-09 不存在之 actorId", async () => {
      const resp = await get({ actorId: "p10t2-no-such-actor-id" }, adminCookie);
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as AuditLogListBody;
      expect(Object.keys(body).sort()).toEqual(RESPONSE_KEYS);
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("(c)／B-06 合法 action 但零命中 → 200 ＋ 空集", async () => {
      const body = await getOk({ actorId: dateActorId, action: "USER_DELETED" });
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("(d)／B-24 端點零寫入：AuditLog／User／Application 三表逐欄不變", async () => {
      const snapshot = async () => ({
        auditLogs: await prisma.auditLog.findMany({ orderBy: { id: "asc" } }),
        users: await prisma.user.findMany({ orderBy: { id: "asc" } }),
        applications: await prisma.application.findMany({ orderBy: { id: "asc" } }),
      });

      const before = await snapshot();
      // 涵蓋成功、驗證失敗與授權失敗三條路徑，皆不得產生任何寫入。
      expect((await get({ actorId: enumActorId }, adminCookie)).statusCode).toBe(200);
      expect((await get({ page: "abc" }, adminCookie)).statusCode).toBe(400);
      expect((await get({}, userCookie)).statusCode).toBe(403);
      const after = await snapshot();

      expect(after).toEqual(before);
      // 前提自證：三表確實非空（否則「逐欄不變」恆真）。
      expect(before.auditLogs.length).toBeGreaterThan(0);
      expect(before.users.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // AC-03 — 全序排序與跨頁不重不漏
  // -------------------------------------------------------------------------

  describe("AC-03 全序排序與跨頁不重不漏", () => {
    it("(a) 排序恆為 createdAt DESC, id DESC——同 createdAt 之 5 列逐位對照 id 降冪", async () => {
      const body = await getOk({ actorId: orderActorId, pageSize: "100" });
      const ids = (body.items ?? []).map((i) => i.id);
      expect(ids).toHaveLength(ORDER_ROW_COUNT);
      expect(ids).toEqual([...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
    });

    it("(a) 跨不同 createdAt 時以 createdAt 降冪為主鍵", async () => {
      const body = await getOk({ actorId: enumActorId, pageSize: "100" });
      const times = (body.items ?? []).map((i) => new Date(i.createdAt).getTime());
      expect(times).toHaveLength(ALL_ACTIONS.length);
      for (let i = 1; i < times.length; i += 1) {
        expect(times[i - 1]).toBeGreaterThan(times[i]);
      }
    });

    it("(b)／B-10 createdAt 完全相同之 5 列，pageSize=2 跨頁：聯集恰等於全集且零重複", async () => {
      // 前提自證：這 5 列的 `createdAt` 確實完全相同（否則本格不具鑑別力）。
      const rows = await prisma.auditLog.findMany({
        where: { actorId: orderActorId },
        select: { id: true, createdAt: true },
      });
      expect(rows).toHaveLength(ORDER_ROW_COUNT);
      expect(new Set(rows.map((r) => r.createdAt.getTime())).size).toBe(1);
      const expectedIds = rows.map((r) => r.id).sort();
      /** `createdAt` 全同時，全序退化為 `id DESC`——這是跨頁邊界的唯一定錨。 */
      const expectedOrder = [...expectedIds].reverse();

      const pages: string[][] = [];
      let total = -1;
      for (const page of ["1", "2", "3"]) {
        const body = await getOk({ actorId: orderActorId, pageSize: "2", page });
        total = body.total as number;
        pages.push((body.items ?? []).map((i) => i.id));
      }
      const collected = pages.flat();

      expect(total).toBe(ORDER_ROW_COUNT);
      // 零重複
      expect(new Set(collected).size).toBe(collected.length);
      // 聯集恰等於全集
      expect([...collected].sort()).toEqual(expectedIds);
      // 每一頁恰為全序之連續切片——移除 `id` 這層排序鍵後，各頁的邊界不再由
      // 任何確定性鍵定義，本斷言即失守（mutant 必紅之鑑別力所在；只做「聯集
      // 相等」的檢查會在 PostgreSQL 碰巧回傳穩定順序時漏放 mutant）。
      expect(pages[0]).toEqual(expectedOrder.slice(0, 2));
      expect(pages[1]).toEqual(expectedOrder.slice(2, 4));
      expect(pages[2]).toEqual(expectedOrder.slice(4, 5));
    });

    it("B-04／FW-1 `page` 大於總頁數 → 200 ＋ 空集 ＋ 正確 total（含 skip 溢位之 page=1e9／1e21）", async () => {
      const beyond = await getOk({ actorId: orderActorId, pageSize: "2", page: "4" });
      expect(beyond.items).toEqual([]);
      expect(beyond.total).toBe(ORDER_ROW_COUNT);
      expect(beyond.page).toBe(4);

      // FW-1：`page` 僅驗 `^\d+$` 且**無上界**，`(page-1)*pageSize` 隨之無上界。
      // 兩個量級各測一格：
      //   · `1e9`（Packet 指名之值）——本 Task 實測 Prisma 5.22 尚可承受；
      //   · `1e21`（21 位十進位數字，parser 一樣照收）——本 Task 實測 Prisma
      //     會拋 `PrismaClientValidationError` → 未預期例外 → `500`，違 B-04。
      // 兩者皆須為 `200` ＋ 空集 ＋ 正確 `total`（移除 route 層 skip 上界守門
      // 之 mutant，第二格必紅）。
      for (const page of ["1000000000", "1000000000000000000000"]) {
        const overflow = await get({ actorId: orderActorId, pageSize: "20", page }, adminCookie);
        expect(overflow.statusCode, `page=${page}`).toBe(200);
        const overflowBody = overflow.json() as AuditLogListBody;
        expect(Object.keys(overflowBody).sort()).toEqual(RESPONSE_KEYS);
        expect(overflowBody.items).toEqual([]);
        expect(overflowBody.total).toBe(ORDER_ROW_COUNT);
        expect(overflowBody.page).toBe(Number.parseInt(page, 10));
      }
    });

    it("B-03／B-23 pageSize 超上限 → clamp 100（不報錯），單次回應恆 ≤ pageSize", async () => {
      const body = await getOk({ actorId: bulkActorId, pageSize: "101" });
      expect(body.pageSize).toBe(100);
      expect(body.total).toBe(BULK_ROW_COUNT);
      expect(body.items).toHaveLength(100);

      const page2 = await getOk({ actorId: bulkActorId, pageSize: "101", page: "2" });
      expect(page2.items).toHaveLength(BULK_ROW_COUNT - 100);
    });
  });

  // -------------------------------------------------------------------------
  // AC-04 — 列投影
  // -------------------------------------------------------------------------

  describe("AC-04 列投影（AD-US-14② 之四要素）", () => {
    it("(a) AuditLogListItemDto 鍵集封閉為七鍵（多一鍵必紅）", async () => {
      const body = await getOk({ actorId: orderActorId });
      expect(body.items).toHaveLength(ORDER_ROW_COUNT);
      for (const item of body.items ?? []) {
        expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
      }
    });

    it("(b) 操作者＝actorDisplayName；回應零內部識別值（actorId／targetId 不外露）", async () => {
      const resp = await get({ actorId: orderActorId }, adminCookie);
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as AuditLogListBody;
      for (const item of body.items ?? []) {
        expect(item.actorDisplayName).toBe("P10T2 orderact");
      }
      expect(resp.body).not.toContain(orderActorId);
      expect(resp.body).not.toContain(targetUserId);
      expect(resp.body).not.toContain('"actorId"');
      expect(resp.body).not.toContain('"targetId"');
    });

    it("(c) 受影響資料＝targetLabel ＋ targetDisplayName（target 在場時為其顯示名）", async () => {
      const body = await getOk({ actorId: orderActorId });
      for (const item of body.items ?? []) {
        expect(item.targetLabel.startsWith(ORDER_LABEL_PREFIX)).toBe(true);
        expect(item.targetDisplayName).toBe("P10T2 target");
      }
    });

    it("(c)／B-13 target 已被刪除（SET NULL 後）→ targetDisplayName: null，targetLabel 仍為快照", async () => {
      const body = await getOk({ actorId: shapeActorId, action: "APPLICATION_UPDATED_ON_BEHALF" });
      expect(body.items).toHaveLength(1);
      const item = (body.items ?? [])[0];
      expect(item.targetDisplayName).toBeNull();
      expect(item.targetLabel).toBe("p10t2shape-ghosttarget");
      expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
    });

    it("(d) 十個 AuditAction 值逐一皆有一條真實列可被取回並通過 (a)~(c)", async () => {
      for (const action of ALL_ACTIONS) {
        const body = await getOk({ actorId: enumActorId, action });
        expect(body.total, `action=${action}`).toBe(1);
        const item = (body.items ?? [])[0];
        expect(Object.keys(item).sort(), `action=${action}`).toEqual(ITEM_KEYS);
        expect(item.action).toBe(action);
        expect(item.actorDisplayName).toBe("P10T2 enumact");
        expect(item.targetLabel).toBe(`p10t2enum-${action}`);
        expect(item.targetDisplayName).toBe("P10T2 target");
        expect(typeof item.createdAt).toBe("string");
      }
    });

    it("(d) 含 APPLICATION_VOIDED，且作廢原因逐字可見於 changes", async () => {
      const body = await getOk({ actorId: enumActorId, action: "APPLICATION_VOIDED" });
      const item = (body.items ?? [])[0];
      expect(item.changes.map((c) => c.field).sort()).toEqual(
        ["applicationId", "reason", "type", "voidedAt"].sort()
      );
      const reason = item.changes.find((c) => c.field === "reason");
      expect(reason).toEqual({ field: "reason", before: null, after: VOID_REASON });
    });

    it("(e) createdAt 以 ISO 8601 UTC 字串輸出", async () => {
      const body = await getOk({ actorId: orderActorId });
      for (const item of body.items ?? []) {
        expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(item.createdAt).toBe(ORDER_CREATED_AT.toISOString());
      }
    });

    it("B-11 summary 為 null → changes: []（不拋錯）", async () => {
      const body = await getOk({ actorId: shapeActorId, action: "USER_DELETED" });
      expect(body.items).toHaveLength(1);
      expect((body.items ?? [])[0].changes).toEqual([]);
    });

    it('B-12 巢狀混合形 summary → 逐子鍵拆列（3 列）且零 "[object Object]"', async () => {
      const resp = await get(
        { actorId: shapeActorId, action: "USER_FUEL_CONSUMPTION_VERSION_CREATED" },
        adminCookie
      );
      expect(resp.statusCode).toBe(200);
      const item = ((resp.json() as AuditLogListBody).items ?? [])[0];
      // **PHASE-010-T-MG1-BE1**（2026-08-09 Mock Gate MG-1 裁定／`SPEC-REV-010-GATE`
      // 之 AC-06(b-0)）：本形改走 `summary` 級預檢，頂層 `before`／`after` **不各自
      // 成列**，改以兩物件之子鍵聯集逐子鍵拆列（本 fixture 兩側子鍵相同 → 2 子鍵）
      // ＋ 純量 `basisNote` 一列，共 3 列。
      expect(item.changes.map((c) => c.field).sort()).toEqual(
        ["basisNote", "fuelType", "kmPerLiter"].sort()
      );
      // 「改前→改後」於 wire 面對得上（MG-1 裁定之終點）。
      expect(item.changes.find((c) => c.field === "fuelType")).toEqual({
        field: "fuelType",
        before: "GASOLINE_95",
        after: "DIESEL",
      });
      expect(item.changes.map((c) => c.field)).not.toContain("before");
      expect(item.changes.map((c) => c.field)).not.toContain("after");
      expect(item.changes.find((c) => c.field === "basisNote")).toEqual({
        field: "basisNote",
        before: null,
        after: BASIS_NOTE,
      });
      expect(resp.body).not.toContain("[object Object]");
    });

    it("AC-06 {before, after} 兩鍵形 → 拆為 before／after 兩欄", async () => {
      const body = await getOk({ actorId: shapeActorId, action: "APPLICATION_UPDATED_ON_BEHALF" });
      expect((body.items ?? [])[0].changes).toEqual([
        { field: "purpose", before: "合成舊目的", after: "合成新目的" },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // 篩選與邊界（AC-02 之 wire 面；FW-2／FW-3）
  // -------------------------------------------------------------------------

  describe("篩選與邊界（wire 面）", () => {
    it("FW-2 半開區間雙向釘死：dateTo 當日 23:59:59.999Z 必命中 ∧ 次日 00:00:00.000Z 必不命中", async () => {
      const body = await getOk({
        actorId: dateActorId,
        dateFrom: DATE_FROM,
        dateTo: DATE_TO,
        pageSize: "100",
      });
      const labels = (body.items ?? []).map((i) => i.targetLabel).sort();
      expect(labels).toEqual(["p10t2date-lower", "p10t2date-upper"]);
      expect(body.total).toBe(2);

      // 前提自證：四列確實都在 DB（否則「必不命中」恆真）。
      const all = await prisma.auditLog.count({ where: { actorId: dateActorId } });
      expect(all).toBe(4);
      // 且未過濾時四列皆可取回（證明落選是區間所致，非資料不存在）。
      const unfiltered = await getOk({ actorId: dateActorId, pageSize: "100" });
      expect(unfiltered.total).toBe(4);
    });

    it("B-07 dateFrom ＝ dateTo（單日）→ 該日之列全數命中", async () => {
      const body = await getOk({
        actorId: dateActorId,
        dateFrom: DATE_TO,
        dateTo: DATE_TO,
        pageSize: "100",
      });
      expect((body.items ?? []).map((i) => i.targetLabel)).toEqual(["p10t2date-upper"]);
    });

    it('B-05 action 非合法值 → 400 VALIDATION_ERROR ＋ fields[{field:"action"}]', async () => {
      const resp = await get({ action: "BOGUS_ACTION" }, adminCookie);
      expect(resp.statusCode).toBe(400);
      const body = resp.json() as AuditLogListBody;
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expect(body.error?.fields?.map((f) => f.field)).toContain("action");
      expect(body.items).toBeUndefined();
    });

    it('B-01 page ＝ 0／-1／1.5／abc → 400 ＋ fields[{field:"page"}]', async () => {
      for (const page of ["0", "-1", "1.5", "abc"]) {
        const resp = await get({ page }, adminCookie);
        expect(resp.statusCode, `page=${page}`).toBe(400);
        const body = resp.json() as AuditLogListBody;
        expect(body.error?.fields?.map((f) => f.field)).toContain("page");
      }
    });

    it('B-02 pageSize ＝ 0／-5／abc → 400 ＋ fields[{field:"pageSize"}]', async () => {
      for (const pageSize of ["0", "-5", "abc"]) {
        const resp = await get({ pageSize }, adminCookie);
        expect(resp.statusCode, `pageSize=${pageSize}`).toBe(400);
        const body = resp.json() as AuditLogListBody;
        expect(body.error?.fields?.map((f) => f.field)).toContain("pageSize");
      }
    });

    it("B-08 dateFrom > dateTo → 400 ＋ fields[]", async () => {
      const resp = await get({ dateFrom: DATE_TO, dateTo: DATE_FROM }, adminCookie);
      expect(resp.statusCode).toBe(400);
      const body = resp.json() as AuditLogListBody;
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      expect((body.error?.fields ?? []).length).toBeGreaterThan(0);
    });

    it("FW-3 errors 非空即 400 且零查詢——page 合法但 action 非法時仍為 400（不得誤用回傳之分頁值）", async () => {
      const resp = await get({ page: "2", action: "BOGUS_ACTION" }, adminCookie);
      expect(resp.statusCode).toBe(400);
      const body = resp.json() as AuditLogListBody;
      expect(body.page).toBeUndefined();
      expect(body.items).toBeUndefined();
      expect(body.total).toBeUndefined();
    });

    it("重複 query key（string[]）→ 400，不得穿透至 Prisma 而爆 500", async () => {
      const resp = await app.inject({
        method: "GET",
        url: `/admin/audit-logs?actorId=${orderActorId}&actorId=${enumActorId}`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(400);
      expect((resp.json() as AuditLogListBody).error?.code).toBe("VALIDATION_ERROR");
    });

    it("targetId 篩選：命中屬於該 target 之列（B-09 之正向對照）", async () => {
      const body = await getOk({ targetId: targetUserId, pageSize: "100" });
      expect(body.total).toBe(ORDER_ROW_COUNT + ALL_ACTIONS.length);
    });
  });
});
