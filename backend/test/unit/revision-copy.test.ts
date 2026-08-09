/**
 * Unit tests for PHASE-009-T5 — 修正版複製之純函式建構器（零 DB、零時鐘）。
 *
 * Spec `docs/specs/PHASE-009.md`：
 *   §7.4「修正版欄位複製對照表（**唯一事實來源**；AC-10 逐欄斷言依此表）」
 *   AC-09（§2 :175）：新列 `status='DRAFT'`／`type` 同原申請／`ownerId` ＝原
 *     擁有人／`createdById` ＝實際操作者／`primaryDate` 由**複製後之業務欄
 *     位**經既有 `derive*PrimaryDate` 推導／`totalAmount`／`completedAt`／四
 *     個作廢欄皆 `NULL`。
 *   AC-10（§2 :177-:181）：三型「複製鍵集」與「禁複製鍵集」toEqual 封閉
 *     （多複製一欄必紅）。
 *
 * ── 為何鍵集清單以字面量寫在**測試檔**，而非自 src 匯入 ──────────────────
 * 若清單由 `application-revision.ts` 匯出、測試再拿它比對自己，則「實作多複
 * 製一欄」的 mutant 只要同時改清單就能維持綠燈——判定會退化為恆真。本檔的
 * 清單一律**逐字抄自 Spec §7.4 對照表**（見各常數上方之出處註解），與實作
 * 互為獨立事實來源；實作單獨多複製／少複製一欄時，`toEqual` 必紅。
 *
 * ── 「禁複製鍵集」之斷言語意 ────────────────────────────────────────────
 * §7.4 之「不複製」欄含兩類：
 *   (1) **恆不出現於建構結果**者（快照欄／參數版本引用欄／`totalAmount`／
 *       `completedAt`／三個作廢欄）——以「鍵不存在」斷言。
 *   (2) **出現但值不得取自原申請**者（`status` 恆 `DRAFT`／`createdById` ＝
 *       操作者／`supersedesId` ＝原申請 id／`primaryDate` 重新推導）——以
 *       「值 ≠ 原申請對應值」之逐項正向斷言涵蓋（見各型別之 it）。
 * 兩類合起來才是 §7.4「不複製」欄之完整落地，僅斷言鍵集封閉並不足夠。
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  buildDepreciationRevisionData,
  buildMaintenanceRevisionData,
  buildTravelRevisionData,
} from "../../src/applications/application-revision.js";

// ---------------------------------------------------------------------------
// Spec §7.4 逐字抄錄之鍵集常數
// ---------------------------------------------------------------------------

/**
 * 共通 `Application` 層之建構鍵集（三型一致）。
 * §7.4「共通 `Application`」列：複製 `type`／`ownerId`；`primaryDate` 重新推
 * 導；`status` 恆 `DRAFT`；`createdById` ＝操作者；`supersedesId` ＝原申請
 * id。加上型別專屬之子表巢狀鍵（`travel`／`maintenance`／`depreciation`）即
 * 為完整鍵集。
 */
const APPLICATION_LEVEL_KEYS = [
  "createdById",
  "ownerId",
  "primaryDate",
  "status",
  "supersedesId",
  "type",
];

/**
 * §7.4「共通 `Application`」列之「不複製」欄中，屬「恆不出現於建構結果」之
 * 鍵（AC-09 明文：`totalAmount`／`completedAt`／四個作廢欄皆 `NULL`——四欄
 * 含 `status`，此處列其餘三個持久化作廢欄）。
 */
const APPLICATION_LEVEL_FORBIDDEN_KEYS = [
  "completedAt",
  "totalAmount",
  "voidReason",
  "voidedAt",
  "voidedById",
];

/** §7.4「差旅」列之「複製」欄（子表層）＋ 段落巢狀鍵。 */
const TRAVEL_CHILD_KEYS = ["purpose", "segments", "tripDate"];

/** §7.4「差旅」列之「不複製」欄（`TravelApplication` 子表層，逐字）。 */
const TRAVEL_CHILD_FORBIDDEN_KEYS = [
  "calculatedAt",
  "etcParameterVersionId",
  "etcUnitPrice",
  "fuelConsumptionVersionId",
  "fuelParameterVersionId",
  "fuelPriceVersionId",
  "fuelUnitPrice",
  "snapshotFuelConsumption",
  "snapshotFuelPricePerLiter",
  "snapshotFuelType",
  "snapshotRawAmount",
  "snapshotTotalKm",
];

/** §7.4「差旅」列：每個 `TripSegment` 之複製欄。 */
const TRIP_SEGMENT_KEYS = ["destination", "highwayKm", "origin", "sortOrder", "totalKm"];

/** §7.4「差旅」列：段之四個快照欄（「一律不複製，新段恆為 `NULL`」）。 */
const TRIP_SEGMENT_FORBIDDEN_KEYS = [
  "snapshotAmount",
  "snapshotEtcAmount",
  "snapshotFuelAmount",
  "snapshotRawAmount",
];

/** §7.4「保養」列之「複製」欄。 */
const MAINTENANCE_CHILD_KEYS = [
  "actualCost",
  "currentMaintenanceDate",
  "currentOdometerKm",
  "lastMaintenanceDate",
  "lastOdometerKm",
];

/** §7.4「保養」列之「不複製」欄（五個快照欄，逐字）。 */
const MAINTENANCE_CHILD_FORBIDDEN_KEYS = [
  "calculatedAt",
  "snapshotIntervalKm",
  "snapshotOfficialKm",
  "snapshotRatio",
  "snapshotRawAmount",
];

/** §7.4「折舊」列之「複製」欄。 */
const DEPRECIATION_CHILD_KEYS = ["annualTotalKm", "applicationYear"];

/**
 * §7.4「折舊」列之「不複製」欄：「九個 `snapshot*` 欄／`calculatedAt`／
 * `depreciationParameterVersionId`／兩個凍結唯讀欄」——兩個凍結唯讀欄
 * （`snapshotEstimatedAnnualKm`／`snapshotPerKmUnitPrice`）本身即在九個
 * `snapshot*` 之內（schema.prisma:395-405 實查），故去重後為 11 個相異鍵。
 */
const DEPRECIATION_CHILD_FORBIDDEN_KEYS = [
  "calculatedAt",
  "depreciationParameterVersionId",
  "snapshotAnnualDepreciation",
  "snapshotAnnualTotalKm",
  "snapshotEstimatedAnnualKm",
  "snapshotOfficialKm",
  "snapshotPerKmUnitPrice",
  "snapshotRatio",
  "snapshotRawAmount",
  "snapshotUsefulLifeYears",
  "snapshotVehiclePrice",
];

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

const SOURCE_ID = "src-application-id";
const OWNER_ID = "owner-user-id";
const ACTOR_ID = "actor-admin-id";
const NOW = new Date("2026-08-07T09:30:00.000Z");

// ===========================================================================
// 差旅
// ===========================================================================

describe("AC-10: 三型「複製鍵集」與「禁複製鍵集」toEqual 封閉（多複製一欄必紅）— 差旅", () => {
  const source = {
    id: SOURCE_ID,
    ownerId: OWNER_ID,
    tripDate: new Date("2026-03-15T00:00:00.000Z"),
    purpose: "客戶拜訪",
    segments: [
      {
        sortOrder: 0,
        origin: "台北",
        destination: "新竹",
        totalKm: new Prisma.Decimal("80.50"),
        highwayKm: new Prisma.Decimal("60.00"),
      },
      {
        sortOrder: 1,
        origin: "新竹",
        destination: "台中",
        totalKm: new Prisma.Decimal("90.25"),
        highwayKm: new Prisma.Decimal("70.00"),
      },
    ],
  };

  it("Application 層鍵集恰為六鍵 ＋ travel 子鍵；五個禁複製鍵恆不出現", () => {
    const data = buildTravelRevisionData(source, ACTOR_ID, NOW);

    expect(sortedKeys(data)).toEqual([...APPLICATION_LEVEL_KEYS, "travel"].sort());
    for (const key of APPLICATION_LEVEL_FORBIDDEN_KEYS) {
      expect(Object.hasOwn(data, key)).toBe(false);
    }
  });

  it("TravelApplication 子層鍵集恰為三鍵；十二個禁複製鍵恆不出現", () => {
    const data = buildTravelRevisionData(source, ACTOR_ID, NOW);
    const child = data.travel.create;

    expect(sortedKeys(child)).toEqual([...TRAVEL_CHILD_KEYS].sort());
    for (const key of TRAVEL_CHILD_FORBIDDEN_KEYS) {
      expect(Object.hasOwn(child, key)).toBe(false);
    }
  });

  it("TripSegment 鍵集恰為五鍵；段快照四欄恆不出現；逐段保序且值逐欄相同", () => {
    const data = buildTravelRevisionData(source, ACTOR_ID, NOW);
    const segments = data.travel.create.segments.create;

    expect(segments).toHaveLength(2);
    for (const segment of segments) {
      expect(sortedKeys(segment)).toEqual([...TRIP_SEGMENT_KEYS].sort());
      for (const key of TRIP_SEGMENT_FORBIDDEN_KEYS) {
        expect(Object.hasOwn(segment, key)).toBe(false);
      }
    }

    // 保序（sortOrder 原序）＋ 值逐欄相同
    expect(segments.map((s) => s.sortOrder)).toEqual([0, 1]);
    expect(segments[0].origin).toBe("台北");
    expect(segments[0].destination).toBe("新竹");
    expect(segments[0].totalKm?.toFixed(2)).toBe("80.50");
    expect(segments[0].highwayKm?.toFixed(2)).toBe("60.00");
    expect(segments[1].origin).toBe("新竹");
    expect(segments[1].destination).toBe("台中");
    expect(segments[1].totalKm?.toFixed(2)).toBe("90.25");
    expect(segments[1].highwayKm?.toFixed(2)).toBe("70.00");
  });

  it("三型各一正向（差旅）：type/status/ownerId/createdById/supersedesId/primaryDate 之值逐項正確", () => {
    const data = buildTravelRevisionData(source, ACTOR_ID, NOW);

    expect(data.type).toBe("TRAVEL");
    expect(data.status).toBe("DRAFT");
    expect(data.ownerId).toBe(OWNER_ID);
    // createdById ＝操作者（≠ 原擁有人；管理員代建之情形）
    expect(data.createdById).toBe(ACTOR_ID);
    expect(data.supersedesId).toBe(SOURCE_ID);
    // primaryDate 由**複製後**之 tripDate 推導（derivePrimaryDate 既有規則）
    expect(data.primaryDate.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(data.travel.create.tripDate?.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(data.travel.create.purpose).toBe("客戶拜訪");
  });

  it("tripDate 為 null → primaryDate 退回 now 之 UTC 日粒度（derivePrimaryDate 既有 fallback），零時鐘（now 由參數注入）", () => {
    const data = buildTravelRevisionData(
      { ...source, tripDate: null, purpose: null, segments: [] },
      ACTOR_ID,
      NOW
    );

    expect(data.primaryDate.toISOString()).toBe("2026-08-07T00:00:00.000Z");
    expect(data.travel.create.tripDate).toBeNull();
    expect(data.travel.create.purpose).toBeNull();
    expect(data.travel.create.segments.create).toEqual([]);
  });

  it("純函式：同輸入兩次呼叫結果 toEqual（零時鐘、零隨機）", () => {
    expect(buildTravelRevisionData(source, ACTOR_ID, NOW)).toEqual(
      buildTravelRevisionData(source, ACTOR_ID, NOW)
    );
  });
});

// ===========================================================================
// 保養
// ===========================================================================

describe("AC-10: 三型「複製鍵集」與「禁複製鍵集」toEqual 封閉（多複製一欄必紅）— 保養", () => {
  const source = {
    id: SOURCE_ID,
    ownerId: OWNER_ID,
    lastMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
    currentMaintenanceDate: new Date("2026-04-01T00:00:00.000Z"),
    lastOdometerKm: new Prisma.Decimal("1000.00"),
    currentOdometerKm: new Prisma.Decimal("1500.00"),
    actualCost: new Prisma.Decimal("1000.00"),
  };

  it("Application 層鍵集恰為六鍵 ＋ maintenance 子鍵；五個禁複製鍵恆不出現", () => {
    const data = buildMaintenanceRevisionData(source, ACTOR_ID, NOW);

    expect(sortedKeys(data)).toEqual([...APPLICATION_LEVEL_KEYS, "maintenance"].sort());
    for (const key of APPLICATION_LEVEL_FORBIDDEN_KEYS) {
      expect(Object.hasOwn(data, key)).toBe(false);
    }
  });

  it("MaintenanceApplication 子層鍵集恰為五鍵；五個快照禁複製鍵恆不出現", () => {
    const child = buildMaintenanceRevisionData(source, ACTOR_ID, NOW).maintenance.create;

    expect(sortedKeys(child)).toEqual([...MAINTENANCE_CHILD_KEYS].sort());
    for (const key of MAINTENANCE_CHILD_FORBIDDEN_KEYS) {
      expect(Object.hasOwn(child, key)).toBe(false);
    }
  });

  it("三型各一正向（保養）：五個業務欄位逐欄複製；primaryDate 由 currentMaintenanceDate 推導", () => {
    const data = buildMaintenanceRevisionData(source, ACTOR_ID, NOW);

    expect(data.type).toBe("MAINTENANCE");
    expect(data.status).toBe("DRAFT");
    expect(data.ownerId).toBe(OWNER_ID);
    expect(data.createdById).toBe(ACTOR_ID);
    expect(data.supersedesId).toBe(SOURCE_ID);
    expect(data.primaryDate.toISOString()).toBe("2026-04-01T00:00:00.000Z");

    const child = data.maintenance.create;
    expect(child.lastMaintenanceDate?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(child.currentMaintenanceDate?.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(child.lastOdometerKm?.toFixed(2)).toBe("1000.00");
    expect(child.currentOdometerKm?.toFixed(2)).toBe("1500.00");
    expect(child.actualCost?.toFixed(2)).toBe("1000.00");
  });

  it("currentMaintenanceDate 為 null → primaryDate 退回 now 之 UTC 日粒度", () => {
    const data = buildMaintenanceRevisionData(
      {
        ...source,
        lastMaintenanceDate: null,
        currentMaintenanceDate: null,
        lastOdometerKm: null,
        currentOdometerKm: null,
        actualCost: null,
      },
      ACTOR_ID,
      NOW
    );

    expect(data.primaryDate.toISOString()).toBe("2026-08-07T00:00:00.000Z");
    expect(data.maintenance.create.actualCost).toBeNull();
  });
});

// ===========================================================================
// 折舊
// ===========================================================================

describe("AC-10: 折舊複製 applicationYear 與 annualTotalKm，九個快照欄與參數版本引用欄恆 NULL", () => {
  const source = {
    id: SOURCE_ID,
    ownerId: OWNER_ID,
    applicationYear: 2026,
    annualTotalKm: new Prisma.Decimal("3000.0"),
  };

  it("Application 層鍵集恰為六鍵 ＋ depreciation 子鍵；五個禁複製鍵恆不出現", () => {
    const data = buildDepreciationRevisionData(source, ACTOR_ID, NOW);

    expect(sortedKeys(data)).toEqual([...APPLICATION_LEVEL_KEYS, "depreciation"].sort());
    for (const key of APPLICATION_LEVEL_FORBIDDEN_KEYS) {
      expect(Object.hasOwn(data, key)).toBe(false);
    }
  });

  it("DepreciationApplication 子層鍵集恰為兩鍵；十一個禁複製鍵（含九個 snapshot*、calculatedAt、depreciationParameterVersionId）恆不出現", () => {
    const child = buildDepreciationRevisionData(source, ACTOR_ID, NOW).depreciation.create;

    expect(sortedKeys(child)).toEqual([...DEPRECIATION_CHILD_KEYS].sort());
    for (const key of DEPRECIATION_CHILD_FORBIDDEN_KEYS) {
      expect(Object.hasOwn(child, key)).toBe(false);
    }
  });

  it("三型各一正向（折舊）：applicationYear／annualTotalKm 逐欄複製；primaryDate 由 applicationYear 推導為該年 12-31", () => {
    const data = buildDepreciationRevisionData(source, ACTOR_ID, NOW);

    expect(data.type).toBe("DEPRECIATION");
    expect(data.status).toBe("DRAFT");
    expect(data.ownerId).toBe(OWNER_ID);
    expect(data.createdById).toBe(ACTOR_ID);
    expect(data.supersedesId).toBe(SOURCE_ID);
    // deriveDepreciationPrimaryDate 既有規則：該年 12-31（UTC）
    expect(data.primaryDate.toISOString()).toBe("2026-12-31T00:00:00.000Z");

    expect(data.depreciation.create.applicationYear).toBe(2026);
    expect(data.depreciation.create.annualTotalKm?.toFixed(1)).toBe("3000.0");
  });

  it("applicationYear 為 null → primaryDate 退回 now 之 UTC 日粒度", () => {
    const data = buildDepreciationRevisionData(
      { ...source, applicationYear: null, annualTotalKm: null },
      ACTOR_ID,
      NOW
    );

    expect(data.primaryDate.toISOString()).toBe("2026-08-07T00:00:00.000Z");
    expect(data.depreciation.create.applicationYear).toBeNull();
    expect(data.depreciation.create.annualTotalKm).toBeNull();
  });
});
