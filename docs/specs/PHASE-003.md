# PHASE-003 — 附件基礎（storage 抽象、上傳、驗證、生命週期、授權存取）

- Governance-Version: 2026-08-01.2
- 狀態：ACTIVE（人類事前批准 2026-08-01：D1~D8 全數照建議定案；D5＝自寫格式偵測＋sharp 縮圖，build 不可行時回退前端縮放並記 Accepted Risk）
- Task ID（產出本 Spec）：SPEC-003
- 更新日期：2026-08-01
- Base Commit：294386c（branch: phase-003）
- 上游事實來源：`userstory.md`（不得改變原意）→ `docs/PRD.md` 第 5 節 PHASE-003 段落 → `docs/ARCHITECTURE.md`、`docs/DATA_FLOW.md`
- 依賴：PHASE-001（骨架/CI、`AppError`／統一錯誤格式、`sanitizeForLog`、pino redact）、PHASE-002（認證/授權中介層 `requireAuth`／`requirePasswordChanged`／`requireAdmin`／`assertOwnershipOrAdmin`、Cookie Session、`AuditLog` 結構、稽核寫入慣例）均已 DONE 併入 main。
- Risk Level：**High**（附件授權存取、生命週期/引用保護）。本 Spec DRAFT 完成後需人類事前批准（見第 12 節決策點）才可轉 ACTIVE 並實作。

> 本文件為 PHASE-003 的實作定案層。描述 API 形狀、概念資料模型與 migration 意圖、Data Flow 與測試策略，供 implementer 依 TDD 落地。實際 Prisma 欄位型別/索引微調、套件精確版本屬實作細節，於 Task 內定案並記錄。

---

## 1. 目標與非目標

### 1.1 目標

建立**與申請類型無關**的附件通用能力，作為後續差旅（PHASE-004）、保養（PHASE-006）、折舊（PHASE-007）三類申請共用的基礎設施：

1. **storage 抽象層 + env 持久化 volume**：附件位元組不落在應用容器內，透過抽象介面存取，未來替換儲存後端只改設定不改業務邏輯（NFR-US-07、假設 A2，無 S3）。
2. **上傳與驗證**：接受 JPEG/PNG/WebP，以**實際檔案內容**（magic bytes）判定格式（防偽副檔名），單檔 ≤ 10 MB，其餘格式（含 PDF）拒絕（BE-US-23）。
3. **附件數量限制引擎**：可配置各類申請/項目的附件數量上限的**引擎**（BE-US-24）。本 Phase 提供引擎與可注入上限；具體上限值（差旅 3/段、保養 5、折舊 5）之**正式套用與完成鎖定**歸 PHASE-004/006/007。
4. **授權存取端點**：任何附件內容（原圖與縮圖）之取得須先通過擁有權/角色驗證；未登入或非擁有者不得取得（NFR-US-10、BE-US-02）。
5. **生命週期核心**：暫存（temp）→ 關聯草稿（linked）→ 草稿刪除解除關聯 → 引用保護；並定義「完成鎖定（locked）」與「暫存清理」的判定規則（清理排程本身歸 PHASE-011）。（BE-US-25）
6. **預覽縮圖**：上傳後回傳可預覽的縮圖（FE-US-21 上傳結果與預覽）。
7. **最小前端上傳/預覽/刪除元件 + 最小宿主頁**：供整合 Gate 端到端驗收（差旅情境正式驗收於 PHASE-004）。

### 1.2 非目標（Out of Scope，明確排除）

- **各申請類型附件上限「套用」與「完成時鎖定」的正式落地**：於 PHASE-004（差旅 3/段）、PHASE-006（保養 5）、PHASE-007（折舊 5）。本 Phase 只提供限制引擎與生命週期 API，並定義 locked 狀態語意，不接上任何真實申請完成流程。
- **24 小時暫存清理「排程」**：清理判定規則（哪些可刪/不可刪）在本 Phase 定義並可由函式驗證；實際定時排程與維運落地歸 PHASE-011（BE-US-25 末兩條 AC 的排程執行）。
- **PHASE-003a 補助參數維護**：獨立 Phase，另出 Spec。
- **PDF 附件上傳**：`userstory.md` 第七節明列不在 MVP；本 Phase 僅接受 JPEG/PNG/WebP 影像。
- **報表正式 PDF 的儲存**：正式 PDF 也走持久化 volume，但其產生/保存於 PHASE-008。本 Phase 的 storage 抽象層設計須不排斥後續 PDF 複用，但不實作 PDF 相關端點。
- **真實申請實體（TravelApplication 等）**：本 Phase 不建立任何申請資料表；生命週期以「引用來源」抽象表達，具體外鍵於各申請 Phase 補上（見 3.2 設計說明）。

---

## 2. 可測試 Acceptance Criteria

AC 以 Given/When/Then 表述，逐條可測，並標註對應 US 與主要 Task。錯誤碼見第 4.8 節。

### 上傳與格式/大小驗證（BE-US-23、FE-US-11 部分）

**AC-01 接受合法影像（真實內容有效）**
- Given 已登入使用者上傳一張實際內容為 JPEG／PNG／WebP 的圖片，且 ≤ 10 MB。
- When 呼叫上傳端點。
- Then 系統接受，建立 Attachment（狀態 `TEMP`），回傳附件識別、格式、大小與**預覽縮圖存取路徑**。

**AC-02 拒絕偽裝副檔名（防偽副檔名，核心安全）**
- Given 使用者上傳一個副檔名為 `.jpg`／`.png`／`.webp`、但**實際位元組內容**為非支援格式（例：實為 PDF、GIF、可執行檔、純文字改名）。
- When 系統以 magic bytes 檢測實際格式。
- Then 系統**拒絕**，回 `UNSUPPORTED_MEDIA_TYPE`；不建立任何 Attachment；不將檔案寫入 volume（或寫入後即刪，見 4.4）。

**AC-03 拒絕未支援格式**
- Given 使用者上傳 PDF、GIF、BMP、SVG、TIFF 或其他非 JPEG/PNG/WebP 之檔案（即使副檔名誠實）。
- When 系統驗證。
- Then 拒絕，回 `UNSUPPORTED_MEDIA_TYPE`。

**AC-04 拒絕超過大小上限**
- Given 使用者上傳單一檔案 > 10 MB（門檻由 env `ATTACHMENT_MAX_BYTES` 提供，預設 10 MiB）。
- When 上傳。
- Then 拒絕，回 `PAYLOAD_TOO_LARGE`；不建立 Attachment。串流上傳於超過門檻時即中止，不將完整檔案讀入記憶體（見 4.3）。

**AC-05 拒絕空檔或零位元組**
- Given 使用者上傳 0 byte 或無有效影像標頭的檔案。
- When 驗證。
- Then 拒絕，回 `UNSUPPORTED_MEDIA_TYPE`（無法辨識為支援影像）。

### 授權存取（NFR-US-10、BE-US-02）

**AC-06 擁有者可取自己的附件內容**
- Given 一般使用者請求**自己上傳/擁有**的附件（原圖或縮圖）。
- When 授權驗證通過（`assertOwnershipOrAdmin`，見 4.6）。
- Then 系統由 storage 抽象層回傳檔案位元組，帶正確 `Content-Type`。

**AC-07 拒絕他人附件**
- Given 一般使用者請求**他人**擁有的附件內容，或在請求中自帶他人識別值。
- When 授權驗證。
- Then 拒絕，回 `FORBIDDEN`（或 `NOT_FOUND`，見 D6 決策）；**不得回傳任何檔案位元組**。

**AC-08 拒絕未登入者**
- Given 未登入者（無有效 session）取得了某附件的存取路徑並直接請求。
- When 存取附件端點。
- Then 拒絕，回 `UNAUTHORIZED`；不得回傳檔案內容。

**AC-09 管理員可取任一附件**
- Given 管理員請求任一使用者的附件內容。
- When 授權驗證（role=ADMIN）。
- Then 系統回傳檔案（管理員代操作/檢視需要，對齊 AD-US-06；管理員存取寫稽核見 4.7 註）。

### 數量限制引擎（BE-US-24）

**AC-10 達上限拒絕新增**
- Given 某引用容器（申請/項目）已關聯達其**設定上限**張附件（上限由呼叫端提供，本 Phase 以可注入值測試；差旅=3、保養/折舊=5 由後續 Phase 套用）。
- When 嘗試將第 N+1 張附件關聯至該容器。
- Then 引擎拒絕，回 `TOO_MANY_ATTACHMENTS`；關聯不成立。

**AC-11 未達上限允許**
- Given 容器目前關聯數 < 上限。
- When 關聯新附件。
- Then 允許，關聯數 +1。

**AC-12 引擎為純判定、上限可配置**
- Given 呼叫端傳入不同上限值（3 或 5）與現有關聯數。
- When 呼叫限制引擎判定函式。
- Then 回傳一致的允許/拒絕結果，不依賴特定申請類型硬編碼（可單元測試多組上限）。

### 生命週期（BE-US-25、FE-US-21）

**AC-13 上傳後標示暫存**
- Given 使用者上傳合法附件但尚未關聯任何申請。
- When 上傳完成。
- Then 附件狀態為 `TEMP`，記錄上傳者與上傳時間；尚無所屬申請/項目。

**AC-14 關聯至草稿**
- Given 一個 `TEMP` 附件與一個草稿容器（由呼叫端提供 owner 與容器識別）。
- When 執行關聯（且未超過數量上限、且容器擁有人=附件上傳者或管理員代操作）。
- Then 附件狀態轉為 `LINKED`，記錄所屬申請與項目（引用來源）；重新載入草稿時該附件可見。

**AC-15 草稿刪除附件解除關聯**
- Given 一個 `LINKED` 附件所屬容器仍為草稿狀態。
- When 合法使用者（擁有人或管理員）刪除該附件。
- Then 解除關聯（狀態轉回 `TEMP` 或標記為 detached，見 4.5）；重新載入草稿不再顯示該附件。

**AC-16 已完成申請不得刪除/替換附件**
- Given 一個附件所屬容器已標記為完成（`locked`；本 Phase 以可注入的容器狀態測試，真實完成流程於 PHASE-004+）。
- When 收到刪除或替換該附件的請求。
- Then 拒絕，回 `FORBIDDEN`（或 `CONFLICT`，見 4.8）；附件與關聯不變。

**AC-17 引用保護（清理判定）**
- Given 附件被草稿、已完成申請、報表或稽核資料任一引用。
- When 執行清理判定（`isEligibleForCleanup(attachment, now)`）。
- Then 判定為**不可清理**。

**AC-18 暫存逾時可清理判定**
- Given 附件為 `TEMP`、上傳超過 24 小時（門檻由 env `ATTACHMENT_TEMP_TTL_HOURS` 提供，預設 24）、且無任何引用。
- When 執行清理判定。
- Then 判定為**可清理**（實際刪除排程於 PHASE-011；本 Phase 只需判定函式正確）。

### 前端（FE-US-11 上傳結果/預覽、FE-US-21 草稿附件管理，差旅情境正式驗收於 PHASE-004）

**AC-19 上傳成功顯示預覽縮圖**
- Given 使用者於最小宿主頁選擇合法圖片。
- When 上傳成功。
- Then 顯示上傳結果與**預覽縮圖**。

**AC-20 前端拒絕回饋**
- Given 使用者選擇 > 10 MB 或非支援格式檔案。
- When 前端先行檢查或收到後端拒絕。
- Then 顯示對應限制訊息（大小上限／格式不支援），不誤報成功。

**AC-21 草稿階段可刪除、刪除後不再顯示**
- Given 附件已關聯草稿。
- When 使用者於元件中刪除。
- Then 元件移除該項；重新載入不再出現。

> 說明：FE-US-21「已完成申請不得提供刪除/替換」「已完成附件有誤須建立修正版」屬申請完成後語意，於 PHASE-004+ 驗收（本 Phase 以 AC-16 於後端層守門）。

---

## 3. 資料模型與 migration

### 3.1 概念資料模型（Attachment）

沿用 `docs/DATA_FLOW.md` 的 Attachment 實體。本 Phase 新增**單一資料表 `Attachment`**（Prisma model）。概念如下（欄位型別/索引屬實作定案，可微調並記錄）：

```prisma
enum AttachmentStatus {
  TEMP     // 已上傳、尚未關聯任何申請（暫存）
  LINKED   // 已關聯至草稿容器
  // 註：LOCKED 不以獨立 enum 值表達，而由「所屬容器是否完成」決定（見 3.2 設計說明）
}

enum AttachmentRefType {
  TRIP_SEGMENT      // 差旅行程段（PHASE-004 套用）
  MAINTENANCE       // 保養申請（PHASE-006 套用）
  DEPRECIATION      // 折舊申請（PHASE-007 套用）
  // 本 Phase 不建立上述真實實體；此 enum 標示「引用來源類型」，關聯欄位為弱關聯（見 3.2）
}

model Attachment {
  id           String            @id @default(cuid())
  status       AttachmentStatus  @default(TEMP)

  // 儲存參照（storage 抽象層的 key，非容器本地絕對路徑；見 4.1）
  storageKey       String        @unique          // 原圖在 storage 的 key
  thumbnailKey     String?                        // 縮圖 key（產製成功才有）
  mimeType         String                         // 實際偵測到的 MIME（image/jpeg|png|webp）
  byteSize         Int                            // 實際位元組數
  originalFilename String                         // 使用者原始檔名（僅顯示用，不參與路徑組合）

  // 上傳者與擁有人（授權基礎）
  uploaderId   String                             // 執行上傳的使用者（可能是管理員代操作）
  ownerId      String                             // 資料擁有人（授權以此為準；代操作時=被代理使用者）

  // 引用來源（弱關聯：本 Phase 不建外鍵至尚不存在的申請表；見 3.2）
  refType      AttachmentRefType?
  refId        String?                            // 所屬容器識別（如 TripSegment id），LINKED 時必填
  // ownerContainerId：若引用容器與申請主檔不同層（如行程段 vs 差旅），保留擴充；本 Phase 以 refType+refId 表達

  createdAt    DateTime          @default(now())  // 上傳時間（暫存 TTL 基準）
  linkedAt     DateTime?                          // 關聯時間
  updatedAt    DateTime          @updatedAt

  @@index([ownerId])
  @@index([status])
  @@index([refType, refId])
  @@index([createdAt])
}
```

### 3.2 設計說明（弱關聯與 locked 判定）

- **弱關聯（refType + refId）而非外鍵**：本 Phase 不存在 `TripSegment`／`MaintenanceApplication`／`DepreciationApplication` 資料表（歸 PHASE-004/006/007）。若在此建立強外鍵會迫使本 Phase 提前建立申請表，違反垂直切片與 Out of Scope。故採 `refType`（enum）+ `refId`（字串）弱關聯表達「所屬容器」。**決策點 D1**：後續 Phase 是否將弱關聯升級為真外鍵（利：referential integrity、清理更安全；弊：跨模組耦合），列決策點。
- **locked 不以 enum 值持久化於 Attachment**：附件是否「鎖定」由**所屬容器（申請）是否已完成**決定，權威在申請狀態機（PHASE-004 `applications`）。本 Phase 提供 `assertContainerMutable(containerState)` 判定介面，由呼叫端傳入容器狀態（草稿/已完成）；`TEMP`/`LINKED` 僅描述附件自身關聯狀態。**理由**：避免附件狀態與申請狀態雙寫不一致；完成鎖定的唯一權威是申請狀態。**決策點 D2**：locked 語意來源（容器狀態注入 vs 附件冗餘旗標），列決策點供 Gate 確認。
- **owner vs uploader 分離**：對齊 PHASE-002 代操作模型（擁有人 vs 操作者），授權以 `ownerId` 為準，`uploaderId` 供稽核。本 Phase 上傳端點的 `ownerId` 預設=上傳者本人；管理員代上傳（指定他人為 owner）之完整情境於 PHASE-004 代操作套用，本 Phase 端點結構須預留（見 5.1 D3）。

### 3.3 migration

- 單一 migration：新增 `Attachment` 表與兩個 enum。無需觸及 PHASE-002 既有表（User/Session/AuditLog）。
- **不變式**：
  - `storageKey` 唯一；序列化 Attachment 的任何 API 回應**不外洩容器本地絕對路徑**，只回 storage key 或經授權端點的存取 URL。
  - `LINKED` 時 `refType` 與 `refId` 必填；`TEMP` 時可為 null。
  - `ownerId` 一經建立不變（附件不轉手）；代操作於建立時決定 owner。
- 下游（PHASE-004/006/007）將以 `AttachmentRefType` 對應各自容器，並在完成流程呼叫本 Phase 的鎖定/數量套用介面。enum 值可於後續 Phase 依需要擴充（沿用同一表）。

---

## 4. 關鍵技術定案

### 4.1 storage 抽象層（NFR-US-07、假設 A2）

- **介面定案**（概念，方法簽章屬實作細節）：

```
interface Storage {
  put(key, bytes, contentType): Promise<void>
  get(key): Promise<ReadableStream | Buffer>   // 供授權端點串流回傳
  delete(key): Promise<void>                    // 供清理排程（PHASE-011）
  exists(key): Promise<boolean>
}
```

- **本 Phase 實作 `LocalVolumeStorage`**：以 env `ATTACHMENT_STORAGE_ROOT`（掛載之持久化 volume 路徑）為根，key → 檔案路徑映射。key 由系統產生（如 `att/<cuid>/original`、`att/<cuid>/thumb`），**不含使用者輸入**，杜絕路徑穿越（path traversal）。原始檔名只存 DB 供顯示，不參與路徑。
- **可搬遷**：業務程式僅依賴 `Storage` 介面；替換為 S3/其他只實作新 class + 改 env，不改業務邏輯（NFR-US-07 第二條 AC）。MVP 只交付 local volume（無 S3）。
- **持久化與分離**：volume 掛載於後端容器外部（ARCHITECTURE §2），容器重建不遺失；正式 PDF（PHASE-008）將複用同一 volume 根下不同前綴。**決策點 D4**：附件與 PDF 是否共用同一 volume 根（利：單一備份對象；弊：權限/清理需以前綴隔離），列決策點。

### 4.2 內容型別偵測（防偽副檔名，AC-02，核心安全）

- **定案**：以**檔案 magic bytes** 偵測實際型別，不信任副檔名與 client 提供的 `Content-Type`。
  - JPEG：`FF D8 FF`；PNG：`89 50 4E 47 0D 0A 1A 0A`；WebP：`RIFF....WEBP`（前 4 bytes `52 49 46 46`，第 8–12 bytes `57 45 42 50`）。
  - 偵測到的型別須在白名單 {jpeg, png, webp} 內，否則拒絕（AC-02/03/05）。
- **依賴（決策點 D5）**：magic-byte 偵測可自寫（讀取前若干 bytes 比對，白名單僅 3 種，風險低、無依賴）**或**引入 `file-type`（ESM、MIT、維護活躍）。**建議**：MVP 以**自寫最小偵測**（白名單僅 3 格式，程式碼 < 50 行、可完整單元測試、零依賴、避免 ESM/CJS 互通與 postinstall 風險，對齊環境備註 npm 11 postinstall 封鎖）；若未來白名單擴大再評估 `file-type`。列為決策點，附必要性/維護/授權/大小評估。
- **縮圖庫（決策點 D5 續）**：預覽縮圖需影像處理庫（`sharp` 為主流、MIT、效能佳，但含原生綁定/postinstall，需 `npm approve-scripts`，且容器 build 需驗證，對齊環境備註）。**替代**：不產伺服器端縮圖，前端以原圖縮放顯示（省依賴，但傳輸大圖、列印/預覽效能較差）。**建議**：採 `sharp` 產製縮圖（限制縮圖尺寸如長邊 512px），但將其列為 **決策點 D5**（原生依賴風險），若容器 build 不可行則回退「前端縮放原圖」並記 Accepted Risk。

### 4.3 上傳處理（串流、大小上限，AC-04）

- 以 Fastify multipart 串流處理；於串流過程累計位元組，超過 `ATTACHMENT_MAX_BYTES` 立即中止並回 `PAYLOAD_TOO_LARGE`，**不將完整檔案讀入記憶體**（防 DoS）。
- 先讀取足夠標頭 bytes 做型別偵測（4.2），型別不合即中止（AC-02/03），避免寫入 volume 後才發現非法。**先驗型別與大小、通過才落地 volume 並建 DB 記錄**（見 4.4 順序與失敗處理）。
- 併發/暫存目錄：串流暫存採系統臨時區或直接串至 storage put；失敗須清除半寫檔（見 4.4）。

### 4.4 落地順序與失敗處理（避免孤兒檔/孤兒紀錄）

- 順序：**驗大小/型別（串流中）→ 產生 key → storage.put 原圖 →（sharp）產縮圖 storage.put → 建立 Attachment DB 記錄（TEMP）**。
- 失敗處理：
  - 型別/大小驗證失敗 → 不 put、不建記錄（AC-02/04）。
  - storage.put 成功但後續（縮圖或 DB）失敗 → **補償刪除**已寫入的 storage key，回錯誤，不留孤兒檔。
  - 縮圖產製失敗（非致命）→ 定案：原圖已合法則仍建記錄，`thumbnailKey=null`，前端回退顯示原圖縮放（記 Low 風險）；**或** 視縮圖為必要而整體失敗——**決策點併入 D5**（縮圖策略）。
- 冪等/重試不在本 Phase（單次上傳語意）。

### 4.5 生命週期狀態轉移（AC-13..18）

```
        upload (合法)
   ───────────────────▶  TEMP
                          │  link(container, owner)  [數量上限檢查 + owner 檢查]
                          ▼
                        LINKED ──── detach(草稿刪除) ────▶ TEMP（或 detached）
                          │
              container 完成（PHASE-004+，容器狀態=已完成）
                          ▼
                    （附件受 locked 保護：拒絕 detach/replace）
```

- `detach` 後定案：狀態轉回 `TEMP`（重置 `createdAt` 為 TTL 基準？→ **決策點 D2 相關**：解除關聯的附件是否重新起算 24h TTL。建議：解除即視為新暫存，`linkedAt=null`，TTL 以「最後一次成為 TEMP 的時間」起算，避免立即被清理造成 UX 突兀，或避免永不清理。列入 D2 說明。）
- 清理判定純函式 `isEligibleForCleanup(attachment, now, hasReference)`：`status==TEMP && !hasReference && now - tempSince > TTL` → 可清理（AC-17/18）。`hasReference` 由呼叫端（PHASE-011 排程）以「是否被任何草稿/已完成/報表/稽核引用」查得；本 Phase 提供判定函式與引用查詢介面契約，不跑排程。

### 4.6 授權存取（NFR-US-10、BE-US-02，沿用 PHASE-002）

- 存取附件內容端點僅掛 `requireAuth`（`requirePasswordChanged` 之取捨依 D8，定案不掛，見 5.1）；取得 Attachment 後以 `assertOwnershipOrAdmin(currentUser, attachment.ownerId)` 判定（PHASE-002 §4.7 契約）。
- 未登入 → 401 `UNAUTHORIZED`（AC-08）；非擁有者且非管理員 → 依 D6 回 403 `FORBIDDEN` 或 404 `NOT_FOUND`（AC-07）。
- **不得**因請求自帶他人 id/key 而繞過（授權以 DB 查得之 `ownerId` 為準，非以請求參數）。
- storage key 不可被使用者列舉/猜測即取檔：所有取檔一律經授權端點，**不得**將 volume 目錄以 nginx 靜態直出（否則繞過授權，違反 NFR-US-10）。**決策點 D7**：確認 nginx 不得直接對外暴露 volume 目錄，附件一律走後端授權端點。

### 4.7 稽核（沿用 PHASE-002 AuditLog）

- 本 Phase 附件的**上傳/關聯/解除**屬使用者對自有草稿的常態操作，**不寫稽核**（對齊 PHASE-002 D11「僅重要管理/代操作事件寫稽核」、避免擴大 Scope）。
- **管理員代操作**（管理員上傳/刪除他人附件、管理員存取他人附件內容）之稽核，隨 PHASE-004 代操作情境套用（沿用同一 `AuditLog`；`AuditAction` enum 於該 Phase 擴充）。本 Phase 不新增 audit action。
- 附件是否被稽核引用，是 4.5 清理引用保護的來源之一（AC-17）。
- 日誌一律沿用 PHASE-001 `sanitizeForLog` + pino redact；**不記錄** volume 絕對路徑之敏感前綴、不記錄檔案位元組、不記錄 session cookie。

### 4.8 錯誤碼

沿用 `AppError(code, httpStatus, message, fields?)` 與統一 body `{ error: { code, message, requestId, fields? } }`（PHASE-001）。`ErrorCode` union 新增：

| code | HTTP | 用途 |
|---|---|---|
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 實際內容非 JPEG/PNG/WebP（含偽裝副檔名、空檔、PDF 等） |
| `PAYLOAD_TOO_LARGE` | 413 | 單檔超過大小上限 |
| `TOO_MANY_ATTACHMENTS` | 409 | 關聯數達容器上限 |

- 沿用既有：`UNAUTHORIZED`(401)、`FORBIDDEN`(403)、`NOT_FOUND`(404)、`VALIDATION_ERROR`(400)、`CONFLICT`(409)。
- 「已完成不得刪除/替換附件」（AC-16）定案回 `FORBIDDEN`(403)（狀態不允許之操作，與擁有權不符同碼族）；亦可用 `CONFLICT`——**定案 403 FORBIDDEN**，理由：與 PHASE-002「已完成不得直接改」同語意族，避免碼義擴散。
- `message` 面向使用者、不外洩內部路徑/堆疊；`fields` 僅驗證錯誤出現。

---

## 5. API Contract（本 Phase 端點）

- 路徑經 nginx `/api` 反向代理至後端（去 `/api` 前綴，PHASE-001 定案）；下表為後端實際 route（前端呼叫加 `/api`）。
- 所有端點掛 `requireAuth` +（除存取端點外）`requirePasswordChanged`。回應成功/錯誤皆 JSON（存取端點成功回二進位檔）。
- **AttachmentDto**（回應排除任何 volume 絕對路徑）：`{ id, status, mimeType, byteSize, originalFilename, refType?, refId?, previewUrl, downloadUrl }`，其中 `previewUrl`/`downloadUrl` 為經授權端點的相對路徑（`/attachments/:id/thumbnail`、`/attachments/:id/content`）。

### 5.1 附件端點

| 方法 | 路徑 | 中介 | Request | 成功回應 | 主要錯誤 |
|---|---|---|---|---|---|
| POST | `/attachments` | requireAuth + requirePasswordChanged | `multipart/form-data`：單一檔案欄位 `file`；可選 `ownerId`（代操作，見 D3） | 201 `{ attachment: AttachmentDto }`（status=TEMP） | 415 `UNSUPPORTED_MEDIA_TYPE`；413 `PAYLOAD_TOO_LARGE`；400 `VALIDATION_ERROR`（缺檔） |
| GET | `/attachments/:id/content` | requireAuth | 無 | 200 二進位（原圖，正確 `Content-Type`；`Content-Disposition: inline`） | 401；403 `FORBIDDEN`/404（D6）；404 `NOT_FOUND` |
| GET | `/attachments/:id/thumbnail` | requireAuth | 無 | 200 二進位（縮圖；若無縮圖回退原圖或 404，依 D5） | 401；403/404 |
| POST | `/attachments/:id/link` | requireAuth + requirePasswordChanged | `{ refType, refId, limit }`（limit 由呼叫端/後續 Phase 提供上限） | 200 `{ attachment: AttachmentDto }`（status=LINKED） | 409 `TOO_MANY_ATTACHMENTS`；403（容器擁有權不符/已完成）；404 |
| DELETE | `/attachments/:id` | requireAuth + requirePasswordChanged | 無 | 200 `{ ok: true }`（解除關聯 / 標記可清理） | 403（已完成鎖定，AC-16；或非擁有者）；404 |

- **link 端點的定位**：本 Phase 提供 `link` 端點與服務層 `linkAttachment(attachmentId, {refType, refId, limit, containerState, actor})`。真實呼叫者為 PHASE-004+ 的申請草稿保存流程（草稿保存時把 TEMP 附件關聯至行程段/申請）。本 Phase 以最小宿主頁/測試直接呼叫驗證引擎。**limit 由呼叫端提供**（差旅 3/保養 5/折舊 5），本 Phase 不硬編碼類型上限（AC-12）。
- **content/thumbnail 不掛 requirePasswordChanged**：與 PHASE-002 對 `/me` 之慣例一致（取自身資源不阻於強制改密流程）；仍掛 `requireAuth` + 擁有權判定。**決策點 D8**：附件存取是否需 `requirePasswordChanged`。定案：不掛（取檔為讀取自有資源，且強制改密使用者理論上尚無附件；但為一致性與最小驚訝，僅要求登入 + 擁有權）。
- **代操作 ownerId（D3）**：`POST /attachments` 接受可選 `ownerId` 供管理員代上傳；一般使用者傳入非自身 `ownerId` 一律忽略/拒絕（授權以 `assertOwnershipOrAdmin`）。本 Phase 若不接管理員代上傳的完整情境，則端點忽略 `ownerId`、owner 恆為上傳者本人，代操作留 PHASE-004。列為決策點 D3。

### 5.2 最小宿主頁（前端）

- 一個受保護的最小頁（或掛在既有 authenticated 區）提供：選檔上傳、顯示上傳結果與縮圖、以可注入的 refType/refId/limit 觸發 link、列出並刪除附件。用途：整合 Gate 端到端驗收（AC-19/20/21）。差旅正式介面於 PHASE-004。

---

## 6. Data Flow（本 Phase 影響部分）

沿用並具體化 `docs/DATA_FLOW.md` §2.3。本 Phase 的資料流：

```
上傳：
使用者 →(multipart file)→ POST /attachments
  【授權】requireAuth（未登入→401 AC-08）
  【敏感】串流讀標頭 → magic-byte 型別偵測（非白名單→415 AC-02/03/05）
  【敏感】串流累計位元組（>上限→413 中止 AC-04）
  → 產生 storageKey → storage.put(原圖) → (sharp) 產縮圖 storage.put
  →（任一失敗→補償刪除已寫 key，回錯）
  → 建 Attachment(status=TEMP, owner=self 或代操作指定) → 201 AttachmentDto(含 previewUrl)

關聯（由 PHASE-004+ 草稿保存呼叫；本 Phase 直接驗證）：
呼叫端 →link(attachmentId, refType, refId, limit, containerState, actor)→
  【授權】assertOwnershipOrAdmin(actor, attachment.owner) + 容器擁有權
  → 容器已完成 → 拒（AC-16）
  → 現有關聯數 ≥ limit → 409 TOO_MANY_ATTACHMENTS（AC-10）
  → 否則 status=LINKED, refType/refId/linkedAt 寫入（AC-14）

刪除（草稿階段）：
使用者 →DELETE /attachments/:id→
  【授權】assertOwnershipOrAdmin(actor, owner)
  → 容器已完成（locked）→ 403（AC-16）
  → 否則解除關聯 → TEMP/detached（AC-15）

存取內容：
使用者 →GET /attachments/:id/content|thumbnail→
  【授權】requireAuth（未登入→401 AC-08）
  → 查 Attachment.ownerId → assertOwnershipOrAdmin（非擁有者且非管理員→403/404 AC-07/09）
  → storage.get(key) 串流回傳，正確 Content-Type（AC-06）

清理判定（排程於 PHASE-011）：
排程 →對每個 TEMP 附件→ isEligibleForCleanup(att, now, hasReference)
  → hasReference（草稿/已完成/報表/稽核引用）→ 不可清理（AC-17）
  → TEMP 且無引用且 >24h → 可清理（AC-18）→（PHASE-011 執行 storage.delete + DB 刪）
```

---

## 7. 非功能需求

- **NFR-US-07（永久附件不落應用容器）**：storage 抽象 + 掛載 volume；容器重建後附件可存取；替換儲存後端只改 env/實作 class。
- **NFR-US-10（附件存取安全）**：一律授權端點取檔；volume 不對外靜態直出（D7）；key 不含使用者輸入、不可路徑穿越。
- **NFR-US-14（效能，PHASE-011 集中驗證）**：上傳串流不整檔入記憶體；縮圖尺寸受限；取檔串流回應。上傳/取檔目標於 NFR-US-14 範圍（大附件等待時間排除於「一般表單 2s」）。
- **NFR-US-16（結構化錯誤）**：沿用統一錯誤格式；不外洩堆疊/DB 結構/volume 路徑。
- **NFR-US-05（env 驅動）**：`ATTACHMENT_STORAGE_ROOT`、`ATTACHMENT_MAX_BYTES`、`ATTACHMENT_TEMP_TTL_HOURS`、縮圖尺寸等一律 env（見第 8 節）；無寫死路徑/秘密。
- **安全（CLAUDE.md）**：全程合成測試檔；不記錄檔案位元組/敏感路徑於 log。

### 8. 環境變數（本 Phase 新增）

| 變數 | 用途 | 預設 |
|---|---|---|
| `ATTACHMENT_STORAGE_ROOT` | local volume 附件根路徑 | 由 compose/Zeabur 提供（無寫死） |
| `ATTACHMENT_MAX_BYTES` | 單檔大小上限 | `10485760`（10 MiB） |
| `ATTACHMENT_TEMP_TTL_HOURS` | 暫存清理門檻 | `24` |
| `ATTACHMENT_THUMBNAIL_MAX_PX` | 縮圖長邊像素（若採 sharp） | `512` |

- Docker/compose 掛載 volume 至 `ATTACHMENT_STORAGE_ROOT`；本機 Windows 需注意 volume 掛載（對齊環境備註 `DOCKER_BUILDKIT=0 docker compose -p oilexpense`）。若新增 `sharp` 依賴，須依環境備註 `npm approve-scripts` 並確認 backend Dockerfile 複製 node_modules 兩層、slim runtime 具 sharp 執行期相依（libvips）。

---

## 9. 測試策略

TDD：每 Task 先寫會失敗的測試再實作；不得 skip/弱化換綠燈。層級分配：

### 9.1 單元（Vitest，不需 DB）

- **內容型別偵測**：對每種合法 magic bytes 回正確型別；對偽裝副檔名（合法副檔名 + 非法標頭）、PDF/GIF/BMP/SVG/空檔回拒絕（AC-01/02/03/05）——**防偽副檔名內容檢測測試為核心安全案例**，以真實 magic bytes 合成樣本（非真圖，最小標頭 fixture）覆蓋每格式的接受與偽裝拒絕。
- **數量限制引擎**：`canLink(currentCount, limit)` 對 (2,3)→允許、(3,3)→拒、(5,5)→拒、(4,5)→允許 等多組（AC-10/11/12）。
- **生命週期狀態轉移純函式**：TEMP→LINKED、LINKED→detach→TEMP、locked→拒 detach（AC-14/15/16）；`isEligibleForCleanup` 對 (TEMP,無引用,>24h)→可清、(TEMP,有引用,>24h)→不可清、(TEMP,無引用,<24h)→不可清、(LINKED,...)→不可清（AC-17/18）。
- **storage key 產生**：不含使用者輸入、不可路徑穿越（給惡意 originalFilename 不影響 key）。
- **授權判定**：`assertOwnershipOrAdmin` 沿用 PHASE-002；此處測「以 DB owner 為準、忽略請求自帶 id」的服務層封裝。
- **錯誤碼組裝**：各拒絕路徑回正確 code/HTTP。

### 9.2 整合（Vitest + Postgres + 真實 route）

- **上傳全流程**：合法 JPEG/PNG/WebP → 201 + TEMP + 縮圖路徑；偽裝副檔名 → 415 且 DB 無記錄且 volume 無孤兒檔（驗補償刪除，4.4）；>10MB → 413；PDF → 415（AC-01..05）。
- **權限矩陣測試**（核心）：對 content/thumbnail/delete/link 端點，矩陣覆蓋 {擁有者本人、他人一般使用者、管理員、未登入} × {存在/不存在附件}，斷言 200/403(或404)/401（AC-06/07/08/09）。他人請求**不得**回任何位元組。
- **生命週期端到端**：上傳→link（達上限 409、未達成功）→草稿刪除解除→重載不顯示；容器已完成狀態注入→刪除/替換被拒 403（AC-10/13/14/15/16）。
- **落地失敗補償**：模擬縮圖或 DB 失敗 → 驗證已寫入 storage key 被刪、回錯、無孤兒（4.4）。
- **持久化**：storage.put 後由獨立 storage.get 讀回一致位元組（volume 讀寫正確；容器重建以測試環境模擬 root 不變即可讀回）。

### 9.3 E2E（Playwright）

- 最小宿主頁：登入 → 選合法圖上傳 → 見縮圖預覽（AC-19）；選 >10MB/非法格式 → 見限制訊息不誤報成功（AC-20）；關聯後刪除 → 重載不顯示（AC-21）。
- 授權 E2E（可選，主力在整合層權限矩陣）：以另一使用者 session 直接請求他人附件 URL → 不得取得內容（呼應 AC-07/08）。

### 9.4 安全與日誌測試

- 斷言錯誤回應與日誌**不含** volume 絕對路徑、不含檔案位元組、不含 cookie（沿用 `sanitizeForLog` + pino redact；以 logStream 擷取）。
- 斷言取檔一律經授權端點；volume 不透過 nginx 靜態直出（設定層檢查 / 說明於整合 Gate 人工複核，D7）。

---

## 10. Rollback

- 本 Phase 新增：單一 `Attachment` 表 + 兩 enum、附件端點、`LocalVolumeStorage`、最小前端宿主頁；於 `phase-003` branch 實作、Draft PR。
- 回滾（開發階段，合成資料）：以 branch 還原至 base commit 294386c；down migration 移除 `Attachment` 表與 enum。
- **volume 檔案清理**：回滾時已寫入 volume 的合成附件檔須一併清除（避免孤兒檔佔用；因無真實資料，可直接清空測試 root）。**不可**在有真實資料階段對 volume 執行破壞性清理（正式回滾為人類決策）。
- 因本 Phase 不接真實申請完成流程，無「已完成鎖定附件」之不可逆正式資料，回滾風險低於 PHASE-004。
- storage 抽象層若未來替換後端，回滾僅需還原 env/實作 class，不影響 DB 中 storageKey（key 語意穩定）。

---

## 11. 已知限制

- **弱關聯**：`refType`+`refId` 無 DB 外鍵約束（D1）；清理引用保護的正確性依賴呼叫端（PHASE-011）如實查詢所有引用來源；本 Phase 提供介面契約與判定函式，實際引用查詢的完整性於 PHASE-004+ 各引用來源就位後才閉環。
- **locked 語意注入**：AC-16 以「呼叫端注入容器狀態」測試，真實完成鎖定的端到端驗收於 PHASE-004（差旅完成流程套用時）。
- **縮圖依賴**（D5）：若採 `sharp`，原生依賴/容器 build 風險已知，回退為前端縮放原圖；預覽/列印大圖效能於 PHASE-008/011 再評估。
- **清理排程**：24h 實際刪除排程於 PHASE-011；本 Phase 僅判定，逾時未清的暫存附件在此期間佔用 volume（開發期合成資料，可接受）。
- **代操作上傳**：管理員代上傳（指定 owner）完整情境視 D3 決定是否於本 Phase 打開；預設留 PHASE-004。
- **CSRF/上傳來源**：沿用 PHASE-002 同源 + SameSite=Lax 基礎；multipart 上傳無額外 CSRF token（與既有一致，若人類要求另議）。

---

## 12. 需人類批准決策點（供 Gate 審閱）

> 以下為改變架構/使用者可見行為/依賴/安全面、或需人類定案者。**Spec 內僅為建議，不得視為既定**；Gate 批准後才落地。整份 Spec 屬 High 風險，需人類事前批准後方可轉 ACTIVE 實作。

| # | 決策點 | 建議 | 風險/影響 |
|---|---|---|---|
| D1 | Attachment 對申請容器採**弱關聯（refType+refId）**還是後續升級為真外鍵 | 本 Phase 弱關聯（避免提前建申請表）；PHASE-004+ 評估升外鍵 | referential integrity vs 跨模組耦合；影響清理安全性 |
| D2 | **locked 語意來源**（容器狀態注入 vs 附件冗餘旗標）＋ detach 後 TTL 是否重新起算 | 容器狀態為權威、附件不持久化 locked；detach 後以「重回 TEMP 時間」起算 TTL | 雙寫不一致風險 vs 查詢成本；影響 AC-16/18 |
| D3 | `POST /attachments` 是否於本 Phase 接受**管理員代上傳 ownerId** | 本 Phase 忽略 ownerId、owner=上傳者；代操作留 PHASE-004 | 是否提前引入代操作面；不縮減 US（FE-US-11 為使用者自上傳） |
| D4 | 附件與正式 PDF（PHASE-008）是否**共用同一 volume 根** | 共用根、以前綴隔離（`att/`、`pdf/`） | 單一備份對象 vs 前綴權限/清理隔離 |
| D5 | **新依賴**：內容偵測（自寫 vs `file-type`）、縮圖（`sharp` vs 前端縮放） | 內容偵測自寫（零依賴）；縮圖採 `sharp`（原生依賴，附回退） | `sharp` 含 postinstall/原生綁定（環境備註風險）；回退記 Accepted Risk |
| D6 | 非擁有者請求他人附件回 **403 FORBIDDEN vs 404 NOT_FOUND** | 定案 403（與 PHASE-002 擁有權不符一致）；若要求不洩漏資源存在則 404 | 資訊洩漏取捨；影響 AC-07 |
| D7 | 確認 **volume 不經 nginx 靜態直出**，附件一律走後端授權端點 | 一律授權端點；nginx 不暴露 volume 目錄 | 直出會繞過授權，違反 NFR-US-10（安全必守） |
| D8 | 附件存取端點是否掛 `requirePasswordChanged` | 不掛（僅 requireAuth + 擁有權），對齊 `/me` 慣例 | 一致性 vs 嚴格度；影響低 |

> 附註（依 Packet「Dependency Permission」）：D5 之依賴評估——`sharp`（MIT、維護活躍、主流影像庫、含原生綁定/postinstall、約數 MB、對齊環境備註需 approve-scripts 與 libvips runtime）；`file-type`（MIT、維護活躍、ESM、輕量、無原生）。本 Spec 僅提議，不安裝，待 Gate 批准。

---

## 13. Task Graph（細化，含風險等級與依賴）

對齊 PRD PHASE-003 T1~T7 並細化。每 Task 一律 TDD、一個 atomic commit（含 Task ID）。High 依 CLAUDE.md（附件權限/驗證/生命週期）。

### T1 — Attachment 資料模型 + migration（依 PHASE-002）— Medium
- 目標：`Attachment` 表 + `AttachmentStatus`/`AttachmentRefType` enum；不變式（storageKey 唯一、LINKED 必填 refType/refId、owner 不變）。
- TDD：migration 後可建 TEMP 附件、唯一鍵衝突丟錯、LINKED 缺 refId 由服務層拒（DB 層可為 nullable + 應用層守門）。
- 依賴：PHASE-002 User（owner/uploader 外鍵）。

### T2 — storage 抽象層 + LocalVolumeStorage + env（依 PHASE-001）— Medium
- 目標：`Storage` 介面 + `LocalVolumeStorage`（env root、key→路徑映射、path traversal 防護）、`put/get/delete/exists`。
- TDD：put→get 位元組一致；惡意 key/檔名不逃逸 root；delete/exists 正確。
- 依賴：PHASE-001 env 載入。

### T3 — 上傳與驗證（格式/大小/實際內容檢測）（依 T1, T2）— **High**
- 目標：`POST /attachments` 串流上傳、magic-byte 型別偵測（自寫，D5）、大小上限中止、落地順序與補償刪除、建 TEMP 記錄、回縮圖路徑。
- TDD：合法三格式 201；偽裝副檔名 415 且無孤兒；PDF/空檔 415；>10MB 413；補償刪除。
- High：是（附件驗證，安全核心 AC-02）。

### T4 — 附件數量限制引擎（可配置上限）（依 T1）— Medium
- 目標：純判定 `canLink(count, limit)` + `link` 服務層套用（limit 由呼叫端提供）。
- TDD：多組上限允許/拒絕（AC-10/11/12）。
- 依賴：T1。（引擎本身非 High；套用於授權/生命週期時經 High 端點）

### T5 — 授權存取端點（擁有權驗證後才回傳）（依 T1, PHASE-002 授權）— **High**
- 目標：`GET /attachments/:id/content|thumbnail`，requireAuth + `assertOwnershipOrAdmin`（以 DB owner 為準）、串流回傳、正確 Content-Type、未登入/他人拒絕（D6）。
- TDD：權限矩陣整合測試（擁有者/他人/管理員/未登入 × 存在/不存在）；他人不得取得位元組。
- High：是（附件授權，NFR-US-10）。

### T6 — 生命週期：暫存→關聯→解除 + 引用保護 + locked 判定（依 T1, T4）— **High**
- 目標：`link`/`detach`/`DELETE`、locked（容器狀態注入）拒改、`isEligibleForCleanup` 判定 + 引用查詢介面契約。
- TDD：狀態轉移純函式 + 整合（link 上限、草稿刪除解除、locked 拒刪、清理判定四象限）。
- High：是（生命週期/引用保護，BE-US-25）。

### T7 — 前端上傳/預覽/刪除元件 + 最小宿主頁（依 T3, T5, T6）— Medium
- 目標：選檔上傳、縮圖預覽、以可注入 refType/refId/limit 觸發 link、列出/刪除；前端大小/格式先行回饋。
- TDD：前端單元（元件互動、拒絕回饋）+ E2E（上傳/預覽/刪除；他人 URL 不得取得，呼應授權）。
- 依賴：T3/T5/T6 端點。

**High 風險 Task**：T3、T5、T6。

依賴圖：
```
PHASE-002（authz/audit/session）  PHASE-001（env/error/sanitizeForLog）
        │                                 │
        ▼                                 ▼
       T1 ─────────────┬─────────► T2
        │              │            │
        ▼              ▼            ▼
       T4         （T1,T2）───────► T3（High）
        │                            │
        ▼                            ▼
       T6（High） ◄──T1,T4      T5（High）（T1 + PHASE-002 授權）
        │                            │
        └──────────────┬─────────────┘
                       ▼
                      T7（前端 + 宿主頁）
```

---

## 14. Spec 修訂紀錄

| 日期 | 版本 | 變更 | 依據 |
|---|---|---|---|
| 2026-08-01 | DRAFT 建立 | 依 SPEC-003 Packet 建立 PHASE-003 完整 Spec | PRD 第 5 節 PHASE-003、userstory BE-US-23/24/25、NFR-US-07/10、FE-US-11/21；PHASE-002 授權/稽核契約 |
| 2026-08-01 | 文字澄清 | §4.6 存取內容端點更正為僅掛 `requireAuth`，消除與 §5.1／D8 之矛盾 | SPEC-003 驗收反饋（§11.1 不改變含義之文字澄清） |
| 2026-08-01 | DRAFT→ACTIVE | 人類事前批准：D1（弱關聯）、D2（容器狀態權威＋detach 重算 TTL）、D3（本 Phase 不接代上傳）、D4（共用 volume 根、前綴隔離）、D5（偵測自寫＋sharp 縮圖附回退）、D6（403）、D7（volume 不經 nginx 直出）、D8（存取端點不掛 requirePasswordChanged）全數照建議定案 | 使用者批准（2026-08-01，Spec Gate） |

> 狀態轉移：DRAFT →（人類事前批准 D1~D8）→ ACTIVE → 實作 → COMPLETED。
