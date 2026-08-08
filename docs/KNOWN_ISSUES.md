# KNOWN ISSUES — 私車差旅補助管理系統

- Governance-Version: 2026-08-07.1
- 狀態：ACTIVE（**目前真相**文件——記錄「今天仍成立」之已知限制、技術債與運維約束）
- 更新日期：2026-08-09（建檔；同步至 **PHASE-009（作廢與修正版）**已落地現實；DOC-SYNC `PHASE-009-DOC-SYNC-B`）
- 上游：各 Phase Spec §17（已知限制與跨 Phase 銜接）、`PROJECT_STATE.md`（Review finding 與 Accepted Risk 之權威登記處）

## 本檔之定位

本檔**不是**缺陷追蹤系統，也不取代 `PROJECT_STATE.md`。它回答一個問題：**「今天這套系統有哪些已知的、刻意接受的限制？」** 收錄標準：

- 已被人類或大總管裁定為**接受**（非待修缺陷），且**今日仍成立**；
- 或屬**運維約束**（設定錯誤會導致可觀察的錯誤行為）；
- 或屬**已排定移交下一 Phase** 之收斂項。

已修復者從本檔移除（歷史留在 `PROJECT_STATE.md` 與各 Phase Spec）。每列註明來源，以利追溯。

---

## 1. 產品行為之已知限制

| # | 限制 | 影響與緩解 | 來源 |
|---|---|---|---|
| P-1 | **原申請與其修正版可同時被統計計入** | 系統**不阻止**「原申請未作廢而修正版已完成」之狀態，兩筆同時進入里程與金額統計。緩解＝前端提示 ＋ 版本關係雙向顯示 ＋ Gate 目視。**根治須改變使用者可見行為（強制作廢原申請或自統計排除），須人類批准** | PHASE-009 §16 D15(a)／§17.1 #1 |
| P-2 | **已完成快照不因後續作廢而回溯更新** | 保養／折舊已完成快照中的期間／年度公務里程是**完成當下**之值；其中某筆差旅事後被作廢，該快照**不變**。後果：「已完成的保養分攤比例」可能與「今天重算的結果」不同。此為 BE-US-18「歷史可重現」之直接後果，**刻意設計非缺陷** | PHASE-009 §17.1 #2 |
| P-3 | **無版本鏈之聚合視圖** | `Application.supersedesId` 只表達**直接前身**；「一路追到最初版本」需遞迴查詢，目前無該 API 或 UI | PHASE-009 §17.1 #6 |
| P-4 | **作廢原因無內容審查** | 除「trim 後 1..500 字元」外不做任何驗證；使用者可填任意文字（已於列印版與前端兩層跳脫，無注入風險），系統不判斷其合理性 | PHASE-009 §17.1 #7 |
| P-5 | **作廢版 PDF 之產生依賴渲染器** | 渲染器不可用時**作廢動作整筆失敗**（可重試，零殘留）。若此不可接受，正解是改採 D4(a)（作廢不產生 PDF）——**不得**由實作端自行降級為「作廢成功但 PDF 略過」 | PHASE-009 §16 D4(b1)／§17.1 #4 |
| P-6 | **引用保護之放寬為單向承諾** | `parameterHasReferences` 已由 `COMPLETED` 單值放寬為 `{COMPLETED, VOIDED}`。改回是純程式變更，但期間若已有參數版本被覆寫，**資料層無法回復**——故此裁定不宜反覆 | PHASE-009 §16 D2(a)／§17.1 #3 |
| P-7 | **修正版附件複製之儲存成本無總量上界（差旅）** | 複製量 ＝ 容器數 × 每容器上限（差旅每段 3／保養 5／折舊 5）× ≤10 MiB。保養與折舊各恰一容器故有硬上界（5 × 10 MiB）；**差旅之 `TripSegment` 段數無上限**（PHASE-004 B-14 未設限），故「段數 × 3 × 10 MiB」在資料層無封頂。**不新增段數上限**——設限屬使用者可見行為之擴充，須人類批准；緩解僅為前端與 Gate 目視 | PHASE-009 §17.1 #5 |
| P-8 | **修正版之持鎖時長風險** | 附件複製於修正版之**單一交易內**進行（`timeout: 60_000`／`maxWait: 10_000`）。段數極端之資料可使 `FOR UPDATE` 列鎖持有數十秒並撞上 60 s 上限而**整筆回滾**——回滾後零殘留仍成立，但該申請於期間內無法被作廢或再次建修正版。「位元組搬移移出交易外」**屬 Spec 決策**（涉及補償與孤兒語意），與 PHASE-011 之孤兒清理併案評估，**不得**由實作端自行改採 | PHASE-009 §17.1 #5 |

---

## 2. 運維約束（設定錯誤會導致可觀察的錯誤行為）

| # | 約束 | 後果 |
|---|---|---|
| O-1 | **`REPORT_PDF_TIMEOUT_MS` 之設定值須顯著小於 60 s**（預設 30000 ms） | `application-void.ts` 之 `VOID_TX_TIMEOUT_MS = 60_000`／`VOID_TX_MAX_WAIT_MS = 10_000` 為**硬編常數**，刻意不由 `REPORT_PDF_TIMEOUT_MS` 推導（該檔對 `reports/` 域維持零依賴）。若前者被調高至接近或超過 60 s，作廢交易會在渲染仍進行中被 Prisma 交易逾時（P2028）搶先中止，使一筆「其實只是慢」的正常作廢變成 500（整筆回滾、零殘留仍成立，可重試）。**變更該 env 時須同批檢視該二常數**；PHASE-011 RUNBOOK 須載明（PHASE-009 §17.1 #9） |
| O-2 | **開發環境必須設定 `ATTACHMENT_STORAGE_ROOT` 與 `REPORT_STORAGE_ROOT`** | 未設定時 dev fallback 為 `%TEMP%/{att,rpt}-storage-dev-<pid>`，**每次重啟後端即換一個空目錄**，先前寫入的位元組滯留舊 PID 目錄——症狀為縮圖破圖、修正版附件複製失敗（AC-14(e) 正確整筆回滾 500）。**此為環境問題非程式缺陷**：防護如設計運作，log-safe 訊息亦零 key 洩漏。**處置（2026-08-08 ENV-STORAGE 事件，已執行）**：位元組遷至穩定根 `%TEMP%/oilexpense-dev-storage/{att,rpt}`，本機未追蹤之 `.env` 補上兩個 ROOT。**後續 session 重建 dev 環境必沿 `.env` 既有 ROOT**；整合 Gate 之容器拓撲以 volume 掛載，不受影響。RUNBOOK 常設化列 PHASE-011 |
| O-3 | **production 未設兩個 STORAGE_ROOT 會 fail-fast** | 為刻意設計（NFR-US-07）：Zeabur／compose 部署須提供持久化 volume 路徑，否則後端拒絕啟動 |

---

## 3. 技術債與收斂候選（不影響行為）

| # | 項目 | 說明 | 排定 |
|---|---|---|---|
| D-1 | **error-handler 兜底路徑之洩漏面** | 未預期錯誤之兜底分支所記之 `errMessage` 可能帶原始碼路徑。**今日為零活路徑**（所有已知錯誤皆走 `AppError` 或既有的訊息固定分支），屬**縱深缺口**而非現行洩漏。新 AC 候選 | 終審裁定（PHASE-009 T18 R-3） |
| D-2 | **`REPORT_GENERATION_FAILED` 之兩處實作形狀分歧** | 產生端點（`reports/routes.ts`）已改經 `AppError` 承載；作廢端點（`applications/routes.ts`）之同型 500 轉譯仍為 `buildErrorBody` 繞道形狀（該檔不在 T18 之 Allowed 範圍）。**兩處 wire 輸出完全一致**，僅形狀分歧 | PHASE-010 候選 |
| D-3 | **`errorLabel` 三份同形實作** | 三處各有一份，宜收斂為單一葉節點模組 | PHASE-010（T18 R-2） |
| D-4 | **`toDecimalConstructorArg` 同形雙拷貝** | `parameter-service.ts` 與 `depreciation-engine.ts` 各有一份；收斂須抽第三個共用葉節點（直接改用共用 helper 會改變 `deriveDepreciation` 之契約） | PHASE-011 重構候選（CHORE-003-T3） |
| D-5 | **E2E 共用 helper 未抽取** | `e2e/` 之樣板複製沿既有慣例，`void-application.spec.ts`／`revision.spec.ts` 加入後重複面擴大 | PHASE-010 開工候選（T17 W-1） |
| D-6 | **`e2e/` 目錄未接入 typecheck** | 全目錄有 76 個既有同型型別錯誤，`tsc` 未涵蓋該目錄 | PHASE-010 開工候選（T17 W-4） |
| D-7 | **XSS 15 格字面／日誌掃描器 pattern／fingerprint 收斂** | 三項測試面之字面重複與收斂候選，皆 Low | PHASE-010 開工候選（T17R 歸置裁定） |
| D-8 | **E2E `serial` 序耦合** | 現行 config 下為確定性，但測試間存在順序依賴；平行化前須先解耦 | Accepted Risk（T17 AR-2） |

---

## 4. 記載型更正待辦（不影響任何斷言）

| # | 位置 | 應更正為 |
|---|---|---|
| R-1 | `backend/prisma/schema.prisma` `VoidedReportFile.storageKey` 之欄位註解 `"rpt/<uuid>/void.pdf"` | 實際後綴為 `void`（`rpt/<uuid>/void`）——storage key 白名單 `^(?:rpt)\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$` 之後綴不接受 `.`，`void.pdf` 會在 `put` 時被拒。註解為示意字面 |
| R-2 | `e2e/report-print-layout.spec.ts` :709、:1058-1059 之行內註解殘留 `Type3` 字樣 | 實測為**子集字型 ＋ `Tj`／`ToUnicode`**。該檔**檔頭**已於 PHASE-009-T18 更正，兩處行內註解因不在該 Task 之 Allowed 範圍而未動（處置正確） |
| R-3 | `docs/specs/PHASE-008.md` §11.4 之 Type0/CID 敘述 | 同上；PHASE-008 本體之更正待大總管另派 |
| R-4 | `backend/src/reports/report-service.ts` 檔頭 | PHASE-009-T18 修 `routes.ts` 時，鄰檔 `report-service.ts` 檔頭之敘述隨之失準（「檔頭停在舊 Task」之失效模式）。**已於 DOC-SYNC-B 之前登記，程式面之檔頭更正待派** |
| R-5 | `backend/src/applications/routes.ts` 之部分註解 | T18 之 Files Forbidden 使其未同步更新，敘述略為失準（W-2 登記） |

---

## 5. 跨 Phase 移交

### PHASE-010（稽核）

1. 稽核檢視頁須納入 **`APPLICATION_VOIDED`**（操作者／時間／類型／受影響資料／原因摘要）。
2. AD-US-14「重要欄位前後摘要」對作廢事件之呈現形式（`summary` 已含 `reason`／`voidedAt`）。
3. AD-US-04「有歷史拒刪」之回歸此時已有**已作廢**資料可用（`userHasHistory` 對 `VOIDED` 天然計入，PHASE-009 零改動）。
4. 代操作稽核之完整性回歸（作廢與修正版兩類）。
5. 上表 D-2、D-3、D-5、D-6、D-7 之收斂。

### PHASE-011（部署硬化與備份）

1. 備份還原須涵蓋 **`VoidedReportFile` 之 `rpt/` 物件**與**修正版複製之附件物件**。
2. 孤兒清理排程須認得上述兩類新物件；**in-doubt 之殘留**（交易在 commit 前後失聯，DB 已提交但補償誤刪、或 DB 回滾但補償未及執行）之語意歸此處解決——PHASE-009 明示不處理。
3. 效能實測須涵蓋「作廢含 PDF 產生」之 10 s 目標與「修正版含附件複製」之 5 s 目標。
4. RUNBOOK 須載明 O-1 之 `REPORT_PDF_TIMEOUT_MS` ≤60 s 約束與 O-2 之 dev storage root 常設化。
5. 附件暫存 >24h 清理排程（BE-US-25）；含修正版草稿刪除後之複本（PHASE-009 B-20）。
6. 統計查詢之索引評估（PHASE-005 D9(a) 定案不新增，屆時以實測決定）；統計頁與列表頁 `tripDate`／`primaryDate` 篩選語意差異之檢視。
7. 上表 D-4 之收斂。

---

## 6. 尚開放之架構問題

| 問題 | 現況 |
|---|---|
| Session 儲存後端（DB session vs 記憶體／外部 store） | PHASE-002 Spec 已定案實作，但 ARCHITECTURE §6 之開放條目仍保留——須滿足「停用／重設密碼即失效既有 session」 |

（`ARCHITECTURE.md` §6.1 所列之兩項——Playwright 封裝方式、報表編號併發安全——**已於 PHASE-008 結案**，不再屬開放問題。）
