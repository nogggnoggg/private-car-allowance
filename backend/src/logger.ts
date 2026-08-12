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
 * PHASE-011-T16（AC-28(b)）定案：覆寫 `err` serializer，只保留分類用之 `type`
 * （`err.name`；非 `Error` 物件時退回 `"UnknownError"`）。
 *
 * 為什麼：pino 未設 `serializers` 時之預設行為（實測釘死於本檔測試）——merging
 * 物件中鍵名逐字 `err`（含 shorthand `{ err }`）或作為呼叫之位置引數，會自動
 * 展開 `message` 與 `stack`；`stack` 逐字含絕對路徑，`message` 內容不可預測，
 * 可能內嵌路徑／SQL 片段／連線資訊（同 AC-21(a) 對 `error-handler.ts` 分支 4
 * 之既有裁定：只記分類標籤，不記原文）。
 *
 * 本覆寫為**運行期防線**，與 AC-28(a) 之靜態掃描器（`phase10-error-handler-
 * leak.test.ts`）互補：掃描器在審查期攔阻新站點誤用 `{ err }`／位置引數型；
 * 本 serializer 則確保即使有站點漏審，pino 也不會把 message／stack 印出。
 */
export function buildLoggerOptions(level: string) {
  return {
    level,
    redact: {
      paths: pinoRedactPaths,
      censor: "[REDACTED]",
    },
    serializers: {
      err: (err: unknown) => ({
        type: err instanceof Error ? err.name : "UnknownError",
        message: "[REDACTED]",
        stack: "[REDACTED]",
      }),
    },
  };
}

// Re-export Fastify logger type for convenience
export type AppLogger = FastifyBaseLogger;
