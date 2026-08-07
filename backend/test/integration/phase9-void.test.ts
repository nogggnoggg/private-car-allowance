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

      // 快照零改寫：totalAmount／completedAt
      expect(after.totalAmount).toBe(before.totalAmount);
      expect(after.completedAt?.toISOString()).toBe(before.completedAt?.toISOString());

      // 快照零改寫：TravelApplication 四欄
      expect(after.travel?.fuelUnitPrice?.toString()).toBe(
        before.travel?.fuelUnitPrice?.toString()
      );
      expect(after.travel?.etcUnitPrice?.toString()).toBe(before.travel?.etcUnitPrice?.toString());
      expect(after.travel?.snapshotTotalKm?.toString()).toBe(
        before.travel?.snapshotTotalKm?.toString()
      );
      expect(after.travel?.snapshotRawAmount?.toString()).toBe(
        before.travel?.snapshotRawAmount?.toString()
      );
      expect(after.travel?.calculatedAt?.toISOString()).toBe(
        before.travel?.calculatedAt?.toISOString()
      );

      // 快照零改寫：段落四欄
      const beforeSeg = before.travel?.segments[0];
      const afterSeg = after.travel?.segments[0];
      expect(afterSeg?.snapshotFuelAmount?.toString()).toBe(
        beforeSeg?.snapshotFuelAmount?.toString()
      );
      expect(afterSeg?.snapshotEtcAmount?.toString()).toBe(
        beforeSeg?.snapshotEtcAmount?.toString()
      );
      expect(afterSeg?.snapshotRawAmount?.toString()).toBe(
        beforeSeg?.snapshotRawAmount?.toString()
      );
      expect(afterSeg?.snapshotAmount).toBe(beforeSeg?.snapshotAmount);

      // 允許變動集合：updatedAt 依 @updatedAt 更新屬預期（AC-04 明文）。
      expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
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
      expect(after.totalAmount).toBe(before.totalAmount);
      expect(after.maintenance?.snapshotIntervalKm?.toString()).toBe(
        before.maintenance?.snapshotIntervalKm?.toString()
      );
      expect(after.maintenance?.snapshotOfficialKm?.toString()).toBe(
        before.maintenance?.snapshotOfficialKm?.toString()
      );
      expect(after.maintenance?.snapshotRatio?.toString()).toBe(
        before.maintenance?.snapshotRatio?.toString()
      );
      expect(after.maintenance?.snapshotRawAmount?.toString()).toBe(
        before.maintenance?.snapshotRawAmount?.toString()
      );
      expect(after.maintenance?.calculatedAt?.toISOString()).toBe(
        before.maintenance?.calculatedAt?.toISOString()
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
      expect(after.totalAmount).toBe(before.totalAmount);
      expect(after.depreciation?.snapshotVehiclePrice?.toString()).toBe(
        before.depreciation?.snapshotVehiclePrice?.toString()
      );
      expect(after.depreciation?.snapshotUsefulLifeYears).toBe(
        before.depreciation?.snapshotUsefulLifeYears
      );
      expect(after.depreciation?.snapshotAnnualDepreciation?.toString()).toBe(
        before.depreciation?.snapshotAnnualDepreciation?.toString()
      );
      expect(after.depreciation?.snapshotOfficialKm?.toString()).toBe(
        before.depreciation?.snapshotOfficialKm?.toString()
      );
      expect(after.depreciation?.snapshotAnnualTotalKm?.toString()).toBe(
        before.depreciation?.snapshotAnnualTotalKm?.toString()
      );
      expect(after.depreciation?.snapshotRatio?.toString()).toBe(
        before.depreciation?.snapshotRatio?.toString()
      );
      expect(after.depreciation?.snapshotRawAmount?.toString()).toBe(
        before.depreciation?.snapshotRawAmount?.toString()
      );
      expect(after.depreciation?.calculatedAt?.toISOString()).toBe(
        before.depreciation?.calculatedAt?.toISOString()
      );
      expect(after.depreciation?.depreciationParameterVersionId).toBe(
        before.depreciation?.depreciationParameterVersionId
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
