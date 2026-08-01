# PHASE-001 Spec — 專案骨架與 CI 基礎

- Governance-Version: 2026-08-01.1
- 狀態：ACTIVE
- 更新日期：2026-08-01
- Phase ID：PHASE-001
- Base Commit：f59649f（branch: phase-001）
- 上游事實來源：`userstory.md`（NFR-US-01~06、15、16）、`docs/PRD.md` 第 5 節 PHASE-001、`docs/ARCHITECTURE.md`、`docs/adr/ADR-0001.md`、`CLAUDE.md`
- Risk Level：Medium（純新增檔案、無 High Task；但錯誤協定與 env 約定影響全案技術骨架）
- Human Gate：事後整合驗收（`docker compose` 啟動 + CI 綠燈）

> 本 Spec 目標為自足：implementer 依 TDD 逐 Task 實作時，不需再讀 `userstory.md` 全文即可完成 T1~T6。凡本 Spec 未定案而影響產品行為者，列於第 12 節開放事項並交回大總管，不得由 implementer 臆測。

---

## 1. 目標與非目標

### 1.1 目標

建立可啟動的三容器骨架（nginx 前端 / node 後端 / PostgreSQL 16），並具備：

1. 後端最小 Fastify 服務，提供 `/health`（含 DB 連線檢查），DB 不通時回異常狀態。
2. Prisma 初始化與可運作的 migration 機制（含一個最小 migration 驗證機制可用）。
3. 後端 env 載入與驗證：缺必要 env 啟動即失敗並指出缺項。
4. 前端最小 React + Vite 應用，呼叫 `/api/health` 顯示後端與 DB 狀態；dev proxy 設定就緒。
5. 三容器 Dockerfile（nginx 多階段、node 多階段）+ `docker-compose.yml`（三服務 + postgres volume + healthcheck + 啟動順序）+ `.env.example`。
6. nginx 以 `/api` 反向代理至後端，維持同源（ADR-0001）。
7. CI（GitHub Actions）：lint、type check、unit test、frontend build、backend build、docker build 全綠。
8. 結構化錯誤協定定案（統一錯誤回應格式、欄位級驗證錯誤表達、錯誤碼慣例、不外洩堆疊/DB 結構）+ Fastify error handler + 404/500 處理，供全案沿用。
9. 環境變數約定：全走 env，無寫死 secrets。

Phase 結束驗收：人類可在本機 `docker compose up` 啟動三服務，於瀏覽器看到前端呼叫後端 `/api/health` 回傳正常；停掉 DB 時前端顯示 DB 異常；CI 綠燈。

### 1.2 非目標（Out of Scope，屬後續 Phase）

- 任何業務功能、認證/授權、Session、密碼、附件、業務資料表（僅 migration 機制就緒與 health 所需最小結構）。
- storage 抽象層的實作（僅**預留** `STORAGE_PATH` 環境變數與 volume 掛載點；抽象層本體於 PHASE-003）。
- Playwright/PDF、E2E 測試（PHASE-008 起）。
- HTTPS/Cookie Secure/正式部署硬化、備份（PHASE-011）；本 Phase Cookie 相關一律不做。
- PHASE-002+ 的任何內容。

---

## 2. 可測試 Acceptance Criteria

以下將 NFR-US-01~06/15/16 的 Given/When/Then **具體化**為 PHASE-001 可驗收形式，**不改變原意**。每條標註對應 US 與由哪個 Task 覆蓋。

### AC-01 前端可 Docker 啟動並提供服務（NFR-US-01 / T3, T4）
- Given 已由 `frontend/Dockerfile` 建置前端 image。
- When 提供必要環境設定並 `docker compose up` 啟動 nginx 容器。
- Then nginx 於容器 port 80 提供 React SPA 靜態資產，首頁可載入（HTTP 200）。

### AC-02 後端可 Docker 啟動並提供服務（NFR-US-02 / T2, T4）
- Given 已由 `backend/Dockerfile` 建置後端 image。
- When 提供必要環境變數（含 `DATABASE_URL`）並啟動 node 容器。
- Then 後端於 `PORT` 監聽，`GET /health` 可回應。

### AC-03 前後端分開容器、可各自重建（NFR-US-03 / T4）
- Given `docker-compose.yml` 定義 `frontend`、`backend`、`db` 三個獨立 service。
- When 只重建 `frontend`（`docker compose build frontend`）。
- Then `backend` 與 `db` 的 image 不需被重建（各 service 有獨立 build context 與 Dockerfile）。

### AC-04 資料庫獨立於應用容器且資料不隨應用重建遺失（NFR-US-04 / T4）
- Given `db` service 使用具名 volume（例 `pgdata`）保存資料。
- When 刪除並重建 `frontend`/`backend` 容器（`docker compose up -d --force-recreate frontend backend`）。
- Then `db` 資料仍存在（重建前寫入的最小驗證資料仍可查得，見 T2 migration 驗證）。

### AC-05 環境變數驅動環境差異且無寫死 secrets（NFR-US-05 / T1, T2, T4）
- Given 專案含 `.env.example`，所有環境相依值（DB 連線、port、儲存路徑等）以 env 提供。
- When 檢查整個 repo（原始碼、compose、Dockerfile、CI）。
- Then 不存在寫死的正式敏感資訊（正式密碼、正式連線字串、token）；程式一律讀 `process.env`（後端經 env schema，見 T2）。
- And 提供不同 env 值時，服務使用對應設定（可由 `PORT` 覆寫驗證）。

### AC-06 本機 Docker Compose 一次啟動三服務並串接（NFR-US-06 / T4）
- Given 本機已安裝 Docker Compose 且已提供 `.env`（複製自 `.env.example`）。
- When 執行 `docker compose up`。
- Then `frontend`、`backend`、`db` 皆啟動；前端可連後端（瀏覽器打 `/api/health` 經 nginx 代理到 backend），後端可連 db。
- And 容器重新啟動後（`docker compose restart`）DB 資料不遺失。

### AC-07 健康檢查正常狀態（NFR-US-15 / T2）
- Given 後端服務正常且 DB 可連。
- When `GET /health`。
- Then 回 HTTP 200，body 為 `{ "status": "ok", "checks": { "db": "up" }, ... }`（形狀見第 5 節）。

### AC-08 健康檢查異常狀態（NFR-US-15 / T2）
- Given 後端運行但 DB 無法連線（例：db 停止或連線失敗）。
- When `GET /health`。
- Then 回 HTTP 503，body 為 `{ "status": "error", "checks": { "db": "down" }, ... }`；不外洩 DB 連線字串、主機、堆疊或 driver 內部訊息。

### AC-09 缺必要 env 啟動即失敗並指出缺項（NFR-US-05 延伸 / T2）
- Given 後端啟動時缺少必要環境變數（例 `DATABASE_URL` 未設定）。
- When 啟動後端 process。
- Then process 以非 0 退出碼失敗，並在啟動日誌明確列出缺少/不合法的 env 變數名稱（僅名稱與原因，不印出值）。

### AC-10 欄位級驗證錯誤可被前端辨識（NFR-US-16 / T6）
- Given 一個會做輸入驗證的端點（本 Phase 以測試用 echo/validation 端點驗證協定，見 T6）。
- When 送出不合法欄位。
- Then 回統一錯誤格式：含 `error.code`、`error.message`、`error.fields[]`（每項含 `field` 與 `reason`），前端可據以定位欄位與原因（形狀見第 5 節）。

### AC-11 非預期錯誤不外洩敏感資訊（NFR-US-16 / T6）
- Given 後端發生非預期錯誤（500）。
- When 回應使用者。
- Then response body 不含程式堆疊、資料庫結構、SQL、檔案路徑或連線字串；僅含統一錯誤格式（`code=INTERNAL_ERROR`、通用 message、`requestId`）。

### AC-12 伺服器日誌含追查識別但不含敏感資訊（NFR-US-16 / T2, T6）
- Given 發生伺服器錯誤（500）。
- When 系統記錄日誌。
- Then 日誌含可追查識別（`requestId` / 錯誤摘要），但不含密碼、token、session、`DATABASE_URL` 值等敏感憑證。

### AC-13 404 統一格式（NFR-US-16 延伸 / T6）
- Given 請求不存在的路由。
- When 後端回應。
- Then 回 HTTP 404 且 body 為統一錯誤格式（`code=NOT_FOUND`），非框架預設裸格式。

### AC-14 CI 綠燈（NFR-US-01/02 建置 + 工程規則 / T5）
- Given push 或 PR 至 `phase-001`。
- When CI 執行。
- Then lint、type check、unit test、frontend build、backend build、docker build 皆通過（綠燈）。

---

## 3. 專案結構定案

### 3.1 Workspace 工具定案：**pnpm workspace**

**定案：採用 pnpm（`pnpm-workspace.yaml`）作為 monorepo 管理工具。Node 版本鎖定 `20 LTS`（`.nvmrc` = `20`，`engines.node >=20 <21`）。pnpm 版本經 `packageManager` 欄位鎖定（例 `pnpm@9`）。**

理由：
- pnpm workspace 對 monorepo 的依賴隔離（非扁平 `node_modules`）較嚴謹，避免幽靈依賴，利於前後端獨立建置與獨立 Docker context。
- pnpm 的 `--filter` 可精準對單一 package 執行 lint/build/test，Docker 多階段建置可只複製對應 package，image 較小。
- 免費、開源（MIT）、成熟、無授權疑慮。相較 npm workspaces，pnpm 在 CI 快取與磁碟效率上更佳，且與 Docker 多階段配合良好。
- Node 20 LTS：長期支援、Fastify 5 / Prisma / Vite 5 皆支援；避免用 22/23 造成部分工具相容性風險。

> 若大總管或人類偏好 npm workspaces（減少一個工具依賴），屬可替換之內部決策，替換不影響 AC；但本 Spec 以 pnpm 為定案，implementer 依此實作。

### 3.2 Monorepo 佈局

```
/                         # repo 根
├── package.json          # 根：workspace scripts（lint/test/build/typecheck 聚合）、devDependencies（共用工具）
├── pnpm-workspace.yaml    # packages: frontend, backend
├── .nvmrc                 # 20
├── .npmrc                 # engine-strict=true 等
├── tsconfig.base.json     # 共用 TS 編譯選項（strict）
├── biome.json             # lint + format 設定（見 T1 定案）
├── .env.example           # 環境變數範本（唯一 secrets 定義來源，值為佔位）
├── .gitignore
├── docker-compose.yml
├── .dockerignore
├── frontend/
│   ├── package.json
│   ├── tsconfig.json      # extends ../tsconfig.base.json
│   ├── vite.config.ts     # 含 dev server proxy /api → backend
│   ├── index.html
│   ├── Dockerfile         # 多階段：build（node）→ nginx 靜態服務 + /api 反向代理
│   ├── nginx.conf         # SPA fallback + /api proxy_pass
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx        # 呼叫 /api/health 顯示狀態
│   │   └── api/health.ts  # fetch 封裝
│   └── test/              # Vitest 前端測試
├── backend/
│   ├── package.json
│   ├── tsconfig.json      # extends ../tsconfig.base.json
│   ├── Dockerfile         # 多階段：build（node）→ 精簡 runtime（node）
│   ├── prisma/
│   │   ├── schema.prisma  # datasource + generator + 最小 model（見 T2）
│   │   └── migrations/    # 由 prisma migrate 產生
│   ├── src/
│   │   ├── server.ts      # buildServer()：組裝 Fastify（plugin、error handler、routes）
│   │   ├── index.ts       # 進入點：載入/驗證 env → buildServer → listen
│   │   ├── config/
│   │   │   └── env.ts     # env schema 驗證（缺項即失敗，見 T2）
│   │   ├── platform/
│   │   │   ├── health.ts      # /health route + DB 檢查
│   │   │   ├── errors.ts      # 錯誤型別、錯誤碼、AppError（見 T6）
│   │   │   └── error-handler.ts # Fastify setErrorHandler + setNotFoundHandler
│   │   ├── db/
│   │   │   └── prisma.ts  # PrismaClient 單例
│   │   └── logger.ts      # pino 設定（redact 敏感欄位）
│   └── test/              # Vitest 後端測試（unit + integration）
└── .github/
    └── workflows/
        └── ci.yml
```

- **共用設定位置**：`tsconfig.base.json`、`biome.json`、`.env.example`、根 `package.json` scripts 皆置於 repo 根，供兩個 package 共用/聚合。
- `frontend/` 與 `backend/` 各有獨立 `package.json` 與 `Dockerfile`，滿足 AC-03 獨立建置。
- 後端 `platform/` 模組對應 ARCHITECTURE 第 3 節 `platform` 模組責任（健康檢查、結構化錯誤、env 載入、DB 連線）。

---

## 4. 各 Task 詳細規格（T1~T6）

各 Task 一律 TDD：**先寫會失敗的測試，再實作**；不得刪除、弱化或 skip 測試換綠燈（CLAUDE.md）。每個 Task 一個 atomic commit。

### T1 — 專案結構 + lint/format + TypeScript 設定

**目標**：建立 monorepo 骨架與程式碼品質工具鏈，讓 `pnpm install`、lint、format、typecheck 可在根與各 package 執行。

**Lint/format 工具定案：Biome**
- 定案採用 **Biome**（單一工具同時做 lint + format），取代 ESLint + Prettier 組合。
- 理由：Biome 為單一二進位、零外掛設定、速度快、內建 TS/React 規則、格式化與 lint 一致無衝突（省去 ESLint/Prettier 整合摩擦），MIT 授權、免費、成熟度足以支撐本專案規模。減少 devDependency 數量與設定檔，利於 CI 速度。
- 設定檔 `biome.json` 置於根，前後端共用；啟用 recommended 規則 + TypeScript + React（前端）規則集。
- 若後續遇到 Biome 未涵蓋之特定 React/a11y 規則需求，屬可追加之內部決策；本 Phase 以 Biome 為定案。

**產出物**：
- 根 `package.json`（scripts：`lint`、`format`、`typecheck`、`test`、`build`，以 `pnpm -r` 或 `--filter` 聚合）、`pnpm-workspace.yaml`、`.nvmrc`、`.npmrc`、`tsconfig.base.json`（`strict: true`、`noUncheckedIndexedAccess`、`esModuleInterop` 等）、`biome.json`、`.gitignore`、`.dockerignore`。
- `frontend/` 與 `backend/` 的 `package.json` 與 `tsconfig.json`（extends base）骨架（此時可為最小可編譯狀態）。

**測試要求（TDD）**：
- 本 Task 以「工具鏈可執行且對違規失敗」為驗證，非傳統單元測試：
  1. 先建立一個**故意違反 lint 規則**的暫存樣本（或以測試 fixture），確認 `pnpm lint` 對它回非 0（失敗態存在）→ 修正後 `pnpm lint` 綠。
  2. 先建立一個**型別錯誤**樣本，確認 `pnpm typecheck` 回非 0 → 修正後綠。
- **Done When**：`pnpm install` 成功；`pnpm lint`、`pnpm format --check`（或等效）、`pnpm typecheck` 在乾淨狀態全綠；上述「違規即失敗」已被人工/腳本驗證過一次。

### T2 — 後端最小 Fastify + `/health` + Prisma + env 驗證

**目標**：可啟動的 Fastify 後端，含 DB 連線檢查的 `/health`、Prisma 初始化與 migration 機制、env 載入與驗證。

**主要 dependency 定案（含理由）**：
- `fastify`（v5）：技術棧指定後端框架。
- `@prisma/client` + `prisma`（CLI）：技術棧指定 ORM。
- `zod`：env schema 驗證。理由：型別安全、可產生清楚的缺項/型別錯誤訊息以滿足 AC-09，MIT、輕量、成熟；亦可供後續 Phase 的請求驗證沿用。
- `pino`（Fastify 內建 logger）：結構化日誌，支援 `redact` 遮蔽敏感欄位（滿足 AC-12），效能佳、MIT。
- `dotenv`（僅本機/測試載入 `.env`；容器內以真實 env 提供，不依賴 dotenv）。

**env 驗證設計（`config/env.ts`）**：
- 以 zod schema 定義所有後端 env（見第 6 節清單），在 `index.ts` 進入點於 `buildServer` 前先 `parse`。
- 驗證失敗時：收集**所有**缺少/不合法項目，印出變數名稱與原因（不印值），以退出碼 1 結束（AC-09）。
- 通過後回傳 typed config 物件供全後端使用；業務程式不得直接讀 `process.env`（集中於此）。

**`/health` 設計（`platform/health.ts`）**：
- 執行輕量 DB 探測（例 `SELECT 1` 經 Prisma `$queryRaw`），成功 → `db: "up"`、HTTP 200、`status: "ok"`；失敗（捕捉例外）→ `db: "down"`、HTTP 503、`status: "error"`。
- 不得將 DB 例外原文、連線字串、主機資訊放入 response（僅 `db: "down"`）；細節寫入日誌（不含 `DATABASE_URL` 值）。
- 形狀見第 5 節。

**Prisma 與 migration 機制（`prisma/schema.prisma`）**：
- `datasource db`：`provider = "postgresql"`、`url = env("DATABASE_URL")`。
- `generator client`。
- 建立**一個最小 model** 作為 migration 機制可用性驗證，例：
  ```prisma
  model HealthProbe {
    id        Int      @id @default(autoincrement())
    checkedAt DateTime @default(now())
  }
  ```
  用途：僅驗證「migration 可建表、可寫入、可查詢」，非業務資料表。此為 PRD 允許之「health 所需最小結構」。
- 產生初始 migration（`prisma migrate dev --name init`），migration 檔納入版本控管。
- 提供 script：`prisma migrate deploy`（部署/容器啟動用）、`prisma generate`（build 前）。

**產出物**：`backend/src/{index.ts,server.ts,config/env.ts,platform/health.ts,db/prisma.ts,logger.ts}`、`backend/prisma/{schema.prisma,migrations/**}`、`backend/package.json` scripts（`dev`、`build`、`start`、`migrate:deploy`、`prisma:generate`、`test`）。

**測試要求（TDD，Vitest）**：
1. **env 驗證（unit）**：先寫測試 — 給缺 `DATABASE_URL` 的 env 物件，`parseEnv()` 應丟出含缺項名稱的錯誤；給完整 env 應回 typed config。先失敗（函式不存在）→ 實作 → 綠。
2. **`/health` 正常（integration）**：以測試 Postgres（見第 9 節）+ 已跑 migration，`inject` `GET /health` 應回 200 且 `checks.db === "up"`。
3. **`/health` 異常（integration/unit）**：模擬 DB 探測拋錯（stub `prisma.$queryRaw` 或指向不可用連線），`GET /health` 應回 503、`checks.db === "down"`、body 不含連線字串。
4. **migration 機制可用（integration）**：對測試 DB 執行 `migrate deploy` 後，可對 `HealthProbe` 寫入一列並查回（驗證 AC-04 / migration 可用）。
- **Done When**：上述測試皆綠；本機以真實 `.env` `pnpm --filter backend dev` 可啟動、`curl /health` 回 200；缺 env 啟動回非 0 並列缺項。

### T3 — 前端最小 React + Vite + 呼叫 `/api/health` + dev proxy

**目標**：最小 React SPA，載入時呼叫 `/api/health`，顯示後端與 DB 狀態；dev server 以 proxy 轉發 `/api` 至後端。

**主要 dependency 定案**：`react`、`react-dom`（v18）、`vite`（v5）、`@vitejs/plugin-react`、`vitest` + `@testing-library/react` + `jsdom`（前端測試）。皆技術棧指定或其標準測試搭配，MIT、免費。

**dev proxy 設計（`vite.config.ts`）**：
- `server.proxy['/api'] = { target: 後端 URL（由 env，例 VITE_API_PROXY_TARGET，預設 http://localhost:3000）, changeOrigin: true }`。
- 前端一律以相對路徑 `/api/health` 呼叫（同源），開發用 proxy、正式用 nginx 反向代理，程式碼一致（符合 ADR-0001 同源）。

**UI 行為**：
- App 載入時 `GET /api/health`：
  - 成功且 `status==="ok"` → 顯示「後端：正常、資料庫：連線正常」。
  - `status==="error"`（HTTP 503）→ 顯示「後端：正常、資料庫：無法連線」。
  - fetch 失敗（後端不可達）→ 顯示「無法連線至後端」。
- 僅為狀態顯示，無業務 UI。

**產出物**：`frontend/src/{main.tsx,App.tsx,api/health.ts}`、`frontend/index.html`、`frontend/vite.config.ts`、`frontend/package.json` scripts（`dev`、`build`、`preview`、`test`）。

**測試要求（TDD，Vitest + Testing Library）**：
1. 先寫測試：mock `fetch` 回 `{status:"ok",checks:{db:"up"}}` → 畫面出現「資料庫：連線正常」文案。先失敗（元件未實作）→ 實作 → 綠。
2. mock `fetch` 回 503 `{status:"error",checks:{db:"down"}}` → 出現「資料庫：無法連線」。
3. mock `fetch` reject → 出現「無法連線至後端」。
- **Done When**：測試綠；`pnpm --filter frontend build` 成功；本機 `dev` 起後（搭配後端）瀏覽器顯示正確狀態。

### T4 — Dockerfile ×2 + docker-compose + .env.example

**目標**：三容器可由 `docker compose up` 一次啟動並串接，滿足 AC-01~06。

**`frontend/Dockerfile`（多階段）**：
- Stage 1（builder，`node:20`）：pnpm install（僅 frontend + 必要根設定）→ `vite build` 產出 `dist/`。
- Stage 2（`nginx` stable）：複製 `dist/` 至 nginx html 目錄；複製 `nginx.conf`。
- `nginx.conf`：
  - SPA fallback：`try_files $uri /index.html`。
  - `location /api/ { proxy_pass http://backend:3000/; ... }` 反向代理至後端 service（compose 內部 DNS `backend`），維持同源（ADR-0001）。後端 port 由約定固定（見第 6 節 `PORT` 預設 3000；compose 內以固定值或 env 傳入）。

**`backend/Dockerfile`（多階段）**：
- Stage 1（builder，`node:20`）：pnpm install → `prisma generate` → `tsc` build → （可 prune dev deps）。
- Stage 2（runtime，`node:20-slim`）：複製 build 產物、`node_modules`（prod）、`prisma/`；容器啟動指令：先 `prisma migrate deploy` 再啟動 server（或以 entrypoint 腳本串接，migrate 失敗則不啟動）。
- 非 root 使用者執行（安全預設）。

**`docker-compose.yml`（三 service）**：
- `db`：`postgres:16`，env（`POSTGRES_USER/PASSWORD/DB` 由 `.env`），具名 volume `pgdata:/var/lib/postgresql/data`，`healthcheck`（`pg_isready`）。
- `backend`：build `./backend`，`depends_on: db`（`condition: service_healthy`），env（`DATABASE_URL`、`PORT`、`NODE_ENV`、`STORAGE_PATH` 等），`healthcheck`（打 `/health`），掛載預留 `storage` volume 至 `STORAGE_PATH`（本 Phase 僅掛載點，不使用）。
- `frontend`：build `./frontend`，`depends_on: backend`（`service_healthy`），對外 port（例 `8080:80`）。
- 頂層 `volumes: pgdata, storage`。
- 啟動順序：db（healthy）→ backend（healthy）→ frontend。

**`.env.example`**：列出所有必要/選用變數（見第 6 節），值為佔位/非敏感範例，**不得含真實 secrets**；`.env` 加入 `.gitignore`。

**產出物**：`frontend/Dockerfile`、`frontend/nginx.conf`、`backend/Dockerfile`、`backend/docker-entrypoint.sh`（如採 entrypoint）、`docker-compose.yml`、`.env.example`、`.dockerignore`。

**測試要求（TDD/驗收導向）**：
- 容器編排以**整合驗收腳本**驗證（非單元測試）：
  1. `docker compose build`（三 image 建置成功）→ 對應 AC-14 docker build。
  2. `docker compose up -d` → 等 backend healthy → `curl http://localhost:8080/api/health` 回 200 且 `db: up`（AC-06）。
  3. 停 db → `curl /api/health` 回 503（AC-08 端到端）。
  4. `docker compose up -d --force-recreate frontend backend`（不動 db）→ 先前寫入 `HealthProbe` 的列仍在（AC-04）。
  5. grep repo 確認無寫死 secrets（AC-05）。
- **Done When**：上述腳本步驟全數通過；`.env.example` 齊備；CI 的 docker build job 綠（見 T5）。

### T5 — CI（GitHub Actions）

**目標**：`.github/workflows/ci.yml`，在 push/PR 至 `phase-001`（及 `main`）時執行完整品質關卡。

**Job 設計**（可單 job 串接或多 job，以 pnpm 快取）：
- setup：checkout、`pnpm/action-setup`、`actions/setup-node@v4`（node 20，快取 pnpm）、`pnpm install --frozen-lockfile`。
- `lint`：`pnpm lint`（Biome）。
- `typecheck`：`pnpm typecheck`。
- `unit test`：`pnpm test`（Vitest，前後端）。**後端 integration 測試需 Postgres**：使用 GitHub Actions `services: postgres:16`（見第 9 節），CI 設 `DATABASE_URL` 指向 service，測試前跑 `prisma migrate deploy`。
- `frontend build`：`pnpm --filter frontend build`。
- `backend build`：`pnpm --filter backend build`（含 `prisma generate`）。
- `docker build`：`docker compose build`（或分別 build 兩 image），驗證 Dockerfile 可建置。
- 全部成功才綠。

**測試要求**：
- CI 本身以「在分支上實際跑出綠燈」驗證。可先以一個必然失敗的 lint/test 確認關卡確實會擋（紅），修正後轉綠，確保 gate 有效（呼應 TDD「先紅後綠」精神）。
- **Done When**：workflow 在 `phase-001` 分支跑出全綠；每個關卡（lint/typecheck/test/frontend build/backend build/docker build）皆存在且可獨立判讀。

### T6 — 結構化錯誤協定 + Fastify error handler + 404/500

**目標**：定案全案沿用的統一錯誤回應協定，並在 Fastify 落地 error handler、404、500 處理。

**錯誤協定定案（見第 5 節 JSON 形狀為權威）**：
- 所有錯誤回應統一為：
  ```json
  { "error": { "code": "...", "message": "...", "requestId": "...", "fields": [ { "field": "...", "reason": "..." } ] } }
  ```
  - `code`：機器可辨識錯誤碼（大寫 SNAKE_CASE，見錯誤碼慣例）。
  - `message`：人類可讀、面向使用者、**不含**堆疊/DB/內部細節。
  - `requestId`：追查識別（同時寫入日誌），供 AC-12。
  - `fields`：**僅欄位驗證錯誤（VALIDATION_ERROR）時**出現；每項 `{ field, reason }`，供前端定位（AC-10）。
- **錯誤碼慣例（本 Phase 定案的基礎集，後續 Phase 沿用擴充）**：
  - `VALIDATION_ERROR`（400，欄位驗證失敗，帶 `fields`）
  - `NOT_FOUND`（404）
  - `INTERNAL_ERROR`（500，通用；不外洩細節）
  - `SERVICE_UNAVAILABLE`（503，健康檢查/依賴不可用）
  - 後續 Phase 依需要新增（例 `UNAUTHORIZED`/`FORBIDDEN`/`CONFLICT`）— 慣例：HTTP 語意 + SNAKE_CASE 業務碼；本 Phase 不預先定義業務碼。
- HTTP status 與 `code` 對應明確；`code` 是穩定契約（前端據此判斷），`message` 可調整文案。

**Fastify 落地（`platform/errors.ts` + `platform/error-handler.ts`）**：
- `AppError` 類別：`{ code, httpStatus, message, fields? }`，供業務層丟出已知錯誤。
- `setErrorHandler`：
  - `AppError` → 依其 `httpStatus`/`code` 輸出統一格式。
  - Fastify 內建 validation 錯誤（schema validation）→ 轉為 `VALIDATION_ERROR` + `fields`。
  - 其他未捕捉例外 → `INTERNAL_ERROR`（500），**不回傳原始訊息/堆疊**；原始錯誤與 `requestId` 寫入日誌（`logger.error`，經 pino redact）。
- `setNotFoundHandler`：回 `NOT_FOUND`（404）統一格式。
- `requestId`：以 Fastify `genReqId` 或 `request.id` 產生並帶入回應與日誌。
- pino `redact`：遮蔽 `authorization`、`cookie`、`set-cookie`、`password`、`DATABASE_URL` 等敏感鍵，落地 AC-12。

**測試端點（本 Phase 專用，供協定驗證）**：
- 提供一個受測試用途的驗證端點（例 `POST /__echo` 或於測試中註冊臨時 route），帶 Fastify schema，用來驗證 `VALIDATION_ERROR` + `fields` 形狀。**此端點僅測試/開發用途，不對外提供業務語意**；若不願暴露，可只在測試中以 `inject` 掛載臨時 route 驗證 error handler（優先此法，避免正式路由表出現非業務端點）。

**產出物**：`backend/src/platform/{errors.ts,error-handler.ts}`、於 `server.ts` 註冊 `setErrorHandler`/`setNotFoundHandler`、logger redact 設定。

**測試要求（TDD，Vitest integration via `inject`）**：
1. 先寫測試：呼叫不存在路由 → 404 且 body 符合統一格式、`code==="NOT_FOUND"`（AC-13）。
2. 觸發丟出 `AppError(VALIDATION_ERROR, fields=[...])` 的臨時 route → 400、`fields` 正確、前端可辨識（AC-10）。
3. 觸發丟出未知例外的臨時 route → 500、`code==="INTERNAL_ERROR"`、body **不含**堆疊/內部訊息、含 `requestId`（AC-11）。
4. 斷言：日誌對 500 有記錄 `requestId`，且（以 redact 設定測試）敏感鍵被遮蔽（AC-12）。
- **Done When**：上述測試皆綠；協定形狀與第 5 節一致；error handler / 404 / 500 已於 `server.ts` 註冊。

---

## 5. API Contract（本 Phase）

本 Phase 僅 `/health` 與錯誤協定格式。以下 JSON 形狀為權威定案。

### 5.1 `GET /health`

正常（HTTP 200）：
```json
{
  "status": "ok",
  "checks": { "db": "up" },
  "uptimeSeconds": 123,
  "timestamp": "2026-08-01T00:00:00.000Z"
}
```

異常（DB 不通，HTTP 503）：
```json
{
  "status": "error",
  "checks": { "db": "down" },
  "uptimeSeconds": 123,
  "timestamp": "2026-08-01T00:00:00.000Z"
}
```

- `status`：`"ok"` | `"error"`。
- `checks.db`：`"up"` | `"down"`。
- 不含 DB 連線字串、主機、driver 例外原文（安全）。
- `uptimeSeconds`、`timestamp` 為輔助欄位（可選實作，但形狀固定；若不實作 `uptimeSeconds` 可省略該鍵）。

> 註：nginx 反向代理下，瀏覽器/前端呼叫路徑為 `/api/health`；後端實際 route 為 `/health`（nginx `location /api/` `proxy_pass http://backend:3000/` 去除 `/api` 前綴）。此代理對應規則於 `nginx.conf` 與 `docker-compose` 定案，容器內後端不掛 `/api` 前綴。

### 5.2 統一錯誤回應（所有錯誤共用）

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "輸入資料有誤，請檢查標示欄位。",
    "requestId": "req-abc123",
    "fields": [
      { "field": "email", "reason": "格式不正確" }
    ]
  }
}
```

- `error.code`：穩定機器碼（前端據此判斷）。基礎集：`VALIDATION_ERROR`(400)、`NOT_FOUND`(404)、`INTERNAL_ERROR`(500)、`SERVICE_UNAVAILABLE`(503)。
- `error.message`：面向使用者、不外洩內部細節。
- `error.requestId`：追查用，與日誌對應。
- `error.fields`：僅 `VALIDATION_ERROR` 出現；其他錯誤省略此鍵。
- 500 回應 `message` 一律通用（例「系統發生錯誤，請稍後再試」），不含堆疊/DB 結構。

---

## 6. 環境變數清單定案

`.env.example` 依此列出（值為佔位，非真實 secrets）。後端一律經 `config/env.ts`（zod）讀取與驗證。

| 變數 | 使用者 | 必要性 | 預設值 | 說明 |
|---|---|---|---|---|
| `NODE_ENV` | backend | 選用 | `development` | `development` / `production` / `test`。 |
| `PORT` | backend | 選用 | `3000` | 後端監聽 port（compose/nginx 以此為代理目標）。 |
| `DATABASE_URL` | backend | **必要** | 無（缺則啟動失敗） | Postgres 連線字串（`postgresql://user:pass@host:5432/db`）。 |
| `STORAGE_PATH` | backend | 選用 | `/data/storage` | 附件/PDF 持久化路徑（本 Phase 僅**預留**、掛載 volume，不使用）。 |
| `LOG_LEVEL` | backend | 選用 | `info` | pino 日誌級別。 |
| `VITE_API_PROXY_TARGET` | frontend(dev) | 選用 | `http://localhost:3000` | 前端 dev server proxy `/api` 目標（僅開發，正式走 nginx）。 |
| `POSTGRES_USER` | db(compose) | 必要（compose） | 範例值 | Postgres 容器初始化用；`.env` 提供。 |
| `POSTGRES_PASSWORD` | db(compose) | 必要（compose） | 範例值（非真實） | 同上；`.env.example` 為佔位，`.env` 不進版控。 |
| `POSTGRES_DB` | db(compose) | 必要（compose） | 範例值 | 同上。 |

- **必要 env 缺失** → 後端啟動失敗並列缺項（AC-09）。`DATABASE_URL` 為後端唯一硬性必要項。
- `POSTGRES_*` 供 compose 啟動 db 與組出 `DATABASE_URL`；正式（Zeabur）由平台 env 提供，compose 三者僅本機開發用。
- 所有變數在 `.env.example` 有佔位；`.env` 於 `.gitignore`；repo 內無真實 secrets（AC-05）。

---

## 7. 資料模型與 Migration

- 本 Phase **僅建立 migration 機制**，不建業務資料表。
- `schema.prisma` 含 `datasource`（postgresql / `env("DATABASE_URL")`）+ `generator client` + 一個最小驗證 model `HealthProbe`（見 T2），僅用於證明 migration 可建表/寫入/查詢與 AC-04 資料持久化驗證。
- 初始 migration 由 `prisma migrate dev --name init` 產生並納入版控；容器/CI 以 `prisma migrate deploy` 套用。
- 後續 Phase（PHASE-002 起）新增業務資料表時沿用此 migration 機制。
- 若人類/大總管認為連 `HealthProbe` 這類最小 model 都不宜出現，替代方案為以「空 migration + 對系統 catalog 探測」驗證機制可用；本 Spec 以 `HealthProbe` 為定案（最直接、可驗證持久化），列為可回退選項於第 12 節。

---

## 8. 非功能需求對應

- **NFR-US-15 健康檢查**：`/health` 正常/異常（AC-07、AC-08）即其骨架；PHASE-011 硬化。
- **NFR-US-16 結構化錯誤處理**：第 5.2 節錯誤協定 + T6 error handler（AC-10~13）即其骨架，全案各 Phase 遵循此協定，不得自訂裸格式。
- **NFR-US-05 env / 無寫死 secrets**：第 6 節 + AC-05、AC-09。
- **NFR-US-01~04, 06 Docker/分離/持久化**：T4 + AC-01~06。
- 效能（NFR-US-14）非本 Phase 目標（PHASE-011）。

---

## 9. 測試策略

### 9.1 單元/整合界線
- **單元測試（unit）**：純函式與不需 DB 的邏輯（env schema 驗證、錯誤格式組裝、前端元件以 mock fetch）。
- **整合測試（integration）**：需要真實 Postgres 的行為（`/health` 的 DB 探測 up/down、migration 可用性、`HealthProbe` 寫入查回）。以 Fastify `inject`（不實際開 port）+ 測試 DB。

### 9.2 測試工具設定
- **Vitest** 為前後端統一測試 runner（技術棧指定）。
  - 後端：node 環境；integration 測試連測試 Postgres。
  - 前端：`jsdom` 環境 + `@testing-library/react`；`fetch` 以 mock。
- 每個 package 各自 `vitest.config.ts`；根 `pnpm test` 聚合。
- E2E（Playwright）不在本 Phase（技術棧列於未來 Phase）。

### 9.3 CI 上如何跑（含 Postgres service container）
- **需要 Postgres service container**：後端 integration 測試需真實 DB。CI 以 GitHub Actions `services.postgres`（`postgres:16`，含 `health-cmd pg_isready`）提供；job 設 `DATABASE_URL` 指向該 service（如 `postgresql://postgres:postgres@localhost:5432/app_test`，CI 專用合成憑證，非真實 secret），測試前 `prisma migrate deploy`。
- 前端測試無需 DB，可與後端測試分 job 或同 job 分步。
- docker build job 驗證兩 image 可建置（AC-14）。

### 9.4 TDD 紀律
- 每個 Task 先寫會失敗的測試再實作；不得為換綠燈刪除/skip/弱化測試（CLAUDE.md）。
- 不得聲稱未實際執行的測試已通過（CLAUDE.md）。

---

## 10. Rollback

- 本 Phase **純新增檔案**，無業務資料、無不可逆操作。
- 回滾方式：捨棄/還原 `phase-001` 分支至 base commit `f59649f` 即可；無 migration 資料遷移風險（`HealthProbe` 僅開發/測試合成資料，dev DB 可整庫重建）。
- 無需 down migration 於正式（尚無正式資料）。

---

## 11. 關鍵技術定案清單（供大總管快速核對）

| 項目 | 定案 | 類別 | 理由摘要 |
|---|---|---|---|
| Workspace 工具 | pnpm workspace | 11.2 內部 | 依賴隔離嚴謹、`--filter` 利於 Docker 多階段與 CI |
| Node 版本 | 20 LTS（`.nvmrc`、`engines`） | 11.2 內部 | LTS、與 Fastify5/Prisma/Vite5 相容 |
| Lint/Format | Biome | 11.2 內部 | 單一工具、快、少設定、MIT |
| env 驗證 | zod | 11.2 內部 | 型別安全、缺項訊息清楚、可沿用 |
| 日誌 | pino（Fastify 內建）+ redact | 11.2 內部 | 結構化、遮蔽敏感欄位 |
| 後端框架/ORM | Fastify 5 / Prisma | 技術棧指定 | 人類已確認 |
| 前端 | React 18 / Vite 5 | 技術棧指定 | 人類已確認 |
| 測試 | Vitest（+ Testing Library/jsdom） | 技術棧指定 | 人類已確認 |
| 錯誤協定 | `{ error: { code, message, requestId, fields? } }` | 11.2 內部（全案契約） | 統一、可辨識、不外洩 |
| 同源代理 | nginx `/api` → backend（去前綴） | ADR-0001 遵循 | 維持同源、無 CORS |
| migration 驗證 model | `HealthProbe`（最小） | 內部 | 驗證 migration 機制與持久化 |

所有新增 dependency 皆免費、開源（MIT 或等效）、成熟、無授權疑慮，無付費/架構性/授權不明依賴（符合技術定案原則）。

---

## 12. 已知限制與開放事項（留給後續 Phase / 交回大總管）

### 12.1 已知限制（本 Phase 刻意不做，非缺陷）
- Cookie/Session、HTTPS、Secure 屬性一律不做（PHASE-002 Session、PHASE-011 HTTPS）。
- storage 抽象層僅預留 `STORAGE_PATH` 與 volume 掛載點，不實作（PHASE-003）。
- 無 CORS 設定（同源策略，ADR-0001；本 Phase 不需要）。
- 無 rate limit、無安全標頭硬化（PHASE-002/011）。
- `/health` 僅檢查 DB；未檢查 storage/外部依賴（PHASE-011 完善）。
- E2E（Playwright）與效能量測不在本 Phase。

### 12.2 開放事項（需大總管/人類確認或後續 Phase 定案；本 Phase 已給預設但標示可調整）
1. **測試 model `HealthProbe`**：若人類不希望出現任何非業務 model，改採「空 migration + 系統 catalog 探測」驗證機制（第 7 節）。預設採 `HealthProbe`。
2. **npm workspaces vs pnpm**：本 Spec 定案 pnpm；若團隊環境偏好 npm workspaces（少一工具），可替換且不影響 AC。屬可替換內部決策，如需切換請大總管裁示。
3. **Biome vs ESLint+Prettier**：本 Spec 定案 Biome；若後續需 ESLint 特定外掛（如 a11y 深度規則），再評估追加。
4. **T6 測試端點暴露方式**：預設以測試 `inject` 掛臨時 route 驗證 error handler，避免正式路由表出現非業務端點；若需常駐 `/__echo` 供整合測試，需大總管同意（非業務端點）。
5. **container 內 migrate 時機**：預設 entrypoint 於啟動時 `migrate deploy`。正式（Zeabur）多副本情境下的 migration 併發策略屬 PHASE-011 議題，本 Phase 單副本開發不涉及。
6. **後端 port 固定值**：`PORT` 預設 3000，nginx `proxy_pass` 與 compose 需一致；若 Zeabur 指定其他 port 規則，於 PHASE-011 對齊。

以上開放事項均**不阻擋** T1~T6 依本 Spec 預設值實作；第 12.2 各項預設已足以達成 Done When。

---

## 附錄 A — Task 依賴與建議實作順序

```
T1（結構+lint+TS）
 ├─▶ T2（後端 Fastify/health/prisma/env） ─▶ T6（錯誤協定/handler，依 T2 之 server）
 └─▶ T3（前端 React/Vite/proxy）
        │
        ▼
      T4（Dockerfile×2 + compose + .env.example，依 T2、T3）
        │
        ▼
      T5（CI，依 T1..T4）
```

建議順序：T1 → T2 → T6 → T3 → T4 → T5（T6 緊接 T2 以便早日固化錯誤協定供後續 route 遵循；T3 可與 T2/T6 並行）。
