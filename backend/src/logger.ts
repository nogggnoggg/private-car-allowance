/**
 * Shared pino logger configuration with redact for sensitive fields.
 * AC-12: Logs contain requestId but not DATABASE_URL values, passwords, tokens, etc.
 */
import type { FastifyBaseLogger } from "fastify";

/**
 * Fields to redact from all log output (keys at any nesting level).
 * pino redact uses a path-based notation: '[*].password' covers arrays.
 */
export const pinoRedactPaths = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "newPassword",
  "currentPassword",
  "temporaryPassword",
  "DATABASE_URL",
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  // Wildcard paths so nested objects (e.g. an accidentally-logged request
  // body) are covered too — AC-27 promises these fields never reach logs.
  "*.password",
  "*.newPassword",
  "*.currentPassword",
  "*.temporaryPassword",
];

/**
 * Base pino options for use in buildServer().
 * Level is overridden at startup from config.LOG_LEVEL.
 */
export function buildLoggerOptions(level: string) {
  return {
    level,
    redact: {
      paths: pinoRedactPaths,
      censor: "[REDACTED]",
    },
  };
}

// Re-export Fastify logger type for convenience
export type AppLogger = FastifyBaseLogger;
