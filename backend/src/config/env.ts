/**
 * Environment variable schema validation using zod.
 * AC-09: Missing/invalid env vars cause startup failure listing names (not values).
 */
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url({ message: "must be a valid URL" }),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  STORAGE_PATH: z.string().default("/data/storage"),
});

export type AppConfig = z.infer<typeof envSchema>;

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
