/**
 * Login service — PHASE-002-T3/T4.
 *
 * Implements the login flow per Spec 4.5.1 / AC-01/02/03/14/15/16:
 *   1. Look up user by loginName
 *   2. If not found: fake verify against DUMMY_HASH (timing protection) → unified 401
 *   3. Check lockedUntil — if in future, reject (AC-15); if in past, reset count (AC-16)
 *   4. Check isActive (disabled → unified 401; does NOT increment count per Spec 4.5 literal)
 *   5. verifyPassword against stored hash
 *   6. On wrong password: increment failedLoginCount; if >= maxFailures, set lockedUntil (AC-14)
 *   7. On success: clear failedLoginCount / lockedUntil, create session, set Cookie
 *
 * Unified error message (Spec 4.5.1 / 5.3):
 *   "帳號或密碼錯誤，或此帳號目前無法登入"
 *   code: UNAUTHORIZED, HTTP 401
 *
 * Locking rules (Spec 4.5 / D4):
 *   - Only "密碼錯誤" (password wrong for active, unlocked account) increments count
 *   - Locked period does NOT extend on retries (no infinite lock)
 *   - Expired lockedUntil → treat as unlocked; count restarts from 0 (not cumulative)
 *   - Non-existent accounts: no DB changes (no row to create)
 *   - Disabled accounts: unified 401 but count NOT incremented (no password verify performed)
 */

import type { PrismaClient } from "@prisma/client";
import { AppError } from "../platform/errors.js";
import { DUMMY_HASH, verifyPassword } from "./password.js";
import { createSession, toUserDto } from "./session.js";
import type { UserDto } from "./session.js";

/** Spec 4.5.1 / AC-02 unified login error message */
export const UNIFIED_LOGIN_ERROR_MESSAGE = "帳號或密碼錯誤，或此帳號目前無法登入";

/** Throw the unified 401 (same message for all failure paths, AC-02) */
function throwUnifiedLoginError(): never {
  throw new AppError("UNAUTHORIZED", 401, UNIFIED_LOGIN_ERROR_MESSAGE);
}

export interface LoginResult {
  userDto: UserDto;
  rawToken: string;
  expiresAt: Date;
  redirect: "home" | "change-password-forced";
}

/**
 * Perform login authentication and session creation.
 *
 * @param prisma       PrismaClient instance
 * @param loginName    Submitted login name
 * @param password     Submitted plaintext password
 * @param ttlHours     Session TTL in hours (from env SESSION_ABSOLUTE_TTL_HOURS)
 * @param maxFailures  Max consecutive failures before lockout (from env LOGIN_MAX_FAILURES)
 * @param lockMinutes  Lockout duration in minutes (from env LOGIN_LOCK_MINUTES)
 * @returns LoginResult on success; throws AppError(UNAUTHORIZED) on any failure
 */
export async function performLogin(
  prisma: PrismaClient,
  loginName: string,
  password: string,
  ttlHours: number,
  maxFailures = 5,
  lockMinutes = 15
): Promise<LoginResult> {
  // Step 1: Look up user
  const user = await prisma.user.findUnique({ where: { loginName } });

  if (!user) {
    // Step 2: Fake verify for timing safety (Spec 4.5.1 / D3)
    await verifyPassword(password, DUMMY_HASH);
    throwUnifiedLoginError();
  }

  const now = new Date();

  // Step 3: Check lock status (AC-14/15/16)
  if (user.lockedUntil !== null) {
    if (user.lockedUntil > now) {
      // Account is actively locked — reject even correct password (AC-15)
      // Still run a fake verify for timing consistency; do NOT change lock state (no extension)
      await verifyPassword(password, DUMMY_HASH);
      throwUnifiedLoginError();
    }
    // lockedUntil is in the past (expired) → treat as unlocked; reset count to 0 (AC-16)
    // This "cleared" state is applied below so the subsequent wrong-password path starts fresh
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    // Reflect the cleared state in our local user object
    user.failedLoginCount = 0;
    user.lockedUntil = null;
  }

  // Step 4: Check isActive (disabled → unified 401, no count change per Spec 4.5 literal)
  // The spec says "密碼錯誤 → +1". Disabled check happens before password verify, so no
  // password error occurs → no count increment for disabled accounts.
  if (!user.isActive) {
    // Still run verify for timing consistency (D3)
    await verifyPassword(password, DUMMY_HASH);
    throwUnifiedLoginError();
  }

  // Step 5: Verify password
  const passwordOk = await verifyPassword(password, user.passwordHash);

  if (!passwordOk) {
    // Step 6: Wrong password → increment failedLoginCount (AC-14 / Spec 4.5 rule 1)
    const newCount = user.failedLoginCount + 1;
    const shouldLock = newCount >= maxFailures;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: newCount,
        // Set lockedUntil only when threshold reached; do NOT reset if already locked
        ...(shouldLock ? { lockedUntil: new Date(now.getTime() + lockMinutes * 60 * 1000) } : {}),
      },
    });

    throwUnifiedLoginError();
  }

  // Step 7: Success — clear failedLoginCount / lockedUntil, create session (AC-16)
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null },
  });

  const { rawToken, expiresAt } = await createSession(
    prisma,
    user.id,
    user.mustChangePassword,
    ttlHours
  );

  // Step 8: Determine redirect (AC-01/03)
  const redirect: "home" | "change-password-forced" = user.mustChangePassword
    ? "change-password-forced"
    : "home";

  return {
    userDto: toUserDto(user),
    rawToken,
    expiresAt,
    redirect,
  };
}
