/**
 * PHASE-008-T4 — `report-data.ts`（報表資料組裝；三型、LEGACY 雙軌、封閉白
 * 名單、零重算）
 *
 * ---------------------------------------------------------------------------
 * 規範出處（Spec `docs/specs/PHASE-008.md`）
 * ---------------------------------------------------------------------------
 * §2.D AC-17（LEGACY 快照雙軌，零重算）：
 *   (a) 差旅——舊模型列（`fuelParameterVersionId != null` 且
 *       `fuelPriceVersionId == null`）呈現快照油資／ETC 單價原值，新三欄
 *       （油種／每公升油價／車輛油耗）為 `null`；新模型列完整呈現五值。
 *   (b) 折舊——舊模型列（`snapshotPerKmUnitPrice != null` 且
 *       `snapshotAnnualTotalKm == null`）呈現折舊每公里單價原值＋年度公務里
 *       程＋金額，新三欄為 `null`；新模型列呈現 AC-18 之五值。
 *   (c) 零重算——LEGACY fixture 以 raw SQL 播種；金額與單價逐字等於快照；
 *       資料組裝檔零算式（結構性掃描：零 `.times(`／`.div(`／`.plus(`／
 *       `.minus(`）；spy 斷言零呼叫計算引擎；任一重算之 mutant 必紅。
 * §2.D AC-18（折舊揭露面）：
 *   (a) 五值精度：annualDepreciation 2dp／annualTotalKm 1dp／ratioPercent
 *       百分比 4dp／officialKm 2dp／totalAmount 整數。
 *   (b) 負向全身分一致：車價／折舊年限／預估年里程／參數版本 id 之字面與鍵
 *       集皆不出現於輸出（本人與管理員各一次）。
 *   (c) 對帳說明以三來源值呈現；`rawAmount` 之 4dp 字面不出現。
 * §2.D AC-19（保養四值＋實際費用＋證明；零重算）。
 * §2.F AC-27（資料側）：`ReportData` 輸出型別封閉白名單；折舊分支不得含
 *   `vehiclePrice`／`usefulLifeYears`／`estimatedAnnualKm`／
 *   `depreciationParameterVersionId`。
 * §8.4：新舊模型判別條件逐字沿用 PHASE-005a／PHASE-007。
 *
 * ---------------------------------------------------------------------------
 * TDD 紅燈證據（見 Task Handoff 完整輸出）
 * ---------------------------------------------------------------------------
 * 本檔於 `backend/src/reports/report-data.ts` 已存在（前次連線中斷前之半成
 * 品）之狀態下續寫；為維持「先紅後綠」之可驗證性，紅燈證據改以**暫時移走
 * 實作檔＋重新命名擋 tsc**的方式重建（見 Handoff 之 mv/restore 紀錄），而非
 * 依賴「實作原就不存在」的自然紅——效果等價：本檔案的每個 `it` 在缺少
 * `report-data.ts` 時全數因 `Cannot find module`／型別缺席而失敗。
 *
 * ---------------------------------------------------------------------------
 * AC-18(b)「本人與管理員各一次」之落地說明（實作決策揭露，交複審）
 * ---------------------------------------------------------------------------
 * `buildReportData` 刻意**不接受 actor 參數**——授權判定屬 routes.ts（T9/T10）
 * 之職責，資料組裝層對任何呼叫者一視同仁。這正是「全身分一致」在資料層的
 * 正確安全性質：沒有分支可以讓管理員身分多看到欄位。下方 AC-18(b) 因而拆成
 * 兩個具名 `it`（「擁有人本人」／「管理員」），斷言同一次 `buildReportData`
 * 呼叫之輸出——因為資料組裝層結構上只有一條路徑，兩個身分經過的正是同一段
 * 程式碼；測試以兩個具名區塊呈現，對應 Spec §12 AC-18 映射表逐字要求之「本
 * 人＋管理員各一次」，同時如實揭露資料層並無 actor 分支的事實。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as depreciationCalculation from "../../src/applications/depreciation-calculation.js";
import * as maintenanceCalculation from "../../src/applications/maintenance-calculation.js";
import * as travelCalculation from "../../src/applications/travel-calculation.js";
import { hashPassword } from "../../src/auth/password.js";
import * as depreciationEngine from "../../src/parameters/depreciation-engine.js";
import * as fuelPriceEngine from "../../src/parameters/fuel-price-engine.js";
import {
  type ReportApplicationRecord,
  type ReportData,
  type ReportMeta,
  buildReportData,
  reportApplicationInclude,
} from "../../src/reports/report-data.js";
import {
  insertDraftDepreciationRowRaw,
  insertLegacyDepreciationRowRaw,
} from "../fixtures/depreciation-legacy-row.js";
import { insertLegacyTravelRowRaw } from "../fixtures/travel-legacy-row.js";

// ── 五個計算引擎之 spy 包裝（真實實作原樣保留；沿 phase7-snapshot-immutability
//    /phase7-depreciation-complete 之既有慣例：`vi.fn(actual.fn)`）───────────
vi.mock("../../src/applications/travel-calculation.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/applications/travel-calculation.js")>();
  return { ...actual, calculateTravel: vi.fn(actual.calculateTravel) };
});
vi.mock("../../src/applications/maintenance-calculation.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/applications/maintenance-calculation.js")>();
  return { ...actual, calculateMaintenance: vi.fn(actual.calculateMaintenance) };
});
vi.mock("../../src/applications/depreciation-calculation.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/applications/depreciation-calculation.js")>();
  return { ...actual, calculateDepreciation: vi.fn(actual.calculateDepreciation) };
});
vi.mock("../../src/parameters/depreciation-engine.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/parameters/depreciation-engine.js")>();
  return { ...actual, deriveAnnualDepreciation: vi.fn(actual.deriveAnnualDepreciation) };
});
vi.mock("../../src/parameters/fuel-price-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/parameters/fuel-price-engine.js")>();
  return { ...actual, deriveFuelUnitPrice: vi.fn(actual.deriveFuelUnitPrice) };
});

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DATA_SRC_PATH = path.resolve(__dirname, "../../src/reports/report-data.ts");

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "ReportDataTestFixture99!";

const REPORT_META: ReportMeta = {
  reportNumber: "DEP-202608-0001",
  generatedAt: new Date("2026-08-06T03:00:00.000Z"),
};

// ---------------------------------------------------------------------------
// 結構性掃描（不需 DB，任何環境皆執行；沿 depreciation-calculation.test.ts 等
// 既有檔之 blankCommentsAndStrings 手法）
// ---------------------------------------------------------------------------

function blankCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += blank(src[i]);
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "`") {
      out += " ";
      i++;
      while (i < n && src[i] !== "`") {
        out += blank(src[i]);
        i++;
      }
      out += " ";
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out += " ";
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += blank(src[i]);
        i++;
      }
      out += " ";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

describe("PHASE-008-T4 — report-data.ts 結構性掃描（AC-17(c)：金額路徑零算式）", () => {
  it("AC-17(c): report-data.ts 原始碼零 .times(/.div(/.plus(/.minus(", () => {
    const src = blankCommentsAndStrings(fs.readFileSync(REPORT_DATA_SRC_PATH, "utf8"));
    expect(src).not.toMatch(/\.times\(/);
    expect(src).not.toMatch(/\.div\(/);
    expect(src).not.toMatch(/\.plus\(/);
    expect(src).not.toMatch(/\.minus\(/);
  });
});

// ---------------------------------------------------------------------------
// AC-27：三型 body 之封閉鍵集（供多處測試複用）
// ---------------------------------------------------------------------------

// PHASE-009-T10 機械連動（§8.5 第四類，§15 T10「機械連動預授權」明文）：
// `ReportCommon` 依 AC-19 受控擴充一鍵 `void`（七鍵 → 八鍵）。此處僅重錨定基
// 線鍵集，鑑別性（`toEqual` 全等、多一鍵必紅）零弱化；三型 body 鍵集逐字不變。
const COMMON_KEYS = [
  "reportNumber",
  "generatedAt",
  "ownerDisplayName",
  "typeLabel",
  "statusLabel",
  "createdAt",
  "totalAmount",
  "void",
].sort();

const TRAVEL_KEYS = [
  "model",
  "tripDate",
  "purpose",
  "segments",
  "totalKm",
  "preRoundingTotal",
  "fuelUnitPrice",
  "etcUnitPrice",
  "fuelType",
  "fuelPricePerLiter",
  "fuelConsumption",
].sort();

const MAINTENANCE_KEYS = [
  "lastMaintenanceDate",
  "currentMaintenanceDate",
  "lastOdometerKm",
  "currentOdometerKm",
  "intervalKm",
  "officialKm",
  "ratioPercent",
  "actualCost",
  "companyAmount",
  "attachments",
].sort();

const DEPRECIATION_KEYS = [
  "model",
  "applicationYear",
  "annualDepreciation",
  "annualTotalKm",
  "ratioPercent",
  "perKmUnitPrice",
  "officialKm",
  "attachments",
].sort();

/** AC-18(b)(c) 之負向斷言：折舊禁列（逐鍵 + 逐值字面）皆不出現。 */
function assertDepreciationForbiddenFieldsAbsent(
  data: ReportData,
  forbiddenLiterals: readonly string[]
): void {
  expect(data.kind).toBe("DEPRECIATION");
  if (data.kind !== "DEPRECIATION") throw new Error("unreachable");
  expect(Object.keys(data.depreciation).sort()).toEqual(DEPRECIATION_KEYS);
  const serialized = JSON.stringify(data);
  for (const literal of forbiddenLiterals) {
    expect(serialized).not.toContain(literal);
  }
  // 鍵名負向斷言（非僅頂層值）：禁列欄位縱使被藏入巢狀結構（例如
  // attachments[i]）亦須被攔下，故直接掃描序列化字串之鍵名字面。
  for (const key of [
    '"vehiclePrice"',
    '"usefulLifeYears"',
    '"estimatedAnnualKm"',
    '"depreciationParameterVersionId"',
  ]) {
    expect(serialized).not.toContain(key);
  }
}

// ---------------------------------------------------------------------------
// Fixture 資料（DB）
// ---------------------------------------------------------------------------

describeWithDb("PHASE-008-T4 — buildReportData（AC-17／AC-18／AC-19／AC-27）", () => {
  let prisma: PrismaClient;
  let ownerId: string;

  let travelCurrentId: string;
  let travelLegacyId: string;
  let maintenanceId: string;
  let depreciationCurrentId: string;
  let depreciationLegacyId: string;

  // SF-2（段—圖對應 + LINKED 過濾）之逐段附件識別碼。
  let segment0LinkedAttachmentId: string;
  let segment1LinkedAttachmentId: string;
  let segment0NonLinkedFilename: string;
  let segment1NonLinkedFilename: string;

  const createdAttachmentIds: string[] = [];

  async function loadRecord(applicationId: string): Promise<ReportApplicationRecord> {
    return prisma.application.findUniqueOrThrow({
      where: { id: applicationId },
      include: reportApplicationInclude,
    });
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const owner = await prisma.user.create({
      data: {
        loginName: `p8t4_owner_${RUN_ID}`,
        displayName: "P8T4 擁有人",
        passwordHash: await hashPassword(PASSWORD),
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    ownerId = owner.id;

    // ── TRAVEL／CURRENT（AC-17(a) 新模型；五值皆非 null）───────────────────
    const travelCurrent = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-03-15T00:00:00.000Z"),
        totalAmount: 888,
        completedAt: new Date(),
        travel: {
          create: {
            tripDate: new Date("2026-03-15T00:00:00.000Z"),
            purpose: "CURRENT 差旅測試",
            fuelUnitPrice: "2.3456",
            etcUnitPrice: "1.2345",
            etcParameterVersionId: "current-etc-v1",
            fuelPriceVersionId: "current-fuel-price-v1",
            fuelConsumptionVersionId: "current-fuel-consum-v1",
            snapshotFuelType: "GASOLINE_95",
            snapshotFuelPricePerLiter: "31.5000",
            snapshotFuelConsumption: "15.2000",
            snapshotTotalKm: "150.75",
            snapshotRawAmount: "888.8888",
            calculatedAt: new Date(),
            segments: {
              create: [
                {
                  sortOrder: 0,
                  origin: "台北",
                  destination: "新竹",
                  totalKm: "100.50",
                  highwayKm: "80.00",
                  snapshotFuelAmount: "235.7448",
                  snapshotEtcAmount: "98.7600",
                  snapshotRawAmount: "334.5048",
                  snapshotAmount: 500,
                },
                {
                  sortOrder: 1,
                  origin: "新竹",
                  destination: "台中",
                  totalKm: "50.25",
                  highwayKm: "0.00",
                  snapshotFuelAmount: "117.8664",
                  snapshotEtcAmount: "0.0000",
                  snapshotRawAmount: "117.8664",
                  snapshotAmount: 388,
                },
              ],
            },
          },
        },
      },
    });
    travelCurrentId = travelCurrent.id;

    // ── SF-2：CURRENT 差旅兩段各播 1 張 LINKED 附件（可辨識檔名）＋1 張同
    //    refId 但 status="TEMP"（非 LINKED）之附件，佐證「段—圖對應」與
    //    「LINKED 過濾」皆有資料側覆蓋 ──────────────────────────────────────
    const [travelSegment0, travelSegment1] = await prisma.tripSegment.findMany({
      where: { travelApplicationId: travelCurrentId },
      orderBy: { sortOrder: "asc" },
    });
    segment0NonLinkedFilename = "segment0-temp-not-linked.jpg";
    segment1NonLinkedFilename = "segment1-temp-not-linked.jpg";
    const segment0Linked = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `att/p8t4-seg0-linked-${RUN_ID}/pdf-source.jpg`,
        mimeType: "image/jpeg",
        byteSize: 1111,
        originalFilename: "segment0-linked.jpg",
        uploaderId: ownerId,
        ownerId,
        refType: "TRIP_SEGMENT",
        refId: travelSegment0.id,
        linkedAt: new Date(),
      },
    });
    const segment0NonLinked = await prisma.attachment.create({
      data: {
        status: "TEMP",
        storageKey: `att/p8t4-seg0-temp-${RUN_ID}/pdf-source.jpg`,
        mimeType: "image/jpeg",
        byteSize: 1112,
        originalFilename: segment0NonLinkedFilename,
        uploaderId: ownerId,
        ownerId,
        refType: "TRIP_SEGMENT",
        refId: travelSegment0.id,
      },
    });
    const segment1Linked = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `att/p8t4-seg1-linked-${RUN_ID}/pdf-source.jpg`,
        mimeType: "image/jpeg",
        byteSize: 1113,
        originalFilename: "segment1-linked.jpg",
        uploaderId: ownerId,
        ownerId,
        refType: "TRIP_SEGMENT",
        refId: travelSegment1.id,
        linkedAt: new Date(),
      },
    });
    const segment1NonLinked = await prisma.attachment.create({
      data: {
        status: "TEMP",
        storageKey: `att/p8t4-seg1-temp-${RUN_ID}/pdf-source.jpg`,
        mimeType: "image/jpeg",
        byteSize: 1114,
        originalFilename: segment1NonLinkedFilename,
        uploaderId: ownerId,
        ownerId,
        refType: "TRIP_SEGMENT",
        refId: travelSegment1.id,
      },
    });
    segment0LinkedAttachmentId = segment0Linked.id;
    segment1LinkedAttachmentId = segment1Linked.id;
    createdAttachmentIds.push(
      segment0Linked.id,
      segment0NonLinked.id,
      segment1Linked.id,
      segment1NonLinked.id
    );

    // ── TRAVEL／LEGACY（AC-17(a) 舊模型；raw SQL 播種，AC-17(c)）───────────
    const travelLegacy = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2020-05-01T00:00:00.000Z"),
        totalAmount: 1200,
        completedAt: new Date(),
      },
    });
    travelLegacyId = travelLegacy.id;
    await insertLegacyTravelRowRaw(prisma, {
      applicationId: travelLegacyId,
      tripDate: new Date("2020-05-01T00:00:00.000Z"),
      purpose: "LEGACY 差旅測試",
      fuelUnitPrice: "3.5000",
      etcUnitPrice: "5.0000",
      fuelParameterVersionId: "legacy-fuel-param-v1",
      etcParameterVersionId: "legacy-etc-param-v1",
      snapshotTotalKm: "200.00",
      snapshotRawAmount: "1200.0000",
      calculatedAt: new Date(),
    });
    await prisma.tripSegment.create({
      data: {
        travelApplicationId: travelLegacyId,
        sortOrder: 0,
        origin: "高雄",
        destination: "台南",
        totalKm: "200.00",
        highwayKm: "150.00",
        snapshotFuelAmount: "700.0000",
        snapshotEtcAmount: "500.0000",
        snapshotRawAmount: "1200.0000",
        snapshotAmount: 1200,
      },
    });

    // ── MAINTENANCE（AC-19；無雙軌）────────────────────────────────────────
    const maintenance = await prisma.application.create({
      data: {
        type: "MAINTENANCE",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-04-01T00:00:00.000Z"),
        totalAmount: 1963,
        completedAt: new Date(),
        maintenance: {
          create: {
            lastMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
            currentMaintenanceDate: new Date("2026-04-01T00:00:00.000Z"),
            lastOdometerKm: "10000.00",
            currentOdometerKm: "10500.00",
            actualCost: "3000.00",
            snapshotIntervalKm: "500.00",
            snapshotOfficialKm: "300.00",
            snapshotRatio: "0.654321",
            snapshotRawAmount: "1963.0000",
            calculatedAt: new Date(),
          },
        },
      },
    });
    maintenanceId = maintenance.id;
    const maintenanceAttachment = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `att/p8t4-maint-${RUN_ID}/pdf-source.jpg`,
        mimeType: "image/jpeg",
        byteSize: 12345,
        originalFilename: "maintenance-proof.jpg",
        uploaderId: ownerId,
        ownerId,
        refType: "MAINTENANCE",
        refId: maintenanceId,
        linkedAt: new Date(),
      },
    });
    createdAttachmentIds.push(maintenanceAttachment.id);

    // ── DEPRECIATION／CURRENT（AC-18；五值 + 禁列）──────────────────────────
    const depreciationCurrent = await prisma.application.create({
      data: {
        type: "DEPRECIATION",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-12-31T00:00:00.000Z"),
        totalAmount: 60000,
        completedAt: new Date(),
        depreciation: {
          create: {
            applicationYear: 2026,
            annualTotalKm: "20000.0",
            snapshotVehiclePrice: "777777.77",
            snapshotUsefulLifeYears: 13,
            snapshotAnnualDepreciation: "120000.00",
            snapshotOfficialKm: "10000.00",
            snapshotAnnualTotalKm: "20000.0",
            snapshotRatio: "0.123457",
            snapshotRawAmount: "54321.9999",
            calculatedAt: new Date(),
            depreciationParameterVersionId: "secret-param-version-xyz",
          },
        },
      },
    });
    depreciationCurrentId = depreciationCurrent.id;
    const depreciationAttachment = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `att/p8t4-dep-${RUN_ID}/pdf-source.jpg`,
        mimeType: "image/jpeg",
        byteSize: 23456,
        originalFilename: "depreciation-proof.jpg",
        uploaderId: ownerId,
        ownerId,
        refType: "DEPRECIATION",
        refId: depreciationCurrentId,
        linkedAt: new Date(),
      },
    });
    createdAttachmentIds.push(depreciationAttachment.id);

    // ── DEPRECIATION／LEGACY（AC-17(b) 舊模型；raw SQL 播種）───────────────
    const depreciationLegacy = await prisma.application.create({
      data: {
        type: "DEPRECIATION",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2019-12-31T00:00:00.000Z"),
        totalAmount: 4938,
        completedAt: new Date(),
      },
    });
    depreciationLegacyId = depreciationLegacy.id;
    await insertLegacyDepreciationRowRaw(prisma, {
      applicationId: depreciationLegacyId,
      applicationYear: 2019,
      snapshotVehiclePrice: "555555.55",
      snapshotUsefulLifeYears: 9,
      snapshotEstimatedAnnualKm: 12345,
      snapshotPerKmUnitPrice: "12.3456",
      snapshotOfficialKm: "400.00",
      snapshotRawAmount: "4938.2400",
      calculatedAt: new Date(),
      depreciationParameterVersionId: "legacy-secret-param-version-abc",
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    if (createdAttachmentIds.length > 0) {
      await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
    }
    await prisma.application.deleteMany({
      where: {
        id: {
          in: [
            travelCurrentId,
            travelLegacyId,
            maintenanceId,
            depreciationCurrentId,
            depreciationLegacyId,
          ].filter(Boolean),
        },
      },
    });
    if (ownerId) {
      await prisma.session.deleteMany({ where: { userId: ownerId } });
      await prisma.user.delete({ where: { id: ownerId } });
    }
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // AC-17(a) 差旅雙軌
  // -------------------------------------------------------------------------

  it("AC-17(a): LEGACY 差旅 — 呈現快照油資/ETC 單價原值，新三欄為 null，零 NaN", async () => {
    const record = await loadRecord(travelLegacyId);
    const data = await buildReportData(prisma, record, REPORT_META);
    expect(data.kind).toBe("TRAVEL");
    if (data.kind !== "TRAVEL") throw new Error("unreachable");
    expect(data.travel.model).toBe("LEGACY");
    expect(data.travel.fuelUnitPrice).toBe("3.5000");
    expect(data.travel.etcUnitPrice).toBe("5.0000");
    expect(data.travel.fuelType).toBeNull();
    expect(data.travel.fuelPricePerLiter).toBeNull();
    expect(data.travel.fuelConsumption).toBeNull();
    expect(data.travel.totalKm).toBe("200.00");
    expect(data.travel.preRoundingTotal).toBe("1200.0000");
    expect(JSON.stringify(data)).not.toMatch(/NaN/);
  });

  it("AC-17(a): CURRENT 差旅 — 完整呈現五值（單價 + 油種/每公升油價/車輛油耗）", async () => {
    const record = await loadRecord(travelCurrentId);
    const data = await buildReportData(prisma, record, REPORT_META);
    expect(data.kind).toBe("TRAVEL");
    if (data.kind !== "TRAVEL") throw new Error("unreachable");
    expect(data.travel.model).toBe("CURRENT");
    expect(data.travel.fuelUnitPrice).toBe("2.3456");
    expect(data.travel.etcUnitPrice).toBe("1.2345");
    expect(data.travel.fuelType).toBe("GASOLINE_95");
    expect(data.travel.fuelPricePerLiter).toBe("31.5000");
    expect(data.travel.fuelConsumption).toBe("15.2000");
    expect(data.travel.totalKm).toBe("150.75");
    expect(data.travel.preRoundingTotal).toBe("888.8888");
    expect(data.travel.segments.map((s) => s.sortOrder)).toEqual([0, 1]);
    expect(data.travel.segments[0].segmentAmount).toBe(500);
    expect(data.travel.segments[1].segmentAmount).toBe(388);
    // report:null 通路（尚未產生報表仍可預覽，§7.3）
    const preview = await buildReportData(prisma, record, null);
    expect(preview.common.reportNumber).toBeNull();
    expect(preview.common.generatedAt).toBeNull();
  });

  it("AC-27/SF-2: 差旅段—圖對應 — 逐段恰為該段之 LINKED 附件，非 LINKED 者不出現，ReportImage 鍵集封閉", async () => {
    const record = await loadRecord(travelCurrentId);
    const data = await buildReportData(prisma, record, REPORT_META);
    expect(data.kind).toBe("TRAVEL");
    if (data.kind !== "TRAVEL") throw new Error("unreachable");
    const [segment0, segment1] = data.travel.segments;

    // ① 逐段 attachments[0].attachmentId 恰為該段者
    expect(segment0.attachments.map((a) => a.attachmentId)).toEqual([segment0LinkedAttachmentId]);
    expect(segment1.attachments.map((a) => a.attachmentId)).toEqual([segment1LinkedAttachmentId]);

    // ② 非 LINKED 者不出現（逐段長度恰 1，且可辨識檔名字面不出現於序列化輸出）
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(segment0NonLinkedFilename);
    expect(serialized).not.toContain(segment1NonLinkedFilename);

    // ③ ReportImage 鍵集封閉
    expect(Object.keys(segment0.attachments[0]).sort()).toEqual(
      ["attachmentId", "storageKey", "mimeType", "originalFilename", "dataUri", "missing"].sort()
    );
  });

  // -------------------------------------------------------------------------
  // AC-17(b) 折舊雙軌
  // -------------------------------------------------------------------------

  it("AC-17(b): LEGACY 折舊 — 呈現折舊每公里單價原值 + 年度公務里程，新三欄為 null", async () => {
    const record = await loadRecord(depreciationLegacyId);
    const data = await buildReportData(prisma, record, REPORT_META);
    expect(data.kind).toBe("DEPRECIATION");
    if (data.kind !== "DEPRECIATION") throw new Error("unreachable");
    expect(data.depreciation.model).toBe("LEGACY");
    expect(data.depreciation.perKmUnitPrice).toBe("12.3456");
    expect(data.depreciation.officialKm).toBe("400.00");
    expect(data.depreciation.annualDepreciation).toBeNull();
    expect(data.depreciation.annualTotalKm).toBeNull();
    expect(data.depreciation.ratioPercent).toBeNull();
    expect(data.common.totalAmount).toBe(4938);
    expect(JSON.stringify(data)).not.toMatch(/NaN/);
  });

  it("AC-17(b): CURRENT 折舊 — 呈現 AC-18 之五值，perKmUnitPrice 為 null", async () => {
    const record = await loadRecord(depreciationCurrentId);
    const data = await buildReportData(prisma, record, REPORT_META);
    expect(data.kind).toBe("DEPRECIATION");
    if (data.kind !== "DEPRECIATION") throw new Error("unreachable");
    expect(data.depreciation.model).toBe("CURRENT");
    expect(data.depreciation.perKmUnitPrice).toBeNull();
    expect(data.depreciation.annualDepreciation).toBe("120000.00");
    expect(data.depreciation.annualTotalKm).toBe("20000.0");
    expect(data.depreciation.officialKm).toBe("10000.00");
  });

  // -------------------------------------------------------------------------
  // AC-17(c) 零重算
  // -------------------------------------------------------------------------

  it("AC-17(c): buildReportData 全程零呼叫五個計算引擎；正控組證明 spy 有牙齒", async () => {
    const spies = [
      vi.mocked(travelCalculation.calculateTravel),
      vi.mocked(maintenanceCalculation.calculateMaintenance),
      vi.mocked(depreciationCalculation.calculateDepreciation),
      vi.mocked(depreciationEngine.deriveAnnualDepreciation),
      vi.mocked(fuelPriceEngine.deriveFuelUnitPrice),
    ];
    for (const s of spies) s.mockClear();

    await buildReportData(prisma, await loadRecord(travelCurrentId), REPORT_META);
    await buildReportData(prisma, await loadRecord(travelLegacyId), REPORT_META);
    await buildReportData(prisma, await loadRecord(maintenanceId), REPORT_META);
    await buildReportData(prisma, await loadRecord(depreciationCurrentId), REPORT_META);
    await buildReportData(prisma, await loadRecord(depreciationLegacyId), REPORT_META);

    for (const s of spies) expect(s).not.toHaveBeenCalled();

    // ── 鑑別力探針：spy 確實有牙齒（否則「零呼叫」可能只是沒接上）──────────
    travelCalculation.calculateTravel({
      segments: [],
      fuelUnitPrice: new Prisma.Decimal("1"),
      etcUnitPrice: new Prisma.Decimal("1"),
    });
    maintenanceCalculation.calculateMaintenance({
      lastOdometerKm: new Prisma.Decimal("0"),
      currentOdometerKm: new Prisma.Decimal("10"),
      officialKm: new Prisma.Decimal("5"),
      actualCost: new Prisma.Decimal("100"),
    });
    depreciationCalculation.calculateDepreciation({
      annualDepreciation: new Prisma.Decimal("100"),
      officialKm: new Prisma.Decimal("10"),
      annualTotalKm: new Prisma.Decimal("20"),
    });
    depreciationEngine.deriveAnnualDepreciation({ vehiclePrice: "10000", usefulLifeYears: 5 });
    fuelPriceEngine.deriveFuelUnitPrice("10", "5");

    for (const s of spies) expect(s).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // AC-18(a) 五值精度
  // -------------------------------------------------------------------------

  it("AC-18(a): CURRENT 折舊五值精度逐字 — 2dp/1dp/4dp%/2dp/整數", async () => {
    const record = await loadRecord(depreciationCurrentId);
    const data = await buildReportData(prisma, record, REPORT_META);
    expect(data.kind).toBe("DEPRECIATION");
    if (data.kind !== "DEPRECIATION") throw new Error("unreachable");
    expect(data.depreciation.annualDepreciation).toMatch(/^\d+\.\d{2}$/);
    expect(data.depreciation.annualTotalKm).toMatch(/^\d+\.\d$/);
    expect(data.depreciation.ratioPercent).toMatch(/^\d+\.\d{4}$/);
    expect(data.depreciation.officialKm).toMatch(/^\d+\.\d{2}$/);
    expect(Number.isInteger(data.common.totalAmount)).toBe(true);
    // 逐字值（snapshotRatio="0.123457" 純字串移位 → "12.3457"；刻意與
    // officialKm/annualTotalKm 之商（0.5）不同，佐證零重算——若實作誤用
    // officialKm÷annualTotalKm 重算比例，此斷言必紅）。
    expect(data.depreciation.annualDepreciation).toBe("120000.00");
    expect(data.depreciation.annualTotalKm).toBe("20000.0");
    expect(data.depreciation.ratioPercent).toBe("12.3457");
    expect(data.depreciation.officialKm).toBe("10000.00");
    expect(data.common.totalAmount).toBe(60000);
  });

  // -------------------------------------------------------------------------
  // AC-18(b) 折舊揭露面負向（本人／管理員；§12 映射表逐字兩具名區塊）
  // -------------------------------------------------------------------------

  const FORBIDDEN_LITERALS_CURRENT = ["777777.77", "secret-param-version-xyz"];
  const FORBIDDEN_LITERALS_LEGACY = ["555555.55", "12345", "legacy-secret-param-version-abc"];

  it("AC-18(b): 折舊資料組裝結果不含車價／年限／預估年里程／參數版本id — 擁有人本人檢視路徑（CURRENT）", async () => {
    const data = await buildReportData(
      prisma,
      await loadRecord(depreciationCurrentId),
      REPORT_META
    );
    assertDepreciationForbiddenFieldsAbsent(data, FORBIDDEN_LITERALS_CURRENT);
  });

  it("AC-18(b): 折舊資料組裝結果不含車價／年限／預估年里程／參數版本id — 管理員檢視路徑（CURRENT；同一函式無 actor 分支）", async () => {
    const data = await buildReportData(
      prisma,
      await loadRecord(depreciationCurrentId),
      REPORT_META
    );
    assertDepreciationForbiddenFieldsAbsent(data, FORBIDDEN_LITERALS_CURRENT);
  });

  it("AC-18(b): 折舊資料組裝結果不含車價／年限／預估年里程／參數版本id — 擁有人本人檢視路徑（LEGACY）", async () => {
    const data = await buildReportData(prisma, await loadRecord(depreciationLegacyId), REPORT_META);
    assertDepreciationForbiddenFieldsAbsent(data, FORBIDDEN_LITERALS_LEGACY);
  });

  it("AC-18(b): 折舊資料組裝結果不含車價／年限／預估年里程／參數版本id — 管理員檢視路徑（LEGACY；同一函式無 actor 分支）", async () => {
    const data = await buildReportData(prisma, await loadRecord(depreciationLegacyId), REPORT_META);
    assertDepreciationForbiddenFieldsAbsent(data, FORBIDDEN_LITERALS_LEGACY);
  });

  // -------------------------------------------------------------------------
  // AC-18(c) 對帳說明（三來源值；rawAmount 4dp 不出現）
  // -------------------------------------------------------------------------

  it("AC-18(c): 對帳列之三來源值皆在場，4dp rawAmount 字面不出現", async () => {
    const data = await buildReportData(
      prisma,
      await loadRecord(depreciationCurrentId),
      REPORT_META
    );
    expect(data.kind).toBe("DEPRECIATION");
    if (data.kind !== "DEPRECIATION") throw new Error("unreachable");
    // 三來源值（供 T5 呈現算式：annualDepreciation × officialKm ÷ annualTotalKm = totalAmount）
    expect(data.depreciation.annualDepreciation).not.toBeNull();
    expect(data.depreciation.officialKm).not.toBeNull();
    expect(data.depreciation.annualTotalKm).not.toBeNull();
    expect(data.common.totalAmount).not.toBeNull();
    // rawAmount（快照 snapshotRawAmount="54321.9999"）之 4dp 字面不出現
    expect(JSON.stringify(data)).not.toContain("54321.9999");
    // 型別上本就無 rawAmount 鍵（AC-27 封閉白名單，於此再度佐證）
    expect(Object.keys(data.depreciation)).not.toContain("rawAmount");
  });

  // -------------------------------------------------------------------------
  // AC-19 保養
  // -------------------------------------------------------------------------

  it("AC-19: 保養呈現四值 + 實際費用 + 全部證明（≥1），逐字取自快照，零重算", async () => {
    const record = await loadRecord(maintenanceId);
    const data = await buildReportData(prisma, record, REPORT_META);
    expect(data.kind).toBe("MAINTENANCE");
    if (data.kind !== "MAINTENANCE") throw new Error("unreachable");
    expect(data.maintenance.intervalKm).toBe("500.00");
    expect(data.maintenance.officialKm).toBe("300.00");
    expect(data.maintenance.ratioPercent).toBe("65.4321");
    expect(data.maintenance.actualCost).toBe("3000.00");
    expect(data.maintenance.companyAmount).toBe(1963);
    expect(data.maintenance.attachments.length).toBeGreaterThanOrEqual(1);
    expect(data.maintenance.attachments[0].originalFilename).toBe("maintenance-proof.jpg");
  });

  // -------------------------------------------------------------------------
  // SF-3：required() 大聲失敗（非靜默 passthrough）
  // -------------------------------------------------------------------------

  it("SF-3: 快照缺欄（status=COMPLETED 但折舊快照未寫入）— required() 顯式拋錯，訊息僅含欄名與 applicationId", async () => {
    const draftDepreciation = await prisma.application.create({
      data: {
        type: "DEPRECIATION",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-01-01T00:00:00.000Z"),
        totalAmount: 1,
        completedAt: new Date(),
      },
    });
    try {
      await insertDraftDepreciationRowRaw(prisma, draftDepreciation.id);
      const record = await loadRecord(draftDepreciation.id);
      await expect(buildReportData(prisma, record, REPORT_META)).rejects.toThrow(
        /missing required field/
      );
      // 錯誤訊息僅含欄名與 applicationId，無金額/快照值洩漏。
      await expect(buildReportData(prisma, record, REPORT_META)).rejects.toThrow(
        new RegExp(`"snapshotOfficialKm".*${draftDepreciation.id}`)
      );
    } finally {
      await prisma.application.delete({ where: { id: draftDepreciation.id } });
    }
  });

  // -------------------------------------------------------------------------
  // AC-27 封閉白名單（資料側，三型 + common）
  // -------------------------------------------------------------------------

  it("AC-27: ReportData 三型 body 與 common 之鍵集封閉（toEqual 全等，多一鍵必紅）", async () => {
    const travel = await buildReportData(prisma, await loadRecord(travelCurrentId), REPORT_META);
    expect(Object.keys(travel.common).sort()).toEqual(COMMON_KEYS);
    if (travel.kind !== "TRAVEL") throw new Error("unreachable");
    expect(Object.keys(travel.travel).sort()).toEqual(TRAVEL_KEYS);
    expect(Object.keys(travel.travel.segments[0]).sort()).toEqual(
      [
        "sortOrder",
        "origin",
        "destination",
        "totalKm",
        "highwayKm",
        "segmentAmount",
        "attachments",
      ].sort()
    );

    const maintenance = await buildReportData(prisma, await loadRecord(maintenanceId), REPORT_META);
    if (maintenance.kind !== "MAINTENANCE") throw new Error("unreachable");
    expect(Object.keys(maintenance.maintenance).sort()).toEqual(MAINTENANCE_KEYS);

    const depreciation = await buildReportData(
      prisma,
      await loadRecord(depreciationCurrentId),
      REPORT_META
    );
    if (depreciation.kind !== "DEPRECIATION") throw new Error("unreachable");
    expect(Object.keys(depreciation.depreciation).sort()).toEqual(DEPRECIATION_KEYS);
  });
});
