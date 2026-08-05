/**
 * Parameters routes — PHASE-003a-T3 / T5 (audit)
 *
 * Endpoints (backend routes; nginx strips /api prefix):
 *   POST /parameters/fuel         → REMOVED (PHASE-005a-T3b, §16 D1(a), AC-37):
 *                                    route no longer registered → 404 NOT_FOUND
 *                                    for all identities (admin/user/unauthenticated);
 *                                    preHandler chain does not run; zero writes.
 *                                    Superseded by POST /parameters/fuel-price.
 *   GET  /parameters/fuel         → 200 { versions: FuelParameterDto[] } (read-only,
 *                                    kept for audit trail / PHASE-008 legacy snapshots)
 *   POST /parameters/etc          → 201 { version: EtcParameterDto }
 *   GET  /parameters/etc          → 200 { versions: EtcParameterDto[] }
 *   POST /parameters/depreciation → 201 { version: DepreciationParameterDto }
 *   GET  /parameters/depreciation → 200 { versions: DepreciationParameterDto[] }
 *
 * Auth (all endpoints): requireAuth + requirePasswordChanged + requireAdmin
 *   (Spec §4.5 D10, AC-16/17/19)
 *
 * Validation:
 *   - unitPrice: number ≥ 0 (AC-03)
 *   - effectiveFrom: required, YYYY-MM-DD valid date (AC-06)
 *
 * No-overlap: T2 engine + DB @@unique(effectiveFrom) concurrent defense (AC-07, D4)
 *
 * T5 audit: Each successful create writes one AuditLog row inside the same transaction
 *   via onCreated callback (AC-18, D6: action=PARAMETER_VERSION_CREATED).
 *   - actorId = request.currentUser.id
 *   - action  = "PARAMETER_VERSION_CREATED"
 *   - targetId = null (parameter versions are not User targets)
 *   - targetLabel = "<TYPE>#<versionId>" (e.g. "FUEL#<id>")
 *   - summary = { parameterType, ...parameterFields, effectiveFrom }
 *   - Passwords/tokens/secrets NEVER in summary or targetLabel (CLAUDE.md / AC-27 principle)
 */

import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireAdmin, requireAuth, requirePasswordChanged } from "../auth/middleware.js";
import { AppError } from "../platform/errors.js";
import { createFuelPriceVersion, listFuelPriceVersions } from "./fuel-price-service.js";
import {
  createDepreciationVersion,
  createEtcVersion,
  listDepreciationVersions,
  listEtcVersions,
  listFuelVersions,
} from "./parameter-service.js";

// ---------------------------------------------------------------------------
// Audit transaction client type (subset of PrismaClient, excludes tx-level methods)
// ---------------------------------------------------------------------------

type TxClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

// ---------------------------------------------------------------------------
// Request body validation schemas (Fastify/ajv — project convention)
// ---------------------------------------------------------------------------

/**
 * Body schema for POST /parameters/fuel and POST /parameters/etc.
 * effectiveFrom is required (Fastify schema: must be a non-empty string, AC-06).
 * unitPrice type/range validation is delegated entirely to the service layer (AC-03):
 *   - Fastify schema does NOT validate unitPrice type, to accept both numeric and
 *     string Decimal inputs (clients may send "3.5000" or 3.5).
 *   - The service checks unitPrice ≥ 0 and returns 400 VALIDATION_ERROR with
 *     fields=[{field:"unitPrice"}] on violation.
 * additionalProperties:false prevents unexpected fields.
 */
const createParameterBodySchema = {
  type: "object",
  required: ["effectiveFrom"],
  properties: {
    unitPrice: {}, // accept any value — service validates type and range (AC-03)
    effectiveFrom: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

/**
 * Body schema for POST /parameters/fuel-price (PHASE-005a-T3).
 * fuelType / pricePerLiter pass through untyped so the service layer performs
 * the full validation (AC-05 enum gate, AC-06 format+range layers) and returns
 * proper field-level 400s rather than a generic Fastify schema-validation error.
 * effectiveFrom is required at the schema layer (AC-06 missing-field case).
 * additionalProperties:false prevents unexpected fields.
 */
const createFuelPriceBodySchema = {
  type: "object",
  required: ["effectiveFrom"],
  properties: {
    fuelType: {}, // accept any — service validates enum closure (AC-05)
    pricePerLiter: {}, // accept any — service validates format+range (AC-06)
    effectiveFrom: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

/**
 * Body schema for POST /parameters/depreciation.
 * effectiveFrom is required.
 * vehiclePrice, usefulLifeYears are passed through without type coercion
 * so the service layer can handle both string/number input and return proper field errors.
 * additionalProperties:false prevents unexpected fields.
 *
 * PHASE-007-R4b（Spec §20.3 AC-57(a)、§20.13 **D20**）：`estimatedAnnualKm` 已縮欄
 * 退場——handler **不再讀取**它，其值不進入 service、不進入 DB（新列該欄為 `NULL`）。
 * 但此 property **刻意保留宣告**：本 schema 為 `additionalProperties: false`，若一併
 * 刪除 property，夾帶該欄的舊呼叫端會被 Fastify schema 層擋成 **400**，正好違反
 * D20「夾帶不採用、**不回 400**」之裁定（沿全案「夾帶欄位一律靜默不採用」慣例）。
 * 保留宣告＝接受但忽略；其餘未知欄位仍由 `additionalProperties: false` 擋下。
 */
const createDepreciationBodySchema = {
  type: "object",
  required: ["effectiveFrom"],
  properties: {
    vehiclePrice: {}, // accept any — service validates > 0 and Decimal (AC-05, D8)
    usefulLifeYears: {}, // accept any — service validates > 0 and integer (AC-05, D8)
    estimatedAnnualKm: {}, // accepted for backward compatibility, never read (AC-57(a), D20)
    effectiveFrom: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

interface ParametersPluginOptions {
  prisma: PrismaClient;
}

// ---------------------------------------------------------------------------
// Parameters plugin
// ---------------------------------------------------------------------------

export const parametersPlugin: FastifyPluginAsync<ParametersPluginOptions> = async (
  fastify: FastifyInstance,
  options: ParametersPluginOptions
) => {
  const { prisma } = options;

  // All parameter routes require admin (Spec §4.5, D10, AC-16/17/19)
  const adminPreHandlers = [requireAuth(prisma), requirePasswordChanged, requireAdmin];

  // -------------------------------------------------------------------------
  // POST /parameters/fuel — REMOVED (PHASE-005a-T3b, §16 D1(a), AC-37).
  // The handler is intentionally not registered: Fastify's 404 handler
  // (setNotFoundHandler, backend/src/platform/error-handler.ts) answers
  // every request to this path with 404 NOT_FOUND, for every identity
  // (admin/user/unauthenticated) — the preHandler chain never runs, so
  // there is no authorization decision and zero writes ever occur here.
  // The only remaining write path for fuel prices is
  // POST /parameters/fuel-price (below).
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // GET /parameters/fuel — list all fuel parameter versions (AC-19; read-only,
  // kept for audit trail / PHASE-008 legacy snapshot display, §16 D1(a))
  // -------------------------------------------------------------------------

  fastify.get(
    "/parameters/fuel",
    { preHandler: adminPreHandlers },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const versions = await listFuelVersions(prisma);
      return reply.status(200).send({ versions });
    }
  );

  // -------------------------------------------------------------------------
  // POST /parameters/fuel-price — create a fuel price version by fuel type
  //   (PHASE-005a-T3, AC-01/02/03/05/06, §7.1/§16 D2(a)/D3(a-1)/D7(a))
  // -------------------------------------------------------------------------

  fastify.post(
    "/parameters/fuel-price",
    {
      preHandler: adminPreHandlers,
      schema: { body: createFuelPriceBodySchema },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as {
        fuelType?: unknown;
        pricePerLiter?: unknown;
        effectiveFrom: string;
      };

      const actorId = request.currentUser.id;

      const version = await createFuelPriceVersion(
        prisma,
        {
          fuelType: body.fuelType,
          pricePerLiter: body.pricePerLiter,
          effectiveFrom: body.effectiveFrom,
          createdById: actorId,
        },
        // Audit hook: write AuditLog inside same transaction, reusing the
        // existing PARAMETER_VERSION_CREATED action (parameterType=FUEL_PRICE
        // distinguishes it from the legacy FUEL/ETC/DEPRECIATION rows, §3.1).
        async (tx: TxClient, dto) => {
          await (tx as PrismaClient).auditLog.create({
            data: {
              action: "PARAMETER_VERSION_CREATED",
              actorId,
              targetId: null,
              targetLabel: `FUEL_PRICE#${dto.id}`,
              summary: {
                parameterType: "FUEL_PRICE",
                fuelType: dto.fuelType,
                pricePerLiter: dto.pricePerLiter,
                effectiveFrom: dto.effectiveFrom,
              },
            },
          });
        }
      );

      return reply.status(201).send({ version });
    }
  );

  // -------------------------------------------------------------------------
  // GET /parameters/fuel-price[?fuelType=] — list fuel price versions
  //   (PHASE-005a-T3, §7.1)
  // -------------------------------------------------------------------------

  fastify.get(
    "/parameters/fuel-price",
    { preHandler: adminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { fuelType?: unknown };
      const result = await listFuelPriceVersions(prisma, query.fuelType);
      if (!result.ok) {
        throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
          result.error,
        ]);
      }
      return reply.status(200).send({ versions: result.versions });
    }
  );

  // -------------------------------------------------------------------------
  // POST /parameters/etc — create an ETC parameter version (AC-02/03/06/07)
  // -------------------------------------------------------------------------

  fastify.post(
    "/parameters/etc",
    {
      preHandler: adminPreHandlers,
      schema: { body: createParameterBodySchema },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as {
        unitPrice?: number | string;
        effectiveFrom: string;
      };

      if (body.unitPrice === undefined || body.unitPrice === null || body.unitPrice === "") {
        throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
          { field: "unitPrice", reason: "單價為必填" },
        ]);
      }

      const actorId = request.currentUser.id;

      const version = await createEtcVersion(
        prisma,
        {
          unitPrice: body.unitPrice,
          effectiveFrom: body.effectiveFrom,
          createdById: actorId,
        },
        // T5 audit hook: write AuditLog inside same transaction (AC-18, D6)
        async (tx: TxClient, dto) => {
          await (tx as PrismaClient).auditLog.create({
            data: {
              action: "PARAMETER_VERSION_CREATED",
              actorId,
              targetId: null,
              targetLabel: `ETC#${dto.id}`,
              summary: {
                parameterType: "ETC",
                unitPrice: dto.unitPrice,
                effectiveFrom: dto.effectiveFrom,
              },
            },
          });
        }
      );

      return reply.status(201).send({ version });
    }
  );

  // -------------------------------------------------------------------------
  // GET /parameters/etc — list all ETC parameter versions (AC-19)
  // -------------------------------------------------------------------------

  fastify.get(
    "/parameters/etc",
    { preHandler: adminPreHandlers },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const versions = await listEtcVersions(prisma);
      return reply.status(200).send({ versions });
    }
  );

  // -------------------------------------------------------------------------
  // POST /parameters/depreciation — create a depreciation parameter version
  //   (AC-04/05/06/08/12/13/16/17)
  // -------------------------------------------------------------------------

  fastify.post(
    "/parameters/depreciation",
    {
      preHandler: adminPreHandlers,
      schema: { body: createDepreciationBodySchema },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // PHASE-007-R4b（AC-57(a)）：請求欄位集合縮為
      // `{ vehiclePrice, usefulLifeYears, effectiveFrom }`——`estimatedAnnualKm`
      // **不出現在此型別中**，故其值在本 handler 內無從被讀取或傳遞（夾帶不採用）。
      const body = request.body as {
        vehiclePrice?: number | string;
        usefulLifeYears?: number;
        effectiveFrom: string;
      };

      // Required field presence checks — service handles type/range validation (AC-05)
      const fieldErrors: { field: string; reason: string }[] = [];
      if (
        body.vehiclePrice === undefined ||
        body.vehiclePrice === null ||
        body.vehiclePrice === ""
      ) {
        fieldErrors.push({ field: "vehiclePrice", reason: "車價為必填且必須大於 0" });
      }
      if (
        body.usefulLifeYears === undefined ||
        body.usefulLifeYears === null ||
        body.usefulLifeYears === ("" as unknown)
      ) {
        fieldErrors.push({ field: "usefulLifeYears", reason: "折舊年限為必填且必須大於 0" });
      }
      // AC-57(a)：`estimatedAnnualKm` 之「必填」缺值檢查隨欄位退場而移除。

      if (fieldErrors.length > 0) {
        throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", fieldErrors);
      }

      const actorId = request.currentUser.id;

      const version = await createDepreciationVersion(
        prisma,
        {
          vehiclePrice: body.vehiclePrice as number | string,
          usefulLifeYears: body.usefulLifeYears as number,
          // AC-57(a)：不傳 `estimatedAnnualKm`（service 之 optional 參數預設 null，
          // D22）——新列該欄一律寫 `NULL`，夾帶值永遠不會抵達持久層。
          effectiveFrom: body.effectiveFrom,
          createdById: actorId,
        },
        // T5 audit hook: write AuditLog inside same transaction (AC-18, D6)
        async (tx: TxClient, dto) => {
          await (tx as PrismaClient).auditLog.create({
            data: {
              action: "PARAMETER_VERSION_CREATED",
              actorId,
              targetId: null,
              targetLabel: `DEPRECIATION#${dto.id}`,
              // PHASE-007-R4b（Spec §20.11.2 之 `phase3a-parameter-audit.test.ts`
              // 列逐字：「稽核 `summary` 欄位集合**縮欄**」）：移除
              // `estimatedAnnualKm` 鍵。稽核 summary 與回應 DTO 是兩份契約，故
              // 需各自裁定——此處之依據為：本端點建立的**每一列**該欄皆為 `NULL`
              // （AC-57(a)），保留該鍵只會在每一筆稽核紀錄留下一個恆為 null 的欄，
              // 既非「建立當下的輸入」也非「落地的值」，不具稽核意義；而歷史稽核
              // 紀錄（縮欄前寫入者）之 summary 為既存 JSON，本變更不回溯改寫，
              // 其原值續存可讀（與 AC-57(c) 之歷史唯讀精神一致）。
              summary: {
                parameterType: "DEPRECIATION",
                vehiclePrice: dto.vehiclePrice,
                usefulLifeYears: dto.usefulLifeYears,
                effectiveFrom: dto.effectiveFrom,
              },
            },
          });
        }
      );

      return reply.status(201).send({ version });
    }
  );

  // -------------------------------------------------------------------------
  // GET /parameters/depreciation — list all depreciation parameter versions (AC-19)
  // -------------------------------------------------------------------------

  fastify.get(
    "/parameters/depreciation",
    { preHandler: adminPreHandlers },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const versions = await listDepreciationVersions(prisma);
      return reply.status(200).send({ versions });
    }
  );
};
