/**
 * Integration test: PHASE-011-T5 — 清理落地後之 AD-US-04 拒刪守門回歸
 * （`docs/specs/PHASE-011.md` **AC-07(b)(c)**；`KNOWN_ISSUES.md` :111 §5-13）
 *
 * ---------------------------------------------------------------------------
 * 這個檔在問的問題（一句話）
 * ---------------------------------------------------------------------------
 * PHASE-011-T3／T4 讓「逾期暫存附件」**真的會被刪掉**。附件列正是 AD-US-04②
 * 拒刪守門的六條路徑之二（`Attachment.uploaderId`／`Attachment.ownerId`，
 * `users/history.ts` 之 `USER_RESTRICT_FK_GUARDS`）。於是有兩個方向要同時證：
 *
 *   · **放寬確實發生**（AC-07(b)）：被清理掉的那筆附件不再擋住帳號刪除；
 *   · **放寬不得過寬**（AC-07(c)）：其他任何歷史（未逾期附件、逾期但**尚未被
 *     清理**之附件、申請、稽核、油耗版本）一條都不許鬆。
 *
 * ---------------------------------------------------------------------------
 * 【FW-4：防套套邏輯——「已被清理」之狀態必須由真實執行器產生】
 * ---------------------------------------------------------------------------
 * 本檔**不以任何直寫刪除模擬清理後的狀態**。若以直寫刪掉附件列再去按刪除帳號，
 * 測的只是「列不見了守門會怎樣」——那件事 PHASE-010-T5 早就測過（零歷史使用者
 * 可刪），與「清理流程」毫無關係，整個 AC-07 會退化成恆真。
 *
 * 故本檔之唯一刪除來源是 `runCleanup`（`src/attachment/cleanup-cli.ts` 之真實
 * 執行器，`dryRun: false`，搭配真實 `LocalVolumeStorage`），並以三道證據釘住：
 *   ①**執行物證**：`summary.deletedCount`、`candidates` 之 id 集合、逐筆
 *     `stage: "deleted"` 日誌事件、以及 storage 位元組確實消失；
 *   ②**結構哨兵**：本檔 arrange／act／assert 全區（teardown 以外）零附件刪除
 *     呼叫、零 raw SQL 刪除——由 `FW4_TEARDOWN_SENTINEL` 之下方分界與一則自我
 *     掃描的 `it` 機械保證（見 `AC-07(b)／FW-4` 兩格）；
 *   ③**時序對照**：同一名使用者、同一個端點，**清理前 409 → 清理後 200**
 *     （`preRelaxUploaderProbe` vs `relaxUploaderProbe`），與**逾期但清理未涵蓋
 *     → 仍 409 → 再跑一輪清理 → 200**（`lateProbe` vs `lateAfterSecondRunProbe`）。
 *     ③使「放寬由清理造成」不是推論而是實測差值：把 act 段的 `runCleanup` 拿掉，
 *     正向格立刻因 409 而紅（Handoff 之 mutant 自證即此）。
 *
 * ---------------------------------------------------------------------------
 * 真刪之爆炸半徑（**Packet 轉述之勘誤一併記載**）
 * ---------------------------------------------------------------------------
 * 本 Task 之 Packet 稱「這將是**全 repo 首次**在測試中執行真刪（此前僅 dry-run
 * 與 CLI 手動）」——**實查不成立**：`phase11-attachment-cleanup.test.ts` :1229 之
 * `runReal` 早已以 `dryRun: false` ＋ 真實 `LocalVolumeStorage` 實刪，並斷言位元
 * 組確實消失（T4 已交付、已 APPROVE）。本檔是**第二個**這麼做的測試檔，射程與
 * 紀律沿用 T4，非新開先例。此更正不改變任何應採取之防護，只是不讓「首次」這個
 * 誇大的前提繼續被引用（同型失真傳播即 PHASE-009 之陳年註解事故）。
 *
 * 防護本身：`planCleanup` 掃的是**全表** `status=TEMP`（無 owner 過濾），故本檔
 * 對全表內容負全責——INFRA-001 之 per-worker schema ＋ per-file 清空使本檔起跑時
 * `Attachment` 表為空（`beforeAll` 內以一則斷言當場確認，不當前提用），全部種子
 * 由本檔自播、`afterAll` 自清。爆炸半徑因此限於本 worker 自己的 schema。
 * **誠實揭露**：若以 `TEST_DB_ISOLATION=off` 回退（INFRA-001 之單鍵回退模式）
 * 跑測試，全表掃描的射程會與 T4 既有之 `runReal` 完全相同——此為 T4 已存在之
 * 性質，本檔未擴大，亦未縮小。
 *
 * ---------------------------------------------------------------------------
 * 上游 FW-5（T3 即審）：種子形狀刻意合乎現行不變式
 * ---------------------------------------------------------------------------
 * 清理之實效條件＝`status=TEMP ∧ elapsed > TTL`（AR-1）。現行寫入路徑下 TEMP 之
 * `refType`／`refId` 恆為 `null`，故本檔種子**不構造引用態**：TEMP ＋ 逾期即為
 * 可清理形狀。「TEMP 但有引用 → 不得刪」之逐型格屬 T4 射程（同檔既有 30 格），
 * 本檔不重覆。
 *
 * ---------------------------------------------------------------------------
 * 與 `phase10-user-delete-regression.test.ts` 之關係（AC-07(a)）
 * ---------------------------------------------------------------------------
 * 該檔**零改動**即為 AC-07(a) 之證據（重跑全綠 ＋ `git diff` 空）。本檔刻意
 * **不** import 它的任何東西、不重覆它的 FK 完整性斷言，只補「清理之後」這一段
 * 它涵蓋不到的時間軸。
 *
 * ---------------------------------------------------------------------------
 * AC-07(d)：`PHASE-010.md` AC-14(b)② 之逐字期望（結論入 Handoff，非測試載體）
 * ---------------------------------------------------------------------------
 * 原文（`docs/specs/PHASE-010.md` :249）：
 *     「·**上傳過附件但無任何申請之使用者**（`Attachment.uploaderId`／
 *       `ownerId`；`TEMP` 態即成立）」→ 斷言 `409`（**非 500**）
 * 其成立條件是「**該附件列在場**」——`history.ts` 之生產判定逐字為「『有無歷史』
 * 只看**當下的列**，沒有『曾經有過』的概念」。清理刪掉的是列本身，故：
 *   · 列還在（未逾期／逾期但尚未清理）→ 期望**逐字仍成立**（本檔 (c)①(c)②）；
 *   · 列被清理刪除 → 該使用者已不再是「上傳過附件**且該附件仍在**」之人，
 *     不落入 AC-14(b)② 之前提，200 不構成該期望之反例（本檔 (b)②(b)③）。
 * 即：AC-14(b)② 是**對列在場之陳述**，清理只改變前提是否成立，不改變蘊涵本身。
 *
 * ---------------------------------------------------------------------------
 * 測試紀律（§11.0／`CLAUDE.md`）
 * ---------------------------------------------------------------------------
 *   · 全程合成資料（虛構帳號、姓名、目的、密碼）；零真實個資／secrets。
 *   · `loginName` 前綴 `p11t5`（不含 `_`／`%`，可安全用於 Prisma `startsWith`）
 *     ＋ 每次執行之隨機 `RUN_ID`；清理一律以本前綴／id 精確比對，禁用全域
 *     `deleteMany({})`。
 *   · 每一組「零刪除」斷言都是**前後整份快照比對**（使用者列 ＋ 六條 RESTRICT
 *     外鍵所指之全部列），不是「使用者還在」這種對半刪無鑑別力的單點檢查。
 *   · 全部 `DELETE /admin/users/:id` 於 `beforeAll` 內依固定順序送出並記錄結果，
 *     各 `it` 只做斷言——順序即被測時間軸本身，不可交由 `it` 執行序決定。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CleanupLogEvent, CleanupRunResult } from "../../src/attachment/cleanup-cli.js";
import { runCleanup } from "../../src/attachment/cleanup-cli.js";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";
import { LocalVolumeStorage } from "../../src/storage/index.js";
import type { Storage } from "../../src/storage/index.js";
import { USER_RESTRICT_FK_GUARDS } from "../../src/users/history.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** 刻意不含 `_`／`%`：可安全用於 Prisma `startsWith`（編譯為 SQL LIKE）。 */
const LOGIN_PREFIX = "p11t5";

/** 合成密碼（本檔全部帳號共用；零真實憑證）。 */
const PASSWORD = "Qv7-Lantern-Sorrel-4";
/** `POST /admin/users` 之 `temporaryPassword`（AuditLog.actorId 路徑之副產物帳號）。 */
const TEMP_PASSWORD = "Rn3-Basalt-Clover-8";

/** 本檔專屬參數年份（與其他 integration 檔零重疊）。 */
const PARAM_YEAR = 2056;

/**
 * 既有 409 文案（逐字）——生產側之單一事實來源為 `admin/routes.ts` 之
 * `HAS_HISTORY_CONFLICT_MESSAGE`。此處刻意**各自宣告**而非 import：測試若與被測
 * 程式共用同一個字串常數，有人改壞文案時兩邊會一起變、斷言恆真。
 */
const HAS_HISTORY_MESSAGE = "此帳號已有資料，無法刪除，請改用停用";

/** TTL 門檻（小時）——與 `ATTACHMENT_TEMP_TTL_HOURS` 之預設同值，注入而非讀 env。 */
const TTL_HOURS = 24;
/** 固定注入之「現在」——使逾期判定完全決定性（沿 T3／T4 之同一紀律）。 */
const NOW = new Date("2031-03-05T12:00:00.000Z");

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// FW-4 結構哨兵（見檔頭 ②）
// ---------------------------------------------------------------------------
/**
 * 本字面在本檔恰出現**兩次**：這一行的宣告，以及檔案下方之分界註解。分界註解
 * **以下**只允許 teardown（`afterAll`）；分界以上（helpers／`beforeAll`／全部
 * `it`）不得出現任何附件刪除或 raw SQL 刪除呼叫——否則「已被清理」之狀態就可能
 * 不是 `runCleanup` 造成的，AC-07(b) 隨即退化為恆真（FW-4）。
 */
const FW4_TEARDOWN_SENTINEL = "FW4-TEARDOWN-REGION-BELOW";

/**
 * 禁止出現於分界以上之刪除手法。**逐條以字串拼接／`String.raw` 組出**，使這幾行
 * 宣告本身不會命中自己（自我掃描的常見陷阱）。掃描前一律先去註解——檔頭與內文
 * 的說明性文字提到這些字樣不算違規。
 */
const FORBIDDEN_DELETE_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: "attachment delegate 刪除", re: /attachment\s*\.\s*delete/ },
  { name: "raw SQL 執行", re: new RegExp(`\\$execute${"Raw"}|\\$query${"RawUnsafe"}`) },
  { name: "raw DELETE 陳述", re: new RegExp(`DELETE${String.raw`\s+FROM`}`, "i") },
];

/** 去除區塊註解與行註解（以等長空白取代，行號可還原）。 */
function stripComments(content: string): string {
  const noBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlockComments.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

const SELF_PATH = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// 「其他歷史」矩陣（AC-07(c)：放寬不得過寬）
//
// 六條 RESTRICT 守門路徑中，附件佔兩條（由清理歸零）；其餘四條逐條各一格，
// 且每格之使用者**同時**持有一筆會被清理掉的逾期 TEMP 附件——如此該格之 409
// 必然來自「其他歷史」那一條，而非殘留的附件列（鑑別力來源）。
// 覆蓋之完整性由 `(c)⑤` 對 `USER_RESTRICT_FK_GUARDS` 之機械比對保證：日後新增
// 一條守門欄而未在此補格即紅。
// ---------------------------------------------------------------------------
interface OtherHistoryCase {
  /** 帳號後綴與 storage key 後綴。 */
  readonly key: string;
  /** 對應之守門「表.欄」（與 `USER_RESTRICT_FK_GUARDS` 逐字相同）。 */
  readonly guardColumn: string;
  /** 該格之人話說明（測試名用）。 */
  readonly label: string;
}

const OTHER_HISTORY_CASES: readonly OtherHistoryCase[] = [
  { key: "appown", guardColumn: "Application.ownerId", label: "自有草稿申請" },
  { key: "appcre", guardColumn: "Application.createdById", label: "代他人建立之草稿" },
  { key: "actor", guardColumn: "AuditLog.actorId", label: "曾執行被稽核之管理操作" },
  { key: "fuelv", guardColumn: "UserFuelConsumptionVersion.userId", label: "油耗版本" },
];

/** 附件之兩條守門欄——由清理歸零，故不在上方矩陣內。 */
const ATTACHMENT_GUARD_COLUMNS = ["Attachment.ownerId", "Attachment.uploaderId"];

interface CreatedUser {
  id: string;
  loginName: string;
}

interface SeededAttachment {
  readonly id: string;
  readonly storageKey: string;
  readonly thumbnailKey: string;
}

/** 一次 `DELETE /admin/users/:id` 之完整觀測（含零刪除比對所需之前後快照）。 */
interface DeleteProbe {
  readonly statusCode: number;
  readonly body: unknown;
  /** `AuditLog` 全表列數差（封閉斷言：任何額外寫入必紅）。 */
  readonly auditDelta: number;
  readonly snapshotBefore: string;
  readonly snapshotAfter: string;
}

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

describeWithDb("PHASE-011-T5 — 清理落地後之 AD-US-04 拒刪守門回歸（AC-07）", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let storageRoot: string;
  let realStorage: Storage;

  let adminId: string;
  let adminCookie: string;

  /** 附件之對造（代上傳者／被代建申請之 owner）；本身不是刪除對象。 */
  let peerId: string;

  // ── AC-07(b) 正向：僅有「已被清理」之暫存附件、其餘零歷史 ────────────────
  let uRelaxUploader: CreatedUser;
  let uRelaxOwner: CreatedUser;
  let attRelaxUploader: SeededAttachment;
  let attRelaxOwner: SeededAttachment;

  // ── AC-07(c) 負向：未逾期／逾期但清理未涵蓋 ─────────────────────────────
  let uFresh: CreatedUser;
  let attFresh: SeededAttachment;
  let uLate: CreatedUser;
  let attLate: SeededAttachment;

  // ── AC-07(c) 其他歷史四路徑 ─────────────────────────────────────────────
  const otherHistoryUsers = new Map<string, CreatedUser>();
  const otherHistoryProbes = new Map<string, DeleteProbe>();
  const otherHistoryAttachments = new Map<string, SeededAttachment>();

  // ── 清理前之對照探針（同一使用者、同一端點，只差「清理是否跑過」）────────
  let preRelaxUploaderProbe: DeleteProbe;
  let preRelaxOwnerProbe: DeleteProbe;

  // ── 清理後之探針 ───────────────────────────────────────────────────────
  let relaxUploaderProbe: DeleteProbe;
  let relaxOwnerProbe: DeleteProbe;
  let freshProbe: DeleteProbe;
  let lateProbe: DeleteProbe;
  let lateAfterSecondRunProbe: DeleteProbe;

  /** 刪除前之 `loginName` 快照（`USER_DELETED` 之 `targetLabel` 比對對象）。 */
  let relaxUploaderLoginSnapshot = "";
  let relaxOwnerLoginSnapshot = "";
  let lateLoginSnapshot = "";

  // ── 兩輪真實清理之產出（FW-4 之執行物證）──────────────────────────────
  let firstRun: CleanupRunResult;
  let firstRunEvents: CleanupLogEvent[] = [];
  let secondRun: CleanupRunResult;
  let secondRunEvents: CleanupLogEvent[] = [];
  /** 第一輪應被刪除之附件 id（本檔自播、逾期、無引用者）。 */
  let firstRunExpectedIds: string[] = [];
  /** 第一輪跑完後，`attFresh` 之位元組是否仍在（放寬不得過寬之 storage 面）。 */
  let freshBytesAfterFirstRun = false;

  // -------------------------------------------------------------------------
  // helpers（本區零刪除呼叫——FW-4 結構哨兵之射程）
  // -------------------------------------------------------------------------

  /** 引導身分：直寫（**前置狀態**，非被驗證之狀態；沿 PHASE-010-T5 之慣例）。 */
  async function bootstrapUser(
    suffix: string,
    role: "USER" | "ADMIN" = "USER"
  ): Promise<CreatedUser> {
    const loginName = `${LOGIN_PREFIX}${suffix}${RUN_ID}`;
    const user = await prisma.user.create({
      data: {
        loginName,
        displayName: `P11T5 ${suffix}`,
        passwordHash: await hashPassword(PASSWORD),
        role,
        isActive: true,
        mustChangePassword: false,
      },
    });
    return { id: user.id, loginName };
  }

  async function login(loginName: string): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName, password: PASSWORD },
    });
    if (resp.statusCode !== 200) {
      throw new Error(`Login failed for ${loginName}: ${resp.statusCode} ${resp.body}`);
    }
    const raw = resp.headers["set-cookie"];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) throw new Error(`No set-cookie for ${loginName}`);
    return header.split(";")[0] as string;
  }

  /** 送出請求，非預期狀態碼即刻拋（避免播種失敗被後續斷言誤讀）。 */
  async function callOk(
    url: string,
    cookie: string,
    payload: Record<string, unknown>,
    expectedStatus: number
  ): Promise<void> {
    const resp = await app.inject({ method: "POST", url, headers: { cookie }, payload });
    if (resp.statusCode !== expectedStatus) {
      throw new Error(
        `POST ${url} → ${resp.statusCode} (expected ${expectedStatus}): ${resp.body}`
      );
    }
  }

  /**
   * 播一筆 TEMP 附件（DB 列 ＋ storage 位元組）。**前置狀態直寫**，沿
   * PHASE-010-T5 `Attachment` 列與 PHASE-011-T3／T4 `seedAttachment` 之既有先例；
   * 被驗證之狀態（刪除／拒刪之行為、清理之實刪）一律經真實路徑產生。
   */
  async function seedTempAttachment(args: {
    key: string;
    uploaderId: string;
    ownerId: string;
    createdAt: Date;
  }): Promise<SeededAttachment> {
    const suffix = `${LOGIN_PREFIX}-${RUN_ID}-${args.key}`;
    const storageKey = `att/${suffix}/original`;
    const thumbnailKey = `att/${suffix}/thumb`;
    const created = await prisma.attachment.create({
      data: {
        status: "TEMP",
        storageKey,
        thumbnailKey,
        mimeType: "image/jpeg",
        byteSize: 128,
        originalFilename: `合成收據-${args.key}.jpg`,
        uploaderId: args.uploaderId,
        ownerId: args.ownerId,
        createdAt: args.createdAt,
      },
    });
    await realStorage.put(storageKey, Buffer.alloc(128, 0xbb), "image/jpeg");
    await realStorage.put(thumbnailKey, Buffer.alloc(32, 0xcc), "image/jpeg");
    return { id: created.id, storageKey, thumbnailKey };
  }

  /**
   * **唯一的刪除來源**（FW-4）：真實執行器、真實 storage、`dryRun: false`。
   * `now` 與 `ttlHours` 注入而非讀 env，使逾期判定完全決定性。
   */
  async function runRealCleanup(): Promise<{
    result: CleanupRunResult;
    events: CleanupLogEvent[];
  }> {
    const events: CleanupLogEvent[] = [];
    const result = await runCleanup(prisma, realStorage, {
      now: NOW,
      ttlHours: TTL_HOURS,
      limit: 500,
      dryRun: false,
      logger: { log: (event) => events.push(event) },
    });
    return { result, events };
  }

  /**
   * 「零刪除」之比對基準：使用者列 ＋ 六條 RESTRICT 外鍵所指之全部列 ＋ 其申請
   * 之報表列，整份序列化。刻意不只看「使用者還在」——後者對「連帶資料被刪掉
   * 一半」完全沒有鑑別力（沿 PHASE-010-T5 `snapshotUserWorld`）。
   */
  async function snapshotUserWorld(userId: string): Promise<string> {
    const [user, applications, attachments, auditLogs, fuelVersions] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.application.findMany({
        where: { OR: [{ ownerId: userId }, { createdById: userId }] },
        orderBy: { id: "asc" },
      }),
      prisma.attachment.findMany({
        where: { OR: [{ uploaderId: userId }, { ownerId: userId }] },
        orderBy: { id: "asc" },
      }),
      prisma.auditLog.findMany({
        where: { OR: [{ actorId: userId }, { targetId: userId }] },
        orderBy: { id: "asc" },
      }),
      prisma.userFuelConsumptionVersion.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    ]);
    const reports = await prisma.report.findMany({
      where: { applicationId: { in: applications.map((a) => a.id) } },
      orderBy: { id: "asc" },
    });
    return JSON.stringify({ user, applications, attachments, auditLogs, fuelVersions, reports });
  }

  /** 一次 `DELETE /admin/users/:id` ＋ 其前後快照與稽核列數差。 */
  async function probeDelete(userId: string): Promise<DeleteProbe> {
    const snapshotBefore = await snapshotUserWorld(userId);
    const auditBefore = await prisma.auditLog.count();
    const resp = await app.inject({
      method: "DELETE",
      url: `/admin/users/${userId}`,
      headers: { cookie: adminCookie },
    });
    const auditAfter = await prisma.auditLog.count();
    const snapshotAfter = await snapshotUserWorld(userId);
    return {
      statusCode: resp.statusCode,
      body: resp.json(),
      auditDelta: auditAfter - auditBefore,
      snapshotBefore,
      snapshotAfter,
    };
  }

  /** 該使用者名下（uploader 或 owner）之附件列數。 */
  async function attachmentCountFor(userId: string): Promise<number> {
    return prisma.attachment.count({
      where: { OR: [{ uploaderId: userId }, { ownerId: userId }] },
    });
  }

  /** 恰一條 `USER_DELETED` 之逐欄斷言（AC-07(b) 之稽核半邊）。 */
  async function expectUserDeletedAudit(loginSnapshot: string): Promise<void> {
    const rows = await prisma.auditLog.findMany({
      where: { action: "USER_DELETED", targetLabel: loginSnapshot },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetId).toBeNull();
    expect(rows[0]?.actorId).toBe(adminId);
  }

  // -------------------------------------------------------------------------

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "silent" });
    await app.ready();

    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `p11t5-${RUN_ID}-`));
    realStorage = new LocalVolumeStorage(storageRoot);

    // 全表前提（不當前提用，當場確認）：`planCleanup` 掃全表 `status=TEMP`，
    // 本檔對全表內容負全責。INFRA-001 之 per-file 清空使此處必為 0；若非 0，
    // 讓它當場紅比讓真刪射到不明資料好。
    expect(await prisma.attachment.count()).toBe(0);

    const admin = await bootstrapUser("admin", "ADMIN");
    adminId = admin.id;
    adminCookie = await login(admin.loginName);

    const peer = await bootstrapUser("peer");
    peerId = peer.id;

    // ── AC-07(b) 正向兩格：附件之兩條守門欄各一名 ────────────────────────
    // uploaderId 路徑：自己上傳、附件掛在對造名下。
    uRelaxUploader = await bootstrapUser("relaxupl");
    relaxUploaderLoginSnapshot = uRelaxUploader.loginName;
    attRelaxUploader = await seedTempAttachment({
      key: "relaxupl",
      uploaderId: uRelaxUploader.id,
      ownerId: peerId,
      createdAt: hoursAgo(25),
    });
    // ownerId 路徑：對造代為上傳、附件掛在自己名下。
    uRelaxOwner = await bootstrapUser("relaxown");
    relaxOwnerLoginSnapshot = uRelaxOwner.loginName;
    attRelaxOwner = await seedTempAttachment({
      key: "relaxown",
      uploaderId: peerId,
      ownerId: uRelaxOwner.id,
      createdAt: hoursAgo(25),
    });

    // ── AC-07(c)① 未逾期暫存附件（清理跑過也不會碰它）────────────────────
    uFresh = await bootstrapUser("fresh");
    attFresh = await seedTempAttachment({
      key: "fresh",
      uploaderId: uFresh.id,
      ownerId: uFresh.id,
      createdAt: hoursAgo(1),
    });

    // ── AC-07(c)④~⑦ 其他歷史四路徑（每人另帶一筆會被清掉的逾期附件）──────
    for (const testCase of OTHER_HISTORY_CASES) {
      const role = testCase.guardColumn === "AuditLog.actorId" ? "ADMIN" : "USER";
      const user = await bootstrapUser(testCase.key, role);
      otherHistoryUsers.set(testCase.key, user);
      otherHistoryAttachments.set(
        testCase.key,
        await seedTempAttachment({
          key: testCase.key,
          uploaderId: user.id,
          ownerId: user.id,
          createdAt: hoursAgo(30),
        })
      );
    }

    // Application.ownerId：自有草稿（本人真實端點）。
    const appOwn = otherHistoryUsers.get("appown") as CreatedUser;
    const appOwnCookie = await login(appOwn.loginName);
    await callOk(
      "/applications/travel",
      appOwnCookie,
      { tripDate: `${PARAM_YEAR}-03-05`, purpose: "合成出差目的：自有草稿路徑" },
      201
    );

    // Application.createdById：代他人建立之草稿。
    // **刻意直寫**（沿 PHASE-010-T5 檔頭之同一理由）：走代操作端點會同時產生一
    // 條 `AuditLog.actorId` 指向該人的稽核列，本格即使 `createdById` 完全沒被守
    // 門也會通過，鑑別力歸零。故直寫出「只有 createdById 一條路徑」之乾淨狀態。
    const appCre = otherHistoryUsers.get("appcre") as CreatedUser;
    await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: peerId,
        createdById: appCre.id,
        primaryDate: new Date(`${PARAM_YEAR}-04-01T00:00:00.000Z`),
        travel: {
          create: {
            tripDate: new Date(`${PARAM_YEAR}-04-01T00:00:00.000Z`),
            purpose: "合成出差目的：代建草稿（createdById 路徑）",
          },
        },
      },
    });

    // AuditLog.actorId：以該管理員之身分執行一次被稽核之操作（真實端點）。
    const actorUser = otherHistoryUsers.get("actor") as CreatedUser;
    const actorCookie = await login(actorUser.loginName);
    await callOk(
      "/admin/users",
      actorCookie,
      {
        loginName: `${LOGIN_PREFIX}byactor${RUN_ID}`,
        displayName: "P11T5 byactor",
        temporaryPassword: TEMP_PASSWORD,
      },
      201
    );

    // UserFuelConsumptionVersion.userId：管理員為其設定油耗（真實端點）。
    const fuelUser = otherHistoryUsers.get("fuelv") as CreatedUser;
    await callOk(
      `/users/${fuelUser.id}/fuel-consumption`,
      adminCookie,
      {
        fuelType: "GASOLINE_95",
        kmPerLiter: "12.0000",
        effectiveFrom: `${PARAM_YEAR}-02-01`,
        basisNote: "合成依據備註：油耗版本路徑",
      },
      201
    );

    // =====================================================================
    // 時間軸（順序即被測內容，不可交由 `it` 執行序決定）
    // =====================================================================

    // ① **清理之前**：兩名「只有逾期暫存附件」之使用者確實被擋（409）。
    //    這一格與下方 ③ 構成同一使用者的前後差值——放寬確由清理造成之直接物證。
    preRelaxUploaderProbe = await probeDelete(uRelaxUploader.id);
    preRelaxOwnerProbe = await probeDelete(uRelaxOwner.id);

    // ② **第一輪真實清理**（唯一刪除來源）。
    firstRunExpectedIds = [
      attRelaxUploader.id,
      attRelaxOwner.id,
      ...[...otherHistoryAttachments.values()].map((a) => a.id),
    ];
    const first = await runRealCleanup();
    firstRun = first.result;
    firstRunEvents = first.events;
    freshBytesAfterFirstRun = await realStorage.exists(attFresh.storageKey);

    // ③ 清理後：兩條附件路徑之放寬（正向格）。
    relaxUploaderProbe = await probeDelete(uRelaxUploader.id);
    relaxOwnerProbe = await probeDelete(uRelaxOwner.id);

    // ④ 清理後：未逾期附件仍在 → 仍 409（放寬不得過寬）。
    freshProbe = await probeDelete(uFresh.id);

    // ⑤ 清理後：其他歷史四路徑仍 409（附件已歸零，409 只能來自該條歷史）。
    for (const testCase of OTHER_HISTORY_CASES) {
      const user = otherHistoryUsers.get(testCase.key) as CreatedUser;
      otherHistoryProbes.set(testCase.key, await probeDelete(user.id));
    }

    // ⑥ **清理之後**才出現的逾期附件：逾期本身不放寬，仍 409。
    //    這一格擋掉「其實是『已逾期』在放寬、跟清理無關」這個致命的替代解釋。
    uLate = await bootstrapUser("late");
    lateLoginSnapshot = uLate.loginName;
    attLate = await seedTempAttachment({
      key: "late",
      uploaderId: uLate.id,
      ownerId: uLate.id,
      createdAt: hoursAgo(30),
    });
    lateProbe = await probeDelete(uLate.id);

    // ⑦ 對同一列再跑一輪清理 → 200。409 → 清理 → 200 之閉環。
    const second = await runRealCleanup();
    secondRun = second.result;
    secondRunEvents = second.events;
    lateAfterSecondRunProbe = await probeDelete(uLate.id);
  }, 120_000);

  // =========================================================================
  // AC-07(b) — 正向：僅有「已被清理」之暫存附件、其餘零歷史 → 200 ＋ 稽核列
  // =========================================================================

  describe("AC-07(b): 僅有已被清理之暫存附件、其餘零歷史 → 200 ＋ USER_DELETED 稽核列", () => {
    it("(b)① 清理之前：同一名使用者被該筆逾期暫存附件擋下（409 ＋ 既有文案 ＋ 零刪除）", () => {
      for (const probe of [preRelaxUploaderProbe, preRelaxOwnerProbe]) {
        expect(probe.statusCode).toBe(409);
        const body = probe.body as ErrorBody;
        expect(body.error.code).toBe("CONFLICT");
        expect(body.error.message).toBe(HAS_HISTORY_MESSAGE);
        expect(probe.auditDelta).toBe(0);
        expect(probe.snapshotAfter).toBe(probe.snapshotBefore);
      }
    });

    it("(b)② uploaderId 路徑：清理後 → 200 { ok: true }，使用者列確實消失", async () => {
      expect(relaxUploaderProbe.statusCode).toBe(200);
      expect(relaxUploaderProbe.body).toEqual({ ok: true });
      await expect(prisma.user.count({ where: { id: uRelaxUploader.id } })).resolves.toBe(0);
      await expect(
        prisma.user.count({ where: { loginName: relaxUploaderLoginSnapshot } })
      ).resolves.toBe(0);
    });

    it("(b)③ ownerId 路徑：清理後 → 200 { ok: true }，使用者列確實消失", async () => {
      expect(relaxOwnerProbe.statusCode).toBe(200);
      expect(relaxOwnerProbe.body).toEqual({ ok: true });
      await expect(prisma.user.count({ where: { id: uRelaxOwner.id } })).resolves.toBe(0);
      await expect(
        prisma.user.count({ where: { loginName: relaxOwnerLoginSnapshot } })
      ).resolves.toBe(0);
    });

    it("(b)④ 兩格各恰一條 USER_DELETED：targetId 為 null、targetLabel 為刪除前 loginName、actorId 為管理員", async () => {
      // 「恰一條」由兩道獨立斷言承擔：全表列數差恰 1（封閉，任何額外寫入必紅）
      // ＋ 該 targetLabel 之列恰 1。
      expect(relaxUploaderProbe.auditDelta).toBe(1);
      expect(relaxOwnerProbe.auditDelta).toBe(1);
      await expectUserDeletedAudit(relaxUploaderLoginSnapshot);
      await expectUserDeletedAudit(relaxOwnerLoginSnapshot);
    });

    it("(b)⑤／FW-4 執行物證：放寬所依賴之刪除確由真實 runCleanup 產生（候選集合／deletedCount／deleted 日誌／storage 位元組四面一致）", async () => {
      // ① 候選集合恰為本檔自播之逾期無引用者（未逾期之 attFresh 不在其中）。
      expect([...firstRun.candidates].map((c) => c.id).sort()).toEqual(
        [...firstRunExpectedIds].sort()
      );
      expect(firstRun.candidates.some((c) => c.id === attFresh.id)).toBe(false);

      // ② 摘要：掃描 7 筆 TEMP、實刪 6 筆、零失敗、零跳過。
      expect(firstRun.summary.dryRun).toBe(false);
      expect(firstRun.summary.scannedCount).toBe(firstRunExpectedIds.length + 1);
      expect(firstRun.summary.deletedCount).toBe(firstRunExpectedIds.length);
      expect(firstRun.summary.failedCount).toBe(0);
      expect(firstRun.summary.skippedCount).toBe(0);

      // ③ 逐筆 `deleted` 日誌事件（執行器真的走過每一筆的刪除路徑）。
      const deletedIds = firstRunEvents
        .filter((e) => e.stage === "deleted")
        .map((e) => e.attachmentId);
      expect([...deletedIds].sort()).toEqual([...firstRunExpectedIds].sort());

      // ④ DB 列與 storage 位元組皆真的不見了（不是只把列標記掉）。
      await expect(
        prisma.attachment.count({ where: { id: { in: firstRunExpectedIds } } })
      ).resolves.toBe(0);
      for (const seeded of [attRelaxUploader, attRelaxOwner]) {
        await expect(realStorage.exists(seeded.storageKey)).resolves.toBe(false);
        await expect(realStorage.exists(seeded.thumbnailKey)).resolves.toBe(false);
      }
    });

    it("(b)⑥／FW-4 結構哨兵：本檔 arrange／act／assert 全區零附件刪除、零 raw SQL 刪除（唯一刪除來源為 runCleanup）", () => {
      const source = fs.readFileSync(SELF_PATH, "utf8");

      // 哨兵字面恰兩處：本常數宣告 ＋ 下方分界註解。多一處即代表有人另闢
      // teardown 區藏刪除，直接紅。
      const occurrences = source.split(FW4_TEARDOWN_SENTINEL).length - 1;
      expect(occurrences).toBe(2);

      const boundary = source.lastIndexOf(FW4_TEARDOWN_SENTINEL);
      const scanned = stripComments(source.slice(0, boundary));
      for (const pattern of FORBIDDEN_DELETE_PATTERNS) {
        expect({ name: pattern.name, hit: pattern.re.test(scanned) }).toEqual({
          name: pattern.name,
          hit: false,
        });
      }

      // 掃描器自身之鑑別力（防「正則寫壞了所以永遠零命中」）：對合成內容必命中。
      // 三行**刻意以字串拼接組出**——直接寫成字面會讓這幾行自己落入上方的掃描
      // 射程（實測：首輪即因此誤紅），拼接後原始碼不含連續字面、執行期才成形。
      const synthetic = [
        `await prisma.attachment.${"delete"}Many({ where: { id } });`,
        `await prisma.$execute${"Raw"}Unsafe(sql);`,
        `await prisma.$query${"RawUnsafe"}('${"DELETE"} FROM "Attachment"');`,
      ].join("\n");
      for (const pattern of FORBIDDEN_DELETE_PATTERNS) {
        expect({ name: pattern.name, hit: pattern.re.test(synthetic) }).toEqual({
          name: pattern.name,
          hit: true,
        });
      }

      // 真實執行器恰被呼叫於一處包裝函式內（`runRealCleanup`），不另闢第二條。
      const callSites = stripComments(source).match(/\brunCleanup\s*\(/g) ?? [];
      expect(callSites).toHaveLength(1);
    });
  });

  // =========================================================================
  // AC-07(c) — 負向對照：放寬不得過寬
  // =========================================================================

  describe("AC-07(c) 負向: 放寬不得過寬", () => {
    it("(c)① 未逾期暫存附件 → 仍 409 ＋ 零刪除（附件列與位元組皆完好）", async () => {
      expect(freshProbe.statusCode).toBe(409);
      const body = freshProbe.body as ErrorBody;
      expect(body.error.code).toBe("CONFLICT");
      expect(body.error.message).toBe(HAS_HISTORY_MESSAGE);
      expect(freshProbe.auditDelta).toBe(0);
      expect(freshProbe.snapshotAfter).toBe(freshProbe.snapshotBefore);
      // 清理未動它：DB 列在、位元組在、使用者仍在。
      await expect(prisma.attachment.count({ where: { id: attFresh.id } })).resolves.toBe(1);
      expect(freshBytesAfterFirstRun).toBe(true);
      await expect(prisma.user.count({ where: { id: uFresh.id } })).resolves.toBe(1);
    });

    it("(c)② 逾期但清理未涵蓋（清理跑完之後才存在）→ 仍 409：放寬源自「列被刪除」而非「已逾期」", () => {
      expect(lateProbe.statusCode).toBe(409);
      const body = lateProbe.body as ErrorBody;
      expect(body.error.message).toBe(HAS_HISTORY_MESSAGE);
      expect(lateProbe.auditDelta).toBe(0);
      expect(lateProbe.snapshotAfter).toBe(lateProbe.snapshotBefore);
      // 這一列**確實已逾期**（否則本格淪為 (c)① 的重覆）：第二輪清理把它選入
      // 候選並刪除，即為其可清理性之事後證明。
      expect(secondRun.candidates.map((c) => c.id)).toEqual([attLate.id]);
    });

    it("(c)③ 同一列經第二輪清理後 → 200 ＋ USER_DELETED：409 → 清理 → 200 之閉環", async () => {
      expect(secondRun.summary.deletedCount).toBe(1);
      expect(
        secondRunEvents.filter((e) => e.stage === "deleted").map((e) => e.attachmentId)
      ).toEqual([attLate.id]);
      expect(lateAfterSecondRunProbe.statusCode).toBe(200);
      expect(lateAfterSecondRunProbe.body).toEqual({ ok: true });
      expect(lateAfterSecondRunProbe.auditDelta).toBe(1);
      await expectUserDeletedAudit(lateLoginSnapshot);
      await expect(prisma.user.count({ where: { id: uLate.id } })).resolves.toBe(0);
    });

    for (const testCase of OTHER_HISTORY_CASES) {
      it(`(c)④ 其他歷史一條不鬆 — ${testCase.guardColumn}（${testCase.label}）：附件已被清理，仍 409 ＋ 零刪除`, async () => {
        const user = otherHistoryUsers.get(testCase.key) as CreatedUser;
        const probe = otherHistoryProbes.get(testCase.key) as DeleteProbe;

        // 鑑別力前提：該人名下之附件確已被清理歸零，故 409 只能來自
        // `${testCase.guardColumn}` 這一條路徑，而不是殘留的附件列。
        await expect(attachmentCountFor(user.id)).resolves.toBe(0);

        expect(probe.statusCode).toBe(409);
        const body = probe.body as ErrorBody;
        expect(body.error.code).toBe("CONFLICT");
        expect(body.error.message).toBe(HAS_HISTORY_MESSAGE);
        expect(probe.auditDelta).toBe(0);
        expect(probe.snapshotAfter).toBe(probe.snapshotBefore);
        await expect(prisma.user.count({ where: { id: user.id } })).resolves.toBe(1);
      });
    }

    it("(c)⑤ 覆蓋自證：六條守門欄＝附件二條（由清理歸零）＋ 本檔矩陣四條，日後新增守門欄而未補格即紅", () => {
      const guardColumns = USER_RESTRICT_FK_GUARDS.map((g) => `${g.table}.${g.column}`).sort();
      const covered = [
        ...ATTACHMENT_GUARD_COLUMNS,
        ...OTHER_HISTORY_CASES.map((c) => c.guardColumn),
      ].sort();
      expect(covered).toEqual(guardColumns);
    });
  });

  // ---------------------------------------------------------------------------
  // FW4-TEARDOWN-REGION-BELOW
  //
  // 分界以下**只有** teardown。`afterAll` 刻意寫在全部 `it` 之後（而非慣例上的
  // 檔頭），使上方之 FW-4 結構哨兵能以「檔案位置」機械界定「非 teardown 區」——
  // vitest 於 `describe` callback 全數求值後才執行，hook 註冊位置不影響時序。
  //
  // 刪除順序即外鍵相依順序（子 → 父）：六條 RESTRICT 外鍵所指之列必須先於
  // `User` 清掉——這正是本檔所驗證之守門在測試側的鏡像。
  // ---------------------------------------------------------------------------

  afterAll(async () => {
    if (!DB_URL) return;
    await app?.close();

    if (prisma) {
      const own = await prisma.user.findMany({
        where: { loginName: { startsWith: LOGIN_PREFIX } },
        select: { id: true },
      });
      const ids = own.map((u) => u.id);
      if (ids.length > 0) {
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await prisma.auditLog.deleteMany({ where: { targetId: { in: ids } } });
        const apps = await prisma.application.findMany({
          where: { OR: [{ ownerId: { in: ids } }, { createdById: { in: ids } }] },
          select: { id: true },
        });
        const appIds = apps.map((a) => a.id);
        if (appIds.length > 0) {
          await prisma.report.deleteMany({ where: { applicationId: { in: appIds } } });
          await prisma.application.deleteMany({ where: { id: { in: appIds } } });
        }
        await prisma.attachment.deleteMany({ where: { uploaderId: { in: ids } } });
        await prisma.attachment.deleteMany({ where: { ownerId: { in: ids } } });
        await prisma.userFuelConsumptionVersion.deleteMany({ where: { userId: { in: ids } } });
        await prisma.session.deleteMany({ where: { userId: { in: ids } } });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
      }
      await prisma.$disconnect();
    }

    if (storageRoot && fs.existsSync(storageRoot)) {
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
