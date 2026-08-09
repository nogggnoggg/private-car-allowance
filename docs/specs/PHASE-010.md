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
> - **裁定直接推論／US 逐字**：AC-01, AC-04, AC-06, AC-07, AC-08, AC-09, AC-12, AC-13, AC-15
> - **既有語意擴張**（須於 Human Gate 清單獨立列出）：**AC-02**（篩選與分頁——PRD :509「篩選」之具體化）、**AC-03**（全序排序——分頁之必要前提，沿 PHASE-004 AC-67 慣例）、**AC-05**（授權矩陣格數——US 僅稱「管理員」）、**AC-14**（FK 守門範圍擴大——US 僅列「申請或歷史資料」）、**AC-18**（呈現安全——US 未提）
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

本 Phase 尚無自身之人類裁定；下表逐筆回查**與本 Phase 範圍交集**之上游裁定，確認其搭配條件／但書在本 Phase 是否有落地義務。

| 上游裁定 | 搭配條件／但書 | 本 Phase 之義務 | 落點 |
|---|---|---|---|
| **PHASE-009 D10(a)**（新增 `APPLICATION_VOIDED`） | 「PHASE-010 稽核頁多一類」（§16 D10 影響欄逐字） | **有**——AC-04／AC-06／AC-07 須明列該值，且 `summary` 四鍵（`applicationId`／`type`／`reason`／`voidedAt`）逐鍵有呈現落點 | AC-04, AC-06, AC-07 |
| **PHASE-009 D2(a)**（`VOIDED` 算「已被引用」） | PHASE-009 T8 即審 **AR-4**：「函式語意已結案，**使用者可達之覆寫操作尚不存在**，實際保存效果待 PHASE-010/011 覆寫端點落地時兌現（該端點落地時必須呼叫本守門）」 | **無**——本 Phase **不新增任何參數覆寫端點**（§1.2 非目標）。明列為「本 Phase 不兌現」，義務續留 PHASE-011 | §1.2, §17.2 |
| **PHASE-009 D15(a)**（修正版不自動作廢 ＋ **前端強提示**） | 前提「前端強提示」曾於 T16 M-1 漏落 AC（本專案最重 finding） | **無**——本 Phase 不觸及該面；但列為 §11.0 之零弱化義務：**既有重複計入提醒文案之測試不得被本 Phase 之前端改動弱化** | §11.0, AC-20 |
| **PHASE-005a T1 即審 AR**（`PROJECT_STATE.md` :393） | 「油耗版本使使用者**永久不可刪**（D8(a) 設計後果，**PHASE-010 文件記載**）」 | **有**——明文記載於已知限制，並納入 AC-12 之五類歷史逐一回歸（含油耗版本一類） | AC-12, §17.1 #1 |
| **PHASE-008 T12~T13 即審 SF-2**（時間呈現一致性 Mock Gate 裁定項） | ISO8601 與 `toLocaleString("zh-TW")` 並排不一致之教訓 | **有**——§16 **D9** 明文裁定本頁時間呈現形式，避免同型再犯 | **D9**, AC-18(c) |

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
(e) `dateFrom > dateTo` → `400` ＋ `fields[]`；區間**起訖日均含當日**（`CLAUDE.md` 工程規則）。
(f) 解析為**純函式**（不碰 DB、不碰 Prisma 型別），可單獨單元測試。

**AC-03 — 全序排序與跨頁不重不漏【既有語意擴張】**
(a) 排序恆為 `createdAt DESC, id DESC`（**兩層全序**；`id` 為 cuid 主鍵，保證最終全序）。
(b) 構造 **≥ 3 筆 `createdAt` 完全相同**之稽核列，以 `pageSize=2` 跨頁取得全部列，斷言**聯集恰等於全集且零重複**——移除 `id` 這一層排序鍵之 mutant **必紅**。
(c) 分頁與計數皆於 DB 層完成（`skip`／`take` ＋ 獨立 `count`），不將命中集合整份讀入記憶體——以原始碼結構斷言守門（沿 PHASE-004 AC-91 先例）。

**AC-04 — 列投影（AD-US-14② 之四要素）**
(a) `AuditLogListItemDto` 鍵集封閉，恰含：`id`／`action`／`createdAt`／`actorDisplayName`／`targetLabel`／`targetDisplayName`／`changes`（依 **D3**）。**多一鍵必紅**。
(b) **操作者**＝`actorDisplayName`（取自 `AuditLog.actor.displayName`）；**不得**輸出 `actorId`／`targetId` 等內部識別值（沿 PHASE-009 §6.3「內部識別值不外露」既有紀律）。
(c) **受影響資料**＝`targetLabel`（DB 既有欄，恆為快照字串；實查形狀有三種：`loginName`／`loginName#applicationId`／`FUEL_PRICE#id` 等參數型），必要時併 `targetDisplayName`（`target` 關聯之顯示名，**目標使用者已被刪除時為 `null`**——`AuditLog.targetId` 之 FK 為 `ON DELETE SET NULL`，實查 `20260801101310_phase2_auth/migration.sql` :83）。
(d) **十個 `AuditAction` 值逐一**皆有一條真實列可被本端點取回並通過 (a)~(c)——含 `APPLICATION_VOIDED`（PHASE-009 移交①）。
(e) `createdAt` 以 **ISO 8601 UTC 字串**輸出（依 **D9**）。

**AC-05 — 授權矩陣（1 端點 × 5 身分 ＝ 5 格，格數明列）【既有語意擴張】**
(a) 五格逐格如 §6.1 表；**管理員 only**——一般使用者（含資料擁有人本人）一律 `403 FORBIDDEN`，此為**嚴於**申請端點之授權（PHASE-009 T4 FW-E 逐字要求「授權不低於申請」）。
(b) 判定順序：`401` → `403 PASSWORD_CHANGE_REQUIRED` → `403 FORBIDDEN` → 參數驗證 `400`——**授權一律早於任何查詢與參數驗證**；以側信道測試證明「非管理員送出畸形 `page` 參數」得 `403` 而**非** `400`。
(c) `403` 回應**零業務值**（不含任何稽核內容、不含 `total`）。

### B. 前後摘要（AD-US-14③、BE-US-31④）

**AC-06 — `changes[]` 之扁平化契約【依 §16 D3】**
(a) 每列輸出 `changes: Array<{ field: string; before: string | null; after: string | null }>`，由 `AuditLog.summary`（`Json?`）經**單一純函式**扁平化而得。
(b) **形狀分派**：`summary` 之值為物件且恰含 `before`／`after` 兩鍵者 → 拆為該兩欄；為純量（`string`／`number`／`boolean`／`null`）者 → `before: null` ＋ `after: 值之字串化`；`summary` 為 `null`／`{}` → `changes: []`。
(c) **同一 `action` 之異形 `summary` 皆須成立**（跨 Phase 追蹤 #6／#7）：
　　· `APPLICATION_CREATED_ON_BEHALF` 之兩形——一般代建立（`{applicationId, type, tripDate, purpose}` 等純量）與**修正版**（`{applicationId, type, revisionOf}`）；
　　· `APPLICATION_UPDATED_ON_BEHALF` 之 `{before, after}` 形；
　　· `USER_FUEL_CONSUMPTION_VERSION_CREATED` 之**巢狀混合形**（實查 `fuel-consumption-routes.ts` :251-259：`{ before: {...}, after: {...}, basisNote }`——`before`／`after` 各為**物件**而非純量，且與 `basisNote` 純量並存）。
(d) **鍵守恆**：扁平化**不得遺失任何 `summary` 頂層鍵**——以「輸入頂層鍵集合 ⊆ 輸出 `field` 集合」之封閉斷言守門，刪一鍵之 mutant 必紅。
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
(c) 列表逐列顯示四要素：操作時間／操作者／操作類型（**中文標籤**，依 AC-10(c) 之對照表）／受影響資料。

**AC-16 — 篩選與分頁 UI【建議新增】**
(a) 篩選控制項對應 AC-02 之維度（依 **D2**）；變更任一篩選即重置 `page` 為 1。
(b) 分頁控制：上一頁／下一頁與「第 N 頁／共 M 筆」；首頁時「上一頁」停用、末頁時「下一頁」停用。
(c) 篩選與分頁一律**經 query 參數送後端**——前端**不得**取回全集後自行過濾或分頁（以「請求 URL 含該參數」之斷言守門）。

**AC-17 — 五態【建議新增】**
依 §4 表逐格：Loading／Empty／Error／Success／Permission denied 各至少一條斷言；**Empty 與 Permission denied 不得共用同一段文案**（防兩態混淆）。

**AC-18 — 呈現安全【既有語意擴張】**
(a) **跳脫**：`targetLabel` 與 `changes[].before`／`after` 皆含使用者自由文字（作廢原因、出差目的、油耗依據備註），一律經 React 之文字節點渲染（**不得** `dangerouslySetInnerHTML`）；以 XSS payload（`<script>`／`"><img onerror=`／`javascript:`）為輸入之正負向各一格，並以「全頁 DOM 無 `<script>` 節點新增」為守門。
(b) **`[object Object]` 負向守門**：以 AC-06(c) 之巢狀混合 `summary`（油耗版本形）為 fixture，斷言渲染結果**不含** `"[object Object]"`。**此守門必須自帶於前端測試**，不得倚賴後端扁平化之測試（沿 PHASE-009 T15c FW「前端呈現側負向守門必自帶」）。
(c) **時間呈現**（依 **D9**）：後端回 ISO 8601 UTC，前端以與列印版同型之台北時區在地化呈現；同頁**不得**同時出現 ISO 原字串與在地化字串兩種形式（PHASE-008 SF-2 之同型再犯防護）。

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
| B-07 | `dateFrom` ＝ `dateTo` ＝ 同一日 | 該日之列**全數命中**（起訖含當日） |
| B-08 | `dateFrom` > `dateTo` | `400` ＋ `fields[]` |
| B-09 | `actorId`／`targetId` 為不存在之 id | `200` ＋ 空集合（**非** 404；不洩漏使用者存在性） |
| B-10 | 三筆稽核列 `createdAt` 完全相同，`pageSize=2` 跨頁取 | 聯集恰等於全集、零重複（AC-03(b)） |
| B-11 | `summary` 為 `null`（實查：`writeAudit` 之 `detail` 為 optional） | `changes: []`，不拋錯 |
| B-12 | `summary` 為巢狀混合形（油耗版本：`before`／`after` 各為物件 ＋ `basisNote` 純量） | 三個頂層鍵皆現身於 `changes`，且**零** `"[object Object]"` |
| B-13 | `targetId` 指向已被刪除之使用者（`SET NULL` 後） | `targetDisplayName: null`、`targetLabel` 仍為快照字串；不拋錯、不洩漏 id |
| B-14 | 刪除「曾執行任一被稽核操作」之管理員 | 依 **D5**：(a)/(c) → `409` ＋ 停用文案；**現況為 `500`** |
| B-15 | 刪除「上傳過附件（`TEMP`）但零申請」之使用者 | 依 **D5**：同上；**現況為 `500`** |
| B-16 | 刪除「代他人建過草稿、自己零申請」之管理員 | 依 **D5**：同上；**現況為 `500`** |
| B-17 | 刪除自己 | `409`「不可對自己執行此操作」（既有行為，零變更；實查 `admin/routes.ts` :392-394） |
| B-18 | 刪除不存在之 `:id` | `404`（既有行為，零變更） |
| B-19 | 未登入／需強制改密存取稽核端點 | `401` ／ `403 PASSWORD_CHANGE_REQUIRED` |
| B-20 | 一般使用者送出畸形 `page` 參數 | `403`（**非** `400`）——授權早於驗證之側信道守門 |
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
  targetLabel: string;            // DB 既有快照欄
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
  &dateFrom=2026-08-01           // optional，YYYY-MM-DD，含當日
  &dateTo=2026-08-31             // optional，YYYY-MM-DD，含當日
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

- `parseAuditLogQuery`：B-01~B-09 之參數矩陣逐格；clamp 與 400 之分野。
- `flattenAuditSummary`：AC-06(b)(c)(d)(f)；以三種真實 `summary` 形狀為 fixture（自各 Phase 實際寫入形狀抄錄，不自行虛構）；鍵守恆之刪鍵 mutant 必紅。
- `buildAuditLogWhere`：純函式 `toEqual`。

### 11.2 整合（Vitest ＋ PostgreSQL ＋ 真實 route）

- `phase10-audit-query.test.ts`：AC-01、AC-03、AC-04、AC-05（5 格）、B-10~B-13、B-19~B-20、B-23~B-25。
- `phase10-audit-completeness.test.ts`：AC-07（七類 ＋ 負向對照）、AC-08（代操作兩類）、AC-09（全表 ＋ wire 掃描）。
- `phase10-audit-structure.test.ts`：AC-10（站點白名單 ＋ enum 對照 ＋ 標籤表涵蓋）、AC-11（不可變性掃描 ＋ mutant 自證）。
- `phase10-user-delete-regression.test.ts`：AC-12（五類）、AC-13、AC-14（依 D5）、B-14~B-18。
- 【條件】`phase10-error-handler-leak.test.ts`：AC-21（依 D6）。

### 11.3 前端（Vitest ＋ Testing Library，mock fetch）

- `AuditLogPage.test.tsx`：AC-15、AC-16、AC-17（五態各一）、AC-18(b)(c)、B-21~B-22。
- `HomePage.test.tsx`（既有檔擴充）：AC-15(b) 之管理員入口正負向。
- `AuditChangesList.test.tsx`（若拆元件）：AC-18(a)(b) 之 XSS 與 `[object Object]` 守門。

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

---

## 12. AC ↔ 測試映射表（機械可查；隨 Task 完成更新「狀態」欄）

> **格式**：`AC` ｜ `層級` ｜ `測試檔（規劃路徑）` ｜ `測試名（預定名稱）` ｜ `Task` ｜ `狀態`
> 狀態值：`PENDING`（尚無測試證據）／`PENDING（Spec Gate 裁定後解鎖）`（條件 AC）／`RED`／`GREEN`／`N/A（非測試）`（該 AC 子項之落點依 Spec 本文即為 Handoff 物證等非測試載體；不計入測試覆蓋計數）。
> **Phase 完成前之覆蓋檢查與終審核對以本表為準**（治理 2026-08-02.1）。轉 `GREEN` 時**一律以實際存在之測試名逐字回填**。

| AC | 層級 | 測試檔 | 測試名（預定） | Task | 狀態 |
|---|---|---|---|---|---|
| AC-01(a)(b)(c) | integration | `backend/test/integration/phase10-audit-query.test.ts` | `PHASE-010-T2 — GET /admin/audit-logs` › `AC-01 端點與回應形狀` › `(a)(b) 200 ＋ 回應 body 為封閉四鍵（多一鍵必紅）`；`(c) 零結果 → 200 ＋ items: [] ＋ total: 0（非 404）——B-09 不存在之 actorId`；`(c)／B-06 合法 action 但零命中 → 200 ＋ 空集` | T2 | `GREEN`（T2 `1aec6ed`） |
| AC-01(d) | integration | `backend/test/integration/phase10-audit-query.test.ts` ＋ `backend/test/integration/phase10-audit-completeness.test.ts`（**兩檔並列**） | ①`PHASE-010-T2 — GET /admin/audit-logs` › `AC-01 端點與回應形狀` › `(d)／B-24 端點零寫入：AuditLog／User／Application 三表逐欄不變`；②`PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）` › `AC-07 — 七類事件端到端齊備回歸（AD-US-14①／BE-US-31）` › `FW-1（T2 即審）: GET /admin/audit-logs 呼叫前後 AuditLog／User／Application 三表逐欄不變，且三表皆非空`（**三表皆非空之實質補齊**——①之 T2 版於 `Application` 表恆空之分支上為恆真） | T2／T3 | `GREEN`（T2 `1aec6ed`；FW-1 格 T3 `81dd7b9`） |
| AC-02(a)~(e) | unit | `backend/test/unit/audit-log-query.test.ts` | `AC-02: parseAuditLogQuery 參數矩陣（B-01~B-09）` | T1 | `GREEN`（T1 `d7b70ad`） |
| AC-02(f) | unit | 同上 | `AC-02(f): 解析為純函式 — 零 DB／零 Prisma 型別相依` | T1 | `GREEN`（T1 `d7b70ad`） |
| AC-02(a)(e) | unit | `backend/test/unit/audit-log-where.test.ts` | `PHASE-010-T2R-LITE — buildAuditLogWhere（where 建構純函式；Spec §11.1）` | T2（R-LITE） | `GREEN`（`1a6b714`） |
| AC-03(a)(b) | integration | `phase10-audit-query.test.ts` | `PHASE-010-T2 — GET /admin/audit-logs` › `AC-03 全序排序與跨頁不重不漏` › `(a) 排序恆為 createdAt DESC, id DESC——同 createdAt 之 5 列逐位對照 id 降冪`；`(a) 跨不同 createdAt 時以 createdAt 降冪為主鍵`；`(b)／B-10 createdAt 完全相同之 5 列，pageSize=2 跨頁：聯集恰等於全集且零重複` | T2 | `GREEN`（T2 `1aec6ed`） |
| AC-03(c) | integration | 同上 | `PHASE-010-T2 結構性斷言（AC-03(c)／ErrorCode 聯集）` › ``AC-03(c)：分頁與計數皆於 DB 層完成——`skip`／`take` ＋ 獨立 `count` 在場，且零記憶體內切片`` | T2 | `GREEN`（T2 `1aec6ed`） |
| AC-04(a)(b)(c)(e) | integration | 同上 | `PHASE-010-T2 — GET /admin/audit-logs` › `AC-04 列投影（AD-US-14② 之四要素）` › `(a) AuditLogListItemDto 鍵集封閉為七鍵（多一鍵必紅）`；`(b) 操作者＝actorDisplayName；回應零內部識別值（actorId／targetId 不外露）`；`(c) 受影響資料＝targetLabel ＋ targetDisplayName（target 在場時為其顯示名）`；`(c)／B-13 target 已被刪除（SET NULL 後）→ targetDisplayName: null，targetLabel 仍為快照`；`(e) createdAt 以 ISO 8601 UTC 字串輸出` | T2 | `GREEN`（T2 `1aec6ed`） |
| AC-04(d) | integration | 同上 | `PHASE-010-T2 — GET /admin/audit-logs` › `AC-04 列投影（AD-US-14② 之四要素）` › `(d) 十個 AuditAction 值逐一皆有一條真實列可被取回並通過 (a)~(c)`；`(d) 含 APPLICATION_VOIDED，且作廢原因逐字可見於 changes` | T2 | `GREEN`（T2 `1aec6ed`） |
| AC-05(a)(b)(c) | integration | 同上 | `PHASE-010-T2 — GET /admin/audit-logs` › `AC-05 授權矩陣（1 端點 × 5 身分 ＝ 5 格）`（該 describe 下 8 條 `it`：格 1~格 5 ＋ 三條 B-20 側信道） | T2 | `GREEN`（T2 `1aec6ed`） |
| AC-06(a)(b)(d)(e) | unit | `backend/test/unit/audit-summary-flatten.test.ts` | `AC-06: flattenAuditSummary 形狀分派與鍵守恆（刪鍵 mutant 必紅）` | T1 | `GREEN`（T1 `d7b70ad`） |
| AC-06(c)(f) | unit | 同上 | `AC-06(c)(f): 四種真實 summary 形狀皆成立且零 [object Object]` | T1 | `GREEN`（T1 `d7b70ad`） |
| AC-07(a)(b) | integration | `backend/test/integration/phase10-audit-completeness.test.ts` | `PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）` › `AC-07 — 七類事件端到端齊備回歸（AD-US-14①／BE-US-31）` › `AC-07: 七類事件經真實端點觸發後稽核列齊備且可經檢視端點取回`；`AC-07(a): 全表 action 分佈恰等於七類事件之預期計數（零額外／零缺漏稽核列）`；`AC-07(a)⑥: PARAMETER_VERSION_CREATED 之 summary.parameterType 三值逐一在場`；`AC-07(a)⑤: 作廢由本人與管理員各寫一條（BE-US-31② 之兩身分皆寫）` | T3 | `GREEN`（T3 `81dd7b9`） |
| AC-07(c) | integration | 同上 | `PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）` › `AC-07 — 七類事件端到端齊備回歸（AD-US-14①／BE-US-31）` › `AC-07(c): 本人自建草稿零稽核列（防恆真負向對照）`；`AC-07(c) 延伸: 管理員經代操作端點對自己建立草稿 → 零稽核列（C3 邊界）` | T3 | `GREEN`（T3 `81dd7b9`） |
| AC-08(a)(b) | integration | 同上 | `PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）` › `AC-08 — 代操作稽核之完整性回歸` › `AC-08: 代操作稽核完整性 — 作廢與修正版兩類（含三向零稽核邊界）` | T3 | `GREEN`（T3 `81dd7b9`） |
| AC-08(c) | integration | 同上 | `PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）` › `AC-08 — 代操作稽核之完整性回歸` › `AC-08(c): 兩類 summary 經 AC-06 扁平化後於列表可讀（作廢原因逐字可見、revisionOf 在場、鍵守恆）` | T3 | `GREEN`（T3 `81dd7b9`） |
| AC-09(a)(b) | integration | 同上 | `PHASE-010-T3 — 稽核完整性回歸（AC-07／AC-08／AC-09）` › `AC-09 — 密碼與敏感資料不入稽核之全表回歸` › `AC-09: 密碼與敏感資料不入稽核 — DB 全表 ＋ wire 面雙掃描`；`掃描器鑑別力自證：兩具掃描器對合成陽性樣本必拋（防恆真）`（後者亦為 AC-09(a) 允許集「子字串不放行」之守門——其 `expect(...).toThrow()` 樣本含 `mustChangePasswordExtra` 與 `{ field: "mustChangePassword" }` 兩則） | T3 | `GREEN`（T3 `81dd7b9`） |
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
| AC-15(a)(b)(c) | frontend | `frontend/test/AuditLogPage.test.tsx`／`HomePage.test.tsx` | `AC-15: 路由與管理員入口正負向；列表四要素` | T7 | `PENDING` |
| AC-16(a)(b)(c) | frontend | `AuditLogPage.test.tsx` | `AC-16: 篩選重置頁次；分頁邊界停用；參數確實送後端` | T7 | `PENDING` |
| AC-17 | frontend | 同上 | `AC-17: 五態逐格；Empty 與 Permission denied 文案可區辨` | T7 | `PENDING` |
| AC-18(a) | frontend | `frontend/test/AuditChangesList.test.tsx` | `AC-18(a): XSS payload 三型跳脫；DOM 零新增 script 節點` | T6 | `GREEN`（T6 `d625d94`） |
| AC-18(b) | frontend | 同上 | `AC-18(b): 巢狀混合 summary 渲染零 [object Object]（前端自帶負向）` | T6 | `GREEN`（T6 `d625d94`） |
| AC-18(c) | frontend | 同上 | `AC-18(c): 時間在地化單一形式；同頁不並存 ISO 原字串` | T6 | `GREEN`（T6 `d625d94`） |
| AC-19(a)~(d) | e2e | `e2e/audit-log.spec.ts` | `AC-19: 稽核頁端到端（建帳號＋作廢兩事件可見）／篩選／分頁／375px` | T8 | `PENDING` |
| AC-20(a)(b) | 全套件 | —（終審實跑對照） | 基準線 後端 3230／前端 346／E2E 50 不下降 | 全 Task | `PENDING` |
| AC-21(a)~(d) | integration | `backend/test/integration/phase10-error-handler-leak.test.ts` | `AC-21: 兜底不記原文 ＋ 站點白名單 ＋ 路徑反向探針 ＋ wire 零變更` | T9 | `PENDING`（D6=(a) 生效解鎖 2026-08-09） |
| AC-22(a)(b)(c)(d) | integration | 既有 contract 檔擴充 | `AC-22: REPORT_GENERATION_FAILED 改道 wire 逐位元組不變；errorLabel 收斂` | T10 | `PENDING`（D7=(a) 生效解鎖 2026-08-09） |

**合計 22 條 AC ／ 38 列映射**（含 **1 列** `N/A（非測試）`＝AC-14(c)，故**測試列為 37 列**；另 **1 列**為 §5 邊界列 B-17／B-18）。條件 AC（AC-14／AC-21／AC-22）已隨 Spec Gate 裁定於 2026-08-09 解鎖。
**狀態計數（本次修訂後）**：`GREEN` **25**／`PENDING` **12**／`N/A（非測試）` **1**＝38。

> `SPEC-REV-010-LITE`（2026-08-09）：新增 `buildAuditLogWhere` 一列（§11.1 該項原無映射落點，30 → 31 列），並將 T2 之七列以實際測試名逐字回填轉 `GREEN`。表內以 `A` › `B` 表示「`describe` A 之下的 `describe`／`it` B」。
>
> `SPEC-REV-010-LITE-2`（2026-08-09）：**31 → 38 列**，四處：①**T3 四列拆為七列**（AC-07(a)(b)／AC-07(c)／AC-08(a)(b)／**AC-08(c)**／AC-09(a)(b)／**AC-09(c)**／**AC-09(d)**）——原四列之「測試名」各僅載一個 `it` 名，但 (c)／(d) 於 `phase10-audit-completeness.test.ts` 實為**獨立 `it`**；本次以該檔實際 `describe`／`it` 名逐字補全（含 AC-07(a) 之三個補強格與 AC-09 之掃描器鑑別力自證格）。②**AC-01(d) 補第二落點**——同檔之 `FW-1（T2 即審）` 格（T2 版於 `Application` 恆空分支上為恆真，FW-1 為其實質補齊），該列改為兩檔並列。③**AC-14 一列拆為四列**（(a)／(b)／**(c)＝`N/A（非測試）`**／**(d)** 新列），(a) 列併入 T5R-LITE 之 SF-1 鑑別力格（`69d4cae`）。④**新增 B-17／B-18 落點列**（§11.2 已列 `B-14~B-18`，其中 B-17／B-18 原無映射落點）。**本次零 AC 語意變更**（AC-14(a) 之欄位級升格見 §2，方向為更嚴且實作已達標）。

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
| **T7** | 前端：稽核檢視頁（路由／入口／列表／篩選／分頁／五態） | FE | AC-15, AC-16, AC-17 | `frontend/src/pages/AuditLogPage.tsx`（新）、`frontend/src/App.tsx`（路由）、`frontend/src/pages/HomePage.tsx`（入口）、`frontend/test/AuditLogPage.test.tsx`（新）、`frontend/test/HomePage.test.tsx`（既有擴充）、`frontend/src/index.css` | Medium | T6 | FE 頁面型／**~140-195k** | — | 管理員入口正負向逐一；四要素逐列；篩選變更重置頁次；分頁邊界停用；**參數確實送後端**（前端零自行過濾之結構斷言）；五態逐格且 Empty 與 Permission denied 文案可區辨；既有 `HomePage.test.tsx` 零弱化 |
| **T8** | E2E Gate：稽核頁端到端 ＋ 375px | E2E | AC-19 | `e2e/audit-log.spec.ts`（新） | Medium | T7 | E2E Gate／**~150-265k** | — | 建帳號與作廢兩事件於稽核頁可見且四要素正確；篩選收斂；第 2 頁零重複；375px 零溢位；播種冪等；既有 50 條 E2E 零弱化 |
| **T9** | 【條件，依 D6】error-handler 兜底洩漏面收斂 | BE | AC-21 | `backend/src/platform/error-handler.ts`、`backend/test/integration/phase10-error-handler-leak.test.ts`（新）、`backend/test/integration/error-handler.test.ts`（既有，零弱化確認） | Medium | — | 小型接線／合約批次／**~110-170k** | — | 修復前反向探針必紅之物證；白名單掃描綠且新增站點必紅；`500` wire body 逐位元組不變；既有 `error-handler.test.ts` 全綠零改動 |
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
```

> **T4 之排程約束**：AC-10(c)（前端標籤表涵蓋全 10 值）之被測對象由 T7 產出，故 **T4 須排在 T7 之後**；若大總管希望提早結清結構面，正解為**拆出 `T4a`**（後端面：站點白名單 ＋ enum 封閉 ＋ 不可變性，可緊接 T2）與 **`T4b`**（標籤表涵蓋，排 T7 後），**不得**以壓縮斷言換取排程。
> **T5 可與 T1~T4 全段併行**（零檔案交集：`history.ts`／`admin/routes.ts` 不被其他 Task 觸及）。
> **T9／T10 為條件 Task**，僅於 D6／D7 裁定納入時開工；兩者與主線零檔案交集，可任意排程；**惟 T10 觸及 `applications/routes.ts`，須確認與任何其他觸該檔之工作不併行**。

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

### 15.4 Gate 規劃與走查腳本固化義務（跨 Phase 常設規則）

| Gate | 觸發時點 | 內容 | 走查腳本 |
|---|---|---|---|
| **Spec Gate（事前批准）** | 本 Spec 定稿後、任何 Task 開工前 | **D1~D12 逐條裁定** ＋ **4 項 High Task 事前批准** ＋ **3 列條件 AC 之取捨** ＋ **來源類別為「既有語意擴張／建議新增」之 AC 逐項確認**（§0.2 末段清單） | `docs/verification/WALKTHROUGH-PHASE-010-SPEC-GATE.md`（**本 Task 一併產出**） |
| **Mock Gate（稽核列表／篩選）** | T7 完成後（E2E 可先不完備） | 人類目視：列表四要素之可讀性、`changes` 前後摘要之呈現形式（**AD-US-14③ 之驗收核心**）、`action` 中文標籤逐值確認、篩選與分頁互動、長作廢原因之版面、375px 可讀、五態文案 | `WALKTHROUGH-PHASE-010-MOCK.md`（大總管於 T7 前產出） |
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
- **(a) 後端回 ISO 8601 UTC；前端以與列印版同型之台北時區在地化呈現**（沿 `report-labels.ts` :46 之 `formatTaipeiDateTime` 為唯一格式化來源之既有紀律）。
- (b) 後端直接回在地化字串。
- (c) 後端同時回兩者。

**影響**
- (a)：契約單純（ISO 為機器可讀之單一真值）；前端在地化與列印版一致，使用者體驗統一；**須**在前端建立同型格式化（可抄 `report-labels.ts` 之邏輯或建共用 util）。
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
