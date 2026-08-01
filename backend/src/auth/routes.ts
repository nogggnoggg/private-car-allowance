/**
 * Auth routes — PHASE-002-T3.
 *
 * Routes:
 *   POST /auth/login   — AC-01/02/03/28 (no auth required)
 *   POST /auth/logout  — AC-07 (requireAuth)
 *   GET  /me           — AC-05/06 (requireAuth)
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
 */

import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { parseEnv } from "../config/env.js";
import { AppError } from "../platform/errors.js";
import { performLogin } from "./login.js";
import { revokeSession, toUserDto, validateSession } from "./session.js";

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
// Session validation helper (shared between logout and GET /me)
// ---------------------------------------------------------------------------

/**
 * Extract and validate the session from the request Cookie.
 * Returns { session, user } if valid.
 * Throws AppError(UNAUTHORIZED, 401) if missing/invalid/expired.
 *
 * This is the core of what T5 (requireAuth middleware) will also use.
 * Exported for reuse by T5.
 */
export async function requireValidSession(
  request: FastifyRequest,
  reply: FastifyReply,
  prisma: PrismaClient,
  cookieName: string
): Promise<ReturnType<typeof validateSession> extends Promise<infer T> ? NonNullable<T> : never> {
  // @fastify/cookie parses cookies into request.cookies
  const rawToken = (request.cookies as Record<string, string | undefined>)[cookieName];
  if (!rawToken) {
    throw new AppError("UNAUTHORIZED", 401, "未登入或 Session 已失效");
  }

  const result = await validateSession(prisma, rawToken);
  if (!result) {
    // Clear the stale cookie (AC-06: "並清除該 Cookie")
    reply.clearCookie(cookieName, { path: "/" });
    throw new AppError("UNAUTHORIZED", 401, "未登入或 Session 已失效");
  }

  return result as NonNullable<Awaited<ReturnType<typeof validateSession>>>;
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

      const result = await performLogin(prisma, loginName, password, ttlHours);

      const cookieOptions = buildCookieOptions(result.expiresAt, cookieName, isProduction);

      reply.setCookie(cookieName, result.rawToken, cookieOptions);

      return reply.status(200).send({
        user: result.userDto,
        redirect: result.redirect,
      });
    }
  );

  // -------------------------------------------------------------------------
  // POST /auth/logout (requireAuth inline)
  // -------------------------------------------------------------------------

  fastify.post("/auth/logout", async (request: FastifyRequest, reply: FastifyReply) => {
    // Validate session (inline requireAuth for T3; T5 will extract middleware)
    const rawToken = (request.cookies as Record<string, string | undefined>)[cookieName];
    if (!rawToken) {
      throw new AppError("UNAUTHORIZED", 401, "未登入或 Session 已失效");
    }

    const sessionResult = await validateSession(prisma, rawToken);
    if (!sessionResult) {
      reply.clearCookie(cookieName, { path: "/" });
      throw new AppError("UNAUTHORIZED", 401, "未登入或 Session 已失效");
    }

    // Delete the session (AC-07: logout makes token unusable)
    await revokeSession(prisma, rawToken);

    // Clear the cookie
    reply.clearCookie(cookieName, buildClearCookieOptions(isProduction));

    return reply.status(200).send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // GET /me (requireAuth inline)
  // -------------------------------------------------------------------------

  fastify.get("/me", async (request: FastifyRequest, reply: FastifyReply) => {
    // Validate session (inline requireAuth for T3)
    const rawToken = (request.cookies as Record<string, string | undefined>)[cookieName];
    if (!rawToken) {
      throw new AppError("UNAUTHORIZED", 401, "未登入或 Session 已失效");
    }

    const sessionResult = await validateSession(prisma, rawToken);
    if (!sessionResult) {
      reply.clearCookie(cookieName, { path: "/" });
      throw new AppError("UNAUTHORIZED", 401, "未登入或 Session 已失效");
    }

    const { user } = sessionResult;

    return reply.status(200).send({
      user: toUserDto(user),
    });
  });
};
