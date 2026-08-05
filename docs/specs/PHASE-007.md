# PHASE-007 — 年度折舊補貼

| 項目 | 內容 |
|---|---|
| **Spec 狀態** | `ACTIVE`（**Spec Gate 通過**：人類 leonchih 2026-08-04 裁定「批准開工」——D1~D14 全數照推薦批准、T6/T9 採 T6b/T9b 拆分（總數 18 Task）、High Task 事前批准 12 項（T1~T4、T6、T6b、T7~T9、T9b、T10、T11）。固化紀錄見 §18）<br>**＋ 折舊模型修訂段進行中**（人類 leonchih 2026-08-05「照提案全部確認」）——**修訂內容一律見 §20，§20 於衝突處覆蓋 §1~§17** |
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

> ## ⚠ 閱讀優先序（折舊模型修訂段，2026-08-05 起）
>
> 本 Phase 之折舊模型已於**開發段完成後**經人類裁定修訂（補貼公式由「年度公務里程 × 每公里單價」改為「每年折舊費用 × 公務比例」；折舊證明由必要改選填）。修訂內容**集中於 §20**。
>
> - **§1~§17 為開發段（2026-08-04 Gate）之定稿內容，保留為歷史記錄，不改寫**；凡受修訂影響之節，其標題／段落已加註 **【已修訂 → §20.x】**。
> - **衝突處一律以 §20 為準。** 未加註之節即為未受影響、仍然有效。
> - **§12 AC↔測試映射表**保留開發段之 `GREEN` 實名記錄（歷史證據），修訂段之狀態以緊隨其後之 **§12R 修訂段狀態覆寫表**為準。
> - **§15 Task Graph（T1~T16／T6b／T9b）為開發段已完成之工作記錄**；修訂段之派工依 **§20.12 修訂段 Task Graph（R1~R13）**。
> - **§16 D1~D14 為開發段已裁定之決策點**，其中 **D6／D7／D8（部分）／D10（部分）** 已被修訂取代，取代關係見 §20.13。

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

### E. 折舊參數套用與每公里單價　**【AC-17／AC-18 已修訂 → §20.2、§20.3】**

> 來源：BE-US-16 全四條；BE-US-14；AD-US-13 第 5 條；ARCHITECTURE §4.1 折舊段與 §4.2；PHASE-003a D2/D3/D7。

- **AC-15** 依**申請年度 1 月 1 日**選版：`findEffectiveVersion(全部折舊版本, YYYY-01-01)`（**該類全部版本 `findMany` 後以純函式選版**，**不得**在 DB 層以 `effectiveFrom: { lte }` 先過濾——沿 DATA_FLOW §2.2 PHASE-005a 明文紀律）。測試須含：① 生效日恰為 `YYYY-01-01` 之版本被選中（含當日）② 生效日為 `YYYY-01-02`／該年中途之新版本**不被選中**（BE-US-16 第 3 條）③ 生效日為前一年之版本被選中（最近一版）④ 全部版本皆晚於 `YYYY-01-01` → 查無有效版本。
- **AC-16** 缺參數之處置（§16 **D5**）：該年 1/1 查無有效版本時——
  - **(a)** **完成端點**拒絕：**409 `PARAMETER_NOT_AVAILABLE`**（**沿用既有 `ErrorCode`，不新增**）＋ `details.missing = ["DEPRECIATION"]` ＋ `details.applicationYear`；訊息提示聯絡管理員設定參數（FE-US-18 第 4 條）。
  - **(b)** **草稿與預覽同步暴露**：`completionBlockers` 含 `PARAMETER_NOT_AVAILABLE`（**沿用既有 blocker code**）且 `computed.calculable=false`——**禁止「預覽說可以、完成才擋」之反模式**（005a SF-2／006 D10(a) 同型高危復發點，須有整合測試）。
  - **(c)** 完成失敗時**零寫入**：`Application.status` 仍為 `DRAFT`、全部快照欄仍為 `null`。
- **AC-17** 單價來源（**不重寫推導**）：一律呼叫既有 `deriveDepreciation({ vehiclePrice, usefulLifeYears, estimatedAnnualKm })`（`backend/src/parameters/depreciation-engine.ts`）並取其 **4 位小數字串** `perKmUnitPrice`；以 import 接線斷言 ＋ 活體突變自證（刪 import 改私有複製必紅）證明；`depreciation-engine.ts` **全 Phase 零 diff**。**kill case**：`vehiclePrice=10, usefulLifeYears=3, estimatedAnnualKm=3` → `perKmUnitPrice="1.1111"`（若改以「已取整之每年費用 3.33」為分子得 `1.1100`，必紅）。
- **AC-18** `deriveDepreciation` 回 `{ ok: false }`（任一參數 ≤0；理論不可達，因 `POST /parameters/depreciation` 已於建立時擋下）之處置：視同**缺參數**同型拒絕——**絕不 500、絕不以單價 0 完成、絕不寫入任何快照**；`details.missing` 追加 `"DEPRECIATION_DERIVATION_FAILED"`（**非新增 `ErrorCode`**，比照 005a `FUEL_DATA_CORRUPTED` 之既有作法），訊息與 AC-16(a) **逐字不同**（避免管理員誤查方向）。

### F. 補貼計算（金額核心）　**【AC-19／AC-20 已退場、AC-21／AC-22 已修訂 → §20.2、§20.4】**

> 來源：BE-US-17 第 1/2/4 條；共通規則 §4；ARCHITECTURE §4.1 折舊段與 PHASE-003a D3；PHASE-006 D4(a) 同型紀律。

- **AC-19** 公式（§7.4 逐字）：`rawAmount = 年度公務里程 × perKmUnitPrice`；`amount = ROUND_HALF_UP(rawAmount, 0)`（新臺幣整數）。**全程 `Prisma.Decimal`，禁止任何浮點中介**；`perKmUnitPrice` 以 `new Prisma.Decimal(字串)` 還原（`deriveDepreciation` 回傳固定 4 位小數字串），**不得**經 `Number()`／`parseFloat`。
- **AC-20** **取整層級**：本 Phase 之取整**恰一處**（最終金額）。單價之 4 位小數取整發生在 **PHASE-003a 引擎內**，本 Phase **不得**再對單價取整、**不得**先取整年度里程、**不得**先取整 `rawAmount` 至 2 位小數再取整。**kill case**：`officialKm = 1234.56`、`perKmUnitPrice = "0.5001"` → `rawAmount = 617.403456` → `amount = 617`（算術筆誤 617.404656 已由 T2 實測更正，見 §18）；若先將 `rawAmount` 取整至 2 位（`617.40`）再取整仍為 `617`（不具鑑別力，**不可作為 kill case**）——正式 kill case 須由 T2 以窮舉搜尋產生並於 Spec 修訂紀錄回填實際數對（Done When 硬性項：**「先取整 rawAmount 至 2 位」與「先取整 officialKm 至整數」兩種 mutant 各須至少一條測試必紅**）。
- **AC-21** 取整方向為**一般四捨五入（`ROUND_HALF_UP`，0.5 進位、away from zero），非銀行家取整**：kill pair `rawAmount=0.5 → 1` 與 `rawAmount=1.5 → 2`（`ROUND_HALF_EVEN` mutant **於前者必紅**——`HALF_EVEN(0.5)=0` 鑑別、`HALF_EVEN(1.5)=2` 不鑑別；原文「於後者必紅」為沿襲筆誤，T2 實測 M1 轉紅者為 row 1，見 §18）；`rawAmount=0.4999… → 0`、`0.5 → 1` 之最小鑑別對在場。
- **AC-22** 容量守門（§16 **D11**；§8.3 推導）：`snapshotOfficialKm`(`Decimal(12,2)`)／`snapshotPerKmUnitPrice`(`Decimal(14,4)`)／`snapshotRawAmount`(`Decimal(14,4)`)／`Application.totalAmount`(`int4`) 任一超出容量 →
  - **(a)** 純函式層之容量 predicate 回 `true`，**閾值由 schema 精度推導之具名常數**（**不得寫魔術數**，006 T1 AR-6 教訓）；
  - **(b)** 完成端點**於寫入前**以 `AMOUNT_OUT_OF_RANGE` blocker 拒絕（**4xx；絕不 500、絕不靜默截斷**），**零寫入**；
  - **(c)** 草稿與預覽 DTO **同步暴露**該 blocker 與 `computed.calculable=false`；
  - **(d)** 邊界正例在場防誤殺（恰 `1e10 − ε` 通過／恰 `1e10` 拒絕；`2147483647` 通過／`2147483648` 拒絕）。

### G. 折舊證明附件　**【AC-24 已退場（證明改選填）→ §20.2、AC-54】**

> 來源：FE-US-19 全三條；BE-US-24（上限 5）；BE-US-25（完成鎖定）；NFR-US-10；ARCHITECTURE §4.5；PHASE-006 D2(a) 同型。

- **AC-23** 上限 5：第 6 張關聯 → **409 `TOO_MANY_ATTACHMENTS`**（沿既有 `canLink`／`linkAttachmentTx`，**不重寫上限邏輯**）；於 `SERIALIZABLE` 交易內對帳，超限時**全交易回滾**（不得部分關聯）；重複 id 之上限繞過封閉。
- **AC-24** 草稿可缺、完成須 ≥1：草稿零附件可儲存（**200/201**，FE-US-17 第 5 條）；完成時 `LINKED` 附件數 < 1 → blocker `DEPRECIATION_ATTACHMENT_REQUIRED` → **400**；**附件計數必須於完成交易內、`FOR UPDATE` 鎖列後同 `tx` `count`**（**不得**沿用交易外 DTO 之快照——否則「DELETE 附件」與「完成」之 write-skew 可產生零證明的 `COMPLETED`，006 T6 FW① 逐字教訓）。
- **AC-25** **完成鎖定（現況缺口修補）**：`deriveContainerState` 之 `refType='DEPRECIATION'` 分支現況**恆回 `'draft'`**（`lifecycle-service.ts:256` 佔位註記「子表尚不存在，PHASE-007，防禦性」）——建表後即成**真實安全缺口**（已完成折舊之證明仍可被刪除／替換，違反 BE-US-25 第 4 條與 NFR-US-10）。本 Phase 擴充為經 `Application.status` 推導（`refId` ＝ `Application.id` ＝ `DepreciationApplication.applicationId`，一次 `findUnique`）：`COMPLETED → 'completed'`；否則（`DRAFT`／不存在孤兒，記 log）→ `'draft'`，**絕不 500**。**須有修復前紅燈實證**（現況「完成後刪除附件回 200」→ 修復後 403）。
- **AC-26** 授權與孤兒：他人之折舊證明 `GET /attachments/:id/content|thumbnail` → **403**（管理員 200）；跨使用者掛入、管理員代掛、`LINKED` 偷渡一律封閉；`deleteApplication` 於刪除折舊草稿時**同一交易內** detach `refType='DEPRECIATION'` 附件（B-25 補洞，**修復前紅燈實證**）。

### H. 完成流程與快照　**【AC-27 已修訂、AC-28 已退場（快照欄集合變更）→ §20.2、AC-55】**

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
| B-22 | `attachmentIds` 含重複 id | 第二次見到同一 id 時該附件已 `LINKED` → **409 `CONFLICT`**，全交易回滾、零關聯；上限繞過由此天然封閉（沿 PHASE-006 `reconcile*Attachments` 同型，本 Phase 不新增第二套去重規則。**前端須自行去重後送出**——T13/T14 義務）。（原文「去重後計數」經人類 2026-08-05 裁定 A 案修訂，見 §18） | AC-23 |
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

### 7.2 DTO 形狀（推薦）　**【已修訂 → §20.6】**

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

### 7.4 折舊補貼計算（不得重寫推導）　**【已由 §20.4 全面取代——本節公式為舊模型，僅供歷史快照對帳追溯】**

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

### 7.5 完成阻擋碼（blocker codes）與固定順序　**【已由 §20.5 全面取代】**

| 順序 | code | 觸發條件 | zh-TW 訊息（推薦） |
|---|---|---|---|
| 1 | `YEAR_REQUIRED` | `applicationYear` 為 `null` | 請選擇申請年度 |
| 2 | `DEPRECIATION_ATTACHMENT_REQUIRED` | `LINKED` 附件數 < 1 | 請至少上傳 1 張折舊證明 |
| 3 | `PARAMETER_NOT_AVAILABLE` | 該年 1/1 無有效折舊參數，或 `deriveDepreciation` 回 `ok:false` | 該年度尚無有效折舊參數，請聯絡管理員設定 |
| 4 | `AMOUNT_OUT_OF_RANGE` | 計算結果超出欄位容量 | 計算結果超出可儲存之金額範圍，請聯絡管理員檢查折舊參數 |

> **兩段式**（沿 006 §9.3）：**結構性條件（1、2）先算**；非空即拒絕、**不查詢**年度里程與參數（省一次聚合，錯誤語意單一）。全通過才執行里程與參數查詢，再算 **3、4** 並二次判定。純函式以 `officialKm?: Decimal | null`、`perKmUnitPrice?: Decimal | null` 表達「尚未查詢」而**不**產生第 3/4 項。
> **完整清單之定義**（T3 即審澄清，2026-08-04，見 §18）：`details.blockers[]` 為**本次已評估**之全部未通過項目。因兩段式紀律，第 1/2 項與第 3/4 項互斥出現（結構性未過即不評估第 3/4 項），第 3 與第 4 項亦互斥（無單價即無從計算金額）；故任一回應之 `blockers[]` 至多含兩碼（僅第 1、2 項可同時出現）。呼叫端**不得**因此自行補算被抑制之項目。
> **不變式**：`calculable=false ⇒ blockingCodes 至少一項`（006 T5R SF-2 裁定同型），以 sweep 測試守護。
> 完成端點之拒絕形狀：`YEAR_REQUIRED`／`DEPRECIATION_ATTACHMENT_REQUIRED`／`AMOUNT_OUT_OF_RANGE` → **400 `VALIDATION_ERROR`** ＋ `fields[]`（僅具欄位路徑者）＋ `details.blockers[]`（**永遠是完整清單**）；`PARAMETER_NOT_AVAILABLE` → **409**（§16 **D5**，沿差旅既有形狀）＋ `details.missing` ＋ `details.applicationYear`。

### 7.6 錯誤合約

沿用 PHASE-003a §14.2 之分層與文案表、PHASE-001 §5.2 之統一形狀。**本 Phase 不新增任何 `ErrorCode`**（AC-43）。使用之碼：`VALIDATION_ERROR`(400)、`UNAUTHORIZED`(401)、`FORBIDDEN`(403)、`PASSWORD_CHANGE_REQUIRED`(403)、`NOT_FOUND`(404)、`CONFLICT`(409)、`TOO_MANY_ATTACHMENTS`(409)、`PARAMETER_NOT_AVAILABLE`(409)、`UNSUPPORTED_MEDIA_TYPE`(415)、`PAYLOAD_TOO_LARGE`(413)、`INTERNAL_ERROR`(500)、`SERVICE_UNAVAILABLE`(503)。

---

## 8. 資料模型與 migration

### 8.1 不新增 enum

`ApplicationType.DEPRECIATION`（`schema.prisma:256`）與 `AttachmentRefType.DEPRECIATION`（`schema.prisma:165`）**早已宣告**；`ApplicationStatus`／`AuditAction`／`FuelType`／`Role`／`AttachmentStatus` 之既有值皆已足夠（AC-01(e)）。

### 8.2 新增資料表（推薦形狀，精度依 §16 D3 裁定）　**【已修訂：新增四欄、二欄轉凍結唯讀 → §20.7】**

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

### 8.3 欄位容量與精度之推導依據（§16 D3 之技術背景）　**【已修訂 → §20.7】**

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

### 8.4 migration 順序與可逆性　**【已增補：修訂段新增 ALTER 型 M2 migration → §20.7】**

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

### 9.3 完成與快照寫入　**【已修訂：步驟②之附件守門退場、新增比例守門、快照欄集合變更 → §20.8】**

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
| AC-02 | integration | `phase7-depreciation-draft.test.ts` | `AC-02: POST /applications/depreciation creates a DRAFT with all-null snapshot columns and ignores body-supplied ownerId/status/totalAmount`（describe 逐字實名，內含 DTO＋DB 逐欄斷言） | T4 | GREEN |
| AC-03 | integration | `phase7-depreciation-draft.test.ts` | `AC-03: applicationYear validation gate table — type/format/range, with fields[].field asserted`（describe 逐字實名；20 invalid×2 端點＋6 valid×2） | T4 | GREEN |
| AC-04 | integration | `phase7-depreciation-draft.test.ts` | `AC-04: PUT rejects COMPLETED at both the outer guard and inside the transaction (FOR UPDATE re-check)`（describe 逐字實名）；同交易對帳鑑別：`attachmentIds[] 混合批次（合法 id ＋ 不存在 id）→ 404，且先前已 link 之合法附件一併回滾為 TEMP（AC-04「同一交易內完成」之鑑別測試）`（T4R-LITE，M13 恰 1 紅） | T4 | GREEN |
| AC-05 | integration | `phase7-depreciation-draft.test.ts` | `AC-05: GET returns blockers+computed for DRAFT and snapshot for COMPLETED; DELETE detaches DEPRECIATION attachments in the same transaction; wrong-type id is 404`（describe 逐字實名）。computed 段已由 T7 落地並經 `phase7-depreciation-parameters.test.ts` 草稿 DTO 面覆蓋（終審核對確認實質 GREEN） | T4 ＋ T7 | GREEN |
| AC-06 | integration | `phase7-depreciation-year.test.ts` | `AC-06: primaryDate is derived from applicationYear (YYYY-12-31) and falls back to the creation date when the year is null`（describe 逐字實名；D2(a) mutant 雙側殺——12-31→01-01 4 紅、null fallback 2 紅） | T5 | GREEN |
| AC-07 | integration | `phase7-depreciation-year.test.ts` | `AC-07: duplicateYearNotice counts same-owner same-year applications excluding self, and is null when applicationYear is null`（describe 逐字實名；排除自身 mutant 7 紅、跨 owner 洩漏側 1 紅） | T5 | GREEN |
| AC-08 | integration | `phase7-depreciation-year.test.ts` | 建立面實名：`AC-08` describe（皆 201＋唯一約束等效 mutant）。完成面已落地：T9 之 AC-08 完成測試（`phase7-depreciation-complete.test.ts`，同年度兩筆皆完成 200） | T5 ＋ T9 | GREEN |
| AC-09 | integration | `phase7-annual-mileage.test.ts` | `AC-09: annual mileage goes through sumOfficialMileage — import wiring asserted from source, with live mutation self-proof`（describe 逐字實名；三重防線 R12 五紅） | T6 | GREEN |
| AC-10 | integration | `phase7-annual-mileage.test.ts` | `AC-10: Jan 1 and Dec 31 trips are included; Dec 31 of the previous year and Jan 1 of the next year are excluded`（describe 逐字實名；R1/R2 端點 mutant 雙側殺＋B-06 閏年） | T6 | GREEN |
| AC-11 | integration | `phase7-annual-mileage.test.ts` | `AC-11: attribution follows tripDate, not createdAt (both directions)`（describe 逐字實名） | T6 | GREEN |
| AC-12 | integration | `phase7-annual-mileage.test.ts` | `AC-12: only COMPLETED non-voided TRAVEL of the owner counts; highway km is never double-counted`（describe 逐字實名。type=TRAVEL 條款由 PHASE-005 `mileage-range.test.ts` 結構性斷言覆蓋——T6 即審 AR-2，本檔為其餘條款之行為面） | T6 | GREEN |
| AC-13 | integration | `phase7-annual-mileage.test.ts` | `AC-13: a null snapshot row is counted by applicationCount but ignored by totalKm; only totalKm feeds the amount`（describe 逐字實名）。金額條款已升級：T7 播種 effectiveFrom=2000-01-01 版本＋正向鑑別（同 count 異 totalKm⇒金額異）；M7/R14 mutant（count 進金額）播種後恰紅實證（T7 即審獨立重放確認） | T6 ＋ T7 | GREEN |
| AC-14 | integration | `phase7-annual-mileage.test.ts` | `AC-14: ownerId is always the application owner; preview resolves ownerId fail-closed (403 for another user) and authorises before field validation`（describe 逐字實名）。草稿 DTO 側已補：`on-behalf drafts: computed.officialKm is always the OWNER's mileage, never the operator's`（T7 檔 describe 逐字實名；R11 mutant 殺） | T6 ＋ T7 | GREEN |
| AC-15 | integration | `phase7-depreciation-parameters.test.ts` | describe 逐字實名：`AC-15: the version effective on Jan 1 of the application year is selected via findEffectiveVersion`（四情境＋off-by-one/時區 mutant R1/R2 殺） | T7 | GREEN |
| AC-16 | unit ＋ integration | `backend/test/unit/depreciation-blockers.test.ts`；`phase7-depreciation-parameters.test.ts` | 判定層實名：`AC-16(b): PARAMETER_NOT_AVAILABLE blocker is produced when no effective version exists`。整合層草稿/預覽面實名：`AC-16(b): a year with no effective version is blocked identically in preview and in the draft DTO`（T7）。完成端點實名：`完成端點 409 PARAMETER_NOT_AVAILABLE（兩來源逐字互異）`（T9 describe；details.missing＋applicationYear＋10 表零寫入） | T3 ＋ T7 ＋ T9 | GREEN |
| AC-17 | integration | `phase7-depreciation-parameters.test.ts` | describe 逐字實名：`AC-17: perKmUnitPrice comes verbatim from deriveDepreciation (4dp) — import wiring + live mutation self-proof`（10/3/3→1.1111 kill case＋R6 2dp mutant 7 紅） | T7 | GREEN |
| AC-18 | unit ＋ integration | `depreciation-blockers.test.ts`；`phase7-depreciation-parameters.test.ts` | 判定層：兩來源（查無版本／推導失敗）於本層折為同一碼之全等測試在場（`depreciation-blockers.test.ts` §4）；**409 訊息逐字互異＋details.missing 追加碼屬完成端點（T9）**；T7 已落：`AC-18: deriveDepreciation returning ok:false is treated as a missing parameter — never 500, never a zero unit price`（describe 逐字實名）＋service 層兩來源區辨形狀。409 區辨已落地：T9 `完成端點 409 PARAMETER_NOT_AVAILABLE（兩來源逐字互異）` describe（["DEPRECIATION"] vs ["DEPRECIATION_DERIVATION_FAILED"]＋訊息逐字互異） | T3 ＋ T7 ＋ T9 | GREEN |
| AC-19 | unit | `backend/test/unit/depreciation-calculation.test.ts` | 實名（代表列）：`AC-19 the function is pure: identical input yields identical output and never mutates the input Decimals`；`AC-19 floating-point discriminator: officialKm=0.07 × perKmUnitPrice=100.0000 is exactly 7 (an IEEE754 double intermediary produces 7.000000000000001)`；`AC-19 perKmUnitPrice is restored from the engine's fixed 4-decimal string with no Number()/parseFloat mediation (10/3/3 wiring check)`＋驗表列（§1，8 條） | T2 | GREEN |
| AC-20 | unit | `depreciation-calculation.test.ts` | 實名：`PRIMARY kill case — officialKm=1234.56 pattern replaced: 850.27 × 6.6667 → raw=5668.495009 → 5668 (mutant A 'pre-round raw to 2dp' → 5669; mutant B 'pre-round officialKm' → 5667)`；`SECONDARY kill case (terminating decimal) — 1137.50 × 5.5556 → raw=6319.495 exactly → 6319 (mutant A → 6320; mutant B → 6322)`；`AC-20 source-level scan: exactly one toDecimalPlaces() call exists in the implementation (the final amount)`；mutant M2/M3 各 7 紅實證（§18 T2 回填列） | T2 | GREEN |
| AC-21 | unit | `depreciation-calculation.test.ts` | 實名：`kill pair row 1 — officialKm=1.00 × 0.5000 → raw=0.5 → amount=1 (ROUND_HALF_EVEN mutant yields 0, must go red)`；`kill pair row 2 — officialKm=3.00 × 0.5000 → raw=1.5 → amount=2 (pairs with row 1: proves 'away from zero', not 'always down')`；`minimal discriminating pair — raw=0.4999 → 0 and raw=0.5 → 1`；mutant M1 3 紅實證 | T2 | GREEN |
| AC-22 | unit ＋ integration | `depreciation-calculation.test.ts`；`phase7-depreciation-complete.test.ts` | 判定層實名：`amount = 2147483647 (int4 max) is within capacity`；`amount = 2147483648 (int4 max + 1) is over capacity`；`FW-2 — an over-capacity input is REJECTED by the predicate, never thrown (Postgres 22003 numeric overflow would otherwise surface as a 500)`；`AC-22(b) the predicate never truncates: calculateDepreciation's returned values are unchanged by the capacity verdict`。整合層實名：`AMOUNT_OUT_OF_RANGE 之完成端點拒絕`（T9）＋`PHASE-007-T9b — AC-22 容量守門三處一致`（同 fixture 三處同步暴露＋防誤殺對照＋4dp 窄窗 22003 結構性不可達） | T2 ＋ T9 ＋ T9b | GREEN |
| AC-23 | integration | `phase7-depreciation-attachment.test.ts` | describe 逐字實名：`AC-23 上限 5：第 6 張 409 TOO_MANY_ATTACHMENTS ＋ 全交易回滾`（7 條；上限 mutant 5→6 與 5→4 雙側殺） | T8 | GREEN |
| AC-24 | unit ＋ integration | `depreciation-blockers.test.ts`；`phase7-depreciation-complete.test.ts` | 判定層實名：AC-24 判定層 0/1/5 張測試（`depreciation-blockers.test.ts` §2）。整合層實名：`PHASE-007-T9b — AC-24 折舊證明附件（草稿可缺、完成須 ≥1）`（全生命週期）＋T9 之 tx 內現算鑑別測試（交易外 DTO 可完成、完成前刪→400） | T3 ＋ T9 ＋ T9b | GREEN |
| AC-25 | integration | `phase7-depreciation-attachment.test.ts` | describe 逐字實名：`AC-25 完成後鎖定（deriveContainerState DEPRECIATION 分支）`（7 條；修復前紅燈 3 條 200→403 實證＋reviewer 獨立重現）。真實流程重驗已落地：T9 `跨 Task 移交項` describe 之「經真實完成端點完成之折舊，其證明附件 DELETE → 403（AC-25 真實流程重驗）」 | T8 ＋ T9 | GREEN |
| AC-26 | integration | `phase7-depreciation-attachment.test.ts` | describe 逐字實名：`AC-26 授權：附件讀取端點之五身分 ＋ 掛入守門 ＋ B-25 孤兒補洞`（10 條；B-25 活體突變恰 1 紅） | T8 | GREEN |
| AC-27 | integration | `phase7-depreciation-complete.test.ts` | describe 逐字實名：`AC-27 完成流程與 §9.3 步驟順序`＋`S-1 完成路徑同 tx 呼叫（mutant M2／M3 kill）`（T9R2 describe 實名；M2/M3 各恰 1 紅） | T9 ＋ T9R2 | GREEN |
| AC-28 | integration | `phase7-depreciation-complete.test.ts` | describe 逐字實名：`AC-28 快照欄位與精度`（8 欄＋totalAmount 落父表；三來源逐位元重算經 T9 即審 P3 獨立實證）＋`S-2 快照寫入 payload 已於服務層量化（mutant M4 kill）`（T9R2 describe 實名；M4 恰 1 紅） | T9 ＋ T9R2 | GREEN |
| AC-29 | integration | `phase7-depreciation-complete.test.ts` | describe 逐字實名：`AC-29 完成授權：僅擁有人本人`（管理員 403＋本人 200 對照；三候選路徑 404 負向；M6 mutant 殺） | T9 | GREEN |
| AC-30 | integration | `phase7-depreciation-complete.test.ts` | describe 逐字實名：`AC-30 原子性`（快照寫入後注入失敗全回滾；P2025→404；M11 快照逃逸交易 mutant 殺） | T9 | GREEN |
| AC-31 | integration | `phase7-snapshot-immutability.test.ts` | describe 逐字實名：`AC-31 事後改參數，歷史不變`（三種生效日 8 欄逐位元＋鑑別力探針＋spy 零重算——B1 mutant 6 紅） | T10 | GREEN |
| AC-32 | integration | `phase7-snapshot-immutability.test.ts` | describe 逐字實名：`AC-32 後端為唯一權威 — 建立端點（POST /applications/depreciation）`／`AC-32 後端為唯一權威 — 更新端點（PUT /applications/depreciation/:id）`／`AC-32 後端為唯一權威 — 完成端點（POST /applications/:id/complete）`（頂層純量矩陣 DB 指紋；三恆真格 T10R 修復——T10 即審 SF-1） | T10 ＋ T10R | GREEN（T10R 補三格） |
| AC-33 | integration | `phase7-snapshot-immutability.test.ts` | describe 逐字實名：`AC-33 雙完成併發`（**20 輪**恰一成功、敗方 403）＋`AC-33 parameterHasReferences('DEPRECIATION') 正負例`（真實完成流程正例＋型別鑑別） | T10 | GREEN |
| AC-34 | integration | `phase7-on-behalf.test.ts` | 實名（逐字）：`POST /admin/users/:userId/applications/depreciation → 201，owner/creator 分離且 AuditLog action/actorId/targetId/targetLabel/summary 精確`（＋真交易回滾 sentinel、停用 400、頂層純量夾帶） | T11 | GREEN |
| AC-35 | integration | `phase7-on-behalf.test.ts` | 實名（逐字）：`PUT /applications/depreciation/:id（admin 對 U 之草稿）→ 200，AuditLog action/actorId/targetId/targetLabel/summary（含前後值）精確`（＋前後值雙方向、自改零稽核鑑別、COMPLETED 403） | T11 ＋ T11b | GREEN |
| AC-36 | integration | `phase7-application-list.test.ts` | 實名：`depreciation, maintenance, and travel rows are interleaved in primaryDate DESC, createdAt DESC, id DESC order — including a null-year depreciation row`（T12R 補真實保養列＋tie-breaker；mutant 分支對調恰 1 紅） | T12 ＋ T12R | GREEN |
| AC-37 | integration | `phase7-application-list.test.ts` | 實名：AC-37 describe 五條（type/date/ownerId/keyword 已知限制）＋`T12R-LITE SF-2: status=DRAFT returns the draft depreciation row and excludes the completed one`／`…status=COMPLETED…`（正負例對照） | T12 ＋ T12R | GREEN |
| AC-38 | frontend | `frontend/test/DepreciationApplicationPage.test.tsx` | 實名：`AC-38：表單僅有申請年度一個可輸入欄位（逐字標籤）`；`AC-38：年度可為空值儲存（null 為合法值，前端轉為 JSON number｜null）`；`AC-38：填入年度後以 JSON number（非字串）送出` | T13 | GREEN |
| AC-39 | frontend | `DepreciationApplicationPage.test.tsx` | 實名：`AC-39：預覽顯示折舊每公里單價／年度公務里程／年度補貼金額，逐字取自後端回應`；`AC-39：前端零自算鑑別——mock 之 amount 與 officialKm×perKmUnitPrice 刻意不符，畫面仍顯示 mock 值`；`AC-39：車價／折舊年限／預估年度行駛公里數三推導值於草稿頁不出現`（＋已完成頁同型負向） | T13 | GREEN |
| AC-40 | frontend | `DepreciationApplicationPage.test.tsx` | 實名：`AC-39：不可計算時不得顯示金額 0，須顯示「無法計算」＋zh-TW 說明`；`Empty：年度無任何有效差旅（totalKm=0.00、applicationCount=0）時顯示 0 值＋說明，非錯誤、非空白頁`（T14R 補說明文字＋完成鈕可用）；`Error：讀取草稿 500 時顯示錯誤訊息與重試按鈕，點擊重試重新呼叫 GET`；`blockingCodes 驅動顯示：未知代碼原樣顯示（非以 calculable 單一旗標決定文案內容）`；Loading/Permission denied 各一 | T13 ＋ T14 ＋ T14R | GREEN |
| AC-41 | frontend | `DepreciationApplicationPage.test.tsx` | 實名：`AC-41：缺參數時顯示聯絡管理員文案、停用「完成申請」，但「儲存草稿」仍可用`；`AC-41：條件齊備（無 blocker）時「完成申請」鈕可用，點擊後呼叫完成端點` | T13 | GREEN |
| AC-42 | frontend | `DepreciationApplicationPage.test.tsx` | 實名：`同年度已有其他申請時顯示提醒文字，但不阻擋建立與完成（提醒在場且完成鈕可用）`；`已有 5 張再上傳（第 6 張）→ 前端拒絕並顯示上限訊息、零上傳呼叫`；`B-22／FW-11 裁定 A：attachmentIds 送出前去重（重複 id 不重複送出）`；`已完成之折舊申請不存在任何上傳／刪除入口（負向斷言）`（等） | T14 | GREEN |
| AC-43 | integration | `phase7-contract.test.ts` | 實名：`AC-43 ErrorCode 聯集全等 + 本 Phase src 僅用基線字面值`（含 `errors.ts ErrorCode union equals the known baseline`、`PHASE-007 source references only baseline ErrorCode literals`——BOGUS mutant 終審重放恰紅）＋`AC-43 — PHASE-007 折舊端點錯誤合約` | T15 | GREEN |
| AC-44 | integration | `phase7-contract.test.ts` | 實名：`AC-44 日誌安全：logStream 六類掃描`（6 條；終審反向探針 2 紅證非恆真） | T15 | GREEN |
| AC-45 | e2e | `e2e/depreciation-allowance.spec.ts` | 實名：`年度折舊補貼 — PHASE-007 Gate E2E` 情境 1~6（大總管親跑 37/37＋單檔二輪 7/7；FW-7 控制組證參數確變） | T16 | GREEN |
| AC-46 | e2e | `e2e/depreciation-allowance.spec.ts` | 實名：`情境7：響應式 375px——折舊表單／預覽／證明／列表／已完成詳情皆無水平溢位`（覆蓋面多於條文四畫面） | T16 | GREEN |

---

## 12R. 修訂段狀態覆寫表（折舊模型修訂，2026-08-05；**修訂段以本表為準**）

> **為何另立表而不改寫 §12**：§12 之 `GREEN` 列載有開發段 18 個 Task 之**實名逐字測試證據**，屬歷史記錄性內容（Packet 明令不得改寫）。本表以「覆寫」方式表達修訂段狀態：**同一 AC 若在本表出現，即以本表狀態為準**；未出現者，§12 之狀態繼續有效。
> **狀態值**：`PENDING`（受修訂影響，須重新以 TDD 落地並回填實名）／`RETIRED`（AC 已退場，其測試依 Spec 授權之測試遷移移除或改寫，**不視為弱化測試**）／`GREEN（不受影響）`（明示判定，供終審核對用）。
> **Phase 完成前之覆蓋檢查與終審核對**：以 §12 ＋ 本表之**合併結果**為準。
> **回填義務**：`PENDING` 列於對應 R Task 完成後，由大總管以 `vitest --reporter=verbose` 之實際輸出**逐字回填**測試名（沿 §12 既有紀律）。

### 12R.1 退場列（`RETIRED`；不刪列，保留追溯）

| AC | 退場理由 | 取代者 | 既有測試之處置 | Task |
|---|---|---|---|---|
| AC-17 | 每公里單價退出申請計算（裁定①）；`deriveDepreciation` 於申請路徑零呼叫 | **AC-49**（每年折舊費用來源＋引擎凍結） | `phase7-depreciation-parameters.test.ts` 之 AC-17 describe 改寫為 AC-49；`10/3/3 → 1.1111` kill case **移轉至 `depreciation-engine.test.ts` 保留**（003a 引擎凍結證明，不得刪） | R4a ＋ R6 |
| AC-19 | 公式改造：`里程 × 單價` → `每年費用 × 比例`（裁定①） | **AC-51** | `depreciation-calculation.test.ts` 之 AC-19 describe 依新公式改寫（浮點鑑別、純度、輸入不變性三條**語意保留**，僅換輸入組） | R2 |
| AC-20 | 舊 kill case 數對（`850.27 × 6.6667`）依附舊公式，新公式下不可達 | **AC-51**（新 kill case 見 §20.4.3） | 舊 kill case 測試刪除並以新 kill case 取代；「取整恰一處」之原始碼掃描斷言**語意保留** | R2 |
| AC-24 | 證明由必要改選填（裁定②）：`DEPRECIATION_ATTACHMENT_REQUIRED` 退場 | **AC-54**（語意反轉：零附件可完成） | `depreciation-blockers.test.ts` §2 與 `phase7-depreciation-complete.test.ts`／`phase7-depreciation-attachment.test.ts` 之「完成須 ≥1」全部反轉；**上限 5（AC-23）不動** | R3 ＋ R7 |
| AC-28 | 快照欄位集合變更（8 欄 → 9 欄，二欄轉凍結唯讀） | **AC-55** | `phase7-depreciation-complete.test.ts` 之 AC-28 describe 依新欄集合改寫；「顯式定精度」「不由 rawAmount 反推 amount」兩條紀律**語意保留** | R7 |
| AC-39 | 前端顯示每公里單價之條文退場（連帶 C 揭露面改為五值） | **AC-59** | `DepreciationApplicationPage.test.tsx` 之 AC-39 三條改寫；「零自算鑑別」與「不顯示車價」兩條**語意保留並擴張**（新增年限負向，Q6） | R9 |

### 12R.2 受影響列（轉 `PENDING`）

| AC | 受影響原因 | Task | 狀態 |
|---|---|---|---|
| AC-01 | §8.2 欄位集合變更（新增 4 欄）＋ `DepreciationParameterVersion.estimatedAnnualKm` 轉 nullable ⇒ **ALTER 型 M2 migration**；安全網 fixture 須依 **T1 FW-8** 改 raw SQL 寫法；業務表總數**不變（15）** | R1 | `PENDING` |
| AC-02 | 建立端點新增 `annualTotalKm`（**應予採用**，S-3）；「全部快照欄為 `null`」之逐欄斷言須含新增 4 欄 | R5 | `PENDING` |
| AC-05 | `DepreciationApplicationDto`／`ComputedDto`／`SnapshotDto` 三形狀全部變更（§20.6） | R5 ＋ R6 | `PENDING` |
| AC-18 | 推導失敗之來源函式改為 `deriveAnnualDepreciation`（兩參數）；`estimatedAnnualKm` 不再是失敗來源 | R4a ＋ R6 | `PENDING` |
| AC-21 | `ROUND_HALF_UP` 紀律不變，但 kill pair 之輸入組須依新公式重建（§20.4.3 已給定數對） | R2 | `PENDING` |
| AC-22 | 容量欄位集合變更：`snapshotPerKmUnitPrice` 退出判定、新增 `snapshotAnnualDepreciation`／`snapshotAnnualTotalKm`／`snapshotRatio`；常數表重整（零魔術數紀律不變） | R2 ＋ R7 | `PENDING` |
| AC-27 | §9.3 步驟②之附件計數守門退場、新增比例守門；②③④順序紀律不變（§20.8） | R7 | `PENDING` |
| AC-30 | 原子性語意不變，但「快照全 `null`」之逐欄回滾斷言須含新增 4 欄 | R7 | `PENDING` |
| AC-31 | 「8 欄逐位元不變」→「**9 欄**逐位元不變」；spy 零重算之被監視函式改為 `deriveAnnualDepreciation` | R8 | `PENDING` |
| AC-32 | 夾帶矩陣變更：新增 `ratio`／`ratioPercent`／`annualDepreciation` 為**不採用**；`annualTotalKm` 為**採用之例外**，須與 AC-48 同場對照（同一請求一採一不採） | R8 | `PENDING` |
| AC-35 | 代修改稽核 `summary` 之前後值須含 `annualTotalKm`（欄位摘要完整性） | R8 | `PENDING` |
| AC-38 | 表單由「僅年度一欄」改為「年度 ＋ 年度總里程兩欄」；年度公務里程無輸入欄之負向斷言**保留** | R9 | `PENDING` |
| AC-40 | 五態語意變更：`Empty`（公務里程 0 但總里程有值 ⇒ 金額 0 合法）與「未輸入總里程 ⇒ 不可計算、不顯 0 元」為**兩種不同狀態**，須各自有測試 | R10 | `PENDING` |
| AC-41 | 缺參數語意不變，但「條件齊備 ⇒ 完成鈕可用」之前置條件須補填 `annualTotalKm` | R10 | `PENDING` |
| AC-42 | 「完成前無證明時完成鈕停用」條款退場（證明選填）；重複提醒、上限 5、已完成無入口三條**保留** | R10 | `PENDING` |
| AC-45 | E2E 流程新增「輸入年度總里程」步驟、證明改選填、預覽與完成詳情改驗五值 | R12 | `PENDING` |
| AC-46 | 響應式四畫面之版型因新增欄位與五值列而改變 | R12 | `PENDING` |

### 12R.3 新增列（修訂段新 AC；條文見 §20.3）

| AC | 層級 | 測試檔（預定路徑） | 測試名（預定名稱） | Task | 狀態 |
|---|---|---|---|---|---|
| AC-47 | integration | `backend/test/integration/phase7-depreciation-draft.test.ts` | `AC-47: annualTotalKm validation gate table — type/decimal-places(≤1)/≤0/capacity, with fields[].field asserted`（建立與更新兩端點各一組） | R5 | `PENDING` |
| AC-48 | integration | `phase7-depreciation-draft.test.ts`；`phase7-snapshot-immutability.test.ts` | `AC-48: annualTotalKm is 申請資料 and IS adopted from the request body, while officialKm/ratio/amount are never adopted (same-request contrast matrix)` | R5 ＋ R8 | `PENDING` |
| AC-49 | unit ＋ integration | `backend/test/unit/depreciation-engine.test.ts`；`phase7-depreciation-parameters.test.ts` | `AC-49: deriveAnnualDepreciation returns 車價÷年限 at 2dp and rejects ≤0 inputs`；`AC-49: the application path calls deriveAnnualDepreciation and never deriveDepreciation (import wiring + live mutation self-proof + negative spy)`；`AC-49 凍結證明: deriveDepreciation 之既有測試零改動全綠` | R4a ＋ R6 | `PENDING` |
| AC-50 | unit | `backend/test/unit/depreciation-calculation.test.ts` | `AC-50: ratio = officialKm ÷ annualTotalKm at full precision; ratioString(6dp)/ratioPercentString(4dp) are display-only and never feed the amount (mutant: amount computed via .times(ratio) must go red)` | R2 | `PENDING` |
| AC-51 | unit ＋ integration | `depreciation-calculation.test.ts`；`phase7-depreciation-parameters.test.ts` | `AC-51 PRIMARY kill case — A=100000.00 × O=1001.66 ÷ I=12345.6 → raw=8113.4979263867288751 → 8113 (mutant ratio6→8114, ratio4→8110, raw2→8114, okmInt→8116 each must go red)`；`AC-51 source-level scan: exactly one toDecimalPlaces(0) call exists in the implementation` | R2 ＋ R6 | `PENDING` |
| AC-52 | unit ＋ integration | `backend/test/unit/depreciation-blockers.test.ts`；`phase7-depreciation-parameters.test.ts`；`phase7-depreciation-complete.test.ts` | `AC-52: officialKm > annualTotalKm produces OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM with field=annualTotalKm`；`AC-52 邊界: ratio 恰 100% (O == I) is allowed to complete`；`AC-52: the blocker is exposed identically in draft DTO, preview and completion` | R3 ＋ R6 | `PENDING` |
| AC-53 | unit ＋ integration ＋ frontend | `depreciation-blockers.test.ts`；`phase7-depreciation-parameters.test.ts`；`DepreciationApplicationPage.test.tsx` | `AC-53: a null annualTotalKm saves as a draft, yields ANNUAL_TOTAL_KM_REQUIRED + calculable=false, and blocks completion with 400`；`AC-53: 未輸入年度總里程時畫面顯示「無法計算」，不得出現金額 0` | R3 ＋ R6 ＋ R10 | `PENDING` |
| AC-54 | integration | `phase7-depreciation-complete.test.ts`；`phase7-contract.test.ts` | `AC-54: a draft with zero attachments completes successfully (200) and writes the full snapshot`；`AC-54: DEPRECIATION_ATTACHMENT_REQUIRED no longer appears in any response nor anywhere in src (structural scan)`；`AC-54: the 5-attachment limit still applies` | R7 | `PENDING` |
| AC-55 | integration | `phase7-depreciation-complete.test.ts` | `AC-55 快照欄位與精度（9 欄）— snapshotVehiclePrice/UsefulLifeYears/AnnualDepreciation/OfficialKm/AnnualTotalKm/Ratio/RawAmount/calculatedAt/depreciationParameterVersionId, with 三來源逐位元重算`；`AC-55: the two frozen legacy columns (snapshotEstimatedAnnualKm, snapshotPerKmUnitPrice) are always NULL for new-model rows` | R7 | `PENDING` |
| AC-56 | integration | `phase7-depreciation-complete.test.ts`；`phase7-migration-safety.test.ts` | `AC-56 新舊模型判別: snapshotAnnualTotalKm != null ⇒ new model; snapshotPerKmUnitPrice != null && snapshotAnnualTotalKm == null ⇒ legacy model (raw-SQL seeded legacy row is rendered read-only and never recomputed)` | R1 ＋ R7 | `PENDING` |
| AC-57 | integration | `backend/test/integration/phase3a-parameter-depreciation.test.ts` | `AC-57 折舊參數縮欄（凍結式）: POST no longer accepts estimatedAnnualKm (夾帶不採用，欄位寫 NULL) and no longer returns perKmUnitPrice`；`AC-57: GET still returns the original estimatedAnnualKm/perKmUnitPrice for legacy versions (read-only) and null for new versions` | R4b ＋ R4c | `PENDING` |
| AC-58 | frontend | `frontend/test/DepreciationApplicationPage.test.tsx` | `AC-58：表單提供「該車年度總里程」可輸入欄位，並與唯讀之「年度公務里程」明確區分（標籤逐字＋公務里程仍無 textbox 之負向斷言）` | R9 | `PENDING` |
| AC-59 | frontend | `DepreciationApplicationPage.test.tsx` | `AC-59：預覽與完成後詳情顯示五值（每年折舊費用／年度公務里程／年度總里程／公務比例／補貼金額），逐字取自後端回應`；`AC-59：車價、折舊年限、每公里單價三者於草稿頁與已完成頁皆不出現（負向斷言）` | R9 | `PENDING` |
| AC-60 | frontend | `DepreciationApplicationPage.test.tsx` | `AC-60：公務比例 >100% 時顯示錯誤與「請檢查年度總里程」提示並停用「完成申請」，但「儲存草稿」仍可用` | R10 | `PENDING` |
| AC-61 | frontend | `frontend/test/ParametersPage.test.tsx` | `AC-61：折舊參數建立表單僅有車價、折舊年限、生效日期（預估年度行駛公里數欄位不存在之負向斷言）`；`AC-61：折舊預覽顯示每年折舊費用、不顯示每公里補助單價（負向斷言）`；`AC-61：版本列表對含預估年里程之歷史版本以唯讀顯示原值` | R11 | `PENDING` |

> **裁定 F（既有舊公式測試申請清空）無 AC 列**——該項為**環境資料操作**（dev／Gate DB 之合成資料刪除），非產品行為，不具可測試之 AC 語意；其驗證落於 **R13 之 Done When**（見 §20.12）。此為刻意判定，非漏列。

### 12R.4 明示不受影響列（`GREEN（不受影響）`；供終審核對，免逐條重查）

**AC-03、AC-04、AC-06、AC-07、AC-08、AC-09、AC-10、AC-11、AC-12、AC-13、AC-14、AC-15、AC-16、AC-23、AC-25、AC-26、AC-29、AC-33、AC-34、AC-36、AC-37、AC-43、AC-44**（共 23 列）。

判定依據（逐項）：AC-03 只約束 `applicationYear`（新欄之驗證屬 AC-47，兩者不重疊）；AC-04 之狀態守門與附件對帳語意零變更；AC-06/07/08 年度語意與重複申請零變更；AC-09~AC-14 里程引擎複用與 `ownerId` 解析零變更（**AC-13「金額只用 `totalKm`」於新公式下仍成立——`totalKm` 為比例之分子**）；AC-15/16 選版與缺參數處置零變更（碼與 409 形狀不變）；AC-23 上限 5 為裁定②明示照舊；AC-25/26 附件鎖定與授權不因證明改選填而變（US §2 已明示 BE-US-25／NFR-US-10 不變）；AC-29 僅本人可完成零變更；AC-33 併發與引用保護零變更；AC-34 代建立之 owner/creator 分離零變更；AC-36/37 列表與篩選零變更；AC-43 **`ErrorCode` 聯集仍全等**（新增之三個 blocker code 為 `Blocker.code` 字串，**不是** `ErrorCode` 成員，見 §20.5.2）；AC-44 日誌安全零變更。

> **測試檔連帶更新 ≠ 狀態變更**：上列 AC 之測試檔可能因**播種資料需補 `annualTotalKm`** 而有機械性改動（例如 `phase7-annual-mileage.test.ts` 之完成流程 fixture）。此類改動屬 §20.11 之測試遷移義務，**不使該 AC 轉 `PENDING`**——判準為「斷言語意是否改變」，不是「檔案是否被觸碰」。

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

## 15. Task Graph　**【開發段已完成之工作記錄；修訂段派工見 §20.12】**

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

| 2026-08-04 | **T2 回填（大總管依 §15 T2 Done When 義務）**：①AC-20 正式 kill case 數對＝`officialKm=850.27, perKmUnitPrice="6.6667"`（引擎可達：300000/3/15000）→ `rawAmount=5668.495009`、`amount=5668`；mutant「先取整 rawAmount 至 2 位」→ `5669`、mutant「先取整 officialKm」→ `5667`，單一數對同時鑑別兩 mutant 且各差 1 元。輔助數對 `1137.50 × "5.5556"（300000/3/18000）→ 6319`（A→6320✗、B→6322✗）。鑑別窗口機制：mutant A 僅於 `frac(rawAmount)∈[0.495,0.5)` 分歧。②§2 AC-20 算術筆誤更正（617.404656→617.403456，結論不變）。③§2 AC-21 鑑別方向筆誤更正（HALF_EVEN 於 row 1 `0.5→1` 必紅，非 row 2；PHASE-006 AC-17(d) 有同型沿襲筆誤，記錄備查）。 | T2 Handoff（`50d9337`）；三項皆 implementer 實跑證據，非推算 |

| 2026-08-04 | **T3 即審後澄清（大總管，§11.1 不改變產品含義之澄清）**：§7.5 補「完整清單之定義」段（reviewer 建議措辭照錄）——blockers[] 為本次已評估之未通過項目、兩段式互斥、至多兩碼、呼叫端不得補算被抑制項。§12 AC-16/18/24 轉 PARTIAL（判定層 GREEN）。 | T3 即審報告裁量 (c)（無矛盾、建議澄清）；T3 Handoff New Risks 同源 |

| 2026-08-05 | **B-22 措辭修訂（T8 即審 SF-1，人類裁定 A 案）**：§5 B-22 由「去重後計數」改為如實描述現況行為（重複 id → 409 `CONFLICT`、全交易回滾、零關聯；上限繞過天然封閉；前端自行去重列 T13/T14 義務）。選項 B（改程式去重）經評估否決：行為變更且折舊與保養分岔，為異常輸入邊角動兩個已驗證功能不划算。現況行為與 PHASE-006 逐行同型、fail-closed，reviewer P5b 探針實證。 | 人類 leonchih 2026-08-05 裁定「A」（大總管以產品語言解說 A/B 後）；T8 即審報告 SF-1 建議措辭照錄 |

| 2026-08-05 | **§15 T11 檔案清單勘誤（大總管，§11.2 內部技術細節記錄）**：AC-35 之 `onUpdated` 稽核 hook 唯一正當落點為 `applications/routes.ts` 之 PUT depreciation handler（呼叫端持有 actorId；service 層刻意無 actor 概念防夾帶面；006 T9 同型先例修同檔 :865-910）——T11 檔案清單漏列該檔致 implementer 正確 BLOCKED。處置：T11b-LITE 限縮授權（僅該 handler 之 onUpdated 建構）。 | T11 Handoff W-1 落點分析（實查非推測）；大總管裁定 (a) |

| 2026-08-05 | **§4 Empty 態勘誤（T12~T14 複審 SF-3 處置）**：Empty 列字面「補貼金額 0 元」之「元」單位——全站既有慣例為金額不帶單位字（Maintenance/快照頁同型），維持慣例；說明文字與「完成仍可執行」已由 T14R 補齊（`29632df`）。 | 大總管裁定（沿全站慣例）；T12~T14 合併複審 SF-3 |

| 2026-08-05 | **終審處置（大總管白名單）**：①MF-1——§12 AC-43~46 轉 GREEN（實名逐字回填）＋AC-05 依 T7 落地事實轉 GREEN；②SF-1——AC-32 列三處括號全形化（逐字可 grep）；③**AR-a 勘誤**：§2 AC-43 條文漏列 `requestId`——系統自 PHASE-001 起錯誤體恆含 requestId（errors.ts 檔頭引 Spec 5.2 權威形狀），歷代 contract test 皆斷言之；T15 沿系統基準正確，條文以本列勘誤不改程式；④AR-c 措辭修正：T9b「4dp 窄窗 22003 結構性不可達」宜讀為「實務不可達（未證明數學上不可能）」。 | PHASE-007 終審報告 MF-1/SF-1/AR-a/AR-c |

| 2026-08-05 | **折舊模型修訂（PHASE-007-SPEC-REV）**：依人類 leonchih 2026-08-05「照提案全部確認」之 US Gate 批准，將本 Spec 全面修訂為新折舊模型。①新增 **§20 修訂段**（全部修訂內容集中於此，衝突處覆蓋 §1~§17）：修訂後目標、AC 異動總表、**新增 AC-47~AC-61 全文**、新公式與**經實際驗算之 kill case 數對**、blocker 表與錯誤碼異動、DTO 與端點異動、**ALTER 型 M2 migration 與新舊模型判別**、Data Flow、五態與邊界增補（B-36~B-45）、揭露面修訂、測試策略與**既有測試遷移逐檔清單**、**修訂段 Task Graph R1~R13**、決策記錄 D15~D22、已知限制與 Rollback 增補。②新增 **§12R 修訂段狀態覆寫表**（退場 6 列、轉 `PENDING` 17 列、新增 15 列、明示不受影響 23 列；§12 開發段 `GREEN` 實名記錄一律保留不改寫）。③§1~§17 受影響節加註 **【已修訂 → §20.x】** 標記，歷史記錄性內容（§15 Task Graph、§16 D1~D14、§18 Gate 固化列）零改寫。**Spec 狀態維持 `ACTIVE`。** 本次修訂**不改變任何已批准之 US 原意、不縮減任何已批准 AC、不新增任何人類未批准之使用者可見行為**；Spec 層裁量 3 項（§20.13 D20~D22）已於 Handoff 逐項揭露。 | 人類 leonchih 2026-08-05「照提案全部確認」（`docs/specs/PHASE-007-US-REV-PROPOSAL.md` Status: APPROVED——§1 八條修訂全文、§6.2 E-1~E-8／S-1~S-4 十二項擴張與建議、§4 Q1~Q12 全數照推薦）；`userstory.md` HEAD 版八條（US-LAND `8b122b7`）；`docs/PRD.md`（REV-PRD-SYNC `237f4b2`）；`PROJECT_STATE.md` L5-L13 Gate 反饋列（裁定①②、連帶 A/B/C、細節 D/E/F）；REV-PRD-SYNC 移交三項（錯誤碼聯集變更、參數端點縮欄凍結式處置 Q9、新舊模型判別 Q7）；PHASE-005a Spec §8.4／§16 D1(a)（凍結式先例）、PHASE-006 Spec AC-16/17 與 T2R SF-1（比例分攤同型與 `.times(ratio)` 反例）、T1 即審 FW-1/FW-2/FW-3/FW-8；`docs/retrospective/PHASE-007-usage.md` §3 預算帶 |

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

---

## 20. 折舊模型修訂段（2026-08-05 人類批准；**衝突處覆蓋 §1~§17**）

### 20.0 修訂依據、適用範圍與優先序

**批准來源（全部已取得人類批准，本節不含任何未裁定項）**

| # | 來源 | 內容 |
|---|---|---|
| 1 | 人類 leonchih 2026-08-05「照提案全部確認」 | `docs/specs/PHASE-007-US-REV-PROPOSAL.md`（Status: **APPROVED**）§1 八條 US 修訂全文、§6.2 **E-1~E-8／S-1~S-4** 十二項【擴張】與【建議】、§4 **Q1~Q12** 全數照推薦 |
| 2 | `PROJECT_STATE.md` L5–L13 Gate 反饋列 | 裁定①（公式改造）、裁定②（證明選填）、連帶 (A)(B)(C)、細節 (D)(E)(F) |
| 3 | `userstory.md` HEAD 版（US-LAND `8b122b7`） | FE-US-17／18／19／20、AD-US-13、BE-US-14／17／18 修訂後逐字條文＝**規範原文** |
| 4 | `docs/PRD.md`（REV-PRD-SYNC `237f4b2`） | §1 產品描述、§4.3 BE-US-14 更名、§5 PHASE-003a 凍結註記與 PHASE-007 段全改寫 |

**優先序規則（機械可判）**

1. 本節（§20）與 §1~§17 衝突時，**一律以 §20 為準**；§1~§17 受影響處已加註 **【已修訂 → §20.x】**。
2. §20 與 `userstory.md` HEAD 版衝突時，**一律以 `userstory.md` 為準**（事實來源第 2 層）——若發現此類衝突，屬 Spec 缺陷，須回報大總管而非自行取捨。
3. §12（開發段 `GREEN` 實名記錄）與 §12R（修訂段狀態）併存：**同一 AC 出現於 §12R 時以 §12R 為準**。
4. §15（T1~T16／T6b／T9b）為**已完成之歷史工作記錄**，修訂段派工一律依 §20.12 之 **R1~R13**。

**修訂之一句話摘要**

> 補貼 ＝ **每年折舊費用（車價 ÷ 折舊年限）× 公務比例（年度公務里程 ÷ 使用者申報之年度總里程）**，整筆一次四捨五入為新臺幣整數；「預估年度行駛公里數」與「每公里補助單價」退出申請計算；申請表單新增「年度總里程」必填輸入欄；折舊證明改為**選填**（上限 5 照舊）。

---

### 20.1 修訂後目標與非目標

**§1.1 目標之取代條目**（其餘條目不變）

| 原條目 | 修訂後 |
|---|---|
| 5.「每公里補助單價」 | **5R.「每年折舊費用」（BE-US-14 修訂後）：一律呼叫 `deriveAnnualDepreciation({ vehiclePrice, usefulLifeYears })`，取其 2 位小數字串；每公里單價推導（`deriveDepreciation`）於申請路徑**零呼叫**、行為凍結（§20.7.5、AC-49）** |
| 6.「年度補貼金額 ＝ ROUND(年度公務里程 × 單價)」 | **6R.「年度補貼金額」（BE-US-17 修訂後）：`rawAmount = 每年折舊費用 × 年度公務里程 ÷ 年度總里程`，`amount = ROUND_HALF_UP(rawAmount, 0)`，**整筆一次**四捨五入；公務比例僅為顯示值，**不參與**金額計算（§20.4）** |
| 8.「完成與快照（6 值 ＋ 3）」 | **8R.「完成與快照」：快照為 **9 欄**（車價／年限／每年折舊費用／年度公務里程／年度總里程／公務比例／取整前金額／計算時間／參數版本 id），最終金額落 `Application.totalAmount`；舊二欄（預估年里程、每公里單價）**恆為 `null`**（§20.7.1、AC-55）** |
| 2.「折舊證明（完成須 ≥1）」 | **2R.「折舊證明（選填）」：上限 5 照舊、草稿可缺、**完成不再要求 ≥1**、完成後鎖定、授權存取（AC-54；裁定②）** |
| 11.「Phase 結束之人類可操作路徑」 | **11R.**：建草稿 → 選年度 → **輸入年度總里程** → 看到年度公務里程（唯讀）／**每年折舊費用**／**公務比例**／補貼金額 → **（可選）**上傳證明 → 完成並保存快照 → 管理員改參數後歷史不變 |

**新增目標**

- **12R. 比例守門（連帶 A）**：公務比例 > 100% 一律**擋完成**並提示檢查年度總里程；恰等於 100% **允許完成**（Q4）。
- **13R. 折舊參數縮欄之凍結式處置（連帶 B／Q9）**：新版本只需車價 ＋ 年限；預估年里程與推導單價自建立介面與回應退場，歷史版本唯讀保留原值。
- **14R. 對帳揭露面（連帶 C）**：畫面顯示**每年折舊費用／年度公務里程／年度總里程／公務比例／補貼金額**五值；**車價與折舊年限一律不顯示**（Q6）。

**§1.2 非目標之增補**

| 項目 | 落點 | 說明 |
|---|---|---|
| 同年度多筆折舊申請之「年度總里程一致性檢查」 | **明確不做** | Q11 已裁定；等同「自動判斷重複報帳」，屬 `userstory.md` §七 Out of Scope |
| 年度總里程之車輛主檔化 | **明確不做** | Q10 已裁定：年度總里程為**每筆申請自帶之申報資料**，不落於任何車輛主檔或使用者屬性 |
| 舊模型已完成折舊申請之資料遷移／重算 | **明確不做** | Q7 已裁定：不遷移、不重算；dev／Gate 之合成資料由**裁定 F** 直接清空（R13） |
| 舊模型列之前端專屬版型 | **PHASE-008** | 裁定 F 清空後 dev／Gate 無此資料；報表層之舊模型呈現屬 PHASE-008（§20.14 #1） |
| 年度**公務**里程為 0 時之阻擋 | **明確不做**（不變） | 年度**總**里程未填或 ≤0 之阻擋則屬 **In Scope**（AC-53）——兩者為不同欄位，PRD §PHASE-007 Out of Scope 已同步消歧 |

---

### 20.2 AC 異動總表

> 逐列判定與受影響原因見 **§12R**（退場 6 列、轉 `PENDING` 17 列、新增 15 列、明示不受影響 23 列）。本表為總量對照。

| 類別 | 數量 | AC 編號 |
|---|---|---|
| **退場**（`RETIRED`，不刪列） | 6 | AC-17、AC-19、AC-20、AC-24、AC-28、AC-39 |
| **修訂**（轉 `PENDING`） | 17 | AC-01、02、05、18、21、22、27、30、31、32、35、38、40、41、42、45、46 |
| **新增** | 15 | **AC-47 ~ AC-61** |
| **不受影響**（明示判定） | 23 | AC-03、04、06~16、23、25、26、29、33、34、36、37、43、44 |
| 修訂後 AC 總數 | **55**（46 − 6 退場 ＋ 15 新增） | — |

---

### 20.3 新增 AC 全文（AC-47 ~ AC-61）

> **溯源規則同 §2**：每條標註來源 US 條文。**金額語意類 AC（AC-50、AC-51、AC-55）之測試一律以精確等值斷言，禁止近似比較。**

#### A′. 年度總里程（使用者申報之申請資料）

- **AC-47 年度總里程之欄位驗證**（來源：FE-US-17 第 1／4／6 條、BE-US-17 第 4 條、裁定 D、裁定 E、Q1）——`POST`／`PUT /applications/depreciation`（**兩端點各一組**）：
  - **(a)** 型別：接受 JSON number、數值字串或 `null`／缺省（沿既有 `parseDecimalField` 之里程欄慣例）；布林／物件／陣列／非數值字串 → **400 `VALIDATION_ERROR`**。
  - **(b)** 精度（**裁定 D**）：小數位 > **1** → 400（例：`12345.67` 拒絕、`12345.6` 通過、`12345` 通過）。**不得靜默取整**。
  - **(c)** 值域（**裁定 E**）：`0`、負數、`NaN`／`Infinity` 字面 → **當場 400**（不延後到完成階段）；`null`／缺省 → **允許**（草稿寬容，AC-53）。
  - **(d)** 容量：`|v| ≥ 1e8` → 400（沿既有 `KM_MAGNITUDE_LIMIT` 與文案「整數部分最多 8 位」）；`99999999.9` 通過／`100000000` 拒絕（邊界四點各一測試）。
  - **(e)** `fields[]` 之 `field` 路徑須有**明文斷言**（`"annualTotalKm"`，006 T3 AR-2／FW-5 教訓）。
  - **(f)** **授權先於格式驗證**（403 先於 400）之既有順序不變。

- **AC-48 年度總里程為「申請資料」應予採用**（來源：BE-US-17 修訂後**第 8 條**逐字＝提案 S-3【建議】，人類已批准）——
  - **(a)** `POST`／`PUT` body 之 `annualTotalKm` **應予採用**：寫入 DB 之值與請求值**逐位元相同**，DTO 回傳為固定 1 位小數字串。
  - **(b)** **同一請求之對照矩陣**（與 AC-32 併存之鑑別測試）：同一次請求同時夾帶 `annualTotalKm`（**採用**）與 `officialKm`／`ratio`／`ratioPercent`／`annualDepreciation`／`rawAmount`／`amount`／`totalAmount`（**一律不採用**）→ 前者入庫、後者與未夾帶之對照組**逐位元相同**。夾帶值須為**頂層純量且與正確值可鑑別**（006 T8 MF-1 教訓）。
  - **(c)** 完成時該值**原樣**寫入 `snapshotAnnualTotalKm`（不重新查詢、不重算——它沒有系統來源）。
  - > **消歧義註記**：本 AC 與 CLAUDE.md「後端不得採用前端提交的金額」**不衝突**——後者約束「計算結果」，本 AC 約束「申請輸入資料」，與保養之 `actualCost` 同型。此區分由人類於 US Gate 明文批准（提案 §5、S-3）。

#### B′. 每年折舊費用與計算

- **AC-49 每年折舊費用之來源、引擎凍結與推導失敗**（來源：BE-US-14 修訂後全三條、連帶 B、Q9、Q12）——
  - **(a)** 新增純函式 `deriveAnnualDepreciation({ vehiclePrice, usefulLifeYears })` → `{ ok: true, annualDepreciation: string /* 2dp */ } | { ok: false }`；公式**逐字**為 `ROUND_HALF_UP(vehiclePrice ÷ usefulLifeYears, 2)`（與既有 `deriveDepreciation` 之 `annualDepreciation` 語意**完全一致**）。
  - **(b)** **單一實作**：`deriveAnnualDepreciation` 與 `deriveDepreciation` 之每年費用計算**共用同一內部推導**（單一事實來源；禁止第二份 `vehiclePrice ÷ usefulLifeYears` 實作——006 T5R SF-1 雙份漂移教訓）。以原始碼結構性斷言守門。
  - **(c)** **申請路徑零呼叫 `deriveDepreciation`**：以 import 接線斷言 ＋ **活體突變自證**（刪 import 改私有複製必紅）＋ **負向 spy**（完成與預覽全程 `deriveDepreciation` 呼叫次數 ＝ **0**）三重證明。
  - **(d)** **`deriveDepreciation` 行為凍結**：`backend/test/unit/depreciation-engine.test.ts` 之既有 `deriveDepreciation` 測試（含 `10/3/3 → perKmUnitPrice="1.1111"` kill case）**零改動、零 skip、全綠**——此即行為未變之機械證明。
  - **(e)** 推導失敗（車價或年限 ≤0；理論不可達，建立端點已擋）之處置**沿 AC-18**：視同缺參數，`details.missing` 追加 `"DEPRECIATION_DERIVATION_FAILED"`，**絕不 500、絕不以每年費用 0 完成、絕不寫入任何快照**，訊息與缺版本情形**逐字互異**。

- **AC-50 公務比例（顯示值，不參與金額）**（來源：BE-US-17 修訂後第 1 條、FE-US-18 第 2 條、連帶 C、Q3）——
  - **(a)** `ratio = officialKm ÷ annualTotalKm`，**全精度 `Prisma.Decimal`，不取整**。
  - **(b)** 對外顯示字串：`ratio`（**6 位小數**）與 `ratioPercent`（**4 位小數**＝ `ratio × 100`）——**逐字比照 `MaintenanceApplication` 之既有精度組**（`snapshotRatio Decimal(9,6)`、`ratioPercentString` 4dp）。
  - **(c)** **比例絕不參與金額計算**：`rawAmount` 一律以 `annualDepreciation × officialKm ÷ annualTotalKm` 之**先乘後除**求值，**不得**寫成 `annualDepreciation.times(ratio)`。**kill case**：`.times(ratio)` mutant 必紅（006 T2R SF-1 已證此路徑可差 1 元；若 R2 之窮舉搜尋在合法值域內證明差異不可達，則以**原始碼層結構性斷言**「實作不得出現 `.times(ratio)`／`.times(ratioString)`」替代，並於 Handoff 說明窮舉範圍與結論）。
  - **(d)** `annualTotalKm ≤ 0` 或非有限值 → `calculable=false`，**絕不除以零、絕不回 `NaN`／`Infinity`、絕不靜默回 0**（005a T2 SF-1／006 T2R MF-1 同型陷阱）。

- **AC-51 修訂後補貼公式與取整層級**（來源：BE-US-17 修訂後第 2、5 條逐字；取代 AC-19／AC-20）——
  - **(a)** 公式（§20.4.1 逐字）：`rawAmount = annualDepreciation × officialKm ÷ annualTotalKm`；`amount = ROUND_HALF_UP(rawAmount, 0)`。**全程 `Prisma.Decimal`，禁止任何浮點中介**；`annualDepreciation` 以 `new Prisma.Decimal(字串)` 還原，**不得**經 `Number()`／`parseFloat`。
  - **(b)** **取整層級**：本 Phase 之取整**恰一處**（最終金額）。每年折舊費用之 2dp 取整發生在**引擎內**（`deriveAnnualDepreciation`，BE-US-14 之契約），不屬本 Phase；**不得**先取整比例、**不得**先取整 `officialKm`、**不得**先取整 `rawAmount` 至 2 位。
  - **(c)** **kill case（已由 spec-writer 實際驗算，見 §20.4.3）**：`annualDepreciation="100000.00"`、`officialKm="1001.66"`、`annualTotalKm="12345.6"` → `rawAmount = 8113.4979263867288751` → `amount = 8113`。四種 mutant 各須至少一條測試**必紅**：先取整比例至 6dp → `8114`；先取整比例至 4dp → `8110`；先取整 `rawAmount` 至 2dp → `8114`；先取整 `officialKm` 至整數 → `8116`。
  - **(d)** 原始碼層掃描：實作中 `toDecimalPlaces(0, …)` **恰一次**（最終金額）。

- **AC-52 公務比例 > 100% 擋完成**（來源：FE-US-18 第 4 條、FE-US-20 第 2 條、BE-US-17 第 3 條、連帶 A、Q4）——
  - **(a)** `officialKm > annualTotalKm` → blocker **`OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM`**（**400 `VALIDATION_ERROR`** ＋ `fields[{ field: "annualTotalKm" }]` ＋ `details.blockers[]`），訊息提示檢查年度總里程。
  - **(b)** **邊界**：`officialKm == annualTotalKm`（比例恰 100%）→ **允許完成**（Q4）；`officialKm` 恰大 `0.01` → 擋（**雙側 mutant 殺**：`>` 改 `>=` 必紅、改 `>` 為恆 `false` 必紅）。
  - **(c)** 比較一律以 `Decimal` **直接比較兩里程值**，**不得**以取整後之 `ratio` 或 `ratioPercent` 比較（沿 006 `isOfficialKmExceedsInterval` 之既有紀律；判定式為**單一事實來源**，service 層不得就地重寫）。
  - **(d)** **三處一致**：草稿 DTO、預覽端點、完成端點對同一 fixture **同步暴露**該 blocker 且 `computed.calculable=false`——禁止「預覽說可以、完成才擋」之反模式（005a SF-2／006 D10(a) 同型）。

- **AC-53 未輸入年度總里程之處置**（來源：FE-US-17 第 6 條、FE-US-18 第 6 條＝S-1【建議】、FE-US-20 第 3 條、BE-US-17 第 4 條、裁定 E）——
  - **(a)** **草稿寬容**：`annualTotalKm` 為 `null`／缺省時，草稿建立與更新皆成功（**201／200**）。
  - **(b)** **預覽提示**：`computed.calculable=false` ＋ `blockingCodes` 含 **`ANNUAL_TOTAL_KM_REQUIRED`**；`amount`／`rawAmount`／`ratio` 皆為 `null`。
  - **(c)** **完成擋下**：完成端點 → **400 `VALIDATION_ERROR`** ＋ `fields[{ field: "annualTotalKm" }]` ＋ `details.blockers[]`；**零寫入**（`status` 仍 `DRAFT`、全部快照欄仍 `null`）。
  - **(d)** **前端不得顯示金額 0 元**：畫面顯示「無法計算」類 zh-TW 說明，**不得**渲染 `0`（以「畫面文字不含金額 0」之負向斷言固定）。
  - **(e)** **防禦層**：純函式層另有 **`ANNUAL_TOTAL_KM_INVALID`**（`≤0` 或非有限值）之 blocker——經 API 路徑因 AC-47(c) 之當場 400 而**結構性不可達**，僅以單元測試覆蓋（保守失敗紀律，不得因不可達而移除）。

#### C′. 證明選填、快照與模型判別

- **AC-54 折舊證明改為選填（語意反轉）**（來源：FE-US-19 修訂後第 3 條逐字、裁定②）——
  - **(a)** 零 `LINKED` 附件之草稿 → **完成成功（200）**，快照完整寫入、狀態轉 `COMPLETED`。
  - **(b)** **`DEPRECIATION_ATTACHMENT_REQUIRED` 完全退場**：任何回應之 `blockingCodes`／`details.blockers[]` 皆不含該碼；**後端 `src` 全庫結構性掃描該字面值命中數 ＝ 0**（含 blocker 純函式、service、route、前端文案表）。
  - **(c)** **上限 5 仍生效**（AC-23 不變）：第 6 張 → 409 `TOO_MANY_ATTACHMENTS`。
  - **(d)** **完成後鎖定仍生效**（AC-25 不變）：已完成折舊之證明不可刪除（403）。
  - **(e)** 完成流程之**附件計數查詢**（`FOR UPDATE` 後 tx 內 `count`）不再作為 blocker 來源；若實作因此移除該查詢，須以 AC-25／AC-26 之既有測試證明附件鎖定與授權**零回歸**。

- **AC-55 修訂後快照欄位（9 欄）**（來源：BE-US-18 修訂後第 3 條逐字、Q5＝S-4【建議】、E-8【擴張】；取代 AC-28）——
  - **(a)** 完成時寫入 **9 欄**：`snapshotVehiclePrice`／`snapshotUsefulLifeYears`／**`snapshotAnnualDepreciation`**／`snapshotOfficialKm`／**`snapshotAnnualTotalKm`**／**`snapshotRatio`**／`snapshotRawAmount`／`calculatedAt`／`depreciationParameterVersionId`；最終金額落既有 `Application.totalAmount`（`Int`），**不重複持久化**。
  - **(b)** **舊二欄恆 `null`**：`snapshotEstimatedAnnualKm`／`snapshotPerKmUnitPrice` 於新模型列**絕不寫入**（明文 DB 層斷言；mutant「順手寫入」必紅）。
  - **(c)** 快照寫入**顯式定精度**（`toFixed(scale)` 後以字串建構 `Decimal`，防裁尾零與二次取整；T1 FW-3：Postgres 對超 scale 小數**靜默四捨五入不報錯**，故服務層定精度為承重需求）。
  - **(d)** **`amount` 不得由 `rawAmount` 反推**；快照之三來源值（`snapshotAnnualDepreciation`／`snapshotOfficialKm`／`snapshotAnnualTotalKm`）行內重算須**逐位元**還原 `snapshotRawAmount` 與 `totalAmount`。
  - **(e)** `snapshotRatio` 為**顯示與對帳用**，**不得**成為 `totalAmount` 之重算來源（(d) 之重算路徑不得經過它）。

- **AC-56 新舊模型之判別（不可省略）**（來源：Q7、BE-US-14 修訂後第 3 條＝E-5【擴張】；比照 PHASE-005a Spec §8.4 判別先例）——
  - **(a)** **新模型列**：`snapshotAnnualTotalKm != null`。**舊模型列**：`snapshotPerKmUnitPrice != null` 且 `snapshotAnnualTotalKm == null`。**草稿列**：兩者皆 `null`。
  - **(b)** 完成流程**只寫新模型欄**（AC-55(b)）。
  - **(c)** DTO 以 `snapshot.model ∈ {"CURRENT","LEGACY"}` 如實揭露判別結果（§20.6）；**舊模型列一律以快照原值呈現，不得以新模型重算**（BE-US-14 第 3 條逐字）。
  - **(d)** 測試以 **raw SQL 播種**一列舊模型快照（Prisma client 型別已含新欄，不得用於製造 migration 前之列形狀——T1 **FW-8** 同型義務），斷言其 DTO 之 `model="LEGACY"`、`perKmUnitPrice` 為原值、`annualDepreciation`／`ratio`／`annualTotalKm` 為 `null`，且**不發生任何重算**（spy 零呼叫）。

#### D′. 折舊參數縮欄（凍結式）

- **AC-57 折舊參數端點之縮欄與歷史唯讀**（來源：AD-US-13 修訂後第 1／3／5 條、連帶 B、Q9；比照 PHASE-005a §16 D1(a) 凍結式）——
  - **(a)** `POST /parameters/depreciation` **請求欄位集合縮為** `{ vehiclePrice, usefulLifeYears, effectiveFrom }`：`estimatedAnnualKm` **不再被解析、不再被驗證、不再被持久化**；**夾帶時一律不採用**（新列該欄寫 `NULL`），**不回 400**（§20.13 **D20**，沿全案「夾帶不採用」慣例）。
  - **(b)** 建立成功之回應**不含** `estimatedAnnualKm` 與 `perKmUnitPrice`；**含** `annualDepreciation`（2dp，AD-US-13 第 3 條）。
  - **(c)** `GET /parameters/depreciation` 對**歷史版本**（`estimatedAnnualKm != null`）仍回傳**原值**與其 `perKmUnitPrice`（唯讀，AD-US-13 第 5 條）；對**新版本**該二欄為 `null`。
  - **(d)** 版本不重疊、未來生效、引用保護（BE-US-19）等既有語意**零變更**（`userstory.md` §2 已明示 BE-US-19 不變）。
  - **(e)** **既有 `≤0` 驗證仍適用於車價與年限兩值**（AD-US-13 第 2 條）；`estimatedAnnualKm` 之 `≤0` 驗證隨欄位退場而移除——此為**依 Spec 更新斷言，非弱化測試**（005a D1(a) 原文同型授權）。

#### E′. 前端

- **AC-58 折舊表單之欄位**（來源：FE-US-17 修訂後第 1、4 條＝含 E-1【擴張】）——表單提供**申請年度**、**該車年度總里程**（可輸入）與**證明圖片（選填）**三類輸入；**年度公務里程仍為唯讀顯示，畫面上不存在任何可輸入／覆寫該值之欄位**（負向斷言保留）；年度總里程與年度公務里程之標籤**逐字互異且同時可見**，使兩者來源可被使用者區分。

- **AC-59 揭露面（五值）與負向遮蔽**（來源：FE-US-18 修訂後第 1、2、3、5 條、FE-US-20 第 5 條、連帶 C、Q6；取代 AC-39）——
  - **(a)** 預覽與**完成後詳情**皆顯示五值：**每年折舊費用／年度公務里程／年度總里程／公務比例／補貼金額**，逐字取自後端回應。
  - **(b)** **前端零自算**：mock 回傳刻意互不自洽之值（`amount ≠ annualDepreciation × officialKm ÷ annualTotalKm`），畫面須照顯示（鑑別「前端自行計算」之實作必紅）。
  - **(c)** **負向斷言**：**車價**、**折舊年限**（Q6）、**每公里補助單價**三者於草稿頁與已完成頁**皆不出現**；後端 DTO 亦不回傳（§20.10）。

- **AC-60 比例 >100% 與未輸入總里程之前端行為**（來源：FE-US-18 第 4、6 條、FE-US-20 第 2、3 條）——比例 >100% 時顯示錯誤與「請檢查年度總里程」類提示並**停用完成按鈕**，但**草稿仍可儲存**；未輸入年度總里程時顯示「無法計算」而**非 0 元**（AC-53(d)）；顯示邏輯一律以 **`blockingCodes`** 驅動，不得以 `calculable` 單一旗標決定文案內容（006 T5 FW／T11 教訓）。

- **AC-61 參數維護頁之縮欄與歷史唯讀**（來源：AD-US-13 修訂後第 1、3、5 條、連帶 B）——折舊參數建立表單僅有**車價／折舊年限／生效日期**（「預估年度行駛公里數」輸入欄**不存在**之負向斷言）；預覽顯示**每年折舊費用**、**不顯示每公里補助單價**（負向斷言）；版本列表對**含預估年里程之歷史版本**以**唯讀**顯示其原值與每公里單價，對新版本該二欄顯示「—」。

---

### 20.4 修訂後計算語意（取代 §7.4）

#### 20.4.1 公式（逐字）

```
① version = findEffectiveVersion(allDepreciationVersions, Date(YYYY-01-01))   ← 不變（AC-15）
     null → missing = ["DEPRECIATION"]                                        （AC-16）
② derived = deriveAnnualDepreciation({
       vehiclePrice:    version.vehiclePrice,
       usefulLifeYears: version.usefulLifeYears,
   })                                        ← BE-US-14 修訂後之引擎（AC-49）
     ok:false → missing += "DEPRECIATION_DERIVATION_FAILED"                   （AC-49(e)）
③ annualDepreciation = new Prisma.Decimal(derived.annualDepreciation)   // 2 位小數字串
④ ratio       = officialKm.div(annualTotalKm)                 // 全精度，**僅供顯示與快照**
   ratioString        = ratio.toFixed(6, ROUND_HALF_UP)       // 6 位小數
   ratioPercentString = ratio.times(100).toFixed(4, ROUND_HALF_UP)   // 4 位小數
⑤ rawAmount = annualDepreciation.times(officialKm).div(annualTotalKm)   // **先乘後除**，未取整
⑥ amount    = rawAmount.toDecimalPlaces(0, ROUND_HALF_UP).toNumber()    // 全案唯一取整處
```

> **禁止**（AC-50(c)、AC-51(b)）：以 `annualDepreciation.times(ratio)` 求 `rawAmount`（引入第二次捨入）、先取整 `ratio`、先取整 `officialKm`、先取整 `rawAmount` 至 2 位、對 `annualDepreciation` 二次取整、以浮點運算任一步。
> **除零守門**：`annualTotalKm ≤ 0` 或任一輸入非有限值 → `calculable=false`，其餘欄位 `null`（AC-50(d)）。

#### 20.4.2 取整層級之責任分界

| 層級 | 取整 | 責任 | 依據 |
|---|---|---|---|
| 參數推導 | `每年折舊費用` → **2 位小數** | `deriveAnnualDepreciation`（引擎） | BE-US-14 第 1 條；沿 PHASE-003a D3 之既有 `annualDepreciation` 精度（**零變更**） |
| 申請計算 | `amount` → **整數** | `calculateDepreciation`（本 Phase，**唯一一處**） | BE-US-17 第 5 條 |
| 顯示 | `ratio` 6dp／`ratioPercent` 4dp | 顯示字串，**不回流計算** | Q3；比照 006 既有精度組 |

> **對帳友善之刻意成本（取代舊 §16 D6 之單價誤差條款）**：使用者以畫面顯示之**每年折舊費用（2dp）**自行核算，與系統結果之誤差上界 ＝ `0.005 × 比例 ≤ 0.005` 元——**遠小於**舊模型之 `年度里程 × 0.00005`（2 萬公里約 1 元）。對帳可行性因本次修訂**改善**。

#### 20.4.3 kill case 數對（**spec-writer 已以 `Prisma.Decimal` 實際驗算**）

> 引擎可達性檢查：`annualDepreciation="100000.00"` ＝ `deriveAnnualDepreciation({ vehiclePrice: "300000.00", usefulLifeYears: 3 })` 之實際輸出（已驗）。

**PRIMARY kill case（單一數對同時鑑別四種取整層級 mutant）**

| 項目 | 值 |
|---|---|
| `annualDepreciation` | `100000.00`（車價 `300000.00` ÷ 年限 `3`） |
| `officialKm` | `1001.66` |
| `annualTotalKm` | `12345.6` |
| `ratio`（6dp 顯示） | `0.081135` ／ `ratioPercent` `8.1135` |
| `rawAmount`（全精度） | `8113.4979263867288751` |
| **`amount`（正確）** | **`8113`** |
| mutant A：先取整比例至 **6dp** 再相乘 | `8114` ✗ |
| mutant B：先取整比例至 **4dp** 再相乘 | `8110` ✗ |
| mutant C：先取整 `rawAmount` 至 **2dp** | `8114` ✗ |
| mutant D：先取整 `officialKm` 至**整數** | `8116` ✗ |

**SECONDARY kill case（比例先取整之獨立鑑別；`rawAmount` 恰為 2dp，故 mutant C 於此列不鑑別）**

| 項目 | 值 |
|---|---|
| `annualDepreciation` ／ `officialKm` ／ `annualTotalKm` | `100000.00` ／ `4000.09` ／ `20000.0` |
| `rawAmount` ／ **`amount`** | `20000.45` ／ **`20000`** |
| mutant A（比例 6dp） | `20001` ✗ |

**`ROUND_HALF_UP` kill pair（取代 AC-21 之舊數對）**

| 列 | 輸入（`annualDepreciation` ／ `officialKm` ／ `annualTotalKm`） | `rawAmount` | 正確 `amount` | `ROUND_HALF_EVEN` mutant |
|---|---|---|---|---|
| **row 1（鑑別）** | `100000.00` ／ `4000.10` ／ `20000.0` | `20000.5` | **`20001`** | `20000` ✗ **必紅** |
| **row 2（配對，證 away-from-zero）** | `100000.00` ／ `4000.30` ／ `20000.0` | `20001.5` | **`20002`** | `20002`（不鑑別，作為配對列） |

**邊界正例（防誤殺）**

| 情境 | 輸入 | 結果 |
|---|---|---|
| 比例恰 100%（Q4，允許完成） | `100000.00` ／ `12345.6` ／ `12345.6` | `ratio="1.000000"`、`ratioPercent="100.0000"`、`rawAmount="100000"`、`amount=100000`、**無 `OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM`** |
| 年度公務里程為 0（B-09 不變，允許完成） | `100000.00` ／ `0.00` ／ `12345.6` | `ratio="0.000000"`、`rawAmount="0"`、`amount=0` |

> **R2 之回填義務**：`.times(ratio)` mutant（AC-50(c)）之鑑別數對由 R2 以窮舉搜尋產生並回填本節；若在合法值域內證明不可達，改以原始碼結構性斷言替代並於 Handoff 說明搜尋範圍與結論。**其餘四種 mutant 之數對已由本 Spec 給定，R2 不需再搜尋，但須實跑驗證後於 Handoff 附輸出。**

---

### 20.5 修訂後完成阻擋碼與錯誤合約（取代 §7.5、增補 §7.6）

#### 20.5.1 blocker 表與固定順序

| 順序 | 段 | code | 觸發條件 | `fields[].field` | zh-TW 訊息（推薦） |
|---|---|---|---|---|---|
| 1 | 結構性 | `YEAR_REQUIRED` | `applicationYear` 為 `null` | `applicationYear` | 請選擇申請年度 |
| 2 | 結構性 | **`ANNUAL_TOTAL_KM_REQUIRED`** | `annualTotalKm` 為 `null` | `annualTotalKm` | 請輸入該車年度總里程 |
| 3 | 結構性 | **`ANNUAL_TOTAL_KM_INVALID`** | `annualTotalKm ≤ 0` 或非有限值（**API 路徑結構性不可達**，AC-47(c) 已於欄位層 400；純函式層防禦） | `annualTotalKm` | 年度總里程必須大於 0 |
| 4 | 計算性 | `PARAMETER_NOT_AVAILABLE` | 該年 1/1 無有效折舊參數，或 `deriveAnnualDepreciation` 回 `ok:false` | —（409 路徑） | 該年度尚無有效折舊參數，請聯絡管理員設定 |
| 5 | 計算性 | **`OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM`** | `officialKm > annualTotalKm`（比例 > 100%） | `annualTotalKm` | 年度公務里程大於年度總里程，請檢查年度總里程 |
| 6 | 計算性 | `AMOUNT_OUT_OF_RANGE` | 計算結果超出欄位容量 | — | 計算結果超出可儲存之金額範圍，請聯絡管理員檢查折舊參數 |

**退場**：`DEPRECIATION_ATTACHMENT_REQUIRED`（裁定②；AC-54(b) 之結構性掃描守門）。

> **兩段式紀律（不變）**：結構性（1~3）先算；非空即拒絕、**不查詢**年度里程與參數。全通過才執行里程與參數查詢，再算 4~6 並二次判定。純函式以 `officialKm?: Decimal | null`、`annualDepreciation?: Decimal | null` 表達「尚未查詢」而**不**產生第 4~6 項。
> **互斥關係（更新 §7.5 之「完整清單之定義」）**：第 2 與第 3 項互斥（`null` vs `≤0`）；第 4 項與第 5／6 項互斥（無每年費用即無從計算金額與比例）；**第 5 與第 6 項可同時出現**（比例超限之申請其金額仍可能超容量）。故任一回應之 `blockers[]` **至多含兩碼**：`{1, 2|3}` 或 `{4}` 或 `{5, 6}` 之子集。呼叫端**不得**因此自行補算被抑制之項目。
> **不變式（不變）**：`calculable=false ⇒ blockingCodes 至少一項`，以 sweep 測試守護。
> **完成端點之拒絕形狀**：`YEAR_REQUIRED`／`ANNUAL_TOTAL_KM_REQUIRED`／`ANNUAL_TOTAL_KM_INVALID`／`OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM`／`AMOUNT_OUT_OF_RANGE` → **400 `VALIDATION_ERROR`** ＋ `fields[]`（僅具欄位路徑者）＋ `details.blockers[]`；`PARAMETER_NOT_AVAILABLE` → **409**（§16 D5 不變）＋ `details.missing` ＋ `details.applicationYear`。

#### 20.5.2 錯誤碼聯集之異動（**公開契約，REV-PRD-SYNC 移交項 #1**）

| 層 | 異動 | 說明 |
|---|---|---|
| **`ErrorCode` 聯集（`platform/errors.ts`）** | **零異動** | 本修訂**不新增、不移除**任何 `ErrorCode`；**AC-43 之聯集全等斷言與 BOGUS mutant 續存且仍為 `GREEN`**。三個新增 blocker code 為 `Blocker.code`（自由字串），**不是** `ErrorCode` 成員——與既有 `YEAR_REQUIRED`／`AMOUNT_OUT_OF_RANGE`／`MAINTENANCE_ATTACHMENT_REQUIRED` 同層。 |
| **blocker code 聯集（折舊）** | **退場 1**：`DEPRECIATION_ATTACHMENT_REQUIRED`<br>**新增 3**：`ANNUAL_TOTAL_KM_REQUIRED`、`ANNUAL_TOTAL_KM_INVALID`、`OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM` | 屬**公開契約**（前端據以顯示文案）。`phase7-contract.test.ts` 之折舊錯誤合約 describe 須同步更新（**依 Spec 更新斷言，非弱化測試**）。 |
| **`details.missing` 之值域** | 零異動 | `["DEPRECIATION"]` 與追加碼 `"DEPRECIATION_DERIVATION_FAILED"` 沿用（AC-49(e)）。 |

---

### 20.6 修訂後 API contract（取代 §7.1 折舊列與 §7.2）

**端點總表之異動**：路徑集合**零變更**（七個端點不增不減）。唯一異動為 `POST /applications/depreciation/preview` 之請求 body 新增 `annualTotalKm`。

```
POST /applications/depreciation/preview
  body: { applicationYear: number | null, annualTotalKm: number | string | null, ownerId?: string }
```

```
DepreciationApplicationDto {
  id, type: "DEPRECIATION", status, ownerId, ownerDisplayName, createdById,
  onBehalf, primaryDate, createdAt, updatedAt                    // ← 全部不變

  applicationYear: number | null            // 不變
  annualTotalKm:   string | null            // ★ 新增：1 位小數字串（使用者申報之申請資料）

  duplicateYearNotice: { count, hasCompleted } | null             // 不變
  attachments: AttachmentDto[]                                    // 不變
  completionBlockers: Blocker[] | null                            // 不變（碼集見 §20.5.1）
  computed:  DepreciationComputedDto | null
  snapshot:  DepreciationSnapshotDto | null
}

DepreciationComputedDto {
  calculable: boolean
  annualDepreciation: string | null   // ★ 新增：2 位小數（deriveAnnualDepreciation 逐字）
  officialKm:   string | null         // 不變：2 位小數
  officialApplicationCount: number | null   // 不變（僅供顯示，AC-13）
  annualTotalKm: string | null        // ★ 新增：1 位小數（申請資料原樣回傳）
  ratio:        string | null         // ★ 新增：6 位小數（顯示用）
  ratioPercent: string | null         // ★ 新增：4 位小數（顯示用）
  rawAmount:    string | null         // 不變：4 位小數，取整前
  amount:       number | null         // 不變：新臺幣整數
  blockingCodes: string[]             // 不變
  // ✗ 移除：perKmUnitPrice
}

DepreciationSnapshotDto {
  model: "CURRENT" | "LEGACY"         // ★ 新增：AC-56 判別結果（由 snapshotAnnualTotalKm 推導）
  // ── 新模型欄（LEGACY 列為 null）──
  annualDepreciation: string | null   // 2 位小數
  annualTotalKm:      string | null   // 1 位小數
  ratio:              string | null   // 6 位小數
  ratioPercent:       string | null   // 4 位小數
  // ── 舊模型欄（CURRENT 列為 null；BE-US-14 第 3 條：原值呈現、不得重算）──
  perKmUnitPrice:     string | null   // 4 位小數
  // ── 兩模型共有 ──
  officialKm:  string                 // 2 位小數
  rawAmount:   string                 // 4 位小數
  totalAmount: number                 // 整數（＝ Application.totalAmount）
  calculatedAt: string                // ISO8601
}
```

> **揭露面不變式（更新 §7.2 之註）**：三型 DTO **皆不含** `vehiclePrice`／`usefulLifeYears`／`estimatedAnnualKm`／`depreciationParameterVersionId`（Q6 將 `usefulLifeYears` 之遮蔽固化為契約——**每年折舊費用 × 年限 ＝ 車價**，僅遮蔽車價無法達成裁定 (C) 之意圖）。以 **DTO 鍵集封閉斷言**守門。
> **傳輸紀律不變**：金額與里程一律以**字串**傳輸，下游以 `Decimal(字串)` 還原無損；`amount`／`totalAmount` 為已取整整數，維持 JSON number。

---

### 20.7 資料模型與 M2 migration（取代 §8.2／§8.3；增補 §8.4）

#### 20.7.1 修訂後 schema

```prisma
model DepreciationApplication {
  applicationId String      @id
  application   Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)

  // ── 業務欄位（草稿可為 null；完成後不可變）──
  applicationYear Int?                                  // 不變
  annualTotalKm   Decimal?  @db.Decimal(9, 1)           // ★ 新增：使用者申報之年度總里程（裁定①＋裁定 D）

  // ── 完成快照（BE-US-18 修訂後；9 欄）；一經寫入不可變 ──
  snapshotVehiclePrice       Decimal?  @db.Decimal(12, 2)   // 不變
  snapshotUsefulLifeYears    Int?                            // 不變
  snapshotAnnualDepreciation Decimal?  @db.Decimal(12, 2)   // ★ 新增：每年折舊費用（2dp 來源值）
  snapshotOfficialKm         Decimal?  @db.Decimal(12, 2)   // 不變
  snapshotAnnualTotalKm      Decimal?  @db.Decimal(9, 1)    // ★ 新增：**新舊模型判別欄**（Q7）
  snapshotRatio              Decimal?  @db.Decimal(9, 6)    // ★ 新增：公務比例（比照保養）
  snapshotRawAmount          Decimal?  @db.Decimal(14, 4)   // 不變
  calculatedAt               DateTime?                       // 不變
  depreciationParameterVersionId String?                     // 不變（引用保護，D12）

  // ── 凍結唯讀（舊模型；新申請**恆為 null**，AC-55(b)）──
  snapshotEstimatedAnnualKm  Int?                            // 保留，不再寫入
  snapshotPerKmUnitPrice     Decimal?  @db.Decimal(14, 4)    // 保留，不再寫入

  @@index([applicationYear])
  @@index([depreciationParameterVersionId])
}

model DepreciationParameterVersion {
  id                String   @id @default(cuid())
  vehiclePrice      Decimal  @db.Decimal(12, 2)
  usefulLifeYears   Int
  estimatedAnnualKm Int?     // ★ 變更：NOT NULL → NULLABLE（凍結欄；新版本恆 null，歷史列原值保留）
  effectiveFrom     DateTime @db.Date
  createdById       String
  createdAt         DateTime @default(now())

  @@unique([effectiveFrom])
  @@index([effectiveFrom])
}
```

#### 20.7.2 容量與精度之推導依據（增補 §8.3 表）

| 欄位 | 型別 | 容量上界 | 依據 |
|---|---|---|---|
| `annualTotalKm`／`snapshotAnnualTotalKm` | **`Decimal(9,1)`** | 絕對值 < `1e8` | 裁定 D（小數 1 位）＋ Q1（比照既有里程欄慣例）；整數位 8 位**恰與既有 `KM_MAGNITUDE_LIMIT`（1e8）及 `parseDecimalField` 之容量文案「整數部分最多 8 位」逐字一致**——複用既有驗證管線，不新增第二套容量心智模型 |
| `snapshotAnnualDepreciation` | **`Decimal(12,2)`** | 絕對值 < `1e10` | 與來源 `DepreciationParameterVersion.vehiclePrice` **逐字一致**；年限 ≥1 ⇒ 每年費用 ≤ 車價，故不產生新容量缺口 |
| `snapshotRatio` | **`Decimal(9,6)`** | 絕對值 < `1e3` | 與 `MaintenanceApplication.snapshotRatio` **逐字一致**（同型比例分攤） |
| `snapshotOfficialKm`／`snapshotRawAmount`／`Application.totalAmount` | 不變 | 不變 | §8.3 既有列 |
| `snapshotPerKmUnitPrice` | 保留 `Decimal(14,4)` | — | **退出容量 predicate 之判定集合**（新模型不寫入） |

> **容量守門仍為必要（更新 §8.3 容量缺口 #2）**：新公式下 `rawAmount = annualDepreciation × ratio`，比例 >100% 已由 AC-52 擋下，故 `rawAmount < 1e10` 恆成立、`snapshotRawAmount` 之溢位**不再可達**；但 **`amount` 仍可超 `int4`**（車價 ≥ 2.15e9 且比例接近 1 時），故 `AMOUNT_OUT_OF_RANGE` 之守門與測試**一律保留**（AC-22 續存）。容量 predicate 之判定集合更新為：`snapshotOfficialKm`、`snapshotAnnualTotalKm`、`snapshotAnnualDepreciation`、`snapshotRatio`、`snapshotRawAmount`、`totalAmount`；閾值一律**由 schema 精度推導之具名常數**（零魔術數，T1 AR-6／FW-1 紀律不變，含常數↔實際 DDL 之對照測試）。

#### 20.7.3 M2 migration（**ALTER 型**）

```sql
-- M2（修訂段）
ALTER TABLE "DepreciationApplication"
  ADD COLUMN "annualTotalKm"              DECIMAL(9,1),
  ADD COLUMN "snapshotAnnualDepreciation" DECIMAL(12,2),
  ADD COLUMN "snapshotAnnualTotalKm"      DECIMAL(9,1),
  ADD COLUMN "snapshotRatio"              DECIMAL(9,6);

ALTER TABLE "DepreciationParameterVersion"
  ALTER COLUMN "estimatedAnnualKm" DROP NOT NULL;
```

- **零 `DROP COLUMN`、零回填、零 enum 異動、零索引異動**；**業務表總數不變（15）**——`infra001-isolation-self-check.test.ts`／`phase6-migration-safety.test.ts` 之表數斷言（T1 即審實查之 **4 個斷言點**）**零改動**。
- **可逆性（部分不可逆，須明文揭露）**：`DROP COLUMN` ×4 會**永久遺失**新模型申請之業務欄與快照；`SET NOT NULL` 之還原**前提為 `estimatedAnnualKm` 無 `NULL` 列**，若已建立新版本則須先回填或刪除該批版本。詳見 §20.15。
- **安全網測試（T1 FW-8 硬性義務）**：`phase7-migration-safety.test.ts` 之既有 fixture 手法「僅在純 `CREATE` 前提下安全」；M2 為 **ALTER 型**，其「既有列逐欄零改寫」之 fixture **必須改以 raw SQL 寫入**（不得經 Prisma client——client 型別已含新欄，無法製造 migration 前之列形狀）。此 fixture 同時作為 **AC-56(d)** 之舊模型列來源。
- **安全網斷言**：八表逐欄零改寫（新增之 4 欄於既有列一律 `NULL`）、鍵集全等（**多餘 `ADD COLUMN` mutant 必紅**）、enum 聯集全等、精度往返（`Decimal(9,1)`／`Decimal(9,6)`／`Decimal(12,2)` 各寫入邊界值後讀回**逐位元相等**）、`migrate deploy` 於乾淨／既有 DB 各一輪且冪等。

#### 20.7.4 新舊模型判別（Q7；比照 PHASE-005a §8.4）

- **新模型列**：`snapshotAnnualTotalKm != null`。
- **舊模型列**：`snapshotPerKmUnitPrice != null` 且 `snapshotAnnualTotalKm == null`。
- **草稿列**：兩者皆 `null`。
- 完成流程**只寫新模型欄**（AC-55(b)）；`reference-guard.ts` 之 `parameterHasReferences("DEPRECIATION")` 依 `depreciationParameterVersionId` 判定，**兩模型皆適用，零變更**（AC-33 續 `GREEN`）。
- **與裁定 F 之關係（不衝突）**：Q7 之「不刪除」約束的是**程式對舊模型列之處置**（不遷移、不重算、唯讀相容）；Q7 原文同時附款「dev／Gate 環境之測試資料由人類視需要重建」——**裁定 F 即為人類行使該附款**（清空 dev 之合成舊資料，R13）。故程式面保留判別與唯讀相容（AC-56），環境面清空（R13），兩者並存。

#### 20.7.5 折舊參數版本之縮欄（Q9；REV-PRD-SYNC 移交項 #2）

| 面向 | 處置 | 依據 |
|---|---|---|
| DB 欄位 | `estimatedAnnualKm` **保留**、轉 **nullable**；新版本寫 `NULL`，歷史列原值不動 | 連帶 B「歷史版本唯讀保留」；§20.13 **D21** |
| 建立端點 | 不解析、不驗證、不持久化該欄；**夾帶不採用**（不回 400） | Q9「不再接受」＋全案「夾帶不採用」慣例；§20.13 **D20** |
| 建立回應 | 不含 `estimatedAnnualKm`／`perKmUnitPrice`；含 `annualDepreciation` | AD-US-13 第 3 條 |
| 查詢端點 | 歷史版本回原值與 `perKmUnitPrice`（唯讀）；新版本該二欄 `null` | AD-US-13 第 5 條 |
| `parameter-service.createDepreciationVersion` | 簽章之 `estimatedAnnualKm` **保留為 optional**（`number \| null`，預設 `null`） | **005a T3b 硬性約束同型**——使約 30 處直呼 service／直寫 `prisma.depreciationParameterVersion` 之既有測試**零改動**；§20.13 **D22** |
| `deriveDepreciation`（每公里單價引擎） | **行為凍結**：函式保留、既有測試零改動、**申請路徑零呼叫**；僅供舊模型快照之歷史顯示與 003a 既有測試 | 連帶 B「推導單價自介面退場」；AC-49(c)(d) |

---

### 20.8 Data Flow 修訂（取代 §9.2／§9.3）

#### 20.8.1 補貼預覽（唯讀路徑）

```
POST /applications/depreciation/preview
  → resolveOwnerId(actor, body.ownerId)                    [不變：一般使用者帶他人 → 403]
  → 欄位驗證（applicationYear ＋ **annualTotalKm**）→ 400   [AC-47]
  → applicationYear == null → calculable=false + [YEAR_REQUIRED]，**不查 DB**
  → annualTotalKm == null  → calculable=false + [ANNUAL_TOTAL_KM_REQUIRED]，**不查 DB**   ★新增
  → sumOfficialMileage(prisma, { ownerId, YYYY-01-01, YYYY-12-31 })   [不變，唯讀]
  → findMany(DepreciationParameterVersion) → findEffectiveVersion(YYYY-01-01)   [不變]
  → deriveAnnualDepreciation({ vehiclePrice, usefulLifeYears })       ★改：不再呼叫 deriveDepreciation
  → calculateDepreciation({ annualDepreciation, officialKm, annualTotalKm })   ★改
  → 比例守門（officialKm > annualTotalKm → blocker）＋ 容量判定 → DepreciationComputedDto
```
**零寫入不變式（不變）**：預覽路徑絕不寫入任何資料列，須有測試證明。

#### 20.8.2 完成與快照寫入

```
POST /applications/:id/complete   （DEPRECIATION 分派）
  → 嚴格 actor.id === ownerId                                [不變，D9]
  → SERIALIZABLE tx（重試）：
       ① SELECT ... FOR UPDATE；assertTransition → 非 DRAFT → 403        [不變]
       ② blockers = computeDepreciationBlockers({ applicationYear, annualTotalKm })
          ★改：**附件計數不再進入 blocker 判定**（裁定②；AC-54(e)）
          非空 → 400 VALIDATION_ERROR + fields[] + details.blockers[]
       ③ { totalKm, applicationCount } = sumOfficialMileage(tx, {...})   [不變]
       ④ version = findEffectiveVersion(findMany(tx), YYYY-01-01)        [不變]
          null → 409 PARAMETER_NOT_AVAILABLE
          derived = deriveAnnualDepreciation(version) ; ok:false → 409（訊息互異）   ★改
       ⑤ result = calculateDepreciation({ annualDepreciation, officialKm: totalKm, annualTotalKm })
          比例守門（AC-52）＋ 容量守門（AC-22）→ blocker → 400，**寫入前**拒絕   ★改
       ⑥a DepreciationApplication.update(**9 個快照欄**，顯式定精度；舊二欄不寫)   ★改
       ⑥b Application.update(status=COMPLETED, totalAmount, completedAt)   [不變]
  → 回應 DTO（含 snapshot.model="CURRENT"）
```
> **②與③④之順序仍不可對調**（結構性條件未過時不查詢里程與參數）。
> **草稿與預覽即暴露不可計算狀態**（blocker ＋ `calculable=false`）之反模式禁令**不變**，並擴及新增之三碼（AC-52(d)、AC-53(b)）。

#### 20.8.3 草稿儲存（§9.1 之增補）

`PUT /applications/depreciation/:id` 之更新欄位集合由 `{ applicationYear }` 擴為 `{ applicationYear, annualTotalKm }`；`primaryDate` 推導**僅依 `applicationYear`**（不受年度總里程影響）；附件對帳、稽核 hook、交易紀律**零變更**。

#### 20.8.4 附件容器狀態推導（§9.4）

**零變更**——`deriveContainerState` 之 `DEPRECIATION` 分支與 `deleteApplication` 之 detach 範圍不因證明改選填而變（AC-25／AC-26 續 `GREEN`）。

---

### 20.9 五態與邊界增補

**§4 五態之修訂列**

| 狀態 | 修訂內容 |
|---|---|
| **Empty** | 拆為**兩種不同狀態**：①**年度無任何有效差旅**（`officialKm="0.00"`、`annualTotalKm` 已填）→ 顯示 `0.00 公里`、比例 `0.0000%`、**補貼金額 0**＋說明文字，**非錯誤、完成仍可執行**（§1.2 不變）；②**尚未輸入年度總里程** → 顯示「無法計算」＋提示，**不得顯示金額 0**（AC-53(d)）。兩者測試須各自存在（AC-40）。 |
| **Error** | 新增觸發：年度總里程格式／值域錯（400，就地標示欄位）、比例 >100%（blocker，提示檢查年度總里程） |
| **Success** | 完成後顯示**五值**（AC-59(a)） |

**§5 邊界條件之增補與修訂**

| # | 情境 | 預期行為 | 對應 AC |
|---|---|---|---|
| B-36 | `annualTotalKm` 為 `null`（草稿） | 允許保存；`calculable=false` ＋ `ANNUAL_TOTAL_KM_REQUIRED`；完成 400 | AC-53 |
| B-37 | `annualTotalKm` 為 `0`／負數 | **當場 400**（裁定 E），不入庫 | AC-47(c) |
| B-38 | `annualTotalKm` 為 `12345.67`（2 位小數） | **400**（裁定 D，最多 1 位）；`12345.6`／`12345` 通過 | AC-47(b) |
| B-39 | `annualTotalKm` 恰 `99999999.9` ／ `100000000` | 前者通過、後者 400（容量四點邊界） | AC-47(d) |
| B-40 | `officialKm == annualTotalKm`（比例恰 100%） | **允許完成**（Q4）；`ratio="1.000000"` | AC-52(b) |
| B-41 | `officialKm` 大於 `annualTotalKm` `0.01` | 擋完成（`OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM`），草稿仍可存 | AC-52 |
| B-42 | 零附件之草稿完成 | **200 完成成功**（裁定②反轉；原 B 段「完成須 ≥1」退場） | AC-54(a) |
| B-43 | 附件恰 5 張再加第 6 張 | 409 `TOO_MANY_ATTACHMENTS`（**不變**） | AC-23 |
| B-44 | 舊模型已完成列（raw SQL 播種） | DTO `model="LEGACY"`、`perKmUnitPrice` 原值、新模型四欄 `null`、**零重算** | AC-56 |
| B-45 | 車價 `9999999999.99`／年限 1／比例接近 1 | `annualDepreciation ≈ 1e10` → `amount` 超 `int4` → `AMOUNT_OUT_OF_RANGE`（非 500、非截斷） | AC-22 |
| B-19（修訂） | 原「車價 1e10／年限 1／年里程 1 → 單價超 `Decimal(14,4)`」 | **不再可達**（每公里單價退出計算）；由 **B-45** 取代 | AC-22 |
| B-10（修訂） | 原「單價為 `0.0000`」 | 改述為「年度公務里程 > 0 但每年折舊費用極小 → 補貼可為 0 元，**非錯誤**」 | AC-51 |
| B-09／B-13～B-18／B-20～B-35 | **不變** | — | — |

---

### 20.10 權限與揭露面修訂（取代 §6.3 之揭露段）

**§6.1 授權矩陣（40 格）零變更**——端點集合、五身分判定、`resolveOwnerId` 紀律、判定順序（403 先於 400）全部不變。

**§6.3「推導三值不外露」之修訂（D8 之取代）**

| 值 | 修訂前 | **修訂後** | 依據 |
|---|---|---|---|
| 每年折舊費用 | 不外露 | **可見**（DTO 回傳＋畫面顯示） | 連帶 (C)；FE-US-18 第 1、5 條 |
| 每公里補助單價 | 可見 | **退場**（新模型不存在；舊模型列之快照原值仍回傳，BE-US-14 第 3 條） | 裁定①；連帶 (B) |
| **車價** | 不外露 | **不外露（不變）** | 連帶 (C)「車價本身仍不顯示」 |
| **折舊年限** | 不外露 | **不外露（固化為契約）** | **Q6**：每年費用 × 年限 ＝ 車價，僅遮蔽車價無法達成裁定意圖 |
| 預估年度行駛公里數 | 不外露 | **不外露（且新模型不再持久化於快照）** | 裁定①、連帶 B |
| 參數版本 id | 不外露 | 不外露（不變） | D8 |

> **真實隔離而非 UI 遮蔽（不變）**：`GET /parameters/depreciation` 維持**管理員限定**（既有行為，零改動），故一般使用者無法由任何 API 取得車價與年限。以 **DTO 鍵集封閉斷言**守門（AC-59(c) 為其前端對應）。
> **年度總里程之揭露面**：為使用者**自己申報**之資料，回傳給本人與管理員不構成任何授權擴張；預覽端點之 `ownerId` 判定沿 `resolveOwnerId`（AC-14 不變）。

---

### 20.11 測試策略與既有測試遷移清單

#### 20.11.1 紀律（§11.0 全數續用）

TDD（先紅後綠、Handoff 附修復前紅燈實際輸出）、禁止刪除／弱化／`skip` 既有測試換綠燈、金額類精確等值、每個關鍵規則須有 mutant 自證、INFRA-001 併跑限制、新增 src 檔須同步入結構性掃描清單、**禁止 spawn 任何 subagent**。

> **「測試遷移」之定義與界線（本修訂段之關鍵紀律）**：依已批准之 US 修訂而更新既有測試之**斷言內容**（例如「完成須 ≥1」反轉為「零附件可完成」），屬 **Spec 授權之測試遷移，不是弱化測試**（005a D1(a) 原文同型授權）。但——
> - **每個 R Task 之 Packet 須逐檔列出**其被授權遷移的測試檔與 describe；
> - implementer **不得自行擴大**至清單外之檔案；發現清單外檔案受影響 → **BLOCKED 回報**，不得私改（005a **REV2 漏檔事件**教訓：搜尋結果截斷曾使「封閉清單」失真）；
> - Handoff 須附**測試增／刪／改計數**與「無任何測試被刪除／`skip`／弱化」之聲明。

#### 20.11.2 既有測試之受影響逐檔清單（**依 `grep` 實查產出；R Task 執行時須逐檔複驗**）

> 實查指令（可重跑）：`grep -rl "estimatedAnnualKm" --include="*.ts" --include="*.tsx" backend/src backend/prisma backend/test frontend/src frontend/test e2e`（31 檔命中）＋逐檔交叉核對 `parameters/depreciation` HTTP 命中數。

| 檔案 | 受影響原因 | 授權遷移之 Task |
|---|---|---|
| `backend/prisma/schema.prisma` | 新增 4 欄 ＋ `estimatedAnnualKm` 轉 nullable | **R1** |
| `backend/prisma/migrations/*`（新增 1 目錄） | M2 | **R1** |
| `backend/test/integration/phase7-migration-safety.test.ts` | 欄位集合、精度往返、**FW-8 raw SQL fixture** | **R1** |
| `backend/src/applications/depreciation-calculation.ts` | 公式改造、ratio、容量常數集合 | **R2** |
| `backend/test/unit/depreciation-calculation.test.ts` | AC-19/20 退場、AC-21/22 改組、AC-50/51 新增 | **R2** |
| `backend/src/applications/depreciation-blockers.ts` | 退場 1 碼、新增 3 碼、兩段式重排 | **R3** |
| `backend/test/unit/depreciation-blockers.test.ts` | 同上 | **R3** |
| `backend/src/parameters/depreciation-engine.ts` | 新增 `deriveAnnualDepreciation`（共用內部推導）；`deriveDepreciation` **行為零變更** | **R4a** |
| `backend/test/unit/depreciation-engine.test.ts` | **既有 `deriveDepreciation` describe 零改動（凍結證明）**；新增 `deriveAnnualDepreciation` describe | **R4a** |
| `backend/src/parameters/parameter-validation.ts` | 折舊驗證縮為兩值 | **R4b** |
| `backend/src/parameters/parameter-service.ts` | `estimatedAnnualKm` 轉 optional（**簽章保留**，D22）；折舊預覽改用 `deriveAnnualDepreciation` | **R4b** |
| `backend/src/parameters/routes.ts` | 請求解析與回應組裝縮欄 | **R4b** |
| `backend/test/unit/parameter-validation.test.ts` | 折舊驗證案例縮欄 | **R4b** |
| `backend/test/integration/phase3a-parameter-depreciation.test.ts`（41 處 HTTP） | AC-57 之主戰場 | **R4b** |
| `backend/test/integration/chore002-d4-decimal-number.test.ts`（1 處 HTTP） | 折舊 POST 之數值型別案例 | **R4c** |
| `backend/test/integration/chore003-parameter-field-capacity.test.ts`（2 處 HTTP） | `estimatedAnnualKm` 之容量案例退場 | **R4c** |
| `backend/test/integration/phase3a-parameter-audit.test.ts`（5 處 HTTP） | 稽核 `summary` 欄位集合縮欄 | **R4c** |
| `backend/src/applications/depreciation-service.ts` | `annualTotalKm` 欄位、DTO 三形狀、computed 組裝、完成流程與快照 | **R5／R6／R7**（依 Packet 逐段授權） |
| `backend/src/applications/routes.ts` | 欄位解析（`annualTotalKm`）、預覽 body、稽核前後值 | **R5／R6／R8** |
| `backend/src/applications/trip-validation.ts` | 新增 `parseAnnualTotalKmField`（複用 `parseDecimalField`，**不新增第二套驗證實作**） | **R5** |
| `backend/test/unit/trip-validation.test.ts` | 新解析器之單元案例 | **R5** |
| `backend/test/integration/phase7-depreciation-draft.test.ts` | AC-02/05/47/48 | **R5** |
| `backend/src/applications/depreciation-parameters.ts` | 改呼叫 `deriveAnnualDepreciation` | **R6** |
| `backend/test/integration/phase7-depreciation-parameters.test.ts` | AC-17 退場→AC-49；AC-51/52 整合層 | **R6** |
| `backend/test/integration/phase7-annual-mileage.test.ts` | **僅播種與 computed 形狀之機械連動**（AC-09~14 語意不變） | **R6** |
| `backend/test/integration/phase7-depreciation-complete.test.ts` | AC-27/30/54/55/56 | **R7** |
| `backend/test/integration/phase7-depreciation-attachment.test.ts` | 「完成須 ≥1」相關斷言反轉；**AC-23/25/26 零改動** | **R7** |
| `backend/test/integration/phase7-contract.test.ts` | blocker code 聯集異動；**AC-43 `ErrorCode` 聯集斷言零改動** | **R7** |
| `backend/test/integration/phase7-snapshot-immutability.test.ts` | AC-31/32/48 | **R8** |
| `backend/test/integration/phase7-on-behalf.test.ts` | AC-35 之前後值摘要 | **R8** |
| `frontend/src/pages/DepreciationApplicationPage.tsx`、`frontend/src/api/depreciation.ts`、`frontend/src/types/api.ts` | 新欄、五值、blocker 文案 | **R9／R10** |
| `frontend/test/DepreciationApplicationPage.test.tsx` | AC-38/39/40/41/42/53/58/59/60 | **R9／R10** |
| `frontend/src/pages/ParametersPage.tsx`、`frontend/src/api/parameters.ts` | 折舊區塊縮欄 | **R11** |
| `frontend/test/ParametersPage.test.tsx` | AC-61 | **R11** |
| `e2e/depreciation-allowance.spec.ts` | AC-45/46 之流程與播種 | **R12** |

**明示不受影響（實查判定，供終審核對）**：`chore001-d4-decimal-placeholder.test.ts`、`chore003-string-fidelity.test.ts`、`phase3a-parameter-model.test.ts`、`parameter-version-engine.test.ts`（四檔皆**直呼 service 或直寫 prisma、零 HTTP**，受 **D22 簽章保留**保護）；`phase7-application-list.test.ts`（AC-36/37 語意不變）；`mileage-engine.ts`／`mileage-range.ts`／`maintenance-*`／`travel-*`／`completion-blockers.ts`（**零 diff**，Stop Condition 續存）。

#### 20.11.3 測試層級之增補

| 層 | 增補 |
|---|---|
| 單元 | `calculateDepreciation`：新公式四 mutant kill、`.times(ratio)` 鑑別、除零與非有限值三重守門、容量 predicate 新集合邊界；`computeDepreciationBlockers`：六碼順序穩定、三段互斥語意、不變式 sweep；`deriveAnnualDepreciation`：2dp 與 `≤0` 拒絕；`parseAnnualTotalKmField`：1dp／`≤0`／容量 |
| 整合 | M2 安全網（raw SQL fixture）、`annualTotalKm` gate table 雙端點、採用 vs 不採用對照矩陣、比例守門三處一致、零附件完成、9 欄快照三來源重算、舊模型列唯讀、參數縮欄與歷史唯讀 |
| 前端 | 兩輸入欄與唯讀里程之區分、五值逐字、三負向（車價／年限／每公里單價）、>100% 與未輸入之兩種不可計算態、`blockingCodes` 驅動 |
| E2E | 完整走一筆新模型折舊（含輸入年度總里程、**不上傳證明亦可完成**）、管理員改參數後歷史不變、375px 無溢位 |
| 安全 | 授權矩陣 40 格**零變更**之回歸；日誌敏感鍵掃描（AC-44）不變 |

---

### 20.12 修訂段 Task Graph（R1 ~ R13）

> 每 Task 一律 TDD、一個 atomic commit（含 Task ID `PHASE-007-R{n}`）。**規模上限（Packet）：單 Task ≤ 5 AC、≤ 6 檔、不得同時橫跨 FE＋BE＋DB 三層。**
> **Diff 預算與 usage 預算帶依 `docs/retrospective/PHASE-007-usage.md` §3 校準後之型態帶**；逾 diff 預算 50% 須即時回報（Stop Condition）；接線型 usage 拆分線 **~320k** 維持。

| Task | 內容 | 層 | AC（≤5） | 檔案（≤6） | Risk | 依賴 | Diff 預算 | usage 帶 | Done When |
|---|---|---|---|---|---|---|---|---|---|
| **R1** | schema 新 4 欄 ＋ `estimatedAnnualKm` 轉 nullable ＋ **M2（ALTER 型）** ＋ 安全網（**FW-8 raw SQL fixture**） | DB | AC-01 | `backend/prisma/schema.prisma`、`backend/prisma/migrations/*`（≤2）、`backend/test/integration/phase7-migration-safety.test.ts` | **High**（部分不可逆 migration） | — | ~600 | ~110-135k | 乾淨／既有 DB 皆 migrate 成功且冪等；八表逐欄零改寫（新欄於既有列一律 `NULL`）；鍵集全等（多餘 `ADD COLUMN` mutant 必紅）；enum 聯集全等；**表數 15 不變**（4 個既有斷言點零改動之機械證明）；`Decimal(9,1)`／`(9,6)`／`(12,2)` 精度往返逐位元；**FW-8 raw SQL fixture 落地並同時可作 AC-56(d) 之舊模型列來源** |
| **R2** | `calculateDepreciation` 新公式 ＋ `ratio` ＋ 容量 predicate 集合重整 | BE（純函式，零接線） | AC-21, 22(判定層), 50, 51 | `backend/src/applications/depreciation-calculation.ts`、`backend/test/unit/depreciation-calculation.test.ts` | **High**（金額核心） | R1 | ~700 | ~130-155k | §20.4.1 ⑤⑥ 逐字；**§20.4.3 四 mutant 各必紅（實跑輸出附 Handoff）**；`ROUND_HALF_EVEN` mutant 於 row 1 必紅；`.times(ratio)` 鑑別（或結構性斷言＋窮舉結論）；除零／`NaN`／`Infinity` 三重守門；容量常數由 schema 精度推導（零魔術數）＋**常數↔實際 DDL 對照測試（FW-1）**；掃描清單含自證 |
| **R3** | `computeDepreciationBlockers`：退場 1 碼、新增 3 碼、三段互斥重排 | BE（純函式，零接線） | AC-52(判定層), 53(判定層), 54(判定層), 18(判定層) | `backend/src/applications/depreciation-blockers.ts`、`backend/test/unit/depreciation-blockers.test.ts` | **High**（金額守門） | R2 | ~600 | ~130-155k | 六碼順序穩定；三段互斥（`{1,2|3}`／`{4}`／`{5,6}`）；`DEPRECIATION_ATTACHMENT_REQUIRED` 於本檔零殘留；不變式 sweep「`calculable=false ⇒ 至少一 blocker`」；`≤0`／非有限值保守失敗；**附件計數參數移除後，既有呼叫端零殘留引用** |
| **R4a** | `deriveAnnualDepreciation` ＋ 共用內部推導（`deriveDepreciation` 行為凍結） | BE（純函式，零接線） | AC-49(單元層) | `backend/src/parameters/depreciation-engine.ts`、`backend/test/unit/depreciation-engine.test.ts` | **High**（金額上游） | R1 | ~400 | ~100-130k | 2dp 逐字；`≤0` → `ok:false`；**單一內部推導（結構性斷言：`vehiclePrice ÷ usefulLifeYears` 恰一份實作）**；**既有 `deriveDepreciation` describe 零改動全綠（凍結證明，含 `10/3/3 → 1.1111`）** |
| **R4b** | 折舊參數端點縮欄（凍結式）＋ 預覽改用每年費用 | BE | AC-57 | `backend/src/parameters/parameter-validation.ts`、`backend/src/parameters/parameter-service.ts`、`backend/src/parameters/routes.ts`、`backend/test/unit/parameter-validation.test.ts`、`backend/test/integration/phase3a-parameter-depreciation.test.ts` | **High**（**公開 API contract 變更**——事前批准已由連帶 B／Q9 之人類裁定構成） | R4a | ~700 | ~160-200k | 夾帶 `estimatedAnnualKm` **不採用且新列該欄為 `NULL`**（非 400）；回應不含該欄與 `perKmUnitPrice`、含 `annualDepreciation`；`GET` 對歷史版本回原值（唯讀）之正負例；**硬性約束：`createDepreciationVersion` 簽章保留 optional 參數**（D22）——`phase3a-parameter-model`／`chore003-string-fidelity`／`chore001`／`parameter-version-engine` 四檔**零改動且仍綠**之機械證明 |
| **R4c** | 參數縮欄之連動測試遷移（純測試檔） | BE（測試） | AC-57（連動） | `backend/test/integration/chore002-d4-decimal-number.test.ts`、`backend/test/integration/chore003-parameter-field-capacity.test.ts`、`backend/test/integration/phase3a-parameter-audit.test.ts` | Medium | R4b | ~400 | ~105-140k | 三檔全綠；**零刪除**（欄位容量／字串保真／稽核之既有覆蓋面不得因縮欄而淨減——如有覆蓋面流失須於 Handoff 明列並提補償測試）；Handoff 附增／刪／改計數 |
| **R5** | 草稿 CRUD：`annualTotalKm` 解析器、欄位驗證、採用、DTO 三形狀 | BE | AC-02, 05, 47, 48(建立/更新面) | `backend/src/applications/trip-validation.ts`、`backend/src/applications/routes.ts`、`backend/src/applications/depreciation-service.ts`、`backend/test/unit/trip-validation.test.ts`、`backend/test/integration/phase7-depreciation-draft.test.ts` | **High**（授權＋欄位驗證） | R1, R3 | ~900 | ~200-240k | gate table 雙端點全綠；`fields[].field="annualTotalKm"` 明文斷言；**403 先於 400 之既有順序零回歸**；小數 1 位與 `≤0` 當場 400 之四點邊界；**複用 `parseDecimalField`（不新增第二套驗證實作）之結構性證明**；DTO 鍵集封閉（車價／年限／版本 id 不外露） |
| **R6** | 計算接線：`computed` 組裝、預覽端點、比例守門三處一致 | BE | AC-49(整合層), 51(整合層), 52(整合層), 53(整合層), 18(整合層) | `backend/src/applications/depreciation-parameters.ts`、`backend/src/applications/depreciation-service.ts`、`backend/src/applications/routes.ts`、`backend/test/integration/phase7-depreciation-parameters.test.ts`、`backend/test/integration/phase7-annual-mileage.test.ts` | **High**（金額上游接線） | R2, R4a, R5 | ~1000 | ~210-310k（拆分線 320k） | `deriveAnnualDepreciation` import 突變自證必紅 ＋ **`deriveDepreciation` 負向 spy（呼叫數 0）**；PRIMARY kill case 於整合層綠；比例守門於草稿 DTO／預覽／完成**同 fixture 三處一致**；預覽零寫入實證；缺參數三處一致（不變） |
| **R7** | 完成流程 ＋ 9 欄快照 ＋ 證明選填反轉 ＋ 舊模型唯讀 | BE ＋ DB（寫入） | AC-27, 30, 54, 55, 56 | `backend/src/applications/depreciation-service.ts`、`backend/test/integration/phase7-depreciation-complete.test.ts`、`backend/test/integration/phase7-depreciation-attachment.test.ts`、`backend/test/integration/phase7-contract.test.ts` | **High**（不可逆完成／快照） | R6 | ~1100 | ~210-310k | 零附件完成 200 ＋ 快照完整；`DEPRECIATION_ATTACHMENT_REQUIRED` **全 src 掃描命中 0**；9 欄逐位元＋三來源行內重算；**舊二欄恆 `null`（mutant「順手寫入」必紅）**；顯式定精度（FW-3）；交易切點回滾實證（回滾斷言含新增 4 欄）；`P2025` 不得 500；**AC-23/25/26 既有附件測試零弱化** |
| **R8** | 快照不可變 ＋ 後端權威（採用／不採用對照）＋ 代操作稽核前後值 | BE | AC-31, 32, 35, 48(權威面) | `backend/src/applications/routes.ts`（僅 `onUpdated` 稽核摘要）、`backend/test/integration/phase7-snapshot-immutability.test.ts`、`backend/test/integration/phase7-on-behalf.test.ts` | **High**（金額權威） | R7 | ~700 | ~150-205k | fixture 經真實完成流程；**同一請求之採用／不採用對照矩陣**（頂層純量 ＋ DB 層指紋）；9 欄逐位元不變 ＋ spy 零重算（被監視函式為 `deriveAnnualDepreciation`／`sumOfficialMileage`）；稽核 `summary` 含 `annualTotalKm` 前後值且不含敏感鍵 |
| **R9** | 前端：折舊表單新欄 ＋ 五值預覽 ＋ 三負向遮蔽 | FE | AC-38, 58, 59 | `frontend/src/types/api.ts`、`frontend/src/api/depreciation.ts`、`frontend/src/pages/DepreciationApplicationPage.tsx`、`frontend/test/DepreciationApplicationPage.test.tsx` | Medium | R6 | ~900 | ~155-195k | 兩輸入欄＋唯讀里程之標籤逐字互異；**年度公務里程無 textbox 之負向斷言保留**；五值逐字取自後端；零自算鑑別（互不自洽 mock）；車價／年限／每公里單價三負向於草稿頁與已完成頁皆綠 |
| **R10** | 前端：五態、>100%、未輸入不顯 0 元、證明選填 UI | FE | AC-40, 41, 42, 53(前端面), 60 | `frontend/src/pages/DepreciationApplicationPage.tsx`、`frontend/src/index.css`、`frontend/test/DepreciationApplicationPage.test.tsx` | Medium | R7, R9 | ~800 | ~155-195k | **兩種不可計算態各有測試**（Empty 0 元合法 vs 未輸入不顯 0）；`blockingCodes` 驅動文案；>100% 停用完成鈕但草稿可存；**無證明時完成鈕可用**（反轉）；已完成無上傳／刪除入口之負向斷言保留 |
| **R11** | 前端：參數維護頁折舊區塊縮欄 ＋ 歷史唯讀 | FE | AC-61 | `frontend/src/types/api.ts`、`frontend/src/api/parameters.ts`、`frontend/src/pages/ParametersPage.tsx`、`frontend/test/ParametersPage.test.tsx` | Medium | R4b | ~450 | ~120-160k | 預估年里程輸入欄不存在之負向斷言；每公里單價不顯示之負向斷言；歷史版本唯讀顯示原值、新版本顯示「—」；**油資／ETC 區塊零回歸** |
| **R12** | E2E ＋ 響應式 | FE ＋ E2E | AC-45, 46 | `e2e/depreciation-allowance.spec.ts`、`frontend/src/index.css` | Medium | R8, R10, R11, R13 | ~600 | ~185-265k | 全情境綠（大總管親跑於 dev 拓撲）；**流程含輸入年度總里程且不上傳證明即完成**；管理員改參數後金額與五值不變；播種冪等；四畫面 375px 無溢位 |
| **R13** | **裁定 F：清空既有舊公式折舊測試申請**（dev／Gate 環境合成資料） | 資料操作（**零檔案變更**） | —（無 AC，見 §12R 註記） | 無（指令與證據記錄於 Handoff；大總管以 `PROJECT_STATE` 白名單記錄） | **High**（資料刪除不可逆） | R7 | 0 | ~30-50k | 刪除前後**逐列 id 與計數證據**；範圍**限縮**於 `Application.type='DEPRECIATION'` 之列與其 `DepreciationApplication` 子列；其附件一律 **detach 回 `TEMP`**（不留孤兒 `LINKED`）；**`AuditLog` 不刪**（歷史不可逆資產，§14）；**不得**觸及差旅／保養／參數版本任何列；執行後 `SELECT count(*) FROM "DepreciationApplication"` 之結果附 Handoff |

#### 依賴圖

```
R1 ─┬─▶ R2 ──▶ R3 ──┬──────────────▶ R5 ──▶ R6 ──▶ R7 ──┬──▶ R8 ───────┐
    │               │                      ▲             ├──▶ R13 ──────┤
    ├─▶ R4a ────────┴──────────────────────┘             │              │
    │     └──▶ R4b ──┬──▶ R4c                            │              │
    │                └──▶ R11 ───────────────────────────┼──────────────┤
    └────────────────────────────────────────────────────┘              │
                                    R9 ◀── R6                           │
                                     └──▶ R10 ───────────────────────────┴──▶ R12
```

#### 規模上限自查

| Task | AC 數 | 檔數 | 跨層 | 合規 |
|---|---|---|---|---|
| R1 | 1 | 3 | DB only | ✅ |
| R2 | 4 | 2 | BE only（純函式） | ✅ |
| R3 | 4 | 2 | BE only（純函式） | ✅ |
| R4a | 1 | 2 | BE only（純函式） | ✅ |
| R4b | 1 | 5 | BE only | ✅ |
| R4c | 1（連動） | 3 | BE only（純測試） | ✅ |
| R5 | 4 | 5 | BE only | ✅ |
| R6 | 5 | 5 | BE only | ✅ |
| R7 | 5 | 4 | BE ＋ DB（寫入既有表，**無 schema 變更**） | ✅ |
| R8 | 4 | 3 | BE only | ✅ |
| R9 | 3 | 4 | FE only | ✅ |
| R10 | 5 | 3 | FE only | ✅ |
| R11 | 1 | 4 | FE only | ✅ |
| R12 | 2 | 2 | FE ＋ E2E | ✅ |
| R13 | 0 | 0 | 資料操作 | ✅ |

> **無任何 Task 同時橫跨 FE＋BE＋DB 三層；R1 為唯一含 schema/migration 之 Task。**
> **High 風險 Task 清單（須於修訂段 Gate 一併取得事前批准）**：**R1、R2、R3、R4a、R4b、R5、R6、R7、R8、R13** 共 **10 項**。判準沿 CLAUDE.md「認證、授權…一律 High」＋本 Phase 既有升級先例（不可逆 migration、金額核心與上游、授權與欄位驗證、不可逆完成／快照、公開 API contract、不可逆資料刪除）。**此清單為保守方向，不縮減任何既有 High 判定。**
> **TDD 順序**：R1（安全網先建）→ R2/R3（金額與守門純函式）→ R4a（引擎）→ R4b/R4c（參數縮欄）→ R5（草稿欄位）→ R6（計算接線）→ R7（不可逆完成）→ R8（權威）→ R9/R10/R11（前端）→ R13（資料清空）→ R12（E2E）。
> **R13 排序**：必須在 **R7 之後**（新模型完成流程可用）且在 **R12 之前**（E2E 播種不得撞上舊模型殘列）。

---

### 20.13 修訂段決策記錄（D15 ~ D22）

> **D15~D19 為已批准裁定之直接落地**（非待裁定項）；**D20~D22 為 Spec 層技術裁量**（屬「可修改但必須記錄」層級，已於 Handoff 逐項揭露供大總管複核）。

| # | 決策 | 內容 | 依據／理由 |
|---|---|---|---|
| **D15** | 每年折舊費用之來源與引擎處置 | 新增 `deriveAnnualDepreciation`（2dp，共用內部推導）；`deriveDepreciation` **行為凍結**、申請路徑零呼叫、既有測試零改動 | BE-US-14 修訂後第 1、3 條；連帶 B；Q9／Q12（更名不改編號）；005a D1(a) 凍結式先例 |
| **D16** | 公式之乘除順序與比例之角色 | `rawAmount = A × O ÷ I`（**先乘後除**）；`ratio` 僅供顯示與快照，**絕不**回流計算 | BE-US-17 修訂後第 5 條（不得對比例或任何中間值先行取整）；**006 T2R SF-1 反例**（`.times(ratio)` 可差 1 元）；Q3 |
| **D17** | 年度總里程之型別、精度與值域 | `Decimal(9,1)`、絕對值 < `1e8`；小數 > 1 位 → 400；`≤0` → **當場 400**；`null` → 草稿允許、完成擋 | 裁定 D、裁定 E、Q1、Q2；複用既有 `parseDecimalField`／`KM_MAGNITUDE_LIMIT`（零新增容量心智模型） |
| **D18** | 快照欄位集合 | **9 欄**（含車價與年限之保留、`rawAmount`、`calculatedAt`、版本 id）；舊二欄凍結唯讀、新列恆 `null` | BE-US-18 修訂後第 3 條逐字；Q5（＝S-4）；E-8（取整前金額）；§16 D7 之 `calculatedAt`／版本 id 設計續用 |
| **D19** | 新舊模型判別 | `snapshotAnnualTotalKm != null` ⇒ 新模型；DTO 以 `model` 欄如實揭露；舊列唯讀不重算 | **Q7**；PHASE-005a Spec §8.4 判別先例；BE-US-14 第 3 條（＝E-5） |
| **D20** | **【Spec 層裁量】** 參數端點對 `estimatedAnnualKm` 夾帶之處置 | **不採用**（新列寫 `NULL`），**不回 400** | Q9 僅裁定「不再接受／不再回傳」，未指定夾帶時之狀態碼。採「不採用」係沿**全案既有慣例**（AC-02／AC-32「夾帶一律不採用」）；採 400 會對既有公開 contract **新增拒絕面**，屬未經批准之可見行為擴張，故不採。**若大總管認為須人類明示，本項可獨立提請裁定而不阻塞其餘 Task（僅影響 R4b 之一組斷言）。** |
| **D21** | **【Spec 層裁量】** `DepreciationParameterVersion.estimatedAnnualKm` 之欄位處置 | 轉 **nullable**（`ALTER COLUMN DROP NOT NULL`），不新增表、不寫哨兵值、不 `DROP COLUMN` | 連帶 B 要求「新版本只需車價＋年限」＋「歷史版本唯讀保留」，**nullable 是唯一能同時滿足兩者且不造假資料的表示法**；哨兵值會使歷史原值與新版本無法區分（破壞 AC-57(c)）；`DROP COLUMN` 直接違反「歷史唯讀保留」。**代價**：M2 成為 ALTER 型 migration，回滾之 `SET NOT NULL` 需前提條件（§20.15） |
| **D22** | **【Spec 層裁量】** `createDepreciationVersion` 之簽章處置 | `estimatedAnnualKm` 參數**保留為 optional**（`number \| null`，預設 `null`），僅 route 層停止傳入 | **005a T3b 硬性約束同型**（「只移除 route 註冊，service 函式一律保留」）——約 30 處直呼 service／直寫 prisma 之既有測試因此**零改動**，將測試遷移面自 8 檔壓縮至 5 檔，顯著降低誤傷風險（005a REV2 漏檔事件教訓） |

**被取代之開發段決策點（§16）**

| 開發段 | 狀態 | 取代者 |
|---|---|---|
| **D6**（每公里單價之精度來源） | **已取代** | §20.4.2（每年折舊費用 2dp；誤差上界由 `年度里程×0.00005` 降為 `≤0.005` 元） |
| **D7**（快照 8 欄） | **已修訂** | **D18**（9 欄；`calculatedAt`／版本 id 之設計理由續用） |
| **D8**（推導三值不外露） | **部分取代** | §20.10（每年折舊費用改為**可見**；車價與**年限**仍不外露，Q6 固化） |
| **D10**（附件容器語意與完成鎖定） | **部分取代** | 完成鎖定與 detach **全部續存**；僅「完成須 ≥1」之守門退場（AC-54） |
| **D14**（`count`／`SUM` 不對稱） | **不變** | 金額只用 `totalKm`（新公式下 `totalKm` 為比例之分子，語意續存） |
| D1／D2／D3（年度值域部分）／D4／D5／D9／D11／D12／D13 | **不變** | — |

---

### 20.14 已知限制增補（§17.1 之續編）

12. **舊模型列於前端無專屬版型**：裁定 F 清空 dev／Gate 之合成舊資料後，前端不存在可達之 `model="LEGACY"` 狀態，故本修訂段**不新增**舊模型版型（避免未經批准之可見行為）。後端 DTO 依 AC-56 已可判別並回傳原值；**PHASE-008 報表之舊模型呈現**屬該 Phase（§20.16 #6）。前端仍須滿足既有 `Error` 態紀律：任何非預期 DTO 形狀不得 500 或渲染 `NaN`。
13. **`ANNUAL_TOTAL_KM_INVALID` 於 API 路徑結構性不可達**：AC-47(c) 之當場 400 使 `≤0` 無法入庫，該 blocker 僅於純函式層可達。**刻意保留**（保守失敗紀律；若未來欄位層放寬即自動生效）。
14. **M2 之回滾具前提條件**：`estimatedAnnualKm` 之 `SET NOT NULL` 還原需該欄無 `NULL` 列；一旦以新介面建立過參數版本即需回填或刪除該批版本。詳見 §20.15。
15. **`rawAmount` 4 位小數與 `totalAmount` 之窗口矛盾（B-12）續存**：`[x.49995, x.5)` 區間之外觀矛盾在新公式下同樣可能發生（PRIMARY kill case 之 `8113.4979…` 即為鄰近例）。**Gate 報告須向人類揭露**；PHASE-008 對帳說明必以**三來源值**（每年折舊費用／年度公務里程／年度總里程）重算，勿直接以 4dp `snapshotRawAmount` 呈現。
16. **每年折舊費用之 2dp 為刻意接受之對帳成本**（取代 §17.1 #7 之單價誤差條款）：誤差上界 `≤0.005` 元，較舊模型改善逾兩個數量級。
17. **同年度多筆申請各自輸入不同年度總里程**：Q11 已裁定不做一致性檢查；同一批差旅可被多筆折舊申請各自計入（§17.1 #10 之語意延續）。

---

### 20.15 Rollback 修訂（增補 §14）

- **修訂段新增內容**：1 個 ALTER 型 migration（4 新欄 ＋ 1 欄轉 nullable）、1 個新純函式（`deriveAnnualDepreciation`）、1 個新解析器（`parseAnnualTotalKmField`）、既有 4 個折舊模組與 3 個參數模組之改造、前端 2 頁改造、測試遷移。
- **開發階段回滾**：branch `phase-007` 還原至修訂段起點；DB 執行 `ALTER TABLE "DepreciationApplication" DROP COLUMN …` ×4 ＋ `ALTER TABLE "DepreciationParameterVersion" ALTER COLUMN "estimatedAnnualKm" SET NOT NULL`。
- **⚠ 部分不可逆（必須向人類揭露）**：
  1. `DROP COLUMN` 會**永久遺失**新模型申請之 `annualTotalKm` 與四個新快照欄；已完成之新模型折舊申請將無法呈現（`Application` 列雖在，快照不可重建）。**回滾前須先匯出該表。**
  2. `SET NOT NULL` 之前提為 `estimatedAnnualKm` 無 `NULL` 列；**若已以新介面建立過參數版本**，須先回填該欄或刪除該批版本——**刪除受 `parameterHasReferences` 引用保護約束**（已被完成申請引用者不可刪）。
  3. **R13 之資料清空為不可逆**：舊模型折舊申請一經刪除即無法還原（合成資料，風險可控；`AuditLog` 之歷史紀錄不刪）。
- **公開 contract 影響**：`ErrorCode` 聯集零變更；**blocker code 聯集**（退場 1、新增 3）與**折舊參數端點欄位集合**（縮欄）為公開契約變更，回滾即回到修訂前形狀；DTO 三形狀之變更同理。
- **既有資料補償**：M2 對既有列**零改寫**（AC-01(b) 機械證明）；新欄於既有列一律 `NULL`。

---

### 20.16 Architecture / Data Flow 同步項增補（§13 之續編；本 Phase 不修改該二檔，結案 DOC-SYNC 批次處理）

12. **ARCHITECTURE §4.1 折舊段**：公式改寫為「`ROUND_HALF_UP(每年折舊費用 × 年度公務里程 ÷ 年度總里程, 0)`，**取整恰一處**（每年費用之 2dp 取整屬 PHASE-003a 引擎契約）；禁止先取整比例、里程或 `rawAmount`」；刪除「以 4dp `perKmUnitPrice` 為準」之舊條款並註記其適用範圍限縮為**舊模型歷史快照**。
13. **ARCHITECTURE §4.1／§4.2 折舊參數段**：補記「新版本只需車價 ＋ 年限；`estimatedAnnualKm` 轉 nullable 之凍結欄；`deriveDepreciation` 行為凍結、申請路徑零呼叫」。
14. **ARCHITECTURE §4.4 快照清單**：折舊項改為 **9 欄**，補記「舊二欄凍結唯讀」與**新舊模型判別欄**（`snapshotAnnualTotalKm`）。
15. **ARCHITECTURE §4.5**：補記「折舊證明為**選填**；完成鎖定與 detach 語意不變」。
16. **ARCHITECTURE §4.11（或 §4.1 揭露面段）**：更新為「每年折舊費用對一般使用者**可見**；車價與**折舊年限**一律不外露（Q6）」。
17. **DATA_FLOW §1.1**：`DepreciationApplication` 欄位列更新為修訂後 schema（含 4 新欄與 2 凍結欄）；`DepreciationParameterVersion.estimatedAnnualKm` 標為 nullable 凍結欄。
18. **DATA_FLOW §2.2**：折舊差異段改述為新公式與比例守門；補記**新舊模型判別**（比照 §2.2 既有之 `fuelPriceVersionId` 判別條目）。
19. **PROJECT_STATE 跨 Phase 追蹤（大總管白名單）**：①**PHASE-008 折舊報表改採五值揭露面**（每年折舊費用／年度公務里程／年度總里程／公務比例／金額；**不呈現車價與折舊年限**）——**Q8 已裁定，同時收斂既有追蹤條「三推導值是否呈現於報表須另行人類裁定」**；②PHASE-008 報表須同時支援**舊模型快照**（判別依 `snapshotAnnualTotalKm` 是否為 `null`）——與 005a `fuelPriceVersionId` 判別為同型義務；③PHASE-008 對帳說明以三來源值重算（§20.14 #15）；④PHASE-009 折舊修正版須複製 `applicationYear` **與 `annualTotalKm`** 後重算。
