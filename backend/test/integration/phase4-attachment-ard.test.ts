/**
 * Integration tests for PHASE-004-T11 — AR-D 閉環鑑別力測試（最高優先）
 *
 * This file is the DISCRIMINATING test suite for D12/AR-D: it proves that the
 * specific bypasses the old `POST /attachments/:id/link` endpoint allowed are
 * now IMPOSSIBLE, not merely "the endpoint returns a different status". Each
 * test here is written so that reverting the AR-D fix (re-adding the link
 * route, or making `DELETE /attachments/:id` read a client-supplied
 * `containerState` again) would turn it red.
 *
 * Division of labor with the migrated `phase3-lifecycle.test.ts` (both files'
 * coverage is complementary, not duplicated — see PHASE-004-T11 Task
 * Handoff's mapping table):
 *   - `phase3-lifecycle.test.ts`: migrated PHASE-003-T6 behavior (owner-403,
 *     limit-409, duplicate-link-409, real-completed-403, etc.) — the POSITIVE
 *     behavior specs, now driven through `PUT .../attachmentIds`.
 *   - THIS FILE: the NEGATIVE/discriminating proof that the old client-side
 *     bypass vectors (self-supplied `limit`, self-supplied `containerState`,
 *     the link endpoint itself) are gone — plus D11 (`ownerId`) coverage and
 *     an AC-28 regression check.
 *   - B-30/D19 concurrency: BOTH files contain a version (裁定 allows "可以
 *     增加" and explicitly names B-30 as this file's required content too).
 *     Per Spec §17 D19 (PHASE-004-T11R2, 使用者 2026-08-02 批准), concurrent
 *     full-PUT requests each declaring a valid attachment set both succeed
 *     ("last writer wins") — `phase3-lifecycle.test.ts`'s version asserts the
 *     AGGREGATE invariant (final LINKED count never exceeds the cap); THIS
 *     file's version additionally asserts CONTENT consistency (the final
 *     LINKED set is exactly the fillers plus ONE of the two race
 *     participants — not both, not neither) — not pure duplication, a
 *     stronger variant catching silent data loss that a count-only check
 *     would miss.
 *
 * AC covered: AC-27 (a/b/c/d — AR-D), AC-28 (regression), AC-29 (D11 ownerId),
 * B-30 (concurrency), AC-08(b) (PHASE-009-T4b addendum, below — VOIDED was
 * mis-derived as 'draft' by `deriveContainerState`'s three refType branches;
 * see that function's own doc comment for the fix).
 *
 * Test discipline (Spec §11.0 / Packet):
 *   - loginName prefix "p4ard_" + per-run random suffix.
 *   - cleanup scoped to this suite's own created ids; no deleteMany({}).
 *   - synthetic data only.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { voidApplication } from "../../src/applications/application-void.js";
import { SEGMENT_ATTACHMENT_LIMIT } from "../../src/applications/travel-service.js";
import { buildMinimalHeader } from "../../src/attachment/detect-mime.js";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p4ard_";
const PASSWORD = "AttachmentArdTest99!";

function makeJpegBytes(size = 200): Buffer {
  const buf = Buffer.alloc(size, 0xaa);
  const header = buildMinimalHeader("image/jpeg", 12);
  header.copy(buf);
  return buf;
}

function buildMultipartBody(
  filename: string,
  content: Buffer,
  fieldname = "file"
): { body: Buffer; contentType: string } {
  const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const CRLF = "\r\n";
  const header = `--${boundary}${CRLF}Content-Disposition: form-data; name="${fieldname}"; filename="${filename}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`;
  const footer = `${CRLF}--${boundary}--${CRLF}`;
  const body = Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function makeTempStorageRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "phase4-attachment-ard-test-"));
}

function removeTempStorageRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Best-effort
  }
}

describeWithDb("PHASE-004-T11 — AR-D 閉環鑑別力測試", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let storageRoot: string;

  const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
  const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
  const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;
  const INACTIVE_LOGIN = `${LOGIN_PREFIX}inactive_${RUN_ID}`;

  let ownerId: string;
  let otherId: string;
  let inactiveId: string;

  let ownerCookie: string;
  let otherCookie: string;
  let adminCookie: string;

  const createdAttachmentIds: string[] = [];
  const createdApplicationIds: string[] = [];

  async function login(loginName: string, password: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ loginName, password }),
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? "");
    const match = cookieStr.match(/^sid=([^;]+)/);
    if (!match) throw new Error(`No sid cookie for ${loginName}`);
    return `sid=${match[1]}`;
  }

  beforeAll(async () => {
    if (!DB_URL) return;

    storageRoot = makeTempStorageRoot();
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    const owner = await prisma.user.create({
      data: {
        loginName: OWNER_LOGIN,
        displayName: "ARD Owner",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });
    ownerId = owner.id;

    const other = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "ARD Other",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });
    otherId = other.id;

    await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "ARD Admin",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
        role: "ADMIN",
      },
    });

    const inactive = await prisma.user.create({
      data: {
        loginName: INACTIVE_LOGIN,
        displayName: "ARD Inactive",
        passwordHash: hash,
        isActive: false,
        mustChangePassword: false,
      },
    });
    inactiveId = inactive.id;

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error", storageRoot });
    await app.ready();

    ownerCookie = await login(OWNER_LOGIN, PASSWORD);
    otherCookie = await login(OTHER_LOGIN, PASSWORD);
    adminCookie = await login(ADMIN_LOGIN, PASSWORD);
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
      await prisma.attachment.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } });
      const userIds = [ownerId, otherId, inactiveId].filter(Boolean);
      if (userIds.length > 0) {
        await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      }
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
    if (storageRoot) removeTempStorageRoot(storageRoot);
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function uploadAs(
    cookie: string,
    filename: string,
    ownerIdParam?: string
  ): Promise<string> {
    const { body, contentType } = buildMultipartBody(filename, makeJpegBytes());
    const url = ownerIdParam ? `/attachments?ownerId=${ownerIdParam}` : "/attachments";
    const res = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": contentType, cookie },
      payload: body,
    });
    return res.statusCode === 201
      ? (() => {
          const { attachment } = JSON.parse(res.body);
          createdAttachmentIds.push(attachment.id);
          return attachment.id as string;
        })()
      : (() => {
          throw new Error(`Upload failed: ${res.statusCode} ${res.body}`);
        })();
  }

  async function createDraftWithSegment(cookie: string): Promise<{
    applicationId: string;
    segmentId: string;
  }> {
    const createResp = await app.inject({
      method: "POST",
      url: "/applications/travel",
      headers: { cookie },
      payload: {},
    });
    expect(createResp.statusCode).toBe(201);
    const applicationId = JSON.parse(createResp.body).application.id as string;
    createdApplicationIds.push(applicationId);

    const putResp = await app.inject({
      method: "PUT",
      url: `/applications/travel/${applicationId}`,
      headers: { cookie },
      payload: { segments: [{ origin: "起點", destination: "終點" }] },
    });
    expect(putResp.statusCode).toBe(200);
    const segmentId = JSON.parse(putResp.body).application.segments[0].id as string;
    return { applicationId, segmentId };
  }

  async function putDraft(
    cookie: string,
    applicationId: string,
    segments: Record<string, unknown>[]
  ) {
    return app.inject({
      method: "PUT",
      url: `/applications/travel/${applicationId}`,
      headers: { cookie },
      payload: { segments },
    });
  }

  async function markCompleted(applicationId: string): Promise<void> {
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: "COMPLETED", completedAt: new Date(), totalAmount: 1 },
    });
  }

  async function linkViaPut(
    cookie: string,
    applicationId: string,
    segmentId: string,
    attachmentId: string
  ): Promise<void> {
    const res = await putDraft(cookie, applicationId, [
      { id: segmentId, attachmentIds: [attachmentId] },
    ]);
    expect(res.statusCode).toBe(200);
  }

  // ---------------------------------------------------------------------------
  // PHASE-009-T4b helpers (AC-08(b))
  // ---------------------------------------------------------------------------

  /**
   * Directly create a COMPLETED `Application` row (bypassing the full
   * create/PUT/complete round-trip) — `deriveContainerState`'s MAINTENANCE/
   * DEPRECIATION branches only ever read `Application.status`, no child-table
   * join needed. Mirrors `phase6-maintenance-attachment.test.ts`'s synthetic-row pattern.
   */
  async function createCompletedApplication(
    type: "MAINTENANCE" | "DEPRECIATION",
    forOwnerId: string
  ): Promise<string> {
    const app_ = await prisma.application.create({
      data: {
        type,
        status: "COMPLETED",
        ownerId: forOwnerId,
        createdById: forOwnerId,
        primaryDate: new Date("2026-01-01"),
        totalAmount: 100,
        completedAt: new Date(),
      },
    });
    createdApplicationIds.push(app_.id);
    return app_.id;
  }

  /** Directly create a LINKED attachment under the given refType/refId (no upload round-trip). */
  async function createLinkedAttachment(
    refType: "TRIP_SEGMENT" | "MAINTENANCE" | "DEPRECIATION",
    refId: string,
    forOwnerId: string,
    filename: string
  ): Promise<string> {
    const att = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `p4ard-t4b-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
        mimeType: "image/jpeg",
        byteSize: 100,
        originalFilename: filename,
        uploaderId: forOwnerId,
        ownerId: forOwnerId,
        refType,
        refId,
        linkedAt: new Date(),
      },
    });
    createdAttachmentIds.push(att.id);
    return att.id;
  }

  const VOID_REASON = "PHASE-009-T4b 測試作廢原因";

  // ===========================================================================
  // AC-27c — 公開 link 端點移除
  // ===========================================================================

  describe("AC-27c — POST /attachments/:id/link 已移除", () => {
    it("POST /attachments/:id/link → 404（端點不存在）", async () => {
      const attId = await uploadAs(ownerCookie, "removed-link.jpg");
      const res = await app.inject({
        method: "POST",
        url: `/attachments/${attId}/link`,
        headers: { "content-type": "application/json", cookie: ownerCookie },
        payload: JSON.stringify({ refType: "TRIP_SEGMENT", refId: "whatever", limit: 999 }),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ===========================================================================
  // AC-22 — client 帶 limit=999 無法突破後端固定上限（3 張）
  // ===========================================================================

  describe("AC-22 — client 帶 limit 無法突破後端上限", () => {
    it("段落已滿 3 張；PUT 於 segment 物件與頂層皆夾帶 limit=999 → 第 4 張仍 409 TOO_MANY_ATTACHMENTS", async () => {
      const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
      const three = [
        await uploadAs(ownerCookie, "climit-1.jpg"),
        await uploadAs(ownerCookie, "climit-2.jpg"),
        await uploadAs(ownerCookie, "climit-3.jpg"),
      ];
      const fillRes = await putDraft(ownerCookie, applicationId, [
        { id: segmentId, attachmentIds: three },
      ]);
      expect(fillRes.statusCode).toBe(200);

      const fourth = await uploadAs(ownerCookie, "climit-4.jpg");
      // Client attempts to smuggle a `limit` override both on the segment
      // object and as a top-level body field — parseSegmentsInput only ever
      // reads `attachmentIds` off the segment object, and the route only
      // ever reads `segments` off the top-level body, so neither `limit`
      // value reaches `linkAttachmentTx` (SEGMENT_ATTACHMENT_LIMIT=3 is the
      // only value that can, per travel-service.ts).
      const res = await app.inject({
        method: "PUT",
        url: `/applications/travel/${applicationId}`,
        headers: { cookie: ownerCookie },
        payload: {
          limit: 999,
          segments: [{ id: segmentId, attachmentIds: [...three, fourth], limit: 999 }],
        },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error.code).toBe("TOO_MANY_ATTACHMENTS");

      const linkedCount = await prisma.attachment.count({
        where: { refType: "TRIP_SEGMENT", refId: segmentId, status: "LINKED" },
      });
      expect(linkedCount).toBe(SEGMENT_ATTACHMENT_LIMIT);
      const fourthRow = await prisma.attachment.findUnique({ where: { id: fourth } });
      expect(fourthRow?.status).toBe("TEMP");
    });
  });

  // ===========================================================================
  // AC-27a/b/d — containerState 由後端推導，client 參數完全無效（雙方向 × query/body）
  // ===========================================================================

  describe("AC-27a/b/d — containerState 由後端推導，client 參數無效", () => {
    it("已完成申請的附件 + query containerState=draft → 仍 403（client 無法宣稱 draft 繞過鎖定）", async () => {
      const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
      const attId = await uploadAs(ownerCookie, "completed-query-draft.jpg");
      await linkViaPut(ownerCookie, applicationId, segmentId, attId);
      await markCompleted(applicationId);

      const res = await app.inject({
        method: "DELETE",
        url: `/attachments/${attId}?containerState=draft`,
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");

      const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
      expect(dbAtt?.status).toBe("LINKED");
    });

    it("草稿附件 + query containerState=completed → 仍 200 成功（client 無法宣稱 completed 觸發誤判鎖定）", async () => {
      const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
      const attId = await uploadAs(ownerCookie, "draft-query-completed.jpg");
      await linkViaPut(ownerCookie, applicationId, segmentId, attId);
      // application remains DRAFT (never completed)

      const res = await app.inject({
        method: "DELETE",
        url: `/attachments/${attId}?containerState=completed`,
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toHaveProperty("ok", true);

      const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
      expect(dbAtt?.status).toBe("TEMP"); // detached successfully — draft container correctly mutable
    });

    it("已完成申請的附件 + BODY containerState=draft → 仍 403（body 版）", async () => {
      const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
      const attId = await uploadAs(ownerCookie, "completed-body-draft.jpg");
      await linkViaPut(ownerCookie, applicationId, segmentId, attId);
      await markCompleted(applicationId);

      const res = await app.inject({
        method: "DELETE",
        url: `/attachments/${attId}`,
        headers: { "content-type": "application/json", cookie: ownerCookie },
        payload: JSON.stringify({ containerState: "draft" }),
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");

      const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
      expect(dbAtt?.status).toBe("LINKED");
    });

    it("草稿附件 + BODY containerState=completed → 仍 200 成功（body 版）", async () => {
      const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
      const attId = await uploadAs(ownerCookie, "draft-body-completed.jpg");
      await linkViaPut(ownerCookie, applicationId, segmentId, attId);

      const res = await app.inject({
        method: "DELETE",
        url: `/attachments/${attId}`,
        headers: { "content-type": "application/json", cookie: ownerCookie },
        payload: JSON.stringify({ containerState: "completed" }),
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toHaveProperty("ok", true);

      const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
      expect(dbAtt?.status).toBe("TEMP");
    });

    it("孤兒附件（refId 指向已不存在的段落）→ DELETE 不得 500，視為 draft 成功解除", async () => {
      // Synthetic orphan: directly create a LINKED attachment whose refId
      // points at a TripSegment id that was never created (or has since been
      // deleted). This exercises deriveContainerState's defensive branch —
      // normal application flow (segment delete detaches first) never
      // produces this state, but the AR-D derivation must not 500 on it.
      const orphan = await prisma.attachment.create({
        data: {
          status: "LINKED",
          storageKey: `p4ard-orphan-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
          mimeType: "image/jpeg",
          byteSize: 100,
          originalFilename: "orphan.jpg",
          uploaderId: ownerId,
          ownerId: ownerId,
          refType: "TRIP_SEGMENT",
          refId: "p4ard-nonexistent-segment-id",
          linkedAt: new Date(),
        },
      });
      createdAttachmentIds.push(orphan.id);

      const res = await app.inject({
        method: "DELETE",
        url: `/attachments/${orphan.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toHaveProperty("ok", true);

      const dbAtt = await prisma.attachment.findUnique({ where: { id: orphan.id } });
      expect(dbAtt?.status).toBe("TEMP");
    });
  });

  // ===========================================================================
  // AC-29 — POST /attachments 的 ownerId（D11）
  // ===========================================================================

  describe("AC-29 — POST /attachments 之 ownerId（D11）", () => {
    it("省略 ownerId → owner=uploader=呼叫者本人", async () => {
      const attId = await uploadAs(ownerCookie, "owner-omitted.jpg");
      const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
      expect(dbAtt?.ownerId).toBe(ownerId);
      expect(dbAtt?.uploaderId).toBe(ownerId);
    });

    it("帶自身 ownerId → 允許，owner=uploader=呼叫者本人", async () => {
      const attId = await uploadAs(ownerCookie, "owner-self.jpg", ownerId);
      const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
      expect(dbAtt?.ownerId).toBe(ownerId);
      expect(dbAtt?.uploaderId).toBe(ownerId);
    });

    it("非 ADMIN 帶他人 ownerId → 403 FORBIDDEN，不建立附件", async () => {
      const { body, contentType } = buildMultipartBody(
        "owner-other-forbidden.jpg",
        makeJpegBytes()
      );
      const res = await app.inject({
        method: "POST",
        url: `/attachments?ownerId=${otherId}`,
        headers: { "content-type": contentType, cookie: ownerCookie },
        payload: body,
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");
    });

    it("ADMIN 帶他人 ownerId → 200，ownerId=該他人、uploaderId=管理員（owner/uploader 分離）", async () => {
      const attId = await uploadAs(adminCookie, "owner-admin-onbehalf.jpg", otherId);
      const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
      expect(dbAtt?.ownerId).toBe(otherId);
      expect(dbAtt?.uploaderId).not.toBe(otherId);
    });

    it("ownerId 指向不存在的使用者（ADMIN 呼叫）→ 404 NOT_FOUND", async () => {
      const { body, contentType } = buildMultipartBody("owner-nonexistent.jpg", makeJpegBytes());
      const res = await app.inject({
        method: "POST",
        url: "/attachments?ownerId=p4ard-nonexistent-user-id",
        headers: { "content-type": contentType, cookie: adminCookie },
        payload: body,
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe("NOT_FOUND");
    });

    it("ownerId 指向已停用的使用者（ADMIN 呼叫）→ 400 VALIDATION_ERROR", async () => {
      const { body, contentType } = buildMultipartBody("owner-inactive.jpg", makeJpegBytes());
      const res = await app.inject({
        method: "POST",
        url: `/attachments?ownerId=${inactiveId}`,
        headers: { "content-type": contentType, cookie: adminCookie },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe("VALIDATION_ERROR");
    });

    // T10R-LITE 殘留缺陷（SF-2）：`?ownerId=A&ownerId=B` 重複 query 鍵，Fastify
    // 執行期型別為 `string[]`，非本端點原本假設的 `string | undefined`——沿用
    // mileage/routes.ts `assertScalarQueryParams`／application-query.ts
    // `resolveOwnerId` 之既有收斂慣例：非字串一律 400 VALIDATION_ERROR，
    // 而非讓陣列值流入 Prisma `findUnique` 造成未預期 500。
    it("ADMIN 帶重複 ownerId（陣列）→ 400 VALIDATION_ERROR，不得 500", async () => {
      const { body, contentType } = buildMultipartBody("owner-dup-admin.jpg", makeJpegBytes());
      const res = await app.inject({
        method: "POST",
        url: `/attachments?ownerId=${ownerId}&ownerId=${otherId}`,
        headers: { "content-type": contentType, cookie: adminCookie },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe("VALIDATION_ERROR");
    });

    it("非 ADMIN 帶重複 ownerId（陣列）→ 403 FORBIDDEN（fail-closed 行為不變）", async () => {
      const { body, contentType } = buildMultipartBody("owner-dup-nonadmin.jpg", makeJpegBytes());
      const res = await app.inject({
        method: "POST",
        url: `/attachments?ownerId=${ownerId}&ownerId=${otherId}`,
        headers: { "content-type": contentType, cookie: ownerCookie },
        payload: body,
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");
    });
  });

  // ===========================================================================
  // AC-28 — 附件授權隔離（回歸確認，沿用 PHASE-003 行為）
  // ===========================================================================

  describe("AC-28 — 附件授權隔離（回歸）", () => {
    it("他人請求 content/thumbnail → 403，不回傳任何位元組", async () => {
      const attId = await uploadAs(ownerCookie, "isolation-content.jpg");
      const contentRes = await app.inject({
        method: "GET",
        url: `/attachments/${attId}/content`,
        headers: { cookie: otherCookie },
      });
      expect(contentRes.statusCode).toBe(403);
      const thumbRes = await app.inject({
        method: "GET",
        url: `/attachments/${attId}/thumbnail`,
        headers: { cookie: otherCookie },
      });
      expect(thumbRes.statusCode).toBe(403);
    });

    it("管理員請求 content/thumbnail → 200", async () => {
      const attId = await uploadAs(ownerCookie, "isolation-admin.jpg");
      const contentRes = await app.inject({
        method: "GET",
        url: `/attachments/${attId}/content`,
        headers: { cookie: adminCookie },
      });
      expect(contentRes.statusCode).toBe(200);
    });

    it("未登入請求 content → 401", async () => {
      const attId = await uploadAs(ownerCookie, "isolation-unauth.jpg");
      const res = await app.inject({
        method: "GET",
        url: `/attachments/${attId}/content`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ===========================================================================
  // B-30 — 併發整份 PUT 對同一段落：最後寫入者贏，且總數不超過上限
  //
  // PHASE-004-T11R2（Spec §17 D19，使用者 2026-08-02 批准）：本測試原斷言
  // 「一成一敗」，前提是把此race當成「增量 link 打 limit 容器」——但這裡打的
  // 是整份取代式 PUT（D15），兩個併發請求各自宣告的都是合法（未超上限）的
  // 完整集合，依 D19「最後寫入者贏」，兩者皆應回 200，且該段最終 LINKED
  // 數量恆等於後手宣告的數量、不超過 `SEGMENT_ATTACHMENT_LIMIT`。
  //
  // 本檔與 `phase3-lifecycle.test.ts` 的 B-30 測試分工：該檔驗證「總數」
  // （aggregate count）；本測試額外驗證「內容一致性」——最終 LINKED 集合必須
  // 恰為 fillers ∪ {attA 或 attB 其中之一}，不得兩者都在、也不得兩者都不在
  // （後者代表兩個請求互相蓋掉了對方，是比「超過上限」更隱蔽的資料遺失缺陷）。
  // ===========================================================================

  describe("B-30 — 併發整份 PUT 對同一段落：最後寫入者贏，總數不超過上限（D19）", () => {
    it("兩個併發整份 PUT 皆回 200，最終 LINKED 集合恰為 fillers + 其中一方的宣告", async () => {
      const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
      const filler: string[] = [];
      for (let i = 0; i < SEGMENT_ATTACHMENT_LIMIT - 1; i++) {
        filler.push(await uploadAs(ownerCookie, `b30-filler-${i}.jpg`));
      }
      const fillRes = await putDraft(ownerCookie, applicationId, [
        { id: segmentId, attachmentIds: filler },
      ]);
      expect(fillRes.statusCode).toBe(200);

      const attA = await uploadAs(ownerCookie, "b30-race-a.jpg");
      const attB = await uploadAs(ownerCookie, "b30-race-b.jpg");

      const [resA, resB] = await Promise.all([
        putDraft(ownerCookie, applicationId, [{ id: segmentId, attachmentIds: [...filler, attA] }]),
        putDraft(ownerCookie, applicationId, [{ id: segmentId, attachmentIds: [...filler, attB] }]),
      ]);

      expect([resA.statusCode, resB.statusCode]).toEqual([200, 200]);

      const linkedRows = await prisma.attachment.findMany({
        where: { refType: "TRIP_SEGMENT", refId: segmentId, status: "LINKED" },
        select: { id: true },
      });
      expect(linkedRows).toHaveLength(SEGMENT_ATTACHMENT_LIMIT);

      const linkedIds = new Set(linkedRows.map((r) => r.id));
      for (const f of filler) {
        expect(linkedIds.has(f)).toBe(true);
      }
      const raceWinnerIsA = linkedIds.has(attA);
      const raceWinnerIsB = linkedIds.has(attB);
      // Exactly one of the two race participants ended up LINKED — not both
      // (would mean the cap was exceeded, the OLD B-30 bug) and not neither
      // (would mean both requests silently lost their own write).
      expect(raceWinnerIsA !== raceWinnerIsB).toBe(true);
    });
  });

  // ===========================================================================
  // AC-08(b) — VOIDED 申請之附件鎖定（PHASE-009-T4b；deriveContainerState 三
  // 個 refType 分支）
  //
  // Pre-fix RED evidence (all three cases, before the fix): expected 200 to
  // be 403 — captured by temporarily reverting the fix in
  // `lifecycle-service.ts` and re-running this block; recorded in the Task
  // Handoff.
  //
  // Write-face parity（「PUT/重上傳等寫入面同等」）: attachment add via
  // `PUT .../attachmentIds` does NOT go through `deriveContainerState` — it's
  // gated by `assertApplicationMutable(existing.status)`, already exercised
  // for VOIDED (body-embedded `attachmentIds`/`segments`) by T3's AC-08(a)
  // suite (`phase9-void.test.ts`, Files Forbidden here). No duplicate PUT
  // test added; the standalone `DELETE /attachments/:id` endpoint (fixed
  // below) is the ONLY gap this Task closes.
  // ===========================================================================

  describe("AC-08(b) — VOIDED 申請之附件鎖定（三個 refType 分支）", () => {
    it("TRIP_SEGMENT：已作廢申請之附件 DELETE → 403，附件仍 LINKED（零寫入）", async () => {
      const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
      const attId = await uploadAs(ownerCookie, "voided-trip-segment.jpg");
      await linkViaPut(ownerCookie, applicationId, segmentId, attId);
      await markCompleted(applicationId);
      await voidApplication(prisma, applicationId, VOID_REASON, ownerId);

      const res = await app.inject({
        method: "DELETE",
        url: `/attachments/${attId}`,
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");

      const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
      expect(dbAtt?.status).toBe("LINKED");
      expect(dbAtt?.refType).toBe("TRIP_SEGMENT");
      expect(dbAtt?.refId).toBe(segmentId);
    });

    it("MAINTENANCE：已作廢申請之附件 DELETE → 403，附件仍 LINKED（零寫入）", async () => {
      const applicationId = await createCompletedApplication("MAINTENANCE", ownerId);
      const attId = await createLinkedAttachment(
        "MAINTENANCE",
        applicationId,
        ownerId,
        "voided-maintenance.jpg"
      );
      await voidApplication(prisma, applicationId, VOID_REASON, ownerId);

      const res = await app.inject({
        method: "DELETE",
        url: `/attachments/${attId}`,
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");

      const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
      expect(dbAtt?.status).toBe("LINKED");
      expect(dbAtt?.refType).toBe("MAINTENANCE");
      expect(dbAtt?.refId).toBe(applicationId);
    });

    it("DEPRECIATION：已作廢申請之附件 DELETE → 403，附件仍 LINKED（零寫入）", async () => {
      const applicationId = await createCompletedApplication("DEPRECIATION", ownerId);
      const attId = await createLinkedAttachment(
        "DEPRECIATION",
        applicationId,
        ownerId,
        "voided-depreciation.jpg"
      );
      await voidApplication(prisma, applicationId, VOID_REASON, ownerId);

      const res = await app.inject({
        method: "DELETE",
        url: `/attachments/${attId}`,
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");

      const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
      expect(dbAtt?.status).toBe("LINKED");
      expect(dbAtt?.refType).toBe("DEPRECIATION");
      expect(dbAtt?.refId).toBe(applicationId);
    });
  });
});
