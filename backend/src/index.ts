/**
 * Backend entry point.
 * 1. Load .env (local dev only — containers provide real env vars)
 * 2. Validate env — exit 1 with missing names if invalid (AC-09)
 * 3. Build and start Fastify server
 */
import { config as loadDotenv } from "dotenv";
import { parseEnv } from "./config/env.js";
import { buildServer } from "./server.js";

// Load .env file for local dev (no-op if file absent; containers use real env)
loadDotenv();

let cfg: ReturnType<typeof parseEnv>;

try {
  cfg = parseEnv(process.env as Record<string, string | undefined>);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  // Print variable names / reasons — never print values (AC-09)
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const server = await buildServer({
  databaseUrl: cfg.DATABASE_URL,
  logLevel: cfg.LOG_LEVEL,
});

try {
  await server.listen({ port: cfg.PORT, host: "0.0.0.0" });
} catch (err) {
  // PHASE-011-T16（AC-28(c)①）：不把 err 物件（位置引數）直接交給 log.error——
  // pino 預設 err serializer 會展開 message 與 stack（stack 逐字含絕對路徑）。
  // 只記分類標籤（err.name），沿 health.ts 探針失敗日誌之既有寫法同形。
  server.log.error(
    { errName: err instanceof Error ? err.name : "UnknownError" },
    "Failed to start listening"
  );
  process.exit(1);
}
