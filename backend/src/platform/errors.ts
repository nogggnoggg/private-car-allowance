/**
 * Unified error protocol for the entire application.
 * Spec 5.2 (authoritative shape): { error: { code, message, requestId, fields? } }
 * AC-10: VALIDATION_ERROR with fields for field-level validation failures.
 * AC-11: INTERNAL_ERROR with no stack/DB details in body.
 * AC-13: NOT_FOUND for unknown routes.
 */

/** Error codes — base set for PHASE-001; extended in PHASE-002 (Spec 4.8); extended in PHASE-003 (Spec 4.8); extended in PHASE-003a (Spec §4.8). */
export type ErrorCode =
  | "VALIDATION_ERROR" // 400 — field validation failure, with fields[]
  | "UNAUTHORIZED" // 401 — unauthenticated, session invalid, login failure (unified), wrong current password
  | "FORBIDDEN" // 403 — role insufficient (requireAdmin), data ownership mismatch
  | "PASSWORD_CHANGE_REQUIRED" // 403 — mustChangePassword session accessing non-change-password endpoints
  | "NOT_FOUND" // 404 — route or resource not found
  | "UNSUPPORTED_MEDIA_TYPE" // 415 — actual file content is not JPEG/PNG/WebP (includes disguised extension, empty file, PDF, etc.)
  | "PAYLOAD_TOO_LARGE" // 413 — single file exceeds size limit (ATTACHMENT_MAX_BYTES)
  | "CONFLICT" // 409 — loginName duplicate, delete blocked (has history), self-deactivate/delete
  | "TOO_MANY_ATTACHMENTS" // 409 — attachment count reached container limit
  | "PARAMETER_PERIOD_OVERLAP" // 409 — new parameter version overlaps with an existing version (PHASE-003a §4.8 D5); body includes details.conflictVersion
  | "PARAMETER_NOT_AVAILABLE" // 409 — trip date has no effective fuel/ETC parameter version, cannot complete (PHASE-004 §8.5, AC-47); body includes details.missing (("FUEL"|"ETC")[]) and details.tripDate
  | "INTERNAL_ERROR" // 500 — unhandled/unexpected exception
  | "SERVICE_UNAVAILABLE" // 503 — dependency unavailable (e.g. DB down)
  | "REPORT_GENERATION_FAILED"; // 500 — PHASE-008 §7.5/D5: PDF render/store/verify/persist failure; body includes details.stage ("RENDER"|"STORE"|"VERIFY"|"PERSIST"), never a path/key/stack

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
  /**
   * Optional structured details for specific error codes.
   * Used by PARAMETER_PERIOD_OVERLAP (PHASE-003a §4.8) to carry
   * conflictVersion: { id, effectiveFrom } without leaking DB internals.
   * MUST NOT contain any stack traces, DB details, or internal paths.
   */
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    httpStatus: number,
    message: string,
    fields?: FieldError[],
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.userMessage = message;
    this.fields = fields;
    this.details = details;
  }
}

/** Unified error body shape (Spec 5.2) */
export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    fields?: FieldError[];
    /** Optional structured details; present for PARAMETER_PERIOD_OVERLAP (PHASE-003a §4.8) */
    details?: Record<string, unknown>;
  };
}

/** Build the unified error response body */
export function buildErrorBody(
  code: string,
  message: string,
  requestId: string,
  fields?: FieldError[],
  details?: Record<string, unknown>
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
  // details only appears for codes that carry structured extra info (e.g. PARAMETER_PERIOD_OVERLAP)
  if (details !== undefined) {
    body.error.details = details;
  }
  return body;
}
