/**
 * Integration tests: PHASE-003-T3 — POST /attachments upload endpoint.
 *
 * Covers Done-When §13-T3:
 *   - AC-01: Legitimate JPEG/PNG/WebP → 201 + TEMP + thumbnail path
 *   - AC-02: Disguised extension (valid extension, non-image bytes) → 415 + no DB record + no orphan file
 *   - AC-03: PDF/unsupported → 415
 *   - AC-04: > size limit → 413
 *   - AC-05: Empty file → 415
 *   - AC-08: Unauthenticated → 401
 *   - Compensation delete: storage orphan prevention
 *   - Log safety: no volume absolute path in responses
 *
 * Storage root is an isolated temp directory per test run.
 * DB cleanup is scoped to attachments/users created by this suite.
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

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Synthetic file builders (magic-byte fixtures — no real image files)
// ---------------------------------------------------------------------------

function makeJpegBytes(size = 100): Buffer {
  const buf = Buffer.alloc(size, 0);
  const header = buildMinimalHeader("image/jpeg", 12);
  header.copy(buf);
  return buf;
}

function makePngBytes(size = 100): Buffer {
  const buf = Buffer.alloc(size, 0);
  const header = buildMinimalHeader("image/png", 12);
  header.copy(buf);
  return buf;
}

function makeWebpBytes(size = 100): Buffer {
  const buf = Buffer.alloc(size, 0);
  const header = buildMinimalHeader("image/webp", 12);
  header.copy(buf);
  return buf;
}

function makePdfBytes(size = 100): Buffer {
  const buf = Buffer.alloc(size, 0);
  // %PDF- magic
  buf[0] = 0x25; // %
  buf[1] = 0x50; // P
  buf[2] = 0x44; // D
  buf[3] = 0x46; // F
  buf[4] = 0x2d; // -
  return buf;
}

// ---------------------------------------------------------------------------
// Multipart body builder
// ---------------------------------------------------------------------------

/**
 * Build a multipart/form-data body manually.
 * Returns { body: Buffer, boundary: string }.
 * Compatible with Fastify inject() which accepts raw Buffer + headers.
 */
function buildMultipartBody(
  filename: string,
  content: Buffer,
  fieldname = "file"
): { body: Buffer; contentType: string } {
  const boundary = `----FormBoundary${Date.now()}`;
  const CRLF = "\r\n";

  const header = `--${boundary}${CRLF}Content-Disposition: form-data; name="${fieldname}"; filename="${filename}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`;

  const footer = `${CRLF}--${boundary}--${CRLF}`;

  const body = Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]);

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ---------------------------------------------------------------------------
// Login helper — returns session cookie
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
// Storage root helper — isolated temp dir per test run
// ---------------------------------------------------------------------------

function makeTempStorageRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "phase3-upload-test-"));
}

function removeTempStorageRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

/** Count files in the storage root recursively */
function countStorageFiles(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      } else {
        count++;
      }
    }
  }
  walk(root);
  return count;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describeWithDb("PHASE-003-T3 — POST /attachments upload endpoint", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let storageRoot: string;

  // User credentials
  const USER_LOGIN = `t3_upload_${Date.now()}`;
  const USER_PASSWORD = "UploadTest99!";
  let sessionCookie: string;
  let userId: string;

  // Track attachment IDs created by this suite for scoped DB cleanup
  const createdAttachmentIds: string[] = [];

  beforeAll(async () => {
    if (!DB_URL) return;

    // Create isolated storage root
    storageRoot = makeTempStorageRoot();

    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    // Create test user
    const hash = await hashPassword(USER_PASSWORD);
    const user = await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "Upload Test User T3",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });
    userId = user.id;

    // Build server with isolated storage root
    app = await buildServer({
      databaseUrl: DB_URL,
      logLevel: "error",
      storageRoot,
    });
    await app.ready();

    // Log in and capture session cookie
    sessionCookie = await loginUser(app, USER_LOGIN, USER_PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      // Scoped cleanup: delete attachments created by this test suite
      if (createdAttachmentIds.length > 0) {
        await prisma.attachment.deleteMany({
          where: { id: { in: createdAttachmentIds } },
        });
      }
      // Also clean by ownerId as safety net
      await prisma.attachment.deleteMany({ where: { ownerId: userId } });
      await prisma.session.deleteMany({ where: { user: { loginName: USER_LOGIN } } });
      await prisma.user.deleteMany({ where: { loginName: USER_LOGIN } });
      await prisma.$disconnect();
    }
    // Remove isolated storage directory
    if (storageRoot) removeTempStorageRoot(storageRoot);
  });

  // -------------------------------------------------------------------------
  // AC-08: Unauthenticated → 401
  // -------------------------------------------------------------------------

  it("returns 401 UNAUTHORIZED when not authenticated", async () => {
    const { body, contentType } = buildMultipartBody("photo.jpg", makeJpegBytes());
    const res = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  // -------------------------------------------------------------------------
  // AC-01: Legitimate formats → 201 + TEMP + correct DTO
  // -------------------------------------------------------------------------

  it("accepts a valid JPEG and returns 201 with AttachmentDto (status=TEMP)", async () => {
    const fileBytes = makeJpegBytes(200);
    const { body, contentType } = buildMultipartBody("receipt.jpg", fileBytes);

    const res = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { "content-type": contentType, cookie: sessionCookie },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    const json = JSON.parse(res.body);
    const att = json.attachment;

    expect(att.id).toBeTypeOf("string");
    expect(att.status).toBe("TEMP");
    expect(att.mimeType).toBe("image/jpeg");
    expect(att.byteSize).toBe(fileBytes.length);
    expect(att.originalFilename).toBe("receipt.jpg");
    expect(att.refType).toBeNull();
    expect(att.refId).toBeNull();
    expect(att.previewUrl).toBe(`/attachments/${att.id}/thumbnail`);
    expect(att.downloadUrl).toBe(`/attachments/${att.id}/content`);

    // DTO must NOT expose storageKey or absolute paths
    expect(JSON.stringify(att)).not.toContain("storageKey");
    expect(JSON.stringify(att)).not.toContain(storageRoot);

    // DB record must exist as TEMP
    const dbRecord = await prisma.attachment.findUnique({ where: { id: att.id } });
    if (!dbRecord) throw new Error("DB record not found after successful upload");
    expect(dbRecord.status).toBe("TEMP");
    expect(dbRecord.ownerId).toBe(userId);
    expect(dbRecord.uploaderId).toBe(userId);

    createdAttachmentIds.push(att.id);
  });

  it("accepts a valid PNG and returns 201 with AttachmentDto", async () => {
    const fileBytes = makePngBytes(150);
    const { body, contentType } = buildMultipartBody("image.png", fileBytes);

    const res = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { "content-type": contentType, cookie: sessionCookie },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    const json = JSON.parse(res.body);
    const att = json.attachment;

    expect(att.status).toBe("TEMP");
    expect(att.mimeType).toBe("image/png");
    expect(att.originalFilename).toBe("image.png");

    // DB record must exist
    const dbRecord = await prisma.attachment.findUnique({ where: { id: att.id } });
    if (!dbRecord) throw new Error("DB record not found after successful PNG upload");
    expect(dbRecord.status).toBe("TEMP");

    createdAttachmentIds.push(att.id);
  });

  it("accepts a valid WebP and returns 201 with AttachmentDto", async () => {
    const fileBytes = makeWebpBytes(200);
    const { body, contentType } = buildMultipartBody("banner.webp", fileBytes);

    const res = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { "content-type": contentType, cookie: sessionCookie },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    const json = JSON.parse(res.body);
    const att = json.attachment;

    expect(att.status).toBe("TEMP");
    expect(att.mimeType).toBe("image/webp");

    // DB record must exist
    const dbRecord = await prisma.attachment.findUnique({ where: { id: att.id } });
    expect(dbRecord).not.toBeNull();

    createdAttachmentIds.push(att.id);
  });

  // -------------------------------------------------------------------------
  // AC-02: Disguised extension → 415 + no DB record + no orphan file (core security)
  // -------------------------------------------------------------------------

  it("rejects a file disguised as .jpg but containing PDF bytes — 415, no DB record, no orphan file (AC-02)", async () => {
    const filesBefore = countStorageFiles(storageRoot);

    const pdfBytes = makePdfBytes(100);
    const { body, contentType } = buildMultipartBody("receipt.jpg", pdfBytes); // .jpg extension, PDF content

    const res = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { "content-type": contentType, cookie: sessionCookie },
      payload: body,
    });

    expect(res.statusCode).toBe(415);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    // No DB record must have been created
    const dbCount = await prisma.attachment.count({ where: { ownerId: userId } });
    const countBefore = createdAttachmentIds.length;
    // The count of attachments owned by this user should not have increased
    // (createdAttachmentIds tracks successful uploads)
    expect(dbCount).toBe(countBefore);

    // No orphan files in storage
    const filesAfter = countStorageFiles(storageRoot);
    expect(filesAfter).toBe(filesBefore);
  });

  it("rejects a file disguised as .png but containing PDF bytes — 415 (AC-02)", async () => {
    const pdfBytes = makePdfBytes(100);
    const { body, contentType } = buildMultipartBody("photo.png", pdfBytes);

    const res = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { "content-type": contentType, cookie: sessionCookie },
      payload: body,
    });

    expect(res.statusCode).toBe(415);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("rejects a file disguised as .webp but containing text bytes — 415, no orphan file (AC-02)", async () => {
    const filesBefore = countStorageFiles(storageRoot);

    const textBytes = Buffer.from("Hello, this is plain text content!", "utf-8");
    const { body, contentType } = buildMultipartBody("banner.webp", textBytes);

    const res = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { "content-type": contentType, cookie: sessionCookie },
      payload: body,
    });

    expect(res.statusCode).toBe(415);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    // No orphan files
    const filesAfter = countStorageFiles(storageRoot);
    expect(filesAfter).toBe(filesBefore);
  });

  // -------------------------------------------------------------------------
  // AC-03: PDF and other unsupported formats → 415
  // -------------------------------------------------------------------------

  it("rejects a PDF file (honest .pdf extension) → 415 (AC-03)", async () => {
    const pdfBytes = makePdfBytes(100);
    const { body, contentType } = buildMultipartBody("document.pdf", pdfBytes);

    const res = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { "content-type": contentType, cookie: sessionCookie },
      payload: body,
    });

    expect(res.statusCode).toBe(415);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  // -------------------------------------------------------------------------
  // AC-04: File > size limit → 413
  // -------------------------------------------------------------------------

  it("rejects a file exceeding maxBytes → 413 PAYLOAD_TOO_LARGE (AC-04)", async () => {
    // Build a server with a small maxBytes for this test
    // We'll use the default server but send a file just over 10 MiB
    // To keep the test fast, build a small-limit server instead
    const smallStorageRoot = makeTempStorageRoot();
    let smallApp: FastifyInstance | null = null;

    try {
      // Build a test server; use ATTACHMENT_MAX_BYTES env override via option
      // Since BuildServerOptions does not expose maxBytes directly, we rely on the
      // env var. For the integration test, we send a file > the default 10 MiB limit.
      // To keep the test fast, we'll instead test by checking that the default 10 MiB
      // limit is enforced. We send exactly 10 MiB + 1 byte.
      //
      // However, reading 10 MiB in a test is slow. Instead, we temporarily use a
      // small server with process.env override.
      const originalMaxBytes = process.env.ATTACHMENT_MAX_BYTES;
      process.env.ATTACHMENT_MAX_BYTES = "1024"; // 1 KB for test speed

      smallApp = await buildServer({
        databaseUrl: DB_URL ?? "",
        logLevel: "error",
        storageRoot: smallStorageRoot,
      });
      await smallApp.ready();

      // Re-login on smallApp (it uses the same DB)
      const smallCookie = await loginUser(smallApp, USER_LOGIN, USER_PASSWORD);

      // Send 2 KB of valid JPEG bytes (exceeds 1 KB limit)
      const bigJpeg = makeJpegBytes(2048);
      const { body, contentType } = buildMultipartBody("big.jpg", bigJpeg);

      const res = await smallApp.inject({
        method: "POST",
        url: "/attachments",
        headers: { "content-type": contentType, cookie: smallCookie },
        payload: body,
      });

      expect(res.statusCode).toBe(413);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");

      // Restore env
      process.env.ATTACHMENT_MAX_BYTES = originalMaxBytes;
    } finally {
      if (smallApp) await smallApp.close();
      removeTempStorageRoot(smallStorageRoot);
    }
  });

  // -------------------------------------------------------------------------
  // AC-05: Empty file → 415
  // -------------------------------------------------------------------------

  it("rejects an empty file (0 bytes) → 415 UNSUPPORTED_MEDIA_TYPE (AC-05)", async () => {
    const emptyBytes = Buffer.alloc(0);
    const { body, contentType } = buildMultipartBody("empty.jpg", emptyBytes);

    const res = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { "content-type": contentType, cookie: sessionCookie },
      payload: body,
    });

    expect(res.statusCode).toBe(415);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  // -------------------------------------------------------------------------
  // Missing file field → 400
  // -------------------------------------------------------------------------

  it("returns 400 VALIDATION_ERROR when no file field is provided", async () => {
    const boundary = "----FormBoundary123";
    // Multipart body with a text field, not a file field named "file"
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="other"\r\n\r\nhello\r\n--${boundary}--\r\n`
    );
    const contentType = `multipart/form-data; boundary=${boundary}`;

    const res = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { "content-type": contentType, cookie: sessionCookie },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  // -------------------------------------------------------------------------
  // AC-01 + thumbnail: storage keys exist after successful upload
  // -------------------------------------------------------------------------

  it("stores original file in storage root after successful JPEG upload", async () => {
    const filesBefore = countStorageFiles(storageRoot);

    const fileBytes = makeJpegBytes(300);
    const { body, contentType } = buildMultipartBody("check-storage.jpg", fileBytes);

    const res = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { "content-type": contentType, cookie: sessionCookie },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    const json = JSON.parse(res.body);
    createdAttachmentIds.push(json.attachment.id);

    // At least one new file should exist in storage (original; thumbnail may or may not be present)
    const filesAfter = countStorageFiles(storageRoot);
    expect(filesAfter).toBeGreaterThan(filesBefore);
  });

  // -------------------------------------------------------------------------
  // Log safety (§9.4): response body must not expose storageRoot path
  // -------------------------------------------------------------------------

  it("response body does not contain the storage root path (log safety §9.4)", async () => {
    const fileBytes = makePngBytes(200);
    const { body, contentType } = buildMultipartBody("safe.png", fileBytes);

    const res = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { "content-type": contentType, cookie: sessionCookie },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(storageRoot);

    const json = JSON.parse(res.body);
    createdAttachmentIds.push(json.attachment.id);
  });

  // -------------------------------------------------------------------------
  // Orphan prevention: after disguised-file rejection, no orphan files remain
  // (already covered in AC-02 test above, this one verifies ELF content)
  // -------------------------------------------------------------------------

  it("no orphan storage files after ELF/executable disguised as .jpg is rejected", async () => {
    const filesBefore = countStorageFiles(storageRoot);

    // ELF magic: 7F 45 4C 46
    const elfBytes = Buffer.alloc(100, 0);
    elfBytes[0] = 0x7f;
    elfBytes[1] = 0x45; // E
    elfBytes[2] = 0x4c; // L
    elfBytes[3] = 0x46; // F

    const { body, contentType } = buildMultipartBody("shell.jpg", elfBytes);

    const res = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { "content-type": contentType, cookie: sessionCookie },
      payload: body,
    });

    expect(res.statusCode).toBe(415);

    const filesAfter = countStorageFiles(storageRoot);
    expect(filesAfter).toBe(filesBefore);
  });
});
