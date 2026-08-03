# PHASE-005 — 區間公務里程統計（共用里程引擎 + 個人／管理員統計查詢）

| 項目 | 內容 |
|---|---|
| **Spec 狀態** | `ACTIVE`（Spec Gate 通過：人類 leonchih 2026-08-03 裁定 D1~D10 全數照建議批准，見 §18） |
| **Phase ID** | PHASE-005 |
| **Task ID（本文件產出）** | SPEC-005 |
| **Base Commit** | main @ `310bc39`；工作 branch `phase-005` |
| **Risk Level** | Medium（PRD 定級；讀取統計。惟本引擎為 PHASE-006 保養分攤與 PHASE-007 折舊補貼之**金額上游**，統計語意錯誤會直接傳導為金額錯誤，故精度與語意條文**視同金額類**對待——見 §10.5） |
| **依賴** | PHASE-002（授權中介，DONE）、PHASE-003a（參數維護，DONE）、PHASE-004（差旅資料模型與完成快照，DONE） |
| **被依賴** | PHASE-006（BE-US-11 保養期間公務里程）、PHASE-007（BE-US-15 年度公務里程）、PHASE-009（作廢語意回歸） |
| **對應 US** | FE-US-06、AD-US-06（使用者統計部分）、BE-US-30、BE-US-20（草稿排除於統計，於此複核） |
| **Human Gate** | Spec 事前批准（本文件）＋ Mock Gate（區間選擇與統計顯示）＋ 整合 Gate（PRD 定：無 High Task——惟 §16 **D10** 就此提出裁定請求） |
| **產出者** | spec-writer（Task Context Packet SPEC-005） |

> **本 Spec 的規範基礎**：CLAUDE.md 事實來源優先序 1→5。本文件不改變任何 User Story 原意、不縮減 PRD 已列 AC。所有「推薦」字樣之處均**未定案**，需人類於 §16 決策點裁定後，由大總管以 Spec 修訂紀錄（§18）固化，方可轉 `ACTIVE`。

---

## 1. 目標與非目標

### 1.1 目標

1. **落地共用的區間公務總里程引擎**（PRD PHASE-005 §目標原文）：起訖含當日、依出差日期歸屬、僅計已完成且未作廢、加總各段總里程不重複加高速、跨分頁涵蓋完整區間。
2. **提供個人區間統計查詢**（FE-US-06）：一般使用者可選日期區間並查得該區間公務總里程。
3. **提供管理員檢視指定使用者之區間統計**（AD-US-06 第三條 AC）：管理員選擇日期區間後可見該使用者的公務總里程。
4. **複核草稿排除**（BE-US-20 第二條 AC）：草稿不得納入公務里程統計。
5. **固化引擎介面供 PHASE-006/007 複用**：引擎須為可在交易內呼叫、與呼叫者無耦合的函式（介面固化屬本 Phase；**006/007 的業務語意不在本 Phase**）。

### 1.2 非目標（Out of Scope）

| 項目 | 落點 | 說明 |
|---|---|---|
| 保養對本引擎的套用（BE-US-11、公務比例、分攤金額） | PHASE-006 | PRD 明列；本 Phase 只固化引擎，**不得**把 006 的 AC 提前納入 |
| 折舊對本引擎的套用（BE-US-15、年度補貼） | PHASE-007 | 同上；年度區間僅為本引擎 `dateFrom=YYYY-01-01, dateTo=YYYY-12-31` 之一般化用法，本 Phase 不新增年度專用端點或 AC |
| 作廢功能本身（狀態轉換、作廢原因、稽核） | PHASE-009 | 本 Phase 依「未作廢」條件過濾；PHASE-004 §14-3 已記「`VOIDED` 於 009 前不可達」。本 Phase 之排除規則**必須現在就寫成可測試的過濾條件**（測試以直接寫入 DB 之 `VOIDED` 列驗證，見 §11.2），作廢語意於 009 回歸 |
| 報表編號關鍵字、PDF | PHASE-008 | 與本 Phase 無交集 |
| 修正版 | PHASE-009 | 同上 |
| 綜合紀錄查詢（分頁列表）本身 | 已於 PHASE-004 落地（BE-US-29） | 本 Phase **不修改** `GET /applications`；統計為**獨立端點**，不共用分頁結果 |
| 參數欄位容量溢位修復（`unitPrice`/`vehiclePrice` → 500） | **待裁定，見 §16 D1** | 屬 PHASE-003a 錯誤合約修訂，非本 Phase 主題 |
| 效能數值量測 | PHASE-011 | 本 Phase 只保證聚合於 DB 層完成（AC-33） |

---

## 2. 可測試 Acceptance Criteria

> **AC 追溯規則**：每條 AC 標註來源 US／PRD 原文條目。**AC-01~AC-10 為 PRD PHASE-005「Acceptance Criteria 摘要」與 FE-US-06／BE-US-30 原文之逐條落地，不得縮減。**
> **符號**：`Tn` = 落在哪個 Task（§15）。

### A. 引擎語意（BE-US-30、FE-US-06、CLAUDE.md 日期規則）

**AC-01 起訖日均含當日（BE-US-30 第一條 AC；CLAUDE.md「日期區間起訖日均含當日」/ T1）** — Given 已完成差旅 X 之出差日期為 `2026-03-01`、Y 為 `2026-03-31`。When 查詢 `dateFrom=2026-03-01, dateTo=2026-03-31`。Then X 與 Y **均納入**。When 查詢 `dateFrom=2026-03-02`（或 `dateTo=2026-03-30`）。Then X（或 Y）**不納入**。
> **鑑別力**：測試必含 `dateFrom−1 日`／`dateFrom 當日`／`dateTo 當日`／`dateTo+1 日` 四點，任一 off-by-one 實作（`gt`/`lt` 誤用）必紅。

**AC-02 依「出差日期」歸屬區間（CLAUDE.md「差旅依出差日期歸屬期間與年度」；PHASE-004 `schema.prisma` `Application.primaryDate` 註解原文「非統計權威——PHASE-005 統計一律讀 `TravelApplication.tripDate`」/ T1, T2）** — Given 差旅之 `createdAt`／`completedAt` 落於區間**外**、`tripDate` 落於區間**內**。Then **納入**。Given 反之（`createdAt` 在區間內、`tripDate` 在區間外）。Then **不納入**。
> **鑑別力**：測試須刻意令 `createdAt` 與 `tripDate` 落在不同月份；若實作誤用 `createdAt`／`completedAt` 必紅。

**AC-03 僅計已完成（BE-US-30 第三條 AC、BE-US-20 第二條 AC / T2）** — Given 同一使用者於區間內另有 `status=DRAFT` 之差旅（含已填妥里程之草稿）。Then 該草稿之里程**完全不計入**；統計值與「草稿不存在時」逐位元相同。

**AC-04 排除已作廢（BE-US-30 第三條 AC、BE-US-22 第三條 AC / T2）** — Given 區間內存在 `status=VOIDED` 之差旅列（本 Phase 由測試直接寫入 DB 建立，見 §11.2 與 §16 D8）。Then **不計入**。
> **鑑別力**：若實作寫成 `status != 'DRAFT'` 而非 `status = 'COMPLETED'`，此測試必紅。

**AC-05 僅計差旅類型（PRD PHASE-005 目標「公務總里程」；PHASE-004 AC-71 相容行為 / T2）** — Given 區間內存在 `type=MAINTENANCE` 或 `DEPRECIATION` 之 `Application`（本 Phase 由測試直接寫入 DB 建立，子表尚不存在）。Then **不計入**，且**不得**因缺子表而拋錯。

**AC-06 僅計指定擁有人（BE-US-02、AD-US-06 / T2）** — Given 使用者 A 與 B 於同區間各有已完成差旅。When 以 `ownerId=A` 統計。Then 結果**只含** A 的里程；B 之任何里程不得混入（含 B 之代操作建立、擁有人仍為 B 者）。

**AC-07 加總各段總里程且不重複加高速（BE-US-30 第三、四條 AC、FE-US-06 第四條 AC；PHASE-004 AC-42 / T2）** — Given 差旅含 3 段：`(totalKm=10.00, highwayKm=10.00)`、`(totalKm=5.50, highwayKm=0.00)`、`(totalKm=20.25, highwayKm=8.00)`。Then 該筆貢獻 `35.75`。
> **鑑別力（數值鑑別，非結構鑑別）**：正確值 `35.75`；若實作誤為「總里程 + 高速里程」得 `53.75`；若誤為「僅加高速」得 `18.00`；若誤為「總里程 − 高速里程」得 `17.75`。三個錯誤值互不相同且與正確值不同，測試以精確等值斷言。

**AC-08 起日晚於迄日拒絕（BE-US-30 第二條 AC、FE-US-06 第二條 AC / T1）** — Given `dateFrom > dateTo`（含僅差一日之最小案例：`dateFrom=2026-03-02, dateTo=2026-03-01`）。Then 拒絕，不執行任何查詢、不回傳任何數值。
> `dateFrom == dateTo` 為**合法**（單日統計），必須通過——此為本條的反向鑑別案例。

**AC-09 無有效差旅回 0（FE-US-06 第三條 AC / T3）** — Given 區間內無任何已完成且未作廢之差旅（無資料、或僅有草稿／作廢／他人／非差旅）。Then 回傳總里程 **0**（依 §16 D3 定案之表示法），HTTP **200**，**不得**為 404、不得為 `null`、不得為空字串、不得視為錯誤。

**AC-10 統計涵蓋完整區間，非單頁（FE-US-06 第五條 AC、PRD「跨分頁涵蓋完整區間」/ T3）** — Given 使用者於區間內有 **101 筆**已完成差旅（`> PAGE_SIZE_MAX = 100`，`application-query.ts:PAGE_SIZE_MAX`）。Then 統計值等於 101 筆之完整加總。
> **鑑別力**：101 為刻意選值——若實作誤以 `GET /applications` 之分頁結果（預設 `pageSize=20`、上限 clamp 100）加總，結果將為前 20 筆或前 100 筆之和，與正確值不同。測試須令每筆里程互異（例如第 i 筆 `totalKm = 1.00 + i × 0.01`）以確保任何「取子集」實作皆得到不同數值。

**AC-11 里程為未取整之 2 位小數保真值（CLAUDE.md「金額與里程計算一律以後端為準」；PHASE-004 D5 `Decimal(10,2)` / T1）** — Given 三段 `10.01 + 10.01 + 10.01`。Then 結果為 `30.03`，**不得**取整為 `30`、不得出現 `30.029999…` 之浮點失真。全程以 `Prisma.Decimal`／DB `numeric` 運算，**禁止浮點中介**。
> 本 Phase **不對里程做任何四捨五入**——CLAUDE.md 的「最終金額為新臺幣整數」規範對象是**金額**，里程非金額（PHASE-006 之比例與 PHASE-007 之補貼才做整筆一次取整）。

**AC-12 引擎為可複用、可於交易內呼叫之介面（PRD「引擎在此固化」；ARCHITECTURE §3 `mileage` 模組 / T3）** — Given 引擎函式簽章接受 `PrismaClient | Prisma.TransactionClient`。When 於 `prisma.$transaction()` 內呼叫。Then 正常回傳、不自行開啟巢狀交易、不寫入任何資料（**唯讀**）。
> 本 AC **不**引入任何 PHASE-006/007 的業務語意；僅驗證介面形狀與唯讀性。

**AC-13 快照與段加總一致性不變式（PHASE-004 AC-42/AC-50 閉環 / T3）** — Given 任一 `status=COMPLETED` 之差旅。Then `TravelApplication.snapshotTotalKm` == Σ 其 `TripSegment.totalKm`。
> 此為**跨 Phase 不變式守門**：若 §16 **D2** 裁定引擎讀快照，本 AC 是「快照可信」的唯一證明；若裁定引擎加總段落，本 AC 是「快照未腐化」的迴歸守門。**兩種裁定下本 AC 皆保留。**

### B. 端點與錯誤合約

**AC-14 個人區間統計查詢成功（FE-US-06 第一條 AC / T4）** — Given 已登入之一般使用者、有效 `dateFrom`/`dateTo`。When 呼叫統計端點（路徑與形狀依 §16 **D4** 定案）。Then **200**，回應含該使用者該區間之公務總里程。

**AC-15 缺 `dateFrom` 或 `dateTo` → 400（依 §16 D5 裁定 / T4）** — Given 未提供 `dateFrom`（或 `dateTo`）。Then **400 `VALIDATION_ERROR`**，`fields` 定位缺漏欄位；**不得**套用任何預設區間、不得回傳數值。
> **本條之行為完全取決於 D5 裁定**；若 D5 改採「預設近一年」，本 AC 須改寫為「未提供時套用預設並於 `appliedFilters` 明示」。**未裁定前不得實作。**

**AC-16 日期格式錯誤 → 400（沿用 PHASE-004 AC-62 慣例 / T4）** — Given `dateFrom=2026-13-01`／`2026/03/01`／`abc`／空字串。Then 400 `VALIDATION_ERROR`，`fields[].field` 為 `dateFrom`／`dateTo`；沿用 `parameter-service.ts:parseUtcDate` 之 `YYYY-MM-DD` 判定。

**AC-17 起>迄 → 400 且欄位可定位（BE-US-30 第二條、FE-US-06 第二條 / T4）** — Then 400 `VALIDATION_ERROR`，`fields` 含 `{ field: "dateRange", reason: <zh-TW 區間錯誤說明> }`（沿用 `application-query.ts:parseApplicationListQuery` 既有 `dateRange` 欄位名，保持前端錯誤定位一致）。

**AC-18 `appliedFilters` 回報實際套用值（沿用 PHASE-004 AC-60 慣例 / T5）** — Then 回應含 `appliedFilters: { dateFrom, dateTo, ownerId }`，值為後端實際套用者（`YYYY-MM-DD` 字串），使 AC-01／AC-24 可由回應本身驗證。

**AC-19 後端權威：端點不採信任何前端提交之里程／金額（CLAUDE.md「後端不得採用前端提交的金額」/ T6）** — Given 請求夾帶 `totalKm=999999`／`amount=…`（無論 query string 或 body）。Then 一律忽略；回應數值為後端計算值。**統計端點為 `GET`，不得因夾帶欄位而改變輸出或報 500。**

**AC-20 本 Phase 不新增 `ErrorCode`（NFR-US-16 / T6）** — Then 所有錯誤路徑僅使用既有 `ErrorCode` 聯集（`platform/errors.ts`）：`VALIDATION_ERROR`(400)、`UNAUTHORIZED`(401)、`FORBIDDEN`(403)、`PASSWORD_CHANGE_REQUIRED`(403)、`NOT_FOUND`(404)、`INTERNAL_ERROR`(500)。**不得**新增碼、不得擴充 4xx 對照表。

### C. 權限與資料隔離

**AC-21 未登入被拒（BE-US-01 / T5）** — 401 `UNAUTHORIZED`，回應不含任何數值欄位。

**AC-22 強制改密使用者被拒（PHASE-002 / T5）** — Given `mustChangePassword=true`。Then 403 `PASSWORD_CHANGE_REQUIRED`。

**AC-23 一般使用者自帶他人識別值 → 403，不靜默降級（BE-US-02 第三條 AC、PHASE-004 AC-74 / T4）** — Given 一般使用者查詢時指定他人 `ownerId`。Then **403 `FORBIDDEN`**；**不得**靜默改查自己（那會使使用者以為看到的是他人數據）、**不得**回傳他人任何數值。
> 沿用 `application-query.ts:resolveOwnerId` 之既有定案（PHASE-004 §6.1）；BE-US-29 原文「拒絕或忽略」之二擇一已由 PHASE-004 定為「拒絕」，本 Phase 保持一致，非新決策。

**AC-24 管理員指定使用者 → 只回該使用者統計（AD-US-06 第三條 AC / T5）** — Given 管理員指定 `ownerId=U`。Then 回應為 U 的區間統計；`appliedFilters.ownerId === U`。

**AC-25 管理員未指定使用者 → 預設自己（PHASE-004 D10 慣例 / T5）** — Then 統計對象為管理員自己；`appliedFilters.ownerId === actor.id`。

**AC-26 回應不外洩他人資料與敏感欄位（NFR-US-16、PHASE-004 D6 邊界警示 / T6）** — Then 統計回應**僅含**里程與 `appliedFilters`（＋依 §16 **D7** 定案之筆數）；**不得**含補助單價、金額、出差目的、地點、附件路徑、他人 `displayName`／`loginName`。以**逐鍵斷言**驗證（列舉允許鍵集合，多一鍵即紅）。
> **PHASE-004 D6 邊界擴張警示（PROJECT_STATE 原文）**：「不得以『一般使用者不知道單價』作為安全前提」。本 Phase 的對應落實是**正向白名單**：回應鍵集合為封閉清單，新增欄位須改 Spec。

### D. 前端（FE-US-06、AD-US-06）

**AC-27 五態齊備（FE-US-06 / T7）** — Loading／Empty／Error／Success／Permission denied 各有可辨識之 zh-TW 呈現（明細見 §4）。

**AC-28 起>迄就地提示日期區間錯誤（FE-US-06 第二條 AC / T7）** — Given 使用者選擇 `起 > 迄`。Then 顯示 zh-TW 區間錯誤提示並就地標示日期欄位；後端仍為權威（即使前端未攔截，後端 400 之 `fields.dateRange` 亦須就地呈現）。

**AC-29 0 值明確顯示（FE-US-06 第三條 AC / T7）** — Given 後端回 0。Then 顯示「0.00 公里」（或 D3 定案之格式）＋ zh-TW 說明（例：「此區間無已完成的差旅紀錄」）；**不得**顯示空白、`—`、`NaN` 或錯誤樣式。

**AC-30 顯示值一律來自統計端點，前端不自算（CLAUDE.md「前端預覽僅供參考，後端不得採用前端提交的金額」；PHASE-004 §11.3 慣例 / T7）** — Then 前端**不得**由列表 `items[]` 之 `totalKm` 加總得出統計值。
> **鑑別力**：測試以 mock 令「統計端點回 `999.99`」而「列表回 3 筆合計 `30.00`」，斷言畫面顯示 `999.99`；若實作自算必紅。

**AC-31 管理員頁之統計對象為被檢視使用者（AD-US-06 第三條 AC / T8）** — Given 管理員位於 `/admin/users/:userId/applications`。When 選擇日期區間查詢。Then 請求之 `ownerId` 為 `:userId`，顯示值為該使用者的統計，非管理員自己的。

**AC-32 響應式：375px 無水平溢位（FE-US-27、PHASE-004 AC-89 慣例 / T8）** — Given 375px viewport。Then 統計區塊之日期選擇與數值可用，`document.body.scrollWidth <= window.innerWidth`。

### E. 非功能

**AC-33 聚合於 DB 層完成（NFR-US-14、PHASE-004 AC-91 慣例 / T3）** — Then 統計以單一 DB 聚合查詢（`aggregate`/`groupBy`/`count`）取得，**不得**把命中集合全部讀入 Node 記憶體後於應用層相加、**不得**逐筆 N+1 查詢段落。查詢須可利用 `Application` 既有索引（見 §7.2 與 §16 **D9**）。

**AC-34 錯誤格式統一且不外洩（NFR-US-16、PHASE-004 AC-90 / T6）** — Then 所有錯誤回應為 `{ error: { code, message, requestId, fields? } }`；**不得**含堆疊、DB 結構、SQL、內部路徑；日誌不含密碼／token／session cookie。

> **AC 總數：34**

---

## 3. 正常流程

### 3.1 一般使用者：查詢自己的區間公務總里程（FE-US-06）

```
使用者登入（PHASE-002 session cookie）
  → 進入統計區塊（落點依 §16 D6 定案）
  → 選擇起日 / 迄日
  → 前端就地驗證（起 ≤ 迄；格式）——僅為體驗，後端為權威
  → GET <統計端點>?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD   [credentials: include]
      【授權】requireAuth + requirePasswordChanged
      【授權】resolveOwnerId(actor, query.ownerId) → 一般使用者恆為自己；自帶他人 → 403（AC-23）
      → 解析與驗證日期（含當日語意、起>迄 → 400）（AC-15~17）
      → 引擎：sumOfficialMileage({ ownerId, dateFrom, dateTo })
           where: Application.ownerId = ownerId
              AND Application.type   = TRAVEL          （AC-05）
              AND Application.status = COMPLETED       （AC-03 + AC-04：COMPLETED 同時排除 DRAFT 與 VOIDED）
              AND TravelApplication.tripDate BETWEEN dateFrom AND dateTo   （AC-01/02，起訖含當日）
           aggregate: SUM(<里程來源，依 D2 定案>)                          （AC-07/AC-33）
      → 無命中 → 0（AC-09）
  → 200 { totalKm: "123.45", appliedFilters: {...} }（形狀依 D3/D4/D7 定案）
  → 前端顯示總里程（不自算，AC-30）
```

### 3.2 管理員：檢視指定使用者的區間統計（AD-US-06）

```
管理員登入 → /admin/users/:userId/applications（PHASE-004 既有頁）
  → 統計區塊選擇起日 / 迄日
  → GET <統計端點>?dateFrom=…&dateTo=…&ownerId=:userId
      【授權】requireAuth + requirePasswordChanged
      【授權】resolveOwnerId → actor.role === ADMIN → 允許指定任一 ownerId（AC-24）
      → 同 3.1 引擎路徑
  → 200；appliedFilters.ownerId === :userId（AC-18/24/31）
```

### 3.3 PHASE-006/007 之複用路徑（**本 Phase 僅固化介面，不實作**）

```
（PHASE-006 保養完成流程 / PHASE-007 折舊完成流程）
  → prisma.$transaction(async (tx) => {
        const { totalKm } = await sumOfficialMileage(tx, { ownerId, dateFrom, dateTo });
        …各自 Phase 之比例／補貼計算與快照寫入…
     })
```
> 本 Phase 只以 AC-12 驗證「引擎接受 `tx`、唯讀、不開巢狀交易」。**不得**在本 Phase 加入任何比例、分攤、補貼、年度預設之邏輯或 AC。

---

## 4. 五態（Loading / Empty / Error / Success / Permission denied）

| 畫面／區塊 | Loading | Empty | Error | Success | Permission denied |
|---|---|---|---|---|---|
| **個人區間統計**（落點依 D6） | 數值區顯示「計算中…」，查詢鈕停用（防重複提交） | 區間內無有效差旅 → 顯示「0.00 公里」＋ zh-TW 說明「此區間無已完成的差旅紀錄」（AC-29）；**非**錯誤樣式 | 400 `VALIDATION_ERROR` → 依 `fields` 就地標示 `dateFrom`／`dateTo`／`dateRange`（AC-28）；5xx／網路失敗 → zh-TW 訊息 ＋「重試」 | 顯示「公務總里程 X.XX 公里」＋ 實際套用區間（來自 `appliedFilters`） | 401 → 導向登入；403 `PASSWORD_CHANGE_REQUIRED` → 導向強制改密；403 `FORBIDDEN` → 「無權查詢此使用者之統計」（不顯示任何數值） |
| **管理員：指定使用者統計**（`/admin/users/:userId/applications` 內） | 同上 | 同上（文案標明對象使用者） | 同上 | 顯示對象使用者之總里程；標示「檢視中：<displayName>」（沿用 PHASE-004 該頁既有標示，不新增資料揭露） | 一般使用者進入該路由 → `RouteGuard` + 後端 `requireAdmin`（頁面既有）；統計端點本身以 `resolveOwnerId` 403 為權威 |

> **初始態（尚未查詢）**：不得預先顯示任何數值（避免使用者誤讀為「全部期間」）。顯示提示「請選擇日期區間後查詢」。此與 D5「起訖必填、無預設」互相一致；若 D5 改採預設區間，本列須連動修訂。

---

## 5. 邊界條件

| # | 邊界 | 定案行為 | 對應 AC |
|---|---|---|---|
| B-01 | `dateFrom == dateTo` | **合法**，只統計該日（起訖含當日） | AC-01/08 |
| B-02 | `tripDate == dateFrom` 當日 | **納入** | AC-01 |
| B-03 | `tripDate == dateTo` 當日 | **納入** | AC-01 |
| B-04 | `tripDate == dateFrom − 1 日` | **不納入** | AC-01 |
| B-05 | `tripDate == dateTo + 1 日` | **不納入** | AC-01 |
| B-06 | `dateFrom = dateTo + 1 日`（最小倒置） | 400（AC-08 之最小鑑別案例） | AC-08/17 |
| B-07 | 區間內僅有草稿 | 回 0 | AC-03/09 |
| B-08 | 區間內僅有作廢 | 回 0 | AC-04/09 |
| B-09 | 區間內僅有他人差旅 | 回 0 | AC-06/09 |
| B-10 | 區間內僅有 MAINTENANCE／DEPRECIATION 申請 | 回 0，且不因缺子表拋錯 | AC-05/09 |
| B-11 | 已完成差旅但 `tripDate` 在區間外、`createdAt` 在區間內 | **不納入** | AC-02 |
| B-12 | 草稿之 `tripDate` 為 `null` | 天然不納入（`status` 已排除）；不得因 `null` 比較而拋錯 | AC-03 |
| B-13 | 單段 `highwayKm == totalKm` | 只計 `totalKm` | AC-07 |
| B-14 | 單段 `highwayKm == 0` | 只計 `totalKm` | AC-07 |
| B-15 | 已完成差旅有 0 段 | PHASE-004 AC-12 已保證「0 段不可完成」；若 DB 中仍存在（資料異常）→ 貢獻 0，不拋錯 | AC-07/13 |
| B-16 | 區間內 101 筆已完成差旅 | 全數納入（跨分頁完整性最小鑑別值） | AC-10 |
| B-17 | 區間跨年（`2025-06-01`~`2026-05-31`） | 正常統計；本 Phase 無年度特殊語意 | AC-01 |
| B-18 | 區間為未來日期 | 合法（US 未禁止；PHASE-004 B-27 已允許未來出差日）；通常回 0 | AC-09 |
| B-19 | 極大區間（如 `1900-01-01`~`2999-12-31`） | 合法；仍以 DB 聚合，不分頁、不截斷 | AC-10/33 |
| B-20 | 日期格式非 `YYYY-MM-DD`（`2026/03/01`、`2026-3-1`、`2026-02-30`） | 400 `VALIDATION_ERROR`（沿用 `parseUtcDate`） | AC-16 |
| B-21 | 時區 | 一律 **UTC 日粒度**（`@db.Date`），沿用 `parseUtcDate`／`utcDateOnly`／`formatUtcDate`；**不得**引入本地時區換算 | AC-01/02 |
| B-22 | 管理員指定不存在之 `ownerId` | 200 + 0（沿用 `resolveOwnerId` 不查 DB 之既有定案，PHASE-004）；**不得**因此洩漏「帳號是否存在」 | AC-24 |
| B-23 | 一般使用者 `ownerId` 帶自己的 id | 等同未指定，200（`resolveOwnerId` 既有行為） | AC-23 |
| B-24 | 里程合計出現 3 位以上小數 | 不可能（來源皆 `Decimal(_,2)`）；若發生視為資料異常，**不得**靜默取整——以 2 位小數格式化輸出並須有測試涵蓋 `.005` 之類輸入不出現於來源 | AC-11 |
| B-25 | 里程合計極大（101 筆 × 每筆上限） | `Decimal` 累加於 DB `numeric` 完成，無溢位風險；輸出字串不得改用 JSON number | AC-11 |
| B-26 | 同時帶 `ownerId` 與非法日期 | 授權判定（403）優先於格式判定（400）——沿用 PHASE-004 route 慣例；**須有明文測試固定此順序**，避免以 400 洩漏「格式有效與否」之側信道 | AC-17/23 |

---

## 6. 權限與敏感資料

### 6.1 授權矩陣

| 端點 | 中介層 | 額外判定 |
|---|---|---|
| `GET <統計端點>`（路徑依 D4） | `requireAuth` + `requirePasswordChanged` | 複用 `application-query.ts:resolveOwnerId(actor, query.ownerId)`：一般使用者強制自己、自帶他人 → 403 `FORBIDDEN`；管理員可指定任一 `ownerId`，未指定則預設自己 |

> **不新造授權機制**（Packet 明令）：不新增中介層、不新增角色、不新增 session 語意。若 D4 裁定採「管理員專用路徑」，該路徑另加既有 `requireAdmin`。

### 6.2 資料隔離不變式（沿用 PHASE-004 §6.2，於統計資料上的落地）

1. 統計對象一律由 `resolveOwnerId` 決定，**永不**直接採信 query string 的使用者識別值。
2. 一般使用者自帶他人識別值 → **403，不靜默降級**（AC-23）。
3. 回應為**封閉鍵集合白名單**（AC-26）：新增任何欄位都是 Spec 變更。
4. 錯誤回應不因「資源存在與否」而不同（B-22）。

### 6.3 敏感資料

- 統計回應**不含**任何補助單價、金額、出差目的、地點、附件資訊（AC-26）。
- **PHASE-004 D6 邊界警示落地**（PROJECT_STATE 原文：「不得以『一般使用者不知道單價』作為安全前提」）：本 Phase 不因「里程看似無害」而放寬——里程仍是他人業務資料，跨使用者存取一律 403。
- 日誌沿用 `sanitizeForLog` + pino redact；**不記錄** session cookie、token。查詢參數（日期、`ownerId`）可入 log（非個資、非機密），但 `ownerId` 屬內部 id，不得與 `loginName` 一併輸出以免組成可追蹤剖繪。
- 測試一律合成資料（CLAUDE.md 禁止事項）。

---

## 7. API Contract

> **本節形狀取決於 §16 D3/D4/D5/D7 之裁定。以下為「推薦形狀」，標示 `【D4】` 等處為待裁定點。未裁定前不得實作。**

### 7.1 端點（推薦：單一端點 + `ownerId` 參數）

| 方法 | 路徑 | 中介 | Query | 成功回應 | 主要錯誤 |
|---|---|---|---|---|---|
| GET | `/statistics/mileage` 【D4】 | auth + pwd | `dateFrom`（必填【D5】）、`dateTo`（必填【D5】）、`ownerId?` | 200 `MileageSummaryResponse` | 400 `VALIDATION_ERROR`（缺漏／格式／起>迄）；401 `UNAUTHORIZED`；403 `PASSWORD_CHANGE_REQUIRED`；403 `FORBIDDEN`（一般使用者自帶他人 `ownerId`） |

- 前端經 nginx `/api` 前綴呼叫（PHASE-001 定案），沿用 `credentials: 'include'` 與 `parseApiResponse`。
- **無 `page`/`pageSize` 參數**——統計不分頁（AC-10）。

### 7.2 DTO（推薦形狀）

```ts
interface MileageSummaryResponse {
  /** 公務總里程；Decimal 字串，固定 2 位小數，未取整（AC-11）。無資料為 "0.00"（AC-09）。【D3】 */
  totalKm: string;
  /** 納入統計之已完成差旅筆數（透明度用；是否保留見【D7】） */
  applicationCount: number;
  /** 後端實際套用值（AC-18） */
  appliedFilters: {
    dateFrom: string;   // YYYY-MM-DD
    dateTo: string;     // YYYY-MM-DD
    ownerId: string;
  };
}
```

> **鍵集合為封閉白名單**（AC-26）：`totalKm`、`applicationCount`【D7】、`appliedFilters.{dateFrom,dateTo,ownerId}`。**不得**新增 `segments`、`items`、`unitPrice`、`amount`、`ownerDisplayName` 等。

### 7.3 引擎介面（後端內部；模組落點 `backend/src/mileage/`，對齊 ARCHITECTURE §3 `mileage` 模組）

```ts
// 純函式：區間驗證與正規化（不碰 DB、不知道「今天」）
export interface ParsedMileageRange {
  errors: FieldError[];
  dateFrom: Date | null;   // UTC 日粒度
  dateTo: Date | null;
}
export function parseMileageRange(raw: { dateFrom?: string; dateTo?: string }): ParsedMileageRange;

// DB 聚合：唯讀，可接受交易 client（AC-12/33）
export type PrismaLike = PrismaClient | Prisma.TransactionClient;
export interface OfficialMileageParams { ownerId: string; dateFrom: Date; dateTo: Date; }
export interface OfficialMileageResult { totalKm: Prisma.Decimal; applicationCount: number; }
export function sumOfficialMileage(
  db: PrismaLike,
  params: OfficialMileageParams
): Promise<OfficialMileageResult>;

// 純函式：where 建構（供單元測試直接斷言過濾條件形狀）
export function buildOfficialMileageWhere(params: OfficialMileageParams): Prisma.ApplicationWhereInput;
```

**`buildOfficialMileageWhere` 之定案條件（AC-03~06）**：

```ts
{
  ownerId: params.ownerId,
  type: "TRAVEL",
  status: "COMPLETED",                       // 同時排除 DRAFT 與 VOIDED——見 §16 D8
  travel: { tripDate: { gte: params.dateFrom, lte: params.dateTo } },   // 起訖含當日
}
```

**索引利用**（AC-33）：`Application` 既有 `@@index([ownerId, status, primaryDate])` 之前綴 `(ownerId, status)` 為兩個等值條件，可完整利用；`type` 與 `travel.tripDate` 由 PostgreSQL 於命中列上進一步過濾。`TravelApplication` 另有既有 `@@index([tripDate])`。**是否新增索引見 §16 D9。**

### 7.4 錯誤碼

**本 Phase 不新增任何 `ErrorCode`**（AC-20）。沿用 `platform/errors.ts` 既有聯集；4xx 對照表（`error-handler.ts`，AR-2 註記之擴充規則）**不需擴充**。

---

## 8. 資料模型與 migration

### 8.1 影響

- **無新資料表、無新欄位、無新 enum、無資料異動**。本 Phase 為**唯讀統計**。
- 讀取對象：`Application`（`ownerId`／`type`／`status`）、`TravelApplication`（`tripDate`、`snapshotTotalKm`）、`TripSegment`（`totalKm`）——皆為 PHASE-004 既有欄位。
- **migration**：預設 **無**。唯一可能的 migration 是 §16 **D9** 若裁定新增索引（非破壞性、可逆）。

### 8.2 PHASE-004 資料模型充分性核實（Packet Stop Condition 檢查）

| 統計需求 | 既有欄位 | 是否充分 |
|---|---|---|
| 依出差日期歸屬 | `TravelApplication.tripDate DateTime @db.Date` | ✅ 日粒度、含當日語意可直接以 `gte`/`lte` 表達 |
| 已完成過濾 | `Application.status ApplicationStatus` | ✅ |
| 未作廢過濾 | `ApplicationStatus.VOIDED` 已宣告 | ✅（`status = COMPLETED` 同時涵蓋兩者；語意約束見 D8） |
| 擁有人隔離 | `Application.ownerId` | ✅ |
| 各段總里程 | `TripSegment.totalKm Decimal(10,2)` | ✅ |
| 高速不重複加 | `TripSegment.highwayKm` 為 `totalKm` 之**其中一部分**（PHASE-004 AC-42 原文「總里程 = Σ 各段總里程，高速不重複加」、B-03「`highwayKm == totalKm` 允許；總里程仍只計 `totalKm`」） | ✅ 只讀 `totalKm` 即滿足 |
| 快照來源 | `TravelApplication.snapshotTotalKm Decimal(12,2)`（PHASE-004 AC-50 完成時寫入「Σ 各段 totalKm」） | ✅ |
| 差旅類型 | `Application.type ApplicationType` | ✅ |

> **結論：PHASE-004 資料模型充分支撐本 Phase 統計需求，無 BLOCKED。**

---

## 9. Data Flow（本 Phase 影響部分）

```
── 區間公務里程統計（唯讀）───────────────────────────────────────────────
前端（個人統計區塊 / 管理員使用者頁統計區塊）
   │  dateFrom, dateTo, [ownerId]
   ▼
GET <統計端點>
   ├─【授權】requireAuth ─────────────────── 未登入 → 401
   ├─【授權】requirePasswordChanged ───────── 強制改密 → 403
   ├─【授權】resolveOwnerId(actor, ownerId) ─ 一般使用者帶他人 → 403（不降級）
   ├─ parseMileageRange(dateFrom, dateTo) ── 缺漏/格式/起>迄 → 400（fields 可定位）
   ▼
mileage 引擎（唯讀，可於 tx 內呼叫）
   │  where: ownerId ∧ type=TRAVEL ∧ status=COMPLETED ∧ tripDate ∈ [dateFrom, dateTo]
   │  aggregate: SUM(<D2 來源>)  +  COUNT(*)
   │  （分頁不存在——完整區間一次聚合，AC-10/33）
   ▼
{ totalKm: Decimal, applicationCount: number }
   │  Decimal → 字串（2 位小數，未取整）
   ▼
200 { totalKm, applicationCount, appliedFilters }
   ▼
前端顯示（不自算，AC-30）

── PHASE-006/007 之複用（介面固化於本 Phase，語意不在本 Phase）────────────
保養/折舊完成流程 → prisma.$transaction(tx => sumOfficialMileage(tx, {...})) → 各自計算
```

**與 DATA_FLOW §2.8 之對應**：本節即 `DATA_FLOW.md` §2.8「統計查詢（區間 / 年度公務里程）」之具體化，語意逐條一致（授權、日期驗證、僅已完成且未作廢、去重高速、涵蓋完整區間、草稿/作廢不納入、無資料回 0）。**本 Phase 不修改 `DATA_FLOW.md` 本體**——建議更新點見 §13。

---

## 10. 非功能需求

### 10.1 NFR-US-14（基本效能）
- 統計查詢目標 < 2s；以單一 DB 聚合完成（AC-33），不做應用層加總、不做 N+1。
- 數值驗證集中於 PHASE-011；本 Phase 僅保證查詢形狀與索引利用正確。

### 10.2 NFR-US-16（結構化錯誤處理）
- 統一錯誤格式與可定位 `fields`（AC-17/34）；不新增 `ErrorCode`（AC-20）。

### 10.3 NFR-US-27（響應式）
- 375px 無水平溢位（AC-32）。

### 10.4 可搬遷性
- 無新環境變數、無新依賴、無新外部服務。

### 10.5 精度紀律（本 Phase 之特別要求）
> 本 Phase Risk 雖為 Medium，但引擎是 PHASE-006 分攤金額與 PHASE-007 補貼金額的**唯一里程來源**。因此以下條文**視同金額類**對待：
> 1. **全程 `Prisma.Decimal` / DB `numeric`，禁止任何浮點中介**（AC-11）。
> 2. **本 Phase 對里程不做任何取整**（取整只發生在下游 Phase 的金額計算，且為「整筆一次四捨五入」——PRD PHASE-006/007 原文）。
> 3. **傳輸以字串表示 Decimal**（沿用 PHASE-003a/004 DTO 慣例），不得改用 JSON number。
> 4. 任何改變上述三條的提議，一律**必須人類批准**。

---

## 11. 測試策略

TDD：每 Task 先寫**會失敗**的測試再實作；不得刪除／弱化／skip 測試換綠燈（CLAUDE.md）。

### 11.0 測試紀律（強制，寫入每個 Task Packet）

- **測試隔離**：沿用 INFRA-001 結構（per-worker schema + per-file 清空）。新測試檔清理**一律限定自建資料**：自建 `loginName` 前綴 + `RUN_ID`、自建 `application.id` 陣列；**禁用全域 `deleteMany({})`**。
- **SQL LIKE `_` 萬用字元陷阱（PHASE-004 R6）**：清理若以 `startsWith`/`contains` 比對含底線之前綴（如 `p5mil_`），`_` 在 `LIKE` 中是單字元萬用字元，會誤刪他檔資料。**對策**：清理一律以 `in: [...自建 id 陣列]` 精確比對，或前綴不含 `_`／`%`；若必須用前綴比對，須依 `application-query.ts:escapeLikePattern` 之同款跳脫。
- **鑑別力自證**：每組核心測試須能在「改為錯誤實作」時變紅；下表逐項標明反向案例。
- **兩輪全綠**：涉及 DB 之 Task 須於**同一 DB 連跑兩輪**全綠（沿用 PHASE-003/004 驗收紀律）。
- **lint 驗收**：repo root `npx biome check .` 全掃並貼出實際輸出。
- **合成資料**：一律合成，無真實個資。

### 11.1 單元（Vitest，不需 DB）

| 對象 | 案例數量級 | 鑑別力自證 |
|---|---|---|
| `parseMileageRange`（AC-08/15/16/17） | ≥ 14 | ① `dateFrom == dateTo` **必須通過**（反向鑑別：若實作誤用 `>=` 判倒置，此案例必紅）；② `dateFrom = dateTo + 1 日` 必拒（最小倒置）；③ 缺 `dateFrom`／缺 `dateTo`／兩者皆缺各一（依 D5）；④ 格式：`2026/03/01`、`2026-3-1`、`2026-02-30`、`""`、`"abc"`；⑤ 回傳**全部**欄位錯誤而非第一項 |
| `buildOfficialMileageWhere`（AC-01~06） | ≥ 8 | ① `status` 必須恰為 `"COMPLETED"`（斷言字面值——若實作寫成 `{ not: "DRAFT" }`，AC-04 之作廢排除即失效，本斷言直接變紅）；② `type` 恰為 `"TRAVEL"`；③ `tripDate` 用 `gte`/`lte`（**不是** `gt`/`lt`）——直接斷言 where 物件鍵名；④ `ownerId` 來自參數而非任何預設 |
| ~~里程加總純函式（若 D2 裁定為「段加總」則新增此列）（AC-07/11）~~ **不適用** | — | **D2(a) 已裁定讀快照聚合（Spec Gate 2026-08-03），此純函式不存在，本列不成立**；AC-07／AC-11 之數值鑑別力改由整合層精確等值斷言承擔（見 §11.2 與 §12 表註 2） |
| 里程格式化（AC-09/11/29）**（歸屬 T4：DTO 序列化落點，非 T1）** | ≥ 6 | `0 → "0.00"`；`30.03 → "30.03"`；`30.1 → "30.10"`；不得輸出 `"30"`、`"30.030000"`、`30.03`(number)。T1~T3 之引擎層僅回傳 `Prisma.Decimal`，**字串表示法於 T4 之 DTO 層產生並驗證** |

### 11.2 整合（Vitest + PostgreSQL + 真實 route）

| 群組 | 內容 | 鑑別力自證 |
|---|---|---|
| **含當日邊界**（AC-01） | 四點測試：`dateFrom−1`／`dateFrom`／`dateTo`／`dateTo+1` 各建一筆已完成差旅，斷言恰納入中間兩筆 | 任一 off-by-one（`gt`/`lt`）必紅；斷言為**精確數值等值**而非「非零」 |
| **歸屬日期權威**（AC-02） | 建 `createdAt` 在區間內但 `tripDate` 在區間外之已完成差旅（以 `prisma` 直接設定 `createdAt`），及反向案例 | 若實作誤用 `createdAt`／`completedAt`／`primaryDate` 語意必紅 |
| **狀態過濾（反向斷言）**（AC-03/04） | 同一使用者同區間：1 筆 COMPLETED（`10.00`）+ 1 筆 DRAFT（里程已填 `999.00`）+ 1 筆 **直接寫入 DB 的 VOIDED**（里程 `888.00`） | 斷言結果**恰為 `10.00`**。若實作漏排除草稿得 `1009.00`；漏排除作廢得 `898.00`；用 `!= DRAFT` 得 `898.00`——三者皆與 `10.00` 不同。**VOIDED 列以 `prisma.application.update({ data: { status: "VOIDED" } })` 直接建立**（PHASE-004 AC-58 保證 API 無此路徑，測試層直寫 DB 為合法且是本 Phase 唯一能現在驗證 AC-04 的方式；PHASE-009 回歸為真實流程） |
| **類型過濾**（AC-05） | 直接寫入 `type=MAINTENANCE`／`DEPRECIATION` 之 `Application`（無子表） | 不計入且不拋錯（若實作以 `travel` 關聯 inner join 而未加 `type` 條件，仍須通過；若實作對缺子表拋錯必紅） |
| **擁有人隔離**（AC-06） | A、B 各有同區間已完成差旅 | A 的統計不含 B 之里程（精確等值） |
| **高速去重數值鑑別**（AC-07） | 3 段 `(10.00,10.00)(5.50,0)(20.25,8.00)` 之單筆差旅完成後統計 | 期望 `35.75`；`53.75`／`18.00`／`17.75` 皆紅 |
| **跨分頁完整性**（AC-10） | 建 **101 筆**已完成差旅，第 i 筆 `totalKm = 1.00 + i×0.01` | 期望為 101 筆精確總和；若實作取列表前 20／前 100 筆，數值必不同必紅。（建檔以直接 `prisma.createMany` + 快照欄位寫入，避免 101 次完整完成流程之耗時；須於測試註解說明此捷徑不影響鑑別力） |
| **快照一致性不變式**（AC-13） | 對所有測試建立之 COMPLETED 差旅，斷言 `snapshotTotalKm == Σ segments.totalKm` | 若 D2 採快照來源，此為快照可信之證明；若採段加總，此為快照未腐化之守門 |
| **交易內呼叫與唯讀**（AC-12） | 於 `prisma.$transaction` 內呼叫引擎；並於呼叫前後比對 `Application`/`TravelApplication`/`TripSegment` 之 `updatedAt` 與筆數 | 引擎若寫入任何資料必紅；若自行開巢狀交易，Prisma 會報錯必紅 |
| **端點驗證**（AC-14~18） | 缺漏／格式／起>迄／成功；`appliedFilters` 逐鍵斷言 | 400 之 `fields[].field` 精確為 `dateFrom`／`dateTo`／`dateRange` |
| **權限矩陣**（AC-21~25） | {擁有者、他人一般使用者、管理員、未登入、`mustChangePassword`} × {未帶 `ownerId`、帶自己、帶他人} | 他人請求之 403 回應 body **逐鍵斷言不含**任何數值欄位（`totalKm`/`applicationCount`/`appliedFilters` 皆不得出現）；一般使用者帶他人 `ownerId` **不得**回自己的數值（靜默降級實作必紅） |
| **判定順序**（B-26） | 一般使用者同時帶他人 `ownerId` 與非法日期 | 恆為 403（非 400），固定順序 |
| **後端權威**（AC-19） | 夾帶 `totalKm=999999`（query 與 body 皆試） | 回應為後端計算值；不得 500 |
| **回應白名單**（AC-26） | 成功回應之鍵集合逐一列舉比對 | 多一鍵即紅（`Object.keys` 全等斷言） |
| **錯誤與日誌安全**（AC-34） | 以 logStream 擷取（沿用 PHASE-003 §9.4 模式） | 回應與日誌不含堆疊／SQL／DB 結構／cookie／token |
| **Decimal 精度往返** | `10.01 × 3` 之統計 | 期望 `"30.03"`；浮點實作得 `"30.029999999999998"` 或 `"30.02"` 必紅 |
| **聚合於 DB 層**（AC-33） | 以 Prisma `$on('query')` 或查詢計數斷言：統計一次請求之 SQL 查詢數為常數（不隨資料筆數成長） | N+1 實作（每筆差旅一次段落查詢）必紅 |

### 11.3 前端頁面測試（Vitest + Testing Library，mock fetch）

| 對象 | 測試 |
|---|---|
| 統計區塊（個人） | 五態各一（Loading／Empty(0 值)／Error+重試／Success／Permission denied）；起>迄就地提示；後端 400 之 `fields.dateRange` 就地呈現；防重複提交 |
| **不自算鑑別力**（AC-30） | mock：統計端點回 `"999.99"`、列表端點回 3 筆合計 `30.00`；斷言畫面顯示 `999.99` |
| 0 值呈現（AC-29） | mock 回 `"0.00"`；斷言顯示「0.00 公里」＋說明文案，且**非**錯誤樣式（斷言不存在 error role/class） |
| 管理員統計區塊（AC-31） | mock：斷言請求 URL 之 `ownerId` 等於路由 `:userId`；顯示值為該使用者統計 |

> 前端**不得**自行計算里程（後端權威）；顯示值一律來自 mock 之後端回應（對齊 PHASE-003a-T6／PHASE-004 §11.3 慣例）。

### 11.4 E2E（Playwright，整合 Gate）

1. 使用者登入 → 建 2 筆差旅並完成（不同出差日期）→ 統計區塊選擇涵蓋兩筆之區間 → 顯示正確總里程。
2. 邊界：把起日設為兩筆之間的日期 → 只剩一筆之里程。
3. 起 > 迄 → 顯示區間錯誤提示，不顯示數值。
4. 空區間 → 顯示 `0.00 公里` 與說明文案。
5. 管理員：進入 `/admin/users/:userId/applications` → 選區間 → 顯示該使用者統計（非管理員自己）。
6. 響應式：375px viewport 下 `document.body.scrollWidth <= window.innerWidth`（AC-32）。

### 11.5 安全測試
- 一般使用者以直連 URL 帶他人 `ownerId` → 403 且 body 無數值（E2E 3 之延伸，沿用 `e2e/data-isolation.spec.ts` 模式）。

---

## 12. AC ↔ 測試映射表（機械可查；隨 Task 完成更新「狀態」欄）

> **格式**：`AC` ｜ `層級` ｜ `測試檔（預定路徑）` ｜ `測試名（預定名稱）` ｜ `Task` ｜ `狀態`
> 狀態值：`PENDING`（Spec 階段）／`RED`（測試已寫且失敗）／`GREEN`（實作完成通過）。
> **Phase 完成前之覆蓋檢查與終審核對以本表為準**（治理 2026-08-02.1）。
> **`GREEN` 列之測試名為實際存在之測試名（逐字可 `grep`）；`PENDING` 列為預定名稱。** 巢狀測試以 `describe > it` 表示。
> 本表之 `GREEN` 依據：T1／T2／T3 + R1（commit `7bbdc00`）之兩輪全綠紀錄（2026-08-03）；T4（commit `d451125`）／T5（commit `d555be3`）／T6（commit `9b9b351`）各自結案並經複審 `APPROVE`（2026-08-03）；T7（commit `b6d4b50`）／T8（commit `17e7d8e`）各自結案並經複審 `APPROVE`、R5-BATCH（commit `fb182c5`）測試層強化（2026-08-03）；**E2E 17 條（含本 Phase `e2e/mileage-statistics.spec.ts` 六情境）由大總管親跑全綠**（2026-08-03）。

| AC | 層級 | 測試檔 | 測試名（預定） | Task | 狀態 |
|---|---|---|---|---|---|
| AC-01 | unit + integration | `backend/test/unit/mileage-range.test.ts`；`backend/test/integration/phase5-mileage-engine.test.ts` | `③ tripDate range uses 'gte'/'lte' keys exactly (not 'gt'/'lt') — precise key-name assertion`；`M-1① — AC-01 四點邊界（tripDate 精確 gte/lte，非近似值） > dateFrom−1／dateTo+1 不納入；dateFrom／dateTo 精確納入（bit-exact）` | T1, T2, R1 | GREEN |
| AC-02 | integration | `phase5-mileage-engine.test.ts` | `M-1② — AC-02 依「出差日期」歸屬區間（非 Application.primaryDate/createdAt） > primaryDate/createdAt 落區間內、tripDate 落區間外（刻意跨月份）→ 不納入`；`… > tripDate 落區間內、primaryDate/createdAt 落區間外（刻意跨月份）→ 納入` | T1, T2, R1 | GREEN |
| AC-03 | unit + integration | `mileage-range.test.ts`；`phase5-mileage-engine.test.ts` | `① status is exactly the literal 'COMPLETED' (not a negated DRAFT check — AC-04 discriminator)`；`counts only COMPLETED travel; DRAFT and VOIDED are fully excluded (reverse assertion, bit-exact)` | T2 | GREEN |
| AC-04 | integration | `phase5-mileage-engine.test.ts` | `counts only COMPLETED travel; DRAFT and VOIDED are fully excluded (reverse assertion, bit-exact)`（同一測試同時涵蓋 AC-03／AC-04，VOIDED 列直寫 DB） | T2 | GREEN |
| AC-05 | integration | `phase5-mileage-engine.test.ts` | `excludes MAINTENANCE / DEPRECIATION applications without throwing (no travel sub-table)` | T2 | GREEN |
| AC-06 | integration | `phase5-mileage-engine.test.ts` | `isolates by ownerId — B's mileage (including on-behalf-created) never leaks into A's total` | T2 | GREEN |
| AC-07 | integration | `phase5-mileage-engine.test.ts` | `sums to exactly 35.75 for a travel whose snapshot reflects segment totals without double-counting highway (PHASE-005-R1 M-2: real completion flow, not a hand-written fixture)` | T2, R1 | GREEN |
| AC-08 | unit | `mileage-range.test.ts` | `① accepts dateFrom == dateTo (single-day statistics) — reverse discriminator for '>=' misuse`；`② rejects dateFrom = dateTo + 1 day (minimal 1-day inversion) with dateRange field error` | T1 | GREEN |
| AC-09（引擎層：`Decimal 0` / `count 0`） | integration | `phase5-mileage-engine.test.ts` | `returns totalKm 0 and applicationCount 0 for a range with no matching rows`；`AC-09(a): empty range with zero applications returns Decimal 0 / count 0`；`AC-09(b): only a DRAFT travel exists in range — still returns Decimal 0 / count 0`；`AC-09(c): only a VOIDED travel exists in range — still returns Decimal 0 / count 0`；`AC-09(d): only another owner's travel and only a non-travel type exist for ownerA — Decimal 0 / count 0` | T3 | GREEN |
| AC-09（HTTP 層：200／`"0.00"`／非 `null`／非 404） | integration | `backend/test/integration/phase5-mileage-endpoint.test.ts` | `AC-09（HTTP 層）無有效差旅 > returns 200 with "0.00" when no eligible travel exists (not null, not empty string, not 404)` | T4 | GREEN |
| AC-10 | integration | `phase5-mileage-engine.test.ts` | `AC-10: sums the FULL range across 101 distinct-valued COMPLETED travels (> PAGE_SIZE_MAX)` | T3 | GREEN |
| AC-11 | integration | `phase5-mileage-engine.test.ts` | `preserves decimal precision across multiple rows: 10.01 + 10.01 + 10.01 = 30.03 exactly` | T3 | GREEN |
| AC-12 | integration | `phase5-mileage-engine.test.ts` | `AC-12: runs correctly inside prisma.$transaction and performs zero writes` | T3 | GREEN |
| AC-13 | integration | `phase5-mileage-engine.test.ts` | `AC-13 (PHASE-005-R1 M-2, global invariant scan): every segment-bearing COMPLETED travel in this schema has snapshotTotalKm == Σ TripSegment.totalKm`；`invariant (PHASE-005-R1 M-2, global): no COMPLETED travel application in this schema has a null snapshotTotalKm`（D2(a) 之快照非 null 守門） | T3, R1 | GREEN |
| AC-14 | integration | `phase5-mileage-endpoint.test.ts` | `AC-14 個人區間統計查詢成功 > authenticated user gets 200 with own range mileage`；`… > returns the DTO shape key by key (totalKm / applicationCount / appliedFilters)`；`… > a normal user may pass their OWN ownerId — equivalent to omitting it (B-23)`；`… > dateFrom == dateTo is legal (single-day statistics) and isolates that day only` | T4 | GREEN |
| AC-15 | integration | `phase5-mileage-endpoint.test.ts` | `AC-15 缺 dateFrom / dateTo → 400 > missing dateFrom / dateTo returns 400 with locating fields`；`… > both missing returns 400 locating BOTH fields (not just the first)` | T4 | GREEN |
| AC-16 | integration | `phase5-mileage-endpoint.test.ts` | `AC-16 日期格式錯誤 → 400 > malformed dates return 400 VALIDATION_ERROR`；`… > malformed dateTo locates the dateTo field (not dateFrom)` | T4 | GREEN |
| AC-17 | integration | `phase5-mileage-endpoint.test.ts` | `AC-17 起>迄 → 400 且欄位可定位 > dateFrom > dateTo returns 400 with fields[].field === "dateRange"`；`… > minimal 1-day inversion (dateFrom = dateTo + 1) is rejected the same way` | T4 | GREEN |
| AC-18 | integration | `backend/test/integration/phase5-mileage-authz.test.ts` | `AC-18 appliedFilters 回報實際套用值 > appliedFilters reports the effective dateFrom/dateTo/ownerId`；`… > echoes the ACTUAL range requested, not a default one (AC-01 可由回應自證)`；`… > admin proxy query reports ownerId === U (AC-24 可由回應自證)`；`… > admin query without ownerId reports ownerId === actor.id (AC-25 可由回應自證)` | T5 | GREEN |
| AC-19 | integration | `backend/test/integration/phase5-mileage-contract.test.ts` | `AC-19 後端權威：夾帶 totalKm/amount 等欄位一律忽略，統計端點不因此 500 > query string carrying totalKm=999999 and amount=... is ignored — response is the real backend value`；`… > a JSON body carrying totalKm/amount on this GET endpoint is likewise ignored, still 200`；`AC-19／T6-AR-1 陣列型／重複 query 鍵 → 400 VALIDATION_ERROR，絕不 500 > duplicate ownerId key as ADMIN → 400 (not 500) — the exact bug reported by T4-AR-1`；`… > duplicate ownerId key as USER → 400 (not the silent-403 path, not 500)`；`… > duplicate dateFrom key → 400 with fields[].field === 'dateFrom', never 500`；`… > duplicate dateTo key → 400 with fields[].field === 'dateTo', never 500`；`… > response body for the duplicate-key 400 leaks no application data (Object.keys === ['error'])` | T6 | GREEN |
| AC-20 | unit(structural) | `phase5-mileage-contract.test.ts` | `AC-20 結構性斷言：本 Phase 不新增 ErrorCode > errors.ts ErrorCode union is exactly the known baseline (no new/removed member)`；`… > src/mileage/** references only ErrorCode literals from the known baseline` | T6 | GREEN |
| AC-21 | integration | `phase5-mileage-authz.test.ts`；`phase5-mileage-endpoint.test.ts` | `矩陣列 4／未登入（AC-21） > [4×未帶 ownerId] 401 UNAUTHORIZED with no numeric fields`；`… > [4×帶自己 ownerId] 401 — 帶 id 不構成身分`；`… > [4×帶他人 ownerId] 401 — 認證先於授權，非 403`；`requireAuth + requirePasswordChanged 自始掛載 > unauthenticated request returns 401 with no numeric fields (never 404, never 200)`；`… > unauthenticated request with another ownerId also returns 401 (auth before authz)` | T4, T5 | GREEN |
| AC-22 | integration | `phase5-mileage-authz.test.ts` | `矩陣列 5／強制改密 mustChangePassword=true（AC-22） > [5×未帶 ownerId] 403 PASSWORD_CHANGE_REQUIRED with no numeric fields`；`… > [5×帶自己 ownerId] 403 PASSWORD_CHANGE_REQUIRED`；`… > [5×帶他人 ownerId] 403 PASSWORD_CHANGE_REQUIRED — 中介層先於 resolveOwnerId` | T5 | GREEN |
| AC-23 | integration | `phase5-mileage-endpoint.test.ts`；`phase5-mileage-authz.test.ts` | `AC-23 一般使用者自帶他人 ownerId → 403，不靜默降級 > normal user passing another ownerId gets 403 and no silent downgrade to own data`；`… > the other user's own request still succeeds — 403 is about the actor, not the data`；`矩陣列 1／擁有者（USER） > [1×帶他人 ownerId] 403 FORBIDDEN, no numeric field, no silent downgrade (AC-23)`；`矩陣列 2／他人一般使用者（USER） > [2×帶他人 ownerId] 403 FORBIDDEN — mirror of row 1, no numeric field`；`… > [2×帶管理員 ownerId] 403 FORBIDDEN — 管理員資料同樣受保護` | T4, T5 | GREEN |
| AC-24 | integration | `phase5-mileage-authz.test.ts` | `矩陣列 3／管理員（ADMIN） > [3×帶他人 ownerId=U] AC-24 returns ONLY U's statistics (two distinct users)`；`AC-18 appliedFilters 回報實際套用值 > admin proxy query reports ownerId === U (AC-24 可由回應自證)` | T5 | GREEN |
| AC-25 | integration | `phase5-mileage-authz.test.ts` | `矩陣列 3／管理員（ADMIN） > [3×未帶 ownerId] AC-25 defaults to self — appliedFilters.ownerId === actor.id`；`… > [3×帶自己 ownerId] AC-25 same as omitting it`；`T6-AR-3／ownerId=（空字串）視同未帶 > ADMIN sends an explicit empty ownerId → 200 defaults to self, same as omitting it (AC-25)`；`AC-18 appliedFilters 回報實際套用值 > admin query without ownerId reports ownerId === actor.id (AC-25 可由回應自證)` | T5, T6 | GREEN |
| AC-26 | integration | `phase5-mileage-contract.test.ts` | `AC-26 回應白名單（Object.keys 全等，200 路徑） > top-level body keys are EXACTLY [totalKm, applicationCount, appliedFilters] — no more, no less`；`… > appliedFilters keys are EXACTLY [dateFrom, dateTo, ownerId]`；`… > no leaked sensitive terms in the raw response body (price/amount/purpose/location/displayName/loginName/path)` | T6 | GREEN |
| AC-27 | frontend | `frontend/test/MileageSummarySection.test.tsx` | `MileageSummarySection > Loading：送出查詢後顯示「計算中…」，查詢鈕停用（防重複提交）`；`… > Success：顯示公務總里程與實際套用區間`；`… > Empty（AC-29）：後端回 0 → 顯示「0.00 公里」＋ 說明，非空白/—/NaN/錯誤樣式`；`… > Error（5xx）：顯示 zh-TW 錯誤訊息 + 重試按鈕；點擊重試重新查詢`；`… > Permission denied（403 FORBIDDEN）：顯示可辨識訊息，不顯示任何數值`；`… > Permission denied（403 PASSWORD_CHANGE_REQUIRED）：顯示與 FORBIDDEN 不同之可辨識訊息`；`… > Permission denied（401 UNAUTHORIZED）：顯示與其餘 permission-denied 訊息不同之可辨識訊息` | T7 | GREEN |
| AC-28 | frontend | `MileageSummarySection.test.tsx` | `MileageSummarySection > AC-28（前端攔截路）：起>迄 → 就地顯示區間錯誤，不呼叫 fetch`；`… > AC-28（後端 400 路）：後端回 fields.dateRange → 就地呈現於日期欄位`；`… > 後端 400 fields.dateFrom/dateTo（格式錯誤）→ 就地標示對應欄位`（同 describe 之欄位定位附加鑑別） | T7 | GREEN |
| AC-29 | frontend | `MileageSummarySection.test.tsx` | `MileageSummarySection > Empty（AC-29）：後端回 0 → 顯示「0.00 公里」＋ 說明，非空白/—/NaN/錯誤樣式`（同一測試同時涵蓋 AC-27 之 Empty 態） | T7 | GREEN |
| AC-30 | frontend（元件層 + 頁面層） | `MileageSummarySection.test.tsx`；`frontend/test/HomePage.test.tsx` | `MileageSummarySection > AC-30：顯示值來自統計端點（999.99），即使假設列表加總為 30.00，也不得顯示 30.00`；`HomePage — MileageSummarySection 嵌入（D6(a) 共用元件） > AC-30 鑑別力：統計端點回 999.99、申請列表 3 筆合計 30.00 → 畫面顯示 999.99（前端不自算）` | T7 | GREEN |
| AC-31 | frontend | `frontend/test/AdminUserApplicationsPage.test.tsx` | `AdminUserApplicationsPage > admin statistics request carries ownerId equal to route :userId` | T8 | GREEN |
| AC-32 | E2E | `e2e/mileage-statistics.spec.ts` | `區間公務里程統計 — PHASE-005 Gate E2E（Spec §11.4） > 情境6（AC-32）：響應式375px——HomePage與管理員頁body皆無水平溢位` | T8 | GREEN |
| AC-33 | integration | `phase5-mileage-engine.test.ts` | `AC-33: aggregation runs in a constant number of SQL queries, independent of row count (3 vs 101), and is a real SQL SUM/COUNT — not findMany()+reduce (PHASE-005-R1 S-1)` | T3, R1 | GREEN |
| AC-34 | integration | `phase5-mileage-contract.test.ts` | `AC-34 錯誤格式統一且不外洩（逐鍵） > VALIDATION_ERROR (duplicate key) has the unified shape with fields`；`… > FORBIDDEN (another owner) has the unified shape without fields`；`… > UNAUTHORIZED (no session) has the unified shape without fields`；`AC-34 日誌安全：錯誤路徑 log 不含密碼/token/cookie/SQL/絕對路徑 > no log line contains the session cookie value`；`… > no log line contains 'password=' or a bearer token pattern`；`… > no log line contains SQL keywords or Prisma query structure`；`… > no log line contains a Windows or POSIX absolute source path`；`… > the 400/403/401 responses are still logged (not silently swallowed)` | T6 | GREEN |

**覆蓋核對**：AC-01~AC-34 全數有映射（本表共 **35 列** = 34 AC + AC-09 拆列）；**`GREEN` 35 列、`PENDING` 0 列、`RED` 0 列**；無 AC 僅由 E2E 覆蓋（E2E 為附加證據，AC-32 除外——響應式本質為瀏覽器行為，沿用 PHASE-004 AC-89 慣例）。

**表註（2026-08-03 同步，依期中 Review S-2）**

1. **AC-09 拆為兩列**：原單列同時宣稱引擎層與 HTTP 層證據，但實際僅有引擎層測試（`Decimal 0` / `count 0`）；`HTTP 200`、`"0.00"` 字串表示、非 `null`／非 404 屬 DTO／route 行為，落點為 T4。拆列後兩層各自可機械核對。
2. **AC-07／AC-11 移除 `backend/test/unit/mileage-engine.test.ts` 映射**：§16 **D2(a)**（Spec Gate 2026-08-03 人類批准，見 §18）裁定引擎直接 `SUM(TravelApplication.snapshotTotalKm)`，**不存在里程加總純函式**，該單元測試檔在 D2(a) 下本就不應存在。兩條 AC 之數值鑑別力由整合層精確等值斷言承擔（`35.75` 與 `30.03`），覆蓋不減。此列屬 Gate 後應連動修訂而未修訂之遺留。
3. **未列 `RED` 狀態**：T1~T3 均依 TDD 先紅後綠，紅燈為過程狀態，結案時一律落在 `GREEN`；R1（commit `7bbdc00`）為零 `src` 變更之測試層鑑別力補強，故僅擴充測試名與 Task 欄，不改變 AC 條文與狀態語意。

**表註（2026-08-03 第二次同步，PHASE-005-SPEC-SYNC-2，依 T5 複審 AR-1）**

4. **8 條預定名與實作實名不符，已逐字改為實名**：AC-19／AC-20／AC-21／AC-22／AC-24／AC-25／AC-26／AC-34 之原「預定名稱」在三個測試檔中**不存在逐字對應**（例：AC-25 預定 `admin without ownerId defaults to self`，實名為 `矩陣列 3／管理員（ADMIN） > [3×未帶 ownerId] AC-25 defaults to self — appliedFilters.ownerId === actor.id`）。T5 複審 AR-1 指出「`GREEN` 列若不換實名，本表即為可機械證偽之假陳述」，故本次同步以三檔實際 `describe`／`it` 逐字回填。AC-09(HTTP)／AC-14/15/16/17/18/23 之預定名則與實名一致或為其前綴，一併補齊巢狀 `describe > it` 與同 `describe` 下之其餘測試。
5. **Task 欄擴充（跨 Task 覆蓋）**：AC-21 與 AC-23 之證據同時落在 T4（`phase5-mileage-endpoint.test.ts`）與 T5（`phase5-mileage-authz.test.ts`），Task 欄改為 `T4, T5`；AC-25 之空字串 `ownerId` 案例由 T6-AR-3 於 authz 檔補入，Task 欄改為 `T5, T6`。**無 AC 條文變更、無新增／刪減 AC。**
6. **反向核對（測試 → AC）**：三檔共 68 條測試（endpoint 21／authz 26／contract 21——R5-BATCH `fb182c5` 於 contract 檔新增 1 條後之現值；終審 S-1 校正，2026-08-03），其中 **52 條列入本表**，**16 條為未對應單一 AC 之附加鑑別**（刻意保留，非覆蓋缺口，皆屬 §5 邊界條件或 §16 決策之補強）：endpoint 檔 6 條 —— `PHASE-005-T4 — formatMileageKm（DTO 層里程格式化，D3(a)）` 3 條（D3(a) 字串表示法純函式）與 `B-26 判定順序：授權（403）優先於格式（400）` 3 條；authz 檔 9 條 —— 矩陣列 1／2 之 `[n×未帶 ownerId]`／`[n×帶自己 ownerId]` 共 4 條（B-23 自帶己方識別值等同未帶）、`[3×帶不存在的 ownerId] B-22 → 200 + 0，不洩漏帳號是否存在` 1 條、`T6-AR-3／ownerId=（空字串）視同未帶` 之 USER 列 1 條、`矩陣列 6／停用帳號 isActive=false` 3 條（`isActive` 即時值權威，屬 PHASE-002 迴歸守門）；contract 檔 1 條 —— R5-B3 之「重複帶自己 id 亦 400」（§5 B-26 側信道無關性之正面樁，其餘 20 條全數列表）。

**表註（2026-08-03 第三次同步，PHASE-005-SPEC-SYNC-3；T7／T8／R5 後之終審前最終同步）**

7. **AC-27~AC-32 六列預定名全數改為實名**：原預定名為英文預定名稱，T7／T8 實作採 zh-TW 測試名（沿用 PHASE-004 前端測試命名慣例），本次以 `frontend/test/MileageSummarySection.test.tsx`（13 條）、`frontend/test/HomePage.test.tsx`、`frontend/test/AdminUserApplicationsPage.test.tsx`、`e2e/mileage-statistics.spec.ts` 之實際 `describe > it`／`test` 名稱逐字回填。**無 AC 條文變更、無新增／刪減 AC。**
8. **AC-30 測試檔欄擴為兩檔（元件層 + 頁面層）**：元件層鑑別力於 `MileageSummarySection.test.tsx`，頁面層（統計端點回 `999.99` 對比申請列表 3 筆合計 `30.00`）於 `HomePage.test.tsx`；層級欄同步註記。**AC-28 第三條**（`後端 400 fields.dateFrom/dateTo（格式錯誤）→ 就地標示對應欄位`）為同 `describe` 下之欄位定位附加鑑別，屬 §5 邊界條件補強，非新增 AC。
9. **§11.4 六情境全數落地並全綠**（`e2e/mileage-statistics.spec.ts`，E2E 17 條由大總管親跑全綠，2026-08-03）：情境1『使用者登入→建2筆差旅並完成（不同出差日期）→統計區塊選擇涵蓋兩筆之區間→顯示正確總里程』、情境2『邊界——把起日設為兩筆之間的日期→只剩一筆之里程』、情境3『起>迄→顯示區間錯誤提示，不顯示數值』、情境4『空區間→顯示0.00公里與說明文案』、情境5『（AC-31）管理員進入/admin/users/:userId/applications→選區間→顯示該使用者統計（非管理員自己）』、情境6『（AC-32）響應式375px——HomePage與管理員頁body皆無水平溢位』。**情境1~5 為 §11.4 整合 Gate 之附加佐證**（對應 AC 之權威證據仍在單元／整合／元件層），故不另占表列；**僅情境6 為 AC-32 之唯一證據列**（響應式本質為瀏覽器行為，沿用 PHASE-004 AC-89 慣例）。
10. **反向核對（前端／E2E 測試 → AC）**：`MileageSummarySection.test.tsx` 13 條中 **11 條列入本表**，2 條為未對應單一 AC 之附加鑑別（刻意保留，非覆蓋缺口）——`初始態：掛載後不呼叫 fetch，顯示「請選擇日期區間後查詢」`（§16 **D5(a)** 掛載不自動查詢）與 `防重複提交：查詢中重複點擊查詢鈕不得觸發第二次 fetch`（§4 Loading 態行為）。`HomePage.test.tsx` 屬本 Phase 之 2 條中 1 條列表（另 1 條為 D6(a) 嵌入與 D5(a) 之守門），其餘 5 條為 PHASE-003b 導覽連結迴歸；`AdminUserApplicationsPage.test.tsx` 屬本 Phase 之 1 條全數列表，其餘 9 條為 PHASE-004 迴歸。`e2e/mileage-statistics.spec.ts` 6 條中 1 條列表（見表註 9）。

---

## 13. Architecture / Data Flow 影響（本 Phase 不修改該兩份文件）

> Packet「Architecture Change Permission：無」。以下僅為**建議更新點**，由大總管於 Gate 後決定是否另行派工。

1. **ARCHITECTURE §3**：`mileage`（統計）模組列補註「本 Phase 落地，落點 `backend/src/mileage/`；對外僅一個唯讀端點；對內提供 `sumOfficialMileage(db, params)` 供 `maintenance`／`depreciation` 於交易內複用」。
2. **ARCHITECTURE §4.6**：補註「統計查詢**不分頁**，與綜合查詢分屬不同端點；`resolveOwnerId` 為兩者共用之授權判定」。
3. **ARCHITECTURE 新增 §4.10（或併入 §4.1）**：補註「里程統計精度定案：全程 `Decimal`、不取整、字串傳輸」（D3 定案後）。
4. **DATA_FLOW §2.8**：以本 Spec §9 之流程圖具體化（含授權檢查點順序 B-26）。
5. **PROJECT_STATE 跨 Phase 追蹤**：新增「PHASE-009 作廢語意須以 `status=VOIDED` 取代 `COMPLETED`（不得改為正交旗標），否則 PHASE-005 引擎過濾條件失效——009 開工須回歸 AC-04」（D8 定案後）。

---

## 14. Rollback

- 本 Phase 新增：1 個後端唯讀模組（`backend/src/mileage/`）+ 1 個 `GET` 端點 + 1 個前端統計元件（嵌入 2 個既有頁）+ 測試。
- **無破壞性資料變更**：無 migration（除非 D9 裁定新增索引——索引之 down migration 為 `DROP INDEX`，非破壞性、可逆）。
- **開發階段回滾**：branch `phase-005` 還原至 main @ `310bc39`；無資料補償步驟。
- **公開 contract 影響**：新增端點屬**新增**而非變更，回滾即移除該 route；`GET /applications` 完全未動，PHASE-004 之前端行為不受影響。
- **前端**：HomePage／AdminUserApplicationsPage 為**新增區塊**，回滾即還原該兩檔。
- **不可逆資產**：**無**。本 Phase 不寫入任何資料、不產生快照。

---

## 15. Task Graph

> 每 Task 一律 TDD、一個 atomic commit（含 Task ID）。**規模上限（Packet）：單 Task ≤ 5 AC、≤ 6 檔、不得同時橫跨 FE+BE+DB 三層。**

| Task | 內容 | 層 | AC（≤5） | 檔案（≤6） | Risk | 依賴 | Done When |
|---|---|---|---|---|---|---|---|
| **T1** | 區間驗證與過濾條件純函式：`parseMileageRange`、`buildOfficialMileageWhere` | BE（純函式，不碰 DB） | AC-01, 02, 08, 11 | `backend/src/mileage/mileage-range.ts`、`backend/test/unit/mileage-range.test.ts` | Medium | PHASE-004 | 單元測試 ≥ 22 例全綠；`status` 字面值、`gte`/`lte` 鍵名、`dateFrom==dateTo` 通過三項鑑別力斷言在場 |
| **T2** | 引擎 DB 聚合：`sumOfficialMileage`（狀態／類型／擁有人過濾 + 里程加總，來源依 **D2**） | BE + DB（唯讀） | AC-03, 04, 05, 06, 07 | `backend/src/mileage/mileage-engine.ts`、`backend/test/integration/phase5-mileage-engine.test.ts` | Medium | T1 | 反向斷言組（DRAFT `999.00` + VOIDED `888.00` 併存下結果恰 `10.00`）全綠；`35.75` 數值鑑別全綠；**同 DB 連跑兩輪全綠** |
| **T3** | 引擎完整性與複用介面：0 值、跨 101 筆完整區間、交易內唯讀、快照一致性、DB 層聚合 | BE + DB（唯讀） | AC-09, 10, 12, 13, 33 | `backend/src/mileage/mileage-engine.ts`、`backend/test/integration/phase5-mileage-engine.test.ts`、`backend/test/integration/phase5-mileage-endpoint.test.ts` | Medium | T2 | 101 筆完整性測試全綠；查詢數常數斷言全綠；兩輪全綠 |
| **T4** | 統計端點：route 掛載（`requireAuth` + `requirePasswordChanged` **自始掛載**）+ query 驗證 + `resolveOwnerId` 授權 | BE | AC-14, 15, 16, 17, 23 | `backend/src/mileage/routes.ts`、`backend/src/server.ts`（註冊）、`backend/test/integration/phase5-mileage-endpoint.test.ts` | **High**（**待 D10 裁定**；本 Task 是 BE-US-02 資料隔離在統計資料上的首次落地） | T3, PHASE-002 | AC-23 之「不靜默降級」測試全綠；400 之 `fields` 定位精確；兩輪全綠 |
| **T5** | 權限矩陣完整覆蓋 + `appliedFilters` | BE | AC-18, 21, 22, 24, 25 | `backend/src/mileage/routes.ts`、`backend/test/integration/phase5-mileage-authz.test.ts` | **High**（同上） | T4 | 5×3 權限矩陣全綠；403 body 逐鍵無數值；判定順序（B-26）固定 |
| **T6** | 回應白名單、後端權威、錯誤合約與日誌安全 | BE | AC-19, 20, 26, 34 | `backend/src/mileage/routes.ts`、`backend/test/integration/phase5-mileage-contract.test.ts` | Medium | T5 | `Object.keys` 全等白名單斷言全綠；無新 `ErrorCode`（結構性斷言）；logStream 斷言全綠 |
| **T7** | 前端個人統計區塊（含 API client） | FE | AC-27, 28, 29, 30 | `frontend/src/api/statistics.ts`、`frontend/src/components/MileageSummarySection.tsx`、`frontend/src/pages/HomePage.tsx`、`frontend/test/MileageSummarySection.test.tsx`、`frontend/test/HomePage.test.tsx`、`frontend/src/index.css` | Medium | T6 | 五態測試全綠；`999.99` vs `30.00` 不自算鑑別力全綠 |
| **T8** | 前端管理員統計嵌入 + 響應式 + E2E | FE + E2E | AC-31, 32 | `frontend/src/pages/AdminUserApplicationsPage.tsx`、`frontend/test/AdminUserApplicationsPage.test.tsx`、`e2e/mileage-statistics.spec.ts` | Medium | T7 | `ownerId === :userId` 斷言全綠；375px 無溢位；E2E 六情境全綠 |

### 依賴圖

```
T1 ──▶ T2 ──▶ T3 ──▶ T4* ──▶ T5* ──▶ T6 ──▶ T7 ──▶ T8
                       (*High，待 D10)
```

### 規模上限自查

| Task | AC 數 | 檔數 | 跨層 | 合規 |
|---|---|---|---|---|
| T1 | 4 | 2 | BE only | ✅ |
| T2 | 5 | 2 | BE + DB（唯讀，無 migration） | ✅ |
| T3 | 5 | 3 | BE + DB（唯讀） | ✅ |
| T4 | 5 | 3 | BE only | ✅ |
| T5 | 5 | 2 | BE only | ✅ |
| T6 | 4 | 2 | BE only | ✅ |
| T7 | 4 | 6 | FE only | ✅ |
| T8 | 2 | 3 | FE + E2E | ✅ |

> **無任何 Task 同時橫跨 FE+BE+DB 三層**；T2/T3 之「DB」為唯讀查詢，無 schema/migration 變更。
> **相對 PRD 初始 Task Graph 之調整**：PRD 列 T1~T4（引擎／個人端點／管理員端點／前端頁）。本 Spec 將 PRD-T2 與 PRD-T3 **合併為單一端點 + `ownerId` 參數**（見 **D4**），再依「≤5 AC」上限拆為 T1~T8。合併之理由與風險見 D4；若 D4 裁定採雙端點，Task Graph 須連動修訂為 T4a/T4b。

---

## 16. 需人類批准之決策點（D1~D10）

> 每條格式：**為什麼要決定** ｜ **選項** ｜ **各選項影響** ｜ **推薦**。
> **凡未裁定者，相關 AC 與實作一律不得開工。**

---

### D1 — 參數欄位容量溢位回 500 之處置（**跨 Phase 追蹤事項強制納入；錯誤合約變更，必人類批准**）

**為什麼要決定**
PROJECT_STATE「跨 Phase 追蹤事項」2026-08-03 條目原文載明本項「**spec-writer 產 PHASE-005 Spec 時必須列為決策點供人類裁定（納入 005 或獨立回合）**」。事實摘要（CHORE-002 reviewer 查出）：

- `unitPrice` 落於 `[1e6, Decimal(10,4) 上限外)`、`vehiclePrice` 落於 `[1e10, Decimal(12,2) 上限外)` 時，DB 層拋錯 → **500**（string／number 皆然），違反 PHASE-003a Spec 錯誤合約（該端點僅列 400/409/401/403）。
- 另 `unitPrice:"0.0000001"` **靜默存為 `0.0000`**（精度截斷無提示）。
- 正解：比照 `backend/src/applications/trip-validation.ts` 之綁欄位容量範圍驗證（十進位字面 pattern + 量級上限，見該檔 `parseKmField` 之 `DECIMAL_LITERAL_PATTERN` 與 `KM_MAGNITUDE_LIMIT` 兩道守門）。
- **關聯項 AR-5（CHORE-002 R2 資訊性 Accepted Risk，PROJECT_STATE 原文）**：`fuel`/`ETC` 字串輸入仍經一次 `Number()` double 中介（對 `Decimal(10,4)` 不可觀測，但文件不得宣稱「字串路徑完全不經浮點」）；「字串全保真」需連同「**不可解析 → 400**」之合約變更走 Spec 批准，**宜與本項同案處理**。

**選項**

| 選項 | 內容 |
|---|---|
| **(a) 納入 PHASE-005** | 於本 Phase 新增 T0（或 T9）處理 `parameters` 模組之範圍驗證與 AR-5 |
| **(b) 獨立回合（CHORE-003）** | 另開 chore 回合：先修訂 **PHASE-003a Spec** 錯誤合約（新增 400 情境＋精度截斷拒絕＋「不可解析→400」），再 implementer TDD → reviewer 複審 |
| **(c) 延後至 PHASE-011（加固期）** | 併入非功能加固批次 |

**各選項影響**

- **(a)**：優點是快。缺點嚴重：① 本項的規範本體在 **PHASE-003a Spec**（錯誤合約表），而 spec-writer 於本 Task 被明令 `Files/Components Forbidden: 既有 Spec`——採 (a) 須先另派工修訂 003a Spec，並非「納入 005 就免掉」；② `phase-005` branch 會混入 `parameters` 模組變更，破壞「一 Phase 一 branch、變更主題內聚」的回滾單元；③ 本項是**使用者可見錯誤合約變更**（500→400、原本會成功的 `"0.0000001"` 變 400），其 Gate 性質與 005 的統計 Gate 不同，混在同一 PR 會讓人類難以分辨批准範圍。
- **(b)**：正確歸屬（003a Spec 修訂 → 003a 程式修復），回滾單元乾淨，可與 PHASE-005 **並行**（兩者零檔案重疊：`parameters/` vs `mileage/`）。缺點是多一個回合的流程成本。
- **(c)**：風險最久暴露。目前是 500 而非資料損毀，但 `"0.0000001"` 靜默存 0 屬**金額參數精度靜默失真**，若管理員誤輸入將直接產生錯誤金額，延後到 011 前的每一筆參數建立都暴露此風險。**不建議。**

**推薦：(b) 獨立回合 CHORE-003，與 PHASE-005 並行，並將 AR-5「字串全保真 + 不可解析→400」併入同一回合。**
理由：歸屬正確（規範本體在 003a Spec）、零檔案重疊可並行、回滾單元乾淨、Gate 語意清晰。本 Phase 不因此被 blocked（PHASE-005 完全不觸及 `parameters` 模組）。
> 若人類裁定 (a)，本 Spec 須增列 AC-35~AC-38（範圍驗證、精度截斷拒絕、不可解析→400、字串全保真）與 T9，且**須另行派工修訂 PHASE-003a Spec**——請於裁定時一併指示。

---

### D2 — 里程來源：完成快照 `snapshotTotalKm` vs 逐段加總 `TripSegment.totalKm`（**金額語意上游，視同金額類**）

**為什麼要決定**
兩者在資料正確時**數值完全相同**（PHASE-004 AC-50 定義 `snapshotTotalKm` = Σ 各段 `totalKm`），但在**權威來源、效能、故障模式**上不同，且此選擇會被 PHASE-006/007 的金額直接繼承。

**選項**

| 選項 | 內容 |
|---|---|
| **(a) 讀快照** | `SUM(TravelApplication.snapshotTotalKm)`，單表聚合 |
| **(b) 逐段加總** | `SUM(TripSegment.totalKm)`，需 join 至 `TripSegment` |
| **(c) 讀快照 + 快照為 null 時回退逐段加總** | 雙路徑 |

**各選項影響**

- **(a)**：與 CLAUDE.md「計算完成時保存快照」及 PHASE-004 AC-48「讀快照，不重算」的既有紀律一致；聚合僅掃 `TravelApplication` 一表，成本最低（AC-33）；對「已完成資料不可變」提供最強保證。**故障模式**：若某 COMPLETED 列之 `snapshotTotalKm` 為 `null`（PHASE-004 AC-50 之原子完成保證其不發生，但資料修補或未來 migration 可能造成），`SUM` 會**忽略**該列而**不報錯**——統計靜默偏低。緩解：AC-13 不變式測試 + 建議加一條「COMPLETED ⇒ snapshotTotalKm 非 null」之整合斷言。
- **(b)**：與 US 原文措辭「加總各差旅**行程段**的總里程」字面最貼近；`null` 快照不影響結果。**故障模式**：需 join 兩層（`Application`→`TravelApplication`→`TripSegment`），聚合成本較高；且若未來出現「快照與段落不一致」（理論上不可能，AC-59 凍結），統計會與已完成申請上顯示的金額基礎不一致——**下游 006/007 的比例分母與 004 的申請詳情會對不上**，這是比 (a) 更難察覺的錯誤。
- **(c)**：兩條路徑 = 兩套語意 = TDD 難以完整覆蓋且易腐化；且「回退」會**掩蓋**應該被發現的資料異常。不建議。

**推薦：(a) 讀快照 `snapshotTotalKm`。**
理由：與「完成即凍結、讀快照不重算」的全案紀律一致；聚合最省；且 AC-13 已把「快照 == 段加總」提升為**顯式不變式測試**，把 (b) 的正確性保證以測試方式保留下來，同時取得 (a) 的效能與一致性。另建議加入斷言：不存在 `status=COMPLETED AND snapshotTotalKm IS NULL` 之列。

---

### D3 — 里程回傳型別、精度與 0 值表示（**精度＝金額語意上游，必人類批准**）

**為什麼要決定**
本值是 PHASE-006 公務比例的分子、PHASE-007 補貼金額的乘數。型別（字串 vs number）、小數位、是否取整，直接決定下游金額能否正確。

**選項**

| 選項 | `totalKm` 傳輸型別 | 精度 | 0 值 |
|---|---|---|---|
| **(a)** | 字串 | 固定 2 位小數，未取整 | `"0.00"` |
| **(b)** | JSON number | 2 位小數 | `0` |
| **(c)** | 字串 | 整數（四捨五入） | `"0"` |

**各選項影響**

- **(a)**：沿用 PHASE-003a/PHASE-004「金額與里程一律以字串表示 `Decimal`」之既有 DTO 慣例（PHASE-004 §8 原文）；無浮點失真；前端顯示直接可用；下游 Phase 以 `new Decimal(str)` 還原無損。
- **(b)**：JSON number 為 IEEE754 double。`30.03` 這類值在 double 下不精確，跨語言／跨序列化可能出現 `30.029999999999998`；與既有慣例衝突，且會使 PHASE-006 比例計算引入浮點。**與 CLAUDE.md 精度紀律相悖。**
- **(c)**：里程取整會使 PHASE-006 比例與 PHASE-007 補貼**系統性偏差**（例如年度 12,345.67 km 取整為 12,346，乘以單價後金額偏差可達數十元）。CLAUDE.md 的「最終金額為新臺幣整數」規範對象是**金額**，不是里程。**明確不建議。**

**推薦：(a) 字串、固定 2 位小數、未取整、0 值為 `"0.00"`。**

---

### D4 — 端點形狀：單一端點 + `ownerId` 參數 vs 個人／管理員雙端點（**公開 API contract，必人類批准**）

**為什麼要決定**
PRD 初始 Task Graph 列「T2 個人區間統計查詢端點」與「T3 管理員指定使用者區間統計」兩項，字面可讀為兩個端點。API 形狀屬公開 contract，且一旦前端接上就有遷移成本。

**選項**

| 選項 | 形狀 |
|---|---|
| **(a) 單一端點** | `GET /statistics/mileage?dateFrom&dateTo&ownerId?`；授權以既有 `resolveOwnerId` 判定 |
| **(b) 雙端點** | `GET /statistics/mileage`（恆為自己）＋ `GET /admin/users/:userId/statistics/mileage`（`requireAdmin`） |
| **(c) 掛在既有列表端點下** | `GET /applications/statistics/mileage?...` |

**各選項影響**

- **(a)**：與 PHASE-004 `GET /applications?ownerId=` 之既有形狀**完全一致**（同一組授權語意、同一個 `resolveOwnerId` 函式、同一組 403 行為），前端兩處可共用同一 API client；授權判定只有一份，減少「兩條路徑語意漂移」的風險。缺點：管理員能力隱含在參數中，端點清單上看不出「誰能查誰」（以授權矩陣文件補足）。
- **(b)**：路徑即權限，可讀性佳，並多一道 `requireAdmin` 縱深。缺點：兩套 route、兩套測試、兩份授權判定（**授權邏輯重複是資料隔離缺陷的常見來源**）；且與 PHASE-004 既有慣例不一致（PHASE-004 的管理員檢視走 `GET /applications?ownerId=`，並非 admin 路徑）。
- **(c)**：語意上統計不屬於「applications 集合的子資源」，且與 ARCHITECTURE §3 的 `mileage` 獨立模組劃分不符。

**推薦：(a) 單一端點 `GET /statistics/mileage`。**
理由：授權判定唯一化（安全上最重要）、與 PHASE-004 慣例一致、前端可共用 client。
> 裁定為 (b) 時，§15 Task Graph 須把 T4 拆為 T4a（個人）／T4b（管理員），AC-24/25 改掛 T4b，並新增「兩端點授權語意一致性」之交叉測試。

---

### D5 — `dateFrom`／`dateTo` 是否必填（**使用者可見行為，必人類批准**）

**為什麼要決定**
`GET /applications`（PHASE-004 AC-60）在未指定日期時**預設近一年**。統計端點若沿用該預設，使用者可能把「近一年的數字」誤讀為「全部期間」；若不沿用，兩個端點的預設行為不一致。FE-US-06 原文為「使用者**選擇**有效起訖日期」，AD-US-06 為「**選擇**日期區間」。

**選項**

| 選項 | 行為 |
|---|---|
| **(a) 兩者皆必填** | 缺任一 → 400；前端初始態不顯示數值 |
| **(b) 沿用近一年預設** | 未提供 → `dateFrom = 今日−1年`、`dateTo` 不設上界；`appliedFilters` 明示 |
| **(c) `dateFrom` 必填、`dateTo` 可省（預設今日）** | 折衷 |

**各選項影響**

- **(a)**：統計數值恆對應使用者明示選擇的區間，**無誤讀空間**；與兩條 US 原文「選擇」措辭一致；缺點是與 `GET /applications` 的預設行為不一致（但兩者用途不同：列表是瀏覽，統計是取數）。
- **(b)**：一致性佳、上手快；但「沒選區間也給一個數字」對**會被拿去報帳／作為保養折舊基礎**的數值而言是誤讀風險，且 `dateTo` 不設上界會把未來日期的差旅也算進去（PHASE-004 B-27 允許未來出差日），使「近一年」名不副實。
- **(c)**：仍有半個預設，誤讀風險減半但未消除；且「今日」作為上界會使同一查詢在不同日回不同值（無法重現）。

**推薦：(a) 兩者皆必填。**
理由：本數值是下游金額的基礎，**可重現性與無誤讀**優先於與列表端點的表面一致性；§4 之初始態「請選擇日期區間後查詢」與之配套。

---

### D6 — 統計 UI 落點：既有頁面內區塊 vs 新增獨立路由（**使用者可見行為，必人類批准**）

**為什麼要決定**
PRD 目標句寫「提供個人與管理員的區間統計查詢**頁**」，但 FE-US-06／AD-US-06 的 AC 只要求「選擇日期區間 → 顯示總里程」。是否新增路由屬使用者可見的資訊架構決策。

**選項**

| 選項 | 落點 |
|---|---|
| **(a) 既有頁內區塊** | 共用元件 `MileageSummarySection` 嵌入 `HomePage`（個人）與 `/admin/users/:userId/applications`（管理員）；**不新增路由** |
| **(b) 新增獨立路由** | `/statistics`（個人）＋ `/admin/users/:userId/statistics`（管理員） |
| **(c) 兩者皆有** | 區塊 + 獨立頁 |

**各選項影響**

- **(a)**：使用者在看紀錄列表的同一頁即可取數，情境連貫；管理員頁面亦然（AD-US-06 原文的三條 AC——紀錄、篩選、統計——本就描述同一個「該使用者頁面」）；diff 最小（T7/T8 各改一個既有頁）；無新路由 = 無新 `RouteGuard` 設定風險。
- **(b)**：符合 PRD「頁」字面；統計可獨立分享 URL。缺點：新增兩條路由與導覽入口、兩份 `RouteGuard` 配置，且與列表脫節（使用者需在兩頁間切換核對）。
- **(c)**：重複維護兩處相同功能。

**推薦：(a) 既有頁內區塊（共用元件）。**
理由：US 原文的 AC 已被完整滿足，資訊架構更連貫，diff 與授權設定風險最小。
> 這是**對 PRD 措辭「查詢頁」的收斂解讀**，故列為決策點而非自主決定。若人類要求嚴格照「頁」實作，裁定 (b) 即可，T7/T8 檔案清單須加入路由與導覽入口。

---

### D7 — 回應是否包含 `applicationCount`／逐筆明細（**資訊揭露範圍**）

**為什麼要決定**
「總里程 = X」缺乏可核對性；使用者無從判斷是否漏算。但揭露越多，跨使用者情境下的資訊面越大（管理員查他人時尤然）。

**選項**

| 選項 | 回應內容 |
|---|---|
| **(a) 里程 + 筆數** | `totalKm` + `applicationCount` + `appliedFilters` |
| **(b) 僅里程** | `totalKm` + `appliedFilters` |
| **(c) 里程 + 筆數 + 逐筆明細** | 另含 `items[]`（每筆 id／tripDate／totalKm） |

**各選項影響**

- **(a)**：使用者可自行核對「這個數字來自 N 筆差旅」，是低成本的可信度提升；`applicationCount` 對呼叫者而言不是新資訊（他本就能從列表查到自己的筆數），管理員亦已可經 `GET /applications` 取得。
- **(b)**：資訊面最小，但可核對性最差；使用者發現數字不對時無從自診。
- **(c)**：與 `GET /applications` 功能重疊、回應可能很大（B-16 之 101 筆）、且需分頁——與「統計不分頁」的 AC-10 設計衝突。**不建議。**

**推薦：(a) 里程 + 筆數。** 並維持 AC-26 的封閉白名單（新增任何欄位須改 Spec）。

---

### D8 — 「未作廢」之表達方式與對 PHASE-009 的約束（**跨 Phase 設計約束**）

**為什麼要決定**
本 Phase 的過濾寫成 `status = 'COMPLETED'`，隱含假設「作廢是**取代** `COMPLETED` 的終態」。若 PHASE-009 改以正交旗標（例如保留 `status=COMPLETED` 另加 `voidedAt`）實作，本引擎的過濾將**靜默失效**——已作廢的差旅仍被計入統計與下游金額，且沒有任何測試會變紅（因為 005 的測試是以 `status=VOIDED` 種子建立的）。這是本 Phase 最危險的隱性風險。

**選項**

| 選項 | 內容 |
|---|---|
| **(a) 固化「VOIDED 取代 COMPLETED」** | 以 `status = 'COMPLETED'` 單一條件表達；**寫入跨 Phase 追蹤，約束 PHASE-009 不得改用正交旗標**；009 開工須回歸 AC-04 |
| **(b) 防禦性雙條件** | `status = 'COMPLETED' AND voidedAt IS NULL`——但 `voidedAt` 欄位**現在不存在**，需先加欄位（migration） |
| **(c) 不約束，留給 009 決定** | 005 只寫 `status='COMPLETED'`，不記錄任何跨 Phase 約束 |

**各選項影響**

- **(a)**：零成本（`ApplicationStatus.VOIDED` 已於 PHASE-004 schema 宣告為 `status` 的一個值，這本就是既有設計）；把風險轉為**明文的跨 Phase 約束 + 009 的回歸清單項**。
- **(b)**：為尚不存在的功能提前加欄位與 migration，違反本 Phase「無 schema 變更」的定位，且 `voidedAt` 的語意應由 009 的 Spec 定義，提前定義易錯。
- **(c)**：**風險最高**——正是上述「靜默失效」情境，且無任何守門。

**推薦：(a)**，並要求大總管於 Gate 後把下列條目寫入 PROJECT_STATE 跨 Phase 追蹤：
> 「PHASE-009 作廢須以 `Application.status = VOIDED` **取代** `COMPLETED`（不得改採正交旗標）；若改採正交旗標，PHASE-005 `mileage-engine` 之過濾條件必須同案修改，並以真實作廢流程回歸 PHASE-005 AC-04。」

---

### D9 — 是否為 `tripDate` 區間統計新增索引（**migration，雖非破壞性仍屬 DB 變更**）

**為什麼要決定**
統計 where 為 `Application.(ownerId, type, status)` 等值 + `TravelApplication.tripDate` 範圍。既有索引 `@@index([ownerId, status, primaryDate])` 的前綴可涵蓋兩個等值條件，但 `tripDate` 的範圍條件落在**另一張表**，索引前綴無法一路涵蓋。

**選項**

| 選項 | 內容 |
|---|---|
| **(a) 不新增索引** | 依賴既有 `Application @@index([ownerId, status, primaryDate])` 與 `TravelApplication @@index([tripDate])`；效能於 PHASE-011 量測 |
| **(b) 新增 `TravelApplication @@index([tripDate, applicationId])`（覆蓋索引方向）** | 需 migration |
| **(c) 以 `primaryDate` 取代 `tripDate` 作為過濾欄位** | 可完整利用既有複合索引 |

**各選項影響**

- **(a)**：零 migration、零回滾成本；本系統為內部系統、資料量級小（PHASE-004 §10.2 已如此評估）；PHASE-011 為集中效能驗證點，屆時有實測依據再決定加索引，比現在猜測更準。
- **(b)**：可能提升，但**在無實測下加索引是猜測**；索引本身有寫入成本，且會使本 Phase 從「無 migration」變成「有 migration」，回滾單元變複雜。
- **(c)**：**明確不可採**——`schema.prisma` 的 `Application.primaryDate` 註解原文即載明「非統計權威——PHASE-005 統計一律讀 `TravelApplication.tripDate`」。雖然對 COMPLETED 差旅兩者相等（PHASE-004 D9），但以 `primaryDate` 過濾等於把一個**巧合的相等**當作**契約**，一旦 D9 語意變動即靜默算錯。列此選項僅為說明其已被既有規範排除。

**推薦：(a) 不新增索引**；並於 §13 建議大總管把「PHASE-005 統計查詢之索引評估」列入 PHASE-011 效能驗證清單。

---

### D10 — T4／T5 之風險分級：PRD「無 High Task」 vs CLAUDE.md「授權相關一律 High」（**流程／Gate 決策**）

**為什麼要決定**
兩份事實來源在本 Phase 出現張力，**必須由人類裁定而非由我挑一邊**：

- **PRD PHASE-005 原文**：「**High 風險 Task：無**（授權沿用既有中介）。」
- **CLAUDE.md 工程規則原文**：「認證、授權、密碼、附件權限相關工作**一律 High 風險，需人類事前批准**。」

我不視此為「文件矛盾須 BLOCKED」——PRD 給了明確且有理由的例外說明（沿用既有中介、不新造機制）。但 T4/T5 確實是 **BE-US-02 資料隔離在統計資料上的首次落地**（新端點 = 新的越權面），且 PHASE-004 有**完全相同的先例**：PRD 原列 T3 為非 High，PHASE-004 Spec §15「調整說明」將其**升為 High**，理由正是「首次在申請資料上落地資料隔離」。

**選項**

| 選項 | 內容 |
|---|---|
| **(a) T4/T5 標記為 High** | 需人類事前批准（可由本 Spec Gate 一併涵蓋，不額外增加 Gate 次數）；reviewer 對授權矩陣做完整審查 |
| **(b) 維持 PRD「無 High Task」** | T4/T5 為 Medium，走一般 review |
| **(c) 僅 T5 為 High** | T4（含 `resolveOwnerId`）為 Medium |

**各選項影響**

- **(a)**：與 CLAUDE.md 字面一致、與 PHASE-004 先例一致；實務成本近乎為零（人類本就要開 Spec Gate，可在同一次裁定中一併事前批准 T4/T5）；換得 reviewer 對 AC-21~25 做完整權限矩陣審查。
- **(b)**：流程最輕。風險：新端點若漏掛 `requirePasswordChanged`、或 `ownerId` 判定順序寫錯（B-26），會造成跨使用者資料外洩且不易被一般 review 抓到。
- **(c)**：切分點不自然——`resolveOwnerId` 的呼叫在 T4，AC-23（不靜默降級）也在 T4，把 T4 排除在 High 之外反而漏掉最關鍵的一條。

**推薦：(a) T4 與 T5 標記為 High，事前批准併入本次 Spec Gate。**
> 若裁定 (a)，PRD PHASE-005 節之「High 風險 Task：無」與實際不符——**建議由大總管另行派工修訂 PRD 該列**（本 Task 之 `Files/Components Forbidden` 含 PRD，我不得修改）。

---

## 17. 已知限制

1. **`VOIDED` 於本 Phase 不可由 API 產生**（PHASE-004 AC-58）：AC-04 之驗證以測試直接寫入 DB 的 `VOIDED` 列完成；**真實作廢流程之回歸驗證屬 PHASE-009**。這是本 Phase 覆蓋度的已知缺口（過濾條件已驗證，觸發路徑未驗證），已於 D8 以跨 Phase 約束緩解。
2. **保養／折舊申請尚不存在**：AC-05 之類型過濾以直接寫入 DB 的 `MAINTENANCE`／`DEPRECIATION` 父列驗證（子表於 006/007 才建立）；完整驗收於 006/007。
3. **引擎複用僅驗介面不驗語意**：AC-12 只證明「可在交易內唯讀呼叫」；PHASE-006 的期間語意（本次－上次保養日）與 PHASE-007 的年度語意（1/1–12/31）由各自 Phase 驗收。
4. **效能未於本 Phase 量測**：AC-33 只保證聚合形狀（DB 層、無 N+1、查詢數常數）；數值目標於 PHASE-011（沿用 PHASE-004 §14-9 之處理方式）。
5. **`applicationCount` 之語意為「納入統計的差旅筆數」**（若 D7 採 (a)），非「區間內全部差旅筆數」——草稿／作廢／他人皆不計。前端文案須明確，避免與列表 `total` 混淆。
6. **統計不提供逐筆明細**（D7 (a)/(b)）：使用者若要核對細項，須自行使用列表頁的日期篩選。兩者的日期語意一致（皆起訖含當日），但**列表以 `primaryDate` 篩選、統計以 `tripDate` 篩選**——對已完成差旅兩者相等，對草稿則不同（PHASE-004 §14-8）。由於統計本就排除草稿，**兩頁對「已完成」的呈現不會不一致**；此點須寫入前端文案或說明，並列入跨 Phase 追蹤以供 PHASE-011 檢視。
7. **無「全部期間」快捷**：D5 推薦必填起訖，故無「全部」選項。若人類日後要求，屬新增使用者可見行為，須另行批准。

---

## 18. Spec 修訂紀錄

| 日期 | 版本／Task | 變更 | 依據 |
|---|---|---|---|
| 2026-08-03 | SPEC-005（初稿） | 建立 PHASE-005 Spec，狀態 `DRAFT`；AC-01~34、Task Graph T1~T8、AC↔測試映射表、決策點 D1~D10 | Task Context Packet SPEC-005；PRD §5 PHASE-005 節；`userstory.md` FE-US-06／AD-US-06／BE-US-30／BE-US-20；PHASE-004 Spec；PROJECT_STATE 跨 Phase 追蹤事項（2026-08-03 條目） |
| 2026-08-03 | S-3 撤回與編碼慣例（大總管固化） | 期中 Review S-3（TimeZone 依賴）經 R2 implementer 實證挑戰與原 reviewer 對抗性重測後**正式撤回**：production 路徑（Prisma 結構化 API 對 `@db.Date` 以 date 型別 OID 綁參）在 UTC±14 全時區逐位元恆定，B-21「UTC 日粒度」語意由 Prisma 綁參行為保證；缺陷僅存在於 raw SQL+JS `Date` 綁參路徑（現況 src 零暴露）。**編碼慣例（新增）：日期區間比較一律走 Prisma 結構化 API，禁止以 raw SQL + JS Date 參數比較 `@db.Date` 欄位**。R1 之 `SHOW TimeZone` 斷言與相關敘述由 R4-LITE 移除，改以 `SET LOCAL TimeZone='Etc/GMT+12'` 交易內重跑四點斷言守護真性質（Prisma 綁參行為，升版敏感）。 | R2 Handoff（BLOCKED 實證）；期中 reviewer 對抗性重測 verdict (a) 撤回（2026-08-03）；大總管裁定 |
| 2026-08-03 | Spec Gate（大總管固化） | **D1~D10 全數照 §16 推薦選項批准**：D1(b) 獨立回合 CHORE-003 與 005 並行（含 AR-5 同案）、D2(a) 讀 `snapshotTotalKm`＋AC-13 不變式＋COMPLETED 快照非 null 斷言、D3(a) 字串／2 位小數／未取整／`"0.00"`、D4(a) 單一端點 `GET /statistics/mileage`、D5(a) `dateFrom`/`dateTo` 皆必填、D6(a) 既有頁內共用區塊不新增路由、D7(a) 里程＋筆數、D8(a) 固化「VOIDED 取代 COMPLETED」並寫入跨 Phase 追蹤、D9(a) 不新增索引（索引評估列 PHASE-011）、D10(a) **T4/T5 升 High 且事前批准已於本 Gate 一併取得**。§7/§12/§15 之「推薦」形狀即定案形狀，無需連動改寫。狀態 `DRAFT`→`ACTIVE`。衍生待辦：PRD PHASE-005 節「High 風險 Task：無」須修正（派工處理）；CHORE-003 回合另開（PHASE-003a Spec 錯誤合約修訂）。 | 人類 leonchih 2026-08-03 Spec Gate 批准（「全部照建議批准」） |
| 2026-08-03 | PHASE-005-SPEC-SYNC-1（T1~T3+R1 後同步） | **僅同步映射表與測試策略至實作現實，未改動任何 AC 條文本體、§16 決策點或其他章節。** §12：T1/T2/T3 + R1 已覆蓋之 AC-01~AC-08、AC-10~AC-13、AC-33 狀態 `PENDING`→`GREEN`，測試名回填為 `phase5-mileage-engine.test.ts`（18 條）與 `mileage-range.test.ts`（31 條）之**實際測試名**；**AC-09 拆為兩列**（引擎層 T3 `GREEN`／HTTP 層 T4 `PENDING`）；**AC-07／AC-11 移除指向不存在檔案 `backend/test/unit/mileage-engine.test.ts` 之映射**（D2(a) 下該純函式不存在，屬 Gate 後未連動之遺留），層級改為 integration；新增表註 1~3 與 `GREEN` 依據說明。§11.1：「里程加總純函式」列標記為 **D2(a) 下不適用**；「里程格式化」列標註**歸屬 T4（DTO 層）**。 | 期中 Review S-2（2026-08-03）；R1 commit `7bbdc00`；§16 D2(a)／Spec Gate 人類批准 leonchih 2026-08-03 |
| 2026-08-03 | PHASE-005-SPEC-SYNC-2（T4~T6 後同步） | **僅同步 §12 映射表至實作現實，未改動任何 AC 條文本體、§16 決策點或其他章節。** T4/T5/T6 對應之 13 列（AC-09 HTTP 層、AC-14~AC-26、AC-34）狀態 `PENDING`→`GREEN`，測試名以 `phase5-mileage-endpoint.test.ts`（21 條）、`phase5-mileage-authz.test.ts`（26 條）、`phase5-mileage-contract.test.ts`（20 條）之**實際 `describe > it` 名稱逐字回填**；其中 8 列原預定名在實作中不存在逐字對應（見表註 4）。AC-21／AC-23 Task 欄擴為 `T4, T5`、AC-25 擴為 `T5, T6`（見表註 5）；新增表註 4~6 並更新 `GREEN` 依據之 commit 清單。**剩餘 `PENDING` 僅 T7／T8 前端與 E2E 之 AC-27~AC-32（6 列）。** | T4 commit `d451125`／T5 commit `d555be3`／T6 commit `9b9b351` 及各自複審 `APPROVE`（2026-08-03）；**T5 複審 AR-1**（`GREEN` 列測試名須逐字可 `grep`，否則為可機械證偽之假陳述） |
| 2026-08-03 | PHASE-005-SPEC-SYNC-3（T7／T8／R5 後之終審前最終同步） | **僅同步 §12 映射表至實作現實，未改動任何 AC 條文本體、§16 決策點或其他章節。** T7／T8 對應之末 6 列（AC-27~AC-32）狀態 `PENDING`→`GREEN`，測試名以 `MileageSummarySection.test.tsx`（13 條）、`HomePage.test.tsx`、`AdminUserApplicationsPage.test.tsx`、`e2e/mileage-statistics.spec.ts`（6 情境）之**實際測試名逐字回填**（原預定名為英文，實作採 zh-TW 命名，見表註 7）；AC-30 測試檔欄擴為元件層＋頁面層兩檔、層級欄同步註記（表註 8）；補記 §11.4 六情境對照與前端／E2E 反向核對（表註 9、10）。**全表 35 列（34 AC + AC-09 拆列）狀態 `GREEN`、`PENDING` 0 列**，測試名逐字 `grep` 命中率 100%（missing=0，含負向對照）。 | T7 commit `b6d4b50`／T8 commit `17e7d8e` 及各自複審 `APPROVE`；R5-BATCH commit `fb182c5`；**E2E 17 條由大總管親跑全綠**（2026-08-03）；治理 2026-08-02.1（終審核對以本表為準） |

| 2026-08-03 | 終審 S-1 校正（大總管固化） | §12 表註 6 之反向核對數字校正至 R5-BATCH 後現實：三檔測試總數 67→**68**（contract 20→**21**，R5-B3 於 `fb182c5` 新增「重複帶自己 id 亦 400」正面樁）；附加鑑別 15→**16** 條（52 條列表數不變）。原數字停留於 SPEC-SYNC-2 時點，SPEC-SYNC-3 引用 R5 commit 但未連動校正——依 T5 複審 AR-1 之「本表陳述須逐字可機械核對」標準列為終審唯一阻擋項（Should Fix S-1），本列即其關閉紀錄。 | PHASE-005 終審（REQUEST_CHANGES→S-1，2026-08-03）；R5-BATCH `fb182c5` |

> **狀態轉換條件**：人類於 Spec Gate 裁定 D1~D10 → 大總管以修訂紀錄固化裁定結果（引用批准與日期）並將受影響條文（§7 API contract、§15 Task Graph、§12 映射表）連動更新 → 狀態改為 `ACTIVE` → 方可派 T1 開工。
