/**
 * Integration test: PHASE-011-T18 — 帳號類稽核之可靠性（AC-30；§16 D16-5=(i)）
 *
 * 涵蓋（`docs/specs/PHASE-011.md` §2 AC-30 逐字）：
 *   · **AC-30(a)** 現況固化：以測試明確釘住「`writeAudit` 失敗時主操作仍成功」
 *     之**既有語意**，使任何改動成為顯性選擇。
 *   · **AC-30(b)** 依 D16 裁定之改善形式 ＋ 該形式之**失效行為**測試：注入稽核
 *     寫入失敗 → 斷言所選語意之實際結果。**本 Phase 之裁定為 §16 D16-5=(i)
 *     「僅固化現況」**（`docs/specs/PHASE-011.md` :1341 逐字：「**(i)** **僅固化
 *     現況**（AC-30(a)＋(c)＋(d)）：測試釘住「稽核失敗不影響主操作」，並以記載型
 *     `it` 明示「改為同交易須人類裁定」。」；§19 `SPEC-011-GATE` 逐字：
 *     「D16-5=(i)」），故 (b) 之「所選語意」＝**吞掉**（三選項中之第一項），
 *     零行為變更。
 *   · **AC-30(c)** **不得**在未經裁定下把 fire-and-forget 改為同交易——記載型
 *     `it` ＋ 結構固化格（不對稱之機械快照）。
 *   · **AC-30(d)** 失敗時之日誌**不得**記錄 `summary` 內容（可能含作廢原因等自由
 *     文字）——與 AC-28(c)② 同批處理。
 *
 * ---------------------------------------------------------------------------
 * TDD 首紅（現況可靠性缺口之實證）— 本檔之出發點
 * ---------------------------------------------------------------------------
 * 本檔第一版把 §1 的兩格寫成「注入稽核寫入失敗後，`AuditLog` 仍應有該事件之
 * 一列」（＝可靠性**期望**），對現行實作實跑 → **紅**，逐字實證
 * `KNOWN_ISSUES.md` §5-16 所述之缺口：帳號類五事件之稽核在寫入失敗時**靜默
 * 遺失**，主操作仍回 2xx，呼叫端與使用者皆無從察覺。該紅燈輸出見 Task
 * Handoff。**D16-5=(i) 之裁定選擇接受此缺口**（`PHASE-010.md` §16 D11=(a) 已
 * 明示接受），故本檔把該格轉為「固化被接受之現況」：斷言主操作成功 **且**
 * 稽核列確實為零。轉向的是斷言方向，不是鑑別力——見每格附帶之防恆真對照。
 *
 * ---------------------------------------------------------------------------
 * 失敗注入之機制（為何不是 mock 掉 `writeAudit`）
 * ---------------------------------------------------------------------------
 * §1 走**真實 HTTP 端點**（`app.inject`）＋**真實 DB**：僅把交給 `adminPlugin`
 * 的 `PrismaClient` 以 Proxy 包一層，使 `auditLog.create` 拋出，其餘一切
 * （`user.create`／`user.delete`／session／`requireAuth`）皆直通真實 client。
 * 若改以 `vi.mock` 攔截 `writeAudit` 本身，被驗證的就不再是「稽核失敗時主操作
 * 的實際結果」而是 mock 自身，該格將失去全部鑑別力。
 * 直接註冊 `adminPlugin` 於一個獨立 Fastify 實例之作法沿既有先例
 * （`admin-users.test.ts` :798／`phase10-user-delete-regression.test.ts` :976
 * 之 `stubApp`），非本檔新創。
 *
 * ---------------------------------------------------------------------------
 * 測試紀律（§11.0／`CLAUDE.md`）
 * ---------------------------------------------------------------------------
 *   · 全程合成資料（虛構帳號、密碼、員工編號、例外訊息）；零真實個資／secrets。
 *   · `loginName` 前綴 `p11t18`（不含 `_`／`%`，可安全用於 Prisma `startsWith`）
 *     ＋ 每次執行之隨機 `RUN_ID`。
 *   · 清理一律以本檔前綴／id 精確比對；**禁用**全域 `deleteMany({})`。
 *   · 結構掃描格之 mutant 一律為**字串 fixture**，絕不寫回磁碟。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { adminPlugin } from "../../src/admin/routes.js";
import { writeAudit } from "../../src/audit/audit.js";
import { hashPassword } from "../../src/auth/password.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const SRC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src");

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** 刻意不含 `_`／`%`：可安全用於 Prisma `startsWith`（編譯為 SQL LIKE）。 */
const LOGIN_PREFIX = "p11t18";
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin${RUN_ID}`;
const ADMIN_PASSWORD = "Jv6-Cinder-Marlow-4";
/** `POST /admin/users` 之 `temporaryPassword`（合成）。 */
const CREATED_PASSWORD = "Kt8-Bramble-Quartz-3";

// ---------------------------------------------------------------------------
// 哨兵（高辨識度合成字面；使「不含」之斷言為有意義之陳述而非因字面過短而恆真）
// ---------------------------------------------------------------------------

/** 經 `employeeNumber` 進入 `USER_CREATED` 之 `detail`／`summary`。 */
const SUMMARY_SENTINEL = "Zq4-Marrow-Kestrel-SUMMARY-P11T18";
/** 注入例外之 `message`（含合成連線字串，模擬 Prisma 錯誤訊息挾帶之連線資訊）。 */
const ERROR_MESSAGE_SENTINEL =
  "Xw9-Thistle-Verbena-ERRMSG-P11T18 postgresql://synthetic-user:synthetic-pass@synthetic-host:5432/synthetic-db";
/** 注入例外之 `name`（AuditAction 以外之另一個防恆真錨點）。 */
const ERROR_NAME_SENTINEL = "SyntheticAuditWriteError";

function makeInjectedError(): Error {
  const err = new Error(ERROR_MESSAGE_SENTINEL);
  err.name = ERROR_NAME_SENTINEL;
  return err;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0]; // "sid=<token>"
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
    throw new Error(`Login failed with status ${resp.statusCode}: ${resp.body}`);
  }
  return extractCookieHeader(resp.headers["set-cookie"]);
}

/**
 * 以 Proxy 包一層 `PrismaClient`，使 `auditLog.create` 必拋 `error`，其餘一切
 * 存取（含其他 delegate、`$transaction`、`$connect`）直通真實 client。
 * 回傳之 `calls` 為注入點實際被呼叫之次數——用來證明注入確實生效（否則「零
 * 稽核列」有可能只是因為端點根本沒走到稽核寫入）。
 */
function withFailingAuditWrite(
  prisma: PrismaClient,
  error: unknown
): { client: PrismaClient; calls: { count: number } } {
  const calls = { count: 0 };
  const bind = (target: object, prop: string | symbol): unknown => {
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  };
  const client = new Proxy(prisma as object, {
    get(target, prop) {
      if (prop === "auditLog") {
        const delegate = Reflect.get(target, prop, target) as object;
        return new Proxy(delegate, {
          get(delegateTarget, delegateProp) {
            if (delegateProp === "create") {
              return async (): Promise<never> => {
                calls.count += 1;
                throw error;
              };
            }
            return bind(delegateTarget, delegateProp);
          },
        });
      }
      return bind(target, prop);
    },
  }) as PrismaClient;
  return { client, calls };
}

/** 建一個只註冊 `authPlugin` ＋ `adminPlugin` 的獨立 Fastify 實例。 */
async function buildAdminApp(prisma: PrismaClient): Promise<FastifyInstance> {
  const Fastify = (await import("fastify")).default;
  const fastifyCookie = (await import("@fastify/cookie")).default;
  const { registerErrorHandlers } = await import("../../src/platform/error-handler.js");
  const { authPlugin } = await import("../../src/auth/routes.js");

  const app = Fastify({ logger: false });
  registerErrorHandlers(app);
  await app.register(fastifyCookie);
  await app.register(authPlugin, { prisma });
  await app.register(adminPlugin, { prisma });
  await app.ready();
  return app;
}

/** 把 `console.error` 之全部呼叫引數攤平成單一字串（哨兵掃描對象）。 */
function serializeLogArgs(calls: unknown[][]): string {
  return calls
    .map((args) =>
      args
        .map((a) => {
          if (typeof a === "string") return a;
          if (a instanceof Error) return `${a.name}|${a.message}|${a.stack ?? ""}`;
          try {
            return JSON.stringify(a) ?? String(a);
          } catch {
            return String(a);
          }
        })
        .join(" ")
    )
    .join("\n");
}

// ===========================================================================
// §1 AC-30(a) — 現況固化：真實端點 × 真實 DB × 注入稽核寫入失敗
// ===========================================================================

describeWithDb("PHASE-011-T18 §1 AC-30(a) 現況固化 — 稽核寫入失敗時主操作仍成功", () => {
  let prisma: PrismaClient;
  /** 稽核寫入必失敗之 app（`adminPlugin` 收到被包過的 client）。 */
  let failingApp: FastifyInstance;
  /** 對照 app：完全真實之 client（防恆真用）。 */
  let controlApp: FastifyInstance;
  let injectedCalls: { count: number };
  let adminId: string;
  let adminCookie: string;

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "T18 稽核可靠性管理員",
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    adminId = admin.id;

    const injected = withFailingAuditWrite(prisma, makeInjectedError());
    injectedCalls = injected.calls;
    failingApp = await buildAdminApp(injected.client);
    controlApp = await buildAdminApp(prisma);
    adminCookie = await loginUser(controlApp, ADMIN_LOGIN, ADMIN_PASSWORD);
  });

  afterAll(async () => {
    if (!DB_URL) return;
    await failingApp?.close();
    await controlApp?.close();
    await prisma.auditLog.deleteMany({ where: { targetLabel: { startsWith: LOGIN_PREFIX } } });
    await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.session.deleteMany({
      where: { user: { loginName: { startsWith: LOGIN_PREFIX } } },
    });
    await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
    await prisma.$disconnect();
  });

  it("AC-30(a)①: POST /admin/users 之稽核寫入失敗 → 仍 201，使用者確實落庫，該事件之稽核列為零（靜默遺失）", async () => {
    const login = `${LOGIN_PREFIX}created${RUN_ID}`;
    const before = injectedCalls.count;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let resp: Awaited<ReturnType<FastifyInstance["inject"]>>;
    try {
      resp = await failingApp.inject({
        method: "POST",
        url: "/admin/users",
        headers: { cookie: adminCookie },
        payload: {
          loginName: login,
          displayName: "T18 新建使用者",
          employeeNumber: SUMMARY_SENTINEL,
          temporaryPassword: CREATED_PASSWORD,
        },
      });
    } finally {
      spy.mockRestore();
    }

    // 主操作成功（AC-30(a) 之被固化語意）。
    expect(resp.statusCode).toBe(201);
    const created = await prisma.user.findUnique({ where: { loginName: login } });
    expect(created).not.toBeNull();
    expect(created?.employeeNumber).toBe(SUMMARY_SENTINEL);

    // 注入確實生效（否則下一條「零稽核列」無鑑別力）。
    expect(injectedCalls.count).toBe(before + 1);

    // 被 §16 D16-5=(i) 明示接受之現況：稽核靜默遺失（首紅即此格之期望版所實證，
    // 見檔頭「TDD 首紅」）。
    const rows = await prisma.auditLog.findMany({ where: { targetLabel: login } });
    expect(rows).toHaveLength(0);
  });

  it("AC-30(a)②: DELETE /admin/users/:id 之稽核寫入失敗 → 仍 200，使用者確實消失，而該次刪除之唯一紀錄一併遺失", async () => {
    const login = `${LOGIN_PREFIX}deleted${RUN_ID}`;
    const victim = await prisma.user.create({
      data: {
        loginName: login,
        displayName: "T18 待刪使用者",
        passwordHash: await hashPassword(CREATED_PASSWORD),
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });

    const before = injectedCalls.count;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let resp: Awaited<ReturnType<FastifyInstance["inject"]>>;
    try {
      resp = await failingApp.inject({
        method: "DELETE",
        url: `/admin/users/${victim.id}`,
        headers: { cookie: adminCookie },
      });
    } finally {
      spy.mockRestore();
    }

    expect(resp.statusCode).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: victim.id } })).toBeNull();
    expect(injectedCalls.count).toBe(before + 1);
    // 使用者已不存在且稽核列為零 ⇒ 這次刪除在系統中**不留任何痕跡**（同上，
    // 為 §16 D16-5=(i) 明示接受之現況）。
    expect(await prisma.auditLog.findMany({ where: { targetLabel: login } })).toHaveLength(0);
  });

  it("防恆真對照：同一端點、未注入失敗 → 201 且稽核列恰一條（證明零列不是因為端點根本不寫稽核）", async () => {
    const login = `${LOGIN_PREFIX}control${RUN_ID}`;
    const resp = await controlApp.inject({
      method: "POST",
      url: "/admin/users",
      headers: { cookie: adminCookie },
      payload: {
        loginName: login,
        displayName: "T18 對照使用者",
        employeeNumber: SUMMARY_SENTINEL,
        temporaryPassword: CREATED_PASSWORD,
      },
    });
    expect(resp.statusCode).toBe(201);
    const rows = await prisma.auditLog.findMany({ where: { targetLabel: login } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("USER_CREATED");
  });
});

// ===========================================================================
// §2 AC-30(b) — 依 D16-5=(i) 之改善形式（僅固化現況）與其失效行為（＝吞掉）
// ===========================================================================

/** `writeAudit` 之最小 prisma 替身：只提供 `auditLog.create`。 */
function makeStubPrisma(behaviour: () => Promise<unknown>): {
  client: PrismaClient;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const client = {
    auditLog: {
      create: async (args: unknown) => {
        calls.push(args);
        return behaviour();
      },
    },
  } as unknown as PrismaClient;
  return { client, calls };
}

const BASE_PARAMS = {
  actorId: "p11t18-actor",
  action: "USER_DEACTIVATED" as const,
  targetId: "p11t18-target",
  targetLabel: `${LOGIN_PREFIX}stub`,
  detail: { isActive: { from: true, to: false } },
};

describe("PHASE-011-T18 §2 AC-30(b) 失效行為 — 裁定形式 (i)「僅固化現況」之語意＝吞掉", () => {
  it("AC-30(b)①: 注入 create 失敗 → writeAudit resolves（吞掉，不外傳），且 create 確被呼叫一次", async () => {
    const stub = makeStubPrisma(() => Promise.reject(makeInjectedError()));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(writeAudit({ prisma: stub.client, ...BASE_PARAMS })).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(stub.calls).toHaveLength(1);
  });

  it("AC-30(b)②: 非 Error 之拋出物（字串）同樣被吞掉，不外傳", async () => {
    const stub = makeStubPrisma(() => Promise.reject("plain-string-rejection-p11t18"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(writeAudit({ prisma: stub.client, ...BASE_PARAMS })).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(stub.calls).toHaveLength(1);
  });

  it("AC-30(b)③ 防恆真：成功路徑 → create 收到逐欄參數（吞掉不是因為根本沒送出寫入）", async () => {
    const stub = makeStubPrisma(() => Promise.resolve({ id: "p11t18-row" }));
    await expect(writeAudit({ prisma: stub.client, ...BASE_PARAMS })).resolves.toBeUndefined();
    expect(stub.calls).toEqual([
      {
        data: {
          action: BASE_PARAMS.action,
          actorId: BASE_PARAMS.actorId,
          targetId: BASE_PARAMS.targetId,
          targetLabel: BASE_PARAMS.targetLabel,
          summary: BASE_PARAMS.detail,
        },
      },
    ]);
  });

  it("AC-30(b)④ 鑑別力自證：同型但**不吞**之區域複本必 reject（證明上方 resolves 斷言非恆真）", async () => {
    // 區域複本，只為證明 `resolves` 斷言有鑑別力；不寫回磁碟、不被任何產品程式引用。
    const writeAuditWithoutSwallow = async (client: PrismaClient): Promise<void> => {
      await client.auditLog.create({ data: {} as never });
    };
    const stub = makeStubPrisma(() => Promise.reject(makeInjectedError()));
    await expect(writeAuditWithoutSwallow(stub.client)).rejects.toThrow(ERROR_MESSAGE_SENTINEL);
  });
});

// ===========================================================================
// §3 AC-30(d) — 失敗日誌之內容邊界
// ===========================================================================

describe("PHASE-011-T18 §3 AC-30(d) 失敗日誌不記 summary 內容（含 err.message／stack）", () => {
  async function captureFailureLog(): Promise<string> {
    const stub = makeStubPrisma(() => Promise.reject(makeInjectedError()));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeAudit({
        prisma: stub.client,
        ...BASE_PARAMS,
        detail: { reason: SUMMARY_SENTINEL },
      });
      return serializeLogArgs(spy.mock.calls as unknown[][]);
    } finally {
      spy.mockRestore();
    }
  }

  it("AC-30(d)①: 失敗日誌不含 summary 內容、不含 err.message、不含 stack 幀", async () => {
    const logged = await captureFailureLog();
    expect(logged).not.toBe("");
    expect(logged).not.toContain(SUMMARY_SENTINEL);
    expect(logged).not.toContain(ERROR_MESSAGE_SENTINEL);
    expect(logged).not.toContain("postgresql://");
    expect(logged).not.toContain("phase11-audit-reliability");
    expect(logged).not.toMatch(/\n\s*at\s+/);
  });

  it("AC-30(d)② 防恆真：日誌確實有寫，且只帶分類標籤（err.name）", async () => {
    const logged = await captureFailureLog();
    expect(logged).toContain(ERROR_NAME_SENTINEL);
  });

  it("AC-30(d)③ AR-4（T16 即審建議）：失敗日誌帶 action（AuditAction 封閉值域，零自由文字），恢復「哪一筆稽核寫失敗」之脈絡", async () => {
    const logged = await captureFailureLog();
    expect(logged).toContain(BASE_PARAMS.action);
    // 仍不得帶 targetLabel（帳號名）與 summary 內容。
    expect(logged).not.toContain(BASE_PARAMS.targetLabel);
    expect(logged).not.toContain(SUMMARY_SENTINEL);
  });

  it("哨兵鑑別力自證：同一組斷言對「含哨兵之合成日誌」必失敗（證明上方 not.toContain 非恆真）", () => {
    const positive = `[audit] Failed to write AuditLog: ${ERROR_MESSAGE_SENTINEL} ${SUMMARY_SENTINEL}`;
    expect(positive).toContain(SUMMARY_SENTINEL);
    expect(positive).toContain(ERROR_MESSAGE_SENTINEL);
    expect(positive).toContain("postgresql://");
  });
});

// ===========================================================================
// §4 AC-30(c) — 記載型 it ＋ 不對稱之結構固化
// ===========================================================================

/** 去除區塊註解與行註解，以等長空白取代（沿 `phase10-audit-structure.test.ts`
 * 之 `stripComments` 同型設計，刻意複製而非 import 測試檔）。 */
function stripComments(content: string): string {
  const noBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlockComments.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function listTsFilesRecursive(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listTsFilesRecursive(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
      files.push(fullPath);
  }
  return files;
}

/** 同交易寫入：`tx.auditLog.create(`／`(tx as PrismaClient).auditLog.create(`。 */
const TX_AUDIT_CREATE =
  /(?:\btx\s*\.|\(\s*tx\s+as\s+PrismaClient\s*\)\s*\.)\s*auditLog\s*\.\s*create\s*\(/g;
/** 非同交易寫入：`prisma.auditLog.create(`（今日恰為 `audit/audit.ts` 之唯一一處）。 */
const PRISMA_AUDIT_CREATE = /\bprisma\s*\.\s*auditLog\s*\.\s*create\s*\(/g;
/** `writeAudit({` 呼叫端。 */
const WRITE_AUDIT_CALL = /\bwriteAudit\s*\(\s*\{/g;

function countAuditShapes(content: string): {
  sameTransaction: number;
  fireAndForget: number;
  callers: number;
} {
  const cleaned = stripComments(content);
  return {
    sameTransaction: [...cleaned.matchAll(TX_AUDIT_CREATE)].length,
    fireAndForget: [...cleaned.matchAll(PRISMA_AUDIT_CREATE)].length,
    callers: [...cleaned.matchAll(WRITE_AUDIT_CALL)].length,
  };
}

function countAuditShapesInSrc(): ReturnType<typeof countAuditShapes> {
  const totals = { sameTransaction: 0, fireAndForget: 0, callers: 0 };
  for (const file of listTsFilesRecursive(SRC_ROOT)) {
    const c = countAuditShapes(fs.readFileSync(file, "utf8"));
    totals.sameTransaction += c.sameTransaction;
    totals.fireAndForget += c.fireAndForget;
    totals.callers += c.callers;
  }
  return totals;
}

describe("PHASE-011-T18 §4 AC-30(c) 未經裁定不得改同交易 — 記載型 ＋ 結構固化", () => {
  it("AC-30(c) 記載型：**未經人類裁定不得**把帳號類五事件之 fire-and-forget 改為同交易（現行裁定＝§16 D16-5=(i) 僅固化現況）", () => {
    // 本 it 為**記載型**（Spec :1341「以記載型 `it` 明示『改為同交易須人類裁定』」）。
    // 它斷言的是：該項裁定與其理由**逐字寫在 `audit/audit.ts` 的檔頭裡**，使
    // 下一位改動者在打開該檔的第一時間就看得到，而不只是躺在 Spec 或本測試檔。
    // 理由（AC-30(c) 逐字）：改同交易會使管理操作因稽核失敗而 500，屬**使用者
    // 可見行為變更**，`PHASE-010.md` §16 D11 已裁定接受現況。
    const auditSource = fs.readFileSync(path.join(SRC_ROOT, "audit/audit.ts"), "utf8");
    expect(auditSource).toContain("D16-5=(i)");
    expect(auditSource).toContain("AC-30(c)");
    expect(auditSource).toContain("未經人類裁定不得改為同交易");
  });

  it("AC-30(c) 結構固化：不對稱之機械快照 — 同交易 12 處／fire-and-forget 1 處（其呼叫端 5 處）", () => {
    // 這組數字就是「不對稱」本身（`KNOWN_ISSUES.md` §5-16）：12 處稽核寫入與其
    // 業務寫入同交易，僅帳號類五事件經 `writeAudit` 走非交易之 best-effort 路徑。
    // 任何人把五處改成同交易（或反向擴散 fire-and-forget），本格即紅，強迫他回到
    // §16 D16-5 重新取得人類裁定。
    //
    // PHASE-011-T18R（AR-4）翻紅之後怎麼辦，兩種情形不同：
    //   · **合法新增（或移除）同交易稽核站點**（本格與 D16-5 之語意無關）：同批更新
    //     此處三個數字 ＋ `phase10-audit-structure.test.ts` 之 `AUDIT_CREATE_SITE_BASELINE`
    //     ＋ `phase11-attachment-cleanup.test.ts` 之 `DECLARED_AUDIT_WRITE_SITES`
    //     （三處互為佐證：同交易 ＋ fire-and-forget ＝ 站點總數），並於 commit message
    //     說明新增之站點與理由。**不需**回 §16。
    //   · **改變 fire-and-forget 之語意本身**（把帳號類五事件改成同交易、或把 best-effort
    //     擴散到其他站點）：屬 AC-30(c) 之範圍，**必須**先回 §16 D16-5 取得人類裁定，
    //     不得逕行改數字消紅。
    expect(countAuditShapesInSrc()).toEqual({
      sameTransaction: 12,
      fireAndForget: 1,
      callers: 5,
    });
  });

  it("AC-30(c) 結構固化：`audit/audit.ts` 全檔零交易語彙（`$transaction`／`tx.`）", () => {
    const cleaned = stripComments(fs.readFileSync(path.join(SRC_ROOT, "audit/audit.ts"), "utf8"));
    expect(cleaned).not.toContain("$transaction");
    expect(cleaned).not.toMatch(/\btx\s*\./);
  });

  it("mutant 自證＋還原：把 `audit.ts` 之寫入改成同交易形之 fixture → 分類立刻翻轉（fixture 不寫回磁碟）", () => {
    const real = fs.readFileSync(path.join(SRC_ROOT, "audit/audit.ts"), "utf8");
    const mutant = real.replace("await prisma.auditLog.create({", "await tx.auditLog.create({");
    expect(mutant).not.toBe(real); // 替換確實命中（否則本 mutant 無效）
    expect(countAuditShapes(mutant)).toMatchObject({ sameTransaction: 1, fireAndForget: 0 });
    expect(countAuditShapes(real)).toMatchObject({ sameTransaction: 0, fireAndForget: 1 });
    // 磁碟內容未被更動。
    expect(fs.readFileSync(path.join(SRC_ROOT, "audit/audit.ts"), "utf8")).toBe(real);
  });
});
