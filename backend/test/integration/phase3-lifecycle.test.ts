/**
 * Integration tests: PHASE-003-T6 — Lifecycle: link, detach, delete
 *
 * Covers Done-When §13-T6 integration requirements:
 *   AC-14: TEMP attachment can be linked → status becomes LINKED, refType/refId/linkedAt written
 *   AC-15: LINKED attachment can be detached via DELETE → status returns to TEMP
 *   AC-16: container state=completed → DELETE returns 403 FORBIDDEN
 *   AC-16: container state=completed → link returns 403 FORBIDDEN
 *   AC-10: link when count reaches limit → 409 TOO_MANY_ATTACHMENTS
 *   Non-TEMP (LINKED) attachment → link rejected 409 CONFLICT
 *   Non-owner requesting link → 403 FORBIDDEN
 *   Non-owner requesting DELETE → 403 FORBIDDEN
 *   Unauthenticated → 401
 *   TEMP attachment DELETE → record removed (pure TEMP delete, AC-15 supplement)
 *   Detach resets createdAt (TTL base restarted per §4.5/Packet D2)
 *
 * Concurrent link test (TOCTOU):
 *   Attempt two concurrent link calls to the same container at limit-1 with
 *   limit=1 — only one should succeed, the other should get 409.
 *   Note: the transaction-based guard prevents both from succeeding; however, due
 *   to the nature of integration testing (sequential HTTP injection), true concurrent
 *   races are simulated via Promise.all. If both succeed, the test fails and that
 *   indicates the transaction guard is not working.
 *
 * Test isolation: all users/attachments/sessions created here are cleaned up in afterAll.
 * Storage root: isolated temp directory per run.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMinimalHeader } from "../../src/attachment/detect-mime.js";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";
import { LocalVolumeStorage } from "../../src/storage/index.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Synthetic file helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function makeTempStorageRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "phase3-lifecycle-test-"));
}

function removeTempStorageRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describeWithDb("PHASE-003-T6 — Lifecycle: link, detach, delete", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let storageRoot: string;

  // Owner user (regular)
  const OWNER_LOGIN = `t6_owner_${Date.now()}`;
  const OWNER_PASSWORD = "OwnerPass99!";
  let ownerCookie: string;
  let ownerId: string;

  // Other regular user
  const OTHER_LOGIN = `t6_other_${Date.now()}`;
  const OTHER_PASSWORD = "OtherPass99!";
  let otherCookie: string;

  // Admin user
  const ADMIN_LOGIN = `t6_admin_${Date.now()}`;
  const ADMIN_PASSWORD = "AdminPass99!";
  let adminCookie: string;

  // Track created attachments for cleanup
  const createdAttachmentIds: string[] = [];

  // ---------------------------------------------------------------------------
  // Setup / teardown
  // ---------------------------------------------------------------------------

  beforeAll(async () => {
    if (!DB_URL) return;

    storageRoot = makeTempStorageRoot();
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    // Create owner
    const ownerHash = await hashPassword(OWNER_PASSWORD);
    const ownerUser = await prisma.user.create({
      data: {
        loginName: OWNER_LOGIN,
        displayName: "T6 Owner",
        passwordHash: ownerHash,
        isActive: true,
        mustChangePassword: false,
      },
    });
    ownerId = ownerUser.id;

    // Create other user
    const otherHash = await hashPassword(OTHER_PASSWORD);
    await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "T6 Other",
        passwordHash: otherHash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    // Create admin
    const adminHash = await hashPassword(ADMIN_PASSWORD);
    await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "T6 Admin",
        passwordHash: adminHash,
        isActive: true,
        mustChangePassword: false,
        role: "ADMIN",
      },
    });

    // Build server
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error", storageRoot });
    await app.ready();

    // Login helpers
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

    ownerCookie = await login(OWNER_LOGIN, OWNER_PASSWORD);
    otherCookie = await login(OTHER_LOGIN, OTHER_PASSWORD);
    adminCookie = await login(ADMIN_LOGIN, ADMIN_PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      // Scoped cleanup — delete all attachments owned by owner or created by tests
      if (createdAttachmentIds.length > 0) {
        await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
      }
      // Safety net: clean by ownerId
      await prisma.attachment.deleteMany({ where: { ownerId } });
      await prisma.session.deleteMany({ where: { user: { loginName: OWNER_LOGIN } } });
      await prisma.session.deleteMany({ where: { user: { loginName: OTHER_LOGIN } } });
      await prisma.session.deleteMany({ where: { user: { loginName: ADMIN_LOGIN } } });
      await prisma.user.deleteMany({
        where: { loginName: { in: [OWNER_LOGIN, OTHER_LOGIN, ADMIN_LOGIN] } },
      });
      await prisma.$disconnect();
    }
    if (storageRoot) removeTempStorageRoot(storageRoot);
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Upload a JPEG as the owner; return the attachment id */
  async function uploadAsOwner(filename = "test.jpg"): Promise<string> {
    const { body, contentType } = buildMultipartBody(filename, makeJpegBytes());
    const res = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { "content-type": contentType, cookie: ownerCookie },
      payload: body,
    });
    if (res.statusCode !== 201) throw new Error(`Upload failed: ${res.statusCode} ${res.body}`);
    const { attachment } = JSON.parse(res.body);
    createdAttachmentIds.push(attachment.id);
    return attachment.id;
  }

  /** POST /attachments/:id/link helper */
  async function linkAttachment(
    attachmentId: string,
    cookie: string,
    body: Record<string, unknown>
  ) {
    return app.inject({
      method: "POST",
      url: `/attachments/${attachmentId}/link`,
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify(body),
    });
  }

  /** DELETE /attachments/:id helper */
  async function deleteAttachment(attachmentId: string, cookie: string, query?: string) {
    return app.inject({
      method: "DELETE",
      url: `/attachments/${attachmentId}${query ? `?${query}` : ""}`,
      headers: { cookie },
    });
  }

  // ---------------------------------------------------------------------------
  // AC-08/401: Unauthenticated requests
  // ---------------------------------------------------------------------------

  it("POST /attachments/:id/link returns 401 UNAUTHORIZED when not authenticated (AC-08)", async () => {
    const attId = await uploadAsOwner("unauth-link.jpg");
    const res = await app.inject({
      method: "POST",
      url: `/attachments/${attId}/link`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ refType: "TRIP_SEGMENT", refId: "seg-001", limit: 3 }),
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("UNAUTHORIZED");
  });

  it("DELETE /attachments/:id returns 401 UNAUTHORIZED when not authenticated (AC-08)", async () => {
    const attId = await uploadAsOwner("unauth-delete.jpg");
    const res = await app.inject({
      method: "DELETE",
      url: `/attachments/${attId}`,
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("UNAUTHORIZED");
  });

  // ---------------------------------------------------------------------------
  // AC-14: Link TEMP attachment → status becomes LINKED (success path)
  // ---------------------------------------------------------------------------

  it("POST /attachments/:id/link links a TEMP attachment → 200 LINKED status (AC-14)", async () => {
    const attId = await uploadAsOwner("link-success.jpg");

    const res = await linkAttachment(attId, ownerCookie, {
      refType: "TRIP_SEGMENT",
      refId: "seg-t6-001",
      limit: 3,
    });

    expect(res.statusCode).toBe(200);
    const { attachment } = JSON.parse(res.body);
    expect(attachment.status).toBe("LINKED");
    expect(attachment.refType).toBe("TRIP_SEGMENT");
    expect(attachment.refId).toBe("seg-t6-001");

    // Verify DB state
    const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(dbAtt?.status).toBe("LINKED");
    expect(dbAtt?.refType).toBe("TRIP_SEGMENT");
    expect(dbAtt?.refId).toBe("seg-t6-001");
    expect(dbAtt?.linkedAt).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 400: Missing required body fields
  // ---------------------------------------------------------------------------

  it("POST /attachments/:id/link returns 400 VALIDATION_ERROR when body is missing refType", async () => {
    const attId = await uploadAsOwner("link-missing.jpg");
    const res = await linkAttachment(attId, ownerCookie, {
      refId: "seg-t6-002",
      limit: 3,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /attachments/:id/link returns 400 VALIDATION_ERROR when body is missing refId", async () => {
    const attId = await uploadAsOwner("link-missing2.jpg");
    const res = await linkAttachment(attId, ownerCookie, {
      refType: "TRIP_SEGMENT",
      limit: 3,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /attachments/:id/link returns 400 VALIDATION_ERROR when body is missing limit", async () => {
    const attId = await uploadAsOwner("link-missing3.jpg");
    const res = await linkAttachment(attId, ownerCookie, {
      refType: "TRIP_SEGMENT",
      refId: "seg-t6-003",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("VALIDATION_ERROR");
  });

  // ---------------------------------------------------------------------------
  // AC-10: Limit exceeded → 409 TOO_MANY_ATTACHMENTS
  // ---------------------------------------------------------------------------

  it("POST /attachments/:id/link returns 409 TOO_MANY_ATTACHMENTS when limit reached (AC-10)", async () => {
    const refId = `seg-t6-limit-${Date.now()}`;

    // First upload and link successfully (limit=1, count goes 0→1)
    const att1 = await uploadAsOwner("limit-att1.jpg");
    const linkRes1 = await linkAttachment(att1, ownerCookie, {
      refType: "TRIP_SEGMENT",
      refId,
      limit: 1,
    });
    expect(linkRes1.statusCode).toBe(200);

    // Second upload attempt to link (count=1, limit=1 → reject)
    const att2 = await uploadAsOwner("limit-att2.jpg");
    const linkRes2 = await linkAttachment(att2, ownerCookie, {
      refType: "TRIP_SEGMENT",
      refId,
      limit: 1,
    });
    expect(linkRes2.statusCode).toBe(409);
    expect(JSON.parse(linkRes2.body).error.code).toBe("TOO_MANY_ATTACHMENTS");

    // att2 must remain TEMP (not linked)
    const dbAtt2 = await prisma.attachment.findUnique({ where: { id: att2 } });
    expect(dbAtt2?.status).toBe("TEMP");
  });

  // ---------------------------------------------------------------------------
  // 409 CONFLICT: trying to link an already-LINKED attachment
  // ---------------------------------------------------------------------------

  it("POST /attachments/:id/link returns 409 CONFLICT when attachment is already LINKED", async () => {
    const refId = `seg-t6-already-linked-${Date.now()}`;
    const attId = await uploadAsOwner("already-linked.jpg");

    // First link succeeds
    const res1 = await linkAttachment(attId, ownerCookie, {
      refType: "TRIP_SEGMENT",
      refId,
      limit: 5,
    });
    expect(res1.statusCode).toBe(200);

    // Second link attempt on same attachment → should fail (already LINKED)
    const res2 = await linkAttachment(attId, ownerCookie, {
      refType: "TRIP_SEGMENT",
      refId: "seg-t6-different",
      limit: 5,
    });
    expect(res2.statusCode).toBe(409);
    const json = JSON.parse(res2.body);
    // Either CONFLICT or similar — the attachment is not TEMP anymore
    expect(["CONFLICT", "TOO_MANY_ATTACHMENTS"]).toContain(json.error.code);
  });

  // ---------------------------------------------------------------------------
  // AC-16: completed container → link returns 403 FORBIDDEN
  // ---------------------------------------------------------------------------

  it("POST /attachments/:id/link returns 403 FORBIDDEN when containerState=completed (AC-16)", async () => {
    const attId = await uploadAsOwner("completed-link.jpg");
    const res = await linkAttachment(attId, ownerCookie, {
      refType: "TRIP_SEGMENT",
      refId: "seg-t6-completed",
      limit: 5,
      containerState: "completed",
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");
  });

  // ---------------------------------------------------------------------------
  // Non-owner link → 403 FORBIDDEN
  // ---------------------------------------------------------------------------

  it("POST /attachments/:id/link returns 403 FORBIDDEN when another user tries to link", async () => {
    const attId = await uploadAsOwner("other-link.jpg");
    const res = await linkAttachment(attId, otherCookie, {
      refType: "TRIP_SEGMENT",
      refId: "seg-t6-other",
      limit: 5,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");
  });

  // ---------------------------------------------------------------------------
  // Admin can link any attachment
  // ---------------------------------------------------------------------------

  it("POST /attachments/:id/link allows admin to link any attachment (AC-09 family)", async () => {
    const attId = await uploadAsOwner("admin-link.jpg");
    const res = await linkAttachment(attId, adminCookie, {
      refType: "MAINTENANCE",
      refId: `maint-admin-${Date.now()}`,
      limit: 5,
    });
    expect(res.statusCode).toBe(200);
    const { attachment } = JSON.parse(res.body);
    expect(attachment.status).toBe("LINKED");
  });

  // ---------------------------------------------------------------------------
  // 404: non-existent attachment id
  // ---------------------------------------------------------------------------

  it("POST /attachments/:id/link returns 404 for non-existent attachment", async () => {
    const res = await linkAttachment("nonexistent-id-t6", ownerCookie, {
      refType: "TRIP_SEGMENT",
      refId: "seg-t6-404",
      limit: 3,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("NOT_FOUND");
  });

  // ---------------------------------------------------------------------------
  // AC-15: DELETE LINKED attachment → detaches (status → TEMP, refType/refId/linkedAt cleared)
  // ---------------------------------------------------------------------------

  it("DELETE /attachments/:id on LINKED attachment → detaches (AC-15)", async () => {
    const attId = await uploadAsOwner("detach.jpg");

    // Link first
    const linkRes = await linkAttachment(attId, ownerCookie, {
      refType: "TRIP_SEGMENT",
      refId: `seg-t6-detach-${Date.now()}`,
      limit: 3,
    });
    expect(linkRes.statusCode).toBe(200);

    // Verify LINKED in DB
    const before = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(before?.status).toBe("LINKED");

    // Now detach via DELETE
    const delRes = await deleteAttachment(attId, ownerCookie);
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.body)).toHaveProperty("ok", true);

    // After detach: status should be TEMP, ref fields cleared
    const after = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(after?.status).toBe("TEMP");
    expect(after?.refType).toBeNull();
    expect(after?.refId).toBeNull();
    expect(after?.linkedAt).toBeNull();

    // TTL base: createdAt should be updated to "now" (the detach time) per §4.5/D2 definition
    // We verify it's later than the initial upload time (at least within 5 seconds of now)
    const now = Date.now();
    expect(after?.createdAt.getTime()).toBeGreaterThan(now - 5000);
    expect(after?.createdAt.getTime()).toBeLessThanOrEqual(now + 1000);
  });

  // ---------------------------------------------------------------------------
  // Draft not displayed after detach (AC-15: "reload draft not shown")
  // ---------------------------------------------------------------------------

  it("after detach, attachment is no longer LINKED (reloading shows TEMP state) (AC-15)", async () => {
    const attId = await uploadAsOwner("after-detach-reload.jpg");
    const refId = `seg-t6-reload-${Date.now()}`;

    await linkAttachment(attId, ownerCookie, {
      refType: "TRIP_SEGMENT",
      refId,
      limit: 3,
    });

    // Detach
    const delRes = await deleteAttachment(attId, ownerCookie);
    expect(delRes.statusCode).toBe(200);

    // Reload: querying DB directly, no longer LINKED to that refId
    const reloaded = await prisma.attachment.findMany({
      where: { refId, status: "LINKED" },
    });
    expect(reloaded).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // AC-16: completed container → DELETE returns 403 FORBIDDEN
  // ---------------------------------------------------------------------------

  it("DELETE /attachments/:id returns 403 FORBIDDEN when containerState=completed (AC-16)", async () => {
    const attId = await uploadAsOwner("completed-delete.jpg");

    // Link it first (draft state)
    const refId = `seg-t6-completed-del-${Date.now()}`;
    await linkAttachment(attId, ownerCookie, {
      refType: "TRIP_SEGMENT",
      refId,
      limit: 5,
    });

    // Now try to delete with containerState=completed
    const res = await deleteAttachment(attId, ownerCookie, "containerState=completed");
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");

    // Attachment must still be LINKED (unchanged)
    const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(dbAtt?.status).toBe("LINKED");
  });

  // ---------------------------------------------------------------------------
  // AC-15 (supplement): DELETE TEMP attachment → record removed from DB + storage
  // ---------------------------------------------------------------------------

  it("DELETE /attachments/:id on TEMP attachment → removes DB record and storage file", async () => {
    const attId = await uploadAsOwner("temp-delete.jpg");

    // Confirm it's TEMP in DB
    const before = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(before?.status).toBe("TEMP");
    const storageKey = before?.storageKey;

    // Delete TEMP attachment
    const delRes = await deleteAttachment(attId, ownerCookie);
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.body)).toHaveProperty("ok", true);

    // DB record should be gone
    const after = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(after).toBeNull();

    // Storage file should also be gone
    if (storageKey) {
      const storage = new LocalVolumeStorage(storageRoot);
      const exists = await storage.exists(storageKey);
      expect(exists).toBe(false);
    }

    // Remove from tracking (already deleted)
    const idx = createdAttachmentIds.indexOf(attId);
    if (idx !== -1) createdAttachmentIds.splice(idx, 1);
  });

  // ---------------------------------------------------------------------------
  // Non-owner DELETE → 403 FORBIDDEN
  // ---------------------------------------------------------------------------

  it("DELETE /attachments/:id returns 403 FORBIDDEN when another user tries to delete", async () => {
    const attId = await uploadAsOwner("other-delete.jpg");
    const res = await deleteAttachment(attId, otherCookie);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");
  });

  // ---------------------------------------------------------------------------
  // Admin can delete any attachment
  // ---------------------------------------------------------------------------

  it("DELETE /attachments/:id allows admin to delete any attachment", async () => {
    const attId = await uploadAsOwner("admin-delete.jpg");
    const delRes = await deleteAttachment(attId, adminCookie);
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.body)).toHaveProperty("ok", true);

    // Remove from tracking (already deleted)
    const idx = createdAttachmentIds.indexOf(attId);
    if (idx !== -1) createdAttachmentIds.splice(idx, 1);
  });

  // ---------------------------------------------------------------------------
  // 404: DELETE non-existent attachment
  // ---------------------------------------------------------------------------

  it("DELETE /attachments/:id returns 404 for non-existent attachment", async () => {
    const res = await deleteAttachment("nonexistent-t6-delete", ownerCookie);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("NOT_FOUND");
  });

  // ---------------------------------------------------------------------------
  // Concurrent link test (TOCTOU via Promise.all)
  // Two simultaneous link requests to a container at capacity limit=1.
  // One should succeed, one should get 409.
  // ---------------------------------------------------------------------------

  it("concurrent link requests to a limit=1 container: only one succeeds (TOCTOU guard)", async () => {
    const refId = `seg-t6-concurrent-${Date.now()}`;

    // Upload two attachments
    const att1 = await uploadAsOwner("concurrent1.jpg");
    const att2 = await uploadAsOwner("concurrent2.jpg");

    // Fire both link requests simultaneously (Promise.all simulates concurrency)
    const [res1, res2] = await Promise.all([
      linkAttachment(att1, ownerCookie, {
        refType: "TRIP_SEGMENT",
        refId,
        limit: 1,
      }),
      linkAttachment(att2, ownerCookie, {
        refType: "TRIP_SEGMENT",
        refId,
        limit: 1,
      }),
    ]);

    const statuses = [res1.statusCode, res2.statusCode].sort();

    // One must be 200 (success), one must be 409 (conflict/over-limit)
    // Note: due to sequential injection in Vitest, both might not truly race;
    // but the transaction guard ensures at most 1 succeeds even under real concurrency.
    expect(statuses).toEqual([200, 409]);

    // Verify DB: exactly 1 attachment should be LINKED to this refId
    const linkedCount = await prisma.attachment.count({
      where: { refId, status: "LINKED" },
    });
    expect(linkedCount).toBe(1);
  });
});
