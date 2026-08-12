/**
 * Integration tests for PHASE-009-T3:
 *   作廢 service — 原因驗證 ＋ 交易 ＋ 四欄寫入 ＋ 三型 DTO 之 `void` 區塊。
 *
 * Spec `docs/specs/PHASE-009.md`：
 *   AC-03（§2）：作廢原因 gate table（12 列：缺鍵／null／空字串／半形空白／
 *     全形空白／Tab／換行／1 字元／500 字元／501 字元／前後空白 trim／XSS
 *     payload）；400 時零寫入。
 *   AC-04：成功時單一交易寫入 status/voidReason/voidedAt/voidedById 四欄；
 *     totalAmount／completedAt／三型快照欄逐欄逐位元組不變。
 *   AC-06：已作廢再作廢 → 409 CONFLICT + details.status="VOIDED"（非冪等）。
 *   AC-07：草稿作廢 → 409 CONFLICT + details.status="DRAFT"。
 *   AC-08：作廢後既有 `assertApplicationMutable` 守門之真實回歸——三型 PUT
 *     端點、DELETE 端點對已作廢申請一律 403 且零寫入（本檔涵蓋範圍見下方
 *     「AC-08 範圍說明」）。
 *   §3.1 步驟 7a（B-08）：兩個併發作廢請求恰一成功、另一 409。
 *   §7.2：三型詳情 DTO 新增 `void: VoidInfoDto | null` 鍵——未作廢恆
 *     `null`，作廢後含 reason／voidedAt／voidedByDisplayName。
 *
 * ── T3 Files Allowed 範圍說明（Packet 逐字）──────────────────────────────
 * `routes.ts` 不在本 Task 白名單內（端點／授權矩陣／稽核 hook 歸 T4）——
 * 因此本檔直接呼叫 `voidApplication`（`application-void.ts`，本 Task 新增）
 * 而非透過尚不存在的 `POST /applications/:id/void` 端點。既有 HTTP 端點
 * （PUT 三型草稿、DELETE、登入）在本 Phase 之前即已存在，本檔僅呼叫、不修改
 * ——用來驗證「VOIDED 首度真實可達後，既有守門是否仍正確生效」（AC-08）。
 *
 * ── AC-08 範圍說明（發現一則跨檔案缺口，記入 Handoff／spawn_task，非本
 *    Task Files Allowed 可修復）──────────────────────────────────────────
 * `attachment/lifecycle-service.ts` 的 `deriveContainerState` 對
 * `refType=TRIP_SEGMENT`/`MAINTENANCE`/`DEPRECIATION` 三分支皆以
 * `application.status === "COMPLETED" ? "completed" : "draft"` 判定容器是
 * 否鎖定——`VOIDED`（本 Phase 首度真實可達）會被誤判為 `"draft"`，使
 * `DELETE /attachments/:id` 對已作廢申請之附件仍會成功刪除（應為 403）。
 * 該檔不在本 Task（T3）、亦不在整份 Task Graph 任何一個 Task 的 Files
 * Allowed 內（逐一核對 T1~T18），修復需要修改 Forbidden 檔案——依 Packet
 * Stop Conditions「發現須動 Forbidden ⇒ BLOCKED」，本檔**不**斷言、**不**
 * 修復此缺口，僅涵蓋 AC-08 中未受此缺口影響的兩類既有守門：三型 `PUT`
 * 端點（含 body 內夾帶 `attachmentIds`／`segments`，驗證「附件新增」與「行
 * 程段增刪」皆走 `assertApplicationMutable`——這兩者由 `routes.ts` 於解析
 * body 前即已 403 短路，不受 `deriveContainerState` 影響）與 `DELETE
 * /applications/:id`。此缺口已另行以 `spawn_task` 標記，供人類決定歸屬
 * Task。
 *
 * ── PHASE-009-T4 追加（本檔第二批內容）──────────────────────────────────
 * 上述 AC-08(b) 缺口已由 **T4b**（`SPEC-REV-9T3` 擴列後）於
 * `attachment/lifecycle-service.ts` 修復並經即審 APPROVE；其端點層回歸落在
 * `phase4-attachment-ard.test.ts` 之 `AC-08(b)` 區塊（本檔不重複）。T4 於本
 * 檔追加：
 *   · **AC-24／AC-26**（§2 :215／:219、§6.2）：作廢稽核之形狀逐鍵、同交易
 *     回滾自證（`onVoided` hook 拋錯）、本人作廢亦寫稽核之正向斷言，以及
 *     管理員代作廢（`actorId ≠ targetId`）與管理員作廢自己申請兩格。
 *     〔稽核之**端點層**同交易自證（route 把稽核寫在交易之後的 mutant）另
 *     見 `phase9-contract.test.ts` §G——本檔之 hook 拋錯測試無法鑑別該
 *     mutant，兩者互補。〕
 *   · **T4b 即審 FW-1**：AC-08(b) 之「新增」面端到端補齊——保養／折舊兩型
 *     `PUT` 各補一則 `attachmentIds: [<TEMP 附件 id>]` 變體（403 ＋ 附件狀
 *     態仍 `TEMP`）；差旅型已由 T3 之 `segments[].attachmentIds` 涵蓋。
 *   · **fixture 缺陷修復**（非弱化）：兩個 fixture 使用者補上
 *     `mustChangePassword: false`——`User.mustChangePassword` 之 schema 預設
 *     為 `true`，T3 未顯式指定，導致本檔既有 AC-08 之四則「403」實際命中的
 *     是 `PASSWORD_CHANGE_REQUIRED`（假綠：即使
 *     `assertApplicationMutable` 守門被整個移除，測試仍會綠）。修復後各該
 *     it 另補錯誤碼逐字斷言（`FORBIDDEN`），判定收緊。
 *
 * Test discipline (Spec §11.0 / Packet)：
 *   - loginName 前綴 "p9t3_" ＋ 每次執行之隨機後綴。
 *   - cleanup 僅限本檔追蹤之 id ＋ loginName 前綴；絕不 `deleteMany({})`。
 *   - 一律合成資料；金額類斷言一律精確等值。
 *   - 完成快照以直寫 Prisma 合成（沿 `phase8-contract.test.ts` 之
 *     `createCompletedTravelApp` 既有先例）——本檔測試對象是「作廢」本身，
 *     非完成流程，直寫可避免重複驗證已在 PHASE-004/006/007 覆蓋過的完成
 *     流程，將預算集中在本 Task 的實際變更面。
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type VoidedApplicationRow,
  resolveVoidInfo,
  voidApplication,
} from "../../src/applications/application-void.js";
import { buildDepreciationApplicationDto } from "../../src/applications/depreciation-service.js";
import { buildMaintenanceApplicationDto } from "../../src/applications/maintenance-service.js";
import { toTravelApplicationDto } from "../../src/applications/travel-service.js";
import { VOID_REASON_MAX_LENGTH, validateVoidReason } from "../../src/applications/void-reason.js";
import { hashPassword } from "../../src/auth/password.js";
import { AppError } from "../../src/platform/errors.js";
import { buildServer } from "../../src/server.js";
import { fingerprintRow } from "../support/fingerprint.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ===========================================================================
// AC-03 — 作廢原因 gate table（純函式，無需 DB，恆執行）
// ===========================================================================

describe("AC-03: 作廢原因 gate table（12 列：缺鍵／null／空字串／半形空白／全形空白／Tab／換行／1 字元／500 字元／501 字元／前後空白 trim／XSS payload）", () => {
  it("缺鍵（undefined）→ 拒絕", () => {
    const result = validateVoidReason(undefined);
    expect(result.ok).toBe(false);
  });

  it("null → 拒絕", () => {
    const result = validateVoidReason(null);
    expect(result.ok).toBe(false);
  });

  it('空字串 "" → 拒絕', () => {
    const result = validateVoidReason("");
    expect(result.ok).toBe(false);
  });

  it('半形空白（"   "）→ 拒絕', () => {
    const result = validateVoidReason("   ");
    expect(result.ok).toBe(false);
  });

  it('全形空白（"　　　"）→ 拒絕', () => {
    const result = validateVoidReason("　　　");
    expect(result.ok).toBe(false);
  });

  it('Tab（"\\t\\t"）→ 拒絕', () => {
    const result = validateVoidReason("\t\t");
    expect(result.ok).toBe(false);
  });

  it('換行（"\\n\\n"）→ 拒絕', () => {
    const result = validateVoidReason("\n\n");
    expect(result.ok).toBe(false);
  });

  it("混合空白（全形空白＋Tab＋換行）→ 拒絕", () => {
    const result = validateVoidReason("　\t\n");
    expect(result.ok).toBe(false);
  });

  it("恰 1 字元 → 接受", () => {
    const result = validateVoidReason("誤");
    expect(result).toEqual({ ok: true, value: "誤" });
  });

  it(`恰 ${VOID_REASON_MAX_LENGTH} 字元 → 接受`, () => {
    const value = "誤".repeat(VOID_REASON_MAX_LENGTH);
    const result = validateVoidReason(value);
    expect(result).toEqual({ ok: true, value });
  });

  it(`${VOID_REASON_MAX_LENGTH + 1} 字元 → 拒絕`, () => {
    const value = "誤".repeat(VOID_REASON_MAX_LENGTH + 1);
    const result = validateVoidReason(value);
    expect(result.ok).toBe(false);
  });

  it('前後空白（B-03："  誤植金額  "）→ 接受，value 為 trim 後之 "誤植金額"', () => {
    const result = validateVoidReason("  誤植金額  ");
    expect(result).toEqual({ ok: true, value: "誤植金額" });
  });

  it("XSS payload（B-04）→ 接受，原樣（未跳脫）保留於 value——跳脫是呈現責任（T11），非驗證責任", () => {
    const payload = '<script>alert("x")</script>';
    const result = validateVoidReason(payload);
    expect(result).toEqual({ ok: true, value: payload });
  });

  it("非字串（number）→ 拒絕", () => {
    const result = validateVoidReason(12345);
    expect(result.ok).toBe(false);
  });

  it('fields[] 恰含 { field: "reason" }（AC-03 明文）', () => {
    const result = validateVoidReason("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("reason");
    }
  });
});

// ===========================================================================
// DB-backed tests
// ===========================================================================

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0];
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
    throw new Error(`Login failed for ${loginName}: ${resp.statusCode} ${resp.body}`);
  }
  return extractCookieHeader(resp.headers["set-cookie"]);
}

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p9t3_";
const PASSWORD = "VoidServiceTest99!";

describeWithDb("PHASE-009-T3 — voidApplication 作廢 service", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let ownerLoginName: string;
  let ownerCookie: string;
  let otherActorId: string; // 模擬「代操作者」——本 Task 不做授權判斷，僅需一個與 ownerId 不同的合法 actorId
  // PHASE-009-T4：AC-24／AC-26 需要以 HTTP 端點（非直呼 service）觸發稽核寫
  // 入，故 T3 既有之「代操作者」（role=ADMIN）於本 Task 追加登入 cookie 與
  // 一筆自己擁有的已完成申請（AC-26(d)）。
  let adminCookie: string;

  const createdApplicationIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  function trackApp(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  // ── Fixture：直寫合成之已完成申請（沿 phase8-contract.test.ts 既有先例）──

  async function createCompletedTravel(suffix: string): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-03-15T00:00:00.000Z"),
        totalAmount: 500,
        completedAt: new Date("2026-03-15T08:00:00.000Z"),
        travel: {
          create: {
            tripDate: new Date("2026-03-15T00:00:00.000Z"),
            purpose: `PHASE-009-T3 測試出差-${suffix}`,
            fuelUnitPrice: "2.3456",
            etcUnitPrice: "1.2345",
            snapshotTotalKm: "60.00",
            snapshotRawAmount: "500.0000",
            calculatedAt: new Date("2026-03-15T08:00:00.000Z"),
            segments: {
              create: [
                {
                  sortOrder: 0,
                  origin: "台北",
                  destination: "新竹",
                  totalKm: "60.00",
                  highwayKm: "50.00",
                  snapshotFuelAmount: "140.0000",
                  snapshotEtcAmount: "60.0000",
                  snapshotRawAmount: "500.0000",
                  snapshotAmount: 500,
                },
              ],
            },
          },
        },
      },
    });
    return trackApp(created.id);
  }

  async function createCompletedMaintenance(suffix: string): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "MAINTENANCE",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-04-01T00:00:00.000Z"),
        totalAmount: 300,
        completedAt: new Date("2026-04-01T08:00:00.000Z"),
        maintenance: {
          create: {
            lastMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
            currentMaintenanceDate: new Date("2026-04-01T00:00:00.000Z"),
            lastOdometerKm: "1000.00",
            currentOdometerKm: "1500.00",
            actualCost: "1000.00",
            snapshotIntervalKm: "500.00",
            snapshotOfficialKm: "150.00",
            snapshotRatio: "0.300000",
            snapshotRawAmount: "300.0000",
            calculatedAt: new Date("2026-04-01T08:00:00.000Z"),
          },
        },
      },
    });
    return trackApp(created.id);
  }

  async function createCompletedDepreciation(suffix: string, year: number): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "DEPRECIATION",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date(`${year}-12-31T00:00:00.000Z`),
        totalAmount: 900,
        completedAt: new Date(`${year}-12-31T08:00:00.000Z`),
        depreciation: {
          create: {
            applicationYear: year,
            annualTotalKm: "3000.0",
            snapshotVehiclePrice: "600000.00",
            snapshotUsefulLifeYears: 5,
            snapshotAnnualDepreciation: "120000.00",
            snapshotOfficialKm: "900.00",
            snapshotAnnualTotalKm: "3000.0",
            snapshotRatio: "0.300000",
            snapshotRawAmount: "900.0000",
            calculatedAt: new Date(`${year}-12-31T08:00:00.000Z`),
          },
        },
      },
    });
    return trackApp(created.id);
  }

  /**
   * PHASE-009-T4：任意擁有人之已完成差旅（AC-26(d) 需要一筆「管理員自己擁
   * 有」的已完成申請）。與上方 `createCompletedTravel` 之差別僅在 owner 可
   * 指定，欄位形狀逐字相同。
   */
  async function createCompletedTravelOwnedBy(owner: string, suffix: string): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: owner,
        createdById: owner,
        primaryDate: new Date("2026-03-15T00:00:00.000Z"),
        totalAmount: 500,
        completedAt: new Date("2026-03-15T08:00:00.000Z"),
        travel: {
          create: {
            tripDate: new Date("2026-03-15T00:00:00.000Z"),
            purpose: `PHASE-009-T4 測試出差-${suffix}`,
            fuelUnitPrice: "2.3456",
            etcUnitPrice: "1.2345",
            snapshotTotalKm: "60.00",
            snapshotRawAmount: "500.0000",
            calculatedAt: new Date("2026-03-15T08:00:00.000Z"),
          },
        },
      },
    });
    return trackApp(created.id);
  }

  /** PHASE-009-T4 FW-8：TEMP 附件（尚未關聯任何容器），供 PUT 夾帶用。 */
  async function createTempAttachment(suffix: string): Promise<string> {
    const attachment = await prisma.attachment.create({
      data: {
        status: "TEMP",
        storageKey: `att/p9t4-${RUN_ID}/${suffix}.jpg`,
        mimeType: "image/jpeg",
        byteSize: 1024,
        originalFilename: `${suffix}.jpg`,
        uploaderId: ownerId,
        ownerId,
      },
    });
    createdAttachmentIds.push(attachment.id);
    return attachment.id;
  }

  async function createDraftTravel(): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-03-15T00:00:00.000Z"),
      },
    });
    return trackApp(created.id);
  }

  beforeAll(async () => {
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    prisma = new PrismaClient();

    ownerLoginName = `${LOGIN_PREFIX}owner_${RUN_ID}`;
    const owner = await prisma.user.create({
      data: {
        loginName: ownerLoginName,
        displayName: "T3 擁有人",
        passwordHash: await hashPassword(PASSWORD),
        role: "USER",
        isActive: true,
        // PHASE-009-T4（缺陷修復，非弱化）：`User.mustChangePassword` 之
        // schema 預設為 `true`（schema.prisma:55）——T3 建立 fixture 時未顯
        // 式指定，導致本檔既有 AC-08 之四則「403」斷言實際命中的是
        // `requirePasswordChanged` 的 403 `PASSWORD_CHANGE_REQUIRED`，而非
        // 意圖驗證的 403 `FORBIDDEN`（`assertApplicationMutable`）——即**假
        // 綠**（守門若被整個移除，測試仍會綠）。改為 `false` 後這些斷言才
        // 真正走到狀態守門；同時於各該 it 補上錯誤碼逐字斷言，防止同型假
        // 綠再次發生（判定收緊，非放寬）。
        mustChangePassword: false,
      },
    });
    ownerId = owner.id;
    createdUserIds.push(owner.id);
    ownerCookie = await loginUser(app, ownerLoginName, PASSWORD);

    const otherLoginName = `${LOGIN_PREFIX}other_${RUN_ID}`;
    const other = await prisma.user.create({
      data: {
        loginName: otherLoginName,
        displayName: "T3 代操作者",
        passwordHash: await hashPassword(PASSWORD),
        role: "ADMIN",
        isActive: true,
        // 同上（PHASE-009-T4）：本 Task 追加 `adminCookie`，需能通過
        // `requirePasswordChanged` 才能觸及作廢端點之授權與稽核判定。
        mustChangePassword: false,
      },
    });
    otherActorId = other.id;
    createdUserIds.push(other.id);
    adminCookie = await loginUser(app, otherLoginName, PASSWORD);
  });

  afterAll(async () => {
    for (const id of createdAttachmentIds) {
      await prisma.attachment.deleteMany({ where: { id } });
    }
    for (const id of createdApplicationIds) {
      await prisma.application.deleteMany({ where: { id } });
    }
    // PHASE-009-T4：AuditLog.actorId／targetId 對 User 有 FK——本 Task 新增
    // 之稽核斷言會留下列，須先於 user 刪除（否則 afterAll 因 FK 失敗）。
    for (const id of createdUserIds) {
      await prisma.auditLog.deleteMany({ where: { actorId: id } });
      await prisma.auditLog.deleteMany({ where: { targetId: id } });
    }
    for (const id of createdUserIds) {
      await prisma.user.deleteMany({ where: { id } });
    }
    await prisma.$disconnect();
    await app.close();
  });

  // ── SF-2（T3R）：全欄指紋法。PHASE-011-T17／AC-29(c)（D16-2）已將此函式收斂
  // 至 `test/support/fingerprint.ts`（與本檔、`phase9-revision.test.ts` 曾各自
  // 之逐字複本合併為單一來源，行為與簽章逐字不變）。`excludeKeys` 供父列排除
  // 四個作廢欄＋`updatedAt`（唯一預期變動集合）；子列（三型子表／
  // TripSegment）呼叫時一律不傳 `excludeKeys`（整列比對，零例外——void 不得
  // 觸碰任何子表欄位）。

  /** AC-04 允許變動集合（父列 `Application`）——僅此五鍵，其餘逐鍵指紋比對。 */
  const APPLICATION_VOID_ALLOWED_CHANGES = [
    "status",
    "voidReason",
    "voidedAt",
    "voidedById",
    "updatedAt",
  ];

  // =========================================================================
  // AC-04 — 成功作廢：單一交易四欄寫入 ＋ 快照逐欄不變
  // =========================================================================

  describe("AC-04: 作廢成功同交易寫入四欄；totalAmount／completedAt／三型快照欄逐欄逐位元組不變", () => {
    it("差旅：成功作廢 → status=VOIDED、四欄正確寫入；totalAmount/completedAt/travel 快照 4 欄/segment 快照 4 欄逐欄不變", async () => {
      const id = await createCompletedTravel("ac04-travel");
      const before = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: { travel: { include: { segments: true } } },
      });

      const result = await voidApplication(prisma, id, "測試作廢原因", ownerId);

      expect(result.status).toBe("VOIDED");
      expect(result.voidReason).toBe("測試作廢原因");
      expect(result.voidedById).toBe(ownerId);
      expect(result.voidedAt).toBeInstanceOf(Date);

      const after = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: { travel: { include: { segments: true } } },
      });

      // 四欄正確落地
      expect(after.status).toBe("VOIDED");
      expect(after.voidReason).toBe("測試作廢原因");
      expect(after.voidedById).toBe(ownerId);
      expect(after.voidedAt).not.toBeNull();

      // SF-2（T3R）：父列全欄指紋（僅排除五個允許變動鍵＋巢狀關聯鍵
      // "travel"——關聯鍵改由下方子列指紋獨立、完整覆蓋，非略過）。取代原本
      // 手選 totalAmount／completedAt 兩欄之逐欄斷言——判定收緊：任何其他父
      // 欄位（如 primaryDate／createdById／ownerId／type）被夾帶改寫，此指紋
      // 比對必紅（M9 鑑別力來源）。
      expect(fingerprintRow(after, [...APPLICATION_VOID_ALLOWED_CHANGES, "travel"])).toEqual(
        fingerprintRow(before, [...APPLICATION_VOID_ALLOWED_CHANGES, "travel"])
      );
      // 允許變動集合：updatedAt 依 @updatedAt 更新屬預期（AC-04 明文）。
      expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());

      // SF-2：TravelApplication 子列整列指紋（零例外——void 不得觸碰任何子
      // 表欄位，取代原本僅列 5 欄之逐欄斷言，13 欄全覆蓋）。
      expect(fingerprintRow(after.travel as Record<string, unknown>)).toEqual(
        fingerprintRow(before.travel as Record<string, unknown>)
      );

      // SF-2：段落整列指紋（零例外）。
      const beforeSeg = before.travel?.segments[0];
      const afterSeg = after.travel?.segments[0];
      expect(fingerprintRow(afterSeg as Record<string, unknown>)).toEqual(
        fingerprintRow(beforeSeg as Record<string, unknown>)
      );
    });

    it("保養：成功作廢 → 五個快照欄（intervalKm/officialKm/ratio/rawAmount/calculatedAt）逐欄不變", async () => {
      const id = await createCompletedMaintenance("ac04-maintenance");
      const before = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: { maintenance: true },
      });

      await voidApplication(prisma, id, "保養作廢測試", ownerId);

      const after = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: { maintenance: true },
      });

      expect(after.status).toBe("VOIDED");

      // SF-2（T3R）：父列全欄指紋（取代 totalAmount 單欄斷言）。
      expect(fingerprintRow(after, [...APPLICATION_VOID_ALLOWED_CHANGES, "maintenance"])).toEqual(
        fingerprintRow(before, [...APPLICATION_VOID_ALLOWED_CHANGES, "maintenance"])
      );
      // SF-2：MaintenanceApplication 子列整列指紋（零例外）。
      expect(fingerprintRow(after.maintenance as Record<string, unknown>)).toEqual(
        fingerprintRow(before.maintenance as Record<string, unknown>)
      );
    });

    it("折舊：成功作廢 → 九個快照欄逐欄不變", async () => {
      const id = await createCompletedDepreciation("ac04-depreciation", 2201);
      const before = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: { depreciation: true },
      });

      await voidApplication(prisma, id, "折舊作廢測試", ownerId);

      const after = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: { depreciation: true },
      });

      expect(after.status).toBe("VOIDED");

      // SF-2（T3R）：父列全欄指紋（取代 totalAmount 單欄斷言）。
      expect(fingerprintRow(after, [...APPLICATION_VOID_ALLOWED_CHANGES, "depreciation"])).toEqual(
        fingerprintRow(before, [...APPLICATION_VOID_ALLOWED_CHANGES, "depreciation"])
      );
      // SF-2：DepreciationApplication 子列整列指紋（零例外，九個快照欄 ＋
      // applicationYear／annualTotalKm／depreciationParameterVersionId 等全
      // 覆蓋，取代原本手選九欄之逐欄斷言）。
      expect(fingerprintRow(after.depreciation as Record<string, unknown>)).toEqual(
        fingerprintRow(before.depreciation as Record<string, unknown>)
      );
    });

    it("代操作者作廢（actorId ≠ ownerId）：voidedById 為實際操作者，非擁有人（本函式不判斷授權，僅忠實記錄呼叫端傳入之 actorId）", async () => {
      const id = await createCompletedTravel("ac04-onbehalf");
      const result = await voidApplication(prisma, id, "代操作作廢", otherActorId);
      expect(result.voidedById).toBe(otherActorId);
      expect(result.ownerId).toBe(ownerId);
    });
  });

  // =========================================================================
  // AC-03 (integration) — 400 時零寫入
  // =========================================================================

  describe("AC-03: 400 時零寫入（status 不變、四欄仍 NULL、零稽核列）", () => {
    it("空白原因 → 400 VALIDATION_ERROR，status 仍為 COMPLETED，四個作廢欄仍為 NULL", async () => {
      const id = await createCompletedTravel("ac03-reject");

      await expect(voidApplication(prisma, id, "   ", ownerId)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        httpStatus: 400,
      });

      const after = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe("COMPLETED");
      expect(after.voidReason).toBeNull();
      expect(after.voidedAt).toBeNull();
      expect(after.voidedById).toBeNull();

      const auditCount = await prisma.auditLog.count({
        where: { action: "APPLICATION_VOIDED", targetId: ownerId },
      });
      expect(auditCount).toBe(0);
    });

    it("501 字元原因 → 400 VALIDATION_ERROR，零寫入", async () => {
      const id = await createCompletedTravel("ac03-toolong");
      const overLong = "誤".repeat(VOID_REASON_MAX_LENGTH + 1);

      await expect(voidApplication(prisma, id, overLong, ownerId)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        httpStatus: 400,
      });

      const after = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe("COMPLETED");
      expect(after.voidReason).toBeNull();
    });
  });

  // =========================================================================
  // AC-06 — 重複作廢
  // =========================================================================

  describe('AC-06: 已作廢再作廢 → 409 CONFLICT + details.status="VOIDED"，零寫入零稽核（非冪等成功）', () => {
    it("第二次作廢 → 409 CONFLICT，details.status=VOIDED，原 voidReason 不被覆寫", async () => {
      const id = await createCompletedTravel("ac06");
      await voidApplication(prisma, id, "第一次作廢原因", ownerId);

      let caught: unknown;
      try {
        await voidApplication(prisma, id, "第二次作廢原因（應被拒絕）", ownerId);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AppError);
      const err = caught as AppError;
      expect(err.code).toBe("CONFLICT");
      expect(err.httpStatus).toBe(409);
      expect(err.details).toEqual({ status: "VOIDED" });

      // 非冪等成功：原因不被第二次呼叫覆寫。
      const after = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(after.voidReason).toBe("第一次作廢原因");
    });
  });

  // =========================================================================
  // AC-07 — 草稿作廢
  // =========================================================================

  describe('AC-07: 草稿作廢 → 409 + details.status="DRAFT"，零寫入', () => {
    it("對草稿呼叫 voidApplication → 409 CONFLICT，details.status=DRAFT", async () => {
      const id = await createDraftTravel();

      let caught: unknown;
      try {
        await voidApplication(prisma, id, "草稿作廢測試", ownerId);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AppError);
      const err = caught as AppError;
      expect(err.code).toBe("CONFLICT");
      expect(err.httpStatus).toBe(409);
      expect(err.details).toEqual({ status: "DRAFT" });

      const after = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe("DRAFT");
      expect(after.voidReason).toBeNull();
    });

    it("狀態守門優先於原因驗證：草稿 + 空白原因 → 仍為 409（狀態），非 400（原因）", async () => {
      const id = await createDraftTravel();

      let caught: unknown;
      try {
        await voidApplication(prisma, id, "   ", ownerId);
      } catch (err) {
        caught = err;
      }

      expect((caught as AppError).code).toBe("CONFLICT");
      expect((caught as AppError).httpStatus).toBe(409);
    });
  });

  // =========================================================================
  // AC-08 — 作廢後既有守門之真實回歸（見檔頭「AC-08 範圍說明」）
  // =========================================================================

  describe("AC-08: 已作廢之三型 PUT／DELETE 端點皆 403 且零寫入（assertApplicationMutable 之真實回歸）", () => {
    it("差旅 PUT（含 purpose 與 segments[].attachmentIds 夾帶）→ 403，purpose 零改寫", async () => {
      const id = await createCompletedTravel("ac08-travel-put");
      await voidApplication(prisma, id, "AC-08 差旅測試", ownerId);

      const resp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${id}`,
        headers: { cookie: ownerCookie },
        payload: { purpose: "作廢後嘗試改動", segments: [{ attachmentIds: ["nonexistent"] }] },
      });

      expect(resp.statusCode).toBe(403);
      // PHASE-009-T4：錯誤碼逐字斷言（防 PASSWORD_CHANGE_REQUIRED 型假綠）。
      expect(JSON.parse(resp.body).error.code).toBe("FORBIDDEN");
      const after = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: { travel: true },
      });
      expect(after.travel?.purpose).not.toBe("作廢後嘗試改動");
    });

    it("保養 PUT → 403，actualCost 零改寫", async () => {
      const id = await createCompletedMaintenance("ac08-maintenance-put");
      await voidApplication(prisma, id, "AC-08 保養測試", ownerId);

      const resp = await app.inject({
        method: "PUT",
        url: `/applications/maintenance/${id}`,
        headers: { cookie: ownerCookie },
        payload: { actualCost: "99999" },
      });

      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.code).toBe("FORBIDDEN");
      const after = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: { maintenance: true },
      });
      expect(after.maintenance?.actualCost?.toString()).not.toBe("99999.00");
    });

    it("折舊 PUT → 403，applicationYear 零改寫", async () => {
      const id = await createCompletedDepreciation("ac08-depreciation-put", 2202);
      await voidApplication(prisma, id, "AC-08 折舊測試", ownerId);

      const resp = await app.inject({
        method: "PUT",
        url: `/applications/depreciation/${id}`,
        headers: { cookie: ownerCookie },
        payload: { applicationYear: 1999 },
      });

      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.code).toBe("FORBIDDEN");
      const after = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: { depreciation: true },
      });
      expect(after.depreciation?.applicationYear).not.toBe(1999);
    });

    // ── PHASE-009-T4（T4b 即審 FW-1）：AC-08(b)「新增」面之端到端補齊 ──────
    // T3 已於上方差旅分支（:622 一帶）以 `segments[].attachmentIds` 夾帶涵蓋
    // 差旅型之「附件新增」路徑；保養／折舊兩型之 `attachmentIds` 為頂層鍵，
    // 走 `parseAttachmentIdsField`——而 `assertApplicationMutable` 在解析
    // body 之前即已 403 短路，故附件恆保持 TEMP、零 LINKED 寫入。
    it("FW-1 保養 PUT 夾帶 attachmentIds:[TEMP 附件] → 403，該附件仍為 TEMP（零關聯寫入）", async () => {
      const id = await createCompletedMaintenance("fw1-maintenance-att");
      await voidApplication(prisma, id, "FW-1 保養附件測試", ownerId);
      const attId = await createTempAttachment("fw1-maintenance");

      const resp = await app.inject({
        method: "PUT",
        url: `/applications/maintenance/${id}`,
        headers: { cookie: ownerCookie },
        payload: { attachmentIds: [attId] },
      });

      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.code).toBe("FORBIDDEN");
      const att = await prisma.attachment.findUniqueOrThrow({ where: { id: attId } });
      expect(att.status).toBe("TEMP");
      expect(att.refType).toBeNull();
      expect(att.refId).toBeNull();
    });

    it("FW-1 折舊 PUT 夾帶 attachmentIds:[TEMP 附件] → 403，該附件仍為 TEMP（零關聯寫入）", async () => {
      const id = await createCompletedDepreciation("fw1-depreciation-att", 2204);
      await voidApplication(prisma, id, "FW-1 折舊附件測試", ownerId);
      const attId = await createTempAttachment("fw1-depreciation");

      const resp = await app.inject({
        method: "PUT",
        url: `/applications/depreciation/${id}`,
        headers: { cookie: ownerCookie },
        payload: { attachmentIds: [attId] },
      });

      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.code).toBe("FORBIDDEN");
      const att = await prisma.attachment.findUniqueOrThrow({ where: { id: attId } });
      expect(att.status).toBe("TEMP");
      expect(att.refType).toBeNull();
      expect(att.refId).toBeNull();
    });

    it("DELETE /applications/:id → 403，列不被刪除", async () => {
      const id = await createCompletedTravel("ac08-delete");
      await voidApplication(prisma, id, "AC-08 刪除測試", ownerId);

      const resp = await app.inject({
        method: "DELETE",
        url: `/applications/${id}`,
        headers: { cookie: ownerCookie },
      });

      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.code).toBe("FORBIDDEN");
      const after = await prisma.application.findUnique({ where: { id } });
      expect(after).not.toBeNull();
    });
  });

  // =========================================================================
  // B-08 — 併發雙作廢恰一成功
  // =========================================================================

  describe("B-08: 兩個併發作廢請求（同一申請）→ 恰一個成功、另一個 409，恰一筆 voidReason 落地", () => {
    it("Promise.allSettled 兩個併發 voidApplication → 恰一 fulfilled、恰一 rejected(409 CONFLICT)", async () => {
      const id = await createCompletedTravel("b08-concurrent");

      const results = await Promise.allSettled([
        voidApplication(prisma, id, "併發作廢-A", ownerId),
        voidApplication(prisma, id, "併發作廢-B", otherActorId),
      ]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<VoidedApplicationRow> => r.status === "fulfilled"
      );
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectedReason).toBeInstanceOf(AppError);
      expect((rejectedReason as AppError).code).toBe("CONFLICT");
      expect((rejectedReason as AppError).httpStatus).toBe(409);
      expect((rejectedReason as AppError).details).toEqual({ status: "VOIDED" });

      const after = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe("VOIDED");
      expect(["併發作廢-A", "併發作廢-B"]).toContain(after.voidReason);
      // 恰一個贏家——voidReason 對應勝出之那次呼叫。
      expect(after.voidReason).toBe(fulfilled[0].value.voidReason);
    });

    // SF-1(a)（T3R）：上方自然時序測試無法可靠鑑別「行鎖被移除」（reviewer
    // M1：12 輪僅 4 紅）或「交易被拆分」（reviewer M10：拆交易後 34 全綠）—
    // —自然時序下兩個併發呼叫常因 DB 往返時間差而恰巧仍保持序列化，運氣好
    // 就綠。本測試改為結構性守門，沿 phase8-report-generate.test.ts:254-272
    // 已背書之「讀原始碼、比對關鍵陳述式之字元位置」形狀：直接掃描
    // application-void.ts 原始碼，斷言 `FOR UPDATE` 行鎖在場、位於單一
    // `$transaction(...)` 回呼內部、且早於讀取（`findUniqueOrThrow`）與寫入
    // （`update`）——鎖移除或搬出交易／拆成第二個交易皆必紅。同一 it 順帶
    // AR-1：斷言 `assertTransition(existing.status, "VOIDED")` 呼叫在場（狀
    // 態機單一事實來源，沿 application-state-machine.test.ts:397 之「原始碼
    // 字面比對」形狀），且介於讀取與寫入之間。
    it('SF-1(a)/AR-1 結構性守門：FOR UPDATE 早於讀取與寫入、位於單一 $transaction 回呼內；assertTransition(...,"VOIDED") 在場（行鎖移除／交易拆分／狀態機呼叫移除之 mutant 必紅）', () => {
      const srcPath = new URL("../../src/applications/application-void.ts", import.meta.url);
      const src = fs.readFileSync(srcPath, "utf8");

      // 全檔恰一次 $transaction(...)——防「拆交易」mutant（M10）：若鎖與寫入
      // 被拆進兩個獨立交易，鎖會在寫入前釋放，B-08 保護即失效，即使各自看
      // 起來仍「有交易」。
      const txCallOccurrences = src.split("prisma.$transaction(").length - 1;
      expect(txCallOccurrences).toBe(1);

      const txCallIdx = src.indexOf("prisma.$transaction(");
      // 以逐字完整片語比對真實呼叫（非檔頭文件說明散文之同名片語——單獨比
      // 對 "FOR UPDATE" 會誤命中檔頭之「`SELECT ... FOR UPDATE` 為交易第一
      // 個陳述式」等說明文字，沿 phase8-report-generate.test.ts 檔頭同型警
      // 示）。
      const forUpdateIdx = src.indexOf('WHERE "id" = ${id} FOR UPDATE');
      const findIdx = src.indexOf("tx.application.findUniqueOrThrow(");
      const assertTransitionIdx = src.indexOf('assertTransition(existing.status, "VOIDED")');
      const updateIdx = src.indexOf("tx.application.update(");

      expect(txCallIdx).toBeGreaterThan(-1);
      expect(forUpdateIdx).toBeGreaterThan(-1);
      expect(findIdx).toBeGreaterThan(-1);
      expect(assertTransitionIdx).toBeGreaterThan(-1);
      expect(updateIdx).toBeGreaterThan(-1);

      // 皆位於 $transaction(...) 回呼內部（交易之後）——結合上方「恰一次」
      // 之計數，排除鎖／寫入被移到交易外、或另立第二個交易之 mutant。
      expect(txCallIdx).toBeLessThan(forUpdateIdx);
      expect(txCallIdx).toBeLessThan(updateIdx);

      // §3.1 步驟 7a（鎖）早於讀取（新鮮讀取須在鎖生效之後）與寫入。
      expect(forUpdateIdx).toBeLessThan(findIdx);
      expect(forUpdateIdx).toBeLessThan(updateIdx);

      // AR-1／狀態機單一事實來源：assertTransition 呼叫介於讀取與寫入之間
      // （讀了才判、判完才寫）。
      expect(findIdx).toBeLessThan(assertTransitionIdx);
      expect(assertTransitionIdx).toBeLessThan(updateIdx);
    });

    // SF-1(b)（T3R）：確定性 barrier——測試自行開第三個交易，對目標列持有
    // `SELECT ... FOR UPDATE` 鎖約 200ms 後才提交釋放；期間發動兩個
    // `voidApplication`。若實作確實在自己的交易內對同一列取用 `FOR UPDATE`
    // （正確實作），兩者會被本測試持有的外部鎖真正卡住、直到釋放後才序列化
    // 執行，收斂為「恰一成功、另一 409」；若鎖被移除（reviewer M1），
    // `voidApplication` 的讀取階段不會被外部鎖擋下、兩者都會在鎖釋放前讀到
    // 「尚未作廢」的快照並各自成功寫入——必紅（見下方自證）。這是比上方
    // 「自然時序」B-08 it 更強的鑑別力來源：外部持鎖強制製造真正的重疊執行
    // 窗口，不依賴 DB 往返時間差的運氣。
    it("SF-1(b) 確定性 barrier：外部持鎖 ~200ms 期間發動兩個 voidApplication → 有鎖時仍恰一成功、另一 409", async () => {
      const id = await createCompletedTravel("sf1b-barrier");

      let releaseBarrier: () => void = () => {};
      const barrierReleaseSignal = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });

      const barrierTxPromise = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Application" WHERE "id" = ${id} FOR UPDATE`;
        await barrierReleaseSignal;
      });

      // 給 barrier 交易一點時間真正取得鎖，才發動兩個 voidApplication——
      // 避免兩者的第一個陳述式搶在 barrier 之前執行。
      await new Promise((resolve) => setTimeout(resolve, 50));

      const resultsPromise = Promise.allSettled([
        voidApplication(prisma, id, "barrier-A", ownerId),
        voidApplication(prisma, id, "barrier-B", otherActorId),
      ]);

      // 確保兩個 voidApplication 已發動且（若正確實作）正卡在鎖上，才釋放。
      await new Promise((resolve) => setTimeout(resolve, 200));
      releaseBarrier();
      await barrierTxPromise;

      const results = await resultsPromise;
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "CONFLICT",
        httpStatus: 409,
        details: { status: "VOIDED" },
      });
    });
  });

  // =========================================================================
  // 三型 DTO 之 void 區塊（§7.2）——正負向
  // =========================================================================

  describe("三型 DTO 之 void 區塊正負向", () => {
    it("差旅：未作廢 → void=null；作廢後 → void 含 reason/voidedAt/voidedByDisplayName", async () => {
      const id = await createCompletedTravel("dto-travel");
      const application = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: {
          owner: { select: { displayName: true, loginName: true } },
          createdBy: { select: { displayName: true } },
          travel: { include: { segments: { orderBy: { sortOrder: "asc" } } } },
        },
      });
      const beforeDto = await toTravelApplicationDto(prisma, application);
      expect(beforeDto.void).toBeNull();

      await voidApplication(prisma, id, "DTO 測試原因", ownerId);

      const afterRow = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: {
          owner: { select: { displayName: true, loginName: true } },
          createdBy: { select: { displayName: true } },
          travel: { include: { segments: { orderBy: { sortOrder: "asc" } } } },
        },
      });
      const afterDto = await toTravelApplicationDto(prisma, afterRow);
      expect(afterDto.void).not.toBeNull();
      expect(afterDto.void?.reason).toBe("DTO 測試原因");
      expect(afterDto.void?.voidedByDisplayName).toBe("T3 擁有人");
      expect(typeof afterDto.void?.voidedAt).toBe("string");
      // PHASE-009-T15c／AC-41：逐鍵斷言同批補入新鍵（值＝完成時之
      // `Application.totalAmount`）。
      expect(afterDto.void?.totalAmount).toBe(500);
    });

    it("保養：未作廢 → void=null；作廢後 → void 非 null", async () => {
      const id = await createCompletedMaintenance("dto-maintenance");
      const before = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: { owner: { select: { displayName: true, loginName: true } }, maintenance: true },
      });
      const beforeDto = await buildMaintenanceApplicationDto(prisma, before);
      expect(beforeDto.void).toBeNull();

      await voidApplication(prisma, id, "保養 DTO 測試", ownerId);

      const after = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: { owner: { select: { displayName: true, loginName: true } }, maintenance: true },
      });
      const afterDto = await buildMaintenanceApplicationDto(prisma, after);
      expect(afterDto.void).toEqual({
        reason: "保養 DTO 測試",
        voidedAt: after.voidedAt?.toISOString(),
        voidedByDisplayName: "T3 擁有人",
        // PHASE-009-T15c／AC-41：閉集三鍵 → 四鍵之受控擴充（非弱化——多一鍵
        // 或少一鍵仍必紅）。值＝完成時之 `Application.totalAmount`。
        totalAmount: 300,
      });
    });

    it("折舊：未作廢 → void=null；作廢後 → void 非 null", async () => {
      const id = await createCompletedDepreciation("dto-depreciation", 2203);
      const before = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: { owner: { select: { displayName: true, loginName: true } }, depreciation: true },
      });
      const beforeDto = await buildDepreciationApplicationDto(prisma, before);
      expect(beforeDto.void).toBeNull();

      await voidApplication(prisma, id, "折舊 DTO 測試", ownerId);

      const after = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: { owner: { select: { displayName: true, loginName: true } }, depreciation: true },
      });
      const afterDto = await buildDepreciationApplicationDto(prisma, after);
      expect(afterDto.void).toEqual({
        reason: "折舊 DTO 測試",
        voidedAt: after.voidedAt?.toISOString(),
        voidedByDisplayName: "T3 擁有人",
        // PHASE-009-T15c／AC-41：閉集三鍵 → 四鍵之受控擴充（非弱化）。
        totalAmount: 900,
      });
    });

    it("voidedById 查無使用者（帳號已刪除）→ voidedByDisplayName 以 「—」 呈現，不拋錯", async () => {
      const id = await createCompletedTravel("dto-orphan-voider");
      // 直寫合成一個「已作廢但 voidedById 指向不存在使用者」之列（模擬帳號
      // 已被刪除；`voidedById` 無 FK，DB 層允許此狀態，§8.3 明文）。
      await prisma.application.update({
        where: { id },
        data: {
          status: "VOIDED",
          voidReason: "孤兒操作者測試",
          voidedAt: new Date(),
          voidedById: "nonexistent-user-id-xyz",
        },
      });

      const application = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: {
          owner: { select: { displayName: true, loginName: true } },
          createdBy: { select: { displayName: true } },
          travel: { include: { segments: { orderBy: { sortOrder: "asc" } } } },
        },
      });
      const dto = await toTravelApplicationDto(prisma, application);
      expect(dto.void?.voidedByDisplayName).toBe("—");
    });
  });

  // =========================================================================
  // PHASE-009-T15c — AC-41 投影面（Mock Gate 定案③：「作廢當時金額」）
  // 呈現面（三型頁 UI）屬 T15d，本區塊零呈現斷言。
  // =========================================================================

  describe("AC-41 投影：已作廢詳情之作廢當時金額", () => {
    /** 三型之「完成時 totalAmount」——與上方三個 fixture helper 之直寫值一致。 */
    const EXPECTED_TOTAL = { travel: 500, maintenance: 300, depreciation: 900 } as const;

    it("AC-41 投影: 三型 VOIDED 詳情之 void.totalAmount ＝ 完成時 Application.totalAmount（作廢前後同值）", async () => {
      // ── 差旅 ──
      const travelId = await createCompletedTravel("ac41-travel");
      const travelBefore = await prisma.application.findUniqueOrThrow({ where: { id: travelId } });
      await voidApplication(prisma, travelId, "AC-41 差旅", ownerId);
      const travelRow = await prisma.application.findUniqueOrThrow({
        where: { id: travelId },
        include: {
          owner: { select: { displayName: true, loginName: true } },
          createdBy: { select: { displayName: true } },
          travel: { include: { segments: { orderBy: { sortOrder: "asc" } } } },
        },
      });
      const travelDto = await toTravelApplicationDto(prisma, travelRow);
      expect(travelDto.status).toBe("VOIDED");
      expect(travelDto.void?.totalAmount).toBe(EXPECTED_TOTAL.travel);
      // 作廢前後同值（AC-04：作廢不清空 `totalAmount`）。
      expect(travelDto.void?.totalAmount).toBe(travelBefore.totalAmount);

      // ── 保養 ──
      const maintenanceId = await createCompletedMaintenance("ac41-maintenance");
      const maintenanceBefore = await prisma.application.findUniqueOrThrow({
        where: { id: maintenanceId },
      });
      await voidApplication(prisma, maintenanceId, "AC-41 保養", ownerId);
      const maintenanceRow = await prisma.application.findUniqueOrThrow({
        where: { id: maintenanceId },
        include: { owner: { select: { displayName: true, loginName: true } }, maintenance: true },
      });
      const maintenanceDto = await buildMaintenanceApplicationDto(prisma, maintenanceRow);
      expect(maintenanceDto.status).toBe("VOIDED");
      expect(maintenanceDto.void?.totalAmount).toBe(EXPECTED_TOTAL.maintenance);
      expect(maintenanceDto.void?.totalAmount).toBe(maintenanceBefore.totalAmount);

      // ── 折舊 ──
      const depreciationId = await createCompletedDepreciation("ac41-depreciation", 2211);
      const depreciationBefore = await prisma.application.findUniqueOrThrow({
        where: { id: depreciationId },
      });
      await voidApplication(prisma, depreciationId, "AC-41 折舊", ownerId);
      const depreciationRow = await prisma.application.findUniqueOrThrow({
        where: { id: depreciationId },
        include: { owner: { select: { displayName: true, loginName: true } }, depreciation: true },
      });
      const depreciationDto = await buildDepreciationApplicationDto(prisma, depreciationRow);
      expect(depreciationDto.status).toBe("VOIDED");
      expect(depreciationDto.void?.totalAmount).toBe(EXPECTED_TOTAL.depreciation);
      expect(depreciationDto.void?.totalAmount).toBe(depreciationBefore.totalAmount);
    });

    it("AC-41 投影 負向: 未作廢 → void 恆 null（既有斷言零弱化，金額無從外露）", async () => {
      const travelId = await createCompletedTravel("ac41-neg-travel");
      const travelRow = await prisma.application.findUniqueOrThrow({
        where: { id: travelId },
        include: {
          owner: { select: { displayName: true, loginName: true } },
          createdBy: { select: { displayName: true } },
          travel: { include: { segments: { orderBy: { sortOrder: "asc" } } } },
        },
      });
      expect((await toTravelApplicationDto(prisma, travelRow)).void).toBeNull();

      const maintenanceId = await createCompletedMaintenance("ac41-neg-maintenance");
      const maintenanceRow = await prisma.application.findUniqueOrThrow({
        where: { id: maintenanceId },
        include: { owner: { select: { displayName: true, loginName: true } }, maintenance: true },
      });
      expect((await buildMaintenanceApplicationDto(prisma, maintenanceRow)).void).toBeNull();

      const depreciationId = await createCompletedDepreciation("ac41-neg-depreciation", 2212);
      const depreciationRow = await prisma.application.findUniqueOrThrow({
        where: { id: depreciationId },
        include: { owner: { select: { displayName: true, loginName: true } }, depreciation: true },
      });
      expect((await buildDepreciationApplicationDto(prisma, depreciationRow)).void).toBeNull();
    });

    it("AC-41(d) 結構: VOIDED 之 snapshot 仍恆為 null — 三型（定案③「不恢復整個快照區塊」；三型 service 檔零 diff）", async () => {
      const travelId = await createCompletedTravel("ac41-snap-travel");
      await voidApplication(prisma, travelId, "AC-41(d) 差旅", ownerId);
      const travelRow = await prisma.application.findUniqueOrThrow({
        where: { id: travelId },
        include: {
          owner: { select: { displayName: true, loginName: true } },
          createdBy: { select: { displayName: true } },
          travel: { include: { segments: { orderBy: { sortOrder: "asc" } } } },
        },
      });
      expect((await toTravelApplicationDto(prisma, travelRow)).snapshot).toBeNull();

      const maintenanceId = await createCompletedMaintenance("ac41-snap-maintenance");
      await voidApplication(prisma, maintenanceId, "AC-41(d) 保養", ownerId);
      const maintenanceRow = await prisma.application.findUniqueOrThrow({
        where: { id: maintenanceId },
        include: { owner: { select: { displayName: true, loginName: true } }, maintenance: true },
      });
      expect((await buildMaintenanceApplicationDto(prisma, maintenanceRow)).snapshot).toBeNull();

      const depreciationId = await createCompletedDepreciation("ac41-snap-depreciation", 2213);
      await voidApplication(prisma, depreciationId, "AC-41(d) 折舊", ownerId);
      const depreciationRow = await prisma.application.findUniqueOrThrow({
        where: { id: depreciationId },
        include: { owner: { select: { displayName: true, loginName: true } }, depreciation: true },
      });
      expect((await buildDepreciationApplicationDto(prisma, depreciationRow)).snapshot).toBeNull();
    });
  });

  // =========================================================================
  // resolveVoidInfo — 直接單元覆蓋（同生共死三欄邏輯）
  // =========================================================================

  // =========================================================================
  // PHASE-009-T4 — AC-24 作廢稽核（同交易）＋ AC-26(a)(d) 代操作稽核
  //
  // 規範出處：§2 AC-24（`action='APPLICATION_VOIDED'`／`actorId`＝實際操作
  // 者／`targetId`＝申請擁有人／`targetLabel`＝`{loginName}#{applicationId}`
  // ／`summary` 含 `{ applicationId, type, reason, voidedAt }`；**本人作廢亦
  // 寫稽核**）、§6.2 稽核表、AC-26(a)（管理員代作廢：actorId≠targetId）／
  // AC-26(d)（管理員作廢自己的申請仍寫 `APPLICATION_VOIDED`）。
  //
  // §12 映射表將 AC-26(a)(d) 之落點列為本檔（`phase9-void.test.ts`）＋ T4；
  // T4 Packet 之 Required Tests 未逐條列出 AC-26——以 Spec §12 原文為準納
  // 入，並於 Handoff Warnings 記載此差異（Packet 轉述與 Spec 不一致時以 Spec
  // 為準之治理規則）。
  // =========================================================================

  describe("AC-24／AC-26: 作廢稽核（同交易）", () => {
    /** 取本申請之 `APPLICATION_VOIDED` 稽核列（以 summary.applicationId 精確定位）。 */
    async function findVoidAudits(applicationId: string) {
      const rows = await prisma.auditLog.findMany({
        where: { action: "APPLICATION_VOIDED" },
        orderBy: { createdAt: "asc" },
      });
      return rows.filter(
        (r) => (r.summary as Record<string, unknown> | null)?.applicationId === applicationId
      );
    }

    it("AC-24: 本人經端點作廢 → 恰一筆 AuditLog(APPLICATION_VOIDED)，action／actorId／targetId／targetLabel／summary 逐鍵", async () => {
      const id = await createCompletedTravel("ac24-shape");

      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/void`,
        headers: { cookie: ownerCookie },
        payload: { reason: "AC-24 形狀測試原因" },
      });
      expect(resp.statusCode).toBe(200);

      const audits = await findVoidAudits(id);
      expect(audits).toHaveLength(1);
      const audit = audits[0];
      expect(audit.action).toBe("APPLICATION_VOIDED");
      expect(audit.actorId).toBe(ownerId);
      expect(audit.targetId).toBe(ownerId);
      expect(audit.targetLabel).toBe(`${ownerLoginName}#${id}`);

      const persisted = await prisma.application.findUniqueOrThrow({ where: { id } });
      // summary 鍵集封閉（`toEqual`）——多寫一鍵（例如夾帶 voidedById／
      // ownerId 等內部識別值）必紅。
      expect(audit.summary).toEqual({
        applicationId: id,
        type: "TRAVEL",
        reason: "AC-24 形狀測試原因",
        voidedAt: persisted.voidedAt?.toISOString(),
      });
    });

    it("AC-24 同交易自證: 稽核 hook 拋錯 → 四欄寫入一併回滾（零孤兒稽核列、狀態未變）", async () => {
      const id = await createCompletedTravel("ac24-rollback");

      await expect(
        voidApplication(prisma, id, "AC-24 回滾測試", ownerId, async (tx, context, application) => {
          // 先真的在同一交易寫入稽核列，再拋錯——若稽核寫入不在交易內，這
          // 一列會殘留成孤兒（下方斷言必紅）。
          await tx.auditLog.create({
            data: {
              action: "APPLICATION_VOIDED",
              actorId: ownerId,
              targetId: context.ownerId,
              targetLabel: `${context.ownerLoginName}#${application.id}`,
              summary: { applicationId: application.id, type: context.type },
            },
          });
          throw new Error("injected audit hook failure");
        })
      ).rejects.toThrow("injected audit hook failure");

      const after = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe("COMPLETED");
      expect(after.voidReason).toBeNull();
      expect(after.voidedAt).toBeNull();
      expect(after.voidedById).toBeNull();
      expect(await findVoidAudits(id)).toHaveLength(0);
    });

    it("AC-24: 本人作廢亦寫稽核（正向斷言——與 PHASE-004 AC-86「本人自建草稿不寫稽核」刻意不同）", async () => {
      const id = await createCompletedTravel("ac24-self");

      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/void`,
        headers: { cookie: ownerCookie },
        payload: { reason: "本人作廢" },
      });
      expect(resp.statusCode).toBe(200);

      const audits = await findVoidAudits(id);
      expect(audits).toHaveLength(1);
      // 本人操作：actorId === targetId（若沿用 AC-86 之「本人豁免」而跳過寫
      // 入，此處 length 為 0 必紅）。
      expect(audits[0].actorId).toBe(ownerId);
      expect(audits[0].actorId).toBe(audits[0].targetId);
    });

    it("AC-26(a): 管理員代作廢 → actorId=管理員、targetId=擁有人（actorId ≠ targetId）", async () => {
      const id = await createCompletedTravel("ac26a-onbehalf");

      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/void`,
        headers: { cookie: adminCookie },
        payload: { reason: "管理員代作廢" },
      });
      expect(resp.statusCode).toBe(200);

      const audits = await findVoidAudits(id);
      expect(audits).toHaveLength(1);
      expect(audits[0].actorId).toBe(otherActorId);
      expect(audits[0].targetId).toBe(ownerId);
      expect(audits[0].actorId).not.toBe(audits[0].targetId);
      expect(audits[0].targetLabel).toBe(`${ownerLoginName}#${id}`);
    });

    it("AC-26(d): 管理員作廢自己的申請 → 仍寫 APPLICATION_VOIDED（作廢不受 AC-86 本人豁免影響）", async () => {
      const id = await createCompletedTravelOwnedBy(otherActorId, "ac26d-admin-self");

      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/void`,
        headers: { cookie: adminCookie },
        payload: { reason: "管理員作廢自己的申請" },
      });
      expect(resp.statusCode).toBe(200);

      const audits = await findVoidAudits(id);
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe("APPLICATION_VOIDED");
      expect(audits[0].actorId).toBe(otherActorId);
      expect(audits[0].targetId).toBe(otherActorId);
    });
  });

  describe("resolveVoidInfo：三欄同生共死", () => {
    it("三欄皆 null → 回傳 null", async () => {
      const result = await resolveVoidInfo(prisma, {
        voidReason: null,
        voidedAt: null,
        voidedById: null,
        // PHASE-009-T15c（AC-41）：新增之投影來源欄（三欄同生共死之判定不受其
        // 影響——三欄皆 null 時恆早退回傳 null，金額無從外露）。
        totalAmount: 500,
      });
      expect(result).toBeNull();
    });
  });
});
