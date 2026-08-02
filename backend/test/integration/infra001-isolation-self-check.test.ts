/**
 * Integration tests for INFRA-001-T1 — per-worker PostgreSQL schema isolation
 * self-check (real DB, real global-setup-provisioned schema).
 *
 * AC covered (Spec docs/specs/INFRA-001.md §3/§9.2, T1 slice only — AC-10/11
 * per-file-empty-start and AC-12/13 collision/residue tests belong to T2 and
 * are NOT in this file yet; setup-file.ts in T1 does not TRUNCATE):
 *   AC-01  current_schema() 為本 worker 專屬 schema，search_path 不含 public
 *   AC-03(c) 目標 schema 不存在時 fail-closed 拋出可行動錯誤
 *   AC-07  worker schema 的 _prisma_migrations 已完成筆數 = migrations 目錄數（動態）
 *   AC-08  worker schema 含全部 11 張業務表 + 6 個 schema 本地 enum（oid ≠ public）
 *   AC-09  僅存在 ^vitest_w[0-9]+$ 且編號 ≤ maxForks；public 表數（run 前後）未變
 *   AC-14  current_schema() 符合 ^vitest_w[0-9]+$（隔離失效即紅——鑑別力核心）
 *   AC-19  travel-service.ts 的 `SELECT ... FOR UPDATE` 原始 SQL 在 worker
 *          schema 下經 updateTravelDraft 正確解析（無 schema 限定表名依
 *          search_path 解析）
 *
 * Whole-file skip semantics (AC-05): this file is entirely about isolation
 * mechanics, so it is skipped both when DATABASE_URL is unset (existing
 * describeWithDb convention) AND when TEST_DB_ISOLATION is explicitly "off"
 * (shouldSkipIsolationOnlyTests) — never merely because isolation "looks"
 * inactive, only on the explicit opt-out.
 *
 * Test discipline (CLAUDE.md / Spec §9.2): synthetic data only, "infra001_"
 * loginName prefix, passwordHash is a plainly-fake constant string (never
 * calls argon2 / src/auth/**), cleanup scoped to this file's own created rows.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateTravelDraft } from "../../src/applications/travel-service.js";
import { WORKER_SCHEMA_PATTERN, shouldSkipIsolationOnlyTests } from "../setup/db-isolation.js";
import { countMigrationDirs, readInfra001IsolationState } from "../setup/global-setup.js";
import { computeMaxForks } from "../setup/max-forks.js";
import { verifyWorkerSchemaExists } from "../setup/setup-file.js";

const DB_URL = process.env.DATABASE_URL;
const isolationOptedOut = shouldSkipIsolationOnlyTests(process.env);
const describeIsolation = DB_URL && !isolationOptedOut ? describe : describe.skip;

const BUSINESS_ENUM_NAMES = [
  "Role",
  "AuditAction",
  "AttachmentStatus",
  "AttachmentRefType",
  "ApplicationType",
  "ApplicationStatus",
] as const;

describeIsolation("INFRA-001-T1 — per-worker schema isolation self-check", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("AC-01 / AC-14: current_schema() 為本 worker 專屬 schema，search_path 不含 public", async () => {
    const schemaRows = await prisma.$queryRaw<Array<{ current_schema: string | null }>>`
      SELECT current_schema()
    `;
    const schema = schemaRows[0]?.current_schema;

    // AC-14's discriminating power: if setupFiles/globalSetup were removed or
    // silently no-op'd, this connection would fall back to `public` and this
    // assertion goes red immediately.
    expect(schema).toMatch(WORKER_SCHEMA_PATTERN);
    expect(schema).toBe(`vitest_w${process.env.VITEST_POOL_ID}`);

    const searchPathRows =
      await prisma.$queryRawUnsafe<Array<{ search_path: string }>>("SHOW search_path");
    const searchPath = searchPathRows[0]?.search_path ?? "";
    expect(searchPath).not.toMatch(/(^|,|\s)public(\s|,|$)/);
  });

  it("AC-03(c): 目標 schema 不存在時 fail-closed 拋出可行動錯誤（絕不回退）", async () => {
    const bogusSchema = "vitest_w999999999_infra001_never_provisioned";
    await expect(verifyWorkerSchemaExists(DB_URL as string, bogusSchema)).rejects.toThrow(/不存在/);
  });

  it("AC-07: worker schema 的 _prisma_migrations 已完成筆數 = migrations 目錄數（動態讀取，非寫死）", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`
    );
    const finishedCount = Number(rows[0]?.count ?? 0);
    expect(finishedCount).toBe(countMigrationDirs());
    expect(finishedCount).toBeGreaterThan(0); // guards against the query itself silently matching nothing
  });

  it("AC-08: worker schema 含全部 11 張業務表，且 6 個 enum 為 schema 本地型別（oid 與 public 不同）", async () => {
    const tableRows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`
    );
    expect(tableRows.length).toBe(11);

    for (const enumName of BUSINESS_ENUM_NAMES) {
      const rows = await prisma.$queryRawUnsafe<Array<{ oid: string; nspname: string }>>(
        `SELECT t.oid::text AS oid, n.nspname
         FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE t.typname = $1 AND n.nspname IN (current_schema(), 'public')`,
        enumName
      );
      const ownRow = rows.find((r) => r.nspname !== "public");
      const publicRow = rows.find((r) => r.nspname === "public");
      expect(ownRow, `enum ${enumName} 應存在於本 worker schema`).toBeDefined();
      expect(publicRow, `enum ${enumName} 應存在於 public（比較基準）`).toBeDefined();
      expect(ownRow?.oid).not.toBe(publicRow?.oid);
    }
  });

  it("AC-09: 僅存在 ^vitest_w[0-9]+$ 且編號 ≤ maxForks；public 表數（run 前後）未變", async () => {
    const maxForks = computeMaxForks();
    const namespaceRows = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
      `SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname ~ '^vitest_w[0-9]+$'`
    );
    expect(namespaceRows.length).toBeGreaterThan(0);
    for (const row of namespaceRows) {
      expect(row.nspname).toMatch(WORKER_SCHEMA_PATTERN);
      const n = Number(row.nspname.slice("vitest_w".length));
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(maxForks);
    }

    const state = readInfra001IsolationState();
    expect(state, "global-setup 應已寫入量測狀態檔").toBeDefined();
    expect(state?.maxForks).toBe(maxForks);
    expect(state?.publicTableCountAfter).toBe(state?.publicTableCountBefore);
  });

  it("AC-19: travel-service 的 `SELECT ... FOR UPDATE` 原始 SQL 在 worker schema 下經 updateTravelDraft 正確解析", async () => {
    const uniqueSuffix = `${process.env.VITEST_POOL_ID ?? "x"}_${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const owner = await prisma.user.create({
      data: {
        loginName: `infra001_ac19_${uniqueSuffix}`,
        displayName: "INFRA-001 AC-19 合成使用者",
        passwordHash: "infra001-synthetic-not-a-real-hash",
        role: "USER",
      },
    });

    let applicationId: string | undefined;
    try {
      const created = await prisma.application.create({
        data: {
          type: "TRAVEL",
          status: "DRAFT",
          ownerId: owner.id,
          createdById: owner.id,
          primaryDate: new Date("2030-01-01"),
          travel: { create: {} },
        },
      });
      applicationId = created.id;

      // This is the exact code path travel-service.ts:693 exercises: the
      // FIRST statement of updateTravelDraft's transaction is an unqualified
      // `SELECT "id" FROM "Application" ... FOR UPDATE`, which resolves via
      // this connection's search_path (§2.2 of the Spec) — if the isolation
      // rewrite were somehow only applied to this test's own PrismaClient and
      // not to updateTravelDraft's internal transaction, or if search_path
      // resolution behaved differently for raw SQL than for the Prisma query
      // builder, this call would either 404 (findUniqueOrThrow on the wrong
      // schema's empty table) or throw — not silently succeed.
      const updated = await updateTravelDraft(prisma, applicationId, {
        purpose: "INFRA-001 AC-19 合成出差目的",
      });

      expect(updated.id).toBe(applicationId);
      expect(updated.travel?.purpose).toBe("INFRA-001 AC-19 合成出差目的");
    } finally {
      if (applicationId) {
        await prisma.application.delete({ where: { id: applicationId } }).catch(() => {});
      }
      await prisma.user.delete({ where: { id: owner.id } }).catch(() => {});
    }
  });
});
