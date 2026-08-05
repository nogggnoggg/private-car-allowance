/**
 * FW-8 raw SQL fixture —— 折舊子表之「M2 之前列形狀」播種器（共用檔）。
 *
 * ── 為何必須 raw SQL（T1 FW-8 硬性義務，Spec §20.7.3 逐字） ─────────────────
 * M1 為純 `CREATE`，其「既有列零改寫」fixture 可安全使用一般 Prisma Client；
 * M2 為 **ALTER 型**，`DepreciationApplication` 的欄集合在 migration 前後
 * **不同**，而 Prisma Client 的型別已含新 4 欄（`annualTotalKm`／
 * `snapshotAnnualDepreciation`／`snapshotAnnualTotalKm`／`snapshotRatio`），
 * **無法**用來製造 migration 前之列形狀。故一律以 raw SQL 寫入。
 *
 * ── 為何抽為共用檔（PHASE-007-R7 即審 FW-2） ───────────────────────────────
 * 本 fixture 有**兩個**消費者：
 *   ① `phase7-migration-safety.test.ts`（M2 安全網之「既有列」，AC-01）；
 *   ② `phase7-depreciation-complete.test.ts`（AC-56(d) 之**舊模型列來源**）。
 * 若由 ② 直接 `import` ①，vitest 會**重複註冊** ① 的整批測試並重跑
 * `migrate deploy`；若 ② 就地複製一份 SQL，則兩份欄位清單會漂移。抽為本共用
 * 檔即同時避開兩者——**單一事實來源**，零重複註冊。
 *
 * 本檔**不含任何 `describe`／`it`**，故被 import 時不會註冊測試。
 */
import type { PrismaClient } from "@prisma/client";

/**
 * 舊模型（M2 前）折舊快照列之輸入形狀 —— 僅 M2 之前就存在的 10 欄。
 */
export interface LegacyDepreciationRowInput {
  applicationId: string;
  applicationYear: number | null;
  snapshotVehiclePrice: string | null;
  snapshotUsefulLifeYears: number | null;
  snapshotEstimatedAnnualKm: number | null;
  snapshotPerKmUnitPrice: string | null;
  snapshotOfficialKm: string | null;
  snapshotRawAmount: string | null;
  calculatedAt: Date | null;
  depreciationParameterVersionId: string | null;
}

/**
 * 舊模型折舊快照列之 raw SQL 播種。
 *
 * 僅列出 **M2 之前就存在的 10 欄**；M2 新增的 4 欄一律不出現在 INSERT 中，
 * 因此：
 *   - 在 **M2 之前**的 DB 上執行 → 產生真正的「migration 前列形狀」；
 *   - 在 **M2 之後**的 DB 上執行 → 新 4 欄取 DB 預設值 `NULL`，恰好滿足
 *     Spec §20.7.4／AC-56(a) 之**舊模型列**述詞（`snapshotPerKmUnitPrice
 *     != null` 且 `snapshotAnnualTotalKm == null`）。
 */
export async function insertLegacyDepreciationRowRaw(
  client: PrismaClient,
  row: LegacyDepreciationRowInput
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO "DepreciationApplication" (
       "applicationId", "applicationYear", "snapshotVehiclePrice", "snapshotUsefulLifeYears",
       "snapshotEstimatedAnnualKm", "snapshotPerKmUnitPrice", "snapshotOfficialKm",
       "snapshotRawAmount", "calculatedAt", "depreciationParameterVersionId"
     ) VALUES (
       $1, $2, CAST($3 AS numeric), $4,
       $5, CAST($6 AS numeric), CAST($7 AS numeric),
       CAST($8 AS numeric), $9, $10
     )`,
    row.applicationId,
    row.applicationYear,
    row.snapshotVehiclePrice,
    row.snapshotUsefulLifeYears,
    row.snapshotEstimatedAnnualKm,
    row.snapshotPerKmUnitPrice,
    row.snapshotOfficialKm,
    row.snapshotRawAmount,
    row.calculatedAt,
    row.depreciationParameterVersionId
  );
}

/** 草稿列（M2 前後皆為「兩者皆 null」之草稿列）。 */
export async function insertDraftDepreciationRowRaw(
  client: PrismaClient,
  applicationId: string
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO "DepreciationApplication" ("applicationId") VALUES ($1)`,
    applicationId
  );
}
