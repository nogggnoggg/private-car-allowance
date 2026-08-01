# PROJECT_STATE

State: PLANNING
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
  - 部署方向：Zeabur（三容器分離）；本機 Docker Compose
- 已確認假設：A1 zh-TW、A2 storage 抽象層＋volume（無 S3）、A3 備份腳本＋Runbook、A4 Cookie Session、A5 repo 名稱

## 目前 Phase

- 無（等待 Human Gate：PRD／Phase 拆分審閱）。
- Phase 拆分：PHASE-001 骨架/CI → 002 認證帳號 → 003 附件基礎 ∥ 003a 補助參數 → 004 差旅（核心）→ 005 區間統計 → 006 保養 → 007 折舊 → 008 報表/PDF → 009 修正版/作廢 → 010 稽核 → 011 部署硬化與備份。詳見 docs/PRD.md 第 5 節。

## Task 狀態

- PLAN-001（PRD + Phase 拆分 + Architecture/Data Flow 草案）：DONE
- SPEC-001（撰寫 docs/specs/PHASE-001.md 詳細 Spec）：PLANNED（待 Phase 拆分審閱通過）

## 阻塞

- Human Gate 待決：PRD／Phase 拆分審閱（含 PHASE-003a 提前調整、High 風險 Task 標記）。

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
