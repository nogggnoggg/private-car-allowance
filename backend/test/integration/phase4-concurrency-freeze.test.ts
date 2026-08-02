/**
 * Integration tests: PHASE-004-R4 — 已完成申請與其附件的併發凍結
 * （Review M-2 High + S-1 Medium 修復回合）
 *
 * Covers AC-06/56/59（已完成申請不可修改／刪除）、AC-26/59（已完成附件不可
 * 刪除/解除關聯）、§7.3 不變式 3。
 *
 * Defects fixed this round (see Task Handoff「交易邊界完整清單」for the full
 * grep-based audit):
 *   M-2（High）— `updateTravelDraft`（PUT 段落）與 `deleteApplication`
 *     （DELETE 申請）的 mutability 守門只在交易外執行一次（routes.ts 的
 *     `assertApplicationMutable`），交易內從未重新驗證 `status` —— 一個
 *     恰好在「外層檢查通過」與「這次交易真正寫入」之間插入的併發
 *     `completeTravelApplication` 可以讓已完成的申請被悄悄改動或刪除。
 *   S-1（Medium）— `DELETE /attachments/:id` 的 `containerState` 推導
 *     （`deriveContainerState`）與實際的 detach/delete 寫入分屬兩次獨立呼叫
 *     （routes.ts 呼叫 `deriveContainerState`，再呼叫 `deleteAttachment`，
 *     `deleteAttachment` 內部又自己重新 `findUnique` 一次），全程沒有任何
 *     `$transaction` 把兩者綁在一起——同樣的視窗可以讓已完成申請的佐證附件
 *     被併發解除關聯。
 *
 * Test design rationale — DETERMINISTIC reconstruction over raw `Promise.all`
 * timing races:
 *   The vulnerable window in both defects is bounded by TWO calls that used
 *   to be independent: an OUTER check (routes.ts, pre-transaction) and an
 *   INNER write (the service function's own transaction). A raw
 *   `Promise.all([complete(), put()])` does NOT reliably reproduce "outer
 *   check already passed, then complete() commits, then the inner write
 *   runs" — in practice `updateTravelDraft`'s first statement is a fast
 *   `SELECT ... FOR UPDATE` that usually WINS the race against
 *   `completeTravelApplication`'s much longer read-heavy transaction, making
 *   naive concurrent timing biased toward the OPPOSITE (non-buggy) ordering.
 *   So each defect below gets a DETERMINISTIC test that reconstructs the
 *   Packet's exact "可達序列" step by step (outer check passes → concurrent
 *   complete() commits fully → the vulnerable service function is then
 *   invoked) — reliably RED before the fix (the call would silently succeed)
 *   and reliably GREEN after (403, unmodified DB state). Each defect ALSO
 *   gets a genuine `Promise.allSettled` concurrency test (same style as
 *   `phase3-lifecycle-concurrent.test.ts`, real DB-level races via a real
 *   connection pool, no HTTP inject) that asserts INVARIANTS holding
 *   regardless of which side the real scheduler lets win — catching any
 *   fix that only handles the deterministic ordering but not true overlap.
 *
 * Test discipline (Spec §11.0 / Packet):
 *   - loginName prefix "p4cf_" + per-run random suffix.
 *   - FuelParameterVersion/EtcParameterVersion `effectiveFrom`：本檔獨佔
 *     2033 年（未被其他測試檔使用，見同目錄慣例 2030~2040）。
 *   - cleanup scoped to this suite's own tracked ids; never deleteMany({}).
 *   - synthetic data only.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertApplicationMutable } from "../../src/applications/application-state-machine.js";
import {
  completeTravelApplication,
  deleteApplication,
  getApplicationForAuth,
  getTravelApplication,
  updateTravelDraft,
} from "../../src/applications/travel-service.js";
import { deleteAttachment } from "../../src/attachment/lifecycle-service.js";
import type { CurrentUser } from "../../src/auth/middleware.js";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";
import type { Storage } from "../../src/storage/index.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// No-op Storage stub — every attachment this file creates is always LINKED
// (never TEMP), so `deleteAttachment`'s TEMP branch (the only branch that
// calls `storage.delete`) is never exercised here. A stub satisfies the
// type without needing a real filesystem root.
// ---------------------------------------------------------------------------

const noopStorage: Storage = {
  put: async () => {},
  get: async () => Buffer.alloc(0),
  delete: async () => {},
  exists: async () => false,
};

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
const LOGIN_PREFIX = "p4cf_";
const PASSWORD = "ConcurrencyFreeze99!";
const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;

// 2033：本檔獨佔年份（見檔頭說明），避免與其他檔案的 FuelParameterVersion/
// EtcParameterVersion 全域表 fixture 互相干擾。
const TRIP_DATE = "2033-05-15";

describeWithDb("PHASE-004-R4 — 已完成申請與附件的併發凍結（M-2/S-1）", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let ownerCookie: string;
  let ownerActor: CurrentUser;

  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];
  const createdFuelVersionIds: string[] = [];
  const createdEtcVersionIds: string[] = [];

  function track(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  async function createLinkedAttachment(segmentId: string) {
    const att = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `p4cf-synthetic-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
        mimeType: "image/jpeg",
        byteSize: 111,
        originalFilename: "synthetic.jpg",
        uploaderId: ownerId,
        ownerId: ownerId,
        refType: "TRIP_SEGMENT",
        refId: segmentId,
        linkedAt: new Date(),
      },
    });
    createdAttachmentIds.push(att.id);
    return att;
  }

  async function createParamVersionsOnce() {
    if (createdFuelVersionIds.length > 0) return; // idempotent — one set for the whole file
    const fuel = await prisma.fuelParameterVersion.create({
      data: {
        unitPrice: new Prisma.Decimal("3.5"),
        effectiveFrom: new Date("2033-01-01"),
        createdById: ownerId,
      },
    });
    const etc = await prisma.etcParameterVersion.create({
      data: {
        unitPrice: new Prisma.Decimal("1.2"),
        effectiveFrom: new Date("2033-01-01"),
        createdById: ownerId,
      },
    });
    createdFuelVersionIds.push(fuel.id);
    createdEtcVersionIds.push(etc.id);
  }

  async function createDraft(): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/travel",
      headers: { cookie: ownerCookie },
      payload: {},
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ application: { id: string } }>();
    return track(body.application.id);
  }

  async function putSegments(id: string, segments: Record<string, unknown>[]) {
    return app.inject({
      method: "PUT",
      url: `/applications/travel/${id}`,
      headers: { cookie: ownerCookie },
      payload: { segments },
    });
  }

  async function completeHttp(id: string) {
    return app.inject({
      method: "POST",
      url: `/applications/${id}/complete`,
      headers: { cookie: ownerCookie },
    });
  }

  /** Build a fully completable draft with exactly one segment + one LINKED attachment. */
  async function buildCompletableDraft(
    origin = "起點",
    destination = "終點",
    totalKm = "10",
    highwayKm = "5"
  ): Promise<{ applicationId: string; segmentId: string }> {
    await createParamVersionsOnce();
    const applicationId = await createDraft();
    const putResp = await putSegments(applicationId, [
      { origin, destination, totalKm, highwayKm, attachmentIds: [] },
    ]);
    expect(putResp.statusCode).toBe(200);
    const segmentId = putResp.json<{ application: { segments: { id: string }[] } }>().application
      .segments[0].id;
    await createLinkedAttachment(segmentId);
    const finalPut = await app.inject({
      method: "PUT",
      url: `/applications/travel/${applicationId}`,
      headers: { cookie: ownerCookie },
      payload: { tripDate: TRIP_DATE, purpose: "併發凍結測試出差目的" },
    });
    expect(finalPut.statusCode).toBe(200);
    return { applicationId, segmentId };
  }

  async function readSegment(segmentId: string) {
    return prisma.tripSegment.findUniqueOrThrow({
      where: { id: segmentId },
      select: { origin: true, destination: true, totalKm: true, highwayKm: true },
    });
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    const owner = await prisma.user.create({
      data: {
        loginName: OWNER_LOGIN,
        displayName: "P4CF 擁有人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    ownerId = owner.id;
    ownerActor = { id: ownerId, role: "USER", mustChangePassword: false, isActive: true };

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    ownerCookie = await loginUser(app, OWNER_LOGIN, PASSWORD);
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
      await prisma.attachment.deleteMany({ where: { ownerId } });
      if (createdFuelVersionIds.length > 0) {
        await prisma.fuelParameterVersion.deleteMany({
          where: { id: { in: createdFuelVersionIds } },
        });
      }
      if (createdEtcVersionIds.length > 0) {
        await prisma.etcParameterVersion.deleteMany({
          where: { id: { in: createdEtcVersionIds } },
        });
      }
      await prisma.session.deleteMany({ where: { userId: ownerId } });
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
  });

  // =========================================================================
  // M-2a — PUT /applications/travel/:id（updateTravelDraft）
  // =========================================================================

  describe("M-2a — updateTravelDraft 與並行 complete", () => {
    it("重現可達序列：外層檢查通過(DRAFT)後，並行的 complete 先提交，updateTravelDraft 自己的交易須拒絕（403）且段落未被改動", async () => {
      const { applicationId, segmentId } = await buildCompletableDraft(
        "M2a-起點",
        "M2a-終點",
        "10",
        "5"
      );
      const before = await readSegment(segmentId);

      // 步驟1：模擬 routes.ts PUT 端點的「交易外」檢查 —— 此刻讀到 DRAFT，通過。
      const outerRead = await getTravelApplication(prisma, applicationId);
      expect(outerRead?.status).toBe("DRAFT");
      expect(() => assertApplicationMutable(outerRead?.status ?? "COMPLETED")).not.toThrow();

      // 步驟2：並行的 complete 搶先完整提交（真實走 HTTP /complete 端點）。
      const completeRes = await completeHttp(applicationId);
      expect(completeRes.statusCode).toBe(200);

      // 步驟3：此刻才呼叫 updateTravelDraft 本體（模擬「外層檢查通過之後、
      // 這次寫入交易才真正開始」的攻擊時序）——修復前：沒有交易內狀態檢查，
      // 這裡會直接成功寫入（紅）；修復後：交易內重新讀到 COMPLETED，403（綠）。
      await expect(
        updateTravelDraft(prisma, applicationId, {}, [
          {
            id: segmentId,
            origin: "被併發改動的起點",
            destination: "被併發改動的終點",
            totalKm: new Prisma.Decimal("999"),
            highwayKm: new Prisma.Decimal("1"),
          },
        ])
      ).rejects.toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });

      // DB 逐欄斷言：段落欄位完全未被寫入。
      const after = await readSegment(segmentId);
      expect(after.origin).toBe(before.origin);
      expect(after.destination).toBe(before.destination);
      expect(after.totalKm?.toString()).toBe(before.totalKm?.toString());
      expect(after.highwayKm?.toString()).toBe(before.highwayKm?.toString());
    });

    it("真實併發（Promise.allSettled，服務層直呼，真實 DB 交易）：complete 與 updateTravelDraft 的結果必為互斥且自洽", async () => {
      const { applicationId, segmentId } = await buildCompletableDraft(
        "M2a-race-起點",
        "M2a-race-終點",
        "8",
        "3"
      );
      const before = await readSegment(segmentId);

      const [completeResult, putResult] = await Promise.allSettled([
        completeTravelApplication(prisma, applicationId),
        updateTravelDraft(prisma, applicationId, {}, [
          {
            id: segmentId,
            origin: "M2a-race-併發改動起點",
            destination: "M2a-race-併發改動終點",
            totalKm: new Prisma.Decimal("777"),
            highwayKm: new Prisma.Decimal("2"),
          },
        ]),
      ]);

      // complete 必定最終成功（草稿本身完全合法可完成；PUT 無論輸贏都不會讓
      // completionBlockers 重新出現，也不會改動 status —— 兩邊的重試迴圈都已
      // 認得真正的 Postgres 死結 40P01，見 travel-service.ts
      // `isRetryableTransactionConflict` 文件註解）。
      expect(completeResult.status).toBe("fulfilled");

      const finalApp = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect(finalApp.status).toBe("COMPLETED");

      if (putResult.status === "fulfilled") {
        // PUT 贏（在 complete 提交前就已完整寫入並提交）——合法時序，非 bug：
        // 段落應反映 PUT 寫入的新值。
        const after = await readSegment(segmentId);
        expect(after.origin).toBe("M2a-race-併發改動起點");
        expect(after.totalKm?.toString()).toBe("777");
      } else {
        // complete 贏——PUT 必須是乾淨的 403，且段落完全未被寫入（非部分寫入）。
        expect(putResult.reason).toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });
        const after = await readSegment(segmentId);
        expect(after.origin).toBe(before.origin);
        expect(after.totalKm?.toString()).toBe(before.totalKm?.toString());
      }
    });
  });

  // =========================================================================
  // M-2b — DELETE /applications/:id（deleteApplication）
  // =========================================================================

  describe("M-2b — deleteApplication 與並行 complete", () => {
    it("重現可達序列：外層檢查通過(DRAFT)後，並行的 complete 先提交，deleteApplication 自己的交易須拒絕（403）且申請仍存在", async () => {
      const { applicationId } = await buildCompletableDraft("M2b-起點", "M2b-終點", "12", "4");

      // 步驟1：模擬 routes.ts DELETE 端點的交易外檢查。
      const outerRead = await getApplicationForAuth(prisma, applicationId);
      expect(outerRead?.status).toBe("DRAFT");
      expect(() => assertApplicationMutable(outerRead?.status ?? "COMPLETED")).not.toThrow();

      // 步驟2：並行的 complete 搶先完整提交。
      const completeRes = await completeHttp(applicationId);
      expect(completeRes.statusCode).toBe(200);

      // 步驟3：此刻才呼叫 deleteApplication 本體。
      await expect(deleteApplication(prisma, applicationId)).rejects.toMatchObject({
        code: "FORBIDDEN",
        httpStatus: 403,
      });

      const stillExists = await prisma.application.findUnique({ where: { id: applicationId } });
      expect(stillExists).not.toBeNull();
      expect(stillExists?.status).toBe("COMPLETED");
    });

    it("真實併發（Promise.allSettled）：complete 與 deleteApplication 絕不會雙雙成功", async () => {
      const { applicationId } = await buildCompletableDraft(
        "M2b-race-起點",
        "M2b-race-終點",
        "6",
        "2"
      );

      const [completeResult, deleteResult] = await Promise.allSettled([
        completeTravelApplication(prisma, applicationId),
        deleteApplication(prisma, applicationId),
      ]);

      const bothSucceeded =
        completeResult.status === "fulfilled" && deleteResult.status === "fulfilled";
      expect(bothSucceeded).toBe(false);

      if (completeResult.status === "fulfilled" && deleteResult.status === "rejected") {
        expect(deleteResult.reason).toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });
        const stillExists = await prisma.application.findUnique({ where: { id: applicationId } });
        expect(stillExists).not.toBeNull();
        expect(stillExists?.status).toBe("COMPLETED");
      } else if (deleteResult.status === "fulfilled") {
        // 合法時序：DELETE 在 complete 提交前就已刪除草稿。
        const gone = await prisma.application.findUnique({ where: { id: applicationId } });
        expect(gone).toBeNull();
      }
    });
  });

  // =========================================================================
  // S-1 — DELETE /attachments/:id（deleteAttachment）
  // =========================================================================

  describe("S-1 — deleteAttachment 與並行 complete", () => {
    it("重現可達序列：推導檢查通過(draft)後，並行的 complete 先提交，deleteAttachment 自己的交易須拒絕（403）且附件仍 LINKED", async () => {
      const { applicationId, segmentId } = await buildCompletableDraft(
        "S1-起點",
        "S1-終點",
        "9",
        "3"
      );
      const attachment = await prisma.attachment.findFirstOrThrow({
        where: { refType: "TRIP_SEGMENT", refId: segmentId, status: "LINKED" },
      });

      // 步驟1：模擬 R4 修復前 routes.ts 的獨立 deriveContainerState 呼叫
      // （此刻用一次性、非交易的 prisma 讀取，確認為 'draft'）。
      // 修復後 deleteAttachment 內部不再信任這個外部推導結果，會在自己的
      // 交易內重新推導一次。
      const { deriveContainerState } = await import("../../src/attachment/lifecycle-service.js");
      const outerDerived = await deriveContainerState(prisma, attachment);
      expect(outerDerived).toBe("draft");

      // 步驟2：並行的 complete 搶先完整提交。
      const completeRes = await completeHttp(applicationId);
      expect(completeRes.statusCode).toBe(200);

      // 步驟3：此刻才呼叫 deleteAttachment 本體。
      await expect(
        deleteAttachment(prisma, noopStorage, { attachmentId: attachment.id, actor: ownerActor })
      ).rejects.toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });

      const after = await prisma.attachment.findUniqueOrThrow({ where: { id: attachment.id } });
      expect(after.status).toBe("LINKED");
      expect(after.refId).toBe(segmentId);
    });

    it("真實併發（Promise.allSettled）：complete 與 deleteAttachment 絕不會雙雙成功（附件被解除的同時申請也完成）", async () => {
      const { applicationId, segmentId } = await buildCompletableDraft(
        "S1-race-起點",
        "S1-race-終點",
        "7",
        "1"
      );
      const attachment = await prisma.attachment.findFirstOrThrow({
        where: { refType: "TRIP_SEGMENT", refId: segmentId, status: "LINKED" },
      });

      const [completeResult, deleteResult] = await Promise.allSettled([
        completeTravelApplication(prisma, applicationId),
        deleteAttachment(prisma, noopStorage, { attachmentId: attachment.id, actor: ownerActor }),
      ]);

      const bothSucceeded =
        completeResult.status === "fulfilled" && deleteResult.status === "fulfilled";
      expect(bothSucceeded).toBe(false);

      if (completeResult.status === "fulfilled" && deleteResult.status === "rejected") {
        expect(deleteResult.reason).toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });
        const after = await prisma.attachment.findUniqueOrThrow({ where: { id: attachment.id } });
        expect(after.status).toBe("LINKED");
      } else if (deleteResult.status === "fulfilled") {
        // 合法時序：附件在 complete 提交前就已被解除關聯（TEMP）。
        const after = await prisma.attachment.findUniqueOrThrow({ where: { id: attachment.id } });
        expect(after.status).toBe("TEMP");
      }
    });
  });
});
