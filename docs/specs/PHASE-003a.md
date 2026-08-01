# PHASE-003a — 補助參數維護（油資 / ETC / 折舊，版本化不重疊）

- Governance-Version: 2026-08-01.2
- 狀態：**ACTIVE**（High 風險 Spec；第 13 節 D1~D10 決策點已於 2026-08-01 經人類事前批准，全數依建議定案，見 §13 修訂紀錄）
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
| 2026-08-01 | DRAFT→ACTIVE | 人類事前批准 Gate 通過：D1~D10 **全數依 spec-writer 建議定案**（D1 三表+泛型服務、D2 僅 effectiveFrom 隱含結束、**D3 每公里單價 Decimal 4 位小數保留、顯示層一般四捨五入、007 末端一次取整為整數**、D4 服務層權威+`@@unique(effectiveFrom)`、D5 專屬 `PARAMETER_PERIOD_OVERLAP`(409)、D6 單一 `PARAMETER_VERSION_CREATED`+summary.parameterType、D7 推導值不持久化、**D8 油資/ETC Decimal(10,4)・車價 Decimal(12,2)・年限/年里程 Int・單價 Decimal(_,4) 一律非浮點**、D9 本 Phase 不提供撤銷端點、D10 全 requireAdmin）。金額語意 D3/D8 經人類明確批准。轉 ACTIVE，開始 TDD。 | 使用者 Gate 批准（2026-08-01，leonchih） |

> 狀態轉移：DRAFT →（人類事前批准 D1~D10，其中 D3/D8 為金額語意必批）→ ACTIVE → 實作（TDD）→ COMPLETED。
> 補充（治理 2026-08-01.2）：本 Spec 屬 High 風險文件，定義 High 風險行為（影響金額之受引用參數）。Gate 中人類提出之任何變更，須先由 spec-writer/大總管完成本 Spec 修訂（引用該批准與日期）後方可實作。
