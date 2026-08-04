/**
 * Admin user management routes — PHASE-002-T9/T10.
 *
 * All routes require: requireAuth + requirePasswordChanged + requireAdmin
 * (Spec §5.2 / AC-24).
 *
 * Endpoints:
 *   GET  /admin/users                         → 200 { users: UserDto[] }
 *   POST /admin/users                         → 201 { user: UserDto }
 *   POST /admin/users/:id/deactivate          → 200 { user: UserDto }
 *   POST /admin/users/:id/activate            → 200 { user: UserDto }
 *   POST /admin/users/:id/reset-password      → 200 { user: UserDto }
 *   DELETE /admin/users/:id                   → 200 { ok: true }
 *
 * Audit events (T10, Spec §7):
 *   USER_CREATED / USER_DEACTIVATED / USER_ACTIVATED /
 *   USER_PASSWORD_RESET / USER_DELETED
 *   Passwords NEVER appear in audit (AC-27).
 *
 * Self-operation guard (Spec §5.2 / D8):
 *   deactivate / delete on own id → 409 CONFLICT
 *
 * Concurrent loginName collision (Spec §4.5.4):
 *   DB unique-key constraint error → 409 CONFLICT (not 500)
 *
 * On-behalf application creation (PHASE-004-T10, AC-78/79/85, Spec §8.2):
 *   POST /admin/users/:userId/applications/travel → 201 { application: TravelApplicationDto }
 *   body shape is identical to `POST /applications/travel` (§8.2 表格：
 *   「同 `POST /applications/travel`」) — `tripDate?`/`purpose?`, both optional,
 *   parsed via the SAME exported field parsers `applications/routes.ts` uses
 *   for its own `POST /applications/travel` (not re-implemented here).
 *   `ownerId` = `:userId` (the selected user), `createdById` = the calling
 *   admin — these are DELIBERATELY different columns (§6.2/C2 of the Packet):
 *   `ownerId` is who the resource belongs to going forward (that user views/
 *   completes/reports on it later); `createdById` is pure audit provenance of
 *   who made the write. `:userId` must exist (404 NOT_FOUND if not) and be
 *   active (400 VALIDATION_ERROR if `isActive=false`) — this exact 404-vs-400
 *   split already established by PHASE-004-T11's `POST /attachments?ownerId=`
 *   on-behalf-upload endpoint (`attachment/routes.ts`), reused here verbatim
 *   for consistency across the two "admin on-behalf" endpoints in this Phase.
 */

import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type {
  CreateMaintenanceDraftInput,
  OnMaintenanceDraftCreated,
} from "../applications/maintenance-service.js";
import {
  buildMaintenanceApplicationDto,
  createMaintenanceDraft,
} from "../applications/maintenance-service.js";
import {
  parseMaintenanceFieldsInput,
  parsePurposeField,
  parseTripDateField,
} from "../applications/routes.js";
import type { OnTravelDraftCreated } from "../applications/travel-service.js";
import { createTravelDraft, toTravelApplicationDto } from "../applications/travel-service.js";
import { writeAudit } from "../audit/audit.js";
import { requireAdmin, requireAuth, requirePasswordChanged } from "../auth/middleware.js";
import { validateNewPassword } from "../auth/password-rules.js";
import { hashPassword } from "../auth/password.js";
import { revokeAllUserSessions, toUserDto } from "../auth/session.js";
import { formatUtcDate } from "../parameters/parameter-service.js";
import type { FieldError } from "../platform/errors.js";
import { AppError } from "../platform/errors.js";
import { makeUserHasHistory } from "../users/history.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect Prisma unique-constraint violation (P2002) */
function isPrismaUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "P2002"
  );
}

/** Detect Prisma record-not-found error (P2025) */
function isPrismaNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "P2025"
  );
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const createUserBodySchema = {
  type: "object",
  required: ["loginName", "displayName", "temporaryPassword"],
  properties: {
    loginName: { type: "string", minLength: 1 },
    displayName: { type: "string", minLength: 1 },
    employeeNumber: { type: "string" },
    temporaryPassword: { type: "string" },
  },
  additionalProperties: false,
} as const;

const resetPasswordBodySchema = {
  type: "object",
  required: ["temporaryPassword"],
  properties: {
    temporaryPassword: { type: "string" },
  },
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Admin plugin
// ---------------------------------------------------------------------------

interface AdminPluginOptions {
  prisma: PrismaClient;
  /**
   * Overridable userHasHistory checker — used in tests to stub "has history=true".
   * If omitted, uses the production checker (always false in PHASE-002).
   */
  hasHistory?: (prisma: PrismaClient, userId: string) => Promise<boolean>;
}

export const adminPlugin: FastifyPluginAsync<AdminPluginOptions> = async (
  fastify: FastifyInstance,
  options: AdminPluginOptions
) => {
  const { prisma } = options;

  // Use injected checker or fall back to production default
  const userHasHistory = options.hasHistory ?? makeUserHasHistory();

  // All admin routes share the same preHandler chain per Spec §5.2
  const adminPreHandlers = [requireAuth(prisma), requirePasswordChanged, requireAdmin];

  // -------------------------------------------------------------------------
  // GET /admin/users — list all users (AC-17)
  // -------------------------------------------------------------------------

  fastify.get(
    "/admin/users",
    { preHandler: adminPreHandlers },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const users = await prisma.user.findMany({
        orderBy: { createdAt: "asc" },
      });

      return reply.status(200).send({
        users: users.map(toUserDto),
      });
    }
  );

  // -------------------------------------------------------------------------
  // POST /admin/users — create a user (AC-18/19, Spec §5.2)
  // -------------------------------------------------------------------------

  fastify.post(
    "/admin/users",
    {
      preHandler: adminPreHandlers,
      schema: { body: createUserBodySchema },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { loginName, displayName, employeeNumber, temporaryPassword } = request.body as {
        loginName: string;
        displayName: string;
        employeeNumber?: string;
        temporaryPassword: string;
      };

      // Validate temporaryPassword against rules (Spec §5.2 / AC-18)
      const validation = validateNewPassword(temporaryPassword);
      if (!validation.valid) {
        throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
          ...(validation.fields ?? []).map((f) => ({
            field: f.field === "newPassword" ? "temporaryPassword" : f.field,
            reason: f.reason,
          })),
        ]);
      }

      const passwordHash = await hashPassword(temporaryPassword);

      let user: Awaited<ReturnType<typeof prisma.user.create>>;
      try {
        user = await prisma.user.create({
          data: {
            loginName,
            displayName,
            employeeNumber: employeeNumber ?? null,
            passwordHash,
            role: "USER",
            isActive: true,
            mustChangePassword: true,
          },
        });
      } catch (err) {
        // Capture DB unique-key conflict (concurrent create, Spec §4.5.4)
        if (isPrismaUniqueConstraintError(err)) {
          throw new AppError("CONFLICT", 409, "此登入帳號已被使用。");
        }
        throw err;
      }

      // Write audit — USER_CREATED (T10, Spec §7)
      await writeAudit({
        prisma,
        actorId: request.currentUser.id,
        action: "USER_CREATED",
        targetId: user.id,
        targetLabel: user.loginName,
        detail: {
          role: user.role,
          ...(user.employeeNumber !== null ? { employeeNumber: user.employeeNumber } : {}),
        },
      });

      return reply.status(201).send({ user: toUserDto(user) });
    }
  );

  // -------------------------------------------------------------------------
  // POST /admin/users/:id/deactivate — deactivate a user (AC-20)
  // -------------------------------------------------------------------------

  fastify.post(
    "/admin/users/:id/deactivate",
    { preHandler: adminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const actorId = request.currentUser.id;

      // Self-operation guard (Spec §5.2 / D8)
      if (id === actorId) {
        throw new AppError("CONFLICT", 409, "不可對自己執行此操作");
      }

      // Verify target exists
      const existing = await prisma.user.findUnique({ where: { id } });
      if (!existing) {
        throw new AppError("NOT_FOUND", 404, "使用者不存在");
      }

      // Deactivate and revoke all sessions (AC-20)
      const user = await prisma.user.update({
        where: { id },
        data: { isActive: false },
      });

      await revokeAllUserSessions(prisma, id);

      // Write audit — USER_DEACTIVATED (T10, Spec §7)
      await writeAudit({
        prisma,
        actorId,
        action: "USER_DEACTIVATED",
        targetId: user.id,
        targetLabel: user.loginName,
        detail: { isActive: { from: true, to: false } },
      });

      return reply.status(200).send({ user: toUserDto(user) });
    }
  );

  // -------------------------------------------------------------------------
  // POST /admin/users/:id/activate — activate a user (AC-21)
  // -------------------------------------------------------------------------

  fastify.post(
    "/admin/users/:id/activate",
    { preHandler: adminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const actorId = request.currentUser.id;

      // Verify target exists
      const existing = await prisma.user.findUnique({ where: { id } });
      if (!existing) {
        throw new AppError("NOT_FOUND", 404, "使用者不存在");
      }

      const user = await prisma.user.update({
        where: { id },
        data: { isActive: true },
      });

      // Write audit — USER_ACTIVATED (T10, Spec §7)
      await writeAudit({
        prisma,
        actorId,
        action: "USER_ACTIVATED",
        targetId: user.id,
        targetLabel: user.loginName,
        detail: { isActive: { from: false, to: true } },
      });

      return reply.status(200).send({ user: toUserDto(user) });
    }
  );

  // -------------------------------------------------------------------------
  // POST /admin/users/:id/reset-password — reset password (AC-22)
  // -------------------------------------------------------------------------

  fastify.post(
    "/admin/users/:id/reset-password",
    {
      preHandler: adminPreHandlers,
      schema: { body: resetPasswordBodySchema },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { temporaryPassword } = request.body as { temporaryPassword: string };
      const actorId = request.currentUser.id;

      // Validate temporaryPassword (Spec §5.2 / AC-22)
      const validation = validateNewPassword(temporaryPassword);
      if (!validation.valid) {
        throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
          ...(validation.fields ?? []).map((f) => ({
            field: f.field === "newPassword" ? "temporaryPassword" : f.field,
            reason: f.reason,
          })),
        ]);
      }

      // Verify target exists
      const existing = await prisma.user.findUnique({ where: { id } });
      if (!existing) {
        throw new AppError("NOT_FOUND", 404, "使用者不存在");
      }

      const passwordHash = await hashPassword(temporaryPassword);

      const user = await prisma.user.update({
        where: { id },
        data: {
          passwordHash,
          mustChangePassword: true,
        },
      });

      // Revoke all existing sessions (AC-22)
      await revokeAllUserSessions(prisma, id);

      // Write audit — USER_PASSWORD_RESET (T10, Spec §7)
      // detail must NOT contain the password or hash (AC-27)
      await writeAudit({
        prisma,
        actorId,
        action: "USER_PASSWORD_RESET",
        targetId: user.id,
        targetLabel: user.loginName,
        detail: { mustChangePassword: true },
      });

      return reply.status(200).send({ user: toUserDto(user) });
    }
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/users/:id — conditional delete (AC-23)
  // -------------------------------------------------------------------------

  fastify.delete(
    "/admin/users/:id",
    { preHandler: adminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const actorId = request.currentUser.id;

      // Self-operation guard (Spec §5.2 / D8)
      if (id === actorId) {
        throw new AppError("CONFLICT", 409, "不可對自己執行此操作");
      }

      // Verify target exists
      const existing = await prisma.user.findUnique({ where: { id } });
      if (!existing) {
        throw new AppError("NOT_FOUND", 404, "使用者不存在");
      }

      // Check history (AC-23 / Spec §4.6)
      const hasHistory = await userHasHistory(prisma, id);
      if (hasHistory) {
        throw new AppError("CONFLICT", 409, "此帳號已有資料，無法刪除，請改用停用");
      }

      // Snapshot loginName and displayName before deletion (for audit targetLabel)
      const snapshotLoginName = existing.loginName;
      const snapshotDisplayName = existing.displayName;

      // Hard delete — Session cascade handled by DB (Spec §3.3 onDelete: Cascade)
      try {
        await prisma.user.delete({ where: { id } });
      } catch (err) {
        if (isPrismaNotFoundError(err)) {
          // Concurrent delete race — treat as not found
          throw new AppError("NOT_FOUND", 404, "使用者不存在");
        }
        throw err;
      }

      // Write audit — USER_DELETED (T10, Spec §7)
      // targetId = null (user no longer exists); targetLabel = snapshot
      await writeAudit({
        prisma,
        actorId,
        action: "USER_DELETED",
        targetId: null,
        targetLabel: snapshotLoginName,
        detail: { deletedLoginName: snapshotLoginName, deletedDisplayName: snapshotDisplayName },
      });

      return reply.status(200).send({ ok: true });
    }
  );

  // -------------------------------------------------------------------------
  // POST /admin/users/:userId/applications/travel — 管理員代建立差旅草稿
  // (PHASE-004-T10, AC-78/79/85, Spec §8.2)
  // -------------------------------------------------------------------------

  fastify.post(
    "/admin/users/:userId/applications/travel",
    { preHandler: adminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = request.params as { userId: string };
      const actorId = request.currentUser.id;

      // AC-79(c): target user must exist and be active — checked BEFORE any
      // write, so neither branch creates any data. 404-vs-400 split mirrors
      // the established precedent in attachment/routes.ts's on-behalf upload
      // endpoint (T11) — see this file's header comment for the full rationale.
      const targetUser = await prisma.user.findUnique({ where: { id: userId } });
      if (!targetUser) {
        throw new AppError("NOT_FOUND", 404, "指定的使用者不存在");
      }
      if (!targetUser.isActive) {
        throw new AppError("VALIDATION_ERROR", 400, "指定的使用者已停用，無法代其建立申請", [
          { field: "userId", reason: "指定的使用者已停用" },
        ]);
      }

      // Body shape identical to POST /applications/travel (§8.2 表格：「同
      // POST /applications/travel」) — reuse the exact same field parsers
      // (applications/routes.ts), not re-implemented here.
      const body = (request.body ?? {}) as Record<string, unknown>;
      const fieldErrors: FieldError[] = [];

      let tripDate: Date | null = null;
      if (Object.prototype.hasOwnProperty.call(body, "tripDate") && body.tripDate !== undefined) {
        const result = parseTripDateField(body.tripDate);
        if (!result.ok) fieldErrors.push(result.error);
        else tripDate = result.value;
      }

      let purpose: string | null = null;
      if (Object.prototype.hasOwnProperty.call(body, "purpose") && body.purpose !== undefined) {
        const result = parsePurposeField(body.purpose);
        if (!result.ok) fieldErrors.push(result.error);
        else purpose = result.value;
      }

      if (fieldErrors.length > 0) {
        throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", fieldErrors);
      }

      // AC-78: owner/creator 分離——ownerId=:userId（被代理使用者），
      // createdById=管理員（操作者）。兩者刻意不同（Packet C2）。
      //
      // PHASE-004-T12（AC-82/83/86，C3）: `createTravelDraft` 現已提供交易內
      // `onCreated` 回呼（比照 parameters/parameter-service.ts 既有的
      // `onCreated` 模式），「建立申請」與「寫入 AuditLog
      // （action=APPLICATION_CREATED_ON_BEHALF）」同一交易原子化（AC-83）。
      // C3 邊界：即使呼叫這個代操作端點，若 `:userId` 恰好等於管理員自己的
      // id（對自己代建立），仍算「自己操作」而非代操作——只有
      // `userId !== actorId` 才建構 hook；否則完全不傳，天然滿足 AC-86。
      const isOnBehalf = userId !== actorId;
      const onCreated: OnTravelDraftCreated | undefined = isOnBehalf
        ? async (tx, created) => {
            await tx.auditLog.create({
              data: {
                action: "APPLICATION_CREATED_ON_BEHALF",
                actorId,
                targetId: userId,
                targetLabel: `${targetUser.loginName}#${created.id}`,
                summary: {
                  applicationId: created.id,
                  type: "TRAVEL",
                  tripDate: created.travel?.tripDate
                    ? formatUtcDate(created.travel.tripDate)
                    : null,
                  purpose: created.travel?.purpose ?? null,
                },
              },
            });
          }
        : undefined;

      const application = await createTravelDraft(
        prisma,
        {
          ownerId: userId,
          createdById: actorId,
          tripDate,
          purpose,
        },
        onCreated
      );

      const dto = await toTravelApplicationDto(prisma, application);
      return reply.status(201).send({ application: dto });
    }
  );

  // -------------------------------------------------------------------------
  // POST /admin/users/:userId/applications/maintenance — 管理員代建立保養草稿
  // (PHASE-006-T9, AC-30/31, Spec §2 群組 K)
  //
  // Body shape identical to POST /applications/maintenance（同一組五欄位選填
  // 語意）——reuse the exact same parser (`parseMaintenanceFieldsInput`,
  // exported from applications/routes.ts for this purpose, T9). `ownerId` =
  // `:userId`（被代理使用者），`createdById` = 呼叫端管理員——兩者刻意分離
  // （AC-30 同 PHASE-004-T10 之 C2 原則）。
  //
  // `:userId` must exist（404 NOT_FOUND if not，AC-30 明文「不得建立任何
  // 列」）；`isActive=false` → 400 VALIDATION_ERROR，比照 PHASE-004-T10 差旅
  // 代操作端點既有文案（人類裁定，Spec §18 SF-4，AC-30 增補）。
  //
  // AC-30/83 同型原子性：`createMaintenanceDraft` 的 `onCreated` hook 於
  // `userId !== actorId`（C3：管理員代自己＝自己操作，非代操作）時才建構，
  // 與 `onBehalfCreate`（差旅）同一分野判定。
  // -------------------------------------------------------------------------

  fastify.post(
    "/admin/users/:userId/applications/maintenance",
    { preHandler: adminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = request.params as { userId: string };
      const actorId = request.currentUser.id;

      // AC-30: :userId 不存在 → 404，不得建立任何列（判定於任何欄位解析之前）。
      const targetUser = await prisma.user.findUnique({ where: { id: userId } });
      if (!targetUser) {
        throw new AppError("NOT_FOUND", 404, "指定的使用者不存在");
      }
      if (!targetUser.isActive) {
        throw new AppError("VALIDATION_ERROR", 400, "指定的使用者已停用，無法代其建立申請", [
          { field: "userId", reason: "指定的使用者已停用" },
        ]);
      }

      const body = (request.body ?? {}) as Record<string, unknown>;
      const { errors: fieldErrors, fields } = parseMaintenanceFieldsInput(body);
      if (fieldErrors.length > 0) {
        throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", fieldErrors);
      }

      const isOnBehalf = userId !== actorId;
      const onCreated: OnMaintenanceDraftCreated | undefined = isOnBehalf
        ? async (tx, created) => {
            const maintenance = created.maintenance;
            await tx.auditLog.create({
              data: {
                action: "APPLICATION_CREATED_ON_BEHALF",
                actorId,
                targetId: userId,
                targetLabel: `${targetUser.loginName}#${created.id}`,
                summary: {
                  applicationId: created.id,
                  type: "MAINTENANCE",
                  lastMaintenanceDate: maintenance?.lastMaintenanceDate
                    ? formatUtcDate(maintenance.lastMaintenanceDate)
                    : null,
                  currentMaintenanceDate: maintenance?.currentMaintenanceDate
                    ? formatUtcDate(maintenance.currentMaintenanceDate)
                    : null,
                  lastOdometerKm: maintenance?.lastOdometerKm
                    ? maintenance.lastOdometerKm.toFixed(2)
                    : null,
                  currentOdometerKm: maintenance?.currentOdometerKm
                    ? maintenance.currentOdometerKm.toFixed(2)
                    : null,
                  actualCost: maintenance?.actualCost ? maintenance.actualCost.toFixed(2) : null,
                },
              },
            });
          }
        : undefined;

      const createInput: CreateMaintenanceDraftInput = {
        ownerId: userId,
        createdById: actorId,
        ...fields,
      };

      const application = await createMaintenanceDraft(prisma, createInput, onCreated);
      const dto = await buildMaintenanceApplicationDto(prisma, application);
      return reply.status(201).send({ application: dto });
    }
  );
};
