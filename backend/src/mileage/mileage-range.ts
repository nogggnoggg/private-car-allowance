/**
 * PHASE-005-T1 — 區間驗證與過濾條件純函式
 *
 * `parseMileageRange`：解析並驗證統計端點的 `dateFrom`/`dateTo`（純函式，不碰
 * DB、不知道「今天」）。依 §16 D5(a) 裁定，兩者皆為**必填**——與
 * `application-query.ts:parseApplicationListQuery`（`dateFrom` 有預設值、
 * `dateTo` 可不設上界）的既有慣例不同，故本函式獨立實作而非直接複用該函式；
 * 但沿用其日期解析工具 `parameter-service.ts:parseUtcDate`（`YYYY-MM-DD` 嚴格
 * 判定、UTC 日粒度）與起>迄錯誤之欄位名慣例（`dateRange`，同
 * `application-query.ts` AC-17）。
 *
 * `buildOfficialMileageWhere`：由已驗證的區間參數建構 Prisma
 * `ApplicationWhereInput`（純函式，供單元測試直接斷言過濾條件形狀）。定案條件
 * 見 Spec §7.3。
 *
 * Spec: docs/specs/PHASE-005.md §7.3、§11.1、AC-01/02/03/04/05/06/08/11/15/16/17
 */
import type { Prisma } from "@prisma/client";
import { parseUtcDate } from "../parameters/parameter-service.js";
import type { FieldError } from "../platform/errors.js";

// ---------------------------------------------------------------------------
// parseMileageRange
// ---------------------------------------------------------------------------

export interface RawMileageRange {
  dateFrom?: string;
  dateTo?: string;
}

export interface ParsedMileageRange {
  errors: FieldError[];
  /** UTC 日粒度；驗證失敗（缺漏／格式錯誤／起>迄）時為 `null`。 */
  dateFrom: Date | null;
  /** UTC 日粒度；驗證失敗時為 `null`。 */
  dateTo: Date | null;
}

/**
 * 解析並驗證區間統計查詢之 `dateFrom`/`dateTo`。
 *
 * - 兩者皆為必填（D5(a)）：缺漏（`undefined` 或空字串）各自回可定位欄位錯誤。
 * - 格式錯誤（非 `YYYY-MM-DD` 或非真實曆日）各自回可定位欄位錯誤。
 * - 僅當兩者皆成功解析時才比較起訖：`dateFrom > dateTo` → `dateRange` 錯誤；
 *   `dateFrom == dateTo` 為合法（單日統計）。
 * - 回傳**全部**欄位錯誤，而非第一項即中止。
 * - 任何錯誤存在時，`dateFrom`/`dateTo` 一律為 `null`（AC-08：「不執行任何查詢、
 *   不回傳任何數值」——上游不得誤用半驗證的日期）。
 */
export function parseMileageRange(raw: RawMileageRange): ParsedMileageRange {
  const errors: FieldError[] = [];

  let dateFrom: Date | null = null;
  if (raw.dateFrom === undefined || raw.dateFrom === "") {
    errors.push({ field: "dateFrom", reason: "起日（dateFrom）為必填" });
  } else {
    const parsed = parseUtcDate(raw.dateFrom);
    if (!parsed) {
      errors.push({ field: "dateFrom", reason: "日期格式錯誤（必須為 YYYY-MM-DD）" });
    } else {
      dateFrom = parsed;
    }
  }

  let dateTo: Date | null = null;
  if (raw.dateTo === undefined || raw.dateTo === "") {
    errors.push({ field: "dateTo", reason: "迄日（dateTo）為必填" });
  } else {
    const parsed = parseUtcDate(raw.dateTo);
    if (!parsed) {
      errors.push({ field: "dateTo", reason: "日期格式錯誤（必須為 YYYY-MM-DD）" });
    } else {
      dateTo = parsed;
    }
  }

  // 僅當兩者皆成功解析為有效日期，才比較起訖（AC-08：dateFrom == dateTo 合法）。
  if (dateFrom !== null && dateTo !== null && dateFrom.getTime() > dateTo.getTime()) {
    errors.push({ field: "dateRange", reason: "起日（dateFrom）不可晚於迄日（dateTo）" });
  }

  if (errors.length > 0) {
    return { errors, dateFrom: null, dateTo: null };
  }

  return { errors, dateFrom, dateTo };
}

// ---------------------------------------------------------------------------
// buildOfficialMileageWhere
// ---------------------------------------------------------------------------

export interface OfficialMileageParams {
  ownerId: string;
  dateFrom: Date;
  dateTo: Date;
}

/**
 * 建構區間公務里程統計之 Prisma where 條件（純函式，不碰 DB）。
 *
 * 定案條件（Spec §7.3、AC-03~06）：
 * - `status: "COMPLETED"`——同時排除 `DRAFT`（AC-03）與 `VOIDED`（AC-04）；
 *   刻意使用字面值等值比對，而非 `{ not: "DRAFT" }` 之類的負向條件（否則
 *   `VOIDED` 會不慎被納入，見 §16 D8）。
 * - `type: "TRAVEL"`（AC-05：排除 MAINTENANCE/DEPRECIATION）。
 * - `travel.tripDate` 以 `gte`/`lte` 表示起訖含當日（AC-01/02）；**不得**用
 *   `gt`/`lt`。
 * - `ownerId` 逐次取自參數，不使用任何預設值（AC-06）。
 */
export function buildOfficialMileageWhere(
  params: OfficialMileageParams
): Prisma.ApplicationWhereInput {
  return {
    ownerId: params.ownerId,
    type: "TRAVEL",
    status: "COMPLETED",
    travel: { tripDate: { gte: params.dateFrom, lte: params.dateTo } },
  };
}
