/**
 * Integration tests: PHASE-003-T5 — GET /attachments/:id/content and
 * GET /attachments/:id/thumbnail (authorised access endpoints).
 *
 * Done-When §13-T5 coverage:
 *   AC-06: Owner can retrieve their own attachment content
 *   AC-07: Non-owner regular user → 403 FORBIDDEN, no file bytes
 *   AC-08: Unauthenticated → 401 UNAUTHORIZED, no file bytes
 *   AC-09: Admin can retrieve any attachment
 *   AC-D6: 403 FORBIDDEN for non-owner (not 404)
 *   D5 thumbnail fallback: if thumbnailKey=null, /thumbnail falls back to original bytes
 *   storageKey must not appear in error responses (§9.4)
 *   Fabricated request params must not bypass DB-based ownership check
 *
 * Test isolation discipline:
 *   - All users/attachments/sessions created here are cleaned up in afterAll.
 *   - Storage root is an isolated temp directory per test run.
 *
 * All file content is synthetic (no real images) per CLAUDE.md §禁止事項.
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
// Synthetic file builders (magic-byte fixtures — no real images)
// ---------------------------------------------------------------------------

function makeJpegBytes(size = 200): Buffer {
  const buf = Buffer.alloc(size, 0xab);
  const header = buildMinimalHeader("image/jpeg", 12);
  header.copy(buf);
  return buf;
}

function makePngBytes(size = 200): Buffer {
  const buf = Buffer.alloc(size, 0xcd);
  const header = buildMinimalHeader("image/png", 12);
  header.copy(buf);
  return buf;
}

// ---------------------------------------------------------------------------
// Multipart body builder (reused from phase3-upload.test.ts pattern)
// ---------------------------------------------------------------------------

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
// Login helper
// ---------------------------------------------------------------------------

async function loginUser(
  app: FastifyInstance,
  loginName: string,
  password: string
): Promise<string> {
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
  if (!match) throw new Error("No sid cookie in login response");
  return `sid=${match[1]}`;
}

// ---------------------------------------------------------------------------
// Upload helper — uploads a file and returns attachment id
// ---------------------------------------------------------------------------

async function uploadFile(
  app: FastifyInstance,
  cookie: string,
  fileBytes: Buffer,
  filename: string
): Promise<string> {
  const { body, contentType } = buildMultipartBody(filename, fileBytes);
  const res = await app.inject({
    method: "POST",
    url: "/attachments",
    headers: { "content-type": contentType, cookie },
    payload: body,
  });
  if (res.statusCode !== 201) {
    throw new Error(`Upload failed: ${res.statusCode} ${res.body}`);
  }
  const json = JSON.parse(res.body);
  return json.attachment.id;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function makeTempStorageRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "phase3-access-test-"));
}

function removeTempStorageRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describeWithDb("PHASE-003-T5 — GET /attachments/:id/content and /thumbnail", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let storageRoot: string;

  // Owner credentials (regular user who uploads the file)
  const OWNER_LOGIN = `t5_owner_${Date.now()}`;
  const OWNER_PASSWORD = "OwnerPass99!";
  let ownerCookie: string;
  let ownerId: string;

  // Other regular user credentials (non-owner)
  const OTHER_LOGIN = `t5_other_${Date.now()}`;
  const OTHER_PASSWORD = "OtherPass99!";
  let otherCookie: string;
  let otherId: string;

  // Admin credentials
  const ADMIN_LOGIN = `t5_admin_${Date.now()}`;
  const ADMIN_PASSWORD = "AdminPass99!";
  let adminCookie: string;
  let adminId: string;

  // Attachment IDs created by owner (with both original + thumbnail)
  let attachmentWithThumb: string;
  // Attachment ID where thumbnailKey is manually set to null (no thumbnail)
  let attachmentNoThumb: string;

  // Track attachment IDs for scoped cleanup
  const createdAttachmentIds: string[] = [];

  beforeAll(async () => {
    if (!DB_URL) return;

    storageRoot = makeTempStorageRoot();

    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    // Create owner user
    const ownerHash = await hashPassword(OWNER_PASSWORD);
    const ownerUser = await prisma.user.create({
      data: {
        loginName: OWNER_LOGIN,
        displayName: "T5 Owner User",
        passwordHash: ownerHash,
        isActive: true,
        mustChangePassword: false,
      },
    });
    ownerId = ownerUser.id;

    // Create other regular user
    const otherHash = await hashPassword(OTHER_PASSWORD);
    const otherUser = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "T5 Other User",
        passwordHash: otherHash,
        isActive: true,
        mustChangePassword: false,
      },
    });
    otherId = otherUser.id;

    // Create admin user
    const adminHash = await hashPassword(ADMIN_PASSWORD);
    const adminUser = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "T5 Admin User",
        passwordHash: adminHash,
        isActive: true,
        mustChangePassword: false,
        role: "ADMIN",
      },
    });
    adminId = adminUser.id;

    // Build server with isolated storage root
    app = await buildServer({
      databaseUrl: DB_URL,
      logLevel: "error",
      storageRoot,
    });
    await app.ready();

    // Log in all users
    ownerCookie = await loginUser(app, OWNER_LOGIN, OWNER_PASSWORD);
    otherCookie = await loginUser(app, OTHER_LOGIN, OTHER_PASSWORD);
    adminCookie = await loginUser(app, ADMIN_LOGIN, ADMIN_PASSWORD);

    // Upload a JPEG as owner — this will have a thumbnail if sharp works, or not if D5 fallback
    attachmentWithThumb = await uploadFile(app, ownerCookie, makeJpegBytes(300), "owner-photo.jpg");
    createdAttachmentIds.push(attachmentWithThumb);

    // Create an attachment directly in DB with thumbnailKey=null, and put original bytes
    // into storage — this simulates the D5 fallback scenario (sharp failed, thumbnailKey=null)
    const storage = new LocalVolumeStorage(storageRoot);
    const noThumbOrigBytes = makePngBytes(250);
    const noThumbStorageId = `noThumb${Date.now()}`;
    const noThumbOrigKey = `att/${noThumbStorageId}/original`;
    await storage.put(noThumbOrigKey, noThumbOrigBytes, "image/png");

    const noThumbRecord = await prisma.attachment.create({
      data: {
        storageKey: noThumbOrigKey,
        thumbnailKey: null, // explicitly no thumbnail
        mimeType: "image/png",
        byteSize: noThumbOrigBytes.length,
        originalFilename: "no-thumb.png",
        uploaderId: ownerId,
        ownerId: ownerId,
        status: "TEMP",
      },
    });
    attachmentNoThumb = noThumbRecord.id;
    createdAttachmentIds.push(attachmentNoThumb);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      if (createdAttachmentIds.length > 0) {
        await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
      }
      // Safety net: clean by ownerId
      await prisma.attachment.deleteMany({ where: { ownerId: ownerId } });
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
  // AC-08: Unauthenticated → 401, no file bytes
  // ---------------------------------------------------------------------------

  it("GET /attachments/:id/content returns 401 UNAUTHORIZED when not authenticated (AC-08)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/attachments/${attachmentWithThumb}/content`,
    });
    expect(res.statusCode).toBe(401);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("UNAUTHORIZED");
    // No file bytes — body is a JSON error object, not binary
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("GET /attachments/:id/thumbnail returns 401 UNAUTHORIZED when not authenticated (AC-08)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/attachments/${attachmentWithThumb}/thumbnail`,
    });
    expect(res.statusCode).toBe(401);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("UNAUTHORIZED");
    expect(res.headers["content-type"]).toContain("application/json");
  });

  // ---------------------------------------------------------------------------
  // AC-06: Owner can retrieve their own attachment content
  // ---------------------------------------------------------------------------

  it("GET /attachments/:id/content returns 200 with correct Content-Type for owner (AC-06)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/attachments/${attachmentWithThumb}/content`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    // Content-Type must match the attachment's mimeType (image/jpeg)
    expect(res.headers["content-type"]).toContain("image/jpeg");
    // Content-Disposition must be inline (AC-06)
    expect(res.headers["content-disposition"]).toContain("inline");
    // Response body must contain actual bytes (not empty)
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it("GET /attachments/:id/thumbnail returns 200 for owner (AC-06)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/attachments/${attachmentWithThumb}/thumbnail`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    // Must return an image content-type
    expect(res.headers["content-type"]).toMatch(/^image\//);
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // AC-07: Non-owner regular user → 403 FORBIDDEN, no file bytes (D6 definite)
  // ---------------------------------------------------------------------------

  it("GET /attachments/:id/content returns 403 FORBIDDEN for non-owner user (AC-07, D6)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/attachments/${attachmentWithThumb}/content`,
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(403);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("FORBIDDEN");
    // No file bytes — content-type must be JSON (not the attachment mime)
    expect(res.headers["content-type"]).toContain("application/json");
    // Raw payload must not match the actual JPEG bytes (we can check it's not an image)
    expect(res.rawPayload.length).toBeLessThan(500); // error body is small
  });

  it("GET /attachments/:id/thumbnail returns 403 FORBIDDEN for non-owner user (AC-07, D6)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/attachments/${attachmentWithThumb}/thumbnail`,
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(403);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("FORBIDDEN");
    expect(res.headers["content-type"]).toContain("application/json");
  });

  // ---------------------------------------------------------------------------
  // AC-09: Admin can retrieve any attachment
  // ---------------------------------------------------------------------------

  it("GET /attachments/:id/content returns 200 for admin accessing any attachment (AC-09)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/attachments/${attachmentWithThumb}/content`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/jpeg");
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it("GET /attachments/:id/thumbnail returns 200 for admin (AC-09)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/attachments/${attachmentWithThumb}/thumbnail`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\//);
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 404 NOT_FOUND: attachment id does not exist
  // ---------------------------------------------------------------------------

  it("GET /attachments/:id/content returns 404 NOT_FOUND for non-existent id (owner)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/attachments/nonexistent-id-xyz/content",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(404);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  it("GET /attachments/:id/thumbnail returns 404 NOT_FOUND for non-existent id (owner)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/attachments/nonexistent-id-xyz/thumbnail",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(404);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  it("GET /attachments/:id/content returns 404 NOT_FOUND for non-existent id (other user)", async () => {
    // Non-existent id returns 404 regardless of who asks
    // (the DB lookup fails before ownership check)
    const res = await app.inject({
      method: "GET",
      url: "/attachments/nonexistent-id-xyz/content",
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(404);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  it("GET /attachments/:id/thumbnail returns 401 for non-existent id when unauthenticated (AC-08 takes priority)", async () => {
    // Auth check happens before DB lookup, so unauthenticated always gets 401
    const res = await app.inject({
      method: "GET",
      url: "/attachments/nonexistent-id-xyz/thumbnail",
    });
    expect(res.statusCode).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // D5 thumbnail fallback: thumbnailKey=null → /thumbnail returns original bytes
  // ---------------------------------------------------------------------------

  it("GET /attachments/:id/thumbnail falls back to original bytes when thumbnailKey=null (D5)", async () => {
    const contentRes = await app.inject({
      method: "GET",
      url: `/attachments/${attachmentNoThumb}/content`,
      headers: { cookie: ownerCookie },
    });
    expect(contentRes.statusCode).toBe(200);
    const originalBytes = contentRes.rawPayload;

    const thumbRes = await app.inject({
      method: "GET",
      url: `/attachments/${attachmentNoThumb}/thumbnail`,
      headers: { cookie: ownerCookie },
    });
    expect(thumbRes.statusCode).toBe(200);
    // Thumbnail endpoint falls back to original bytes when thumbnailKey is null
    expect(thumbRes.rawPayload).toEqual(originalBytes);
    // Content-Type should match original mimeType (image/png)
    expect(thumbRes.headers["content-type"]).toContain("image/png");
  });

  // ---------------------------------------------------------------------------
  // §9.4: storageKey must not appear in error response bodies
  // ---------------------------------------------------------------------------

  it("error responses do not expose storageKey or volume paths (§9.4)", async () => {
    // A 403 response for a known attachment must not leak its storage key
    const dbRecord = await prisma.attachment.findUnique({
      where: { id: attachmentWithThumb },
    });
    if (!dbRecord) throw new Error("Test attachment not found in DB");

    const res = await app.inject({
      method: "GET",
      url: `/attachments/${attachmentWithThumb}/content`,
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(403);
    // Response body must not contain the storageKey value
    expect(res.body).not.toContain(dbRecord.storageKey);
    // Response body must not contain the storage root path
    expect(res.body).not.toContain(storageRoot);
  });

  // ---------------------------------------------------------------------------
  // Authorization uses DB ownerId, not request parameters
  // Even if the "other" user somehow fabricates their own user id in a URL,
  // the endpoint uses :id (attachment id), and ownership comes from DB.
  // ---------------------------------------------------------------------------

  it("authorization is based on DB ownerId, not request parameters (fabricated request cannot bypass)", async () => {
    // Other user requests owner's attachment — must be 403 regardless
    // (the attachment id is the only param; ownerId is read from DB, not request)
    const res = await app.inject({
      method: "GET",
      url: `/attachments/${attachmentWithThumb}/content`,
      headers: {
        cookie: otherCookie,
        // Even if a fabricated header is added, it has no effect
        "x-owner-id": ownerId,
        "x-user-id": ownerId,
      },
    });
    expect(res.statusCode).toBe(403);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("FORBIDDEN");
  });

  // ---------------------------------------------------------------------------
  // Bytes consistency: /content returns the exact bytes that were stored
  // ---------------------------------------------------------------------------

  it("GET /attachments/:id/content returns byte-for-byte identical content to what was uploaded (AC-06)", async () => {
    // Upload a fresh file and verify the returned bytes match
    const fileBytes = makeJpegBytes(350);
    const { body, contentType } = buildMultipartBody("verify-bytes.jpg", fileBytes);

    const uploadRes = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { "content-type": contentType, cookie: ownerCookie },
      payload: body,
    });
    expect(uploadRes.statusCode).toBe(201);
    const { attachment } = JSON.parse(uploadRes.body);
    createdAttachmentIds.push(attachment.id);

    const contentRes = await app.inject({
      method: "GET",
      url: `/attachments/${attachment.id}/content`,
      headers: { cookie: ownerCookie },
    });
    expect(contentRes.statusCode).toBe(200);
    // Returned bytes must match exactly what was uploaded
    expect(contentRes.rawPayload).toEqual(fileBytes);
  });

  // ---------------------------------------------------------------------------
  // Non-owner trying to get the "no-thumb" attachment also gets 403
  // ---------------------------------------------------------------------------

  it("GET /attachments/:id/content returns 403 for non-owner on no-thumbnail attachment", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/attachments/${attachmentNoThumb}/content`,
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(403);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("GET /attachments/:id/thumbnail returns 403 for non-owner on no-thumbnail attachment", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/attachments/${attachmentNoThumb}/thumbnail`,
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(403);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("FORBIDDEN");
  });
});
