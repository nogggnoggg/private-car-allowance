# PHASE-005（含 CHORE-003）回顧——團隊與流程改進建議

**日期**：2026-08-03
**撰寫**：開發大總管（Orchestrator，/orchestrator 治理流程）
**目的**：本文件交付給負責「agent 框架補強」的執行者。內容為 PHASE-005 與 CHORE-003 兩回合的實際事證與改進建議。**本文件僅為建議與事證彙整，未經人類批准不構成任何治理變更授權**；建議落地時涉及治理檔（`~/.claude/commands/orchestrator.md`、`~/.claude/agents/{spec-writer,implementer,reviewer}.md`，現行 Governance-Version `2026-08-02.3`）者，須依治理規則同步升版四檔。

---

## 一、背景（給不熟悉本專案的讀者）

- 專案：私車差旅補助管理系統（React/Vite + Fastify/Prisma + PostgreSQL 16），SDD+TDD，治理流程見 `~/.claude/commands/orchestrator.md` 與專案 `CLAUDE.md`。
- 團隊結構：大總管（主迴圈，**零程式修改**，白名單僅 PROJECT_STATE／Spec 狀態欄與修訂紀錄／ADR／CHANGELOG／治理節）+ 三個全局 subagent：`spec-writer`（高推理）、`implementer`（標準推理，High Task 向上覆寫至高推理）、`reviewer`（高推理，唯讀）。自 2026-08-03 起 subagent 一律**背景派工**（使用者裁定，記錄於 PROJECT_STATE）。
- 本次回顧範圍：
  - **PHASE-005 區間公務里程統計**（PR #11 已合併）：8 功能 Task + 5 修復回合 + 3 次 Spec 同步；期中 Review REQUEST_CHANGES→修復清零；終審 34/34 AC PASS；測試 960→1078（後端）/121→137（前端）/11→17（E2E）。
  - **CHORE-003 參數欄位容量/精度/字串保真**（PR #12 已合併）：3 Task；消滅參數端點三類 500 與兩類靜默錯誤金額寫入；測試 1078→1211。
- 兩回合最終品質良好（全部 Review 清零、CI 綠、人類 Gate 通過），本文件聚焦**過程成本**與**可複製的教訓**。

---

## 二、已驗證有效、應固化保留的做法

| # | 做法 | 事證 |
|---|---|---|
| K-1 | **變異自證（mutation self-evidence）**：implementer 交付時附「把實作改壞→測試紅→還原並以 diff 證明」 | PHASE-005 T4 起採用。T4（判定順序對調→3 紅；toFixed 改 toString→4 紅）、CHORE-003-T3（還原 Number 中介→3 紅）皆即審一次通過。**對照組**：未做此事的 T2/T3 在期中 Review 被抓出套套邏輯測試（見 P-1）。 |
| K-2 | **決策點批次化**：Spec Gate 一次呈 D1~D10、CHORE 子決策一次呈 CD-1~3，附推薦與影響 | 人類介入次數最小化且授權軌跡完整（皆固化於 Spec §18/§13 修訂列）。 |
| K-3 | **Packet 防呆條款**：「裁定若改變既有測試前提，須複核原斷言在新前提下是否仍成立；不成立時 BLOCKED，不得逕行修改斷言」（治理 2026-08-02.1，源自 PHASE-004 B-30 教訓） | 本次三度奏效：R2 implementer 拒絕為不存在的 TimeZone 缺陷硬造紅燈（見 P-2）；T5 implementer 被權限分類器攔下後正確停止未繞過；T2（CHORE）implementer 正確判讀 Spec 原文優先於 Packet 字面。 |
| K-4 | **對抗性核對迴路**：finding 被實證挑戰時，送回原 reviewer 以更強方法重測並給最終 verdict | S-3 事件（見 P-2）中，原 reviewer 以「自帶 raw SQL 對照組證明 TZ 切換有效」的設計重測，正式撤回自己的 finding 並自陳根因——避免了為假缺陷修改金額上游程式。 |
| K-5 | **資料層反事實探針**（驗證授權鑑別力時不動程式、只翻 DB 旗標） | T5 複審：同一 session 同一 URL 下翻 `mustChangePassword`/`isActive`/role，直接觀測 403↔200 切換，以唯讀方式閉合 RED 證據缺口。 |

---

## 三、問題事證與改進建議

### P-1（最高優先）｜套套邏輯測試晚兩個 Task 才被發現

**狀況**：PHASE-005 T2/T3 交付的三項守門測試為套套邏輯——AC-07 的 fixture 直接手寫快照值 `35.75` 再斷言統計等於 `35.75`（引擎只讀快照，35.75 vs 53.75 鑑別在任何實作下都不可能觸發）；AC-13「快照==段加總」兩邊由同一測試同一 helper 產生（只證明 DB round-trip）。**而 AC-13 正是人類批准 D2(a)（引擎讀快照）的前提條件**。大總管驗收時跑了測試、核了 diff、確認全綠，但沒有問「這些測試在什麼錯誤實作下會紅」。缺陷由期中 reviewer 於兩個 Task 之後抓出（M-2），衍生 R1 修復回合（改用真實完成流程建立快照，+353/-55）。

**成本**：一個完整修復回合＋輕量複審；更重要的是「人類批准條件被空置」的治理風險窗口存在了兩個 Task。

**建議**：
1. **implementer agent 定義**加入交付紀律：「金額語意、授權、狀態機類的關鍵鑑別測試，交付時必附至少一組受控變異實證（改壞實作→對應測試紅→還原，diff 證明乾淨）；無法安全執行變異時（見 P-5）明文揭露並說明替代驗證。」
2. **orchestrator 治理檔 §16（Handoff 驗收）**加一條大總管檢查項：「關鍵測試之鑑別力證據（變異實證或等效說理）——缺席即退回」。這條同時是對大總管自己的約束。

### P-2（高優先）｜reviewer 以非 production 路徑證據宣稱 production 缺陷（S-3 誤判事件）

**狀況**：期中 reviewer 提出 S-3：「統計的日期比較依賴 DB session TimeZone=UTC，非 UTC 環境會靜默漏算起日當天」。其證據是 (a) raw SQL 字面量 cast 探針（`'2026-03-01'::date >= '...'::timestamptz` 在 Asia/Taipei session 為 false——現象本身為真）與 (b) Prisma query log 中參數的字串化呈現被**推論**為 timestamptz 綁定型別。大總管採納並升級為 src 修復回合 R2。R2 implementer 依防呆條款先複核，實測 **production 路徑（Prisma 結構化 API 對 `@db.Date` 以 date 型別 OID 綁參）在 UTC±14 四種 session 下逐位元恆定**——缺陷只存在於 raw SQL+JS Date 綁參路徑（當時 src 零暴露）。原 reviewer 對抗性重測後正式撤回，自陳根因為「兩個獨立探針之間的未驗證推論跳躍」。

**成本**：R2（BLOCKED）＋對抗性重測＋R4-LITE（移除已擴散至三處的錯誤敘述與守門斷言）≈ 三個 agent 回合。若防呆條款未攔住，代價會是「為不存在的缺陷修改金額上游程式」。

**建議**：
1. **reviewer agent 定義**加入 finding 規範：「宣稱 production 缺陷時，必須以實際 production 程式路徑重現（結構化 API、真實 route、真實資料流）；raw SQL／字面量／log 字串化等探針僅為輔助證據。無法路徑重現者，finding 必須標記為『未經路徑驗證的假設』並降級呈報。」
2. 保留 K-4 的對抗性核對迴路作為第二道防線（本次證明有效），但目標是讓成本前移到 finding 產出時。

### P-3（高優先）｜「單一驗證腳本」治理早有建議但始終未建（大總管欠帳）

**狀況**：治理 §16 明文「專案應盡早建立單一驗證腳本（format＋lint＋type check＋相關測試），讓 implementer 貼的與大總管跑的是同一支腳本的輸出」。專案跑完 PHASE-005 後，`CLAUDE.md`「常用指令」節**仍是空的**。實際後果：每個 Packet 手寫 4~5 條驗收指令（曾發生指令細節不一致）；每份 Handoff 貼 4~5 段完整輸出（Handoff 動輒數百行，大總管 context 消耗大）；驗收環境差異（`DATABASE_URL` 帶入方式、biome 掃描範圍）反覆在 Packet 中重複說明。

**建議**：建立 `verify.ps1`／npm script（backend 全套＋frontend＋tsc×2＋root biome，參數化 DATABASE_URL），寫入 `CLAUDE.md` 常用指令節；Packet 驗收指令一律引用該腳本；Handoff 只貼該腳本的單一輸出區塊。這是一次性成本、每 Task 回收的投資。

### P-4（中高優先）｜AC↔測試映射表同步的結構性滯後

**狀況**：治理 2026-08-02.1 要求「終審核對以映射表為準、GREEN 列測試名須逐字可 grep」。PHASE-005 為此做了**三次** SPEC-SYNC 派工（spec-writer），終審仍抓到一條數字失效（R5-BATCH 新增 1 條測試後表註總數過期）；另有 8 條「Spec 預定測試名（英文）vs 實作實名（zh-TW）」漂移。文件追實作天生滯後，靠人（agent）補同步成本高且會漏。

**建議**（三選一或組合，需人類批准治理變更）：
1. 治理白名單開一條縫：允許 implementer 於交付 commit 中**直接更新 Spec 映射表之「狀態＋測試名」欄**（AC 條文本體仍禁動）——消滅同步時差。
2. 更徹底：約定測試名帶 AC 標籤（如 `[AC-07]`），映射表由腳本自 test 檔生成、Spec 只保留例外註記——「機械可查」由生成保證而非人工回填。
3. 最小改動：Spec 初稿的映射表**不寫預定測試名**（只寫情境描述、名稱欄留空），從源頭消滅「可機械證偽的假陳述」風險。PHASE-005 後段已採半步（implementer Handoff 附實名對照表），可固化。

### P-5（中優先）｜變異實驗與安全防護的衝突缺乏標準解法

**狀況**：T5 implementer 為證明權限矩陣鑑別力，嘗試暫時移除 `requirePasswordChanged` 中介再跑測試，被環境權限分類器連續攔下（分類器行為正確——那確實是「弱化授權」）。implementer 正確還原並停止，但列 4/5/6 的 RED 證據因此缺席，靠複審 reviewer 以資料層反事實探針（K-5）補齊。

**建議**：把 K-5 升級為兩個 agent 的標準工具：「授權/安全類鑑別力驗證，**優先採資料層反事實**（翻合成帳號的 DB 旗標、換 role、換 session——不動任何程式），僅在資料層無法表達時才考慮程式變異，且預期會被安全防護攔截時直接改用替代法並揭露」。寫進 implementer 與 reviewer 定義各一句即可。

### P-6（中優先）｜Packet 預算系統性低估

**狀況**：R1 實際超預算 41%、T6 超 66%、T3 超 90%、CHORE-003-T3 超 90%。共同原因：大總管估行數時未計入「說理註解」——而 AC 常明文要求說理留存（如 AC-29 要求鑑別力來源說明）。每次超預算都觸發 implementer 的揭露-裁決流程，是純摩擦。

**建議**：Expected Diff Budget 改以「檔案數＋測試條數＋可執行行數」為單位，明文排除註解/說理行；或在治理 §14 加一句「說理性註解不計入行數預算」。

### P-7（低優先）｜worktree 派工的環境噪音

**狀況**：spec-writer 以 worktree 隔離派工後，`.claude/worktrees/**/settings.local.json`（CRLF）污染 root `biome check` 訊號達四個回合，每份 Handoff 都要花篇幅解釋「這 2 個 error 不是我的」，直到 T6 以 `.gitignore` 加 `.claude/` 根治。

**建議**：worktree 派工 SOP 第一步檢查環境噪音；或專案模板預設 `.gitignore` 含 `.claude/`（本專案已修，新專案應內建）。

### P-8（低優先）｜跨 checkout 的測試併行不安全

**狀況**：CHORE-003 Spec 產出與 PHASE-005 實作曾獲批准並行，但大總管評估後發現：兩個 checkout 同時跑 vitest 會共用同一測試 DB 的 per-worker schema 槽位（`vitest_w1...`，INFRA-001 隔離只認 worker id 不認 checkout），會互相污染。實際處置為改回序列執行（文件產出仍並行，因 worktree 無 node_modules 也跑不了測試）。

**建議**：若未來需要真正的實作並行，INFRA 層讓 schema 前綴帶 checkout 識別（或每 checkout 獨立 DB port）；在此之前，治理明文「同一測試 DB 同時只允許一個 suite 執行」。列 PHASE-011 候選。

### P-9（低優先）｜人類 Gate 的合成資料準備靠瀏覽器手動操作

**狀況**：Mock/整合 Gate 前，大總管以瀏覽器手動操作 20+ 步建立合成資料（建帳號、參數、兩筆完成差旅），其中附件上傳需以 JS 注入 file input（一次意外傳了兩張）。可重現性差、耗時。

**建議**：建立 gate-seed 腳本（合成管理員/使用者/參數/已完成申請一鍵就緒），作為驗收基礎設施；設計時守住「測試資料不得流入正式環境」的既有規範（可要求 NODE_ENV 檢查）。列 PHASE-011 候選。

### P-10（觀察）｜長 session 的紀律維持

**狀況**：本 session 連續完成兩個完整回合（PHASE-005＋CHORE-003）。歷史教訓（PHASE-002 治理事件根因分析）指出 context 長度是違規放大器。本次靠「Phase 開工重讀 §15 禁令節」與 PROJECT_STATE 高密度記錄撐住零違規，但屬於「靠紀律不靠結構」。

**建議**：約定「一個 Phase／Chore 回合一個 session」為預設節奏；PROJECT_STATE 的接力密度已驗證足夠（本 session 開頭即從純文件狀態完整接手）。

---

## 四、建議優先序（供框架補強執行者排程）

| 優先 | 項目 | 落點 | 治理升版？ |
|---|---|---|---|
| 1 | P-1 變異自證入 implementer 定義＋大總管驗收檢查項 | `agents/implementer.md`、`commands/orchestrator.md` §16 | 是（四檔同步） |
| 2 | P-3 單一驗證腳本 | 專案 repo（scripts）＋`CLAUDE.md` 常用指令節 | 否（程式類，須走 implementer 派工） |
| 3 | P-2 reviewer finding 規範（production 路徑重現） | `agents/reviewer.md` | 是 |
| 4 | P-5 資料層反事實探針標準化 | `agents/implementer.md`、`agents/reviewer.md` | 是（可與 1、3 同批升版） |
| 5 | P-4 映射表同步結構性解法（三案擇一） | 治理檔＋（選案 2 時）專案腳本 | 是，且屬白名單變更，**必須人類批准** |
| 6 | P-6 預算單位修正 | `commands/orchestrator.md` §14 | 是 |
| 7 | P-7/P-8/P-9 | 專案層（PHASE-011 加固候選清單已有對應條目） | 否 |

**注意事項（給執行者）**：
- 治理四檔任何修改須同步升 `Governance-Version`（現行 `2026-08-02.3`，格式 `YYYY-MM-DD.N`），缺一檔即啟動自檢警告。
- P-4 選案 1 涉及「大總管/implementer 白名單」變更，依既有治理慣例屬人類必批事項，請勿逕行落地。
- 本文件的事證均可在 `PROJECT_STATE.md`（PHASE-005/CHORE-003 節）、`docs/specs/PHASE-005.md` §18、`docs/specs/PHASE-003a.md` §13/§14 與 PR #11/#12 的 commit 歷史中交叉查證。
