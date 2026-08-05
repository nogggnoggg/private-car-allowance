# PHASE-008 — 報表列印與正式 PDF

- Governance-Version: 2026-08-04.1（初版誤植 2026-08-05.1，大總管勘誤——治理現行版即 2026-08-04.1）
- 狀態：**`ACTIVE`**（**Spec Gate 通過**：人類 leonchih 2026-08-06 經 AskUserQuestion 三問全數照推薦——D1~D16 全數照推薦批准、D4 三項附帶批准（CJK 字型必裝／`--no-sandbox` 安全取捨明示接受／playwright runtime 依賴）、High Task 10 項（T1/T2/T4/T5/T7/T7b/T8a/T8/T9/T10）一併事前批准。固化紀錄見 §18）
- 建立日期：2026-08-06
- Task ID：`PHASE-008-SPEC`
- Base Commit：`1e9c23e`（branch `phase-008`，自 main `e597810` 切出）
- 上游（優先序依 `CLAUDE.md`）：人類確認決策 → `userstory.md` → `docs/PRD.md` :454-459 → `docs/ARCHITECTURE.md`／`docs/DATA_FLOW.md`／ADR → 現行實作
- 風險等級：**High**（正式報表與 PDF 為不可逆保存產物、編號唯一性、附件與檔案授權、新增外部依賴與容器變更）

> **Blocking Unknowns**：**無**（無任何足以阻止 Spec 定稿之未知）。
> 兩項**資訊缺口**（不阻塞 Spec，但影響 D4 之裁定品質，建議 Gate 時人類補充）：
> 1. Zeabur 後端服務之**映像大小與記憶體上限**（Chromium 約 +350~450 MB 映像、單次渲染尖峰 RSS 約 +150~300 MB）。
> 2. CI 硬體之實際效能（影響 NFR-US-14「PDF 10 秒目標」之測試門檻是否需放寬——**放寬須經 Spec 修訂，不得由 implementer 自行弱化**）。
>
> **技術棧疑義**：**無**。spec-writer 實查：root `node_modules/playwright@1.62.1` 與 `ms-playwright/chromium-1234` 均已在場（`@playwright/test` 之傳遞相依），本機開發與測試可立即執行；生產容器化之作法見 §16 D4。

---

## 0. 導讀與逐字依據

### 0.1 PRD §PHASE-008 逐字為綱（`docs/PRD.md` :454-459）

| PRD 條目 | 逐字內容（節錄） | 本 Spec 落點 |
|---|---|---|
| 目標（:456） | 「為三類已完成申請產生唯一報表編號（TRV/MNT/DEP + 月內唯一）、瀏覽器列印版（完整內容/計算明細/證明圖片、多段依序、圖片不溢出、多頁不重疊）、以 Playwright 用同一份列印版 HTML 產生並保存正式 PDF、產生安全檔名、下載保存檔（重下相同編號與內容）、PDF 產生失敗不得標示成功」 | §1.1、§2 A~E |
| Out of Scope（:457） | 「修正版/作廢報表（PHASE-009，但編號與 PDF 引擎在此，修正版於 009 複用產生新編號/新 PDF）」 | §1.2、§17.2 |
| 對應 US（:458） | 「FE-US-22, 23, 24, 27（報表響應式/桌面列印提示）；BE-US-26, 27, 28；NFR-US-14（PDF 10 秒目標）」 | §0.2 溯源表 |
| AC 摘要（:459） | 「草稿不得產生報表；已完成首次產生建立唯一編號並保存 PDF+產生時間；同月同類型多份編號皆唯一；同版本重下不重產編號且內容一致；PDF 未完整保存則不得顯示成功；列印版含完整內容/明細/證明、多段依序含對應截圖、圖片可辨識不溢出、多頁不重疊；檔名含類型/使用者名/日期或年度/報表編號並移除不安全字元；列印版與 PDF 同一版型」 | §2 全節逐條展開 |
| UI 驗收（:460） | 「Mock Gate（列印版版面）+ 整合 Gate（PDF 產生/下載端到端）」 | §15.4 Gate 規劃 |
| Human Gate（:463） | 「事前批准（High：不可逆報表產物）+ Mock Gate + 整合 Gate」 | §16 |

### 0.2 US → AC 溯源總表（**每條 US 驗收條件逐條有落點，無遺漏**）

| US | 驗收條件（逐條摘要） | 本 Spec AC |
|---|---|---|
| **FE-US-22**（產生正式報表） | ①已完成首次產生→建立唯一報表編號 | AC-02, AC-03, AC-06 |
| | ②草稿嘗試產生→拒絕 | AC-25 |
| | ③產生成功→查看申請顯示報表編號 | AC-06, AC-30 |
| | ④產生失敗（PDF 未完成保存）→畫面不得顯示已成功產生 | AC-07, AC-31 |
| **FE-US-23**（預覽及列印報表） | ①已完成開啟列印版→顯示完整內容、計算明細、證明圖片 | AC-11, AC-17, AC-18, AC-19 |
| | ②多段差旅→依行程段順序顯示明細與對應 Google Maps 截圖 | AC-12 |
| | ③多張證明→圖片可辨識且不超出頁面範圍 | AC-13 |
| | ④超過一頁→文字、表格及圖片不得重疊 | AC-14 |
| | ⑤報表已作廢→顯示作廢標示與原因 | **延後至 PHASE-009**（§1.2、§17.2；PRD :457 逐字 Out of Scope） |
| **FE-US-24**（下載正式 PDF） | ①已產生並保存→下載提供原保存 PDF | AC-08 |
| | ②同一版本再次下載→相同報表編號及相同內容 | AC-05, AC-08 |
| | ③檔名含不適合 OS 之字元→自動移除或轉換 | AC-21 |
| | ④三型→檔名使用對應類型、使用者姓名、日期或年度及報表編號 | AC-20 |
| **FE-US-27**（響應式操作，第 4 條） | ④手機開啟報表→可閱讀，系統可提示以桌面裝置列印 | AC-34, AC-36 |
| **BE-US-26**（唯一報表編號） | ①差旅→`TRV` ②保養→`MNT` ③折舊→`DEP` | AC-02 |
| | ④同月同類型多份→每份唯一 | AC-03, AC-04 |
| | ⑤同一版本已產生→再次下載不得重新產生不同編號 | AC-05 |
| **BE-US-27**（產生及保存正式 PDF） | ①首次產生成功→保存 PDF、報表編號及產生時間 | AC-06 |
| | ②無法完整產生或保存→不得標示已成功產生 | AC-07 |
| | ③已保存→再次下載提供原保存檔案 | AC-08 |
| | ④修正版完成→保存新的 PDF | **PHASE-009**（本 Phase 之編號與引擎複用即滿足；§17.2） |
| | ⑤報表已作廢→保留原始內容及可辨識作廢狀態 | **PHASE-009**（§17.2） |
| **BE-US-28**（安全 PDF 檔名） | ①含類型、使用者名稱、申請日期或年度及報表編號 | AC-20 |
| | ②使用者名稱含路徑符號或不安全字元→移除或轉換 | AC-21 |
| | ③同一使用者多份→檔名可透過報表編號區分 | AC-20, AC-23 |
| **NFR-US-14**（基本效能，第 4 條） | ④產生正式 PDF→目標 10 秒內完成 | AC-09 |
| **FE-US-05**（第 4 條，關鍵字含報表編號） | 輸入出差目的**或報表編號**→關鍵字查詢回傳符合紀錄 | **AC-38（條件 AC，須 D13 批准）** |

> **US 原意保護聲明**：本 Spec **未改變任何 US 之原意**，亦未刪減任何 US 驗收條件。上表標記為「延後至 PHASE-009」之三條（FE-US-23⑤、BE-US-27④⑤）之延後依據為 **PRD :457 逐字之 Out of Scope**，屬既有人類批准之階段劃分，非本 Spec 之裁量；其完整落地與回歸驗證義務已寫入 §17.2，並列為 D14 供 Gate 逐條確認。

### 0.3 跨 Phase 追蹤義務核銷表（Packet 八項，逐項核銷）

| # | Packet 條目 | 本 Spec 處置 | 落點 |
|---|---|---|---|
| 1 | **LEGACY 快照雙軌**（差旅依 `fuelPriceVersionId`、折舊依 `snapshotAnnualTotalKm` 判別；LEGACY 列不得以新模型重算，報表一律呈現快照值） | **納入 AC**：AC-17 三段式（差旅雙軌、折舊雙軌、零重算之 spy 斷言）；資料組裝層以「讀快照、零算式」為結構性紀律 | AC-17、§8.4、§11.2 |
| 2 | **折舊揭露面五值**（Q8 已裁定；不呈現車價與折舊年限） | **納入 AC**：AC-18（正向五值 ＋ 逐欄負向斷言，全身分一致） | AC-18、§6.3 |
| 3 | **對帳說明以三來源值重算、勿直接呈現 4dp `snapshotRawAmount`** | **納入 AC**：AC-18(c) | AC-18 |
| 4 | **保養列印版四值 ＋ 實際費用 ＋ 證明圖片** | **納入 AC**：AC-19 | AC-19 |
| 5 | **`RATIO_DISPLAY_SCALE` ↔ `snapshotRatio` DDL scale 對照測試**（AR-1 移交） | **納入 AC**：AC-01(g)（折舊與保養兩表各一格，常數與 `information_schema.columns.numeric_scale` 對照；常數改壞必紅） | AC-01(g)、T1 |
| 6 | **drift guard 升常設 infra 測試** | **納入 AC**：AC-01(h)；新建 `backend/test/integration/infra002-schema-drift.test.ts`，**既有 `phase7-migration-safety.test.ts` 之 drift 測試零改動、零刪除**（不弱化原則） | AC-01(h)、T1b |
| 7 | **T1 即審 FW-7**（表數斷言權威清單 4 點）＋ **FW-8**（純 CREATE 前提下 fixture 手法安全） | **納入 AC ＋ Task Graph 明列**：AC-01(f) 四處逐一實查（spec-writer 已親查，行號見 §8.5）；FW-8 已確認——本 Phase migration 為**純 `CREATE TABLE` ＋ 純 `CREATE INDEX` ＋ 一個 `ADD CONSTRAINT`**，對既有表**零 `ALTER`**，故安全網 fixture 手法可沿 PHASE-007 T1 既有作法，**不需 raw SQL 型處置** | AC-01(f)、§8.5、T1 |
| 8 | **人工檢核點常設規則**（Gate 走查腳本固化義務） | **納入 Gate 規劃**：Mock Gate（列印版版面）與整合 Gate（PDF 端到端）各須產出 `docs/verification/WALKTHROUGH-PHASE-008-MOCK.md`／`-INTEGRATION.md`（**大總管產出**，非本 Task 之 Allowed 檔案） | §15.4 |
| 9 | **修正版/作廢 Out of Scope，但編號與 PDF 引擎於本 Phase 建立、009 複用；介面設計須預留**（PRD :457 逐字） | **納入設計約束**：§7.6「PHASE-009 複用介面約束」＋ §17.2；D14 供 Gate 確認 | §7.6、§17.2、D14 |

---

## 1. 目標與非目標

### 1.1 目標

Phase 結束時，人類可對**任一類已完成申請**（差旅／保養／折舊）走完：

1. 於申請詳情頁點「產生正式報表」→ 系統建立**唯一報表編號**（`TRV-YYYYMM-NNNN` 等）並**同時**以 Playwright（Chromium）將**列印版 HTML** 渲染為 PDF、保存於持久化 volume，記錄編號、產生時間、檔名、位元組數與內容雜湊。
2. 於畫面上看到報表編號與產生時間；**若 PDF 未完整產生或保存，畫面絕不顯示「已成功產生」**，且資料庫與 volume 皆零殘留。
3. 點「檢視列印版」→ 於瀏覽器新分頁開啟列印版 HTML（**與 PDF 同一份版型產生器**），內容含完整申請資料、計算明細與證明圖片；多段差旅依序呈現各段明細與對應截圖；圖片不溢出、多頁不重疊。
4. 點「下載 PDF」→ 取得**原保存之 PDF 位元組**（非重新渲染），檔名含類型／使用者姓名／日期或年度／報表編號且已移除不安全字元；重複下載編號與內容完全一致。
5. 手機開啟列印版仍可閱讀，並看到「建議以桌面裝置列印」之提示；該提示**不出現於列印輸出與 PDF**。

### 1.2 非目標（Out of Scope）

| 項目 | 理由與落點 |
|---|---|
| **修正版報表**（新編號、新 PDF、原 PDF 不覆寫） | PRD :457 逐字 → **PHASE-009**。本 Phase 建立之編號產生器與 PDF 引擎於 009 複用（介面約束見 §7.6） |
| **作廢報表之作廢標示與原因**（FE-US-23⑤、BE-US-27⑤） | PRD :457 逐字 → **PHASE-009**。`ApplicationStatus.VOIDED` 於現行系統**結構性不可達**（`application-state-machine.ts` :14-17），本 Phase 不得預先實作作廢版型（避免不可測之投機程式碼；§17.2 記載 009 之落地義務） |
| **報表之稽核檢視頁** | PHASE-010（AD-US-14）。本 Phase 是否**寫入**稽核事件見 D15 |
| **暫存附件 24h 清理排程** | PHASE-011（BE-US-25），既有既定劃分 |
| **報表列表／報表獨立查詢頁** | US 未要求。報表資訊一律經申請詳情取得 |
| **PDF 內嵌數位簽章、浮水印、加密** | US 未要求，不做投機功能 |
| **重新產生（regenerate）／刪除報表端點** | US 未要求，且與「保存內容不可變」抵觸；修正需求走 PHASE-009 修正版 |
| **報表編號之關鍵字查詢**（FE-US-05④） | **範圍歧義，列 D13 供人類裁定**；未獲批准前不實作（AC-38 為條件 AC） |

---

## 2. 可測試 Acceptance Criteria

> **通則**：每條 AC 皆須可由自動化測試機械判定；「使用者可見行為」一律以逐字字串或鍵集斷言。金額／里程／比例一律**只讀快照、零重算**。

### A. 資料模型與 migration

**AC-01 `Report` 表建立與既有結構零改寫**（BE-US-26／27 之持久化基礎）

- **(a)** 新增 `Report` 表，欄位集合、可空性、型別與精度與 §8.1 **逐欄相符**（`information_schema.columns` 斷言）；四個唯一約束與一個一般索引存在（§8.2）；對 `Application` 之 FK 為 `ON DELETE RESTRICT`。
- **(b)** migration 對**既有 15 張表**逐欄**零改寫**（欄位集合、型別、精度、可空性、預設值全等），且 migration SQL **零 `ALTER TABLE` 於既有表**、零 `DROP`、零 `INSERT`／`UPDATE`、零 `ALTER TYPE`（正則斷言 ＋ 突變自證：加入一行 `ADD COLUMN` 必紅）。
- **(c)** 乾淨 DB 與既有 DB 各一輪 `prisma migrate deploy` 皆成功，重跑冪等；既有資料零回填、零改寫；`Report` 表在既有 DB 上為空表。
- **(d)** `Application` 之 `report Report?` 為 Prisma 關聯虛擬欄，**不產生任何 DDL**（以 `Application` 欄位集合前後全等佐證）。
- **(e)** enum 聯集全等——本 Phase **零 enum 異動**（既有七個 enum 之標籤集合前後完全相同）。
- **(f)** **表數 15 → 16 之四處權威斷言同步更新**（spec-writer 已親查，行號見 §8.5）：`infra001-isolation-self-check.test.ts` **兩處**、`phase6-migration-safety.test.ts` **一處**、`phase7-migration-safety.test.ts` **一處**；四處皆改為 `16` 且各自之鑑別性斷言（`toContain("MaintenanceApplication")` 等）**零弱化**。**implementer 須於 Handoff 回報實查處數**（勿信本 Spec 之預估——PHASE-006／007 先例：實際處數與預估可能不同）。
- **(g)** **（AR-1 移交結案）** 新增常數 ↔ DDL 對照斷言：`RATIO_DISPLAY_SCALE`（`depreciation-calculation.ts` :112／`depreciation-service.ts` :663，值 `6`）等於 `DepreciationApplication.snapshotRatio` 之 `numeric_scale`；同型對照 `MaintenanceApplication.snapshotRatio` 之 `numeric_scale` 等於保養顯示層之 `6`。**常數改為 4 或 DDL 改為 `(9,4)` 任一側必紅**（雙側 mutant 自證）。
- **(h)** **（drift guard 常設化）** 新建常設 infra 測試檔，以 `prisma migrate diff --exit-code` 斷言 `schema.prisma` 與 `prisma/migrations` 逐一套用後之狀態完全一致；該檔**不綁任何 Phase**，往後每個新 migration 自動受涵蓋。既有 `phase7-migration-safety.test.ts` 之 drift 測試**零改動、零刪除**（不弱化原則）。

### B. 報表編號（BE-US-26）

**AC-02 型別前綴（三型窮舉）**——`TRAVEL` → `TRV`、`MAINTENANCE` → `MNT`、`DEPRECIATION` → `DEP`。實作以**型別 → 前綴之窮舉映射**（`Record<ApplicationType, string>`）承載，未來新增型別於**編譯期**即失敗；三型各有正向測試，且映射對調（`TRV`↔`MNT`）之 mutant 必紅。

**AC-03 編號格式與月份歸屬**

- **(a)** 格式**逐字**為 `{PREFIX}-{YYYYMM}-{NNNN}`，例：`TRV-202608-0001`；以正則 `^(TRV|MNT|DEP)-\d{6}-\d{4,}$` 斷言，且逐段值精確等值。
- **(b)** `YYYYMM` 取自**產生時間**，以 **Asia/Taipei（UTC+08:00 固定偏移，台灣無日光節約）** 換算。四點邊界測試：`2026-08-31T15:59:59Z` → `202608`；`2026-08-31T16:00:00Z` → `202609`；`2026-12-31T16:00:00Z` → `202701`；`2026-01-01T00:00:00Z` → `202601`。**改為 UTC 之 mutant 必紅。**
- **(c)** `NNNN` 為該 `(前綴, 月份)` 之序號，自 `1` 起，`padStart(4, "0")`；序號 ≥ 10000 時**自然延伸為 5 位**（`10000`），**不截斷、不歸零、不拒絕**（純函式層以 `sequence=10000` 之測試固定此行為）。
- **(d)** 編號字串本身**僅含 `[A-Z0-9-]`**，可安全用於檔名（與 AC-20 之 ASCII fallback 相依）。

**AC-04 同月同型多份皆唯一（含併發）**

- **(a)** 同一月份、同一型別連續產生 5 份 → 序號為 `0001`~`0005`，五個編號互異。
- **(b)** 不同型別同月份互不干涉（`TRV-202608-0001` 與 `MNT-202608-0001` 可並存）。
- **(c)** **併發 ≥ 12 輪**（12 筆不同的已完成申請同時產生）→ 全部成功、12 個編號**互異**且集合恰為 `0001`~`0012`（無跳號、無重複）。
- **(d)** **DB 唯一約束為最後防線**：移除應用層序號重試之 mutant → 必出現唯一鍵衝突而測試變紅（不得以 500 外洩 DB 錯誤原文；轉為可行動之錯誤碼並重試，沿 PHASE-003a D4 先例）。

**AC-05 冪等：同一申請不重產編號**

- **(a)** 對同一申請重複 `POST` 產生報表 → **不新增 `Report` 列、不新增 storage 檔、`reportNumber`／`generatedAt`／`fileName`／`contentHash` 全部不變**；首次回 `201`、其後回 `200`（狀態碼可區辨）。
- **(b)** 重複下載不觸發任何產生行為（`Report` 列與檔案之 `updatedAt`／mtime 零變化；以 spy 斷言 PDF 渲染器**零呼叫**）。

### C. PDF 產生與保存（BE-US-27）

**AC-06 首次產生成功之完整保存**——成功回應後，下列**七項同時成立**：`Report` 列存在且 `applicationId` 正確；`reportNumber` 符合 AC-03；`generatedAt` 非空；`storageKey` 符合 `rpt/<token>/pdf` 格式；storage 中該 key 存在且位元組數等於 `byteSize`；`contentHash`（SHA-256）等於實際位元組之雜湊；PDF 位元組以 `%PDF-` 開頭、以 `%%EOF` 結尾且長度 > 1024。`GET` 報表端點與（若採 D10 方案 A）申請詳情皆可查得編號。

**AC-07 產生失敗零殘留、不得標示成功**（BE-US-27②、FE-US-22④）——下列**四種注入失敗**各一測試：①HTML 渲染拋錯；②PDF 渲染器拋錯／逾時；③`storage.put` 拋錯；④寫檔後**讀回校驗不符**（位元組數或雜湊不符）。每種情境皆須：回應為 `500 REPORT_GENERATION_FAILED`（**非 200、非 2xx**）；`Report` 資料表**零新增列**；storage **零殘留檔**（以列出該前綴下之 key 斷言）；後續 `GET` 報表仍為 `null`；申請本身之 `status`／`totalAmount`／快照**逐欄不變**。

**AC-08 重下提供原保存檔**（BE-US-27③、FE-US-24①②）——連續兩次下載之回應位元組**逐位元全等**，且等於產生當時保存之位元組（雜湊比對）；`Content-Type: application/pdf`；渲染器 spy **零呼叫**（證明是讀檔而非重算）。**「下載時重新渲染」之 mutant 必紅。**

**AC-09 效能與逾時守門**（NFR-US-14④）

- **(a)** 標準 fixture（差旅 3 段、每段 1 張 1600×1200 JPEG 證明）之產生端到端 **≤ 10 000 ms**（於 dev 拓撲量測；量測值須記入 Handoff）。
- **(b)** 渲染逾時（`REPORT_PDF_TIMEOUT_MS`，預設 30 000）觸發時，以 `REPORT_GENERATION_FAILED` 收斂並滿足 AC-07 之零殘留（不得懸掛、不得 200）。
- **(c)** **（容器）** 於後端容器映像內產生之 PDF，**中文字元不得為缺字方框**（字型在場）；以容器內渲染之量測斷言（見 §11.2）＋ Gate 走查腳本之目視確認。

**AC-10 同一申請併發產生**——同一申請之 2 個併發 `POST` → 最終**恰一份 `Report`**、兩個回應皆為成功且**編號相同**（敗方以冪等路徑回既有），storage **無孤兒檔**（敗方已產生之位元組須被清理，以前綴列舉斷言恰一個 key）。

### D. 列印版版型與內容（FE-US-23）

**AC-11 三型列印版內容完整**——列印版 HTML 逐型包含下列**逐字標題與值**（缺任一項必紅）：

| 型別 | 必含項目 |
|---|---|
| 共通 | 報表標題、報表編號（已產生時）、產生時間、申請人姓名、申請類型、申請狀態、申請建立時間、最終金額（新臺幣整數） |
| 差旅 | 出差日期、出差目的、各段（序號／出發地／到達地／總里程／高速里程／段金額）、總里程、油資每公里單價、ETC 每公里單價、（新模型另含）油種／每公升油價／車輛油耗、取整前總額之對帳列、各段證明截圖 |
| 保養 | 上次／本次保養日期、上次／本次里程表、**保養區間總里程**、**期間公務里程**、**公務使用比例**、實際費用、**公司分攤金額**、證明圖片 |
| 折舊 | 申請年度、**每年折舊費用**、**年度公務里程**、**年度總里程**、**公務比例**、**補貼金額**、證明圖片（**車價／折舊年限一律不得出現**，見 AC-18） |

**AC-12 多段依序與段—圖對應**（FE-US-23②）——差旅列印版之行程段以 `sortOrder` **升冪**呈現；每段之截圖**恰為該段所屬之附件**（以 3 段 × 各 1 張可辨識圖之 fixture，逐段比對嵌入之 data URI 與該段附件位元組之雜湊）。**段—圖錯置之 mutant（取第一段之圖給所有段／反序）必紅。**

**AC-13 圖片可辨識且不溢出**（FE-US-23③）

- **(a)（嵌入面）** 每張證明以 `data:image/...;base64,` 內嵌；長邊超過 `REPORT_IMAGE_MAX_PX`（預設 1600）者等比降尺寸後嵌入，**不放大**小圖；嵌入之位元組數 ≤ 原圖；來源檔遺失時該圖以佔位說明文字取代且**整份報表仍產生成功**（不得 500）。
- **(b)（版面面）** 於列印媒體模擬下量測：每張圖之 `getBoundingClientRect().width` ≤ 內容區寬度，且 `right` ≤ 內容區右緣 + 1px 容差；文件 `scrollWidth` ≤ 頁面內容寬度（無水平溢位）。**移除 `max-width:100%` 之 mutant 必紅。**

**AC-14 多頁不重疊**（FE-US-23④）——以「足以產生 ≥ 2 頁」之 fixture，於列印媒體模擬下量測：每個標記為不可分割之區塊（段落卡片、表格列、圖片容器）之 `top` 與 `bottom-1` 落於**同一頁索引**（`floor(y / 頁面內容高度)` 相等）；且任兩區塊之矩形**互不重疊**。**移除 `break-inside: avoid` 之 mutant 必紅。**

**AC-15 列印版與 PDF 同一版型**（PRD :459 逐字）——列印端點回傳之 HTML 與產生 PDF 時所使用之 HTML **由同一函式、同一輸入產生且字串全等**（同一 `ReportData` 輸入之兩次呼叫結果 `toEqual`；服務層以 spy 斷言 PDF 路徑呼叫的就是該函式）。**「PDF 走另一份模板／另一組樣式」之 mutant 必紅。**

**AC-16 自足文件與跳脫（安全）**

- **(a)** 列印版 HTML **零 `<script`**、零 `on*=` 事件屬性、零外部資源參照（無 `<link>`、無 `http://`／`https://`／`//` 開頭之 `src`／`href`／`url()`）；所有圖片皆為 `data:` URI。
- **(b)** **所有**來自資料之插值（出差目的、出發地、到達地、申請人姓名、附件原始檔名等）一律經**單一** HTML 跳脫函式處理；以 XSS payload fixture（`<script>alert(1)</script>`、`"><img src=x onerror=alert(1)>`、`</style>`）斷言：輸出中**不存在**未跳脫之標籤，且於 Chromium 載入後 `window` 上無被注入之副作用、無 console error。**移除跳脫之 mutant 必紅。**
- **(c)** 列印端點回應標頭含 `Content-Type: text/html; charset=utf-8`、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`、`Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'`。

**AC-17 LEGACY 快照雙軌（零重算）**（跨 Phase 追蹤 #1）

- **(a)（差旅）** 舊模型列（`fuelParameterVersionId != null` 且 `fuelPriceVersionId == null`）之列印版：呈現快照之油資／ETC 每公里單價原值，**不呈現**油種／每公升油價／車輛油耗三欄（該三欄為 `null`），**不得**顯示 `null`／`NaN`／空白亂碼（以「—」或逐字說明呈現）；新模型列則完整呈現五值。
- **(b)（折舊）** 舊模型列（`snapshotPerKmUnitPrice != null` 且 `snapshotAnnualTotalKm == null`）之列印版：呈現快照之**折舊每公里單價**原值與年度公務里程、金額，**不呈現**每年折舊費用／年度總里程／公務比例（該三欄為 `null`）；新模型列則呈現 AC-18 之五值。
- **(c)（零重算）** 兩型之 LEGACY fixture（以 raw SQL 播種舊模型列）產生之列印版與 PDF，其金額與單價**逐字等於快照值**；資料組裝與版型函式中**不存在任何算式**（結構性掃描：該二檔零 `.times(`／`.div(`／`.plus(`／`.minus(` 於金額路徑），且以 spy 斷言未呼叫任何計算引擎（`calculateTravel`／`calculateMaintenance`／`calculateDepreciation`／`deriveAnnualDepreciation`／`deriveFuelUnitPrice`）。**任一重算之 mutant 必紅。**

**AC-18 折舊揭露面（Q8 已裁定之落地）**（跨 Phase 追蹤 #2#3）

- **(a)（正向五值）** 折舊列印版與 PDF 呈現：**每年折舊費用**（2 位小數）、**年度公務里程**（2 位小數）、**年度總里程**（1 位小數）、**公務比例**（百分比 4 位小數）、**補貼金額**（整數）。
- **(b)（負向，全身分一致）** 折舊列印版、PDF 與報表 DTO **一律不出現**車價、折舊年限、預估年度行駛公里數、折舊參數版本 id——以**擁有人本人**與**管理員**兩身分各渲染一次，皆以「該值之字面字串不出現於輸出」＋「資料組裝結果之鍵集封閉白名單」雙層斷言。**任一欄回流之 mutant 必紅。**
- **(c)（對帳說明）** 對帳列以**三來源值**呈現算式：「每年折舊費用 × 年度公務里程 ÷ 年度總里程 = 補貼金額」；**不得**直接呈現 4 位小數之 `snapshotRawAmount`（負向斷言：`rawAmount` 之 4dp 字面值不出現於輸出）。

**AC-19 保養呈現四值 ＋ 實際費用 ＋ 證明**（跨 Phase 追蹤 #4）——保養列印版含**保養區間總里程／期間公務里程／公務使用比例／公司分攤金額**四值 ＋ 實際費用 ＋ 全部證明圖片（≥1 張）；四值逐字取自快照（`snapshotIntervalKm`／`snapshotOfficialKm`／`snapshotRatio`／`Application.totalAmount`），零重算。

### E. 安全檔名（BE-US-28）

**AC-20 檔名組成（三型逐型）**——檔名為 `{類型}_{使用者姓名}_{日期或年度}_{報表編號}.pdf`，其中類型為 zh-TW 標籤（`差旅`／`保養`／`折舊`）、日期或年度為：差旅＝出差日期（`YYYY-MM-DD`）、保養＝本次保養日期（`YYYY-MM-DD`）、折舊＝申請年度（`YYYY`）。三型各一測試，四段值逐字斷言；**同一使用者之多份報表因編號段而互異**（BE-US-28③）。日期／年度來源為 `null` 之防禦：以 `Application.primaryDate` 為 fallback（三型皆非空，見 §8.4）。

**AC-21 不安全字元移除或轉換（gate table）**——以下輸入（置於使用者姓名）逐列驗證輸出檔名安全且非空：`../../etc/passwd`、`a/b\c`、`名字:*?"<>|`、含 `\r\n` 之字串（header injection）、含空位元組（`\x00`）與控制字元、純空白、前後綴 `.` 與空白、`CON`／`NUL`（Windows 保留裝置名）、長度 300 字之字串、空字串。規則：`[\\/:*?"<>|]` 與控制字元 → `_`；連續空白 → `_`；去除前後綴 `.` 與空白；姓名段長度上限 **30** 字（超出截斷）；整體檔名（含副檔名）長度上限 **120**；若清理後姓名段為空 → 以 `使用者` 取代。**輸出恆不含 `/`、`\`、`\r`、`\n`、空位元組，且恆包含報表編號**（後者保證絕不與 Windows 保留裝置名全等）。

**AC-22 `Content-Disposition` 雙形式與標頭注入封閉**——下載回應之 `Content-Disposition` 同時含：ASCII fallback `filename="{報表編號}.pdf"`（**僅** `[A-Za-z0-9.-]`）與 RFC 5987 之 `filename*=UTF-8''{百分比編碼之完整檔名}`；標頭值**不含**裸 CR／LF；以含 `\r\n` 之姓名 fixture 斷言回應標頭數量與內容未被注入（wire-level 斷言）。

**AC-23 檔名於產生時持久化、重下一致**——`fileName` 於產生時寫入 `Report` 並凍結；**事後修改使用者 `displayName` 後再次下載，檔名逐字不變**（`Content-Disposition` 比對）。**「下載時即時推導檔名」之 mutant 必紅。**

### F. 授權與資料隔離

**AC-24 授權矩陣（4 端點 × 5 身分 ＝ 20 格）**——依 §6.1 之表逐格斷言（狀態碼與回應鍵集皆斷言）；一般使用者存取他人申請之報表一律 `403 FORBIDDEN`，且回應**不含**任何報表編號、檔名、金額或姓名。授權一律以 **DB 查得之 `Application.ownerId`** 為準，**絕不**採信任何請求參數。

**AC-25 狀態守門：草稿不得產生報表／不得開啟列印版**（FE-US-22②）——`DRAFT` 申請之產生、列印、下載三端點皆拒絕（碼與狀態見 D11）；`details.status` 揭露當前狀態供前端定位。**判定順序：認證 → 強制改密 → 授權（403）→ 狀態（拒絕）**——他人之草稿一律先以 `403 FORBIDDEN` 收斂，**不得**以錯誤碼差異洩漏「該申請是否為草稿」（側信道測試：他人草稿與他人已完成之回應碼與訊息**逐字相同**）。

**AC-26 storage 金鑰白名單與路徑安全**——PDF 之 storage key 由系統產生（`rpt/<隨機 token>/pdf`，token 為 `crypto.randomUUID()`），**不含任何使用者輸入**；金鑰白名單擴充為**封閉前綴集合**（附件實例僅接受 `att`、報表實例僅接受 `rpt`，互不互通）；既有 `att` 前綴之全部行為與既有 `storage.test.ts` **零改動、零弱化**；路徑穿越（`..`、絕對路徑、反斜線、URL 編碼、控制字元、空位元組）一律拒絕（沿既有測試矩陣，對 `rpt` 前綴重跑一輪）。PDF 位元組**一律經後端授權端點回傳**，volume **不得**由 nginx 靜態直出（結構性斷言：`nginx.conf` 無 volume 路徑之 `location`）。

**AC-27 揭露面封閉（鍵集白名單）**——`ReportDto` 之鍵集**恰為** `{reportNumber, generatedAt, fileName, byteSize, downloadUrl, printUrl}`（`toEqual` 全等，多一鍵必紅）；列印版資料組裝之輸出型別為**封閉白名單**，折舊分支**不得**含 `vehiclePrice`／`usefulLifeYears`／`estimatedAnnualKm`／`depreciationParameterVersionId`（逐鍵負向斷言，沿 PHASE-007 §20.10 之既有紀律）。

### G. 錯誤合約與日誌

**AC-28 錯誤合約**——`ErrorCode` 聯集全等（基線 ＋ 本 Phase 新增之 `REPORT_GENERATION_FAILED`，多一碼／少一碼必紅；BOGUS mutant 必紅）；四端點之錯誤表（§7.5）逐格斷言：`401`／`403 PASSWORD_CHANGE_REQUIRED`／`403 FORBIDDEN`／`404 NOT_FOUND`／`409 CONFLICT`／`500 REPORT_GENERATION_FAILED` 各有正例；錯誤回應**不外洩**堆疊、DB 結構、storage key 或絕對路徑。

**AC-29 日誌安全**（NFR-US-16）——以 `logStream` 掃描：日誌**不含** `storageKey`、volume 絕對路徑、session cookie／token、密碼、PDF 位元組或其 base64 片段、以及折舊之車價／折舊年限；`requestId` 在場可供追查；渲染失敗之日誌含可追查識別但不含上述任一。**反向探針**（刻意寫入敏感字串）證明掃描非恆真。

### H. 前端（FE-US-22／23／24／27）

**AC-30 報表區塊與產生流程**——三型申請詳情頁於 `status === "COMPLETED"` 時顯示「報表」區塊：未產生時顯示「產生正式報表」按鈕；點擊後呼叫產生端點，成功後**逐字顯示報表編號與產生時間**，並出現「檢視列印版」與「下載 PDF」兩入口。`status === "DRAFT"` 時**整個區塊不渲染**（負向斷言：`產生正式報表` 文字不存在）。

**AC-31 產生失敗不得顯示成功**（FE-US-22④）——mock 產生端點回 `500 REPORT_GENERATION_FAILED` → 畫面顯示錯誤訊息與「重試」，**不得**出現任何報表編號、不得出現「已產生」字樣、下載與列印入口**不出現**；重試會重新呼叫產生端點。

**AC-32 列印與下載入口**——「檢視列印版」以 `target="_blank"` 開啟 `/api/applications/{id}/report/print`（`rel="noopener"`）；「下載 PDF」導向 `/api/applications/{id}/report/pdf`；**前端不自組檔名、不自行渲染 PDF、不重複呼叫產生端點**（負向斷言：點擊下載時零 `POST`）。

**AC-33 五態**——Loading（產生中按鈕停用並顯示進行中）／Empty（已完成但尚未產生）／Error（產生或讀取失敗＋重試）／Success（編號＋時間＋兩入口）／Permission denied（`403` → 顯示無權限訊息，**零**後續請求）五態各一測試。

**AC-34 手機可閱讀 ＋ 桌面列印提示**（FE-US-27④）——列印版於 375px 寬度無水平溢位且主要內容可讀；頁面含逐字提示（例：「建議以桌面裝置列印」）；該提示於**列印媒體與 PDF 中不出現**（`@media print { display: none }`；以列印媒體模擬與 PDF 文字擷取雙層斷言）。

### I. E2E / Gate

**AC-35 三型端到端**——`e2e/report-pdf.spec.ts`：三型各一情境，完成申請 → 產生報表 → 畫面顯示編號 → 開啟列印版（斷言關鍵值在場）→ 下載 PDF（斷言下載檔名與 `%PDF-` 開頭）→ 再次下載內容一致；另含「草稿無報表入口」之負向情境。

**AC-36 響應式 375px**——列印版與三型詳情頁之報表區塊於 375px 無水平溢位（`document.scrollWidth <= clientWidth`）。

### J. 相容與回歸

**AC-37 零弱化與基準線只增不減**——既有全部測試**零刪除、零 skip、零弱化**；基準線起點（`1e9c23e`）：後端 **2573/0**、前端 **240/0**、E2E **38/38**；Phase 結束時三者只增不減（終審逐項核對）。

### K. 條件 AC（**須 D13 批准後方生效；未批准則本節不實作、不測試**）

**AC-38 報表編號之關鍵字查詢**（FE-US-05④）——綜合查詢之 `keyword` 除既有之差旅出差目的外，另比對 `Report.reportNumber`（大小寫不敏感、`%`／`_`／`\` 已跳脫）；三型申請皆可由其報表編號查得；未產生報表之申請不受影響；既有 `keyword` 測試零改動。

---

## 3. 正常流程

### 3.1 產生正式報表（FE-US-22、BE-US-26／27）

```
使用者（或管理員）於已完成申請詳情頁 → 點「產生正式報表」
  → POST /applications/:id/report
  → 【授權】requireAuth + requirePasswordChanged + assertOwnershipOrAdmin(DB.ownerId)
  → 【狀態】status 必須為 COMPLETED（DRAFT → 拒絕，D11）
  → 【冪等】已有 Report → 直接回既有（200，零渲染、零寫入）
  → 組裝 ReportData（讀快照，零重算；封閉白名單）
  → 讀取證明附件位元組 → sharp 降尺寸 → data URI 內嵌
  → renderReportHtml(ReportData) → HTML 字串（與列印端點同一份）
  → Playwright(Chromium) page.setContent(html) → page.pdf() → Buffer
  → 校驗（%PDF- 開頭、%%EOF 結尾、長度 > 0）
  → storage.put("rpt/<token>/pdf") → 讀回校驗（位元組數 + SHA-256）
  → SERIALIZABLE tx：再查一次冪等 → 配號（max(sequence)+1）→ INSERT Report
       唯一鍵衝突 → 重試（上限 5 次，指數退避）
  → 任一步失敗 → 清理已寫入之 storage 檔 → 500 REPORT_GENERATION_FAILED（零殘留）
  → 201 { report: ReportDto }
```

### 3.2 預覽及列印（FE-US-23）

```
使用者點「檢視列印版」→ 新分頁開啟 /api/applications/:id/report/print
  → 【授權】同上；【狀態】COMPLETED 才回應
  → 組裝 ReportData（同 3.1 之同一函式）→ renderReportHtml → text/html
  → 瀏覽器呈現；使用者按 Ctrl+P 列印（@page A4、桌面提示於列印媒體隱藏）
```

### 3.3 下載正式 PDF（FE-US-24）

```
使用者點「下載 PDF」→ GET /applications/:id/report/pdf
  → 【授權】同上
  → Report 不存在 → 404 NOT_FOUND（尚未產生）
  → storage.get(storageKey)（檔案遺失 → 404 + 錯誤日誌，不外洩 key）
  → Content-Type: application/pdf
     Content-Disposition: attachment; filename="TRV-202608-0001.pdf";
                          filename*=UTF-8''%E5%B7%AE%E6%97%85_...
  → 回傳原保存位元組（零渲染）
```

### 3.4 查詢報表資訊

```
申請詳情頁載入 → GET /applications/:id/report
  → 【授權】同上
  → 200 { report: ReportDto | null }（尚未產生為 null，**非 404**）
```

---

## 4. 五態（Loading / Empty / Error / Success / Permission denied）

| 狀態 | 觸發 | 前端呈現 | 後端語意 |
|---|---|---|---|
| **Loading** | 產生中／讀取報表資訊中 | 按鈕停用 ＋ 進行中提示；**不得**先行顯示任何編號 | — |
| **Empty** | 已完成但尚未產生報表（`report === null`） | 顯示「尚未產生正式報表」＋「產生正式報表」按鈕 | `200 { report: null }` |
| **Error** | 產生失敗／讀取失敗／逾時 | 錯誤訊息 ＋ 重試；**零編號、零下載入口**（AC-31） | `500 REPORT_GENERATION_FAILED` 或 `5xx` |
| **Success** | 已產生 | 報表編號、產生時間、檢視列印版、下載 PDF | `200/201 { report: ReportDto }` |
| **Permission denied** | 非擁有人且非管理員 | 「無權存取」訊息，**不得**顯示任何申請或報表資料，**零**後續請求 | `403 FORBIDDEN`（回應不含任何業務值） |

> **草稿之處置**：報表區塊**整段不渲染**（不是 disabled 按鈕），避免使用者誤以為功能故障；後端仍獨立守門（AC-25）——前端不渲染**從不是**授權或狀態依據。

---

## 5. 邊界條件

| # | 情境 | 預期行為 | 對應 AC |
|---|---|---|---|
| B-01 | 草稿申請產生報表 | 拒絕（D11 之碼），零寫入、零渲染 | AC-25 |
| B-02 | 他人之草稿申請產生報表 | `403 FORBIDDEN`，與「他人之已完成」回應**逐字相同**（無側信道） | AC-25 |
| B-03 | 不存在之申請 id | `404 NOT_FOUND`（授權判定前即為 404；不洩漏他人 id 是否存在之差異——沿既有 `GET /applications/:type/:id` 先例） | AC-24 |
| B-04 | 同一申請連續兩次產生 | 第二次 `200` 回既有，零新增列／檔 | AC-05 |
| B-05 | 同一申請 2 併發產生 | 恰一列、兩回應編號相同、零孤兒檔 | AC-10 |
| B-06 | 12 筆不同申請同時產生（同月同型） | 12 個互異編號，序號 `0001`~`0012` 無跳號 | AC-04(c) |
| B-07 | 產生時間為台北時間月初 00:00（UTC 前月 16:00） | 月份為**新月** | AC-03(b) |
| B-08 | 該月該型已有 9999 份 | 第 10000 份序號為 `10000`（5 位），仍唯一 | AC-03(c) |
| B-09 | 零附件之折舊已完成申請（證明選填） | 列印版正常產生，證明區顯示「無證明圖片」而非空白或錯誤 | AC-11, AC-19 |
| B-10 | 附件檔案於 volume 遺失（DB 有列、檔案無） | 該圖以佔位說明取代，**整份報表仍成功**；錯誤日誌不含 key | AC-13(a) |
| B-11 | 5 張證明（上限）之保養申請 | 五張皆嵌入、皆不溢出、頁面不重疊 | AC-13, AC-14 |
| B-12 | 單張 10 MB（上限）之 4000×3000 JPEG | 降尺寸至長邊 1600 後嵌入；產生仍 ≤ 10 秒 | AC-09, AC-13(a) |
| B-13 | 出差目的含 `<script>alert(1)</script>` | HTML 與 PDF 皆跳脫，零執行 | AC-16(b) |
| B-14 | 使用者姓名含 `../` 或 `:*?"<>\|` | 檔名清理為安全字串且含編號 | AC-21 |
| B-15 | 使用者姓名含 `\r\n` | 標頭零注入（wire-level 斷言） | AC-22 |
| B-16 | 使用者姓名為 300 字 | 姓名段截斷至 30、總長 ≤ 120 | AC-21 |
| B-17 | 使用者姓名清理後為空字串 | 姓名段以 `使用者` 取代，檔名非空 | AC-21 |
| B-18 | 產生後修改 `displayName` 再下載 | 檔名逐字不變 | AC-23 |
| B-19 | LEGACY 差旅（`fuelPriceVersionId == null`） | 呈現舊模型單價，新三欄以「—」呈現，零重算 | AC-17(a)(c) |
| B-20 | LEGACY 折舊（`snapshotAnnualTotalKm == null`） | 呈現每公里單價原值，新三欄「—」，零重算 | AC-17(b)(c) |
| B-21 | 折舊已完成申請由**管理員**開啟列印版／下載 | 車價與折舊年限**仍不出現**（全身分一致） | AC-18(b) |
| B-22 | 差旅無附件之段（歷史資料，理論上不可達） | 該段證明區顯示「無截圖」，不 500 | AC-11, AC-12 |
| B-23 | 極長之出差目的（500 字）與長地名 | 版面換行、不溢出、不重疊 | AC-13(b), AC-14 |
| B-24 | 已產生報表後刪除申請 | 不可達——`Report` 對 `Application` 為 `ON DELETE RESTRICT`，且 `DELETE /applications/:id` 僅對草稿開放；以測試固定此不變式 | AC-01(a) |
| B-25 | PDF 渲染逾時（注入慢速渲染） | `500 REPORT_GENERATION_FAILED`、零殘留 | AC-07, AC-09(b) |
| B-26 | 寫檔成功但讀回位元組數不符（注入） | 視為失敗：零 `Report` 列、清理檔案 | AC-07 |
| B-27 | 尚未產生報表即下載 | `404 NOT_FOUND`（訊息為「尚未產生正式報表」） | AC-24 |
| B-28 | 已產生但 storage 檔案遺失 | `404 NOT_FOUND` ＋ 錯誤日誌（不含 key），**不得** 500 | AC-24, AC-29 |
| B-29 | 需強制改密之使用者呼叫四端點 | `403 PASSWORD_CHANGE_REQUIRED`（四端點一致，見 D8） | AC-24 |
| B-30 | 未登入呼叫四端點 | `401 UNAUTHORIZED`，回應不含任何業務值 | AC-24 |
| B-31 | 375px 開啟列印版 | 無水平溢位、桌面列印提示在場 | AC-34, AC-36 |
| B-32 | 列印（列印媒體）時之桌面提示 | 不出現於列印輸出與 PDF | AC-34 |
| B-33 | 容器內產生含中文之 PDF | 中文正常顯示（非缺字方框） | AC-09(c) |
| B-34 | 同一使用者同月同型 3 份 | 三個編號互異，檔名以編號區分 | AC-04(a), AC-20 |

---

## 6. 權限與敏感資料

### 6.1 授權矩陣（**4 端點 × 5 身分 ＝ 20 格，格數明列**）

| 端點 | 未登入 | 需強制改密 | 本人（擁有人） | 他人（一般使用者） | 管理員 |
|---|---|---|---|---|---|
| `POST /applications/:id/report`（產生） | 401 | 403 `PASSWORD_CHANGE_REQUIRED` | **201/200** | **403 FORBIDDEN** | **201/200**（D9 裁定；代行） |
| `GET /applications/:id/report`（查詢） | 401 | 403 `PASSWORD_CHANGE_REQUIRED` | **200**（含 `null`） | **403 FORBIDDEN** | **200** |
| `GET /applications/:id/report/print`（列印版） | 401 | 403 `PASSWORD_CHANGE_REQUIRED` | **200 text/html** | **403 FORBIDDEN** | **200 text/html** |
| `GET /applications/:id/report/pdf`（下載） | 401 | 403 `PASSWORD_CHANGE_REQUIRED` | **200 application/pdf** | **403 FORBIDDEN** | **200 application/pdf** |

**判定紀律（不可違背）**

1. 授權一律以 **DB 查得之 `Application.ownerId`** 為準，**絕不**採信請求參數（沿 PHASE-004 §6.2 不變式 1）。
2. 判定順序：`requireAuth`（401）→ `requirePasswordChanged`（403）→ 申請存在性（404）→ `assertOwnershipOrAdmin`（403）→ 狀態守門（D11 之碼）。**授權先於狀態**，避免以碼差異洩漏他人申請之狀態（AC-25）。
3. 管理員之可見面**不擴張**：管理員本已可讀三型申請詳情（`assertOwnershipOrAdmin`），報表僅是同一資料之另一種呈現；**折舊之車價／折舊年限對管理員亦不外露**（AC-18(b)）。
4. 產生報表時 `Report.generatedById` ＝ **操作者**（管理員代行時為管理員），擁有人恆由 `Application.ownerId` 決定——沿 PHASE-004「擁有人／操作者分離」之既有紀律。

### 6.2 稽核

見 **D15**（是否為報表產生新增 `AuditAction.REPORT_GENERATED`）。**未經裁定前不實作**；`Report.generatedById` ＋ `generatedAt` 已提供最小追溯能力。

### 6.3 敏感資料

| 資料 | 處理原則 | 落點 |
|---|---|---|
| 正式 PDF 位元組 | 保存於持久化 volume；**一律經授權端點回傳**，nginx 不得靜態直出；storage key 系統產生、封閉前綴白名單 | AC-26 |
| 證明圖片 | 以 data URI 內嵌於列印版／PDF；列印版本身受同一授權守門，故不構成繞過 | AC-16, AC-24 |
| 折舊車價／折舊年限／預估年里程／參數版本 id | **持久化但一律不外露**（DTO、列印版、PDF、日誌皆然；全身分一致） | AC-18(b), AC-27, AC-29 |
| storage key 與 volume 絕對路徑 | 不入錯誤回應、不入日誌 | AC-28, AC-29 |
| 使用者姓名 | 出現於檔名與報表內文（US 明文要求）；檔名經安全清理；HTML 內文經跳脫 | AC-20, AC-21, AC-16(b) |
| Session／密碼／token | 絕不入日誌與回應（既有紀律） | AC-29 |

---

## 7. API Contract

### 7.1 端點總表（**本 Phase 新增 4 個，皆掛於 `reports` 模組**）

| 方法 | 路徑 | 用途 | 前置中介 | 成功回應 |
|---|---|---|---|---|
| `POST` | `/applications/:id/report` | 產生正式報表（冪等） | `requireAuth` ＋ `requirePasswordChanged` | `201 { report: ReportDto }`（首次）／`200 { report: ReportDto }`（已存在） |
| `GET` | `/applications/:id/report` | 查詢報表資訊 | 同上 | `200 { report: ReportDto \| null }` |
| `GET` | `/applications/:id/report/print` | 列印版 HTML | 同上 | `200 text/html; charset=utf-8` |
| `GET` | `/applications/:id/report/pdf` | 下載正式 PDF | 同上 | `200 application/pdf` ＋ `Content-Disposition: attachment` |

> **路徑設計理由**：四端點皆以**申請**為主體（`/applications/:id/...`），使授權判定（`assertOwnershipOrAdmin(DB.ownerId)`）與既有三型詳情端點**完全同型**，不新增任何授權路徑。PHASE-009 之修正版為**新的 `Application`**，因而自然取得新編號與新 PDF，**端點零變更**（§7.6）。

### 7.2 DTO 形狀

```ts
/** 報表資訊；鍵集為封閉白名單（AC-27）。 */
export interface ReportDto {
  reportNumber: string;   // "TRV-202608-0001"
  generatedAt: string;    // ISO8601
  fileName: string;       // 產生時凍結之安全檔名（含 .pdf）
  byteSize: number;       // PDF 位元組數
  downloadUrl: string;    // "/applications/{id}/report/pdf"（後端相對；前端加 /api 前綴）
  printUrl: string;       // "/applications/{id}/report/print"
}
```

> **刻意不含**：`id`、`storageKey`、`contentHash`、`generatedById`、`sequence`、`numberPrefix`、`numberPeriod`——內部識別與儲存細節不外露（沿 PHASE-003 §9.4 之 storage key 不外洩紀律）。
> `downloadUrl`／`printUrl` 之相對路徑形式沿用既有 `AttachmentDto.previewUrl`／`downloadUrl` 慣例（前端以 `toFrontendUrl()` 加 `/api` 前綴）。

### 7.3 列印版資料組裝之封閉型別（`ReportData`）

```ts
type ReportData =
  | { kind: "TRAVEL";       common: ReportCommon; travel: TravelReportBody }
  | { kind: "MAINTENANCE";  common: ReportCommon; maintenance: MaintenanceReportBody }
  | { kind: "DEPRECIATION"; common: ReportCommon; depreciation: DepreciationReportBody };

interface ReportCommon {
  reportNumber: string | null;   // 尚未產生時為 null（列印版仍可看）
  generatedAt: string | null;
  ownerDisplayName: string;
  typeLabel: "差旅" | "保養" | "折舊";
  statusLabel: string;
  createdAt: string;
  totalAmount: number;           // 最終金額（整數）
}

interface DepreciationReportBody {          // ★ 揭露面封閉（AC-18(b)、AC-27）
  model: "CURRENT" | "LEGACY";
  applicationYear: number | null;
  annualDepreciation: string | null;        // CURRENT：2dp；LEGACY：null
  annualTotalKm: string | null;             // CURRENT：1dp；LEGACY：null
  ratioPercent: string | null;              // CURRENT：4dp；LEGACY：null
  perKmUnitPrice: string | null;            // LEGACY：4dp；CURRENT：null
  officialKm: string;                       // 2dp（兩模型共有）
  attachments: ReportImage[];
  // 絕不含 vehiclePrice / usefulLifeYears / estimatedAnnualKm /
  // depreciationParameterVersionId / rawAmount(4dp 直呈)
}
```

> 差旅／保養之 body 型別同構，逐欄列於 §11.1 之測試對象；三者**皆為封閉白名單**，任何欄位新增須經 Spec 修訂。

### 7.4 列印版與 PDF 之同一版型契約（PRD :459 逐字）

```
renderReportHtml(data: ReportData): string     // 純函式，無 IO、無 DB、無隨機、無時鐘
        │
        ├── GET /applications/:id/report/print  ->  直接回傳此字串（text/html）
        └── POST /applications/:id/report       ->  page.setContent(此字串) -> page.pdf()
```

- **不得**存在第二份模板、第二組樣式或「PDF 專用」分支（AC-15 之 mutant 守門）。
- 版型內之樣式一律 **inline `<style>`**；螢幕／列印之差異一律以 `@media print` 表達（同一份 HTML，非兩份）。
- `renderReportHtml` **不讀時鐘**——`generatedAt` 一律由呼叫端傳入，確保同輸入同輸出（AC-15 之 `toEqual` 得以成立）。

### 7.5 錯誤合約

| 情境 | 碼 | HTTP | `details` |
|---|---|---|---|
| 未登入／Session 失效 | `UNAUTHORIZED` | 401 | — |
| 需強制改密 | `PASSWORD_CHANGE_REQUIRED` | 403 | — |
| 非擁有人且非管理員 | `FORBIDDEN` | 403 | — |
| 申請不存在／`Report` 尚未產生（下載）／storage 檔遺失 | `NOT_FOUND` | 404 | — |
| 申請非已完成（草稿）→ 產生／列印／下載 | **見 D11**（推薦 `CONFLICT` 409） | 409 | `{ status: "DRAFT" }` |
| PDF 渲染／保存／校驗失敗、逾時 | **`REPORT_GENERATION_FAILED`（新增）** | 500 | `{ stage: "RENDER" \| "STORE" \| "VERIFY" \| "PERSIST" }`（**不含**任何路徑、key 或堆疊） |
| 未預期例外 | `INTERNAL_ERROR` | 500 | — |

> **`ErrorCode` 聯集新增恰一碼**（`REPORT_GENERATION_FAILED`）——屬**公開 API contract 變更**，列 D5 供 Gate 批准。`details.stage` 之值域為封閉四項，供前端顯示差異化提示而不外洩內部細節。

### 7.6 PHASE-009 複用介面約束（PRD :457 逐字「介面設計須預留」之落地）

1. **編號產生器**（`report-number.ts`）之簽章以 **`(type, generatedAt, nextSequence)`** 為輸入，**不依賴** `Application` 之任何狀態；修正版於 009 只需以新 `applicationId` 呼叫同一函式即取得新編號——**零改動**。
2. **冪等鍵為 `Report.applicationId`（唯一）**：修正版為**新的 `Application` 列**，故天然取得新編號與新 PDF，**原 `Report` 與其 PDF 不被觸碰**（`storageKey` 唯一、無覆寫路徑；本 Phase **不提供**任何更新或刪除 `Report` 之程式路徑——結構性斷言，見 §11.2）。
3. **版型之作廢標示**：`renderReportHtml` 之輸入為**單一 `ReportData` 物件**，009 得以**新增一個欄位＋一段版型區塊**完成作廢標示，無需改變函式簽章或呼叫端。**本 Phase 不預先建立任何作廢欄位或分支**（投機程式碼禁令）。
4. **PDF 引擎**（`pdf-renderer.ts`）之簽章為 `(html: string, options) => Promise<Buffer>`，與申請型別、狀態完全解耦。

---

## 8. 資料模型與 migration

### 8.1 新增資料表 `Report`（推薦形狀；精度與約束依 §16 D1 裁定）

```prisma
/// PHASE-008：正式報表（每個 Application 至多一份；修正版為新 Application → 新 Report）。
model Report {
  id            String      @id @default(cuid())
  applicationId String      @unique                       // 冪等鍵（D3）
  application   Application @relation(fields: [applicationId], references: [id], onDelete: Restrict)

  reportNumber  String      @unique                       // "TRV-202608-0001"
  numberPrefix  String                                    // "TRV" | "MNT" | "DEP"
  numberPeriod  String                                    // "YYYYMM"（Asia/Taipei）
  sequence      Int                                       // 該 (prefix, period) 之序號，自 1

  storageKey    String      @unique                       // "rpt/<uuid>/pdf"（系統產生）
  fileName      String                                    // 產生時凍結之安全檔名（AC-23）
  byteSize      Int
  contentHash   String                                    // SHA-256 hex（重下一致性驗證）

  generatedById String                                    // 操作者（無 FK，沿 003a/005a 慣例）
  generatedAt   DateTime    @default(now())

  @@unique([numberPrefix, numberPeriod, sequence])        // 併發最後防線（D3）
  @@index([numberPrefix, numberPeriod])                   // max(sequence) 查詢
}
```

`Application` 新增關聯虛擬欄（**零 DDL**）：`report Report?`

### 8.2 欄位與約束之推導依據

| 項目 | 決定 | 依據 |
|---|---|---|
| `applicationId` 唯一 | 一個申請至多一份報表 | BE-US-26⑤（不得重新產生不同編號）；冪等之結構性保證（D3） |
| `onDelete: Restrict` | 有報表之申請不可被刪 | 報表為正式產物；`DELETE /applications/:id` 僅對草稿開放，故實務上不可達，Restrict 為結構性保險（B-24） |
| `reportNumber` 唯一 | 全域唯一 | BE-US-26④ |
| `(numberPrefix, numberPeriod, sequence)` 唯一 | 序號配置之最後防線 | 沿 PHASE-003a D4「DB 唯一約束捕捉併發」先例 |
| `storageKey` 唯一 | 一檔一列，杜絕覆寫 | §7.6-2「原 PDF 不覆寫」之結構性保證 |
| 三個編號分欄持久化 | 使 `max(sequence)` 為索引可用之查詢，避免解析字串 | 效能與正確性；`reportNumber` 為三者之衍生呈現 |
| `contentHash` `String`（SHA-256 hex，64 字元） | 讀回校驗與重下一致性 | AC-06、AC-08 |
| `byteSize` `Int` | PDF 大小（遠小於 `int4` 上限） | 與 `Attachment.byteSize` 慣例一致 |
| `generatedById` 無 FK | 沿 `FuelPriceVersion.createdById`／`UserFuelConsumptionVersion.createdById` 既有慣例 | 一致性；避免影響 `userHasHistory` 之刪除守門語意 |
| **不新增 `PdfFile` 表** | `DATA_FLOW §1` 之 `Report 1───1 PdfFile` 概念層關聯折為 `Report` 之三欄（`storageKey`／`fileName`／`byteSize`） | 1:1 且無獨立生命週期，另立表為過度正規化；屬概念→實作之落地裁量，列 **D1** 供 Gate 確認並記入 §13 同步項 |

### 8.3 `userHasHistory` 之處置（**明文：零變更**）

`Report` **無** `User` FK，且每一份 `Report` 必依附於一筆 `Application`（`ownerId` FK 為 `Restrict`）——既有 `userHasHistory` 之 `application.count({ where: { ownerId } })` 已完整涵蓋。**本 Phase 不修改 `backend/src/users/history.ts`**；以測試固定此推論（有報表之使用者刪除 → 仍為 `409 CONFLICT`，且錯誤來源為 Application 而非 FK 例外）。

### 8.4 快照讀取與新舊模型判別（**報表一律讀快照、零重算**）

| 型別 | 判別欄 | `CURRENT` 呈現 | `LEGACY` 呈現 |
|---|---|---|---|
| 差旅 | `fuelPriceVersionId`（`!= null` 為 CURRENT；`fuelParameterVersionId != null` 且 `fuelPriceVersionId == null` 為 LEGACY） | 油資／ETC 單價 ＋ 油種／每公升油價／車輛油耗 | 油資／ETC 單價；新三欄以「—」 |
| 保養 | 無雙軌（PHASE-006 起單一模型） | 四值 ＋ 實際費用 | — |
| 折舊 | `snapshotAnnualTotalKm`（`!= null` 為 CURRENT；`snapshotPerKmUnitPrice != null` 且 `snapshotAnnualTotalKm == null` 為 LEGACY） | 每年折舊費用／年度公務里程／年度總里程／公務比例／金額 | 折舊每公里單價（原值）／年度公務里程／金額 |

> 判別條件**逐字沿用** PHASE-005a §8.4 與 PHASE-007 §20.7.4，**不得**於本 Phase 另立判準。
> `Application.primaryDate` 三型皆非空（差旅＝出差日期、保養＝本次保養日期、折舊＝該年 12-31），為檔名日期段之 fallback 來源（AC-20）。

### 8.5 migration 順序、可逆性與四處表數斷言（FW-7 實查）

**migration**：`backend/prisma/migrations/20260806xxxxxx_phase8_report_model/migration.sql`

- 內容**僅**：一個 `CREATE TABLE "Report"`、四個 `CREATE UNIQUE INDEX`、一個 `CREATE INDEX`、一個 `ALTER TABLE "Report" ADD CONSTRAINT ... FOREIGN KEY`。
- **零** `ALTER TABLE` 於既有表、**零** `DROP`、**零** `INSERT`／`UPDATE`、**零** `ALTER TYPE`（AC-01(b) 正則斷言）。
- **FW-8 確認**：本 migration 為**純 CREATE 型**，安全網 fixture 得沿 PHASE-007 T1 之既有手法（Prisma client 直接播種），**不需** raw SQL 型處置（該義務僅適用於 ALTER 型 migration，如 PHASE-007 之 M2）。
- **可逆性**：回滾即 `DROP TABLE "Report"`（連帶索引與 FK 自動移除）；**既有資料零補償**。已保存之 PDF 檔案會成為 volume 上之孤兒（見 §14）。

**表數斷言四處（spec-writer 於基準 `1e9c23e` 親查之行號；implementer 須複查後回報）**

| # | 檔案 | 行 | 現值 | 應改為 | 鑑別性斷言（**不得弱化**） |
|---|---|---|---|---|---|
| 1 | `backend/test/integration/infra001-isolation-self-check.test.ts` | :77 | `expect(tableRows.length).toBe(15)` | `16` | 其後之逐表空表檢查 |
| 2 | 同上 | :157 | `expect(tableRows.length).toBe(15)` | `16` | `AC-08` 之 enum oid 檢查 |
| 3 | `backend/test/integration/phase6-migration-safety.test.ts` | :550 | `expect(tableRows.length).toBe(15)` | `16` | `toContain("MaintenanceApplication")` |
| 4 | `backend/test/integration/phase7-migration-safety.test.ts` | :684 | `expect(tableRows.length).toBe(15)` | `16` | `toContain("DepreciationApplication")` |

> 第 4 處之 `it` 標題逐字為 `AC-01(f) 表數 14→15 — DepreciationApplication is the 15th business table`——**標題內之數字屬 PHASE-007 之歷史事實**，implementer 僅改斷言值、**不得**改寫該標題（改寫會使 PHASE-007 之 AC 對照表失去可 `grep` 性）；如需說明，於該行加註解（沿 PHASE-007 T1R-LITE 之既有作法）。

---

## 9. Data Flow（本 Phase 影響部分）

### 9.1 產生報表（唯一之寫入路徑）

```
POST /applications/:id/report
  -> requireAuth + requirePasswordChanged
  -> application = findUnique(id)                          null -> 404
  -> assertOwnershipOrAdmin(actor, application.ownerId)         -> 403
  -> status !== COMPLETED                                       -> 409 CONFLICT + details.status（D11）
  -> (1) 冪等前置查詢：Report.findUnique({ applicationId })
           存在 -> 200 回既有（**零渲染、零寫入**）
  -> (2) buildReportData(prisma, application)   讀快照 + 附件列（零重算，封閉白名單）
  -> (3) embedImages(storage, sharp)            讀位元組 -> 降尺寸 -> data URI
           單張讀取失敗 -> 佔位說明，**不中止**（B-10）
  -> (4) html = renderReportHtml(data)          純函式（與列印端點同一份）
  -> (5) pdf = renderPdf(html, { timeoutMs })   Playwright；逾時 -> 失敗路徑
           校驗：%PDF- 開頭、%%EOF 結尾、length > 0
  -> (6) storageKey = `rpt/${randomUUID()}/pdf`
         storage.put(key, pdf, "application/pdf")
         讀回校驗：exists + byteSize 相等 + SHA-256 相等    不符 -> 失敗路徑
  -> (7) SERIALIZABLE tx（重試 <=5）：
           a. Report.findUnique({ applicationId })  存在 -> 標記「敗方」，跳出
           b. next = max(sequence) + 1 where (prefix, period)
           c. INSERT Report(...)      唯一鍵衝突 -> 重試 b
  -> (8) 敗方 or 任一步失敗 -> storage.delete(key)（補償）-> 200 冪等 or 500
  -> 201 { report }
```

**不變式（以測試守護）**

- **零殘留**：`Report` 列與 storage 檔**同生共死**——不存在「有列無檔」或「有檔無列」之持久狀態（失敗路徑一律補償刪檔；AC-07、AC-10）。
- **配號在最後**：序號僅於**交易提交**時被消耗；渲染或寫檔失敗**絕不**消耗編號（避免編號出現無對應報表之洞）。
- **(2)(3)(4) 之順序不可對調**：狀態與授權未過時**不讀附件位元組、不啟動 Chromium**（省成本、錯誤語意單一）。
- **(5) 之前零 DB 寫入**：任何 DB 寫入只發生於 (7)。

### 9.2 列印版（唯讀路徑）

```
GET /applications/:id/report/print
  -> 授權與狀態守門同 9.1
  -> buildReportData -> embedImages -> renderReportHtml     與 9.1 之 (2)(3)(4) 同一份實作
  -> 200 text/html（**絕不寫入任何資料列、絕不寫入任何檔案**）
```

### 9.3 下載（唯讀路徑）

```
GET /applications/:id/report/pdf
  -> 授權與狀態守門同 9.1
  -> report = Report.findUnique({ applicationId })   null -> 404
  -> bytes = storage.get(report.storageKey)          例外 -> 404 + 錯誤日誌（不含 key）
  -> 200 application/pdf
       Content-Disposition: attachment; filename="{編號}.pdf"; filename*=UTF-8''{編碼檔名}
       Cache-Control: no-store；X-Content-Type-Options: nosniff
  -> **渲染器零呼叫**（AC-08 spy）
```

### 9.4 storage 抽象之擴充（`att` ／ `rpt` 雙實例）

```
server.ts
  attachmentStorage = new LocalVolumeStorage(ATTACHMENT_STORAGE_ROOT, { prefixes: ["att"] })
  reportStorage     = new LocalVolumeStorage(REPORT_STORAGE_ROOT,     { prefixes: ["rpt"] })
```

- 金鑰白名單由**寫死之 `att`** 改為**建構子參數之封閉前綴集合**，預設 `["att"]`——**既有呼叫端與既有測試零改動**（AC-26）。
- 兩實例之 root 互不重疊（compose 既有註解已預留 `/data/storage/pdf`）；跨實例之 key **互不接受**（附件實例拒 `rpt/...`，反之亦然），以測試固定。
- `docker-entrypoint.sh` 須比照 `ATTACHMENT_STORAGE_ROOT` 為 `REPORT_STORAGE_ROOT` 建立目錄並 `chown`（否則容器內以 `appuser` 寫入失敗 → 產生恆失敗）。

---

## 10. 非功能需求

1. **效能（NFR-US-14④）**：標準 fixture 之 PDF 產生 ≤ 10 秒（AC-09(a)）。設計上之保證：附件位元組**只讀一次**、以 `sharp` 降尺寸後嵌入（避免 10 MB 原圖進入 Chromium）、`page.setContent` **零網路請求**（無外部資源）、Chromium 啟動參數精簡。列印版（唯讀）之回應目標 ≤ 2 秒（沿 NFR-US-14①）。
2. **資源與可搬遷**：新增三個環境變數 `REPORT_STORAGE_ROOT`／`REPORT_PDF_TIMEOUT_MS`（預設 30000）／`REPORT_IMAGE_MAX_PX`（預設 1600），一律經 `config/env.ts` 之 zod schema 驗證；生產環境 `REPORT_STORAGE_ROOT` **未設即啟動失敗**（沿 `ATTACHMENT_STORAGE_ROOT` 之既有 fail-fast 形狀），非生產以動態 temp 路徑回退。**不寫死任何路徑或秘密。**
3. **新增相依（例外，須 D4 批准）**：後端新增 `playwright`（或 `playwright-core`）為 **runtime dependency**，並於映像中安裝 Chromium 與 **CJK 字型**。這是本 Phase 唯一之外部相依擴張，理由為 CLAUDE.md 已確認之技術棧（「PDF：Playwright (Chromium) 渲染列印版 HTML」）。**除此之外不得新增任何 npm 套件**（圖片處理沿用既有 `sharp`；雜湊沿用 node 內建 `crypto`；UUID 沿用 `crypto.randomUUID`）。
4. **記憶體與併發**：Chromium **每次請求啟動、用畢即關**（D4 推薦方案），確保無殭屍瀏覽器與跨請求狀態污染；同時產生之上限由 Node 事件迴圈自然節流，本 Phase **不實作佇列**（US 未要求；~20 人規模，見 §17.1 已知限制）。
5. **精度紀律**：報表**不做任何金額或里程計算**——所有數值皆為快照之**定精度字串**（既有 DTO 慣例）直接呈現。故本 Phase **零 `Decimal` 運算、零取整**；以結構性掃描守門（AC-17(c)）。
6. **相容**：既有差旅／保養／折舊／附件／參數／統計之全部測試**零弱化、零 skip、零刪除**；基準線只增不減（AC-37）。
7. **安全預設**：列印版為自足文件（零腳本、零外部資源）＋ 嚴格 CSP ＋ `nosniff`；所有插值跳脫；PDF 一律經授權端點回傳；storage key 系統產生且前綴封閉。

---

## 11. 測試策略

### 11.0 測試紀律（強制，寫入每個 Task Packet）

- **TDD**：先寫會失敗的測試；Handoff 須附「修復前紅燈」之實際輸出。
- **禁止**刪除／弱化／`skip` 既有測試換綠燈。**10 秒效能斷言若於 CI 變紅，正解為 Spec 修訂（記錄實測與新門檻），不得靜默放寬。**
- **鑑別力**：每個關鍵規則須有 mutant 自證（改壞實作必紅），且 Handoff 須附 mutant 紅燈之實際輸出。
- **INFRA-001 併跑限制持續有效**：不得同時派工兩個會跑 vitest 的 agent。
- **新增 src 檔須同步入既有結構性掃描清單**（沿 PHASE-005a AR-B 機械項）。
- **禁止 spawn 任何 subagent**（治理 2026-08-04.1）。
- **Playwright 於後端測試之使用**：後端整合測試會啟動真實 Chromium，單檔耗時較長；該類測試集中於 `phase8-pdf-render.test.ts`／`phase8-report-generate.test.ts`，**不得**散落於其他檔案（避免全套測試時間失控）。

### 11.1 單元（Vitest，不需 DB、不需瀏覽器）

| 對象 | 檔案 | 重點 |
|---|---|---|
| `report-number.ts`（純函式） | `backend/test/unit/report-number.test.ts` | AC-02／AC-03；三型前綴窮舉 ＋ 對調 mutant；Asia/Taipei 四點邊界（含 `T15:59:59Z`／`T16:00:00Z` 相鄰對）＋ UTC mutant 必紅；`padStart` 與 `sequence=10000` 之 5 位行為；輸出字元集斷言（`[A-Z0-9-]`）；格式正則 ＋ 逐段值 |
| `report-filename.ts`（純函式） | `backend/test/unit/report-filename.test.ts` | AC-20／AC-21；三型組成 gate table；不安全字元 12 列 gate table（含 `../`、`\r\n`、控制字元、保留裝置名、300 字、空字串）；長度上限雙層（姓名 30／整體 120）；輸出恆不含 `/ \ CR LF` 且恆含編號之**不變式 sweep**（隨機 200 例） |
| `report-html.ts`（純函式） | `backend/test/unit/report-html.test.ts` | AC-11／AC-12／AC-15／AC-16／AC-17／AC-18／AC-19；三型必含項目逐字；段序與段—圖對應（錯置 mutant 必紅）；同輸入兩次呼叫 `toEqual`；零 `<script`／零外部 URL 之正則；XSS payload 跳脫（3 種 payload × 5 個插值點）；折舊禁列逐欄負向；LEGACY 雙軌兩型；對帳列以三來源值呈現且 `rawAmount` 4dp 不出現 |
| `pdf-renderer.ts` 之選項組裝 | 併入 `phase8-pdf-render.test.ts` | 逾時參數傳遞、啟動參數集合（`--no-sandbox` 等）之結構性斷言 |

### 11.2 整合（Vitest ＋ PostgreSQL ＋ 真實 route；部分含真實 Chromium）

| 對象 | 檔案 | 重點 |
|---|---|---|
| migration 安全網 | `backend/test/integration/phase8-migration-safety.test.ts` | AC-01(a)~(g)；乾淨／既有 DB 各一輪；既有 15 表逐欄零改寫 ＋ 突變自證；`Application` 欄位集合前後全等（AC-01(d)）；enum 聯集全等；**`RATIO_DISPLAY_SCALE` ↔ DDL scale 雙側 mutant**（AC-01(g)）；`Report` 之四唯一約束與 FK `RESTRICT` 行為（刪除父列必失敗，B-24） |
| drift guard（常設） | `backend/test/integration/infra002-schema-drift.test.ts` | AC-01(h)；`prisma migrate diff --exit-code` 為 0；**不綁 Phase**；既有 phase7 之同型測試零改動 |
| 資料組裝 | `backend/test/integration/phase8-report-data.test.ts` | AC-17／AC-18／AC-19／AC-27；三型 fixture ＋ **LEGACY 兩型以 raw SQL 播種**；輸出鍵集封閉（`toEqual`）；折舊禁列逐欄；計算引擎 spy 零呼叫；金額路徑零算式之結構性掃描 |
| 圖片嵌入 | `backend/test/integration/phase8-report-images.test.ts` | AC-13(a)；data URI 前綴；長邊上限（4000px 原圖 → 1600）與**不放大**（800px 原圖維持 800）；嵌入位元組 <= 原圖；檔案遺失 → 佔位且不中止；日誌不含 key |
| PDF 渲染器 | `backend/test/integration/phase8-pdf-render.test.ts` | AC-09；真實 Chromium；`%PDF-`／`%%EOF`／長度；逾時注入 → 明確錯誤且不懸掛；**中文可見度量測**（渲染一段中文並以 `document.fonts.check()` 與字寬量測雙層斷言，AC-09(c)）；效能量測（≤10 000 ms，量測值輸出於測試名或 log） |
| 產生端點 | `backend/test/integration/phase8-report-generate.test.ts` | AC-04／AC-05／AC-06／AC-07／AC-10；四種失敗注入之零殘留（DB ＋ storage 前綴列舉雙層）；12 輪併發之編號集合全等 `0001..0012`；同申請 2 併發恰一列 ＋ 零孤兒；序號重試 mutant；**「無任何更新／刪除 `Report` 之程式路徑」之結構性斷言**（§7.6-2） |
| storage 前綴 | `backend/test/unit/storage.test.ts`（**既有檔，只增不改**）＋ `backend/test/unit/report-storage.test.ts` | AC-26；`rpt` 前綴之路徑穿越矩陣重跑；跨實例互拒；既有 `att` 測試逐條零改動（diff 檢查） |
| 下載與查詢端點 | `backend/test/integration/phase8-report-download.test.ts` | AC-08／AC-22／AC-23／AC-24（下載與查詢兩列）；兩次下載位元組全等 ＋ 渲染器 spy 零呼叫；`Content-Disposition` 雙形式 wire-level；`\r\n` 注入封閉；改 `displayName` 後檔名不變；檔案遺失 → 404 不 500 |
| 列印端點與授權 | `backend/test/integration/phase8-report-print.test.ts` | AC-15／AC-24（產生與列印兩列）／AC-25；同一版型（列印端點 HTML 與產生 PDF 所用 HTML 全等）；20 格授權矩陣逐格；**側信道**：他人草稿與他人已完成之回應逐字相同；回應標頭三項（CSP／nosniff／no-store） |
| 錯誤合約與日誌 | `backend/test/integration/phase8-contract.test.ts` | AC-28／AC-29；`ErrorCode` 聯集全等（BOGUS mutant 必紅）；四端點錯誤表逐格；`logStream` 掃描七類敏感值 ＋ 反向探針 |
| 刪除守門回歸 | 併入 `phase8-migration-safety.test.ts` | §8.3：有報表之使用者刪除仍 `409 CONFLICT`；`history.ts` **零 diff** 之結構性斷言 |

### 11.3 前端（Vitest ＋ Testing Library，mock fetch）

| 對象 | 檔案 | 重點 |
|---|---|---|
| 報表區塊共用元件 | `frontend/test/ReportSection.test.tsx` | AC-30／AC-31／AC-32／AC-33；五態各一；草稿不渲染之負向；失敗時零編號、零下載入口；點下載零 `POST`；`target="_blank"` ＋ `rel="noopener"` |
| 三型詳情頁接線 | 既有 `TravelApplicationPage.test.tsx`／`MaintenanceApplicationPage.test.tsx`／`DepreciationApplicationPage.test.tsx`（**只增不改既有斷言**） | AC-30（三型皆有區塊）；既有測試零弱化之 diff 檢查 |

### 11.4 E2E（Playwright，Mock Gate ＋ 整合 Gate）

| 檔案 | 重點 |
|---|---|
| `e2e/report-pdf.spec.ts` | AC-35／AC-36；三型端到端（完成 → 產生 → 顯示編號 → 開列印版 → 下載 → 重下一致）；草稿無入口之負向；375px 無溢位 |
| `e2e/report-print-layout.spec.ts` | AC-13(b)／AC-14／AC-34；**列印媒體模擬（`emulateMedia({ media: "print" })`）下之機械量測**：圖片寬度與右緣、文件 `scrollWidth`、每個 `.avoid-break` 區塊之頁索引一致性、任兩區塊矩形不重疊、桌面提示於列印媒體不可見 |

> **版面驗證之方法論說明（記錄備查）**：「多頁不重疊」於 PDF 位元組層無法在不新增 PDF 解析相依之前提下機械判定。本 Spec 選擇於 **DOM ＋ 列印媒體模擬**domain 驗證——這正是產生 PDF 的**同一個排版引擎**（Chromium），故其結論對 PDF 有直接效力；PDF 位元組層則以完整性（magic bytes、長度、雜湊）與 Gate 目視雙軌覆蓋。此為測試策略裁量（spec-writer 可自主範圍），限制已記於 §17.1。

### 11.5 安全測試

- 授權矩陣 20 格（§6.1）逐格；他人資料 403 且回應零業務值。
- 判定順序無側信道（授權 403 先於狀態碼；他人草稿 vs 他人已完成回應逐字相同）。
- storage 路徑穿越矩陣（`rpt` 前綴重跑）＋ 跨實例互拒。
- XSS：三種 payload × 五個插值點，HTML 與載入後之瀏覽器行為雙層。
- 標頭注入：`\r\n` 於姓名 → `Content-Disposition` wire-level 斷言。
- 日誌敏感鍵掃描七類 ＋ 反向探針。
- 揭露面：折舊禁列逐欄（本人與管理員兩身分）。

---

## 12. AC ↔ 測試映射表（機械可查；隨 Task 完成更新「狀態」欄）

> **格式**：`AC` ｜ `層級` ｜ `測試檔（預定路徑）` ｜ `測試名（預定名稱）` ｜ `Task` ｜ `狀態`
> 狀態值：`PENDING`（Spec 階段）／`RED`（測試已寫且失敗）／`GREEN`（實作完成通過）。
> **Phase 完成前之覆蓋檢查與終審核對以本表為準**（治理 2026-08-02.1）。
> **`GREEN` 列之測試名須為實際存在之測試名（逐字可 `grep`）**；`PENDING` 列為預定名稱，落地後依 `vitest --reporter=verbose`／`playwright --reporter=list` 之實際輸出**逐字回填**。

| AC | 層級 | 測試檔 | 測試名（預定） | Task | 狀態 |
|---|---|---|---|---|---|
| AC-01(a)~(e) | integration | `phase8-migration-safety.test.ts` | `AC-01(a): Report 表之欄位集合、可空性、型別與四個唯一約束逐欄符合 §8.1`；`AC-01(b): 既有 15 張表逐欄零改寫（含突變自證：ADD COLUMN 必紅）`；`AC-01(c): 乾淨與既有 DB 各一輪 migrate deploy 成功且冪等`；`AC-01(d): Application 欄位集合前後全等（report 為虛擬關聯欄，零 DDL）`；`AC-01(e): enum 聯集全等 — 本 Phase 零 enum 異動` | T1 | PENDING |
| AC-01(f) | integration | `infra001-isolation-self-check.test.ts`；`phase6-migration-safety.test.ts`；`phase7-migration-safety.test.ts` | 四處既有測試之斷言值 15→16（測試名零改動；implementer 回報實查處數） | T1 | PENDING |
| AC-01(g) | integration | `phase8-migration-safety.test.ts` | `AC-01(g): RATIO_DISPLAY_SCALE 等於 DepreciationApplication.snapshotRatio 之 numeric_scale（常數側與 DDL 側各一 mutant 必紅）`；`AC-01(g): 保養顯示比例位數等於 MaintenanceApplication.snapshotRatio 之 numeric_scale` | T1 | PENDING |
| AC-01(h) | integration | `infra002-schema-drift.test.ts` | `常設 drift guard：schema.prisma 與 prisma/migrations 逐一套用後之狀態完全一致（migrate diff --exit-code = 0）` | T1b | PENDING |
| AC-02 | unit | `backend/test/unit/report-number.test.ts` | `AC-02: 三型前綴窮舉 TRAVEL→TRV / MAINTENANCE→MNT / DEPRECIATION→DEP（映射對調 mutant 必紅）` | T2 | PENDING |
| AC-03 | unit | `report-number.test.ts` | `AC-03(a): 編號格式為 {PREFIX}-{YYYYMM}-{NNNN} 且逐段值精確`；`AC-03(b): 月份依 Asia/Taipei 換算 — 四點邊界（UTC mutant 必紅）`；`AC-03(c): sequence 補零與 10000 之五位延伸`；`AC-03(d): 編號字元集恆為 [A-Z0-9-]` | T2 | PENDING |
| AC-04 | integration | `phase8-report-generate.test.ts` | `AC-04(a): 同月同型連續 5 份序號 0001~0005 且互異`；`AC-04(b): 不同型別同月份互不干涉`；`AC-04(c): 12 筆併發產生之編號集合恰為 0001~0012（無跳號、無重複）`；`AC-04(d): 移除序號重試之 mutant 觸發唯一鍵衝突且不外洩 DB 錯誤原文` | T8 | PENDING |
| AC-05 | integration | `phase8-report-generate.test.ts` | `AC-05(a): 同一申請重複 POST 不新增列與檔，首次 201 其後 200 且編號/時間/檔名/雜湊全不變`；`AC-05(b): 下載不觸發產生（渲染器 spy 零呼叫）` | T8 | PENDING |
| AC-06 | integration | `phase8-report-generate.test.ts` | `AC-06: 首次產生成功之七項完整保存（DB 列 + storage 檔 + 雜湊 + PDF magic bytes）` | T8 | PENDING |
| AC-07 | integration | `phase8-report-generate.test.ts` | `AC-07: 四種失敗注入（RENDER/STORE/VERIFY/PERSIST）各自零殘留 — 零 Report 列、零 storage 檔、500 REPORT_GENERATION_FAILED、申請快照逐欄不變` | T8 | PENDING |
| AC-08 | integration | `phase8-report-download.test.ts` | `AC-08: 兩次下載位元組逐位元全等且等於保存值；渲染器 spy 零呼叫（下載時重新渲染之 mutant 必紅）` | T9 | PENDING |
| AC-09(a)(b) | integration | `phase8-pdf-render.test.ts` | `AC-09(a): 標準 fixture 之產生端到端 <= 10000 ms（量測值記入 Handoff）`；`AC-09(b): 渲染逾時以 REPORT_GENERATION_FAILED 收斂且零殘留、不懸掛` | T7 ＋ T8 | PENDING |
| AC-09(c) | integration | `phase8-pdf-render.test.ts` | `AC-09(c): 中文字型在場 — 渲染中文字串之字寬量測與 document.fonts.check 雙層斷言` | T7b | PENDING |
| AC-10 | integration | `phase8-report-generate.test.ts` | `AC-10: 同一申請 2 併發產生恰一份 Report、兩回應編號相同、storage 恰一個 key（零孤兒）` | T8 | PENDING |
| AC-11 | unit | `backend/test/unit/report-html.test.ts` | `AC-11: 三型列印版必含項目逐字在場（共通 8 項 + 差旅 / 保養 / 折舊各自清單）` | T5 | PENDING |
| AC-12 | unit | `report-html.test.ts` | `AC-12: 行程段以 sortOrder 升冪呈現且每段截圖恰為該段附件（反序與取首段圖兩個 mutant 各必紅）` | T5 | PENDING |
| AC-13(a) | integration | `phase8-report-images.test.ts` | `AC-13(a): 圖片以 data URI 內嵌、長邊上限 1600 且不放大小圖；來源遺失以佔位取代且整份報表仍成功` | T6 | PENDING |
| AC-13(b) | e2e | `e2e/report-print-layout.spec.ts` | `AC-13(b): 列印媒體下每張圖寬度與右緣不超出內容區、文件無水平溢位（移除 max-width:100% 之 mutant 必紅）` | T14 | PENDING |
| AC-14 | e2e | `e2e/report-print-layout.spec.ts` | `AC-14: 多頁 fixture 下每個不可分割區塊之頁索引一致且任兩區塊矩形不重疊（移除 break-inside: avoid 之 mutant 必紅）` | T14 | PENDING |
| AC-15 | unit ＋ integration | `report-html.test.ts`；`phase8-report-print.test.ts` | `AC-15: 同輸入兩次呼叫 renderReportHtml 結果全等（純函式、不讀時鐘）`；`AC-15: 列印端點回傳之 HTML 與產生 PDF 所用之 HTML 字串全等（PDF 走另一份模板之 mutant 必紅）` | T5 ＋ T10 | PENDING |
| AC-16 | unit ＋ integration | `report-html.test.ts`；`phase8-report-print.test.ts` | `AC-16(a): 列印版零 <script、零 on* 屬性、零外部資源參照`；`AC-16(b): 三種 XSS payload × 五個插值點皆跳脫且於 Chromium 載入後零副作用（移除跳脫之 mutant 必紅）`；`AC-16(c): 列印端點四個安全標頭在場` | T5 ＋ T10 | PENDING |
| AC-17 | integration | `phase8-report-data.test.ts` | `AC-17(a): LEGACY 差旅呈現舊模型單價、新三欄以「—」呈現且不顯示 null/NaN`；`AC-17(b): LEGACY 折舊呈現每公里單價原值、新三欄以「—」`；`AC-17(c): 零重算 — 計算引擎 spy 全數零呼叫且金額路徑零算式（結構性掃描）` | T4 | PENDING |
| AC-18 | integration | `phase8-report-data.test.ts` | `AC-18(a): 折舊呈現五值（每年折舊費用/年度公務里程/年度總里程/公務比例/金額）`；`AC-18(b): 車價、折舊年限、預估年里程、參數版本 id 於本人與管理員兩身分皆不出現（鍵集封閉 + 字面負向斷言）`；`AC-18(c): 對帳列以三來源值呈現且 4dp rawAmount 不出現` | T4 | PENDING |
| AC-19 | integration | `phase8-report-data.test.ts` | `AC-19: 保養呈現四值 + 實際費用 + 全部證明圖片，四值逐字取自快照` | T4 | PENDING |
| AC-20 | unit | `backend/test/unit/report-filename.test.ts` | `AC-20: 三型檔名組成 {類型}_{姓名}_{日期或年度}_{編號}.pdf 逐段精確；同使用者多份以編號段互異` | T3 | PENDING |
| AC-21 | unit | `report-filename.test.ts` | `AC-21: 不安全字元 gate table（12 列）輸出安全且非空`；`AC-21: 不變式 sweep — 輸出恆不含 / \ CR LF 且恆包含報表編號（200 隨機例）` | T3 | PENDING |
| AC-22 | integration | `phase8-report-download.test.ts` | `AC-22: Content-Disposition 同時含 ASCII fallback 與 RFC 5987 形式且無裸 CR/LF（含 \r\n 姓名之 wire-level 注入封閉）` | T9 | PENDING |
| AC-23 | integration | `phase8-report-download.test.ts` | `AC-23: 產生後修改 displayName 再下載，檔名逐字不變（下載時即時推導之 mutant 必紅）` | T9 | PENDING |
| AC-24 | integration | `phase8-report-print.test.ts`；`phase8-report-download.test.ts` | `AC-24: 授權矩陣 20 格逐格（狀態碼 + 回應鍵集）`；`AC-24: 403 與 401 回應不含任何報表編號/檔名/金額/姓名` | T9 ＋ T10 | PENDING |
| AC-25 | integration | `phase8-report-print.test.ts` | `AC-25: 草稿之產生/列印/下載三端點皆拒絕且 details.status 在場`；`AC-25: 側信道 — 他人草稿與他人已完成之回應碼與訊息逐字相同` | T10 | PENDING |
| AC-26 | unit ＋ integration | `backend/test/unit/report-storage.test.ts`；`backend/test/unit/storage.test.ts`（既有，零改動） | `AC-26: rpt 前綴之路徑穿越矩陣全數拒絕`；`AC-26: 附件實例拒 rpt 金鑰、報表實例拒 att 金鑰（跨實例互拒）`；`AC-26: 既有 att 前綴行為零改動（既有測試檔零 diff）` | T8a | PENDING |
| AC-27 | integration | `phase8-report-data.test.ts`；`phase8-report-download.test.ts` | `AC-27: ReportDto 鍵集恰為六鍵（toEqual 全等，多一鍵必紅）`；`AC-27: ReportData 折舊分支之鍵集封閉白名單` | T4 ＋ T9 | PENDING |
| AC-28 | integration | `phase8-contract.test.ts` | `AC-28: ErrorCode 聯集全等（基線 + REPORT_GENERATION_FAILED；BOGUS mutant 必紅）`；`AC-28: 四端點錯誤合約逐格（401/403/403PCR/404/409/500）且回應不外洩堆疊、DB 結構、storage key` | T11 | PENDING |
| AC-29 | integration | `phase8-contract.test.ts` | `AC-29: logStream 七類敏感值掃描全綠 + 反向探針證明非恆真` | T11 | PENDING |
| AC-30 | frontend | `frontend/test/ReportSection.test.tsx`；三型頁既有測試檔 | `AC-30: 已完成申請顯示報表區塊，產生成功後逐字顯示編號與產生時間`；`AC-30: 草稿不渲染報表區塊（負向斷言）`；`AC-30: 三型詳情頁皆掛載報表區塊` | T12 ＋ T13 | PENDING |
| AC-31 | frontend | `ReportSection.test.tsx` | `AC-31: 產生失敗時顯示錯誤與重試，且零編號、零「已產生」字樣、零下載/列印入口；重試會重新呼叫產生端點` | T12 | PENDING |
| AC-32 | frontend | `ReportSection.test.tsx` | `AC-32: 檢視列印版以 target=_blank + rel=noopener 開啟 /api/.../report/print；下載導向 /api/.../report/pdf 且點擊時零 POST` | T13 | PENDING |
| AC-33 | frontend | `ReportSection.test.tsx` | `AC-33: 五態 — Loading / Empty / Error / Success / Permission denied 各一（403 後零後續請求）` | T13 | PENDING |
| AC-34 | e2e | `e2e/report-print-layout.spec.ts` | `AC-34: 列印版於 375px 可閱讀且含桌面列印提示；該提示於列印媒體與 PDF 文字中皆不出現` | T14 | PENDING |
| AC-35 | e2e | `e2e/report-pdf.spec.ts` | `AC-35: 三型端到端（完成→產生→顯示編號→列印版→下載→重下一致）`；`AC-35: 草稿無報表入口（負向）` | T15 | PENDING |
| AC-36 | e2e | `e2e/report-pdf.spec.ts` | `AC-36: 列印版與三型詳情頁報表區塊於 375px 無水平溢位` | T15 | PENDING |
| AC-37 | 全 Task ＋ 終審 | — | 每個 Task 之 Done When 含「既有測試零弱化」；終審以三套件實跑數對照基準線 2573/240/38 | 全 Task | PENDING |
| **AC-38（條件）** | integration | `phase8-report-keyword.test.ts` | `AC-38: keyword 比對報表編號（三型皆可查得）；未產生報表之申請不受影響；既有 keyword 測試零改動` | **T17（須 D13 批准）** | **BLOCKED（待裁定）** |

---

## 13. Architecture / Data Flow 需同步項清單（**本 Phase 不修改該二檔**；結案 DOC-SYNC 批次處理）

| # | 目標檔／節 | 同步內容 |
|---|---|---|
| 1 | `ARCHITECTURE.md` §3 模組表 `reports` 列 | 補記落點與檔案分工：`backend/src/reports/`——`report-number.ts`（編號純函式）／`report-filename.ts`（安全檔名純函式）／`report-data.ts`（快照讀取與封閉白名單組裝）／`report-html.ts`（列印版版型純函式）／`report-images.ts`（附件位元組 → 降尺寸 → data URI）／`pdf-renderer.ts`（Playwright 封裝）／`report-service.ts`（編排、交易、冪等、補償）／`routes.ts`（四端點） |
| 2 | `ARCHITECTURE.md` §4.7（報表與 PDF） | 補記：編號格式 `{PREFIX}-{YYYYMM}-{NNNN}`（月份依 Asia/Taipei）；冪等鍵為 `Report.applicationId` 唯一；併發以「SERIALIZABLE ＋ `max(sequence)+1` ＋ 三欄唯一約束 ＋ 重試」保證；**配號在交易提交時才被消耗**；PDF 產生失敗一律零殘留（列與檔同生共死） |
| 3 | `ARCHITECTURE.md` §4.5／新增一條 | 補記 storage 抽象之**封閉前綴白名單**（`att`／`rpt` 雙實例、跨實例互拒）；PDF 一律經授權端點回傳，volume 不得靜態直出（既有紀律之延伸） |
| 4 | `ARCHITECTURE.md` §6 開放問題 | **結案兩條**：①「Playwright/Chromium 於後端容器的封裝方式」→ 依 D4 裁定；②「報表編號月內唯一的併發安全實作」→ 依 D3 裁定。**兩條移出開放問題並改寫為定案條目** |
| 5 | `ARCHITECTURE.md` §1 技術棧表 PDF 列 | 「隨後端（同容器或伴生 worker，Phase Spec 定案）」→ 依 D4 之裁定改為定值 |
| 6 | `DATA_FLOW.md` §1.1 實體摘要 | `Report` 列改為本 Spec §8.1 之落地形狀；**刪除 `PdfFile` 列**並註明其三欄併入 `Report`（D1） |
| 7 | `DATA_FLOW.md` §1 概念圖 | `Report 1───1 PdfFile` 改為 `Application 0..1───1 Report（含 PDF 檔案參照）` |
| 8 | `DATA_FLOW.md` §1.2 關鍵不變式 | 新增：「已完成申請至多一份 `Report`；`Report` 列與其 PDF 檔案同生共死；本 Phase 不存在更新或刪除 `Report` 之程式路徑」 |
| 9 | `DATA_FLOW.md` §2.4（報表產生與下載） | 以本 Spec §9.1~§9.3 之落地流程取代概要流程（含冪等前置、配號在最後、讀回校驗、補償刪檔、404 語意） |
| 10 | `DATA_FLOW.md` §3 敏感資料彙整「正式 PDF」列 | 補記 storage key 系統產生與封閉前綴；補記折舊揭露面於報表之延續（車價／年限不外露） |
| 11 | `PROJECT_STATE.md` 跨 Phase 追蹤（**大總管白名單**） | ①**AR-1（`RATIO_DISPLAY_SCALE` 對照）已於本 Phase 結案**，可自追蹤清單移除；②**drift guard 已升常設**，可自追蹤清單移除；③新增「FE-US-05 報表編號關鍵字查詢」之處置結果（依 D13）；④新增「PHASE-009 須複用本 Phase 之編號產生器與 PDF 引擎，並補齊 FE-US-23⑤／BE-US-27④⑤」 |

---

## 14. Rollback

| 情境 | 處置 |
|---|---|
| **Spec 未批准／方向翻轉** | 分支未合併，直接棄用 `phase-008` 分支；main 零影響 |
| **Task 層失敗** | 單一 atomic commit 還原（`git revert`）；各 Task 皆為新增檔案為主，還原不影響既有模組 |
| **migration 回滾** | `DROP TABLE "Report"`（索引與 FK 連帶移除）。**既有 15 表零補償、既有資料零改寫**——本 migration 未觸碰任何既有欄位。回滾後 `schema.prisma` 須同步移除 `Report` model 與 `Application.report` 欄，並以常設 drift guard（AC-01(h)）確認一致 |
| **已保存之 PDF** | 回滾後 volume 上之 `rpt/` 前綴檔案成為孤兒。**開發期為合成資料，直接刪除該前綴目錄即可**；正式環境若已上線，須先匯出該前綴檔案再回滾（列為 Runbook 待辦） |
| **容器變更回滾（D4）** | Dockerfile／compose／entrypoint 之變更為獨立 Task（T7b），可單獨還原；還原後產生端點必失敗（渲染器不可用）——故**容器變更與程式變更須同批發布**，不得只回滾其一（列為發布約束） |
| **編號序列一致性** | 回滾不造成序列不一致：序號由 `max(sequence)+1` 於配號當下計算，非全域序列物件；表被 `DROP` 後重建即自 `0001` 起。**若正式環境已發出編號後回滾，重建將產生重複編號**——故正式環境之回滾一律須先匯出 `Report` 表（Runbook 待辦） |

---

## 15. Task Graph

> 每 Task 一律 TDD、一個 atomic commit（含 Task ID）。**規模上限（治理 §10）：單 Task ≤ 5 AC、≤ 6 檔、不得同時橫跨 FE＋BE＋DB 三層。**
> **Expected Diff / usage 預算**依 `docs/retrospective/PHASE-007-usage.md` §3／§6.3 之型態帶（見下表「預算」欄）。**逾預算 50% 須即時回報（Stop Condition）**；接線型 usage 拆分線 ~320k。

| Task | 內容 | 層 | AC（≤5） | 檔案（≤6） | Risk | 依賴 | 預算（diff／usage 帶） | Done When |
|---|---|---|---|---|---|---|---|---|
| **T1** | `Report` schema ＋ migration ＋ 安全網 ＋ 四處表數連動 ＋ AR-1 對照 | DB | AC-01(a)~(g) | `backend/prisma/schema.prisma`、`backend/prisma/migrations/*`、`backend/test/integration/phase8-migration-safety.test.ts`、`infra001-isolation-self-check.test.ts`、`phase6-migration-safety.test.ts`、`phase7-migration-safety.test.ts` | **High**（不可逆 migration） | — | ~1100 行／~130-135k | 乾淨與既有 DB 皆 migrate 成功且冪等；既有 15 表逐欄零改寫＋突變自證；`Application` 欄位集合前後全等；enum 聯集全等；**四處表數斷言實查後回報實際處數**；AR-1 雙側 mutant 必紅；FK `RESTRICT` 行為測試在場 |
| **T1b** | drift guard 升常設 infra 測試 | DB／infra | AC-01(h) | `backend/test/integration/infra002-schema-drift.test.ts` | Medium | T1 | ~150 行／~50-100k（輕 Lite） | 新檔不綁 Phase；`migrate diff --exit-code = 0`；既有 phase7 drift 測試**零 diff**；影子 schema 用畢即清 |
| **T2** | 報表編號純函式（前綴映射、Asia/Taipei 月份、序號格式） | BE（純函式，零接線） | AC-02, AC-03 | `backend/src/reports/report-number.ts`、`backend/test/unit/report-number.test.ts` | **High**（編號唯一性語意 ＋ 使用者可見識別） | — | ~700 行／~145-160k | 三型前綴對調 mutant 必紅；UTC mutant 必紅；四點時區邊界綠；`sequence=10000` 行為固定；字元集不變式 sweep |
| **T3** | 安全檔名純函式（組成、清理、長度、fallback） | BE（純函式，零接線） | AC-20, AC-21 | `backend/src/reports/report-filename.ts`、`backend/test/unit/report-filename.test.ts` | Medium | T2 | ~700 行／~145-160k | 12 列 gate table 綠；200 例不變式 sweep（恆不含 `/ \ CR LF`、恆含編號）；三型組成逐段精確 |
| **T4** | 報表資料組裝（三型、LEGACY 雙軌、封閉白名單、零重算） | BE | AC-17, AC-18, AC-19, AC-27（資料側） | `backend/src/reports/report-data.ts`、`backend/test/integration/phase8-report-data.test.ts` | **High**（敏感資料揭露面） | T1 | ~900 行／~160-200k | LEGACY 兩型以 raw SQL 播種；計算引擎 spy 全數零呼叫；金額路徑零算式之結構性掃描；折舊禁列逐欄負向（本人＋管理員）；鍵集 `toEqual` 封閉 |
| **T5** | 列印版 HTML 版型純函式（三型版型、跳脫、樣式、分頁規則） | BE（純函式） | AC-11, AC-12, AC-15（純函式側）, AC-16（(a)(b)） | `backend/src/reports/report-html.ts`、`backend/test/unit/report-html.test.ts` | **High**（XSS ＋ 揭露面 ＋ 版型唯一性） | T4 | ~1100 行／~160-200k | 三型必含項目逐字綠；段序與段—圖對應雙 mutant 必紅；同輸入兩次呼叫 `toEqual`；零 `<script`／零外部資源正則；3 payload × 5 插值點跳脫綠；`@media print` 之桌面提示隱藏規則在場 |
| **T6** | 證明圖片嵌入（storage 讀取 ＋ sharp 降尺寸 ＋ data URI ＋ 缺檔容錯） | BE | AC-13(a) | `backend/src/reports/report-images.ts`、`backend/test/integration/phase8-report-images.test.ts` | Medium | T4 | ~600 行／~140-160k | 長邊上限與不放大雙向測試；缺檔佔位且不中止；日誌零 key；嵌入位元組 ≤ 原圖 |
| **T7** | PDF 渲染器（Playwright 封裝、逾時、校驗）＋ env 擴充 ＋ 相依宣告 | BE | AC-09(a)(b) | `backend/src/reports/pdf-renderer.ts`、`backend/src/config/env.ts`、`backend/package.json`、`backend/test/integration/phase8-pdf-render.test.ts`、`backend/test/unit/env.test.ts` | **High**（新增外部相依 ＋ 執行環境） | T5 | ~700 行／~160-200k | 真實 Chromium 產生合法 PDF；逾時明確錯誤且不懸掛；三個新 env 之 zod 驗證與生產 fail-fast 測試綠；效能量測值記入 Handoff |
| **T7b** | 容器化：Dockerfile 安裝 Chromium ＋ CJK 字型、entrypoint 建立 PDF 目錄、compose env | infra | AC-09(c) | `backend/Dockerfile`、`backend/docker-entrypoint.sh`、`docker-compose.yml` | **High**（部署 ＋ 容器安全 `--no-sandbox`） | T7 | ~120 行／~95-130k | 映像可建置；容器內產生之 PDF **中文非缺字方框**（量測 ＋ 目視雙軌）；`REPORT_STORAGE_ROOT` 目錄由 entrypoint 建立並 `chown appuser`；映像大小增量記入 Handoff |
| **T8a** | storage 金鑰前綴白名單參數化（`att`／`rpt` 封閉集合） | BE | AC-26 | `backend/src/storage/local-volume-storage.ts`、`backend/test/unit/report-storage.test.ts` | **High**（路徑安全守門） | — | ~400 行／~130-140k（重 Lite） | 既有 `storage.test.ts` **零 diff 且全綠**；`rpt` 前綴穿越矩陣全數拒絕；跨實例互拒；預設參數維持 `["att"]` |
| **T8** | 產生端點 ＋ 配號交易 ＋ 冪等 ＋ 失敗補償 ＋ 併發 | BE ＋ DB（寫入） | AC-04, AC-05, AC-06, AC-07, AC-10 | `backend/src/reports/report-service.ts`、`backend/src/reports/routes.ts`、`backend/src/server.ts`、`backend/test/integration/phase8-report-generate.test.ts` | **High**（不可逆產物 ＋ 併發 ＋ 失敗語意） | T2, T4, T5, T6, T7, T8a | ~1250 行／~210-310k | 四種失敗注入零殘留（DB ＋ storage 雙層）；12 輪併發編號集合全等；同申請 2 併發恰一列零孤兒；序號重試 mutant 必紅；「無更新／刪除 `Report` 路徑」結構性斷言綠 |
| **T9** | 查詢與下載端點 ＋ 檔名標頭 ＋ 重下一致 | BE | AC-08, AC-22, AC-23, AC-24（下載／查詢兩列）, AC-27（DTO 側） | `backend/src/reports/routes.ts`、`backend/src/reports/report-service.ts`、`backend/test/integration/phase8-report-download.test.ts` | **High**（授權 ＋ 檔案內容回傳） | T8 | ~900 行／~160-200k | 兩次下載位元組全等且渲染器 spy 零呼叫；`Content-Disposition` 雙形式 wire-level；`\r\n` 注入封閉；改名後檔名不變；檔案遺失 404 不 500 |
| **T10** | 列印端點 ＋ 同一版型斷言 ＋ 授權矩陣 ＋ 狀態守門 ＋ 安全標頭 | BE | AC-15（端點側）, AC-16(c), AC-24（產生／列印兩列）, AC-25 | `backend/src/reports/routes.ts`、`backend/test/integration/phase8-report-print.test.ts` | **High**（授權矩陣 ＋ 側信道） | T8 | ~900 行／~160-200k | 20 格授權矩陣逐格綠；他人草稿 vs 他人已完成回應逐字相同；列印 HTML 與 PDF 用 HTML 全等（另一份模板 mutant 必紅）；四個安全標頭在場 |
| **T11** | 錯誤合約 ＋ `ErrorCode` 結構性斷言 ＋ 日誌安全 | BE | AC-28, AC-29 | `backend/src/platform/errors.ts`、`backend/test/integration/phase8-contract.test.ts` | Medium | T9, T10 | ~850 行／~105-175k | `ErrorCode` 聯集全等（BOGUS mutant 必紅）；四端點錯誤表逐格；七類日誌掃描 ＋ 反向探針 |
| **T12** | 前端：報表 API client ＋ `ReportSection` 元件 ＋ 差旅頁接線 | FE | AC-30, AC-31 | `frontend/src/api/reports.ts`、`frontend/src/components/ReportSection.tsx`、`frontend/src/pages/TravelApplicationPage.tsx`、`frontend/src/index.css`、`frontend/test/ReportSection.test.tsx` | Medium | T9, T10 | ~700 行／~155-195k | 產生失敗零編號零入口之負向斷言綠；草稿不渲染；既有差旅頁測試零弱化 |
| **T13** | 前端：保養／折舊頁接線 ＋ 列印與下載入口 ＋ 五態 | FE | AC-32, AC-33, AC-30（三型面） | `frontend/src/pages/MaintenanceApplicationPage.tsx`、`frontend/src/pages/DepreciationApplicationPage.tsx`、`frontend/src/components/ReportSection.tsx`、`frontend/test/ReportSection.test.tsx`、`frontend/test/MaintenanceApplicationPage.test.tsx`、`frontend/test/DepreciationApplicationPage.test.tsx` | Medium | T12 | ~650 行／~155-195k | 五態各一綠；點下載零 `POST`；`target=_blank` ＋ `rel=noopener`；既有兩頁測試零弱化 |
| **T14** | 列印版面機械驗證（列印媒體量測）＋ 桌面列印提示 | E2E ＋ FE | AC-13(b), AC-14, AC-34 | `e2e/report-print-layout.spec.ts`、`backend/src/reports/report-html.ts`（僅樣式修正範圍） | Medium | T5, T10 | ~700 行／~185-265k | 圖片右緣與文件寬度量測綠；區塊頁索引一致 ＋ 兩兩不重疊；兩個樣式 mutant（移除 `max-width`／`break-inside`）各必紅；提示於列印媒體不可見 |
| **T15** | Gate E2E：三型端到端 ＋ 375px 響應式 | E2E | AC-35, AC-36 | `e2e/report-pdf.spec.ts` | Medium | T13, T14 | ~700 行／~185-265k | 三型情境全綠（大總管親跑於 dev 拓撲）；播種冪等；下載檔名與 `%PDF-` 斷言；草稿無入口負向 |
| **T17（條件）** | 報表編號之關鍵字查詢 | BE | AC-38 | `backend/src/applications/application-query.ts`、`backend/test/integration/phase8-report-keyword.test.ts` | Medium | T8 ＋ **D13 批准** | ~500 行／~140-160k | 三型皆可由編號查得；既有 `keyword` 測試零改動；LIKE 萬用字元跳脫沿既有 `escapeLikePattern` |

> **AC-37（零弱化與基準線）**：不設獨立 Task——寫入**每個 Task 之 Done When**，並由終審以三套件實跑數對照基準線（後端 2573／前端 240／E2E 38）核對。

### 15.1 依賴圖

```
T1 ──┬──▶ T1b
     └──▶ T4 ──┬──▶ T5 ──▶ T7 ──▶ T7b
               └──▶ T6            │
T2 ──▶ T3                         │
T8a ──────────────────────────────┤
                                   ▼
        T2, T4, T5, T6, T7, T8a ──▶ T8 ──┬──▶ T9 ──┐
                                          └──▶ T10 ─┴──▶ T11
                                                     │
                              T9, T10 ──▶ T12 ──▶ T13┤
                              T5, T10 ──▶ T14 ───────┴──▶ T15
                              T8  ──▶ （T17，條件）
```

**TDD 順序建議**：T1（安全網先建立）→ T2／T3／T8a（零接線之純函式與守門，可與 T1 併行排程但**不得同時跑 vitest**）→ T4（資料組裝）→ T5（版型）→ T6（圖片）→ T7／T7b（引擎與容器）→ T8（產生）→ T9／T10（下載與列印、授權）→ T11（合約）→ T12／T13（前端）→ T14／T15（版面與 Gate）。

### 15.2 規模上限自查

| Task | AC 數 | 檔數 | 跨層 | 合規 |
|---|---|---|---|---|
| T1 | 1（AC-01 之七個子項） | 6 | DB only（＋3 既有測試檔之機械連動，均在 6 檔內） | ✅ |
| T1b | 1 | 1 | infra only | ✅ |
| T2 | 2 | 2 | BE only（純函式） | ✅ |
| T3 | 2 | 2 | BE only（純函式） | ✅ |
| T4 | 4 | 2 | BE only | ✅ |
| T5 | 4 | 2 | BE only（純函式） | ✅ |
| T6 | 1 | 2 | BE only | ✅ |
| T7 | 1（AC-09 兩子項） | 5 | BE only | ✅ |
| T7b | 1 | 3 | infra only | ✅ |
| T8a | 1 | 2 | BE only | ✅ |
| T8 | 5 | 4 | BE ＋ DB（寫入新表，無 schema 變更） | ✅ |
| T9 | 5 | 3 | BE only | ✅ |
| T10 | 4 | 2 | BE only | ✅ |
| T11 | 2 | 2 | BE only | ✅ |
| T12 | 2 | 5 | FE only | ✅ |
| T13 | 3 | 6 | FE only | ✅ |
| T14 | 3 | 2 | E2E ＋ BE（僅樣式檔） | ✅ |
| T15 | 2 | 1 | E2E only | ✅ |
| T17 | 1 | 2 | BE only | ✅ |

> **無任何 Task 同時橫跨 FE＋BE＋DB 三層。** T1 為唯一含 schema／migration 之 Task；T7b 為唯一含容器設定之 Task。
> **T14 觸及 `report-html.ts`** 之範圍**限於樣式修正**（`max-width`／`break-inside`／`@media print`），不得改動版型結構或插值邏輯——Packet 須明文限縮。

### 15.3 與 PRD §PHASE-008「初始 Task Graph 概要」之對照

| PRD Task | 本 Spec 落點 | 說明 |
|---|---|---|
| T1 Report 概念模型（編號、產生時間、PDF 引用、版本）＋ migration | **T1 ＋ T1b** | 一致；另納入四處表數連動、AR-1 對照與 drift guard 常設化（跨 Phase 移交項） |
| T2 唯一報表編號產生器（前綴 ＋ 月內唯一 ＋ 冪等）（**High**） | **T2（純函式）＋ T8（配號交易與冪等）** | 拆分：格式語意與併發配號分屬純函式與接線兩層（規模上限） |
| T3 列印版 HTML 版型（三類、多段、圖片排版、多頁） | **T4（資料）＋ T5（版型）＋ T6（圖片）＋ T14（版面驗證）** | 拆分為四（規模上限 ＋ 揭露面獨立守門） |
| T4 Playwright PDF 渲染 ＋ 保存 ＋ 失敗即不標示成功（**High**） | **T7（引擎）＋ T7b（容器）＋ T8（保存與失敗語意）** | 拆分為三（容器變更獨立可回滾） |
| T5 安全檔名產生 | **T3（純函式）＋ T9（標頭與持久化）** | 拆分為二 |
| T6 下載端點（授權、回保存檔、冪等內容）（**High**） | **T9 ＋ T10** | 拆為「下載與查詢」與「列印與授權矩陣」 |
| T7 前端：產生報表／預覽列印／下載入口 | **T12 ＋ T13 ＋ T15** | 拆分（含 E2E） |
| （PRD 未列） | **T8a（storage 前綴白名單）、T11（錯誤合約與日誌）、T17（條件）** | T8a 為 PDF 保存之前置安全守門；T11 沿各 Phase 既有之合約／日誌 Task 慣例；T17 待 D13 裁定 |

**High 風險 Task 清單（須於 Spec Gate 一併取得事前批准）**：**T1、T2、T4、T5、T7、T7b、T8a、T8、T9、T10** 共 **10 項**。

> 與 PRD「High 風險 Task：T2, T4, T6」之差異說明：PRD 之 T2／T4／T6 對應本 Spec 之 T2＋T8（編號）、T7＋T7b＋T8（PDF 渲染與保存）、T9＋T10（下載授權），**三者全數涵蓋**。本 Spec 另將 **T1**（不可逆 migration）、**T4**（敏感資料揭露面）、**T5**（XSS 與版型唯一性）、**T8a**（路徑安全守門）升為 High，依據為 CLAUDE.md「認證、授權、密碼、附件權限相關工作一律 High」與 PHASE-004/005a/006/007 之既有升級先例。**此升級為保守方向（增加人類批准面），不縮減任何既有 High 判定。**

### 15.4 Gate 規劃與走查腳本固化義務（跨 Phase 追蹤 #8）

| Gate | 觸發時點 | 內容 | 走查腳本（**大總管產出**） |
|---|---|---|---|
| **Spec Gate（事前批准）** | 本 Spec 定稿後、任何 Task 開工前 | D1~D16 逐條裁定 ＋ 10 項 High Task 事前批准 ＋ 條件 AC-38 之取捨 | — |
| **Mock Gate（列印版版面）** | T5／T6／T14 完成後（**PDF 引擎與端點可先不完備**） | 人類目視三型列印版版面：欄位齊全、多段依序、圖片可辨識不溢出、多頁不重疊、折舊不出現車價／年限、375px 可讀 | `docs/verification/WALKTHROUGH-PHASE-008-MOCK.md`（step-by-step，含每步預期畫面與判定準則） |
| **整合 Gate（PDF 端到端）** | 全 Task 完成 ＋ reviewer 清零後 | 三型端到端產生／列印／下載；**容器內 PDF 之中文目視確認**；重下一致；失敗情境之畫面不顯示成功 | `docs/verification/WALKTHROUGH-PHASE-008-INTEGRATION.md` |
| **PR 合併批准** | 整合 Gate 通過後 | 人類決策，不授權代行 | — |

---

## 16. 需人類批准之決策點（D1 ~ D16）

> 每條格式：**為什麼要決定** ｜ **選項** ｜ **各選項影響** ｜ **推薦**。
> **凡未裁定者，相關 AC 與實作一律不得開工。**
> 標記 **【High】** 者屬架構／安全／資料／成本／部署面，須於 Spec Gate 明示批准。

### D1 — `Report` 資料模型：單表 vs `Report` + `PdfFile` 兩表　**【High：資料模型 ＋ 不可逆 migration】**

**為什麼要決定**：`DATA_FLOW.md §1` 之概念模型為 `Report 1───1 PdfFile`；落地時是否照建兩表，一經 migration 即為不可逆資產。另需決定 FK 之 `onDelete` 與冪等鍵。

**選項**
- (a) **單表 `Report`**（含 `storageKey`／`fileName`／`byteSize`／`contentHash`），`applicationId` 唯一為冪等鍵，FK `onDelete: Restrict`。
- (b) 照概念模型建 `Report` ＋ `PdfFile` 兩表，1:1。
- (c) 不建新表，將編號與 PDF 資訊塞入三個子表（`TravelApplication` 等）各自欄位。

**影響**
- (a)：一次 `CREATE TABLE`，查詢與冪等最單純；與概念模型有一處差異（須記 §13 同步項）。表數 15→16。
- (b)：多一張表與一次 join，`PdfFile` 無獨立生命週期（隨 `Report` 生滅），屬過度正規化；表數 15→17，四處表數斷言改動更大。
- (c)：三處重複欄位、三份唯一約束、編號序列查詢須 union 三表——與「一個 `Report` 概念」背道而馳，且 PHASE-009 修正版關聯更難表達。**不推薦。**

**推薦**：**(a)**。理由：`PdfFile` 與 `Report` 為嚴格 1:1 且同生共死（§9.1 不變式），拆表只增加 join 與不一致風險；`applicationId` 唯一約束是 BE-US-26⑤「不得重新產生不同編號」的**結構性**保證（不是靠應用層自律）；`onDelete: Restrict` 使「有正式報表之申請不可被刪」成為 DB 層事實。概念模型之差異以 §13 同步項 #6/#7 更新 `DATA_FLOW.md`。

---

### D2 — 報表編號格式、月份時區與序號位數　**【High：使用者可見之永久識別】**

**為什麼要決定**：編號會印在紙本、進報帳流程、被人肉引用，且一經發出即不可更改；「月內唯一」之「月」需要一個明確定義（系統以 UTC 存時間，使用者在台灣）。

**選項**
- (a) `TRV-202608-0001`（前綴 ＋ `YYYYMM` ＋ 4 位序號），月份依 **Asia/Taipei（UTC+8 固定偏移）**。
- (b) 同格式但月份依 **UTC**。
- (c) 含日期之較長格式（如 `TRV-20260806-0001`）。
- (d) 純流水號（如 `TRV-000123`，不含月份）。

**影響**
- (a)：使用者於台北時間月初產生之報表落在「新月」，與直覺一致；需引入本專案**第一個時區常數**（其餘日期皆為 `@db.Date` 日粒度，無時區換算）。
- (b)：實作最單純（零時區邏輯），但台北時間 9/1 08:00 產生之報表編號會是 `202608`，人肉核對時易被誤判為錯誤。
- (c)：日內序號重置，同日多份仍唯一，但編號更長且 US 只要求「月內唯一」。
- (d)：不滿足 US 對「同一月份」語意之直覺，且無法由編號看出期間。

**推薦**：**(a)**。理由：編號是**給人看的**，月份必須與使用者所在時區一致；台灣無日光節約，固定 `+08:00` 偏移不需時區資料庫，以純函式實作（`report-number.ts`）並以四點邊界測試釘死（AC-03(b)）。序號 `padStart(4)`、超過 9999 自然延伸為 5 位（不截斷、不重置），避免人工上限造成的失敗模式。

---

### D3 — 月內唯一之併發保證與冪等機制　**【High：正確性 ＋ 不可逆產物】**

**為什麼要決定**：兩個使用者同時產生同月同型報表時，序號可能重複；同一使用者連點兩次也不得產生兩份。ARCHITECTURE §6 明列此為 PHASE-008 待定案項。

**選項**
- (a) **SERIALIZABLE 交易 ＋ `max(sequence)+1` ＋ `(prefix, period, sequence)` 唯一約束 ＋ 應用層重試（≤5）**；冪等鍵為 `applicationId` 唯一約束。
- (b) PostgreSQL `SEQUENCE`（每月每型一個序列物件，動態建立）。
- (c) 應用層鎖（advisory lock）序列化配號。
- (d) 以 `count(*)+1` 配號，不加唯一約束（僅靠交易隔離）。

**影響**
- (a)：沿 PHASE-003a D4「DB 唯一約束為併發最後防線」之既有先例；重試路徑有明確測試（AC-04(d)）；無額外 DB 物件。
- (b)：序列物件需動態 `CREATE SEQUENCE`（DDL 於執行期），且序列不回滾會產生跳號；migration 與備份還原複雜度上升。
- (c)：advisory lock 為本專案未曾使用之機制，且鎖粒度與逾時語意需另行定義。
- (d)：**不可接受**——無唯一約束時併發下必然出現重複編號，且測試不易穩定重現。

**推薦**：**(a)**。另定案：**配號一律在最後一步（交易內）**，PDF 渲染與寫檔失敗**絕不消耗編號**；冪等鍵為 `Report.applicationId` 唯一（PHASE-009 修正版為新 `Application`，天然取得新編號）。

---

### D4 — PDF 執行環境：Playwright／Chromium 之封裝、字型與啟動策略　**【High：部署 ＋ 成本 ＋ 容器安全】**

**為什麼要決定**：ARCHITECTURE §6 明列「Playwright/Chromium 於後端容器的封裝方式（同容器 vs 伴生 worker）— PHASE-008 Spec 定案」。此決定直接影響映像大小、記憶體、Zeabur 成本與容器安全設定。

**選項**
- (a) **同容器**：後端映像安裝 Chromium ＋ CJK 字型；**每次請求啟動、用畢即關**。
- (b) 同容器但**常駐瀏覽器實例**（lazily 建立，跨請求共用）。
- (c) **伴生 worker 容器**（獨立渲染服務，後端以 HTTP 呼叫）。
- (d) 改用純 JS PDF 產生器（不使用 Chromium）。

**影響**
- (a)：映像 +約 350~450 MB；單次渲染尖峰 RSS +約 150~300 MB；啟動成本約 0.3~0.8 秒（10 秒目標內綽綽有餘）；**無跨請求狀態、無殭屍瀏覽器**；部署拓撲不變（仍三服務）。
- (b)：省下每次啟動時間，但需處理瀏覽器崩潰後之重建、記憶體洩漏與併發 context 管理——為 ~20 人規模引入不必要之狀態。
- (c)：後端映像維持精簡，但**新增第四個服務**（部署、健康檢查、內部認證、成本全部 +1），且需定義 worker 之授權（否則成為未授權渲染入口）。與 ADR-0001 之三服務拓撲相衝。
- (d)：**違反 CLAUDE.md 已確認之技術棧**（「PDF：Playwright (Chromium) 渲染列印版 HTML」），且中文字型與複雜版面支援度差。**不可選。**

**推薦**：**(a)**。**同時定案三項容器細節（皆須批准）**：
1. **CJK 字型必裝**（`fonts-noto-cjk`）——否則容器內 PDF 之中文為缺字方框，且此失敗**在 Windows 開發機上不會出現**（本機有系統字型），屬高機率漏網缺陷，故立 AC-09(c) ＋ Gate 目視雙軌守門。
2. **啟動參數 `--no-sandbox --disable-dev-shm-usage`**——容器內以非 root 執行時 Chromium sandbox 需額外權限；本用途**只載入自己產生、零腳本、零外部資源之 HTML**（AC-16(a) 結構性守門），攻擊面已封閉，故關閉 sandbox 之殘餘風險可接受。**此為安全取捨，須人類明示批准。**
3. **`playwright` 列為後端 runtime dependency**（本專案唯一之新增 npm 套件）。

---

### D5 — 產生失敗之語意、交易順序與新增錯誤碼　**【High：公開 API contract ＋ 不可逆產物】**

**為什麼要決定**：BE-US-27②「PDF 無法完整產生或保存 → 不得標示報表已成功產生」需要一個明確的**步驟順序與補償策略**，以及一個前端可辨識之錯誤碼。

**選項**
- (a) **先渲染 → 寫檔 → 讀回校驗 → 交易內配號並寫列**；任一步失敗即補償刪檔並回 **新增碼 `REPORT_GENERATION_FAILED`（500）＋ `details.stage`**。
- (b) 先在交易內配號寫列（狀態 `PENDING`）→ 渲染 → 成功後改為 `READY`。
- (c) 同 (a) 但沿用既有 `INTERNAL_ERROR`，不新增錯誤碼。

**影響**
- (a)：`Report` 列存在 ⇔ PDF 完整保存（單一不變式，最易測、最易理解）；編號不會被失敗消耗；需新增一個 `ErrorCode`（公開契約 +1）。
- (b)：引入報表狀態機與「殭屍 PENDING 列」之清理問題，且 `PENDING` 列已消耗編號——與 US「不得標示成功」之最簡解相比複雜度大增。
- (c)：前端無法區分「PDF 引擎問題（可重試）」與「未預期程式錯誤」，UX 較差；且 `INTERNAL_ERROR` 依既有慣例是「未處理例外」，用它表達已知失敗會弱化該碼之語意。

**推薦**：**(a)**，並新增 `REPORT_GENERATION_FAILED`（500）＋ `details.stage ∈ {RENDER, STORE, VERIFY, PERSIST}`（封閉值域，不含任何路徑或堆疊）。

---

### D6 — PDF 儲存位置與 storage 金鑰白名單之擴充　**【High：檔案存取安全】**

**為什麼要決定**：現行 `LocalVolumeStorage` 之金鑰白名單**寫死**為 `att/<id>/<suffix>`（`local-volume-storage.ts` :37），PDF 無法使用；而放寬此正則屬安全守門變更。

**選項**
- (a) **建構子參數化封閉前綴集合**（預設 `["att"]`），另建一個 root 為 `REPORT_STORAGE_ROOT`、前綴為 `["rpt"]` 之第二實例。
- (b) 直接把正則改為 `(att|rpt)`，兩用途共用同一實例與 root。
- (c) 為報表另寫一個 storage 實作類別。
- (d) PDF 直接寫入附件之 `att/` 前綴。

**影響**
- (a)：既有 `att` 行為與既有 `storage.test.ts` **零改動**（預設值不變）；兩用途之 root 實體隔離；跨實例互拒可測（AC-26）。
- (b)：單一實例下，附件端點理論上可被誘導讀取 `rpt/` 金鑰（雖 key 來自 DB 而非使用者輸入，但少了一層結構性隔離）。
- (c)：複製一份路徑安全邏輯 = 兩份可能漂移的安全程式碼。**不推薦。**
- (d)：語意混淆，且附件清理排程（PHASE-011）掃描 `att/` 時可能誤刪 PDF。**不可選。**

**推薦**：**(a)**。另定案：`REPORT_STORAGE_ROOT` 預設 `/data/storage/pdf`（compose 與 entrypoint 註解**已預留此路徑**），生產未設即啟動失敗（沿 `ATTACHMENT_STORAGE_ROOT` 之 fail-fast 形狀）；storage key 為 `rpt/<crypto.randomUUID()>/pdf`，**零使用者輸入**。

---

### D7 — 安全檔名規則與「持久化 vs 即時推導」　**【High：使用者可見行為 ＋ BE-US-28】**

**為什麼要決定**：BE-US-28 只給了組成元素與「移除不安全字元」的目標，未定義具體規則；且檔名是否隨使用者改名而變，會影響「重下一致」之語意。

**選項（規則）**
- (a) 組成 `{類型}_{姓名}_{日期或年度}_{編號}.pdf`；`[\\/:*?"<>|]` 與控制字元 → `_`；空白 → `_`；去前後綴 `.` 與空白；姓名段 ≤30 字、整體 ≤120；姓名清理後為空 → `使用者`。
- (b) 全 ASCII 化（類型改為 `TRAVEL` 等、姓名以拼音或移除非 ASCII）。

**選項（時點）**
- (i) **產生時持久化 `fileName`**（凍結）。
- (ii) 下載時即時推導。

**影響**
- (a)：檔名對台灣使用者可讀（`差旅_王小明_2026-03-05_TRV-202608-0001.pdf`），需 RFC 5987 編碼 ＋ ASCII fallback（AC-22）。
- (b)：跨系統最保險，但使用者難以辨識，且 US 明文要求「使用者名稱」。
- (i)：重下永遠一致（AC-23）；改名後舊報表檔名保留當時姓名——**與「報表為當時事實之快照」一致**。
- (ii)：改名後檔名變動，與 FE-US-24②「相同報表編號及相同內容」之精神不合（雖字面只約束內容）。

**推薦**：**(a) ＋ (i)**。`Content-Disposition` 同時提供 ASCII fallback（`{編號}.pdf`）與 `filename*=UTF-8''`，確保任何瀏覽器皆可下載且不致亂碼。

---

### D8 — 列印版之產生位置與四端點之前置中介　**【High：授權面】**

**為什麼要決定**：PRD :459 要求「列印版與 PDF 同一版型」。若列印版由前端 React 渲染、PDF 由後端渲染，兩者將是**兩份版型**（必然漂移），且 Playwright 需登入 SPA 才能截取。另需決定四端點是否套用 `requirePasswordChanged`（既有附件內容端點刻意**未**套用，PHASE-003 D8）。

**選項**
- (a) **後端產生列印版 HTML**（`text/html`），前端以新分頁開啟；四端點**皆**套用 `requireAuth ＋ requirePasswordChanged`。
- (b) 前端 React 列印頁；Playwright 以登入態載入 SPA 產生 PDF。
- (c) 後端 HTML，但比照附件端點只套 `requireAuth`（不擋強制改密）。

**影響**
- (a)：版型**字面上同一份**（AC-15 可用字串全等斷言）；Playwright 走 `setContent`，**零網路、零認證**，最安全也最快；需強制改密之使用者被一致擋下。
- (b)：需在容器內對自己的前端發 HTTP、攜帶 session cookie，或另建無認證渲染路徑（等於開後門）；版型漂移風險高；渲染時間與失敗面大增。**不推薦。**
- (c)：與附件端點一致，但附件之豁免理由是「圖片內嵌於頁面、擋下會使頁面破圖」；報表為主動操作，無此需求，且強制改密者本就不該執行正式操作。

**推薦**：**(a)**。差異點（相對附件端點多擋一層）已於 §6.1 明列，屬**收緊**方向。

---

### D9 — 產生報表是否允許管理員代行　**【High：授權】**

**為什麼要決定**：PHASE-006 D7(a)／PHASE-007 D9(a) 定案「完成申請僅本人」（不可逆狀態轉換）。報表產生同為不可逆產物，是否比照收緊？而 `DATA_FLOW §2.4` 現行文字為「【授權】僅擁有人/管理員」。

**選項**
- (a) **擁有人 ＋ 管理員**（沿 `DATA_FLOW §2.4` 明文與 `assertOwnershipOrAdmin` 慣例）。
- (b) 僅擁有人本人（比照「完成」之收緊）。

**影響**
- (a)：管理員可代員工補產報表（實務常見：員工離職、請假、不熟操作）；管理員本就能讀取全部申請內容與附件，**未擴張其可見面**；報表產生**不改變申請狀態、不改變金額**，與「完成」之性質不同；`generatedById` 記錄操作者以供追溯。
- (b)：更保守，但當擁有人無法操作時報表將無法產生（無代行路徑，也無補救端點，因本 Phase 不提供重產）；且與既有文件明文相衝，需同步修改 `DATA_FLOW`。

**推薦**：**(a)**。理由：產生報表是**既有資料之呈現與封存**，非狀態轉換；`Report.generatedById` 提供追溯；若人類偏好 (b)，僅需改 §6.1 之一格與對應測試，成本低但請於 Gate 明示。

---

### D10 — 報表資訊之讀取介面：獨立端點 vs 併入三型詳情 DTO　**【公開 API contract】**

**為什麼要決定**：FE-US-22③「產生成功 → 使用者查看申請 → 顯示報表編號」需要前端能取得編號。

**選項**
- (a) **獨立端點 `GET /applications/:id/report`**，回 `{ report: ReportDto | null }`。
- (b) 於三型詳情 DTO（`TravelApplicationDto` 等）新增 `report` 欄位。

**影響**
- (a)：三個既有大型 service 檔（`travel-service.ts` 88KB／`maintenance-service.ts` 55KB／`depreciation-service.ts` 70KB）**零改動**，回歸風險最低；前端多一次請求（詳情頁載入時併發送出）。
- (b)：一次請求取得全部；但需改三個 DTO 契約與三份既有測試之鍵集斷言（多處既有測試以 `toEqual` 斷言鍵集，改動面不可低估），且 `reports` 模組會被三個 `applications` 模組反向依賴。

**推薦**：**(a)**。另定案：尚未產生時回 **`200 { report: null }`**（**非 404**），使「未產生」為正常狀態而非錯誤（沿 PHASE-005 統計端點「無資料仍 200」之既有紀律）。

---

### D11 — 草稿申請之報表操作：錯誤碼選擇　**【公開 API contract】**

**為什麼要決定**：FE-US-22② 僅說「拒絕操作」，未指定碼；本 repo 既有之狀態守門（`assertApplicationMutable`）用 `403 FORBIDDEN`。

**選項**
- (a) **`409 CONFLICT` ＋ `details.status`**。
- (b) `403 FORBIDDEN`（沿既有狀態守門先例）。

**影響**
- (a)：與授權失敗（403）明確區分，前端可給「請先完成申請」之精準提示；需確保**授權判定先於狀態判定**，否則他人草稿回 409 會洩漏狀態（本 Spec 已以 AC-25 側信道測試釘死）。
- (b)：與既有先例一致，但「無權限」與「狀態不對」共用同一碼，前端只能靠訊息字串區分；對本人自己的草稿顯示「無權限」易造成誤解。

**推薦**：**(a)**，並以 AC-25 之側信道測試保證他人草稿仍先以 403 收斂（無資訊洩漏）。若人類偏好一致性而選 (b)，僅需改錯誤表一列與對應測試。

---

### D12 — 折舊報表之揭露面（Q8 裁定之落地確認）　**【敏感資料；已有裁定，此處為落地核對】**

**為什麼要決定**：PHASE-007 §20.16 #19 已載明人類 Q8 裁定「PHASE-008 折舊報表改採五值揭露面，不呈現車價與折舊年限」。本條供 Gate **核對落地形狀**，非重新開放討論。

**落地形狀**：AC-18（正向五值 ＋ 逐欄負向 ＋ 全身分一致 ＋ 對帳以三來源值重算、不呈現 4dp `rawAmount`）；型別層以封閉白名單 `DepreciationReportBody` 承載（§7.3）。

**推薦**：**照此落地**。若人類此刻改變主意（例如希望管理員版報表含車價），須明示，因為那將**擴大**揭露面並需重寫 AC-18(b)。

---

### D13 — FE-US-05④「報表編號關鍵字查詢」是否納入本 Phase　**【範圍】**

**為什麼要決定**：`PROJECT_STATE.md` 跨 Phase 追蹤列有「FE-US-05 報表編號關鍵字查詢於 PHASE-008 後完整驗收」，文義可解為「於 008 實作」或「008 之後再驗收」；PRD :458 之對應 US 清單**未列** FE-US-05。實查現況：`application-query.ts` :327-330 之 `keyword` **僅**比對差旅 `purpose`，三型報表編號皆無法查得。

**選項**
- (a) **納入本 Phase**（新增 T17，~500 行）。
- (b) 不納入，記為跨 Phase 追蹤，待 PHASE-009 或 PHASE-010 處理。

**影響**
- (a)：FE-US-05 於本 Phase 完整達成；改動既有 `application-query.ts` 之 `where` 組裝（既有列表測試需確認零回歸）；範圍略超 PRD 之 US 清單。
- (b)：本 Phase 結束後 FE-US-05④ 仍未達成，追蹤列繼續存在；使用者拿到編號卻搜不到，體驗有缺口。

**推薦**：**(a)**。理由：報表編號在本 Phase 才首次存在，此刻補齊成本最低（一個小 Task）；且「搜得到自己剛拿到的編號」是使用者的直覺期待。**未獲批准前 AC-38 維持 `BLOCKED`、T17 不派工。**

---

### D14 — 作廢／修正版相關 US 條文延後至 PHASE-009 之確認　**【範圍】**

**為什麼要決定**：FE-US-23⑤（作廢標示與原因）、BE-US-27④（修正版保存新 PDF）、BE-US-27⑤（作廢後保留原始內容與可辨識作廢狀態）三條屬本 Phase 之 US，但 PRD :457 逐字將其劃入 PHASE-009。

**選項**
- (a) **照 PRD 延後**：本 Phase 不實作作廢版型；`VOIDED` 於現行系統結構性不可達，預先實作將是不可測之投機程式碼。以 §7.6-3 之介面約束確保 009 之改動為局部。
- (b) 本 Phase 先實作作廢標示版型（以人工播種 `VOIDED` 列測試）。

**影響**
- (a)：與 PRD 一致；三條 US 之落地義務明確移交 009（§17.2）。
- (b)：需以 raw SQL 播種一個**系統無法產生**的狀態來測試，且 009 之作廢原因／操作者／時間欄位尚不存在——版型將建立在猜測的資料形狀上，屆時大機率重寫。

**推薦**：**(a)**。此為 PRD 既有劃分之確認，非新裁量。

---

### D15 — 報表產生是否寫入稽核事件　**【稽核可追溯性】**

**為什麼要決定**：BE-US-31／AD-US-14 之稽核事件清單（帳號新增／停用／密碼重設／代操作／作廢／參數異動）**未列**報表產生；但管理員代行產生（D9(a)）屬「代操作」性質。

**選項**
- (a) **不新增稽核事件**；以 `Report.generatedById` ＋ `generatedAt` 提供最小追溯。
- (b) 新增 `AuditAction.REPORT_GENERATED`，僅於**管理員代行**時寫入（比照 `APPLICATION_CREATED_ON_BEHALF` 之語意）。
- (c) 每次產生皆寫稽核（含本人）。

**影響**
- (a)：零 enum 異動（AC-01(e) 之「零 enum 異動」得以成立）、零額外寫入；追溯資訊已存於 `Report` 列本身。
- (b)：與既有「代操作留稽核」之紀律一致；需新增 enum 值（migration 由純 `CREATE` 變為含 `ALTER TYPE`，**FW-8 之 raw SQL 型處置隨之適用**，T1 成本上升）；PHASE-010 稽核頁需多顯示一類。
- (c)：報表產生為冪等且每申請至多一次，稽核量不大，但與 US 清單不符（過度）。

**推薦**：**(a)**。理由：US 未要求；`Report` 列本身即含操作者與時間，追溯能力不缺；避免為此在本 Phase 引入 enum 異動而使 migration 型態複雜化。**若人類重視「管理員代行留痕」，選 (b) 亦合理——請於 Gate 明示，因為它會改變 T1 之 migration 型態與 AC-01(e)。**

---

### D16 — 證明圖片之嵌入策略　**【使用者可見輸出品質 ＋ 效能】**

**為什麼要決定**：FE-US-23③ 要求「圖片應保持可辨識」，而附件單檔上限 10 MB；直接嵌入原圖之 base64 會使 HTML 膨脹（5 張 × 10 MB ≈ 67 MB），威脅 10 秒目標與記憶體。

**選項**
- (a) **以既有 `sharp` 降尺寸為列印用派生圖**（長邊上限 `REPORT_IMAGE_MAX_PX`，預設 1600；不放大小圖；不持久化），以 `data:` URI 嵌入。
- (b) 直接嵌入原圖 base64。
- (c) 嵌入既有縮圖（`thumbnailKey`，長邊 512）。
- (d) 於 HTML 中以 `/attachments/:id/content` 之 URL 參照（不嵌入）。

**影響**
- (a)：每張約 200~400 KB；1600px 對 A4 寬度（約 190 mm）≈ 210 dpi，Google Maps 截圖之文字清晰可辨；產生時間可控。
- (b)：可能觸發 10 秒逾時與記憶體尖峰；PDF 檔案巨大（下載慢、volume 消耗大）。
- (c)：512px 於 A4 寬度僅約 68 dpi，**地圖文字不可辨識**——違反 FE-US-23③。
- (d)：Chromium 需發網路請求並攜帶 session cookie（`setContent` 無 cookie 上下文），須開放無認證路徑或注入 cookie——**引入授權風險**，且列印版於瀏覽器可用不代表 PDF 可用。**不可選。**

**推薦**：**(a)**。`REPORT_IMAGE_MAX_PX` 以 env 提供（預設 1600），Gate 目視若認為不足可調整而不需改程式。

---

## 17. 已知限制與跨 Phase 銜接

### 17.1 已知限制（本 Phase 明示不處理者）

1. **「多頁不重疊」之驗證域**：於 DOM ＋ 列印媒體模擬驗證（同一 Chromium 排版引擎），**非**於 PDF 位元組層解析驗證——後者需新增 PDF 解析相依。PDF 層以完整性（magic bytes／長度／雜湊）與 Gate 目視覆蓋。（§11.4 方法論說明）
2. **10 秒效能目標之測試穩定性**：整合測試於 CI 硬體之實測值未知；若變紅，正解為 **Spec 修訂**（記錄實測與新門檻），**不得**由 implementer 自行放寬或 skip。
3. **無渲染佇列與併發上限**：多人同時產生報表時，多個 Chromium 實例並存之記憶體尖峰無應用層節流（~20 人規模下可接受）。若 PHASE-011 效能驗證發現問題，再引入佇列。
4. **無報表重產／刪除路徑**：內容有誤只能走 PHASE-009 之修正版。此為刻意設計（保存不可變），非疏漏。
5. **`REPORT_IMAGE_MAX_PX` 之視覺品質**為經驗值（1600px ≈ 210 dpi），未經人類目視確認前不視為定案——Mock Gate 之判定項之一。
6. **列印版之瀏覽器差異**：`@page`／`break-inside` 於各瀏覽器列印引擎表現略有差異；本 Spec 之機械驗證以 Chromium 為準（與 PDF 一致），其他瀏覽器之列印外觀屬盡力而為。
7. **孤兒 PDF 檔案之清理**：本 Phase 之失敗路徑會主動補償刪檔，但若程序於「寫檔成功、補償前」被強制中止，仍可能留下孤兒檔。清理排程屬 PHASE-011（與附件 TTL 清理同批）。

### 17.2 與 PHASE-009／010／011 之銜接

| 目標 Phase | 移交事項 |
|---|---|
| **PHASE-009** | ①**FE-US-23⑤／BE-US-27⑤**：作廢報表之作廢標示與原因——於 `ReportData` 新增欄位 ＋ `report-html.ts` 新增一段版型（§7.6-3）；②**BE-US-27④**：修正版完成後產生新報表——**零程式變更即成立**（修正版為新 `Application`，冪等鍵 `applicationId` 天然給出新編號與新 PDF），但須以測試**實證**原 `Report` 與其 PDF 位元組未被觸碰；③修正版之版本關聯顯示於報表（若 009 需要）；④**折舊修正版須複製 `applicationYear` 與 `annualTotalKm` 後重算**（PHASE-007 §20.16 #19 之既有移交項，續存） |
| **PHASE-010** | 若 D15 選 (b)，稽核檢視頁需納入 `REPORT_GENERATED`；否則報表產生之追溯以 `Report.generatedById`／`generatedAt` 為準，稽核頁不涉及 |
| **PHASE-011** | ①孤兒 PDF 之清理排程（與附件 TTL 清理同批）；②PDF 產生之效能實測與必要之佇列／併發上限；③備份還原驗證須涵蓋 `rpt/` 前綴（NFR-US-12／13 已列 PDF）；④`Report` 表之索引評估（目前僅 `(numberPrefix, numberPeriod)`） |

### 17.3 已於本 Phase 結清之跨 Phase 追蹤項

| 項目 | 結清方式 |
|---|---|
| **AR-1**：`RATIO_DISPLAY_SCALE` ↔ `snapshotRatio` DDL scale 對照測試 | AC-01(g)（T1），折舊與保養各一格 ＋ 雙側 mutant |
| **drift guard 升常設 infra 測試** | AC-01(h)（T1b），新建不綁 Phase 之常設測試檔 |
| **FE-US-05④ 報表編號關鍵字查詢** | 依 D13 裁定（推薦納入，AC-38／T17） |
| **ARCHITECTURE §6 開放問題兩條**（Playwright 封裝方式、編號併發安全） | 依 D4／D3 裁定；§13 同步項 #4 移出開放問題 |

---

## 18. Spec 修訂紀錄

| 日期 | Task ID | 內容 | 批准依據 |
|---|---|---|---|
| 2026-08-06 | `PHASE-008-SPEC` | 初版 DRAFT：§0~§19 全文；38 條 AC（含 1 條條件 AC）、19 個 Task（含 1 個條件 Task）、16 個決策點、34 條邊界條件、20 格授權矩陣、AC↔測試映射表 **43 列**（38 條 AC，其中 AC-01／AC-09／AC-13 各拆為子項列；42 列 `PENDING`、1 列 `BLOCKED`） | 待 Spec Gate |
| 2026-08-06 | —（大總管白名單） | **Spec Gate 通過（固化）**：人類 leonchih 2026-08-06 經 AskUserQuestion 三問**全數照推薦**——①**D1~D16 全數照推薦批准**（含 D13 AC-38 納入→該列 `BLOCKED` 解除轉 `PENDING`、D14 三條 US 照 PRD 延後 009、D15 不新增稽核、D16 sharp 降尺寸嵌入）；②**D4 三項附帶批准**：CJK 字型必裝、**Chromium `--no-sandbox` 之安全取捨明示接受**（依據＝渲染內容 100% 自產零腳本零外部資源＋AC-16(a) 結構性守門；防禦層減一已明示）、playwright 列 runtime 依賴（映像 +350~450MB 成本已明示）；③**High Task 10 項一併事前批准**（T1/T2/T4/T5/T7/T7b/T8a/T8/T9/T10）。狀態欄轉 **`ACTIVE`**。**併記勘誤**：文件頭 Governance-Version 初版誤植 `2026-08-05.1`，更正為現行 `2026-08-04.1`。兩項資訊缺口（Zeabur 上限／CI 硬體）人類未補充——依 Spec 既定處置進行（AC-09(a) 變紅須走 Spec 修訂不得靜默弱化）。檢核過程見 `docs/verification/WALKTHROUGH-PHASE-008-SPEC-GATE.md`。 | 人類 leonchih 2026-08-06（AskUserQuestion 三問全數照推薦） |
| 2026-08-06 | —（大總管白名單） | **T1 完成＋即審 APPROVE（固化＋勘誤）**：T1（`9586646`）落地 AC-01(a)~(g)，reviewer 重驗證級即審 **APPROVE**（0 Must／0 Should／5 AR／6 FW；12 自選 mutant 親手重現 10 殺——3 存活者皆 AC 字面外、TDD 10/19 紅獨立重放逐數相符、§8.1 逐欄三路斷言核對、範圍零夾帶）。**勘誤 a**：§8.5 表數斷言實查為**五處**非四處（第五處＝phase7-migration-safety 之 R1 M2 段 15 斷言；implementer 據實回報後依 T1R-LITE 先例同 commit 處置、大總管與 reviewer 雙判未越權；§8.5 正式補列併下次 Spec 修訂）。**FW-1 承接裁定**：§11.2 末列「刪除守門回歸」（有報表之使用者刪除仍 409、history.ts 零 diff 結構性斷言）原無 Task 承接且 §12 無列——**併入 T1b**，§12 補列義務同批。AR-1/AR-2（破壞性 DML 掃描缺口、datetime_precision/column_default 未涵蓋）依 reviewer 建議由 T1b 常設 guard 承接（涵蓋全部 migration 優於補單檔）。AR-3：§12 AC-01 三列實名回填併結案 DOC-SYNC（PHASE-007 先例）。AR-5：INFRA-001.md「11 張業務表」過時（005a 起既存）記文件 Lite 候選。 | reviewer PHASE-008-T1-REVIEW（APPROVE）；大總管 2026-08-06 |

---

## 19. PRD 建議修正清單（**本 Task 未編輯 `docs/PRD.md`**）

| # | 位置 | 建議 | 理由 |
|---|---|---|---|
| 1 | PRD :458「對應 US」 | 若 D13 批准，補列 **FE-US-05**（次要關聯：報表編號關鍵字查詢） | 本 Phase 首次使報表編號存在，該 US 條文於此才可能達成 |
| 2 | PRD :464-471「初始 Task Graph 概要」 | 補列 **storage 前綴白名單**（T8a）、**錯誤合約與日誌**（T11）、**容器化與字型**（T7b）三項 | 三者為 PDF 保存之必要前置與既有各 Phase 之慣例 Task，PRD 概要未涵蓋 |
| 3 | PRD :472「High 風險 Task」 | 由「T2, T4, T6」擴充為本 Spec §15.3 之 10 項對照 | 依 CLAUDE.md「授權／附件權限一律 High」與既有升級先例 |
| 4 | PRD :473「Rollback 概要」 | 補記「容器變更（Dockerfile／compose／entrypoint）與程式變更須同批發布，不得只回滾其一」 | §14 之發布約束 |
| 5 | PRD :459「AC 摘要」 | 補記「列印版為自足文件（零腳本、零外部資源）且所有插值須跳脫」 | 本 Spec 新增之安全 AC（AC-16），US 未明文但屬必要之安全底線 |

---

**（Spec 全文結束。狀態 `DRAFT`；經人類 Spec Gate 批准 D1~D16 與 10 項 High Task 後，由大總管將狀態欄改為 `ACTIVE` 並開始派工。）**
