# KNOWN ISSUES — 私車差旅補助管理系統

- Governance-Version: 2026-08-07.1
- 狀態：ACTIVE（**目前真相**文件——記錄「今天仍成立」之已知限制、技術債與運維約束）
- 更新日期：**2026-08-10**（同步至 **PHASE-010（稽核檢視與回歸）**已落地現實；DOC-SYNC `PHASE-010-DOCSYNC`——§3 D-1／D-2／D-3 結清＋D-5~D-7 改排 PHASE-011＋新增 D-9~D-11、§3.1 結清紀錄新增、§4 R-4／R-5 結清＋新增 R-6、§5 兩節重寫。前次：2026-08-09 建檔，`PHASE-009-DOC-SYNC-B`）
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
| D-4 | **`toDecimalConstructorArg` 同形雙拷貝** | `parameter-service.ts` 與 `depreciation-engine.ts` 各有一份；收斂須抽第三個共用葉節點（直接改用共用 helper 會改變 `deriveDepreciation` 之契約） | PHASE-011 重構候選（CHORE-003-T3） |
| D-5 | **E2E 共用 helper 未抽取** | `e2e/` 之樣板複製沿既有慣例，`void-application.spec.ts`／`revision.spec.ts` 加入後重複面擴大 | **PHASE-011**（原列 PHASE-010 開工候選；**PHASE-010 §16 D7=(b) 明列不納**，見該 Spec AC-22(d)。理由：抽取觸及全部 12 個 E2E 檔，與 PHASE-010-T8 之新 E2E 檔並行時衝突面大） |
| D-6 | **`e2e/` 目錄未接入 typecheck** | 全目錄有 76 個既有同型型別錯誤，`tsc` 未涵蓋該目錄 | **PHASE-011**（同上；修復量不可預估屬方法論風險型工作，與 PHASE-011 之部署硬化／CI 面同域） |
| D-7 | **XSS 15 格字面／日誌掃描器 pattern／fingerprint 收斂** | 三項測試面之字面重複與收斂候選，皆 Low | **PHASE-011**（同上；收斂收益低於觸檔風險） |
| D-8 | **E2E `serial` 序耦合** | 現行 config 下為確定性，但測試間存在順序依賴；平行化前須先解耦 | Accepted Risk（T17 AR-2） |
| D-9 | **pino `log.error({ err })` 序列化型之洩漏面**（新） | 以物件簡寫 `{ err }`（或位置引數 `log.error(err, "…")`）交給 pino 時，其預設 error serializer 會展開 `message` 與 **`stack`**（`stack` 逐字含絕對路徑）。PHASE-010-T9／T9R 之**兩層站點白名單掃描結構上不可能命中**此型——掃描器判定的是「`.message` 之**取值語法**」，而本型從不取值。**今日狀態**：`backend/src` 之現況未見該寫法（T9R 實查，白名單基線零變動），屬**縱深缺口**而非現行洩漏；已由 `phase10-error-handler-leak.test.ts` 之**記載型反向 `it`**（`已知不可及⑫…`）固化——日後若掃描器補上該型，該 `it` 會**顯性翻紅**而非靜默失效。**判準需求（修復時）**：①`{ err }` 物件簡寫與位置引數兩式皆須涵蓋②須確認 `logger.ts` 之 serializer 設定（是否覆寫 `err` serializer／是否 `redact` `stack`） | **PHASE-011**（日誌硬化；PHASE-010 T9/T10 合併複審 **FW-A**） |
| D-10 | **`errorLabel` 收斂後無反退化守門格**（新） | `platform/error-label.ts` 為單一葉節點（PHASE-010-T10／AC-22(b) 收斂），但**無任何斷言**阻止日後有人在他檔再寫一份私有 `function errorLabel`——退化不會使測試變紅。建議格：沿 `phase9-void-report.test.ts` §D-0 之結構性掃描同型一格（全 `backend/src` 之 `function errorLabel` 定義恰一處） | **PHASE-011**（PHASE-010 T9/T10 合併複審 **FW-D**） |
| D-11 | **ajv 驗證錯誤之 `detail.message` 輸出面**（既有面，登記） | 結構化錯誤處理中由 ajv 產生之 `detail.message` 亦為訊息輸出面，不在 PHASE-010-T9 兩層掃描之射程內（該掃描針對**例外物件**之 `.message`）。屬既有面之登記，非本 Phase 新引入 | **PHASE-011**（PHASE-010 T9/T10 合併複審 **FW-B**） |

### 3.1 本 Phase 結清紀錄（PHASE-010，2026-08-10；`PHASE-010-DOCSYNC`）

> 依本檔「已修復者從本檔移除」之收錄標準，下列各項已自上表移除；**保留一列結清紀錄**係因其中 **D-3** 之失準溯源本身即為本檔之教訓（記載鏈失真），非單純的歷史備查。完整歷史見 `PROJECT_STATE.md` 與 `docs/specs/PHASE-010.md`。

| 原 # | 原項目 | 結清方式 |
|---|---|---|
| D-1 | error-handler 兜底路徑之洩漏面 | **PHASE-010-T9（`3bae7fd`）＋T9R（`f98e7d5`）**：兜底分支改記固定分類標籤 `UNEXPECTED_EXCEPTION` ＋ `error.name`，**不再記 `error.message` 原文**；`requestId` 為唯一關聯手段；併建兩層站點白名單掃描與絕對路徑反向探針（Spec AC-21，§12 兩列 `GREEN`）。**遺留之縱深缺口另立 D-9**（pino 序列化型） |
| D-2 | `REPORT_GENERATION_FAILED` 兩處形狀分歧 | **PHASE-010-T10（`c11045a`）**：`applications/routes.ts` 由 `buildErrorBody` 繞道改經 `AppError` 承載，與 `reports/routes.ts` 對齊；**wire 逐位元組不變**（含鍵序）。全案 `buildErrorBody(` 呼叫端歸零（僅存 `error-handler.ts` 五處＋定義本身）。守門：`phase9-void-report.test.ts` §D-0（不得回退為繞道）＋§D-6b（wire 逐位元組全等） |
| D-3 | 「`errorLabel` **三份**同形實作」 | **PHASE-010-T10（`c11045a`）收斂為 `platform/error-label.ts`**。⚠ **本列之原記載失準（溯源）**：實際同形者恰**兩份**（`attachment/attachment-copy.ts`／`attachment/upload-service.ts`；T10 以 `git log -S` 覈實第三份從不存在）。失準成因＝PHASE-009-T18 檔頭所稱之「**慣例同型**」（同一族的零內容標籤寫法）在登記為本條目時被收斂成「**同形實作**」（同一份程式碼的複本），語意滑移一次，其後 `PHASE-010.md` AC-22(b) 再承接該字面而擴散。`platform/health.ts`（與 `error-handler.ts`）之 `errName` 取 **`err.name`**、本模組取 **`err.constructor.name`**，對未自訂 `name` 之 `Error` 子類回傳相異值，**併入即為行為變更**，故刻意不併——非漏收斂。經 T10 實查、W-1、T9/T10 合併複審**三重覈實**，大總管裁定「兩份收斂＝AC-22(b) 足額關閉」，複審 CONFIRM。**反退化守門格之缺另立 D-10** |
| R-4／R-5 | `report-service.ts` 檔頭／`applications/routes.ts` 註解失準 | **PHASE-010-T10（`c11045a`）**：`report-service.ts` 檔頭矛盾句更正；`applications/routes.ts` 檔頭由「PHASE-004-T3 之 7 端點」改寫為**當前 17 端點總覽**（依來源 Phase 分組，與檔內 `fastify.<verb>(` 註冊數相符）。零斷言影響 |

---

## 4. 記載型更正待辦（不影響任何斷言）

| # | 位置 | 應更正為 |
|---|---|---|
| R-1 | `backend/prisma/schema.prisma` `VoidedReportFile.storageKey` 之欄位註解 `"rpt/<uuid>/void.pdf"` | 實際後綴為 `void`（`rpt/<uuid>/void`）——storage key 白名單 `^(?:rpt)\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$` 之後綴不接受 `.`，`void.pdf` 會在 `put` 時被拒。註解為示意字面 |
| R-2 | `e2e/report-print-layout.spec.ts` :709、:1058-1059 之行內註解殘留 `Type3` 字樣 | 實測為**子集字型 ＋ `Tj`／`ToUnicode`**。該檔**檔頭**已於 PHASE-009-T18 更正，兩處行內註解因不在該 Task 之 Allowed 範圍而未動（處置正確） |
| R-3 | `docs/specs/PHASE-008.md` §11.4 之 Type0/CID 敘述 | 同上；PHASE-008 本體之更正待大總管另派 |
| R-6 | `backend/src/platform/error-label.ts` :42-43 之函式註解「故**三處呼叫端**之日誌輸出零變更」 | 實查為 **4 個呼叫端／2 檔**（`attachment/attachment-copy.ts` :121／:321、`attachment/upload-service.ts` :319／:332）。「三處」係承 `PHASE-010.md` AC-22(b) 原文之失準字面（該 AC 已於 `SPEC-REV-010-CLOSE` 更正為「2 檔 4 個呼叫端」）；同檔 :21-36 之「收斂範圍」段本身**正確**（已明載兩份），僅此一句失準。**零斷言影響**；PHASE-010-DOCSYNC 之 Files Allowed 不含程式檔，故登記待派 |

> **R-4／R-5 已結清**（PHASE-010-T10 `c11045a`），見 §3.1 結清紀錄。

---

## 5. 跨 Phase 移交

### PHASE-010（稽核）— **五項全數處置完畢（2026-08-10）**

1. ~~稽核檢視頁須納入 **`APPLICATION_VOIDED`**（操作者／時間／類型／受影響資料／原因摘要）。~~ → **結清**：`PHASE-010.md` AC-04(d)（十值逐一可取回，含 `APPLICATION_VOIDED`）、AC-07(a)⑤（本人與管理員各寫一條）。
2. ~~AD-US-14「重要欄位前後摘要」對作廢事件之呈現形式（`summary` 已含 `reason`／`voidedAt`）。~~ → **結清**：AC-06（`changes[]` 扁平化）＋AC-08(c)（**作廢原因逐字可見**）。**併記射程限定**：`applicationId`／`revisionOf` 兩純內部識別碼欄依 MG-3 裁定（人類 2026-08-10）**不於畫面呈現**，其可讀性改由 wire 面承載（AC-18(e)）。
3. ~~AD-US-04「有歷史拒刪」之回歸此時已有**已作廢**資料可用。~~ → **結清**：AC-12（五類歷史逐一 `409`，`VOIDED` 一類以**真實作廢端點**構造）。
4. ~~代操作稽核之完整性回歸（作廢與修正版兩類）。~~ → **結清**：AC-08（含「本人建修正版／管理員對自己之申請建修正版」兩向零稽核之邊界）。
5. ~~上表 D-2、D-3、D-5、D-6、D-7 之收斂。~~ → **依 `PHASE-010.md` §16 D7=(b)（人類 leonchih 2026-08-09 Spec Gate「照推薦」）分流**：**D-2／D-3 已結清**（T10 `c11045a`，見 §3.1）；**D-5／D-6／D-7 明列不納**（AC-22(d)），排定欄已改 **PHASE-011**，見下節。

### PHASE-011（部署硬化與備份）

1. 備份還原須涵蓋 **`VoidedReportFile` 之 `rpt/` 物件**與**修正版複製之附件物件**。
2. 孤兒清理排程須認得上述兩類新物件；**in-doubt 之殘留**（交易在 commit 前後失聯，DB 已提交但補償誤刪、或 DB 回滾但補償未及執行）之語意歸此處解決——PHASE-009 明示不處理。
3. 效能實測須涵蓋「作廢含 PDF 產生」之 10 s 目標與「修正版含附件複製」之 5 s 目標。
4. RUNBOOK 須載明 O-1 之 `REPORT_PDF_TIMEOUT_MS` ≤60 s 約束與 O-2 之 dev storage root 常設化。
5. 附件暫存 >24h 清理排程（BE-US-25）；含修正版草稿刪除後之複本（PHASE-009 B-20）。
6. 統計查詢之索引評估（PHASE-005 D9(a) 定案不新增，屆時以實測決定）；統計頁與列表頁 `tripDate`／`primaryDate` 篩選語意差異之檢視。
7. 上表 D-4 之收斂。

**PHASE-010 移入（2026-08-10；`PHASE-010-DOCSYNC`）**

8. **上表 D-5／D-6／D-7 之收斂**（E2E helper 抽取／`e2e/` 接入 typecheck（76 個既有型別錯誤）／XSS 字面與掃描器 pattern 收斂）——`PHASE-010.md` §16 **D7=(b)** 明列不納並移交本 Phase（AC-22(d)）。
9. **日誌硬化：上表 D-9（pino `{ err }` 序列化型洩漏面）之判準補齊**——`{ err }` 簡寫與位置引數兩式 ＋ `logger.ts` serializer 設定確認；修好後 `phase10-error-handler-leak.test.ts` 之記載型反向 `it` 會**顯性翻紅**（設計如此），須同批改寫該格。併同上表 **D-11**（ajv `detail.message` 既有面）評估。
10. **上表 D-10 之反退化守門格**（`errorLabel` 定義恰一處之結構性掃描）。
11. **RUNBOOK 須載明「500 兜底不再記錄例外原文」之診斷取捨**（PHASE-010-T9 生效）：線上排障之**正解為各服務層之具名日誌**（各 catch 自行記 `{ stage, id }` 一類零內容標籤 ＋ `requestId` 關聯），**不得**以「排障不便」為由回退兜底記 `error.message`——該回退會使 T9 之反向探針與白名單掃描同時失效。〔PHASE-010 T9/T10 合併複審 **FW-C**〕
12. **`Application.createdById` 與 `Attachment.uploaderId` 之索引補強評估**：兩欄為使用者刪除守門之 `count` 對象（`USER_RESTRICT_FK_GUARDS` 六條之二）但**無對應索引**（`schema.prisma` 實查），大表上為 seq scan。刪帳號為低頻管理操作故現況可接受；**正解是補索引而非縮小守門面**。〔PHASE-010-T5 遺留登記，`history.ts` 檔頭已明載〕
13. **`Attachment` `TEMP` 清理排程落地後**，AD-US-04 之附件阻擋條件自然放寬——須回歸確認 `PHASE-010.md` AC-14(b)② 之期望仍成立。
14. **PHASE-009 D2(a) 之兌現**：參數覆寫端點落地時**必須**呼叫 `parameterHasReferences` 守門（PHASE-010 明示不兌現——該 Phase 無任何參數覆寫端點）。
15. **稽核面之三項**：①備份還原須涵蓋 `AuditLog`（含 `summary` JSON）②稽核之保留期限／封存／清理語意（含「已清理期間在檢視頁如何呈現」——`PHASE-010.md` §7.5 明示不預設）③效能實測須涵蓋稽核列表（2 s 目標）與 `action` 欄索引之實測決定（該欄現無索引，PHASE-010 明示不新增）。
16. **帳號類五事件之稽核可靠性**：`writeAudit` 為 **fire-and-forget 且非同交易**（`audit.ts`），失敗僅 `console.error`，稽核可能靜默遺失；其餘五類事件為同交易 hook。**此不對稱為 `PHASE-010.md` §16 D11=(a)（人類 leonchih 2026-08-09）明示接受、本期零變更**，可靠性議題移交本 Phase。

---

## 6. 尚開放之架構問題

| 問題 | 現況 |
|---|---|
| Session 儲存後端（DB session vs 記憶體／外部 store） | PHASE-002 Spec 已定案實作，但 ARCHITECTURE §6 之開放條目仍保留——須滿足「停用／重設密碼即失效既有 session」 |

（`ARCHITECTURE.md` §6.1 所列之兩項——Playwright 封裝方式、報表編號併發安全——**已於 PHASE-008 結案**，不再屬開放問題。）
