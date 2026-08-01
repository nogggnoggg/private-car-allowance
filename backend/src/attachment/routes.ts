/**
 * Attachment routes — PHASE-003-T3
 *
 * Routes registered in this module (T3 scope):
 *   POST /attachments  — stream upload, magic-byte validation, size limit,
 *                        storage put, thumbnail, DB record (TEMP)
 *
 * GET /attachments/:id/content and /thumbnail are implemented in T5.
 * POST /attachments/:id/link and DELETE /attachments/:id are implemented in T6.
 *
 * Middleware (Spec §5.1):
 *   POST /attachments: requireAuth + requirePasswordChanged
 *
 * Owner rule (D3): ownerId always = authenticated uploader; any ownerId in the
 * form data is silently ignored.
 *
 * Error codes (Spec §4.8):
 *   400 VALIDATION_ERROR  — missing file field
 *   413 PAYLOAD_TOO_LARGE — single file exceeds ATTACHMENT_MAX_BYTES
 *   415 UNSUPPORTED_MEDIA_TYPE — magic bytes not JPEG/PNG/WebP
 *   401 UNAUTHORIZED       — not authenticated (from requireAuth)
 */

import multipart from "@fastify/multipart";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth, requirePasswordChanged } from "../auth/middleware.js";
import { parseEnv } from "../config/env.js";
import type { Storage } from "../storage/index.js";
import { getAttachmentContent, getAttachmentThumbnail } from "./access-service.js";
import { processUpload } from "./upload-service.js";

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

interface AttachmentPluginOptions {
  prisma: PrismaClient;
  storage: Storage;
}

// ---------------------------------------------------------------------------
// Default env (mirrors auth/routes.ts fallback pattern for test isolation)
// ---------------------------------------------------------------------------

function getEnvConfig() {
  try {
    return parseEnv(process.env);
  } catch {
    return {
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://localhost/test",
      NODE_ENV: (process.env.NODE_ENV as "development" | "production" | "test") ?? "development",
      PORT: 3000,
      LOG_LEVEL: "info" as const,
      STORAGE_PATH: "/data/storage",
      SESSION_ABSOLUTE_TTL_HOURS: 8,
      SESSION_COOKIE_NAME: "sid",
      LOGIN_MAX_FAILURES: 5,
      LOGIN_LOCK_MINUTES: 15,
      ATTACHMENT_STORAGE_ROOT: undefined,
      ATTACHMENT_MAX_BYTES: 10485760,
      ATTACHMENT_TEMP_TTL_HOURS: 24,
      ATTACHMENT_THUMBNAIL_MAX_PX: 512,
    };
  }
}

// ---------------------------------------------------------------------------
// Attachment plugin
// ---------------------------------------------------------------------------

export const attachmentPlugin: FastifyPluginAsync<AttachmentPluginOptions> = async (
  fastify: FastifyInstance,
  options: AttachmentPluginOptions
) => {
  const { prisma, storage } = options;

  // Load env config for attachment limits
  const env = getEnvConfig();
  const maxBytes = env.ATTACHMENT_MAX_BYTES;
  const thumbnailMaxPx = env.ATTACHMENT_THUMBNAIL_MAX_PX;

  // Register @fastify/multipart on this plugin scope
  // limits.fileSize is set generously above maxBytes so we can do our own
  // streaming abort at exactly maxBytes (Spec §4.3 — abort on exceeding limit).
  // We set a slightly higher hard limit so @fastify/multipart doesn't error first.
  await fastify.register(multipart, {
    limits: {
      fileSize: maxBytes + 1, // let our own code handle the exact limit check
      files: 1, // single file per upload (Spec §5.1)
    },
  });

  // -------------------------------------------------------------------------
  // POST /attachments
  // Stream upload; magic-byte detection; size abort; DB TEMP record.
  // -------------------------------------------------------------------------

  fastify.post(
    "/attachments",
    {
      preHandler: [requireAuth(prisma), requirePasswordChanged],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const uploaderId = request.currentUser.id;

      const result = await processUpload(request, prisma, storage, {
        uploaderId,
        maxBytes,
        thumbnailMaxPx,
      });

      return reply.status(201).send({ attachment: result });
    }
  );

  // -------------------------------------------------------------------------
  // GET /attachments/:id/content
  // Returns original file bytes for the attachment.
  // Spec §5.1 / Done-When T5:
  //   - requireAuth only (D8: no requirePasswordChanged)
  //   - Authorization: DB ownerId via assertOwnershipOrAdmin (D6: 403 FORBIDDEN)
  //   - 404 if id not found; 403 if non-owner non-admin; 401 if unauthenticated
  //   - Content-Disposition: inline (AC-06)
  //   - storageKey must NOT appear in error responses (§9.4)
  // -------------------------------------------------------------------------

  fastify.get(
    "/attachments/:id/content",
    {
      preHandler: [requireAuth(prisma)],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const currentUser = request.currentUser;

      const log = {
        error: (obj: Record<string, unknown>, msg: string) => request.log.error(obj, msg),
      };

      const { bytes, mimeType } = await getAttachmentContent(prisma, storage, id, currentUser, log);

      return reply
        .status(200)
        .header("Content-Type", mimeType)
        .header("Content-Disposition", "inline")
        .send(bytes);
    }
  );

  // -------------------------------------------------------------------------
  // GET /attachments/:id/thumbnail
  // Returns thumbnail bytes; falls back to original if thumbnailKey=null (D5).
  // Spec §5.1 / Done-When T5:
  //   Same auth rules as /content.
  // -------------------------------------------------------------------------

  fastify.get(
    "/attachments/:id/thumbnail",
    {
      preHandler: [requireAuth(prisma)],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const currentUser = request.currentUser;

      const log = {
        error: (obj: Record<string, unknown>, msg: string) => request.log.error(obj, msg),
      };

      const { bytes, mimeType } = await getAttachmentThumbnail(
        prisma,
        storage,
        id,
        currentUser,
        log
      );

      return reply
        .status(200)
        .header("Content-Type", mimeType)
        .header("Content-Disposition", "inline")
        .send(bytes);
    }
  );
};
