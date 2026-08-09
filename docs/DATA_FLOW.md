# DATA FLOW — 私車差旅補助管理系統（草案）

- Governance-Version: 2026-08-01.1
- 狀態：DRAFT
- 更新日期：2026-08-09（最後同步至 **PHASE-009（作廢與修正版）**已落地現實；DOC-SYNC `PHASE-009-DOC-SYNC-B`。前次：2026-08-07 `PHASE-008-DOC-SYNC`（C 批），該次未更新本行故 2026-08-05 之日期一度失準）
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
Application 0..1───1 Report (含 PDF 檔案參照；已完成才有；修正版各自新 Report)
Report      0..1───1 VoidedReportFile (作廢版 PDF；作廢時同交易產生)      ← PHASE-009 落地
Application 0..1 ──self── Application (原申請 ─supersededBy→ 修正版)
                          ↑ 落地依據＝修正版列之 supersedesId @unique    ← PHASE-009 落地

FuelPriceVersion      (每公升油價；依油種各自一條時間軸，含生效日期，不重疊)   ← PHASE-005a 落地
User 1───* UserFuelConsumptionVersion (車輛油種 + 油耗 km/L，含生效日期，不重疊) ← PHASE-005a 落地
FuelParameterVersion  (油資每公里；**舊模型**，寫入已凍結、唯讀保留供歷史引用)  ← PHASE-005a D1(a)
EtcParameterVersion   (ETC 每公里，含生效日期，不重疊)
DepreciationParameterVersion (車價/年限，含生效日期，不重疊；預估年里程為**凍結欄**，新版本恆 null) ← PHASE-007 修訂段縮欄

TravelApplication 完成快照 ─引用→ FuelPriceVersion            ← PHASE-005a 落地（新模型）
TravelApplication 完成快照 ─引用→ UserFuelConsumptionVersion   ← PHASE-005a 落地（新模型）
TravelApplication 完成快照 ─引用→ FuelParameterVersion         （舊模型；新流程不再寫入）

CalculationSnapshot (內嵌於已完成 Application：參數值 + 取整前後金額)
```

### 1.1 實體摘要

| 實體 | 重點屬性（概念） | 說明 |
|---|---|---|
| User | 登入帳號、顯示姓名、員工編號(可空)、密碼雜湊、啟用/停用、需強制改密旗標、登入失敗計數/鎖定至、角色(一般/管理員) | 密碼僅存雜湊；員工編號可空 |
| Session | 擁有者、建立/到期、失效狀態 | 停用/重設密碼即失效 |
| Application（抽象） | 擁有人、建立者(操作者)、類型(差旅/保養/折舊)、狀態(草稿/已完成/已作廢)、`primaryDate`、`totalAmount`、`completedAt`、CalculationSnapshot（於三型子表）；**PHASE-009 落地四欄**：`voidReason`（`String?`，trim 後 1..500 由應用層驗證）／`voidedAt`（`DateTime?`）／`voidedById`（`String?`，操作者，**無 FK**，沿 `Report.generatedById` 慣例）／`supersedesId`（`String?` **`@unique`**，指向本列所修正之那筆已完成申請，`onDelete: Restrict`；反向關聯 `supersededBy`） | 三類共用狀態與快照容器。**PHASE-009 落地**：四個新欄**皆 nullable、無 default、零回填**（既有列一律 `NULL`）；前三欄**同生共死**——恆同時為 `null` 或同時非 `null`；`supersedesId` 之 `@unique` 即概念圖 `0..1` 之落地依據（一筆已完成申請至多一個修正版）。四欄之 migration 為 `ALTER TABLE` 加欄，既有十欄逐欄不變 |
| TravelApplication | 出差日期、出差目的；**完成快照**：油資／ETC 每公里單價、快照總里程、取整前金額、計算時間 ＋ **PHASE-005a 新增五欄** `snapshotFuelType`／`snapshotFuelPricePerLiter`（元／L）／`snapshotFuelConsumption`（km/L）／`fuelPriceVersionId`／`fuelConsumptionVersionId` | 差旅專屬 + 多段行程；**PHASE-005a 落地**：新增五欄全部 nullable、無 default、零回填；新舊模型判別與寫入順序見 §2.2 |
| TripSegment | 出發地、到達地、總里程、高速里程、排序 | 屬差旅；≥1 段且每段完成須 ≥1 附件 |
| MaintenanceApplication | **業務 5 欄**：上次/本次保養日期（`@db.Date`，日粒度）、上次/本次里程表、實際費用；**快照 5 欄**：`snapshotIntervalKm`（區間里程）／`snapshotOfficialKm`（期間公務里程）／`snapshotRatio`（比例，6 位小數）／`snapshotRawAmount`（取整前分攤金額）／`calculatedAt` | **PHASE-006 已落地之實體**：`MaintenanceApplication` 子表，1:1 於 `Application`（PK ＝ `applicationId`，`onDelete: Cascade`），與既有 `TravelApplication` 對稱（D1(a)）；本次保養日期為 `Application.primaryDate` 之來源；**最終金額落於既有 `Application.totalAmount`（`Int`）不重複持久化**；**實際費用之快照即 `actualCost` 欄位本身**（完成後凍結，D11(a)，不另存冗餘副本） |
| DepreciationApplication | **業務 2 欄**：申請年度 `applicationYear`（`Int?`，西元年，值域 [1900, 2999]，草稿可為 `null`）／**該車年度總里程 `annualTotalKm`（`Decimal(9,1)?`，使用者申報之申請資料，小數 1 位，草稿可為 `null`）**；**快照 9 欄**：`snapshotVehiclePrice`（`Decimal(12,2)`，車價）／`snapshotUsefulLifeYears`（`Int`）／**`snapshotAnnualDepreciation`（`Decimal(12,2)`，每年折舊費用 2 位小數）**／`snapshotOfficialKm`（`Decimal(12,2)`，年度公務里程）／**`snapshotAnnualTotalKm`（`Decimal(9,1)`，年度總里程）**／**`snapshotRatio`（`Decimal(9,6)`，公務比例，比照保養）**／`snapshotRawAmount`（`Decimal(14,4)`，取整前補貼金額）／`calculatedAt`／`depreciationParameterVersionId`（所引用之折舊參數版本）；**凍結唯讀 2 欄**（舊模型；新申請恆為 `null`）：`snapshotEstimatedAnnualKm`（`Int?`）／`snapshotPerKmUnitPrice`（`Decimal(14,4)?`，折舊每公里單價之 4 位小數） | **PHASE-007 已落地之實體（欄位形狀為折舊模型修訂段之現況）**：`DepreciationApplication` 子表，1:1 於 `Application`（PK ＝ `applicationId`，`onDelete: Cascade`），與既有 `TravelApplication`／`MaintenanceApplication` 對稱（D1(a)）；`Application.primaryDate` ＝ 該年 `12-31`（`applicationYear` 為 `null` 時 ＝ 建立日，D2(a)），**不受 `annualTotalKm` 影響**，為列表排序與期間篩選之權威；**最終金額落於既有 `Application.totalAmount`（`Int`）不重複持久化**；`annualTotalKm`／`snapshotAnnualTotalKm` 之 `Decimal(9,1)` 整數位 8 位恰與既有里程容量慣例（`1e8`）逐字一致，`snapshotRatio` 與 `MaintenanceApplication.snapshotRatio` 逐字一致；凍結二欄之單價欄刻意用 `Decimal(14,4)` 而非沿差旅之 `(10,4)`，以容納舊引擎全部合法輸出（D3(a)）；**車價／年限／預估年里程與版本 id 持久化但不出現於任何折舊 DTO**（每年折舊費用／年度總里程／公務比例則對外呈現，見 ARCHITECTURE §4.11）；自身兩索引：`applicationYear`、`depreciationParameterVersionId`（皆零異動） |
| Attachment | 檔案參照(volume 路徑)、格式、大小、暫存/關聯狀態、所屬申請/項目、上傳時間 | 生命週期核心 |
| Report | **編號 4 欄**：`reportNumber`（`TRV/MNT/DEP-YYYYMM-NNNN`，全域唯一）／`numberPrefix`／`numberPeriod`（`YYYYMM`，Asia/Taipei）／`sequence`（該 `(prefix, period)` 之序號，自 1）；**檔案 4 欄**：`storageKey`（`rpt/<uuid>/pdf`，系統產生、唯一）／`fileName`（**產生時凍結**之安全檔名）／`byteSize`／`contentHash`（SHA-256 hex）；**產生者 2 欄**：`generatedById`（操作者，無 FK，沿 003a/005a 慣例）／`generatedAt`；**冪等鍵** `applicationId`（`@unique`，對 `Application` 為 `onDelete: Restrict`） | **PHASE-008 已落地之實體**：每個 `Application` **至多一份**（修正版為新 `Application` → 新 `Report`）；`Application` 端為**零 DDL 之虛擬關聯欄** `report Report?`；四個唯一約束（`applicationId`／`reportNumber`／`storageKey`／`(numberPrefix, numberPeriod, sequence)`）＋ 一個一般索引 `(numberPrefix, numberPeriod)`（供 `max(sequence)` 查詢）；**併發之最後防線**即上述三欄唯一約束（主防線為顧問鎖，見 ARCHITECTURE §4.7） |
| VoidedReportFile | `reportId`（**`@unique`**，冪等鍵——一份 `Report` 至多一份作廢版；對 `Report` 為 `onDelete: Restrict`）／`storageKey`（`rpt/<uuid>/void`，`@unique`，系統產生）／`fileName`（**與原 `Report.fileName` 相同**——作廢不產生新編號）／`byteSize`／`contentHash`（SHA-256 hex）／`createdById`（作廢操作者，無 FK）／`createdAt` | **PHASE-009 已落地之實體**（D4(b1)）：作廢時於**作廢交易內**產生之作廢版 PDF。**獨立表而非擴充 `Report`** 之理由：`Report` 之「零更新／零刪除路徑」為 PHASE-008 之結構性守門（掃描 `reports/` 原始碼字串），擴充 `Report` 即須更新該列而使守門失效；獨立表使原 `Report` 列與其 PDF 位元組**永不被觸碰**。schema 欄位註解之 `"rpt/<uuid>/void.pdf"` 為**示意字面**，與 storage key 白名單（後綴不接受 `.`）不相容，實際後綴為 `void`——註解之更正列於 `docs/KNOWN_ISSUES.md` |
| ~~PdfFile~~（**已併入 `Report`，PHASE-008 D1(a)**） | —（原「volume 檔案參照、安全檔名」三項屬性） | **本實體不存在**：原規劃之 `PdfFile` 三欄（`storageKey`／`fileName`／`byteSize`＋`contentHash`）**併入 `Report` 同一列**——PDF 與報表列**同生共死**、無獨立生命週期，分表只會製造「有列無檔／有檔無列」之不一致窗口（D1(a) 人類已批准）。歷史條目保留於此以利追溯 |
| Fuel/Etc/DepreciationParameterVersion | 參數值、生效日期 `effectiveFrom`（日粒度，含當日；有效期間不重疊，結束由下一版隱含界定，PHASE-003a D2 方案 A）。**`DepreciationParameterVersion` 自 PHASE-007 修訂段起**：新版本只需車價 ＋ 折舊年限；`estimatedAnnualKm` 為 **nullable 之凍結欄**（建立端點不解析／不驗證／不持久化，夾帶不採用；新版本恆 `NULL`，歷史列原值保留） | 版本化、被引用不可覆寫；折舊每年費用/每公里單價為 derived 不持久化（D7），即算即回；**每公里單價僅對歷史版本推導（唯讀），新版本一律 `null`**。**`FuelParameterVersion` 之油資角色自 PHASE-005a 起由 `FuelPriceVersion` ＋ `UserFuelConsumptionVersion` 取代**（D1(a)：表與既有列保留、寫入端點凍結、`GET` 唯讀），量綱不同（元／km vs 元／L）**不做任何資料換算** |
| FuelPriceVersion | 油種 `fuelType`（GASOLINE_92／95／98／DIESEL 固定四項）、每公升油價 `pricePerLiter`（元／L，≥0）、生效日期 `effectiveFrom`（日粒度，含當日）、建立者、建立時間 | **PHASE-005a 落地**：每油種各自一條時間軸（`@@unique(fuelType, effectiveFrom)`）；僅管理員可寫；被已完成申請快照引用後不可覆寫 |
| UserFuelConsumptionVersion | 使用者 `userId`、油種 `fuelType`、油耗 `kmPerLiter`（km/L，>0）、生效日期 `effectiveFrom`（日粒度，含當日）、核對依據 `basisNote`（必填）、操作管理員、建立時間 | **PHASE-005a 落地**：使用者屬性但**僅管理員可寫**（本人亦不可寫，僅唯讀檢視）；同使用者 `effectiveFrom` 唯一、跨使用者互不干涉；append-only；對 `User` 為 `onDelete: Restrict`（屬該帳號歷史資料，納入刪除守門） |
| AuditLog | 操作者、擁有人、時間、操作類型、受影響資料、前後摘要 | 不含密碼 |

### 1.2 關鍵不變式

- 一般使用者只能存取自己擁有的 Application/Attachment/Report。
- Application 完成即鎖定業務欄位與附件，並寫入 CalculationSnapshot；快照不可變。
- 各類參數版本（ETC／折舊 ParameterVersion、`FuelPriceVersion` 依油種、`UserFuelConsumptionVersion` 依使用者）各自時間軸之有效期間不重疊；被歷史申請引用後內容不可覆寫。
- **折舊快照引用之參數版本不可覆寫**（PHASE-007 D12(a)，已落地）：已完成折舊申請之 `depreciationParameterVersionId` 即為 `DepreciationParameterVersion` 之真實引用來源，`parameterHasReferences("DEPRECIATION", versionId)` 據此判定（引用 ＝ 存在指向該版本且 `Application.status = COMPLETED` 之折舊申請）；歷史補貼金額由快照保證不變（BE-US-19／AD-US-13）。
- 修正版為新 Application（草稿），透過版本關聯指向原申請；原申請與其 PDF 不被改動。
- 統計/計算僅納入「已完成且未作廢」的差旅。
- **（PHASE-009）作廢為狀態取代且不可逆**：`COMPLETED → VOIDED` 是 `ALLOWED_TRANSITIONS` 兩條邊之一，`VOIDED` 為終態——集合中不存在任何離開 `VOIDED` 的邊，故「回復為已完成」在結構上不可達（非以條件式擋下）。作廢**不得**改採與 `COMPLETED` 正交的旗標，否則 `mileage-engine` 之 `status = 'COMPLETED'` 過濾會靜默失效且既有測試不會變紅（PHASE-005 D8(a) 之硬約束，PHASE-009 已依此落地）。
- **（PHASE-009）作廢不改寫任何金額或快照**：作廢只寫 `Application.status` ＋ 三個作廢欄；`totalAmount`／`completedAt` 與三型子表之全部快照欄逐欄不變，`Report` 列與其 PDF 位元組亦不被觸碰。已作廢申請因而仍可呈現「作廢當時金額」並仍可下載其報表。
- **（PHASE-009）原申請與其修正版可同時被統計計入**（D15(a) 之裁定結果，據實記載）：系統**不阻止**「原申請未作廢而修正版已完成」之狀態，兩筆將同時計入里程與金額統計。緩解為前端提示 ＋ 版本關係顯示 ＋ Gate 目視；根治須改變使用者可見行為，須人類批准（見 `docs/KNOWN_ISSUES.md`）。
- **（PHASE-009）`Report` 至多一份 `VoidedReportFile`**（`reportId @unique`）：作廢版之 `fileName` 恆等於原 `Report.fileName`（編號不變）；產生失敗時整筆作廢交易回滾 ＋ 已寫入之 `rpt/` 物件補償刪除，不存在「已作廢但有孤兒作廢版檔」之成功態。
- **已完成申請至多一份 `Report`**（冪等鍵 ＝ `Report.applicationId` 唯一；重複產生回既有列，不新增列、不新增檔、編號／時間／檔名／雜湊全不變）。
- **`Report` 列與其 PDF 檔案同生共死**：產生失敗（`RENDER`／`STORE`／`VERIFY`／`PERSIST` 任一階段）一律零殘留——交易回滾 ＋ 已寫入之檔補償刪除，不存在「有列無檔」或「有檔無列」之成功態。
- **本 Phase 不存在更新或刪除 `Report` 之程式路徑**（結構性掃描守門）；報表內容有誤只能走修正版（PHASE-009），原 `Report` 與其 PDF 位元組不被觸碰。`Report` 對 `Application` 為 `onDelete: Restrict`——有報表之申請無法被刪除，連帶使「有報表之使用者刪除仍為 `409 CONFLICT`」之既有守門成立。

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
- 折舊差異（**折舊模型修訂段之現況**）：完成時取年度公務里程(2.8)、依申請年度 1/1 有效折舊參數推導**每年折舊費用**，補貼 ＝ `ROUND_HALF_UP(每年折舊費用 × 年度公務里程 ÷ 年度總里程, 0)`（先乘後除、取整恰一處）；**年度總里程為使用者於申請上申報之資料**（可編輯、後端驗證），年度公務里程則唯讀不可覆寫；比例 >100% 擋完成、恰 100% 允許完成；證明附件**選填**；快照存車價/年限/每年折舊費用/年度公務里程/年度總里程/比例/取整前後金額。**PHASE-007 落地流程見下。**

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

PHASE-007 落地細節（折舊分支；預覽唯讀路徑與完成快照寫入。**以下為折舊模型修訂段之現況**）：

```
POST /applications/depreciation/preview（唯讀；D13(a)）
  → requireAuth + requirePasswordChanged
  → 【授權】resolveOwnerId(actor, body.ownerId) ── 一般使用者帶他人 → 403（不靜默降級）
       （授權判定先於欄位格式驗證，沿 PHASE-005 B-26／006 §6.1）
  → 欄位驗證（applicationYear ＋ annualTotalKm：型別／小數 ≤1 位／>0／容量）→ 400 fields[]
  → applicationYear == null → calculable=false + [YEAR_REQUIRED]，**不查 DB**
  → annualTotalKm  == null → calculable=false + [ANNUAL_TOTAL_KM_REQUIRED]，**不查 DB**
  → sumOfficialMileage(prisma, { ownerId, YYYY-01-01, YYYY-12-31 })   ← 唯讀，起訖含當日
  → findMany(DepreciationParameterVersion 全部版本)
       → findEffectiveVersion(YYYY-01-01)   ← 純函式選版
  → deriveAnnualDepreciation({ vehiclePrice, usefulLifeYears })   ← PHASE-003a 引擎；
       不再呼叫 deriveDepreciation（每公里單價引擎已自申請路徑退場、行為凍結）
  → calculateDepreciation({ annualDepreciation, officialKm, annualTotalKm })
       → 比例守門（officialKm > annualTotalKm → blocker）＋ 容量判定
  → DepreciationComputedDto
```

```
POST /applications/:id/complete（依 type 分派 → DEPRECIATION）
  → requireAuth + requirePasswordChanged
  → 【授權】嚴格 actor.id === ownerId（D9(a)：僅本人可完成；管理員代操作僅及於草稿）
  → SERIALIZABLE tx（重試）：
       ① SELECT ... FOR UPDATE；assertTransition(status → COMPLETED)   非 DRAFT → 403
       ② computeDepreciationBlockers({ applicationYear, annualTotalKm })（**結構性條件先算**）
             非空 → 400 VALIDATION_ERROR + fields[] + details.blockers[]
             ★ 附件計數**不再**進入 blocker 判定（證明改選填，
               DEPRECIATION_ATTACHMENT_REQUIRED 已退場）；原 tx 內之
               attachment.count 查詢隨其唯一消費者一併移除
       ③ sumOfficialMileage(tx, { ownerId, YYYY-01-01, YYYY-12-31 })
             ← 同一交易內呼叫既有引擎（不重寫過濾與加總）
       ④ version = findEffectiveVersion(findMany(tx), YYYY-01-01)
             null → 409 PARAMETER_NOT_AVAILABLE + details.missing/applicationYear
             deriveAnnualDepreciation → ok:false → 409（訊息與缺參數逐字互異）
       ⑤ calculateDepreciation({ annualDepreciation, officialKm: totalKm, annualTotalKm })
             比例守門（OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM）＋
             容量守門（AMOUNT_OUT_OF_RANGE）**於寫入前**拒絕（4xx；絕不 500、絕不截斷）
       ⑥a DepreciationApplication.update(**9 個快照欄**，顯式定精度；凍結二欄明文寫 null)
       ⑥b Application.update(status=COMPLETED, totalAmount, completedAt)
  → 回應 DTO（含 snapshot.model="CURRENT"；completionBlockers=null、computed=null）
```

- **②與③④之順序不可對調**（同保養）：完成度未過時**不查詢**年度里程與參數。blocker 分兩段計算——結構性條件先算（`YEAR_REQUIRED`／`ANNUAL_TOTAL_KM_REQUIRED`／`ANNUAL_TOTAL_KM_INVALID`），全通過才執行 ③④，再算 `PARAMETER_NOT_AVAILABLE`／`OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM`／`AMOUNT_OUT_OF_RANGE` 並二次判定；純函式以 `officialKm?`／`annualDepreciation?` 之 `null` 表達「尚未查詢」而不產生該類 blocker。
- **零寫入不變式**：預覽路徑**絕不**寫入任何資料列；完成失敗時亦零寫入（`Application.status` 仍為 `DRAFT`、九個快照欄仍為 `null`）。
- **草稿與預覽即暴露不可計算狀態**（blocker ＋ `computed.calculable=false`），不得出現「預覽說可以、完成才擋」之反模式；此禁令一併適用於新增之三碼。**「未輸入年度總里程 ⇒ 不可計算」與「年度公務里程為 0 ⇒ 金額 0 且合法」是兩種不同狀態**，不得以 0 元呈現前者。
- **每年折舊費用與取整**：每年折舊費用一律為 PHASE-003a `deriveAnnualDepreciation` 之 2 位小數字串，以 `Prisma.Decimal(字串)` 還原（不經 `Number()`／`parseFloat`、不再次取整）；`rawAmount = 每年折舊費用 × 年度公務里程 ÷ 年度總里程`（先乘後除、未取整），`amount = ROUND_HALF_UP(rawAmount, 0)`——**本 Phase 取整恰一處**（ARCHITECTURE §4.1 折舊段）。比例之 6 位小數／百分比 4 位小數字串**僅供顯示與快照，不回流計算**；`snapshotRatio` 與 `snapshotRawAmount` 之寫入值與 DTO 呈現走**同一份**實作。
- **新舊模型判別**（比照 §2.2 之 PHASE-005a `fuelPriceVersionId` 判別條目）：新模型列 ＝ `snapshotAnnualTotalKm != null`；舊模型列 ＝ `snapshotPerKmUnitPrice != null` 且 `snapshotAnnualTotalKm == null`；草稿列 ＝ 兩者皆 `null`。完成流程**只寫新模型欄**，凍結二欄明文寫 `null`；舊模型已完成申請之快照逐位元不變，DTO 以 `model="LEGACY"` 呈現其原值（每公里單價原值回傳、新模型四值為 `null`）並**零重算**，且不得因此拋錯或顯示 `NaN`。`parameterHasReferences("DEPRECIATION")` 依 `depreciationParameterVersionId` 判定，兩模型皆適用、零變更。
- **選版一律走純函式**：折舊參數以一次 `findMany` 取**全部版本**後 `findEffectiveVersion(YYYY-01-01)` 選版，**不得**在 DB 層以 `effectiveFrom: { lte }` 先過濾（沿 PHASE-005a 明文紀律）。
- **代操作與年度歸屬**：`ownerId` 恆取自 `Application.ownerId`（絕不為操作者）；年度區間為 `[YYYY-01-01, YYYY-12-31]` **起訖含當日**，依差旅之**出差日期**歸屬。`applicationCount` 純供顯示，金額只用 `totalKm`（D14(a)，見 ARCHITECTURE §4.10 末條）。

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
建立修正版 →（PHASE-009）
  → 不解除、不搬移原附件；於修正版容器**複製**出新列＋新 key（見 2.5）
  → 原附件仍受已完成申請之鎖定保護；副本為修正版草稿之 LINKED 附件
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
使用者 →產生正式報表 POST /applications/:id/report→ reports
  【授權】僅擁有人/管理員(管理員得代行)；判定順序：授權 403 早於狀態判定
  【狀態】申請須為已完成；草稿 → 409 CONFLICT + details.status='DRAFT'(零寫入、零渲染)
  ── 交易外前置(唯讀) ──
  → 冪等前查：該申請已有 Report → 200 回既有 ReportDto(不重產、不重渲染)
  → 讀取快照組裝 ReportData(封閉白名單；零重算、零計算引擎呼叫)
  → 嵌入證明圖片(降尺寸/EXIF 轉正/取小者 → data URI)
  ── 單一交易(READ COMMITTED，本交易限定) ──
  → (a) pg_advisory_xact_lock(hash(numberPrefix, numberPeriod))  ← 交易首語句
  → (b) 冪等再查(鎖內；RC 下鎖外查詢讀不到前位剛提交之列，故順序不可對調)
  → (c) 配號 max(sequence)+1 → reportNumber
  → (d) 帶編號渲染：以同一版型函式產生列印版 HTML → Playwright 產生 PDF
        ★ 配號早於渲染，故持久化 PDF 與列印端點得以同一組編號/產生時間為輸入
  → (e) 校驗 PDF(%PDF- 開頭 / %%EOF 結尾 / 非零長度)
  → (f) storage.put(rpt/<uuid>/pdf)  ← 交易內唯一之檔案寫入
  → (g) 讀回校驗(位元組數 + SHA-256 雜湊)
  → (h) INSERT Report(編號 4 欄 + 檔案 4 欄 + 產生者 2 欄)  ← 唯一之 DB 寫入
  → 提交；序號僅於提交時落庫 → 回滾天然不燒號
  【失敗處理】任一階段失敗 → 500 REPORT_GENERATION_FAILED + details.stage
        (RENDER/STORE/VERIFY/PERSIST)；交易回滾 + 已寫入之檔補償刪除
        → 零 Report 列、零 storage 檔、申請快照逐欄不變、不標示成功
  【併發】同組排隊(顧問鎖)為主防線；三欄唯一約束 + P2002 重試為最後防線
        不同 (prefix, period) 組互不阻擋
使用者 →預覽/列印 GET /applications/:id/report/print→ reports
  【授權】同上；草稿 → 409 CONFLICT + details.status
  【狀態 PHASE-009】放行集合由 COMPLETED 單值擴為 **COMPLETED ∪ VOIDED**
        （白名單）；VOIDED → 200 且首屏渲染 .void-banner（作廢標示＋原因）
        ★ 產生端點（上方 POST）之守門**不**放行 VOIDED（已作廢申請不得產
          生新報表 → 409），兩端點守門字面刻意不同；訊息亦刻意不改寫
          （「僅已完成之申請可檢視列印版」——改寫會使草稿之 409 含「已作
          廢」字樣）
  → 顯示完整內容/計算明細/證明圖片(多段依序、圖片不溢出、多頁不重疊)
  → 與 PDF 同一版型函式、同一輸入 → wire 層字串全等
  → 尚未產生報表之已完成申請亦可預覽(編號/產生時間呈現「尚未產生」，零寫入)
  → 回應四項安全標頭(Content-Type/X-Content-Type-Options/Cache-Control/CSP)
  → 自足文件：零腳本、零外部資源(圖片一律 data URI)
使用者 →下載 PDF GET /applications/:id/report/pdf→ reports
  【授權】僅擁有人/管理員
  【內容選擇 PHASE-009】status=VOIDED 且該 Report 有 VoidedReportFile
        → 回**作廢版**位元組；否則回原檔（fallback：VOIDED 但無作廢版
          ——同交易語意下結構性不可達，僅理論競態窗或歷史資料可達
          ——回原檔，為「保留原始內容」之安全預設，優於 404/500）
        ★ 這是**內容選擇**不是守門：VOIDED 之下載仍為 200，兩分支皆純
          讀取（零渲染、零寫入），重複下載位元組全等之紀律不變
        ★ ASCII fallback 檔名恆取自 Report.reportNumber（作廢不產生新
          編號）；RFC 5987 檔名取自所選來源之 fileName（作廢版依定義
          等於原檔名），故標頭作廢前後逐字不變
  → 檔名取自產生時凍結之 Report.fileName(事後改名不影響；下載時不重新推導)
  → Content-Disposition 雙形式(ASCII fallback + RFC 5987)，零裸 CR/LF
  → 回傳原保存 PDF(重下位元組全等；渲染器零呼叫)
  【尚未產生】404 NOT_FOUND「尚未產生正式報表」(不帶 details.status)
        —— 草稿與「已完成但未產生」之回應逐字相同(AC-25 修訂後語意)
  【檔案遺失】404 NOT_FOUND「報表檔案遺失」(不得 500)；錯誤日誌不含 storage key
使用者 →查詢報表資訊 GET /applications/:id/report→ reports
  【授權】僅擁有人/管理員
  → 200 { report: ReportDto | null }；ReportDto 恰六鍵
        (reportNumber/generatedAt/fileName/byteSize/downloadUrl/printUrl)
  【尚未產生】200 { report: null }（**非 404**）——草稿與「已完成但未產生」逐字相同
```

錯誤流（`REPORT_GENERATION_FAILED`；PHASE-009-T18 落地形狀）：

- **產生端點（`reports/routes.ts`）改經 `AppError` 承載**：捕捉 `report-service.ts` 之 `ReportGenerationError` 後拋 `AppError("REPORT_GENERATION_FAILED", 500, …, undefined, { stage })`，由 error-handler 之 `AppError` 分支以**同一個 `buildErrorBody`** 組出回應。歷史沿革：PHASE-008 撰寫時該碼尚未收錄於 `ErrorCode` 聯集（屬他 Task 之檔案），故當時以 `buildErrorBody` 手動組回應而繞過編譯期收斂；PHASE-008-T11 收錄該碼後繞道之理由消失。wire 格式（`{ error: { code, message, requestId, details: { stage } } }`）**逐位元組不變**，有回歸測試釘住鍵集、鍵序與值，並有結構斷言禁止回退為繞道。
- **作廢端點（`applications/routes.ts`）之同型 500 轉譯仍為 `buildErrorBody` 形狀**（該檔不在 T18 之 Allowed 範圍）：**兩處 wire 輸出完全一致**，僅實作形狀分歧——形狀收斂已登記於 `docs/KNOWN_ISSUES.md`。
- 兩處之 `details` 皆僅含 `{ stage }`（四值封閉，不擴充）；日誌皆僅含 `{ stage, applicationId }`，**不記錄原始錯誤訊息**——storage 錯誤訊息逐字含 key、Chromium 失敗訊息逐字含 executablePath。

### 2.5 修正版（PHASE-009 落地流程；取代原概要）

```
POST /applications/:id/revision
  【授權】requireAuth + requirePasswordChanged
        → 404 存在性（不洩漏申請型別）
        → 403 assertOwnershipOrAdmin（擁有人或管理員；以 DB 之 ownerId 為準）
        ★ 判定順序：401 → 404 → 403 → 409 → 400（授權早於狀態，無側信道）
  【狀態】來源須為 COMPLETED；否則 409
  【既有修正版守門】原申請已有 supersededBy → 409 + details.existingRevisionId
  ── 單一交易（timeout 60s / maxWait 10s）──
  → SELECT ... FOR UPDATE（原申請列鎖）→ 狀態與既有修正版之新鮮再判定
  → 讀原業務欄位（含 TripSegment 全段、LINKED 附件清單）
  → INSERT Application(status=DRAFT, ownerId=原擁有人, createdById=操作者)
       + 三型子列（業務欄位逐欄複製；快照欄與完成類欄位一律不複製）
       ★ 折舊之 applicationYear / annualTotalKm 屬**業務欄位**故複製，
         金額於修正版自己完成時重算（不沿用原快照）
  → set supersedesId = 原申請 id（@unique；P2002 為最後防線，轉同形狀 409）
  → 附件位元組複製（見下）
  → 〔僅代操作〕INSERT AuditLog(APPLICATION_CREATED_ON_BEHALF)
  → COMMIT
  【失敗】整筆回滾 + 已寫入之新 storage key 補償刪除；**原申請零改動**
  → 201 { application }（含 supersedes / supersededBy 兩鍵）
```

附件位元組複製（`attachment/attachment-copy.ts`；D6(c)）：

```
對原申請每一張 LINKED 附件（依容器對位：差旅逐段、保養/折舊單一容器）
  → storage.get(原 key) → 產生新 storageId → storage.put(新 key)   〔原圖〕
  → 縮圖同上（各自新 key）
  → 於**同一交易客戶端**上 INSERT Attachment（refType/refId 指向修正版之容器）
  ★ 順序「先 put 後 insert」沿 upload-service 既有慣例：DB 列一旦存在就必須
    有對應位元組，反序會出現「列指向尚未寫成的 key」之中間態
  ★ 位元組逐位元組相同（SHA-256 前後全等）、key 互異、ownerId 不變
  ★ 失敗 → 補償刪除本次已寫之新 key ＋ 整筆修正版交易回滾（兩側零殘留）
  ★ 日誌零 storage key：本檔永不記 err.message（LocalVolumeStorage 之錯誤
    訊息逐字含 key，而 sanitizeForLog 不遮蔽 storage key），只記錯誤類別名
    稱並改拋訊息固定之 AppError("INTERNAL_ERROR", 500)
```

- **版本關聯之雙向投影**：三型詳情 DTO 一律經 `withRevisionLinks` 附掛兩鍵——`supersedes`（本列所修正之原申請：`id`／`status`／`primaryDate`／該原申請之 `reportNumber`，無報表時 `null`）與 `supersededBy`（本列之修正版：`id`／`status`／`primaryDate`）。此 helper 由 `applications/routes.ts` export 供 `admin/routes.ts` 三個代建端點複用，**每一個回傳詳情 DTO 之端點都必須套用**，否則同一份 DTO 會因端點而異形。列表 DTO 則只投影布林 `isRevision`（＝`supersedesId !== null`），**刻意不外露** `supersedesId` 本身——列表徽章只需「是不是修正版」。
- **修正版完成後產生正式報表為零程式變更**（冪等鍵 ＝ `Report.applicationId`）：新 `Application` → 新編號、新 PDF，原 `Report` 之位元組不被覆寫。

### 2.6 作廢（PHASE-009 落地流程；取代原概要）

```
POST /applications/:id/void   body: { reason }
  【授權】requireAuth + requirePasswordChanged
        → 404 存在性 → 403 assertOwnershipOrAdmin
        ★ 作廢放行管理員（AD-US-10），與 /complete 之 owner-only 刻意不同
  ── 交易外前置（唯讀；零 DB 寫入）──
  → 狀態預判（僅避免無謂工作，權威守門在交易內）
  → 〔status=COMPLETED 時〕prepareVoidedReport：讀快照組裝 ReportData（含
     void 區塊，reason/voidedAt 先以佔位值）＋ 嵌入證明圖片
     ★ **未產生報表**者回 null → 整段渲染流程不執行（零渲染、零 storage 寫入）
  ── 單一交易（READ COMMITTED；timeout 60s / maxWait 10s）──
  → (a) SELECT ... FOR UPDATE（交易首語句）
  → (b) assertTransition(status → VOIDED)   非 COMPLETED → 409 + details.status
  → (c) validateVoidReason(reason)          trim 後空/>500 → 400 + fields[]
        ★ 狀態（409）恆早於原因（400）：草稿+空原因一律回 409
  → (d) UPDATE Application(status=VOIDED, voidReason, voidedAt, voidedById)
  → (e) 〔有報表時〕作廢版 PDF 四階段：
          渲染（以 (d) 之真實 reason/voidedAt 覆寫佔位值）→ storage.put
          (rpt/<uuid>/void) → 讀回校驗（位元組數 + SHA-256）
          → INSERT VoidedReportFile
        ★ 順序不可對調：狀態寫入早於渲染，使 ReportData 恆帶正確作廢資訊
  → (f) INSERT AuditLog(APPLICATION_VOIDED)【稽核】本人與管理員皆寫
  → COMMIT
  【失敗處理】任一階段 → 交易回滾（狀態仍 COMPLETED、快照逐欄不變）
        + storage 補償刪檔（**雙層**：內層＝PDF 四階段自身失敗於拋出前先補償；
          外層＝呼叫端於 voidApplication 拋錯時 plan.compensate()，涵蓋稽核
          hook 拋錯與 commit 失敗）。成功路徑**永不**呼叫補償
        → PDF 階段失敗回 500 REPORT_GENERATION_FAILED + details.stage
  【併發】兩個併發作廢於 FOR UPDATE 排隊；後手以新鮮讀取見 VOIDED 而確定性
        得 409（**不用 SERIALIZABLE + 重試**——只讀寫單一 Application 列，
        列鎖已足以序列化）
  → 200 { application }（void 非 null，含作廢當時金額）
```

- **不變式**：①交易外**零 DB 寫入**；②交易內之 `put` 於任一失敗路徑必補償刪除；③狀態寫入早於渲染；④未產生報表者零渲染、零 storage 寫入；⑤作廢後**不得恢復為已完成**（狀態機集合中無該邊）；⑥統計（2.8）自此排除該筆而**引用保護仍計入**（見 ARCHITECTURE §4.10 兩集合對照表）。
- **作廢後之報表面**：列印版首屏出現 `.void-banner`（作廢標示 ＋ 原因 ＋ 時間，全部經 `escapeHtml` 之唯一插值出口）；下載回作廢版位元組（見 2.4）；產生端點於 `VOIDED` 回 409。
- **`VoidInfoDto` 之投影（三型共用單一函式 `resolveVoidInfo`）**：`reason`／`voidedAt`（ISO8601）／`voidedByDisplayName`（解析失敗為 `"—"`）／`totalAmount`（**作廢當時金額**＝該申請完成時保存之最終整筆金額 `Application.totalAmount`，新臺幣整數）四鍵封閉；未作廢時整個 `void` 恆為 `null`（Empty 態不渲染之依據），故未作廢回應之鍵集**逐鍵不變**。`voidedById` 等內部識別值不外露。**範圍守門**：`totalAmount` 是唯一被放行的快照類數值——`VOIDED` 之 `snapshot` 仍恆為 `null`（三型 service 之 `status === "COMPLETED"` 閘門零改動），單價／比例／計算明細一律不外露；同一整數早已由列表 DTO 無條件投影，本鍵僅消除「列表看得到、詳情看不到」之不一致。

### 2.7 參數維護

```
管理員 →建立參數版本(油資/ETC/折舊)→ parameters
  【授權】僅管理員
  → 值域驗證(油資/ETC ≥0；折舊車價與年限 >0，否則拒並指欄位。PHASE-007 修訂段縮欄後，
       折舊僅驗證此二值——預估年里程已退出端點契約，見下方落地細節)
  → 有效期間重疊檢查 → 重疊則拒並指衝突
  → 未來生效版本不影響現行版本
  → 折舊：推導每年費用(車價÷年限)；每公里單價僅對**歷史版本**推導(唯讀顯示)，新版本為 null
  → 保存新版本【稽核】記修改者/前後重要設定摘要(不涉密碼)
  → 已被歷史申請引用之版本內容不得覆寫；歷史金額由快照保證不變
```

PHASE-003a 落地細節（已實作事實）：

- 三類 `ParameterVersion` 之 `effectiveFrom` 為**日粒度**（`@db.Date`，含當日）；有效期間結束為「同類下一版生效日前一日」隱含推導，不重疊退化為同類 `effectiveFrom` 唯一（D2 方案 A）。
- 折舊 derived（每年費用 / 每公里單價）**不持久化**（D7），依推導引擎即算即回。
- **折舊參數縮欄（PHASE-007 修訂段，已落地；取代上方流程圖之「折舊各值 >0」與「推導每公里單價」二列之折舊部分）**：建立折舊版本只需**車價 ＋ 折舊年限 ＋ 生效日期**，值域驗證亦僅及此二值；`estimatedAnnualKm` 已退出端點契約——不解析、不驗證、不持久化，**夾帶不採用且不回 400**，新版本該欄恆為 `NULL`（欄位保留並轉 nullable，歷史列原值不動）。回應之 `estimatedAnnualKm` 與 `derived.perKmUnitPrice` 對歷史版本回原值（唯讀），對新版本一律 `null`；`derived.annualDepreciation` 兩者皆有值。稽核 `summary` 之欄位集合隨之收斂（回應 DTO 與稽核 summary 為兩份契約）。
- **引用保護以「只增不改」保證**：本 Phase 不提供改/刪版本端點，覆寫版本內容之路徑天然不存在。提供引用偵測介面契約 `parameterHasReferences(type, versionId): boolean`；PHASE-003a 當下引用來源（已完成申請快照）尚不存在，故該 Phase 回傳 false。真實引用判斷與「歷史金額不變」回歸於 PHASE-004/007（以申請完成快照為權威）。
- **上述承諾已於 PHASE-007 兌現完畢（D12(a)，已落地）**：`ParameterType` 加入 `"DEPRECIATION"`，查 `DepreciationApplication.depreciationParameterVersionId` ＋ `Application.status = "COMPLETED"`（與 PHASE-004 之 `"FUEL"`／`"FUEL_PRICE"`／`"FUEL_CONSUMPTION"`／`"ETC"` 同型，一個分支 ＋ 一次 `count`）。**尚無生產呼叫端**——參數版本仍以「只增不改」保證引用保護（無改／刪端點），本函式之接線（清理與覆寫守門）屬 PHASE-010／011。

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
- **作廢之連動為零程式變更（PHASE-009）**：`status = 'COMPLETED'` 字面等值使 `VOIDED` 天然排除，`mileage/` 於 PHASE-009 **零 diff**（有結構斷言守門），並以走**真實作廢端點**之回歸測試證明作廢筆自統計中消失。**引用保護面則相反**——`parameterHasReferences` 之 `status ∈ {COMPLETED, VOIDED}`（D2(a)）；兩集合刻意不同，理由與對照表見 ARCHITECTURE §4.10。
- **已完成快照不因後續作廢而回溯更新**：保養／折舊已完成快照中的期間／年度公務里程是**完成當下**的值；其中某筆差旅事後被作廢時該快照**不變**（BE-US-18「歷史可重現」之直接後果，非缺陷）——見 `docs/KNOWN_ISSUES.md`。

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
| 正式 PDF | 保存於 volume；下載須授權；作廢後保留作廢標示。**PHASE-008 落地補記**：①`storageKey` **由系統產生**（`rpt/<uuid>/pdf`，不含使用者輸入，杜絕路徑穿越與列舉取檔），**封閉前綴白名單**下報表實例只認 `rpt`、附件實例只認 `att`，**跨實例互拒**；②PDF **一律經授權端點回傳**，volume **不得由 nginx 靜態直出**（有結構性守門，見 ARCHITECTURE §4.5）；③**日誌禁字**——`storageKey`（`rpt/`／`att/` 前綴值）、volume 絕對路徑、session cookie／token、密碼、**PDF 位元組或其 base64 片段**一律不入日誌（七類掃描 ＋ 反向探針證明非恆真）；④**折舊揭露面於報表延續**——車價／折舊年限／預估年度行駛公里數／參數版本 id **不出現於列印版與 PDF**（全身分一致，含管理員），與 ARCHITECTURE §4.11 同一契約；⑤**檔名於產生時凍結**（事後改顯示姓名不影響已產生報表之下載檔名），檔名恆不含 `/ \ CR LF NUL` 且恆含報表編號。**PHASE-009 落地補記**：⑥**原 PDF 之位元組於作廢後永不被觸碰**——作廢版以獨立之 `VoidedReportFile`（`rpt/<uuid>/void`）承載，下載端點依狀態**選擇來源**而非改寫原檔；⑦作廢版之 `storageKey` 同樣由系統產生且落於同一封閉前綴白名單（報表實例只認 `rpt`），日誌禁字清單原樣適用；⑧作廢版產生失敗時**補償刪檔**（雙層），不留無主 `rpt/` 物件——in-doubt 窗之殘留歸 PHASE-011 孤兒清理 | FE-US-24, BE-US-27, BE-US-28, NFR-US-10, NFR-US-16 |
| 作廢原因（PHASE-009） | 使用者自由輸入之文字（trim 後 1..500）。**入 DB**（`Application.voidReason`）與**入稽核**（`AuditLog.summary.reason`，BE-US-31② 逐字要求）；**不入日誌**（作廢流程之錯誤日誌僅記 `{ stage, applicationId }` 一類零內容標籤）；**呈現須跳脫**——列印版與 PDF 之插值一律經 `report-html.ts` 之單一 `escapeHtml` 出口（不另開插值路徑），前端另有一層。系統**不做**長度以外之內容審查 | BE-US-31, NFR-US-16 |
| 修正版之附件副本（PHASE-009） | 位元組逐位元組複製為**新 `storageKey`**（原圖與縮圖各自新 key），`ownerId` 與授權面不變——副本仍須通過同一授權端點才能存取；複製失敗時補償刪檔 ＋ 整筆交易回滾。**日誌零 storage key**：複製模組永不記錄底層錯誤訊息原文（其逐字含 key），只記錯誤類別名稱並改拋訊息固定之 500 | NFR-US-10, BE-US-23, NFR-US-16 |
| 稽核紀錄 | 記操作者/擁有人/時間/類型/前後摘要；不含密碼與憑證 | BE-US-31, AD-US-14 |
| 錯誤回應/日誌 | 不外洩堆疊/DB 結構/敏感資訊；日誌含追查識別但不含密碼 | NFR-US-16 |
| Secrets/連線憑證 | 一律環境變數；不寫死於程式/commit/log/文件 | NFR-US-05 |

---

## 4. 資料保存與可搬遷

- 業務資料存 PostgreSQL；附件與正式 PDF 存持久化 volume（storage 抽象層）；兩者皆與應用容器分離，容器重建不遺失（NFR-US-04, 07）。
- 環境差異（DB 連線、密碼、網域、儲存路徑、Cookie/HTTPS）全走環境變數；搬遷不改核心業務邏輯（NFR-US-05）。
- 備份涵蓋 DB + 附件 + PDF，保留 ≥14 天、異地保存、每月還原驗證（NFR-US-12, 13；PHASE-011）。
