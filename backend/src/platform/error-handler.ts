/**
 * Fastify error handler and 404 handler for the unified error protocol.
 * Spec 5.2 (authoritative error shape) + AC-10, 11, 12, 13.
 *
 * setErrorHandler:
 *   - AppError → use its code/httpStatus/fields
 *   - Fastify schema validation errors → VALIDATION_ERROR + fields extracted from details
 *   - All other errors → INTERNAL_ERROR (500), generic message, no stack/details in body
 *
 * setNotFoundHandler:
 *   - NOT_FOUND (404) in unified format
 *
 * requestId flows from request.id (set by Fastify genReqId) into response and logs.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError, type FieldError, buildErrorBody } from "./errors.js";
import { sanitizeForLog } from "./log-sanitize.js";

/** Generic message for 500 responses — must not leak internal details (AC-11, Spec 5.2) */
const INTERNAL_ERROR_MESSAGE = "系統發生錯誤，請稍後再試";

/**
 * Fastify validation error detail item.
 * Shape produced by Fastify's built-in JSON Schema validation (ajv).
 */
interface FastifyValidationErrorDetail {
  instancePath?: string;
  schemaPath?: string;
  keyword?: string;
  params?: Record<string, unknown>;
  message?: string;
}

/**
 * Convert Fastify ajv validation details to our FieldError format.
 * instancePath is like "/body/email" → we extract "email".
 */
function extractFieldErrors(validation: FastifyValidationErrorDetail[]): FieldError[] {
  return validation.map((detail) => {
    // instancePath may be "" (root) or "/fieldName"
    const instancePath = detail.instancePath ?? "";
    const field = instancePath.startsWith("/")
      ? instancePath.slice(1) // "/name" → "name"
      : instancePath || (detail.params?.missingProperty as string) || "unknown";

    // For required errors, the failing field is in params.missingProperty
    const effectiveField =
      detail.keyword === "required" ? ((detail.params?.missingProperty as string) ?? field) : field;

    return {
      field: effectiveField,
      reason: detail.message ?? "Invalid value",
    };
  });
}

/**
 * Register setErrorHandler and setNotFoundHandler on the Fastify instance.
 * Must be called AFTER all plugins/routes are registered in buildServer().
 */
export function registerErrorHandlers(fastify: FastifyInstance): void {
  // ── 404 handler ──────────────────────────────────────────────────────────
  fastify.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const requestId = String(request.id);
    // AR-3: omit { requestId } from log object — logController already injects it
    request.log.warn("Route not found");

    return reply.status(404).send(buildErrorBody("NOT_FOUND", "找不到請求的資源。", requestId));
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  fastify.setErrorHandler((error: Error, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = String(request.id);

    // 1. Known application error (AppError)
    if (error instanceof AppError) {
      // AR-3: omit { requestId } from log object — logController already injects it
      request.log.info({ code: error.code }, `AppError: ${error.userMessage}`);
      return reply
        .status(error.httpStatus)
        .send(
          buildErrorBody(error.code, error.userMessage, requestId, error.fields, error.details)
        );
    }

    // 2. Fastify validation error (ajv schema validation)
    //    Fastify attaches .validation property (array of ajv errors)
    //    and .statusCode === 400
    const fastifyError = error as Error & {
      validation?: FastifyValidationErrorDetail[];
      statusCode?: number;
    };
    if (fastifyError.validation !== undefined && Array.isArray(fastifyError.validation)) {
      const fields = extractFieldErrors(fastifyError.validation);
      // AR-3: omit { requestId } from log object — logController already injects it
      request.log.info({ fields }, "Fastify schema validation error");
      return reply
        .status(400)
        .send(
          buildErrorBody("VALIDATION_ERROR", "輸入資料有誤，請檢查標示欄位。", requestId, fields)
        );
    }

    // 3. Unknown/unhandled exception → INTERNAL_ERROR
    //    SF-1: log only sanitized name+message — no stack (stack repeats the message and
    //    adds file paths; sanitizing multi-line stacks reliably is harder than a single
    //    message string, and requestId is sufficient for correlation in a structured log).
    //    AR-3: omit { requestId } from log object — logController already injects it.
    request.log.error(
      {
        errName: error.name,
        errMessage: sanitizeForLog(error.message),
      },
      "Unhandled exception"
    );
    return reply
      .status(500)
      .send(buildErrorBody("INTERNAL_ERROR", INTERNAL_ERROR_MESSAGE, requestId));
  });
}
