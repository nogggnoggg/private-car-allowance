/**
 * User fuel-consumption API client — PHASE-005a-T10
 *
 * Wraps the admin-only fuel-consumption version endpoints (§7.2, backend
 * T4/T5：backend/src/users/fuel-consumption-routes.ts).
 * All URLs use /api prefix (nginx proxy → backend, same pattern as
 * users.ts / parameters.ts). Errors are parsed via parseApiResponse →
 * thrown as ApiError (code / message / fields / details).
 */

import { type FuelConsumptionVersionDto, type FuelType, parseApiResponse } from "../types/api.js";

export interface CreateFuelConsumptionVersionRequest {
  fuelType: FuelType;
  kmPerLiter: string | number;
  effectiveFrom: string; // YYYY-MM-DD
  basisNote: string;
}

export async function apiCreateFuelConsumptionVersion(
  userId: string,
  data: CreateFuelConsumptionVersionRequest
): Promise<{ version: FuelConsumptionVersionDto }> {
  const res = await fetch(`/api/users/${userId}/fuel-consumption`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  return parseApiResponse<{ version: FuelConsumptionVersionDto }>(res);
}

export async function apiGetFuelConsumptionVersions(
  userId: string
): Promise<{ versions: FuelConsumptionVersionDto[] }> {
  const res = await fetch(`/api/users/${userId}/fuel-consumption`, {
    credentials: "include",
  });
  return parseApiResponse<{ versions: FuelConsumptionVersionDto[] }>(res);
}
