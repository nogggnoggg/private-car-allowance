/**
 * Password validation rules — PHASE-002-T2.
 *
 * Implements Spec 4.4 / AC-09:
 *   1. Length check: password must be >= 10 characters (applied to raw input).
 *   2. Weak password check: normalize (toLower + trim) then check against static Set.
 *
 * Returns a structured result compatible with VALIDATION_ERROR fields (Spec 4.8 / 5.3).
 */

import type { FieldError } from "../platform/errors.js";
import { WEAK_PASSWORDS } from "./weak-passwords.js";

/** Minimum allowed password length (Spec 4.4 / AC-09) */
const MIN_PASSWORD_LENGTH = 10;

/** Structured validation result — feeds into VALIDATION_ERROR.fields */
export interface PasswordValidationResult {
  valid: boolean;
  /** Present only when valid=false; each entry maps to one field-level error */
  fields?: FieldError[];
}

/**
 * Validate a candidate new password against the rules in Spec 4.4.
 *
 * @param password - The raw plaintext password as submitted by the user.
 * @param _context - Optional context (loginName/displayName) reserved for future
 *                   optional enhancement (Spec 4.4 bullet 3); unused in this Phase.
 * @returns PasswordValidationResult — { valid: true } or { valid: false, fields: [...] }
 */
export function validateNewPassword(
  password: string,
  _context?: { loginName?: string; displayName?: string }
): PasswordValidationResult {
  const errors: FieldError[] = [];

  // Rule 1: Length check — applied to the raw input (before trim).
  // Spec 4.4: "長度 < 10 → 拒"
  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push({
      field: "newPassword",
      reason: `密碼至少需 ${MIN_PASSWORD_LENGTH} 個字元`,
    });
  }

  // Rule 2: Weak password check — normalize (toLower + trim) then check Set.
  // Spec 4.4: "正規化（轉小寫、去前後空白）後完全命中清單 → 拒為弱密碼"
  // Only run if length is sufficient (avoid double-reporting on very short common words).
  if (errors.length === 0) {
    const normalized = password.trim().toLowerCase();
    if (WEAK_PASSWORDS.has(normalized)) {
      errors.push({
        field: "newPassword",
        reason: "此密碼為常見弱密碼，請選擇更安全的密碼",
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, fields: errors };
  }

  return { valid: true };
}
