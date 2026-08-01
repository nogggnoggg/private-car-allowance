/**
 * Unit tests for config/env.ts — parseEnv()
 * TDD: written BEFORE implementation, expected to fail first.
 *
 * PHASE-003-T2: tests for ATTACHMENT_* env variables added at bottom.
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

  // ── PHASE-003-T2: Attachment storage env variables (Spec §8) ────────────

  describe("PHASE-003-T2 attachment env vars", () => {
    const baseEnv = {
      DATABASE_URL: "postgresql://user:pass@localhost:5432/test_db",
      NODE_ENV: "test",
    };

    it("ATTACHMENT_STORAGE_ROOT is optional and parsed as string when provided", () => {
      const config = parseEnv({ ...baseEnv, ATTACHMENT_STORAGE_ROOT: "/data/attachments" });
      expect(config.ATTACHMENT_STORAGE_ROOT).toBe("/data/attachments");
    });

    it("ATTACHMENT_STORAGE_ROOT is undefined when not provided", () => {
      const config = parseEnv({ ...baseEnv });
      expect(config.ATTACHMENT_STORAGE_ROOT).toBeUndefined();
    });

    it("ATTACHMENT_MAX_BYTES defaults to 10485760 (10 MiB)", () => {
      const config = parseEnv({ ...baseEnv });
      expect(config.ATTACHMENT_MAX_BYTES).toBe(10485760);
    });

    it("ATTACHMENT_MAX_BYTES is coerced from string to number", () => {
      const config = parseEnv({ ...baseEnv, ATTACHMENT_MAX_BYTES: "5242880" });
      expect(config.ATTACHMENT_MAX_BYTES).toBe(5242880);
    });

    it("ATTACHMENT_TEMP_TTL_HOURS defaults to 24", () => {
      const config = parseEnv({ ...baseEnv });
      expect(config.ATTACHMENT_TEMP_TTL_HOURS).toBe(24);
    });

    it("ATTACHMENT_TEMP_TTL_HOURS is coerced from string to number", () => {
      const config = parseEnv({ ...baseEnv, ATTACHMENT_TEMP_TTL_HOURS: "48" });
      expect(config.ATTACHMENT_TEMP_TTL_HOURS).toBe(48);
    });

    it("ATTACHMENT_THUMBNAIL_MAX_PX defaults to 512", () => {
      const config = parseEnv({ ...baseEnv });
      expect(config.ATTACHMENT_THUMBNAIL_MAX_PX).toBe(512);
    });

    it("ATTACHMENT_THUMBNAIL_MAX_PX is coerced from string to number", () => {
      const config = parseEnv({ ...baseEnv, ATTACHMENT_THUMBNAIL_MAX_PX: "256" });
      expect(config.ATTACHMENT_THUMBNAIL_MAX_PX).toBe(256);
    });

    it("ATTACHMENT_MAX_BYTES rejects zero (must be positive)", () => {
      expect(() => parseEnv({ ...baseEnv, ATTACHMENT_MAX_BYTES: "0" })).toThrowError(
        /ATTACHMENT_MAX_BYTES/
      );
    });

    it("ATTACHMENT_TEMP_TTL_HOURS rejects zero (must be positive)", () => {
      expect(() => parseEnv({ ...baseEnv, ATTACHMENT_TEMP_TTL_HOURS: "0" })).toThrowError(
        /ATTACHMENT_TEMP_TTL_HOURS/
      );
    });
  });
});
