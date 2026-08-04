# PHASE-005a subagent context 用量彙整報告——派工型態分析與迴圈優化建議

**日期**：2026-08-04
**撰寫**：agents loop workflow 設計 agent（依 PROJECT_STATE.md「subagent context 用量觀測」追蹤項之結案義務）
**資料來源**：`PROJECT_STATE.md` PHASE-005a 各結案列之 usage 標注（輸出 token 約值；部分列附 tool uses 計數）、`docs/specs/PHASE-005a.md` §15 Task Graph／§18 修訂紀錄（Task 性質對照）、`docs/retrospective/PHASE-005.md`（前 Phase 回顧）。
**用途**：供未來多 agent 開發迴圈的派工分級、Packet 設計與複審節奏優化。**本文件僅為建議與事證彙整，未經人類批准不構成任何治理變更授權。**

---

## 1. 全 Phase usage 總表

usage 為輸出 token 約值（k）；tool uses 僅後半 Phase（T9 起）有記錄。「結果輪次」指該產出到 Review 清零所經的修復回合數。

### 1.1 Spec 通道（spec-writer）

| 項目 | 性質 | usage | 產出規模 | 結果 |
|---|---|---|---|---|
| US-DRAFT | US 修訂提案 | ~121k | 309 行提案 | 一次通過人類 Gate |
| US-LAND | US 落地 | ~140k | +156/-21 ＋ PRD | 一處自我攔截越權後通過 |
| SPEC-005a | Phase Spec 全文 | ~257k | 1062 行 | 一次通過人類 Gate |
| SPEC-REV1 | Spec 修訂（AC-37 新增） | ~133k | 修訂＋逐檔 grep 實查 | grep 截斷致遺漏 → 引發 REV2 |
| SPEC-REV2 | Spec 修訂（補列＋窮盡 grep） | ~158k | 61 行/11 檔全歸類 | 通過 |

小計 ~809k。

### 1.2 實作通道（implementer）——完整 Task

| Task | 性質／Risk | 通道 | usage | tool uses | 結果輪次 |
|---|---|---|---|---|---|
| T1 | schema+migration／High | 完整 | ~184k | — | 即審 RC → R2 輪清零 |
| T2 | 純函式金額核心／High | 完整 | ~107k | — | 合併複審 RC → 1 輪 |
| T3 | service+route 48 測試矩陣／High | 完整 | ~221k | — | 即審 RC（1 Must）→ 1 輪 |
| T3b 首輪 | 舊端點凍結／High | 完整 | ~154k | — | **BLOCKED**（Spec 清單漏列） |
| T3b 續行 | 同上（SendMessage 續派） | 續行 | ~291k | — | DONE；**合計 ~445k** |
| T4 | 油耗 service 50 測試／High | 完整 | ~198k | — | 即審 APPROVE（0 輪） |
| T5 | route+授權矩陣／High | 完整 | ~220k | — | 即審 RC（1 Must）→ 1 輪 |
| T6 | 自身唯讀端點／High | 完整 | ~129k | — | 即審 RC → 1 輪 |
| T7 | 參數解析改造＋D5(a) 更名／High | 完整 | **~439k** | **244** | 合併即審 RC → 1 輪＋Spec 補列 |
| T8 | 完成流程快照／High | 完整 | ~271k | — | 即審 RC → 1 輪 |
| T9 | 油價前端／Medium | 完整 | ~167k | 59 | 合併複審通過 |
| T10 | 油耗維護頁／Medium | 完整 | ~191k | 75 | 合併複審通過 |
| T11 | 個人檢視＋缺參數提示／Medium | 完整 | ~221k | 93 | 合併複審 SF-1 → T11R |
| T12 | 錯誤合約（純測試檔）／Medium | 完整 | ~143k | 43 | 合併複審通過 |
| T13 | 響應式＋E2E 六情境／Medium | 完整 | ~214k | 114 | 終審回退 AR-4 → T13R2 |
| T13R | E2E 播種修復／Medium | 完整 | ~258k | 102 | 終審通過 |
| T14 | Gate 反饋①／Medium | 完整 | ~92k | — | 輕審 RC → T14R |

### 1.3 實作通道（implementer）——Lite／修復回合

| 項目 | usage | 備註 |
|---|---|---|
| T1R-LITE | ~65k | 機械連動（斷言計數） |
| T1R2-LITE | ~95k | 五表逐欄比對擴充 |
| T2R-LITE | ~88k | +4 防禦測試 |
| T3R-LITE | ~137k | 修 M-1 假測試＋3 AR 併修（Lite 中最重） |
| T3R2-LITE | ~73k | self-proof 管線修正 |
| T5R-LITE | 未記錄 | — |
| T6R-LITE | 未記錄 | — |
| T7b-LITE | ~70k | ParameterType 四型別 |
| T7R-LITE | 未記錄 | — |
| T8R-LITE | 未記錄 | — |
| T11R | ~91k | SF-1 修復（2 檔） |
| T13R2 | ~99k | 含 API 中斷 SendMessage 續派 |
| T14R-LITE | ~70k | +53 行補測試 |

有記錄之 Lite 區間：**65k~99k**（T3R 137k 為多項併修之外圍值）。

### 1.4 Review 通道（reviewer）

| 項目 | 涵蓋範圍 | usage | tool uses | verdict |
|---|---|---|---|---|
| T1 即審 | 1 Task | ~120k | — | RC（0 Must） |
| T1R2＋T2 合併複審 | 1 Lite＋1 Task | ~105k | — | RC（SF-1 真缺陷） |
| T2R＋SF-2 輕量複審 | 關閉確認 | ~76k | — | APPROVE |
| T3 即審 | 1 Task | ~123k | — | RC（1 Must） |
| T3R＋T3b 合併複審 | 1 Lite＋1 Task | ~115k | — | RC（僅 SF-1） |
| T4 即審＋SF-1 確認 | 1 Task＋關閉確認 | ~123k | — | APPROVE |
| T5 即審 | 1 Task | ~104k | — | RC（1 Must） |
| T6 即審＋T5R 確認 | 1 Task＋關閉確認 | ~95k | — | RC（0 Must） |
| T7＋T7b＋T6R 合併即審 | 2 Task＋關閉確認 | ~191k | — | T7 RC（0 Must/5 Should） |
| T8 即審＋T7R 確認 | 1 Task＋關閉確認 | ~163k | — | RC（0 Must/3 Should） |
| T8R 輕量關閉確認 | 關閉確認 | ~95k | — | 程式面清零 |
| T9~T12 合併複審 | **4 Task** | ~208k | 90 | RC（0 Must/1 Should；SF-1 真缺陷） |
| 終審 | 全 Phase＋3 修復 | ~166k | 60 | RC（0 Must/3 Should） |
| T13R2 輕量複審 | 關閉確認 | ~58k | 37 | APPROVE |
| T14 輕量複審 | 1 Task | 未記錄 | — | RC（SF-1）→ T14R |

### 1.5 總計（有記錄項）

| 通道 | 項數 | 合計 | 均值 |
|---|---|---|---|
| Spec | 5 | ~809k | ~162k |
| 實作（完整 Task） | 17 | ~3,500k | ~206k |
| 實作（Lite／修復） | 9（有記錄） | ~788k | ~88k |
| Review | 14（有記錄） | ~1,742k | ~124k |
| **全 Phase（有記錄項）** | 45 | **~6,839k** | ~152k |

Review 通道合計約占全 Phase 25%；Lite 通道以約 43% 的完整 Task 均值成本消化了全部修復回合。

---

## 2. 型態驗證（對 PROJECT_STATE 初步觀察①~⑦逐一以全 Phase 數據覆核）

### ① 「Spec 產出與大型測試矩陣為前兩大戶」——**部分修正**

前半 Phase 成立（SPEC-005a ~257k、T3 ~221k 領先），但全 Phase 收齊後排序改變：

| 排名 | 項目 | usage | 驅動因素 |
|---|---|---|---|
| 1 | T7 | ~439k | 破壞性更名波及面探索（型態⑤） |
| 2 | T3b 首輪＋續行 | ~445k（雙輪合計） | BLOCKED 續派（型態②） |
| 3 | T8 | ~271k | 快照整合＋SF-2 落地 |
| 4 | T13R | ~258k | E2E 環境迭代（型態⑥） |
| 5 | SPEC-005a | ~257k | 1062 行 Spec 產出 |

**修正結論**：單輪最大戶是「波及面探索型」與「E2E 環境迭代型」，非 Spec 產出。Spec 產出成本高但**可預測且單調**（與產出行數大致線性）；波及面與環境迭代成本則**不可預測**，才是預算失控主源。大型測試矩陣（T3 221k、T4 198k、T5 220k、T11 221k）穩定落在 ~200-220k 帶，可視為「High/矩陣型 Task 的標準成本」。

### ② 「BLOCKED→續派使單 agent 累積雙輪脈絡」——**驗證成立，且與⑦形成關鍵對照**

T3b 合計 ~445k：首輪 154k（分析後 BLOCKED，等待 SPEC-REV2）＋續行 291k（續行輪帶著已過時的首輪分析脈絡重工）。續行輪單獨即為全 Phase 第三高，超過任何一個從零派工的同級 Task（T3b 性質相近的 T3 為 221k）。**估算**：若 SPEC-REV2 定案後改派新 agent、Packet 只帶裁定結論與三道窮盡 grep 結果，成本應落在同型 Task 的 ~150-220k 帶，可省約 100-150k。詳見 §3.3。

### ③ 「Lite 通道成本約完整 Task 三分之一」——**驗證成立，區間微調**

全 Phase Lite 有記錄 9 筆：65k~99k（中位 ~88k），對完整 Task 均值 206k 為 **~43%**，對矩陣型 Task（~210k）為 ~40%。外圍值 T3R 137k 的原因是單一 Lite 回合併修 1 Must＋3 AR——**Lite 回合塞入多項異質修復會使其退化回半個完整 Task**。分級派工有效性確認。

### ④ 「reviewer 恆在 76k~123k 區間，穩定」——**修正：區間僅對單 Task 審成立，合併審隨範圍線性擴張**

- 單 Task 即審（含輕量關閉確認搭車）：**95k~123k**，極穩定（6 筆全落帶內）。
- 輕量關閉確認（獨立）：**58k~95k**。
- 合併審：T7＋T7b＋T6R ~191k、T9~T12 四 Task ~208k、終審 ~166k。

**修正結論**：reviewer 成本 ≈ 基礎 ~60k ＋ 每個實質 Task 約 35-50k。合併審沒有「免費」——它把多個 Task 的邊際成本疊在一個 context 內，省的是基礎成本與重複環境建置，代價見 §3.4。

### ⑤ 「破壞性更名之波及面 low-ball」——**驗證成立（T7 單案，全 Phase 最高）**

T7 ~439k／244 tool uses。主因：D5(a) 更名波及 Packet 檔案清單外 6 個測試檔的 fixture 機械傳播，implementer 靠「跑全套→逐一紅燈→修→再跑」迭代發現。244 次 tool uses 中大量是這種發現式迴圈。**同型先例**：SPEC-REV1 的 grep 被截斷於 100 筆未察覺（已立「grep 原文＋命中計數落檔」規則）——兩案根因同構：**波及面必須在派工前以窮盡 grep 定案，不能留給 agent 執行期探索**。

### ⑥ 「E2E 類 Task 因 playwright 迭代與環境探索居高」——**驗證成立**

T13 ~214k/114、T13R ~258k/102。兩者 tool uses（114/102）為全 Phase 最高帶（矩陣型 BE Task 約 43-93），印證成本主要來自「跑 E2E→觀察→調整」的高輪次迭代而非產出量。T13R 另含大總管親跑揭露的播種非冪等問題（持久 dev DB），屬環境狀態探索成本。

### ⑦ 「API 中斷續派以 SendMessage 原 agent 續行，成本低於重派」——**驗證成立，適用條件須與②區分**

T13R2 含中斷續派全程 ~99k，仍落在 Lite 帶。與②的表面矛盾其實是適用條件不同：

| 維度 | T3b（②，貴） | T13R2（⑦，便宜） |
|---|---|---|
| 中斷性質 | 語意性 BLOCKED（Spec 缺口，需人類/Spec 迴圈） | 機械性中斷（API 連線斷） |
| 中斷時 context 價值 | 首輪分析在 SPEC-REV2 後**部分過時** | 半成品狀態（src 已改、測試未動）**完全有效** |
| 等待期間 | 跨一個 Spec 修訂迴圈 | 即時 |
| 續行負擔 | 舊分析＋新 Spec 對賬重工 | 從斷點直接續作 |

**規則化**：中斷時 context 是否仍為有效資產，決定續派或重派。

---

## 3. 派工型態建議（具體可執行）

### 3.1 哪類 Task 該拆

1. **預測 usage > ~250k 的 Task 應在 Packet 設計期拆分**。本 Phase 超過此線的四案（T7、T3b 雙輪、T8、T13R）全部伴隨修復回合或事件。可操作的預測訊號：
   - 觸及檔案 ≥ 5 且含跨檔更名／契約變更 → 拆「更名機械傳播」為獨立前置 Task（純 fixture/import 改名，Lite 級，波及清單由派工前 grep 定案）。T7 若如此拆，主 Task 可回到 ~250k 帶、傳播 Task ~70-100k。
   - E2E 情境 ≥ 4 或需觸碰共用 helper／播種 → 拆「播種／helper 改造」與「新情境」為二（T13/T13R 事後實際就是這個形狀，只是以修復回合的形式被動發生——應改為主動規劃）。
2. **矩陣型 BE Task（~200-220k）不必拆**：T3/T4/T5/T11 成本穩定、單 commit 原子性價值高，是目前規模上限（≤5 AC/≤6 檔）下的健康形狀。

### 3.2 哪類 Task 適合 Lite

有效範圍（本 Phase 實證）：單一 finding 修復、機械連動（計數斷言）、負向斷言補位（T7b）、單點護欄補齊（T13R2 SF-1）。**反例教訓**：T3R 把 1 Must＋3 AR 塞進一個 Lite 回合 → 137k（Lite 帶上限的 1.4 倍）。建議明文：**Lite 回合以「1 個主 finding ＋ 至多 2 個同檔小 AR」為上限**，超過即升完整修復 Task 或拆兩個 Lite。

### 3.3 BLOCKED 後「續派」vs「重派」成本比較（T3b vs T13R2 兩案例）

- **T3b**：語意性 BLOCKED → SendMessage 續派，合計 ~445k。續行輪 291k 高於任何同型從零派工（對照 T3 221k、T4 198k），差額 ~70-140k 即為「舊脈絡對賬稅」。
- **T13R2**：機械性中斷 → SendMessage 續行，合計 ~99k（Lite 帶內）。大總管先核對工作區半成品狀態再續派，零污染。

**建議規則**（可寫入 §15）：
- 機械性中斷（API 斷線、逾時、環境故障）且工作區狀態可核對 → **SendMessage 原 agent 續行**（大總管先做工作區狀態核對）。
- 語意性 BLOCKED（Spec 缺口、裁定待決）→ 原 agent 結束（Handoff 記錄發現與還原證明），Spec 迴圈完成後**開新 agent 附精簡 Packet**（只帶：裁定結論、窮盡 grep 結果、前輪 BLOCKED 的發現摘要一段；不帶前輪對話）。
- 例外：Spec 迴圈可在極短時間內完成且僅為單點補列時，續派仍可接受——但 T3b 案例顯示即使補列不大，續行稅仍顯著，預設應為重派。

### 3.4 複審「合併」vs「即審」成本效益

- **成本面**：T9~T12 四 Task 合併複審 ~208k（均攤 ~52k/Task）；同等四次即審依單審帶（~95-123k）估 ~420-490k。**合併省約 55%**。
- **風險面**：合併審使缺陷發現延後。T11 的 SF-1（真缺陷，前端誤報且隱藏後端金額）在 T12 完成後才被抓到，衍生 T11R（91k）＋終審再驗；若 T11 即審，T12/T13 的部分工作不受其牽動。對照組：T3/T5 的 Must 級缺陷在即審被當場攔下，未污染下游。
- **本 Phase 實際節奏已趨近最優**：High（金額/授權/migration/公開契約）Task 全部即審；Medium 前端鏈合併審。
- **建議固化**：High → 即審不合併（允許搭車輕量關閉確認，如 T4＋SF-1、T8＋T7R，實證幾乎零邊際成本）；Medium 且互不依賴金額語意 → 合併審，**上限 3 個 Task**（四 Task 合併時 SF-1 延遲成本已可觀；三個為均攤收益與延遲風險的折衷）；Lite 修復 → 併入下一個即審或輕量關閉確認（本 Phase 慣例，實證有效）。

### 3.5 E2E 類 Task 的預算校準

- usage 預算：**~200-260k／Task**（一般 Medium 前端的 1.3-1.5 倍）；tool uses 預期 **100+**。
- Packet 必含（把探索成本前移為已知條件）：①目標環境的播種現況（哪些 helper 播什麼模型、是否冪等）②持久 DB vs 乾淨 DB 的宣告③既有 spec 檔的斷言風格（是否有具體金額斷言——T13R 因三檔皆無金額斷言而免等值換算，這類事實派工前可查）。
- 新增情境與共用 helper 改造分 Task（見 §3.1）。

### 3.6 usage 記錄紀律

本 Phase 有 5 筆 Lite／1 筆複審 usage 未記錄，tool uses 僅後半有。建議：Handoff 模板加「usage 約值＋tool uses」欄位（implementer/reviewer 自報），大總管結案列照抄——記錄成本趨近零，缺口即消失。

---

## 4. 對治理檔（orchestrator.md）的具體修訂建議清單

**僅建議；治理檔修改須人類批准並同步升 Governance-Version（現行 2026-08-01.2 系）。**

### §14 Context-Driven Task Packet

| # | 建議 | 依據 |
|---|---|---|
| 14-1 | Packet 增設「usage 預算帶」欄位，依型態給參考值：矩陣型 BE ~200-220k；FE 頁面 ~170-220k；E2E ~200-260k；Lite ~65-100k；Spec 全文 ~250k。超帶 50% 為 Stop/揭露門檻的量化基準（與既有 diff 預算並列） | §1.5、§2③⑥ |
| 14-2 | **破壞性更名／公開契約變更類 Task：波及面 grep 由大總管（或前置 spec 迴圈）於派工前窮盡執行，grep 指令原文＋命中計數＋逐檔歸類落入 Packet**；agent 執行期「發現式波及」即為預算事故訊號 | §2⑤（T7 439k）、SPEC-REV2 先例 |
| 14-3 | E2E Task Packet 必含環境事實三項（播種現況／DB 持久性／既有斷言風格） | §3.5 |
| 14-4 | Lite Packet 範圍上限明文：1 主 finding＋至多 2 同檔小 AR，超過升級 | §3.2（T3R 137k） |

### §15 Agent 分派與執行（含派工分級）

| # | 建議 | 依據 |
|---|---|---|
| 15-1 | 中斷處置二分法入「執行規則」：機械性中斷 → 大總管核對工作區後 SendMessage 原 agent 續行；語意性 BLOCKED → 原 agent 收 Handoff 結束，Spec 迴圈後**新 agent＋精簡 Packet**（預設重派，續派為需說理的例外） | §2②⑦、§3.3 |
| 15-2 | 派工分級表補「更名傳播」型態：純機械 fixture/import 傳播列 Lite 級獨立 Task，與語意實作分離 | §3.1 |
| 15-3 | 預測 usage 超 ~250k 的單 Task 於 Task Graph 設計期拆分（拆分訊號：≥5 檔＋跨檔契約變更、E2E ≥4 情境＋helper 改造） | §3.1 |
| 15-4 | Handoff 模板加 usage／tool uses 自報欄；大總管結案列照抄（記錄義務常態化，不再依 Phase 特別指示） | §3.6 |

### §19 Code Review（Review 節奏）

| # | 建議 | 依據 |
|---|---|---|
| 19-1 | Review 節奏明文分級：High Task 一律即審（可搭車前輪 Lite 之關閉確認——實證零邊際成本）；Medium 且不涉金額語意可合併審，**合併上限 3 Task**；Lite 修復預設併下一次審 | §3.4 |
| 19-2 | reviewer 預算帶：單審 ~95-125k、輕量關閉確認 ~58-95k、每加一個合併 Task ＋35-50k——供大總管決定合併範圍時估算 | §2④ |
| 19-3 | 終審前提下，四 Task 級合併審的缺陷延遲風險（本 Phase SF-1 案例）記為節奏選擇的顯性代價，不以均攤便宜為唯一準則 | §3.4 |

---

## 5. 流程建議：每 Phase 結束之大總管復盤（使用者裁定，常設流程）

**使用者裁定（2026-08-04）**：本報告之產出方式——Phase 結束時由大總管彙整全 Phase subagent usage 數據（各結案列累記之 usage／tool uses），派分析 agent 產出 retrospective 報告——自 PHASE-005a 起立為**常設流程**，每個 Phase 結束皆執行。

**建議「AGENTS LOOP workflow 設計 agent」將此方法納入多 agent 迴圈設計**：

- **Phase 級 usage 復盤為迴圈的固定收尾步驟**——位置在人類合併批准之後、下一 Phase 開工之前，與 Spec 轉 COMPLETED／PROJECT_STATE 結案列同屬 Phase Done 的收尾動作。
- **數據餵入下一 Phase 的派工預算校準**——復盤報告之 usage 帶（§1.5、§4 之 14-1/19-2）作為下一 Phase Task Graph 設計與 Packet 預算的輸入；型態驗證節（§2 形式）逐 Phase 累積，使派工型態庫隨專案演進而非單次快照。
- **前置依賴**：usage 記錄紀律（§3.6，Handoff 自報欄＋大總管結案列照抄）是本流程的資料來源，兩者應同批落地。

## 6. 附註：與 PHASE-005 回顧之銜接

- 本報告 §3.1/§14-2 與 PHASE-005 回顧 P-6（預算系統性低估）同向：005a 已將行數預算按 T3/T4 實績校準（T5 起首次落帶內），本報告再補 usage 維度。兩者合併後，Packet 預算應為「檔數＋測試條數＋可執行行數＋usage 帶」四元組。
- PHASE-005 回顧 P-3（單一驗證腳本）在 005a 仍未建：T7 的 244 tool uses 中相當比例為重複的全套驗證指令組合，verify 腳本可直接壓低所有 Task 的 tool uses 底噪。優先序維持高位。
