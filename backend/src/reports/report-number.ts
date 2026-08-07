/**
 * 報表編號純函式 — PHASE-008-T2（BE-US-26）
 *
 * Pure function: no DB, no IO, no side effects, no implicit host-timezone
 * dependency（一律使用 `Date` 之 `getUTC*` 系方法，**不得**使用
 * `getFullYear`／`getMonth` 等會受執行主機時區污染的區域方法）。
 * Spec `docs/specs/PHASE-008.md` §2.B AC-02／AC-03、§16 D2（推薦選項 (a)）。
 *
 * ---------------------------------------------------------------------------
 * AC-02 型別前綴（三型窮舉）
 * ---------------------------------------------------------------------------
 * TRAVEL → TRV／MAINTENANCE → MNT／DEPRECIATION → DEP。以
 * `Record<ApplicationType, string>` 承載：未來 `ApplicationType` 新增成員時，
 * 若未同步在此補上對應前綴，`REPORT_NUMBER_PREFIX` 之型別檢查將於**編譯期**
 * 失敗（`Record<K, V>` 強制窮盡 `K` 之每個成員）。
 *
 * ---------------------------------------------------------------------------
 * AC-03 編號格式與月份歸屬
 * ---------------------------------------------------------------------------
 * (a) 格式逐字為 `{PREFIX}-{YYYYMM}-{NNNN}`，例：`TRV-202608-0001`。
 * (b) `YYYYMM` 取自產生時間，依 **Asia/Taipei（UTC+08:00 固定偏移，台灣無日光
 *     節約）** 換算。實作方式：以毫秒數加上固定 8 小時偏移後，改用 `getUTC*`
 *     系方法讀出年月——全程不依賴執行主機之系統時區設定，亦不使用時區資料庫。
 * (c) `NNNN` 為序號，自 `1` 起 `padStart(4, "0")`；序號 ≥ 10000 時
 *     `String(sequence)` 本身已 ≥5 位，`padStart` 對已達最小長度之字串為
 *     no-op，故**自然延伸為 5 位**，不截斷、不歸零、不拒絕。
 * (d) 編號字串僅含 `[A-Z0-9-]`：前綴恆為 `TRV`／`MNT`／`DEP`（大寫 ASCII 字母）、
 *     `YYYYMM` 與 `NNNN` 恆為純數字字串、分隔符為 `-`，三者串接後之字元集恆
 *     滿足此不變式（見 `report-number.test.ts` 之字元集 sweep）。
 */

import type { ApplicationType } from "@prisma/client";

/** Asia/Taipei 固定偏移（UTC+08:00，無日光節約）。§16 D2 推薦選項 (a)。 */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** AC-02：型別 → 前綴之窮舉映射。 */
export const REPORT_NUMBER_PREFIX: Record<ApplicationType, string> = {
  TRAVEL: "TRV",
  MAINTENANCE: "MNT",
  DEPRECIATION: "DEP",
};

/** AC-02：依申請型別取得報表編號前綴。 */
export function getReportNumberPrefix(type: ApplicationType): string {
  return REPORT_NUMBER_PREFIX[type];
}

/**
 * AC-03(b)：依產生時間（UTC `Date`）換算 Asia/Taipei 之 `YYYYMM`。
 * 固定 +8h 偏移後一律以 `getUTC*` 讀出，避免受執行主機時區影響。
 */
export function getReportNumberPeriod(generatedAt: Date): string {
  const taipeiInstant = new Date(generatedAt.getTime() + TAIPEI_OFFSET_MS);
  const year = taipeiInstant.getUTCFullYear();
  const month = taipeiInstant.getUTCMonth() + 1;
  return `${year}${String(month).padStart(2, "0")}`;
}

/** AC-03(c)：序號補零，`padStart(4, "0")`；≥10000 自然延伸不截斷。 */
export function formatReportSequence(sequence: number): string {
  return String(sequence).padStart(4, "0");
}

/** AC-03(a)：組裝 `{PREFIX}-{YYYYMM}-{NNNN}`。 */
export function buildReportNumber(prefix: string, period: string, sequence: number): string {
  return `${prefix}-${period}-${formatReportSequence(sequence)}`;
}

/** AC-02＋AC-03 完整管線：型別 ＋ 產生時間 ＋ 序號 → 報表編號。 */
export function generateReportNumber(
  type: ApplicationType,
  generatedAt: Date,
  sequence: number
): string {
  return buildReportNumber(
    getReportNumberPrefix(type),
    getReportNumberPeriod(generatedAt),
    sequence
  );
}
