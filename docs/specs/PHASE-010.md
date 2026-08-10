# PHASE-010 — 稽核檢視與回歸

- Governance-Version: 2026-08-09.1
- 狀態：**`ACTIVE`**（人類 leonchih 2026-08-09 Spec Gate 通過：D1~D12 全數裁定＋T1/T2/T3/T5 四項 High Task 事前批准＋3 條件 AC 全生效——見 §18）
- 建立日期：2026-08-09
- Task ID：`PHASE-010-SPEC`
- Base Commit：`41181ce`（branch `phase-010`，自 `main` `02a7d5f`＝PR #18 合併點切出）
- 上游（優先序依 `CLAUDE.md`）：人類確認決策 → `userstory.md`（AD-US-04 :930／AD-US-14 :1154／BE-US-31 :1968）→ `docs/PRD.md` :503-521 → `docs/ARCHITECTURE.md`／`docs/DATA_FLOW.md`／ADR → 現行實作
- 風險等級：**High**（稽核完整性＝授權與不可逆操作之可追溯性；PRD :509 明定）

> **Blocking Unknowns：無**。以下兩項為**待人類裁定之決策點**（非未知資訊），已逐條列於 §16。
>
> **資訊缺口（不阻塞 Spec，但影響 D6 之裁定品質，建議 Gate 時人類補充）**：
> 1. **PHASE-009 終審對 D-1（error-handler 兜底洩漏面）所給之「四段 AC 草案」本文，於 repo 內查無留存**。spec-writer 實查：`PROJECT_STATE.md` :118 僅載「終審已給四段 AC 草案含站點白名單掃描」一句、`docs/KNOWN_ISSUES.md` :49 僅載一列摘要，**兩處皆無草案本文**。故本 Spec §2 H 段之 AC-21 四段係 spec-writer **依該摘要重建**，來源類別標記為**「建議新增」**——Gate 須確認其與終審原意是否一致，或由人類直接否決納入（D6(b)）。
> 2. **稽核列表之篩選維度**：`userstory.md` AD-US-14 未要求任何篩選；「篩選」二字之唯一出處為 `docs/PRD.md` :507「UI 驗收：Mock Gate（稽核列表/篩選）」。故篩選維度之集合屬**PRD 授權範圍內之設計裁量**，列 §16 **D2** 供裁定。
>
> **技術棧疑義：無**。本 Phase 所需之全部技術面（管理端授權中介、分頁／全序排序慣例、`AuditLog` 表與 10 個 `AuditAction` 值、前端管理頁與 API client 慣例、E2E 播種）皆已於 PHASE-002~009 落地並在場。**零新增 npm 依賴、零新增外部服務、零容器變更**；若 §16 **D8** 依推薦裁定 (a)，則本 Phase **零 migration**（見 §8）。

---

## 0. 導讀與逐字依據

### 0.1 PRD §PHASE-010 逐字為綱（`docs/PRD.md` :503-521；行號為本次 grep 實查）

| PRD 條目 | 逐字內容（節錄） | 本 Spec 落點 |
|---|---|---|
| 標題（:503） | 「PHASE-010 — 稽核檢視與回歸」 | 全文 |
| 目標（:505） | 「管理員稽核檢視頁（操作者/時間/類型/受影響資料、重要欄位前後摘要、密碼不入稽核），並回歸驗證前面各 Phase 已寫入的稽核事件（帳號新增/停用/密碼重設/代操作/作廢/參數異動）齊備。AD-US-04（有歷史拒刪）的完整回歸亦在此確認」 | §1.1、§2 A~D |
| Out of Scope（:506） | 「稽核事件的『寫入』已分散於 PHASE-002/003a/004/009；本 Phase 只做集中檢視與回歸，不重寫寫入邏輯（若發現缺漏則回補）」 | §1.2、§16 **D11**（實查結論：**US 明列之七類事件零缺漏**，本 Spec 不提出回補 Task；另揭露一項非 US 要求之不對稱交人類裁定） |
| 對應 US（:507） | 「AD-US-14；BE-US-31（集中檢視/回歸）；AD-US-04（有歷史拒刪回歸）」 | §0.2 溯源表 |
| AC 摘要（:508） | 「新增/停用/密碼重設/代操作/作廢/參數異動皆有稽核；顯示操作者/時間/類型/受影響資料；重要欄位變更可見前後摘要；密碼不入稽核；有歷史資料之帳號拒絕永久刪除並提供停用」 | §2 全節逐條展開 |
| UI 驗收（:509） | 「Mock Gate（稽核列表/篩選）+ 整合 Gate」 | §15.4 Gate 規劃 |
| 涉及層（:510） | 「FE / BE / DB」 | §15.2 規模上限自查（**無任一 Task 同時橫跨三層**） |
| Risk Level（:511） | 「High（稽核完整性 = 授權/不可逆操作可追溯性）」 | 本檔風險等級 |
| Human Gate（:512） | 「事前批准（High：稽核可追溯性）+ Mock Gate + 整合 Gate」 | §16 |
| 初始 Task Graph 概要（:513-517） | T1 稽核查詢端點（僅管理員、篩選、前後摘要呈現）**High**／T2 回歸：確認各事件寫入齊備、密碼不入稽核 **High**／T3 AD-US-04 有歷史拒刪回歸 **High**／T4 前端稽核檢視頁 | §15.3 對照 |
| High 風險 Task（:519） | 「T1, T2, T3」（PRD 概要編號） | §15.3 對照（本 Spec 為 **T1~T5**，見該節保守升級說明） |
| Rollback 概要（:520） | 「以讀取檢視為主；若回補稽核寫入則屬新增，回滾以分支還原」 | §14 |

### 0.2 US → AC 溯源總表（**每條 US 驗收條件逐條有落點，無遺漏**）

| US | 驗收條件（`userstory.md` 逐條，行號為實查） | 本 Spec AC |
|---|---|---|
| **AD-US-14**（查看基本稽核紀錄，:1154） | ①管理員執行新增、停用、密碼重設、代操作、作廢、參數異動**或油耗資料異動** → 操作成功 → 應產生稽核紀錄 | AC-07, AC-08, AC-10 |
| | ②管理員查看稽核紀錄 → 系統顯示資料 → 應包含**操作者、操作時間、操作類型及受影響資料** | AC-01, AC-04, AC-15 |
| | ③操作涉及重要欄位變更 → 顯示稽核資料 → 應可辨識**修改前後**的重要欄位摘要 | **AC-06**（依 §16 **D3**）, AC-18 |
| | ④操作涉及密碼 → 產生稽核紀錄 → **不得保存密碼內容** | AC-09 |
| **BE-US-31**（記錄重要操作稽核資訊，:1968） | ①管理員代替使用者建立或修改草稿 → 保存成功 → 記錄管理員、資料擁有人、時間及操作類型 | AC-07, AC-08 |
| | ②使用者或管理員作廢申請 → 操作成功 → 記錄作廢原因、操作者及時間 | AC-07, AC-08（PHASE-009 移交①②④） |
| | ③管理員修改補助參數 → 新版本建立成功 → 記錄修改者及重要設定摘要 | AC-07 |
| | ④管理員建立或修改使用者車輛油耗資料 → 記錄修改者、資料對象使用者、**異動前後**的油種與油耗摘要及依據備註 | AC-06, AC-07 |
| | ⑤管理員重設密碼 → 記錄事件，但**不得記錄密碼** | AC-09 |
| **AD-US-04**（刪除無歷史紀錄的使用者，:930） | ①使用者沒有任何申請或歷史資料 → 確認永久刪除 → 系統可以刪除帳號 | AC-13 |
| | ②使用者已有草稿、已完成、**已作廢**或報表資料 → 嘗試永久刪除 → **拒絕並提供停用選項** | AC-12, **AC-14**（依 §16 **D5**） |
| | ③管理員執行永久刪除 → 操作完成 → 留下**不含敏感資料**的管理操作紀錄 | AC-13, AC-09 |

> **US 原意保護聲明**：本 Spec **未改變任何 US 之原意**，亦未刪減任何 US 驗收條件。凡本 Spec 判定「US 未涵蓋而現實需要裁量」者（篩選維度／`summary` 揭露形式／FK 守門範圍／技術債納入與否），**一律不由 spec-writer 折衷**，完整列為 §16 之選項與代價交人類裁定。
>
> **來源類別標記（治理 2026-08-03.1）**——本 Spec 之 AC 逐條分類如下：
> - **裁定直接推論／US 逐字**：AC-01, AC-04, AC-06, AC-07, AC-08, AC-09, AC-12, AC-13, AC-15，**＋ AC-16(d)**（`SPEC-REV-010-LITE-3` 新增之子項——人類 leonchih 2026-08-09 SF-1 裁定「改用使用者下拉」之逐字落地；其母條 AC-16 仍屬「建議新增」），**＋ AC-06(b-0)（兩者皆為物件之半邊）／(b-1)／AC-02(e) 台北日界／AC-18(d)**（`SPEC-REV-010-GATE` 新增之子項——人類 leonchih 2026-08-09 Mock Gate MG-1／MG-2 兩項裁定之逐字落地），**＋ AC-18(e)**（`SPEC-REV-010-GATE-2` 新增之子項——人類 leonchih 2026-08-10 Mock Gate 第二輪 MG-3 裁定＋同日消歧裁定之逐字落地；其母條 AC-18 仍屬「既有語意擴張」。**其中「參數型 `targetLabel` 之 `#` 後段一併隱藏」屬延伸判讀**，須於 MG-3 小範圍目視之覆核清單獨立列出，見 §18）
> - **既有語意擴張**（須於 Human Gate 清單獨立列出）：**AC-02**（篩選與分頁——PRD :509「篩選」之具體化）、**AC-03**（全序排序——分頁之必要前提，沿 PHASE-004 AC-67 慣例）、**AC-05**（授權矩陣格數——US 僅稱「管理員」）、**AC-14**（FK 守門範圍擴大——US 僅列「申請或歷史資料」）、**AC-18**（呈現安全——US 未提）、**★ AC-06(b-0) 之「一側為 `null`（油耗首版）亦拆子欄」半邊**（`SPEC-REV-010-GATE`：MG-1 裁定逐字僅及「巢狀前後版本」，首版之涵蓋屬語意擴張——**須於 Mock Gate 第二輪前之確認清單獨立列出**；否決時退回嚴格版，見 AC-06(b-0) 之括註）
> - **建議新增**（須於 Human Gate 清單獨立列出）：**AC-10**（站點白名單掃描）、**AC-11**（稽核不可變性守門）、**AC-16／AC-17**（前端篩選 UI 與五態）、**AC-19**（E2E）、**AC-20**（零弱化基準線）、**AC-21**（error-handler 兜底，依 D6）、**AC-22**（技術債收斂，依 D7）

### 0.3 跨 Phase 追蹤義務核銷表（Packet 四項 ＋ spec-writer 實查追加六項，逐項核銷）

| # | 來源條目 | 本 Spec 處置 | 落點 |
|---|---|---|---|
| 1 | **KNOWN_ISSUES §5 PHASE-010 五項**（`APPLICATION_VOIDED` 納入檢視頁／前後摘要對作廢事件之呈現／AD-US-04 回歸此時已有 VOIDED 資料／代操作稽核完整性回歸／D-2·D-3·D-5·D-6·D-7 收斂） | ①②→AC-04／AC-06／AC-07（`APPLICATION_VOIDED` 之 `summary` 四鍵含 `reason`／`voidedAt`，逐鍵有呈現落點）③→AC-12（`VOIDED` 為五類歷史之一，逐類真實資料）④→AC-08（作廢＋修正版兩類代操作）⑤→**§16 D7**（分流裁定，非全數納入） | AC-04, AC-06, AC-07, AC-08, AC-12, **D7** |
| 2 | **D-1 error-handler 兜底洩漏面**（PHASE-009 終審 R-3 裁定，新 AC 候選） | **列為決策點 ＋ 條件 AC**：§16 **D6**；AC-21 四段由 spec-writer 依摘要重建（**草案本文 repo 內查無留存**，見卷首資訊缺口 #1） | **D6**, AC-21, T9 |
| 3 | **D15 稽核 enum 收斂議題再議**（PHASE-008 D15／PHASE-009 D10 之續議） | **本 Phase 結論性處理**：§16 **D8**——實查 AD-US-14① 之七類事件對現行 10 個 enum 值之對照表**零缺漏**（見 §6.2），故推薦 **(a) 維持 10 值、零新增**；連帶本 Phase **零 migration** | **D8**, §6.2, §8 |
| 4 | **KNOWN_ISSUES §4 R-4／R-5 記載型更正**（`report-service.ts` 檔頭／`applications/routes.ts` 註解；觸檔時順手） | **納入條件 chore（D7）之順手義務**：本 Phase 若 T10 成立則同批更正；**若 D7 裁定不納入 chore，則兩項明列不納並續留 KNOWN_ISSUES §4**（不得靜默消失） | AC-22(c), **D7**, §17.2 |
| 5 | 〔實查追加〕**PHASE-009 T4 即審 FW-E**（`PROJECT_STATE.md` :48）：稽核檢視頁 **XSS escape ＋ 授權不低於申請** | **納入 AC**：AC-18(a)（escape）、AC-05（授權矩陣——管理員 only，**嚴於**申請端點之「擁有人或管理員」） | AC-05, AC-18 |
| 6 | 〔實查追加〕**PHASE-009 T7 即審 FW**（:59）：稽核頁須**相容兩種 `ON_BEHALF` summary 形狀**（一般代建立 vs 修正版之 `revisionOf`） | **納入 AC**：AC-06(c)（同一 `action` 下之異形 `summary` 皆須可呈現，不得因缺鍵而崩） | AC-06, AC-08 |
| 7 | 〔實查追加〕**PHASE-007 T11 即審 FW**（:293）：**`summary.applicationYear` 同鍵異型**（`*_CREATED_ON_BEHALF` 為純量／`*_UPDATED_ON_BEHALF` 為 `{before, after}`，三型同慣例）——**須依 action 分支渲染否則 `[object Object]`**；併記 `targetId` 可為 admin、`targetLabel` 恆 `loginName#id` | **納入 AC 並升為本 Phase 之核心設計問題**：§16 **D3** 三選項；AC-06 之扁平化契約；AC-18(b) 之 `[object Object]` 負向守門（**前端呈現側自帶，不倚賴後端**——沿 PHASE-009 T15c FW） | **D3**, AC-06, AC-18 |
| 8 | 〔實查追加〕**PHASE-007 G3 輕量複審 FW**（:246）：格式器共用 util ＋ travel／maintenance 代建立摘要覆蓋面 → 「PHASE-010 稽核統一議題」 | **部分納入**：格式化在地化統一由 §16 **D9** 裁定（沿 `report-labels.ts` 之 `formatTaipeiDateTime` 單一來源）；travel／maintenance 代建立摘要之覆蓋面併入 AC-07 之七類齊備回歸 | **D9**, AC-07 |
| 9 | 〔實查追加〕**PHASE-009 T9 即審 FW-3**（:68）：PHASE-010 新增**任何金額彙總**必須複用 `COMPLETED` 字面過濾 ＋ 同型結構斷言，否則 D8(a) 開新缺口 | **明文不觸發**：本 Phase **零金額彙總**（稽核檢視為事件列表，不聚合任何金額或里程）。列為 §11.0 測試紀律之禁令：**任何 Task 不得於本 Phase 引入 `aggregate`／`groupBy`／`_sum`**；違反即須回 Spec | §11.0, §17.1 #4 |
| 10 | 〔實查追加〕**PHASE-009 T10 即審 FW（低度）**（:70）：**`userHasHistory` 不查 `AuditLog` 之同型缺口**記錄 | **升格為本 Phase 之 High 決策點**——spec-writer 實查 migration 確認**六條 `ON DELETE RESTRICT` 指向 `User`，其中三條無守門**（見 §5 B-14~B-16、§16 **D5**）；不再只是「記錄」 | **D5**, AC-14, T5 |

### 0.4 上游 Gate 裁定之搭配條件回查（治理 2026-08-09.1 §11 強制）

下表逐筆回查**與本 Phase 範圍交集**之上游裁定，確認其搭配條件／但書在本 Phase 是否有落地義務。**本 Phase 自身之人類裁定**（Spec Gate 2026-08-09 之 D1~D12 十二條，見 §18；期中複審 #2 之 SF-1／SF-3 兩條，2026-08-09）**併入表末逐筆回查**。

| 上游裁定 | 搭配條件／但書 | 本 Phase 之義務 | 落點 |
|---|---|---|---|
| **PHASE-009 D10(a)**（新增 `APPLICATION_VOIDED`） | 「PHASE-010 稽核頁多一類」（§16 D10 影響欄逐字） | **有**——AC-04／AC-06／AC-07 須明列該值，且 `summary` 四鍵（`applicationId`／`type`／`reason`／`voidedAt`）逐鍵有呈現落點 | AC-04, AC-06, AC-07 |
| **PHASE-009 D2(a)**（`VOIDED` 算「已被引用」） | PHASE-009 T8 即審 **AR-4**：「函式語意已結案，**使用者可達之覆寫操作尚不存在**，實際保存效果待 PHASE-010/011 覆寫端點落地時兌現（該端點落地時必須呼叫本守門）」 | **無**——本 Phase **不新增任何參數覆寫端點**（§1.2 非目標）。明列為「本 Phase 不兌現」，義務續留 PHASE-011 | §1.2, §17.2 |
| **PHASE-009 D15(a)**（修正版不自動作廢 ＋ **前端強提示**） | 前提「前端強提示」曾於 T16 M-1 漏落 AC（本專案最重 finding） | **無**——本 Phase 不觸及該面；但列為 §11.0 之零弱化義務：**既有重複計入提醒文案之測試不得被本 Phase 之前端改動弱化** | §11.0, AC-20 |
| **PHASE-005a T1 即審 AR**（`PROJECT_STATE.md` :393） | 「油耗版本使使用者**永久不可刪**（D8(a) 設計後果，**PHASE-010 文件記載**）」 | **有**——明文記載於已知限制，並納入 AC-12 之五類歷史逐一回歸（含油耗版本一類） | AC-12, §17.1 #1 |
| **PHASE-008 T12~T13 即審 SF-2**（時間呈現一致性 Mock Gate 裁定項） | ISO8601 與 `toLocaleString("zh-TW")` 並排不一致之教訓 | **有**——§16 **D9** 明文裁定本頁時間呈現形式，避免同型再犯 | **D9**, AC-18(c) |
| **本 Phase・期中複審 #2 SF-1 裁定**（人類 leonchih 2026-08-09，AskUserQuestion）＝「**改用使用者下拉**」 | 三項搭配條件逐字：①顯示名稱為選項文字、②**內部帶 id** 為送出值、③**複用既有使用者清單 API** | **有**——三項**逐字入 AC**（治理 §11；原 (a) 之「篩選控制項對應 AC-02 之維度」與下拉相容但**不蘊含**下拉，僅加註不足以承載） | **AC-16(d)**（新）, §16 D2(b) 註, §15 T7／**T7R** |
| **本 Phase・期中複審 #2 SF-3 裁定**（人類 leonchih 2026-08-09，AskUserQuestion）＝「**沿用瀏覽器時區**」 | 但書逐字：①與前端既有 8 處一致、**零程式變更**、②規格字面修正、③**記載已知限制**（國外登入時顯示當地時間） | **有**——①②入 AC-18(c) 字面；③入已知限制；列印版／PDF 之固定 +8h **不變**（裁定射程僅及前端） | **AC-18(c)**（改字面）, §16 D9(a) 註, **§17.1 #10**（新） |
| **本 Phase・Mock Gate 第一輪 MG-1 裁定**（人類 leonchih 2026-08-09，AskUserQuestion）＝「**智能攤平＋值中文化**」 | 三項搭配條件逐字：①後端 `{from,to}` **拆進改前／改後兩欄**、②**油耗巢狀前後版本逐子欄拆列**（「油種：改前 92 無鉛→改後 95 無鉛」）、③前端**值中文化**（差旅/保養/折舊、油種名、是/否、日期在地化） | **有**——三項**逐字入 AC**（治理 §11）：①②入 **AC-06(b-1)／(b-0)**（連動 (c)(d) 案例與鍵守恆基準重述、B-12／B-26~B-28），③入 **AC-18(d)**（連動 `FIELD_LABELS` 32 鍵）。**不得**僅記於 §16 D3 之影響欄——該落法即 PHASE-009 T16 M-1 之同型缺口 | **AC-06(b)(c)(d)**, **AC-18(d)**（新）, B-12／B-26／B-27／B-28, §15 **T-MG1-BE1／T-MG1-FE** |
| **本 Phase・Mock Gate 第一輪 MG-2 裁定**（人類 leonchih 2026-08-09，AskUserQuestion）＝「**以台灣日曆日為準**」 | 三項搭配條件逐字：①「篩 8/7~8/8 就是台灣時間的 8/7 00:00~8/8 23:59」、②**與畫面顯示一致**、③後端**日界平移八小時**；併記已知限制「國外瀏覽器登入時篩選仍以台灣日為準」 | **有**——①③入 **AC-02(e)** 字面（含兩端點之逐字 UTC 換算與固定 +8h）；②入 AC-02(e) 之台灣時區一致性條款；已知限制入 **§17.1 #11**；B-07 改台北日界、新增 B-29 雙向釘死 | **AC-02(e)**, B-07／B-29, **§17.1 #11**（新）, §15 **T-MG1-BE2** |
| **本 Phase・Mock Gate 第二輪 MG-3 裁定**（人類 leonchih 2026-08-10；走查中先詢問 `帳號#編號` 語意，釋義後裁定）＝「**內部申請編號（cuid）對人類無意義，畫面不顯示、資料庫可查即可**」 | **同日消歧裁定＝「兩處都拿掉」**，兩項搭配條件逐字：①列標題「受影響資料」之 `帳號#編號` **只留帳號（含顯示名稱）**、②明細表內**純內部編號列（申請編號／修正自）不顯示**；併記射程限定逐字：**顯示層變更——DB 與 API wire 完整保留**（追查用） | **有**——兩項**逐字入 AC**（治理 2026-08-09.1 §11）：兩處呈現面合併入 **AC-18(e)**（新子項）；wire 面之零變更以 AC-04(c)／AC-06／AC-09 之明文「零變更」承載。**不得**僅記於 §16 D 項或本表——該落法即 PHASE-009 T16 M-1 之同型缺口 | **AC-18(e)**（新）, AC-04(c)／AC-08(c)／AC-15(c) 註, B-30／B-31, **§17.1 #12**（新）, §15 **T-MG3-FE** |

---

## 1. 目標與非目標

### 1.1 目標

1. **管理員稽核檢視端點與頁面**：以單一唯讀端點 `GET /admin/audit-logs`（依 **D1**）提供分頁、篩選（依 **D2**）之稽核事件列表，每列含**操作者／操作時間／操作類型／受影響資料**（AD-US-14②）與**重要欄位前後摘要**（AD-US-14③，依 **D3**）。
2. **稽核完整性之真實回歸**：以**真實端點**（非直接 DB 寫入）逐一驗證 AD-US-14① 所列七類事件皆確實產生稽核列，且欄位齊備；含 PHASE-009 移交之**作廢**與**修正版代操作**兩類。
3. **密碼與敏感資料不入稽核之全表回歸**（AD-US-14④／BE-US-31⑤）。
4. **AD-US-04「有歷史拒刪」之完整回歸**：此時 `DRAFT`／`COMPLETED`／`VOIDED`／報表／油耗版本五類歷史皆為真實可構造之資料。
5. **結構性防腐**：稽核寫入站點白名單掃描（AC-10）與稽核不可變性守門（AC-11），使「新增寫入路徑而漏稽核」「新增 enum 值而檢視頁無支援」「意外對 `AuditLog` 下 UPDATE／DELETE」三類迴歸在測試層必紅。
6. Phase 結束後，人類可在稽核頁查得各類重要操作紀錄與前後摘要（PRD :505 末句之驗收）。

### 1.2 非目標（Out of Scope）

1. **不重寫稽核「寫入」邏輯**（PRD :506 明文）。spec-writer 實查結論：US 明列之七類事件**零缺漏**，本 Spec **不提出任何回補 Task**；實查另揭露之一項不對稱（帳號類五事件之 fire-and-forget 語意）列為 §16 **D11** 交人類裁定，**不由 spec-writer 定案**。
2. **不新增任何參數／油耗版本之覆寫或刪除端點**——PHASE-009 D2(a) 之實際保存效果因而仍不兌現（義務續留 PHASE-011）。
3. **不新增稽核事件之匯出／下載／報表功能**（US 未要求）。
4. **不提供一般使用者可見之稽核視圖**（依 **D4** 推薦 (a)；US 之兩條稽核 US 皆為管理員／系統視角）。
5. **不做稽核資料之保留期限、封存或清理**——歸 PHASE-011（備份／清理）。
6. **不做效能目標之實測**（列表 2 s 等）——歸 PHASE-011（PRD :523 起）。
7. **PHASE-011 範圍一律不納**：備份／還原、孤兒清理、部署硬化、附件暫存清理。

---

## 2. 可測試 Acceptance Criteria

> 標記 **【條件 AC】** 者，於 Spec Gate 裁定前狀態為 `PENDING（Spec Gate 裁定後解鎖）`，相關 Task 不得開工。

### A. 稽核查詢端點與契約（BE）

**AC-01 — 端點與回應形狀**
(a) 存在唯讀端點 `GET /admin/audit-logs`（路徑與落點依 **D1**），成功回 `200`。
(b) 回應 body 為封閉**四鍵** `{ items: AuditLogListItemDto[], total: number, page: number, pageSize: number }`——鍵集以 `toEqual` 封閉斷言，**多一鍵必紅**。（`SPEC-REV-010-LITE` 勘誤：原文字面作「三鍵」與同句列舉之四鍵及 §7.2 `AuditLogListResponse` 四欄不一致；此為字面計數勘誤，行為語意零變更。）
(c) 零結果時回 `200` ＋ `items: []` ＋ `total: 0`（**非** 404）。
(d) 端點**零寫入**：呼叫前後 `AuditLog`／`User`／`Application` 三表之列數與內容逐欄不變（查詢端點不得產生自身之稽核列）。

**AC-02 — 篩選與分頁解析【既有語意擴張】**
(a) 支援 query 參數（維度集合依 **D2**）：`action`／`actorId`／`targetId`／`dateFrom`／`dateTo`／`page`／`pageSize`。
(b) `page` 預設 `1`；非正整數或 `< 1` → `400 VALIDATION_ERROR` ＋ `fields[{field:"page"}]`，**零查詢**。
(c) `pageSize` 預設 `20`、上限 `100`（**超過即 clamp 不報錯**）；`<= 0` 或非正整數 → `400` ＋ `fields[{field:"pageSize"}]`。**逐字沿 PHASE-004 `application-query.ts` :56／:255-285 之既有語意**（實查：`PAGE_SIZE_DEFAULT=20`／`PAGE_SIZE_MAX=100`）。
(d) `action` 非 `AuditAction` 之合法值 → `400` ＋ `fields[{field:"action"}]`（**不得**靜默忽略而回全集）。
(e) **【依 2026-08-09 Mock Gate MG-2 裁定「以台灣日曆日為準」修訂；裁定直接推論】** `dateFrom > dateTo` → `400` ＋ `fields[]`；區間**起訖日均含當日**（`CLAUDE.md` 工程規則），且此處之「**日**」逐字為**台灣（UTC+8）日曆日**——**篩 `dateFrom`~`dateTo` 即台灣時間 `dateFrom 00:00:00` 至 `dateTo 23:59:59`（裁定逐字：「與畫面顯示一致」）**。解析輸出之半開區間 `[createdAtFrom, createdAtToExclusive)` 因而為：
　　· `createdAtFrom` ＝ `dateFrom` 之台北時 `00:00:00.000` ＝ **前一日 `16:00:00.000Z`**（例：`dateFrom=2026-08-07` → `2026-08-06T16:00:00.000Z`）
　　· `createdAtToExclusive` ＝ `dateTo` **次日**之台北時 `00:00:00.000` ＝ **`dateTo` 當日 `16:00:00.000Z`**（例：`dateTo=2026-08-08` → `2026-08-08T16:00:00.000Z`）
　　偏移量為**固定 ＋8 小時**（台灣自 1979 年起無日光節約時間，故**不需時區資料庫、零新增 npm 依賴**——N-6）。欄位名與半開區間之用法**零變更**：呼叫端仍為 `gte: createdAtFrom` ＋ `lt: createdAtToExclusive`，故 `buildAuditLogWhere` **零程式變更**（僅兩個 `Date` 之值改變）。**以 UTC 日界實作之 mutant 必紅**（B-29）。
　　與 **AC-18(c)（瀏覽器時區顯示）之關係**：台灣時區之瀏覽器，篩選日與畫面顯示日**恆一致**（裁定之直接目的）；非台灣時區之瀏覽器，顯示為當地時間而篩選仍以台灣日為準，**此不一致為裁定當日明示接受之已知限制**（§17.1 #11），**非缺陷、不得於實作期自行「修正」為瀏覽器時區日界**。
(f) 解析為**純函式**（不碰 DB、不碰 Prisma 型別），可單獨單元測試。

**AC-03 — 全序排序與跨頁不重不漏【既有語意擴張】**
(a) 排序恆為 `createdAt DESC, id DESC`（**兩層全序**；`id` 為 cuid 主鍵，保證最終全序）。
(b) 構造 **≥ 3 筆 `createdAt` 完全相同**之稽核列，以 `pageSize=2` 跨頁取得全部列，斷言**聯集恰等於全集且零重複**——移除 `id` 這一層排序鍵之 mutant **必紅**。
(c) 分頁與計數皆於 DB 層完成（`skip`／`take` ＋ 獨立 `count`），不將命中集合整份讀入記憶體——以原始碼結構斷言守門（沿 PHASE-004 AC-91 先例）。

**AC-04 — 列投影（AD-US-14② 之四要素）**
(a) `AuditLogListItemDto` 鍵集封閉，恰含：`id`／`action`／`createdAt`／`actorDisplayName`／`targetLabel`／`targetDisplayName`／`changes`（依 **D3**）。**多一鍵必紅**。
(b) **操作者**＝`actorDisplayName`（取自 `AuditLog.actor.displayName`）；**不得**輸出 `actorId`／`targetId` 等內部識別值（沿 PHASE-009 §6.3「內部識別值不外露」既有紀律）。
(c) **受影響資料**＝`targetLabel`（DB 既有欄，恆為快照字串；實查形狀有三種：`loginName`／`loginName#applicationId`／`FUEL_PRICE#id` 等參數型），必要時併 `targetDisplayName`（`target` 關聯之顯示名，**目標使用者已被刪除時為 `null`**——`AuditLog.targetId` 之 FK 為 `ON DELETE SET NULL`，實查 `20260801101310_phase2_auth/migration.sql` :83）。
　　**wire 值零變更**（2026-08-10 MG-3 裁定射程限定逐字：「DB 與 API wire 完整保留」）：本欄一律輸出 `targetLabel` 之**完整快照字串**（含 `#` 後段之內部識別碼），供追查使用；**前端之呈現形式**依 **AC-18(e)** 只取 `#` 前段，兩者為不同層次，**不得**以「畫面不顯示」為由縮減本欄之 wire 值（縮減即違反 AC-04(a) 之鍵集封閉與本條之快照語意）。
(d) **十個 `AuditAction` 值逐一**皆有一條真實列可被本端點取回並通過 (a)~(c)——含 `APPLICATION_VOIDED`（PHASE-009 移交①）。
(e) `createdAt` 以 **ISO 8601 UTC 字串**輸出（依 **D9**）。

**AC-05 — 授權矩陣（1 端點 × 5 身分 ＝ 5 格，格數明列）【既有語意擴張】**
(a) 五格逐格如 §6.1 表；**管理員 only**——一般使用者（含資料擁有人本人）一律 `403 FORBIDDEN`，此為**嚴於**申請端點之授權（PHASE-009 T4 FW-E 逐字要求「授權不低於申請」）。
(b) 判定順序：`401` → `403 PASSWORD_CHANGE_REQUIRED` → `403 FORBIDDEN` → 參數驗證 `400`——**授權一律早於任何查詢與參數驗證**；以側信道測試證明「非管理員送出畸形 `page` 參數」得 `403` 而**非** `400`。
(c) `403` 回應**零業務值**（不含任何稽核內容、不含 `total`）。

### B. 前後摘要（AD-US-14③、BE-US-31④）

**AC-06 — `changes[]` 之扁平化契約【依 §16 D3；(b)(c)(d) 依 2026-08-09 Mock Gate MG-1 裁定「智能攤平」修訂】**
(a) 每列輸出 `changes: Array<{ field: string; before: string | null; after: string | null }>`，由 `AuditLog.summary`（`Json?`）經**單一純函式**扁平化而得。
(b) **形狀分派**（自上而下：先 `summary` 級預檢 (b-0)，再逐頂層鍵分派 (b-1)/(b-2)）：

　　**(b-0) `summary` 級預檢——巢狀前後版本之逐子欄拆列**【MG-1 裁定：「油耗巢狀前後版本逐子欄拆列（油種：改前 92 無鉛→改後 95 無鉛）」】：`summary` 為物件且**同時含 `before` 與 `after` 兩個頂層鍵**，且兩者之值**至少一為物件**、另一為物件或 `null` 者 → 該兩個頂層鍵**不各自成列**，改以兩物件之**子鍵聯集**逐子鍵拆列：每一子鍵恰一列
　　　　`{ field: <子鍵>, before: <before[子鍵] 之字串化；該側為 null 或無此子鍵時為 null>, after: <after[子鍵] 之字串化；同上> }`。
　　子鍵順序＝`before` 物件之鍵序，再接 `after` 中未出現於 `before` 者（`before` 為 `null` 時即 `after` 之鍵序）；子鍵列插入於 `before` 頂層鍵之原位置。**其餘頂層鍵**（如 `basisNote`）照 (b-1)/(b-2) 各自一列，位置沿其原插入序。
　　〔**來源標記**：「兩者皆為物件」之情形為**裁定直接推論**；「**一側為 `null`**（油耗**首版**，實查 `fuel-consumption-routes.ts` :230-235 之 `before = beforeRow ? {...} : null`）」之涵蓋為**既有語意擴張**，須於 Human Gate 確認清單**獨立列出**（治理 2026-08-03.1）。擴張理由：首版為同一事件、同一 `summary` 形狀之實例，若不涵蓋則裁定所欲消除之「JSON 整包塞入改後欄」缺陷於首版仍原封存在（該形已在測試 fixture 中，`audit-summary-flatten.test.ts` :161-168／:500-501）。**若人類否決此擴張，退回「兩者皆為物件才拆」之嚴格版**，本 AC 其餘條文不變。〕

　　**(b-1) 逐頂層鍵之兩鍵物件分派**：值為物件且**恰含 `before`／`after` 兩鍵** → 拆為該兩欄；值為物件且**恰含 `from`／`to` 兩鍵** → 拆為 `before: from 之字串化`／`after: to 之字串化`（**與 `{before,after}` 同等待遇**；MG-1 裁定逐字：「`{from,to}` 拆進改前／改後兩欄」——實查唯一來源為 `USER_DEACTIVATED`／`USER_ACTIVATED` 之 `isActive: {from,to}`，`admin/routes.ts` :324／:360）。鍵序不拘；「**恰兩鍵**」為字面條件（三鍵之 `{before,after,extra}` 或一鍵皆**不**走此分支，改走 (b-2)，以免憑空捏造或吞掉資訊）。

　　**(b-2) 其餘一切值** → `before: null` ＋ `after: 值之字串化`（純量 `string`／`number`／`boolean`／`null`、陣列、任意其他物件形狀）。

　　**(b-3)** `summary` 為 `null`／非物件／`{}` → `changes: []`。

　　**揭露面註記**：(b-0)(b-1) 之拆欄**不擴大揭露面**——輸出內容仍恰為同一 `summary` 之既有值，僅呈現形式改變（原以 `JSON.stringify` 整包呈現者改為逐子欄呈現）；AC-09(b) 之 wire 面掃描依舊涵蓋全部 `changes`，**不因拆欄而放寬**。
(c) **同一 `action` 之異形 `summary` 皆須成立**（跨 Phase 追蹤 #6／#7；**案例依 MG-1 修訂後之期望輸出重寫**）：
　　· `APPLICATION_CREATED_ON_BEHALF` 之兩形——一般代建立（`{applicationId, type, tripDate, purpose}` 等純量）與**修正版**（`{applicationId, type, revisionOf}`）：**走 (b-2)**，逐頂層鍵一列（**本次修訂零影響**）；
　　· `APPLICATION_UPDATED_ON_BEHALF` 之逐欄 `{before, after}` 形（`tripDate: {before, after}` 等）：**走 (b-1)**（**本次修訂零影響**——`summary` 頂層雖有多個兩鍵物件，但頂層**不含** `before`／`after` 鍵，故不觸發 (b-0)）；
　　· `USER_FUEL_CONSUMPTION_VERSION_CREATED` 之**巢狀混合形**（實查 `fuel-consumption-routes.ts` :251-259：`{ before: {...} | null, after: {...}, basisNote }`）：**走 (b-0)** → 期望輸出恰為 **4 列**——`fuelType`／`kmPerLiter`／`effectiveFrom`（三個子鍵，各自 `before`→`after` 兩欄對照）＋ `basisNote`（純量一列）；**首版**（`before` 為 `null`）時同為 4 列，三個子鍵列之 `before` 皆為 `null`；
　　· `USER_DEACTIVATED`／`USER_ACTIVATED` 之 `{isActive: {from, to}}`：**走 (b-1)** → 一列 `{field:"isActive", before:"true", after:"false"}`（**本次修訂之新行為**，修訂前為 `{before:null, after:'{"from":true,"to":false}'}`）。
(d) **鍵守恆（子欄拆列後之封閉基準）**：輸出之 `field` 集合**恰等於**
　　　　`( summary 頂層鍵集合 − { 觸發 (b-0) 之 before／after 兩鍵 } ) ∪ ( 該兩物件之子鍵聯集 )`
　　——以 `toEqual` 之**集合相等**（非僅 `⊆`）封閉斷言守門：**刪任一頂層鍵之 mutant 必紅**，且**刪任一子鍵之 mutant 亦必紅**（子欄拆列所新增之守門面，設計目的即防「聯集取成交集」「只取 `after` 側子鍵」「漏 `before` 獨有子鍵」三類漏鍵實作）。未觸發 (b-0) 時本式退化為「`field` 集合恰等於頂層鍵集合」，與修訂前語意相容。
(e) 純函式：零 DB、零時鐘、零 I/O；同輸入恆同輸出（`toEqual` 可比）。
(f) **值之字串化不得產生 `"[object Object]"`**——(c) 之巢狀混合形為此不變式之最高密度案例；產生該字面即為失敗（正向斷言 ＋ 全 `changes` 之 `not.toContain("[object Object]")` 負向掃描並存）。

### C. 稽核完整性回歸（BE-US-31／AD-US-14①）

**AC-07 — 七類事件端到端齊備回歸**
(a) 以**真實 HTTP 端點**（非 `prisma.auditLog.create` 直寫）逐一觸發 AD-US-14① 之七類事件，每類至少一條，斷言恰產生對應 `action` 之稽核列且 `actorId`／`targetLabel`／`createdAt` 齊備：
　　①新增＝`POST /admin/users` → `USER_CREATED`
　　②停用＝`POST /admin/users/:id/deactivate` → `USER_DEACTIVATED`（併測啟用 → `USER_ACTIVATED`）
　　③密碼重設＝`POST /admin/users/:id/reset-password` → `USER_PASSWORD_RESET`
　　④代操作＝代建立三型草稿 → `APPLICATION_CREATED_ON_BEHALF`；代修改三型草稿 → `APPLICATION_UPDATED_ON_BEHALF`
　　⑤作廢＝`POST /applications/:id/void` → `APPLICATION_VOIDED`（**本人與管理員皆寫**，兩者各一條）
　　⑥參數異動＝三類參數版本建立 → `PARAMETER_VERSION_CREATED`（`summary.parameterType` 三值逐一）
　　⑦油耗資料異動＝`POST /users/:userId/fuel-consumption` → `USER_FUEL_CONSUMPTION_VERSION_CREATED`
(b) 每類事件之稽核列皆可經 `GET /admin/audit-logs` 取回並通過 AC-04。
(c) **負向對照（防恆真）**：本人自建草稿 → **零**新增稽核列（PHASE-004 AC-86 既有刻意行為）；此條為「(a)④ 之計數斷言確實有牙」之證明。

**AC-08 — 代操作稽核之完整性回歸（PHASE-009 移交④）**
(a) **作廢類**：管理員代他人作廢 → 一條 `APPLICATION_VOIDED`，`actorId`＝管理員、`targetId`＝擁有人、`summary` 為封閉四鍵 `{applicationId, type, reason, voidedAt}`；本人作廢 → 同樣寫入（`actorId`＝本人）。
(b) **修正版類**：管理員代他人建修正版 → 一條 `APPLICATION_CREATED_ON_BEHALF`，`summary` 含 `revisionOf`；**本人建修正版 → 零稽核列**（PHASE-009 AC-26(c) 既有）；**管理員對自己之申請建修正版 → 零稽核列**（PHASE-009 T7R 之三向鑑別力封閉，本 Phase 只回歸不改行為）。
(c) 兩類之 `summary` 皆通過 AC-06 之扁平化並在列表中可讀（含**作廢原因**逐字可見——BE-US-31② 之終點）。
　　**射程限定（2026-08-10 MG-3 裁定連動）**：本條之「可讀」對**純內部識別碼欄**（`applicationId`／`revisionOf`）**不再及於畫面**——該兩欄依 **AC-18(e)** 不渲染，其可讀性由 **wire 面**承載（`GET /admin/audit-logs` 之 `changes[]` 仍含該兩列，本條之整合測試落點即在 wire 面，**零斷言弱化**）。**行為後果須知**：修正版代建立之「修正自」關係因而在畫面上不可辨識（`summary` 僅餘 `type` 一列可見）——此為裁定逐字「兩處都拿掉」之直接後果，記於 **§17.1 #12** 並列入 Gate 覆核清單（§18）。

**AC-09 — 密碼與敏感資料不入稽核之全表回歸（AD-US-14④／BE-US-31⑤／AD-US-04③）**
(a) 以既有 `assertNoSensitiveContent` 同型遞迴掃描器（實查在場：`phase4-on-behalf-audit.test.ts` :109、`phase6-on-behalf.test.ts` :110）掃描**全表**之 `targetLabel` 與 `summary`：對測試中使用之明文密碼字串、argon2 雜湊前綴（`$argon2`）、session token 字面**零命中**。
　　**允許集之封閉射程**（`SPEC-REV-010-LITE-2` 明載，依 T3 即審 W-1(iii)）：該掃描器於本 Phase **得帶一個封閉允許集**，其成員**限於「Spec／schema 強制上 wire 之識別字之完整字面」**——現行**恰兩個**：`USER_PASSWORD_RESET`（`AuditAction` enum 值，`schema.prisma` :34，本身即含 `password` 字樣）與 `mustChangePassword`（AC-09(c) 之封閉單鍵鍵名）。允許集之**封閉性由 AC-09(c) 之 `toEqual` 承擔**（該斷言禁止 `summary` 出現除 `mustChangePassword` 以外之任何鍵，故允許集無法被悄悄擴大）。比對**一律為完整字面相等**，**子字串不放行**——`mustChangePasswordExtra`／`temporaryPassword`／`passwordHash` 等皆須命中。允許集新增任何第三個成員即為 Spec 變更，須回 Spec。（§11.6 同步交叉引用。）
(b) 掃描對象**同時涵蓋 wire 面**：`GET /admin/audit-logs` 之完整回應 body 亦零命中（AC-06 之 `changes` 為新的揭露面，須一併掃）。
(c) `USER_PASSWORD_RESET` 之 `summary` 為封閉單鍵 `{mustChangePassword: true}`（實查 `admin/routes.ts` :372-375），**加入任何密碼相關鍵之 mutant 必紅**。
(d) `USER_DELETED` 之稽核列不含敏感資料且 `targetId` 為 `null`、`targetLabel` 為刪除前快照（AD-US-04③）。

**AC-10 — 稽核寫入站點白名單掃描 ＋ enum 對照封閉【建議新增】**
(a) 結構性掃描：`backend/src/**/*.ts` 中所有 `auditLog.create(` 之出現位置，其**檔案集合**恰等於白名單——實查基線（本次 grep）：`admin/routes.ts`（3 處）、`applications/routes.ts`（5 處）、`parameters/routes.ts`（3 處）、`users/fuel-consumption-routes.ts`（1 處）、`audit/audit.ts`（1 處，`writeAudit` 助手，另有 `admin/routes.ts` 之 5 個呼叫端）——**共 5 檔／13 個 create 呼叫**。新增檔案或移除既有檔案皆必紅。
(b) `AuditAction` enum 之值集合恰等於基線 **10 值**（實查 `schema.prisma` :30-41）；新增值必紅，**強制新增者同批更新本 Phase 之檢視頁對照**（AC-04(d)）。
(c) 前端稽核頁之 `action` 標籤對照表**涵蓋全部 10 值**——以「enum 值集合 ⊆ 標籤表鍵集合」之封閉斷言守門，漏一值必紅（防「新增 enum 後檢視頁顯示原始 enum 字面」）。
(d) 併記基線連動實查：`enumLabels("AuditAction")` 之閉集斷言現有 **4 處**（`phase6-migration-safety.test.ts` :711、`phase7-migration-safety.test.ts` :1077／:2194、`phase8-migration-safety.test.ts` :1356）；`phase9-migration-safety.test.ts` 另有 (e) 聯集全等一處。**若 D8 裁定新增 enum 值，此五處為機械連動預授權範圍**。

**AC-11 — 稽核不可變性結構守門【建議新增，依 §16 D12】**
(a) 全 `backend/src` 掃描：`auditLog.update(`／`auditLog.updateMany(`／`auditLog.delete(`／`auditLog.deleteMany(`／`auditLog.upsert(` **零命中**（沿 PHASE-008 `reports/` 零更新守門之既有形狀）。
(b) 插入任一該類呼叫之 mutant 必紅（掃描器鑑別力自證）。
(c) 本 AC **零程式變更**——純測試守門。

### D. AD-US-04 有歷史拒刪回歸

**AC-12 — 五類歷史逐一拒刪 ＋ 提供停用選項**
(a) 對持有下列**任一類真實資料**之使用者送 `DELETE /admin/users/:id` → `409 CONFLICT` ＋ 既有文案「此帳號已有資料，無法刪除，請改用停用」（實查 `admin/routes.ts` :406），且**零刪除**（該使用者列與其資料逐欄不變）：
　　①`DRAFT` 申請　②`COMPLETED` 申請　③**`VOIDED` 申請**（PHASE-009 移交③——本 Phase 首度以真實作廢流程構造）　④已產生正式報表之申請　⑤`UserFuelConsumptionVersion`
(b) 「提供停用選項」以回應文案承載（既有語意，不改）；前端 `AdminUsersPage` 之既有停用入口為其落點——本 AC 不新增使用者可見行為。
(c) `VOIDED` 一類須以**真實作廢端點**構造（非 raw SQL 直寫 `status`），沿 PHASE-009 AC-16／AC-17 之既有紀律。

**AC-13 — 無歷史可刪 ＋ 刪除稽核**
(a) 對**完全無**上述五類資料之使用者 → `200 { ok: true }`，該使用者列確實消失。
(b) 同時產生恰一條 `USER_DELETED` 稽核列，`targetId` 為 `null`、`targetLabel` 為刪除前 `loginName` 快照（AD-US-04③）。
(c) 該列可經 `GET /admin/audit-logs` 取回，`targetDisplayName` 為 `null`（目標已不存在）——AC-04(c) 之邊界落點。

**AC-14 — FK `ON DELETE RESTRICT` 之守門完整性【依 §16 D5；既有語意擴張】**
> **實查依據**（`grep 'REFERENCES "User"' backend/prisma/migrations/*/migration.sql`）：指向 `User` 之 FK 共 **8 條**，其中 `ON DELETE RESTRICT` **6 條**：`AuditLog.actorId`／`Attachment.uploaderId`／`Attachment.ownerId`／`Application.ownerId`／`Application.createdById`／`UserFuelConsumptionVersion.userId`（另 `Session.userId` 為 `CASCADE`、`AuditLog.targetId` 為 `SET NULL`）。現行 `userHasHistory`（`backend/src/users/history.ts` :80-88）**僅查 2 條**（`Application.ownerId`、`UserFuelConsumptionVersion.userId`）→ 其餘 **3 條**（`AuditLog.actorId`、`Attachment.uploaderId`／`ownerId`、`Application.createdById`）於真實觸發時使 `prisma.user.delete` 拋 P2003，落入 `error-handler.ts` 分支 4 → **`500 INTERNAL_ERROR`**，與 AD-US-04② 要求之「拒絕並提供停用選項」不符。

(a) **機械完整性斷言**：以 `information_schema` 列舉「指向 `User` 且 `ON DELETE` 為 `RESTRICT`/`NO ACTION`」之全部 FK，斷言其**引用之「表.欄位」集合**恰等於 `userHasHistory` 所查之**「表.欄位」集合**——新增此類 FK 而未同步守門者必紅，**且同一表新增另一條未守門之 RESTRICT 欄位亦必紅**。**方法論風險見 §11.6**。
　　（`SPEC-REV-010-LITE-2` **升格**，依期中複審 #1 SF-B2：原文之「**表**集合」對「同表新增未守門欄」**零鑑別力**——期中複審 V4 已實證。升格方向為**更嚴**，屬防「合規弱化」之記載對齊；**T5 實作已達此標準**（`(a) 欄位級：RESTRICT／NO ACTION 之「表.欄」集合恰等於守門宣告之「表.欄」集合` 一格在場，見 §12），故**零實作影響**。）
(b) 三條缺口路徑逐一構造真實資料並斷言 `409`（**非 500**）：
　　·**曾執行任一被稽核操作之管理員**（`AuditLog.actorId`）
　　·**上傳過附件但無任何申請之使用者**（`Attachment.uploaderId`／`ownerId`；`TEMP` 態即成立）
　　·**代他人建立過草稿、自己無申請之管理員**（`Application.createdById`）
(c) 修復前之**紅燈物證**（現況實得 500）須記入 Handoff。
(d) 依 **D5** 之裁定落地：(a) 擴充守門／(b) 端點 catch P2003 → 409／(c) 兩者併用／(d) 不修僅記錄。**若裁定 (d)，本 AC 全條移除，並將三條路徑之 500 明列為已知限制**。

### E. 前端稽核檢視頁

**AC-15 — 路由、入口與列表欄位**
(a) 新路由 `/admin/audit-logs`（依 **D10**），`RequireAuth` 保護；非管理員進入時**不渲染任何稽核內容**（後端 403 之 Permission denied 態）。
(b) `HomePage` 管理員區塊新增「稽核紀錄」入口——沿既有 `/admin/users`（`HomePage.tsx` :31-33）與 `/admin/parameters`（:36-38）兩入口之慣例；**一般使用者不渲染該入口**（負向斷言）。
(c) 列表逐列顯示四要素：操作時間／操作者／操作類型（**中文標籤**，依 AC-10(c) 之對照表）／受影響資料（**呈現形式依 AC-18(e)**——只取 `targetLabel` 之 `#` 前段，必要時併 `targetDisplayName`）。

**AC-16 — 篩選與分頁 UI【建議新增】**
(a) 篩選控制項對應 AC-02 之維度（依 **D2**）；變更任一篩選即重置 `page` 為 1。
(b) 分頁控制：上一頁／下一頁與「第 N 頁／共 M 筆」；首頁時「上一頁」停用、末頁時「下一頁」停用。
(c) 篩選與分頁一律**經 query 參數送後端**——前端**不得**取回全集後自行過濾或分頁（以「請求 URL 含該參數」之斷言守門）。
(d) **`actorId`／`targetId` 兩篩選欄為使用者下拉選單**【**裁定直接推論**——人類 leonchih 2026-08-09 SF-1 裁定逐字：「改用使用者下拉」】：以**顯示名稱**為選項文字、**內部帶使用者 id** 為送出值；清單**複用既有使用者清單 API**（`apiGetUsers`，`frontend/src/api/users.ts` :3），不另立端點。**不得**以純文字 id 輸入實作——回應依 §6.3／AC-04(b) **不外露** `actorId`／`targetId`，使用者無從得知可輸入之值（SF-1 之成因）。〔本子項為**裁定內容入 AC** 之落點，治理 2026-08-09.1 §11 強制；(a) 之現行字面「篩選控制項對應 AC-02 之維度」與下拉相容但**不蘊含**下拉，故不足以承載本裁定〕

**AC-17 — 五態【建議新增】**
依 §4 表逐格：Loading／Empty／Error／Success／Permission denied 各至少一條斷言；**Empty 與 Permission denied 不得共用同一段文案**（防兩態混淆）。

**AC-18 — 呈現安全【既有語意擴張】**
(a) **跳脫**：`targetLabel` 與 `changes[].before`／`after` 皆含使用者自由文字（作廢原因、出差目的、油耗依據備註），一律經 React 之文字節點渲染（**不得** `dangerouslySetInnerHTML`）；以 XSS payload（`<script>`／`"><img onerror=`／`javascript:`）為輸入之正負向各一格，並以「全頁 DOM 無 `<script>` 節點新增」為守門。
(b) **`[object Object]` 負向守門**：以 AC-06(c) 之巢狀混合 `summary`（油耗版本形）為 fixture，斷言渲染結果**不含** `"[object Object]"`。**此守門必須自帶於前端測試**，不得倚賴後端扁平化之測試（沿 PHASE-009 T15c FW「前端呈現側負向守門必自帶」）。
(c) **時間呈現**（依 **D9**）：後端回 ISO 8601 UTC，前端以**使用者瀏覽器時區之在地化（`zh-TW` 格式）**呈現（**人類 leonchih 2026-08-09 SF-3 裁定逐字：「沿用瀏覽器時區」**——與前端既有 8 個時間格式化落點一致、零程式變更；列印版／PDF 之後端固定 +8h 台北時區**維持不變**，二者**格式同型但基準時區不同**，已知限制見 §17.1 #10）；同頁**不得**同時出現 ISO 原字串與在地化字串兩種形式（PHASE-008 SF-2 之同型再犯防護）。
(d) **`changes[].before`／`after` 之值層中文化**【**裁定直接推論**——人類 leonchih 2026-08-09 Mock Gate MG-1 裁定逐字：「前端加值中文化（差旅/保養/折舊、油種名、是/否、日期在地化）」】：
　　· **依欄位限定之枚舉值映射**（**不**做全域字面替換，以免把使用者自由文字如作廢原因誤譯）：`type` → `ApplicationType` 三值／`fuelType` → `FuelType` 全值／`role` → `Role` 兩值／`parameterType` → 參數類型三值；布林字面 `"true"`／`"false"` → 「是」／「否」，**限定於布林欄位**（現行 `isActive`／`mustChangePassword`）。
　　· **值標籤逐字沿既有落點用語**，不另立第二種說法：`ApplicationType` 沿 `ApplicationListSection.tsx` :30-32（`TRAVEL`＝「差旅補助」／`MAINTENANCE`＝「保養分攤」／`DEPRECIATION`＝「折舊補貼」——裁定原文之簡稱「差旅/保養/折舊」為其前綴，採既有全稱以維持跨頁一致）；`FuelType` 沿 `AdminFuelConsumptionPage.tsx` :59-62／`MyFuelConsumptionSection.tsx` :33-36（`GASOLINE_92`＝「92 無鉛汽油」…`DIESEL`＝「柴油」）。
　　· **ISO 日期／時間值在地化**：既有行為（AC-18(c) 之 `formatValue`）**維持不變**，本子項不改其語意。
　　· **未知值原樣顯示不崩**：映射表無對應之值一律逐字原樣呈現（回退慣例與 D3=(c) 之欄名對照表同型）。
　　· **與 (a) 之關係**：映射後之輸出仍為字串並經 React 文字節點渲染，**不引入任何 `dangerouslySetInnerHTML`**——(a) 之跳脫守門與 (b) 之 `[object Object]` 負向守門**逐條不受影響且不得弱化**。
　　· **覆蓋守門（機械可查）**：以「值映射表之鍵集合 ⊇ `summary` 內實際出現之全部枚舉值全集」之封閉常數斷言守門——現行全集 **14 值**（`ApplicationType` 3 ＋ `FuelType` 4 ＋ `Role` 2 ＋ 參數類型 3 ＋ 布林 2），刪表中任一值即紅（沿 T7R 之 `REQUIRED_SUMMARY_FIELDS` 守門形狀）。
　　· **欄名對照表之連動**：(b-0) 子欄拆列後，`kmPerLiter` 首度成為 `changes[].field` 之可能值 → D3=(c) 之 `FIELD_LABELS` 須新增該鍵，且其覆蓋守門常數之**定義同步改為**「`changes[].field` 之可能值全集」＝`summary` 頂層鍵全集 ∪ (b-0) 子鍵聯集＝**現行 32 鍵**（31 ＋ `kmPerLiter`；`before`／`after` 兩鍵**保留**，因其仍可能以非物件形出現而各自成列）。

(e) **內部識別碼不呈現於畫面**【**裁定直接推論**——人類 leonchih 2026-08-10 Mock Gate 第二輪 **MG-3** 裁定逐字：「內部申請編號（cuid）對人類無意義，畫面不顯示、資料庫可查即可」；**同日消歧裁定＝「兩處都拿掉」**：①列標題「受影響資料」之 `帳號#編號` 只留帳號（含顯示名稱）②明細表內純內部編號列（申請編號／修正自）不顯示】：

　　**射程界定（前置聲明，逐條為裁定之「顯示層變更，DB 與 API wire 完整保留」）**：本子項為**純前端呈現層**變更，**`backend/src` 零 diff**。下列各面**逐條零變更**：`AuditLog` 資料表與 `summary` 內容（AC-06 之扁平化契約）／`AuditLogListItemDto` 之 `targetLabel` 與 `changes[]` **wire 值**（AC-04(a)(c)）／AC-09(a)(b) 之 DB 全表與 wire 雙面掃描射程（**掃描對象仍為完整 wire，不因畫面隱藏而縮小**）／AC-16(d) 之使用者下拉——其 `<option value>` 為**送出值**而非畫面文字，**不在本子項射程內**，**不得**以本子項為由改為非 id 送出（該改動將直接違反 AC-16(d) 之裁定落地）。

　　**(e-1) `targetLabel` 之呈現＝第一個 `#` 之前段**：頁面列渲染 `targetLabel` 時，僅呈現其**第一個 `#` 字元之前**的子字串，`#` 及其後全部字元不渲染。**不含 `#` 者原樣全字呈現**（`loginName` 形；`USER_DELETED` 之刪除前快照形；油耗事件之 fallback 形——實查 `users/fuel-consumption-routes.ts` :250 `targetUser?.loginName ?? dto.userId`，該 fallback 可為裸 `userId`，**無 `#` 故不截斷**，見 B-30）。
　　　　· **射程涵蓋參數型 `targetLabel`**（`FUEL_PRICE#<cuid>`／`ETC#<cuid>`／`DEPRECIATION#<cuid>`，實查 `parameters/routes.ts` :210／:284／:374）：其 `#` 後段同為 cuid，即裁定所稱「對人類無意義之內部編號」，依裁定原則**一致處理**，呈現為 `FUEL_PRICE`／`ETC`／`DEPRECIATION`。〔**延伸判讀之來源標記＝裁定直接推論**（裁定字面為「內部申請編號」，但其理由「cuid 對人類無意義、DB 可查即可」對參數型後段**逐字同樣成立**；且若不涵蓋，同一畫面將出現「一半顯示編號、一半不顯示」之不一致）。**惟此為延伸至裁定字面未列之 `action` 類別，須於 Gate 覆核清單獨立列出**（§18）；人類否決時退回「僅 `帳號#編號` 形截斷」之窄版，(e-1) 其餘條文不變。〕
　　　　· **前綴之英文參數類型字面**（`FUEL_PRICE` 等）**不在本次射程內中文化**——MG-3 未及，且該字面於修訂前即以英文呈現（非本次新增之可讀性缺口）；記於 §17.1 #12 供日後另案。
　　　　· **設計選擇之揭露（第一個 `#` vs 最後一個 `#`）**：現行 `loginName` 驗證僅 `minLength: 1`（實查 `admin/routes.ts` :152），**未禁止帳號含 `#`**。取「第一個 `#`」時，含 `#` 之帳號其顯示會被截於首個 `#`（B-30 末列）；取「最後一個 `#`」則反使「純帳號且含 `#`」之列被誤截。兩者皆有邊界代價，本 Spec 取**第一個 `#`**——理由：規則最單純、**零 id 格式耦合**（不引入 cuid 形狀判斷，避免 id 格式變更時靜默失效），且與裁定字面「`帳號#編號` 只留帳號」之直觀讀法一致。合成帳號實務上不含 `#`，wire 完整值亦恆可追查，故代價可接受；**此選擇明列於 §17.1 #12 與 Gate 覆核清單**，人類可於小範圍目視時低成本推翻。

　　**(e-2) 明細表之純內部識別碼列不呈現**：`AuditChangesList` 渲染前先**濾除** `field` 屬「純內部識別碼欄位」封閉集合之列。該集合**現行恰兩個**：`applicationId`／`revisionOf`。**實查依據**（本次對 13 個稽核寫入站點之 `summary` 鍵全集逐一核對）：除該兩鍵外，32 鍵中無任何一鍵之值為內部識別碼——`targetId`／`actorId`／`voidedById`／`ownerId` 等一律**刻意不入 `summary`**（`applications/routes.ts` :1516 註、§6.3）。**過濾一律依欄位名**（**不得**依值形狀或 cuid 樣式猜測），以免誤濾使用者自由文字（同 AC-18(d) 之「依欄位限定」紀律）。

　　**(e-3) 封閉集合之覆蓋守門（機械可查）**：以**獨立硬編**之隱藏欄常數斷言該集合**恰為兩鍵**——刪任一鍵或多一鍵即紅（沿 `REQUIRED_SUMMARY_FIELDS`／14 值守門之既有形狀，不衍生自被測模組之常數）；併斷言**隱藏欄集合 ⊆ `FIELD_LABELS` 鍵集**（32 鍵）。日後若有新的純內部識別碼欄成為 `changes[].field` 之可能值，須**同批**更新本集合與 §2 之實查依據（屬 Spec 變更）。

　　**(e-4) 32 鍵欄名守門之鑑別力不得因隱藏而失效**【**防合規弱化**，AC-18(d) 末段連動】：現行 32 鍵守門之形狀為「將 32 鍵各構成一列渲染 → 斷言畫面上不出現原始英文鍵名」（`AuditChangesList.test.tsx` :232-242）。(e-2) 生效後，被隱藏之兩鍵**根本不渲染**，該斷言對此二鍵將**恆真而失去鑑別力**（＝FE 複審 SF-A「fixture 汰換後負向守門零鑑別力」之同型）。故 32 鍵守門**須就被隱藏欄改以標籤表本身為斷言對象**（逐鍵有非空、且**不等於鍵名**之中文標籤），使「刪 `FIELD_LABELS` 之 `applicationId`／`revisionOf` 任一鍵」之 mutant **仍必紅**。**`FIELD_LABELS` 之 32 鍵定義與計數零變更**——「是否呈現」與「是否有標籤」為**兩件正交之事**，隱藏欄之標籤條目一律保留（供回退顯示、日後解除隱藏、及守門之用），**刪除即為守門弱化**。

　　**(e-5) 全列被濾後之空態**：過濾後 `changes[]` 為空者，走 `AuditChangesList` **既有空態文案**「（無異動明細）」，**不渲染空表頭**；AC-17 之列表層 Empty 態文案**不受影響**（兩者為不同層次）。現行 10 個 `action` 之 `summary` 形狀中**無**全欄皆被濾之案例（最接近者為修正版之 `{applicationId, type, revisionOf}` → 濾後仍餘 `type` 一列），本條為**防禦性條款**（B-31）。

　　**(e-6) 與 (a)(b)(c)(d) 之關係**：截斷與過濾皆為**渲染前**之字串／陣列運算，輸出仍經 React 文字節點呈現，**不引入任何 `dangerouslySetInnerHTML`**——(a) 跳脫／(b) `[object Object]` 負向／(c) 時間在地化／(d) 值中文化**逐條不受影響且不得弱化**；含 `#` 之 XSS payload 經截斷後仍以純文字呈現（B-21 逐字不變）。

　　**(e-7) 顯示名稱之附掛與去重比較**：裁定逐字「只留帳號（**含顯示名稱**）」——`targetDisplayName` 之附掛行為**維持**。惟現行去重比較為 `targetDisplayName !== targetLabel`（`AuditLogPage.tsx` :439-440），**比較之左右兩側須改以裁切後之顯示值為準**，否則 `alice#<cuid>` 之列將呈現「alice（alice）」之重複（截斷後兩值相等卻仍附掛）。

### F. E2E / Gate

**AC-19 — E2E 端到端 ＋ 375px【建議新增】**
(a) `e2e/audit-log.spec.ts`（新）：以管理員登入 → 執行一次真實管理操作（建立帳號）與一次真實作廢 → 進入稽核頁 → 該兩事件可見且四要素正確。
(b) 篩選一次（依 `action`）後列表確實收斂；分頁至第 2 頁後列不重複。
(c) 375px 寬度下列表零水平溢位（沿 PHASE-009 AC-36 慣例）。
(d) 播種冪等（重跑不累積失敗）。

### G. 零弱化與基準線

**AC-20 — 零弱化與基準線【建議新增】**
(a) 起點基準線（PHASE-009 終審實測）：後端 **3230**／前端 **346**／E2E **50**。本 Phase 終值 ≥ 起點且**無任何既有測試被刪除、skip、或斷言弱化**。
(b) 不設獨立 Task——寫入**每個 Task 之 Done When**，由終審以三套件實跑數對照核對。

### H. 【條件 AC，依 §16 D6】error-handler 兜底洩漏面

**AC-21 — 兜底路徑之洩漏面收斂【建議新增；D6 裁定 (a) 時方成立】**
(a) `error-handler.ts` 分支 4（未預期例外）之日誌**不再記錄 `error.message` 原文**，改記固定分類標籤 ＋ `error.name`；`requestId` 仍為關聯手段（現況實查 :169-176 記 `sanitizeForLog(error.message)`）。
(b) **站點白名單掃描**：全 `backend/src` 中「將 `err.message`／`error.message` 直接送入 `log.*` 或回應 `details`」之出現位置，其檔案集合恰等於白名單（今日已知之受控站點）；新增站點必紅。
(c) **反向探針**：注入一個訊息含絕對路徑（如 `C:\...\src\foo.ts`）之未預期例外，斷言 `logStream` 中**零路徑分隔字面命中**；修復前該探針必紅（紅燈物證記入 Handoff）。
(d) **wire 零變更**：`500` 回應之 body 逐位元組不變（`INTERNAL_ERROR` ＋ 固定文案 ＋ `requestId`），既有 `error-handler.test.ts` 零弱化。

### I. 【條件 AC，依 §16 D7】技術債收斂

**AC-22 — 技術債收斂批次【建議新增；依 D7 之分流裁定】**
(a) **D-2**：`applications/routes.ts` 之 `REPORT_GENERATION_FAILED` 500 轉譯由 `buildErrorBody` 繞道改經 `AppError` 承載，**wire 輸出逐位元組不變**（含鍵序）。
(b) **D-3**：`errorLabel` 三份同形實作收斂為單一葉節點模組，三處呼叫端行為零變更。
(c) **R-4／R-5**（記載型更正）：`reports/report-service.ts` 檔頭與 `applications/routes.ts` 之失準註解同批更正——**零斷言影響**。
(d) **D-5／D-6／D-7 明列不納**（理由見 §16 **D7**），續留 `KNOWN_ISSUES.md` §3。

---

## 3. 正常流程

### 3.1 管理員檢視稽核紀錄（AD-US-14②③）

1. 管理員於首頁點「稽核紀錄」→ 前端導向 `/admin/audit-logs`。
2. 前端以預設參數（`page=1`、`pageSize=20`、無篩選）呼叫 `GET /api/admin/audit-logs`，`credentials: "include"`。
3. 後端 preHandler 鏈：`requireAuth` → `requirePasswordChanged` → `requireAdmin`（沿 `admin/routes.ts` :151 之 `adminPreHandlers` 既有形狀）。
4. 解析 query（AC-02 純函式）→ 任一違規即 `400` ＋ `fields[]`，**零查詢**。
5. 建 `where` → `findMany`（`include: { actor: {select:{displayName}}, target: {select:{displayName}} }`、`orderBy: [{createdAt:"desc"},{id:"desc"}]`、`skip`／`take`）＋ 獨立 `count`（`Promise.all`）。
6. 每列投影為 `AuditLogListItemDto`：`summary` 經扁平化純函式 → `changes[]`（AC-06）。
7. 回 `200 { items, total, page, pageSize }`。
8. 前端渲染列表（時間在地化、`action` 中文標籤、`changes` 逐列展開）；`total` 驅動分頁控制。

### 3.2 稽核完整性回歸（測試流程，非使用者流程）

1. 於單一 worker schema 內，以真實 HTTP 端點依序觸發七類事件（AC-07(a) 之七小項）。
2. 每觸發一類即以 `GET /admin/audit-logs?action=<X>` 取回並逐欄斷言。
3. 全部觸發完成後，對全表跑 `assertNoSensitiveContent`（AC-09(a)）與 wire 面掃描（AC-09(b)）。

### 3.3 AD-US-04 拒刪回歸（測試流程）

1. 為五類歷史各建一名獨立使用者並構造該類資料——**構造手段之強制射程逐字依 AC-12(c)**：**`VOIDED` 一類須以真實作廢端點構造**（非 raw SQL 直寫 `status`）；其餘四類之**前置狀態底稿**得沿既有先例以測試工廠／Prisma client 直寫構造（被驗證之行為為 `DELETE /admin/users/:id` 之回應與零刪除，底稿構造手段不在射程內；§11.0 #4 之禁止項亦僅及於 `prisma.auditLog.create`／raw SQL 直寫**被驗證之狀態**）。
　　（`SPEC-REV-010-LITE-2` 措辭對齊，依 T5 即審 AR-5：原文「以**真實端點**構造該類資料」寬於 AC-12(c) 之射程，與 T5 實作（②`COMPLETED`／④已產生正式報表兩類之底稿沿 phase9 先例直寫）字面矛盾。本次以 AC-12(c) 為準對齊流程描述，**AC 語意零變更**。）
2. 逐一 `DELETE /admin/users/:id` → 斷言 `409` ＋ 文案 ＋ 零刪除。
3. 另建一名零資料使用者 → `DELETE` → `200` ＋ `USER_DELETED` 稽核列（AC-13）。
4. 依 **D5** 之裁定，另構造三條 FK 缺口路徑並斷言 `409`（AC-14(b)）。

---

## 4. 五態（Loading / Empty / Error / Success / Permission denied）

| 態 | 稽核列表頁 | 篩選／分頁 |
|---|---|---|
| **Loading** | 顯示「載入中…」，列表區不渲染舊資料之殘影；篩選控制項停用 | 切頁時同左；重複點擊不併發送出（送出中停用） |
| **Empty** | 有結果集但為空 → 顯示「查無稽核紀錄」**且保留篩選控制項**（使用者可放寬條件） | 篩選導致空集合時同左，**文案須與「尚無任何稽核紀錄」可區辨**（依 D2 是否有篩選而定，二者不得同文案） |
| **Error** | `400`（篩選參數違規 → 逐欄提示 `fields[].reason`）／`500`（一般錯誤 ＋ 重試鈕）；**重試不重複送出** | 分頁越界（`page` 大於總頁數）→ `200` ＋ 空 `items`（**非** 400/404） |
| **Success** | 列表渲染 N 列 ＋ 「共 M 筆」；每列四要素 ＋ `changes` | 篩選後 URL query 與請求參數一致 |
| **Permission denied** | 一般使用者 → `403` → 顯示無權限訊息、**零後續請求**（無重試鈕）、零稽核內容 | 同左；`HomePage` 亦不渲染入口（AC-15(b) 負向） |

---

## 5. 邊界條件

| # | 情境 | 期望 |
|---|---|---|
| B-01 | `page` 缺省／`""`／`0`／`-1`／`1.5`／`abc` | 缺省與 `""` → 預設 1；其餘 → `400` ＋ `fields[{field:"page"}]`，零查詢 |
| B-02 | `pageSize` ＝ `0`／`-5`／`abc` | `400` ＋ `fields[{field:"pageSize"}]` |
| B-03 | `pageSize` ＝ `101`／`10000` | **clamp 為 100**（`200`，**不報錯**）——逐字沿 PHASE-004 既有語意 |
| B-04 | `page` 大於總頁數 | `200` ＋ `items: []` ＋ 正確之 `total`（非 404） |
| B-05 | `action` ＝ `"BOGUS_ACTION"` | `400` ＋ `fields[{field:"action"}]`（**不得**靜默回全集） |
| B-06 | `action` ＝ 合法值但零命中 | `200` ＋ `items: []` ＋ `total: 0` |
| B-07 | `dateFrom` ＝ `dateTo` ＝ 同一日（**MG-2 修訂：台北日**） | **該台北日**之列全數命中（起訖含當日）——即 `[前一日 16:00:00.000Z, 當日 16:00:00.000Z)`；該台北日之首毫秒（`前一日 16:00:00.000Z`）與末毫秒（`當日 15:59:59.999Z`）皆**必命中**，其外兩側各一毫秒**必不命中** |
| B-08 | `dateFrom` > `dateTo` | `400` ＋ `fields[]` |
| B-09 | `actorId`／`targetId` 為不存在之 id | `200` ＋ 空集合（**非** 404；不洩漏使用者存在性） |
| B-10 | 三筆稽核列 `createdAt` 完全相同，`pageSize=2` 跨頁取 | 聯集恰等於全集、零重複（AC-03(b)） |
| B-11 | `summary` 為 `null`（實查：`writeAudit` 之 `detail` 為 optional）／`{}`／非物件 | `changes: []`，不拋錯（AC-06(b-3)；**MG-1 修訂零影響**——(b-0) 之預檢須先確認 `summary` 為物件且兩鍵在場，`null` 不得使預檢拋錯） |
| B-12 | `summary` 為巢狀混合形（油耗版本：`before`／`after` 各為物件 ＋ `basisNote` 純量）（**MG-1 修訂**） | **走 AC-06(b-0)**：輸出恰 4 列＝`fuelType`／`kmPerLiter`／`effectiveFrom`（各含改前→改後兩欄）＋ `basisNote`；頂層 `before`／`after` **不**各自成列；且**零** `"[object Object]"` |
| B-26 | `summary` 之值為 `{from, to}` 兩鍵物件（`isActive: {from:true, to:false}`）（**MG-1 新增**） | **走 AC-06(b-1)**：一列 `{field:"isActive", before:"true", after:"false"}`；前端呈現為「啟用狀態｜是｜否」（AC-18(d)）；輸出 `'{"from":true,"to":false}'` 之 mutant 必紅 |
| B-27 | 巢狀混合形之**首版**（`before` 為 `null`、`after` 為物件 ＋ `basisNote`）（**MG-1 新增；(b-0) 之既有語意擴張半邊**） | 同 B-12 之 4 列，三個子鍵列之 `before` 皆為 `null`（前端顯示「—」）；**不得**退化為「`after` 整包 JSON 一列」 |
| B-28 | 巢狀兩側**子鍵不對稱**（`before` 有 `fuelType`／`kmPerLiter`，`after` 有 `fuelType`／`effectiveFrom`）（**MG-1 新增**） | 以**聯集**拆列（3 列）；缺側之欄為 `null`；取成**交集**（1 列）之 mutant 必紅——AC-06(d) 之守門對象 |
| B-29 | 篩選 `dateFrom=dateTo=D`，資料含「台北 D 日 00:00:00（＝`D−1 16:00Z`）」與「UTC D 日 23:59（＝台北 `D+1` 07:59）」兩列（**MG-2 新增**） | 前者**必命中**、後者**必不命中**；以 **UTC 日界**實作之 mutant 於本格必紅（雙向釘死） |
| B-13 | `targetId` 指向已被刪除之使用者（`SET NULL` 後） | `targetDisplayName: null`、`targetLabel` 仍為快照字串；不拋錯、不洩漏 id |
| B-14 | 刪除「曾執行任一被稽核操作」之管理員 | 依 **D5**：(a)/(c) → `409` ＋ 停用文案；**現況為 `500`** |
| B-15 | 刪除「上傳過附件（`TEMP`）但零申請」之使用者 | 依 **D5**：同上；**現況為 `500`** |
| B-16 | 刪除「代他人建過草稿、自己零申請」之管理員 | 依 **D5**：同上；**現況為 `500`** |
| B-17 | 刪除自己 | `409`「不可對自己執行此操作」（既有行為，零變更；實查 `admin/routes.ts` :392-394） |
| B-18 | 刪除不存在之 `:id` | `404`（既有行為，零變更） |
| B-19 | 未登入／需強制改密存取稽核端點 | `401` ／ `403 PASSWORD_CHANGE_REQUIRED` |
| B-20 | 一般使用者送出畸形 `page` 參數 | `403`（**非** `400`）——授權早於驗證之側信道守門 |
| B-30 | `targetLabel` **不含 `#`**（`loginName` 形／`USER_DELETED` 快照形／油耗 fallback 之裸 `userId`）（**MG-3 新增**） | **原樣全字呈現，不得截斷**（AC-18(e-1)）；wire 值不變。〔併記已揭露之邊界：`loginName` 本身含 `#` 時（現行驗證未禁止），顯示截於**首個 `#`** ——設計選擇與代價見 AC-18(e-1) 末點與 §17.1 #12〕 |
| B-31 | 明細列**全數**為純內部識別碼欄（合成 fixture `{applicationId, revisionOf}`）（**MG-3 新增**） | 濾後為空 → 走既有空態「（無異動明細）」，**不渲染空表頭**（AC-18(e-5)）；wire 之 `changes` 仍為兩列（AC-04／AC-06 零變更） |
| B-21 | `targetLabel` 或 `changes` 值含 XSS payload | 原樣入 DB、跳脫後呈現；DOM 零新增 `<script>` 節點 |
| B-22 | 作廢原因為 500 字元長文字 | 列表列不破版；375px 下零水平溢位（換行或截斷 ＋ 完整值可得） |
| B-23 | 稽核列數量極大（如 500 筆） | 分頁後單次回應恆 ≤ `pageSize`；**不得**將全集讀入記憶體（AC-03(c) 結構守門） |
| B-24 | 查詢端點被呼叫 | **零**新增稽核列（查詢不是被稽核事件；AC-01(d)） |
| B-25 | 同一 query 參數**重複帶入**（Fastify 執行期給 `string[]`）——`action`／`actorId`／`targetId`／`dateFrom`／`dateTo`／`page`／`pageSize` **七個參數皆適用** | `400 VALIDATION_ERROR` ＋ `fields[{field:"<該欄>"}]`；該欄**不得**以陣列值穿透至 Prisma `where` 而爆 `500`。**溯源**：逐字沿 `backend/src/applications/application-query.ts` :115／:241 之 **B-35** 既有紀律（PHASE-005 T6-AR-1 同型）；判讀經 T1／T2 兩輪即審 CONFIRM（T1 W-6）。**實測落點**：`backend/test/unit/audit-log-query.test.ts` 型別防禦格（:448，`it.each` 七欄）＋ `backend/test/integration/phase10-audit-query.test.ts` wire 格（:840） |

---

## 6. 權限與敏感資料

### 6.1 授權矩陣（**1 端點 × 5 身分 ＝ 5 格，格數明列**）

| # | 端點 | 身分 | 期望 |
|---|---|---|---|
| 1 | `GET /admin/audit-logs` | 未登入 | `401 UNAUTHORIZED` |
| 2 | 同上 | 已登入但 `mustChangePassword` | `403 PASSWORD_CHANGE_REQUIRED` |
| 3 | 同上 | 一般使用者（`USER`） | `403 FORBIDDEN`，回應零業務值 |
| 4 | 同上 | 一般使用者且為某些稽核列之 `target` | `403 FORBIDDEN`——**與 #3 逐字相同**（不得因「與自己相關」而放行；D4(a)） |
| 5 | 同上 | 管理員（`ADMIN`） | `200` |

**判定紀律（沿 PHASE-004／008／009 既有不變式，本 Phase 零變更）**
1. 授權（`401`／`403`）一律**先於**參數驗證（`400`）與任何 DB 查詢——B-20 為其側信道守門。
2. `403` 回應**零業務值**（不含 `total`、不含任何稽核內容）。
3. 授權判定僅依 `request.currentUser.role`，永不採信請求參數。

### 6.2 稽核事件對照表（AD-US-14① 七類 × 現行 10 個 `AuditAction` 值——**零缺漏之實查佐證**）

| AD-US-14① 之事件類別 | 對應 `AuditAction` 值 | 寫入落點（實查） | 交易語意 |
|---|---|---|---|
| 新增（帳號） | `USER_CREATED` | `admin/routes.ts` :225 → `writeAudit` | **fire-and-forget**（見 **D11**） |
| 停用（帳號） | `USER_DEACTIVATED` | `admin/routes.ts` :272 | fire-and-forget |
| （啟用，US 未列之對稱事件） | `USER_ACTIVATED` | `admin/routes.ts` :308 | fire-and-forget |
| 密碼重設 | `USER_PASSWORD_RESET` | `admin/routes.ts` :368 | fire-and-forget |
| （刪除帳號，AD-US-04③） | `USER_DELETED` | `admin/routes.ts` :426 | fire-and-forget |
| 代操作（建立） | `APPLICATION_CREATED_ON_BEHALF` | `admin/routes.ts` :502／:587／:691；`applications/routes.ts` :1727（修正版） | **同交易**（`onCreated` hook） |
| 代操作（修改） | `APPLICATION_UPDATED_ON_BEHALF` | `applications/routes.ts` :882／:1083／:1292 | 同交易 |
| 作廢 | `APPLICATION_VOIDED` | `applications/routes.ts` :1509 | 同交易 |
| 參數異動 | `PARAMETER_VERSION_CREATED` | `parameters/routes.ts` :205／:279／:369 | 同交易 |
| 油耗資料異動 | `USER_FUEL_CONSUMPTION_VERSION_CREATED` | `users/fuel-consumption-routes.ts` :242 | 同交易 |

> **結論**：US 明列之七類事件**全數已有落點，零缺漏** → 依 PRD :506「若發現缺漏則回補」之條件**不觸發**，本 Spec 不提出回補 Task。
> **但實查揭露一項不對稱**：帳號類五事件為 **fire-and-forget**（`audit/audit.ts` :53-56 明文 catch 並吞例外，且與主操作**非同交易**），其餘五類為同交易。對「稽核完整性＝授權可追溯性」之 High 風險 Phase 而言，此為實質缺口——列 §16 **D11** 交人類裁定，**不由 spec-writer 定案**。

### 6.3 敏感資料

| 項目 | 處置 |
|---|---|
| **密碼／雜湊／token** | 恆不入 `AuditLog`（AC-09(a)(c)）；本 Phase 新增之 `changes` 為新揭露面，須同批掃描（AC-09(b)） |
| **內部識別值**（`actorId`／`targetId`／`applicationId` 等） | `AuditLogListItemDto` **不輸出** `actorId`／`targetId`（AC-04(b)）。`summary` 內既存之 `applicationId`／`revisionOf` 為既有欄位，經 `changes` 呈現屬既有揭露面之延續，**不擴大**（管理員 only） |
| **作廢原因**（使用者自由文字） | 入 `changes` 並於頁面呈現（BE-US-31② 之終點）；**跳脫後呈現**（AC-18(a)）；**不入任何日誌行**（沿 PHASE-009 AC-25 既有紀律，本 Phase 之新端點日誌亦適用） |
| **油耗依據備註／出差目的** | 同上（使用者自由文字，跳脫後呈現） |
| **稽核內容之可見範圍** | **管理員 only**（D4(a)）；一般使用者 `403` 且回應零業務值 |
| **查詢參數** | `actorId`／`targetId` 為內部 id，**不得**進入 URL 以外之持久化紀錄；不記入日誌 |

---

## 7. API Contract

### 7.1 端點總表（本 Phase 新增 **1 個**）

| 方法 | 路徑 | 說明 | 授權 | 成功碼 |
|---|---|---|---|---|
| `GET` | `/admin/audit-logs` | 稽核事件列表（分頁 ＋ 篩選） | **管理員 only** | `200` |

> **落點依 §16 D1**。實查佐證：`admin/routes.ts` 現為 **723 行**、`applications/routes.ts` 為 **1875 行**、`users/fuel-consumption-routes.ts` 為 **343 行**（獨立子域自有 routes 檔之既有先例）。

### 7.2 DTO 形狀

```ts
// 依 §16 D3 之裁定；(c) 為推薦形狀
interface AuditLogListItemDto {
  id: string;
  action: AuditAction;            // 10 值之一（AC-10(b) 封閉）
  createdAt: string;              // ISO 8601 UTC（D9）
  actorDisplayName: string;       // AuditLog.actor.displayName
  targetLabel: string;            // DB 既有快照欄（**完整值**；前端呈現只取 `#` 前段——AC-18(e-1)，wire 零變更）
  targetDisplayName: string | null; // target 已刪除時為 null
  changes: AuditChangeDto[];      // 由 summary 扁平化（AC-06）
}

interface AuditChangeDto {
  field: string;                  // summary 之頂層鍵
  before: string | null;          // 純量形時恆 null
  after: string | null;
}

interface AuditLogListResponse {
  items: AuditLogListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}
```

### 7.3 請求形狀

```
GET /admin/audit-logs
  ?action=APPLICATION_VOIDED     // optional，須為合法 AuditAction
  &actorId=<cuid>                // optional（依 D2）
  &targetId=<cuid>               // optional（依 D2）
  &dateFrom=2026-08-01           // optional，YYYY-MM-DD，含當日；**台灣（UTC+8）日曆日**（AC-02(e)／MG-2）
  &dateTo=2026-08-31             // optional，YYYY-MM-DD，含當日；同上
  &page=1                        // optional，預設 1
  &pageSize=20                   // optional，預設 20、上限 100（clamp）
```

### 7.4 錯誤合約（本 Phase **零新增 `ErrorCode`**）

| 情境 | HTTP | `code` | 備註 |
|---|---|---|---|
| 未登入 | 401 | `UNAUTHORIZED` | 既有 |
| 需強制改密 | 403 | `PASSWORD_CHANGE_REQUIRED` | 既有 |
| 非管理員 | 403 | `FORBIDDEN` | 既有；零業務值 |
| 參數違規 | 400 | `VALIDATION_ERROR` ＋ `fields[]` | 既有形狀 |
| 未預期例外 | 500 | `INTERNAL_ERROR` | 既有；AC-21 只改日誌不改 wire |

> **`ErrorCode` 聯集全等斷言**：本 Phase 不新增任何碼——以既有 contract 測試之聯集斷言守門（BOGUS mutant 必紅）。

### 7.5 PHASE-011 之複用介面約束

- `AuditLogListItemDto` 與 `changes` 扁平化函式為**唯讀投影**，PHASE-011 之備份／清理**不得**改寫其語意。
- 若 PHASE-011 引入稽核保留期限，須明確裁定「已被清理之期間在本頁如何呈現」——本 Phase 不預設。

---

## 8. 資料模型與 migration

**本 Phase 以讀取為主。依 §16 D8 推薦 (a)（enum 零新增）時，本 Phase 之 migration 影響為：零。**

| 面向 | 影響 |
|---|---|
| `AuditLog` 表結構 | **零變更**（既有 7 欄 ＋ 3 索引已足：`@@index([actorId])`／`@@index([targetId])`／`@@index([createdAt])`——實查 `schema.prisma` :99-101） |
| 索引 | **零新增**。`createdAt` 索引即為 AC-03 主排序鍵之支撐；`actorId`／`targetId` 索引支撐 D2(b) 之兩個篩選維度。`action` 無索引——本 Phase **不新增**（沿 PHASE-005 D9(a)「不新增索引，屆時以實測決定」之既有裁定；效能實測歸 PHASE-011） |
| `AuditAction` enum | 依 **D8**：(a) → 零變更；(b)/(c) → 含 `ALTER TYPE` 之 migration，**T4 之機械連動擴為 5 處**（AC-10(d)）且 T4 風險由 Medium 升 High、預算取上緣 |
| `userHasHistory` 之查詢面 | 依 **D5**：(a)/(c) → `history.ts` 新增 2~3 個 `count` 查詢（**純程式，零 schema 變更**）；(b) → `admin/routes.ts` 新增 P2003 catch（純程式） |
| 其他表 | **零變更** |

> **若 D8 裁定 (b)/(c)**：migration 型態沿 PHASE-009 之 `ALTER TYPE` 獨立檔慣例（實查：`20260807140100_phase9_audit_action_voided`），且須沿 FW-8 之 raw SQL baseline fixture 處置。**此路徑之成本上升已於 §15 T4 預算欄標註。**

---

## 9. Data Flow（本 Phase 影響部分）

### 9.1 稽核檢視（唯一之新讀取路徑）

```
GET /admin/audit-logs
  → requireAuth → requirePasswordChanged → requireAdmin        【授權，早於一切】
  → parseAuditLogQuery(query)  〔純函式〕                        【400 + fields[]，零查詢】
        └ 日期區間之日界＝台北日（UTC+8），AC-02(e)／MG-2
  → buildAuditLogWhere(filters) 〔純函式〕
  → Promise.all([
        prisma.auditLog.findMany({ where, include:{actor,target}, orderBy:[createdAt desc, id desc], skip, take }),
        prisma.auditLog.count({ where })
     ])                                                          【DB 層分頁與計數】
  → items.map(toAuditLogListItemDto)
        → flattenAuditSummary(summary) 〔純函式〕→ changes[]     【AC-06 單一事實來源】
  → 200 { items, total, page, pageSize }                         【零寫入】
```

### 9.2 稽核寫入（**本 Phase 零變更**，僅回歸）

既有兩種語意並存，本 Phase 只回歸不改（除非 **D11** 裁定改變）：
- **同交易**（PHASE-003a 起五類）：業務寫入 → `tx.auditLog.create` → COMMIT；hook 拋錯即整筆回滾。
- **fire-and-forget**（PHASE-002 帳號類五事件）：業務寫入 COMMIT → `writeAudit`（獨立連線，失敗僅 `console.error`）。

### 9.3 使用者刪除守門（依 **D5** 可能變更）

```
DELETE /admin/users/:id
  → 自我操作守門（409）
  → 存在性（404）
  → userHasHistory(prisma, id)  【現況查 2 表；D5(a)/(c) → 查 6 表】
        → true  → 409 「此帳號已有資料，無法刪除，請改用停用」
        → false → prisma.user.delete
                    → 【D5(b)/(c)】catch P2003 → 409 同文案
                    → 成功 → writeAudit(USER_DELETED)
```

---

## 10. 非功能需求

| # | 需求 | 落點 |
|---|---|---|
| N-1 | 稽核列表查詢**不得**將命中集合整份讀入記憶體 | AC-03(c) 結構斷言（`skip`/`take` ＋ 獨立 `count`） |
| N-2 | 稽核內容**恆不入日誌**（作廢原因、備註、目的等自由文字） | §6.3；沿 PHASE-009 AC-25 既有 `logStream` 掃描形狀 |
| N-3 | 端點回應**零 storage 存取**、零外部 I/O | 純 DB 讀取 |
| N-4 | 前端 375px 可用 | AC-19(c)、B-22 |
| N-5 | 效能目標（列表 2 s） | **本 Phase 不實測**——歸 PHASE-011（§1.2 #6） |
| N-6 | 本 Phase **零新增 npm 依賴、零容器變更、零 env 變更** | §15 各 Task Done When |

---

## 11. 測試策略

### 11.0 測試紀律（強制，寫入每個 Task Packet）

1. **TDD**：先寫必失敗之測試；不得刪除、弱化、skip 既有測試換綠燈。
2. **零弱化**：AC-20 寫入每個 Task 之 Done When。
3. **禁止金額彙總**：本 Phase 任一 Task **不得**引入 `aggregate`／`groupBy`／`_sum`（跨 Phase 追蹤 #9）；如認為必要，須回 Spec。
4. **真實端點優先**：稽核齊備回歸與 AD-US-04 回歸一律走真實 HTTP 端點，**禁止**以 `prisma.auditLog.create`／raw SQL 直寫構造被驗證之狀態（沿 PHASE-009 AC-16／AC-17 紀律）。
5. **防恆真**：每一組計數型斷言須配一條負向對照（AC-07(c) 為範例形狀）。
6. **前端負向守門自帶**：AC-18(b) 不得倚賴後端測試（PHASE-009 T15c FW）。

### 11.1 單元（Vitest，不需 DB）

- `parseAuditLogQuery`：B-01~B-09 之參數矩陣逐格；clamp 與 400 之分野；**B-29 台北日界（MG-2）——兩個半開區間端點以逐字 UTC 字面斷言，UTC 日界 mutant 必紅**。
- `flattenAuditSummary`：AC-06(b-0)~(b-3)(c)(d)(f)；以四種真實 `summary` 形狀為 fixture（自各 Phase 實際寫入形狀抄錄，不自行虛構）＋ **MG-1 新增之 B-26／B-27／B-28 三格**；鍵守恆之**刪頂層鍵**與**刪子鍵**兩類 mutant 皆必紅。
- `buildAuditLogWhere`：純函式 `toEqual`。

### 11.2 整合（Vitest ＋ PostgreSQL ＋ 真實 route）

- `phase10-audit-query.test.ts`：AC-01、AC-03、AC-04、AC-05（5 格）、B-10~B-13、B-19~B-20、B-23~B-25、**B-29（MG-2 台北日界之 wire 面雙向釘死）**。
- `phase10-audit-completeness.test.ts`：AC-07（七類 ＋ 負向對照）、AC-08（代操作兩類）、AC-09（全表 ＋ wire 掃描）。
- `phase10-audit-structure.test.ts`：AC-10（站點白名單 ＋ enum 對照 ＋ 標籤表涵蓋）、AC-11（不可變性掃描 ＋ mutant 自證）。
- `phase10-user-delete-regression.test.ts`：AC-12（五類）、AC-13、AC-14（依 D5）、B-14~B-18。
- 【條件】`phase10-error-handler-leak.test.ts`：AC-21（依 D6）。

### 11.3 前端（Vitest ＋ Testing Library，mock fetch）

- `AuditLogPage.test.tsx`：AC-15、AC-16、AC-17（五態各一）、AC-18(b)(c)、B-21~B-22；**AC-18(e-1)(e-7) `targetLabel` 呈現面（MG-3）——`帳號#編號` 只見帳號之正向 ＋ `#` 後段字面於畫面零命中之負向 ＋ 參數型（`FUEL_PRICE#…`）同型 ＋ B-30 無 `#` 不截斷 ＋ 顯示名稱去重（不得出現「alice（alice）」）**。
- `HomePage.test.tsx`（既有檔擴充）：AC-15(b) 之管理員入口正負向。
- `AuditChangesList.test.tsx`（若拆元件）：AC-18(a)(b) 之 XSS 與 `[object Object]` 守門；**AC-18(d) 值中文化（MG-1）——枚舉四類 ＋ 布林兩值逐值正向、未知值原樣回退負向、自由文字（作廢原因）不得被誤譯之防誤譯格、14 值覆蓋守門常數之刪值 mutant**；**AC-18(e-2)~(e-5) 明細列過濾（MG-3）——`applicationId`／`revisionOf` 兩列不渲染之正負向、隱藏欄常數恰兩鍵之刪／增 mutant、隱藏欄 ⊆ `FIELD_LABELS`、B-31 全濾後之既有空態，及 **(e-4)** 32 鍵守門改以標籤表為斷言對象後「刪 `FIELD_LABELS` 之隱藏欄鍵仍必紅」之鑑別力自證**。

### 11.4 E2E（Playwright）

- `e2e/audit-log.spec.ts`：AC-19(a)~(d)。Mock Gate 與整合 Gate 皆以此檔為機械對照。

### 11.5 安全測試

- XSS：AC-18(a) 之三種 payload 正負向。
- 授權側信道：B-20（`403` 早於 `400`）；#3 與 #4 之回應逐字相同。
- 日誌洩漏：N-2 之 `logStream` 掃描（新端點路徑）；【條件】AC-21(c) 之反向探針。

### 11.6 方法論 spike（治理 §11 強制）

| 手段 | 本專案是否有先例 | 處置 |
|---|---|---|
| 原始碼字面／檔案集合白名單掃描（AC-10、AC-11、AC-21(b)） | **有**（PHASE-009 AC-05(a) 白名單、AC-28 `logStream` 掃描、PHASE-008 `PHASE_008_SRC_FILES` 目錄實列） | 沿既有形狀，無須 spike。**併記既有教訓**：PHASE-009 T2 SF-2 證「單行字面掃描」對 enum 成員／跨行／變數間接三型有規避面——本 Phase 之掃描須自帶同型規避探針 |
| `logStream` 敏感字串掃描（N-2、AC-21(c)） | **有**（PHASE-009 AC-25／AC-28） | 沿用 |
| `assertNoSensitiveContent` 遞迴掃描（AC-09） | **有**（`phase4-on-behalf-audit.test.ts` :109、`phase6-on-behalf.test.ts` :110） | 沿用；本 Phase 擴及 wire 面為新應用但同手法。**允許集之封閉射程逐字見 AC-09(a)**（限「Spec／schema 強制上 wire 之識別字之完整字面」，現行恰兩個；完整字面相等比對，**子字串不放行**；封閉性由 AC-09(c) 之 `toEqual` 承擔）——`SPEC-REV-010-LITE-2` 依 T3 即審 W-1(iii) 明載 |
| **`information_schema.referential_constraints` ＋ `key_column_usage` 之 FK 列舉（AC-14(a)）** | **無**——實查全 `backend/test` 僅見 `information_schema.columns`／`tables` 與 `pg_type`／`pg_namespace` 之用法（`phase5a-migration-safety.test.ts` :539-559、`phase9-migration-safety.test.ts`），**無 FK 中繼資料查詢之先例** | **⚠ 方法論風險**。T5 之第一步須以**最小 spike** 證明該查詢可在 worker schema 下正確列舉出六條 FK 與其 `delete_rule`；**spike 失敗之替代路徑**＝改採「`backend/prisma/migrations/**/migration.sql` 之 `REFERENCES "User"` 字面掃描」（該手法有 PHASE-009 migration.sql 字面掃描先例）。**T5 預算取上緣**（見 §15） |
| **`SPEC-REV-010-GATE` 之兩項修復（MG-1 攤平／MG-2 台北日界）** | **有**——三具手段皆在場且已實跑：①純函式 fixture 對照（`audit-summary-flatten.test.ts` 之四形狀 `toEqual`）②整合 wire 面之毫秒級邊界 fixture（`phase10-audit-query.test.ts` :220-223 之四常數，PHASE-010-T2 已實證可精準釘死半開區間）③前端對照表覆蓋守門常數（T7R 之 `REQUIRED_SUMMARY_FIELDS`，刪鍵即紅已實證） | **無須 spike**——**零新量測手段、零新工具、零新觀測管道**；固定 +8h 之時區換算為算術運算（**不引入時區資料庫**），其正確性由 ②之毫秒級雙向 fixture 直接觀測。**方法論風險：低**，故三個修復 Task 之預算取**帶內**而非上緣 |

---

## 12. AC ↔ 測試映射表（機械可查；隨 Task 完成更新「狀態」欄）

> **格式**：`AC` ｜ `層級` ｜ `測試檔（規劃路徑）` ｜ `測試名（預定名稱）` ｜ `Task` ｜ `狀態`
> 狀態值：`PENDING`（尚無測試證據）／`PENDING（Spec Gate 裁定後解鎖）`（條件 AC）／**`PENDING（Gate 修訂後待重驗）`**（`SPEC-REV-010-GATE` 新增：該列既有測試曾為 `GREEN`，但其**被測語意已因 Mock Gate 反饋之 Spec 修訂而改變**，既有斷言不再等於現行 AC，須由修復 Task 重測後逐字回填——**不得**以「原本是綠的」視同覆蓋）／`RED`／`GREEN`／`N/A（非測試）`（該 AC 子項之落點依 Spec 本文即為 Handoff 物證等非測試載體；不計入測試覆蓋計數）。
> **Phase 完成前之覆蓋檢查與終審核對以本表為準**（治理 2026-08-02.1）。轉 `GREEN` 時**一律以實際存在之測試名逐字回填**。

| AC | 層級 | 測試檔 | 測試名（預定） | Task | 狀態 |
|---|---|---|---|---|---|
| AC-01(a)(b)(c) | integration | `backend/test/integration/phase10-audit-query.test.ts` | `PHASE-010-T2 — GET /admin/audit-logs` › `AC-01 端點與回應形狀` › `(a)(b) 200 ＋ 回應 body 為封閉四鍵（多一鍵必紅）`；`(c) 零結果 → 200 ＋ items: [] ＋ total: 0（非 404）——B-09 不存在之 actorId`；`(c)／B-06 合法 action 但零命中 → 200 ＋ 空集` | T2 | `GREEN`（T2 `1aec6ed`） |
| AC-01(d) | integration | `backend/test/integration/phase10-audit-query.test.ts` ＋ `backend/test/integration/phase10-audit-completeness.test.ts`（**兩檔並列**） | ①`PHASE-010-T2 — GET /admin/audit-logs` › `AC-01 端點與回應形狀` › `(d)／B-24 端點零寫入：AuditLog／User／Application 三表逐欄不變`；②`PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）` › `AC-07 — 七類事件端到端齊備回歸（AD-US-14①／BE-US-31）` › `FW-1（T2 即審）: GET /admin/audit-logs 呼叫前後 AuditLog／User／Application 三表逐欄不變，且三表皆非空`（**三表皆非空之實質補齊**——①之 T2 版於 `Application` 表恆空之分支上為恆真） | T2／T3 | `GREEN`（T2 `1aec6ed`；FW-1 格 T3 `81dd7b9`） |
| AC-02(a)~(e) | unit | `backend/test/unit/audit-log-query.test.ts` | `AC-02: parseAuditLogQuery 參數矩陣（B-01~B-09）`（含 `B-29 台北（UTC+8）日界雙向釘死（MG-2；UTC 日界之 mutant 必紅）` 子 describe 3 格＋dateFrom 借位 it.each 3 例——T-MG1-BE2 已落地） | T1 → **T-MG1-BE2** | **`GREEN`（MG-2 重驗 T-MG1-BE2 `c919aac`）** |
| AC-02(f) | unit | 同上 | `AC-02(f): 解析為純函式 — 零 DB／零 Prisma 型別相依` | T1 | `GREEN`（T1 `d7b70ad`） |
| AC-02(a)(e) | unit | `backend/test/unit/audit-log-where.test.ts` | `PHASE-010-T2R-LITE — buildAuditLogWhere（where 建構純函式；Spec §11.1）` | T2（R-LITE） | `GREEN`（`1a6b714`）——**MG-2 零斷言影響**（該檔以 `Date` 值直接建構 `parsed(...)`，不經 `parseAuditLogQuery`，故日界平移不改其真偽；惟「單日語意自證」格之 fixture（`2049-07-12T00:00Z`／`07-13T00:00Z`）與檔頭敘述仍為 **UTC 日框架**，須由 **T-MG1-BE2** 同批對齊為台北日界字面，屬**記載對齊、零語意變更**） |
| AC-03(a)(b) | integration | `phase10-audit-query.test.ts` | `PHASE-010-T2 — GET /admin/audit-logs` › `AC-03 全序排序與跨頁不重不漏` › `(a) 排序恆為 createdAt DESC, id DESC——同 createdAt 之 5 列逐位對照 id 降冪`；`(a) 跨不同 createdAt 時以 createdAt 降冪為主鍵`；`(b)／B-10 createdAt 完全相同之 5 列，pageSize=2 跨頁：聯集恰等於全集且零重複` | T2 | `GREEN`（T2 `1aec6ed`） |
| AC-03(c) | integration | 同上 | `PHASE-010-T2 結構性斷言（AC-03(c)／ErrorCode 聯集）` › ``AC-03(c)：分頁與計數皆於 DB 層完成——`skip`／`take` ＋ 獨立 `count` 在場，且零記憶體內切片`` | T2 | `GREEN`（T2 `1aec6ed`） |
| AC-04(a)(b)(c)(e) | integration | 同上 | `PHASE-010-T2 — GET /admin/audit-logs` › `AC-04 列投影（AD-US-14② 之四要素）` › `(a) AuditLogListItemDto 鍵集封閉為七鍵（多一鍵必紅）`；`(b) 操作者＝actorDisplayName；回應零內部識別值（actorId／targetId 不外露）`；`(c) 受影響資料＝targetLabel ＋ targetDisplayName（target 在場時為其顯示名）`；`(c)／B-13 target 已被刪除（SET NULL 後）→ targetDisplayName: null，targetLabel 仍為快照`；`(e) createdAt 以 ISO 8601 UTC 字串輸出` | T2 | `GREEN`（T2 `1aec6ed`） |
| AC-04(d) | integration | 同上 | `PHASE-010-T2 — GET /admin/audit-logs` › `AC-04 列投影（AD-US-14② 之四要素）` › `(d) 十個 AuditAction 值逐一皆有一條真實列可被取回並通過 (a)~(c)`；`(d) 含 APPLICATION_VOIDED，且作廢原因逐字可見於 changes` | T2 | `GREEN`（T2 `1aec6ed`） |
| AC-05(a)(b)(c) | integration | 同上 | `PHASE-010-T2 — GET /admin/audit-logs` › `AC-05 授權矩陣（1 端點 × 5 身分 ＝ 5 格）`（該 describe 下 8 條 `it`：格 1~格 5 ＋ 三條 B-20 側信道） | T2 | `GREEN`（T2 `1aec6ed`） |
| AC-06(a)(b)(d)(e) | unit | `backend/test/unit/audit-summary-flatten.test.ts` | `AC-06: flattenAuditSummary 形狀分派與鍵守恆（刪鍵 mutant 必紅）`（**MG-1 後須增 (b-0) 子欄拆列、(b-1) `{from,to}`、鍵守恆改集合相等 ＋ 刪子鍵 mutant**） | T1 → **T-MG1-BE1** | **`GREEN`（MG-1 重驗 T-MG1-BE1 `73f874d`）** |
| AC-06(c)(f) | unit | 同上 | `AC-06(c)(f): 四種真實 summary 形狀皆成立且零 [object Object]`（**MG-1 後：四形狀之期望輸出重寫 ＋ B-27／B-28 兩格新增**） | T1 → **T-MG1-BE1** | **`GREEN`（MG-1 重驗 T-MG1-BE1 `73f874d`）** |
| AC-07(a)(b) | integration | `backend/test/integration/phase10-audit-completeness.test.ts` | `PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）` › `AC-07 — 七類事件端到端齊備回歸（AD-US-14①／BE-US-31）` › `AC-07: 七類事件經真實端點觸發後稽核列齊備且可經檢視端點取回`；`AC-07(a): 全表 action 分佈恰等於七類事件之預期計數（零額外／零缺漏稽核列）`；`AC-07(a)⑥: PARAMETER_VERSION_CREATED 之 summary.parameterType 三值逐一在場`；`AC-07(a)⑤: 作廢由本人與管理員各寫一條（BE-US-31② 之兩身分皆寫）` | T3 | `GREEN`（T3 `81dd7b9`） |
| AC-07(c) | integration | 同上 | `PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）` › `AC-07 — 七類事件端到端齊備回歸（AD-US-14①／BE-US-31）` › `AC-07(c): 本人自建草稿零稽核列（防恆真負向對照）`；`AC-07(c) 延伸: 管理員經代操作端點對自己建立草稿 → 零稽核列（C3 邊界）` | T3 | `GREEN`（T3 `81dd7b9`） |
| AC-08(a)(b) | integration | 同上 | `PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）` › `AC-08 — 代操作稽核之完整性回歸` › `AC-08: 代操作稽核完整性 — 作廢與修正版兩類（含三向零稽核邊界）` | T3 | `GREEN`（T3 `81dd7b9`） |
| AC-08(c) | integration | 同上 | `PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）` › `AC-08 — 代操作稽核之完整性回歸` › `AC-08(c): 兩類 summary 經 AC-06 扁平化後於列表可讀（作廢原因逐字可見、revisionOf 在場、鍵守恆）` | T3 | `GREEN`（T3 `81dd7b9`） |
| AC-09(a)(b) | integration | 同上 | `PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）` › `AC-09 — 密碼與敏感資料不入稽核之全表回歸` › `AC-09: 密碼與敏感資料不入稽核 — DB 全表 ＋ wire 面雙掃描`；`掃描器鑑別力自證：兩具掃描器對合成陽性樣本必拋（防恆真）`（後者亦為 AC-09(a) 允許集「子字串不放行」之守門——其 `expect(...).toThrow()` 樣本含 `mustChangePasswordExtra` 與 `{ field: "mustChangePassword" }` 兩則） | T3 → **T-MG1-BE1**（僅前一格） | **`GREEN`（MG-1 重驗 T-MG1-BE1 `73f874d`）** |
| AC-09(c) | integration | 同上 | `PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）` › `AC-09 — 密碼與敏感資料不入稽核之全表回歸` › `AC-09(c): USER_PASSWORD_RESET 之 summary 為封閉單鍵 {mustChangePassword:true}（加鍵 mutant 必紅）` | T3 | `GREEN`（T3 `81dd7b9`） |
| AC-09(d) | integration | 同上 | `PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）` › `AC-09 — 密碼與敏感資料不入稽核之全表回歸` › `AC-09(d): USER_DELETED 之稽核列 targetId 為 null、targetLabel 為刪除前快照且不含敏感資料` | T3 | `GREEN`（T3 `81dd7b9`） |
| AC-10(a)(b)(c)(d) | integration | `backend/test/integration/phase10-audit-structure.test.ts` | `AC-10: 稽核寫入站點白名單（5 檔／13 呼叫）＋ enum 10 值 ＋ 標籤表涵蓋` | T4 | `PENDING` |
| AC-11(a)(b)(c) | integration | 同上 | `AC-11: AuditLog 零 update／delete／upsert 掃描 ＋ mutant 自證` | T4 | `PENDING` |
| AC-12(a)(b)(c) | integration | `backend/test/integration/phase10-user-delete-regression.test.ts` | `AC-12: 五類歷史逐一 409 拒刪且零刪除（VOIDED 經真實作廢端點構造）` | T5 | `GREEN`（T5 `f900984`） |
| AC-13(a)(b)(c) | integration | 同上 | `AC-13: 零歷史可刪 ＋ USER_DELETED 稽核列 ＋ targetDisplayName null` | T5 | `GREEN`（T5 `f900984`） |
| AC-14(a) | integration | 同上 | `PHASE-010-T5 — AD-US-04 有歷史拒刪回歸 ＋ FK 守門完整性` › `AC-14: 六條 RESTRICT FK 之守門完整性；三條缺口路徑 409（非 500）` › `(a) spike：information_schema 於 worker schema 下列舉出指向 User 之全部 FK，逐條與 Spec §2 基線相符`；`(a) RESTRICT／NO ACTION 之引用表集合恰等於 userHasHistory 所查之表集合`；**`(a) 欄位級：RESTRICT／NO ACTION 之「表.欄」集合恰等於守門宣告之「表.欄」集合`**（＝§2 AC-14(a) 欄位級升格之落點）；`(a) mutant①：守門清單移除任一項 → 相符斷言必紅（逐項驗，非抽樣）`；`(a) mutant②：DB 新增一條未守門之 RESTRICT FK → 相符斷言必紅`；`(a)／FW-4：AuditLog.targetId 為 SET NULL 且刻意不入守門清單（被操作過的人可刪，操作過的人不可刪）`；`(a)／SF-1 守門判定邏輯之鑑別力：六條 guard 逐條對「僅走該路徑」之使用者計得 > 0、對零歷史者 0，且 userHasHistory 六人皆 true／零歷史者 false` | T5／T5R-LITE | `GREEN`（T5 `f900984`；SF-1 鑑別力格 T5R-LITE `69d4cae`；D5=(c) 生效解鎖 2026-08-09） |
| AC-14(b) | integration | 同上 | `PHASE-010-T5 — AD-US-04 有歷史拒刪回歸 ＋ FK 守門完整性` › `AC-14: 六條 RESTRICT FK 之守門完整性；三條缺口路徑 409（非 500）` › `(b)／B-14 曾執行被稽核操作之管理員（AuditLog.actorId）→ 409（非 500）＋ 零刪除`；`(b)／B-15 上傳過附件之使用者（Attachment.uploaderId）→ 409（非 500）＋ 零刪除`；`(b)／B-15 被代上傳附件之使用者（Attachment.ownerId）→ 409（非 500）＋ 零刪除`；`(b)／B-16 代他人建過草稿、自己零申請之管理員（Application.createdById）→ 409（非 500）＋ 零刪除` | T5 | `GREEN`（T5 `f900984`） |
| AC-14(c) | —（非測試落點） | — | **Handoff 物證，非測試**：§2 AC-14(c) 之要求逐字為「修復前之**紅燈物證**（現況實得 500）須記入 Handoff」，其載體為 T5 Handoff 而非測試斷言；三條缺口路徑（B-14／B-15／B-16）修復前實得 `500` 之物證已由 T5 Handoff 承載。本列**不計入測試覆蓋計數**。 | T5 | `N/A（非測試）` |
| AC-14(d) | integration | 同上 | `PHASE-010-T5 — AD-US-04 有歷史拒刪回歸 ＋ FK 守門完整性` › `AC-14(d): DELETE 端點之 P2003 兜底 — 守門停用時仍為 409（非 500）` › `守門 stub 恆 false ＋ 真實 RESTRICT 列 → 409 CONFLICT ＋ 同一文案，使用者仍在`；`防恆真：守門 stub 恆 false ＋ 零 RESTRICT 列 → 200（兜底不是無條件 409）`；`mutant：兜底之錯誤碼辨識——P2003 為真；P2002／P2025／非 Prisma 例外皆為偽` | T5 | `GREEN`（T5 `f900984`；D5=(c) 之「P2003 兜底轉譯 409」半邊） |
| B-17／B-18（§5 邊界；AC-12／AC-13 之既有行為零變更對照） | integration | 同上 | `PHASE-010-T5 — AD-US-04 有歷史拒刪回歸 ＋ FK 守門完整性` › `B-17／B-18: 既有行為零變更` › `B-17 刪除自己 → 409「不可對自己執行此操作」（自我守門先於歷史守門）`；`B-18 刪除不存在之 id → 404 NOT_FOUND` | T5 | `GREEN`（T5 `f900984`） |
| AC-15(a)(b)(c) | frontend | `frontend/test/AuditLogPage.test.tsx` ＋ `frontend/test/HomePage.test.tsx`（**兩檔並列**） | ①`AuditLogPage` › `AC-15: 路由與列表欄位` › `AC-15(a)：非管理員進入 /admin/audit-logs 不渲染任何稽核內容`；`AC-15(c)：列表逐列顯示四要素（操作時間／操作者／操作類型／受影響資料）`；②（＝AC-15(b) 入口正負向）`HomePage — 稽核紀錄導覽連結` › `管理員登入 → 首頁顯示「稽核紀錄」連結，指向 /admin/audit-logs`；`一般使用者（role=USER）登入 → 首頁不顯示「稽核紀錄」連結` | T7 → **T-MG3-FE**（僅 AC-15(c) 一格） | **`GREEN`（MG-3 重驗 T-MG3-FE `7e66968`）** |
| AC-16(a)(b)(c) | frontend | `frontend/test/AuditLogPage.test.tsx` | `AuditLogPage` › `AC-16: 篩選與分頁 UI` › `AC-16(a)：篩選變更即重置 page 為 1（先翻頁至 2，再套用篩選 → 請求帶 page=1）`；`AC-16(b)：首頁「上一頁」停用、末頁「下一頁」停用`；`AC-16(c)：篩選與分頁參數確實經 query 送後端（請求 URL 含該參數）` | T7 | `GREEN`（T7 `15a1a9a`） |
| **AC-16(d)**（新，SF-1 裁定） | frontend | `frontend/test/AuditLogPage.test.tsx` | `AuditLogPage` › `AC-16(d): 使用者下拉篩選` › 三格：`AC-16(d) 正向：兩篩選欄為使用者下拉——選項文字為顯示名稱、送出值為 id，清單來自 apiGetUsers`／`AC-16(d) 負向：篩選區不得存在純文字 id 輸入欄`／`AC-16(d) 降級：使用者清單載入失敗時兩下拉停用並提示，稽核列表與其餘篩選照常（篩選不阻斷主功能）` | **T7R** | `GREEN`（T7R `951af53`） |
| AC-17 | frontend | 同上 | `AuditLogPage` › `AC-17: 五態` › `Loading 態：顯示載入中，且篩選控制項停用`；`Empty 態（無篩選）：顯示「尚無任何稽核紀錄」`；`Empty 態（篩選導致空集合）：文案與「尚無任何稽核紀錄」可區辨`；`Error 態（500）：顯示錯誤訊息與重試鈕，重試不重複送出`；`Error 態（400 篩選參數違規）：逐欄提示 fields[].reason`；`Success 態：列表渲染 N 列，每列四要素，並顯示共 M 筆`；`Permission denied 態：一般使用者顯示無權限訊息，零後續請求，無重試鈕，零稽核內容` | T7；另 `SF-5: 切頁期間之 Loading 守門` › `切頁請求掛起中：列表區零舊資料殘影、篩選控制項全停用、且無從重複送出`（T7R `951af53`，§4 Loading 表切頁半邊） | `GREEN`（T7 `15a1a9a`） |
| AC-18(a) | frontend | `frontend/test/AuditChangesList.test.tsx` ＋ `frontend/test/AuditLogPage.test.tsx`（**兩檔並列**） | ①`AuditChangesList` › `AC-18: 呈現安全` › `AC-18(a): XSS payload 三型跳脫；DOM 零新增 script 節點`（`changes[].before`／`after` 面）；②`AuditLogPage` › `追加①: targetLabel 之 AC-18(a) XSS 跳脫` › `三型 payload 逐字以純文字節點呈現，DOM 零新增 script 節點`（**`targetLabel` 面之實質補齊**——①之元件級不涵蓋頁面列之 `targetLabel`） | T6／T7 | `GREEN`（T6 `d625d94`；追加①格 T7 `15a1a9a`） |
| AC-18(b) | frontend | `frontend/test/AuditChangesList.test.tsx` | `AuditChangesList` › `AC-18: 呈現安全` › `AC-18(b): 巢狀混合 summary 渲染零 [object Object]（前端自帶負向）`（T-MG1-FE 依 BE1 新契約 4 列形重驗） | T6 → **T-MG1-FE** | **`GREEN`（MG-1 重驗 T-MG1-FE `5705082`）** |
| **AC-02(e) wire 面**（新列——`SPEC-REV-010-GATE` 補：日期篩選之整合面原無映射落點） | integration | `backend/test/integration/phase10-audit-query.test.ts` | `PHASE-010-T2 — GET /admin/audit-logs` › `篩選與邊界（wire 面）` › 三格：`FW-2 半開區間雙向釘死：台北 dateTo 當日 23:59:59.999（＝15:59:59.999Z）必命中 ∧ 台北次日 00:00:00.000（＝16:00:00.000Z）必不命中`／`B-07 dateFrom ＝ dateTo（單日）→ 該台北日之列全數命中`／`B-29 台北日界雙向釘死（MG-2）：台北 D 日 00:00 必命中 ∧ UTC D 日 23:59（台北 D+1 07:59）必不命中`（T-MG1-BE2 已落地） | T2 → **T-MG1-BE2** | **`GREEN`（MG-2 重驗 T-MG1-BE2 `c919aac`）** |
| AC-18(c) | frontend | `frontend/test/AuditChangesList.test.tsx` ＋ `frontend/test/AuditLogPage.test.tsx`（**兩檔並列**） | ①`AuditChangesList` › `AC-18: 呈現安全` › `AC-18(c): 時間在地化單一形式；同頁不並存 ISO 原字串`；②`AuditLogPage` › `追加②: createdAt 之 AC-18(c) 在地化單一形式` › `操作時間欄以在地化字串呈現，同頁不並存 ISO 原字串`（**頁面列 `createdAt` 面之實質補齊**） | T6／T7 | `GREEN`（T6 `d625d94`；追加②格 T7 `15a1a9a`） |
| **AC-18(d)**（新，MG-1 值中文化） | frontend | `frontend/test/AuditChangesList.test.tsx`／`AuditLogPage.test.tsx` | `AC-18(d): 值層中文化` › 四格：`枚舉四類逐值中文（type／fuelType／role／parameterType）`／`布林 true/false → 是/否（限定布林欄位）`／`未知值與自由文字原樣顯示不崩（防誤譯：作廢原因逐字不被映射）`／`14 值覆蓋守門常數：刪任一值即紅`；另 `BE2 即審 FW-1: dateFrom/dateTo 送出值紅線（T-MG1-FE）` 一格 | **T-MG1-FE** | **`GREEN`（T-MG1-FE `5705082`）** |
| **AC-18(e)**（新，MG-3 內部識別碼不呈現） | frontend | `frontend/test/AuditLogPage.test.tsx` ＋ `frontend/test/AuditChangesList.test.tsx`（**兩檔並列**） | ①（`targetLabel` 面，(e-1)(e-7)）`AuditLogPage` › `AC-18(e): 內部識別碼不呈現（MG-3）` › 預定四格：`帳號#編號 只顯示帳號段，# 後段字面於全頁零命中`／`參數型 FUEL_PRICE#<cuid> 只顯示 FUEL_PRICE`／`B-30 無 # 之 targetLabel 原樣全字呈現（不截斷）`／`(e-7) 顯示名稱去重以裁切後之值比較——不得出現「alice（alice）」`；②（明細列面，(e-2)~(e-5)）`AuditChangesList` › `AC-18(e): 純內部識別碼列不呈現（MG-3）` › 預定五格：`applicationId／revisionOf 兩列不渲染（正向）且其值字面零命中（負向）`／`其餘欄位列逐列照常渲染（防過濾過寬）`／`隱藏欄常數恰兩鍵：刪一鍵／多一鍵之 mutant 必紅`／`(e-4) 刪 FIELD_LABELS 之 applicationId／revisionOf 任一鍵 → 32 鍵守門仍必紅（鑑別力自證）`／`B-31 全列被濾 → 既有空態「（無異動明細）」且無空表頭` | **T-MG3-FE** | **`GREEN`（T-MG3-FE `7e66968`）** |
| AC-19(a)~(d) | e2e | `e2e/audit-log.spec.ts` | `AC-19: 稽核頁端到端（建帳號＋作廢兩事件可見）／篩選／分頁／375px` | T8 | `PENDING` |
| AC-20(a)(b) | 全套件 | —（終審實跑對照） | 基準線 後端 3230／前端 346／E2E 50 不下降 | 全 Task | `PENDING` |
| AC-21(a)~(d) | integration | `backend/test/integration/phase10-error-handler-leak.test.ts` | `AC-21: 兜底不記原文 ＋ 站點白名單 ＋ 路徑反向探針 ＋ wire 零變更` | T9 | `PENDING`（D6=(a) 生效解鎖 2026-08-09） |
| AC-22(a)(b)(c)(d) | integration | 既有 contract 檔擴充 | `AC-22: REPORT_GENERATION_FAILED 改道 wire 逐位元組不變；errorLabel 收斂` | T10 | `PENDING`（D7=(a) 生效解鎖 2026-08-09） |

**合計 22 條 AC ／ 42 列映射**（含 **1 列** `N/A（非測試）`＝AC-14(c)，故**測試列為 41 列**；另 **1 列**為 §5 邊界列 B-17／B-18）。條件 AC（AC-14／AC-21／AC-22）已隨 Spec Gate 裁定於 2026-08-09 解鎖。**AC 條數維持 22**——`SPEC-REV-010-LITE-3` 之 **AC-16(d)**、`SPEC-REV-010-GATE` 之 **AC-18(d)**／**AC-06(b-0)~(b-3)**、`SPEC-REV-010-GATE-2` 之 **AC-18(e)** 皆為既有 AC 之**子項**，不新增 AC 編號。
**狀態計數（`SPEC-REV-010-GATE-2` 後，42 列）**：`GREEN` **33**／`PENDING` **7**（T4×2／T8／T9／T10／AC-20／**AC-18(e)**）／**`PENDING（Gate 修訂後待重驗）` 1**（AC-15(a)(b)(c)——僅 (c) 一格受衝擊）／`N/A（非測試）` **1**＝**42**（測試列 41 ＋ `N/A` 1）。〔前一版計數為 41 列＝`GREEN` 34／`PENDING` 6／`N/A` 1（大總管 2026-08-10 SF-B 去重更正：原 AC-18(d) 預定列與實名列重複——刪預定列留實名列）。本次兩處：①**新增 AC-18(e) 一列**（`PENDING`／T-MG3-FE）②**AC-15 一列由 `GREEN` 轉 `PENDING（Gate 修訂後待重驗）`**（`GREEN` 34−1＝33）。**其餘 40 列狀態逐列零變更**——實查佐證：`AuditChangesList.test.tsx` 內**零**斷言依賴 `applicationId`／`revisionOf` 兩列之呈現（`REQUIRED_SUMMARY_FIELDS` :232-242 之守門為「英文鍵名**不得**出現」之負向式，過濾後仍為真——**惟其對該兩鍵之鑑別力歸零，故 AC-18(e-4) 強制改以標籤表為斷言對象**）；`e2e/audit-log.spec.ts` 尚未實作（AC-19 `PENDING`），零 E2E 衝擊。〕
> 計數推導（供機械核對）：修訂前 39 列＝`GREEN` 32／`PENDING` 6／`N/A` 1。本次 ①**5 列由 `GREEN` 轉 `PENDING（Gate 修訂後待重驗）`**（AC-02(a)~(e) unit／AC-06(a)(b)(d)(e)／AC-06(c)(f)／AC-09(a)(b)／AC-18(b)）→ `GREEN` 32−5＝**27**；②**新增 2 列**——`AC-02(e) wire 面`（`PENDING（Gate 修訂後待重驗）`，補既有覆蓋落點缺口）與 `AC-18(d)`（`PENDING`，新裁定落地）→ 待重驗 5＋1＝**6**、`PENDING` 6＋1＝**7**；③總列數 39＋2＝**41**。**`GREEN` 27 之全部落點皆未因本次修訂而語意變更**（逐列已於「狀態」欄註明零影響者：`audit-log-where.test.ts` 為記載對齊、AC-08(c) 與 AC-04(d) 之作廢／修正版 `summary` 不含頂層 `before`／`after` 故不觸發 (b-0)）。

> `SPEC-REV-010-LITE`（2026-08-09）：新增 `buildAuditLogWhere` 一列（§11.1 該項原無映射落點，30 → 31 列），並將 T2 之七列以實際測試名逐字回填轉 `GREEN`。表內以 `A` › `B` 表示「`describe` A 之下的 `describe`／`it` B」。
>
> `SPEC-REV-010-LITE-2`（2026-08-09）：**31 → 38 列**，四處：①**T3 四列拆為七列**（AC-07(a)(b)／AC-07(c)／AC-08(a)(b)／**AC-08(c)**／AC-09(a)(b)／**AC-09(c)**／**AC-09(d)**）——原四列之「測試名」各僅載一個 `it` 名，但 (c)／(d) 於 `phase10-audit-completeness.test.ts` 實為**獨立 `it`**；本次以該檔實際 `describe`／`it` 名逐字補全（含 AC-07(a) 之三個補強格與 AC-09 之掃描器鑑別力自證格）。②**AC-01(d) 補第二落點**——同檔之 `FW-1（T2 即審）` 格（T2 版於 `Application` 恆空分支上為恆真，FW-1 為其實質補齊），該列改為兩檔並列。③**AC-14 一列拆為四列**（(a)／(b)／**(c)＝`N/A（非測試）`**／**(d)** 新列），(a) 列併入 T5R-LITE 之 SF-1 鑑別力格（`69d4cae`）。④**新增 B-17／B-18 落點列**（§11.2 已列 `B-14~B-18`，其中 B-17／B-18 原無映射落點）。**本次零 AC 語意變更**（AC-14(a) 之欄位級升格見 §2，方向為更嚴且實作已達標）。
>
> `SPEC-REV-010-LITE-3`（2026-08-09）：**38 → 39 列**，三處：①**T7 三列逐字回填**——AC-15／AC-16(a)(b)(c)／AC-17 原載**預定名稱**（各一句），以 `AuditLogPage.test.tsx`／`HomePage.test.tsx` 實查之 `describe`／`it` 名逐字取代（AC-15 改**兩檔並列**：(b) 之入口正負向實際落於 `HomePage — 稽核紀錄導覽連結` 之兩個 `it`；AC-17 實為**七個 `it`**，非原載之一句）。②**AC-18(a)／(c) 補 T7 落點**——`AuditLogPage.test.tsx` 之 `追加①`（`targetLabel` 面 XSS）與 `追加②`（頁面列 `createdAt` 在地化）為 T6 元件級所**不涵蓋**之面，兩列改為兩檔並列（T6／T7）；同時為 T6 三列補上 `describe` 前綴（`A` › `B` 記法）。GREEN 標注維持（T6 `d625d94`／T7 `15a1a9a`）。③**新增 AC-16(d) 一列**（SF-1 裁定落地，`PENDING`／T7R）——**T7R 修復後之該列由大總管以實際測試名逐字回填並轉 `GREEN`**。
>
> `SPEC-REV-010-GATE`（2026-08-09）：**39 → 41 列**，三處：①**5 列轉 `PENDING（Gate 修訂後待重驗）`**（狀態值圖例同步新增該值）——AC-02(a)~(e) unit（MG-2 日界）／AC-06(a)(b)(d)(e)／AC-06(c)(f)（MG-1 攤平）／AC-09(a)(b)（wire 巢狀在場自證恆真化）／AC-18(b)（前端 fixture 已非真實輸出）；每列「狀態」欄逐字載明**必紅之具體斷言與行號**，供修復 Task 之紅燈物證對照。②**新增 `AC-02(e) wire 面` 一列**——`phase10-audit-query.test.ts` 之 `FW-2`／`B-07`／`B-08` 三格原僅隱含於 AC-01／AC-02 之 unit 列，日期篩選之**整合面無獨立映射落點**（與 `SPEC-REV-010-LITE` 之 `buildAuditLogWhere` 缺口同型）。③**新增 `AC-18(d)` 一列**（MG-1 值中文化裁定落地，`PENDING`／T-MG1-FE）。**修復 Task 完成後由大總管以實際 `describe`／`it` 名逐字回填並轉 `GREEN`**。
>
> `SPEC-REV-010-GATE-2`（2026-08-10）：**41 → 42 列**，兩處：①**新增 `AC-18(e)` 一列**（MG-3 內部識別碼不呈現，`PENDING`／`T-MG3-FE`；兩檔並列——`targetLabel` 面於 `AuditLogPage.test.tsx`、明細列面於 `AuditChangesList.test.tsx`）。②**AC-15 一列轉 `PENDING（Gate 修訂後待重驗）`**——`AuditLogPage.test.tsx` :374 之 `/user1#app-9/` 斷言於 MG-3 後必紅（該列「狀態」欄已逐字載明必紅斷言與行號，供 T-MG3-FE 之紅燈物證對照）。**併記既有落點缺口（不在本次射程，據實登記）**：`AuditChangesList.test.tsx` 之 `D3=(c): 中文欄名對照` describe（32 鍵守門三格，:230-298）**於本表原無獨立映射列**（其覆蓋長期隱含於 AC-18(d) 列）；本次 AC-18(e-4) 對該 describe 之強化格暫由 **AC-18(e) 列**承載，補列與否留待終審前之覆蓋核對一併處理。

---

## 13. Architecture / Data Flow 需同步項清單（**本 Phase 不修改該二檔**；結案 DOC-SYNC 批次處理）

| # | 檔案／節 | 待同步內容 |
|---|---|---|
| 1 | `ARCHITECTURE.md` §4.8 稽核 | 補「稽核檢視端點」之落點與投影語意（`changes[]` 扁平化為單一事實來源） |
| 2 | `ARCHITECTURE.md` §3 模組表 :75 `audit` 列 | 現載「稽核事件寫入與查詢」——**查詢面本 Phase 才落地**，須更新落點檔名 |
| 3 | `DATA_FLOW.md` | 新增 §「稽核檢視（唯讀）」流程（本 Spec §9.1） |
| 4 | `DATA_FLOW.md` :518 稽核紀錄列 | 補「對外投影不含內部識別值」與「管理員 only」 |
| 5 | 【依 D5】`ARCHITECTURE.md` 使用者刪除守門 | 六條 RESTRICT FK 與 `userHasHistory` 之對應關係 |
| 6 | 【依 D11】`ARCHITECTURE.md` §4.8 | 帳號類五事件之交易語意（fire-and-forget vs 同交易）之明文記載 |
| 7 | `KNOWN_ISSUES.md` §5 PHASE-010 五項 | 逐項結清或改列 PHASE-011（依 D7 分流） |
| 8 | `CHANGELOG.md` | PHASE-010 條目 |

---

## 14. Rollback

| 情境 | 處置 |
|---|---|
| **Spec 未批准／方向翻轉** | 分支未合併，直接棄用 `phase-010` 分支；`main` 零影響 |
| **Task 層失敗** | 單一 atomic commit 還原（`git revert`）；本 Phase **全部 Task 皆為新增檔或既有檔之加法式修改**，無不可逆操作 |
| **migration 回滾** | **依 D8(a) 本 Phase 零 migration → 無回滾面**。若裁定 (b)/(c)：`AuditAction` 之新 enum 值因 PostgreSQL 限制**不可移除**，保留為未使用值屬無害（沿 PHASE-004 既有先例） |
| **`userHasHistory` 擴充（D5(a)/(c)）之回滾** | 純程式變更，`git revert` 即回復。**但回滾後三條 FK 缺口路徑重新回到 500**——須同批回復 KNOWN_ISSUES 記載 |
| **稽核資料** | 本 Phase **零稽核寫入變更**（除非 D11 裁定改變）→ 既有稽核資料零影響 |
| **【D11(b)】fire-and-forget → 同交易之回滾** | 純程式變更可 revert；**但期間若有管理操作因稽核寫入失敗而回滾（500），該操作本即未生效，資料層無殘留** |
| **前端** | 新頁面與新路由為純新增；`HomePage` 之入口為單行加法，revert 零副作用 |

---

## 15. Task Graph

> 每 Task 一律 TDD、一個 atomic commit（含 Task ID）。**規模上限（治理 §10）：單 Task ≤ 5 AC、≤ 6 檔、不得同時橫跨 FE＋BE＋DB 三層。**
> **預算依 `docs/retrospective/PHASE-009-usage.md` §2.3（PHASE-009 校準後之型態表）**，見「預算」欄並標註所引型態。**逾預算 50% 須即時回報（Stop Condition）**。

| Task | 內容 | 層 | AC（≤5） | 檔案（≤6） | Risk | 依賴 | 預算（型態／usage 帶） | 機械連動預授權 | Done When |
|---|---|---|---|---|---|---|---|---|---|
| **T1** | 稽核查詢之兩個純函式：`parseAuditLogQuery`（篩選與分頁解析）＋ `flattenAuditSummary`（`changes[]` 扁平化） | BE（純函式） | AC-02, AC-06 | `backend/src/audit/audit-query.ts`（新）、`backend/src/audit/audit-summary.ts`（新）、`backend/test/unit/audit-log-query.test.ts`（新）、`backend/test/unit/audit-summary-flatten.test.ts`（新） | **High**（稽核揭露面之單一事實來源） | — | 純函式 BE／**~110-160k** | — | 參數矩陣 B-01~B-09 逐格綠；clamp 與 400 分野正確；四種真實 `summary` 形狀（含油耗巢狀混合）逐一綠；**鍵守恆刪鍵 mutant 必紅**；零 `"[object Object]"`；兩函式零 DB／零時鐘；既有測試零弱化 |
| **T2** | 稽核查詢端點 ＋ 授權 ＋ DTO 投影 ＋ 排序分頁（含 plugin 註冊） | BE | AC-01, AC-03, AC-04, AC-05 | `backend/src/audit/routes.ts`（新，依 D1）、`backend/src/server.ts`（註冊）、`backend/src/audit/audit-query.ts`、`backend/test/integration/phase10-audit-query.test.ts`（新）、既有 contract 測試檔（`ErrorCode` 聯集） | **High**（授權 ＋ 稽核揭露面 ＋ 公開 API contract） | T1 | 接線端點（授權矩陣型）／**~230-280k** | ✅ `ErrorCode` 聯集斷言（本 Phase 零新增碼，須確認不變） | 五格授權逐格綠；`403` 早於 `400` 側信道綠；七鍵 `toEqual` 封閉且多一鍵必紅；十個 enum 值逐一可取回；`createdAt` 同值三列跨頁不重不漏且移除 `id` 排序之 mutant 必紅；`skip`/`take` ＋ 獨立 `count` 結構斷言綠；**查詢端點零寫入**；既有測試零弱化 |
| **T3** | 稽核完整性回歸（七類事件 ＋ 代操作兩類 ＋ 密碼與敏感資料雙面掃描） | BE（測試為主） | AC-07, AC-08, AC-09 | `backend/test/integration/phase10-audit-completeness.test.ts`（新） | **High**（稽核可追溯性之最終守門） | T2 | 揭露面／矩陣密度型／**~160-230k**（七類 × 端到端，取上緣） | — | 七類逐類綠且**負向對照在場**（本人自建草稿零稽核）；作廢兩身分與修正版三向邊界逐一綠；`assertNoSensitiveContent` 對 DB 全表 ＋ wire 面雙綠；`USER_PASSWORD_RESET` 之封閉單鍵加鍵 mutant 必紅；**全程真實 HTTP 端點，零 `auditLog.create` 直寫**；既有測試零弱化 |
| **T4** | 結構性防腐：稽核寫入站點白名單 ＋ enum 對照封閉 ＋ 標籤表涵蓋 ＋ 不可變性掃描 | BE（測試為主） | AC-10, AC-11 | `backend/test/integration/phase10-audit-structure.test.ts`（新） | Medium（**若 D8 裁定新增 enum 則升 High**） | T2, T7（標籤表） | 重 Lite／複合修復／**~115-215k** | ✅ 依 D8：若新增 enum 值 → `enumLabels("AuditAction")` **4 處** ＋ `phase9-migration-safety.test.ts` (e) 一處，合計 5 處預授權 | 白名單 5 檔／13 呼叫實查相符且新增檔必紅；**掃描器自帶三型規避探針**（enum 成員／跨行／變數間接——PHASE-009 T2 SF-2 教訓）；enum 10 值封閉；標籤表涵蓋全 10 值且漏一值必紅；`auditLog.update/delete/upsert` 零命中且插入 mutant 必紅；既有測試零弱化 |
| **T5** | AD-US-04 有歷史拒刪完整回歸 ＋ FK 守門補齊（依 D5） | BE | AC-12, AC-13, AC-14 | `backend/src/users/history.ts`、`backend/src/admin/routes.ts`、`backend/test/integration/phase10-user-delete-regression.test.ts`（新） | **High**（不可逆操作 ＋ 使用者可見行為 ＋ 資料保存） | — | 重 Lite／複合修復**上緣**／**~150-215k**（**方法論風險加成**，見 §11.6） | — | **首步 spike**：`information_schema` FK 列舉可行性（失敗即改 migration.sql 字面掃描，據實記入 Handoff）；五類歷史逐類 `409` ＋ 零刪除（`VOIDED` 經真實作廢端點）；零歷史 `200` ＋ `USER_DELETED`；**三條缺口路徑修復前之 500 紅燈物證記入 Handoff**，修復後 `409`；六條 FK 與守門表集合之機械相符斷言綠；既有 `admin-users.test.ts`／`phase4-reference-protection.test.ts` 零弱化 |
| **T6** | 前端：API client ＋ 稽核變更清單元件（呈現安全） | FE | AC-18 | `frontend/src/api/audit.ts`（新）、`frontend/src/types/api.ts`（型別）、`frontend/src/components/AuditChangesList.tsx`（新）、`frontend/test/AuditChangesList.test.tsx`（新） | Medium | T2 | FE 頁面（單元件型）／**~110-195k** | — | XSS 三型正負向綠且 DOM 零新增 `<script>`；**巢狀混合 `summary` 之 `[object Object]` 負向自帶於前端**；時間在地化單一形式且同頁不並存 ISO；`credentials:"include"` 沿既有慣例；既有前端測試零弱化 |
| **T7** | 前端：稽核檢視頁（路由／入口／列表／篩選／分頁／五態） | FE | AC-15, AC-16, AC-17 | `frontend/src/pages/AuditLogPage.tsx`（新）、`frontend/src/App.tsx`（路由）、`frontend/src/pages/HomePage.tsx`（入口）、`frontend/test/AuditLogPage.test.tsx`（新）、`frontend/test/HomePage.test.tsx`（既有擴充）、`frontend/src/index.css` | Medium | T6 | FE 頁面型／**~140-195k** | — | 管理員入口正負向逐一；四要素逐列；篩選變更重置頁次；分頁邊界停用；**參數確實送後端**（前端零自行過濾之結構斷言）；五態逐格且 Empty 與 Permission denied 文案可區辨；既有 `HomePage.test.tsx` 零弱化；**〔SF-1 裁定 2026-08-09 追加，落於修復 Task `T7R`〕`actorId`／`targetId` 兩篩選欄為使用者下拉（選項文字＝顯示名稱、送出值＝id、清單來自 `apiGetUsers`），且頁面零純文字 id 輸入欄（AC-16(d)）** |
| **T8** | E2E Gate：稽核頁端到端 ＋ 375px | E2E | AC-19 | `e2e/audit-log.spec.ts`（新） | Medium | T7 | E2E Gate／**~150-265k** | — | 建帳號與作廢兩事件於稽核頁可見且四要素正確；篩選收斂；第 2 頁零重複；375px 零溢位；播種冪等；既有 50 條 E2E 零弱化 |
| **T9** | 【條件，依 D6】error-handler 兜底洩漏面收斂 | BE | AC-21 | `backend/src/platform/error-handler.ts`、`backend/test/integration/phase10-error-handler-leak.test.ts`（新）、`backend/test/integration/error-handler.test.ts`（既有，零弱化確認） | Medium | — | 小型接線／合約批次／**~110-170k** | — | 修復前反向探針必紅之物證；白名單掃描綠且新增站點必紅；`500` wire body 逐位元組不變；既有 `error-handler.test.ts` 全綠零改動 |
| **T-MG1-BE1** | 【Mock Gate 修復，依 **MG-1** 裁定】後端智能攤平：(b-0) 巢狀前後版本逐子欄拆列 ＋ (b-1) `{from,to}` 拆兩欄 ＋ 鍵守恆改集合相等 | BE | AC-06 | `backend/src/audit/audit-summary.ts`、`backend/test/unit/audit-summary-flatten.test.ts`、`backend/test/integration/phase10-audit-completeness.test.ts` | **High**（稽核對外揭露面之單一事實來源 ＋ 公開 API 之 `changes[]` 契約語意變更） | —（可與 BE2 併行；零檔案交集） | 揭露面／複合修復／**~130-190k** | ✅ `phase10-audit-completeness.test.ts` 之 wire 掃描「巢狀在場自證」判別式（:1439）——(b-0) 生效後恆真，**同批改寫為子鍵列判別**為預授權範圍（沿 T11b／R1b 先例） | **先取紅燈物證**（現行 fixture 對新 AC 之失敗輸出記入 Handoff）；B-12／B-26／B-27／B-28 四格逐格綠；鍵守恆之**刪頂層鍵**與**刪子鍵**兩類 mutant 皆必紅；`{from,to}` 輸出 `'{"from":…}'` 之 mutant 必紅；零 `"[object Object]"` 全域負向維持；`audit-summary.ts` **維持零 import／純函式**（AC-06(e) 結構斷言不得弱化）；`backend/src` 之 diff **僅限** `audit-summary.ts`；既有測試零弱化（**刪除既有 `it`／`expect` 行數須為 0，逐格說明改寫理由**） |
| **T-MG1-BE2** | 【Mock Gate 修復，依 **MG-2** 裁定】日期篩選改台灣日曆日：`parseAuditLogQuery` 之兩個日界平移 −8h | BE | AC-02 | `backend/src/audit/audit-query.ts`、`backend/test/unit/audit-log-query.test.ts`、`backend/test/integration/phase10-audit-query.test.ts`、`backend/test/unit/audit-log-where.test.ts`（記載對齊） | **High**（**使用者可見行為變更** ＋ 公開 API 之 query 語意變更） | —（可與 BE1 併行；零檔案交集） | 小型接線／合約批次／**~110-170k** | ✅ ①`audit-log-query.test.ts` 之 4 處 UTC 字面日界斷言（`B-07` :326-327、跨月跨年閏日 `it.each` :355-362、單端 :368-374、契約全欄 :118-119）②`phase10-audit-query.test.ts` 之四個毫秒級 fixture 常數（:220-223）——**兩者同批重錨定為台北日界字面**為預授權範圍 | **先取紅燈物證**（FW-2／B-07 兩格在現行 fixture 下之失敗輸出記入 Handoff）；B-07／B-29 逐格綠且**以 UTC 日界實作之 mutant 於 B-29 必紅**；固定 +8h **不引入任何時區套件**（N-6 零新增依賴）；`buildAuditLogWhere` **零程式變更**（`gte`／`lt` 用法不動）；`audit-log-where.test.ts` 僅改 fixture 字面與敘述、**零斷言增刪**；`backend/src` 之 diff **僅限** `audit-query.ts`；既有測試零弱化 |
| **T-MG1-FE** | 【Mock Gate 修復，依 **MG-1** 裁定】前端值層中文化 ＋ 欄名表補 `kmPerLiter` ＋ 巢狀 fixture 對齊新契約 | FE | AC-18 | `frontend/src/components/AuditChangesList.tsx`、`frontend/test/AuditChangesList.test.tsx`（另 `frontend/test/AuditLogPage.test.tsx` 僅於其 fixture 含巢狀 `changes` 時觸及——派工時實查） | Medium | **T-MG1-BE1**（契約先定） | FE 頁面（單元件型）／**~110-160k** | ✅ `REQUIRED_SUMMARY_FIELDS` 覆蓋守門常數 **31 → 32**（新增 `kmPerLiter`）＋ 其定義改為「`changes[].field` 可能值全集」 | 枚舉四類 ＋ 布林兩值逐值中文（**依欄位限定映射**，非全域字面替換）；**防誤譯格**：作廢原因等自由文字逐字不被映射；未知值原樣顯示不崩；14 值覆蓋守門刪值 mutant 必紅；32 鍵欄名覆蓋守門刪鍵 mutant 必紅；巢狀 fixture 改為子鍵四列形且**與後端真實輸出同型**（以 BE1 之單元測試 fixture 為抄錄來源，不自行虛構）；AC-18(a)(b)(c) 三項既有守門**逐條仍綠且零弱化** |
| **T-MG3-FE** | 【Mock Gate 第二輪修復，依 **MG-3** 裁定】內部識別碼不呈現：①頁面列 `targetLabel` 只取 `#` 前段（含顯示名稱去重比較改以裁切後值為準）②明細表濾除 `applicationId`／`revisionOf` 兩列 ＋ 隱藏欄封閉集合守門 ＋ 32 鍵守門鑑別力補強 | FE | AC-18(e)（連動 AC-15(c) 一格重錨定） | `frontend/src/pages/AuditLogPage.tsx`、`frontend/src/components/AuditChangesList.tsx`、`frontend/test/AuditLogPage.test.tsx`、`frontend/test/AuditChangesList.test.tsx`（**4 檔**） | Medium（顯示層；**`backend/src` 零 diff**） | —（三個 MG-1／MG-2 修復 Task 皆已 DONE） | FE 頁面（單元件型）／**~110-160k** | ✅ ①`AuditLogPage.test.tsx` :374 之 `/user1#app-9/` 斷言**重錨定**為「只見 `user1`」＋「`#app-9` 零命中」正負向（**不得刪格**）②`AuditChangesList.test.tsx` :232-242 之 32 鍵守門格**就被隱藏之兩鍵**改以 `FIELD_LABELS`／`fieldLabel()` 為斷言對象（(e-4)；必要時於元件 export 該表或其查表函式——**屬既定架構內之內部技術細節**）。**兩處皆為機械連動預授權範圍，逐格說明改寫理由** | **先取紅燈物證**（`AuditLogPage.test.tsx` :374 之現行失敗輸出記入 Handoff）；(e-1)(e-7) 四格＋(e-2)~(e-5) 五格逐格綠；**過濾過寬之防護格在場**（其餘 30 鍵之列逐列照常渲染）；隱藏欄常數「刪一鍵／多一鍵」mutant 必紅；**(e-4) 鑑別力自證**——刪 `FIELD_LABELS` 之 `applicationId`／`revisionOf` 任一鍵 mutant 必紅；`FIELD_LABELS` **維持 32 鍵**（刪任一條目即為守門弱化）；AC-18(a)(b)(c)(d) 四項既有守門**逐條仍綠且零弱化**；AC-16(d) 之下拉送出值仍為 id（**不得**因本 Task 改動）；`backend/src` diff **必須為 0**；既有測試零弱化（**刪除既有 `it`／`expect` 行數須為 0**） |
| **T10** | 【條件，依 D7】技術債收斂批次（D-2／D-3 ＋ R-4／R-5） | BE | AC-22 | `backend/src/applications/routes.ts`、`backend/src/reports/report-service.ts`（檔頭）、`errorLabel` 三處落點（派工時實查）、既有 contract 測試檔 | Medium | — | 多項合併修復（≥4 項）／**逐項累加 ~110-200k** | — | `REPORT_GENERATION_FAILED` 改道後 wire 逐位元組（含鍵序）不變；`errorLabel` 三處收斂後行為零變更；R-4／R-5 敘述與實測相符；既有測試零弱化 |

> **AC-20（零弱化與基準線）**：不設獨立 Task——寫入**每個 Task 之 Done When**，由終審以三套件實跑數對照基準線核對。**基準線起點**：後端 **3230**／前端 **346**／E2E **50**（PHASE-009 終審實測）。

### 15.1 依賴圖

```
T1 ──▶ T2 ──┬──▶ T3
            ├──▶ T4 ◀── T7（標籤表涵蓋斷言之資料前提）
            └──▶ T6 ──▶ T7 ──▶ T8

T5（獨立；不依賴 T1~T4）
T9（條件，獨立）
T10（條件，獨立）

〔Mock Gate 第一輪修復（SPEC-REV-010-GATE 後）〕
T-MG1-BE1 ──▶ T-MG1-FE          （契約先定；BE1 之單元 fixture 為 FE fixture 之抄錄來源）
T-MG1-BE2                        （獨立，可與 BE1／FE 全段併行——零檔案交集）
        三者完成後 ──▶ reviewer ──▶ Mock Gate 第二輪 ──▶ T4／T8

〔Mock Gate 第二輪修復（SPEC-REV-010-GATE-2 後）〕
T-MG3-FE（獨立，FE only；與 T4／T8 零檔案交集，惟須排在 T8 撰寫之前——見下方 T8 連動）
        完成後 ──▶ reviewer（可輕量）──▶ MG-3 小範圍目視 ──▶ T4／T8
```

> **T4 之排程約束**：AC-10(c)（前端標籤表涵蓋全 10 值）之被測對象由 T7 產出，故 **T4 須排在 T7 之後**；若大總管希望提早結清結構面，正解為**拆出 `T4a`**（後端面：站點白名單 ＋ enum 封閉 ＋ 不可變性，可緊接 T2）與 **`T4b`**（標籤表涵蓋，排 T7 後），**不得**以壓縮斷言換取排程。
> **T5 可與 T1~T4 全段併行**（零檔案交集：`history.ts`／`admin/routes.ts` 不被其他 Task 觸及）。
> **T9／T10 為條件 Task**，僅於 D6／D7 裁定納入時開工；兩者與主線零檔案交集，可任意排程；**惟 T10 觸及 `applications/routes.ts`，須確認與任何其他觸該檔之工作不併行**。
> **T-MG1-BE1／BE2／FE 為 Mock Gate 第一輪之修復 Task**（依 2026-08-09 兩項裁定）。**不得同 Task 跨 BE＋FE**，故 MG-1 之後端面與前端面拆為 BE1／FE 兩 Task；MG-2 因**射程與 MG-1 完全獨立**（不同裁定、不同檔案、不同 AC）而獨立為 BE2，三者合計 **9 檔**、單 Task 最多 **4 檔**，皆在規模上限內。
> **與 Packet 建議之差異（據實記錄）**：Packet 建議之單一 `T-MG1-BE`（`audit-summary.ts` ＋ `audit-query.ts` ＋ 兩單元測試檔）**未計入兩個必然連動之整合測試檔**（`phase10-audit-completeness.test.ts`／`phase10-audit-query.test.ts`，見下方「受衝擊測試面」），合計將達 6~7 檔且**一個 atomic commit 內混入兩項互不相干之裁定**。故改拆為 BE1（MG-1 後端）／BE2（MG-2）兩 Task——**兩裁定各自可獨立回滾**，且可併行。
> **T4 之連動**：AC-10(c)「前端標籤表涵蓋全 10 值」之被測對象為 `action` 標籤表（`AuditLogPage`），**不含**本次新增之欄名／值映射表；惟 T-MG1-FE 之兩具覆蓋守門常數（32 鍵欄名／14 值枚舉）與 T4 之結構掃描同族，**T4 派工時須確認三具守門互不重複亦互不遺漏**（避免第四份複本——期中複審 #2 FW 已列此項）。
> **T8（E2E）之連動**：`e2e/audit-log.spec.ts` 尚未實作（`PENDING`），故本次修訂**零 E2E 衝擊**；惟 T8 撰寫時之列表期望值須以**修訂後**之呈現形式為準（子欄拆列 ＋ 中文值），Packet 須明載。**`SPEC-REV-010-GATE-2` 追加**：T8 之期望值另須含 MG-3 之呈現形式——**畫面不得出現任何 `#` 後之內部編號、亦不得出現「申請編號」／「修正自申請編號」兩列**；受影響資料之比對一律以**帳號段**為準（**不得**以 `帳號#編號` 全字串比對，該寫法將於 MG-3 後必失敗）。故 **T8 須排在 T-MG3-FE 之後**。

**TDD 順序建議**：T1（純函式先立單一事實來源）→ T2（端點與授權）→ T3（完整性回歸）／T5（AD-US-04，可併行）→ T6（前端元件）→ T7（前端頁面）→ T4（結構防腐，收口）→ T8（E2E Gate）→〔T9／T10 條件 chore 收尾〕。

### 15.2 規模上限自查

| Task | AC 數 | 檔數 | 跨層 | 合規 |
|---|---|---|---|---|
| T1 | 2 | 4 | BE only（純函式） | ✅ |
| T2 | 4 | 5 | BE only | ✅ |
| T3 | 3 | 1 | BE only（測試為主） | ✅ |
| T4 | 2 | 1 | BE only（測試為主） | ✅（惟排程須排 T7 後；逾規模時正解為拆 T4a／T4b） |
| T5 | 3 | 3 | BE only | ✅ |
| T6 | 1 | 4 | FE only | ✅ |
| T7 | 3 | 6 | FE only | ⚠ **貼上限**（檔數恰 6）——**若實作時逾規模，正解為拆出 `T7b`（`HomePage` 入口 ＋ `App.tsx` 路由）而非壓縮測試** |
| T8 | 1 | 1 | E2E only | ✅ |
| T9 | 1 | 3 | BE only | ✅ |
| T10 | 1 | ≤6（派工時實查） | BE only | ✅ |
| **T-MG1-BE1** | 1 | 3 | BE only | ✅ |
| **T-MG1-BE2** | 1 | 4 | BE only | ✅ |
| **T-MG1-FE** | 1 | 2（+1 條件） | FE only | ✅ |
| **T-MG3-FE** | 1（AC-18(e)） | 4 | FE only | ✅ |

> **無任何 Task 同時橫跨 FE＋BE＋DB 三層。** 依 D8(a)，本 Phase **無任何含 schema／migration 之 Task**。**T3／T4 為純測試 Task**（`backend/src` 零 diff），其 Done When 須明載該零 diff 事實以防夾帶。

### 15.3 與 PRD §PHASE-010「初始 Task Graph 概要」之對照

| PRD Task | 本 Spec 落點 | 說明 |
|---|---|---|
| T1 稽核查詢端點（僅管理員、篩選、前後摘要呈現）（**High**） | **T1 ＋ T2** | 拆分為二（純函式／端點與授權——規模上限；「前後摘要呈現」之演算法落於 T1 之 `flattenAuditSummary`） |
| T2 回歸：確認各事件寫入齊備、密碼不入稽核（**High**） | **T3 ＋ T4** | 拆分為二（端到端齊備回歸／結構性防腐掃描）。**T4 為 PRD 未列之新增**——防腐掃描源自跨 Phase 追蹤 #10 與 PHASE-009 之既有守門紀律 |
| T3 AD-US-04 有歷史拒刪回歸（**High**） | **T5** | 一致；另納入 FK 守門缺口之處置（依 **D5**，PRD 未預見） |
| T4 前端稽核檢視頁 | **T6 ＋ T7 ＋ T8** | 拆分為三（元件／頁面／E2E） |
| （PRD 未列） | **T9**（條件）、**T10**（條件） | 跨 Phase 移交之收尾，依 **D6**／**D7** 裁定 |

**High 風險 Task 清單（須於 Spec Gate 一併取得事前批准）**：**T1、T2、T3、T5**——**四項**。
> 與 PRD「High 風險 Task：T1, T2, T3」之差異說明：PRD 之三項對應本 Spec 之 T1/T2（查詢端點）、T3/T4（回歸）、T5（AD-US-04），**全數涵蓋**。本 Spec 將 **T4 降為 Medium**（純測試掃描、`backend/src` 零 diff、無授權與資料面影響）並將 **T1 升為 High**（`flattenAuditSummary` 為稽核對外揭露面之單一事實來源，錯誤即造成敏感資料揭露或稽核失真）。**此調整之淨效果為 High 項目由 3 增為 4（保守方向）**；`CLAUDE.md`「認證、授權、密碼、附件權限相關工作一律 High」之判準於 T2（授權）與 T5（不可逆刪除）明確適用。
> **若 D8 裁定 (b)/(c)（新增 enum 值）**：T4 因含 `ALTER TYPE` migration 而**升為 High**，High 清單增為五項——請人類於 Gate 一併批准。
> **【`SPEC-REV-010-GATE` 追加——需大總管處置之批准項】** 修復 Task **T-MG1-BE1**（稽核揭露面之 `changes[]` 契約語意變更）與 **T-MG1-BE2**（**使用者可見之篩選行為**變更）依 `CLAUDE.md` 與本節判準均為 **High**，原則上須**事前批准**。spec-writer **不自行定案**，列兩條路徑供大總管擇一並記錄：**(i)** 以 **2026-08-09 兩項 Mock Gate 裁定原文為批准依據**（該裁定已明示修法方向、影響面與已知限制代價，實質等同事前批准）——推薦，零額外 Gate 往返；**(ii)** 另取人類逐句確認。**無論何者，AC-06(b-0) 之「一側為 `null`（油耗首版）」擴張條款**（來源標記＝**既有語意擴張**）**必須於 Human Gate 確認清單獨立列出**（治理 2026-08-03.1），不得與裁定落地項混列；若人類否決，退回「兩者皆為物件才拆」之嚴格版。

### 15.4 Gate 規劃與走查腳本固化義務（跨 Phase 常設規則）

| Gate | 觸發時點 | 內容 | 走查腳本 |
|---|---|---|---|
| **Spec Gate（事前批准）** | 本 Spec 定稿後、任何 Task 開工前 | **D1~D12 逐條裁定** ＋ **4 項 High Task 事前批准** ＋ **3 列條件 AC 之取捨** ＋ **來源類別為「既有語意擴張／建議新增」之 AC 逐項確認**（§0.2 末段清單） | `docs/verification/WALKTHROUGH-PHASE-010-SPEC-GATE.md`（**本 Task 一併產出**） |
| **Mock Gate（稽核列表／篩選）** | T7 完成後（E2E 可先不完備） | 人類目視：列表四要素之可讀性、`changes` 前後摘要之呈現形式（**AD-US-14③ 之驗收核心**）、`action` 中文標籤逐值確認、篩選與分頁互動、長作廢原因之版面、375px 可讀、五態文案 | `WALKTHROUGH-PHASE-010-MOCK.md`（大總管於 T7 前產出） |
| **Mock Gate 第二輪**（`SPEC-REV-010-GATE` 追加） | 三個修復 Task（T-MG1-BE1／BE2／FE）完成 ＋ reviewer 複審清零後 | **第一輪兩項反饋之逐項驗收**：①MG-1——`{from,to}` 與油耗巢狀之「欄位／改前／改後」三欄是否**內容對得上**、枚舉值與是/否是否**中文可讀**；②MG-2——**篩 8/7~8/8 即台灣時間之 8/7 00:00~8/8 23:59**，畫面不再出現 8/9 之列。**併須確認之擴張項一條**：油耗**首版**（無前一版）之列是否亦逐子欄拆列、改前欄顯示「—」（AC-06(b-0) 之既有語意擴張半邊，§0.2 已獨立列出） | `WALKTHROUGH-PHASE-010-MOCK.md`（大總管更新第二輪檢核項與素材前提——**素材須含油耗首版一列**，否則該擴張項無從目視） |
| **MG-3 小範圍目視**（`SPEC-REV-010-GATE-2` 追加；人類 2026-08-10 裁定末句逐字：「修復後小範圍目視即結」） | `T-MG3-FE` 完成 ＋ reviewer（可輕量）複審清零後 | **MG-3 兩處之逐項驗收**：①列標題「受影響資料」只見帳號（含顯示名稱），**畫面無 `#` 後編號**②明細表無「申請編號」／「修正自申請編號」列。**併須確認之延伸判讀一條**：**參數型 `targetLabel`**（`FUEL_PRICE#<cuid>` 等）之 `#` 後段亦一併隱藏、僅見 `FUEL_PRICE`／`ETC`／`DEPRECIATION`（AC-18(e-1) 之延伸，§18 已獨立列出）。**併須揭露之兩項後果**：①修正版代建立之「修正自」關係在畫面上不再可辨識（僅餘「申請類型」一列）②參數型前綴仍為英文字面、且 `loginName` 含 `#` 之帳號會被截於首個 `#`（§17.1 #12） | `WALKTHROUGH-PHASE-010-MOCK.md`（大總管追加 MG-3 檢核項；素材沿用第二輪播種——**須含一筆修正版代建立列與一筆參數異動列**，否則兩項無從目視） |
| **整合 Gate（端到端）** | 全 Task 完成 ＋ reviewer 清零後 | 容器內：真實執行一次管理操作與一次作廢 → 稽核頁確認可查；AD-US-04 拒刪之真實畫面；權限拒絕之真實畫面 | `WALKTHROUGH-PHASE-010-INTEGRATION.md` |
| **PR 合併批准** | 整合 Gate 通過後 | 人類決策，不授權代行 | — |

---

## 16. 需人類批准之決策點（D1 ~ D12）

> 每條格式：**為什麼要決定** ｜ **選項** ｜ **各選項影響** ｜ **推薦**。
> **spec-writer 不得自行定案任一條。**

### D1 — 稽核查詢端點之路由形狀與模組落點　**【公開 API contract】**

**為什麼要決定**：新增對外端點屬公開 contract；落點影響既有檔案規模與 plugin 註冊順序。

**選項**
- (a) `GET /admin/audit-logs`，落於既有 `backend/src/admin/routes.ts`。
- **(b) `GET /admin/audit-logs`，落於新檔 `backend/src/audit/routes.ts`**（新 `auditPlugin`，於 `server.ts` 註冊）。
- (c) `GET /audit-logs` ＋ `requireAdmin`（不帶 `/admin` 前綴）。

**影響**
- (a)：零新 plugin；但 `admin/routes.ts` 實查已 **723 行**且含五個帳號端點 ＋ 三個代建端點，再加查詢與投影邏輯會使單檔責任過雜。
- (b)：`backend/src/audit/` 目錄已存在（現僅 `audit.ts`），寫入與查詢同域內聚；沿 `users/fuel-consumption-routes.ts`（343 行，獨立子域自有 routes 檔）之既有先例；代價＝`server.ts` 多一次 `register`。
- (c)：路徑不帶 `/admin` 會與「僅管理員」之語意脫鉤，且與既有 `/admin/users`、`/admin/parameters` 慣例不一致。

**推薦**：**(b)**。

---

### D2 — 篩選維度之集合　**【公開 API contract ＋ 使用者可見行為】**

**為什麼要決定**：`userstory.md` AD-US-14 **未要求任何篩選**；「篩選」二字之唯一出處為 `docs/PRD.md` :509 之 UI 驗收。維度集合屬 PRD 授權範圍內之設計裁量，須人類定範圍。

**選項**
- (a) 最小集：`action` ＋ `page`／`pageSize`。
- **(b) (a) ＋ `dateFrom`／`dateTo` ＋ `actorId`／`targetId`。**
- (c) (b) ＋ `keyword`（對 `targetLabel` 模糊比對）。

**影響**
- (a)：實作最小；但「查某位使用者身上發生過什麼」為稽核之最常見需求，無法滿足。
- (b)：四個維度皆有既有索引支撐（`actorId`／`targetId`／`createdAt` 三索引實查在場），**零新增索引**；前端需一個使用者下拉（可複用 `apiGetUsers`）。
  - **〔SF-1 裁定落地——人類 leonchih 2026-08-09〕**：本影響欄之「前端需一個使用者下拉」為**已裁定之強制要求**，非選配。裁定逐字：`actorId`／`targetId` 兩篩選欄**改用使用者下拉**（顯示名稱、內部帶 id），**複用既有使用者清單 API**。理由＝**純文字 id 輸入實質不可用**——依 §6.3 與 AC-04(b)，回應**不外露** `actorId`／`targetId`，管理員無從得知可輸入之值。複用對象實查：`apiGetUsers`（`frontend/src/api/users.ts` :3），既有先例 `AdminFuelConsumptionPage.tsx` :131、`AdminUserApplicationsPage.tsx` :87。落點：**AC-16(d)**（治理 2026-08-09.1 §11：裁定內容須入 AC 條文，不得僅存於 D 項）、§15 **T7R**。
- (c)：`targetLabel` 無索引，模糊比對為全表掃描；且 `keyword` 之 LIKE 跳脫已有 PHASE-004 B-23 先例但屬額外面。效能面歸 PHASE-011 才實測，此時加入等於先欠債。

**推薦**：**(b)**。

---

### D3 — `summary`（前後摘要）之對外揭露形式　**【敏感資料揭露面 ＋ 公開 API contract ＋ AD-US-14③ 之直接落點】**

**為什麼要決定**：AD-US-14③ 要求「應可辨識修改前後的重要欄位摘要」。`AuditLog.summary` 為自由 `Json`，實查有**四種異形**（純量、`{before,after}`、含 `revisionOf` 之代建立形、油耗之巢狀混合形）。PHASE-007 T11 即審 FW 已明示：**須依 action 分支渲染否則 `[object Object]`**。此為本 Phase 之核心設計問題。

**選項**
- (a) **原樣輸出 `summary` JSON**，呈現責任全交前端。
- (b) **後端依 `action` 逐值投影**為封閉鍵集（10 個 action 各一份投影）。
- **(c) 後端以單一通用扁平化函式產生 `changes: [{field, before, after}]`**，不輸出原始 `summary`。

**影響**
- (a)：後端零工；但把 PHASE-007 FW 已警示之坑原封不動丟給前端，且**新增 `action` 或改變 `summary` 形狀時前端靜默失真**（無守門）。
- (b)：呈現最精確；但**維護面最大**——10 份投影，且新增 action 時漏投影會**靜默**輸出空白（失效模式與 AR-7 同構：保證繫於呼叫端紀律）。
- (c)：一份純函式涵蓋全部異形，對未知 `action` **天然可用**（不需逐值枚舉）；鍵守恆斷言（AC-06(d)）使「漏鍵」在測試層必紅。**代價**：扁平化若有 bug，管理員看到的與 DB 存的不同——緩解＝純函式 ＋ 封閉單元測試 ＋ 鍵守恆 mutant ＋ 前端 `[object Object]` 自帶負向（AC-18(b)）。另：`field` 為英文鍵名（如 `annualTotalKm`），可讀性略遜於 (b) 之中文標籤。

**推薦**：**(c)**。**併記**：若人類重視欄位中文可讀性，可於 **(c) 之上**加一層「英文鍵 → 中文標籤」對照表於**前端**（缺表時原樣顯示英文鍵，不崩），成本低且不影響後端契約——此為 (c) 之可選增強，建議一併裁定是否納入。

> **〔Mock Gate 第一輪實測反饋——人類 leonchih 2026-08-09〕** D3=(c)（＋中文欄名）之**通用扁平化輸出形式**經真實資料目視後**未通過**：`{from,to}` 兩鍵物件與油耗巢狀前後版本皆被 `JSON.stringify` 整包塞入「改後」欄，改前欄恆空、值為英文原文，「改前→改後」之語意在最需要它的兩類事件上落空（即本 D 項影響欄 (c) 所預告之代價於實測中兌現）。**修法裁定＝「智能攤平＋值中文化」**：在**不改** (c) 之單一通用函式架構前提下，增設兩條形狀分派規則（AC-06(b-0)／(b-1)）與前端值層中文化（AC-18(d)）。**本 D 項之裁定 (c) 未被推翻**（仍為單一通用扁平化、仍不輸出原始 `summary`），推翻的是其**輸出形式之充分性**；上文「`field` 為英文鍵名，可讀性略遜」一句之射程**擴及值層**，緩解手段同為前端對照表。**此為已批准項經 Gate 實測後之正當反饋，非重議違規。**

---

### D4 — 稽核紀錄之可見範圍　**【High：授權 ＋ 敏感資料】**

**為什麼要決定**：US 之兩條稽核故事皆為管理員／系統視角，但「使用者可否看到自己被誰動過什麼」是合理的產品問題，須明示。

**選項**
- **(a) 管理員 only。**
- (b) 使用者可見「`targetId` ＝ 自己」之稽核列。

**影響**
- (a)：與 US 字面一致；授權面最單純（5 格矩陣）；PHASE-009 T4 FW-E「授權不低於申請」自然滿足。
- (b)：屬**新增使用者可見行為**（US 未要求）；且 `summary` 含管理員之操作意圖與內部識別值，揭露面需重新盤點；授權矩陣由 5 格擴為 ≥8 格。

**推薦**：**(a)**。

---

### D5 — AD-US-04 之 FK `ON DELETE RESTRICT` 三條未覆蓋路徑之處置　**【High：不可逆操作 ＋ 使用者可見行為 ＋ 資料保存】**　★ **本 Phase 最重要之決策**

**為什麼要決定**：spec-writer 實查發現——指向 `User` 之 `ON DELETE RESTRICT` FK 共 **6 條**，`userHasHistory` 只查 **2 條**。其餘三條（`AuditLog.actorId`、`Attachment.uploaderId`／`ownerId`、`Application.createdById`）於真實觸發時使 `prisma.user.delete` 拋 P2003 → 落 `error-handler.ts` 分支 4 → **`500 INTERNAL_ERROR`**。AD-US-04② 要求「**拒絕並提供停用選項**」，`500` 不滿足該要求。此缺口在 PHASE-009 T10 即審已以「低度記錄」登記，本 Phase 為其到期日。

**選項**
- (a) **擴充 `userHasHistory` 為六條 RESTRICT 全查**（任一有列即 `409`）。
- (b) **維持兩查，於 `DELETE` 端點 catch P2003 → `409`** 同文案。
- **(c) (a) ＋ (b) 併用**（守門 ＋ 兜底）。
- (d) 不處理，將三條路徑之 `500` 明列為已知限制。

**影響**
- (a)：語意最正確（`409` 由守門產生，非由錯誤兜底）；**但須人類明確知悉其後果——凡「曾建立過任何帳號」之管理員即成為 `AuditLog` 之 actor，因而永久不可刪除**。這是稽核不可刪除性的必然推論，但屬「不可刪範圍擴大」之使用者可見行為變化。另：`Attachment` 之 `TEMP` 態附件於 PHASE-011 清理排程落地後會自動消失，屆時該條之阻擋自然放寬。
- (b)：改動最小（一個 catch）；但 `409` 文案「此帳號已有資料」對「只有稽核紀錄」之帳號**語意略失準**；且守門與實際約束仍不一致（`userHasHistory` 回 `false` 卻刪不掉）。
- (c)：守門正確 ＋ 兜底覆蓋任何未來新增之 RESTRICT FK；**縱深防禦**，與本專案既有紀律（AC-14(a) 之機械完整性斷言）相配。代價＝改動面最大（兩檔）。
- (d)：`500` 續存。**對 High 風險之稽核 Phase 而言，把「US 明文要求之拒絕語意」留在 500 不建議**；且 PRD :505 明文「AD-US-04 的完整回歸亦在此確認」。

**推薦**：**(c)**。**併記（須人類明示知悉）**：採 (a)/(c) 後，**實務上絕大多數曾操作過系統的管理員帳號將不可永久刪除，只能停用**——這正是 AD-US-04② 之設計意圖（有歷史即拒刪、改用停用），但請確認符合您的預期。若您認為「管理員應可被刪除」，則正解**不是**放寬本守門，而是另立 Phase 討論「稽核列之 actor 匿名化」（屬資料保存決策，本 Phase 不處理）。

---

### D6 — D-1（error-handler 兜底洩漏面）是否納入本 Phase　**【範圍 ＋ 安全縱深】**

**為什麼要決定**：PHASE-009 終審裁定「KNOWN_ISSUES 記錄即可不阻擋，同時列 PHASE-010 新 AC 候選」。納入即擴大範圍；不納入則縱深缺口續存。**且終審原給之四段草案本文於 repo 內查無留存**（見卷首資訊缺口 #1）。

**選項**
- **(a) 納入為條件 Task T9**，四段 AC 依 §2 H 段（spec-writer 重建版）。
- (b) 不納入，續留 `KNOWN_ISSUES.md` D-1。
- (c) 納入但僅做 (c) 反向探針與 (b) 白名單掃描（**不改** `error-handler.ts` 之日誌內容）——即「只建守門不改行為」。

**影響**
- (a)：安全縱深收斂；今日為零活路徑故**零行為風險**；成本 ~110-170k。**風險**：四段內容為 spec-writer 重建，可能與終審原意有出入。
- (b)：缺口續存至 PHASE-011；`KNOWN_ISSUES` D-1 續列。
- (c)：零行為變更、成本更低；但缺口本身未收斂（只是被觀測）。

**推薦**：**(a)**，**但請人類於 Gate 確認四段內容**（若您記得終審原案與此不同，請以原案為準，spec-writer 將修訂）。若不確定，選 **(c)** 為安全折衷。

---

### D7 — 技術債收斂（KNOWN_ISSUES §3 D-2／D-3／D-5／D-6／D-7 ＋ §4 R-4／R-5）之納入範圍　**【範圍】**

**為什麼要決定**：`KNOWN_ISSUES.md` §5 將五項列為 PHASE-010 移交。全數納入會顯著擴大範圍；全不納入則持續累積。

**選項**
- (a) 全數納入。
- **(b) 分流**：納入 **D-2**（`REPORT_GENERATION_FAILED` 形狀分歧）、**D-3**（`errorLabel` 三份收斂）、**R-4／R-5**（記載型更正）；**D-5／D-6／D-7 明列不納並移 PHASE-011**。
- (c) 全數不納入。

**影響**
- (a)：D-6（`e2e/` 接入 typecheck）實查有 **76 個既有型別錯誤**，修復量**不可預估**——屬方法論風險型工作，與本 Phase 之稽核主線零關聯；D-5（E2E helper 抽取）觸及全部 12 個 E2E 檔，與 T8 之新 E2E 檔並行時衝突面大；D-7（XSS 15 格字面／掃描器 pattern／fingerprint 收斂）為 Low 純測試面重複，收斂收益低於觸檔風險。
- (b)：D-2／D-3 皆為**單檔葉節點、零行為變更**，可安全收斂；R-4／R-5 為零斷言影響之記載更正。D-5／D-6 與 PHASE-011（部署硬化、CI 面）同域，移交合理且有依據。
- (c)：與「觸檔必補」紀律相衝（T10 若成立即觸 `applications/routes.ts`，R-5 正在該檔）。

**推薦**：**(b)**。**併記**：若人類希望壓到最小範圍，可再退為「僅 R-4／R-5 記載型更正」（成本 ~55-90k 輕 Lite），D-2／D-3 移 PHASE-011。

---

### D8 — `AuditAction` enum 收斂議題之結論（PHASE-008 D15／PHASE-009 D10 之續議）　**【稽核可追溯性 ＋ migration 型態 ＋ 本 Phase 是否有 migration】**

**為什麼要決定**：此議題自 PHASE-008 D15 起延宕兩個 Phase，`PROJECT_STATE.md` §13#11③ 明列「本 Phase 再議」。結論直接決定本 Phase **是否有 migration**。

**選項**
- **(a) 維持現況 10 值，零新增。**
- (b) 新增 `APPLICATION_REVISION_CREATED`（使修正版與一般代建立可區分）。
- (c) 新增 `REPORT_GENERATED`（報表產生留痕）。

**影響**
- (a)：**實查佐證**——AD-US-14① 之七類事件對現行 10 值之對照表（§6.2）**零缺漏**；本 Phase **零 migration**，T4 維持 Medium，機械連動零觸發。修正版與一般代建立之區分已由 `summary.revisionOf` 提供（PHASE-009 D10(a) 已裁定之設計）。
- (b)：稽核頁可直接以類型區分修正版；但 `summary.revisionOf` 已足，且新增值使本 Phase 由零 migration 變為含 `ALTER TYPE`（沿 FW-8 raw SQL fixture 處置），**T4 升 High、預算取上緣、機械連動 5 處**。收益低於成本。
- (c)：「報表產生」US 從未列為須稽核之事件（PHASE-008 D15(a) 已據此裁定不新增）；本 Phase 無新證據推翻該裁定。

**推薦**：**(a)**——並建議於 Gate 將此議題**正式結案**（不再逐 Phase 續議），未來若 US 新增事件再議。

---

### D9 — 稽核列表之時間呈現形式　**【使用者可見行為】**

**為什麼要決定**：PHASE-008 T12~T13 即審 SF-2 曾出現「ISO8601（UTC）與 `toLocaleString("zh-TW")` 上下相鄰並排不一致、對非技術使用者不可讀」之 Mock Gate 裁定項。本 Phase 為時間欄密度最高之頁面，須事前定調以免同型再犯。

**選項**
- **(a) 後端回 ISO 8601 UTC；前端以與列印版同型之台北時區在地化呈現**（沿 `report-labels.ts` :46 之 `formatTaipeiDateTime` 為唯一格式化來源之既有紀律）。　**〔本選項文字為 Spec Gate 當時之原文，保留為歷史紀錄；其「台北時區」半邊已由 SF-3 裁定（人類 leonchih 2026-08-09）修正為「使用者瀏覽器時區」——現行有效字面以 §2 AC-18(c) 為準〕**
- (b) 後端直接回在地化字串。
- (c) 後端同時回兩者。

**影響**
- (a)：契約單純（ISO 為機器可讀之單一真值）；前端在地化與列印版一致，使用者體驗統一；**須**在前端建立同型格式化（可抄 `report-labels.ts` 之邏輯或建共用 util）。
  - **〔SF-3 裁定修正——人類 leonchih 2026-08-09〕**：上句「可抄 `report-labels.ts` 之邏輯」**不再適用**。前端採**瀏覽器時區**慣例（`new Date(...).toLocaleString("zh-TW")`，與既有 8 個時間格式化落點一致——實查：`ReportSection.tsx` :161、`DepreciationApplicationPage.tsx` :623/:662、`MaintenanceApplicationPage.tsx` :601/:638、`TravelApplicationPage.tsx` :684/:765 共 7 處 ＋ `ParametersPage.formatDateYmd`（:46-53，本地時區 `getFullYear`／`getMonth`／`getDate`）），**不**移植後端之固定 +8h。列印版／PDF 之 `formatTaipeiDateTime`（`report-labels.ts` :46，固定台北）**維持不變**。故本 D 項所稱「與列印版一致」**限於格式同型**，**不含基準時區同一**；差異已明示接受並記於 §17.1 #10。落點：AC-18(c)。
- (b)：前端零工；但格式化邏輯散落後端，與既有「格式化屬呈現層」之紀律相衝，且測試須斷言中文字串（環境 ICU 相依——PHASE-009 CI TZ-FIX 事件之同族風險）。
- (c)：`AuditLogListItemDto` 多一鍵；AC-18(c) 之「同頁不並存兩形式」反而更難守。

**推薦**：**(a)**。

---

### D10 — 前端稽核頁之路由與入口　**【使用者可見行為（新頁面）】**

**為什麼要決定**：新增管理員可見之頁面與入口屬使用者可見行為。

**選項**
- **(a) 新路由 `/admin/audit-logs`；`HomePage` 管理員區塊新增「稽核紀錄」入口**（沿 `/admin/users`、`/admin/parameters` 兩個既有入口之慣例）。
- (b) 掛為 `AdminUsersPage` 之一個分頁。

**影響**
- (a)：與既有兩個管理入口對稱；路由獨立，E2E 與深連結單純。
- (b)：稽核之範圍**遠大於**使用者管理（含參數、申請、作廢），掛在使用者頁下語意不符。

**推薦**：**(a)**。

---

### D11 — 帳號類五事件之 fire-and-forget 稽核語意是否改為同交易　**【High：稽核可追溯性 ＋ 使用者可見行為】**

**為什麼要決定**：spec-writer 實查發現，`audit/audit.ts` :53-56 明文「Audit write failure must not propagate」並 catch 吞例外；`admin/routes.ts` 之五個帳號類事件皆在主操作 **COMMIT 之後**以獨立連線寫稽核。**後果：帳號新增／停用／啟用／密碼重設／刪除之稽核列可能靜默遺失，而操作本身成功**。其餘五類事件（PHASE-003a 起）皆為同交易。對「稽核完整性＝授權可追溯性」之 High 風險 Phase，此為實質不對稱。PRD :506 明文「若發現缺漏則回補」——本項是否算「缺漏」須人類判定。

**選項**
- (a) **不處理**，記為已知限制（現況；PHASE-002 之既有設計裁量）。
- (b) **將四個「單一 update」型事件改為同交易**（`USER_CREATED`／`USER_DEACTIVATED`／`USER_ACTIVATED`／`USER_PASSWORD_RESET`）；`USER_DELETED` 因刪除後 `targetId` 為 `null` 且與 **D5** 之 FK 議題耦合，**另議**。
- (c) 保留 fire-and-forget 但改為「稽核寫入失敗即回 `500`」（操作已生效但回報失敗——**最差選項**，會造成使用者重試而重複操作）。

**影響**
- (a)：零成本；但稽核可追溯性有一個靜默失效面，且與 §1 目標 #2「稽核完整性回歸」之精神相衝——回歸只能證明**正常路徑**寫入，無法證明**失敗路徑**不遺失。
- (b)：語意與其餘五類統一；**屬使用者可見行為變更**——稽核寫入失敗時管理操作整筆失敗（`500`），管理員需重試。範圍＝`admin/routes.ts` 四處 ＋ `audit.ts` 之簽章（需支援 `tx`）；風險 High（觸及授權相關端點），須另立 Task 並取得事前批准。**本 Spec 未為此預留 Task**——若裁定 (b)，spec-writer 須修訂 §15 新增一個 High Task 並重估預算。
- (c)：兩害相權最劣，僅列為完整性。

**推薦**：**(a)**（本 Phase 不處理，記入 `KNOWN_ISSUES.md` 並移交 PHASE-011 併同備份／可靠性議題評估）。**理由**：PRD :506 之「回補」條件針對的是「事件沒有稽核」，而非「稽核寫入之可靠性語意」；本項屬後者，且改動觸及**授權相關端點之失敗語意**，在以「檢視與回歸」為主軸的 Phase 內變更風險大於收益。**但 spec-writer 明確揭露：若您認為「稽核可能靜默遺失」不可接受，(b) 是正確選擇，屆時本 Spec 須修訂新增一個 High Task。**

---

### D12 — 稽核不可變性之結構守門是否納入　**【資料保存；記載型確認】**

**為什麼要決定**：現況全 `backend/src` 無任何 `AuditLog` 之 UPDATE／DELETE 呼叫（實查），但**無守門**——未來任一 Task 誤加即靜默破壞稽核不可竄改性。

**選項**
- **(a) 納入 AC-11**：結構性掃描 ＋ mutant 自證（沿 PHASE-008 `reports/` 零更新守門之既有形狀）。
- (b) 不納入。

**影響**
- (a)：**零程式變更**（純測試），成本併入 T4；防護的是稽核之根本屬性。
- (b)：保證繫於呼叫端紀律（與 AR-7／D-1 同構之失效模式）。

**推薦**：**(a)**。

---

## 17. 已知限制與跨 Phase 銜接

### 17.1 已知限制（本 Phase 明示不處理者）

1. **有油耗版本之使用者永久不可刪**（PHASE-005a D8(a) 之設計後果；`PROJECT_STATE.md` :393 指定「PHASE-010 文件記載」）：`UserFuelConsumptionVersion.userId` 為 `ON DELETE RESTRICT` 且油耗版本為 append-only（無刪除端點），故一旦建立即永久阻擋該使用者之刪除。**此為刻意設計**（歷史可重現），非缺陷。
2. **【若 D5 裁定 (a)/(c)】曾操作過系統之管理員永久不可刪**：凡成為 `AuditLog.actorId` 者即被守門阻擋。緩解＝停用。根治須「稽核 actor 匿名化」，屬資料保存決策，本 Phase 不處理。
3. **【若 D11 裁定 (a)】帳號類五事件之稽核可能靜默遺失**：`writeAudit` 為 fire-and-forget 且非同交易。今日無觀測到之實例，但為結構性可能。移交 PHASE-011 併同可靠性議題評估。
4. **稽核列表無效能保證**：`action` 欄無索引；本 Phase 不新增索引亦不做效能實測（沿 PHASE-005 D9(a)）。資料量成長後之列表延遲屬 PHASE-011 之實測範圍。
5. **稽核無保留期限與封存**：`AuditLog` 無限成長。清理／封存語意歸 PHASE-011。
6. **`summary` 之語意由各寫入端各自決定**：本 Phase 之 `changes` 扁平化為通用處理，**不驗證** `summary` 內容之語意正確性；若某寫入端寫入誤導性摘要，檢視頁會忠實呈現。
7. **【若 D3 裁定 (c)】`changes[].field` 為英文鍵名**：可讀性遜於中文標籤；緩解＝前端可選之對照表（D3 併記）。
8. **PHASE-009 D2(a) 之保存效果本 Phase 不兌現**：本 Phase 無參數覆寫端點，`parameterHasReferences` 之 `VOIDED` 語意仍無使用者可達之觸發路徑（義務續留 PHASE-011）。
9. **【若 D7 裁定 (b)】D-5／D-6／D-7 續存**：E2E helper 未抽取、`e2e/` 未接入 typecheck（76 個既有型別錯誤）、XSS 字面與掃描器 pattern 未收斂——三項移交 PHASE-011。
10. **稽核頁時間以「使用者瀏覽器時區」呈現**（**人類 leonchih 2026-08-09 SF-3 裁定「沿用瀏覽器時區」之明示接受項**）：於**非台灣時區之瀏覽器**登入時，稽核頁「操作時間」與 `AuditChangesList` 之時間值顯示**當地時間**，與列印版／PDF 之固定台北時間（後端 `formatTaipeiDateTime` +8h）**可能不同**（同一事件於兩處呈現之時分不一致）。此為與前端既有 8 個時間格式化落點一致之取捨（**零程式變更**），**明示接受**；若日後需全站固定台北，屬跨頁時間基準一致性議題，歸 PHASE-011。
11. **日期篩選恆以台灣日曆日為準**（**人類 leonchih 2026-08-09 Mock Gate MG-2 裁定之明示接受項，裁定逐字：「已知限制：國外瀏覽器登入時篩選仍以台灣日為準」**）：`dateFrom`／`dateTo` 之日界固定為 UTC+8（AC-02(e)），**不隨瀏覽器時區調整**。於**非台灣時區之瀏覽器**登入時，畫面之「操作時間」以當地時間呈現（§17.1 #10），而篩選仍切在台灣日界——故該情境下**可能出現「篩 8/7~8/8 卻見到畫面日期為 8/6 或 8/9 之列」**（與台灣使用者所見恰相反之方向）。此為 #10（顯示沿瀏覽器時區）與本項（篩選固定台北）兩項裁定並存之必然推論，**已於裁定當日明示接受**；若日後需二者同基準，屬跨頁時間基準一致性議題，歸 PHASE-011（與 #10 同案處理）。

12. **稽核頁不再於畫面呈現任何內部識別碼**（**人類 leonchih 2026-08-10 Mock Gate 第二輪 MG-3 裁定之明示接受項，裁定逐字：「內部申請編號（cuid）對人類無意義，畫面不顯示、資料庫可查即可」**）：AC-18(e) 之呈現層過濾使下列四項成為**明示接受之取捨**——
　　· **追查須改經 DB 或 API**：畫面上無從得知某列對應之申請／參數版本 id；wire（`GET /admin/audit-logs` 之 `targetLabel`／`changes[]`）與 DB 皆完整保留，故追查路徑存在但**非畫面可達**（裁定逐字之直接內容）。
　　· **修正版之「修正自」關係於畫面不可辨識**：`APPLICATION_CREATED_ON_BEHALF` 之修正版形（`{applicationId, type, revisionOf}`）濾後僅餘「申請類型」一列，畫面上與一般代建立**難以區辨**（AC-08(c) 之射程限定）。此為「兩處都拿掉」之直接後果；若日後需在畫面保留該語意，正解為**新增一個非識別碼之語意欄**（如布林「為修正版」）而**非**回填 cuid——屬新使用者可見行為，須另取人類裁定，歸 PHASE-011 候選。
　　· **參數型 `targetLabel` 前綴仍為英文字面**（`FUEL_PRICE`／`ETC`／`DEPRECIATION`）：MG-3 未及值層中文化之此面（修訂前即以英文呈現，非本次新增之缺口）；納入與否留待日後另案。
　　· **`loginName` 含 `#` 之帳號其顯示會被截於首個 `#`**：現行帳號驗證僅 `minLength: 1`、未禁止 `#`（`admin/routes.ts` :152）。此為 AC-18(e-1) 取「第一個 `#`」之已揭露代價（替代方案與比較見該條末點）；合成帳號實務上不含 `#`，且 wire 完整值恆可追查，**明示接受**。

### 17.2 與 PHASE-011 之銜接

| 目標 | 移交事項 |
|---|---|
| **PHASE-011** | ①稽核資料之**備份與還原**須涵蓋 `AuditLog` 表（含 `summary` JSON）②稽核之**保留期限／封存／清理**語意（含「已清理期間在檢視頁如何呈現」）③**效能實測**須涵蓋稽核列表（列表 2 s 目標）與 `action` 欄索引之實測決定④**PHASE-009 D2(a) 之兌現**——參數覆寫端點落地時必須呼叫 `parameterHasReferences` 守門⑤【若 D7(b)】KNOWN_ISSUES **D-5／D-6／D-7** 之收斂⑥【若 D11(a)】帳號類稽核之 fire-and-forget 可靠性議題⑦`Attachment` `TEMP` 清理排程落地後，AD-US-04 之附件阻擋條件自然放寬——須回歸確認 |

### 17.3 本 Phase 結清之跨 Phase 追蹤項

| 項目 | 結清方式 |
|---|---|
| **KNOWN_ISSUES §5 PHASE-010 ①②**（`APPLICATION_VOIDED` 納入檢視頁／前後摘要對作廢事件之呈現） | AC-04(d)、AC-06(c)、AC-07(a)⑤ |
| **KNOWN_ISSUES §5 PHASE-010 ③**（AD-US-04 回歸此時已有 `VOIDED` 資料） | AC-12(a)③(c) |
| **KNOWN_ISSUES §5 PHASE-010 ④**（代操作稽核完整性回歸） | AC-08 |
| **KNOWN_ISSUES §5 PHASE-010 ⑤**（D-2~D-7 收斂） | §16 **D7** 之分流裁定；AC-22 |
| **D-1**（error-handler 兜底洩漏面） | §16 **D6**；AC-21 |
| **D15 稽核 enum 收斂議題**（008/009/010 三 Phase 懸案） | §16 **D8** ＋ §6.2 對照表——**本 Phase 結案** |
| **PHASE-009 T10 即審 FW（低度）**（`userHasHistory` 不查 `AuditLog`） | §16 **D5**；AC-14 |
| **PHASE-007 T11 FW**（`summary` 同鍵異型 → `[object Object]`） | §16 **D3**；AC-06、AC-18(b) |
| **PHASE-009 T4 FW-E**（稽核頁 XSS ＋ 授權不低於申請） | AC-05、AC-18(a) |
| **PHASE-009 T7 FW**（相容兩種 `ON_BEHALF` summary 形狀） | AC-06(c) |
| **PHASE-005a T1 AR**（油耗版本使使用者永久不可刪之文件記載） | §17.1 #1 |
| **KNOWN_ISSUES §4 R-4／R-5** | AC-22(c)（依 D7）；若不納入則明列續存 |

---

## 18. Spec 修訂紀錄

| 日期 | Task ID | 內容 | 批准依據 |
|---|---|---|---|
| 2026-08-09 | `PHASE-010-SPEC` | 初版 DRAFT：§0~§18 全文；**22 條 AC**（其中 3 條為條件 AC）、**10 個 Task**（4 項 High ＋ 2 個條件 Task）、**12 個決策點**、**24 條邊界條件**（B-01~B-24）、**5 格授權矩陣**、AC↔測試映射表 **30 列**（27 列 `PENDING`、**3 列**條件列）。跨 Phase 追蹤 **10 項**逐項有落點（§0.3）。**兩項實查新發現**：①六條 `ON DELETE RESTRICT` FK 中三條無守門，AD-US-04② 現況實得 `500`（**D5**）②帳號類五事件之稽核為 fire-and-forget 且非同交易（**D11**）。 | 待 Spec Gate |
| 2026-08-09 | `PHASE-010-SPEC`（Gate 固化，大總管白名單） | **★ Spec Gate 通過（人類 leonchih 2026-08-09；兩輪 AskUserQuestion——四條親核裁定＋六點複述確認）★** 裁定全文：**D5=(c) 兩邊都補**（守門擴至全部 6 條 RESTRICT FK 路徑＋P2003 兜底轉譯 409「拒絕並提供停用」非 500；**代價明示接受：凡曾建帳號/改參數/上傳附件/被記稽核之管理員永久不可刪、僅能停用**；AC-14 生效）／**D11=(a)** 帳號類五事件稽核維持 fire-and-forget 本期零變更，不對稱事實記 KNOWN_ISSUES 移交 PHASE-011／**D3=(c)＋中文欄名**（後端攤平「欄位/改前/改後」三欄＋前端中文欄位對照表）／**D8=(a) 結案**（`AuditAction` 維持現有 10 值、本 Phase 零 migration；**此案結案，後續 Phase 不再重議**）／其餘 8 條（D1/D2/D4/D6/D7/D9/D10/D12）照推薦（D6 之 AC-21 採依摘要重建版）／**T1/T2/T3/T5 四項 High 事前批准**／3 條件 AC 全生效（AC-14/21/22）／§0.2 來源標記清單（既有語意擴張/建議新增）無異議。狀態 DRAFT→ACTIVE；§12 三條件列解鎖。 | 人類 leonchih 2026-08-09（AskUserQuestion 兩輪） |
| 2026-08-09 | `SPEC-REV-010-LITE` | **記載面修訂批次（零 AC 語意變更、零新 AC、零 Task Graph 變更）**，四項：①**§2 AC-01(b) 勘誤**——字面「封閉三鍵」與同句列舉之四鍵及 §7.2 `AuditLogListResponse` 四欄不一致，更正為「封閉**四鍵**」（T2 實作採四鍵已 APPROVE）。②**§12 T2 七列回填**——AC-01(a)(b)(c)／AC-01(d)／AC-03(a)(b)／AC-03(c)／AC-04(a)(b)(c)(e)／AC-04(d)／AC-05(a)(b)(c) 以 `phase10-audit-query.test.ts` 之實際 `describe`／`it` 名逐字回填並轉 `GREEN`（T2 `1aec6ed`）；**兩處預定名經實查證為失準**（「回應三鍵封閉」實為四鍵、「createdAt 同值三列」實為 5 列），以實查為準。③**§12 新增 `buildAuditLogWhere` 一列**（AC-02(a)(e)／`backend/test/unit/audit-log-where.test.ts`／T2（R-LITE）／`GREEN` `1a6b714`）——§11.1 該項原無映射落點（SF-1 長期不可見之結構成因），映射表 30 → **31 列**。④**§5 新增 B-25**——同一 query 參數重複帶入（`string[]`）七參數皆 `400 VALIDATION_ERROR` ＋ `fields[{field:"<該欄>"}]`，溯源 `applications/application-query.ts` B-35（PHASE-005 T6-AR-1 同型），並於 §11.2 同步 `B-23~B-24` → `B-23~B-25`。 | T1 即審 FW-6／T2 即審 SF-2·AR-4／T2 關閉確認 FW-7／大總管派工 2026-08-09 |
| 2026-08-09 | `SPEC-REV-010-LITE-2` | **記載面修訂批次（零新 AC、零 Task Graph 變更；AC 語意變更僅第⑤項之單向從嚴升格）**，六項：①**§12 T3 四列失準修正**——AC-07(a)(b)／AC-07(c)／AC-08(a)(b)(c)／AC-09(a)(b)(c)(d) 四列之測試名各僅載單一 `it` 名，但 `phase10-audit-completeness.test.ts` 實查證 AC-08(c)（:1315）、AC-09(c)（:1445）、AC-09(d)（:1465）及 AC-07(a) 之三個補強格（:1161／:1173／:1184）、AC-07(c) 延伸格（:1224）、掃描器鑑別力自證格（:1488）皆為**獨立 `it`**；四列拆為**七列**並以實際 `describe`／`it` 名逐字補全（`A` › `B` 記法沿 T2 七列）。GREEN 標注維持（T3 `81dd7b9`；格式修復 `71d729c`）。②**§12 AC-01(d) 補第二落點**——同檔 `FW-1（T2 即審）: GET /admin/audit-logs 呼叫前後 AuditLog／User／Application 三表逐欄不變，且三表皆非空`（:1228）補入該列，改為 T2／T3 兩檔並列（T2 版於 `Application` 恆空分支上為恆真，FW-1 為其實質補齊）。③**§2 AC-09(a) 明載 W-1 允許集**——`assertNoSensitiveContent` 同型掃描器得帶**封閉允許集**，成員限「Spec／schema 強制上 wire 之識別字之**完整字面**」（現行恰兩個：`USER_PASSWORD_RESET`、`mustChangePassword`），封閉性由 AC-09(c) 之 `toEqual` 承擔，**子字串不放行**；§11.6 同步交叉引用。④**§12 AC-14 拆列＋落點補齊**——拆為 AC-14(a)／(b)／(c)／(d) 四列：(c) 依 §2 逐字為「紅燈物證記入 Handoff」，改註 **`N/A（非測試）`**（不計入測試覆蓋計數；狀態值圖例同步新增該值）；(d) 為新列（`AC-14(d): DELETE 端點之 P2003 兜底 — 守門停用時仍為 409（非 500）` describe 之三格）；(a) 列併入 T5R-LITE 之 `(a)／SF-1 守門判定邏輯之鑑別力` 格（`69d4cae`）；另補 `B-17／B-18: 既有行為零變更` 落點列（§11.2 已列 `B-14~B-18`，該兩項原無落點）。映射表 **31 → 38 列**（`GREEN` 25／`PENDING` 12／`N/A` 1）。⑤**§2 AC-14(a) 升格為欄位級**——「引用**表**集合恰等於…」升格為「引用**「表.欄位」**集合恰等於…」；原文對「同表新增未守門欄」**零鑑別力**（期中複審 #1 V4 實證），升格方向為**更嚴**、屬防「合規弱化」，**T5 實作已達此標準**（欄位級格在場）故零實作影響。⑥**§3.3 步驟 1 措辭對齊**——原文「以**真實端點**構造該類資料」寬於 AC-12(c) 之強制射程（僅 `VOIDED` 一類強制真實端點），與 T5 實作（②④底稿沿 phase9 先例直寫）字面矛盾；改為逐字引用 AC-12(c) 之射程並註明 §11.0 #4 之禁止項僅及於直寫**被驗證之狀態**。**與 Packet 之差異（據實記錄）**：Packet 第 6 項稱「§10 步驟 1」，實查 §10 為非功能需求表（無步驟）；該逐字文句位於 **§3.3 步驟 1**，故落於 §3.3。 | T3 即審 SF-2·W-1(iii)／期中複審 #1 SF-B1·SF-B2／T5 即審 AR-5／T5R 關閉確認附帶提醒／大總管派工 2026-08-09 |
| 2026-08-09 | `SPEC-REV-010-LITE-3` | **兩項人類裁定落地 ＋ 記載面修訂批次（零新 AC 編號、零 Task Graph 結構變更；AC 語意變更兩處，皆為已批准裁定之逐字落地）**，五項：①**SF-3 落地（「沿用瀏覽器時區」）**——§2 **AC-18(c)** 之「與列印版同型之**台北時區**在地化」改為「**使用者瀏覽器時區之在地化（`zh-TW` 格式）**」，並明載列印版／PDF 之後端固定 +8h **維持不變**（二者格式同型、基準時區不同）；§16 **D9(a) 影響欄**加註「可抄 `report-labels.ts` 之邏輯」一句**不再適用**（實查既有 8 個瀏覽器時區格式化落點：`ReportSection.tsx` :161、`DepreciationApplicationPage.tsx` :623/:662、`MaintenanceApplicationPage.tsx` :601/:638、`TravelApplicationPage.tsx` :684/:765 ＋ `ParametersPage.formatDateYmd` :46-53）；§17.1 **新增 #10** 已知限制（非台灣時區瀏覽器登入時顯示當地時間，與列印版可能不同——**明示接受**）。②**SF-1 落地（「改用使用者下拉」）**——§16 **D2(b) 影響欄**加註裁定三項搭配條件與複用對象（`apiGetUsers`，`frontend/src/api/users.ts` :3；既有先例 `AdminFuelConsumptionPage.tsx` :131、`AdminUserApplicationsPage.tsx` :87）；**§2 新增 AC-16(d)**（來源標記：**裁定直接推論**）載明兩篩選欄為使用者下拉、選項文字＝顯示名稱、送出值＝id、清單複用既有 API、**不得**以純文字 id 輸入實作；§15 **T7** Done When 追加同義項並指向修復 Task **T7R**。③**§12 T7 三列逐字回填**（AC-15／AC-16(a)(b)(c)／AC-17，AC-15 改兩檔並列、AC-17 實為七個 `it`）＋ **AC-18(a)／(c) 補 T7 追加①②落點**（改兩檔並列，T6 三列補 `describe` 前綴）＋ **新增 AC-16(d) 一列**（`PENDING`／T7R）；映射表 **38 → 39 列**（`GREEN` 31／`PENDING` 7／`N/A` 1——大總管更正，原載 25／13 為計數失準）。④**§0.4 併入本 Phase 自身裁定之回查**（SF-1／SF-3 兩列 ＋ 導言更正——原句「本 Phase 尚無自身之人類裁定」於 Spec Gate 後已失準）。⑤本列。**與 Packet 之差異（據實記錄，需大總管知悉）**：Packet 第 2 項指示「AC-16(a) 若字面相容則**僅加註不改 AC**」；實查 AC-16(a) 字面**與下拉相容但不蘊含下拉**（純文字 id 輸入亦滿足之），若僅加註於 §16 D 項則構成**治理 2026-08-09.1 §11 之缺口**（＝PHASE-009 T16 M-1「已批准措施零 AC 落地」之同型），故**改以新增 AC-16(d) 承載**，AC-16(a) 字面**未動**。 | **人類 leonchih 2026-08-09（AskUserQuestion 兩項裁定：SF-1＝改用使用者下拉、SF-3＝沿用瀏覽器時區）**／期中複審 #2 SF-1·SF-3·SF-4／大總管派工 2026-08-09 |
| 2026-08-09 | `SPEC-REV-010-GATE` | **★ Mock Gate 第一輪反饋之兩項人類裁定落地（Gate 反饋型 Spec 修訂；零新 AC 編號、AC 語意變更三處皆為已批准裁定之逐字落地，另有一處明標之既有語意擴張）★** 裁定原文（AskUserQuestion 選項全文即裁定）：**MG-1＝「智能攤平＋值中文化」**——「後端攤平強化：`{from,to}` 拆進改前/改後兩欄；油耗巢狀前後版本逐子欄拆列（油種：改前 92 無鉛→改後 95 無鉛）；前端加值中文化（差旅/保養/折舊、油種名、是/否、日期在地化）」；**MG-2＝「以台灣日曆日為準」**——「篩 8/7~8/8 就是台灣時間的 8/7 00:00~8/8 23:59，與畫面顯示一致；後端日界平移八小時；已知限制：國外瀏覽器登入時篩選仍以台灣日為準」。六項：①**§2 AC-06(b) 全條重寫**——分派改為三層（(b-0) `summary` 級預檢之巢狀子鍵聯集拆列／(b-1) `{before,after}` 與 **`{from,to}` 同等待遇**之兩鍵物件拆欄／(b-2) 其餘／(b-3) 空集），併加「拆欄不擴大揭露面」註記；**(c) 四案例依修訂後期望輸出重寫**（油耗巢狀 → 4 列；`{isActive:{from,to}}` → 一列兩欄；代建立／代修改兩形**明載零影響**）；**(d) 鍵守恆改為集合相等之封閉式** `(頂層鍵 − 觸發預檢之 before/after) ∪ 子鍵聯集`，新增**刪子鍵 mutant 必紅**之守門面。②**§2 AC-02(e) 改台北日界**——兩端點逐字換算（`dateFrom` 前一日 `16:00Z` ／ `dateTo` 當日 `16:00Z`）、固定 +8h **零新增依賴**、`buildAuditLogWhere` 零程式變更、UTC 日界 mutant 必紅，併明載**與 AC-18(c)（瀏覽器時區顯示）之關係**（台灣使用者一致；非台灣使用者為已裁定接受之差異，**不得於實作期自行「修正」**）。③**§2 新增 AC-18(d)**（值層中文化）——**依欄位限定**之枚舉映射（`type`／`fuelType`／`role`／`parameterType`）＋布林限定欄位之是/否＋未知值原樣回退＋**14 值覆蓋守門常數**；值標籤**逐字沿既有落點**（`ApplicationListSection.tsx` :30-32／`AdminFuelConsumptionPage.tsx` :59-62），併載 `FIELD_LABELS` 因 `kmPerLiter` 首度成為 `field` 而 **31 → 32 鍵**且其守門常數定義改為「`changes[].field` 可能值全集」。④**§5 邊界**：B-07 改台北日界（首末毫秒雙向）、B-11／B-12 更新，**新增 B-26~B-29 四條**（`{from,to}` 拆欄／巢狀首版／子鍵不對稱聯集／台北日界雙向釘死）。⑤**§12 映射表 39 → 41 列**（`GREEN` 32 → **27**／新狀態值 `PENDING（Gate 修訂後待重驗）` **6**／`PENDING` **7**／`N/A` 1）——5 列轉待重驗且**逐列載明必紅之具體斷言與行號**，新增 `AC-02(e) wire 面`（既有覆蓋落點缺口）與 `AC-18(d)` 兩列。⑥**§15 新增三個修復 Task**（**T-MG1-BE1**／**T-MG1-BE2**／**T-MG1-FE**）＋依賴圖＋規模自查＋機械連動預授權（三處：completeness 之巢狀在場自證判別式、audit-log-query 之 4 處 UTC 字面、phase10-audit-query 之四個毫秒級 fixture 常數）；另 §0.4 增 MG-1／MG-2 兩列回查、§16 D3 增 Gate 實測反饋註（**裁定 (c) 未被推翻，推翻的是其輸出形式之充分性**）、§17.1 增 #11、§15.4 增 Mock Gate 第二輪列。**需人類確認之獨立項一條（治理 2026-08-03.1）**：AC-06(b-0) 之「**一側為 `null`（油耗首版）亦拆子欄**」屬**既有語意擴張**（裁定逐字僅及「前後版本」），已於 §0.2 獨立列出並於 AC 內載明否決時之退回字面。**與 Packet 之差異（據實記錄）**：①Packet 建議單一 `T-MG1-BE`，實查證其未計入兩個必然連動之整合測試檔（達 6~7 檔且混入兩項不相干裁定），改拆為 BE1／BE2 兩 Task（理由載於 §15.1）；②Packet 稱「T2R 單元檔 `audit-log-where.test.ts` 日界格將因 AC-02(e) 修訂而紅」，**實查為否**——該檔以 `Date` 值直接建構輸入、不經 `parseAuditLogQuery`，斷言真偽不受日界平移影響，實際需要的是**記載對齊**（fixture 字面與檔頭敘述仍為 UTC 日框架），已如實登記於 §12 該列與 T-MG1-BE2 之 Done When；③Packet 稱「T3 之 AC-08(c) 扁平化相關格如受影響同列」，**實查證受影響者為 AC-09(a)(b) 之 wire 掃描格**（`withBefore` 判別式 :1439 於 (b-0) 後恆真），AC-08(c) 之作廢／修正版 `summary` 頂層不含 `before`／`after`，**零影響**。 | **人類 leonchih 2026-08-09（AskUserQuestion 兩項裁定：MG-1＝智能攤平＋值中文化、MG-2＝以台灣日曆日為準）**／Mock Gate 第一輪反饋（`WALKTHROUGH-PHASE-010-MOCK.md` 檢核結果欄／`PROJECT_STATE.md` Mock Gate 第一輪列）／大總管派工 2026-08-09 |
| 2026-08-10 | `SPEC-REV-010-GATE-2` | **★ Mock Gate 第二輪反饋之 MG-3 裁定落地（Gate 反饋型 Spec 修訂；零新 AC 編號、AC 語意變更一處＝新子項 AC-18(e)，射程限於前端呈現層）★** 裁定原文：**MG-3＝「內部申請編號（cuid）對人類無意義，畫面不顯示、資料庫可查即可」**；**同日消歧裁定＝「兩處都拿掉」**（①列標題「受影響資料」之 `帳號#編號` 只留帳號（含顯示名稱）②明細表內純內部編號列（申請編號／修正自）不顯示）；**射程限定逐字：顯示層變更——DB 與 API wire 完整保留**（追查用）。八項：①**§2 新增 AC-18(e)**（來源標記：**裁定直接推論**）——(e-1) `targetLabel` 只呈現**第一個 `#` 之前段**（無 `#` 者原樣全字）／(e-2) 明細表濾除**依欄位名**之隱藏欄封閉集合（**實查全 13 個稽核寫入站點之 `summary` 鍵全集，屬純內部識別碼者恰兩個**：`applicationId`／`revisionOf`）／(e-3) 隱藏欄常數之「恰兩鍵」與「⊆ `FIELD_LABELS`」機械守門／**(e-4) 32 鍵欄名守門之鑑別力保全**（見下方「跨 AC 一致性自查」）／(e-5) 全濾後走既有空態／(e-6) 與 (a)~(d) 四項既有守門之零弱化關係／(e-7) 顯示名稱去重比較改以裁切後值為準；並於**射程界定**段明文鎖住 wire 面零變更與 **AC-16(d) 下拉送出值不在射程內**（防「連 `<option value>` 一起拿掉」而反噬已批准之 SF-1 裁定）。②**§2 AC-04(c)／AC-08(c)／AC-15(c) 三處加註**——AC-04(c) 明載 wire 恆為完整快照字串且不得以「畫面不顯示」為由縮減；AC-08(c) 之「在列表中可讀」對兩隱藏欄**改由 wire 面承載**並記其行為後果；AC-15(c) 指向 AC-18(e)。③**§5 新增 B-30／B-31 兩條**（無 `#` 不截斷／全列被濾之空態）。④**§7.2 `targetLabel` 註記**。⑤**§11.3 兩檔測試項補列**。⑥**§12 映射表 41 → 42 列**——新增 `AC-18(e)` 列（`PENDING`／`T-MG3-FE`）＋ **AC-15 列由 `GREEN` 轉 `PENDING（Gate 修訂後待重驗）`**（逐字載明必紅斷言與行號：`AuditLogPage.test.tsx` :374 `/user1#app-9/`），計數更新為 `GREEN` 33／`PENDING` 7／待重驗 1／`N/A` 1。⑦**§15 新增 `T-MG3-FE`**（FE only、4 檔、Medium、`backend/src` 零 diff）＋依賴圖＋規模自查＋**兩處機械連動預授權**（:374 重錨定／32 鍵守門就隱藏欄改斷言對象）；**§15.1 T8 連動更新**（E2E 期望值不得以 `帳號#編號` 全字串比對，且 T8 須排在 T-MG3-FE 之後）；**§15.4 新增「MG-3 小範圍目視」Gate 列**。⑧**§17.1 新增 #12**（四項明示接受之取捨）＋§0.4 增 MG-3 回查列。**跨 AC 一致性自查所得（治理 2026-08-07.1）**：**(e-4) 為本次最重之發現**——現行 32 鍵守門之形狀為「渲染 32 列 → 斷言英文鍵名不出現」，(e-2) 生效後被隱藏之兩鍵**根本不渲染**，該負向斷言將**恆真而失去鑑別力**（＝FE 複審 SF-A 之同型，屬**靜默的守門弱化**），故 Spec 強制其就隱藏欄改以標籤表為斷言對象，並要求「刪 `FIELD_LABELS` 任一隱藏欄鍵之 mutant 仍必紅」之鑑別力自證；同時明定 `FIELD_LABELS` **維持 32 鍵**（「是否呈現」與「是否有標籤」正交）。**需人類覆核之獨立項三條（治理 2026-08-03.1；MG-3 小範圍目視時逐條確認）**：**(i) 延伸判讀**——裁定字面為「內部**申請**編號」，本 Spec 將射程延伸至**參數型 `targetLabel`**（`FUEL_PRICE#<cuid>` 等）之 `#` 後段（理由：其後段同為 cuid，裁定理由逐字同樣成立；不延伸將造成同頁不一致）；否決時退回窄版，(e-1) 其餘不變。**(ii) 行為後果**——修正版之「修正自」關係於畫面**不再可辨識**（§17.1 #12 第二點）；此為「兩處都拿掉」之直接後果，**非**本 Spec 之自行取捨，惟人類裁定當下未必預見，故獨立列出。**(iii) 設計選擇**——(e-1) 取「**第一個** `#`」而非「最後一個 `#`」或 cuid 形狀判斷，代價為「`loginName` 含 `#` 時被截斷」（現行驗證未禁止）；三方案之比較與取捨理由載於 (e-1) 末點，人類可低成本推翻。**與 Packet 之差異（據實記錄）**：①Packet 給二擇一「AC-04(c) 或 AC-18 新子項」——**選 AC-18(e)**，因 §2 A 段為 BE 契約段而呈現層屬 E 段（AC-04(c) 改以加註指向，避免把前端行為寫進 BE 契約 AC）；②Packet 問「明細 `changes[]` 中值為純內部識別碼之欄……確認有無其他」——**實查結論為恰兩個**（`applicationId`／`revisionOf`），佐證已入 (e-2)；③Packet 之連動項提到「隱藏列之鍵仍在 `FIELD_LABELS` 供回退？」——**答：保留，且此為必須**（理由見 (e-4)），並額外發現既有守門之鑑別力歸零問題（Packet 未預見）；④Packet 稱「§0.4 回查列」——本次改列於 §0.4 表**末**（MG-2 列之後，維持時序）。 | **人類 leonchih 2026-08-10（Mock Gate 第二輪走查中之 MG-3 裁定＋同日消歧裁定「兩處都拿掉」）**／`PROJECT_STATE.md` Mock Gate 第二輪列／`WALKTHROUGH-PHASE-010-MOCK.md` :93 第二輪檢核結果欄／大總管派工 2026-08-10 |
