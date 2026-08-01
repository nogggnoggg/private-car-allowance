/**
 * Integration test: PHASE-003-T1 — Attachment data model + migration invariants.
 * TDD: written BEFORE schema change; expected to fail first (table does not exist).
 *
 * Requires a running Postgres instance with migrations already applied.
 * If DATABASE_URL is not set, tests are skipped with an explanatory message.
 *
 * Covers Done-When invariants (Spec §3.3 §13-T1):
 *  1. Can create a TEMP attachment with refType/refId = null.
 *  2. storageKey uniqueness — duplicate throws.
 *  3. LINKED requires refType+refId — application-layer service rejects missing values.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.DATABASE_URL;

const describeWithDb = DB_URL ? describe : describe.skip;

describeWithDb("PHASE-003-T1 — Attachment model + AttachmentStatus/AttachmentRefType enums", () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import for test isolation
  let prisma: any;
  let ownerUser: { id: string };

  beforeAll(async () => {
    if (!DB_URL) return;
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({
      datasources: { db: { url: DB_URL } },
    });
    await prisma.$connect();

    // Create a synthetic owner user for FK reference
    ownerUser = await prisma.user.create({
      data: {
        loginName: "attach_owner_t1",
        displayName: "Attachment Owner T1",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash_placeholder",
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      // Clean up in dependency order
      await prisma.attachment.deleteMany({});
      await prisma.user.deleteMany({ where: { loginName: "attach_owner_t1" } });
      await prisma.$disconnect();
    }
  });

  // -----------------------------------------------------------------------
  // Invariant 1: can create a TEMP attachment (refType/refId nullable)
  // -----------------------------------------------------------------------

  it("can create a TEMP attachment with all required fields and null refType/refId", async () => {
    const att = await prisma.attachment.create({
      data: {
        storageKey: "att/cuid-test-001/original",
        mimeType: "image/jpeg",
        byteSize: 102400,
        originalFilename: "receipt.jpg",
        uploaderId: ownerUser.id,
        ownerId: ownerUser.id,
        // status defaults to TEMP; refType/refId null by default
      },
    });

    expect(att.id).toBeTypeOf("string");
    expect(att.status).toBe("TEMP");
    expect(att.storageKey).toBe("att/cuid-test-001/original");
    expect(att.thumbnailKey).toBeNull();
    expect(att.mimeType).toBe("image/jpeg");
    expect(att.byteSize).toBe(102400);
    expect(att.originalFilename).toBe("receipt.jpg");
    expect(att.uploaderId).toBe(ownerUser.id);
    expect(att.ownerId).toBe(ownerUser.id);
    expect(att.refType).toBeNull();
    expect(att.refId).toBeNull();
    expect(att.linkedAt).toBeNull();
    expect(att.createdAt).toBeInstanceOf(Date);
    expect(att.updatedAt).toBeInstanceOf(Date);
  });

  it("can create a TEMP attachment with an optional thumbnailKey", async () => {
    const att = await prisma.attachment.create({
      data: {
        storageKey: "att/cuid-test-002/original",
        thumbnailKey: "att/cuid-test-002/thumb",
        mimeType: "image/png",
        byteSize: 512000,
        originalFilename: "photo.png",
        uploaderId: ownerUser.id,
        ownerId: ownerUser.id,
      },
    });

    expect(att.thumbnailKey).toBe("att/cuid-test-002/thumb");
    expect(att.status).toBe("TEMP");
  });

  it("supports all three MIME types: image/jpeg, image/png, image/webp", async () => {
    const mimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;
    for (const [i, mimeType] of mimeTypes.entries()) {
      const att = await prisma.attachment.create({
        data: {
          storageKey: `att/cuid-mime-${i}/original`,
          mimeType,
          byteSize: 1024,
          originalFilename: "file",
          uploaderId: ownerUser.id,
          ownerId: ownerUser.id,
        },
      });
      expect(att.mimeType).toBe(mimeType);
    }
  });

  // -----------------------------------------------------------------------
  // Invariant 2: storageKey uniqueness
  // -----------------------------------------------------------------------

  it("enforces storageKey uniqueness — duplicate throws", async () => {
    const storageKey = "att/cuid-dupe/original";

    await prisma.attachment.create({
      data: {
        storageKey,
        mimeType: "image/jpeg",
        byteSize: 1024,
        originalFilename: "img.jpg",
        uploaderId: ownerUser.id,
        ownerId: ownerUser.id,
      },
    });

    await expect(
      prisma.attachment.create({
        data: {
          storageKey, // same key — must throw
          mimeType: "image/jpeg",
          byteSize: 2048,
          originalFilename: "img2.jpg",
          uploaderId: ownerUser.id,
          ownerId: ownerUser.id,
        },
      })
    ).rejects.toThrow();
  });

  // -----------------------------------------------------------------------
  // Invariant 3: LINKED requires refType+refId (application-layer service)
  // -----------------------------------------------------------------------

  it("createAttachment service: rejects LINKED status without refType", async () => {
    const { createAttachment } = await import("../../src/attachment/attachment-service.js");

    await expect(
      createAttachment(prisma, {
        storageKey: "att/cuid-linked-noref/original",
        mimeType: "image/jpeg",
        byteSize: 1024,
        originalFilename: "img.jpg",
        uploaderId: ownerUser.id,
        ownerId: ownerUser.id,
        status: "LINKED",
        // refType and refId intentionally omitted
      })
    ).rejects.toThrow("LINKED attachment requires refType and refId");
  });

  it("createAttachment service: rejects LINKED status without refId", async () => {
    const { createAttachment } = await import("../../src/attachment/attachment-service.js");

    await expect(
      createAttachment(prisma, {
        storageKey: "att/cuid-linked-noid/original",
        mimeType: "image/jpeg",
        byteSize: 1024,
        originalFilename: "img.jpg",
        uploaderId: ownerUser.id,
        ownerId: ownerUser.id,
        status: "LINKED",
        refType: "TRIP_SEGMENT",
        // refId intentionally omitted
      })
    ).rejects.toThrow("LINKED attachment requires refType and refId");
  });

  it("createAttachment service: allows LINKED status with both refType and refId", async () => {
    const { createAttachment } = await import("../../src/attachment/attachment-service.js");

    const att = await createAttachment(prisma, {
      storageKey: "att/cuid-linked-ok/original",
      mimeType: "image/jpeg",
      byteSize: 1024,
      originalFilename: "img.jpg",
      uploaderId: ownerUser.id,
      ownerId: ownerUser.id,
      status: "LINKED",
      refType: "TRIP_SEGMENT",
      refId: "segment-synthetic-001",
    });

    expect(att.status).toBe("LINKED");
    expect(att.refType).toBe("TRIP_SEGMENT");
    expect(att.refId).toBe("segment-synthetic-001");
    expect(att.linkedAt).toBeInstanceOf(Date);
  });

  it("createAttachment service: allows TEMP status without refType/refId", async () => {
    const { createAttachment } = await import("../../src/attachment/attachment-service.js");

    const att = await createAttachment(prisma, {
      storageKey: "att/cuid-temp-svc/original",
      mimeType: "image/png",
      byteSize: 4096,
      originalFilename: "receipt.png",
      uploaderId: ownerUser.id,
      ownerId: ownerUser.id,
      // status defaults to TEMP; no refType/refId
    });

    expect(att.status).toBe("TEMP");
    expect(att.refType).toBeNull();
    expect(att.refId).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Enum values: AttachmentStatus and AttachmentRefType
  // -----------------------------------------------------------------------

  it("supports AttachmentStatus enum values: TEMP and LINKED", async () => {
    // TEMP
    const tempAtt = await prisma.attachment.create({
      data: {
        storageKey: "att/enum-temp/original",
        mimeType: "image/jpeg",
        byteSize: 1024,
        originalFilename: "t.jpg",
        uploaderId: ownerUser.id,
        ownerId: ownerUser.id,
        status: "TEMP",
      },
    });
    expect(tempAtt.status).toBe("TEMP");

    // LINKED
    const linkedAtt = await prisma.attachment.create({
      data: {
        storageKey: "att/enum-linked/original",
        mimeType: "image/jpeg",
        byteSize: 1024,
        originalFilename: "l.jpg",
        uploaderId: ownerUser.id,
        ownerId: ownerUser.id,
        status: "LINKED",
        refType: "MAINTENANCE",
        refId: "maint-synthetic-001",
        linkedAt: new Date(),
      },
    });
    expect(linkedAtt.status).toBe("LINKED");
  });

  it("supports all AttachmentRefType enum values", async () => {
    const refTypes = ["TRIP_SEGMENT", "MAINTENANCE", "DEPRECIATION"] as const;
    for (const [i, refType] of refTypes.entries()) {
      const att = await prisma.attachment.create({
        data: {
          storageKey: `att/enum-ref-${i}/original`,
          mimeType: "image/jpeg",
          byteSize: 1024,
          originalFilename: "f.jpg",
          uploaderId: ownerUser.id,
          ownerId: ownerUser.id,
          status: "LINKED",
          refType,
          refId: `ref-synthetic-${i}`,
          linkedAt: new Date(),
        },
      });
      expect(att.refType).toBe(refType);
    }
  });
});
