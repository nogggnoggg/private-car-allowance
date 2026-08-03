/**
 * Parameter service — PHASE-003a-T3
 *
 * Shared service layer for Fuel and ETC parameter version operations.
 * Designed for T5 (audit) to inject AuditLog writes within the same transaction
 * by accepting an optional `onCreated` callback executed inside the transaction.
 *
 * Spec §4.1, §4.3 (D4), §5.1, §8.2
 *
 * T5 audit hook (接入點):
 *   Both createFuelVersion and createEtcVersion accept an optional
 *   `onCreated(tx, version)` callback that is called inside the Prisma
 *   interactive transaction, after the version row is inserted but before
 *   the transaction commits. T5 should pass a callback that writes the
 *   AuditLog entry (action=PARAMETER_VERSION_CREATED, D6).
 *
 * CHORE-003-T2（Spec §14，ACTIVE）—— 欄位容量／精度／字串保真守門接線：
 *   三個建立路徑的金額欄位改由 `parameter-validation.ts`（T1 純函式）先過
 *   **格式層**（型別 → 十進位字面 → 小數位 → 欄位容量量級），再進既有
 *   **值域層**（`unitPrice ≥ 0` / `vehiclePrice > 0` / 整數欄位為整數且 > 0）。
 *   §14.2 之固定順序即為此；同一欄位先命中者決定 `reason`，跨欄位仍沿用既有
 *   「一次回報所有違規欄位」行為（AC-05／AC-32）。
 *   目的：消滅 §14.3 B-14／B-17／B-23／B-25 之 500 路徑，並廢止 B-15／B-21 的
 *   靜默精度截斷。route schema 之 accept-any 與 `routes.ts` 的「必填」缺值檢查
 *   **不變**（§14.2「路由層不變」）。
 *
 * CHORE-003-T3（AC-29／AR-5 閉環）—— 金額字串路徑保真不變式：
 *   `unitPrice`／`vehiclePrice` **自輸入到 `Prisma.Decimal` 建構之間不得經過任何
 *   浮點中介**：格式層一律以原字串（`number` 輸入則以 `.toString()`）建構，值域
 *   比較亦改以 `Prisma.Decimal` 方法（`lessThan`／`lte`）進行。CHORE-002 時期的
 *   `const priceNum = Number(input.unitPrice)` 中介已完全移除。
 *
 *   本檔僅存的 `Number(...)` 呼叫在 `parseUtcDate()` 內（`effectiveFrom` 之
 *   `YYYY-MM-DD` 分段轉整數），與金額輸入無關；`Number.isFinite`／
 *   `Number.isInteger` 則是折舊整數欄位（`usefulLifeYears`／`estimatedAnnualKm`，
 *   本就是 `number` 型別）之既有值域述詞，兩者皆不在 AC-29 的禁止範圍。
 *
 *   此不變式由 `test/integration/chore003-string-fidelity.test.ts` 的**結構性
 *   靜態斷言**守住（掃描本目錄原始碼、以白名單固定上述 3 個日期用呼叫）——
 *   之所以不能用行為測試守，是因為兩個欄位的容量（`Decimal(10,4)` ≤10 位、
 *   `Decimal(12,2)` ≤12 位有效數字）都在 double 無損往返的 15 位之內，浮點中介
 *   在合法輸入下**不可觀測**（AR-5 判定，該測試檔 §3 有可執行實證）。
 *   → 若日後有人在金額路徑加回 `Number()`，該測試會轉紅並指出違規呼叫。
 */

import type { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import type { FieldError } from "../platform/errors.js";
import { AppError } from "../platform/errors.js";
import { deriveDepreciation } from "./depreciation-engine.js";
import {
  DEPRECIATION_VEHICLE_PRICE_CAPACITY,
  UNIT_PRICE_CAPACITY,
  parseParameterDecimalField,
  parseParameterIntField,
} from "./parameter-validation.js";
import { checkNoOverlap } from "./parameter-version-engine.js";

// ---------------------------------------------------------------------------
// Prisma unique-constraint error detection (reused from admin/routes.ts pattern)
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
// Date utilities
// ---------------------------------------------------------------------------

/**
 * Parse a date string (YYYY-MM-DD) and return a UTC midnight Date.
 * Returns null if the string is not a valid date.
 *
 * We validate strictly: must match YYYY-MM-DD format and produce a
 * real calendar date (no 2026-02-30, etc.).
 */
export function parseUtcDate(dateStr: string): Date | null {
  // Must match YYYY-MM-DD
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;
  const [, yStr, mStr, dStr] = match;
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  // Reconstruct and verify — Date handles invalid days by rolling over
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) {
    return null;
  }
  return date;
}

/**
 * Format a Date as "YYYY-MM-DD" using UTC components.
 * Used for DTO output (AC-19: effectiveFrom as YYYY-MM-DD string).
 */
export function formatUtcDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// DTO types
// ---------------------------------------------------------------------------

export interface FuelParameterDto {
  id: string;
  unitPrice: string; // Decimal as string to avoid float imprecision (D8)
  effectiveFrom: string; // YYYY-MM-DD
  createdAt: string; // ISO timestamp
}

export interface EtcParameterDto {
  id: string;
  unitPrice: string;
  effectiveFrom: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Raw DB row → DTO mappers
// ---------------------------------------------------------------------------

type FuelRow = {
  id: string;
  unitPrice: Prisma.Decimal;
  effectiveFrom: Date;
  createdAt: Date;
};

type EtcRow = {
  id: string;
  unitPrice: Prisma.Decimal;
  effectiveFrom: Date;
  createdAt: Date;
};

export function toFuelDto(row: FuelRow): FuelParameterDto {
  return {
    id: row.id,
    unitPrice: row.unitPrice.toFixed(4), // Decimal(10,4) → 4 decimal places, D8
    effectiveFrom: formatUtcDate(row.effectiveFrom),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toEtcDto(row: EtcRow): EtcParameterDto {
  return {
    id: row.id,
    unitPrice: row.unitPrice.toFixed(4),
    effectiveFrom: formatUtcDate(row.effectiveFrom),
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// D4 bright-line: number → Decimal-safe string conversion
// ---------------------------------------------------------------------------

/**
 * Converts a `number | string` amount into a string suitable for the
 * `Prisma.Decimal` constructor, closing the last "number 變數建構" gap of the
 * D4 bright-line (Spec D8: 一律非浮點).
 *
 * - string input: returned as-is — already a decimal literal, no float
 *   mediation ever occurs for the string path.
 * - number input: converted via `String(value)` rather than handed directly
 *   to `new Prisma.Decimal(value)`.
 *
 * 本版 decimal.js 的建構子對 number 引數內部已先做 toString() 才解析，
 * 因此 `new Decimal(value)` 與 `new Decimal(String(value))` 對所有 number
 * 皆為恆等變換（含科學記號輸入 —— decimal.js 完整支援解析 "1e+21" 這類
 * 字面值）。此函式仍保留「一律先字串化」這一步，不是為了修正當前版本的
 * 行為差異（沒有差異），而是讓 D4 bright-line（一律非浮點）不依賴這個
 * 實作細節本身 —— 未來若更換十進位運算函式庫或升版、且新版建構子改為
 * 直接讀取 number 的二進位值，這裡的轉換仍會保護既有行為不變。
 *
 * 可重跑驗證（直擊實際建構子 Prisma.Decimal，而非其底層 decimal.js，
 * 確保驗證的是本專案實際使用的路徑）：
 *   node -e "const {Prisma}=require('@prisma/client'); console.log(new Prisma.Decimal(0.1).toString()===new Prisma.Decimal('0.1').toString())"
 *   → true
 *
 * CHORE-003-T2 現況說明（避免註解與實作背離）：本模組的三個建立路徑已改由
 * `parameter-validation.ts` 的 `parseParameterDecimalField()` 完成字串化與
 * `Prisma.Decimal` 建構（同樣是「一律以字串建構」，且額外加上四道格式守門），
 * 故本函式目前**不再被 `parameter-service.ts` 內部呼叫**。它維持具名匯出乃因
 * `chore002-d4-decimal-number.test.ts` 之單元段落直接測試此 helper 的恆等變換
 * 契約（PHASE-003a Spec §14.7 備註明列：移除匯出屬「破壞既有測試」）。
 */
export function toDecimalConstructorArg(value: number | string): string {
  if (typeof value === "string") return value;
  return String(value);
}

// ---------------------------------------------------------------------------
// T5 audit hook type
// ---------------------------------------------------------------------------

/** T5 接入點: callback called inside the transaction after insert, before commit */
export type OnParameterCreated<T> = (
  tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">,
  version: T
) => Promise<void>;

// ---------------------------------------------------------------------------
// createFuelVersion
// ---------------------------------------------------------------------------

export interface CreateFuelVersionInput {
  unitPrice: number | string;
  effectiveFrom: string; // YYYY-MM-DD
  createdById: string;
}

/**
 * Creates a new FuelParameterVersion.
 *
 * Validates:
 *   - unitPrice 格式層：型別／十進位字面／≤4 位小數／|value| < 1e6（AC-21/23/25/26/27）
 *   - unitPrice ≥ 0 (AC-03) —— 值域層，以 `Prisma.Decimal` 比較
 *   - effectiveFrom is a valid YYYY-MM-DD date (AC-06)
 *   - No overlap with existing versions via checkNoOverlap (AC-07)
 *
 * DB @@unique(effectiveFrom) serves as the concurrent last-resort guard (D4).
 * Both service-layer and DB constraint violations are surfaced as
 * PARAMETER_PERIOD_OVERLAP (409), never as raw DB errors.
 *
 * T5 接入點: pass `onCreated` to inject AuditLog write inside the same transaction.
 *
 * @returns the created DTO
 */
export async function createFuelVersion(
  prisma: PrismaClient,
  input: CreateFuelVersionInput,
  onCreated?: OnParameterCreated<FuelParameterDto>
): Promise<FuelParameterDto> {
  // CHORE-003-T2: 格式層先行（型別 → 十進位字面 → 小數位 → 欄位容量量級），
  // 上限常數綁 `Decimal(10, 4)` 之容量推導（見 parameter-validation.ts），不寫死魔術數。
  // 這一步取代了原本的 `Number(input.unitPrice)`：accept-any route 送進來的
  // boolean／array／全空白字串等值不再被 `Number()` 悄悄脅制成數字寫入 DB（B-07~B-10），
  // 且 ≥1e6／>4 位小數／`Infinity` 等值在進入交易前即被擋下（B-14／B-15／B-17）。
  const priceResult = parseParameterDecimalField(input.unitPrice, "unitPrice", UNIT_PRICE_CAPACITY);
  if (!priceResult.ok) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      priceResult.error,
    ]);
  }
  const unitPriceDecimal = priceResult.value;

  // 值域層（既有語意不變，AC-03／AC-30）：`unitPrice ≥ 0`。比較改以 `Prisma.Decimal`
  // 方法進行——字串輸入路徑上不再有任何對輸入的 `Number()` 呼叫（§14.2 字串保真）。
  if (unitPriceDecimal.lessThan(0)) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      { field: "unitPrice", reason: "單價不得小於 0" },
    ]);
  }

  // Validate effectiveFrom (AC-06)
  const effectiveFromDate = parseUtcDate(input.effectiveFrom);
  if (!effectiveFromDate) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      { field: "effectiveFrom", reason: "生效日期必須為合法日期（格式：YYYY-MM-DD）" },
    ]);
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Fetch ALL existing fuel versions inside transaction (D4 / T2 New Risk note)
      const existing = await tx.fuelParameterVersion.findMany({
        select: { id: true, effectiveFrom: true },
      });

      // Check no-overlap (AC-07)
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

      // Create
      const version = await tx.fuelParameterVersion.create({
        data: {
          // 已由格式層以字串建構完成的 Decimal（D4 bright-line：一律非浮點）。
          unitPrice: unitPriceDecimal,
          effectiveFrom: effectiveFromDate,
          createdById: input.createdById,
        },
      });

      const dto = toFuelDto(version);

      // T5 接入點: call audit hook inside same transaction
      if (onCreated) {
        await onCreated(tx, dto);
      }

      return dto;
    });

    return result;
  } catch (err) {
    // Re-throw AppError as-is (overlap or validation)
    if (err instanceof AppError) throw err;

    // Capture DB unique-constraint violation (concurrent create, D4)
    if (isPrismaUniqueConstraintError(err)) {
      throw new AppError(
        "PARAMETER_PERIOD_OVERLAP",
        409,
        "新版本的生效期間與現有版本重疊（系統偵測到並發衝突）。",
        undefined,
        { conflictVersion: { effectiveFrom: input.effectiveFrom } }
      );
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// listFuelVersions
// ---------------------------------------------------------------------------

/**
 * Returns all FuelParameterVersion records sorted by effectiveFrom ascending (AC-19).
 */
export async function listFuelVersions(prisma: PrismaClient): Promise<FuelParameterDto[]> {
  const rows = await prisma.fuelParameterVersion.findMany({
    orderBy: { effectiveFrom: "asc" },
  });
  return rows.map(toFuelDto);
}

// ---------------------------------------------------------------------------
// createEtcVersion
// ---------------------------------------------------------------------------

export interface CreateEtcVersionInput {
  unitPrice: number | string;
  effectiveFrom: string;
  createdById: string;
}

/**
 * Creates a new EtcParameterVersion.
 * Structure identical to createFuelVersion — shared validation + no-overlap logic
 * （含 CHORE-003-T2 之格式層／值域層兩段，兩端點共用同一組欄位容量常數）。
 *
 * T5 接入點: pass `onCreated` to inject AuditLog write inside the same transaction.
 */
export async function createEtcVersion(
  prisma: PrismaClient,
  input: CreateEtcVersionInput,
  onCreated?: OnParameterCreated<EtcParameterDto>
): Promise<EtcParameterDto> {
  // CHORE-003-T2: 與 createFuelVersion 完全同形的兩層驗證（格式層 → 值域層）。
  // 同一組守門常數（`Decimal(10, 4)`）確保兩端點行為一致（AC-21／AC-23）。
  const priceResult = parseParameterDecimalField(input.unitPrice, "unitPrice", UNIT_PRICE_CAPACITY);
  if (!priceResult.ok) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      priceResult.error,
    ]);
  }
  const unitPriceDecimal = priceResult.value;

  // 值域層（既有語意不變，AC-03／AC-30）：`unitPrice ≥ 0`，以 `Prisma.Decimal` 比較。
  if (unitPriceDecimal.lessThan(0)) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      { field: "unitPrice", reason: "單價不得小於 0" },
    ]);
  }

  // Validate effectiveFrom (AC-06)
  const effectiveFromDate = parseUtcDate(input.effectiveFrom);
  if (!effectiveFromDate) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      { field: "effectiveFrom", reason: "生效日期必須為合法日期（格式：YYYY-MM-DD）" },
    ]);
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Fetch ALL existing ETC versions inside transaction
      const existing = await tx.etcParameterVersion.findMany({
        select: { id: true, effectiveFrom: true },
      });

      // Check no-overlap (AC-07)
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

      // Create
      const version = await tx.etcParameterVersion.create({
        data: {
          // 已由格式層以字串建構完成的 Decimal（D4 bright-line：一律非浮點）。
          unitPrice: unitPriceDecimal,
          effectiveFrom: effectiveFromDate,
          createdById: input.createdById,
        },
      });

      const dto = toEtcDto(version);

      // T5 接入點: call audit hook inside same transaction
      if (onCreated) {
        await onCreated(tx, dto);
      }

      return dto;
    });

    return result;
  } catch (err) {
    if (err instanceof AppError) throw err;

    if (isPrismaUniqueConstraintError(err)) {
      throw new AppError(
        "PARAMETER_PERIOD_OVERLAP",
        409,
        "新版本的生效期間與現有版本重疊（系統偵測到並發衝突）。",
        undefined,
        { conflictVersion: { effectiveFrom: input.effectiveFrom } }
      );
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// listEtcVersions
// ---------------------------------------------------------------------------

/**
 * Returns all EtcParameterVersion records sorted by effectiveFrom ascending (AC-19).
 */
export async function listEtcVersions(prisma: PrismaClient): Promise<EtcParameterDto[]> {
  const rows = await prisma.etcParameterVersion.findMany({
    orderBy: { effectiveFrom: "asc" },
  });
  return rows.map(toEtcDto);
}

// ---------------------------------------------------------------------------
// DepreciationParameterDto
// ---------------------------------------------------------------------------

export interface DepreciationParameterDto {
  id: string;
  vehiclePrice: string; // Decimal(12,2) as string, 2 decimal places (D8)
  usefulLifeYears: number;
  estimatedAnnualKm: number;
  effectiveFrom: string; // YYYY-MM-DD
  createdAt: string; // ISO timestamp
  derived: {
    annualDepreciation: string; // round_half_up(vehiclePrice / usefulLifeYears, 2) — display 2 dp (D3)
    perKmUnitPrice: string; // round_half_up(vehiclePrice/usefulLifeYears/estimatedAnnualKm, 4) — display 4 dp (D3)
  };
}

// ---------------------------------------------------------------------------
// Raw DB row → DTO mapper for depreciation
// ---------------------------------------------------------------------------

type DepreciationRow = {
  id: string;
  vehiclePrice: Prisma.Decimal;
  usefulLifeYears: number;
  estimatedAnnualKm: number;
  effectiveFrom: Date;
  createdAt: Date;
};

export function toDepreciationDto(row: DepreciationRow): DepreciationParameterDto {
  // Derive the non-persisted fields (D7: not stored in DB, calculated on-the-fly)
  const derivationResult = deriveDepreciation({
    vehiclePrice: row.vehiclePrice,
    usefulLifeYears: row.usefulLifeYears,
    estimatedAnnualKm: row.estimatedAnnualKm,
  });

  // Since values are already validated as > 0 before saving, this should always succeed.
  // If somehow it fails (shouldn't happen), derive a safe fallback to avoid runtime crash.
  const derived = derivationResult.ok
    ? derivationResult
    : { annualDepreciation: "0.00", perKmUnitPrice: "0.0000" };

  return {
    id: row.id,
    vehiclePrice: row.vehiclePrice.toFixed(2), // Decimal(12,2) → 2 decimal places (D8)
    usefulLifeYears: row.usefulLifeYears,
    estimatedAnnualKm: row.estimatedAnnualKm,
    effectiveFrom: formatUtcDate(row.effectiveFrom),
    createdAt: row.createdAt.toISOString(),
    derived: {
      annualDepreciation: derived.annualDepreciation,
      perKmUnitPrice: derived.perKmUnitPrice,
    },
  };
}

// ---------------------------------------------------------------------------
// createDepreciationVersion
// ---------------------------------------------------------------------------

export interface CreateDepreciationVersionInput {
  vehiclePrice: number | string;
  usefulLifeYears: number;
  estimatedAnnualKm: number;
  effectiveFrom: string; // YYYY-MM-DD
  createdById: string;
}

/**
 * Creates a new DepreciationParameterVersion.
 *
 * Validates:
 *   - vehiclePrice 格式層：型別／十進位字面／≤2 位小數／|value| < 1e10（AC-22/24/25/26/27）
 *   - vehiclePrice > 0 (AC-05) —— 值域層，以 `Prisma.Decimal` 比較
 *   - usefulLifeYears ≤ 2147483647（int4 容量，AC-28）且 > 0 and integer (AC-05, D8)
 *   - estimatedAnnualKm ≤ 2147483647（int4 容量，AC-28）且 > 0 and integer (AC-05, D8)
 *   - effectiveFrom is a valid YYYY-MM-DD date (AC-06)
 *   - No overlap with existing versions via checkNoOverlap (AC-08)
 *
 * DB @@unique(effectiveFrom) serves as the concurrent last-resort guard (D4).
 * Both service-layer and DB constraint violations are surfaced as
 * PARAMETER_PERIOD_OVERLAP (409), never as raw DB errors.
 *
 * derived fields are computed on-the-fly (D7: not persisted).
 *
 * T5 接入點: pass `onCreated` to inject AuditLog write inside the same transaction.
 *
 * @returns the created DTO (including derived)
 */
export async function createDepreciationVersion(
  prisma: PrismaClient,
  input: CreateDepreciationVersionInput,
  onCreated?: OnParameterCreated<DepreciationParameterDto>
): Promise<DepreciationParameterDto> {
  // Collect all validation errors to report together (AC-05: 精確指違規欄位，可多個)
  // CHORE-003-T2：跨欄位彙總行為維持不變（AC-05／AC-32 後半）；每個欄位內部則為
  // **first-hit**——格式層命中即不再追加該欄位的值域層文案。
  const fieldErrors: FieldError[] = [];

  // vehiclePrice：格式層（型別／字面／2 位小數／< 1e10 量級）→ 值域層（> 0）。
  // 取代原本的 `new Prisma.Decimal(...)` + try/catch：那個 catch 分支既擋不住
  // `"Infinity"`（Decimal 建構不拋錯 → 進 DB → 500，B-14）、也擋不住 ≥1e10（B-23），
  // 且會讓 `"600000.005"` 靜默進位存成 `600000.01`（B-21）。
  let vehiclePriceDecimal: Prisma.Decimal | null = null;
  const vehiclePriceResult = parseParameterDecimalField(
    input.vehiclePrice,
    "vehiclePrice",
    DEPRECIATION_VEHICLE_PRICE_CAPACITY
  );
  if (!vehiclePriceResult.ok) {
    fieldErrors.push(vehiclePriceResult.error);
  } else if (vehiclePriceResult.value.lte(0)) {
    // 值域層文案不變（AC-05／AC-30）
    fieldErrors.push({ field: "vehiclePrice", reason: "必須大於 0" });
  } else {
    vehiclePriceDecimal = vehiclePriceResult.value;
  }

  // usefulLifeYears：int4 容量守門（CD-3(a)／AC-28）先於既有值域層。
  // `parseParameterIntField` 的 `{ ok: true, value: null }` 意為「容量守門不適用」
  // （非 number／非有限值），一律往下交既有值域層判定，其行為與文案完全不變。
  const usefulLifeYearsResult = parseParameterIntField(input.usefulLifeYears, "usefulLifeYears");
  if (!usefulLifeYearsResult.ok) {
    fieldErrors.push(usefulLifeYearsResult.error);
  } else if (
    // Validate usefulLifeYears > 0 and integer (AC-05, D8) —— 既有邏輯逐字不變
    typeof input.usefulLifeYears !== "number" ||
    !Number.isFinite(input.usefulLifeYears) ||
    !Number.isInteger(input.usefulLifeYears) ||
    input.usefulLifeYears <= 0
  ) {
    if (!Number.isInteger(input.usefulLifeYears) && input.usefulLifeYears > 0) {
      fieldErrors.push({ field: "usefulLifeYears", reason: "必須為整數且大於 0" });
    } else {
      fieldErrors.push({ field: "usefulLifeYears", reason: "必須大於 0" });
    }
  }

  // estimatedAnnualKm：同上。
  const estimatedAnnualKmResult = parseParameterIntField(
    input.estimatedAnnualKm,
    "estimatedAnnualKm"
  );
  if (!estimatedAnnualKmResult.ok) {
    fieldErrors.push(estimatedAnnualKmResult.error);
  } else if (
    // Validate estimatedAnnualKm > 0 and integer (AC-05, D8) —— 既有邏輯逐字不變
    typeof input.estimatedAnnualKm !== "number" ||
    !Number.isFinite(input.estimatedAnnualKm) ||
    !Number.isInteger(input.estimatedAnnualKm) ||
    input.estimatedAnnualKm <= 0
  ) {
    if (!Number.isInteger(input.estimatedAnnualKm) && input.estimatedAnnualKm > 0) {
      fieldErrors.push({ field: "estimatedAnnualKm", reason: "必須為整數且大於 0" });
    } else {
      fieldErrors.push({ field: "estimatedAnnualKm", reason: "必須大於 0" });
    }
  }

  // Validate effectiveFrom (AC-06)
  const effectiveFromDate = parseUtcDate(input.effectiveFrom);
  if (!effectiveFromDate) {
    fieldErrors.push({
      field: "effectiveFrom",
      reason: "生效日期必須為合法日期（格式：YYYY-MM-DD）",
    });
  }

  // If any field errors, throw VALIDATION_ERROR immediately (AC-05/06)
  // Do NOT perform derivation when inputs are invalid (AC-05: 不進行推導計算，避免除以 0)
  if (fieldErrors.length > 0) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", fieldErrors);
  }

  // At this point all values are validated; effectiveFromDate is non-null
  const validEffectiveFrom = effectiveFromDate as Date;
  // 同理 vehiclePriceDecimal：只有在格式層與值域層都通過時才會被賦值，而任一未通過
  // 都會在上面的 fieldErrors 檢查處丟出——故此處必為非 null（取代原本的 "0" placeholder）。
  const validVehiclePrice = vehiclePriceDecimal as Prisma.Decimal;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Fetch ALL existing depreciation versions inside transaction (D4)
      const existing = await tx.depreciationParameterVersion.findMany({
        select: { id: true, effectiveFrom: true },
      });

      // Check no-overlap (AC-08)
      const overlapResult = checkNoOverlap(existing, validEffectiveFrom);
      if (!overlapResult.ok) {
        throw new AppError(
          "PARAMETER_PERIOD_OVERLAP",
          409,
          "新版本的生效期間與現有版本重疊，請調整生效日期。",
          undefined,
          { conflictVersion: overlapResult.conflict }
        );
      }

      // Create
      const version = await tx.depreciationParameterVersion.create({
        data: {
          vehiclePrice: validVehiclePrice,
          usefulLifeYears: input.usefulLifeYears,
          estimatedAnnualKm: input.estimatedAnnualKm,
          effectiveFrom: validEffectiveFrom,
          createdById: input.createdById,
        },
      });

      const dto = toDepreciationDto(version);

      // T5 接入點: call audit hook inside same transaction
      if (onCreated) {
        await onCreated(tx, dto);
      }

      return dto;
    });

    return result;
  } catch (err) {
    // Re-throw AppError as-is (overlap or validation)
    if (err instanceof AppError) throw err;

    // Capture DB unique-constraint violation (concurrent create, D4)
    if (isPrismaUniqueConstraintError(err)) {
      throw new AppError(
        "PARAMETER_PERIOD_OVERLAP",
        409,
        "新版本的生效期間與現有版本重疊（系統偵測到並發衝突）。",
        undefined,
        { conflictVersion: { effectiveFrom: input.effectiveFrom } }
      );
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// listDepreciationVersions
// ---------------------------------------------------------------------------

/**
 * Returns all DepreciationParameterVersion records sorted by effectiveFrom ascending (AC-19).
 * Each version includes derived fields (annualDepreciation, perKmUnitPrice) computed on-the-fly (D7).
 */
export async function listDepreciationVersions(
  prisma: PrismaClient
): Promise<DepreciationParameterDto[]> {
  const rows = await prisma.depreciationParameterVersion.findMany({
    orderBy: { effectiveFrom: "asc" },
  });
  return rows.map(toDepreciationDto);
}
