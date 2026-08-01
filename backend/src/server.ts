/**
 * buildServer() — assembles the Fastify instance with plugins and routes.
 * Accepts options for test injection (databaseUrl, dbProbeOverride, logStream).
 */
import type { Writable } from "node:stream";
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { LogController } from "fastify";
import { authPlugin } from "./auth/routes.js";
import { getPrismaClient } from "./db/prisma.js";
import { buildLoggerOptions } from "./logger.js";
import { registerErrorHandlers } from "./platform/error-handler.js";
import { healthPlugin, makeDefaultDbProbe } from "./platform/health.js";
import type { DbProbe } from "./platform/health.js";

export interface BuildServerOptions {
  /** Postgres connection URL; if omitted, reads from DATABASE_URL env var */
  databaseUrl?: string;
  /** Override the DB probe function (for unit/integration test stubs) */
  dbProbeOverride?: DbProbe;
  /** pino log level; defaults to 'info' */
  logLevel?: string;
  /**
   * Optional writable stream to capture log output (for integration tests).
   * When provided, pino writes JSON log lines to this stream instead of stdout.
   */
  logStream?: Writable;
}

export async function buildServer(
  options: BuildServerOptions = {}
): Promise<ReturnType<typeof Fastify>> {
  const logLevel = options.logLevel ?? process.env.LOG_LEVEL ?? "info";
  const loggerOptions = buildLoggerOptions(logLevel);

  const fastify = Fastify({
    logger: options.logStream ? { ...loggerOptions, stream: options.logStream } : loggerOptions,
    // Use logController to set requestIdLogLabel without deprecation warning
    logController: new LogController({ requestIdLogLabel: "requestId" }),
  });

  // Set up Prisma client (use test URL if provided)
  const prisma = getPrismaClient(options.databaseUrl);

  // Determine DB probe (allow override for tests)
  const dbProbe: DbProbe = options.dbProbeOverride ?? makeDefaultDbProbe(prisma);

  // Register unified error handlers FIRST so they apply to all child scopes.
  // In Fastify 5, setErrorHandler/setNotFoundHandler on root must be registered
  // before plugin scopes to ensure inheritance.
  registerErrorHandlers(fastify);

  // Register @fastify/cookie (required for session cookie handling — Spec 4.3 / AC-28)
  // Must be registered before any route that reads/writes cookies.
  await fastify.register(fastifyCookie);

  // Register routes
  await fastify.register(healthPlugin, { dbProbe });

  // Register auth routes (POST /auth/login, POST /auth/logout, GET /me)
  await fastify.register(authPlugin, { prisma });

  // Graceful shutdown: disconnect Prisma
  fastify.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  return fastify;
}
