/**
 * buildServer() — assembles the Fastify instance with plugins and routes.
 * Accepts options for test injection (databaseUrl, dbProbeOverride, logStream).
 */
import * as os from "node:os";
import * as path from "node:path";
import type { Writable } from "node:stream";
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { LogController } from "fastify";
import { adminPlugin } from "./admin/routes.js";
import { attachmentPlugin } from "./attachment/routes.js";
import { authPlugin } from "./auth/routes.js";
import { getEnvOrTestDefaults } from "./config/env.js";
import { getPrismaClient } from "./db/prisma.js";
import { buildLoggerOptions } from "./logger.js";
import { parametersPlugin } from "./parameters/routes.js";
import { registerErrorHandlers } from "./platform/error-handler.js";
import { healthPlugin, makeDefaultDbProbe } from "./platform/health.js";
import type { DbProbe } from "./platform/health.js";
import { LocalVolumeStorage } from "./storage/index.js";

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
  /**
   * Override the storage root path (for integration tests).
   * When provided, LocalVolumeStorage uses this path instead of ATTACHMENT_STORAGE_ROOT.
   */
  storageRoot?: string;
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

  // Register admin routes (GET/POST /admin/users, deactivate/activate/reset-password/delete)
  await fastify.register(adminPlugin, { prisma });

  // Register parameters routes (POST/GET /parameters/fuel, /parameters/etc — PHASE-003a-T3)
  await fastify.register(parametersPlugin, { prisma });

  // Register attachment routes (POST /attachments — T3)
  // Storage root resolution (Spec §8, NFR-US-07):
  //   Priority: options.storageRoot (test injection) > env ATTACHMENT_STORAGE_ROOT (compose/Zeabur mount)
  //
  //   Production (NODE_ENV=production): ATTACHMENT_STORAGE_ROOT MUST be set; fail-fast on startup
  //   so misconfiguration is caught immediately rather than silently writing into a non-persistent path.
  //
  //   Non-production (test / development): if ATTACHMENT_STORAGE_ROOT is absent, fall back to
  //   os.tmpdir()/<dynamic-subdir> with a warning log. This avoids breaking existing test suites
  //   that call buildServer() without a storageRoot option and without ATTACHMENT_STORAGE_ROOT set.
  //   The path is dynamic (os.tmpdir() + process id), NOT a hardcoded string (Spec §8, NFR-US-07).
  const appEnv = getEnvOrTestDefaults(process.env);

  const resolvedStorageRoot = options.storageRoot ?? appEnv.ATTACHMENT_STORAGE_ROOT;

  let storageRoot: string;
  if (resolvedStorageRoot) {
    storageRoot = resolvedStorageRoot;
  } else if (appEnv.NODE_ENV === "production") {
    throw new Error(
      "Server startup failed — ATTACHMENT_STORAGE_ROOT is not set. " +
        "Provide the environment variable (volume mount path) for the persistent storage volume."
    );
  } else {
    // Non-production fallback: dynamic temp path, not a hardcoded string (Spec §8)
    storageRoot = path.join(os.tmpdir(), `att-storage-dev-${process.pid}`);
    fastify.log.warn(
      `ATTACHMENT_STORAGE_ROOT not set; using dynamic temp path for non-production: ${storageRoot.replace(os.tmpdir(), "<tmpdir>")}`
    );
  }

  const storage = new LocalVolumeStorage(storageRoot);
  await fastify.register(attachmentPlugin, { prisma, storage });

  // Graceful shutdown: disconnect Prisma
  fastify.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  return fastify;
}
