/**
 * Annual depreciation completion blockers — PHASE-007-T3
 *
 * Pure function: no DB, no IO, no `Date.now()`, no randomness, no side
 * effects. Spec `docs/specs/PHASE-007.md` §7.5（四碼固定順序表、兩段式定義、
 * 不變式）、§9.3 ②③④（呼叫順序）、§2 AC-16(b)／AC-18／AC-22(c)／AC-24
 * （判定層）。形狀與慣例沿 `completion-blockers.ts`（PHASE-004）／
 * `maintenance-blockers.ts`（PHASE-006）。
 *
 * ── 兩段式語意（§7.5 逐字：「結構性條件（1、2）先算；非空即拒絕、**不查詢**
 *    年度里程與參數」；§9.3 註記「②與③④之順序不可對調」） ────────────────
 *   第一段（結構性，第 1、2 項）：僅需 `applicationYear` 與 `attachmentCount`
 *     即可判定。非空即回傳，**不**評估第 3、4 項——呼叫端據此省下一次年度
 *     里程聚合與參數查詢，且錯誤語意單一。
 *   第二段（計算性，第 3、4 項）：僅在第一段全通過**且**呼叫端已完成查詢時
 *     評估。以 `officialKm` 是否為 `null`／`undefined` 表達「是否已查詢」
 *     （§7.5：「純函式以 `officialKm?: Decimal | null`、`perKmUnitPrice?:
 *     Decimal | null` 表達『尚未查詢』而**不**產生第 3/4 項」）：
 *       `officialKm == null`                → 尚未查詢，完全抑制第 3、4 項；
 *       `officialKm != null`＋`perKmUnitPrice == null`
 *                                           → 已查詢但該年 1/1 無有效參數，
 *                                             或 `deriveDepreciation` 回
 *                                             `ok:false`（AC-18 視同缺參數）
 *                                           → 第 3 項；
 *       兩者皆非 `null`                     → 依實際計算判定第 4 項。
 *
 * ── 容量判定之單一事實來源（T2 移交 W-3／T2 即審 FW-1、FW-8） ──────────────
 * 第 4 項（`AMOUNT_OUT_OF_RANGE`）一律經 `calculateDepreciation` ＋
 * `isDepreciationCalculationOverCapacity`（PHASE-007-T2）判定，**不得**在本檔
 * 重寫任何閾值或比較式（禁止第二份容量閾值拷貝——`DEPRECIATION_COLUMN_
 * CAPACITY` 僅存在於 T2 一處）。此處刻意**偏離** PHASE-006
 * `maintenance-blockers.ts` 之「由呼叫端算好 `amountOutOfRange?: boolean`
 * 旗標注入」慣例，理由三點：
 *   (1) T2 predicate 於 `calculable=false` 時回 `true`（W-3，與 006 相反——
 *       折舊僅四碼、無「不可計算」專屬碼），第 4 項因此同時承擔「非有限值」
 *       之兜底，必須與計算結果同源；
 *   (2) §7.5 不變式「`calculable=false ⇒ blockingCodes 至少一項`」若以旗標
 *       注入實作，真實映射將落在呼叫端（T7/T9）而非本純函式，sweep 測試只能
 *       驗證旗標轉手（T2 即審 FW-2 明文禁止）；
 *   (3) 單一判定來源避免 006 T5R SF-1「同一規則兩份可各自漂移之實作」重演。
 * **FW-1 紀律**：第一段未通過、或第二段缺參數（第 3 項）之路徑，**絕不**呼叫
 * 容量 predicate——否則缺參數情境會多吐一個 `AMOUNT_OUT_OF_RANGE`，使
 * AC-16(b) 之完整 blocker 清單斷言破裂。本檔以「早退（early return）」結構
 * 機械保證此性質。
 *
 * ── `NaN`／`Invalid Date` 防禦（保守失敗，不得靜默放行） ────────────────────
 * `NaN < 1`、`NaN >= 1` 等原生比較恆為 `false`，若以裸比較判定，`NaN` 輸入會
 * 被靜默放行（看似合法）——006 T3 AR-1 已登記之同型缺口。本檔對 `applicationYear`
 * 與 `attachmentCount` 一律以 `Number.isInteger()` 守門：非整數／非有限值視同
 * 「無法驗證為合法」而產生對應的結構性 blocker。年度之典型非有限來源為
 * `Invalid Date` 推導（`new Date("nope").getUTCFullYear() === NaN`）。
 * `Prisma.Decimal` 之非有限值（`NaN`／`±Infinity`）則由 T2 之三重守門 ＋
 * predicate（W-3）轉為第 4 項，故不變式「任何非有限輸入必產生至少一個
 * blocker」在四碼清單下成立。
 *
 * 本檔刻意**不做**年度值域驗證（[1900,2999] 屬 T4 驗證層）、刻意**不接線**
 * （不查 DB、不呼叫 `sumOfficialMileage`／`findEffectiveVersion`／
 * `deriveDepreciation`——查詢屬 T7/T9，本檔只收其結果）。
 */

import type { Prisma } from "@prisma/client";
import {
  calculateDepreciation,
  isDepreciationCalculationOverCapacity,
} from "./depreciation-calculation.js";

export interface Blocker {
  code: string;
  field?: string;
  message: string; // zh-TW
}

export interface ComputeDepreciationBlockersInput {
  /** 申請年度（`null` ＝ 尚未選擇）。值域檢查屬 T4 驗證層，本檔只判缺漏。 */
  applicationYear: number | null;
  /** 該申請目前 `LINKED` 附件數（AC-24；完成流程須於 tx 內 `FOR UPDATE` 後現算）。 */
  attachmentCount: number;
  /**
   * 年度公務里程（`sumOfficialMileage` 之 `totalKm`）。`null`／省略 ＝ 第一段
   * 呼叫（尚未查詢，§9.3 ②）→ 完全抑制第 3、4 項。
   */
  officialKm?: Prisma.Decimal | null;
  /**
   * 每公里補助單價（`deriveDepreciation` 之 4 位小數字串還原而得）。於第二段
   * （`officialKm` 非 `null`）時，`null` 表「該年 1/1 無有效參數」或
   * 「`deriveDepreciation` 回 `ok:false`」（AC-18 同型）→ 第 3 項。
   */
  perKmUnitPrice?: Prisma.Decimal | null;
}

/** 年度缺漏判定（第 1 項）。非整數／非有限值（含 `Invalid Date` 推導之 `NaN`）視同缺漏。 */
function isApplicationYearMissing(applicationYear: number | null): boolean {
  return applicationYear === null || !Number.isInteger(applicationYear);
}

/** 附件缺漏判定（第 2 項，AC-24）。非整數／非有限值視同缺漏（`NaN` 靜默放行缺口封閉）。 */
function isAttachmentMissing(attachmentCount: number): boolean {
  return !Number.isInteger(attachmentCount) || attachmentCount < 1;
}

/**
 * 計算折舊申請的完成阻擋碼清單（§7.5 固定順序 1~4）。
 *
 * 回傳全部**已評估**且未通過之項目，順序穩定且逐項對應 §7.5 表格；空陣列於
 * 第一段呼叫僅代表「結構性通過，可進行里程與參數查詢」，於第二段呼叫才代表
 * 「可完成」。純函式：同輸入同輸出、不變動輸入、絕不拋錯。
 */
export function computeDepreciationBlockers(input: ComputeDepreciationBlockersInput): Blocker[] {
  // ── 第一段（結構性）：1、2 ────────────────────────────────────────────
  const structural: Blocker[] = [];
  if (isApplicationYearMissing(input.applicationYear)) {
    structural.push({
      code: "YEAR_REQUIRED",
      field: "applicationYear",
      message: "請選擇申請年度",
    });
  }
  if (isAttachmentMissing(input.attachmentCount)) {
    structural.push({
      code: "DEPRECIATION_ATTACHMENT_REQUIRED",
      message: "請至少上傳 1 張折舊證明",
    });
  }
  // 非空即拒絕：不評估第 3、4 項（§7.5／§9.3；FW-1）。
  if (structural.length > 0) {
    return structural;
  }

  // ── 第二段（計算性）：3、4 ────────────────────────────────────────────
  const officialKm = input.officialKm ?? null;
  if (officialKm === null) {
    // 尚未查詢年度公務里程（第一段呼叫）→ 完全抑制第 3、4 項。
    return [];
  }

  const perKmUnitPrice = input.perKmUnitPrice ?? null;
  if (perKmUnitPrice === null) {
    // 該年 1/1 無有效參數，或 deriveDepreciation 回 ok:false（AC-16(b)／AC-18）。
    // FW-1：此路徑**絕不**呼叫容量 predicate——無單價即無從計算金額。
    return [
      {
        code: "PARAMETER_NOT_AVAILABLE",
        message: "該年度尚無有效折舊參數，請聯絡管理員設定",
      },
    ];
  }

  // AC-22(c)：容量判定一律沿用 T2 之計算與 predicate（W-3／FW-8，零第二份閾值）。
  const result = calculateDepreciation({ officialKm, perKmUnitPrice });
  if (isDepreciationCalculationOverCapacity(result)) {
    return [
      {
        code: "AMOUNT_OUT_OF_RANGE",
        message: "計算結果超出可儲存之金額範圍，請聯絡管理員檢查折舊參數",
      },
    ];
  }

  return [];
}
