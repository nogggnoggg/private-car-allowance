/**
 * Unified error protocol for the entire application.
 * Spec 5.2 (authoritative shape): { error: { code, message, requestId, fields? } }
 * AC-10: VALIDATION_ERROR with fields for field-level validation failures.
 * AC-11: INTERNAL_ERROR with no stack/DB details in body.
 * AC-13: NOT_FOUND for unknown routes.
 */

/** Error codes — base set for PHASE-001; extended in PHASE-002 (Spec 4.8). */
export type ErrorCode =
  | "VALIDATION_ERROR" // 400 — field validation failure, with fields[]
  | "UNAUTHORIZED" // 401 — unauthenticated, session invalid, login failure (unified), wrong current password
  | "FORBIDDEN" // 403 — role insufficient (requireAdmin), data ownership mismatch
  | "PASSWORD_CHANGE_REQUIRED" // 403 — mustChangePassword session accessing non-change-password endpoints
  | "NOT_FOUND" // 404 — route or resource not found
  | "CONFLICT" // 409 — loginName duplicate, delete blocked (has history), self-deactivate/delete
  | "INTERNAL_ERROR" // 500 — unhandled/unexpected exception
  | "SERVICE_UNAVAILABLE"; // 503 — dependency unavailable (e.g. DB down)

/** Per-field validation failure entry (AC-10) */
export interface FieldError {
  field: string;
  reason: string;
}

/**
 * AppError: known, intentional errors thrown by business/platform code.
 * The error handler converts these to the unified wire format.
 */
export class AppError extends Error {
  /** Machine-readable error code — stable contract for frontend */
  readonly code: ErrorCode;
  /** HTTP status code to use in the response */
  readonly httpStatus: number;
  /** Human-readable message — MUST NOT contain stack/DB details */
  readonly userMessage: string;
  /** Only present for VALIDATION_ERROR */
  readonly fields?: FieldError[];

  constructor(code: ErrorCode, httpStatus: number, message: string, fields?: FieldError[]) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.userMessage = message;
    this.fields = fields;
  }
}

/** Unified error body shape (Spec 5.2) */
export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    fields?: FieldError[];
  };
}

/** Build the unified error response body */
export function buildErrorBody(
  code: string,
  message: string,
  requestId: string,
  fields?: FieldError[]
): ErrorResponseBody {
  const body: ErrorResponseBody = {
    error: {
      code,
      message,
      requestId,
    },
  };
  // fields only appears for VALIDATION_ERROR (Spec 5.2)
  if (fields !== undefined && fields.length > 0) {
    body.error.fields = fields;
  }
  return body;
}
