// Shared API types for PHASE-002 frontend

export type Role = "USER" | "ADMIN";

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
