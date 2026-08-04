/**
 * Attachment routes — PHASE-003-T3, revised PHASE-004-T11 (AR-D 閉環, D11/D12)
 *
 * Routes registered in this module:
 *   POST /attachments  — stream upload, magic-byte validation, size limit,
 *                        storage put, thumbnail, DB record (TEMP).
 *                        PHASE-004-T11 (D11/AC-29): accepts an optional
 *                        `?ownerId=` query param — only ADMIN may specify a
 *                        different owner; `uploaderId` is always the caller.
 *   GET /attachments/:id/content|thumbnail — unchanged from PHASE-003-T5.
 *   DELETE /attachments/:id — PHASE-004-T11 (AR-D/AC-27): `containerState` is
 *     now derived from DB (`deriveContainerState`) — no client-supplied query
 *     or body `containerState` is read anywhere in this handler.
 *
 * REMOVED in PHASE-004-T11 (D12, AR-D 閉環 — 最高優先):
 *   POST /attachments/:id/link — the public link endpoint allowed a client to
 *   self-supply `limit` (bypass the 3/segment cap), `refId` (link to any
 *   container), and `containerState` (claim 'draft' to bypass completion
 *   lock) — a real authorization bypass once PHASE-004 has real completed
 *   assets. Requests to this path now 404 (no route registered). Attachment
 *   linking is now exclusively driven by `PUT /applications/travel/:id`'s
 *   `attachmentIds[]` (travel-service.ts), which calls the SERVICE layer
 *   (`linkAttachmentTx`) directly — never this HTTP surface. The service
 *   function `linkAttachment`/`linkAttachmentTx` remains exported from
 *   lifecycle-service.ts for that internal use.
 *
 * Middleware (Spec §5.1/§6.1):
 *   POST /attachments: requireAuth + requirePasswordChanged
 *   DELETE /attachments/:id: requireAuth + requirePasswordChanged
 *
 * Owner rule (D3, extended D11): ownerId defaults to the authenticated
 * uploader; ADMIN may override via `?ownerId=` to upload on behalf of another
 * (active) user. `uploaderId` is ALWAYS the authenticated caller, never
 * client-supplied.
 *
 * Error codes (Spec §4.8, §8.5):
 *   400 VALIDATION_ERROR  — missing file field; ownerId points to an inactive user
 *   403 FORBIDDEN         — non-ADMIN specifies a different ownerId
 *   404 NOT_FOUND         — ownerId points to a non-existent user
 *   413 PAYLOAD_TOO_LARGE — single file exceeds ATTACHMENT_MAX_BYTES
 *   415 UNSUPPORTED_MEDIA_TYPE — magic bytes not JPEG/PNG/WebP
 *   401 UNAUTHORIZED       — not authenticated (from requireAuth)
 */

import multipart from "@fastify/multipart";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth, requirePasswordChanged } from "../auth/middleware.js";
import { getEnvOrTestDefaults } from "../config/env.js";
import { AppError } from "../platform/errors.js";
import type { Storage } from "../storage/index.js";
import { getAttachmentContent, getAttachmentThumbnail } from "./access-service.js";
import { deleteAttachment } from "./lifecycle-service.js";
import { processUpload } from "./upload-service.js";

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

interface AttachmentPluginOptions {
  prisma: PrismaClient;
  storage: Storage;
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
  const env = getEnvOrTestDefaults(process.env);
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
  //
  // PHASE-004-T11 (D11/AC-29): optional `?ownerId=` query param.
  //   - omitted, or equal to the caller's own id → ownerId = uploaderId = caller
  //     (unchanged PHASE-003 default behavior).
  //   - a DIFFERENT id, non-ADMIN caller        → 403 FORBIDDEN.
  //   - a DIFFERENT id, ADMIN caller             → allowed; ownerId = that user,
  //     uploaderId = the admin (on-behalf upload; §9「管理員代建立」step 5).
  //     Target user must exist (404 NOT_FOUND if not) and be active
  //     (400 VALIDATION_ERROR if isActive=false) — 404-vs-400 split mirrors the
  //     established precedent in admin/routes.ts (user-not-found → 404) and
  //     PHASE-004 §8.2's sibling admin-create-draft endpoint (disabled user →
  //     400, nonexistent user → 404).
  //
  // Transport choice: `ownerId` is read from the QUERY STRING, not an
  // additional multipart form field. This endpoint's body is a raw file
  // stream consumed by `processUpload`/`@fastify/multipart`'s `request.file()`
  // — adding a second multipart field would require `attachFieldsToBody` and
  // strict field-ordering guarantees that are unrelated to this Task's actual
  // requirement (an optional owner override). The query string carries this
  // one piece of metadata unambiguously without touching the upload pipeline.
  // -------------------------------------------------------------------------

  fastify.post(
    "/attachments",
    {
      preHandler: [requireAuth(prisma), requirePasswordChanged],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.currentUser;
      const uploaderId = actor.id;

      const query = request.query as Record<string, string | undefined>;
      const requestedOwnerId = query.ownerId;

      let ownerId = uploaderId;
      if (
        requestedOwnerId !== undefined &&
        requestedOwnerId !== "" &&
        requestedOwnerId !== uploaderId
      ) {
        if (actor.role !== "ADMIN") {
          throw new AppError("FORBIDDEN", 403, "無權為他人上傳附件");
        }
        // T10R-LITE（SF-2 殘留缺陷）：重複 query 鍵（`?ownerId=A&ownerId=B`）在
        // Fastify 執行期型別為 `string[]`，非本端點原本假設的
        // `string | undefined`——沿用 mileage/routes.ts
        // `assertScalarQueryParams`／application-query.ts `resolveOwnerId` 之
        // 既有收斂慣例：非字串一律 400 VALIDATION_ERROR，避免陣列值流入下方
        // `prisma.user.findUnique` 觸發 PrismaClientValidationError → 未預期
        // 500。刻意置於 ADMIN 角色判定「之後」——非 ADMIN 呼叫者帶重複
        // ownerId 沿用既有 fail-closed 行為（403 FORBIDDEN，見上方判定），不
        // 因本次型別收斂而變成 400，兩者判定順序互不影響。
        if (typeof requestedOwnerId !== "string") {
          throw new AppError("VALIDATION_ERROR", 400, "查詢參數有誤，請檢查標示欄位。", [
            { field: "ownerId", reason: "僅接受單一字串值，不得重複帶入此參數" },
          ]);
        }
        const targetUser = await prisma.user.findUnique({ where: { id: requestedOwnerId } });
        if (!targetUser) {
          throw new AppError("NOT_FOUND", 404, "指定的擁有人不存在");
        }
        if (!targetUser.isActive) {
          throw new AppError("VALIDATION_ERROR", 400, "指定的擁有人已停用，無法代其上傳附件", [
            { field: "ownerId", reason: "指定的擁有人已停用" },
          ]);
        }
        ownerId = requestedOwnerId;
      }

      const result = await processUpload(request, prisma, storage, {
        uploaderId,
        ownerId,
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

  // -------------------------------------------------------------------------
  // POST /attachments/:id/link — REMOVED (PHASE-004-T11, D12, AR-D 閉環).
  // No route is registered for this path; requests now receive Fastify's
  // default 404 (route not found). See file header comment for rationale.
  // The service-layer functions (`linkAttachment`/`linkAttachmentTx` in
  // lifecycle-service.ts) remain available for internal callers
  // (travel-service.ts's `updateTravelDraft`).
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // DELETE /attachments/:id
  // Delete or detach an attachment.
  //
  // Spec §5.1 / PHASE-003-T6, revised PHASE-004-T11 (AR-D/AC-26/27),
  // revised PHASE-004-R4 (S-1 — 推導與寫入現在同一交易):
  //   - requireAuth + requirePasswordChanged
  //   - LINKED → detach (status → TEMP, ref cleared, createdAt reset as TTL base)
  //   - TEMP → physical delete (DB record + storage files)
  //   - containerState is DERIVED FROM DB, INSIDE `deleteAttachment`'s own
  //     transaction (lifecycle-service.ts) — this handler does NOT read any
  //     client-supplied `containerState`, from either the query string or the
  //     request body, anywhere (AC-27b). Any such client value is completely
  //     inert — this is the AR-D closure. 'completed' (derived) → 403
  //     FORBIDDEN (AC-26). PHASE-004-R4 (S-1): this handler no longer does
  //     its OWN separate `findUnique`/`deriveContainerState` call before
  //     invoking `deleteAttachment` — that pre-R4 two-step (derive here,
  //     write inside `deleteAttachment`) left a TOCTOU window where a
  //     concurrent `completeTravelApplication` could commit in between. Both
  //     steps now happen inside `deleteAttachment`'s own single transaction
  //     (see that function's doc comment).
  //   - 200 { ok: true } on success
  //   - 403 FORBIDDEN if non-owner, non-admin, or (derived) completed container
  //   - 404 NOT_FOUND if attachment does not exist
  // -------------------------------------------------------------------------

  fastify.delete(
    "/attachments/:id",
    {
      preHandler: [requireAuth(prisma), requirePasswordChanged],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const actor = request.currentUser;

      const log = { warn: (msg: string) => request.log.warn(msg) };
      const result = await deleteAttachment(prisma, storage, { attachmentId: id, actor }, log);

      return reply.status(200).send(result);
    }
  );
};
