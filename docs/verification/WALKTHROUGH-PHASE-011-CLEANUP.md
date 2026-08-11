# WALKTHROUGH — PHASE-011 清理啟用前人工確認 Gate

- 產出：大總管（2026-08-11；Spec §15.4 新設 Gate——不可逆刪除之最後人類關卡）
- 前提：T3/T3R 全鏈 APPROVE＋T4/T4R（關閉確認完成後本欄更新：＿＿＿）
- 裁定人：leonchih
- 預估時間：10~15 分鐘（dev 環境，全合成資料；本 Gate 通過前清理**不會**在任何環境被排程執行）
- 執行方式：以下指令由大總管在您在場時代跑並展示輸出，或您自行複製執行皆可。

## 您在批准前應知道的三件事（據實揭露）

1. **今日實際生效的判準只有兩條**：`status=TEMP` 且 `建立時間逾 24 小時`。走查腳本裡看到的「四項引用保護」中，三條容器存在性檢查在現行系統不變式下（TEMP 附件的引用欄恆為空——經 src 寫入路徑全查證＋結構證據雙重覆核）**一次都不會觸發**，屬防禦縱深。真正天天在擋的是：TEMP 過濾（LINKED 連掃描都不進）、TTL 嚴格大於、刪除瞬間的條件式比對（期間被關聯走就放手）。
   **樣本來源正名（T4R 關閉確認 NF-1）**：開發過程引為佐證的資料快照（136 筆稽核×97 筆附件×13 筆 TEMP）出自**測試庫 `app_test`**（t1-pg:55432，`.env` 所指），非 compose 之 dev DB——決定性證據始終是**靜態查證**（稽核 summary 組裝站點全查＋TEMP 寫入站點恰二皆零引用），資料快照僅為佐證。本走查之 dry-run 亦跑在同一測試庫上，資料全合成。
2. **設定寫錯不會默默刪東西**（T4R 修復後行為）：env 任何變數不合規，CLI 直接拒跑、結束碼 1、零刪除——修復前它會靜默改用預設 24 小時門檻執行，此缺陷已由即審攔下並結清。
3. **B-04 孤兒弱引用是唯一反直覺路徑**：`refId` 指向已不存在容器的 TEMP 附件會被視為「無引用、可刪」（與既有系統語意一致）。走查第 3 步請特別看這型。

## 走查步驟

### 第 1 步：設定防呆展示（親眼確認「寫錯不會刪」）

```bash
cd "E:\Claude Project\油資\backend" && ATTACHMENT_CLEANUP_BATCH_LIMIT=0 npx tsx src/attachment/cleanup-cli.ts --dry-run
```

- 預期：`{"stage":"config-error","detail":"ATTACHMENT_CLEANUP_BATCH_LIMIT"}`＋結束碼 1、零輸出候選、零刪除。
- 結果：

### 第 2 步：正式 TTL 之 dry-run（樣張 A——以此為批准基準）

```bash
cd "E:\Claude Project\油資\backend" && npx tsx src/attachment/cleanup-cli.ts --dry-run
```

- 預期：逐筆 `candidate` 輸出（若有）＋`summary` 一行。候選中**不應**出現任何「看起來應該保留」的項目；輸出零 storageKey／零檔名／零擁有者。
- 檢核點：①候選各筆 `overdueHours` 均為正②`referenceChecks` 四項均 `false`③被引用（LINKED）附件不在清單中（可與 DB 計數對照）。
- 結果：

### 第 3 步：候選清單長相與 B-04 型（樣張 B——縮短 TTL 讓候選現形，仍為唯讀）

```bash
cd "E:\Claude Project\油資\backend" && ATTACHMENT_TEMP_TTL_HOURS=1 npx tsx src/attachment/cleanup-cli.ts --dry-run
```

- 目的：僅為目視候選清單格式（dry-run 唯讀，不刪任何東西）；重點看是否可讀、四要素是否齊。
- 結果：

### 第 4 步：批次上限與摘要語意確認（口頭確認即可）

- 單次執行上限 500 筆（`ATTACHMENT_CLEANUP_BATCH_LIMIT` 可調）；`hasMore: true` 表示還有下一批。
- 結束碼契約：0＝全數成功（含零候選）；1＝任何失敗／設定錯誤——外部排程只需判非零告警。
- **維運注意（AR-2 登記）**：若連續多次出現 `candidateCount=0` 且 `hasMore=true`，代表批次頭部被卡住需人工介入——結束碼不會告訴你，屬 Runbook 監測項（T14 落地）。
- 結果：

## 本 Gate 裁定的是什麼

- ✅ 批准＝「dry-run 候選判定正確，允許清理進入可執行狀態」（實際排程仍為部署時人工設定——PRD :526；本 Phase 只交付 CLI 與 Runbook）。
- ❌ 本 Gate 不批准：正式環境排程啟用（屬部署時決策）、備份還原（T12/T13 另有整合 Gate）。

## Gate 結果（大總管回填）

- **執行方式變更（人類 leonchih 2026-08-11 裁定）**：「這種純 coding 的部份這次讓你驗，通過後跟我說」——本 Gate 之技術驗證由大總管代跑並全程記錄，使用者依報告做最終批准。
- 裁定日期：2026-08-11（大總管代跑完成；使用者批准狀態見下）
- 各步結果（全數通過，完整輸出見 session 記錄）：
  1. 設定防呆：`ATTACHMENT_CLEANUP_BATCH_LIMIT=0` → `{"stage":"config-error","detail":"ATTACHMENT_CLEANUP_BATCH_LIMIT"}`＋EXIT=1、零刪除 ✅
  2. 正式 TTL dry-run：掃描 13 筆 TEMP、候選 **0**（全數尚未滿 24h——嚴格大於正確）、EXIT=0 ✅
  3. TTL=1h 候選目視：13 筆候選逐筆輸出、四項引用檢查全 false、`referenced:true` 計 0、禁字（storageKey/檔名/擁有者）計 0；LINKED 84 筆連掃描都不進（scannedCount=13 恰為 TEMP 數）；本庫無 B-04 孤兒型資料（與 AR-1 揭露一致）✅
  4. DB 計數前後全等（LINKED 84／TEMP 13 → 84／13）——dry-run 唯讀實證 ✅
- 總結：候選判定正確、防呆有效、輸出可讀且零敏感欄位。
- 使用者批准：
