/**
 * Unit tests for INFRA-001-T1 — `backend/test/setup/db-isolation.ts` pure functions.
 *
 * No DB, no filesystem — these exercise `isolationMode`, `resolveWorkerDatabaseUrl`,
 * `workerSchemaName`, `parseWorkerPoolId`, `shouldSkipIsolationOnlyTests` in isolation.
 *
 * AC covered (Spec §3 / §9.1):
 *   AC-02 (URL rewrite, 3 shapes), AC-03(a)/(b) (fail-closed on VITEST_POOL_ID),
 *   AC-04 (DATABASE_URL unset), AC-05 (TEST_DB_ISOLATION off/invalid + skip gating).
 *
 * Test discipline: synthetic env objects only — never mutates real `process.env`.
 */
import { describe, expect, it } from "vitest";
import {
  type MigrationDirChecksum,
  type ProvisionedMigrationRow,
  isolationMode,
  parseWorkerPoolId,
  resolveWorkerDatabaseUrl,
  schemaMigrationStateMatches,
  shouldSkipIsolationOnlyTests,
  withSchema,
  workerSchemaName,
} from "../setup/db-isolation.js";

describe("INFRA-001-T1 db-isolation pure functions", () => {
  describe("resolveWorkerDatabaseUrl — AC-02 URL rewrite shapes", () => {
    it("no query string: appends ?schema=vitest_w<N>", () => {
      const result = resolveWorkerDatabaseUrl({
        DATABASE_URL: "postgresql://testuser:test@localhost:55432/app_test",
        VITEST_POOL_ID: "3",
      });
      expect(result).toBe("postgresql://testuser:test@localhost:55432/app_test?schema=vitest_w3");
    });

    it("existing unrelated query params are preserved, schema is appended", () => {
      const result = resolveWorkerDatabaseUrl({
        DATABASE_URL: "postgresql://testuser:test@localhost:55432/app_test?connection_limit=5",
        VITEST_POOL_ID: "3",
      });
      expect(result).not.toBeUndefined();
      const url = new URL(result as string);
      expect(url.searchParams.get("connection_limit")).toBe("5");
      expect(url.searchParams.get("schema")).toBe("vitest_w3");
    });

    it("existing schema= param is overridden, not duplicated", () => {
      const result = resolveWorkerDatabaseUrl({
        DATABASE_URL: "postgresql://testuser:test@localhost:55432/app_test?schema=stale_value",
        VITEST_POOL_ID: "3",
      });
      const url = new URL(result as string);
      expect(url.searchParams.getAll("schema")).toEqual(["vitest_w3"]);
    });
  });

  describe("resolveWorkerDatabaseUrl — AC-04 DATABASE_URL unset", () => {
    it("returns undefined without throwing when DATABASE_URL is absent", () => {
      expect(() => resolveWorkerDatabaseUrl({ VITEST_POOL_ID: "1" })).not.toThrow();
      expect(resolveWorkerDatabaseUrl({ VITEST_POOL_ID: "1" })).toBeUndefined();
    });

    it("returns undefined even when TEST_DB_ISOLATION is an otherwise-invalid value", () => {
      // DATABASE_URL absence short-circuits before TEST_DB_ISOLATION validation —
      // must not throw just because some other env var happens to be malformed too.
      expect(resolveWorkerDatabaseUrl({ TEST_DB_ISOLATION: "bogus" })).toBeUndefined();
    });
  });

  describe("resolveWorkerDatabaseUrl / isolationMode — AC-05 TEST_DB_ISOLATION semantics", () => {
    it('TEST_DB_ISOLATION="off" returns the input URL unchanged (no schema param added)', () => {
      const input = "postgresql://testuser:test@localhost:55432/app_test";
      const result = resolveWorkerDatabaseUrl({
        DATABASE_URL: input,
        TEST_DB_ISOLATION: "off",
        // Deliberately absent/invalid VITEST_POOL_ID — off mode must not even
        // look at it, let alone throw because of it.
      });
      expect(result).toBe(input);
    });

    it('TEST_DB_ISOLATION="off" ignores an invalid VITEST_POOL_ID entirely', () => {
      const input = "postgresql://testuser:test@localhost:55432/app_test";
      expect(() =>
        resolveWorkerDatabaseUrl({
          DATABASE_URL: input,
          TEST_DB_ISOLATION: "off",
          VITEST_POOL_ID: "not-a-number",
        })
      ).not.toThrow();
    });

    it("an invalid TEST_DB_ISOLATION value throws (never silently treated as off)", () => {
      expect(() =>
        resolveWorkerDatabaseUrl({
          DATABASE_URL: "postgresql://testuser:test@localhost:55432/app_test",
          TEST_DB_ISOLATION: "disabled", // not "off" — a plausible typo
          VITEST_POOL_ID: "1",
        })
      ).toThrow(/TEST_DB_ISOLATION/);
    });

    it("isolationMode defaults to schema when unset", () => {
      expect(isolationMode({})).toBe("schema");
    });

    it("isolationMode accepts schema/off, rejects anything else", () => {
      expect(isolationMode({ TEST_DB_ISOLATION: "schema" })).toBe("schema");
      expect(isolationMode({ TEST_DB_ISOLATION: "off" })).toBe("off");
      expect(() => isolationMode({ TEST_DB_ISOLATION: "SCHEMA" })).toThrow();
      expect(() => isolationMode({ TEST_DB_ISOLATION: "" })).toThrow();
    });

    it("shouldSkipIsolationOnlyTests is true only when explicitly off — the AC-05 discriminating core", () => {
      expect(shouldSkipIsolationOnlyTests({ TEST_DB_ISOLATION: "off" })).toBe(true);
      // Absent → must NOT skip (a silently-deleted env var must not make the
      // isolation-only tests hide themselves — that would zero out their
      // discriminating power).
      expect(shouldSkipIsolationOnlyTests({})).toBe(false);
      expect(shouldSkipIsolationOnlyTests({ TEST_DB_ISOLATION: "schema" })).toBe(false);
      // An invalid value is not "off" either — callers are expected to have
      // already thrown via isolationMode() before consulting this function,
      // but this function in isolation must not treat "not recognized" as
      // "skip".
      expect(shouldSkipIsolationOnlyTests({ TEST_DB_ISOLATION: "bogus" })).toBe(false);
    });
  });

  describe("resolveWorkerDatabaseUrl — AC-03(a)/(b) fail-closed on VITEST_POOL_ID", () => {
    it("throws with an actionable message when VITEST_POOL_ID is absent", () => {
      expect(() =>
        resolveWorkerDatabaseUrl({
          DATABASE_URL: "postgresql://testuser:test@localhost:55432/app_test",
        })
      ).toThrow(/VITEST_POOL_ID/);
    });

    it.each([["0"], ["-1"], ["abc"], [""], ["1.5"], ["NaN"]])(
      "throws for non-positive-integer VITEST_POOL_ID=%s",
      (raw) => {
        expect(() =>
          resolveWorkerDatabaseUrl({
            DATABASE_URL: "postgresql://testuser:test@localhost:55432/app_test",
            VITEST_POOL_ID: raw,
          })
        ).toThrow();
      }
    );

    it("never falls back to the unrewritten DATABASE_URL on failure", () => {
      const input = "postgresql://testuser:test@localhost:55432/app_test";
      let thrown: unknown;
      let result: string | undefined;
      try {
        result = resolveWorkerDatabaseUrl({ DATABASE_URL: input, VITEST_POOL_ID: "bad" });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(result).toBeUndefined();
    });
  });

  describe("parseWorkerPoolId", () => {
    it("parses a valid positive integer string", () => {
      expect(parseWorkerPoolId("7")).toBe(7);
    });

    it.each([undefined, "", "0", "-3", "abc", "2.5"])("rejects %s", (raw) => {
      expect(() => parseWorkerPoolId(raw)).toThrow();
    });
  });

  describe("workerSchemaName", () => {
    it("produces vitest_w<N>", () => {
      expect(workerSchemaName(3)).toBe("vitest_w3");
      expect(workerSchemaName(1)).toBe("vitest_w1");
      expect(workerSchemaName(42)).toBe("vitest_w42");
    });
  });

  describe("withSchema", () => {
    it("is the same rewrite logic resolveWorkerDatabaseUrl delegates to", () => {
      const result = withSchema("postgresql://u:p@h:5432/db", "vitest_w9");
      expect(result).toBe("postgresql://u:p@h:5432/db?schema=vitest_w9");
    });
  });

  describe("schemaMigrationStateMatches — INFRA-001b-T1 AC-09 按需重建的純函式比對核心", () => {
    const dirs: MigrationDirChecksum[] = [
      { name: "20260101000000_init", checksum: "aaa" },
      { name: "20260102000000_second", checksum: "bbb" },
    ];

    function rowsFromDirs(overrides?: Partial<Record<string, Partial<ProvisionedMigrationRow>>>) {
      return dirs.map((dir) => ({
        migration_name: dir.name,
        checksum: dir.checksum,
        finished_at: new Date("2026-01-01T00:00:00Z"),
        rolled_back_at: null,
        ...(overrides?.[dir.name] ?? {}),
      }));
    }

    it("returns true when migration_name/checksum/finished_at/rolled_back_at all line up exactly", () => {
      expect(schemaMigrationStateMatches(dirs, rowsFromDirs())).toBe(true);
    });

    it("returns false when a migration is missing from the DB (subset, not just superset check)", () => {
      const rows = rowsFromDirs().slice(0, 1);
      expect(schemaMigrationStateMatches(dirs, rows)).toBe(false);
    });

    it("returns false when the DB has an extra unknown migration row (same length trap)", () => {
      // Same length as `dirs`, but the second entry is a name `dirs` doesn't
      // know about — a naive "same length ⇒ ok" check would wrongly pass this.
      const rows = [
        rowsFromDirs()[0],
        {
          migration_name: "20269999000000_unknown_to_directory",
          checksum: "zzz",
          finished_at: new Date("2026-01-01T00:00:00Z"),
          rolled_back_at: null,
        },
      ];
      expect(schemaMigrationStateMatches(dirs, rows)).toBe(false);
    });

    it("returns false when a checksum differs from the migration.sql-derived value", () => {
      const rows = rowsFromDirs({ "20260102000000_second": { checksum: "corrupted" } });
      expect(schemaMigrationStateMatches(dirs, rows)).toBe(false);
    });

    it("returns false when finished_at is null (migration started but never completed)", () => {
      const rows = rowsFromDirs({ "20260101000000_init": { finished_at: null } });
      expect(schemaMigrationStateMatches(dirs, rows)).toBe(false);
    });

    it("returns false when rolled_back_at is not null (migration was rolled back)", () => {
      const rows = rowsFromDirs({
        "20260101000000_init": { rolled_back_at: new Date("2026-01-01T01:00:00Z") },
      });
      expect(schemaMigrationStateMatches(dirs, rows)).toBe(false);
    });

    it("returns true regardless of row order (comparison is by name, not by position)", () => {
      const rows = [...rowsFromDirs()].reverse();
      expect(schemaMigrationStateMatches(dirs, rows)).toBe(true);
    });

    it("returns false for an empty actualRows array against a non-empty expected set (the fail-safe default for 'schema not provisioned')", () => {
      expect(schemaMigrationStateMatches(dirs, [])).toBe(false);
    });
  });
});
