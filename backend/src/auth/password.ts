/**
 * Password hashing service — PHASE-002-T2.
 *
 * Primary: argon2id (AC-08, Spec 4.1).
 * Parameters: memoryCost=19456 KiB, timeCost=2, parallelism=1 (OWASP recommendation).
 * Self-describing encoded string stored in User.passwordHash.
 *
 * DUMMY_HASH: pre-computed argon2id hash used for timing-safe fake verification
 * when the account does not exist (D3/4.5.1). Always returns false on verify.
 */

import argon2 from "argon2";

/** argon2id parameters (Spec 4.1) */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // ~19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hash a plaintext password using argon2id.
 * Returns a self-describing encoded string suitable for storage in User.passwordHash.
 * Each call produces a unique output (random salt).
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a plaintext password against a stored argon2id hash.
 * Returns true if the password matches, false otherwise.
 * Does NOT throw — always returns a boolean (caller handles auth logic).
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // malformed hash or other error → treat as no-match (never expose error details)
    return false;
  }
}

/**
 * DUMMY_HASH — a valid argon2id hash of a random internal string.
 * Used for timing-safe fake verification when an account does not exist (D3/4.5.1):
 *
 *   const exists = await findUser(loginName);
 *   const match = exists
 *     ? await verifyPassword(password, exists.passwordHash)
 *     : await verifyPassword(password, DUMMY_HASH); // always false, but takes same time
 *
 * This prevents attackers from distinguishing "account does not exist" from "wrong password"
 * via timing side-channel.
 *
 * IMPORTANT: verifyPassword against DUMMY_HASH always returns false.
 */
export const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2Fs$oFaEAqYlhNqTe6X7YlH+qRiRG0BFSbSMMqnGEBSB3Rs";
