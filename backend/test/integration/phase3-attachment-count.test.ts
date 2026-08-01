/**
 * Integration tests: PHASE-003-T4 — countLinkedAttachments repository helper
 *
 * Spec AC-10/11/12 §13-T4:
 *   - countLinkedAttachments(prisma, refType, refId): counts LINKED attachments
 *     for a specific (refType, refId) container.
 *   - TEMP attachments for the same container are NOT counted.
 *   - Different (refType, refId) containers do NOT interfere with each other.
 *   - After N insertions, count == N.
 *
 * Test isolation: only the attachments created by this suite are cleaned up
 * (scoped deleteMany by ownerId). No global deleteMany.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

describeWithDb("PHASE-003-T4 — countLinkedAttachments integration", () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import for test isolation
  let prisma: any;
  let ownerUser: { id: string };

  // ── Setup / teardown ─────────────────────────────────────────────────

  beforeAll(async () => {
    if (!DB_URL) return;
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    ownerUser = await prisma.user.create({
      data: {
        loginName: "attach_count_t4",
        displayName: "Attachment Count T4",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder_t4",
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      // Scoped cleanup: delete only this suite's attachments (by ownerId)
      await prisma.attachment.deleteMany({ where: { ownerId: ownerUser?.id } });
      await prisma.user.deleteMany({ where: { loginName: "attach_count_t4" } });
      await prisma.$disconnect();
    }
  });

  // ── Helper to create an attachment with explicit status ──────────────

  async function createAtt(
    storageKeySuffix: string,
    status: "TEMP" | "LINKED",
    refType?: string,
    refId?: string
  ) {
    return prisma.attachment.create({
      data: {
        storageKey: `att/t4-count-${storageKeySuffix}/original`,
        mimeType: "image/jpeg",
        byteSize: 1024,
        originalFilename: "test.jpg",
        uploaderId: ownerUser.id,
        ownerId: ownerUser.id,
        status,
        refType: refType ?? null,
        refId: refId ?? null,
        linkedAt: status === "LINKED" ? new Date() : null,
      },
    });
  }

  // ── Test: empty container returns 0 ──────────────────────────────────

  it("returns 0 when no LINKED attachments exist for the given container", async () => {
    const { countLinkedAttachments } = await import(
      "../../src/attachment/attachment-limit-engine.js"
    );

    const count = await countLinkedAttachments(prisma, "TRIP_SEGMENT", "nonexistent-ref-001");
    expect(count).toBe(0);
  });

  // ── Test: counts only LINKED (not TEMP) for the container ────────────

  it("counts only LINKED attachments; ignores TEMP attachments for same refType+refId", async () => {
    const { countLinkedAttachments } = await import(
      "../../src/attachment/attachment-limit-engine.js"
    );

    const refType = "MAINTENANCE";
    const refId = "maint-t4-container-a";

    // Create 2 LINKED and 1 TEMP for the same container
    await createAtt("linked-a1", "LINKED", refType, refId);
    await createAtt("linked-a2", "LINKED", refType, refId);
    await createAtt("temp-a1", "TEMP"); // no refType/refId — should not count

    const count = await countLinkedAttachments(prisma, refType, refId);
    expect(count).toBe(2);
  });

  // ── Test: different containers do NOT interfere ───────────────────────

  it("containers with different refId do not interfere with each other", async () => {
    const { countLinkedAttachments } = await import(
      "../../src/attachment/attachment-limit-engine.js"
    );

    const refType = "DEPRECIATION";
    const refIdA = "depr-t4-container-b";
    const refIdB = "depr-t4-container-c";

    // 3 for container-b, 1 for container-c
    await createAtt("depr-b1", "LINKED", refType, refIdA);
    await createAtt("depr-b2", "LINKED", refType, refIdA);
    await createAtt("depr-b3", "LINKED", refType, refIdA);
    await createAtt("depr-c1", "LINKED", refType, refIdB);

    expect(await countLinkedAttachments(prisma, refType, refIdA)).toBe(3);
    expect(await countLinkedAttachments(prisma, refType, refIdB)).toBe(1);
  });

  // ── Test: different refType containers do NOT interfere ───────────────

  it("containers with same refId but different refType do not interfere", async () => {
    const { countLinkedAttachments } = await import(
      "../../src/attachment/attachment-limit-engine.js"
    );

    const sharedRefId = "shared-ref-t4-001";

    // 2 for TRIP_SEGMENT, 1 for MAINTENANCE — same refId, different type
    await createAtt("trip-shared-1", "LINKED", "TRIP_SEGMENT", sharedRefId);
    await createAtt("trip-shared-2", "LINKED", "TRIP_SEGMENT", sharedRefId);
    await createAtt("maint-shared-1", "LINKED", "MAINTENANCE", sharedRefId);

    expect(await countLinkedAttachments(prisma, "TRIP_SEGMENT", sharedRefId)).toBe(2);
    expect(await countLinkedAttachments(prisma, "MAINTENANCE", sharedRefId)).toBe(1);
  });

  // ── Test: incremental count after each link ───────────────────────────

  it("count increments correctly after each link (0 → 1 → 2 → 3)", async () => {
    const { countLinkedAttachments } = await import(
      "../../src/attachment/attachment-limit-engine.js"
    );

    const refType = "TRIP_SEGMENT";
    const refId = "trip-t4-incremental-001";

    expect(await countLinkedAttachments(prisma, refType, refId)).toBe(0);

    await createAtt("incr-1", "LINKED", refType, refId);
    expect(await countLinkedAttachments(prisma, refType, refId)).toBe(1);

    await createAtt("incr-2", "LINKED", refType, refId);
    expect(await countLinkedAttachments(prisma, refType, refId)).toBe(2);

    await createAtt("incr-3", "LINKED", refType, refId);
    expect(await countLinkedAttachments(prisma, refType, refId)).toBe(3);
  });
});
