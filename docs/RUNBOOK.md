# RUNBOOK — 私車差旅補助管理系統部署與維運手冊

- 狀態：ACTIVE（新建，`PHASE-011-T14`）
- 對象：**未參與本專案開發的維運人員**——本文盡量避免內部代號與只有開發者才懂的縮寫；每個指令都附「預期看到什麼」。
- 對應 Spec：`docs/specs/PHASE-011.md` **AC-25**（八項必載小節）；機械守門：`backend/test/unit/runbook-sections.test.ts`（缺一必紅）。
- 上游事實來源：`docs/KNOWN_ISSUES.md`（運維約束 O-1／O-2／O-3、已知限制）、`PROJECT_STATE.md`（歷次環境事故與其處置）、各 Phase Spec §16/§17。本文只彙整可執行的操作步驟，**不重新定義**任何行為或約束——若本文與上述來源有出入，以來源為準並回報。
- 適用範圍：本機 Docker Compose 與 Zeabur 部署皆適用；環境差異一律以環境變數表達，不在腳本內寫死平台判斷。

---

## (a) 部署硬化

### production 必要環境變數

以下三鍵在 `NODE_ENV=production` 時**缺一即拒絕啟動**（`PRODUCTION_REQUIRED_ENV_KEYS`，`backend/src/config/env.ts`）：

| 變數 | 拒絕發生的位置 |
|---|---|
| `DATABASE_URL` | zod schema 層（啟動最早期，`parseEnv` 直接拋出） |
| `ATTACHMENT_STORAGE_ROOT` | `server.ts` 判斷 `NODE_ENV === "production"` 之分支（schema 層本身是選用，測試與開發環境允許不設） |
| `REPORT_STORAGE_ROOT` | 同上，與 `ATTACHMENT_STORAGE_ROOT` 邏輯完全鏡像 |

未設定其中任一個 STORAGE_ROOT 時，後端行程在啟動階段就會拋出錯誤並結束（不會帶著錯誤設定跑起來）；訊息只說明「哪個變數未設定」，不含任何路徑或連線資訊。這是刻意設計（`KNOWN_ISSUES.md` O-3）：Zeabur／compose 部署必須提供持久化 volume 路徑，否則寧可不啟動。

**完整 env 鍵清單**（含選用鍵與其預設值）以 `.env.example` 為權威來源，並受機械守門（`backend/test/unit/env-example-sync.test.ts`）保證其 ⊇ `config/env.ts` schema 全鍵。新增一個 env 鍵時，以下四處**同批更新**，缺一即有機械斷言必紅：
① `backend/src/config/env.ts` 之 schema ＋ `getEnvOrTestDefaults` 回退值　② `.env.example`　③ `docker-compose.yml` backend 之 `environment:`（僅必要鍵為硬性要求）　④ `backend/test/unit/env.test.ts` 之 `ENV_SCHEMA_KEYS` 封閉集合。

**`docker-compose.yml` 只轉發 `environment:` 區塊中明確列出的鍵**：即使你在 `.env` 檔裡設定了某個變數，只要它沒有出現在 `docker-compose.yml` 的 `backend.environment:` 清單裡，容器內的行程**永遠看不到它**——沒有 `env_file`、Dockerfile 沒有 `ENV`、entrypoint 不 source `.env`，設了等於沒設，且**不會有任何錯誤訊息**（2026-08 曾發生：四個 session／登入鎖定相關的鍵漏轉發，調整 `.env` 完全無效果，直到比對 compose 檔才發現）。修改 `.env` 中某個鍵之前，**先確認該鍵確實出現於 `docker-compose.yml` 的 `backend.environment:` 區塊**，否則你的調整不會生效。

### Cookie 安全屬性（D7=(a) 裁定）

production 下 Cookie 屬性集為固定值：`HttpOnly` ∧ `SameSite=Lax` ∧ `Path=/` ∧ `Secure`，已由測試以 `toEqual` 封閉比對釘死（多一個屬性、少一個屬性都會使測試翻紅）。這不是本文可調整的設定項——若要變更這個屬性集，需先修改 Spec 並經人類裁定，不是改個 env 值就能調整。

### 反向代理與 HTTPS（D8=(a) 裁定）

後端**不信任**任何 `X-Forwarded-*` 標頭（`trustProxy` 未啟用），Cookie 的 `Secure` 屬性單純由 `NODE_ENV=production` 決定，不依賴反向代理告知的協定。

**這是一個假設，不是驗證**：HTTPS 之保證完全來自部署平台（Zeabur、或自架的 nginx／負載平衡器）——**應用層完全不驗證，也不會察覺**（`docs/specs/PHASE-011.md` §17.1 #2）。若部署平台沒有強制 HTTPS，Cookie 依然會被標記 `Secure`，但實際連線可能仍是明文 HTTP 而系統不會有任何警示。**部署時務必在平台層自行確認 HTTPS 已強制啟用**（Zeabur 預設提供憑證與強制導向；自架 nginx／負載平衡器需自行設定 HTTP→HTTPS 導向與憑證）。

真實 TLS 的目視驗證（瀏覽器網址列鎖頭圖示、開發者工具 Cookie 面板之 `Secure` 旗標是否確實生效）**屬整合 Gate 的人工檢查項**，不在本系統的自動化測試範圍內——測試只能證明「Cookie 物件在 production 分支帶 `Secure` 屬性」，不能證明「這條連線真的是 HTTPS」。

### 健康檢查端點

`GET /health`：

- 正常：`200` ＋ `{"status":"ok","checks":{"db":"up"}}`
- DB 不可達：`503` ＋ `{"status":"error","checks":{"db":"down"}}`；回應內容不含連線字串、主機名、堆疊資訊。
- DB 探針有 2 秒逾時上限，遠短於 `docker-compose.yml` 之健康檢查間隔（10 秒），避免一個卡住的探針讓平台誤判為「還在檢查中」。

**健康檢查不涵蓋 storage**（`docs/specs/PHASE-011.md` §17.1 #12，D9=(a) 刻意設計）：附件／報表存放的 volume 不可寫時，`/health` 仍然回 `200`——因為重啟這個行為對 volume 故障沒有任何幫助。儲存故障的偵測方式見下方 **(h) 故障處置**，不要以為 `/health` 綠燈就代表儲存正常。

`docker-compose.yml` 對 `db`／`backend` 兩服務皆定義了 `healthcheck`（`db` 用 `pg_isready`，`backend` 用容器內對自己 `/health` 的請求）；**`frontend` 未定義 `healthcheck`**，它的可用性以人工執行 `curl -i http://localhost:8080/api/health` 應回 `200` 來判斷，不宣稱 compose 對 frontend 有機械化的健康狀態。

### 測試環境隔離（`TEST_DB_ISOLATION`）之維運禁令

`TEST_DB_ISOLATION=off` 是後端測試基礎設施（INFRA-001）提供的**單鍵回退模式**，會跳過預設的 per-worker schema 隔離。**禁止在共用或持久化的開發資料庫上以此模式執行整套後端測試**——以下兩個測試檔皆對全表 `status=TEMP` 的附件執行**真實刪除**（不只 dry-run）：

- `backend/test/integration/phase11-attachment-cleanup.test.ts`
- `backend/test/integration/phase11-user-delete-after-cleanup.test.ts`

在正常隔離模式下，兩檔各自負責的是自己該次執行所播種、限定在單一 worker schema 內的資料；但在 `TEST_DB_ISOLATION=off` 回退模式下，這兩檔的刪除範圍會擴大到**整個共用資料庫中同型的資料**，不限於本檔自播的種子。兩檔各自有同型的 fail-closed 閘門（`beforeAll` 斷言起跑時 `Attachment` 表為空）會在真刪之前先行中止，但這只是意外情況下的最後防線，**不是設計上鼓勵依賴的安全機制**——正常情況下不應該在任何共用或持久化的資料庫上以 `TEST_DB_ISOLATION=off` 執行測試套件。

### 部署平台

Zeabur 為優先部署目標，本機／CI 使用 Docker Compose；環境差異一律以環境變數表達（見上），不在程式或腳本中寫死判斷特定平台的邏輯。

---

## (b) 備份與還原驗證

### 每日備份

執行方式：`scripts/backup.sh`。所有設定經環境變數提供（**零命令列憑證字面**——連線資訊只解析 host／port／user／database，密碼段永不取用、永不輸出）：

| 變數 | 必要性 | 說明 |
|---|---|---|
| `BACKUP_DEST_ROOT` | 必要 | 備份目的地根目錄；機械守門確保它不落在正式資料的路徑樹內 |
| `ATTACHMENT_STORAGE_ROOT` | 必要 | 附件 storage 根（受保護根 ＋ 備份來源） |
| `REPORT_STORAGE_ROOT` | 必要 | 報表 storage 根（受保護根 ＋ 備份來源） |
| `DATABASE_URL`（或 `BACKUP_DATABASE_URL` 覆寫） | 必要 | 備份目標 |
| `BACKUP_RETENTION_DAYS` | 選用，預設 14 | **小於 14 時腳本拒絕啟動**；恰好 N 天保留，逾期即刪 |
| `BACKUP_PGDATA_PATH` | 選用 | PG data 目錄之主機路徑，設了才納入路徑守門比對 |
| `BACKUP_PG_CONTAINER` | 選用，特定情境下必要（見下） | 指定 DB 容器名 |
| `BACKUP_ALLOW_EMPTY` | 選用，只接受字面 `1` | 見下方「涵蓋自檢與空庫初始備份」 |

**排程設定**：本系統不內建排程器（與 (g) 清理排程同一裁定精神：不可逆／敏感操作不常駐於服務行程）。由部署人員在平台的排程 Job（Zeabur 之一次性 Job）或主機 `cron` 設定每日執行一次 `scripts/backup.sh`；排程本身屬部署時人工設定，PRD 明示如此。

**目的地與異地保存**：`BACKUP_DEST_ROOT` 之機械守門**只保證**「備份不落在正式資料的路徑樹內」（`AC-21(a)`）——**不保證不同主機、不同磁碟**。真正的異地保存（另一台主機、雲端物件儲存）是部署時的人工職責：建議另外排程把 `BACKUP_DEST_ROOT` 之內容同步到異地（例如 `rclone`／`rsync`，或平台自帶的 volume 快照／匯出功能），本系統不提供此同步機制，也不會自動驗證異地副本是否存在。

**權限＝唯一保護層**：備份**不加密**（人類裁定 D11-2=(a)）。`db.dump` 內含全庫個資（`User` 表含 `passwordHash`）與附件、稽核內容。目的地目錄的**檔案系統權限是唯一保護層**——務必限制唯管理／備援帳號可讀，絕不放在任何形式的公開可讀路徑。

**涵蓋自檢與空庫初始備份**：每次備份都會核對「DB 中的四類 storage 鍵（附件正本、縮圖、報表、作廢版報表）是否全部進了本次的 tar 檔」。若四來源鍵集合為空（例如全新環境的第一次備份），自檢預設**拒絕執行**（避免「沒東西可驗」被誤讀為「驗過都在」）。確認這真的是空庫初始備份時，才手動加上 `BACKUP_ALLOW_EMPTY=1` 明示放行。**不得把這個變數常設在排程的環境變數中**——常設等於永久放棄涵蓋自檢，往後任何真正的遺漏都不會被抓到。`manifest.json` 的 `coverage.allowEmpty` 欄會記錄該次是否放行過，供事後辨識。

**named volume 形態之替代手法**：若 storage 只掛載在容器可見的 named volume（主機無法直接存取路徑），可先用一次性容器把內容搬到主機可讀的暫存目錄，再指向該暫存目錄跑 `backup.sh`，例如：

```
docker run --rm --volumes-from <承載 storage 的容器名> \
  -v <主機暫存目錄>:/backup-staging \
  alpine sh -c "cp -r /<容器內掛載路徑>/. /backup-staging/"
```

取得主機端可讀副本後，把 `ATTACHMENT_STORAGE_ROOT`／`REPORT_STORAGE_ROOT` 指向該暫存目錄再執行 `backup.sh`。**此步驟未經本 Phase 機械驗證**，正式採用前建議先在測試環境跑一次確認路徑對應正確。

**受管 DB（無法 `docker exec`）之替代指令**：`backup.sh` 依賴 `docker exec` 呼叫**容器內**的 `pg_dump`（用戶端與伺服器同容器版本必然相容之設計）。雲端代管的 PostgreSQL（無容器可 exec）不適用此路徑。替代做法：在一台裝有相容版本 `pg_dump` 的機器上，改用環境變數（如 `PGPASSWORD`，或 `.pgpass` 檔）提供憑證、**不經命令列**，對外部連線直接執行：

```
pg_dump <目標資料庫連線資訊，依 psql 慣例以 host/port/user/dbname 分別指定或用環境變數提供> -Fc -f db.dump
```

（本文刻意不示範完整連線字串字面，理由與腳本本身的紀律相同：連線字串屬敏感資訊，一律經環境變數而非文件字面傳遞。）此路徑**不會**自動得到 `backup.sh` 的涵蓋自檢、保留期清理與 manifest 產生——附件與報表的打包、涵蓋自檢與 manifest 需比照 `backup.sh` 的邏輯手動執行或另行撰寫腳本；這是已知缺口，非本 Phase 機械驗證範圍。

**`BACKUP_PG_CONTAINER` 何時必須顯式設定**：腳本預設以「哪個容器發布了這個 DB 的 port」自動探測，要求剛好探測到一個。**本機若同時跑多個專案且共用同一個預設 PostgreSQL port**，探測會得到零個或多個結果而拒絕執行；此時必須顯式設定 `BACKUP_PG_CONTAINER` 指向正確的容器名。`DATABASE_URL` 的主機名不是 `localhost`／`127.0.0.1`／`::1`／`host.docker.internal` 時同樣必須顯式設定。

**排障方式**：腳本已把 `pg_dump`／`psql`／`tar` 的錯誤輸出全部關閉（避免絕對路徑外洩），失敗時只回報「哪個步驟失敗」，看不到外部工具的原始錯誤訊息。要看到原始診斷，**用完全相同的環境變數手動執行同一支外部工具一次**（不要重導向 stderr），例如直接對容器內的資料庫跑 `pg_dump`，即可看到工具自己的錯誤輸出。

**`manifest.json` 之 `tools.script` 版本可信度**：此欄記錄產生該份備份的腳本版本（`PHASE-011-T12/2` 為涵蓋自檢改為 fail-closed 之後的版本）。**早於此版本的備份，其「涵蓋完整」沒有機械背書**——還原驗證時這類備份會被標記 `coverage-unverified`（見下）。

### 每月還原驗證

執行方式：`scripts/verify-restore.sh`。四個必要環境變數：

| 變數 | 說明 |
|---|---|
| `BACKUP_DEST_ROOT` | 同備份腳本；取最近一份備份 |
| `DATABASE_URL` | **正式**（來源）連線字串；全程唯讀 |
| `RESTORE_TARGET_DATABASE_URL` | 隔離還原目標；**不得**等於正式來源，其資料庫名須尚未存在（腳本自建、用畢自刪） |
| `RESTORE_VERIFY_LOG` | 驗證紀錄檔路徑（追加寫入） |

**`RESTORE_VERIFY_LOG` 的目錄須事先存在且可寫**：腳本只會把紀錄追加到這個檔案，**不會**建立它的父目錄。若父目錄不存在或不可寫，本次演練會跑完但**零紀錄留存**——稽核時會誤以為那個月沒跑過。第一次設定時務必先手動建立該目錄並確認可寫入權限。

**步驟**：前置守門（目標主機／庫／schema 不得與正式相同；目標庫不得已存在；三個識別字形狀檢查）→ 取最近一份備份 → 還原至隔離目標 → **①** DB 可開啟且 migration 尾筆與正式現況相符 → **②** 附件抽樣至少 3 筆（含縮圖、含修正版複製之副本）且各部件雜湊與 manifest 全等 → **③** 關聯完整性（動態列舉全部外鍵 ＋ 七項固定清單，含 `Attachment` 弱引用之容器存在性檢查）→ 全通過寫成功紀錄；任一步失敗寫失敗紀錄，隔離目標一律刪除（不留在實例上）。

**失敗紀錄六欄**：`timestamp`／`backupId`／`stage`（`guard`／`a`／`b`／`c`／`none`）／`summary`（見下表）／`exitCode`／`evidence`（降級標記，無則為 `full`）。

**摘要碼判讀（23 個封閉碼；三個最需要人工反應的碼）**：

| 摘要碼 | 代表意義 | 該做什麼 |
|---|---|---|
| `migration-tail-differs-from-source` | 這份備份還原回來的 schema 版本已對不上今天程式的 migrations | **改用較新的備份重跑**；不是這次驗證本身的缺陷 |
| `attachment-object-missing` | 抽樣到的 storage 鍵，還原後在附件包裡找不到 | **查這份備份的 `manifest.coverage.missing`**——備份當下的涵蓋自檢是否本來就有缺漏 |
| `relation-orphans-found` | 動態外鍵掃描抓到真實的孤兒列 | **人工判讀**，非機械可自動修復；需查是哪張表、哪個外鍵 |

其餘摘要碼多為前置守門或工具執行失敗類（如 `backup-not-found`、`create-database-failed`、`pg-restore-failed`、`archive-extract-failed` 等），依字面即可定位是哪個步驟出了問題；完整 23 碼列表見 `backend/src/platform/restore-check.ts` 之 `SUMMARY_CODES`。

**`evidence` 欄之判讀（兩種降級標記，方向相反）**：

- 不含任何標記（值為 `full`）：三項確認皆完整跑過，且所驗的備份本身涵蓋自檢也有機械背書。
- **`coverage-unverified`**：**三項驗證都真的跑完了**，但所驗的那份備份本身的涵蓋自檢沒有機械背書（`manifest.coverage.allowEmpty=true`，或該備份由早於 `PHASE-011-T12/2` 的腳本版本產生）。此時「備份裡的東西還原得回來」被證實了，但「該備的都備到了」沒有被證實。
- **`sample-incomplete`**：附件抽樣那一項（②）**根本沒有真的執行完整**（湊不出 ≥3 筆且含縮圖含修正版複製），是在 `RESTORE_ALLOW_INCOMPLETE_SAMPLE=1` 明示放行下才繼續的降級演練。

兩者判讀方向不同：`coverage-unverified` 是「都跑了、但驗證對象本身有缺口」；`sample-incomplete` 是「有一項根本沒跑」。

**`RESTORE_ALLOW_INCOMPLETE_SAMPLE` 不得常設在排程環境變數中**：與 `BACKUP_ALLOW_EMPTY` 同一紀律——常設等於每個月都自動放行抽樣不足，稽核時分不出這個月是樣本真的充足還是被放行跳過。

**同實例磁碟風險**：`RESTORE_TARGET_DATABASE_URL` 若指向與正式來源**相同**的 PostgreSQL 實例，演練期間會在該實例上瞬間多出一份全庫副本，佔用等量磁碟直到自動 `DROP`；正式 volume 若已接近水位，一次演練就可能把正式服務的磁碟寫爆。**演練前應先確認可用磁碟空間**（至少大於目前資料庫大小），並**建議以 `RESTORE_PG_CONTAINER` 指向一個獨立的 PostgreSQL 實例**（或至少獨立磁碟）作為還原目標，降低對正式服務的資源競爭風險。

**結束碼判讀**：`0`＝三項全過（含降級證據仍算過，但 `summary` 會標明是哪種）；`1`＝任一階段失敗（已寫入失敗紀錄）；`2`＝必要環境變數缺漏或所需工具（`docker`／`tar`／`node`）不存在等前置條件不足——**此時腳本尚未進入任何驗證階段，不會寫入任何紀錄**，不算通過也不算失敗，只代表這次執行的環境設定有問題，排除後應重新執行。

### 持久化驗證（容器重建操作前後之目視工具）

執行方式：`scripts/verify-persistence.sh`，四種模式：

| 模式 | 動作 | 期望結果 |
|---|---|---|
| `preserve` | `docker compose down`（不加 `-v`）→ `up` | 三指紋（DB／附件位元組／PDF 位元組）逐一全等 |
| `destroy` | `docker compose down -v`（**刪除 volume**）→ `up` | **期望驗證失敗**——反向對照，證明本驗證程序不是恆真 |
| `rebuild-backend` | 只重建後端 | `db`／`frontend` 容器 id 與映像 id 不變、資料不變 |
| `rebuild-frontend` | 只重建前端 | `db`／`backend` 容器 id 與映像 id 不變、資料不變 |

**`destroy` 模式僅限 dev／staging 環境，永不對正式環境執行**——它會真的刪除 volume 且無法復原。腳本已內建守門：非 `localhost`／`127.0.0.1` 目標一律拒絕執行（結束碼 2），需明示 `--yes-write-to-remote` 才放行；`destroy` 模式另需明示 `--yes-destroy-data`。

**結束碼 1（`destroy` 模式下）是預期結果**，代表反向對照成立（刪除 volume 後驗證確實失敗，證明這道驗證有鑑別力）。判讀時務必同時看到腳本印出「✅ 反向對照成立：刪 volume 後驗證確實失敗（本程序具鑑別力）」這行；若沒看到這行卻仍是結束碼 1，代表失敗原因可能與預期不同，需追查完整輸出內容。

**結束碼 2（非 `destroy` 模式下）**代表前置條件不足：目標非本機、必要工具缺漏，或**前側三指紋未能全數取得**（腳本會印出「前側三指紋未能全數取得：本次比對無鑑別力」）。**這種情況不算通過也不算失敗**——代表播種後連第一次都沒取到三指紋（例如附件授權端點回 403、報表端點回 404），此時任何「前後全等」的結論都無意義，須先排除該端點問題再重跑。

**`--yes-write-to-remote` 之使用時機**：僅當**確實**要對非 `localhost`／`127.0.0.1` 目標執行本程序時才加此旗標（例如對一個遠端 staging 環境）。它不是用來繞過本機守門，而是明示承認「這會建立業務資料、消耗一個正式報表編號（不可回收）」的動作。一般本機操作不需要此旗標。

---

## (c) REPORT_PDF_TIMEOUT_MS ≤ 60 秒硬約束

`REPORT_PDF_TIMEOUT_MS`（預設 30000 ms／30 秒）之設定值**須顯著小於 60 秒**。

`application-void.ts` 之 `VOID_TX_TIMEOUT_MS = 60_000`／`VOID_TX_MAX_WAIT_MS = 10_000` 為**硬編常數**，刻意不由 `REPORT_PDF_TIMEOUT_MS` 推導（該檔對報表產生邏輯維持零依賴）。若前者被調高至接近或超過 60 秒，作廢交易會在渲染仍進行中被 Prisma 交易逾時（`P2028`）搶先中止，使一筆「其實只是慢」的正常作廢動作變成 500（整筆回滾、零殘留仍成立，可重試，但體驗上是一次失敗）。

**變更該 env 時須同批檢視 `VOID_TX_TIMEOUT_MS`／`VOID_TX_MAX_WAIT_MS` 二常數**（`docs/KNOWN_ISSUES.md` O-1）：如果確實需要調高 `REPORT_PDF_TIMEOUT_MS`（例如渲染大量圖片的報表），必須同時評估這兩個硬編常數是否也要調整，這是一個需要改動程式碼並重新測試的決定，不是純環境變數調整。

---

## (d) dev 環境 Storage Root 常設化

開發環境**必須**設定 `ATTACHMENT_STORAGE_ROOT` 與 `REPORT_STORAGE_ROOT`。未設定時的 dev fallback 路徑為 `%TEMP%/{att,rpt}-storage-dev-<pid>`——**每次重啟後端就換一個空目錄**，先前寫入的位元組會滯留在舊 PID 的目錄裡。症狀：縮圖破圖、修正版附件複製失敗（此為防護正常運作而整筆回滾 500，**不是**程式缺陷）。

本機已知的穩定根路徑（2026-08-08 環境事件之處置）：`%TEMP%/oilexpense-dev-storage/{att,rpt}`。本機未追蹤版控的 `.env` 已補上這兩個 ROOT。**後續 session 重建 dev 環境必沿 `.env` 既有 ROOT**，不要讓它退回動態暫存路徑——若手動刪除或忽略 `.env` 中這兩行，下次啟動就會退回每次換目錄的行為。

整合 Gate 的容器拓撲以 named volume 掛載，不受此限；本節僅適用「本機直接跑 backend（非容器）」的開發情境。

---

## (e) 500 兜底之診斷取捨

自 PHASE-010-T9 起，後端的 500 兜底路徑改記固定分類標籤（`UNEXPECTED_EXCEPTION` ＋ `error.name`），**不再記錄例外原文**（「500 兜底不再記錄例外原文」）。

線上排障之正解為**各服務層具名日誌**：各 `catch` 區塊自行記錄如 `{ stage, id }` 一類零內容標籤（不含使用者輸入、不含例外原文），並以 `requestId` 做關聯，串起同一次請求跨層的日誌紀錄。

**不得**以「排障不便」為由回退成記錄 `error.message`——該回退會使既有的反向探針與白名單掃描守門（`docs/specs/PHASE-010.md` AC-21 之兩層站點掃描器；與本文件所屬 PHASE-011 之 AC-21 是不同 Spec 的編號，勿混淆）同時失效，且會撞回已經修復過的洩漏面。

實務排障步驟：拿到 500 回應後，取得回應中的 `requestId` → 於伺服器日誌中搜尋含該 `requestId` 的所有紀錄 → 依各服務層留下的 `{ stage, id }` 標籤定位是哪一段邏輯失敗 → 若仍不足以判斷根因，於 dev／staging 環境以相同輸入重放並在該 `catch` 區塊本地除錯（不改動 production 的日誌紀律）。

---

## (f) Phase 邊界維運

每個 Phase 邊界（合併主線分支後）執行一次的 dev DB 重置程序：

1. **先停 dev backend**（例如 `docker compose stop backend`，或停掉本機 preview 行程）。**不得在後端仍運行、仍持有連線時直接對其資料庫做 `DROP SCHEMA`**——曾發生邊界重置時後端仍在運行，導致附件相關的 E2E 出現懷疑為連線暫態問題的間歇失敗（suspected flaky），此後固化為「重置前先停 dev server」的常設規則。
2. `DROP SCHEMA public CASCADE`（清空全部物件）。
3. `prisma migrate deploy` 重放全部 migrations。
4. 重啟 backend。
5. `seed:admin` 重建 e2e 管理員帳號（`mustChangePassword` 旗標）。
6. `POST /me/password` 強制改密至 E2E 慣例密碼，並驗證登入回 `200`。
7. 跑一次**全套 E2E 自舉驗證**——這是重置程序是否成功的最終判準。若出現非預期紅燈，先排除「重置時 server 是否仍在運行」這個已知肇因，再往下查其他原因。

### Windows 開發環境注意事項

以下三項是本機（Windows）維運時反覆踩過的坑，記錄下來避免重演：

- **容器建置一律經 PowerShell 執行**：本倉庫實際路徑含中文，Docker BuildKit 對含非 ASCII 字元的 build context 會失敗（且失敗方式並不總是明顯——曾發生建置因中文路徑觸發 BuildKit 內部錯誤，但 `docker compose up` 仍靜默沿用了兩天前的舊映像，外觀正常但容器內程式碼是舊的）。改用 PowerShell 執行建置可避開此問題，且**建置完成後務必核對映像時戳**（`docker images` 之 `CREATED` 欄應為當日），確認真的重建成功而非沿用舊映像。
- **`C:\oilexp-build` 是一個指向本倉庫的 junction（非複製品）**：若本機需要一個零中文路徑的建置別名，junction 是本專案採用的解法，例如 `powershell -Command "cd C:\oilexp-build; docker compose build"`。**因為它與倉庫是同一份檔案系統物件，絕不可對它執行 `robocopy /MIR` 之類的鏡像／同步工具**——那等於對倉庫自己鏡像自己，即使因 source 與 destination 相同而僥倖沒有造成資料損毀，這仍是應該避免的操作。
- **Git Bash 對含非 ASCII 字元（例如中文）的內容之管線傳遞不可靠**：曾發生以 Git Bash 的 `curl` 送出含中文的 JSON body 時位元組被污染，導致伺服器回應驗證錯誤。**對 API 播種或送出含中文內容的請求時，一律改用 Python（`urllib`）或 PowerShell，不要用 Git Bash 的 `curl` 帶非 ASCII 內容。**

---

## (g) 清理排程之啟用前置

附件清理由一次性 CLI 承擔（`npm run cleanup:attachments`）：刻意**不**常駐於服務行程、**不**暴露 HTTP 端點，只由部署平台之排程或主機 `cron` 呼叫。本系統**不內建**排程開關——沒有類似「清理是否啟用」的旗標，因為根本沒有內建排程器可以開關。

**啟用前必須先以 `--dry-run` 驗證引用保護**（PRD 逐字硬性前置要求）：

```
npm run cleanup:attachments -- --dry-run
```

`--dry-run` 唯讀列出候選清單，執行前後 DB 全表逐欄快照與 storage 鍵集合全等（結構性保證零刪除發生）。**確認候選清單合理**（沒有任何看起來還在使用中的附件被誤列為候選）之後，才把排程接上**不帶 `--dry-run`** 的呼叫。

**停用方式（回滾路徑）**：因為排程本身不在系統內（是平台的 Job 或主機 `cron`），停用清理＝**移除或暫停該排程 Job**，程式面完全不需要改動，不需要 `git revert`。

**相關環境變數**：`ATTACHMENT_TEMP_TTL_HOURS`（TEMP 狀態附件多久算逾期，預設 24 小時）、`ATTACHMENT_CLEANUP_BATCH_LIMIT`（單次批次上限，預設 500；超量候選留待下次執行）。

**env 不合 schema 時之症狀對照與定位手法**：

- **症狀**：CLI 以非零結束碼退出，標準輸出印出一行 `config-error` 階段紀錄；**零候選被列出、零刪除發生**。若失敗的是 `ATTACHMENT_TEMP_TTL_HOURS` 或 `ATTACHMENT_CLEANUP_BATCH_LIMIT` 本身不合法（非整數／小於等於零／空字串），該行會**具名**點出是哪一個鍵；若是其他任何 env 鍵不合 schema（例如 `PORT` 被設成非數字），該行印出通用標籤 `ENV_VALIDATION_FAILED`（不含哪個鍵、不含值——CLI 受掃描器約束不得記錄例外原文）。
- **定位手法**：先看紀錄是否具名——是的話直接修該鍵；若是通用的 `ENV_VALIDATION_FAILED`，比對目前生效的環境變數（`.env` 或部署平台的環境變數面板）與 `backend/src/config/env.ts` 之 schema，逐鍵核對型別（多半是某個數值型的鍵被設成空字串或非數字）。
- **期待值**：修正後重跑 `--dry-run`，應以結束碼 `0` 印出候選清單摘要（含候選筆數等欄位），且仍是零刪除。

**批次饑餓監測**：若某次執行的摘要顯示 `hasMore=true` 但候選筆數為 `0`，代表候選集合的頭部持續卡在無法刪除的項目上，需要**人工介入**查看，不要自動當作「還有更多待清理」的正常狀態。

**已知限制**：storage 刪除失敗不會回滾對應的 DB 刪除（計入失敗計數），可能穩定產生「DB 已無此列但 storage 仍有檔案」的孤兒物件。

**孤兒盤點（PHASE-011-T6，已落地；D5=(c) 只盤點、不刪除）**：判定模組 `backend/src/attachment/orphan-inventory.ts`（`inventoryOrphans`）已存在，比對 storage 四型物件（`att/original`／`att/thumb`／`rpt/pdf`／`rpt/void`）與 DB 四來源鍵集（`Attachment.storageKey`／`thumbnailKey`／`Report.storageKey`／`VoidedReportFile.storageKey`）之差集，唯讀、零刪除。**目前仍無 CLI**（D5=(c) 只到「量測」為止，未授權操作面）；開發者需要盤點時，以一次性 `tsx` 腳本呼叫，例如：

```ts
// 存於任一暫存位置（不進 repo），從 backend/ 目錄以 `npx tsx <script>.ts` 執行
import { config as loadDotenv } from "dotenv";
loadDotenv();
import { PrismaClient } from "@prisma/client";
import { inventoryOrphans } from "./src/attachment/orphan-inventory.js";
import { LocalVolumeStorage } from "./src/storage/local-volume-storage.js";

const attStorage = new LocalVolumeStorage(process.env.ATTACHMENT_STORAGE_ROOT!, { prefixes: ["att"] });
const rptStorage = new LocalVolumeStorage(process.env.REPORT_STORAGE_ROOT!, { prefixes: ["rpt"] });
const prisma = new PrismaClient();
console.log(JSON.stringify(await inventoryOrphans(prisma, attStorage, rptStorage, { now: new Date() }), null, 2));
await prisma.$disconnect();
```

**判讀本報告時的三項警語**：
1. **「無對應 DB 列」之高佔比不等於高洩漏率**——T6 首次對本機共用開發 storage 根目錄實測，21,612／22,173（約 97%）之物件無對應 DB 列。主因是 **Phase 邊界之 DB 重置（見上方 (f) 節）未同步清空 storage volume**：DB 清空重來，舊 Phase 遺留的 storage 檔案仍在，因而每個 Phase 邊界都會製造一批「合法但過期」的無對應物件——這不是清理程序的洩漏率，是共用開發環境的操作副作用。正式環境（DB 與 storage 生命週期一致、無這種週期性重置）之比例預期遠低於此。
2. **`pendingCount` 必須與 `confirmedOrphanCount` 併讀，不得逕行忽略**——`pendingCount` 是仍在保護期窗（預設 24 小時）內、尚未被判定為孤兒的物件；在高寫入頻率環境下它可能遠大於 `confirmedOrphanCount`（T6 首測：7,255 confirmed／14,357 pending），並非可安全略過的雜訊。
3. **報告數字為下限**——不合 `LocalVolumeStorage` key 格式（如非本系統寫入路徑落地的雜項檔案）之物件在 `list()` 這一層已被過濾、報告完全看不見，故實際孤兒數只會**大於等於**報告所示。

目前若需要盤點以外的操作（刪除、封存等），仍需人工比對上述輸出後自行執行——尚未落地為可執行的操作指令；落地後本節將補充相關指令。

---

## (h) 故障處置

**健康檢查異常**（`GET /health` 回 `503`）：`checks.db="down"` 表示 DB 連線失敗——先確認 DB 容器／服務是否存活，再檢查 `DATABASE_URL` 是否正確。**健康檢查綠燈不代表儲存正常**（見 (a)），儲存故障的偵測方式如下。

**儲存不可寫**：不會反映在 `/health`（D9=(a) 刻意設計，重啟對 volume 故障沒有幫助）。偵測方式：
① `scripts/backup.sh` 執行失敗（`mkdir`／`tar` 相關步驟失敗，見 (b) 之排障方式）；
② 一般業務操作（上傳附件、產生報表）出現 `500`，且日誌中出現 storage 相關的具名日誌標籤；
③ 手動確認掛載的 volume 路徑之讀寫權限。

**渲染器（Playwright／Chromium）不可用**：依 `docs/KNOWN_ISSUES.md` 之刻意設計，PDF 產生依賴渲染器，渲染器不可用時**作廢動作整筆失敗**（作廢與 PDF 產生在同一交易內，回滾，可重試，零殘留）。若這個「全有全無」語意不可接受，正解是改變產品設計（例如作廢不需要成功產生 PDF）——**這是使用者可見行為的變更，不由運維端自行降級處理**，需走 Spec 決策流程。運維端能做的只有排查渲染器本身為何不可用（容器內 Chromium 是否正常啟動、記憶體是否足夠）並請使用者重試該次作廢。

**20 併發下偶發 `503`（草稿儲存端點）**：已量測發生率 0.35%（21384 次請求中 74 筆），全數集中於草稿儲存端點（`PUT /applications/travel/:id`），根因為資料庫交易在高併發寫入下衝突重試耗盡。人類已於 2026-08-12 裁定接受為已知特性。使用者端症狀為草稿儲存偶發失敗，**重按一次即可成功**；不需要運維介入排查。

---

*本文件為機械守門對象（`backend/test/unit/runbook-sections.test.ts`）：上列八個小節標題若被移除或改寫，該守門測試會翻紅。修改本文時請保留各節標題的可辨識文字，內容可自由擴充。*
