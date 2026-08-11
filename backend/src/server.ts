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
import { applicationsPlugin } from "./applications/routes.js";
import { attachmentPlugin } from "./attachment/routes.js";
import { auditPlugin } from "./audit/routes.js";
import { authPlugin } from "./auth/routes.js";
import { getEnvOrTestDefaults } from "./config/env.js";
import { getPrismaClient } from "./db/prisma.js";
import { buildLoggerOptions } from "./logger.js";
import { mileagePlugin } from "./mileage/routes.js";
import { parametersPlugin } from "./parameters/routes.js";
import { registerErrorHandlers } from "./platform/error-handler.js";
import { healthPlugin, makeDefaultDbProbe } from "./platform/health.js";
import type { DbProbe } from "./platform/health.js";
import { reportsPlugin } from "./reports/routes.js";
import { LocalVolumeStorage } from "./storage/index.js";
import { fuelConsumptionPlugin } from "./users/fuel-consumption-routes.js";

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
  /**
   * Override the report storage root path (for integration tests; PHASE-008-T8).
   * When provided, the report LocalVolumeStorage instance uses this path instead
   * of env REPORT_STORAGE_ROOT.
   */
  reportStorageRoot?: string;
  /**
   * Force the production session-cookie attribute set (`Secure`) on without
   * setting NODE_ENV=production (PHASE-011-T7; Spec AC-09(d), §11.0 #5 forbids
   * NODE_ENV=production in tests). One-way: it can only harden — see
   * `resolveSecureCookies()` in `auth/routes.ts`.
   */
  forceSecureCookies?: boolean;
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
    // PHASE-011-T7 (Spec AC-10(b-2); §16 D8=(a)) — do NOT trust reverse-proxy
    // headers. This is Fastify's own default, so writing it changes nothing at
    // runtime; it is explicit so the decision is visible here and so the
    // structural guard in `test/integration/phase11-cookie-proxy.test.ts` can
    // pin the VALUE (a later `true` would let any client forge
    // `X-Forwarded-Proto` / `X-Forwarded-For`) rather than merely its absence.
    // Nothing in this codebase needs the original protocol or client IP: logs
    // record neither, the cookie `Secure` flag comes from NODE_ENV alone
    // (`auth/routes.ts` resolveSecureCookies), and HTTP→HTTPS redirection is
    // the deployment platform's job. Assumption and its failure consequence:
    // Spec §17.1 #2 (if the platform does not enforce HTTPS, the application
    // will not notice).
    trustProxy: false,
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
  await fastify.register(authPlugin, {
    prisma,
    forceSecureCookies: options.forceSecureCookies,
  });

  // Register admin routes (GET/POST /admin/users, deactivate/activate/reset-password/delete)
  await fastify.register(adminPlugin, { prisma });

  // Register audit query route (GET /admin/audit-logs — PHASE-010-T2, §16 D1(b):
  // 稽核之寫入（audit/audit.ts）與查詢同域內聚，故獨立於 adminPlugin 之外)
  await fastify.register(auditPlugin, { prisma });

  // Register parameters routes (POST/GET /parameters/fuel, /parameters/etc — PHASE-003a-T3)
  await fastify.register(parametersPlugin, { prisma });

  // Register user fuel-consumption routes (POST/GET /users/:userId/fuel-consumption
  // — PHASE-005a-T5, §7.2/§16 D7(a))
  await fastify.register(fuelConsumptionPlugin, { prisma });

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

  // PHASE-008-T8a-FW①：附件實例明寫 { prefixes: ["att"] }（與省略時之預設值
  // 完全相同——零行為變動，僅使白名單前綴在此處可見、不必回頭查
  // LocalVolumeStorage 的預設值定義）。
  const storage = new LocalVolumeStorage(storageRoot, { prefixes: ["att"] });
  await fastify.register(attachmentPlugin, { prisma, storage });

  // Report storage root resolution mirrors ATTACHMENT_STORAGE_ROOT above
  // (Spec §10-2, §16 D6; T7-FW2④ — fail-fast shape must mirror
  // ATTACHMENT_STORAGE_ROOT's production fail-fast exactly):
  //   Priority: options.reportStorageRoot (test injection) > env REPORT_STORAGE_ROOT
  //   (compose/Zeabur mount) > production fail-fast > non-production dynamic temp fallback.
  //
  // PHASE-009-T12a：本區塊由原本的「reportsPlugin 註冊前」**前移至此**
  // （applicationsPlugin 註冊之前）——作廢端點（POST /applications/:id/void）
  // 於 D4(b1) 之下需要同一份報表 storage 來寫入作廢版 PDF（AC-21(a)），而
  // `applicationsPlugin` 註冊於下方。前移只改變建構時機，不改變解析優先序、
  // production fail-fast 形狀或 `{ prefixes: ["rpt"] }` 之字面。**兩個 plugin
  // 共用同一個實例**（不新建第二個 `LocalVolumeStorage`）：storage root 之解
  // 析是本檔的單一事實來源，另建實例等於複製該段邏輯，兩份一旦分歧就會出現
  // 「作廢端點寫進 A、下載端點讀 B」的靜默資料錯置（同紀律已逐字記於
  // `applications/routes.ts` 之 `attachmentStorage` 註解）。
  const resolvedReportStorageRoot = options.reportStorageRoot ?? appEnv.REPORT_STORAGE_ROOT;

  let reportStorageRoot: string;
  if (resolvedReportStorageRoot) {
    reportStorageRoot = resolvedReportStorageRoot;
  } else if (appEnv.NODE_ENV === "production") {
    throw new Error(
      "Server startup failed — REPORT_STORAGE_ROOT is not set. " +
        "Provide the environment variable (volume mount path) for the persistent PDF storage volume."
    );
  } else {
    reportStorageRoot = path.join(os.tmpdir(), `rpt-storage-dev-${process.pid}`);
    fastify.log.warn(
      `REPORT_STORAGE_ROOT not set; using dynamic temp path for non-production: ${reportStorageRoot.replace(os.tmpdir(), "<tmpdir>")}`
    );
  }

  // T8a-FW①：報表實例明寫 { prefixes: ["rpt"] }（封閉前綴集合，與附件實例
  // 互不接受對方之 key，AC-26）。
  const reportStorage = new LocalVolumeStorage(reportStorageRoot, { prefixes: ["rpt"] });

  // Register applications routes (差旅草稿 CRUD — PHASE-004-T3)
  // PHASE-009-T7：修正版端點（POST /applications/:id/revision）會連同證明附件
  // 一併複製位元組，故注入**同一個**附件 storage 實例（不另建，見
  // `applications/routes.ts` 之 `ApplicationsPluginOptions` 註解）。
  // PHASE-009-T12a：作廢端點（POST /applications/:id/void）於同一交易內產生作
  // 廢版 PDF，故一併注入報表 storage 與兩個渲染參數——與 `reportsPlugin` 拿到
  // 的是**同一個** `reportStorage` 實例、同一組 env 值。
  await fastify.register(applicationsPlugin, {
    prisma,
    attachmentStorage: storage,
    reportStorage,
    imageMaxPx: appEnv.REPORT_IMAGE_MAX_PX,
    pdfTimeoutMs: appEnv.REPORT_PDF_TIMEOUT_MS,
  });

  // Register mileage statistics route (GET /statistics/mileage — PHASE-005-T4)
  await fastify.register(mileagePlugin, { prisma });

  // Register reports routes (POST /applications/:id/report — PHASE-008-T8)
  await fastify.register(reportsPlugin, {
    prisma,
    attachmentStorage: storage,
    reportStorage,
    imageMaxPx: appEnv.REPORT_IMAGE_MAX_PX,
    pdfTimeoutMs: appEnv.REPORT_PDF_TIMEOUT_MS,
  });

  // Graceful shutdown: disconnect Prisma
  fastify.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  return fastify;
}
