# PROJECT_STATE

State: ACTIVE
Governance-Version: 2026-08-01.1
Updated: 2026-08-01

## 目前狀態

- Preflight 完成，Project Execution Profile 已由使用者確認（2026-08-01）。
- PLAN-001 完成：`docs/PRD.md`（ACTIVE，含 12 Phase 拆分與 88 條 US 對應表）、`docs/ARCHITECTURE.md`（DRAFT）、`docs/DATA_FLOW.md`（DRAFT）已由 spec-writer 產出、大總管驗收。
- 已確認決策：
  - AI 協作模式：Claude 多 Agent（spec-writer / implementer / reviewer，依序執行）
  - 治理強度：Standard；認證／授權／密碼／附件權限 Task 一律 High
  - 技術棧：React+Vite / Fastify+Prisma / PostgreSQL 16 / Playwright PDF（全 TypeScript）
  - Git：本機 git + GitHub 私有 repo `nogggnoggg/private-car-allowance`
  - 部署方向：前端/後端/PostgreSQL 三服務全部署於 Zeabur（ADR-0001，2026-08-01 人類確認）；同源策略 nginx proxy /api；本機 Docker Compose 同構模擬
- 已確認假設：A1 zh-TW、A2 storage 抽象層＋volume（無 S3）、A3 備份腳本＋Runbook、A4 Cookie Session、A5 repo 名稱

## 目前 Phase

- PHASE-001 專案骨架與 CI 基礎（branch: phase-001，IN_PROGRESS）。
- Phase 拆分審閱：已通過（人類批准，2026-08-01）。
- 全案順序：001 骨架/CI → 002 認證帳號 → 003 附件基礎 ∥ 003a 補助參數 → 004 差旅（核心）→ 005 區間統計 → 006 保養 → 007 折舊 → 008 報表/PDF → 009 修正版/作廢 → 010 稽核 → 011 部署硬化與備份。詳見 docs/PRD.md 第 5 節。

## Task 狀態

- PLAN-001（PRD + Phase 拆分 + Architecture/Data Flow 草案）：DONE
- SPEC-001（docs/specs/PHASE-001.md 詳細 Spec）：DONE（commit 8e41e28）
- PHASE-001-T1（monorepo 骨架 + lint/TS 工具鏈）：DONE（workspace 工具改裁 npm，見 Spec 3.1 修訂）
- PHASE-001-T2（Fastify/health/Prisma/env）：DONE（9/9 測試通過，大總管獨立重跑驗證；Prisma 定版 5.22 因 v7 schema 語法不相容，屬實作細節）
- PHASE-001-T6（錯誤協定 + error handler）：DONE（22 新測試；全套 27/27 綠，大總管重驗；lint 遺漏由大總管代修：format/organizeImports/1 處 non-null assertion）
- PHASE-001-T3（React 前端 + /api/health + dev proxy）：DONE（3/3 測試綠；大總管重驗 build exit=0、dist 完整；implementer 回報的 0xC0000409 build crash 未重現）
- PHASE-001-T4（Dockerfile×2 + compose + .env.example）：READY
- PHASE-001-T5（CI）：PLANNED
- 待 Review 事項（reviewer 用）：
  - health.ts 記錄 DB 探測 err.message 原文（理論外洩面，Prisma 實務不含憑證，評 Low）
  - dotenv@17 對 stdout 印提示訊息（容器無 .env 不受影響）
  - 日誌重複 requestId 鍵（transport 與手動各加一次，cosmetic）
  - health「DB up」測試在本機無 DB 時 fail 而非 skip（CI 有 DB service 不受影響；skip guard 待改善）

## 環境備註（後續 Task 必讀）

- 本機為 Windows 11、Node 25、npm 11；**pnpm 在中文路徑會崩潰，已裁示全案改用 npm workspaces**。
- npm 11 會封鎖新依賴的 postinstall scripts：新增含 postinstall 的依賴後需 `npm approve-scripts` 並確認 `package.json` 的 `allowScripts`。
- 容器與 CI 鎖 Node 20 LTS；本機 Node 25 僅開發用。

## 阻塞

- 無。

## 跨 Phase 追蹤事項（來自 PLAN-001 Handoff）

- AD-US-04「有歷史拒刪」完整語意於 PHASE-010 回歸驗證。
- BE-US-25 的 24 小時暫存清理排程歸 PHASE-011；核心生命週期在 PHASE-003/004。
- FE-US-05 報表編號關鍵字查詢於 PHASE-008 後完整驗收。
- ARCHITECTURE 開放問題：Playwright 封裝方式（PHASE-008 Spec）、Session 儲存後端（PHASE-002 Spec）、報表編號併發安全（PHASE-008 Spec）。

## Human Gate（待觸發）

- 【當前】PRD／Phase 拆分審閱
- 各 High 風險 Phase 事前批准（002/003/003a/004/006/007/008/009/010/011）
- 各 Phase Mock UI 驗收、整合驗收
- 正式合併與發布

## Base Commit

- main @ 734e03a（本次 commit 後更新）

## 備註

- Bootstrap 階段（治理文件與規劃文件）直接 commit 至 main；自 PHASE-001 起改為 Phase branch + Draft PR。
