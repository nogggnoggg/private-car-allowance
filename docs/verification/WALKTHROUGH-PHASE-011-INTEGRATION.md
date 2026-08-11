# WALKTHROUGH — PHASE-011 部署硬化整合 Gate（骨架）

- 產出：PHASE-011-T10（implementer）；**本檔為骨架**，T11／T12／T13 落地後由大總管補完各該段落
- 前提：T3~T10 已合入 `phase-011`；dev 容器 stack 可啟動（映像已 build 過一次）
- 裁定人：leonchih
- 預估時間：20~30 分鐘（全合成資料）
- 執行方式：以下指令由大總管在您在場時代跑並展示輸出，或您自行複製執行皆可。

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

- 預期：`db` 與 `backend` 為 `healthy`；`frontend` 為 `running`（**compose 未替 frontend 定義 healthcheck**，其「可用」以下一步的 HTTP 200 為準——此處據實記載，不宣稱 frontend 有 health 狀態）。
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

> **待 T11 落地後補完**（`scripts/measure-performance.mjs` ＋ 數據表）。骨架保留位：七類場景 × N≥5 之中位數／最大值表、20 併發之 5xx 比率與 p95、量測條件（資料規模／環境／冷啟或暖機／取樣數）逐條載明。

- 結果：

## 第 6 段：備份與還原（AC-19~AC-24）

> **待 T12／T13 落地後補完**（`scripts/backup.sh`／`scripts/verify-restore.sh`）。骨架保留位：①備份涵蓋三類（DB／附件／PDF）＋ manifest 六欄目視 ②保留期與目的地守門 ③還原至隔離目標後之三項確認與關聯完整性七項 ④**防恆真對照**（截斷／改位元組之備份必然失敗）⑤還原流程前後正式面資料全等。

- 結果：

## 本 Gate 裁定的是什麼

- ✅ 批准＝「部署硬化之驗證程序可信，容器／DB／附件分離重建不失資料」。
- ❌ 本 Gate 不批准：正式環境上線、真實資料遷移、正式網域 TLS 設定（屬部署時決策）。

## Gate 結果（大總管回填）

- 裁定日期：
- 各段結果：
- 使用者批准：
