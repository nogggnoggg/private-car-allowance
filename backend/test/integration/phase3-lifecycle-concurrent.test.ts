/**
 * Integration tests: PHASE-003-T6 — Concurrent linkAttachment TOCTOU guard
 *
 * This test calls the service layer directly with a real PrismaClient (connection pool),
 * NOT via HTTP inject. HTTP inject in Fastify is sequential — it does not create true
 * DB-level concurrency. Only calling the service function directly via Promise.all
 * with a real connection pool exercises true concurrent DB transactions.
 *
 * What is tested:
 *   Two concurrent linkAttachment() calls targeting the same (refType, refId) container
 *   with limit=1. Under READ COMMITTED, both could see count=0 and both succeed.
 *   With SERIALIZABLE isolation + P2034 retry, exactly one succeeds and the other
 *   receives TOO_MANY_ATTACHMENTS (or is retried and then sees count=1 → TOO_MANY).
 *
 * Test is run 5 times in a loop to reduce the probability of false-positive passing
 * (a sequential fluke in one iteration might look like success).
 *
 * TOCTOU mechanism (definitive, per remediation round):
 *   prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
 *   Serializable prevents phantom reads: if two transactions concurrently count the same
 *   container, Postgres detects the conflict at commit time and aborts one with error P2034
 *   (serialization failure). The retried transaction then sees the committed count and
 *   correctly rejects with TOO_MANY_ATTACHMENTS.
 *
 * Advisory lock alternative (rejected):
 *   pg_advisory_xact_lock(hash(refType+refId)) would also serialize, but requires raw SQL
 *   via prisma.$queryRaw, adding complexity. SERIALIZABLE is the standard Postgres mechanism,
 *   cleaner and sufficient for this workload (contention is per-container, low frequency).
 */

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linkAttachment } from "../../src/attachment/lifecycle-service.js";
import { hashPassword } from "../../src/auth/password.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

describeWithDb("PHASE-003-T6 — concurrent linkAttachment TOCTOU guard (service layer)", () => {
  let prisma: PrismaClient;
  let ownerId: string;
  const LOGIN_NAME = `t6_concurrent_${Date.now()}`;
  const createdAttachmentIds: string[] = [];

  // ---------------------------------------------------------------------------
  // Setup / teardown
  // ---------------------------------------------------------------------------

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword("ConcurrPass99!");
    const user = await prisma.user.create({
      data: {
        loginName: LOGIN_NAME,
        displayName: "T6 Concurrent Test User",
        passwordHash: hash,
        isActive: true,
        mustChangePassword: false,
      },
    });
    ownerId = user.id;
  });

  afterAll(async () => {
    if (prisma) {
      if (createdAttachmentIds.length > 0) {
        await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
      }
      await prisma.attachment.deleteMany({ where: { ownerId } });
      await prisma.user.deleteMany({ where: { loginName: LOGIN_NAME } });
      await prisma.$disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // Helper: create a TEMP attachment directly in DB (no HTTP)
  // ---------------------------------------------------------------------------

  async function createTempAttachment(suffix: string) {
    const att = await prisma.attachment.create({
      data: {
        storageKey: `att/t6-concurrent-${suffix}/original`,
        mimeType: "image/jpeg",
        byteSize: 1024,
        originalFilename: "concurrent-test.jpg",
        uploaderId: ownerId,
        ownerId,
        status: "TEMP",
      },
    });
    createdAttachmentIds.push(att.id);
    return att;
  }

  // ---------------------------------------------------------------------------
  // Actor mock (matches CurrentUser shape)
  // ---------------------------------------------------------------------------

  function makeActor() {
    return {
      id: ownerId,
      role: "USER" as const,
      mustChangePassword: false,
      isActive: true,
    };
  }

  // ---------------------------------------------------------------------------
  // True concurrent test — repeated 5 times to reduce false-positive probability
  // ---------------------------------------------------------------------------

  it("concurrent linkAttachment with limit=1: exactly one succeeds (TOCTOU guard, 5 iterations)", async () => {
    const actor = makeActor();

    for (let iteration = 0; iteration < 5; iteration++) {
      const refId = `t6-conc-iter-${Date.now()}-${iteration}-${Math.random().toString(36).slice(2)}`;

      // Create two TEMP attachments for this iteration
      const att1 = await createTempAttachment(`${Date.now()}-iter${iteration}-a`);
      const att2 = await createTempAttachment(`${Date.now()}-iter${iteration}-b`);

      // Track for cleanup
      createdAttachmentIds.push(att1.id, att2.id);

      // Fire both linkAttachment calls truly concurrently via Promise.allSettled
      // (not HTTP inject — real PrismaClient connection pool creates real DB concurrency)
      const results = await Promise.allSettled([
        linkAttachment(prisma, {
          attachmentId: att1.id,
          refType: "TRIP_SEGMENT",
          refId,
          limit: 1,
          containerState: "draft",
          actor,
        }),
        linkAttachment(prisma, {
          attachmentId: att2.id,
          refType: "TRIP_SEGMENT",
          refId,
          limit: 1,
          containerState: "draft",
          actor,
        }),
      ]);

      const successes = results.filter((r) => r.status === "fulfilled");
      const failures = results.filter((r) => r.status === "rejected");

      // CRITICAL: at most 1 success (limit=1 — never both succeed)
      expect(
        successes.length,
        `Iteration ${iteration}: both concurrent link calls succeeded — TOCTOU NOT prevented`
      ).toBeLessThanOrEqual(1);

      // At least 1 must succeed (the other should be rejected)
      expect(
        successes.length,
        `Iteration ${iteration}: neither concurrent link call succeeded — unexpected`
      ).toBeGreaterThanOrEqual(1);

      // The failure must be TOO_MANY_ATTACHMENTS (or CONFLICT if second checked status first)
      for (const f of failures) {
        const err = (f as PromiseRejectedResult).reason as {
          code?: string;
          httpStatus?: number;
        };
        expect(
          ["TOO_MANY_ATTACHMENTS", "CONFLICT"],
          `Iteration ${iteration}: rejected with unexpected code: ${err?.code}`
        ).toContain(err?.code);
      }

      // DB assertion: total LINKED count for this refId must be exactly 1
      const linkedCount = await prisma.attachment.count({
        where: { refId, status: "LINKED" },
      });
      expect(
        linkedCount,
        `Iteration ${iteration}: DB has ${linkedCount} LINKED for refId=${refId}, expected exactly 1`
      ).toBe(1);
    }
  }, 30000); // 30s timeout for 5 iterations

  // ---------------------------------------------------------------------------
  // Sanity: serializable isolation error (P2034) is retried and resolves correctly
  //
  // This test intentionally serializes (sequential) to verify that:
  //   - A limit=1 container with 1 existing LINKED → a new link attempt → TOO_MANY
  //   - This is the steady-state behavior after a retry resolves serialization
  // ---------------------------------------------------------------------------

  it("after one link succeeds, second attempt (sequential) returns TOO_MANY_ATTACHMENTS", async () => {
    const actor = makeActor();
    const refId = `t6-sanity-seq-${Date.now()}`;

    const att1 = await createTempAttachment(`sanity-a-${Date.now()}`);
    const att2 = await createTempAttachment(`sanity-b-${Date.now()}`);

    // First link: succeeds
    const result1 = await linkAttachment(prisma, {
      attachmentId: att1.id,
      refType: "MAINTENANCE",
      refId,
      limit: 1,
      containerState: "draft",
      actor,
    });
    expect(result1.status).toBe("LINKED");

    // Second link (sequential): should fail TOO_MANY_ATTACHMENTS
    await expect(
      linkAttachment(prisma, {
        attachmentId: att2.id,
        refType: "MAINTENANCE",
        refId,
        limit: 1,
        containerState: "draft",
        actor,
      })
    ).rejects.toMatchObject({ code: "TOO_MANY_ATTACHMENTS", httpStatus: 409 });
  });
});
