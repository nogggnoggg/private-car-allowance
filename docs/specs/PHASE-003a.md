# PHASE-003a — 補助參數維護（油資 / ETC / 折舊，版本化不重疊）

- Governance-Version: 2026-08-01.2
- 狀態：**COMPLETED**（High 風險 Spec；D1~D10 事前批准並實作，Review APPROVE、20/20 AC、Mock UI+整合驗收通過；PR #4 經人類批准合併至 main @ 94a87a8，2026-08-02。見 §13 修訂紀錄）
- Task ID（產出本 Spec）：SPEC-003a
- 更新日期：2026-08-01
- Phase ID：PHASE-003a
- Base Commit：3fafcf9（branch: phase-003a；自 main @ 93411cc 切出）
- 上游事實來源（優先序見 CLAUDE.md）：`userstory.md`（AD-US-11/12/13、BE-US-14、BE-US-19；不得改變原意）→ `docs/PRD.md` 第 5 節 PHASE-003a 段落（289–307 行）→ `docs/ARCHITECTURE.md`（§3 `parameters` 模組、§4.2 參數版本查找、§4.8 稽核）、`docs/DATA_FLOW.md`（§1 三類 ParameterVersion、§2.7 參數維護）、ADR、`docs/specs/PHASE-001.md`（§5.2 錯誤協定、`sanitizeForLog`）、`docs/specs/PHASE-002.md`（授權中介 `requireAuth`/`requirePasswordChanged`/`requireAdmin`、`AuditLog` 結構與稽核寫入慣例、密碼不入稽核原則）
- 依賴：
  - **PHASE-002（DONE，已合併 main）**：認證/授權中介層（`requireAuth`、`requirePasswordChanged`、`requireAdmin`、`assertOwnershipOrAdmin`）、Cookie Session、`AuditLog` model 與 `AuditAction` enum、稽核寫入慣例、`sanitizeForLog` + pino redact（承 PHASE-001）。
  - **PHASE-003（DONE，已合併 main）**：附件基礎。與本 Phase 概念獨立；僅在「引用保護規則之定義方式」上與 PHASE-003 的弱關聯/引用保護思路對齊（見 §4.7），不共用資料表。
- Risk Level：**High**（參數版本＝影響金額之受引用資料；建立後被歷史申請引用即不可覆寫，屬不可逆/受引用資料）。

> 本文件為 PHASE-003a 的實作定案層：描述可測試 AC、概念資料模型與 migration 意圖、不重疊引擎與折舊推導引擎、API 形狀、Data Flow 與測試策略，供 implementer 依 TDD 落地。實際 Prisma 欄位型別/索引微調、精確數值型別的資料庫映射屬實作細節，於 Task 內定案並記錄（但**金額/單價語意與精度決策**屬 High，見第 13 節 D 級決策，不得由 implementer 臆測）。
>
> **本 Spec 為 DRAFT。第 13 節「需人類批准決策點」為人類事前批准的審閱依據。未經批准不得開始實作。**

---

## 1. 目標與非目標

### 1.1 目標

建立**管理員維護三類補助參數版本**的垂直切片，作為 PHASE-004（差旅套用油資/ETC 參數，BE-US-09）與 PHASE-007（折舊套用，BE-US-14/16）的硬前置。Phase 結束人類可實際操作：

1. 以**管理員**建立三類補助參數版本：**油資每公里單價**（AD-US-11）、**ETC 每公里單價**（AD-US-12）、**折舊參數**（車價 / 折舊年限 / 預估年度行駛公里數，AD-US-13）。
2. 每個版本含**生效日期**；同類參數**有效期間不得重疊**，重疊時被拒絕並指出衝突版本（BE-US-19、AD-US-11/12/13）。
3. 建立**未來生效版本**不影響現行有效版本；依任一查詢日期可查得該日**唯一**有效版本（AD-US-11、BE-US-19）。
4. 折舊參數建立後系統推導並顯示**每年折舊費用**（車價 ÷ 年限）與**折舊每公里補助單價**（每年費用 ÷ 預估年里程）（AD-US-13、BE-US-14）。
5. 值域驗證：油資/ETC 單價 **≥ 0** 才可建立；折舊各值（車價、年限、預估年里程）**必須 > 0**，任一 ≤ 0 拒絕並指出欄位（AD-US-11/12/13、BE-US-14）。
6. 三類參數異動寫**稽核**（修改者、參數類型、重要設定前後摘要；密碼/敏感資料不入稽核），**複用 PHASE-002 既有 `AuditLog` 機制**（AD-US-14、BE-US-31、BE-US-19）。
7. **依日期版本查找引擎**（純函式優先）與**折舊每公里單價推導引擎**（純函式）就位，供 PHASE-004/007 呼叫。
8. 前端**參數維護頁**：三類參數的建立表單與版本列表，具 Loading / Empty / Error / Success / Permission denied 五態。

並落地供後續 Phase 沿用的能力：**不重疊驗證引擎**（純判定）、**依日期查找引擎**（純判定）、**折舊推導引擎**（純函式）、**參數異動稽核**（複用 002）。

### 1.2 非目標（Out of Scope，明確排除）

- **套用參數到實際申請計算**：差旅套用油資/ETC（BE-US-09）於 **PHASE-004**；折舊套用（BE-US-16/17、依申請年度 1/1 取版本）於 **PHASE-007**。本 Phase 只建立「查找引擎」與「折舊推導引擎」並以測試直接驗證，**不接任何真實申請完成流程**。
- **歷史申請「引用保護」的完整回歸**：需已存在已完成申請才能回歸（於 PHASE-004/007）。本 Phase 僅**定義**引用保護規則與資料上如何**偵測/標記**被引用（見 §4.7），**不做跨 Phase 回歸**（此非縮減 AC——引用保護 AC 在有引用來源出現後於後續 Phase 閉環，本 Phase 先驗證判斷點與拒絕覆寫路徑，可用注入的引用來源測試拒絕分支）。
- **參數的修改 / 刪除 / 停用**：`userstory.md` AD-US-11/12/13、BE-US-19 僅要求**建立新版本**與**版本不重疊**、**未來生效**、**歷史不變**；未提供「編輯既有版本內容」或「刪除版本」的 User Story。本 Phase **只支援建立版本與查詢**，不提供改/刪版本端點（改參數＝建立新版本，符合版本化語意與引用保護）。是否需要「撤銷未來生效且未被引用之版本」列為決策點 D9，預設不納入。
- **前端真實整合驗收細節**：屬整合 Gate。本 Phase 前端頁提供 Mock Gate（表單/列表五態）與整合 Gate 標的。
- **折舊「依申請年度 1/1 取版本」的年度選版邏輯**（BE-US-16）：屬 PHASE-007 套用層。本 Phase 的查找引擎為「依任一給定日期取有效版本」的通用引擎，PHASE-007 以「該年度 1/1」為查詢日期呼叫之。

---

## 2. 可測試 Acceptance Criteria

AC 以 Given/When/Then 表述，逐條可測，標註對應 US 與主要 Task。錯誤碼見 §4.8；「有效期間」表示法見 §4.2（決策點 D2）。以下 AC 中「有效期間不重疊」「依日期查得唯一版本」的具體語意依 D2 定案；本節以 D2 **建議方案（僅 `effectiveFrom` + 隱含結束＝下一版生效前一日）** 表述，若 Gate 改採顯式 `effectiveTo` 則等義調整（不改變 US 原意）。

### 值域驗證（AD-US-11/12/13、BE-US-14）

**AC-01 建立油資參數：單價 ≥ 0 通過（AD-US-11 / T3）**
- Given 管理員輸入油資每公里單價 **≥ 0** 與生效日期，且與既有版本無重疊。
- When `POST /parameters/fuel`。
- Then 建立新版本，回 201 與版本 DTO（含生效日期、單價、隱含有效期間）。

**AC-02 建立 ETC 參數：單價 ≥ 0 通過（AD-US-12 / T3）**
- Given 管理員輸入 ETC 每公里單價 **≥ 0** 與生效日期，無重疊。
- When `POST /parameters/etc`。
- Then 建立新版本，回 201 與版本 DTO。

**AC-03 油資/ETC 單價 < 0 拒絕（AD-US-11/12 / T3）**
- Given 管理員輸入單價 **< 0**（負值）。
- When 提交建立。
- Then 拒絕，回 `VALIDATION_ERROR`，`fields` 標示 `unitPrice`「單價不得小於 0」；不建立版本。

**AC-04 建立折舊參數：三值皆 > 0 通過（AD-US-13 / T4）**
- Given 管理員輸入車價、折舊年限、預估年度行駛公里數**皆 > 0** 與生效日期，無重疊。
- When `POST /parameters/depreciation`。
- Then 建立新版本，回 201 與版本 DTO，並附**推導結果**：每年折舊費用與折舊每公里補助單價（見 AC-11/12）。

**AC-05 折舊任一值 ≤ 0 拒絕並指欄位（AD-US-13、BE-US-14 / T4）**
- Given 車價、折舊年限、預估年里程中**任一 ≤ 0**（含 0 與負值）。
- When 提交建立。
- Then 拒絕，回 `VALIDATION_ERROR`，`fields` **精確標示違規欄位**（`vehiclePrice`／`usefulLifeYears`／`estimatedAnnualKm` 中對應者）與原因「必須大於 0」；不建立版本；**不進行推導計算**（避免除以 0）。

**AC-06 生效日期為必填且合法日期（AD-US-11/12/13 / T3, T4）**
- Given 管理員未提供生效日期或提供非法日期字串。
- When 提交建立。
- Then 拒絕，回 `VALIDATION_ERROR`，`fields` 標示 `effectiveFrom`；不建立版本。

### 有效期間不重疊（BE-US-19、AD-US-11/12/13）

**AC-07 重疊拒絕並指出衝突版本（BE-US-19、AD-US-11/12 / T2, T3）**
- Given 某類參數已存在有效期間覆蓋日期 D 的版本 V。
- When 管理員為**同類**參數建立一個有效期間與 V **重疊**的新版本。
- Then 拒絕，回 `PARAMETER_PERIOD_OVERLAP`（見 §4.8），錯誤 body 指出**衝突版本識別與其生效日期**（供前端定位）；不建立版本。

**AC-08 折舊重疊亦拒絕（AD-US-13、BE-US-19 / T2, T4）**
- Given 折舊參數已存在有效期間覆蓋日期 D 的版本。
- When 建立與其重疊的折舊版本。
- Then 拒絕，回 `PARAMETER_PERIOD_OVERLAP`，指出衝突版本；不建立。

**AC-09 不重疊引擎為純判定、跨類一致（BE-US-19 / T2）**
- Given 一組現有版本的有效期間與一個候選新版本的有效期間（同類）。
- When 呼叫不重疊判定函式（純函式，不依賴 DB）。
- Then 對「相鄰不重疊（新版生效日 = 舊版隱含結束日 + 1 日）」回**允許**；對「任一日交集」回**拒絕並回傳衝突版本**；三類參數共用同一判定邏輯（可單元測試多組區間）。日期起訖**含當日**（CLAUDE.md 日期規則）。

### 未來生效與依日期查找（AD-US-11/12、BE-US-19）

**AC-10 未來生效版本不影響現行版本（AD-US-11、BE-US-19 / T2, T3）**
- Given 現行有效版本 V0（生效日 ≤ 今日）；管理員建立生效日在**未來**的版本 V1。
- When 建立 V1（與 V0 不重疊，V1 生效日 > V0 生效日）。
- Then V1 建立成功；**以今日為查詢日期查得 V0**（現行版本仍有效）；以 V1 生效日（含當日）為查詢日期查得 V1。

**AC-11 依任一日期查得唯一有效版本（BE-US-19、BE-US-09 前置 / T2）**
- Given 同類存在多個不重疊版本。
- When 以任一查詢日期 D 呼叫依日期查找引擎。
- Then 回傳**唯一**在 D 有效的版本（生效日 ≤ D 且 D ≤ 隱含結束日，起訖含當日）；D 早於最早版本生效日 → 回「查無有效版本」（供 PHASE-004/007 判斷「缺參數」）。

### 折舊推導（BE-US-14、AD-US-13）

**AC-12 推導每年折舊費用（BE-US-14 / T4）**
- Given 折舊版本車價、折舊年限皆 > 0。
- When 系統推導。
- Then 每年折舊費用 = **車價 ÷ 折舊年限**（推導精度見 §4.4 / D3）。

**AC-13 推導折舊每公里補助單價（BE-US-14 / T4）**
- Given 每年折舊費用與預估年度行駛公里數（> 0）。
- When 系統推導。
- Then 折舊每公里補助單價 = **每年折舊費用 ÷ 預估年度行駛公里數**（推導精度見 §4.4 / D3）。

**AC-14 折舊推導引擎為純函式且對 ≤ 0 回報無效（BE-US-14 / T4）**
- Given 傳入車價/年限/預估年里程任一 ≤ 0。
- When 呼叫推導純函式。
- Then 回報**參數無效**（不丟未捕捉例外、不回 NaN/Infinity）；三值皆 > 0 時回傳一致的每年費用與每公里單價（可單元測試多組數值）。

### 引用保護（規則定義，回歸於後續 Phase）（BE-US-19、AD-US-11/13）

**AC-15 被引用版本內容不得覆寫（規則定義）（BE-US-19、AD-US-11/13 / T2）**
- Given 某參數版本**已被歷史已完成申請引用**（本 Phase 以注入的「引用存在」旗標/查詢介面表達；真實引用來源於 PHASE-004/007）。
- When 任何嘗試**變更該版本內容**的路徑。
- Then 被拒絕（本 Phase 不提供改版本端點，故此規則以「查找引擎不回傳可變引用 + 引用偵測介面契約 + 建立新版本不改動舊版本」共同保證）；新增後續版本**不改動**被引用版本之欄位值（AC-10 已涵蓋「歷史金額由快照保證不變」的參數面）。

> 說明：AD-US-11「歷史差旅已完成時新增新版本，歷史申請金額不得改變」、AD-US-13「折舊申請已完成後修改參數，歷史不得改變」之**金額不變**部分，其權威為**申請完成時的計算快照**（ARCHITECTURE §4.4，PHASE-004/007 落地），非本 Phase 職責。本 Phase 保證的是「建立新版本不覆寫舊版本內容、舊版本仍可依歷史日期查得」。

### 權限與稽核（AD-US-11/12/13、AD-US-14、BE-US-31）

**AC-16 僅管理員可維護參數（AD-US-11/12/13、BE-US-02 衍生 / T3, T4）**
- Given 一般使用者（`role=USER`）已登入。
- When 呼叫任一參數**建立**端點（fuel/etc/depreciation）。
- Then 回 **403 `FORBIDDEN`**（`requireAdmin`，沿用 PHASE-002 §4.7）；不建立、不回傳資料。

**AC-17 未登入被拒（BE-US-01 衍生 / T3, T4）**
- Given 無有效 Session。
- When 呼叫任一參數端點。
- Then 回 **401 `UNAUTHORIZED`**；不回傳資料。

**AC-18 參數異動寫稽核（AD-US-14、BE-US-31、BE-US-19 / T5）**
- Given 管理員成功建立任一類參數版本。
- When 建立成功。
- Then 寫入一筆 `AuditLog`（複用 PHASE-002 結構），含：操作者(actor)、操作類型（參數建立，見 D6 命名）、參數類型與重要設定摘要（`summary`：如油資 `{ unitPrice, effectiveFrom }`；折舊 `{ vehiclePrice, usefulLifeYears, estimatedAnnualKm, effectiveFrom }`）、時間；**不含密碼與任何敏感憑證**。

**AC-19 參數查詢/列表授權（AD-US-11/12/13 / T3, T4, T6）**
- Given 管理員已登入（非 `mustChangePassword` 限制態）。
- When `GET` 參數列表端點。
- Then 回該類參數所有版本（依生效日期排序），含推導結果（折舊）；一般使用者呼叫**維護頁對應之管理端點**回 403（見 D10 對「一般使用者能否讀取參數」之定案）。

### 前端五態（AD-US-11/12/13 / T6）

**AC-20 參數維護頁五態（AD-US-11/12/13 / T6）**
- Given 三類參數的建立表單與版本列表頁。
- When 呈現。
- Then 具備 **Loading / Empty（尚無任何版本）/ Error（值域錯、重疊錯、載入錯）/ Success（建立成功刷新列表並顯示折舊推導）/ Permission denied（一般使用者 403 態）** 對應處理；文案 zh-TW，響應式；錯誤依統一 `error.code` 判讀（重疊錯顯示衝突版本、值域錯以 `fields` 定位欄位）。

---

## 3. 資料模型與 migration

### 3.1 三類 ParameterVersion（概念資料模型）

沿用 `docs/DATA_FLOW.md` §1 的 `FuelParameterVersion`／`EtcParameterVersion`／`DepreciationParameterVersion` 三實體。**資料表結構（單表多型 vs 三表）為決策點 D1**；下列以 **D1 建議方案（三表，各自欄位明確、型別安全、查找引擎以泛型套用）** 表達，若 Gate 改採單表多型則語意等義收斂（見 D1）。

```prisma
// D2 建議：僅持久化 effectiveFrom（生效日，含當日）；有效期間結束為「同類下一版生效日前一日」隱含推導。
// 若 Gate 採 D2 替代（顯式 effectiveTo）則新增可空 effectiveTo 欄位並於建立時維護。

model FuelParameterVersion {
  id            String   @id @default(cuid())
  unitPrice     Decimal  @db.Decimal(10, 4)   // 油資每公里單價，≥0；精度見 §4.4 / D8
  effectiveFrom DateTime @db.Date              // 生效日（日粒度，含當日）；不含時間
  createdById   String                          // 建立之管理員（稽核/追溯）
  createdAt     DateTime @default(now())

  @@index([effectiveFrom])
}

model EtcParameterVersion {
  id            String   @id @default(cuid())
  unitPrice     Decimal  @db.Decimal(10, 4)   // ETC 每公里單價，≥0
  effectiveFrom DateTime @db.Date
  createdById   String
  createdAt     DateTime @default(now())

  @@index([effectiveFrom])
}

model DepreciationParameterVersion {
  id                String   @id @default(cuid())
  vehiclePrice      Decimal  @db.Decimal(12, 2)  // 車價（新臺幣），>0
  usefulLifeYears   Int                           // 折舊年限（年），>0；整數或小數見 D8
  estimatedAnnualKm Int                           // 預估年度行駛公里數，>0
  effectiveFrom     DateTime @db.Date
  createdById       String
  createdAt         DateTime @default(now())
  // 註：每年折舊費用與每公里單價「不持久化」，由推導引擎即算即回（D7）；
  //     若 D7 改為持久化，則新增 annualDepreciation / perKmUnitPrice 欄位並於建立時計算寫入。

  @@index([effectiveFrom])
}
```

- `createdById` 對應 PHASE-002 `User.id`（外鍵可選；由於建立者為管理員且不隨帳號刪除而失去稽核意義，稽核以 `AuditLog` 為權威，此欄位為輔助追溯，D1 說明是否加外鍵）。
- **生效日採 `@db.Date`（日粒度）**：符合 CLAUDE.md「日期起訖含當日」「差旅依出差日期歸屬」的日粒度語意，避免時區/時分秒造成「同一日不同時刻」的重疊判定歧義。查找以「日」比較。
- **索引**：`effectiveFrom` 建索引以支援依日期查找與排序；不重疊約束落點見 §4.3（D4）。

### 3.2 設計說明

- **三表 vs 單表多型（D1）**：三表利在型別安全（折舊三欄 vs 油資/ETC 單欄結構不同）、查詢明確、下游 PHASE-004/007 查找 API 形狀清晰；弊在不重疊引擎與稽核需對三表各接一次（可用泛型/共用服務降低重複）。單表多型（一張 `ParameterVersion` + `type` enum + 可空欄位或 `JSON payload`）利在共用一套不重疊/查找/稽核程式；弊在欄位可空性鬆散、折舊三欄以 JSON 存則失去 DB 型別檢查。**建議三表 + 共用泛型服務層**，詳列 D1。
- **有效期間表示法（D2）**：見 §4.2。
- **推導值是否持久化（D7）**：折舊每年費用/每公里單價為**純函式可重算**之派生值。建議**不持久化**（即算即回，避免派生值與來源不一致），詳列 D7。
- **金額/單價精度（D8）**：見 §4.4。

### 3.3 migration

- 單一 migration：新增三個 model（或 D1 定案之單表 + enum）。不觸及 PHASE-002 既有表（User/Session/AuditLog）與 PHASE-003 Attachment 表。
- **不變式**：
  - 同類參數：不存在兩個版本其有效期間交集（不重疊，§4.2/§4.3 保證）。
  - `effectiveFrom` 為日粒度（`@db.Date`）。
  - 油資/ETC `unitPrice ≥ 0`；折舊三值 `> 0`（值域由服務層守門，DB 可加 CHECK 約束強化，見 D4）。
  - 版本一經建立，其**參數值欄位不再被更新**（無改版本端點；引用保護，§4.7）。
- **`AuditAction` enum 擴充**：新增參數建立稽核動作（命名見 D6），沿用 PHASE-002 `AuditLog` 結構（同一 migration 或 audit 模組 migration，實作定案）。

---

## 4. 關鍵技術定案（每項附理由與替代/決策點）

### 4.1 模組落點

- 後端置於 `parameters` 模組（ARCHITECTURE §3）：三類參數建立/列表端點、不重疊驗證、依日期查找引擎、折舊推導引擎。
- 稽核寫入**複用** `audit` 模組與 PHASE-002 `AuditLog`（§4.6）；不另起爐灶。
- 授權沿用 PHASE-002 `requireAuth` + `requirePasswordChanged` + `requireAdmin`（§4.5）。

### 4.2 有效期間表示法與不重疊語意（決策點 D2）

三方案（日期起訖**含當日**，CLAUDE.md 規則）：

- **方案 A（建議）：僅持久化 `effectiveFrom`，有效期間結束＝「同類下一版生效日前一日」隱含推導。** 最後一版無結束（開放至無限未來）。
  - 利：資料最簡（單欄）；「不重疊」等價於「同類無重複 `effectiveFrom` 且排序後相鄰即接續」——實務上任兩版本只要生效日不同即天然不重疊（因結束由下一版隱含界定），**不重疊約束退化為「同類 `effectiveFrom` 唯一」**，實作與心智模型簡單；符合「參數為連續生效的時間線」語意（任一日恰有一版有效，最早版之前為無有效版）。
  - 弊：無法表達「一段有效後留空窗再接新版」（時間線中間不能有洞）。惟 US 未要求空窗（AD-US-11「舊版本在新版本生效前仍應有效」隱含連續時間線），故非缺陷。
- **方案 B：顯式 `effectiveFrom` + 可空 `effectiveTo`。** 建新版本時自動把前一版 `effectiveTo` 設為新版 `effectiveFrom - 1 日`。
  - 利：可表達空窗；查找不需「看下一版」。
  - 弊：`effectiveTo` 為派生值需維護（建立新版本需**更新前一版**，牴觸「版本內容不再被更新」不變式與引用保護——雖僅改 `effectiveTo` 非參數值，但增加寫入面與一致性風險）；重疊判定需比對區間交集。
- **方案 C：顯式 `effectiveFrom` + `effectiveTo`，由管理員手動輸入結束日。** 
  - 弊：UX 負擔、易產生空窗/重疊、與 US「生效日期」單一輸入不符。**不建議。**

**建議：方案 A**（僅 `effectiveFrom`，隱含結束、連續時間線、不重疊退化為生效日唯一）。理由：最貼合 US（只輸入生效日期）、最少寫入面（不回改舊版本）、最強引用保護（舊版本欄位完全不動）。**不重疊引擎**在方案 A 下：拒絕「同類已存在相同 `effectiveFrom`」，並在查找時以排序後區間界定唯一有效版本；AC-07「指出衝突版本」＝指出已占用該生效日或其涵蓋區間的版本。**若 Gate 選 B/C，AC 與資料模型等義調整。**

### 4.3 不重疊約束落點：DB 約束 vs 服務層（決策點 D4）

- **服務層驗證（必備）**：建立時於交易內查同類現有版本，套用 §4.2 不重疊判定；重疊回 `PARAMETER_PERIOD_OVERLAP` 並附衝突版本（AC-07/08）。此為**權威**，回錯誤語意清晰、可回傳衝突版本細節。
- **DB 約束（強化，D4）**：
  - 方案 A 下，可加 `@@unique([effectiveFrom])`（同類生效日唯一）作為併發最後防線（兩管理員同時建立同生效日 → DB 唯一鍵擋下，捕捉並轉 `PARAMETER_PERIOD_OVERLAP`）。
  - 完整區間不重疊（方案 B/C）需 PostgreSQL `EXCLUDE USING gist` 約束（Prisma 不原生支援，需 raw SQL migration）——複雜度較高。
- **建議（D4）**：**服務層權威 + 方案 A 的 `@@unique(effectiveFrom)` 併發防線**（Prisma 原生支援、簡單可靠）；不引入 gist EXCLUDE（除非採方案 B/C 且要求 DB 級完整區間約束）。值域（≥0 / >0）以服務層驗證為主，DB CHECK 約束為可選強化（實作定案，屬內部技術細節）。

### 4.4 折舊推導與金額/單價精度（決策點 D3、D8）

**兩種用途的精度分離（核心）：**

- **本 Phase：推導/顯示用途**（AC-12/13、AD-US-13、BE-US-14）：
  - 每年折舊費用 = 車價 ÷ 年限；每公里單價 = 每年費用 ÷ 預估年里程。
  - 此為**中間單價**，非「最終申報金額」。CLAUDE.md「最終金額為新臺幣整數、一般四捨五入」**適用於申請的最終補貼金額**（PHASE-007 `round(年度里程 × 每公里單價)`），**不適用於中間單價**（若在此把每公里單價先取整為整數，將嚴重失真——每公里補助常為小數）。
  - **決策點 D3**：每公里單價的**保留精度**。方案：(a) 以 `Decimal` 保留固定小數位（建議 4 位，與 §4.8/D8 單價精度一致）供顯示與 PHASE-007 套用；(b) 保留完整有理數/更高精度至 PHASE-007 計算末端才取整。**建議 (a)：推導產出以 `Decimal(小數 4 位)` 表示每公里單價與每年費用（每年費用可 2 位）**，四捨五入（一般 0.5 進位）至該精度僅供**顯示**；PHASE-007 套用時以**相同精度的單價**乘年度里程後對**最終金額一次四捨五入為整數**（與快照一致性由 PHASE-007 保證）。此使「本 Phase 顯示的單價」與「PHASE-007 計算所用單價」一致，避免兩處精度不同導致金額對不上。
  - **推導不改變 US 原意**：US 只說「顯示每年費用與每公里單價」，未定精度；此為金額語意決策，**列 D3 交人類批准**，本 Spec 僅建議。

- **PHASE-007：套用/最終金額用途**（非本 Phase）：`round(年度公務里程 × 每公里單價)` 為新臺幣整數，一般四捨五入（0.5 進位），對整筆一次取整（ARCHITECTURE §4.1、BE-US-17）。本 Phase 不做，但**本 Phase 決定的每公里單價精度會被 PHASE-007 沿用**，故 D3 屬 High（影響金額）。

**取整方向（一般四捨五入，0.5 進位，非銀行家取整）**：任何本 Phase 的四捨五入（若 D3 選 (a) 在顯示層取整）一律採 CLAUDE.md 規則。除以 0 已由值域驗證（三值 > 0）在推導前擋下（AC-05/14）。

**單價/數值精度（決策點 D8）**：
- 油資/ETC 單價：以 `Decimal` 保留小數（建議 `Decimal(10,4)`，即最多 4 位小數；每公里補助以角/分級距足夠）。**不可用浮點 `Float`**（金額精度要求，避免二進位浮點誤差）。
- 車價：`Decimal(12,2)`（元，2 位小數）。
- 折舊年限、預估年里程：整數 `Int`（建議；若需「年限含小數如 5.5 年」則改 `Decimal`——US 未明示，**列 D8**，預設整數）。
- **建議 D8**：油資/ETC `Decimal(10,4)`、車價 `Decimal(12,2)`、年限/年里程 `Int`；每公里推導單價 `Decimal(_,4)`。此為金額精度決策，屬 High，交 Gate 確認。

### 4.5 授權（沿用 PHASE-002）

- 三類參數**建立**端點：`requireAuth` + `requirePasswordChanged` + `requireAdmin`（AC-16/17）。
- 參數**列表/查詢**端點：至少 `requireAuth` + `requireAdmin`（維護頁為管理員功能，AD-US-11/12/13 主體為管理員）。**決策點 D10**：一般使用者是否需要讀取參數（例：差旅預覽金額需知道當日油資單價）。US 中 FE-US-10/18 的「預覽」由 PHASE-004/007 的**申請預覽端點**回傳（後端計算後回結果，非直接讀參數表）；故本 Phase **參數維護端點一律 requireAdmin**，一般使用者的參數需求由後續 Phase 的申請預覽端點間接滿足。**建議：本 Phase 參數端點全 requireAdmin**，詳列 D10。

### 4.6 稽核（複用 PHASE-002，不另起爐灶）

- **複用點（明確）**：
  - **表結構**：沿用 PHASE-002 `AuditLog` model（§3.4）——`action`/`actorId`/`actor`/`targetId?`/`targetLabel`/`summary(Json?)`/`createdAt`。參數版本非「User target」，故 `targetId` 可為 null，`targetLabel` 存參數類型與版本識別（如 `FUEL#<versionId>` 或 `油資參數 v(<effectiveFrom>)`），`summary` 存重要設定摘要。
  - **寫入方式**：沿用 PHASE-002 稽核寫入慣例（操作成功後於同交易/緊接寫入一筆）。
  - **密碼/敏感不入稽核**：沿用 PHASE-002 原則；參數稽核 `summary` 僅含參數數值與生效日（非敏感），**不涉及任何密碼**。
- **待確認的稽核事件型別命名（決策點 D6）**：PHASE-002 `AuditAction` enum 目前為 `USER_CREATED` 等帳號事件；本 Phase 需新增參數建立事件。命名方案：
  - (a) 單一 `PARAMETER_VERSION_CREATED`，以 `summary.parameterType` 區分 fuel/etc/depreciation；
  - (b) 三個明確值 `FUEL_PARAMETER_CREATED` / `ETC_PARAMETER_CREATED` / `DEPRECIATION_PARAMETER_CREATED`。
  - **建議 (a) 單一 `PARAMETER_VERSION_CREATED` + `summary.parameterType`**：與 PHASE-002「一動作一 enum 值」慣例略異，但參數三類同構、便於稽核查詢彙整（AD-US-14「參數異動」為單一概念）；若偏好與帳號事件同粒度則採 (b)。**列 D6 交 Gate 定案**（enum 命名影響 migration 與稽核查詢，屬需記錄之變更）。
- **摘要內容（`summary`）**：
  - 油資/ETC：`{ parameterType: "FUEL"|"ETC", unitPrice, effectiveFrom }`。
  - 折舊：`{ parameterType: "DEPRECIATION", vehiclePrice, usefulLifeYears, estimatedAnnualKm, effectiveFrom }`（可另附推導 `annualDepreciation`/`perKmUnitPrice` 供追溯，非必要）。
- **AD-US-14 稽核查詢頁**：本 Phase **不建**稽核查詢頁（屬 PHASE-002/後續 audit 呈現）；本 Phase 只保證「參數建立寫入稽核」（AC-18），查詢頁沿用既有/後續。

### 4.7 引用保護規則定義（本 Phase 僅定義，回歸於後續）

- **規則**：一參數版本一旦被**歷史已完成申請**引用（差旅完成引用其出差日有效油資/ETC 版本；折舊完成引用其年度 1/1 有效折舊版本），該版本**內容不得被覆寫**（BE-US-19、AD-US-11/13）。
- **本 Phase 如何「定義並偵測」引用（無申請資料下）**：
  - 本 Phase **不提供改/刪版本端點**（§1.2），故「覆寫版本內容」路徑天然不存在——引用保護在資料流上由「只增不改」保證（建立新版本不動舊版本，AC-10/15）。
  - 提供**引用偵測介面契約** `parameterHasReferences(type, versionId): boolean`（類比 PHASE-002 `userHasHistory` 與 PHASE-003 `isEligibleForCleanup` 的引用判斷模式）：本 Phase 引用來源集合為「已完成差旅/折舊申請之快照所引用的參數版本」，因該資料在本 Phase 不存在，**本 Phase 回傳 false**（無引用）；PHASE-004/007 將申請快照納入其判斷。
  - 此介面供**未來若引入「撤銷未來生效未被引用版本」端點（D9）** 時作前置檢查；本 Phase 預設不引入該端點。
- **與計算快照的分工**：AD-US-11/13「歷史金額不變」由**申請完成快照**（PHASE-004/007）保證，非本 Phase。本 Phase 保證「舊版本欄位不被改動、可依歷史日期查得」。此分工在 §2 AC-15 說明中已載明，避免與快照職責混淆。

### 4.8 錯誤碼（沿用 PHASE-001 錯誤協定 + PHASE-002/003 慣例）

沿用 `AppError(code, httpStatus, message, fields?)` 與統一 body `{ error: { code, message, requestId, fields? } }`（PHASE-001 §5.2）。`ErrorCode` union 新增：

| code | HTTP | 用途 |
|---|---|---|
| `PARAMETER_PERIOD_OVERLAP` | 409 | 新版本有效期間與同類既有版本重疊（AC-07/08）；body 附衝突版本識別與生效日期 |

- 沿用既有：`VALIDATION_ERROR`(400，值域錯/日期錯，帶 `fields`，AC-03/05/06)、`UNAUTHORIZED`(401，AC-17)、`FORBIDDEN`(403，AC-16)、`NOT_FOUND`(404，查無版本 id)、`CONFLICT`(409，如需區分)。
- **重疊為何用專屬碼 `PARAMETER_PERIOD_OVERLAP` 而非 `CONFLICT`**：需在錯誤 body 附**衝突版本細節**供前端定位（AC-07「指出衝突版本」），專屬碼利於前端顯示「與 v(2026-01-01) 重疊」；亦可用 `CONFLICT` + `fields`/`details`——**決策點併入 D5 錯誤碼設計**（建議專屬碼）。衝突細節放於 body 的擴充欄位（如 `error.details.conflictVersion`），不外洩內部路徑/堆疊。
- `message` 面向使用者、zh-TW、不外洩內部細節；`fields` 僅 `VALIDATION_ERROR` 出現。

---

## 5. API Contract（本 Phase 端點）

- 路徑經 nginx `/api` 反向代理至後端（去 `/api` 前綴，PHASE-001 定案）；下表為後端實際 route（前端呼叫加 `/api`）。
- 除另註外，所有端點掛 `requireAuth` + `requirePasswordChanged` + `requireAdmin`（§4.5、D10）。回應成功/錯誤皆 JSON，錯誤統一格式（§4.8）。
- **DTO**（回應排除任何敏感資料；金額/單價以字串或數值表示，精度依 D8）：
  - `FuelParameterDto = { id, unitPrice, effectiveFrom, createdAt }`
  - `EtcParameterDto = { id, unitPrice, effectiveFrom, createdAt }`
  - `DepreciationParameterDto = { id, vehiclePrice, usefulLifeYears, estimatedAnnualKm, effectiveFrom, createdAt, derived: { annualDepreciation, perKmUnitPrice } }`（`derived` 由推導引擎即算，D7）

### 5.1 參數端點

| 方法 | 路徑 | 中介 | Request | 成功回應 | 主要錯誤 |
|---|---|---|---|---|---|
| POST | `/parameters/fuel` | requireAuth + requirePasswordChanged + requireAdmin | `{ unitPrice, effectiveFrom }` | 201 `{ version: FuelParameterDto }` | 400 `VALIDATION_ERROR`（單價<0 / 日期錯，AC-03/06）；409 `PARAMETER_PERIOD_OVERLAP`（AC-07）；401/403 |
| GET | `/parameters/fuel` | 同上 | query 可選（省略回全列表，依 `effectiveFrom` 排序） | 200 `{ versions: FuelParameterDto[] }` | 401/403 |
| POST | `/parameters/etc` | 同上 | `{ unitPrice, effectiveFrom }` | 201 `{ version: EtcParameterDto }` | 400 / 409 / 401/403 |
| GET | `/parameters/etc` | 同上 | query 可選 | 200 `{ versions: EtcParameterDto[] }` | 401/403 |
| POST | `/parameters/depreciation` | 同上 | `{ vehiclePrice, usefulLifeYears, estimatedAnnualKm, effectiveFrom }` | 201 `{ version: DepreciationParameterDto }`（含 `derived`） | 400 `VALIDATION_ERROR`（任一≤0 指欄位 / 日期錯，AC-05/06）；409 `PARAMETER_PERIOD_OVERLAP`（AC-08）；401/403 |
| GET | `/parameters/depreciation` | 同上 | query 可選 | 200 `{ versions: DepreciationParameterDto[] }`（各含 `derived`） | 401/403 |

- **查找引擎不必然對外開端點**：依日期查找（AC-11）主要供 PHASE-004/007 **後端內部**呼叫（差旅/折舊完成流程）。本 Phase 以**服務層純函式**提供 `findEffectiveVersion(type, date)`，並以測試直接驗證（§9）；**是否對外開 `GET /parameters/{type}/effective?date=` 端點**（供前端顯示「當日有效單價」）列為輕量選項——**建議提供**該唯讀查詢端點（requireAdmin）以支援維護頁「查某日有效版本」的檢視，但非硬需求（D10 相關）。若提供：`GET /parameters/fuel/effective?date=YYYY-MM-DD` → 200 `{ version | null }`（查無回 `{ version: null }`，非 404，AC-11）。
- **無改/刪端點**（§1.2）：不提供 `PUT`/`PATCH`/`DELETE` 參數版本端點（引用保護與版本化語意）。

### 5.2 前端參數維護頁

- **導覽入口（Gate 反饋 2026-08-01，人類批准）**：管理員首頁（HomePage）須提供進入本頁的導覽連結（比照既有「使用者管理」→ `/admin/users` 之管理員專屬連結模式），連結文字 zh-TW（如「補助參數維護」）指向 `/admin/parameters`；一般使用者不顯示此連結。
- 受保護（管理員）頁，提供三類參數各自的：**建立表單**（依類型欄位）、**版本列表**（依生效日期，顯示各版本值；折舊列額外顯示 `derived` 每年費用與每公里單價）。
- 五態（AC-20）：Loading（載入列表）、Empty（尚無版本，顯示建立入口）、Error（值域錯以 `fields` 標欄位、重疊錯顯示衝突版本、載入錯可重試）、Success（建立成功刷新列表 + 折舊即時顯示推導）、Permission denied（一般使用者 403 態）。
- 用途：Mock Gate（表單/列表五態）與整合 Gate 端到端（管理員建立→被拒重疊→查得有效版本）標的。

---

## 6. Data Flow（本 Phase 影響部分）

沿用並具體化 `docs/DATA_FLOW.md` §2.7（參數維護）。本 Phase 的資料流：

```
建立參數版本（油資/ETC/折舊）：
管理員 →(參數值 + effectiveFrom)→ POST /parameters/{fuel|etc|depreciation}
  【授權】requireAuth（未登入→401 AC-17）→ requirePasswordChanged → requireAdmin（非管理員→403 AC-16）
  → 值域驗證：油資/ETC unitPrice ≥0（<0→400 AC-03）；折舊三值 >0（任一≤0→400 指欄位 AC-05，且不推導避免除0）
  → 日期驗證：effectiveFrom 必填且合法（否則→400 AC-06）
  → 【不重疊引擎】查同類現有版本 → 與候選有效期間比對（§4.2）
        → 重疊 → 409 PARAMETER_PERIOD_OVERLAP + 衝突版本（AC-07/08）
        → （方案A：同 effectiveFrom 亦視為衝突；DB @@unique 併發防線 D4）
  →（折舊）推導引擎：每年費用=車價÷年限、每公里單價=每年費用÷預估年里程（AC-12/13，精度 D3）
  → 交易內建立版本（只增不改，引用保護 §4.7）
  → 【稽核】複用 PHASE-002 AuditLog 寫入一筆（action=參數建立 D6、actor、summary=參數摘要、不含密碼）（AC-18）
  → 201 版本 DTO（折舊含 derived）

依日期查找（供 PHASE-004/007 內部呼叫；本 Phase 測試直接驗證，可選對外唯讀端點）：
呼叫端 →findEffectiveVersion(type, date)→
  → 於同類版本中取「effectiveFrom ≤ date 且 date ≤ 下一版 effectiveFrom - 1 日（含當日）」之唯一版本（§4.2）
  → date 早於最早版本 → 回 null（缺參數；PHASE-004/007 據此拒絕完成申請）（AC-11）
  → 未來生效版本不影響今日查找（AC-10）

列表：
管理員 →GET /parameters/{type}→
  【授權】requireAuth + requireAdmin
  → 回該類全版本（依 effectiveFrom 排序）；折舊各版即算 derived（AC-19）

引用保護（規則定義，回歸於後續 Phase）：
  → 本 Phase 無改/刪端點 → 版本內容不可被覆寫（天然保證）
  → parameterHasReferences(type, versionId)：本 Phase 引用來源不存在 → 回 false
  → PHASE-004/007 將已完成申請快照納入引用判斷；歷史金額不變由申請快照保證（非本 Phase）（AC-15）
```

---

## 7. 非功能需求（NFR）

- **NFR-US-05（env 驅動）**：本 Phase **不新增 env**（無新外部設定；參數數值為業務資料存 DB，非環境設定）。若 D8 需可配置精度則仍以程式常數表達（非 env），避免無用設定。
- **NFR-US-14（效能，PHASE-011 集中驗證）**：參數列表與依日期查找為小資料量（參數版本數量級小），`effectiveFrom` 索引足夠；查找為 O(log n)/線性掃描皆在目標內。建立操作於 NFR-US-14「一般表單 2s」目標內。
- **NFR-US-16（結構化錯誤）**：沿用統一錯誤格式；重疊錯附衝突版本供前端定位，不外洩堆疊/DB 結構/內部路徑。
- **安全（CLAUDE.md）**：全程合成測試資料；稽核與日誌不含密碼/敏感憑證（參數數值本身非敏感，但沿用 `sanitizeForLog` + pino redact 慣例，不記錄 session cookie）。
- **金額精度（CLAUDE.md）**：金額/單價一律 `Decimal`（非浮點）；最終金額取整規則屬 PHASE-007，本 Phase 推導精度見 §4.4/D3/D8。
- **可搬遷（NFR-US-05）**：無寫死敏感資訊；純業務資料表 + 端點，隨既有容器部署。

---

## 8. 測試策略

TDD：每 Task 先寫會失敗的測試再實作；不得 skip/弱化換綠燈。**不重疊引擎與折舊推導引擎為純函式優先**（可完整單元測試、鑑別力高）。層級分配：

### 8.1 單元（Vitest，不需 DB）— 引擎純函式為主

- **不重疊判定引擎**（AC-07/08/09，核心）：
  - 給定現有版本區間集合（依 §4.2 方案 A：以 `effectiveFrom` 排序推導隱含區間）與候選 `effectiveFrom`：
    - 候選生效日**等於**既有版本 → 拒（回衝突版本）。
    - 候選生效日落在既有版本隱含區間內 → 拒（回衝突版本）。
    - 候選為全新最早/最晚/中間插入且不與任何區間交集 → 允許。
    - **相鄰邊界**（候選＝某版隱含結束日的**次日**）→ 允許（起訖含當日的邊界正確性，鑑別力關鍵）。
  - 三類參數共用同一引擎，以泛型/相同函式測（AC-09）。
  - **鑑別力要求**：測試須能捕捉「差一日（off-by-one）」錯誤——明確測「同一日交集拒絕」與「相鄰次日允許」兩相鄰案例；測空集合（第一個版本必允許）。
- **依日期查找引擎**（AC-10/11，核心）：
  - 多版本下，對「早於最早生效日」→ null；「恰為某版生效日」→ 該版（含當日邊界）；「某版隱含結束日當日」→ 該版；「結束日次日」→ 下一版；「最新版生效日之後任一未來日」→ 最新版。
  - **未來生效版本存在時，以今日查找回現行版本**（AC-10，鑑別力：未來版不得污染現行查找）。
  - **鑑別力要求**：邊界日（生效日當日、隱含結束日當日、次日）三點必測，捕捉含當日/不含當日錯誤。
- **折舊推導引擎**（AC-12/13/14，核心）：
  - 三值 > 0：驗每年費用＝車價÷年限、每公里單價＝每年費用÷預估年里程，多組數值（含可整除與需保留小數的案例）；驗**精度/取整**依 D3 定案（如保留 4 位小數、一般四捨五入 0.5 進位方向正確）。
  - 任一值 ≤ 0（0 與負）→ 回報無效、**不回 NaN/Infinity、不丟未捕捉例外**（AC-14，鑑別力：明確測 0 年限不得除以 0）。
  - **鑑別力要求**：以「需四捨五入且落在 .5 邊界」的數值驗一般四捨五入（0.5 進位）而非銀行家取整（如末位 .5 進位方向）。
- **值域驗證**：油資/ETC `<0` 拒、`0`/正值通過（AC-03）；折舊各欄 `≤0` 精確指欄位（AC-05）。
- **錯誤碼組裝**：各拒絕路徑回正確 code/HTTP 與 `fields`/衝突版本（AC-03/05/07）。

### 8.2 整合（Vitest + Postgres + 真實 route）

- **建立全流程**：合法油資/ETC/折舊 → 201 + DTO（折舊含 derived）；油資 `-1` → 400 指 `unitPrice`；折舊 `usefulLifeYears=0` → 400 指欄位且無 derived；缺/錯 `effectiveFrom` → 400（AC-01..06）。
- **不重疊端到端**：建立 v(2026-01-01) → 再建 v(2026-01-01) 或重疊區間 → 409 `PARAMETER_PERIOD_OVERLAP` 且 body 含衝突版本；建立相鄰次日版本 → 成功（AC-07/08/09）。
- **未來生效與查找端到端**：建 v0（過去/今日）+ v1（未來）→ 以今日查得 v0、以 v1 生效日查得 v1（AC-10/11）；查早於最早 → null。
- **權限矩陣**（核心）：對 POST/GET fuel/etc/depreciation，覆蓋 {管理員、一般使用者、未登入、`mustChangePassword` 管理員} → 斷言 201/200、403、401、403（PASSWORD_CHANGE_REQUIRED）（AC-16/17/19）。一般使用者**不得**建立或（依 D10）讀取。
- **稽核寫入**（AC-18）：建立各類參數後，讀 `AuditLog` 該筆，斷言含 actor、參數建立 action（D6）、`summary` 含參數摘要與 `effectiveFrom`；**斷言 `summary`/`targetLabel` 不含任何密碼欄位鍵**（複用 PHASE-002 稽核安全測試模式）。
- **併發防線**（D4，若採方案 A `@@unique`）：模擬同 `effectiveFrom` 併發建立 → 一成功一回 `PARAMETER_PERIOD_OVERLAP`（DB 唯一鍵捕捉轉碼），不外洩 DB 錯誤原文。
- **精度持久化**（D8）：寫入 `Decimal` 單價後讀回一致（不因浮點失真）；折舊 derived 兩次呼叫一致（純函式）。

### 8.3 前端（Vitest + Testing Library，mock fetch）

- 三類參數維護頁五態（AC-20）各一測試：Loading（列表載入）、Empty（無版本 + 建立入口）、Error（值域錯以 `fields` 標欄位、重疊錯顯示衝突版本、載入錯重試）、Success（建立成功刷新 + 折舊顯示 derived）、Permission denied（一般使用者 403 態）。
- 折舊表單即時顯示推導（每年費用/每公里單價）——以 mock 後端回應之 `derived` 驗顯示（前端不自行計算金額，對齊「後端為計算權威」）。

### 8.4 E2E（Playwright，整合 Gate）

- 管理員登入 → 建立油資/ETC/折舊各一版本 → 列表可見 → 建立重疊版本被拒並見衝突提示 → 建立未來生效版本、列表可見兩版本（AC-01/04/07/10）。
- 一般使用者 session 直接請求參數維護頁/端點 → Permission denied（AC-16，呼應授權）。

### 8.5 安全與日誌測試

- 斷言參數建立的稽核 JSON 與伺服器日誌**不含**密碼/session cookie（沿用 `sanitizeForLog` + pino redact；以 logStream 擷取）。
- 斷言錯誤回應不外洩 DB 結構/堆疊/內部路徑（重疊錯僅回衝突版本業務識別與生效日）。

---

## 9. Rollback

- 本 Phase 新增：三個參數版本表（或 D1 單表）+ `AuditAction` enum 擴充（D6）+ 參數端點 + 不重疊/查找/推導引擎 + 前端維護頁；於 `phase-003a` branch 實作、Draft PR。
- 回滾（開發階段，合成資料）：以 branch 還原至 base commit 3fafcf9；down migration 移除新增表與 enum 值擴充。
- **引用資料風險**：本 Phase **不接真實申請完成流程**（Out of Scope），故本 Phase 無「被已完成申請引用之參數版本」的不可逆正式資料，回滾風險可控（開發期合成資料可清）。
- **一旦後續 Phase（004/007）有歷史申請引用參數**，回滾須避免刪除被引用版本（正式資料階段的回滾為人類決策，非本 Phase 開發期情境）。
- `AuditAction` enum 擴充之回滾：PostgreSQL enum 值移除需注意既有稽核列引用（開發期無正式稽核列，可安全重建）。

---

## 10. 已知限制

- **有效期間表示法未定案**：§4.2 建議方案 A（僅 `effectiveFrom` 隱含結束），最終依 D2；若採 B/C 則資料模型/AC 等義調整。
- **推導單價精度未定案**：§4.4 建議 4 位小數 `Decimal` 供顯示與 PHASE-007 沿用，最終依 D3/D8；此決定會被 PHASE-007 沿用，影響最終金額，屬 High。
- **引用保護僅定義、不回歸**：§4.7；`parameterHasReferences` 本 Phase 回 false，真實引用判斷與歷史金額不變回歸於 PHASE-004/007（跨 Phase 追蹤須記入 PROJECT_STATE）。
- **無改/刪版本**：本 Phase 只增不改（引用保護與版本化語意）；「撤銷未來生效未被引用版本」列 D9，預設不納入。
- **稽核查詢頁不在本 Phase**：只保證寫入（AC-18）；AD-US-14 查詢呈現沿用既有/後續 audit 呈現。
- **折舊「年度 1/1 取版本」不在本 Phase**：查找引擎為通用「依日期」，PHASE-007 以年度 1/1 為查詢日呼叫（BE-US-16）。
- **一般使用者讀參數**：本 Phase 端點全 requireAdmin（D10）；一般使用者的參數需求由後續申請預覽端點間接滿足。

---

## 11. 需人類批准決策點清單（供 Gate 審閱）

> 以下為改變架構/資料模型/金額語意/依賴/稽核 enum 或需人類定案者。**Spec 內僅為建議，不得視為既定**；Gate 批准後才落地。整份 Spec 屬 High 風險，需人類事前批准後方可轉 ACTIVE 實作。凡涉及**金額/單價語意**（D3、D8）依 Packet「Spec Change Permission」一律交人類批准，不得自行定案。

| # | 決策點 | 建議 | 風險/影響 |
|---|---|---|---|
| D1 | 三類參數**資料表結構**：三表 vs 單表多型 | **三表 + 共用泛型服務層**（型別安全、下游查找 API 清晰） | 型別安全 vs 程式重複；影響 migration、不重疊/查找/稽核的接法、PHASE-004/007 查找 API 形狀 |
| D2 | **有效期間表示法**：僅 `effectiveFrom`（隱含結束）／顯式 `effectiveFrom+effectiveTo`（建版回改前一版）／手動雙日期 | **方案 A：僅 `effectiveFrom`，隱含結束、連續時間線、不重疊退化為生效日唯一** | 最貼 US、最少寫入面、最強引用保護（不回改舊版）vs 無法表達空窗（US 未要求）；影響不重疊引擎與查找語意 |
| **D3** | **折舊每公里單價/每年費用的推導精度與取整時機**（金額語意，**必人類批准**） | **每公里單價以 `Decimal(4 位小數)`（每年費用 2 位）保留，顯示層一般四捨五入（0.5 進位）；PHASE-007 以相同精度單價乘年度里程後對最終金額一次取整為整數** | 中間單價精度直接影響 PHASE-007 最終補貼金額；此處若過早取整為整數將嚴重失真；須與「最終金額為整數、一般四捨五入」規則對齊且兩處單價精度一致 |
| D4 | **不重疊約束落點**：服務層 vs DB 約束 | **服務層權威 + 方案 A 下 `@@unique(effectiveFrom)` 併發防線**；不引入 gist EXCLUDE（除非採 D2 的 B/C 並要求 DB 級完整區間約束） | 併發正確性 vs 複雜度；DB 級完整區間不重疊需 raw SQL（Prisma 不原生支援） |
| D5 | **重疊錯誤碼**：專屬 `PARAMETER_PERIOD_OVERLAP` vs 沿用 `CONFLICT` | **專屬 `PARAMETER_PERIOD_OVERLAP`（409）+ body 附衝突版本**（利前端定位） | 錯誤碼族擴散 vs 前端可讀性；AC-07「指出衝突版本」需求 |
| D6 | **參數稽核 `AuditAction` enum 命名**（複用 PHASE-002 AuditLog） | **單一 `PARAMETER_VERSION_CREATED` + `summary.parameterType` 區分三類** | 與 PHASE-002「一動作一 enum」慣例略異 vs 稽核彙整便利；影響 migration 與稽核查詢；屬「可修改但須記錄」之稽核事件型別命名 |
| D7 | 折舊**推導值是否持久化**（每年費用/每公里單價） | **不持久化，即算即回（純函式，避免派生值與來源不一致）** | 派生值一致性 vs 查詢便利；若持久化須於建版寫入且與精度 D3 綁定 |
| **D8** | **金額/單價精度型別**（**含金額語意，必人類批准**） | 油資/ETC `Decimal(10,4)`、車價 `Decimal(12,2)`、折舊年限/預估年里程 `Int`（非小數）、每公里推導單價 `Decimal(_,4)`；一律 `Decimal` 非浮點 | 直接影響金額精度與 PHASE-007 計算；年限是否允許小數（US 未明示，預設整數） |
| D9 | 是否提供「**撤銷未來生效且未被引用之版本**」端點（改/刪之最小開口） | **本 Phase 不提供**（只增不改，US 未要求改/刪；引用保護最強） | 是否擴大 Scope；若人類要求「建錯未來版本可撤銷」再議（需引用偵測前置檢查，介面已預留 §4.7） |
| D10 | 參數端點**授權範圍**：全 requireAdmin vs 一般使用者可讀 | **全 requireAdmin**（維護為管理員功能；一般使用者的參數需求由 PHASE-004/007 申請預覽端點間接滿足） | 是否提前對一般使用者開放參數讀取；影響 AC-19；FE-US-10/18 預覽由後續申請端點回計算結果，非直接讀參數表 |

> 附註（依 Packet「Dependency Permission」）：本 Phase **不新增任何 npm 依賴**。`Decimal` 由 Prisma/`@prisma/client`（既有）提供，金額運算以 Prisma `Decimal`（decimal.js）處理；不引入額外套件。若實作評估認為需要新依賴（如高精度有理數庫），須列為新 D 級決策交 Gate，不得自行安裝。

---

## 12. Architecture / Data Flow 更新建議（供大總管處置，本 Phase 不直接改）

> 依 Packet「Architecture Change Permission: 無（僅提建議）」與「Files Forbidden」，以下僅為建議，**未修改** `ARCHITECTURE.md`／`DATA_FLOW.md`；由大總管於 Gate 後決定是否更新該兩份 DRAFT 文件。

1. **ARCHITECTURE §4.2（Parameter 版本查找）**：建議補註本 Phase 定案之「有效期間表示法」（D2 方案 A：僅 `effectiveFrom` 隱含結束、連續時間線、不重疊退化為生效日唯一）與「依日期查找為後端內部引擎（純函式），PHASE-004/007 呼叫」。目前 §4.2 已載「有效期間不得重疊、依日期選版、被引用不可覆寫」，與本 Spec 一致，僅需補表示法細節。
2. **ARCHITECTURE §4.8（稽核）/ §3 `audit`**：建議補註參數建立稽核複用 PHASE-002 `AuditLog`，並記錄 `AuditAction` 新增值（D6 定案後）。
3. **DATA_FLOW §1.1 / §2.7**：建議補註三類 ParameterVersion 的 `effectiveFrom` 日粒度、推導值不持久化（D7）、引用保護以「只增不改」保證、`parameterHasReferences` 介面契約（本 Phase 回 false，PHASE-004/007 閉環）。§2.7 現有流程與本 Spec §6 一致，僅需補精度（D3/D8）與稽核命名（D6）之定案。
4. **精度決策（D3/D8）** 一旦 Gate 定案，建議同步記入 ARCHITECTURE §4.1（Calculation Engine 折舊段）以確保 PHASE-007 沿用一致單價精度。

---

## 13. Spec 修訂紀錄

| 日期 | 版本 | 變更 | 依據 |
|---|---|---|---|
| 2026-08-01 | DRAFT 建立 | 依 SPEC-003a Packet 建立 PHASE-003a 完整 Spec（§1~§12 + 決策點 D1~D10） | PRD 第 5 節 PHASE-003a（289–307 行）、userstory AD-US-11/12/13、BE-US-14、BE-US-19；PHASE-002 授權/稽核契約；PHASE-003 引用保護/弱關聯思路；ARCHITECTURE §3/§4.2/§4.8、DATA_FLOW §1/§2.7；PHASE-001 錯誤協定/sanitizeForLog |
| 2026-08-01 | Gate 反饋修訂 | Mock UI/整合驗收 Gate **通過**（人類，leonchih）；人類提出導覽缺口：管理員首頁缺少進入參數維護頁的連結。依 Gate 反饋流程新增 §5.2 導覽入口需求（管理員首頁提供 `/admin/parameters` 連結，比照既有 `/admin/users` 模式）。由 implementer 以 TDD 實作、reviewer 輕量複審後合入。此為使用者可見行為之微增，不改既有 AC 語意。 | 使用者 Gate 反饋（2026-08-01，leonchih） |
| 2026-08-02 | UI 修正回合（ui-fix-001） | 人類回報參數維護頁「歷史版本」表格可讀性缺陷：`.param-table` class 無任何 CSS 定義（T6 交付遺漏），瀏覽器預設零內距使生效日期與單價欄目視黏連（`2020-01-01` + `5.0000` 誤讀為 `015.0000`）。批准四項修正：①補 `.param-table` 樣式（比照既有 `.users-table`/`.app-list-table` 慣例）②數值欄靠右對齊 ③折舊表（7 欄）包 `.table-scroll` 橫向捲動 wrapper ④**建立時間顯示格式由 `toLocaleDateString("zh-TW")`（`2026/8/2`）統一為 `YYYY-MM-DD`（`2026-08-02`）**，與生效日期欄一致。①~③為純視覺；④為顯示格式行為變更，本列即其 Spec 依據（原 Spec 未規定建立時間格式）。不改任何 AC 語意、不動後端。 | 使用者批准（2026-08-02，leonchih） |
| 2026-08-01 | DRAFT→ACTIVE | 人類事前批准 Gate 通過：D1~D10 **全數依 spec-writer 建議定案**（D1 三表+泛型服務、D2 僅 effectiveFrom 隱含結束、**D3 每公里單價 Decimal 4 位小數保留、顯示層一般四捨五入、007 末端一次取整為整數**、D4 服務層權威+`@@unique(effectiveFrom)`、D5 專屬 `PARAMETER_PERIOD_OVERLAP`(409)、D6 單一 `PARAMETER_VERSION_CREATED`+summary.parameterType、D7 推導值不持久化、**D8 油資/ETC Decimal(10,4)・車價 Decimal(12,2)・年限/年里程 Int・單價 Decimal(_,4) 一律非浮點**、D9 本 Phase 不提供撤銷端點、D10 全 requireAdmin）。金額語意 D3/D8 經人類明確批准。轉 ACTIVE，開始 TDD。 | 使用者 Gate 批准（2026-08-01，leonchih） |
| 2026-08-03 | CHORE-003 錯誤合約修訂（新增 §14） | 依人類 leonchih 2026-08-03 於 **PHASE-005 Spec Gate 之 D1(b) 裁定**（「另開 chore 回合：先修訂 PHASE-003a Spec 錯誤合約（新增 400 情境＋精度截斷拒絕＋『不可解析→400』），再 implementer TDD → reviewer 複審」，AR-5「字串全保真」同案處理），**新增 §14** 定義參數欄位容量／精度／字串保真之修訂後驗證合約：欄位逐欄盤點、行為變更對照表（B-01~B-26）、新增 **AC-21~AC-32**、AC↔測試映射表、Task 拆分（CHORE-003-T1~T3）與受影響既有測試盤點。**§1~§13 主體維持 `COMPLETED` 且未被改寫**（既有 AC-01~AC-20 語意、成功路徑、409/401/403 合約一律不變）；**§14 之狀態為 `ACTIVE`（CHORE-003 待實作）**。§14.4 之 CD-1（前後空白字串處置）、CD-2（非標準十進位字面）、CD-3（折舊整數欄位是否納入）為方向內尚待人類定案之細項，**未裁定不得開工**。本次不新增 `ErrorCode`、不新增依賴、不改資料模型／migration／授權／稽核／前端。 | 人類 leonchih 2026-08-03 PHASE-005 Spec Gate 批准（D1(b)；見 `docs/specs/PHASE-005.md` §16 D1 與 §18 修訂紀錄）；PROJECT_STATE 跨 Phase 追蹤事項 2026-08-03 條目；CHORE-002 R2 AR-5 |
| 2026-08-03 | CD-1~CD-3 裁定固化（大總管） | §14.4 三決策點經人類裁定**全數採推薦選項 (a)**：**CD-1(a)** 前後空白 trim 後判定（`vehiclePrice` 含空白由 400 放寬為 201 之唯一放寬變更已明示並批准）；**CD-2(a)** 非標準十進位字面（`"1e5"`／`".5"`／`"19."`／`"+19.9"`／`"0x10"` 等）一律 400，僅收標準十進位字面；**CD-3(a)** 折舊整數欄位（`usefulLifeYears`／`estimatedAnnualKm`）之 int4 容量守門納入本回合（AC-28 保留）。§14 全部 AC-21~AC-32 就此定案，CHORE-003 可開工實作。 | 人類 leonchih 2026-08-03 裁定（CD-1/2/3 皆選推薦選項） |
| 2026-08-03 | CHORE-003-SPEC-SYNC（T1~T3 後同步） | **僅將 §14 同步至實作現實，未改動任何 AC 條文本體、§14.4 決策點、§14.2 合約，亦未動 §1~§13 既有內容。** ①**§14.1**：原「待實作觀測（TDD 紀律）」結案回填為「舊行為實測結果」——兩個 `Int` 欄位之現行溢位行為經 T2 於真實 Postgres 實測確認為 **500**，分屬 `PrismaClientUnknownRequestError`（DB 端 int4 溢位）與 `PrismaClientValidationError`（超出 Prisma `Int` 可接受範圍，如 `1e21`）兩類，兩類日誌**均含絕對來源路徑**（故 AC-31 對本欄位同樣必要）；容量盤點表該列「非 400」改為「500」。②**§14.6 映射表**：改採 PHASE-005 §12 之機械可查格式（新增 `Task`／`狀態` 欄），測試名以三個新增測試檔之**實際 `describe > it` 逐字回填**；**AC-29 拆為結構性（U(structural)）／行為等值（I）兩列**（依 AC-29 明文「單純比較兩路徑結果無鑑別力」）；全表 13 列狀態 `GREEN`、`PENDING` 0 列；新增覆蓋核對與表註 1~4（含反向核對：三檔共 133 條，4 條為刻意保留之附加鑑別）。③**§14.7**：「順帶消除 AR-1 同形雙拷貝」加註**未採用**及理由（`parseParameterDecimalField` 不接受 `Prisma.Decimal` 實例、且附加小數位／量級守門，改用會改變 `deriveDepreciation` 之既有契約——即 §14.8 第 6 項明示須停止之情形）；**AR-1 維持追蹤**。④**§14.8**：第 1、2 項標記 ✅ 已完成（T3 `17cc428`）並記錄完成情形；第 6 項標記實際零變更並記錄未採用共用 helper 之結論。⑤§14 本節狀態之括號敘述由「待實作」更新為「T1~T3 已實作，待終局複審與人類合併批准」（狀態值 `ACTIVE` 未變）。 | CHORE-003-T1 commit `ca2267d`／T2 commit `dcad263`／T3 commit `17cc428` 及各自即審／複審 `APPROVE`；大總管 T2「過渡紅燈」裁定（紅燈集合精確吻合 §14.8 逐字預告，由 T3 關閉）；CD-1(a)／CD-2(a)／CD-3(a) 人類裁定（2026-08-03，leonchih）；治理 2026-08-02.1（AC↔測試映射表為終審核對依據） |

> 狀態轉移：DRAFT →（人類事前批准 D1~D10，其中 D3/D8 為金額語意必批）→ ACTIVE → 實作（TDD）→ COMPLETED。
> 補充（治理 2026-08-01.2）：本 Spec 屬 High 風險文件，定義 High 風險行為（影響金額之受引用參數）。Gate 中人類提出之任何變更，須先由 spec-writer/大總管完成本 Spec 修訂（引用該批准與日期）後方可實作。

---

## 14. CHORE-003 錯誤合約修訂——參數欄位容量、精度與字串保真（2026-08-03）

| 項目 | 內容 |
|---|---|
| **本節狀態** | `ACTIVE`（CHORE-003 T1~T3 已實作並各自通過即審／複審；待終局複審與人類合併批准後轉 `COMPLETED`）。**§1~§13 主體維持 `COMPLETED` 且不受本節改寫**——本節只**新增** AC-21~AC-32 與新增之 400 情境，既有 AC-01~AC-20 之語意、既有成功路徑與 409/401/403 合約一律不變。 |
| **Task ID（產出本節）** | CHORE-003-SPEC |
| **批准依據** | 人類 leonchih 2026-08-03 PHASE-005 Spec Gate 裁定 **D1(b)**：「另開 chore 回合：先修訂 **PHASE-003a Spec** 錯誤合約（新增 400 情境＋精度截斷拒絕＋『不可解析→400』），再 implementer TDD → reviewer 複審」；**AR-5**（CHORE-002 R2 資訊性 Accepted Risk）之「字串全保真＋不可解析→400」經同一裁定併入本回合同案處理。 |
| **風險等級** | **High**（使用者可見錯誤合約變更；金額參數領域）。變更**方向**已批准；本節 §14.4 之 CD-1~CD-3 為方向內尚待人類定案的細項，**未裁定者不得開工**。 |
| **範圍** | 僅 `parameters` 模組之三個 POST 端點的**輸入驗證層**。不改資料模型、不改 migration、不改授權、不改稽核、不改前端、不新增 `ErrorCode`、不新增依賴。 |
| **不變式** | 修訂後三端點之錯誤碼集合仍為 **400 `VALIDATION_ERROR` / 409 `PARAMETER_PERIOD_OVERLAP` / 401 `UNAUTHORIZED` / 403 `FORBIDDEN`（含 `PASSWORD_CHANGE_REQUIRED`）**，且**不得**出現 500（本回合的目的即為消滅既有 500 路徑）。 |

### 14.1 事實基準（現況缺陷）與欄位容量逐欄盤點

**引用（PROJECT_STATE 跨 Phase 追蹤條目原文，CHORE-002 reviewer 查出）：**

> `unitPrice` 落於 `[1e6, Decimal(10,4) 上限外)`、`vehiclePrice` 落於 `[1e10, Decimal(12,2) 上限外)` 時，DB 層拋錯 → **500**（string／number 皆然），違反 PHASE-003a Spec 錯誤合約（該端點僅列 400/409/401/403）。另 `unitPrice:"0.0000001"` **靜默存為 `0.0000`**（精度截斷無提示）。正解：比照 `backend/src/applications/trip-validation.ts` 之綁欄位容量範圍驗證（十進位字面 pattern + 量級上限，見該檔 `parseKmField` 之 `DECIMAL_LITERAL_PATTERN` 與 `KM_MAGNITUDE_LIMIT`）。

**逐欄盤點（本節 AC 之權威欄位清單；容量欄依 `backend/prisma/schema.prisma` 現行定義）：**

| 欄位 | 端點 | Prisma 型別 | 小數位上限（scale） | 量級上限（絕對值） | 現行超出時之行為 |
|---|---|---|---|---|---|
| `unitPrice` | `POST /parameters/fuel` | `Decimal @db.Decimal(10, 4)` | **4** | **< 1e6**（整數部分最多 6 位） | ≥1e6 → **500**；>4 位小數 → **靜默截斷**（`"0.0000001"` 存為 `0.0000`） |
| `unitPrice` | `POST /parameters/etc` | `Decimal @db.Decimal(10, 4)` | **4** | **< 1e6** | 同上 |
| `vehiclePrice` | `POST /parameters/depreciation` | `Decimal @db.Decimal(12, 2)` | **2** | **< 1e10**（整數部分最多 10 位） | ≥1e10 → **500**；>2 位小數 → **靜默取整**（PostgreSQL `numeric(12,2)` 進位） |
| `usefulLifeYears` | `POST /parameters/depreciation` | `Int`（PostgreSQL `integer` / int4） | —（僅整數） | **≤ 2147483647** | ≥2^31 之整數通過現行 `Number.isInteger && > 0` 檢查後於持久化層失敗 → **500**（T2 實測確認，詳見下方「舊行為實測結果」） |
| `estimatedAnnualKm` | `POST /parameters/depreciation` | `Int`（int4） | — | **≤ 2147483647** | 同上 |
| `effectiveFrom` | 三端點 | `DateTime @db.Date` | — | — | 已有 400（AC-06），**本回合不變** |

- **舊行為實測結果（2026-08-03 回填；原「待實作觀測」已結案）**：本 Spec 定稿時因 worktree 無 DB 而將兩個 `Int` 欄位的現行狀態碼列為未實測。**CHORE-003-T2（commit `dcad263`）於真實 Postgres 上以修復前 RED 測試實測確認：現行行為為 500**，且分屬**兩類驅動層例外**——`PrismaClientUnknownRequestError`（值進得了 Prisma 層、於 DB 端 int4 溢位）與 `PrismaClientValidationError`（值超出 Prisma `Int` 可接受範圍而在送出前即被拒，如 `1e21`）；**兩類之伺服器日誌均含絕對來源路徑**，故 AC-31 之「日誌不外洩」斷言對本欄位同樣必要（非僅適用於兩個 `Decimal` 欄位）。修訂後此情境一律回 400（AC-28／B-25），與 `unitPrice`／`vehiclePrice` 之 500 路徑同時消滅。**證據**：T2 修復前紅燈輸出（見 CHORE-003-T2 Handoff 與 commit `dcad263` 訊息第二項）。
- **非本回合範圍之 Decimal 欄位**：`TripSegment.totalKm` / `highwayKm`（已由 PHASE-004 `parseKmField` 綁容量守門）；`TravelApplication` / `TripSegment` 之快照欄位（伺服器端計算值，非使用者直接輸入）——後者另見 §14.9 之跨 Phase 提醒。

### 14.2 修訂後之輸入驗證合約

**分層（沿用 `trip-validation.ts` 的 format / business 兩層切分）：**

1. **格式層（本回合新增／強化）**：型別 → 十進位字面 → 小數位 → 欄位容量量級。任一失敗 → **400 `VALIDATION_ERROR`**，`fields` 精確定位欄位。
2. **值域層（既有，不變）**：油資／ETC `unitPrice ≥ 0`（AC-03）；折舊 `vehiclePrice > 0`、`usefulLifeYears > 0` 且為整數、`estimatedAnnualKm > 0` 且為整數（AC-05）。

**檢查順序（決定性要求，AC-32）**：`型別 → 十進位字面 → 小數位 → 量級 → 值域`。同一欄位多重違規時，**先命中者決定 `reason`**；**跨欄位**（折舊三欄）則沿用既有「一次回報所有違規欄位」之行為（AC-05 不變）。

**路由層不變**：`backend/src/parameters/routes.ts` 之 `accept-any` body schema **維持不變**（`unitPrice: {}` 等），服務層仍為驗證權威。理由：改由 ajv schema 擋下會產生**不同的錯誤形狀**（非 `fields` 定位之 `VALIDATION_ERROR`），破壞 AC-03/05 與 CHORE-001/CHORE-002 已固化的 4xx wire-level 合約。既有的「必填」缺值檢查（`undefined` / `null` / `""` → 400 `單價為必填`）亦維持不變。

**`reason` 文案（zh-TW，面向使用者，不外洩內部細節）：**

| 情境 | `reason` |
|---|---|
| 非字串亦非數字之型別（boolean / array / object） | `必須為有效的數值（字串或數字）` |
| 空字串或全空白字串 | `必須為有效的數值` |
| 非十進位字面（指數記號、前導 `+`、缺整數部 `.5`、缺小數部 `19.`、十六進位 `0x10`、`Infinity`、`NaN`、`abc`） | `必須為有效的十進位數值（不接受指數記號）` |
| 小數位超出欄位 scale | `最多允許 4 位小數`（`unitPrice`）／`最多允許 2 位小數`（`vehiclePrice`） |
| 量級超出欄位容量 | `數值超出可儲存範圍（整數部分最多 6 位）`（`unitPrice`）／`（整數部分最多 10 位）`（`vehiclePrice`） |
| 整數欄位超出 int4 | `數值超出可儲存範圍（最大 2147483647）` |
| 值域：單價 < 0 | `單價不得小於 0`（**不變**） |
| 值域：車價 ≤ 0 | `必須大於 0`（**不變**） |
| 整數欄位非整數 / ≤ 0 | `必須為整數且大於 0` ／ `必須大於 0`（**不變**） |

> **文案變更提醒**：折舊 `vehiclePrice` 之「無法解析」路徑，現行 `reason` 為 `必須為有效數值且大於 0`（`parameter-service.ts` catch 分支），修訂後改為上表之格式層文案。此為本回合明文批准之文案調整，連帶影響一個既有測試的精確斷言（見 §14.8 第 2 項）——屬**依 Spec 更新斷言**，非弱化測試。

**字串保真（AR-5 閉環）**：修訂後，**字串輸入路徑不得經過 `Number()`**——trim 後的十進位字面直接交給 `new Prisma.Decimal(literal)`，值域比較亦以 `Prisma.Decimal` 方法進行（不再以 `priceNum` 比較）。`number` 輸入路徑以 `value.toString()`（JS 自身最短往返字串轉換）進入同一管線；該路徑的浮點性**源自 JSON number 本身（IEEE 754）**，本層不再引入新的中介。實作完成後，程式註解與文件方可敘述「字串路徑不經浮點中介」；在此之前**不得**如此宣稱（AR-5 原警語）。
> 連帶清理：`parameter-service.ts` 現有引用 `priceNum` 之 S-3 註解（`createFuelVersion` / `createEtcVersion` 內）於修訂後失效，須由 implementer 同步更新為新事實，避免註解與實作背離。

### 14.3 行為變更對照表（變更前 → 變更後）

> 逐條標記供追溯。「**變更**」＝使用者可見行為改變；「不變」＝納入零回歸反向斷言（AC-30）。`(CD-1)` / `(CD-2)` 表示該列結果取決於 §14.4 對應決策點之裁定，以**推薦選項**列示。

| # | 輸入（`unitPrice`，油資／ETC） | 變更前 | 變更後 | 類別 |
|---|---|---|---|---|
| B-01 | `0`、`3.5`、`"3.5000"`、`"1.2345"` | 201 | 201（值不變） | 不變 |
| B-02 | `-1` | 400 `unitPrice` | 400 `unitPrice` | 不變 |
| B-03 | 缺欄位／`null`／`""` | 400 `單價為必填` | 400（同） | 不變 |
| B-04 | `"abc"` | 400 | 400（`reason` 改為格式層文案） | 文案變更 |
| B-05 | `"19.90000"`（尾隨零） | 201 存 `19.9000` | 201 存 `19.9000` | 不變（**鑑別關鍵**：尾隨零不得誤判為超精度） |
| B-06 | `" 19.9 "`（前後空白） | 201 存 `19.9000` | 201 存 `19.9000`（trim 後判定） | 不變 **(CD-1)** |
| B-07 | `"   "`（全空白） | 201 存 `0.0000`（`Number("   ")===0`） | **400** | **變更** |
| B-08 | `true` | 201 存 `1.0000` | **400** | **變更** |
| B-09 | `false` | 201 存 `0.0000` | **400** | **變更** |
| B-10 | `[]` / `["5"]` | 201 存 `0.0000` / `5.0000` | **400** | **變更** |
| B-11 | `{}` | 400（`Number({})` 為 `NaN`） | 400 | 不變 |
| B-12 | `"1e5"` | 201 存 `100000.0000` | **400** | **變更 (CD-2)** |
| B-13 | `".5"` / `"19."` / `"+19.9"` / `"0x10"` | 201 存 `0.5000` / `19.0000` / `19.9000` / `16.0000` | **400** | **變更 (CD-2)** |
| B-14 | `"Infinity"` / JSON number `1e400`（解析為 `Infinity`） | **500**（DB 層） | **400** | **變更（消滅 500）** |
| B-15 | `"0.0000001"`、number `0.00001` | 201 **靜默存 `0.0000`** | **400**（`最多允許 4 位小數`） | **變更（D1(b) 明列：精度截斷拒絕）** |
| B-16 | `"999999.9999"`（容量上界內最大值） | 201 | 201 | 不變（**邊界**） |
| B-17 | `"1000000"`（1e6）、`"12345678"` | **500** | **400**（`超出可儲存範圍`） | **變更（消滅 500）** |

| # | 輸入（`vehiclePrice`／折舊整數欄位） | 變更前 | 變更後 | 類別 |
|---|---|---|---|---|
| B-18 | `"500000.00"`、`500000`、`0`、`-100` | 201／201／400／400 | 同 | 不變 |
| B-19 | `"abc"` | 400（`reason`＝`必須為有效數值且大於 0`） | 400（`reason` 改為格式層文案） | 文案變更 |
| B-20 | `" 600000 "`（前後空白） | **400**（`Decimal` 建構丟出 → catch） | **201**（trim 後判定） | **變更（放寬）(CD-1)** |
| B-21 | `"600000.005"`（3 位小數） | 201 **靜默進位存 `600000.01`** | **400**（`最多允許 2 位小數`） | **變更** |
| B-22 | `"9999999999.99"`（容量上界內最大值） | 201 | 201 | 不變（**邊界**） |
| B-23 | `"10000000000"`（1e10） | **500** | **400** | **變更（消滅 500）** |
| B-24 | `usefulLifeYears` / `estimatedAnnualKm` `= 2147483647` | 201 | 201 | 不變（**邊界**） |
| B-25 | `usefulLifeYears` / `estimatedAnnualKm` `= 2147483648`、`3e9`、`1e21` | **非 400**（見 §14.1 待實作觀測） | **400** | **變更（消滅非 400 路徑）(CD-3)** |
| B-26 | `usefulLifeYears = 2.5`、`= 0`、`= -1` | 400 定位欄位 | 同 | 不變 |

> **B-20 特別註記**：此為**唯一放寬方向**的變更（400 → 201）。D1(b) 之批准方向為「消滅 500／拒絕精度截斷／不可解析→400」（皆為收緊），放寬不在其字面範圍內，故列為 **CD-1** 交人類於 CHORE-003 Gate 一併裁定，不得由 AI 自行定案。

### 14.4 需人類批准之決策點（CD-1~CD-3）

> 未裁定者相關 AC 不得開工。三項皆為「已批准方向內」的細項，建議於同一次 CHORE-003 Gate 一併裁定。

**CD-1 — 前後空白字串之處置（影響 B-06、B-20）**

| 選項 | 內容 | 影響 |
|---|---|---|
| **(a) trim 後判定（推薦）** | 字串先 `.trim()`，再套用十進位字面 pattern | ① 與 Packet 明列之「正解」`parseKmField` **完全同形**（該函式即先 trim 再比對 pattern）；② 保留 CHORE-002 R2（2026-08-02 定案）之 `" 19.9 "` → 201 行為，不製造相隔一日的反覆；③ **消除現行 `unitPrice`（接受空白）與 `vehiclePrice`（拒絕空白）之不對稱**——該不對稱本身即缺陷；④ 代價：`vehiclePrice` 由 400 放寬為 201（B-20） |
| (b) 不 trim，含空白一律 400 | 任何前後空白 → 400 | ① 全部方向皆為收緊，完全落在 D1(b) 字面內；② 但推翻 CHORE-002 R2 剛定案之行為（B-06 由 201 變 400），且與 `parseKmField` 不同形，四個欄位仍不對稱（里程接受空白、單價不接受） |

**推薦：(a)**。理由：Packet 指定的參照實作即為 trim 語意；空白是傳輸層雜訊而非值語意差異（trim 後**值完全保真**）；且能一次消除既有的欄位間不對稱。
> 若裁定 (b)：AC-27 之期望改為「`" 19.9 "` → 400」，B-06 改列「變更」、B-20 改列「不變」，§14.8 第 1 項之既有測試斷言須由 201 改為 400。

**CD-2 — 非標準十進位字面之處置（影響 B-12、B-13）**

| 選項 | 內容 | 影響 |
|---|---|---|
| **(a) 一律 400（推薦）** | 採 `^-?\d+(\.\d+)?$` pattern：拒絕指數記號、前導 `+`、`.5`、`19.`、`0x10`、`Infinity`、`NaN` | ① 與 `parseKmField`／PHASE-004 D5 先例一致；② 字面即所存值，稽核可讀、無「`1e5` 究竟存了多少」的解讀歧義；③ 同時天然攔下 `Infinity`／`NaN`（`Prisma.Decimal` **會**接受此二字面，且其 `decimalPlaces()` 回 `NaN`——若僅靠小數位檢查會**漏放**，見下方實作警示）；④ 代價：`"1e5"` 這類「可解析且在容量內」的輸入由 201 變 400，嚴格說略超出「不可解析→400」之字面 |
| (b) 僅拒絕 `Prisma.Decimal` 無法解析者 | 允許指數記號等 | 需另行明確處理 `Infinity`／`NaN`（否則仍是 500）；且相同數值有多種字面，稽核與測試面擴大 |

**推薦：(a)**。
> **實作警示（無論裁定何者皆適用）**：`new Prisma.Decimal("Infinity")` 與 `new Prisma.Decimal("NaN")` **不會拋出**，且其 `.decimalPlaces()` 回傳 `NaN`——`NaN > 4` 為 `false`，故**小數位檢查不會擋下它們**。必須以 pattern 或顯式 `isFinite` 判定攔截，否則 B-14 的 500 依舊存在。（此為本 Task 於 `@prisma/client` 實測確認之行為。）

**CD-3 — 折舊整數欄位（`usefulLifeYears` / `estimatedAnnualKm`）是否納入本回合（影響 B-25、AC-28）**

| 選項 | 內容 | 影響 |
|---|---|---|
| **(a) 納入（推薦）** | int4 容量守門一併補上 | 與 `unitPrice`／`vehiclePrice` **屬完全相同的缺陷類**（欄位容量溢位 → 非 400）；同一模組同一次修改成本近乎為零；不納入則留一個已知的 500 路徑於正式碼 |
| (b) 不納入 | 僅處理 PROJECT_STATE 條目字面所列的兩個 Decimal 欄位 | 追蹤條目字面確實只列 `unitPrice`／`vehiclePrice`；但會留下同類缺口，且需另開追蹤項 |

**推薦：(a)**。AC-28 已獨立編號，若裁定 (b) 可整條剔除而不影響其他 AC。

### 14.5 新增 Acceptance Criteria（AC-21~AC-32）

> 編號續接既有 AC-01~AC-20（既有 AC 一律不改）。所有新 AC 之錯誤回應**一律** `400 VALIDATION_ERROR` + `fields[]`，**不新增 `ErrorCode`**。

**AC-21 `unitPrice` 量級上限綁欄位容量（油資／ETC，CHORE-003 / T1, T2）**
- Given 管理員提交 `unitPrice` 之絕對值 **≥ 1e6**（如 `"1000000"`、`1000000`、`"12345678.9"`、`"-1000000"`）。
- When `POST /parameters/fuel` 或 `POST /parameters/etc`。
- Then 回 **400 `VALIDATION_ERROR`**，`fields` 含 `{ field: "unitPrice" }` 且 `reason` 為 `數值超出可儲存範圍（整數部分最多 6 位）`；**不建立版本**；回應不含 DB 錯誤原文／堆疊。
- **鑑別力**：必須同時測 **`"999999.9999"` → 201**（上界內最大值）與 **`"1000000"` → 400**（上界），才能捕捉「上限值寫錯一個數量級」與「用 `>` 而非 `>=`」；上限常數須綁 `Decimal(10,4)` 之容量推導（`10 - 4 = 6` 位整數），不得寫死無來源的魔術數。

**AC-22 `vehiclePrice` 量級上限綁欄位容量（折舊，CHORE-003 / T1, T2）**
- Given `vehiclePrice` 絕對值 **≥ 1e10**（如 `"10000000000"`）。
- When `POST /parameters/depreciation`。
- Then 400，`fields` 含 `vehiclePrice`，`reason` 為 `數值超出可儲存範圍（整數部分最多 10 位）`；不建立版本；**不進行折舊推導**（沿用 AC-05 之「無效輸入不推導」紀律）。
- **鑑別力**：`"9999999999.99"` → 201 與 `"10000000000"` → 400 兩邊界必測。

**AC-23 `unitPrice` 精度超出欄位小數位 → 拒絕，不靜默截斷（CHORE-003 / T1, T2）**
- Given `unitPrice` 之**有效小數位 > 4**（如 `"0.0000001"`、`"1.23456"`、number `0.00001`）。
- When 提交建立。
- Then 400，`fields` 含 `unitPrice`，`reason` 為 `最多允許 4 位小數`；**不建立版本**（現行為靜默存 `0.0000`，本回合明文廢止）。
- **鑑別力（關鍵）**：必須測 **`"19.90000"`（尾隨零）→ 201 且存 `19.9000`**——小數位須以**正規化後的值**（`Prisma.Decimal#decimalPlaces()`，尾隨零已被剝除）判定，而非字面字元數；沿用 `parseKmField` 之同一決策。同時測 `"1.2345"` → 201（恰為上界 4 位）。

**AC-24 `vehiclePrice` 精度超出 2 位小數 → 拒絕（CHORE-003 / T1, T2）**
- Given `vehiclePrice` 有效小數位 **> 2**（如 `"600000.005"`）。
- Then 400，`fields` 含 `vehiclePrice`，`reason` 為 `最多允許 2 位小數`；不建立版本（現行為靜默進位存 `600000.01`）。
- **鑑別力**：`"600000.00"`／`"600000.5"`／`"600000.05"` → 201；`"600000.005"` → 400；並測 `"600000.500"`（尾隨零）→ 201，證明判定基於值而非字面。

**AC-25 非十進位字面 → 400（AR-5「不可解析→400」，CHORE-003 / T1, T2）**
- Given `unitPrice` 或 `vehiclePrice` 為 `"abc"`、`"1e5"`、`".5"`、`"19."`、`"+19.9"`、`"0x10"`、`"Infinity"`、`"NaN"`，或 number 型別的 `1e-7`、`1e21`、`1e400`（JSON 解析為 `Infinity`）、`NaN`。
- Then **400**，`fields` 定位對應欄位，`reason` 為 `必須為有效的十進位數值（不接受指數記號）`；不建立版本。
- **鑑別力**：`"Infinity"` 與 `1e400` 兩例為**本回合消滅 500 的核心證據**，必測且必須斷言**狀態碼為 400 而非 500**；並須有一條測試證明「小數位檢查單獨無法擋下 `Infinity`」之防呆仍在（見 CD-2 實作警示）。
- 依 CD-2 裁定：若採 (b)，`"1e5"`／`".5"`／`"19."`／`"+19.9"`／`"0x10"` 之期望改為 201，`"Infinity"`／`"NaN"`／`1e400` 仍為 400。

**AC-26 非數值型別 → 400（CHORE-003 / T1, T2）**
- Given `unitPrice`／`vehiclePrice` 為 `true`、`false`、`[]`、`["5"]`、`{}` 等既非字串亦非數字之 JSON 值（route 為 accept-any，此類值可到達服務層）。
- Then **400**，`fields` 定位欄位，`reason` 為 `必須為有效的數值（字串或數字）`；不建立版本。
- **鑑別力**：`true` 現行存為 `1.0000`、`[]` 現行存為 `0.0000`——兩者皆為**靜默寫入錯誤金額參數**，必測；並斷言 DB 中確實**沒有**新增列（不能只斷言狀態碼）。

**AC-27 前後空白字串之處置（CHORE-003 / T1, T2；依 CD-1 裁定）**
- 採 CD-1 **(a)** 時：Given `" 19.9 "` → Then **201** 且存 `19.9000`；Given `" 600000 "`（`vehiclePrice`）→ **201** 存 `600000.00`；Given `"   "`（全空白）→ **400**（`必須為有效的數值`）；Given `" abc "` → **400**。
- 採 CD-1 **(b)** 時：上述含空白者一律 **400**。
- **鑑別力**：`"   "` 現行經 `Number("   ")` 為 `0` 而**靜默存入 `0.0000`**，無論 CD-1 採何選項皆須為 400，此條可獨立於 CD-1 驗證。

**AC-28 折舊整數欄位容量上限（CHORE-003 / T1, T2；依 CD-3 裁定，採 (b) 時整條剔除）**
- Given `usefulLifeYears` 或 `estimatedAnnualKm` 為 **≥ 2147483648**（即 2^31）之整數（`2147483648`、`3e9`、`1e21`——三者 `Number.isInteger` 皆為 `true`，故現行值域檢查放行）。
- Then **400**，`fields` 精確定位違規欄位，`reason` 為 `數值超出可儲存範圍（最大 2147483647）`；不建立版本；不推導。
- **鑑別力**：`2147483647` → 201（上界內最大）與 `2147483648` → 400（上界）必測；兩欄位**各測一次**（避免只守其中一欄）。

**AC-29 字串路徑保真且不經浮點中介（AR-5 閉環，CHORE-003 / T3）**
- Given 同一數值之字串與等值 number 兩種輸入（如 `"19.9"` vs `19.9`、`"0.1"` vs `0.1`）。
- When 分別建立版本。
- Then 兩者存入與回傳之 DTO **完全相同**；且**字串路徑之程式路徑上不存在 `Number(...)` 對輸入的呼叫**（值域比較改以 `Prisma.Decimal` 方法進行）。
- **鑑別力**：需一條**結構性斷言**（如對 `parameters` 模組原始碼之靜態檢查，或以「僅字串可表達、`Number()` 會失真」之值作行為鑑別）——單純比較兩路徑結果**無鑑別力**（現行實作亦會通過，見 AR-5：`Decimal(10,4)` 下 double 中介不可觀測）。實作者須明確選定並在 Handoff 說明其鑑別力來源。
- 同時要求：`parameter-service.ts` 中引用 `priceNum` 之 S-3 註解、以及任何宣稱字串路徑行為的文字，須與修訂後實作一致。

**AC-30 既有成功／409／401／403 路徑零回歸（反向斷言，CHORE-003 / T2）**
- Given 既有 AC-01~AC-20 之全部情境。
- When 於修訂後執行既有測試套件。
- Then **全數維持原結果**：合法輸入 201／列表 200（含 `derived` 值不變）、重疊 409 `PARAMETER_PERIOD_OVERLAP`（含 `details.conflictVersion`）、未登入 401、非管理員 403、`mustChangePassword` 403、稽核 `AuditLog` 寫入內容與 `summary` 形狀不變。
- **鑑別力**：須特別涵蓋 `unitPrice = 0`（值域下界，不得被新的格式層誤擋）、`"3.5000"`／`"1.2345"`（精度上界內）、`-1`（既有值域 400 之 `field` 與行為不變）、以及 `Decimal` round-trip 精度測試（既有「Precision: unitPrice Decimal round-trip」段落）。

**AC-31 錯誤形狀與不外洩（CHORE-003 / T2）**
- Given 任一新增之 400 情境。
- Then 回應 body 為統一格式 `{ error: { code: "VALIDATION_ERROR", message, requestId, fields } }`；**不含** DB 錯誤原文、SQL、堆疊、內部路徑或欄位型別定義字串；伺服器日誌亦不得記錄 DB 錯誤原文（沿用 `sanitizeForLog` + pino redact 慣例）；三端點**不再產生任何 500**。
- **鑑別力**：對 B-14／B-17／B-23 三個原 500 情境，除斷言 400 外，須斷言回應 body 與日誌**不含**驅動層訊息片段。

**AC-32 檢查順序決定性與多欄位彙總（CHORE-003 / T1）**
- Given 同一欄位同時違反多項規則（如 `"-0.0000001"`：負值＋超精度；`"1e21"`：非十進位字面＋超量級）。
- Then `reason` 依 §14.2 固定順序（型別 → 字面 → 小數位 → 量級 → 值域）之**先命中者**產生，結果可重現。
- Given 折舊三欄同時違規（如 `vehiclePrice="600000.005"` 且 `usefulLifeYears=0`）。
- Then `fields` **同時包含**兩欄位（沿用 AC-05 之多欄位彙總行為）。
- **鑑別力**：純函式單元測試層即可完整覆蓋；須含至少兩組「多重違規」案例以固定順序，避免實作改動時 `reason` 漂移而無測試察覺。

### 14.6 AC↔測試映射表（治理 2026-08-02.1）

> **格式**：`AC` ｜ `層級` ｜ `測試檔` ｜ `測試名` ｜ `Task` ｜ `狀態`（沿用 PHASE-005 §12 之機械可查慣例，治理 2026-08-02.1）。
> 層級：U＝unit（無 DB）、I＝integration（真實 route／service + Postgres）、U(structural)＝對原始碼之靜態結構斷言（無 DB）。
> 狀態值：`PENDING`（Spec 階段）／`RED`（測試已寫且失敗）／`GREEN`（實作完成通過）。**Phase／回合完成前之覆蓋檢查與終審核對以本表為準。**
> **`GREEN` 列之測試名為實際存在之測試名（逐字可 `grep`）**；巢狀以 `describe > it` 表示，同 `describe` 下之其餘測試以 `… > ` 續接。
> 本表之 `GREEN` 依據：CHORE-003-T1（commit `ca2267d`，unit 50 條）／T2（commit `dcad263`，integration 69 條、AC-30 主證四檔 84/84 零修改全綠）／T3（commit `17cc428`，string-fidelity 14 條）各自結案並經即審／複審 `APPROVE`；T3 大總管獨立驗收全套兩輪 1211/0/0（2026-08-03）。

| AC | 層級 | 測試檔 | 測試名 | Task | 狀態 |
|---|---|---|---|---|---|
| AC-21 | U + I | `backend/test/unit/parameter-validation.test.ts`；`backend/test/integration/chore003-parameter-field-capacity.test.ts` | U：`AC-21 unitPrice ≥1e6 → 400（含 999999.9999 → 201 上界鑑別） > 上界內最大值 "999999.9999" 通過且值保真`；`… > 恰為上界 "1000000" 被拒（捕捉 > 與 >= 之誤用）`；`… > number 型別 1000000、字串 "12345678.9" 同樣被拒`；`… > 負向同樣以絕對值判定："-1000000" 被拒、"-999999.9999" 通過格式層`；`… > error.field 精確回傳呼叫端指定之欄位名`；容量常數綁欄位定義：`容量常數綁 Prisma 欄位定義推導（§14.7 實作備註） > decimalColumnCapacity(precision, scale) 推導整數位數 = precision - scale`；`… > unitPrice 綁 Decimal(10,4)、vehiclePrice 綁 Decimal(12,2)、整數欄位綁 int4`。I：`CHORE-003-T2 參數欄位容量／精度／字串保真（I 層） > AC-21 unitPrice ≥1e6 → 400（含 999999.9999 → 201 上界鑑別） > 上界內最大值 '999999.9999' → 201 且原值存入（B-16，證明上限非寫小一個數量級）`；`… > 上界 '1000000'（1e6）→ 400 量級文案 且 DB 無新增列（B-17，原為 500）`；`… > number 型別 1000000 → 400 量級文案（string／number 同一管線）`；`… > '12345678.9' → 400 量級文案（AC-21 明列案例）`；`… > '-1000000' → 400 **量級**文案而非「單價不得小於 0」（AC-21／AC-32：格式層先於值域層）`；`… > ETC 端點同守門：'999999.9999' → 201；'1000000' → 400 且 DB 無新增列` | T1, T2 | GREEN |
| AC-22 | U + I | 同上兩檔 | U：`AC-22 vehiclePrice ≥1e10 → 400（含 9999999999.99 → 201 上界鑑別） > 上界內最大值 "9999999999.99" 通過且值保真`；`… > 恰為上界 "10000000000" 被拒`；`… > 量級文案依欄位容量而異（6 位 vs 10 位），不共用同一字串`。I：`… > AC-22 vehiclePrice ≥1e10 → 400（含 9999999999.99 → 201 上界鑑別） > 上界內最大值 '9999999999.99' → 201 且原值存入（B-22）`；`… > 上界 '10000000000'（1e10）→ 400 量級文案、DB 無新增列、回應不含 derived（B-23，原為 500）` | T1, T2 | GREEN |
| AC-23 | U + I | 同上兩檔 | U：`AC-23 unitPrice >4 位小數 → 400；尾隨零 "19.90000" → 201 > "0.0000001"、"1.23456"、number 0.00001 皆被拒（不再靜默截斷為 0.0000）`；`… > 尾隨零 "19.90000" 通過並存 19.9000（以值而非字面字元數判定）`；`… > 恰為上界 4 位小數 "1.2345"、以及 "3.5000"／0 通過`。I：`… > AC-23 unitPrice >4 位小數 → 400；尾隨零 '19.90000' → 201 > '0.0000001' → 400 小數位文案 且 DB 無新增列（B-15，原為靜默存 0.0000）`；`… > '1.23456' → 400 小數位文案`；`… > number 0.00001 → 400 小數位文案（number 路徑同守門）`；`… > 尾隨零 '19.90000' → 201 且存 19.9000（鑑別關鍵：小數位以正規化後的值判定，非字面字元數）`；`… > 恰為上界 4 位小數 '1.2345' → 201（證明用的是 > 而非 >=）` | T1, T2 | GREEN |
| AC-24 | U + I | 同上兩檔 | U：`AC-24 vehiclePrice >2 位小數 → 400；"600000.500" → 201 > "600000.005" 被拒（不再靜默進位為 600000.01）`；`… > "600000.00"／"600000.5"／"600000.05" 通過`；`… > 尾隨零 "600000.500" 通過，證明判定基於值而非字面`；`… > 小數位上限隨欄位 scale 變動："1.234" 於 unitPrice 通過、於 vehiclePrice 被拒`。I：`… > AC-24 vehiclePrice >2 位小數 → 400；'600000.500' → 201 > '600000.005' → 400 小數位文案 且 DB 無新增列（B-21，原為靜默進位存 600000.01）`；`… > '600000.00' → 201`；`… > '600000.5' → 201 存 600000.50`；`… > '600000.05' → 201 存 600000.05`；`… > 尾隨零 '600000.500' → 201 存 600000.50（判定基於值而非字面）` | T1, T2 | GREEN |
| AC-25 | U + I | 同上兩檔 | U：`AC-25 非十進位字面 → 400（Infinity／1e400 斷言為 400 而非 500） > 字串 "abc"／"1e5"／".5"／"19."／"+19.9"／"0x10" 一律被拒（CD-2(a)）`；`… > 字串 "Infinity"／"NaN"／"-Infinity" 被拒（原 500 路徑消滅）`；`… > number 型別 1e-7／1e21／1e400(=Infinity)／NaN／-Infinity 被拒`；`… > vehiclePrice 同樣適用（"abc" 由格式層攔截，取代舊 catch 分支文案）`；`… > 防呆證明：小數位檢查單獨無法擋下 Infinity／NaN，故字面 pattern 為必要守門`；`… > pattern 只收標準十進位字面（正例／反例對照）`。I：`… > AC-25 非十進位字面 → 400（Infinity／1e400 斷言為 400 而非 500）` 之迴圈參數化 8 條，樣板字串（可逐字 `grep`）`` `unitPrice ${JSON.stringify(literal)} → 400 字面文案 且 DB 無新增列` ``，參數 `literals` = "abc"／"1e5"／".5"／"19."／"+19.9"／"0x10"／"Infinity"／"NaN"（見表註 2）；`… > number 1e-7 → 400 字面文案（toString() 為 '1e-7'，指數記號）`；`… > number 1e21 → 400 字面文案（toString() 為 '1e+21'）`；`… > JSON number 1e400（解析為 Infinity）→ **400 而非 500**（B-14 消滅 500 的核心證據）`；`… > 'Infinity' → **400 而非 500**（B-14；小數位檢查單獨擋不住它，須靠字面／isFinite 守門）`；`… > vehiclePrice '1e5' → 400 字面文案（折舊端點同守門）`；`… > vehiclePrice 'abc' → 400 字面文案（B-19 文案變更；狀態碼與 field 不變）` | T1, T2 | GREEN |
| AC-26 | U + I | 同上兩檔 | U：`AC-26 boolean／array／object → 400（U 層：型別守門） > true／false 被拒（現行分別靜默存 1.0000／0.0000）`；`… > []／["5"]／{} 被拒（現行分別靜默存 0.0000／5.0000）`；`… > null／undefined 亦不被視為數值（必填檢查在上游 route 層，此處為最後守門）`；`… > vehiclePrice 同樣適用`。I：`… > AC-26 boolean／array／object → 400 且 DB 無新增列` 之迴圈參數化 5 條，樣板字串（可逐字 `grep`）`` `unitPrice ${label} → 400 型別文案 且 DB 無新增列` ``，參數 `label` = `true（原靜默存 1.0000）`／`false（原靜默存 0.0000）`／`[]（原靜默存 0.0000）`／`["5"]（原靜默存 5.0000）`／`{}`（見表註 2）；`… > vehiclePrice true → 400 型別文案 且 DB 無新增列` | T1, T2 | GREEN |
| AC-27 | U + I | 同上兩檔 | U：`AC-27 前後空白字串處置（CD-1(a) trim 後判定）；全空白 → 400 > " 19.9 " trim 後通過並存 19.9000（值完全保真）`；`… > " 600000 "（vehiclePrice）trim 後通過並存 600000.00（B-20 唯一放寬）`；`` … > 全空白 "   "／"\\t\\n" 被拒（廢止 Number("   ")===0 之靜默寫入） ``；`… > 空字串 "" 被拒`；`… > " abc " 被拒（trim 後仍非十進位字面）`；`… > 內部空白 "1 9.9" 被拒（trim 僅去頭尾）`。I：`… > AC-27 前後空白字串處置（CD-1(a)）；全空白 → 400 > unitPrice ' 19.9 ' → 201 存 19.9000（B-06 不變，trim 後值完全保真）`；`… > vehiclePrice ' 600000 ' → 201 存 600000.00（B-20，CD-1(a) 明文批准之放寬）`；`… > unitPrice '   '（全空白）→ 400 空值文案 且 DB 無新增列（B-07，原 Number('   ')===0 靜默存 0.0000）`；`… > unitPrice ' abc ' → 400 字面文案（trim 後仍非十進位字面）` | T1, T2 | GREEN |
| AC-28 | U + I | 同上兩檔 | U：`AC-28 折舊整數欄位 ≥2^31 → 400（2147483647 → 201 上界鑑別） > 上界內最大值 2147483647 通過（兩欄位各測）`；`… > 恰為上界 2147483648 被拒（兩欄位各測，field 精確定位）`；`… > 3e9 與 1e21（Number.isInteger 皆為 true，現行值域檢查放行）被拒`；`… > 既有值域案例（2.5／0／-1／5）不被本容量守門攔截，交由既有值域層判定（AC-30 零回歸）`；`… > 非 number 型別與非有限值不改變既有值域層行為（回傳 value=null 表示不適用）`。I：`… > AC-28 折舊整數欄位 ≥2^31 → 400（2147483647 → 201 上界鑑別） > usefulLifeYears = 2147483647 → 201（上界內最大，B-24）`；`… > estimatedAnnualKm = 2147483647 → 201（上界內最大，B-24）`；`… > usefulLifeYears = 2147483648（2^31）→ 400 int 容量文案 且 DB 無新增列（B-25，原為非 400）`；`… > estimatedAnnualKm = 2147483648 → 400 int 容量文案 且 DB 無新增列（兩欄位各守一次）`；`… > usefulLifeYears = 3e9 → 400 int 容量文案（Number.isInteger 為 true，現行值域檢查放行）`；`… > estimatedAnnualKm = 1e21 → 400 int 容量文案`；`… > usefulLifeYears = 2147483648.5 → 只回容量文案，不同時回「必須為整數且大於 0」（per-field first-hit）` | T1, T2 | GREEN |
| AC-29（結構性鑑別） | U(structural) | `backend/test/integration/chore003-string-fidelity.test.ts` | `CHORE-003-T3 §1 AC-29 結構性斷言：金額字串路徑無 Number() 中介 > 掃描 sanity：挖空後仍保有可辨識的程式碼骨架（確保不是掃到空字串而空跑）`；`… > parameter-validation.ts（金額輸入的唯一格式層）全檔無任何 Number()/parseFloat/parseInt 轉型`；`… > 三個建立路徑的函式體內，對金額輸入無任何 Number()/parseFloat/parseInt 轉型`；`… > parameter-service.ts 全檔僅存的 Number() 呼叫為 parseUtcDate 的日期分段（與金額輸入無關）`；`` … > src/parameters/** 已無 `priceNum` 這個舊中介變數（CHORE-002 S-3 機制已消失） ``；`… > 掃描器自證（鑑別力）：舊實作片段必被抓到；註解／字串中的 Number( 必不誤報` | T3 | GREEN |
| AC-29（行為等值） | I | 同上檔 | `CHORE-003-T3 §2 AC-29：字串輸入與等值 number 輸入之 DTO 完全相同 > createFuelVersion："19.9" 與 19.9 存入與回傳完全相同（僅 id/日期/建立時間不同）`；`… > createFuelVersion："0.1" 與 0.1 存入與回傳完全相同（典型二進位不可精確表示值）`；`… > createFuelVersion：容量上界 "999999.9999" 與 999999.9999 完全相同（AR-5 不可觀測性之上界案例）`；`… > createEtcVersion："5.5" 與 5.5 存入與回傳完全相同`；`… > createDepreciationVersion："9999999999.99" 與 9999999999.99 之 DTO 與 derived 完全相同（容量上界）` | T3 | GREEN |
| AC-30 | I | **主證（既有四檔，零修改全綠）**：`backend/test/integration/phase3a-parameter-fuel-etc.test.ts`、`phase3a-parameter-depreciation.test.ts`、`phase3a-parameter-audit.test.ts`、`phase3a-parameter-model.test.ts`；**補充鑑別**：`chore003-parameter-field-capacity.test.ts` | 主證：**四檔既有測試名一律不變、斷言零修改，T2 執行 84/84 全綠**（commit `dcad263`）。補充鑑別 10 條：`CHORE-003-T2 參數欄位容量／精度／字串保真（I 層） > AC-30 既有成功／值域／必填行為零回歸（補充鑑別） > unitPrice = 0（值域下界）→ 201 存 0.0000，不得被新的格式層誤擋`；`… > unitPrice '3.5000' → 201 存 3.5000（精度上界內）`；`… > Decimal round-trip：'3.1415' 建立後由 GET 列表取回仍為 3.1415`；`… > unitPrice = -1 → 400 且 field/reason 為既有值域層之「單價不得小於 0」（不變）`；`… > unitPrice = -0.5 → 400「單價不得小於 0」（負值且格式合法者仍走值域層）`；`… > unitPrice 缺欄位／null／'' → 400「單價為必填」（B-03，必填檢查仍在格式層之前）`；`… > vehiclePrice = 0 / -100 → 400「必須大於 0」（既有值域層文案不變）`；`… > usefulLifeYears = 2.5 → 400「必須為整數且大於 0」；= 0 → 400「必須大於 0」（不變）`；`… > 重疊 effectiveFrom 仍為 409 PARAMETER_PERIOD_OVERLAP + details.conflictVersion（不變）`；`… > 未登入 → 401；成功路徑之稽核列仍寫入（不變）` | T2 | GREEN |
| AC-31 | I | `backend/test/integration/chore003-parameter-field-capacity.test.ts` | 回應層：`CHORE-003-T2 參數欄位容量／精度／字串保真（I 層） > AC-31 原 500 情境之回應不外洩 DB／驅動層原文 > B-14 'Infinity'：400，body 為統一形狀且不含驅動層訊息片段`；`… > B-17 '1000000'：400，body 不含驅動層訊息片段`；`… > B-23 vehiclePrice '10000000000'：400，body 不含驅動層訊息片段`；`… > 三端點於全部新增之 400 情境皆不產生 500（狀態碼掃描）`。日誌層（獨立 `describeWithDb`，顯式 `logLevel:"info"` + logStream 擷取）：`CHORE-003-T2 AC-31 日誌不外洩 DB／驅動層原文 > 前提成立：三個錯誤路徑確實產生了 log 輸出`；`… > log 不含 DB／驅動層錯誤原文（numeric field overflow／out of range／22003／Prisma 查詢結構）`；`… > log 不含 SQL 關鍵字組合與絕對來源路徑`；`… > 三個請求仍被記錄為 400（未被靜默吞掉，且無 500）` | T2 | GREEN |
| AC-32 | U + I | 同 AC-21 兩檔 | U（10 條）：`AC-32 多重違規之 reason 順序決定性；折舊多欄位彙總 > 型別優先於一切：true 回型別文案而非字面／量級文案`；`… > 字面優先於量級："1e21"（非十進位字面＋超量級）回字面文案`；`… > 小數位優先於量級："1000000.000001"（超量級＋6 位有效小數）回小數位文案`；`… > 尾隨零不構成小數位違規："1000000.00000" 正規化後回量級文案（值判定而非字面）`；`… > 小數位優先於值域："-0.0000001"（負值＋超精度）回小數位文案，負值留給值域層`；`… > 量級優先於值域："-1000000"（負值＋超量級）回量級文案`；`… > 空白字串優先於字面："   " 回「必須為有效的數值」而非字面文案`；`… > 同一輸入重複呼叫結果完全一致（決定性）`；`… > 折舊多欄位彙總：vehiclePrice 與 usefulLifeYears 同時違規時 fields 同時包含兩者`；`… > 折舊三欄同時格式違規：三個欄位皆各自回報，不彼此吞噬`。I（2 條）：`… > AC-32（I 層補充）多重違規之順序決定性；折舊多欄位彙總 > unitPrice '-0.0000001'（負值＋超精度）→ 小數位文案（順序：小數位先於值域）`；`… > vehiclePrice '600000.005' 且 usefulLifeYears = 0 → fields 同時含兩欄位（AC-05 彙總行為不變）` | T1, T2 | GREEN |

**覆蓋核對（2026-08-03，CHORE-003-SPEC-SYNC）**：AC-21~AC-32 全數有映射（本表共 **13 列** = 12 AC + AC-29 拆為結構性／行為等值兩列）；**`GREEN` 13 列、`PENDING` 0 列、`RED` 0 列**。全表測試名以腳本對三個測試檔全文逐字比對，**missing = 0**（含負向對照：刻意竄改一字之測試名比對失敗，證明比對非恆真）。

**表註**

1. **AC-29 拆為兩列**：§14.5 AC-29 明文要求「單純比較兩路徑結果**無鑑別力**」，須另有結構性斷言。實作即依此分為 §1（對原始碼之靜態掃描，無 DB）與 §2（真實 DB 之等值 DTO 比對），兩者層級不同，拆列後方可機械核對。T3 另以 mutant 實證（還原舊 `Number()` 中介 → §1 三條轉紅、§2 行為等值斷言全綠）證明該警告成立。
2. **AC-25／AC-26 之 I 層測試名為迴圈參數化產生**：測試名由樣板字串在 `for` 迴圈中生成（各 8 條／5 條），故本表記錄其**樣板與參數清單**而非 13 條展開後字面；靜態 `grep` 應以樣板前綴比對。
3. **AC-30 主證為「零修改」**：四個 `phase3a-parameter-*.test.ts` 之測試名與斷言**一律未動**（§14.8 第 3~5 項），其證據形式為「執行結果全綠」而非新測試名，故本表不逐條列舉；補充鑑別 10 條為 T2 新增之反向斷言。§14.5 AC-30 所列之必涵蓋項（`unitPrice=0`、`"3.5000"`／`"1.2345"`、`-1`、`Decimal` round-trip）全數落在補充鑑別 10 條或既有四檔內。
4. **反向核對（測試 → AC）**：三個新增檔共 **133 條**（unit 50／capacity-I 69／string-fidelity 14），其中未直接對應單一 AC 者為：unit 檔 `容量常數綁 Prisma 欄位定義推導（§14.7 實作備註）` 2 條（併列於 AC-21，證明上限常數綁 Prisma 欄位定義而非魔術數）與 `純函式性質（葉節點模組，零 IO） > 回傳之 Decimal 由字串建構，D4 bright-line 保真（"0.1" 與 number 0.1 一致）`／`… > 成功結果為 Prisma.Decimal 實例` 2 條（D4 bright-line 守門）；string-fidelity 檔 `CHORE-003-T3 §3 AR-5 實證：欄位容量內不存在 double 中介會失真之值` 3 條（AR-5 之可執行實證，含容量外 17 位有效數字反例作鑑別力對照）。四者皆為刻意保留之附加鑑別，非覆蓋缺口。

### 14.7 Task 拆分建議（供大總管開 Packet 引用）

> 建議 **3 個 implementer Task**（可壓縮為 2：T3 併入 T2）。每 Task 一個 atomic commit，commit 訊息含 Task ID。全部 Task 皆為 **High 風險**（使用者可見錯誤合約 + 金額參數領域），須於 CHORE-003 Gate 取得 CD-1~CD-3 裁定後方可開工。

| Task | 內容 | 涵蓋 AC | 檔案清單 |
|---|---|---|---|
| **CHORE-003-T1** | 新增純函式驗證模組：`parseParameterDecimalField(value, field, { scale, integerDigits })`（型別／字面／小數位／量級四道守門，回 `{ ok, value \| error }`）與 `parseParameterIntField(value, field)`（int4 容量）。**零 IO**，與 `trip-validation.ts` 同形。 | AC-21~28（U 層）、AC-32 | **新增** `backend/src/parameters/parameter-validation.ts`；**新增** `backend/test/unit/parameter-validation.test.ts` |
| **CHORE-003-T2** | 將 T1 守門接入三個建立路徑（fuel／etc／depreciation），值域比較改以 `Prisma.Decimal` 進行；route schema 與必填檢查**不動**。 | AC-21~28（I 層）、AC-30、AC-31 | **修改** `backend/src/parameters/parameter-service.ts`；**新增** `backend/test/integration/chore003-parameter-field-capacity.test.ts`；**回歸執行**（不修改）`phase3a-parameter-*.test.ts` 四檔 |
| **CHORE-003-T3** | AR-5 閉環：確保字串路徑無 `Number()` 中介、更新失效之 S-3 註解與文件敘述；調整因合約變更而失效之既有斷言（見 §14.8）。 | AC-29 | **修改** `backend/src/parameters/parameter-service.ts`（註解）、`backend/src/parameters/depreciation-engine.ts`（若共用 helper）；**新增** `backend/test/integration/chore003-string-fidelity.test.ts`；**修改** `backend/test/integration/chore002-d4-decimal-number.test.ts`、`backend/test/integration/chore001-d4-decimal-placeholder.test.ts` |

**實作備註（內部技術細節，供 implementer 定案並記錄）：**
- `parameter-validation.ts` 為**葉節點模組**（不 import 同模組內他檔），故 `parameter-service.ts` 與 `depreciation-engine.ts` 可同時 import 而不形成循環依賴。
- ~~這**順帶消除 AR-1「`toDecimalConstructorArg` 同形雙拷貝」** 的維護風險。~~ → **未採用（T3 評估後停止，2026-08-03）**。理由：`parseParameterDecimalField(value, field, capacity)` **不接受 `Prisma.Decimal` 實例**（其型別守門僅放行 `string`／`number`，`Decimal` 實例會被判為 `必須為有效的數值（字串或數字）`），而 `deriveDepreciation` 的既有契約 `DepreciationInput.vehiclePrice: Prisma.Decimal | string | number` **必須**接受 `Decimal` 實例（`parameter-service.ts` 即以 `Decimal` 實例呼叫之）；且該函式另附**小數位／量級兩道守門**，改用會使 `deriveDepreciation` 對「格式合法但超容量」之輸入由 `{ ok: false }` 以外的路徑或不同語意回應——**改變其既有契約**（§14.5 AC-14 僅規定「≤ 0 → 無效」）。§14.8 第 6 項已明示「若因此變紅即代表引入非預期行為改變，須停止」，故 T3 停止此項。**AR-1（`toDecimalConstructorArg` 同形雙拷貝）維持追蹤**，`depreciation-engine.ts` 內之雙拷貝說明註解保留有效；若日後要收斂，須另抽第三個共用葉節點模組（不改 `deriveDepreciation` 契約），屬 PHASE-011 加固期重構候選。
- **`toDecimalConstructorArg` 必須維持自 `parameter-service.ts` 具名匯出**（可改為 re-export），否則 `chore002-d4-decimal-number.test.ts` 之單元段落（該檔 L51~L60）將因找不到匯出而紅——那屬於**破壞既有測試**而非依 Spec 更新斷言。
- 不 import／不修改 `backend/src/applications/trip-validation.ts`（PHASE-004 領域，已合併 main，回歸面過大）。若日後要抽共用模組，屬 PHASE-011 加固期之重構候選，非本回合。
- **不新增 `ErrorCode`**：全部走既有 400 `VALIDATION_ERROR`。若實作評估認為需要新碼，須**停止並列為新決策點**交大總管，不得自行新增。
- 前端 `frontend/src/pages/ParametersPage.tsx` **不需修改**：其送出值為 `<input type="number">` 之原始字串，且已依 `error.fields` 逐欄顯示訊息，新增的 400 情境可直接被現有錯誤態呈現。

### 14.8 受影響既有測試逐檔盤點

> 「須調整」＝因**本 Spec 明文批准的合約變更**而必須更新斷言；此為依 Spec 更新，**不得**以「刪除／skip／放寬」方式處理，且更新後仍須保有原測試的鑑別意圖。

| # | 檔案 | 影響 | 須做什麼 |
|---|---|---|---|
| 1 | `backend/test/integration/chore002-d4-decimal-number.test.ts` | **須調整（斷言）→ ✅ 已完成（T3 `17cc428`）** | ① L175-183「`unitPrice: true` → 201 且存 `1.0000`」**斷言須改為 400**（B-08）。② L166-173（`" 19.9 "` → 201）與 L185-192（`" 5.5 "` → 201）：CD-1 採 (a) 時**斷言值不變**，但其標題／註解所述理由（「必須仍走 `priceNum`」）已失效，須改述為新機制；CD-1 採 (b) 時**斷言須改為 400**。③ L51-60 `toDecimalConstructorArg` 單元段落：只要維持匯出即**不需改動**（見 §14.7 備註）。<br>**完成情形**：① 已改為 `400` + `fields[{ field:"unitPrice", reason:"必須為有效的數值（字串或數字）" }]`，並依 AC-26 鑑別要求**加測「DB 無新增列」**（原鑑別意圖強化而非弱化）；② CD-1(a) 下斷言值維持 201/`19.9000`，標題與註解已改述為「格式層 trim 後判定，字串路徑無 `Number()` 中介」；③ `toDecimalConstructorArg` 維持自 `parameter-service.ts` 具名匯出，該段落零改動。 |
| 2 | `backend/test/integration/chore001-d4-decimal-placeholder.test.ts` | **須調整（文案斷言）→ ✅ 已完成（T3 `17cc428`）** | L44-62 精確斷言 `{ field: "vehiclePrice", reason: "必須為有效數值且大於 0" }`；新驗證改由格式層攔截 `"abc"`，`reason` 變更（§14.2 文案表），該斷言須同步更新。狀態碼與 `field` **維持 400 / `vehiclePrice` 不變**。<br>**完成情形**：`reason` 已更新為 `必須為有效的十進位數值（不接受指數記號）`，狀態碼 400 與 `field: "vehiclePrice"` 皆未變；檔頭補註說明原 `new Prisma.Decimal("0")` placeholder 與其 try/catch 分支已於 T2 消失、本檔守門價值轉為「不可解析之 `vehiclePrice` 仍必須被精確定位並以 400 拒絕」，原鑑別意圖完整保留。 |
| 3 | `backend/test/integration/phase3a-parameter-fuel-etc.test.ts` | **零變更（AC-30 主證）** | 全檔使用合法值（`0`、`-1`、`"3.5000"`、`"1.2345"`、`"3.1415"`），且**不斷言 `reason` 文字**（僅斷言 `field`），故無須修改。須完整執行並在 Handoff 附結果。 |
| 4 | `backend/test/integration/phase3a-parameter-depreciation.test.ts` | **零變更（AC-30 主證）** | 同上；`usefulLifeYears=2.5`／`=0`／`=-1` 等既有值域案例之 `reason` 文字**不在本回合變更範圍**（§14.2 表列為「不變」），故斷言不受影響。 |
| 5 | `backend/test/integration/phase3a-parameter-audit.test.ts`、`phase3a-parameter-model.test.ts` | **零變更** | 使用合法值；稽核與模型層不在變更範圍。須執行確認。 |
| 6 | `backend/test/unit/depreciation-engine.test.ts`、`backend/test/unit/parameter-version-engine.test.ts` | **零變更 → ✅ 實際零變更（T3 `17cc428`）** | 純引擎測試；未直接測 `toDecimalConstructorArg`。若 T3 讓 `depreciation-engine.ts` 改用共用 helper，行為為恆等變換，測試仍應全綠——**若變紅即代表引入了非預期的行為改變，須停止**。<br>**完成情形**：T3 評估後**未讓 `depreciation-engine.ts` 改用共用 helper**（理由見 §14.7 實作備註第 2 點：`parseParameterDecimalField` 不接受 `Decimal` 實例且附加守門，改用會改變 `deriveDepreciation` 既有契約——即本項所指之「須停止」情形）。該檔 `src` 與測試皆零變更，AR-1 維持追蹤。 |
| 7 | `backend/test/integration/phase4-*.test.ts`（`travel-draft`／`travel-preview`／`travel-complete`／`admin-on-behalf`／`on-behalf-audit`／`concurrency-freeze`／`reference-protection`） | **零變更** | 該七檔雖出現 `unitPrice`／`vehiclePrice`，但皆以 `prisma.*.create` **直寫**參數版本 fixture（未經 service／endpoint 驗證路徑），且值皆在容量內（`3.5`／`5.0000`／`6.0000` 等），故不受本回合影響。仍建議納入回歸執行範圍。 |
| 8 | `backend/test/integration/chore002-4xx-status-mapping.test.ts`、`chore001-wire-level-4xx-hardening.test.ts` | **零影響** | 經檢索未涉及 `parameters` 端點。 |
| 9 | `frontend/test/ParametersPage.test.tsx` | **零變更** | 前端不修改（§14.7 備註）。若 implementer 認為需補「新錯誤文案顯示」之前端測試，屬**加測**而非調整，可加於本檔。 |

### 14.9 已知限制與跨 Phase 提醒

1. **本節不觸及既有資料**：修訂僅影響**新建立**之參數版本輸入驗證。若開發期已存在因靜默截斷而存為 `0.0000` 的版本列，本回合**不做資料修補**（開發期合成資料，可由人類決定清除）。正式資料階段之修補屬人類決策。
2. **`Int` 欄位容量上限為 PostgreSQL `integer` 之界限，非業務上限**：本回合不設「折舊年限最多 N 年」這類業務上限（US 未要求，屬擴大 Scope）。若日後要加，須新的人類批准。
3. **`effectiveFrom` 不在本回合範圍**：其 400 合約（AC-06）已完備。
4. **跨 Phase 提醒（非本回合處理，已回報大總管）**：`TripSegment.snapshotFuelAmount` / `snapshotEtcAmount` / `snapshotRawAmount` 為 `Decimal(14,4)`（整數部分最多 10 位，即 < 1e10），而其計算來源為 `totalKm`（`parseKmField` 上限 < 1e8）× `unitPrice`（本回合上限 < 1e6），理論乘積可達 ~1e14，**超出快照欄位容量**。此屬 PHASE-004 領域之同類缺陷（欄位容量與上游輸入上限未對齊），**本回合不處理**，建議由大總管記入 PROJECT_STATE 跨 Phase 追蹤事項並於 PHASE-011 或專責回合評估。

### 14.10 Rollback

- 變更範圍：一個新增檔（`parameter-validation.ts`）、一個既有服務檔的驗證段落、測試檔。**無 migration、無資料模型變更、無 API 形狀變更**（僅新增既有 `VALIDATION_ERROR` 之觸發情境）。
- 回滾＝還原分支至 base commit；無資料層副作用需處理。回滾後行為即回到「既有 500 路徑與靜默截斷」之現況（即回到已知缺陷狀態，非資料損毀）。
- 若僅需部分回退：AC-28（CD-3）之整數欄位守門為獨立條目，可單獨移除而不影響 AC-21~AC-27。
