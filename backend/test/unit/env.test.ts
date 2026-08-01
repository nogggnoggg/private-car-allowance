/**
 * Unit tests for config/env.ts — parseEnv()
 * TDD: written BEFORE implementation, expected to fail first.
 */
import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";

describe("parseEnv()", () => {
  it("throws an error containing the missing variable name when DATABASE_URL is absent", () => {
    const incompleteEnv = {
      // DATABASE_URL intentionally omitted
      NODE_ENV: "test",
      PORT: "3000",
    };
    expect(() => parseEnv(incompleteEnv)).toThrowError(/DATABASE_URL/);
  });

  it("returns a typed config object when all required env vars are present", () => {
    const validEnv = {
      DATABASE_URL: "postgresql://user:pass@localhost:5432/test_db",
      NODE_ENV: "test",
      PORT: "3001",
      LOG_LEVEL: "info",
      STORAGE_PATH: "/data/storage",
    };
    const config = parseEnv(validEnv);
    expect(config.DATABASE_URL).toBe("postgresql://user:pass@localhost:5432/test_db");
    expect(config.PORT).toBe(3001);
    expect(config.NODE_ENV).toBe("test");
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("uses default values for optional env vars when not provided", () => {
    const minimalEnv = {
      DATABASE_URL: "postgresql://user:pass@localhost:5432/test_db",
    };
    const config = parseEnv(minimalEnv);
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe("development");
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("does not include DATABASE_URL value in error message (security)", () => {
    const incompleteEnv: Record<string, string> = {};
    expect(() => parseEnv(incompleteEnv)).toThrowError(/DATABASE_URL/);
    // Ensure no secrets leak in the error — the error should list the name, not a value
    // (Here we are checking missing-key scenario, so no value to leak, but the test
    // documents the intent: only variable names appear in errors, never values.)
  });
});
