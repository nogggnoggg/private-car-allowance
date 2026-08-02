/**
 * Application routes — PHASE-004-T3
 *
 * Endpoints implemented in this Task (backend routes; nginx strips /api prefix):
 *   POST   /applications/travel      → 201 { application: TravelApplicationDto }
 *   GET    /applications/travel/:id  → 200 { application: TravelApplicationDto }
 *   PUT    /applications/travel/:id  → 200 { application: TravelApplicationDto }
 *   DELETE /applications/:id         → 200 { ok: true }
 *
 * Endpoints implemented in PHASE-004-T7 (this Task's own addition):
 *   POST   /applications/travel/preview → 200 { preview: TravelComputedDto }
 *     stateless（AC-36：絕對不寫任何 DB 資料列，only reads via
 *     resolveTravelParameters's findMany）; §8.2, §9「金額預覽（stateless）」.
 *
 * Endpoints implemented in PHASE-004-T8 (this Task's own addition):
 *   POST   /applications/:id/complete → 200 { application: TravelApplicationDto }
 *     （`status=COMPLETED` + `snapshot`）; body 一律忽略（AC-54，本路由完全
 *     不讀取 request.body）; AC-49~54/43/48/59, §9「完成申請」.
 *     授權**不**使用本檔其餘端點共用的 `assertOwnershipOrAdmin`：D17（Spec
 *     §17.1 定案，Packet Out of Scope 明文）「本 Phase 不提供管理員代完成，
 *     完成僅能由使用者本人執行」——`assertOwnershipOrAdmin` 會放行 ADMIN，
 *     用在這裡即等同開放代完成，牴觸 D17；故此路由改為嚴格
 *     `actor.id === application.ownerId`（見下方路由本體的行內註解）。
 *
 * Endpoints implemented in PHASE-004-T9 (this Task's own addition):
 *   GET /applications → 200 ApplicationListResponse
 *     個人綜合紀錄查詢：日期／類型／狀態／關鍵字篩選、分頁、排序、授權隔離。
 *     授權判定（AC-74/84）與 query 格式驗證（AC-60~66）皆委派給
 *     `./application-query.js` 的純函式（`resolveOwnerId`/
 *     `parseApplicationListQuery`）——本路由只做「呼叫 → 若有錯誤就 throw
 *     400/403 → 否則查詢並回應」的薄層編排，不重複實作任何驗證邏輯。
 *
 * Explicitly OUT of scope for this Task (see PHASE-004.md §2, Task Graph):
 *   POST /admin/users/:userId/applications/travel (T10)
 *
 * Auth (§6.1 授權矩陣): requireAuth + requirePasswordChanged on every route
 * here; ownership is authorized purely from the DB-loaded `ownerId`
 * (`assertOwnershipOrAdmin`), never from any request-supplied identifier
 * (§6.2 資料隔離不變式 1 — BE-US-02 第三條 AC). `/applications/travel/preview`
 * has NO data ownership (stateless, §6.1 授權矩陣表) — auth is still required
 * (401/403 PASSWORD_CHANGE_REQUIRED) but there is no `assertOwnershipOrAdmin`
 * call because there is no persisted resource to own. `POST
 * /applications/:id/complete` is the one exception to the
 * `assertOwnershipOrAdmin` pattern — see the T8 note above (D17). `GET
 * /applications` is a different exception again: there is no single resource
 * to own (it is a per-owner *list*), so authorization is `resolveOwnerId`
 * (AC-74/84) rather than `assertOwnershipOrAdmin` — see T9 note above.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { assertOwnershipOrAdmin, requireAuth, requirePasswordChanged } from "../auth/middleware.js";
import { formatUtcDate, parseUtcDate } from "../parameters/parameter-service.js";
import type { FieldError } from "../platform/errors.js";
import { AppError } from "../platform/errors.js";
import {
  parseApplicationListQuery,
  queryApplications,
  resolveOwnerId,
  toApplicationListItemDto,
} from "./application-query.js";
import { assertApplicationMutable } from "./application-state-machine.js";
import { resolveTravelParameters } from "./travel-parameters.js";
import type { SegmentPatch } from "./travel-service.js";
import {
  completeTravelApplication,
  createTravelDraft,
  deleteApplication,
  formatTravelComputed,
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
// `attachmentIds`（PHASE-004-T11 新增）：格式驗證僅檢查「陣列，且每個元素為
// 非空字串」——業務規則（附件是否存在、擁有權一致、3 張上限、409 CONFLICT）
// 全部留給 travel-service.ts 的 `reconcileSegmentAttachments` 在交易內處理
// （AC-22/23/25/30、B-17/32）；此處刻意不查 DB，維持這層純格式驗證的職責。
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
    if (Object.prototype.hasOwnProperty.call(seg, "attachmentIds")) {
      const result = parseAttachmentIdsField(seg.attachmentIds, `segments[${index}].attachmentIds`);
      if (!result.ok) errors.push(result.error);
      else parsed.attachmentIds = result.value;
    }

    return parsed;
  });

  return { errors, segments };
}

/** `attachmentIds`: must be an array of non-empty strings when the key is present. */
function parseAttachmentIdsField(value: unknown, field: string): FieldParseResult<string[]> {
  if (!Array.isArray(value)) {
    return { ok: false, error: { field, reason: "必須為字串陣列" } };
  }
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      return { ok: false, error: { field, reason: "必須為非空字串組成的陣列" } };
    }
    ids.push(item);
  }
  return { ok: true, value: ids };
}

// ---------------------------------------------------------------------------
// PHASE-004-T7: /applications/travel/preview 專用 segments[] 格式驗證。
//
// §8.2 宣告的形狀較窄：`{ totalKm?, highwayKm? }[]`（無 id/origin/
// destination/attachmentIds — 預覽不需要，因為預覽從不寫入任何段落）。
// 沿用 T5 的 `parseKmField`（不重寫解析邏輯，Packet 明文要求）；三態語意
// 同 PUT 的 segments[] 欄位：key 缺席或值為 undefined → 視為未提供，該段
// totalKm/highwayKm 為 null（下游 `formatTravelComputed` 視 null 為 0 計算，
// 符合 Packet「里程為 null 的段落：視為 0 計算」）。
// ---------------------------------------------------------------------------

interface ParsedPreviewSegment {
  totalKm: Prisma.Decimal | null;
  highwayKm: Prisma.Decimal | null;
}

interface ParsedPreviewSegmentsResult {
  errors: FieldError[];
  segments: ParsedPreviewSegment[];
}

function parsePreviewSegmentsInput(segmentsRaw: unknown): ParsedPreviewSegmentsResult {
  const errors: FieldError[] = [];

  if (!Array.isArray(segmentsRaw)) {
    errors.push({ field: "segments", reason: "必須為陣列" });
    return { errors, segments: [] };
  }

  const segments: ParsedPreviewSegment[] = segmentsRaw.map((rawSegment, index) => {
    if (rawSegment === null || typeof rawSegment !== "object" || Array.isArray(rawSegment)) {
      errors.push({ field: `segments[${index}]`, reason: "必須為物件" });
      return { totalKm: null, highwayKm: null };
    }
    const seg = rawSegment as Record<string, unknown>;
    let totalKm: ParsedPreviewSegment["totalKm"] = null;
    let highwayKm: ParsedPreviewSegment["highwayKm"] = null;

    if (Object.prototype.hasOwnProperty.call(seg, "totalKm") && seg.totalKm !== undefined) {
      const result = parseKmField(seg.totalKm, `segments[${index}].totalKm`);
      if (!result.ok) errors.push(result.error);
      else totalKm = result.value;
    }
    if (Object.prototype.hasOwnProperty.call(seg, "highwayKm") && seg.highwayKm !== undefined) {
      const result = parseKmField(seg.highwayKm, `segments[${index}].highwayKm`);
      if (!result.ok) errors.push(result.error);
      else highwayKm = result.value;
    }

    return { totalKm, highwayKm };
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
  // POST /applications/travel/preview (PHASE-004-T7)
  // AC-31~36, AC-45~47（部分：呈現 parameterAvailable/missingParameters，
  // 不擋任何請求 — 完成端點才擋，見 travel-parameters.ts assertParametersAvailable
  // 供 T8 使用）, D6/D8, §9「金額預覽（stateless）」。
  //
  // Stateless：無資料擁有權判定（§6.1 授權矩陣「無資料擁有權（stateless）；
  // 不回傳他人資料」）——不查詢/寫入任何 Application/TripSegment/Attachment
  // 資料列（AC-36），只讀參數版本表（resolveTravelParameters 的 findMany）。
  // -------------------------------------------------------------------------

  fastify.post(
    "/applications/travel/preview",
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

      const { errors: segmentErrors, segments: parsedSegments } = parsePreviewSegmentsInput(
        body.segments
      );
      fieldErrors.push(...segmentErrors);

      if (fieldErrors.length > 0) {
        throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", fieldErrors);
      }

      // 唯一的 DB 存取：讀取（AC-36 唯讀鑑別力）。
      const resolved = await resolveTravelParameters(prisma, tripDate);

      const preview = formatTravelComputed(
        resolved,
        parsedSegments.map((s, index) => ({
          segmentId: null,
          segmentIndex: index,
          totalKm: s.totalKm,
          highwayKm: s.highwayKm,
        }))
      );

      return reply.status(200).send({ preview });
    }
  );

  // -------------------------------------------------------------------------
  // POST /applications/:id/complete (PHASE-004-T8)
  // AC-49~54/43/48/59, §9「完成申請」. Body 一律忽略（AC-54）——below, only
  // `request.params.id` and `request.currentUser` are ever read; there is no
  // code path that touches `request.body` at all.
  // -------------------------------------------------------------------------

  fastify.post(
    "/applications/:id/complete",
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const existing = await getTravelApplication(prisma, id);
      if (!existing) {
        throw new AppError("NOT_FOUND", 404, "找不到指定的申請");
      }

      // D17（Spec §17.1 定案 + Packet Out of Scope 明文）：完成僅能由申請
      // 擁有人本人執行——本 Phase 不提供管理員代完成。刻意不呼叫本檔其餘端點
      // 共用的 `assertOwnershipOrAdmin`（它會放行 ADMIN），改用嚴格的
      // owner-only 判定；ADMIN 若非擁有人，同一般他人一樣得 403（§6.2 資料
      // 隔離不變式 4：他人資源一律 403，不因資源存在與否洩漏）。
      if (request.currentUser.id !== existing.ownerId) {
        throw new AppError("FORBIDDEN", 403, "無權存取此資源");
      }

      const completed = await completeTravelApplication(prisma, id);
      const dto = await toTravelApplicationDto(prisma, completed);
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

  // -------------------------------------------------------------------------
  // GET /applications (PHASE-004-T9)
  // AC-60~71/74/84/91, §8.1 ApplicationListResponse, §8.2, §9「綜合查詢」.
  //
  // 授權（AC-74/84）先於格式驗證：一般使用者自帶他人 ownerId 直接 403，甚至
  // 不必先看其餘 query 參數是否合法——符合 §6.2 資料隔離不變式「不因資源存在
  // 與否／其他條件洩漏」的精神，並讓 403 測試不受其他無關參數影響。
  // -------------------------------------------------------------------------

  fastify.get(
    "/applications",
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as Record<string, string | undefined>;
      const actor = request.currentUser;

      // AC-74/84: 一般使用者強制 ownerId=self，自帶他人 → 403；管理員可指定
      // 任一 ownerId，未指定則預設自己（D10）。以 DB 查得之 ownerId 為準的
      // 精神在此體現為「永不信任請求參數決定要不要套用授權」——本函式本身
      // 就是唯一的授權判定點，見 application-query.ts 文件註解。
      const ownerId = resolveOwnerId(actor, query.ownerId);

      const parsed = parseApplicationListQuery(query, new Date());
      if (parsed.errors.length > 0) {
        throw new AppError(
          "VALIDATION_ERROR",
          400,
          "查詢參數有誤，請檢查標示欄位。",
          parsed.errors
        );
      }

      const filters = {
        ownerId,
        dateFrom: parsed.dateFrom,
        dateTo: parsed.dateTo,
        type: parsed.type,
        status: parsed.status,
        keyword: parsed.keyword,
        page: parsed.page,
        pageSize: parsed.pageSize,
      };

      const { items, total } = await queryApplications(prisma, filters);

      return reply.status(200).send({
        items: items.map(toApplicationListItemDto),
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        appliedFilters: {
          dateFrom: formatUtcDate(filters.dateFrom),
          dateTo: filters.dateTo ? formatUtcDate(filters.dateTo) : null,
          type: filters.type,
          status: filters.status,
          keyword: filters.keyword,
          ownerId: filters.ownerId,
        },
      });
    }
  );
};
