/**
 * Log security integration tests — SF-1 fix verification.
 *
 * TDD: written BEFORE fixes, expected to fail first.
 *
 * Assertions:
 * (a) DB down: log output must NOT contain "postgresql://" credentials or raw err.message
 * (b) 500 error: log output must NOT contain "password=secret" but MUST contain err name + requestId
 * (c) AR-3: no duplicate requestId key in log entries
 *
 * Strategy: capture pino log lines by injecting a custom stream into buildServer,
 * then parse JSON log lines emitted during request handling.
 */
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.js";

/** Collect raw JSON log lines into an array */
function makeLogCapture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, stream };
}

/** Parse a log line into its JSON object, or null if not JSON */
function parseLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// (a) health.ts DB-down log assertions
// ──────────────────────────────────────────────────────────────
describe("SF-1(a): health.ts DB-down log must not contain credentials", () => {
  let app: FastifyInstance;
  let logLines: string[];

  beforeAll(async () => {
    const capture = makeLogCapture();
    logLines = capture.lines;

    app = await buildServer({
      dbProbeOverride: async () => {
        throw new Error("Connection refused postgresql://secret:pass@host:5432/db");
      },
      logStream: capture.stream,
    });
    await app.ready();

    // Trigger the health check to produce a log entry
    await app.inject({ method: "GET", url: "/health" });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("returns HTTP 503 (AC-08 unchanged)", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
  });

  it("log does NOT contain 'postgresql://' credential string", () => {
    const combined = logLines.join("\n");
    // The raw connection string with credentials must not appear
    expect(combined).not.toContain("postgresql://secret:pass");
  });

  it("log does NOT contain raw err.message from the probe exception", () => {
    const combined = logLines.join("\n");
    // The word "Connection refused" from the error message must not appear verbatim
    expect(combined).not.toContain("Connection refused postgresql://");
  });

  it("log DOES contain a diagnostic entry (error-level) for the DB probe failure", () => {
    const errorLines = logLines.map(parseLine).filter((obj) => obj !== null && obj.level === 50); // pino error level = 50
    expect(errorLines.length).toBeGreaterThan(0);
  });

  it("log diagnostic entry contains errName for error classification", () => {
    const errorEntries = logLines.map(parseLine).filter((obj) => obj !== null && obj.level === 50);
    // At least one error log entry should have errName
    const hasErrName = errorEntries.some((obj) => typeof obj?.errName === "string");
    expect(hasErrName).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────
// (b) error-handler.ts 500 log assertions
// ──────────────────────────────────────────────────────────────
describe("SF-1(b): error-handler 500 log must sanitize sensitive content", () => {
  let app: FastifyInstance;
  let logLines: string[];

  beforeAll(async () => {
    const capture = makeLogCapture();
    logLines = capture.lines;

    app = await buildServer({
      dbProbeOverride: async () => {},
      logStream: capture.stream,
    });

    // Register a test route that throws an error with sensitive content
    app.get("/test/log-security-error", {
      handler: async () => {
        throw new Error("Some internal database error with sensitive info: password=secret");
      },
    });

    await app.ready();

    // Trigger the error to produce log entries
    await app.inject({ method: "GET", url: "/test/log-security-error" });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("returns HTTP 500 (AC-11 unchanged)", async () => {
    const response = await app.inject({ method: "GET", url: "/test/log-security-error" });
    expect(response.statusCode).toBe(500);
  });

  it("log does NOT contain 'password=secret'", () => {
    const combined = logLines.join("\n");
    expect(combined).not.toContain("password=secret");
  });

  it("log DOES contain error level entry (50) for unhandled exception", () => {
    const errorEntries = logLines.map(parseLine).filter((obj) => obj !== null && obj.level === 50);
    expect(errorEntries.length).toBeGreaterThan(0);
  });

  it("log DOES contain err.name for classification", () => {
    const errorEntries = logLines.map(parseLine).filter((obj) => obj !== null && obj.level === 50);
    const hasErrName = errorEntries.some(
      (obj) =>
        typeof obj?.errName === "string" ||
        typeof (obj?.err as Record<string, unknown>)?.name === "string"
    );
    expect(hasErrName).toBe(true);
  });

  it("log DOES contain requestId in the 500 error entry", () => {
    const errorEntries = logLines.map(parseLine).filter((obj) => obj !== null && obj.level === 50);
    const hasRequestId = errorEntries.some((obj) => typeof obj?.requestId === "string");
    expect(hasRequestId).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────
// (c) AR-3: no duplicate requestId key in any log entry
// ──────────────────────────────────────────────────────────────
describe("AR-3: no duplicate requestId key in log entries", () => {
  let app: FastifyInstance;
  let rawLines: string[];

  beforeAll(async () => {
    const capture = makeLogCapture();
    rawLines = capture.lines;

    app = await buildServer({
      dbProbeOverride: async () => {},
      logStream: capture.stream,
    });

    app.get("/test/ar3-route", {
      handler: async (_req, reply) => reply.send({ ok: true }),
    });

    await app.ready();
    await app.inject({ method: "GET", url: "/test/ar3-route" });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("no log line contains the literal string 'requestId' twice", () => {
    for (const line of rawLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Count occurrences of the key "requestId" in the JSON string
      const occurrences = (trimmed.match(/"requestId"/g) ?? []).length;
      expect(occurrences, `Line has duplicate requestId: ${trimmed}`).toBeLessThanOrEqual(1);
    }
  });
});

// PHASE-002 review SF-1: pino redact must cover all password-carrying field
// names promised by AC-27, at top level and nested (wildcard paths).
describe("SF-1 (PHASE-002): redact covers password/newPassword/currentPassword/temporaryPassword", () => {
  async function logAndCapture(payload: Record<string, unknown>): Promise<string> {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const app: FastifyInstance = await buildServer({
      databaseUrl: "postgresql://user:pass@localhost:5432/unused",
      logStream: stream,
    });
    app.log.info(payload, "redact probe");
    await app.close();
    return lines.join("\n");
  }

  it("redacts all four fields at top level", async () => {
    const out = await logAndCapture({
      password: "TOP-SECRET-1",
      newPassword: "TOP-SECRET-2",
      currentPassword: "TOP-SECRET-3",
      temporaryPassword: "TOP-SECRET-4",
    });
    expect(out).not.toContain("TOP-SECRET-1");
    expect(out).not.toContain("TOP-SECRET-2");
    expect(out).not.toContain("TOP-SECRET-3");
    expect(out).not.toContain("TOP-SECRET-4");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts all four fields nested one level (e.g. accidentally logged body)", async () => {
    const out = await logAndCapture({
      body: {
        password: "NEST-SECRET-1",
        newPassword: "NEST-SECRET-2",
        currentPassword: "NEST-SECRET-3",
        temporaryPassword: "NEST-SECRET-4",
      },
    });
    expect(out).not.toContain("NEST-SECRET-1");
    expect(out).not.toContain("NEST-SECRET-2");
    expect(out).not.toContain("NEST-SECRET-3");
    expect(out).not.toContain("NEST-SECRET-4");
  });
});
