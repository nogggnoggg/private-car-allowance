# INFRA-001 — 測試隔離結構性修復（per-worker schema + per-file 清空）

- Governance-Version: 2026-08-01.2
- 狀態：**ACTIVE**（D1~D8 經人類 Spec Gate 全數照建議批准，2026-08-03，leonchih）
- Task ID（產出本 Spec）：SPEC-INFRA-001
- 更新日期：2026-08-03
- Phase ID：INFRA-001（基礎設施回合，非產品 Phase；不新增使用者可見行為、不動任何 AC）
- Base Commit：`183c604`（branch: `infra-001`，自 main @ `29f3472` 切出）
- Risk Level：**Medium**（僅動測試基礎設施與 `backend/vitest.config.ts`；不觸及 `backend/src/**`、`backend/prisma/**`、`src/auth/**`、`seed-admin.ts`、金額語意、任何產品 API）
- 上游事實來源（優先序見 CLAUDE.md）：
  - `docs/retrospective/PHASE-004.md` §5 建議①（L153–156）— 本回合的動機原文
  - `PROJECT_STATE.md` A-1 裁定（L146）與 A-1 補充證據（L147）、R6 掃描結論（L120–121）、六類隔離事故（L98–L102、L120–121）
  - `backend/vitest.config.ts` L4–L37（R3 因果實驗證據與殘餘風險自陳）
  - `.github/workflows/ci.yml` L53–L99（backend job 現況）
- 依賴：無新 npm 依賴（`@prisma/client`、`vitest`、`tinypool` 皆為既有）

> 本文件為 INFRA-001 的實作定案層。**本 Spec 為 DRAFT；§14「需人類批准決策點清單」為 Gate 審閱依據，未經批准不得開始實作。**
>
> 本回合的所有技術定案（D1~D8）都建立在 §2 的**實測證據**上，而非推論。所有引用一律附原文與行號（依 retrospective §5 建議③）。

---

## 1. 目標與非目標

### 1.1 目標

把 backend 測試套件的隔離從「命名慣例 + 範圍清理」升級為**結構性隔離**，使「跑一輪全綠」重新成為有效證據。

動機原文（`docs/retrospective/PHASE-004.md` L153–156）：

```
### ① 測試隔離改成結構性，不靠命名慣例
每個 worker 一個 schema 或一個 DB，或每個測試包在可回滾交易裡。

**一項消滅六類事故**，並且讓「跑一輪」重新成為證據——驗證輪次可從 5~17 掉到 1~2。**這是唯一能大幅壓縮總時間的改動**，其餘皆為邊際改善。
```

具體目標：

1. **G1 — per-worker 資料隔離**：每個 vitest fork worker 使用專屬 PostgreSQL schema，任何 worker 的寫入對其他 worker 不可見。
2. **G2 — per-file 乾淨起點**：每個測試檔開始前，其 worker schema 的業務資料表為空。這比 G1 更強，且是消滅「同一 worker 內跨檔污染」與「行程級中斷殘留」的必要條件（見 §4.4 的機制分析）。
3. **G3 — 既有測試檔零改動**：`backend/test/**` 現有 47 個測試檔一字不改即完成隔離（診斷方式見 §2.3）。
4. **G4 — fail-closed**：隔離機制若未生效（設定被移除、`VITEST_POOL_ID` 缺席、schema 未供裝），測試必須**紅燈或拋錯**，不得靜默退回共用 DB。
5. **G5 — 一鍵回退**：單一環境變數即可回到修復前的共用 `public` 行為，不需 revert 程式碼。
6. **G6 — 結構性關閉既有追蹤項**：R6 的 self-heal 缺口（`PROJECT_STATE.md` L121）由本回合的機制結構性關閉，而非靠 9 個測試檔各自補 `beforeAll`。

### 1.2 非目標（Out of Scope，明確排除）

1. **不解決容量型 503 flake**（見 §4.7 與 §13-L1）。本回合消滅的是**邏輯干擾**；`maxForks = cores/2` 所緩解的「多 worker 對同一 Postgres 排隊造成查詢延遲超出重試退避視窗」屬**容量**問題，per-schema 隔離不會降低 DB 的 CPU 負載。**A-1 的 Accepted Risk 不因本回合自動關閉**（但 §4.7 說明本回合預期會消掉其中一個具體成因，並以 AC-24 量測驗證）。
2. **不改 E2E（Playwright）拓撲**（見 §8）。
3. **不改 `backend/src/**`、`backend/prisma/**`（含 migration 檔）**。
4. **不刪除任何既有的清理程式碼、RUN_ID 前綴、範圍 `deleteMany`、`maxForks` 上限**（見 §7）。
5. **不改任何 AC、API contract、資料模型、使用者可見行為**。
6. **不改 production／compose／Zeabur 拓撲**。本回合新增的環境變數只被 `backend/test/setup/**` 讀取，`backend/src/**` 永不 import（AC-18 為此設結構性斷言）。
7. **不調整 Prisma connection pool 上限**（`connection_limit`）。屬相鄰的容量議題，見 §13-L2。
8. **不新增 npm 依賴。**

---

## 2. 現況勘查與實測證據

> 本節所有「實測」皆由 spec-writer 於 2026-08-03 對本機測試 DB（`postgresql://testuser:test@localhost:55432/app_test`，PostgreSQL 16.14）執行讀取與**可逆的拋棄式 schema 探針**取得；探針 schema 已全數 `DROP SCHEMA ... CASCADE`，`public` 未被觸碰（探針後 `public` 仍為 12 張表 = 11 業務表 + `_prisma_migrations`）。未修改任何檔案。

### 2.1 測試對 DB 的取用形狀（決定「零改動」是否可能）

47 個測試檔（`backend/test/integration/` **31** 個 + `backend/test/unit/` **16** 個，另有非測試 helper `test/integration/_param-version-floor-date.ts`）。**31 個 integration 檔中的 29 個使用同一組樣板**（例外兩個見下），以 `phase4-travel-draft.test.ts` 為代表（原文）：

```
29: const DB_URL = process.env.DATABASE_URL;
30: const describeWithDb = DB_URL ? describe : describe.skip;
...
167:     prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
...
218:     app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
```

實測掃描結果：

- `process.env.DATABASE_URL` 在測試層**只有 29 處讀取**（29 個檔各一處），全部是各檔**模組頂層**的 `const DB_URL = process.env.DATABASE_URL;`（`backend/test/integration/*.test.ts`；`test/unit/**` 完全不讀 `process.env.DATABASE_URL`，`env.test.ts` 一律傳入明確的 env 物件）。唯一的例外是 `admin-users.test.ts:1140-1141`，它把已解析的 `DB_URL` 寫回 `process.env.DATABASE_URL` 以驅動 `runSeedAdmin`：

  ```
  1140:     const originalDbUrl = process.env.DATABASE_URL;
  1141:     process.env.DATABASE_URL = DB_URL;
  ```

  —— 這一處仍然轉播的是**同一個 `DB_URL` 值**，因此隨 setup 改寫而自動正確。
- 27 個檔共 60 處 `new PrismaClient(...)`：**55 處**為單行的 `new PrismaClient({ datasources: { db: { url: DB_URL } } })`，另 **5 處**（`migration.test.ts:22`、`phase2-models.test.ts:39`、`phase3-attachment-model.test.ts:30`、`phase3a-parameter-model.test.ts:34`、`phase4-application-model.test.ts:101`）為同一形狀的多行寫法。**沒有任何一處是裸 `new PrismaClient()`，60 處全部經由 `DB_URL`。**
- **兩個 integration 檔完全沒有 `const DB_URL`**：`error-handler.test.ts`（`:35` 以 `dbProbeOverride: noopDbProbe` 建 server，不碰 DB）與 `log-security.test.ts`（4 處 `buildServer({...})` 皆不帶 `databaseUrl`，只驗 pino log 內容）。後者會落到 `backend/src/db/prisma.ts:21-22` 的 `new PrismaClient()`——該路徑讀 `process.env.DATABASE_URL`，**同樣會被 setup 改寫涵蓋**。
- `buildServer()` 共 8 處呼叫未帶 `databaseUrl`；未帶者要嘛使用 `dbProbeOverride` 完全不碰 DB，要嘛走上述 `getPrismaClient()` 無參數分支。**兩條路徑都被 setup 的 env 改寫覆蓋，無漏網。**

**結論（G3 可達成）**：只要在 vitest `setupFiles` 層改寫 `process.env.DATABASE_URL`，且改寫發生在測試檔模組被 import 之前，29 個檔的模組頂層 `const DB_URL` 與 `getPrismaClient()` 的無參數分支就會同時拿到 per-worker 的 URL，**既有測試檔一行都不用改**。這是 D1 選擇 schema 方案的決定性理由。

### 2.2 Prisma 5.22 對 `?schema=` 的實際行為（實測）

探針（三條連線，只讀）結果原文：

```
[no-schema-param]   search_path = "$user", public          current_schema() = public
[schema=public]     search_path = "public"                 current_schema() = public
[schema=<不存在>]    search_path = "infra001_probe_nonexistent"   current_schema() = null
```

證實三件事：

1. `?schema=X` 使 Prisma 對該連線設定 `search_path = "X"`——**單一項目，不含 `public` 後援**。
2. Prisma client **不會**自動建立不存在的 schema（`current_schema()` 為 `null`），因此供裝必須顯式進行。
3. 由於是連線層級的 `search_path`，**所有語句（含 `$queryRaw` / `$queryRawUnsafe`）一律套用**。這對兩處生產程式的原始 SQL 至關重要：

   `backend/src/applications/travel-service.ts:693`：
   ```
   await tx.$queryRaw`SELECT "id" FROM "Application" WHERE "id" = ${id} FOR UPDATE`;
   ```
   `backend/src/applications/travel-service.ts:965`：同一形狀。

   兩者皆為**未加 schema 限定**的表名，會依 `search_path` 解析到 worker schema。同理，`phase4-application-model.test.ts:243` 的 `SELECT 'BOGUS_STATUS'::"ApplicationStatus"` 也依 `search_path` 解析。

### 2.3 migration 在 per-schema 下的行為（實測）

以 `DATABASE_URL=...?schema=infra001_probe`（該 schema 事前不存在）執行 `npx prisma migrate deploy`：

- **自動建立 schema 並套用全部 7 個 migration，exit 0，wall time 2.367s**（含 CLI 冷啟動）。
- 供裝後該 schema 內含 12 張表：`Application, Attachment, AuditLog, DepreciationParameterVersion, EtcParameterVersion, FuelParameterVersion, HealthProbe, Session, TravelApplication, TripSegment, User, _prisma_migrations`。
- **enum 型別是 schema 本地的**：`pg_type` 查詢顯示 `infra001_probe.{ApplicationStatus, ApplicationType, AttachmentRefType, AttachmentStatus, AuditAction, Role}` 與 `public.{同 6 個}` 並存為不同型別。
  → 這直接回答 Packet 的疑問：**`ALTER TYPE ... ADD VALUE` 類 migration 在多 schema 下無跨 worker 影響**。`20260801162126_phase3a_parameter_audit_action/migration.sql:2`（`ALTER TYPE "AuditAction" ADD VALUE 'PARAMETER_VERSION_CREATED';`）與 `20260802092851_phase4_application_audit_actions/migration.sql:9-10`（兩條 ADD VALUE）皆為未限定型別名，各自作用於自己 schema 的 enum。
- 全 7 個 migration SQL 掃描：**無任何 `CREATE SCHEMA`、無 `public.` 限定、無 `CREATE EXTENSION`**。`schema.prisma` 的主鍵為 `@default(cuid())`（用戶端產生）與 `@default(autoincrement())`（schema 本地 sequence），**不依賴任何 `public` 內的函式或擴充**。

**並行供裝實測**：3 個 `prisma migrate deploy` 同時對 3 個不同 schema 執行 → 三者皆 exit 0，**總 wall time 2.701s**（與單一次幾乎相同）。Prisma migrate 的 advisory lock 未造成可觀察的阻塞。

**TRUNCATE 成本實測**：對 11 張（空）業務表連續 5 次 `TRUNCATE ... RESTART IDENTITY CASCADE`，總計 961ms → **約 192ms/次**。

### 2.4 worker 身分來源（實測，讀 node_modules 原始碼）

vitest 實裝 2.1.9（`package.json` 宣告 `^2.0.5`）。`node_modules/vitest/dist/worker.js:77-78`：

```
77:   process.env.VITEST_WORKER_ID = String(ctx.workerId);
78:   process.env.VITEST_POOL_ID = String(workerId);
```

兩者語意完全不同：

| 變數 | 來源 | 值域 | 穩定性 |
|---|---|---|---|
| `VITEST_WORKER_ID` | `ctx.workerId`，即 `resolveConfig.rBxzbVsl.js:6762` 的 `const workerId = ++id;` | **1..N（N = 測試檔批次數，無上限）** | 每個測試檔遞增，不可用來索引固定數量的 schema |
| `VITEST_POOL_ID` | `import { workerId } from 'tinypool'`（`worker.js:3`） | **1..maxForks（有上限）** | 為 tinypool 的**行程槽位編號**，可重複使用 |

tinypool 槽位配置原文（`node_modules/tinypool/dist/index.js`）：

```
519:  this.workerIds = new Map(new Array(this.options.maxThreads).fill(0).map((_, i) => [i + 1, true]));
...
567:  const workerInfo = new WorkerInfo(worker, port1, workerId, () => workerIds.set(workerId, true), onMessage, this.options.filename, this.options.teardown);
```

即：槽位池大小恰為 `maxThreads`（= vitest 的 `maxForks`），worker 銷毀時槽位**歸還並被下一個 worker 重用**。child_process 模式下該值經環境變數傳遞（`node_modules/tinypool/dist/index.js:106` 設 `TINYPOOL_WORKER_ID`；`node_modules/tinypool/dist/entry/process.js:9` 讀回為 `workerId`）。

**關鍵推論**（見 D2、D4）：`poolOptions.forks.isolate` 預設為 `true`（`resolveConfig.rBxzbVsl.js:6748`：`const isolated = poolOptions.isolate ?? true;` → `6750: options.isolateWorkers = true;`），因此**每個測試檔都跑在全新的 child process**，但**槽位編號（＝ schema 編號）會被後續的測試檔重用**。
→ 所以 per-worker schema **無法單獨消滅「同一槽位上前後兩個測試檔互相污染」**。這正是 §4.4（D4，per-file TRUNCATE）存在的理由，也是本 Spec 與 Packet 原始描述「每個 worker 一個 schema」相比**唯一的實質補強**。

`worker.js:77-78` 位於 `execute()` 的最前段，早於 test runner 被 import，因此 `setupFiles` 執行時 `VITEST_POOL_ID` 必然已設妥。

### 2.5 CI 與本機拓撲

`.github/workflows/ci.yml`：

```
73:     env:
74:       DATABASE_URL: postgresql://postgres:postgres@localhost:5432/app_test
...
94:       - name: Run Prisma migrations
95:         working-directory: backend
96:         run: npm run migrate:deploy
97:
98:       - name: Backend tests (unit + integration)
99:         run: npm run test --workspace=backend
```

- CI 的 `DATABASE_URL`（L74）**不含 query string**，改寫時只需附加 `?schema=`。
- 本機為 `backend/.env` 的 `postgresql://testuser:test@localhost:55432/app_test`（同樣無 query string）。
  - **DRAFT 撰稿時之原文（保留供追溯）**：「但 vitest **不會**自動把 `.env` 載入 `process.env`（`PROJECT_STATE.md` L96、L118 記載的『未 export `DATABASE_URL` 造成 55 skipped』即為此），因此本機一律靠明確 `export`。」
  - **T1 實測更正（2026-08-03）**：上述主張**經實測推翻，不成立**。vitest 2.1.9 在測試模式下會自動載入 `backend/.env`，且把**全部**變數（非僅 `VITE_` 前綴者）寫入 `process.env`——此為 Vitest 沿用 Vite env 檔載入、但對 `process.env` 採空前綴的標準行為。故本機即使未明確 `export`，`DATABASE_URL` 仍會有值。
  - **連帶更正（因果歸因撤回）**：原文據該主張對舊事故所作的**因果歸因**同時失效。`PROJECT_STATE.md` 記載之兩起「55 skipped」事故——**驗收紀律事件（T6）**與**驗收紀律事件（第三次，R3）**（原文引為 L96／L118，撰稿當時實際位於 L99／L121，該檔其後有增補，**現位於 L103／L125**；行號會漂移，請以事件名稱定位）——**另有成因，T1 未追查、本 Spec 不臆測**。自本次修訂起，本 Spec 不再以「`.env` 未被載入」解釋該兩起事故，後續 Phase 亦不得引用該歸因。原引用僅保留為歷史紀錄。
  - **對本 Spec 之影響：無。** (i) **CI 不受影響**——`backend/.env` 受 `.gitignore` 排除（L10-12：`.env`、`.env.*`、`!.env.example`），CI checkout 無此檔，`DATABASE_URL` 一律由 `ci.yml` L74 之 workflow `env` 明確提供。(ii) **隔離機制不依賴此行為**——`setup-file.ts` 以 `process.env.DATABASE_URL` 的**實際值**為輸入並改寫之，該值來源為 shell `export` 抑或 `.env` 自動載入，皆不影響 D1 的 URL 改寫或 D5 的 fail-closed 語意。(iii) §4.8 與 §12 之「明確 `export DATABASE_URL`，不得依賴 `.env` 自動載入」**維持不變**——顯式優於隱式，並可避免本機 `.env` 指向的 DB 與意圖執行的目標 DB 不一致；惟該條自此應理解為**執行紀律**，而非對 vitest 行為的事實主張。
- **CI 觸發分支限 `phase-001` / `main`**（`ci.yml` L3–L11）。`infra-001` 的 push 不會觸發 CI；**開向 `main` 的 Draft PR 會觸發**。這與 PHASE-004-R9 的治理疏漏（`PROJECT_STATE.md` L149）同一處，本回合必須實際開 PR 才拿得到 CI 證據。
- 本機測試 DB 角色 `testuser` 為 `rolsuper = true, rolcreatedb = true`；CI 的 `postgres` 角色亦為 superuser。**兩者皆足以 `CREATE SCHEMA` 與 `CREATE DATABASE`**，D1 的選型不受權限限制。
- `max_connections = 100`（本機）。

### 2.6 生產程式的併發原語

`backend/src/**` 全庫 **無任何 `pg_advisory_lock` / `pg_advisory_xact_lock`**（三處註解明示刻意不用：`travel-service.ts:57`、`travel-service.ts:434`、`attachment/lifecycle-service.ts:35/44/370`）。併發正確性一律靠 `Prisma.TransactionIsolationLevel.Serializable`（6 處：`travel-service.ts:865/986/1275`、`lifecycle-service.ts:472/759` 等）。

**推論**：PostgreSQL 的 SSI 謂詞鎖是 per-relation/page/tuple 的。不同 schema ＝ 不同 relation ⇒ **跨 worker 的序列化失敗（40001）結構上歸零**。這對 §4.7 的成效預期至關重要。

### 2.7 併發測試的隔離語意（逐檔確認）

Packet 要求確認「真併發測試是否刻意要多 worker 打同一資料列」。逐檔確認結果：**沒有任何一個**。

- `phase4-concurrency-freeze.test.ts`：併發一律以**同一行程內**的 `Promise.all` / `Promise.allSettled` 產生（檔頭 L44–L47 原文）：

  ```
  44:  *   gets a genuine `Promise.allSettled` concurrency test (same style as
  45:  *   `phase3-lifecycle-concurrent.test.ts`, real DB-level races via a real
  46:  *   connection pool, no HTTP inject) that asserts INVARIANTS holding
  47:  *   regardless of which side the real scheduler lets win — catching any
  ```

  且該檔 L49–L52 明示其資料為本檔獨佔（`loginName prefix "p4cf_" + per-run random suffix`、`effectiveFrom：本檔獨佔 2033 年`、`cleanup scoped to this suite's own tracked ids; never deleteMany({})`）。
- `phase3-lifecycle-concurrent.test.ts`：同樣為單行程內的併發（檔頭 L26–L27 討論 `pg_advisory_xact_lock` 為何不採用）。
- 其餘 29 個 integration 檔均以「本檔前綴 + RUN_ID + 追蹤 id 清理」為紀律（**9 個檔**明文寫「NEVER `deleteMany({})` globally」或等義中文）。

**結論**：per-worker schema **不會弱化任何併發測試的鑑別力**——它們要的併發全在單一 worker 內，隔離的是 worker 之間。反而是跨 worker 的**非預期**併發（正是六類事故的來源）被消除。

### 2.8 與 Packet 背景描述不符之處（Handoff 需回報）

| # | Packet 描述 | 實測 | 影響 |
|---|---|---|---|
| N-1 | 「backend 47 個測試檔；27 個檔案共 60 處 `new PrismaClient()`」 | 檔數與處數正確（47 = integration 31 + unit 16）。補充：**29 個 integration 檔有模組頂層 `const DB_URL`**（另兩檔不碰 DB 或走 `getPrismaClient()` 無參數分支），且 60 處全部帶 `datasources.db.url`，**無裸建構** | 對本 Spec 有利：G3「零改動」比 Packet 預期更穩固 |
| N-2 | 「E2E（root `e2e/`）是否共用同一 DB」 | **不共用**。`playwright.config.ts:9` 為 **port 55434**，vitest 為 55432 | E2E 已天然隔離於 vitest，out of scope 的理由更強（§8） |
| N-3 | 「migration 如何在測試前套用（本機手動？CI workflow 步驟？）」 | 本機**手動**（無腳本）；CI 為 `ci.yml:94-96` | 本回合把本機供裝自動化，是附帶改善 |
| N-4 | vitest 版本 | `package.json` 宣告 `^2.0.5`，**實裝 2.1.9** | 本 Spec 的 worker.js/tinypool 行號皆以 2.1.9 為準；升級 vitest 需重驗 D2 |
| N-5 | 「per-worker 一個 schema」即可 | 因 `isolate: true` 造成**槽位跨檔重用**，單靠 per-worker schema **不足以**消滅同槽位前後檔污染（§2.4） | 新增 D4（per-file TRUNCATE）作為必要補強 |

---

## 3. 可測試 Acceptance Criteria

> 「隔離啟用」＝ `TEST_DB_ISOLATION` 未設或為 `schema`，且 `DATABASE_URL` 已設。

### A. 隔離機制正確性

- **AC-01**　隔離啟用時，任一測試檔中由 `DB_URL` 建立的 Prisma 連線，其 `current_schema()` 等於 `vitest_w${VITEST_POOL_ID}`，且 `SHOW search_path` 的結果不含 `public`。
- **AC-02**　URL 改寫為純函式且可單獨測試：`resolveWorkerDatabaseUrl(env)` 對「無 query string」「已有其他 query 參數（須保留）」「已有 `schema=` 參數（須被覆蓋）」三種輸入皆產出正確 URL。
- **AC-03**　**fail-closed**：隔離啟用但（a）`VITEST_POOL_ID` 缺席、（b）`VITEST_POOL_ID` 非正整數、（c）目標 schema 在 DB 中不存在 —— 三種情形皆**拋出含可行動訊息的錯誤**，絕不回退到未改寫的 `DATABASE_URL`。
- **AC-04**　`DATABASE_URL` 未設時，setup 不做任何事、不拋錯；既有 `describeWithDb` 的 skip 行為與修復前完全一致。
- **AC-05**　`TEST_DB_ISOLATION=off` 時：`resolveWorkerDatabaseUrl` 原樣回傳輸入 URL；globalSetup 不建立、不刪除任何 schema；INFRA-001 自身的隔離專屬測試（AC-13/14/15 所屬檔案）整體 skip（**僅在此變數被明示設為 `off` 時 skip**；變數缺席或值無效時不得 skip）。**回退正確性的驗收基準（2026-08-03 修訂，人類批准）**：以（i）上述機制行為（skip／零 DDL／URL 不改寫）與（ii）`--pool-options.forks.maxForks=1` 下全套 0 failed 為準；預設並行度下允許重現修復前既有之 503 容量 flake（A-1 成因，off 模式即修復前行為之忠實還原，該 flake 屬預期而非本回合缺陷），不得據此判定回退路徑失效。修訂理由：原文「其餘全綠」在邏輯上不可穩定達成——舊行為本為機率性紅，正是本回合要治的病（T3 實測 3/3 重現，見 §17）。
- **AC-06**　`NODE_ENV=production` 時 globalSetup 拒絕執行任何 DDL 並拋錯。

### B. schema 供裝與 migration

- **AC-07**　globalSetup 為 `1..maxForks` 每個編號供裝 schema `vitest_w<i>`，且每個 schema 的 `_prisma_migrations` 內 `finished_at IS NOT NULL` 的筆數等於 `backend/prisma/migrations/` 下 migration 目錄數（現為 7）。
- **AC-08**　每個 worker schema 內含全部 11 張業務表；且 6 個 enum 型別（`Role`、`AuditAction`、`AttachmentStatus`、`AttachmentRefType`、`ApplicationType`、`ApplicationStatus`）在該 schema 內存在，其 `pg_type.oid` 與 `public` 同名型別**不同**。
- **AC-09**　每次 run 開始時，globalSetup 先移除所有符合 `^vitest_w[0-9]+$` 的既有 schema（**含編號大於本次 `maxForks` 的孤兒**），確保無跨 run 殘留；`public` schema **不得被觸碰**（run 前後 `public` 的表數不變）。

### C. 每檔乾淨起點（per-file）

- **AC-10**　任一測試檔的第一個 `beforeAll` 執行時，其 worker schema 的 11 張業務表列數皆為 0；`_prisma_migrations` 不受影響（筆數仍為 7）。
- **AC-11**　同一測試檔內，`beforeAll` 建立的資料在該檔的多個 `it` 之間持續存在（證明清空是 per-file 而非 per-test，避免破壞既有 fixture 模型）。
- **AC-12**　**行程級中斷殘留自癒**：在 worker schema 內預先注入模擬殘留（一個 `User` + 其名下 `Application` + `AuditLog`，即 `PROJECT_STATE.md` L121 所述會爆 FK 的形狀），下一個測試檔仍全綠。

### D. 鑑別力（隔離失效必紅）

- **AC-13**　兩個新測試檔各自以**完全相同的寫死 `loginName`**（`infra001_fixed_collision`，無 RUN_ID、無隨機後綴）建立 `User` 並**刻意不清理**，兩檔皆須通過且各自 `count === 1`。
  *鑑別力*：關閉隔離後，兩檔中後執行者必然踩 `loginName` 唯一鍵（P2002）→ 紅。與執行順序、worker 配置無關（同 worker 則先後衝突，異 worker 則並發衝突）。
- **AC-14**　自檢測試斷言 `current_schema()` 符合 `^vitest_w[0-9]+$`。
  *鑑別力*：任何人移除 `setupFiles` 設定、或 setup 靜默失效，此測試立刻紅（`current_schema()` 會是 `public`）。
- **AC-15**　以 `--pool-options.forks.maxForks=1` 執行完整套件（**所有 47 檔共用同一個 schema，序列執行**）仍為 0 failed / 0 skipped。
  *鑑別力*：這使 AC-10/AC-13 的證明變成**與排程無關的確定性證明**——若 per-file 清空無效，AC-13 的兩檔在單一 schema 下必然衝突。

### E. 相容性

- **AC-16**　`backend/test/` 下**既有 47 個測試檔與 `_param-version-floor-date.ts` 的 diff 為空**；全套回歸 passed ≥ 879（PHASE-004 收盤基準）、failed = 0、**skipped = 0**。
- **AC-17**　`backend/src/**`、`backend/prisma/**`（含所有 migration SQL）、`frontend/**`、`e2e/**` 的 diff 為空。
- **AC-18**　結構性斷言：`backend/src/**` 不存在任何對 `test/setup/**` 或 `TEST_DB_ISOLATION` 的引用（防止測試設施洩漏進生產路徑）。
- **AC-19**　`travel-service.ts:693` / `:965` 的 `SELECT ... FROM "Application" ... FOR UPDATE` 原始 SQL 在 worker schema 下正確解析：由一條顯式測試（在 worker schema 建立 Application 後，經 `updateTravelDraft` 走該路徑成功）＋ 既有 `phase4-concurrency-freeze.test.ts` 全綠共同覆蓋。

### F. CI

- **AC-20**　CI backend job **不需修改 `.github/workflows/ci.yml`** 即完成隔離（若實作證明必須改，須回報為 Spec 偏離，見 §6）。
- **AC-21**　CI 上「真正隔離」的證據形式：AC-14 的自檢測試在 CI 執行並通過，且其斷言訊息輸出實際 schema 名與 `maxForks`；Draft PR 的 `Backend Build & Tests` job 綠燈即為證據。

### G. 效能與成效

- **AC-22**　globalSetup 供裝耗時 ≤ 30s（本機與 CI 兩處皆須量測並記入 Handoff）。
- **AC-23**　全套 wall time 相對修復前基準增幅 ≤ 20%（同機、同負載條件下量測，兩者皆須貼出數字與當時 CPU 負載）。
- **AC-24**　**成效驗收**：連續 **14 輪**全套回歸，每輪 0 failed / 0 skipped；每輪須記錄起跑當下的主機 CPU 負載。輪數依據見 §9.4。任一輪出現 503 flake 即視為未達成，須提出診斷（不得以「重跑就好」結案）。

### H. 既有防線處置

- **AC-25**　本回合**未刪除**任何既有清理程式碼、RUN_ID 前綴、範圍 `deleteMany`、年份分配慣例，亦未調整 `maxForks = cores/2`；成為冗餘者僅以文件／註解標註（§7 清單）。
- **AC-26**　`PROJECT_STATE.md` L121 的 R6 self-heal 追蹤項由 AC-10 + AC-12 結構性關閉；Spec §7 記錄其狀態轉為「已由 INFRA-001 結構性覆蓋，9 檔不需各自補 `beforeAll`」。（PROJECT_STATE 本體之更新屬大總管白名單，非本 Task。）

---

## 4. 關鍵技術定案（附理由與替代方案）

### 4.1 D1 — 隔離機制選型：**per-worker PostgreSQL schema**

**定案建議：per-worker schema（單一 DB、`?schema=vitest_w<N>`）。**

| 方案 | 既有測試檔改動量 | migration 成本 | 拓撲一致性 | 權限需求 | 判定 |
|---|---|---|---|---|---|
| **A. per-worker schema** | **零**（只改寫 `process.env.DATABASE_URL`，§2.1 已證 31 個 integration 檔全部被 env 改寫覆蓋：29 檔模組頂層 `DB_URL` + 2 檔經 `getPrismaClient()` 分支或不碰 DB） | 每 schema 一次 `migrate deploy`，實測 2.37s；3 個並行僅 2.70s（§2.3） | 本機與 CI 完全同構（都只是 URL 附加 `?schema=`），compose/production 完全不受影響 | `CREATE` on database（實測 `testuser`/`postgres` 皆足夠） | **採用** |
| B. per-worker database | 零（同樣只改 URL，但改的是 path 段） | `CREATE DATABASE ... TEMPLATE` 雖快，但**要求 template 無任何連線**——與平行測試天然衝突；否則每個 DB 各跑一次完整 migration | CI 的 postgres service 只宣告一個 `POSTGRES_DB`（`ci.yml:63`）；需額外 `CREATE DATABASE` 步驟。`DROP DATABASE` 需無連線，殘留清理較脆 | `CREATEDB`（有，但更高權） | 不採用 |
| C. 每測試包在可回滾交易 | **極大**。測試經 `app.inject()` 打真實 HTTP，路由內部由 `buildServer` 自己的 PrismaClient 開 `$transaction(..., Serializable)`（6 處，§2.6）。外層交易無法涵蓋這些獨立連線，且巢狀 `$transaction` 語意不同 | 無 | — | — | **結構上不可行**，排除 |

**選 A 的理由（依權重）**：

1. **零測試檔改動**（G3）。§2.1 證明 31 個 integration 檔全部被單一入口 `process.env.DATABASE_URL` 的改寫覆蓋（29 檔模組頂層 `DB_URL` + 2 檔經 `getPrismaClient()` 分支或不碰 DB）；這是本專案獨有的、極幸運的既有結構，直接使方案 A 的落地面積縮到一個 setup 檔。
2. **原始 SQL 相容**。§2.2 實測 `?schema=` 設定的是連線層 `search_path`，`$queryRaw`（`travel-service.ts:693/965`）與 enum cast 皆自動正確。
3. **enum migration 無跨 worker 影響**。§2.3 實測 `ALTER TYPE ADD VALUE` 作用於 schema 本地 enum。
4. **供裝成本可忽略**。實測並行 3 個 = 2.70s。
5. **CI 零改動**（AC-20）。

**方案 A 的已知代價**（誠實揭露）：`search_path` 只有一項、不含 `public`（§2.2 實測）。若日後引入需安裝於 `public` 的 PostgreSQL 擴充（如 `pgcrypto`、`uuid-ossp`），worker schema 將看不到它。現況全 7 個 migration **無任何 `CREATE EXTENSION`**，主鍵用 cuid（用戶端）與 sequence（schema 本地），故目前無風險；記入 §13-L3 供未來監控。

### 4.2 D2 — worker 身分來源：**`VITEST_POOL_ID`**

**定案建議：`VITEST_POOL_ID`，並對其做嚴格驗證。**

依 §2.4 實測：

- `VITEST_WORKER_ID` 是**每個測試檔遞增的批次序號**（`++id`），值域可達測試檔數（47），**不可用**——會產生 47 個 schema，供裝成本暴增且無界。
- `VITEST_POOL_ID` 是 **tinypool 的行程槽位編號，值域嚴格為 `1..maxForks`**，且 worker 銷毀時歸還重用（`tinypool/dist/index.js:519/567`）。

**「fork pool 下 worker 重用/重生時 schema 是否需重建或清空」的回答**：

- **不需重建**（schema 內容與行程生命週期無關，migration 已套用）。
- **必須清空**——而且不是因為「worker 重生」，是因為 `isolate: true`（`resolveConfig.rBxzbVsl.js:6748-6750`）使**每個測試檔都是新行程但可能拿到同一槽位**，前一檔的資料原封不動留在該 schema。這就是 D4 的存在理由。

**驗證要求（fail-closed，AC-03）**：`VITEST_POOL_ID` 必須存在、可解析為正整數、且 `1 ≤ id ≤ 已供裝上界`。若使用者以 CLI 提高 `maxForks` 超過 globalSetup 供裝數（例：`--pool-options.forks.maxForks=32`），setup 應以「schema `vitest_w17` 不存在，請重跑或調整 maxForks」這類可行動訊息拋錯，**不得**靜默改用 `public`。

**替代方案**：以 `process.pid` 命名 schema——否決。pid 無界、每檔一個 schema，且無法在 globalSetup 預先供裝。

### 4.3 D3 — migration 套用策略與 schema 生命週期：**globalSetup 一次性、並行、run 前 drop**

**定案建議：**

1. **供裝時機**：vitest `globalSetup`（主行程，測試開始前一次）。
2. **供裝方式**：對每個 `i ∈ 1..maxForks`，先 `DROP SCHEMA IF EXISTS "vitest_w<i>" CASCADE`，再以 `DATABASE_URL=<base>?schema=vitest_w<i>` spawn `prisma migrate deploy`（由 `node_modules/.bin` 解析，**不用 `npx`**，避免 registry 查詢；須跨平台處理 Windows 的 `.cmd`）。
3. **並行度**：帶上限的並行（建議 cap = 4），實作須量測實際 `maxForks` 下的耗時並記入 Handoff（AC-22）。若觀察到 Prisma advisory lock 逾時，降為序列並在 Handoff 說明；**不得**設定 `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK`。
4. **孤兒清理**：供裝前查 `pg_namespace` 掃出所有 `^vitest_w[0-9]+$`，一併 drop（涵蓋「上次在 16 核機器跑出 8 個、這次只要 2 個」的情形）——AC-09。
5. **清理時機：run 前 drop，run 後保留。** 理由：保留最後一次 run 的完整資料供事後除錯（本專案在 R6/B-30 的診斷中反覆需要這個能力），而下一次 run 的開頭必定重建，因此不會累積。
6. **不做 lazy 建立**。setupFile 只**驗證** schema 存在（一次極廉價的查詢），不建立——避免 N 個 worker 同時 spawn Prisma CLI 的競態與 advisory lock 爭用，也讓失敗點集中在一處。

**為何不採 lazy + advisory lock**：可行但更複雜（需自管 `pg_advisory_lock` 鍵、需處理「別人正在建、我要等多久」、每個 worker 首次都要付 2.4s 的 CLI 冷啟動），而 globalSetup 並行供裝實測只要 2.7s（3 個）。複雜度不划算。

**為何不採「重放 migration SQL 檔」**：可省下 CLI spawn，但繞過 Prisma migration engine（語句切分、`ALTER TYPE` 的交易處理、`_prisma_migrations` 記帳），會讓測試環境與 CI／production 走**不同的 migration 路徑**——正是 R9（`PROJECT_STATE.md` L141）那類「只有真實路徑才會暴露」的缺陷溫床。否決。

**`maxForks` 的單一事實來源**：目前 `vitest.config.ts:37` 就地計算。實作須抽到共用模組（例：`backend/test/setup/max-forks.ts`），由 `vitest.config.ts` 與 `global-setup.ts` 共同 import，避免兩處各算一次而漂移。

### 4.4 D4 — per-file 清空：**每個測試檔開始前 TRUNCATE 該 schema 的業務表**

**定案建議：採用。這是 D1 的必要補強，不是可選優化。**

**為何必要（機制論證）**：`isolate: true` ⇒ 每個測試檔一個新行程，但槽位（schema）跨檔重用（§2.4 實測）。因此 per-worker schema 只消滅**跨 worker** 干擾，**同槽位前後檔**的干擾原封不動。而六類事故中至少有三類（R2 的 `seed:admin` 全域降級殘留、R3 機制 B 的參數版本全域可見、T12F 的 `AuditLog` 未清理引爆 FK）在「同 schema 前後檔」情境下**仍會發生**。加上 per-file TRUNCATE 後：

| 事故 | per-worker schema 單獨是否消滅 | ＋per-file TRUNCATE |
|---|---|---|
| #1 R1 跨檔種子帳號撞名 | 跨 worker 是；同槽位否 | **是** |
| #2 T1R 全域 `deleteMany` 引爆平行測試 | 是（別人的資料不在我的 schema） | 是 |
| #3 R2 `seed:admin` 全域降級 ADMIN | 跨 worker 是；同槽位否 | **是** |
| #4 R3 機制 B 參數版本表全域可見 | 跨 worker 是；同槽位否 | **是** |
| #5 T12F `AuditLog` 未清理 → FK 違反 | 否（同槽位前一檔留下的 AuditLog 仍在） | **是** |
| #6 R6 `LIKE` 萬用字元誤刪他檔使用者 | 跨 worker 是；同槽位否 | **是** |
| R6 附帶：行程級中斷殘留（`PROJECT_STATE.md` L121） | **否**（殘留就在自己的 schema 裡） | **是**（AC-12） |

**實作形狀**：`setupFiles` 內註冊 root-level `beforeAll`（vitest 中 setup 檔註冊的 root hook 先於測試檔內任何 `describe` 的 `beforeAll` 執行），內容為：

1. 動態列舉 `pg_tables WHERE schemaname = <worker schema> AND tablename <> '_prisma_migrations'`（**不寫死表清單**，避免日後新增 model 時漏掉）。
2. 單一 `TRUNCATE TABLE <全部> RESTART IDENTITY CASCADE`。
3. 用完即 `$disconnect()`。

**成本**：實測 ~192ms/次 × 47 檔 ÷ maxForks(8) ≈ **1.2s wall**。納入 AC-23 的 20% 預算。

**為何不用 per-test（每個 `it`）清空**：既有 32 個檔全部在 `beforeAll` 建 fixture、在多個 `it` 之間共用（AC-11 即為此設的防護欄）。per-test 清空會破壞全部既有測試，違反 G3。

**為何不用「afterAll 清空」而用「beforeAll 清空」**：`beforeAll` 清空同時覆蓋「上一檔留下的」與「上一次 run 因行程被砍而留下的」兩種殘留；`afterAll` 只覆蓋前者。R6 的追蹤項要的正是後者。

### 4.5 D5 — 啟用開關與 fail-closed 語意

**定案建議：**

| 環境變數 | 值 | 行為 |
|---|---|---|
| `TEST_DB_ISOLATION` | 未設（預設） | `schema` 模式 |
| | `schema` | per-worker schema + per-file TRUNCATE |
| | `off` | 完全還原修復前行為：不改寫 URL、globalSetup 不動任何 DDL、INFRA-001 自身的隔離測試 skip |
| | 其他值 | **拋錯**（不得靜默當成 `off`） |

**fail-closed 三原則**（AC-03）：

1. 隔離啟用但 `VITEST_POOL_ID` 缺席或非正整數 → 拋錯。
2. 隔離啟用但目標 schema 不存在 → 拋錯，訊息含 schema 名與修復建議。
3. **任何情況下都不得以「回退到未改寫的 `DATABASE_URL`」作為錯誤處理**——那正是把結構性隔離悄悄變回共用 DB 的路徑。

**`off` 模式下隔離測試 skip 的設計理由**：使 G5（一鍵回退）真的得到綠燈套件，而不是「回退後有 K 條紅」。但 skip 條件**必須是「`TEST_DB_ISOLATION` 被明示設為 `off`」**，不能是「隔離看起來沒生效」——否則設定被誤刪時測試會自己躲開，鑑別力歸零。此判斷邏輯本身需有單元測試（AC-05）。

### 4.6 D6 — 命名與安全護欄

- schema 命名：`vitest_w<N>`，識別 regex `^vitest_w[0-9]+$`（AC-09 的孤兒清理依此）。
- globalSetup 在 `NODE_ENV=production` 時拒絕執行（AC-06）——DDL（`DROP SCHEMA ... CASCADE`）是本回合唯一具破壞性的動作，必須有明確護欄。
- globalSetup 只對符合上述 regex 的 schema 執行 `DROP`；**永不**對 `public` 或任何其他 schema 執行 DDL（AC-09 以 run 前後 `public` 表數不變驗證）。

### 4.7 D7 — 與容量型 503 的關係（成效預期，須量測而非宣稱）

`backend/vitest.config.ts` L32–36 的殘餘風險自陳原文：

```
32: // 殘餘風險（誠實揭露，非過度宣稱已徹底解決）：這是容量餘裕，不是數學上的
33: // 不可能證明——若這台機器同時承受遠超過本次實驗（1 顆核心）的额外負載，同一
34: // 類重試耗盡理論上仍可能重現，只是門檻已大幅提高。要做到與負載完全無關的
35: // 決定性，需要 per-worker 獨立 DB schema 等基礎設施層隔離，超出本 Task
36: // Files Allowed 範圍（會動到 migration／CI 設定）。
```

`PROJECT_STATE.md` L147 的 A-1 補充證據原文（節錄）：

```
147: **A-1 補充證據（2026-08-02 合併後量測，PHASE-005 起必讀）**：大總管於**拆除 compose stack 之後**重置測試 DB 並重跑，14 輪中出現 **2 次 503 flake** + **1 次 8 skipped**（約 **21% 異常率**）。當時主機 CPU 環境負載 **41%**（16 核，`TextInputHost`／`GCC` 等一般背景程序，非本專案）。
```

**本 Spec 的立場（不得過度宣稱）**：503 來自「重試預算耗盡」。耗盡有兩個獨立成因：

- **(a) SSI 序列化衝突**（40001 重試）：`completeTravelApplication` 在 SERIALIZABLE 交易內全表掃描 `FuelParameterVersion`/`EtcParameterVersion`（`PROJECT_STATE.md` L113 記載），而**這兩張表今天是全域共用的**——任何其他 worker 的 phase3a 測試在此期間 INSERT 參數版本，就與該掃描的謂詞鎖衝突。per-schema 隔離使不同 worker 觸及**不同的 relation**，此成因**結構上歸零**（§2.6 論證）。
- **(b) CPU/IO 排隊延遲**：多 worker 對同一 Postgres 造成查詢延遲超出 200ms 退避視窗。per-schema 隔離**完全不改善**這一項（DB 負載一樣）。

因此：**預期 503 率顯著下降但不保證歸零**。AC-24 的 14 輪量測就是用來**量**這件事的，不是用來宣稱它。無論結果如何，`maxForks = cores/2`（針對成因 b）**維持不動**（§7、AC-25）。

**A-1 的狀態**：本回合**不自動關閉 A-1**。若 14 輪量測（含記錄 CPU 負載）為零 503，建議大總管把 A-1 的升級條件改述為「成因 (a) 已結構性消除；剩餘為純容量餘裕」，並保留 Accepted Risk。此為 PROJECT_STATE 之異動，屬大總管白名單，非本 Task。

### 4.8 D8 — 成效驗收輪次 N

**定案建議：N = 14。**

依 A-1 基線異常率 p ≈ 21%（`PROJECT_STATE.md` L147）。若修復無效，連續 N 輪皆無異常的機率為 `(1-0.21)^N`：

| N | 誤判「已修好」機率 |
|---|---|
| 5 | 30.8% |
| 10 | 9.5% |
| **14** | **3.6%** |
| 20 | 0.9% |

N=14 使誤判率降至約 3.6%，且與本專案既有先例一致（B-30：23% 失敗率 → 14 輪，`PROJECT_STATE.md` L98/L100）。

**量測條件（缺一不可，寫入 Handoff）**：

1. 主機**無執行中的 compose stack**（reviewer 於 `PROJECT_STATE.md` L151 提出的流程建議）。
2. 每輪起跑時記錄 CPU 負載百分比。
3. 每輪貼出 passed/failed/**skipped** 三個數字，skipped 必須為 0（`PROJECT_STATE.md` L96 的既有紀律）。
4. 明確 `export DATABASE_URL`，不得依賴 `.env` 自動載入（`PROJECT_STATE.md` L118）。

**本回合之後的常態驗收輪次**：建議降為 **1~2 輪**（retrospective §5 建議①的預期效益），但**須待 AC-24 的 14 輪證據成立後**才由大總管更新驗收紀律；本 Spec 不代為變更治理紀律。

---

## 5. 實作介面契約

> 以下為模組落點與函式簽章的**意圖**；精確型別與內部實作屬 Task 內細節。

### 5.1 新增檔案（全部位於 `backend/test/setup/`，`src/` 永不 import）

| 檔案 | 職責 |
|---|---|
| `backend/test/setup/max-forks.ts` | 唯一的 `maxForks` 計算來源；由 `vitest.config.ts` 與 `global-setup.ts` 共同 import（取代目前 `vitest.config.ts:37` 的就地計算） |
| `backend/test/setup/db-isolation.ts` | **純函式層**：`isolationMode(env)`、`workerSchemaName(poolId)`、`resolveWorkerDatabaseUrl(env)`。不碰 DB、不碰檔案系統，可完全單元測試（AC-02/03/04/05） |
| `backend/test/setup/global-setup.ts` | vitest `globalSetup`：孤兒清理 → drop → spawn `prisma migrate deploy` × maxForks（並行 cap 4）→ 驗證 |
| `backend/test/setup/setup-file.ts` | vitest `setupFiles`：改寫 `process.env.DATABASE_URL` → 驗證 schema 存在（fail-closed）→ root `beforeAll` 內 TRUNCATE |

命名須避開 `include: ["test/**/*.test.ts"]`（`vitest.config.ts:43`），故一律用 `.ts` 而非 `.test.ts`——與既有 `test/integration/_param-version-floor-date.ts` 同慣例。

### 5.2 `backend/vitest.config.ts` 的變更（唯一被修改的既有檔案）

- 新增 `globalSetup: ["./test/setup/global-setup.ts"]`
- 新增 `setupFiles: ["./test/setup/setup-file.ts"]`
- `maxForks` 改為 import 自 `./test/setup/max-forks.ts`
- **L4–L36 的既有 R3 註解一字不動**，另起一段補述 INFRA-001 的關係（特別是「`maxForks` 上限為何仍保留」，見 §7）

### 5.3 執行順序（實作須確保，並由 AC-01/AC-10 驗證）

```
vitest 主行程
 └─ globalSetup            ← 供裝 vitest_w1..N（一次）
     └─ [每個測試檔，各自一個 child process]
         ├─ worker.js 設定 VITEST_POOL_ID   （vitest/dist/worker.js:78）
         ├─ setupFiles: setup-file.ts
         │    ├─ 改寫 process.env.DATABASE_URL → ...?schema=vitest_w<POOL_ID>
         │    ├─ 驗證 schema 存在（否則拋錯）
         │    └─ 註冊 root beforeAll: TRUNCATE
         └─ import 測試檔  ← 此時模組頂層 `const DB_URL = process.env.DATABASE_URL` 讀到改寫後的值
```

**這一步的正確性是整個方案的支點**：若 `setupFiles` 在測試檔 import 之後才跑，32 個檔的 `DB_URL` 會是舊值、隔離完全失效。實作必須以 AC-01（`current_schema()` 斷言）**在真實執行中**驗證此順序，不得只靠推論。

---

## 6. CI 接線

**定案：`.github/workflows/ci.yml` 預期零改動（AC-20）。**

理由：

- `ci.yml:74` 的 `DATABASE_URL` 無 query string，改寫時直接附加 `?schema=`。
- `ci.yml:94-96` 的 `Run Prisma migrations`（對 `public`）**保留不動**：它是一項獨立且有價值的檢查（驗證 migration 能乾淨套用到全新 schema，正是 CI 該做的），且 globalSetup 的供裝與它互不干擾。
- CI runner 為 2~4 核 ⇒ `maxForks = max(2, cores/2)` ⇒ 供裝 2 個 schema，耗時預估 < 5s。

**「CI 上也真正隔離」的證據形式（AC-21）**：

1. AC-14 的自檢測試在 CI 執行並通過，斷言 `current_schema()` 符合 `^vitest_w[0-9]+$`。它在 `public` 上必然紅，因此 CI 綠 ⇒ CI 真的隔離了。
2. 該測試的斷言訊息輸出實際 schema 名與 `maxForks`，可在 CI log 目視核對。
3. AC-13 的固定名稱碰撞對在 CI 執行並通過。

**必須實際開 Draft PR 才拿得到證據**：`ci.yml:3-11` 的觸發分支僅 `phase-001` / `main`，push `infra-001` 不觸發；開向 `main` 的 PR 會觸發。此為 `PROJECT_STATE.md` L149 記載之治理疏漏的同一處，本回合不得重蹈。

**若實作發現必須改 CI**（例：runner 上 `prisma` binary 解析失敗）：屬 Spec 偏離，implementer 應停下並回報，由大總管裁定，不得自行擴大 Files Allowed。

---

## 7. 既有防護的處置（D5 之延伸）

**原則（Packet 明示）：不因新隔離而刪除仍有價值的防線。** 本回合**一行都不刪**（AC-25），僅標註冗餘狀態，供未來獨立回合決定。

| # | 既有防線 | 位置 | 隔離落地後的狀態 | 本回合處置 |
|---|---|---|---|---|
| 1 | `maxForks = cores/2` | `vitest.config.ts:37` | **仍有效、仍必要**。它對付的是容量型延遲（成因 b，§4.7），per-schema 完全不覆蓋 | **保留**，並在註解補述為何 INFRA-001 沒有讓它變冗餘 |
| 2 | RUN_ID / per-run 隨機後綴（12 檔） | 各檔頂層 | 冗餘（跨 worker 由 schema 隔離、同槽位由 TRUNCATE 清空） | 保留。不做 47 檔大改（違反 G3 的零改動與 diff 可審性） |
| 3 | 檔案專屬 loginName 前綴（`p4t1_`、`p4cf_` 等） | 各檔 | 冗餘（同 #2）；另仍有可讀性價值（log 中看得出資料來源） | 保留 |
| 4 | 範圍 `deleteMany` / 追蹤 id 清理（`afterAll`） | 各檔 | 冗餘（下一檔的 TRUNCATE 會清） | 保留 |
| 5 | 「嚴禁全域 `deleteMany({})`」紀律（9 檔明文） | 各檔檔頭 | **從「必須」降為「良好習慣」**——即使有人寫了，也只炸自己的 schema | 保留紀律文字；不放寬 |
| 6 | 參數版本年份分配慣例（例：`phase4-concurrency-freeze.test.ts` 獨佔 2033） | 各檔檔頭 | 冗餘 | 保留 |
| 7 | `dateBeforeAnyKnownParameterVersion()`（R3 機制 B 修法） | `test/integration/_param-version-floor-date.ts` | 仍正確（在隔離後變成「查一張只有自己資料的表」，恆真） | **保留**。它的設計本來就是「當場查 DB 而非假設」，是正確的寫法，不因冗餘而移除 |
| 8 | R6 的 `LIKE` 萬用字元跳脫（測試清理層） | R6 修復處 | 冗餘於測試層 | 保留。**注意**：`application-query.ts:290` 的 production `contains` 萬用字元議題（`PROJECT_STATE.md` L122）與本回合**無關**，不得因此降級 |
| 9 | **R6 self-heal 建議**（9 檔補 `beforeAll` 自癒，`PROJECT_STATE.md` L121「建議 Gate 前統一補上 self-heal」） | 尚未實作 | **結構性關閉**——AC-10 + AC-12 以單一機制覆蓋全部 47 檔，優於在 9 檔各補一段 | **建議大總管將此追蹤項標記為「由 INFRA-001 覆蓋，不再需要逐檔 self-heal」**（PROJECT_STATE 異動屬大總管白名單） |
| 10 | A-1（`maxForks` Accepted Risk 與升級條件） | `PROJECT_STATE.md` L146-147 | 見 §4.7：不自動關閉 | 依 AC-24 量測結果由人類/大總管裁定 |

---

## 8. E2E 與 compose 拓撲（in/out of scope）

### 8.1 E2E：**Out of Scope**（理由與現狀風險）

`playwright.config.ts` 原文：

```
9:  *   - Database: postgresql://testuser:test@localhost:55434/app_test
...
28:   fullyParallel: false,
29:   retries: 0,
30:   workers: 1,
```

排除理由（三項，任一項單獨即成立）：

1. **不同的 DB**：E2E 用 port **55434**，vitest 用 **55432**（§2.8 N-2）。兩者今天就沒有共用 DB，vitest 的隔離對它既無幫助也無傷害。
2. **不同的行程模型**：E2E 打的是**獨立啟動的真實 backend server**（`playwright.config.ts:14` 記載其啟動指令），該行程的 `DATABASE_URL` 由使用者的 shell 提供，**vitest 的 `setupFiles` 在架構上無法觸及**。要隔離必須改 server 啟動方式或 Playwright fixture，屬不同性質的工作。
3. **單 worker、序列執行**（`workers: 1`、`fullyParallel: false`）：不存在平行 worker 互相干擾這個問題。

**現狀殘留風險（明確記錄，不掩蓋）**：4 個 spec 檔（`admin-applications`、`attachments-demo`、`data-isolation`、`travel-application`）循序共用同一個 DB，**跨 spec 與跨 run 的資料殘留不會被清除**。目前靠人工重置 DB（整合 Gate 時建立全新 volume）。這是真實的技術債，但與本回合的失敗模式（平行 worker 互相污染）不同類，且 E2E 只有 11 條、只在 Gate 手動執行、**尚未進 CI**（`PROJECT_STATE.md` L153）。建議留待「E2E 進 CI」的回合一併處理。

### 8.2 compose / production：**完全不受影響**

- `docker-compose.yml` 的 `DATABASE_URL` 來自 `.env`，不含 `?schema=`，行為與今天完全相同。
- 新增的 `TEST_DB_ISOLATION` **只被 `backend/test/setup/**` 讀取**；AC-18 以結構性斷言確保 `backend/src/**` 永不引用它。
- `backend/src/db/prisma.ts:13-24` 的 `getPrismaClient()` 語意不變。

---

## 9. 測試策略

### 9.1 單元（Vitest，不需 DB）

`backend/test/unit/infra001-db-isolation.test.ts` — 對 `db-isolation.ts` 的純函式：

- URL 改寫三形狀（無 query／有其他 query 須保留／已有 `schema=` 須覆蓋）
- `DATABASE_URL` 未設 → 回傳 undefined，不拋錯
- `TEST_DB_ISOLATION=off` → 原樣回傳
- `TEST_DB_ISOLATION=<無效值>` → 拋錯
- `VITEST_POOL_ID` 缺席／`"0"`／`"abc"`／負數 → 拋錯（**逐一**，不只測一種）
- `workerSchemaName(3) === "vitest_w3"`
- skip-gating 邏輯：只有在 `TEST_DB_ISOLATION === "off"` 時回報「應 skip」；缺席或無效值時回報「不應 skip」（AC-05 的鑑別力核心）

`backend/test/unit/infra001-structural.test.ts` — 結構性斷言（AC-18）：掃 `backend/src/**` 不得出現 `test/setup` 或 `TEST_DB_ISOLATION` 字樣。（比照既有 `frontend/test/api-no-body-mutations.test.ts` 的結構性斷言先例。）

### 9.2 整合（Vitest + 真實 Postgres）

| 檔案 | 內容 |
|---|---|
| `backend/test/integration/infra001-isolation-self-check.test.ts` | AC-01（`current_schema()` / `search_path`）、AC-07（`_prisma_migrations` 筆數 = 7）、AC-08（11 表 + 6 enum，且 enum oid ≠ public 同名）、AC-10（11 張表列數皆 0）、AC-11（跨 `it` 資料存活）、AC-19（`FOR UPDATE` 原始 SQL 在 worker schema 解析成功） |
| `backend/test/integration/infra001-collision-a.test.ts` | AC-13：以寫死 `loginName = "infra001_fixed_collision"` 建立 User，**不清理**，斷言 `count === 1` |
| `backend/test/integration/infra001-collision-b.test.ts` | AC-13：與 a 檔**完全相同**的寫死名稱，同樣不清理 |
| `backend/test/integration/infra001-residue-selfheal.test.ts` | AC-12：先注入 `User + Application + AuditLog` 三層殘留（模擬行程級中斷），再驗證本檔自身在 TRUNCATE 後從 0 起跑；並斷言 FK 依賴的插入不會爆 |

**AC-13 的鑑別力保證**：兩檔都不清理，所以「後執行者看得到前執行者的資料」在無隔離時是**確定事件**（同 worker 則序列衝突，異 worker 則並發衝突），必然 P2002 紅。這是本 Spec 唯一一條「拿掉隔離就一定紅」的端到端證明。

**合成資料紀律**：所有新測試檔的 `passwordHash` 使用明顯非真實的常數字串（不呼叫 argon2、不觸及 `src/auth/**`），loginName 使用 `infra001_` 前綴，符合 CLAUDE.md「全程合成資料」。

### 9.3 執行模式驗證（非測試檔，屬 Handoff 證據）

- **AC-15**：`--pool-options.forks.maxForks=1` 全套一輪（所有檔共用 `vitest_w1`）。
- **AC-05 回退驗證**：`TEST_DB_ISOLATION=off` 全套一輪，須綠（隔離測試 skip，其餘照舊）。
- **AC-16/17**：`git diff --stat` 對 `backend/test/`（既有檔）、`backend/src/`、`backend/prisma/`、`frontend/`、`e2e/` 皆為空。

### 9.4 成效量測（AC-22/23/24）

依 §4.8 的 N=14 與四項量測條件。Handoff 須以**固定格式區塊**呈現（retrospective §5 建議④），每輪一行：`round / passed / failed / skipped / wall(s) / host CPU%`。

### 9.5 AC ↔ 測試映射表

> 機械可查格式。「層級」為 unit / integration / evidence（＝非測試的可重現證據，須貼實際輸出）。Task 完成時須更新「狀態」欄。

| AC | 層級 | 測試檔（預定） | 測試名（預定） | Task | 狀態 |
|---|---|---|---|---|---|
| AC-01 | integration | `test/integration/infra001-isolation-self-check.test.ts` | `current_schema() 為本 worker 專屬 schema 且 search_path 不含 public` | T1 | 已完成（T1，`3120029`） |
| AC-02 | unit | `test/unit/infra001-db-isolation.test.ts` | `resolveWorkerDatabaseUrl — 三種 URL 形狀改寫正確` | T1 | 已完成（T1，`3120029`） |
| AC-03 | unit | `test/unit/infra001-db-isolation.test.ts` | `fail-closed — POOL_ID 缺席/非正整數一律拋錯` | T1 | 已完成（T1，`3120029`） |
| AC-03(c) | integration | `test/integration/infra001-isolation-self-check.test.ts` | `schema 不存在時 setup 拋出可行動錯誤` | T1 | 已完成（T1，`3120029`） |
| AC-04 | unit | `test/unit/infra001-db-isolation.test.ts` | `DATABASE_URL 未設時不動作且不拋錯` | T1 | 已完成（T1，`3120029`） |
| AC-05 | unit | `test/unit/infra001-db-isolation.test.ts` | `TEST_DB_ISOLATION=off 原樣回傳；無效值拋錯；skip 僅在明示 off 時` | T1 | 已完成（T1，`3120029`） |
| AC-05 | evidence | — | `TEST_DB_ISOLATION=off` 全套一輪全綠（Handoff 貼三數字） | T3 | **部分達標**——T3 於 2026-08-03 實測：機制正確（4 檔/11 條隔離專屬測試整體 skip、globalSetup 無任何 DDL log），但預設並行度（本機 maxForks）下連續 3 輪皆以完全相同的 2 個測試（`phase3-lifecycle.test.ts` D11、`phase4-travel-complete.test.ts` AC-48）現紅（`expected 503 to be 200`）；`--pool-options.forks.maxForks=1`（序列化）下同批次 0 failed。判定為 §4.7 成因 (a)（跨 worker SSI 衝突）在共用 `public` schema 下的真實重現，屬 A-1 既有風險而非 T3 引入的缺陷，但與本列原文「須綠」字面不符，需人類/大總管裁定 AC-05 的驗收讀法（見 Handoff）。 |
| AC-06 | unit | `test/unit/infra001-db-isolation.test.ts` | `NODE_ENV=production 時 globalSetup 護欄拒絕執行` | T1 | 已完成（T1，`3120029`） |
| AC-07 | integration | `test/integration/infra001-isolation-self-check.test.ts` | `worker schema 的 _prisma_migrations 已完成筆數 = migrations 目錄數` | T1 | 已完成（T1，`3120029`） |
| AC-08 | integration | `test/integration/infra001-isolation-self-check.test.ts` | `worker schema 含 11 業務表與 6 個 schema 本地 enum（oid ≠ public）` | T1 | 已完成（T1，`3120029`） |
| AC-09 | integration | `test/integration/infra001-isolation-self-check.test.ts` | `僅存在 ^vitest_w\d+$ 且編號 ≤ maxForks；public 表數未變` | T1 | 已完成（T1，`3120029`） |
| AC-10 | integration | `test/integration/infra001-isolation-self-check.test.ts` | `檔案起跑時 11 張業務表列數皆為 0` | T2 | 已完成（T2，`6319fea`） |
| AC-11 | integration | `test/integration/infra001-isolation-self-check.test.ts` | `beforeAll 建立的資料在多個 it 之間存活（非 per-test 清空）` | T2 | 已完成（T2，`6319fea`） |
| AC-12 | integration | `test/integration/infra001-residue-selfheal.test.ts` | `注入 User+Application+AuditLog 殘留後仍能從零起跑且 FK 不爆` | T2 | 已完成（T2，`6319fea`） |
| AC-13 | integration | `infra001-collision-a.test.ts` + `infra001-collision-b.test.ts` | `以固定 loginName 建立且不清理，兩檔皆 count===1` | T2 | 已完成（T2，`6319fea`；紅燈鑑別力已於 T2 Handoff 實證） |
| AC-14 | integration | `test/integration/infra001-isolation-self-check.test.ts` | `current_schema() 符合 ^vitest_w\d+$（隔離未生效即紅）` | T1 | 已完成（T1，`3120029`） |
| AC-15 | evidence | — | `maxForks=1` 全套一輪 0 failed / 0 skipped | T2 | 已完成（T2，`6319fea`；大總管獨立驗收 922/0/0） |
| AC-16 | evidence | — | `git diff` 對既有 47 測試檔為空；全套 ≥879 / 0 / 0 | T1,T2 | 已完成——T3 覆核 `git diff main...HEAD --stat` 對既有測試檔/`src/`/`prisma/`/`frontend/`/`e2e/`/`.github/` 為空（僅新增 10 個 `infra001-*`/setup 檔案），T3 的 14 輪皆 922/0/0 |
| AC-17 | evidence | — | `git diff` 對 `src/`、`prisma/`、`frontend/`、`e2e/` 為空 | T1,T2 | 已完成——同上 T3 覆核結果 |
| AC-18 | unit | `test/unit/infra001-structural.test.ts` | `src/** 不引用 test/setup 或 TEST_DB_ISOLATION` | T1 | 已完成（T1，`3120029`） |
| AC-19 | integration | `test/integration/infra001-isolation-self-check.test.ts` | `SELECT ... FROM "Application" FOR UPDATE 在 worker schema 解析成功` | T1 | 已完成（T1，`3120029`） |
| AC-20 | evidence | — | `git diff .github/workflows/ci.yml` 為空 | T3 | 檔案層面已確認（`git diff` 對 `.github/**` 為空）；CI 實際綠燈證據待大總管開 Draft PR 取得，不在 T3 職責內 |
| AC-21 | evidence | — | Draft PR 的 `Backend Build & Tests` job 綠燈 + log 中自檢輸出的 schema 名 | T3 | 待大總管開 Draft PR 後取得，不在 T3 職責內 |
| AC-22 | evidence | — | globalSetup 耗時（本機 + CI 各一） | T1 | 已完成（本機，T1 Handoff）；CI 端待大總管開 PR 後取得 |
| AC-23 | evidence | — | 全套 wall time 前後對照（同機同負載） | T3 | **未達標**——T3 於 2026-08-03 以 `TEST_DB_ISOLATION=off`（預設並行度）近似修復前基準：3 次量測 Duration 均值約 7.9s（CPU 45~50%），對照預設模式（schema 隔離）14 輪 Duration 均值約 13.4s（CPU 34~54%）——增幅約 **70%**，超過 §3 AC-23 訂的 ≤20% 過關線。方法論說明與根因假設（per-file TRUNCATE + `isolate:true` 下每檔皆需全新 PrismaClient 連線的握手成本，實測遠高於 §2.3 探針的 192ms/次估計）見 Handoff；修正需改動 `backend/test/setup/setup-file.ts`（T3 Files Forbidden），故列為待人類/大總管裁定事項，不由 T3 自行處理 |
| AC-24 | evidence | — | 14 輪固定格式表（round/passed/failed/skipped/wall/CPU%） | T3 | **已完成**——T3 於 2026-08-03 連續 14 輪，每輪 922 passed / 0 failed / 0 skipped，CPU 負載 34~54%，backend-only wall time 12.6~15.3s（Duration 欄），全數見 Handoff；無 503 flake、無需中止重跑 |
| AC-25 | evidence | — | `git diff` 顯示 `maxForks` 值未變、無測試檔清理程式碼被刪 | T3 | 已完成——`git diff main...HEAD` 對既有 47 測試檔、`vitest.config.ts` 的 `maxForks` 計算公式（僅搬遷至 `max-forks.ts`，公式字元未變）、既有清理程式碼（RUN_ID/前綴/`deleteMany`）均無刪除或改動 |
| AC-26 | evidence | — | 本 Spec §7-#9 記錄 + AC-10/AC-12 綠燈 | T3 | 已完成——§7-#9 已記錄「結構性關閉，9 檔不需各自補 beforeAll」；AC-10/AC-12 綠燈已於 T2（`6319fea`）與本 T3 14 輪中反覆驗證 |

---

## 10. 非功能需求（NFR）

| # | 需求 | 量測 |
|---|---|---|
| NFR-1 | globalSetup 供裝 ≤ 30s（本機 maxForks=8、CI maxForks=2） | AC-22 |
| NFR-2 | 全套 wall time 增幅 ≤ 20% | AC-23 |
| NFR-3 | 不增加 DB 連線峰值：per-file TRUNCATE 用完即 `$disconnect()`；不改任何 `connection_limit`（本機 `max_connections = 100`） | 實作審查 + AC-24 期間無連線耗盡錯誤 |
| NFR-4 | 跨平台：Windows（開發機）與 Linux（CI）皆須可執行——`prisma` binary 的 spawn 須處理 `.cmd` | AC-21（CI）+ 本機實跑 |
| NFR-5 | 零新增 npm 依賴 | `git diff package*.json` 為空 |

---

## 11. 風險與 Rollback

### 11.1 Rollback

| 層級 | 動作 | 效果 |
|---|---|---|
| **L1（一鍵，不需改碼）** | `export TEST_DB_ISOLATION=off` | 完全還原修復前行為：URL 不改寫、無 DDL、隔離專屬測試 skip、其餘 47 檔照舊跑共用 `public` |
| L2 | revert 本 PR 的單一 merge commit | 完全回到 `183c604` 狀態 |
| L3 | 手動清理 | `DROP SCHEMA "vitest_w<i>" CASCADE`（僅影響拋棄式 schema，`public` 不受影響） |

L1 的存在本身是 AC-05 的驗收對象——**回退路徑必須被測過才算存在**。

### 11.2 風險登錄

| # | 風險 | 機率 | 影響 | 緩解 |
|---|---|---|---|---|
| R-1 | `setupFiles` 執行順序不如預期（在測試檔 import 之後） | 低（§2.4 已從原始碼確認 `VITEST_POOL_ID` 早於 runner 設定；但 setupFiles 相對 import 的順序須實跑確認） | **致命**（隔離靜默失效） | AC-01 為實跑斷言；AC-14 使任何失效都變紅 |
| R-2 | 未來新增需 `public` 內擴充的 migration（`CREATE EXTENSION`） | 低 | 中（worker schema 看不到擴充） | §13-L3 記錄；`search_path` 若需含 `public` 可改為 `?schema=X`＋顯式 `SET search_path` 兩段式（未來回合） |
| R-3 | 並行 `prisma migrate deploy` 遇 advisory lock 逾時（實測 3 個 OK，8 個未測） | 中低 | 低（供裝變慢或失敗） | D3 要求量測實際 maxForks；失敗即降為序列並記錄；**禁用** `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK` |
| R-4 | 有人以 CLI 提高 `maxForks` 超過供裝數 | 中 | 中 | AC-03(c) fail-closed 拋錯，訊息含修復建議 |
| R-5 | TRUNCATE 成本在測試檔增加後線性上升（現 47 檔 × 192ms） | 中 | 低 | NFR-2 的 20% 預算為守門；超出時可改為「僅在偵測到非空時 TRUNCATE」 |
| R-6 | 誤刪非測試 schema | 極低 | **高** | D6：只對 `^vitest_w[0-9]+$` 執行 DDL；`NODE_ENV=production` 護欄；AC-09 驗證 `public` 表數不變 |
| R-7 | 對 A-1（503）成效不如預期，14 輪未過 | 中（§4.7 明示只消滅成因 a） | 中（Task 無法宣告完成） | AC-24 要求提出診斷而非重跑；`maxForks` 保留為既有防線；必要時把「殘餘為純容量問題」寫回 A-1 |
| R-8 | vitest 升版改變 `VITEST_POOL_ID` 語意 | 低 | 高 | AC-01/AC-14 會在升版當下變紅；§13-L4 記錄此耦合 |

---

## 12. Task Graph

> 全部 **Medium**。本回合**不觸及** `src/auth/**`、`src/seed/seed-admin.ts`、附件權限、金額語意，故**無 High 風險 Task**。
> **Stop 條件（三個 Task 共通）**：若實作發現任一 Task 必須修改 `backend/src/**`、`backend/prisma/**`、既有 47 個測試檔任一行，或必須觸及 `src/auth/**`／`seed-admin.ts`——**立即停止並回報大總管**，不得自行擴大範圍（`src/auth/**`／`seed-admin.ts` 一經觸及即為 High，需人類事前批准，見 `PROJECT_STATE.md` L102 的教訓）。

### T1 — per-worker schema 隔離核心（Medium）

- **內容**：`max-forks.ts`、`db-isolation.ts`（純函式）、`global-setup.ts`（供裝）、`setup-file.ts`（僅 URL 改寫 + schema 存在性驗證，**不含 TRUNCATE**）、`vitest.config.ts` 接線；自檢測試與純函式單元測試。
- **AC**：AC-01~AC-09、AC-14、AC-16、AC-17、AC-18、AC-19、AC-22
- **Files Allowed**：`backend/vitest.config.ts`、`backend/test/setup/**`（新）、`backend/test/unit/infra001-*.test.ts`（新）、`backend/test/integration/infra001-isolation-self-check.test.ts`（新）
- **Files Forbidden**：`backend/src/**`、`backend/prisma/**`、既有 47 測試檔、`_param-version-floor-date.ts`、`.github/**`、`docker-compose.yml`、`frontend/**`、`e2e/**`
- **Done When**：全套 ≥879 / 0 failed / **0 skipped**（明確 `export DATABASE_URL`）；AC-01 與 AC-14 實跑通過；`git diff` 證明既有檔零改動；供裝耗時已量測。

### T2 — per-file 清空 + 鑑別力測試（Medium）

- **內容**：`setup-file.ts` 加入 root `beforeAll` TRUNCATE（動態列舉表名）；AC-13 的兩個固定名稱碰撞檔；AC-12 的殘留自癒檔；`maxForks=1` 全套驗證。
- **AC**：AC-10~AC-13、AC-15、AC-16、AC-17
- **依賴**：T1
- **Files Allowed**：`backend/test/setup/setup-file.ts`、`backend/test/integration/infra001-collision-a.test.ts`、`...-collision-b.test.ts`、`...-residue-selfheal.test.ts`（皆新增）、`backend/test/integration/infra001-isolation-self-check.test.ts`（補 AC-10/11）
- **Files Forbidden**：同 T1
- **Done When**：預設模式與 `maxForks=1` 模式各一輪全綠；**並須提出 AC-13 的鑑別力實證**——以 `TEST_DB_ISOLATION=off` 但**暫時關閉 skip gating** 的方式（或等價的本機實驗，不進 commit）證明兩檔在共用 DB 下確實會紅，Handoff 貼出該次紅燈輸出。

### T3 — 成效量測、防線盤點與 CI 證據（Medium）

- **內容**：`vitest.config.ts` 註解補述（為何 `maxForks` 上限仍保留、INFRA-001 與 R3 的關係）；AC-24 的 14 輪量測；AC-05 的回退驗證；AC-23 的前後 wall time 對照；Draft PR + CI 綠燈；§9.5 映射表狀態更新。
- **AC**：AC-05(evidence)、AC-20、AC-21、AC-23~AC-26
- **依賴**：T2
- **Files Allowed**：`backend/vitest.config.ts`（僅註解）、`docs/specs/INFRA-001.md`（僅 §9.5 狀態欄與 §15 修訂列）
- **Files Forbidden**：同 T1，另加 `.github/workflows/ci.yml`（若證明必須改，停下回報）
- **Done When**：14 輪固定格式表全綠並附 CPU 負載；CI 三 job 綠；映射表 26 條 AC 全數標記完成。

---

## 13. 已知限制

- **L1 — 不解決容量型 503**。§4.7 已論證：per-schema 消滅成因 (a)（跨 worker SSI 衝突），不影響成因 (b)（CPU 排隊）。`maxForks = cores/2` 因此保留。A-1 的 Accepted Risk 不由本回合關閉。
- **L2 — 未調整 Prisma connection pool**。本機 `max_connections = 100`；每個 PrismaClient 預設 `connection_limit = 實體核心數 × 2 + 1`，而部分測試檔（如 `admin-users.test.ts`）在多個 `describe` 各建一個 client。連線為惰性建立故現況未爆，但這是**相鄰的容量議題**，若日後出現連線耗盡，可在同一個 setup 檔加 `connection_limit` 參數（改動面積極小）。本回合不動。
- **L3 — `search_path` 不含 `public`**（§2.2 實測）。目前零 `CREATE EXTENSION`，無風險；未來若引入需 `public` 擴充的 migration，須回頭調整（R-2）。
- **L4 — 與 vitest / tinypool 內部行為耦合**。`VITEST_POOL_ID` 非公開契約中的穩定 API（本 Spec 以 vitest 2.1.9 的原始碼為據）。升級 vitest 時 AC-01/AC-14 會立即現形，屬 fail-loud 而非 fail-silent，可接受。
- **L5 — E2E 殘留未處理**（§8.1）。
- **L6 — 冗餘防線未清理**（§7）。47 檔中的 RUN_ID／前綴／`afterAll` 清理成為冗餘但保留；日後若要簡化，應為獨立回合並逐檔驗證，不可與本回合混合（會使 diff 不可審）。
- **L7 — 供裝依賴 `prisma` CLI 可執行**。若 `node_modules` 未安裝或 binary 解析失敗，globalSetup 會失敗（fail-loud）。

---

## 14. 需人類批准決策點清單（供 Gate 審閱）

> 依 CLAUDE.md 與治理 2026-08-01.2：本回合**不觸及**認證／授權／密碼／附件權限／金額語意／公開 API／不可逆 migration／部署平台，故**無「必須人類批准」等級的項目**。以下 D1~D8 為 Spec Gate 的裁定對象；spec-writer 的建議**不得視為既定**。

| # | 決策點 | 建議 | 風險/影響 | 證據 |
|---|---|---|---|---|
| **D1** | 隔離機制：per-worker **schema** / per-worker **database** / 每測試可回滾交易 | **per-worker schema** | 決定整個回合的落地面積。schema 方案使既有 47 檔零改動；database 方案 CI 需加步驟且清理較脆；交易方案結構上不可行（HTTP + 服務層自開 SERIALIZABLE 交易） | §2.1、§2.2、§2.3、§4.1（含實測） |
| **D2** | worker 身分：`VITEST_POOL_ID` vs `VITEST_WORKER_ID` | **`VITEST_POOL_ID`** | `WORKER_ID` 無上限（每檔遞增）會產生 47 個 schema；`POOL_ID` 嚴格 1..maxForks 但**會跨檔重用**，故必須配 D4 | §2.4（vitest/tinypool 原始碼行號） |
| **D3** | migration 套用：globalSetup 一次性 vs per-worker lazy + advisory lock；schema 清理時機 | **globalSetup 並行（cap 4）供裝；run 前 drop、run 後保留** | 供裝實測 2.37s／個、3 個並行 2.70s；run 後保留可供事後除錯。lazy 方案複雜度不划算 | §2.3、§4.3 |
| **D4** | 是否加 **per-file TRUNCATE**（Packet 原案只有 per-worker） | **加，且視為必要而非可選** | 這是本 Spec 相對 Packet 的唯一實質補強。不加則六類事故中的 #1/#3/#4/#5/#6 在「同槽位前後檔」情境**仍會發生**，R6 的行程級殘留也無法關閉。成本 ~192ms/檔 | §2.4、§4.4（含事故對照表與實測成本） |
| **D5** | 開關語意與 fail-closed 邊界；`off` 時隔離測試是否 skip | **`TEST_DB_ISOLATION`（預設 `schema`）；三條 fail-closed；`off` 時隔離測試 skip，但僅在明示 `off` 時** | skip gating 若寫錯（例如改成「偵測不到隔離就 skip」），鑑別力會歸零——這是最容易寫錯且最難察覺的一處 | §4.5、AC-05 |
| **D6** | 既有防線處置（RUN_ID／前綴／範圍清理／`maxForks`／R6 self-heal 建議） | **一行不刪**；僅標註冗餘；`maxForks` 明確保留；**R6 self-heal 追蹤項建議標記為由 INFRA-001 結構性覆蓋** | 唯一有治理意涵者為 R6 追蹤項的狀態變更（PROJECT_STATE 異動屬大總管白名單，需人類/大總管確認） | §7 |
| **D7** | A-1（503 Accepted Risk）在本回合後的狀態 | **不自動關閉**；依 AC-24 的 14 輪量測結果由人類/大總管裁定是否改述升級條件 | 過度宣稱「隔離修好了 flake」正是 retrospective 警示的模式。§4.7 明確區分成因 (a)（結構性消滅）與 (b)（不受影響） | §4.7、`PROJECT_STATE.md` L146-147 |
| **D8** | 成效驗收輪次 N 與量測條件 | **N = 14**，四項量測條件（無 compose、記錄 CPU%、三數字且 skipped=0、明確 export `DATABASE_URL`） | N 太小會誤判（N=5 誤判率 30.8%）。本回合之後常態輪次是否降為 1~2，屬治理紀律變更，**不由本 Spec 代決** | §4.8 |

**附註 1（依賴）**：本回合**不新增任何 npm 依賴**。若實作評估需要新依賴，須列為新 D 級決策交 Gate。

**附註 2（範圍護欄）**：`src/auth/**`、`src/seed/seed-admin.ts`、附件權限相關檔案**一經觸及即為 High、需人類事前批准**（`PROJECT_STATE.md` L102 教訓）。本 Spec 已勘查確認三個 Task 皆不需觸及：`admin-users.test.ts:1140-1141` 只是在**執行期**改寫 `process.env.DATABASE_URL` 來驅動 `runSeedAdmin`，`seed-admin.ts` 原始碼不需任何變更。

---

## 15. Blocking Unknowns

無。§2 的實測已把 Packet 列出的全部待查項（`?schema=` 支援、migration 成本、`ALTER TYPE` 行為、與 60 處 `new PrismaClient()` 的相容性、app 端 client 的建構時機、`app.inject` 取得 app 的方式、migration 現行套用方式、`describeWithDb` 機制、E2E 是否共用 DB、worker id 語意）逐項回答並附證據。

唯一未以實測收斂、留給實作驗證的是 **R-1（`setupFiles` 相對測試檔 import 的執行順序）**——這不是 Blocking Unknown（AC-01 會在第一次實跑當場給答案，且失敗方向為 fail-loud），但它是整個方案的支點，implementer 必須在 T1 的第一步就實跑確認，不得留到最後。

---

## 16. Architecture / Data Flow 更新建議（供大總管處置，本 Spec 不直接改）

1. 本回合不改變任何 runtime 架構，`ARCHITECTURE.md` / `DATA_FLOW.md` **無需更新**。
2. 建議於 `CLAUDE.md`「常用指令」節（目前為空佔位）補上後端測試的標準執行方式（明確 `export DATABASE_URL`、`TEST_DB_ISOLATION` 的語意、`maxForks=1` 的除錯用法）——屬大總管白名單之外的一般文件變更，由大總管決定派工方式。
3. 建議 AC-24 的 14 輪量測輸出格式固化為腳本（retrospective §5 建議④「驗證證據改成固定腳本的輸出」）。**本 Spec 未把它納入 Task Graph**（會擴大範圍且與隔離修復正交），列為後續回合建議。

---

## 17. Spec 修訂紀錄

| 日期 | 版本 | 變更 | 依據 |
|---|---|---|---|
| 2026-08-03 | **文件校正（ACTIVE 內，DOC-FIX-001）**：§2.5 撤回「vitest 不會自動載入 `.env`」之錯誤事實主張及其對舊事故的因果歸因 | **原文主張**：§2.5 稱「vitest **不會**自動把 `.env` 載入 `process.env`」，並引 `PROJECT_STATE.md`（原文寫 L96／L118）之「未 export `DATABASE_URL` 造成 55 skipped」為佐證。**T1 實測推翻（2026-08-03）**：vitest 2.1.9 會自動載入 `backend/.env` 並把**全部**變數（非僅 `VITE_` 前綴）寫入 `process.env`（Vitest 沿用 Vite env 檔載入、對 `process.env` 採空前綴之標準行為），故本機未 `export` 時 `DATABASE_URL` 仍有值。**處置**：(1) §2.5 保留原文與原引用為歷史紀錄，另加「T1 實測更正」段落載明正確行為；(2) **撤回因果歸因**——`PROJECT_STATE.md` 之兩起 55 skipped 事故（**驗收紀律事件（T6）**、**驗收紀律事件（第三次，R3）**；原引 L96／L118，撰稿當時實際為 L99／L121，現為 L103／L125，故改以事件名稱定位）**另有成因、尚未查明**，本 Spec 與後續 Phase 不得再以「`.env` 未被載入」解釋之；(3) 明載對本 Spec **零影響**——CI 因 `backend/.env` 受 `.gitignore` L10-12 排除而無此檔（`DATABASE_URL` 由 `ci.yml` L74 workflow `env` 提供），且 `setup-file.ts` 以 `process.env.DATABASE_URL` 之實際值為輸入，來源無涉 D1 改寫與 D5 fail-closed 之正確性；(4) §4.8／§12 之「明確 `export DATABASE_URL`，不得依賴 `.env` 自動載入」**文字不變**，惟語義自此定位為執行紀律而非 vitest 行為主張。**無 AC 增刪、無 AC 語意變更、無決策變更、無程式／測試變更。** | 使用者 leonchih 2026-08-03 授權處理累積文件待辦；事實依據為 INFRA-001-T1 實測（2026-08-03）。治理 2026-08-02.3 §11.1「格式、文字澄清」——本列為**更正已被實證推翻之事實陳述**，不含新決策，不觸發 §11.3。 |
| 2026-08-03 | ACTIVE（T3 量測） | T3（成效量測、防線盤點、CI 前置）完成大部分交付並更新 §9.5 狀態欄：AC-01~AC-19、AC-22（本機）、AC-24~AC-26 已完成；AC-16/17（既有 47 檔+`src/`/`prisma/`/`frontend/`/`e2e/`/`.github/` 零改動）覆核通過。**兩項未達 Spec 原文字面標準，留待人類/大總管裁定**：(1) AC-23 全套 wall time 增幅實測約 70%（`TEST_DB_ISOLATION=off` 預設並行度 3 次均值 ~7.9s vs 預設 schema 隔離模式 14 輪均值 ~13.4s），超過 §3 訂的 ≤20% 過關線；(2) AC-05 evidence 在預設並行度下連續 3 輪皆以相同 2 個測試現紅（`expected 503 to be 200`），僅在 `--pool-options.forks.maxForks=1`（序列化）下全綠——判定為 §4.7 已知成因 (a)（跨 worker SSI 衝突）在共用 `public` schema 下的真實重現，屬 A-1 既有風險而非 T3/T1/T2 引入的新缺陷，但與 AC-05 原文「須綠」字面不符。兩項的修正（若採納）皆需改動 T3 Files Forbidden 範圍內的檔案（`setup-file.ts` 等），故 T3 未自行處理，完整數據與根因假設見 Task Handoff。AC-20/21（CI 綠燈）依 Spec 原意由大總管開 Draft PR 後取得，非 T3 職責。 | T3 implementer 實測（2026-08-03），Spec §3/§4.7/§9.4 |
| 2026-08-03 | T3 量測後裁定（人類批准兩項） | T3 實測：AC-24 十四輪 922/0/0 零 503（核心目標達成）；AC-23 增幅 ~69% 超過 ≤20% 門檻（根因假說：`isolate:true` 下 per-file TRUNCATE 每檔新建 Prisma 連線 ×53，Spec §2.3 探針未含連線開銷——即 §11.2 R-5 預見之情境）；AC-05 off 模式預設並行度 3/3 重現修復前 503 flake。人類裁定：①派 REPAIR（R1）依 R-5 緩解方向優化 TRUNCATE 開銷後重測 AC-23（門檻維持 ≤20% 不放寬）；②AC-05 文字修訂如該條新增粗體段（機制正確性 + maxForks=1 全綠為準）。另更正 §12 T3 Files Allowed 之「§15 修訂列」為「§17 修訂列」（章節編號誤植，T3 implementer 正確識別並回報）。 | 使用者裁定（2026-08-03，leonchih）|
| 2026-08-03 | DRAFT→ACTIVE | 人類 Spec Gate 通過：**D1~D8 全數照 spec-writer 建議批准**（D1 per-worker schema、D2 `VITEST_POOL_ID`、D3 globalSetup 並行供裝＋run 前 drop、**D4 per-file TRUNCATE 必加**、D5 `TEST_DB_ISOLATION` fail-closed、D6 既有防線一行不刪、D7 A-1 不自動關閉、D8 N=14）。大總管同回合代修兩處驗收發現之瑕疵：檔頭 Governance-Version 誤植 `2026-08-02.3`→`2026-08-01.2`；§4.1 兩處「32 檔」統一為「31 個 integration 檔（29 檔 `DB_URL` + 2 檔例外路徑）」與 §2.1 一致。轉 ACTIVE，開始 T1。 | 使用者 Gate 批准（2026-08-03，leonchih）|
| 2026-08-03 | DRAFT 建立 | 依 SPEC-INFRA-001 Packet 建立完整 Spec（§1~§16 + 決策點 D1~D8 + 26 條 AC + AC↔測試映射表）。相對 Packet 原案新增 **D4（per-file TRUNCATE）**，理由為 `isolate: true` 造成 worker 槽位跨檔重用，單靠 per-worker schema 不足以消滅同槽位前後檔污染（§2.4 原始碼實證、§4.4 事故對照表）。所有技術定案附 §2 的實測證據。 | `docs/retrospective/PHASE-004.md` §5 建議①（L153-156）；`PROJECT_STATE.md` A-1（L146-147）、R6（L120-121）、六類事故（L98-102）；`backend/vitest.config.ts` L4-37；`.github/workflows/ci.yml` L53-99；`playwright.config.ts` L9/28-30；vitest 2.1.9 與 tinypool 原始碼；2026-08-03 對本機 PG16 之可逆探針實測 |

> 狀態轉移：DRAFT →（人類 Spec Gate 裁定 D1~D8）→ ACTIVE → T1/T2/T3（TDD）→ reviewer → Draft PR + CI → 人類合併批准 → COMPLETED。
> 補充（治理 2026-08-02.3）：Gate 中人類提出之任何變更（無論多小），須先由 spec-writer／大總管完成本 Spec 修訂（引用該批准與日期）後方可實作。
