/**
 * 安全檔名純函式 — PHASE-008-T3（BE-US-28）
 *
 * Pure function: no DB, no IO, no side effects. 報表編號**不於此重算**——一律以
 * 呼叫端已產生之字串（`generateReportNumber` 之產出，見 `report-number.ts`）為
 * 輸入參數（T2 複審 FW-4）。
 * Spec `docs/specs/PHASE-008.md` §2.E AC-20／AC-21、§16 D7（推薦選項 (a)＋(i)）。
 *
 * ---------------------------------------------------------------------------
 * AC-20 檔名組成（三型逐型）
 * ---------------------------------------------------------------------------
 * `{類型}_{使用者姓名}_{日期或年度}_{報表編號}.pdf`。
 * - 類型：zh-TW 標籤（`差旅`／`保養`／`折舊`），見 `REPORT_TYPE_LABEL`。
 * - 日期或年度：差旅／保養＝對應日期（`YYYY-MM-DD`）；折舊＝申請年度（`YYYY`）。
 *   來源為 `null` 時以 `Application.primaryDate` 為 fallback（三型皆非空，§8.4）。
 *
 * ---------------------------------------------------------------------------
 * AC-21 不安全字元移除或轉換
 * ---------------------------------------------------------------------------
 * 姓名段清理規則（`sanitizeDisplayName`）：
 *   1. 去除前後綴 `.` 與空白（含 `\r`／`\n` 等空白類控制字元）。
 *   2. `[\\/:*?"<>|]` 與控制字元（`\x00`-`\x1F`、`\x7F`）→ `_`（逐字元替換）。
 *   3. 連續空白 → 單一 `_`。
 *   4. 長度上限 30 字（截斷）。
 *   5. 清理後為空 → `使用者`。
 * 整體檔名（含 `.pdf`）長度上限 120：超長時報表編號與 `.pdf` 恆保留，優先截姓名
 * 段、其次截日期／年度段（`assembleFileName` 之防禦性截斷，正常編號長度不會觸
 * 發，見測試檔「實作決策揭露」）。
 * 因報表編號恆存在於檔名中，整體檔名絕不會與 Windows 保留裝置名（`CON`／`NUL`
 * 等）全等。
 */

import type { ApplicationType } from "@prisma/client";

const EXTENSION = ".pdf";

/** AC-21：姓名段長度上限（超出截斷）。 */
export const MAX_NAME_SEGMENT_LENGTH = 30;

/** AC-21：整體檔名（含副檔名）長度上限。 */
export const MAX_FILE_NAME_LENGTH = 120;

/** AC-20：型別 → zh-TW 標籤之窮舉映射。 */
export const REPORT_TYPE_LABEL: Record<ApplicationType, string> = {
  TRAVEL: "差旅",
  MAINTENANCE: "保養",
  DEPRECIATION: "折舊",
};

/** AC-20：依申請型別取得 zh-TW 標籤。 */
export function getReportTypeLabel(type: ApplicationType): string {
  return REPORT_TYPE_LABEL[type];
}

/** `[\\/:*?"<>|]`：Windows／通用不安全路徑字元。 */
const UNSAFE_PATH_CHAR_RE = /[\\/:*?"<>|]/;

/** 控制字元（含空位元組 `\x00`、`\r`、`\n`）：0x00-0x1F 與 0x7F。 */
function isControlChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
}

/**
 * AC-21：清理使用者姓名為安全檔名段。
 * 順序：去前後綴 `.`／空白 → 不安全字元／控制字元逐字元轉 `_` → 連續空白收合為
 * 單一 `_` → 截斷至 {@link MAX_NAME_SEGMENT_LENGTH} → 清理後為空則以 `使用者`
 * 取代（見本檔頂端「AC-21」區塊與測試檔「實作決策揭露」之順序理由）。
 */
export function sanitizeDisplayName(raw: string): string {
  let value = raw.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");

  value = Array.from(value)
    .map((ch) => (UNSAFE_PATH_CHAR_RE.test(ch) || isControlChar(ch) ? "_" : ch))
    .join("");

  value = value.replace(/\s+/g, "_");

  value = value.slice(0, MAX_NAME_SEGMENT_LENGTH);

  return value.length === 0 ? "使用者" : value;
}

/** `YYYY-MM-DD`（`getUTC*`，不受主機時區影響）。 */
function formatDateSegment(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** `YYYY`（`getUTC*`，不受主機時區影響）。 */
function formatYearSegment(date: Date): string {
  return String(date.getUTCFullYear());
}

/**
 * AC-20：解析日期／年度段，型別專屬來源為 `null` 時以 `primaryDate` fallback。
 * - TRAVEL／MAINTENANCE：`dateOrYearSource` 為 `Date | null`（出差日期／本次保養
 *   日期）；`null` 時使用 `primaryDate`。
 * - DEPRECIATION：`dateOrYearSource` 為 `number | null`（申請年度）；`null` 時
 *   使用 `primaryDate` 之年。
 */
export function resolveDateOrYearSegment(
  type: ApplicationType,
  dateOrYearSource: Date | number | null,
  primaryDate: Date
): string {
  if (type === "DEPRECIATION") {
    const year =
      typeof dateOrYearSource === "number" ? dateOrYearSource : formatYearSegment(primaryDate);
    return String(year);
  }
  const date = dateOrYearSource instanceof Date ? dateOrYearSource : primaryDate;
  return formatDateSegment(date);
}

/**
 * AC-21：整體檔名長度上限之防禦性截斷。報表編號與 `.pdf` 恆保留；超長時優先截
 * 姓名段，其次截日期／年度段（見本檔頂端說明；正常報表編號長度不會觸發此路
 * 徑）。
 */
function assembleFileName(
  typeLabel: string,
  nameSegment: string,
  dateOrYearSegment: string,
  reportNumber: string
): string {
  let name = nameSegment;
  let dateOrYear = dateOrYearSegment;
  let fileName = `${typeLabel}_${name}_${dateOrYear}_${reportNumber}${EXTENSION}`;

  if (fileName.length > MAX_FILE_NAME_LENGTH) {
    const overByName = fileName.length - MAX_FILE_NAME_LENGTH;
    name = name.slice(0, Math.max(0, name.length - overByName));
    fileName = `${typeLabel}_${name}_${dateOrYear}_${reportNumber}${EXTENSION}`;
  }

  if (fileName.length > MAX_FILE_NAME_LENGTH) {
    const overByDate = fileName.length - MAX_FILE_NAME_LENGTH;
    dateOrYear = dateOrYear.slice(0, Math.max(0, dateOrYear.length - overByDate));
    fileName = `${typeLabel}_${name}_${dateOrYear}_${reportNumber}${EXTENSION}`;
  }

  return fileName;
}

/** {@link buildReportFileName} 之輸入。 */
export interface BuildReportFileNameInput {
  /** 申請型別（決定 zh-TW 標籤與日期／年度段之格式）。 */
  type: ApplicationType;
  /** 使用者姓名（未清理之原始值；經 {@link sanitizeDisplayName} 處理）。 */
  displayName: string;
  /**
   * 型別專屬之日期或年度來源：TRAVEL／MAINTENANCE 為出差日期／本次保養日期
   * （`Date | null`）；DEPRECIATION 為申請年度（`number | null`，即
   * `DepreciationApplication.applicationYear`）。為 `null` 時以 `primaryDate`
   * 防禦（AC-20、§8.4）。
   */
  dateOrYearSource: Date | number | null;
  /** `Application.primaryDate`；三型皆非空，為上者之 fallback 來源。 */
  primaryDate: Date;
  /**
   * 已產生之報表編號字串（由呼叫端經 `generateReportNumber` 取得）；本函式**不
   * 重算**編號（T2 複審 FW-4）。
   */
  reportNumber: string;
}

/** AC-20＋AC-21 完整管線：型別 ＋ 姓名 ＋ 日期或年度 ＋ 報表編號 → 安全檔名。 */
export function buildReportFileName(input: BuildReportFileNameInput): string {
  const typeLabel = getReportTypeLabel(input.type);
  const nameSegment = sanitizeDisplayName(input.displayName);
  const dateOrYearSegment = resolveDateOrYearSegment(
    input.type,
    input.dateOrYearSource,
    input.primaryDate
  );
  return assembleFileName(typeLabel, nameSegment, dateOrYearSegment, input.reportNumber);
}
