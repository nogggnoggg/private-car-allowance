/**
 * Depreciation parameter resolution — PHASE-007-T7／**R6（折舊模型修訂段）**
 *
 * Spec `docs/specs/PHASE-007.md` §2 AC-15（依申請年度 1 月 1 日選版）／
 * §20.3 **AC-49**（每年折舊費用一律取自 `deriveAnnualDepreciation` 之 2 位小數
 * `annualDepreciation`；申請路徑**零呼叫** `deriveDepreciation`）／AC-18
 * （推導回 `ok:false` 視同缺參數）、**§20.4.1 ①②③**、§20.8.1（預覽唯讀路徑
 * 之選版段）、§16 D5(a)。
 *
 * 分工（沿 `travel-parameters.ts` 之既有切法）：本檔只做「查版本 → 選版 →
 * 推導每年折舊費用」，**不**計算金額（屬 `depreciation-calculation.ts`）、
 * **不**組 blocker（屬 `depreciation-blockers.ts`）、**不**碰 HTTP。
 *
 * ── 不重寫任何既有引擎（AC-15／AC-49 逐字） ──────────────────────────────
 *   - 選版：`findEffectiveVersion`（`../parameters/parameter-version-engine.ts`）
 *     為日期比較之唯一權威；本檔不做任何自己的日期比較或名次挑選。
 *   - 推導：`deriveAnnualDepreciation`（`../parameters/depreciation-engine.ts`，
 *     PHASE-007-R4a）為每年折舊費用之唯一權威；本檔**沒有任何除法**，只把它
 *     回傳的 2 位小數字串以 `new Prisma.Decimal(字串)` 還原（§20.4.1 ③；
 *     **不得**經 `Number()`／`parseFloat`，亦**不得**再次取整——AC-51(b)
 *     「本 Phase 之取整恰一處，即最終金額」）。
 *   兩者於本 Phase 皆為零 diff 檔案。
 *
 * ── 每公里單價引擎已退出本檔（PHASE-007-R6；裁定①、AC-49(c)(d)） ─────────
 *   `deriveDepreciation` **行為凍結但申請路徑零呼叫**：本檔不再 import 它。
 *   連帶移除 R1c 之過渡碼（以 0 代位縮欄後之年里程再餵舊引擎；R1 即審 S-2
 *   指定移除）——該過渡碼會使 AC-57 縮欄後之新版本（年里程欄為 `NULL`）踩進
 *   舊引擎的「≤0 → ok:false」契約而被**誤判**為推導失敗。
 *   修訂後之推導根本不需要年里程，該誤判隨之結構性消失（§20.5 之第 4 碼只在
 *   「查無版本」或「車價／年限 ≤0」時成立）。
 *
 * ── 「全部版本取回後以純函式選版」之紀律（AC-15 逐字） ────────────────────
 *   查詢一律取回該類**全部**版本後交給純函式挑選，**不得**在 DB 層先以
 *   `effectiveFrom` 的比較條件收斂、也不得在 DB 層排名——沿 DATA_FLOW §2.2
 *   之 PHASE-005a 明文紀律（同一份選版語意只有純函式一個實作，DB 端不得出現
 *   第二份可各自漂移的日期規則）。折舊參數版本為全域少量資料列，全表取回的
 *   成本可忽略。
 *
 * ── 兩來源之區辨（T3 即審 FW-6；供 T9 使用） ─────────────────────────────
 *   「該年 1/1 查無有效版本」與「版本存在但 `deriveAnnualDepreciation` 回 `ok:false`」
 *   是**不同**的管理員可行動情境（前者要建參數，後者要修既有版本的車價／年限）。
 *   §7.5 於 blocker 層將兩者折為同一碼 `PARAMETER_NOT_AVAILABLE`（草稿／預覽
 *   面），但本層**必須**保留區辨資訊：`missing` 之內容與 `derivationFailed`
 *   旗標即為 T9 完成端點組 409 `details.missing`（AC-16(a)／AC-18「訊息逐字
 *   不同」）之來源。呼叫端不得把兩者混同。
 */

import { Prisma } from "@prisma/client";
import type { PrismaLike } from "../mileage/mileage-engine.js";
import { deriveAnnualDepreciation } from "../parameters/depreciation-engine.js";
import { findEffectiveVersion } from "../parameters/parameter-version-engine.js";

/**
 * §7.4／AC-18 之 wire 值域（皆非新增 `ErrorCode`——沿 005a `FUEL_DATA_CORRUPTED`
 * 之既有作法，只出現在 `details.missing` 陣列內）。
 */
export type DepreciationMissingParameter = "DEPRECIATION" | "DEPRECIATION_DERIVATION_FAILED";

/**
 * 選版結果所需之最小版本形狀。三個推導來源值供 **T9 快照寫入**使用
 * （`snapshotVehiclePrice`／`snapshotUsefulLifeYears`；縮欄後之 `estimatedAnnualKm`
 * 僅供舊模型列之唯讀相容），§16 D8(a)／§20.6：任何折舊 DTO 一律不外露此三值
 * 與 `id`。
 */
export interface DepreciationVersionRow {
  id: string;
  effectiveFrom: Date;
  vehiclePrice: Prisma.Decimal;
  usefulLifeYears: number;
  estimatedAnnualKm: number | null; // PHASE-007-R1c：欄位已轉 nullable（§20.7.1／D21）
}

export interface ResolvedDepreciationParameters {
  /**
   * 每年折舊費用（2 位小數，逐字還原自 `deriveAnnualDepreciation`；
   * PHASE-007-R6 取代舊模型之 `perKmUnitPrice`）。
   * `null` ＝ 查無有效版本，或推導失敗（兩者之區辨見 `missing`／`derivationFailed`）。
   */
  annualDepreciation: Prisma.Decimal | null;
  /** 該年 1/1 有效之版本；`null` ＝ 查無。推導失敗時仍為非 `null`（版本存在）。 */
  version: DepreciationVersionRow | null;
  /** `true` ＝ 版本存在但 `deriveAnnualDepreciation` 回 `ok:false`（AC-18／AC-49(e)）。 */
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

/**
 * 「查無有效版本」之結果——**工廠而非共用常數**（T7 即審 SF-1）。
 *
 * 曾以 `const NOT_AVAILABLE` ＋ `{ ...NOT_AVAILABLE }` 回傳：淺複製只複製外層
 * 物件，`missing` 內層陣列仍是同一個參考，跨呼叫共用。Spec §7.4 ② 之字面即為
 * `missing += "DEPRECIATION_DERIVATION_FAILED"`，呼叫端（T9 完成端點）對回傳
 * 值 `push` 是預期用法——一次變異就會同時污染先前已回傳之結果與後續全部新
 * 呼叫。故此處每次建構**全新物件與全新陣列**，回傳值一律可安全變異。
 */
function notAvailable(): ResolvedDepreciationParameters {
  return {
    annualDepreciation: null,
    version: null,
    derivationFailed: false,
    missing: ["DEPRECIATION"],
  };
}

/**
 * 解析某申請年度之折舊參數與每年折舊費用（§20.4.1 ①②③）。
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
    return notAvailable();
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
    return notAvailable();
  }

  // AC-49(a)(b)：每年折舊費用之唯一來源；本檔不含任何推導算式。
  // **刻意只傳兩值**：修訂後之推導不需要 `estimatedAnnualKm`（AD-US-13 縮欄後
  // 該欄於新版本恆為 `NULL`），故縮欄版本不再有任何被誤判為推導失敗的途徑。
  const derived = deriveAnnualDepreciation({
    vehiclePrice: version.vehiclePrice,
    usefulLifeYears: version.usefulLifeYears,
  });

  if (!derived.ok) {
    // AC-49(e)：理論不可達（建立端點已擋下車價／年限 ≤0），但一旦發生一律視同
    // 缺參數——絕不 500、絕不以每年費用 0 繼續計算。
    return {
      annualDepreciation: null,
      version,
      derivationFailed: true,
      missing: ["DEPRECIATION_DERIVATION_FAILED"],
    };
  }

  return {
    // §20.4.1 ③：以固定 2 位小數字串還原，零浮點中介、不再取整（AC-51(b)）。
    annualDepreciation: new Prisma.Decimal(derived.annualDepreciation),
    version,
    derivationFailed: false,
    missing: [],
  };
}
