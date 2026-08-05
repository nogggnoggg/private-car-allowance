/**
 * Annual depreciation completion blockers — PHASE-007-R3（折舊模型修訂段）
 *
 * Pure function: no DB, no IO, no `Date.now()`, no randomness, no side
 * effects. Spec `docs/specs/PHASE-007.md` **§20.5**（修訂後六碼固定順序表、
 * 兩段式紀律、三段互斥、不變式；取代 §7.5）、§20.8.2（完成流程呼叫順序）、
 * §2／§20.3 AC-16(b)／AC-18／AC-22(c)(d)／AC-52／AC-53／AC-54（判定層）。
 * 形狀與慣例沿 `completion-blockers.ts`（PHASE-004）／`maintenance-blockers.ts`
 * （PHASE-006）。
 *
 * ── 兩段式語意（§20.5 逐字：「結構性（1~3）先算；非空即拒絕、**不查詢**年度
 *    里程與參數。全通過才執行里程與參數查詢，再算 4~6 並二次判定」） ─────────
 *   第一段（結構性，第 1~3 項）：僅需 `applicationYear` 與 `annualTotalKm`
 *     即可判定——兩者皆為**使用者申報之申請資料**，無須任何查詢。非空即回傳，
 *     **不**評估第 4~6 項；呼叫端據此省下一次年度里程聚合與參數查詢。
 *   第二段（計算性，第 4~6 項）：僅在第一段全通過**且**呼叫端已完成查詢時
 *     評估。以 `officialKm` 是否為 `null`／`undefined` 表達「是否已查詢」
 *     （§20.5：「純函式以 `officialKm?: Decimal | null`、`annualDepreciation?:
 *     Decimal | null` 表達『尚未查詢』而**不**產生第 4~6 項」）：
 *       `officialKm == null`                    → 尚未查詢，完全抑制第 4~6 項；
 *       `officialKm != null`＋`annualDepreciation == null`
 *                                               → 已查詢但該年 1/1 無有效參數，
 *                                                 或 `deriveAnnualDepreciation`
 *                                                 回 `ok:false`（AC-18 視同缺
 *                                                 參數）→ 第 4 項；
 *       兩者皆非 `null`                          → 依實際比較與計算判定第 5、6 項。
 *
 * ── 三段互斥（§20.5 逐字，本檔以結構機械保證） ─────────────────────────────
 *   「第 2 與第 3 項互斥（`null` vs `≤0`）；第 4 項與第 5／6 項互斥（無每年
 *     費用即無從計算金額與比例）；**第 5 與第 6 項可同時出現**（比例超限之申請
 *     其金額仍可能超容量）。故任一回應之 `blockers[]` 至多含兩碼：`{1, 2|3}`
 *     或 `{4}` 或 `{5, 6}` 之子集。」
 *   實作對應：第 2/3 項寫成同一個 `if / else if`（互斥前提為 `null` 與 `≤0`
 *   不可能同時成立）；第 4 項為早退（early return）；第 5/6 項於同一段各自
 *   push，順序固定 5 → 6。
 *
 * ── AC-54：折舊證明改為選填（語意反轉） ────────────────────────────────────
 * 舊模型之「附件必備」第 2 碼已於修訂段**退場**（§20.5.1「退場」列、AC-54(b)
 * 之全 src 結構性掃描守門）。本檔因此**不再接收附件計數參數**，附件與完成度
 * 判定完全脫鉤；上限 5（AC-23）與完成後鎖定（AC-25）屬附件層，不在本檔。
 *
 * ── 判定之單一事實來源（T2 移交 W-3／FW-1、FW-8；AC-52(c)） ────────────────
 * 第 6 項（`AMOUNT_OUT_OF_RANGE`）一律經 `calculateDepreciation` ＋
 * `isDepreciationCalculationOverCapacity`（PHASE-007-R2）判定，**不得**在本檔
 * 重寫任何閾值或比較式（禁止第二份容量閾值拷貝）。
 * 第 5 項（`OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM`）之判定式抽為匯出 predicate
 * `isOfficialKmExceedsAnnualTotalKm`，供本檔與 service 層（`computed` 組裝）
 * 共同呼叫——**service 層不得就地重寫**（AC-52(c) 逐字；沿 006 T5R SF-1
 * 「同一規則兩份可各自漂移之實作」之教訓與 `isOfficialKmExceedsInterval` 先例）。
 * **FW-1 紀律**：第一段未通過、或第二段缺每年費用（第 4 項）之路徑，**絕不**
 * 呼叫比例 predicate 或容量 predicate——否則缺參數情境會多吐碼，使 AC-16(b)
 * 之完整 blocker 清單斷言與 §20.5 之互斥關係同時破裂。本檔以早退結構機械保證。
 *
 * ── `NaN`／`Invalid Date` 防禦（保守失敗，不得靜默放行） ────────────────────
 * `NaN < 1`、`NaN >= 1` 等原生比較恆為 `false`，若以裸比較判定，`NaN` 輸入會
 * 被靜默放行（看似合法）——006 T3 AR-1 已登記之同型缺口。本檔對
 * `applicationYear` 以 `Number.isInteger()` 守門（典型非有限來源為
 * `Invalid Date` 推導：`new Date("nope").getUTCFullYear() === NaN`）；對
 * `annualTotalKm` 則**先** `.isFinite()` 再比較 `≤ 0`（`Prisma.Decimal` 與
 * `NaN` 之任何比較恆為 `false`，比較式不能當唯一守門），非有限值一律折為第 3
 * 項。`officialKm`／`annualDepreciation` 之非有限值分別由第 5 項 predicate
 * （保守視同超出）與 R2 之三重守門＋容量 predicate（`calculable=false ⇒ true`）
 * 轉為第 5／6 項，故不變式「任何非有限輸入必產生至少一個 blocker」成立。
 *
 * 本檔刻意**不做**年度值域驗證（[1900,2999] 屬驗證層）、刻意**不做**年度總里程
 * 之小數位與容量驗證（AC-47 屬欄位驗證層，且 API 路徑已於欄位層 400——本檔之
 * 第 3 項為 AC-53(e) 明示之防禦層，「不得因不可達而移除」）、刻意**不接線**
 * （不查 DB、不呼叫 `sumOfficialMileage`／`findEffectiveVersion`／
 * `deriveAnnualDepreciation`——查詢屬 service 層，本檔只收其結果）。
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
  /** 申請年度（`null` ＝ 尚未選擇）。值域檢查屬驗證層，本檔只判缺漏。 */
  applicationYear: number | null;
  /**
   * 該車年度總里程（使用者申報之申請資料；AC-47／AC-48）。`null` ＝ 未輸入
   * （草稿寬容，AC-53(a)）→ 第 2 項；`≤0` 或非有限值 → 第 3 項（AC-53(e) 防禦層）。
   */
  annualTotalKm: Prisma.Decimal | null;
  /**
   * 年度公務里程（`sumOfficialMileage` 之 `totalKm`）。`null`／省略 ＝ 第一段
   * 呼叫（尚未查詢，§20.8.2）→ 完全抑制第 4~6 項。
   */
  officialKm?: Prisma.Decimal | null;
  /**
   * 每年折舊費用（`deriveAnnualDepreciation` 之 2 位小數字串還原而得）。於第二段
   * （`officialKm` 非 `null`）時，`null` 表「該年 1/1 無有效參數」或
   * 「`deriveAnnualDepreciation` 回 `ok:false`」（AC-18 同型）→ 第 4 項。
   */
  annualDepreciation?: Prisma.Decimal | null;
}

/** 年度缺漏判定（第 1 項）。非整數／非有限值（含 `Invalid Date` 推導之 `NaN`）視同缺漏。 */
function isApplicationYearMissing(applicationYear: number | null): boolean {
  return applicationYear === null || !Number.isInteger(applicationYear);
}

/**
 * 年度總里程值域違規判定（第 3 項，AC-53(e)）：`≤ 0`。非有限值（`NaN`／
 * `±Infinity`）亦視為違規——保守失敗，不得靜默放行（`.isFinite()` **先於**
 * 比較式，見檔頭 `NaN` 防禦段）。
 */
function isAnnualTotalKmInvalid(annualTotalKm: Prisma.Decimal): boolean {
  return !annualTotalKm.isFinite() || annualTotalKm.lessThanOrEqualTo(0);
}

/**
 * AC-52 共用 predicate：`年度公務里程 > 年度總里程`（比例 > 100%）。
 *
 * **單一事實來源**（AC-52(c) 逐字：「判定式為單一事實來源，service 層不得就地
 * 重寫」）——供本檔（第 5 項）與 `depreciation-service.ts` 之 `computed` 組裝
 * 共同呼叫，避免同一條規則出現兩份可各自漂移之實作（006 T5R SF-1 教訓；
 * `maintenance-blockers.ts` 之 `isOfficialKmExceedsInterval` 為既有先例）。
 *
 * AC-52(c) 明文要求以兩里程之 `Decimal` **直接比較**，**不得**以取整後之
 * `ratio`（6dp）或 `ratioPercent`（4dp）比較——例如
 * `officialKm=1000000.01`／`annualTotalKm=1000000.0` 之 `ratioString` 恰為
 * `"1.000000"`、`ratioPercentString` 恰為 `"100.0000"`，取整後比較會靜默放行。
 *
 * AC-52(b) 邊界：`officialKm == annualTotalKm`（比例恰 100%）→ **允許完成**，
 * 故此處為嚴格大於（`greaterThan`），不得寫成 `greaterThanOrEqualTo`。
 *
 * 非有限值（防禦性）視同超出，保守失敗而非靜默放行（同檔頭 `NaN` 防禦原則）。
 */
export function isOfficialKmExceedsAnnualTotalKm(
  officialKm: Prisma.Decimal,
  annualTotalKm: Prisma.Decimal
): boolean {
  return (
    !officialKm.isFinite() || !annualTotalKm.isFinite() || officialKm.greaterThan(annualTotalKm)
  );
}

/**
 * 計算折舊申請的完成阻擋碼清單（§20.5.1 固定順序 1~6）。
 *
 * 回傳全部**已評估**且未通過之項目，順序穩定且逐項對應 §20.5.1 表格；空陣列於
 * 第一段呼叫僅代表「結構性通過，可進行里程與參數查詢」，於第二段呼叫才代表
 * 「可完成」。純函式：同輸入同輸出、不變動輸入、絕不拋錯。
 */
export function computeDepreciationBlockers(input: ComputeDepreciationBlockersInput): Blocker[] {
  // ── 第一段（結構性）：1、2|3 ──────────────────────────────────────────
  const structural: Blocker[] = [];
  if (isApplicationYearMissing(input.applicationYear)) {
    structural.push({
      code: "YEAR_REQUIRED",
      field: "applicationYear",
      message: "請選擇申請年度",
    });
  }
  // 第 2 與第 3 項互斥（§20.5.1）：`null` 與 `≤0` 不可能同時成立。第 2 項成立
  // 時直接早退——結構上即杜絕兩碼並存，同時使 `annualTotalKm` 於其後之型別
  // 收窄為非 `null`（零型別斷言）。
  // `?? null`：型別上 `annualTotalKm` 為必填，但本純函式之契約是「絕不拋錯」。
  // 呼叫端若（例如接線尚未收斂時）漏帶該欄，裸值會使 `.isFinite()` 於 `undefined`
  // 上炸開而變成 500——保守失敗紀律要求折為第 2 項，而非拋錯。
  const annualTotalKm = input.annualTotalKm ?? null;
  if (annualTotalKm === null) {
    structural.push({
      code: "ANNUAL_TOTAL_KM_REQUIRED",
      field: "annualTotalKm",
      message: "請輸入該車年度總里程",
    });
    return structural;
  }
  if (isAnnualTotalKmInvalid(annualTotalKm)) {
    structural.push({
      code: "ANNUAL_TOTAL_KM_INVALID",
      field: "annualTotalKm",
      message: "年度總里程必須大於 0",
    });
  }
  // 非空即拒絕：不評估第 4~6 項（§20.5；FW-1）。
  if (structural.length > 0) {
    return structural;
  }

  // ── 第二段（計算性）：4、5、6 ─────────────────────────────────────────
  const officialKm = input.officialKm ?? null;
  if (officialKm === null) {
    // 尚未查詢年度公務里程（第一段呼叫）→ 完全抑制第 4~6 項。
    return [];
  }

  const annualDepreciation = input.annualDepreciation ?? null;
  if (annualDepreciation === null) {
    // 該年 1/1 無有效參數，或推導失敗（AC-16(b)／AC-18）。
    // FW-1 ＋ §20.5.1 互斥：此路徑**絕不**呼叫比例／容量 predicate——無每年
    // 費用即無從計算金額與比例。
    return [
      {
        code: "PARAMETER_NOT_AVAILABLE",
        message: "該年度尚無有效折舊參數，請聯絡管理員設定",
      },
    ];
  }

  // 第 5、6 項可同時出現（§20.5.1），順序固定 5 → 6。
  const computed: Blocker[] = [];

  // AC-52：比例 > 100%（共用 predicate，見上方說明）。
  if (isOfficialKmExceedsAnnualTotalKm(officialKm, annualTotalKm)) {
    computed.push({
      code: "OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM",
      field: "annualTotalKm",
      message: "年度公務里程大於年度總里程，請檢查年度總里程",
    });
  }

  // AC-22(c)：容量判定一律沿用 R2 之計算與 predicate（W-3／FW-8，零第二份閾值）。
  const result = calculateDepreciation({ annualDepreciation, officialKm, annualTotalKm });
  if (isDepreciationCalculationOverCapacity(result)) {
    computed.push({
      code: "AMOUNT_OUT_OF_RANGE",
      message: "計算結果超出可儲存之金額範圍，請聯絡管理員檢查折舊參數",
    });
  }

  return computed;
}
