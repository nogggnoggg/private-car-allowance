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
- PHASE-001-T4（Dockerfile×2 + compose + .env.example）：DONE（五步整合驗收通過；大總管複驗 health 200/SPA 200/資料持久化）
- PHASE-001-T5（CI）：DONE（run 30693648259 全綠；gate 紅→綠驗證 run 30693595614 failure→revert 轉綠）
- PHASE-001：REVIEW（reviewer 獨立審查中）
- PHASE-001-REVIEW（reviewer 獨立審查）：DONE。結果：無 Must Fix；SF-1（Should Fix）＝日誌可含連線字串/stack 敏感內容（health.ts 記 err.message 原文、error-handler 記完整 stack、pino redact 未覆蓋 err）；AR-2 dotenv stdout 提示（Accepted/Low）；AR-3 重複 requestId 鍵（Accepted/Low）；AR-4 無 DB 時測試為 **skip 非 fail**（更正先前記錄；Accepted/Low，CI 有 DB service 覆蓋）。14 條 AC：13 PASS、AC-12 PARTIAL（缺口即 SF-1）。
- PHASE-001-T7（REPAIR：修 SF-1 + 順修 AR-3）：DONE（sanitizeForLog 純函式供全案沿用；500 不記 stack 只記 name+sanitized message；26 新測試；全套 53/53 綠，大總管重驗）
- PHASE-001：**DONE**。整合驗收通過、PR #1 經人類批准合併至 main（281b744，2026-08-01）。
- SPEC-002：DONE。**D1~D11 全數人類批准（2026-08-01）**，Spec 轉 ACTIVE。
- PHASE-002（認證與帳號管理，branch: phase-002）：IN_PROGRESS
  - T1 資料模型（User/Session/AuditLog + migration）：READY
  - T2~T11：PLANNED（順序 T1→T2→T3→T4→T5→T6→T7→T8→T9→T10→T11）
- Accepted Risk（已記錄）：AR-2 dotenv stdout 提示（Low）；AR-4 無 DB 時 integration 測試 skip（Low，CI 有 DB service 覆蓋）；sanitizeForLog scheme 清單需隨新連線字串型態擴充（記入後續 Phase 注意事項）

## 環境備註（後續 Task 必讀）

- 本機為 Windows 11、Node 25、npm 11；**pnpm 在中文路徑會崩潰，已裁示全案改用 npm workspaces**。
- npm 11 會封鎖新依賴的 postinstall scripts：新增含 postinstall 的依賴後需 `npm approve-scripts` 並確認 `package.json` 的 `allowScripts`。
- 容器與 CI 鎖 Node 20 LTS；本機 Node 25 僅開發用。
- **本機 Docker 指令必帶 workaround**（中文路徑）：`DOCKER_BUILDKIT=0 docker compose -p oilexpense <cmd>`——BuildKit 對非 ASCII 路徑會失敗、專案名稱需以 -p 指定。CI/Linux 不受影響。
- npm workspaces 不會把 prisma/@prisma/client hoist 到根 node_modules；backend Dockerfile 需同時複製根與 backend 兩層 node_modules（已實作，未來加後端依賴時維持此模式）。
- node:20-slim 需 apt 安裝 openssl 供 Prisma 使用（已寫入 Dockerfile）。

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

- main @ 281b744（PHASE-001 合併後）；工作 branch：phase-002

## 備註

- Bootstrap 階段（治理文件與規劃文件）直接 commit 至 main；自 PHASE-001 起改為 Phase branch + Draft PR。
