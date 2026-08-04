# ARCHITECTURE — 私車差旅補助管理系統（草案）

- Governance-Version: 2026-08-01.1
- 狀態：DRAFT
- 更新日期：2026-08-04（最後同步至 PHASE-006 已落地現實；DOC-SYNC `PHASE-007-DOC-SYNC-A`、`PHASE-007-DOC-SYNC-B`）
- 上游：`userstory.md`、`docs/PRD.md`、`CLAUDE.md`（技術棧已由人類確認）
- 說明：本文件為概念層架構草案，不含實際套件版本細節、API 完整路徑、DB 欄位與索引、部署程式碼。這些於各 Phase Spec 與實作 Task 定案。

---

## 1. 技術棧

| 層 | 技術 | 容器 |
|---|---|---|
| 前端 | React 18 + TypeScript + Vite | nginx（靜態資產 + 反向代理至後端） |
| 後端 | Node.js + Fastify + Prisma ORM + TypeScript | node |
| 資料庫 | PostgreSQL 16 | 獨立容器／受管服務 |
| PDF | Playwright (Chromium) 渲染列印版 HTML | 隨後端（同 node 容器或伴生 worker，Phase Spec 定案） |
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
| `parameters` | 三類補助參數版本之建立/列表端點、不重疊驗證（退化為同類 `effectiveFrom` 唯一，PHASE-003a）、依日期查找純函式 `findEffectiveVersion`、折舊每公里單價推導引擎、參數異動稽核（複用 `audit`／PHASE-002 `AuditLog`）；只增不改（無改/刪版本端點）以保引用保護。**PHASE-005a 起，油資由 `FuelPriceVersion`（按油種 `GASOLINE_92`／`GASOLINE_95`／`GASOLINE_98`／`DIESEL`）維護，端點 `POST\|GET /parameters/fuel-price`，落點 `fuel-price-service.ts`＋單價推導純函式 `fuel-price-engine.ts`；`FuelParameterVersion` 依 D1(a) 定案處置——表與歷史引用保留、`POST /parameters/fuel` 凍結（三身分皆 404、零寫入）、`GET /parameters/fuel` 保留唯讀（供稽核追溯與舊快照顯示）** | AD-US-11..13, BE-US-14, 19, 32 |
| `applications` | 申請共通：狀態機、草稿、綜合查詢（分頁/篩選/授權）、修正版、作廢、快照容器。**PHASE-006 起亦為保養實作之落點**（下列 `maintenance` 概念模組之程式落於 `backend/src/applications/`）：`maintenance-service.ts`（草稿 CRUD／預覽／完成流程編排）、`maintenance-calculation.ts`（分攤計算純函式）、`maintenance-blockers.ts`（完成阻擋碼純函式） | FE-US-04, 05, 21, 25, 26, BE-US-05, 18, 20, 21, 22, 29 |
| `trips` | 差旅專屬：多段行程、里程驗證、差旅完成流程 | FE-US-07..12, BE-US-06, 07, 08, 09 |
| `maintenance` | 保養專屬：區間里程、期間公務里程、分攤、保養完成流程 | FE-US-13..16, BE-US-10..13 |
| `depreciation` | 折舊專屬：年度里程、參數套用、補貼計算、折舊完成流程 | FE-US-17..20, BE-US-15, 16, 17 |
| `mileage`（統計） | 區間/年度公務里程統計引擎（共用給差旅統計、保養、折舊）。**PHASE-005 落地，落點 `backend/src/mileage/`**，三檔各司其職：`mileage-range.ts`（純函式：區間驗證 `parseMileageRange`、過濾條件建構 `buildOfficialMileageWhere`，不碰 DB、不知道「今天」）、`mileage-engine.ts`（唯讀 DB 聚合 `sumOfficialMileage`，簽章接受 `PrismaClient \| Prisma.TransactionClient`）、`routes.ts`（薄層編排：授權 → 結構收斂 → 驗證 → 引擎 → DTO，本身不含任何業務判定）。對外**僅一個唯讀端點**；對內提供 `sumOfficialMileage(db, params)` 供 `maintenance`／`depreciation` **於交易內複用**（不重算、不繞道 HTTP） | FE-US-06, BE-US-30 |
| `attachments` | storage 抽象、上傳/格式大小/內容檢測、數量限制、生命週期（暫存→關聯→鎖定→清理）、授權存取 | FE-US-21, BE-US-23, 24, 25, NFR-US-07, 10 |
| `reports` | 報表編號產生、列印版 HTML 組裝、Playwright PDF 產生/保存、安全檔名、授權下載 | FE-US-22..24, BE-US-26, 27, 28 |
| `audit` | 稽核事件寫入與查詢（操作者/擁有人/時間/類型/前後摘要；密碼不入） | AD-US-14, BE-US-31 |
| `calculation engine` | 金額計算純函式：單段/整筆差旅、保養分攤、折舊補貼、統一四捨五入取整 | BE-US-06, 07, 12, 14, 17 |
| `platform` | 健康檢查、結構化錯誤處理、設定/env 載入、DB 連線 | NFR-US-15, 16, 05 |

模組依賴方向（高階）：`trips/maintenance/depreciation` → `applications`（狀態/草稿/查詢）+ `calculation engine` + `parameters` + `mileage` + `attachments`；所有受保護模組 → `auth` + `authz`；寫入操作 → `audit`。

## 4. 共用元件與跨模組規則

### 4.1 Calculation Engine（金額計算唯一權威）

- 純函式、無副作用，供各申請類型呼叫；後端為金額與里程計算的唯一權威，**不得採用前端提交的金額**（BE-US-06/07/12/17 各有明列）。
- 統一四捨五入：小數 <0.5 捨去、≥0.5 進位，非銀行家取整；最終申報金額為新臺幣整數（共通取整規則）。
- 差旅：單段 = round(總里程×油資單價 + 高速里程×ETC 單價)（先相加再取整）；整筆 = Σ 各段取整金額；總里程 = Σ 各段總里程，**不重複加高速里程**。
- **油資每公里單價為推導值（PHASE-005a，已落地）**：`油資單價 = ROUND_HALF_UP(每公升油價 ÷ 車輛油耗, 0)`（元／km，整數；`deriveFuelUnitPrice` 純函式）。每公升油價取自 `FuelPriceVersion`（依**擁有人油種** ＋ 出差日期選版），油耗取自 `UserFuelConsumptionVersion`（依**擁有人** ＋ 出差日期選版）。**差旅金額路徑之取整恰兩處**——① 推導每公里單價、② 段金額——**不得新增第三處**。推導商 < 0.5 時單價為 0（合法結果，非錯誤）；推導值或金額超出目標欄位容量時以可行動 4xx 拒絕（D4(a)），**絕不 500、絕不靜默截斷**。
- 保養：區間里程 = 本次里程表 − 上次里程表；比例 = 期間公務里程 ÷ 區間里程（>100% 阻擋）；分攤 = round(實際費用 × 比例)（整筆一次取整）。
- **保養分攤之計算式與取整層級（PHASE-006 D4(a)，已落地）**：分攤 ＝ `ROUND_HALF_UP(實際費用 × 期間公務里程 ÷ 保養區間里程, 0)`；**計算過程不得先取整比例或任何中間值**（快照之 `ratio` 6 位小數與 `ratioPercent` 僅供顯示與快照，**不參與**金額計算）；**全案取整恰一處**（此處），不得新增第二處。>100% 之阻擋判定必須以 `Decimal` 直接比較「期間公務里程」與「區間里程」（`O == I` 為合法、允許完成），**不得**以取整後之比例比較。
- 折舊：每年費用 = 車價 ÷ 年限；每公里單價 = 每年費用 ÷ 預估年里程；補貼 = round(年度公務里程 × 每公里單價)（整筆一次取整）。
- **折舊推導精度定案（PHASE-003a D3）**：折舊參數建立時之推導值，每年折舊費用以 `Decimal` 保留 2 位小數、每公里補助單價以 `Decimal` 保留 4 位小數；取整採一般四捨五入（0.5 進位，ROUND_HALF_UP，非銀行家取整）。`perKmUnitPrice` 以**未先取整**之每年費用為分子計算（round-late，減少累積誤差）。每公里單價為**中間單價非最終申報金額**，不得在此先取整為整數（否則嚴重失真）。**PHASE-007 套用折舊補貼時，必須以本 Phase（PHASE-003a）回傳之 4 位小數 `perKmUnitPrice` 為準**，再對最終金額一次四捨五入為新臺幣整數；兩處單價精度必須一致，避免最終補貼金額對不上。

### 4.2 Parameter 版本查找

- 三類參數皆為「版本 + 生效日期」；有效期間不得重疊（`parameters` 模組建立時驗證，BE-US-19）。
- 差旅依**出差日期**選有效油資/ETC 版本（BE-US-09）；折舊依**申請年度 1/1**選有效折舊版本（BE-US-16），年度中途新版本不影響當年計算。
- 版本被歷史已完成申請引用後其內容不可覆寫；歷史金額由快照保證不變（見 4.4）。
- **有效期間表示法定案（PHASE-003a D2 方案 A）**：三類參數僅持久化 `effectiveFrom`（`@db.Date` 日粒度，含當日），有效期間結束為「同類下一版生效日前一日」隱含推導，最後一版開放至無限未來；時間線連續不留空窗。因結束由下一版隱含界定，「不重疊」約束退化為「同類 `effectiveFrom` 唯一」。
- **依日期查找為後端純函式 `findEffectiveVersion(type, date)`**（不依賴 DB 狀態的判定，`parameters` 模組提供）：取同類中 `effectiveFrom ≤ 查詢日` 之最大者為該日唯一有效版本；查詢日早於最早版本則回「查無有效版本」（供下游判斷缺參數）。此引擎供 PHASE-004（差旅以出差日呼叫）與 PHASE-007（折舊以年度 1/1 呼叫）使用。

### 4.3 申請狀態機

- 狀態：草稿 / 已完成 / 已作廢。允許：新建→草稿、草稿→已完成、草稿→刪除、已完成→已作廢、已完成→建立修正版草稿。禁止：已完成→草稿、已作廢→已完成、已作廢→草稿、已完成永久刪除。
- 由 `applications` 模組集中守門，各申請類型共用（BE-US-05）。完成需通過各類型完整性驗證。

### 4.4 計算快照（不可變）

- 申請完成時保存「使用的參數 + 取整前後金額」快照（差旅：油資/ETC 單價、取整前後金額；保養：區間里程/公務里程/比例/實際費用/最終金額；折舊：車價/年限/預估年里程/單價/年度里程/最終金額）（BE-US-18）。
- 快照一旦寫入不可變；事後修改參數不影響歷史申請與已保存 PDF（AD-US-11/13、FE-US-20、BE-US-09/16 一致）。
- **保養快照之落地形狀（PHASE-006，D11(a)）**：`MaintenanceApplication` 另存**取整前金額 `snapshotRawAmount`** 與 `calculatedAt`（連同 `snapshotIntervalKm`／`snapshotOfficialKm`／`snapshotRatio` 共五個快照欄位）；**實際費用之快照即 `actualCost` 欄位本身**（完成後由狀態機凍結，**不另存冗餘副本**）；最終金額落於既有 `Application.totalAmount`（`Int`），不重複持久化。

### 4.5 附件生命週期與授權存取

- 生命週期：上傳→暫存標示→關聯草稿→（完成時）鎖定→被引用則保護、暫存 >24h 無引用可清理（BE-US-25）。
- 授權存取：任何附件內容存取須先通過擁有權/角色驗證（`authz`），未登入或非擁有者不得取得（NFR-US-10, BE-US-02）。數量與格式/大小/內容檢測由 `attachments` 統一（BE-US-23/24）。
- **附件內容一律經後端授權端點回傳；持久化 volume 不得由 nginx 靜態直出對外（否則繞過授權，違反 NFR-US-10）**。storage key 由系統產生、不含使用者輸入，杜絕路徑穿越與列舉取檔。（修訂 2026-08-01，SPEC-003 決策點 D7；PHASE-003 拓撲約束，待人類批准 Spec 後生效。）
- 附件對申請容器於 PHASE-003 採**弱關聯**（refType+refId，避免提前建立申請表）；「完成鎖定」語意權威在申請狀態機，附件不冗餘持久化 locked。（修訂 2026-08-01，SPEC-003 決策點 D1/D2。）
- **`deriveContainerState` 支援 `refType=MAINTENANCE`（PHASE-006 D2(a)，已落地）**：自 PHASE-006 起，保養附件之容器狀態經 `MaintenanceApplication → Application.status` 推導（`refId` ＝ `Application.id` ＝ `MaintenanceApplication.applicationId`），已完成保養之證明附件即受鎖定保護（BE-US-25 第 4 條）；`deleteApplication` 於刪除保養草稿時一併 detach 其 `MAINTENANCE` 附件，避免孤兒 `LINKED` 附件。維持上列「弱關聯 ＋ 不冗餘持久化 locked」之既有定案（未改為強 FK、未新增 locked 旗標）。

### 4.6 綜合查詢與資料隔離

- `applications` 提供分頁/篩選/關鍵字綜合查詢，預設近一年；授權層強制一般使用者只見自己資料，管理員可指定使用者；一般使用者自帶他人識別值不得越權（BE-US-29, BE-US-02）。
- **統計查詢與綜合查詢分屬不同端點（PHASE-005 D4(a) 定案）**：統計為單一端點 + `ownerId` 參數（個人與管理員共用同一路徑），**不分頁**——無 `page`／`pageSize`，一次聚合完整區間；綜合查詢維持分頁。統計端點之日期起訖**皆為必填**（PHASE-005 D5(a)），刻意不沿用綜合查詢「未指定即預設近一年」的預設值，以免使用者把近一年數字誤讀為全期間。
- **`resolveOwnerId(actor, ownerId)` 為兩者共用之授權判定**（實作單一份，落於 `applications` 模組，統計端點直接複用、**不重寫**）：未帶或帶自己 → 自己；一般使用者帶他人 → 403，**不靜默降級為自己**；管理員得指定任一擁有人。任何新增之「可指定擁有人」查詢一律沿用此函式。

### 4.7 報表與 PDF

- 報表編號：TRV/MNT/DEP 前綴 + 月內唯一 + 對同一版本冪等（BE-US-26）。
- 列印版 HTML 與正式 PDF **同一版型**；Playwright 以該 HTML 產生 PDF 並保存；產生/保存失敗不得標示成功（BE-US-27）。安全檔名移除不安全字元（BE-US-28）。

### 4.8 稽核

- 重要操作（帳號新增/停用/密碼重設/代操作/作廢/參數異動）寫稽核，含操作者/擁有人/時間/類型/前後摘要；**密碼與敏感憑證不入稽核與日誌**（BE-US-31, NFR-US-16）。
- **參數建立稽核定案（PHASE-003a D6）**：三類參數版本建立之稽核**複用 PHASE-002 `AuditLog`** 機制（不另起爐灶）；`AuditAction` enum 新增**單一值 `PARAMETER_VERSION_CREATED`**，以 `summary.parameterType`（`FUEL`／`ETC`／`DEPRECIATION`）區分三類，`summary` 存重要設定摘要（單價或車價/年限/年里程 + `effectiveFrom`），不含密碼與敏感憑證。

### 4.9 結構化錯誤處理

- 統一錯誤回應：前端可辨識欄位與原因；不外洩堆疊、DB 結構或敏感資訊；伺服器日誌含追查識別但不含密碼/憑證（NFR-US-16）。

### 4.10 里程統計精度與引擎複用（PHASE-005 定案）

- **里程來源（D2(a)）**：區間公務里程取自 `TravelApplication` 之完成快照總里程（單表聚合），**不逐段重算**——與 4.4「完成即凍結、讀快照不重算」一致；「總里程 = Σ 各段總里程、不重複加高速里程」之語意由申請完成時寫入快照的定義保證（見 4.1）。**故障模式與守則**：已完成申請若快照為 `null`，`SUM` 會忽略該列而不報錯、統計靜默偏低，故「已完成 ⇒ 快照非 null」列為不變式並以測試守護。
- **過濾條件**：擁有人等值 ∧ 類型＝差旅 ∧ 狀態＝已完成 ∧ 出差日期落於區間（起訖含當日，以 `gte`/`lte` 表達）。「未作廢」以**狀態字面值等值比對**表達，不用負向條件（D8(a)）；**作廢語意必須維持「已作廢取代已完成」之終態，不得改為與已完成正交的旗標**，否則本過濾將靜默失效且既有測試不會變紅。
- **精度定案（D3(a)，視同金額類）**：全程 `Decimal` / DB `numeric`，**禁止任何浮點中介**；**本層對里程不做任何取整**（取整只發生於下游金額計算，且為整筆一次四捨五入）；對外**以字串傳輸、固定 2 位小數、未取整**（無資料為 `"0.00"`），沿用 PHASE-003a/004「金額與里程一律以字串表示 `Decimal`」之 DTO 慣例，下游以 `Decimal(字串)` 還原無損。**改變上述任一條須人類批准。**
- **複用介面**：`sumOfficialMileage(db, { ownerId, dateFrom, dateTo })` 唯讀且接受交易 client。**`maintenance`（期間公務里程）已於 PHASE-006 落地**——預覽路徑以 `prisma` 唯讀呼叫（零寫入），完成路徑於同一 `SERIALIZABLE` 交易 `tx` 內呼叫；`ownerId` 一律取自 `Application.ownerId`（**代操作時亦為擁有人，絕不為操作者**），區間為 `[上次保養日期, 本次保養日期]` 起訖含當日。`depreciation`（年度公務里程）之複用仍為**計畫**（PHASE-007）。里程過濾與加總**全案只有這一份實作**，PHASE-006 未重寫（以 import 接線斷言 ＋ 突變自證守護）。
- **D2(a) `count`／`SUM` 不對稱之保養處置（PHASE-006 AC-15，已落地）**：若期間內某已完成差旅之快照總里程為 `null`，引擎之 `applicationCount` **計入**該列而 `totalKm` **忽略**該列（外觀為「筆數 ≥ 1 但里程 `0.00`」）——此為既有引擎行為，PHASE-006 **不改**。保養之**任何金額計算一律只使用 `totalKm`**，`applicationCount` 純供顯示，不得參與分子、分母或任何推導；偏差方向為**保守**（分子偏低 → 比例偏低 → 分攤偏低），不會溢付；DTO 如實回傳兩值，前端不得據此自行推導或補值。
- **效能形狀**：以 DB 層單一聚合完成，不將命中集合讀入記憶體相加、不 N+1、不分頁；不新增索引（D9(a)），依賴既有申請 `(擁有人, 狀態)` 索引前綴與出差日期索引，實測與索引評估留待 PHASE-011 效能驗證。

### 4.11 使用者屬性之授權（PHASE-005a 定案）

- **油耗資料之寫入授權（PHASE-005a）**：使用者車輛油耗（`UserFuelConsumptionVersion`）為**使用者屬性**，但**僅管理員可寫**——一般使用者**含本人**皆不可寫；本人僅得經 `GET /me/fuel-consumption` 唯讀檢視。差旅單價解析一律以**擁有人**之油耗為準，管理員代操作時絕不取操作者之油耗。

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

- Playwright/Chromium 於後端容器的封裝方式（同容器 vs 伴生 worker）— PHASE-008 Spec 定案。
- Session 儲存後端（DB session vs 記憶體/外部 store）— PHASE-002 Spec 定案，須滿足「停用/重設密碼即失效既有 session」。
- 報表編號月內唯一的併發安全實作（序列/交易）— PHASE-008 Spec 定案。
