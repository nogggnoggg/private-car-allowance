/**
 * INFRA-001-T1/T2 — vitest `setupFiles`：per-worker URL 改寫 + schema 存在性驗證
 * + per-file TRUNCATE（T2）。
 *
 * 執行時機：每個測試檔的 fork worker 行程內，測試檔模組被 import **之前**
 * （已由 R-1 實驗於真實執行中確認，見 Task Handoff）。
 *
 * 職責：
 *   1. 若隔離未啟用（`TEST_DB_ISOLATION=off` 或 `DATABASE_URL` 未設）：什麼都
 *      不做，`describeWithDb` 的既有 skip 行為與修復前完全一致（AC-04/AC-05）；
 *      本分支下**不註冊** TRUNCATE 的 root `beforeAll`（回退模式必須是完整的
 *      修復前行為，見 Spec T2 Packet 摘要）。
 *   2. 否則：呼叫 `resolveWorkerDatabaseUrl()` 改寫 `process.env.DATABASE_URL`
 *      → 指向本 worker 的專屬 schema。純函式層的 fail-closed（AC-03 a/b）
 *      已由 `resolveWorkerDatabaseUrl()` 涵蓋（`VITEST_POOL_ID` 缺席/非正整數
 *      即拋錯，不回退）。
 *   3. 驗證目標 schema 確實已被 `global-setup.ts` 供裝（AC-03(c)）——不存在
 *      即拋出含 schema 名與修復建議的可行動錯誤，**絕不**回退到未改寫的
 *      `DATABASE_URL`。
 *   4.（T2）註冊一個 root-level `beforeAll`（vitest 中 setup 檔註冊的 root hook
 *      先於測試檔內任何 `describe` 的 `beforeAll` 執行——Spec §4.4）：對本
 *      worker schema 動態列舉的全部業務表（`_prisma_migrations` 排除在外）執行
 *      一次 `TRUNCATE ... RESTART IDENTITY CASCADE`，達成 G2「per-file 乾淨
 *      起點」（AC-10/AC-11/AC-12/AC-13/AC-15）。
 *
 * 這一步的正確性是整個方案的支點（Spec §5.3）：若順序不如預期，既有 29 個
 * integration 檔的模組頂層 `const DB_URL = process.env.DATABASE_URL` 會讀到
 * 舊值、隔離完全失效——這正是為何 AC-01/AC-14 必須是「實跑斷言」而非推論。
 *
 * `backend/src/**` 永不 import 這個模組（AC-18）。
 *
 * INFRA-001-R1（AC-23 REPAIR）：T3 實測 per-file wall time 增幅 ~69%（門檻
 * ≤20%）。實測拆解兩個根因（見 Task Handoff 完整量測表）：
 *
 *   (a) 本檔在 `isolate:true`（每測試檔全新模組環境）下，每個測試檔各自建立
 *       **兩個**獨立 `PrismaClient`——一個給 `verifyWorkerSchemaExists`
 *       （AC-03c 探測），一個給 root `beforeAll` 的 `truncateWorkerSchema`——
 *       各自握手、各自拆線，53 檔 × 2 條連線。修法：同一測試檔內這兩步共用
 *       **同一個** `PrismaClient` 實例（探測與清空本就發生在同一個檔案生命
 *       週期、同一筆邏輯性「本檔的資料庫工作階段」內），把每檔的
 *       PrismaClient 建構次數從 2 砍到 1。`verifyWorkerSchemaExists` 保留可
 *       選的 `client` 參數以維持向後相容：`infra001-isolation-self-check.
 *       test.ts` 的 AC-03(c) 測試仍以「不傳 client」的方式呼叫它，針對一個
 *       刻意捏造、從未供裝的 schema 做獨立探測——那不在本檔的每檔熱路徑上，
 *       維持原本「自建即用即拆」的行為對它而言零成本、零風險。
 *
 *   (b) **主因（實測貢獻遠大於 (a)）**：`TRUNCATE ... CASCADE` 本身在這台機
 *       器上單次呼叫實測約 178ms（5 次序列 890ms，見 Handoff 微量測）——這
 *       是 PostgreSQL 的 DDL 類目錄失效廣播 + WAL/fsync 成本，與連線握手無
 *       關，即使 (a) 完全消除也還有這筆帳。R-5（Spec §11.2）預見「僅在偵測
 *       到非空才 TRUNCATE」這個方向，但本回合的測試套件慣例是**刻意不清
 *       理**（AC-13 兩檔皆刻意留下資料，供下一檔的 TRUNCATE 證明自癒），所
 *       以多數檔案起跑時 schema 幾乎必然非空——「僅非空才做」的命中率太低，
 *       救不了 AC-23。改採**同義但便宜非常多**的替代動作：用動態探測到的
 *       外鍵相依關係做拓撲排序，逐表 `DELETE FROM`（子表→父表順序，不違反
 *       FK），而非整批 `TRUNCATE`。同一台機器上 11 表 × `DELETE`（依序）實測
 *       5 輪僅 36ms 總計（約 0.65ms/表），比 `TRUNCATE` 快兩個數量級——DELETE
 *       走一般 MVCC 行鎖與正常交易提交路徑，不觸發 TRUNCATE 特有的目錄失效
 *       廣播。若拓撲排序偵測到循環依賴（目前 6 條外鍵路徑無循環，但未來
 *       schema 若真的出現循環）則安全退回原本的 `TRUNCATE ... CASCADE`——
 *       `CASCADE` 對任何拓撲都正確，只是慢，作為保底而非常態路徑。
 *
 * 兩者疊加後 AC-23 增幅量測結果見 Task Handoff。
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll } from "vitest";
import { isolationMode, resolveWorkerDatabaseUrl } from "./db-isolation.js";

/**
 * Exported (not just used internally) so
 * `test/integration/infra001-isolation-self-check.test.ts` can exercise
 * AC-03(c) directly against a deliberately-nonexistent schema name, without
 * needing to fabricate a whole separate vitest run. Re-importing this module
 * from a test file does not re-run its top-level side effects a second time
 * within the same worker process — Node's ESM module cache means the
 * `setupFiles`-triggered import and this later import resolve to the same
 * cached module instance.
 *
 * INFRA-001-R1：新增可選的 `client` 參數——本檔下方 `isolationEnabled` 熱路
 * 徑傳入已建立好的共用連線，探測完不拆線，留給緊接著的 `truncateWorkerSchema`
 * 繼續用（每檔的 PrismaClient 建構次數從 2 砍到 1）；省略時（本檔案中
 * `infra001-isolation-self-check.test.ts` 對 AC-03(c) 的獨立呼叫）維持原本
 * 「自建、探測、拆線」的行為不變，呼叫端寫法完全不用改。
 */
export async function verifyWorkerSchemaExists(
  databaseUrl: string,
  schema: string,
  client?: PrismaClient
): Promise<void> {
  const probe = client ?? new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const rows = await probe.$queryRawUnsafe<Array<{ exists: boolean }>>(
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS exists",
      schema
    );
    if (!rows[0]?.exists) {
      throw new Error(
        `[INFRA-001 setup-file] 目標 schema "${schema}" 在資料庫中不存在（AC-03c fail-closed）。這通常表示：(a) global-setup 尚未執行或執行失敗，(b) 你以 CLI 覆寫了 --pool-options.forks.maxForks 使其超過供裝時的上限，或 (c) 直接單獨執行本測試檔而繞過了 globalSetup。請重跑完整測試套件（讓 globalSetup 供裝）、或確認 maxForks 未被覆寫。絕不會回退到未改寫的 DATABASE_URL。`
      );
    }
  } finally {
    if (!client) {
      await probe.$disconnect();
    }
  }
}

/**
 * INFRA-001-R1：動態探測本 worker schema 內的外鍵相依關係（`pg_constraint`
 * 的 `contype = 'f'`），對表集合做拓撲排序，回傳「子表在前、父表在後」的刪除
 * 順序——這個順序下逐一 `DELETE FROM` 不會因外鍵約束（`Restrict`/`NoAction`）
 * 而失敗，且完全不需要寫死任何表名或相依關係（新增 model／FK 時自動適應）。
 *
 * 回傳 `undefined` 表示排序失敗（偵測到循環依賴，或圖中有表未被排進最終順
 * 序）——呼叫端此時必須改用 `TRUNCATE ... CASCADE` 保底，因為 `CASCADE` 對
 * 任何拓撲（含循環）都正確，只是較慢。目前 schema 的 6 條外鍵路徑（見 Task
 * Handoff）不構成循環，此函式預期回傳完整順序；防禦性寫法是為了未來 schema
 * 演進時不會靜默產生錯誤的刪除順序。
 */
/**
 * INFRA-001-R2 (S-3)：`truncateWorkerSchema` 與其內部的
 * `computeForeignKeySafeDeleteOrder` 只用得到 `$queryRawUnsafe` /
 * `$executeRawUnsafe` 這兩個方法——把參數型別收斂成這個結構化介面（而非具體
 * `PrismaClient` class），讓 unit test 可以注入一個不連真實 DB 的假物件，直接
 * 驗證「查到 0 張表時應 throw」這個分支的行為，不需要在測試環境裡真的建立一
 * 個空 schema。真正的 `PrismaClient` 實例在結構上相容，呼叫端（本檔 root
 * `beforeAll` 與 `infra001-residue-selfheal.test.ts`）完全不用改寫。
 */
export interface WorkerSchemaSqlExecutor {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

async function computeForeignKeySafeDeleteOrder(
  prisma: WorkerSchemaSqlExecutor,
  tableNames: readonly string[]
): Promise<string[] | undefined> {
  const nameSet = new Set(tableNames);
  const edges = await prisma.$queryRawUnsafe<Array<{ child: string; parent: string }>>(
    `SELECT DISTINCT cl.relname AS child, cf.relname AS parent
     FROM pg_constraint con
     JOIN pg_class cl ON cl.oid = con.conrelid
     JOIN pg_class cf ON cf.oid = con.confrelid
     JOIN pg_namespace ns ON ns.oid = cl.relnamespace
     WHERE con.contype = 'f' AND ns.nspname = current_schema()`
  );

  // Kahn's algorithm: edge (child -> parent) means "child must be deleted
  // before parent". `inDegree` counts, for each table, how many
  // not-yet-processed children still reference it.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const name of tableNames) {
    inDegree.set(name, 0);
    dependents.set(name, []);
  }
  for (const { child, parent } of edges) {
    // Ignore self-referencing FKs and anything pointing outside our table
    // set (e.g. a stray reference to `_prisma_migrations`, which is never
    // part of `tableNames`) — a full-table wipe doesn't need internal
    // self-ref ordering, and out-of-set references can't be resolved here.
    if (child === parent || !nameSet.has(child) || !nameSet.has(parent)) continue;
    dependents.get(child)?.push(parent);
    inDegree.set(parent, (inDegree.get(parent) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    order.push(current);
    for (const parent of dependents.get(current) ?? []) {
      const nextDegree = (inDegree.get(parent) ?? 0) - 1;
      inDegree.set(parent, nextDegree);
      if (nextDegree === 0) queue.push(parent);
    }
  }

  if (order.length !== tableNames.length) return undefined;
  return order;
}

/**
 * INFRA-001-T2/R1 — per-file 清空：動態列舉本 worker schema 的全部業務表
 * （排除 `_prisma_migrations`，AC-10 的 migration 帳本不受影響），依外鍵安全
 * 順序逐表 `DELETE`（R1：比整批 `TRUNCATE` 快兩個數量級，見上方檔頭說明的
 * 微量測），排序失敗時保底退回單一 `TRUNCATE ... RESTART IDENTITY CASCADE`。
 *
 * 刻意**不寫死表清單**（Spec §4.4/§12 T2 的既有原則，R1 沿用並延伸到外鍵排
 * 序）：`pg_tables`/`pg_constraint` 動態列舉，避免日後新增 model 或 FK 時這
 * 裡漏掉。
 *
 * 不重設 autoincrement 序號（與 T2 原版的 `RESTART IDENTITY` 行為不同）：
 * schema 中僅 `HealthProbe.id` 使用 `autoincrement()`，其餘主鍵皆為用戶端產
 * 生的 `cuid()`；既有 47 個測試檔與 INFRA-001 自身測試均未斷言任何自增值的
 * 起始數字（僅斷言型別或列數），保底路徑（`TRUNCATE`）仍會重設，DELETE 路徑
 * 不重設純屬有意的效能取捨，不影響任何已宣告的驗收條件。
 *
 * Exported so `infra001-residue-selfheal.test.ts` (AC-12) can invoke the exact
 * same production cleanup logic directly — simulating "the next test file's
 * root beforeAll" without needing a second physical file, since per-file (not
 * per-test) semantics mean this function only ever runs once per file via the
 * root `beforeAll` registered below.
 */
export async function truncateWorkerSchema(prisma: WorkerSchemaSqlExecutor): Promise<void> {
  const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
    "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'"
  );
  if (tables.length === 0) {
    // INFRA-001-R2 (S-3): 本 schema（由 global-setup 以 `prisma migrate
    // deploy` 供裝）必然含 11 張業務表（Spec §3 AC-08）。查到 0 張不是「這個
    // worker schema 剛好沒有業務資料」——TRUNCATE/DELETE 清空的是資料列，不是
    // 表本身，表結構應恆存在。0 張表唯一合理的解釋是 `current_schema()`（即
    // `search_path`）失效，落回一個不含任何表的 schema（例如
    // `resolveWorkerDatabaseUrl` 的改寫失敗但未拋錯、或連線字串的 `schema=`
    // 參數被後續程式碼覆寫）——這種情況下靜默 return 會讓後續測試在錯誤的
    // schema（很可能是別的 worker 的、甚至是 public）上跑而完全不清空，是比
    // 「清空失敗」更危險的靜默資料污染，因此必須 fail-closed。
    throw new Error(
      "[INFRA-001 setup-file] truncateWorkerSchema：目標 schema 找不到任何業務表（0 張）。" +
        "本 worker schema 應已由 global-setup 供裝 11 張業務表——查到 0 張代表 " +
        "current_schema()/search_path 失效，本次清空已中止以避免在錯誤的 schema 上動作。" +
        "請確認 global-setup 是否已成功執行、DATABASE_URL 的 schema= 參數是否被覆寫。"
    );
  }
  const tableNames = tables.map((t) => t.tablename);

  const deleteOrder = await computeForeignKeySafeDeleteOrder(prisma, tableNames);
  if (deleteOrder) {
    for (const tableName of deleteOrder) {
      await prisma.$executeRawUnsafe(`DELETE FROM "${tableName}"`);
    }
    return;
  }

  // Fallback: a cyclic (or otherwise unresolvable) FK graph — TRUNCATE ...
  // CASCADE remains correct for any topology, just slower.
  const identifierList = tableNames.map((t) => `"${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${identifierList} RESTART IDENTITY CASCADE`);
}

const isolationEnabled =
  isolationMode(process.env) === "schema" && Boolean(process.env.DATABASE_URL);

if (isolationEnabled) {
  const rewritten = resolveWorkerDatabaseUrl(process.env);
  if (!rewritten) {
    // resolveWorkerDatabaseUrl 只在 DATABASE_URL 未設時回傳 undefined，
    // 而上面的 isolationEnabled 檢查已排除這個情形——防禦性寫法，理論上
    // 不可達。
    throw new Error("[INFRA-001 setup-file] 內部不變式違反：隔離已啟用但改寫結果為 undefined。");
  }

  process.env.DATABASE_URL = rewritten;

  const schemaMatch = new URL(rewritten).searchParams.get("schema");
  if (!schemaMatch) {
    throw new Error("[INFRA-001 setup-file] 內部不變式違反：改寫後的 URL 缺少 schema 參數。");
  }

  // vitest 的 setupFiles 支援 top-level await（ESM）。這一步必須在測試檔
  // import 之前完成同步等待，否則後面 import 的測試檔可能在 schema 驗證完
  // 成前就已讀取 process.env.DATABASE_URL ——但因為同一個 setupFiles 模組
  // 內部所有程式碼都在此 await 完成前不會 return，vitest 會等待整個
  // setupFiles 模組的 top-level Promise resolve 後才繼續 import 測試檔。
  //
  // INFRA-001-R1：這一個 PrismaClient 實例（`workerPrisma`）刻意在 schema 驗
  // 證與下面 root `beforeAll` 的 TRUNCATE 之間共用，把每測試檔的 PrismaClient
  // 建構/連線握手次數從 2 次砍到 1 次（T3 實測根因：`isolate:true` 下 53 檔
  // × 2 條各自握手的連線是 AC-23 增幅超標的主因，見上方檔頭說明與 Spec
  // §11.2 R-5）。此連線的生命週期跨越「探測」與「TRUNCATE」兩步，本就是同一
  // 個邏輯性的「本檔案的資料庫工作階段」，於下方 root `afterAll` 拆線。
  const workerPrisma = new PrismaClient({ datasources: { db: { url: rewritten } } });
  await verifyWorkerSchemaExists(rewritten, schemaMatch, workerPrisma);

  // INFRA-001-T2 — AC-10/11/12/13/15: root-level beforeAll，先於本測試檔內任
  // 何 describe 的 beforeAll 執行（vitest setupFiles 註冊 root hook 的語意，
  // Spec §4.4）。每個測試檔只跑一次（per-file，非 per-beforeEach/per-test），
  // 因此 AC-11 要求的「同檔內 beforeAll 建立的資料在多個 it 間持續存在」不受
  // 影響——這裡只在檔案最開頭清空一次。
  beforeAll(async () => {
    await truncateWorkerSchema(workerPrisma);
  });

  // INFRA-001-R1：與 `workerPrisma` 的建立配對，確保這條連線在本檔所有測試
  // 結束後被釋放，不依賴行程結束時的隱式回收。
  afterAll(async () => {
    await workerPrisma.$disconnect();
  });
}
