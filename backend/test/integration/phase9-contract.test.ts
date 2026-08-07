/**
 * PHASE-009-T4 — 作廢端點之授權矩陣、錯誤合約與日誌安全（AC-23／AC-25／
 * AC-27，含 AC-05(b) 之端點層四格）
 *
 * ---------------------------------------------------------------------------
 * 規範出處（Spec `docs/specs/PHASE-009.md`，逐條原文見各 § 區塊註解）
 * ---------------------------------------------------------------------------
 * AC-05(b)（:165）：對已作廢申請呼叫完成端點 → 403 `FORBIDDEN` 且訊息沿既有
 *   `ALREADY_FINAL_MESSAGE`；作廢端點 → 409 `CONFLICT`；`PUT` 三型更新端點
 *   → 403；`DELETE` → 403。四者皆零寫入。
 * AC-23（:213）：授權矩陣 2 端點 × 5 身分 ＝ 10 格。**本檔僅交付作廢端點之
 *   5 格**；修正版端點（`POST /applications/:id/revision`）之 5 格屬 **T7**，
 *   見下方「T7 留白清單」。另含「報表四端點於 `VOIDED` 之回歸四格」與
 *   「403 回應零業務值掃描」。
 * AC-25（:217）：`AuditLog.summary` 與日誌流零敏感資料；作廢原因入稽核（BE-
 *   US-31② 既定要求）但**不得**進入 `request.log` 之任何一行；反向探針證明
 *   掃描機制非恆真。
 * AC-27（:223）：`ErrorCode` 聯集與 PHASE-008 結案基線逐字相同（本 Phase 零
 *   新增碼，BOGUS mutant 必紅）；新端點之錯誤表（§7.5）逐格驗證：401／403／
 *   404／409（含 `details.status`）／400（`fields[]`）／500。
 *   `details.existingRevisionId` 一格屬修正版端點 → **T7**。
 * §6.1 判定紀律：①授權（401／403）一律先於狀態守門（409）與欄位驗證（400）
 *   ——他人之草稿／已完成／已作廢三種狀態之回應**逐字相同**；②授權權威恆為
 *   DB 查得之 `ownerId`；③403 回應零業務值。
 *
 * ---------------------------------------------------------------------------
 * T7 留白清單（T4 開列；1./2. 已由 **T7** 於本檔 §I〜§L 就地補齊，
 * 4. 已由 **T12b** 於 §D 就地補齊，3. 仍留 T13）
 * ---------------------------------------------------------------------------
 *   1. ✅ **T7 已補齊**（§I／§J）：AC-23 之修正版端點 5 格（未登入／強制改密
 *      ／本人 201／他人 403／管理員 201 且 `ownerId` ＝原擁有人）＋ 側信道
 *      三態指紋。
 *   2. ✅ **T7 已補齊**（§K／§L）：AC-27 之 `409 + details.existingRevisionId`
 *      一格（§7.5「已有修正版」列）；修正版端點之 401／403／404／
 *      409(`details.status`)／500 各格；`PHASE_009_VOID_SRC_FILES` 擴列修正版
 *      面兩檔（見 §A）。**T7b 補**：§7.5 之「申請擁有人**已停用**（**僅修正版
 *      端點**）→ 400 `VALIDATION_ERROR`」一格（B-16；`SPEC-REV-9T7` 補格）已
 *      於 §K 就地補齊——T7 交付時該格之「400 不適用」表述只對 §7.3 之 **body
 *      驗證** 面成立，B-16 之 400 來自**擁有人狀態**而非 body。
 *   3. ✅ **T13 已補齊**（§D）：AC-23 回歸四格中「列印端點於 `VOIDED` → 200」之
 *      **狀態碼**斷言（AC-22／D5：列印端點狀態守門由 `COMPLETED` 放行為
 *      `COMPLETED ∪ VOIDED`）。T4／T7／T12b 交付當時本檔對列印端點僅斷言**授
 *      權面**（401／403）與 `COMPLETED` 時逐字相同——即 §6.1 回歸格所要求之
 *      「四格之授權判定（401／403）與 `COMPLETED` 時逐字相同」——刻意不釘樁
 *      擁有人視角之狀態碼，以免 T13 放行後必須回頭修改本檔。**T13 補齊之
 *      格**：擁有人／管理員對已作廢申請列印皆 **200 text/html** 且含
 *      `.void-banner` 作廢標示；未作廢之同型申請為零標示之對照。列印版**內
 *      容**面之完整覆蓋（AC-20 標示三欄、XSS wire 探針、charset、授權五格逐
 *      格）屬 `phase8-report-print.test.ts` §K，本檔僅釘樁授權矩陣所要求之
 *      **狀態碼**（沿第 4 點之同一分工）。
 *   4. ✅ **T12b 已補齊**（§D）：AC-23 回歸四格中「**下載端點於 `VOIDED` →
 *      200**（依 §16 **D4**(b1)）」一格。T4 即審 **SF-1／FW-A** 開列此留白之
 *      理由：該格所要釘樁的**語意**（200 ＝ 回**作廢版**位元組）須待 D4(b1)
 *      之作廢版 PDF 落地（AC-21(a)，T12a）方有意義——T4／T7 交付當時
 *      `VoidedReportFile` 尚無寫入路徑，釘樁 200 只能證明「回了原檔」，與
 *      D4 裁定前之既有行為無異，故當時留白。
 *      **⚠ 不是「狀態不可達」**：`voidApplication`（T3，`d94cc62`）對
 *      `Report` **零互動**（AC-21(f)），故「已作廢**且有** `Report`」之申請
 *      自 T3 起即可達，T4／T7 以直寫手法本就能建構——本項留白是**語意時
 *      序**問題，不是資料可達性問題。此一區別有實質後果：T3〜T12a 之間被作
 *      廢的含報表申請，正是「`VOIDED` 但無 `VoidedReportFile`」之**真實歷
 *      史資料**，故 `reports/routes.ts` 之 fallback（回原檔）**非死碼**，不
 *      得據「該狀態不可達」之推論移除。
 *      **T12b 補齊之格**：已作廢**且有** `Report` 之申請，擁有人與管理員下
 *      載皆 **200**。位元組面（回作廢版、編號不變、重複下載全等且渲染器零呼
 *      叫，AC-21(b)(d)）屬 `phase9-void-report.test.ts` §E，本檔僅釘樁授權矩
 *      陣所要求之**狀態碼**。
 *
 * ---------------------------------------------------------------------------
 * TDD 與紅燈實錄（Task Handoff 附完整輸出）
 * ---------------------------------------------------------------------------
 * 本檔開工時 `POST /applications/:id/void` 端點尚不存在（T3 僅交付
 * `voidApplication` service，`routes.ts` 屬 T4 之 Files Allowed）——§B/§E/§F
 * 全部斷言在 `routes.ts` 接線前皆為紅（404 Fastify route not found）。
 *
 * Mutant 自證（暫改後復原，不入最終 diff）：
 *   ① 稽核移出交易（route 之 `onVoided` hook 改為 `voidApplication` 回傳後才
 *      寫 `auditLog`）→ §F-500「同交易端點層自證」必紅（狀態變為 VOIDED）。
 *   ② 授權判定順序對調（409 早於 403）→ §C 側信道測試必紅。
 *   ③ `ErrorCode` 聯集加入 BOGUS 成員 → §A 必紅。
 *
 * 紀律（Spec §11.0）：合成資料；`loginName` 前綴 `p9t4_`（與既有測試檔互不
 * 重疊）；清理一律以本檔自建 id 精確比對，禁用全域 `deleteMany({})`；禁止
 * spawn 任何 subagent。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";
import { LocalVolumeStorage } from "../../src/storage/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p9t4_";
const PASSWORD = "T4ContractFixtureP@ss99";
const NONEXISTENT_ID = "clnonexistentapplication0000";

// ===========================================================================
// §A — AC-27 結構性：`ErrorCode` 聯集全等（本 Phase 零新增碼）
//
// AC-27 逐字：「`errors.ts` 之 `ErrorCode` 聯集與 PHASE-008 結案基線**逐字
// 相同**（BOGUS mutant 必紅）」。基線陣列與 `phase8-contract.test.ts` 之
// `KNOWN_ERROR_CODES` 同名陣列逐字相同（十四碼）——本 Phase 一碼不增。
//
// T3 即審 FW（Packet 逐條核銷第 2 項）：錯誤碼來源掃描之檔案清單須納入本
// Phase 於 `src/applications/` 新增之兩檔（`void-reason.ts`／
// `application-void.ts`）＋ 接線所在之 `routes.ts`。清單本身以「與目錄實際
// 內容比對」自證（新增 src 檔而未同步清單即紅），避免清單腐化成恆真。
// ===========================================================================

describe("AC-27 結構性 — ErrorCode 聯集全等（本 Phase 零新增碼）＋ applications/ 僅用基線字面值", () => {
  const errorsSrc = fs.readFileSync(path.join(BACKEND_ROOT, "src/platform/errors.ts"), "utf-8");

  /** PHASE-008 結案基線（十四碼）——本 Phase **零新增**（AC-27／§7.5 表頭
   * 逐字「本 Phase 零新增 `ErrorCode`」）。與
   * `phase8-contract.test.ts:236` 之同名陣列逐字相同。 */
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

  it("AC-27: errors.ts 之 ErrorCode 聯集與 PHASE-008 結案基線逐字相同（多一碼／少一碼／BOGUS mutant 必紅）", () => {
    const unionMatch = /export type ErrorCode =([\s\S]*?";)/.exec(errorsSrc);
    expect(unionMatch, "ErrorCode union declaration not found").toBeTruthy();
    const unionBody = unionMatch?.[1] ?? "";
    const unionBodyNoComments = unionBody.replace(/\/\/.*$/gm, "");
    const members = [...unionBodyNoComments.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
    expect(members).toEqual(KNOWN_ERROR_CODES);
    // 正向對照：確實抓到十四個成員（非因正則失配而空陣列恆真）。
    expect(members.length).toBe(14);
  });

  /**
   * 本 Phase 之申請面 src 檔——**掃描面**之定義是「本 Phase 新增或接線、且會
   * 自行拋出 `AppError` 的 src 檔」。
   *
   *   · T3 新增兩檔：`void-reason.ts`／`application-void.ts`（作廢面）。
   *   · T4／T7 接線：`routes.ts`（兩個新端點皆掛於此）。
   *   · **T7 擴列（Packet FW-8）**：
   *     - `src/applications/application-revision.ts`（T5）：修正版 service，
   *       自拋 `CONFLICT`（兩處守門）與 `INTERNAL_ERROR`（子列缺席）。
   *     - `src/attachment/attachment-copy.ts`（T6）：修正版**唯一** production
   *       入口 `createApplicationRevisionWithAttachments` 所在，自拋
   *       `INTERNAL_ERROR`（對位不一致／複製失敗之 log-safe 轉譯）。雖位於
   *       `src/attachment/`，其錯誤碼是**修正版端點**回應之一部分（§7.5
   *       「附件複製失敗 → 500 `INTERNAL_ERROR`」列），故屬本 Phase 掃描
   *       面；下方清單自證即依此分目錄核對。
   */
  const PHASE_009_VOID_SRC_FILES = [
    "src/applications/void-reason.ts",
    "src/applications/application-void.ts",
    "src/applications/application-revision.ts",
    "src/applications/routes.ts",
    "src/attachment/attachment-copy.ts",
  ];

  it("AC-27: 本 Phase 掃描面五檔（作廢三檔 ＋ 修正版兩檔）僅使用基線 ErrorCode 字面值", () => {
    const usedCodes = new Set<string>();
    let filesSeen = 0;
    for (const rel of PHASE_009_VOID_SRC_FILES) {
      const abs = path.join(BACKEND_ROOT, rel);
      expect(fs.existsSync(abs), `${rel} 不存在`).toBe(true);
      filesSeen++;
      const content = fs.readFileSync(abs, "utf-8");
      for (const m of content.matchAll(/new AppError\(\s*"([A-Z_]+)"/g)) usedCodes.add(m[1]);
      for (const m of content.matchAll(/buildErrorBody\(\s*"([A-Z_]+)"/g)) usedCodes.add(m[1]);
    }
    expect(filesSeen).toBe(PHASE_009_VOID_SRC_FILES.length);
    // 正向對照：確實有掃到字面值（非因正則失配而恆真通過）。
    expect(usedCodes.size).toBeGreaterThan(0);
    // 作廢流程實際會用到的三碼確實在場（§7.5 表：400／403／409）。
    expect(usedCodes).toContain("VALIDATION_ERROR");
    expect(usedCodes).toContain("CONFLICT");
    expect(usedCodes).toContain("NOT_FOUND");
    for (const code of usedCodes) {
      expect(KNOWN_ERROR_CODES).toContain(code);
    }
  });

  it("AC-27 清單自證: PHASE_009_VOID_SRC_FILES 之五檔皆為實際成員，且作廢面／修正版面之檔名族群無遺漏（新增本 Phase src 檔而未同步清單即紅）", () => {
    // 每一列各自回到其所屬目錄核對（T7 擴列後清單橫跨 `src/applications/`
    // 與 `src/attachment/` 兩目錄，不能再以單一目錄之 basename 比對）。
    for (const rel of PHASE_009_VOID_SRC_FILES) {
      const dir = path.join(BACKEND_ROOT, path.dirname(rel));
      const actual = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
      expect(actual, `${rel} 不是 ${path.dirname(rel)} 之實際成員`).toContain(path.basename(rel));
    }

    // 反向：以檔名族群自證「沒有漏列」。作廢面 ＝ `src/applications/` 內含
    // `void-`／`-void` 者；修正版面 ＝ `src/applications/` 內含 `-revision`
    // 者 ＋ `src/attachment/` 內含 `-copy` 者。任一族群多出新檔而未列入清
    // 單，本斷言即紅（清單腐化守門，T4 即審 FW-D）。
    const applicationsFiles = fs
      .readdirSync(path.join(BACKEND_ROOT, "src/applications"))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const attachmentFiles = fs
      .readdirSync(path.join(BACKEND_ROOT, "src/attachment"))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

    const voidFaceFiles = applicationsFiles.filter(
      (f) => f.startsWith("void-") || f.includes("-void")
    );
    expect(voidFaceFiles.sort()).toEqual(["application-void.ts", "void-reason.ts"]);

    const revisionFaceFiles = [
      ...applicationsFiles.filter((f) => f.includes("-revision")),
      ...attachmentFiles.filter((f) => f.includes("-copy")),
    ].sort();
    expect(revisionFaceFiles).toEqual(["application-revision.ts", "attachment-copy.ts"]);

    // 兩族群之四檔皆須在清單內（移除任一擴列項即紅）。
    for (const basename of [...voidFaceFiles, ...revisionFaceFiles]) {
      expect(PHASE_009_VOID_SRC_FILES.map((rel) => path.basename(rel))).toContain(basename);
    }
  });
});

// ===========================================================================
// DB-backed helpers
// ===========================================================================

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

function makeTempStorageRoot(prefixLabel: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `phase9-contract-${prefixLabel}-`));
}

function removeTempStorageRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

function makeLogCapture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, stream };
}

/**
 * log 行為 JSON 序列化字串——含反斜線之值（Windows 絕對路徑）於行內會被跳
 * 脫為兩個反斜線，直接以原始字串比對在 Windows 上恆假（vacuous pass）。沿
 * `phase8-contract.test.ts` 之同名 helper（各 Phase contract 檔各自持有一
 * 份複本，避免跨 Phase 測試檔之隱性耦合）。
 */
function toLogSearchable(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    fields?: Array<{ field?: string; reason?: string }>;
    details?: Record<string, unknown>;
  };
}

/** §7.5 尾句：錯誤回應不外洩堆疊、DB 結構、storage key 或絕對路徑。 */
function expectNoLeakage(body: ErrorBody) {
  expect(body.error).toBeDefined();
  const errorObj = body.error as Record<string, unknown>;
  expect(typeof errorObj.code).toBe("string");
  expect(typeof errorObj.message).toBe("string");
  expect(typeof errorObj.requestId).toBe("string");
  expect((errorObj.requestId as string).length).toBeGreaterThan(0);

  const serialized = JSON.stringify(body);
  expect(serialized).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // 堆疊行樣式
  expect(serialized).not.toMatch(/[A-Za-z]:\\\\?[\w\\/. -]+\.ts/); // Windows 絕對路徑
  expect(serialized).not.toMatch(/\/(home|usr|Users)\/[\w./-]+/); // POSIX 絕對路徑
  expect(serialized.toUpperCase()).not.toMatch(/\bSELECT\b|\bINSERT\b|\bPRISMACLIENT/i);
  expect(serialized).not.toMatch(/\brpt\//);
  expect(serialized).not.toMatch(/\batt\//);
}

/** 去除 `requestId`（每次請求必然不同）後之回應指紋——供「逐字相同」比對。 */
function responseFingerprint(resp: { statusCode: number; body: string }): string {
  const parsed = JSON.parse(resp.body) as ErrorBody;
  if (parsed.error) parsed.error.requestId = "<redacted>";
  return `${resp.statusCode}|${JSON.stringify(parsed)}`;
}

// 業務值標記（403 零業務值掃描用）——刻意選用不會與 id／時間戳巧合重疊之
// 字面值。
const PURPOSE_MARKER = "洽公行程標記4718293";
const OWNER_DISPLAY_MARKER = "作廢擁有人標記5928374";
const TOTAL_AMOUNT_MARKER = 837261;

// ===========================================================================
// §B〜§G — 端點層（需 DB）
// ===========================================================================

describeWithDb("PHASE-009-T4 — 作廢端點授權矩陣／錯誤合約（AC-05(b)／AC-23／AC-27）", () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let attachmentStorageRoot: string;
  let reportStorageRoot: string;

  let ownerId: string;
  let ownerCookie: string;
  let strangerCookie: string;
  let mustChangeCookie: string;
  let adminId: string;
  let adminCookie: string;

  const createdApplicationIds: string[] = [];
  const createdUserIds: string[] = [];

  async function createUser(
    labelSuffix: string,
    opts: { role?: "USER" | "ADMIN"; mustChangePassword?: boolean; displayName?: string } = {}
  ) {
    const loginName = `${LOGIN_PREFIX}${labelSuffix}_${RUN_ID}`;
    const user = await prisma.user.create({
      data: {
        loginName,
        displayName: opts.displayName ?? `T4 ${labelSuffix}`,
        passwordHash: await hashPassword(PASSWORD),
        role: opts.role ?? "USER",
        isActive: true,
        mustChangePassword: opts.mustChangePassword ?? false,
      },
    });
    createdUserIds.push(user.id);
    const cookie = await loginUser(app, loginName, PASSWORD);
    return { id: user.id, cookie, loginName };
  }

  /** 已完成差旅（含業務值標記，供 403 零業務值掃描）。 */
  async function createCompletedTravel(suffix: string): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-05-10T00:00:00.000Z"),
        totalAmount: TOTAL_AMOUNT_MARKER,
        completedAt: new Date("2026-05-10T08:00:00.000Z"),
        travel: {
          create: {
            tripDate: new Date("2026-05-10T00:00:00.000Z"),
            purpose: `${PURPOSE_MARKER}-${suffix}`,
            fuelUnitPrice: "2.3456",
            etcUnitPrice: "1.2345",
            snapshotTotalKm: "60.00",
            snapshotRawAmount: "500.0000",
            calculatedAt: new Date("2026-05-10T08:00:00.000Z"),
          },
        },
      },
    });
    createdApplicationIds.push(created.id);
    return created.id;
  }

  async function createDraftTravel(suffix: string): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-05-10T00:00:00.000Z"),
        travel: { create: { purpose: `${PURPOSE_MARKER}-${suffix}` } },
      },
    });
    createdApplicationIds.push(created.id);
    return created.id;
  }

  /** 已作廢差旅——一律經**真實作廢端點**產生（非直寫 DB）。 */
  async function createVoidedTravel(suffix: string): Promise<string> {
    const id = await createCompletedTravel(suffix);
    const resp = await app.inject({
      method: "POST",
      url: `/applications/${id}/void`,
      headers: { cookie: ownerCookie },
      payload: { reason: `作廢原因-${suffix}` },
    });
    if (resp.statusCode !== 200) {
      throw new Error(`void endpoint failed for ${suffix}: ${resp.statusCode} ${resp.body}`);
    }
    return id;
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    attachmentStorageRoot = makeTempStorageRoot("att");
    reportStorageRoot = makeTempStorageRoot("rpt");

    app = await buildServer({
      databaseUrl: DB_URL,
      storageRoot: attachmentStorageRoot,
      reportStorageRoot,
      logLevel: "error",
    });
    await app.ready();

    const owner = await createUser("owner", { displayName: OWNER_DISPLAY_MARKER });
    ownerId = owner.id;
    ownerCookie = owner.cookie;
    strangerCookie = (await createUser("stranger")).cookie;
    mustChangeCookie = (await createUser("mustchg", { mustChangePassword: true })).cookie;
    const admin = await createUser("admin", { role: "ADMIN" });
    adminId = admin.id;
    adminCookie = admin.cookie;
  });

  afterAll(async () => {
    if (!prisma) return;
    await app.close();
    if (createdUserIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: createdUserIds } } });
    }
    // T12b：§D 之「下載 → 200」一格直寫了 `Report`／`VoidedReportFile`；
    // 兩者之 FK 皆為 `onDelete: Restrict`，故須先於 `Application` 刪除
    // （沿 `phase9-void-report.test.ts` 之既有清理形狀）。
    const reports = await prisma.report.findMany({
      where: { applicationId: { in: createdApplicationIds } },
      select: { id: true },
    });
    if (reports.length > 0) {
      await prisma.voidedReportFile.deleteMany({
        where: { reportId: { in: reports.map((r) => r.id) } },
      });
      await prisma.report.deleteMany({
        where: { applicationId: { in: createdApplicationIds } },
      });
    }
    await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
    if (createdUserIds.length > 0) {
      await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
    removeTempStorageRoot(attachmentStorageRoot);
    removeTempStorageRoot(reportStorageRoot);
  });

  // =========================================================================
  // §B — AC-23 授權矩陣：作廢端點 5 格（§6.1 表 #1〜#5）
  // =========================================================================

  describe("AC-23: 授權矩陣 5 格逐格（POST /applications/:id/void × 5 身分；修正版端點 5 格屬 T7）", () => {
    it("§6.1 #1 未登入 → 401 UNAUTHORIZED（判定先於存在性——以不存在之 id 呼叫亦為 401）", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/applications/${NONEXISTENT_ID}/void`,
        payload: { reason: "未登入嘗試" },
      });
      expect(resp.statusCode).toBe(401);
      const body = JSON.parse(resp.body) as ErrorBody;
      expect(body.error?.code).toBe("UNAUTHORIZED");
      expectNoLeakage(body);
    });

    it("§6.1 #2 已登入但 mustChangePassword → 403 PASSWORD_CHANGE_REQUIRED（先於存在性判定）", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/applications/${NONEXISTENT_ID}/void`,
        headers: { cookie: mustChangeCookie },
        payload: { reason: "強制改密嘗試" },
      });
      expect(resp.statusCode).toBe(403);
      const body = JSON.parse(resp.body) as ErrorBody;
      expect(body.error?.code).toBe("PASSWORD_CHANGE_REQUIRED");
      expectNoLeakage(body);
    });

    it("§6.1 #3 擁有人本人 → 200，回應為型別分派之詳情 DTO 且 void 非 null", async () => {
      const id = await createCompletedTravel("matrix-owner");
      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/void`,
        headers: { cookie: ownerCookie },
        payload: { reason: "擁有人本人作廢" },
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body) as {
        application: { id: string; status: string; void: { reason: string } | null };
      };
      expect(body.application.id).toBe(id);
      expect(body.application.status).toBe("VOIDED");
      expect(body.application.void).not.toBeNull();
      expect(body.application.void?.reason).toBe("擁有人本人作廢");
    });

    it("§6.1 #4 他人一般使用者 → 403 FORBIDDEN，回應零業務值（狀態／型別／金額／姓名／原因皆不外洩）", async () => {
      const id = await createCompletedTravel("matrix-stranger");
      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/void`,
        headers: { cookie: strangerCookie },
        payload: { reason: "他人嘗試作廢" },
      });
      expect(resp.statusCode).toBe(403);
      const body = JSON.parse(resp.body) as ErrorBody;
      expect(body.error?.code).toBe("FORBIDDEN");
      expectNoLeakage(body);

      // 零業務值掃描（§6.1 判定紀律③）。
      expect(resp.body).not.toContain(PURPOSE_MARKER);
      expect(resp.body).not.toContain(OWNER_DISPLAY_MARKER);
      expect(resp.body).not.toContain(String(TOTAL_AMOUNT_MARKER));
      expect(resp.body).not.toContain("COMPLETED");
      expect(resp.body).not.toContain("TRAVEL");
      expect(body.error?.details).toBeUndefined();

      // 零寫入。
      const after = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe("COMPLETED");
      expect(after.voidReason).toBeNull();
    });

    it("§6.1 #5 管理員（非擁有人）→ 200（AD-US-10 明文授權）", async () => {
      const id = await createCompletedTravel("matrix-admin");
      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/void`,
        headers: { cookie: adminCookie },
        payload: { reason: "管理員代作廢" },
      });
      expect(resp.statusCode).toBe(200);
      const after = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe("VOIDED");
      // 授權權威恆為 DB 之 ownerId：擁有人不因代操作而改變。
      expect(after.ownerId).toBe(ownerId);
      expect(after.voidedById).toBe(adminId);
    });
  });

  // =========================================================================
  // §C — AC-23／§6.1 判定紀律①：側信道（他人視角之三種狀態回應逐字相同）
  //
  // T3 即審 FW（Packet 逐條核銷第 1 項）：授權早於 409 只能在 route 層落地
  // ——本組即該不變式之鑑別性測試。判定順序若對調（409 早於授權），他人對
  // 草稿／已完成／已作廢會分別得到 409(DRAFT)／403／409(VOIDED)，指紋互異
  // → 必紅。
  // =========================================================================

  describe("AC-23 側信道: 他人之「草稿」「已完成」「已作廢」三種狀態回應逐字相同（授權判定早於狀態守門）", () => {
    it("三種狀態之 403 回應（狀態碼＋body，requestId 除外）逐字全等，且皆零寫入", async () => {
      const draftId = await createDraftTravel("sidechannel-draft");
      const completedId = await createCompletedTravel("sidechannel-completed");
      const voidedId = await createVoidedTravel("sidechannel-voided");

      const headers = { cookie: strangerCookie };
      const [draftResp, completedResp, voidedResp] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/applications/${draftId}/void`,
          headers,
          payload: { reason: "側信道測試" },
        }),
        app.inject({
          method: "POST",
          url: `/applications/${completedId}/void`,
          headers,
          payload: { reason: "側信道測試" },
        }),
        app.inject({
          method: "POST",
          url: `/applications/${voidedId}/void`,
          headers,
          payload: { reason: "側信道測試" },
        }),
      ]);

      const fingerprints = [draftResp, completedResp, voidedResp].map(responseFingerprint);
      expect(fingerprints[0]).toBe(fingerprints[1]);
      expect(fingerprints[1]).toBe(fingerprints[2]);
      // 正向對照：三者皆為 403 FORBIDDEN（非「三者皆 500」之恆真式全等）。
      expect(draftResp.statusCode).toBe(403);
      expect(JSON.parse(draftResp.body).error.code).toBe("FORBIDDEN");

      // 零寫入：三筆狀態皆未變。
      const rows = await prisma.application.findMany({
        where: { id: { in: [draftId, completedId, voidedId] } },
        select: { id: true, status: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r.status]));
      expect(byId.get(draftId)).toBe("DRAFT");
      expect(byId.get(completedId)).toBe("COMPLETED");
      expect(byId.get(voidedId)).toBe("VOIDED");
    });

    it("同一不存在之 id：他人與擁有人皆得 404（不因擁有人身分洩漏差異）；他人之「存在但非其所有」則為 403", async () => {
      const id = await createCompletedTravel("sidechannel-404");
      const strangerMissing = await app.inject({
        method: "POST",
        url: `/applications/${NONEXISTENT_ID}/void`,
        headers: { cookie: strangerCookie },
        payload: { reason: "x" },
      });
      const ownerMissing = await app.inject({
        method: "POST",
        url: `/applications/${NONEXISTENT_ID}/void`,
        headers: { cookie: ownerCookie },
        payload: { reason: "x" },
      });
      expect(strangerMissing.statusCode).toBe(404);
      expect(ownerMissing.statusCode).toBe(404);
      expect(responseFingerprint(strangerMissing)).toBe(responseFingerprint(ownerMissing));

      const strangerExisting = await app.inject({
        method: "POST",
        url: `/applications/${id}/void`,
        headers: { cookie: strangerCookie },
        payload: { reason: "x" },
      });
      expect(strangerExisting.statusCode).toBe(403);
    });
  });

  // =========================================================================
  // §D — AC-23 回歸四格：既有報表四端點於 `VOIDED` 狀態
  //
  // §6.1 逐字：「四格之授權判定（401／403）與 `COMPLETED` 時**逐字相同**」。
  // 本組即以「同型之 COMPLETED 與 VOIDED 兩筆申請、同一組身分逐端點比對回應
  // 指紋」落地。擁有人視角之狀態碼另立一則，列印端點之狀態碼留 T13（見檔頭
  // T7／T13 留白清單）。
  // =========================================================================

  describe("AC-23 回歸四格: 報表四端點於 VOIDED 之授權判定與 COMPLETED 逐字相同", () => {
    const reportEndpoints = (id: string) => [
      { label: "產生", method: "POST" as const, url: `/applications/${id}/report` },
      { label: "查詢", method: "GET" as const, url: `/applications/${id}/report` },
      { label: "列印", method: "GET" as const, url: `/applications/${id}/report/print` },
      { label: "下載", method: "GET" as const, url: `/applications/${id}/report/pdf` },
    ];

    it("未登入／強制改密／他人 三種身分 × 四端點：VOIDED 與 COMPLETED 之回應指紋逐格全等（12 組比對）", async () => {
      const completedId = await createCompletedTravel("regression-completed");
      const voidedId = await createVoidedTravel("regression-voided");

      const identities = [
        { label: "未登入", headers: undefined as Record<string, string> | undefined, code: 401 },
        { label: "強制改密", headers: { cookie: mustChangeCookie }, code: 403 },
        { label: "他人", headers: { cookie: strangerCookie }, code: 403 },
      ];

      let comparisons = 0;
      for (const identity of identities) {
        for (const ep of reportEndpoints(completedId)) {
          const completedResp = await app.inject({
            method: ep.method,
            url: ep.url,
            headers: identity.headers,
          });
          const voidedResp = await app.inject({
            method: ep.method,
            url: ep.url.replace(completedId, voidedId),
            headers: identity.headers,
          });
          expect(
            responseFingerprint(voidedResp),
            `${identity.label} × ${ep.label}: VOIDED 與 COMPLETED 之回應不一致`
          ).toBe(responseFingerprint(completedResp));
          // 正向對照：授權面確實生效（非「兩邊都 200」之恆真式全等）。
          expect(completedResp.statusCode).toBe(identity.code);
          comparisons++;
        }
      }
      expect(comparisons).toBe(12);

      // 授權失敗一律零寫入：兩筆狀態未變。
      const rows = await prisma.application.findMany({
        where: { id: { in: [completedId, voidedId] } },
        select: { id: true, status: true },
      });
      expect(new Map(rows.map((r) => [r.id, r.status])).get(completedId)).toBe("COMPLETED");
      expect(new Map(rows.map((r) => [r.id, r.status])).get(voidedId)).toBe("VOIDED");
    });

    it("擁有人視角: 產生 → 409 + details.status='VOIDED'（B-27／D13）；查詢 → 200 report:null；下載 → 404（尚未產生，B-28 語意不變）", async () => {
      const id = await createVoidedTravel("regression-owner");
      const headers = { cookie: ownerCookie };

      const genResp = await app.inject({
        method: "POST",
        url: `/applications/${id}/report`,
        headers,
      });
      expect(genResp.statusCode).toBe(409);
      const genBody = JSON.parse(genResp.body) as ErrorBody;
      expect(genBody.error?.code).toBe("CONFLICT");
      expect(genBody.error?.details).toEqual({ status: "VOIDED" });

      const queryResp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report`,
        headers,
      });
      expect(queryResp.statusCode).toBe(200);
      expect(JSON.parse(queryResp.body)).toEqual({ report: null });

      const pdfResp = await app.inject({
        method: "GET",
        url: `/applications/${id}/report/pdf`,
        headers,
      });
      expect(pdfResp.statusCode).toBe(404);

      // 列印端點之擁有人視角狀態碼（D5：VOIDED 應放行為 200）屬 **T13**
      // （AC-22），本檔刻意不釘樁——見檔頭「T7 留白清單」第 3 點。
    });

    // -----------------------------------------------------------------------
    // T13（AC-22／§16 D5）：AC-23 之「列印 → 200（依 D5）」一格
    //
    // 上一則刻意留白之「擁有人視角列印狀態碼」於本則補齊（見檔頭 T7／T13 留
    // 白清單第 3 點）。本則只釘**狀態碼 ＋ 標示在場**；列印版內容面之完整覆
    // 蓋屬 `phase8-report-print.test.ts` §K。
    //
    // 資料建構：`createVoidedTravel` 之申請**未產生報表**（作廢為純 DB 操
    // 作，AC-21(e)），故列印路徑零 `renderPdf`／零 Chromium——與本檔「零渲染
    // 器替身」之既有前提相容。
    // -----------------------------------------------------------------------

    it("擁有人／管理員視角: 已作廢申請列印 → 200 text/html ＋ .void-banner 作廢標示（依 §16 D5；T4 開列之 T13 留白補齊）", async () => {
      const voidedId = await createVoidedTravel("regression-print-200");
      const voidedReason = "作廢原因-regression-print-200";
      const completedId = await createCompletedTravel("regression-print-200-control");

      /** 擷取 `.void-banner` 區塊內容（T11 W-4：statusLabel 亦含「已作廢」）。 */
      const extractVoidBanner = (html: string): string | null => {
        const match = html.match(/<section class="void-banner avoid-break">([\s\S]*?)<\/section>/);
        return match ? match[1] : null;
      };

      for (const identity of [
        { label: "擁有人", cookie: ownerCookie },
        { label: "管理員", cookie: adminCookie },
      ]) {
        const resp = await app.inject({
          method: "GET",
          url: `/applications/${voidedId}/report/print`,
          headers: { cookie: identity.cookie },
        });
        expect(resp.statusCode, `${identity.label}: ${resp.body.slice(0, 300)}`).toBe(200);
        expect(resp.headers["content-type"]).toBe("text/html; charset=utf-8");
        const banner = extractVoidBanner(resp.body);
        expect(banner, `${identity.label}: 缺 .void-banner 區塊`).not.toBeNull();
        expect(banner).toContain("已作廢");
        expect(banner).toContain(voidedReason);
      }

      // 對照組（避免上述斷言恆真）：未作廢之同型申請列印亦 200，但零作廢標示。
      const controlResp = await app.inject({
        method: "GET",
        url: `/applications/${completedId}/report/print`,
        headers: { cookie: ownerCookie },
      });
      expect(controlResp.statusCode).toBe(200);
      expect(extractVoidBanner(controlResp.body)).toBeNull();
      expect(controlResp.body).not.toContain("已作廢");

      // 列印為唯讀：狀態未因列印而改變。
      const after = await prisma.application.findUniqueOrThrow({ where: { id: voidedId } });
      expect(after.status).toBe("VOIDED");
    });

    // -----------------------------------------------------------------------
    // T12b（FW-A 銷帳）：AC-23 之「下載 → 200（依 D4）」一格
    //
    // 上一則之 VOIDED 申請**未產生報表**，故下載為 404（B-27）。本則補齊
    // 「已作廢**且有** `Report`」之格：擁有人／管理員下載皆 200。
    //
    // 資料建構刻意**不經**產生端點：本檔零 `renderPdf` 替身，經端點產生會啟
    // 動真實 Chromium（分鐘級）且本格所驗為**狀態碼**而非位元組來源。故先經
    // 真實作廢端點取得 `VOIDED`（此時無 `Report`，作廢為純 DB 操作，
    // AC-21(e)），再直寫 `Report` ＋ `VoidedReportFile` ＋ 兩份 storage 位元
    // 組。位元組面之語意（回作廢版、編號不變、AC-21(b)(d)）由
    // `phase9-void-report.test.ts` §E 以真實作廢流程覆蓋。
    // -----------------------------------------------------------------------

    it("擁有人／管理員視角: 已作廢**且有報表**之申請下載 → 200（依 §16 D4(b1)；T4 即審 FW-A 之留白補齊）", async () => {
      const id = await createVoidedTravel("regression-download-200");
      const reportStorage = new LocalVolumeStorage(reportStorageRoot, { prefixes: ["rpt"] });

      const originalBytes = Buffer.from(`%PDF-1.4\n% T12b original\n${"o".repeat(600)}\n%%EOF`);
      const voidedBytes = Buffer.from(`%PDF-1.4\n% T12b voided\n${"v".repeat(900)}\n%%EOF`);
      const originalKey = `rpt/${crypto.randomUUID()}/pdf`;
      const voidedKey = `rpt/${crypto.randomUUID()}/void`;
      await reportStorage.put(originalKey, originalBytes, "application/pdf");
      await reportStorage.put(voidedKey, voidedBytes, "application/pdf");

      const report = await prisma.report.create({
        data: {
          applicationId: id,
          reportNumber: `TRV-299901-${RUN_ID.slice(0, 4).toUpperCase()}`,
          numberPrefix: "TRV",
          numberPeriod: "299901",
          sequence: 1,
          storageKey: originalKey,
          fileName: "差旅補助報表-TRV-299901-0001.pdf",
          byteSize: originalBytes.length,
          contentHash: crypto.createHash("sha256").update(originalBytes).digest("hex"),
          generatedById: ownerId,
        },
      });
      await prisma.voidedReportFile.create({
        data: {
          reportId: report.id,
          storageKey: voidedKey,
          // §8.2：與原 `Report.fileName` 相同（報表編號不變）。
          fileName: report.fileName,
          byteSize: voidedBytes.length,
          contentHash: crypto.createHash("sha256").update(voidedBytes).digest("hex"),
          createdById: ownerId,
        },
      });

      for (const identity of [
        { label: "擁有人", cookie: ownerCookie },
        { label: "管理員", cookie: adminCookie },
      ]) {
        const resp = await app.inject({
          method: "GET",
          url: `/applications/${id}/report/pdf`,
          headers: { cookie: identity.cookie },
        });
        expect(resp.statusCode, `${identity.label}: ${resp.body}`).toBe(200);
        expect(resp.headers["content-type"]).toBe("application/pdf");
        // 編號不變（AC-21(b)）——ASCII fallback 檔名沿原報表編號。
        expect(resp.headers["content-disposition"]).toContain(
          `filename="${report.reportNumber}.pdf"`
        );
      }

      // 作廢狀態未因下載而改變，且下載為唯讀（作廢版列仍恰一列）。
      const after = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe("VOIDED");
      expect(await prisma.voidedReportFile.count({ where: { reportId: report.id } })).toBe(1);
    });
  });

  // =========================================================================
  // §E — AC-27 錯誤表逐格（§7.5，作廢端點側）
  // =========================================================================

  describe("AC-27: 作廢端點錯誤表逐格（401／403×2／404／409+details.status／400+fields[]；existingRevisionId 與修正版各格屬 T7）", () => {
    it("404 NOT_FOUND: 擁有人對不存在之 id 作廢（不帶 details，不洩漏型別；B-13）", async () => {
      const resp = await app.inject({
        method: "POST",
        url: `/applications/${NONEXISTENT_ID}/void`,
        headers: { cookie: ownerCookie },
        payload: { reason: "不存在之申請" },
      });
      expect(resp.statusCode).toBe(404);
      const body = JSON.parse(resp.body) as ErrorBody;
      expect(body.error?.code).toBe("NOT_FOUND");
      expect(body.error?.details).toBeUndefined();
      expectNoLeakage(body);
    });

    it('409 CONFLICT + details.status="DRAFT"（AC-07 端點層）與 details.status="VOIDED"（AC-06 端點層）；訊息逐字釘樁（T3 即審 AR-4）', async () => {
      const draftId = await createDraftTravel("errtable-draft");
      const voidedId = await createVoidedTravel("errtable-voided");
      const headers = { cookie: ownerCookie };

      const draftResp = await app.inject({
        method: "POST",
        url: `/applications/${draftId}/void`,
        headers,
        payload: { reason: "草稿作廢" },
      });
      expect(draftResp.statusCode).toBe(409);
      const draftBody = JSON.parse(draftResp.body) as ErrorBody;
      expect(draftBody.error?.code).toBe("CONFLICT");
      expect(draftBody.error?.details).toEqual({ status: "DRAFT" });
      expect(draftBody.error?.message).toBe("僅已完成之申請可作廢");

      const voidedResp = await app.inject({
        method: "POST",
        url: `/applications/${voidedId}/void`,
        headers,
        payload: { reason: "重複作廢" },
      });
      expect(voidedResp.statusCode).toBe(409);
      const voidedBody = JSON.parse(voidedResp.body) as ErrorBody;
      expect(voidedBody.error?.code).toBe("CONFLICT");
      expect(voidedBody.error?.details).toEqual({ status: "VOIDED" });
      expect(voidedBody.error?.message).toBe("僅已完成之申請可作廢");

      // 零寫入：草稿仍為草稿；已作廢之原因未被第二次呼叫覆寫。
      const draftAfter = await prisma.application.findUniqueOrThrow({ where: { id: draftId } });
      expect(draftAfter.status).toBe("DRAFT");
      const voidedAfter = await prisma.application.findUniqueOrThrow({ where: { id: voidedId } });
      expect(voidedAfter.voidReason).toBe("作廢原因-errtable-voided");
    });

    it('400 VALIDATION_ERROR + fields[] 恰含 { field: "reason" }（缺鍵／空字串／僅空白三例），零寫入', async () => {
      const headers = { cookie: ownerCookie };
      const payloads: Array<Record<string, unknown>> = [{}, { reason: "" }, { reason: "　\t\n" }];

      for (const [index, payload] of payloads.entries()) {
        const id = await createCompletedTravel(`errtable-400-${index}`);
        const resp = await app.inject({
          method: "POST",
          url: `/applications/${id}/void`,
          headers,
          payload,
        });
        expect(resp.statusCode).toBe(400);
        const body = JSON.parse(resp.body) as ErrorBody;
        expect(body.error?.code).toBe("VALIDATION_ERROR");
        expect(body.error?.fields?.map((f) => f.field)).toEqual(["reason"]);
        expectNoLeakage(body);

        const after = await prisma.application.findUniqueOrThrow({ where: { id } });
        expect(after.status).toBe("COMPLETED");
        expect(after.voidReason).toBeNull();
        expect(after.voidedAt).toBeNull();
        expect(after.voidedById).toBeNull();
      }
    });

    it("判定順序: 他人 × 草稿 × 空原因（三重違規）→ 403（授權），非 409（狀態）亦非 400（原因）", async () => {
      const id = await createDraftTravel("errtable-order");
      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/void`,
        headers: { cookie: strangerCookie },
        payload: {},
      });
      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.code).toBe("FORBIDDEN");
    });
  });

  // =========================================================================
  // §F — AC-05(b) 端點層四類守門（對已作廢申請）
  //
  // AC-05(b) 逐字：完成端點 → 403 `FORBIDDEN`，訊息沿既有
  // `ALREADY_FINAL_MESSAGE`；作廢端點 → 409；`PUT` 三型 → 403；`DELETE` →
  // 403。四者皆零寫入。（T2 即審 FW：完成端點 403 之 message 必逐字斷言。）
  //
  // FW-9（T4b 即審）：附件面之 403 文案與 `ALREADY_FINAL_MESSAGE` **分歧**
  // （PHASE-003 既存）——`lifecycle-service.ts` 之
  // `assertContainerMutable` 拋出「已完成的申請不得修改或刪除附件」。兩者
  // 皆為 VOIDED 之使用者可見 403 文案，故一併納入本組之文案聯集斷言；
  // **不擅改任一既有文案**（行為變更），判定與建議記於 Handoff（AR-4）。
  // =========================================================================

  describe("AC-05(b): 已作廢申請之四類端點守門（完成 403 逐字／作廢 409／PUT 403／DELETE 403，皆零寫入）", () => {
    /** `application-state-machine.ts:55` 之既有常數，逐字複本。 */
    const ALREADY_FINAL_MESSAGE = "已完成的申請不可修改，請建立修正版";
    /** `attachment/lifecycle-service.ts:163` 之既有常數，逐字複本（FW-9）。 */
    const ATTACHMENT_LOCKED_MESSAGE = "已完成的申請不得修改或刪除附件";

    it("完成端點 POST /applications/:id/complete → 403 FORBIDDEN，message 逐字為 ALREADY_FINAL_MESSAGE，零寫入", async () => {
      const id = await createVoidedTravel("ac05b-complete");
      const before = await prisma.application.findUniqueOrThrow({ where: { id } });

      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/complete`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(403);
      const body = JSON.parse(resp.body) as ErrorBody;
      expect(body.error?.code).toBe("FORBIDDEN");
      expect(body.error?.message).toBe(ALREADY_FINAL_MESSAGE);

      const after = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe("VOIDED");
      expect(after.completedAt?.toISOString()).toBe(before.completedAt?.toISOString());
      expect(after.voidReason).toBe(before.voidReason);
    });

    it("作廢端點 → 409 CONFLICT（非 403、非冪等 200）；三型 PUT → 403 ALREADY_FINAL_MESSAGE；DELETE → 403 ALREADY_FINAL_MESSAGE；皆零寫入", async () => {
      const id = await createVoidedTravel("ac05b-quartet");
      const headers = { cookie: ownerCookie };

      const voidResp = await app.inject({
        method: "POST",
        url: `/applications/${id}/void`,
        headers,
        payload: { reason: "再次作廢" },
      });
      expect(voidResp.statusCode).toBe(409);

      const putResp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${id}`,
        headers,
        payload: { purpose: "作廢後嘗試改動" },
      });
      expect(putResp.statusCode).toBe(403);
      expect(JSON.parse(putResp.body).error.message).toBe(ALREADY_FINAL_MESSAGE);

      const deleteResp = await app.inject({
        method: "DELETE",
        url: `/applications/${id}`,
        headers,
      });
      expect(deleteResp.statusCode).toBe(403);
      expect(JSON.parse(deleteResp.body).error.message).toBe(ALREADY_FINAL_MESSAGE);

      const after = await prisma.application.findUnique({
        where: { id },
        include: { travel: true },
      });
      expect(after).not.toBeNull();
      expect(after?.status).toBe("VOIDED");
      expect(after?.travel?.purpose).not.toBe("作廢後嘗試改動");
      expect(after?.voidReason).toBe("作廢原因-ac05b-quartet");
    });

    it("FW-9: VOIDED 相關之使用者可見 403 文案聯集恰為兩支（申請面 ALREADY_FINAL_MESSAGE ＋ 附件面 ATTACHMENT_LOCKED_MESSAGE），兩者於既有 src 皆在場且互異", () => {
      const stateMachineSrc = fs.readFileSync(
        path.join(BACKEND_ROOT, "src/applications/application-state-machine.ts"),
        "utf-8"
      );
      const lifecycleSrc = fs.readFileSync(
        path.join(BACKEND_ROOT, "src/attachment/lifecycle-service.ts"),
        "utf-8"
      );
      expect(stateMachineSrc).toContain(ALREADY_FINAL_MESSAGE);
      expect(lifecycleSrc).toContain(ATTACHMENT_LOCKED_MESSAGE);
      // 兩支文案刻意分歧（PHASE-003 既存）——本 Task **不**統一（行為變更，
      // 非本 Task 授權範圍）。此斷言的作用是：任一方被單方面改動時本測試必
      // 紅，迫使變更者顯式面對兩支文案之關係（AR-4 判定交 reviewer／大總管）。
      expect(ALREADY_FINAL_MESSAGE).not.toBe(ATTACHMENT_LOCKED_MESSAGE);
    });
  });

  // =========================================================================
  // §G — 500 INTERNAL_ERROR（§7.5 末列）＋ AC-24 同交易之**端點層**自證
  //
  // AC-24 逐字：「**同交易**之證明：以 hook 拋錯注入使業務寫入一併回滾（零
  // 孤兒稽核列、零狀態變更）」——`phase9-void.test.ts` 已以 service 層之
  // `onVoided` 拋錯落地該字面要求。但該測試無法鑑別「route 把稽核寫在
  // `voidApplication` **回傳之後**」之 mutant（該 mutant 下 service 層測試
  // 仍全綠）。本組改以 DB 層注入：於本 worker schema 對 `"AuditLog"` 建立
  // 一個僅對本測試專屬 `targetLabel` 前綴生效的 BEFORE INSERT 觸發器，使稽
  // 核寫入必然失敗——
  //   · 正確實作（稽核在交易內）→ 整筆回滾：狀態仍 COMPLETED、零稽核列、500。
  //   · Mutant ①（稽核移到交易後）→ 作廢已提交：狀態變 VOIDED → **必紅**。
  // 觸發器以 `RUN_ID` 專屬之 loginName 前綴過濾，且於 finally 中卸除，不影
  // 響其他測試檔。
  // =========================================================================

  describe("§7.5 500 INTERNAL_ERROR ＋ AC-24 同交易之端點層自證（稽核寫入失敗 → 整筆回滾）", () => {
    it("稽核 INSERT 於 DB 層失敗 → 500 INTERNAL_ERROR，狀態仍 COMPLETED、四欄仍 NULL、零稽核列（稽核移出交易之 mutant 必紅）", async () => {
      const trapFn = `p9t4_audit_trap_${RUN_ID}`;
      const trapTrigger = `p9t4_audit_trap_trg_${RUN_ID}`;
      // 專屬擁有人：其 loginName 即 targetLabel 之前綴（`{loginName}#{id}`）。
      const trapOwner = await createUser("audittrap");

      const trapAppRow = await prisma.application.create({
        data: {
          type: "TRAVEL",
          status: "COMPLETED",
          ownerId: trapOwner.id,
          createdById: trapOwner.id,
          primaryDate: new Date("2026-06-01T00:00:00.000Z"),
          totalAmount: 1234,
          completedAt: new Date("2026-06-01T08:00:00.000Z"),
          travel: { create: { purpose: "audit trap fixture" } },
        },
      });
      createdApplicationIds.push(trapAppRow.id);

      try {
        await prisma.$executeRawUnsafe(
          `CREATE OR REPLACE FUNCTION "${trapFn}"() RETURNS trigger AS $trap$
             BEGIN RAISE EXCEPTION 'p9t4 audit trap'; END;
           $trap$ LANGUAGE plpgsql;`
        );
        await prisma.$executeRawUnsafe(
          `CREATE TRIGGER "${trapTrigger}" BEFORE INSERT ON "AuditLog"
             FOR EACH ROW WHEN (NEW."targetLabel" LIKE '${trapOwner.loginName}#%')
             EXECUTE FUNCTION "${trapFn}"();`
        );

        const resp = await app.inject({
          method: "POST",
          url: `/applications/${trapAppRow.id}/void`,
          headers: { cookie: trapOwner.cookie },
          payload: { reason: "同交易自證用原因" },
        });

        expect(resp.statusCode).toBe(500);
        const body = JSON.parse(resp.body) as ErrorBody;
        expect(body.error?.code).toBe("INTERNAL_ERROR");
        expectNoLeakage(body);

        // 整筆回滾：狀態與四欄皆未變。
        const after = await prisma.application.findUniqueOrThrow({
          where: { id: trapAppRow.id },
        });
        expect(after.status).toBe("COMPLETED");
        expect(after.voidReason).toBeNull();
        expect(after.voidedAt).toBeNull();
        expect(after.voidedById).toBeNull();

        // 零孤兒稽核列。
        const audits = await prisma.auditLog.count({ where: { actorId: trapOwner.id } });
        expect(audits).toBe(0);
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trapTrigger}" ON "AuditLog";`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${trapFn}"();`);
      }

      // 觸發器卸除後，同一筆申請可正常作廢（證明上方 500 來自注入而非實作
      // 本身壞掉——反向對照，避免「恆 500」之恆真式通過）。
      const okResp = await app.inject({
        method: "POST",
        url: `/applications/${trapAppRow.id}/void`,
        headers: { cookie: trapOwner.cookie },
        payload: { reason: "解除注入後正常作廢" },
      });
      expect(okResp.statusCode).toBe(200);
      expect(await prisma.auditLog.count({ where: { actorId: trapOwner.id } })).toBe(1);
    });
  });
});

// ===========================================================================
// §H — AC-25：稽核與日誌零敏感資料（含作廢原因零入日誌 ＋ 反向探針）
//
// AC-25 逐字：「`AuditLog.summary` 與日誌流**零出現**：密碼、session cookie
// ／token、`att/`／`rpt/` storage key 前綴值、volume 絕對路徑、折舊車價／折
// 舊年限。作廢原因為使用者輸入之自由文字，**入稽核屬既定要求**（BE-US-31
// ②），但**不得**進入 `request.log` 之任何一行——反向探針證明掃描機制非恆
// 真。」
//
// 掃描窗涵蓋之作廢路徑：成功（200）／原因驗證失敗（400）／狀態衝突（409）
// ／他人（403）——四者皆帶著 `reason` 進入 handler。
// ===========================================================================

describeWithDb("PHASE-009-T4 — AC-25 稽核與日誌零敏感資料（作廢原因零入日誌 ＋ 反向探針）", () => {
  let prisma: PrismaClient;
  let logApp: FastifyInstance;
  let logLines: string[];
  let attachmentStorageRoot: string;
  let reportStorageRoot: string;

  let ownerId: string;
  let ownerCookie: string;
  let strangerCookie: string;

  const createdApplicationIds: string[] = [];
  const createdUserIds: string[] = [];

  // 本套件專屬標記——刻意選用不易與時間戳／隨機 id 巧合重疊之字面值（沿
  // phase8-contract.test.ts §E 之實測教訓：3 位數字曾與毫秒時間戳子字串巧
  // 合，改用長字串／8 位數字）。
  const REASON_MARKER = `作廢原因敏感標記-${RUN_ID}-92183746`;
  const VEHICLE_PRICE_MARKER = "918273.64";
  const USEFUL_LIFE_YEARS_MARKER = 84213579;

  async function createUser(labelSuffix: string) {
    const loginName = `${LOGIN_PREFIX}log_${labelSuffix}_${RUN_ID}`;
    const user = await prisma.user.create({
      data: {
        loginName,
        displayName: `T4Log ${labelSuffix}`,
        passwordHash: await hashPassword(PASSWORD),
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    createdUserIds.push(user.id);
    return { id: user.id, cookie: await loginUser(logApp, loginName, PASSWORD), loginName };
  }

  /** 已完成折舊（帶車價／年限標記）——AC-25 之折舊揭露面。 */
  async function createCompletedDepreciation(year: number): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "DEPRECIATION",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date(`${year}-12-31T00:00:00.000Z`),
        totalAmount: 40000,
        completedAt: new Date(`${year}-12-31T08:00:00.000Z`),
        depreciation: {
          create: {
            applicationYear: year,
            annualTotalKm: "20000.0",
            snapshotVehiclePrice: VEHICLE_PRICE_MARKER,
            snapshotUsefulLifeYears: USEFUL_LIFE_YEARS_MARKER,
            snapshotAnnualDepreciation: "70000.00",
            snapshotOfficialKm: "10000.00",
            snapshotAnnualTotalKm: "20000.0",
            snapshotRatio: "0.500000",
            snapshotRawAmount: "40000.0000",
            calculatedAt: new Date(`${year}-12-31T08:00:00.000Z`),
          },
        },
      },
    });
    createdApplicationIds.push(created.id);
    return created.id;
  }

  let voidedApplicationId = "";
  let draftApplicationId = "";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    attachmentStorageRoot = makeTempStorageRoot("att-h");
    reportStorageRoot = makeTempStorageRoot("rpt-h");

    const capture = makeLogCapture();
    logLines = capture.lines;

    logApp = await buildServer({
      databaseUrl: DB_URL,
      storageRoot: attachmentStorageRoot,
      reportStorageRoot,
      logStream: capture.stream,
      logLevel: "info",
    });
    await logApp.ready();

    const owner = await createUser("owner");
    ownerId = owner.id;
    ownerCookie = owner.cookie;
    strangerCookie = (await createUser("stranger")).cookie;

    // ── 四條帶 reason 之路徑，全部走過一遍（掃描窗）──────────────────────
    // (1) 成功 200（折舊型，順帶把車價／年限標記帶進 DTO 組裝路徑）
    voidedApplicationId = await createCompletedDepreciation(2205);
    const okResp = await logApp.inject({
      method: "POST",
      url: `/applications/${voidedApplicationId}/void`,
      headers: { cookie: ownerCookie },
      payload: { reason: REASON_MARKER },
    });
    if (okResp.statusCode !== 200) {
      throw new Error(`void failed: ${okResp.statusCode} ${okResp.body}`);
    }

    // (2) 409（重複作廢，帶同一 reason 標記）
    await logApp.inject({
      method: "POST",
      url: `/applications/${voidedApplicationId}/void`,
      headers: { cookie: ownerCookie },
      payload: { reason: REASON_MARKER },
    });

    // (3) 403（他人，帶同一 reason 標記）
    await logApp.inject({
      method: "POST",
      url: `/applications/${voidedApplicationId}/void`,
      headers: { cookie: strangerCookie },
      payload: { reason: REASON_MARKER },
    });

    // (4) 400（原因僅空白——此路徑之 reason 為空白字元，另以一筆合法標記但
    //     超長之原因觸發 400，確保「被拒絕的原因文字」同樣不入日誌）
    const draft = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-07-01T00:00:00.000Z"),
        totalAmount: 100,
        completedAt: new Date("2026-07-01T08:00:00.000Z"),
        travel: { create: { purpose: "AC-25 400 路徑" } },
      },
    });
    createdApplicationIds.push(draft.id);
    draftApplicationId = draft.id;
    await logApp.inject({
      method: "POST",
      url: `/applications/${draftApplicationId}/void`,
      headers: { cookie: ownerCookie },
      payload: { reason: `${REASON_MARKER}${"誤".repeat(600)}` },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await logApp.close();
    if (createdUserIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: createdUserIds } } });
    }
    await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
    if (createdUserIds.length > 0) {
      await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
    removeTempStorageRoot(attachmentStorageRoot);
    removeTempStorageRoot(reportStorageRoot);
  });

  it("AC-25: 作廢原因入稽核（正向）——AuditLog.summary.reason 逐字為使用者輸入之原因", async () => {
    const audits = await prisma.auditLog.findMany({
      where: { action: "APPLICATION_VOIDED", actorId: ownerId },
    });
    expect(audits).toHaveLength(1);
    expect((audits[0].summary as Record<string, unknown>).reason).toBe(REASON_MARKER);
  });

  it("AC-25: AuditLog.summary 零敏感資料（密碼／cookie 值／att-rpt storage key 前綴／volume 絕對路徑／折舊車價／折舊年限）", async () => {
    const audits = await prisma.auditLog.findMany({
      where: { action: "APPLICATION_VOIDED", actorId: ownerId },
    });
    expect(audits.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(audits.map((a) => a.summary));
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(ownerCookie);
    expect(serialized).not.toMatch(/\batt\//);
    expect(serialized).not.toMatch(/\brpt\//);
    expect(serialized).not.toContain(toLogSearchable(attachmentStorageRoot));
    expect(serialized).not.toContain(toLogSearchable(reportStorageRoot));
    expect(serialized).not.toContain(VEHICLE_PRICE_MARKER);
    expect(serialized).not.toContain(String(USEFUL_LIFE_YEARS_MARKER));
    // summary 亦不含 voidedById（§6.3：內部識別值不外露）——鍵集封閉之補強。
    expect(Object.keys(audits[0].summary as Record<string, unknown>).sort()).toEqual([
      "applicationId",
      "reason",
      "type",
      "voidedAt",
    ]);
  });

  it("AC-25: 作廢原因零出現於 request.log 任何一行（200／409／403／400 四條路徑皆已走過）", () => {
    expect(logLines.length).toBeGreaterThan(0);
    const joined = logLines.join("\n");
    expect(joined).not.toContain(REASON_MARKER);
    expect(joined).not.toContain(toLogSearchable(REASON_MARKER));
  });

  it("AC-25: 日誌流零其餘六類敏感值（密碼／session cookie 值／att-rpt 前綴／兩個 volume 絕對路徑／折舊車價／折舊年限）", () => {
    const joined = logLines.join("\n");
    expect(joined).not.toContain(PASSWORD);
    expect(joined).not.toContain(ownerCookie.split("=").slice(1).join("="));
    expect(joined).not.toMatch(/\batt\//);
    expect(joined).not.toMatch(/\brpt\//);
    expect(joined).not.toContain(toLogSearchable(attachmentStorageRoot));
    expect(joined).not.toContain(toLogSearchable(reportStorageRoot));
    expect(joined).not.toContain(VEHICLE_PRICE_MARKER);
    expect(joined).not.toContain(String(USEFUL_LIFE_YEARS_MARKER));
  });

  it("AC-25 反向探針: 刻意將同一組敏感字串寫入同一 logStream，上述掃描全部能偵測（證明掃描機制非恆真）", () => {
    const probeLines: string[] = [];
    logApp.log.info(
      {
        probeReason: REASON_MARKER,
        probePassword: PASSWORD,
        probeCookie: ownerCookie,
        probeAttKey: "att/probe/xyz.jpg",
        probeRptKey: "rpt/probe/xyz.pdf",
        probeAttRoot: attachmentStorageRoot,
        probeRptRoot: reportStorageRoot,
        probeVehiclePrice: VEHICLE_PRICE_MARKER,
        probeUsefulLife: USEFUL_LIFE_YEARS_MARKER,
      },
      "AC-25 reverse probe"
    );
    // 取探針寫入後新增之行（logLines 為同一 stream 之累積緩衝）。
    probeLines.push(...logLines.filter((line) => line.includes("AC-25 reverse probe")));
    expect(probeLines.length).toBeGreaterThan(0);
    const probeJoined = probeLines.join("\n");

    // 逐項確認「若真的洩漏，上方掃描必能偵測」——每一條與上方掃描一一對應。
    expect(probeJoined).toContain(toLogSearchable(REASON_MARKER));
    expect(probeJoined).toContain(PASSWORD);
    expect(probeJoined).toMatch(/\batt\//);
    expect(probeJoined).toMatch(/\brpt\//);
    expect(probeJoined).toContain(toLogSearchable(attachmentStorageRoot));
    expect(probeJoined).toContain(toLogSearchable(reportStorageRoot));
    expect(probeJoined).toContain(VEHICLE_PRICE_MARKER);
    expect(probeJoined).toContain(String(USEFUL_LIFE_YEARS_MARKER));
  });
});

// ===========================================================================
// §I〜§L — PHASE-009-T7：修正版端點之授權矩陣與錯誤合約
//   （AC-23 修正版 5 格／AC-27 §7.5 逐格，含 details.existingRevisionId）
//
// ---------------------------------------------------------------------------
// 規範出處
// ---------------------------------------------------------------------------
// AC-23（:213）§6.1 表 #6〜#10：未登入 401；`mustChangePassword` 403
//   `PASSWORD_CHANGE_REQUIRED`；擁有人本人 201；他人一般使用者 403
//   `FORBIDDEN` 且回應**零業務值**；管理員 201 且新草稿 `ownerId` ＝原擁有人
//   （AD-US-09①）。他人之「已完成」與「草稿」回應**逐字相同**。
// AC-27（:223）§7.5：401／403／404／409(`details.status`)／
//   409(`details.existingRevisionId`)／500。**body 驗證**之 400 一格對本端點
//   不適用（§7.3「Body：無（一律忽略）」——正向實證見
//   `phase9-revision.test.ts` 之「body 一律忽略」一則）；惟 §7.5 另有一格
//   400——「申請擁有人**已停用**（**僅修正版端點**）」（**B-16**，
//   `SPEC-REV-9T7` 補格）——其 wire 形狀由 **T7b** 於 §K 補齊。
// §6.1 判定紀律①：授權（401／403）一律先於狀態守門（409）——他人之草稿／已
//   完成／已作廢三種狀態之回應逐字相同。
//
// ---------------------------------------------------------------------------
// Mutant 自證（暫改後復原，不入最終 diff；結果記於 Handoff）
// ---------------------------------------------------------------------------
//   ① 修正版 route 之 `assertOwnershipOrAdmin` 移到 service 呼叫之後（409 早
//      於授權）→ §J 側信道必紅。
//   ② 代操作稽核移出交易（`createApplicationRevisionWithAttachments` 回傳後
//      才寫 `auditLog`）→ §L 必紅（修正版已提交）。
//   ③ 自 `PHASE_009_VOID_SRC_FILES` 移除任一 T7 擴列項 → §A 清單自證必紅。
//
// 紀律：合成資料；`loginName` 前綴 `p9t7c_`；清理僅限本套件自建 id。
// ===========================================================================

describeWithDb("PHASE-009-T7 — 修正版端點授權矩陣／錯誤合約（AC-23／AC-27）", () => {
  const T7_PREFIX = "p9t7c_";
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let attachmentStorageRoot: string;
  let reportStorageRoot: string;

  let ownerId: string;
  let ownerCookie: string;
  let strangerCookie: string;
  let mustChangeCookie: string;
  let adminCookie: string;

  const createdApplicationIds: string[] = [];
  const createdUserIds: string[] = [];

  async function createUser(
    labelSuffix: string,
    opts: { role?: "USER" | "ADMIN"; mustChangePassword?: boolean; displayName?: string } = {}
  ) {
    const loginName = `${T7_PREFIX}${labelSuffix}_${RUN_ID}`;
    const user = await prisma.user.create({
      data: {
        loginName,
        displayName: opts.displayName ?? `T7 ${labelSuffix}`,
        passwordHash: await hashPassword(PASSWORD),
        role: opts.role ?? "USER",
        isActive: true,
        mustChangePassword: opts.mustChangePassword ?? false,
      },
    });
    createdUserIds.push(user.id);
    return { id: user.id, cookie: await loginUser(app, loginName, PASSWORD), loginName };
  }

  /** 已完成差旅（含業務值標記，供 403 零業務值掃描）。 */
  async function createCompletedTravel(suffix: string): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-05-10T00:00:00.000Z"),
        totalAmount: TOTAL_AMOUNT_MARKER,
        completedAt: new Date("2026-05-10T08:00:00.000Z"),
        travel: {
          create: {
            tripDate: new Date("2026-05-10T00:00:00.000Z"),
            purpose: `${PURPOSE_MARKER}-${suffix}`,
            fuelUnitPrice: "2.3456",
            etcUnitPrice: "1.2345",
            snapshotTotalKm: "60.00",
            snapshotRawAmount: "500.0000",
            calculatedAt: new Date("2026-05-10T08:00:00.000Z"),
          },
        },
      },
    });
    createdApplicationIds.push(created.id);
    return created.id;
  }

  async function createDraftTravel(suffix: string): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-05-10T00:00:00.000Z"),
        travel: { create: { purpose: `${PURPOSE_MARKER}-${suffix}` } },
      },
    });
    createdApplicationIds.push(created.id);
    return created.id;
  }

  /** 已作廢差旅——經**真實作廢端點**產生（非直寫 DB）。 */
  async function createVoidedTravel(suffix: string): Promise<string> {
    const id = await createCompletedTravel(suffix);
    const resp = await app.inject({
      method: "POST",
      url: `/applications/${id}/void`,
      headers: { cookie: ownerCookie },
      payload: { reason: `T7 作廢原因-${suffix}` },
    });
    if (resp.statusCode !== 200) {
      throw new Error(`void endpoint failed for ${suffix}: ${resp.statusCode} ${resp.body}`);
    }
    return id;
  }

  function postRevision(id: string, headers?: Record<string, string>) {
    return app.inject({ method: "POST", url: `/applications/${id}/revision`, headers });
  }

  /** 追蹤成功建立之修正版（cleanup 需先刪修正版，見 afterAll）。 */
  function trackRevision(resp: { body: string }): string {
    const id = (JSON.parse(resp.body) as { application: { id: string } }).application.id;
    createdApplicationIds.push(id);
    return id;
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    attachmentStorageRoot = makeTempStorageRoot("att-t7");
    reportStorageRoot = makeTempStorageRoot("rpt-t7");

    app = await buildServer({
      databaseUrl: DB_URL,
      storageRoot: attachmentStorageRoot,
      reportStorageRoot,
      logLevel: "error",
    });
    await app.ready();

    const owner = await createUser("owner", { displayName: OWNER_DISPLAY_MARKER });
    ownerId = owner.id;
    ownerCookie = owner.cookie;
    strangerCookie = (await createUser("stranger")).cookie;
    mustChangeCookie = (await createUser("mustchg", { mustChangePassword: true })).cookie;
    adminCookie = (await createUser("admin", { role: "ADMIN" })).cookie;
  });

  afterAll(async () => {
    if (!prisma) return;
    await app.close();
    if (createdUserIds.length > 0) {
      await prisma.attachment.deleteMany({ where: { ownerId: { in: createdUserIds } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: createdUserIds } } });
    }
    // 修正版（supersedesId → 原申請，onDelete: Restrict）必須先於原申請刪除。
    for (const id of [...createdApplicationIds].reverse()) {
      await prisma.application.deleteMany({ where: { supersedesId: id } });
    }
    await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
    if (createdUserIds.length > 0) {
      await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
    removeTempStorageRoot(attachmentStorageRoot);
    removeTempStorageRoot(reportStorageRoot);
  });

  // =========================================================================
  // §I — AC-23 授權矩陣：修正版端點 5 格（§6.1 表 #6〜#10）
  // =========================================================================

  describe("AC-23: 授權矩陣 5 格逐格（POST /applications/:id/revision × 5 身分）", () => {
    it("§6.1 #6 未登入 → 401 UNAUTHORIZED（判定先於存在性——以不存在之 id 呼叫亦為 401）", async () => {
      const resp = await postRevision(NONEXISTENT_ID);
      expect(resp.statusCode).toBe(401);
      const body = JSON.parse(resp.body) as ErrorBody;
      expect(body.error?.code).toBe("UNAUTHORIZED");
      expectNoLeakage(body);
    });

    it("§6.1 #7 已登入但 mustChangePassword → 403 PASSWORD_CHANGE_REQUIRED（先於存在性判定）", async () => {
      const resp = await postRevision(NONEXISTENT_ID, { cookie: mustChangeCookie });
      expect(resp.statusCode).toBe(403);
      const body = JSON.parse(resp.body) as ErrorBody;
      expect(body.error?.code).toBe("PASSWORD_CHANGE_REQUIRED");
      expectNoLeakage(body);
    });

    it("§6.1 #8 擁有人本人 → 201，回應為新草稿之型別分派 DTO 且 supersedes 非 null", async () => {
      const sourceId = await createCompletedTravel("matrix-owner");
      const resp = await postRevision(sourceId, { cookie: ownerCookie });
      expect(resp.statusCode).toBe(201);
      const revisionId = trackRevision(resp);

      const body = JSON.parse(resp.body) as {
        application: {
          id: string;
          type: string;
          status: string;
          ownerId: string;
          supersedes: { id: string } | null;
        };
      };
      expect(body.application.id).toBe(revisionId);
      expect(body.application.type).toBe("TRAVEL");
      expect(body.application.status).toBe("DRAFT");
      expect(body.application.ownerId).toBe(ownerId);
      expect(body.application.supersedes).not.toBeNull();
      expect(body.application.supersedes?.id).toBe(sourceId);
    });

    it("§6.1 #9 他人一般使用者 → 403 FORBIDDEN，回應零業務值（狀態／型別／金額／姓名／行程目的皆不外洩），零寫入", async () => {
      const sourceId = await createCompletedTravel("matrix-stranger");
      const resp = await postRevision(sourceId, { cookie: strangerCookie });
      expect(resp.statusCode).toBe(403);
      const body = JSON.parse(resp.body) as ErrorBody;
      expect(body.error?.code).toBe("FORBIDDEN");
      expectNoLeakage(body);

      // 零業務值掃描（§6.1 判定紀律③）。
      expect(resp.body).not.toContain(PURPOSE_MARKER);
      expect(resp.body).not.toContain(OWNER_DISPLAY_MARKER);
      expect(resp.body).not.toContain(String(TOTAL_AMOUNT_MARKER));
      expect(resp.body).not.toContain("COMPLETED");
      expect(resp.body).not.toContain("TRAVEL");
      expect(body.error?.details).toBeUndefined();

      // 零寫入：既無修正版，原申請亦未被 touch。
      expect(await prisma.application.count({ where: { supersedesId: sourceId } })).toBe(0);
      const after = await prisma.application.findUniqueOrThrow({ where: { id: sourceId } });
      expect(after.status).toBe("COMPLETED");
    });

    it("§6.1 #10 管理員（非擁有人）→ 201，新草稿 ownerId ＝原擁有人（AD-US-09①）", async () => {
      const sourceId = await createCompletedTravel("matrix-admin");
      const resp = await postRevision(sourceId, { cookie: adminCookie });
      expect(resp.statusCode).toBe(201);
      const revisionId = trackRevision(resp);

      const row = await prisma.application.findUniqueOrThrow({ where: { id: revisionId } });
      expect(row.ownerId).toBe(ownerId);
      expect(row.supersedesId).toBe(sourceId);
      expect(row.status).toBe("DRAFT");
    });
  });

  // =========================================================================
  // §J — AC-23／§6.1 判定紀律①：側信道（他人視角三種狀態逐字相同）
  //
  // T4 即審 FW-G：授權早於 409 只能在 route 層落地——判定順序若對調，他人對
  // 草稿／已完成／已作廢會分別得到 409(DRAFT)／403／409(VOIDED)，指紋互異
  // → 必紅。
  // =========================================================================

  describe("AC-23 側信道: 他人之「草稿」「已完成」「已作廢」三種狀態回應逐字相同（授權判定早於狀態守門）", () => {
    it("三種狀態之 403 回應（狀態碼＋body，requestId 除外）逐字全等，且皆零寫入", async () => {
      const draftId = await createDraftTravel("t7-sidechannel-draft");
      const completedId = await createCompletedTravel("t7-sidechannel-completed");
      const voidedId = await createVoidedTravel("t7-sidechannel-voided");

      const headers = { cookie: strangerCookie };
      const [draftResp, completedResp, voidedResp] = await Promise.all([
        postRevision(draftId, headers),
        postRevision(completedId, headers),
        postRevision(voidedId, headers),
      ]);

      const fingerprints = [draftResp, completedResp, voidedResp].map(responseFingerprint);
      expect(fingerprints[0]).toBe(fingerprints[1]);
      expect(fingerprints[1]).toBe(fingerprints[2]);
      // 正向對照：三者皆為 403 FORBIDDEN（非「三者皆 500」之恆真式全等）。
      expect(draftResp.statusCode).toBe(403);
      expect(JSON.parse(draftResp.body).error.code).toBe("FORBIDDEN");

      // 零寫入：三筆狀態皆未變，且皆無修正版。
      const rows = await prisma.application.findMany({
        where: { id: { in: [draftId, completedId, voidedId] } },
        select: { id: true, status: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r.status]));
      expect(byId.get(draftId)).toBe("DRAFT");
      expect(byId.get(completedId)).toBe("COMPLETED");
      expect(byId.get(voidedId)).toBe("VOIDED");
      expect(
        await prisma.application.count({
          where: { supersedesId: { in: [draftId, completedId, voidedId] } },
        })
      ).toBe(0);
    });

    it("同一不存在之 id：他人與擁有人皆得 404（不因擁有人身分洩漏差異）；他人之「存在但非其所有」則為 403", async () => {
      const sourceId = await createCompletedTravel("t7-sidechannel-404");
      const strangerMissing = await postRevision(NONEXISTENT_ID, { cookie: strangerCookie });
      const ownerMissing = await postRevision(NONEXISTENT_ID, { cookie: ownerCookie });
      expect(strangerMissing.statusCode).toBe(404);
      expect(ownerMissing.statusCode).toBe(404);
      expect(responseFingerprint(strangerMissing)).toBe(responseFingerprint(ownerMissing));

      const strangerExisting = await postRevision(sourceId, { cookie: strangerCookie });
      expect(strangerExisting.statusCode).toBe(403);
    });
  });

  // =========================================================================
  // §K — AC-27 錯誤表逐格（§7.5，修正版端點側）
  // =========================================================================

  describe("AC-27: 修正版端點錯誤表逐格（404／409+details.status×2／409+details.existingRevisionId／400 擁有人已停用；body 驗證之 400 不適用）", () => {
    it("404 NOT_FOUND: 擁有人對不存在之 id 建修正版（不帶 details，不洩漏型別；B-13）", async () => {
      const resp = await postRevision(NONEXISTENT_ID, { cookie: ownerCookie });
      expect(resp.statusCode).toBe(404);
      const body = JSON.parse(resp.body) as ErrorBody;
      expect(body.error?.code).toBe("NOT_FOUND");
      expect(body.error?.details).toBeUndefined();
      expectNoLeakage(body);
    });

    it('409 CONFLICT + details.status="DRAFT"／"VOIDED"（AC-13(a)(b) 端點層），訊息逐字釘樁', async () => {
      const draftId = await createDraftTravel("t7-errtable-draft");
      const voidedId = await createVoidedTravel("t7-errtable-voided");
      const headers = { cookie: ownerCookie };

      const draftResp = await postRevision(draftId, headers);
      expect(draftResp.statusCode).toBe(409);
      const draftBody = JSON.parse(draftResp.body) as ErrorBody;
      expect(draftBody.error?.code).toBe("CONFLICT");
      expect(draftBody.error?.details).toEqual({ status: "DRAFT" });
      expect(draftBody.error?.message).toBe("僅已完成之申請可建立修正版");
      expectNoLeakage(draftBody);

      const voidedResp = await postRevision(voidedId, headers);
      expect(voidedResp.statusCode).toBe(409);
      const voidedBody = JSON.parse(voidedResp.body) as ErrorBody;
      expect(voidedBody.error?.code).toBe("CONFLICT");
      expect(voidedBody.error?.details).toEqual({ status: "VOIDED" });
      expect(voidedBody.error?.message).toBe("僅已完成之申請可建立修正版");

      expect(
        await prisma.application.count({ where: { supersedesId: { in: [draftId, voidedId] } } })
      ).toBe(0);
    });

    it("409 CONFLICT + details.existingRevisionId（§7.5「已有修正版」列；T4 留白清單第 2 點）", async () => {
      const sourceId = await createCompletedTravel("t7-errtable-existing");
      const first = await postRevision(sourceId, { cookie: ownerCookie });
      expect(first.statusCode).toBe(201);
      const firstRevisionId = trackRevision(first);

      const second = await postRevision(sourceId, { cookie: ownerCookie });
      expect(second.statusCode).toBe(409);
      const body = JSON.parse(second.body) as ErrorBody;
      expect(body.error?.code).toBe("CONFLICT");
      expect(body.error?.details).toEqual({ existingRevisionId: firstRevisionId });
      expect(body.error?.message).toBe("此申請已有修正版");
      expectNoLeakage(body);

      // 仍恰一筆修正版（非冪等成功、非第二筆）。
      const revisions = await prisma.application.findMany({
        where: { supersedesId: sourceId },
        select: { id: true },
      });
      expect(revisions.map((r) => r.id)).toEqual([firstRevisionId]);
    });

    it("判定順序: 他人 × 草稿（雙重違規）→ 403（授權），非 409（狀態）", async () => {
      const draftId = await createDraftTravel("t7-errtable-order");
      const resp = await postRevision(draftId, { cookie: strangerCookie });
      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.code).toBe("FORBIDDEN");
    });

    // -----------------------------------------------------------------------
    // PHASE-009-T7b — §7.5「申請擁有人**已停用**（**僅修正版端點**）」400 格
    //
    // Spec §7.5（:517）逐字：「申請擁有人**已停用**（**僅修正版端點**）｜400｜
    // `VALIDATION_ERROR`｜訊息「指定的使用者已停用」……**作廢端點不受此限**」；
    // B-16（§5 :360）「沿既有代建立草稿之 **B-26** 先例」。本則只驗 **wire 形
    // 狀**（狀態碼／`error` 鍵集／`fields[]` 形狀／零洩漏）——行為面（零寫入、
    // B-15 對照、判定順序）在 `phase9-revision.test.ts` 之 T7b 區塊。
    //
    // Mutant：移除 `routes.ts` 之 B-16 守門 → 本則必紅（201）。
    // -----------------------------------------------------------------------
    it('400 VALIDATION_ERROR + fields[] 恰含 { field: "userId" }（B-16 擁有人已停用；error 鍵集封閉、零 details、零洩漏）', async () => {
      const inactiveOwner = await createUser("t7b-inactive");
      const source = await prisma.application.create({
        data: {
          type: "TRAVEL",
          status: "COMPLETED",
          ownerId: inactiveOwner.id,
          createdById: inactiveOwner.id,
          primaryDate: new Date("2026-05-10T00:00:00.000Z"),
          totalAmount: TOTAL_AMOUNT_MARKER,
          completedAt: new Date("2026-05-10T08:00:00.000Z"),
          travel: { create: { purpose: `${PURPOSE_MARKER}-t7b-inactive` } },
        },
      });
      createdApplicationIds.push(source.id);
      await prisma.user.update({
        where: { id: inactiveOwner.id },
        data: { isActive: false },
      });

      const resp = await postRevision(source.id, { cookie: adminCookie });
      expect(resp.statusCode).toBe(400);
      const body = JSON.parse(resp.body) as ErrorBody;
      expect(body.error?.code).toBe("VALIDATION_ERROR");
      // 逐字沿用 B-26（`admin/routes.ts` 三個代建端點）之文案與 `fields[]`。
      expect(body.error?.message).toBe("指定的使用者已停用，無法代其建立申請");
      expect(body.error?.fields).toEqual([{ field: "userId", reason: "指定的使用者已停用" }]);
      // `error` 鍵集封閉：`details` 專屬 409 兩格，本格不得出現。
      expect(Object.keys(body.error as Record<string, unknown>).sort()).toEqual(
        ["code", "fields", "message", "requestId"].sort()
      );
      expectNoLeakage(body);

      // 零寫入（wire 面之最小佐證；完整零寫入斷言見 revision 檔）。
      expect(await prisma.application.count({ where: { supersedesId: source.id } })).toBe(0);

      // 反向對照：同一管理員對**仍啟用**擁有人之來源仍 201（證明 400 非恆真）。
      const activeSourceId = await createCompletedTravel("t7b-active-control");
      const ok = await postRevision(activeSourceId, { cookie: adminCookie });
      expect(ok.statusCode).toBe(201);
      trackRevision(ok);
    });
  });

  // =========================================================================
  // §L — 500 INTERNAL_ERROR（§7.5 末列）＋ 代操作稽核同交易之端點層自證
  //
  // 手法沿 §G（T4）：於本 worker schema 對 `"AuditLog"` 建立僅對本測試專屬
  // `targetLabel` 前綴生效之 BEFORE INSERT 觸發器，使代操作稽核寫入必然失敗
  // ——
  //   · 正確實作（稽核在交易內）→ 整筆回滾：零修正版列、零稽核列、500。
  //   · Mutant（稽核移到交易後）→ 修正版已提交 → **必紅**。
  // =========================================================================

  describe("§7.5 500 INTERNAL_ERROR ＋ AC-26(b) 同交易之端點層自證（代操作稽核寫入失敗 → 整筆回滾）", () => {
    it("稽核 INSERT 於 DB 層失敗 → 500 INTERNAL_ERROR，零修正版列、零稽核列、零附件複製（稽核移出交易之 mutant 必紅）", async () => {
      const trapFn = `p9t7_audit_trap_${RUN_ID}`;
      const trapTrigger = `p9t7_audit_trap_trg_${RUN_ID}`;
      // 專屬擁有人：其 loginName 即 targetLabel 之前綴（`{loginName}#{id}`）。
      const trapOwner = await createUser("audittrap");
      const trapAdmin = await createUser("audittrapadmin", { role: "ADMIN" });

      const sourceRow = await prisma.application.create({
        data: {
          type: "TRAVEL",
          status: "COMPLETED",
          ownerId: trapOwner.id,
          createdById: trapOwner.id,
          primaryDate: new Date("2026-06-01T00:00:00.000Z"),
          totalAmount: 1234,
          completedAt: new Date("2026-06-01T08:00:00.000Z"),
          travel: { create: { purpose: "T7 audit trap fixture" } },
        },
      });
      createdApplicationIds.push(sourceRow.id);

      try {
        await prisma.$executeRawUnsafe(
          `CREATE OR REPLACE FUNCTION "${trapFn}"() RETURNS trigger AS $trap$
             BEGIN RAISE EXCEPTION 'p9t7 audit trap'; END;
           $trap$ LANGUAGE plpgsql;`
        );
        await prisma.$executeRawUnsafe(
          `CREATE TRIGGER "${trapTrigger}" BEFORE INSERT ON "AuditLog"
             FOR EACH ROW WHEN (NEW."targetLabel" LIKE '${trapOwner.loginName}#%')
             EXECUTE FUNCTION "${trapFn}"();`
        );

        const resp = await postRevision(sourceRow.id, { cookie: trapAdmin.cookie });
        expect(resp.statusCode).toBe(500);
        const body = JSON.parse(resp.body) as ErrorBody;
        expect(body.error?.code).toBe("INTERNAL_ERROR");
        expectNoLeakage(body);

        // 整筆回滾：零修正版列、零稽核列。
        expect(await prisma.application.count({ where: { supersedesId: sourceRow.id } })).toBe(0);
        expect(await prisma.auditLog.count({ where: { actorId: trapAdmin.id } })).toBe(0);
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trapTrigger}" ON "AuditLog";`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${trapFn}"();`);
      }

      // 反向對照：觸發器卸除後同一來源可正常建立修正版（證明上方 500 來自注
      // 入而非實作本身壞掉，避免「恆 500」之恆真式通過）。
      const okResp = await postRevision(sourceRow.id, { cookie: trapAdmin.cookie });
      expect(okResp.statusCode).toBe(201);
      trackRevision(okResp);
      expect(await prisma.auditLog.count({ where: { actorId: trapAdmin.id } })).toBe(1);
    });
  });
});
