# DATA FLOW — 私車差旅補助管理系統（草案）

- Governance-Version: 2026-08-01.1
- 狀態：DRAFT
- 更新日期：2026-08-04（最後同步至 PHASE-006 已落地現實；DOC-SYNC `PHASE-007-DOC-SYNC-A`）
- 上游：`userstory.md`、`docs/PRD.md`、`docs/ARCHITECTURE.md`
- 說明：概念層資料模型與資料流草案。實體命名為概念名稱，非最終 DB schema；不含欄位型別、索引、API I/O 格式（於 Phase Spec 定案）。

---

## 1. 概念資料模型（實體與關聯）

```
User 1───* Application ───┐
 │                        ├── (依 type) TravelApplication  1───* TripSegment
 │                        ├── (依 type) MaintenanceApplication
 │                        └── (依 type) DepreciationApplication
 │
User 1───* Session
User 1───* AuditLog (as owner)              Admin(User) 1───* AuditLog (as actor)

Application 1───* Attachment (關聯，草稿階段可解除；完成後鎖定)
TripSegment 1───* Attachment
Application 0..1───1 Report (已完成才有；修正版各自新 Report)
Report 1───1 PdfFile (保存於 volume)
Application 0..1 ──self── Application (原申請 ─supersededBy→ 修正版)

FuelParameterVersion  (油資每公里，含生效日期，不重疊)
EtcParameterVersion   (ETC 每公里，含生效日期，不重疊)
DepreciationParameterVersion (車價/年限/預估年里程，含生效日期，不重疊)

CalculationSnapshot (內嵌於已完成 Application：參數值 + 取整前後金額)
```

### 1.1 實體摘要

| 實體 | 重點屬性（概念） | 說明 |
|---|---|---|
| User | 登入帳號、顯示姓名、員工編號(可空)、密碼雜湊、啟用/停用、需強制改密旗標、登入失敗計數/鎖定至、角色(一般/管理員) | 密碼僅存雜湊；員工編號可空 |
| Session | 擁有者、建立/到期、失效狀態 | 停用/重設密碼即失效 |
| Application（抽象） | 擁有人、建立者(操作者)、類型(差旅/保養/折舊)、狀態(草稿/已完成/已作廢)、作廢原因/操作者/時間、版本關聯、CalculationSnapshot | 三類共用狀態與快照容器 |
| TravelApplication | 出差日期、出差目的 | 差旅專屬 + 多段行程 |
| TripSegment | 出發地、到達地、總里程、高速里程、排序 | 屬差旅；≥1 段且每段完成須 ≥1 附件 |
| MaintenanceApplication | **業務 5 欄**：上次/本次保養日期（`@db.Date`，日粒度）、上次/本次里程表、實際費用；**快照 5 欄**：`snapshotIntervalKm`（區間里程）／`snapshotOfficialKm`（期間公務里程）／`snapshotRatio`（比例，6 位小數）／`snapshotRawAmount`（取整前分攤金額）／`calculatedAt` | **PHASE-006 已落地之實體**：`MaintenanceApplication` 子表，1:1 於 `Application`（PK ＝ `applicationId`，`onDelete: Cascade`），與既有 `TravelApplication` 對稱（D1(a)）；本次保養日期為 `Application.primaryDate` 之來源；**最終金額落於既有 `Application.totalAmount`（`Int`）不重複持久化**；**實際費用之快照即 `actualCost` 欄位本身**（完成後凍結，D11(a)，不另存冗餘副本） |
| DepreciationApplication | 申請年度；(快照:車價/年限/預估年里程/單價/年度里程/補貼金額) | 折舊專屬 |
| Attachment | 檔案參照(volume 路徑)、格式、大小、暫存/關聯狀態、所屬申請/項目、上傳時間 | 生命週期核心 |
| Report | 報表編號(TRV/MNT/DEP+月內唯一)、產生時間、所屬申請版本 | 已完成才有；冪等 |
| PdfFile | volume 檔案參照、安全檔名 | 保存不可變內容 |
| Fuel/Etc/DepreciationParameterVersion | 參數值、生效日期 `effectiveFrom`（日粒度，含當日；有效期間不重疊，結束由下一版隱含界定，PHASE-003a D2 方案 A） | 版本化、被引用不可覆寫；折舊每年費用/每公里單價為 derived 不持久化（D7），即算即回 |
| AuditLog | 操作者、擁有人、時間、操作類型、受影響資料、前後摘要 | 不含密碼 |

### 1.2 關鍵不變式

- 一般使用者只能存取自己擁有的 Application/Attachment/Report。
- Application 完成即鎖定業務欄位與附件，並寫入 CalculationSnapshot；快照不可變。
- 三類 ParameterVersion 各自有效期間不重疊；被歷史申請引用後內容不可覆寫。
- 修正版為新 Application（草稿），透過版本關聯指向原申請；原申請與其 PDF 不被改動。
- 統計/計算僅納入「已完成且未作廢」的差旅。

---

## 2. 主要資料流（含權限檢查點與敏感資料處理）

標記說明：【授權】= 權限檢查點；【敏感】= 敏感資料處理點。

### 2.1 登入

```
瀏覽器 →(帳號+密碼)→ auth
  【授權】驗證帳號存在且啟用且密碼雜湊相符（統一錯誤訊息，不透露哪項錯/是否停用）
  【敏感】密碼僅比對雜湊，不記錄於日誌
  → 若連續失敗達 5 次 → 鎖定該帳號 15 分鐘（鎖定期間正確密碼亦拒）
  → 成功 → 建立 Session → 設 Cookie(HttpOnly/SameSite;正式 Secure)
  → 若需強制改密 → 導向強制改密流程（阻擋其他頁面）
  → 否則導向「我的私車補助紀錄」
```

### 2.2 建立草稿 → 完成（含計算與快照）

以差旅為例（保養/折舊同構，計算與參數不同）：

```
使用者 →建立差旅草稿→ applications/trips
  【授權】要求已登入；擁有人=自己（或管理員代操作時擁有人=指定使用者、操作者=管理員【授權】管理員角色 + 已選使用者）
  → 儲存不完整草稿(允許)，標示未完成項；多段行程 CRUD 與排序持久化
  → 上傳截圖(見 2.3)；里程即時前端驗證 + 後端權威驗證
  → 前端金額預覽(僅參考)
使用者 →完成申請→ applications
  【授權】狀態機:僅草稿可→已完成；已完成不得直接改
  → 完整性驗證(日期/目的/≥1 段/每段地點里程與≥1 附件/高速≤總里程)
  → 依出差日期解析參數(擁有人油耗→該油種油價→ETC；缺→拒絕完成。PHASE-005a 落地流程見下)
  → calculation engine 後端計算(不採前端金額)
  → 寫入 CalculationSnapshot(單價+取整前後金額) → 鎖定附件 → 狀態=已完成
  → 回傳後端正式結果(前端以此為準)
```

- 保養差異：完成時計算區間里程(本次−上次里程表)、期間公務里程(2.8 統計)、比例(>100% 拒絕)、分攤金額；快照存區間里程/公務里程/比例/費用/金額。**PHASE-006 落地流程見下。**
- 折舊差異：完成時取年度公務里程(2.8)、依申請年度 1/1 有效折舊參數算每公里單價與補貼；年度里程唯讀不可覆寫；快照存車價/年限/預估年里程/單價/年度里程/金額。**（PHASE-007 尚未落地。）**

PHASE-005a 落地細節（差旅單價解析；預覽與完成共用，取代上文「依出差日期套用油資參數」之舊敘述）：

```
resolveTravelParameters(db, tripDate, ownerId)
   │
   ├─ tripDate == null → missing = 全部三類(油耗／油價／ETC)，不查 DB（B-07，沿用 PHASE-004）
   │
   ├─ findMany(UserFuelConsumptionVersion where userId = ownerId)   ← 該使用者全部版本，不在 DB 層過濾
   │     └─ findEffectiveVersion(versions, tripDate) → consumption | null
   │
   ├─ consumption == null → missing += FUEL_CONSUMPTION（油種未知，**不再查油價**；B-05 避免誤導提示）
   │  consumption != null → findMany(FuelPriceVersion where fuelType = consumption.fuelType)
   │        └─ findEffectiveVersion(...) → price | null；null → missing += FUEL_PRICE
   │
   ├─ findMany(EtcParameterVersion) → findEffectiveVersion → etc | null；null → missing += ETC
   │
   └─ price && consumption → deriveFuelUnitPrice(price, consumption)   ← 純函式
                                = ROUND_HALF_UP(每公升油價 ÷ 油耗, 0)
```

```
差旅完成（既有 Serializable 交易內，步驟順序不變）
  ② computeCompletionBlockers（missingParameters 值域擴充）
  ③ resolveTravelParameters(tx, tripDate, ownerId) → assertParametersAvailable
       缺項 → 409 PARAMETER_NOT_AVAILABLE + details.missing（油耗／油價／ETC 逐項可辨，訊息互異）
  ③b deriveFuelUnitPrice 容量守門（超出欄位容量 → 可行動 4xx；絕不 500、絕不靜默截斷）
  ④ calculateTravel({ segments, fuelUnitPrice: 推導取整後單價, etcUnitPrice })   ← 計算引擎零改動
  ⑤a 段快照（既有四欄，零改動）
  ⑤b TravelApplication 快照：既有欄位 ＋ snapshotFuelType / snapshotFuelPricePerLiter /
      snapshotFuelConsumption / fuelPriceVersionId / fuelConsumptionVersionId
  ⑤c Application.status = COMPLETED（最後寫入）
```

- **新舊模型判別**（PHASE-005a §8.4）：舊模型列 ＝ `fuelParameterVersionId != null` 且 `fuelPriceVersionId == null`；新模型列 ＝ `fuelPriceVersionId != null` 且 `fuelConsumptionVersionId != null`。完成流程**只寫新模型欄位**，`fuelParameterVersionId` 保持 `null`；舊模型已完成申請之快照逐位元不變（新五欄為 `null`，DTO 不得因此拋錯或顯示 `NaN`）。
- **參數選版一律走純函式**：油耗／油價／ETC 皆「該類全部版本 `findMany` 後以 `findEffectiveVersion` 選版」（一次請求最多 3 次 `findMany`，油價已由 `fuelType` 收斂），**不得**在 DB 層以 `effectiveFrom: { lte }` 先過濾（避免與 PHASE-003a 之日粒度語意分歧）。
- **代操作**：解析一律以**擁有人**之油耗與油種為準，絕不取操作者之油耗。

PHASE-006 落地細節（保養分支；完成與快照寫入）：

```
POST /applications/:id/complete（依 type 分派 → MAINTENANCE）
  → requireAuth + requirePasswordChanged
  → 【授權】嚴格 actor.id === ownerId（D7(a)：僅本人可完成；管理員代操作僅及於草稿）
  → SERIALIZABLE tx（重試）：
       ① assertTransition(status → COMPLETED)                      非 DRAFT → 403
       ② attachmentCount = count(LINKED, MAINTENANCE, applicationId)
          computeMaintenanceBlockers（**結構性條件先算**）
             非空 → 400 VALIDATION_ERROR + fields[] + details.blockers[]
       ③ sumOfficialMileage(tx, { ownerId, dateFrom: 上次保養日, dateTo: 本次保養日 })
             ← 同一交易內呼叫既有引擎（起訖含當日；不重寫過濾與加總）
          → 再算依賴里程之 blocker（OFFICIAL_KM_EXCEEDS_INTERVAL 等）並二次判定
       ④ calculateMaintenance({ actualCost, officialKm, intervalKm })
          → 容量守門（AMOUNT_OUT_OF_RANGE）**於寫入前**拒絕（4xx；絕不 500、絕不截斷）
       ⑤a MaintenanceApplication.update(snapshotIntervalKm / snapshotOfficialKm /
              snapshotRatio / snapshotRawAmount / calculatedAt)
       ⑤b Application.update(status=COMPLETED, totalAmount, completedAt)
  → 回應 DTO（含 snapshot；completionBlockers=null、computed=null）
```

- **②與③④之順序不可對調**：完成度未過時**不查詢**期間里程（省一次聚合，錯誤語意單一）。故 blocker 分兩段計算——結構性條件先算，全通過才執行 ③，再算依賴里程之項目並二次判定；純函式以 `officialKm?: Decimal | null` 表達「尚未查詢」而不產生該類 blocker。
- **預覽為純讀取路徑**（`POST /applications/maintenance/preview`）：`resolveOwnerId` 授權 → 欄位驗證 → `sumOfficialMileage`（唯讀）→ `calculateMaintenance` → 容量判定；**絕不寫入任何資料列**。
- **草稿與預覽即暴露不可計算狀態**（blocker ＋ `computed.calculable=false`），不得出現「預覽說可以、完成才擋」之反模式。

### 2.3 附件上傳生命週期（暫存 → 關聯 → 鎖定 → 清理）

```
使用者 →上傳圖片→ attachments
  【授權】要求已登入；上傳者身分綁定
  【敏感】驗證實際檔案內容(非僅副檔名)：僅 JPEG/PNG/WebP；單檔≤10MB；否則拒絕
  → 通過 → 標示為「暫存(temp)」，回傳預覽縮圖
使用者 →儲存草稿→ 
  → 暫存附件關聯至該 Application/TripSegment；套用數量上限(差旅 3/段、保養/折舊 5)
使用者 →草稿中刪除附件→
  【授權】僅擁有人/代操作管理員；且申請須為草稿
  → 解除關聯(重新載入不再顯示)
申請完成 →
  → 附件鎖定：已完成申請不得刪除/替換附件
清理排程(PHASE-011) →
  → 暫存 >24h 且無任何(草稿/已完成/報表/稽核)引用 → 可刪除
  → 被任何資料引用 → 不得刪除
```

存取附件內容：

```
任何人 →請求附件內容→ attachments
  【授權】未登入→拒絕；非擁有者(且非管理員)→拒絕；不得因自帶他人識別值而取得
  → 通過 → 由 storage 抽象層回傳檔案
```

### 2.4 報表產生與下載

```
使用者 →產生正式報表→ reports
  【授權】僅擁有人/管理員；申請須為已完成(草稿拒絕)
  → 若該版本已有報表 → 回既有編號(冪等，不重產)
  → 否則 → 產生唯一編號(TRV/MNT/DEP+月內唯一)
  → 以列印版 HTML(與 PDF 同版型) 經 Playwright 產生 PDF
  → 保存 PDF 至 volume + 記錄編號/產生時間
  → 【失敗處理】PDF 未完整保存 → 不標示成功、不回報已產生
使用者 →預覽/列印→ 顯示完整內容/計算明細/證明圖片(多段依序、圖片不溢出、多頁不重疊)
使用者 →下載 PDF→ reports
  【授權】僅擁有人/管理員
  → 產生安全檔名(移除不安全字元；含類型/姓名/日期或年度/編號)
  → 回傳原保存 PDF(重下內容/編號一致)
```

### 2.5 修正版

```
使用者/管理員 →對已完成申請建立修正版→ applications
  【授權】擁有人或管理員；來源須為已完成
  → 複製原資料為新 Application(草稿)，擁有人=原使用者(管理員操作時操作者=管理員【敏感/稽核】)
  → 建立版本關聯(原 ─supersededBy→ 修正版)；原申請不被改動
  → 修正版完成後(走 2.2)產生正式報表 → 新報表編號、原 PDF 不覆寫
  → 查詢時可顯示新舊版本關係
```

### 2.6 作廢

```
使用者/管理員 →作廢已完成申請→ applications
  【授權】擁有人或管理員；來源須為已完成
  → 前端二次確認 + 必填作廢原因；【後端驗證】原因為空→拒絕
  → 狀態=已作廢；記錄原因/操作者/時間【稽核】
  → 不得恢復為已完成(狀態機禁止)
  → 統計/計算(2.8)自此排除該筆
  → 若已有 PDF：下載時保留可辨識作廢標示與原因
```

### 2.7 參數維護

```
管理員 →建立參數版本(油資/ETC/折舊)→ parameters
  【授權】僅管理員
  → 值域驗證(油資/ETC ≥0；折舊各值 >0，否則拒並指欄位)
  → 有效期間重疊檢查 → 重疊則拒並指衝突
  → 未來生效版本不影響現行版本
  → 折舊：推導每年費用(車價÷年限)與每公里單價(每年費用÷預估年里程)
  → 保存新版本【稽核】記修改者/前後重要設定摘要(不涉密碼)
  → 已被歷史申請引用之版本內容不得覆寫；歷史金額由快照保證不變
```

PHASE-003a 落地細節（已實作事實）：

- 三類 `ParameterVersion` 之 `effectiveFrom` 為**日粒度**（`@db.Date`，含當日）；有效期間結束為「同類下一版生效日前一日」隱含推導，不重疊退化為同類 `effectiveFrom` 唯一（D2 方案 A）。
- 折舊 derived（每年費用 / 每公里單價）**不持久化**（D7），依推導引擎即算即回。
- **引用保護以「只增不改」保證**：本 Phase 不提供改/刪版本端點，覆寫版本內容之路徑天然不存在。提供引用偵測介面契約 `parameterHasReferences(type, versionId): boolean`；本 Phase 引用來源（已完成申請快照）尚不存在，故**本 Phase 回傳 false**。真實引用判斷與「歷史金額不變」回歸於 PHASE-004/007（以申請完成快照為權威）。

錯誤流（PHASE-003a）：

```
  → 有效期間重疊 → 拒絕 PARAMETER_PERIOD_OVERLAP (409)
        + error.details.conflictVersion（衝突版本識別與生效日期，供前端定位）（D5）
  → 併發同一 effectiveFrom（兩管理員同時建立）→ 由 DB @@unique(effectiveFrom) 捕捉
        → 轉為同一 PARAMETER_PERIOD_OVERLAP (409) 碼（不外洩 DB 錯誤原文）（D4）
```

### 2.8 統計查詢（區間 / 年度公務里程）

```
使用者/管理員 →選日期區間或年度→ mileage
  【授權】一般使用者僅自己資料；管理員可指定使用者；自帶他人識別值不得越權
  → 日期驗證(起訖含當日；區間起>迄→拒絕)
  → 篩選:僅「已完成且未作廢」差旅、出差日期落於區間/年度(1/1–12/31)
  → 加總各段總里程；不重複加高速里程；涵蓋完整區間(非單頁)
  → 草稿/已作廢不納入
  → 回傳總里程(無有效差旅→0)
```

PHASE-005 落地細節（已實作事實）：

```
前端(個人首頁統計區塊 / 管理員使用者申請頁統計區塊)
   │  query: dateFrom, dateTo, [ownerId]（日期兩者必填 D5(a)；統計不分頁，無 page/pageSize）
   ▼
GET /statistics/mileage（單一端點 + ownerId 參數，D4(a)；個人與管理員共用同一路徑）
   ├─【授權】requireAuth ───────────────────── 未登入/Session 失效 → 401 UNAUTHORIZED
   ├─【授權】requirePasswordChanged ────────── 需強制改密 → 403 PASSWORD_CHANGE_REQUIRED
   ├─【結構】assertScalarQueryParams ───────── ownerId/dateFrom/dateTo 非單一字串(重複帶同名參數)
   │                                          → 400 VALIDATION_ERROR（拒絕而非取首值，且不致 500）
   ├─【授權】resolveOwnerId(actor, ownerId) ── 一般使用者自帶他人 → 403 FORBIDDEN（不靜默降級為自己）
   ├─【驗證】parseMileageRange(dateFrom,dateTo) ─ 缺漏/格式非 YYYY-MM-DD/起>迄
   │                                          → 400 VALIDATION_ERROR + 可定位 fields（回傳全部錯誤，非第一項即止）
   ▼
mileage 引擎 sumOfficialMileage(db, {ownerId,dateFrom,dateTo})（唯讀，可於交易內呼叫）
   │  where: ownerId ∧ type=TRAVEL ∧ status=COMPLETED ∧ tripDate ∈ [dateFrom, dateTo]（gte/lte，含當日）
   │  DB 層單一聚合：SUM(TravelApplication 完成快照總里程) + COUNT(*)
   │  （不分頁、不將命中集合讀入記憶體相加、不 N+1）
   ▼
{ totalKm: Decimal, applicationCount: number }
   │  Decimal → 字串，固定 2 位小數、不取整、不經浮點
   ▼
200 { totalKm, applicationCount, appliedFilters:{dateFrom,dateTo,ownerId} }
   ▼
前端僅顯示後端回傳值（不自算、不推導）
```

- **判定順序固定**：結構收斂(400) → 授權(403) → 日期格式與區間(400)。授權先於日期驗證，避免以 400／403 之差異，向無權查詢他人資料者洩漏「該日期是否合法」這條側信道。
- **里程來源為完成快照**（D2(a)）：讀已完成差旅之快照總里程，不逐段重算；「加總各段總里程、不重複加高速里程」之語意由申請完成時寫入快照的定義保證（2.2）。
- **精度**（D3(a)）：全程 `Decimal`，本層不取整，對外以字串固定 2 位小數傳輸；無有效差旅回 `"0.00"` 且**仍為 200**（非 404、非 `null`、非空字串）。
- **回應鍵為封閉白名單**：僅 `totalKm`、`applicationCount`、`appliedFilters.{dateFrom,dateTo,ownerId}`；**不含**單價、金額、出差目的／地點、附件或他人顯示名稱／帳號；403 回應本身亦不含任何數值。
- **不新增錯誤碼**：沿用既有結構化錯誤協定之錯誤碼聯集；日誌不含 Session／敏感值。
- **引擎複用**：`sumOfficialMileage` 接受交易 client，供保養（期間公務里程）與折舊（年度公務里程）於各自完成流程之交易內呼叫（2.2），統計端點與完成流程共用同一份過濾與加總實作。

綜合紀錄查詢（個人/管理員列表）：

```
使用者/管理員 →查詢(日期/類型/狀態/關鍵字)→ applications
  【授權】一般使用者僅自己；管理員可指定使用者；越權識別值→拒絕或忽略
  → 未指定日期→預設近一年
  → 同時套用有效條件；分頁(回頁次/每頁/總數)；全部紀錄仍限單次筆數
  → 差旅/保養/折舊混合依日期倒序；不適用欄位顯「—」
```

---

## 3. 敏感資料處理彙整

| 資料 | 處理原則 | 相關 US |
|---|---|---|
| 密碼 | 僅存不可逆雜湊；≥10 字元且拒弱密碼；不入日誌/稽核；改密/重設即失效舊 session；管理員介面不顯示 | NFR-US-08, BE-US-04, BE-US-31 |
| Session Cookie | HttpOnly/SameSite；正式 Secure；不入日誌 | NFR-US-11, CLAUDE.md |
| 附件內容 | 授權後才回傳；未登入/非擁有者拒絕；storage 抽象隔離路徑 | NFR-US-10, BE-US-02 |
| 正式 PDF | 保存於 volume；下載須授權；作廢後保留作廢標示 | FE-US-24, BE-US-27 |
| 稽核紀錄 | 記操作者/擁有人/時間/類型/前後摘要；不含密碼與憑證 | BE-US-31, AD-US-14 |
| 錯誤回應/日誌 | 不外洩堆疊/DB 結構/敏感資訊；日誌含追查識別但不含密碼 | NFR-US-16 |
| Secrets/連線憑證 | 一律環境變數；不寫死於程式/commit/log/文件 | NFR-US-05 |

---

## 4. 資料保存與可搬遷

- 業務資料存 PostgreSQL；附件與正式 PDF 存持久化 volume（storage 抽象層）；兩者皆與應用容器分離，容器重建不遺失（NFR-US-04, 07）。
- 環境差異（DB 連線、密碼、網域、儲存路徑、Cookie/HTTPS）全走環境變數；搬遷不改核心業務邏輯（NFR-US-05）。
- 備份涵蓋 DB + 附件 + PDF，保留 ≥14 天、異地保存、每月還原驗證（NFR-US-12, 13；PHASE-011）。
