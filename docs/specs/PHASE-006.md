# PHASE-006 — 保養費用分攤

| 項目 | 內容 |
|---|---|
| **Spec 狀態** | `ACTIVE`（Spec Gate 通過：人類 leonchih 2026-08-04，D1~D12 全數照推薦批准（含 D11 追認）；**T1~T9 共 9 項 High 之事前批准已於本 Gate 一併取得**。見 §18 修訂紀錄） |
| **Phase ID** | PHASE-006 |
| **Task ID（本文件產出）** | PHASE-006-SPEC |
| **Base Commit** | `f1a2909`；工作 branch `phase-006`（自 main `9fa0913` 切出） |
| **Risk Level** | **High**（完成鎖定／不可逆快照／附件權限／金額計算；依 CLAUDE.md「認證、授權、密碼、附件權限相關工作一律 High」與 PRD §5 判準） |
| **依賴** | PHASE-003（附件生命週期與授權存取，COMPLETED）、PHASE-003a（參數版本引擎與 §14 欄位驗證合約，COMPLETED）、PHASE-004（申請骨架／狀態機／快照／代操作／綜合查詢，COMPLETED）、PHASE-005（區間公務里程引擎 `sumOfficialMileage`，COMPLETED）、PHASE-005a（油資模型，COMPLETED——**本 Phase 不觸油資單價**） |
| **被依賴** | PHASE-008（保養報表編號 `MNT` 與列印版／PDF）、PHASE-009（保養之作廢與修正版）、PHASE-010（稽核回歸）、PHASE-011（附件清理之保養引用保護） |
| **對應 US（主要）** | FE-US-13、FE-US-14、FE-US-15、FE-US-16；BE-US-10、BE-US-11、BE-US-12、BE-US-13；BE-US-18（保養快照）、BE-US-24（保養上限 5）、BE-US-25（保養完成鎖定）；NFR-US-10（保養附件） |
| **對應 US（次要／延伸驗收）** | FE-US-04／FE-US-05（列表與篩選之類型擴充）、FE-US-21（草稿附件管理之保養情境）、FE-US-27（響應式）、AD-US-06／07／08 與 BE-US-03（代操作延伸至保養）、BE-US-20（草稿）、BE-US-30（區間公務總里程之複用）、BE-US-22（作廢排除之既有預留，本 Phase **不實作作廢**） |
| **Human Gate** | **Spec 事前批准（本文件，High；含全部 High Task 之事前批准）** ＋ Mock Gate（保養表單／預覽／證明）＋ 整合 Gate |
| **產出者** | spec-writer（Task Context Packet `PHASE-006-SPEC`） |

> **本 Spec 的規範基礎**：CLAUDE.md 事實來源優先序 1→5。本文件**不改變任何 User Story 原意、不縮減任何已定稿 AC**。凡標「推薦」者一律**未定案**，須人類於 §16 裁定後由大總管以 §18 修訂紀錄固化，方可轉 `ACTIVE`。
>
> **必引前提（開工 Packet 逐條納入）**：PHASE-005 結案移交之 **D2(a) null 快照 count/sum 不對稱**（見 §5 B-14、§7.3、AC-15）、**「不得以一般使用者不知道單價為安全前提」**（PHASE-004 D6 修訂，2026-08-02 人類批准，見 §6.3）、**補測清單 B-12/15/17/19/24/25**（處置見 §11.6）。

---

## 1. 目標與非目標

### 1.1 目標

1. **保養草稿**（FE-US-13、BE-US-20）：上次／本次保養日期、上次／本次里程表數值、本次實際保養費用五欄；僅部分資料亦可保存。
2. **保養證明附件**（FE-US-15、BE-US-13、BE-US-24、BE-US-25、NFR-US-10）：上限 5 張、草稿可缺、完成須 ≥1、完成後鎖定、授權存取。
3. **保養區間里程**（BE-US-10）：`本次里程表 − 上次里程表`；本次日期 ≤ 上次日期、本次里程表 ≤ 上次里程表、費用 ≤ 0 一律拒絕完成。
4. **期間公務里程**（BE-US-11、BE-US-30）：**複用 PHASE-005 引擎 `sumOfficialMileage`**，期間 ＝ `[上次保養日期, 本次保養日期]`（起訖含當日）、僅已完成且未作廢之本人差旅、高速里程不重複加總。
5. **公務比例與分攤金額**（BE-US-12、FE-US-14）：比例 ＝ 期間公務里程 ÷ 保養區間里程；比例 > 100% 顯錯並拒絕完成；分攤 ＝ 實際費用 × 比例，**整筆一次一般四捨五入**為新臺幣整數；後端為唯一權威，不採前端提交之金額／比例／里程。
6. **完成與快照**（FE-US-16、BE-US-18、BE-US-25）：完成時於單一交易內驗證→計算→寫快照（區間里程／期間公務里程／公務比例／實際費用／最終金額，另存取整前金額）→狀態轉換；快照與附件一經完成即不可變。
7. **列表與代操作之類型擴充**（FE-US-04／05、AD-US-06/07/08、BE-US-03）：保養列進入既有綜合列表與篩選；管理員可代建立／代修改保養草稿並留稽核。
8. **Phase 結束之人類可操作路徑**：建草稿 → 輸入區間與費用 → 上傳證明 → 看到區間里程／公務里程／比例／分攤金額 → 完成並保存快照。

### 1.2 非目標（Out of Scope）

| 項目 | 落點 | 說明 |
|---|---|---|
| 保養報表編號（`MNT`）、列印版、PDF | **PHASE-008** | PRD §PHASE-006 明文 Out of Scope |
| 保養之修正版與作廢 | **PHASE-009** | 同上；`ApplicationStatus.VOIDED` 於本 Phase **仍無任何轉換路徑**（沿 PHASE-004 AC-58） |
| 折舊補貼 | PHASE-007 | 不觸 |
| 油資／ETC／折舊參數模型 | 不變更 | **保養分攤不使用任何補助參數**——分攤基礎為使用者自填之實際費用，與 `FuelPriceVersion`／`EtcParameterVersion`／`DepreciationParameterVersion` 全無關聯 |
| 統計端點 `GET /statistics/mileage` | 不變更 | 本 Phase 只**呼叫** `sumOfficialMileage` 引擎函式，不改該端點之任何行為 |
| 差旅相關任何既有行為 | 不變更 | `travel-calculation.ts`／`travel-parameters.ts`／`completion-blockers.ts` 之既有語意零改動（改動須經 Stop Condition 回報） |
| 相鄰保養申請之期間重疊偵測／去重 | **見 §16 D12**（推薦本 Phase 不做，列已知限制） | US 未要求；屬新增產品行為 |
| 保養里程表與差旅里程之交叉一致性檢核 | 永久 Out of Scope（MVP） | US 未要求；里程表為使用者自填 |
| 暫存附件之定時清理（TTL 掃除） | PHASE-011 | 本 Phase 只需保證保養附件之**引用保護語意**可被 PHASE-011 之 `HasReferenceQuery` 實作查得 |

---

## 2. 可測試 Acceptance Criteria

> **AC 追溯規則**：每條 AC 標註來源 US／PRD 原文條目。**符號**：`Tn` ＝ 落在哪個 Task（§15）。
> **金額語意類 AC（AC-06、AC-16~AC-20、AC-26、AC-28）之測試一律以精確等值斷言，禁止近似比較。**

### A. 資料模型與 migration

> 來源：BE-US-18 第 2 條「Given 保養申請完成／When 保存資料／Then 應保存保養區間里程、期間公務里程、公務比例、實際費用及最終金額。」；DATA_FLOW §1.1「MaintenanceApplication｜上次/本次保養日期、上次/本次里程表、實際費用；(快照:區間里程/公務里程/比例/分攤金額)」

**AC-01 保養資料模型與零改寫 migration（BE-US-18 / DATA_FLOW §1.1 / T1）** — Given 既有資料庫（含 PHASE-005a 之已完成差旅申請與附件）。When 套用本 Phase migration。Then：
(a) 新增 `MaintenanceApplication` 表（1:1 於 `Application`，PK ＝ `applicationId`），含五個業務欄位與五個快照欄位（§8.2；D11(a) 不另存 snapshotActualCost）；
(b) **既有所有表之所有既有欄位值逐位元不變**（跨 `Application`／`TravelApplication`／`TripSegment`／`Attachment`／`User` 五表逐欄比對）；
(c) **零回填**：不新增任何非空預設值、不寫入任何既有資料列；
(d) `prisma migrate` 於**乾淨 DB** 與**既有 DB** 皆成功；
(e) 業務表總數由 13 增為 14，`infra001-isolation-self-check.test.ts` 之表數斷言同步更新（**機械連動項**，見 §17.1）；
(f) **不新增任何 enum、不新增任何 `AuditAction` 值**（`ApplicationType.MAINTENANCE`、`AttachmentRefType.MAINTENANCE`、`APPLICATION_CREATED_ON_BEHALF`／`APPLICATION_UPDATED_ON_BEHALF` 皆已存在）。

### B. 保養草稿 CRUD

> FE-US-13 第 1 條：「…Then 系統應提供上次與本次保養日期、里程表數值及本次實際保養費用欄位。」；第 2 條：「Given 使用者只輸入部分資料／When 儲存草稿／Then 系統應允許保存。」；BE-US-20 第 1 條：「…系統應允許保存可接受的部分資料。」

**AC-02 建立與更新草稿允許部分資料（FE-US-13 第 2 條、BE-US-20 第 1 條 / T4）** — Given 已登入之一般使用者。When `POST /applications/maintenance`（空 body）或 `PUT /applications/maintenance/:id` 僅帶部分欄位。Then **201／200**，`status="DRAFT"`，未提供之欄位為 `null`，**不因缺欄位而拒絕**；回應含 `completionBlockers[]`（列出目前尚未通過之完成條件）。欄位三態語意沿用 PHASE-004 §8.2：key 缺席＝不變、key＝`null`＝清空、key 有值＝設定。

**AC-03 欄位格式與容量驗證（CHORE-003 欄位驗證合約 / T4）** — Given 任一欄位之值為非法格式（非 `YYYY-MM-DD` 之日期、非數字字串、含千分位、科學記號、超過欄位小數位、超過欄位整數位容量、`NaN`／`Infinity`）。When 建立或更新草稿。Then **400 `VALIDATION_ERROR`** 且 `fields[]` 可定位到該欄位並附 zh-TW `reason`；**絕不 500、絕不靜默截斷寫入**。驗證分層與 `reason` 措辭沿用 PHASE-003a §14.2／CHORE-003 之既有 gate table 慣例（格式層四道 → 容量層 → 值域層），**不新增第二套驗證實作**。

**AC-04 已完成不可修改（BE-US-25 第 4 條、PHASE-004 AC-56/59 / T4）** — Given 保養申請 `status="COMPLETED"`。When `PUT /applications/maintenance/:id` 或 `DELETE /applications/:id`。Then **403 `FORBIDDEN`**，訊息逐字沿用既有 `assertApplicationMutable` 之 `已完成的申請不可修改，請建立修正版`；DB 零寫入。

**AC-05 資料隔離（BE-US-02、NFR-US-10 / T4）** — Given 使用者 A 之保養申請。When 使用者 B（一般使用者）以 `GET`／`PUT`／`DELETE` 存取。Then **403 `FORBIDDEN`**（沿用 `assertOwnershipOrAdmin` 之既有語意），且回應不洩漏該申請之任何業務欄位；未登入 → **401**；`mustChangePassword` → **403 `PASSWORD_CHANGE_REQUIRED`**。

### C. 保養區間里程與完成前置驗證

> BE-US-10 三條 AC 原文：「應使用『本次里程表數值－上次里程表數值』」／「本次里程表數值小於或等於上次里程表數值→拒絕」／「本次保養日期早於或等於上次保養日期→拒絕」。FE-US-13 第 3~5 條同義並加上「實際保養費用小於或等於 0 → 拒絕完成」。

**AC-06 保養區間里程公式（BE-US-10 第 1 條 / T2）** — Given 上次里程表 `L`、本次里程表 `C` 皆為有效 `Decimal`。When 計算保養區間里程。Then 結果精確等於 `C − L`（`Prisma.Decimal` 減法，全程無浮點中介），**不取整**、以 2 位小數字串對外呈現。邊界：`C − L = 0.01`（最小正值）與 `C − L = 1`（極小區間）皆為合法輸入，計算不例外。

**AC-07 保養日期順序（BE-US-10 第 3 條、FE-US-13 第 3 條 / T3）** — Given `本次保養日期 ≤ 上次保養日期`（含相等）。When 嘗試完成。Then 拒絕完成，回傳 blocker `MAINTENANCE_DATE_ORDER_INVALID`；`本次 = 上次 + 1 日` 為最小合法鑑別案例（不得被誤擋）。

**AC-08 里程表順序（BE-US-10 第 2 條、FE-US-13 第 4 條 / T3）** — Given `本次里程表 ≤ 上次里程表`（含相等）。When 嘗試完成。Then 拒絕完成，回傳 blocker `ODOMETER_ORDER_INVALID`；`本次 = 上次 + 0.01` 為最小合法鑑別案例。

**AC-09 費用值域（FE-US-13 第 5 條 / T3）** — Given `實際保養費用 ≤ 0`（含 `0`、`-0.01`）。When 嘗試完成。Then 拒絕完成，回傳 blocker `ACTUAL_COST_INVALID`；`0.01` 為最小合法鑑別案例。

**AC-10 完成度回傳全部未通過項（PHASE-004 AC-52 既有紀律 / T3）** — Given 草稿同時違反多項完成條件。When 檢視草稿或嘗試完成。Then 回傳**全部**未通過項（非只回第一項），順序穩定可預期（§7.4 之固定順序表）；缺欄位（`*_REQUIRED`）與關係錯誤（`*_ORDER_INVALID`）為**互斥**呈現（欄位缺漏時不另報順序錯誤，避免自相矛盾之雙訊息）。

### D. 期間公務里程

> BE-US-11 四條 AC 原文：「起日與迄日均應包含」／「差旅已完成且未作廢…應納入」／「差旅為草稿或已作廢…不得納入」／「差旅包含高速公路里程…不得重複加總」。BE-US-30 第 3 條：「應加總各差旅行程段的總里程」。

**AC-11 期間定義與含當日（BE-US-11 第 1 條 / T5）** — Given 上次保養日期 `D1`、本次保養日期 `D2`（`D1 < D2`）。When 統計期間公務里程。Then 查詢區間為 `[D1, D2]` **起訖均含當日**（以 `gte`/`lte` 表達，**不得**用 `gt`/`lt`）；`tripDate = D1`、`tripDate = D2` 之已完成差旅**均納入**；`tripDate = D1 − 1 日`、`tripDate = D2 + 1 日` **均不納入**。日期一律 UTC 日粒度（`@db.Date`），沿用 `parseUtcDate`／`utcDateOnly`／`formatUtcDate`，**不得**引入本地時區換算。

**AC-12 納入條件（BE-US-11 第 2、3 條、BE-US-22 第 3 條 / T5）** — Given 期間內存在草稿差旅、已作廢差旅、他人之已完成差旅、本人之保養／折舊申請。When 統計期間公務里程。Then 上述皆**不納入**；僅「本人 ∧ `type=TRAVEL` ∧ `status=COMPLETED` ∧ `tripDate ∈ [D1,D2]`」之申請納入。（作廢排除由 `status="COMPLETED"` **字面值等值比對**達成，沿 PHASE-005 D8(a)；本 Phase 不得改為負向條件。）

**AC-13 高速里程不重複加總（BE-US-11 第 4 條、BE-US-30 第 4 條 / T5）** — Given 期間內之已完成差旅其行程段含 `highwayKm > 0`（含 `highwayKm == totalKm` 之邊界）。When 加總期間公務里程。Then 結果精確等於 `Σ 各段 totalKm`，`highwayKm` **從不參與加總**（此語意由 PHASE-004 AC-50 之 `snapshotTotalKm` 定義保證，本 Phase 以精確等值斷言驗證）。

**AC-14 引擎複用，不得第二份實作（ARCHITECTURE §4.10 / T5）** — Given 期間公務里程之需求。When 實作。Then **必須**呼叫 `backend/src/mileage/mileage-engine.ts` 之 `sumOfficialMileage(db, { ownerId, dateFrom, dateTo })`（於保養完成流程之**同一交易** `tx` 內呼叫），且 `ownerId` 一律取自 `Application.ownerId`（**代操作時亦為擁有人，絕不可為操作者**）；本 Phase **不得**在任何檔案重寫過濾條件或加總邏輯。以 import 接線斷言＋突變自證（移除該 import 改為私有複製必紅）驗證。

**AC-15 D2(a) `count`/`SUM` 不對稱之明文語意（PHASE-005 D2(a) 移交 / T5）** — Given 期間內某已完成差旅之 `snapshotTotalKm` 為 `null`（資料異常；PHASE-004 AC-50 之原子完成保證其不發生）。When 統計期間公務里程。Then：
(a) `sumOfficialMileage` 之 `applicationCount` **計入**該列、`totalKm` **忽略**該列（外觀為「筆數 ≥ 1 但里程 `0.00`」）——此為既有引擎行為，本 Phase **不改**；
(b) 保養之**任何金額計算一律只使用 `totalKm`，`applicationCount` 純供顯示**，不得參與分子、分母或任何推導；
(c) 偏差方向為**保守**（分子偏低 → 比例偏低 → 分攤金額偏低），不會溢付；
(d) 若 `applicationCount > 0` 而 `totalKm = 0`，DTO 仍如實回傳兩值，前端**不得**據此自行推導或補值；須有整合測試**明文固定**此外觀。

### E. 分攤計算（金額核心）

> BE-US-12 五條 AC 原文：「應使用『期間公務里程 ÷ 保養區間里程』」／「公務使用比例大於 100%→拒絕」／「應使用『實際保養費用 × 公務使用比例』」／「應對整筆金額進行一次一般四捨五入」／「前端提交自訂分攤金額…不得直接採用」。FE-US-16 第 2 條：「Given 公務里程大於保養區間里程／When 使用者嘗試完成／Then 系統應拒絕並提示檢查差旅、日期或里程資料。」

**AC-16 公務比例公式（BE-US-12 第 1 條 / T2）** — Given 保養區間里程 `I > 0`、期間公務里程 `O ≥ 0`。When 計算公務比例。Then 比例 ＝ `O ÷ I`（`Prisma.Decimal.div`，全程無浮點中介）；對外以**兩種表示**回傳：`ratio`（比值，固定 6 位小數字串）與 `ratioPercent`（百分比，固定 4 位小數字串，＝ `ratio × 100`）——**前端一律直接顯示，不得自行換算**（§11.3）。`I = 0` 不可能（AC-08 已擋），若仍發生一律視為不可計算，**不得**除以零、不得回 `NaN`/`Infinity`、不得 500。

**AC-17 分攤金額之計算式與取整層級（BE-US-12 第 3、4 條、PRD §PHASE-006「整筆一次四捨五入」 / T2）** — Given 實際費用 `P`、期間公務里程 `O`、保養區間里程 `I`。When 計算分攤金額。Then：
(a) 取整前金額 `raw` ＝ `P × O ÷ I`，**計算過程中不得對比例或任何中間值取整**；
(b) 最終金額 ＝ `ROUND_HALF_UP(raw, 0)`（一般四捨五入，**非銀行家取整**），為新臺幣整數；
(c) 全案取整**恰一處**（此處），不得新增第二處；
(d) **鑑別力必辦（kill case，逐字寫入測試）**：
  - **取整規則鑑別**（`ROUND_HALF_UP` vs 銀行家）：`P=2.00, O=1, I=4` → `raw=0.5` → **1**（銀行家為 0）；`P=6.00, O=1, I=4` → `raw=1.5` → **2**（銀行家亦為 2）——兩例**成對**出現方具鑑別力；
  - **取整層級鑑別**（禁止先取整比例）：`P=1500000.00, O=2, I=3` → 正解 `raw = 1000000.0000` → **1000000**；若先將比例取整為 6 位小數（`0.666667`）再乘則得 `1000000.5` → `1000001` → **必須為紅**；
  - **浮點中介鑑別**：`P=0.10, O=2, I=10` 等組合以精確等值斷言，證明未經 IEEE754 double。

**AC-18 比例 > 100% 阻擋（BE-US-12 第 2 條、FE-US-14 第 4 條、FE-US-16 第 2 條 / T3）** — Given `期間公務里程 > 保養區間里程`。When 檢視草稿或嘗試完成。Then 顯示錯誤並**拒絕完成**，回傳 blocker `OFFICIAL_KM_EXCEEDS_INTERVAL`，zh-TW 訊息須提示「檢查差旅、日期或里程資料」（FE-US-16 第 2 條字面）。**比例恰等於 100%（`O == I`）為合法、允許完成**（最小鑑別對：`O = I` 通過、`O = I + 0.01` 被擋）。判定**必須**以 `O` 與 `I` 之 `Decimal` 直接比較，**不得**以取整後之 `ratio` 比較（否則 `O = I + 0.0000001` 類輸入會被誤放行）。

**AC-19 金額與比例之容量守門（PHASE-005a D4(a) 同型延伸 / T2 判定 ＋ T8 接線）** — Given `raw`／最終金額／區間里程／公務里程之任一項超出其目標資料庫欄位容量（`Decimal(14,4)` 之 `|v| ≥ 1e10`；`Int`/int4 之 `> 2147483647` 或 `< -2147483648`）。When 檢視草稿、預覽或嘗試完成。Then：
(a) **草稿與預覽即暴露**不可計算狀態（blocker `AMOUNT_OUT_OF_RANGE` ＋ `computed.calculable=false`），**不得**出現「預覽說可以、完成才擋」之反模式（PHASE-005a SF-2/S-1 之教訓）；
(b) 完成端點以**可行動之 4xx** 拒絕（形狀見 §16 D10），**絕不 500、絕不靜默截斷寫入**；
(c) 邊界**正例**必須在場（合法大額組合可完成成功），防守門誤殺。

**AC-20 後端為唯一權威（BE-US-12 第 5 條、CLAUDE.md「後端不得採用前端提交的金額」 / T8）** — Given 請求 body／query 夾帶 `intervalKm`／`officialKm`／`ratio`／`ratioPercent`／`rawAmount`／`amount`／`totalAmount`／`snapshot*` 等任一欄位（含合法值、畸形值、`null`、字串、陣列、頂層非物件 body）。When 建立／更新／預覽／完成。Then 一律**忽略**，回應與快照皆為後端自算之值；**絕不 500**；以「夾帶矩陣」測試逐一覆蓋。

### F. 保養證明附件

> FE-US-15 五條 AC；BE-US-13 三條 AC；BE-US-24 第 2 條「Given 保養申請已有 5 張附件／When 嘗試增加第 6 張／Then 系統應拒絕。」；BE-US-25 第 4 條「Given 申請已完成／When 收到刪除或替換附件請求／Then 系統應拒絕。」；NFR-US-10 三條 AC。

**AC-21 上限 5 張（BE-US-24 第 2 條、FE-US-15 第 2 條 / T6）** — Given 保養草稿已關聯 5 張 `LINKED` 附件。When 以 `PUT /applications/maintenance/:id` 之 `attachmentIds[]` 宣告第 6 張。Then **409 `TOO_MANY_ATTACHMENTS`**，整份儲存 rollback（附件與業務欄位皆不變）。上限常數 `MAINTENANCE_ATTACHMENT_LIMIT = 5` 定義於後端且**不得**由用戶端提供（`POST /attachments/:id/link` 已於 PHASE-004-T11 移除，本 Phase **不得**重新引入任何可自帶 `limit`／`refId`／`containerState` 之公開端點）。邊界正例：恰 5 張可儲存。

**AC-22 草稿可缺、完成須 ≥1（FE-US-15 第 4、5 條、BE-US-13 第 1、2 條 / T6）** — Given 保養草稿無任何附件。When 儲存草稿。Then **允許**（200/201）。When 嘗試完成。Then 拒絕完成，回傳 blocker `MAINTENANCE_ATTACHMENT_REQUIRED`；恰 1 張為最小合法鑑別案例。

**AC-23 完成後附件鎖定（BE-US-25 第 4 條、PHASE-003 AC-16 / T6）** — Given 保養申請已完成、其附件 `refType="MAINTENANCE"`。When `DELETE /attachments/:id`。Then **403 `FORBIDDEN`**，附件列零變更。**實作必要條件**：`lifecycle-service.ts` 之 `deriveContainerState` 現況對 `refType="MAINTENANCE"` **一律回 `'draft'`**（該分支註記「子表尚不存在，防禦性」）——本 Phase **必須**擴充該分支經 `MaintenanceApplication → Application.status` 推導真實狀態，否則保養完成後附件仍可被刪除（**現況即為真實安全缺口**，見 §17.1）。須有「修復前紅燈」實證。

**AC-24 附件授權存取（NFR-US-10 三條 / T6）** — Given 保養證明附件。When 擁有人請求 → 可取得內容與縮圖；其他一般使用者請求 → **403**，不得回傳檔案位元組；未登入直接開啟內容／縮圖 URL → **401**，不得提供內容。（沿用 PHASE-003 既有 `access-service.ts` 授權端點；本 Phase 提供**保養情境**之驗收，不新造授權機制。）

### G. 完成流程與快照

> FE-US-16 三條 AC；BE-US-18 第 2 條與第 4 條（「管理員後續修改參數／When 查看歷史申請／Then 系統應使用原計算快照」）。

**AC-25 完成之原子性（PHASE-004 AC-53 既有紀律 / T7）** — Given 通過全部完成條件之保養草稿。When `POST /applications/:id/complete`。Then 於**單一 `SERIALIZABLE` 交易**內依序完成：狀態機守門 → 完成度驗證 → 期間公務里程查詢 → 計算 → 快照寫入 → `Application.status/totalAmount/completedAt` 轉換；**任一步驟失敗，先前之快照寫入必須一併回滾**（以交易內可控失敗切點之測試證明，比照 PHASE-004 `__testOnlyFailAfterSnapshotWrite` 之既有做法）。完成後 `status="COMPLETED"`，回應含 `snapshot`。

**AC-26 快照齊備且可重現（BE-US-18 第 2 條、FE-US-16 第 3 條 / T7）** — Given 保養申請已完成。When 讀取 `GET /applications/maintenance/:id`。Then 回傳 `snapshot` 含**保養區間里程、期間公務里程、公務比例、實際費用、最終金額**五項（BE-US-18 逐字）＋取整前金額 `rawAmount` ＋ `calculatedAt`；且由快照之三項來源值（費用、公務里程、區間里程）**重算**可精確重現 `rawAmount` 與最終金額（雙重可重現性斷言）。詳情頁顯示此四值（FE-US-16 第 3 條）。

**AC-27 完成僅能由擁有人本人執行（PHASE-004 D17 沿用 / T7）** — Given 保養草稿之擁有人為 U。When 管理員 A（非擁有人）呼叫 `POST /applications/:id/complete`。Then **403 `FORBIDDEN`**，DB 零寫入。（授權在 route 層以嚴格 `actor.id === application.ownerId` 判定，**不得**使用 `assertOwnershipOrAdmin`——該函式會放行 ADMIN。裁定見 §16 D7。）

**AC-28 快照不可變（BE-US-18 第 4 條 / T8）** — Given 保養申請已完成。When 事後於該保養期間內新增／完成新的差旅申請，或修改任何差旅資料。Then 該保養申請之 `snapshot` **逐位元不變**（五個快照欄位＋`Application.totalAmount` 逐一等值斷言），且讀取已完成之保養申請時**不執行任何期間公務里程查詢**（以 spy 計數證明：讀 DRAFT 計數 +1、讀 COMPLETED 計數 +0）。

**AC-29 併發完成（PHASE-004 B-29 既有紀律 / T8）** — Given 同一保養草稿。When 兩個請求同時完成。Then **恰一個成功**、另一個得 403（來源狀態已鎖定），**不得雙重完成、不得雙重快照**、不得 500；序列化衝突以重試處理，重試耗盡以 503 呈現（沿用既有 `isRetryableTransactionConflict` 慣例）。

### H. 代操作

> AD-US-07 三條 AC；AD-US-08 三條 AC；BE-US-03 三條 AC。

**AC-30 管理員代建立／代修改保養草稿（AD-US-07 第 1、2 條、AD-US-08 第 1、2 條、BE-US-03 第 1、2 條 / T9）** — Given 管理員 A 已選定使用者 U。When `POST /admin/users/:userId/applications/maintenance` 建立、或 `PUT /applications/maintenance/:id` 修改 U 之草稿。Then 申請之 `ownerId = U`、`createdById = A`；並寫入 `AuditLog`（`action = APPLICATION_CREATED_ON_BEHALF` ／ `APPLICATION_UPDATED_ON_BEHALF`，`actorId = A`、`targetId = U`、`targetLabel` ＝ U 之 `loginName` 快照＋申請識別、`summary` 為重要欄位前後摘要且**不含**密碼／token）；稽核寫入與業務寫入於**同一交易**（失敗一併回滾）。未指定使用者（`userId` 不存在）→ **404**，不得建立任何列。

**AC-31 管理員不得直接修改已完成之保養申請（AD-US-08 第 3 條、BE-US-03 第 3 條 / T9）** — Given U 之保養申請已完成。When 管理員 A 嘗試 `PUT`。Then **403 `FORBIDDEN`**，訊息含「請建立修正版」（沿用既有文案），DB 零寫入。

### I. 綜合列表與篩選

> FE-US-04 五條 AC；FE-US-05 七條 AC；AD-US-06 第 1、2 條。

**AC-32 保養列進入綜合列表（FE-US-04 第 1、2、3、5 條 / T10）** — Given 使用者同時有差旅與保養申請。When `GET /applications`。Then 兩類混合、依 `primaryDate DESC, createdAt DESC, id DESC` 全序排序；保養列之 `type="MAINTENANCE"`、`status` 正確；**不適用於保養之欄位一律回 `null`**（前端顯示「—」，AC-68 既有語意），可適用欄位之映射依 §16 D9 裁定。

**AC-33 類型與期間篩選（FE-US-05 第 5 條、AD-US-06 第 2 條 / T10）** — Given 混合資料。When 以 `type=MAINTENANCE` ＋日期區間篩選（管理員另可帶 `ownerId`）。Then 僅回傳符合全部條件之保養列；保養列之期間歸屬以 `Application.primaryDate` ＝ **本次保養日期**（未填時回退為建立日期，沿 `derivePrimaryDate` 慣例）判定；起訖含當日。授權沿用 `resolveOwnerId`（一般使用者帶他人 → 403，**不靜默降級**）。

### J. 前端

> FE-US-13/14/15/16、FE-US-21、FE-US-27。

**AC-34 保養表單（FE-US-13 第 1、2 條 / T11）** — Given 使用者點擊「新增保養費用申請」。When 進入表單。Then 提供**上次保養日期、本次保養日期、上次里程表、本次里程表、本次實際保養費用**五個欄位（逐字標籤）；僅填部分欄位仍可「儲存草稿」成功；後端 400 之 `fields[]` 就地標示於對應欄位。

**AC-35 預覽四值（FE-US-14 全五條、FE-US-16 第 3 條 / T11）** — Given 有效輸入。When 預覽。Then 顯示**保養區間總里程、期間公務里程、公務使用比例、公司分攤金額**四值，數值一律直接取自後端回應（`intervalKm`／`officialKm`／`ratioPercent`／`amount`），**前端不得自行計算或換算**；比例 > 100% 時顯示錯誤訊息並使「完成」不可用；**任一不可計算狀態下不得顯示金額 `0`**，須顯示「無法計算」與可行動之 zh-TW 說明（沿 PHASE-005a AC-32 已批之反模式禁令）。

**AC-36 保養證明前端行為（FE-US-15 第 1、2、3、4 條、FE-US-21 / T12）** — Given 草稿。When 上傳支援格式圖片 → 顯示縮圖預覽；已有 5 張再上傳 → 前端拒絕並顯示上限訊息（後端仍為權威，AC-21）；單張 > 10 MB → 拒絕該檔（沿用既有 `AttachmentUploader` 之 413 處理）；無證明仍可儲存草稿；完成前缺證明 → 完成鈕停用並顯示 blocker 訊息。已完成之保養申請**不得出現**任何上傳／刪除入口（負向斷言）。

**AC-37 五態（PRD UI 驗收 / T11、T12）** — 保養表單／預覽／證明三處各具備：Loading（載入中）、Empty（尚無草稿／尚無證明）、Error（4xx 就地標示、5xx zh-TW 訊息＋重試）、Success、Permission denied（非擁有人不呼叫任何寫入 API——以「該 API 從未被呼叫」之零呼叫斷言驗證）。

**AC-38 響應式 375px（FE-US-27 / T14）** — Given 視窗寬度 375px。When 檢視保養表單、預覽區塊、證明區塊與保養詳情。Then `body` 無水平溢位（`scrollWidth <= clientWidth`），關鍵操作可達。

### K. 錯誤合約與日誌

**AC-39 不新增 `ErrorCode`（PHASE-005a AC-35 沿用 / T13）** — Given 本 Phase 全部新增程式。When 掃描。Then `platform/errors.ts` 之 `ErrorCode` 聯集與現有基線**全等**（新增／刪除任一成員必紅）；本 Phase 之 src 檔僅引用基線成員之字面值。

**AC-40 端點錯誤合約與日誌安全（NFR-US-16 / T13）** — Given 本 Phase 全部端點之 401／403／400／404／409（／§16 D10 裁定之容量錯誤碼）路徑。When 觸發。Then 回應形狀統一為 `{ error: { code, message, requestId, fields?, details? } }`（頂層鍵集合封閉）；伺服器日誌**不含** cookie 值、`password=`、bearer pattern、SQL 關鍵字／Prisma 類名、絕對路徑；錯誤仍有日誌（不靜默）。

### L. E2E

**AC-41 Gate E2E — 完整走一筆保養（PRD「Phase 結束人類可完整走一筆保養」 / T14）** — 情境：①播種一筆該期間內之已完成差旅 → ②建立保養草稿（部分欄位）→ ③補齊四欄 → ④上傳 1 張證明 → ⑤預覽顯示四值 → ⑥完成 → ⑦詳情顯示快照四值且附件無刪除入口 → ⑧再次嘗試修改得 403。播種須**冪等**（先查後建，沿 PHASE-005a T13R 之教訓）。

---

## 3. 正常流程

### 3.1 建立與編輯保養草稿（FE-US-13）

1. 使用者於首頁點「新增保養費用申請」→ 前端 `POST /applications/maintenance`（空 body）→ 201，取得 `id`，導向表單。
2. 使用者填寫五欄（可部分）→ 「儲存草稿」→ `PUT /applications/maintenance/:id` → 200，回應含 `completionBlockers[]` 與 `computed`。
3. 上傳證明：`POST /attachments`（TEMP）→ 前端把回傳之 `attachmentId` 併入下次 `PUT` 之 `attachmentIds[]` → 後端於同一交易內 `linkAttachmentTx`（`refType="MAINTENANCE"`、`refId = applicationId`、`limit = 5`）。

### 3.2 預覽分攤（FE-US-14）

1. 前端 `POST /applications/maintenance/preview`（或讀 `PUT`/`GET` 回應之 `computed`，依 §16 D6 裁定）。
2. 後端：驗證四欄 → 計算 `intervalKm = C − L` → `sumOfficialMileage(prisma, { ownerId, dateFrom: D1, dateTo: D2 })` 取 `officialKm` → `ratio = O ÷ I` → `raw = P × O ÷ I` → `amount = ROUND_HALF_UP(raw, 0)` → 容量判定 → 回 `MaintenanceComputedDto`。
3. 前端逐值顯示；`calculable=false` 時顯示對應 zh-TW 說明，**不顯示 0**。

### 3.3 完成保養申請（FE-US-16、BE-US-18）

單一 `SERIALIZABLE` 交易內：
① `assertTransition(status, "COMPLETED")`（非 DRAFT → 403）
② 讀附件數 → `computeMaintenanceBlockers(...)`；非空 → 400 `VALIDATION_ERROR` ＋ `fields[]` ＋ `details.blockers[]`（全部未通過項）
③ `sumOfficialMileage(tx, {...})`（**同一交易**）
④ `calculateMaintenance(...)` → 容量守門（§16 D10）
⑤ 寫 `MaintenanceApplication` 五個快照欄位 → 寫 `Application.status/totalAmount/completedAt`
⑥ 交易提交；附件因 `deriveContainerState` 推導為 `completed` 而自動鎖定（AC-23）

### 3.4 管理員代操作（AD-US-07/08）

`POST /admin/users/:userId/applications/maintenance` → 建立時 `ownerId=U`、`createdById=admin` ＋ 稽核；後續 `PUT` 由 `assertOwnershipOrAdmin` 放行管理員並寫 `APPLICATION_UPDATED_ON_BEHALF`。**完成仍僅限本人**（AC-27）。

---

## 4. 五態（Loading / Empty / Error / Success / Permission denied）

| 畫面／區塊 | Loading | Empty | Error | Success | Permission denied |
|---|---|---|---|---|---|
| **保養表單（草稿）** | 「載入中…」骨架 | 新建立之草稿：五欄皆空 ＋ blocker 清單提示待補 | 400 就地標示欄位；5xx zh-TW 訊息＋重試 | 「草稿已儲存」＋更新後 blockers／computed | 非擁有人 403 → 導回列表並提示無權限；**零寫入 API 呼叫** |
| **分攤預覽** | 「計算中…」 | 欄位未齊 → 「請先填寫上次／本次保養日期與里程表」（非錯誤） | 不可計算 → 顯示對應 zh-TW 原因（比例超過 100%／金額超出範圍／區間里程無效），**不顯示 0** | 四值齊備顯示 | 同上 |
| **保養證明** | 上傳進度 | 「尚未上傳保養證明（完成前至少需 1 張）」 | 415／413／409 各自 zh-TW 訊息 | 縮圖列＋張數 `n/5` | 已完成 → 無上傳／刪除入口（唯讀） |
| **保養詳情（已完成）** | 讀取中 | 不適用（已完成必有內容） | 讀取失敗 → 重試 | 顯示快照四值＋實際費用＋證明縮圖 | 非擁有人 403 |
| **綜合列表之保養列** | 沿用既有列表五態（PHASE-004 AC-69~72） | 沿用 | 沿用 | 類型標籤「保養分攤」 | 沿用 `resolveOwnerId` |

---

## 5. 邊界條件

| 編號 | 情境 | 期望行為 | 對應 AC |
|---|---|---|---|
| B-01 | `本次保養日期 = 上次保養日期` | 拒絕完成（`MAINTENANCE_DATE_ORDER_INVALID`） | AC-07 |
| B-02 | `本次保養日期 = 上次保養日期 + 1 日` | 合法（最小正區間） | AC-07 |
| B-03 | `本次里程表 = 上次里程表` | 拒絕完成（`ODOMETER_ORDER_INVALID`） | AC-08 |
| B-04 | `本次里程表 = 上次里程表 + 0.01` | 合法；`intervalKm = 0.01` | AC-06/08 |
| B-05 | 區間里程恰 1 km | 合法；比例可能極大 → 多半觸發 AC-18 阻擋，**非** 500 | AC-06/18 |
| B-06 | 期間公務里程 `O` 恰等於區間里程 `I`（比例 100%） | **允許完成**；分攤 ＝ `ROUND_HALF_UP(P)` | AC-18 |
| B-07 | `O = I + 0.01` | 拒絕完成（`OFFICIAL_KM_EXCEEDS_INTERVAL`） | AC-18 |
| B-08 | 期間內無任何已完成差旅 | `officialKm = "0.00"`、`ratio = "0.000000"`、`amount = 0`；**允許完成**（US 未禁止零分攤） | AC-12/17 |
| B-09 | 期間內同一日有多筆已完成差旅 | 全數納入（引擎自然行為） | AC-11/12 |
| B-10 | 差旅 `tripDate` 恰等於上次保養日期 | **納入**（起日含當日） | AC-11 |
| B-11 | 差旅 `tripDate` 恰等於本次保養日期 | **納入**（迄日含當日） | AC-11 |
| B-12 | 期間內僅有草稿差旅（其 `tripDate` 可能為 `null`） | 回 0；**不得**因 `null` 比較拋錯（PHASE-005 補測 B-12） | AC-12/15 |
| B-13 | 期間內僅有他人之已完成差旅 | 回 0 | AC-12 |
| B-14 | 期間內存在 `status=COMPLETED` 但 `snapshotTotalKm IS NULL` 之差旅 | `applicationCount` 計入、`totalKm` 忽略（「筆數 1 但 0.00」）；金額只用 `totalKm`（PHASE-005 D2(a)） | AC-15 |
| B-15 | 期間內存在已完成但 0 段之差旅（資料異常） | 貢獻 0，不拋錯（PHASE-005 補測 B-15） | AC-13/15 |
| B-16 | 保養期間跨年（如 `2025-06-01`~`2026-05-31`） | 正常統計；本 Phase 無年度特殊語意（PHASE-005 補測 B-17） | AC-11 |
| B-17 | 保養期間極大（如 `1900-01-01`~`2999-12-31`） | 合法；仍以 DB 單次聚合，不分頁、不截斷（PHASE-005 補測 B-19） | AC-11/14 |
| B-18 | 保養日期為未來日期 | 合法（沿 PHASE-004 B-27 允許未來出差日之既有裁定） | AC-11 |
| B-19 | 公務里程合計出現 3 位以上小數 | 不可能（來源皆 `Decimal(_,2)`）；若發生**不得**靜默取整，以 2 位小數格式化並須有測試證明來源不含此類值（PHASE-005 補測 B-24） | AC-13 |
| B-20 | 公務里程合計極大（101 筆 × 每筆上限） | `Decimal` 於 DB `numeric` 累加，無溢位；輸出**字串**不得改用 JSON number（PHASE-005 補測 B-25） | AC-13/19 |
| B-21 | 實際費用含 3 位小數（`100.005`） | 400 `VALIDATION_ERROR`（超過 `Decimal(_,2)` 之小數位），**不得**靜默捨入（CHORE-003 合約） | AC-03 |
| B-22 | 實際費用為千分位／科學記號／`NaN`／`Infinity`／前後空白 | 前四者 400（分層 reason 各異）；前後空白 trim 後判定（沿 003a 慣例） | AC-03 |
| B-23 | 里程表整數位超出 `Decimal(10,2)` 容量 | 400 容量層 reason，**不得** 500 | AC-03 |
| B-24 | 費用 × 比例之結果超出 `Decimal(14,4)` 或 int4 容量 | 草稿／預覽即暴露 `AMOUNT_OUT_OF_RANGE`；完成以 4xx 拒絕（§16 D10）；**絕不 500／截斷** | AC-19 |
| B-25 | 附件恰 5 張 | 允許儲存 | AC-21 |
| B-26 | 同一 `PUT` 之 `attachmentIds[]` 自身即含 6 個 id | 409 `TOO_MANY_ATTACHMENTS`，整份 rollback | AC-21 |
| B-27 | `attachmentIds[]` 含他人擁有之附件 | 403 `FORBIDDEN`（附件擁有人與申請擁有人不一致，沿 PHASE-004 AC-30 既有訊息） | AC-21 |
| B-28 | `attachmentIds[]` 含已 `LINKED` 至其他容器之附件 | 409 `CONFLICT`（沿既有訊息） | AC-21 |
| B-29 | 刪除保養草稿（`DELETE /applications/:id`） | 允許；其 `refType="MAINTENANCE"` 之 `LINKED` 附件須於**同一交易**內 detach 回 TEMP——**現況 `deleteApplication` 只 detach `TRIP_SEGMENT`，本 Phase 必須補**（見 §17.1） | AC-04/23 |
| B-30 | 保養草稿與其附件之併發：完成 vs 刪除附件 | `SERIALIZABLE` + 重試；恰一方成功，另一方 403／409，不得 500（沿 PHASE-004 R4 之 S-1 修法） | AC-23/29 |
| B-31 | 相鄰兩筆保養申請共用邊界日（前一筆之本次保養日 ＝ 後一筆之上次保養日） | 該日之差旅被**兩筆**保養同時計入。US 未禁止；本 Phase 之處置見 §16 **D12**（推薦：不阻擋、列已知限制） | §17.1 |
| B-32 | 時區 | 一律 UTC 日粒度（`@db.Date`），沿用 `parseUtcDate`／`utcDateOnly`／`formatUtcDate`；**不得**引入本地時區換算 | AC-11 |
| B-33 | 完成端點 body 夾帶任意欄位（含非物件頂層 body） | 一律忽略；不得 500（沿 PHASE-004 AC-54） | AC-20 |
| B-34 | `GET /applications/maintenance/:id` 之 `:id` 指向差旅申請 | **404 `NOT_FOUND`**（型別不符即視為找不到，沿 `getTravelApplication` 既有語意），不得洩漏該筆為差旅 | AC-05 |
| B-35 | 重複 query key（如 `?ownerId=a&ownerId=b`） | 400 `VALIDATION_ERROR`（沿 PHASE-005 T6-AR-1 之既有收斂），不得 500 | AC-40 |

---

## 6. 權限與敏感資料

### 6.1 授權矩陣（**格數明列：8 欄 × 5 身分 = 40 格**）

身分：`未登入`／`mustChangePassword`／`一般使用者（本人）`／`一般使用者（他人資料）`／`管理員`。

| # | 端點／動作 | 未登入 | PCR | 一般（本人） | 一般（他人） | 管理員 |
|---|---|---|---|---|---|---|
| 1 | `POST /applications/maintenance` | 401 | 403 PCR | **201**（owner＝自己） | n/a（無 ownerId 參數） | **201**（owner＝自己） |
| 2 | `GET /applications/maintenance/:id` | 401 | 403 PCR | **200** | 403 | **200** |
| 3 | `PUT /applications/maintenance/:id` | 401 | 403 PCR | **200**（DRAFT）／403（COMPLETED） | 403 | **200**（DRAFT，寫稽核）／403（COMPLETED） |
| 4 | `DELETE /applications/:id`（保養） | 401 | 403 PCR | **200**（DRAFT）／403（COMPLETED） | 403 | **200**（DRAFT）／403（COMPLETED） |
| 5 | `POST /applications/maintenance/preview`（依 D6） | 401 | 403 PCR | **200**（自己） | 403（帶他人 `ownerId`） | **200**（可指定任一 `ownerId`） |
| 6 | `POST /applications/:id/complete`（保養） | 401 | 403 PCR | **200** | 403 | **403**（D7：不提供代完成） |
| 7 | `POST /admin/users/:userId/applications/maintenance` | 401 | 403 PCR | 403 | 403 | **201**（owner＝U，createdBy＝admin，寫稽核） |
| 8 | `GET /attachments/:id/content｜thumbnail`（保養證明） | 401 | **200**（沿 PHASE-003 D8，人類 2026-08-01 批准：附件讀取不掛 requirePasswordChanged；見 PHASE-003 Spec D8 與 attachment/routes.ts 實作註記） | **200** | 403 | **200** |

> **資料隔離不變式**（沿 PHASE-004 §6.2）：授權一律以 **DB 載入之 `Application.ownerId`／`Attachment.ownerId`** 為權威，**絕不**採用請求夾帶之任何識別值。`resolveOwnerId` 為「可指定擁有人」查詢之**唯一**判定實作，本 Phase 不得重寫。
> **判定順序**：授權（401/403）**先於**格式驗證（400），沿 PHASE-005 B-26 之既有裁定，避免以 400/403 差異洩漏側信道；須有明文測試固定此順序。

### 6.2 稽核

- 代操作建立／修改沿用既有 `AuditAction.APPLICATION_CREATED_ON_BEHALF`／`APPLICATION_UPDATED_ON_BEHALF`，以 `summary.type = "MAINTENANCE"` 區分；**不新增 enum 值**（AC-01(f)）。
- 稽核寫入與業務寫入**同交易**（AC-30）；`summary` 不含密碼／token／session cookie。
- 本人自建／自改**不寫稽核**（沿 PHASE-004 AC-86）。

### 6.3 敏感資料

- 保養證明圖片一律經後端授權端點回傳；持久化 volume **不得**由 nginx 靜態直出（ARCHITECTURE §4.5）。
- 日誌不得記錄附件位元組、`storageKey` 之外部可猜測形式、實際費用以外之個資。
- **「不得以一般使用者不知道單價為安全前提」（PHASE-004 D6 修訂，2026-08-02 人類批准）於本 Phase 之落地**：保養分攤**不使用任何補助參數單價**，故本 Phase 不引入新的單價揭露面；但預覽端點會回傳「該使用者於任意期間之公務總里程」——此與既有 `GET /statistics/mileage` 之揭露面**完全相同**（同一引擎、同一 `resolveOwnerId` 授權），**不構成新的授權擴張**。任何「以他人不知道自己里程為安全前提」之設計一律禁止。

---

## 7. API Contract

> 路徑不含 `/api` 前綴（nginx 剝除）。**標「推薦」者依 §16 相應決策點裁定後定案。**

### 7.1 端點總表

| 方法 | 路徑 | 說明 | 成功回應 |
|---|---|---|---|
| POST | `/applications/maintenance` | 建立保養草稿（body 全選填） | 201 `{ application: MaintenanceApplicationDto }` |
| GET | `/applications/maintenance/:id` | 讀取保養申請 | 200 `{ application: MaintenanceApplicationDto }` |
| PUT | `/applications/maintenance/:id` | 更新草稿（含 `attachmentIds[]`） | 200 `{ application: MaintenanceApplicationDto }` |
| DELETE | `/applications/:id` | **既有 generic 端點**，本 Phase 補 MAINTENANCE 附件 detach | 200 `{ ok: true }` |
| POST | `/applications/maintenance/preview` | **推薦新增**（§16 D6）；stateless 預覽 | 200 `{ preview: MaintenanceComputedDto }` |
| POST | `/applications/:id/complete` | **既有 generic 路徑**，依 `Application.type` 分派至保養完成流程 | 200 `{ application: MaintenanceApplicationDto }` |
| POST | `/admin/users/:userId/applications/maintenance` | 管理員代建立 | 201 `{ application: MaintenanceApplicationDto }` |

> `POST /applications/:id/complete` 沿用**同一路徑**依型別分派（該路徑本即與型別無關）——**推薦**；替代方案為另開 `/applications/maintenance/:id/complete`（會使前端與 E2E 出現兩套完成路徑，不建議）。此為公開 API contract，列入 §16 D6 之附帶裁定。

### 7.2 DTO 形狀（推薦）

```
MaintenanceApplicationDto {
  id: string
  type: "MAINTENANCE"
  status: "DRAFT" | "COMPLETED" | "VOIDED"
  ownerId: string
  ownerDisplayName: string
  createdById: string
  onBehalf: boolean                       // createdById !== ownerId
  primaryDate: string                     // YYYY-MM-DD
  createdAt: string; updatedAt: string    // ISO8601

  lastMaintenanceDate:    string | null   // YYYY-MM-DD
  currentMaintenanceDate: string | null
  lastOdometerKm:         string | null   // Decimal 字串，固定 2 位小數
  currentOdometerKm:      string | null
  actualCost:             string | null   // Decimal 字串，固定 2 位小數

  attachments: AttachmentDto[]            // 沿用 PHASE-003 既有形狀
  completionBlockers: Blocker[] | null    // DRAFT 才有；COMPLETED 為 null
  computed:  MaintenanceComputedDto | null// DRAFT 才有
  snapshot:  MaintenanceSnapshotDto | null// COMPLETED 才有
}

MaintenanceComputedDto {
  calculable: boolean
  intervalKm:    string | null   // 2 位小數，未取整
  officialKm:    string | null   // 2 位小數，未取整
  officialApplicationCount: number | null   // 僅供顯示，AC-15(b)
  ratio:         string | null   // 6 位小數（比值）
  ratioPercent:  string | null   // 4 位小數（百分比）
  rawAmount:     string | null   // 4 位小數，取整前
  amount:        number | null   // 新臺幣整數，取整後
  blockingCodes: string[]        // 不可計算之原因代碼（見 §7.4）
}

MaintenanceSnapshotDto {
  intervalKm: string      // 2 位小數
  officialKm: string      // 2 位小數
  ratio: string           // 6 位小數
  ratioPercent: string    // 4 位小數
  actualCost: string      // 2 位小數（＝完成當時之欄位值，見 §16 D11）
  rawAmount: string       // 4 位小數
  totalAmount: number     // 整數（＝ Application.totalAmount）
  calculatedAt: string    // ISO8601
}
```

> **金額與里程一律以字串傳輸**（沿 PHASE-003a／004／005 之既有 DTO 紀律），下游以 `Decimal(字串)` 還原無損；**不得**改用 JSON number。

### 7.3 期間公務里程之引擎呼叫（不得重寫）

```
sumOfficialMileage(tx, {
  ownerId: application.ownerId,        // 絕不為操作者
  dateFrom: lastMaintenanceDate,       // 含當日
  dateTo:   currentMaintenanceDate,    // 含當日
}) → { totalKm: Prisma.Decimal, applicationCount: number }
```
`totalKm` 為**唯一**進入金額計算之值；`applicationCount` 僅映射至 `computed.officialApplicationCount` 供顯示（AC-15）。

### 7.4 完成阻擋碼（blocker codes）與固定順序

| 順序 | code | 觸發條件 | zh-TW 訊息（推薦） |
|---|---|---|---|
| 1 | `LAST_MAINTENANCE_DATE_REQUIRED` | 上次保養日期為 null | 請填寫上次保養日期 |
| 2 | `CURRENT_MAINTENANCE_DATE_REQUIRED` | 本次保養日期為 null | 請填寫本次保養日期 |
| 3 | `MAINTENANCE_DATE_ORDER_INVALID` | 兩者皆有值且 `本次 ≤ 上次` | 本次保養日期必須晚於上次保養日期 |
| 4 | `LAST_ODOMETER_REQUIRED` | 上次里程表為 null | 請填寫上次里程表數值 |
| 5 | `CURRENT_ODOMETER_REQUIRED` | 本次里程表為 null | 請填寫本次里程表數值 |
| 6 | `ODOMETER_ORDER_INVALID` | 兩者皆有值且 `本次 ≤ 上次` | 本次里程表數值必須大於上次里程表數值 |
| 7 | `ACTUAL_COST_REQUIRED` | 實際費用為 null | 請填寫本次實際保養費用 |
| 8 | `ACTUAL_COST_INVALID` | 實際費用 `≤ 0` | 本次實際保養費用必須大於 0 |
| 9 | `OFFICIAL_KM_EXCEEDS_INTERVAL` | `期間公務里程 > 保養區間里程` | 期間公務里程大於保養區間里程，請檢查差旅、日期或里程資料 |
| 10 | `MAINTENANCE_ATTACHMENT_REQUIRED` | `LINKED` 附件數 < 1 | 請至少上傳 1 張保養證明 |
| 11 | `AMOUNT_OUT_OF_RANGE` | 計算結果超出欄位容量 | 計算結果超出可儲存之金額範圍，請檢查里程與費用 |

> **互斥規則（AC-10）**：`*_REQUIRED` 在場時，同組之 `*_ORDER_INVALID` 不重複回報；第 9、11 項僅在前 8 項全通過時才可能出現（否則無法計算）。
> 完成端點之拒絕形狀：**400 `VALIDATION_ERROR`** ＋ `fields[]`（僅具欄位路徑者）＋ `details.blockers[]`（**永遠是完整清單**），沿 PHASE-004 D14(i) 既有形狀。第 11 項之最終形狀依 §16 **D10** 裁定。

### 7.5 錯誤合約

沿用 PHASE-003a §14.2 之分層與文案表、PHASE-001 §5.2 之統一形狀。**本 Phase 不新增任何 `ErrorCode`**（AC-39）。使用之碼：`VALIDATION_ERROR`(400)、`UNAUTHORIZED`(401)、`FORBIDDEN`(403)、`PASSWORD_CHANGE_REQUIRED`(403)、`NOT_FOUND`(404)、`CONFLICT`(409)、`TOO_MANY_ATTACHMENTS`(409)、`UNSUPPORTED_MEDIA_TYPE`(415)、`PAYLOAD_TOO_LARGE`(413)、`INTERNAL_ERROR`(500)、`SERVICE_UNAVAILABLE`(503)。

---

## 8. 資料模型與 migration

### 8.1 不新增 enum

`ApplicationType.MAINTENANCE`、`AttachmentRefType.MAINTENANCE`、`ApplicationStatus`、`AuditAction` 之既有值皆已足夠（AC-01(f)）。

### 8.2 新增資料表（推薦形狀，容量依 §16 D3 裁定）

```prisma
model MaintenanceApplication {
  applicationId String      @id
  application   Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)

  // ── 業務欄位（草稿可為 null；完成後不可變）──
  lastMaintenanceDate    DateTime? @db.Date   // 上次保養日期（日粒度，含當日）
  currentMaintenanceDate DateTime? @db.Date   // 本次保養日期（＝ primaryDate 之來源）
  lastOdometerKm         Decimal?  @db.Decimal(10, 2)
  currentOdometerKm      Decimal?  @db.Decimal(10, 2)
  actualCost             Decimal?  @db.Decimal(12, 2)   // 新臺幣，>0 方可完成

  // ── 完成快照（BE-US-18）；一經寫入不可變 ──
  snapshotIntervalKm Decimal?  @db.Decimal(12, 2)  // 本次 − 上次 里程表
  snapshotOfficialKm Decimal?  @db.Decimal(12, 2)  // 期間公務里程（＝ sumOfficialMileage.totalKm）
  snapshotRatio      Decimal?  @db.Decimal(9, 6)   // 公務比例（比值，0 ≤ r ≤ 1）
  snapshotRawAmount  Decimal?  @db.Decimal(14, 4)  // 取整前分攤金額
  calculatedAt       DateTime?
  // 註：最終金額落於既有 `Application.totalAmount`（Int），不重複持久化。
  //     實際費用之快照＝ `actualCost` 欄位本身（完成後凍結），見 §16 D11。

  @@index([currentMaintenanceDate])
}
```

`Application` 模型新增一條 relation：`maintenance MaintenanceApplication?`（與既有 `travel TravelApplication?` 對稱；不改任何既有欄位與索引）。

### 8.3 欄位容量與精度之推導依據（§16 D3 之技術背景）

| 欄位 | 推薦型別 | 容量上界 | 依據 |
|---|---|---|---|
| `lastOdometerKm`／`currentOdometerKm` | `Decimal(10,2)` | `|v| < 1e8` | 與 `TripSegment.totalKm` 一致；里程表 1 億公里遠超實務 |
| `actualCost` | `Decimal(12,2)` | `|v| < 1e10` | 與 `DepreciationParameterVersion.vehiclePrice` 一致 |
| `snapshotIntervalKm`／`snapshotOfficialKm` | `Decimal(12,2)` | `|v| < 1e10` | 與 `TravelApplication.snapshotTotalKm` 一致（後者為 `Decimal(12,2)`） |
| `snapshotRatio` | `Decimal(9,6)` | `|v| < 1000` | 比例 ≤ 1（AC-18 已擋 > 1）；6 位小數為顯示精度，**不參與金額計算**（AC-17(a)） |
| `snapshotRawAmount` | `Decimal(14,4)` | `|v| < 1e10` | 與 `TravelApplication.snapshotRawAmount` 一致 |
| `Application.totalAmount` | `Int`（int4） | `≤ 2147483647` | 既有欄位 |

> **容量缺口（必須守門）**：`actualCost` 上界 `~1e10` × 比例 `1.0` ＝ `~1e10`，**超過 int4 上界 2.147e9**。故 AC-19 之容量守門為**必要**，非防禦性冗餘。其呈現形狀見 §16 **D10**（含「改為收緊 `actualCost` 至 `Decimal(9,2)`」之替代方案）。

### 8.4 migration 順序與可逆性

- **M1**：`CREATE TABLE "MaintenanceApplication"`（含 FK 至 `Application`、`@@index`）。
- **零 `ALTER`**：既有表**完全不動**（`Application` 之新 relation 為 Prisma schema 層之反向關聯，不產生 DDL）。
- **零回填**：新表建立時無任何列。
- **回滾**：`DROP TABLE "MaintenanceApplication"`。**補償步驟**：若回滾時已存在 `refType='MAINTENANCE'` 之 `LINKED` 附件，須先將其 detach 回 `TEMP`（清 `refType`/`refId`/`linkedAt`、重設 `createdAt`），否則成為指向不存在容器之孤兒（`deriveContainerState` 之孤兒分支會回 `'draft'`，不致 500，但語意錯誤）。列為 rollback 手冊步驟。
- **安全網測試**（比照 PHASE-005a T1）：`backend/test/integration/phase6-migration-safety.test.ts` — 既有 DB 逐表逐欄位值比對、乾淨 DB 全新套用、表數 13→14。

---

## 9. Data Flow（本 Phase 影響部分）

### 9.1 草稿儲存（含附件對帳）

```
PUT /applications/maintenance/:id
  → requireAuth + requirePasswordChanged
  → 載入 Application（含 maintenance）→ 404（不存在／型別非 MAINTENANCE）
  → assertOwnershipOrAdmin(actor, application.ownerId)          [授權，DB 權威]
  → assertApplicationMutable(status)                            [外層快速失敗]
  → 欄位格式／容量驗證（CHORE-003 分層）→ 400 fields[]
  → SERIALIZABLE tx：
       SELECT ... FOR UPDATE on Application
       assertApplicationMutable(freshStatus)                    [交易內再驗，M-2 教訓]
       更新 MaintenanceApplication 五欄 + Application.primaryDate（＝本次保養日期）
       附件對帳：computeMaintenanceAttachmentDeltas → detach(移除者) → linkAttachmentTx(新增者, limit=5)
       代操作時 onUpdated hook 寫 AuditLog（同交易）
  → 回應 DTO（含 completionBlockers + computed）
```

### 9.2 分攤預覽（讀取路徑）

```
POST /applications/maintenance/preview   （或 GET/PUT 回應內嵌 computed，依 D6）
  → resolveOwnerId(actor, body.ownerId)                          [一般使用者帶他人 → 403]
  → 欄位驗證（同 9.1）
  → intervalKm = currentOdometerKm − lastOdometerKm
  → sumOfficialMileage(prisma, { ownerId, dateFrom, dateTo })     [唯讀，零寫入]
  → calculateMaintenance({ actualCost, officialKm, intervalKm })
  → 容量判定 → MaintenanceComputedDto
```
**零寫入不變式**：預覽路徑**絕不**寫入任何資料列（比照 PHASE-004 AC-36），須有測試證明。

### 9.3 完成與快照寫入

```
POST /applications/:id/complete
  → requireAuth + requirePasswordChanged
  → 載入 Application → 依 type 分派（MAINTENANCE → 本流程）
  → 嚴格 actor.id === ownerId                                     [D7；不用 assertOwnershipOrAdmin]
  → SERIALIZABLE tx（重試 6 次）：
       ① assertTransition(status, "COMPLETED")                    → 非 DRAFT → 403
       ② attachmentCount = count(LINKED, MAINTENANCE, id)
          blockers = computeMaintenanceBlockers({ 五欄, attachmentCount, officialKm, intervalKm })
          非空 → 400 VALIDATION_ERROR + fields[] + details.blockers[]
       ③ { totalKm, applicationCount } = sumOfficialMileage(tx, {...})   [同交易]
       ④ result = calculateMaintenance({...})；容量守門 → 4xx（D10），**寫入前**拒絕
       ⑤a MaintenanceApplication.update(snapshotIntervalKm/OfficialKm/Ratio/RawAmount/calculatedAt)
       ⑤b Application.update(status=COMPLETED, totalAmount, completedAt)
  → 回應 DTO（含 snapshot；completionBlockers=null、computed=null）
```
> ②與③④之順序不可對調：完成度未過時**不查詢**期間里程（省一次聚合，且錯誤語意單一）。惟 `OFFICIAL_KM_EXCEEDS_INTERVAL`（第 9 項）需要 ③ 之結果——故 blockers 之計算分兩段：**結構性條件（1~8、10）先算**；若已非空即拒絕；全通過才執行 ③，再算 **9、11** 並二次判定。此兩段式須於 §11.1 之純函式簽章上明確反映（`computeMaintenanceBlockers` 接受 `officialKm?: Decimal | null`，`null` 表「尚未查詢」而**不**產生第 9/11 項）。

---

## 10. 非功能需求

1. **精度紀律**：全程 `Prisma.Decimal`／DB `numeric`，**禁止任何浮點中介**；`Decimal` 建構一律傳字串或既有 `Decimal`；`toNumber()` 僅可於「已取整為整數之後」使用（沿 PHASE-004 `travel-calculation.ts` 之既有宣告）。以結構性掃描測試守門（AC-17(d) 浮點鑑別 ＋ 零 `Number()`/`parseFloat`/`parseInt` 掃描）。
2. **效能**：期間公務里程以 DB 層單次聚合完成，不將命中集合讀入記憶體、不 N+1、不分頁；保養列表沿用既有 `Application` 索引（`[ownerId, status, primaryDate]`／`[ownerId, primaryDate]`），**不新增索引**（沿 PHASE-005 D9(a)；索引評估仍列 PHASE-011）。
3. **交易紀律**：所有寫入路徑 `SERIALIZABLE` ＋ 重試；**storage I/O 一律不在 DB 交易內**（沿 PHASE-004 D16）。
4. **可觀測性**：錯誤仍有日誌，內容依 AC-40 之禁列表 sanitize。
5. **相容性**：既有 1468 後端／180 前端／23 E2E 測試**零弱化**（不得刪除、`skip`、`only`、放寬斷言）；任何既有測試需調整必須在 Handoff 逐條說明理由與增刪計數。

---

## 11. 測試策略

### 11.0 測試紀律（強制，寫入每個 Task Packet）

- **TDD**：先寫會失敗的測試；Handoff 須附「修復前紅燈」之實際輸出。
- **禁止**刪除／弱化／`skip` 既有測試換綠燈。
- **鑑別力**：金額類測試一律精確等值；每個關鍵規則須有 mutant 自證（改壞實作必紅）。
- **INFRA-001 併跑限制持續有效**：不得同時派工兩個會跑 vitest 的 agent（per-worker schema 槽位共用）。
- **新增 src 檔須同步入結構性掃描清單**（沿 PHASE-005a AR-B 之機械項）。

### 11.1 單元（Vitest，不需 DB）

| 對象 | 檔案 | 重點 |
|---|---|---|
| `calculateMaintenance`（純函式） | `backend/test/unit/maintenance-calculation.test.ts` | AC-06/16/17/19 判定；**取整規則 kill pair**（`0.5→1` 與 `1.5→2`）；**取整層級 kill case**（`P=1500000, O=2, I=3` → 1000000，先取整比例得 1000001 必紅）；除零／`NaN`／`Infinity` 防禦；容量 predicate 邊界（恰 `1e10 − ε` 通過、`1e10` 拒絕；`2147483647` 通過、`2147483648` 拒絕）；零浮點掃描 |
| `computeMaintenanceBlockers`（純函式） | `backend/test/unit/maintenance-blockers.test.ts` | AC-07/08/09/10/18/22；順序穩定性；互斥規則；`officialKm=null` 兩段式語意；最小鑑別對（`本次=上次+1日`、`+0.01 km`、`0.01 元`、`O=I` 通過／`O=I+0.01` 擋） |

### 11.2 整合（Vitest ＋ PostgreSQL ＋ 真實 route）

| 對象 | 檔案 | 重點 |
|---|---|---|
| migration 安全網 | `phase6-migration-safety.test.ts` | AC-01(a)~(f)；五表逐欄零改寫；乾淨／既有 DB 各一輪；突變自證（改寫任一既有欄位必紅） |
| 草稿 CRUD | `phase6-maintenance-draft.test.ts` | AC-02/03/04/05；分層 gate table（比照 AC-06/AC-11 之 003a 慣例）；B-21~B-23、B-34、B-35 |
| 期間公務里程 | `phase6-official-mileage.test.ts` | AC-11~15；B-08~B-20（含 PHASE-005 補測 B-12/15/17/19/24/25）；引擎 import 接線斷言＋突變自證 |
| 附件 | `phase6-maintenance-attachment.test.ts` | AC-21~24；B-25~B-30；`deriveContainerState` 之 MAINTENANCE 分支修復前紅燈；`deleteApplication` detach 補洞之修復前紅燈 |
| 完成與快照 | `phase6-maintenance-complete.test.ts` | AC-25/26/27；交易原子性切點；快照重現性重算 |
| 不可變與權威 | `phase6-snapshot-immutability.test.ts` | AC-19(接線)/20/28/29；夾帶矩陣；spy 零重查；併發恰一成功 |
| 代操作 | `phase6-on-behalf.test.ts` | AC-30/31；稽核欄位精確；同交易回滾（真交易，非 stub） |
| 綜合列表 | `phase6-application-list.test.ts` | AC-32/33；混合排序全序；不適用欄 `null` |
| 錯誤合約與日誌 | `phase6-contract.test.ts` | AC-39/40；頂層鍵集合封閉；`logStream` 掃描 |

### 11.3 前端（Vitest ＋ Testing Library，mock fetch）

| 對象 | 檔案 | 重點 |
|---|---|---|
| 保養申請頁 | `frontend/test/MaintenanceApplicationPage.test.tsx` | AC-34~37；**前端零自算鑑別**：mock 後端回傳「刻意與前端可自算之值不同」之 `ratioPercent`／`amount`，斷言畫面顯示後端值（防止前端偷算）；不可計算不得顯示 `0`；Permission denied 之零寫入呼叫斷言 |
| 綜合列表 | `frontend/test/ApplicationListSection.test.tsx`（既有檔擴充） | 保養列類型標籤與「—」呈現；**既有斷言零改動** |

### 11.4 E2E（Playwright，整合 Gate）

`e2e/maintenance-allowance.spec.ts` — AC-41 八步情境 ＋ AC-38 之 375px 無溢位。播種**冪等**（先查後建）。

### 11.5 安全測試

- 授權矩陣 40 格逐格（§6.1），403 路徑須有 **DB 零寫入**實證。
- 附件跨使用者存取（AC-24）。
- 判定順序無側信道（403 先於 400）。
- 日誌敏感鍵掃描（AC-40）。

### 11.6 PHASE-005 補測清單 B-12/15/17/19/24/25 之處置（**spec-writer 裁定，記錄備查**）

**全部六條納入本 Phase**，落點 `phase6-official-mileage.test.ts`（對應本 Spec 之 B-12、B-15、B-16、B-17、B-19、B-20）。理由：六條全部直接關係到**保養分攤之分子正確性**（期間公務里程），在本 Phase 補測之邊際成本近乎零（同一測試檔、同一播種工具），而延至 PHASE-011 則等於讓金額核心帶著未測邊界上線。**不列入 PHASE-011。** 此為測試策略決定，屬 spec-writer 可自主範圍（§修改權限分級「增加測試案例與邊界條件」）。

---

## 12. AC ↔ 測試映射表（機械可查；隨 Task 完成更新「狀態」欄）

> **格式**：`AC` ｜ `層級` ｜ `測試檔（預定路徑）` ｜ `測試名（預定名稱）` ｜ `Task` ｜ `狀態`
> 狀態值：`PENDING`（Spec 階段）／`RED`（測試已寫且失敗）／`GREEN`（實作完成通過）。
> **Phase 完成前之覆蓋檢查與終審核對以本表為準**（治理 2026-08-02.1）。
> **`GREEN` 列之測試名須為實際存在之測試名（逐字可 `grep`）；`PENDING` 列為預定名稱**，落地後依 `vitest --reporter=verbose` 之實際輸出**逐字回填**。

| AC | 層級 | 測試檔 | 測試名（預定） | Task | 狀態 |
|---|---|---|---|---|---|
| AC-01 | integration | `backend/test/integration/phase6-migration-safety.test.ts` | `PHASE-006-T1 migration safety net > AC-01(b): every pre-existing column across all five tables is byte-for-byte unchanged after migration`；`… AC-01(c): MaintenanceApplication is created empty (zero backfill)`；`… AC-01(d): migrate succeeds on a clean DB and on an existing DB`；`… AC-01(f): no new enum value is introduced (ApplicationType/AttachmentRefType/AuditAction unions equal baseline)` | T1 | GREEN（T1 `d7b5d19`＋T1R `e653974`；實名逐子款：(a)(e)＝`clean DB > full-null draft row…`＋`precision round-trip: 10,2/12,2/9,6/14,4…`；(b)＝`existing DB > …every pre-existing column, across all five representative tables, is byte-for-byte unchanged`（T1R 後為 AC-01(b) 七表：五表字面＋FuelPriceVersion/UserFuelConsumptionVersion 加值）；(c)＝`the new MaintenanceApplication table exists and is empty`＋鍵集全等守門；(d)＝existing/clean 兩條 migrate deploy；(f)＝`enum union baseline — …exactly match the pre-T1 set`＋infra001 七具名型別清單 | 
| AC-02 | integration | `backend/test/integration/phase6-maintenance-draft.test.ts` | `POST /applications/maintenance > AC-02 creates a DRAFT with an empty body (all five fields null, blockers listed)`；`PUT … > AC-02 partial update keeps unspecified fields unchanged (three-state key semantics)` | T4 | GREEN（T4 `4b4ecc2`：空 body 201/三態語意逐欄/completionBlockers 第一段；兩輪 1604 全綠） |
| AC-03 | integration | `phase6-maintenance-draft.test.ts` | `PUT /applications/maintenance/:id > AC-03 ordered gate table: $label returns its own reason (400, never 500)`（it.each，涵蓋日期格式／非數字／千分位／科學記號／3 位小數／容量超出／NaN／Infinity）；`… > AC-03 boundary positives are accepted (0.01 cost, 0.01 km, leading/trailing spaces trimmed)` | T4 | GREEN（T4 `4b4ecc2`＋T4R `9b29158`：gate table 19 組×POST/PUT 雙路徑、分層文案逐字釘住（V12 mutant 恰 1 紅）、五邊界正例） |
| AC-04 | integration | `phase6-maintenance-draft.test.ts` | `AC-04 completed maintenance rejects PUT with 403 and the verbatim 已完成的申請不可修改，請建立修正版 message (zero DB writes)`；`… > and rejects DELETE with 403` | T4 | GREEN（T4 `4b4ecc2`＋T4R：COMPLETED PUT/DELETE 403＋updatedAt 逐毫秒零寫入＋雙守門 mutant（V7/V8）＋本人+畸形 body 403 順序釘住（V10 mutant 恰 1 紅）） |
| AC-05 | integration | `phase6-maintenance-draft.test.ts` | `AC-05 授權隔離 > another normal user gets 403 on GET/PUT/DELETE and no business field leaks`；`… > unauthenticated → 401`；`… > mustChangePassword → 403 PASSWORD_CHANGE_REQUIRED`；`… > B-34: :id pointing at a TRAVEL application returns 404, never leaks its type` | T4 | GREEN（T4 `4b4ecc2`：他人 403 不洩欄位/未登入 401/PCR 403/404 語意/B-34 型別不洩漏；reviewer 十條 wire 探針獨立驗證） |
| AC-06 | unit | `backend/test/unit/maintenance-calculation.test.ts` | `calculateMaintenance — AC-06 intervalKm equals current − last odometer (exact Decimal table)`；`… > minimal positive interval 0.01 is computed, not rejected` | T2 | GREEN（T2 `fc48e20`；驗表 5 列 verbose 逐字在場） |
| AC-07 | unit | `backend/test/unit/maintenance-blockers.test.ts` | `computeMaintenanceBlockers — AC-07 current ≤ last maintenance date yields MAINTENANCE_DATE_ORDER_INVALID (equal and earlier)`；`… > current = last + 1 day is accepted (discriminating positive)` | T3 | GREEN—unit（T3 `0f74838`：describe `computeMaintenanceBlockers — AC-07 current <= last maintenance date yields MAINTENANCE_DATE_ORDER_INVALID (equal and earlier)` 三條；整合接線待 T7） |
| AC-08 | unit | `maintenance-blockers.test.ts` | `computeMaintenanceBlockers — AC-08 current ≤ last odometer yields ODOMETER_ORDER_INVALID (equal and smaller)`；`… > current = last + 0.01 is accepted` | T3 | GREEN—unit（T3 `0f74838`：describe `… AC-08 current <= last odometer yields ODOMETER_ORDER_INVALID (equal and smaller)` 三條；整合待 T7） |
| AC-09 | unit | `maintenance-blockers.test.ts` | `computeMaintenanceBlockers — AC-09 actualCost ≤ 0 yields ACTUAL_COST_INVALID (0 and -0.01)`；`… > 0.01 is accepted` | T3 | GREEN—unit（T3 `0f74838`：describe `… AC-09 actualCost <= 0 yields ACTUAL_COST_INVALID (0 and -0.01)` 三條；整合待 T7） |
| AC-10 | unit | `maintenance-blockers.test.ts` | `computeMaintenanceBlockers — AC-10 returns EVERY unmet condition, never only the first, in the §7.4 fixed order`；`… > AC-10 mutual exclusion: a missing field never also reports its ORDER_INVALID counterpart`；`… > AC-10 two-phase: officialKm=null suppresses OFFICIAL_KM_EXCEEDS_INTERVAL and AMOUNT_OUT_OF_RANGE`（實際名尾綴 `…even when the interval is trivially small and amountOutOfRange=true`；互斥拆 date/odometer 兩條；另 `shuffled violation…fixed §7.4 order` 與 `9 before 10 before 11`） | T3 | GREEN（T3 `0f74838`；mutant B/D/E/F 全紅獨立重現） |
| AC-11 | integration | `backend/test/integration/phase6-official-mileage.test.ts` | `AC-11 期間含當日 > trips on the last-maintenance date and on the current-maintenance date are BOTH included`；`… > trips one day outside either end are BOTH excluded`；`… > B-32: dates are compared at UTC day granularity` | T5 | GREEN（T5 `76abda9`：四點邊界＋UTC 日粒度；兩輪 1650 全綠） |
| AC-12 | integration | `phase6-official-mileage.test.ts` | `AC-12 納入條件 > drafts, voided, another user's trips and non-TRAVEL applications are all excluded (0.00)`；`… > only COMPLETED TRAVEL owned by the application owner contributes` | T5 | GREEN（T5 `76abda9`：納入條件矩陣（草稿/作廢/他人/異型別負例）＋等值比對） |
| AC-13 | integration | `phase6-official-mileage.test.ts` | `AC-13 高速里程不重複加總 > officialKm equals Σ snapshotTotalKm exactly, including a segment where highwayKm == totalKm`；`… > B-19: no 3-decimal value can originate from Decimal(_,2) sources`；`… > B-20: 101 completed trips aggregate without overflow and stay a string` | T5 | GREEN（T5 `76abda9`＋T5R `3e7b59d`：真實 TripSegment fixture 含 highwayKm==totalKm 邊界、精確等值） |
| AC-14 | integration | `phase6-official-mileage.test.ts` | `AC-14 引擎複用 > maintenance-service imports sumOfficialMileage from mileage-engine (source-level import assertion)`；`… > mutant self-proof: replacing the import with a private copy fails this test`；`… > ownerId passed to the engine is the application owner, never the acting admin` | T5 | GREEN（T5 `76abda9`：唯一呼叫點＋import 接線斷言＋私有複製突變 3 紅（reviewer M1 獨立重現）） |
| AC-15 | integration | `phase6-official-mileage.test.ts` | `AC-15 D2(a) 不對稱 > a COMPLETED trip with a NULL snapshotTotalKm yields applicationCount=1 but officialKm="0.00"`；`… > the amount computation uses totalKm only — applicationCount never influences ratio or amount`；`… > B-12: a draft trip with a null tripDate never throws` | T5 | GREEN（T5 `76abda9`：(d) 筆數≥1 但 0.00 明文測試；(b) 金額僅用 totalKm） |
| AC-16 | unit | `maintenance-calculation.test.ts` | `calculateMaintenance — AC-16 ratio = officialKm ÷ intervalKm (exact six-decimal table)`；`… > ratio and ratioPercent are consistent (percent = ratio × 100) and both are strings`；`… > intervalKm = 0 never divides by zero, never returns NaN/Infinity — reported as not calculable` | T2 | GREEN（T2 `fc48e20`＋T2R `cdb7219` MF-1 三條 NaN/Infinity 防禦：describe `T2R MF-1: NaN/Infinity inputs never produce NaN/Infinity amounts or silent zeros`） |
| AC-17 | unit | `maintenance-calculation.test.ts` | `calculateMaintenance — AC-17 amount = ROUND_HALF_UP(cost × officialKm ÷ intervalKm, 0)`；`… > AC-17(d) rounding kill pair: 0.5 → 1 and 1.5 → 2 together discriminate HALF_UP from banker's rounding`；`… > AC-17(d) rounding-LEVEL kill case: cost=1500000, official=2, interval=3 → exactly 1000000 (pre-rounding the ratio to 6dp would yield 1000001)`；`… > AC-17(c) rounding happens exactly once (source-level scan: a single toDecimalPlaces call on the amount path)`；T2R SF-1 kill case：`… > T2R SF-1 kill case: cost=40431.36, official=0.25, interval=1.92 → 5265 (proves `actualCost.times(ratio)` mutant C is NOT equivalent, off by 1)` | T2 | GREEN（T2 `fc48e20`＋T2R `cdb7219`；mutant A/B/C/D 全紅實證） |
| AC-18 | unit + integration | `maintenance-blockers.test.ts`；`phase6-maintenance-complete.test.ts` | 單元：`computeMaintenanceBlockers — AC-18 officialKm > intervalKm yields OFFICIAL_KM_EXCEEDS_INTERVAL`；`… > officialKm == intervalKm (exactly 100%) is ACCEPTED`；`… > officialKm = intervalKm + 0.01 is blocked`；`… > the comparison uses raw Decimals, not the 6-decimal ratio (mutant: comparing rounded ratio lets intervalKm+1e-7 through)`。整合：`AC-18 完成端點 > ratio above 100% returns 400 with details.blockers containing OFFICIAL_KM_EXCEEDS_INTERVAL and the 檢查差旅、日期或里程資料 wording` | T3, T7 | GREEN（unit T3 `0f74838`＋整合 T7 `245d5f8`：完成端點 O>I → 400＋blocker＋「檢查差旅、日期或里程資料」逐字、O==I 成功對照；共用 isOfficialKmExceedsInterval 單一事實來源） |
| AC-19 | unit + integration | `maintenance-calculation.test.ts`；`phase6-maintenance-complete.test.ts`；`phase6-snapshot-immutability.test.ts` | 單元：describe `calculateMaintenance — AC-19 capacity guard: rawAmount ≥ 1e10 or amount beyond int4 is reported, never silently truncated`（十列含邊界正例與互斥語意）；整合 T7：`AC-19 容量守門（完成端點）` 之「超容量 400＋零快照寫入」與「邊界正例：合法大額組合完成成功」；整合 T8：`AC-19（整合層）` 之 DRAFT DTO 與 preview 雙處暴露 `AMOUNT_OUT_OF_RANGE` 兩條 | T2, T7, T8 | GREEN（T2 `fc48e20`＋T7 `245d5f8`＋T8 `062c3b7`；檔案歸屬依 T8 即審 SF-2 更正，無雙重宣稱） |
| AC-20 | integration | `phase6-snapshot-immutability.test.ts` | `AC-20 後端權威 > body carrying intervalKm/officialKm/ratio/rawAmount/amount/totalAmount is ignored on create, update, preview and complete`；`… > malformed injected VALUES never cause a 500`；`… > a non-object top-level body (null / string / array) never causes a 500` | T8 | GREEN（T8 `062c3b7`＋T8R `cf5fdaf`：13 欄×5 值型×四端點 it.each＋完成端點純量 kill 值＋DB 層斷言（M-E2 mutant 復活修復）＋query 維度三端點＋頂層非物件/ownerId 非字串 fail-closed；M-D 4/5 紅） |
| AC-21 | integration | `backend/test/integration/phase6-maintenance-attachment.test.ts` | `AC-21 上限 5 > linking a 6th attachment returns 409 TOO_MANY_ATTACHMENTS and rolls the whole PUT back`；`… > exactly 5 is accepted (boundary positive)`；`… > B-26: a single PUT declaring 6 ids is rejected`；`… > B-27/B-28: another user's attachment → 403; an already-LINKED attachment → 409`；`… > no public endpoint accepts a client-supplied limit/refId/containerState (POST /attachments/:id/link is 404)` | T6 | GREEN（T6 `ada74d1`：describe `AC-21 上限 5` 八條 verbose 實名（恰 5 正例／第 6 張 409 全 rollback／B-26/27/28／link 端點 404／同集 no-op／移除 detach）＋LIMIT 結構釘；mutant C/D/E 恰紅獨立重現） |
| AC-22 | integration | `phase6-maintenance-attachment.test.ts` | `AC-22 草稿可缺 > a draft with zero attachments saves successfully`；`… > completing with zero attachments returns 400 with MAINTENANCE_ATTACHMENT_REQUIRED`；`… > exactly 1 attachment is enough` | T6 | GREEN（T6 `ada74d1` 草稿段＋T7 `245d5f8` 完成段：零附件完成 400＋blocker、1 張成功；附件計數於完成 tx 內現算（B-30 真併發 36 輪雙向實證）） |
| AC-23 | integration | `phase6-maintenance-attachment.test.ts` | `AC-23 完成後鎖定 > DELETE /attachments/:id on a COMPLETED maintenance attachment returns 403 and changes nothing`；`… > pre-fix RED evidence: with deriveContainerState's MAINTENANCE branch returning 'draft', this deletion SUCCEEDS`；`… > B-29: deleting a maintenance DRAFT detaches its MAINTENANCE attachments back to TEMP in the same transaction` | T6 | GREEN（T6 `ada74d1`：`DELETE …COMPLETED… returns 403 and changes nothing (post-fix)`＋DRAFT 正例＋`B-29 …detaches…back to TEMP…(post-fix)`＋TRIP_SEGMENT 零變更；修復前紅燈以暫時回退法取得（測試檔頭據實說明），reviewer mutant A/B 獨立重現 200→403 與 LINKED→TEMP） |
| AC-24 | integration | `phase6-maintenance-attachment.test.ts` | `AC-24 附件授權 > owner can read content and thumbnail`；`… > another normal user gets 403 and zero file bytes`；`… > unauthenticated gets 401 for both content and thumbnail` | T6 | GREEN（T6 `ada74d1`：describe `AC-24 附件授權` 四條（owner／other 403 零位元組／anon 401／admin 代讀）；零新授權機制） |
| AC-25 | integration | `backend/test/integration/phase6-maintenance-complete.test.ts` | `AC-25 原子性 > a failure injected after the snapshot write rolls back the snapshot together with the (never-reached) status flip`；`… > successful completion flips status, totalAmount and completedAt in the same transaction` | T7 | GREEN（T7 `245d5f8`：八步驟同 tx（reviewer 逐行對照 §9.3）、切點回滾 mutant M1 六紅、FOR UPDATE 參數化、__testOnly 生產不可達實證） |
| AC-26 | integration | `phase6-maintenance-complete.test.ts` | `AC-26 快照齊備 > snapshot stores intervalKm / officialKm / ratio / actualCost / totalAmount (BE-US-18 five items) plus rawAmount and calculatedAt`；`… > recomputing cost × officialKm ÷ intervalKm from the snapshot reproduces rawAmount exactly`；`… > recomputing ROUND_HALF_UP(rawAmount) reproduces totalAmount exactly` | T7 | GREEN（T7 `245d5f8`＋T7R `9b9524d`：五項＋rawAmount＋calculatedAt、行內獨立重算雙重可重現（005a 先例同型）、S-2 kill case raw=0.499995→totalAmount=0（M2 mutant 必紅）、S-1 null 快照列 200/null 不 500） |
| AC-27 | integration | `phase6-maintenance-complete.test.ts` | `AC-27 完成僅本人 > an ADMIN completing another user's maintenance draft gets 403 and writes nothing`；`… > the owner completing their own draft succeeds (discriminating control)` | T7 | GREEN（T7 `245d5f8`：route 層嚴格 owner-only（不用 assertOwnershipOrAdmin，M4 mutant 紅）、admin 403 零寫入＋本人成功對照、401/PCR/他人全格） |
| AC-28 | integration | `phase6-snapshot-immutability.test.ts` | `AC-28 快照不可變 > adding and completing a new trip inside the maintenance period leaves all six snapshot values and totalAmount bit-identical`；`… > GET of a COMPLETED maintenance performs no official-mileage query (spy: DRAFT +1, COMPLETED +0)` | T8 | GREEN（T8 `062c3b7`：真實完成流程 fixture、drift 鑑別（M-C 紅 1029 vs 40）、逐位元字串比對、spy DRAFT+1/COMPLETED+0（M-B 紅）） |
| AC-29 | integration | `phase6-snapshot-immutability.test.ts` | `AC-29 併發完成 > two concurrent completions resolve to exactly one 200 and one 403, never a double snapshot, never a 500` | T8 | GREEN（T8 `062c3b7`：12 輪真併發恰一成功/一 403、零 500、單快照；503 覆蓋缺口記 AR-2） |
| AC-30 | integration | `backend/test/integration/phase6-on-behalf.test.ts` | `AC-30 代建立 > POST /admin/users/:userId/applications/maintenance sets ownerId=U, createdById=admin and writes one APPLICATION_CREATED_ON_BEHALF row`；`… > 代修改 writes APPLICATION_UPDATED_ON_BEHALF with before/after summary and no sensitive keys`；`… > audit and business writes share one transaction (real $transaction rollback evidence)`；`… > unknown userId → 404 with zero rows created` | T9 | GREEN—待 SF-4 裁定註記（T9 `7b8b218`＋T9R：稽核精確（M1/M2/M3/M4/M5/M8 killed）、tx client 釘住（M4b 雙側必紅）、summary 五欄值（M9 必紅）、count===1、真回滾、404 零列；SF-4 停用者不對稱交人類裁定中） |
| AC-31 | integration | `phase6-on-behalf.test.ts` | `AC-31 管理員不得改已完成 > admin PUT on a COMPLETED maintenance returns 403 請建立修正版 with zero DB writes` | T9 | GREEN（T9 `7b8b218`：admin PUT COMPLETED 403「請建立修正版」＋零寫入；D7(a) 負向 complete 403） |
| AC-32 | integration | `backend/test/integration/phase6-application-list.test.ts` | `AC-32 綜合列表 > maintenance and travel rows are interleaved in primaryDate DESC, createdAt DESC, id DESC order`；`… > maintenance rows carry type=MAINTENANCE and the correct status`；`… > fields not applicable to maintenance are null (rendered as — by the frontend)` | T10 | GREEN（T10 `73cdafc`：`phase6-application-list.test.ts` 混合全序（id tiebreak mutant 紅）、D9(a) title 期間字串、null 欄、type/status） |
| AC-33 | integration | `phase6-application-list.test.ts` | `AC-33 篩選 > type=MAINTENANCE returns only maintenance rows`；`… > primaryDate equals the current maintenance date and drives the date-range filter (inclusive on both ends)`；`… > a normal user passing another ownerId gets 403 (never a silent downgrade)` | T10 | GREEN（T10 `73cdafc`＋T10R：篩選含當日（lte→lt mutant 紅）、resolveOwnerId 403、MF-1 三條經端點 primaryDate 鑑別（derivePrimaryDate(null) mutant 恰紅）、陣列 query 400） |
| AC-34 | frontend | `frontend/test/MaintenanceApplicationPage.test.tsx` | `保養申請頁 > 表單提供上次／本次保養日期、上次／本次里程表、本次實際保養費用五欄（逐字標籤）`；`… > 僅填部分欄位仍可儲存草稿`；`… > 後端 400 之 fields[] 就地標示於對應欄位` | T11 | GREEN（T11 `f23dc8a`：`MaintenanceApplicationPage > AC-34：提供五個欄位（逐字標籤）`；`… AC-34：僅填部分欄位（本次實際保養費用）仍可「儲存草稿」成功`；`… AC-34：後端 400 之 fields[] 就地標示於對應欄位`） |
| AC-35 | frontend | `MaintenanceApplicationPage.test.tsx` | `保養申請頁 > 預覽顯示保養區間總里程／期間公務里程／公務使用比例／公司分攤金額四值`；`… > 鑑別力：mock 回傳與前端可自算之值刻意不同時，畫面顯示後端值（前端零自算）`；`… > 比例大於 100% 顯示錯誤並停用完成`；`… > 不可計算時顯示「無法計算」而非金額 0`（it.each 涵蓋 OFFICIAL_KM_EXCEEDS_INTERVAL／AMOUNT_OUT_OF_RANGE 兩碼） | T11 | GREEN（T11 `f23dc8a`：`… AC-35：不自算金額鑑別力——畫面顯示的四值即為 mock 之後端回應值`（自算 mutant 紅）；`… AC-35：比例 > 100%（OFFICIAL_KM_EXCEEDS_INTERVAL）→ 顯示錯誤訊息並使「完成申請」不可用`；`… AC-35：不可計算狀態（欄位齊備但超出容量）不得顯示金額 0，須顯示「無法計算」＋zh-TW 說明`；`… AC-35：五欄未齊（Empty，非錯誤）→ 顯示提示文字而非任何錯誤或金額 0`——實作為獨立 it 非 it.each，實質等價） |
| AC-36 | frontend | `MaintenanceApplicationPage.test.tsx` | `保養證明 > 上傳支援格式顯示縮圖預覽`；`… > 已有 5 張時第 6 張被拒並顯示上限訊息`；`… > 超過 10 MB 之單檔被拒`；`… > 無證明仍可儲存草稿，但完成鈕停用並顯示 MAINTENANCE_ATTACHMENT_REQUIRED 訊息`；`… > 已完成之保養申請不存在任何上傳／刪除入口（負向斷言）` | T12 | GREEN（T12 `230ed54`：describe `保養證明（AC-36/AC-37）` 八條 verbose 實名（縮圖/滿5拒絕零呼叫/>10MB 零呼叫/無證明可存＋完成鈕停用（mutant 紅）/COMPLETED 負向/AR-3 去重/409 呈現/Empty）） |
| AC-37 | frontend | `MaintenanceApplicationPage.test.tsx` | `保養申請頁 — 五態 > Loading／Empty／400 就地標示／5xx 訊息＋重試／Success／Permission denied 零寫入呼叫`（describe 拆 6 it） | T11, T12 | GREEN（T11/T12：表單/預覽/附件三處五態 verbose 實名（Loading/Empty/Error 5xx 重試/Permission denied 零寫入呼叫/Success）；`… 完成申請：dirty 時確認框…` 沿 005a T14 行為） |
| AC-38 | E2E | `e2e/maintenance-allowance.spec.ts` | `保養費用分攤 — PHASE-006 Gate E2E > 情境7：響應式 375px——保養表單／預覽／證明／詳情 body 皆無水平溢位` | T14 | GREEN（T14 `90fad67`：`e2e/maintenance-allowance.spec.ts` 情境7 375px 四畫面 scrollWidth；大總管親跑 30/30） |
| AC-39 | unit(structural) | `backend/test/integration/phase6-contract.test.ts` | `AC-39 ErrorCode 聯集全等 + 本 Phase src 僅用基線字面值 > errors.ts ErrorCode union equals the known baseline`；`AC-39 ErrorCode 聯集全等 + 本 Phase src 僅用基線字面值 > PHASE-006 source references only baseline ErrorCode literals` | T13 | GREEN（T13：`phase6-contract.test.ts` 聯集 13 碼全等（BOGUS mutant 紅）＋本 Phase 9 src 檔字面值掃描） |
| AC-40 | integration | `phase6-contract.test.ts` | describe `AC-40 — PHASE-006 保養端點錯誤合約`（八端點 per-endpoint describe×狀態碼 it，非 it.each——逐條統一形狀 Object.keys 封閉）；describe `AC-40 日誌安全：logStream 六類掃描`（`no log line contains the session cookie value` 等六條）；`… > the triggered error responses are still logged (not silently swallowed)` | T13 | GREEN（T13：八端點×狀態碼統一形狀（頂層鍵封閉）＋logStream 六類掃描＋錯誤不靜默；AR-1 路徑正則盲點檔頭記載） |
| AC-41 | E2E | `e2e/maintenance-allowance.spec.ts` | `保養費用分攤 — PHASE-006 Gate E2E > 情境1：播種一筆期間內之已完成差旅→建立保養草稿（部分欄位：僅填上次保養日期）`；`… > 情境2：補齊本次保養日期／上次里程表／本次里程表／實際保養費用四欄並儲存`；`… > 情境3：上傳一張保養證明並儲存草稿`；`… > 情境4：預覽顯示保養區間總里程／期間公務里程／公務使用比例／公司分攤金額四值`；`… > 情境5：完成申請→詳情顯示快照四值且附件無刪除入口`；`… > 情境6：再次嘗試修改已完成之保養申請→403`；`… > 情境7：響應式 375px——保養表單／預覽／證明／詳情 body 皆無水平溢位`（情境7 同為 AC-38 證據） | T14 | GREEN（T14 `90fad67`：七情境八步驟（API 播種冪等兩輪實證、上傳→儲存→完成順序、手算 1000/250/25%/1000、快照四值＋無刪除入口、修改 403）；大總管親跑 30/30） |

**覆蓋核對**：AC-01~AC-41 全數有映射（本表共 **41 列**）。無 AC 僅由 E2E 覆蓋（AC-38／AC-41 除外——響應式與端到端串接本質為瀏覽器行為，沿 PHASE-004 AC-89／PHASE-005 AC-32／PHASE-005a AC-33 之既有慣例）。

---

## 13. Architecture / Data Flow 需同步項清單（本 Phase 不修改該二檔）

> 由大總管於 Gate 後決定是否另行派工（DOC-SYNC）。

1. **ARCHITECTURE §3 模組表**：`applications` 模組補列 `maintenance-service.ts`／`maintenance-calculation.ts`／`maintenance-blockers.ts`。
2. **ARCHITECTURE §4.1**：保養段落補「分攤 ＝ `ROUND_HALF_UP(實際費用 × 期間公務里程 ÷ 保養區間里程, 0)`，**計算過程不得先取整比例**；全案取整恰一處」。
3. **ARCHITECTURE §4.4**：快照清單之保養項補「另存取整前金額 `snapshotRawAmount` 與 `calculatedAt`；實際費用之快照即欄位本身（完成後凍結）」（依 §16 D11 裁定）。
4. **ARCHITECTURE §4.5**：補「`deriveContainerState` 自 PHASE-006 起支援 `refType=MAINTENANCE`，經 `MaintenanceApplication → Application.status` 推導」。
5. **ARCHITECTURE §4.10**：複用介面段落之「`maintenance`（期間公務里程）…於各自完成流程之交易內直接呼叫」由**計畫**改為**已落地**，並補記 D2(a) 不對稱之保養處置（AC-15）。
6. **DATA_FLOW §1.1／§2.2**：`MaintenanceApplication` 由概念條目改為實體條目；§2.2 之「建立草稿→完成」補保養分支（本 Spec §9.3）。
7. **PROJECT_STATE 跨 Phase 追蹤**：新增「PHASE-008 報表須支援 `MNT` 編號與保養列印版（四值＋實際費用＋證明）」與「PHASE-009 保養作廢須同時排除於後續保養／折舊之公務里程統計」。

---

## 14. Rollback

- **新增內容**：1 張新表、6 個後端端點（含 1 個既有 generic 路徑之型別分派）、3 個後端純函式／service 模組、2 處既有模組之擴充（`deriveContainerState`、`deleteApplication`）、1 個前端頁面＋1 個 API 模組、測試。
- **開發階段回滾**：branch `phase-006` 還原至 `f1a2909`；DB 執行 `DROP TABLE "MaintenanceApplication"`。
- **既有資料補償**：**無**（本 Phase 不改寫任何既有資料列，AC-01(b) 機械證明）。**唯一例外**：回滾前須先 detach 所有 `refType='MAINTENANCE'` 之 `LINKED` 附件（§8.4）。
- **已產生已完成保養申請後之回滾**：`DROP TABLE` 會**永久遺失**該批申請之全部業務欄位與快照（`Application` 列雖仍在，但 `type=MAINTENANCE` 之列將無子表可讀）。**若已有已完成保養申請，回滾前須先匯出該表**；開發期為合成資料，風險可控。
- **公開 contract 影響**：全部為**新增**（回滾即移除 route）。**唯一之既有行為變更**為 `deriveContainerState` 之 MAINTENANCE 分支與 `deleteApplication` 之 detach 範圍——兩者皆為**修補既有缺口**（現況允許已完成保養之附件被刪除／草稿刪除後留下孤兒），回滾即回到有缺口的狀態。
- **不可逆資產**：`AuditLog` 之代操作紀錄一經寫入即為歷史，不刪除。

---

## 15. Task Graph

> 每 Task 一律 TDD、一個 atomic commit（含 Task ID）。**規模上限（Packet）：單 Task ≤ 5 AC、≤ 6 檔、不得同時橫跨 FE＋BE＋DB 三層。**
> **Expected Diff Budget** 依 PHASE-005a 實績校準（integration 重 Task ~1100~1250 行；純函式 Task ~350~450 行；前端 Task ~450~700 行）。逾預算 50% 須即時回報（Stop Condition）。

| Task | 內容 | 層 | AC（≤5） | 檔案（≤6） | Risk | 依賴 | Diff 預算 | Done When |
|---|---|---|---|---|---|---|---|---|
| **T1** | Schema ＋ migration ＋ 安全網 ＋ infra 表數連動 | DB | AC-01 | `backend/prisma/schema.prisma`、`backend/prisma/migrations/*`（≤2 檔）、`backend/test/integration/phase6-migration-safety.test.ts`、`backend/test/integration/infra001-isolation-self-check.test.ts` | **High**（migration） | — | ~500 | 既有／乾淨 DB 皆 migrate 成功；五表逐欄零改寫；表數 13→14；enum 聯集全等基線 |
| **T2** | 保養計算純函式 `calculateMaintenance` ＋ 容量 predicate ＋ 零浮點掃描 | BE（純函式，零接線） | AC-06, 16, 17, 19 | `backend/src/applications/maintenance-calculation.ts`、`backend/test/unit/maintenance-calculation.test.ts` | **High**（金額核心） | T1 | ~450 | 取整 kill pair 與取整層級 kill case 皆綠；`ROUND_HALF_EVEN` 與「先取整比例」兩種 mutant 必紅；除零／NaN／Infinity 防禦在場 |
| **T3** | 完成度純函式 `computeMaintenanceBlockers`（兩段式） | BE（純函式，零接線） | AC-07, 08, 09, 10, 18 | `backend/src/applications/maintenance-blockers.ts`、`backend/test/unit/maintenance-blockers.test.ts` | **High**（金額守門） | T2 | ~400 | 11 碼順序穩定；互斥規則；`O==I` 通過／`O=I+0.01` 擋；「以取整後 ratio 比較」mutant 必紅 |
| **T4** | 保養草稿 CRUD service ＋ route ＋ 欄位驗證 ＋ 狀態／授權守門 | BE | AC-02, 03, 04, 05 | `backend/src/applications/maintenance-service.ts`、`backend/src/applications/routes.ts`、`backend/test/integration/phase6-maintenance-draft.test.ts` | High（授權＋狀態機） | T1, T3 | ~1200 | 分層 gate table 全綠；403 先於 400 之順序有明文測試；既有差旅測試零弱化 |
| **T5** | 期間公務里程接線（引擎複用）＋ 預覽端點 ＋ `computed` | BE | AC-11, 12, 13, 14, 15 | `backend/src/applications/maintenance-service.ts`、`backend/src/applications/routes.ts`、`backend/test/integration/phase6-official-mileage.test.ts` | **High**（金額上游） | T2, T4 | ~1250 | 引擎 import 突變自證必紅；六條補測邊界全綠；預覽零寫入實證；`ownerId` 恆為擁有人 |
| **T6** | 保養附件：上限 5、`attachmentIds[]` 對帳、完成鎖定（`deriveContainerState` 擴充）、草稿刪除 detach 補洞、授權 | BE | AC-21, 22, 23, 24 | `backend/src/attachment/lifecycle-service.ts`、`backend/src/applications/travel-service.ts`（僅 `deleteApplication` 之 detach 範圍）、`backend/src/applications/maintenance-service.ts`、`backend/test/integration/phase6-maintenance-attachment.test.ts` | **High**（附件權限） | T4 | ~1200 | AC-23 修復前紅燈（現況可刪）實證；B-29 孤兒補洞修復前紅燈實證；PHASE-003/004 既有附件測試零弱化 |
| **T7** | 完成流程 ＋ 快照寫入 ＋ 原子性 ＋ 僅本人授權 | BE ＋ DB（寫入） | AC-25, 26, 27, 18(整合層) | `backend/src/applications/maintenance-service.ts`、`backend/src/applications/routes.ts`、`backend/test/integration/phase6-maintenance-complete.test.ts` | **High**（不可逆完成／快照） | T5, T6 | ~1250 | 交易切點回滾實證；快照雙重可重現性；管理員代完成 403（對照組：本人成功） |
| **T8** | 快照不可變 ＋ 後端權威 ＋ 容量守門接線 ＋ 併發 | BE | AC-19(整合層), 20, 28, 29 | `backend/src/applications/maintenance-service.ts`、`backend/test/integration/phase6-snapshot-immutability.test.ts` | **High**（金額權威） | T7 | ~1100 | 逐位元不變＋spy 零重查；夾帶矩陣零 500；併發恰一成功；容量守門邊界正例在場（防誤殺） |
| **T9** | 代操作（代建立／代修改）＋ 稽核 | BE | AC-30, 31 | `backend/src/admin/routes.ts`、`backend/src/applications/maintenance-service.ts`、`backend/test/integration/phase6-on-behalf.test.ts` | **High**（授權） | T4 | ~900 | 稽核欄位精確；真交易回滾證據（非 stub）；`ownerId`／`createdById` 分離 |
| **T10** | 綜合列表之保養列映射 ＋ 篩選 | BE | AC-32, 33 | `backend/src/applications/application-query.ts`、`backend/test/integration/phase6-application-list.test.ts` | Medium | T4 | ~600 | 混合全序排序；不適用欄 `null`；PHASE-004 既有列表測試零改動 |
| **T11** | 前端：保養表單 ＋ 預覽 ＋ 五態 | FE | AC-34, 35, 37(部分) | `frontend/src/api/maintenance.ts`、`frontend/src/types/api.ts`、`frontend/src/pages/MaintenanceApplicationPage.tsx`、`frontend/src/App.tsx`、`frontend/src/pages/HomePage.tsx`、`frontend/test/MaintenanceApplicationPage.test.tsx` | Medium | T5, T7 | ~700 | 前端零自算鑑別測試綠；不可計算不顯示 0；Permission denied 零寫入呼叫 |
| **T12** | 前端：保養證明上傳／刪除 ＋ 完成流程 ＋ 五態補齊 | FE | AC-36, 37(部分) | `frontend/src/pages/MaintenanceApplicationPage.tsx`、`frontend/src/components/AttachmentUploader.tsx`（如需保養情境參數化）、`frontend/src/index.css`、`frontend/test/MaintenanceApplicationPage.test.tsx` | Medium | T6, T11 | ~600 | 上限／大小／完成須 ≥1 全綠；已完成無入口之負向斷言綠；既有差旅上傳行為零回歸 |
| **T13** | 錯誤合約 ＋ `ErrorCode` 結構性斷言 ＋ 日誌安全 | BE | AC-39, 40 | `backend/test/integration/phase6-contract.test.ts` | Medium | T8, T9 | ~850 | `ErrorCode` 聯集全等（BOGUS mutant 必紅）；`logStream` 六類掃描全綠 |
| **T14** | 響應式 ＋ Gate E2E | FE ＋ E2E | AC-38, 41 | `e2e/maintenance-allowance.spec.ts`、`frontend/src/index.css` | Medium | T12, T13 | ~700 | 七情境全綠（大總管親跑於 dev 拓撲）；播種冪等；四畫面 375px 無溢位 |

### 依賴圖

```
T1 ──▶ T2 ──▶ T3 ──▶ T4 ──┬──▶ T5 ──┐
                            ├──▶ T6 ──┴──▶ T7 ──▶ T8 ──┐
                            ├──▶ T9 ─────────────────────┼──▶ T13 ──┐
                            └──▶ T10                     │          │
                                        T11 ◀── T5, T7   │          │
                                         └──▶ T12 ───────┴──────────┴──▶ T14
```

### 規模上限自查

| Task | AC 數 | 檔數 | 跨層 | 合規 |
|---|---|---|---|---|
| T1 | 1 | 5 | DB only（＋1 既有測試檔之機械連動） | ✅ |
| T2 | 4 | 2 | BE only（純函式） | ✅ |
| T3 | 5 | 2 | BE only（純函式） | ✅ |
| T4 | 4 | 3 | BE only | ✅ |
| T5 | 5 | 3 | BE only | ✅ |
| T6 | 4 | 4 | BE only | ✅ |
| T7 | 4 | 3 | BE ＋ DB（寫入既有／新表，無 schema 變更） | ✅ |
| T8 | 4 | 2 | BE only | ✅ |
| T9 | 2 | 3 | BE only | ✅ |
| T10 | 2 | 2 | BE only | ✅ |
| T11 | 3 | 6 | FE only | ✅ |
| T12 | 2 | 4 | FE only | ✅ |
| T13 | 2 | 1 | BE only | ✅ |
| T14 | 2 | 2 | FE ＋ E2E | ✅ |

> **無任何 Task 同時橫跨 FE＋BE＋DB 三層。** T1 為唯一含 schema/migration 之 Task。
> **TDD 順序**：T1（migration 安全網先建立）→ T2/T3（金額與守門純函式，零接線）→ T4（草稿骨架）→ T5/T6（金額上游與附件權限）→ T7/T8（不可逆完成與快照）→ T9/T10（代操作與列表）→ T11/T12（前端）→ T13/T14（合約與 Gate）。

### 與 PRD §PHASE-006「初始 Task Graph 概要」之對照

| PRD Task | 本 Spec 落點 | 說明 |
|---|---|---|
| T1 保養 Application 概念模型 + 快照容器 + migration | **T1** | 一致 |
| T2 保養草稿 CRUD | **T4** | 一致（編號後移，因純函式先行之 TDD 順序） |
| T3 區間里程與日期/里程表驗證 | **T2 ＋ T3** | 拆為「計算純函式」與「完成度純函式」兩個零接線 Task（規模上限與 TDD 紀律） |
| T4 期間公務里程（複用 005 引擎） | **T5** | 一致 |
| T5 分攤計算（**High**） | **T2（公式／取整）＋ T3（>100% 阻擋）＋ T8（後端權威／容量）** | 拆分 |
| T6 保養證明上限 5 + 完成須 ≥1（**High**） | **T6** | 一致（另納入完成鎖定與 detach 補洞） |
| T7 完成流程 + 快照 + 附件鎖定（**High**） | **T7 ＋ T8** | 拆為「完成與快照」與「不可變／權威／併發」 |
| T8 前端保養表單/預覽/證明/響應式 | **T11 ＋ T12 ＋ T14** | 拆分（含 E2E） |
| （PRD 未列） | **T9 代操作、T10 列表、T13 錯誤合約** | US 索引表已將 AD-US-06/07/08、BE-US-03、FE-US-04/05 列為 PHASE-006 之次要關聯，PRD §PHASE-006 之 Task 概要未涵蓋——本 Spec 補齊（見 §19 之 PRD 建議修正 #2） |

**High 風險 Task 清單（**須於 Spec Gate 一併取得事前批准**）**：**T1、T2、T3、T4、T5、T6、T7、T8、T9** 共 9 項。
> 與 PRD「High 風險 Task：T5, T6, T7」之差異說明：PRD 之 T5/T6/T7 對應本 Spec 之 T2/T3/T8（分攤計算）、T6（保養證明）、T7（完成流程），**三者全數涵蓋**；本 Spec 另將 T1（不可逆 migration）、T4（授權與狀態機）、T5（金額上游之引擎接線與 `ownerId` 解析）、T9（代操作授權）升為 High，依據為 CLAUDE.md「認證、授權…相關工作一律 High」與 PHASE-005 D10(a)／PHASE-005a 之既有升級先例。**此升級為保守方向（增加人類批准面），不縮減任何既有 High 判定。**

---

## 16. 需人類批准之決策點（D1~D12）

> 每條格式：**為什麼要決定** ｜ **選項** ｜ **各選項影響** ｜ **推薦**。
> **凡未裁定者，相關 AC 與實作一律不得開工。**

### D1 — 保養資料模型：新增子表 vs 擴充既有表（**資料模型 ＋ 不可逆 migration，必人類批准**）

**為什麼要決定**：PRD 概要說「保養 Application 概念模型 + 快照容器」，未指定表結構。此選擇一經 migration 落地即為不可逆資產，且 PHASE-007（折舊）會直接沿用同一模式。

| 選項 | 內容 |
|---|---|
| **(a) 新增 `MaintenanceApplication` 子表**（1:1 於 `Application`，PK ＝ `applicationId`） | 完全比照既有 `TravelApplication` |
| (b) 於 `Application` 父表直接加保養欄位 | 不新增表 |
| (c) 通用 `Application.details Json` 欄位 | 三型共用一個 JSON |

**各選項影響**
- **(a)**：與既有 `TravelApplication` 對稱，型別安全（Prisma 產生具名欄位）；`Application` 父表**零 `ALTER`**（AC-01(b) 最強保證）；查詢以 `include` 銜接，與 `application-query.ts` 既有形狀相容；PHASE-007 可原樣複製。缺點：新增一張表（infra 自檢表數需機械連動，見 §17.1）。
- **(b)**：`Application` 父表被灌入 5＋5 個僅對一種型別有意義的可空欄位，差旅／折舊列永遠為 `null`；且需 `ALTER TABLE` 既有表 → 直接削弱 AC-01(b) 之「既有表完全不動」保證；PHASE-007 再加 6 欄後父表將有 20＋ 個型別專屬空欄。
- **(c)**：喪失型別安全與 DB 層約束；金額欄位進 JSON 後 `Decimal` 精度紀律無法由 schema 保證（違反 §10.1）；查詢與索引困難。**強烈不建議**。

**推薦：(a) 新增 `MaintenanceApplication` 子表。**

---

### D2 — 保養附件之容器語意與完成鎖定（**附件權限，必人類批准**）

**為什麼要決定**：`AttachmentRefType.MAINTENANCE` 早在 PHASE-003 即宣告，但 `deriveContainerState` 對該分支**一律回 `'draft'`**（註記「子表尚不存在，防禦性」）。若不修補，保養完成後其證明附件仍可被刪除／替換——**直接違反 BE-US-25 第 4 條與 NFR-US-10**。此外 `deleteApplication` 目前只 detach `TRIP_SEGMENT` 附件，刪除保養草稿會留下孤兒 `LINKED` 附件。

| 選項 | 內容 |
|---|---|
| **(a) 擴充 `deriveContainerState` ＋ 補 `deleteApplication` detach**；`refId` ＝ `Application.id`（＝ `MaintenanceApplication.applicationId`）；關聯途徑僅 `PUT /applications/maintenance/:id` 之 `attachmentIds[]` | 修補既有缺口 |
| (b) 於 `Attachment` 加真實 FK 至 `MaintenanceApplication` | 改弱關聯為強關聯 |
| (c) 於 `Attachment` 冗餘持久化 `locked` 旗標 | 不再推導 |

**各選項影響**
- **(a)**：與 PHASE-003 D1/D2 之既有定案（弱關聯、鎖定語意權威在申請狀態機）一致；改動面小且集中；`refId` 直接是 `Application.id` 使 `deriveContainerState` 只需一次 `application.findUnique`。
- **(b)**：`refType` 之設計目的即為避免對多型容器建 FK；改為強 FK 需為三型各加一個可空 FK 欄，且 PHASE-003 之既有測試與 `refType/refId` 索引全面重寫。
- **(c)**：ARCHITECTURE §4.5 明文「附件不冗餘持久化 locked」——推翻既有定案，且引入「旗標與狀態不同步」之新故障模式。

**推薦：(a)。** 並將「AC-23 修復前紅燈」與「B-29 孤兒補洞修復前紅燈」列為 T6 之 Done When 硬性項。

---

### D3 — 欄位精度與容量（**金額語意上游 ＋ 使用者可見行為**）

**為什麼要決定**：里程表、費用、比例、快照之精度直接決定金額正確性與可儲存範圍；且 `Decimal(_,2)` 之選擇會使「輸入 3 位小數」成為 400（B-21），屬使用者可見行為。

| 欄位 | **推薦** | 替代 |
|---|---|---|
| `lastOdometerKm`／`currentOdometerKm` | `Decimal(10,2)`（與 `TripSegment.totalKm` 一致） | `Int`（里程表為整數）——但與全案「里程皆 2 位小數」慣例不符，且使用者可能填 `123456.5` |
| `actualCost` | `Decimal(12,2)` | `Decimal(9,2)`（≤ 9,999,999.99，可**直接消除** int4 溢位風險，見 D10） |
| `snapshotIntervalKm`／`snapshotOfficialKm` | `Decimal(12,2)`（與 `snapshotTotalKm` 一致） | — |
| `snapshotRatio` | `Decimal(9,6)`（6 位小數） | `Decimal(9,4)`（4 位小數，顯示足夠但快照精度較低） |
| 比例對外表示 | **同時回 `ratio`（6 位小數比值）與 `ratioPercent`（4 位小數百分比）** | 只回其一 → 前端必須自算（違反 §11.3 之零自算紀律） |

**推薦：如上表「推薦」欄。** 關鍵理由：比例之 6 位小數**僅供顯示與快照**，**不參與**金額計算（AC-17(a)），故精度選擇不影響金額正確性；同時回兩種表示是為了讓前端**完全不做算術**。

---

### D4 — 分攤計算式與取整層級（**金額核心，必人類批准**）

**為什麼要決定**：PRD 與 BE-US-12 說「分攤 ＝ 實際費用 × 公務比例，整筆一次四捨五入」。若把「公務比例」實作為一個**已取整到 N 位小數的中間值**，再乘以費用，實質上就引入了**第二處取整**，與「整筆一次四捨五入」抵觸，且在大額情境會產生 1 元差異（見 §2 AC-17(d) 之 kill case）。此為對 US 文字之**實作解讀**，非 US 改寫，但影響金額結果，須人類確認。

| 選項 | 內容 |
|---|---|
| **(a) `amount = ROUND_HALF_UP(cost × officialKm ÷ intervalKm, 0)`**，比例僅作為顯示／快照值另行計算 | 單一取整 |
| (b) `ratio = ROUND(officialKm ÷ intervalKm, 6)`；`amount = ROUND_HALF_UP(cost × ratio, 0)` | 兩處取整 |
| (c) 同 (b) 但比例取更多位（如 10 位） | 兩處取整，誤差較小 |

**各選項影響**
- **(a)**：嚴格符合「整筆一次四捨五入」；快照中之 `ratio` 與 `rawAmount` 可能出現「以 `ratio` 重算得不到 `rawAmount`」之極小差異——須以**快照重現性斷言用三項來源值（費用／公務里程／區間里程）重算**（AC-26 已如此規定），而非用 `ratio` 重算。
- **(b)/(c)**：可由 `ratio` 直接重算 `rawAmount`（對帳直觀），但違反「整筆一次」；(b) 在 `cost ≥ 1.5e6` 時可產生 1 元偏差，(c) 把偏差門檻推高但**未消除**。

**推薦：(a)。** 並於快照文件與報表（PHASE-008）明文「比例為顯示值，對帳請以三項來源值重算」。

---

### D5 — 完成阻擋之錯誤合約形狀（**公開 API contract**）

**為什麼要決定**：`比例 > 100%` 與其餘完成條件之拒絕形狀決定前端如何呈現，且一經前端接用即為公開合約。

| 選項 | 內容 |
|---|---|
| **(a) 400 `VALIDATION_ERROR` ＋ `fields[]` ＋ `details.blockers[]`（完整清單）** | 完全沿用 PHASE-004 D14(i) 既有形狀 |
| (b) 比例超限單獨用 409 `CONFLICT` | 與其餘 blocker 分流 |

**各選項影響**
- **(a)**：前端只需一套處理邏輯；`details.blockers[]` 已被 `TravelApplicationPage` 消費，保養頁可直接複製呈現模式；不新增 `ErrorCode`（AC-39 成立）。
- **(b)**：使前端須處理兩種形狀；且「比例超限」與「缺附件」在語意上同屬「尚未符合完成條件」，分流無實益。

**推薦：(a)。**

---

### D6 — 預覽形狀與完成端點路徑（**使用者可見行為 ＋ 授權面，必人類批准**）

**為什麼要決定**：FE-US-14 之「預覽」語意是「輸入有效日期與里程表數值 → 系統進行預覽」；若不提供 stateless 端點，使用者必須先儲存草稿才看得到預覽（可見行為差異）。另外 stateless 預覽需要 `ownerId` 才能為代操作情境算出正確的期間公務里程——這會擴大該端點之授權面（比照 PHASE-005a D6(a) 之先例）。

| 選項 | 內容 |
|---|---|
| **(a) 兩者皆有**：草稿 `GET`/`PUT` 回應內嵌 `computed`，**另加** `POST /applications/maintenance/preview`（body 四欄 ＋ 選填 `ownerId`，授權沿用 `resolveOwnerId`） | 完全比照 PHASE-004 |
| (b) 僅草稿內嵌 `computed`（無 stateless 端點） | 使用者須先存草稿 |
| (c) 僅 stateless 端點（草稿回應不含 `computed`） | 前端須額外呼叫一次 |

**各選項影響**
- **(a)**：與 PHASE-004 差旅頁之使用者體驗一致（邊填邊看）；`resolveOwnerId` 為既有唯一授權判定，複用零新機制；揭露面與既有 `GET /statistics/mileage` **完全相同**（見 §6.3），不構成新擴張。成本：多 1 個端點與其授權測試（已計入 T5 預算）。
- **(b)**：使用者可見行為與差旅頁**不一致**（差旅可即時預覽、保養不行），屬體驗降級；優點是少一個端點與少一組授權面。
- **(c)**：草稿詳情頁需額外往返；且已完成申請讀 `snapshot`、草稿讀 `computed` 之對稱性被打破。

**推薦：(a)。**
**附帶裁定（同一決策點）**：完成端點沿用**既有 generic 路徑** `POST /applications/:id/complete`，依 `Application.type` 分派（該路徑本即與型別無關，前端與 E2E 只需一套完成流程）；替代方案 `/applications/maintenance/:id/complete` 會造成兩套完成路徑，不建議。

---

### D7 — 完成之授權：是否允許管理員代完成（**授權，必人類批准**）

**為什麼要決定**：AD-US-07/08 只授權管理員「建立草稿」與「修改草稿」，**未**授權代完成；PHASE-004 D17 已定案「本 Phase 不提供管理員代完成，完成僅能由使用者本人執行」。保養是否沿用須人類確認（沿用＝維持現狀；放寬＝擴大授權範圍，屬必人類批准項）。

| 選項 | 內容 |
|---|---|
| **(a) 沿用 PHASE-004 D17：完成僅本人** | 一致 |
| (b) 允許管理員代完成 | 擴大授權 |

**各選項影響**
- **(a)**：與 AD-US-07/08 之字面授權範圍一致；route 層以嚴格 `actor.id === ownerId` 判定（**不得**使用 `assertOwnershipOrAdmin`，該函式會放行 ADMIN）。
- **(b)**：US 未涵蓋；且「完成」為不可逆並產生金額，代完成之責任歸屬需另行定義；若要開放，應同時定義代完成之稽核 action（新增 enum 值，與 AC-01(f) 抵觸）。

**推薦：(a)。**

---

### D8 — D2(a) `null` 快照之處置（**金額正確性**）

**為什麼要決定**：PHASE-005 D2(a) 已知故障模式：`status=COMPLETED` 但 `snapshotTotalKm IS NULL` 之差旅會被 `SUM` 忽略而不報錯，使保養之分子靜默偏低。PHASE-005 已以「AC-13 不變式測試」守護，但保養是**金額落地點**，是否加一道執行期守門須裁定。

| 選項 | 內容 |
|---|---|
| **(a) 沿用 PHASE-005 之不變式測試，保養不加執行期守門**；以 AC-15 明文固定語意與偏差方向 | 不加查詢 |
| (b) 保養完成時額外查詢「期間內是否存在 `COMPLETED ∧ snapshotTotalKm IS NULL`」，若有則拒絕完成 | 加一次查詢 |

**各選項影響**
- **(a)**：零額外成本；偏差方向**保守**（分攤偏低，不會溢付）；異常本身由 PHASE-004 AC-50 之原子完成保證不發生，並由 PHASE-005 AC-13 全域不變式測試守護。風險：若異常真的發生，使用者會拿到偏低金額而系統不報錯。
- **(b)**：使異常變成可見的拒絕（fail-loud）；成本為完成路徑多一次 `count` 查詢（同交易內，索引可用）。風險：一筆歷史髒資料會使該期間所有保養申請**永久無法完成**，且使用者無自救途徑（須管理員修資料）。

**推薦：(a)**，並要求 AC-15(d) 之「筆數 ≥1 但里程 0.00」外觀有明文整合測試固定。**若人類偏好 fail-loud，選 (b)** ——請一併裁定「使用者遇此拒絕時之 zh-TW 訊息與求助路徑」。

---

### D9 — 綜合列表中保養列之欄位映射（**使用者可見行為**）

**為什麼要決定**：`toApplicationListItemDto` 目前對非 `TRAVEL` 之列一律回 `title=null`／`totalKm=null`／`segmentCount=null`（顯示「—」）。若保養列的「摘要」欄永遠是「—」，列表可用性差；但填入什麼值屬使用者可見行為。

| 欄位 | **推薦** | 理由 |
|---|---|---|
| `title` | 保養列填 `"保養 YYYY-MM-DD ~ YYYY-MM-DD"`（日期未齊時退為 `null`） | FE-US-04 第 2 條要求「明確的類型標籤」已由 `type` 滿足；`title` 為摘要欄，填保養期間最具辨識度 |
| `totalKm` | **維持 `null`** | 該欄在差旅列之語意為「公務總里程」；保養之「區間里程」語意不同，混用會誤導（FE-US-04 第 5 條明文「不得顯示錯誤資料」） |
| `segmentCount` | **維持 `null`** | 保養無行程段 |
| `totalAmount` | 已完成之保養列顯示分攤金額（既有欄位，無須改動） | 三型共用語意「最終申報金額」 |
| `keyword` 比對範圍 | **維持現況：僅比對 `TravelApplication.purpose`** | 保養無文字欄位可比對；FE-US-05 之「出差目的或報表編號」中，報表編號屬 PHASE-008。帶 keyword 時保養列天然查無結果——**須於本 Spec §17.1 明文記載為已知限制**，並列為 PHASE-008 之銜接項 |

**推薦：如上表。** 若人類希望保養列在 keyword 查詢中可被找到，須先定義「保養之可搜尋文字」為何（US 未定義）——屬新增 US 範圍，本 Phase 不得自行決定。

---

### D10 — 金額容量守門之呈現形狀（**錯誤合約 ＋ 資料模型**）

**為什麼要決定**：`actualCost` 之 `Decimal(12,2)` 上界（`~1e10`）× 比例 `1.0` ＝ `~1e10`，**超過 `Application.totalAmount` 之 int4 上界 2,147,483,647**。若不處理，極端合法輸入會在寫入時觸發 Postgres 溢位 → 500 或靜默截斷——正是 CHORE-003／PHASE-005a D4(a) 已裁定為不可接受之缺陷類。

| 選項 | 內容 |
|---|---|
| **(a) 保留 `Decimal(12,2)` ＋ 新增 blocker `AMOUNT_OUT_OF_RANGE`**（400 `VALIDATION_ERROR` ＋ `details.blockers[]`），草稿／預覽同步暴露 | 沿 PHASE-005a D4(a) ＋ S-1 修法 |
| (b) 收緊 `actualCost` 至 `Decimal(9,2)`（≤ 9,999,999.99），使溢位**結構上不可能** | 改欄位容量 |
| (c) 兩者都做 | 雙保險 |

**各選項影響**
- **(a)**：不對使用者可輸入之費用設業務上限（US 未設）；錯誤在完成前即可見（避免 SF-2 反模式）；成本為 1 個 blocker 碼與其測試。
- **(b)**：實質上引入「保養費用不得超過 1000 萬元」之**業務規則**——US 未授權，屬對使用者可見行為之新增限制，**不由 AI 代為決定**；但確實最簡潔（欄位驗證層即擋，`reason` 為容量層文案）。
- **(c)**：最穩健，但 (b) 之業務規則問題依然存在。

**推薦：(a)。** 若人類認為「保養費用上限 1000 萬」是合理的產品規則，則改採 **(c)**（此時 (b) 之限制已獲人類授權，不再是 AI 代決）。

---

### D11 — 快照是否另存 `snapshotActualCost`（**資料保存**）

**為什麼要決定**：BE-US-18 第 2 條逐字要求快照保存「…**實際費用**及最終金額」。`actualCost` 欄位本身在完成後即被狀態機凍結（不可修改），因此**欄位本身即為快照**；但是否另存一份冗餘副本，關係到「快照容器之完整性」之解讀。

| 選項 | 內容 |
|---|---|
| **(a) 不另存**：`actualCost` 欄位完成後凍結，`MaintenanceSnapshotDto.actualCost` 直接讀該欄位 | 無冗餘 |
| (b) 另存 `snapshotActualCost` 欄位 | 冗餘副本，可偵測「凍結被繞過」 |

**各選項影響**
- **(a)**：與 PHASE-004 之既有做法一致（`tripDate`／`purpose` 未另存快照，靠凍結保證）；DTO 仍完整回傳 BE-US-18 之五項，US 字面滿足。
- **(b)**：可在測試中以「欄位 vs 快照不一致」偵測凍結漏洞；成本為 1 個欄位與其寫入。

**推薦：(a)**，並以 AC-04（已完成不可修改，DB 零寫入實證）＋ AC-28（逐位元不變）承擔凍結保證。**此為對 US 文字之實作解讀，請人類明示追認。**

---

### D12 — 相鄰保養申請之期間邊界重疊（**使用者可見行為**）

**為什麼要決定**：US 定義期間為 `[上次保養日期, 本次保養日期]` **起訖含當日**（BE-US-11 第 1 條）。若使用者建立連續兩筆保養（前筆之「本次保養日」＝ 後筆之「上次保養日」），該日之差旅會被**兩筆保養同時計入**分子。US 未禁止，亦未要求偵測。

| 選項 | 內容 |
|---|---|
| **(a) 不阻擋、不警示**，列為已知限制 | 嚴格照 US |
| (b) 偵測到重疊時於預覽顯示提示（不阻擋完成） | 新增可見行為 |
| (c) 拒絕完成 | 新增限制 |

**各選項影響**
- **(a)**：完全遵照 US 原文；重複計入之影響有限（單日里程對長區間比例影響小），且「起訖含當日」本身即為 US 明示裁定。
- **(b)**：新增使用者可見提示，屬新增 US 範圍；需定義提示文案與偵測範圍（同擁有人？跨草稿？）。
- **(c)**：直接與 BE-US-11「起訖均應包含」之字面產生張力，且會使合理使用情境（連續保養）被擋。**不建議。**

**推薦：(a)。**

---

## 17. 已知限制與跨 Phase 銜接

### 17.1 已知限制與**現況缺口**（本 Phase 內必須處置者以 ★ 標示）

1. **★ `deriveContainerState` 之 MAINTENANCE 分支恆回 `'draft'`**（`backend/src/attachment/lifecycle-service.ts`）——PHASE-003 之防禦性佔位，於本 Phase 建立子表後即成為**真實安全缺口**（保養完成後附件仍可刪除）。由 T6／AC-23 修補，須有修復前紅燈實證。
2. **★ `deleteApplication` 只 detach `TRIP_SEGMENT` 附件**（`backend/src/applications/travel-service.ts`）——刪除保養草稿會留下 `refType='MAINTENANCE'` 之孤兒 `LINKED` 附件（永不被 TTL 清理，因 `LINKED` 恆不符 `isEligibleForCleanup`）。由 T6／B-29 修補。
3. **★ `infra001-isolation-self-check.test.ts` 之業務表總數為寫死之 `13`**（三處斷言）——新增一張表即需機械連動為 `14`。已列 T1 Done When；**動態計數之改造仍為 PHASE-011 加固候選**（PHASE-005a T1 已登記同一條目）。
4. **關鍵字查詢不涵蓋保養列**（D9）：`buildApplicationWhere` 之 `keyword` 僅比對 `TravelApplication.purpose`；保養無可搜尋文字欄位。帶 `keyword` 時保養列天然查無結果。**PHASE-008 引入報表編號後**，keyword 應擴充為「purpose ∨ 報表編號」，屆時保養列可經編號被搜尋——列為 PHASE-008 銜接項。
5. **相鄰保養期間邊界重疊**（D12）：同一日之差旅可被兩筆保養同時計入。
6. **`applicationCount` 與 `totalKm` 之不對稱**（D2(a)／AC-15）：極端資料異常下會出現「筆數 ≥1 但里程 0.00」之外觀，偏差方向保守。
7. **保養不使用任何補助參數**：故不受 PHASE-003a／005a 之參數版本變動影響；但也表示**保養金額之正確性完全依賴使用者自填之費用**，系統無從交叉驗證（MVP 接受）。
8. **`VOIDED` 於本 Phase 仍不可達**：保養之作廢屬 PHASE-009；`sumOfficialMileage` 之「排除作廢」對保養**本身**尚無意義（保養不進入任何統計），但對其**分子來源之差旅**已生效。
9. **完成失敗對話框不分缺項**（PHASE-004 既有行為，PHASE-005a 終審 AR-6 已記錄）：保養頁沿用同一模式，不在本 Phase 改善。

### 17.2 與 PHASE-007／008／009／010／011 之銜接

- **PHASE-007（折舊）**：可原樣複製本 Phase 之子表模式（D1(a)）、blocker 兩段式（§9.3）、附件容器擴充（D2(a)）與快照重現性斷言；`DepreciationApplication` 之 `deriveContainerState` 分支同樣須擴充（**PHASE-007 開工 Packet 必引本條**）。年度公務里程同樣呼叫 `sumOfficialMileage`（`dateFrom=該年 1/1`、`dateTo=該年 12/31`），D2(a) 之不對稱處置同樣適用。
- **PHASE-008（報表）**：保養報表編號前綴 `MNT`；列印版須呈現區間里程／公務里程／比例／實際費用／分攤金額五值＋證明圖片；**比例為顯示值，對帳請以三項來源值重算**（D4(a) 之附帶約束，**PHASE-008 開工 Packet 必引**）；keyword 擴充見 §17.1 #4。
- **PHASE-009（作廢／修正版）**：保養之 `COMPLETED → VOIDED` 轉換須擴充 `ALLOWED_TRANSITIONS`；作廢之保養**本身**不進入任何統計，但作廢之**差旅**會改變後續保養之分子——**已完成保養之快照仍不得改變**（AC-28），此為刻意設計（歷史金額凍結）。
- **PHASE-010（稽核檢視）**：代操作保養之 `AuditLog` 以 `summary.type="MAINTENANCE"` 區分。
- **PHASE-011（清理／效能）**：`HasReferenceQuery` 之實作須納入 `MaintenanceApplication` 之附件引用；索引評估納入 `MaintenanceApplication.currentMaintenanceDate`；infra 表數動態化。

---

## 18. Spec 修訂紀錄

| 日期 | 變更 | 依據 |
|---|---|---|
| 2026-08-04 | `ACTIVE`（T9 即審 SF-3 更正） | §6.2 與 §19（PHASE-010 前瞻）之 `summary.applicationType` 兩處更正為 `summary.type`——對齊 PHASE-004 既有稽核 summary 鍵名（差旅代操作 `summary.type="TRAVEL"`，admin/routes.ts:500 實作在先）；Spec 原文為撰寫筆誤，非產品決策變更。T9 實作採 `type` 為正確一致性選擇（reviewer 判讀）。 | T9 即審 SF-3；PHASE-004 既有實作；大總管白名單 |
| 2026-08-04 | `ACTIVE`（T6 即審 SF-2 更正） | §13 授權矩陣第 8 列（保養證明附件讀取）之 PCR 格由「403 PCR」更正為「200」——原列與**已批准之 PHASE-003 D8**（人類 2026-08-01：附件讀取端點不掛 requirePasswordChanged）及現行實作（attachment/routes.ts:164 明文註記）相牴觸；本更正為對齊既有人類批准，非新產品決策。上傳端點（POST /attachments）仍掛 PCR 不變（reviewer 實測）。 | T6 即審 SF-2；PHASE-003 Spec D8 批准原文；大總管白名單 |
| 2026-08-04 | `ACTIVE`（T1 即審 SF-2(b) 更正） | AC-01(a)/AC-28/§9⑤ 之「六個快照欄位」更正為「五個」——與 §8.2 及已批 D11(a)（不另存 snapshotActualCost）一致；「六」為 DRAFT 撰寫殘留（原含 snapshotActualCost 之草案計數），非產品決策變更。DB 實查 11 欄（1 PK＋5 業務＋5 快照）。 | T1 即審 SF-2(b)；D11(a) 批准原文；大總管白名單 |
| 2026-08-04 | `ACTIVE`（PRD-SYNC 落地） | §19 三項 PRD 修正已由 PHASE-006-PRD-SYNC 落地（spec-writer Lite 派工）；§19 標題之「本 Task 未編輯 docs/PRD.md」註記自此為歷史敘述。 | PHASE-006-PRD-SYNC Handoff；大總管白名單 |
| 2026-08-04 | `ACTIVE`（Spec Gate 通過） | **人類 leonchih 裁定（AskUserQuestion）：D1~D12 全數照推薦批准**——D1(a) MaintenanceApplication 子表、D2(a) deriveContainerState 擴充＋deleteApplication detach、D3 精度組（10,2/12,2/12,2/9,6＋ratio/ratioPercent 雙欄）、**D4(a) ROUND_HALF_UP(cost×officialKm÷intervalKm, 0) 單次取整（不得先取整比例）**、D5(a) 400+details.blockers[]、D6(a) 內嵌 computed＋stateless preview＋generic complete、D7(a) 僅本人完成、D8(a) 不變式測試不加執行期守門、D9 列表映射與 keyword 限制列已知限制、D10(a) Decimal(12,2)＋AMOUNT_OUT_OF_RANGE blocker、**D11(a) 不另存 snapshotActualCost（人類明示追認）**、D12(a) 期間重疊不阻擋列已知限制。**T1~T9 共 9 項 High 之事前批准同場取得**。 | 人類 leonchih Spec Gate（2026-08-04）；PROJECT_STATE 開工記錄 |
| 2026-08-04 | `DRAFT` 建立：依 Task Context Packet `PHASE-006-SPEC` 產出完整 Phase Spec（§1~§19：41 條 AC 全溯源、正常流程、五態、35 項邊界、40 格授權矩陣、API contract、資料模型與 migration、Data Flow、NFR、測試策略、AC↔測試映射表 41 列、Rollback、14 Task 之 Task Graph、決策點 D1~D12、PRD 建議修正清單） | `userstory.md` FE-US-04/05/13/14/15/16/21/27、AD-US-06/07/08、BE-US-03/10/11/12/13/18/20/22/23/24/25/30、NFR-US-10/16；`docs/PRD.md` §PHASE-006（402–422 行）與 §4 US 索引表、§6 High 總覽；`docs/ARCHITECTURE.md` §4.1/4.2/4.3/4.4/4.5/4.6/4.10；`docs/DATA_FLOW.md` §1.1/§1.2/§2.2/§2.3/§2.8；PHASE-003 Spec（附件生命週期 D1/D2）、PHASE-003a Spec §14（欄位驗證合約）、PHASE-004 Spec（狀態機／快照／代操作／D6 修訂／D14/D16/D17/D19）、PHASE-005 Spec §16 D2(a)/D5(a)/D8(a)/D9(a) 與 §5 補測清單、PHASE-005a Spec §16 D4(a)/D5(a)/D6(a) 與 §18；`PROJECT_STATE.md` PHASE-006 開工記錄與 PHASE-005/005a 結案移交；程式現況實查（`schema.prisma`、`mileage-engine.ts`、`mileage-range.ts`、`travel-service.ts`、`travel-calculation.ts`、`completion-blockers.ts`、`application-state-machine.ts`、`application-query.ts`、`applications/routes.ts`、`admin/routes.ts`、`attachment/lifecycle-service.ts`、`attachment/attachment-limit-engine.ts`、`attachment/routes.ts`、`users/history.ts`、`platform/errors.ts`、`infra001-isolation-self-check.test.ts`、`ApplicationListSection.tsx`） |

---

## 19. PRD 建議修正清單（**本 Task 未編輯 `docs/PRD.md`**）

> **未編輯之理由**：下列三項修正的正確內容**取決於 §16 之 Gate 裁定結果**（Task 拆分與 High 清單），於 Gate 前寫入 PRD 等同把未經批准之決策固化進事實來源第 3 層。且 PRD 不在大總管白名單內，落地須另行派工。**建議於 Spec Gate 通過、Spec 轉 `ACTIVE` 後，以一個 `PHASE-006-PRD-SYNC` Lite Packet 一次落地。**

| # | 位置 | 現況（逐字） | 建議修正（逐字） | 理由 |
|---|---|---|---|---|
| 1 | `docs/PRD.md:406`（§PHASE-006「對應 US」） | `**對應 US**：FE-US-13, 14, 15, 16；BE-US-10, 11, 12, 13；BE-US-18（保養快照）, 24（保養上限 5）, 25（保養完成鎖定）；NFR-US-10（保養附件）。` | 於句末追加：`次要關聯：FE-US-04／05（列表與篩選之類型擴充）、FE-US-21（草稿附件管理）、FE-US-27（響應式）、AD-US-06／07／08 與 BE-US-03（代操作延伸）、BE-US-20（草稿）、BE-US-30（區間公務總里程之複用）。` | PRD §4 US 索引表**已**將這些 US 之次要 Phase 標為 PHASE-006（FE-US-04＝63 行、FE-US-05＝64 行、FE-US-21＝80 行、AD-US-06/07/08＝98–100 行、BE-US-03＝115 行、BE-US-20＝132 行、BE-US-30＝142 行；FE-US-27＝86 行標「所有 FE Phase」），但 §PHASE-006 段落之「對應 US」未列出——**同一份 PRD 內部不一致**。 |
| 2 | `docs/PRD.md:412-420`（§PHASE-006「初始 Task Graph 概要」） | `T1…T8` 八列 | 於清單前追加一行：`（以下為概要；正式拆分依 Phase Spec §15 之 14 個 Task，對照表見該節。）` | 本 Spec 依 Packet 規模上限（≤5 AC、≤6 檔、不跨三層）將 8 項概要細化為 14 個 Task，並補齊 PRD 概要未涵蓋之代操作／列表／錯誤合約三項（其 US 已於 §4 索引表歸屬本 Phase）。 |
| 3 | `docs/PRD.md:421`（§PHASE-006「High 風險 Task」）與 `docs/PRD.md:549`（§6 總覽之 PHASE-006 列） | `**High 風險 Task**：T5, T6, T7。` ／ `\| PHASE-006 \| 分攤計算、保養附件、完成鎖定/快照 \|` | 分別改為：`**High 風險 Task**：見 Phase Spec §15（共 9 項）。` ／ `\| PHASE-006 \| 分攤計算、保養附件、完成鎖定/快照、不可逆 migration、授權與代操作、期間公務里程接線 \|` | 本 Spec 依 CLAUDE.md「認證、授權…一律 High」與既有升級先例，另將 migration／授權／代操作／金額上游升為 High（**保守方向，不縮減任何既有判定**）。 |

> 上列修正**皆不改變任何 User Story 原意、不縮減任何 AC、不擴大 Scope**，僅消除 PRD 內部不一致與 Spec 細化後之對齊。
