/**
 * Parameters API client — PHASE-003a-T6
 *
 * Wraps fuel / ETC / depreciation parameter version endpoints.
 * All URLs use /api prefix (nginx proxy → backend, same pattern as users.ts / attachments.ts).
 * Errors are parsed via parseApiResponse → thrown as ApiError (code / message / fields / details).
 */

import {
  type DepreciationParameterDto,
  type EtcParameterDto,
  type FuelPriceVersionDto,
  type FuelType,
  parseApiResponse,
} from "../types/api.js";

// ---- Fuel price (PHASE-005a-T3/T9：油種＋每公升油價，取代舊制 /parameters/fuel) ----

export interface CreateFuelPriceVersionRequest {
  fuelType: FuelType;
  pricePerLiter: string | number;
  effectiveFrom: string; // YYYY-MM-DD
}

export async function apiCreateFuelPriceVersion(
  data: CreateFuelPriceVersionRequest
): Promise<{ version: FuelPriceVersionDto }> {
  const res = await fetch("/api/parameters/fuel-price", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  return parseApiResponse<{ version: FuelPriceVersionDto }>(res);
}

export async function apiGetFuelPriceVersions(): Promise<{ versions: FuelPriceVersionDto[] }> {
  const res = await fetch("/api/parameters/fuel-price", {
    credentials: "include",
  });
  return parseApiResponse<{ versions: FuelPriceVersionDto[] }>(res);
}

// ---- ETC ----

export interface CreateEtcVersionRequest {
  unitPrice: string | number;
  effectiveFrom: string;
}

export async function apiCreateEtcVersion(
  data: CreateEtcVersionRequest
): Promise<{ version: EtcParameterDto }> {
  const res = await fetch("/api/parameters/etc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  return parseApiResponse<{ version: EtcParameterDto }>(res);
}

export async function apiGetEtcVersions(): Promise<{ versions: EtcParameterDto[] }> {
  const res = await fetch("/api/parameters/etc", {
    credentials: "include",
  });
  return parseApiResponse<{ versions: EtcParameterDto[] }>(res);
}

// ---- Depreciation ----

export interface CreateDepreciationVersionRequest {
  vehiclePrice: string | number;
  usefulLifeYears: number;
  estimatedAnnualKm: number;
  effectiveFrom: string;
}

export async function apiCreateDepreciationVersion(
  data: CreateDepreciationVersionRequest
): Promise<{ version: DepreciationParameterDto }> {
  const res = await fetch("/api/parameters/depreciation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  return parseApiResponse<{ version: DepreciationParameterDto }>(res);
}

export async function apiGetDepreciationVersions(): Promise<{
  versions: DepreciationParameterDto[];
}> {
  const res = await fetch("/api/parameters/depreciation", {
    credentials: "include",
  });
  return parseApiResponse<{ versions: DepreciationParameterDto[] }>(res);
}
