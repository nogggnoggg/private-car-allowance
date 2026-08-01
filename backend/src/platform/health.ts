import type { PrismaClient } from "@prisma/client";
/**
 * /health route plugin.
 * AC-07: HTTP 200 + checks.db==="up" when DB is healthy.
 * AC-08: HTTP 503 + checks.db==="down" when DB is unavailable, no connection info leaked.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type DbProbe = () => Promise<void>;

/** Lightweight DB liveness check via SELECT 1 */
export function makeDefaultDbProbe(prisma: PrismaClient): DbProbe {
  return async () => {
    await prisma.$queryRaw`SELECT 1`;
  };
}

const startTime = Date.now();

export async function healthPlugin(
  fastify: FastifyInstance,
  options: { dbProbe: DbProbe }
): Promise<void> {
  fastify.get("/health", async (_request: FastifyRequest, reply: FastifyReply) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const timestamp = new Date().toISOString();

    let dbStatus: "up" | "down" = "up";

    try {
      await options.dbProbe();
    } catch (err) {
      dbStatus = "down";
      // Log the error for debugging but DO NOT include message or stack (AC-08, SF-1).
      // Only log the error class name — enough to classify the failure without
      // risking credential leakage via err.message (e.g. connection strings).
      fastify.log.error(
        { errName: err instanceof Error ? err.name : "UnknownError" },
        "Health check DB probe failed"
      );
    }

    if (dbStatus === "up") {
      return reply.status(200).send({
        status: "ok",
        checks: { db: "up" },
        uptimeSeconds,
        timestamp,
      });
    }

    return reply.status(503).send({
      status: "error",
      checks: { db: "down" },
      uptimeSeconds,
      timestamp,
    });
  });
}
