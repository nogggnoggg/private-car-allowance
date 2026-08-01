/**
 * Login service — PHASE-002-T3.
 *
 * Implements the login flow per Spec 4.5.1 / AC-01/02/03:
 *   1. Look up user by loginName
 *   2. If not found: fake verify against DUMMY_HASH (timing protection) → unified 401
 *   3. Check lockedUntil (T3 reads and enforces; T4 adds counting logic)
 *   4. Check isActive
 *   5. verifyPassword against stored hash
 *   6. On success: clear failedLoginCount / lockedUntil, create session, set Cookie
 *   7. On failure: return unified 401 (D3 — no difference between not-found/wrong-pw/disabled/locked)
 *
 * Unified error message (Spec 4.5.1 / 5.3):
 *   "帳號或密碼錯誤，或此帳號目前無法登入"
 *   code: UNAUTHORIZED, HTTP 401
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
 * @param prisma      PrismaClient instance
 * @param loginName   Submitted login name
 * @param password    Submitted plaintext password
 * @param ttlHours    Session TTL in hours (from env)
 * @returns LoginResult on success; throws AppError(UNAUTHORIZED) on any failure
 */
export async function performLogin(
  prisma: PrismaClient,
  loginName: string,
  password: string,
  ttlHours: number
): Promise<LoginResult> {
  // Step 1: Look up user
  const user = await prisma.user.findUnique({ where: { loginName } });

  if (!user) {
    // Step 2: Fake verify for timing safety (Spec 4.5.1 / D3)
    await verifyPassword(password, DUMMY_HASH);
    throwUnifiedLoginError();
  }

  // Step 3: Check lock status (T3 enforces; T4 adds counting)
  const now = new Date();
  if (user.lockedUntil !== null && user.lockedUntil > now) {
    // Account is locked — still run a fake verify for timing consistency
    await verifyPassword(password, DUMMY_HASH);
    throwUnifiedLoginError();
  }

  // Step 4: Check isActive (even before password verify — unified 401 either way)
  if (!user.isActive) {
    // Still run verify for timing consistency (D3)
    await verifyPassword(password, DUMMY_HASH);
    throwUnifiedLoginError();
  }

  // Step 5: Verify password
  const passwordOk = await verifyPassword(password, user.passwordHash);

  if (!passwordOk) {
    // T4 will add failedLoginCount increment here
    throwUnifiedLoginError();
  }

  // Step 6: Success — clear failedLoginCount / lockedUntil, create session
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

  // Step 7: Determine redirect (AC-01/03)
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
