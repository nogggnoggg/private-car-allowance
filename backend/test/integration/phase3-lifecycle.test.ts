/**
 * Integration tests: PHASE-003-T6 — Lifecycle: link, detach, delete
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MIGRATED — PHASE-004-T11 (D12, AR-D 閉環)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The public `POST /attachments/:id/link` endpoint this file originally
 * exercised has been REMOVED (Spec §17.1 D12): it let a client self-supply
 * `limit` (bypass the 3/segment cap), `refId` (link to any container), and
 * `containerState` (claim 'draft' to bypass completion lock) — a real
 * authorization bypass once PHASE-004 has real completed applications
 * (AR-D). See `docs/specs/PHASE-004.md` §17 Spec 修訂紀錄
 * （2026-08-02「測試策略澄清」列, commit c5fc3cb) for the governance decision
 * authorizing this migration (治理 2026-08-01.2 §11.2「測試策略屬 AI 可修改
 * 但必須記錄」).
 *
 * Every test below has been migrated, NOT deleted or weakened: the BEHAVIOR
 * each one protects (owner-403, limit-409, duplicate-link-409,
 * completed-container-403, unauthenticated-401, malformed-request-400) still
 * exists in PHASE-004 — only the ENTRY POINT changed, from
 * `POST /attachments/:id/link` to `PUT /applications/travel/:id`'s
 * `segments[].attachmentIds[]` (the only remaining way to link an
 * attachment). `DELETE /attachments/:id` tests that never depended on the
 * removed endpoint are UNCHANGED.
 *
 * Test count: 20 before migration, 21 after PHASE-004-T11R2 (§17 修訂紀錄
 * requirement: 不得減少 — one net addition, an AC-22 single-request
 * discriminating test, see below). See PHASE-004-T11 Task Handoff for the
 * original 20→20 mapping table.
 *
 * AR-D discriminating tests (client-supplied `limit`/`containerState` are now
 * provably inert; the removed link endpoint now 404s) live in the NEW file
 * `phase4-attachment-ard.test.ts` — not duplicated here (裁定: 「不要重複
 * 實作」). The one exception is the B-30/D19 concurrency scenario (this
 * file's original last test): it is migrated here in place AND re-asserted
 * with a slightly different angle in `phase4-attachment-ard.test.ts` (that
 * file's Done-When explicitly requires a B-30 test) — see that file's header
 * comment for why both exist.
 *
 * Original PHASE-003-T6 AC coverage (unchanged in substance):
 *   AC-14: TEMP attachment can be linked → status becomes LINKED, refType/refId/linkedAt written
 *   AC-15: LINKED attachment can be detached via DELETE → status returns to TEMP
 *   AC-16: container state=completed → DELETE returns 403 FORBIDDEN
 *   AC-16: container state=completed → link (now: PUT attachmentIds) returns 403 FORBIDDEN
 *   AC-10: link when count reaches limit → 409 TOO_MANY_ATTACHMENTS
 *   Non-TEMP (LINKED) attachment → link (now: PUT attachmentIds) rejected 409 CONFLICT
 *   Non-owner requesting link/PUT → 403 FORBIDDEN
 *   Non-owner requesting DELETE → 403 FORBIDDEN
 *   Unauthenticated → 401
 *   TEMP attachment DELETE → record removed (pure TEMP delete, AC-15 supplement)
 *   Detach resets createdAt (TTL base restarted per §4.5/Packet D2)
 *
 * PHASE-004-T11R2 (Spec §17 D19, 使用者 2026-08-02 批准): the "concurrent link"
 * test below was re-asserted, NOT weakened — its ORIGINAL assertion
 * ([200, 409], "only one succeeds") assumed an INCREMENTAL `link` semantic
 * that no longer applies once it races on the full-PUT-replace endpoint (D15):
 * two concurrent full PUTs, each declaring its OWN complete, individually
 * VALID attachment set for the same segment, are not a capacity conflict at
 * all under D15/D19 — they are two different "this segment's final state is
 * X" declarations, and the later one legitimately wins. The real invariant —
 * the segment's LINKED count never exceeding `SEGMENT_ATTACHMENT_LIMIT` — is
 * asserted via `linkedCount`, not via one side losing. AC-22 (a single
 * request declaring an over-cap set must be rejected) is untouched by D19 and
 * now has its own dedicated single-request test immediately after.
 *
 * Test isolation: all users/attachments/applications/sessions created here
 * are cleaned up in afterAll, scoped to this suite's own created ids.
 * Storage root: isolated temp directory per run.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEGMENT_ATTACHMENT_LIMIT } from "../../src/applications/travel-service.js";
import { buildMinimalHeader } from "../../src/attachment/detect-mime.js";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";
import { LocalVolumeStorage } from "../../src/storage/index.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

// Per-process unique suffix for seed loginNames. Prevents cross-file/cross-fork
// collisions when this file and another test file (e.g. middleware.test.ts)
// evaluate module-level `Date.now()`-based seeds within the same millisecond
// under vitest's default parallel `pool: forks` execution.
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

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

describeWithDb("PHASE-003-T6 — Lifecycle: link, detach, delete (migrated PHASE-004-T11)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let storageRoot: string;

  // Owner user (regular) — plays "application owner" in the migrated tests.
  const OWNER_LOGIN = `t6_owner_${RUN_ID}`;
  const OWNER_PASSWORD = "OwnerPass99!";
  let ownerCookie: string;
  let ownerId: string;

  // Other regular user — plays "cross-owner attachment" in AC-30-style tests.
  const OTHER_LOGIN = `t6_other_${RUN_ID}`;
  const OTHER_PASSWORD = "OtherPass99!";
  let otherCookie: string;
  let otherId: string;

  // Admin user
  const ADMIN_LOGIN = `t6_admin_${RUN_ID}`;
  const ADMIN_PASSWORD = "AdminPass99!";
  let adminCookie: string;

  // Track created attachments/applications for cleanup
  const createdAttachmentIds: string[] = [];
  const createdApplicationIds: string[] = [];

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
    const otherUser = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "T6 Other",
        passwordHash: otherHash,
        isActive: true,
        mustChangePassword: false,
      },
    });
    otherId = otherUser.id;

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
      // Scoped cleanup — delete all attachments/applications created by this suite.
      if (createdAttachmentIds.length > 0) {
        await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
      }
      if (createdApplicationIds.length > 0) {
        await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
      }
      // Safety net: clean any remaining attachments by ownerId (owner or other).
      await prisma.attachment.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } });
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

  /** Upload a JPEG as a given actor (cookie); return the attachment id. Optional ownerId query (D11). */
  async function uploadAs(cookie: string, filename: string, ownerId?: string): Promise<string> {
    const { body, contentType } = buildMultipartBody(filename, makeJpegBytes());
    const url = ownerId ? `/attachments?ownerId=${ownerId}` : "/attachments";
    const res = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": contentType, cookie },
      payload: body,
    });
    if (res.statusCode !== 201) throw new Error(`Upload failed: ${res.statusCode} ${res.body}`);
    const { attachment } = JSON.parse(res.body);
    createdAttachmentIds.push(attachment.id);
    return attachment.id;
  }

  /** Upload a JPEG as the owner; return the attachment id (most common case). */
  async function uploadAsOwner(filename = "test.jpg"): Promise<string> {
    return uploadAs(ownerCookie, filename);
  }

  /** DELETE /attachments/:id helper */
  async function deleteAttachment(attachmentId: string, cookie: string, query?: string) {
    return app.inject({
      method: "DELETE",
      url: `/attachments/${attachmentId}${query ? `?${query}` : ""}`,
      headers: { cookie },
    });
  }

  /**
   * PHASE-004-T11: create a bare travel draft (POST /applications/travel) as
   * the given actor, then PUT a single segment (no attachmentIds — three-state
   * "absent" — so this never touches attachments). Returns the application id
   * and the new segment's id. This is the "container" every migrated
   * link-equivalent test below operates on.
   */
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

  /**
   * PHASE-004-T11: PUT a draft's segments[] — the ONLY remaining way to
   * link/detach attachments (replaces the removed `POST /attachments/:id/link`).
   * `segments` is the full array to submit (id-diff semantics, D15) — callers
   * pass through whichever segments they want to affect, e.g. `{ id: segmentId,
   * attachmentIds: [...] }`; segments omitted entirely from a prior draft would
   * be DELETED (full-replace PUT semantics), so multi-segment scenarios must
   * include every segment they want to keep.
   */
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

  /** Directly mark an Application COMPLETED via Prisma (T8 完成端點尚未實作 — 大總管裁定：測試中直接設定 status). */
  async function markCompleted(applicationId: string): Promise<void> {
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: "COMPLETED", completedAt: new Date(), totalAmount: 1 },
    });
  }

  // ---------------------------------------------------------------------------
  // #1 (was: "POST /attachments/:id/link returns 401 UNAUTHORIZED") — MIGRATED
  // ---------------------------------------------------------------------------

  it("PUT /applications/travel/:id (attachmentIds) returns 401 UNAUTHORIZED when not authenticated", async () => {
    const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
    const attId = await uploadAsOwner("unauth-link.jpg");
    const res = await app.inject({
      method: "PUT",
      url: `/applications/travel/${applicationId}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ segments: [{ id: segmentId, attachmentIds: [attId] }] }),
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("UNAUTHORIZED");
  });

  // ---------------------------------------------------------------------------
  // #2 (was: "DELETE /attachments/:id returns 401 UNAUTHORIZED") — UNCHANGED
  // (never depended on the removed /link endpoint)
  // ---------------------------------------------------------------------------

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
  // #3 (was: "POST /attachments/:id/link links a TEMP attachment → 200 LINKED (AC-14)") — MIGRATED
  // ---------------------------------------------------------------------------

  it("PUT attachmentIds links a TEMP attachment → segment shows LINKED status (AC-14)", async () => {
    const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
    const attId = await uploadAsOwner("link-success.jpg");

    const res = await putDraft(ownerCookie, applicationId, [
      { id: segmentId, attachmentIds: [attId] },
    ]);
    expect(res.statusCode).toBe(200);
    const segment = JSON.parse(res.body).application.segments[0];
    expect(segment.attachments).toHaveLength(1);
    expect(segment.attachments[0].id).toBe(attId);
    expect(segment.attachments[0].status).toBe("LINKED");

    // Verify DB state
    const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(dbAtt?.status).toBe("LINKED");
    expect(dbAtt?.refType).toBe("TRIP_SEGMENT");
    expect(dbAtt?.refId).toBe(segmentId);
    expect(dbAtt?.linkedAt).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // #4-#6 (was: "POST /attachments/:id/link returns 400 VALIDATION_ERROR when
  // body is missing refType/refId/limit") — MIGRATED. The new request shape
  // has no refType/refId/limit fields at all (only attachmentIds[]); the
  // equivalent malformed-request theme is "attachmentIds is not a well-formed
  // string array" — same error code (400 VALIDATION_ERROR), same "reject
  // malformed link request" intent.
  // ---------------------------------------------------------------------------

  it("PUT attachmentIds returns 400 VALIDATION_ERROR when attachmentIds is not an array", async () => {
    const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
    const res = await putDraft(ownerCookie, applicationId, [
      { id: segmentId, attachmentIds: "not-an-array" },
    ]);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("VALIDATION_ERROR");
  });

  it("PUT attachmentIds returns 400 VALIDATION_ERROR when an element is an empty string", async () => {
    const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
    const res = await putDraft(ownerCookie, applicationId, [
      { id: segmentId, attachmentIds: [""] },
    ]);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("VALIDATION_ERROR");
  });

  it("PUT attachmentIds returns 400 VALIDATION_ERROR when an element is not a string", async () => {
    const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
    const res = await putDraft(ownerCookie, applicationId, [
      { id: segmentId, attachmentIds: [12345] },
    ]);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("VALIDATION_ERROR");
  });

  // ---------------------------------------------------------------------------
  // #7 (was: "POST /attachments/:id/link returns 409 TOO_MANY_ATTACHMENTS
  // when limit reached (AC-10)") — MIGRATED. Client can no longer supply
  // `limit` at all; the cap is the backend constant SEGMENT_ATTACHMENT_LIMIT.
  // ---------------------------------------------------------------------------

  it("PUT attachmentIds returns 409 TOO_MANY_ATTACHMENTS when the segment is already at capacity (AC-10/AC-22)", async () => {
    const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
    const atts: string[] = [];
    for (let i = 0; i < SEGMENT_ATTACHMENT_LIMIT; i++) {
      atts.push(await uploadAsOwner(`limit-fill-${i}.jpg`));
    }
    const fillRes = await putDraft(ownerCookie, applicationId, [
      { id: segmentId, attachmentIds: atts },
    ]);
    expect(fillRes.statusCode).toBe(200);

    const extra = await uploadAsOwner("limit-overflow.jpg");
    const res = await putDraft(ownerCookie, applicationId, [
      { id: segmentId, attachmentIds: [...atts, extra] },
    ]);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("TOO_MANY_ATTACHMENTS");

    // extra must remain TEMP (not linked); rollback means the whole PUT failed
    const dbExtra = await prisma.attachment.findUnique({ where: { id: extra } });
    expect(dbExtra?.status).toBe("TEMP");
    const linkedCount = await prisma.attachment.count({
      where: { refType: "TRIP_SEGMENT", refId: segmentId, status: "LINKED" },
    });
    expect(linkedCount).toBe(SEGMENT_ATTACHMENT_LIMIT);
  });

  // ---------------------------------------------------------------------------
  // #8 (was: "POST /attachments/:id/link returns 409 CONFLICT when attachment
  // is already LINKED") — MIGRATED. Same attachment referenced by two
  // segments' attachmentIds within ONE PUT (segment A keeps it via omitted
  // attachmentIds key = unchanged; segment B tries to claim it too).
  // ---------------------------------------------------------------------------

  it("PUT attachmentIds returns 409 CONFLICT when an attachment is already LINKED elsewhere (B-17)", async () => {
    const { applicationId, segmentId: segA } = await createDraftWithSegment(ownerCookie);
    // Add a second segment B to the same application.
    const secondSegResp = await putDraft(ownerCookie, applicationId, [
      { id: segA },
      { origin: "B起點", destination: "B終點" },
    ]);
    expect(secondSegResp.statusCode).toBe(200);
    const segB = JSON.parse(secondSegResp.body).application.segments[1].id as string;

    const attId = await uploadAsOwner("already-linked.jpg");

    // Link to segment A first.
    const res1 = await putDraft(ownerCookie, applicationId, [
      { id: segA, attachmentIds: [attId] },
      { id: segB },
    ]);
    expect(res1.statusCode).toBe(200);

    // Second PUT: segment A untouched (attachmentIds key omitted = keep as-is,
    // still LINKED to A), segment B tries to claim the SAME attachment → 409.
    const res2 = await putDraft(ownerCookie, applicationId, [
      { id: segA },
      { id: segB, attachmentIds: [attId] },
    ]);
    expect(res2.statusCode).toBe(409);
    const json = JSON.parse(res2.body);
    expect(json.error.code).toBe("CONFLICT");

    // Attachment must remain linked to segment A (rollback of the failed PUT).
    const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(dbAtt?.status).toBe("LINKED");
    expect(dbAtt?.refId).toBe(segA);
  });

  // ---------------------------------------------------------------------------
  // #9 (was: "POST /attachments/:id/link returns 403 FORBIDDEN when
  // containerState=completed (AC-16)") — MIGRATED to a REAL completed
  // Application (no client flag involved at all — the pure positive case;
  // the "even with a client override attempt" reverse-assertions live in
  // phase4-attachment-ard.test.ts, not duplicated here).
  // ---------------------------------------------------------------------------

  it("PUT attachmentIds on a COMPLETED application's segment → 403 FORBIDDEN (AC-16/26)", async () => {
    const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
    const attId = await uploadAsOwner("completed-link.jpg");
    await markCompleted(applicationId);

    const res = await putDraft(ownerCookie, applicationId, [
      { id: segmentId, attachmentIds: [attId] },
    ]);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");

    // Attachment must remain TEMP — no partial linking.
    const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(dbAtt?.status).toBe("TEMP");
  });

  // ---------------------------------------------------------------------------
  // #10 (was: "POST /attachments/:id/link returns 403 FORBIDDEN when another
  // user tries to link") — MIGRATED to AC-30 (附件擁有人 ≠ 申請擁有人).
  //
  // Semantic mapping: the original threat was "actor ≠ attachment owner"
  // (guarded by assertOwnershipOrAdmin inside the removed link endpoint).
  // Under PHASE-004-T11, the actor is ALREADY authorized against the
  // APPLICATION (assertOwnershipOrAdmin on the PUT route, tested exhaustively
  // in phase4-travel-draft.test.ts's 權限矩陣). The remaining, genuinely NEW
  // cross-user leak this architecture must close is "attachment.ownerId !==
  // application.ownerId" — AC-30 — which is exactly what this test now
  // exercises: same threat CLASS (prevent cross-user attachment mixing),
  // different specific gate (D11's new invariant instead of the old actor
  // check, which is still separately covered by existing 403 tests).
  // ---------------------------------------------------------------------------

  it("PUT attachmentIds returns 403 FORBIDDEN when the attachment belongs to a different user (AC-30)", async () => {
    const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
    const otherAttId = await uploadAs(otherCookie, "other-link.jpg");

    const res = await putDraft(ownerCookie, applicationId, [
      { id: segmentId, attachmentIds: [otherAttId] },
    ]);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");

    const dbAtt = await prisma.attachment.findUnique({ where: { id: otherAttId } });
    expect(dbAtt?.status).toBe("TEMP");
  });

  // ---------------------------------------------------------------------------
  // #11 (was: "POST /attachments/:id/link allows admin to link any
  // attachment (AC-09 family)") — MIGRATED to admin on-behalf: admin uploads
  // FOR the draft's owner (D11 `?ownerId=`), then admin PUTs the owner's
  // draft (AC-80 admin-can-modify-any-draft) to link it. Exercises D11 +
  // AC-80 together — the modern equivalent of "admin bypasses the ownership
  // check other actors are subject to".
  // ---------------------------------------------------------------------------

  it("Admin can link an attachment into another user's draft on their behalf (D11 + AC-80)", async () => {
    const { applicationId, segmentId } = await createDraftWithSegment(otherCookie);
    const attId = await uploadAs(adminCookie, "admin-link.jpg", otherId);

    const res = await putDraft(adminCookie, applicationId, [
      { id: segmentId, attachmentIds: [attId] },
    ]);
    expect(res.statusCode).toBe(200);
    const segment = JSON.parse(res.body).application.segments[0];
    expect(segment.attachments[0].id).toBe(attId);

    const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(dbAtt?.status).toBe("LINKED");
    expect(dbAtt?.ownerId).toBe(otherId);
    expect(dbAtt?.uploaderId).not.toBe(otherId); // uploaded by admin, owned by other
  });

  // ---------------------------------------------------------------------------
  // #12 (was: "POST /attachments/:id/link returns 404 for non-existent
  // attachment") — MIGRATED (B-32).
  // ---------------------------------------------------------------------------

  it("PUT attachmentIds returns 404 NOT_FOUND for a non-existent attachment id (B-32)", async () => {
    const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
    const res = await putDraft(ownerCookie, applicationId, [
      { id: segmentId, attachmentIds: ["nonexistent-id-t6"] },
    ]);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("NOT_FOUND");
  });

  // ---------------------------------------------------------------------------
  // #13 (was: "DELETE /attachments/:id on LINKED attachment → detaches
  // (AC-15)") — MIGRATED setup only (link via PUT instead of the removed
  // endpoint); DELETE behavior itself is unchanged.
  // ---------------------------------------------------------------------------

  it("DELETE /attachments/:id on LINKED attachment → detaches (AC-15)", async () => {
    const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
    const attId = await uploadAsOwner("detach.jpg");
    const linkRes = await putDraft(ownerCookie, applicationId, [
      { id: segmentId, attachmentIds: [attId] },
    ]);
    expect(linkRes.statusCode).toBe(200);

    const before = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(before?.status).toBe("LINKED");

    const delRes = await deleteAttachment(attId, ownerCookie);
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.body)).toHaveProperty("ok", true);

    const after = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(after?.status).toBe("TEMP");
    expect(after?.refType).toBeNull();
    expect(after?.refId).toBeNull();
    expect(after?.linkedAt).toBeNull();

    // TTL base: createdAt should be updated to "now" (the detach time) per §4.5/D2 definition
    const now = Date.now();
    expect(after?.createdAt.getTime()).toBeGreaterThan(now - 5000);
    expect(after?.createdAt.getTime()).toBeLessThanOrEqual(now + 1000);
  });

  // ---------------------------------------------------------------------------
  // #14 (was: "after detach, attachment is no longer LINKED (reloading shows
  // TEMP state) (AC-15)") — MIGRATED setup; now also verifiable through the
  // real draft DTO's segment.attachments[] (richer than the original, which
  // could only query DB directly).
  // ---------------------------------------------------------------------------

  it("after detach, the draft's segment.attachments[] no longer shows it (AC-15/AC-25)", async () => {
    const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
    const attId = await uploadAsOwner("after-detach-reload.jpg");
    await putDraft(ownerCookie, applicationId, [{ id: segmentId, attachmentIds: [attId] }]);

    const delRes = await deleteAttachment(attId, ownerCookie);
    expect(delRes.statusCode).toBe(200);

    const getResp = await app.inject({
      method: "GET",
      url: `/applications/travel/${applicationId}`,
      headers: { cookie: ownerCookie },
    });
    const segment = JSON.parse(getResp.body).application.segments[0];
    expect(segment.attachments).toEqual([]);

    const reloaded = await prisma.attachment.findMany({
      where: { refId: segmentId, status: "LINKED" },
    });
    expect(reloaded).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // #15 (was: "DELETE /attachments/:id returns 403 FORBIDDEN when
  // containerState=completed (AC-16)") — MIGRATED to a REAL completed
  // Application, no client flag at all (the pure positive case; the
  // "client tries to override anyway" reverse-assertions live in
  // phase4-attachment-ard.test.ts, not duplicated here).
  // ---------------------------------------------------------------------------

  it("DELETE /attachments/:id on an attachment of a COMPLETED application → 403 FORBIDDEN (AC-16/26)", async () => {
    const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
    const attId = await uploadAsOwner("completed-delete.jpg");
    await putDraft(ownerCookie, applicationId, [{ id: segmentId, attachmentIds: [attId] }]);
    await markCompleted(applicationId);

    const res = await deleteAttachment(attId, ownerCookie);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");

    const dbAtt = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(dbAtt?.status).toBe("LINKED");
  });

  // ---------------------------------------------------------------------------
  // #16 (was: "DELETE /attachments/:id on TEMP attachment → removes DB record
  // and storage file") — UNCHANGED (never depended on the removed endpoint).
  // ---------------------------------------------------------------------------

  it("DELETE /attachments/:id on TEMP attachment → removes DB record and storage file", async () => {
    const attId = await uploadAsOwner("temp-delete.jpg");

    const before = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(before?.status).toBe("TEMP");
    const storageKey = before?.storageKey;

    const delRes = await deleteAttachment(attId, ownerCookie);
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.body)).toHaveProperty("ok", true);

    const after = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(after).toBeNull();

    if (storageKey) {
      const storage = new LocalVolumeStorage(storageRoot);
      const exists = await storage.exists(storageKey);
      expect(exists).toBe(false);
    }

    const idx = createdAttachmentIds.indexOf(attId);
    if (idx !== -1) createdAttachmentIds.splice(idx, 1);
  });

  // ---------------------------------------------------------------------------
  // #17 (was: "DELETE /attachments/:id returns 403 FORBIDDEN when another
  // user tries to delete") — UNCHANGED (never depended on the removed endpoint).
  // ---------------------------------------------------------------------------

  it("DELETE /attachments/:id returns 403 FORBIDDEN when another user tries to delete", async () => {
    const attId = await uploadAsOwner("other-delete.jpg");
    const res = await deleteAttachment(attId, otherCookie);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");
  });

  // ---------------------------------------------------------------------------
  // #18 (was: "DELETE /attachments/:id allows admin to delete any
  // attachment") — UNCHANGED (never depended on the removed endpoint).
  // ---------------------------------------------------------------------------

  it("DELETE /attachments/:id allows admin to delete any attachment", async () => {
    const attId = await uploadAsOwner("admin-delete.jpg");
    const delRes = await deleteAttachment(attId, adminCookie);
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.body)).toHaveProperty("ok", true);

    const idx = createdAttachmentIds.indexOf(attId);
    if (idx !== -1) createdAttachmentIds.splice(idx, 1);
  });

  // ---------------------------------------------------------------------------
  // #19 (was: "DELETE /attachments/:id returns 404 for non-existent
  // attachment") — UNCHANGED (never depended on the removed endpoint).
  // ---------------------------------------------------------------------------

  it("DELETE /attachments/:id returns 404 for non-existent attachment", async () => {
    const res = await deleteAttachment("nonexistent-t6-delete", ownerCookie);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("NOT_FOUND");
  });

  // ---------------------------------------------------------------------------
  // #20 (was: "concurrent link requests to a limit=1 container: only one
  // succeeds (TOCTOU guard)") — MIGRATED (B-30), then RE-ASSERTED per Spec §17
  // D19 (PHASE-004-T11R2, 使用者 2026-08-02 批准): the client can no longer
  // inject `limit`, so this races for the real, backend-fixed cap
  // (SEGMENT_ATTACHMENT_LIMIT=3) — but the two racing requests are FULL,
  // REPLACING `PUT`s (D15), not incremental `link` calls. Each concurrent PUT
  // declares its own complete, individually-VALID 3-attachment set for the
  // segment (2 shared fillers + 1 of its own). D19 "最後寫入者贏": BOTH such
  // requests succeed (200) — the later one's declared set is what the segment
  // ends up with — and the segment's LINKED count never exceeds the cap
  // regardless of which one committed last. `linkedCount` is the assertion
  // that actually proves no cap violation happened (not just "some 200s
  // occurred") — this is the test's core, not incidental.
  // ---------------------------------------------------------------------------

  it("concurrent full-PUT requests each declaring a valid attachment set for the same segment: both succeed, last writer wins, count never exceeds the cap (D19)", async () => {
    const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
    const filler: string[] = [];
    for (let i = 0; i < SEGMENT_ATTACHMENT_LIMIT - 1; i++) {
      filler.push(await uploadAsOwner(`concurrent-filler-${i}.jpg`));
    }
    const fillRes = await putDraft(ownerCookie, applicationId, [
      { id: segmentId, attachmentIds: filler },
    ]);
    expect(fillRes.statusCode).toBe(200);

    const att1 = await uploadAsOwner("concurrent1.jpg");
    const att2 = await uploadAsOwner("concurrent2.jpg");

    const [res1, res2] = await Promise.all([
      putDraft(ownerCookie, applicationId, [{ id: segmentId, attachmentIds: [...filler, att1] }]),
      putDraft(ownerCookie, applicationId, [{ id: segmentId, attachmentIds: [...filler, att2] }]),
    ]);

    expect([res1.statusCode, res2.statusCode]).toEqual([200, 200]);

    const linkedCount = await prisma.attachment.count({
      where: { refType: "TRIP_SEGMENT", refId: segmentId, status: "LINKED" },
    });
    expect(linkedCount).toBe(SEGMENT_ATTACHMENT_LIMIT);
  });

  // ---------------------------------------------------------------------------
  // AC-22 discriminating test (D19 does NOT touch this): a SINGLE request
  // declaring MORE attachments than the segment's cap must still be rejected
  // with 409 TOO_MANY_ATTACHMENTS — this is the actual body of AC-22 and is
  // unaffected by D19's "last writer wins" (D19 only concerns two DIFFERENT
  // concurrent requests each declaring a valid set; it never licenses one
  // request declaring an invalid, over-cap set).
  // ---------------------------------------------------------------------------

  it("a single PUT declaring more attachments than the segment cap → 409 TOO_MANY_ATTACHMENTS (AC-22)", async () => {
    const { applicationId, segmentId } = await createDraftWithSegment(ownerCookie);
    const overLimit: string[] = [];
    for (let i = 0; i < SEGMENT_ATTACHMENT_LIMIT + 1; i++) {
      overLimit.push(await uploadAsOwner(`over-limit-${i}.jpg`));
    }

    const res = await putDraft(ownerCookie, applicationId, [
      { id: segmentId, attachmentIds: overLimit },
    ]);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("TOO_MANY_ATTACHMENTS");

    const linkedCount = await prisma.attachment.count({
      where: { refType: "TRIP_SEGMENT", refId: segmentId, status: "LINKED" },
    });
    expect(linkedCount).toBe(0);
  });
});
