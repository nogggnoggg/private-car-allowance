/**
 * User fuel-consumption routes — PHASE-005a-T5
 *
 * Endpoints (backend routes; nginx strips /api prefix):
 *   POST /users/:userId/fuel-consumption → 201 { version: FuelConsumptionVersionWithStateDto }
 *   GET  /users/:userId/fuel-consumption → 200 { versions: FuelConsumptionVersionWithStateDto[] }
 *
 * Spec §2.B AC-12/13/14, §2.G AC-36, §7.2, §16 D7(a)/D8(a).
 *
 * Auth (both endpoints): requireAuth + requirePasswordChanged + requireAdmin
 *   — this is the exact ordering AC-13 requires: 認證 → 強制改密 → 授權
 *   （requireAdmin）→ 格式驗證. Body validation (fuelType/kmPerLiter/
 *   effectiveFrom/basisNote format+range) is delegated entirely to
 *   `fuel-consumption-service.ts`'s `createFuelConsumptionVersion`, which
 *   runs strictly AFTER the preHandler chain above — so a normal user (or
 *   an unauthenticated caller, or a mustChangePassword=true admin) hitting
 *   POST with a malformed/legal body alike is rejected by the preHandler
 *   chain BEFORE any body parsing/validation ever runs. This route
 *   deliberately registers **no Fastify `schema.body`** for POST: a
 *   `required`/`additionalProperties:false` schema is validated by Fastify
 *   at the "validation" lifecycle step, which runs BEFORE `preHandler` —
 *   using such a schema here would let a malformed body short-circuit to
 *   400 for an unauthenticated/non-admin caller, creating exactly the
 *   side-channel AC-13 forbids ("授權失敗之回應不得因輸入合法與否而有差異").
 *   `request.body` is therefore read as `unknown` and passed through
 *   untouched to the service layer.
 *
 * AR-1（T4 複審，Packet 逐字義務）: `userId` 不存在（404）與 body 格式錯誤
 *   （400）同時成立時，`createFuelConsumptionVersion` 之驗證順序為
 *   **格式層優先**（1~5 格式/值域驗證 → 6 userId 存在性 → 7 重疊檢查），
 *   而非 `backend/src/admin/routes.ts` 既有之「先 404 後 400」慣例。兩者
 *   刻意分歧：T4 裁定維持格式優先，理由為「洩漏更少」——若採 404 優先，
 *   呼叫端可用「固定合法格式＋窮舉 userId」的方式探測帳號是否存在而不觸發
 *   任何格式錯誤路徑；格式優先則使「格式是否合法」與「userId 是否存在」
 *   两个探測面不可分離觀察。此差異已知且刻意，非本 Task 之回歸缺陷。
 *
 * T5 稽核（AC-14）: 建立成功後，`onCreated` hook 在**與 create() 相同的
 * `$transaction` 內**（見 service 層 `prisma.$transaction` 回呼）重查該
 * 使用者之其餘版本，計算 `before`（新版本 `effectiveFrom` 前一日之有效
 * 版本，`findEffectiveVersion(otherVersions, effectiveFrom − 1 day)`——
 * 嚴格早於，非 `findEffectiveVersion(otherVersions, effectiveFrom)` 之
 * `<=` 語意），寫入一列 `AuditLog`。若 `auditLog.create` 拋出，整個
 * `$transaction` 回呼會拋出，Prisma 互動式交易語意保證整筆 create() 一併
 * 回滾（見 `phase5a-fuel-consumption-authz.test.ts` 之 stub 測試）。
 */

import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireAdmin, requireAuth, requirePasswordChanged } from "../auth/middleware.js";
import { formatUtcDate, parseUtcDate } from "../parameters/parameter-service.js";
import { findEffectiveVersion } from "../parameters/parameter-version-engine.js";
import { AppError } from "../platform/errors.js";
import type { FuelConsumptionVersionDto } from "./fuel-consumption-service.js";
import {
  createFuelConsumptionVersion,
  listFuelConsumptionVersions,
} from "./fuel-consumption-service.js";

// ---------------------------------------------------------------------------
// Audit transaction client type (subset of PrismaClient, excludes tx-level methods)
// — identical convention to parameters/routes.ts's TxClient.
// ---------------------------------------------------------------------------

type TxClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

// ---------------------------------------------------------------------------
// DTO: §7.2 FuelConsumptionVersionDto + `state` (AC-12, computed here — the
// service layer intentionally does not compute `state`, see its own header).
// ---------------------------------------------------------------------------

export type FuelConsumptionVersionState = "HISTORICAL" | "CURRENT" | "FUTURE";

export interface FuelConsumptionVersionWithStateDto extends FuelConsumptionVersionDto {
  state: FuelConsumptionVersionState;
}

/**
 * 為每一列版本附加相對於**查詢當日**（UTC）之 `state`（AC-12）。
 *
 * 複用 `findEffectiveVersion`（不重寫日期比較邏輯）：對查詢當日呼叫一次，
 * 取得「今日生效版本」；效期晚於今日者為 `FUTURE`，等於今日生效版本者為
 * `CURRENT`，其餘（效期不晚於今日、但非今日生效版本者）為 `HISTORICAL`。
 * `effectiveFrom` 為 `YYYY-MM-DD` 字串，ISO 格式下字串比較與日期比較同序，
 * 用於 `FUTURE` 之快速判定；`CURRENT`/`HISTORICAL` 之分界仍完全依賴
 * `findEffectiveVersion` 之判定結果（避免自行重寫「最新生效版本」邏輯）。
 */
function withState(
  versions: FuelConsumptionVersionDto[],
  queryDate: Date
): FuelConsumptionVersionWithStateDto[] {
  const todayStr = formatUtcDate(queryDate);
  const currentVersion = findEffectiveVersion(versions, queryDate);

  return versions.map((v) => {
    let state: FuelConsumptionVersionState;
    if (v.effectiveFrom > todayStr) {
      state = "FUTURE";
    } else if (currentVersion && currentVersion.id === v.id) {
      state = "CURRENT";
    } else {
      state = "HISTORICAL";
    }
    return { ...v, state };
  });
}

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

interface FuelConsumptionPluginOptions {
  prisma: PrismaClient;
}

// ---------------------------------------------------------------------------
// Fuel-consumption plugin
// ---------------------------------------------------------------------------

export const fuelConsumptionPlugin: FastifyPluginAsync<FuelConsumptionPluginOptions> = async (
  fastify: FastifyInstance,
  options: FuelConsumptionPluginOptions
) => {
  const { prisma } = options;

  // Admin-only, ordered per AC-13: 認證 → 強制改密 → 授權（requireAdmin）→
  // 格式驗證（delegated to the service layer, runs after this chain).
  const adminPreHandlers = [requireAuth(prisma), requirePasswordChanged, requireAdmin];

  // -------------------------------------------------------------------------
  // POST /users/:userId/fuel-consumption — create a fuel-consumption version
  //   for the given user (AC-07~14, §7.2, §16 D7(a)/D8(a))
  // -------------------------------------------------------------------------

  fastify.post(
    "/users/:userId/fuel-consumption",
    { preHandler: adminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = request.params as { userId: string };

      // No Fastify body schema is registered on this route (see file header
      // JSDoc for why) — read as unknown and let the service layer perform
      // every format/range check (AC-11), in that order, AFTER the
      // authorization preHandler chain above has already run.
      const rawBody = (request.body ?? {}) as Record<string, unknown>;

      const actorId = request.currentUser.id;

      const version = await createFuelConsumptionVersion(
        prisma,
        {
          userId,
          fuelType: rawBody.fuelType,
          kmPerLiter: rawBody.kmPerLiter,
          effectiveFrom: rawBody.effectiveFrom,
          basisNote: rawBody.basisNote,
          createdById: actorId,
        },
        // AC-14 audit hook: runs INSIDE the same $transaction as create()
        // (service layer awaits this callback before the transaction
        // resolves) — if auditLog.create() throws, the whole transaction
        // (including the just-created version row) rolls back.
        async (tx: TxClient, dto: FuelConsumptionVersionDto) => {
          // Re-query the user's OTHER versions (excluding the one just
          // created) inside the same transaction, to compute `before` per
          // the Spec's precise definition: the last version effective
          // STRICTLY BEFORE the new version's effectiveFrom.
          const otherVersions = await (tx as PrismaClient).userFuelConsumptionVersion.findMany({
            where: { userId: dto.userId, id: { not: dto.id } },
            select: { id: true, fuelType: true, kmPerLiter: true, effectiveFrom: true },
          });

          // newEffectiveFrom − 1 day (UTC, 24h subtraction — no DST at UTC
          // midnight). `parseUtcDate` already validated this string upstream
          // (service layer step 4), so it cannot be null here.
          const newEffectiveFromDate = parseUtcDate(dto.effectiveFrom) as Date;
          const dayBeforeNewEffectiveFrom = new Date(newEffectiveFromDate.getTime() - 86_400_000);

          // Strictly-before semantics via findEffectiveVersion(existing, D−1)
          // — deliberately NOT findEffectiveVersion(existing, D), which would
          // use `<=` and could wrongly select a version effective ON D itself
          // (impossible here since the same-day version is `dto` itself,
          // excluded above — but D−1 is the Spec-mandated construction, kept
          // literal rather than relying on that exclusion alone).
          const beforeRow = findEffectiveVersion(otherVersions, dayBeforeNewEffectiveFrom);

          const before = beforeRow
            ? {
                fuelType: beforeRow.fuelType,
                kmPerLiter: beforeRow.kmPerLiter.toFixed(4),
                effectiveFrom: formatUtcDate(beforeRow.effectiveFrom),
              }
            : null;

          const targetUser = await (tx as PrismaClient).user.findUnique({
            where: { id: dto.userId },
            select: { loginName: true },
          });

          await (tx as PrismaClient).auditLog.create({
            data: {
              action: "USER_FUEL_CONSUMPTION_VERSION_CREATED",
              actorId,
              targetId: dto.userId,
              // targetLabel = 對象 loginName 快照（AC-14）；targetUser 理論上
              // 不可能為 null（userId 存在性已於建立前驗證），但仍以 dto.userId
              // 為 fallback，避免任何情況下寫入 undefined。
              targetLabel: targetUser?.loginName ?? dto.userId,
              summary: {
                before,
                after: {
                  fuelType: dto.fuelType,
                  kmPerLiter: dto.kmPerLiter,
                  effectiveFrom: dto.effectiveFrom,
                },
                basisNote: dto.basisNote,
              },
            },
          });
        }
      );

      return reply.status(201).send({ version });
    }
  );

  // -------------------------------------------------------------------------
  // GET /users/:userId/fuel-consumption — list a user's fuel-consumption
  //   versions with computed `state` (AC-12, §7.2)
  // -------------------------------------------------------------------------

  fastify.get(
    "/users/:userId/fuel-consumption",
    { preHandler: adminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = request.params as { userId: string };

      // userId existence check (§7.2 GET contract: 404 for unknown userId).
      const targetUser = await prisma.user.findUnique({ where: { id: userId } });
      if (!targetUser) {
        throw new AppError("NOT_FOUND", 404, "使用者不存在");
      }

      const versions = await listFuelConsumptionVersions(prisma, userId);
      const versionsWithState = withState(versions, new Date());

      return reply.status(200).send({ versions: versionsWithState });
    }
  );
};
