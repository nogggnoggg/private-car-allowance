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

    // 3. Wire-level / framework 4xx errors not already handled above (CHORE-001).
    //    Example: malformed JSON body, Content-Length mismatch, empty body with
    //    `Content-Type: application/json` (Fastify's built-in body parser throws
    //    e.g. FST_ERR_CTP_INVALID_JSON_BODY / FST_ERR_CTP_EMPTY_JSON_BODY /
    //    FST_ERR_CTP_INVALID_CONTENT_LENGTH). This happens in Fastify's body
    //    parser, which runs BEFORE preHandler/auth — an unauthenticated caller
    //    can trigger it. It is a client-input problem, not a server bug, and
    //    must not be classified as INTERNAL_ERROR (500) nor logged at error
    //    level (SF-1/log-security: caller-triggered 4xx is request.log.info,
    //    matching branch 2's existing convention above).
    //    Narrow condition (deliberately NOT "any thrown error"): AppError
    //    (branch 1) and ajv schema-validation errors (branch 2) are already
    //    handled above, so by the time execution reaches here an error only
    //    matches if it carries an explicit numeric 4xx `.statusCode` or a
    //    `FST_ERR_CTP_*` code — both are properties Fastify's own error
    //    classes set, not something an arbitrary unexpected exception/bug
    //    happens to carry. Genuine unknown exceptions (real bugs) essentially
    //    never have a 4xx statusCode, so this does not swallow real 500s.
    const wireError = error as Error & { statusCode?: number; code?: string };
    const isFastifyContentTypeError =
      typeof wireError.code === "string" && wireError.code.startsWith("FST_ERR_CTP_");
    const has4xxStatusCode =
      typeof wireError.statusCode === "number" &&
      wireError.statusCode >= 400 &&
      wireError.statusCode < 500;
    if (isFastifyContentTypeError || has4xxStatusCode) {
      // CHORE-002 修項②: wire-level 4xx 對照表 — 413/415 保留原始語意與 statusCode,
      // 其餘（畸形 JSON、Content-Length 不符等）維持既有 400 VALIDATION_ERROR 壓平。
      // （reviewer 實測：CHORE-001 舊版把 413/415 也壓成 400，語意流失。）
      let wireStatus = 400;
      let wireCode: "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "VALIDATION_ERROR" =
        "VALIDATION_ERROR";
      let wireMessage = "輸入資料有誤，請檢查標示欄位。";
      if (wireError.statusCode === 413) {
        wireStatus = 413;
        wireCode = "PAYLOAD_TOO_LARGE";
        wireMessage = "請求內容過大，請縮小後再試。";
      } else if (wireError.statusCode === 415) {
        wireStatus = 415;
        wireCode = "UNSUPPORTED_MEDIA_TYPE";
        wireMessage = "不支援的內容類型，請確認 Content-Type 設定。";
      }

      // AR-3: omit { requestId } from log object — logController already injects it
      request.log.info(
        { errName: error.name, errCode: wireError.code },
        "Wire-level 4xx error (body parser / framework)"
      );
      return reply.status(wireStatus).send(buildErrorBody(wireCode, wireMessage, requestId));
    }

    // 4. Unknown/unhandled exception → INTERNAL_ERROR
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
