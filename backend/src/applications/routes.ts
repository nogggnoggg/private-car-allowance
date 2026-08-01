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
import type { SegmentPatch } from "./travel-service.js";
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
// PHASE-004-T4/T5: segments[] 格式驗證 + 解析。
//
// T5 只驗證格式（丟棄解析結果）；T4 擴充為「驗證且回傳已解析的值」，供
// updateTravelDraft 的整份 PUT diff（D15）使用 —— 解析邏輯本身完全不變
// （仍是 T5 的 parseKmField/parseLocationField，未重寫），只是現在把
// parseXxxField 回傳的 `.value` 保留下來，不再只看 `.ok`。
//
// 三態語意（比照 tripDate/purpose，§8.2 「PUT 語意（D15）」延伸至各段欄位）：
// 欄位缺席於物件上 = 不解析、也不寫入回傳物件的對應 key（travel-service.ts
// 據此判斷「不變」）；欄位存在（含 null）= 解析並寫入 key。
// `attachmentIds` 完全不在此處理——T11 範圍（Packet 明文）。
// ---------------------------------------------------------------------------

interface ParsedSegmentsResult {
  errors: FieldError[];
  segments: SegmentPatch[];
}

/** 解析並驗證 PUT body 的 `segments[]`；回傳所有欄位錯誤（非只回第一個）+ 已解析的段落陣列。 */
function parseSegmentsInput(segmentsRaw: unknown): ParsedSegmentsResult {
  const errors: FieldError[] = [];

  if (!Array.isArray(segmentsRaw)) {
    errors.push({ field: "segments", reason: "必須為陣列" });
    return { errors, segments: [] };
  }

  const segments: SegmentPatch[] = segmentsRaw.map((rawSegment, index) => {
    if (rawSegment === null || typeof rawSegment !== "object" || Array.isArray(rawSegment)) {
      errors.push({ field: `segments[${index}]`, reason: "必須為物件" });
      return {};
    }
    const seg = rawSegment as Record<string, unknown>;
    const parsed: SegmentPatch = {};

    if (Object.prototype.hasOwnProperty.call(seg, "id")) {
      if (typeof seg.id !== "string" || seg.id.length === 0) {
        errors.push({ field: `segments[${index}].id`, reason: "必須為非空字串" });
      } else {
        parsed.id = seg.id;
      }
    }
    if (Object.prototype.hasOwnProperty.call(seg, "origin")) {
      const result = parseLocationField(seg.origin, `segments[${index}].origin`);
      if (!result.ok) errors.push(result.error);
      else parsed.origin = result.value;
    }
    if (Object.prototype.hasOwnProperty.call(seg, "destination")) {
      const result = parseLocationField(seg.destination, `segments[${index}].destination`);
      if (!result.ok) errors.push(result.error);
      else parsed.destination = result.value;
    }
    if (Object.prototype.hasOwnProperty.call(seg, "totalKm")) {
      const result = parseKmField(seg.totalKm, `segments[${index}].totalKm`);
      if (!result.ok) errors.push(result.error);
      else parsed.totalKm = result.value;
    }
    if (Object.prototype.hasOwnProperty.call(seg, "highwayKm")) {
      const result = parseKmField(seg.highwayKm, `segments[${index}].highwayKm`);
      if (!result.ok) errors.push(result.error);
      else parsed.highwayKm = result.value;
    }

    return parsed;
  });

  return { errors, segments };
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

      // PHASE-004-T4/T5: segments[] 格式驗證 + 解析（里程小數位/容量、地點
      // 長度、id 型別）。任一段格式不合格 → 併入 fieldErrors，與
      // tripDate/purpose 錯誤一起回傳（AC-52 精神：回報全部欄位錯誤，非只回
      // 第一項）。`segments` 欄位缺席 = array-level 三態「不變」，`parsedSegments`
      // 維持 `undefined`（updateTravelDraft 的既有三態語意，T3 起即如此）。
      let parsedSegments: SegmentPatch[] | undefined;
      if (Object.prototype.hasOwnProperty.call(body, "segments")) {
        const result = parseSegmentsInput(body.segments);
        fieldErrors.push(...result.errors);
        parsedSegments = result.segments;
      }

      if (fieldErrors.length > 0) {
        throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", fieldErrors);
      }

      // AC-35（PUT 部分）: 任何金額欄位（totalAmount/amount/fuelAmount 等）與
      // ownerId/createdById/status 一律忽略——本函式從未讀取這些 body 欄位，
      // 只讀取 tripDate/purpose/segments，故天然滿足「忽略」語意。
      //
      // segments 的整份 diff（新增/更新/刪除/排序重寫）+ 刪段連帶 detach
      // （D15/D16）皆於 updateTravelDraft 內單一交易完成（PHASE-004-T4）。
      // 「不屬於此申請的 segment id」→ computeSegmentDiff 拋出
      // AppError("FORBIDDEN", 403, ...)，交易 rollback，此處不特別 catch，
      // 讓錯誤原樣傳給全域 error-handler（與 §6.2 資料隔離不變式 4「他人
      // 資源一律 403，不因資源存在與否洩漏」一致 —— 見 segment-diff.ts 文件
      // 註解的完整理由）。附件關聯（attachmentIds → link，3/段上限）為
      // T11 範圍，本 Task 完全不處理。
      const updated = await updateTravelDraft(prisma, id, patch, parsedSegments);
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
