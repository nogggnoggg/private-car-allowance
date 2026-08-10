# ARCHITECTURE — 私車差旅補助管理系統（草案）

- Governance-Version: 2026-08-01.1
- 狀態：DRAFT
- 更新日期：**2026-08-10**（最後同步至 **PHASE-010（稽核檢視與回歸）**已落地現實；DOC-SYNC `PHASE-010-DOCSYNC`——§3 `audit`／`platform` 兩列落點更新、§4.8 稽核檢視與兩種寫入交易語意、§4.9 錯誤組裝點唯一與兜底不記原文、**新增 §4.13 使用者刪除守門與 FK 對應**。前次：2026-08-09 `PHASE-009-DOC-SYNC-B`；再前次：2026-08-07 `PHASE-008-DOC-SYNC`（C 批），該次未更新本行故 2026-08-05 之日期一度失準）
- 上游：`userstory.md`、`docs/PRD.md`、`CLAUDE.md`（技術棧已由人類確認）
- 說明：本文件為概念層架構草案，不含實際套件版本細節、API 完整路徑、DB 欄位與索引、部署程式碼。這些於各 Phase Spec 與實作 Task 定案。

---

## 1. 技術棧

| 層 | 技術 | 容器 |
|---|---|---|
| 前端 | React 18 + TypeScript + Vite | nginx（靜態資產 + 反向代理至後端） |
| 後端 | Node.js + Fastify + Prisma ORM + TypeScript | node |
| 資料庫 | PostgreSQL 16 | 獨立容器／受管服務 |
| PDF | Playwright (Chromium **Headless Shell**) 渲染列印版 HTML | **同 node 容器**（PHASE-008 §16 D4(a) 定案，人類已批准）：每次請求啟動、用畢即關，無常駐實例；映像以 `npx playwright install --only-shell chromium` 只裝 headless shell（`renderPdf` 從不啟動完整 Chrome），**映像實測 2.08 GB**（初版含完整 chromium 為 +2.61 GB，T7bR SF-2 收斂）；併裝 `fonts-noto-cjk` ＋ `/etc/fonts/local.conf` 強制 `sans-serif` 解析為 **Noto Sans CJK TC**（T7bR MF-1：僅安裝字型不足以使 Chromium 選中它）；啟動參數 `--no-sandbox --disable-dev-shm-usage`（D4 附帶批准②之安全取捨） |
| 儲存 | storage 抽象層 + env 指定路徑之持久化 volume（MVP 不做 S3） | 掛載至後端 |
| 測試 | Vitest（unit/integration）+ Playwright（E2E） | CI |

設定原則：環境差異（DB 連線、密碼、網域、儲存路徑、Cookie 屬性、HTTPS）一律由環境變數提供，程式不得寫死正式敏感資訊。

## 2. 容器拓撲

```
                       ┌─────────────────────────┐
   使用者瀏覽器 ──HTTPS──▶│  nginx (前端容器)         │
   (桌機/平板/手機)       │  - React SPA 靜態資產     │
                       │  - 反向代理 /api → 後端    │
                       └───────────┬─────────────┘
                                   │ 內部網路 (HTTP)
                                   ▼
                       ┌─────────────────────────┐
                       │  node (後端容器)          │
                       │  - Fastify API           │
                       │  - Prisma ORM            │
                       │  - Playwright PDF 渲染    │
                       │  - storage 抽象層         │
                       └──────┬──────────┬────────┘
                              │          │
                   Prisma 連線 │          │ 檔案讀寫
                              ▼          ▼
                   ┌──────────────┐  ┌────────────────────┐
                   │ PostgreSQL 16 │  │ 持久化 volume        │
                   │ (獨立容器/受管)│  │ (附件 + 正式 PDF)    │
                   └──────────────┘  └────────────────────┘
```

- 正式環境三服務（nginx 前端 / node 後端 / PostgreSQL）均部署於 Zeabur，DB 與附件使用 Zeabur 持久化 volume（ADR-0001，人類已確認）。
- 前端、後端、資料庫分別為獨立容器，可分開建置與部署（NFR-US-01..04）。
- 同源策略：瀏覽器僅面對前端網域，nginx 以 `/api` 反向代理至後端（Zeabur 私有網路）；Cookie Session 維持同源（SameSite=Lax），不引入 CORS（ADR-0001）。
- 附件與正式 PDF 保存於後端外掛的持久化 volume，容器重建不遺失（NFR-US-07）；透過 storage 抽象層存取，未來替換儲存後端只改設定不改業務邏輯。
- 本機以 Docker Compose 一次啟動三服務（NFR-US-06）；Zeabur 以三服務分離部署（NFR-US-01..05）。
- Session 為 Cookie（HttpOnly / SameSite；正式 Secure）；正式環境 HTTPS（NFR-US-11）。

## 3. 後端模組責任劃分

後端以功能模組（feature module）劃分，共用能力下沉為跨模組服務。以下為概念責任，非最終目錄結構。

| 模組 | 責任 | 主要 US |
|---|---|---|
| `auth` | 登入/登出、Session 建立與失效、Cookie、登入失敗鎖定、密碼雜湊與規則、強制/自行改密 | FE-US-01..03, BE-US-01, 04, NFR-US-08, 09, 11 |
| `authz` | 角色判斷、資料擁有權驗證、一般使用者資料隔離、管理員代操作權限（擁有人 vs 操作者） | BE-US-02, 03 |
| `users` | 使用者清單/新增/啟用停用/重設密碼/條件式刪除 | AD-US-01..05 |
| `users/fuel-consumption` | 使用者車輛油耗版本（油種 ＋ 每公升公里數 ＋ 依據備註）之建立與列表（管理員）、本人唯讀檢視；append-only（無改/刪端點），依 `effectiveFrom` 選版並複用 `parameters` 之 `checkNoOverlap`／`findEffectiveVersion`／`parseParameterDecimalField`；稽核 `USER_FUEL_CONSUMPTION_VERSION_CREATED`。**PHASE-005a 落地，落點 `backend/src/users/fuel-consumption-service.ts`／`fuel-consumption-routes.ts`**；路徑依 D7(a)：`POST\|GET /users/:userId/fuel-consumption`（管理員）＋ `GET /me/fuel-consumption`（恆為自己，結構上不存在他人識別值參數） | AD-US-15, FE-US-28, BE-US-19, 31 |
| `parameters` | 三類補助參數版本之建立/列表端點、不重疊驗證（退化為同類 `effectiveFrom` 唯一，PHASE-003a）、依日期查找純函式 `findEffectiveVersion`、折舊推導引擎（**PHASE-007 修訂段起**：`deriveAnnualDepreciation`＝每年折舊費用 2 位小數，為申請路徑之唯一推導來源；`deriveDepreciation`＝每公里單價 4 位小數**行為凍結**，僅供舊模型歷史快照與歷史參數版本之唯讀顯示，申請路徑**零呼叫**）、參數異動稽核（複用 `audit`／PHASE-002 `AuditLog`）；只增不改（無改/刪版本端點）以保引用保護。**PHASE-005a 起，油資由 `FuelPriceVersion`（按油種 `GASOLINE_92`／`GASOLINE_95`／`GASOLINE_98`／`DIESEL`）維護，端點 `POST\|GET /parameters/fuel-price`，落點 `fuel-price-service.ts`＋單價推導純函式 `fuel-price-engine.ts`；`FuelParameterVersion` 依 D1(a) 定案處置——表與歷史引用保留、`POST /parameters/fuel` 凍結（三身分皆 404、零寫入）、`GET /parameters/fuel` 保留唯讀（供稽核追溯與舊快照顯示）** | AD-US-11..13, BE-US-14, 19, 32 |
| `applications` | 申請共通：狀態機、草稿、綜合查詢（分頁/篩選/授權）、修正版、作廢、快照容器。**PHASE-006 起亦為保養實作之落點**（下列 `maintenance` 概念模組之程式落於 `backend/src/applications/`）：`maintenance-service.ts`（草稿 CRUD／預覽／完成流程編排）、`maintenance-calculation.ts`（分攤計算純函式）、`maintenance-blockers.ts`（完成阻擋碼純函式）。**PHASE-007 起亦為折舊實作之落點**（下列 `depreciation` 概念模組之程式同樣落於此目錄，四檔見該列）。**PHASE-009 落地（作廢與修正版）**，三個新檔：`void-reason.ts`（作廢原因驗證純函式——trim 後 1..500，含全形空白／Tab／換行）／`application-void.ts`（作廢編排：型別無關，只讀寫 `Application` 單列；`SELECT … FOR UPDATE` ＋ **READ COMMITTED**，刻意不用 `SERIALIZABLE`＋重試——單列寫入之列鎖已足以序列化併發雙作廢）／`application-revision.ts`（修正版複製：三型業務欄位逐欄複製 ＋ `supersedesId` ＋ 單一交易與列鎖，交易 `timeout: 60_000`／`maxWait: 10_000`）。**兩個新端點掛於既有 `routes.ts`**（`POST /applications/:id/void`、`POST /applications/:id/revision`），未另開 plugin；版本關聯之 DTO 投影 `withRevisionLinks` 亦於 `routes.ts` 並 export 供 `admin/routes.ts` 三個代建端點複用（同一 DTO 不因端點而異形） | FE-US-04, 05, 21, 25, 26, BE-US-05, 18, 20, 21, 22, 29 |
| `trips` | 差旅專屬：多段行程、里程驗證、差旅完成流程 | FE-US-07..12, BE-US-06, 07, 08, 09 |
| `maintenance` | 保養專屬：區間里程、期間公務里程、分攤、保養完成流程 | FE-US-13..16, BE-US-10..13 |
| `depreciation` | 折舊專屬：年度公務里程（引擎複用）、**使用者申報之年度總里程**、參數套用、補貼計算、折舊完成流程。**PHASE-007 落地，落點 `backend/src/applications/`**，四檔各司其職：`depreciation-calculation.ts`（補貼計算與容量判定純函式，無 DB／無 IO）、`depreciation-blockers.ts`（完成阻擋碼純函式，結構性／計算性兩段式）、`depreciation-parameters.ts`（依申請年度 1/1 選版 ＋ 呼叫 PHASE-003a `deriveAnnualDepreciation` 推導每年折舊費用；**修訂段起不再 import `deriveDepreciation`**）、`depreciation-service.ts`（草稿 CRUD／預覽／完成流程編排與快照寫入） | FE-US-17..20, BE-US-15, 16, 17 |
| `mileage`（統計） | 區間/年度公務里程統計引擎（共用給差旅統計、保養、折舊）。**PHASE-005 落地，落點 `backend/src/mileage/`**，三檔各司其職：`mileage-range.ts`（純函式：區間驗證 `parseMileageRange`、過濾條件建構 `buildOfficialMileageWhere`，不碰 DB、不知道「今天」）、`mileage-engine.ts`（唯讀 DB 聚合 `sumOfficialMileage`，簽章接受 `PrismaClient \| Prisma.TransactionClient`）、`routes.ts`（薄層編排：授權 → 結構收斂 → 驗證 → 引擎 → DTO，本身不含任何業務判定）。對外**僅一個唯讀端點**；對內提供 `sumOfficialMileage(db, params)` 供 `maintenance`／`depreciation` **於交易內複用**（不重算、不繞道 HTTP） | FE-US-06, BE-US-30 |
| `attachments` | storage 抽象、上傳/格式大小/內容檢測、數量限制、生命週期（暫存→關聯→鎖定→清理）、授權存取。**PHASE-009 落地 `backend/src/attachment/attachment-copy.ts`**：修正版之附件**位元組複製**（原圖與縮圖各自新 `storageKey`，逐位元組相同；容器對位＝差旅逐段、保養／折舊單一容器；沿既有「先 `put` 後 `INSERT`」順序，失敗時補償刪除已寫新 key 並讓整筆修正版交易回滾）。**本檔於交易客戶端（`Prisma.TransactionClient`）上直接 `create`**，未改 `attachment-service.ts` 之 `createAttachment` 簽章（其只收頂層 `PrismaClient`，改簽章會波及 PHASE-003 起既有呼叫端） | FE-US-21, BE-US-23, 24, 25, NFR-US-07, 10 |
| `reports` | 報表編號產生、列印版 HTML 組裝、Playwright PDF 產生/保存、安全檔名、授權下載。**PHASE-008 落地，落點 `backend/src/reports/`**，**九檔**各司其職：`report-number.ts`（編號純函式：三型前綴 ＋ Asia/Taipei `YYYYMM` ＋ 序號補零）／`report-filename.ts`（安全檔名純函式：不安全字元清理、姓名段 30／整體 120 上限、`Content-Disposition` 雙形式）／`report-data.ts`（**只讀快照**之封閉白名單組裝，零重算、零計算引擎呼叫）／`report-html.ts`（列印版版型**純函式**：零時鐘、零隨機、零外部資源）／`report-labels.ts`（**顯示標籤之單一來源**：油種中文名稱窮舉 `Record<FuelType, string>`、台北時區中文時間格式化——PHASE-008 Mock Gate 裁-1／裁-3）／`report-images.ts`（附件位元組 → 降尺寸／EXIF 轉正／**取小者** → data URI）／`pdf-renderer.ts`（Playwright 封裝：啟動參數、逾時、`%PDF-`／`%%EOF` 校驗、`preferCSSPageSize` A4）／`report-service.ts`（編排、交易、冪等、補償刪檔）／`routes.ts`（四端點：產生／列印／下載／查詢）。**九檔清單有結構性測試釘住**（新增或刪除 `.ts` 而未同步清單即紅）。**PHASE-009 之作廢版 PDF 亦落於本目錄且仍為九檔**——`prepareVoidedReport`／`VoidedReportPlan` 附加於 `report-service.ts` 既有產生流程**之後**（位置為約束非風格：既有結構斷言以 `renderReportHtml(` 之**首現位置**判定「配號早於渲染」，插入於前會在零行為缺陷下轉紅），**不得**新建 `reports/*.ts`；`routes.ts` 之四端點於 `VOIDED` 之行為見 §4.7 末三條 | FE-US-22..24, BE-US-26, 27, 28 |
| `audit` | 稽核事件寫入與查詢（操作者/擁有人/時間/類型/前後摘要；密碼不入）。**PHASE-010 落地（查詢面）**，落點 `backend/src/audit/` **四檔**：`audit.ts`（既有——`writeAudit` 寫入助手）／`audit-query.ts`（**純函式**：`parseAuditLogQuery` 篩選與分頁解析、`buildAuditLogWhere` 條件建構；零 DB、零 Prisma 型別相依）／`audit-summary.ts`（**純函式**：`flattenAuditSummary` 將 `AuditLog.summary` 之 JSON 攤平為 `changes[]`——**對外揭露面之單一事實來源**，零 import／零時鐘／零 I/O）／`routes.ts`（薄層編排：授權 → 解析 → `where` → DB 層分頁 ＋ 獨立 `count` → DTO 投影；獨立 `auditPlugin`，於 `server.ts` 註冊）。**寫入面 PHASE-010 零變更**（見 §4.8） | AD-US-14, BE-US-31 |
| `calculation engine` | 金額計算純函式：單段/整筆差旅、保養分攤、折舊補貼、統一四捨五入取整 | BE-US-06, 07, 12, 14, 17 |
| `platform` | 健康檢查、結構化錯誤處理、設定/env 載入、DB 連線。落點 `backend/src/platform/`：`errors.ts`（`AppError` ＋ `ErrorCode` 聯集 ＋ `buildErrorBody` **單一組裝點**）／`error-handler.ts`（四分支統一錯誤回應；**PHASE-010-T9 起，未預期例外之兜底分支不再記錄 `error.message` 原文**——見 §4.9）／`log-sanitize.ts`／`health.ts`／**`error-label.ts`（PHASE-010-T10 新增之葉節點**：零內容錯誤標籤 `errorLabel(err) = err.constructor.name`，**無任何專案內部相依**故可被任何層級 import 而不成環；現行呼叫端為 `attachment/attachment-copy.ts` 與 `attachment/upload-service.ts` 共 **4 處**） | NFR-US-15, 16, 05 |

模組依賴方向（高階）：`trips/maintenance/depreciation` → `applications`（狀態/草稿/查詢）+ `calculation engine` + `parameters` + `mileage` + `attachments`；所有受保護模組 → `auth` + `authz`；寫入操作 → `audit`。

**PHASE-009 新增之兩條依賴（記載，非既有方向之推翻）**：

- `attachment` → `applications`：`attachment/attachment-copy.ts` **import** `applications/application-revision.ts` 之 `createApplicationRevision`，以其既有 hook `OnApplicationRevisionCreated` 掛入**同一交易**（AC-14(e) 之「整筆回滾」唯有同一交易成立）。此為既有「`applications` → `attachments`」之**反向**依賴，故明文記載：對位規則屬附件域、交易擁有權屬申請域，本檔是兩域的接縫，**不得**再由 `applications/` 反向 import 本檔（會成環）。
- `applications` → `reports`：`applications/routes.ts` 之作廢端點 import `reports/report-service.ts` 之 `prepareVoidedReport`／`ReportGenerationError`。方向為單向——`reports/` 對 `applications/` 維持**零依賴**（`VoidedReportPlan.onVoided` 之參數型別刻意只宣告實際讀取的兩個欄位，而非 import 申請域型別）。

## 4. 共用元件與跨模組規則

### 4.1 Calculation Engine（金額計算唯一權威）

- 純函式、無副作用，供各申請類型呼叫；後端為金額與里程計算的唯一權威，**不得採用前端提交的金額**（BE-US-06/07/12/17 各有明列）。
- 統一四捨五入：小數 <0.5 捨去、≥0.5 進位，非銀行家取整；最終申報金額為新臺幣整數（共通取整規則）。
- 差旅：單段 = round(總里程×油資單價 + 高速里程×ETC 單價)（先相加再取整）；整筆 = Σ 各段取整金額；總里程 = Σ 各段總里程，**不重複加高速里程**。
- **油資每公里單價為推導值（PHASE-005a，已落地）**：`油資單價 = ROUND_HALF_UP(每公升油價 ÷ 車輛油耗, 0)`（元／km，整數；`deriveFuelUnitPrice` 純函式）。每公升油價取自 `FuelPriceVersion`（依**擁有人油種** ＋ 出差日期選版），油耗取自 `UserFuelConsumptionVersion`（依**擁有人** ＋ 出差日期選版）。**差旅金額路徑之取整恰兩處**——① 推導每公里單價、② 段金額——**不得新增第三處**。推導商 < 0.5 時單價為 0（合法結果，非錯誤）；推導值或金額超出目標欄位容量時以可行動 4xx 拒絕（D4(a)），**絕不 500、絕不靜默截斷**。
- 保養：區間里程 = 本次里程表 − 上次里程表；比例 = 期間公務里程 ÷ 區間里程（>100% 阻擋）；分攤 = round(實際費用 × 比例)（整筆一次取整）。
- **保養分攤之計算式與取整層級（PHASE-006 D4(a)，已落地）**：分攤 ＝ `ROUND_HALF_UP(實際費用 × 期間公務里程 ÷ 保養區間里程, 0)`；**計算過程不得先取整比例或任何中間值**（快照之 `ratio` 6 位小數與 `ratioPercent` 僅供顯示與快照，**不參與**金額計算）；**全案取整恰一處**（此處），不得新增第二處。>100% 之阻擋判定必須以 `Decimal` 直接比較「期間公務里程」與「區間里程」（`O == I` 為合法、允許完成），**不得**以取整後之比例比較。
- 折舊：每年折舊費用 = 車價 ÷ 年限；公務比例 = 年度公務里程 ÷ **該車年度總里程**（使用者申報）；補貼 = round(每年折舊費用 × 年度公務里程 ÷ 年度總里程)（整筆一次取整）。
- **折舊補貼之計算式與取整層級（PHASE-007 折舊模型修訂段，人類 2026-08-05 批准；已落地）**：補貼 ＝ `ROUND_HALF_UP(每年折舊費用 × 年度公務里程 ÷ 年度總里程, 0)`——**先乘後除**（`annualDepreciation.times(officialKm).div(annualTotalKm)`），每年折舊費用一律取自 PHASE-003a 引擎之 `deriveAnnualDepreciation` 回傳之 2 位小數字串並以 `Prisma.Decimal(字串)` 還原（**不得**經 `Number()`／`parseFloat`），**不得於本層重算或再次取整該費用**。**本 Phase 之取整恰一處**（最終金額；每年費用之 2 位小數取整屬 PHASE-003a 引擎契約），**不得**先取整比例、**不得**先取整年度公務里程、**不得**先將取整前金額 `rawAmount` 收斂至 2 位小數再取整，亦**不得**以 `每年折舊費用 × 比例` 求 `rawAmount`（引入第二次捨入）。比例之 6 位小數／百分比 4 位小數字串**僅供顯示與快照，不回流計算**（同保養既有紀律）；`年度總里程 ≤ 0` 或任一輸入非有限值 → `calculable=false`、其餘欄位一律 `null`（**絕不**除以零、**絕不**回傳 `NaN`／看似合法的 `0`）。比例 >100%（年度公務里程 > 年度總里程）**擋完成**、恰等於 100% **允許完成**，判定一律以兩里程之 `Decimal` 直接比較，**不得**以取整後之比例比較（同保養既有紀律）。落點 `backend/src/applications/depreciation-calculation.ts`。
- **折舊推導精度定案（PHASE-003a D3；修訂段之適用範圍已分流）**：折舊參數建立時之推導值，每年折舊費用以 `Decimal` 保留 2 位小數、每公里補助單價以 `Decimal` 保留 4 位小數；取整採一般四捨五入（0.5 進位，ROUND_HALF_UP，非銀行家取整）。`perKmUnitPrice` 以**未先取整**之每年費用為分子計算（round-late，減少累積誤差）。**自 PHASE-007 修訂段起**：申請路徑一律以 2 位小數之**每年折舊費用**為金額來源；**「補貼以 4 位小數 `perKmUnitPrice` 為準」之舊條款，其適用範圍限縮為舊模型歷史快照**（`snapshotPerKmUnitPrice != null` 且 `snapshotAnnualTotalKm == null` 之已完成申請）**與歷史參數版本之唯讀顯示**，該類資料一律原值呈現、**絕不重算**。

### 4.2 Parameter 版本查找

- 三類參數皆為「版本 + 生效日期」；有效期間不得重疊（`parameters` 模組建立時驗證，BE-US-19）。
- 差旅依**出差日期**選有效油資/ETC 版本（BE-US-09）；折舊依**申請年度 1/1**選有效折舊版本（BE-US-16），年度中途新版本不影響當年計算。
- 版本被歷史已完成申請引用後其內容不可覆寫；歷史金額由快照保證不變（見 4.4）。
- **有效期間表示法定案（PHASE-003a D2 方案 A）**：三類參數僅持久化 `effectiveFrom`（`@db.Date` 日粒度，含當日），有效期間結束為「同類下一版生效日前一日」隱含推導，最後一版開放至無限未來；時間線連續不留空窗。因結束由下一版隱含界定，「不重疊」約束退化為「同類 `effectiveFrom` 唯一」。
- **依日期查找為後端純函式 `findEffectiveVersion(type, date)`**（不依賴 DB 狀態的判定，`parameters` 模組提供）：取同類中 `effectiveFrom ≤ 查詢日` 之最大者為該日唯一有效版本；查詢日早於最早版本則回「查無有效版本」（供下游判斷缺參數）。此引擎已由 PHASE-004／005a（差旅以出差日呼叫）與 **PHASE-007（折舊以申請年度 1/1 呼叫，已落地）**複用。
- **選版一律走純函式（PHASE-007 AC-15，已落地；沿 PHASE-005a 既有紀律）**：折舊與差旅皆「該類**全部版本** `findMany` 後交由 `findEffectiveVersion` 選版」，**不得**在 DB 層以 `effectiveFrom: { lte 查詢日 }` 先過濾（避免與 PHASE-003a 之日粒度語意分歧、造成兩處選版規則不一致）。版本數為個位數量級，一次全取無效能疑慮。
- **折舊參數之縮欄（凍結式；PHASE-007 修訂段，已落地）**：**新版本只需車價 ＋ 折舊年限**（＋生效日期）。`estimatedAnnualKm`（預估年度行駛公里數）**保留欄位並轉 nullable**——建立端點不再解析、不驗證、不持久化該欄（**夾帶不採用，不回 400**），故新版本該欄恆為 `NULL`；**歷史版本原值一律保留不動**。查詢與建立回應之 `estimatedAnnualKm` 與 `derived.perKmUnitPrice` 對**歷史版本**回原值（唯讀），對**新版本**一律 `null`（刻意為 `null` 而非 `0`／哨兵值，使兩者可被區分、避免假值外洩）。`deriveDepreciation`（每公里單價引擎）**行為凍結**：函式與其既有測試零改動，但**申請路徑零呼叫**；`deriveAnnualDepreciation` 與其共用同一份內部推導，兩者之每年折舊費用逐位元一致。凍結式處置沿 PHASE-005a `FuelParameterVersion` 之既有先例（表與歷史引用保留、寫入面退場）。

### 4.3 申請狀態機

- 狀態：草稿 / 已完成 / 已作廢。允許：新建→草稿、草稿→已完成、草稿→刪除、已完成→已作廢、已完成→建立修正版草稿。禁止：已完成→草稿、已作廢→已完成、已作廢→草稿、已完成永久刪除。
- 由 `applications` 模組集中守門，各申請類型共用（BE-US-05）。完成需通過各類型完整性驗證。
- **已落地（PHASE-009，取代上二條之規劃語氣）**：`application-state-machine.ts` 之 `ALLOWED_TRANSITIONS` **恰兩條**——`DRAFT → COMPLETED`（PHASE-004）與 `COMPLETED → VOIDED`（PHASE-009）。長度以 `ALLOWED_TRANSITIONS.length === 2` 之測試釘住，任何再放寬須先經 Gate 決策批准並於該檔加註引用。
- **`VOIDED` 為終態，無任何回復路徑（結構性守門）**：`VOIDED → COMPLETED`／`VOIDED → DRAFT`／`VOIDED → VOIDED` 皆不在集合內而被 `assertTransition` 拒絕（403 FORBIDDEN，逐字文案「已完成的申請不可修改，請建立修正版」）；「回復」不是被某段條件式擋下，而是**集合裡沒有那條邊**。
- **「已完成→建立修正版草稿」不是狀態轉換**：修正版為**新建**一列 `Application`（`DRAFT`），原列狀態逐字不變；兩者以 `Application.supersedesId`（`@unique`）單向連結，故不經 `ALLOWED_TRANSITIONS`。「原申請已有修正版」之重複建立由 `FOR UPDATE` 列鎖 ＋ `supersededBy` 守門攔為 409，`supersedesId @unique` 為最後防線（`P2002` 轉譯為同形狀 409，避免同一使用者情境時而 409 時而 500）。

### 4.4 計算快照（不可變）

- 申請完成時保存「使用的參數 + 取整前後金額」快照（差旅：油資/ETC 單價、取整前後金額；保養：區間里程/公務里程/比例/實際費用/最終金額；**折舊（修訂後）：車價/年限/每年折舊費用/年度公務里程/年度總里程/公務比例/取整前後金額**）（BE-US-18）。
- 快照一旦寫入不可變；事後修改參數不影響歷史申請與已保存 PDF（AD-US-11/13、FE-US-20、BE-US-09/16 一致）。
- **作廢不改寫任何金額或快照（PHASE-009）**：作廢只寫 `Application` 之 `status` ＋ 三個作廢欄，`totalAmount`、`completedAt` 與三型子表之全部快照欄**逐欄不變**（有整合測試逐欄比對）。已作廢申請之詳情因而仍能呈現「作廢當時金額」＝完成時快照之最終整筆金額（`VoidInfoDto.totalAmount`，三型共用同一投影）。
- **保養快照之落地形狀（PHASE-006，D11(a)）**：`MaintenanceApplication` 另存**取整前金額 `snapshotRawAmount`** 與 `calculatedAt`（連同 `snapshotIntervalKm`／`snapshotOfficialKm`／`snapshotRatio` 共五個快照欄位）；**實際費用之快照即 `actualCost` 欄位本身**（完成後由狀態機凍結，**不另存冗餘副本**）；最終金額落於既有 `Application.totalAmount`（`Int`），不重複持久化。
- **折舊快照之落地形狀（PHASE-007 修訂段，已落地）**：`DepreciationApplication` 存**九個快照欄**——`snapshotVehiclePrice`（`Decimal(12,2)`）／`snapshotUsefulLifeYears`（`Int`）／`snapshotAnnualDepreciation`（`Decimal(12,2)`，每年折舊費用 2 位小數之來源值）／`snapshotOfficialKm`（`Decimal(12,2)`，年度公務里程）／`snapshotAnnualTotalKm`（`Decimal(9,1)`，年度總里程）／`snapshotRatio`（`Decimal(9,6)`，公務比例）／`snapshotRawAmount`（`Decimal(14,4)`，取整前金額）／`calculatedAt` ／`depreciationParameterVersionId`（版本引用，供 `parameterHasReferences` 與稽核追溯）；最終金額同樣落於既有 `Application.totalAmount`（`Int`），不重複持久化。九欄一律**顯式定精度**後寫入（`toFixed(scale)` 再以字串建構 `Decimal`），不依賴 DB 之靜默捨入。
- **折舊快照之凍結唯讀二欄與新舊模型判別（PHASE-007 修訂段）**：`snapshotEstimatedAnnualKm`（`Int?`）與 `snapshotPerKmUnitPrice`（`Decimal(14,4)`）為**舊模型欄，保留但不再寫入**——新模型列一律明文寫 `null`（**絕不**以 0 或任何佔位值填充）。**判別欄為 `snapshotAnnualTotalKm`**：`!= null` ⇒ 新模型；`snapshotPerKmUnitPrice != null` 且 `snapshotAnnualTotalKm == null` ⇒ 舊模型（原值唯讀呈現、**零重算**）；兩者皆 `null` ⇒ 草稿。此判別與 PHASE-005a 之 `fuelPriceVersionId` 判別為同型義務。`parameterHasReferences("DEPRECIATION")` 依 `depreciationParameterVersionId` 判定，**兩模型皆適用、零變更**。
- **折舊快照之揭露面（修訂後，見 §4.11）**：`snapshotVehiclePrice`／`snapshotUsefulLifeYears`／`snapshotEstimatedAnnualKm` 與版本 id **持久化但不出現於任何折舊 DTO**（草稿／預覽／快照皆然）；每年折舊費用、年度總里程與公務比例則**隨 DTO 對外呈現**。

### 4.5 附件生命週期與授權存取

- 生命週期：上傳→暫存標示→關聯草稿→（完成時）鎖定→被引用則保護、暫存 >24h 無引用可清理（BE-US-25）。
- 授權存取：任何附件內容存取須先通過擁有權/角色驗證（`authz`），未登入或非擁有者不得取得（NFR-US-10, BE-US-02）。數量與格式/大小/內容檢測由 `attachments` 統一（BE-US-23/24）。
- **附件內容一律經後端授權端點回傳；持久化 volume 不得由 nginx 靜態直出對外（否則繞過授權，違反 NFR-US-10）**。storage key 由系統產生、不含使用者輸入，杜絕路徑穿越與列舉取檔。（修訂 2026-08-01，SPEC-003 決策點 D7；PHASE-003 拓撲約束，待人類批准 Spec 後生效。）
- 附件對申請容器於 PHASE-003 採**弱關聯**（refType+refId，避免提前建立申請表）；「完成鎖定」語意權威在申請狀態機，附件不冗餘持久化 locked。（修訂 2026-08-01，SPEC-003 決策點 D1/D2。）
- **`deriveContainerState` 支援 `refType=MAINTENANCE`（PHASE-006 D2(a)，已落地）**：自 PHASE-006 起，保養附件之容器狀態經 `MaintenanceApplication → Application.status` 推導（`refId` ＝ `Application.id` ＝ `MaintenanceApplication.applicationId`），已完成保養之證明附件即受鎖定保護（BE-US-25 第 4 條）；`deleteApplication` 於刪除保養草稿時一併 detach 其 `MAINTENANCE` 附件，避免孤兒 `LINKED` 附件。維持上列「弱關聯 ＋ 不冗餘持久化 locked」之既有定案（未改為強 FK、未新增 locked 旗標）。
- **storage 抽象之封閉前綴白名單（PHASE-008 D6(a)，已落地）**：`LocalVolumeStorage` 改為**可設定之封閉前綴集合**，全案僅有**兩個實例**——附件實例（`att`）與報表實例（`rpt`），各自掛載獨立 volume。**跨實例互拒**：附件實例拒 `rpt/` 金鑰、報表實例拒 `att/` 金鑰（`server.ts` 對兩實例皆明寫 `{ prefixes: [...] }`，有結構性斷言釘住）；未指定選項時預設仍為 `["att"]`，**既有附件行為零改動**。前綴比對之字面 `.` 不得被當作正則萬用字元（`escapeRegExp` 守門）。路徑穿越矩陣（21 列）對 `rpt` 前綴重跑全數拒絕。
- **兩實例由 `server.ts` 建構並跨 plugin 共用（PHASE-009 落地）**：報表 storage 之 root 解析區塊由原本的「`reportsPlugin` 註冊前」**前移至 `applicationsPlugin` 註冊之前**——作廢端點需同一份報表 storage 寫入作廢版 PDF。前移**只改建構時機**，不改解析優先序（`options.reportStorageRoot` ＞ env `REPORT_STORAGE_ROOT` ＞ production fail-fast ＞ 非 production 動態 tmpdir）、不改 production fail-fast 形狀、不改 `{ prefixes: ["rpt"] }` 之字面。`applicationsPlugin` 與 `reportsPlugin` 拿到的是**同一個** `LocalVolumeStorage` 實例（附件實例亦然）；**不得**為第二個消費者另建實例——storage root 之解析是 `server.ts` 的單一事實來源，兩份一旦分歧即出現「作廢端點寫進 A、下載端點讀 B」的靜默資料錯置。
- **`rpt/` 之兩種物件（PHASE-009）**：正式版 `rpt/<uuid>/pdf` 與作廢版 `rpt/<uuid>/void`。作廢版後綴取 `void` 而**非** `void.pdf`——`LocalVolumeStorage` 之 key 白名單為 `^(?:rpt)\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$`，後綴不接受 `.`。兩者結構上互異，`storageKey` 恆不外流（`ReportDto` 不含此欄）。
- **正式 PDF 沿用附件之同一紀律（PHASE-008）**：PDF **一律經授權端點回傳**，volume **不得由 nginx 靜態直出**——此為上一條既有紀律之延伸，並新增**結構性守門**：以解析 `nginx.conf` 之 `location`／`server` 區塊斷言無任何 `root`／`alias` 指向 storage／report volume 路徑（含裸 `root`、帶正則或前綴修飾子之 `location`、`if` 巢狀大括號三種繞過型態之鑑別力自證）。`storageKey` 由系統產生、不含使用者輸入。
- **`deriveContainerState` 支援 `refType=DEPRECIATION`（PHASE-007 D10(a)，已落地）**：折舊證明附件之容器狀態直接經 `Application.status` 推導（`refId` ＝ `Application.id` ＝ `DepreciationApplication.applicationId`），已完成折舊之證明附件即受鎖定保護（BE-US-25 第 4 條）；容器不存在（孤兒）時視為 `'draft'` 並記警告日誌。`deleteApplication`（generic 端點）於刪除折舊草稿時一併 detach 其 `DEPRECIATION` 附件，避免永遠停在 `LINKED`、清理排程掃不到的孤兒。同樣維持弱關聯定案，未新增 locked 旗標。**PHASE-007 修訂段（已落地）：折舊證明改為「選填」**——零附件之草稿可完成（完成端點不再計數附件、`DEPRECIATION_ATTACHMENT_REQUIRED` 已退場），但**上限 5 張、完成鎖定與 detach 語意一律不變**（本列其餘敘述零變更）。

### 4.6 綜合查詢與資料隔離

- `applications` 提供分頁/篩選/關鍵字綜合查詢，預設近一年；授權層強制一般使用者只見自己資料，管理員可指定使用者；一般使用者自帶他人識別值不得越權（BE-US-29, BE-US-02）。
- **統計查詢與綜合查詢分屬不同端點（PHASE-005 D4(a) 定案）**：統計為單一端點 + `ownerId` 參數（個人與管理員共用同一路徑），**不分頁**——無 `page`／`pageSize`，一次聚合完整區間；綜合查詢維持分頁。統計端點之日期起訖**皆為必填**（PHASE-005 D5(a)），刻意不沿用綜合查詢「未指定即預設近一年」的預設值，以免使用者把近一年數字誤讀為全期間。
- **`resolveOwnerId(actor, ownerId)` 為兩者共用之授權判定**（實作單一份，落於 `applications` 模組，統計端點直接複用、**不重寫**）：未帶或帶自己 → 自己；一般使用者帶他人 → 403，**不靜默降級為自己**；管理員得指定任一擁有人。任何新增之「可指定擁有人」查詢一律沿用此函式。

### 4.7 報表與 PDF

- 報表編號：TRV/MNT/DEP 前綴 + 月內唯一 + 對同一版本冪等（BE-US-26）。
- 列印版 HTML 與正式 PDF **同一版型**；Playwright 以該 HTML 產生 PDF 並保存；產生/保存失敗不得標示成功（BE-US-27）。安全檔名移除不安全字元（BE-US-28）。
- **編號格式（PHASE-008 D2(a) 定案，已落地）**：`{PREFIX}-{YYYYMM}-{NNNN}`，**月份依 Asia/Taipei**（固定 +08:00，無日光節約；以固定偏移換算後一律 `getUTC*` 讀出，不受執行主機時區影響）；序號補零 4 位，`≥10000` 自然延伸為 5 位（不截斷、不歸零）。
- **冪等與併發（PHASE-008 D3 修訂後定案，已落地）**：冪等鍵為 **`Report.applicationId` 唯一**；併發以「**`READ COMMITTED`（本交易限定）＋ `(numberPrefix, numberPeriod)` 交易級顧問鎖排隊（主防線）** ＋ `max(sequence)+1` ＋ 三欄唯一約束 ＋ `P2002` 重試（最後防線）」保證。**顧問鎖為交易首語句**——早於冪等再查與配號（`READ COMMITTED` 下鎖外查詢讀不到前位剛提交之列，順序不可對調）；不同 `(prefix, period)` 組互不阻擋（鎖鍵為該二欄之穩定雜湊，非共用常數）。**隔離等級之變更僅限本交易**，不改全域設定或連線層預設。
- **交易形狀（D3 修訂後）**：**配號與帶編號渲染同在一個交易內，序號僅於提交時落庫（回滾天然不燒號）**——單一交易內依序為「顧問鎖 → 冪等再查 → 配號 → **帶編號渲染** → `put` → 讀回校驗 → `INSERT`」；**配號早於渲染**是列印版與 PDF 得以 wire 層字串全等（BE-US-27／同一版型）之結構前提。
- **PDF 產生失敗一律零殘留（列與檔同生共死）**：四個失敗階段（`RENDER`／`STORE`／`VERIFY`／`PERSIST`）皆回 `500 REPORT_GENERATION_FAILED` 並攜 `details.stage`，交易回滾 ＋ 已寫入之檔案補償刪除，**零 `Report` 列、零 storage 檔、申請快照逐欄不變**。
- **報表為不可變產物**：本 Phase **不存在**更新或刪除 `Report` 之程式路徑（以結構性掃描斷言 `report.update`／`delete`／`upsert`／`updateMany`／`deleteMany` 於 `reports/` 零出現）；內容有誤只能走 PHASE-009 之修正版（新 `Application` → 新編號、新 PDF，原報表位元組不被觸碰）。
- **PHASE-009 落地後此性質**（D4(b1) 之落地形狀）**：`Report` 仍為零更新路徑**——上述結構性掃描於 PHASE-009 後**零改動且全綠**（該掃描讀原始碼字串而不剝除註解，故 `reports/` 內連註解與 JSDoc 都不得出現那三個呼叫字面）。作廢版 PDF 以**獨立之 `VoidedReportFile`** 承載（每個 `Report` 至多一份，冪等鍵 `reportId @unique`），`reports/` 對此新表只有 `voidedReportFile.create(` **一處**寫入；**原 PDF 之位元組永不被觸碰**，原 `Report` 列之編號／檔名／雜湊／產生時間亦逐欄不變。
- **作廢版 PDF 之產生（PHASE-009，交易內四階段）**：渲染 → `put` → 讀回校驗 → `INSERT VoidedReportFile`，掛在**作廢交易**（擁有者為 `applications/application-void.ts`）之內，任一階段失敗即整筆作廢回滾、狀態仍為 `COMPLETED`。失敗階段沿用既有四值 `RENDER`／`STORE`／`VERIFY`／`PERSIST`，回應 500 `REPORT_GENERATION_FAILED` ＋ `details.stage`。**雙層補償**：內層（`onVoided` 自身失敗，於拋出前先補償刪檔）＋ 外層（呼叫端於 `voidApplication` 拋錯時 `plan.compensate()`，涵蓋稽核 hook 拋錯與 commit 失敗）；成功路徑**永不**呼叫補償。**未產生報表之申請**整段流程不執行（零渲染、零 storage 寫入），作廢為純 DB 操作。
- **作廢後之四端點行為（PHASE-009）**：`GET …/report/print` 之狀態守門由 `COMPLETED` 單值放行為 **`COMPLETED ∪ VOIDED`**（白名單），列印版首屏渲染 `.void-banner`；`GET …/report/pdf` 於 `VOIDED` 且 `VoidedReportFile` 在場時回**作廢版位元組**、否則回原檔（**內容選擇而非守門**，兩分支皆純讀取、零渲染，狀態碼恆 200；ASCII fallback 檔名恆取自 `Report.reportNumber`，作廢不產生新編號）；`POST …/report`（產生）之守門**維持 `COMPLETED` 單值**（`VOIDED` → 409，已作廢申請不得產生新報表），與列印端點之守門字面**刻意不同**；`GET …/report`（查詢）維持零狀態讀取，`VOIDED` 亦回既有中繼資料。

### 4.8 稽核

- 重要操作（帳號新增/停用/密碼重設/代操作/作廢/參數異動）寫稽核，含操作者/擁有人/時間/類型/前後摘要；**密碼與敏感憑證不入稽核與日誌**（BE-US-31, NFR-US-16）。
- **作廢稽核定案（PHASE-009 D10(a)，已落地）**：`AuditAction` enum 新增**單一值 `APPLICATION_VOIDED`**（enum 由九值增為十值）。**本人與管理員皆寫**——與三型 PUT 之 `APPLICATION_UPDATED_ON_BEHALF` 不同，本 hook 恆傳入、不以 `actorId !== ownerId` 分野（BE-US-31② 逐字「使用者**或**管理員作廢申請 → 應記錄作廢原因、操作者及時間」；與 PHASE-004「本人自建草稿不寫稽核」之差異為刻意）。稽核 `INSERT` 於作廢之**同一交易**內、四欄寫入之後執行：hook 拋錯即連同狀態變更一併回滾（零孤兒稽核列、零狀態變更）。`summary` 為封閉四鍵並含**作廢原因**；`voidedById`／`ownerId` 等內部識別值刻意不入 `summary`（操作者已由 `actorId` 欄承載）。
- **修正版之稽核（PHASE-009）**：沿用既有 `APPLICATION_CREATED_ON_BEHALF`，**不新增第二個 enum 值**；僅代操作（管理員為他人建立）時寫入，與既有代建端點同一紀律。
- **參數建立稽核定案（PHASE-003a D6）**：三類參數版本建立之稽核**複用 PHASE-002 `AuditLog`** 機制（不另起爐灶）；`AuditAction` enum 新增**單一值 `PARAMETER_VERSION_CREATED`**，以 `summary.parameterType`（`FUEL`／`ETC`／`DEPRECIATION`）區分三類，`summary` 存重要設定摘要（單價或車價/年限/年里程 + `effectiveFrom`），不含密碼與敏感憑證。
- **`AuditAction` enum 之收斂議題已結案（PHASE-010 §16 D8(a)，人類 2026-08-09 Spec Gate）**：維持現有 **10 值**，PHASE-010 **零 migration**；「修正版 vs 一般代建立」之區分由 `summary.revisionOf` 承載，不另立 enum 值；「報表產生」從未被 US 列為須稽核之事件。**此案結案，後續 Phase 不再逐期重議**（自 PHASE-008 D15 起延宕兩期之議題於此收束）；未來若 US 新增事件再議。

#### 稽核**寫入**之兩種交易語意（PHASE-010 §16 D11(a) 明文記載，人類 2026-08-09 明示接受）

| 語意 | 適用事件 | 形狀 | 失敗後果 |
|---|---|---|---|
| **同交易** | 參數版本建立（PHASE-003a 起）／代操作三型／作廢／油耗版本建立等 | 業務寫入與 `tx.auditLog.create` 同一交易，hook 於業務寫入之後執行 | hook 拋錯即**整筆回滾**——零孤兒稽核列、零狀態變更 |
| **fire-and-forget** | **帳號類五事件**（`USER_CREATED`／`USER_DEACTIVATED`／`USER_ACTIVATED`／`USER_PASSWORD_RESET`／`USER_DELETED`，PHASE-002 起） | 業務交易 COMMIT 後，`writeAudit` 以**獨立連線**寫入；失敗僅 `console.error` | 業務操作已生效而稽核列**可能靜默遺失**（今日無觀測到之實例，屬結構性可能） |

  此不對稱為 PHASE-002 之既有形狀，PHASE-010 **明示不改**（D11(a)）；可靠性議題（是否改為同交易、或補投遞保證）移交 PHASE-011，見 `docs/KNOWN_ISSUES.md` §5。**新增稽核寫入站點時須自覺選邊**：涉及授權／不可逆操作者應採同交易。稽核寫入站點之集合由 `phase10-audit-structure.test.ts` 之**白名單掃描**釘住（現行 **5 檔／13 個 `auditLog.create(` 呼叫**），新增或移除檔案即紅。

#### 稽核**檢視**（PHASE-010 落地；唯一之新讀取路徑）

- **端點**：`GET /admin/audit-logs`（唯讀、分頁、篩選），落於獨立之 `backend/src/audit/routes.ts` ＋ `auditPlugin`。**管理員 only**（D4(a)）——一般使用者含資料擁有人本人一律 `403`，**嚴於**申請端點之「擁有人或管理員」；授權（`requireAuth` → `requirePasswordChanged` → `requireAdmin` 三段既有 `preHandler`）**恆早於**參數解析與任何 DB 查詢，故非管理員送出畸形參數得 `403` 而非 `400`（側信道測試守門）。
- **端點零寫入**：查詢不產生自身之稽核列（呼叫前後 `AuditLog`／`User`／`Application` 三表逐欄不變，有測試釘住）。
- **投影之單一事實來源**：`AuditLog.summary`（`Json?`）之對外形式**只由 `audit-summary.ts` 之 `flattenAuditSummary` 一處決定**，輸出 `changes: Array<{ field, before, after }>`。其形狀分派為三層（`summary` 級之巢狀前後版本逐子鍵拆列 → 頂層之 `{before,after}`／`{from,to}` 兩鍵物件拆欄 → 其餘一律字串化入 `after`），並以**鍵守恆之集合相等**斷言封閉（刪頂層鍵或刪子鍵之 mutant 皆必紅）。**攤平不擴大揭露面**——輸出恰為同一 `summary` 之既有值，僅呈現形式改變。
- **內部識別值不外露**：列 DTO 恰七鍵（`id`／`action`／`createdAt`／`actorDisplayName`／`targetLabel`／`targetDisplayName`／`changes`），**不含 `actorId`／`targetId`**（沿 PHASE-009 §6.3 既有紀律）。連帶後果：前端之操作者／對象篩選必須是**使用者下拉**（顯示名稱為選項文字、id 為送出值、清單複用既有使用者清單 API），不能是純文字 id 輸入——使用者無從得知可輸入之值。
- **wire 面與呈現層之邊界（MG-3 裁定，人類 2026-08-10）**：`targetLabel`（`loginName#<id>`／`FUEL_PRICE#<id>` 等快照字串）與 `changes[]` 之 `applicationId`／`revisionOf` 於 **wire 與 DB 完整保留**（追查用）；**畫面不呈現**——`targetLabel` 只顯示第一個 `#` 前段、該兩欄之明細列整列不渲染。**兩者為不同層次**：不得以「畫面不顯示」為由縮減 wire 值，亦不得在畫面回填內部識別碼。
- **不可變性**：`backend/src` 全域對 `auditLog` 之 `update`／`updateMany`／`delete`／`deleteMany`／`upsert` **零呼叫**（結構性掃描守門，插入任一該類呼叫之 mutant 必紅）——稽核為 append-only。
- **時間**：後端一律回 **ISO 8601 UTC**（機器可讀之單一真值），在地化屬呈現層。**日期篩選之日界為台灣（UTC+8）日曆日**（固定 +8h，不引入時區資料庫）；**畫面顯示則沿用瀏覽器時區**（與前端既有 8 個格式化落點一致）——兩者對非台灣時區之使用者會不一致，此為 2026-08-09 兩項裁定並存之**已明示接受**後果，見 `docs/specs/PHASE-010.md` §17.1 #10／#11。

### 4.9 結構化錯誤處理

- 統一錯誤回應：前端可辨識欄位與原因；不外洩堆疊、DB 結構或敏感資訊；伺服器日誌含追查識別但不含密碼/憑證（NFR-US-16）。
- **錯誤回應之組裝點唯一（PHASE-010-T10／AC-22(a)，已落地）**：一切錯誤回應皆經 `platform/errors.ts` 之 `buildErrorBody` 由 `error-handler` 統一組出；**業務路由不得自行呼叫 `buildErrorBody` 繞道**（全案呼叫端已歸零，僅存 `error-handler.ts` 內部與定義本身）。`applications/routes.ts` 之 `REPORT_GENERATION_FAILED` 為最後一處繞道，已改經 `AppError` 承載——**wire 輸出逐位元組不變**（含鍵序），並有「不得回退為繞道」之結構性守門。
- **未預期例外之兜底日誌不記例外原文（PHASE-010-T9／AC-21，已落地；診斷取捨已明示接受）**：`error-handler` 之第四分支（未預期例外）記**固定分類標籤 `UNEXPECTED_EXCEPTION` ＋ `error.name`**，**不記 `error.message`**——根因是 `sanitizeForLog` 只遮蔽連線字串與 `password=` 形式之憑證，**不遮蔽絕對路徑與 storage key**，而 storage／fs／Chromium 之錯誤訊息逐字含之。`requestId` 為唯一關聯手段（日誌與回應同值）。**wire 面零變更**（`500` body 逐位元組不變）。
  - **取捨與紀律**：線上排障之正解為**各服務層之具名日誌**（各 `catch` 自記 `{ stage, id }` 一類零內容標籤 ＋ `requestId`），**不得**以排障不便為由回退兜底記原文——回退會使反向探針與站點白名單掃描同時失效（PHASE-011 RUNBOOK 須載明）。
  - **守門形狀**：兩層站點白名單掃描（L1＝「直接送入 `log.*`／`console.*` 或回應 `details`」之 AC 字面面；L2＝全域錯誤訊息取值之保守超集，承接變數間接型）＋絕對路徑注入之反向探針。**已知不可及之型別已據實記載**（pino `log.error({ err })` 之序列化型、參數位解構），以**記載型反向 `it`** 固化，日後補上掃描能力時會顯性翻紅；見 `docs/KNOWN_ISSUES.md` §3 D-9。
- **零內容錯誤標籤之單一來源**：需要在日誌中標示「發生了哪一類錯誤」時，一律用 `platform/error-label.ts` 之 `errorLabel`（取 `err.constructor.name`），**不記訊息**。**與 `errName: err.name` 慣例刻意不合併**——兩者對未自訂 `name` 之 `Error` 子類回傳相異值，合併即為行為變更（`health.ts`／`error-handler.ts` 維持 `err.name`）。

### 4.10 里程統計精度與引擎複用（PHASE-005 定案）

- **里程來源（D2(a)）**：區間公務里程取自 `TravelApplication` 之完成快照總里程（單表聚合），**不逐段重算**——與 4.4「完成即凍結、讀快照不重算」一致；「總里程 = Σ 各段總里程、不重複加高速里程」之語意由申請完成時寫入快照的定義保證（見 4.1）。**故障模式與守則**：已完成申請若快照為 `null`，`SUM` 會忽略該列而不報錯、統計靜默偏低，故「已完成 ⇒ 快照非 null」列為不變式並以測試守護。
- **過濾條件**：擁有人等值 ∧ 類型＝差旅 ∧ 狀態＝已完成 ∧ 出差日期落於區間（起訖含當日，以 `gte`/`lte` 表達）。「未作廢」以**狀態字面值等值比對**表達，不用負向條件（D8(a)）；**作廢語意必須維持「已作廢取代已完成」之終態，不得改為與已完成正交的旗標**，否則本過濾將靜默失效且既有測試不會變紅。
- **作廢已真實可達（PHASE-009）**：在此之前 `VOIDED` 為不可達狀態，故本過濾之正確性從未被真實資料檢驗；PHASE-009 之作廢端點落地後，`mileage/` **零 diff**（過濾條件一字未改）並以**走真實作廢端點**之回歸測試證明作廢筆自統計中消失（PHASE-005 當時以 `prisma.application.update` 直寫作廢的權宜作法於本 Phase 正式退場）。
- **兩個 `status` 集合刻意不同——統計面 vs 引用保護面（PHASE-009 D2(a)，人類 2026-08-07 Spec Gate 批准）**：

  | 面向 | 落點 | `status` 條件 | 問的問題 |
  |---|---|---|---|
  | 統計 | `mileage/mileage-range.ts` 之 `buildOfficialMileageWhere` | `= 'COMPLETED'`（**單值**） | 這筆申請今天還算不算數？ |
  | 引用保護 | `parameters/reference-guard.ts` 之 `REFERENCING_STATUSES` | `∈ {'COMPLETED', 'VOIDED'}` | 這個參數版本有沒有歷史紀錄在引用它？ |

  **差異理由**：作廢改變的是一筆申請的**統計有效性**，不是它的**歷史存在性**。已作廢申請仍保有完整快照、仍可下載其正式 PDF、仍在稽核軌跡內；若引用保護沿用 `COMPLETED` 單值，該申請所引用的參數版本會被回報為「無人引用、可覆寫」，覆寫後那筆歷史紀錄即**不可解釋**（違反 BE-US-19④ 對*歷史內容*之保護）。故**兩者不得「統一」**，各有獨立測試守門（統計側 AC-16／AC-17，引用側 AC-18 之 `COMPLETED`-only mutant 必紅）。D2 之選項 (c)（整段拿掉 `status` 條件）雖在今日語意等價（草稿從不寫快照欄）仍被否決：那會移除唯一一處意圖之明文陳述。
- **引用保護之放寬為單向承諾**：改回 `COMPLETED`-only 是純程式變更，但期間若已有參數版本被覆寫，**資料層無法回復**——故 D2 一經批准即為長期承諾。
- **精度定案（D3(a)，視同金額類）**：全程 `Decimal` / DB `numeric`，**禁止任何浮點中介**；**本層對里程不做任何取整**（取整只發生於下游金額計算，且為整筆一次四捨五入）；對外**以字串傳輸、固定 2 位小數、未取整**（無資料為 `"0.00"`），沿用 PHASE-003a/004「金額與里程一律以字串表示 `Decimal`」之 DTO 慣例，下游以 `Decimal(字串)` 還原無損。**改變上述任一條須人類批准。**
- **複用介面**：`sumOfficialMileage(db, { ownerId, dateFrom, dateTo })` 唯讀且接受交易 client。**`maintenance`（期間公務里程）已於 PHASE-006 落地**——預覽路徑以 `prisma` 唯讀呼叫（零寫入），完成路徑於同一 `SERIALIZABLE` 交易 `tx` 內呼叫；`ownerId` 一律取自 `Application.ownerId`（**代操作時亦為擁有人，絕不為操作者**），區間為 `[上次保養日期, 本次保養日期]` 起訖含當日。**`depreciation`（年度公務里程）亦已於 PHASE-007 落地**——預覽路徑以 `prisma` 唯讀呼叫（零寫入），完成路徑於同一 `SERIALIZABLE` 交易 `tx` 內呼叫；`ownerId` 同樣一律取自 `Application.ownerId`（**代操作時亦為擁有人，絕不為操作者**；預覽端點以 `resolveOwnerId` 判定，一般使用者帶他人 → 403，不靜默降級），區間為 `[YYYY-01-01, YYYY-12-31]` 起訖含當日。里程過濾與加總**全案只有這一份實作**，PHASE-006／007 均未重寫（以 import 接線斷言 ＋ 突變自證守護，`mileage-engine.ts`／`mileage-range.ts` 於兩 Phase 皆零 diff）。
- **D2(a) `count`／`SUM` 不對稱之保養處置（PHASE-006 AC-15，已落地）**：若期間內某已完成差旅之快照總里程為 `null`，引擎之 `applicationCount` **計入**該列而 `totalKm` **忽略**該列（外觀為「筆數 ≥ 1 但里程 `0.00`」）——此為既有引擎行為，PHASE-006 **不改**。保養之**任何金額計算一律只使用 `totalKm`**，`applicationCount` 純供顯示，不得參與分子、分母或任何推導；偏差方向為**保守**（分子偏低 → 比例偏低 → 分攤偏低），不會溢付；DTO 如實回傳兩值，前端不得據此自行推導或補值。
- **D2(a) `count`／`SUM` 不對稱之折舊處置（PHASE-007 AC-13／D14(a)，已落地）**：同型適用於年度公務里程——引擎**不改**，折舊之**任何金額計算一律只使用 `totalKm`**，`applicationCount` 純供顯示，不得參與分子、分母或任何推導；不加執行期守門（`applicationCount > 0 且 totalKm = 0` 不得據以拒絕完成，以免與「該年度確實 0 公里」之合法情形混為一談），仍以「已完成 ⇒ 快照非 null」之不變式測試守護；偏差方向為**保守**（補貼偏低），不會溢付；DTO 如實回傳兩值。
- **效能形狀**：以 DB 層單一聚合完成，不將命中集合讀入記憶體相加、不 N+1、不分頁；不新增索引（D9(a)），依賴既有申請 `(擁有人, 狀態)` 索引前綴與出差日期索引，實測與索引評估留待 PHASE-011 效能驗證。

### 4.11 使用者屬性之授權與參數揭露面（PHASE-005a／007 定案）

- **油耗資料之寫入授權（PHASE-005a）**：使用者車輛油耗（`UserFuelConsumptionVersion`）為**使用者屬性**，但**僅管理員可寫**——一般使用者**含本人**皆不可寫；本人僅得經 `GET /me/fuel-consumption` 唯讀檢視。差旅單價解析一律以**擁有人**之油耗為準，管理員代操作時絕不取操作者之油耗。
- **折舊推導過程之揭露面（PHASE-007 修訂段，人類 2026-08-05 批准；取代原 D8(a) 之揭露段，已落地）**：對一般使用者**可見**者為**五值**——每年折舊費用（2 位小數）／年度公務里程（2 位小數）／年度總里程（1 位小數）／公務比例（6 位小數與百分比 4 位小數）／補貼金額（整數）；隨預覽、草稿與快照 DTO 回傳並顯示於畫面。**車價 `vehiclePrice`、折舊年限 `usefulLifeYears`、預估年度行駛公里數 `estimatedAnnualKm` 與參數版本 id 一律不出現於任何折舊 DTO**——草稿、預覽、已完成快照皆然，且**全身分一致**（管理員亦不由折舊 DTO 取得，需要時走既有管理員限定之 `GET /parameters/depreciation`）。**折舊年限之遮蔽為契約層義務而非疏漏**：每年折舊費用 × 年限 ＝ 車價，僅遮蔽車價無法達成裁定意圖。**每公里單價已自新模型退場**（新模型不存在該值；舊模型列之快照原值仍原樣回傳，不重算）。此為 API 契約層之**真實隔離**，不是「前端不顯示」的 UI 遮蔽（沿 PHASE-004 D6 修訂「不得以一般使用者不知道為安全前提」之紀律），以 DTO 鍵集封閉斷言守門。取整前金額 `rawAmount` **不屬**推導過程（為金額本身之中間值，沿 PHASE-006 既有先例），照常回傳供對帳。年度總里程為**使用者自己申報之申請資料**，回傳予本人與管理員不構成授權擴張。

### 4.12 作廢與修正版之授權與交易邊界（PHASE-009 定案，已落地）

- **授權面刻意不對稱**：作廢端點依 AD-US-10 之逐字授權**放行管理員**（`assertOwnershipOrAdmin`）；**完成端點維持 owner-only**（管理員亦 403，D17／D7(a)／D9(a)），管理員代操作僅及於草稿。修正版端點同作廢，擁有人或管理員皆可，管理員操作時擁有人仍為原使用者、操作者為管理員並寫稽核。
- **判定順序（無側信道）**：`401` → `404`（存在性，不洩漏申請型別）→ `403`（授權，以 DB 查得之 `ownerId` 為準）→ `409`（狀態）→ `400`（欄位）。**授權必須早於狀態守門**：若移到 service 之後，他人對草稿／已完成／已作廢會得到互異回應而洩漏狀態；此不變式有側信道測試守門。作廢之 409（狀態）恆早於 400（原因），故「草稿 ＋ 空原因」之請求回 409 而非 400。
- **作廢之交易邊界**：狀態守門與原因驗證皆收斂於**交易內**（列鎖後之新鮮讀取），故併發雙作廢由列鎖排隊後手確定性得 409——不靠重試碰運氣。交易內序為：列鎖 → 狀態守門 → 原因驗證 → 四欄寫入（`status` ＋ `voidReason`／`voidedAt`／`voidedById`）→〔作廢版 PDF 四階段〕→ 稽核 `INSERT` → COMMIT。**狀態寫入早於渲染**，使渲染所用之 `ReportData` 恆帶正確作廢資訊；順序不可對調。
- **修正版之交易邊界**：讀原業務欄位（含 `TripSegment`、`LINKED` 附件清單）→ 建新 `Application`(DRAFT) ＋ 三型子列 → `supersedesId` → 附件位元組複製 →〔代操作〕稽核 → COMMIT。附件複製在**同一交易**內完成，故失敗即整筆回滾；storage 側以補償刪除回收已寫之新 key。交易顯式 `timeout: 60_000`／`maxWait: 10_000`——差旅段數極端之資料可能撞上該上限而整筆回滾（零殘留仍成立），見 `docs/KNOWN_ISSUES.md`。
- **`VOID_TX_TIMEOUT_MS = 60_000` 為硬編常數，與 `REPORT_PDF_TIMEOUT_MS` 無程式耦合**——構成一條運維約束：後者之設定值須顯著小於 60 s（預設 30000 ms，須保留 `put`／讀回校驗／`INSERT` 之餘裕），調高至接近或超過 60 s 會使「其實只是慢」的正常作廢被 Prisma 交易逾時（P2028）搶先中止而變成 500。

### 4.13 使用者刪除守門與 FK 對應（PHASE-010 §16 D5(c) 定案，人類 2026-08-09 Spec Gate 批准；已落地）

- **問題形狀**：`prisma.user.delete()` 只要撞上**任何一條**指向 `User` 的 `ON DELETE RESTRICT` 外鍵即拋 P2003；該例外若未被守門攔在前面，會落入 `error-handler` 之未預期例外分支而回 **`500`**——與 AD-US-04② 逐字要求之「拒絕並提供停用選項」（`409` ＋ 停用文案）不符。故守門所查之欄位集合**必須與 DB 實際之 RESTRICT 外鍵集合一一對應：少一條就是一條 500 的缺口**。
- **兩邊都補（D5=(c)）**：①`users/history.ts` 之 `USER_RESTRICT_FK_GUARDS` 由 2 條擴為 **6 條**（每條 FK 一個項目、每個 `count` 只查自己那一欄，使宣告與查詢之間無漂移空間；六條並行 `Promise.all`，任一 > 0 即拒刪）②`admin/routes.ts` 之 `DELETE` 端點另加 **P2003 兜底轉譯 → `409` ＋ 同一文案**（縱深：守門漏補或競態時仍不是 500），並記一筆 `warn`（`fkField` 取自 Prisma `meta.field_name`，屬 schema metadata、零 PII）。

| 指向 `User` 之 FK | `ON DELETE` | 守門 |
|---|---|---|
| `Application.ownerId` | RESTRICT | ✅ `USER_RESTRICT_FK_GUARDS` |
| `Application.createdById` | RESTRICT | ✅（**無索引**——大表上為 seq scan，PHASE-011 補索引候選） |
| `Attachment.uploaderId` | RESTRICT | ✅（**無索引**，同上） |
| `Attachment.ownerId` | RESTRICT | ✅ |
| `AuditLog.actorId` | RESTRICT | ✅ |
| `UserFuelConsumptionVersion.userId` | RESTRICT | ✅ |
| `AuditLog.targetId` | **SET NULL** | ❌ **刻意不納** |
| `Session.userId` | **CASCADE** | ❌ **刻意不納** |

- **兩條刻意不納之語意（勿誤讀為漏列）**：`Session.userId` 為 CASCADE，本就不阻擋刪除；`AuditLog.targetId` 為 SET NULL——**被操作過的人可刪、操作過的人不可刪**，刪除後該欄轉 `null` 而 `targetLabel` 仍留 `loginName` 快照，正是 AD-US-04③「留下不含敏感資料的管理操作紀錄」之既有設計。
- **對應關係不靠註解維持**：`phase10-user-delete-regression.test.ts` 以 `information_schema` 列舉 DB 實際 FK 與本宣告做**欄位級（「表.欄」集合）機械相符斷言**——日後在 schema 新增一條指向 `User` 的 RESTRICT 外鍵而未同步登記，該測試即紅；「同一表新增另一條未守門欄位」亦必紅（表級斷言對此零鑑別力，已由 mutant 實證）。
- **使用者可見代價（人類明示接受）**：凡曾建立過帳號／改過全域參數／上傳過附件／被記過任何稽核（即成為 `AuditLog.actorId`）之管理員，**永久不可刪除，只能停用**；有油耗版本之使用者亦然（`UserFuelConsumptionVersion` 為 append-only，PHASE-005a D8(a) 之設計後果）。這是 AD-US-04② 的設計意圖而非缺陷；根治須「稽核 actor 匿名化」，屬資料保存決策，未排定。

## 5. 設計原則（不可違背）

1. **後端為計算唯一權威**：金額與里程一律後端計算，前端預覽僅供參考，後端不採前端提交金額。
2. **已完成不可變**：已完成申請不可修改，只能作廢或建立修正版；完成時保存計算快照。
3. **快照不可變**：歷史申請與已保存 PDF 不因後續參數變更而改變。
4. **參數版本不重疊**：同類參數有效期間不得重疊；依日期唯一對應版本。
5. **資料隔離**：一般使用者僅能存取自己的資料與附件；管理員代操作須分離擁有人與操作者並留稽核。
6. **附件授權存取**：附件內容須通過權限驗證；暫存/引用生命週期防遺失與孤立。
7. **可搬遷**：環境差異全走環境變數；容器與資料庫/附件分離；核心業務邏輯不因搬遷或儲存後端變更而修改。
8. **安全預設**：密碼不可逆保存、≥10 字元且拒弱密碼、登入失敗鎖定、正式 HTTPS 與 Cookie 安全屬性、日誌不含敏感資訊。

## 6. 開放問題（待 Phase Spec 或人類決策）

- Session 儲存後端（DB session vs 記憶體/外部 store）— PHASE-002 Spec 定案，須滿足「停用/重設密碼即失效既有 session」。

### 6.1 已結案（歷史條目保留，標註結案依據）

| 原開放問題（原文保留） | 結案依據 | 落點 |
|---|---|---|
| 「Playwright/Chromium 於後端容器的封裝方式（同容器 vs 伴生 worker）— PHASE-008 Spec 定案。」 | **PHASE-008 §16 D4(a)**（人類 2026-08-06 Spec Gate 批准，含三項附帶批准：CJK 字型必裝、`--no-sandbox` 安全取捨明示接受、`playwright` 列 runtime 依賴之映像成本已明示） | **同容器、每次請求啟動用畢即關**；見 §1 技術棧 PDF 列與 §4.7 |
| 「報表編號月內唯一的併發安全實作（序列/交易）— PHASE-008 Spec 定案。」 | **PHASE-008 §16 D3 修訂後定案**（人類 2026-08-06 兩次裁定：方案 (d) 交易形狀 ＋ 顧問鎖；再裁定 `READ COMMITTED`，經 T8R3 三層獨立複現證明 `SERIALIZABLE` 下顧問鎖排隊機制不成立） | **`READ COMMITTED`（本交易限定）＋ 交易級顧問鎖排隊（主防線）＋ `max(sequence)+1` ＋ 三欄唯一約束 ＋ `P2002` 重試（最後防線）**；見 §4.7 |
