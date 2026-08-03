/**
 * PHASE-005-T2 — 引擎 DB 聚合：`sumOfficialMileage`
 *
 * 狀態／類型／擁有人過濾（沿用 T1 之 `buildOfficialMileageWhere`，單一真相
 * 來源，本檔不重寫過濾條件）+ 里程加總。
 *
 * 里程來源依 Gate 定案 D2(a)：讀 `TravelApplication.snapshotTotalKm`（單表聚合，
 * 完成時已寫入「Σ 各段 totalKm」，見 PHASE-004 AC-50）。DB 層聚合
 * （`aggregate`），不將命中集合讀入記憶體相加、不 N+1（AC-33 方向；正式驗證
 * 屬 T3）。
 *
 * D3(a)：內部運算全程 `Prisma.Decimal`，禁止浮點中介——`_sum` 由 PostgreSQL
 * 之 `numeric` 型別於 DB 端加總，Prisma 以 `Decimal` 物件回傳，JS 端從不將其
 * 轉為 `number`。
 *
 * 唯讀；簽章接受 `PrismaClient | Prisma.TransactionClient`（AC-12 屬 T3 驗證，
 * 簽章自本 Task 即定型）。
 *
 * Spec: docs/specs/PHASE-005.md §7.3、§8、AC-03/04/05/06/07
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { type OfficialMileageParams, buildOfficialMileageWhere } from "./mileage-range.js";

export type { OfficialMileageParams } from "./mileage-range.js";

export type PrismaLike = PrismaClient | Prisma.TransactionClient;

export interface OfficialMileageResult {
  totalKm: Prisma.Decimal;
  applicationCount: number;
}

/**
 * 聚合區間內指定擁有人之「已完成公務差旅」里程總和（AC-03~07）。
 *
 * 查詢由 `TravelApplication` 出發（聚合對象 `snapshotTotalKm` 落點於此表），
 * 以 `application: <T1 建構之 where>` 銜接父列過濾（狀態／類型／擁有人）——
 * `buildOfficialMileageWhere` 回傳之物件原樣沿用、不重寫其內部條件。
 *
 * - `type=MAINTENANCE`／`DEPRECIATION` 之 `Application` 目前無 `TravelApplication`
 *   子列（子表尚不存在，AC-05），此查詢天然不會命中、也不會因此拋錯——
 *   聚合以 `TravelApplication` 為主表，沒有子列即沒有列可聚合。
 * - `_sum.snapshotTotalKm` 於命中集合為空時為 `null`；以 `Decimal("0")` 補上，
 *   語意為「區間內無已完成差旅」。
 */
export async function sumOfficialMileage(
  db: PrismaLike,
  params: OfficialMileageParams
): Promise<OfficialMileageResult> {
  const where = buildOfficialMileageWhere(params);

  const aggregate = await db.travelApplication.aggregate({
    where: { application: where },
    _sum: { snapshotTotalKm: true },
    _count: { _all: true },
  });

  return {
    totalKm: aggregate._sum.snapshotTotalKm ?? new Prisma.Decimal("0"),
    applicationCount: aggregate._count._all,
  };
}
