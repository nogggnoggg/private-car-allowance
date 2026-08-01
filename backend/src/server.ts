/**
 * buildServer() — assembles the Fastify instance with plugins and routes.
 * Accepts options for test injection (databaseUrl, dbProbeOverride).
 */
import Fastify from "fastify";
import { LogController } from "fastify";
import { getPrismaClient } from "./db/prisma.js";
import { buildLoggerOptions } from "./logger.js";
import { healthPlugin, makeDefaultDbProbe } from "./platform/health.js";
import type { DbProbe } from "./platform/health.js";

export interface BuildServerOptions {
  /** Postgres connection URL; if omitted, reads from DATABASE_URL env var */
  databaseUrl?: string;
  /** Override the DB probe function (for unit/integration test stubs) */
  dbProbeOverride?: DbProbe;
  /** pino log level; defaults to 'info' */
  logLevel?: string;
}

export async function buildServer(
  options: BuildServerOptions = {}
): Promise<ReturnType<typeof Fastify>> {
  const logLevel = options.logLevel ?? process.env.LOG_LEVEL ?? "info";

  const fastify = Fastify({
    logger: buildLoggerOptions(logLevel),
    // Use logController to set requestIdLogLabel without deprecation warning
    logController: new LogController({ requestIdLogLabel: "requestId" }),
  });

  // Set up Prisma client (use test URL if provided)
  const prisma = getPrismaClient(options.databaseUrl);

  // Determine DB probe (allow override for tests)
  const dbProbe: DbProbe = options.dbProbeOverride ?? makeDefaultDbProbe(prisma);

  // Register routes
  await fastify.register(healthPlugin, { dbProbe });

  // Graceful shutdown: disconnect Prisma
  fastify.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  return fastify;
}
