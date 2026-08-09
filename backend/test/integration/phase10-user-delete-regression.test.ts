/**
 * Integration test: PHASE-010-T5 — AD-US-04 有歷史拒刪完整回歸 ＋ FK 守門補齊
 * （AC-12／AC-13／AC-14；`docs/specs/PHASE-010.md` §2 D 段）
 *
 * ---------------------------------------------------------------------------
 * 涵蓋
 * ---------------------------------------------------------------------------
 *   · **AC-12** 五類歷史逐一拒刪 ＋ 提供停用選項
 *       (a) 五類真實資料（①`DRAFT`②`COMPLETED`③`VOIDED`④已產生正式報表
 *           ⑤`UserFuelConsumptionVersion`）各一名獨立使用者 → `DELETE
 *           /admin/users/:id` → `409 CONFLICT` ＋ 既有文案「此帳號已有資料，
 *           無法刪除，請改用停用」（`admin/routes.ts` 實查），且**零刪除**
 *           （使用者列與其資料逐欄不變——前後整份快照 `toEqual`）；
 *       (b) 「提供停用選項」以回應文案承載（既有語意，本檔不新增使用者可見
 *           行為，故其斷言即 (a) 之文案逐字比對）；
 *       (c) `VOIDED` 一類以**真實作廢端點** `POST /applications/:id/void`
 *           構造（非 raw SQL 直寫 `status`）。
 *   · **AC-13** 無歷史可刪 ＋ 刪除稽核
 *       (a) 零歷史使用者 → `200 { ok: true }`，該列確實消失；
 *       (b) 恰一條 `USER_DELETED`：`targetId` 為 `null`、`targetLabel` 為刪除
 *           前 `loginName` 快照；
 *       (c) 該列可經 `GET /admin/audit-logs` 取回且 `targetDisplayName` 為
 *           `null`。
 *   · **AC-14** FK `ON DELETE RESTRICT` 之守門完整性（§16 **D5=(c)**）
 *       (a) 以 `information_schema` 列舉指向 `User` 之全部外鍵與其
 *           `delete_rule`，斷言「RESTRICT／NO ACTION」之表集合與**欄集合**
 *           恰等於 `USER_RESTRICT_FK_GUARDS` 之宣告；
 *       (b) 三條缺口路徑（`AuditLog.actorId`／`Attachment.uploaderId`＋
 *           `Attachment.ownerId`／`Application.createdById`）逐一構造真實資料
 *           並斷言 `409`（**非 500**）；
 *       (d) 兩邊都補之縱深：守門擴充（本檔 AC-14(a)(b)）＋ 端點 P2003 兜底
 *           （本檔 AC-14(d)：以 `hasHistory: async () => false` 刻意打開守門，
 *           證明兜底單獨也能把 P2003 轉成同一條 409）。
 *   · **B-14~B-18**（Spec §5）：B-14/B-15/B-16 即 AC-14(b) 三格；B-17（刪自己
 *     → 409「不可對自己執行此操作」）與 B-18（不存在 → 404）為既有行為之零變更
 *     回歸，於本檔一併釘住**判定順序**（自我守門先於歷史守門）。
 *
 * ---------------------------------------------------------------------------
 * 首步 spike 結論（Spec §11.6 之方法論風險，Packet Done When 第一項）
 * ---------------------------------------------------------------------------
 * `information_schema.referential_constraints` ＋ `key_column_usage` ＋
 * `constraint_column_usage` 之三方 join 在 per-worker schema
 * （INFRA-001 之 `vitest_w<N>`）下**可行**：實跑列舉出恰 8 條指向 `User` 的
 * 外鍵、`delete_rule` 逐條正確（6 條 `RESTRICT`、`Session.userId` 為 `CASCADE`、
 * `AuditLog.targetId` 為 `SET NULL`），與 Spec §2 AC-14 之實查基線逐字相符。
 * 故**不需**退回替代路徑（`migration.sql` 之 `REFERENCES "User"` 字面掃描）。
 * 查詢一律以 `rc.constraint_schema = current_schema()` 侷限於本 worker 自己的
 * schema——`information_schema` 是 cluster 範圍的視圖，不侷限即會把其他 worker
 * schema 的同名約束一併聚合進來（與 `phase5a-migration-safety.test.ts` :539-559
 * 對 `pg_type`／`pg_namespace` 之 `nspname` 侷限同一道理）。
 *
 * ---------------------------------------------------------------------------
 * 「真實端點」紀律之精確射程（Spec §11.0 #4；Packet 上游 FW-4 判讀逐字寫入）
 * ---------------------------------------------------------------------------
 * §11.0 #4 之禁止對象為「**以直寫構造被驗證之狀態**」。本 Task 被驗證之狀態＝
 * **拒刪／刪除之行為與其 `USER_DELETED` 稽核列**，其中：
 *   · `VOIDED` 態依 AC-12(a)③(c) **必須**經真實作廢端點產生；
 *   · `USER_DELETED` 依 AC-13 **必須**經真實 `DELETE /admin/users/:id` 產生；
 *   · 其餘**前置資料**（已完成申請快照、`Report` 列、`Attachment` 列、代建申
 *     請之 `createdById` 列）以 `prisma.*.create` 直寫，沿 `phase9-void.test.ts`
 *     ／`phase9-revision.test.ts`／`phase10-audit-completeness.test.ts`
 *     （`createCompletedTravel`）之既有先例。
 * 另有一處**刻意**的直寫，理由是鑑別力而非成本，特此揭露：AC-14(b) 第四格之
 * 「代他人建立過草稿、自己無申請之管理員」若改以真實代操作端點
 * （`POST /admin/users/:id/applications/travel`）構造，會**同時**產生一條
 * `AuditLog.actorId` 指向該管理員的稽核列——如此一來即使
 * `Application.createdById` 完全沒被守門，該格仍會因 `AuditLog.actorId` 而通過，
 * 這一格的鑑別力歸零。故該格以直寫構造**只有** `Application.createdById` 一條
 * 路徑的乾淨狀態，讓它真正只驗證它宣稱要驗證的那條外鍵。
 *
 * ---------------------------------------------------------------------------
 * 上游 FW（Packet 必引）
 * ---------------------------------------------------------------------------
 *   · **T3 即審 FW-3**：`AuditLog.actorId` 為 RESTRICT 之現成物證——T3 檔
 *     （`phase10-audit-completeness.test.ts`）:403 清理註解「稽核列必須先於使
 *     用者刪除」與 :579 之 `DELETE /admin/users/:id` → 200 的對照（該處 `uDeleted`
 *     從未當過 actor，故可刪）。本檔 AC-14(b) 第一格即把「當過 actor」這一半
 *     補上。
 *   · **T2 即審 FW-4／T3 覆核**：`AuditLog.targetId` 為 `SET NULL`、`actorId`
 *     為 `RESTRICT`，兩語意分野——**被操作過的人可刪，操作過的人不可刪**。
 *     `targetId` **不入**拒刪清單，本檔以一則獨立斷言把這個「刻意不納入」釘住
 *     （否則日後有人「順手補齊」就會讓 AC-13 的可刪路徑整條消失）。
 *   · **B-09 存在性側信道**（Spec §5）：本檔沿既有端點之判定順序（自我守門 →
 *     404 存在性 → 歷史守門），不新增洩漏面。
 *
 * ---------------------------------------------------------------------------
 * 測試紀律（§11.0／`CLAUDE.md`）
 * ---------------------------------------------------------------------------
 *   · 全程合成資料（虛構帳號、姓名、目的、密碼）；零真實個資／secrets。
 *   · `loginName` 前綴 `p10t5`（刻意不含 `_`／`%`，可安全用於 Prisma
 *     `startsWith`＝SQL LIKE）＋ 每次執行之隨機 `RUN_ID`。
 *   · 清理一律以本檔前綴／id 精確比對；**禁用**全域 `deleteMany({})`。
 *   · 每一組「零刪除」斷言都是**前後整份快照比對**，不是「使用者列還在」這種
 *     單點檢查——後者對「連帶資料被刪掉一半」無鑑別力。
 */

import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPlugin, isPrismaForeignKeyConstraintError } from "../../src/admin/routes.js";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";
import { USER_RESTRICT_FK_GUARDS, userHasHistory } from "../../src/users/history.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** 刻意不含 `_`／`%`：可安全用於 Prisma `startsWith`（編譯為 SQL LIKE）。 */
const LOGIN_PREFIX = "p10t5";

/** 合成密碼（本檔全部帳號共用；零真實憑證）。 */
const PASSWORD = "Zt4-Cinder-Marigold-3";
/** `POST /admin/users` 之 `temporaryPassword`（AC-13 之可刪帳號）。 */
const TEMP_PASSWORD = "Ly8-Quartz-Bramble-2";

/** 本檔專屬參數年份（與其他 integration 檔零重疊）。 */
const PARAM_YEAR = 2054;

/**
 * 既有 409 文案（逐字，AC-12(a)(b)）——生產側之單一事實來源為
 * `admin/routes.ts` 之 `HAS_HISTORY_CONFLICT_MESSAGE`。
 * 此處刻意**各自宣告**而非 import：測試若與被測程式共用同一個字串常數，
 * 有人改壞文案時兩邊會一起變、斷言恆真。
 */
const HAS_HISTORY_MESSAGE = "此帳號已有資料，無法刪除，請改用停用";
/** `DELETE /admin/users/:id` 之自我守門文案（B-17，既有行為零變更）。 */
const SELF_OPERATION_MESSAGE = "不可對自己執行此操作";

// ---------------------------------------------------------------------------
// Spec §2 AC-14 之實查基線（指向 `User` 之全部外鍵，逐條）。
// 刻意逐條寫死而非由 DB 反推：這一份是「Spec 說 DB 應該長這樣」的獨立宣告，
// 與 DB 實況比對才有意義；若改成從 DB 生成即成恆真。
// ---------------------------------------------------------------------------
const SPEC_BASELINE_USER_FKS = [
  "Application.createdById=RESTRICT",
  "Application.ownerId=RESTRICT",
  "Attachment.ownerId=RESTRICT",
  "Attachment.uploaderId=RESTRICT",
  "AuditLog.actorId=RESTRICT",
  "AuditLog.targetId=SET NULL",
  "Session.userId=CASCADE",
  "UserFuelConsumptionVersion.userId=RESTRICT",
];

/** 視為「會阻擋刪除」之 `delete_rule`（AC-14(a) 逐字）。 */
const BLOCKING_DELETE_RULES = new Set(["RESTRICT", "NO ACTION"]);

interface UserFkRow {
  constraint_name: string;
  referencing_table: string;
  referencing_column: string;
  delete_rule: string;
}

/**
 * 列舉本 worker schema 內「指向 `User`」之全部外鍵。
 *
 * `constraint_column_usage` 給的是**被引用端**（`User.id`）之表／欄，
 * `key_column_usage` 給的是**引用端**（如 `AuditLog.actorId`）之表／欄；兩者
 * 皆以 `constraint_schema` 侷限於 `current_schema()`，避免跨 worker schema 聚合。
 */
const USER_FK_SQL = `
  SELECT
    rc.constraint_name AS constraint_name,
    kcu.table_name     AS referencing_table,
    kcu.column_name    AS referencing_column,
    rc.delete_rule     AS delete_rule
  FROM information_schema.referential_constraints rc
  JOIN information_schema.key_column_usage kcu
    ON  kcu.constraint_name   = rc.constraint_name
    AND kcu.constraint_schema = rc.constraint_schema
  JOIN information_schema.constraint_column_usage ccu
    ON  ccu.constraint_name   = rc.unique_constraint_name
    AND ccu.constraint_schema = rc.unique_constraint_schema
  WHERE rc.constraint_schema = current_schema()
    AND ccu.table_name = 'User'
  ORDER BY kcu.table_name, kcu.column_name
`;

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

interface AuditLogListItemDto {
  id: string;
  action: string;
  createdAt: string;
  actorDisplayName: string;
  targetLabel: string;
  targetDisplayName: string | null;
  changes: Array<{ field: string; before: string | null; after: string | null }>;
}

interface CreatedUser {
  id: string;
  loginName: string;
}

describeWithDb("PHASE-010-T5 — AD-US-04 有歷史拒刪回歸 ＋ FK 守門完整性", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let adminId: string;
  let adminLogin: string;
  let adminCookie: string;

  /** 附件／代建申請之對造（本身不是刪除對象）。 */
  let peerId: string;

  // ── AC-12 五類歷史之對象 ────────────────────────────────────────────────
  let uDraft: CreatedUser;
  let uCompleted: CreatedUser;
  let uVoided: CreatedUser;
  let uReported: CreatedUser;
  let uFuel: CreatedUser;

  // ── AC-14(b) 三條缺口路徑之對象（附件一條拆兩欄逐一涵蓋）────────────────
  let uActor: CreatedUser;
  let uUploader: CreatedUser;
  let uAttachmentOwner: CreatedUser;
  let uCreator: CreatedUser;

  // ── AC-13 零歷史可刪之對象（經真實 `POST /admin/users` 建立）────────────
  let uDeletable: CreatedUser;
  /** 刪除前之 `loginName` 快照（AC-13(b) 之 `targetLabel` 比對對象）。 */
  let deletableLoginSnapshot = "";
  /** `DELETE` 前後之 `AuditLog` 全表列數差（AC-13(b)：恰 1）。 */
  let deletableAuditDelta = -1;
  /** `DELETE` 之回應（AC-13(a)）。 */
  let deletableStatus = -1;
  let deletableBody: unknown;

  // ── AC-14(d) P2003 兜底之對象 ──────────────────────────────────────────
  let uFkVictim: CreatedUser;
  let uFkControl: CreatedUser;

  /** DB 實際列舉出之外鍵（`beforeAll` 取得一次，多則 `it` 共用）。 */
  let userFkRows: UserFkRow[] = [];

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
    // 刪除順序即外鍵相依順序（子 → 父）：`AuditLog.actorId`／`Application.ownerId`
    // ／`Attachment.*`／`UserFuelConsumptionVersion.userId` 皆為 RESTRICT，
    // 必須先於 `User` 清掉——這正是本檔所驗證之守門在測試側的鏡像。
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { targetId: { in: ids } } });
    const apps = await prisma.application.findMany({
      where: { OR: [{ ownerId: { in: ids } }, { createdById: { in: ids } }] },
      select: { id: true },
    });
    const appIds = apps.map((a) => a.id);
    if (appIds.length > 0) {
      // `Report.applicationId` 為 RESTRICT：報表列必須先於申請刪除。
      await prisma.report.deleteMany({ where: { applicationId: { in: appIds } } });
      await prisma.application.updateMany({
        where: { id: { in: appIds } },
        data: { supersedesId: null },
      });
      await prisma.application.deleteMany({ where: { id: { in: appIds } } });
    }
    await prisma.attachment.deleteMany({ where: { uploaderId: { in: ids } } });
    await prisma.attachment.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.userFuelConsumptionVersion.deleteMany({ where: { userId: { in: ids } } });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  /** 引導身分：直寫（非被驗證之狀態；沿 T2／T3 `bootstrapUser` 慣例）。 */
  async function bootstrapUser(
    suffix: string,
    role: "USER" | "ADMIN" = "USER"
  ): Promise<CreatedUser> {
    const loginName = `${LOGIN_PREFIX}${suffix}${RUN_ID}`;
    const user = await prisma.user.create({
      data: {
        loginName,
        displayName: `P10T5 ${suffix}`,
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
    method: "POST" | "DELETE",
    url: string,
    cookie: string,
    payload: Record<string, unknown> | undefined,
    expectedStatus: number
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

  /**
   * 直寫一筆已完成差旅申請（**前置狀態**，非被驗證之狀態——見檔頭射程說明）。
   * 欄位形狀沿 `phase10-audit-completeness.test.ts` 之 `createCompletedTravel`。
   */
  async function createCompletedTravel(ownerId: string, suffix: string): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date(`${PARAM_YEAR}-05-12T00:00:00.000Z`),
        totalAmount: 1500,
        completedAt: new Date(`${PARAM_YEAR}-05-12T08:00:00.000Z`),
        travel: {
          create: {
            tripDate: new Date(`${PARAM_YEAR}-05-12T00:00:00.000Z`),
            purpose: `合成出差目的：完成快照前置-${suffix}`,
            fuelUnitPrice: "2.3456",
            etcUnitPrice: "1.2345",
            fuelParameterVersionId: `p10t5-fpv-${suffix}`,
            etcParameterVersionId: `p10t5-epv-${suffix}`,
            snapshotTotalKm: "240.75",
            snapshotRawAmount: "1500.0000",
            calculatedAt: new Date(`${PARAM_YEAR}-05-12T08:00:00.000Z`),
            snapshotFuelType: "GASOLINE_95",
            snapshotFuelPricePerLiter: "31.5000",
            snapshotFuelConsumption: "12.5000",
            fuelPriceVersionId: `p10t5-fpricev-${suffix}`,
            fuelConsumptionVersionId: `p10t5-fcv-${suffix}`,
            segments: {
              create: [
                {
                  sortOrder: 0,
                  origin: "合成起點甲",
                  destination: "合成迄點乙",
                  totalKm: "240.75",
                  highwayKm: "180.00",
                  snapshotFuelAmount: "1160.0000",
                  snapshotEtcAmount: "340.0000",
                  snapshotRawAmount: "1500.0000",
                  snapshotAmount: 1500,
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
   * 「零刪除」之比對基準（AC-12(a) 逐字「該使用者列與其資料逐欄不變」）。
   *
   * 涵蓋使用者列本身 ＋ 六條 RESTRICT 外鍵所指之全部列 ＋ 其申請之報表列。
   * 刻意整份序列化比對，而非只看「使用者還在」：後者對「連帶資料被刪掉一半」
   * 完全沒有鑑別力。
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

  /** 對某使用者送出 `DELETE /admin/users/:id`（以本檔主管理員身分）。 */
  async function deleteUser(
    userId: string,
    cookie: string = adminCookie
  ): Promise<{ statusCode: number; body: string; json: () => unknown }> {
    const resp = await app.inject({
      method: "DELETE",
      url: `/admin/users/${userId}`,
      headers: { cookie },
    });
    return { statusCode: resp.statusCode, body: resp.body, json: () => resp.json() };
  }

  // -------------------------------------------------------------------------

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    await cleanupSyntheticData();

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "silent" });
    await app.ready();

    const admin = await bootstrapUser("admin", "ADMIN");
    adminId = admin.id;
    adminLogin = admin.loginName;
    adminCookie = await login(adminLogin);

    const peer = await bootstrapUser("peer");
    peerId = peer.id;

    // ── AC-12① `DRAFT` 申請（真實端點：本人自建草稿）────────────────────
    uDraft = await bootstrapUser("draft");
    const draftCookie = await login(uDraft.loginName);
    await callOk(
      "POST",
      "/applications/travel",
      draftCookie,
      { tripDate: `${PARAM_YEAR}-03-05`, purpose: "合成出差目的：草稿類拒刪回歸" },
      201
    );

    // ── AC-12② `COMPLETED` 申請（前置狀態直寫）──────────────────────────
    uCompleted = await bootstrapUser("done");
    await createCompletedTravel(uCompleted.id, "done");

    // ── AC-12③ `VOIDED` 申請（**真實作廢端點**，AC-12(c)）────────────────
    uVoided = await bootstrapUser("void");
    const toVoidId = await createCompletedTravel(uVoided.id, "void");
    await callOk(
      "POST",
      `/applications/${toVoidId}/void`,
      adminCookie,
      { reason: "合成作廢原因：作廢類拒刪回歸" },
      200
    );

    // ── AC-12④ 已產生正式報表之申請（`Report` 列為前置狀態直寫）──────────
    uReported = await bootstrapUser("rpt");
    const reportedAppId = await createCompletedTravel(uReported.id, "rpt");
    await prisma.report.create({
      data: {
        applicationId: reportedAppId,
        reportNumber: `TRV-${PARAM_YEAR}05-${RUN_ID.slice(0, 6)}`,
        numberPrefix: "TRV",
        numberPeriod: `${PARAM_YEAR}05`,
        sequence: 1,
        storageKey: `rpt/p10t5-${RUN_ID}/pdf`,
        fileName: "合成報表.pdf",
        byteSize: 2048,
        contentHash: "0".repeat(64),
        generatedById: adminId,
      },
    });

    // ── AC-12⑤ `UserFuelConsumptionVersion`（真實端點：管理員設定油耗）───
    uFuel = await bootstrapUser("fuel");
    await callOk(
      "POST",
      `/users/${uFuel.id}/fuel-consumption`,
      adminCookie,
      {
        fuelType: "GASOLINE_95",
        kmPerLiter: "12.0000",
        effectiveFrom: `${PARAM_YEAR}-02-01`,
        basisNote: "合成依據備註：油耗版本類拒刪回歸",
      },
      201
    );

    // ── AC-14(b)① 曾執行被稽核操作之管理員（`AuditLog.actorId`）──────────
    // 真實端點：以 uActor 之身分建立一個帳號 → 該次操作之稽核列 `actorId`
    // 即 uActor。此使用者**只有**這一條 RESTRICT 路徑（他自己不是任何申請的
    // owner／createdById、無附件、無油耗版本），故本格確實只驗 actorId。
    uActor = await bootstrapUser("actor", "ADMIN");
    const actorCookie = await login(uActor.loginName);
    await callOk(
      "POST",
      "/admin/users",
      actorCookie,
      {
        loginName: `${LOGIN_PREFIX}byactor${RUN_ID}`,
        displayName: "P10T5 byactor",
        temporaryPassword: TEMP_PASSWORD,
      },
      201
    );

    // ── AC-14(b)② 上傳過附件但無任何申請之使用者 ──────────────────────────
    // 兩欄逐一涵蓋：`uploaderId`（代他人上傳者）與 `ownerId`（被代上傳者）。
    uUploader = await bootstrapUser("upl");
    uAttachmentOwner = await bootstrapUser("attown");
    await prisma.attachment.create({
      data: {
        status: "TEMP",
        storageKey: `att/p10t5-${RUN_ID}-uploader`,
        mimeType: "image/jpeg",
        byteSize: 128,
        originalFilename: "合成附件-uploader.jpg",
        uploaderId: uUploader.id,
        ownerId: peerId,
      },
    });
    await prisma.attachment.create({
      data: {
        status: "TEMP",
        storageKey: `att/p10t5-${RUN_ID}-owner`,
        mimeType: "image/jpeg",
        byteSize: 128,
        originalFilename: "合成附件-owner.jpg",
        uploaderId: adminId,
        ownerId: uAttachmentOwner.id,
      },
    });

    // ── AC-14(b)③ 代他人建過草稿、自己零申請之管理員（`Application.createdById`）
    // 直寫（而非走代操作端點）之理由見檔頭「刻意的直寫」：走端點會同時產生
    // `AuditLog.actorId` 列，使本格即使 createdById 未守門也會通過。
    uCreator = await bootstrapUser("creator", "ADMIN");
    await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId: peerId,
        createdById: uCreator.id,
        primaryDate: new Date(`${PARAM_YEAR}-04-01T00:00:00.000Z`),
        travel: {
          create: {
            tripDate: new Date(`${PARAM_YEAR}-04-01T00:00:00.000Z`),
            purpose: "合成出差目的：代建草稿（createdById 路徑）",
          },
        },
      },
    });

    // ── AC-14(d) P2003 兜底之對象 ─────────────────────────────────────────
    // uFkVictim：只有一條附件（uploader＋owner 皆自己）——守門被 stub 打開時，
    // `prisma.user.delete` 必然撞 `Attachment` 之 RESTRICT 外鍵。
    uFkVictim = await bootstrapUser("fkvic");
    await prisma.attachment.create({
      data: {
        status: "TEMP",
        storageKey: `att/p10t5-${RUN_ID}-victim`,
        mimeType: "image/png",
        byteSize: 64,
        originalFilename: "合成附件-victim.png",
        uploaderId: uFkVictim.id,
        ownerId: uFkVictim.id,
      },
    });
    // uFkControl：零任何 RESTRICT 列（防恆真對照——兜底不得無條件回 409）。
    uFkControl = await bootstrapUser("fkctl");

    // ── AC-13 零歷史可刪（**真實** `POST /admin/users` 建立 → 該帳號在
    // `AuditLog` 中只當過 `targetId`（`SET NULL`），故仍可刪；FW-4 兩語意分野
    // 之活體示範）────────────────────────────────────────────────────────
    const createdBody = await callOk(
      "POST",
      "/admin/users",
      adminCookie,
      {
        loginName: `${LOGIN_PREFIX}del${RUN_ID}`,
        displayName: "P10T5 deletable",
        temporaryPassword: TEMP_PASSWORD,
      },
      201
    );
    const createdUser = (createdBody as { user: { id: string; loginName: string } }).user;
    uDeletable = { id: createdUser.id, loginName: createdUser.loginName };
    deletableLoginSnapshot = createdUser.loginName;

    // AC-13 之真實 `DELETE`（被驗證之狀態——必經真實端點）。前後量測全表
    // `AuditLog` 列數差，故「恰一條」是封閉斷言而非「查得到某條」。
    const auditBefore = await prisma.auditLog.count();
    const deleteResp = await deleteUser(uDeletable.id);
    deletableStatus = deleteResp.statusCode;
    deletableBody = deleteResp.statusCode === 200 ? deleteResp.json() : deleteResp.body;
    deletableAuditDelta = (await prisma.auditLog.count()) - auditBefore;

    // ── AC-14(a) 之 DB 實況（一次查詢，多則 `it` 共用）───────────────────
    userFkRows = await prisma.$queryRawUnsafe<UserFkRow[]>(USER_FK_SQL);
  }, 120_000);

  afterAll(async () => {
    if (!DB_URL) return;
    await app?.close();
    await prisma?.$disconnect();
  });

  // =========================================================================
  // AC-14(a) — 六條 RESTRICT FK 之守門完整性（機械相符斷言）
  // =========================================================================

  describe("AC-14: 六條 RESTRICT FK 之守門完整性；三條缺口路徑 409（非 500）", () => {
    it("(a) spike：information_schema 於 worker schema 下列舉出指向 User 之全部 FK，逐條與 Spec §2 基線相符", () => {
      const actual = userFkRows
        .map((r) => `${r.referencing_table}.${r.referencing_column}=${r.delete_rule}`)
        .sort();
      expect(actual).toEqual([...SPEC_BASELINE_USER_FKS].sort());
      // 8 條之中恰 6 條會阻擋刪除——這個數字是 Spec §2 AC-14 實查基線的核心。
      expect(userFkRows.filter((r) => BLOCKING_DELETE_RULES.has(r.delete_rule))).toHaveLength(6);
    });

    it("(a) RESTRICT／NO ACTION 之引用表集合恰等於 userHasHistory 所查之表集合", () => {
      const dbTables = [
        ...new Set(
          userFkRows
            .filter((r) => BLOCKING_DELETE_RULES.has(r.delete_rule))
            .map((r) => r.referencing_table)
        ),
      ].sort();
      const guardTables = [...new Set(USER_RESTRICT_FK_GUARDS.map((g) => g.table))].sort();
      expect(guardTables).toEqual(dbTables);
    });

    it("(a) 欄位級：RESTRICT／NO ACTION 之「表.欄」集合恰等於守門宣告之「表.欄」集合", () => {
      // 表集合相符仍可能漏欄（例如日後在已守門的 Application 上新增一條指向
      // User 的 RESTRICT 欄位），故欄位級比對是 AC-14(a)「新增此類 FK 而未同步
      // 守門者必紅」之實質保證。
      const dbColumns = userFkRows
        .filter((r) => BLOCKING_DELETE_RULES.has(r.delete_rule))
        .map((r) => `${r.referencing_table}.${r.referencing_column}`)
        .sort();
      const guardColumns = USER_RESTRICT_FK_GUARDS.map((g) => `${g.table}.${g.column}`).sort();
      expect(guardColumns).toEqual(dbColumns);
    });

    it("(a) mutant①：守門清單移除任一項 → 相符斷言必紅（逐項驗，非抽樣）", () => {
      const dbColumns = userFkRows
        .filter((r) => BLOCKING_DELETE_RULES.has(r.delete_rule))
        .map((r) => `${r.referencing_table}.${r.referencing_column}`)
        .sort();
      expect(USER_RESTRICT_FK_GUARDS.length).toBeGreaterThan(0);
      for (const dropped of USER_RESTRICT_FK_GUARDS) {
        const mutated = USER_RESTRICT_FK_GUARDS.filter((g) => g !== dropped)
          .map((g) => `${g.table}.${g.column}`)
          .sort();
        expect(mutated).not.toEqual(dbColumns);
      }
    });

    it("(a) mutant②：DB 新增一條未守門之 RESTRICT FK → 相符斷言必紅", () => {
      const mutatedDbColumns = [
        ...userFkRows
          .filter((r) => BLOCKING_DELETE_RULES.has(r.delete_rule))
          .map((r) => `${r.referencing_table}.${r.referencing_column}`),
        "Application.approvedById",
      ].sort();
      const guardColumns = USER_RESTRICT_FK_GUARDS.map((g) => `${g.table}.${g.column}`).sort();
      expect(guardColumns).not.toEqual(mutatedDbColumns);
    });

    it("(a)／FW-4：AuditLog.targetId 為 SET NULL 且刻意不入守門清單（被操作過的人可刪，操作過的人不可刪）", () => {
      const targetIdRow = userFkRows.find(
        (r) => r.referencing_table === "AuditLog" && r.referencing_column === "targetId"
      );
      expect(targetIdRow?.delete_rule).toBe("SET NULL");
      expect(
        USER_RESTRICT_FK_GUARDS.some((g) => g.table === "AuditLog" && g.column === "targetId")
      ).toBe(false);
      // 對照組：同表之 actorId 為 RESTRICT 且**必須**在守門清單內。
      const actorIdRow = userFkRows.find(
        (r) => r.referencing_table === "AuditLog" && r.referencing_column === "actorId"
      );
      expect(actorIdRow?.delete_rule).toBe("RESTRICT");
      expect(
        USER_RESTRICT_FK_GUARDS.some((g) => g.table === "AuditLog" && g.column === "actorId")
      ).toBe(true);
      // Session.userId 為 CASCADE，同樣不入清單（刪得掉，不是歷史）。
      const sessionRow = userFkRows.find((r) => r.referencing_table === "Session");
      expect(sessionRow?.delete_rule).toBe("CASCADE");
      expect(USER_RESTRICT_FK_GUARDS.some((g) => g.table === "Session")).toBe(false);
    });

    it("(a)／SF-1 守門判定邏輯之鑑別力：六條 guard 逐條對「僅走該路徑」之使用者計得 > 0、對零歷史者 0，且 userHasHistory 六人皆 true／零歷史者 false", async () => {
      // 為什麼需要這一格（T5 即審 SF-1）：AC-14(a) 只比對「宣告」與 DB 是否相
      // 符；AC-14(b)／(d) 只看端點回應——而端點回應在 P2003 兜底之下對「守門
      // 判定寫錯」**完全不敏感**：把 `counts.some(...)` 誤寫為 `counts.every(
      // ...)`（守門退化成 D5=(b)，全靠兜底）或某條 guard 的 lambda 誤查同表
      // 別欄，兩者都不會改變任何一個 409／200。本格直接對判定邏輯本身取證，
      // 是**區辨 D5=(c)（守門正確＋兜底縱深）與 D5=(b)（只剩兜底）的唯一落點**。
      //
      // 每一格之使用者刻意選為「**只**走該欄」者（見各列註解之對照關係），使
      // 「lambda 誤查同表另一欄」必得 0 而翻紅。
      function guardFor(table: string, column: string) {
        const guard = USER_RESTRICT_FK_GUARDS.find((g) => g.table === table && g.column === column);
        if (!guard) throw new Error(`守門清單缺少 ${table}.${column}`);
        return guard;
      }

      const matrix = [
        // peer 是 uCreator 代建草稿之 owner，且**不是**任何申請之 createdById
        // → lambda 若誤查 createdById 即得 0。
        { table: "Application", column: "ownerId", userId: peerId },
        // uCreator 只當 createdById、零 ownerId（B-16 格另有獨立斷言）。
        { table: "Application", column: "createdById", userId: uCreator.id },
        // uUploader 只當 uploaderId（該附件之 ownerId 為 peer）。
        { table: "Attachment", column: "uploaderId", userId: uUploader.id },
        // uAttachmentOwner 只當 ownerId（該附件之 uploaderId 為 admin）。
        { table: "Attachment", column: "ownerId", userId: uAttachmentOwner.id },
        // uActor 只當 actorId（他建立的那個帳號才是 targetId）
        // → lambda 若誤查 targetId 即得 0。
        { table: "AuditLog", column: "actorId", userId: uActor.id },
        // 該表僅此一條指向 User 之外鍵，無同表誤查對照。
        { table: "UserFuelConsumptionVersion", column: "userId", userId: uFuel.id },
      ];
      // 矩陣與守門清單等長——日後新增 guard 而未補對應格即紅。
      expect(matrix).toHaveLength(USER_RESTRICT_FK_GUARDS.length);

      for (const row of matrix) {
        const guard = guardFor(row.table, row.column);
        await expect(
          guard.count(prisma, row.userId),
          `${row.table}.${row.column} 之 guard 對僅走該路徑之使用者應計得 > 0`
        ).resolves.toBeGreaterThan(0);
        // 同一條 guard 對零歷史使用者必為 0——否則上面的 `> 0` 是恆真。
        await expect(
          guard.count(prisma, uFkControl.id),
          `${row.table}.${row.column} 之 guard 對零歷史使用者應計得 0`
        ).resolves.toBe(0);
      }

      // 判定層：六人**各只有一條**路徑，故 `some` → `every` 之退化在此必然
      // 全數翻假（P2003 兜底救不了這條斷言，因為這裡根本沒有經過端點）。
      for (const row of matrix) {
        await expect(userHasHistory(prisma, row.userId)).resolves.toBe(true);
      }
      await expect(userHasHistory(prisma, uFkControl.id)).resolves.toBe(false);
    });

    // -----------------------------------------------------------------------
    // AC-14(b) — 三條缺口路徑（修復前實得 500，見 Task Handoff 之紅燈物證）
    // -----------------------------------------------------------------------

    it("(b)／B-14 曾執行被稽核操作之管理員（AuditLog.actorId）→ 409（非 500）＋ 零刪除", async () => {
      const before = await snapshotUserWorld(uActor.id);
      const resp = await deleteUser(uActor.id);
      expect(resp.statusCode).toBe(409);
      const body = resp.json() as ErrorBody;
      expect(body.error.code).toBe("CONFLICT");
      expect(body.error.message).toBe(HAS_HISTORY_MESSAGE);
      expect(await snapshotUserWorld(uActor.id)).toBe(before);
    });

    it("(b)／B-15 上傳過附件之使用者（Attachment.uploaderId）→ 409（非 500）＋ 零刪除", async () => {
      const before = await snapshotUserWorld(uUploader.id);
      const resp = await deleteUser(uUploader.id);
      expect(resp.statusCode).toBe(409);
      const body = resp.json() as ErrorBody;
      expect(body.error.code).toBe("CONFLICT");
      expect(body.error.message).toBe(HAS_HISTORY_MESSAGE);
      expect(await snapshotUserWorld(uUploader.id)).toBe(before);
    });

    it("(b)／B-15 被代上傳附件之使用者（Attachment.ownerId）→ 409（非 500）＋ 零刪除", async () => {
      const before = await snapshotUserWorld(uAttachmentOwner.id);
      const resp = await deleteUser(uAttachmentOwner.id);
      expect(resp.statusCode).toBe(409);
      const body = resp.json() as ErrorBody;
      expect(body.error.code).toBe("CONFLICT");
      expect(body.error.message).toBe(HAS_HISTORY_MESSAGE);
      expect(await snapshotUserWorld(uAttachmentOwner.id)).toBe(before);
    });

    it("(b)／B-16 代他人建過草稿、自己零申請之管理員（Application.createdById）→ 409（非 500）＋ 零刪除", async () => {
      // 前置自證：該管理員確實**不是**任何申請的 owner，故此格若綠，只可能
      // 來自 createdById 這條路徑（ownerId 路徑在此格恆為 0 列）。
      await expect(prisma.application.count({ where: { ownerId: uCreator.id } })).resolves.toBe(0);
      await expect(prisma.auditLog.count({ where: { actorId: uCreator.id } })).resolves.toBe(0);
      await expect(prisma.application.count({ where: { createdById: uCreator.id } })).resolves.toBe(
        1
      );

      const before = await snapshotUserWorld(uCreator.id);
      const resp = await deleteUser(uCreator.id);
      expect(resp.statusCode).toBe(409);
      const body = resp.json() as ErrorBody;
      expect(body.error.code).toBe("CONFLICT");
      expect(body.error.message).toBe(HAS_HISTORY_MESSAGE);
      expect(await snapshotUserWorld(uCreator.id)).toBe(before);
    });
  });

  // =========================================================================
  // AC-12 — 五類歷史逐一 409 拒刪且零刪除
  // =========================================================================

  describe("AC-12: 五類歷史逐一 409 拒刪且零刪除（VOIDED 經真實作廢端點構造）", () => {
    /** 五類之逐格矩陣；`assertShape` 於送出 DELETE 前先證明該類資料確實在場。 */
    function cases(): Array<{
      label: string;
      user: () => CreatedUser;
      assertShape: () => Promise<void>;
    }> {
      return [
        {
          label: "①DRAFT 申請",
          user: () => uDraft,
          assertShape: async () => {
            const apps = await prisma.application.findMany({ where: { ownerId: uDraft.id } });
            expect(apps).toHaveLength(1);
            expect(apps[0]?.status).toBe("DRAFT");
          },
        },
        {
          label: "②COMPLETED 申請",
          user: () => uCompleted,
          assertShape: async () => {
            const apps = await prisma.application.findMany({ where: { ownerId: uCompleted.id } });
            expect(apps).toHaveLength(1);
            expect(apps[0]?.status).toBe("COMPLETED");
          },
        },
        {
          label: "③VOIDED 申請（真實作廢端點）",
          user: () => uVoided,
          assertShape: async () => {
            const apps = await prisma.application.findMany({ where: { ownerId: uVoided.id } });
            expect(apps).toHaveLength(1);
            // AC-12(c)：狀態與作廢三欄由**真實端點**寫入（非 raw SQL 直寫）。
            expect(apps[0]?.status).toBe("VOIDED");
            expect(apps[0]?.voidReason).toBe("合成作廢原因：作廢類拒刪回歸");
            expect(apps[0]?.voidedAt).not.toBeNull();
            expect(apps[0]?.voidedById).toBe(adminId);
          },
        },
        {
          label: "④已產生正式報表之申請",
          user: () => uReported,
          assertShape: async () => {
            const apps = await prisma.application.findMany({ where: { ownerId: uReported.id } });
            expect(apps).toHaveLength(1);
            const reports = await prisma.report.findMany({
              where: { applicationId: apps[0]?.id ?? "" },
            });
            expect(reports).toHaveLength(1);
          },
        },
        {
          label: "⑤UserFuelConsumptionVersion",
          user: () => uFuel,
          assertShape: async () => {
            const versions = await prisma.userFuelConsumptionVersion.findMany({
              where: { userId: uFuel.id },
            });
            expect(versions).toHaveLength(1);
            // 防誤讀：此使用者**零申請**，故本格確實驗的是油耗版本那條路徑。
            await expect(prisma.application.count({ where: { ownerId: uFuel.id } })).resolves.toBe(
              0
            );
          },
        },
      ];
    }

    for (const testCase of cases()) {
      it(`(a)(b) ${testCase.label} → 409 CONFLICT ＋ 既有停用文案 ＋ 零刪除`, async () => {
        await testCase.assertShape();
        const target = testCase.user();
        const before = await snapshotUserWorld(target.id);

        const resp = await deleteUser(target.id);

        expect(resp.statusCode).toBe(409);
        const body = resp.json() as ErrorBody;
        expect(body.error.code).toBe("CONFLICT");
        // (b) 「提供停用選項」＝既有文案逐字承載（不新增使用者可見行為）。
        expect(body.error.message).toBe(HAS_HISTORY_MESSAGE);

        // 零刪除：使用者列與其全部關聯資料逐欄不變。
        expect(await snapshotUserWorld(target.id)).toBe(before);
        await expect(prisma.user.count({ where: { id: target.id } })).resolves.toBe(1);
      });
    }

    it("(a) 拒刪時零稽核列產生（拒絕不是被稽核事件）", async () => {
      const before = await prisma.auditLog.count();
      const resp = await deleteUser(uCompleted.id);
      expect(resp.statusCode).toBe(409);
      expect(await prisma.auditLog.count()).toBe(before);
    });
  });

  // =========================================================================
  // AC-13 — 零歷史可刪 ＋ USER_DELETED 稽核列
  // =========================================================================

  describe("AC-13: 零歷史可刪 ＋ USER_DELETED 稽核列 ＋ targetDisplayName null", () => {
    it("(a) 200 { ok: true } ＋ 該使用者列確實消失", async () => {
      expect(deletableStatus).toBe(200);
      expect(deletableBody).toEqual({ ok: true });
      await expect(prisma.user.count({ where: { id: uDeletable.id } })).resolves.toBe(0);
      await expect(
        prisma.user.count({ where: { loginName: deletableLoginSnapshot } })
      ).resolves.toBe(0);
    });

    it("(b) 恰一條 USER_DELETED：targetId 為 null、targetLabel 為刪除前 loginName 快照", async () => {
      // 「恰一條」由兩道獨立斷言承擔：全表列數差恰 1（封閉，任何額外寫入必紅）
      // ＋ 該 targetLabel 之列恰 1。
      expect(deletableAuditDelta).toBe(1);
      const rows = await prisma.auditLog.findMany({
        where: { action: "USER_DELETED", targetLabel: deletableLoginSnapshot },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.targetId).toBeNull();
      expect(rows[0]?.actorId).toBe(adminId);
    });

    it("(c) 該列可經 GET /admin/audit-logs 取回，targetDisplayName 為 null", async () => {
      const resp = await app.inject({
        method: "GET",
        url: "/admin/audit-logs?action=USER_DELETED&pageSize=100",
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as { items: AuditLogListItemDto[]; total: number };
      const item = body.items.filter((i) => i.targetLabel === deletableLoginSnapshot);
      expect(item).toHaveLength(1);
      expect(item[0]?.action).toBe("USER_DELETED");
      expect(item[0]?.targetDisplayName).toBeNull();
    });
  });

  // =========================================================================
  // AC-14(d) — P2003 兜底（守門被打開時之縱深防禦）
  // =========================================================================

  describe("AC-14(d): DELETE 端點之 P2003 兜底 — 守門停用時仍為 409（非 500）", () => {
    let stubApp: FastifyInstance;

    beforeAll(async () => {
      if (!DB_URL) return;
      const Fastify = (await import("fastify")).default;
      const fastifyCookie = (await import("@fastify/cookie")).default;
      const { registerErrorHandlers } = await import("../../src/platform/error-handler.js");
      const { authPlugin } = await import("../../src/auth/routes.js");

      stubApp = Fastify({ logger: false });
      registerErrorHandlers(stubApp);
      await stubApp.register(fastifyCookie);
      await stubApp.register(authPlugin, { prisma });
      // **刻意打開守門**：`hasHistory` 恆 false，使 `prisma.user.delete` 真的
      // 撞上 RESTRICT 外鍵。此時唯一能把 P2003 變成 409 的就是端點層的兜底
      // catch——沒有它即落 `error-handler.ts` 未預期例外分支 → 500。
      await stubApp.register(adminPlugin, { prisma, hasHistory: async () => false });
      await stubApp.ready();
    });

    afterAll(async () => {
      await stubApp?.close();
    });

    it("守門 stub 恆 false ＋ 真實 RESTRICT 列 → 409 CONFLICT ＋ 同一文案，使用者仍在", async () => {
      const before = await snapshotUserWorld(uFkVictim.id);
      const resp = await stubApp.inject({
        method: "DELETE",
        url: `/admin/users/${uFkVictim.id}`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(409);
      const body = resp.json() as ErrorBody;
      expect(body.error.code).toBe("CONFLICT");
      expect(body.error.message).toBe(HAS_HISTORY_MESSAGE);
      expect(await snapshotUserWorld(uFkVictim.id)).toBe(before);
    });

    it("防恆真：守門 stub 恆 false ＋ 零 RESTRICT 列 → 200（兜底不是無條件 409）", async () => {
      const resp = await stubApp.inject({
        method: "DELETE",
        url: `/admin/users/${uFkControl.id}`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(200);
      expect(resp.json()).toEqual({ ok: true });
      await expect(prisma.user.count({ where: { id: uFkControl.id } })).resolves.toBe(0);
    });

    it("mutant：兜底之錯誤碼辨識——P2003 為真；P2002／P2025／非 Prisma 例外皆為偽", () => {
      // 若把判別式寫成「只要是物件就當 FK 違反」，下面四則必有一則翻紅。
      expect(isPrismaForeignKeyConstraintError({ code: "P2003" })).toBe(true);
      expect(isPrismaForeignKeyConstraintError({ code: "P2002" })).toBe(false);
      expect(isPrismaForeignKeyConstraintError({ code: "P2025" })).toBe(false);
      expect(isPrismaForeignKeyConstraintError(new Error("boom"))).toBe(false);
      expect(isPrismaForeignKeyConstraintError(null)).toBe(false);
      expect(isPrismaForeignKeyConstraintError("P2003")).toBe(false);
    });
  });

  // =========================================================================
  // B-17／B-18 — 既有行為零變更（判定順序守門）
  // =========================================================================

  describe("B-17／B-18: 既有行為零變更", () => {
    it("B-17 刪除自己 → 409「不可對自己執行此操作」（自我守門先於歷史守門）", async () => {
      // 本檔之管理員此時已有大量稽核列（歷史守門也會回 409），故這一格真正
      // 驗的是**文案**：自我守門若被移到歷史守門之後，訊息就會變成
      // 「此帳號已有資料…」而非「不可對自己執行此操作」。
      const resp = await deleteUser(adminId);
      expect(resp.statusCode).toBe(409);
      const body = resp.json() as ErrorBody;
      expect(body.error.code).toBe("CONFLICT");
      expect(body.error.message).toBe(SELF_OPERATION_MESSAGE);
      await expect(prisma.user.count({ where: { id: adminId } })).resolves.toBe(1);
    });

    it("B-18 刪除不存在之 id → 404 NOT_FOUND", async () => {
      const resp = await deleteUser(`p10t5-nonexistent-${RUN_ID}`);
      expect(resp.statusCode).toBe(404);
      const body = resp.json() as ErrorBody;
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });
});
