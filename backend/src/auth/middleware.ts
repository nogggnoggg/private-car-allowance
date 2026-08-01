/**
 * Auth/Authz middleware — PHASE-002-T5/T6.
 *
 * Exports:
 *   requireAuth(prisma)      — Fastify preHandler factory: validates session, mounts
 *                               request.currentUser = { id, role, mustChangePassword, isActive }
 *                               Uses User live value per Spec 4.7.1 (not session snapshot).
 *   requirePasswordChanged   — Fastify preHandler: 403 PASSWORD_CHANGE_REQUIRED if
 *                               currentUser.mustChangePassword is true (AC-04).
 *   requireAdmin             — Fastify preHandler: 403 FORBIDDEN if role !== ADMIN (AC-24).
 *   assertOwnershipOrAdmin   — Pure function: passes for ADMIN or matching userId; throws
 *                               AppError(FORBIDDEN) otherwise (AC-25, BE-US-02).
 *
 * Usage order per Spec 5.1 / 5.2:
 *   Protected routes:      [requireAuth(prisma)]
 *   /me, /auth/logout:     [requireAuth(prisma)]            (no requirePasswordChanged)
 *   /me/password:          [requireAuth(prisma)]            (no requirePasswordChanged)
 *   Admin routes:          [requireAuth(prisma), requirePasswordChanged, requireAdmin]
 *
 * Spec refs: §4.7, §4.7.1, §4.8, §5.1, §5.2, AC-04/05/06/24/25
 */

import type { PrismaClient, Role } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../platform/errors.js";
import { validateSession } from "./session.js";

// ---------------------------------------------------------------------------
// Fastify type augmentation: request.currentUser
// Spec §4.7: preHandler mounts { id, role, mustChangePassword, isActive }
// ---------------------------------------------------------------------------

export interface CurrentUser {
  id: string;
  role: Role;
  mustChangePassword: boolean;
  isActive: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    currentUser: CurrentUser;
  }
}

// ---------------------------------------------------------------------------
// Cookie name resolution (mirrors routes.ts env logic)
// ---------------------------------------------------------------------------

function getCookieName(): string {
  return process.env.SESSION_COOKIE_NAME ?? "sid";
}

// ---------------------------------------------------------------------------
// requireAuth — preHandler factory
// ---------------------------------------------------------------------------

/**
 * Returns a Fastify preHandler that:
 *   1. Reads the session token from the Cookie header.
 *   2. Validates the session (revokedAt IS NULL AND expiresAt > now AND user.isActive).
 *   3. Loads the User's LIVE values (Spec 4.7.1: mustChangePassword uses live value).
 *   4. Mounts request.currentUser = { id, role, mustChangePassword, isActive }.
 *   5. Returns 401 UNAUTHORIZED if anything is invalid.
 *   6. Returns 401 UNAUTHORIZED if user.isActive=false (double-guard, Spec §4.7).
 *
 * Note: validateSession already checks user.isActive as a DB-level guard.
 * requireAuth's explicit isActive check here is the "double-guard" mentioned in Spec §4.7:
 * it re-reads the live User value (not session snapshot), which is authoritative.
 *
 * @param prisma — PrismaClient injected by the route registration
 */
export function requireAuth(prisma: PrismaClient) {
  return async function requireAuthHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const cookieName = getCookieName();

    // Extract raw token from cookie
    const rawToken = (request.cookies as Record<string, string | undefined>)[cookieName];
    if (!rawToken) {
      throw new AppError("UNAUTHORIZED", 401, "未登入或 Session 已失效");
    }

    // Validate session (DB lookup + expiry + revokedAt + user.isActive check)
    const result = await validateSession(prisma, rawToken);
    if (!result) {
      // Clear stale cookie (AC-06)
      reply.clearCookie(cookieName, { path: "/" });
      throw new AppError("UNAUTHORIZED", 401, "未登入或 Session 已失效");
    }

    const { user } = result;

    // Double-guard: use live User.isActive value (Spec §4.7)
    // validateSession already checks isActive, but requireAuth re-asserts
    // this using the live User object loaded with the session to ensure
    // mustChangePassword is also the live value (Spec §4.7.1).
    if (!user.isActive) {
      reply.clearCookie(cookieName, { path: "/" });
      throw new AppError("UNAUTHORIZED", 401, "未登入或 Session 已失效");
    }

    // Mount currentUser with LIVE values from User row (Spec §4.7.1)
    request.currentUser = {
      id: user.id,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      isActive: user.isActive,
    };
  };
}

// ---------------------------------------------------------------------------
// requirePasswordChanged — preHandler (must run AFTER requireAuth)
// ---------------------------------------------------------------------------

/**
 * Fastify preHandler that blocks access when the authenticated user must
 * change their password (AC-04, Spec §4.7).
 *
 * Uses the LIVE user value (already loaded by requireAuth into request.currentUser).
 * Returns 403 PASSWORD_CHANGE_REQUIRED if mustChangePassword=true.
 *
 * Must be chained after requireAuth:
 *   preHandler: [requireAuth(prisma), requirePasswordChanged]
 */
export async function requirePasswordChanged(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  if (request.currentUser.mustChangePassword) {
    throw new AppError("PASSWORD_CHANGE_REQUIRED", 403, "請先完成密碼變更後再繼續操作");
  }
}

// ---------------------------------------------------------------------------
// requireAdmin — preHandler (must run AFTER requireAuth)
// ---------------------------------------------------------------------------

/**
 * Fastify preHandler that restricts access to ADMIN role only (AC-24, Spec §4.7).
 *
 * Returns 403 FORBIDDEN for any role !== ADMIN.
 * Must be chained after requireAuth (and typically after requirePasswordChanged):
 *   preHandler: [requireAuth(prisma), requirePasswordChanged, requireAdmin]
 */
export async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (request.currentUser.role !== "ADMIN") {
    throw new AppError("FORBIDDEN", 403, "權限不足，此操作僅限管理員");
  }
}

// ---------------------------------------------------------------------------
// assertOwnershipOrAdmin — pure function (AC-25, BE-US-02)
// ---------------------------------------------------------------------------

/**
 * Asserts that the actor either owns the resource or is an ADMIN.
 *
 * Passes (returns void) if:
 *   - actor.role === 'ADMIN', OR
 *   - actor.id === resourceOwnerId
 *
 * Throws AppError(FORBIDDEN, 403) if neither condition is met.
 *
 * This is the unified authorization judgment point for data ownership checks
 * used across all subsequent Phases (申請/附件/報表, PHASE-004+).
 *
 * @param actor           The authenticated user (from request.currentUser)
 * @param resourceOwnerId The id of the user who owns the resource
 */
export function assertOwnershipOrAdmin(
  actor: { id: string; role: string },
  resourceOwnerId: string
): void {
  if (actor.role === "ADMIN" || actor.id === resourceOwnerId) {
    return;
  }
  throw new AppError("FORBIDDEN", 403, "無權存取此資源");
}
