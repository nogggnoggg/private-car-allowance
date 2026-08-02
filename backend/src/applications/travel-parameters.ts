/**
 * Travel parameter resolution — PHASE-004-T7
 *
 * Spec §2 群組 G（AC-45~48）、§5 邊界 B-09~B-12、§8.5 新增 ErrorCode
 * `PARAMETER_NOT_AVAILABLE`（409）、§9「金額預覽（stateless）」+「完成申請」
 * Data Flow、§10.2（該類全部版本 `findMany` 後純函式選版）、§17.1 D6/D8。
 *
 * 依出差日期解析當日有效之油資／ETC 版本。**必須複用**
 * `../parameters/parameter-version-engine.ts` 的 `findEffectiveVersion`
 * （PHASE-003a 已批准的選版純函式，不得重寫）；比照 PHASE-003a
 * `parameter-service.ts` 的既有作法：先 `findMany` 取得該類**全部**版本，
 * 再交給純函式選版——不得在 DB 層（`where: { effectiveFrom: { lte: ... } }`
 * 之類）先過濾，以免與 003a 的日粒度語意分歧（Packet 明文）。
 *
 * `resolveTravelParameters` 接受 `PrismaClient | Prisma.TransactionClient`
 * （`PrismaClientOrTx`），供 T8 在完成流程的交易內原樣傳入 `tx` 呼叫。
 *
 * `assertParametersAvailable` 是純函式（zero IO，同 `application-state-machine.ts`
 * / `completion-blockers.ts` 的形狀）：接受已解析好的 `ResolvedParameters`，
 * 缺任一參數即拋 `AppError("PARAMETER_NOT_AVAILABLE", 409, ...)`
 * （`details.missing` / `details.tripDate`，AC-47）。供 T8 完成流程直接呼叫；
 * 本 Task 只寫單元測試，不接線任何完成端點（Packet 明文：本 Task 不實作
 * 完成端點）。
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { formatUtcDate } from "../parameters/parameter-service.js";
import { findEffectiveVersion } from "../parameters/parameter-version-engine.js";
import { AppError } from "../platform/errors.js";

/** Accepts either a plain PrismaClient or a `$transaction` callback's `tx` param (mirrors `PrismaTxLike` in attachment/lifecycle-service.ts). */
export type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

export interface ResolvedParameters {
  fuelUnitPrice: Prisma.Decimal | null;
  etcUnitPrice: Prisma.Decimal | null;
  fuelVersionId: string | null;
  etcVersionId: string | null;
  missing: ("FUEL" | "ETC")[];
}

/**
 * 依出差日期解析當日有效之油資／ETC 版本。
 *
 * `tripDate = null` → 兩者皆視為缺（`missing = ["FUEL","ETC"]`），且刻意
 * **不查詢 DB**（草稿尚未填出差日期時，查了也永遠選不到任何版本 —
 * `findEffectiveVersion` 對任何 `queryDate` 皆須有值，`null` 沒有對應語意）。
 *
 * 含當日語意（B-09/B-10）完全由 `findEffectiveVersion` 保證，本函式不重寫
 * 任何日期比較邏輯。
 */
export async function resolveTravelParameters(
  prisma: PrismaClientOrTx,
  tripDate: Date | null
): Promise<ResolvedParameters> {
  if (tripDate === null) {
    return {
      fuelUnitPrice: null,
      etcUnitPrice: null,
      fuelVersionId: null,
      etcVersionId: null,
      missing: ["FUEL", "ETC"],
    };
  }

  // Spec §10.2 / Packet：該類全部版本 findMany 後由純函式選版，不得先在 DB 層過濾。
  const [fuelVersions, etcVersions] = await Promise.all([
    prisma.fuelParameterVersion.findMany({
      select: { id: true, effectiveFrom: true, unitPrice: true },
    }),
    prisma.etcParameterVersion.findMany({
      select: { id: true, effectiveFrom: true, unitPrice: true },
    }),
  ]);

  const fuel = findEffectiveVersion(fuelVersions, tripDate);
  const etc = findEffectiveVersion(etcVersions, tripDate);

  const missing: ("FUEL" | "ETC")[] = [];
  if (!fuel) missing.push("FUEL");
  if (!etc) missing.push("ETC");

  return {
    fuelUnitPrice: fuel ? fuel.unitPrice : null,
    etcUnitPrice: etc ? etc.unitPrice : null,
    fuelVersionId: fuel ? fuel.id : null,
    etcVersionId: etc ? etc.id : null,
    missing,
  };
}

/**
 * 缺任一參數不得完成（AC-47）。純函式，供 T8 完成流程直接呼叫
 * （T8 之前無任何呼叫端——本 Task 不實作完成端點，只提供此函式 + 單元測試）。
 *
 * `details.tripDate`：格式化為 `YYYY-MM-DD`（沿用 PHASE-003a `formatUtcDate`），
 * `tripDate=null` 時原樣回 `null`（呼叫端已用 `resolveTravelParameters`
 * 算好 `missing`，本函式不重新判斷 tripDate 是否為 null 這件事本身）。
 */
export function assertParametersAvailable(
  resolved: ResolvedParameters,
  tripDate: Date | null
): void {
  if (resolved.missing.length === 0) return;

  throw new AppError(
    "PARAMETER_NOT_AVAILABLE",
    409,
    "該出差日期尚無有效補助參數，請聯絡管理員設定。",
    undefined,
    {
      missing: resolved.missing,
      tripDate: tripDate ? formatUtcDate(tripDate) : null,
    }
  );
}
