/**
 * Integration test: migration mechanism and HealthProbe write/read.
 * TDD: written BEFORE implementation, expected to fail first.
 *
 * Requires a running Postgres instance with migrations already applied.
 * If DATABASE_URL is not set, tests are skipped with an explanatory message.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.DATABASE_URL;

const describeWithDb = DB_URL ? describe : describe.skip;

describeWithDb("Migration mechanism — HealthProbe write/read", () => {
  // Dynamically import PrismaClient to avoid issues when DB_URL is absent
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import for test isolation
  let prisma: any;

  beforeAll(async () => {
    if (!DB_URL) return;
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({
      datasources: { db: { url: DB_URL } },
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  it("can write and read a HealthProbe row (migration applied)", async () => {
    // Insert a row
    const created = await prisma.healthProbe.create({ data: {} });
    expect(created.id).toBeTypeOf("number");
    expect(created.checkedAt).toBeInstanceOf(Date);

    // Read it back
    const found = await prisma.healthProbe.findUnique({
      where: { id: created.id },
    });
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);

    // Clean up
    await prisma.healthProbe.delete({ where: { id: created.id } });
  });
});
