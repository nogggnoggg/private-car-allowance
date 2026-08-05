# 人類複驗走查腳本 — PHASE-007-REV2（G1 檢視連結三型／G2 參數頁縮欄）

> **常設規則首例（人類 leonchih 2026-08-06 裁定）**：每次人類複驗之 step-by-step 走查腳本固化於 `docs/verification/`，供後續 loop agent 對照最新架構確認腳本是否仍有效（路由、入口文字、預期畫面是否漂移）。

| 項目 | 內容 |
|---|---|
| Walkthrough ID | WALKTHROUGH-PHASE-007-REV2 |
| 建立日期 | 2026-08-06 |
| 驗證對象 | 裁定 G1（AC-62，`4115cae`）／裁定 G2（AC-61R，`9a01f61`） |
| 規範錨點 | `docs/specs/PHASE-007.md` §20.17.1（AC-62）、§20.17.2（AC-61R） |
| 適用 HEAD | `e5f98fc`（branch `phase-007`） |
| 複驗結果 | **通過**（人類 leonchih 2026-08-06 回報「複驗完成」，未回報任何異常；G1 三型檢視連結與 G2 參數頁縮欄兩點皆確認） |

## 前置條件（loop agent 檢核點 P1~P4）

| # | 條件 | 檢核方式 |
|---|---|---|
| P1 | dev 拓撲三服務運行：frontend `http://localhost:5173`／backend `:3000`／DB `t1-pg`（`localhost:55432/app_test`） | `curl :5173`＝200、`curl :3000/health`＝200 |
| P2 | 管理員合成帳號 `e2eadmin`（密碼見 `e2e/depreciation-allowance.spec.ts` :62，合成憑證） | 可登入 |
| P3 | 走查帳號 `gate-depr-01`（2026-08-05 Gate 走查建立、資料保留）：差旅 COMPLETED×2＋折舊 DRAFT×1＋折舊 COMPLETED×1 | DB 查 `Application` by owner |
| P4 | 保養資料帳號 `e2e-maint-msebfzzv372`：差旅 COMPLETED＋保養 DRAFT＋保養 COMPLETED | 同上 |

## G1 走查步驟（AC-62：操作欄「檢視」連結三型一致）

| 步驟 | 操作 | 預期結果 | 規範錨點 |
|---|---|---|---|
| 1 | 開 `http://localhost:5173`，以 `e2eadmin` 登入 | 進入首頁 | — |
| 2 | 點「使用者管理」→ 找 `gate-depr-01` → 點該列「**申請紀錄**」按鈕 | 進入該使用者申請列表（`/admin/users/{id}/applications`） | AC-62(d) |
| 3 | 看列表「操作」欄 | **每一列**（含差旅、折舊；含草稿與已完成）都有「檢視」連結；**沒有任何一列顯示「—」** | AC-62(a)(c)(e) |
| 4 | 點折舊「已完成」列的「檢視」 | 進入折舊詳情頁（`/applications/depreciation/{id}`），顯示快照五值（每年折舊費用／年度公務里程／年度總里程／公務比例／金額） | AC-62(b) |
| 5 | 返回列表，點折舊「草稿」列的「檢視」 | 進入同一折舊頁之草稿態（可編輯） | AC-62(c) |
| 6 | 回「使用者管理」→ 找 `e2e-maint-msebfzzv372` → 「申請紀錄」→ 點保養列「檢視」 | 進入保養詳情頁（`/applications/maintenance/{id}`） | AC-62(b) |
| 7 | （可選）以 `gate-depr-01` 登入本人首頁 | 本人列表「操作」欄同樣三型皆有「檢視」（同一共用元件，行為一體） | AC-62(d) |

## G2 走查步驟（AC-61R：折舊參數版本清單縮欄）

| 步驟 | 操作 | 預期結果 | 規範錨點 |
|---|---|---|---|
| 8 | 以 `e2eadmin` 回首頁 → 點「**補助參數維護**」 | 進入 `/admin/parameters` | — |
| 9 | 捲動至「折舊參數」區塊，看版本清單表頭 | **恰 5 欄**：生效日期／車價（元）／折舊年限（年）／每年折舊費用（元）／建立時間；**「預估年里程（公里）」與「每公里單價（元）」兩欄不存在**（含歷史版本列——原值不再顯示，也沒有「—」佔位欄） | AC-61R(c)(d)(e) |
| 10 | 看同區塊建立表單 | 仍為三欄：車價／折舊年限／生效日期；預覽仍顯示「每年折舊費用」、不顯示每公里單價 | AC-61R(a)(b) |
| 11 | 對照 ETC 區塊 | ETC 的「每公里單價（元）」欄**仍在**（不受 G2 影響） | AC-61R(g) |

## Loop agent 對照架構檢核指引

腳本失效訊號（任一命中即回報大總管，勿自行改腳本）：
1. 路由漂移：`frontend/src/App.tsx` 不再含 `/applications/{travel|maintenance|depreciation}/:id` 或 `/admin/users/:userId/applications`、`/admin/parameters`。
2. 入口文字漂移：`AdminUsersPage.tsx` 無「申請紀錄」按鈕；`HomePage.tsx` 無「補助參數維護」連結。
3. 元件漂移：`ApplicationListSection.tsx` 之 `TYPE_DETAIL_PATHS` 不存在或操作欄出現條件分支；`ParametersPage.tsx` 折舊表頭欄數 ≠ 5。
4. 規範漂移：Spec §20.17.1/§20.17.2 被 SUPERSEDED 或 AC-62/AC-61R 有後續修訂列。
5. 資料前提失效：P3/P4 帳號或其申請組合不存在（R13 型清理、資料重置後須重播種）。
