/**
 * Travel parameter resolution — PHASE-004-T7, 改造於 PHASE-005a-T7
 *
 * PHASE-005a Spec §2.A AC-04、§2.D AC-21/22/23、§7.4、§9.2 Data Flow、
 * §16 D4(a)/D5(a)/D6(a)（已批）。
 *
 * 本次改造重點（PHASE-005a）：
 *   1. 油資單價不再直讀 `FuelParameterVersion`（每公里單價，舊模型），改為
 *      「擁有人（ownerId）油耗版本 → 該油種油價版本 → deriveFuelUnitPrice
 *      推導取整」雙鏈解析（§9.2 Data Flow 逐字）。
 *   2. `resolveTravelParameters` 新增必要參數 `ownerId`：油耗一律以擁有人
 *      （代操作時為 `Application.ownerId`，非操作者 `request.currentUser.id`）
 *      解析，落實 AC-23「代操作以擁有人資料為準」。
 *   3. `MissingParameter` 由 `"FUEL"|"ETC"` 改為
 *      `"FUEL_PRICE"|"FUEL_CONSUMPTION"|"ETC"`（D5(a) 已批之破壞性更名）。
 *   4. 缺油耗（B-05）：油種未知，`missing` 僅回報 `FUEL_CONSUMPTION`，
 *      **不**同時查詢／回報油價缺項。
 *   5. `deriveFuelUnitPrice` 之 `RangeError`（代表資料毀損）由本模組攔截，
 *      記一行 sanitized 警示日誌後轉為 `fuelDataCorrupted=true`（T2 複審 AR-D
 *      義務——不得讓例外直接穿透至 HTTP 回應／以 500 面向使用者；PHASE-005a-T7R
 *      SF-1：不得零日誌靜默吞掉，且與「推導正常但超出欄位容量」
 *      （`fuelUnitPriceOutOfRange=true`）為不同情境，訊息與 `details.missing`
 *      代碼皆刻意不同）。非 `RangeError` 之未知例外一律 rethrow，絕不吞掉。
 *
 * 仍然沿用（不重寫）：
 *   - `findEffectiveVersion`（`../parameters/parameter-version-engine.ts`）—
 *     日期比較邏輯的唯一權威，AC-04 明文禁止重寫。
 *   - 「該類全部版本 `findMany` 後純函式選版」既定作法（§9.2 效能註記）——
 *     不得在 DB 層先以 `effectiveFrom: { lte }` 過濾。
 *
 * `resolveTravelParameters` 接受 `PrismaClient | Prisma.TransactionClient`
 * （`PrismaClientOrTx`），供完成流程在交易內原樣傳入 `tx` 呼叫。
 */

import type { FuelType, Prisma, PrismaClient } from "@prisma/client";
import { deriveFuelUnitPrice } from "../parameters/fuel-price-engine.js";
import { formatUtcDate } from "../parameters/parameter-service.js";
import { findEffectiveVersion } from "../parameters/parameter-version-engine.js";
import { AppError } from "../platform/errors.js";

/** Accepts either a plain PrismaClient or a `$transaction` callback's `tx` param (mirrors `PrismaTxLike` in attachment/lifecycle-service.ts). */
export type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

/**
 * D5(a) 已批准之破壞性更名：`"FUEL"` → `"FUEL_PRICE"`，並新增 `"FUEL_CONSUMPTION"`。
 * wire 值域，見 Spec §7.4。
 */
export type MissingParameter = "FUEL_PRICE" | "FUEL_CONSUMPTION" | "ETC";

export interface ResolvedParameters {
  /** 推導取整後之整數單價（NTD／km）；缺任一來源或超出容量時為 null。 */
  fuelUnitPrice: Prisma.Decimal | null;
  etcUnitPrice: Prisma.Decimal | null;
  /** `FuelPriceVersion.id`（新模型，取代舊 `fuelVersionId`）。 */
  fuelPriceVersionId: string | null;
  /** `UserFuelConsumptionVersion.id`（新模型新增）。 */
  fuelConsumptionVersionId: string | null;
  etcVersionId: string | null;
  /** 供 T8 完成快照使用之來源值（AC-25）；本 Task 只解析，不寫入快照。 */
  snapshotFuelType: FuelType | null;
  snapshotFuelPricePerLiter: Prisma.Decimal | null;
  snapshotFuelConsumption: Prisma.Decimal | null;
  /**
   * D4(a)：油耗與油價皆已解析，但推導單價 `|v| ≥ 10^6`（`deriveFuelUnitPrice`
   * 正常回傳之 `status: "out_of_range"`，非例外）。與 `missing` 是獨立的
   * 維度——`missing` 表示「查無版本」，本旗標表示「版本皆有，但推導結果超出
   * 欄位容量」。完成流程（T8）依此追加 `FUEL_UNIT_PRICE_OUT_OF_RANGE` 至 409
   * 之 `details.missing`。與 `fuelDataCorrupted`（資料毀損）為互斥的獨立
   * 維度，兩者不同時為 true（PHASE-005a-T7R SF-1）。
   */
  fuelUnitPriceOutOfRange: boolean;
  /**
   * PHASE-005a-T7R SF-1：`deriveFuelUnitPrice` 因資料毀損而 `throw
   * RangeError`（例如 `kmPerLiter <= 0` 或非有限值繞過上游驗證存入 DB）。
   * 與 `fuelUnitPriceOutOfRange`（正常推導但超出容量）為不同情境——資料毀損
   * 情境對外訊息與 `details.missing` 代碼皆刻意不同（可行動性不同：容量超出
   * 應查參數設定，資料毀損應查該使用者的油耗版本本身）。本模組已攔截並記錄
   * 一行 sanitized 警示日誌，絕不讓例外穿透至 HTTP 回應。
   */
  fuelDataCorrupted: boolean;
  missing: MissingParameter[];
}

/** `resolveTravelParameters` 內部用之最小版本形狀（DB 查詢結果）。 */
interface FuelConsumptionRow {
  id: string;
  effectiveFrom: Date;
  fuelType: FuelType;
  kmPerLiter: Prisma.Decimal;
}

interface FuelPriceRow {
  id: string;
  effectiveFrom: Date;
  pricePerLiter: Prisma.Decimal;
}

interface EtcRow {
  id: string;
  effectiveFrom: Date;
  unitPrice: Prisma.Decimal;
}

/**
 * 依出差日期與擁有人解析當日有效之油資（油種→油價）／ETC 版本，並推導取整
 * 後之油資每公里單價（§9.2 Data Flow 逐字）。
 *
 * `tripDate = null` → 全部視為缺（`missing = ["FUEL_CONSUMPTION","FUEL_PRICE","ETC"]`，
 * B-07），且刻意**不查詢 DB**（草稿尚未填出差日期時，查了也永遠選不到任何
 * 版本 — `findEffectiveVersion` 對任何 `queryDate` 皆須有值，`null` 沒有對應
 * 語意）。
 *
 * `ownerId`：油耗一律以此使用者解析（AC-23 代操作以擁有人資料為準——呼叫端
 * 必須傳入 `Application.ownerId`，絕不可傳操作者 `request.currentUser.id`）。
 *
 * 含當日語意（B-09）完全由 `findEffectiveVersion` 保證，本函式不重寫任何日期
 * 比較邏輯。
 */
export async function resolveTravelParameters(
  prisma: PrismaClientOrTx,
  tripDate: Date | null,
  ownerId: string
): Promise<ResolvedParameters> {
  if (tripDate === null) {
    return {
      fuelUnitPrice: null,
      etcUnitPrice: null,
      fuelPriceVersionId: null,
      fuelConsumptionVersionId: null,
      etcVersionId: null,
      snapshotFuelType: null,
      snapshotFuelPricePerLiter: null,
      snapshotFuelConsumption: null,
      fuelUnitPriceOutOfRange: false,
      fuelDataCorrupted: false,
      missing: ["FUEL_CONSUMPTION", "FUEL_PRICE", "ETC"],
    };
  }

  // Spec §9.2：先查擁有人的「全部」油耗版本 + ETC 版本（不得在 DB 層先以
  // effectiveFrom 過濾），純函式選版後才知道油種，再收斂查該油種的油價版本。
  const [consumptionVersions, etcVersions] = await Promise.all([
    prisma.userFuelConsumptionVersion.findMany({
      where: { userId: ownerId },
      select: { id: true, effectiveFrom: true, fuelType: true, kmPerLiter: true },
    }),
    prisma.etcParameterVersion.findMany({
      select: { id: true, effectiveFrom: true, unitPrice: true },
    }),
  ]);

  const consumption = findEffectiveVersion<FuelConsumptionRow>(consumptionVersions, tripDate);
  const etc = findEffectiveVersion<EtcRow>(etcVersions, tripDate);

  const missing: MissingParameter[] = [];

  let price: FuelPriceRow | null = null;
  if (consumption === null) {
    // B-05：油種未知，不查詢油價，亦不同時回報油價缺項。
    missing.push("FUEL_CONSUMPTION");
  } else {
    // 已由 fuelType 收斂，非全表查詢（§9.2 效能註記）。
    const priceVersions = await prisma.fuelPriceVersion.findMany({
      where: { fuelType: consumption.fuelType },
      select: { id: true, effectiveFrom: true, pricePerLiter: true },
    });
    price = findEffectiveVersion<FuelPriceRow>(priceVersions, tripDate);
    if (price === null) {
      missing.push("FUEL_PRICE");
    }
  }

  if (etc === null) missing.push("ETC");

  let fuelUnitPrice: Prisma.Decimal | null = null;
  let fuelUnitPriceOutOfRange = false;
  let fuelDataCorrupted = false;

  if (consumption !== null && price !== null) {
    try {
      const derivation = deriveFuelUnitPrice(price.pricePerLiter, consumption.kmPerLiter);
      if (derivation.status === "ok") {
        fuelUnitPrice = derivation.unitPrice;
      } else {
        // 正常推導（非例外），但 |商| ≥ 1e6 超出欄位容量（AC-20）。
        fuelUnitPriceOutOfRange = true;
      }
    } catch (err) {
      if (!(err instanceof RangeError)) {
        // PHASE-005a-T7R SF-1：非 RangeError 之未知例外絕不得吞掉——
        // fail-loud，維持既有例外傳播行為，交由上層（route 錯誤處理）視為
        // 未預期錯誤，不得偽裝成可行動的 409。
        throw err;
      }
      // T2 複審 AR-D 義務：deriveFuelUnitPrice 之 RangeError 代表資料已毀損
      // （例如 kmPerLiter <= 0 或非有限值繞過上游驗證存入 DB），不得以 500
      // 面向使用者，亦不得零日誌靜默吞掉——記一行 sanitized 警示日誌（僅
      // versionId／fuelType／err.name，不含 basisNote 或任何個資），供管理員
      // 事後排查資料完整性問題；本模組攔截後轉為 `fuelDataCorrupted`，交由
      // 完成流程（T8）轉為可行動的 409（D4(a)），絕不讓例外穿透至 HTTP 回應。
      console.error(
        "[travel-parameters] deriveFuelUnitPrice threw RangeError — treating as corrupted fuel data",
        {
          fuelConsumptionVersionId: consumption.id,
          fuelPriceVersionId: price.id,
          fuelType: consumption.fuelType,
          errorName: err.name,
        }
      );
      fuelDataCorrupted = true;
    }
  }

  return {
    fuelUnitPrice,
    etcUnitPrice: etc ? etc.unitPrice : null,
    fuelPriceVersionId: price ? price.id : null,
    fuelConsumptionVersionId: consumption ? consumption.id : null,
    etcVersionId: etc ? etc.id : null,
    snapshotFuelType: consumption ? consumption.fuelType : null,
    snapshotFuelPricePerLiter: price ? price.pricePerLiter : null,
    snapshotFuelConsumption: consumption ? consumption.kmPerLiter : null,
    fuelUnitPriceOutOfRange,
    fuelDataCorrupted,
    missing,
  };
}

/**
 * 依缺項組合選擇 zh-TW 訊息（AC-21/22 明文要求「逐字不同」）。
 * 優先序：油耗缺項 > 油價缺項 > 其餘（ETC 或無，沿用既有泛用文案）——
 * 與 §9.2 Data Flow 解析順序（先油耗、後油價、後 ETC）一致。
 */
function buildMissingMessage(missing: MissingParameter[]): string {
  if (missing.includes("FUEL_CONSUMPTION")) return "請聯絡管理員建立油耗資料";
  if (missing.includes("FUEL_PRICE")) return "請聯絡管理員設定參數";
  return "該出差日期尚無有效補助參數，請聯絡管理員設定。";
}

/**
 * 缺任一參數（或推導單價超出容量）不得完成（AC-21/22/47、D4(a)）。純函式，
 * 供完成流程直接呼叫。
 *
 * `details.tripDate`：格式化為 `YYYY-MM-DD`（沿用 PHASE-003a `formatUtcDate`），
 * `tripDate=null` 時原樣回 `null`。
 */
export function assertParametersAvailable(
  resolved: ResolvedParameters,
  tripDate: Date | null
): void {
  if (
    resolved.missing.length === 0 &&
    !resolved.fuelUnitPriceOutOfRange &&
    !resolved.fuelDataCorrupted
  ) {
    return;
  }

  const formattedTripDate = tripDate ? formatUtcDate(tripDate) : null;

  if (resolved.fuelDataCorrupted) {
    // PHASE-005a-T7R SF-1：與「容量超出」為不同情境——訊息與 details.missing
    // 代碼皆刻意逐字不同，避免管理員被誤導去查參數組合（實際應查該使用者的
    // 油耗版本本身是否毀損）。非新增 ErrorCode，仍走 PARAMETER_NOT_AVAILABLE
    // 409（僅 details.missing 追加新代碼）。
    throw new AppError(
      "PARAMETER_NOT_AVAILABLE",
      409,
      "油耗資料異常，請聯絡管理員檢查該使用者之油耗版本",
      undefined,
      {
        missing: [...resolved.missing, "FUEL_DATA_CORRUPTED"],
        tripDate: formattedTripDate,
      }
    );
  }

  if (resolved.fuelUnitPriceOutOfRange) {
    // D4(a)：油耗／油價皆已解析，但推導單價超出快照欄位容量（或資料毀損被
    // 本模組攔截）。與「查無版本」是獨立維度，故 `details.missing` 在既有
    // 缺項之外「追加」此代碼（非新增 ErrorCode，AC-35 仍成立）。
    throw new AppError(
      "PARAMETER_NOT_AVAILABLE",
      409,
      "油價與油耗之組合超出可計算範圍，請聯絡管理員檢查參數設定",
      undefined,
      {
        missing: [...resolved.missing, "FUEL_UNIT_PRICE_OUT_OF_RANGE"],
        tripDate: formattedTripDate,
      }
    );
  }

  throw new AppError(
    "PARAMETER_NOT_AVAILABLE",
    409,
    buildMissingMessage(resolved.missing),
    undefined,
    {
      missing: resolved.missing,
      tripDate: formattedTripDate,
    }
  );
}
