import type { PrismaClient } from "@prisma/client";
/**
 * /health route plugin.
 * AC-07: HTTP 200 + checks.db==="up" when DB is healthy.
 * AC-08: HTTP 503 + checks.db==="down" when DB is unavailable, no connection info leaked.
 * PHASE-011-T9 (Spec AC-14; §16 D9=(a)): the DB probe now runs under a bounded
 * timeout (B-14, N-4 — a stuck probe must not block the platform's health
 * judgement) and its failure log records only the probe name and err.name,
 * never err.message (AC-14(c)).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type DbProbe = () => Promise<void>;

/** Lightweight DB liveness check via SELECT 1 */
export function makeDefaultDbProbe(prisma: PrismaClient): DbProbe {
  return async () => {
    await prisma.$queryRaw`SELECT 1`;
  };
}

/**
 * Default upper bound (ms) for a single probe (PHASE-011-T9; Spec §16
 * D9=(a), B-14, N-4). Well under the `docker-compose.yml` :49-58 health-check
 * interval (10s) so a stuck probe never causes the platform to judge on a
 * stale in-flight request. A code-level constant, not an env var — D9=(a)
 * scopes this Task to `backend/src` only; `docker-compose.yml` is out of
 * scope for this decision.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 2000;

/**
 * Thrown when a probe exceeds its timeout budget. Only `.name` is ever read
 * by the caller (AC-14(c)) — the message exists for local debugging via a
 * debugger/stack trace only, never logged.
 */
class ProbeTimeoutError extends Error {
  constructor(probeName: string) {
    super(`probe "${probeName}" timed out`);
    this.name = "ProbeTimeoutError";
  }
}

/**
 * Races `promise` against a timer; the timer is cleared on both branches so
 * it never keeps the process alive. If `promise` loses the race and later
 * settles, its rejection handler here (attached via `.then`'s second
 * argument) prevents an unhandled-rejection warning — mirrors
 * `reports/pdf-renderer.ts`'s `withTimeout`.
 */
function withProbeTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  probeName: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ProbeTimeoutError(probeName));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

const startTime = Date.now();

export async function healthPlugin(
  fastify: FastifyInstance,
  options: { dbProbe: DbProbe; probeTimeoutMs?: number }
): Promise<void> {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  fastify.get("/health", async (_request: FastifyRequest, reply: FastifyReply) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const timestamp = new Date().toISOString();

    let dbStatus: "up" | "down" = "up";

    try {
      await withProbeTimeout(options.dbProbe(), probeTimeoutMs, "db");
    } catch (err) {
      dbStatus = "down";
      // Log the error for debugging but DO NOT include message or stack (AC-14(c)).
      // Only log the probe name and error class name — enough to classify the
      // failure without risking credential leakage via err.message (e.g.
      // connection strings) or a probe-specific message.
      fastify.log.error(
        { probe: "db", errName: err instanceof Error ? err.name : "UnknownError" },
        "Health check probe failed"
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
