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
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { AppError } from "../platform/errors.js";
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
 *   - unitPrice ≥ 0 (AC-03)
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
  // Validate unitPrice ≥ 0 (AC-03)
  const priceNum = Number(input.unitPrice);
  if (Number.isNaN(priceNum) || priceNum < 0) {
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
          unitPrice: new Prisma.Decimal(priceNum),
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
 * Structure identical to createFuelVersion — shared validation + no-overlap logic.
 *
 * T5 接入點: pass `onCreated` to inject AuditLog write inside the same transaction.
 */
export async function createEtcVersion(
  prisma: PrismaClient,
  input: CreateEtcVersionInput,
  onCreated?: OnParameterCreated<EtcParameterDto>
): Promise<EtcParameterDto> {
  // Validate unitPrice ≥ 0 (AC-03)
  const priceNum = Number(input.unitPrice);
  if (Number.isNaN(priceNum) || priceNum < 0) {
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
          unitPrice: new Prisma.Decimal(priceNum),
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
