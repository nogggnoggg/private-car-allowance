# CLAUDE.md — 私車差旅補助管理系統

內部 Web 系統：員工申報私車差旅油資／ETC 補助、保養費用分攤、年度折舊補貼；管理員管理帳號、全域補助參數、代操作與稽核。

## 事實來源（優先序）

1. 最新人類確認決策（記錄於 Spec / ADR / PROJECT_STATE.md）
2. `userstory.md` — User Story 與驗收條件定稿（不得由 AI 改變原意）
3. `docs/PRD.md`、Active Phase Spec（`docs/specs/`）
4. `docs/ARCHITECTURE.md`、`docs/DATA_FLOW.md`、ADR（`docs/adr/`）
5. 程式與測試的當前實作

## 技術棧（人類已確認）

- 前端：React 18 + TypeScript + Vite（容器：nginx）
- 後端：Node.js + Fastify + Prisma ORM + TypeScript（容器：node）
- 資料庫：PostgreSQL 16（獨立容器／受管服務）
- PDF：Playwright (Chromium) 渲染列印版 HTML（列印版與 PDF 同一版型）
- 測試：Vitest（unit/integration）+ Playwright（E2E）
- 部署：Zeabur 優先；本機 Docker Compose；環境差異一律用環境變數

## 工程規則

- SDD：先有 ACTIVE Phase Spec 才能實作；Spec 在 `docs/specs/PHASE-XXX.md`
- TDD：先寫會失敗的測試，再實作；不得刪除、弱化、skip 測試換綠燈
- 金額計算：一般四捨五入（0.5 進位），不用銀行家取整；最終金額為新臺幣整數
- 金額與里程計算一律以後端為準，前端預覽僅供參考，後端不得採用前端提交的金額
- 日期區間起訖日均含當日；差旅依「出差日期」歸屬期間與年度
- 已完成申請不可修改，只能作廢或建立修正版；計算完成時保存快照
- 認證、授權、密碼、附件權限相關工作一律 High 風險，需人類事前批准

## Git

- `main` 為保護分支；一個 Phase 一個 branch + Draft PR；一個 Task 一個 atomic commit
- 正式合併與正式發布需人類批准；不得 force push、不得改寫共享歷史
- Remote：GitHub 私有 repo（nogggnoggg/private-car-allowance）

## 禁止事項

- 不得使用真實個資、真實密碼、真實 secrets；開發測試全程合成資料
- Secrets 不寫入程式、commit、log 或文件；一律環境變數
- 不得在 log 記錄密碼、token、session cookie
- 不得聲稱未實際執行的測試已通過

## 常用指令

（骨架建立後於此補充 build / test / lint 指令）

## 治理

流程治理依 `/orchestrator`（Governance-Version 2026-08-01.1）；專案狀態見 `PROJECT_STATE.md`。

### 大總管行為限制（2026-08-01 使用者裁定，違規事件後補強）

- 大總管（Orchestrator）**不得直接修改任何程式、測試、設定或資料檔**——含 lint 修復、格式化、測試修正等機械式工作，一律派 implementer；大總管僅編排、驗收、commit 經驗收的產出與維護治理文件（PROJECT_STATE、Spec 狀態欄、ADR 記錄）。
- 任何行為變更（含 Human Gate 反饋的小變更）標準順序：**先 Spec 修訂（引用人類批准）→ 派 implementer TDD → reviewer 審查 → 合入**。變更規模不是豁免條件。
- 未經 reviewer 審查的程式變更不得合入 main。
