/**
 * Application routes — PHASE-004-T3
 *
 * Endpoints implemented in this Task (backend routes; nginx strips /api prefix):
 *   POST   /applications/travel      → 201 { application: TravelApplicationDto }
 *   GET    /applications/travel/:id  → 200 { application: TravelApplicationDto }
 *   PUT    /applications/travel/:id  → 200 { application: TravelApplicationDto }
 *   DELETE /applications/:id         → 200 { ok: true }
 *
 * Explicitly OUT of scope for this Task (see PHASE-004.md §2, Task Graph):
 *   POST /applications/travel/preview        (T6)
 *   POST /applications/:id/complete           (T8)
 *   GET  /applications                        (T9)
 *   POST /admin/users/:userId/applications/travel (T10)
 *
 * Auth (§6.1 授權矩陣): requireAuth + requirePasswordChanged on every route
 * here; ownership is authorized purely from the DB-loaded `ownerId`
 * (`assertOwnershipOrAdmin`), never from any request-supplied identifier
 * (§6.2 資料隔離不變式 1 — BE-US-02 第三條 AC).
 */

import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { assertOwnershipOrAdmin, requireAuth, requirePasswordChanged } from "../auth/middleware.js";
import { parseUtcDate } from "../parameters/parameter-service.js";
import type { FieldError } from "../platform/errors.js";
import { AppError } from "../platform/errors.js";
import { assertApplicationMutable } from "./application-state-machine.js";
import {
  createTravelDraft,
  deleteApplication,
  getApplicationForAuth,
  getTravelApplication,
  toTravelApplicationDto,
  updateTravelDraft,
} from "./travel-service.js";
import { parseKmField, parseLocationField } from "./trip-validation.js";

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

interface ApplicationsPluginOptions {
  prisma: PrismaClient;
}

// ---------------------------------------------------------------------------
// Field-level validation helpers (D14(ii): purpose ≤ 500 chars; strict
// YYYY-MM-DD + valid calendar day for tripDate, reusing parameter-service's
// parseUtcDate per Packet instruction — do NOT re-implement date parsing).
// ---------------------------------------------------------------------------

type FieldParseResult<T> = { ok: true; value: T } | { ok: false; error: FieldError };

/** tripDate: `null` = 清空; a valid YYYY-MM-DD string = 設定; anything else = 400. */
function parseTripDateField(value: unknown): FieldParseResult<Date | null> {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      error: { field: "tripDate", reason: "出差日期格式錯誤（必須為字串或 null）" },
    };
  }
  const parsed = parseUtcDate(value);
  if (!parsed) {
    return {
      ok: false,
      error: { field: "tripDate", reason: "出差日期必須為合法日期（格式：YYYY-MM-DD）" },
    };
  }
  return { ok: true, value: parsed };
}

const PURPOSE_MAX_LENGTH = 500; // D14(ii)：大總管代定，供人類事後調整

/** purpose: `null` = 清空; a string ≤500 chars = 設定; anything else = 400. */
function parsePurposeField(value: unknown): FieldParseResult<string | null> {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      error: { field: "purpose", reason: "出差目的格式錯誤（必須為字串或 null）" },
    };
  }
  if (value.length > PURPOSE_MAX_LENGTH) {
    return {
      ok: false,
      error: { field: "purpose", reason: `出差目的長度不可超過 ${PURPOSE_MAX_LENGTH} 字` },
    };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// PHASE-004-T5: segments[] 格式驗證（僅格式；diff/寫入留給 T4，見下方
// TODO(PHASE-004-T4)）。對每段的 totalKm/highwayKm/origin/destination 執行
// 格式驗證（AC-19、D14(ii)）；三態語意比照 tripDate/purpose：欄位缺席=不驗證，
// 存在（含 null）才驗證，維持與 SegmentInput 之 `?` 可選欄位一致的語意。
// ---------------------------------------------------------------------------

/** 驗證 PUT body 的 `segments[]` 格式；回傳所有欄位錯誤（非只回第一個）。 */
function validateSegmentsFormat(segmentsRaw: unknown): FieldError[] {
  const errors: FieldError[] = [];

  if (!Array.isArray(segmentsRaw)) {
    errors.push({ field: "segments", reason: "必須為陣列" });
    return errors;
  }

  segmentsRaw.forEach((rawSegment, index) => {
    if (rawSegment === null || typeof rawSegment !== "object" || Array.isArray(rawSegment)) {
      errors.push({ field: `segments[${index}]`, reason: "必須為物件" });
      return;
    }
    const seg = rawSegment as Record<string, unknown>;

    if (Object.prototype.hasOwnProperty.call(seg, "origin")) {
      const result = parseLocationField(seg.origin, `segments[${index}].origin`);
      if (!result.ok) errors.push(result.error);
    }
    if (Object.prototype.hasOwnProperty.call(seg, "destination")) {
      const result = parseLocationField(seg.destination, `segments[${index}].destination`);
      if (!result.ok) errors.push(result.error);
    }
    if (Object.prototype.hasOwnProperty.call(seg, "totalKm")) {
      const result = parseKmField(seg.totalKm, `segments[${index}].totalKm`);
      if (!result.ok) errors.push(result.error);
    }
    if (Object.prototype.hasOwnProperty.call(seg, "highwayKm")) {
      const result = parseKmField(seg.highwayKm, `segments[${index}].highwayKm`);
      if (!result.ok) errors.push(result.error);
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Applications plugin
// ---------------------------------------------------------------------------

export const applicationsPlugin: FastifyPluginAsync<ApplicationsPluginOptions> = async (
  fastify: FastifyInstance,
  options: ApplicationsPluginOptions
) => {
  const { prisma } = options;

  const authPreHandlers = [requireAuth(prisma), requirePasswordChanged];

  // -------------------------------------------------------------------------
  // POST /applications/travel (AC-01, AC-79a)
  // body { tripDate?, purpose? } — both entirely optional at creation.
  // owner is ALWAYS request.currentUser.id — any body.ownerId is silently
  // ignored (never read at all, below).
  // -------------------------------------------------------------------------

  fastify.post(
    "/applications/travel",
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
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

      // AC-79a: owner 恆為呼叫者，不接受 body ownerId（body.ownerId/createdById
      // 從未被讀取——不是「讀了再忽略」，是根本沒有存取該欄位的程式碼路徑）。
      const selfId = request.currentUser.id;

      const application = await createTravelDraft(prisma, {
        ownerId: selfId,
        createdById: selfId,
        tripDate,
        purpose,
      });

      const dto = await toTravelApplicationDto(prisma, application);
      return reply.status(201).send({ application: dto });
    }
  );

  // -------------------------------------------------------------------------
  // GET /applications/travel/:id (AC-04, AC-72/73/75/76/77)
  // -------------------------------------------------------------------------

  fastify.get(
    "/applications/travel/:id",
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const application = await getTravelApplication(prisma, id);
      if (!application) {
        throw new AppError("NOT_FOUND", 404, "找不到指定的申請");
      }

      // §6.2 資料隔離不變式 1: 授權一律以 DB 查得之 ownerId 為準。
      assertOwnershipOrAdmin(request.currentUser, application.ownerId);

      const dto = await toTravelApplicationDto(prisma, application);
      return reply.status(200).send({ application: dto });
    }
  );

  // -------------------------------------------------------------------------
  // PUT /applications/travel/:id (AC-02/03/04/06/21/35, D15 partial: 三態語意)
  // -------------------------------------------------------------------------

  fastify.put(
    "/applications/travel/:id",
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as Record<string, unknown>;

      const existing = await getTravelApplication(prisma, id);
      if (!existing) {
        throw new AppError("NOT_FOUND", 404, "找不到指定的申請");
      }

      assertOwnershipOrAdmin(request.currentUser, existing.ownerId);
      assertApplicationMutable(existing.status); // AC-06/56: 已完成 → 403 FORBIDDEN

      const fieldErrors: FieldError[] = [];
      const patch: { tripDate?: Date | null; purpose?: string | null } = {};

      // 三態語意：body 是否含有該 key 才決定要不要放進 patch（缺席=不變）。
      if (Object.prototype.hasOwnProperty.call(body, "tripDate")) {
        const result = parseTripDateField(body.tripDate);
        if (!result.ok) fieldErrors.push(result.error);
        else patch.tripDate = result.value;
      }
      if (Object.prototype.hasOwnProperty.call(body, "purpose")) {
        const result = parsePurposeField(body.purpose);
        if (!result.ok) fieldErrors.push(result.error);
        else patch.purpose = result.value;
      }

      // PHASE-004-T5: segments[] 格式驗證接點（里程小數位/容量、地點長度）。
      // 任一段格式不合格 → 併入 fieldErrors，與 tripDate/purpose 錯誤一起
      // 回傳（AC-52 精神：回報全部欄位錯誤，非只回第一項）。
      if (Object.prototype.hasOwnProperty.call(body, "segments")) {
        fieldErrors.push(...validateSegmentsFormat(body.segments));
      }

      if (fieldErrors.length > 0) {
        throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", fieldErrors);
      }

      // AC-35（PUT 部分）: 任何金額欄位（totalAmount/amount/fuelAmount 等）與
      // ownerId/createdById/status 一律忽略——本函式從未讀取這些 body 欄位，
      // 只讀取 tripDate/purpose，故天然滿足「忽略」語意。
      //
      // TODO(PHASE-004-T4): segments 的 diff／新增／刪除／排序／附件
      // link/detach 於此接入。本 Task（T5）僅完成上方的格式驗證（未通過即
      // 400，不會執行到這裡）；格式通過後 body.segments 目前仍完全被忽略
      // （不寫入、不影響既有段落），T4 屆時將 body.segments 傳入
      // travel-service 的新服務函式（例如 applySegmentDiff）。

      const updated = await updateTravelDraft(prisma, id, patch);
      const dto = await toTravelApplicationDto(prisma, updated);
      return reply.status(200).send({ application: dto });
    }
  );

  // -------------------------------------------------------------------------
  // DELETE /applications/:id (AC-05/06)
  // Generic across Application types (not travel-specific route path).
  // -------------------------------------------------------------------------

  fastify.delete(
    "/applications/:id",
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const application = await getApplicationForAuth(prisma, id);
      if (!application) {
        throw new AppError("NOT_FOUND", 404, "找不到指定的申請");
      }

      assertOwnershipOrAdmin(request.currentUser, application.ownerId);
      assertApplicationMutable(application.status); // AC-06: 已完成 → 403 FORBIDDEN

      await deleteApplication(prisma, id);
      return reply.status(200).send({ ok: true });
    }
  );
};
