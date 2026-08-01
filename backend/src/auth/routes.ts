/**
 * Auth routes — PHASE-002-T3.
 *
 * Routes:
 *   POST /auth/login   — AC-01/02/03/28 (no auth required)
 *   POST /auth/logout  — AC-07 (requireAuth, NO requirePasswordChanged per Spec 5.1)
 *   GET  /me           — AC-05/06 (requireAuth, NO requirePasswordChanged per Spec 5.1)
 *
 * Cookie handling (Spec 4.3 / AC-28):
 *   - Name: SESSION_COOKIE_NAME (default "sid")
 *   - HttpOnly, SameSite=Lax, Path=/
 *   - Secure only when NODE_ENV=production
 *   - Max-Age aligned with expiresAt
 *
 * Session validation (Spec 4.7):
 *   - Raw token from Cookie → SHA-256 → DB lookup
 *   - revokedAt IS NULL AND expiresAt > now AND user.isActive
 *   - 401 UNAUTHORIZED for any invalid/expired/revoked session
 *
 * T5/T6: requireAuth preHandler now sourced from middleware.ts.
 * /me and /auth/logout intentionally use requireAuth only (NOT requirePasswordChanged)
 * per Spec 5.1 — mustChangePassword users must still be able to logout and view their info.
 */

import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { parseEnv } from "../config/env.js";
import { performLogin } from "./login.js";
import { requireAuth } from "./middleware.js";
import { revokeSession, toUserDto } from "./session.js";

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

/**
 * Build cookie options per Spec 4.3 / AC-28.
 * Secure only in production.
 */
function buildCookieOptions(expiresAt: Date, cookieName: string, isProduction: boolean) {
  const maxAgeSeconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: isProduction,
    maxAge: maxAgeSeconds,
  };
}

/**
 * Build clear-cookie options (Max-Age=0) for logout.
 */
function buildClearCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: isProduction,
    maxAge: 0,
  };
}

// ---------------------------------------------------------------------------
// Request/response schemas (Fastify schema validation → VALIDATION_ERROR on miss)
// ---------------------------------------------------------------------------

const loginBodySchema = {
  type: "object",
  required: ["loginName", "password"],
  properties: {
    loginName: { type: "string" },
    password: { type: "string" },
  },
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Auth plugin
// ---------------------------------------------------------------------------

interface AuthPluginOptions {
  prisma: PrismaClient;
}

export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (
  fastify: FastifyInstance,
  options: AuthPluginOptions
) => {
  const { prisma } = options;

  // Parse env for session config (parse only, no throw in test env — defaults used)
  let env: ReturnType<typeof parseEnv>;
  try {
    env = parseEnv(process.env);
  } catch {
    // During testing with partial env, use defaults
    env = {
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://localhost/test",
      NODE_ENV: (process.env.NODE_ENV as "development" | "production" | "test") ?? "development",
      PORT: 3000,
      LOG_LEVEL: "info" as const,
      STORAGE_PATH: "/data/storage",
      SESSION_ABSOLUTE_TTL_HOURS: 8,
      SESSION_COOKIE_NAME: "sid",
      LOGIN_MAX_FAILURES: 5,
      LOGIN_LOCK_MINUTES: 15,
    };
  }

  const cookieName = env.SESSION_COOKIE_NAME;
  const ttlHours = env.SESSION_ABSOLUTE_TTL_HOURS;
  const isProduction = env.NODE_ENV === "production";
  const maxFailures = env.LOGIN_MAX_FAILURES;
  const lockMinutes = env.LOGIN_LOCK_MINUTES;

  // -------------------------------------------------------------------------
  // POST /auth/login
  // -------------------------------------------------------------------------

  fastify.post(
    "/auth/login",
    {
      schema: {
        body: loginBodySchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { loginName, password } = request.body as { loginName: string; password: string };

      const result = await performLogin(
        prisma,
        loginName,
        password,
        ttlHours,
        maxFailures,
        lockMinutes
      );

      const cookieOptions = buildCookieOptions(result.expiresAt, cookieName, isProduction);

      reply.setCookie(cookieName, result.rawToken, cookieOptions);

      return reply.status(200).send({
        user: result.userDto,
        redirect: result.redirect,
      });
    }
  );

  // -------------------------------------------------------------------------
  // POST /auth/logout (requireAuth — NO requirePasswordChanged per Spec 5.1)
  // mustChangePassword users must be able to logout
  // -------------------------------------------------------------------------

  fastify.post(
    "/auth/logout",
    { preHandler: [requireAuth(prisma)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Extract raw token for session revocation
      // At this point requireAuth has already validated the session and set request.currentUser
      const rawToken = (request.cookies as Record<string, string | undefined>)[cookieName];

      // Delete the session (AC-07: logout makes token unusable)
      // rawToken is guaranteed to exist here because requireAuth passed
      if (rawToken) {
        await revokeSession(prisma, rawToken);
      }

      // Clear the cookie
      reply.clearCookie(cookieName, buildClearCookieOptions(isProduction));

      return reply.status(200).send({ ok: true });
    }
  );

  // -------------------------------------------------------------------------
  // GET /me (requireAuth — NO requirePasswordChanged per Spec 5.1)
  // mustChangePassword users must be able to view their own info
  // -------------------------------------------------------------------------

  fastify.get(
    "/me",
    { preHandler: [requireAuth(prisma)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // request.currentUser is guaranteed to be set by requireAuth preHandler
      // Re-fetch the full user for the DTO (currentUser has minimal fields)
      const user = await prisma.user.findUnique({
        where: { id: request.currentUser.id },
      });

      if (!user) {
        // This shouldn't happen (requireAuth validated), but handle defensively
        throw new Error("User not found after authentication");
      }

      return reply.status(200).send({
        user: toUserDto(user),
      });
    }
  );
};
