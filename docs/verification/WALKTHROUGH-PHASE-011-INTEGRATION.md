# WALKTHROUGH — PHASE-011 部署硬化整合 Gate

- 產出：§1~§4 由 PHASE-011-T10（implementer）產出骨架；**§5／§6 由 PHASE-011-FR1（implementer）於 2026-08-12 以實跑物證補完**（終審 MF-1；走查腳本之補完屬派工，非大總管自行撰寫）
- 前提：T3~T10 已合入 `phase-011`；dev 容器 stack 可啟動（映像已 build 過一次）
- 裁定人：leonchih
- 預估時間：20~30 分鐘（全合成資料）；含 §6 之完整備份還原一輪約再加 5 分鐘
- 執行方式：以下指令由大總管在您在場時代跑並展示輸出，或您自行複製執行皆可。
- **步驟分類標注**（2026-08-11 人類裁定先例：「這種純 coding 的部份這次讓你驗，通過後跟我說」，記載形見 `WALKTHROUGH-PHASE-011-CLEANUP.md` :7／:60）：§5／§6 逐步標注 **產品判斷型**（需裁定人親看、涉及人類判斷者）或 **純技術驗證型**（大總管代跑並展示輸出即可）。§1~§4 為 T10 骨架原文，本次未回頭加註（其性質於各步文字內已可辨——如 §4 之 TLS／Cookie 目視即典型產品判斷型）。

## 環境前提（每次執行前先確認）

| 項目 | 值 | 為何重要 |
|---|---|---|
| compose 專案名 | `oilexpense` | 倉庫實際路徑含中文，compose 無法從目錄名推導專案名；一律 `COMPOSE_PROJECT_NAME=oilexpense` |
| build 通道 | junction `C:\oilexp-build` ＋ PowerShell | BuildKit 對含非 ASCII 之 build context 會失敗（PHASE-009 事故） |
| 入口 | `http://localhost:8080`（前端 nginx，`/api` 轉後端 :3000） | AC-16(a) 的「前端可經 `/api` 打到後端」即由此鏈路證明 |
| **不得觸碰** | 容器 `t1-pg`（:55432） | 測試庫，整個 vitest 套件靠它；不屬 `oilexpense` 專案 |
| 憑證 | 寫在**倉庫外**的 env 檔，以 `set -a; . <檔>; set +a` 載入 | 憑證不經命令列（AC-22(c) 同族紀律） |

```bash
# 倉庫外的憑證檔範例（勿 commit；密碼請用該環境實際值）
# VERIFY_ADMIN_LOGIN=<admin 帳號>
# VERIFY_ADMIN_PASSWORD=<目前密碼>
# VERIFY_ADMIN_INITIAL_PASSWORD=<僅空 DB 自舉時用，須與上一行不同>
```

## 第 1 段：三服務起動與健康檢查兩態（AC-14／AC-16(a)）

### 1-1 三服務起動

```bash
cd C:\oilexp-build && COMPOSE_PROJECT_NAME=oilexpense docker compose up -d --build
COMPOSE_PROJECT_NAME=oilexpense docker compose ps
```

- 預期：`db`／`backend`／`frontend` **三者皆為 `healthy`**（frontend 之 healthcheck 由 PHASE-011-FR2 補上，`3ca7092`）。
  - frontend 之健檢指令為 `curl -fsS http://localhost/`（容器內對自己），`start_period` **30s**——**首次 `up` 後約 30~40 秒內顯示 `starting` 屬正常，不是缺陷**；請等它轉 `healthy` 再判定，勿在 30 秒內就判失敗。
  - ⚠ **判讀界線**：frontend `healthy` **只代表 nginx 正在服務**（SPA fallback 使任意路徑皆回 200），**不代表 `/api` 反向代理通**；前端經 `/api` 打到後端之全鏈證明仍看下一步 §1-2 的 `GET http://localhost:8080/api/health`。
- 結果：

### 1-2 健康檢查「正常態」

```bash
curl -i http://localhost:8080/api/health
```

- 預期：`200` ＋ `status:"ok"` ＋ `checks.db:"up"`；回應零連線資訊、零路徑、零例外訊息。
- 結果：

### 1-3 健康檢查「異常態」（目視 DB 斷線時的行為）

```bash
COMPOSE_PROJECT_NAME=oilexpense docker compose stop db
curl -i http://localhost:8080/api/health          # 預期 503 + status:"error" + checks.db:"down"
COMPOSE_PROJECT_NAME=oilexpense docker compose start db
```

- 檢核點：訊息不得洩漏連線字串／主機名／堆疊；恢復後回 `200`。
- 結果：

## 第 2 段：持久化三指紋（AC-15(a)(b)(c)）＋ 反向對照（AC-15(d)）

> ⛔ **本段的驗證腳本僅限 dev／staging，禁止對正式環境執行。** 它不是唯讀探針——每次執行會建立全域參數版本、建立並完成一筆申請、**消耗一個正式報表編號（不可回收）**；`--mode destroy` 更會刪除 volume。腳本已內建機械守門：`BASE_URL` 非 `localhost`／`127.0.0.1` 時直接拒跑（結束碼 2），需明示 `--yes-write-to-remote` 才放行。
>
> ⛔ **若腳本回結束碼 2 並印出「前側三指紋未能全數取得：本次比對無鑑別力」，該次執行不算通過，也不算失敗**——代表播種後連第一次都沒取到三指紋（例如附件授權端點回 403、報表端點回 404），此時任何「前後全等」的結論都無意義。請先排除該端點問題再重跑。

### 2-1 正向：`down`（不加 `-v`）→ `up` → 三指紋逐一全等

```bash
cd C:\oilexp-build && bash scripts/verify-persistence.sh --mode preserve
```

- 腳本會：播種一筆含附件之已完成差旅申請並產生正式 PDF → 記錄三指紋（①DB：申請 id ＋ totalAmount ②附件位元組 sha256 ③PDF 位元組 sha256）→ `docker compose down` → `up` → 重新取三指紋比對。
- 預期：`✅ 三指紋逐一全等`＋結束碼 **0**。
- 檢核點：附件與 PDF 是**經授權端點取回後**逐位元組比對，不是看檔案還在不在。
- 結果：

### 2-2 反向對照（證明這道驗證不是恆真）

```bash
cd C:\oilexp-build && bash scripts/verify-persistence.sh --mode destroy --yes-destroy-data
```

- ⚠ **會刪掉 `oilexpense_pgdata` 與 `oilexpense_storage` 兩個 volume**（dev 全合成資料）。執行前請先確認 stack 內無任何需保留之資料。
- 預期：`❌ 三指紋不全等` → `✅ 反向對照成立` ＋結束碼 **1**。**結束碼 1 是本步驟的正確結果**。
- 檢核點：若此步竟然回 0，代表 2-1 的「全等」沒有鑑別力，2-1 的結論即不可採信。
- 結果：

### 2-3 空 volume 自舉（證明程序可重複執行）

```bash
cd C:\oilexp-build && bash scripts/verify-persistence.sh --mode preserve
```

- 預期：腳本自行 seed 管理員（`[seed:admin] Admin user created`）→ 播種 → 三指紋全等 ＋結束碼 0。
- 結果：

## 第 3 段：單面重建之獨立性（AC-16(b)）

```bash
cd C:\oilexp-build
COMPOSE_PROJECT_NAME=oilexpense docker compose ps -q          # 前
bash scripts/verify-persistence.sh --mode rebuild-backend      # 只重建後端
bash scripts/verify-persistence.sh --mode rebuild-frontend     # 只重建前端
COMPOSE_PROJECT_NAME=oilexpense docker compose ps -q          # 後
```

- 預期（每次執行）：被重建的那一面容器 id 改變，**另兩面容器 id 與映像 id 皆不變**，且三指紋全等。
- 檢核點：`docker compose ps -q` 的前後輸出，未重建之服務其完整 id 必須逐字相同。
- 結果：

## 第 4 段：TLS 與 Cookie 屬性目視（AC-09／AC-10；T7 FW-6）

> 本段需**部署於已啟用 HTTPS 之環境**（本機 compose 為 http，`Secure` 旗標不會出現——此為預期，不是缺陷）。本機執行時請在「結果」欄註明「本機 http，改於 staging 目視」。

1. **位址列**：以瀏覽器開啟系統首頁，確認位址列為 `https://`（非 `http://`、無憑證警告）。
   - 結果：
2. **Cookie 面板**：DevTools → Application → Cookies → 選 session cookie，確認 `Secure`／`HttpOnly`／`SameSite=Lax`／`Path=/` 四欄。
   - 結果：

## 第 5 段：效能量測報告目視（AC-17／AC-18）

> **本段之數據來源＝T11 已審定實測，不要求當場重跑。** 下列每一格皆出自 `docs/specs/PHASE-011.md` §12 之 `AC-17(a)~(g)`／`AC-17(h)(i)`／`AC-18(a)~(d)` 三列（T11 於 2026-08-11 19:56~19:57 之第四次執行，已經 reviewer 與大總管審定入 Spec）。
>
> ⚠ **重跑之代價須先知道**：`scripts/measure-performance.mjs` 每次執行都會**先播種** 25 位合成使用者 × 各 30 筆申請，並實際完成申請／產生正式 PDF／作廢／建立修正版——這是**不可逆**的資料增長與**正式報表編號消耗**（同 §2 之同族紀律）。是否重跑由裁定人決定；**只目視數據即可完成本段**。

### 5-1 七類場景之最大值對照目標（**純技術驗證型**）

- 判定準則（AC-17(h) 原文）：「**單次取樣不算數**：每個目標至少 **N ≥ 5** 次，報告中位數與最大值，**以最大值對照目標**。」

| AC | 場景 | N | 最大值 | 目標 | 判定 |
|---|---|---|---|---|---|
| (a) | 申請列表 | 8 | **7 ms** | 2000 ms | PASS |
| (a) | 申請詳情 | 8 | **5 ms** | 2000 ms | PASS |
| (a) | 管理員全域列表 | 8 | **5 ms** | 2000 ms | PASS |
| (b) | 日期區間里程統計 | 8 | **4 ms** | 3000 ms | PASS |
| (c) | 草稿儲存 | 8 | **15 ms** | 2000 ms | PASS |
| (c) | 完成申請 | 6 | **15 ms** | 2000 ms | PASS |
| (d) | 正式 PDF 產生 | 6 | **165 ms** | 10000 ms | PASS |
| (e) | 作廢（含作廢版 PDF） | 6 | **172 ms** | 10000 ms | PASS |
| (f) | 建立修正版（含附件複製） | 6 | **19 ms** | 5000 ms | PASS |
| (g) | 稽核列表查詢 | 8 | **5 ms** | 2000 ms | PASS |

- 七類全數 PASS、**零失敗樣本**。另有一項非 AC-17 列名之量測：`DELETE /admin/users/:id` 之歷史阻擋查詢最大 **10 ms**——它與上表之 (b) **4 ms**、(g) **5 ms** 三者即 §16 D17（索引補強）之三個裁定輸入，全數遠低於目標，故依二階段預授權 **T19 不補索引、不開工**（§17.1 #17）。
- **中位數不在本表**（據實說明，非遺漏）：Spec §12 只審定入 N 與最大值（AC-17(h) 指定之對照量），逐場景中位數在 T11 Handoff 與重跑輸出中。目視本段**以最大值為準**即可完成判定。
- 失敗處置：若裁定人要求重跑而某類最大值超標——依 **AC-17(i)**，不得放寬目標、亦不由本 Phase 自行優化；據實記入 §17 並由人類裁定是否本期處理。
- 結果：

### 5-2 資料規模與量測條件（**純技術驗證型**；AC-17(h) 之交付物本體）

- **環境**：本機 docker compose stack（`COMPOSE_PROJECT_NAME=oilexpense`），量測對象 `http://localhost:8080`（nginx 全鏈，含反向代理）。
- **資料規模**（T11 播種後以 `psql count(*)` 實測）：`User` 66／`Application` 1653／`TravelApplication` 888／`TripSegment` 886／`MaintenanceApplication` 408／`DepreciationApplication` 357／`Report` 229／`Attachment` 629／`AuditLog` 146。
- **量測方式**：暖機後取樣（非冷啟）；讀取類序列取樣、寫入類逐筆消耗式取樣；N=6~8。時點 `2026-08-11T19:57:40Z`。
- ⚠ **射程限制（不得被誤讀）**：上述毫秒數只在**這個資料規模、這台機器**上成立。B-22 明定「空庫量測無效」；同理，25 使用者 × 30 筆之規模遠小於數年營運後的量，**達標不等於永遠達標**。§17.1 #17 已把這組數字登記為日後重評之**基準線**——資料量成長使任一項超標時，三項候選索引須重評。
- 當場核對資料規模（唯讀，可代跑）：

```bash
docker exec oilexpense-db-1 psql -U appuser -d appdb -tAc \
  'SELECT (SELECT count(*) FROM "User"), (SELECT count(*) FROM "Application"), (SELECT count(*) FROM "Report"), (SELECT count(*) FROM "Attachment")'
```

- 預期：`66|1653|229|629`（2026-08-12 實跑值；後續若又跑過播種類腳本會變大，**變大不是缺陷**，但判讀 5-1 之毫秒數時須知道它們對應的是上面那組規模）。
- 結果：

### 5-3 20 併發之可用性（**產品判斷型**——判準已由人類裁定，請裁定人確認該裁定仍成立）

- T11 實測：**20 併發**、持續 **35.1 s**、總請求數 **21384**（同時滿足 ≥30 s 與 ≥200 次請求兩判準）。
- `5xx`：**503 共 74 筆＝0.35%**；逐筆歸因**全數**落在 `PUT /applications/travel/:id`（草稿儲存），根因為 SERIALIZABLE 交易衝突之重試耗盡。
- 非預期 `4xx`：**0**。
- p95：列表 **19 ms**／詳情 **22 ms**／草稿儲存 **202 ms**（皆遠低於 AC-17(a)(c) 之 2000 ms）。
- **判準勘誤（已由人類裁定，此處據實重述）**：AC-18(b)① 原文為「`5xx` 比率 ＝ 0（含 `503`）」；**leonchih 於 2026-08-12 以 AskUserQuestion 裁定接受**該 0.35% 併發重試型 503（與 §17.1 #13、PR #19 已接受之 503 同一根因），判準勘誤為「**`5xx` 限於已登記之併發重試型，其餘 ＝ 0**」，非該型者仍判未達標；降低發生率之結構性改動列未來獨立工作項（§17.2 #8），本 Phase 不自行優化。
- ⚠ **重跑時之判讀陷阱（據實揭露）**：`measure-performance.mjs` 之輸出仍逐字印 `5xx 數=N（判準：必須為 0）`，且 `5xx > 0` 時**結束碼為 3**——這段文字與結束碼規則**早於**上述 2026-08-12 之勘誤，腳本未同步（本次修復不得變更 `scripts/*` 之內容）。故重跑若回結束碼 3：**先看「5xx 逐筆歸因」那幾行**，全數落於 `PUT /applications/travel/:id` 者，依勘誤後判準仍為達標；出現任何其他路徑之 5xx 才是真的未達標。
- 結果：

### 5-4 選用：當場重跑（**純技術驗證型**；有不可逆副作用，執行前須裁定人明示同意）

```bash
cd "E:\Claude Project\油資"
set -a; . <倉庫外的憑證檔>; set +a          # 憑證一律經環境變數，不經命令列參數
export PERF_ADMIN_LOGIN="$VERIFY_ADMIN_LOGIN"
export PERF_ADMIN_PASSWORD="$VERIFY_ADMIN_PASSWORD"
node scripts/measure-performance.mjs; echo "EXIT=$?"
```

- 預期：Phase 0／spike（客戶端瓶頸確認 ＋ 三次重跑離散度）→ Phase 1／播種 → Phase 2／七類表 → Phase 3／20 併發表，最後印 `=== AC-17(h) 量測條件 ===`。
- 失敗處置：結束碼 **2**＝stack 未就緒或缺必要環境變數（**不算通過也不算失敗**，排除後重跑）；**1**＝量測期間未預期錯誤；**3**＝至少一類未達標**或**併發 5xx>0（後者之判讀見 5-3 之陷阱說明）。
- 結果：

## 第 6 段：備份與還原（AC-19~AC-24）

> **本段每一則「預期輸出」皆為 PHASE-011-FR1 於 2026-08-12 之實跑輸出節錄**（一次完整備份 → 一次完整還原驗證 → 兩道守門 → 防恆真對照），不是構想值。備份 id 與 `sha256` 逐次不同屬正常，**其餘行的形狀應逐字相符**。
>
> **本 stack 的兩個環境事實決定了下面的參數形，請先看懂再執行**：
>
> 1. **DB 容器未對主機發布 port**（`docker ps` 顯示 `oilexpense-db-1` 為 `5432/tcp`，無 host 映射），而主機上另有其他專案的 PostgreSQL 佔著 5432 → `backup.sh` 的「哪個容器發布了這個 port」自動探測必然失準，**必須顯式設定 `BACKUP_PG_CONTAINER=oilexpense-db-1`**（`RUNBOOK.md` :112 同一條）。
> 2. **storage 掛在 named volume，主機看不到路徑** → 依 `RUNBOOK.md` :94-102 之替代手法，先把內容複製到主機可讀的暫存目錄，再指向該目錄備份。
>
> 一切產物落在**倉庫外**的走查專用目錄（下稱 `$WD`），不污染 repo；收尾一併刪除（6-8）。
>
> **本段各步沿用同一個 shell**（`$WD` 與各個 `export` 仍在）。若中途換了視窗，請先重跑該步之前最近的 `export` 區塊，否則會撞「必要環境變數缺漏」而回結束碼 2。

### 6-0 準備：走查目錄與 storage 之主機端副本（**純技術驗證型**）

```bash
WD="<倉庫外的走查目錄，例如 C:/Users/<你>/AppData/Local/Temp/oilexpense-gate>"
mkdir -p "$WD/live" "$WD/backups" "$WD/log"
docker run --rm --volumes-from oilexpense-backend-1 -v "$WD/live:/backup-staging" \
  alpine sh -c "cp -r /data/storage/. /backup-staging/ && ls /backup-staging && find /backup-staging -type f | wc -l"
docker exec oilexpense-backend-1 sh -c 'find /data/storage -type f | wc -l'   # 對照組
```

- 預期（2026-08-12 實跑）：先印 `attachments`／`pdf` 兩個目錄名，再印 **`1499`**；對照組同樣印 **`1499`**。
- 判定準則：**兩個數字必須相同**。不同即代表複製不完整——**不可繼續**，因為後面的涵蓋自檢會把這份副本當成「全部物件」，副本殘缺會讓自檢在假前提下通過。
- 失敗處置：多半是掛載點寫錯或磁碟空間不足（storage 約 100 MB）；修正後重跑本步，不必回頭做別的。
- 結果：

### 6-1 一次完整備份（AC-19；**純技術驗證型**）

```bash
cd "E:\Claude Project\油資"
set -a; . ./.env; set +a          # compose 之未追蹤 env 檔；DATABASE_URL 由此取得（密碼段腳本永不取用、永不輸出）
export BACKUP_DEST_ROOT="$WD/backups"
export ATTACHMENT_STORAGE_ROOT="$WD/live/attachments"
export REPORT_STORAGE_ROOT="$WD/live/pdf"
export BACKUP_PG_CONTAINER=oilexpense-db-1
bash scripts/backup.sh; echo "EXIT=$?"
```

- 預期（2026-08-12 實跑逐字）：

```
[backup] preflight: destination-ok checked=ATTACHMENT_STORAGE_ROOT,REPORT_STORAGE_ROOT unset-and-skipped=BACKUP_PGDATA_PATH retention-days=14
[backup] start id=20260812T120347Z container=oilexpense-db-1 schema=public
[backup] part db-dump bytes=253990
[backup] part attachments bytes=1617920
[backup] part reports bytes=97269760
[backup] coverage: sources=4 keys=1499 present=1499 missing=0
[backup] retention: days=14 removed=0
[backup] done id=20260812T120347Z parts=3
EXIT=0
```

- 判定準則（逐條）：
  1. **三個 `part` 行齊全**——`db-dump`／`attachments`／`reports`，即 AC-19(a)(b)(c) 之三類涵蓋範圍，缺一即不成立。
  2. `coverage` 行 **`missing=0`** 且 **`keys` 不為 0**。`keys=0` 會被腳本直接拒跑（**「沒東西可驗」不得與「驗過都在」同結局**）；此處 `keys=1499` 恰等於 6-0 的檔案數，代表 DB 四來源鍵集與 storage 現況對得上。
  3. `EXIT=0`。
  4. **輸出目視零敏感內容**（AC-22(b)）：整段沒有絕對路徑、沒有完整 storage key、沒有連線字串——只有備份 id、位元組數、計數與**變數名**。
- 失敗處置：腳本刻意關閉外部工具（`pg_dump`／`psql`／`tar`）的原始錯誤輸出以免洩漏絕對路徑，只回報「哪一步失敗」。要看原文，依 `RUNBOOK.md` :114：**以完全相同的環境變數手動跑同一支工具一次**（不重導向 stderr）。
- 結果：

### 6-2 manifest 六欄目視（AC-19(e)；**產品判斷型**——這份清單是日後鑑識「這批資料是哪一版腳本、哪個時點備的」唯一線索）

```bash
cat "$WD/backups/<上一步印出的備份 id>/manifest.json"
```

- 預期（2026-08-12 實跑；`sha256` 與 `backupId` 逐次不同屬正常）：

```json
{
  "backupId": "20260812T120347Z",
  "createdAt": "2026-08-12T12:03:47Z",
  "scope": ["postgresql-database", "attachment-storage", "report-storage"],
  "parts": [
    { "name": "db-dump", "scope": "postgresql-database", "file": "db.dump", "bytes": 253990, "sha256": "99a60e80…" },
    { "name": "attachments", "scope": "attachment-storage", "file": "attachments.tar", "bytes": 1617920, "sha256": "e5ba6ea2…" },
    { "name": "reports", "scope": "report-storage", "file": "reports.tar", "bytes": 97269760, "sha256": "bd6c60ca…" }
  ],
  "tools": { "pg_dump": "16.14", "tar": "tar (GNU tar) 1.35", "script": "PHASE-011-T12/2" },
  "coverage": { "keys": 1499, "present": 1499, "missing": 0, "allowEmpty": false },
  "retentionDays": 14
}
```

- 判定準則——**AC-19(e) 之六欄逐項在場**：①時間戳 `createdAt` ②涵蓋範圍 `scope`（三類）③各部分 `parts`（三份）④各部分**位元組數** `bytes` ⑤各部分**雜湊** `sha256` ⑥**工具版本** `tools`（含 `script`＝產生此備份之腳本版本）。
- 另兩欄請一併看（它們決定這份備份「可不可信」）：`coverage.allowEmpty` 須為 **`false`**（`true` 代表該次備份的涵蓋自檢**根本沒有驗證對象**，是維運人員明示放行的）；`retentionDays` 須 **≥ 14**。
- 結果：

### 6-3 兩道守門（AC-20(c) 保留下限／AC-21 目的地路徑樹；**純技術驗證型**）

```bash
# (i) 目的地落在受保護的 storage 路徑樹之內 → 必拒
BACKUP_DEST_ROOT="$WD/live/attachments/backup-here" bash scripts/backup.sh; echo "EXIT=$?"
# (ii) 保留天數低於 US 硬性下限 → 必拒
BACKUP_DEST_ROOT="$WD/backups" BACKUP_RETENTION_DAYS=7 bash scripts/backup.sh; echo "EXIT=$?"
# (iii) 守門後之寫入痕跡（應為零）
ls "$WD/live/attachments"
```

- 預期（2026-08-12 實跑逐字）：

```
BACKUP_DEST_ROOT rejected by path-tree guard (AC-21): descendant-of-protected of ATTACHMENT_STORAGE_ROOT
[backup] ERROR: preflight rejected (see message above; nothing was written)
EXIT=1
BACKUP_RETENTION_DAYS must be at least 14 (US NFR-US-12 hard lower bound)
[backup] ERROR: preflight rejected (see message above; nothing was written)
EXIT=1
att
```

- 判定準則：①兩次皆**非零結束碼**②訊息**含變數名但不含完整路徑值**（AC-21(b)：只說相對關係 `descendant-of-protected`）③第三個指令只印 `att`——**沒有** `backup-here` 目錄，即守門攔截時**零寫入**。
- 為什麼要看這兩格：6-1 的成功是「這條路走得通」，這兩格才是「走錯路會被擋住」。**只有 6-1 沒有 6-3，等於沒證明守門存在。**
- ⚠ **本守門之射程（不得被誤讀）**：機械保證的只有「備份不落在正式資料的**路徑樹**內」。**「不同主機／不同磁碟」系統不驗證**——同一顆磁碟上的另一個目錄會通過守門。真正的異地保存是部署時的人工職責（AC-21(e)、`RUNBOOK.md` :88）。
- 結果：

### 6-4 一次完整還原驗證（AC-23 之三項確認；**純技術驗證型**）

```bash
cd "E:\Claude Project\油資"
set -a; . ./.env; set +a
export BACKUP_DEST_ROOT="$WD/backups"
export RESTORE_TARGET_DATABASE_URL="${DATABASE_URL%/*}/restore_verify_scratch"   # 同實例、另一個庫名；腳本自建、用畢自刪
export RESTORE_VERIFY_LOG="$WD/log/restore-verify.log"
export RESTORE_PG_CONTAINER=oilexpense-db-1
export RESTORE_SOURCE_PG_CONTAINER=oilexpense-db-1
bash scripts/verify-restore.sh; echo "EXIT=$?"
```

- 預期（2026-08-12 實跑逐字）：

```
[verify-restore] start id=20260812T120347Z evidence=full schema-scope=RESTORE_VERIFY_SCHEMA version=PHASE-011-T13/2
[verify-restore] target=created
[verify-restore] (a) db-opened=yes migration-tail=match
[verify-restore] (b) parts-verified=3; sample n=3 thumb=1 revision=1 readable=3
[verify-restore] (c) relations checked=16 fk=15 fixed=1 orphans=0 fixed-list=7/7
[verify-restore] done id=20260812T120347Z result=pass summary=all-three-confirmations-passed evidence=full
[verify-restore] target=dropped
EXIT=0
```

- 判定準則——**三項確認逐行對照**：
  - **(a) 資料庫可開啟**：`db-opened=yes` ＋ `migration-tail=match`（還原目標之 `_prisma_migrations` 尾筆與**來源現況**相同）。若看到 `migration-tail-differs-from-source`，代表這份備份還原回來的 schema 已對不上今天的程式——**改用較新的備份重跑**，不是本次驗證的缺陷。
  - **(b) 附件可讀取**：`parts-verified=3`（三份產物之 `sha256` 與 manifest 全等）＋ `sample n=3 thumb=1 revision=1`（抽樣 ≥3 且**含縮圖、含修正版副本**——AC-23(b) 逐字）＋ `readable=3`（抽到的鍵在還原出來的 storage 裡都讀得到）。
  - **(c) 主要資料關聯存在**：`fk=15`＝以 `information_schema` **動態列舉**目標 schema 之全部外鍵共 15 條、逐條數孤兒；`fixed=1`＝一條**非外鍵**的弱引用檢查（`Attachment.refType`／`refId` 之 `LINKED` 列其容器是否存在——七項中唯一沒有外鍵在守、真的可能抓到東西的一項）；`checked=16`＝15＋1；`fixed-list=7/7`＝AC-23(c) 之**七項固定清單**逐項對得上（七項所宣告的每一條外鍵邊都出現在動態列舉結果內，缺一即紅——防「固定清單過時」）；`orphans=0`＝孤兒總數為 0。
  - `evidence=full`：**沒有任何降級標記**。看到 `sample-incomplete` 代表 (b) 根本沒跑完整；看到 `coverage-unverified` 代表**三項都跑了但所驗的那份備份自己的涵蓋自檢沒有背書**——兩者方向不同，別混為一談。
  - `target=dropped` ＋ `EXIT=0`。
- ⚠ **執行前必知（同實例磁碟風險）**：本例的還原目標與來源在**同一個 PostgreSQL 實例**上（只是庫名不同）。演練期間該實例會**瞬間多出一份全庫副本**，直到 `DROP` 為止。正式環境若磁碟已近水位，**一次演練就足以把正式服務寫爆**——正式環境演練前務必先確認可用空間，並建議以 `RESTORE_PG_CONTAINER` 指向獨立實例（`RUNBOOK.md` :155）。
- 失敗處置：結束碼 **1**＝某一階段失敗（**已寫入失敗紀錄**，看 6-5 的紀錄檔取摘要碼，對照 `RUNBOOK.md` :137-143 之判讀表）；**2**＝必要環境變數或工具缺漏，**此時尚未進入任何驗證階段、不會寫紀錄**，不算通過也不算失敗。
- 結果：

### 6-5 隔離目標用畢即刪 ＋ 驗證紀錄（AC-24；**純技術驗證型**）

```bash
docker exec oilexpense-db-1 psql -U appuser -d postgres -tAc "SELECT datname FROM pg_database ORDER BY 1"
cat "$WD/log/restore-verify.log"
```

- 預期（2026-08-12 實跑）：

```
appdb
postgres
template0
template1
{"timestamp":"2026-08-12T12:04:43Z","backupId":"20260812T120347Z","stage":"none","summary":"all-three-confirmations-passed","exitCode":0,"evidence":"full"}
```

- 判定準則：①資料庫清單中**沒有** `restore_verify_scratch`——隔離目標用畢即刪，不留在實例上②紀錄檔有一行 JSON 六欄齊全（`timestamp`／`backupId`／`stage`／`summary`／`exitCode`／`evidence`）③紀錄內容**零敏感值**（無連線字串、無 storage key、無絕對路徑）。
- 為什麼成功也要留紀錄：AC-24(c) 之目的是讓「**這個月到底有沒有真的跑過**」可稽核——只記失敗的話，沒紀錄會同時代表「沒跑」與「跑得很順」。
- 結果：

### 6-6 防恆真對照：改一個位元組的備份**必然失敗**（AC-23(e)；**純技術驗證型**；本段最重要的一格）

```bash
# 複製一份備份，只改第 1000 個位元組（長度不變、manifest 不動）
cp -r "$WD/backups/20260812T120347Z" "$WD/backups/20260812T129999Z"
printf 'X' | dd of="$WD/backups/20260812T129999Z/db.dump" bs=1 seek=1000 count=1 conv=notrunc 2>/dev/null
RESTORE_BACKUP_ID=20260812T129999Z bash scripts/verify-restore.sh; echo "EXIT=$?"
tail -n 1 "$WD/log/restore-verify.log"
docker exec oilexpense-db-1 psql -U appuser -d postgres -tAc "SELECT datname FROM pg_database ORDER BY 1" | tr '\n' ' '
```

- 預期（2026-08-12 實跑逐字）：

```
[verify-restore] start id=20260812T129999Z evidence=full schema-scope=RESTORE_VERIFY_SCHEMA version=PHASE-011-T13/2
[verify-restore] ERROR: stage=a summary=db-dump-hash-mismatch
EXIT=1
{"timestamp":"2026-08-12T12:05:31Z","backupId":"20260812T129999Z","stage":"a","summary":"db-dump-hash-mismatch","exitCode":1,"evidence":"full"}
appdb postgres template0 template1
```

- 判定準則：①**結束碼 1**（此處的 1 是**正確結果**——同 §2-2 反向對照之精神）②失敗紀錄為**追加**（紀錄檔現在有**兩行**，6-5 的成功那行仍在，未被覆蓋——AC-24(b)）③失敗被 **(a) 階段**捕捉、摘要碼為 `db-dump-hash-mismatch`④**沒有建立任何資料庫**（清單仍是四個系統／正式庫）——順序刻意如此：**先驗產物、再動資料庫**，損毀的備份連半個空庫都不會留下。
- **這一格證明的是什麼**：6-4 的一片綠燈**不是恆真**。若此步竟然回 0，6-4 的「三項全過」就完全不可採信——**該情形應立即中止 Gate 並回報**，不得以重跑取綠。
- 結果：

### 6-7 正式面全程唯讀（AC-19(f)／AC-23(d)；**純技術驗證型**）

```bash
docker exec oilexpense-db-1 psql -U appuser -d appdb -tAc \
  'SELECT (SELECT count(*) FROM "Attachment"), (SELECT count(*) FROM "Report"), (SELECT count(*) FROM "VoidedReportFile"), (SELECT count(*) FROM "User"), (SELECT count(*) FROM "Application")'
docker exec oilexpense-backend-1 sh -c 'find /data/storage -type f | wc -l'
```

- 預期（2026-08-12 實跑；**6-1 之前與 6-6 之後兩次量測完全相同**）：

```
629|229|12|66|1653
1499
```

- 判定準則：把本段**開始前**與**全部跑完後**的兩組數字並排——**逐項全等**即證備份與還原演練對正式面是唯讀的。
- ⚠ **本格之射程（據實記載）**：此為**計數層**之前後全等，不是逐位元組快照；它擋得住「演練把正式資料刪了／改了列數」這一類事故，擋不住「列數不變但欄位被改」。逐位元組層級之持久化證明由 §2（三指紋逐一全等）承擔，兩段互補。
- 結果：

### 6-8 收尾清理（**純技術驗證型**）

```bash
docker exec oilexpense-db-1 psql -U appuser -d postgres -tAc "SELECT datname FROM pg_database"   # 確認無 restore_verify_scratch
rm -rf "$WD"                                                                                      # 刪走查目錄（約 200 MB）
```

- 判定準則：`$WD` 已不存在；`docker ps` 之三個 `oilexpense-*` 容器狀態與 §1 相同（本段全程未動 stack 生命週期）。
- 結果：

## 本 Gate 裁定的是什麼

- ✅ 批准＝「部署硬化之驗證程序可信，容器／DB／附件分離重建不失資料」。
- ❌ 本 Gate 不批准：正式環境上線、真實資料遷移、正式網域 TLS 設定（屬部署時決策）。

## Gate 結果（大總管回填）

- **執行方式**：人類 leonchih 2026-08-12 裁定沿用代跑模式（`GATE-011-CONFIRM` 列；清理 Gate 先例）——純技術驗證型全數由大總管代跑並記錄於本節，產品判斷型項目以報告呈現。
- 裁定日期：2026-08-12（大總管代跑完成；使用者批准狀態見下）
- **執行順序調整（記錄在案）**：§2-2 之 destroy 會刪除兩 volume（終局性），故實際順序為 §1 → §5-2 → §6 → §4 → §2 → §3——先跑依賴既有資料的段落（§6 之預期值以既有 1499 檔資料集為基準），destroy 留後。
- **偏差一筆（記錄在案）**：原管理員憑證檔（倉庫外）未跨 session 留存，故 §2 以 `down -v` 重置後由腳本自舉建立**合成**管理員（`[seed:admin] Admin user created`）——§2-1 因此跑在自舉後資料上而非既有資料，三指紋語意不受影響；新合成憑證檔存於 scratchpad（倉庫外），Phase 邊界重置時一併失效。
- 各段結果（完整輸出見 session 記錄）：
  1. **§1 三服務起動與健康兩態 ✅**：`up -d --build` 重建後 **db／backend／frontend 三者皆 `healthy`**（FR2 healthcheck 首次執行期實證，frontend 起動 14 秒即轉 healthy）；`GET /api/health` 正常態 `200`＋`db:"up"`；`stop db` 後 `503`＋`db:"down"`（零連線資訊、零路徑、零堆疊）；`start db` 後恢復 `200`。
  2. **§2 持久化三指紋 ✅**：2-1 preserve＝三指紋逐一全等、結束碼 0（FP2 附件 `sha256=c414cd0e…` 與 Spec 存證值一致）；2-2 destroy＝刪 volume 後三指紋轉 `UNAVAILABLE(HTTP 401)`、「反向對照成立」、結束碼 1（預期）；2-3 空 volume 自舉＝`[seed:admin] Admin user created` → 三指紋全等、結束碼 0。
  3. **§3 單面重建獨立性 ✅**：rebuild-backend＝僅 backend 容器/映像 id 變，db（`a5546e4f…`）與 frontend 完整 id 逐字不變；rebuild-frontend＝僅 frontend 變，db 與 backend（`b29848b5…`）不變；兩次三指紋皆全等。前後 `ps -q` 原文已核。
  4. **§4 TLS/Cookie**：本機 http，`Secure` 不出現屬預期——**改於 staging 目視**（走查本文預留之處置；Cookie 四屬性另有 T7 之 8 格測試釘死＋終審 M3 mutant 反證）。此為本 Gate 唯一留待部署時人工目視項。
  5. **§5 效能 ✅**：5-1 十列（T11 已審定，最大值 4~172 ms vs 目標 2000~10000 ms）目視完成；5-2 資料規模當場核對 `66|1653|229|629` **逐字命中**；5-3 併發判準依 2026-08-12 勘誤裁定判讀；5-4 重跑未執行（有不可逆播種代價，依本文「只目視數據即可完成本段」）。
  6. **§6 備份還原 ✅（本 Gate 核心）**：6-0 副本 1499=1499；6-1 備份 `EXIT=0`、`coverage 1499/1499 missing=0`；6-2 manifest 六欄齊＋`allowEmpty:false`；6-3 兩守門必拒（`EXIT=1`）且零寫入（僅 `att`）；6-4 還原三確認全過（`fk=15`＋`fixed=1`、`fixed-list=7/7`、`evidence=full`）、`target=dropped`、`EXIT=0`；6-5 無 `restore_verify_scratch` 殘留＋紀錄檔 JSON 六欄；6-6 改一位元組 → `stage=a db-dump-hash-mismatch`、`EXIT=1`、連還原庫都未建立、紀錄追加不覆蓋；6-7 正式面前後計數 `629|229|12|66|1653`／`1499` **逐項全等**（唯讀實證）；6-8 走查目錄已刪。
  - 額外收穫：6-4 首跑曾因 MSYS 路徑形（`/c/…`）誤報 `backup-not-found`（改 `C:/` 形即過）——**該次失敗也被寫入紀錄檔且未覆蓋成功列**，意外實證 AC-24(b) 追加語意；路徑形提醒已由本檔 §6-0 之 `$WD` 範例（`C:/` 形）涵蓋。
- 終態：三服務 `healthy`、全鏈 `/api/health` 200；`t1-pg` 全程零觸碰。
- 使用者批准：**批准（人類 leonchih 2026-08-12，AskUserQuestion）**——部署硬化之驗證程序可信、分離重建不失資料；正式上線／真實資料遷移／正式網域 TLS 屬部署時決策不在本 Gate 射程。
