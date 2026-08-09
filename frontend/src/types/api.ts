// Shared API types for PHASE-002 frontend

export type Role = "USER" | "ADMIN";

// ---- PHASE-003a parameter types ----

// ---- PHASE-005a-T3/T9 fuel price (油種＋每公升油價) ----

export type FuelType = "GASOLINE_92" | "GASOLINE_95" | "GASOLINE_98" | "DIESEL";

export interface FuelPriceVersionDto {
  id: string;
  fuelType: FuelType;
  pricePerLiter: string; // Decimal(10,4) as string, toFixed(4)
  effectiveFrom: string; // YYYY-MM-DD
  createdAt: string; // ISO
}

// ---- PHASE-005a-T4/T5/T10 fuel consumption (使用者車輛油種＋油耗版本) ----

export type FuelConsumptionVersionState = "HISTORICAL" | "CURRENT" | "FUTURE";

export interface FuelConsumptionVersionDto {
  id: string;
  userId: string;
  fuelType: FuelType;
  kmPerLiter: string; // Decimal(10,4) as string, toFixed(4)
  effectiveFrom: string; // YYYY-MM-DD
  basisNote: string;
  state: FuelConsumptionVersionState;
  createdAt: string; // ISO
  createdById: string;
}

/**
 * PHASE-005a-T11: `GET /me/fuel-consumption` 之 `current`（backend T6 逐鍵
 * 白名單，見 backend/src/users/fuel-consumption-routes.ts）——僅此三鍵。
 */
export interface MyFuelConsumptionDto {
  fuelType: FuelType;
  kmPerLiter: string;
  effectiveFrom: string; // YYYY-MM-DD
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
  /** PHASE-007-R11：新版本為 `null`（AC-57(b)）；歷史版本回原值（AC-57(c)） */
  estimatedAnnualKm: number | null;
  effectiveFrom: string;
  createdAt: string;
  derived: {
    annualDepreciation: string;
    /** PHASE-007-R11：新版本為 `null`（AC-57(b)）；歷史版本回原值（AC-57(c)） */
    perKmUnitPrice: string | null;
  };
}

// ---- PHASE-010-T6 audit log types (§7.2 AuditLogListItemDto／AuditChangeDto) ----

/** `AuditAction` enum，10 值封閉（`schema.prisma` :30-41；D8=(a) 結案，零 migration）。 */
export type AuditAction =
  | "USER_CREATED"
  | "USER_DEACTIVATED"
  | "USER_ACTIVATED"
  | "USER_PASSWORD_RESET"
  | "USER_DELETED"
  | "PARAMETER_VERSION_CREATED"
  | "APPLICATION_CREATED_ON_BEHALF"
  | "APPLICATION_UPDATED_ON_BEHALF"
  | "USER_FUEL_CONSUMPTION_VERSION_CREATED"
  | "APPLICATION_VOIDED";

/**
 * §7.2 `AuditChangeDto`：`AuditLog.summary` 經後端 `flattenAuditSummary`
 * 扁平化後之單列（欄位／改前／改後）。`before`／`after` 恆為 `string | null`
 * ——非純量之原值（含巢狀混合形之 `before`／`after` 物件）已由後端
 * `JSON.stringify` 字串化，前端不得再對其做二次物件化解讀。
 */
export interface AuditChangeDto {
  /** `summary` 之頂層鍵（英文鍵名）；中文標籤對照見 AuditChangesList（D3=(c)）。 */
  field: string;
  before: string | null;
  after: string | null;
}

/** §7.2／AC-04(a)：鍵集封閉為七鍵（後端 `backend/src/audit/routes.ts` 同名介面）。 */
export interface AuditLogListItemDto {
  id: string;
  action: AuditAction;
  /** ISO 8601 UTC 字串（D9(a)）；在地化屬前端呈現層。 */
  createdAt: string;
  actorDisplayName: string;
  targetLabel: string;
  /** `target` 已被刪除（FK `ON DELETE SET NULL`）時為 `null`（AC-04(c)）。 */
  targetDisplayName: string | null;
  changes: AuditChangeDto[];
}

/** §7.2／AC-01(b)：鍵集封閉為四鍵。 */
export interface AuditLogListResponse {
  items: AuditLogListItemDto[];
  total: number;
  page: number;
  pageSize: number;
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
