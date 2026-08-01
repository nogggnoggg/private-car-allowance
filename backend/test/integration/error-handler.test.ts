/**
 * Integration tests for T6: Unified error protocol
 * TDD: written BEFORE implementation, expected to fail first.
 *
 * AC-10: Validation error → 400, unified format, fields
 * AC-11: Unknown exception → 500, INTERNAL_ERROR, no stack/details in body, requestId present
 * AC-12: 500 logs requestId; redact hides sensitive keys
 * AC-13: Unknown route → 404, unified format, code=NOT_FOUND
 *
 * Per Spec 12.2.4: tests use inject to register temporary routes, no persistent non-business endpoints.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pinoRedactPaths } from "../../src/logger.js";
import { AppError } from "../../src/platform/errors.js";
import { buildServer } from "../../src/server.js";

// Use a no-op DB probe to avoid needing a real database for error handler tests
const noopDbProbe = async () => {};

/** Canonical error response shape from Spec 5.2 */
interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    fields?: Array<{ field: string; reason: string }>;
  };
}

describe("Error Protocol — unified error handler (T6)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer({ dbProbeOverride: noopDbProbe });

    // Register temporary test-only routes after server is built
    // Per Spec 12.2.4: inject temporary routes in tests, not persistent endpoints
    app.post("/test/validation-error", {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
      },
      handler: async (request, _reply) => {
        // Throw AppError with VALIDATION_ERROR and fields
        throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
          { field: "email", reason: "格式不正確" },
        ]);
      },
    });

    app.get("/test/internal-error", {
      handler: async (_request, _reply) => {
        throw new Error("Some internal database error with sensitive info: password=secret");
      },
    });

    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // AC-13: Unknown route → 404 unified format
  describe("AC-13: 404 Not Found — unknown route", () => {
    it("returns HTTP 404 for unknown route", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/this-route-does-not-exist",
      });
      expect(response.statusCode).toBe(404);
    });

    it("returns unified error format with code=NOT_FOUND", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/this-route-does-not-exist",
      });
      const body = response.json<ErrorBody>();
      expect(body).toHaveProperty("error");
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toBeTruthy();
      expect(body.error.requestId).toBeTruthy();
      expect(body.error).not.toHaveProperty("fields");
    });
  });

  // AC-10: AppError(VALIDATION_ERROR, fields) → 400 with fields
  describe("AC-10: Validation error — AppError with fields", () => {
    it("returns HTTP 400 when route throws AppError(VALIDATION_ERROR)", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/test/validation-error",
        payload: { name: "valid" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("returns unified error format with code=VALIDATION_ERROR and fields array", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/test/validation-error",
        payload: { name: "valid" },
      });
      const body = response.json<ErrorBody>();
      expect(body).toHaveProperty("error");
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBeTruthy();
      expect(body.error.requestId).toBeTruthy();
      expect(body.error.fields).toBeInstanceOf(Array);
      expect(body.error.fields).toHaveLength(1);
      expect(body.error.fields?.[0]).toEqual({ field: "email", reason: "格式不正確" });
    });
  });

  // AC-11: Unknown exception → 500, INTERNAL_ERROR, no stack in body, requestId present
  describe("AC-11: Unhandled exception → 500 INTERNAL_ERROR", () => {
    it("returns HTTP 500 for unhandled exception", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/test/internal-error",
      });
      expect(response.statusCode).toBe(500);
    });

    it("returns unified error format with code=INTERNAL_ERROR", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/test/internal-error",
      });
      const body = response.json<ErrorBody>();
      expect(body).toHaveProperty("error");
      expect(body.error.code).toBe("INTERNAL_ERROR");
    });

    it("body does NOT contain stack trace or internal error message", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/test/internal-error",
      });
      const text = response.body;
      expect(text).not.toMatch(/password=secret/);
      expect(text).not.toMatch(/sensitive info/);
      expect(text).not.toMatch(/at Object\./); // No stack trace lines
      expect(text).not.toMatch(/Error:/);
    });

    it("body contains requestId for tracing", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/test/internal-error",
      });
      const body = response.json<ErrorBody>();
      expect(body.error.requestId).toBeTruthy();
      expect(typeof body.error.requestId).toBe("string");
    });

    it("body uses generic message (not internal details)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/test/internal-error",
      });
      const body = response.json<ErrorBody>();
      // Generic message, not the internal error message
      expect(body.error.message).toBe("系統發生錯誤，請稍後再試");
    });
  });

  // AC-12: Fastify schema validation error auto-converts to VALIDATION_ERROR + fields
  describe("Fastify schema validation → VALIDATION_ERROR + fields (AC-10 extension)", () => {
    it("returns 400 when body fails Fastify schema validation", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/test/validation-error",
        payload: {}, // Missing required 'name' field
      });
      expect(response.statusCode).toBe(400);
    });

    it("auto-converts Fastify validation error to VALIDATION_ERROR format", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/test/validation-error",
        payload: {}, // Missing required 'name' field
      });
      const body = response.json<ErrorBody>();
      expect(body).toHaveProperty("error");
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.requestId).toBeTruthy();
      // fields should be present for schema validation errors
      expect(body.error.fields).toBeInstanceOf(Array);
      expect(body.error.fields?.length).toBeGreaterThan(0);
    });
  });
});

// AC-12: pino redact configuration test
describe("AC-12: pino redact configuration covers sensitive keys", () => {
  it("redact paths include authorization header", () => {
    expect(pinoRedactPaths).toContain("authorization");
  });

  it("redact paths include cookie header", () => {
    expect(pinoRedactPaths).toContain("cookie");
  });

  it("redact paths include set-cookie header", () => {
    expect(pinoRedactPaths).toContain("set-cookie");
  });

  it("redact paths include password field", () => {
    expect(pinoRedactPaths).toContain("password");
  });

  it("redact paths include DATABASE_URL", () => {
    expect(pinoRedactPaths).toContain("DATABASE_URL");
  });

  it("redact paths include req.headers.authorization", () => {
    expect(pinoRedactPaths).toContain("req.headers.authorization");
  });

  it("redact paths include req.headers.cookie", () => {
    expect(pinoRedactPaths).toContain("req.headers.cookie");
  });
});
