/**
 * Integration tests for INFRA-001-T1/T2 — per-worker PostgreSQL schema
 * isolation self-check (real DB, real global-setup-provisioned schema).
 *
 * AC covered (Spec docs/specs/INFRA-001.md §3/§9.2):
 *   AC-01  current_schema() 為本 worker 專屬 schema，search_path 不含 public
 *   AC-03(c) 目標 schema 不存在時 fail-closed 拋出可行動錯誤
 *   AC-07  worker schema 的 _prisma_migrations 已完成筆數 = migrations 目錄數（動態）
 *   AC-08  worker schema 含全部 13 張業務表 + 6 個 schema 本地 enum（oid ≠ public）
 *   AC-09  僅存在 ^vitest_w[0-9]+$ 且編號 ≤ maxForks；public 表數（run 前後）未變
 *   AC-10  本檔第一個 beforeAll 執行時（root TRUNCATE 已完成），13 張業務表
 *          列數皆為 0；_prisma_migrations 不受影響（T2）
 *   AC-11  beforeAll 建立的資料在該檔多個 it 之間持續存在（per-file 而非
 *          per-test 清空，T2）
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
import {
  WORKER_SCHEMA_PATTERN,
  shouldSkipIsolationOnlyTests,
  withSchema,
} from "../setup/db-isolation.js";
import globalSetup, {
  countMigrationDirs,
  provisionWorkerSchema,
  readInfra001IsolationState,
  readMigrationDirsWithChecksum,
} from "../setup/global-setup.js";
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

describeIsolation("INFRA-001-T1/T2 — per-worker schema isolation self-check", () => {
  let prisma: PrismaClient;
  let ac11FixtureUserId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

    // AC-10: 這是本檔的第一個 beforeAll。setup-file.ts 以 setupFiles 註冊的
    // root-level beforeAll（TRUNCATE，T2）必已在此之前執行完畢——斷言故意放
    // 在這裡（而非某個 it），因為 AC-10 驗證的正是「這個時間點」的狀態；若
    // 挪到後面才檢查，下面緊接著建立的 AC-11 fixture 會使斷言恆假。
    const tableRows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`
    );
    expect(tableRows.length).toBe(13);
    for (const { table_name } of tableRows) {
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count FROM "${table_name}"`
      );
      expect(Number(rows[0]?.count ?? -1), `AC-10: 表 ${table_name} 應為空`).toBe(0);
    }
    const migrationRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`
    );
    expect(Number(migrationRows[0]?.count ?? 0)).toBe(countMigrationDirs());

    // AC-11 fixture：刻意建立在 beforeAll（而非某個 it）裡，用來證明
    // beforeAll 建立的資料會在本檔的多個 it 之間持續存在（per-file 而非
    // per-test 清空）——見下面兩個 "AC-11" it。
    const fixtureUser = await prisma.user.create({
      data: {
        loginName: "infra001_ac11_fixture_user",
        displayName: "INFRA-001 AC-11 跨 it 存活 fixture",
        passwordHash: "infra001-synthetic-not-a-real-hash",
        role: "USER",
      },
    });
    ac11FixtureUserId = fixtureUser.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: ac11FixtureUserId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("AC-11 (1/2): beforeAll 建立的 fixture 使用者在本 it 中仍存在", async () => {
    const found = await prisma.user.findUnique({ where: { id: ac11FixtureUserId } });
    expect(found).not.toBeNull();
    expect(found?.loginName).toBe("infra001_ac11_fixture_user");
  });

  it("AC-11 (2/2): beforeAll 建立的 fixture 使用者在後續 it 中依然存在（非 per-test 清空）", async () => {
    const found = await prisma.user.findUnique({ where: { id: ac11FixtureUserId } });
    expect(found).not.toBeNull();
    expect(found?.id).toBe(ac11FixtureUserId);
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

  it("AC-08: worker schema 含全部 13 張業務表，且 6 個 enum 為 schema 本地型別（oid 與 public 不同）", async () => {
    const tableRows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`
    );
    expect(tableRows.length).toBe(13);

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

    // INFRA-001-R2 (S-4): 原本這裡只比對 state 檔內兩個由 globalSetup 自己
    // 寫入的數字（publicTableCountBefore/After）——兩者皆源自同一次 globalSetup
    // 執行的記憶內狀態，若 globalSetup 的守護邏輯本身失效（例如比較邏輯被
    // 誤刪、或兩個欄位被同時寫壞），這個斷言仍會恆真，鑑別力為零。改為在測試
    // 執行的「此刻」對 public schema 即時查一次 BASE TABLE 數，與供裝當時記錄
    // 的 before 值比對——這樣才是獨立於 globalSetup 內部比較邏輯之外的第二個
    // 見證：若本回合任何 worker 對 public 動了 DDL（新增/刪除表），此刻查到的
    // 即時值會與供裝前的快照不同，測試才會真的變紅。
    const publicTableCountNowRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const publicTableCountNow = Number(publicTableCountNowRows[0]?.count ?? -1);
    expect(publicTableCountNow).toBe(state?.publicTableCountBefore);
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

  /**
   * INFRA-001b-T1 — AC-09（2026-08-03 修訂，人類批准第四選項「按需重建」）。
   *
   * 設計取捨（Handoff 亦有記載）：test (b)（不吻合 ⇒ 重建）刻意**不對
   * 1..maxForks 範圍內的真實 worker schema 動手**——那些 schema 在預設並行度
   * 下可能正被其他同時執行的測試檔使用中，若對它們動 `_prisma_migrations`
   * 後觸發真正的 `globalSetup()`，會把其他檔案正在使用的資料整個 drop 掉。
   * 因此改為建立一個**超出 maxForks 範圍、只有本測試自己知道**的 scratch
   * schema（`vitest_w900000+poolId`，poolId 已排除 1..maxForks 之外），直接
   * 呼叫 `provisionWorkerSchema()`——這正是 `globalSetup()` 對 `1..maxForks`
   * 逐一呼叫的同一段生產程式碼，只是這裡把它對準一個不會被任何併發測試檔
   * 觸碰的 schema，practice 同一條邏輯路徑而不冒摧毀別人資料的風險。
   *
   * test (a)（吻合 ⇒ 沿用）與 test (c)（孤兒移除）則相反：因為它們的正確性
   * 定義就是「不對其他 schema 做任何 DDL」，呼叫真正的 `globalSetup()`（會遍
   * 歷所有 1..maxForks）是安全的——只要沒人在測試期間把某個正在用的 schema
   * 的 `_prisma_migrations` 弄壞，`globalSetup()` 對它們全部只會做唯讀比對。
   */
  describe("INFRA-001b-T1 — AC-09 按需重建（migration 狀態比對）", () => {
    it("(a) 吻合 ⇒ 沿用：本 worker schema 內種一筆標記資料，重跑 globalSetup 後標記仍在、schema 未被 drop", async () => {
      const marker = await prisma.user.create({
        data: {
          loginName: "infra001_ac09_reuse_marker",
          displayName: "INFRA-001 AC-09 沿用標記",
          passwordHash: "infra001-synthetic-not-a-real-hash",
          role: "USER",
        },
      });

      const namespaceOidBefore = await prisma.$queryRawUnsafe<Array<{ oid: string }>>(
        "SELECT oid::text AS oid FROM pg_catalog.pg_namespace WHERE nspname = current_schema()"
      );

      try {
        // 呼叫真正的生產進入點：由它自己決定「哪些 schema 吻合、哪些不吻
        // 合」，而不是我們代它決定。本 worker schema 的 migration 狀態未被
        // 動過，理應被判定為吻合而沿用。
        await globalSetup();

        // INFRA-001b-R1 (AR-1)：mid-run 呼叫真正的 globalSetup() 是編排層
        // （globalSetup 本身遍歷 1..maxForks 並逐一判斷重建/沿用/孤兒移除）
        // 的第一次覆蓋——若本次 run 期間任何其他正在使用中的 worker schema
        // 被誤判為不吻合而重建、或被誤判為孤兒而移除，這裡必須紅燈，而不是
        // 靜默地把別的測試檔正在用的資料整個毀掉。讀取方式比照本檔既有
        // AC-09 斷言（readInfra001IsolationState()）。
        const stateAfterReuseCall = readInfra001IsolationState();
        expect(stateAfterReuseCall?.rebuiltSchemaCount).toBe(0);
        expect(stateAfterReuseCall?.orphanSchemaRemovedCount).toBe(0);

        const namespaceOidAfter = await prisma.$queryRawUnsafe<Array<{ oid: string }>>(
          "SELECT oid::text AS oid FROM pg_catalog.pg_namespace WHERE nspname = current_schema()"
        );
        // DROP SCHEMA ... CASCADE 接著重建，會產生一個全新的 pg_namespace
        // row（新 oid）——oid 不變是「這個 schema 物件本身從未被 drop 過」的
        // 直接證據，比「資料還在」更強（後者理論上也可能被某種巧合的 rebuild
        // + 重新插入相同資料造成偽陽性，oid 不會）。
        expect(namespaceOidAfter[0]?.oid).toBe(namespaceOidBefore[0]?.oid);

        // 「殘留交給 per-file 清空承擔」的新語意：沿用不等於清空，標記資料必
        // 須原封不動地還在——它不是被 globalSetup 清掉的，是留給下一個測試檔
        // 的 root beforeAll TRUNCATE 處理。
        const found = await prisma.user.findUnique({ where: { id: marker.id } });
        expect(found).not.toBeNull();
        expect(found?.loginName).toBe("infra001_ac09_reuse_marker");

        const state = readInfra001IsolationState();
        expect(state?.reusedSchemaCount).toBeGreaterThan(0);
      } finally {
        await prisma.user.delete({ where: { id: marker.id } }).catch(() => {});
      }
    });

    it("(b) 不吻合 ⇒ 重建：動一筆 checksum 後,該 schema 被重建、資料消失、migration 筆數恢復", async () => {
      const poolId = Number(process.env.VITEST_POOL_ID ?? "0");
      const scratchSchema = `vitest_w${900000 + poolId}`;
      const expectedDirs = readMigrationDirsWithChecksum();

      try {
        // 先供裝一個全新、乾淨的 scratch schema（此時必定「不吻合」——根本
        // 不存在——所以第一次呼叫必然是 rebuilt，這一步只是準備測試夾具）。
        const initial = await provisionWorkerSchema(
          prisma,
          DB_URL as string,
          scratchSchema,
          expectedDirs
        );
        expect(initial.action).toBe("rebuilt");

        const scratchPrisma = new PrismaClient({
          datasources: { db: { url: withSchema(DB_URL as string, scratchSchema) } },
        });
        try {
          // 種一筆業務資料，證明重建後資料真的消失（而非碰巧本來就是空的）。
          await scratchPrisma.user.create({
            data: {
              loginName: "infra001_ac09_rebuild_residue",
              displayName: "INFRA-001 AC-09 重建前殘留",
              passwordHash: "infra001-synthetic-not-a-real-hash",
              role: "USER",
            },
          });
          const residueCountBefore = await scratchPrisma.user.count();
          expect(residueCountBefore).toBe(1);

          // 動一筆 checksum：把其中一筆 migration 的 checksum 改成明顯錯誤的
          // 值 —— 這模擬「migration.sql 內容與資料庫記錄的版本不一致」。
          await scratchPrisma.$executeRawUnsafe(
            `UPDATE "_prisma_migrations" SET checksum = 'deadbeef_infra001_corrupted_checksum' WHERE migration_name = $1`,
            expectedDirs[0].name
          );
        } finally {
          await scratchPrisma.$disconnect();
        }

        // 重跑同一段生產邏輯：這次必須判定為不吻合 ⇒ drop + migrate deploy 重建。
        const rebuilt = await provisionWorkerSchema(
          prisma,
          DB_URL as string,
          scratchSchema,
          expectedDirs
        );
        expect(rebuilt.action).toBe("rebuilt");

        const afterPrisma = new PrismaClient({
          datasources: { db: { url: withSchema(DB_URL as string, scratchSchema) } },
        });
        try {
          // 資料消失：schema 是被整個 drop 掉重建的，不是被清空。
          const residueCountAfter = await afterPrisma.user.count();
          expect(residueCountAfter).toBe(0);

          // migration 筆數恢復到與目錄數一致，且每一筆的 checksum 都回到正
          // 確值（不再是被動過手腳的 deadbeef）。
          const migrationRows = await afterPrisma.$queryRawUnsafe<
            Array<{ migration_name: string; checksum: string; finished_at: Date | null }>
          >('SELECT migration_name, checksum, finished_at FROM "_prisma_migrations"');
          expect(migrationRows.length).toBe(expectedDirs.length);
          for (const dir of expectedDirs) {
            const row = migrationRows.find((r) => r.migration_name === dir.name);
            expect(row, `migration ${dir.name} 應存在於重建後的 schema`).toBeDefined();
            expect(row?.finished_at).not.toBeNull();
            expect(row?.checksum).toBe(dir.checksum);
          }
        } finally {
          await afterPrisma.$disconnect();
        }
      } finally {
        // 測試自我清理：scratch schema 編號遠超出任何合理的 maxForks，下一次
        // 完整 run 的孤兒清理也會把它掃掉，但這裡主動清理，不依賴那個安全網。
        await prisma
          .$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${scratchSchema}" CASCADE`)
          .catch(() => {});
      }
    });

    it("(c) 孤兒（編號超出 maxForks）仍被移除", async () => {
      const maxForks = computeMaxForks();
      const poolId = Number(process.env.VITEST_POOL_ID ?? "0");
      // 遠超出任何合理 maxForks 的編號，同時以本 worker 的 poolId 錯開，避免
      // 與其他並行執行中的測試檔挑到同一個孤兒 schema 名稱。
      const orphanSchema = `vitest_w${800000 + poolId}`;
      expect(Number(orphanSchema.slice("vitest_w".length))).toBeGreaterThan(maxForks);

      await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${orphanSchema}"`);
      const existsBefore = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS exists",
        orphanSchema
      );
      expect(existsBefore[0]?.exists).toBe(true);

      await globalSetup();

      const existsAfter = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS exists",
        orphanSchema
      );
      expect(existsAfter[0]?.exists).toBe(false);
    });

    it("(d) public 表數在 globalSetup 重跑前後不變", async () => {
      const countPublicTables = async () => {
        const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT count(*)::bigint AS count FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
        );
        return Number(rows[0]?.count ?? -1);
      };

      const before = await countPublicTables();
      await globalSetup();
      const after = await countPublicTables();

      expect(after).toBe(before);
    });
  });
});
