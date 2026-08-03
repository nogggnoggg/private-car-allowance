/**
 * Integration tests for PHASE-004-T15 — 引用保護閉環（AC-92/93）
 *
 * Closes out two Cross-Phase reserved judgment points now that PHASE-004-T1
 * (`Application`/`TravelApplication`) and T8 (`completeTravelApplication`
 * writes real completion snapshots) both exist:
 *
 *   - AC-92 (AD-US-04 / PHASE-002-T9's `userHasHistory` extensibility point):
 *     a user with ANY `Application` (draft or completed) cannot be
 *     permanently deleted — 409 CONFLICT with a deactivate hint, no data
 *     deleted.
 *   - AC-93 (BE-US-19 / PHASE-003a §4.7's reserved `parameterHasReferences`
 *     contract): a parameter version referenced by a COMPLETED travel
 *     application's snapshot reports `true`; an unreferenced version (or one
 *     only touched by a DRAFT, which never has a snapshot) reports `false`.
 *
 * Discriminating design (Packet Required Tests 3/6):
 *   - AC-92 includes a NEGATIVE case (user with zero Applications deletes
 *     successfully) so the gate cannot be "always 409".
 *   - AC-93 includes a BOUNDARY case: a DRAFT travel application whose
 *     tripDate falls inside the referenced version's effective window, but
 *     which was never completed (no snapshot) — must still report `false`,
 *     proving the judgment is snapshot-based, not effective-window-based.
 *
 * Test discipline (Spec §11.0 / Packet C5):
 *   - loginName prefix "p4rp_" + per-run random suffix.
 *   - cleanup scoped to this suite's own tracked ids + loginName prefix;
 *     NEVER deleteMany({}) globally; never touches other test files' data.
 *   - synthetic data only.
 *   - FuelParameterVersion/EtcParameterVersion.effectiveFrom is a GLOBAL
 *     table — this file claims its own unused calendar years (2045~2048),
 *     mirroring the existing per-file year-claiming convention in
 *     phase4-travel-complete.test.ts (2034~2040) etc.
 */
import { FuelType, Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { parameterHasReferences } from "../../src/parameters/reference-guard.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Shared helpers (pattern per phase4-travel-complete.test.ts)
// ---------------------------------------------------------------------------

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0];
}

async function loginUser(
  app: FastifyInstance,
  loginName: string,
  password: string
): Promise<string> {
  const resp = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { loginName, password },
  });
  if (resp.statusCode !== 200) {
    throw new Error(`Login failed for ${loginName}: ${resp.statusCode} ${resp.body}`);
  }
  return extractCookieHeader(resp.headers["set-cookie"]);
}

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p4rp_";
const PASSWORD = "ReferenceProtectionTest99!";

interface ErrorJson {
  error: { code: string; message: string };
}

describeWithDb("PHASE-004-T15 — 引用保護閉環（AC-92/93）", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let adminId: string;
  let adminCookie: string;

  const createdUserIds: string[] = [];
  const createdUserLoginNames: string[] = [];
  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];
  const createdFuelVersionIds: string[] = [];
  const createdEtcVersionIds: string[] = [];
  const createdConsumptionIds: string[] = [];

  function trackUser(id: string, loginName: string): string {
    createdUserIds.push(id);
    createdUserLoginNames.push(loginName);
    return id;
  }

  async function createUser(
    loginName: string,
    displayName: string,
    role: "USER" | "ADMIN" = "USER"
  ) {
    const hash = await hashPassword(PASSWORD);
    const user = await prisma.user.create({
      data: {
        loginName,
        displayName,
        passwordHash: hash,
        role,
        isActive: true,
        mustChangePassword: false,
      },
    });
    trackUser(user.id, loginName);
    return user;
  }

  async function createLinkedAttachment(segmentId: string, forOwnerId: string) {
    const att = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `p4rp-synthetic-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
        mimeType: "image/jpeg",
        byteSize: 123,
        originalFilename: "synthetic.jpg",
        uploaderId: forOwnerId,
        ownerId: forOwnerId,
        refType: "TRIP_SEGMENT",
        refId: segmentId,
        linkedAt: new Date(),
      },
    });
    createdAttachmentIds.push(att.id);
    return att;
  }

  /**
   * PHASE-005a-T7: 新模型下油資單價依「擁有人油耗版本 → 該油種油價版本」雙鏈
   * 推導（不再直讀 `FuelParameterVersion`）。呼叫端若之後要對某位使用者呼叫
   * `/complete`，須傳入 `consumerId`（該使用者）以便同時建立其油耗版本；僅
   * 建立版本、不完成任何申請的呼叫可省略。以 kmPerLiter="1.0000" 保留測試
   * 等價（見 phase4-travel-complete.test.ts 同一慣例）。
   */
  async function createParamVersions(
    effectiveFrom: string,
    fuelPrice: string,
    etcPrice: string,
    consumerId?: string
  ): Promise<{ fuelVersionId: string; etcVersionId: string; consumptionVersionId: string | null }> {
    let consumptionVersionId: string | null = null;
    if (consumerId) {
      const consumption = await prisma.userFuelConsumptionVersion.create({
        data: {
          userId: consumerId,
          fuelType: FuelType.GASOLINE_95,
          kmPerLiter: new Prisma.Decimal("1.0000"),
          effectiveFrom: new Date(effectiveFrom),
          basisNote: "p4rp 測試 fixture：kmPerLiter=1",
          createdById: adminId,
        },
      });
      createdConsumptionIds.push(consumption.id);
      consumptionVersionId = consumption.id;
    }
    const fuel = await prisma.fuelPriceVersion.create({
      data: {
        fuelType: FuelType.GASOLINE_95,
        pricePerLiter: new Prisma.Decimal(fuelPrice),
        effectiveFrom: new Date(effectiveFrom),
        createdById: adminId,
      },
    });
    const etc = await prisma.etcParameterVersion.create({
      data: {
        unitPrice: new Prisma.Decimal(etcPrice),
        effectiveFrom: new Date(effectiveFrom),
        createdById: adminId,
      },
    });
    createdFuelVersionIds.push(fuel.id);
    createdEtcVersionIds.push(etc.id);
    return { fuelVersionId: fuel.id, etcVersionId: etc.id, consumptionVersionId };
  }

  async function createDraft(cookie: string) {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/travel",
      headers: { cookie },
      payload: {},
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ application: { id: string } }>();
    createdApplicationIds.push(body.application.id);
    return body.application.id as string;
  }

  async function putSegments(
    cookie: string,
    id: string,
    segments: Record<string, unknown>[],
    extra: Record<string, unknown> = {}
  ) {
    return app.inject({
      method: "PUT",
      url: `/applications/travel/${id}`,
      headers: { cookie },
      payload: { segments, ...extra },
    });
  }

  async function completeHttp(cookie: string, id: string) {
    return app.inject({
      method: "POST",
      url: `/applications/${id}/complete`,
      headers: { cookie },
    });
  }

  /** Build a completable draft (one segment, one linked attachment, tripDate/purpose set) and complete it. */
  async function buildAndCompleteTravelApplication(
    cookie: string,
    ownerIdForAttachments: string,
    input: { tripDate: string; purpose: string }
  ): Promise<string> {
    const applicationId = await createDraft(cookie);
    const putResp = await putSegments(cookie, applicationId, [
      {
        origin: "甲地",
        destination: "乙地",
        totalKm: "30.00",
        highwayKm: "10.00",
        attachmentIds: [],
      },
    ]);
    expect(putResp.statusCode).toBe(200);
    const segmentId = putResp.json<{ application: { segments: { id: string }[] } }>().application
      .segments[0].id;
    await createLinkedAttachment(segmentId, ownerIdForAttachments);
    const finalPut = await app.inject({
      method: "PUT",
      url: `/applications/travel/${applicationId}`,
      headers: { cookie },
      payload: { tripDate: input.tripDate, purpose: input.purpose },
    });
    expect(finalPut.statusCode).toBe(200);

    const completeResp = await completeHttp(cookie, applicationId);
    expect(completeResp.statusCode).toBe(200);
    return applicationId;
  }

  /** Build a draft only (tripDate set, no segments/attachments) — never completed, so no snapshot. */
  async function buildDraftTravelApplication(
    cookie: string,
    input: { tripDate: string; purpose: string }
  ): Promise<string> {
    const applicationId = await createDraft(cookie);
    const putResp = await app.inject({
      method: "PUT",
      url: `/applications/travel/${applicationId}`,
      headers: { cookie },
      payload: { tripDate: input.tripDate, purpose: input.purpose },
    });
    expect(putResp.statusCode).toBe(200);
    return applicationId;
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const admin = await createUser(`${LOGIN_PREFIX}admin_${RUN_ID}`, "P4RP 管理員", "ADMIN");
    adminId = admin.id;

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    adminCookie = await loginUser(app, admin.loginName, PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      if (createdAttachmentIds.length > 0) {
        await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
      }
      if (createdApplicationIds.length > 0) {
        await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
      }
      if (createdConsumptionIds.length > 0) {
        await prisma.userFuelConsumptionVersion.deleteMany({
          where: { id: { in: createdConsumptionIds } },
        });
      }
      if (createdFuelVersionIds.length > 0) {
        await prisma.fuelPriceVersion.deleteMany({
          where: { id: { in: createdFuelVersionIds } },
        });
      }
      if (createdEtcVersionIds.length > 0) {
        await prisma.etcParameterVersion.deleteMany({
          where: { id: { in: createdEtcVersionIds } },
        });
      }
      if (createdUserIds.length > 0) {
        await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
        await prisma.auditLog.deleteMany({
          where: {
            OR: [{ actorId: { in: createdUserIds } }, { targetId: { in: createdUserIds } }],
          },
        });
      }
      // Some victim users are deleted by the tests themselves (AC-92 negative
      // case) — deleteMany on ids that no longer exist is a no-op, not an error.
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
  });

  // ===========================================================================
  // AC-92 — userHasHistory 接上 Application：有歷史拒刪，無歷史可刪
  // ===========================================================================

  describe("AC-92 — 有申請紀錄之使用者不得永久刪除", () => {
    it("使用者有草稿 Application → DELETE → 409 CONFLICT + 停用提示；使用者仍存在", async () => {
      const victim = await createUser(`${LOGIN_PREFIX}draft_victim_${RUN_ID}`, "P4RP 草稿受測者");
      const victimCookie = await loginUser(app, victim.loginName, PASSWORD);
      await createDraft(victimCookie);

      const resp = await app.inject({
        method: "DELETE",
        url: `/admin/users/${victim.id}`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(409);
      const body = resp.json<ErrorJson>();
      expect(body.error.code).toBe("CONFLICT");
      // 既有協定：message 提示改用停用（AC-23 沿用文案，滿足 AC-92「提供停用選項」）
      expect(body.error.message).toContain("停用");

      const stillExists = await prisma.user.findUnique({ where: { id: victim.id } });
      expect(stillExists).not.toBeNull();
    });

    it("使用者有已完成 Application → DELETE → 409 CONFLICT + 停用提示；使用者仍存在", async () => {
      const victim = await createUser(`${LOGIN_PREFIX}done_victim_${RUN_ID}`, "P4RP 已完成受測者");
      const victimCookie = await loginUser(app, victim.loginName, PASSWORD);
      await createParamVersions("2045-01-01", "5.0000", "2.0000", victim.id);
      await buildAndCompleteTravelApplication(victimCookie, victim.id, {
        tripDate: "2045-06-01",
        purpose: "P4RP 已完成申請歷史測試",
      });

      const resp = await app.inject({
        method: "DELETE",
        url: `/admin/users/${victim.id}`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(409);
      const body = resp.json<ErrorJson>();
      expect(body.error.code).toBe("CONFLICT");
      expect(body.error.message).toContain("停用");

      const stillExists = await prisma.user.findUnique({ where: { id: victim.id } });
      expect(stillExists).not.toBeNull();
    });

    it("鑑別力：使用者沒有任何 Application → DELETE 成功（200），非「永遠 409」", async () => {
      const victim = await createUser(`${LOGIN_PREFIX}clean_victim_${RUN_ID}`, "P4RP 無歷史受測者");

      const resp = await app.inject({
        method: "DELETE",
        url: `/admin/users/${victim.id}`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ ok: boolean }>();
      expect(body.ok).toBe(true);

      const gone = await prisma.user.findUnique({ where: { id: victim.id } });
      expect(gone).toBeNull();
    });
  });

  // ===========================================================================
  // AC-93 — parameterHasReferences 接上完成快照
  // ===========================================================================

  describe("AC-93 — 被已完成差旅引用之參數版本回報有引用", () => {
    it("已完成差旅引用 v1 → parameterHasReferences('FUEL_PRICE'/'FUEL_CONSUMPTION'/'ETC', v1.id) 皆回 true", async () => {
      const owner = await createUser(`${LOGIN_PREFIX}ref_owner_${RUN_ID}`, "P4RP 引用擁有人");
      const ownerCookie = await loginUser(app, owner.loginName, PASSWORD);
      const { fuelVersionId, etcVersionId, consumptionVersionId } = await createParamVersions(
        "2046-01-01",
        "6.0000",
        "3.0000",
        owner.id
      );
      await buildAndCompleteTravelApplication(ownerCookie, owner.id, {
        tripDate: "2046-06-01",
        purpose: "P4RP AC-93 正向引用測試",
      });

      // PHASE-005a-T7 起，completeTravelApplication 寫入新模型雙鏈欄位
      // （fuelPriceVersionId／fuelConsumptionVersionId），不再寫入舊模型
      // 單一欄位 fuelParameterVersionId（D11(a)）。
      await expect(parameterHasReferences(prisma, "FUEL_PRICE", fuelVersionId)).resolves.toBe(true);
      expect(consumptionVersionId).not.toBeNull();
      await expect(
        parameterHasReferences(prisma, "FUEL_CONSUMPTION", consumptionVersionId as string)
      ).resolves.toBe(true);
      await expect(parameterHasReferences(prisma, "ETC", etcVersionId)).resolves.toBe(true);

      // 舊型別 "FUEL" 保留其舊列語意（查 fuelParameterVersionId）：新模型完成
      // 之申請從未寫入該欄位，因此對新模型版本 id 正確回 false（不是「永遠 true」）。
      await expect(parameterHasReferences(prisma, "FUEL", fuelVersionId)).resolves.toBe(false);
    });

    it("從未被任何完成申請引用的版本 → parameterHasReferences 回 false", async () => {
      const { fuelVersionId, etcVersionId } = await createParamVersions(
        "2047-01-01",
        "7.0000",
        "4.0000"
      );

      await expect(parameterHasReferences(prisma, "FUEL_PRICE", fuelVersionId)).resolves.toBe(
        false
      );
      await expect(parameterHasReferences(prisma, "ETC", etcVersionId)).resolves.toBe(false);
    });

    it("邊界（鑑別力）：草稿差旅之出差日期落在版本生效區間，但未完成（無快照）→ 仍回 false", async () => {
      const owner = await createUser(
        `${LOGIN_PREFIX}draft_ref_owner_${RUN_ID}`,
        "P4RP 草稿引用擁有人"
      );
      const ownerCookie = await loginUser(app, owner.loginName, PASSWORD);
      const { fuelVersionId, etcVersionId } = await createParamVersions(
        "2048-01-01",
        "8.0000",
        "5.0000"
      );
      // tripDate 落在 v1 生效區間內（2048-01-01 起生效，無下一版本 → 永遠生效），
      // 但這是草稿：從未呼叫 /complete，因此 fuelPriceVersionId/fuelConsumptionVersionId/
      // etcParameterVersionId 從未被寫入（completeTravelApplication 才會寫）。
      await buildDraftTravelApplication(ownerCookie, {
        tripDate: "2048-06-01",
        purpose: "P4RP AC-93 邊界測試：草稿不算引用",
      });

      await expect(parameterHasReferences(prisma, "FUEL_PRICE", fuelVersionId)).resolves.toBe(
        false
      );
      await expect(parameterHasReferences(prisma, "ETC", etcVersionId)).resolves.toBe(false);
    });
  });
});
