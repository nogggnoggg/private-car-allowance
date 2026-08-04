/**
 * Depreciation parameter resolution — PHASE-007-T7
 *
 * Spec `docs/specs/PHASE-007.md` §2 AC-15（依申請年度 1 月 1 日選版）／AC-17
 * （單價一律取自 PHASE-003a `deriveDepreciation` 之 4 位小數 `perKmUnitPrice`）
 * ／AC-18（`deriveDepreciation` 回 `ok:false` 視同缺參數）、§7.4 ①②③、
 * §9.2（預覽唯讀路徑之選版段）、§16 D5(a)／D6(a)。
 *
 * 分工（沿 `travel-parameters.ts` 之既有切法）：本檔只做「查版本 → 選版 →
 * 推導單價」，**不**計算金額（屬 `depreciation-calculation.ts`）、**不**組
 * blocker（屬 `depreciation-blockers.ts`）、**不**碰 HTTP。
 *
 * ── 不重寫任何既有引擎（AC-15／AC-17 逐字） ──────────────────────────────
 *   - 選版：`findEffectiveVersion`（`../parameters/parameter-version-engine.ts`）
 *     為日期比較之唯一權威；本檔不做任何自己的日期比較或名次挑選。
 *   - 推導：`deriveDepreciation`（`../parameters/depreciation-engine.ts`）為
 *     每公里單價之唯一權威；本檔**沒有任何除法**，只把它回傳的 4 位小數字串
 *     以 `new Prisma.Decimal(字串)` 還原（§7.4 ③；**不得**經 `Number()`／
 *     `parseFloat`，亦**不得**再次取整——D6(a)「兩處單價精度必須一致」）。
 *   兩者於本 Phase 皆為零 diff 檔案。
 *
 * ── 「全部版本取回後以純函式選版」之紀律（AC-15 逐字） ────────────────────
 *   查詢一律取回該類**全部**版本後交給純函式挑選，**不得**在 DB 層先以
 *   `effectiveFrom` 的比較條件收斂、也不得在 DB 層排名——沿 DATA_FLOW §2.2
 *   之 PHASE-005a 明文紀律（同一份選版語意只有純函式一個實作，DB 端不得出現
 *   第二份可各自漂移的日期規則）。折舊參數版本為全域少量資料列，全表取回的
 *   成本可忽略。
 *
 * ── 兩來源之區辨（T3 即審 FW-6；供 T9 使用） ─────────────────────────────
 *   「該年 1/1 查無有效版本」與「版本存在但 `deriveDepreciation` 回 `ok:false`」
 *   是**不同**的管理員可行動情境（前者要建參數，後者要修既有版本的三值）。
 *   §7.5 於 blocker 層將兩者折為同一碼 `PARAMETER_NOT_AVAILABLE`（草稿／預覽
 *   面），但本層**必須**保留區辨資訊：`missing` 之內容與 `derivationFailed`
 *   旗標即為 T9 完成端點組 409 `details.missing`（AC-16(a)／AC-18「訊息逐字
 *   不同」）之來源。呼叫端不得把兩者混同。
 */

import { Prisma } from "@prisma/client";
import type { PrismaLike } from "../mileage/mileage-engine.js";
import { deriveDepreciation } from "../parameters/depreciation-engine.js";
import { findEffectiveVersion } from "../parameters/parameter-version-engine.js";

/**
 * §7.4／AC-18 之 wire 值域（皆非新增 `ErrorCode`——沿 005a `FUEL_DATA_CORRUPTED`
 * 之既有作法，只出現在 `details.missing` 陣列內）。
 */
export type DepreciationMissingParameter = "DEPRECIATION" | "DEPRECIATION_DERIVATION_FAILED";

/**
 * 選版結果所需之最小版本形狀。三個推導來源值供 **T9 快照寫入**使用
 * （`snapshotVehiclePrice`／`snapshotUsefulLifeYears`／`snapshotEstimatedAnnualKm`），
 * §16 D8(a)：任何折舊 DTO 一律不外露此三值與 `id`。
 */
export interface DepreciationVersionRow {
  id: string;
  effectiveFrom: Date;
  vehiclePrice: Prisma.Decimal;
  usefulLifeYears: number;
  estimatedAnnualKm: number;
}

export interface ResolvedDepreciationParameters {
  /**
   * 每公里補助單價（4 位小數，逐字還原自 `deriveDepreciation`）。
   * `null` ＝ 查無有效版本，或推導失敗（兩者之區辨見 `missing`／`derivationFailed`）。
   */
  perKmUnitPrice: Prisma.Decimal | null;
  /** 該年 1/1 有效之版本；`null` ＝ 查無。推導失敗時仍為非 `null`（版本存在）。 */
  version: DepreciationVersionRow | null;
  /** `true` ＝ 版本存在但 `deriveDepreciation` 回 `ok:false`（AC-18）。 */
  derivationFailed: boolean;
  /** T9 組 409 `details.missing` 之來源；成功時為空陣列。 */
  missing: DepreciationMissingParameter[];
}

/**
 * 選版查詢日 ＝ 申請年度之 1 月 1 日（§7.4 ①）。
 *
 * UTC 建構（006 T1 AR-6③／T3 AR-3 之既有慣例）：**不得**以本地時區建構，
 * 否則東八區會使查詢日落到前一年 12-31T16:00Z 而選到錯誤的版本。
 */
export function depreciationParameterQueryDate(applicationYear: number): Date {
  return new Date(Date.UTC(applicationYear, 0, 1));
}

const NOT_AVAILABLE: ResolvedDepreciationParameters = {
  perKmUnitPrice: null,
  version: null,
  derivationFailed: false,
  missing: ["DEPRECIATION"],
};

/**
 * 解析某申請年度之折舊參數與每公里單價（§7.4 ①②③）。
 *
 * `applicationYear` 為 `null`／非整數（含 `Invalid Date` 推導之 `NaN`）時視同
 * 「無從選版」並**刻意不查詢 DB**——與 `travel-parameters.ts` 對
 * `tripDate = null` 之既有處置同型（沒有查詢日就沒有選版語意）。年度之缺漏
 * 本身於呼叫端已由 `computeDepreciationBlockers` 之第 1 碼 `YEAR_REQUIRED`
 * 承擔，本函式不重複產生該語意。
 *
 * 接受 `PrismaClient | Prisma.TransactionClient`，供 T9 完成流程在同一交易內
 * 原樣傳入 `tx` 呼叫。唯讀：本函式只查詢，絕無任何寫入。
 */
export async function resolveDepreciationParameters(
  db: PrismaLike,
  applicationYear: number | null
): Promise<ResolvedDepreciationParameters> {
  if (applicationYear === null || !Number.isInteger(applicationYear)) {
    return { ...NOT_AVAILABLE };
  }

  // AC-15：取回該類全部版本，選版一律交給純函式（見檔頭紀律說明）。
  const versions = await db.depreciationParameterVersion.findMany({
    select: {
      id: true,
      effectiveFrom: true,
      vehiclePrice: true,
      usefulLifeYears: true,
      estimatedAnnualKm: true,
    },
  });

  const version = findEffectiveVersion<DepreciationVersionRow>(
    versions,
    depreciationParameterQueryDate(applicationYear)
  );

  if (version === null) {
    return { ...NOT_AVAILABLE };
  }

  // AC-17：單價之唯一來源；本檔不含任何推導算式。
  const derived = deriveDepreciation({
    vehiclePrice: version.vehiclePrice,
    usefulLifeYears: version.usefulLifeYears,
    estimatedAnnualKm: version.estimatedAnnualKm,
  });

  if (!derived.ok) {
    // AC-18：理論不可達（建立端點已擋下 ≤0），但一旦發生一律視同缺參數——
    // 絕不 500、絕不以單價 0 繼續計算。
    return {
      perKmUnitPrice: null,
      version,
      derivationFailed: true,
      missing: ["DEPRECIATION_DERIVATION_FAILED"],
    };
  }

  return {
    // §7.4 ③：以固定 4 位小數字串還原，零浮點中介、不再取整（D6(a)）。
    perKmUnitPrice: new Prisma.Decimal(derived.perKmUnitPrice),
    version,
    derivationFailed: false,
    missing: [],
  };
}
