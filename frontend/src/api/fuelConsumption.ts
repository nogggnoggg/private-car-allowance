/**
 * User fuel-consumption API client — PHASE-005a-T10 / T11
 *
 * Wraps the admin-only fuel-consumption version endpoints (§7.2, backend
 * T4/T5：backend/src/users/fuel-consumption-routes.ts) plus (T11) the
 * self-only read endpoint `GET /me/fuel-consumption`（backend T6）.
 * All URLs use /api prefix (nginx proxy → backend, same pattern as
 * users.ts / parameters.ts). Errors are parsed via parseApiResponse →
 * thrown as ApiError (code / message / fields / details).
 */

import {
  type FuelConsumptionVersionDto,
  type FuelType,
  type MyFuelConsumptionDto,
  parseApiResponse,
} from "../types/api.js";

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

// ---------------------------------------------------------------------------
// GET /me/fuel-consumption — self read-only (AC-31, T11). No :userId — the
// backend derives the caller from the session (see route JSDoc, §16 D7(a)).
// ---------------------------------------------------------------------------

export async function apiGetMyFuelConsumption(): Promise<{
  current: MyFuelConsumptionDto | null;
}> {
  const res = await fetch("/api/me/fuel-consumption", {
    credentials: "include",
  });
  return parseApiResponse<{ current: MyFuelConsumptionDto | null }>(res);
}
