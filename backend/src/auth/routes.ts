/**
 * Auth routes — PHASE-002-T3/T7/T8.
 *
 * Routes:
 *   POST /auth/login   — AC-01/02/03/28 (no auth required)
 *   POST /auth/logout  — AC-07 (requireAuth, NO requirePasswordChanged per Spec 5.1)
 *   GET  /me           — AC-05/06 (requireAuth, NO requirePasswordChanged per Spec 5.1)
 *   POST /me/password  — AC-03/10/11/12/13 (requireAuth only, NO requirePasswordChanged)
 *                        Serves BOTH forced change (mustChangePassword=true) and
 *                        self-initiated change (mustChangePassword=false) per Spec 5.1/D10.
 *
 * Cookie handling (Spec 4.3 / AC-28):
 *   - Name: SESSION_COOKIE_NAME (default "sid")
 *   - HttpOnly, SameSite=Lax, Path=/
 *   - Secure only when NODE_ENV=production
 *   - Max-Age aligned with expiresAt
 *
 * PHASE-011-T7 (Spec AC-09 / AC-10; §16 D7=(a), D8=(a)) — zero behaviour change:
 *   - The attribute set above is unchanged; T7 only pins it down with closed
 *     `toEqual` guards (`test/unit/cookie-options.test.ts` +
 *     `test/integration/phase11-cookie-proxy.test.ts`), because until T7 the
 *     production branch had no test coverage at all.
 *   - `buildCookieOptions` / `buildClearCookieOptions` are exported so the
 *     production branch can be unit-tested by argument injection — Spec §11.0 #5
 *     forbids setting NODE_ENV=production in tests (it trips the
 *     `global-setup.ts` :304 fail-closed guard).
 *   - `resolveSecureCookies()` is the single source of the "is this a secure
 *     connection" decision (AC-10(a)). It reads NODE_ENV only: per D8=(a) the
 *     application never trusts `X-Forwarded-*`, and HTTPS is guaranteed by the
 *     deployment platform (assumption + failure consequence: Spec §17.1 #2).
 *
 * Session validation (Spec 4.7):
 *   - Raw token from Cookie → SHA-256 → DB lookup
 *   - revokedAt IS NULL AND expiresAt > now AND user.isActive
 *   - 401 UNAUTHORIZED for any invalid/expired/revoked session
 *
 * T5/T6: requireAuth preHandler now sourced from middleware.ts.
 * /me, /auth/logout, /me/password intentionally use requireAuth only (NOT requirePasswordChanged)
 * per Spec 5.1 — mustChangePassword users must be able to change their password.
 *
 * D10: POST /me/password does NOT revoke any sessions (neither current nor other devices).
 * Self-initiated change vs. admin reset-password are intentionally different:
 *   - self-change: no session revocation (D10)
 *   - admin reset-password (T9): revokes all sessions
 */

import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config/env.js";
import { getEnvOrTestDefaults } from "../config/env.js";
import { AppError } from "../platform/errors.js";
import { performLogin } from "./login.js";
import { requireAuth } from "./middleware.js";
import { validateNewPassword } from "./password-rules.js";
import { hashPassword, verifyPassword } from "./password.js";
import { revokeSession, toUserDto } from "./session.js";

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

/**
 * Decide whether session cookies must carry the `Secure` attribute
 * (PHASE-011-T7, Spec AC-10(a) — single source of the secure-connection
 * decision; §16 D8=(a)).
 *
 * NODE_ENV is the only signal: proxy-supplied headers (`X-Forwarded-Proto`)
 * are never consulted because any client can forge them and `trustProxy`
 * stays off (`server.ts`).
 *
 * `forceSecureCookies` exists solely so integration tests can exercise the
 * production branch without setting NODE_ENV=production (Spec §11.0 #5). It is
 * deliberately ONE-WAY: it can only turn `Secure` ON. Written as `||` rather
 * than an override (`??`) so that no caller — test or otherwise — can ever
 * switch `Secure` off in production. Guarded by
 * `test/unit/cookie-options.test.ts` ("單向加嚴：可開不可關").
 */
export function resolveSecureCookies(
  nodeEnv: AppConfig["NODE_ENV"],
  forceSecureCookies?: boolean
): boolean {
  return nodeEnv === "production" || forceSecureCookies === true;
}

/**
 * Build cookie options per Spec 4.3 / AC-28.
 * Secure only in production.
 *
 * Exported for PHASE-011-T7's closed attribute-set guard (AC-09(a)(b)(c)).
 */
export function buildCookieOptions(expiresAt: Date, cookieName: string, isProduction: boolean) {
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
 *
 * Exported for PHASE-011-T7's closed attribute-set guard (AC-09(b)): the clear
 * must carry the same attributes as the set, otherwise the browser may not
 * treat it as the same cookie and a usable session cookie survives logout.
 */
export function buildClearCookieOptions(isProduction: boolean) {
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

/** Schema for POST /me/password (Spec 5.1 / AC-10/11) */
const changePasswordBodySchema = {
  type: "object",
  required: ["currentPassword", "newPassword"],
  properties: {
    currentPassword: { type: "string" },
    newPassword: { type: "string" },
  },
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Auth plugin
// ---------------------------------------------------------------------------

interface AuthPluginOptions {
  prisma: PrismaClient;
  /**
   * PHASE-011-T7: force the production cookie attribute set (i.e. `Secure`) on
   * without setting NODE_ENV=production. Test-injection only, and one-way —
   * see `resolveSecureCookies()`.
   */
  forceSecureCookies?: boolean;
}

export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (
  fastify: FastifyInstance,
  options: AuthPluginOptions
) => {
  const { prisma } = options;

  // Parse env for session config (parse only, no throw in test env — defaults used)
  const env = getEnvOrTestDefaults(process.env);

  const cookieName = env.SESSION_COOKIE_NAME;
  const ttlHours = env.SESSION_ABSOLUTE_TTL_HOURS;
  const secureCookies = resolveSecureCookies(env.NODE_ENV, options.forceSecureCookies);
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

      const cookieOptions = buildCookieOptions(result.expiresAt, cookieName, secureCookies);

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
      reply.clearCookie(cookieName, buildClearCookieOptions(secureCookies));

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

  // -------------------------------------------------------------------------
  // POST /me/password (requireAuth — NO requirePasswordChanged per Spec 5.1)
  //
  // Serves BOTH:
  //   - Forced password change (AC-03/13): mustChangePassword=true users submit
  //     their temporary password as currentPassword and a new compliant password.
  //     On success: mustChangePassword → false (session restriction lifted).
  //   - Self-initiated change (AC-10/11/12): normal users change their own password.
  //
  // Flow per Spec 5.1 / 4.5.3:
  //   1. Verify currentPassword against stored hash (wrong → 401 UNAUTHORIZED,
  //      message "目前密碼不正確" per Spec 4.5.3)
  //   2. Validate newPassword rules (< 10 chars or weak → 400 VALIDATION_ERROR + fields)
  //   3. Check new != current (same → 400 VALIDATION_ERROR + fields)
  //   4. Hash newPassword → update User.passwordHash + User.mustChangePassword=false
  //   5. Return { ok: true }
  //
  // D10: Does NOT revoke any sessions (current or other devices).
  // failedLoginCount / lockedUntil are NOT modified (unrelated to password change).
  // -------------------------------------------------------------------------

  fastify.post(
    "/me/password",
    {
      preHandler: [requireAuth(prisma)],
      schema: { body: changePasswordBodySchema },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { currentPassword, newPassword } = request.body as {
        currentPassword: string;
        newPassword: string;
      };

      const userId = request.currentUser.id;

      // Step 1: Load the current user's passwordHash from DB
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, passwordHash: true },
      });

      if (!user) {
        // Defensive: requireAuth already validated the user exists
        throw new AppError("UNAUTHORIZED", 401, "未登入或 Session 已失效");
      }

      // Step 2: Verify currentPassword against stored hash (Spec 4.5.3 / AC-10)
      const passwordOk = await verifyPassword(currentPassword, user.passwordHash);
      if (!passwordOk) {
        throw new AppError("UNAUTHORIZED", 401, "目前密碼不正確");
      }

      // Step 3: Validate newPassword rules (AC-09 — length ≥ 10, not weak)
      const validationResult = validateNewPassword(newPassword);
      if (!validationResult.valid) {
        throw new AppError(
          "VALIDATION_ERROR",
          400,
          "輸入資料有誤，請檢查標示欄位。",
          validationResult.fields
        );
      }

      // Step 4: Ensure new != current (AC-11)
      const isSamePassword = await verifyPassword(newPassword, user.passwordHash);
      if (isSamePassword) {
        throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
          { field: "newPassword", reason: "請使用與目前不同的密碼" },
        ]);
      }

      // Step 5: Hash the new password and update DB
      // mustChangePassword → false (AC-13: forced change complete; AC-12: self change)
      // D10: No session revocation (self-change does not affect sessions)
      // failedLoginCount/lockedUntil: unchanged (Spec 5.1 D10 — password change doesn't affect login counters)
      const newHash = await hashPassword(newPassword);
      await prisma.user.update({
        where: { id: userId },
        data: {
          passwordHash: newHash,
          mustChangePassword: false,
        },
      });

      return reply.status(200).send({ ok: true });
    }
  );
};
