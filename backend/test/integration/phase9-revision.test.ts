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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplicationRevision } from "../../src/applications/application-revision.js";
import { hashPassword } from "../../src/auth/password.js";
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
