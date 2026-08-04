/**
 * Integration tests for PHASE-006-T6:
 *   保養附件——上限 5、`attachmentIds[]` 對帳、完成鎖定
 *   （`deriveContainerState` MAINTENANCE 分支擴充）、草稿刪除 detach 補洞
 *   （B-29）、授權存取（AC-24）。
 *
 * AC covered (PHASE-006 Spec §2): AC-21, AC-22, AC-23, AC-24;
 * B-25~B-30（B-30 之併發恰一成功屬 T8/T7 範圍，本檔僅涵蓋 B-25~B-29 之單執行緒行為）。
 *
 * Test discipline (Spec §11.0 / Packet):
 *   - loginName prefix "p6t6_" + per-run random suffix.
 *   - cleanup scoped to this suite's own tracked application/attachment ids +
 *     loginName prefix; NEVER deleteMany({}) globally.
 *   - synthetic data only.
 *
 * Pre-fix RED evidence (AC-23 / B-29, Spec §17.1 ★ items, Done When):
 *   Before this Task's fix, `deriveContainerState`'s MAINTENANCE branch
 *   unconditionally returned 'draft' (PHASE-003-era placeholder), and
 *   `deleteApplication` only detached TRIP_SEGMENT attachments. The captured
 *   RED output for both is recorded verbatim in the Task Handoff (§Test
 *   Results) — reproduced by temporarily reverting those two hunks and
 *   re-running this file's "pre-fix RED evidence" cases, then restoring the
 *   fix. Those two cases below still exist as permanent regression guards:
 *   they assert the FIXED (post-repair) behavior, so a future regression
 *   that resurrects either bug fails them again.
 */
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

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
const LOGIN_PREFIX = "p6t6_";
const PASSWORD = "MaintenanceAttachmentTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;

describeWithDb("PHASE-006-T6 — 保養附件：上限 5 + attachmentIds 對帳 + 完成鎖定 + 授權", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let otherId: string;
  let adminId: string;

  let ownerCookie: string;
  let otherCookie: string;
  let adminCookie: string;

  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  function trackApp(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }
  function trackAttachment(id: string): string {
    createdAttachmentIds.push(id);
    return id;
  }

  async function createOwnerDraft(payload: Record<string, unknown> = {}) {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/maintenance",
      headers: { cookie: ownerCookie },
      payload,
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ application: Record<string, unknown> & { id: string } }>();
    trackApp(body.application.id);
    return body.application;
  }

  async function putDraft(cookie: string, id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/applications/maintenance/${id}`,
      headers: { cookie },
      payload,
    });
  }

  async function markCompleted(applicationId: string, totalAmount = 5000) {
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: "COMPLETED", completedAt: new Date(), totalAmount },
    });
  }

  /** Directly create a LINKED attachment under refType=MAINTENANCE (no upload round-trip needed). */
  async function createLinkedMaintenanceAttachment(applicationId: string, forOwnerId: string) {
    const att = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `p6t6-synthetic-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
        mimeType: "image/jpeg",
        byteSize: 123,
        originalFilename: "synthetic.jpg",
        uploaderId: forOwnerId,
        ownerId: forOwnerId,
        refType: "MAINTENANCE",
        refId: applicationId,
        linkedAt: new Date(),
      },
    });
    trackAttachment(att.id);
    return att;
  }

  function buildMultipartBody(
    filename: string,
    content: Buffer
  ): { body: Buffer; contentType: string } {
    const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
    const CRLF = "\r\n";
    const header = `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`;
    const footer = `${CRLF}--${boundary}--${CRLF}`;
    return {
      body: Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  function makeJpegBytes(size = 64): Buffer {
    // Minimal legal JPEG magic header + padding (synthetic fixture, no real image).
    const buf = Buffer.alloc(size, 0xaa);
    buf[0] = 0xff;
    buf[1] = 0xd8;
    buf[2] = 0xff;
    return buf;
  }

  /** Real TEMP upload via POST /attachments (needed for real TEMP→LINKED transitions). */
  async function uploadTemp(cookie: string, filename: string): Promise<string> {
    const { body, contentType } = buildMultipartBody(filename, makeJpegBytes());
    const resp = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { cookie, "content-type": contentType },
      payload: body,
    });
    expect(resp.statusCode).toBe(201);
    const id = resp.json<{ attachment: { id: string } }>().attachment.id;
    trackAttachment(id);
    return id;
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);

    const owner = await prisma.user.create({
      data: {
        loginName: OWNER_LOGIN,
        displayName: "P6T6 擁有人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const other = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "P6T6 他人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "P6T6 管理員",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });

    ownerId = owner.id;
    otherId = other.id;
    adminId = admin.id;

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    ownerCookie = await loginUser(app, OWNER_LOGIN, PASSWORD);
    otherCookie = await loginUser(app, OTHER_LOGIN, PASSWORD);
    adminCookie = await loginUser(app, ADMIN_LOGIN, PASSWORD);
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
      const userIds = [ownerId, otherId, adminId].filter(Boolean);
      if (userIds.length > 0) {
        await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      }
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
  });

  // ===========================================================================
  // AC-21 — 上限 5
  // ===========================================================================

  describe("AC-21 上限 5", () => {
    it("恰 5 張可儲存（boundary positive）", async () => {
      const draft = await createOwnerDraft({});
      const ids = [
        await uploadTemp(ownerCookie, "a1.jpg"),
        await uploadTemp(ownerCookie, "a2.jpg"),
        await uploadTemp(ownerCookie, "a3.jpg"),
        await uploadTemp(ownerCookie, "a4.jpg"),
        await uploadTemp(ownerCookie, "a5.jpg"),
      ];
      const resp = await putDraft(ownerCookie, draft.id as string, { attachmentIds: ids });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: { attachments: { id: string }[] } }>();
      expect(body.application.attachments.map((a) => a.id).sort()).toEqual([...ids].sort());
    });

    it("linking a 6th attachment on top of 5 existing returns 409 TOO_MANY_ATTACHMENTS and rolls the whole PUT back (business fields unchanged)", async () => {
      const draft = await createOwnerDraft({ actualCost: "100.00" });
      const five = [
        await uploadTemp(ownerCookie, "b1.jpg"),
        await uploadTemp(ownerCookie, "b2.jpg"),
        await uploadTemp(ownerCookie, "b3.jpg"),
        await uploadTemp(ownerCookie, "b4.jpg"),
        await uploadTemp(ownerCookie, "b5.jpg"),
      ];
      const fillResp = await putDraft(ownerCookie, draft.id as string, { attachmentIds: five });
      expect(fillResp.statusCode).toBe(200);

      const sixth = await uploadTemp(ownerCookie, "b6.jpg");
      const resp = await putDraft(ownerCookie, draft.id as string, {
        attachmentIds: [...five, sixth],
        actualCost: "999.00", // business field carried in the SAME PUT — must also roll back
      });
      expect(resp.statusCode).toBe(409);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("TOO_MANY_ATTACHMENTS");

      // DB unchanged: still exactly 5 LINKED, actualCost still 100.00 (not 999.00)
      const linked = await prisma.attachment.count({
        where: { refType: "MAINTENANCE", refId: draft.id as string, status: "LINKED" },
      });
      expect(linked).toBe(5);
      const row = await prisma.maintenanceApplication.findUnique({
        where: { applicationId: draft.id as string },
      });
      expect(row?.actualCost?.toFixed(2)).toBe("100.00");
    });

    it("B-26: a single PUT declaring 6 brand-new ids is rejected (409), rolls back entirely", async () => {
      const draft = await createOwnerDraft({});
      const six = [
        await uploadTemp(ownerCookie, "c1.jpg"),
        await uploadTemp(ownerCookie, "c2.jpg"),
        await uploadTemp(ownerCookie, "c3.jpg"),
        await uploadTemp(ownerCookie, "c4.jpg"),
        await uploadTemp(ownerCookie, "c5.jpg"),
        await uploadTemp(ownerCookie, "c6.jpg"),
      ];
      const resp = await putDraft(ownerCookie, draft.id as string, { attachmentIds: six });
      expect(resp.statusCode).toBe(409);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("TOO_MANY_ATTACHMENTS");

      const linked = await prisma.attachment.count({
        where: { refType: "MAINTENANCE", refId: draft.id as string, status: "LINKED" },
      });
      expect(linked).toBe(0);
    });

    it("B-27: another user's attachment in attachmentIds[] → 403 FORBIDDEN, nothing linked", async () => {
      const draft = await createOwnerDraft({});
      const othersAttachment = await uploadTemp(otherCookie, "others.jpg");
      const resp = await putDraft(ownerCookie, draft.id as string, {
        attachmentIds: [othersAttachment],
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");

      const linked = await prisma.attachment.count({
        where: { refType: "MAINTENANCE", refId: draft.id as string, status: "LINKED" },
      });
      expect(linked).toBe(0);
    });

    it("B-28: an already-LINKED (elsewhere) attachment in attachmentIds[] → 409 CONFLICT", async () => {
      const draft1 = await createOwnerDraft({});
      const draft2 = await createOwnerDraft({});
      const attachmentId = await uploadTemp(ownerCookie, "shared.jpg");

      const first = await putDraft(ownerCookie, draft1.id as string, {
        attachmentIds: [attachmentId],
      });
      expect(first.statusCode).toBe(200);

      const second = await putDraft(ownerCookie, draft2.id as string, {
        attachmentIds: [attachmentId],
      });
      expect(second.statusCode).toBe(409);
      expect(second.json<{ error: { code: string } }>().error.code).toBe("CONFLICT");
    });

    it("no public endpoint accepts a client-supplied limit/refId/containerState (POST /attachments/:id/link is 404)", async () => {
      const attachmentId = await uploadTemp(ownerCookie, "link-probe.jpg");
      const resp = await app.inject({
        method: "POST",
        url: `/attachments/${attachmentId}/link`,
        headers: { cookie: ownerCookie },
        payload: { refType: "MAINTENANCE", refId: "whatever", limit: 999, containerState: "draft" },
      });
      expect(resp.statusCode).toBe(404);
    });

    it("declaring the SAME 5-id set again is a no-op (still exactly 5, no 409)", async () => {
      const draft = await createOwnerDraft({});
      const five = [
        await uploadTemp(ownerCookie, "d1.jpg"),
        await uploadTemp(ownerCookie, "d2.jpg"),
        await uploadTemp(ownerCookie, "d3.jpg"),
        await uploadTemp(ownerCookie, "d4.jpg"),
        await uploadTemp(ownerCookie, "d5.jpg"),
      ];
      const first = await putDraft(ownerCookie, draft.id as string, { attachmentIds: five });
      expect(first.statusCode).toBe(200);

      const second = await putDraft(ownerCookie, draft.id as string, { attachmentIds: five });
      expect(second.statusCode).toBe(200);

      const linked = await prisma.attachment.count({
        where: { refType: "MAINTENANCE", refId: draft.id as string, status: "LINKED" },
      });
      expect(linked).toBe(5);
    });

    it("removing an id from attachmentIds[] detaches it back to TEMP within the same PUT", async () => {
      const draft = await createOwnerDraft({});
      const two = [
        await uploadTemp(ownerCookie, "e1.jpg"),
        await uploadTemp(ownerCookie, "e2.jpg"),
      ];
      const first = await putDraft(ownerCookie, draft.id as string, { attachmentIds: two });
      expect(first.statusCode).toBe(200);

      const second = await putDraft(ownerCookie, draft.id as string, { attachmentIds: [two[0]] });
      expect(second.statusCode).toBe(200);
      const body = second.json<{ application: { attachments: { id: string }[] } }>();
      expect(body.application.attachments.map((a) => a.id)).toEqual([two[0]]);

      const detached = await prisma.attachment.findUnique({ where: { id: two[1] } });
      expect(detached?.status).toBe("TEMP");
      expect(detached?.refType).toBeNull();
      expect(detached?.refId).toBeNull();
    });
  });

  // ===========================================================================
  // AC-22 — 草稿可缺、完成須 ≥1（第 10 項 blocker 接真實 LINKED 計數）
  // ===========================================================================

  describe("AC-22 草稿可缺", () => {
    it("a draft with zero attachments saves successfully and its blockers include MAINTENANCE_ATTACHMENT_REQUIRED", async () => {
      const draft = await createOwnerDraft({
        lastMaintenanceDate: "2026-01-01",
        currentMaintenanceDate: "2026-01-02",
        lastOdometerKm: "1000",
        currentOdometerKm: "1100",
        actualCost: "100",
      });
      const codes = (draft.completionBlockers as { code: string }[]).map((b) => b.code);
      expect(codes).toEqual(["MAINTENANCE_ATTACHMENT_REQUIRED"]);
    });

    it("exactly 1 attachment is enough — MAINTENANCE_ATTACHMENT_REQUIRED no longer appears", async () => {
      const draft = await createOwnerDraft({
        lastMaintenanceDate: "2026-01-01",
        currentMaintenanceDate: "2026-01-02",
        lastOdometerKm: "1000",
        currentOdometerKm: "1100",
        actualCost: "100",
      });
      const attachmentId = await uploadTemp(ownerCookie, "f1.jpg");
      const resp = await putDraft(ownerCookie, draft.id as string, {
        attachmentIds: [attachmentId],
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: { completionBlockers: { code: string }[] } }>();
      const codes = body.application.completionBlockers.map((b) => b.code);
      expect(codes).not.toContain("MAINTENANCE_ATTACHMENT_REQUIRED");
      expect(codes).toEqual([]);
    });
  });

  // ===========================================================================
  // AC-23 — 完成後附件鎖定（deriveContainerState MAINTENANCE 分支修復）
  // ===========================================================================

  describe("AC-23 完成後鎖定", () => {
    it("DELETE /attachments/:id on a COMPLETED maintenance attachment returns 403 and changes nothing (post-fix)", async () => {
      const draft = await createOwnerDraft({ actualCost: "50.00" });
      const attachment = await createLinkedMaintenanceAttachment(draft.id as string, ownerId);
      await markCompleted(draft.id as string);

      const resp = await app.inject({
        method: "DELETE",
        url: `/attachments/${attachment.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");

      const stillThere = await prisma.attachment.findUnique({ where: { id: attachment.id } });
      expect(stillThere?.status).toBe("LINKED");
      expect(stillThere?.refType).toBe("MAINTENANCE");
      expect(stillThere?.refId).toBe(draft.id as string);
    });

    it("DRAFT maintenance attachments can still be deleted (positive control — completion lock must not over-block)", async () => {
      const draft = await createOwnerDraft({});
      const attachment = await createLinkedMaintenanceAttachment(draft.id as string, ownerId);

      const resp = await app.inject({
        method: "DELETE",
        url: `/attachments/${attachment.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(200);

      const detached = await prisma.attachment.findUnique({ where: { id: attachment.id } });
      expect(detached?.status).toBe("TEMP");
    });

    it("B-29: deleting a maintenance DRAFT detaches its MAINTENANCE attachments back to TEMP in the same transaction (post-fix)", async () => {
      const draft = await createOwnerDraft({});
      const att1 = await createLinkedMaintenanceAttachment(draft.id as string, ownerId);
      const att2 = await createLinkedMaintenanceAttachment(draft.id as string, ownerId);

      const resp = await app.inject({
        method: "DELETE",
        url: `/applications/${draft.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(200);

      for (const att of [att1, att2]) {
        const row = await prisma.attachment.findUnique({ where: { id: att.id } });
        expect(row?.status).toBe("TEMP");
        expect(row?.refType).toBeNull();
        expect(row?.refId).toBeNull();
      }
    });

    it("既有差旅 TRIP_SEGMENT detach 行為零變更：刪除差旅草稿仍正確 detach 其段落附件", async () => {
      const travelResp = await app.inject({
        method: "POST",
        url: "/applications/travel",
        headers: { cookie: ownerCookie },
        payload: {},
      });
      expect(travelResp.statusCode).toBe(201);
      const travelId = travelResp.json<{ application: { id: string } }>().application.id;
      trackApp(travelId);

      const segResp = await app.inject({
        method: "PUT",
        url: `/applications/travel/${travelId}`,
        headers: { cookie: ownerCookie },
        payload: { segments: [{ origin: "P", destination: "Q", totalKm: "1", highwayKm: "0" }] },
      });
      expect(segResp.statusCode).toBe(200);
      const segmentId = segResp.json<{ application: { segments: { id: string }[] } }>().application
        .segments[0].id;

      const seg = await prisma.attachment.create({
        data: {
          status: "LINKED",
          storageKey: `p6t6-travel-synthetic-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
          mimeType: "image/jpeg",
          byteSize: 10,
          originalFilename: "seg.jpg",
          uploaderId: ownerId,
          ownerId,
          refType: "TRIP_SEGMENT",
          refId: segmentId,
          linkedAt: new Date(),
        },
      });
      trackAttachment(seg.id);

      const delResp = await app.inject({
        method: "DELETE",
        url: `/applications/${travelId}`,
        headers: { cookie: ownerCookie },
      });
      expect(delResp.statusCode).toBe(200);

      const row = await prisma.attachment.findUnique({ where: { id: seg.id } });
      expect(row?.status).toBe("TEMP");
      expect(row?.refType).toBeNull();
      expect(row?.refId).toBeNull();
    });
  });

  // ===========================================================================
  // AC-24 — 附件授權存取（沿用 PHASE-003 access-service.ts，保養情境驗收）
  // ===========================================================================

  describe("AC-24 附件授權", () => {
    it("owner can read content and thumbnail of a maintenance proof attachment", async () => {
      const draft = await createOwnerDraft({});
      const attachmentId = await uploadTemp(ownerCookie, "auth-owner.jpg");
      const linkResp = await putDraft(ownerCookie, draft.id as string, {
        attachmentIds: [attachmentId],
      });
      expect(linkResp.statusCode).toBe(200);

      const contentResp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/content`,
        headers: { cookie: ownerCookie },
      });
      expect(contentResp.statusCode).toBe(200);
      expect(contentResp.headers["content-type"]).toContain("image/jpeg");

      const thumbResp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/thumbnail`,
        headers: { cookie: ownerCookie },
      });
      expect(thumbResp.statusCode).toBe(200);
      expect(thumbResp.headers["content-type"]).toMatch(/^image\//);
    });

    it("another normal user gets 403 and zero file bytes for content and thumbnail", async () => {
      const draft = await createOwnerDraft({});
      const attachmentId = await uploadTemp(ownerCookie, "auth-other.jpg");
      await putDraft(ownerCookie, draft.id as string, { attachmentIds: [attachmentId] });

      const contentResp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/content`,
        headers: { cookie: otherCookie },
      });
      expect(contentResp.statusCode).toBe(403);
      expect(contentResp.headers["content-type"]).toContain("application/json");

      const thumbResp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/thumbnail`,
        headers: { cookie: otherCookie },
      });
      expect(thumbResp.statusCode).toBe(403);
      expect(thumbResp.headers["content-type"]).toContain("application/json");
    });

    it("unauthenticated gets 401 for both content and thumbnail, no bytes", async () => {
      const draft = await createOwnerDraft({});
      const attachmentId = await uploadTemp(ownerCookie, "auth-anon.jpg");
      await putDraft(ownerCookie, draft.id as string, { attachmentIds: [attachmentId] });

      const contentResp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/content`,
      });
      expect(contentResp.statusCode).toBe(401);
      expect(contentResp.headers["content-type"]).toContain("application/json");

      const thumbResp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/thumbnail`,
      });
      expect(thumbResp.statusCode).toBe(401);
      expect(thumbResp.headers["content-type"]).toContain("application/json");
    });

    it("admin (代操作) can also read content of another user's maintenance proof attachment", async () => {
      const draft = await createOwnerDraft({});
      const attachmentId = await uploadTemp(ownerCookie, "auth-admin.jpg");
      await putDraft(ownerCookie, draft.id as string, { attachmentIds: [attachmentId] });

      const resp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/content`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(200);
    });
  });

  // ===========================================================================
  // Mutant self-proof: MAINTENANCE_ATTACHMENT_LIMIT is enforced (not silently 0/∞)
  // ===========================================================================

  describe("鑑別力 — 上限常數確實作用", () => {
    it("MAINTENANCE_ATTACHMENT_LIMIT export equals 5 (structural pin)", async () => {
      const mod = await import("../../src/applications/maintenance-service.js");
      expect(mod.MAINTENANCE_ATTACHMENT_LIMIT).toBe(5);
    });
  });
});
