# KNOWN ISSUES — 私車差旅補助管理系統

- Governance-Version: 2026-08-11.1
- 狀態：ACTIVE（**目前真相**文件——記錄「今天仍成立」之已知限制、技術債與運維約束）
- 更新日期：**2026-08-12**（同步至 **PHASE-011（部署硬化與備份）**已落地現實；DOC-SYNC `PHASE-011-DOCSYNC`——§3 D-5／D-7／D-9／D-10／D-11 結清＋D-4 維持開放並附裁定引用、§5 十六項全數處置（結清／更新／移出）、新增「非 Phase 歸屬之開放工作項」節、新增 §3.2 suspected flaky 登記。前次：2026-08-10 建檔，`PHASE-010-DOCSYNC`）
- 上游：各 Phase Spec §17（已知限制與跨 Phase 銜接）、`PROJECT_STATE.md`（Review finding 與 Accepted Risk 之權威登記處）

## 本檔之定位

本檔**不是**缺陷追蹤系統，也不取代 `PROJECT_STATE.md`。它回答一個問題：**「今天這套系統有哪些已知的、刻意接受的限制？」** 收錄標準：

- 已被人類或大總管裁定為**接受**（非待修缺陷），且**今日仍成立**；
- 或屬**運維約束**（設定錯誤會導致可觀察的錯誤行為）；
- 或屬**已排定移交下一 Phase** 之收斂項；
- **PHASE-011 起**：本系統之 PRD 已無下一個 Phase 可承接（PHASE-011 為規劃之最後一個 Phase），故新增「非 Phase 歸屬之開放工作項」節，收錄不再有目標 Phase 可移交、但仍待人類決定去向（獨立工作項／永久接受／新增 Phase）之項目。

已修復者從本檔移除（歷史留在 `PROJECT_STATE.md` 與各 Phase Spec）。每列註明來源，以利追溯。

---

## 1. 產品行為之已知限制

| # | 限制 | 影響與緩解 | 來源 |
|---|---|---|---|
| P-1 | **原申請與其修正版可同時被統計計入** | 系統**不阻止**「原申請未作廢而修正版已完成」之狀態，兩筆同時進入里程與金額統計。緩解＝前端提示 ＋ 版本關係雙向顯示 ＋ Gate 目視。**根治須改變使用者可見行為（強制作廢原申請或自統計排除），須人類批准** | PHASE-009 §16 D15(a)／§17.1 #1 |
| P-2 | **已完成快照不因後續作廢而回溯更新** | 保養／折舊已完成快照中的期間／年度公務里程是**完成當下**之值；其中某筆差旅事後被作廢，該快照**不變**。後果：「已完成的保養分攤比例」可能與「今天重算的結果」不同。此為 BE-US-18「歷史可重現」之直接後果，**刻意設計非缺陷** | PHASE-009 §17.1 #2 |
| P-3 | **無版本鏈之聚合視圖** | `Application.supersedesId` 只表達**直接前身**；「一路追到最初版本」需遞迴查詢，目前無該 API 或 UI | PHASE-009 §17.1 #6 |
| P-4 | **作廢原因無內容審查** | 除「trim 後 1..500 字元」外不做任何驗證；使用者可填任意文字（已於列印版與前端兩層跳脫，無注入風險），系統不判斷其合理性 | PHASE-009 §17.1 #7 |
| P-5 | **作廢版 PDF 之產生依賴渲染器** | 渲染器不可用時**作廢動作整筆失敗**（可重試，零殘留）。若此不可接受，正解是改採 D4(b1)（作廢不產生 PDF）——**不得**由實作端自行降級為「作廢成功但 PDF 略過」 | PHASE-009 §16 D4(b1)／§17.1 #4 |
| P-6 | **引用保護之放寬為單向承諾** | `parameterHasReferences` 已由 `COMPLETED` 單值放寬為 `{COMPLETED, VOIDED}`。改回是純程式變更，但期間若已有參數版本被覆寫，**資料層無法回復**——故此裁定不宜反覆 | PHASE-009 §16 D2(a)／§17.1 #3 |
| P-7 | **修正版附件複製之儲存成本無總量上界（差旅）** | 複製量 ＝ 容器數 × 每容器上限（差旅每段 3／保養 5／折舊 5）× ≤10 MiB。保養與折舊各恰一容器故有硬上界（5 × 10 MiB）；**差旅之 `TripSegment` 段數無上限**（PHASE-004 B-14 未設限），故「段數 × 3 × 10 MiB」在資料層無封頂。**不新增段數上限**——設限屬使用者可見行為之擴充，須人類批准；緩解僅為前端與 Gate 目視 | PHASE-009 §17.1 #5 |
| P-8 | **修正版之持鎖時長風險** | 附件複製於修正版之**單一交易內**進行（`timeout: 60_000`／`maxWait: 10_000`）。段數極端之資料可使 `FOR UPDATE` 列鎖持有數十秒並撞上 60 s 上限而**整筆回滾**——回滾後零殘留仍成立，但該申請於期間內無法被作廢或再次建修正版。「位元組搬移移出交易外」**屬 Spec 決策**（涉及補償與孤兒語意）。**PHASE-011 未提出方案**（僅於該 Phase Spec D5 之選項欄載明其耦合關係），**本 Phase 為 PRD 最後一個 Phase，無後續 Phase 可承接**——去向見下方「非 Phase 歸屬之開放工作項」#3 | PHASE-009 §17.1 #5／PHASE-011 §17.1 #5 |

---

## 2. 運維約束（設定錯誤會導致可觀察的錯誤行為）

| # | 約束 | 後果 |
|---|---|---|
| O-1 | **`REPORT_PDF_TIMEOUT_MS` 之設定值須顯著小於 60 s**（預設 30000 ms） | `application-void.ts` 之 `VOID_TX_TIMEOUT_MS = 60_000`／`VOID_TX_MAX_WAIT_MS = 10_000` 為**硬編常數**，刻意不由 `REPORT_PDF_TIMEOUT_MS` 推導（該檔對 `reports/` 域維持零依賴）。若前者被調高至接近或超過 60 s，作廢交易會在渲染仍進行中被 Prisma 交易逾時（P2028）搶先中止，使一筆「其實只是慢」的正常作廢變成 500（整筆回滾、零殘留仍成立，可重試）。**變更該 env 時須同批檢視該二常數**。**已載明於 `docs/RUNBOOK.md` §(c)**（PHASE-011-T14，`228b93d`）——DOC-SYNC 結清（見 §5 結清紀錄 #4） |
| O-2 | **開發環境必須設定 `ATTACHMENT_STORAGE_ROOT` 與 `REPORT_STORAGE_ROOT`** | 未設定時 dev fallback 為 `%TEMP%/{att,rpt}-storage-dev-<pid>`，**每次重啟後端即換一個空目錄**，先前寫入的位元組滯留舊 PID 目錄——症狀為縮圖破圖、修正版附件複製失敗（AC-14(e) 正確整筆回滾 500）。**此為環境問題非程式缺陷**：防護如設計運作，log-safe 訊息亦零 key 洩漏。**已載明於 `docs/RUNBOOK.md` §(d)**（PHASE-011-T14，`228b93d`）——DOC-SYNC 結清（見 §5 結清紀錄 #4） |
| O-3 | **production 未設兩個 STORAGE_ROOT 會 fail-fast** | 為刻意設計（NFR-US-07）：Zeabur／compose 部署須提供持久化 volume 路徑，否則後端拒絕啟動 |

---

## 3. 技術債與收斂候選（不影響行為）

| # | 項目 | 說明 | 排定 |
|---|---|---|---|
| D-4 | **`toDecimalConstructorArg` 同形雙拷貝** | `parameter-service.ts` 與 `depreciation-engine.ts` 各有一份；收斂須抽第三個共用葉節點（直接改用共用 helper 會改變 `deriveDepreciation` 之契約） | **維持開放**——`docs/specs/PHASE-011.md` §16 **D16-4：不納入本 Phase**（人類 leonchih 2026-08-11 Spec Gate「照推薦」；理由：本 Phase 為部署硬化，觸碰金額計算模組之風險報酬比最差，且原判定為 Low）。**PHASE-011 為 PRD 最後一個 Phase，無後續 Phase 可承接**——去向見下方「非 Phase 歸屬之開放工作項」#6（獨立 CHORE 或永久接受） |
| D-8 | **E2E `serial` 序耦合** | 現行 config 下為確定性，但測試間存在順序依賴；平行化前須先解耦 | Accepted Risk（PHASE-010-T17 AR-2） |

### 3.1 本 Phase 結清紀錄（PHASE-010，2026-08-10；`PHASE-010-DOCSYNC`）

> 依本檔「已修復者從本檔移除」之收錄標準，下列各項已自上表移除；**保留一列結清紀錄**係因其中 **D-3** 之失準溯源本身即為本檔之教訓（記載鏈失真），非單純的歷史備查。完整歷史見 `PROJECT_STATE.md` 與 `docs/specs/PHASE-010.md`。

| 原 # | 原項目 | 結清方式 |
|---|---|---|
| D-1 | error-handler 兜底路徑之洩漏面 | **PHASE-010-T9（`3bae7fd`）＋T9R（`f98e7d5`）**：兜底分支改記固定分類標籤 `UNEXPECTED_EXCEPTION` ＋ `error.name`，**不再記 `error.message` 原文**；`requestId` 為唯一關聯手段；併建兩層站點白名單掃描與絕對路徑反向探針（Spec AC-21，§12 兩列 `GREEN`）。**遺留之縱深缺口另立 D-9**（pino 序列化型） |
| D-2 | `REPORT_GENERATION_FAILED` 兩處形狀分歧 | **PHASE-010-T10（`c11045a`）**：`applications/routes.ts` 由 `buildErrorBody` 繞道改經 `AppError` 承載，與 `reports/routes.ts` 對齊；**wire 逐位元組不變**（含鍵序）。全案 `buildErrorBody(` 呼叫端歸零（僅存 `error-handler.ts` 五處＋定義本身）。守門：`phase9-void-report.test.ts` §D-0（不得回退為繞道）＋§D-6b（wire 逐位元組全等） |
| D-3 | 「`errorLabel` **三份**同形實作」 | **PHASE-010-T10（`c11045a`）收斂為 `platform/error-label.ts`**。⚠ **本列之原記載失準（溯源）**：實際同形者恰**兩份**（`attachment/attachment-copy.ts`／`attachment/upload-service.ts`；T10 以 `git log -S` 覈實第三份從不存在）。失準成因＝PHASE-009-T18 檔頭所稱之「**慣例同型**」（同一族的零內容標籤寫法）在登記為本條目時被收斂成「**同形實作**」（同一份程式碼的複本），語意滑移一次，其後 `PHASE-010.md` AC-22(b) 再承接該字面而擴散。`platform/health.ts`（與 `error-handler.ts`）之 `errName` 取 **`err.name`**、本模組取 **`err.constructor.name`**，對未自訂 `name` 之 `Error` 子類回傳相異值，**併入即為行為變更**，故刻意不併——非漏收斂。經 T10 實查、W-1、T9/T10 合併複審**三重覈實**，大總管裁定「兩份收斂＝AC-22(b) 足額關閉」，複審 CONFIRM。**反退化守門格之缺另立 D-10（PHASE-011 已結清，見 §3.2）** |
| R-4／R-5 | `report-service.ts` 檔頭／`applications/routes.ts` 註解失準 | **PHASE-010-T10（`c11045a`）**：`report-service.ts` 檔頭矛盾句更正；`applications/routes.ts` 檔頭由「PHASE-004-T3 之 7 端點」改寫為**當前 17 端點總覽**（依來源 Phase 分組，與檔內 `fastify.<verb>(` 註冊數相符）。零斷言影響 |

### 3.2 本 Phase 結清紀錄（PHASE-011，2026-08-12；`PHASE-011-DOCSYNC`）

| 原 # | 原項目 | 結清方式 |
|---|---|---|
| D-5 | E2E 共用 helper 未抽取 | **PHASE-011-T17（`d619bc6`）＋T17R-LITE（`732b8d9`）**：`e2e/helpers.ts` 新增共用 loginAsAdmin／uploadAttachment 兩形態等 helper；`void-application.spec.ts`／`revision.spec.ts` 等既有 12 檔逐位元組等價（4 regex／fingerprintRow 邏輯抽取，it 數前後全等零移除）。E2E 55/55 全綠 |
| D-6 | `e2e/` 目錄未接入 typecheck | **PHASE-011-T15（`ade0b2f`）**：新增 `tsconfig.e2e.json` 涵蓋 `e2e/**/*.ts`；`tsc` 回 0。**「76 個既有型別錯誤、修復量不可預估」之原記載已由 Spec §11.6 之最小 spike 於開工前實測推翻**：實際為 **48 個錯誤、8 檔、單一根因**（`strict` ＋ `noUncheckedIndexedAccess` 之 possibly-undefined 族），與 spike 逐字重現同分佈同 8 檔——「不可預估」之判斷更新為「可預估、同族、集中」。全數以真窄化修復（顯式檢查／`??` fallback／`.entries()`），**零 `any`／零 `@ts-ignore`／零 `!` 非空斷言淨增** |
| D-7 | XSS 15 格字面／日誌掃描器 pattern／fingerprint 收斂 | **PHASE-011-T17（`d619bc6`）**：三項測試面字面重複收斂至 `backend/test/support/`（`fingerprint.ts`／`secret-patterns.ts`）共用模組；XSS payload 值、掃描器 pattern 等逐位元組同值抽取（純常數抽取，值不變） |
| D-9 | pino `log.error({ err })` 序列化型之洩漏面 | **PHASE-011-T16（`8b934b5`）**：`logger.ts` 覆寫 `err` serializer 定案（只留 `type`＝`err.name`，不再展開 `message`／`stack`）；`phase10-error-handler-leak.test.ts` 擴充兩式掃描（物件簡寫 `{ err }` ＋ 位置引數）併入 L1；**兩處今日即存在站點皆已修復**——`backend/src/index.ts` :33（`server.log.error(err)`）與 `backend/src/audit/audit.ts`（原 :56，檔頭增長後現況 :98，`console.error("[audit] Failed to write AuditLog:", err)`）兩者皆改為只記分類標籤（`err.name`）不記 `message`／`stack`。**`MESSAGE_READ_WHITELIST` 之 `index.ts` 白名單條目已加註**：該條目理由僅涵蓋啟動期 env 驗證之 `stderr` 寫入，**不涵蓋** `server.log.error(err)` 一型（避免白名單長期遮蔽本型）。「已知不可及⑫」記載型反向 `it` 已設計性翻紅並同批改寫為正向格（AC-28(d)） |
| D-10 | `errorLabel` 收斂後無反退化守門格 | **PHASE-011-T17（`d619bc6`）**：`backend/test/integration/phase11-structural-guards.test.ts` 新增結構性掃描一格——全 `backend/src` 之 `function errorLabel` 定義恰一處，mutant（新增第二份定義）必紅 |
| D-11 | ajv 驗證錯誤之 `detail.message` 輸出面 | **PHASE-011-T16（`8b934b5`）評估結論：不納入 AC-28 之判準**——實測 ajv 之 `detail.message` 為固定形式文字（`required` 缺漏者零路徑分隔字面、零 `stack` 欄位；型別／`pattern` 不符者僅含 schema 自身之關鍵字資訊，不回放呼叫端實際輸入值），今日不構成訊息洩漏面。**保留條件（觸發即須重評）**：專案日後引入 `ajv-errors`（自訂錯誤訊息可內嵌任意樣板，含資料值）或 `ajv-formats`（部分 format 之訊息會帶入實際值）之任一者時，本結論即失去事實基礎，須重新判定是否納入 AC-28(a) 之掃描判準 |

### 3.3 Suspected Flaky 登記（待終審人類接受；PHASE-011-DOCSYNC）

> 收錄結構性判定為「隔離成立、非系統性缺陷」但單輪執行仍偶發翻紅之測試格。判定依據見 `PROJECT_STATE.md` 對應 Task 之即審記錄；**列於此處係供終審批准時之揭露事項**，非待修缺陷。

| # | 位置 | 判定 |
|---|---|---|
| F-1 | `backend/test/integration/phase11-backup-restore.test.ts`（T12 AC-20 格） | **10 輪 1 紅，診斷性缺口**（PHASE-011-T13 即審「suspected flaky 結構性判定」）：隔離成立不需收斂——`FORCE` drop 擊殺範圍實證僅目標庫 1→0、`app_test` 7→7 不變；6 輪中 T13 自身零失敗。**但揪出一個真問題**：斷言（測試檔 :732 一帶）丟棄已取回之 `stdout`／`stderr`，致該輪失敗**無法歸因**（診斷性缺口，非鑑別力缺口）。建議：補記失敗時之完整 `stdout`／`stderr` 於斷言訊息，供下次翻紅時歸因。 |
| F-2 | `e2e/*.ts`（AC-19(d) 紅燈物證格；PHASE-011-T17R-LITE 新登記） | **2 輪 1 紅，隔離不重現，資源競爭型**（PHASE-011-T17R-LITE「新 suspected flaky 登記」）：全套執行下偶發紅（1/2 次全套重現），單檔隔離執行 45/45 綠，與 T17R 之修改零關聯。判定為 **8 worker 併行下 docker／`pg_dump`／15k 檔案 tar 之資源競爭型**，與 F-1（T12 AC-20 格）之 flake 同域但非同一根因。「不建議此時改測試——這是要記錄的事實，不是要消掉的紅字」（reviewer 原文）。 |

> **PHASE-006 B-30 併發 `503` 縫隙——不在本節（已收斂為合法契約，非 flaky）**：原以 flaky 登記候選收斂之項目已由 PHASE-011-T1（`187eafd`）依 D1=(a) 承認 `503` 為合法契約並建立確定性覆蓋（見 §6「非 Phase 歸屬之開放工作項」#8）；本欄不再收錄。

---

## 4. 記載型更正待辦（不影響任何斷言）

| # | 位置 | 應更正為 |
|---|---|---|
| R-1 | `backend/prisma/schema.prisma` `VoidedReportFile.storageKey` 之欄位註解 `"rpt/<uuid>/void.pdf"` | 實際後綴為 `void`（`rpt/<uuid>/void`）——storage key 白名單 `^(?:rpt)\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$` 之後綴不接受 `.`，`void.pdf` 會在 `put` 時被拒。註解為示意字面 |
| R-2 | `e2e/report-print-layout.spec.ts` :709、:1058-1059 之行內註解殘留 `Type3` 字樣 | 實測為**子集字型 ＋ `Tj`／`ToUnicode`**。該檔**檔頭**已於 PHASE-009-T18 更正，兩處行內註解因不在該 Task 之 Allowed 範圍而未動（處置正確） |
| R-3 | `docs/specs/PHASE-008.md` §11.4 之 Type0/CID 敘述 | 同上；PHASE-008 本體之更正待大總管另派 |
| R-6 | `backend/src/platform/error-label.ts` :42-43 之函式註解「故**三處呼叫端**之日誌輸出零變更」 | 實查為 **4 個呼叫端／2 檔**（`attachment/attachment-copy.ts` :121／:321、`attachment/upload-service.ts` :319／:332）。「三處」係承 `PHASE-010.md` AC-22(b) 原文之失準字面（該 AC 已於 `SPEC-REV-010-CLOSE` 更正為「2 檔 4 個呼叫端」）；同檔 :21-36 之「收斂範圍」段本身**正確**（已明載兩份），僅此一句失準。**零斷言影響**。**PHASE-011 為 PRD 最後一個 Phase，無後續 Phase 可承接**——續留，去向見下方「非 Phase 歸屬之開放工作項」 |

> **R-4／R-5 已結清**（PHASE-010-T10 `c11045a`），見 §3.1 結清紀錄。

---

## 5. 跨 Phase 移交

### PHASE-010（稽核）— **五項全數處置完畢（2026-08-10）**

1. ~~稽核檢視頁須納入 **`APPLICATION_VOIDED`**（操作者／時間／類型／受影響資料／原因摘要）。~~ → **結清**：`PHASE-010.md` AC-04(d)（十值逐一可取回，含 `APPLICATION_VOIDED`）、AC-07(a)⑤（本人與管理員各寫一條）。
2. ~~AD-US-14「重要欄位前後摘要」對作廢事件之呈現形式（`summary` 已含 `reason`／`voidedAt`）。~~ → **結清**：AC-06（`changes[]` 扁平化）＋AC-08(c)（**作廢原因逐字可見**）。**併記射程限定**：`applicationId`／`revisionOf` 兩純內部識別碼欄依 MG-3 裁定（人類 2026-08-10）**不於畫面呈現**，其可讀性改由 wire 面承載（AC-18(e)）。
3. ~~AD-US-04「有歷史拒刪」之回歸此時已有**已作廢**資料可用。~~ → **結清**：AC-12（五類歷史逐一 `409`，`VOIDED` 一類以**真實作廢端點**構造）。
4. ~~代操作稽核之完整性回歸（作廢與修正版兩類）。~~ → **結清**：AC-08（含「本人建修正版／管理員對自己之申請建修正版」兩向零稽核之邊界）。
5. ~~上表 D-2、D-3、D-5、D-6、D-7 之收斂。~~ → **依 `PHASE-010.md` §16 D7=(b)（人類 leonchih 2026-08-09 Spec Gate「照推薦」）分流**：**D-2／D-3 已結清**（T10 `c11045a`，見 §3.1）；**D-5／D-6／D-7 明列不納**（AC-22(d)），排定欄已改 **PHASE-011**——**已於下節全數結清**。

### PHASE-011（部署硬化與備份）— **十六項全數處置完畢（2026-08-12；`PHASE-011-DOCSYNC`）**

> 本 Phase 為 PRD 規劃之**最後一個 Phase**；下列各項原按「移交下一 Phase」記載，本次結案時逐項核銷去向——**結清**者移入上方 §3.1／§3.2 結清紀錄，**移出**者續留但轉入下方「非 Phase 歸屬之開放工作項」節（因已無下一個 Phase 可承接），**更新**者原地修訂狀態。

1. ~~備份還原須涵蓋 **`VoidedReportFile` 之 `rpt/` 物件**與**修正版複製之附件物件**。~~ → **結清**：`PHASE-011.md` AC-19～AC-22（T12 `8167bad`）——完整備份實跑物證：三類 189/189 鍵全在，**含 `VoidedReportFile` 之 void 物件 ×22**。
2. ~~孤兒清理排程須認得上述兩類新物件；**in-doubt 之殘留**...之語意歸此處解決——PHASE-009 明示不處理。~~ → **移出**（見「非 Phase 歸屬之開放工作項」#2）。**併記重要落差**：Spec `docs/specs/PHASE-011.md` §17.1 #3／§17.2 #2 原預期本項由條件 Task **T6**（storage 孤兒盤點，依 D5=(c)「只盤點不刪除」）交付盤點數據作為未來刪除策略之決策輸入；**經 `PROJECT_STATE.md` 實查，T6 於本 Phase 主線（Gate 通過後「T5 → T7 → T8/T9 → …」之派工序列）中未被派工、`backend/src/attachment/orphan-inventory.ts` 不存在於本倉庫任何版本**——**孤兒物件之存在與範圍今日仍未經測量**，非「已盤點、待裁定」。此為文件與實作落差，已列本次 Handoff Warnings 供人類與大總管確認去向（補派 T6 或正式接受不執行）。
3. ~~效能實測須涵蓋「作廢含 PDF 產生」之 10 s 目標與「修正版含附件複製」之 5 s 目標。~~ → **結清**：`PHASE-011.md` AC-17（T11 `0ddb7e1`）——七類全 PASS，餘裕巨大（最大 172 ms vs 目標 2000~10000 ms；含作廢與修正版兩類）。
4. ~~RUNBOOK 須載明 O-1 之 `REPORT_PDF_TIMEOUT_MS` ≤60 s 約束與 O-2 之 dev storage root 常設化。~~ → **結清**：`docs/RUNBOOK.md` §(c)／§(d)（T14 `228b93d`）逐字涵蓋，見 §2 O-1／O-2 列。
5. ~~附件暫存 >24h 清理排程（BE-US-25）；含修正版草稿刪除後之複本（PHASE-009 B-20）。~~ → **結清**：`PHASE-011.md` AC-03～AC-06（T3 `3a891f1` ＋ T4 `faa0ddb`）——CLI 化執行器、批次上限、TTL 判定與 dry-run／實跑共用同一判定路徑；複本因與一般 TEMP 附件同形而結構性涵蓋。
6. 統計查詢之索引評估（PHASE-005 D9(a) 定案不新增，屆時以實測決定）；統計頁與列表頁 `tripDate`／`primaryDate` 篩選語意差異之檢視。→ **拆分處置**：
   - **前半（索引評估）**：**T11（`0ddb7e1`）實測達標記載**——見下方項 12 之同批記載（AC-17(b) 日期區間里程統計最大 4 ms／目標 3000 ms），依 `PHASE-011.md` §16 **D17** 二階段預授權「全達標→不開工」，**T19（索引補強）未開工**。**維持開放**供未來資料量規模變化時再評（非結清、非移出——與項 12 同一組基準線）。
   - **後半（`tripDate`／`primaryDate` 語意差異）**：`PHASE-011.md` §13 #4／Spec Gate（人類 leonchih 2026-08-11）裁定**自 PHASE-011 移出，另立產品面工作項**（判定為使用者可見語意之產品行為問題，非部署硬化；擅自「統一」將改變使用者可見行為）→ **移出**（見「非 Phase 歸屬之開放工作項」#7）。
7. ~~上表 D-4 之收斂。~~ → **移出**：處置同 §3 D-4（**維持開放**，`PHASE-011.md` §16 D16-4 裁定不納）——見「非 Phase 歸屬之開放工作項」#6。

**PHASE-010 移入（2026-08-10；`PHASE-010-DOCSYNC`）**

8. ~~上表 D-5／D-6／D-7 之收斂~~（E2E helper 抽取／`e2e/` 接入 typecheck／XSS 字面與掃描器 pattern 收斂）→ **結清**：見 §3.2（T15 `ade0b2f`／T17 `d619bc6`）。
9. ~~日誌硬化：上表 D-9（pino `{ err }` 序列化型洩漏面）之判準補齊~~；~~併同上表 D-11（ajv `detail.message` 既有面）評估~~ → **結清**：見 §3.2（**D-9：T16 `8b934b5`**；**D-11：T16 `8b934b5` 評估結論不納入判準，保留條件已記載**）。
10. ~~上表 D-10 之反退化守門格~~（`errorLabel` 定義恰一處之結構性掃描）→ **結清**：見 §3.2（**T17 `d619bc6`**——本項由 T17 交付而非 T16，特此更正原記載之隱含歸屬）。
11. ~~RUNBOOK 須載明「500 兜底不再記錄例外原文」之診斷取捨~~（PHASE-010-T9 生效）→ **結清**：`docs/RUNBOOK.md` §(e)「500 兜底之診斷取捨」（**T14 `228b93d`**）——線上排障之正解為各服務層之具名日誌，不得以「排障不便」為由回退兜底記 `error.message`，逐字載明。
12. **`Application.createdById` 與 `Attachment.uploaderId` 之索引補強評估**：兩欄為使用者刪除守門之 `count` 對象（`USER_RESTRICT_FK_GUARDS` 六條之二）但**無對應索引**（`schema.prisma` 實查），大表上為 seq scan。刪帳號為低頻管理操作故現況可接受；正解是補索引而非縮小守門面。〔PHASE-010-T5 遺留登記，`history.ts` 檔頭已明載〕**→ PHASE-011-T11（`0ddb7e1`）實測達標記載（`PHASE-011.md` §16 D17 二階段預授權「後半段」，人類 leonchih 2026-08-11 Spec Gate 預授權）**：三項候選索引之量測輸入全數遠低於目標——①`Application.createdById`（日期區間里程統計，最大 **4 ms**／目標 3000 ms）②`AuditLog.action`（稽核列表查詢，最大 **5 ms**／目標 2000 ms）③`Attachment.uploaderId`（使用者刪除之守門查詢路徑，最大 **10 ms**）。依 `AC-31(a)`「無實測不得補」（PHASE-005 D9(a) 搭配條件）**不補索引，T19 不開工，`schema.prisma` 零觸碰**。**維持開放**：三項候選之依據續留為條件式義務——日後資料量成長使任一項超標時重評，本次量測數即該重評之基準線。
13. ~~`Attachment` `TEMP` 清理排程落地後，AD-US-04 之附件阻擋條件自然放寬——須回歸確認 `PHASE-010.md` AC-14(b)② 之期望仍成立。~~ → **結清**：`PHASE-011.md` AC-07(b)(c)（**T5 `d41ddbc` ＋ T5R-2 `2952698`**）。**結清所依之兩要素**（`PHASE-011-T5` 即審 CONFIRM、`PROJECT_STATE.md` 逐字記載）：**(i)** `PHASE-010.md` AC-14(b)② 之「期望逐字仍成立」係在**「列在場」讀法**下成立——`KNOWN_ISSUES.md` 本列原措辭本身即預設「阻擋條件之列存在，只是前提被清理改變」之讀法（`history.ts` 之生產程式碼註解為此判準之來源）；**(ii)** 清理落地後 `409`（未逾期）放寬為 `200`（已逾期且已清理）之新行為，是 `PHASE-010.md` §16 **D5=(c)**（storage 孤兒「只盤點不刪除」推薦裁定）之選項欄已**明示接受**之直接後果，非未經裁定之行為變更。**不得順帶結清 §5-12（今項 12）**——兩者為獨立事項。
14. **PHASE-009 D2(a) 之兌現**：參數覆寫端點落地時**必須**呼叫 `parameterHasReferences` 守門（PHASE-010 明示不兌現——該 Phase 無任何參數覆寫端點）。→ **移出**：`PHASE-011.md` §16 D18 項目二（人類 leonchih 2026-08-11 Spec Gate「照推薦」=(a)）——**T8（`632978b`）實查結論：本 Phase 之 14 個核心 Task 與 5 個條件 Task 皆不引入任何參數覆寫端點**（`backend/src/parameters/` 在零 diff 射程內），義務**再度未觸發**。見「非 Phase 歸屬之開放工作項」#1。
15. **稽核面之三項**：①備份還原須涵蓋 `AuditLog`（含 `summary` JSON）②稽核之保留期限／封存／清理語意（含「已清理期間在檢視頁如何呈現」——`PHASE-010.md` §7.5 明示不預設）③效能實測須涵蓋稽核列表（2 s 目標）與 `action` 欄索引之實測決定（該欄現無索引，PHASE-010 明示不新增）。→ **拆分處置**：
    - **①備份含 `AuditLog`**：**結清**——`PHASE-011.md` AC-19(a)（T12 `8167bad`）DB 全庫備份結構性涵蓋 `AuditLog` 與其 `jsonb`，AC-23(c) 抽驗（T13 `d32cfbc`/`c542a28`/`78dec94`）。
    - **②保留期限／封存語意**：**移出**——`PHASE-011.md` §16 **D18 項目一**（人類 leonchih 2026-08-11 Spec Gate「照推薦」=(a) **明示不納**）：無 US 依據、屬產品行為決策、且與既有「稽核 append-only」之結構守門正面衝突。見「非 Phase 歸屬之開放工作項」#4。
    - **③效能（稽核列表 2 s 目標）**：**結清**——`PHASE-011.md` AC-17(g)（T11 `0ddb7e1`）稽核列表查詢最大 5 ms，遠低於 2000 ms 目標。
    - **`action` 欄索引之實測決定**：**維持開放**，同項 12 之同批記載（`AuditLog.action` 最大 5 ms／目標 2000 ms，依 D17 預授權不補索引）。
16. **帳號類五事件之稽核可靠性**：`writeAudit` 為 **fire-and-forget 且非同交易**（`audit.ts`），失敗僅 `console.error`，稽核可能靜默遺失；其餘五類事件為同交易 hook。**此不對稱為 `PHASE-010.md` §16 D11=(a)（人類 leonchih 2026-08-09）明示接受、本期零變更**，可靠性議題移交本 Phase。→ **狀態更新（T18 `4263519`／`2c60f4b`，非結清）**：`PHASE-011.md` §16 **D16-5=(i)**（人類 leonchih 2026-08-11 Spec Gate「僅固化現況」）已落地——`audit.ts` 之 `writeAudit` 失敗路徑今日**有守門的顯性選擇**：真實端點注入稽核寫入失敗之紅燈物證確認「主操作 2xx 而稽核列 0」（靜默遺失）之失效行為存在且**刻意保留**（吞掉例外不使主操作失敗，記載型 `it` 固化「未經裁定不得改同交易」）；失敗時另補記 `action`（封閉列舉、零自由文字）供事後歸因，且不記 `summary` 內容。**實質風險維持接受**：`PHASE-010.md` D11=(a) ＋ `PHASE-011.md` D16-5=(i) 兩層裁定皆選擇「不升級為同交易」。**消除此風險須回 D16-5 重新取得裁定**（選項 (ii) 同交易寫入 ／ (iii) 其他強化形式），本 Phase 不自行升級。

---

## 6. 非 Phase 歸屬之開放工作項

> **PHASE-011 為 PRD § 5 規劃之最後一個 Phase（第 13／13）**，故本節收錄已無「下一個 Phase」可承接、仍待人類裁定去向（獨立工作項／永久接受／新增 Phase）之項目。來源為 `docs/specs/PHASE-011.md` §17.2（跨 Phase 銜接）之九項登記，加計 §5 中依本次結案裁定移出者。**收錄標準與 §5 相同（今日仍成立之已知限制／待決事項），僅因無 Phase 編號可掛而獨立成節**；日後若有新 Phase 承接任一項，逕自本節移出並改掛該 Phase 編號。

1. **PHASE-009 D2(a) 之兌現**（`docs/specs/PHASE-011.md` §17.2 #1；本檔原 §5-14）——參數覆寫端點落地時必須呼叫 `parameterHasReferences` 守門。**狀態：連續兩個 Phase（PHASE-010、PHASE-011）皆未觸發**（皆無任何參數覆寫端點落地）。`KNOWN_ISSUES.md` 原 P-6 列明載「此裁定不宜反覆」——在無業務需求下不應搶先開該端點。**續留為條件式義務**，待參數覆寫端點確有業務需求時，落地 Task 之 Spec 須將此列為 Done When 之一。
2. **storage 孤兒物件之刪除策略**（`docs/specs/PHASE-011.md` §17.2 #2；本檔原 §5-2／§5-13(2)）——`docs/specs/PHASE-011.md` §16 D5=(c)（人類 leonchih 2026-08-11 Spec Gate「照推薦」：storage 孤兒物件本期只盤點不刪除）預期由條件 Task **T6** 交付盤點數據作為未來刪除策略之決策輸入。**重要落差（本次 DOCSYNC 實查發現）**：T6 於 PHASE-011 主線實際派工序列中**未被執行**（`PROJECT_STATE.md` 「清理啟用前人工 Gate：通過」列之後，「主線恢復」明載派工序列為「T5 → T7 → T8/T9 → T10~T14 → 條件 Task → 終審」，T6 不在其中；`backend/src/attachment/orphan-inventory.ts` 於本倉庫任一版本皆不存在）。**故本項今日狀態並非「已盤點、待裁定刪除策略」，而是「孤兒物件之存在與範圍尚未經任何測量」**——比原登記更早一步。去向：①補派 T6（盤點，Medium 風險）產出資料後再議刪除策略，或②由人類裁定本 Phase 起永久不執行系統化盤點（僅仰賴既有備份與人工排障）。**須人類決定去向**。
3. **`KNOWN_ISSUES.md` §1 P-8**（`docs/specs/PHASE-011.md` §17.2 #3）——修正版之持鎖時長風險／位元組搬移移出交易外。涉補償與孤兒語意變更，需獨立 Spec 評估；`docs/specs/PHASE-011.md` §16 D5 之選項欄已載明其與孤兒清理之耦合關係，但本 Phase 未提出方案。
4. **稽核保留期限／封存語意**（`docs/specs/PHASE-011.md` §17.2 #4；本檔原 §5-15②）——`docs/specs/PHASE-011.md` §16 D18 項目一（人類 leonchih 2026-08-11 Spec Gate「照推薦」=(a) 明示不納）：無 US 依據、屬產品行為決策、且與既有「稽核 append-only」之結構守門（`AuditLog` 之 `update`／`delete`／`upsert` 全域零命中掃描）正面衝突。需先由人類定義產品語意，再評估與該結構守門之相容性。
5. **效能未達標項之優化**（`docs/specs/PHASE-011.md` §17.2 #5）——PHASE-011 之七類效能目標（AC-17）全數 PASS 且餘裕巨大；**唯一之「未達標」為 AC-18(b)①（20 併發下之 `5xx` 比率）**，已由人類裁定接受（見下方 #8，不視為待優化項）。本項今日**無實質待辦內容**，保留條目編號以與 Spec §17.2 對齊。
6. **D16 未納之技術債（`toDecimalConstructorArg` 同形雙拷貝，即 `KNOWN_ISSUES.md` §3 D-4）**（`docs/specs/PHASE-011.md` §17.2 #6；本檔原 §5-7）——`docs/specs/PHASE-011.md` §16 D16-4（人類 leonchih 2026-08-11 Spec Gate「照推薦」：不納入本 Phase）。詳見 §3 D-4 列。獨立 CHORE 候選，或永久接受現況（`parameter-service.ts` 與 `depreciation-engine.ts` 各自一份 `toDecimalConstructorArg`）。
7. **統計頁與列表頁 `tripDate`／`primaryDate` 篩選語意差異**（`docs/specs/PHASE-011.md` §13 #4；本檔原 §5-6 後半）——統計頁與列表頁對同一筆資料之歸屬期間可能不同，屬使用者可見語意之**產品行為問題**，非部署硬化；`docs/specs/PHASE-011.md` Spec Gate（人類 leonchih 2026-08-11）裁定自 PHASE-011 移出，另立產品面工作項或列為產品行為之已知限制，**需人類裁定**產品語意後再評估是否統一。
8. **PHASE-006 B-30 併發 `503` 縫隙——發生率降低（`docs/specs/PHASE-011.md` §17.2 #8）**：**已收斂為合法契約，非待辦**。原登記（`PROJECT_STATE.md`，PR #19 合併批准時人類接受之 flaky，登記「候選 PHASE-011 收斂」）已由 **PHASE-011-T1**（`187eafd`）依 `docs/specs/PHASE-011.md` §16 **D1=(a)**（人類 leonchih 2026-08-11 Spec Gate「照推薦」）承認 `503` 為併發下之合法契約回應（重試耗盡之誠實回應），並建立確定性覆蓋（`vi.spyOn($transaction)` 丟 `P2034`、恰 7 次呼叫、DB 全欄位零寫入之結構性斷言）＋允許碼集合擴為 `[400, 403, 409, 503]`。**該筆收斂候選結清，不再是待辦項**。若日後欲**降低**該 `503` 之發生率（結構性改動如縮小謂詞鎖範圍），屬獨立工作項（High 風險，需獨立評估），**續留為此編號之開放內容**。
9. **本檔 §5「跨 Phase 移交」與 §13 移交清單各項之記載型更正**（`docs/specs/PHASE-011.md` §17.2 #9）——即本次 `PHASE-011-DOCSYNC` 本身；本節與 §3.1／§3.2／§5 之更新即其交付物。**結清**。
10. **`process.env` 直接讀取站點之收斂**（`docs/specs/PHASE-011.md` §8.2／T8 `632978b` 判讀 W-1）——`PHASE-011.md` AC-11(d) 之「面一」（`process.env.<KEY>` 屬性取值）今日恰二站點：`backend/src/auth/middleware.ts` :51（`SESSION_COOKIE_NAME`）與 `backend/src/server.ts` :63（`LOG_LEVEL`，先於 `AppConfig` 建立之結構性取值點，非安全面）。兩者依大總管預裁處置 (i) 入白名單並附理由，機械守門已落地（T8）。**收斂候選（未落地）**：兩站點若移入 `config/env.ts` 之集中設定物件，可使「面一」白名單清空、AC-11(d) 之封閉集合更單純。此為**架構收斂建議**，非缺陷；`middleware.ts` 之 Cookie 名讀取與 `server.ts` 之 logger 初始化各有其時序理由（logger 須先於 `AppConfig` 建立），收斂需評估時序依賴。
11. **`cleanup-cli.ts` 空字串 env 值之具名一致性**（PHASE-011-T4R-DOC 判讀 NF-2，`backend/src/attachment/cleanup-cli.ts` :374-381）——`invalidNumericEnvKeys` 對空字串／全空白之數值型 env 變數採「放行」判定（不視為無效鍵名），但下游 `parseEnv` 之 `z.coerce.number().positive()` 仍會拒絕空字串並回退為通用之 `ENV_VALIDATION_FAILED`（而非具名指出是哪個變數）。**fail-closed 之方向正確**（不可逆刪除不會因空字串而用預設值偷跑），僅「是哪個變數」之錯誤訊息解析度較低。一致性守門（讓空字串也具名，或提供 `env.ts` 匯出「無效變數名陣列」之 API）曾規劃由 T8 順帶處理，**T8 完成時仍未落地**（見 T8 Handoff FW-4，再度登記於此）。
12. **Linux 環境驗證批次（M-7）**（PHASE-011-T12R／T12R-2、T13 判讀）——三項僅能在 Linux 環境完整驗證之行為，本機（Windows）開發環境無法構造：①`scripts/backup.sh`／`scripts/verify-restore.sh` 之 `rm` 呼叫未加靜音旗標（`-f`／重導向 `/dev/null`）之失敗路徑（本機無法構造該失敗條件以驗證錯誤訊息形狀）②兩腳本之 bash 重導向缺口（已於腳本內以四則子敘述誠實記載但未驗證修正，`backup.sh` AR-R2 裁定「改了但證不了比留著並寫清楚更糟」）③`scripts/verify-restore.sh` 之 `SIGINT` 訊號中斷行為（T13 已以四時點決定性驗證 Windows 可行部分，但 Linux 之訊號語意與 Windows 有別，`docs/RUNBOOK.md` 之維運程序最終將於 Linux 容器／伺服器執行，此差異須以真實 Linux 環境補一輪驗證）。**建議**：於 CI 之 Linux runner 或部署前手動驗證批次執行，逐項核銷後移除本項。
13. **`AttachmentRefType` 新增列舉值時之連動點**（PHASE-011-T13 判讀「未來 refType 工作項」；實查 `backend/src/attachment/cleanup-service.ts` :57-99、`backend/src/platform/restore-check.ts` :438-474）——日後若 `AttachmentRefType` 這個 Prisma enum 新增列舉值（例如新增一種附件容器類型），至少三處需同批更新且**今日無自動化守門提醒**：①`cleanup-service.ts` 之 `ATTACHMENT_REFERENCE_SOURCES` 封閉來源集常數（該檔註解已明載「新增一種來源＝同批更新此聯集型別與下方常數」，但依賴人工紀律非機械強制）②`restore-check.ts` 之**兩處硬編碼 SQL**（`refType::text = 'TRIP_SEGMENT' / 'MAINTENANCE' / 'DEPRECIATION'` 之 `CASE`／`JOIN` 條件，各出現一次於容器存在性查詢與孤兒盤點查詢）。**建議**：新增列舉值之 Task 應將此三處列入其 Files Allowed 與 Done When，或另立一個「`AttachmentRefType` 列舉值 ⊇ 上述三處涵蓋集合」之結構性守門格。

---

## 7. 尚開放之架構問題

| 問題 | 現況 |
|---|---|
| Session 儲存後端（DB session vs 記憶體／外部 store） | PHASE-002 Spec 已定案實作，但 ARCHITECTURE §6 之開放條目仍保留——須滿足「停用／重設密碼即失效既有 session」 |

（`ARCHITECTURE.md` §6.1 所列之兩項——Playwright 封裝方式、報表編號併發安全——**已於 PHASE-008 結案**，不再屬開放問題。）
