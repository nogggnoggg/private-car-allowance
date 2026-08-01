# PROJECT_STATE

State: ACTIVE
Governance-Version: 2026-08-01.2
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

- PHASE-003 附件基礎（branch: phase-003，IN_PROGRESS）。
- 開工批准：使用者於 2026-08-01 批准「003 → 003a 依序執行」（照 PRD 編號；003a 待 003 完成後接續，無需再次開工批准，但其 Spec 仍需事前批准）。
- Phase 開工重錨定：大總管已重讀治理 2026-08-01.2「大總管禁止事項」節並確認（2026-08-01）——零程式修改、白名單外一律派 implementer、未經 reviewer 審查不合入。
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
  - T1 資料模型：DONE（62/62）
  - T2 密碼雜湊（argon2id + 10k 弱密碼清單，大總管補足清單至 D6 規模）：DONE（87/87）
  - T3 登入/Session/Cookie（22 新測試；統一 401 逐字驗證）：DONE（109/109，大總管複驗）
  - T4 失敗鎖定：DONE（122/122；大總管修 1 個 race 型 flaky 斷言）
  - T5+T6 授權中介層（requireAuth/requirePasswordChanged/requireAdmin/assertOwnershipOrAdmin）：DONE（140/140）
  - T7+T8 改密流程（/me/password 共用端點，D10 驗證）：DONE（161/161）
  - T9+T10 管理員帳號管理＋稽核＋seed:admin：DONE（197/197，大總管複驗）
  - T11 前端頁面：DONE（30 前端測試；E2E 由大總管於 compose 正式拓撲實跑通過）
- PHASE-002-REVIEW：DONE。29 AC＝27 PASS + 2 PARTIAL（皆已處置）；D1~D11 忠實落地；無 Must Fix。SF-1（pino redact 欄位不齊，AC-27 防護網缺口）已由大總管修復（logger 增補 4 欄位＋萬用巢狀路徑＋2 測試）；AR-6（多餘 @types/react-router-dom）已移除。
- PHASE-002 Accepted Risk（Low，記錄保留）：AR-1 production Secure cookie 無自動化測試；AR-2 弱密碼清單對 ≥10 字元密碼有效覆蓋 208 筆（短密碼由長度規則先擋）；AR-3 session 撤銷用硬刪（Spec 允許）；AR-4 auth plugin parseEnv 防禦性 fallback 為死碼（建議後續清理）；AR-5 seed:admin TOCTOU（部署一次性情境可接受）；AR-7 wrong-password 路徑 ~1ms DB write 時間差（可忽略）。
- PHASE-002：**DONE**。Mock/整合驗收通過（人類，2026-08-01，含 Gate 反饋修正：強制改密頁登出出口）；PR #2 經人類批准合併至 main（e0e2d14）。
- 治理事件（2026-08-01）：使用者指出大總管兩項違規（直接實作未派工；行為變更未先改 Spec）。根因分析（規則明確度為主因、派工成本為中因、context 長度為放大器）經使用者確認；解方 S1~S5 經使用者批准並執行：治理升版 **2026-08-01.2**（大總管零程式修改白名單、Gate 反饋明文流程、Lite Packet／輕量複審通道、commit 前 Task ID 自檢、Phase 開工重錨定）。
- S5 補救審查（reviewer 事後審 b76f44b、acbb327）：DONE — **APPROVE**。無 Must/Should Fix；測試鑑別力經反向驗證（拿掉修復後測試會紅）；231 測試（後端 199＋前端 32）無回歸。新增 Accepted Risk：AR-S5-1（Low）pino `*` 萬用路徑僅遮蔽單層巢狀，兩層以上不遞迴——防禦縱深已知邊界，正常程式不記 request body，記錄保留；AR-S5-2（觀察）PHASE-002 Spec 檔內版本戳仍為 .1，下次動該檔時一併更新。
- 治理事件結案：違規已補救、規則已升版固化（2026-08-01.2）。
- SPEC-003（docs/specs/PHASE-003.md 詳細 Spec）：DONE（commit 4c0ce84；驗收時發現 §4.6 與 D8 文字矛盾，已由 spec-writer 修正）。
- PHASE-003 Spec Gate：**已通過**（2026-08-01）——D1~D8 全數照建議批准；D5＝自寫 magic-byte 偵測＋sharp 縮圖（build 不可行則回退前端縮放並記 Accepted Risk）。Spec 轉 ACTIVE。
- PHASE-003-T1（Attachment 資料模型 + migration，Medium）：DONE（199ffdd；乾淨 DB 3 migration 套用成功，大總管重驗 lint/tsc/測試）。
- PHASE-003-T1R（REPAIR：測試隔離）：DONE（d08ee5e）。根因：T1 新增 Attachment→User FK(RESTRICT) 引爆 phase2-models.test.ts 的全域 user.deleteMany（平行執行相撞→清理靜默失敗→殘留資料）。修復：清理限定自建 loginName + beforeAll 自癒；大總管於髒 DB 連跑兩輪 209/209 全綠驗證。implementer 首輪回報 14/14 綠屬執行順序運氣，未發現此問題——**驗收紀律追加：資料模型類 Task 驗收一律同 DB 連跑兩輪**。
- 測試隔離備註（後續 Task Packet 必含）：新測試檔清理一律限定自建資料，禁用全域 deleteMany；phase3-attachment-model.test.ts 現有全域 attachment.deleteMany({}) 目前安全（Attachment 為葉節點且僅該檔建立附件），但 T3/T5/T6 新測試檔開始建附件後即成地雷，屆時一併改為範圍清理。
- PHASE-003-T2（Storage 介面 + LocalVolumeStorage + env）：DONE（131dec4；key 白名單主防護 + 含入次防護；大總管重驗兩輪 15/15、全 repo biome/tsc）。範圍偏差已驗收接受：env 一次補齊 Spec §8 四變數；auth/routes.ts fallback 物件補欄位（AppConfig 型別連鎖，5 行機械性）——AR-4 死碼 fallback 清理需求再+1。
- PHASE-003-T2R（REPAIR：.gitignore `storage/`→`/storage/` 根錨定）：DONE（4ea8836）。根因：PHASE-001 未錨定模式誤傷 backend/src/storage 原始碼；T2 commit 未 push 前發現，add -f + amend 保持 atomic。
- PHASE-003-T3（上傳與驗證，High）：DONE（5cf04d8）。首輪驗收退回兩項：server.ts 寫死 `/tmp/att-storage` fallback（違反 Spec §8 無寫死/NFR-US-07）→ 改 production fail-fast + 非 production 動態 tmpdir；§9.2 補償刪除測試缺失 → 補 6 個 stub 測試（DB 失敗/縮圖 put 失敗/驗證失敗三情境）。sharp 0.35.3 採用成功（無需 approve-scripts）；+51 測試（303 總）。大總管重驗兩輪 18/18、biome/tsc、AC-02 測試名實抽查。
- Phase 整合驗收待辦：Docker 容器 build 需驗證 sharp 之 libvips runtime（node:20-slim）；Zeabur/compose 必設 ATTACHMENT_STORAGE_ROOT（production 現會 fail-fast）。
- 待 Review 事項（PHASE-003 reviewer 用）：LocalVolumeStorage 內部同步 fs（readFileSync/writeFileSync）於 async 介面下阻塞 event loop——功能過 AC，效能/慣例問題請 reviewer 權衡（10MB 上限內風險有限，改 fs/promises 非破壞性）；AppConfig 防禦性 try/catch fallback 字面量已擴散至第三處（env→auth/routes→server.ts），AR-4 清理升級為應處理項。
- 派工紀律備註：implementer 兩度（T6、T3）聲稱 lint 通過但實況有 error——後續 Packet 一律要求貼上 biome check 實際輸出；大總管驗收必自跑 lint。
- 待 Review 事項（Phase 結束 reviewer 用）：auth routes 內 parseEnv 防禦性 try/catch（implementer 自承不應複製的模式）；revokeAllUserSessions 用硬刪除而非 revokedAt 軟刪（Spec 允許，稽核性差異）；production Secure cookie 屬性無自動化測試（條件式程式碼，Low）
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

- 【當前】PHASE-003 Mock UI／整合驗收（T7 完成後）
- 003a Spec 事前批准（003 完成後）；其後各 High 風險 Phase 事前批准（004/006/007/008/009/010/011）
- 各 Phase Mock UI 驗收、整合驗收
- 正式合併與發布

## Base Commit

- main @ e5397c1（PHASE-002 合併＋治理事件結案後）；工作 branch：phase-003

## 備註

- Bootstrap 階段（治理文件與規劃文件）直接 commit 至 main；自 PHASE-001 起改為 Phase branch + Draft PR。
