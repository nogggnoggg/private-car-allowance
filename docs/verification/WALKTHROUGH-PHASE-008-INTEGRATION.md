# 人類檢核走查腳本 — PHASE-008 整合 Gate（容器端到端目視）

| 項目 | 內容 |
|---|---|
| Walkthrough ID | WALKTHROUGH-PHASE-008-INTEGRATION |
| 建立日期 | 2026-08-07（夜間；機器可驗部分已由大總管完成並附證據） |
| 檢核對象 | **容器版**系統（`oilexpense` compose stack @ `http://localhost:8080`）之報表端到端＋PDF 品質 |
| 檢核性質 | 整合 Gate（真實前後端整合驗收；產品 Gate） |
| 檢核結果 | **待檢核** |

## 這次要做什麼（30 秒版）

用**容器版**（不是平常開發用的 5173）親手跑一次「產生報表→看列印版→下載 PDF」，目視 PDF 品質（重點：**繁體字形**）。機器能驗的我都驗完了（下方有證據清單），剩下的是只有人眼能判斷的項目。預計 10~15 分鐘。

## 大總管已完成之機器驗證（附證據，您不用重做）

| 項 | 結果 |
|---|---|
| 映像重建 | backend **2.08GB**（與 T7bR 記錄終值一致）、frontend 238MB |
| 容器拓撲 | 三容器健康、`/api/health` OK、**13 個 migration 全套用**（含報表表） |
| 字型解析 | 容器內 `fc-match "Noto Sans TC"` → **Noto Sans CJK TC**（T7bR 修復生效） |
| 字型 probe（可重跑） | 容器內以真實 `renderPdf` 產 169KB PDF：**內嵌字型 NotoSansCJK 在場、WenQuanYi 不在**（probe 指令見附錄） |
| 三套件 | 後端 2952／前端 254／E2E 44 全綠；終審程式面 0 Must 0 Should |

## Step-by-step 走查步驟

1. 開瀏覽器到 **`http://localhost:8080`**（這是容器版；平常的 5173 是開發版，這次不要用）。
2. 以員工帳號登入（前次 Gate 用過的，例如 `gate-depr-01`；**忘記密碼**就先用 `gateadmin` 登入 → 管理使用者 → 重設該員工密碼 → 再改用員工登入）。
3. 找一筆**已完成**的申請（前次 Gate 留下的資料；若都沒有，就用畫面新建一筆完成——選年度→上傳→儲存草稿→完成）。
4. 詳情頁下方「報表」區塊 → 點「**產生正式報表**」→ 顯示編號與**中文格式時間**。
5. 點「**下載 PDF**」，打開檔案，逐項目視：
   - **繁體字形正確**（本場重點）：看「為、值、悅、臺」這類字是不是台灣慣用寫法，不是簡體、不是日文異體、更不是方框
   - **報表編號、產生時間兩欄有值**（不是「尚未產生」）
   - 三項前次裁定生效：無「報表標題」重複列／兩個時間欄是中文格式／（差旅報表）油種顯示中文
   - 對帳列（取整前總額→最終金額）可讀——這一塊沒有機械量測守門，請特別看一眼
   - 圖片順序與詳情頁一致、皆不出界
6. 點「**檢視列印版**」（新分頁）：與 PDF 同一長相；Ctrl+P 預覽看分頁處**沒有把段落卡片或圖片攔腰切開**。
7. （可選）縮窄視窗看列印版：內容可讀、頂部「建議以桌面裝置列印」提示在（列印預覽時消失）。

## 知悉事項（前次已說明，複述即可，不需動作）

- 部署包 2.08GB／5 併發記憶體 +1.7GB（您已於 2026-08-07 知悉；Zeabur 方案選擇時再裁定）。
- 列印版時間「無秒」與詳情頁「有秒」是設計容忍差異，非缺陷。
- LEGACY（舊制參數）申請的「—」樣式：容器 DB 若無 LEGACY 資料則本場看不到，測試層已覆蓋（AC-17 逐字斷言）。

## 檢核後請回覆

一句話即可：「整合 Gate 通過」或列出問題。通過後我會呈報 PR 合併批准。

## 附錄：字型 probe 重跑指令（機器取證，AC-09(c) 文件化取證之可重跑步驟）

```bash
docker exec oilexpense-backend-1 node -e "const{renderPdf}=require('./dist/reports/pdf-renderer.js');renderPdf('<!doctype html><html><head><meta charset=\"utf-8\"><style>body{font-family:\"Noto Sans TC\",sans-serif}</style></head><body><h1>繁體檢核：臺為值悅</h1></body></html>',{timeoutMs:30000}).then(b=>{const s=b.toString('latin1');console.log('NotoSansCJK:',/NotoSansCJK/i.test(s),'WenQuanYi:',/WenQuanYi/i.test(s));})"
```

預期輸出：`NotoSansCJK: true WenQuanYi: false`
