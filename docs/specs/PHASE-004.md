# PHASE-004 — 差旅申請（垂直核心：草稿→多段行程→附件鎖定→計算→完成→查詢→代操作）

- Governance-Version: 2026-08-01.2
- 狀態：**ACTIVE**（Gate 於 2026-08-02 通過，D1~D18 全數定案，見 §17）
- Task ID（產出本 Spec）：SPEC-004
- 更新日期：2026-08-02
- Phase ID：PHASE-004
- Base Commit：6041af4（branch: phase-004；自 main @ 94a87a8 切出，工作區乾淨）
- 上游事實來源（優先序見 CLAUDE.md）：`userstory.md`（不得改變原意）→ `docs/PRD.md` 第 5 節 PHASE-004 段落（311–337 行）→ `docs/ARCHITECTURE.md`、`docs/DATA_FLOW.md`（DRAFT）→ ADR → 既有 Spec（PHASE-001 錯誤協定、PHASE-002 授權/稽核、PHASE-003 附件、PHASE-003a 參數）
- 對應 US 清單：
  - **FE**：FE-US-04、05、07、08、09、10、11、12、21（差旅情境）、27（多段表單響應式）
  - **AD**：AD-US-06、07、08
  - **BE**：BE-US-02（申請資料情境）、03、05、06、07、08、09、18（差旅快照）、20、24（差旅上限 3/段）、25（完成鎖定）、29
  - **NFR**：NFR-US-10（差旅附件）、14、16
- 依賴（皆 DONE 並已合併 main）：
  - **PHASE-001**：`AppError` / 統一錯誤協定 / `error-handler` / `sanitizeForLog` + pino redact / env 載入。
  - **PHASE-002**：`requireAuth`／`requirePasswordChanged`／`requireAdmin`／`assertOwnershipOrAdmin`、Cookie Session、`AuditLog` model 與 `AuditAction` enum、稽核寫入慣例、`userHasHistory` 可插拔判斷點。
  - **PHASE-003**：`Attachment` model（`TEMP`/`LINKED`、`refType`+`refId` 弱關聯）、`storage` 抽象、上傳/內容偵測、`attachment-limit-engine`（`canLink`／`countLinkedAttachments`）、`lifecycle-service`（`linkAttachment`／`deleteAttachment`／`assertContainerMutable`／`isEligibleForCleanup`／`HasReferenceQuery`）、`access-service` 授權存取。
  - **PHASE-003a**：`findEffectiveVersion`／`checkNoOverlap`、`FuelParameterVersion`／`EtcParameterVersion`、Decimal 精度定案（D3/D8）、`PARAMETER_VERSION_CREATED` 稽核。
- Risk Level：**High**（授權／資料隔離／附件權限／完成鎖定不可逆／計算快照／金額語意）

> 本文件為 PHASE-004 的實作定案層：可測試 AC、資料模型與 migration 意圖、計算與狀態機引擎、API 形狀、Data Flow、測試策略、Task Graph，供 implementer 依 TDD 落地。
>
> **本 Spec 已於 2026-08-02 通過 Gate 並轉 ACTIVE。** 第 16 節 D1~D18 之定案結果見 §17.1；除 D18 外全數依 spec-writer 建議定案，D18 改採選項 (b)（維持單一 PHASE-004）並附理由。§16 各節保留原始選項分析作為決策依據存證，**實作一律以 §17.1 定案表為準**。

---

## 1. 目標與非目標

### 1.1 目標

PHASE-004 是本專案的**垂直核心**。Phase 結束時人類可完整走完一筆差旅並在 UI 看到結果：

1. **申請狀態機首次落地**：`DRAFT` / `COMPLETED`（`VOIDED` 於 PHASE-009 才可達）；禁止逆轉（BE-US-05）。
2. **草稿機制**：允許保存不完整資料，並由**後端**回傳「尚未完成項」清單（FE-US-07、BE-US-20）。
3. **多段行程**：任意多段的新增／修改／刪除／排序持久化；刪段連帶解除其未鎖定附件關聯（FE-US-08）。
4. **里程驗證**：總里程 > 0、高速里程 ≥ 0、高速 ≤ 總里程；違反者拒絕完成並定位對應行程段（FE-US-09、BE-US-08）。
5. **Google Maps 截圖**：套用 PHASE-003 限制引擎，**上限 3 張／段**；每段完成須 ≥ 1 張；完成即鎖定（FE-US-11、BE-US-24、BE-US-25）。
6. **後端計算唯一權威**：單段＝`round(總里程 × 油資單價 + 高速里程 × ETC 單價)`（**先相加再四捨五入**）；整筆＝**Σ 各段已取整金額**；總里程＝Σ 各段總里程，**高速不重複加**（BE-US-06、BE-US-07）。
7. **依出差日期套用油資／ETC 參數**：複用 PHASE-003a `findEffectiveVersion`；缺參數可存草稿、不可完成（BE-US-09）。
8. **完成時保存計算快照**：單價、參數版本識別、取整前／後金額、總里程、計算時間；快照不可變（BE-US-18）。
9. **綜合紀錄查詢**：預設近一年、日期／類型／狀態／關鍵字篩選、分頁（頁次／每頁／總數）、授權隔離（FE-US-04、FE-US-05、BE-US-29）。
10. **管理員代操作**：擁有人 vs 操作者分離、未選使用者不得代操作、已完成拒改並提示建修正版、寫稽核（AD-US-06/07/08、BE-US-03、BE-US-31）。
11. **PHASE-003 前置約束閉環（AR-D，硬性）**：`containerState` **一律由申請服務層依 `Application.status` 注入**；route **移除／忽略 client 傳入的 `containerState`**（§4.9、AC-27）。
12. **前端**：個人綜合列表（篩選）、差旅草稿表單（多段、預覽、附件）、已完成檢視、管理員檢視他人紀錄與代操作介面；五態齊備、響應式（FE-US-04/05/07~12/21/27、AD-US-06/07/08）。
13. **跨 Phase 引用保護閉環**：`userHasHistory` 接上 `Application`（AD-US-04 拒刪）、`parameterHasReferences` 接上已完成差旅快照（BE-US-19，PHASE-003a §4.7 預留）。

### 1.2 非目標（Out of Scope，明列各 Phase 界線）

| 項目 | 歸屬 Phase | 本 Phase 的處置 |
|---|---|---|
| 區間公務里程統計引擎與統計頁（FE-US-06、BE-US-30、AD-US-06 統計部分） | **PHASE-005** | 本 Phase 只產生統計來源資料（已完成差旅 + `snapshotTotalKm`）；**不**提供統計端點/頁面 |
| 保養費用分攤（FE-US-13~16、BE-US-10~13） | **PHASE-006** | `ApplicationType.MAINTENANCE` 於 enum 宣告，但無子表、無端點；查詢該類型回空清單 |
| 年度折舊補貼（FE-US-17~20、BE-US-14~17） | **PHASE-007** | 同上（`DEPRECIATION`） |
| 報表編號、列印版、正式 PDF（FE-US-22~24、BE-US-26~28） | **PHASE-008** | 不產生任何報表；**FE-US-05 的「報表編號關鍵字查詢」於 008 擴充**（本 Phase 關鍵字僅比對出差目的，見 §10.4 已知限制與跨 Phase 追蹤） |
| 建立修正版（FE-US-25、AD-US-09、BE-US-21） | **PHASE-009** | 本 Phase 僅「已完成拒改 + 提示建立修正版」，**不**提供建立修正版功能與版本關聯欄位 |
| 作廢（FE-US-26、AD-US-10、BE-US-22） | **PHASE-009** | `ApplicationStatus.VOIDED` 於 enum 宣告（供 005 過濾條件可寫），但**無**任何轉換路徑、無作廢欄位 |
| 稽核檢視頁（AD-US-14） | **PHASE-010** | 本 Phase 只保證代操作稽核**寫入** |
| 暫存附件 24h 清理排程（BE-US-25 末兩條） | **PHASE-011** | 本 Phase 提供 `HasReferenceQuery` 的差旅實作，不跑排程 |
| 附件弱關聯升級為真外鍵（PHASE-003 D1 待評估） | 本 Phase 評估後**建議維持弱關聯**（D11-b） | 引用完整性由服務層在同交易內保證 |

---

## 2. 可測試 Acceptance Criteria

AC 以 Given/When/Then 表述，逐條可測，標註對應 US 與主要 Task。錯誤碼見 §8.6。凡 AC 依賴決策點者，以**建議方案**表述；Gate 若改採替代方案，AC 等義調整（不改變 US 原意）。

### A. 草稿建立與保存（FE-US-07、BE-US-20、BE-US-02）

**AC-01 建立差旅草稿（T3）** — Given 已登入一般使用者。When `POST /applications/travel`（body 可為空）。Then 201，建立 `Application(type=TRAVEL, status=DRAFT, ownerId=self, createdById=self)` 與 `TravelApplication`；回傳 DTO 含 `id`、空 `segments`、`completionBlockers`。

**AC-02 只輸入部分資料可保存（FE-US-07 / T3）** — Given 使用者僅填出差目的、未填出差日期、未新增行程段。When `PUT /applications/travel/:id`。Then 200 保存成功，**不得**因欄位不完整而拒絕。

**AC-03 未完成項由後端標示且不阻止保存（FE-US-07、BE-US-20 / T3）** — Given 草稿缺出差日期、缺行程段、某段缺附件。When 儲存或讀取草稿。Then 回應含 `completionBlockers[]`，每項含 `code`、可選 `field`、可選 `segmentId`/`segmentIndex`、zh-TW `message`；HTTP 仍為 200。

**AC-04 重新開啟草稿還原資料與附件關聯（FE-US-07 / T3, T11）** — Given 已保存含 2 段、各段 2 張截圖的草稿。When `GET /applications/travel/:id`。Then 還原出差日期／目的／各段欄位／順序，且每段 `attachments[]` 含其 `LINKED` 附件（含 `previewUrl`/`downloadUrl`）。

**AC-05 草稿可刪除並連帶解除附件（BE-US-20、FE-US-08 / T3, T11）** — Given 草稿含 `LINKED` 附件。When 擁有人或管理員 `DELETE /applications/:id`。Then 200；`Application`/`TravelApplication`/`TripSegment` 移除；其附件於**同一交易**內 `detach`（`LINKED`→`TEMP`、`refType`/`refId`/`linkedAt` 清空、`createdAt` 重置為 TTL 基準）；該草稿不再出現於列表。

**AC-06 已完成申請不可刪除（BE-US-05 / T2, T3）** — Given `status=COMPLETED`。When `DELETE /applications/:id`。Then 403 `FORBIDDEN`，message 提示改用建立修正版（PHASE-009）；資料不變。

**AC-07 草稿不納入金額統計（BE-US-20 / T1, T8）** — Given 草稿。When 讀取列表。Then `totalAmount` 為 `null`（未完成無金額），且 `status=DRAFT` 可被篩選分辨；`Application.totalAmount` 僅於完成時寫入。

### B. 多段行程（FE-US-08）

**AC-08 新增行程段（T4）** — Given 編輯中的差旅草稿。When `PUT` 的 `segments[]` 含一個**無 `id`** 的項目。Then 建立一筆新 `TripSegment`，回傳其 `id` 與 `sortOrder`。

**AC-09 每段四欄位（T4）** — Given 行程段。When 儲存與讀取。Then 每段含 `origin`（出發地點）、`destination`（到達地點）、`totalKm`（總行駛公里數）、`highwayKm`（高速公路里程）；草稿階段四欄位皆可為空。

**AC-10 排序持久化（T4）** — Given 差旅含 ≥ 2 段。When 使用者調整順序後儲存，再重新開啟草稿。Then 段落順序與儲存時一致（`sortOrder` 依提交陣列索引重寫為 `0..n-1`，讀取一律 `orderBy sortOrder asc`）。

**AC-11 刪除行程段連帶移除未鎖定附件關聯（FE-US-08、BE-US-25 / T4, T11）** — Given 草稿某段有 2 張 `LINKED` 附件。When `PUT` 的 `segments[]` 不再包含該段 `id`。Then 該段刪除；其 2 張附件於同交易 `detach` 回 `TEMP`；重新載入草稿不再顯示該段與其附件。

**AC-12 允許 0 段草稿但不得完成（FE-US-08 / T4, T8）** — Given 草稿刪至 0 段。When 儲存。Then 200 允許。When 嘗試完成。Then 拒絕，`completionBlockers` 含「至少需一個行程段」。

**AC-13 整份儲存以 id 對齊（T4）** — Given 草稿現有段 `S1,S2,S3`。When `PUT` 提交 `[{id:S2,…},{…新增…},{id:S1,…}]`。Then `S2` 更新且 `sortOrder=0`、新段建立且 `sortOrder=1`、`S1` 更新且 `sortOrder=2`、`S3` 刪除並 detach 其附件；全部於單一交易完成。

### C. 里程驗證（FE-US-09、BE-US-08）

**AC-14 總里程 ≤ 0 拒絕完成（T5, T8）** — Given 某段 `totalKm ≤ 0`（含 0 與負值）。When 嘗試完成。Then 拒絕，錯誤定位該段（`segmentId` + `field="totalKm"`）。

**AC-15 高速里程 < 0 拒絕完成（T5, T8）** — Given 某段 `highwayKm < 0`。When 嘗試完成。Then 拒絕，定位該段 `highwayKm`。

**AC-16 高速里程 > 總里程拒絕完成（T5, T8）** — Given 某段 `highwayKm > totalKm`。When 嘗試完成。Then 拒絕，**指出對應行程段**。

**AC-17 高速里程 = 0 允許（T5）** — Given 某段 `highwayKm = 0` 且其他欄位有效。Then 允許保存與完成；該段 ETC 金額為 0。

**AC-18 高速里程 = 總里程（邊界）允許（T5）** — Given `highwayKm == totalKm`（如 10.00 / 10.00）。Then 允許（`≤` 為含等於）；總里程統計仍只計 `totalKm`（不重複加）。

**AC-19 里程小數位超過 2 位拒絕（T5）** — Given `totalKm = 12.345`。When 儲存或完成。Then 400 `VALIDATION_ERROR` 指該欄位「最多 2 位小數」；**不得靜默取整**。

**AC-20 缺出發或到達地點拒絕完成（BE-US-08 / T5, T8）** — Given 某段 `origin` 或 `destination` 為空／純空白。When 嘗試完成。Then 拒絕，定位該段對應欄位。

**AC-21 草稿階段不合法里程仍可保存（BE-US-20 / T3, T5）** — Given 某段 `totalKm = 0`、`highwayKm > totalKm`。When **儲存草稿**。Then 200 允許保存，僅列入 `completionBlockers`（格式性錯誤如 AC-19 之小數位除外，該項於儲存時即拒）。

### D. 附件（FE-US-11、FE-US-21、BE-US-24、BE-US-25、NFR-US-10）

**AC-22 每段上限 3 張（BE-US-24、FE-US-11 / T11）** — Given 某段已關聯 3 張附件。When 嘗試關聯第 4 張（經草稿儲存）。Then 拒絕，409 `TOO_MANY_ATTACHMENTS`，定位該段；關聯不成立；**上限 3 由後端提供**，client 不得指定 `limit`。

**AC-23 某段未上傳截圖可存草稿（FE-US-11 / T3, T11）** — Given 某段 `attachmentIds` 為空。When 儲存草稿。Then 200 允許。

**AC-24 任一段無截圖不得完成（FE-US-11、BE-US-08 / T8, T11）** — Given 有 3 段，其中第 2 段無附件。When 嘗試完成。Then 拒絕；`completionBlockers` 含 `code=SEGMENT_ATTACHMENT_REQUIRED` 與該段 `segmentId`/`segmentIndex`（**定位缺少附件的行程段**）。

**AC-25 草稿階段刪附件解除關聯（FE-US-21 / T11）** — Given 草稿某段的 `LINKED` 附件。When 擁有人刪除該附件（`DELETE /attachments/:id` 或自 `PUT` 的 `attachmentIds` 移除）。Then 解除關聯；重新載入草稿不再顯示。

**AC-26 已完成申請的附件不得刪除／替換（FE-US-21、BE-US-25 / T11）** — Given 附件所屬 `TripSegment` 之 `Application.status = COMPLETED`。When `DELETE /attachments/:id`（**且 client 嘗試以任何參數宣稱 `containerState=draft`**）。Then 403 `FORBIDDEN`；附件與關聯不變。

**AC-27 `containerState` 由服務層注入、公開 link 端點移除（AR-D 硬性 / T11）** — Given 任何附件關聯／刪除路徑。When 處理請求。Then (a) `containerState` 一律由後端依 `Attachment.refType/refId` → `TripSegment` → `Application.status` 推導（`TEMP` 無容器者視為 `draft`）；(b) route **不接受**任何 client 傳入的 `containerState`（body/query 皆忽略且不影響結果）；(c) 公開 `POST /attachments/:id/link` 端點**移除**，附件關聯僅能經差旅草稿儲存端點；(d) 測試須證明「舊 client 參數已無效」（送出仍得到依真實狀態的結果）。

**AC-28 附件授權隔離（NFR-US-10、BE-US-02 / T11）** — Given 使用者 A 的差旅內附件。When 使用者 B 請求該附件 `content`/`thumbnail`。Then 403，不回傳任何位元組。When 管理員請求。Then 200。When 未登入請求。Then 401。

**AC-29 管理員代上傳可指定 `ownerId`（BE-US-03 / T10, T11）** — Given 管理員代使用者 U 操作。When `POST /attachments` 帶 `ownerId=U`。Then 附件 `ownerId=U`、`uploaderId=管理員`。Given 一般使用者。When 帶 `ownerId` 為他人。Then 403 `FORBIDDEN`；帶自身 `ownerId` 或省略則允許（owner=自己）。

**AC-30 附件擁有人須與申請擁有人一致（BE-US-02 / T11）** — Given 附件 `ownerId ≠ 申請 ownerId`。When 於草稿儲存時嘗試關聯。Then 403 `FORBIDDEN`；不建立關聯（防跨擁有人混接）。

### E. 金額預覽（FE-US-10）

**AC-31 總里程變更更新油資預覽（T6, T13）** — Given 有效總里程與出差日期。When 呼叫預覽。Then 回該段油資補助（未取整值以字串表示）。

**AC-32 高速里程變更更新 ETC 預覽（T6, T13）** — Given 有效高速里程。When 呼叫預覽。Then 回該段 ETC 補助。

**AC-33 單段預覽顯示油資／ETC／取整後金額（FE-US-10 / T6）** — Given 某段有效里程且當日參數齊備。Then 預覽回 `{ fuelAmount, etcAmount, rawAmount, amount }`，`amount` 為整數。

**AC-34 多段預覽加總各段取整後金額（FE-US-10 / T6）** — Given 多段。Then `totalAmount = Σ segments[].amount`（**先各段取整、再加總**）。

**AC-35 後端結果為準、後端不採前端金額（FE-US-10、BE-US-06 / T3, T6, T8）** — Given 前端在 `PUT` 或 `complete` 的 body 中夾帶 `totalAmount`／`amount`／`fuelAmount` 等欄位。When 後端處理。Then **一律忽略**；回應與 DB 內金額皆為後端計算值（測試須以刻意錯誤的前端金額證明鑑別力）。

**AC-36 預覽為唯讀（T6）** — Given 呼叫預覽端點。Then 不建立／不修改任何 `Application`/`TripSegment`/`Attachment` 資料列。

### F. 計算引擎（BE-US-06、BE-US-07）

**AC-37 單段油資 = 總里程 × 油資單價（未取整）（T6）** — 以 `Prisma.Decimal` 計算，不使用浮點。

**AC-38 單段 ETC = 高速里程 × ETC 單價（未取整）（T6）** — 同上。

**AC-39 單段金額 = round(油資 + ETC)（先相加再取整）（T6）** — 鑑別力案例：油資 `0.4`、ETC `0.4` → 相加 `0.8` → **1**；若實作誤為「各自取整再相加」將得 **0**（測試必含此案例）。

**AC-40 一般四捨五入（0.5 進位），非銀行家取整（T6）** — 鑑別力案例：`2.5 → 3`、`3.5 → 4`、`-`（本 Phase 金額非負）；若為 half-even 將得 `2`／`4`（測試必含 `2.5` 案例）。

**AC-41 整筆 = Σ 各段已取整金額（BE-US-07 / T6）** — 鑑別力案例：三段各 `0.5` → 各段取整為 `1`，整筆 `3`；若誤為「先加未取整再取整」將得 `2`（測試必含）。

**AC-42 總里程 = Σ 各段總里程，高速不重複加（BE-US-07 / T6）** — 鑑別力案例：單段 `totalKm=10, highwayKm=10` → 總里程 `10`（非 `20`）。

**AC-43 任一段資料無效則整筆不得完成（BE-US-07 / T5, T8）** — Given 3 段中第 3 段 `highwayKm > totalKm`。When 完成。Then 拒絕，前 2 段亦不落地任何快照。

**AC-44 計算引擎為純函式（T6）** — Given 單價與段落陣列。When 呼叫引擎。Then 無 DB／IO 存取、無副作用、相同輸入恆得相同輸出；型別一律 `Prisma.Decimal`，**禁止浮點中介**。

### G. 參數套用（BE-US-09）

**AC-45 依出差日期取有效油資與 ETC 版本（含當日）（T7）** — Given 油資版本 `v(2026-01-01)`、`v(2026-03-01)`。When 出差日期為 `2026-02-28` → 取 `v(2026-01-01)`；`2026-03-01`（**當日**）→ 取 `v(2026-03-01)`；`2025-12-31` → 查無。實作複用 PHASE-003a `findEffectiveVersion`（傳入**該類全部版本**）。

**AC-46 缺任一參數仍可保存草稿（BE-US-09 / T3, T7）** — Given 出差日期無有效油資或 ETC 版本。When 儲存草稿。Then 200 允許；`completionBlockers` 含 `PARAMETER_NOT_AVAILABLE` 並標明缺哪一類。

**AC-47 缺任一參數不得完成（BE-US-09、FE-US-12 / T7, T8）** — Given 同上。When 嘗試完成。Then 409 `PARAMETER_NOT_AVAILABLE`，`details.missing = ["FUEL"] | ["ETC"] | ["FUEL","ETC"]`，message 為 zh-TW 且提示**聯絡管理員設定參數**；狀態不變。

**AC-48 完成後新增參數版本不改變歷史金額（AD-US-11、BE-US-09、BE-US-18 / T7, T8）** — Given 差旅已於 `2026-02-10` 完成（單價 `5.0000`）。When 管理員新增 `v(2026-02-01)` 之後續版本或任何新版本。Then 重新讀取該已完成差旅，其單價、各段金額、整筆金額**完全不變**（讀快照，不重算）。

### H. 完成流程與快照（FE-US-12、BE-US-05、BE-US-18）

**AC-49 完整資料可完成（FE-US-12 / T8）** — Given 有效出差日期與目的、≥1 段、每段有效地點與里程且 ≥1 張截圖、出差日期有有效油資與 ETC 參數。When `POST /applications/:id/complete`。Then 200，`status=COMPLETED`，回傳**後端正式計算結果**。

**AC-50 完成時保存快照（BE-US-18 / T8）** — When 完成成功。Then 保存：`fuelUnitPrice`、`etcUnitPrice`（各 `Decimal(10,4)`）、`fuelParameterVersionId`、`etcParameterVersionId`、每段 `snapshotFuelAmount`/`snapshotEtcAmount`/`snapshotRawAmount`（**取整前**）與 `snapshotAmount`（**取整後**，整數）、整筆 `snapshotRawAmount`（Σ 各段取整前）與 `Application.totalAmount`（整數）、`snapshotTotalKm`、`calculatedAt`、`completedAt`。

**AC-51 完成後列表顯示「已完成」（FE-US-12 / T9, T13）** — When 使用者返回個人列表。Then 該筆顯示狀態「已完成」與後端正式金額。

**AC-52 必要欄位不完整則拒絕並列出錯誤欄位（FE-US-12 / T8）** — Given 缺出差目的且第 2 段缺附件。When 完成。Then 拒絕，回應列出**所有**未通過項（非只回第一項），每項可定位欄位／行程段。

**AC-53 完成為原子操作（T8）** — Given 完成流程中任一步驟（驗證／參數查找／計算／快照寫入／狀態轉換／稽核）失敗。When 交易結束。Then **無任何部分變更落地**：狀態仍為 `DRAFT`、無快照欄位、附件仍可修改。

**AC-54 完成端點忽略任何金額 body（BE-US-06 / T8）** — Given `POST /applications/:id/complete` body 帶 `{ totalAmount: 999999 }`。Then 忽略；落地金額為後端計算值。

### I. 狀態機（BE-US-05）

**AC-55 DRAFT → COMPLETED 允許（條件通過）（T2）**

**AC-56 已完成收到一般更新請求則拒絕（BE-US-05、AD-US-08 / T2, T10）** — Given `status=COMPLETED`。When `PUT /applications/travel/:id`（無論擁有人或管理員）。Then 403 `FORBIDDEN`，message 提示「已完成申請不可修改，請建立修正版」；重要業務欄位不變。

**AC-57 COMPLETED → DRAFT 不允許（T2）** — 任何路徑皆不得將已完成回退為草稿。

**AC-58 狀態機為純函式且非法轉換一律拒絕（T2）** — Given 轉換矩陣（含 `VOIDED` 相關：`VOIDED→COMPLETED`、`VOIDED→DRAFT`、`COMPLETED→DRAFT`）。When 呼叫 `assertTransition(from, to)`。Then 允許集合僅 `{DRAFT→COMPLETED}`（本 Phase）；其餘拋 `AppError`；`VOIDED` 於本 Phase **不可達**（無任何路徑寫入）。

**AC-59 已完成的業務欄位與附件皆凍結（BE-US-05、BE-US-25 / T2, T8, T11）** — Given 已完成。Then 出差日期／目的／各段欄位／段落增刪／附件關聯與刪除皆被拒（403）。

### J. 綜合查詢（FE-US-04、FE-US-05、BE-US-29）

**AC-60 未指定日期預設近一年（BE-US-29、FE-US-05 / T9）** — Given 未提供 `dateFrom`/`dateTo`。When 查詢。Then 套用 `dateFrom = 今日 − 1 年`（含當日）、**不設上界**（見 D9）；回應之 `appliedFilters` 明示實際套用值。

**AC-61 自訂起訖日期起訖含當日（FE-US-05、CLAUDE.md / T9）** — Given 某差旅出差日期為 `2026-03-01`。When 查詢 `dateFrom=2026-03-01`（或 `dateTo=2026-03-01`）。Then **包含**該筆（起日與迄日當天均含）。

**AC-62 起日晚於迄日拒絕（BE-US-30 對齊 / T9）** — Given `dateFrom > dateTo`。When 查詢。Then 400 `VALIDATION_ERROR` 指出日期區間錯誤。

**AC-63 多條件同時套用（FE-US-05、BE-US-29 / T9）** — Given 提供日期 + 類型 + 狀態 + 關鍵字。Then 僅回**同時**符合所有條件者（AND 語意）。

**AC-64 關鍵字比對出差目的（FE-US-05 / T9）** — Given 出差目的含「台中客戶拜訪」。When 關鍵字為「客戶」（或大小寫不同之英數）。Then 命中（不分大小寫、部分比對）。Given 關鍵字為空字串或純空白。Then 視同未提供，不套用關鍵字條件。（報表編號比對於 PHASE-008 擴充，見 §10.4）

**AC-65 分頁參數與回應（BE-US-29 / T9）** — Then 回應含 `page`、`pageSize`、`total`；`pageSize` 超過上限（建議 100）→ **clamp 至上限**（不報錯，符合「仍應限制單次回傳筆數」）；`page < 1` 或非整數 → 400 `VALIDATION_ERROR`。

**AC-66 「全部紀錄」仍分頁且限制單次筆數（BE-US-29、FE-US-05 / T9）** — Given 使用者選擇全部紀錄（不套日期）。Then 仍以分頁回傳，單次回傳筆數 ≤ 上限。

**AC-67 依日期倒序且分頁穩定（FE-US-04 / T9）** — Then 排序為 `primaryDate DESC, createdAt DESC, id DESC`；相同日期多筆時跨頁不重複、不遺漏。

**AC-68 類型標籤、狀態、不適用欄位（FE-US-04 / T9, T13）** — Then 每筆含 `type`（供類型標籤）與 `status`；不適用於該類型之欄位回 `null`，前端顯示「—」，**不得**顯示錯誤資料。

**AC-69 無任何紀錄顯示空白狀態與新增入口（FE-US-04 / T9, T13）** — Given 使用者無任何申請。Then API 回 `items: []`、`total: 0`；前端顯示空白狀態與「新增差旅補助」入口。

**AC-70 篩選後無結果顯示空白狀態非錯誤（FE-US-05 / T9, T13）** — Then 200 + 空清單；前端顯示空白狀態，**不得**顯示錯誤訊息。

**AC-71 查詢尚未實作之類型回空清單（T9）** — Given `type=MAINTENANCE` 或 `DEPRECIATION`。Then 200 + `items: []`，**不得**報錯（PHASE-006/007 前的相容行為）。

### K. 權限與資料隔離（BE-US-02、NFR-US-10、NFR-US-16）

**AC-72 一般使用者可存取自己的申請（T3, T9）** — 200。

**AC-73 一般使用者存取他人申請被拒（BE-US-02 / T3, T9）** — Given 他人 `Application.id`。When `GET`/`PUT`/`DELETE`/`complete`。Then 403 `FORBIDDEN`；**不得**回傳任何業務欄位（不洩漏出差目的、金額等）。

**AC-74 一般使用者自帶他人 `ownerId` 查詢不得越權（BE-US-02、BE-US-29 / T9）** — Given 一般使用者於 `GET /applications?ownerId=<他人>`。Then 403 `FORBIDDEN`（不靜默降級為自己資料，亦不回他人資料）。

**AC-75 未登入被拒（BE-US-01 / T3, T9）** — 401 `UNAUTHORIZED`。

**AC-76 強制改密使用者被拒（PHASE-002 / T3, T9）** — Given `mustChangePassword=true`。When 呼叫本 Phase 任一業務端點。Then 403 `PASSWORD_CHANGE_REQUIRED`。

**AC-77 管理員可存取任一使用者的申請與附件（AD-US-06 / T9, T10, T11）** — 200。

### L. 管理員代操作與稽核（AD-US-06/07/08、BE-US-03、BE-US-31）

**AC-78 代建立草稿：擁有人 vs 操作者分離（AD-US-07、BE-US-03 / T10）** — Given 管理員選定使用者 U。When `POST /admin/users/:userId/applications/travel`。Then 201；`ownerId=U`、`createdById=管理員`。

**AC-79 未選使用者不得代操作（AD-US-07 / T10）** — Given 管理員未指定使用者。Then (a) 一般端點 `POST /applications/travel` 之 owner **恆為呼叫者自己**（不接受 body `ownerId`）；(b) 代操作路徑缺 `:userId` 不存在（404）；(c) `:userId` 指向不存在或已停用之使用者 → 400/404 `VALIDATION_ERROR`/`NOT_FOUND`，不建立資料。

**AC-80 管理員可修改使用者草稿（AD-US-08 / T10）** — Given 使用者草稿。When 管理員 `PUT`。Then 200 保存成功。

**AC-81 管理員不得直接修改已完成（AD-US-08、BE-US-03 / T2, T10）** — Then 403，message 提供「建立修正版」指引（PHASE-009 提供功能）。

**AC-82 代操作寫稽核（BE-US-31、AD-US-14 / T12）** — When 管理員代建立或代修改草稿成功。Then 寫入 `AuditLog`：`action ∈ {APPLICATION_CREATED_ON_BEHALF, APPLICATION_UPDATED_ON_BEHALF}`、`actorId=管理員`、`targetId=擁有人`、`targetLabel`（擁有人 loginName 快照 + 申請識別）、`summary`（申請 id／類型／重要欄位變更前後摘要）、`createdAt`；**不得**含密碼／token／session cookie／secret。

**AC-83 稽核與主體同交易（原子性）（T12）** — Given 稽核寫入失敗。Then 主體變更 rollback（申請不落地）。Given 操作被拒（403/400/409）。Then **不寫**任何稽核。

**AC-84 管理員檢視指定使用者紀錄（AD-US-06 / T9, T14）** — Given 管理員。When `GET /applications?ownerId=U`（含日期／類型／狀態篩選）。Then 只回 U 的、且符合條件的紀錄。

**AC-85 一般使用者不得存取代操作端點（BE-US-02 / T10）** — When 一般使用者呼叫 `POST /admin/users/:userId/applications/travel`。Then 403 `FORBIDDEN`。

**AC-86 使用者自有草稿之常態操作不寫稽核（對齊 PHASE-003 §4.7 / T12）** — Given 使用者對自己的草稿建立／儲存／刪除。Then 不產生 `AuditLog`（避免稽核噪音；重要管理／代操作事件才寫）。

### M. 響應式（FE-US-27）

**AC-87 手機多段表單垂直可觸控（T13）** — Given 375px 寬視窗。When 顯示多段差旅表單。Then 每個行程段為垂直堆疊、可觸控之獨立區塊（非橫向表格）。

**AC-88 手機上傳可自相簿選取（FE-US-27、FE-US-11 / T13）** — Then 檔案輸入具 `accept="image/jpeg,image/png,image/webp"`（或 `image/*`），行動瀏覽器可自相簿選檔。

**AC-89 手機列表無水平溢位（T13）** — Given 375px。Then 主要資訊與主要操作可用；頁面 body 不得水平溢位（寬表格須自身可捲動）。

### N. 非功能（NFR-US-14、NFR-US-16）

**AC-90 錯誤可辨識且不外洩（NFR-US-16 / 全 Task）** — Then 所有錯誤回應為統一格式 `{ error: { code, message, requestId, fields?, details? } }`；欄位錯誤可定位；**不得**含堆疊、DB 結構、storage 絕對路徑、內部檔名；日誌不含密碼／token／session cookie。

**AC-91 效能目標（NFR-US-14 / 全 Task，PHASE-011 集中驗證）** — 列表與詳情查詢目標 < 2s、儲存／完成目標 < 2s（不含大型附件上傳等待）；查詢須走索引（`ownerId`/`status`/`primaryDate` 複合索引），**不得**於應用層做全表掃描後分頁。

### O. 引用保護與刪除守門（AD-US-04、BE-US-19）

**AC-92 有申請紀錄之使用者不得永久刪除（AD-US-04 / T15）** — Given 使用者已有任一 `Application`（草稿或已完成）。When 管理員嘗試永久刪除該帳號。Then 409 `CONFLICT` 並提供停用選項；不刪除資料（`userHasHistory` 接上 `Application` 計數）。

**AC-93 被已完成差旅引用之參數版本回報有引用（BE-US-19 / T15）** — Given 已完成差旅之快照引用 `FuelParameterVersion v1`。When 呼叫 `parameterHasReferences("FUEL", v1.id)`。Then 回 `true`；未被引用者回 `false`（閉環 PHASE-003a §4.7 預留契約）。

> **AC 總數：93**

---

## 3. 正常流程

### 3.1 一般使用者：建立→完成→查詢

```
1. 登入 →（PHASE-002）→ 個人首頁「我的私車補助紀錄」
2. 點「新增差旅補助」→ POST /applications/travel → 取得草稿 id → 導向 /applications/travel/:id
3. 填出差日期、出差目的（皆可暫留空）
4. 「新增行程段」→ 前端於本地陣列加一段（尚無 id）
5. 每段填 出發地點/到達地點/總里程/高速里程
6. 每段上傳 Google Maps 截圖 → POST /attachments（TEMP，owner=self）→ 取得 attachmentId → 前端記入該段 attachmentIds（最多 3）
7.（可選）金額預覽 → POST /applications/travel/preview（debounce）→ 顯示各段油資/ETC/取整後金額與整筆合計（後端計算）
8. 「儲存草稿」→ PUT /applications/travel/:id（整份提交：tripDate/purpose/segments[]，每段含 id?/欄位/attachmentIds[]）
     後端於單一交易：diff 段落（更新/新增/刪除+detach）→ 重寫 sortOrder → link/detach 附件（limit=3、containerState 由服務層注入 draft）
     → 回 200 + 完整 DTO（含 completionBlockers、computed 預覽）
9.（重複 3~8 直到完整）；離開頁面前若有未儲存變更 → 前端提示可能遺失
10. 「完成申請」→ POST /applications/:id/complete
     後端於單一交易：狀態機守門 → 完整性驗證 → 依 tripDate 查油資/ETC 有效版本（缺→409）
     → 計算引擎（純函式）→ 寫入各段與整筆快照 → status=COMPLETED、completedAt → 附件即刻受鎖定保護
     → 回 200 + 正式計算結果（前端以此為準）
11. 返回個人列表 → GET /applications（預設近一年）→ 該筆顯示「已完成」與正式金額
12. 篩選：日期區間/類型/狀態/關鍵字 + 分頁
13. 檢視已完成：GET /applications/travel/:id → 顯示快照（單價、各段金額、整筆金額）；不提供編輯/刪除/刪附件，改顯示「建立修正版」提示（功能於 PHASE-009）
```

### 3.2 管理員代操作流程

```
1. 管理員登入 → 管理首頁 → 使用者管理 → 點使用者姓名
2. 進入「使用者 U 的申請紀錄」頁 → GET /applications?ownerId=U（+ 篩選）（AD-US-06）
3. 「代 U 建立差旅草稿」→ POST /admin/users/:U/applications/travel
     → ownerId=U、createdById=管理員 → 寫 AuditLog(APPLICATION_CREATED_ON_BEHALF)（同交易）
4. 編輯草稿（沿用同一表單）→ PUT /applications/travel/:id
     → assertOwnershipOrAdmin 通過（ADMIN）→ 儲存 → 因 actor≠owner，寫 AuditLog(APPLICATION_UPDATED_ON_BEHALF)（同交易）
5. 代上傳截圖：POST /attachments 帶 ownerId=U（uploaderId=管理員）→ 關聯時斷言 attachment.ownerId === application.ownerId
6. 管理員對「已完成」申請按編輯 → 403 + 「請建立修正版」提示（PHASE-009）
7.（依 D17）管理員是否可代「完成」— 預設不提供，由使用者本人完成
```

---

## 4. 五態（Loading / Empty / Error / Success / Permission denied）

| 畫面 | Loading | Empty | Error | Success | Permission denied |
|---|---|---|---|---|---|
| **個人綜合列表**（`/`） | 骨架/「載入中…」，篩選列可見但停用 | 「尚無任何申請紀錄」+「新增差旅補助」入口（AC-69）；篩選後無結果顯示「查無符合條件的紀錄」+ 清除篩選（AC-70） | 載入失敗顯示 zh-TW 訊息 + 重試；`VALIDATION_ERROR`（起>迄）就地標示日期欄位 | 清單依日期倒序、類型標籤、狀態徽章、不適用欄位「—」、分頁列（頁次/每頁/總數） | 401 → 導向登入；403 `PASSWORD_CHANGE_REQUIRED` → 導向強制改密 |
| **差旅草稿表單**（`/applications/travel/:id`） | 讀取草稿中；預覽區顯示「計算中…」 | 尚無行程段 → 空段提示 +「新增行程段」；某段尚無截圖 → 空附件槽提示（可存草稿） | 欄位錯誤依 `fields` 就地標示；`PARAMETER_NOT_AVAILABLE` → 「該出差日期尚無有效補助參數，請聯絡管理員」；`TOO_MANY_ATTACHMENTS` → 該段「最多 3 張」；上傳錯誤沿用 PHASE-003 文案 | 儲存成功 toast + 未完成項清單（非錯誤樣式）；完成成功 → 顯示後端正式金額並轉為檢視態 | 非擁有人非管理員 403 → 「無權存取此資源」頁；未登入 401 → 登入頁 |
| **差旅檢視（已完成）** | 讀取中 | 不適用（已完成必有內容） | 讀取失敗 → 重試 | 顯示快照：出差日期/目的、各段明細與截圖、各段金額、整筆金額、（依 D6）單價 | 403 同上 |
| **管理員：使用者申請紀錄**（`/admin/users/:userId/applications`） | 載入中 | 「該使用者尚無申請紀錄」+「代建立差旅草稿」入口 | 同列表頁 | 清單 + 篩選 + 代操作入口 | 一般使用者進入 → 403 頁（`RouteGuard` + 後端 `requireAdmin` 為權威） |
| **管理員：代建立入口** | 送出中（防重複提交） | 未選使用者 → 入口停用並提示「請先選擇使用者」（AC-79 之 UX 面；後端為權威） | 使用者不存在/已停用 → 顯示後端錯誤 | 建立成功 → 導向該草稿表單（標示「代 U 操作中」） | 403 同上 |

---

## 5. 邊界條件

| # | 邊界 | 定案行為 |
|---|---|---|
| B-01 | `totalKm = 0` / 負值 | 草稿可存；完成拒絕並定位（AC-14/21） |
| B-02 | `highwayKm = 0` | 允許保存與完成；ETC 金額 = 0（AC-17） |
| B-03 | `highwayKm == totalKm` | 允許（`≤` 含等於）；總里程仍只計 `totalKm`（AC-18/42） |
| B-04 | `highwayKm > totalKm`（差 0.01） | 完成拒絕（AC-16）；測試須含最小差值案例 |
| B-05 | 里程小數位 3 位以上 | 儲存即 400，不靜默取整（AC-19） |
| B-06 | 單段金額落在 `.5` | 一般四捨五入進位（`2.5→3`）；非銀行家（AC-40） |
| B-07 | 各段各 `0.5` 共 3 段 | 各段取整為 1，整筆 3（非 2）（AC-41） |
| B-08 | 單段油資 `0.4` + ETC `0.4` | 先相加 `0.8` → 取整 `1`（非 `0`）（AC-39） |
| B-09 | 出差日期 == 參數 `effectiveFrom` 當日 | 使用該版本（含當日）（AC-45） |
| B-10 | 出差日期 == 參數 `effectiveFrom` 前一日 | 使用前一版本；若無前版 → 查無 → 缺參數（AC-45/47） |
| B-11 | 出差日期早於所有版本 | 缺參數：可存草稿、不可完成（AC-46/47） |
| B-12 | 只有油資有版本、ETC 無 | 缺參數，`details.missing=["ETC"]`（AC-47） |
| B-13 | 0 行程段 | 草稿可存；完成拒絕（AC-12） |
| B-14 | 段數上限 | 本 Phase **不設**業務上限（US 未定義）；僅受請求體大小限制。列已知限制 §10 |
| B-15 | 某段 3 張附件 → 第 4 張 | 409 `TOO_MANY_ATTACHMENTS`（AC-22） |
| B-16 | 某段 0 張附件 | 草稿可存；完成拒絕並定位該段（AC-23/24） |
| B-17 | 同一附件被兩段同時引用 | 拒絕（附件 `refId` 單值；第二次 link 遇 `status=LINKED` → 409 `CONFLICT`，沿用 PHASE-003） |
| B-18 | 查詢 `page=0` / 非整數 | 400 `VALIDATION_ERROR`（AC-65） |
| B-19 | 查詢 `pageSize > 100` | clamp 至 100（AC-65/66） |
| B-20 | 查詢 `pageSize <= 0` | 400 `VALIDATION_ERROR` |
| B-21 | 查詢頁次超出總頁數 | 200 + 空 `items` + 正確 `total`（非 404） |
| B-22 | 關鍵字為空字串／純空白／僅換行 | 視同未提供（AC-64） |
| B-23 | 關鍵字含 `%` `_` 等 SQL 萬用字元 | 以參數化查詢處理，視為字面字元（Prisma `contains` 已參數化；須有測試） |
| B-24 | 日期 `dateFrom == dateTo` | 合法；只回該日（起訖含當日） |
| B-25 | `dateFrom > dateTo` | 400（AC-62） |
| B-26 | 草稿無出差日期時的列表歸屬 | `primaryDate` 暫以**建立日期**代之（見 D9），確保新建空白草稿仍可見且可排序 |
| B-27 | 出差日期為未來 | 允許（US 未禁止）；預設篩選不設上界故仍可見（D9） |
| B-28 | 已完成後嘗試任何寫入 | 403（AC-56/59） |
| B-29 | 併發：兩請求同時完成同一草稿 | 交易內以狀態條件更新（`WHERE status='DRAFT'`）；落敗方得 403/409，不得雙重完成或雙重快照 |
| B-30 | 併發：同段同時 link 第 3、第 4 張 | 沿用 PHASE-003 SERIALIZABLE + P2034 重試；最終不得超過 3 張 |
| B-31 | 出差目的／地點長度 | 建議上限：目的 500 字、地點 200 字（防禦性，超過 → 400）。屬使用者可見行為，見 D14 |
| B-32 | `attachmentIds` 含不存在／他人附件 id | 404 / 403，整份儲存 rollback（AC-30） |

---

## 6. 權限與敏感資料

### 6.1 授權矩陣

| 端點 | 中介層 | 額外判定 |
|---|---|---|
| `POST /applications/travel` | `requireAuth` + `requirePasswordChanged` | owner 恆為呼叫者；**不接受 body `ownerId`** |
| `GET/PUT/DELETE /applications/travel/:id`、`POST /applications/:id/complete` | `requireAuth` + `requirePasswordChanged` | `assertOwnershipOrAdmin(actor, application.ownerId)`（以 **DB 查得之 ownerId** 為準，非請求參數） |
| `POST /applications/travel/preview` | `requireAuth` + `requirePasswordChanged` | 無資料擁有權（stateless）；不回傳他人資料 |
| `GET /applications` | `requireAuth` + `requirePasswordChanged` | 一般使用者：強制 `ownerId = self`；自帶他人 `ownerId` → 403（AC-74）。管理員：可指定任一 `ownerId`；未指定則預設自己（見 D10） |
| `POST /admin/users/:userId/applications/travel` | `requireAuth` + `requirePasswordChanged` + `requireAdmin` | `:userId` 須存在且啟用 |
| `POST /attachments`（既有，擴充 `ownerId`） | `requireAuth` + `requirePasswordChanged` | 非 ADMIN 指定他人 `ownerId` → 403（AC-29） |
| `GET /attachments/:id/content|thumbnail`（既有） | `requireAuth` | 沿用 PHASE-003 `assertOwnershipOrAdmin`（AC-28） |
| `DELETE /attachments/:id`（既有，改造） | `requireAuth` + `requirePasswordChanged` | `containerState` **由後端推導**（AC-27） |
| ~~`POST /attachments/:id/link`~~ | — | **移除**（D12） |

### 6.2 資料隔離不變式

1. **授權一律以 DB 查得之 `ownerId` 為準**，永不採信請求體/查詢字串中的使用者識別（BE-US-02 第三條 AC）。
2. **一般使用者自帶他人識別值 → 403**，不靜默降級、不回傳他人任何欄位（AC-73/74）。
3. **附件擁有人 = 申請擁有人**（AC-30）；管理員代上傳以 `ownerId` 指定被代理使用者，`uploaderId` 記管理員（AC-29）。
4. 錯誤回應不因「資源存在與否」洩漏他人資料：他人資源一律 403（沿用 PHASE-003 D6 定案 403 而非 404，保持全案一致）。

### 6.3 敏感資料

- 稽核 `summary` 僅含申請 id／類型／業務欄位變更摘要（出差日期、目的、段數、金額）；**不含**密碼、token、session cookie、secret（AC-82）。
- 日誌沿用 `sanitizeForLog` + pino redact；**不記錄** storage 絕對路徑、附件位元組、cookie。
- 出差目的與地點屬業務資料非個資，但測試一律使用**合成資料**（CLAUDE.md）。
- 錯誤回應不外洩堆疊／DB 結構／內部路徑（AC-90）。

---

## 7. 資料模型與 migration

### 7.1 概念與落點

沿用 `DATA_FLOW.md` §1 概念模型與 `ARCHITECTURE.md` §3（`applications` 共通 + `trips` 專屬）。採 **D1 建議方案：`Application` 共用父表 + `TravelApplication` 1:1 子表 + `TripSegment` 子表（class-table inheritance）**。

```prisma
// ── PHASE-004 enums ────────────────────────────────────────────────
enum ApplicationType {
  TRAVEL
  MAINTENANCE   // 宣告以供查詢相容；子表於 PHASE-006 建立
  DEPRECIATION  // 宣告以供查詢相容；子表於 PHASE-007 建立
}

enum ApplicationStatus {
  DRAFT
  COMPLETED
  VOIDED        // 宣告（供 PHASE-005 過濾條件可寫）；本 Phase 無任何轉換路徑（AC-58）
}

// AuditAction 擴充（既有 enum 追加值）
//   APPLICATION_CREATED_ON_BEHALF
//   APPLICATION_UPDATED_ON_BEHALF

// ── 共用父表 ────────────────────────────────────────────────────────
model Application {
  id          String            @id @default(cuid())
  type        ApplicationType
  status      ApplicationStatus @default(DRAFT)

  ownerId     String                                     // 資料擁有人（授權權威）
  owner       User @relation("ApplicationOwner",     fields: [ownerId],     references: [id], onDelete: Restrict)
  createdById String                                     // 實際操作者（代操作時為管理員）
  createdBy   User @relation("ApplicationCreatedBy", fields: [createdById], references: [id], onDelete: Restrict)

  /// 列表排序與期間篩選之歸屬日期（D9）：差旅＝出差日期；未填時暫以建立日期代之。
  /// 非統計權威——PHASE-005 統計一律讀 TravelApplication.tripDate（已完成必非空）。
  primaryDate DateTime @db.Date

  /// 完成快照：最終申報金額（新臺幣整數）。草稿為 null（AC-07/50）。
  totalAmount Int?
  completedAt DateTime?

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  travel      TravelApplication?

  @@index([ownerId, status, primaryDate])
  @@index([ownerId, primaryDate])
  @@index([type, status])
  @@index([primaryDate])
}

// ── 差旅子表（1:1） ─────────────────────────────────────────────────
model TravelApplication {
  applicationId String      @id
  application   Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)

  tripDate DateTime? @db.Date   // 出差日期（日粒度，含當日；歸屬期間與年度之權威）
  purpose  String?              // 出差目的（關鍵字查詢對象）

  // ── 完成快照（BE-US-18）；一經寫入不可變 ──
  fuelUnitPrice          Decimal? @db.Decimal(10, 4)  // 快照單價，與 PHASE-003a D8 精度一致
  etcUnitPrice           Decimal? @db.Decimal(10, 4)
  fuelParameterVersionId String?                      // 引用保護來源（AC-93）
  etcParameterVersionId  String?
  snapshotTotalKm        Decimal? @db.Decimal(12, 2)  // Σ 各段 totalKm（高速不重複加）
  snapshotRawAmount      Decimal? @db.Decimal(14, 4)  // Σ 各段取整前金額
  calculatedAt           DateTime?

  segments TripSegment[]

  @@index([tripDate])
  @@index([fuelParameterVersionId])
  @@index([etcParameterVersionId])
}

// ── 行程段 ─────────────────────────────────────────────────────────
model TripSegment {
  id                  String            @id @default(cuid())
  travelApplicationId String
  travel              TravelApplication @relation(fields: [travelApplicationId], references: [applicationId], onDelete: Cascade)

  sortOrder   Int                           // 0..n-1，依提交陣列索引重寫（D15）
  origin      String?
  destination String?
  totalKm     Decimal? @db.Decimal(10, 2)   // D5：2 位小數（金額語意，須人類批准）
  highwayKm   Decimal? @db.Decimal(10, 2)

  // ── 段快照（完成時寫入，不可變）──
  snapshotFuelAmount Decimal? @db.Decimal(14, 4)  // 取整前
  snapshotEtcAmount  Decimal? @db.Decimal(14, 4)  // 取整前
  snapshotRawAmount  Decimal? @db.Decimal(14, 4)  // 取整前（油資+ETC）
  snapshotAmount     Int?                          // 取整後（整數）

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([travelApplicationId, sortOrder])
}
```

### 7.2 設計說明

- **父子表（D1）**：狀態、擁有人／操作者、排序日期、最終金額集中於 `Application`，使**綜合查詢為單表索引查詢**（FE-US-04/05、BE-US-29、AC-67/91），且 PHASE-008 報表、PHASE-009 版本關聯／作廢欄位只需加在父表一處；型別專屬欄位（差旅日期／目的、保養 5 欄、折舊年度）留在子表保有 NOT NULL 型別安全。
- **`primaryDate` 非空（D9）**：避免 null 排序與「新建空白草稿消失」；語意為「列表歸屬日期」。**統計權威仍是 `tripDate`**（PHASE-005 明文），已完成差旅必有 `tripDate`，故不污染統計。
- **金額欄位不重複**：整筆最終金額只存 `Application.totalAmount`（單一真相）；`TravelApplication` 只存差旅專屬的取整前金額與總里程。
- **`snapshotTotalKm` 的必要性**：非 BE-US-18 明文要求，但使 PHASE-005 區間統計可單表 `SUM`，避免每次 join 段落（NFR-US-14）。屬效能導向的派生快照，與段落資料一致性由「完成後段落凍結」保證。
- **附件關聯**：維持 PHASE-003 弱關聯（`refType=TRIP_SEGMENT` + `refId=TripSegment.id`，**無 FK**，D11-b）；引用完整性由服務層在同交易內保證（刪段必 detach，AC-11）。
- **`onDelete: Restrict`（User → Application）**：使「有歷史即拒刪」在 DB 層有最後防線；友善 409 由 `userHasHistory` 於應用層先行回覆（AC-92）。
- **`ApplicationStatus.VOIDED` 提前宣告**：PHASE-005 的「僅計已完成且未作廢」過濾條件需要該值存在才寫得出；本 Phase 無任何寫入路徑（AC-58）。反之 **PHASE-009 的作廢欄位（原因／操作者／時間）與版本關聯欄位不提前建立**（YAGNI；009 自帶 migration）。

### 7.3 Migration

- **Migration 1**：新增 `ApplicationType`、`ApplicationStatus` enum + `Application`、`TravelApplication`、`TripSegment` 三表與索引。不觸及既有 `User`/`Session`/`AuditLog`/`Attachment`/三類 `ParameterVersion` 表結構，**但** `User` 新增兩個反向關聯欄位（`applicationsAsOwner`、`applicationsAsCreator`，Prisma relation 需要，不產生 DB 欄位）。
- **Migration 2**：`AuditAction` 追加 `APPLICATION_CREATED_ON_BEHALF`、`APPLICATION_UPDATED_ON_BEHALF`（PostgreSQL `ALTER TYPE ... ADD VALUE`；沿用 PHASE-003a-T5 已驗證之獨立 migration 作法，避免與同交易內使用衝突）。
- **不變式**：
  1. `Application.status=COMPLETED` ⟹ `totalAmount`、`completedAt` 非空，且 `TravelApplication.fuelUnitPrice`/`etcUnitPrice`/`calculatedAt`/`snapshotTotalKm`/`snapshotRawAmount` 非空，且每段 `snapshotAmount` 非空。
  2. `Application.status=DRAFT` ⟹ 上述快照欄位全為 null。
  3. 快照欄位一經寫入**不再更新**（無任何 UPDATE 路徑會改動；由狀態機守門保證）。
  4. `TripSegment.sortOrder` 於同一 `travelApplicationId` 內為 `0..n-1` 連續且唯一（由整份儲存重寫保證；不加 DB 唯一鍵以避免重排時的中途衝突，見 D15）。
  5. `Attachment.refType=TRIP_SEGMENT` 且 `status=LINKED` ⟹ 其 `refId` 指向存在的 `TripSegment`（服務層交易保證）。
- **Rollback 影響**：見 §12。

---

## 8. API Contract

- 路徑經 nginx `/api` 反向代理至後端（去 `/api` 前綴，PHASE-001 定案）；下表為**後端實際 route**，前端呼叫時加 `/api`（沿用 `toFrontendUrl()` 慣例處理 DTO 內回傳之路徑，並沿用 `credentials: 'include'` 與 `parseApiResponse`）。
- 所有端點回應成功／錯誤皆 JSON，錯誤統一格式（PHASE-001 §5.2）。
- **金額與里程一律以字串表示 `Decimal`**（避免 JSON number 浮點失真，沿用 PHASE-003a DTO 慣例）；**最終申報金額以 JSON number（整數）表示**。

### 8.1 DTO

```ts
type ApplicationStatusDto = "DRAFT" | "COMPLETED" | "VOIDED";
type ApplicationTypeDto   = "TRAVEL" | "MAINTENANCE" | "DEPRECIATION";

interface BlockerDto {
  code: string;            // 例：TRIP_DATE_REQUIRED / SEGMENT_REQUIRED / SEGMENT_TOTAL_KM_INVALID
                           //     SEGMENT_HIGHWAY_GT_TOTAL / SEGMENT_ATTACHMENT_REQUIRED
                           //     PARAMETER_NOT_AVAILABLE / PURPOSE_REQUIRED / SEGMENT_LOCATION_REQUIRED
  field?: string;          // 例："tripDate" | "segments[1].totalKm"
  segmentId?: string;      // 精確定位（優於索引，並發下穩定）
  segmentIndex?: number;   // 顯示用序號
  message: string;         // zh-TW
}

interface TripSegmentDto {
  id: string;
  sortOrder: number;
  origin: string | null;
  destination: string | null;
  totalKm: string | null;      // Decimal 字串，2 位小數
  highwayKm: string | null;
  attachments: AttachmentDto[]; // 沿用 PHASE-003 AttachmentDto（含 previewUrl / downloadUrl）
  snapshot: {                   // 僅 COMPLETED
    fuelAmount: string;         // 取整前
    etcAmount: string;          // 取整前
    rawAmount: string;          // 取整前（油資+ETC）
    amount: number;             // 取整後（整數）
  } | null;
}

interface TravelComputedDto {   // 草稿即算預覽（後端計算，非快照）
  parameterAvailable: boolean;
  missingParameters: ("FUEL" | "ETC")[];
  fuelUnitPrice?: string;       // 是否回傳見 D6
  etcUnitPrice?: string;        // 是否回傳見 D6
  totalKm: string;
  segments: { segmentId: string | null; segmentIndex: number;
              fuelAmount: string; etcAmount: string; rawAmount: string; amount: number }[];
  totalRawAmount: string;
  totalAmount: number;
}

interface TravelSnapshotDto {   // 僅 COMPLETED（讀快照，非重算）
  fuelUnitPrice: string;
  etcUnitPrice: string;
  fuelParameterVersionId: string;
  etcParameterVersionId: string;
  totalKm: string;
  totalRawAmount: string;
  totalAmount: number;
  calculatedAt: string;         // ISO
}

interface TravelApplicationDto {
  id: string;
  type: "TRAVEL";
  status: ApplicationStatusDto;
  ownerId: string;
  ownerDisplayName: string;
  createdById: string;
  createdByDisplayName: string;
  onBehalf: boolean;            // createdById !== ownerId
  tripDate: string | null;      // YYYY-MM-DD
  purpose: string | null;
  segments: TripSegmentDto[];
  completionBlockers: BlockerDto[];  // DRAFT 有值；COMPLETED 為 []
  computed: TravelComputedDto | null;  // DRAFT：即算預覽；COMPLETED：null
  snapshot: TravelSnapshotDto | null;  // COMPLETED：快照；DRAFT：null
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface ApplicationListItemDto {   // 綜合列表（混合三類）
  id: string;
  type: ApplicationTypeDto;
  status: ApplicationStatusDto;
  primaryDate: string;          // YYYY-MM-DD（歸屬日期）
  tripDate: string | null;      // 差旅專屬；非差旅為 null（前端顯「—」）
  title: string | null;         // 差旅＝出差目的；非差旅由各自 Phase 定義
  totalKm: string | null;       // 差旅已完成才有；否則 null
  totalAmount: number | null;   // 已完成才有；否則 null
  segmentCount: number | null;  // 差旅專屬
  ownerId: string;
  ownerDisplayName: string;
  onBehalf: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ApplicationListResponse {
  items: ApplicationListItemDto[];
  page: number;
  pageSize: number;
  total: number;
  appliedFilters: {             // 後端回報實際套用的條件（AC-60 可驗證）
    dateFrom: string | null;
    dateTo: string | null;
    type: ApplicationTypeDto | null;
    status: ApplicationStatusDto | null;
    keyword: string | null;
    ownerId: string;
  };
}
```

### 8.2 差旅端點

| 方法 | 路徑 | 中介 | Request | 成功回應 | 主要錯誤 |
|---|---|---|---|---|---|
| POST | `/applications/travel` | auth + pwd | `{ tripDate?, purpose? }`（皆可省略） | 201 `{ application: TravelApplicationDto }` | 400 `VALIDATION_ERROR`（日期格式）；401；403 `PASSWORD_CHANGE_REQUIRED` |
| GET | `/applications/travel/:id` | auth + pwd | — | 200 `{ application: TravelApplicationDto }` | 401；403（非擁有人非管理員）；404 |
| PUT | `/applications/travel/:id` | auth + pwd | `{ tripDate?: string\|null, purpose?: string\|null, segments: SegmentInput[] }` | 200 `{ application: TravelApplicationDto }` | 400；401；403（他人／已完成）；404；409 `TOO_MANY_ATTACHMENTS` |
| DELETE | `/applications/:id` | auth + pwd | — | 200 `{ ok: true }` | 401；403（他人／已完成 AC-06）；404 |
| POST | `/applications/travel/preview` | auth + pwd | `{ tripDate?: string\|null, segments: { totalKm?, highwayKm? }[] }` | 200 `{ preview: TravelComputedDto }` | 400（里程格式）；401；403 |
| POST | `/applications/:id/complete` | auth + pwd | 空 body（**任何欄位一律忽略**，AC-54） | 200 `{ application: TravelApplicationDto }`（`status=COMPLETED` + `snapshot`） | 400 `VALIDATION_ERROR`（`details.blockers[]`，AC-52）；401；403（他人／非草稿）；404；409 `PARAMETER_NOT_AVAILABLE` |
| GET | `/applications` | auth + pwd | query：`dateFrom? dateTo? type? status? keyword? page? pageSize? ownerId?` | 200 `ApplicationListResponse` | 400（日期／分頁）；401；403（一般使用者自帶他人 `ownerId`） |
| POST | `/admin/users/:userId/applications/travel` | auth + pwd + **admin** | 同 `POST /applications/travel` | 201 `{ application: TravelApplicationDto }`（`ownerId=:userId`） | 400（使用者已停用）；401；403（非管理員）；404（使用者不存在） |

```ts
interface SegmentInput {
  id?: string;                 // 有 id → 更新既有段；無 id → 新增
  origin?: string | null;
  destination?: string | null;
  totalKm?: string | number | null;
  highwayKm?: string | number | null;
  attachmentIds: string[];     // 該段之附件（最多 3；後端據此 link/detach）
}
```

> **`PUT` 語意（D15）**：整份替換 + 以 `id` 對齊 diff。未出現於 `segments[]` 的既有段落 → 刪除並 detach 其附件；`sortOrder` 依陣列索引重寫。`attachmentIds` 中新增者 → link（`limit=3`、`containerState` 由服務層注入）；原本 LINKED 但已移除者 → detach。全部在**單一交易**內完成。
>
> **`tripDate`/`purpose` 的三態**：欄位缺席 = 不變；`null` = 清空；有值 = 設定。

### 8.3 既有附件端點的改造（PHASE-003）

| 端點 | 改造 |
|---|---|
| `POST /attachments` | **新增可選 `ownerId`**（僅 ADMIN 可指定他人；一般使用者指定他人 → 403）。`uploaderId` 恆為呼叫者（AC-29）。此為 PHASE-003 D3「代操作留 PHASE-004」之預留路徑落地。 |
| `POST /attachments/:id/link` | **移除**（D12）。服務層 `linkAttachment()` 保留供內部呼叫。 |
| `DELETE /attachments/:id` | 移除 client `containerState` 參數；改由後端依 `refType/refId` → `TripSegment` → `Application.status` 推導（AC-26/27）。`TEMP`（無容器）→ `draft`。 |
| `GET /attachments/:id/content|thumbnail` | 不變（沿用 PHASE-003 授權）。 |

### 8.4 前端路由（新增／調整）

| 路由 | 說明 |
|---|---|
| `/`（HomePage） | 由 placeholder 改為**個人綜合列表 + 篩選 + 新增入口**（FE-US-04/05） |
| `/applications/travel/new` | 建立草稿（呼叫 POST 後導向 `:id`） |
| `/applications/travel/:id` | 草稿編輯表單（多段／預覽／附件）；已完成則轉檢視態 |
| `/admin/users/:userId/applications` | 管理員檢視指定使用者紀錄 + 代操作入口（AD-US-06/07） |
| `/attachments-demo`（既有） | PHASE-003 最小宿主頁；因 link 端點移除須調整或移除（見 D12） |

### 8.5 錯誤碼（沿用 + 新增）

新增 `ErrorCode`：

| code | HTTP | 用途 |
|---|---|---|
| `PARAMETER_NOT_AVAILABLE` | 409 | 出差日期無有效油資／ETC 參數，無法完成（AC-47）；`details.missing: ("FUEL"\|"ETC")[]`、`details.tripDate` |

沿用既有：`VALIDATION_ERROR`(400，帶 `fields`；完成失敗另帶 `details.blockers[]`)、`UNAUTHORIZED`(401)、`FORBIDDEN`(403，含他人資源／已完成拒改／附件鎖定)、`PASSWORD_CHANGE_REQUIRED`(403)、`NOT_FOUND`(404)、`CONFLICT`(409，附件已關聯／併發完成落敗／使用者有歷史拒刪)、`TOO_MANY_ATTACHMENTS`(409)、`PAYLOAD_TOO_LARGE`(413)、`UNSUPPORTED_MEDIA_TYPE`(415)、`INTERNAL_ERROR`(500)。

「已完成拒改」定案 **403 `FORBIDDEN`**（與 PHASE-003 §4.8「已完成不得刪除/替換附件」同語意族，避免碼義擴散）；`message` 為 zh-TW 並提示建立修正版（D13）。

---

## 9. Data Flow（本 Phase 影響部分）

```
── 建立草稿 ────────────────────────────────────────────────────────────
使用者 → POST /applications/travel
  【授權】requireAuth（401）→ requirePasswordChanged（403）
  → owner = 呼叫者（不接受 body ownerId）
  → primaryDate = tripDate ?? 今日（D9）
  → 交易：建立 Application(DRAFT) + TravelApplication
  → 201 DTO（completionBlockers 由純函式即算）

管理員代建立 → POST /admin/users/:userId/applications/travel
  【授權】+ requireAdmin（403）→ 查 :userId 存在且 isActive（否則 400/404）
  → owner = :userId、createdBy = 管理員
  → 交易：建立 + 【稽核】tx.auditLog.create(APPLICATION_CREATED_ON_BEHALF)（同交易，失敗即 rollback）

── 儲存草稿（整份 PUT）─────────────────────────────────────────────────
使用者/管理員 → PUT /applications/travel/:id
  【授權】requireAuth + requirePasswordChanged → 查 Application → assertOwnershipOrAdmin(actor, DB.ownerId)
  【狀態機】status 必須為 DRAFT，否則 403（AC-56）
  → 格式驗證（日期格式、里程 ≤2 位小數、長度上限）→ 不合格 400（不落地）
  → 交易開始：
      ① 段落 diff（以 id 對齊）：更新 / 新增 / 刪除
      ② 被刪除段落之 LINKED 附件 → detachAttachment（LINKED→TEMP，createdAt 重置）
      ③ sortOrder 依陣列索引重寫 0..n-1
      ④ 每段附件對帳：
           新增者 → 驗附件存在 + attachment.ownerId === application.ownerId（否則 403）
                  → linkAttachment(limit=3, containerState=服務層依 status 注入 'draft')
                  → 超限 → 409 TOO_MANY_ATTACHMENTS（整份 rollback）
           移除者 → detach
      ⑤ tripDate/purpose 更新；primaryDate = tripDate ?? createdAt 之日期
      ⑥ 若 actor ≠ owner →【稽核】tx.auditLog.create(APPLICATION_UPDATED_ON_BEHALF)
  → 交易提交
  → 讀回完整 DTO：completionBlockers（純函式）+ computed（依 tripDate 查參數後由計算引擎即算；缺參數則 parameterAvailable=false）
  → 200

── 金額預覽（stateless）────────────────────────────────────────────────
使用者 → POST /applications/travel/preview
  【授權】requireAuth + requirePasswordChanged
  → 依 tripDate 取全部 Fuel/Etc 版本 → findEffectiveVersion(versions, tripDate)（PHASE-003a）
  → 缺任一 → parameterAvailable=false、missingParameters
  → 計算引擎（純函式，Prisma.Decimal）：
        segFuel = totalKm × fuelUnitPrice          （未取整）
        segEtc  = highwayKm × etcUnitPrice          （未取整）
        segRaw  = segFuel + segEtc                  （先相加）
        segAmt  = ROUND_HALF_UP(segRaw, 0)          （再取整；非銀行家）
        totalAmount = Σ segAmt                      （加總已取整）
        totalKm     = Σ totalKm                     （高速不重複加）
  → 200（不寫 DB，AC-36）

── 完成申請 ────────────────────────────────────────────────────────────
使用者 → POST /applications/:id/complete（body 一律忽略，AC-54）
  【授權】assertOwnershipOrAdmin（以 DB ownerId 為準）
  → 交易開始（SERIALIZABLE 或條件式更新 WHERE status='DRAFT'，防併發雙完成 B-29）：
      ①【狀態機】assertTransition(DRAFT → COMPLETED)，非 DRAFT → 403
      ② 完整性驗證（純函式，回全部 blockers；非空 → 400 VALIDATION_ERROR + details.blockers，rollback）
           tripDate 必填 / purpose 必填 / ≥1 段
           每段：origin、destination 非空；totalKm > 0；highwayKm ≥ 0；highwayKm ≤ totalKm
           每段：LINKED 附件數 ≥ 1（且 ≤ 3）
      ③ 依 tripDate 查有效油資 + ETC 版本；任一缺 → 409 PARAMETER_NOT_AVAILABLE（rollback）
      ④ 計算引擎（同上純函式）
      ⑤ 寫入快照：各段 snapshotFuel/Etc/Raw/Amount；TravelApplication 單價/版本 id/totalKm/rawAmount/calculatedAt；
                  Application.totalAmount / completedAt / status=COMPLETED
      ⑥ 附件即刻受鎖定保護（不改 Attachment 資料列；由容器狀態推導，PHASE-003 D2）
  → 交易提交 → 200 DTO（snapshot；computed=null）

── 綜合查詢 ────────────────────────────────────────────────────────────
使用者/管理員 → GET /applications?…
  【授權】一般使用者：忽略/拒絕他人 ownerId → 403（AC-74）；管理員：可指定 ownerId
  → 日期正規化：未提供 → dateFrom = 今日−1年、dateTo = null（D9）；dateFrom > dateTo → 400
  → where: ownerId AND primaryDate BETWEEN [dateFrom, dateTo]（含當日）
            AND type? AND status? AND (keyword? → TravelApplication.purpose contains, insensitive)
  → orderBy: primaryDate DESC, createdAt DESC, id DESC
  → skip=(page-1)*pageSize, take=pageSize（pageSize clamp ≤ 100）
  → 併行 count() 取 total
  → 200 { items, page, pageSize, total, appliedFilters }

── 附件（改造點）──────────────────────────────────────────────────────
DELETE /attachments/:id
  【授權】requireAuth + requirePasswordChanged → assertOwnershipOrAdmin(actor, attachment.ownerId)
  → 【AR-D 閉環】containerState 推導：
        attachment.status=TEMP → 'draft'
        refType=TRIP_SEGMENT → 查 TripSegment → TravelApplication → Application.status
             COMPLETED → 'completed' → assertContainerMutable → 403（AC-26）
             DRAFT → 'draft'
        refType=MAINTENANCE/DEPRECIATION → 子表尚不存在 → 'draft'（本 Phase 不可能產生此關聯）
  → client 傳入之 containerState 一律忽略（AC-27）

── 引用保護閉環 ────────────────────────────────────────────────────────
userHasHistory(prisma, userId)
  → prisma.application.count({ where: { ownerId: userId } }) > 0（AC-92）
parameterHasReferences("FUEL"|"ETC", versionId)
  → prisma.travelApplication.count({ where: { application: { status: 'COMPLETED' },
                                              fuelParameterVersionId | etcParameterVersionId: versionId } }) > 0（AC-93）
HasReferenceQuery（供 PHASE-011）
  → hasReference(attachmentId) = 該附件是否被任何 TripSegment（LINKED refId）引用
```

**後端權威點（不可繞過）**：
1. 金額與里程計算：**只在計算引擎純函式**，輸入為 DB 中的段落資料與 DB 中的參數版本，**永不來自請求體**（AC-35/44/54）。
2. 授權：**只依 DB 查得之 `ownerId`**（AC-73/74）。
3. 附件容器狀態：**只依 DB 查得之 `Application.status`**（AC-27）。
4. 附件上限：**後端常數 3**，client 不得提供（AC-22）。
5. 未完成項：**後端 `completionBlockers`** 為權威，前端即時提示僅為 UX（AC-03）。

---

## 10. 非功能需求

### 10.1 NFR-US-10（附件存取安全）
- 差旅附件沿用 PHASE-003 授權端點；他人 403、未登入 401、管理員可（AC-28）。
- 附件擁有人與申請擁有人一致（AC-30）；代上傳以 `ownerId` 明示（AC-29）。
- volume 不經 nginx 靜態直出（PHASE-003 D7 已確認，本 Phase 不改變此拓撲）。

### 10.2 NFR-US-14（基本效能）
- 列表／詳情目標 < 2s；儲存／完成目標 < 2s（不含附件上傳等待）。
- 查詢須走 `@@index([ownerId, status, primaryDate])`；分頁以 `skip/take` + `count` 於 DB 執行，**禁止**應用層全量載入後分頁（AC-91）。
- 草稿 DTO 之 `computed` 需查參數版本：以「該類全部版本」`findMany` 後純函式選版（版本數量級小，PHASE-003a §7 已評估）；預覽端點前端須 debounce（建議 300ms）避免每鍵一請求。
- 完成流程之交易應盡量短：驗證與計算為純函式（無 IO），交易內僅 DB 讀寫。

### 10.3 NFR-US-16（結構化錯誤處理）
- 統一錯誤格式；欄位錯誤帶 `fields`；完成失敗帶 `details.blockers[]`（含 `segmentId` 定位）；缺參數帶 `details.missing`。
- 不外洩堆疊／DB 結構／storage 路徑；`INTERNAL_ERROR` 只回 `requestId`。
- 日誌沿用 `sanitizeForLog` + pino redact；不記錄 cookie／密碼／token。

### 10.4 其他
- **env**：本 Phase **不新增環境變數**（附件上限 3 為業務常數而非環境設定；分頁上限 100 同）。
- **合成資料**：測試全程合成（地名、目的、姓名皆虛構）。
- **zh-TW**：所有使用者可見文案。
- **可搬遷**：純業務資料表 + 端點，隨既有容器部署。

---

## 11. 測試策略

TDD：每 Task 先寫**會失敗**的測試再實作；不得刪除／弱化／skip 測試換綠燈。

### 11.0 測試紀律（強制，寫入每個 Task Packet）
- **測試隔離**：新測試檔的清理**一律限定自建資料**（依自建 `loginName` 前綴、自建 `application.id` 陣列、自建 `attachment.id` 陣列），**禁用全域 `deleteMany({})`**（承 PHASE-003-T1R 事故）。
- **資料模型類 Task 驗收**：須於**同一 DB 連跑兩輪**全綠（承 PHASE-003 驗收紀律）。
- **鑑別力自證**：每組核心測試須能在「拿掉實作／改為錯誤實作」時變紅；下表逐項標明反向案例。
- **lint 驗收**：一律 repo root `npx biome check .` 全掃並貼出實際輸出。

### 11.1 單元（Vitest，不需 DB）— 純函式為主

| 對象 | 案例數量級 | 鑑別力自證 |
|---|---|---|
| **計算引擎**（AC-37~44） | ≥ 25 | ① `fuel=0.4, etc=0.4 → 1`（若「各自取整再相加」得 `0`）；② `2.5 → 3`（若 half-even 得 `2`）；③ 三段各 `0.5` → 整筆 `3`（若「先加未取整再取整」得 `2`）；④ `totalKm=10, highwayKm=10` → 總里程 `10`（若重複加得 `20`）；⑤ 單價 4 位小數 × 里程 2 位小數之乘積精度（以 `Decimal` 驗，浮點實作會失真）；⑥ 空段陣列 → 金額 0 且不拋例外 |
| **里程驗證**（AC-14~20） | ≥ 15 | `totalKm=0`／`-0.01`／`0.01`；`highwayKm=-0.01`／`0`／`==totalKm`／`totalKm+0.01`（最小差值鑑別 off-by-one）；小數位 2 vs 3；地點空字串 vs 純空白 vs 有值 |
| **狀態機**（AC-55~58） | ≥ 8 | 完整轉換矩陣（3×3）逐格斷言；`DRAFT→COMPLETED` 唯一允許；`VOIDED` 相關全拒 |
| **`completionBlockers` 產生器**（AC-03/52） | ≥ 12 | 單一缺項、多重缺項（須回**全部**而非第一項）、`segmentId` 正確對應、0 段、缺參數旗標 |
| **段落 diff / sortOrder 重寫**（AC-08/10/11/13） | ≥ 10 | 純新增／純刪除／重排／混合；`sortOrder` 結果為 `0..n-1`；被刪 id 集合正確（供 detach） |
| **查詢條件建構**（AC-60~67） | ≥ 12 | 預設近一年之 `dateFrom` 計算；含當日邊界（`dateFrom` 當日與前一日）；`dateFrom>dateTo` 拒；關鍵字空白正規化；`pageSize` clamp；`page` 非法 |
| **`primaryDate` 推導**（D9/B-26） | ≥ 5 | `tripDate` 有值 → 用之；清空 → 回退建立日；未來日期不被截斷 |

### 11.2 整合（Vitest + PostgreSQL + 真實 route）

| 群組 | 內容 | 鑑別力自證 |
|---|---|---|
| **草稿 CRUD**（AC-01~07） | 建立／讀取／整份儲存／刪除；不完整可存；blockers 隨資料變化 | 刪除草稿後其附件確為 `TEMP` 且 `refId` 為 null |
| **多段行程**（AC-08~13） | diff 三種情形 + 排序往返；刪段 detach | 重排後重讀順序一致；被刪段之附件狀態變更**於同交易**（中途失敗則全不變） |
| **附件整合**（AC-22~30） | 3/段上限；0 張可存草稿；完成後拒刪；owner 一致性；代上傳 `ownerId` | **AR-D 鑑別力**：對已完成申請之附件送 `DELETE /attachments/:id?containerState=draft` → 仍 403；對草稿附件送 `?containerState=completed` → 仍成功（證明 client 參數完全無效）。`POST /attachments/:id/link` → 404（端點已移除） |
| **計算與參數**（AC-45~48） | 端到端金額；含當日邊界選版；缺參數 | **快照不變性**：完成後新增／變更參數版本，重讀該申請金額與單價**位元級不變**（若實作誤為「讀取時重算」將變化） |
| **完成流程**（AC-49~54） | 成功路徑；多重缺項列全部；原子性 | **原子性鑑別力**：以 stub 令快照寫入後之步驟拋錯 → 斷言 `status` 仍為 `DRAFT`、無任何快照欄位、附件仍可刪 |
| **後端權威**（AC-35/54） | `PUT`/`complete` body 夾帶 `totalAmount=999999`、段 `amount=0` | 回應與 DB 皆為後端計算值（若實作採信前端將顯著不同） |
| **狀態鎖定**（AC-56/59） | 已完成後 `PUT`／`DELETE`／刪附件／改段落 | 全 403 且 DB 無變更 |
| **綜合查詢**（AC-60~71） | 預設近一年、含當日、多條件 AND、關鍵字、分頁、排序穩定、空結果、未實作類型 | **含當日鑑別力**：出差日恰為 `dateFrom`／`dateTo` 當日必命中；前／後一日必不命中。**分頁穩定性**：同日多筆跨頁不重不漏 |
| **權限矩陣**（AC-72~77、85） | 對每個端點覆蓋 {擁有者、他人一般使用者、管理員、未登入、`mustChangePassword` 使用者} × {存在／不存在資源} | 他人請求回應 body **不含**任何業務欄位（逐鍵斷言） |
| **代操作與稽核**（AC-78~86） | 代建立／代修改；owner/creator 分離；未選使用者；停用使用者 | **稽核原子性雙向**：稽核寫入失敗 → 申請不落地；操作被 403 拒絕 → 無稽核列。**稽核安全**：`summary`/`targetLabel` 逐鍵斷言不含 `password`/`token`/`cookie`/`secret` 字樣 |
| **併發**（B-29/B-30） | 同時完成同一草稿；同段同時 link 第 3、4 張 | 一成一敗；DB 內恰一份快照／恰 3 張附件 |
| **引用保護**（AC-92/93） | `userHasHistory`、`parameterHasReferences` | 有申請 → 刪除 409；刪除該申請後 → 可刪。已完成引用之版本 → `true`；草稿引用（無快照）→ `false` |
| **Decimal 精度** | 里程／單價／金額往返 | 寫入 `12.35` 讀回 `12.35`（浮點實作會出現 `12.349999…`） |

### 11.3 前端頁面測試（Vitest + Testing Library，mock fetch）

| 頁面 | 測試 |
|---|---|
| 個人列表 | 五態各一（Loading／Empty＋新增入口／Error＋重試／Success 清單與分頁／Permission denied）；類型標籤與狀態徽章；不適用欄位顯「—」；篩選送出正確 query；篩選後空結果非錯誤 |
| 差旅表單 | 五態；新增／刪除段落；段落順序 UI；里程即時錯誤提示；預覽區顯示**後端回傳值**（不自算）；附件上限 3 之 UI 停用與後端 409 回饋；未儲存離開提示；防重複提交 |
| 差旅檢視（已完成） | 顯示快照金額與各段明細；**無**編輯／刪除／刪附件入口；顯示「建立修正版」提示文案 |
| 管理員使用者紀錄頁 | 五態；代建立入口在未選使用者時停用；一般使用者進入 → permission denied |

> 前端**不得**自行計算金額（後端權威）；預覽數值一律來自 mock 之後端回應（對齊 PHASE-003a-T6 慣例）。

### 11.4 E2E（Playwright，整合 Gate）

1. 使用者登入 → 建草稿 → 加 2 段 → 各段上傳截圖 → 預覽金額 → 儲存 → 完成 → 列表顯示「已完成」與正式金額。
2. 缺參數路徑：出差日期設為無參數之日 → 可存草稿 → 完成被拒並顯示「聯絡管理員」。
3. 資料隔離：使用者 B 以直連 URL 存取 A 的申請與附件 → 皆不得取得。
4. 管理員：檢視 A 的紀錄 → 代建立草稿 → 編輯 → 對 A 已完成申請按編輯 → 顯示「請建立修正版」。
5. **響應式**（AC-87~89）：375px viewport 下多段表單為垂直區塊、`document.body.scrollWidth <= window.innerWidth`（無水平溢位）、檔案輸入具 `accept` 影像型別。

### 11.5 安全與日誌測試
- 斷言錯誤回應與伺服器日誌**不含** storage 絕對路徑、堆疊、DB 結構、cookie、密碼（以 logStream 擷取，沿用 PHASE-003 §9.4 模式）。
- 斷言他人資源之 403 回應 body 不含任何業務欄位。
- 斷言關鍵字含 SQL 萬用字元時為字面比對（B-23）。

### 11.6 AC → 測試層對照（摘要）

| 層 | 覆蓋 AC |
|---|---|
| 單元 | 03、08、10、13、14~20、31~34、37~44、45（選版純函式）、52（blockers 產生）、55~58、60~67 |
| 整合 | 01~07、09、11~13、21~30、35、36、43、45~54、56、59、60~86、90、92、93 |
| 前端 | 03、51、68~70、87~89（部分）、五態全部 |
| E2E | 04、24、47、49、51、73、78、81、87~89 |
| 效能（PHASE-011 集中） | 91 |

---

## 12. Rollback

- 本 Phase 新增：2 enum + 3 資料表 + 2 個 `AuditAction` 值 + 差旅端點 + 附件端點改造 + 計算／狀態機／驗證引擎 + 前端列表與表單頁；於 `phase-004` branch 實作、Draft PR。
- **開發階段回滾**（合成資料）：branch 還原至 `6041af4`；down migration 移除三表與兩 enum；`AuditAction` 追加值之移除需注意既有稽核列引用（開發期可重建）。
- **附件影響**：回滾前應先將所有 `refType=TRIP_SEGMENT` 的 `LINKED` 附件 detach 回 `TEMP`（否則 `refId` 指向已刪表，成為孤兒 refId；因無 FK，DB 不會阻擋）。此步驟須寫入回滾程序。
- **不可逆資產**：已完成差旅之快照與「附件鎖定」為不可逆語意。**一旦存在正式（非合成）已完成資料，回滾為人類決策**，不得由 AI 執行破壞性 down migration。
- **附件端點 contract 變更之回滾**：移除 `POST /attachments/:id/link` 屬公開 contract 移除；回滾即還原該 route（服務層函式未刪，還原成本低）。
- **前端**：HomePage 由 placeholder 改為列表頁；回滾即還原該檔。
- 若採 D18（拆 004a/004b），回滾單位縮小為各自 branch，風險進一步下降。

---

## 13. Architecture / Data Flow 影響（本 Phase 不直接修改該兩份文件）

> 依 Packet「Architecture Change Permission：只能在 Spec 內描述影響」，以下僅為**建議更新點**，由大總管於 Gate 後決定是否派工更新 `docs/ARCHITECTURE.md` / `docs/DATA_FLOW.md`（兩者現為 DRAFT）。

1. **ARCHITECTURE §3**：`applications` 模組補註「父表 `Application` 承載狀態／擁有人／操作者／`primaryDate`／`totalAmount`；`trips` 模組承載 `TravelApplication` + `TripSegment`」（D1 定案後）。
2. **ARCHITECTURE §4.1（Calculation Engine）**：補註差旅計算之 `Decimal` 精度定案（單價 `Decimal(10,4)`、里程 `Decimal(10,2)`、取整前金額 `Decimal(14,4)`、最終金額 `Int`、`ROUND_HALF_UP`）（D4/D5 定案後）。
3. **ARCHITECTURE §4.3（申請狀態機）**：補註本 Phase 可達狀態集合（`DRAFT`/`COMPLETED`）與 `VOIDED` 提前宣告但不可達之定案（D2）。
4. **ARCHITECTURE §4.4（計算快照）**：補註差旅快照的具體欄位落點（父表 `totalAmount`、子表單價／版本 id／總里程／取整前金額、段表四欄）（D3）。
5. **ARCHITECTURE §4.5（附件生命週期）**：補註 **`containerState` 由申請服務層依狀態機注入、公開 link 端點移除**（AR-D 閉環，D12）；補註「附件 owner 必須等於申請 owner」不變式（D11）。
6. **ARCHITECTURE §4.6（綜合查詢與資料隔離）**：補註分頁形狀（offset + `page/pageSize/total`）、預設近一年語意、排序鍵（D9/D10）。
7. **DATA_FLOW §1.1**：`Application`/`TravelApplication`/`TripSegment` 實體屬性補齊；`Attachment` 補「owner 須等同申請 owner」。
8. **DATA_FLOW §2.2 / §2.3 / §2.8**：以本 Spec §9 的流程圖取代／具體化（含後端權威點與 AR-D 閉環）。
9. **PROJECT_STATE 跨 Phase 追蹤**：`userHasHistory`（AD-US-04）與 `parameterHasReferences`（PHASE-003a §4.7）於本 Phase 閉環，可自「待閉環」移除；FE-US-05 之「報表編號關鍵字」仍待 PHASE-008。

---

## 14. 已知限制

1. **關鍵字僅比對出差目的**：FE-US-05 的「報表編號」關鍵字須待 PHASE-008 產生報表編號後擴充（PRD §4.1 已將此列為 FE-US-05 的 PHASE-008 次要關聯）。**非縮減 AC**，屬 Phase 邊界；須列入跨 Phase 追蹤。
2. **列表僅有差旅類型**：FE-US-04「混合顯示三類」在 PHASE-006/007 完成後才完整；本 Phase 之查詢 API 已支援 `type` 篩選與混合排序骨架（AC-71）。
3. **`VOIDED` 不可達**：作廢語意於 PHASE-009 才存在；PHASE-005 的「未作廢」過濾在 009 之前恆真。
4. **修正版僅有提示**：已完成申請之修改一律 403 並提示建立修正版；功能於 PHASE-009。
5. **附件 `refType=MAINTENANCE/DEPRECIATION` 的容器狀態推導**：本 Phase 視為 `draft`（該類容器尚不存在，實務上不可能產生此關聯）；PHASE-006/007 須各自補上推導分支——列入跨 Phase 追蹤。
6. **弱關聯無 DB 外鍵**：`Attachment.refId` → `TripSegment.id` 無 FK（D11-b）；孤兒 refId 之防護完全依賴服務層交易（AC-11）與回滾程序（§12）。
7. **段數無業務上限**（B-14）：US 未定義；僅受請求體大小限制。若人類要求上限，屬新增使用者可見規則，須另行批准。
8. **`primaryDate` 對草稿為建立日**（D9）：若使用者建立草稿後很久才填入很早的出差日期，該草稿在填入前是以建立日參與篩選。已完成申請一律以出差日期為準，故不影響統計與報帳。
9. **效能未於本 Phase 量測**：NFR-US-14 之數值驗證集中於 PHASE-011；本 Phase 只保證索引與分頁策略正確（AC-91）。
10. **`AttachmentsDemoPage`（PHASE-003 最小宿主頁）**：因 link 端點移除須調整或移除（D12），屬使用者可見頁面之變更。

---

## 15. Task Graph

> 以 PRD PHASE-004 T1~T14 為基礎，依本 Spec 之分析調整。每 Task 一律 TDD、一個 atomic commit（含 Task ID）。High 判準依 CLAUDE.md（授權／資料隔離／附件權限／不可逆完成／快照／金額）。

### 調整說明（相對 PRD 初始 Task Graph）
- **T3 由「非 High」升為 High**：草稿 CRUD 是 BE-US-02「一般使用者資料隔離」在**申請資料**上的首次落地，屬授權/資料隔離。
- **T4 由「非 High」升為 High**：刪段連帶 detach 屬附件生命週期／附件權限族。
- **新增 T15**：`userHasHistory` 與 `parameterHasReferences` 的引用保護閉環（AD-US-04 不可逆刪除守門 + BE-US-19），PRD 未列但為跨 Phase 追蹤事項之閉環點，且涉及不可逆刪除故為 High。
- **T11 擴充**：除套用 3/段上限外，明確納入 **AR-D 閉環**（`containerState` 服務層注入、移除公開 link 端點、`DELETE` 改造）與代上傳 `ownerId`。

| Task | 內容 | Risk | 依賴 | Done When |
|---|---|---|---|---|
| **T1** | `ApplicationType`/`ApplicationStatus` enum + `Application`/`TravelApplication`/`TripSegment` 三表 + 索引 + migration | Medium | PHASE-002/003/003a | migration 乾淨套用；模型測試涵蓋 Decimal 往返精度、`@db.Date` 日粒度、Cascade、`Restrict`、`sortOrder` 索引；**同 DB 連跑兩輪全綠** |
| **T2** | 申請狀態機純函式 `assertTransition` + 服務層守門（已完成拒改／拒刪） | **High** | T1 | 3×3 轉換矩陣逐格測試；`DRAFT→COMPLETED` 唯一允許；已完成之 `PUT`/`DELETE` 皆 403（AC-55~59、06） |
| **T3** | 草稿 CRUD（建立／讀取／整份 `PUT` 主體／刪除）+ `completionBlockers` 產生器 + 授權隔離 | **High** | T1, T2 | AC-01~07、21、72~76 綠；權限矩陣整合測試；他人請求 body 不含業務欄位 |
| **T4** | 多段行程 diff（id 對齊）+ `sortOrder` 重寫 + 刪段 detach | **High** | T3, PHASE-003 lifecycle | AC-08~13 綠；diff 純函式單元測試；刪段 detach 於同交易 |
| **T5** | 里程驗證純函式（總里程/高速里程/地點/小數位） | Medium | T1 | AC-14~21 綠；最小差值與邊界值鑑別力測試 |
| **T6** | 差旅計算引擎純函式（單段／整筆／取整／總里程） | **High** | T5 | AC-37~44 綠；四項鑑別力案例（先加再取整、half-up 非 half-even、Σ 已取整、高速不重複）全綠 |
| **T7** | 依出差日期套用油資／ETC 參數（複用 `findEffectiveVersion`）+ 缺參數處理 + 預覽端點 | **High** | T6, PHASE-003a | AC-31~36、45~47 綠；含當日邊界；預覽不寫 DB |
| **T8** | 完成流程（狀態機 + 完整性驗證 + 參數 + 計算 + 快照 + 原子性 + 附件鎖定生效） | **High** | T2, T4, T6, T7, T11 | AC-49~54、43、48、59 綠；原子性與快照不變性鑑別力測試綠 |
| **T9** | 綜合紀錄查詢（分頁／篩選／關鍵字／排序／授權隔離） | **High** | T1, T2 | AC-60~71、74、84 綠；含當日與分頁穩定性鑑別力綠；走索引 |
| **T10** | 管理員代操作（`/admin/users/:userId/applications/travel`）+ 已完成拒改 + 代上傳 `ownerId` | **High** | T3, T2, PHASE-002 authz | AC-78~81、85、29 綠；owner/creator 分離；停用使用者拒絕 |
| **T11** | 差旅附件整合：3/段上限套用、**AR-D 閉環**（`containerState` 服務層注入、移除公開 link 端點、`DELETE` 改造）、owner 一致性 | **High** | T4, PHASE-003 T4/T5/T6 | AC-22~30 綠；**AR-D 鑑別力測試**（client 參數已無效）綠；`POST /attachments/:id/link` 回 404 |
| **T12** | 代操作稽核（`AuditAction` 擴充 + 同交易原子寫入） | **High** | T10, PHASE-002 audit | AC-82、83、86 綠；稽核安全逐鍵斷言；原子性雙向測試綠 |
| **T13** | 前端：個人綜合列表 + 篩選 + 差旅表單（多段／預覽／附件）+ 已完成檢視 + 響應式 | Medium | T3, T4, T7, T9, T11 | 五態測試綠；不自算金額；AC-68~70、87~89 綠 |
| **T14** | 前端：管理員檢視他人紀錄頁 + 代操作入口 | Medium | T9, T10, T13 | 五態測試綠；未選使用者停用入口；一般使用者 permission denied |
| **T15** | 引用保護閉環：`userHasHistory` 接 `Application`、`parameterHasReferences` 接快照、`HasReferenceQuery` 差旅實作 | **High** | T1, T8 | AC-92、93 綠；有歷史拒刪 409 並提供停用 |

**High 風險 Task**：T2、T3、T4、T6、T7、T8、T9、T10、T11、T12、T15（共 11／15）。

### 依賴圖

```
PHASE-002(authz/audit)  PHASE-003(attachment)  PHASE-003a(parameters)
        │                       │                      │
        └───────────┬───────────┴──────────┬───────────┘
                    ▼                      │
                   T1 ──────► T5 ──────► T6(High) ──────► T7(High)
                    │                                        │
                    ▼                                        │
                  T2(High)                                   │
                    │                                        │
        ┌───────────┼───────────┬──────────────┐             │
        ▼           ▼           ▼              ▼             │
      T3(High)    T9(High)   T10(High)      T15(High)◄───────┤
        │           │           │                            │
        ▼           │           ▼                            │
      T4(High)      │        T12(High)                       │
        │           │           │                            │
        ▼           │           │                            │
     T11(High) ─────┴───────────┴────────────────────────────┤
        │                                                    │
        └────────────────────► T8(High) ◄────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
                 T13(前端)                  T14(管理員前端)
```

### 若採 D18（拆 004a/004b）之分組建議

| Sub-phase | Tasks | 驗收 Gate |
|---|---|---|
| **PHASE-004a — 差旅後端核心（草稿→完成）** | T1, T2, T3, T4, T5, T6, T7, T8, T11, T15 | 事前批准（D1~D7、D11、D12、D14~D16）+ **整合 Gate**（無 UI；以 compose 真實拓撲 + API smoke + 全整合測試驗收，比照 PHASE-003a 之 compose smoke 作法） |
| **PHASE-004b — 查詢／代操作／稽核／前端** | T9, T10, T12, T13, T14 | 事前批准（D8~D10、D13、D17）+ **Mock Gate** + **整合 Gate** |

---

## 16. 需人類批准決策點（D1~D18，供 Gate 審閱）

> **Spec 內僅為建議，不得視為既定**；Gate 批准後才落地。整份 Spec 屬 High 風險，需人類事前批准後方可轉 ACTIVE。凡涉及**金額語意**（D4、D5、D6）、**公開 contract／使用者可見行為**（D8、D9、D10、D12、D13、D14）、**附件權限／安全**（D11、D12）、**Scope**（D17、D18）者，**必須由人類定案**。
>
> 依 Packet「Dependency Permission：不得新增任何依賴」——本 Phase **不新增任何 npm 依賴**（`Decimal` 由既有 `@prisma/client` 提供；日期以原生 `Date` UTC 方法處理，沿用 PHASE-003a T2 慣例；分頁以 Prisma `skip/take`）。若實作評估認為需要新依賴（如日期庫），須列為新 D 級決策交 Gate，不得自行安裝。

---

### D1 — `Application` 資料表結構

**要決定什麼**：三類申請共用一張多型表，或差旅獨立專表，或父子表。

**為什麼要決定**：此決定固化 PHASE-006（保養）、007（折舊）、008（報表編號）、009（修正版／作廢）的擴充成本，且直接決定 FE-US-04/05 混合列表與 BE-US-29 分頁能否以單表索引查詢完成。一旦有正式資料，改動成本極高。

| 選項 | 影響 |
|---|---|
| **(a) 父子表（class-table）**：`Application`（type/status/owner/creator/primaryDate/totalAmount）+ `TravelApplication` 1:1 子表 + `TripSegment` | ✅ 混合列表為單表索引查詢（AC-67/91）；✅ 008/009 的報表 FK、版本關聯、作廢欄位只加在父表一處；✅ 子表保有 NOT NULL 型別安全；⚠️ 每次讀取詳情需一次 join；⚠️ 建立需寫兩表（同交易） |
| **(b) 單表多型**：一張 `Application` 含三類全部欄位（大量 nullable）+ `type` | ✅ 查詢與寫入最單純；❌ 006/007 上線後約 8~10 個 nullable 欄位，型別安全全失（差旅缺 `tripDate` 與保養缺 `tripDate` 在 DB 層無法區分）；❌ 快照欄位混雜；⚠️ 表寬且語意鬆散 |
| **(c) 三張完全獨立專表**（無父表） | ✅ 各類型最乾淨；❌ 混合列表需 3 表 UNION + 應用層合併分頁（違反 AC-91「不得應用層分頁」）；❌ 報表／版本關聯／作廢／稽核邏輯須三份；❌ 009 修正版關聯無法統一表達 |

**推薦：(a) 父子表。** 理由：與 `ARCHITECTURE.md` §3 既有的 `applications`（共通）vs `trips`（專屬）模組劃分**完全同構**，與 `DATA_FLOW.md` §1 概念模型一致；且唯一能讓 BE-US-29 的分頁在 DB 層正確完成的方案。

---

### D2 — 狀態集合與命名，以及 PHASE-009 欄位是否提前預留

**要決定什麼**：`ApplicationStatus` 的 enum 值集合、命名語言，以及作廢／版本關聯欄位是否在本 Phase 先建。

**為什麼要決定**：enum 值集合影響 migration 與 PHASE-005 能否寫出「未作廢」過濾條件；提前建立無用欄位則是技術債。

| 選項 | 影響 |
|---|---|
| **(a) 現在宣告 `DRAFT / COMPLETED / VOIDED`（英文），但 `VOIDED` 本 Phase 不可達；作廢欄位與版本關聯欄位不預留** | ✅ PHASE-005 的「僅計已完成且未作廢」條件立即可寫且可測；✅ 009 只需加欄位不需改 enum（避免 `ALTER TYPE` 與既有資料列的互動）；✅ 無無用欄位；⚠️ 需以測試明確證明 `VOIDED` 不可達（AC-58） |
| **(b) 現在只宣告 `DRAFT / COMPLETED`，009 再 `ALTER TYPE ADD VALUE VOIDED`** | ✅ 最小宣告；❌ PHASE-005 無法寫出「未作廢」條件（該 Phase PRD 已明列此過濾為其 AC）；⚠️ Postgres `ALTER TYPE ADD VALUE` 需獨立 migration（003a 已有前例，成本不高但仍是一次 schema 變更） |
| **(c) 宣告全狀態 + 同時預留 `voidReason`/`voidedAt`/`voidedById`/`supersedesId`/`supersededById`** | ✅ 009 幾乎零 migration；❌ 5 個永遠為 null 的欄位存在整個 004~008 期間，且無守門邏輯，屬未經驗證的表面；❌ 違反 YAGNI 且擴大本 Phase 審閱面 |

**推薦：(a)。** 命名採**英文 enum**（`DRAFT`/`COMPLETED`/`VOIDED`），與既有 `Role`/`AuditAction`/`AttachmentStatus` 全案慣例一致；zh-TW 顯示由前端對應（「草稿／已完成／已作廢」）。

---

### D3 — 快照的儲存形式與應包含欄位

**要決定什麼**：計算快照以結構化欄位或 JSON 欄位保存，以及具體包含哪些欄位。

**為什麼要決定**：BE-US-18 明文要求保存「單價、取整前金額、取整後金額」；快照是「歷史金額不變」（AD-US-11、AC-48）的唯一保證，且 PHASE-008 列印版與 PDF 直接讀它。形式一經落地即為不可變歷史資料。

| 選項 | 影響 |
|---|---|
| **(a) 全結構化欄位**：父表 `totalAmount Int`；子表 `fuelUnitPrice`/`etcUnitPrice Decimal(10,4)`、`fuel/etcParameterVersionId`、`snapshotTotalKm Decimal(12,2)`、`snapshotRawAmount Decimal(14,4)`、`calculatedAt`；段表 `snapshotFuelAmount`/`snapshotEtcAmount`/`snapshotRawAmount Decimal(14,4)`、`snapshotAmount Int` | ✅ DB 層型別與精度可驗證（Decimal 不會退化為字串）；✅ 參數版本 id 可建索引 → `parameterHasReferences`（AC-93）為索引查詢；✅ PHASE-005 可單表 `SUM(snapshotTotalKm)`；⚠️ 006/007 各自需再加自己的快照欄位（但在各自子表，不污染父表） |
| **(b) 單一 JSON 欄位** `Application.snapshot Json?` 三類共用 | ✅ 一個欄位涵蓋三類、schema 變更少；❌ Decimal 在 JSON 中只能是字串或 number，**number 會浮點失真**、字串則 DB 無法驗證精度；❌ 參數版本引用無法建索引（AC-93 退化為全表掃描）；❌ 快照內容的不變式無法由 DB 保證，只能靠測試 |
| **(c) 混合**：可查詢的關鍵值（`totalAmount`、參數版本 id、`snapshotTotalKm`）結構化，明細（各段金額）放 JSON | ✅ 折衷；❌ 各段取整前／後金額正是 BE-US-18 明文要求保存的項目，放入 JSON 等於把最需要精度保證的部分交給最弱的型別 |

**推薦：(a) 全結構化欄位。** 理由：BE-US-18 要求的「取整前金額」是金額精度的核心證據，必須由 `Decimal` 欄位承載；且 AC-93 的引用保護查詢與 PHASE-005 的統計都需要索引。

---

### D4 — 金額欄位型別與精度（**金額語意，必人類批准**）

**要決定什麼**：取整前金額、最終金額的欄位型別與小數位。

**為什麼要決定**：直接決定申報金額；且必須與 PHASE-003a 已批准之單價精度（`Decimal(10,4)`）銜接。

| 選項 | 影響 |
|---|---|
| **(a) 取整前金額 `Decimal(14,4)`、最終金額 `Int`** | ✅ 取整前金額保留 4 位小數，與單價精度同級，可完整重現「先相加再取整」的中間值；✅ 最終金額為新臺幣整數（CLAUDE.md 明文）；✅ 上限 10^10 元，遠超業務需求 |
| **(b) 取整前金額 `Decimal(14,2)`** | ⚠️ 單價 4 位 × 里程 2 位的乘積本身可達 6 位小數，截為 2 位會在「先相加再取整」前先失真，可能改變取整結果（如 `0.4999 + 0.4999 = 0.9998 → 1`，若各截為 `0.50 + 0.50 = 1.00 → 1` 巧合相同，但 `0.4949+0.4949=0.9898→1` vs `0.49+0.49=0.98→1`；存在邊界差異）；❌ 引入不必要的精度損失 |
| **(c) 取整前金額不持久化（只存最終整數）** | ✅ 欄位最少；❌ **違反 BE-US-18 明文**（「應保存…取整前金額及取整後金額」）；不可採 |

**推薦：(a)。** 取整前金額 `Decimal(14,4)`（段與整筆皆是），最終金額 `Int`（新臺幣整數）。取整一律 `Prisma.Decimal.ROUND_HALF_UP`（一般四捨五入，0.5 進位，**非銀行家取整**），**禁止任何浮點中介**（承 PHASE-003a AR-3a-1 之教訓：`Decimal` 建構一律傳字串，不傳已經過 `Number()` 的值）。

---

### D5 — 里程欄位型別與精度（**金額語意，必人類批准**）

**要決定什麼**：`totalKm` / `highwayKm` 的型別與允許小數位；超出位數時的行為。

**為什麼要決定**：里程是金額的乘數，精度直接影響申報金額；且「輸入 12.345 會怎樣」是使用者可見行為。

| 選項 | 影響 |
|---|---|
| **(a) `Decimal(10,2)`，超過 2 位小數 → 400 拒絕（不靜默取整）** | ✅ 涵蓋 Google Maps 常見的 1 位小數顯示並留餘裕；✅ 拒絕優於靜默改值（使用者不會在不知情下被改動申報基礎）；⚠️ 使用者貼上 3 位小數需自行修正 |
| **(b) `Decimal(10,2)`，超過 2 位小數 → 後端四捨五入後接受** | ✅ 輸入寬鬆；❌ 使用者送出的數字與落地的數字不同且無提示，違反「後端不得靜默改動申報基礎」的直覺；⚠️ 前端預覽與後端結果會出現無法解釋的差異 |
| **(c) `Decimal(10,1)`（1 位小數）** | ✅ 最貼近 Google Maps 顯示；⚠️ 若使用者手動加總或使用其他來源的 2 位小數里程則被迫捨去；❌ 彈性不足 |

**推薦：(a) `Decimal(10,2)` + 超位數拒絕。** 上限 99,999,999.99 公里為型別上限；**本 Phase 不設業務上限**（US 未定義；設上限屬新增使用者可見規則）。

---

### D6 — 預覽／草稿回應是否對一般使用者揭露「當日單價」（**金額語意 + 授權範圍，必人類批准**）

**要決定什麼**：`TravelComputedDto` 是否包含 `fuelUnitPrice` / `etcUnitPrice`。

**為什麼要決定**：PHASE-003a **D10 已批准「參數端點全 requireAdmin」**，一般使用者無法讀參數表。若預覽回應附單價，等於以另一條路徑對一般使用者揭露參數值——這是對已批准授權範圍的實質擴張，必須由人類決定，AI 不得自行放寬。（註：**已完成申請的快照單價**屬另一回事，見下方說明。）

| 選項 | 影響 |
|---|---|
| **(a) 預覽／草稿 `computed` **不含**單價，只回金額** | ✅ 完全維持 003a D10 的授權邊界；✅ FE-US-10 的四條 AC 只要求顯示「油資補助、ETC 補助、取整後金額、總額」，**未要求顯示單價** → 不縮減 AC；⚠️ 使用者看到金額但不知單價，若質疑金額需詢問管理員 |
| **(b) 預覽／草稿 `computed` **包含**單價** | ✅ 使用者可自行核對金額，透明度高；❌ 實質放寬 003a D10（一般使用者可經此端點得知任一日之油資／ETC 單價）；⚠️ 需人類明確承認此擴張 |
| **(c) 僅在**已完成**申請的 `snapshot` 中回傳單價，草稿預覽不回** | ✅ 折衷；理由：快照單價是「該筆申請自身的計算依據」，屬使用者自有資料，且 PHASE-008 列印版（FE-US-23「完整申請內容、計算明細」）幾乎必然要顯示；✅ 草稿階段維持 D10 邊界 |

**推薦：(c)。** 即：草稿預覽 `computed` **不含**單價（維持 003a D10）；已完成申請 `snapshot` **含**單價（來源為該筆申請自己的快照，非參數表查詢）。此推薦同時為 PHASE-008 列印版預先鋪路。**若人類選 (b)，須明確記錄「PHASE-003a D10 之授權範圍於 PHASE-004 擴張」以維持治理可追溯。**

---

### D7 — 「未完成項標示」的表達方式

**要決定什麼**：FE-US-07「標示尚未完成的項目」由誰判定。

**為什麼要決定**：牽涉「後端權威」原則；若前端自行判斷，可能與後端完成驗證不一致（使用者看到「已完整」卻被拒絕完成）。

| 選項 | 影響 |
|---|---|
| **(a) 後端回 `completionBlockers[]`（唯一權威），前端純顯示** | ✅ 與完成驗證**同一份純函式**，永不失準；✅ 可攜帶 `segmentId` 精確定位（FE-US-11「定位缺少附件的行程段」、FE-US-09「指出對應行程段」）；⚠️ 每次判定需一次請求（隨草稿儲存／讀取回傳，無額外往返） |
| **(b) 前端自行依欄位判斷** | ✅ 零延遲；❌ 規則雙寫，必然漂移（尤其「缺參數」須查 DB，前端無法判斷）；❌ 違反後端權威原則 |
| **(c) 後端權威 + 前端即時輔助提示（明示為輔助）** | ✅ 打字時即時回饋（如里程為 0 立即紅框），送出後以後端 `completionBlockers` 為準；⚠️ 兩份規則但**權威單一**，且前端規則僅限純格式性檢查（不含參數可用性） |

**推薦：(c)，權威為 (a)。** 後端 `completionBlockers` 為唯一權威並用於完成守門；前端僅做**純欄位級**即時提示（里程 ≤0、高速>總里程、必填空白），不得自行判斷「附件是否足夠」與「參數是否存在」。

---

### D8 — 金額預覽端點形狀

**要決定什麼**：獨立 preview 端點 vs 隨草稿讀取回傳 vs 兩者。

**為什麼要決定**：FE-US-10 要求「欄位數值變更即更新預覽」；若只能隨草稿儲存回傳，等於每次改一個數字就要寫一次 DB。

| 選項 | 影響 |
|---|---|
| **(a) 獨立 stateless `POST /applications/travel/preview`（不寫 DB）+ 草稿讀取/儲存也回同一份 `computed`** | ✅ 未儲存狀態亦可預覽（符合 FE-US-10「欄位數值變更」）；✅ 不寫 DB（AC-36）；✅ 與草稿回應共用同一計算路徑，兩處數值必然一致；⚠️ 需前端 debounce（建議 300ms）避免每鍵一請求 |
| **(b) 僅隨草稿讀取/儲存回傳** | ✅ 端點最少；❌ 未儲存的輸入無法預覽，使用者須先存草稿才看得到金額，與 FE-US-10 語意不符；❌ 產生大量無意義的 DB 寫入 |
| **(c) 前端本地計算預覽（需單價）** | ✅ 零延遲；❌ 需對一般使用者揭露單價（撞 D6/003a D10）；❌ 前端重複實作取整規則，易與後端不一致（雖 FE-US-10 允許差異並以後端為準，但主動製造差異不可取） |

**推薦：(a)。** 預覽端點掛 `requireAuth + requirePasswordChanged`，stateless、不寫 DB、不回傳他人資料；回應與草稿 `computed` 使用同一組計算函式。

---

### D9 — 列表歸屬日期（`primaryDate`）與預設「近一年」語意（**使用者可見行為，必人類批准**）

**要決定什麼**：(i) 綜合列表的排序／篩選日期來源；(ii) 草稿尚無出差日期時如何歸屬；(iii) 預設「近一年」是否設上界。

**為什麼要決定**：直接決定「使用者打開首頁看得到什麼」。若處理不當，剛建立的空白草稿或未來出差日的申請會憑空消失。

| 子項 | 選項 | 影響 |
|---|---|---|
| (i)+(ii) | **(a) 持久化 `primaryDate`（非空）＝ 出差日期；未填時暫以建立日期代之** | ✅ 排序與篩選皆為單欄索引；✅ 空白草稿必可見；✅ 已完成必有出差日期，故不污染 PHASE-005 統計（統計讀 `tripDate`）；⚠️ 需在每次 `PUT` 維護該欄位 |
| | (b) 直接以 `tripDate` 排序／篩選（可為 null） | ❌ 草稿無出差日期時 null 排序不確定；❌ 日期篩選會**排除**所有尚未填日期的草稿（使用者新建草稿後在列表找不到） |
| | (c) 以 `COALESCE(tripDate, createdAt)` 即時計算 | ✅ 無需維護欄位；❌ Prisma 不支援 `COALESCE` 排序，須 raw SQL（增加維護與注入面）；❌ 無法建立有效索引（AC-91） |
| (iii) | **(a) 預設 `dateFrom = 今日 − 1 年`（含當日），`dateTo` 不設上界** | ✅ 未來出差日的草稿仍可見；✅ 符合「最近一年資料」的實務期待 |
| | (b) 預設 `[今日 − 1 年, 今日]` | ⚠️ 出差日在未來的申請預設被藏起（US 未禁止未來出差日）；使用者需手動改篩選才看得到自己剛建的行程 |

**推薦：(i)(ii) = (a)、(iii) = (a)。** 即：持久化非空 `primaryDate`（出差日期，未填則為建立日期）；預設篩選為 `dateFrom = 今日−1年`、無上界；回應以 `appliedFilters` 明示實際套用值，使 AC-60 可被自動化驗證。

---

### D10 — 分頁形狀、上限與關鍵字比對範圍

**要決定什麼**：分頁機制、`pageSize` 預設與上限、非法值行為、關鍵字比對欄位。

**為什麼要決定**：BE-US-29 明文要求回「目前頁次、每頁筆數及總筆數」且「全部紀錄仍應限制單次回傳筆數」；上限值是使用者可見行為（一次最多看幾筆）。

| 子項 | 選項 | 影響 |
|---|---|---|
| 機制 | **(a) offset 分頁（`page`/`pageSize`/`total`）** | ✅ 直接對應 BE-US-29 字面要求；✅ 前端可顯示總頁數；⚠️ 深頁效能較差（本案資料量級無虞） |
| | (b) cursor 分頁 | ✅ 深頁效能佳；❌ 無法自然提供「目前頁次」與「總筆數」，與 BE-US-29 字面不符 |
| 上限 | **(a) `pageSize` 預設 20、上限 100；超過 → clamp** | ✅ 「仍應限制單次回傳筆數」即 clamp 語意；✅ 不因使用者傳大值而報錯 |
| | (b) 超過上限 → 400 | ⚠️ 對使用者較不友善，且非 US 要求 |
| 非法值 | **`page < 1` 或非整數 → 400；`pageSize <= 0` → 400** | ✅ 明確優於靜默修正（與 clamp 上限並存不矛盾：上限是保護系統，下限非法是輸入錯誤） |
| 關鍵字 | **(a) 本 Phase 僅比對 `TravelApplication.purpose`（不分大小寫、部分比對）；報表編號於 PHASE-008 擴充** | ✅ 忠於 FE-US-05（「出差目的或報表編號」），報表編號在本 Phase 尚不存在；✅ 不擴大 Scope |
| | (b) 額外比對行程段地點 | ❌ US 未要求，屬擴大使用者可見行為 |

**推薦：offset 分頁；`pageSize` 預設 20、上限 100（clamp）；`page<1`/`pageSize<=0` → 400；關鍵字僅比對出差目的。** 空白關鍵字視同未提供（AC-64）。**FE-US-05 的報表編號關鍵字須列入跨 Phase 追蹤（PHASE-008 閉環），本 Spec 不視為已完成。**

---

### D11 — 管理員代操作時的附件擁有權（**附件權限，必人類批准**）

**要決定什麼**：管理員代使用者上傳截圖時，附件的 `ownerId` 如何決定；以及附件與申請的擁有權關係是否強制一致。

**為什麼要決定**：**這是一個會導致實際功能缺陷的決策點。** PHASE-003 D3 已定案「`POST /attachments` 忽略 `ownerId`，owner = 上傳者」。若沿用不變，管理員代操作上傳的附件 `ownerId = 管理員`，而申請 `ownerId = 使用者`；日後**使用者本人查看自己申請中的截圖時，`assertOwnershipOrAdmin(user, attachment.ownerId=管理員)` 會回 403** ——使用者看不到自己申請裡的證明圖。必須在本 Phase 解決。

| 選項 | 影響 |
|---|---|
| **(a) `POST /attachments` 接受可選 `ownerId`（僅 ADMIN 可指定他人），`uploaderId` 恆為呼叫者；並於關聯時斷言 `attachment.ownerId === application.ownerId`** | ✅ 正是 PHASE-003 §5.1 D3 明文預留的路徑（「代操作留 PHASE-004」）；✅ 不破壞 PHASE-003「`ownerId` 一經建立不變」不變式；✅ 存取授權邏輯零改動；✅ 新增的擁有權一致性斷言反而**縮小**攻擊面（防跨擁有人混接）；⚠️ 需在 `POST /attachments` 增加一個受 `requireAdmin` 條件保護的參數 |
| (b) 擴充附件存取授權為「附件 owner **或所屬申請 owner** 或 ADMIN」 | ✅ 不需改上傳端點；❌ 修改 PHASE-003 已通過安全審查的授權判定（`access-service`），授權面**擴大**且需重跑完整權限矩陣；❌ 需多一次 join 才能判定授權（每次取檔） |
| (c) 於關聯時改寫 `attachment.ownerId` 為申請 owner | ✅ 最終狀態正確；❌ **違反 PHASE-003 §3.3 不變式「`ownerId` 一經建立不變（附件不轉手）」**；❌ 稽核上「誰擁有過這個檔案」變得可變 |

**推薦：(a)。** 具體：`POST /attachments` 之 `ownerId` 為可選；非 ADMIN 指定非自身值 → 403；ADMIN 可指定任一啟用使用者。**並新增不變式：附件關聯至行程段時，`attachment.ownerId` 必須等於該申請之 `ownerId`，否則 403（AC-30）。**

---

### D12 — 公開 `POST /attachments/:id/link` 端點的處置（**公開 contract 變更 + 安全，必人類批准**）

**要決定什麼**：PHASE-003 留下的公開 link 端點（client 可自帶 `refType`/`refId`/`limit`/`containerState`）在本 Phase 如何處置；以及 `AttachmentsDemoPage` 的去留。

**為什麼要決定**：這是 **AR-D 的核心風險**。現行端點允許 client 自行指定 `limit`（可傳 999 繞過 3 張上限）、`refId`（可關聯到任意行程段）、`containerState`（可宣稱 draft 以繞過完成鎖定）。PHASE-004 一旦有真實的完成鎖定資產，此端點即為實質授權漏洞。屬公開 contract 移除，須人類批准。

| 選項 | 影響 |
|---|---|
| **(a) 移除公開 `POST /attachments/:id/link` 端點；附件關聯僅能經差旅草稿儲存（`PUT`）；服務層 `linkAttachment()` 保留供內部呼叫。`DELETE /attachments/:id` 保留但 `containerState` 改由後端推導。`AttachmentsDemoPage` 一併移除或改為僅示範上傳/刪除** | ✅ 攻擊面最小、AR-D 徹底關閉；✅ `limit=3` 與 `containerState` 皆成為後端不可繞過之常數／推導值；⚠️ 移除公開端點與示範頁屬使用者可見變更（該頁為 PHASE-003 的驗收用最小宿主頁，非正式功能） |
| (b) 保留端點但全面加固：`refType/refId` 須經擁有權與容器狀態驗證、`limit` 改由後端依 `refType` 查表、`containerState` 由後端推導、client 參數一律忽略 | ✅ 不移除公開 contract；⚠️ 端點保留但所有參數都被忽略，實質已無用途，卻仍需維護一整套授權測試；⚠️ 未來新增申請類型時此端點是額外的迴歸面 |
| (c) 維持現狀（僅在申請服務層另走內部路徑） | ❌ **AR-D 未關閉**：使用者仍可用該端點繞過 3 張上限與完成鎖定；違反 PROJECT_STATE 明文之 PHASE-004 前置約束；不可採 |

**推薦：(a)。** 並要求 T11 附上**鑑別力測試**：`POST /attachments/:id/link` 回 404；`DELETE /attachments/:id?containerState=draft` 對已完成申請之附件仍回 403（證明 client 參數已無效）。`AttachmentsDemoPage` 建議改為僅保留「上傳 + 預覽 + 刪除」示範（維持 PHASE-003 AC-19/20/21 的回歸價值），移除 link 操作區。

---

### D13 — 「已完成拒改」的錯誤碼與提示文案（**使用者可見行為**）

**要決定什麼**：對已完成申請的寫入請求回 403 還是 409；以及提示文案。

| 選項 | 影響 |
|---|---|
| **(a) 403 `FORBIDDEN` + message「已完成的申請不可修改，請建立修正版」** | ✅ 與 PHASE-003 §4.8 已定案之「已完成不得刪除/替換附件回 403」同語意族，全案一致；✅ 前端可用單一分支處理；⚠️ 語意上「狀態不允許」用 403 略寬鬆 |
| (b) 409 `CONFLICT` | ✅ 狀態衝突語意較精準；❌ 與 PHASE-003 已落地行為不一致（同一使用者操作在附件層得 403、在申請層得 409） |
| (c) 新增專屬碼 `APPLICATION_COMPLETED_IMMUTABLE`(409) | ✅ 前端可精準切換 UI；❌ 錯誤碼族擴散；⚠️ 需同步改 PHASE-003 附件層才一致 |

**推薦：(a) 403 `FORBIDDEN`。** 文案於本 Phase 僅為**提示**（「請建立修正版」），功能於 PHASE-009 提供；前端須確保不出現無效的按鈕（避免使用者點了沒反應）。

---

### D14 — 完成失敗的錯誤碼形狀與文字欄位長度上限（**使用者可見行為**）

**要決定什麼**：(i) 完成驗證失敗回什麼碼、如何定位行程段；(ii) 出差目的／地點的長度上限。

| 子項 | 選項 | 影響 |
|---|---|---|
| (i) | **(a) 400 `VALIDATION_ERROR` + `fields[]`（路徑如 `segments[1].totalKm`）+ `details.blockers[]`（含 `segmentId`）** | ✅ 沿用既有協定不擴散碼義；✅ `segmentId` 在並發下比索引穩定，同時保留索引供顯示；✅ 直接對齊 NFR-US-16「前端應能識別對應欄位及錯誤原因」 |
| | (b) 新增 `APPLICATION_INCOMPLETE`(409) | ✅ 前端可切換到「完成前檢查清單」UI；❌ 碼義擴散；⚠️ 與 `completionBlockers`（200 回應內）重複表達同一概念 |
| (ii) | **(a) 出差目的 ≤ 500 字、地點 ≤ 200 字，超過 → 400** | ✅ 防禦無界輸入（DB 與列印版皆受益）；⚠️ 屬 US 未定義之新增規則，故列入本決策點請人類確認數值 |
| | (b) 不設上限 | ⚠️ 無界字串進入 DB 與 PHASE-008 列印版，版面與效能不可控 |

**推薦：(i)=(a)、(ii)=(a)（目的 500 / 地點 200）。** 上限值請人類確認；若人類另指定數值，僅需改常數與測試。

---

### D15 — 多段行程的儲存語意、排序持久化與刪段序號重整

**要決定什麼**：草稿儲存採整份替換或細粒度 REST；排序如何持久化；刪段後 `sortOrder` 是否重整。

**為什麼要決定**：這同時決定了 FE-US-08 的三條 AC（新增／排序保留／刪段連帶附件），以及「新段在儲存前沒有 id，附件如何關聯」這個雞生蛋問題。

| 選項 | 影響 |
|---|---|
| **(a) 整份 `PUT`（segments 陣列，以 `id` 對齊 diff），`sortOrder` 依陣列索引重寫為 `0..n-1`；每段以 `attachmentIds[]` 表達附件** | ✅ 排序、新增、刪除、重整四件事由單一語意涵蓋；✅ 前端先上傳取得 `attachmentId`（TEMP）即可，**無需先有 segment id**，解決雞生蛋問題；✅ 與「儲存草稿」按鈕（FE-US-07）與「離開頁面提示未儲存」（FE-US-07 AC4）的前端狀態模型一致；✅ 單一交易，刪段 detach 與附件對帳原子完成；⚠️ 每次儲存需重寫全部段落的 `sortOrder`（段數量級小，成本可忽略） |
| (b) 細粒度 REST：`POST /segments`、`PATCH /segments/:sid`、`DELETE /segments/:sid`、`PUT /segments/order` | ✅ 每次操作粒度小；❌ 新段必須先 `POST` 取得 id 才能上傳關聯附件 → 「未儲存即離開」會留下孤兒段落；❌ 排序需額外端點；❌ 一次表單儲存變成 N 次請求，原子性難保證 |
| (c) 依 `createdAt` 排序，不存 `sortOrder` | ❌ 無法滿足 FE-US-08「調整順序並儲存後再次開啟應保留該順序」（除非刪除重建，破壞附件關聯）；不可採 |
| 刪段序號 | **重整為連續 `0..n-1`**（隨整份儲存自然達成）vs 留洞 | 重整使「第 N 段」顯示與 `sortOrder` 一致，利於錯誤定位訊息；留洞則需前端另行計算顯示序號 |

**推薦：(a) 整份 `PUT` + `sortOrder` 依索引重寫（刪段後連續，無洞）。** 不對 `(travelApplicationId, sortOrder)` 加 DB 唯一鍵——重排過程中會短暫出現重複值，唯一鍵會導致需要兩階段更新；連續性由服務層保證並以測試驗證（§7.3 不變式 4）。

---

### D16 — 刪段時未鎖定附件的處置

**要決定什麼**：刪除行程段時，其 `LINKED` 附件是解除關聯還是實體刪除。

**為什麼要決定**：FE-US-08 明文「該行程段及其**尚未正式鎖定的附件關聯**應移除」；「移除關聯」與「刪除檔案」是兩件事。

| 選項 | 影響 |
|---|---|
| **(a) 沿用 PHASE-003 `detach` 語意：`LINKED → TEMP`，清空 `refType`/`refId`/`linkedAt`，`createdAt` 重置為 TTL 基準；檔案保留，24h 後由 PHASE-011 清理** | ✅ 與 US 字面「移除**關聯**」一致；✅ 使用者誤刪段落後 24h 內檔案仍在（雖 UI 不再顯示）；✅ 完全複用 PHASE-003 已審查通過之實作；⚠️ 短期佔用 volume（開發期合成資料可接受） |
| (b) 立即實體刪除 DB 記錄 + storage 檔案 | ✅ 不佔空間；❌ 不可復原；❌ 需在申請交易內做 storage IO（storage 失敗與 DB 交易無法同時原子，易產生孤兒檔或誤刪） |
| (c) 保留 `LINKED` 但標記 soft-deleted | ❌ 引入新狀態，與 PHASE-003 已定案之兩態模型衝突；不可採 |

**推薦：(a)。** 直接呼叫 PHASE-003 `lifecycle-service` 之 detach 路徑（於申請交易內執行 DB 部分，不做 storage IO）。

---

### D17 — 管理員是否可代使用者「完成」申請（**Scope，必人類批准**）

**要決定什麼**：管理員在代操作情境下，能否對他人申請執行「完成」（不可逆狀態轉換）。

**為什麼要決定**：`userstory.md` 對管理員的能力列舉為：查看所有使用者、帳號管理、重設密碼、**查看所有人紀錄、替使用者建立或修改草稿、替已完成紀錄建立修正版、作廢所有使用者的已完成紀錄、維護參數、查看稽核**——**未列「代使用者完成申請」**（AD-US-07/08 明確只到「草稿」）。開放或不開放都會偏離字面，需人類定案。

| 選項 | 影響 |
|---|---|
| **(a) 本 Phase 不提供代完成**：管理員可代建立／代修改草稿，完成由使用者本人執行 | ✅ 忠於 US 字面（AD-US-07/08 僅涉草稿）；✅ 不可逆操作維持由資料擁有人本人執行，責任歸屬清楚；⚠️ 若使用者長期不上線，管理員協助輸入的草稿無法結案 |
| (b) 開放代完成 | ✅ 管理員可完整代辦；❌ 擴大 Scope（新增 US 未描述之管理員能力）；⚠️ 需新增 AC 與稽核 action `APPLICATION_COMPLETED_ON_BEHALF`，且不可逆操作由非擁有人執行需明確稽核 |
| (c) 開放但需額外確認（如二次確認 + 必填理由） | ⚠️ 更複雜且 US 完全未描述；不建議在 MVP 引入 |

**推薦：(a) 本 Phase 不提供代完成。** 若人類選 (b)，本 Spec 需增補：AC「管理員代完成 → 狀態轉換成功、`completedAt` 記錄、稽核 action `APPLICATION_COMPLETED_ON_BEHALF` 含擁有人與操作者」，並將 T8/T12 的 Done When 一併擴充。

---

### D18 — 是否將 PHASE-004 拆為 004a / 004b（**Phase 結構變更，必人類批准**）

**要決定什麼**：15 個 Task（其中 11 個 High）是否拆成兩個 sub-phase 各自走 Gate。

**為什麼要決定**：PRD §5 目前將 PHASE-004 定義為單一 Phase；拆分屬 Phase 結構變更，需人類批准並由大總管同步 PRD。

| 選項 | 影響 |
|---|---|
| **(a) 拆為 004a（後端核心：T1~T8, T11, T15）+ 004b（查詢／代操作／稽核／前端：T9, T10, T12, T13, T14）** | ✅ 單次 Gate 的審閱面從 15 Task／11 High 降為 10 + 5；✅ 金額語意（D4/D5/D6）與快照可在 004a 提早落地驗證，前端不必等；✅ 依賴方向單向（004b 幾乎不會反向改動 004a 的資料模型），切點乾淨；✅ PR 較小 → reviewer 品質較高（003a 經驗）；✅ 回滾單位縮小；⚠️ 004a 結束時**沒有 UI**，人類「實際操作」只能以 compose + API smoke 驗收（PRD 允許純後端 Phase 只觸發整合 Gate，且 003a 已有 compose smoke 前例）；⚠️ 需人類批准並更新 PRD §5 與依賴圖 |
| (b) 維持單一 PHASE-004 | ✅ 與 PRD 現狀一致，無需改規劃文件；✅ Phase 結束即有完整可操作的垂直切片（最符合 PRD 的垂直切片原則）；❌ 單次事前批准 Gate 需一次審完 15 Task／11 High／18 個 D-item；❌ 單一 PR 過大，reviewer 與整合驗收風險集中；❌ 若中途發現金額語意需調整，已完成的前端須連帶返工 |
| (c) 拆為三段（模型/計算/前端） | ❌ 切點會落在「無法獨立驗收」的位置（例如只有模型沒有端點），違反垂直切片原則 |

**推薦：(a) 拆為 004a / 004b。** 主要理由是**風險集中度**：本 Phase 的 High Task 數（11）超過既往任一 Phase（002 為 9、003 為 3、003a 為 4），且同時包含金額語意、資料模型、授權隔離、附件權限、不可逆完成五類高風險決策；一次性 Gate 的人類審閱負擔與失敗回滾成本都偏高。若人類偏好維持 PRD 原結構（選 (b)），本 Spec 內容完全適用，僅需將 §15 之 sub-phase 分組視為「Gate 內的階段性驗收檢查點」。

---

## 17. Spec 修訂紀錄

| 日期 | 版本 | 變更 | 依據 |
|---|---|---|---|
| 2026-08-02 | DRAFT 建立 | 依 SPEC-004 Packet 建立 PHASE-004 完整 Spec（§1~§16：93 條 AC、正常流程、五態、32 項邊界、權限與敏感資料、API contract、資料模型與 migration、Data Flow、NFR、測試策略、Rollback、Architecture/Data Flow 影響、已知限制、15 Task 之 Task Graph、決策點 D1~D18） | PRD §5 PHASE-004（311–337 行）；`userstory.md` FE-US-04/05/07~12/21/27、AD-US-06/07/08、BE-US-02/03/05/06/07/08/09/18/20/24/25/29、NFR-US-10/14/16；PHASE-001 錯誤協定；PHASE-002 授權中介與稽核慣例；PHASE-003 附件生命週期與 Review AR-D 前置約束；PHASE-003a Decimal 語意 D3/D8、`findEffectiveVersion`、錯誤碼 D5、稽核 D6；`ARCHITECTURE.md` §3/§4.1~4.6；`DATA_FLOW.md` §1/§2.2/§2.3/§2.8；`PROJECT_STATE.md` 前置約束與測試隔離紀律 |
| 2026-08-02 | **DRAFT → ACTIVE** | Gate 通過；D1~D18 全數定案（見 §17.1）。D1~D17 依 spec-writer 建議定案；**D18 改採 (b) 維持單一 PHASE-004**，並將 §15 之 004a/004b 分組改作「Phase 內階段性獨立 Review 檢查點」。無 AC 增刪、無 US 原意變更。 | **使用者 leonchih 於 2026-08-02 明示授權：「spec 寫好後直接進入實作，這次的 session 的 spec 不用 approval」**——由大總管代行 Gate 裁定並完整記錄理由，供使用者事後複核。合併進 main 仍保留為人類批准事項（不可逆，未代決）。 |

### 17.1 Gate 定案表（2026-08-02）

> 授權來源：使用者 leonchih 2026-08-02 明示「本 session 之 Spec 不需 approval，直接進入實作」。大總管依此代行裁定；每項附裁定理由，使用者可事後逐項複核並要求修訂（走 Gate 反饋流程：先 Spec 修訂 → implementer TDD → reviewer 複審 → 合入）。

| D | 定案 | 裁定理由 |
|---|---|---|
| **D1** 資料表結構 | **(a) 父子表**：`Application` + `TravelApplication` 1:1 + `TripSegment` | 唯一能讓 BE-US-29 分頁在 DB 層完成的方案（AC-91 禁止應用層分頁）；與 `ARCHITECTURE.md` §3 既有 `applications`/`trips` 模組劃分同構；006/007/008/009 的擴充只需加在父表一處。 |
| **D2** 狀態集合 | **(a)** 宣告 `DRAFT`/`COMPLETED`/`VOIDED`（英文），`VOIDED` 本 Phase 不可達；**不**預留 009 之作廢／版本關聯欄位 | PHASE-005 的「僅計已完成且未作廢」過濾條件需 `VOIDED` 值存在才寫得出且可測；預留 5 個永遠為 null 的欄位違反 YAGNI 且擴大審閱面。命名沿用全案英文 enum 慣例（`Role`/`AuditAction`/`AttachmentStatus`）。 |
| **D3** 快照形式 | **(a) 全結構化欄位**（父表 `totalAmount Int`；子表單價／版本 id／`snapshotTotalKm`／`snapshotRawAmount`／`calculatedAt`；段表四欄） | BE-US-18 明文要求保存「取整前金額」——精度核心證據必須由 `Decimal` 欄位承載，JSON 之 number 會浮點失真、字串則 DB 無法驗證精度；AC-93 引用保護與 PHASE-005 統計皆需索引。 |
| **D4** 金額型別（金額語意） | **(a)** 取整前金額 `Decimal(14,4)`（段與整筆）、最終金額 `Int`；`ROUND_HALF_UP`，**禁浮點中介**，`Decimal` 建構一律傳字串 | 與 003a 已批准之單價 `Decimal(10,4)` 同級，可完整重現「先相加再取整」的中間值；最終金額為新臺幣整數（CLAUDE.md 明文）。`Decimal` 傳字串為 003a AR-3a-1 教訓之固化。 |
| **D5** 里程型別（金額語意） | **(a)** `Decimal(10,2)`；**超過 2 位小數 → 400 拒絕，不靜默取整**；本 Phase 不設業務上限 | 里程是金額的乘數；後端靜默改動申報基礎會使使用者在不知情下被改數字，且製造前端預覽與後端結果的無法解釋差異。設業務里程上限屬新增使用者可見規則，US 未定義故不新增。 |
| **D6** 是否揭露當日單價（金額語意＋授權範圍） | **(c)** 草稿／預覽 `computed` **不含**單價；**已完成**申請 `snapshot` **含**單價 | 003a D10 已批准「參數端點全 requireAdmin」；若草稿預覽附單價等於以另一路徑對一般使用者揭露參數表，屬對已批准授權範圍的實質擴張，**不由 AI 代為放寬**。FE-US-10 四條 AC 只要求顯示油資／ETC／取整後金額／總額，未要求單價 → 選 (c) 不縮減任何 AC。已完成快照單價屬該筆申請自身的計算依據（使用者自有資料），且為 PHASE-008 列印版鋪路。 |
| **D7** 未完成項標示 | **(c)，權威為 (a)**：後端 `completionBlockers` 唯一權威；前端僅做純欄位級即時提示，**不得**自行判斷附件是否足夠、參數是否存在 | 與完成守門共用同一份純函式，永不失準；`segmentId` 可精確定位（FE-US-09/11 明文要求指出對應行程段）。 |
| **D8** 預覽端點 | **(a)** 獨立 stateless `POST /applications/travel/preview`（不寫 DB）+ 草稿讀取／儲存回傳同一份 `computed`（同一組計算函式） | FE-US-10 要求「欄位數值變更即更新預覽」；僅隨草稿儲存回傳等於每改一個數字就寫一次 DB，且未儲存的輸入無法預覽。前端 debounce 300ms。 |
| **D9** `primaryDate` 與近一年（使用者可見行為） | **(i)(ii)=(a)** 持久化非空 `primaryDate`＝出差日期，未填則建立日期；**(iii)=(a)** 預設 `dateFrom=今日−1年`（含當日）、**不設上界**；`appliedFilters` 明示實際套用值 | 避免「新建空白草稿在列表消失」與「未來出差日的申請被預設藏起」兩種使用者可見故障；單欄索引可用（AC-91）。統計權威仍為 `tripDate`（PHASE-005），已完成必有 `tripDate`，不污染統計。 |
| **D10** 分頁與關鍵字 | offset 分頁（`page`/`pageSize`/`total`）；`pageSize` 預設 **20**、上限 **100**（超過 clamp）；`page<1` 或非整數 → 400、`pageSize<=0` → 400；關鍵字**僅比對出差目的**（不分大小寫、部分比對），空白視同未提供 | BE-US-29 字面要求「目前頁次、每頁筆數及總筆數」→ cursor 分頁無法自然提供；「全部紀錄仍應限制單次回傳筆數」即 clamp 語意。報表編號關鍵字於 PHASE-008 閉環，**列為跨 Phase 追蹤，本 Phase 不視為已完成**。 |
| **D11** 代操作附件擁有權（附件權限） | **(a)** `POST /attachments` 新增可選 `ownerId`（僅 ADMIN 可指定他人，一般使用者指定他人 → 403）；`uploaderId` 恆為呼叫者；**新增不變式：關聯時 `attachment.ownerId` 必須等於申請 `ownerId`，否則 403** | 這是**修正一個真實功能缺陷**：沿用 003 D3 不變的話，管理員代上傳的截圖 owner=管理員，使用者本人日後看自己申請裡的證明圖會得到 403。選 (a) 正是 PHASE-003 §5.1 D3 明文預留的「代操作留 PHASE-004」路徑，不破壞「`ownerId` 一經建立不變」不變式，且新增的一致性斷言**縮小**攻擊面。(b) 會擴大已通過安全審查的授權判定面，(c) 直接違反 003 不變式。 |
| **D12** 公開 link 端點（公開 contract＋安全） | **(a) 移除 `POST /attachments/:id/link`**；附件關聯僅能經差旅草稿 `PUT`；服務層 `linkAttachment()` 保留供內部呼叫；`DELETE /attachments/:id` 之 `containerState` 改由後端推導；`AttachmentsDemoPage` 保留「上傳＋預覽＋刪除」示範、移除 link 操作區 | **AR-D 閉環為 PROJECT_STATE 明文之 PHASE-004 前置約束**。現行端點允許 client 自帶 `limit=999` 繞過 3 張上限、自帶 `containerState=draft` 繞過完成鎖定——PHASE-004 一旦有真實完成鎖定資產即為實質授權漏洞。(b) 端點保留但所有參數被忽略，實質無用途卻仍是迴歸面；(c) 不可採。T11 須附鑑別力測試證明 client 參數已無效。Demo 頁保留上傳／預覽／刪除以維持 PHASE-003 AC-19/20/21 的回歸價值。 |
| **D13** 已完成拒改錯誤碼 | **(a) 403 `FORBIDDEN`** + zh-TW message「已完成的申請不可修改，請建立修正版」；前端不得出現無效按鈕 | 與 PHASE-003 §4.8「已完成不得刪除／替換附件回 403」同語意族，避免同一使用者操作在附件層得 403、申請層得 409 的不一致。 |
| **D14** 完成失敗形狀與長度上限（使用者可見行為） | **(i)(a)** 400 `VALIDATION_ERROR` + `fields[]` + `details.blockers[]`（含 `segmentId`）；**(ii)(a)** 出差目的 ≤ **500** 字、地點 ≤ **200** 字，超過 → 400 | (i) 沿用既有協定不擴散碼義，`segmentId` 在並發下比索引穩定，直接對齊 NFR-US-16。(ii) 屬 US 未定義之新增防禦性規則——無界字串會進入 DB 與 PHASE-008 列印版，版面與效能不可控；**此二數值為大總管代定，明確標示供使用者事後調整（僅需改常數與測試）**。 |
| **D15** 儲存語意與排序 | **(a)** 整份 `PUT` + 以 `id` 對齊 diff；`sortOrder` 依陣列索引重寫為 `0..n-1`（刪段後連續無洞）；每段以 `attachmentIds[]` 表達附件；**不**加 `(travelApplicationId, sortOrder)` DB 唯一鍵 | 解決「新段在儲存前無 id、附件如何關聯」的雞生蛋問題（前端先上傳取得 TEMP `attachmentId` 即可）；排序／新增／刪除／重整由單一語意涵蓋且單一交易原子完成。不加唯一鍵是因重排過程會短暫出現重複值，會逼出兩階段更新；連續性由服務層保證並以測試驗證（§7.3 不變式 4）。 |
| **D16** 刪段附件處置 | **(a)** 沿用 PHASE-003 `detach` 語意（`LINKED→TEMP`、清 `refType`/`refId`/`linkedAt`、`createdAt` 重置為 TTL 基準）；檔案保留待 PHASE-011 清理；申請交易內只做 DB 部分，**不做 storage IO** | FE-US-08 字面為「移除**關聯**」而非刪檔；完全複用 003 已審查通過之實作；在申請交易內做 storage IO 無法與 DB 交易同時原子，易產生孤兒檔或誤刪。 |
| **D17** 管理員能否代完成（Scope） | **(a) 本 Phase 不提供代完成**；管理員可代建立／代修改草稿，完成由使用者本人執行 | `userstory.md` 對管理員能力的列舉止於「替使用者建立或修改**草稿**」（AD-US-07/08），未列代完成。開放屬擴大 Scope；**AI 不得自行擴大 US 未描述的管理員能力**，尤其是不可逆操作。若使用者日後需要，走 Gate 反饋流程增補 AC 與 `APPLICATION_COMPLETED_ON_BEHALF` 稽核。 |
| **D18** 是否拆 004a/004b（Phase 結構） | **(b) 維持單一 PHASE-004**（**此項未採 spec-writer 建議**）；改以 §15 之分組作為 **Phase 內階段性獨立 Review 檢查點**：T1~T8/T11/T15 後段核心完成即先跑一次 reviewer，再進 T9/T10/T12/T13/T14 與 Phase 終審 | 拆 Phase 屬規劃結構變更，需同步改 `docs/PRD.md` §5 與依賴圖——**PRD 不在大總管寫入白名單內**，代行拆分需額外派 spec-writer 改 PRD，且會產生兩個 PR＝兩次人類合併批准，對睡眠中的使用者反而增加負擔。spec-writer 提出的核心效益是「降低 reviewer 一次審閱面、提早發現金額語意問題」——這個效益以**期中 reviewer 檢查點**即可取得，無須變更 Phase 結構。D18 選項 (b) 原文亦明載此作法適用。維持單一 Phase 亦更符合 PRD「垂直切片」原則（Phase 結束即有完整可操作切片）。 |

**Gate 結論**：無 AC 增刪、無 US 原意變更、無 Scope 擴大、不新增任何 npm 依賴。D14(ii) 之長度數值與 D18 之 Phase 結構為大總管代定項，已標示供使用者事後複核。

> 狀態轉移：DRAFT →（Gate 2026-08-02，使用者授權大總管代行裁定 D1~D18）→ **ACTIVE** → 實作（TDD）→ COMPLETED。
>
> 補充（治理 2026-08-01.2）：本 Spec 屬 High 風險文件，定義 High 風險行為（授權／資料隔離／附件權限／不可逆完成／計算快照／金額語意）。轉 ACTIVE 後人類提出之任何變更（無論多小），須先完成本 Spec 修訂（引用該批准與日期）後方可實作。**合併進 main 仍為人類批准事項，未在本次授權範圍內。**
