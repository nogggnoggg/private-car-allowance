# PROJECT_STATE

State: PLANNING
Governance-Version: 2026-08-01.1
Updated: 2026-08-01

## 目前狀態

- Preflight 完成，Project Execution Profile 已由使用者確認（2026-08-01）。
- 已確認決策：
  - AI 協作模式：Claude 多 Agent（spec-writer / implementer / reviewer，依序執行）
  - 治理強度：Standard；認證／授權／密碼／附件權限 Task 一律 High
  - 技術棧：React+Vite / Fastify+Prisma / PostgreSQL 16 / Playwright PDF（全 TypeScript）
  - Git：本機 git + GitHub 私有 repo `nogggnoggg/private-car-allowance`
  - 部署方向：Zeabur（三容器分離）；本機 Docker Compose
- 已確認假設：
  - A1 UI 與報表語言 zh-TW
  - A2 附件／PDF 走 storage 抽象層＋env 指定路徑之持久化 volume；MVP 不做 S3
  - A3 備份交付腳本＋Runbook；實際排程與異地保存為部署時人工設定
  - A4 認證採 Cookie Session（HttpOnly／SameSite；正式環境 Secure）
  - A5 Repo 名稱 private-car-allowance

## 目前 Phase

- 無（規劃中）。下一步：spec-writer 產出 PRD、ARCHITECTURE、DATA_FLOW 草案與 Phase 拆分。

## Task 狀態

- PLAN-001（spec-writer：PRD + Phase 拆分 + Architecture/Data Flow 草案）：PLANNED

## 阻塞

- 無。

## Human Gate（待觸發）

- PRD／Phase 拆分審閱（含 High 風險項標記）
- 各 Phase 的 Mock UI 驗收、整合驗收
- 正式合併與發布

## Base Commit

- （初始 commit 後填入）

## 備註

- Bootstrap 階段（治理文件與規劃文件）直接 commit 至 main；自 Phase 1 起改為 Phase branch + Draft PR。
