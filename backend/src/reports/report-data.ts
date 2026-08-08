/**
 * 報表資料組裝 — PHASE-008-T4（FE-US-23 資料基礎；跨 Phase 追蹤 #1~#4）
 *
 * Spec `docs/specs/PHASE-008.md` §2.D AC-17／AC-18／AC-19、§2.F AC-27（資料
 * 側）、§7.3（`ReportData` 封閉型別）、§8.4（快照讀取與新舊模型判別）。
 *
 * ---------------------------------------------------------------------------
 * 零重算紀律（AC-17(c)；§10.5）
 * ---------------------------------------------------------------------------
 * 本檔**只讀**已完成申請之持久化快照欄位，一律以 `.toFixed(n)` 定精度呈現，
 * **不呼叫**任何計算引擎（`calculateTravel`／`calculateMaintenance`／
 * `calculateDepreciation`／`deriveAnnualDepreciation`／`deriveFuelUnitPrice`），
 * 亦**不使用** `Prisma.Decimal` 之 `.times(`／`.div(`／`.plus(`／`.minus(`
 * ——包含公務比例之百分比呈現（`ratioToPercentString`）：來源
 * `snapshotRatio Decimal(9,6)` 為 6 位小數定寬字串，右移 2 位小數點即為 4
 * 位小數之百分比，純字串操作、零 Decimal 運算、零捨入（與既有
 * `maintenance-service.ts buildSnapshotDto` 之 `snapshotRatio.times(100)`
 * 逐位元同值，此處以字串移位取代 Decimal 乘法以滿足本檔「零算式」之結構性
 * 掃描守門）。
 *
 * ---------------------------------------------------------------------------
 * 新舊模型判別（§8.4，逐字沿用 PHASE-005a／PHASE-007 既有判準，不另立）
 * ---------------------------------------------------------------------------
 * 差旅：`fuelPriceVersionId != null` → CURRENT；`fuelParameterVersionId !=
 *   null 且 fuelPriceVersionId == null` → LEGACY。
 * 折舊：`snapshotAnnualTotalKm != null` → CURRENT；`snapshotPerKmUnitPrice
 *   != null 且 snapshotAnnualTotalKm == null` → LEGACY。
 * 保養：無雙軌（PHASE-006 起單一模型）。
 *
 * ---------------------------------------------------------------------------
 * 封閉白名單（AC-27）
 * ---------------------------------------------------------------------------
 * `DepreciationReportBody` 刻意**不含** `vehiclePrice`／`usefulLifeYears`／
 * `estimatedAnnualKm`／`depreciationParameterVersionId`（AC-18(b)）；亦不含
 * 4 位小數之 `rawAmount`（AC-18(c)）。三型 body 與 `ReportImage` 皆為封閉介
 * 面（無 index signature），任何欄位新增須經 Spec 修訂（§7.3）。
 *
 * PHASE-009 AC-19（受控擴充，經 Spec 修訂）：`ReportCommon` 新增**恰一個**欄位
 * `void`（七鍵 → 八鍵）；**三型 body 鍵集逐字不變**——作廢資訊只落於 `common`，
 * 不污染任何一型 body。
 *
 * ---------------------------------------------------------------------------
 * 圖片欄位（`ReportImage`）── 與 T6（`report-images.ts`）之分工
 * ---------------------------------------------------------------------------
 * 本檔僅讀出附件之中繼資料殼（`attachmentId`／`storageKey`／`mimeType`／
 * `originalFilename`），`dataUri` 恆為 `null`、`missing` 恆為 `false`——實際
 * 讀取位元組、降尺寸、轉為 `data:` URI（AC-13）由 §9.1 流程之下一步
 * `embedImages`（T6）填入，非本 Task 範圍。
 */

import type { ApplicationStatus, FuelType, Prisma } from "@prisma/client";
import type { PrismaLike } from "../mileage/mileage-engine.js";
import { getReportTypeLabel } from "./report-filename.js";

// ---------------------------------------------------------------------------
// Application 讀取形狀（供本檔與 T8 report-service.ts 共用之 include）
// ---------------------------------------------------------------------------

export const reportApplicationInclude = {
  owner: { select: { displayName: true } },
  travel: { include: { segments: { orderBy: { sortOrder: "asc" } } } },
  maintenance: true,
  depreciation: true,
} satisfies Prisma.ApplicationInclude;

export type ReportApplicationRecord = Prisma.ApplicationGetPayload<{
  include: typeof reportApplicationInclude;
}>;

/** 已產生報表之最小中繼資料（尚未產生時呼叫端傳入 `null`，§7.3 `ReportCommon`）。 */
export interface ReportMeta {
  reportNumber: string;
  generatedAt: Date;
}

// ---------------------------------------------------------------------------
// §7.3 封閉型別
// ---------------------------------------------------------------------------

/** 報表證明圖片殼；`dataUri`／`missing` 由 T6 之 `embedImages` 填入。 */
export interface ReportImage {
  attachmentId: string;
  storageKey: string;
  mimeType: string;
  originalFilename: string;
  dataUri: string | null;
  missing: boolean;
}

/**
 * 作廢資訊（PHASE-009 AC-19）；未作廢恆為 `null`。
 *
 * 與 `applications/application-void.ts` 之 `VoidInfoDto` 為**不同鍵名**之姊妹
 * 型別（該處為 `voidedAt`／`voidedByDisplayName`，此處依 AC-19 原文為 `at`／
 * `byDisplayName`），故無法直接複用其型別；「解析失敗以 `"—"` 呈現、恆不外洩
 * `voidedById`」之語意則逐字同型（見 {@link resolveReportVoid}）。
 *
 * `at` 為 ISO8601 字串——與同一介面之 `generatedAt`／`createdAt` 同型。台北時
 * 區中文格式化屬列印版之責（AC-20 明文要求沿 `formatTaipeiDateTime` 為**唯一**
 * 格式化來源），資料層不預先格式化。
 */
export interface ReportVoidInfo {
  reason: string;
  at: string;
  byDisplayName: string;
}

export interface ReportCommon {
  reportNumber: string | null;
  generatedAt: string | null;
  ownerDisplayName: string;
  typeLabel: "差旅" | "保養" | "折舊";
  statusLabel: string;
  createdAt: string;
  totalAmount: number;
  void: ReportVoidInfo | null;
}

export interface TravelSegmentReport {
  sortOrder: number;
  origin: string | null;
  destination: string | null;
  totalKm: string; // 2dp
  highwayKm: string; // 2dp
  segmentAmount: number; // 整數（TripSegment.snapshotAmount）
  attachments: ReportImage[];
}

export interface TravelReportBody {
  model: "CURRENT" | "LEGACY";
  tripDate: string | null; // YYYY-MM-DD
  purpose: string | null;
  segments: TravelSegmentReport[];
  totalKm: string; // 2dp（Σ 各段，snapshotTotalKm）
  preRoundingTotal: string; // 4dp（取整前總額，對帳列；snapshotRawAmount）
  fuelUnitPrice: string; // 4dp
  etcUnitPrice: string; // 4dp
  // ── 新模型三欄（LEGACY 恆為 null，AC-17(a)）──
  fuelType: FuelType | null;
  fuelPricePerLiter: string | null; // 4dp
  fuelConsumption: string | null; // 4dp
}

export interface MaintenanceReportBody {
  lastMaintenanceDate: string | null;
  currentMaintenanceDate: string | null;
  lastOdometerKm: string | null; // 2dp
  currentOdometerKm: string | null; // 2dp
  intervalKm: string; // 2dp（保養區間總里程，snapshotIntervalKm）
  officialKm: string; // 2dp（期間公務里程，snapshotOfficialKm）
  ratioPercent: string; // 4dp（公務使用比例）
  actualCost: string; // 2dp（實際費用）
  companyAmount: number; // 整數（公司分攤金額 ＝ Application.totalAmount）
  attachments: ReportImage[];
}

/** ★ 揭露面封閉（AC-18(b)、AC-27）。逐字依 Spec §7.3。 */
export interface DepreciationReportBody {
  model: "CURRENT" | "LEGACY";
  applicationYear: number | null;
  annualDepreciation: string | null; // CURRENT：2dp；LEGACY：null
  annualTotalKm: string | null; // CURRENT：1dp；LEGACY：null
  ratioPercent: string | null; // CURRENT：4dp；LEGACY：null
  perKmUnitPrice: string | null; // LEGACY：4dp；CURRENT：null
  officialKm: string; // 2dp（兩模型共有）
  attachments: ReportImage[];
  // 絕不含 vehiclePrice / usefulLifeYears / estimatedAnnualKm /
  // depreciationParameterVersionId / rawAmount(4dp 直呈)
}

export type ReportData =
  | { kind: "TRAVEL"; common: ReportCommon; travel: TravelReportBody }
  | { kind: "MAINTENANCE"; common: ReportCommon; maintenance: MaintenanceReportBody }
  | { kind: "DEPRECIATION"; common: ReportCommon; depreciation: DepreciationReportBody };

// ---------------------------------------------------------------------------
// 內部工具
// ---------------------------------------------------------------------------

/** AC-02 同型窮舉映射之既有慣例（`report-filename.ts REPORT_TYPE_LABEL`）已編
 * 譯期保證涵蓋三型，此處轉型為字面聯集屬安全轉型，不另立重複映射（DRY）。 */
function typeLabelOf(type: ReportApplicationRecord["type"]): ReportCommon["typeLabel"] {
  return getReportTypeLabel(type) as ReportCommon["typeLabel"];
}

const REPORT_STATUS_LABEL: Record<ApplicationStatus, string> = {
  DRAFT: "草稿",
  COMPLETED: "已完成",
  VOIDED: "已作廢",
};

/** `YYYY-MM-DD`（`getUTC*`，不受主機時區影響；沿 `parameter-service.ts` 既有慣例）。 */
function formatUtcDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 已完成申請之快照欄位理應非 `null`；若違反此不變式（例如測試以 Prisma 直接
 * 撥動 `status` 而未經完成流程寫入快照），寧可明確拋錯，也不要以 0／空字串
 * 靜默呈現錯誤金額（本 Task 為敏感資料揭露面，錯誤呈現之代價高於顯式失敗）。
 */
function required<T>(value: T | null | undefined, field: string, applicationId: string): T {
  if (value === null || value === undefined) {
    throw new Error(
      `Report data assembly: missing required field "${field}" for application ${applicationId}`
    );
  }
  return value;
}

function stripLeadingZeros(digits: string): string {
  const stripped = digits.replace(/^0+/, "");
  return stripped.length === 0 ? "0" : stripped;
}

/**
 * 將 6 位小數之比例 Decimal（`snapshotRatio Decimal(9,6)`）轉為 4 位小數之
 * 百分比字串——純字串小數點右移兩位，零 Decimal 運算、零捨入（見檔頭說明）。
 */
function ratioToPercentString(ratio: Prisma.Decimal): string {
  const fixed6 = ratio.toFixed(6);
  const [intPart, fracPart] = fixed6.split(".");
  const frac6 = (fracPart ?? "").padEnd(6, "0");
  const shiftedInt = stripLeadingZeros(intPart + frac6.slice(0, 2));
  const shiftedFrac = frac6.slice(2);
  return `${shiftedInt}.${shiftedFrac}`;
}

function toReportImage(row: {
  id: string;
  storageKey: string;
  mimeType: string;
  originalFilename: string;
}): ReportImage {
  return {
    attachmentId: row.id,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    originalFilename: row.originalFilename,
    dataUri: null,
    missing: false,
  };
}

async function fetchSegmentAttachments(
  db: PrismaLike,
  segmentIds: string[]
): Promise<Map<string, ReportImage[]>> {
  const bySegment = new Map<string, ReportImage[]>();
  if (segmentIds.length === 0) return bySegment;
  const rows = await db.attachment.findMany({
    where: { refType: "TRIP_SEGMENT", refId: { in: segmentIds }, status: "LINKED" },
    select: { id: true, storageKey: true, mimeType: true, originalFilename: true, refId: true },
    orderBy: [{ linkedAt: "asc" }, { id: "asc" }],
  });
  for (const row of rows) {
    if (!row.refId) continue;
    const list = bySegment.get(row.refId) ?? [];
    list.push(toReportImage(row));
    bySegment.set(row.refId, list);
  }
  return bySegment;
}

async function fetchApplicationAttachments(
  db: PrismaLike,
  refType: "MAINTENANCE" | "DEPRECIATION",
  applicationId: string
): Promise<ReportImage[]> {
  const rows = await db.attachment.findMany({
    where: { refType, refId: applicationId, status: "LINKED" },
    select: { id: true, storageKey: true, mimeType: true, originalFilename: true },
    orderBy: [{ linkedAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toReportImage);
}

// ---------------------------------------------------------------------------
// 共通區塊
// ---------------------------------------------------------------------------

/**
 * 由 `Application` 列組裝 {@link ReportVoidInfo}（AC-19(c)）。
 *
 * 三個作廢欄（`voidReason`／`voidedAt`／`voidedById`）同生共死（§8.1）——任一
 * 為 `null` 即視為未作廢，回傳 `null`。`voidedById` **無 FK**（§8.3，沿
 * `Report.generatedById` 慣例），故以獨立查詢解析顯示名稱；查無該使用者（帳號
 * 其後被刪除等情形）時以 `"—"` 呈現、**不**拋錯、**不**外洩 `voidedById`。
 *
 * 依賴方向：本檔（`reports/` 域）刻意**不** import `applications/
 * application-void.ts` 之 `resolveVoidInfo`——`reports/` 目前對 `applications/`
 * 零依賴（僅型別性地依賴 `mileage/mileage-engine.ts` 之 `PrismaLike`），為單一
 * 鍵名重映射而新建一條跨域執行期依賴不划算；且兩者鍵名不同（見
 * {@link ReportVoidInfo} 說明），複用亦無法省去映射。此處為六行之同型實作，
 * 語意（含 `"—"` 之字面）與該函式逐字一致。
 */
async function resolveReportVoid(
  db: PrismaLike,
  application: ReportApplicationRecord
): Promise<ReportVoidInfo | null> {
  if (
    application.voidReason === null ||
    application.voidedAt === null ||
    application.voidedById === null
  ) {
    return null;
  }

  const voidedBy = await db.user.findUnique({
    where: { id: application.voidedById },
    select: { displayName: true },
  });

  return {
    reason: application.voidReason,
    at: application.voidedAt.toISOString(),
    byDisplayName: voidedBy?.displayName ?? "—",
  };
}

async function buildCommon(
  db: PrismaLike,
  application: ReportApplicationRecord,
  report: ReportMeta | null
): Promise<ReportCommon> {
  return {
    reportNumber: report?.reportNumber ?? null,
    generatedAt: report ? report.generatedAt.toISOString() : null,
    ownerDisplayName: application.owner.displayName,
    typeLabel: typeLabelOf(application.type),
    statusLabel: REPORT_STATUS_LABEL[application.status],
    createdAt: application.createdAt.toISOString(),
    totalAmount: required(application.totalAmount, "totalAmount", application.id),
    void: await resolveReportVoid(db, application),
  };
}

// ---------------------------------------------------------------------------
// 差旅（AC-17(a)）
// ---------------------------------------------------------------------------

async function buildTravelBody(
  db: PrismaLike,
  application: ReportApplicationRecord
): Promise<TravelReportBody> {
  const travel = required(application.travel, "travel", application.id);
  const segmentIds = travel.segments.map((s) => s.id);
  const attachmentsBySegment = await fetchSegmentAttachments(db, segmentIds);

  // §8.4：fuelPriceVersionId != null → CURRENT；否則（fuelParameterVersionId
  // != null 且 fuelPriceVersionId == null）→ LEGACY。
  const model: "CURRENT" | "LEGACY" = travel.fuelPriceVersionId != null ? "CURRENT" : "LEGACY";

  return {
    model,
    tripDate: travel.tripDate ? formatUtcDate(travel.tripDate) : null,
    purpose: travel.purpose ?? null,
    segments: travel.segments.map((segment) => ({
      sortOrder: segment.sortOrder,
      origin: segment.origin ?? null,
      destination: segment.destination ?? null,
      totalKm: required(segment.totalKm, "totalKm", application.id).toFixed(2),
      highwayKm: required(segment.highwayKm, "highwayKm", application.id).toFixed(2),
      segmentAmount: required(segment.snapshotAmount, "snapshotAmount", application.id),
      attachments: attachmentsBySegment.get(segment.id) ?? [],
    })),
    totalKm: required(travel.snapshotTotalKm, "snapshotTotalKm", application.id).toFixed(2),
    preRoundingTotal: required(
      travel.snapshotRawAmount,
      "snapshotRawAmount",
      application.id
    ).toFixed(4),
    fuelUnitPrice: required(travel.fuelUnitPrice, "fuelUnitPrice", application.id).toFixed(4),
    etcUnitPrice: required(travel.etcUnitPrice, "etcUnitPrice", application.id).toFixed(4),
    fuelType: model === "CURRENT" ? travel.snapshotFuelType : null,
    fuelPricePerLiter:
      model === "CURRENT" && travel.snapshotFuelPricePerLiter != null
        ? travel.snapshotFuelPricePerLiter.toFixed(4)
        : null,
    fuelConsumption:
      model === "CURRENT" && travel.snapshotFuelConsumption != null
        ? travel.snapshotFuelConsumption.toFixed(4)
        : null,
  };
}

// ---------------------------------------------------------------------------
// 保養（AC-19；無雙軌）
// ---------------------------------------------------------------------------

async function buildMaintenanceBody(
  db: PrismaLike,
  application: ReportApplicationRecord
): Promise<MaintenanceReportBody> {
  const maintenance = required(application.maintenance, "maintenance", application.id);
  const attachments = await fetchApplicationAttachments(db, "MAINTENANCE", application.id);

  return {
    lastMaintenanceDate: maintenance.lastMaintenanceDate
      ? formatUtcDate(maintenance.lastMaintenanceDate)
      : null,
    currentMaintenanceDate: maintenance.currentMaintenanceDate
      ? formatUtcDate(maintenance.currentMaintenanceDate)
      : null,
    lastOdometerKm: maintenance.lastOdometerKm ? maintenance.lastOdometerKm.toFixed(2) : null,
    currentOdometerKm: maintenance.currentOdometerKm
      ? maintenance.currentOdometerKm.toFixed(2)
      : null,
    intervalKm: required(
      maintenance.snapshotIntervalKm,
      "snapshotIntervalKm",
      application.id
    ).toFixed(2),
    officialKm: required(
      maintenance.snapshotOfficialKm,
      "snapshotOfficialKm",
      application.id
    ).toFixed(2),
    ratioPercent: ratioToPercentString(
      required(maintenance.snapshotRatio, "snapshotRatio", application.id)
    ),
    actualCost: required(maintenance.actualCost, "actualCost", application.id).toFixed(2),
    companyAmount: required(application.totalAmount, "totalAmount", application.id),
    attachments,
  };
}

// ---------------------------------------------------------------------------
// 折舊（AC-18；LEGACY 雙軌）
// ---------------------------------------------------------------------------

async function buildDepreciationBody(
  db: PrismaLike,
  application: ReportApplicationRecord
): Promise<DepreciationReportBody> {
  const depreciation = required(application.depreciation, "depreciation", application.id);
  const attachments = await fetchApplicationAttachments(db, "DEPRECIATION", application.id);
  const officialKm = required(
    depreciation.snapshotOfficialKm,
    "snapshotOfficialKm",
    application.id
  ).toFixed(2);

  // §8.4：snapshotAnnualTotalKm != null → CURRENT；否則（snapshotPerKmUnitPrice
  // != null 且 snapshotAnnualTotalKm == null）→ LEGACY。
  if (depreciation.snapshotAnnualTotalKm != null) {
    return {
      model: "CURRENT",
      applicationYear: depreciation.applicationYear,
      annualDepreciation: required(
        depreciation.snapshotAnnualDepreciation,
        "snapshotAnnualDepreciation",
        application.id
      ).toFixed(2),
      annualTotalKm: depreciation.snapshotAnnualTotalKm.toFixed(1),
      ratioPercent: ratioToPercentString(
        required(depreciation.snapshotRatio, "snapshotRatio", application.id)
      ),
      perKmUnitPrice: null,
      officialKm,
      attachments,
    };
  }

  return {
    model: "LEGACY",
    applicationYear: depreciation.applicationYear,
    annualDepreciation: null,
    annualTotalKm: null,
    ratioPercent: null,
    perKmUnitPrice: required(
      depreciation.snapshotPerKmUnitPrice,
      "snapshotPerKmUnitPrice",
      application.id
    ).toFixed(4),
    officialKm,
    attachments,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 組裝單一已完成申請之報表資料（§9.1 步驟 (2)；§9.2 列印版讀取路徑共用同一
 * 函式）。呼叫端須以 {@link reportApplicationInclude} 查得 `application`；
 * `report` 為 `null` 時代表尚未產生報表（列印版仍可預覽，`common.reportNumber`
 * 與 `common.generatedAt` 皆為 `null`，§7.3）。
 */
export async function buildReportData(
  db: PrismaLike,
  application: ReportApplicationRecord,
  report: ReportMeta | null
): Promise<ReportData> {
  const common = await buildCommon(db, application, report);
  if (application.type === "TRAVEL") {
    return { kind: "TRAVEL", common, travel: await buildTravelBody(db, application) };
  }
  if (application.type === "MAINTENANCE") {
    return {
      kind: "MAINTENANCE",
      common,
      maintenance: await buildMaintenanceBody(db, application),
    };
  }
  if (application.type === "DEPRECIATION") {
    return {
      kind: "DEPRECIATION",
      common,
      depreciation: await buildDepreciationBody(db, application),
    };
  }
  const exhaustive: never = application.type;
  throw new Error(`Report data assembly: unsupported application type ${exhaustive as string}`);
}
