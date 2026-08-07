# PHASE-009 — 作廢與修正版

- Governance-Version: 2026-08-04.1（勘誤：初版誤植 2026-08-05.1，與 PHASE-008 同型誤植，大總管於 Spec Gate 固化時更正）
- 狀態：**`ACTIVE`**（人類 leonchih 2026-08-07 Spec Gate 通過：D1~D16 全數裁定＋13 項 High Task 事前批准——見 §18）
- 建立日期：2026-08-07
- Task ID：`PHASE-009-SPEC`
- Base Commit：`ac56f20`（branch `phase-009`，自 `phase-008` 尖端切出；PHASE-008 已終審 APPROVE，待晨間合併後 rebase 至 `main`——本 Spec 一律以 **008 完成後之現實**為基底）
- 上游（優先序依 `CLAUDE.md`）：人類確認決策 → `userstory.md` → `docs/PRD.md` :480-499 → `docs/ARCHITECTURE.md`／`docs/DATA_FLOW.md`／ADR → 現行實作
- 風險等級：**High**（作廢為不可逆狀態轉換、影響金額與里程統計、影響參數引用保護、涉及授權面與代操作、涉及既有不可變報表產物）

> **Blocking Unknowns**：**無**（無任何足以阻止 Spec 定稿之未知；下列兩項為**待人類裁定之決策點**，非未知資訊，已逐條列於 §16）。
>
> **資訊缺口（不阻塞 Spec，但影響 D4／D15 之裁定品質，建議 Gate 時人類補充）**：
> 1. **作廢後之正式 PDF 是否須帶作廢標示**——`userstory.md` BE-US-22④「應提供保留作廢標示的正式報表」與 BE-US-27⑤「應保留原始內容及可辨識的作廢狀態」兩條之字面，與 PHASE-008 已落地之「PDF 位元組不可變、下載端點零渲染」紀律存在張力（§16 D4 已列三選項與各自代價，含**會連動修改 PHASE-008 已批准 AC** 之選項）。**spec-writer 不得自行折衷**。
> 2. **原申請與其修正版之統計重複計入風險**——US 未要求「建立修正版後自動作廢原申請」，故兩筆已完成申請將**同時**被里程與金額統計計入（§16 D15）。此為產品語意問題，須人類明示取捨。
>
> **技術棧疑義**：**無**。spec-writer 實查：作廢與修正版所需之全部技術面（狀態機、交易、稽核 hook、storage 抽象、Playwright 渲染器、`sharp`）皆已於 PHASE-002~008 落地並在場，本 Phase **零新增 npm 依賴、零新增外部服務、零容器變更**。

---

## 0. 導讀與逐字依據

### 0.1 PRD §PHASE-009 逐字為綱（`docs/PRD.md` :480-499）

| PRD 條目 | 逐字內容（節錄） | 本 Spec 落點 |
|---|---|---|
| 標題（:480） | 「PHASE-009 — 修正版與作廢」（Packet 稱「作廢與修正版」，**同一 Phase，僅語序不同**；本 Spec 標題沿 Packet，內容以 PRD 為準） | 全文 |
| 目標（:482） | 「已完成申請建立修正版（複製為新草稿、原不可變、保存新舊版本關聯、修正版報表用新編號、原 PDF 不覆寫）；作廢（二次確認 + 必填原因、已作廢不可復原、作廢後排除統計、作廢報表保留可辨識作廢標示）；管理員可對任一使用者執行；稽核記錄作廢/修正版」 | §1.1、§2 B~F |
| Out of Scope（:483） | 「無新申請類型。作廢對統計的排除規則於 PHASE-005 已預留（依「未作廢」過濾），本 Phase 使作廢動作真正存在並回歸驗證」 | §1.2、§2 D（AC-16／AC-17） |
| 對應 US（:484） | 「FE-US-25, 26；AD-US-09, 10；BE-US-21, 22；FE-US-23（作廢列印標示）, FE-US-24（作廢 PDF）擴充；BE-US-27（作廢 PDF 保留）擴充」 | §0.2 溯源表 |
| AC 摘要（:485） | 「建修正版→新草稿複製原資料、原不被改動、保存版本關聯、完成產生新報表編號、原 PDF 不覆寫；作廢須二次確認與非空原因、空原因拒絕、作廢後顯示原因/操作者/時間、不得恢復為已完成、統計/計算不納入作廢；作廢且已有 PDF 下載時保留作廢標示；管理員作廢記錄管理員身分/時間/原因並寫稽核」 | §2 全節逐條展開 |
| UI 驗收（:486） | 「Mock Gate（修正版/作廢確認流程與作廢標示）+ 整合 Gate」 | §15.4 Gate 規劃 |
| Human Gate（:489） | 「事前批准（High：不可逆狀態轉換/授權）+ Mock Gate + 整合 Gate」 | §16 |
| High 風險 Task（:498） | 「T2–T6」（PRD 概要編號） | §15.3 對照 |

### 0.2 US → AC 溯源總表（**每條 US 驗收條件逐條有落點，無遺漏**）

| US | 驗收條件（逐條摘要） | 本 Spec AC |
|---|---|---|
| **FE-US-25**（建立修正版） | ①查看自己的已完成申請→選「建立修正版」→建立新草稿並複製原申請資料 | AC-09, AC-10, AC-14, AC-32 |
| | ②修正版草稿修改內容→原申請不得被改動 | AC-11 |
| | ③修正版完成並產生報表→查看新舊紀錄顯示兩者版本關係 | AC-12, AC-32 |
| | ④修正版產生正式報表→應使用新的報表編號 | AC-15 |
| **FE-US-26**（作廢已完成申請） | ①查看自己的已完成申請→點「作廢」→顯示二次確認及作廢原因欄位 | AC-29 |
| | ②未填寫作廢原因→嘗試確認→拒絕 | AC-03, AC-29 |
| | ③作廢成功→返回列表→顯示「已作廢」 | AC-30, AC-35 |
| | ④已作廢→查看詳細資料或報表→顯示作廢原因、操作者及作廢時間 | AC-04, AC-20, AC-30 |
| | ⑤已作廢→嘗試恢復為已完成→系統不得提供此功能 | AC-05, AC-31 |
| **AD-US-09**（替使用者建立修正版） | ①申請已完成→管理員建立修正版→建立屬於**原使用者**的新草稿 | AC-09, AC-23（修正版列） |
| | ②管理員編輯修正版→保存資料→記錄管理員為實際操作者 | AC-09（`createdById`）, AC-26 |
| | ③修正版完成並產生正式報表→查看版本關係→顯示原紀錄與修正版關聯 | AC-12, AC-15 |
| **AD-US-10**（作廢任一使用者申請） | ①狀態為已完成→管理員執行作廢→要求二次確認及作廢原因 | AC-03, AC-29 |
| | ②管理員未填寫原因→提交作廢→拒絕 | AC-03 |
| | ③作廢成功→查看申請→顯示管理員身分、作廢時間及原因 | AC-04, AC-30 |
| | ④申請已作廢→系統執行里程或金額統計→不得納入該筆資料 | AC-16, AC-17 |
| **BE-US-21**（建立修正版關聯） | ①已完成建立修正版→建立新草稿→保存新舊版本關聯 | AC-12 |
| | ②修正版完成→查詢原申請→能顯示後續修正版 | AC-12 |
| | ③原申請已有正式報表→修正版產生報表→建立新的報表編號 | AC-15 |
| | ④修正版存在→查看原 PDF→原 PDF 內容不得被覆寫 | AC-11, AC-15 |
| **BE-US-22**（作廢申請） | ①已完成→合法使用者或管理員提交作廢原因→狀態改為已作廢 | AC-02, AC-04, AC-23（作廢列） |
| | ②作廢原因為空白→提交作廢→拒絕 | AC-03 |
| | ③申請已作廢→執行里程、保養或折舊計算→不得納入 | AC-16, AC-17 |
| | ④申請已作廢且已有 PDF→使用者下載→提供**保留作廢標示**的正式報表 | **AC-21**（依 §16 **D4** 裁定） |
| **FE-US-23⑤**（PHASE-008 D14 延後） | 報表已作廢→開啟列印版→顯示明確作廢標示及作廢原因 | AC-19, AC-20, AC-22 |
| **BE-US-27④**（PHASE-008 D14 延後） | 修正版完成→產生正式報表→保存新的 PDF | AC-15 |
| **BE-US-27⑤**（PHASE-008 D14 延後） | 報表已作廢→保留正式 PDF→保留原始內容及可辨識的作廢狀態 | **AC-21**（依 §16 **D4** 裁定） |
| **BE-US-05**（管理申請狀態；第 3、4 條） | ③申請已完成→建立修正版→建立新的草稿版本 | AC-09 |
| | ④申請已作廢→嘗試恢復為已完成→拒絕 | AC-02, AC-05 |
| **BE-US-31**（重要操作稽核；第 2 條） | ②使用者或管理員作廢申請→記錄作廢原因、操作者及時間 | AC-24, AC-25, AC-26 |
| **AD-US-14**（查看基本稽核紀錄；第 1 條之「作廢」） | 管理員執行……作廢……→產生稽核紀錄 | AC-24, AC-26（**寫入**面；集中檢視面屬 PHASE-010） |
| **FE-US-21④**（管理草稿附件；第 4 條） | 已完成申請的附件有誤→使用者需要修正→系統應提供建立修正版功能 | AC-14, AC-32 |
| **AD-US-08③**（修改使用者草稿；第 3 條） | 使用者申請已完成→管理員嘗試直接修改→拒絕並**提供建立修正版選項** | AC-32（前端文案與入口；後端拒絕為既有行為，AC-37 回歸） |
| **BE-US-30③**（區間公務里程） | 差旅為草稿或已作廢→計算期間公務里程→不得納入 | AC-16 |
| **BE-US-15②/③**（年度公務里程） | 差旅已完成且未作廢才納入 | AC-17 |
| **BE-US-19④**（管理參數版本） | 參數或油耗資料已有歷史申請引用→不得覆寫被引用的歷史內容 | **AC-18**（依 §16 **D2** 裁定） |
| **FE-US-04③**（個人首頁列表） | 一筆申請為草稿、已完成或已作廢→顯示對應狀態 | AC-30（**已作廢首次真實可達**之回歸） |
| **FE-US-05⑤**（篩選個人申請紀錄） | 選擇申請類型及狀態→同時符合所有條件 | AC-30（狀態＝已作廢之真實資料回歸） |
| **NFR-US-10**（附件存取安全） | 附件之授權與生命週期 | AC-14（修正版附件之擁有人與授權面不變） |

> **US 原意保護聲明**：本 Spec **未改變任何 US 之原意**，亦未刪減任何 US 驗收條件。凡本 Spec 判定「US 字面與既有已批准架構存在張力」者（僅 BE-US-22④／BE-US-27⑤ 一組），**一律不由 spec-writer 折衷**，而是完整列為 §16 **D4** 之選項與代價交人類裁定；在裁定前 AC-21 標記為**條件 AC**（`PENDING（Spec Gate 2026-08-07 裁定後解鎖）`），相關 Task 不得開工。

### 0.3 跨 Phase 追蹤義務核銷表（Packet 十項，逐項核銷）

| # | Packet 條目 | 本 Spec 處置 | 落點 |
|---|---|---|---|
| 1 | **D8(a) 硬約束**（作廢以 `status=VOIDED` **取代** `COMPLETED`、mileage-engine 過濾條件連動、真實作廢流程回歸 PHASE-005 AC-04） | **納入 AC ＋ 設計硬約束**：AC-02 明文「作廢為狀態**取代**，不得改為與已完成正交之旗標」；`mileage-range.ts`／`mileage-engine.ts` 本 Phase **零 diff**（AC-16 明列）；AC-16／AC-17 以**真實作廢端點**（非 raw SQL 直寫）重跑 005／006／007 之排除斷言 | AC-02, AC-16, AC-17, §8.6 |
| 2 | **T10 FW 人類裁定項**（VOIDED 後 `status=COMPLETED` 過濾器使已作廢申請之引用被判「無引用」可覆寫；A3 由防禦變載重） | **列為決策點 ＋ 條件 AC**：§16 **D2**（三選項、影響、推薦 (a) 納入 VOIDED）；AC-18 依裁定落地，含**差旅五型別與折舊**同型一併 | **D2**, AC-18, T8 |
| 3 | **§17.2 複用義務三項**（作廢標示欄＋版型段／修正版零程式變更之位元組不變實證／折舊修正版複製 `applicationYear`·`annualTotalKm` 重算） | **逐項納入 AC**：①`ReportData` 新增作廢欄位 ＋ `report-html.ts` 新增一段版型（AC-19／AC-20）；②修正版之「原 `Report` 與其 PDF 位元組未被觸碰」以**逐位元組雜湊比對**實證（AC-11(c)／AC-15(c)）；③折舊修正版複製該二欄後**由既有完成流程重算**（AC-10 折舊列 ＋ AC-15） | AC-10, AC-11, AC-15, AC-19, AC-20 |
| 4 | **機械連動預授權**（`ReportData` 擴欄 → AC-27 鍵集封閉 ＋ `PHASE_008_SRC_FILES` 九檔清單必紅；Task 拆分時預授權同批修改，沿 T11b／R1b 先例） | **明文寫入 Task 列**：§15 T10／T12 之「機械連動預授權」欄逐檔列出（`phase8-report-data.test.ts` 鍵集列、`phase8-contract.test.ts` 之 `PHASE_008_SRC_FILES`）；另**新增本 Phase 專屬之三類連動**（Application 欄位集合、`AuditAction` enum 基線、業務表數）並同樣預授權 | §15 各 Task「機械連動」欄、§8.5 |
| 5 | **AR-7**（`upload-service.ts` :298／:309 同型洩漏——比照 AR-4 修法納入本 Phase Task） | **納入 chore Task**：AC-38（依 §16 **D14**）；修法沿 AR-4 既有形狀，並將 `logStream` 敏感掃描**擴及上傳路徑** | **D14**, AC-38, T18 |
| 6 | **`report-data.ts` :253 tiebreaker 守門**（觸檔必補） | **納入 AC**：AC-39——本 Phase T10 必觸 `report-data.ts`，故同批補「`id asc` 恰兩處」之結構斷言 ＋ **保養／折舊路徑**之 tiebreaker 行為測試（既有僅差旅覆蓋） | AC-39, T10／T18 |
| 7 | **Type0/CID 敘述更正**（`print-layout` 檔頭 ＋ PHASE-008 §11.4——記載型微更正） | **拆為兩半**：①`e2e/report-print-layout.spec.ts` **檔頭**之更正納入 AC-40／T18（本 Phase 可寫）；②**PHASE-008 §11.4 本體**之更正**不在本 Task 之 Allowed 檔案**（唯一可寫為本檔），移交大總管另派 `SPEC-REV-008` Lite | AC-40, §17.2, §19 |
| 8 | **`buildErrorBody` 繞道回歸 `AppError` 候選** | **列為決策點 ＋ chore AC**：§16 **D14**（納入與否）；若納入＝AC-40 之一部（`reports/routes.ts` 之 `REPORT_GENERATION_FAILED` 改由 `AppError` 承載，wire 格式逐字不變之回歸斷言） | **D14**, AC-40, T18 |
| 9 | **D15 稽核 enum 議題**（009／010 再議） | **本 Phase 結論性處理**：§16 **D10**——BE-US-31② 明文要求「作廢」須留稽核（含**本人**作廢，非僅代操作），既有 `AuditAction` 無合適值，故推薦新增 **`APPLICATION_VOIDED`** 一個值；連帶 migration 由純 `CREATE` 變為含 `ALTER TYPE`（**FW-8 之 raw SQL 型 fixture 處置隨之適用**，T1 成本上升，已計入預算帶） | **D10**, AC-01(e), AC-24, T1 |
| 10 | **D14 延後三條 US**（FE-US-23⑤／BE-US-27④⑤）折入本 Phase | **逐條有落點**：FE-US-23⑤→AC-19／AC-20／AC-22；BE-US-27④→AC-15；BE-US-27⑤→AC-21（條件 AC，依 D4） | §0.2 溯源表末三列 |

---

## 1. 目標與非目標

### 1.1 目標

Phase 結束時，人類可對**任一類已完成申請**（差旅／保養／折舊）走完兩條主線：

**作廢線**
1. 於申請詳情頁點「作廢」→ 出現**二次確認**對話框與**必填作廢原因**欄位；原因留空（或僅空白字元）時**前端拒絕送出、後端亦拒絕**。
2. 確認後 → 申請狀態由「已完成」**變為**「已作廢」，同時保存作廢原因、操作者與作廢時間；**稽核留痕**。
3. 回到列表 → 該筆顯示「已作廢」；詳情頁為**唯讀**，顯示作廢原因／操作者／時間，且**畫面上不存在任何可恢復為已完成的操作**。
4. 期間公務里程、保養期間公務里程、年度公務里程與金額統計**自此不再納入該筆**（以**真實作廢流程**回歸驗證，非測試直寫 DB）。
5. 若該筆已產生正式報表：列印版顯示**明確作廢標示與作廢原因**；PDF 下載之作廢語意依 §16 **D4** 之裁定落地。
6. 管理員可對**任一使用者**之已完成申請執行同一流程，稽核記錄管理員身分／時間／原因。

**修正版線**
1. 於已完成申請詳情頁點「建立修正版」→ 系統建立一筆**新的草稿**，複製原申請之業務欄位（含證明附件，依 §16 **D6** 裁定）；**原申請逐欄未被改動**。
2. 新草稿可正常編輯、完成；完成後產生正式報表 → **新的報表編號與新的 PDF**，**原 `Report` 列與其 PDF 位元組逐位元組未被觸碰**。
3. 新舊兩筆互相看得到**版本關係**（原 → 修正版、修正版 → 原）。
4. 管理員可替使用者建立修正版：新草稿之**擁有人為原使用者**、**實際操作者記為管理員**，並寫稽核。

### 1.2 非目標（Out of Scope）

| 項目 | 理由與落點 |
|---|---|
| **新的申請類型** | PRD :483 逐字「無新申請類型」 |
| **稽核檢視頁** | PHASE-010（AD-US-14）。本 Phase 只負責**寫入**作廢稽核事件與代操作稽核 |
| **已作廢申請之永久刪除** | `userstory.md` §3 明文「已完成紀錄直接永久刪除」不允許；已作廢同屬終態，不提供刪除 |
| **作廢之復原（VOIDED → COMPLETED／DRAFT）** | US 明文不允許（FE-US-26⑤／BE-US-05④）。本 Phase **不得**存在任何此類程式路徑（結構性斷言，AC-05） |
| **建立修正版後自動作廢原申請** | US 未要求；屬使用者可見行為之新增 → 列 §16 **D15** 供人類裁定，**未獲批准前不實作** |
| **已作廢申請之報表首次產生** | 產生端點之 `COMPLETED` 守門維持（§16 **D13**）；作廢後才想產報表屬無效需求 |
| **修正版之差異比對（diff）視圖** | US 未要求，不做投機功能 |
| **批次作廢／批次修正版** | US 未要求 |
| **暫存附件 24h 清理排程** | PHASE-011（BE-US-25），既有既定劃分 |
| **PHASE-008 §11.4 本體之 Type0/CID 敘述更正** | **不在本 Task 之 Allowed 檔案**；移交大總管另派 `SPEC-REV-008` Lite（§17.2、§19） |

---

## 2. 可測試 Acceptance Criteria

> **通則**：每條 AC 皆須可由自動化測試機械判定；「使用者可見行為」一律以逐字字串或鍵集斷言。金額／里程／比例一律**只讀快照、零重算**（本 Phase 不新增任何計算）。凡標記 **【條件 AC】** 者，須待對應 D 裁定後方生效；未裁定前不實作、不測試。

### A. 資料模型與 migration

**AC-01 作廢與版本關聯之持久化基礎，且既有結構零改寫**（BE-US-21／22 之基礎）

- **(a)** `Application` 新增**四個 nullable 欄位**（§8.1 逐欄相符，以 `information_schema.columns` 斷言）：`voidReason`（text，nullable）／`voidedAt`（**`timestamp(3)`**，nullable——沿全專案 `DateTime` 慣例，**非** timestamptz）／`voidedById`（text，nullable，**無 FK**，沿 `Report.generatedById`／003a／005a 慣例）／`supersedesId`（text，nullable，**`@unique`**，自關聯指向被修正之原申請，依 §16 **D7**）。**四欄皆無 `DEFAULT`、皆不回填**（既有列該四欄恆為 `NULL`）。
- **(b)** 【條件 AC，依 §16 **D4**】新增 `VoidedReportFile` 表（§8.2 逐欄相符）：`reportId`（`@unique`，對 `Report` 之 FK `onDelete: Restrict`）／`storageKey`（`@unique`，`rpt/` 前綴）／`fileName`／`byteSize`／`contentHash`／`createdById`／`createdAt`。
- **(c)** migration 對**除 `Application` 外之既有表**逐欄**零改寫**（欄位集合、型別、精度、可空性、預設值全等）；對 `Application` **僅有四個 `ADD COLUMN`**，**零 `DROP`**、零既有欄改型、零 `INSERT`／`UPDATE`（正則斷言 ＋ 突變自證：加入一行 `ALTER COLUMN` 或 `UPDATE` 必紅）。
- **(d)** 乾淨 DB 與既有 DB 各一輪 `prisma migrate deploy` 皆成功、重跑冪等；既有資料**零回填、零改寫**（既有 `Application` 列之十個原欄位逐欄逐位元組不變 ＋ 四個新欄恆為 `NULL`）。
- **(e)** 【依 §16 **D10**】`AuditAction` enum **新增恰一個值** `APPLICATION_VOIDED`；其餘六個 enum 之標籤集合**前後完全相同**（聯集全等斷言，多一／少一值必紅）。**因含 `ALTER TYPE`，本 migration 非純 `CREATE` 型**——PHASE-008 FW-8 所述之 fixture 安全網手法須改用 **raw SQL 型處置**（§8.5 明列作法與理由）。
- **(f)** **機械連動之逐處實查同步**（spec-writer 已親查，行號見 §8.5；**implementer 須於 Handoff 回報實查處數，勿信本 Spec 之預估**——PHASE-006／007／008 先例：實際處數與預估可能不同）：
  - **業務表數 16 → 17**（僅當 (b) 條件成立）：`infra001-isolation-self-check.test.ts` **兩處**、`phase6-migration-safety.test.ts` **一處**、`phase7-migration-safety.test.ts` **兩處**、`phase8-migration-safety.test.ts` **一處**——spec-writer 實查共 **6 處**。
  - **`Application` 欄位集合基線**：`phase8-migration-safety.test.ts` 之 `AC-01(d)` 十欄 `toEqual` 清單（實查 :1250 附近）須擴為十四欄。
  - **`AuditAction` enum 基線**：`phase5a-migration-safety.test.ts`／`phase6-migration-safety.test.ts`／`phase7-migration-safety.test.ts`（**兩處**）／`phase8-migration-safety.test.ts`——spec-writer 實查共 **5 處**。
  - 上述各處之**鑑別性斷言（`toContain(...)`、逐欄型別比對等）一律零弱化**，僅更新基線值。
- **(g)** 常設 drift guard（PHASE-008 AC-01(h)／`infra002-schema-drift.test.ts`）**零改動且全綠**：`schema.prisma` 與 `prisma/migrations` 逐一套用後狀態完全一致。
- **(h)** `Application` 之自關聯（`supersedes`／`supersededBy`）為 Prisma 關聯虛擬欄，**僅 `supersedesId` 產生 DDL**；`supersededBy` 側零 DDL（以欄位集合斷言佐證）。

### B. 狀態機與作廢流程（BE-US-22、BE-US-05）

**AC-02 狀態轉換集合之受控擴充**——`ALLOWED_TRANSITIONS` 由 1 條擴為 **2 條**：`DRAFT→COMPLETED`（既有，逐字不動）＋ `COMPLETED→VOIDED`（新增）。斷言：`ALLOWED_TRANSITIONS.length === 2`；`VOIDED→COMPLETED`／`VOIDED→DRAFT`／`DRAFT→VOIDED`／`COMPLETED→DRAFT` 四者**逐一**仍被拒絕且錯誤碼與訊息與既有語意一致（來源非 `DRAFT` → 403 `FORBIDDEN`；來源為 `DRAFT` 但目的非 `COMPLETED` → 400 `VALIDATION_ERROR`）。**硬約束（跨 Phase #1）**：作廢為**狀態取代**（`status` 欄由 `COMPLETED` 改為 `VOIDED`），**不得**新增與 `status` 正交之布林旗標——否則 `mileage-range.ts` 之 `status: "COMPLETED"` 等值過濾將靜默失效且既有測試不會變紅（結構性斷言：`Application` 無任何 `isVoided`／`voided` 布林欄）。

**AC-03 作廢原因之驗證（必填）**——`reason` 經 `trim` 後長度須落於 **1..500**；缺鍵／`null`／空字串／**僅空白字元（含全形空白 `　`、Tab、換行）** 一律 **400 `VALIDATION_ERROR`** 且 `fields[]` 恰含 `{ field: "reason" }`；超過 500 字元亦 400。**拒絕時零寫入**（`status` 不變、四個作廢欄仍為 `NULL`、零稽核列）。持久化值為 **`trim` 後**之字串（前後空白不入庫）。

**AC-04 作廢成功之持久化（同交易四欄 ＋ 快照零改寫）**——成功時於**單一交易**內寫入：`status='VOIDED'`、`voidReason`（trim 後值）、`voidedById`（實際操作者 id）、`voidedAt`（伺服器時間）。**同時斷言**：`totalAmount`／`completedAt`／三型子表之**全部快照欄位逐欄逐位元組不變**（作廢不得改寫任何金額或計算快照）；`updatedAt` 依 Prisma `@updatedAt` 更新屬預期，明列於斷言之允許變動集合。

**AC-05 不可復原（結構性 ＋ 端點雙層）**——(a) **結構性**：`backend/src/` 全域掃描，不存在任何將 `status` 由 `VOIDED` 寫回 `COMPLETED`／`DRAFT` 之程式路徑（掃描 `status: "COMPLETED"`／`status: "DRAFT"` 之**寫入位置**清單，逐一比對其守門，白名單外必紅）。(b) **端點**：對已作廢申請呼叫完成端點（`POST /applications/:id/complete`）→ **403 `FORBIDDEN`**，訊息沿既有 `ALREADY_FINAL_MESSAGE`；呼叫作廢端點 → **409 `CONFLICT`**（AC-06）；`PUT` 三型更新端點 → 403；`DELETE` → 403。四者皆**零寫入**。

**AC-06 重複作廢**——對已作廢申請再次作廢 → **409 `CONFLICT`** ＋ `details.status = "VOIDED"`（沿 PHASE-008 D11 之 `details.status` 形狀）；**非**冪等成功、**非** 200。零寫入、零稽核列。

**AC-07 草稿作廢**——對草稿呼叫作廢端點 → **409 `CONFLICT`** ＋ `details.status = "DRAFT"`；零寫入。**判定順序**：授權（401／403）**先於**狀態守門（409），他人草稿與他人已完成之回應**逐字相同**（側信道紀律，沿 PHASE-008 §6.1）。

**AC-08 作廢後業務欄位仍不可修改（既有守門之真實回歸）**——`assertApplicationMutable("VOIDED")` 拋 403（既有行為，本 Phase 首次成為**真實可達**狀態）；三型 `PUT` 端點、附件新增／刪除、行程段增刪對已作廢申請一律 403 且零寫入。

### C. 修正版（FE-US-25、AD-US-09、BE-US-21）

**AC-09 建立修正版之基本形狀**——對已完成申請呼叫修正版端點 → **201**，建立一筆新 `Application`：`status='DRAFT'`、`type` 與原申請相同、**`ownerId` ＝原申請之 `ownerId`**（管理員代建時亦然）、**`createdById` ＝實際操作者**（本人操作時為本人；管理員代建時為管理員）、`primaryDate` 依既有三型 `derive*PrimaryDate` 規則由**複製後之業務欄位**推導、`totalAmount`／`completedAt`／四個作廢欄皆為 `NULL`。

**AC-10 三型業務欄位逐欄複製對照（快照欄零複製）**——依 §7.4 之逐欄對照表，**逐欄**斷言複製結果：
- **差旅**：`tripDate`／`purpose`；**全部 `TripSegment`**（`sortOrder` 保持原序、`origin`／`destination`／`totalKm`／`highwayKm`）；**段快照四欄（`snapshot*`）一律不複製**（新段恆為 `NULL`）。
- **保養**：`lastMaintenanceDate`／`currentMaintenanceDate`／`lastOdometerKm`／`currentOdometerKm`／`actualCost`；五個快照欄不複製。
- **折舊**：`applicationYear`／`annualTotalKm`（**跨 Phase #3 之 §17.2 移交項**）；九個快照欄不複製——**修正版完成時由既有折舊完成流程重算**（含年度公務里程重查、參數重新查找），**不得**沿用原快照。
- **共通負向**：新申請之 `fuelPriceVersionId`／`depreciationParameterVersionId`／`calculatedAt` 等**全部參數版本引用欄位恆為 `NULL`**（鍵集封閉式逐欄斷言，多複製一欄必紅）。

**AC-11 原申請零改動（逐欄 ＋ 產物雙層）**——(a) 建立修正版前後，原 `Application` 列與其三型子表、`TripSegment` 全部欄位**逐欄逐位元組相同**（含 `updatedAt`——原列**不得**被 touch）。(b) 原申請之 `Attachment` 列（`id`／`storageKey`／`refId`／`status`／`linkedAt`）逐欄不變。(c) 原申請若已有 `Report`：`Report` 列七個關鍵欄（`reportNumber`／`storageKey`／`fileName`／`byteSize`／`contentHash`／`generatedAt`／`generatedById`）逐欄不變，且**storage 中該 `storageKey` 之位元組 SHA-256 前後相同**（逐位元組實證，非僅「列未變」）。

**AC-12 版本關聯之保存與雙向可見**——(a) 新申請之 `supersedesId` ＝原申請 `id`；(b) 查詢**原**申請詳情 → 回應含 `supersededBy: { id, status, primaryDate }`（修正版存在時）／`null`（不存在時）；查詢**修正版**詳情 → 回應含 `supersedes: { id, status, primaryDate, reportNumber | null }`。(c) 兩向皆為**單一 `supersedesId` 欄位**之投影，不另存反向欄位（單一事實來源）。

**AC-13 修正版之來源守門**——(a) 來源為草稿 → **409 `CONFLICT`** ＋ `details.status="DRAFT"`；(b) 來源為已作廢 → **409 `CONFLICT`** ＋ `details.status="VOIDED"`（依 §16 **D8**）；(c) 【依 §16 **D7**】原申請**已有**修正版 → **409 `CONFLICT`** ＋ `details.existingRevisionId`；(d) 三者皆零寫入、零附件複製、零 storage 寫入。

**AC-14 修正版之證明附件處置**【依 §16 **D6**】——推薦 (c) 成立時：(a) 原申請每一筆 `status='LINKED'` 之附件，於修正版產生**一筆新 `Attachment` 列**（新 `id`、**新 `storageKey`**、`ownerId` ＝原擁有人、`uploaderId` ＝實際操作者、`status='LINKED'`、`refType`／`refId` 指向**新**容器）；(b) 新舊 `storageKey` **互異**且新檔位元組與原檔**逐位元組相同**（SHA-256 比對），縮圖同步複製（`thumbnailKey` 有值時）；(c) **差旅段對應**：原段 N 之附件恰複製至新段 N（依 `sortOrder` 對位，不跨段錯置）；(d) 附件上限（差旅每段 5、保養 5、折舊 5）於複製後仍成立；(e) 複製失敗（storage 讀寫錯誤）→ **整筆修正版交易回滾**、零殘留（DB 零新增列、storage 已寫之新 key 補償刪除），回應 500 且**日誌零 storage key**。

**AC-15 修正版完成 → 新報表編號與新 PDF（PHASE-008 §17.2 之零程式變更實證）**——(a) 修正版完成後呼叫產生報表端點 → **201**，取得**與原申請不同**之 `reportNumber`（且序號為同月同型之下一號）；(b) 新 `Report.storageKey` 與原申請之 `storageKey` **互異**，新 PDF 位元組之 SHA-256 與原 PDF **不同**；(c) 原 `Report` 列與其 PDF 位元組 **SHA-256 前後不變**（BE-US-21④ 之逐位元組實證）；(d) 本 AC **不得**以修改 `report-number.ts`／`report-service.ts` 之編號或冪等邏輯達成——`backend/src/reports/report-number.ts` 於本 Phase **零 diff**（結構性斷言）。

### D. 統計排除與引用保護之真實回歸

**AC-16 區間公務里程排除已作廢（PHASE-005 AC-04 之真實流程回歸）**——以**真實作廢端點**（非 `prisma.application.update` 直寫）作廢一筆已完成差旅後：`sumOfficialMileage` 之結果**恰等於**未含該筆之值；`buildOfficialMileageWhere` 之 `status` 仍為字面 `"COMPLETED"`（非 `{ not: "DRAFT" }`）之既有斷言**零改動且全綠**；`backend/src/mileage/` **全目錄本 Phase 零 diff**（結構性斷言）。

**AC-17 保養期間與折舊年度公務里程排除已作廢（真實流程）**——同一引擎之兩個消費端各一：(a) 保養草稿之 `computed.officialKm` 於區間內某差旅被**真實作廢**後下降對應值；(b) 折舊草稿之年度公務里程同型；(c) 兩者之**已完成快照**於作廢後**不變**（歷史不因後續作廢而改變——快照即歷史，AC-04 之延伸）。

**AC-18 參數引用保護之作廢語意**【依 §16 **D2**】——推薦 (a) 成立時：`parameterHasReferences` 之 `status` 條件由 `"COMPLETED"` 改為 **`{ in: ["COMPLETED", "VOIDED"] }`**，五種 `ParameterType`（`FUEL`／`FUEL_PRICE`／`FUEL_CONSUMPTION`／`ETC`／`DEPRECIATION`）**逐型別**驗證：(a) 引用來源申請被作廢後，該參數版本**仍**判定為「已被引用」（改回 `COMPLETED` only 之 mutant **必紅**）；(b) 僅被草稿引用者仍判定為「未被引用」（草稿無快照，行為不變）；(c) 既有 `COMPLETED` 之正向判定逐型別零弱化。

### E. 報表與 PDF 之作廢面（FE-US-23⑤、BE-US-22④、BE-US-27⑤）

**AC-19 `ReportData` 之作廢欄位（封閉鍵集之受控擴充）**——`ReportCommon` 新增**恰一個**欄位 `void: { reason: string; at: string; byDisplayName: string } | null`（未作廢恆為 `null`）。斷言：(a) `ReportCommon` 鍵集 `toEqual` 全等（**八鍵**，多一鍵必紅）；(b) 三型 body 鍵集**逐字不變**（作廢資訊只落於 `common`，不污染三型 body）；(c) `byDisplayName` 取自作廢當下之操作者顯示名稱（`voidedById` 解析；使用者不存在時以 `"—"` 呈現，不拋錯、不洩漏 id）；(d) `report-data.ts` **零算式**之既有結構掃描（`.times(`／`.div(`／`.plus(`／`.minus(` 零出現）維持全綠。

**AC-20 列印版之作廢標示（FE-US-23⑤ 逐字）**——已作廢申請之列印版 HTML：(a) 含**明確作廢標示**——逐字字串 `已作廢` 出現於**專屬區塊**（`.void-banner`）且該區塊位於文件**首屏**（`renderCommonHeader` 之前）；(b) 逐字顯示**作廢原因**、**作廢操作者**、**作廢時間**（台北時區中文格式，沿 `formatTaipeiDateTime` **唯一**格式化來源，不新增第二個格式化函式）；(c) 未作廢申請之列印版**零** `.void-banner`、零 `已作廢` 字樣（負向斷言，避免恆真）；(d) 作廢原因經 **`escapeHtml`** 跳脫——3 種 XSS payload 於原因欄逐一驗證，移除跳脫之 mutant **必紅**；(e) `renderReportHtml` 仍為**純函式**（同輸入兩次呼叫 `toEqual`、零時鐘、零隨機）——既有 AC-15 斷言零弱化；(f) `.void-banner` 加 `avoid-break`（不得被分頁切開），且於列印媒體與 PDF 皆可見（**不得**套用 `@media print { display:none }`）。

**AC-21 【條件 AC，依 §16 **D4**】作廢後之正式 PDF 語意**——推薦 (b1) 成立時：(a) 作廢**已產生報表**之申請時，於**同一交易**內以同一份快照 ＋ 作廢資訊渲染出**作廢版 PDF**，經 `put` → 讀回校驗（位元組數 ＋ SHA-256）→ `INSERT VoidedReportFile` → 提交；任一階段失敗 → **整筆作廢回滾**（狀態仍為 `COMPLETED`）、storage 零殘留、回應 500 `REPORT_GENERATION_FAILED` ＋ `details.stage`；(b) 作廢後下載 → 回**作廢版**位元組，`Content-Disposition` 之報表編號**不變**；(c) 原 `Report.storageKey` 之位元組 SHA-256 **前後不變**（BE-US-27⑤「保留原始內容」之實證）；(d) 作廢後重複下載**位元組全等**且**渲染器零呼叫**（PHASE-008 AC-08 之紀律於作廢後仍成立）；(e) **未產生報表**之申請作廢 → 零渲染、零 storage 寫入（作廢為純 DB 操作）；(f) `Report` 列**零更新**——PHASE-008 之「`reports/` 零 `.report.update(`／`.delete(`／`.upsert(`」結構斷言**零改動且全綠**。

**AC-22 列印端點對已作廢申請放行**【依 §16 **D5**】——`GET /applications/:id/report/print` 之狀態守門由 `status === "COMPLETED"` 改為 **`status ∈ {COMPLETED, VOIDED}`**；草稿仍 **409 `CONFLICT`** ＋ `details.status="DRAFT"`（既有斷言零弱化）；已作廢之列印版含 AC-20 之全部作廢標示；授權矩陣（他人 403、未登入 401、強制改密 403）於 `VOIDED` 狀態逐格重驗。

### F. 授權與稽核

**AC-23 授權矩陣（**2 新端點 × 5 身分 ＝ 10 格**，格數明列）**——依 §6.1 逐格斷言狀態碼與回應鍵集：未登入 401；需強制改密 403 `PASSWORD_CHANGE_REQUIRED`；**擁有人本人**成功；**他人一般使用者** 403 `FORBIDDEN` 且回應**零業務值**；**管理員** 成功（AD-US-09／AD-US-10 明文授權）。他人之「已完成」與「草稿」回應**逐字相同**（不因狀態洩漏資源存在性）。

**AC-24 作廢稽核（BE-US-31②）**——作廢成功時於**同一交易**寫入恰一筆 `AuditLog`：`action='APPLICATION_VOIDED'`、`actorId` ＝實際操作者、`targetId` ＝申請擁有人、`targetLabel` ＝`{loginName}#{applicationId}` 形狀、`summary` 含 `{ applicationId, type, reason, voidedAt }`。**同交易**之證明：以 hook 拋錯注入使業務寫入一併回滾（零孤兒稽核列、零狀態變更）。**本人作廢亦寫稽核**（與 PHASE-004 AC-86「本人自建草稿不寫稽核」不同——BE-US-31② 逐字為「使用者**或**管理員作廢申請」，明列理由於 §6.2）。

**AC-25 稽核與日誌零敏感資料**——`AuditLog.summary` 與日誌流**零出現**：密碼、session cookie／token、`att/`／`rpt/` storage key 前綴值、volume 絕對路徑、折舊車價／折舊年限。作廢原因為使用者輸入之自由文字，**入稽核屬既定要求**（BE-US-31②），但**不得**進入 `request.log` 之任何一行（避免日誌成為第二份未受授權保護之副本）——反向探針證明掃描機制非恆真。

**AC-26 代操作稽核（AD-US-09②／AD-US-10③）**——(a) 管理員代作廢 → 稽核之 `actorId` ＝管理員、`targetId` ＝擁有人（`actorId ≠ targetId`）；(b) 管理員代建立修正版 → 沿用既有 `APPLICATION_CREATED_ON_BEHALF`（**不新增第二個 enum 值**），`summary` 含 `{ applicationId, type, revisionOf }`；(c) **本人**建立修正版 → **零稽核列**（沿 PHASE-004 AC-86 之 `userId !== actorId` 判定）；(d) 管理員對**自己**之申請作廢 → 仍寫 `APPLICATION_VOIDED`（作廢為不可逆狀態轉換，非「代操作」語意，故不受 AC-86 之本人豁免影響——明列理由於 §6.2）。

### G. 錯誤合約與日誌

**AC-27 `ErrorCode` 聯集全等（本 Phase 零新增碼）**——`errors.ts` 之 `ErrorCode` 聯集與 PHASE-008 結案基線**逐字相同**（BOGUS mutant 必紅）；兩個新端點之錯誤表（§7.5）逐格驗證：401／403／404／409（含 `details.status`／`details.existingRevisionId`）／400（`fields[]`）／500。

**AC-28 日誌敏感鍵掃描（含 AR-7 修復後之上傳路徑）**——七類敏感字串掃描擴及：作廢端點、修正版端點、附件複製路徑、**`upload-service.ts` 之補償刪檔路徑（AR-7 修復點）**；反向探針證明掃描非恆真；每條錯誤日誌行含 `requestId` 可追查。

### H. 前端（FE-US-25／26、FE-US-21④、AD-US-08③、FE-US-27）

**AC-29 作廢之二次確認與必填原因**——(a) 已完成申請詳情頁出現「作廢」按鈕；(b) 點擊後出現**確認對話框**（`.dialog-overlay`，沿既有二次確認慣例）含**作廢原因輸入欄**；(c) 原因為空或僅空白 → 確認鈕**停用**且**零 `POST`**（前端第一道）；(d) 送出中按鈕停用（防重複提交）；(e) 後端回 400 時逐字顯示欄位錯誤、回 409 時顯示狀態衝突訊息並提供重新載入；(f) **取消**時零請求、零狀態變更。

**AC-30 已作廢之呈現（列表 ＋ 詳情）**——(a) 列表該筆狀態欄逐字顯示 `已作廢`（既有 `STATUS_LABEL` 映射之真實回歸）；(b) 狀態篩選選 `已作廢` 可查得該筆；(c) 詳情頁逐字顯示**作廢原因**、**作廢操作者**、**作廢時間**（時間格式與既有前端「計算時間」同一長相）。

**AC-31 已作廢詳情頁為唯讀（缺陷修復 ＋ 負向斷言）**——(a) 三型詳情頁新增 `status === "VOIDED"` 之**唯讀分支**——**現況為缺陷**：`VOIDED` 會落入草稿編輯分支而渲染可編輯表單（spec-writer 實查 `TravelApplicationPage.tsx` :496／`MaintenanceApplicationPage.tsx` :428／`DepreciationApplicationPage.tsx` :450 之 `status === "COMPLETED"` 分支後即為草稿分支）；(b) 唯讀頁**零**「儲存」「完成申請」「刪除」「作廢」「建立修正版」按鈕（逐一負向斷言）；(c) **零任何可恢復為已完成之控制項**（FE-US-26⑤ 之前端落點）；(d) `ReportSection` 於 `VOIDED` **改為渲染**（現況 `status !== "COMPLETED"` 直接回 `null`）：顯示既有報表編號與**下載／檢視列印版**兩入口，**不**顯示「產生正式報表」按鈕（產生端點對 `VOIDED` 仍 409）；未產生報表者顯示「未產生正式報表」說明文字。

**AC-32 修正版入口與版本關係（FE-US-25①③、FE-US-21④、AD-US-08③）**——(a) 已完成申請詳情頁出現「建立修正版」按鈕（取代現況佔位文案「功能將於後續版本提供」，spec-writer 實查 `TravelApplicationPage.tsx` :510）；(b) 點擊成功後導向新草稿頁；(c) 原申請詳情頁顯示「已建立修正版」與**指向修正版之連結**；修正版頁顯示「本申請為 {原編號或原日期} 之修正版」與**指向原申請之連結**；(d) 附件區之提示文案含「如需修正附件，請建立修正版」（FE-US-21④）；(e) 管理員代操作路徑之入口與文案一致（AD-US-08③）。

**AC-33 五態**——`Loading`（送出中）／`Empty`（未作廢時無作廢資訊區塊）／`Error`（400／409／500 各一）／`Success`（作廢成功、修正版建立成功各一）／`Permission denied`（403 → 顯示無權限訊息且零後續請求）。

**AC-34 響應式（FE-US-27）**——375px 下：作廢確認對話框、作廢資訊區塊、版本關係區塊、已作廢列印版**皆無水平溢位**且內容可讀。

### I. E2E / Gate

**AC-35 作廢端到端**——差旅 ＋ 另一型（保養或折舊）各一：完成 → 產生報表 → 作廢（二次確認 ＋ 原因）→ 列表顯示已作廢 → 詳情顯示原因／操作者／時間 → 列印版顯示作廢標示 → 下載 PDF（依 D4 之裁定語意）→ 區間里程統計不含該筆。草稿無作廢入口之負向。

**AC-36 修正版端到端**——已完成差旅 → 建立修正版 → 新草稿含複製之欄位與附件 → 修改後完成 → 產生報表得**新編號** → 原申請詳情顯示版本關係且其報表編號未變。

### J. 相容與回歸

**AC-37 既有測試零弱化與基準線**——每個 Task 之 Done When 含「既有測試零弱化」；終審以三套件實跑數對照基準線（**後端 2952／前端 254／E2E 44**，PHASE-008 終審實測）核對；本 Phase 之機械連動（AC-01(f)）**僅更新基線值**，不得刪除或 skip 任何既有測試。

### K. 【條件 AC，依 §16 **D14**】跨 Phase chore

**AC-38 AR-7 日誌洩漏修復**——`upload-service.ts` 之補償刪檔與非預期錯誤路徑（實查 :296-310）之錯誤訊息比照 **AR-4 既有修法**處置，使 storage key 不入日誌；`logStream` 掃描擴及上傳路徑並附**反向探針**（修復前必紅之紅燈證據記入 Handoff）。

**AC-39 `report-data.ts` 附件排序 tiebreaker 守門**——(a) 結構性斷言：`report-data.ts` 之 `orderBy` 含 `{ id: "asc" }` **恰兩處**（差旅段路徑 ＋ 保養／折舊路徑；移除任一處必紅）；(b) 行為斷言：**保養／折舊**路徑之三張同 `linkedAt` 附件、寫入序與 `id` 遞增序刻意相反時，輸出恆依 `id` 遞增序（既有僅差旅覆蓋——PHASE-008 終審 AR-2／X8b 守門缺口之關閉）。

**AC-40 記載型更正與 `buildErrorBody` 回歸**——(a) `e2e/report-print-layout.spec.ts` **檔頭**之字型內嵌敘述更正為實測結果（子集字型 `Tj`／`ToUnicode`，非 `Type3` 向量化；PHASE-008 T8R2 SF-7 之實測）；(b) 【依 D14(b)】`reports/routes.ts` 之 `REPORT_GENERATION_FAILED` 由 `buildErrorBody` 繞道改為經 `AppError` 承載，**wire 格式逐字不變**之回歸斷言（`{ error: { code, message, requestId, details:{ stage } } }` 鍵集與值全等），且既有 `phase8-contract.test.ts` 之相關斷言零弱化。

---

## 3. 正常流程

### 3.1 作廢已完成申請（FE-US-26、AD-US-10、BE-US-22）

```
前端：詳情頁「作廢」→ 對話框（二次確認 + 原因必填）→ 原因非空才啟用確認鈕
  → POST /applications/:id/void { reason }

後端：
 (1) requireAuth → requirePasswordChanged                      〔401 / 403〕
 (2) 讀 Application（id, ownerId, status, type）；不存在 → 404
 (3) assertOwnershipOrAdmin(actor, ownerId)                    〔403，先於狀態守門〕
 (4) 狀態守門：status !== COMPLETED → 409 CONFLICT + details.status
 (5) reason 驗證：trim 後 1..500，否則 400 VALIDATION_ERROR + fields[]
 (6) 若「已產生報表」且 D4 裁定為 (b1)：交易外先組裝作廢版 ReportData
     （讀快照 + 嵌圖，零重算）——與 PHASE-008 §9.1 (2)(3) 同型
 (7) 單一交易：
      a. SELECT ... FOR UPDATE（行鎖，防雙作廢競態）
      b. assertTransition(status, "VOIDED")   ← 狀態機單一事實來源
      c. UPDATE Application SET status='VOIDED', voidReason, voidedById, voidedAt
      d. 〔D4(b1)〕renderReportHtml(含 void) → renderPdf → storage.put
         → 讀回校驗（byteSize + SHA-256）→ INSERT VoidedReportFile
      e. INSERT AuditLog(action='APPLICATION_VOIDED', ...)      〔同交易〕
      f. 提交
 (8) 失敗一律回滾：狀態不變、零稽核列、已寫入之 storage 檔補償刪除（零殘留）
 (9) 200 { application: <型別分派之詳情 DTO，含 void 區塊> }
```

**不變式**：①交易外**零 DB 寫入**；②(7)d 之 `put` 於任一失敗路徑必補償刪除；③(7) 內順序不可對調——狀態寫入（c）早於渲染（d），使渲染所用之 `ReportData` 恆帶正確作廢資訊；④**未產生報表**者 (6)(7)d 整段不執行（零渲染）。

### 3.2 建立修正版（FE-US-25、AD-US-09、BE-US-21）

```
前端：已完成詳情頁「建立修正版」→ POST /applications/:id/revision

後端：
 (1)(2)(3) 同 3.1 之認證、讀取、授權
 (4) 狀態守門：status !== COMPLETED → 409 + details.status（DRAFT / VOIDED 皆拒）
 (5) 既有修正版守門〔D7〕：原申請已有 supersededBy → 409 + details.existingRevisionId
 (6) 單一交易：
      a. 依 type 讀原申請之業務欄位（含 TripSegment、LINKED 附件清單）
      b. 建立新 Application（DRAFT）+ 三型子列，逐欄複製業務欄位（§7.4 對照表）
         —— 快照欄與參數版本引用欄一律不寫（恆 NULL）
      c. 設定 新Application.supersedesId = 原申請.id
      d. 〔D6(c)〕逐一複製附件：storage.get(原 key) → storage.put(新 key)
         → INSERT Attachment(LINKED, refId=新容器)
      e. 管理員代建時 INSERT AuditLog(APPLICATION_CREATED_ON_BEHALF, revisionOf)
      f. 提交
 (7) 失敗回滾 + 已寫入之新 storage key 補償刪除（零殘留、原申請零改動）
 (8) 201 { application: <新草稿之型別分派 DTO，含 supersedes 區塊> }
```

### 3.3 已作廢申請之列印與下載

```
GET /applications/:id/report/print   ← 狀態守門放行 COMPLETED ∪ VOIDED〔D5〕
  → renderReportHtml(ReportData with common.void ≠ null)
  → 首屏 .void-banner：「已作廢」+ 原因 + 操作者 + 時間

GET /applications/:id/report/pdf     ← 無狀態守門（既有）
  〔D4(b1)〕若 application.status = VOIDED 且 VoidedReportFile 存在
      → 回作廢版位元組（報表編號與檔名不變）
    否則 → 回原 Report 位元組（既有行為）
  兩種情形皆：零渲染、重複下載位元組全等
```

---

## 4. 五態（Loading / Empty / Error / Success / Permission denied）

| 態 | 作廢流程 | 修正版流程 | 已作廢詳情／報表 |
|---|---|---|---|
| **Loading** | 對話框確認鈕顯示「作廢中…」並停用；頁面其他操作停用 | 「建立中…」並停用（附件複製可能數秒） | 詳情載入中之既有骨架 |
| **Empty** | 未作廢時**不渲染**作廢資訊區塊（非顯示空白欄位） | 無修正版時**不渲染**版本關係區塊 | 已作廢但**未產生報表**：報表區塊顯示「未產生正式報表」說明文字 |
| **Error** | 400（原因欄逐字錯誤）／409（狀態衝突 → 提示重新載入）／500（一般錯誤 ＋ 重試） | 409（來源狀態／已有修正版）／500（含附件複製失敗）／重試不重複建立 | 列印版 409（草稿）；PDF 404（檔案遺失，不 500） |
| **Success** | 對話框關閉、頁面轉為**已作廢唯讀檢視**、逐字顯示原因／操作者／時間 | 導向新草稿頁；原頁面顯示版本關係 | 列印版含作廢標示；下載得作廢版（依 D4） |
| **Permission denied** | 403 → 顯示無權限訊息，**零後續請求**（無重試鈕） | 403 同左 | 他人資料 403 且回應零業務值 |

---

## 5. 邊界條件

| # | 情境 | 期望 |
|---|---|---|
| B-01 | `reason` 缺鍵／`null`／`""`／`"   "`／`"　\t\n"` | 400 `VALIDATION_ERROR` ＋ `fields[{field:"reason"}]`，零寫入 |
| B-02 | `reason` 恰 1 字元 ／ 恰 500 字元 | 皆接受；501 字元 → 400 |
| B-03 | `reason` 含前後空白 `"  誤植金額  "` | 接受，入庫為 `"誤植金額"`（trim） |
| B-04 | `reason` 含 XSS payload | 接受並原樣入庫；列印版與前端**跳脫後**呈現（AC-20(d)） |
| B-05 | `reason` 含換行 | 接受；列印版以 `escapeHtml` 後之文字節點呈現（不轉 `<br>`，避免注入面） |
| B-06 | 對草稿作廢 | 409 ＋ `details.status="DRAFT"` |
| B-07 | 對已作廢再作廢 | 409 ＋ `details.status="VOIDED"`（非冪等成功） |
| B-08 | 兩個併發作廢請求（同一申請） | 恰一個 200、另一個 409；恰一筆稽核列；**恰一個** `VoidedReportFile`（行鎖 ＋ `reportId` 唯一） |
| B-09 | 作廢**未產生報表**之申請 | 200；零渲染、零 storage 寫入、零 `VoidedReportFile` 列 |
| B-10 | 作廢時 PDF 渲染失敗（D4(b1)） | 整筆回滾：狀態仍 `COMPLETED`、零稽核列、storage 零殘留、500 ＋ `details.stage` |
| B-11 | 作廢後查詢統計（區間／年度／保養期間） | 三者皆排除該筆；已完成之保養／折舊**快照不變** |
| B-12 | 作廢一筆**被保養快照計入**之差旅 | 保養之既有快照**不變**（歷史即快照）；新查詢之 `computed` 才下降 |
| B-13 | 對不存在之 `:id` 作廢／建修正版 | 404 `NOT_FOUND`（兩端點一致，不洩漏型別） |
| B-14 | 他人之已完成申請作廢／建修正版 | 403；回應與「他人之草稿」**逐字相同** |
| B-15 | 管理員對**已停用**使用者之申請作廢 | 200（作廢為資料修正，不受帳號狀態限制）；理由記於 §6.2 |
| B-16 | 管理員對**已停用**使用者建修正版 | **400 `VALIDATION_ERROR`**「指定的使用者已停用」——沿既有代建立草稿之 B-26 先例（新草稿屬新建資料） |
| B-17 | 來源為草稿建修正版 | 409 ＋ `details.status="DRAFT"` |
| B-18 | 來源為已作廢建修正版 | 409 ＋ `details.status="VOIDED"`（D8） |
| B-19 | 原申請已有修正版（草稿或已完成） | 409 ＋ `details.existingRevisionId`（D7） |
| B-20 | 修正版草稿被刪除後再次建修正版 | 200／201 成立（`supersedesId` 隨列刪除而釋放） |
| B-21 | 修正版之修正版（鏈） | 允許；`supersedesId` 指向**直接前身**，不壓平為原始祖先 |
| B-22 | 原申請**零附件** | 修正版建立成功、零 storage 操作 |
| B-23 | 原申請附件之 storage 檔遺失 | 整筆修正版回滾 500；日誌零 storage key（AC-14(e)） |
| B-24 | 差旅原申請有 3 段、各段附件數不同 | 逐段對位複製，段—圖零錯置；各段上限 5 仍成立 |
| B-25 | 原申請附件恰 5 張（上限） | 複製後仍為 5 張且不觸發 `TOO_MANY_ATTACHMENTS` |
| B-26 | 已作廢申請開列印版 | 200 ＋ 作廢標示（D5） |
| B-27 | 已作廢申請**產生**報表（尚未產生過） | 409 ＋ `details.status="VOIDED"`（D13，維持既有 `COMPLETED` 守門） |
| B-28 | 已作廢申請下載 PDF（尚未產生過） | 404「尚未產生正式報表」（既有語意不變） |
| B-29 | 已作廢申請下載 PDF（已產生） | 依 D4：(b1) → 作廢版；`Content-Disposition` 之編號不變 |
| B-30 | 作廢後 `voidedById` 對應之使用者列不存在（理論上不可達——有歷史者拒刪） | 列印版與 DTO 以 `"—"` 呈現操作者，不拋錯、不洩漏 id |
| B-31 | 未登入／需強制改密存取兩新端點 | 401 ／ 403 `PASSWORD_CHANGE_REQUIRED` |
| B-32 | 作廢原因入稽核，但**不得**入日誌 | `logStream` 掃描該原因字串零命中（AC-25） |
| B-33 | 既有 `VOIDED` 過濾器（`mileage-range.ts`）於真實資料下 | 零 diff 且全綠；`{ not: "DRAFT" }` 之 mutant 必紅 |
| B-34 | 參數版本僅被**已作廢**申請引用 | 依 D2(a)：仍判定為「已被引用」（不可覆寫） |

---

## 6. 權限與敏感資料

### 6.1 授權矩陣（**2 端點 × 5 身分 ＝ 10 格，格數明列**）

| # | 端點 | 身分 | 期望 |
|---|---|---|---|
| 1 | `POST /applications/:id/void` | 未登入 | 401 `UNAUTHORIZED` |
| 2 | 同上 | 已登入但 `mustChangePassword` | 403 `PASSWORD_CHANGE_REQUIRED` |
| 3 | 同上 | 擁有人本人 | 200（狀態合法時） |
| 4 | 同上 | 他人一般使用者 | 403 `FORBIDDEN`，回應零業務值 |
| 5 | 同上 | 管理員（非擁有人） | 200（AD-US-10 明文授權） |
| 6 | `POST /applications/:id/revision` | 未登入 | 401 `UNAUTHORIZED` |
| 7 | 同上 | 已登入但 `mustChangePassword` | 403 `PASSWORD_CHANGE_REQUIRED` |
| 8 | 同上 | 擁有人本人 | 201（狀態合法時） |
| 9 | 同上 | 他人一般使用者 | 403 `FORBIDDEN`，回應零業務值 |
| 10 | 同上 | 管理員（非擁有人） | 201，新草稿 `ownerId` ＝原擁有人（AD-US-09①） |

**回歸格（既有 4 個報表端點 × `VOIDED` 狀態，4 格）**：產生 → 409（B-27）；列印 → 200（D5）；下載 → 200（依 D4）；查詢 → 200。四格之授權判定（401／403）與 `COMPLETED` 時**逐字相同**。

**與「完成端點 owner-only」先例之差異（記載）**：PHASE-004 D17／PHASE-006 D7(a)／PHASE-007 D9(a) 一致裁定「完成」僅限擁有人本人，管理員不得代行。本 Phase 之兩端點**放行管理員**，依據為 **AD-US-09／AD-US-10 之逐字授權**（US 明文，非本 Spec 之裁量）；差異已列入 §16 **D12** 供 Gate 確認。

**判定紀律（沿 PHASE-004／008 既有不變式，本 Phase 零變更）**
1. **授權（401／403）一律先於狀態守門（409）與欄位驗證（400）**——他人之草稿／已完成／已作廢三種狀態之回應**逐字相同**。
2. 授權權威恆為 **DB 查得之 `ownerId`**，永不採信請求參數。
3. 403 回應**零業務值**（不含 `status`、`type`、`ownerDisplayName`、金額）。

### 6.2 稽核

| 事件 | 動作值 | 觸發條件 | 理由 |
|---|---|---|---|
| 作廢 | **`APPLICATION_VOIDED`**（新增，D10） | **每一次**成功作廢（本人與管理員皆寫） | BE-US-31② 逐字「使用者**或**管理員作廢申請 → 應記錄作廢原因、操作者及時間」——與 PHASE-004 AC-86「本人自建草稿不寫稽核」之差異在於：**建立草稿可逆、作廢不可逆**，US 對後者明文要求留痕且未區分身分 |
| 建立修正版（管理員代行） | `APPLICATION_CREATED_ON_BEHALF`（既有，**不新增**） | `actorId ≠ ownerId` | AD-US-09② 之要求即「記錄管理員為實際操作者」；修正版本質為「代建立草稿」，沿既有語意與 enum，以 `summary.revisionOf` 區分 |
| 建立修正版（本人） | — | 零稽核列 | 沿 PHASE-004 AC-86（本人自建草稿不寫稽核）；`createdById` 本身即操作者紀錄 |

**同交易原子性**：兩類稽核寫入皆與業務寫入同一交易（沿既有 `onCreated` hook 模式），hook 拋錯時業務寫入一併回滾（AC-24）。

### 6.3 敏感資料

| 項目 | 處置 |
|---|---|
| **作廢原因**（使用者自由文字） | 入 DB 與 `AuditLog.summary`（US 要求）；**不得入任何日誌行**（AC-25／B-32）；呈現一律經 `escapeHtml`；他人視角恆不可見（授權面 403 先擋） |
| **作廢操作者** | DTO 與列印版僅呈現 `displayName`，**不呈現 `voidedById`**（內部識別值不外露，沿 `Report.generatedById` 既有紀律） |
| **折舊揭露面** | 車價／折舊年限／預估年度行駛公里數／參數版本 id 於作廢版列印版與 PDF **仍不出現**（PHASE-008 AC-18(b) 之延續，全身分一致） |
| **storage key** | 修正版附件複製之新舊 key 一律不入日誌、不入回應（AC-14(e)、AC-28） |
| **修正版之附件** | 新列 `ownerId` ＝**原擁有人**（非操作者），授權面與既有附件端點完全一致（NFR-US-10 不變） |

---

## 7. API Contract

### 7.1 端點總表（本 Phase 新增 **2 個**）

| 方法 | 路徑 | 說明 | 授權 | 成功碼 |
|---|---|---|---|---|
| `POST` | `/applications/:id/void` | 作廢已完成申請 | 擁有人或管理員 | 200 |
| `POST` | `/applications/:id/revision` | 建立修正版草稿 | 擁有人或管理員 | 201 |

> **落點**：兩端點掛於既有 `backend/src/applications/routes.ts`（與 `/applications/:id/complete`、`DELETE /applications/:id` 同一模組，型別分派沿既有 `typeProbe` 慣例）。**不新增路由模組、不新增前綴**。

### 7.2 DTO 形狀（擴充；既有鍵逐字不變）

```ts
/** 作廢資訊；未作廢恆為 null（Empty 態不渲染之依據）。 */
export interface VoidInfoDto {
  reason: string;
  voidedAt: string;             // ISO8601
  voidedByDisplayName: string;  // 解析失敗時 "—"；恆不含 voidedById
}

/** 版本關聯之最小投影（雙向皆由 supersedesId 推導）。 */
export interface RevisionLinkDto {
  id: string;
  status: "DRAFT" | "COMPLETED" | "VOIDED";
  primaryDate: string;          // YYYY-MM-DD
}

// 三型詳情 DTO 新增三鍵：
//   void:         VoidInfoDto | null
//   supersedes:   RevisionLinkDto | null   （本筆為修正版時指向原申請）
//   supersededBy: RevisionLinkDto | null   （本筆已有修正版時指向該修正版）
// 列表 DTO 新增一鍵（列表徽章用）：
//   isRevision:   boolean                  （supersedesId != null）
```

**鍵集紀律**：三型詳情 DTO 之既有實作**無**封閉 `toEqual` 鍵集斷言（spec-writer 實查確認），故新增鍵不觸發既有測試連動；但新增鍵須有**逐鍵正向 ＋ 負向（未作廢／無修正版時為 `null`）**測試。列表 DTO 之既有 17 鍵逐字不變。

### 7.3 請求／回應形狀

```
POST /applications/:id/void
  Body: { "reason": string }        // 其餘鍵一律忽略（沿 AC-54 既有紀律）
  200 : { "application": <型別分派之詳情 DTO；void 非 null> }
  400 : VALIDATION_ERROR + fields[{ field:"reason", reason:"…" }]
  409 : CONFLICT + details.status ∈ {"DRAFT","VOIDED"}

POST /applications/:id/revision
  Body: 無（一律忽略）
  201 : { "application": <新草稿之型別分派 DTO；supersedes 非 null> }
  409 : CONFLICT + details.status ∈ {"DRAFT","VOIDED"}
      | CONFLICT + details.existingRevisionId
```

### 7.4 修正版欄位複製對照表（**唯一事實來源**；AC-10 逐欄斷言依此表）

| 型別 | **複製**（業務欄位） | **不複製**（快照／引用／狀態） |
|---|---|---|
| 共通 `Application` | `type`／`ownerId`（＝原擁有人）；`primaryDate` **重新推導**（不直接複製） | `status`（恆 `DRAFT`）／`totalAmount`／`completedAt`／三個作廢欄／`createdById`（＝**操作者**，非原建立者）／`supersedesId`（＝原申請 id，非複製而來） |
| **差旅** | `tripDate`／`purpose`；每個 `TripSegment` 之 `sortOrder`／`origin`／`destination`／`totalKm`／`highwayKm` | `fuelUnitPrice`／`etcUnitPrice`／`snapshotTotalKm`／`snapshotRawAmount`／`calculatedAt`／五個版本引用欄／`snapshotFuelType`／`snapshotFuelPricePerLiter`／`snapshotFuelConsumption`；段之 `snapshotFuelAmount`／`snapshotEtcAmount`／`snapshotRawAmount`／`snapshotAmount` |
| **保養** | `lastMaintenanceDate`／`currentMaintenanceDate`／`lastOdometerKm`／`currentOdometerKm`／`actualCost` | `snapshotIntervalKm`／`snapshotOfficialKm`／`snapshotRatio`／`snapshotRawAmount`／`calculatedAt` |
| **折舊** | `applicationYear`／`annualTotalKm`（§17.2 移交項；完成時**重算**年度公務里程與參數） | 九個 `snapshot*` 欄／`calculatedAt`／`depreciationParameterVersionId`／兩個凍結唯讀欄 |
| **附件**（依 D6(c)） | `mimeType`／`byteSize`／`originalFilename`／`ownerId`／**位元組內容**；`refType`＋`refId` 指向新容器 | `id`／`storageKey`／`thumbnailKey`（皆新產生）／`uploaderId`（＝操作者）／`linkedAt`（＝現在） |

### 7.5 錯誤合約（本 Phase **零新增 `ErrorCode`**）

| 狀況 | HTTP | code | 備註 |
|---|---|---|---|
| 未登入 | 401 | `UNAUTHORIZED` | 既有 |
| 需強制改密 | 403 | `PASSWORD_CHANGE_REQUIRED` | 既有 |
| 他人資料 | 403 | `FORBIDDEN` | 回應零業務值 |
| 申請不存在 | 404 | `NOT_FOUND` | 兩端點一致，不洩漏型別 |
| 原因驗證失敗 | 400 | `VALIDATION_ERROR` | `fields[{field:"reason"}]` |
| 狀態不符（草稿／已作廢） | 409 | `CONFLICT` | `details.status` |
| 已有修正版 | 409 | `CONFLICT` | `details.existingRevisionId` |
| 作廢版 PDF 產生失敗（D4(b1)） | 500 | `REPORT_GENERATION_FAILED` | `details.stage ∈ {RENDER,STORE,VERIFY,PERSIST}`（既有四值封閉，**不擴充**） |
| 附件複製失敗 | 500 | `INTERNAL_ERROR` | 日誌零 storage key |

### 7.6 PHASE-010／011 之複用介面約束

1. **稽核查詢面**：`APPLICATION_VOIDED` 之 `summary` 形狀（`{ applicationId, type, reason, voidedAt }`）即 PHASE-010 稽核頁「前後摘要」之來源；本 Phase 不提供任何稽核查詢端點。
2. **`VoidedReportFile`**（若 D4(b1) 成立）：`storageKey` 一律 `rpt/` 前綴，PHASE-011 之備份還原與孤兒清理須一併涵蓋（§17.2）。
3. **版本關聯**：`supersedesId` 為單一事實來源；PHASE-010 若需顯示版本鏈，以遞迴查詢該欄即可，**不得**另存反向欄位。

---

## 8. 資料模型與 migration

### 8.1 `Application` 之四個新欄（推薦形狀；依 §16 D1／D7 裁定）

```prisma
model Application {
  // ── 既有十欄一律不動 ──

  /// PHASE-009：作廢資訊（三欄同生共死——恆同時為 null 或同時非 null）
  voidReason  String?                     // trim 後 1..500（應用層驗證）
  voidedAt    DateTime?
  voidedById  String?                     // 操作者（無 FK，沿 Report.generatedById 慣例）

  /// PHASE-009：版本關聯——本列為「哪一筆已完成申請」之修正版
  supersedesId String?  @unique           // 0..1（D7）
  supersedes   Application?  @relation("ApplicationRevision", fields: [supersedesId], references: [id], onDelete: Restrict)
  supersededBy Application?  @relation("ApplicationRevision")

  // 既有四個索引一律不動；本 Phase 不新增索引（supersedesId 之 @unique 自帶索引）
}
```

### 8.2 【條件】`VoidedReportFile` 表（依 §16 D4(b1)）

```prisma
model VoidedReportFile {
  id          String   @id @default(cuid())
  reportId    String   @unique                    // 冪等鍵：一份 Report 至多一份作廢版
  report      Report   @relation(fields: [reportId], references: [id], onDelete: Restrict)
  storageKey  String   @unique                    // "rpt/<uuid>/void.pdf"（系統產生）
  fileName    String                              // 與原 Report.fileName 相同（編號不變）
  byteSize    Int
  contentHash String                              // SHA-256 hex
  createdById String                              // 作廢操作者（無 FK）
  createdAt   DateTime @default(now())
}
```

> **為何不擴充 `Report`**：PHASE-008 已固化「**不存在更新或刪除 `Report` 之程式路徑**」（`ARCHITECTURE.md` :144／`DATA_FLOW.md` :69）並以結構性掃描守門（`reports/` 零 `.report.update(`／`.delete(`／`.upsert(`）。以獨立表承載作廢版，可使該守門**零改動且全綠**（AC-21(f)）；若改為在 `Report` 加欄並 `update`，該既有守門必紅且須弱化一條已批准之結構斷言——此代價已列為 §16 D4 次選項之明示成本。

### 8.3 欄位與約束之推導依據

| 欄位 | 型別 | 依據 |
|---|---|---|
| `voidReason` | `String?`（text） | 自由文字，長度上界由應用層驗證（500）而非 DDL——沿既有 `purpose`／`targetLabel` 慣例，避免 DDL 上界成為第二事實來源 |
| `voidedAt` | `DateTime?` | 伺服器時間；與 `AuditLog.createdAt` 可能有毫秒差，**不**斷言兩者相等（沿 PHASE-007 T10R 之時間戳紀律） |
| `voidedById` | `String?`，無 FK | 沿 `Report.generatedById`／003a／005a 既有慣例；顯示名稱於 DTO 組裝時查詢，查無以 `"—"` 呈現 |
| `supersedesId` | `String? @unique`，FK `Restrict` | `@unique` ＝ D7(a) 之「0..1」語意；`Restrict` 使原申請在有修正版時不可被刪除（已完成本即不可刪，屬縱深防禦） |

### 8.4 快照與歷史之關係（**作廢不改寫任何歷史數值**）

- 作廢**只**改 `status` 與三個作廢欄；`totalAmount`、`completedAt`、三型全部 `snapshot*` 欄**逐欄不變**（AC-04）。
- 已完成之保養／折舊快照中所含之「期間／年度公務里程」為**當時**之計算結果；後續作廢某筆差旅**不回溯改寫**該快照（AC-17(c)）——此為 BE-US-18「歷史可重現」之直接後果，屬**刻意設計**，並記入 §17.1 已知限制。

### 8.5 migration 型態、順序與機械連動（**FW-8 之 raw SQL 型處置**）

1. **本 migration 非純 `CREATE` 型**：含 `ALTER TABLE "Application" ADD COLUMN`（四欄，皆 nullable、無 default → **不重寫既有列**）＋ `ALTER TYPE "AuditAction" ADD VALUE 'APPLICATION_VOIDED'`（依 D10）＋（條件）`CREATE TABLE "VoidedReportFile"`。
2. **FW-8 連動**：PHASE-008 T1 之安全網 fixture 手法（以最新 Prisma Client 對 baseline schema 寫入）在**含新 enum 值**時失效（Client 認得新值、baseline DB 不認得）。本 Phase 之 baseline fixture **一律改以 raw SQL（`$executeRaw`）寫入**，沿 PHASE-005a／006 既有 raw SQL 播種先例（`phase5a-migration-safety.test.ts` :250-275 為現成範本）。
3. **`ALTER TYPE ... ADD VALUE` 之交易限制**：PostgreSQL 12+ 允許於交易內執行，但**同一交易內不得使用該新值**。安全網測試須將「新增值」與「使用該值」分於不同交易（明列於 T1 之 Done When）。
4. **機械連動清單（spec-writer 實查行號；implementer 須實查回報實際處數）**

| 連動類型 | 檔案與處數（spec-writer 實查） | 更新內容 |
|---|---|---|
| 業務表數 16 → 17（**僅** D4(b1) 成立時） | `infra001-isolation-self-check.test.ts` :80／:161；`phase6-migration-safety.test.ts` :551；`phase7-migration-safety.test.ts` :686／:1803；`phase8-migration-safety.test.ts` :751 —— **共 6 處** | 值 16 → 17；`toContain(...)` 等鑑別性斷言零弱化 |
| `Application` 欄位集合基線 | `phase8-migration-safety.test.ts` :1250 附近（十欄 `toEqual`） | 擴為十四欄；**新增一則負向**：四個新欄皆 `is_nullable='YES'` 且無 `column_default` |
| `AuditAction` enum 基線 | `phase5a-migration-safety.test.ts` :559；`phase6-migration-safety.test.ts` :678；`phase7-migration-safety.test.ts` :1052／:2167；`phase8-migration-safety.test.ts` :1293 —— **共 5 處** | 九值 → 十值（加 `APPLICATION_VOIDED`）；聯集全等紀律不變 |
| `ReportCommon` 鍵集封閉 | `phase8-report-data.test.ts`（AC-27 列之鍵集 `toEqual`） | 七鍵 → 八鍵（加 `void`）；三型 body 鍵集逐字不變 |
| `PHASE_008_SRC_FILES` 九檔清單 | `phase8-contract.test.ts` §B | 若新增 `backend/src/reports/*.ts` 檔（如作廢版渲染輔助）→ 同步更新清單 |

> **預授權（沿 T11b／R1b 先例）**：上述五類連動之修改，於 Spec Gate 通過後**視為同批預授權**——相關 Task 之 Packet 得直接修改該些既有測試檔之**基線值**，無需另行請示；但**任何鑑別性斷言之弱化、刪除或 skip 一律禁止**，且 implementer 須於 Handoff 逐檔列出實際改動處數與 diff 行數。

### 8.6 D8(a) 硬約束之結構性守門（跨 Phase 核銷 #1）

- **作廢＝狀態取代**：`Application` **不得**新增任何與 `status` 正交之作廢旗標（結構性斷言：欄位集合零 `isVoided`／`voided` 類布林欄）。
- `backend/src/mileage/` 全目錄本 Phase **零 diff**（AC-16）。
- 既有「`status` 必須恰為字面 `"COMPLETED"`」之斷言（PHASE-005 測試）零改動且全綠。

---

## 9. Data Flow（本 Phase 影響部分）

### 9.1 作廢（唯一之狀態終結路徑）

```
POST /applications/:id/void
  → 認證 → 授權(ownerId) → 狀態守門(COMPLETED) → reason 驗證
  → 〔已產生報表且 D4(b1)〕交易外組裝 ReportData(含 void) + 嵌圖   〔零 DB 寫入〕
  → 交易 { 行鎖 → assertTransition → UPDATE(status + 作廢三欄)
           → 〔渲染 → put → 讀回校驗 → INSERT VoidedReportFile〕
           → INSERT AuditLog(APPLICATION_VOIDED) → COMMIT }
  → 失敗：回滾 + 補償刪檔（零殘留、狀態仍 COMPLETED）
  → 200 { application }
```

**不變式**：①交易外**零 DB 寫入**；②交易內之 `put` 於任一失敗路徑必補償刪除；③順序不可對調——狀態寫入早於渲染，使渲染所用之 `ReportData` 恆帶正確作廢資訊；④**未產生報表**者整段渲染流程不執行（零渲染、零 storage 寫入）。

### 9.2 修正版（唯一之複製路徑）

```
POST /applications/:id/revision
  → 認證 → 授權 → 狀態守門(COMPLETED) → 既有修正版守門(D7)
  → 交易 { 讀原業務欄位(含 TripSegment、LINKED 附件清單)
           → 建新 Application(DRAFT)+三型子列（逐欄複製，§7.4）
           → set supersedesId = 原申請 id
           → 〔D6(c)〕逐一複製附件位元組(storage.get→put) + INSERT Attachment
           → 〔代操作〕INSERT AuditLog(APPLICATION_CREATED_ON_BEHALF) → COMMIT }
  → 失敗：回滾 + 新 storage key 補償刪除（原申請零改動）
  → 201 { application }
```

### 9.3 統計與引用保護之連動（唯讀）

```
sumOfficialMileage / parameterHasReferences
  ← Application.status
      統計面：status = 'COMPLETED'（字面等值）→ VOIDED 天然排除（**零程式變更**）
      引用面：status ∈ {'COMPLETED','VOIDED'}（D2(a) 之唯一改動點）
```

### 9.4 報表面之連動

```
GET .../report/print  → 狀態放行 COMPLETED ∪ VOIDED → ReportData.common.void → .void-banner
GET .../report/pdf    → VOIDED 且有 VoidedReportFile → 回作廢版；否則回原檔（皆零渲染）
POST .../report       → 狀態守門維持 COMPLETED（VOIDED → 409，D13）
GET .../report        → 無狀態守門（既有），VOIDED 亦回既有報表中繼資料
```

---

## 10. 非功能需求

| 項目 | 目標 | 依據 |
|---|---|---|
| 作廢端點回應時間（**無**報表者） | < 1 s | NFR-US-14 表單類 2 s 之內 |
| 作廢端點回應時間（**有**報表且 D4(b1)） | 目標 10 s（與 PDF 產生同帶） | NFR-US-14④；量測值記入 Handoff |
| 修正版端點回應時間（含 ≤5 張附件複製） | 目標 5 s | 附件複製為位元組搬移，無影像處理 |
| 併發 | ~20 人規模；作廢以行鎖排隊，無需佇列 | PHASE-008 §10 同一評估 |
| 儲存成本 | 修正版附件複製 ≤ 5 × 10 MB／次；作廢版 PDF ≤ 1 份／報表 | §17.1 已知限制 |
| 可用性 | 本 Phase 零新增外部依賴、零容器變更 | 全 Phase 複用既有 Playwright／sharp／storage |

---

## 11. 測試策略

### 11.0 測試紀律（強制，寫入每個 Task Packet）

1. **TDD**：先寫會失敗的測試（紅燈證據記入 Handoff），再實作；**不得**刪除、弱化、skip 任何既有測試換綠燈。
2. **mutant 自證**：每條「守門型」斷言須附至少一個 mutant 之必紅證明（本 Spec 已於各 AC 逐條指名）。
3. **零重算紀律**：報表面一律讀快照；本 Phase **不新增任何金額或里程計算**。
4. **真實流程優先**：AC-16／AC-17 之作廢**一律走真實端點**，不得以 `prisma.application.update` 直寫（PHASE-005 當時之權宜作法於本 Phase 正式退場）。
5. **既有測試零弱化之 diff 檢查**列入每個 Task 之 Done When。

### 11.1 單元（Vitest，不需 DB）

| 對象 | 檔案 | 重點 |
|---|---|---|
| 狀態機擴充 | `backend/test/unit/application-state-machine.test.ts`（既有；**既有鑑別性斷言零弱化，轉換集合基線得依 AC-02 重錨定 1→2**） | AC-02：轉換集合長度 2、四種非法轉換逐一、錯誤碼分流不變 |
| 作廢原因驗證純函式 | `backend/test/unit/void-reason.test.ts`（新） | AC-03：gate table（≥12 列，含全形空白、Tab、換行、500／501 邊界、trim） |
| 列印版作廢標示 | `backend/test/unit/report-html.test.ts`（既有，只增不改） | AC-20：`.void-banner` 在場／未作廢負向／3 payload 跳脫／純函式 `toEqual` |
| 修正版複製鍵集 | `backend/test/unit/revision-copy.test.ts`（新） | AC-10：三型「複製鍵集」與「禁複製鍵集」之 `toEqual` 封閉 |

### 11.2 整合（Vitest ＋ PostgreSQL ＋ 真實 route）

| 對象 | 檔案 | 重點 |
|---|---|---|
| migration 安全網 | `phase9-migration-safety.test.ts`（新） | AC-01(a)~(h)；raw SQL 型 baseline fixture；四欄 nullable 無 default；enum 十值；drift guard 綠 |
| 作廢流程 | `phase9-void.test.ts`（新） | AC-03~AC-08、AC-24／AC-26（作廢側）；B-08 併發雙作廢；快照逐欄不變 |
| 修正版流程 | `phase9-revision.test.ts`（新） | AC-09~AC-13；原申請逐欄 ＋ 原 PDF 位元組 SHA-256 前後不變 |
| 修正版附件複製 | `phase9-revision-attachment.test.ts`（新） | AC-14：位元組雜湊相同、key 互異、段對位、上限、失敗回滾零殘留 |
| 統計排除真實回歸 | `phase9-void-statistics.test.ts`（新） | AC-15(a)~(c)／AC-16／AC-17；`mileage/` 零 diff 結構斷言 |
| 引用保護 | `phase9-reference-guard.test.ts`（新） | AC-18：五型別逐一；`COMPLETED`-only mutant 必紅 |
| 報表資料與作廢版 PDF | `phase9-void-report.test.ts`（新） | AC-19／AC-21／AC-39；`Report` 列零更新之既有結構斷言複跑 |
| 列印端點放行 | `phase8-report-print.test.ts`（既有，只增不改） | AC-22：`VOIDED` 200 ＋ 草稿 409 既有斷言零弱化 |
| 授權矩陣與錯誤合約 | `phase9-contract.test.ts`（新） | AC-23（10 格 ＋ 4 回歸格）／AC-25／AC-27／AC-28；反向探針 |

### 11.3 前端（Vitest ＋ Testing Library，mock fetch）

| 對象 | 檔案 | 重點 |
|---|---|---|
| 作廢對話框元件 | `frontend/test/VoidApplicationDialog.test.tsx`（新） | AC-29／AC-33：空原因零 `POST`、送出中停用、取消零請求、403 零重試 |
| 報表區塊 VOIDED 放行 | `frontend/test/ReportSection.test.tsx`（既有，只增不改） | AC-31(d)：VOIDED 顯示下載／列印入口、**零**產生按鈕 |
| 三型詳情頁 | 既有三檔（只增不改） | AC-30／AC-31／AC-32：唯讀分支、作廢資訊、版本關係、文案更新 |
| 列表 | `frontend/test/ApplicationListSection.test.tsx`（既有，只增不改） | AC-30(a)(b)：已作廢徽章與狀態篩選 |

### 11.4 E2E（Playwright，Mock Gate ＋ 整合 Gate）

| 檔案 | 重點 |
|---|---|
| `e2e/void-application.spec.ts`（新） | AC-34／AC-35：兩型端到端；列印版作廢標示；統計不含該筆；草稿無入口負向；375px 無溢位 |
| `e2e/revision.spec.ts`（新） | AC-36：建立修正版 → 複製欄位與附件 → 完成 → 新編號 → 版本關係雙向 |

### 11.5 安全測試

- 授權矩陣 10 格逐格 ＋ 報表四端點於 `VOIDED` 之 4 格回歸；他人資料 403 且回應零業務值。
- 判定順序無側信道（他人之草稿／已完成／已作廢回應逐字相同）。
- XSS：作廢原因 × 列印版 ＋ 前端，兩層。
- 日誌敏感鍵掃描（含作廢原因、storage key、AR-7 上傳路徑）＋ 反向探針。
- 附件複製後之 `ownerId` 不變（授權面回歸）。

---

## 12. AC ↔ 測試映射表（機械可查；隨 Task 完成更新「狀態」欄）

> **格式**：`AC` ｜ `層級` ｜ `測試檔（預定路徑）` ｜ `測試名（預定名稱）` ｜ `Task` ｜ `狀態`
> 狀態值：`PENDING`（Spec 階段）／`PENDING（Spec Gate 2026-08-07 裁定後解鎖）`／`RED`（測試已寫且失敗）／`GREEN`（實作完成通過）。
> **Phase 完成前之覆蓋檢查與終審核對以本表為準**（治理 2026-08-02.1）。
> **`GREEN` 列之測試名須為實際存在之測試名（逐字可 `grep`）**；`PENDING` 列為預定名稱，落地後依 `vitest --reporter=verbose`／`playwright --reporter=list` 之實際輸出**逐字回填**（沿 PHASE-008 DOC-SYNC 之實名回填規則：巢狀者以 `describe 標題 › it 標題` 表示，回填一律以 `grep` 逐檔核對，不得抄錄清單）。

| AC | 層級 | 測試檔 | 測試名（預定） | Task | 狀態 |
|---|---|---|---|---|---|
| AC-01(a)(c)(d)(h) | integration | `phase9-migration-safety.test.ts` | `AC-01(a): Application 四個新欄之型別／可空性／無 default 逐欄符合 §8.1`；`AC-01(c): 除 Application 外既有表逐欄零改寫（突變自證：ALTER COLUMN／UPDATE 各必紅）`；`AC-01(d): 乾淨與既有 DB 各一輪 migrate deploy 成功且冪等；既有列十個原欄不變、四個新欄恆為 NULL`；`AC-01(h): supersededBy 為零 DDL 之虛擬關聯欄（Application 欄位集合僅增四欄）` | T1 | PENDING |
| AC-01(b) | integration | `phase9-migration-safety.test.ts` | `AC-01(b): VoidedReportFile 表之欄位集合、兩個唯一約束與 FK(onDelete: Restrict) 逐欄符合 §8.2` | T1 | PENDING（D4=b1 已裁定解鎖） |
| AC-01(e) | integration | `phase9-migration-safety.test.ts` | `AC-01(e): AuditAction 恰新增 APPLICATION_VOIDED，其餘六個 enum 聯集全等（多一／少一必紅）`；`AC-01(e): ALTER TYPE 新值於獨立交易後方可使用（raw SQL fixture 手法自證）` | T1 | PENDING（D10 照推薦已裁定解鎖） |
| AC-01(f) | integration | `infra001-isolation-self-check.test.ts`；`phase5a／6／7／8-migration-safety.test.ts` | 表數 16→17 之六處（條件）與 `AuditAction` 五處、`Application` 欄位集合一處之基線值更新——**測試名零改動**，故無新實名；另新增一則逐字測試 `AC-01(f) 機械連動實查: 本 Phase 更新之基線處數與 Handoff 回報值相符` | T1 | PENDING |
| AC-01(g) | integration | `infra002-schema-drift.test.ts`（既有，零改動） | 既有 drift guard 測試名（`migrate diff --exit-code = 0`） | T1 | PENDING |
| AC-02 | unit（轉換集合）＋ integration（D8(a) 結構面） | `backend/test/unit/application-state-machine.test.ts`；`backend/test/integration/phase9-migration-safety.test.ts`（D8(a) 結構面，**T1 已交付**） | `ALLOWED_TRANSITIONS — 本 Phase 可達轉換集合（D2, PHASE-009-T2 依 AC-02 受控擴充）` › `AC-02: ALLOWED_TRANSITIONS 恰兩條（DRAFT→COMPLETED、COMPLETED→VOIDED）`／`兩元素逐字為 [DRAFT, COMPLETED] 與 [COMPLETED, VOIDED]（全等比對，防偷加第三條或改動內容）`；`AC-02 逐字驗收 — 四種非法轉換逐一（錯誤碼分流不變）` › `AC-02: VOIDED→COMPLETED／VOIDED→DRAFT／DRAFT→VOIDED／COMPLETED→DRAFT 逐一被拒且錯誤碼分流不變`；`DRAFT→COMPLETED 與 COMPLETED→VOIDED 是僅有的兩個不拋格子（矩陣鑑別力總結，AC-02）`；**D8(a)「零布林旗標」之結構面守門 ＝ T1 之 14 欄封閉集合斷言**（`AC-01(a): Application 之四個新欄 — 型別／可空性／無 default 逐欄符合 §8.1（14 欄封閉集合）`，`phase9-migration-safety.test.ts` :888）——**不另造第二個較弱守門**（T1 即審 **FW-3** 裁定：欄位集合封閉即涵蓋「零 `isVoided`／`voided`」，寫入路徑列舉≠布林守門重造） | T2（轉換集合）＋ **T1**（D8(a) 結構面） | PENDING |
| AC-03 | unit ＋ integration | `void-reason.test.ts`；`phase9-void.test.ts` | `AC-03: 作廢原因 gate table（12 列：缺鍵／null／空字串／半形空白／全形空白／Tab／換行／1 字元／500 字元／501 字元／前後空白 trim／XSS payload）`；`AC-03: 400 時零寫入（status 不變、四欄仍 NULL、零稽核列）` | T3 | PENDING |
| AC-04 | integration | `phase9-void.test.ts` | `AC-04: 作廢成功同交易寫入四欄；totalAmount／completedAt／三型快照欄逐欄逐位元組不變（允許變動集合僅含 status／四新欄／updatedAt）` | T3 | PENDING |
| AC-05 | **unit**（(a)）＋ integration（(b)） | **(a)**：`backend/test/unit/application-state-machine.test.ts`（**T2 已交付**）／**(b)**：`phase9-void.test.ts`；`phase9-contract.test.ts`（T4，預定） | **(a) 實名**：`AC-05(a) 結構性守門 — backend/src 全域零 VOIDED→COMPLETED／DRAFT 寫入路徑` › `至少掃到一些 src 檔案（確保這個測試本身沒有因為路徑算錯而空跑）`／`status: COMPLETED／DRAFT 之程式碼出現位置逐一比對白名單，白名單外必紅`／`鑑別力自證（SF-3, T2R-LITE：真實 fixture 目錄實跑，非恆真式）：listStatusLiteralOccurrences 對 scratchpad fixture 目錄實際掃描，涵蓋字串字面值／enum 成員／跨行三種寫入形式，且正確排除行註解與 JSDoc`／`三筆 COMPLETED 寫入（travel／maintenance／depreciation）皆含同函式的 assertTransition(existing.status, "COMPLETED") 呼叫（VOIDED 來源必先 403，不可能執行到該 update）`；**(b) 預定名**：`AC-05(b): 已作廢之 complete／三型 PUT／DELETE 皆 403 且零寫入` | T2（(a)）＋ T4（(b)） | PENDING |
| AC-06 | integration | `phase9-void.test.ts` | `AC-06: 已作廢再作廢 → 409 CONFLICT + details.status="VOIDED"，零寫入零稽核（非冪等成功）` | T3 | PENDING |
| AC-07 | integration | `phase9-void.test.ts` | `AC-07: 草稿作廢 → 409 + details.status="DRAFT"`；`AC-07 側信道: 他人草稿 vs 他人已完成 vs 他人已作廢 → 403 回應逐字相同` | T3 | PENDING |
| AC-08 | integration | `phase9-void.test.ts` | `AC-08: 已作廢之三型 PUT／附件新增刪除／行程段增刪皆 403 且零寫入（assertApplicationMutable 之真實回歸）` | T3 | PENDING |
| AC-09 | integration | `phase9-revision.test.ts` | `AC-09: 建立修正版 → 201；新列 status=DRAFT、ownerId=原擁有人、createdById=操作者、totalAmount／completedAt／作廢三欄皆 NULL` | T5 | PENDING |
| AC-10 | unit ＋ integration | `revision-copy.test.ts`；`phase9-revision.test.ts` | `AC-10: 三型「複製鍵集」與「禁複製鍵集」toEqual 封閉（多複製一欄必紅）`；`AC-10: 差旅逐段複製且 sortOrder 保序，段快照四欄恆 NULL`；`AC-10: 折舊複製 applicationYear 與 annualTotalKm，九個快照欄與參數版本引用欄恆 NULL` | T5 | PENDING |
| AC-11 | integration | `phase9-revision.test.ts` | `AC-11(a): 原 Application／三型子列／TripSegment 逐欄逐位元組不變（含 updatedAt 未被 touch）`；`AC-11(b): 原附件列五欄逐欄不變`；`AC-11(c): 原 Report 七欄不變且其 PDF 位元組 SHA-256 前後相同` | T5 | PENDING |
| AC-12 | integration | `phase9-revision.test.ts` | `AC-12: supersedesId 指向原申請；原申請詳情回 supersededBy、修正版詳情回 supersedes（未建立時皆 null）`；`AC-12 結構: 反向關聯無獨立持久化欄位（單一事實來源）` | T7 | PENDING |
| AC-13 | integration | `phase9-revision.test.ts` | `AC-13: 草稿來源 → 409 + details.status="DRAFT"`；`AC-13: 已作廢來源 → 409 + details.status="VOIDED"`；`AC-13: 已有修正版 → 409 + details.existingRevisionId`；`AC-13: 三者皆零寫入、零附件複製、零 storage 寫入` | T7 | PENDING |
| AC-14 | integration | `phase9-revision-attachment.test.ts` | `AC-14(a)(b): 每張 LINKED 附件複製為新列與新 storageKey，位元組 SHA-256 相同、縮圖同步複製`；`AC-14(c): 差旅段—圖對位複製，零跨段錯置`；`AC-14(d): 複製後各容器附件數仍在上限內`；`AC-14(e): storage 失敗 → 整筆回滾、零殘留、日誌零 storage key` | T6 | PENDING（D6=c 已裁定解鎖） |
| AC-15 | integration | `phase9-revision.test.ts` | `AC-15(a): 修正版完成後產生報表 → 新編號且序號為同月同型下一號`；`AC-15(b): 新 storageKey 與新 PDF 位元組雜湊皆與原申請不同`；`AC-15(c): 原 Report 與其 PDF 位元組雜湊前後不變（BE-US-21④）`；`AC-15(d) 結構: report-number.ts 本 Phase 零 diff` | T9 | PENDING |
| AC-16 | integration | `phase9-void-statistics.test.ts` | `AC-16: 經真實作廢端點作廢後，sumOfficialMileage 恰等於未含該筆之值（PHASE-005 AC-04 真實流程回歸）`；`AC-16 結構: backend/src/mileage 全目錄零 diff` | T9 | PENDING |
| AC-17 | integration | `phase9-void-statistics.test.ts` | `AC-17(a): 保養草稿 computed.officialKm 於區間內差旅被真實作廢後下降對應值`；`AC-17(b): 折舊草稿年度公務里程同型`；`AC-17(c): 已完成之保養／折舊快照於作廢後逐欄不變` | T9 | PENDING |
| AC-18 | integration | `phase9-reference-guard.test.ts` | `AC-18(a): 五型別逐一——引用來源被作廢後仍判定為已被引用（COMPLETED-only mutant 必紅）`；`AC-18(b): 僅被草稿引用者仍判定為未被引用`；`AC-18(c): 既有 COMPLETED 正向判定逐型別零弱化` | T8 | PENDING（D2=a 已裁定解鎖） |
| AC-19 | integration | `phase9-void-report.test.ts` | `AC-19(a): ReportCommon 鍵集恰八鍵（toEqual 全等，多一鍵必紅）`；`AC-19(b): 三型 body 鍵集逐字不變`；`AC-19(c): byDisplayName 解析失敗以「—」呈現且輸出零 voidedById`；`AC-19(d): report-data.ts 零算式結構掃描維持全綠` | T10 | PENDING |
| AC-20 | unit | `report-html.test.ts` | `AC-20(a)(b): 已作廢列印版首屏 .void-banner 含「已作廢」＋原因／操作者／時間逐字`；`AC-20(c): 未作廢列印版零 .void-banner、零「已作廢」字樣`；`AC-20(d): 作廢原因 3 payload 跳脫（移除跳脫必紅）`；`AC-20(e): renderReportHtml 純函式性不變（同輸入 toEqual、零時鐘）`；`AC-20(f): .void-banner 具 avoid-break 且不套用 @media print 隱藏` | T11 | PENDING |
| AC-21 | integration | `phase9-void-report.test.ts` | `AC-21(a): 作廢版 PDF 同交易產生並校驗；任一階段失敗 → 整筆回滾、狀態仍 COMPLETED、零殘留、500 + details.stage`；`AC-21(b): 作廢後下載回作廢版且報表編號與檔名不變`；`AC-21(c): 原 Report PDF 位元組雜湊前後不變`；`AC-21(d): 作廢後重複下載位元組全等且渲染器零呼叫`；`AC-21(e): 未產生報表者作廢 → 零渲染零 storage 寫入`；`AC-21(f): reports/ 零 report.update／delete／upsert 之既有結構斷言零改動且全綠` | T12 | PENDING（D4=b1 已裁定解鎖） |
| AC-22 | integration | `phase8-report-print.test.ts` | `AC-22: 已作廢申請列印端點 200 且含作廢標示；草稿仍 409 + details.status（既有斷言零弱化）`；`AC-22: VOIDED 狀態下之列印端點授權五格逐格重驗` | T13 | PENDING（D5=a 照推薦已裁定解鎖） |
| AC-23 | integration | `phase9-contract.test.ts` | `AC-23: 授權矩陣 10 格逐格（狀態碼 + 回應鍵集）`；`AC-23: 報表四端點於 VOIDED 之回歸四格`；`AC-23: 403 回應零業務值掃描` | T4 ＋ T7 | PENDING |
| AC-24 | integration | `phase9-void.test.ts` | `AC-24: 作廢成功寫入恰一筆 AuditLog(APPLICATION_VOIDED)，欄位與 summary 形狀逐鍵`；`AC-24 同交易自證: 稽核 hook 拋錯 → 業務寫入一併回滾（零孤兒稽核列、狀態未變）`；`AC-24: 本人作廢亦寫稽核（正向斷言）` | T4 | PENDING |
| AC-25 | integration | `phase9-contract.test.ts` | `AC-25: AuditLog.summary 與 logStream 七類敏感字串零命中`；`AC-25: 作廢原因入稽核但零入日誌（含反向探針證明掃描非恆真）` | T4 | PENDING |
| AC-26 | integration | `phase9-void.test.ts`；`phase9-revision.test.ts` | `AC-26(a): 管理員代作廢 → actorId=管理員、targetId=擁有人`；`AC-26(b): 管理員代建修正版 → APPLICATION_CREATED_ON_BEHALF + summary.revisionOf（不新增第二個 enum 值）`；`AC-26(c): 本人建修正版 → 零稽核列`；`AC-26(d): 管理員作廢自己的申請仍寫 APPLICATION_VOIDED` | T4 ＋ T7 | PENDING |
| AC-27 | integration | `phase9-contract.test.ts` | `AC-27: ErrorCode 聯集與 PHASE-008 結案基線逐字相同（BOGUS mutant 必紅；本 Phase 零新增碼）`；`AC-27: 兩端點錯誤表逐格（401／403／404／409+details／400+fields／500）` | T4 | PENDING |
| AC-28 | integration | `phase9-contract.test.ts` | `AC-28: 七類日誌掃描擴及作廢／修正版／附件複製／upload-service 補償路徑`；`AC-28 反向探針: 直接寫入七類敏感字串證明掃描非恆真`；`AC-28: 錯誤日誌行含 requestId` | T18 | PENDING |
| AC-29 | frontend | `VoidApplicationDialog.test.tsx` | `AC-29: 空原因／僅空白 → 確認鈕停用且零 POST`；`AC-29: 送出中按鈕停用（防重複提交）`；`AC-29: 400 逐字顯示欄位錯誤；409 顯示狀態衝突並提供重新載入`；`AC-29: 取消 → 零請求零狀態變更` | T14 | PENDING |
| AC-30 | frontend | 三型頁測試檔；`ApplicationListSection.test.tsx` | `AC-30(a): 列表狀態欄逐字「已作廢」`；`AC-30(b): 狀態篩選「已作廢」可查得該筆`；`AC-30(c): 詳情頁逐字顯示作廢原因／操作者／時間` | T15 | PENDING |
| AC-31 | frontend | 三型頁測試檔；`ReportSection.test.tsx` | `AC-31(a): VOIDED 渲染唯讀分支（非草稿編輯表單）——三型各一`；`AC-31(b): 唯讀頁零儲存／完成／刪除／作廢／建立修正版按鈕`；`AC-31(c): 零任何恢復為已完成之控制項`；`AC-31(d): ReportSection 於 VOIDED 顯示下載與列印入口、零產生按鈕；未產生報表者顯示說明文字` | T14 ＋ T15 | PENDING |
| AC-32 | frontend | 三型頁測試檔 | `AC-32(a): 已完成頁出現「建立修正版」按鈕（取代佔位文案）`；`AC-32(c): 原頁顯示指向修正版之連結、修正版頁顯示指向原申請之連結`；`AC-32(d): 附件區提示含「如需修正附件，請建立修正版」` | T16 | PENDING |
| AC-33 | frontend | `VoidApplicationDialog.test.tsx` | `AC-33: 五態` › `Loading：作廢中停用`／`Empty：未作廢不渲染作廢資訊區塊`／`Error：400／409／500 各一`／`Success：轉為唯讀檢視並顯示三項作廢資訊`／`Permission denied：403 零後續請求` | T14 | PENDING |
| AC-34 | e2e | `e2e/void-application.spec.ts` | `AC-34: 375px 下作廢對話框／作廢資訊區塊／版本關係區塊／已作廢列印版皆無水平溢位` | T17 | PENDING |
| AC-35 | e2e | `e2e/void-application.spec.ts` | `AC-35: 兩型端到端（完成→產生報表→作廢→列表已作廢→詳情三項→列印版標示→下載→統計不含該筆）`；`AC-35: 草稿無作廢入口（負向）` | T17 | PENDING |
| AC-36 | e2e | `e2e/revision.spec.ts` | `AC-36: 修正版端到端（建立→複製欄位與附件→完成→新編號→版本關係雙向→原報表編號未變）` | T17 | PENDING |
| AC-37 | 全 Task ＋ 終審 | —（無單一測試載體；以三套件實跑數為證） | 每個 Task 之 Done When 含「既有測試零弱化」；終審三套件實跑對照基準線（後端 2952／前端 254／E2E 44） | 全 Task | PENDING |
| AC-38 | integration | `phase9-contract.test.ts` | `AC-38: upload-service 補償刪檔與非預期錯誤路徑之日誌零 storage key（修復前必紅之紅燈證據記入 Handoff）` | T18 | PENDING（D14 照推薦已裁定解鎖） |
| AC-39 | integration | `phase9-void-report.test.ts` | `AC-39(a) 結構: report-data.ts 之 orderBy 含 { id: "asc" } 恰兩處（移除任一處必紅）`；`AC-39(b): 保養／折舊路徑之同 linkedAt 三附件恆依 id 遞增序輸出（寫入序與 id 序刻意相反）` | T10 ＋ T18 | PENDING |
| AC-40 | e2e ＋ integration | `e2e/report-print-layout.spec.ts`（檔頭）；`phase8-contract.test.ts` | `AC-40(a): 檔頭字型敘述更正為子集字型 Tj／ToUnicode（記載型，無斷言變更）`；`AC-40(b): REPORT_GENERATION_FAILED 改經 AppError 後 wire 格式逐字不變（鍵集與值全等）` | T18 | PENDING（D14 照推薦已裁定解鎖） |

> **本表統計**：**40 條 AC**；映射表 **44 列**（AC-01 拆為 (a)(c)(d)(h)／(b)／(e)／(f)／(g) **五列**，其餘 AC-02~AC-40 各一列 ＝ 39 列）。其中 **8 列標記 `PENDING（Spec Gate 2026-08-07 裁定後解鎖）`**——**6 條完整 AC**（AC-14／AC-18／AC-21／AC-22／AC-38／AC-40）＋ **AC-01 之兩個子項**（(b) 依 D4、(e) 依 D10）。

---

## 13. Architecture / Data Flow 需同步項清單（**本 Phase 不修改該二檔**；結案 DOC-SYNC 批次處理）

| # | 目標檔／節 | 同步內容 |
|---|---|---|
| 1 | `ARCHITECTURE.md` §3 模組表 `applications` 列 | 補記本 Phase 落點：`application-void.ts`（作廢編排與 DTO 作廢區塊）／`application-revision.ts`（修正版複製）／`void-reason.ts`（原因驗證純函式）；兩個新端點掛於既有 `routes.ts` |
| 2 | `ARCHITECTURE.md` :107（狀態機） | 由「允許：……已完成→已作廢、已完成→建立修正版草稿」之**規劃語氣**改為**已落地**，並補記 `ALLOWED_TRANSITIONS` 恰兩條、`VOIDED` 為終態且無任何回復路徑（結構性守門） |
| 3 | `ARCHITECTURE.md` :144（報表為不可變產物） | 補記 D4 裁定之落地形狀：`Report` 仍**零更新路徑**；作廢版 PDF（若 D4(b1)）以獨立 `VoidedReportFile` 承載，原 PDF 位元組永不被觸碰 |
| 4 | `ARCHITECTURE.md` :158（統計過濾條件） | 補記「作廢已真實可達」並補記**引用保護面之 `status` 集合為 `{COMPLETED, VOIDED}`（D2）**——與統計面之 `COMPLETED` 單值刻意不同，附差異理由（歷史可解釋 vs 統計有效性） |
| 5 | `ARCHITECTURE.md` :148（稽核） | 補列 `APPLICATION_VOIDED`（本人與管理員皆寫）之新事件值 |
| 6 | `DATA_FLOW.md` §1.1 實體摘要 `Application` 列 | 「作廢原因/操作者/時間、版本關聯」由概念改為落地欄位（`voidReason`／`voidedAt`／`voidedById`／`supersedesId`），並註明四欄皆 nullable、零回填 |
| 7 | `DATA_FLOW.md` §1 概念圖 | `Application 0..1 ──self── Application` 補註 `supersedesId @unique`（0..1 之落地依據）；（條件）新增 `Report 0..1───1 VoidedReportFile` |
| 8 | `DATA_FLOW.md` §1.2 關鍵不變式 | 新增三條：①作廢為狀態取代且不可逆；②作廢不改寫任何金額或快照；③原申請與其修正版**同時可被統計計入**（D15 之裁定結果，據實記載） |
| 9 | `DATA_FLOW.md` §2.5／§2.6 | 以本 Spec §9.1／§9.2 之落地流程取代概要流程（含交易邊界、補償刪檔、稽核同交易、附件複製） |
| 10 | `DATA_FLOW.md` §3 敏感資料彙整 | 新增「作廢原因」列（入 DB 與稽核、**不入日誌**、呈現須跳脫）；「正式 PDF」列補記作廢版之處置 |
| 11 | `PROJECT_STATE.md` 跨 Phase 追蹤（**大總管白名單**） | ①**T10 FW「VOIDED 引用語意」已於本 Phase 結案**（依 D2）；②AR-7／tiebreaker／Type0-CID／`buildErrorBody` 四項之結案或續留；③新增「PHASE-010 稽核頁須納入 `APPLICATION_VOIDED`」；④新增「PHASE-011 備份與孤兒清理須涵蓋 `VoidedReportFile` 之 `rpt/` 物件」 |

---

## 14. Rollback

| 情境 | 處置 |
|---|---|
| **Spec 未批准／方向翻轉** | 分支未合併，直接棄用 `phase-009` 分支；`main` 零影響 |
| **Task 層失敗** | 單一 atomic commit 還原（`git revert`）；除 T1（migration）外皆為新增檔或既有檔之加法式修改 |
| **migration 回滾** | 逆序：`ALTER TABLE "Application" DROP COLUMN`（四欄）＋（條件）`DROP TABLE "VoidedReportFile"`。**`AuditAction` 之新 enum 值因 PostgreSQL 限制不可移除**，保留為未使用值屬無害（沿 PHASE-004 :400 既有先例）。**既有資料零補償**——四欄皆 nullable 且零回填 |
| **已作廢資料之回滾** | `DROP COLUMN` 會**遺失作廢原因／操作者／時間**，但 `status='VOIDED'` 仍留在 `Application`（enum 值本即存在），將形成「已作廢但無原因」之列。**回滾前須先匯出該四欄**；開發期為合成資料，風險可控 |
| **已保存之作廢版 PDF** | 回滾後 volume 上該些 `rpt/` 物件成為孤兒。開發期直接刪除；正式環境須先匯出（Runbook 待辦，與 PHASE-008 §14 同型） |
| **修正版已建立之附件副本** | 回滾不刪除副本檔案（新 `Attachment` 列若隨資料回滾而消失則成孤兒）。開發期為合成資料；正式環境列 Runbook 待辦 |
| **引用保護語意回滾（D2）** | 純程式變更，`git revert` 即回復為 `COMPLETED`-only；**但期間若已有參數版本被覆寫，資料層無法回復**——故 D2 一經批准即視為長期承諾（記於 §17.1） |

---

## 15. Task Graph

> 每 Task 一律 TDD、一個 atomic commit（含 Task ID）。**規模上限（治理 §10）：單 Task ≤ 5 AC、≤ 6 檔、不得同時橫跨 FE＋BE＋DB 三層。**
> **Expected Diff / usage 預算**依 `docs/retrospective/PHASE-008-usage.md` **§2.3（22 型態表）**（見下表「預算」欄，並標註所引型態）。**逾預算 50% 須即時回報（Stop Condition）**；大接線型**必拆兩段**（service／routes+tests），單段 ~200-300k。

| Task | 內容 | 層 | AC（≤5） | 檔案（≤6） | Risk | 依賴 | 預算（型態／usage 帶） | 機械連動預授權 | Done When |
|---|---|---|---|---|---|---|---|---|---|
| **T1** | `Application` 四欄 ＋（條件）`VoidedReportFile` ＋ `AuditAction` 新值 ＋ migration ＋ 安全網 ＋ 三類基線連動 | DB | AC-01(a)~(h) | `backend/prisma/schema.prisma`、`backend/prisma/migrations/*`、`backend/test/integration/phase9-migration-safety.test.ts`、既有基線測試檔（**六處表數／五處 enum／一處欄位集合**，合併計為 3 檔上限內之機械連動） | **High**（不可逆 migration ＋ 首度 `ALTER TABLE` 既有表 ＋ `ALTER TYPE`） | — | DB 安全網型／**~200-300k** | ✅ 表數 16→17 六處、`AuditAction` 五處、`Application` 欄位集合一處 | 乾淨與既有 DB 皆 migrate 成功且冪等；既有列十欄逐欄不變、四新欄恆 NULL；enum 聯集恰 +1；**raw SQL 型 baseline fixture**（FW-8）落地；`ALTER TYPE` 新值之跨交易使用限制有測試；drift guard 零改動全綠；**實查回報各類連動之實際處數** |
| **T2** | 狀態機擴充（`COMPLETED→VOIDED`）＋ 不可復原之結構性守門 | BE（純函式） | AC-02, AC-05(a) | `backend/src/applications/application-state-machine.ts`、`backend/test/unit/application-state-machine.test.ts` | **High**（不可逆狀態語意之單一事實來源） | T1 | 純函式 BE 型／**~110-160k** | — | 轉換集合恰 2 條；四種非法轉換逐一綠；`ALLOWED_TRANSITIONS.length` 斷言更新且**不弱化**；全域零 `VOIDED→COMPLETED` 寫入路徑之掃描綠；**既有鑑別性斷言零弱化；轉換集合之基線斷言（`ALLOWED_TRANSITIONS.length` 等）得依 AC-02 重錨定（1→2），此為 AC-02 明文要求之受控擴充，非弱化**（原表述「既有測試零改寫（只增）」與 AC-02 內在不相容，已於 `SPEC-REV-9T2` 更正） |
| **T3** | 作廢 service：原因驗證 ＋ 交易 ＋ 四欄寫入 ＋ 三型 DTO 之 `void` 區塊 | BE | AC-03, AC-04, AC-06, AC-07, AC-08 | `backend/src/applications/void-reason.ts`（新）、`backend/src/applications/application-void.ts`（新）、`travel-service.ts`、`maintenance-service.ts`、`depreciation-service.ts`、`backend/test/integration/phase9-void.test.ts` | **High**（不可逆狀態轉換 ＋ 快照保護） | T2 | 大接線之 service 段／**~200-300k** | — | gate table 12 列綠；400／409 皆零寫入；快照逐欄不變之逐欄斷言綠；B-08 併發雙作廢恰一成功；三型 DTO 之 `void` 區塊正負向皆綠 |
| **T4** | 作廢端點 ＋ 授權矩陣 ＋ 稽核（同交易）＋ 錯誤合約 | BE | AC-05(b), AC-23（作廢列）, AC-24, AC-25, AC-27 | `backend/src/applications/routes.ts`、`backend/src/applications/application-void.ts`、`backend/test/integration/phase9-void.test.ts`、`backend/test/integration/phase9-contract.test.ts` | **High**（授權 ＋ 稽核可追溯性） | T3 | 接線端點（授權矩陣型）／**~230-330k** | — | 授權五格逐格綠；判定順序側信道測試綠；稽核同交易回滾自證綠；`ErrorCode` 聯集全等（BOGUS mutant 必紅）；本人作廢寫稽核之正向斷言綠 |
| **T5** | 修正版複製 service（三型欄位逐欄複製 ＋ 版本關聯 ＋ 原申請零改動） | BE | AC-09, AC-10, AC-11 | `backend/src/applications/application-revision.ts`（新）、`travel-service.ts`、`maintenance-service.ts`、`depreciation-service.ts`、`backend/test/unit/revision-copy.test.ts`、`backend/test/integration/phase9-revision.test.ts` | **High**（歷史不可變 ＋ 資料複製正確性） | T1 | 大接線之 service 段／**~200-300k** | — | 複製／禁複製鍵集 `toEqual` 封閉且多複製一欄必紅；原申請逐欄 ＋ 原 PDF 雜湊前後不變；三型各一正向；**既有 `create*Draft` 之簽章與行為零改變** |
| **T6** | 修正版之附件複製（位元組複製 ＋ 段對位 ＋ 失敗補償） | BE | AC-14 | `backend/src/applications/application-revision.ts`、`backend/src/attachment/attachment-service.ts`（或新 `attachment-copy.ts`）、`backend/test/integration/phase9-revision-attachment.test.ts` | **High**（附件權限 ＋ storage 寫入 ＋ 補償語意） | T5, **D6 批准** | 重 Lite／複合修復型／**~140-200k** | — | 位元組 SHA-256 相同、key 互異；段對位零錯置；上限仍成立；失敗回滾零殘留；日誌零 storage key；新列 `ownerId` ＝原擁有人 |
| **T7** | 修正版端點 ＋ 版本關聯查詢 ＋ 來源守門 ＋ 代操作稽核 | BE | AC-12, AC-13, AC-23（修正版列）, AC-26 | `backend/src/applications/routes.ts`、`backend/src/applications/application-revision.ts`、`backend/test/integration/phase9-revision.test.ts`、`backend/test/integration/phase9-contract.test.ts` | **High**（授權 ＋ 稽核） | T5（T6 若批准則亦依賴） | 接線端點（授權矩陣型）／**~230-330k** | — | 授權五格逐格綠；三種 409 逐一且零寫入零 storage 寫入；雙向版本關聯正負向綠；代操作／本人之稽核差異綠 |
| **T8** | 參數引用保護之 `VOIDED` 語意 | BE | AC-18 | `backend/src/parameters/reference-guard.ts`、`backend/test/integration/phase9-reference-guard.test.ts` | **High**（資料保存／歷史不可覆寫） | T3, **D2 批准** | 重 Lite 型／**~115-200k** | — | 五型別逐一綠；`COMPLETED`-only mutant 必紅；草稿仍判「未引用」；既有正向零弱化 |
| **T9** | 統計排除之真實流程回歸 ＋ 修正版新編號實證 | BE（測試為主） | AC-15, AC-16, AC-17 | `backend/test/integration/phase9-void-statistics.test.ts`、`backend/test/integration/phase9-revision.test.ts` | **High**（金額與里程正確性之最終守門） | T4, T7 | 揭露面／矩陣密度型下緣／**~160-230k** | — | 三個統計消費端皆排除；`mileage/` 零 diff 結構斷言綠；已完成快照不因後續作廢而變；新舊報表編號與 PDF 雜湊之四項斷言綠；`report-number.ts` 零 diff |
| **T10** | `ReportData` 作廢欄位擴充 ＋ tiebreaker 守門 | BE | AC-19, AC-39 | `backend/src/reports/report-data.ts`、`backend/test/integration/phase9-void-report.test.ts`、`backend/test/integration/phase8-report-data.test.ts`（鍵集基線） | **High**（敏感資料揭露面 ＋ 封閉鍵集） | T3 | 純函式／資料層／**~140-200k** | ✅ `ReportCommon` 鍵集七→八；（若新增 `reports/*.ts` 檔則）`PHASE_008_SRC_FILES` 九檔清單 | 鍵集 `toEqual` 封閉且多一鍵必紅；三型 body 鍵集逐字不變；零算式掃描維持；`orderBy` `id asc` 恰兩處之結構斷言綠 |
| **T11** | 列印版作廢標示版型（`.void-banner`） | BE（純函式） | AC-20 | `backend/src/reports/report-html.ts`、`backend/test/unit/report-html.test.ts` | **High**（XSS ＋ 使用者可見輸出） | T10 | 版型（矩陣密度型）下緣／**~160-230k** | — | 首屏標示與三項資訊逐字綠；未作廢負向綠；3 payload 跳脫且移除跳脫必紅；純函式 `toEqual` 與零時鐘不變；`avoid-break` 在場且未被 `@media print` 隱藏 |
| **T12** | 作廢版 PDF 之產生、保存與下載語意 | BE | AC-21 | `backend/src/applications/application-void.ts`、`backend/src/reports/report-service.ts`、`backend/src/reports/routes.ts`、`backend/test/integration/phase9-void-report.test.ts` | **High**（不可逆產物 ＋ 交易 ＋ 補償） | T11, **D4 批准** | 大接線（渲染＋儲存＋交易）／**~200-300k** | ✅（若擴 `reports/` 檔）`PHASE_008_SRC_FILES` | 四階段失敗注入各自零殘留且狀態仍 `COMPLETED`；作廢後下載回作廢版且編號不變；原 PDF 雜湊不變；重複下載位元組全等且渲染器零呼叫；`reports/` 零更新路徑之既有結構斷言全綠 |
| **T13** | 列印端點對 `VOIDED` 放行 ＋ 授權矩陣回歸 | BE | AC-22 | `backend/src/reports/routes.ts`、`backend/test/integration/phase8-report-print.test.ts` | **High**（授權面 ＋ 側信道） | T11, **D5 批准** | 接線端點下緣／**~160-230k** | — | `VOIDED` 200 且含標示；草稿 409 之既有斷言零弱化；五格授權於 `VOIDED` 逐格綠 |
| **T14** | 前端元件層：作廢對話框 ＋ API client ＋ `ReportSection` 之 `VOIDED` 放行 | FE | AC-29, AC-31(d), AC-33 | `frontend/src/api/applications.ts`、`frontend/src/components/VoidApplicationDialog.tsx`（新）、`frontend/src/components/ReportSection.tsx`、`frontend/src/index.css`、`frontend/test/VoidApplicationDialog.test.tsx`、`frontend/test/ReportSection.test.tsx` | Medium | T4 | FE 頁面型／**~140-195k** | — | 空原因零 `POST`；送出中停用；取消零請求；403 零重試；`VOIDED` 顯示兩入口且零產生按鈕；既有 `ReportSection` 測試零弱化 |
| **T15** | 前端三型詳情頁：作廢入口 ＋ `VOIDED` 唯讀分支 ＋ 作廢資訊 ＋ 列表徽章 | FE | AC-30, AC-31(a)~(c) | `TravelApplicationPage.tsx`、`MaintenanceApplicationPage.tsx`、`DepreciationApplicationPage.tsx`、三型頁測試檔（**合計 6 檔**） | Medium | T14 | FE 頁面型／**~140-195k** | — | 三型各有 `VOIDED` 唯讀分支（**現況缺陷之修復**）；唯讀頁五類按鈕逐一負向；三項作廢資訊逐字；既有三頁測試零弱化 |
| **T16** | 前端修正版：入口按鈕 ＋ 版本關係區塊 ＋ 文案更新（含 FE-US-21④／AD-US-08③） | FE | AC-32, AC-34（DOM 面） | 三型頁 ＋ 三型頁測試檔（**合計 6 檔**） | Medium | T15, T7 | FE 頁面型／**~140-195k** | — | 佔位文案「功能將於後續版本提供」**逐字移除**且以真實入口取代；雙向連結逐一；附件區提示逐字；既有測試零弱化 |
| **T17** | E2E Gate：作廢與修正版端到端 ＋ 375px | E2E | AC-34, AC-35, AC-36 | `e2e/void-application.spec.ts`（新）、`e2e/revision.spec.ts`（新） | Medium | T13, T16 | E2E Gate 型／**~185-265k** | — | 兩型作廢情境全綠（大總管親跑於 dev 拓撲）；修正版端到端全綠；播種冪等；草稿無入口負向；375px 零溢位 |
| **T18** | chore：AR-7 洩漏修復 ＋ tiebreaker 行為測試 ＋ 檔頭更正 ＋ `buildErrorBody` 回歸 | BE ＋ E2E（檔頭） | AC-28, AC-38, AC-39(b), AC-40 | `backend/src/attachment/upload-service.ts`、`backend/src/reports/routes.ts`、`backend/test/integration/phase9-contract.test.ts`、`backend/test/integration/phase8-contract.test.ts`、`e2e/report-print-layout.spec.ts`（僅檔頭註解） | Medium | T12, **D14 批准** | 多項合併修復（≥4 項移交）→ **逐項累加，勿套單項帶**／**~150-250k** | — | AR-7 修復前必紅之紅燈證據；日誌掃描擴上傳路徑 ＋ 反向探針；保養／折舊 tiebreaker 行為測試綠；`buildErrorBody` 改道後 wire 格式逐字不變；檔頭敘述與實測相符 |

> **AC-37（零弱化與基準線）**：不設獨立 Task——寫入**每個 Task 之 Done When**，並由終審以三套件實跑數對照基準線（後端 **2952**／前端 **254**／E2E **44**）核對。

### 15.1 依賴圖

```
T1 ──┬──▶ T2 ──▶ T3 ──┬──▶ T4 ──┐
     │                 ├──▶ T8   │
     │                 └──▶ T10 ─┴──▶ T11 ──┬──▶ T12 ──┐
     └──▶ T5 ──┬──▶ T6                       └──▶ T13 ──┤
               └──▶ T7 ──┐                              │
                          ├──▶ T9                       │
              T4, T7 ─────┘                             │
                        T4 ──▶ T14 ──▶ T15 ──▶ T16 ─────┴──▶ T17
                                       T12 ──▶ T18
```

**TDD 順序建議**：T1（安全網先建立）→ T2（狀態機單一事實來源）→ T3／T5（兩條主線之 service，可先後不可併跑 vitest）→ T4／T7（端點與授權）→ T6（附件複製）→ T8（引用保護）→ T9（統計回歸）→ T10／T11（報表資料與版型）→ T12／T13（PDF 與列印端點）→ T14/T15/T16（前端）→ T17（E2E Gate）→ T18（chore 收尾）。

### 15.2 規模上限自查

| Task | AC 數 | 檔數 | 跨層 | 合規 |
|---|---|---|---|---|
| T1 | 1（AC-01 之八個子項） | 3（＋既有基線測試檔之機械連動） | DB only | ✅ |
| T2 | 2 | 2 | BE only（純函式） | ✅ |
| T3 | 5 | 6 | BE only | ✅ |
| T4 | 5 | 4 | BE only | ✅ |
| T5 | 3 | 6 | BE only | ✅ |
| T6 | 1 | 3 | BE only | ✅ |
| T7 | 4 | 4 | BE only | ✅ |
| T8 | 1 | 2 | BE only | ✅ |
| T9 | 3 | 2 | BE only（測試為主） | ✅ |
| T10 | 2 | 3 | BE only | ✅ |
| T11 | 1 | 2 | BE only（純函式） | ✅ |
| T12 | 1 | 4 | BE only | ✅ |
| T13 | 1 | 2 | BE only | ✅ |
| T14 | 3 | 6 | FE only | ✅ |
| T15 | 2 | 6 | FE only | ✅ |
| T16 | 2 | 6 | FE only | ✅ |
| T17 | 3 | 2 | E2E only | ✅ |
| T18 | 4 | 5 | BE ＋ E2E 檔頭（**非**跨三層） | ✅ |

> **無任何 Task 同時橫跨 FE＋BE＋DB 三層。** T1 為唯一含 schema／migration 之 Task。**T18 觸及 `e2e/report-print-layout.spec.ts` 之範圍限於檔頭註解**，不得改動任何斷言（Packet 須明文限縮）。**T3／T5 各觸三個既有 service 檔**，範圍限於「新增作廢區塊／複製函式」，**不得改動任何既有完成流程或計算路徑**（Packet 須明文限縮）。

### 15.3 與 PRD §PHASE-009「初始 Task Graph 概要」之對照

| PRD Task | 本 Spec 落點 | 說明 |
|---|---|---|
| T1 版本關聯欄位 ＋ 作廢欄位 ＋ migration | **T1** | 一致；另納入 `AuditAction` 新值與三類基線機械連動 |
| T2 建立修正版（複製為新草稿、原不可變、版本關聯）（**High**） | **T5 ＋ T6 ＋ T7** | 拆分為三（service／附件複製／端點與授權——規模上限） |
| T3 作廢流程（必填原因、二次確認後端驗證、不可復原）（**High**） | **T2 ＋ T3 ＋ T4** | 拆分為三（狀態機／service／端點與稽核） |
| T4 統計排除回歸（**High**） | **T9** | 一致；另納入 **T8**（引用保護之 `VOIDED` 語意——PRD 未列，源自 PHASE-007 T10 FW） |
| T5 作廢報表／PDF 標示保留（**High**） | **T10 ＋ T11 ＋ T12 ＋ T13** | 拆分為四（資料／版型／PDF 產生保存／列印端點） |
| T6 管理員代作廢／代修正版 ＋ 稽核（**High**） | **T4 ＋ T7 之稽核與授權面** | 未另立 Task——代操作與本人流程共用同一端點，僅稽核分支不同（避免重複實作） |
| T7 前端：修正版入口、作廢確認、作廢標示、版本關係顯示 | **T14 ＋ T15 ＋ T16 ＋ T17** | 拆分為四（元件／詳情頁／修正版 UI／E2E） |
| （PRD 未列） | **T8**（引用保護）、**T18**（跨 Phase chore） | T8 源自 PHASE-007 T10 即審 FW 之人類裁定項；T18 為四項跨 Phase 移交之收尾 |

**High 風險 Task 清單（須於 Spec Gate 一併取得事前批准）**：**T1、T2、T3、T4、T5、T6、T7、T8、T9、T10、T11、T12、T13** 共 **13 項**。

> 與 PRD「High 風險 Task：T2–T6」之差異說明：PRD 之 T2~T6 對應本 Spec 之 T5/T6/T7（修正版）、T2/T3/T4（作廢）、T9（統計）、T10~T13（報表作廢面），**全數涵蓋**。本 Spec 另將 **T1**（不可逆 migration ＋ 首度 `ALTER TABLE` 既有表）與 **T8**（參數引用保護＝資料保存面）升為 High，依據為 `CLAUDE.md`「認證、授權、密碼、附件權限相關工作一律 High」與 PHASE-004/005a/006/007/008 之既有升級先例。**此升級為保守方向（增加人類批准面），不縮減任何既有 High 判定。**

### 15.4 Gate 規劃與走查腳本固化義務（跨 Phase 常設規則）

| Gate | 觸發時點 | 內容 | 走查腳本（**大總管產出**） |
|---|---|---|---|
| **Spec Gate（事前批准）** | 本 Spec 定稿後、任何 Task 開工前 | D1~D16 逐條裁定 ＋ **13 項 High Task 事前批准** ＋ 8 列條件 AC 之取捨 | `docs/verification/WALKTHROUGH-PHASE-009-SPEC-GATE.md` |
| **Mock Gate（作廢／修正版流程與作廢標示）** | T11／T15／T16 完成後（**PDF 與 E2E 可先不完備**） | 人類目視：作廢二次確認與原因欄之互動、已作廢唯讀頁三項資訊、版本關係雙向連結、**列印版作廢標示之版面**（首屏、不被分頁切開、原因長文字換行）、375px 可讀 | `docs/verification/WALKTHROUGH-PHASE-009-MOCK.md`（step-by-step，含每步預期畫面與判定準則） |
| **整合 Gate（端到端）** | 全 Task 完成 ＋ reviewer 清零後 | 作廢端到端（含統計即時排除之肉眼確認）、修正版端到端（含附件確實複製）、**容器內作廢版 PDF 之中文與標示目視**、失敗情境之畫面不顯示成功 | `docs/verification/WALKTHROUGH-PHASE-009-INTEGRATION.md` |
| **PR 合併批准** | 整合 Gate 通過後 | 人類決策，不授權代行 | — |

---

## 16. 需人類批准之決策點（D1 ~ D16）

> 每條格式：**為什麼要決定** ｜ **選項** ｜ **各選項影響** ｜ **推薦**。
> **凡未裁定者，相關 AC 與實作一律不得開工**（§12 已以 `PENDING（Spec Gate 2026-08-07 裁定後解鎖）` 標記受影響之 8 列）。
> 標記 **【High】** 者屬架構／安全／資料／成本／部署面，須於 Spec Gate 明示批准。

### D1 — 作廢與版本關聯之資料模型落點　**【High：資料模型 ＋ 不可逆 migration】**

**為什麼要決定**：本 Phase 需持久化「作廢原因／操作者／時間」與「版本關聯」四項資訊。落點一經 migration 即為不可逆資產；且這是 PHASE-004 建表以來**第一次對既有 `Application` 表執行 `ALTER TABLE`**，會使多份既有安全網測試之基線同步變動（§8.5）。

**選項**
- **(a) 四欄直接加在 `Application`**（`voidReason`／`voidedAt`／`voidedById`／`supersedesId`，皆 nullable、無 default）。
- (b) 作廢資訊獨立成 `ApplicationVoid` 表（1:1），版本關聯仍加欄於 `Application`。
- (c) 作廢資訊與版本關聯各自獨立成表（兩張新表，`Application` 零 `ALTER`）。

**影響**
- (a)：**零回填、零既有列改寫**（nullable 無 default 之 `ADD COLUMN` 在 PostgreSQL 11+ 為純中繼資料操作）；查詢最省（列表／詳情／統計皆單表可得，零 join）；代價＝觸發 `Application` 欄位集合基線之機械連動（**一處**，已預授權）。
- (b)：作廢資訊之寫入需多一次 insert 與 join；「三欄同生共死」之不變式由 DDL 保證（整列存在與否）——但實務上四欄同交易寫入，(a) 亦不會出現半套；額外一張表使表數與 join 成本上升，收益有限。
- (c)：`Application` 零 `ALTER`（避開機械連動），但**每次列表查詢都要 join 兩張表**（列表為最高頻查詢，PHASE-004 §10.2 已對其索引形狀做過設計），且版本關聯之 `0..1` 語意需靠額外唯一約束維持——複雜度顯著上升，只為了規避一次可控的基線更新。

**推薦**：**(a)**。理由：作廢與版本關聯皆為 `Application` 之**固有屬性**（狀態之附屬資訊），非獨立實體；`DATA_FLOW.md` :46 之既有概念模型即將其列於 `Application` 列內；機械連動已於 §8.5 逐處實查並預授權，成本可控且一次付清。

---

### D2 — `VOIDED` 是否算「參數版本已被引用」　**【High：資料保存 ＋ 歷史不可覆寫】**　**（PHASE-007 T10 即審 FW 之人類裁定項）**

**為什麼要決定**：`parameterHasReferences`（`reference-guard.ts` :114／:132）以 `application: { status: "COMPLETED" }` 判定引用。PHASE-007 T10 即審已預警：**一旦 `VOIDED` 真實可達，已作廢申請所引用之參數版本將被判為「無引用」而可被覆寫**——該過濾條件由「今日等價之防禦」變成「載重」。已作廢申請仍保有完整快照、仍可下載其正式 PDF、仍在稽核可追溯範圍內，其引用之參數版本若被覆寫，該歷史紀錄即不再可解釋。

**選項**
- **(a) `status ∈ {COMPLETED, VOIDED}` 皆算引用**（改動點：`reference-guard.ts` 兩處 `where`）。
- (b) 維持 `COMPLETED` only（已作廢者不保護）。
- (c) 完全移除 `status` 條件（凡持有該版本 id 之列即算引用）。

**影響**
- (a)：歷史可解釋性完整；代價＝參數版本更難被覆寫（但覆寫本即為例外操作，且 US 明文禁止覆寫被引用者）；**五個 `ParameterType` 一次改齊**（差旅四型 ＋ 折舊）。
- (b)：與 BE-US-19④「不得覆寫被引用的歷史內容」之意圖**直接抵觸**——已作廢申請仍是「歷史內容」；且此缺口**無測試會變紅**（今日等價之過濾條件明日成為載重，正是 T10 FW 預警之情形）。
- (c)：語意等價於 (a)（草稿從不寫快照欄，故不會誤判），但**移除了唯一的顯式狀態表達**，未來若出現「草稿也寫版本 id」之改動即靜默失效；且與既有檔頭註解（明言此條件為防禦性保留）相衝。

**推薦**：**(a)**。理由：US 之保護對象是「歷史內容」而非「有效申請」；作廢改變的是**統計有效性**，不改變**歷史存在性**。並明記與統計面之刻意差異：**統計面 `= COMPLETED`（單值）／引用面 `∈ {COMPLETED, VOIDED}`**，兩者不同步是**設計意圖**，須於 `ARCHITECTURE.md` §4 同步記載（§13 #4），以免後人「統一」而破壞其一。

---

### D3 — 作廢原因之驗證規則與持久化形式　**【使用者可見行為 ＋ 稽核內容】**

**為什麼要決定**：US 僅要求「非空」；長度上界、空白字元處理、是否入稽核之細節屬使用者可見行為與敏感資料面，須明示。

**選項**
- **(a)** `trim` 後長度 1..500；僅空白字元（含全形空白）視同空 → 400；持久化 `trim` 後值；原文入 `AuditLog.summary`。
- (b) 不 `trim`，僅檢查非空字串。
- (c) 更長上界（如 2000）或不設上界。

**影響**
- (a)：可預測、可測（gate table 12 列）；500 字元足以描述作廢理由；`trim` 使「按空白鍵繞過必填」不成立。
- (b)：`"   "` 可通過 → 違反 FE-US-26②／AD-US-10② 之意圖（「未填寫」之實質）。
- (c)：無上界使欄位可被當作附註濫用，並使列印版版面不可控（作廢原因會印在報表首屏）。

**推薦**：**(a)**。上界 500 為 spec-writer 之工程判斷（列印版首屏可容納且不破版），**若人類認為過短請於 Gate 指定新值**——變更上界屬 Spec 修訂，不得由 implementer 自行調整。

---

### D4 — 作廢後之「正式 PDF」語意　**【High：不可逆產物 ＋ US 字面 ＋ 已批准 AC 之連動】**

**為什麼要決定**：`userstory.md` **BE-US-22④**「申請已作廢且已有 PDF → 使用者下載 → **應提供保留作廢標示的正式報表**」與 **BE-US-27⑤**「報表已作廢 → 保留正式 PDF → 應保留**原始內容及可辨識的作廢狀態**」，與 PHASE-008 已落地並經人類批准之三項紀律存在張力：①`Report` 無更新／刪除路徑（結構性守門）；②下載端點**零渲染**、重複下載位元組全等（AC-08）；③FE-US-24②「再次下載 → 相同報表編號及**相同內容**」。**已產生之 PDF 位元組在作廢當下無法「長出」作廢標示**，必須選擇一種落地方式。

**選項**
- **(a) 原 PDF 位元組不變**；作廢狀態由**列印版**（即時渲染，必有標示）、詳情頁與列表承載；下載仍回原檔。
- **(b1) 作廢時同交易產生「作廢版 PDF」**（獨立 `VoidedReportFile` 表，§8.2），下載於 `VOIDED` 時回作廢版；原 PDF 位元組保留不動。渲染失敗 → **整筆作廢回滾**。
- (b2) 同 (b1) 但**延遲至首次下載時**產生並保存（作廢動作不渲染）。
- (c) 下載時即時疊加作廢浮水印（不保存）。

**影響**
- (a)：改動最小、風險最低、PHASE-008 全部 AC 零連動；**但 BE-US-22④ 之字面（「下載得到的正式報表帶作廢標示」）不成立**——離線流通之 PDF 看不出已作廢。**屬 US 字面之折衷，須人類明示接受。**
- (b1)：US 字面完整成立（下載即帶標示；原檔保留＝「保留原始內容」）；`Report` 仍零更新（守門全綠）；下載端點仍零渲染（AC-08 紀律維持）。代價＝**作廢動作可能因渲染失敗而失敗**（可重試）、作廢延時上升至 PDF 產生等級（目標 10 s）、一張新表 ＋ 表數基線連動（6 處）、storage 多一份 PDF。**FE-US-24② 之「相同內容」在作廢前後不同**（同一版本之內容因狀態改變而更新）——須人類明示接受此解讀。
- (b2)：作廢動作輕量且不受渲染器影響（正確性關鍵動作不被非關鍵依賴阻擋）；代價＝**下載端點成為寫入路徑**，PHASE-008 **AC-08「下載期間渲染器零呼叫」之結構斷言必紅**，須修訂一條已批准之 AC；且需處理併發首次下載（雙渲染／唯一鍵衝突）。
- (c)：**直接違反** AC-08（零渲染、位元組全等）與「保存不可變」之既有承諾；每次下載結果不可預測。**不可選。**

**推薦**：**(b1)**。理由：唯一能同時滿足 BE-US-22④ 與 BE-US-27⑤ 字面、又**不弱化任何 PHASE-008 已批准守門**的方案；失敗語意沿用 008 已驗證之「同生共死 ＋ 補償刪檔」形狀，實作風險最低。**若人類優先考量「作廢動作必須永遠成功、不受渲染器影響」，(a) 是唯一零風險選項——請於 Gate 明示，因為它等於接受 BE-US-22④ 字面不落地**（該情形下 AC-21 全列刪除、T12 取消、表數基線連動一併免除）。

---

### D5 — 列印端點對已作廢申請是否放行　**【公開 API contract】**

**為什麼要決定**：`GET /applications/:id/report/print` 現行守門為 `status !== "COMPLETED" → 409`（`reports/routes.ts` :299），故**已作廢申請開列印版會 409**——與 FE-US-23⑤「報表已作廢 → 開啟列印版 → 顯示明確作廢標示及作廢原因」直接衝突。

**選項**
- **(a) 放行 `COMPLETED ∪ VOIDED`**，草稿仍 409。
- (b) 維持現狀（已作廢不可列印）。
- (c) 放行全部狀態（含草稿）。

**影響**
- (a)：FE-US-23⑤ 成立；既有草稿 409 斷言與側信道紀律零弱化；改動為單一條件式。
- (b)：FE-US-23⑤ **無法落地**——該條 US 正是 PHASE-008 D14 延後至本 Phase 者，等於刪減已批准 US。
- (c)：草稿無快照、無金額，列印版會呈現半成品或觸發 `required()` 拋錯（PHASE-008 §11.2 已驗證）——且 PHASE-008 D11／SPEC-REV-T9 已就草稿之 409 語意做過人類裁定，不應翻案。

**推薦**：**(a)**。

---

### D6 — 修正版是否複製證明附件　**【High：附件權限 ＋ storage 生命週期 ＋ 使用者可見行為】**

**為什麼要決定**：FE-US-25①「複製原申請資料」未明示是否含附件；FE-US-21④ 又明文「**已完成申請的附件有誤 → 建立修正版**」——即修正版是修正附件的**唯一途徑**。保養完成須 ≥1 證明，若不複製，使用者必須重新上傳全部證明。

**選項**
- (a) **不複製**（修正版為空附件草稿，使用者自行重新上傳）。
- (b) **共用同一 `storageKey`**（新 `Attachment` 列指向同一物件）。
- **(c) 複製位元組**（新 `Attachment` 列 ＋ 新 `storageKey` ＋ 新縮圖）。

**影響**
- (a)：零風險、零成本；但「只改一個數字」的常見情境要求使用者重傳最多 5 張圖，且原圖可能已不在手邊（系統為唯一保存處）——與 FE-US-21④ 之意圖相悖。
- (b)：**危險**。既有附件生命週期中，`TEMP` 附件之刪除會**物理刪除 storage 檔**（`lifecycle-service.ts` §5.1）；修正版草稿之附件被解除關聯後成為 `TEMP`，其刪除將連帶刪掉**原已完成申請仍在引用**之位元組 → 不可逆資料損失。除非引入引用計數（超出本 Phase 範圍且風險高）。**不可選。**
- (c)：語意最貼近「複製原申請資料」；與既有生命週期完全相容（每個 `Attachment` 列擁有自己的物件，刪除語意不變）；代價＝storage 佔用（≤5 × 10 MB／次）與一次位元組搬移之延時（無影像處理，僅 I/O）。

**推薦**：**(c)**。並明定：新列 `ownerId` ＝**原擁有人**（授權面零變化）、`uploaderId` ＝實際操作者、複製失敗一律整筆回滾且補償刪檔（AC-14(e)）。**若人類選 (a)**，AC-14 全列刪除、T6 取消，並須於前端明示「修正版需重新上傳證明」之提示（屬使用者可見行為，一併批准）。

---

### D7 — 同一原申請可否有多個修正版　**【資料模型 ＋ 使用者可見行為】**

**為什麼要決定**：`DATA_FLOW.md` :25 之概念圖為 `Application 0..1 ──self── Application`（0..1），但 US 未明文。落地時決定 `supersedesId` 是否 `@unique`，一經 migration 即為不可逆約束。

**選項**
- **(a) `@unique`（0..1）**：一筆已完成申請至多一個修正版；重複建立 → 409 ＋ `details.existingRevisionId`。
- (b) 不設唯一：可建立多個修正版草稿。

**影響**
- (a)：與既有概念圖一致；避免「同一筆錯誤申請被建立五個修正版草稿」之混亂；**修正版草稿被刪除後約束自然釋放**（B-20），使用者仍可重來；修正版之修正版（鏈）不受影響（B-21）。
- (b)：無約束 → 版本關係變為 1:N，前端「版本關係」呈現需列表化，且「哪一個才是正式修正版」無從判斷（多個都完成時會重複計入統計，放大 D15 之問題）。

**推薦**：**(a)**。

---

### D8 — 已作廢申請可否建立修正版　**【使用者可見行為】**

**為什麼要決定**：FE-US-25①／AD-US-09① 皆以「**已完成**」為前提；作廢後之情形 US 未定義。

**選項**
- **(a) 僅 `COMPLETED` 可建立修正版**（`VOIDED` → 409）。
- (b) `COMPLETED ∪ VOIDED` 皆可。

**影響**
- (a)：與 US 字面一致；作廢後若要重報，直接建立新申請即可（零障礙），只是不帶版本關聯。
- (b)：多一條路徑與一組測試；語意上「修正一筆已作廢的申請」意義不明（作廢即表示該筆不成立，不需要「修正版」）；且與 D7 之唯一約束交互後更複雜。

**推薦**：**(a)**。

---

### D9 — 兩個新端點之路由形狀與錯誤碼　**【公開 API contract】**

**為什麼要決定**：端點路徑與錯誤碼一經落地即為公開契約；且需決定是否新增 `ErrorCode`。

**選項**
- **(a)** `POST /applications/:id/void` ＋ `POST /applications/:id/revision`，掛於既有 `applications/routes.ts`，型別分派沿既有 `typeProbe`；狀態不符 → **409 `CONFLICT` ＋ `details.status`**（沿 PHASE-008 D11 形狀），原因驗證失敗 → 400 `VALIDATION_ERROR` ＋ `fields[]`；**零新增 `ErrorCode`**。
- (b) 新增語意化錯誤碼（如 `APPLICATION_ALREADY_VOIDED`／`REVISION_ALREADY_EXISTS`）。
- (c) 以 `PATCH /applications/:id` ＋ body 動詞表達狀態轉換。

**影響**
- (a)：與既有 `/applications/:id/complete` 之形狀一致（動詞式子路徑）；`details` 攜帶區辨資訊即足；前端以 `code + details` 分流已有先例。
- (b)：`ErrorCode` 聯集擴張需連動 `phase7/8-contract.test.ts` 之聯集全等測試；語意收益有限（`details` 已可區辨）。
- (c)：把不可逆狀態轉換藏在通用更新端點中，與「已完成不可修改」之既有 `PUT` 語意衝突，且授權與守門難以獨立測試。

**推薦**：**(a)**。

---

### D10 — 作廢是否新增 `AuditAction` enum 值　**【稽核可追溯性 ＋ migration 型態】**　**（PHASE-008 D15 議題之續議）**

**為什麼要決定**：BE-US-31②／AD-US-14① 明列「作廢」為須留稽核之事件；既有 `AuditAction` 九個值中**無**合適者。PHASE-008 D15 曾就「報表產生」裁定不新增 enum（因 US 未列），本項與之相反——US 明列。

**選項**
- **(a) 新增恰一個值 `APPLICATION_VOIDED`**，本人與管理員作廢皆寫；修正版建立沿用既有 `APPLICATION_CREATED_ON_BEHALF`。
- (b) 新增兩個值（`APPLICATION_VOIDED` ＋ `APPLICATION_REVISION_CREATED`）。
- (c) 零新增：以 `APPLICATION_UPDATED_ON_BEHALF` 承載作廢。

**影響**
- (a)：滿足 US；migration 由純 `CREATE` 變為含 `ALTER TYPE`（**FW-8 之 raw SQL fixture 處置適用**，T1 成本上升，已計入 §15 預算）；`AuditAction` 基線連動 **5 處**（已預授權）；PHASE-010 稽核頁多一類。
- (b)：修正版建立本質即「代建立草稿」，既有值語意已足；多一個值使 PHASE-010 需多處理一類，收益低。
- (c)：**語意錯誤**——`*_ON_BEHALF` 之語意為「代操作」，但本人作廢也必須留痕；且以「更新」承載「作廢」會使稽核頁無法區分兩者，違反 AD-US-14「操作類型」可辨識之要求。

**推薦**：**(a)**。

---

### D11 — 修正版之報表編號與原報表之關係　**【記載型確認；已有既定設計】**

**為什麼要決定**：PHASE-008 §7.6-2 已設計「冪等鍵為 `Report.applicationId`，修正版為**新的 `Application` 列**，故天然取得新編號與新 PDF，原 `Report` 與其 PDF 不被觸碰」，並將**實證義務**移交本 Phase（§17.2-②）。此處為落地確認，非新裁量。

**選項**
- **(a) 確認沿用**：修正版完成後走既有產生端點即得新編號；本 Phase **對 `report-number.ts`／編號邏輯零改動**，僅補測試實證。
- (b) 為修正版設計「版本後綴」編號（如 `TRV-202608-0001-R1`）。

**影響**
- (a)：零程式變更即成立（PHASE-008 已預留）；編號規則單一（BE-US-26 之四條 AC 不受影響）。
- (b)：改變 BE-US-26 已批准之編號格式與其全部測試；且「同一版本已產生編號不得改變」之語意會被後綴混淆。

**推薦**：**(a)**。**併記**：AC-15(d) 以「`report-number.ts` 本 Phase 零 diff」之結構斷言，防止實作者為此改動編號器。

---

### D12 — 作廢／修正版之授權面（管理員可代行）　**【High：授權】**

**為什麼要決定**：既有「完成」端點經 PHASE-004 D17／006 D7(a)／007 D9(a) **三次**裁定為 **owner-only**（管理員不得代完成）。本 Phase 兩端點若放行管理員，需明示其與既有先例之差異依據。

**選項**
- **(a) 擁有人或管理員**（`assertOwnershipOrAdmin`）。
- (b) owner-only（比照完成端點）。
- (c) 作廢放行管理員、修正版 owner-only（或反之）。

**影響**
- (a)：**AD-US-09／AD-US-10 之逐字要求**（「替使用者建立修正版」「作廢任一使用者申請」）；與「完成」之差異有明確依據——完成是**代替使用者做申報決定**（US 從未授權），作廢與修正版是**資料修正**（US 明文授權管理員）。
- (b)：**直接違反** AD-US-09／AD-US-10，等於刪減已批准 US。
- (c)：US 對兩者一視同仁，無差別化依據。

**推薦**：**(a)**。並於 §6.1 記載此差異與依據，避免後續 reviewer 誤判為「授權面放寬」。

---

### D13 — 已作廢申請可否**首次**產生正式報表　**【公開 API contract】**

**為什麼要決定**：`POST /applications/:id/report` 現行守門為 `status !== "COMPLETED" → 409`。作廢後才想產生報表之情形 US 未定義。

**選項**
- **(a) 維持 409**（`VOIDED` 不可產生）。
- (b) 放行（產生帶作廢標示之報表）。

**影響**
- (a)：與 FE-US-22①「申請狀態為已完成 → 產生」之字面一致；既有斷言零改動；語意清楚（作廢即不再申報）。
- (b)：需處理「作廢版與正式版何者為主」之語意，且與 D4 之作廢版 PDF 機制重疊；US 無需求。

**推薦**：**(a)**。

---

### D14 — 跨 Phase chore 是否納入本 Phase　**【範圍】**

**為什麼要決定**：Packet 列出四項跨 Phase 移交（AR-7 洩漏修復、`report-data.ts` tiebreaker 守門、Type0/CID 敘述更正、`buildErrorBody` 回歸 `AppError`）。納入會擴大 Phase 範圍，不納入則持續累積。

**選項**
- **(a) 全數納入為獨立 chore Task（T18）**，其中 tiebreaker 之結構斷言併入 T10（因 T10 必觸 `report-data.ts`）。
- (b) 僅納入「觸檔必補」者（tiebreaker），其餘續留。
- (c) 全數不納入。

**影響**
- (a)：四項一次結清；T18 為 Medium 風險、預算 ~150-250k（多項合併型逐項累加）；**AR-7 為安全面（日誌洩漏）**，續留即續存風險。
- (b)：AR-7 之安全缺口續存至 PHASE-010／011；`buildErrorBody` 繞道之型別收斂缺口續存。
- (c)：與「觸檔必補」之既有紀律相衝（T10 必觸 `report-data.ts`）。

**推薦**：**(a)**。**併記**：`buildErrorBody` 回歸（AC-40(b)）為**內部技術債清理**，其驗收核心是「wire 格式逐字不變」——若人類認為風險不值得，可單獨否決 (b) 子項而保留其餘三項（AC-40(b) 刪除，AC-40(a) 保留）。

---

### D15 — 建立修正版後，原申請是否自動作廢　**【High：使用者可見行為 ＋ 金額統計正確性】**

**為什麼要決定**：**這是本 Phase 最重要的產品語意問題**。US 定義「修正版」為「保留舊資料並提交正確版本」（FE-US-25 標題），但**未要求**建立或完成修正版時自動作廢原申請。若不作廢，原申請與修正版**兩筆都是已完成**，`sumOfficialMileage` 與金額統計**兩筆都會計入** → 里程與補助金額**重複計算**。

**選項**
- **(a) 不自動作廢**（US 字面）：使用者需自行作廢原申請；前端於修正版完成後**明顯提示**「請記得作廢原申請，否則兩筆都會計入統計」。
- (b) **修正版完成時**自動作廢原申請（原因自動填入如「已由修正版 {編號} 取代」）。
- (c) **阻擋修正版完成**，直到原申請已作廢（完成阻擋碼多一條）。

**影響**
- (a)：與 US 字面完全一致、最小驚訝、零新增使用者可見行為；**風險＝使用者忘記作廢即造成重複計入**（金額正確性風險，且系統不會報錯）。此風險須記入 §17.1 已知限制，並由前端提示與 Gate 目視緩解。
- (b)：統計正確性最強；但屬**新增使用者可見行為**（一個動作連帶改變另一筆紀錄之狀態），且自動作廢之原因欄非使用者填寫，與 FE-US-26②「必填原因」之精神有張力；若修正版之後又被作廢，原申請已無法復原。
- (c)：統計正確性強且不自動改動任何紀錄；但增加一條完成阻擋，改變 BE-US-05 之完成語意，且使用者流程變為「先作廢再完成修正版」——與 FE-US-25「先建修正版、改好再完成」之敘述順序衝突。

**推薦**：**(a)**，**但強制搭配前端提示**（AC-32(c) 之版本關係區塊加註提醒文案）並將重複計入風險據實記入 §17.1。**spec-writer 明確揭露：本推薦係以「不改變已批准 US 原意」為最高優先；若人類更重視統計正確性，(b) 或 (c) 皆為合理選擇，但屬使用者可見行為之擴充，須於 Gate 明示批准並連動修訂 AC-15／AC-32 與 §17.1。**

---

### D16 — 已作廢申請之前端呈現範圍　**【使用者可見行為】**

**為什麼要決定**：現況三型詳情頁**沒有** `VOIDED` 分支——`status === "COMPLETED"` 分支之後即為草稿編輯分支（spec-writer 實查 `TravelApplicationPage.tsx` :496／`MaintenanceApplicationPage.tsx` :428／`DepreciationApplicationPage.tsx` :450），故已作廢申請會渲染**可編輯表單**（後端會拒絕寫入，但畫面誤導）。需決定唯讀頁之內容範圍。

**選項**
- **(a) 唯讀頁 ＝ 已完成檢視之全部內容（含快照與計算依據）＋ 作廢資訊區塊 ＋ 報表區塊（下載／列印）**，移除全部操作按鈕。
- (b) 極簡頁：僅顯示「本申請已作廢」＋ 原因／操作者／時間。
- (c) 沿用已完成檢視、僅加一條橫幅。

**影響**
- (a)：使用者仍可查閱歷史內容與下載報表（BE-US-22④ 之下載入口需要它）；FE-US-26④「查看詳細資料或報表 → 顯示作廢原因、操作者及時間」完整成立。
- (b)：使用者無法查閱已作廢申請之內容與報表——與 FE-US-26④「查看**詳細資料**」相衝。
- (c)：與 (a) 幾乎等價，差別僅在是否明確移除操作按鈕；但「移除按鈕」正是 FE-US-26⑤（不得提供恢復功能）與 AC-31(b) 之核心，不可省。

**推薦**：**(a)**。並列為 **Mock Gate 目視項**（唯讀頁之欄位齊全度與作廢橫幅之顯著性）。

---

## 17. 已知限制與跨 Phase 銜接

### 17.1 已知限制（本 Phase 明示不處理者）

1. **原申請與修正版之統計重複計入**（D15(a) 成立時）：系統**不會**阻止「原申請未作廢而修正版已完成」之狀態，兩筆將同時計入里程與金額統計。緩解＝前端提示 ＋ 版本關係顯示 ＋ Gate 目視；**根治須改為 D15(b)／(c)**，屬使用者可見行為之擴充。
2. **已完成快照不因後續作廢而回溯更新**：保養／折舊之已完成快照中所含之期間／年度公務里程，是**完成當下**的值；若其中某筆差旅事後被作廢，該快照**不變**（BE-US-18「歷史可重現」之直接後果）。此為刻意設計，非缺陷——但意味著「已完成的保養分攤比例」可能與「今天重算的結果」不同。
3. **引用保護一經放寬即為長期承諾**（D2(a)）：資料層無法回復已被覆寫之參數版本，故 D2 之裁定不宜反覆。
4. **作廢版 PDF 之產生依賴渲染器**（D4(b1) 成立時）：渲染器不可用時**作廢動作會失敗**（可重試）。若人類無法接受，正解是改採 D4(a)，**不得**由 implementer 自行降級為「作廢成功但 PDF 略過」。
5. **修正版附件複製之儲存成本**（D6(c) 成立時）：每次修正版最多複製 5 張 × 10 MB；孤兒清理屬 PHASE-011。
6. **無版本鏈之聚合視圖**：`supersedesId` 只表達**直接前身**；「一路追到最初版本」需遞迴查詢，本 Phase 不提供該 API 或 UI。
7. **作廢原因無內容審查與長度以外之驗證**：使用者可填任意文字（已跳脫，無注入風險），但系統不判斷其合理性。
8. **PHASE-008 §11.4 之 Type0/CID 敘述更正**不在本 Task 之 Allowed 檔案內（唯一可寫為 `docs/specs/PHASE-009.md`），僅 `e2e` 檔頭部分於 T18 更正——**PHASE-008 本體之更正仍待大總管另派**（§19 #4）。

### 17.2 與 PHASE-010／011 之銜接

| 目標 Phase | 移交事項 |
|---|---|
| **PHASE-010** | ①稽核檢視頁須納入 **`APPLICATION_VOIDED`**（操作者／時間／類型／受影響資料／原因摘要）；②AD-US-14「重要欄位前後摘要」對作廢事件之呈現形式（`summary` 已含 `reason`／`voidedAt`）；③AD-US-04「有歷史拒刪」之回歸此時已有**已作廢**資料可用（`userHasHistory` 對 `VOIDED` 天然計入，本 Phase 零改動）；④代操作稽核之完整性回歸（作廢與修正版兩類） |
| **PHASE-011** | ①備份還原須涵蓋 **`VoidedReportFile` 之 `rpt/` 物件**（若 D4(b1)）與**修正版複製之附件物件**；②孤兒清理排程須認得此二類新物件；③效能實測須涵蓋「作廢含 PDF 產生」之 10 s 目標與「修正版含附件複製」之 5 s 目標 |

### 17.3 本 Phase 結清之跨 Phase 追蹤項

| 項目 | 結清方式 |
|---|---|
| **PHASE-007 T10 即審 FW：VOIDED 引用語意** | §16 **D2** 裁定 ＋ AC-18（T8），五型別逐一，`COMPLETED`-only mutant 必紅 |
| **PHASE-008 D14 延後三條 US**（FE-US-23⑤／BE-US-27④⑤） | AC-19／AC-20／AC-22（列印標示）、AC-15（修正版新 PDF）、AC-21（作廢 PDF，依 D4） |
| **PHASE-008 §17.2 三項複用義務** | AC-19／AC-20（作廢欄與版型段）、AC-11(c)／AC-15(c)（位元組不變實證）、AC-10 折舊列（`applicationYear`／`annualTotalKm` 複製後重算） |
| **AR-7**（`upload-service` 日誌洩漏） | AC-38（T18，依 D14） |
| **`report-data.ts` tiebreaker 守門** | AC-39（T10 結構斷言 ＋ T18 行為測試） |
| **`buildErrorBody` 繞道** | AC-40(b)（T18，依 D14(b) 子項） |
| **PHASE-008 D15 稽核 enum 議題（009/010 再議）** | §16 **D10** 就本 Phase 之作廢事件作出結論（新增一值）；報表產生仍維持 008 D15(a) 之不新增 |

---

## 18. Spec 修訂紀錄

| 日期 | Task ID | 內容 | 批准依據 |
|---|---|---|---|
| 2026-08-07 | `PHASE-009-SPEC` | 初版 DRAFT：§0~§19 全文；**40 條 AC**、**18 個 Task**（13 項 High）、**16 個決策點**、**34 條邊界條件**（B-01~B-34）、**10 格授權矩陣（＋4 格報表端點於 `VOIDED` 之回歸）**、AC↔測試映射表 **44 列**（36 列 `PENDING`、**8 列 `PENDING（Spec Gate 2026-08-07 裁定後解鎖）`**）。跨 Phase 核銷十項逐項有落點（§0.3）。 | 待 Spec Gate |
| 2026-08-07 | `Spec Gate 通過`（大總管固化） | **人類 Spec Gate 通過，Spec 轉 `ACTIVE`**。裁定（AskUserQuestion 兩輪：四條重點細節裁定＋六項複述確認）：**D4=(b1)** 作廢時同交易另產作廢版 PDF（獨立 `VoidedReportFile` 表；渲染失敗整筆回滾可重試——人類知悉並接受此失敗語意）；**D15=(a)** 不自動作廢＋前端強提示，**人類明示接受「使用者忘記手動作廢時統計重複計入」之風險**（§17.1 已知限制據此生效）；**D2=(a)** `VOIDED` 仍算參數引用（統計面單值/引用面雙值為設計意圖）；**D6=(c)** 修正版附件複製位元組（(b) 共用 storageKey 依實查判不可選）；**其餘 D1/D3/D5/D7~D14/D16 十二條全數照推薦**；**13 項 High Task（T1~T13）事前批准**（之後不再逐項請示）。§12 之 8 列 `PENDING（Spec Gate 2026-08-07 裁定後解鎖）` 依上開裁定全數轉 `PENDING`（無刪除列——四條裁定皆採含該功能之選項）。走查腳本 `WALKTHROUGH-PHASE-009-SPEC-GATE.md` 結果欄同步回填。**Governance-Version 誤植勘誤**（08-05.1→08-04.1）併本列記錄。 | 人類 leonchih 2026-08-07（AskUserQuestion 複述確認「正確，Spec 轉 ACTIVE 開工」；固化於 `PROJECT_STATE.md` Spec Gate 列） |
| 2026-08-07 | `SPEC-REV-9T1` | **用詞勘誤（Lite）**：§2 **AC-01(a)**（:144）之 `voidedAt` 型別敘述由「timestamptz」更正為「**`timestamp(3)`**（沿全專案 `DateTime` 慣例，**非** timestamptz）」。**錯在 Spec 用詞、實作正確**——T1 已落地之 DDL 為 `ADD COLUMN "voidedAt" TIMESTAMP(3)`（`backend/prisma/migrations/20260807140000_phase9_void_revision_model/migration.sql` :6），與 `Application.completedAt`／`createdAt`／`Report.generatedAt` 等全部既有 `DateTime` 欄同型；spec-writer 本次**實查全 repo `prisma/migrations` 對 `timestamptz`／`WITH TIME ZONE` 之命中數為 0**，故若依原敘述做成 timestamptz，反而會成為全專案**第一個**不一致欄位。**同型字樣之全檔實查（據實列出）**：`timestamptz` 於本 Spec **僅此一處**——§8.1／§8.2 之 Prisma 區塊皆為 `DateTime?`、§8.3 推導表亦為 `DateTime?`（`VoidedReportFile.createdAt` 同理，實際 DDL 亦為 `TIMESTAMP(3)`），三處**皆正確**，本次零改動。**一律不變**：AC-01(a) 其餘三欄之敘述、可空性與「無 `DEFAULT`、不回填」義務、§8.1~§8.3 全部內容、§12 映射表（含狀態欄）、§16 全部決策、其他章節。**性質**：文件用詞勘誤（記錄型），**未改變任何 AC 之驗收語意、未縮減守門強度、未擴大 Scope、未改變任何已批准 US 原意**；**實作與測試無需任何變更**（`phase9-migration-safety.test.ts` 之逐欄型別斷言本即以實際 DDL 為準，零 diff）。**未修改** `userstory.md`／`docs/PRD.md`／任何程式或測試。Spec 狀態維持 `ACTIVE`。 | T1 即審 **SF-2**（reviewer `PHASE-009-T1-REVIEW`）；`PROJECT_STATE.md` T1 即審記錄列；大總管 2026-08-07 `SPEC-REV-9T1` Packet |
| 2026-08-07 | `SPEC-REV-9T2` | **映射與措辭修正（Lite）——三處失準逐處收口，AC 語意零變更**：**(a) §12 AC-02 列**——原列之第三個預定測試名 `AC-02 結構: Application 無任何與 status 正交之作廢布林欄（D8(a) 硬約束）` **於全 repo 不存在**（spec-writer 實查 `backend/test/` 零命中）；改為指向 **T1 已交付**之等效且更強守門 `AC-01(a): Application 之四個新欄 — 型別／可空性／無 default 逐欄符合 §8.1（14 欄封閉集合）`（`phase9-migration-safety.test.ts` :888——欄位集合封閉即涵蓋「零 `isVoided`／`voided` 布林欄」），並**註記 T1 即審 FW-3 之裁定：不得重造第二個較弱守門**（「寫入路徑列舉≠布林守門重造」界線判讀成立）；同列 unit 側兩條測試名依實際 `describe › it` 巢狀結構補全（含 `兩元素逐字為 [DRAFT, COMPLETED] 與 [COMPLETED, VOIDED]…`、`DRAFT→COMPLETED 與 COMPLETED→VOIDED 是僅有的兩個不拋格子（矩陣鑑別力總結，AC-02）`），Task 欄改 `T2（轉換集合）＋ T1（D8(a) 結構面）`。**(b) §12 AC-05 列**——原列「層級 ＝ integration／檔案 ＝ `phase9-void.test.ts`；`phase9-contract.test.ts`」與實際交付衝突：**AC-05(a) 實際由 T2 以 unit 交付於 `backend/test/unit/application-state-machine.test.ts`**；修正為 `unit（(a)）＋ integration（(b)）` 之分列，(a) 之四條測試名**以 `grep` 逐字回填**（含 T2R 後新增之自證 it `鑑別力自證（SF-3, T2R-LITE：真實 fixture 目錄實跑，非恆真式）…`），(b) 維持 T4 之預定名，Task 欄改 `T2（(a)）＋ T4（(b)）`。**(c) §11.1 狀態機列（:673）與 §15 T2 列 Done When（:816）**——原表述「既有測試零改寫（只增）」「既有，**只增不改**」與 AC-02 要求之 `ALLOWED_TRANSITIONS` **1→2** 內在不相容（照字面不可能同時成立）；改為「**既有鑑別性斷言零弱化；轉換集合之基線斷言得依 AC-02 重錨定（1→2），此為 AC-02 明文要求之受控擴充，非弱化**」。**一律不變**：AC-02／AC-05 之**字面與驗收語意**、全部 mutant 必紅義務、§12 兩列之**狀態欄**（維持 `PENDING`，實名回填仍併結案 DOC-SYNC）、其他 AC 與 §16 全部決策、其他章節之「只增不改」表述（`report-html`／`phase8-report-print`／三型 FE 頁四處，該四處無同型不相容問題，經實查後**刻意不動**）。**性質**：映射表準確性與措辭修正（記錄型），**未改變任何 AC 驗收語意、未縮減任何守門強度、未擴大 Scope、未改變任何已批准 US 原意**；**未修改** `userstory.md`／`docs/PRD.md`／任何程式或測試。Spec 狀態維持 `ACTIVE`。**併記（流程紀律）**：(c) 之不相容為 T2 開工時即可觀察之 Spec 內在矛盾，**implementer 依 AC-02 重錨定基線屬正確判讀，但未於當下請示即偏離 Packet 之「只增不改」字面**——此偏差據實記錄於本列，供大總管與後續 Task 引以為戒（正解為「發現 Spec 內在矛盾時回報，由 Spec 修訂先行」）。 | T2 即審 **SF-4**（reviewer `PHASE-009-T2-REVIEW`）；`PROJECT_STATE.md` T2 即審記錄列（含 FW-3 界線判讀成立之裁定）；大總管 2026-08-07 `SPEC-REV-9T2` Packet |

---

## 19. PRD 建議修正清單（**本 Task 未編輯 `docs/PRD.md`**）

| # | 位置 | 建議 | 理由 |
|---|---|---|---|
| 1 | PRD :484「對應 US」 | 補列 **BE-US-31**（作廢稽核）、**BE-US-05**（狀態機第 3／4 條）、**FE-US-21④**、**AD-US-08③**、**BE-US-19④**（引用保護之作廢語意） | 五者於本 Phase 皆有實質落點（§0.2 溯源表），PRD 概要未涵蓋 |
| 2 | PRD :490-497「初始 Task Graph 概要」 | 補列 **狀態機擴充**、**參數引用保護之 VOIDED 語意**、**跨 Phase chore** 三項 | 前二者為本 Phase 之必要前置與人類裁定項（T10 FW），PRD 未列 |
| 3 | PRD :498「High 風險 Task」 | 由「T2–T6」擴充為本 Spec §15.3 之 **13 項**對照 | 依 `CLAUDE.md`「授權相關一律 High」與既有升級先例（保守方向） |
| 4 | PRD :499「Rollback 概要」 | 補記「`AuditAction` 新 enum 值不可移除（PostgreSQL 限制）」與「回滾前須匯出四個作廢欄」 | §14 之落地約束 |
| 5 | PRD :483「Out of Scope」 | 補記「**建立修正版不自動作廢原申請**」（依 D15 之裁定結果） | 該語意為本 Phase 最重要之產品邊界，PRD 未明示 |
| 6 | （跨檔）`docs/specs/PHASE-008.md` §11.4 | **Type0/CID 敘述更正**（實為子集字型 `Tj`／`ToUnicode`，非 `Type3` 向量化） | 本 Task 之 Allowed 檔案不含 PHASE-008.md，須由大總管另派 `SPEC-REV-008` Lite（跨 Phase 核銷 #7 之另一半） |

---

**（Spec 全文結束。狀態 `ACTIVE`（2026-08-07 Spec Gate 通過，全部 BLOCKED 列已解鎖——見 §18）。）**
