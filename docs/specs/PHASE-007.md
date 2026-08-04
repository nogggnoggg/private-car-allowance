# PHASE-007 — 年度折舊補貼

| 項目 | 內容 |
|---|---|
| **Spec 狀態** | `ACTIVE`（**Spec Gate 通過**：人類 leonchih 2026-08-04 裁定「批准開工」——D1~D14 全數照推薦批准、T6/T9 採 T6b/T9b 拆分（總數 18 Task）、High Task 事前批准 12 項（T1~T4、T6、T6b、T7~T9、T9b、T10、T11）。固化紀錄見 §18） |
| **Phase ID** | PHASE-007 |
| **Task ID（本文件產出）** | PHASE-007-SPEC |
| **Base Commit** | `d4950b4`；工作 branch `phase-007`（自 main `973d48f` 切出） |
| **Risk Level** | **High**（金額計算＋參數套用＋不可逆完成快照＋附件權限＋代操作授權；依 CLAUDE.md「認證、授權、密碼、附件權限相關工作一律 High」與 PRD §PHASE-007 判準） |
| **依賴** | PHASE-003（附件生命週期與授權存取，COMPLETED）、PHASE-003a（折舊參數版本 ＋ `deriveDepreciation` 推導引擎 ＋ `findEffectiveVersion` ＋ §14 欄位驗證合約，COMPLETED）、PHASE-004（申請骨架／狀態機／草稿／快照／代操作／綜合查詢／`parameterHasReferences`，COMPLETED）、PHASE-005（公務里程引擎 `sumOfficialMileage`，COMPLETED）、PHASE-005a（油資模型，COMPLETED——**本 Phase 完全不觸油資**）、PHASE-006（保養子表模式／blocker 兩段式／附件容器擴充／完成授權 D7(a)，COMPLETED——**本 Phase 為其同型複製**） |
| **被依賴** | PHASE-008（折舊報表編號 `DEP` 與列印版／PDF）、PHASE-009（折舊之作廢與修正版）、PHASE-010（稽核檢視）、PHASE-011（附件清理之折舊引用保護、效能與索引評估） |
| **對應 US（主要）** | FE-US-17、FE-US-18、FE-US-19、FE-US-20；BE-US-14（**套用端**；推導引擎已於 PHASE-003a 落地）、BE-US-15、BE-US-16、BE-US-17；BE-US-18（折舊快照）、BE-US-24（折舊上限 5）、BE-US-25（折舊完成鎖定）；NFR-US-10（折舊附件） |
| **對應 US（次要／延伸驗收）** | FE-US-04／FE-US-05（列表與篩選之類型擴充）、FE-US-21（草稿附件管理之折舊情境）、FE-US-27（響應式）、AD-US-06／07／08 與 BE-US-03（代操作延伸至折舊）、AD-US-13（折舊參數之引用與歷史不變）、BE-US-19（參數版本引用保護之真實回歸）、BE-US-20（草稿）、BE-US-30（公務總里程引擎之複用）、BE-US-22（作廢排除之既有預留，本 Phase **不實作作廢**） |
| **Human Gate** | **Spec 事前批准（本文件，High；含全部 High Task 之事前批准）** ＋ Mock Gate（折舊表單／預覽／證明）＋ 整合 Gate |
| **產出者** | spec-writer（Task Context Packet `PHASE-007-SPEC`） |

> **本 Spec 的規範基礎**：CLAUDE.md 事實來源優先序 1→5。本文件**不改變任何 User Story 原意、不縮減任何已定稿 AC、不擴大 Scope**。凡標「推薦」者一律**未定案**，須人類於 §16 裁定後方可實作。
>
> **必引前提（開工 Packet 逐條納入）**：
> 1. **折舊單價精度（ARCHITECTURE §4.1 末段，PHASE-003a D3 已批准）**——「**PHASE-007 套用折舊補貼時，必須以 PHASE-003a 回傳之 4 位小數 `perKmUnitPrice` 為準**，再對最終金額一次四捨五入為新臺幣整數；兩處單價精度必須一致」。見 §16 **D6**、AC-17、AC-19。
> 2. **里程引擎唯一實作（ARCHITECTURE §4.10）**——`sumOfficialMileage` 全案只有一份實作；**D2(a) `count`／`SUM` 不對稱**同型適用於折舊（見 §5 B-14、§7.3、AC-13、§16 D14）。
> 3. **PHASE-005 補測遺項 B-12/15/17/19/24/25**——**已於 PHASE-006 全數清償**（PHASE-006 Spec §11.6 裁定，落於 `backend/test/integration/phase6-official-mileage.test.ts`，本 Spec 已逐條實查存在）。本 Phase **不重複補測**，僅在 §11.6 記錄核對結果與折舊專屬之年度邊界新增項。
> 4. **「不得以一般使用者不知道單價為安全前提」**（PHASE-004 D6 修訂，2026-08-02 人類批准）——見 §6.3。折舊每公里單價對一般使用者**可見**（FE-US-18 明文允許），但**內部推導三值不外露**（§16 D8）。
> 5. **005a/006 快照與容量守門慣例**——快照寫入前**全 `Decimal` 欄容量守門**（不只 `int4`）、`AMOUNT_OUT_OF_RANGE` 於草稿／預覽同步暴露（006 D10(a) 同型）、快照顯式定精度、保存 `rawAmount`、**單次取整 kill case**（006 D4(a) 同型：取整層級 mutant 必紅）。
> 6. **006 附件與 on-behalf 模式**——附件三端點 on-behalf 一致模式；`deriveContainerState` 須擴 `refType=DEPRECIATION`（**006 曾實查出佔位回 `'draft'` 之真實漏洞，本 Phase 同型必查**）；`deleteApplication` detach 範圍；代操作夾帶須以**頂層純量** `ownerId`／`createdById` 斷言（006 T8 MF-1 教訓）；稽核 hook 同 tx；**D7(a) 嚴格 owner-only 完成**。
> 7. **AR-1／006 §18 SF-4 裁定 (a)**——管理員代建**停用**使用者之草稿一律擋下 400；折舊端點必須與差旅／保養一致（見 §6.1 第 7 列、AC-34）。

---

## 1. 目標與非目標

### 1.1 目標

1. **折舊草稿**（FE-US-17、BE-US-20）：申請年度單一業務欄位；僅部分資料（含年度為空）亦可保存。
2. **折舊證明附件**（FE-US-19、BE-US-24、BE-US-25、NFR-US-10）：上限 5 張、草稿可缺、完成須 ≥1、完成後鎖定、授權存取。
3. **年度公務里程**（BE-US-15、BE-US-30）：**複用 PHASE-005 引擎 `sumOfficialMileage`**，區間 ＝ `[YYYY-01-01, YYYY-12-31]`（起訖含當日）、僅**擁有人**已完成且未作廢之差旅、依**出差日期**歸屬、高速里程不重複加總；**系統計算、不得提供覆寫欄位**。
4. **折舊參數套用**（BE-US-16、AD-US-13）：依**申請年度 1 月 1 日**有效之 `DepreciationParameterVersion`（`findEffectiveVersion`）；年度中途新版本不影響當年計算；該日無有效版本則**拒絕完成**。
5. **每公里補助單價**（BE-US-14 套用端）：**一律呼叫既有 `deriveDepreciation`（PHASE-003a）**，取其 **4 位小數** `perKmUnitPrice`；本 Phase **不重寫任何推導**。
6. **年度補貼金額**（BE-US-17、FE-US-18）：補貼 ＝ `ROUND_HALF_UP(年度公務里程 × 每公里單價, 0)`，**整筆一次一般四捨五入**為新臺幣整數；後端為唯一權威，**不採前端提交之里程或金額**。
7. **同年度重複申請**（FE-US-17、FE-US-20、BE-US-17）：**允許**建立與完成，同時提供「重複申請提示所需資訊」。
8. **完成與快照**（FE-US-20、BE-US-18、BE-US-25）：完成時於單一交易內驗證→查詢→計算→寫快照（車價／年限／預估年里程／每公里單價／年度公務里程／最終金額，另存取整前金額、計算時間與參數版本 id）→狀態轉換；快照與附件一經完成即不可變；**事後修改參數不改歷史**。
9. **列表與代操作之類型擴充**（FE-US-04／05、AD-US-06/07/08、BE-US-03）：折舊列進入既有綜合列表與篩選；管理員可代建立／代修改折舊草稿並留稽核。
10. **參數引用保護之真實回歸**（BE-US-19、AD-US-13 第 5 條）：`parameterHasReferences` 擴充至 `"DEPRECIATION"`（PHASE-003a §4.7 對 PHASE-007 之既有承諾）。
11. **Phase 結束之人類可操作路徑**：建草稿 → 選年度 → 看到年度公務里程（唯讀）／每公里單價／補貼金額 → 上傳證明 → 完成並保存快照 → 管理員改參數後歷史不變。

### 1.2 非目標（Out of Scope）

| 項目 | 落點 | 說明 |
|---|---|---|
| 折舊報表編號（`DEP`）、列印版、PDF | **PHASE-008** | PRD §PHASE-007 明文 Out of Scope |
| 折舊之修正版與作廢 | **PHASE-009** | 同上；`ApplicationStatus.VOIDED` 於本 Phase **仍無任何轉換路徑**（沿 PHASE-004 AC-58、PHASE-006 §1.2） |
| 稽核檢視頁 | **PHASE-010** | 本 Phase 只**寫入**稽核（沿既有 `AuditAction`），不做檢視 UI |
| 折舊參數之建立／查詢端點與推導引擎 | **不變更**（PHASE-003a 已落地） | 本 Phase 只**呼叫** `deriveDepreciation` 與 `findEffectiveVersion`，不改該二函式之任何行為；`POST\|GET /parameters/depreciation` 零改動 |
| 油資／ETC 參數與差旅任何既有行為 | **不變更** | `travel-calculation.ts`／`travel-parameters.ts`／`completion-blockers.ts`／`mileage-engine.ts`／`mileage-range.ts` 之既有語意**零改動**（改動須經 Stop Condition 回報） |
| 保養任何既有行為 | **不變更** | `maintenance-calculation.ts`／`maintenance-blockers.ts`／`maintenance-service.ts` 零改動（`routes.ts`／`admin/routes.ts`／`lifecycle-service.ts`／`travel-service.ts` 之**新增分支**除外，見 §15） |
| 統計端點 `GET /statistics/mileage` | **不變更** | 只呼叫引擎函式，不改端點行為 |
| 「一人一年一筆」之唯一性約束 | **明確不做** | **US 已明文允許重複**（FE-US-17 第 4 條、FE-US-20 第 2 條、BE-US-17 第 3 條）；提示形狀見 §16 D4 |
| 折舊申請與差旅／保養之交叉一致性檢核 | 永久 Out of Scope（MVP） | US 未要求 |
| 年度里程為 0 時之阻擋 | **明確不做** | US 未要求；補貼 0 元為合法結果（見 §5 B-09、§16 D4 附註）。**新增阻擋屬擴大 Scope，禁止自行加入** |
| 暫存附件之定時清理（TTL 掃除） | PHASE-011 | 本 Phase 只需保證折舊附件之**引用保護語意**可被 PHASE-011 之 `HasReferenceQuery` 查得 |

---

## 2. 可測試 Acceptance Criteria

> **AC 追溯規則**：每條 AC 標註來源 US／PRD／既有 Spec 原文條目。`Tn` ＝ 落在哪個 Task（§15）。
> **金額語意類 AC（AC-17、AC-19~AC-22、AC-28、AC-31、AC-32）之測試一律以精確等值斷言，禁止近似比較。**

### A. 資料模型與 migration

> 來源：BE-US-18 第 3 條「Given 折舊申請完成／When 保存資料／Then 應保存車價、折舊年限、預估年度行駛公里數、折舊單價、年度公務里程及最終金額。」；DATA_FLOW §1.1「DepreciationApplication｜申請年度；(快照:車價/年限/預估年里程/單價/年度里程/補貼金額)」；PHASE-006 D1(a) 子表模式。

- **AC-01** 新增 `DepreciationApplication` 子表（§8.2 形狀），且：
  - **(a)** 乾淨 DB 全新套用全部 migration 成功；新表存在、欄位型別與精度與 §8.2 逐欄相符（精度往返測試：`Decimal(12,2)`／`Decimal(14,4)` 各寫入邊界值後讀回**逐位元相等**）。
  - **(b)** 既有 DB 套用本 migration 後，**既有全部表之既有欄位逐欄位值逐位元不變**（比照 PHASE-006 AC-01(b) 之七表比對，另加 `MaintenanceApplication`＝**八表**）；突變自證：故意改寫任一既有欄位值必紅。
  - **(c)** 新表建立時為空（零回填）；`Application` 父表**零 `ALTER`**（新增之 relation 為 Prisma schema 層反向關聯，不產生 DDL）。
  - **(d)** `migrate deploy` 於既有 DB 與乾淨 DB 各一輪皆成功且冪等。
  - **(e)** **不新增任何 enum 值**：`ApplicationType`／`AttachmentRefType`／`ApplicationStatus`／`AuditAction`／`FuelType`／`Role`／`AttachmentStatus` 之聯集與基線**全等**（`DEPRECIATION` 於 `ApplicationType` 與 `AttachmentRefType` 早已宣告）。
  - **(f)** `infra001-isolation-self-check.test.ts` 之業務表總數斷言 **14 → 15**（**實查全部連動處**，PHASE-006 T1 先例為 5 處而非 Packet 預估之 3 處，**不得低估**）。

### B. 折舊草稿 CRUD 與欄位驗證

> 來源：FE-US-17（「系統應提供申請年度及證明圖片欄位」「草稿缺少證明→允許保存」）、BE-US-20 第 1 條、AD-US-08、PHASE-004 草稿慣例。

- **AC-02** `POST /applications/depreciation`：body 全選填（含 `applicationYear` 可為 `null`／缺省）→ **201**，`ownerId` ＝ 登入者、`createdById` ＝ 登入者、`type="DEPRECIATION"`、`status="DRAFT"`、`totalAmount=null`、全部快照欄為 `null`。**絕不**採用 body 之 `ownerId`／`createdById`／`status`／`totalAmount`。
- **AC-03** 欄位驗證（沿 CHORE-003 分層與 PHASE-003a §14 合約）：`applicationYear` 非整數、非數值型、含小數、超出 §16 **D3** 裁定之值域 → **400 `VALIDATION_ERROR`** ＋ `fields[{ field: "applicationYear", reason }]`；合法值與邊界值（值域上下界恰通過、上下界±1 恰拒絕）各有正負例。**`fields[]` 之 `field` 路徑須有明文斷言**（006 T3 AR-2／FW-5 教訓）。
- **AC-04** `PUT /applications/depreciation/:id`：僅 `DRAFT` 可改；`COMPLETED` → **403**（外層快速失敗 ＋ **交易內 `FOR UPDATE` 後二次守門**，006 M-2 紀律）；`attachmentIds[]` 對帳於同一交易內完成。
- **AC-05** `GET /applications/depreciation/:id` → 200，`DRAFT` 回 `completionBlockers` ＋ `computed`（`snapshot=null`），`COMPLETED` 回 `snapshot`（`completionBlockers=null`、`computed=null`）；`DELETE /applications/:id`（既有 generic 端點）刪除折舊草稿 → 200 且**同一交易內** detach 其 `refType='DEPRECIATION'` 附件（不留孤兒 `LINKED`）；`COMPLETED` → 403。型別不符或不存在之 id → **404**。

### C. 年度語意、重複申請與唯一性

> 來源：FE-US-17 第 4 條「同年度已有其他折舊申請／再次建立／應顯示提醒，但允許繼續」；FE-US-20 第 2 條「同年度已有其他申請／完成新申請／應允許完成」；BE-US-17 第 3 條「應允許，但應提供重複申請提示所需資訊」；共通規則 §5「差旅依出差日期歸屬統計期間及年度」。

- **AC-06** 年度歸屬與 `Application.primaryDate`（§16 **D2**）：`applicationYear` 有值時 `primaryDate` ＝ 該年 **12-31**；為 `null` 時 ＝ 建立當日（沿 PHASE-004 差旅既有慣例）；更新年度時 `primaryDate` 同步更新（同一交易內）。**列表期間篩選與排序依此欄，統計權威仍為差旅之 `tripDate`（不受影響）。**
- **AC-07** 重複申請提示資訊：DTO 回 `duplicateYearNotice`（§7.2 形狀）——同 `ownerId`、同 `applicationYear`、**排除自身**、狀態 ∈ {`DRAFT`,`COMPLETED`}（未來之 `VOIDED` 天然排除）之筆數與是否已有 `COMPLETED`。無其他申請時為 `{ count: 0, hasCompleted: false }`（**非 `null`、非缺鍵**）。`applicationYear` 為 `null` 時為 `null`（無年度即無重複語意）。
- **AC-08** **不設任何 DB 唯一約束**：同一擁有人同一年度可同時存在多筆 `DRAFT`／`COMPLETED`；連續建立兩筆同年度申請皆 **201**（**不得 409**）；兩筆皆可完成（皆 200）。突變自證：加上 `@@unique([ownerId, applicationYear])` 之等效條件檢查必使本 AC 轉紅。

### D. 年度公務里程（引擎複用）

> 來源：BE-US-15 全四條；BE-US-30；FE-US-17 第 2/3 條；ARCHITECTURE §4.10；PHASE-006 §7.3 同型。

- **AC-09** **不重寫引擎**：年度里程一律經 `sumOfficialMileage(db, { ownerId, dateFrom, dateTo })` 取得（§7.3）。以**讀取原始碼之 import 接線斷言 ＋ 活體突變自證**（刪除 import 改為私有複製必紅）證明，比照 PHASE-005a T3R 之作法；`mileage-engine.ts`／`mileage-range.ts` **全 Phase 零 diff**（以 blob hash 或 git diff 斷言）。
- **AC-10** 區間為 `[YYYY-01-01, YYYY-12-31]`，**起訖含當日**：出差日期恰為 1/1 與恰為 12/31 之已完成差旅**皆納入**；前一年 12/31 與次年 1/1 **皆不納入**（四點邊界各一測試）。
- **AC-11** 依**出差日期**歸屬（BE-US-15 第 3 條）：`createdAt` 落於該年但 `tripDate` 不在該年 → **不納入**；`createdAt` 不在該年但 `tripDate` 在該年 → **納入**（兩向各一測試，`createdAt` 以顯式寫入之相異值鑑別）。
- **AC-12** 僅「已完成且未作廢」且**類型為差旅**：`DRAFT` 差旅、他人差旅、`MAINTENANCE`／`DEPRECIATION` 之 `Application` 皆不納入；**高速里程不重複加總**（fixture 須含 `highwayKm > 0` 且 `highwayKm == totalKm` 之真實段落，比照 006 T5R SF-3）。
- **AC-13** **D2(a) `count`／`SUM` 不對稱之折舊處置**（ARCHITECTURE §4.10 末條）：某已完成差旅之 `snapshotTotalKm` 為 `null` 時，`applicationCount` **計入**該列而 `totalKm` **忽略**該列（外觀「筆數 ≥1 但里程 `0.00`」）——**既有引擎行為，本 Phase 不改**。折舊之**任何金額計算一律只使用 `totalKm`**；`applicationCount` 純供顯示，**不得**參與分子、分母或任何推導；DTO 如實回兩值，前端不得據此自行推導或補值。
- **AC-14** `ownerId` **恆為擁有人**（`Application.ownerId`，**絕不**為操作者）：管理員代操作之草稿其年度里程仍以擁有人計算（對照組：管理員本人有差旅、擁有人無差旅 → 里程為 `0.00`）。預覽端點以 `resolveOwnerId` 判定——一般使用者帶他人 `ownerId` → **403 fail-closed，不靜默降級為自己**；管理員可指定任一 `ownerId`。**授權判定先於欄位格式驗證**（沿 PHASE-005 B-26／006 §6.1）。

### E. 折舊參數套用與每公里單價

> 來源：BE-US-16 全四條；BE-US-14；AD-US-13 第 5 條；ARCHITECTURE §4.1 折舊段與 §4.2；PHASE-003a D2/D3/D7。

- **AC-15** 依**申請年度 1 月 1 日**選版：`findEffectiveVersion(全部折舊版本, YYYY-01-01)`（**該類全部版本 `findMany` 後以純函式選版**，**不得**在 DB 層以 `effectiveFrom: { lte }` 先過濾——沿 DATA_FLOW §2.2 PHASE-005a 明文紀律）。測試須含：① 生效日恰為 `YYYY-01-01` 之版本被選中（含當日）② 生效日為 `YYYY-01-02`／該年中途之新版本**不被選中**（BE-US-16 第 3 條）③ 生效日為前一年之版本被選中（最近一版）④ 全部版本皆晚於 `YYYY-01-01` → 查無有效版本。
- **AC-16** 缺參數之處置（§16 **D5**）：該年 1/1 查無有效版本時——
  - **(a)** **完成端點**拒絕：**409 `PARAMETER_NOT_AVAILABLE`**（**沿用既有 `ErrorCode`，不新增**）＋ `details.missing = ["DEPRECIATION"]` ＋ `details.applicationYear`；訊息提示聯絡管理員設定參數（FE-US-18 第 4 條）。
  - **(b)** **草稿與預覽同步暴露**：`completionBlockers` 含 `PARAMETER_NOT_AVAILABLE`（**沿用既有 blocker code**）且 `computed.calculable=false`——**禁止「預覽說可以、完成才擋」之反模式**（005a SF-2／006 D10(a) 同型高危復發點，須有整合測試）。
  - **(c)** 完成失敗時**零寫入**：`Application.status` 仍為 `DRAFT`、全部快照欄仍為 `null`。
- **AC-17** 單價來源（**不重寫推導**）：一律呼叫既有 `deriveDepreciation({ vehiclePrice, usefulLifeYears, estimatedAnnualKm })`（`backend/src/parameters/depreciation-engine.ts`）並取其 **4 位小數字串** `perKmUnitPrice`；以 import 接線斷言 ＋ 活體突變自證（刪 import 改私有複製必紅）證明；`depreciation-engine.ts` **全 Phase 零 diff**。**kill case**：`vehiclePrice=10, usefulLifeYears=3, estimatedAnnualKm=3` → `perKmUnitPrice="1.1111"`（若改以「已取整之每年費用 3.33」為分子得 `1.1100`，必紅）。
- **AC-18** `deriveDepreciation` 回 `{ ok: false }`（任一參數 ≤0；理論不可達，因 `POST /parameters/depreciation` 已於建立時擋下）之處置：視同**缺參數**同型拒絕——**絕不 500、絕不以單價 0 完成、絕不寫入任何快照**；`details.missing` 追加 `"DEPRECIATION_DERIVATION_FAILED"`（**非新增 `ErrorCode`**，比照 005a `FUEL_DATA_CORRUPTED` 之既有作法），訊息與 AC-16(a) **逐字不同**（避免管理員誤查方向）。

### F. 補貼計算（金額核心）

> 來源：BE-US-17 第 1/2/4 條；共通規則 §4；ARCHITECTURE §4.1 折舊段與 PHASE-003a D3；PHASE-006 D4(a) 同型紀律。

- **AC-19** 公式（§7.4 逐字）：`rawAmount = 年度公務里程 × perKmUnitPrice`；`amount = ROUND_HALF_UP(rawAmount, 0)`（新臺幣整數）。**全程 `Prisma.Decimal`，禁止任何浮點中介**；`perKmUnitPrice` 以 `new Prisma.Decimal(字串)` 還原（`deriveDepreciation` 回傳固定 4 位小數字串），**不得**經 `Number()`／`parseFloat`。
- **AC-20** **取整層級**：本 Phase 之取整**恰一處**（最終金額）。單價之 4 位小數取整發生在 **PHASE-003a 引擎內**，本 Phase **不得**再對單價取整、**不得**先取整年度里程、**不得**先取整 `rawAmount` 至 2 位小數再取整。**kill case**：`officialKm = 1234.56`、`perKmUnitPrice = "0.5001"` → `rawAmount = 617.404656` → `amount = 617`；若先將 `rawAmount` 取整至 2 位（`617.40`）再取整仍為 `617`（不具鑑別力，**不可作為 kill case**）——正式 kill case 須由 T2 以窮舉搜尋產生並於 Spec 修訂紀錄回填實際數對（Done When 硬性項：**「先取整 rawAmount 至 2 位」與「先取整 officialKm 至整數」兩種 mutant 各須至少一條測試必紅**）。
- **AC-21** 取整方向為**一般四捨五入（`ROUND_HALF_UP`，0.5 進位、away from zero），非銀行家取整**：kill pair `rawAmount=0.5 → 1` 與 `rawAmount=1.5 → 2`（`ROUND_HALF_EVEN` mutant 於後者必紅）；`rawAmount=0.4999… → 0`、`0.5 → 1` 之最小鑑別對在場。
- **AC-22** 容量守門（§16 **D11**；§8.3 推導）：`snapshotOfficialKm`(`Decimal(12,2)`)／`snapshotPerKmUnitPrice`(`Decimal(14,4)`)／`snapshotRawAmount`(`Decimal(14,4)`)／`Application.totalAmount`(`int4`) 任一超出容量 →
  - **(a)** 純函式層之容量 predicate 回 `true`，**閾值由 schema 精度推導之具名常數**（**不得寫魔術數**，006 T1 AR-6 教訓）；
  - **(b)** 完成端點**於寫入前**以 `AMOUNT_OUT_OF_RANGE` blocker 拒絕（**4xx；絕不 500、絕不靜默截斷**），**零寫入**；
  - **(c)** 草稿與預覽 DTO **同步暴露**該 blocker 與 `computed.calculable=false`；
  - **(d)** 邊界正例在場防誤殺（恰 `1e10 − ε` 通過／恰 `1e10` 拒絕；`2147483647` 通過／`2147483648` 拒絕）。

### G. 折舊證明附件

> 來源：FE-US-19 全三條；BE-US-24（上限 5）；BE-US-25（完成鎖定）；NFR-US-10；ARCHITECTURE §4.5；PHASE-006 D2(a) 同型。

- **AC-23** 上限 5：第 6 張關聯 → **409 `TOO_MANY_ATTACHMENTS`**（沿既有 `canLink`／`linkAttachmentTx`，**不重寫上限邏輯**）；於 `SERIALIZABLE` 交易內對帳，超限時**全交易回滾**（不得部分關聯）；重複 id 之上限繞過封閉。
- **AC-24** 草稿可缺、完成須 ≥1：草稿零附件可儲存（**200/201**，FE-US-17 第 5 條）；完成時 `LINKED` 附件數 < 1 → blocker `DEPRECIATION_ATTACHMENT_REQUIRED` → **400**；**附件計數必須於完成交易內、`FOR UPDATE` 鎖列後同 `tx` `count`**（**不得**沿用交易外 DTO 之快照——否則「DELETE 附件」與「完成」之 write-skew 可產生零證明的 `COMPLETED`，006 T6 FW① 逐字教訓）。
- **AC-25** **完成鎖定（現況缺口修補）**：`deriveContainerState` 之 `refType='DEPRECIATION'` 分支現況**恆回 `'draft'`**（`lifecycle-service.ts:256` 佔位註記「子表尚不存在，PHASE-007，防禦性」）——建表後即成**真實安全缺口**（已完成折舊之證明仍可被刪除／替換，違反 BE-US-25 第 4 條與 NFR-US-10）。本 Phase 擴充為經 `Application.status` 推導（`refId` ＝ `Application.id` ＝ `DepreciationApplication.applicationId`，一次 `findUnique`）：`COMPLETED → 'completed'`；否則（`DRAFT`／不存在孤兒，記 log）→ `'draft'`，**絕不 500**。**須有修復前紅燈實證**（現況「完成後刪除附件回 200」→ 修復後 403）。
- **AC-26** 授權與孤兒：他人之折舊證明 `GET /attachments/:id/content|thumbnail` → **403**（管理員 200）；跨使用者掛入、管理員代掛、`LINKED` 偷渡一律封閉；`deleteApplication` 於刪除折舊草稿時**同一交易內** detach `refType='DEPRECIATION'` 附件（B-25 補洞，**修復前紅燈實證**）。

### H. 完成流程與快照

> 來源：FE-US-20 第 1 條；BE-US-18 第 3 條；BE-US-25；PHASE-006 §9.3 同型；§16 D7/D9。

- **AC-27** 完成流程於**單一 `SERIALIZABLE` 交易**內依 §9.3 之步驟順序執行（含重試與 `isRetryableTransactionConflict`）：`FOR UPDATE` → 狀態機 → 附件計數（tx 內現算）→ 結構性 blocker → 年度里程（tx 內呼叫引擎）→ 參數選版與單價 → 計算 → 容量守門 → 寫快照 → 寫狀態。**②（完成度）與③（里程／參數查詢）之順序不可對調**（見 §9.3 說明）。
- **AC-28** 快照欄位（**BE-US-18 第 3 條逐項**）：完成時寫入 `snapshotVehiclePrice`／`snapshotUsefulLifeYears`／`snapshotEstimatedAnnualKm`／`snapshotPerKmUnitPrice`／`snapshotOfficialKm`／`snapshotRawAmount`／`calculatedAt`／`depreciationParameterVersionId` 共 **8 欄**；最終金額落於既有 `Application.totalAmount`（`Int`），**不重複持久化**。快照寫入**顯式定精度**（`toFixed(scale)` 後以字串建構 `Decimal`，防裁尾零與二次取整）；**`amount` 不得由 `rawAmount` 之 4 位小數反推**（006 T2 AR 前瞻③）。
- **AC-29** 完成授權（§16 **D9**，沿 006 D7(a)）：**僅擁有人本人**可完成——`request.currentUser.id !== application.ownerId` → **403**，**管理員亦然**（不呼叫 `assertOwnershipOrAdmin`）；對照組：本人完成 200。管理員代操作端點**不得**提供代完成路徑（負向斷言）。
- **AC-30** 原子性：於「寫快照後、寫狀態前」等切點注入失敗 → **全交易回滾**（`status` 仍 `DRAFT`、快照全 `null`、`totalAmount` 仍 `null`、附件仍可刪）；`P2025`（完成中被刪）不得以 500 呈現。

### I. 快照不可變、後端權威與併發

> 來源：FE-US-20 第 3 條；BE-US-16 第 4 條；AD-US-13 第 5 條；BE-US-17 第 4 條；FE-US-17 第 3 條；BE-US-19；PHASE-006 AC-28/29 同型。

- **AC-31** **事後改參數，歷史不變**：完成一筆折舊 → 管理員建立新折舊參數版本（生效日更早／同年度中途／更晚三種）→ 重新讀取該申請，`snapshot` 之 **8 欄逐位元不變**、`totalAmount` 不變；**spy 證明讀取路徑零重算**（不再呼叫 `deriveDepreciation`／`sumOfficialMileage`）。**fixture 必經真實完成流程**（直寫 `markCompleted` 會得 `snapshot:null` 而遮蔽斷言，006 T8 FW 教訓）。
- **AC-32** **後端為唯一權威**：建立／更新／完成三端點之 body 夾帶 `officialKm`／`annualOfficialKm`／`perKmUnitPrice`／`rawAmount`／`amount`／`totalAmount`／`snapshotVehiclePrice` 等任一 → **一律不採用**（DB 值與未夾帶之對照組**逐位元相同**）。**夾帶值必須是頂層純量且與正確值可鑑別**（`it.each` 之純量 kill 值 ＋ **DB 層斷言**；巢狀物件與恆真斷言為無效測試，006 T8 MF-1 逐字教訓）；另含 `ownerId`／`createdById`／`status` 之夾帶封閉。
- **AC-33** 併發：同一草稿之兩個完成請求 **恰一成功**，另一為 4xx（**不得 500**）；N 輪迴圈（≥12）而非條件式斷言（006 AR-3 教訓）。`parameterHasReferences("DEPRECIATION", versionId)` 於完成後回 `true`、僅有草稿引用時回 `false`（§16 **D12**；BE-US-19 之真實回歸）。

### J. 代操作與稽核

> 來源：AD-US-06/07/08 全條；BE-US-03；PHASE-004 代操作慣例；PHASE-006 §18 SF-4 裁定 (a)。

- **AC-34** `POST /admin/users/:userId/applications/depreciation`（管理員限定）：→ **201**，`ownerId` ＝ `:userId`、`createdById` ＝ 管理員、`onBehalf=true`；一般使用者呼叫 → **403**；`:userId` 不存在 → **404**；**`:userId` 已停用 → 400 `VALIDATION_ERROR`**（沿差旅／保養既有文案，**006 §18 SF-4 裁定 (a) 一致性義務**）。稽核 `APPLICATION_CREATED_ON_BEHALF`、`summary.type = "DEPRECIATION"`，**與業務寫入同交易**（回滾時稽核亦不留，須以真交易而非 stub 證明）。
- **AC-35** 代修改草稿：管理員 `PUT /applications/depreciation/:id` 於他人草稿 → 200 且寫 `APPLICATION_UPDATED_ON_BEHALF`（`summary.type="DEPRECIATION"`，含變更前後重要欄位摘要，**不含密碼／token／session**）；本人自建／自改**不寫稽核**（沿 PHASE-004 AC-86）；管理員修改**已完成**申請 → **403**（AD-US-08 第 3 條）。**不新增 `AuditAction` enum 值**。

### K. 綜合列表與篩選

> 來源：FE-US-04 全五條；FE-US-05；AD-US-06 第 1/2 條；PHASE-006 D9 同型。

- **AC-36** 折舊列進入既有綜合列表：`type="DEPRECIATION"`、標題 ＝ §16 **D2** 裁定之形式（推薦「年度折舊 YYYY」；年度為 `null` 時「年度折舊（未指定年度）」）、狀態標籤正確；**不適用欄位一律 `null`**（前端顯示「—」）；差旅／保養／折舊混合依 `primaryDate` 倒序之**全序**穩定（同日以既有 tie-breaker）。
- **AC-37** 篩選：`type=DEPRECIATION` 只回折舊列；`status` 與日期區間（起訖含當日，比對 `primaryDate`）正確；`keyword` **天然不匹配折舊列**（無可搜尋文字欄）——沿 PHASE-006 §17.1 #4 列為**已知限制**，PHASE-008 引入報表編號後改善。既有差旅／保養列表測試**零改動**。

### L. 前端

> 來源：FE-US-17／18／19／20 全條；FE-US-27；PHASE-006 前端慣例。

- **AC-38** 表單欄位（FE-US-17 第 1/3 條）：僅提供**申請年度**與**證明圖片**兩類輸入；**年度公務里程為唯讀顯示，畫面上不存在任何可輸入／覆寫該值之欄位**（以「查無該 `name`／`role=textbox` 之負向斷言」固定）。
- **AC-39** 預覽顯示（FE-US-18 第 1/2/3 條）：顯示**折舊每公里補助單價**、年度公務里程、**四捨五入後之年度補貼金額**；**不顯示車價／折舊年限／預估年度行駛公里數**（§16 **D8**；以「畫面文字不含該三值」之負向斷言固定，且後端 DTO 本即不回傳）。前端**零自算**：金額與里程一律取自後端回應（mock 回傳刻意錯誤之值，畫面須照顯示，鑑別「前端自行計算」之實作必紅）。
- **AC-40** 五態（§4）：Loading／Empty／Error／Success／Permission denied 各有測試；不可計算時**不顯示 `0` 元**（顯示「—」或阻擋說明），以 `blockingCodes` 而非 `calculable` 單一旗標決定顯示（006 T5 FW／T11 關鍵教訓）。
- **AC-41** 缺參數提示（FE-US-18 第 4 條）：該年度無有效折舊參數時，顯示「請聯絡管理員設定折舊參數」類文案並**停用完成按鈕**；同時不得因此讓草稿無法儲存（草稿仍可存）。
- **AC-42** 重複提醒與證明（FE-US-17 第 4 條、FE-US-19、FE-US-20 第 2 條）：同年度已有其他申請時顯示提醒文字**但不阻擋**建立與完成（正例：提醒在場且完成鈕可用）；證明上傳／預覽／刪除（草稿階段）可用、第 6 張被拒、完成前無證明時完成鈕停用；已完成申請**無任何上傳／刪除入口**（負向斷言）。

### M. 錯誤合約與日誌

- **AC-43** **不新增任何 `ErrorCode`**：`ErrorCode` 聯集與基線**全等**（BOGUS mutant 必紅）；本 Phase 使用之碼見 §7.6。錯誤回應頂層鍵集合封閉（`code`／`message`／`fields?`／`details?`）。
- **AC-44** 日誌安全：折舊相關路徑之 `logStream` 掃描**不得**出現密碼、token、session cookie、附件位元組；錯誤回應不外洩堆疊／DB 結構／Prisma 錯誤原文。

### N. 響應式與 E2E

- **AC-45** E2E（Playwright，Gate 拓撲）：完整走一筆折舊——登入 → 新增折舊申請 → 選年度 → 看到年度公務里程／單價／補貼金額 → 上傳證明 → 完成 → 列表出現已完成折舊列且金額一致；管理員改參數後重看該筆**金額與單價不變**。播種冪等。
- **AC-46** 響應式（FE-US-27）：折舊表單／預覽／證明區塊／列表四畫面於 **375px** 無水平溢位（`scrollWidth === clientWidth`）。

---

## 3. 正常流程

### 3.1 建立與編輯折舊草稿（FE-US-17、BE-US-20）

1. 使用者於首頁點「新增折舊補貼申請」→ 前端 `POST /applications/depreciation`（body 可為空）→ 201 取得草稿 id。
2. 使用者選擇申請年度 → `PUT /applications/depreciation/:id { applicationYear }` → 後端更新欄位與 `primaryDate`，回傳 DTO 含 `computed`（年度公務里程／單價／補貼金額）、`completionBlockers`、`duplicateYearNotice`。
3. 使用者可反覆修改年度；每次皆重新查詢里程與參數（預覽為唯讀路徑，零寫入）。

### 3.2 預覽年度折舊補貼（FE-US-18）

1. 前端於年度變更時呼叫 `POST /applications/depreciation/preview { applicationYear, ownerId? }`（stateless，不需先建草稿）。
2. 後端：`resolveOwnerId` → 欄位驗證 → `sumOfficialMileage`（唯讀）→ `findEffectiveVersion(YYYY-01-01)` → `deriveDepreciation` → `calculateDepreciation` → 容量判定 → 回 `DepreciationComputedDto`。
3. 前端僅顯示後端回傳值（單價、年度里程、補貼金額），**不自算、不推導**。

### 3.3 上傳折舊證明（FE-US-19）

1. `POST /attachments`（既有端點）上傳 → `TEMP`。
2. `PUT /applications/depreciation/:id { attachmentIds }` → 同交易內對帳 → `LINKED`（`refType='DEPRECIATION'`、`refId=Application.id`），上限 5。
3. 草稿階段可刪除（`DELETE /attachments/:id`，`deriveContainerState` 回 `'draft'`）；完成後不可刪（回 `'completed'` → 403）。

### 3.4 完成年度折舊申請（FE-US-20、BE-US-18）

見 §9.3。完成後 DTO 之 `snapshot` 非空、`computed`／`completionBlockers` 為 `null`。

### 3.5 管理員代操作（AD-US-06/07/08）

1. 管理員於使用者頁面 `POST /admin/users/:userId/applications/depreciation` 建立草稿（owner＝該使用者、createdBy＝管理員、寫稽核）。
2. 管理員可 `PUT /applications/depreciation/:id` 修改該草稿（寫稽核）。
3. 管理員**不可**代完成（AC-29）。

---

## 4. 五態（Loading / Empty / Error / Success / Permission denied）

| 狀態 | 觸發 | 後端 | 前端呈現 |
|---|---|---|---|
| **Loading** | 讀取草稿／預覽計算中 | — | 骨架或「計算中…」；期間不得顯示過期金額（stale 需標示或清空） |
| **Empty** | 年度無任何有效差旅（`totalKm="0.00"`、`applicationCount=0`） | 200 | 顯示「0.00 公里」與「補貼金額 0 元」＋說明文字；**非錯誤、非空白頁**；完成仍可執行（§1.2 明確不阻擋） |
| **Error** | 年度格式錯（400）、缺參數（409／blocker）、容量超出（blocker）、網路／500 | 對應碼 | 就地 zh-TW 文案 ＋ 可定位欄位；缺參數時提示聯絡管理員（AC-41） |
| **Success** | 草稿儲存／完成成功 | 200/201 | 顯示後端回傳之金額與快照；完成後表單轉唯讀、無上傳／刪除入口 |
| **Permission denied** | 未登入（401）／需強制改密（403 PCR）／他人資料（403）／管理員代完成（403） | 對應碼 | 導向登入或顯示無權訊息；**零寫入呼叫**（不得先送出再被擋） |

---

## 5. 邊界條件

| # | 情境 | 預期行為 | 對應 AC |
|---|---|---|---|
| B-01 | `applicationYear` 為 `null`（草稿） | 允許保存；`computed.calculable=false` ＋ blocker `YEAR_REQUIRED`；`duplicateYearNotice=null`；`primaryDate` ＝ 建立日 | AC-02/06/07 |
| B-02 | `applicationYear` 為字串 `"2025"` | 依 §16 D3 裁定：**拒絕**（400，型別嚴格）——與既有數值欄位分層驗證一致 | AC-03 |
| B-03 | `applicationYear` 為 `2025.0`／`2025.5` | `2025.0` 於 JSON 中即整數 `2025`（接受）；`2025.5` → 400 | AC-03 |
| B-04 | `applicationYear` 恰為值域上下界／界外 ±1 | 界內通過、界外 400（四點各一測試） | AC-03 |
| B-05 | 重複帶同名 query／body 鍵（陣列型） | 沿既有 `assertScalarQueryParams` 慣例 → **400**（不得 500） | AC-03/43 |
| B-06 | 閏年（`YYYY=2024`） | 區間 `2024-01-01`~`2024-12-31`；2/29 之差旅正常納入 | AC-10 |
| B-07 | 年度跨越參數版本切換（1/1 有 v1、7/1 有 v2） | 一律用 v1；v2 完全不影響（BE-US-16 第 3 條） | AC-15 |
| B-08 | 該年 1/1 前無任何版本、但年中有版本 | **查無有效版本** → 缺參數處置 | AC-15/16 |
| B-09 | 年度公務里程為 `0.00` | 合法：`rawAmount=0`、`amount=0`；**允許完成**（US 未要求阻擋，§1.2） | AC-13/19 |
| B-10 | 年度里程 > 0 但單價為 `0.0000`（極大年里程參數） | 合法：補貼 0 元；**非錯誤** | AC-19 |
| B-11 | `rawAmount` 恰為 `x.5` | `ROUND_HALF_UP` 進位（kill pair） | AC-21 |
| B-12 | `rawAmount` 落於 `[x.49995, x.5)` | 快照 `rawAmount`（4 位小數）顯示為 `x.5000` 而 `totalAmount` 為 `x`——**外觀矛盾但為正確結果**（006 AR-5 同型）。**Gate 報告須向人類揭露**；PHASE-008 對帳說明必以三來源值重算 | AC-19/28 |
| B-13 | 某已完成差旅之 `snapshotTotalKm` 為 `null` | `applicationCount` 計入、`totalKm` 忽略（D2(a)）；金額只用 `totalKm`，偏差方向**保守**（偏低，不溢付） | AC-13 |
| B-14 | 該年有 101+ 筆已完成差旅 | DB 層單一聚合，不分頁、不截斷；輸出仍為字串（非 JSON number） | AC-09/13 |
| B-15 | 同年度已有 1 筆 `COMPLETED` ＋ 2 筆 `DRAFT` | `duplicateYearNotice = { count: 3, hasCompleted: true }`（排除自身）；建立與完成皆放行 | AC-07/08 |
| B-16 | 同一秒併發建立兩筆同年度草稿 | 皆 **201**（無唯一約束、無 409） | AC-08 |
| B-17 | 完成中另一請求刪除其附件 | `SERIALIZABLE` ＋ tx 內 `count` 使兩者不可能同時成功；恰一成功，另一 4xx（不得 500） | AC-24/33 |
| B-18 | 完成中該草稿被刪除（`P2025`） | 映射為 4xx（404），**不得 500** | AC-30 |
| B-19 | 車價 `9999999999.99`／年限 1／年里程 1 | `perKmUnitPrice ≈ 1e10` → 超出 `Decimal(14,4)` 容量 → `AMOUNT_OUT_OF_RANGE` blocker（**非 500、非截斷**） | AC-22 |
| B-20 | 年度里程極大 × 單價極大 | `rawAmount` 超容量或 `amount` 超 `int4` → 同上 | AC-22 |
| B-21 | 附件恰 5 張再加第 6 張 | 409 `TOO_MANY_ATTACHMENTS`，全交易回滾 | AC-23 |
| B-22 | `attachmentIds` 含重複 id | 去重後計數；不得藉重複繞過上限 | AC-23 |
| B-23 | `attachmentIds` 含他人附件 id | 403（fail-closed），零關聯 | AC-26 |
| B-24 | 已完成折舊之附件被請求刪除 | **403**（AC-25 修復後）；修復前為 200（紅燈實證） | AC-25 |
| B-25 | 刪除折舊草稿後其附件狀態 | 同交易 detach 回 `TEMP`（清 `refType`/`refId`/`linkedAt`），不留孤兒 `LINKED` | AC-05/26 |
| B-26 | 管理員代建草稿予**停用**使用者 | **400**（006 §18 SF-4 裁定 (a) 一致性） | AC-34 |
| B-27 | 管理員未選使用者即代建 | 路徑無 `:userId` 即 404；`:userId` 空字串 → 400/404（AD-US-07 第 3 條） | AC-34 |
| B-28 | 一般使用者於預覽帶他人 `ownerId` | **403**，且回應不含任何數值（不洩漏他人里程） | AC-14 |
| B-29 | 一般使用者帶自己的 `ownerId` | 200（等同不帶） | AC-14 |
| B-30 | 管理員預覽指定他人 `ownerId` | 200（揭露面與既有 `GET /statistics/mileage` **完全相同**，非授權擴張） | AC-14/§6.3 |
| B-31 | `keyword` 篩選 ＋ `type=DEPRECIATION` | 天然零結果（已知限制，非錯誤） | AC-37 |
| B-32 | 列表中折舊列之差旅／保養專屬欄位 | 一律 `null`（前端「—」），**不得**顯示錯誤資料（FE-US-04 第 5 條） | AC-36 |
| B-33 | 年度為 `null` 之草稿出現在列表 | 標題為「年度折舊（未指定年度）」，`primaryDate` ＝ 建立日；不得 500 或顯示 `NaN` | AC-06/36 |
| B-34 | `GET /applications/depreciation/:id` 指向差旅／保養 id | **404**（型別不符） | AC-05 |
| B-35 | 未登入／PCR 存取任一折舊端點 | 401／403 PCR（附件內容端點依 PHASE-003 D8 不掛 PCR） | §6.1 |

---

## 6. 權限與敏感資料

### 6.1 授權矩陣（**格數明列：8 欄 × 5 身分 ＝ 40 格**）

身分：`未登入`／`mustChangePassword（PCR）`／`一般使用者（本人）`／`一般使用者（他人資料）`／`管理員`。

| # | 端點／動作 | 未登入 | PCR | 一般（本人） | 一般（他人） | 管理員 |
|---|---|---|---|---|---|---|
| 1 | `POST /applications/depreciation` | 401 | 403 PCR | **201**（owner＝自己） | n/a（無 `ownerId` 參數） | **201**（owner＝自己） |
| 2 | `GET /applications/depreciation/:id` | 401 | 403 PCR | **200** | 403 | **200** |
| 3 | `PUT /applications/depreciation/:id` | 401 | 403 PCR | **200**（DRAFT）／403（COMPLETED） | 403 | **200**（DRAFT，寫稽核）／403（COMPLETED） |
| 4 | `DELETE /applications/:id`（折舊） | 401 | 403 PCR | **200**（DRAFT）／403（COMPLETED） | 403 | **200**（DRAFT）／403（COMPLETED） |
| 5 | `POST /applications/depreciation/preview` | 401 | 403 PCR | **200**（自己） | **403**（帶他人 `ownerId`） | **200**（可指定任一 `ownerId`） |
| 6 | `POST /applications/:id/complete`（折舊） | 401 | 403 PCR | **200** | 403 | **403**（§16 D9：不提供代完成） |
| 7 | `POST /admin/users/:userId/applications/depreciation` | 401 | 403 PCR | 403 | 403 | **201**（owner＝U、createdBy＝admin、寫稽核；U 不存在 **404**、**U 停用 400**——006 §18 SF-4 裁定 (a)） |
| 8 | `GET /attachments/:id/content｜thumbnail`（折舊證明） | 401 | **200**（沿 PHASE-003 D8，人類 2026-08-01 批准：附件讀取不掛 `requirePasswordChanged`） | **200** | 403 | **200** |

> **資料隔離不變式**（沿 PHASE-004 §6.2／PHASE-006 §6.1）：授權一律以 **DB 載入之 `Application.ownerId`／`Attachment.ownerId`** 為權威，**絕不**採用請求夾帶之任何識別值。`resolveOwnerId` 為「可指定擁有人」查詢之**唯一**判定實作，本 Phase **不得重寫**。
> **判定順序**：授權（401/403）**先於**格式驗證（400），沿 PHASE-005 B-26 既有裁定，避免以 400/403 差異洩漏側信道；須有明文測試固定此順序。

### 6.2 稽核

- 代建立／代修改沿用既有 `AuditAction.APPLICATION_CREATED_ON_BEHALF`／`APPLICATION_UPDATED_ON_BEHALF`，以 `summary.type = "DEPRECIATION"` 區分；**不新增 enum 值**（AC-01(e)、AC-35）。
- 稽核寫入與業務寫入**同交易**（AC-34）；`summary` 不含密碼／token／session cookie。
- 本人自建／自改**不寫稽核**（沿 PHASE-004 AC-86）。
- **無代完成路徑**（AC-29），故本 Phase **不新增**任何完成相關之稽核 action（勿藉稽核擴大授權面，006 T7 FW 教訓）。

### 6.3 敏感資料

- 折舊證明圖片一律經後端授權端點回傳；持久化 volume **不得**由 nginx 靜態直出（ARCHITECTURE §4.5）。
- **「不得以一般使用者不知道單價為安全前提」（PHASE-004 D6 修訂，2026-08-02 人類批准）於本 Phase 之落地**：折舊每公里單價對一般使用者**可見**（FE-US-18 第 3 條明文允許），故**不得**以「使用者看不到單價」作為任何授權設計之前提；一切授權一律以 `ownerId` 判定。預覽端點回傳「該使用者於某年度之公務總里程」——揭露面與既有 `GET /statistics/mileage` **完全相同**（同一引擎、同一 `resolveOwnerId`），**不構成授權擴張**。
- **推導三值不外露**（§16 **D8**）：`vehiclePrice`／`usefulLifeYears`／`estimatedAnnualKm` 於**任何折舊申請 DTO**（草稿／預覽／完成快照）**皆不回傳**——落實 FE-US-18 第 3 條「可以顯示每公里單價，但不得顯示完整內部推導過程」。三值仍**持久化於快照**（BE-US-18 第 3 條明文要求保存）供 PHASE-008 報表與稽核使用；`GET /parameters/depreciation` 維持**管理員限定**（既有行為，零改動），故此為真實隔離而非僅 UI 遮蔽。
- 日誌不得記錄附件位元組、`storageKey` 之外部可猜測形式。

---

## 7. API Contract

> 路徑不含 `/api` 前綴（nginx 剝除）。**標「推薦」者依 §16 相應決策點裁定後定案。**

### 7.1 端點總表

| 方法 | 路徑 | 說明 | 成功回應 |
|---|---|---|---|
| POST | `/applications/depreciation` | 建立折舊草稿（body 全選填） | 201 `{ application: DepreciationApplicationDto }` |
| GET | `/applications/depreciation/:id` | 讀取折舊申請 | 200 `{ application: DepreciationApplicationDto }` |
| PUT | `/applications/depreciation/:id` | 更新草稿（含 `attachmentIds[]`） | 200 `{ application: DepreciationApplicationDto }` |
| DELETE | `/applications/:id` | **既有 generic 端點**，本 Phase 補 `DEPRECIATION` 附件 detach | 200 `{ ok: true }` |
| POST | `/applications/depreciation/preview` | **推薦新增**（§16 D13）；stateless 預覽 | 200 `{ preview: DepreciationComputedDto }` |
| POST | `/applications/:id/complete` | **既有 generic 路徑**，依 `Application.type` **新增 `DEPRECIATION` 分派** | 200 `{ application: DepreciationApplicationDto }` |
| POST | `/admin/users/:userId/applications/depreciation` | 管理員代建立 | 201 `{ application: DepreciationApplicationDto }` |

> 完成沿用**同一 generic 路徑**依型別分派（既有 `routes.ts` 已對 `MAINTENANCE` 如此處理）——**推薦**；替代方案為另開 `/applications/depreciation/:id/complete`（會使前端與 E2E 出現第三套完成路徑，不建議）。列入 §16 **D13**。

### 7.2 DTO 形狀（推薦）

```
DepreciationApplicationDto {
  id: string
  type: "DEPRECIATION"
  status: "DRAFT" | "COMPLETED" | "VOIDED"
  ownerId: string
  ownerDisplayName: string
  createdById: string
  onBehalf: boolean                        // createdById !== ownerId
  primaryDate: string                      // YYYY-MM-DD（§16 D2）
  createdAt: string; updatedAt: string     // ISO8601

  applicationYear: number | null            // 申請年度（西元年整數）

  duplicateYearNotice: { count: number; hasCompleted: boolean } | null   // AC-07

  attachments: AttachmentDto[]             // 沿用 PHASE-003 既有形狀
  completionBlockers: Blocker[] | null     // DRAFT 才有；COMPLETED 為 null
  computed:  DepreciationComputedDto | null// DRAFT 才有
  snapshot:  DepreciationSnapshotDto | null// COMPLETED 才有
}

DepreciationComputedDto {
  calculable: boolean
  officialKm:   string | null    // 2 位小數，未取整（sumOfficialMileage.totalKm）
  officialApplicationCount: number | null   // 僅供顯示（AC-13）
  perKmUnitPrice: string | null  // 4 位小數（deriveDepreciation 之回傳，逐字）
  rawAmount:    string | null    // 4 位小數，取整前
  amount:       number | null    // 新臺幣整數，取整後
  blockingCodes: string[]        // 不可計算之原因代碼（見 §7.5）
}

DepreciationSnapshotDto {
  officialKm: string        // 2 位小數
  perKmUnitPrice: string    // 4 位小數
  rawAmount: string         // 4 位小數
  totalAmount: number       // 整數（＝ Application.totalAmount）
  calculatedAt: string      // ISO8601
}
```

> **`DepreciationComputedDto` 與 `DepreciationSnapshotDto` 皆不含 `vehiclePrice`／`usefulLifeYears`／`estimatedAnnualKm`／`depreciationParameterVersionId`**（§16 **D8**；三值與版本 id 仍持久化於 DB 快照）。
> **金額與里程一律以字串傳輸**（沿 PHASE-003a／004／005／006 既有 DTO 紀律），下游以 `Decimal(字串)` 還原無損；**不得**改用 JSON number。`amount` 為已取整之整數，維持 JSON number（與既有 `totalAmount` 一致）。

### 7.3 年度公務里程之引擎呼叫（不得重寫）

```
sumOfficialMileage(tx, {
  ownerId: application.ownerId,          // 絕不為操作者
  dateFrom: Date(YYYY-01-01, UTC),       // 含當日
  dateTo:   Date(YYYY-12-31, UTC),       // 含當日
}) → { totalKm: Prisma.Decimal, applicationCount: number }
```
- `totalKm` 為**唯一**進入金額計算之值；`applicationCount` 僅映射至 `computed.officialApplicationCount` 供顯示（AC-13）。
- 日期建構沿用既有 `utcDateOnly` UTC 慣例（006 T1 AR-6③／T3 AR-3），**不得**使用本地時區建構。

### 7.4 折舊補貼計算（不得重寫推導）

```
① version = findEffectiveVersion(allDepreciationVersions, Date(YYYY-01-01))
     null → missing = ["DEPRECIATION"]（AC-16）
② derived = deriveDepreciation({
       vehiclePrice: version.vehiclePrice,
       usefulLifeYears: version.usefulLifeYears,
       estimatedAnnualKm: version.estimatedAnnualKm,
   })                                         ← PHASE-003a 引擎，零改動
     ok:false → missing += "DEPRECIATION_DERIVATION_FAILED"（AC-18）
③ perKmUnitPrice = new Prisma.Decimal(derived.perKmUnitPrice)   // 4 位小數字串
④ rawAmount = officialKm.times(perKmUnitPrice)                  // 未取整
⑤ amount    = rawAmount.toDecimalPlaces(0, ROUND_HALF_UP).toNumber()   // 全案唯一取整處
```
> **禁止**：先取整 `officialKm`、先取整 `rawAmount` 至 2 位、對 `perKmUnitPrice` 二次取整、以浮點運算任一步（AC-19/20）。

### 7.5 完成阻擋碼（blocker codes）與固定順序

| 順序 | code | 觸發條件 | zh-TW 訊息（推薦） |
|---|---|---|---|
| 1 | `YEAR_REQUIRED` | `applicationYear` 為 `null` | 請選擇申請年度 |
| 2 | `DEPRECIATION_ATTACHMENT_REQUIRED` | `LINKED` 附件數 < 1 | 請至少上傳 1 張折舊證明 |
| 3 | `PARAMETER_NOT_AVAILABLE` | 該年 1/1 無有效折舊參數，或 `deriveDepreciation` 回 `ok:false` | 該年度尚無有效折舊參數，請聯絡管理員設定 |
| 4 | `AMOUNT_OUT_OF_RANGE` | 計算結果超出欄位容量 | 計算結果超出可儲存之金額範圍，請聯絡管理員檢查折舊參數 |

> **兩段式**（沿 006 §9.3）：**結構性條件（1、2）先算**；非空即拒絕、**不查詢**年度里程與參數（省一次聚合，錯誤語意單一）。全通過才執行里程與參數查詢，再算 **3、4** 並二次判定。純函式以 `officialKm?: Decimal | null`、`perKmUnitPrice?: Decimal | null` 表達「尚未查詢」而**不**產生第 3/4 項。
> **不變式**：`calculable=false ⇒ blockingCodes 至少一項`（006 T5R SF-2 裁定同型），以 sweep 測試守護。
> 完成端點之拒絕形狀：`YEAR_REQUIRED`／`DEPRECIATION_ATTACHMENT_REQUIRED`／`AMOUNT_OUT_OF_RANGE` → **400 `VALIDATION_ERROR`** ＋ `fields[]`（僅具欄位路徑者）＋ `details.blockers[]`（**永遠是完整清單**）；`PARAMETER_NOT_AVAILABLE` → **409**（§16 **D5**，沿差旅既有形狀）＋ `details.missing` ＋ `details.applicationYear`。

### 7.6 錯誤合約

沿用 PHASE-003a §14.2 之分層與文案表、PHASE-001 §5.2 之統一形狀。**本 Phase 不新增任何 `ErrorCode`**（AC-43）。使用之碼：`VALIDATION_ERROR`(400)、`UNAUTHORIZED`(401)、`FORBIDDEN`(403)、`PASSWORD_CHANGE_REQUIRED`(403)、`NOT_FOUND`(404)、`CONFLICT`(409)、`TOO_MANY_ATTACHMENTS`(409)、`PARAMETER_NOT_AVAILABLE`(409)、`UNSUPPORTED_MEDIA_TYPE`(415)、`PAYLOAD_TOO_LARGE`(413)、`INTERNAL_ERROR`(500)、`SERVICE_UNAVAILABLE`(503)。

---

## 8. 資料模型與 migration

### 8.1 不新增 enum

`ApplicationType.DEPRECIATION`（`schema.prisma:256`）與 `AttachmentRefType.DEPRECIATION`（`schema.prisma:165`）**早已宣告**；`ApplicationStatus`／`AuditAction`／`FuelType`／`Role`／`AttachmentStatus` 之既有值皆已足夠（AC-01(e)）。

### 8.2 新增資料表（推薦形狀，精度依 §16 D3 裁定）

```prisma
model DepreciationApplication {
  applicationId String      @id
  application   Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)

  // ── 業務欄位（草稿可為 null；完成後不可變）──
  applicationYear Int?      // 申請年度（西元年）；primaryDate 之來源（§16 D2）

  // ── 完成快照（BE-US-18 第 3 條）；一經寫入不可變 ──
  snapshotVehiclePrice      Decimal? @db.Decimal(12, 2)  // 車價（＝參數版本值）
  snapshotUsefulLifeYears   Int?                          // 折舊年限
  snapshotEstimatedAnnualKm Int?                          // 預估年度行駛公里數
  snapshotPerKmUnitPrice    Decimal? @db.Decimal(14, 4)  // 折舊每公里單價（003a 之 4dp）
  snapshotOfficialKm        Decimal? @db.Decimal(12, 2)  // 年度公務里程
  snapshotRawAmount         Decimal? @db.Decimal(14, 4)  // 取整前補貼金額
  calculatedAt              DateTime?
  depreciationParameterVersionId String?                  // 引用保護來源（§16 D12）
  // 註：最終金額落於既有 `Application.totalAmount`（Int），不重複持久化。

  @@index([applicationYear])
  @@index([depreciationParameterVersionId])
}
```

`Application` 模型新增一條 relation：`depreciation DepreciationApplication?`（與既有 `travel`／`maintenance` 對稱；不改任何既有欄位與索引）。

### 8.3 欄位容量與精度之推導依據（§16 D3 之技術背景）

| 欄位 | 推薦型別 | 容量上界 | 依據 |
|---|---|---|---|
| `applicationYear` | `Int`（int4） | ≤ 2147483647 | 業務值域另由驗證層收斂（§16 D3） |
| `snapshotVehiclePrice` | `Decimal(12,2)` | `|v| < 1e10` | **與來源 `DepreciationParameterVersion.vehiclePrice` 逐字一致** |
| `snapshotUsefulLifeYears`／`snapshotEstimatedAnnualKm` | `Int` | int4 | 與來源欄位一致 |
| `snapshotPerKmUnitPrice` | **`Decimal(14,4)`** | `|v| < 1e10` | **見下方容量缺口 #1**——`perKmUnitPrice` 之理論上界 ＝ `vehiclePrice` 上界（年限＝年里程＝1 時），約 `1e10`；**若照差旅 `fuelUnitPrice Decimal(10,4)`（<1e6）抄，將產生人為容量缺口** |
| `snapshotOfficialKm` | `Decimal(12,2)` | `|v| < 1e10` | 與 `TravelApplication.snapshotTotalKm`／`MaintenanceApplication.snapshotOfficialKm` 一致 |
| `snapshotRawAmount` | `Decimal(14,4)` | `|v| < 1e10` | 與 `TravelApplication.snapshotRawAmount`／`MaintenanceApplication.snapshotRawAmount` 一致 |
| `Application.totalAmount` | `Int`（int4） | ≤ 2147483647 | 既有欄位 |

> **容量缺口 #1（spec-writer 實查發現）**：`DepreciationParameterVersion.vehiclePrice` 為 `Decimal(12,2)`（<1e10），而 `usefulLifeYears`／`estimatedAnnualKm` 之下界為 **1**（`>0` 之整數）——故 `perKmUnitPrice` 理論上界約 `1e10`，**遠超差旅單價欄位 `Decimal(10,4)`（<1e6）之容量**。推薦 `Decimal(14,4)` 使快照欄能容納引擎全部合法輸出，將守門集中於 `rawAmount` 與 `totalAmount` 兩處。**替代方案**（收緊參數表 `vehiclePrice` 精度）會 `ALTER` 既有表並改變 PHASE-003a 已批准之欄位契約，**不建議**——見 §16 D3。
> **容量缺口 #2（必須守門）**：`rawAmount = officialKm(<1e10) × perKmUnitPrice(<1e10)` 之理論上界約 `1e20`，遠超 `Decimal(14,4)`；`amount` 亦可超 `int4`。故 AC-22 之容量守門為**必要**，非防禦性冗餘（與 PHASE-006 AC-19 同型）。

### 8.4 migration 順序與可逆性

- **M1**：`CREATE TABLE "DepreciationApplication"`（含 FK 至 `Application`、兩個 `@@index`）。
- **零 `ALTER`**：既有表**完全不動**（`Application` 之新 relation 為 Prisma schema 層反向關聯，不產生 DDL）。
- **零回填**：新表建立時無任何列。
- **回滾**：`DROP TABLE "DepreciationApplication"`。**補償步驟**：若回滾時已存在 `refType='DEPRECIATION'` 之 `LINKED` 附件，須先 detach 回 `TEMP`（清 `refType`/`refId`/`linkedAt`），否則成為孤兒（`deriveContainerState` 之孤兒分支回 `'draft'`，不致 500 但語意錯誤）。
- **安全網測試**（比照 PHASE-005a T1／PHASE-006 T1）：`backend/test/integration/phase7-migration-safety.test.ts` — 既有 DB 逐表逐欄位值比對（**八表**）、乾淨 DB 全新套用、鍵集全等封閉（`ADD COLUMN` mutant 必紅）、enum 聯集全等、表數 14→15。

---

## 9. Data Flow（本 Phase 影響部分）

### 9.1 草稿儲存（含附件對帳）

```
PUT /applications/depreciation/:id
  → requireAuth + requirePasswordChanged
  → 載入 Application（含 depreciation）→ 404（不存在／型別非 DEPRECIATION）
  → assertOwnershipOrAdmin(actor, application.ownerId)          [授權，DB 權威]
  → assertApplicationMutable(status)                            [外層快速失敗]
  → 欄位格式／值域驗證（CHORE-003 分層）→ 400 fields[]
  → SERIALIZABLE tx（重試）：
       SELECT ... FOR UPDATE on Application
       assertApplicationMutable(freshStatus)                    [交易內再驗，M-2 紀律]
       更新 DepreciationApplication.applicationYear
            + Application.primaryDate（§16 D2 推導）
       附件對帳：computeAttachmentDeltas → detach(移除者) → linkAttachmentTx(新增者, limit=5)
       代操作時 onUpdated hook 寫 AuditLog（同交易）
  → 回應 DTO（含 completionBlockers + computed + duplicateYearNotice）
```

### 9.2 補貼預覽（唯讀路徑）

```
POST /applications/depreciation/preview
  → resolveOwnerId(actor, body.ownerId)                          [一般使用者帶他人 → 403]
  → 欄位驗證（同 9.1）→ 400
  → applicationYear == null → calculable=false + [YEAR_REQUIRED]，**不查 DB**
  → sumOfficialMileage(prisma, { ownerId, YYYY-01-01, YYYY-12-31 })   [唯讀，零寫入]
  → findMany(DepreciationParameterVersion) → findEffectiveVersion(YYYY-01-01)
  → deriveDepreciation(...)                                      [003a 引擎，零改動]
  → calculateDepreciation({ officialKm, perKmUnitPrice })
  → 容量判定 → DepreciationComputedDto
```
**零寫入不變式**：預覽路徑**絕不**寫入任何資料列（比照 PHASE-004 AC-36／006 §9.2），須有測試證明（spy 或 DB 前後快照）。

### 9.3 完成與快照寫入

```
POST /applications/:id/complete
  → requireAuth + requirePasswordChanged
  → 載入 Application → 依 type 分派（DEPRECIATION → 本流程）
  → 嚴格 actor.id === ownerId                                     [§16 D9；不用 assertOwnershipOrAdmin]
  → SERIALIZABLE tx（重試，isRetryableTransactionConflict）：
       ① SELECT ... FOR UPDATE；assertTransition(status → COMPLETED) → 非 DRAFT → 403
       ② attachmentCount = count(LINKED, DEPRECIATION, id)         [tx 內現算，AC-24]
          blockers = computeDepreciationBlockers({ applicationYear, attachmentCount })
          非空 → 400 VALIDATION_ERROR + fields[] + details.blockers[]
       ③ { totalKm, applicationCount } = sumOfficialMileage(tx, {...})   [同交易]
       ④ version = findEffectiveVersion(findMany(tx), YYYY-01-01)
          null → 409 PARAMETER_NOT_AVAILABLE + details.missing/applicationYear
          derived = deriveDepreciation(version) ; ok:false → 409（訊息互異，AC-18）
       ⑤ result = calculateDepreciation({ officialKm: totalKm, perKmUnitPrice })
          容量守門 → AMOUNT_OUT_OF_RANGE blocker → 400，**寫入前**拒絕
       ⑥a DepreciationApplication.update(8 個快照欄，顯式定精度)
       ⑥b Application.update(status=COMPLETED, totalAmount, completedAt)
  → 回應 DTO（含 snapshot；completionBlockers=null、computed=null）
```
> **②與③④之順序不可對調**：完成度未過時**不查詢**里程與參數。故 blocker 分兩段——結構性條件先算，全通過才執行 ③④，再算 `PARAMETER_NOT_AVAILABLE`／`AMOUNT_OUT_OF_RANGE` 並二次判定。
> **草稿與預覽即暴露不可計算狀態**（blocker ＋ `computed.calculable=false`），不得出現「預覽說可以、完成才擋」之反模式。

### 9.4 附件容器狀態推導（既有函式之擴充）

```
deriveContainerState(tx, attachment)
  status != LINKED                                   → 'draft'
  refType = TRIP_SEGMENT → ...（既有，零改動）
  refType = MAINTENANCE  → ...（既有，零改動）
  refType = DEPRECIATION → Application.findUnique(refId).status     ← **本 Phase 新增**
        COMPLETED → 'completed'；DRAFT → 'draft'；不存在（孤兒）→ 'draft' + log.warn
```

---

## 10. 非功能需求

1. **精度紀律**：全程 `Prisma.Decimal`／DB `numeric`，**禁止任何浮點中介**；`Decimal` 建構一律傳字串或既有 `Decimal`；`toNumber()` 僅可於「已取整為整數之後」使用。以結構性掃描測試守門（零 `Number()`／`parseFloat`／`parseInt` 於金額路徑；新增 src 檔須同步入 `PHASE_007_SRC_FILES` 掃描清單，含**掃描器自證**）。
2. **效能**：年度公務里程以 DB 層單次聚合完成（`sumOfficialMileage`），不將命中集合讀入記憶體、不 N+1、不分頁；折舊參數以一次 `findMany` 取全部版本後純函式選版（版本數為個位數量級）；列表沿用既有 `Application` 索引，**不新增 `Application` 索引**（沿 PHASE-005 D9(a)；新表自身之兩個索引屬新表定義）。
3. **可用性**：預覽為唯讀，任何時候失敗不得影響草稿既有資料。
4. **可搬遷**：不新增環境變數、不新增外部依賴、不新增 npm 套件。
5. **相容**：既有差旅／保養／統計／參數之全部測試**零弱化、零 skip、零刪除**；基準線只增不減（起點：後端 **1801/0/0**、前端 **206/0/0**、E2E **30/30**）。

---

## 11. 測試策略

### 11.0 測試紀律（強制，寫入每個 Task Packet）

- **TDD**：先寫會失敗的測試；Handoff 須附「修復前紅燈」之實際輸出。
- **禁止**刪除／弱化／`skip` 既有測試換綠燈。
- **鑑別力**：金額類測試一律精確等值；每個關鍵規則須有 mutant 自證（改壞實作必紅）。
- **INFRA-001 併跑限制持續有效**：不得同時派工兩個會跑 vitest 的 agent（per-worker schema 槽位共用）。
- **新增 src 檔須同步入結構性掃描清單**（沿 PHASE-005a AR-B 機械項）。
- **禁止 spawn 任何 subagent**（治理 2026-08-04.1；PHASE-006 T9 INC 教訓）。

### 11.1 單元（Vitest，不需 DB）

| 對象 | 檔案 | 重點 |
|---|---|---|
| `calculateDepreciation`（純函式） | `backend/test/unit/depreciation-calculation.test.ts` | AC-19/20/21/22；**取整 kill pair**（`0.5→1`、`1.5→2`）；**取整層級 kill case**（先取整 `rawAmount` 至 2 位／先取整 `officialKm`，兩 mutant 各必紅——實際數對由 T2 窮舉產生並回填 §18）；`NaN`／`Infinity`／負值防禦（**絕不回 `NaN`／`Infinity`、絕不靜默回 0**，005a T2 SF-1／006 T2R MF-1 同型陷阱）；容量 predicate 邊界（`1e10−ε` 通過／`1e10` 拒絕；`2147483647` 通過／`2147483648` 拒絕）；零浮點掃描 |
| `computeDepreciationBlockers`（純函式） | `backend/test/unit/depreciation-blockers.test.ts` | AC-16(b)/18/22(c)/24；四碼順序穩定；兩段式語意（`officialKm=null`／`perKmUnitPrice=null` 表「尚未查詢」而不產生第 3/4 項）；不變式 sweep「`calculable=false ⇒ 至少一 blocker`」；`Invalid Date`／`NaN` 防禦 |

### 11.2 整合（Vitest ＋ PostgreSQL ＋ 真實 route）

| 對象 | 檔案 | 重點 |
|---|---|---|
| migration 安全網 | `phase7-migration-safety.test.ts` | AC-01(a)~(f)；**八表**逐欄零改寫；乾淨／既有 DB 各一輪；鍵集全等（`ADD COLUMN` mutant 必紅）；enum 聯集全等；突變自證 |
| 草稿 CRUD | `phase7-depreciation-draft.test.ts` | AC-02/03/04/05；分層 gate table；403 先於 400；B-01~B-05、B-34、B-35 |
| 年度語意與重複 | `phase7-depreciation-year.test.ts` | AC-06/07/08；B-15、B-16、B-33；唯一約束等效 mutant 必紅 |
| 年度公務里程 | `phase7-annual-mileage.test.ts` | AC-09~14；B-06、B-13、B-14；引擎 import 接線斷言＋活體突變自證；`ownerId` 恆為擁有人之對照組 |
| 參數套用與單價 | `phase7-depreciation-parameters.test.ts` | AC-15/16/17/18；B-07、B-08、B-19；`deriveDepreciation` import 接線＋突變自證；缺參數之草稿／預覽／完成三處一致 |
| 附件 | `phase7-depreciation-attachment.test.ts` | AC-23/25/26；B-21~B-25；`deriveContainerState` 之 `DEPRECIATION` 分支**修復前紅燈**；`deleteApplication` detach 補洞**修復前紅燈** |
| 完成與快照 | `phase7-depreciation-complete.test.ts` | AC-24(整合層)/27/28/29/30；交易切點回滾實證；快照雙重可重現性（行內重算對照）；管理員代完成 403（對照組本人 200） |
| 不可變與權威 | `phase7-snapshot-immutability.test.ts` | AC-31/32/33；**頂層純量夾帶矩陣 ＋ DB 層斷言**；spy 零重算；併發 ≥12 輪；`parameterHasReferences("DEPRECIATION")` 正負例 |
| 代操作 | `phase7-on-behalf.test.ts` | AC-34/35；稽核欄位精確（`summary.type`）；真交易回滾證據（非 stub）；停用使用者 400；`ownerId`／`createdById` 分離 |
| 綜合列表 | `phase7-application-list.test.ts` | AC-36/37；三型混合全序；不適用欄 `null`；既有列表測試零改動 |
| 錯誤合約與日誌 | `phase7-contract.test.ts` | AC-43/44；`ErrorCode` 聯集全等（BOGUS mutant 必紅）；頂層鍵集封閉；`logStream` 掃描 |

### 11.3 前端（Vitest ＋ Testing Library，mock fetch）

| 對象 | 檔案 | 重點 |
|---|---|---|
| 折舊申請頁 | `frontend/test/DepreciationApplicationPage.test.tsx` | AC-38~42；**零自算鑑別**（mock 回傳刻意錯誤值，畫面須照顯示）；年度里程無輸入欄之負向斷言；三推導值不出現之負向斷言；`blockingCodes` 驅動之顯示邏輯；五態；Permission denied 零寫入呼叫 |

### 11.4 E2E（Playwright，整合 Gate）

`e2e/depreciation-allowance.spec.ts` — AC-45/46；播種冪等；四畫面 375px 無溢位；管理員改參數後歷史不變之端到端驗證。

### 11.5 安全測試

- 授權矩陣 40 格（§6.1）逐格；他人資料 403、夾帶識別值不越權。
- 判定順序無側信道（403 先於 400）。
- 附件跨使用者掛入／偷渡封閉；已完成附件刪除 403。
- 日誌敏感鍵掃描（AC-44）。

### 11.6 PHASE-005 補測清單之核對結果（**spec-writer 實查，記錄備查**）

Packet 要求評估 PHASE-005 遺項 **B-12/15/17/19/24/25** 是否落本 Phase。**實查結論：六條已於 PHASE-006 全數清償**——PHASE-006 Spec §11.6 明文裁定「全部六條納入本 Phase，**不列入 PHASE-011**」，且 `backend/test/integration/phase6-official-mileage.test.ts` 內確有對應測試（PHASE-006 編號 B-12／B-15／B-16／B-17／B-19／B-20，逐條實查存在）。**本 Phase 不重複補測**。

本 Phase 另補**折舊專屬之年度邊界**（PHASE-005/006 未涵蓋）：B-06（閏年）、B-10（1/1 與 12/31 四點邊界，AC-10）、B-11（`createdAt` 在該年但 `tripDate` 不在，AC-11）。此為測試策略決定，屬 spec-writer 可自主範圍。

---

## 12. AC ↔ 測試映射表（機械可查；隨 Task 完成更新「狀態」欄）

> **格式**：`AC` ｜ `層級` ｜ `測試檔（預定路徑）` ｜ `測試名（預定名稱）` ｜ `Task` ｜ `狀態`
> 狀態值：`PENDING`（Spec 階段）／`RED`（測試已寫且失敗）／`GREEN`（實作完成通過）。
> **Phase 完成前之覆蓋檢查與終審核對以本表為準**（治理 2026-08-02.1）。
> **`GREEN` 列之測試名須為實際存在之測試名（逐字可 `grep`）**；`PENDING` 列為預定名稱，落地後依 `vitest --reporter=verbose` 之實際輸出**逐字回填**。

| AC | 層級 | 測試檔 | 測試名（預定） | Task | 狀態 |
|---|---|---|---|---|---|
| AC-01 | integration | `backend/test/integration/phase7-migration-safety.test.ts` | 實名（verbose 逐字，15 條之對應主測試）：`AC-01(a): the new table's column set, nullability and numeric precision match Spec §8.2 逐欄`；`AC-01(a) 精度往返: Decimal(12,2) / Decimal(14,4) boundary values round-trip byte-for-byte`；`AC-01(a): the new table's PK, FK (onDelete: Cascade) and the two §8.2 indexes exist`；`AC-01(b): every pre-existing column, across all eight representative tables, is byte-for-byte unchanged after migration`；`AC-01(b) 突變自證: the zero-rewrite comparator is discriminating — a single rewritten value, and a single ADDed column, each make it red`；`AC-01(c): the new DepreciationApplication table exists and is empty (零回填) after migrating an existing DB`；`AC-01(c): the migration SQL performs zero ALTER on any pre-existing table (Application 父表零 ALTER)`；`AC-01(c): DepreciationApplication rows cascade-delete with their parent Application (無孤兒子列)`；`AC-01(d): re-running migrate deploy against the already-upgraded existing DB is idempotent (no-op, still succeeds)`；`AC-01(a)/(d): prisma migrate deploy succeeds end-to-end against a brand-new empty DB, and is idempotent on re-run`；`AC-01(e) enum union baseline — all seven enums exactly match the pre-T1 set (no silent additions)`；`AC-01(f) 表數 14→15 — DepreciationApplication is the 15th business table` | T1 | GREEN |
| AC-02 | integration | `phase7-depreciation-draft.test.ts` | `AC-02: POST /applications/depreciation creates a DRAFT with all-null snapshot columns and ignores body-supplied ownerId/status/totalAmount` | T4 | PENDING |
| AC-03 | integration | `phase7-depreciation-draft.test.ts` | `AC-03: applicationYear validation gate table — type/format/range, with fields[].field asserted` | T4 | PENDING |
| AC-04 | integration | `phase7-depreciation-draft.test.ts` | `AC-04: PUT rejects COMPLETED at both the outer guard and inside the transaction (FOR UPDATE re-check)` | T4 | PENDING |
| AC-05 | integration | `phase7-depreciation-draft.test.ts` | `AC-05: GET returns blockers+computed for DRAFT and snapshot for COMPLETED; DELETE detaches DEPRECIATION attachments in the same transaction; wrong-type id is 404` | T4 | PENDING |
| AC-06 | integration | `phase7-depreciation-year.test.ts` | `AC-06: primaryDate is derived from applicationYear (YYYY-12-31) and falls back to the creation date when the year is null` | T5 | PENDING |
| AC-07 | integration | `phase7-depreciation-year.test.ts` | `AC-07: duplicateYearNotice counts same-owner same-year applications excluding self, and is null when applicationYear is null` | T5 | PENDING |
| AC-08 | integration | `phase7-depreciation-year.test.ts` | `AC-08: two applications for the same owner and year are both created (201) and both can be completed — no uniqueness constraint` | T5 | PENDING |
| AC-09 | integration | `phase7-annual-mileage.test.ts` | `AC-09: annual mileage goes through sumOfficialMileage — import wiring asserted from source, with live mutation self-proof` | T6 | PENDING |
| AC-10 | integration | `phase7-annual-mileage.test.ts` | `AC-10: Jan 1 and Dec 31 trips are included; Dec 31 of the previous year and Jan 1 of the next year are excluded` | T6 | PENDING |
| AC-11 | integration | `phase7-annual-mileage.test.ts` | `AC-11: attribution follows tripDate, not createdAt (both directions)` | T6 | PENDING |
| AC-12 | integration | `phase7-annual-mileage.test.ts` | `AC-12: only COMPLETED non-voided TRAVEL of the owner counts; highway km is never double-counted` | T6 | PENDING |
| AC-13 | integration | `phase7-annual-mileage.test.ts` | `AC-13: a null snapshot row is counted by applicationCount but ignored by totalKm; only totalKm feeds the amount` | T6 | PENDING |
| AC-14 | integration | `phase7-annual-mileage.test.ts` | `AC-14: ownerId is always the application owner; preview resolves ownerId fail-closed (403 for another user) and authorises before field validation` | T6 | PENDING |
| AC-15 | integration | `phase7-depreciation-parameters.test.ts` | `AC-15: the version effective on Jan 1 of the application year is selected; mid-year versions never apply` | T7 | PENDING |
| AC-16 | unit ＋ integration | `backend/test/unit/depreciation-blockers.test.ts`；`phase7-depreciation-parameters.test.ts` | `AC-16(b): PARAMETER_NOT_AVAILABLE blocker is produced when no effective version exists`；`AC-16(a)(c): complete returns 409 PARAMETER_NOT_AVAILABLE with details.missing and writes nothing; draft and preview expose the same blocker` | T3 ＋ T7 | PENDING |
| AC-17 | integration | `phase7-depreciation-parameters.test.ts` | `AC-17: perKmUnitPrice comes from deriveDepreciation (4 dp) — import wiring asserted, mutation self-proof, and the 10/3/3 → 1.1111 kill case` | T7 | PENDING |
| AC-18 | unit ＋ integration | `depreciation-blockers.test.ts`；`phase7-depreciation-parameters.test.ts` | `AC-18: deriveDepreciation ok:false is treated as a missing parameter — 409 with a distinct message, never 500, never a zero unit price` | T3 ＋ T7 | PENDING |
| AC-19 | unit | `backend/test/unit/depreciation-calculation.test.ts` | `AC-19: rawAmount = officialKm × perKmUnitPrice and amount = ROUND_HALF_UP(rawAmount, 0), all in Decimal` | T2 | PENDING |
| AC-20 | unit | `depreciation-calculation.test.ts` | `AC-20: rounding happens exactly once — pre-rounding rawAmount to 2 dp and pre-rounding officialKm are each killed by a dedicated case` | T2 | PENDING |
| AC-21 | unit | `depreciation-calculation.test.ts` | `AC-21: ROUND_HALF_UP kill pair (0.5 → 1, 1.5 → 2) — ROUND_HALF_EVEN mutant turns red` | T2 | PENDING |
| AC-22 | unit ＋ integration | `depreciation-calculation.test.ts`；`phase7-depreciation-complete.test.ts` | `AC-22(a)(d): capacity predicate boundaries derived from schema precision, with positive controls`；`AC-22(b)(c): complete rejects with AMOUNT_OUT_OF_RANGE before any write; draft and preview expose the same blocker` | T2 ＋ T9 | PENDING |
| AC-23 | integration | `phase7-depreciation-attachment.test.ts` | `AC-23: the 6th attachment is rejected with 409 TOO_MANY_ATTACHMENTS and the whole transaction rolls back; duplicate ids cannot bypass the limit` | T8 | PENDING |
| AC-24 | unit ＋ integration | `depreciation-blockers.test.ts`；`phase7-depreciation-complete.test.ts` | `AC-24: a draft with zero attachments saves; completing without an attachment is blocked, with the count taken inside the completion transaction after FOR UPDATE` | T3 ＋ T9 | PENDING |
| AC-25 | integration | `phase7-depreciation-attachment.test.ts` | `AC-25: deleting a proof of a COMPLETED depreciation application returns 403 (red before the deriveContainerState fix)` | T8 | PENDING |
| AC-26 | integration | `phase7-depreciation-attachment.test.ts` | `AC-26: another user's proof is 403 (admin 200); deleting a depreciation draft detaches its attachments in the same transaction (red before the fix)` | T8 | PENDING |
| AC-27 | integration | `phase7-depreciation-complete.test.ts` | `AC-27: completion runs as a single SERIALIZABLE transaction in the §9.3 step order, and does not query mileage or parameters when structural blockers exist` | T9 | PENDING |
| AC-28 | integration | `phase7-depreciation-complete.test.ts` | `AC-28: all eight snapshot columns are written with explicit precision and totalAmount lands on Application` | T9 | PENDING |
| AC-29 | integration | `phase7-depreciation-complete.test.ts` | `AC-29: only the owner can complete — an admin gets 403 while the owner succeeds` | T9 | PENDING |
| AC-30 | integration | `phase7-depreciation-complete.test.ts` | `AC-30: an injected failure after the snapshot write rolls the whole transaction back; P2025 surfaces as 4xx, never 500` | T9 | PENDING |
| AC-31 | integration | `phase7-snapshot-immutability.test.ts` | `AC-31: creating new depreciation parameter versions after completion leaves the snapshot byte-for-byte unchanged, with a spy proving zero recomputation` | T10 | PENDING |
| AC-32 | integration | `phase7-snapshot-immutability.test.ts` | `AC-32: top-level scalar payload injection (officialKm/perKmUnitPrice/rawAmount/totalAmount/ownerId/status) is never trusted — asserted at the DB layer` | T10 | PENDING |
| AC-33 | integration | `phase7-snapshot-immutability.test.ts` | `AC-33: concurrent completion — exactly one succeeds over 12 rounds, the loser is 4xx; parameterHasReferences("DEPRECIATION") is true only after completion` | T10 | PENDING |
| AC-34 | integration | `phase7-on-behalf.test.ts` | `AC-34: admin on-behalf create sets ownerId/createdById, writes the audit row in the same transaction, 404s for an unknown user and 400s for a deactivated one` | T11 | PENDING |
| AC-35 | integration | `phase7-on-behalf.test.ts` | `AC-35: admin editing another user's draft writes APPLICATION_UPDATED_ON_BEHALF with summary.type="DEPRECIATION"; self-edit writes nothing; editing a COMPLETED application is 403` | T11 | PENDING |
| AC-36 | integration | `phase7-application-list.test.ts` | `AC-36: depreciation rows appear in the combined list with the correct title and null for inapplicable columns, in a stable total order` | T12 | PENDING |
| AC-37 | integration | `phase7-application-list.test.ts` | `AC-37: type/status/date filters apply to depreciation rows; keyword yields no depreciation rows (documented limitation)` | T12 | PENDING |
| AC-38 | frontend | `frontend/test/DepreciationApplicationPage.test.tsx` | `AC-38: the form exposes only the year and proof inputs — there is no input that can overwrite the annual official mileage` | T13 | PENDING |
| AC-39 | frontend | `DepreciationApplicationPage.test.tsx` | `AC-39: the preview shows unit price, annual mileage and amount from the backend verbatim, and never shows vehicle price / useful life / estimated annual km` | T13 | PENDING |
| AC-40 | frontend | `DepreciationApplicationPage.test.tsx` | `AC-40: five states — loading, empty, error, success, permission denied; a non-calculable state never renders 0 元` | T14 | PENDING |
| AC-41 | frontend | `DepreciationApplicationPage.test.tsx` | `AC-41: a year without an effective parameter shows the contact-admin notice and disables Complete while still allowing the draft to be saved` | T13 | PENDING |
| AC-42 | frontend | `DepreciationApplicationPage.test.tsx` | `AC-42: the duplicate-year notice is shown without blocking; proof upload/delete works on drafts, the 6th is rejected, and a completed application exposes no upload or delete control` | T14 | PENDING |
| AC-43 | integration | `phase7-contract.test.ts` | `AC-43: the ErrorCode union exactly matches the baseline (BOGUS mutant turns red) and error bodies keep a closed top-level key set` | T15 | PENDING |
| AC-44 | integration | `phase7-contract.test.ts` | `AC-44: logStream contains no password, token, session cookie or attachment bytes across the depreciation paths` | T15 | PENDING |
| AC-45 | e2e | `e2e/depreciation-allowance.spec.ts` | `AC-45: full depreciation flow — draft, year, mileage, unit price, amount, proof, complete, list; parameter change afterwards leaves the amount unchanged` | T16 | PENDING |
| AC-46 | e2e | `e2e/depreciation-allowance.spec.ts` | `AC-46: no horizontal overflow at 375px across the four depreciation screens` | T16 | PENDING |

---

## 13. Architecture / Data Flow 需同步項清單（本 Phase 不修改該二檔）

> 由大總管於 Gate 後決定是否另行派工（DOC-SYNC）。

1. **ARCHITECTURE §3 模組表**：`depreciation` 列由概念改為已落地，補列 `backend/src/applications/depreciation-service.ts`／`depreciation-calculation.ts`／`depreciation-blockers.ts`／`depreciation-parameters.ts`；`applications` 列補記折舊落點。
2. **ARCHITECTURE §4.1**：折舊段補「補貼 ＝ `ROUND_HALF_UP(年度公務里程 × perKmUnitPrice(4dp), 0)`，**本 Phase 取整恰一處**（單價之 4dp 取整屬 PHASE-003a）；禁止先取整里程或 `rawAmount`」。
3. **ARCHITECTURE §4.2**：「折舊依申請年度 1/1 選有效版本」由計畫改為**已落地**，補記「全部版本 `findMany` 後純函式選版，不得於 DB 層以 `effectiveFrom: { lte }` 先過濾」。
4. **ARCHITECTURE §4.4**：快照清單之折舊項補「另存 `snapshotRawAmount`、`calculatedAt` 與 `depreciationParameterVersionId`；三推導值持久化但不出現在任何 DTO（D8）」。
5. **ARCHITECTURE §4.5**：補「`deriveContainerState` 自 PHASE-007 起支援 `refType=DEPRECIATION`，經 `Application.status` 推導；`deleteApplication` 一併 detach」。
6. **ARCHITECTURE §4.10**：複用介面段落之「`depreciation`（年度公務里程）之複用仍為**計畫**（PHASE-007）」改為**已落地**，並補記 D2(a) 不對稱之折舊處置（AC-13）。
7. **ARCHITECTURE §4.11 或新節**：補「折舊每公里單價對一般使用者可見，但推導三值不外露」之授權定案（D8）。
8. **DATA_FLOW §1.1／§1.2**：`DepreciationApplication` 由概念條目改為實體條目（欄位逐項，比照 `MaintenanceApplication` 列）；不變式補「折舊快照引用之參數版本不可覆寫」。
9. **DATA_FLOW §2.2**：「折舊差異」段之「（PHASE-007 尚未落地）」改為落地細節（本 Spec §9.3）。
10. **DATA_FLOW §2.7**：PHASE-003a 落地細節之「`parameterHasReferences` 本 Phase 回傳 false／真實引用判斷於 PHASE-004/007」補記折舊已落地（D12）。
11. **PROJECT_STATE 跨 Phase 追蹤**（大總管白名單）：新增「PHASE-008 報表須支援 `DEP` 編號與折舊列印版（單價／年度里程／補貼金額＋證明；三推導值之呈現須依 D8 另行裁定）」與「PHASE-009 折舊作廢須同時排除於統計語意之回歸」。

---

## 14. Rollback

- **新增內容**：1 張新表、6 個後端端點（含 1 個既有 generic 路徑之型別分派、1 個既有 generic 刪除端點之 detach 擴充）、4 個後端純函式／service 模組、3 處既有模組之擴充（`deriveContainerState`、`deleteApplication`、`parameterHasReferences`）、1 個前端頁面＋1 個前端 API 模組、測試。
- **開發階段回滾**：branch `phase-007` 還原至 `d4950b4`；DB 執行 `DROP TABLE "DepreciationApplication"`。
- **既有資料補償**：**無**（本 Phase 不改寫任何既有資料列，AC-01(b) 機械證明）。**唯一例外**：回滾前須先 detach 全部 `refType='DEPRECIATION'` 之 `LINKED` 附件（§8.4）。
- **已產生已完成折舊申請後之回滾**：`DROP TABLE` 會**永久遺失**該批申請之業務欄位與快照（`Application` 列雖仍在，但 `type=DEPRECIATION` 之列將無子表可讀）。**若已有已完成折舊申請，回滾前須先匯出該表**；開發期為合成資料，風險可控。
- **公開 contract 影響**：全部為**新增**（回滾即移除 route）。**既有行為變更**為 `deriveContainerState` 之 `DEPRECIATION` 分支、`deleteApplication` 之 detach 範圍與 `parameterHasReferences` 之型別聯集——前二者為**修補既有缺口**（現況允許已完成折舊之附件被刪除／草稿刪除後留孤兒），回滾即回到有缺口的狀態；後者回滾後 `"DEPRECIATION"` 型別不再受支援（呼叫端僅測試）。
- **不可逆資產**：`AuditLog` 之代操作紀錄一經寫入即為歷史，不刪除。

---

## 15. Task Graph

> 每 Task 一律 TDD、一個 atomic commit（含 Task ID）。**規模上限（Packet）：單 Task ≤ 5 AC、≤ 6 檔、不得同時橫跨 FE＋BE＋DB 三層。**
> **Expected Diff Budget** 依 `docs/retrospective/PHASE-006-usage.md` §3.1 之型態帶：**純函式 ~700–750 行**、**接線整合 ~1100–1250 行**、**FE ~450–700 行**。逾預算 50% 須即時回報（Stop Condition）。**接線型 Task 之 usage 拆分線 ~320k。**

| Task | 內容 | 層 | AC（≤5） | 檔案（≤6） | Risk | 依賴 | Diff 預算 | Done When |
|---|---|---|---|---|---|---|---|---|
| **T1** | Schema ＋ migration ＋ 安全網 ＋ infra 表數連動 | DB | AC-01 | `backend/prisma/schema.prisma`、`backend/prisma/migrations/*`（≤2 檔）、`backend/test/integration/phase7-migration-safety.test.ts`、`backend/test/integration/infra001-isolation-self-check.test.ts` | **High**（不可逆 migration） | — | ~550 | 既有／乾淨 DB 皆 migrate 成功；八表逐欄零改寫；鍵集全等（`ADD COLUMN` mutant 必紅）；enum 聯集全等；**infra001 連動處須逐一實查後回報實際處數**（006 先例 5 處，勿信預估） |
| **T2** | 折舊計算純函式 `calculateDepreciation` ＋ 容量 predicate ＋ 零浮點掃描 | BE（純函式，零接線） | AC-19, 20, 21, 22(判定層) | `backend/src/applications/depreciation-calculation.ts`、`backend/test/unit/depreciation-calculation.test.ts` | **High**（金額核心） | T1 | ~750 | 取整 kill pair 綠；**兩種取整層級 mutant 各有一條測試必紅**（實際數對回填 §18）；`ROUND_HALF_EVEN` mutant 必紅；`NaN`／`Infinity` 三重守門在場；容量常數由 schema 精度推導（零魔術數）；掃描清單含自證 |
| **T3** | 完成度純函式 `computeDepreciationBlockers`（兩段式） | BE（純函式，零接線） | AC-16(b), 18(判定層), 24(判定層) | `backend/src/applications/depreciation-blockers.ts`、`backend/test/unit/depreciation-blockers.test.ts` | **High**（金額守門） | T2 | ~700 | 四碼順序穩定；兩段式（`null` 表未查詢）；不變式 sweep「`calculable=false ⇒ 至少一 blocker`」；`Invalid Date`／`NaN` 防禦 |
| **T4** | 折舊草稿 CRUD service ＋ route ＋ 欄位驗證 ＋ 狀態／授權守門 | BE | AC-02, 03, 04, 05 | `backend/src/applications/depreciation-service.ts`、`backend/src/applications/routes.ts`、`backend/src/applications/travel-service.ts`（僅 `deleteApplication` 之 detach 範圍）、`backend/test/integration/phase7-depreciation-draft.test.ts` | **High**（授權＋狀態機） | T1, T3 | ~1200 | 分層 gate table 全綠；`fields[].field` 路徑有明文斷言；403 先於 400 有明文測試；既有差旅／保養測試零弱化 |
| **T5** | 年度語意：`primaryDate` 推導 ＋ 重複提示 ＋ 無唯一約束 | BE | AC-06, 07, 08 | `backend/src/applications/depreciation-service.ts`、`backend/test/integration/phase7-depreciation-year.test.ts` | Medium | T4 | ~700 | 唯一約束等效檢查 mutant 必紅；`duplicateYearNotice` 排除自身之鑑別測試；年度為 `null` 之全路徑不 500 |
| **T6** | 年度公務里程接線（引擎複用）＋ 預覽授權 | BE | AC-09, 10, 11, 12, 13, 14 → **拆分見下註** | `backend/src/applications/depreciation-service.ts`、`backend/src/applications/routes.ts`、`backend/test/integration/phase7-annual-mileage.test.ts` | **High**（金額上游＋授權） | T2, T4 | ~1250 | 引擎 import 突變自證必紅；`mileage-engine.ts` 零 diff；四點年度邊界全綠；`ownerId` 恆為擁有人之對照組；預覽零寫入實證 |
| **T7** | 折舊參數選版 ＋ 單價套用 ＋ 預覽端點 ＋ `computed` | BE | AC-15, 16(整合層), 17, 18(整合層) | `backend/src/applications/depreciation-parameters.ts`、`backend/src/applications/depreciation-service.ts`、`backend/src/applications/routes.ts`、`backend/test/integration/phase7-depreciation-parameters.test.ts` | **High**（金額上游） | T3, T6 | ~1250 | `deriveDepreciation` import 突變自證必紅；`depreciation-engine.ts` 零 diff；10/3/3 kill case 綠；缺參數於草稿／預覽／完成三處一致 |
| **T8** | 折舊附件：上限 5、`attachmentIds[]` 對帳、完成鎖定（`deriveContainerState` 擴充）、草稿刪除 detach、授權 | BE | AC-23, 25, 26 | `backend/src/attachment/lifecycle-service.ts`、`backend/src/applications/depreciation-service.ts`、`backend/test/integration/phase7-depreciation-attachment.test.ts` | **High**（附件權限） | T4 | ~1200 | AC-25 修復前紅燈（現況可刪）實證；B-25 孤兒補洞修復前紅燈實證；PHASE-003/004/006 既有附件測試零弱化 |
| **T9** | 完成流程 ＋ 快照寫入 ＋ 原子性 ＋ 僅本人授權 | BE ＋ DB（寫入） | AC-24(整合層), 22(整合層), 27, 28, 29, 30 → **拆分見下註** | `backend/src/applications/depreciation-service.ts`、`backend/src/applications/routes.ts`、`backend/test/integration/phase7-depreciation-complete.test.ts` | **High**（不可逆完成／快照） | T7, T8 | ~1250 | 附件計數於 tx 內 `FOR UPDATE` 後現算；交易切點回滾實證；快照顯式定精度；管理員代完成 403（對照組本人 200）；`P2025` 不得 500 |
| **T10** | 快照不可變 ＋ 後端權威 ＋ 併發 ＋ 引用保護 | BE | AC-31, 32, 33 | `backend/src/parameters/reference-guard.ts`、`backend/test/integration/phase7-snapshot-immutability.test.ts` | **High**（金額權威） | T9 | ~1100 | fixture 經真實完成流程；頂層純量夾帶矩陣 ＋ DB 層斷言；spy 零重算；併發 ≥12 輪恰一成功；`parameterHasReferences("DEPRECIATION")` 正負例 |
| **T11** | 代操作（代建立／代修改）＋ 稽核 | BE | AC-34, 35 | `backend/src/admin/routes.ts`、`backend/src/applications/depreciation-service.ts`、`backend/test/integration/phase7-on-behalf.test.ts` | **High**（授權） | T4 | ~900 | 稽核 hook 同 tx（真交易回滾證據，非 stub）；停用使用者 400；`ownerId`／`createdById` 分離；無代完成路徑之負向斷言 |
| **T12** | 綜合列表之折舊列映射 ＋ 篩選 | BE | AC-36, 37 | `backend/src/applications/application-query.ts`、`backend/test/integration/phase7-application-list.test.ts` | Medium | T4 | ~600 | 三型混合全序排序；不適用欄 `null`；PHASE-004/006 既有列表測試零改動 |
| **T13** | 前端：折舊表單 ＋ 預覽 ＋ 缺參數提示 | FE | AC-38, 39, 41 | `frontend/src/api/depreciation.ts`、`frontend/src/types/api.ts`、`frontend/src/pages/DepreciationApplicationPage.tsx`、`frontend/src/App.tsx`、`frontend/src/pages/HomePage.tsx`、`frontend/test/DepreciationApplicationPage.test.tsx` | Medium | T7, T9 | ~700 | 前端零自算鑑別測試綠；年度里程無輸入欄之負向斷言；三推導值不出現之負向斷言 |
| **T14** | 前端：證明上傳／刪除 ＋ 完成流程 ＋ 五態 ＋ 重複提醒 | FE | AC-40, 42 | `frontend/src/pages/DepreciationApplicationPage.tsx`、`frontend/src/components/AttachmentUploader.tsx`（如需折舊情境參數化）、`frontend/src/index.css`、`frontend/test/DepreciationApplicationPage.test.tsx` | Medium | T8, T13 | ~650 | 不可計算不顯示 `0`；`blockingCodes` 驅動顯示；已完成無入口之負向斷言；既有差旅／保養上傳行為零回歸 |
| **T15** | 錯誤合約 ＋ `ErrorCode` 結構性斷言 ＋ 日誌安全 | BE | AC-43, 44 | `backend/test/integration/phase7-contract.test.ts` | Medium | T10, T11 | ~850 | `ErrorCode` 聯集全等（BOGUS mutant 必紅）；`logStream` 六類掃描全綠 |
| **T16** | 響應式 ＋ Gate E2E | FE ＋ E2E | AC-45, 46 | `e2e/depreciation-allowance.spec.ts`、`frontend/src/index.css` | Medium | T14, T15 | ~700 | 全情境綠（大總管親跑於 dev 拓撲）；播種冪等；四畫面 375px 無溢位 |

> **T6／T9 之 AC 數說明（規模上限例外處置）**：T6 名目 6 條、T9 名目 6 條，均超過「≤5 AC」上限。**處置**：AC-13／AC-14 之判定邏輯與 AC-09~12 同屬「一次引擎呼叫之輸出映射」，實作面為同一函式之同一批斷言，**不拆為獨立 Task 會使測試檔重複播種成本翻倍**；AC-22(整合層)／AC-24(整合層) 於 T2／T3 已完成判定層，T9 僅為**接線斷言**。**建議大總管於派工時採下列任一**：(i) 將 AC-13/14 從 T6 切出為 **T6b**（`~450`，Medium，僅整合測試檔）、將 AC-22/24 整合層自 T9 切出為 **T9b**（`~450`）；或 (ii) 於 Packet 明示「本 Task AC 數 6 為 Spec §15 已揭露之例外，經 Gate 一併批准」。**本 Spec 推薦 (i)**，以嚴守規模上限；採 (i) 時總 Task 數為 18。

### 依賴圖

```
T1 ──▶ T2 ──▶ T3 ──▶ T4 ──┬──▶ T5
                            ├──▶ T6 ──▶ T7 ──┐
                            ├──▶ T8 ──────────┴──▶ T9 ──▶ T10 ──┐
                            ├──▶ T11 ──────────────────────────┼──▶ T15 ──┐
                            └──▶ T12                            │          │
                                        T13 ◀── T7, T9          │          │
                                         └──▶ T14 ──────────────┴──────────┴──▶ T16
```

### 規模上限自查

| Task | AC 數 | 檔數 | 跨層 | 合規 |
|---|---|---|---|---|
| T1 | 1 | 4 | DB only（＋1 既有測試檔之機械連動） | ✅ |
| T2 | 4 | 2 | BE only（純函式） | ✅ |
| T3 | 3 | 2 | BE only（純函式） | ✅ |
| T4 | 4 | 4 | BE only | ✅ |
| T5 | 3 | 2 | BE only | ✅ |
| T6 | 6 | 3 | BE only | ⚠️ 見上註（推薦切 T6b） |
| T7 | 4 | 4 | BE only | ✅ |
| T8 | 3 | 3 | BE only | ✅ |
| T9 | 6 | 3 | BE ＋ DB（寫入既有／新表，無 schema 變更） | ⚠️ 見上註（推薦切 T9b） |
| T10 | 3 | 2 | BE only | ✅ |
| T11 | 2 | 3 | BE only | ✅ |
| T12 | 2 | 2 | BE only | ✅ |
| T13 | 3 | 6 | FE only | ✅ |
| T14 | 2 | 4 | FE only | ✅ |
| T15 | 2 | 1 | BE only | ✅ |
| T16 | 2 | 2 | FE ＋ E2E | ✅ |

> **無任何 Task 同時橫跨 FE＋BE＋DB 三層。** T1 為唯一含 schema/migration 之 Task。
> **TDD 順序**：T1（migration 安全網先建立）→ T2/T3（金額與守門純函式，零接線）→ T4（草稿骨架）→ T5（年度語意）→ T6/T7（金額上游：里程與參數）→ T8（附件權限）→ T9/T10（不可逆完成與權威）→ T11/T12（代操作與列表）→ T13/T14（前端）→ T15/T16（合約與 Gate）。

### 與 PRD §PHASE-007「初始 Task Graph 概要」之對照

| PRD Task | 本 Spec 落點 | 說明 |
|---|---|---|
| T1 折舊 Application 概念模型 + 快照容器 + migration | **T1** | 一致 |
| T2 折舊草稿 CRUD + 同年度重複提示 | **T4 ＋ T5** | 拆為「草稿骨架」與「年度語意」（規模上限） |
| T3 年度公務里程統計（複用 005） | **T6** | 一致 |
| T4 套用該年度 1/1 有效折舊參數 + 每公里單價（**High**） | **T7** | 一致 |
| T5 補貼計算（**High**） | **T2（公式／取整）＋ T9（接線與容量）＋ T10（後端權威）** | 拆分 |
| T6 折舊證明上限 5 + 完成須 ≥1（**High**） | **T3（判定層）＋ T8（附件生命週期）** | 拆分（另納入完成鎖定與 detach 補洞） |
| T7 完成流程 + 快照 + 附件鎖定（**High**） | **T9 ＋ T10** | 拆為「完成與快照」與「不可變／權威／併發」 |
| T8 前端折舊表單/預覽/證明 | **T13 ＋ T14 ＋ T16** | 拆分（含 E2E） |
| （PRD 未列） | **T11 代操作、T12 列表、T15 錯誤合約** | US 索引表已將 AD-US-06/07/08、BE-US-03、FE-US-04/05 列為 PHASE-007 之次要關聯，PRD §PHASE-007 之 Task 概要未涵蓋——本 Spec 補齊（見 §19 之 PRD 建議修正 #2） |

**High 風險 Task 清單（須於 Spec Gate 一併取得事前批准）**：**T1、T2、T3、T4、T6、T7、T8、T9、T10、T11** 共 **10 項**（若採 T6b／T9b 拆分，該二子 Task 亦為 High，共 12 項）。

> 與 PRD「High 風險 Task：T4, T5, T6, T7」之差異說明：PRD 之 T4/T5/T6/T7 對應本 Spec 之 T7（參數套用）、T2/T9/T10（補貼計算）、T3/T8（證明）、T9（完成流程），**四者全數涵蓋**；本 Spec 另將 T1（不可逆 migration）、T4（授權與狀態機）、T6（金額上游之引擎接線與 `ownerId` 解析）、T11（代操作授權）升為 High，依據為 CLAUDE.md「認證、授權…相關工作一律 High」與 PHASE-005/005a/006 之既有升級先例。**此升級為保守方向（增加人類批准面），不縮減任何既有 High 判定。**

---

## 16. 需人類批准之決策點（D1~D14）

> 每條格式：**為什麼要決定** ｜ **選項** ｜ **各選項影響** ｜ **推薦**。
> **凡未裁定者，相關 AC 與實作一律不得開工。**

### D1 — 折舊資料模型：新增子表 vs 擴充既有表（**資料模型 ＋ 不可逆 migration，必人類批准**）

**為什麼要決定**：PRD 概要僅說「折舊 Application 概念模型 + 快照容器」，未指定表結構；一經 migration 落地即為不可逆資產。

| 選項 | 內容 |
|---|---|
| **(a) 新增 `DepreciationApplication` 子表**（1:1 於 `Application`，PK ＝ `applicationId`） | 完全比照既有 `TravelApplication`／`MaintenanceApplication` |
| (b) 於 `Application` 父表直接加折舊欄位 | 不新增表 |
| (c) 通用 `Application.details Json` | 三型共用一個 JSON |

**各選項影響**
- **(a)**：與已落地之兩張子表對稱、型別安全；`Application` 父表**零 `ALTER`**（AC-01(c) 最強保證）；`application-query.ts` 之 `include` 形狀相容；PHASE-006 之測試與 service 骨架可原樣複製。缺點：新增一張表（infra 自檢表數機械連動）。
- **(b)**：父表被灌入 9 個僅對一型有意義之可空欄（加上保養若當初也如此則 20+），且需 `ALTER` 既有表 → 直接削弱 AC-01(b)；與已落地之保養模式不一致。
- **(c)**：喪失型別安全與 DB 精度約束；`Decimal` 精度紀律無法由 schema 保證（違反 §10.1）。**強烈不建議**。

**推薦：(a) 新增 `DepreciationApplication` 子表。**

---

### D2 — 申請年度之欄位與 `Application.primaryDate` 推導（**使用者可見行為：列表排序與期間篩選**）

**為什麼要決定**：`Application.primaryDate` 為 `@db.Date` **NOT NULL**，是列表排序與期間篩選之權威。折舊只有「年度」而無單一日期，必須指定映射；此映射直接改變使用者在列表上看到的順序與篩選結果。

| 選項 | 內容 |
|---|---|
| **(a) `applicationYear Int?`；`primaryDate` ＝ 該年 12-31（年度為 null 時 ＝ 建立日）** | 年度申請排在該年之後 |
| (b) `primaryDate` ＝ 該年 01-01 | 排在該年之前 |
| (c) `primaryDate` ＝ 建立日（不隨年度變） | 與年度脫鉤 |
| (d) 以 `DateTime @db.Date` 存年度起日、不另存 `applicationYear` | 少一欄 |

**各選項影響**
- **(a)**：語意上「年度折舊」是該年度結束後才申報的補貼，排在該年末最符合直覺；「篩選最近一年」時當年度之折舊申請會落在區間內。列表標題另以 `applicationYear` 呈現（「年度折舊 2025」）。
- **(b)**：與 (a) 對稱，但使用者於 2025 年底建立 2025 年度申請時，該筆會出現在「最近三個月」之外（`primaryDate=2025-01-01`），造成「剛建的申請找不到」之可用性問題。
- **(c)**：違反 CLAUDE.md／US 共通規則「不依資料建立日歸屬」之精神（雖該規則字面針對差旅），且同年度重複申請之排序與年度無關，難以閱讀。
- **(d)**：年度需由日期反推，`applicationYear` 之驗證與 `duplicateYearNotice` 查詢都得改用日期區間比對，複雜度升高且無收益。

**推薦：(a)**——`applicationYear Int?` ＋ `primaryDate` ＝ 該年 `12-31`（`null` 時 ＝ 建立日）。

---

### D3 — 年度值域與快照精度組（**金額語意上游 ＋ 使用者可見行為**）

**為什麼要決定**：`applicationYear` 之值域決定哪些輸入是 400（使用者可見）；快照精度直接決定可儲存範圍與是否需要守門。**§8.3 已實查出一處人為容量缺口**（若照差旅 `Decimal(10,4)` 抄單價欄）。

| 選項 | 內容 |
|---|---|
| **(a) 年度 `Int` ∈ [1900, 2999]；快照精度依 §8.3 表（單價 `Decimal(14,4)`）** | 值域寬鬆但可防明顯誤輸入；單價欄能容納引擎全部合法輸出 |
| (b) 年度 ∈ [2000, 當年+1]（動態上界） | 更緊 |
| (c) 年度不限（僅擋非整數與 int4） | 最寬鬆 |
| (d) 單價快照沿差旅 `Decimal(10,4)` | 與差旅一致 |

**各選項影響**
- **(a)**：`[1900, 2999]` 與 PHASE-005 B-17「極大區間 1900–2999 合法」之既有裁定一致；`Decimal(14,4)` 使單價欄不再是守門點，守門集中於 `rawAmount`／`totalAmount` 兩處，測試面較小且語意單一。
- **(b)**：動態上界使「今天」進入純函式（違反 PHASE-005 `mileage-range.ts`「不知道今天」之既有設計紀律）；且跨年時既有草稿可能突然變成非法輸入。
- **(c)**：`applicationYear = 1` 之申請會產生 `primaryDate = 0001-12-31`，列表排序與前端日期格式化易生邊緣問題，且無業務意義。
- **(d)**：`perKmUnitPrice` 上界約 `1e10` > `Decimal(10,4)` 之 `1e6` → 合法參數組合（車價 1e7、年限 1、年里程 1）即撞容量，必須以 `AMOUNT_OUT_OF_RANGE` 擋下**本可正常計算**的情形——**人為缺口，不建議**。

**推薦：(a)。**

---

### D4 — 同年度重複申請之處置形狀（**使用者可見行為**）

**為什麼要決定**：**US 已明文裁定「允許」**（FE-US-17 第 4 條、FE-US-20 第 2 條、BE-US-17 第 3 條），故「是否允許」**不是**本決策點；待裁定者為「提示所需資訊」之形狀與揭露面——此為公開 API contract 與可見行為。

| 選項 | 內容 |
|---|---|
| **(a) 不設 DB 約束；DTO 回 `duplicateYearNotice { count, hasCompleted }`（排除自身、排除未來之 VOIDED）** | 後端提供最小必要資訊 |
| (b) 回完整清單（含各筆 id／狀態／金額） | 資訊更多 |
| (c) 僅前端自行查列表判斷 | 後端不回 |
| (d) 設 DB `@@unique([ownerId, applicationYear])` | **違反 US，僅列出以供對照** |

**各選項影響**
- **(a)**：滿足 BE-US-17「提供重複申請提示所需資訊」之字面要求；揭露面最小（僅自己的資料，且只有筆數與布林）；DTO 穩定。
- **(b)**：對本人而言不越權，但使 DTO 隨資料量成長、且提示 UI 不需要這些資訊；`amount` 出現在提示中會與主金額混淆。
- **(c)**：前端需額外一次列表查詢並自行推導「同年度」語意 → 與「後端為權威、前端零推導」之既有紀律相悖，且分頁下易漏算。
- **(d)**：**直接違反 US 定稿**，僅供對照，不得採用。

**推薦：(a)。** 附註：年度里程為 0 時仍允許完成（US 未要求阻擋，§1.2 已列 Out of Scope；新增阻擋屬擴大 Scope）。

---

### D5 — 缺折舊參數之錯誤合約形狀（**公開 API contract**）

**為什麼要決定**：BE-US-16 第 2 條要求「該年度 1/1 沒有有效折舊參數／使用者嘗試完成／系統應拒絕」，但拒絕形狀（狀態碼與 body）為公開 contract。既有兩種前例：差旅為 **409 `PARAMETER_NOT_AVAILABLE` ＋ `details.missing`**；保養為 **400 ＋ `details.blockers[]`**。

| 選項 | 內容 |
|---|---|
| **(a) 完成端點 409 `PARAMETER_NOT_AVAILABLE` ＋ `details.missing=["DEPRECIATION"]` ＋ `details.applicationYear`；草稿／預覽以既有 blocker code `PARAMETER_NOT_AVAILABLE` 同步暴露** | 沿差旅前例（同為「系統參數未設定」） |
| (b) 一律 400 ＋ `details.blockers[]` | 沿保養前例 |
| (c) 完成 409、草稿／預覽不暴露 | **禁止**（預覽說可以、完成才擋之反模式） |

**各選項影響**
- **(a)**：與差旅語意一致——「參數缺失」是**管理員該處理的系統狀態**，非使用者填錯欄位，409 比 400 更貼切；且 `PARAMETER_NOT_AVAILABLE` 既存在於 `ErrorCode` 也存在於差旅 blocker 清單，前端可複用既有處理分支（含「聯絡管理員」文案）。
- **(b)**：保養之全部 blocker 都是使用者可自行修正的欄位問題，故 400 合理；折舊之缺參數使用者**無法自行修正**，用 400 會誤導。
- **(c)**：005a SF-2／006 D10(a) 已明文禁止之反模式。

**推薦：(a)。**

---

### D6 — 每公里單價之精度來源（**金額核心，必人類批准**）

**為什麼要決定**：最終補貼金額直接取決於單價精度。ARCHITECTURE §4.1（PHASE-003a D3 已批准）已明文「PHASE-007 套用時必須以 003a 回傳之 4 位小數 `perKmUnitPrice` 為準」，本決策點為**追認並固化為 AC**，同時排除兩個看似合理的替代路徑。

| 選項 | 內容 |
|---|---|
| **(a) 使用 `deriveDepreciation` 回傳之 4 位小數 `perKmUnitPrice`** | 與參數頁顯示值、與 ARCHITECTURE §4.1 完全一致 |
| (b) 於本 Phase 以全精度 `車價 ÷ 年限 ÷ 年里程` 重算（round-late 至最終金額） | 理論誤差更小 |
| (c) 將單價先取整為整數（比照差旅之油資單價） | 與差旅對稱 |

**各選項影響**
- **(a)**：使用者於管理員參數頁與折舊預覽看到的單價**是同一個數**，對帳可行（`年度里程 × 顯示單價` 即為 `rawAmount`）；ARCHITECTURE 已明文「兩處單價精度必須一致，避免最終補貼金額對不上」。誤差上界：`年度里程 × 0.00005`（年度里程 2 萬公里時約 1 元），可接受且**方向不定**（非系統性偏低）。
- **(b)**：金額最精確，但**使用者拿顯示單價自行核算會得到不同答案**（差異可達數元），且與 ARCHITECTURE 已批准之定案衝突——若採此案須同時修訂 ARCHITECTURE §4.1，屬既有批准之推翻。
- **(c)**：單價量級常在 `0.x` ～ `x.x` 元／km（例：車價 60 萬／年限 5／年里程 2 萬 ＝ `6.0000`；車價 30 萬／年限 6／年里程 3 萬 ＝ `1.6667`），取整為整數會造成**嚴重失真**（`1.6667 → 2`，偏差 20%）——PHASE-003a D3 已明文「不得在此先取整為整數（否則嚴重失真）」。**禁止**。

**推薦：(a)。** 並將「本 Phase 取整恰一處（最終金額）」列為 AC-20 之硬性 kill case 義務。

---

### D7 — 快照欄位集合（**資料保存 ＋ 不可逆**）

**為什麼要決定**：BE-US-18 第 3 條逐項要求保存六值；但「另存 `rawAmount`／`calculatedAt`／版本 id」以及「是否改以 join 參數表取代存值」屬本 Spec 之設計選擇，一經完成即不可變。

| 選項 | 內容 |
|---|---|
| **(a) 存 8 欄**：三推導輸入值 ＋ 單價 ＋ 年度里程 ＋ `rawAmount` ＋ `calculatedAt` ＋ 版本 id | 值與引用皆保存 |
| (b) 僅存版本 id，三輸入值與單價由 join 參數表取得 | 少 4 欄 |
| (c) 存值但不存版本 id | 少 1 欄 |

**各選項影響**
- **(a)**：完全滿足 BE-US-18 字面；`rawAmount` 供 PHASE-008 對帳與 D6 誤差說明（B-12）；版本 id 供 `parameterHasReferences`（D12）與稽核追溯；與差旅／保養快照慣例一致（兩者皆存值 ＋ 版本 id ＋ `rawAmount` ＋ `calculatedAt`）。
- **(b)**：**違反 BE-US-18「應保存車價、折舊年限、預估年度行駛公里數」之字面要求**；且參數表雖為 append-only，未來若引入修改端點即失去不變性保證。
- **(c)**：`parameterHasReferences("DEPRECIATION")` 無從實作（D12 落空），且 PHASE-003a 對 PHASE-007 之承諾無法兌現。

**推薦：(a)。**

---

### D8 — 內部推導過程之揭露面（**使用者可見行為 ＋ 敏感資料**）

**為什麼要決定**：FE-US-18 第 3 條明文「系統可以顯示每公里單價，但**不得顯示完整內部推導過程**」。何謂「推導過程」須定義為可測試的 API 契約。

| 選項 | 內容 |
|---|---|
| **(a) 任何折舊申請 DTO（草稿／預覽／快照）皆不回傳 `vehiclePrice`／`usefulLifeYears`／`estimatedAnnualKm`／版本 id；僅回 `perKmUnitPrice`／`officialKm`／`rawAmount`／`amount`** | 全身分一致 |
| (b) 一般使用者不回、管理員回 | 兩套 DTO |
| (c) 全部回傳（僅前端不顯示） | 單套 DTO，靠 UI 遮蔽 |

**各選項影響**
- **(a)**：契約單一、可機械測試（DTO 鍵集封閉斷言）；與 `GET /parameters/depreciation` 之管理員限定（既有行為）一致，構成**真實隔離**而非 UI 遮蔽；管理員需要三值時走既有參數頁。
- **(b)**：兩套 DTO 形狀 → 前端型別分歧、測試面加倍；且管理員代操作時 DTO 形狀隨身分改變，易生快取／序列化錯誤。
- **(c)**：違反「不得以前端不顯示為安全前提」之既有紀律（PHASE-004 D6 修訂之同精神）；一般使用者可由 API 直接取得推導過程，與 US 字面牴觸。

**推薦：(a)。** 附註：`rawAmount`（取整前金額）**不屬**「推導過程」——它是金額本身之中間值，且 006 已將 `snapshotRawAmount` 納入 DTO 之既有先例；保留以供 B-12 之對帳說明。

---

### D9 — 完成之授權：是否允許管理員代完成（**授權，必人類批准**）

**為什麼要決定**：AD-US-07/08 只授權管理員「建立與修改**草稿**」，未授權代完成；完成為不可逆動作。PHASE-006 D7(a) 已就保養裁定「僅本人可完成」。

| 選項 | 內容 |
|---|---|
| **(a) 僅擁有人本人可完成（管理員 403）** | 沿 006 D7(a) |
| (b) 管理員亦可代完成（寫稽核） | 擴大授權面 |

**各選項影響**
- **(a)**：與已落地之差旅／保養完成授權完全一致；不新增稽核 action；不擴大不可逆動作之授權面。
- **(b)**：US 無明文授權，屬**擴大 Scope 與授權面**；需新增稽核 action 與整組負向測試；與已落地之兩型不一致，前端亦須分歧處理。

**推薦：(a)。**

---

### D10 — 折舊附件之容器語意與完成鎖定（**附件權限，必人類批准**）

**為什麼要決定**：`AttachmentRefType.DEPRECIATION` 早在 PHASE-003 即宣告，但 `deriveContainerState` 對該分支**一律回 `'draft'`**（`lifecycle-service.ts:256`，註記「子表尚不存在，PHASE-007，防禦性」）。建表後若不修補，折舊完成後其證明仍可被刪除／替換——**直接違反 BE-US-25 第 4 條與 NFR-US-10**。此外 `deleteApplication` 目前只 detach `TRIP_SEGMENT` 與 `MAINTENANCE`。

| 選項 | 內容 |
|---|---|
| **(a) 擴充 `deriveContainerState` ＋ 補 `deleteApplication` detach**；`refId` ＝ `Application.id`（＝ `DepreciationApplication.applicationId`）；關聯途徑僅 `PUT /applications/depreciation/:id` 之 `attachmentIds[]` | 修補既有缺口，與 006 D2(a) 完全同型 |
| (b) 於 `Attachment` 加真實 FK 至 `DepreciationApplication` | 改弱關聯為強關聯 |
| (c) 冗餘持久化 `locked` 旗標 | 不再推導 |

**各選項影響**
- **(a)**：與 PHASE-003 D1/D2 及 PHASE-006 D2(a) 之既有定案一致；改動集中；`refId` 直接是 `Application.id`，一次 `findUnique` 即可。
- **(b)**：`refType` 之設計目的即為避免對多型容器建 FK；需重寫 PHASE-003/006 既有測試與索引。
- **(c)**：ARCHITECTURE §4.5 明文「附件不冗餘持久化 locked」——推翻既有定案並引入不同步故障模式。

**推薦：(a)。** 並將「AC-25 修復前紅燈」與「B-25 孤兒補洞修復前紅燈」列為 T8 之 Done When 硬性項。

---

### D11 — 金額容量守門之呈現形狀（**錯誤合約 ＋ 金額正確性**）

**為什麼要決定**：§8.3 之容量缺口 #2 使「合法輸入導致超出欄位容量」成為可達狀態；呈現形狀為公開 contract。

| 選項 | 內容 |
|---|---|
| **(a) `AMOUNT_OUT_OF_RANGE` blocker（400 ＋ `details.blockers[]`），草稿／預覽同步暴露** | 沿 006 D10(a) |
| (b) 409 `PARAMETER_NOT_AVAILABLE` ＋ `details.missing` 追加代碼 | 沿 005a D4(a) |
| (c) 收緊 `DepreciationParameterVersion.vehiclePrice` 精度 | 從源頭消除 |

**各選項影響**
- **(a)**：與 006 已落地之保養完全同型，前端可複用既有 blocker 呈現分支；`calculable=false` 與 blocker 一致；草稿即可見，不會「完成才擋」。
- **(b)**：語意上不精確（參數本身有效，是**組合**超出容量），且會與 D5(a) 之缺參數 409 混用同一碼、`details.missing` 需再追加代碼，前端分辨成本高。
- **(c)**：需 `ALTER` PHASE-003a 已批准之既有表並可能影響既有列，屬**不可逆 migration 之推翻**，不建議。

**推薦：(a)。**

---

### D12 — `parameterHasReferences` 是否擴充至 `"DEPRECIATION"`（**內部 API contract；PHASE-003a 對本 Phase 之既有承諾**）

**為什麼要決定**：PHASE-003a Spec §4.7／DATA_FLOW §2.7 明文「真實引用判斷與『歷史金額不變』回歸於 PHASE-004/007（以申請完成快照為權威）」；PHASE-004 已完成差旅端（`"FUEL"`／`"FUEL_PRICE"`／`"FUEL_CONSUMPTION"`／`"ETC"`），折舊端尚缺。

| 選項 | 內容 |
|---|---|
| **(a) `ParameterType` 加 `"DEPRECIATION"`，查 `DepreciationApplication.depreciationParameterVersionId` ＋ `Application.status="COMPLETED"`** | 兌現 003a 承諾 |
| (b) 不動，留 PHASE-010/011 | 縮小本 Phase 範圍 |

**各選項影響**
- **(a)**：與 PHASE-004 之實作完全同型（新增一個三元分支 ＋ 一次 `count`）；邊際成本極小（約 10 行 ＋ 2 條測試）；BE-US-19「已有歷史申請引用之版本不得覆寫」在折舊端獲得真實回歸；PHASE-011 之清理與 PHASE-010 之稽核可直接使用。
- **(b)**：PHASE-003a 對 PHASE-007 之承諾落空，需在 PROJECT_STATE 再記一筆跨 Phase 債；且 AC-33 之引用保護回歸無實作可測。

**推薦：(a)。**

---

### D13 — 預覽端點與完成路徑（**公開 API contract ＋ 授權面**）

**為什麼要決定**：預覽是否為獨立端點、完成走既有 generic 路徑或新路徑，皆為公開 contract 且涉及授權判定入口。

| 選項 | 內容 |
|---|---|
| **(a) `POST /applications/depreciation/preview`（stateless，`ownerId?`）＋ 草稿／讀取 DTO 內嵌 `computed` ＋ 完成沿既有 `POST /applications/:id/complete` 型別分派** | 與 006 D6(a) 完全同型 |
| (b) 只內嵌 `computed`，不提供獨立預覽端點 | 少一端點 |
| (c) 完成另開 `/applications/depreciation/:id/complete` | 第三套完成路徑 |

**各選項影響**
- **(a)**：使用者尚未建草稿即可看到某年度之補貼估算（FE-US-17 第 2 條「選擇年度→系統載入資料→顯示該年度公務總里程」正是此情境）；管理員可指定 `ownerId` 預覽（沿 005a D6(a)／006 D6(a)）；完成路徑前端與 E2E 只有一套。
- **(b)**：必須先建草稿才能看到任何數字，與 FE-US-17 第 2 條之流程不符；且每次改年度都要寫一次 DB（預覽零寫入不變式消失）。
- **(c)**：前端與 E2E 出現第三套完成路徑，測試與維護成本上升，無收益。

**推薦：(a)。**

---

### D14 — `count`／`SUM` 不對稱之折舊處置（**金額正確性**）

**為什麼要決定**：ARCHITECTURE §4.10 末條之 D2(a) 不對稱（已完成差旅之快照為 `null` 時，`applicationCount` 計入而 `totalKm` 忽略）於折舊同型適用，須明文裁定折舊端之處置。

| 選項 | 內容 |
|---|---|
| **(a) 沿 006 之處置：引擎不改；金額只用 `totalKm`；`applicationCount` 僅供顯示；DTO 如實回兩值** | 偏差方向保守（補貼偏低） |
| (b) 於折舊端加執行期守門（`applicationCount > 0 且 totalKm = 0` 時拒絕完成） | 主動攔截資料異常 |
| (c) 修改引擎令 `count` 與 `SUM` 對稱 | 從源頭消除 |

**各選項影響**
- **(a)**：與 006 已落地之保養完全一致；偏差方向為**保守**（分子偏低 → 補貼偏低，不會溢付）；以不變式測試（「已完成 ⇒ 快照非 null」）守護，不加執行期守門（沿 006 D8(a) 之人類裁定）。
- **(b)**：會把**合法的「該年度確實 0 公里」**與資料異常混為一談（B-09 已裁定 0 公里可完成），造成誤殺。
- **(c)**：修改 `mileage-engine.ts` 會影響差旅統計端點與保養分攤之既有行為與快照，屬跨 Phase 迴歸風險，且 §1.2 已列 Out of Scope。

**推薦：(a)。**

---

## 17. 已知限制與跨 Phase 銜接

### 17.1 已知限制與**現況缺口**（本 Phase 內必須處置者以 ★ 標示）

1. **★ `deriveContainerState` 之 `DEPRECIATION` 分支恆回 `'draft'`**（`backend/src/attachment/lifecycle-service.ts:256`）——PHASE-003 之防禦性佔位，於本 Phase 建立子表後即成**真實安全缺口**（折舊完成後附件仍可刪除）。由 T8／AC-25 修補，須有修復前紅燈實證。**006 曾在同一位置實查出同型漏洞，本 Phase 不得假設「註解說防禦性就沒問題」。**
2. **★ `deleteApplication` 未 detach `DEPRECIATION` 附件**（`backend/src/applications/travel-service.ts`，現況只處理 `TRIP_SEGMENT` 與 `MAINTENANCE`）——刪除折舊草稿會留下孤兒 `LINKED` 附件（永不被 TTL 清理）。由 T4／T8／B-25 修補。
3. **★ `infra001-isolation-self-check.test.ts` 之業務表總數為寫死之 `14`**（實查至少兩處：`:76`、`:156`）——新增一張表即需機械連動為 `15`。已列 T1 Done When；**動態計數之改造仍為 PHASE-011 加固候選**（005a T1／006 T1 已各登記一次同一條目，本 Phase 為第三次撞上）。
4. **關鍵字查詢不涵蓋折舊列**（AC-37）：`buildApplicationWhere` 之 `keyword` 僅比對 `TravelApplication.purpose`；折舊無可搜尋文字欄位。**PHASE-008 引入報表編號後**應擴充為「purpose ∨ 報表編號」——與 006 §17.1 #4 為**同一條**跨 Phase 債，PHASE-008 一次處理。
5. **`applicationCount` 與 `totalKm` 之不對稱**（D14）：極端資料異常下會出現「筆數 ≥1 但里程 `0.00`」之外觀，偏差方向保守。
6. **`rawAmount` 4 位小數與 `totalAmount` 之窗口矛盾**（B-12）：`[x.49995, x.5)` 區間內快照顯示 `x.5000` 而金額為 `x`——正確結果，**須於 Gate 報告向人類揭露**；PHASE-008 對帳說明必以三來源值重算（與 006 AR-5 為同型義務）。
7. **單價精度誤差**（D6(a) 之接受成本）：使用 4 位小數單價而非全精度，`年度里程 × 0.00005` 之誤差上界（2 萬公里約 1 元）為刻意接受之對帳友善代價。
8. **年度里程 0 仍可完成**（B-09）：US 未要求阻擋；補貼 0 元之申請可完成並產生快照。
9. **`VOIDED` 於本 Phase 仍不可達**：折舊之作廢屬 PHASE-009；`duplicateYearNotice` 之狀態過濾已預留（未來 `VOIDED` 天然排除）。
10. **相鄰年度之邊界無交叉檢核**：同一筆差旅只會落在唯一年度（`tripDate` 唯一），故不存在 006 D12 之「同一日差旅被兩筆同時計入」問題；但**同年度多筆折舊申請會各自計入同一批差旅**（US 明文允許重複，見 D4）。
11. **完成失敗對話框不分缺項**（PHASE-004 既有行為，005a 終審 AR-6 已記錄）：折舊頁沿用同一模式，不在本 Phase 改善。

### 17.2 與 PHASE-008／009／010／011 之銜接

- **PHASE-008（報表）**：折舊報表編號前綴 `DEP`；列印版須呈現年度／年度公務里程／每公里單價／補貼金額＋證明圖片；**三推導值（車價／年限／年里程）是否呈現於報表須另行裁定**（D8 只約束申請 DTO，報表為不同揭露場景）——**PHASE-008 開工 Packet 必引本條**；`rawAmount` 對帳說明見 §17.1 #6；keyword 擴充見 §17.1 #4。
- **PHASE-009（作廢／修正版）**：折舊之 `COMPLETED → VOIDED` 轉換須擴充 `ALLOWED_TRANSITIONS`；作廢之折舊**本身**不進入任何統計；作廢之**差旅**會改變後續折舊之年度里程——**已完成折舊之快照仍不得改變**（AC-31），此為刻意設計。修正版須複製 `applicationYear` 並重新計算。
- **PHASE-010（稽核檢視）**：代操作折舊之 `AuditLog` 以 `summary.type="DEPRECIATION"` 區分。
- **PHASE-011（清理／效能）**：`HasReferenceQuery` 之實作須納入 `DepreciationApplication` 之附件引用；索引評估納入 `DepreciationApplication.applicationYear`；**infra 表數動態化（第三次登記）**；`isRetryableTransactionConflict`／掃描 helper 之多份拷貝抽共用（005a AR-1／006 AR-1，本 Phase 將產生第三／第四份）。

---

## 18. Spec 修訂紀錄

| 日期 | 變更 | 依據 |
|---|---|---|
| 2026-08-04 | `DRAFT` 建立：依 Task Context Packet `PHASE-007-SPEC` 產出完整 Phase Spec（§1~§19：46 條 AC 全溯源、正常流程、五態、35 項邊界、40 格授權矩陣、API contract、資料模型與 migration、Data Flow、NFR、測試策略、AC↔測試映射表 46 列、Rollback、16 Task 之 Task Graph（含 T6/T9 規模例外之處置建議）、決策點 D1~D14、Architecture/Data Flow 同步項 11 條、PRD 建議修正清單） | `userstory.md` FE-US-04/05/17/18/19/20/21/27、AD-US-06/07/08/13、BE-US-03/14/15/16/17/18/19/20/22/24/25/30、NFR-US-10/16；`docs/PRD.md` §PHASE-007（427–449 行）與 §4 US 索引表、§6 總覽；`docs/ARCHITECTURE.md` §3/§4.1/4.2/4.3/4.4/4.5/4.6/4.10/4.11；`docs/DATA_FLOW.md` §1.1/§1.2/§2.2/§2.3/§2.7/§2.8；PHASE-003 Spec（附件 D1/D2/D8）、PHASE-003a Spec（D2/D3/D7/§4.7/§14）、PHASE-004 Spec（狀態機／快照／代操作／D6 修訂）、PHASE-005 Spec §16 D2(a)/D5(a)/D8(a)/D9(a) 與 §5 補測清單、PHASE-005a Spec §16 D4(a)/D6(a)、PHASE-006 Spec 全文（D1/D2/D4/D6/D7/D10/D11 與 §9.3/§11.6/§17）；`PROJECT_STATE.md` PHASE-007 開工記錄與 PHASE-005/005a/006 結案移交；`docs/retrospective/PHASE-006-usage.md` §3.1 預算帶；程式現況實查（`schema.prisma`、`depreciation-engine.ts`、`parameter-service.ts`、`parameter-version-engine.ts`、`reference-guard.ts`、`mileage-engine.ts`、`maintenance-calculation.ts`、`applications/routes.ts`、`admin/routes.ts`、`application-query.ts`、`attachment/lifecycle-service.ts`、`travel-service.ts`、`travel-parameters.ts`、`completion-blockers.ts`、`platform/errors.ts`、`users/history.ts`、`infra001-isolation-self-check.test.ts`、`phase6-official-mileage.test.ts`、`frontend/src/App.tsx`） |

| 2026-08-04 | **Spec Gate 通過，`DRAFT` → `ACTIVE`**（大總管固化）。裁定內容：①**D1~D14 全數採選項 (a)**（照推薦批准）——D1 子表、D2 `applicationYear Int?`＋`primaryDate`=該年 12-31、D3 年度 [1900,2999]＋單價快照 `Decimal(14,4)`、D4 `duplicateYearNotice{count,hasCompleted}`、D5 完成 409 `PARAMETER_NOT_AVAILABLE`＋草稿/預覽 blocker 同步暴露、D6 用 003a 之 4dp `perKmUnitPrice`（誤差上界 年度里程×0.00005 已向人類量化揭露）、D7 快照 8 欄、D8 全身分不回三推導值與版本 id、D9 僅本人可完成、D10 擴 `deriveContainerState`＋補 detach、D11 `AMOUNT_OUT_OF_RANGE` blocker、D12 擴 `"DEPRECIATION"`、D13 stateless preview＋generic complete 分派、D14 沿 006 金額只用 `totalKm`。②**T6/T9 規模例外採處置 (i)**：切出 T6b/T9b，總數 18 Task。③**High Task 事前批准 12 項**：T1、T2、T3、T4、T6、T6b、T7、T8、T9、T9b、T10、T11。④B-12 外觀矛盾（rawAmount `x.5000` vs 金額 `x`）之整合 Gate 揭露義務已告知。 | 人類 leonchih 2026-08-04「批准開工」（大總管 Gate 呈報全文含 D1~D14 推薦、T6b/T9b 拆分建議、12 項 High 清單；本次批准即對該呈報包全案照案） |

> Gate 固化義務已履行（上列 2026-08-04 第二列）。

---

## 19. PRD 建議修正清單（**本 Task 未編輯 `docs/PRD.md`**）

> **未編輯之理由**：下列修正的正確內容**取決於 §16 之 Gate 裁定結果**（Task 拆分與 High 清單），於 Gate 前寫入 PRD 等同把未經批准之決策固化進事實來源第 3 層。且 PRD 不在大總管白名單內，落地須另行派工。**建議於 Spec Gate 通過、Spec 轉 `ACTIVE` 後，以一個 `PHASE-007-PRD-SYNC` Lite Packet 一次落地。**

| # | 位置 | 現況（逐字） | 建議修正（逐字） | 理由 |
|---|---|---|---|---|
| 1 | `docs/PRD.md:431`（§PHASE-007「對應 US」） | `**對應 US**：FE-US-17, 18, 19, 20；BE-US-14（套用）, 15, 16, 17；BE-US-18（折舊快照）, 24（折舊上限 5）, 25（折舊完成鎖定）；NFR-US-10（折舊附件）。` | 於句末追加：`次要關聯：FE-US-04／05（列表與篩選之類型擴充）、FE-US-21（草稿附件管理）、FE-US-27（響應式）、AD-US-06／07／08 與 BE-US-03（代操作延伸）、AD-US-13（折舊參數引用）、BE-US-19（參數版本引用保護之真實回歸）、BE-US-20（草稿）、BE-US-30（公務總里程之複用）。` | PRD §4 US 索引表**已**將這些 US 之次要 Phase 標為 PHASE-007（FE-US-04＝63 行、FE-US-05＝64 行、FE-US-21＝80 行、AD-US-06/07/08＝98–100 行、AD-US-13＝105 行、BE-US-03＝115 行、BE-US-20＝132 行、BE-US-30＝142 行、NFR-US-10＝159 行），但 §PHASE-007 段落之「對應 US」未列出——**同一份 PRD 內部不一致**（與 PHASE-006 §19 #1 同型）。 |
| 2 | `docs/PRD.md:437-446`（§PHASE-007「初始 Task Graph 概要」） | `T1…T8` 八列 | 於清單前追加一行：`（以下為概要；正式拆分依 Phase Spec §15 之 Task 清單，對照表見該節。）` | 本 Spec 依 Packet 規模上限（≤5 AC、≤6 檔、不跨三層）將 8 項概要細化為 16（或 18）個 Task，並補齊 PRD 概要未涵蓋之代操作／列表／錯誤合約三項（其 US 已於 §4 索引表歸屬本 Phase）。 |
| 3 | `docs/PRD.md:447`（§PHASE-007「High 風險 Task」）與 `docs/PRD.md:551`（§6 總覽之 PHASE-007 列） | `**High 風險 Task**：T4, T5, T6, T7。` ／ `\| PHASE-007 \| 折舊參數套用、補貼計算、折舊附件、完成鎖定/快照 \|` | 分別改為：`**High 風險 Task**：見 Phase Spec §15（共 10 項）。` ／ `\| PHASE-007 \| 折舊參數套用、補貼計算、折舊附件、完成鎖定/快照、不可逆 migration、授權與代操作、年度公務里程接線 \|` | 本 Spec 依 CLAUDE.md「認證、授權…一律 High」與 PHASE-005/005a/006 之既有升級先例，另將 migration／授權／代操作／金額上游升為 High（**保守方向，不縮減任何既有判定**）。 |
| 4 | `docs/PRD.md:429`（§PHASE-007「目標」） | `…同年度重複申請提醒但允許、完成保存快照、歷史不隨參數變動。` | 維持不變；**僅建議於「Out of Scope」列追加**：`稽核檢視頁（PHASE-010）；「一人一年一筆」之唯一性約束（US 明文允許重複）；年度里程為 0 時之阻擋（US 未要求）。` | 消除實作者對「是否該加唯一約束／0 里程阻擋」之歧義——本 Spec §1.2 已明列，PRD 同步後可避免下游 Phase 重複討論。 |

> 上列修正**皆不改變任何 User Story 原意、不縮減任何 AC、不擴大 Scope**，僅消除 PRD 內部不一致與 Spec 細化後之對齊。
