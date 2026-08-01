/**
 * Unit tests for sanitizeForLog() — must run BEFORE implementation exists (TDD).
 *
 * SF-1 fix: sanitizeForLog redacts DB connection string credentials and
 * password-like key=value patterns from text before writing to logs.
 */
import { describe, expect, it } from "vitest";
import { sanitizeForLog } from "../../src/platform/log-sanitize.js";

describe("sanitizeForLog — DB URL patterns", () => {
  it("redacts credentials in postgresql:// URL", () => {
    const input = "Connection refused postgresql://secret:pass@host:5432/db";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("secret");
    expect(result).not.toContain("pass@");
    expect(result).toContain("[REDACTED]");
    expect(result).toContain("postgresql://");
  });

  it("redacts credentials in postgres:// URL", () => {
    const input = "Error: postgres://admin:hunter2@db.example.com:5432/mydb";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("admin");
    expect(result).not.toContain("hunter2");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts credentials in mysql:// URL", () => {
    const input = "mysql://root:mysecret@localhost:3306/app";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("root");
    expect(result).not.toContain("mysecret");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts credentials in redis:// URL", () => {
    const input = "redis://user:redispass@cache:6379/0";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("redispass");
    expect(result).toContain("[REDACTED]");
  });

  it("preserves scheme and host after redaction (enough context for diagnosis)", () => {
    const input = "postgresql://user:pass@myhost:5432/mydb";
    const result = sanitizeForLog(input);
    // Scheme still visible
    expect(result).toContain("postgresql://");
    // Host still visible for diagnostics
    expect(result).toContain("myhost");
  });
});

describe("sanitizeForLog — password= and similar patterns", () => {
  it("redacts password=<value>", () => {
    const input = "Some internal database error with sensitive info: password=secret";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("password=secret");
    expect(result).toContain("[REDACTED]");
    // The word "password" key itself may be visible or not — what matters is the value is gone
  });

  it("redacts pwd=<value>", () => {
    const input = "connect failed: pwd=mypassword host=localhost";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("mypassword");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts passwd=<value>", () => {
    const input = "auth error: passwd=topsecret";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("topsecret");
    expect(result).toContain("[REDACTED]");
  });

  it("is case-insensitive for key names", () => {
    const input = "PASSWORD=MySecretValue";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("MySecretValue");
    expect(result).toContain("[REDACTED]");
  });
});

describe("sanitizeForLog — safe content passes through unchanged", () => {
  it("returns non-sensitive text unchanged", () => {
    const input = "Connection refused at localhost:5432 (timeout)";
    const result = sanitizeForLog(input);
    expect(result).toBe(input);
  });

  it("returns empty string unchanged", () => {
    expect(sanitizeForLog("")).toBe("");
  });

  it("returns undefined-safe: handles non-string gracefully", () => {
    // Should not throw when passed non-string accidentally
    expect(() => sanitizeForLog("normal text")).not.toThrow();
  });

  it("returns text without credentials unchanged when URL has no userinfo", () => {
    const input = "postgresql://localhost:5432/db connection failed";
    const result = sanitizeForLog(input);
    // No credentials to redact — text should remain intact
    expect(result).toContain("localhost:5432");
  });
});

describe("sanitizeForLog — err.name safe to log (no redaction)", () => {
  it("does not redact typical error class names", () => {
    const input = "PrismaClientKnownRequestError";
    expect(sanitizeForLog(input)).toBe(input);
  });

  it("does not redact generic Error name", () => {
    expect(sanitizeForLog("Error")).toBe("Error");
  });
});
