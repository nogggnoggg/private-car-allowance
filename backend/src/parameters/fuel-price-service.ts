/**
 * Fuel price service — PHASE-005a-T3
 *
 * 按油種之每公升油價版本 service 層（建立／列表）。
 * Spec §2.A AC-01/02/03/05/06、§7.1、§16 D2(a)/D3(a-1)/D7(a)。
 *
 * **複用義務（AC-06 實作約束逐字）**：金額欄位格式層驗證一律複用
 * `parameter-validation.ts` 之 `parseParameterDecimalField` 與
 * `UNIT_PRICE_CAPACITY`（`Decimal(10,4)`），**不得另寫一套**（避免
 * CHORE-003 已消滅之 500 路徑復活）。重疊判定一律複用
 * `parameter-version-engine.ts` 之 `checkNoOverlap`（AC-02/03 鑑別力：
 * `existing` 由呼叫端以 `fuelType` 收斂查詢後傳入，使跨油種時間軸互不干涉）。
 * 日期解析／格式化複用 `parameter-service.ts` 之 `parseUtcDate`／
 * `formatUtcDate`（PHASE-003a 既有純函式，同形沿用，不重寫日期比較邏輯）。
 *
 * `Decimal` 建構全程以字串／既有 Decimal 值進行（D4 bright-line）；本檔
 * 唯一涉及數值的路徑（`pricePerLiter`）完全交由 `parseParameterDecimalField`
 * 處理，本檔自身不含任何 `Number()`／`parseFloat`／`parseInt`／一元 `+`
 * 數值脅制（AC-28，見 `test/unit/fuel-price-engine.test.ts` 之
 * `PHASE_005A_SRC_FILES` 結構性掃描——本檔已列入該清單）。
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { FuelType } from "@prisma/client";
import type { FieldError } from "../platform/errors.js";
import { AppError } from "../platform/errors.js";
import { formatUtcDate, parseUtcDate } from "./parameter-service.js";
import { UNIT_PRICE_CAPACITY, parseParameterDecimalField } from "./parameter-validation.js";
import { checkNoOverlap } from "./parameter-version-engine.js";

// ---------------------------------------------------------------------------
// Prisma unique-constraint error detection (reused pattern, parameter-service.ts)
// ---------------------------------------------------------------------------

function isPrismaUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "P2002"
  );
}

// ---------------------------------------------------------------------------
// Fuel type enum gate (AC-05：油種列舉封閉)
// ---------------------------------------------------------------------------

/** 固定四項油種（Q4／D2(a)）。 */
const VALID_FUEL_TYPES: readonly string[] = [
  FuelType.GASOLINE_92,
  FuelType.GASOLINE_95,
  FuelType.GASOLINE_98,
  FuelType.DIESEL,
];

const REASON_FUEL_TYPE = "油種必須為 GASOLINE_92、GASOLINE_95、GASOLINE_98 或 DIESEL 之一";

/**
 * 驗證 `fuelType` 是否為四項列舉之一（AC-05）。
 * 任何非此四值之輸入（含未知字串、數字、物件、陣列、`null`、缺欄位）
 * 一律視為驗證失敗，回報 `field: "fuelType"`，**絕不** 500。
 */
function validateFuelType(value: unknown): value is FuelType {
  return typeof value === "string" && VALID_FUEL_TYPES.includes(value);
}

// ---------------------------------------------------------------------------
// DTO types（§7.1 FuelPriceVersionDto）
// ---------------------------------------------------------------------------

export interface FuelPriceVersionDto {
  id: string;
  fuelType: FuelType;
  pricePerLiter: string; // toFixed(4)，Decimal(10,4)
  effectiveFrom: string; // YYYY-MM-DD
  createdAt: string; // ISO
}

type FuelPriceRow = {
  id: string;
  fuelType: FuelType;
  pricePerLiter: Prisma.Decimal;
  effectiveFrom: Date;
  createdAt: Date;
};

export function toFuelPriceDto(row: FuelPriceRow): FuelPriceVersionDto {
  return {
    id: row.id,
    fuelType: row.fuelType,
    pricePerLiter: row.pricePerLiter.toFixed(4), // Decimal(10,4) → 4 位小數（D3(a-1)）
    effectiveFrom: formatUtcDate(row.effectiveFrom),
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// T5-style audit hook（比照 parameter-service.ts 之既有介面）
// ---------------------------------------------------------------------------

export type OnFuelPriceCreated = (
  tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">,
  version: FuelPriceVersionDto
) => Promise<void>;

// ---------------------------------------------------------------------------
// createFuelPriceVersion（AC-01/02/03/05/06）
// ---------------------------------------------------------------------------

export interface CreateFuelPriceVersionInput {
  fuelType: unknown;
  pricePerLiter: unknown;
  effectiveFrom: unknown;
  createdById: string;
}

/**
 * 建立一筆按油種之每公升油價版本。
 *
 * 驗證順序（AC-06 決定性要求）：
 *   1. `fuelType` 列舉封閉（AC-05）
 *   2. `pricePerLiter` 格式層四道（型別 → 十進位字面 → 小數位 → 量級，
 *      複用 `parseParameterDecimalField`／`UNIT_PRICE_CAPACITY`）
 *   3. `pricePerLiter` 值域層（`≥ 0`）
 *   4. `effectiveFrom` 合法日期
 *   5. 同油種重疊檢查（`checkNoOverlap`，AC-02/03）
 *
 * DB `@@unique([fuelType, effectiveFrom])` 為併發最後防線（AC-02 鑑別力）：
 * 併發衝突一律轉譯為 409 `PARAMETER_PERIOD_OVERLAP`，絕不 500。
 */
export async function createFuelPriceVersion(
  prisma: PrismaClient,
  input: CreateFuelPriceVersionInput,
  onCreated?: OnFuelPriceCreated
): Promise<FuelPriceVersionDto> {
  // 1. fuelType 列舉封閉（AC-05）——先於金額欄位判定，避免以「未知油種」
  // 之後又報出無意義的金額錯誤混淆使用者。
  if (!validateFuelType(input.fuelType)) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      { field: "fuelType", reason: REASON_FUEL_TYPE },
    ]);
  }
  const fuelType = input.fuelType;

  // 2/3. pricePerLiter：格式層（複用）→ 值域層（≥0，AC-06 值域列）
  const priceResult = parseParameterDecimalField(
    input.pricePerLiter,
    "pricePerLiter",
    UNIT_PRICE_CAPACITY
  );
  if (!priceResult.ok) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      priceResult.error,
    ]);
  }
  const pricePerLiterDecimal = priceResult.value;

  if (pricePerLiterDecimal.lessThan(0)) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      { field: "pricePerLiter", reason: "單價不得小於 0" },
    ]);
  }

  // 4. effectiveFrom：合法 YYYY-MM-DD（複用 parameter-service.ts:parseUtcDate）
  if (typeof input.effectiveFrom !== "string") {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      { field: "effectiveFrom", reason: "生效日期必須為合法日期（格式：YYYY-MM-DD）" },
    ]);
  }
  const effectiveFromDate = parseUtcDate(input.effectiveFrom);
  if (!effectiveFromDate) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      { field: "effectiveFrom", reason: "生效日期必須為合法日期（格式：YYYY-MM-DD）" },
    ]);
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 5. 同油種重疊檢查（AC-02/03）：existing 以 fuelType 收斂查詢，
      // 使跨油種時間軸互不干涉（AC-03 鑑別力核心）。
      const existing = await tx.fuelPriceVersion.findMany({
        where: { fuelType },
        select: { id: true, effectiveFrom: true },
      });

      const overlapResult = checkNoOverlap(existing, effectiveFromDate);
      if (!overlapResult.ok) {
        throw new AppError(
          "PARAMETER_PERIOD_OVERLAP",
          409,
          "新版本的生效期間與現有版本重疊，請調整生效日期。",
          undefined,
          { conflictVersion: overlapResult.conflict }
        );
      }

      const version = await tx.fuelPriceVersion.create({
        data: {
          fuelType,
          pricePerLiter: pricePerLiterDecimal,
          effectiveFrom: effectiveFromDate,
          createdById: input.createdById,
        },
      });

      const dto = toFuelPriceDto(version);

      if (onCreated) {
        await onCreated(tx, dto);
      }

      return dto;
    });

    return result;
  } catch (err) {
    if (err instanceof AppError) throw err;

    // 併發最後防線（DB @@unique([fuelType, effectiveFrom])）→ 409，絕不 500。
    if (isPrismaUniqueConstraintError(err)) {
      throw new AppError(
        "PARAMETER_PERIOD_OVERLAP",
        409,
        "新版本的生效期間與現有版本重疊（系統偵測到並發衝突）。",
        undefined,
        {
          conflictVersion: {
            fuelType,
            effectiveFrom: input.effectiveFrom,
          },
        }
      );
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// listFuelPriceVersions（§7.1 GET /parameters/fuel-price[?fuelType=]）
// ---------------------------------------------------------------------------

export type ListFuelPriceVersionsResult =
  | { ok: true; versions: FuelPriceVersionDto[] }
  | { ok: false; error: FieldError };

/**
 * 依 `(fuelType, effectiveFrom)` 升冪回傳版本清單；未帶 `fuelType` 回全部。
 * `fuelType` 查詢參數非四項列舉之一 → `{ ok: false }`（呼叫端轉 400）。
 */
export async function listFuelPriceVersions(
  prisma: PrismaClient,
  fuelType?: unknown
): Promise<ListFuelPriceVersionsResult> {
  if (fuelType !== undefined) {
    if (!validateFuelType(fuelType)) {
      return {
        ok: false,
        error: { field: "fuelType", reason: REASON_FUEL_TYPE },
      };
    }
    const rows = await prisma.fuelPriceVersion.findMany({
      where: { fuelType },
      orderBy: [{ fuelType: "asc" }, { effectiveFrom: "asc" }],
    });
    return { ok: true, versions: rows.map(toFuelPriceDto) };
  }

  const rows = await prisma.fuelPriceVersion.findMany({
    orderBy: [{ fuelType: "asc" }, { effectiveFrom: "asc" }],
  });
  return { ok: true, versions: rows.map(toFuelPriceDto) };
}
