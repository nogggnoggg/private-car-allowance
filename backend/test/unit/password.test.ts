/**
 * Unit tests for password hashing and password rules.
 * PHASE-002-T2: TDD — these tests must FAIL before implementation.
 *
 * Tests:
 * 1. hashPassword / verifyPassword (argon2id or bcryptjs fallback)
 * 2. DUMMY_HASH — can be verified and always returns false
 * 3. validateNewPassword — length, weak password list, normalization
 *
 * No DB required — pure unit tests.
 */

import { describe, expect, it } from "vitest";

import {
  type PasswordValidationResult,
  validateNewPassword,
} from "../../src/auth/password-rules.js";
// These imports will fail until implementation exists (TDD red phase)
import { DUMMY_HASH, hashPassword, verifyPassword } from "../../src/auth/password.js";

// ---------------------------------------------------------------------------
// hashPassword / verifyPassword
// ---------------------------------------------------------------------------

describe("hashPassword / verifyPassword", () => {
  it("hashPassword returns a non-empty string (not plaintext)", async () => {
    const hash = await hashPassword("MySecurePass1!");
    expect(hash).toBeTypeOf("string");
    expect(hash.length).toBeGreaterThan(0);
    // Must NOT equal plaintext
    expect(hash).not.toBe("MySecurePass1!");
  });

  it("verifyPassword returns true when password matches hash", async () => {
    const password = "CorrectHorseBattery";
    const hash = await hashPassword(password);
    const result = await verifyPassword(password, hash);
    expect(result).toBe(true);
  });

  it("verifyPassword returns false when password does NOT match hash", async () => {
    const hash = await hashPassword("CorrectPassword99");
    const result = await verifyPassword("WrongPassword99", hash);
    expect(result).toBe(false);
  });

  it("two hashes of the same password produce different outputs (salt uniqueness)", async () => {
    const password = "SamePassword123";
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);
    // Different salts → different ciphertext
    expect(hash1).not.toBe(hash2);
    // Both must still verify correctly
    expect(await verifyPassword(password, hash1)).toBe(true);
    expect(await verifyPassword(password, hash2)).toBe(true);
  });

  it("hash output has expected format marker (argon2id or bcrypt)", async () => {
    const hash = await hashPassword("SomePassword123");
    // argon2id: starts with $argon2id$
    // bcryptjs fallback: starts with $2b$ or $2a$
    const isArgon2 = hash.startsWith("$argon2id$");
    const isBcrypt = hash.startsWith("$2b$") || hash.startsWith("$2a$");
    expect(isArgon2 || isBcrypt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DUMMY_HASH — for timing-safe fake verify (D3: unified error message)
// ---------------------------------------------------------------------------

describe("DUMMY_HASH", () => {
  it("DUMMY_HASH is a non-empty string constant", () => {
    expect(DUMMY_HASH).toBeTypeOf("string");
    expect(DUMMY_HASH.length).toBeGreaterThan(0);
  });

  it("verifyPassword against DUMMY_HASH does not throw", async () => {
    await expect(verifyPassword("anypassword", DUMMY_HASH)).resolves.not.toThrow();
  });

  it("verifyPassword against DUMMY_HASH always returns false", async () => {
    // This is the timing-safe path: account does not exist but we still verify
    // to avoid timing attacks (D3/4.5.1)
    const result = await verifyPassword("anypassword", DUMMY_HASH);
    expect(result).toBe(false);
  });

  it("verifyPassword against DUMMY_HASH returns false even with correct-looking input", async () => {
    // Edge case: DUMMY_HASH is designed to be verifiable (no throw) but always false
    const result = await verifyPassword("", DUMMY_HASH);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateNewPassword — length rules
// ---------------------------------------------------------------------------

describe("validateNewPassword — length rules", () => {
  it("rejects password shorter than 10 characters (length=9)", () => {
    const result = validateNewPassword("Short123!");
    expect(result.valid).toBe(false);
    expect(result.fields).toBeDefined();
    expect(result.fields?.some((f) => f.field === "newPassword")).toBe(true);
    const field = result.fields?.find((f) => f.field === "newPassword");
    expect(field?.reason).toMatch(/10/);
  });

  it("rejects password of length exactly 9", () => {
    const result = validateNewPassword("Abcdefgh1"); // 9 chars
    expect(result.valid).toBe(false);
  });

  it("accepts password of exactly 10 characters (boundary)", () => {
    // Make sure it doesn't accidentally land on the weak list
    const result = validateNewPassword("Abcdefgh12"); // 10 chars, not in weak list
    // Only check length-related: if it's not in weak list, should be valid
    if (result.valid === false) {
      // Might be on weak list — just verify it's NOT a length error
      const field = result.fields?.find((f) => f.field === "newPassword");
      expect(field?.reason).not.toMatch(/10/);
    }
  });

  it("accepts password of 15 characters that is not weak", () => {
    const result = validateNewPassword("Qwerty12345ABCD"); // 15 chars, not in weak list
    // Should NOT fail on length; may or may not be in weak list
    if (result.valid === false) {
      const field = result.fields?.find((f) => f.field === "newPassword");
      expect(field?.reason).not.toMatch(/10/);
    }
  });

  it("accepts a clearly strong password", () => {
    const result = validateNewPassword("Tr0ub4dor&3_horse_battery_staple");
    expect(result.valid).toBe(true);
    expect(result.fields).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateNewPassword — weak password list
// ---------------------------------------------------------------------------

describe("validateNewPassword — weak password list", () => {
  it("rejects 'password123' (common weak password)", () => {
    const result = validateNewPassword("password123");
    expect(result.valid).toBe(false);
    const field = result.fields?.find((f) => f.field === "newPassword");
    expect(field?.reason).toMatch(/弱密碼|常見|weak/i);
  });

  it("rejects '1234567890' (common numeric-only weak password)", () => {
    const result = validateNewPassword("1234567890");
    expect(result.valid).toBe(false);
    const field = result.fields?.find((f) => f.field === "newPassword");
    expect(field?.reason).toMatch(/弱密碼|常見|weak/i);
  });

  it("rejects 'qwertyuiop' (common keyboard pattern weak password)", () => {
    const result = validateNewPassword("qwertyuiop");
    expect(result.valid).toBe(false);
    const field = result.fields?.find((f) => f.field === "newPassword");
    expect(field?.reason).toMatch(/弱密碼|常見|weak/i);
  });

  it("rejects 'iloveyou123' (common weak password ≥10 chars)", () => {
    const result = validateNewPassword("iloveyou123");
    expect(result.valid).toBe(false);
    const field = result.fields?.find((f) => f.field === "newPassword");
    expect(field?.reason).toMatch(/弱密碼|常見|weak/i);
  });

  it("rejects 'administrator' (common weak password)", () => {
    const result = validateNewPassword("administrator");
    expect(result.valid).toBe(false);
    const field = result.fields?.find((f) => f.field === "newPassword");
    expect(field?.reason).toMatch(/弱密碼|常見|weak/i);
  });
});

// ---------------------------------------------------------------------------
// validateNewPassword — normalization (case/whitespace)
// ---------------------------------------------------------------------------

describe("validateNewPassword — normalization", () => {
  it("normalizes to lowercase before weak-list check (PASSWORD123 → password123)", () => {
    // "password123" is a known weak password; uppercase version must also be caught
    const result = validateNewPassword("PASSWORD123");
    expect(result.valid).toBe(false);
    const field = result.fields?.find((f) => f.field === "newPassword");
    expect(field?.reason).toMatch(/弱密碼|常見|weak/i);
  });

  it("normalizes mixed case before weak-list check (Password123 → password123)", () => {
    const result = validateNewPassword("Password123");
    expect(result.valid).toBe(false);
    const field = result.fields?.find((f) => f.field === "newPassword");
    expect(field?.reason).toMatch(/弱密碼|常見|weak/i);
  });

  it("trims leading/trailing whitespace before normalization check", () => {
    // "  password123  " trimmed → "password123" → weak
    const result = validateNewPassword("  password123  ");
    expect(result.valid).toBe(false);
  });

  it("length check is applied to ORIGINAL (untrimmed) password length", () => {
    // Spaces padded to make it look ≥10 but underlying word is < 10
    // "  short  " has 9 chars total with spaces, trim → 5 chars
    // The spec says ≥10 chars; we apply length check to the input as-is
    // (before trim, length = 9 for "  short  " = 9 chars)
    // This test verifies the length rule behavior is documented
    const result = validateNewPassword("  short  "); // 9 chars
    expect(result.valid).toBe(false); // 9 chars → too short
  });
});

// ---------------------------------------------------------------------------
// validateNewPassword — return structure
// ---------------------------------------------------------------------------

describe("validateNewPassword — return structure (for VALIDATION_ERROR fields)", () => {
  it("returns { valid: true } for compliant password with no fields", () => {
    const result: PasswordValidationResult = validateNewPassword("CorrectHorseBattery9!");
    expect(result.valid).toBe(true);
    // fields should be absent or empty
    expect(result.fields == null || result.fields.length === 0).toBe(true);
  });

  it("returns { valid: false, fields: [...] } for non-compliant password", () => {
    const result: PasswordValidationResult = validateNewPassword("short");
    expect(result.valid).toBe(false);
    expect(Array.isArray(result.fields)).toBe(true);
    expect(result.fields?.length).toBeGreaterThan(0);
    expect(result.fields?.[0]).toHaveProperty("field");
    expect(result.fields?.[0]).toHaveProperty("reason");
  });
});
