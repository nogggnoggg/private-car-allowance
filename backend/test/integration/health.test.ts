import type { FastifyInstance } from "fastify";
/**
 * Integration tests for GET /health
 * TDD: written BEFORE implementation, expected to fail first.
 *
 * Requires a running Postgres instance (see DATABASE_URL in env or .env.test).
 * If DATABASE_URL is not set, tests are skipped with an explanatory message.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;

const describeWithDb = DB_URL ? describe : describe.skip;

describeWithDb("GET /health — normal (DB up)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    if (!DB_URL) return;
    app = await buildServer({ databaseUrl: DB_URL });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("returns HTTP 200 with status ok and checks.db up", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; checks: { db: string } }>();
    expect(body.status).toBe("ok");
    expect(body.checks.db).toBe("up");
  });

  it("response body does not contain connection strings", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });
    const text = response.body;
    expect(text).not.toMatch(/postgresql:\/\//);
    expect(text).not.toMatch(/password/i);
  });
});

describeWithDb("GET /health — DB unavailable (stub)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    if (!DB_URL) return;
    // Build server but override the DB probe to simulate failure
    app = await buildServer({
      databaseUrl: DB_URL,
      dbProbeOverride: async () => {
        throw new Error("Connection refused postgresql://secret:pass@host:5432/db");
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("returns HTTP 503 with status error and checks.db down", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });
    expect(response.statusCode).toBe(503);
    const body = response.json<{ status: string; checks: { db: string } }>();
    expect(body.status).toBe("error");
    expect(body.checks.db).toBe("down");
  });

  it("response body does not contain connection strings or internal error details", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });
    const text = response.body;
    // Must not leak the connection string from the thrown error
    expect(text).not.toMatch(/postgresql:\/\//);
    expect(text).not.toMatch(/secret/);
    expect(text).not.toMatch(/Connection refused/);
  });
});
