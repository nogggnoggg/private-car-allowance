/**
 * PrismaClient singleton.
 * Create a single shared instance for the application process.
 */
import { PrismaClient } from "@prisma/client";

let _prisma: PrismaClient | undefined;

/**
 * Returns a singleton PrismaClient instance.
 * Pass databaseUrl to create a client with a specific URL (useful for tests).
 */
export function getPrismaClient(databaseUrl?: string): PrismaClient {
  if (databaseUrl) {
    // For testing: create a new client bound to a specific URL
    return new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });
  }

  if (!_prisma) {
    _prisma = new PrismaClient();
  }
  return _prisma;
}

/**
 * Disconnects the singleton PrismaClient if it was initialised.
 * Call during graceful shutdown.
 */
export async function disconnectPrisma(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = undefined;
  }
}
