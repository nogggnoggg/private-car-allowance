# WALKTHROUGH — Zeabur 首次部署走查腳本

- 產出：DEPLOY-ZB-T1R（implementer，2026-08-12/13），Goal B 交付物；沿 `WALKTHROUGH-PHASE-011-INTEGRATION.md` 之步驟／預期／判定／失敗處置格式與**產品判斷型／純技術驗證型**標注。
- 狀態：**待執行**（部署當天使用；本文所有「結果」欄為空白，由執行當天填入）。
- 前提：DEPLOY-ZB-T1R 已將 nginx upstream 參數化落地（`frontend/nginx.conf.template` ＋ `frontend/Dockerfile` ＋ `docker-compose.yml`），本機 `docker compose build frontend` → `up` → `/api/health` 全鏈已於同批驗證通過（見同批 Task Handoff）；**尚未 commit／尚未合併**，Zeabur 部署前須先完成本 Task 之合入。
- 區域：Korea（人類已裁定）。方案：付費（volume 可用）。網域：待部署當天現場決定（Zeabur 提供之 `*.zeabur.app` 子網域，或自有網域）。
- 步驟分類標注（沿 PHASE-011 整合 Gate 先例）：**產品判斷型**＝需裁定人親自在 Zeabur 後台操作或目視判斷；**純技術驗證型**＝可由大總管代跑並展示輸出（本文中僅 §3 之 env 清單比對、§5 之 `/api/health` curl 屬此類，其餘 Zeabur 後台操作依其性質全屬產品判斷型——Zeabur 後台今日無可供本專案腳本化操作之 API 整合）。
- 預估時間：40~60 分鐘（含等待 Zeabur build／DNS/憑證生效時間，實際視 Zeabur 平台當下速度而定，非本文可控）。

---

## §0 前提與紅線（**產品判斷型**——執行前請先確認）

1. **機密全程由使用者在 Zeabur 後台填、不經對話**：`DATABASE_URL`（或其組成的帳密）、`SEED_ADMIN_PASSWORD`、任何正式憑證，一律由裁定人直接在 Zeabur 後台的環境變數欄位輸入，不貼進與大總管或任何 AI 的對話、不寫入本機檔案。
2. **正式密碼現場新產**：`SEED_ADMIN_PASSWORD`（首次管理員密碼）與 `POSTGRES_PASSWORD`（若 Zeabur PostgreSQL 服務要求自訂）**不得沿用開發／測試環境之合成值**——現場產生一組新密碼，且需符合 `validateNewPassword`（`backend/src/auth/password-rules.ts`）之規則。
3. **區域固定 Korea**（人類已裁定，非本文可調整項）。
4. 本文的 §1~§4 是**建立階段**（一次性，之後只在改設定時重跑對應段落）；§5 是**每次部署後皆應執行**的驗收；§6 是**部署當天需一併決定並設定**的排程；§7 是失敗時的回退指引。

- 結果：

---

## §1 GitHub 授權＋建立 Zeabur 專案（**產品判斷型**）

1. 登入 Zeabur 後台，授權存取 GitHub（若尚未授權）。
2. 新建專案，選擇本倉庫（`nogggnoggg/private-car-allowance`）。
3. 專案區域選擇 **Korea**。

- 判定準則：專案建立完成，可見專案 Dashboard；區域顯示 Korea。
- 失敗處置：GitHub 授權失敗多半是組織層權限限制，需在 GitHub 之 Organization Settings → Installed GitHub Apps 確認 Zeabur 有權存取本倉庫。
- 結果：

---

## §2 PostgreSQL 服務（**產品判斷型**）

1. 在專案內新增服務 → 選擇 Zeabur 內建的 **PostgreSQL**（prebuilt）。
2. 待服務啟動後，取得其連線資訊（host／port／user／password／database，或 Zeabur 提供的連線字串變數引用語法，例如 `${POSTGRES_CONNECTION_STRING}` 之類——**以 Zeabur 後台當時實際顯示的變數名為準**，本文不臆測其確切名稱）。

- 判定準則：PostgreSQL 服務狀態為 running／healthy。
- 檢核點：**不要**把連線字串明文貼到 backend 服務的 `DATABASE_URL` 欄位——優先使用 Zeabur 服務間變數引用語法（若支援），避免密碼以明文重複出現在多個服務設定裡。
- 結果：

---

## §3 backend 服務（**產品判斷型**建立 ＋ **純技術驗證型**環境變數清單核對）

### 3-1 建立服務

1. 新增服務 → 從 GitHub 倉庫建置 → **build context 選 monorepo 根目錄**、**Dockerfile 路徑選 `backend/Dockerfile`**（`backend/Dockerfile` 之 `COPY` 指令假設 build context 為倉庫根，與 `docker-compose.yml` 現行 `context: .` 一致，勿改成 `backend/` 子目錄，否則 `COPY package.json package-lock.json ./` 等步驟會找不到檔案）。
2. 掛載一個 volume 到容器內路徑（建議 `/data/storage`，與本機 compose 之 `STORAGE_PATH` 預設值一致，非強制但可減少認知負擔）。

### 3-2 環境變數清單（逐項對照 `backend/src/config/env.ts` 之 `envSchema`，2026-08-13 實查）

`docker-entrypoint.sh` 啟動時自動執行 `prisma migrate deploy`；後端零改動，`index.ts` 監聽 `cfg.PORT`／`0.0.0.0`（DEPLOY-ZB-T1R 背景實查，未變更）。

**production 下缺一即拒絕啟動的三鍵**（`PRODUCTION_REQUIRED_ENV_KEYS`，`env.ts` :109-113）：

| 變數 | 說明 | 建議值 |
|---|---|---|
| `DATABASE_URL` | zod schema 必填；連線字串 | 引用 §2 之 Zeabur PostgreSQL 連線資訊組成（scheme／帳號／密碼／host／port／DB 名依序組合；不在本文重複易誤判為真實憑證之完整格式範例，實際值以 Zeabur 後台當時顯示者為準） |
| `ATTACHMENT_STORAGE_ROOT` | 附件 storage 根；`NODE_ENV=production` 下未設即拒絕啟動（`server.ts` 判斷分支，非 schema 層） | `/data/storage/attachments`（§3-1 volume 之子路徑） |
| `REPORT_STORAGE_ROOT` | 報表 PDF storage 根；邏輯與上一列鏡像 | `/data/storage/pdf`（同一 volume 之另一子路徑，D6 前綴隔離） |

**其餘 14 個 schema 鍵**（有預設值，可不設；下表為 `.env.example` 現行預設，正式環境是否覆寫由裁定人決定）：

| 變數 | 預設值 | 備註 |
|---|---|---|
| `NODE_ENV` | `development` | **Zeabur 必須明確設為 `production`**——Cookie 之 `Secure` 屬性由此值決定（D7=(a)），未設會沿用開發模式行為 |
| `PORT` | `3000` | 與 §4 之 `BACKEND_UPSTREAM` 埠號需一致 |
| `LOG_LEVEL` | `info` | |
| `STORAGE_PATH` | `/data/storage` | 保留鍵，後端邏輯不直接讀取（`.env.example` :20 逐字），僅供 volume 掛載路徑之慣例對齊 |
| `SESSION_ABSOLUTE_TTL_HOURS` | `8` | |
| `SESSION_COOKIE_NAME` | `sid` | 不含 `__Host-`/`__Secure-` 前綴（D7=(a) 裁定範圍外的實作選擇，見 `.env.example` :29-31）；不建議在此處自行改為前綴形式 |
| `LOGIN_MAX_FAILURES` | `5` | |
| `LOGIN_LOCK_MINUTES` | `15` | |
| `ATTACHMENT_MAX_BYTES` | `10485760`（10 MiB） | |
| `ATTACHMENT_TEMP_TTL_HOURS` | `24` | |
| `ATTACHMENT_THUMBNAIL_MAX_PX` | `512` | |
| `ATTACHMENT_CLEANUP_BATCH_LIMIT` | `500` | 只被一次性 CLI `attachment/cleanup-cli.ts` 讀取，見 §6 |
| `REPORT_PDF_TIMEOUT_MS` | `30000` | RUNBOOK (c)：Playwright PDF 逾時硬約束 ≤ 60 秒，本值遠低於上限 |
| `REPORT_IMAGE_MAX_PX` | `1600` | |

**首次啟動自舉用（不在 `envSchema` 內，`seed-admin.ts` 直讀 `process.env`）**：

| 變數 | 說明 |
|---|---|
| `SEED_ADMIN_LOGIN` | 首任管理員登入帳號；`runSeedAdmin` 必要輸入 |
| `SEED_ADMIN_PASSWORD` | 首任管理員初始密碼；須通過 `validateNewPassword`；**現場新產，不沿用開發合成值**（見 §0-2） |

⚠ **`SEED_ADMIN_LOGIN`／`SEED_ADMIN_PASSWORD` 不是自動執行的**——`docker-entrypoint.sh`（DEPLOY-ZB-T1R 實查）只自動跑 `prisma migrate deploy` 與啟動伺服器，**不會**自動呼叫 `seed-admin.ts`。設了這兩個變數本身不會建立管理員；需另外手動執行 `node dist/seed/seed-admin.js`（`package.json` 之 `seed:admin` script）。**Zeabur 之服務終端機／一次性指令執行功能今日是否可用、如何觸發，本 Task 未實查**——部署當天先在 Zeabur 後台確認該服務是否提供 exec／終端機介面，若無，退而求其次的辦法是本機以相同 `DATABASE_URL`（指向 Zeabur 之 PostgreSQL，需其允許外部連線或用 SSH 隧道）執行同一支腳本，兩者皆須事先驗證可行性。

- 判定準則（純技術驗證型，可代跑）：上述三張表之鍵集合＝`env.ts` 匯出之 `ENV_SCHEMA_KEYS`（17 鍵）＋`PRODUCTION_REQUIRED_ENV_KEYS`（3 鍵，含於前者）＋`SEED_ADMIN_LOGIN`／`SEED_ADMIN_PASSWORD`（2 鍵，schema 外），逐項核對零遺漏零多餘。
- 結果：

---

## §4 frontend 服務（**產品判斷型**）

1. 新增服務 → 從同一 GitHub 倉庫建置 → build context 選 monorepo 根目錄、Dockerfile 路徑選 `frontend/Dockerfile`。
2. 設定環境變數：

   ```
   BACKEND_UPSTREAM=<backend 服務名>.zeabur.internal:3000
   ```

   **`<backend 服務名>` 以 Zeabur 後台 §3 建立時實際顯示的服務名為準**——Zeabur 私網主機名格式固定為 `<服務名>.zeabur.internal`（DEPLOY-ZB-T1 背景研究引官方 docs deploy/private-networking，本 Task 未重新查證原文，僅轉引；部署當天若行為與此不符，以 Zeabur 當下實際文件為準並回報）。官方警語重點：**改服務名不改主機名**——即服務改名後，主機名會跟著變（因為主機名本來就是由服務名當下的值組成），若之前已把舊主機名寫死在別處會失效；**不是**「主機名一旦產生就固定不再隨服務改名而變」。
   
   埠號 `3000` 需與 §3-2 之 backend `PORT`（預設 3000，未覆寫）一致。
3. 綁定公開網域：Zeabur 提供的 `*.zeabur.app` 子網域，或使用者自有網域（現場決定，見 §0）。

- 判定準則：frontend 服務建置成功且啟動；容器內 `/etc/nginx/conf.d/default.conf` 之 `proxy_pass` 應解析為 `http://<backend 服務名>.zeabur.internal:3000/`（Zeabur 若提供服務終端機，可比照 DEPLOY-ZB-T1R 本機驗證手法 `cat /etc/nginx/conf.d/default.conf` 核對；若無終端機介面，以 §5 之 `/api/health` 全鏈是否連通作為間接證明）。
- 失敗處置：若 `/api/health` 打不通，先確認 `BACKEND_UPSTREAM` 是否為當下的真實服務名（Zeabur 後台服務清單逐字核對，勿憑記憶輸入）；其次確認 backend 服務本身是否已 healthy。
- 結果：

---

## §5 部署後驗收（**產品判斷型**為主，`/api/health` 一項**純技術驗證型**可代跑）

1. **`/api/health` 全鏈**（純技術驗證型）：

   ```bash
   curl -i https://<公開網域>/api/health
   ```

   預期：`200` ＋ `{"status":"ok","checks":{"db":"up"}}`。

2. **TLS 目視**（產品判斷型）：瀏覽器開啟 `https://<公開網域>`，確認位址列鎖頭圖示、無憑證警告（PHASE-011 整合 Gate §4 之留待項，於此核銷）。

3. **Cookie 面板目視**（產品判斷型，PHASE-011 整合 Gate §4 同項）：DevTools → Application → Cookies → session cookie，確認四欄：`Secure`／`HttpOnly`／`SameSite=Lax`／`Path=/`。

4. **登入改密**（產品判斷型）：以 §3-2 之 `SEED_ADMIN_LOGIN`／`SEED_ADMIN_PASSWORD` 登入，系統應強制要求改密（`mustChangePassword=true`），改密後可正常使用。

5. **上傳附件一輪**（產品判斷型）：任一差旅／保養申請上傳一個合成附件，確認可預覽／下載。

6. **產 PDF 一輪**（產品判斷型）：任一已完成申請產生正式 PDF，確認可下載且內容正確（版面 A4、內容無亂碼）。

- 結果：

---

## §6 備份排程設定（**產品判斷型**——依 `docs/RUNBOOK.md` §(b)「每日備份」節，非 §(e)，見下方勘誤）

> **勘誤（據實記載）**：DEPLOY-ZB-T1 Task Packet 原文引「RUNBOOK §(e)」——實查 `docs/RUNBOOK.md` 之 §(e) 為「500 兜底之診斷取捨」，與備份排程無關；備份排程之權威段落實際是 **§(b) 備份與還原驗證 → 每日備份 → 「排程設定」**（`docs/RUNBOOK.md` :86）。本節內容以 §(b) 原文為準。

`docs/RUNBOOK.md` :86 原文：「**排程設定**：本系統不內建排程器（與 (g) 清理排程同一裁定精神：不可逆／敏感操作不常駐於服務行程）。由部署人員在平台的排程 Job（Zeabur 之一次性 Job）或主機 `cron` 設定每日執行一次 `scripts/backup.sh`；排程本身屬部署時人工設定，PRD 明示如此。」

- ⚠ **不確定項，據實標注，勿臆測**：「Zeabur 之一次性 Job」是否確實提供**可對已部署服務容器執行 `docker exec` 等效操作**（即在容器內跑 `scripts/backup.sh` 並讀取其環境變數與掛載的 volume）之排程功能，**本 Task 未實查 Zeabur 產品文件證實**——RUNBOOK 原文本身也只是泛稱「平台的排程 Job」，未逐字保證 Zeabur 這項具體能力存在或其確切操作方式。**列為部署當天驗證項**：
  1. 確認 Zeabur 是否提供排程 Job／Cron 功能，及其能否存取 backend 服務同一顆 volume。
  2. 若可行：設定每日一次執行 `scripts/backup.sh`，環境變數依 RUNBOOK §(b) 表格（`BACKUP_DEST_ROOT`／`ATTACHMENT_STORAGE_ROOT`／`REPORT_STORAGE_ROOT`／`DATABASE_URL`／`BACKUP_RETENTION_DAYS` 等）設定，`BACKUP_DEST_ROOT` 不得落在正式 storage 路徑樹內（機械守門 AC-21）。
  3. 若不可行：退而求其次，於**外部主機**（非 Zeabur 內）以 `cron` 定期連線 Zeabur 之 PostgreSQL（需其允許外部連線）與 volume（若 Zeabur volume 不可由外部主機掛載，此路徑可能整個不可行，需另評估）執行備份——此為 RUNBOOK 原文列出的另一選項，但其可行性同樣**未經本 Task 驗證**。
  4. **異地保存**（RUNBOOK :88）：`BACKUP_DEST_ROOT` 之機械守門只保證不落在正式資料路徑樹內，不保證異地——需另外安排（`rclone`／`rsync`／平台 volume 快照功能），今日**未實作、未驗證**。

- 判定準則：本節之「結果」欄不判定通過／失敗，而是記錄部署當天實際查得的 Zeabur 排程能力與最終採用的方案。
- 結果：

---

## §7 失敗回退（**產品判斷型**）

1. **Zeabur 服務刪除即回退**：任一服務（backend／frontend／PostgreSQL）建置或啟動失敗，可直接在 Zeabur 後台刪除該服務重建，不影響其餘服務。
2. **DB 未有真實資料前可整專案重來**：若尚未有任何真實使用者資料寫入正式 PostgreSQL，可整個刪除 Zeabur 專案，從 §1 重新開始——此時沒有資料遺失風險（一切為初次部署）。
3. 一旦有真實資料寫入，回退需改走 §6 之備份／還原機制（`scripts/backup.sh`／`scripts/verify-restore.sh`），不得再用「整專案刪除重來」處置。

- 結果：

---

## 本走查腳本核銷的是什麼

- ✅ 通過＝「Zeabur 三服務（PostgreSQL／backend／frontend）皆可正確建置、啟動、彼此連通，`/api/health` 全鏈 200，TLS／Cookie 屬性目視正確，登入／附件／PDF 三個關鍵操作皆可用」。
- ❌ 本文不核銷：備份排程之實際可行性（§6 已標注為部署當天現查現定）、異地備份保存方案、正式營運後的效能表現（PHASE-011 整合 Gate 之效能量測基準線僅適用本機 compose 環境，Zeabur 平台之實際效能未經量測）。

## 本文與 Task Packet 之差異記錄（誠實揭露，供大總管核對）

- Task Packet 原文引「RUNBOOK §(e)」處理備份排程，實查應為 §(b)（見 §6 開頭勘誤）——已據實更正並記錄差異，非自行改變 Spec 產品含義。
- Zeabur 私網主機名格式（`<服務名>.zeabur.internal`）與其排程 Job 能力，本文引用 Task Packet 之背景研究轉述，**本 Task 未直接查證 Zeabur 官方文件原文**——凡標「未實查」「不確定」之處，皆為誠實揭露射程限制，非驗證完畢。
