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
  let ownerCookie: string;
  let otherActorId: string; // 模擬「代操作者」——本 Task 不做授權判斷，僅需一個與 ownerId 不同的合法 actorId

  const createdApplicationIds: string[] = [];
  const createdUserIds: string[] = [];

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

    const ownerLoginName = `${LOGIN_PREFIX}owner_${RUN_ID}`;
    const owner = await prisma.user.create({
      data: {
        loginName: ownerLoginName,
        displayName: "T3 擁有人",
        passwordHash: await hashPassword(PASSWORD),
        role: "USER",
        isActive: true,
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
      },
    });
    otherActorId = other.id;
    createdUserIds.push(other.id);
  });

  afterAll(async () => {
    for (const id of createdApplicationIds) {
      await prisma.application.deleteMany({ where: { id } });
    }
    for (const id of createdUserIds) {
      await prisma.user.deleteMany({ where: { id } });
    }
    await prisma.$disconnect();
    await app.close();
  });

  // ── SF-2（T3R）：全欄指紋法，沿 phase7-depreciation-draft.test.ts:896-901
  // 之 `fingerprintOf` 既有形狀——逐鍵轉字串後依鍵排序，避免 Decimal／Date
  // 物件之 toEqual 結構比對細節干擾，同時（相較舊版逐欄手選斷言）不會漏掉
  // 任何「新增之允許外欄位」。`excludeKeys` 供父列排除四個作廢欄＋
  // `updatedAt`（唯一預期變動集合）；子列（三型子表／TripSegment）呼叫時
  // 一律不傳 `excludeKeys`（整列比對，零例外——void 不得觸碰任何子表欄位）。
  function fingerprintRow(
    row: Record<string, unknown>,
    excludeKeys: string[] = []
  ): Array<[string, string | null]> {
    return Object.entries(row)
      .filter(([key]) => !excludeKeys.includes(key))
      .map(([key, value]): [string, string | null] => [
        key,
        value === null || value === undefined ? null : String(value),
      ])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

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
      const after = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: { depreciation: true },
      });
      expect(after.depreciation?.applicationYear).not.toBe(1999);
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
  // resolveVoidInfo — 直接單元覆蓋（同生共死三欄邏輯）
  // =========================================================================

  describe("resolveVoidInfo：三欄同生共死", () => {
    it("三欄皆 null → 回傳 null", async () => {
      const result = await resolveVoidInfo(prisma, {
        voidReason: null,
        voidedAt: null,
        voidedById: null,
      });
      expect(result).toBeNull();
    });
  });
});
