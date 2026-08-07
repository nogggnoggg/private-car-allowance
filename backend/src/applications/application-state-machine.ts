/**
 * Application state machine — PHASE-004-T2
 *
 * Spec §2 群組 I（AC-55~59）、AC-06、§8.5（D13 已完成拒改 403 FORBIDDEN）、
 * §17.1 D2（狀態集合）/D13（錯誤碼與文案定案）
 *
 * Pure functions, zero IO — no prisma client instance, no env access, no
 * DB/network/filesystem calls. Single source of truth for:
 *   (1) which ApplicationStatus transitions are legal this Phase, and
 *   (2) which statuses allow business-field mutation / deletion,
 * consumed by every write path (T3 草稿 CRUD、T8 完成流程、T10 代操作、
 * T11 附件關聯與刪除) so the "已完成不可修改" rule lives in exactly one place.
 *
 * D2（狀態集合，Gate 定案）：ApplicationStatus 宣告 DRAFT/COMPLETED/VOIDED。
 * PHASE-004~008：VOIDED 完全不可達——沒有任何轉換路徑寫入該值（AC-58）。
 * PHASE-009-T2（Spec §2 AC-02，受控擴充，人類已批准）：新增
 * `COMPLETED → VOIDED` 一條轉換，供作廢功能（PHASE-009 T3 起）使用；
 * `DRAFT → COMPLETED` 逐字不動。
 *
 * 型別來源：狀態型別直接取自 Prisma 產生的 ApplicationStatus，避免與 schema
 * 脫鉤（Packet 型別要求）。這裡用 `import type`——型別匯入在編譯後完全被抹除，
 * 不產生任何 runtime import／不觸發 Prisma client 初始化，因此本模組在沒有
 * DATABASE_URL 的環境下仍可被當作純函式模組載入與單元測試。
 */
import type { ApplicationStatus } from "@prisma/client";
import { AppError } from "../platform/errors.js";

/**
 * 狀態值型別別名——見檔頭說明：來源即 Prisma 產生的 ApplicationStatus，
 * 不在本檔另行手刻一份字串聯集。
 */
export type ApplicationStatusValue = ApplicationStatus;

/**
 * 本 Phase 可達之轉換集合：
 *   - `DRAFT → COMPLETED`（PHASE-004 D2，逐字不動）
 *   - `COMPLETED → VOIDED`（PHASE-009-T2，Spec §2 AC-02，人類已批准之受控擴充）
 * 長度恆為 2——任何再放寬都必須先經 Gate 決策批准，並在此加註引用該決策；
 * 測試檔以 `ALLOWED_TRANSITIONS.length === 2` 斷言防止未經批准的悄悄放寬。
 */
export const ALLOWED_TRANSITIONS: ReadonlyArray<[ApplicationStatusValue, ApplicationStatusValue]> =
  [
    ["DRAFT", "COMPLETED"],
    ["COMPLETED", "VOIDED"],
  ];

function isAllowedTransition(from: ApplicationStatusValue, to: ApplicationStatusValue): boolean {
  return ALLOWED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/**
 * D13 逐字定案文案，供「來源狀態已是終態」的所有非法轉換與
 * assertApplicationMutable 共用（同一語意族：已完成/已作廢者不可再變動）。
 */
const ALREADY_FINAL_MESSAGE = "已完成的申請不可修改，請建立修正版";

/**
 * 斷言狀態轉換合法；非法一律拋 AppError。僅 `ALLOWED_TRANSITIONS` 所列
 * 兩條（DRAFT→COMPLETED、COMPLETED→VOIDED）放行，其餘全部拒絕。
 *
 * 兩種拒絕情形，分別對應不同錯誤碼：
 *
 * 1. `from` 非 DRAFT 且非「COMPLETED 轉 VOIDED」（即 COMPLETED→DRAFT、
 *    VOIDED→COMPLETED、VOIDED→DRAFT、VOIDED→VOIDED 等）→ 403 FORBIDDEN，
 *    訊息比照 D13。語意：來源狀態本身已鎖定，這是「權限/不可變性」層級
 *    的拒絕。
 *
 * 2. `from` = DRAFT 但 `to` 不是本 Phase 唯一支援的目的狀態 COMPLETED
 *    （即 DRAFT→DRAFT、DRAFT→VOIDED）→ 400 VALIDATION_ERROR。
 *    選碼理由：這裡來源狀態並未鎖定（DRAFT 本身可變），問題出在呼叫端
 *    要求的「目的狀態」本身不合法/本 Phase 不支援——語意上更接近
 *    「請求內容不合法」而非「權限不足」。若這裡也回 403 FORBIDDEN，會讓
 *    呼叫端無法區分「你沒有權限做這個轉換」與「這個目的狀態根本不存在
 *    於本 Phase」兩種完全不同的錯誤成因；FORBIDDEN 應保留給情形 1
 *    （來源已鎖定）以維持語意單一。既有 ErrorCode 中 VALIDATION_ERROR（400）
 *    最貼近「請求的目標狀態無效」，且不需新增 ErrorCode（Packet 禁止新增）。
 *    註：PHASE-004~008 已知呼叫端只會以 to="COMPLETED" 呼叫；PHASE-009-T3
 *    起新增以 to="VOIDED" 呼叫的作廢流程（走 COMPLETED→VOIDED 允許分支，
 *    不落入本分支）。DRAFT→VOIDED 目前仍非任何已知使用者可觸發路徑，此
 *    分支對它而言依舊是防禦性守門。
 */
export function assertTransition(from: ApplicationStatusValue, to: ApplicationStatusValue): void {
  if (isAllowedTransition(from, to)) {
    return;
  }

  if (from !== "DRAFT") {
    throw new AppError("FORBIDDEN", 403, ALREADY_FINAL_MESSAGE);
  }

  // from === "DRAFT" && to !== "COMPLETED"（本 Phase 不支援的目的狀態）
  throw new AppError("VALIDATION_ERROR", 400, "不支援的申請狀態轉換目標");
}

/** 純謂詞：該狀態下申請的業務欄位是否可變更（僅 DRAFT 為 true）。 */
export function isMutable(status: ApplicationStatusValue): boolean {
  return status === "DRAFT";
}

/**
 * 斷言申請可被修改／刪除；不可變時拋 403 FORBIDDEN + zh-TW 訊息（D13）。
 * DRAFT 通過；COMPLETED／VOIDED 一律拒絕（AC-06/56/59）。
 */
export function assertApplicationMutable(status: ApplicationStatusValue): void {
  if (isMutable(status)) {
    return;
  }
  throw new AppError("FORBIDDEN", 403, ALREADY_FINAL_MESSAGE);
}
