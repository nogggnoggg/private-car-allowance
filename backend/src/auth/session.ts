/**
 * Session service — PHASE-002-T3.
 *
 * Implements DB opaque-token session (Spec 4.2/4.3):
 *   - Token generation: crypto.randomBytes(32) → base64url (placed in Cookie)
 *   - Storage: SHA-256 hash of raw token stored in Session.sessionToken
 *   - Session validity: revokedAt IS NULL AND expiresAt > now AND User.isActive
 *   - lastSeenAt: updated at most once per LAST_SEEN_THROTTLE_MS (5 min)
 *
 * Spec 4.7.1: requireAuth uses User.mustChangePassword (live value), not session snapshot.
 */

import crypto from "node:crypto";
import type { PrismaClient, Session, User } from "@prisma/client";

/** Throttle window for lastSeenAt updates: 5 minutes (Spec 4.3) */
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Generate a cryptographically random opaque token (256-bit, base64url encoded).
 * This is the raw value placed into the Cookie.
 */
export function generateRawToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Compute the SHA-256 hash of a raw token for DB storage.
 * Spec 4.3: "DB 僅存該 token 的 SHA-256 雜湊"
 */
export function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/** UserDto shape — passwordHash excluded per Spec 5.1 */
export interface UserDto {
  id: string;
  loginName: string;
  displayName: string;
  employeeNumber: string | null;
  role: string;
  isActive: boolean;
  mustChangePassword: boolean;
}

/**
 * Map a Prisma User to UserDto (strips passwordHash and internal fields).
 * Spec 5.1: "所有 User 回應 DTO 一律排除 passwordHash"
 */
export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    loginName: user.loginName,
    displayName: user.displayName,
    employeeNumber: user.employeeNumber,
    role: user.role,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
  };
}

/**
 * Create a new session for a user after successful login.
 *
 * @param prisma - PrismaClient instance
 * @param userId - The authenticated user's id
 * @param mustChangePassword - Snapshot of user's mustChangePassword at login time
 * @param ttlHours - Session absolute TTL in hours (from env SESSION_ABSOLUTE_TTL_HOURS)
 * @returns { rawToken, expiresAt } — rawToken goes into Cookie; expiresAt for Max-Age
 */
export async function createSession(
  prisma: PrismaClient,
  userId: string,
  mustChangePassword: boolean,
  ttlHours: number
): Promise<{ rawToken: string; expiresAt: Date }> {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      sessionToken: tokenHash,
      userId,
      expiresAt,
      mustChangePassword,
    },
  });

  return { rawToken, expiresAt };
}

/**
 * Validate a session from the raw cookie token.
 *
 * Checks: revokedAt IS NULL AND expiresAt > now AND user.isActive
 * Also performs throttled lastSeenAt update (>5 min since last update).
 *
 * Returns { session, user } if valid; null if invalid/expired/revoked.
 */
export async function validateSession(
  prisma: PrismaClient,
  rawToken: string
): Promise<{ session: Session; user: User } | null> {
  const tokenHash = hashToken(rawToken);

  const session = await prisma.session.findUnique({
    where: { sessionToken: tokenHash },
    include: { user: true },
  });

  if (!session) return null;

  const now = new Date();

  // Check: not revoked
  if (session.revokedAt !== null) return null;

  // Check: not expired
  if (session.expiresAt <= now) return null;

  // Check: user still active (Spec 4.7 — double-check isActive)
  if (!session.user.isActive) return null;

  // Throttled lastSeenAt update (Spec 4.3: >5 min才寫)
  const timeSinceLastSeen = now.getTime() - session.lastSeenAt.getTime();
  if (timeSinceLastSeen > LAST_SEEN_THROTTLE_MS) {
    // Fire-and-forget: do not block the request on this write
    prisma.session
      .update({
        where: { id: session.id },
        data: { lastSeenAt: now },
      })
      .catch(() => {
        // Non-critical: log silently (lastSeenAt update failure should not reject the session)
      });
  }

  return { session, user: session.user };
}

/**
 * Revoke (delete) a session by raw token (logout).
 * Spec AC-07: logout deletes the session so it can no longer be used.
 */
export async function revokeSession(prisma: PrismaClient, rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  await prisma.session.deleteMany({
    where: { sessionToken: tokenHash },
  });
}

/**
 * Revoke all sessions for a user (used by deactivate / reset-password — T9).
 * Spec AC-20/22: stopping user or resetting password invalidates all their sessions.
 */
export async function revokeAllUserSessions(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}
