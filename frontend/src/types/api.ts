// Shared API types for PHASE-002 frontend

export type Role = "USER" | "ADMIN";

// ---- PHASE-003a parameter types ----

export interface FuelParameterDto {
  id: string;
  unitPrice: string; // Decimal as string (D8)
  effectiveFrom: string; // YYYY-MM-DD
  createdAt: string;
}

export interface EtcParameterDto {
  id: string;
  unitPrice: string;
  effectiveFrom: string;
  createdAt: string;
}

export interface DepreciationParameterDto {
  id: string;
  vehiclePrice: string; // Decimal as string
  usefulLifeYears: number;
  estimatedAnnualKm: number;
  effectiveFrom: string;
  createdAt: string;
  derived: {
    annualDepreciation: string;
    perKmUnitPrice: string;
  };
}

export interface UserDto {
  id: string;
  loginName: string;
  displayName: string;
  employeeNumber: string | null;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
}

export interface ApiError {
  code: string;
  message: string;
  requestId?: string;
  fields?: Array<{ field: string; reason: string }>;
  /** Extra details for specific error codes, e.g. PARAMETER_PERIOD_OVERLAP → details.conflictVersion */
  details?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  error: ApiError;
}

/** Parse a fetch Response into a typed result or throw an ApiError */
export async function parseApiResponse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const errBody = body as ApiErrorResponse | null;
    const apiError: ApiError = errBody?.error ?? {
      code: "UNKNOWN",
      message: `HTTP ${res.status}`,
    };
    throw apiError;
  }

  return body as T;
}
