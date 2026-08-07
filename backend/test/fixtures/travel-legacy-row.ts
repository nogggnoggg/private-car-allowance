/**
 * 差旅子表之「舊模型（PHASE-005a 之前）列形狀」raw SQL 播種器（共用檔）。
 *
 * ── 為何以 raw SQL 播種（PHASE-008-T4，Spec §11.2／AC-17(c) 逐字義務） ──────
 * 現行 `schema.prisma` 之 `TravelApplication` 五個 PHASE-005a 新欄
 * （`snapshotFuelType`／`snapshotFuelPricePerLiter`／`snapshotFuelConsumption`／
 * `fuelPriceVersionId`／`fuelConsumptionVersionId`）**全部 nullable、無
 * `@default`**，故技術上以一般 Prisma Client `create()`（省略這五欄）即可造出
 * 「舊模型列」形狀。但 Spec §11.2「資料組裝」列與 T4 Done When **逐字**要求
 * 「LEGACY 兩型以 raw SQL 播種」——與 `depreciation-legacy-row.ts`
 * （`insertLegacyDepreciationRowRaw`）同型義務，本檔提供差旅之對應版本，供
 * `phase8-report-data.test.ts` 之 AC-17(a)(c) 使用。
 *
 * 僅寫入 **PHASE-005a 之前就存在的 10 欄**；五個新欄一律不出現在 INSERT 中，
 * 故新欄取 DB 預設值 `NULL`——恰好滿足 Spec §8.4 之判別述詞
 * （`fuelParameterVersionId != null` 且 `fuelPriceVersionId == null`）。
 *
 * 本檔**不含任何 `describe`／`it`**，故被 import 時不會註冊測試。呼叫端須先
 * 以一般 Prisma Client 建立對應之 `Application` 父列（`id` 等於本函式之
 * `applicationId`），本函式僅寫入 `TravelApplication` 子列。
 */
import type { PrismaClient } from "@prisma/client";

/** 舊模型（PHASE-005a 之前）差旅快照列之輸入形狀——僅 10 個既有欄。 */
export interface LegacyTravelRowInput {
  applicationId: string;
  tripDate: Date;
  purpose: string;
  fuelUnitPrice: string;
  etcUnitPrice: string;
  fuelParameterVersionId: string;
  etcParameterVersionId: string;
  snapshotTotalKm: string;
  snapshotRawAmount: string;
  calculatedAt: Date;
}

/** 舊模型差旅快照列之 raw SQL 播種（`TravelApplication`）。 */
export async function insertLegacyTravelRowRaw(
  client: PrismaClient,
  row: LegacyTravelRowInput
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO "TravelApplication" (
       "applicationId", "tripDate", purpose, "fuelUnitPrice", "etcUnitPrice",
       "fuelParameterVersionId", "etcParameterVersionId", "snapshotTotalKm",
       "snapshotRawAmount", "calculatedAt"
     ) VALUES (
       $1, $2, $3, CAST($4 AS numeric), CAST($5 AS numeric),
       $6, $7, CAST($8 AS numeric), CAST($9 AS numeric), $10
     )`,
    row.applicationId,
    row.tripDate,
    row.purpose,
    row.fuelUnitPrice,
    row.etcUnitPrice,
    row.fuelParameterVersionId,
    row.etcParameterVersionId,
    row.snapshotTotalKm,
    row.snapshotRawAmount,
    row.calculatedAt
  );
}
