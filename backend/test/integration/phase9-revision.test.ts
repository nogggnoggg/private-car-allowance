/**
 * Integration tests for PHASE-009-T5:
 *   修正版複製 service — 三型欄位逐欄複製 ＋ 版本關聯 ＋ 原申請零改動。
 *
 * Spec `docs/specs/PHASE-009.md`：
 *   AC-09（§2 :175）：新 `Application`：`status='DRAFT'`、`type` 同原申請、
 *     `ownerId` ＝原申請之 `ownerId`（管理員代建時亦然）、`createdById` ＝實
 *     際操作者、`primaryDate` 由**複製後之業務欄位**依既有 `derive*PrimaryDate`
 *     推導、`totalAmount`／`completedAt`／四個作廢欄皆 `NULL`。
 *   AC-10（§2 :177-:181、§7.4 對照表）：三型逐欄複製；快照欄與參數版本引用
 *     欄一律不複製（鍵集封閉式逐欄斷言，多複製一欄必紅）。
 *   AC-11（§2 :183）：(a) 原 `Application`／三型子列／`TripSegment` 逐欄逐位
 *     元組不變（含 `updatedAt` 未被 touch）；(b) 原 `Attachment` 五欄不變；
 *     (c) 原 `Report` 七欄不變且其 PDF 位元組 SHA-256 前後相同。
 *
 * ── T5 Files Allowed 範圍說明（Packet 逐字）──────────────────────────────
 * `routes.ts`（端點／授權／稽核）屬 **T7**、附件複製屬 **T6**、修正版報表
 * 屬 **T9/T12**——皆為本 Task 之 Files Forbidden。故本檔直接呼叫
 * `createApplicationRevision`（`application-revision.ts`，本 Task 新增）而非
 * 尚不存在的 `POST /applications/:id/revision` 端點；AC-09 之「**201**」為端
 * 點層語意，本 Task 交付的是其 service 層前提（回傳形狀與 DB 列正確性），
 * 201 之逐字斷言歸 T7。同理 AC-12（雙向版本關聯 DTO）與 AC-13（三種 409 之
 * 端點回應）之測試亦歸 T7，本檔只斷言 `supersedesId` 之持久化事實。
 *
 * ── AC-11(c) 之 PDF 位元組如何合成（誠實揭露）──────────────────────────
 * 本檔不呼叫 Playwright 渲染真實 PDF：修正版流程**完全不觸碰 storage**（附
 * 件複製屬 T6、報表屬 T9/T12），因此「位元組前後相同」之鑑別力與位元組是否
 * 由真實渲染器產生無關。本檔以 `LocalVolumeStorage` 於暫存目錄寫入合成位元
 * 組（含 `%PDF-` 開頭，僅為形狀擬真），並於修正版建立前後各讀取一次、比對
 * SHA-256 —— 逐位元組實證（§17.2 複用義務 #2），非以「Report 列未變」替代。
 *
 * Test discipline (Spec §11.0 / Packet)：
 *   - loginName 前綴 "p9t5_" ＋ 每次執行之隨機後綴。
 *   - cleanup 僅限本檔追蹤之 id ＋ loginName 前綴；絕不 `deleteMany({})`。
 *   - 一律合成資料；金額／里程斷言一律精確等值。
 *   - fixture 使用者顯式指定 `mustChangePassword: false`（T3 假綠教訓；本檔
 *     雖不經 HTTP，仍沿用同一 fixture 紀律以免日後擴充時重蹈覆轍）。
 *   - 已完成申請之快照以直寫 Prisma 合成（沿 `phase9-void.test.ts` 既有先
 *     例）——本檔測試對象是「複製」本身，非完成流程。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplicationRevision } from "../../src/applications/application-revision.js";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";
import { LocalVolumeStorage } from "../../src/storage/index.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const LOGIN_PREFIX = "p9t5_";
const PASSWORD = "P9t5-Synthetic-Passw0rd!";

describeWithDb("PHASE-009-T5 修正版複製 service（AC-09／AC-10／AC-11）", () => {
  let prisma: PrismaClient;
  let ownerId: string;
  let adminId: string;
  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];
  const createdUserIds: string[] = [];
  let reportStorageRoot: string;

  function trackApp(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  // -------------------------------------------------------------------------
  // fingerprintRow —— 沿 `phase9-void.test.ts:466-489`（T5pre 修復後語意）
  //
  // 【第三份複製之理由，Packet FW-1⑤ 大總管裁定】抽為共用 helper 需新增
  // `backend/test/**` 之共用模組並改寫 `phase7-depreciation-draft.test.ts`／
  // `phase9-void.test.ts` 兩個既有檔案——後者為本 Task 之 Files Forbidden
  // （唯讀參考），前者屬 phase7 測試檔（亦 Forbidden）。故依裁定於本新檔就地
  // 複製第三份，維持三處語意逐字一致。
  //
  // 修復後語意（AR-5／M13）：
  //   · Date → toISOString()（保留毫秒；String(Date) 會截斷至秒，使「同秒內
  //     毫秒位移之竄改」不可鑑別——AC-11(a)「原列不得被 touch」正是此場景）。
  //   · Prisma.Decimal → String()（維持既有數值序列化行為；需 scale 保真時
  //     另以 toFixed 逐欄斷言，見 AC-10 各 it）。
  //   · 其餘物件（含陣列）→ JSON.stringify（避免 String(object) 退化為
  //     `[object Object]` 而掩蓋內容差異）。
  // -------------------------------------------------------------------------
  function fingerprintRow(
    row: Record<string, unknown>,
    excludeKeys: string[] = []
  ): Array<[string, string | null]> {
    return Object.entries(row)
      .filter(([key]) => !excludeKeys.includes(key))
      .map(([key, value]): [string, string | null] => {
        if (value === null || value === undefined) return [key, null];
        if (value instanceof Date) return [key, value.toISOString()];
        if (typeof value === "object" && !(value instanceof Prisma.Decimal)) {
          return [key, JSON.stringify(value)];
        }
        return [key, String(value)];
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // -------------------------------------------------------------------------
  // fixtures
  // -------------------------------------------------------------------------

  /** 已完成差旅（三段，段序 0/1/2，段快照四欄皆有值）。 */
  async function createCompletedTravel(suffix: string): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-03-15T00:00:00.000Z"),
        totalAmount: 1500,
        completedAt: new Date("2026-03-15T08:00:00.000Z"),
        travel: {
          create: {
            tripDate: new Date("2026-03-15T00:00:00.000Z"),
            purpose: `PHASE-009-T5 測試出差-${suffix}`,
            fuelUnitPrice: "2.3456",
            etcUnitPrice: "1.2345",
            fuelParameterVersionId: `fpv-${suffix}`,
            etcParameterVersionId: `epv-${suffix}`,
            snapshotTotalKm: "240.75",
            snapshotRawAmount: "1500.0000",
            calculatedAt: new Date("2026-03-15T08:00:00.000Z"),
            snapshotFuelType: "GASOLINE_95",
            snapshotFuelPricePerLiter: "31.5000",
            snapshotFuelConsumption: "12.5000",
            fuelPriceVersionId: `fpricev-${suffix}`,
            fuelConsumptionVersionId: `fcv-${suffix}`,
            segments: {
              create: [
                {
                  sortOrder: 0,
                  origin: "台北",
                  destination: "新竹",
                  totalKm: "80.50",
                  highwayKm: "60.00",
                  snapshotFuelAmount: "140.0000",
                  snapshotEtcAmount: "60.0000",
                  snapshotRawAmount: "500.0000",
                  snapshotAmount: 500,
                },
                {
                  sortOrder: 1,
                  origin: "新竹",
                  destination: "台中",
                  totalKm: "90.25",
                  highwayKm: "70.00",
                  snapshotFuelAmount: "150.0000",
                  snapshotEtcAmount: "70.0000",
                  snapshotRawAmount: "550.0000",
                  snapshotAmount: 550,
                },
                {
                  sortOrder: 2,
                  origin: "台中",
                  destination: "嘉義",
                  totalKm: "70.00",
                  highwayKm: "50.00",
                  snapshotFuelAmount: "130.0000",
                  snapshotEtcAmount: "50.0000",
                  snapshotRawAmount: "450.0000",
                  snapshotAmount: 450,
                },
              ],
            },
          },
        },
      },
    });
    return trackApp(created.id);
  }

  /** 已完成保養（五個業務欄位 ＋ 五個快照欄皆有值）。 */
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
            actualCost: `1000.0${suffix.length % 10}`,
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

  /** 已完成折舊（兩個業務欄位 ＋ 九個快照欄 ＋ 參數版本引用欄皆有值）。 */
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
            depreciationParameterVersionId: `dpv-${suffix}`,
            // 凍結唯讀（舊模型）兩欄——刻意給值，證明修正版不沿用
            snapshotEstimatedAnnualKm: 15000,
            snapshotPerKmUnitPrice: "8.0000",
          },
        },
      },
    });
    return trackApp(created.id);
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    reportStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase9-revision-rpt-"));

    const owner = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}owner_${RUN_ID}`,
        displayName: "T5 擁有人",
        passwordHash: await hashPassword(PASSWORD),
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    ownerId = owner.id;
    createdUserIds.push(owner.id);

    const admin = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}admin_${RUN_ID}`,
        displayName: "T5 代操作管理員",
        passwordHash: await hashPassword(PASSWORD),
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    adminId = admin.id;
    createdUserIds.push(admin.id);
  });

  afterAll(async () => {
    if (!prisma) return;
    for (const id of createdAttachmentIds) {
      await prisma.attachment.deleteMany({ where: { id } });
    }
    await prisma.report.deleteMany({ where: { applicationId: { in: createdApplicationIds } } });
    // 修正版（supersedesId → 原申請，onDelete: Restrict）必須先於原申請刪除。
    for (const id of [...createdApplicationIds].reverse()) {
      await prisma.application.deleteMany({ where: { supersedesId: id } });
    }
    for (const id of [...createdApplicationIds].reverse()) {
      await prisma.application.deleteMany({ where: { id } });
    }
    for (const id of createdUserIds) {
      await prisma.user.deleteMany({ where: { id } });
    }
    await prisma.$disconnect();
    try {
      fs.rmSync(reportStorageRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  // =========================================================================
  // AC-09
  // =========================================================================

  describe("AC-09: 建立修正版 → 201；新列 status=DRAFT、ownerId=原擁有人、createdById=操作者、totalAmount／completedAt／作廢三欄皆 NULL", () => {
    it("差旅（管理員代建）：父列全欄封閉比對——僅六個允許欄位有值，其餘（totalAmount／completedAt／三個作廢欄）恆 NULL", async () => {
      const sourceId = await createCompletedTravel("ac09-travel");

      const row = await createApplicationRevision(prisma, sourceId, adminId);
      trackApp(row.id);

      expect(row.id).not.toBe(sourceId);
      expect(row.status).toBe("DRAFT");
      expect(row.type).toBe("TRAVEL");
      expect(row.ownerId).toBe(ownerId);
      expect(row.createdById).toBe(adminId);
      expect(row.supersedesId).toBe(sourceId);

      const created = await prisma.application.findUniqueOrThrow({ where: { id: row.id } });
      const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = created;

      // 封閉式逐欄斷言：expected 逐一列出 `Application` 之**全部**其餘欄位。
      // 實作若夾帶複製任一欄（如 totalAmount／completedAt／作廢欄），actual
      // 之該鍵將非 null 而 expected 為 null → 必紅；schema 日後新增欄位則
      // expected 缺鍵 → 亦必紅（機械連動可見）。
      expect(fingerprintRow(rest)).toEqual(
        fingerprintRow({
          type: "TRAVEL",
          status: "DRAFT",
          ownerId,
          createdById: adminId,
          primaryDate: new Date("2026-03-15T00:00:00.000Z"),
          totalAmount: null,
          completedAt: null,
          voidReason: null,
          voidedAt: null,
          voidedById: null,
          supersedesId: sourceId,
        })
      );
    });

    it("保養（本人操作）：createdById ＝操作者本人；primaryDate 由複製後之 currentMaintenanceDate 推導", async () => {
      const sourceId = await createCompletedMaintenance("ac09-maintenance");

      const row = await createApplicationRevision(prisma, sourceId, ownerId);
      trackApp(row.id);

      const created = await prisma.application.findUniqueOrThrow({ where: { id: row.id } });
      const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = created;

      expect(fingerprintRow(rest)).toEqual(
        fingerprintRow({
          type: "MAINTENANCE",
          status: "DRAFT",
          ownerId,
          createdById: ownerId,
          primaryDate: new Date("2026-04-01T00:00:00.000Z"),
          totalAmount: null,
          completedAt: null,
          voidReason: null,
          voidedAt: null,
          voidedById: null,
          supersedesId: sourceId,
        })
      );
    });

    it("折舊（管理員代建）：primaryDate ＝複製後 applicationYear 之 12-31（deriveDepreciationPrimaryDate 既有規則）", async () => {
      const sourceId = await createCompletedDepreciation("ac09-dep", 2025);

      const row = await createApplicationRevision(prisma, sourceId, adminId);
      trackApp(row.id);

      const created = await prisma.application.findUniqueOrThrow({ where: { id: row.id } });
      const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = created;

      expect(fingerprintRow(rest)).toEqual(
        fingerprintRow({
          type: "DEPRECIATION",
          status: "DRAFT",
          ownerId,
          createdById: adminId,
          primaryDate: new Date("2025-12-31T00:00:00.000Z"),
          totalAmount: null,
          completedAt: null,
          voidReason: null,
          voidedAt: null,
          voidedById: null,
          supersedesId: sourceId,
        })
      );
    });
  });

  // =========================================================================
  // AC-10
  // =========================================================================

  describe("AC-10: 三型「複製鍵集」與「禁複製鍵集」toEqual 封閉（多複製一欄必紅）", () => {
    it("差旅子列：tripDate／purpose 複製，十二個快照／參數版本引用欄恆 NULL（DB 列層封閉比對）", async () => {
      const sourceId = await createCompletedTravel("ac10-travel-child");
      const row = await createApplicationRevision(prisma, sourceId, ownerId);
      trackApp(row.id);

      const child = await prisma.travelApplication.findUniqueOrThrow({
        where: { applicationId: row.id },
      });
      const { applicationId: _applicationId, ...rest } = child;

      expect(fingerprintRow(rest)).toEqual(
        fingerprintRow({
          tripDate: new Date("2026-03-15T00:00:00.000Z"),
          purpose: "PHASE-009-T5 測試出差-ac10-travel-child",
          fuelUnitPrice: null,
          etcUnitPrice: null,
          fuelParameterVersionId: null,
          etcParameterVersionId: null,
          snapshotTotalKm: null,
          snapshotRawAmount: null,
          calculatedAt: null,
          snapshotFuelType: null,
          snapshotFuelPricePerLiter: null,
          snapshotFuelConsumption: null,
          fuelPriceVersionId: null,
          fuelConsumptionVersionId: null,
        })
      );
    });

    it("保養子列：五個業務欄位複製，五個快照欄恆 NULL（DB 列層封閉比對，Decimal scale 以 toFixed 保真）", async () => {
      const sourceId = await createCompletedMaintenance("ac10-mnt");
      const row = await createApplicationRevision(prisma, sourceId, ownerId);
      trackApp(row.id);

      const source = await prisma.maintenanceApplication.findUniqueOrThrow({
        where: { applicationId: sourceId },
      });
      const child = await prisma.maintenanceApplication.findUniqueOrThrow({
        where: { applicationId: row.id },
      });
      const { applicationId: _applicationId, ...rest } = child;

      expect(fingerprintRow(rest)).toEqual(
        fingerprintRow({
          lastMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
          currentMaintenanceDate: new Date("2026-04-01T00:00:00.000Z"),
          lastOdometerKm: new Prisma.Decimal("1000.00"),
          currentOdometerKm: new Prisma.Decimal("1500.00"),
          actualCost: source.actualCost,
          snapshotIntervalKm: null,
          snapshotOfficialKm: null,
          snapshotRatio: null,
          snapshotRawAmount: null,
          calculatedAt: null,
        })
      );

      // scale 保真（FW-1③：String(Decimal) 會塌縮尾隨零，故金額欄另以 toFixed
      // 逐欄比對原值）。
      expect(child.lastOdometerKm?.toFixed(2)).toBe(source.lastOdometerKm?.toFixed(2));
      expect(child.currentOdometerKm?.toFixed(2)).toBe(source.currentOdometerKm?.toFixed(2));
      expect(child.actualCost?.toFixed(2)).toBe(source.actualCost?.toFixed(2));
    });

    it("AC-10: 差旅逐段複製且 sortOrder 保序，段快照四欄恆 NULL", async () => {
      const sourceId = await createCompletedTravel("ac10-segments");
      const row = await createApplicationRevision(prisma, sourceId, ownerId);
      trackApp(row.id);

      const sourceSegments = await prisma.tripSegment.findMany({
        where: { travelApplicationId: sourceId },
        orderBy: { sortOrder: "asc" },
      });
      const newSegments = await prisma.tripSegment.findMany({
        where: { travelApplicationId: row.id },
        orderBy: { sortOrder: "asc" },
      });

      expect(sourceSegments).toHaveLength(3);
      expect(newSegments).toHaveLength(3);
      // 段序保存（0/1/2）；FW-1① orderBy sortOrder asc 已於兩側查詢明示。
      expect(newSegments.map((s) => s.sortOrder)).toEqual([0, 1, 2]);
      // 新段 id 一律新生成（非沿用原段 id）
      expect(
        newSegments.map((s) => s.id).some((id) => sourceSegments.some((s) => s.id === id))
      ).toBe(false);

      for (const [index, segment] of newSegments.entries()) {
        const source = sourceSegments[index];
        const {
          id: _id,
          travelApplicationId: _travelApplicationId,
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          ...rest
        } = segment;

        // 封閉比對：五個業務欄位 ＝原段值；四個段快照欄恆 NULL。
        expect(fingerprintRow(rest)).toEqual(
          fingerprintRow({
            sortOrder: source.sortOrder,
            origin: source.origin,
            destination: source.destination,
            totalKm: source.totalKm,
            highwayKm: source.highwayKm,
            snapshotFuelAmount: null,
            snapshotEtcAmount: null,
            snapshotRawAmount: null,
            snapshotAmount: null,
          })
        );
        // 段—值對位（零跨段錯置）＋ scale 保真
        expect(segment.origin).toBe(source.origin);
        expect(segment.destination).toBe(source.destination);
        expect(segment.totalKm?.toFixed(2)).toBe(source.totalKm?.toFixed(2));
        expect(segment.highwayKm?.toFixed(2)).toBe(source.highwayKm?.toFixed(2));
      }
    });

    it("AC-10: 折舊複製 applicationYear 與 annualTotalKm，九個快照欄與參數版本引用欄恆 NULL", async () => {
      const sourceId = await createCompletedDepreciation("ac10-dep", 2024);
      const row = await createApplicationRevision(prisma, sourceId, ownerId);
      trackApp(row.id);

      const child = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: row.id },
      });
      const { applicationId: _applicationId, ...rest } = child;

      expect(fingerprintRow(rest)).toEqual(
        fingerprintRow({
          applicationYear: 2024,
          annualTotalKm: new Prisma.Decimal("3000.0"),
          snapshotVehiclePrice: null,
          snapshotUsefulLifeYears: null,
          snapshotAnnualDepreciation: null,
          snapshotOfficialKm: null,
          snapshotAnnualTotalKm: null,
          snapshotRatio: null,
          snapshotRawAmount: null,
          calculatedAt: null,
          depreciationParameterVersionId: null,
          snapshotEstimatedAnnualKm: null,
          snapshotPerKmUnitPrice: null,
        })
      );
      expect(child.annualTotalKm?.toFixed(1)).toBe("3000.0");
    });
  });

  // =========================================================================
  // T5 service 層守門（§3.2 步驟 4／5）
  //
  // 誠實揭露：AC-13（來源守門之**端點層** 409 回應與 details 形狀）歸 **T7**，
  // 不在本 Task 之 AC 清單內。但 §3.2 步驟 4／5 是修正版流程本身的一部分，
  // 而「歷史不可變」要求 service 在被直接呼叫時亦不得對草稿／已作廢／已有修
  // 正版之來源產出複本——若把守門全部推到端點層，本 service 就成了一個「呼
  // 叫即複製」的未設防原語。故守門實作於本檔，並在此以最小斷言鎖住其行為
  // （零寫入 ＋ AppError 之 code／details）；T7 屆時只需在端點層加上 HTTP 面
  // 之斷言，無須改動本檔既有判定。
  //
  // TDD 紀律之誠實記載：本區塊之斷言是在守門實作**之後**補寫的（守門原為實
  // 作 §3.2 步驟 4／5 時一併寫下）。為補上「先紅」之鑑別力證據，已逐一以
  // mutant 實跑驗證（停用任一守門 → 對應 it 必紅），結果記於 Handoff。
  // =========================================================================

  describe("T5 service 守門：非 COMPLETED 來源與既有修正版（AC-13 之端點層斷言歸 T7）", () => {
    // SF-1（T5R，即審 REQUEST_CHANGES）：本 Task 原 27 筆測試對「§3.2 步驟 6
    // 之 FOR UPDATE 行鎖」**零覆蓋**——reviewer 實跑 mutant「移除
    // application-revision.ts:360 之行鎖」，27 筆全綠。該行鎖並非可有可無的
    // 效能設計，而是上方「已有修正版 → 409 + details.existingRevisionId」這
    // 條確定性語意的前提：無鎖時兩個併發呼叫會雙雙讀到「無修正版」而各建一
    // 筆，敗方由 `supersedesId @unique` 拋原生 P2002 → 500，且該原生錯誤之
    // 日誌含絕對路徑（洩漏面）。
    //
    // 自然時序併發測試**不加**：T3R 之 reviewer M1 實測其鑑別力不穩定（12
    // 輪僅 4 紅）——兩個併發呼叫常因 DB 往返時間差而恰巧仍序列化，運氣好就
    // 綠。故沿 `phase9-void.test.ts:897`（T3R SF-1(a)，已背書）之結構性守門
    // 形狀：讀原始碼、比對關鍵陳述式之字元位置。行鎖被移除、被搬出交易、或
    // 交易被拆成兩個，皆必紅。
    it("SF-1 結構性守門：FOR UPDATE 早於讀取與寫入、位於單一 $transaction 回呼內（行鎖移除／交易拆分之 mutant 必紅）", () => {
      const srcPath = new URL("../../src/applications/application-revision.ts", import.meta.url);
      const src = fs.readFileSync(srcPath, "utf8");

      // 全檔恰一次 $transaction(...)——防「拆交易」mutant：若鎖與建立被拆進
      // 兩個獨立交易，鎖會在建立前釋放，D7 之 0..1 保護即失效，即使各自看起
      // 來仍「有交易」。
      const txCallOccurrences = src.split("prisma.$transaction(").length - 1;
      expect(txCallOccurrences).toBe(1);

      const txCallIdx = src.indexOf("prisma.$transaction(");
      // 以逐字完整片語比對真實呼叫，而非檔頭文件散文之同名片語——本檔檔頭
      // 「併發與鎖」段落含「`SELECT ... FOR UPDATE`」「`FOR UPDATE` 取的是列
      // 鎖」等說明文字，單獨比對 "FOR UPDATE" 會誤命中而使守門恆綠（沿
      // phase9-void.test.ts:905-909 之同型警示）。
      const forUpdateIdx = src.indexOf('WHERE "id" = ${sourceId} FOR UPDATE');
      const findIdx = src.indexOf("tx.application.findUniqueOrThrow(");
      const createIdx = src.indexOf("tx.application.create(");

      expect(txCallIdx).toBeGreaterThan(-1);
      expect(forUpdateIdx).toBeGreaterThan(-1);
      expect(findIdx).toBeGreaterThan(-1);
      expect(createIdx).toBeGreaterThan(-1);

      // 皆位於 $transaction(...) 回呼內部（交易之後）——結合上方「恰一次」之
      // 計數，排除鎖／建立被移到交易外、或另立第二個交易之 mutant。
      expect(txCallIdx).toBeLessThan(forUpdateIdx);
      expect(txCallIdx).toBeLessThan(createIdx);

      // §3.2 步驟 6：鎖早於新鮮讀取（讀取須在鎖生效之後，否則守門讀到的可能
      // 是過期狀態）與寫入。
      expect(forUpdateIdx).toBeLessThan(findIdx);
      expect(forUpdateIdx).toBeLessThan(createIdx);

      // 讀取早於建立（讀了才判、判完才寫）。
      expect(findIdx).toBeLessThan(createIdx);
    });

    it("草稿來源 → CONFLICT ＋ details.status=DRAFT，且零新增 Application", async () => {
      const draft = await prisma.application.create({
        data: {
          type: "TRAVEL",
          status: "DRAFT",
          ownerId,
          createdById: ownerId,
          primaryDate: new Date("2026-05-01T00:00:00.000Z"),
          travel: { create: { tripDate: new Date("2026-05-01T00:00:00.000Z") } },
        },
      });
      trackApp(draft.id);

      const countBefore = await prisma.application.count({ where: { ownerId } });
      await expect(createApplicationRevision(prisma, draft.id, ownerId)).rejects.toMatchObject({
        code: "CONFLICT",
        httpStatus: 409,
        details: { status: "DRAFT" },
      });
      expect(await prisma.application.count({ where: { ownerId } })).toBe(countBefore);
    });

    it("已作廢來源 → CONFLICT ＋ details.status=VOIDED，且零新增 Application", async () => {
      const sourceId = await createCompletedTravel("guard-voided");
      await prisma.application.update({
        where: { id: sourceId },
        data: {
          status: "VOIDED",
          voidReason: "測試作廢原因",
          voidedAt: new Date(),
          voidedById: ownerId,
        },
      });

      const countBefore = await prisma.application.count({ where: { ownerId } });
      await expect(createApplicationRevision(prisma, sourceId, ownerId)).rejects.toMatchObject({
        code: "CONFLICT",
        httpStatus: 409,
        details: { status: "VOIDED" },
      });
      expect(await prisma.application.count({ where: { ownerId } })).toBe(countBefore);
    });

    it("已有修正版 → CONFLICT ＋ details.existingRevisionId，且零新增 Application（D7：0..1）", async () => {
      const sourceId = await createCompletedTravel("guard-existing");
      const first = await createApplicationRevision(prisma, sourceId, ownerId);
      trackApp(first.id);

      const countBefore = await prisma.application.count({ where: { ownerId } });
      await expect(createApplicationRevision(prisma, sourceId, adminId)).rejects.toMatchObject({
        code: "CONFLICT",
        httpStatus: 409,
        details: { existingRevisionId: first.id },
      });
      expect(await prisma.application.count({ where: { ownerId } })).toBe(countBefore);
    });
  });

  // =========================================================================
  // AC-11
  // =========================================================================

  describe("AC-11: 原申請零改動（逐欄 ＋ 產物雙層）", () => {
    it("AC-11(a): 原 Application／三型子列／TripSegment 逐欄逐位元組不變（含 updatedAt 未被 touch）", async () => {
      const travelId = await createCompletedTravel("ac11a-travel");
      const maintenanceId = await createCompletedMaintenance("ac11a-mnt");
      const depreciationId = await createCompletedDepreciation("ac11a-dep", 2023);

      const includeShape = {
        travel: { include: { segments: { orderBy: { sortOrder: "asc" as const } } } },
        maintenance: true,
        depreciation: true,
      };

      const beforeTravel = await prisma.application.findUniqueOrThrow({
        where: { id: travelId },
        include: includeShape,
      });
      const beforeMaintenance = await prisma.application.findUniqueOrThrow({
        where: { id: maintenanceId },
        include: includeShape,
      });
      const beforeDepreciation = await prisma.application.findUniqueOrThrow({
        where: { id: depreciationId },
        include: includeShape,
      });

      for (const sourceId of [travelId, maintenanceId, depreciationId]) {
        const row = await createApplicationRevision(prisma, sourceId, adminId);
        trackApp(row.id);
      }

      const afterTravel = await prisma.application.findUniqueOrThrow({
        where: { id: travelId },
        include: includeShape,
      });
      const afterMaintenance = await prisma.application.findUniqueOrThrow({
        where: { id: maintenanceId },
        include: includeShape,
      });
      const afterDepreciation = await prisma.application.findUniqueOrThrow({
        where: { id: depreciationId },
        include: includeShape,
      });

      // 父列：零排除鍵（updatedAt 亦在比對集合內——原列不得被 touch；毫秒級
      // 鑑別由 fingerprintRow 之 Date→toISOString 語意保證，見上方註解）。
      expect(fingerprintRow(afterTravel)).toEqual(fingerprintRow(beforeTravel));
      expect(fingerprintRow(afterMaintenance)).toEqual(fingerprintRow(beforeMaintenance));
      expect(fingerprintRow(afterDepreciation)).toEqual(fingerprintRow(beforeDepreciation));

      // updatedAt 毫秒級逐值相等（顯式，避免 JSON.stringify 巢狀比對之可讀性
      // 損失掩蓋此一關鍵斷言）。
      expect(afterTravel.updatedAt.toISOString()).toBe(beforeTravel.updatedAt.toISOString());
      expect(afterMaintenance.updatedAt.toISOString()).toBe(
        beforeMaintenance.updatedAt.toISOString()
      );
      expect(afterDepreciation.updatedAt.toISOString()).toBe(
        beforeDepreciation.updatedAt.toISOString()
      );

      // 三段 TripSegment 整列指紋（含各自 updatedAt）逐段比對。
      const beforeSegments = beforeTravel.travel?.segments ?? [];
      const afterSegments = afterTravel.travel?.segments ?? [];
      expect(afterSegments).toHaveLength(3);
      for (const [index, segment] of afterSegments.entries()) {
        expect(fingerprintRow(segment as unknown as Record<string, unknown>)).toEqual(
          fingerprintRow(beforeSegments[index] as unknown as Record<string, unknown>)
        );
      }
    });

    it("AC-11(b): 原附件列五欄（id／storageKey／refId／status／linkedAt）逐欄不變", async () => {
      const sourceId = await createCompletedTravel("ac11b");
      const sourceSegments = await prisma.tripSegment.findMany({
        where: { travelApplicationId: sourceId },
        orderBy: { sortOrder: "asc" },
      });

      const linkedAt = new Date("2026-03-14T02:03:04.567Z");
      for (const [index, segment] of sourceSegments.entries()) {
        const attachment = await prisma.attachment.create({
          data: {
            status: "LINKED",
            storageKey: `att/p9t5-${RUN_ID}-ac11b/${index}.jpg`,
            mimeType: "image/jpeg",
            byteSize: 2048 + index,
            originalFilename: `ac11b-${index}.jpg`,
            uploaderId: ownerId,
            ownerId,
            refType: "TRIP_SEGMENT",
            refId: segment.id,
            linkedAt,
          },
        });
        createdAttachmentIds.push(attachment.id);
      }

      const before = await prisma.attachment.findMany({
        where: { id: { in: createdAttachmentIds } },
        orderBy: { storageKey: "asc" },
        select: { id: true, storageKey: true, refId: true, status: true, linkedAt: true },
      });
      expect(before).toHaveLength(3);

      const row = await createApplicationRevision(prisma, sourceId, adminId);
      trackApp(row.id);

      const after = await prisma.attachment.findMany({
        where: { id: { in: createdAttachmentIds } },
        orderBy: { storageKey: "asc" },
        select: { id: true, storageKey: true, refId: true, status: true, linkedAt: true },
      });

      expect(after.map((a) => fingerprintRow(a))).toEqual(before.map((a) => fingerprintRow(a)));
    });

    it("AC-11(c): 原 Report 七欄不變且其 PDF 位元組 SHA-256 前後相同（逐位元組實證）", async () => {
      const sourceId = await createCompletedTravel("ac11c");

      const storage = new LocalVolumeStorage(reportStorageRoot, { prefixes: ["rpt"] });
      const storageKey = `rpt/p9t5-${RUN_ID}-ac11c/pdf`;
      const bytes = Buffer.concat([
        Buffer.from("%PDF-1.7\n", "latin1"),
        crypto.randomBytes(512),
        Buffer.from("\n%%EOF\n", "latin1"),
      ]);
      await storage.put(storageKey, bytes, "application/pdf");
      const hashBefore = crypto.createHash("sha256").update(bytes).digest("hex");

      const report = await prisma.report.create({
        data: {
          applicationId: sourceId,
          reportNumber: `TRV-202603-${RUN_ID.slice(0, 4)}`,
          numberPrefix: "TRV",
          numberPeriod: "202603",
          sequence: 1,
          storageKey,
          fileName: `TRV-202603-${RUN_ID.slice(0, 4)}.pdf`,
          byteSize: bytes.length,
          contentHash: hashBefore,
          generatedById: ownerId,
        },
      });

      const REPORT_KEY_COLUMNS = {
        reportNumber: true,
        storageKey: true,
        fileName: true,
        byteSize: true,
        contentHash: true,
        generatedAt: true,
        generatedById: true,
      } as const;

      const before = await prisma.report.findUniqueOrThrow({
        where: { id: report.id },
        select: REPORT_KEY_COLUMNS,
      });

      const row = await createApplicationRevision(prisma, sourceId, adminId);
      trackApp(row.id);

      const after = await prisma.report.findUniqueOrThrow({
        where: { id: report.id },
        select: REPORT_KEY_COLUMNS,
      });
      expect(fingerprintRow(after)).toEqual(fingerprintRow(before));

      // 逐位元組實證：重新自 storage 讀回並雜湊（非以「列未變」替代）。
      const raw = await storage.get(storageKey);
      const readBack = Buffer.isBuffer(raw) ? raw : Buffer.from([]);
      expect(readBack.length).toBe(bytes.length);
      const hashAfter = crypto.createHash("sha256").update(readBack).digest("hex");
      expect(hashAfter).toBe(hashBefore);
    });
  });
});

// ===========================================================================
// PHASE-009-T7 — 修正版端點（AC-12／AC-13／AC-26）
//
// ---------------------------------------------------------------------------
// 規範出處（Spec `docs/specs/PHASE-009.md`，逐條原文）
// ---------------------------------------------------------------------------
// AC-12（:185）：(a) 新申請之 `supersedesId` ＝原申請 `id`；(b) 查詢**原**申請
//   詳情 → 回應含 `supersededBy: { id, status, primaryDate }`（修正版存在時）
//   ／`null`（不存在時）；查詢**修正版**詳情 → 回應含
//   `supersedes: { id, status, primaryDate, reportNumber | null }`。(c) 兩向皆
//   為**單一 `supersedesId` 欄位**之投影，不另存反向欄位（單一事實來源）。
// AC-13（:187）：(a) 來源為草稿 → 409 `CONFLICT` ＋ `details.status="DRAFT"`；
//   (b) 來源為已作廢 → 409 ＋ `details.status="VOIDED"`；(c) 原申請**已有**修
//   正版 → 409 ＋ `details.existingRevisionId`；(d) 三者皆零寫入、零附件複
//   製、零 storage 寫入。
// AC-26（:219）：(b) 管理員代建立修正版 → 沿用既有
//   `APPLICATION_CREATED_ON_BEHALF`（**不新增第二個 enum 值**），`summary` 含
//   `{ applicationId, type, revisionOf }`；(c) **本人**建立修正版 → **零稽核
//   列**（沿 PHASE-004 AC-86 之 `userId !== actorId` 判定）。
// §7.3：`POST /applications/:id/revision` Body 無（一律忽略）；
//   201 `{ "application": <新草稿之型別分派 DTO；supersedes 非 null> }`。
//
// ---------------------------------------------------------------------------
// 本檔 T7 區塊之分工（授權矩陣與錯誤表逐格屬 `phase9-contract.test.ts`）
// ---------------------------------------------------------------------------
// AC-23（修正版端點 5 格）與 AC-27（§7.5 錯誤表逐格）之落點為
// `phase9-contract.test.ts` 之 T7 區塊（沿 T4 作廢端點之同一分工：契約面集中
// 於 contract 檔，行為面留在各功能檔）。本區塊只涵蓋 AC-12／AC-13／AC-26 之
// **行為**，以及 Packet FW-1（單一入口）與 FW-6（併發雙建）之鑑別性守門。
//
// ---------------------------------------------------------------------------
// Mutant 自證（暫改後復原，不入最終 diff；結果記於 Handoff）
// ---------------------------------------------------------------------------
//   ① 稽核 hook 對本人也傳入（移除 `actorId !== ownerId` 判定）
//      → 「AC-26(c) 本人建立零稽核列」必紅。
//   ② route 改呼叫 `createApplicationRevision`（而非
//      `createApplicationRevisionWithAttachments`）→「FW-1 單一入口」必紅
//      （修正版容器零附件）。
//   ③ AC-12 之雙向投影另存反向欄位 → AC-12(c) 之欄位集合封閉斷言必紅。
//
// 紀律：合成資料；loginName 前綴 `p9t7_`；清理僅限本區塊自建 id。
// ===========================================================================

describeWithDb(
  "PHASE-009-T7 修正版端點 POST /applications/:id/revision（AC-12／AC-13／AC-26）",
  () => {
    const T7_PREFIX = "p9t7_";
    let prisma: PrismaClient;
    let app: FastifyInstance;
    let storage: LocalVolumeStorage;
    let attachmentRoot: string;
    let reportRoot: string;

    let ownerId: string;
    let ownerLoginName: string;
    let ownerCookie: string;
    let adminId: string;
    let adminLoginName: string;
    let adminCookie: string;

    const t7ApplicationIds: string[] = [];
    const t7UserIds: string[] = [];
    let attachmentSeq = 0;

    function track(id: string): string {
      t7ApplicationIds.push(id);
      return id;
    }

    /** storage root 之全部相對路徑（零 storage 寫入之全等比對用）。 */
    function listStorageFiles(root: string): string[] {
      if (!fs.existsSync(root)) return [];
      const out: string[] = [];
      function walk(dir: string): void {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out.push(path.relative(root, full).split(path.sep).join("/"));
        }
      }
      walk(root);
      return out.sort();
    }

    async function login(loginName: string): Promise<string> {
      const resp = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { loginName, password: PASSWORD },
      });
      if (resp.statusCode !== 200) {
        throw new Error(`login failed: ${resp.statusCode} ${resp.body}`);
      }
      const raw = resp.headers["set-cookie"];
      const str = Array.isArray(raw) ? raw[0] : (raw as string);
      return str.split(";")[0];
    }

    async function createUser(
      suffix: string,
      role: "USER" | "ADMIN"
    ): Promise<{ id: string; loginName: string; cookie: string }> {
      const loginName = `${T7_PREFIX}${suffix}_${RUN_ID}`;
      const user = await prisma.user.create({
        data: {
          loginName,
          displayName: `T7 ${suffix}`,
          passwordHash: await hashPassword(PASSWORD),
          role,
          isActive: true,
          // T3 假綠教訓：fixture 一律顯式指定，不倚賴 schema 預設。
          mustChangePassword: false,
        },
      });
      t7UserIds.push(user.id);
      return { id: user.id, loginName, cookie: await login(loginName) };
    }

    async function seedCompletedTravel(suffix: string, segmentCount = 2): Promise<string> {
      const created = await prisma.application.create({
        data: {
          type: "TRAVEL",
          status: "COMPLETED",
          ownerId,
          createdById: ownerId,
          primaryDate: new Date("2026-03-15T00:00:00.000Z"),
          totalAmount: 1500,
          completedAt: new Date("2026-03-15T08:00:00.000Z"),
          travel: {
            create: {
              tripDate: new Date("2026-03-15T00:00:00.000Z"),
              purpose: `T7 出差-${suffix}`,
              fuelUnitPrice: "2.3456",
              etcUnitPrice: "1.2345",
              snapshotTotalKm: "160.00",
              snapshotRawAmount: "1500.0000",
              calculatedAt: new Date("2026-03-15T08:00:00.000Z"),
              segments: {
                create: Array.from({ length: segmentCount }, (_, index) => ({
                  sortOrder: index,
                  origin: `起-${index}`,
                  destination: `迄-${index}`,
                  totalKm: "80.00",
                  highwayKm: "60.00",
                })),
              },
            },
          },
        },
      });
      return track(created.id);
    }

    async function seedCompletedMaintenance(suffix: string): Promise<string> {
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
              actualCost: `1000.0${suffix.length % 10}`,
              snapshotIntervalKm: "500.00",
              snapshotOfficialKm: "150.00",
              snapshotRatio: "0.300000",
              snapshotRawAmount: "300.0000",
              calculatedAt: new Date("2026-04-01T08:00:00.000Z"),
            },
          },
        },
      });
      return track(created.id);
    }

    async function seedCompletedDepreciation(year: number): Promise<string> {
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
      return track(created.id);
    }

    /** 合成一筆 LINKED 附件（位元組 ＋ DB 列），供 FW-1 單一入口守門使用。 */
    async function seedAttachment(refId: string, payload: string): Promise<string> {
      const storageId = `p9t7${RUN_ID}${attachmentSeq++}`;
      const storageKey = `att/${storageId}/original`;
      const bytes = Buffer.from(`T7-ORIGINAL:${payload}`, "utf8");
      await storage.put(storageKey, bytes, "image/jpeg");
      const row = await prisma.attachment.create({
        data: {
          status: "LINKED",
          storageKey,
          thumbnailKey: null,
          mimeType: "image/jpeg",
          byteSize: bytes.length,
          originalFilename: `t7-${payload}.jpg`,
          uploaderId: ownerId,
          ownerId,
          refType: "TRIP_SEGMENT",
          refId,
          linkedAt: new Date("2026-03-01T01:02:03.456Z"),
        },
      });
      return row.id;
    }

    async function postRevision(id: string, cookie: string, payload?: unknown) {
      return app.inject({
        method: "POST",
        url: `/applications/${id}/revision`,
        headers: { cookie },
        ...(payload === undefined ? {} : { payload }),
      });
    }

    async function getTravelDetail(id: string, cookie: string) {
      const resp = await app.inject({
        method: "GET",
        url: `/applications/travel/${id}`,
        headers: { cookie },
      });
      expect(resp.statusCode).toBe(200);
      return (resp.json() as { application: Record<string, unknown> }).application;
    }

    beforeAll(async () => {
      if (!DB_URL) return;
      prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
      await prisma.$connect();

      attachmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase9-t7-att-"));
      reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase9-t7-rpt-"));
      storage = new LocalVolumeStorage(attachmentRoot, { prefixes: ["att"] });

      app = await buildServer({
        databaseUrl: DB_URL,
        storageRoot: attachmentRoot,
        reportStorageRoot: reportRoot,
        logLevel: "error",
      });
      await app.ready();

      const owner = await createUser("owner", "USER");
      ownerId = owner.id;
      ownerLoginName = owner.loginName;
      ownerCookie = owner.cookie;
      const admin = await createUser("admin", "ADMIN");
      adminId = admin.id;
      adminLoginName = admin.loginName;
      adminCookie = admin.cookie;
    });

    afterAll(async () => {
      if (!prisma) return;
      await app.close();
      if (t7UserIds.length > 0) {
        await prisma.attachment.deleteMany({ where: { ownerId: { in: t7UserIds } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: t7UserIds } } });
        await prisma.auditLog.deleteMany({ where: { targetId: { in: t7UserIds } } });
      }
      await prisma.report.deleteMany({ where: { applicationId: { in: t7ApplicationIds } } });
      // 修正版（supersedesId → 原申請，onDelete: Restrict）必須先於原申請刪除。
      for (const id of [...t7ApplicationIds].reverse()) {
        await prisma.application.deleteMany({ where: { supersedesId: id } });
      }
      for (const id of [...t7ApplicationIds].reverse()) {
        await prisma.application.deleteMany({ where: { id } });
      }
      if (t7UserIds.length > 0) {
        await prisma.session.deleteMany({ where: { userId: { in: t7UserIds } } });
        await prisma.user.deleteMany({ where: { id: { in: t7UserIds } } });
      }
      await prisma.$disconnect();
      for (const root of [attachmentRoot, reportRoot]) {
        try {
          fs.rmSync(root, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    });

    // =========================================================================
    // AC-12 — 版本關聯之保存與雙向可見
    // =========================================================================

    describe("AC-12: 版本關聯之保存與雙向可見（單一 supersedesId 之雙向投影）", () => {
      it("AC-12(a): 端點 201 且新列 supersedesId ＝原申請 id；回應之 supersedes 非 null（§7.3）", async () => {
        const sourceId = await seedCompletedTravel("ac12a");
        const resp = await postRevision(sourceId, ownerCookie);

        expect(resp.statusCode).toBe(201);
        const body = resp.json() as {
          application: {
            id: string;
            status: string;
            supersedes: { id: string; status: string; primaryDate: string; reportNumber: unknown };
            supersededBy: unknown;
          };
        };
        track(body.application.id);

        expect(body.application.status).toBe("DRAFT");
        expect(body.application.supersedes).not.toBeNull();
        expect(body.application.supersedes.id).toBe(sourceId);
        expect(body.application.supersededBy).toBeNull();

        const row = await prisma.application.findUniqueOrThrow({
          where: { id: body.application.id },
          select: { supersedesId: true, ownerId: true, createdById: true },
        });
        expect(row.supersedesId).toBe(sourceId);
        expect(row.ownerId).toBe(ownerId);
        expect(row.createdById).toBe(ownerId);
      });

      it("AC-12(b) 原申請側: 建立前 supersededBy 為 null；建立後為 { id, status, primaryDate } 三鍵封閉", async () => {
        const sourceId = await seedCompletedTravel("ac12b-src");

        const before = await getTravelDetail(sourceId, ownerCookie);
        expect(before.supersededBy).toBeNull();

        const resp = await postRevision(sourceId, ownerCookie);
        expect(resp.statusCode).toBe(201);
        const revisionId = (resp.json() as { application: { id: string } }).application.id;
        track(revisionId);

        const after = await getTravelDetail(sourceId, ownerCookie);
        expect(after.supersededBy).toEqual({
          id: revisionId,
          status: "DRAFT",
          // 修正版之 primaryDate 由複製後之 tripDate 推導（2026-03-15）。
          primaryDate: "2026-03-15",
        });
        // 原申請本身不是任何人的修正版。
        expect(after.supersedes).toBeNull();
      });

      it("AC-12(b) 修正版側: supersedes 為 { id, status, primaryDate, reportNumber } 四鍵封閉——原申請有報表時為其編號，無報表時為 null", async () => {
        // (1) 原申請**無**報表 → reportNumber 為 null。
        const plainSourceId = await seedCompletedTravel("ac12b-noreport");
        const plainResp = await postRevision(plainSourceId, ownerCookie);
        expect(plainResp.statusCode).toBe(201);
        const plainRevisionId = (plainResp.json() as { application: { id: string } }).application
          .id;
        track(plainRevisionId);

        const plainDetail = await getTravelDetail(plainRevisionId, ownerCookie);
        expect(plainDetail.supersedes).toEqual({
          id: plainSourceId,
          status: "COMPLETED",
          primaryDate: "2026-03-15",
          reportNumber: null,
        });

        // (2) 原申請**有**報表 → reportNumber 逐字為該編號。
        const reportedSourceId = await seedCompletedTravel("ac12b-report");
        const reportNumber = `TRV-209901-${RUN_ID.slice(0, 4)}`;
        await prisma.report.create({
          data: {
            applicationId: reportedSourceId,
            reportNumber,
            numberPrefix: "TRV",
            numberPeriod: "209901",
            sequence: 1,
            storageKey: `rpt/${RUN_ID}-t7/pdf`,
            fileName: `${reportNumber}.pdf`,
            byteSize: 10,
            contentHash: "0".repeat(64),
            generatedById: ownerId,
          },
        });

        const reportedResp = await postRevision(reportedSourceId, ownerCookie);
        expect(reportedResp.statusCode).toBe(201);
        const reportedRevisionId = (reportedResp.json() as { application: { id: string } })
          .application.id;
        track(reportedRevisionId);

        const reportedDetail = await getTravelDetail(reportedRevisionId, ownerCookie);
        expect(reportedDetail.supersedes).toEqual({
          id: reportedSourceId,
          status: "COMPLETED",
          primaryDate: "2026-03-15",
          reportNumber,
        });
      });

      it("AC-12(c) 單一事實來源: Application 無任何反向關聯欄位（information_schema 封閉掃描），且刪除修正版後原申請之 supersededBy 自動回 null", async () => {
        const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'Application'
      `;
        const names = columns.map((c) => c.column_name).sort();
        expect(names).toContain("supersedesId");
        // 反向欄位一律不存在（AC-12(c)：不另存反向欄位）。
        for (const forbidden of ["supersededById", "supersededBy", "revisionId", "revisionOfId"]) {
          expect(names).not.toContain(forbidden);
        }

        // 投影而非儲存之行為實證：修正版被刪除後，原申請之 supersededBy 立即
        // 回到 null（若曾另存反向欄位，該欄位會殘留為 dangling 值）。
        const sourceId = await seedCompletedTravel("ac12c");
        const resp = await postRevision(sourceId, ownerCookie);
        expect(resp.statusCode).toBe(201);
        const revisionId = (resp.json() as { application: { id: string } }).application.id;

        expect((await getTravelDetail(sourceId, ownerCookie)).supersededBy).not.toBeNull();
        await prisma.application.delete({ where: { id: revisionId } });
        expect((await getTravelDetail(sourceId, ownerCookie)).supersededBy).toBeNull();
      });

      it("AC-12: 保養與折舊兩型之端點成功與雙向投影（型別分派逐型別覆蓋）", async () => {
        const maintenanceId = await seedCompletedMaintenance("ac12-mnt");
        const maintenanceResp = await postRevision(maintenanceId, ownerCookie);
        expect(maintenanceResp.statusCode).toBe(201);
        const maintenanceRevision = (
          maintenanceResp.json() as {
            application: { id: string; type: string; supersedes: { id: string } };
          }
        ).application;
        track(maintenanceRevision.id);
        expect(maintenanceRevision.type).toBe("MAINTENANCE");
        expect(maintenanceRevision.supersedes.id).toBe(maintenanceId);

        const depreciationId = await seedCompletedDepreciation(2098);
        const depreciationResp = await postRevision(depreciationId, ownerCookie);
        expect(depreciationResp.statusCode).toBe(201);
        const depreciationRevision = (
          depreciationResp.json() as {
            application: { id: string; type: string; supersedes: { id: string } };
          }
        ).application;
        track(depreciationRevision.id);
        expect(depreciationRevision.type).toBe("DEPRECIATION");
        expect(depreciationRevision.supersedes.id).toBe(depreciationId);

        // 原申請側之反向投影（兩型各一）。
        const maintenanceDetail = await app.inject({
          method: "GET",
          url: `/applications/maintenance/${maintenanceId}`,
          headers: { cookie: ownerCookie },
        });
        expect(maintenanceDetail.statusCode).toBe(200);
        expect(
          (maintenanceDetail.json() as { application: { supersededBy: { id: string } } })
            .application.supersededBy.id
        ).toBe(maintenanceRevision.id);

        const depreciationDetail = await app.inject({
          method: "GET",
          url: `/applications/depreciation/${depreciationId}`,
          headers: { cookie: ownerCookie },
        });
        expect(depreciationDetail.statusCode).toBe(200);
        expect(
          (depreciationDetail.json() as { application: { supersededBy: { id: string } } })
            .application.supersededBy.id
        ).toBe(depreciationRevision.id);
      });
    });

    // =========================================================================
    // AC-13 — 來源守門（三種 409 ＋ 零寫入零 storage 寫入）
    // =========================================================================

    describe("AC-13: 修正版之來源守門（三種 409 逐格 ＋ (d) 零寫入、零附件複製、零 storage 寫入）", () => {
      it("AC-13(a): 來源為草稿 → 409 CONFLICT ＋ details.status='DRAFT'，零寫入零 storage 寫入", async () => {
        const draft = await prisma.application.create({
          data: {
            type: "TRAVEL",
            status: "DRAFT",
            ownerId,
            createdById: ownerId,
            primaryDate: new Date("2026-05-01T00:00:00.000Z"),
            travel: { create: { tripDate: new Date("2026-05-01T00:00:00.000Z") } },
          },
        });
        track(draft.id);

        const appsBefore = await prisma.application.count({ where: { ownerId } });
        const attachmentsBefore = await prisma.attachment.count({ where: { ownerId } });
        const filesBefore = listStorageFiles(attachmentRoot);

        const resp = await postRevision(draft.id, ownerCookie);
        expect(resp.statusCode).toBe(409);
        const body = resp.json() as { error: { code: string; message: string; details: unknown } };
        expect(body.error.code).toBe("CONFLICT");
        expect(body.error.details).toEqual({ status: "DRAFT" });
        expect(body.error.message).toBe("僅已完成之申請可建立修正版");

        expect(await prisma.application.count({ where: { ownerId } })).toBe(appsBefore);
        expect(await prisma.attachment.count({ where: { ownerId } })).toBe(attachmentsBefore);
        expect(listStorageFiles(attachmentRoot)).toEqual(filesBefore);
      });

      it("AC-13(b): 來源為已作廢 → 409 CONFLICT ＋ details.status='VOIDED'，零寫入零 storage 寫入", async () => {
        const sourceId = await seedCompletedTravel("ac13b");
        const voidResp = await app.inject({
          method: "POST",
          url: `/applications/${sourceId}/void`,
          headers: { cookie: ownerCookie },
          payload: { reason: "T7 AC-13(b) 來源作廢" },
        });
        expect(voidResp.statusCode).toBe(200);

        const appsBefore = await prisma.application.count({ where: { ownerId } });
        const attachmentsBefore = await prisma.attachment.count({ where: { ownerId } });
        const filesBefore = listStorageFiles(attachmentRoot);

        const resp = await postRevision(sourceId, ownerCookie);
        expect(resp.statusCode).toBe(409);
        const body = resp.json() as { error: { code: string; message: string; details: unknown } };
        expect(body.error.code).toBe("CONFLICT");
        expect(body.error.details).toEqual({ status: "VOIDED" });
        expect(body.error.message).toBe("僅已完成之申請可建立修正版");

        expect(await prisma.application.count({ where: { ownerId } })).toBe(appsBefore);
        expect(await prisma.attachment.count({ where: { ownerId } })).toBe(attachmentsBefore);
        expect(listStorageFiles(attachmentRoot)).toEqual(filesBefore);
      });

      it("AC-13(c): 原申請已有修正版 → 409 CONFLICT ＋ details.existingRevisionId（D7：0..1），零寫入零 storage 寫入", async () => {
        const sourceId = await seedCompletedTravel("ac13c", 1);
        const segments = await prisma.tripSegment.findMany({
          where: { travelApplicationId: sourceId },
          select: { id: true },
        });
        await seedAttachment(segments[0].id, "ac13c");

        const first = await postRevision(sourceId, ownerCookie);
        expect(first.statusCode).toBe(201);
        const firstRevisionId = (first.json() as { application: { id: string } }).application.id;
        track(firstRevisionId);

        const appsBefore = await prisma.application.count({ where: { ownerId } });
        const attachmentsBefore = await prisma.attachment.count({ where: { ownerId } });
        const filesBefore = listStorageFiles(attachmentRoot);

        const resp = await postRevision(sourceId, adminCookie);
        expect(resp.statusCode).toBe(409);
        const body = resp.json() as { error: { code: string; message: string; details: unknown } };
        expect(body.error.code).toBe("CONFLICT");
        expect(body.error.details).toEqual({ existingRevisionId: firstRevisionId });
        expect(body.error.message).toBe("此申請已有修正版");

        // (d) 零寫入、零附件複製、零 storage 寫入（全等比對，非「數量未增」）。
        expect(await prisma.application.count({ where: { ownerId } })).toBe(appsBefore);
        expect(await prisma.attachment.count({ where: { ownerId } })).toBe(attachmentsBefore);
        expect(listStorageFiles(attachmentRoot)).toEqual(filesBefore);
        // 失敗之第二次呼叫亦零稽核列（管理員身分）。
        expect(
          await prisma.auditLog.count({
            where: { actorId: adminId, action: "APPLICATION_CREATED_ON_BEHALF" },
          })
        ).toBe(0);
      });

      it("FW-6 併發雙建（T1 FW 落地）: 兩個併發 POST 恰一個 201、一個 409，且 DB 恰一筆修正版", async () => {
        const sourceId = await seedCompletedTravel("concurrent", 1);

        const [a, b] = await Promise.all([
          postRevision(sourceId, ownerCookie),
          postRevision(sourceId, ownerCookie),
        ]);
        const codes = [a.statusCode, b.statusCode].sort();
        expect(codes).toEqual([201, 409]);

        const winner = a.statusCode === 201 ? a : b;
        const loser = a.statusCode === 201 ? b : a;
        const winnerId = (winner.json() as { application: { id: string } }).application.id;
        track(winnerId);

        // 敗方之 409 形狀與序列化情形完全一致（`details.existingRevisionId` 指
        // 向勝方；行鎖失效時之 P2002 兜底亦須映射為同一形狀）。
        const loserBody = loser.json() as { error: { code: string; details: unknown } };
        expect(loserBody.error.code).toBe("CONFLICT");
        expect(loserBody.error.details).toEqual({ existingRevisionId: winnerId });

        const revisions = await prisma.application.findMany({
          where: { supersedesId: sourceId },
          select: { id: true },
        });
        expect(revisions.map((r) => r.id)).toEqual([winnerId]);
      });
    });

    // =========================================================================
    // AC-26 — 代操作稽核
    // =========================================================================

    describe("AC-26: 代操作稽核（(b) 管理員代建沿用既有 enum；(c) 本人零稽核列）", () => {
      it("AC-26(b): 管理員代建 → 恰一筆 APPLICATION_CREATED_ON_BEHALF，actorId＝管理員、targetId＝擁有人、summary 三鍵封閉 { applicationId, type, revisionOf }", async () => {
        const sourceId = await seedCompletedTravel("ac26b");
        const before = await prisma.auditLog.count({ where: { actorId: adminId } });

        const resp = await postRevision(sourceId, adminCookie);
        expect(resp.statusCode).toBe(201);
        const revision = (resp.json() as { application: { id: string; ownerId: string } })
          .application;
        track(revision.id);

        // AD-US-09①：新草稿之擁有人恆為原使用者。
        expect(revision.ownerId).toBe(ownerId);
        const row = await prisma.application.findUniqueOrThrow({
          where: { id: revision.id },
          select: { ownerId: true, createdById: true },
        });
        expect(row.ownerId).toBe(ownerId);
        expect(row.createdById).toBe(adminId);

        const audits = await prisma.auditLog.findMany({
          where: { actorId: adminId, action: "APPLICATION_CREATED_ON_BEHALF" },
        });
        expect(audits).toHaveLength(1);
        expect(await prisma.auditLog.count({ where: { actorId: adminId } })).toBe(before + 1);
        expect(audits[0].targetId).toBe(ownerId);
        expect(audits[0].targetLabel).toBe(`${ownerLoginName}#${revision.id}`);
        const summary = audits[0].summary as Record<string, unknown>;
        expect(Object.keys(summary).sort()).toEqual(["applicationId", "revisionOf", "type"]);
        expect(summary).toEqual({
          applicationId: revision.id,
          type: "TRAVEL",
          revisionOf: sourceId,
        });
      });

      it("AC-26(b) 不新增第二個 enum 值: AuditAction 之十值集合逐字不變（修正版稽核沿用既有 APPLICATION_CREATED_ON_BEHALF）", async () => {
        const rows = await prisma.$queryRaw<Array<{ label: string }>>`
        SELECT e.enumlabel AS label
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'AuditAction' AND n.nspname = current_schema()
      `;
        expect(rows.map((r) => r.label).sort()).toEqual(
          [
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
          ].sort()
        );
      });

      it("AC-26(c): 本人建立修正版 → 零稽核列（沿 PHASE-004 AC-86 之 userId !== actorId 判定；hook 對本人也寫之 mutant 必紅）", async () => {
        const sourceId = await seedCompletedTravel("ac26c");
        const before = await prisma.auditLog.count({ where: { actorId: ownerId } });

        const resp = await postRevision(sourceId, ownerCookie);
        expect(resp.statusCode).toBe(201);
        const revisionId = (resp.json() as { application: { id: string } }).application.id;
        track(revisionId);

        expect(await prisma.auditLog.count({ where: { actorId: ownerId } })).toBe(before);
        // 針對**這一筆**修正版之精確比對（`targetLabel` ＝ `{loginName}#{id}`）
        // ——不以「全域零列」比對，否則會被同一套件之 AC-26(b) 代建列汙染。
        expect(
          await prisma.auditLog.count({
            where: {
              action: "APPLICATION_CREATED_ON_BEHALF",
              targetLabel: `${ownerLoginName}#${revisionId}`,
            },
          })
        ).toBe(0);
      });

      // T7R SF-1（即審 REQUEST_CHANGES）：上面兩則無法鑑別「判定基準是
      // `actorId !== ownerId`（正確）還是 `role === 'ADMIN'`（錯誤）」——前者
      // 之 fixture 恆為 USER 擁有人 × ADMIN 操作者，後者恆為 USER × 本人，兩
      // 種判定在這兩組資料上結論相同，mutant「isOnBehalf = role === 'ADMIN'」
      // 因而存活（實測 65/65 全綠）。唯一能區分兩者的資料點是
      // **ADMIN 對自己擁有之申請操作**：`actorId === ownerId` → 零稽核（正
      // 確）；`role === 'ADMIN'` → 寫一筆（錯誤）。
      //
      // 專案既定標準（三處先例）：`phase4-admin-on-behalf` 系列／PHASE-006
      // 保養代操作／PHASE-007 折舊代操作三個測試檔皆各有一則「管理員對自己
      // 代建立 → 零稽核列」之專屬 it（`admin/routes.ts:495-498` 之 C3 邊界註
      // 解逐字記載此語意）。本則即該標準於修正版端點之落地。
      it("AC-26(c) C3 邊界: 管理員對**自己擁有**之申請建立修正版 → 201 且零稽核列（判定基準為 actorId !== ownerId，非 role === 'ADMIN'——角色判定之 mutant 必紅）", async () => {
        const adminOwnSource = await prisma.application.create({
          data: {
            type: "TRAVEL",
            status: "COMPLETED",
            // 擁有人與建立者皆為管理員本人——這是唯一能區分「本人判定」與
            // 「角色判定」的資料形狀。
            ownerId: adminId,
            createdById: adminId,
            primaryDate: new Date("2026-03-15T00:00:00.000Z"),
            totalAmount: 1500,
            completedAt: new Date("2026-03-15T08:00:00.000Z"),
            travel: {
              create: {
                tripDate: new Date("2026-03-15T00:00:00.000Z"),
                purpose: "T7R 管理員自有申請",
              },
            },
          },
        });
        track(adminOwnSource.id);

        const before = await prisma.auditLog.count({ where: { actorId: adminId } });

        const resp = await postRevision(adminOwnSource.id, adminCookie);
        expect(resp.statusCode).toBe(201);
        const revisionId = (resp.json() as { application: { id: string } }).application.id;
        track(revisionId);

        // 新草稿之擁有人與建立者皆仍為管理員本人（非代操作）。
        const row = await prisma.application.findUniqueOrThrow({
          where: { id: revisionId },
          select: { ownerId: true, createdById: true, supersedesId: true },
        });
        expect(row.ownerId).toBe(adminId);
        expect(row.createdById).toBe(adminId);
        expect(row.supersedesId).toBe(adminOwnSource.id);

        // 零稽核列：全域計數未增 ＋ 針對這一筆之 targetLabel 精確比對
        // （沿 AC-26(c) 既有手法，防同套件之 AC-26(b) 代建列汙染）。
        expect(await prisma.auditLog.count({ where: { actorId: adminId } })).toBe(before);
        expect(
          await prisma.auditLog.count({
            where: {
              action: "APPLICATION_CREATED_ON_BEHALF",
              targetLabel: `${adminLoginName}#${revisionId}`,
            },
          })
        ).toBe(0);
      });
    });

    // =========================================================================
    // FW-1（Packet 逐條核銷第 1 項）—— production 單一入口
    // =========================================================================

    describe("FW-1 單一入口: 端點必經 createApplicationRevisionWithAttachments（附件位元組隨修正版複製）", () => {
      it("原申請段附件 → 修正版對應段有新列、新 storageKey、位元組逐位元組相同（route 改呼叫 createApplicationRevision 之 mutant 必紅）", async () => {
        const sourceId = await seedCompletedTravel("fw1", 1);
        const sourceSegments = await prisma.tripSegment.findMany({
          where: { travelApplicationId: sourceId },
          orderBy: { sortOrder: "asc" },
          select: { id: true },
        });
        await seedAttachment(sourceSegments[0].id, "fw1-payload");
        const sourceAttachment = await prisma.attachment.findFirstOrThrow({
          where: { refType: "TRIP_SEGMENT", refId: sourceSegments[0].id, status: "LINKED" },
        });

        const resp = await postRevision(sourceId, ownerCookie);
        expect(resp.statusCode).toBe(201);
        const revisionId = (resp.json() as { application: { id: string } }).application.id;
        track(revisionId);

        const revisionSegments = await prisma.tripSegment.findMany({
          where: { travelApplicationId: revisionId },
          orderBy: { sortOrder: "asc" },
          select: { id: true },
        });
        expect(revisionSegments).toHaveLength(1);

        const copies = await prisma.attachment.findMany({
          where: { refType: "TRIP_SEGMENT", refId: revisionSegments[0].id, status: "LINKED" },
        });
        expect(copies).toHaveLength(1);
        const copy = copies[0];
        expect(copy.storageKey).not.toBe(sourceAttachment.storageKey);
        // AC-14(a)：擁有人沿用原附件；上傳者＝實際操作者。
        expect(copy.ownerId).toBe(ownerId);
        expect(copy.uploaderId).toBe(ownerId);

        const originalBytes = await storage.get(sourceAttachment.storageKey);
        const copiedBytes = await storage.get(copy.storageKey);
        const hash = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("hex");
        expect(hash(copiedBytes as Buffer)).toBe(hash(originalBytes as Buffer));
      });
    });

    // =========================================================================
    // §7.3 —— Body 一律忽略
    // =========================================================================

    it("§7.3: 修正版端點之 body 一律忽略（夾帶任意鍵仍 201，且不影響新列欄位）——故 §7.5 之 400 一格對本端點不適用", async () => {
      const sourceId = await seedCompletedTravel("body-ignored");
      const resp = await postRevision(sourceId, ownerCookie, {
        ownerId: adminId,
        status: "COMPLETED",
        totalAmount: 999999,
        supersedesId: "偽造關聯",
        reason: "夾帶鍵",
      });
      expect(resp.statusCode).toBe(201);
      const revisionId = (resp.json() as { application: { id: string } }).application.id;
      track(revisionId);

      const row = await prisma.application.findUniqueOrThrow({
        where: { id: revisionId },
        select: { ownerId: true, status: true, totalAmount: true, supersedesId: true },
      });
      expect(row.ownerId).toBe(ownerId);
      expect(row.status).toBe("DRAFT");
      expect(row.totalAmount).toBeNull();
      expect(row.supersedesId).toBe(sourceId);
    });
  }
);
