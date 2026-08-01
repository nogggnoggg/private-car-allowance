/**
 * Parameters routes — PHASE-003a-T3 / T5 (audit)
 *
 * Endpoints (backend routes; nginx strips /api prefix):
 *   POST /parameters/fuel         → 201 { version: FuelParameterDto }
 *   GET  /parameters/fuel         → 200 { versions: FuelParameterDto[] }
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
import {
  createDepreciationVersion,
  createEtcVersion,
  createFuelVersion,
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
 * Body schema for POST /parameters/depreciation.
 * effectiveFrom is required.
 * vehiclePrice, usefulLifeYears, estimatedAnnualKm are passed through without type coercion
 * so the service layer can handle both string/number input and return proper field errors.
 * additionalProperties:false prevents unexpected fields.
 */
const createDepreciationBodySchema = {
  type: "object",
  required: ["effectiveFrom"],
  properties: {
    vehiclePrice: {}, // accept any — service validates > 0 and Decimal (AC-05, D8)
    usefulLifeYears: {}, // accept any — service validates > 0 and integer (AC-05, D8)
    estimatedAnnualKm: {}, // accept any — service validates > 0 and integer (AC-05, D8)
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
  // POST /parameters/fuel — create a fuel parameter version (AC-01/03/06/07)
  // -------------------------------------------------------------------------

  fastify.post(
    "/parameters/fuel",
    {
      preHandler: adminPreHandlers,
      schema: { body: createParameterBodySchema },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as {
        unitPrice?: number | string;
        effectiveFrom: string;
      };

      // unitPrice is required — schema marks it optional (not in required[]) to get
      // a nicer validation error from service layer; but we must check presence.
      if (body.unitPrice === undefined || body.unitPrice === null || body.unitPrice === "") {
        throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
          { field: "unitPrice", reason: "單價為必填" },
        ]);
      }

      const actorId = request.currentUser.id;

      const version = await createFuelVersion(
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
              targetLabel: `FUEL#${dto.id}`,
              summary: {
                parameterType: "FUEL",
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
  // GET /parameters/fuel — list all fuel parameter versions (AC-19)
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
      const body = request.body as {
        vehiclePrice?: number | string;
        usefulLifeYears?: number;
        estimatedAnnualKm?: number;
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
      if (
        body.estimatedAnnualKm === undefined ||
        body.estimatedAnnualKm === null ||
        body.estimatedAnnualKm === ("" as unknown)
      ) {
        fieldErrors.push({
          field: "estimatedAnnualKm",
          reason: "預估年度行駛公里數為必填且必須大於 0",
        });
      }

      if (fieldErrors.length > 0) {
        throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", fieldErrors);
      }

      const actorId = request.currentUser.id;

      const version = await createDepreciationVersion(
        prisma,
        {
          vehiclePrice: body.vehiclePrice as number | string,
          usefulLifeYears: body.usefulLifeYears as number,
          estimatedAnnualKm: body.estimatedAnnualKm as number,
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
              summary: {
                parameterType: "DEPRECIATION",
                vehiclePrice: dto.vehiclePrice,
                usefulLifeYears: dto.usefulLifeYears,
                estimatedAnnualKm: dto.estimatedAnnualKm,
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
