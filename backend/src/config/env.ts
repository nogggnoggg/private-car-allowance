/**
 * Environment variable schema validation using zod.
 * AC-09: Missing/invalid env vars cause startup failure listing names (not values).
 *
 * PHASE-002 additions (Spec §8):
 *   SESSION_ABSOLUTE_TTL_HOURS — Session absolute expiry in hours (default 8)
 *   SESSION_COOKIE_NAME        — Cookie name (default "sid")
 *   LOGIN_MAX_FAILURES         — Consecutive failures before lockout (default 5)
 *   LOGIN_LOCK_MINUTES         — Lockout duration in minutes (default 15)
 *
 * PHASE-003-T2 additions (Spec §8):
 *   ATTACHMENT_STORAGE_ROOT    — Local volume root path for attachment files (no default; required in prod)
 *   ATTACHMENT_MAX_BYTES       — Single-file size limit in bytes (default 10 MiB)
 *   ATTACHMENT_TEMP_TTL_HOURS  — Temp attachment cleanup threshold in hours (default 24)
 *   ATTACHMENT_THUMBNAIL_MAX_PX — Thumbnail long-side pixel limit if sharp is used (default 512)
 *
 * PHASE-008-T7 additions (Spec §8, §10-2, §16 D6):
 *   REPORT_STORAGE_ROOT     — Local volume root path for generated PDF reports (no default;
 *                             production fail-fast mirrors ATTACHMENT_STORAGE_ROOT, wired in T8
 *                             server.ts — out of this file's scope, schema only accepts/parses it here)
 *   REPORT_PDF_TIMEOUT_MS   — Playwright PDF render timeout in ms, passed to pdf-renderer.ts (default 30000)
 *   REPORT_IMAGE_MAX_PX     — Report image embed long-edge pixel cap, passed to report-images.ts (default 1600)
 *
 * PHASE-011-T4 additions (Spec §8.2, AC-06(b), §16 D6-1=(a)):
 *   ATTACHMENT_CLEANUP_BATCH_LIMIT — 單次附件清理之批次上限（預設 500）。只被
 *                             `attachment/cleanup-cli.ts`（一次性 CLI，D3=(c)）
 *                             讀取；伺服器行程不讀、不排程。與
 *                             `cleanup-service.ts` 之 DEFAULT_CLEANUP_BATCH_LIMIT
 *                             為同一個數，兩處由 phase11 測試之機械斷言釘住。
 *                             **T8 已收斂**（T4 當時記為「移交 T8」）：本鍵已
 *                             同批進入 `.env.example` 與 `docker-compose.yml`
 *                             之 backend `environment:`，並受 AC-13(a)／
 *                             AC-11(e) 之機械守門。
 *   （D3=(c) 之故，Spec §8.2 草案中的 `ATTACHMENT_CLEANUP_ENABLED` 屬「若
 *    D3=(a) 內建排程」之條件列，**未新增**——沒有排程開關要開。）
 *
 * PHASE-011-T8 additions（Spec §2 D 段 AC-11／AC-13）：本檔**零新增 env 變數**，
 *   只新增兩份由 schema 導出的常數 `ENV_SCHEMA_KEYS` 與
 *   `PRODUCTION_REQUIRED_ENV_KEYS`（見各自 JSDoc），供三具機械守門引用。
 */
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url({ message: "must be a valid URL" }),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  STORAGE_PATH: z.string().default("/data/storage"),
  // PHASE-002: Session configuration (Spec §8)
  SESSION_ABSOLUTE_TTL_HOURS: z.coerce.number().int().positive().default(8),
  SESSION_COOKIE_NAME: z.string().default("sid"),
  // PHASE-002: Login lockout configuration (Spec §8, AC-14/15/16, used by T4)
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  // PHASE-003-T2: Attachment storage configuration (Spec §8)
  // Optional with no default: callers must provide or use a test-specific path.
  // In production/compose, this is set by the volume mount env var.
  ATTACHMENT_STORAGE_ROOT: z.string().optional(),
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(10485760), // 10 MiB
  ATTACHMENT_TEMP_TTL_HOURS: z.coerce.number().int().positive().default(24),
  ATTACHMENT_THUMBNAIL_MAX_PX: z.coerce.number().int().positive().default(512),
  // PHASE-011-T4: Attachment cleanup batch limit (Spec §8.2, AC-06(b))
  ATTACHMENT_CLEANUP_BATCH_LIMIT: z.coerce.number().int().positive().default(500),
  // PHASE-008-T7: Report generation configuration (Spec §8, §10-2)
  // Optional with no default, same shape as ATTACHMENT_STORAGE_ROOT — production
  // fail-fast enforcement is server.ts's responsibility (wired in T8, out of this file's scope).
  REPORT_STORAGE_ROOT: z.string().optional(),
  REPORT_PDF_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  REPORT_IMAGE_MAX_PX: z.coerce.number().int().positive().default(1600),
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * 本後端所認得的**全部** env 變數名，由 `envSchema` 直接導出、排序後凍結。
 *
 * 刻意由 `Object.keys(envSchema.shape)` 導出而非另抄一份清單：AC-13(a) 的守門
 * （`.env.example` ⊇ schema 全鍵）與 AC-11(e) 的守門（compose 鍵 ⊆ schema）都
 * 拿這份當左邊，如果它是手抄的，就會變成「兩份手抄清單互比」——兩邊一起漏掉
 * 同一個新變數時全綠，守門歸零。
 *
 * 新增一個 schema 鍵時的連動點（缺一即有機械斷言必紅）：
 *   ① 本檔 schema ＋ `getEnvOrTestDefaults` fallback
 *   ② `.env.example`（AC-13(a)，`test/unit/env-example-sync.test.ts`）
 *   ③ `docker-compose.yml` backend `environment:`（AC-11(e)，僅必要鍵為硬性）
 *   ④ `test/unit/env.test.ts` 之 `ENV_SCHEMA_KEYS` 封閉集合一格
 */
export const ENV_SCHEMA_KEYS: readonly string[] = Object.freeze(
  Object.keys(envSchema.shape).sort()
);

/**
 * **production 下缺少即拒絕啟動**的變數（Spec AC-11(c)；核銷 `KNOWN_ISSUES.md`
 * :41 O-3）。這是一份**部署契約**：清單上的每個名字都必須由部署平台提供，
 * 否則後端行程會在啟動時硬失敗而不是帶著錯誤設定跑起來。
 *
 * 三個名字的拒絕點**不在同一層**，這點對維護者很重要：
 *   · `DATABASE_URL`          — zod schema 層必填（`parseEnv` 直接拋）。
 *   · `ATTACHMENT_STORAGE_ROOT`／`REPORT_STORAGE_ROOT`
 *                             — schema 層是 `.optional()`（測試與開發環境要能
 *                               不設它而落到動態暫存路徑），真正的拒絕發生在
 *                               `server.ts` 解析 storage root 之後、判斷
 *                               `NODE_ENV === "production"` 的分支。
 *
 * 故 `phase11-env-secrets.test.ts` 的 AC-11(c) 斷言是**兩路導出取聯集**再與本
 * 常數 `toEqual`：行為導出（真的呼叫 `parseEnv` 逐鍵探針）抓第一類，結構導出
 * （讀 `server.ts` 的 fail-fast 分支）抓第二類。只做其中一路都會漏掉另一類。
 */
export const PRODUCTION_REQUIRED_ENV_KEYS: readonly string[] = Object.freeze([
  "ATTACHMENT_STORAGE_ROOT",
  "DATABASE_URL",
  "REPORT_STORAGE_ROOT",
]);

/**
 * Returns a parsed AppConfig, falling back to safe literal defaults when
 * `parseEnv` throws (e.g. incomplete test environments that omit DATABASE_URL).
 *
 * Single source of truth for fallback values — replaces the three duplicated
 * try/catch blocks in server.ts, auth/routes.ts, and attachment/routes.ts
 * (PHASE-003-T9 remediation).
 *
 * Zero behaviour change guarantee:
 *   - Fallback values match the literals previously maintained in each caller.
 *   - ATTACHMENT_STORAGE_ROOT is read from `env` so server.ts storage-root
 *     resolution continues to work correctly in non-production environments.
 *   - Production fail-fast logic in server.ts is unaffected (it operates on
 *     the resolved storageRoot AFTER this function returns).
 *
 * @param env - Raw env object (defaults to process.env).
 * @returns Typed AppConfig — either fully validated or safe test defaults.
 */
export function getEnvOrTestDefaults(
  env: Record<string, string | undefined> = process.env
): AppConfig {
  try {
    return parseEnv(env);
  } catch {
    return {
      DATABASE_URL: env.DATABASE_URL ?? "postgresql://localhost/test",
      NODE_ENV: (env.NODE_ENV as "development" | "production" | "test") ?? "development",
      PORT: 3000,
      LOG_LEVEL: "info" as const,
      STORAGE_PATH: "/data/storage",
      SESSION_ABSOLUTE_TTL_HOURS: 8,
      SESSION_COOKIE_NAME: "sid",
      LOGIN_MAX_FAILURES: 5,
      LOGIN_LOCK_MINUTES: 15,
      ATTACHMENT_STORAGE_ROOT: env.ATTACHMENT_STORAGE_ROOT,
      ATTACHMENT_MAX_BYTES: 10485760,
      ATTACHMENT_TEMP_TTL_HOURS: 24,
      ATTACHMENT_THUMBNAIL_MAX_PX: 512,
      ATTACHMENT_CLEANUP_BATCH_LIMIT: 500,
      REPORT_STORAGE_ROOT: env.REPORT_STORAGE_ROOT,
      REPORT_PDF_TIMEOUT_MS: 30000,
      REPORT_IMAGE_MAX_PX: 1600,
    };
  }
}

/**
 * Parses and validates environment variables.
 *
 * @param env - Raw env object (defaults to process.env).
 * @returns Typed config object.
 * @throws Error listing missing/invalid variable NAMES (never their values) on failure.
 */
export function parseEnv(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues;
    // Collect variable names and reasons — never include values (AC-09 security)
    const details = issues
      .map((issue) => {
        const path = issue.path.join(".") || "(root)";
        return `${path}: ${issue.message}`;
      })
      .join("; ");

    throw new Error(`Server startup failed — missing or invalid environment variables: ${details}`);
  }

  return result.data;
}
