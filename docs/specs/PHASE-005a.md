# PHASE-005a — 油資模型修正（按油種之每公升油價 + 按使用者之車輛油耗，推導每公里單價）

| 項目 | 內容 |
|---|---|
| **Spec 狀態** | `ACTIVE`（Spec Gate 通過：人類 leonchih 2026-08-03，D1~D11 全數照建議批准；T1~T8 High 之事前批准已於本 Gate 一併取得。見 §18 修訂紀錄） |
| **Phase ID** | PHASE-005a |
| **Task ID（本文件產出）** | PHASE-005a-SPEC |
| **Base Commit** | `e7f2860`；工作 branch `phase-005a` |
| **Risk Level** | **High**（金額模型變更 ＋ 管理員維護他人屬性之授權面 ＋ schema migration；依 CLAUDE.md「認證、授權、密碼、附件權限相關工作一律 High」與 PRD §5 High 判準「參數版本／快照」） |
| **依賴** | PHASE-002（授權中介與稽核基礎，DONE）、PHASE-003a（參數版本化引擎 + §14 欄位驗證合約，COMPLETED）、PHASE-004（差旅引擎／快照／代操作，COMPLETED）、PHASE-005a-US-LAND（US 修訂已落地，`e7e2c34`） |
| **被依賴** | PHASE-006（保養，不觸油資單價但共用參數頁與稽核）、PHASE-008（報表須呈現擴充後快照欄位）、PHASE-009（作廢／修正版沿用快照不可變） |
| **對應 US** | AD-US-11（修訂）、AD-US-15（新增）、FE-US-28（新增）、BE-US-32（新增）；連動：FE-US-10／12、BE-US-06／09／18／19、AD-US-14、BE-US-31 |
| **Human Gate** | **Spec 事前批准（本文件，High）** ＋ Mock Gate（油價頁／油耗維護頁／個人檢視／差旅提示）＋ 整合 Gate |
| **產出者** | spec-writer（Task Context Packet PHASE-005a-SPEC） |

> **本 Spec 的規範基礎**：CLAUDE.md 事實來源優先序 1→5。本文件**不改變任何 User Story 原意、不縮減任何已定稿 AC**。凡標「推薦」者一律**未定案**，須人類於 §16 裁定後由大總管以 §18 修訂紀錄固化，方可轉 `ACTIVE`。
>
> **US 層批准基礎**：`docs/specs/PHASE-005a-US-PROPOSAL.md`（`Status: APPROVED`，US Gate 人類 leonchih 2026-08-03，Q1–Q10 全數照推薦批准，Q3 明確裁定「僅擋完成申請，草稿可存」）；`PROJECT_STATE.md` L8 產品裁定五項；`userstory.md` 修訂後全文（`e7e2c34`）。

---

## 1. 目標與非目標

### 1.1 目標

1. **油價參數改為按油種維護之每公升油價**（AD-US-11 修訂後全文）：油種固定 92／95／98／柴油四項列舉（Q4），生效日期版本化，**每油種各自一條時間軸**（Q1），同油種重疊拒絕、跨油種互不干涉。
2. **新增「使用者車輛油種＋油耗」屬性**（AD-US-15）：**僅管理員可維護**，生效日期版本化、依出差日期取值、必填依據備註、異動留稽核。
3. **落地油資每公里單價推導**（BE-US-32）：單價 ＝ 每公升油價 ÷ 油耗，以**一般四捨五入取為新臺幣整數**；段金額 ＝ 總里程 × 取整後單價，段金額之取整層級沿用 BE-US-06 既有規則（Q9：**不新增第三處取整**）。
4. **缺資料之行為**（Q3 定案）：缺油耗或缺該油種油價 → **草稿可存、完成被擋**，且缺油耗與缺油價之提示**必須可區分**（FE-US-12 第四條 AC）。
5. **擴充完成快照**（BE-US-18 修訂後全文、Q8）：保存**油種、每公升油價、車輛油耗、推導取整後之油資每公里單價、ETC 單價、取整前金額及取整後金額**，使歷史金額可重現、可對帳。
6. **員工唯讀檢視自身油耗**（FE-US-28）：僅目前生效版本之油種／油耗／生效日（Q5），**無任何新增／修改／刪除入口**。
7. **既有已完成申請之快照零影響**：本 Phase 之 migration **一律為新增（additive）**，不改寫、不回填、不刪除任何既有快照欄位或資料列。

### 1.2 非目標（Out of Scope）

| 項目 | 落點 | 說明 |
|---|---|---|
| 車輛主檔（車牌、廠牌、車型、車籍） | 永久 Out of Scope | `userstory.md` L2328 逐字：「車輛主檔（僅納入油種與油耗兩項補助計算必要屬性，不含車牌、廠牌、車型、車籍等主檔欄位）」（Q2 裁定） |
| 油種清單之自訂／新增／停用 | 不做 | Q4：MVP 固定四項列舉，不提供自訂（自訂即引入油種主檔維護） |
| ETC 參數模型、折舊參數模型 | 不變更 | US 盤點確認不受影響（US-PROPOSAL §3.1） |
| 保養分攤、折舊補貼 | PHASE-006／007 | 不涉油資單價 |
| 報表與 PDF 版型呈現新快照欄位 | **PHASE-008** | 本 Phase 只負責**寫入**快照；版型呈現屬 008（見 §17.2 銜接註記） |
| 作廢／修正版 | PHASE-009 | 不觸 |
| 油耗版本之**修改／刪除**端點 | **待裁定，見 §16 D8** | 推薦 append-only（僅新增版本），與既有參數版本一致 |
| 既有 `FuelParameterVersion`（每公里單價）之資料遷移換算 | **明確不做** | 舊資料語意為「每公里單價」，與新模型「每公升油價」**量綱不同**，任何自動換算都是臆造；處置見 §16 **D1** |
| 統計引擎（PHASE-005） | 不觸 | 統計讀 `snapshotTotalKm`，與單價無關 |

---

## 2. 可測試 Acceptance Criteria

> **AC 追溯規則**：每條 AC 標註來源 US 原文條目（逐字引用置於引言區）。**符號**：`Tn` ＝ 落在哪個 Task（§15）。
> **金額語意類 AC（AC-19~AC-29）之測試一律以精確等值斷言，禁止近似比較。**

### A. 油價參數（按油種）— AD-US-11、BE-US-19

> AD-US-11 第 1 條 AC 原文：「Given 管理員選擇油種並輸入大於或等於 0 的每公升油價及生效日期／When 建立參數版本／Then 系統應保存該油種的新版本。」

**AC-01 依油種建立油價版本（AD-US-11 第 1 條 / T3）** — Given 管理員提供 `fuelType ∈ {GASOLINE_92, GASOLINE_95, GASOLINE_98, DIESEL}`、`pricePerLiter ≥ 0`、合法 `effectiveFrom`（`YYYY-MM-DD`）。When 建立。Then **201**，回傳含 `id`／`fuelType`／`pricePerLiter`（字串，4 位小數）／`effectiveFrom`／`createdAt` 之 DTO；DB 中該油種新增一列。

**AC-02 同油種重疊拒絕並指出衝突（AD-US-11 第 2 條、BE-US-19 第 1 條 / T3）** — Given 同一 `fuelType` 已有 `effectiveFrom = D` 之版本。When 以同油種、同 `effectiveFrom = D` 提交。Then **409 `PARAMETER_PERIOD_OVERLAP`**，`details.conflictVersion` 含衝突版本之 `id` 與 `effectiveFrom`。
> **鑑別力**：沿用 PHASE-003a `checkNoOverlap` 之日粒度語意；DB 層 `@@unique([fuelType, effectiveFrom])` 為併發最後防線，並發衝突亦須回 409 而非 500。

**AC-03 跨油種時間軸互相獨立（AD-US-11 第 3 條、BE-US-19 第 2 條 / T3）** — Given `GASOLINE_95` 已有 `effectiveFrom = 2026-01-01`。When 以 `GASOLINE_92`（或 98／柴油）同一 `effectiveFrom = 2026-01-01` 提交。Then **201 允許建立**；四種油種可同時各有生效版本。
> **鑑別力（必要）**：若實作沿用舊的全域 `@@unique([effectiveFrom])` 或未把 `fuelType` 納入重疊判定，本條必紅。測試須建立**四個油種同生效日**之完整組合。

**AC-04 依出差日期取同油種有效版本、未來版本不影響現行（AD-US-11 第 4 條、BE-US-19 第 3 條 / T7）** — Given `GASOLINE_95` 有 `2026-01-01`（30.0000）與 `2026-06-01`（35.0000）兩版本。When 出差日期為 `2026-05-31`／`2026-06-01`／`2026-06-02`。Then 分別取得 `30.0000`／`35.0000`／`35.0000`（**含當日**）。且同時間 `DIESEL` 之版本集合完全不影響此結果。
> **鑑別力**：四點邊界（`2025-12-31` 應取不到任何版本 → 缺油價）。複用 `parameter-version-engine.ts:findEffectiveVersion`，**不得重寫日期比較邏輯**。

**AC-05 油種列舉封閉（Q4 / T3）** — Given `fuelType` 為 `"GASOLINE_91"`／`"98"`／`""`／`null`／數字／物件／陣列。Then **400 `VALIDATION_ERROR`**，`fields[].field === "fuelType"`；**不得** 500、不得建立任何列。缺 `fuelType` 欄位亦為 400。

**AC-06 油價欄位驗證：格式層四道 ＋ 值域層（AD-US-11 第 1 條「大於或等於 0」；PHASE-003a §14.2 逐字合約 / T3）** — 檢查順序恆為 `型別 → 十進位字面 → 小數位 → 量級 → 值域`（PHASE-003a §14.2「檢查順序（決定性要求，AC-32）」原文），同一欄位先命中者決定 `reason`：
> - 非 string 亦非 number（`true`／`[]`／`{}`／`null`） → 400，`reason = 必須為有效的數值（字串或數字）`
> - 空字串／全空白 → 400，`reason = 必須為有效的數值`
> - 非十進位字面（`"1e5"`／`".5"`／`"19."`／`"+19.9"`／`"0x10"`／`"Infinity"`／`"NaN"`／`"abc"`） → 400，`reason = 必須為有效的十進位數值（不接受指數記號）`
> - 小數位 > 4 → 400，`reason = 最多允許 4 位小數`
> - `|value| ≥ 10^6` → 400，`reason = 數值超出可儲存範圍（整數部分最多 6 位）`
> - `value < 0` → 400，`reason = 單價不得小於 0`
> - `0`／`"0"`／`"999999.9999"`／`" 30.5 "`（前後空白，trim 後判定）→ **201**（邊界正例）
>
> **實作約束**：**必須複用** `backend/src/parameters/parameter-validation.ts` 之 `parseParameterDecimalField` 與 `UNIT_PRICE_CAPACITY`（`Decimal(10,4)`），**不得另寫一套**（避免 CHORE-003 已消滅之 500 路徑復活）。

### B. 使用者車輛油耗（AD-US-15、BE-US-19、BE-US-31）

> AD-US-15 第 1 條 AC 原文：「Given 管理員選擇一位使用者，輸入油種、大於 0 的油耗、生效日期及依據備註／When 建立油耗資料版本／Then 系統應保存該使用者的新版本。」

**AC-07 管理員為指定使用者建立油耗版本（AD-US-15 第 1 條 / T4）** — Given 管理員提供 `userId`（存在且未刪除）、`fuelType`（四項列舉）、`kmPerLiter > 0`、合法 `effectiveFrom`、非空 `basisNote`。When 建立。Then **201**，DB 新增一列，`createdById` 為操作管理員。`userId` 不存在 → **404 `NOT_FOUND`**（不得 500，不得洩漏帳號存在與否以外之資訊）。

**AC-08 油耗 ≤ 0 拒絕並指出欄位（AD-US-15 第 2 條 / T4）** — Given `kmPerLiter` 為 `0`／`"0"`／`-1`／`"-0.0001"`。Then **400 `VALIDATION_ERROR`**，`fields[].field === "kmPerLiter"`，`reason = 油耗必須大於 0`。
> **邊界正例**：`"0.0001"`（>0 之最小可表示值，`Decimal(10,4)`）→ 201。

**AC-09 依據備註必填（AD-US-15 第 3 條、Q6 / T4）** — Given `basisNote` 缺欄位／`null`／`""`／`"   "`（全空白）。Then **400**，`fields[].field === "basisNote"`，`reason = 請填寫核對依據`。`basisNote` 長度 > 上限（見 §16 **D3(c)**）→ 400 定位同欄位。

**AC-10 同使用者重疊拒絕、跨使用者互不干涉（AD-US-15 第 4／5 條、BE-US-19 第 2 條 / T4）** — Given 使用者 A 已有 `effectiveFrom = D` 之油耗版本。When 以 A、同 `D` 提交 → **409 `PARAMETER_PERIOD_OVERLAP`** 含 `details.conflictVersion`。When 以使用者 B、同 `D` 提交 → **201**。
> **鑑別力**：DB 層 `@@unique([userId, effectiveFrom])` 為併發最後防線，並發衝突回 409 而非 500。

**AC-11 油耗欄位驗證：格式層四道 ＋ 值域層（PHASE-003a §14.2 合約之同形套用 / T4）** — 順序與文案沿用 AC-06 之六道，惟值域層改為「必須大於 0」。`"1e1"`／`"Infinity"`／`" 15.5 "`／小數位超限／量級超限之判定與 AC-06 同形。**必須複用** `parseParameterDecimalField`（容量常數見 §16 **D3(b)**）。

**AC-12 油耗版本清單（管理員視角）（AD-US-15 第 10 條 / T5）** — Given 管理員查看某使用者。Then 回傳該使用者**全部版本**（歷史／目前生效／未來生效）依 `effectiveFrom` 升冪；每列含 `id`／`fuelType`／`kmPerLiter`／`effectiveFrom`／`basisNote`／`createdAt`／`createdById`，並含後端計算之 `state ∈ {HISTORICAL, CURRENT, FUTURE}`（相對於**查詢當日**，由後端判定，前端不自算）。無版本 → **200 空陣列**（非 404）。

**AC-13 一般使用者（含本人）對油耗一律不可寫（AD-US-15 第 8 條逐字：「Given 一般使用者嘗試建立、修改或刪除任何油耗資料，包含自己的資料／When 系統驗證權限／Then 應拒絕操作。」/ T5）** — Given 一般使用者。When 呼叫任何油耗**寫入**端點（含 `userId = 自己`）。Then **403 `FORBIDDEN`**；DB 零寫入（以寫入前後列數與 `updatedAt` 逐項比對證明）。未登入 → **401**；`mustChangePassword=true` → **403 `PASSWORD_CHANGE_REQUIRED`**。
> **判定順序（沿用 PHASE-005 B-26）**：認證 → 強制改密 → 授權（requireAdmin）→ 格式驗證。授權失敗之回應**不得**因輸入合法與否而有差異（無側信道）。

**AC-14 油耗異動稽核（AD-US-15 第 9 條、BE-US-31 第 4 條、AD-US-14 第 1 條 / T5）** — Given 管理員成功建立油耗版本。Then **同一交易內**寫入一列 `AuditLog`：`action` 為新增之 `USER_FUEL_CONSUMPTION_VERSION_CREATED`、`actorId` ＝ 操作管理員、`targetId` ＝ **資料對象使用者**、`targetLabel` ＝ 對象 `loginName` 快照、`summary` 含 `{ before: { fuelType, kmPerLiter, effectiveFrom } | null, after: { fuelType, kmPerLiter, effectiveFrom }, basisNote }`。
> **「異動前後」之精確定義（Spec 層澄清，append-only 模型下）**：`before` ＝ 新版本 `effectiveFrom` **之前**最後一個生效版本（`findEffectiveVersion(existing, newEffectiveFrom − 1 日)`）；無此版本則為 `null`。
> **不得**寫入密碼、token、session cookie（CLAUDE.md 禁止事項；沿用 PHASE-003a AC-18 慣例）。稽核寫入失敗須使整筆建立回滾（同交易）。

### C. 員工唯讀檢視自身油耗（FE-US-28）

**AC-15 讀取自身目前生效版本（FE-US-28 第 1 條、Q5 / T6）** — Given 已登入使用者且今日有生效中的油耗版本。When 呼叫自身唯讀端點。Then **200**，回傳 `{ fuelType, kmPerLiter, effectiveFrom }`（＋油種 zh-TW 標籤由前端映射）。**不得**回傳 `basisNote`、歷史版本、未來版本、`createdById`、其他使用者任何資料（**逐鍵白名單斷言**：頂層鍵集合恰為列舉集合，多一鍵即紅）。

**AC-16 尚未建立 → 200 空狀態（FE-US-28 第 2 條 / T6）** — Given 使用者無任何油耗版本（或全部版本之 `effectiveFrom` 皆在未來）。Then **200**，`{ current: null }` 形狀（依 §16 **D7** 定案），**不得** 404、不得 500、不得回傳空字串或 `NaN`。

**AC-17 自身唯讀端點不得成為他人資料通道（BE-US-02、Q10 / T6）** — Given 一般使用者以任何方式指定他人識別值（query／body／path）。Then 回應恆為**自己**的資料或 **403**，**絕不**回傳他人資料；不得靜默降級為「看起來像他人資料」。管理員讀他人資料須走 AC-12 之管理端點（該端點回傳完整版本清單）。
> **Q10 約束（PHASE-004 D6 邊界，PROJECT_STATE 原文）**：「不得以『一般使用者不知道單價』作為安全前提」。本 Phase 之落實為**正向白名單**：所有回應之鍵集合為封閉清單，新增欄位須改 Spec。

### D. 油資每公里單價推導（BE-US-32 — 金額核心）

> BE-US-32 第 1 條 AC 原文：「Given 出差日期存在該擁有人有效的油耗版本，且該版本的油種在該日期存在有效的油價版本／When 計算油資每公里單價／Then 應使用「每公升油價 ÷ 油耗」，並以一般四捨五入取為新臺幣整數。」
> BE-US-32 第 2 條 AC 原文：「Given 油資每公里單價已取整／When 計算行程段油資補助／Then 應使用「總里程 × 取整後的油資每公里單價」。」

**AC-18 單價推導公式與取整（BE-US-32 第 1 條、CLAUDE.md「一般四捨五入（0.5 進位），不用銀行家取整；最終金額為新臺幣整數」/ T2）** — Given `pricePerLiter = P`、`kmPerLiter = C`。Then 單價 ＝ `ROUND_HALF_UP(P ÷ C, 0)`，型別為**整數**。精確驗點（表列，逐條精確等值）：

| P（元/L） | C（km/L） | P ÷ C | 取整後單價 |
|---|---|---|---|
| `30.0000` | `10.0000` | 3 | **3** |
| `31.0000` | `10.0000` | 3.1 | **3** |
| `35.0000` | `10.0000` | 3.5 | **4**（0.5 進位，非銀行家取整） |
| `45.0000` | `10.0000` | 4.5 | **5**（銀行家取整會得 4 → 必紅） |
| `29.9999` | `10.0000` | 2.99999 | **3** |
| `1.0000` | `3.0000` | 0.333… | **0** |
| `0.0000` | `10.0000` | 0 | **0** |
| `30.0000` | `0.0001` | 300000 | **300000** |

> **鑑別力（必要）**：`35 ÷ 10` 與 `45 ÷ 10` 兩列同時存在，可鑑別銀行家取整；`1 ÷ 3` 可鑑別「先乘後除」或未取整之實作。
> **零浮點約束**：全程 `Prisma.Decimal`（`.div()`／`.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)`），**禁止** `Number()`／`parseFloat`／`/` 浮點除法作為中介（沿用 `travel-calculation.ts` 之既有紀律）。

**AC-19 段金額沿用既有取整層級，不新增第三處取整（BE-US-32 第 2 條、BE-US-06 第 3 條、Q9 / T8）** — Given 取整後單價 `U`、ETC 單價 `E`、段 `totalKm = K`、`highwayKm = H`。Then：
> `segFuel = K × U`（未取整）→ `segEtc = H × E`（未取整）→ `segRaw = segFuel + segEtc`（**先相加**）→ `segAmt = ROUND_HALF_UP(segRaw, 0)`；整筆 `totalAmount = Σ segAmt`。
> **取整恰兩處**：①單價推導（AC-18）②段金額（本條）。**不得**在 `segFuel` 或 `Σ` 層再取整。
> **鑑別力**：`K = 12.50, U = 3, H = 4.00, E = 2.0000` → `segFuel = 37.5`、`segEtc = 8`、`segRaw = 45.5`、`segAmt = 46`。若在 `segFuel` 先取整（38）則 `segRaw = 46`、`segAmt = 46` —— 此例不可鑑別，故**必須另加**鑑別例：`K = 0.50, U = 3, H = 0.25, E = 2.0000` → `segFuel = 1.5`、`segEtc = 0.5`、`segRaw = 2.0`、`segAmt = 2`；若先各自取整則得 `2 + 1 = 3` → 必紅。
> **實作約束**：`calculateTravel`（`travel-calculation.ts`）之演算法**零改動**；本 Phase 只改變傳入的 `fuelUnitPrice` 之**來源**（由參數表直讀 → 由推導取整而得）。

**AC-20 推導單價之欄位容量守門（新識別之結構性風險 / T2, T8）** — Given 推導後單價 `U` 使 `|U| ≥ 10^6`（例：`P = 999999.9999, C = 0.0001` → `U ≈ 9.9999999e9`）。Then 依 §16 **D4** 定案之處置回應；**在任何情況下不得** 500、不得靜默截斷寫入快照欄位。
> **背景**：快照欄位 `TravelApplication.fuelUnitPrice` 為 `Decimal(10,4)`（整數部 6 位），而輸入值域（油價 < 1e6、油耗 > 0）之商**無上界**。此為 US 層未預見之結構性邊界，故列為決策點 D4。

**AC-21 缺油耗：草稿可存、完成被擋、提示可區分（BE-US-32 第 3／4 條逐字、Q3、FE-US-12 第四條 / T7）** — Given 申請擁有人在出差日期**沒有**有效油耗版本。Then：
> - When 儲存草稿 → **200/201 允許保存**（`completionBlockers` 含 `FUEL_CONSUMPTION_NOT_AVAILABLE`）。
> - When 嘗試完成 → **409 `PARAMETER_NOT_AVAILABLE`**，`details.missing` 含 `FUEL_CONSUMPTION`（wire 值依 §16 **D5**），訊息為「請聯絡管理員建立油耗資料」之 zh-TW 文案，**與缺油價之訊息逐字不同**。
> - **不得**以預設值、替代值或其他使用者的資料計算（BE-US-32 第 4 條逐字）。**鑑別力**：測試須存在另一使用者之有效油耗版本，且該值**不得**出現在結果中。

**AC-22 缺該油種油價：完成被擋，提示為「設定參數」（BE-US-32 第 5 條、FE-US-12 第三條 / T7）** — Given 擁有人有有效油耗版本（油種 `F`），但 `F` 在出差日期**沒有**有效油價版本（縱使其他油種有）。Then 草稿可存；完成 → **409 `PARAMETER_NOT_AVAILABLE`**，`details.missing` 含油價缺項，訊息為「請聯絡管理員設定參數」，**與 AC-21 之訊息逐字不同**。
> **鑑別力（必要）**：測試須令**其他三個油種皆有**有效油價版本，僅 `F` 缺；若實作以「任一油種有版本」判定則必紅。

**AC-23 代操作以擁有人資料為準（BE-US-32 第 6 條逐字 / T7）** — Given 管理員 M（自身有油耗版本，油種／油耗與擁有人**互異**）代使用者 O 操作差旅。Then 解析與計算一律使用 **O** 的油耗版本與其油種之油價；`M` 的任何數值不得出現於預覽、完成結果或快照。
> **鑑別力**：M 與 O 之推導單價須刻意設為互異整數（例 M → 5、O → 3），以精確等值斷言最終金額。

**AC-24 後端權威：不採用前端提交之單價／油價／油耗（BE-US-32 第 8 條逐字、CLAUDE.md「後端不得採用前端提交的金額」/ T8）** — Given 請求 body／query 夾帶 `fuelUnitPrice`／`pricePerLiter`／`kmPerLiter`／`amount`／`totalAmount` 等欄位（合法或畸形值皆然）。Then 一律忽略；輸出恆為後端計算值；**不得**因夾帶欄位而 500 或改變輸出。

### E. 快照擴充與不可變（BE-US-18、BE-US-09、AD-US-11 第 5 條）

> BE-US-18 第 1 條 AC 原文：「Given 差旅申請完成／When 保存資料／Then 應保存使用的油種、每公升油價、車輛油耗、推導取整後之油資每公里單價、ETC 單價、取整前金額及取整後金額。」

**AC-25 完成時保存七項來源值＋兩個版本 id（BE-US-18 第 1 條逐字、Q8 / T8）** — Given 差旅完成成功。Then `TravelApplication` 之快照包含且逐欄可讀：`snapshotFuelType`（油種）、`snapshotFuelPricePerLiter`（每公升油價）、`snapshotFuelConsumption`（車輛油耗）、`fuelUnitPrice`（推導取整後之每公里單價）、`etcUnitPrice`、`snapshotRawAmount`（取整前）、`Application.totalAmount`（取整後）；並記錄 `fuelPriceVersionId`、`fuelConsumptionVersionId`、`etcParameterVersionId`。
> **可重現性驗證（本 AC 之鑑別力）**：測試須以快照三項來源值**獨立重算** `ROUND_HALF_UP(snapshotFuelPricePerLiter ÷ snapshotFuelConsumption, 0)`，斷言等於 `fuelUnitPrice`；再以 `fuelUnitPrice` 與各段里程重算段金額，斷言等於 `snapshotAmount`。**若僅存單價，本斷言不可能成立** —— 這是 Q8 之機械證明。

**AC-26 快照不可變：後續改參數不影響歷史（AD-US-11 第 5 條、AD-US-15 第 7 條、BE-US-32 第 7 條、BE-US-09 第 4 條 / T8）** — Given 差旅 X 已完成。When 管理員新增油價版本（更早或更晚生效）或新增該使用者之油耗版本。Then X 之 `fuelUnitPrice`／`snapshotFuelPricePerLiter`／`snapshotFuelConsumption`／`snapshotFuelType`／各段 `snapshot*`／`totalAmount` **逐位元不變**；`GET` X 亦不重新解析參數（**不呼叫** `resolveTravelParameters`）。
> **鑑別力**：以「新增一個 `effectiveFrom` 早於 X 出差日期且數值不同的版本」為變異，若 DTO 走重算路徑必紅。

**AC-27 舊模型已完成申請完全不受 migration 影響（Packet Done When 2 硬性要求 / T1）** — Given migration 前存在之已完成差旅（快照由 PHASE-004 舊模型寫入，`fuelParameterVersionId` 非空、新增之五個欄位不存在）。When 套用本 Phase 全部 migration。Then 該列**所有既有欄位逐位元不變**（以 migration 前後之欄位值快照比對證明），新增欄位一律為 `NULL`；`GET` 該申請仍回 200 且 `snapshot` 非 null。
> **鑑別力**：測試須在 migration 前寫入一筆完整已完成差旅（或以 fixture 模擬舊列：新五欄為 NULL、`fuelParameterVersionId` 非空），並斷言 DTO 之新舊模型判別欄位（見 §8.4）行為正確。

**AC-28 零浮點中介之結構性守門（CLAUDE.md 金額規則、CHORE-003 AC-29 同形 / T2）** — Then 本 Phase 新增之推導模組與服務層原始碼中，金額／油價／油耗路徑**不得**出現 `Number(`／`parseFloat(`／`parseInt(`／`+<變數>` 之數值脅制；`Prisma.Decimal` 一律以**字串**建構（D4 bright-line）。以掃描本 Phase 新增檔案之結構性斷言守門（白名單僅允許日期字串解析用之 `Number()`）。

### F. 前端（AD-US-11、AD-US-15、FE-US-28、FE-US-10、FE-US-12、FE-US-27）

**AC-29 管理員油價維護頁含油種（AD-US-11 / T9）** — Given 管理員開啟參數維護頁。Then 油資區塊之表單含**油種選擇**（四項 zh-TW 標籤：`92 無鉛汽油`／`95 無鉛汽油`／`98 無鉛汽油`／`柴油`）與**每公升油價**欄位（標籤明示單位「元／公升」）；版本列表含油種欄且可辨識各油種各自之時間軸。五態齊備（見 §4）。

**AC-30 管理員油耗維護頁（AD-US-15 第 10 條 / T10）** — Given 管理員選定一位使用者。Then 顯示該使用者之版本列表（歷史／目前生效／未來生效可辨識，含生效日期與依據備註）＋建立表單（使用者、油種、油耗、生效日、依據備註）。版型比照 PHASE-003a 參數頁（`.param-table` 樣式、數值欄靠右 `.num-col`、日期 `YYYY-MM-DD`，見 PHASE-003a §13 UI-FIX-001 修訂列）。五態齊備。

**AC-31 員工個人油耗檢視（FE-US-28 全四條 / T11）** — Then：①有生效版本 → 顯示油種／油耗／生效日；②無資料 → 顯示空白狀態＋「請聯絡管理員建立」；③畫面**不得**存在新增／修改／刪除入口（以「不存在具該語意之可互動元素」之負向斷言驗證）；④顯示固定說明文案「如與實際車輛不符，請聯絡管理員核對後更新」。

**AC-32 差旅表單缺油耗提示與缺油價可區分（FE-US-12 第四條逐字、FE-US-10 第四條 / T11）** — Given 後端回 `missingParameters` 僅含油耗缺項。Then 顯示「請聯絡管理員建立油耗資料」；Given 僅含油價缺項 → 顯示「請聯絡管理員設定參數」；Given 兩者皆缺 → **兩則訊息同時可見**。三種情境之畫面文字**逐字互異**（以精確字串斷言）。且預覽區顯示「油資無法計算」而非顯示金額 0 為最終值（FE-US-10 第四條）。

**AC-33 響應式 375px 無水平溢位（FE-US-27、PHASE-004 AC-89 慣例 / T13）** — Given 375px viewport 下開啟油價頁、油耗維護頁、個人檢視區塊。Then `document.body.scrollWidth <= window.innerWidth`；寬表格以 `.table-scroll` wrapper 內捲。

### G. 非功能與錯誤合約

**AC-34 錯誤格式統一且不外洩（NFR-US-16、PHASE-005 AC-34 同形 / T12）** — Then 所有錯誤回應為 `{ error: { code, message, requestId, fields? } }`；**不得**含堆疊、DB 結構、SQL、絕對路徑；日誌不含密碼／token／session cookie／依據備註以外之個資。
> **CHORE-003 教訓引用（PHASE-003a §14.1 回填原文）**：Prisma 之 `PrismaClientUnknownRequestError`／`PrismaClientValidationError` 兩類例外**日誌均含絕對來源路徑**，故本 AC 之日誌斷言對新增之整數／Decimal 欄位同樣必要。

**AC-35 不新增未列 `ErrorCode`（NFR-US-16 / T12）** — Then 錯誤路徑僅使用既有 `ErrorCode` 聯集（`platform/errors.ts`）：`VALIDATION_ERROR`(400)、`UNAUTHORIZED`(401)、`FORBIDDEN`(403)、`PASSWORD_CHANGE_REQUIRED`(403)、`NOT_FOUND`(404)、`PARAMETER_PERIOD_OVERLAP`(409)、`PARAMETER_NOT_AVAILABLE`(409)、`INTERNAL_ERROR`(500)。以結構性斷言（列舉聯集全等）守門。

**AC-36 授權矩陣完整覆蓋（BE-US-02、AD-US-15 第 8 條 / T5）** — 下表每一格皆須有測試（**15 必要格**）：

| 角色／狀態 | 油價寫入 | 油價讀取 | 油耗寫入（他人） | 油耗寫入（自己） | 油耗讀取（他人，管理端點） | 自身唯讀端點 |
|---|---|---|---|---|---|---|
| 未登入 | 401 | 401 | 401 | 401 | 401 | 401 |
| `mustChangePassword=true` | 403 PCR | 403 PCR | 403 PCR | 403 PCR | 403 PCR | 403 PCR |
| 一般使用者 | 403 | 403 | **403** | **403** | **403** | 200（自己） |
| 管理員 | 201/409/400 | 200 | 201/409/400 | 201 | 200 | 200（自己） |
| 停用帳號（`isActive=false`） | 401 | 401 | 401 | 401 | 401 | 401 |

### H. 舊油資端點凍結（§16 **D1(a)** 之落實）

> **D1(a) 批准原文（§16，人類 leonchih 2026-08-03）**：「`POST /parameters/fuel` **移除**（回 404），`GET /parameters/fuel` **保留為唯讀**（供稽核追溯與 PHASE-008 舊快照顯示）」；同段並明示「需調整 PHASE-003a 之既有測試（**屬依 Spec 更新斷言，非弱化測試**）」。本 AC 為該批准之排程落點，**不引入任何新產品決策**。

**AC-37 `POST /parameters/fuel` 移除、`GET /parameters/fuel` 唯讀保留（§16 D1(a) / T3b）**

- **(a) 寫入端點回 404** — When 以任何 body（合法或畸形）呼叫 `POST /parameters/fuel`。Then **404 `NOT_FOUND`**，body 為統一錯誤形狀 `{ error: { code: "NOT_FOUND", message, requestId } }`（由 `backend/src/platform/error-handler.ts:63-68` 之 `setNotFoundHandler` 提供；`NOT_FOUND` 屬既有 `ErrorCode` 聯集，**不新增 `ErrorCode`**，AC-35 仍成立）。
  > **判定語意（須明示，避免 reviewer 誤判為授權回歸）**：route 已不存在，故 `requireAuth`／`requirePasswordChanged`／`requireAdmin` 三道 preHandler **不執行**；**管理員／一般使用者／未登入三種身分皆為 404**（無授權判定，亦無資源可洩漏）。測試須逐一涵蓋此三種身分。
- **(b) 零寫入證明** — Then 上述三種身分之請求前後，`FuelParameterVersion` 之**列數與最大 `createdAt` 全等**；**不得**因 404 路徑而建立任何列。
- **(c) 讀取端點 200 唯讀保留** — When 管理員呼叫 `GET /parameters/fuel`。Then **200**，回傳既有 `FuelParameterVersion` 版本清單，DTO 形狀與 `effectiveFrom` 排序與 PHASE-003a AC-19 **逐字相同**；**授權鏈完全不變**（`requireAuth` → `requirePasswordChanged` → `requireAdmin`），故未登入 → 401、`mustChangePassword=true` → 403 `PASSWORD_CHANGE_REQUIRED`、一般使用者 → 403 `FORBIDDEN` 三格行為與 PHASE-003a 既有測試逐字相同（該三條既有 it 為本項之現成證據，**不得**改動）。
- **(d) 不變式** — 本 AC **不觸及** `FuelParameterVersion` 之 schema、既有列、`fuelParameterVersionId` 之歷史引用，亦不觸及 `/parameters/etc`／`/parameters/depreciation` 之任何行為（AC-27／§8.5 之「零回填、零改寫」仍成立）。

**(e) 受影響之既有測試逐檔清單（以 `grep` 實查為準；處置一律為「依 Spec 更新斷言」，非弱化）**

> **本表之窮盡性基礎（REV2 重查；REV1 因搜尋結果被截斷於前 100 筆而漏列 `phase3a-parameter-audit.test.ts`，導致 T3b BLOCKED）。本表據以下三道指令之**完整未截斷**輸出建立：**
> ```
> grep -rn "/parameters/fuel" backend/src backend/test e2e frontend/src frontend/test | grep -v "fuel-price"
> grep -rnE "apiCreateFuelVersion|apiGetFuelVersions|postFuel" backend/src backend/test e2e frontend/src frontend/test
> grep -rn 'url: "/parameters' backend/test        # 交叉核對：確認無其他檔案以 HTTP 打參數端點
> ```
> 命中共 **61 行／11 檔**（第一道）＋ **40 行／3 檔**（第二道）。第三道確認 `url: "/parameters` 僅出現於 5 個測試檔，其中 `phase3a-parameter-depreciation.test.ts`（33 行）與 `phase5a-fuel-price.test.ts`（29 行）**零命中** `/parameters/fuel`。**下表窮盡涵蓋全部命中，含「不受影響」列與其理由；表外無任何遺漏。**

| 檔案 | 受影響位置（實查） | 處置 |
|---|---|---|
| `backend/test/integration/phase3a-parameter-fuel-etc.test.ts` | `describeWithDb("POST /parameters/fuel")`（L168）之 **10 條 it**：AC-01（L198）、AC-01 boundary（L218）、AC-03（L231）、AC-06 缺 `effectiveFrom`（L247）、AC-06 非法日期（L262）、AC-07 重疊（L277）、AC-09 相鄰日（L308）、AC-16 USER 403（L329）、AC-17 未登入 401（L341）、`mustChangePassword` 403（L352） | **就地改寫為 AC-37(a)(b) 之 404／零寫入斷言**（不刪檔、不刪 describe）。該批對「油資寫入」之契約覆蓋由 PHASE-005a **AC-01／02／03／05／06**（`/parameters/fuel-price`，§12 已 `GREEN`）承接；`/parameters/etc` 之同型 it 全數保留不動。 |
| 同上 | `describeWithDb("GET /parameters/fuel")`（L368）之 AC-19（L398）以 `POST /parameters/fuel` **播種**兩列 | 播種改為 `prisma.fuelParameterVersion.create`（直寫，繞過已移除之端點）；**GET 之斷言逐字不變**（AC-37(c) 之主要證據）。 |
| 同上 | 同 describe 之 AC-16（L448）／AC-17（L459）／`mustChangePassword`（L469）三條**純 GET** it | **零改動**（AC-37(c) 授權鏈不變之現成證據）。 |
| 同上 | `describeWithDb("Concurrent defense…")`（L747）之「two sequential requests with same fuel date」（L773） | 移轉至 `/parameters/fuel-price`（同語意已由 AC-02 之並發 it 覆蓋，`GREEN`）或改直寫播種；**ETC 之同型 it（L798）不動**。 |
| 同上 | `describeWithDb("Precision: unitPrice Decimal round-trip")`（L827）之 L851／L863 兩條（皆以 POST 播種） | 播種改直寫或移轉至 `/parameters/fuel-price`；精度斷言逐字保留。 |
| `backend/test/integration/phase3a-parameter-audit.test.ts`（**REV2 補列——REV1 漏檔，T3b BLOCKED 之直接原因**） | `describeWithDb("POST /parameters/fuel → AuditLog (AC-18)")`（L156）之 **5 條 it／6 處 `url` 命中**：成功建立→稽核列（L180，url L184）、稽核不含敏感鍵（L212，url L216）、非管理員 403 →零稽核列（L241，url L249）、未登入 401 →零稽核列（L261，url L269）、重疊 409 原子性→零新增稽核列（L281，url L285＋L298 兩次 POST） | **移轉至 `POST /parameters/fuel-price`（不改寫為 404）**。理由：此 5 條為 PHASE-003a AC-18 之**稽核契約**覆蓋，改寫為 404 將使該契約在新端點**零覆蓋**；而 `phase5a-fuel-price.test.ts:775` 目前**僅有成功路徑一條**（實查：只斷言 `action`／`parameterType`／單列），**缺**敏感鍵掃描、403／401 零稽核列、409 原子性四項 —— 故移轉為**淨增覆蓋**，非重複。<br>**逐項對應**（T3 已落地之稽核形狀，`routes.ts:236-250` 實查）：payload `{ unitPrice, effectiveFrom }` → `{ fuelType: "GASOLINE_95", pricePerLiter, effectiveFrom }`；`targetLabel` `FUEL#<id>` → `FUEL_PRICE#<id>`；`summary.parameterType` `"FUEL"` → `"FUEL_PRICE"`；`summary.unitPrice` → `summary.pricePerLiter`；`action` **仍為 `PARAMETER_VERSION_CREATED`（不變）**。409 原子性之第二次 POST 須用**同一 `fuelType` ＋ 同一 `effectiveFrom`**（新表唯一鍵為 `[fuelType, effectiveFrom]`）。稽核計數之 `where` 範圍（`actorId` ＋ `action`）**維持原樣不動**，避免與同檔 ETC／折舊 describe 之計數語意分歧。 |
| 同上 | 同檔之 `POST /parameters/etc → AuditLog`（L316 起）與折舊 describe | **零改動**（`/parameters/etc`、`/parameters/depreciation` 不在 D1(a) 範圍）。 |
| `backend/test/integration/chore003-parameter-field-capacity.test.ts` | helper `postFuel`（L151-158）＋ **34 處呼叫**，散佈於 AC-21／AC-23／AC-25／AC-26／AC-27／AC-30／AC-31／AC-32 各 describe | **`postFuel` 改指 `POST /parameters/fuel-price`**：payload 由 `{ unitPrice, effectiveFrom }` 改為 `{ fuelType: "GASOLINE_95", pricePerLiter: <原值>, effectiveFrom }`；期望 `fields[].field` 由 `unitPrice` 改為 `pricePerLiter`。**狀態碼與 `reason` 文案逐字不變**——兩端點共用 `parseParameterDecimalField` ＋ `UNIT_PRICE_CAPACITY`，值域層文案同為「單價不得小於 0」（`fuel-price-service.ts:158-160` 實查證實）。`afterAll` 之清理（L133 `prisma.fuelParameterVersion.deleteMany`）須同步改為 `fuelPriceVersion`。ETC／折舊路徑之 it **全數不動**。 |
| 同上 | **唯一文案例外**：「`unitPrice` 缺欄位／`null`／`''` → 400『單價為必填』」（L570-579） | 「單價為必填」由**舊 route 之就地必填檢查**產生（`backend/src/parameters/routes.ts:156-160`），`/parameters/fuel-price` 無此分支，缺／`null`／`''` 一律走 `parseParameterDecimalField`。故該 it 之期望 `reason` **依已批准之 AC-06 文案更新**；**嚴禁**為了讓舊斷言通過而在新端點加回「單價為必填」分支（那將是以實作遷就過時測試）。 |
| `e2e/travel-application.spec.ts`（L77 GET／L91 POST）、`e2e/admin-applications.spec.ts`（L65／L78）、`e2e/mileage-statistics.spec.ts`（L86／L99） | 三個 helper 皆為 **`if (!covers(fuelVersions))` 守衛後才 POST**（實查確認）。dev／Gate DB 既有油資列（`PROJECT_STATE`：5.0000／2026-01-01 生效）使 `covers` 恆為 `true`，故 **T3b 落地當下不會使 e2e 轉紅**。 | **不屬 T3b**。三檔之播種改寫與 D1(a) 附款「Gate 環境之舊油資參數列由人類以新模型重建」合併處理，落點 **T13**（E2E）。列此僅為排程可追溯。 |
| `frontend/src/api/parameters.ts`（L26 GET／L36 POST）、`frontend/test/ParametersPage.test.tsx`（L614 mock） | `apiCreateFuelVersion` 在 T3b 後即為 404 死路徑 | **不屬 T3b**，由 **T9**（AC-29）承接：油資區塊改指 `/parameters/fuel-price`，並移除／改寫 `apiCreateFuelVersion`。**T9 附帶必辦**：`ParametersPage.test.tsx:614` 之 mock 條件 `url.includes("/api/parameters/fuel")` 會**同時命中** `/api/parameters/fuel-price`，須收斂為精確比對，否則新舊端點之 mock 無法區辨。另 `frontend/src/pages/ParametersPage.tsx` L17／L20／L82／L108 為該二函式之唯一呼叫端，一併由 T9 承接。 |
| **【不受影響】** `backend/test/integration/chore002-d4-decimal-number.test.ts`（L145／150／181／196）、`chore003-string-fidelity.test.ts`（L272／277／294／299／309／314）、`phase3a-parameter-model.test.ts`（L77／91／162…）、`phase4-*.test.ts`、`phase5-mileage-engine.test.ts`、`phase5a-migration-safety.test.ts`、`backend/test/integration/_param-version-floor-date.ts` | 實查確認：**皆直呼 service 函式 `createFuelVersion(prisma, …)` 或 `prisma.fuelParameterVersion.*`，零 HTTP**（`url: "/parameters` 於這些檔案零命中） | **零改動。****由此導出 T3b 之硬性約束：只得移除 `backend/src/parameters/routes.ts` 之 POST route 註冊，`backend/src/parameters/parameter-service.ts` 之 `createFuelVersion`／`listFuelVersions` 與 `FuelParameterVersion` model 一律保留**（`GET` 端點與上列測試皆依賴之）。若誤刪 service 函式，上列約 27 處呼叫將全紅——此為 D1(a)「保留表」之直接要求。 |
| **【不受影響】** `backend/src/server.ts:80`、`backend/src/parameters/routes.ts` L5／L6／L59 | 純註解字串 | 可順手更新註解文字（非必要）；**不得**因此改動任何行為。 |
| **【不受影響】** `backend/test/integration/phase3a-parameter-depreciation.test.ts`（33 處 `url: "/parameters`）、`backend/test/integration/phase5a-fuel-price.test.ts`（29 處） | 交叉核對確認**零命中** `/parameters/fuel` | **零改動。** |

> **AC 總數：37**

---

## 3. 正常流程

### 3.1 管理員維護油價（AD-US-11）

1. 管理員登入 → 參數維護頁 → 油資區塊。
2. 選油種（92／95／98／柴油）、輸入每公升油價、生效日期 → 送出。
3. 後端：`requireAuth` → `requirePasswordChanged` → `requireAdmin` → 欄位格式層 → 值域層 → 交易內 `findMany(該油種全部版本)` → `checkNoOverlap` → `create` → `AuditLog`（`PARAMETER_VERSION_CREATED`，`summary.parameterType = "FUEL_PRICE"`，含 `fuelType`）→ commit。
4. 前端刷新該油種版本列表。

### 3.2 管理員維護使用者油耗（AD-US-15）

1. 管理員 → 使用者清單 → 選定使用者 → 油耗維護頁（落點見 §16 **D9**）。
2. 輸入油種、油耗（km/L）、生效日期、**依據備註（必填）** → 送出。
3. 後端：認證 → 強制改密 → `requireAdmin` → `userId` 存在性 → 欄位格式層／值域層 → `basisNote` 必填與長度 → 交易內 `findMany(該使用者全部版本)` → `checkNoOverlap` → `create` → 計算 `before`（新版本生效日前一日之有效版本）→ `AuditLog`（`USER_FUEL_CONSUMPTION_VERSION_CREATED`）→ commit。
4. 前端刷新版本列表（`state` 由後端標示）。

### 3.3 一般使用者檢視自身油耗（FE-US-28）

1. 使用者登入 → 個人頁面之「車輛油耗資料」區塊（落點見 §16 **D9**）。
2. 前端呼叫自身唯讀端點 → 顯示目前生效之油種／油耗／生效日，或空白狀態。
3. 畫面固定顯示「如與實際車輛不符，請聯絡管理員核對後更新」，且無任何寫入入口。

### 3.4 差旅預覽（FE-US-10、BE-US-32）

1. 使用者填出差日期與各段里程 → 前端呼叫 `POST /applications/travel/preview`（含 `tripDate`、`segments`，代操作時另含 `ownerId`，見 §16 **D6**）。
2. 後端：認證 → `resolveOwnerId`（代操作授權）→ `resolveTravelParameters(db, tripDate, ownerId)`：
   - `findMany(該使用者全部油耗版本)` → `findEffectiveVersion(tripDate)` → 得 `{ fuelType, kmPerLiter, versionId }` 或 `null`
   - 若得油耗：`findMany(該 fuelType 全部油價版本)` → `findEffectiveVersion(tripDate)` → 得 `pricePerLiter` 或 `null`
   - 若油耗為 `null`：**油種未知**，`missing = [FUEL_CONSUMPTION]`（**不**同時回報油價缺項，見 §5 B-05）
   - `deriveFuelUnitPrice(pricePerLiter, kmPerLiter)` → 取整後單價（缺任一則以 `Decimal("0")` 佔位，沿用 `formatTravelComputed` 既有慣例）
3. `calculateTravel` 計算段／整筆金額 → 回 `computed`（`parameterAvailable`／`missingParameters`／金額；**不含單價**，沿用 PHASE-004 D6(c)）。

### 3.5 差旅完成（BE-US-32、BE-US-18）

1. `POST /applications/:id/complete`（body 一律忽略，AC-24）。
2. 交易內：狀態機守門 → `computeCompletionBlockers`（含油耗／油價缺項）→ `resolveTravelParameters(tx, tripDate, application.ownerId)` → `assertParametersAvailable` → 若 `missing` 非空拋 **409** 並於 `details.missing` 區分缺項 → 推導單價（含 AC-20 容量守門）→ `calculateTravel` → 寫入段快照 → 寫入 `TravelApplication` 快照（含新增五欄）→ 更新 `Application.status = COMPLETED`。
3. 回傳含 `snapshot` 之 DTO。

---

## 4. 五態（Loading / Empty / Error / Success / Permission denied）

| 畫面 | Loading | Empty | Error | Success | Permission denied |
|---|---|---|---|---|---|
| 油價維護（AC-29） | 「載入中…」，送出鈕停用防重複提交 | 該油種尚無版本 → 「尚未建立此油種的油價版本」 | 400 就地標示欄位（`fields[].field`）；409 顯示衝突版本生效日；5xx 顯示 zh-TW 錯誤＋重試 | 新版本出現於列表頂／對應位置 | 非管理員：頁面顯示「僅管理員可使用」，且不呼叫寫入 API |
| 油耗維護（AC-30） | 同上 | 該使用者尚無版本 → 「此使用者尚未建立油耗資料」 | 400 就地標示（含 `basisNote`）；404 使用者不存在；409 重疊 | 版本列表更新，`state` 標示 | 同上 |
| 個人油耗檢視（AC-31） | 「載入中…」 | 「尚未建立車輛油耗資料，請聯絡管理員建立」 | 5xx zh-TW 錯誤＋重試 | 顯示油種／油耗／生效日 | 401 → 導向登入（沿用既有 `parseApiResponse` 慣例） |
| 差旅表單／預覽（AC-32） | 預覽計算中 | 無行程段 → 不顯示金額區 | 缺油耗／缺油價 → **兩則互異提示**；預覽顯示「油資無法計算」 | 顯示各段與整筆金額（後端為準） | 代操作未選使用者 → 既有 PHASE-004 行為 |

---

## 5. 邊界條件

| # | 情境 | 期望行為 |
|---|---|---|
| **B-01** | `pricePerLiter = 0` | 合法（AD-US-11「大於或等於 0」）。推導單價 ＝ 0，段油資 ＝ 0，**可完成**（不視為缺參數）。 |
| **B-02** | 推導商 < 0.5（例 `1 ÷ 3`） | 單價取整為 **0**，段油資 ＝ 0，**可完成**。此為合法結果，非錯誤。 |
| **B-03** | 推導商恰為 `x.5` | 進位（`45 ÷ 10 = 4.5 → 5`）。**非**銀行家取整。 |
| **B-04** | `kmPerLiter` 極小（`0.0001`）＋ 油價極大 | 推導單價可能 ≥ 1e6 → 依 **D4** 處置（AC-20）；**絕不** 500、絕不截斷。 |
| **B-05** | 缺油耗（油種未知）且所有油種皆無油價版本 | `missing` **僅含** `FUEL_CONSUMPTION`。理由：油種未知時「該油種是否有油價」無定義，回報油價缺項會產生誤導性提示。 |
| **B-06** | 有油耗、其油種缺油價，其他三油種皆有油價 | `missing` 含油價缺項（AC-22 鑑別力）。 |
| **B-07** | `tripDate = null`（草稿未填日期） | 沿用 PHASE-004：**不查 DB**，`missing` 含全部三類（油耗／油價／ETC）；草稿可存。 |
| **B-08** | 出差日期早於該使用者最早油耗版本之生效日 | 視為缺油耗（`findEffectiveVersion` 回 `null`）。 |
| **B-09** | 使用者有油耗版本但油種欄位對應之油價版本**恰在出差當日生效** | 含當日 → 取得該版本（`findEffectiveVersion` 之 `≤` 語意）。 |
| **B-10** | 同一使用者同一日兩個並發建立請求 | 一成功、一 **409**（DB `@@unique([userId, effectiveFrom])` 最後防線）；**不得** 500、不得兩列並存。 |
| **B-11** | 陣列型／重複 query 鍵（`?userId=a&userId=b`） | **400 `VALIDATION_ERROR`**，比照 PHASE-005 T6 之 `assertScalarQueryParams` 結構收斂；**絕不** 500。（PROJECT_STATE 追蹤項：PHASE-004 兩處同型風險尚未修，本 Phase 新端點不得複製該缺陷。） |
| **B-12** | 管理員為**已停用**使用者建立油耗版本 | 允許（停用不代表歷史資料不可維護）；但該使用者無法登入，故其唯讀端點不可達。**列為 D8 之附帶確認項**。 |
| **B-13** | `basisNote` 含前後空白 | `trim()` 後判定非空（沿用 PHASE-003a CD-1(a)）；儲存值為 trim 後之字串。 |
| **B-14** | 已完成差旅之擁有人其後**新增更早生效**之油耗版本 | 歷史快照逐位元不變（AC-26）。 |
| **B-15** | 油價版本已被已完成差旅引用 | 依 §16 **D11** 定案；本 Phase 為 append-only，無覆寫路徑，故不變式自然成立。 |
| **B-16** | 舊模型已完成申請（新五欄為 NULL） | DTO 之 `snapshot` 仍非 null；新欄位以 `null` 呈現；**不得**因此拋錯或顯示 `NaN`（AC-27）。 |
| **B-17** | `effectiveFrom` 非法（`2026-13-01`／`2026/01/01`／`""`） | 400，`fields[].field === "effectiveFrom"`（沿用 `parseUtcDate`）。 |
| **B-18** | 一般使用者以 `POST` 打管理端點且 body 完全畸形 | 判定順序：認證 → 改密 → 授權 → 驗證，故回 **403**（非 400）；無側信道。 |

---

## 6. 權限與敏感資料

### 6.1 授權權威

- **後端 `requireAdmin` 為唯一權威**（沿用 PHASE-003a §4.5 D10）。前端隱藏入口僅為 UX，**不得**作為安全前提。
- 油耗**寫入**端點：`requireAuth` → `requirePasswordChanged` → `requireAdmin`。
- 油耗**管理讀取**端點（他人完整版本清單）：同上三道。
- **自身唯讀端點**：`requireAuth` → `requirePasswordChanged`；**擁有人恆為 `request.currentUser.id`**，不接受任何身分參數（AC-17）。
- 油價端點：三道，與既有 `/parameters/*` 完全一致。
- 差旅預覽之 `ownerId`：沿用 `application-query.ts:resolveOwnerId`（一般使用者指定他人 → **403，不靜默降級**），見 §16 **D6**。

### 6.2 資料隔離不變式

1. 一般使用者**永遠**無法取得他人之 `fuelType`／`kmPerLiter`／`basisNote`／版本清單。
2. 代操作之計算來源恆為 `Application.ownerId`，**永不**為 `request.currentUser.id`（AC-23）。
3. 所有回應之鍵集合為**封閉白名單**，新增欄位須改 Spec（Q10 落實）。

### 6.3 敏感資料

- `basisNote` 為管理員輸入之自由文字，可能含人工核對紀錄。**限管理員可見**（Q5）；**不得**出現在一般使用者端點回應、不得寫入應用層日誌（僅入 `AuditLog.summary`，屬受控稽核儲存）。
- 稽核 `summary` **絕不**含密碼、token、session cookie（CLAUDE.md）。

---

## 7. API Contract

> **端點路徑與形狀為公開 API contract，須人類批准** —— 見 §16 **D1／D7**。以下為**推薦形狀**。

### 7.1 油價參數（管理員）

```
POST /parameters/fuel-price
  body: { fuelType: FuelType, pricePerLiter: string|number, effectiveFrom: "YYYY-MM-DD" }
  201  { version: FuelPriceVersionDto }
  400 VALIDATION_ERROR | 401 | 403 | 409 PARAMETER_PERIOD_OVERLAP

GET  /parameters/fuel-price[?fuelType=<FuelType>]
  200  { versions: FuelPriceVersionDto[] }   // 依 (fuelType, effectiveFrom) 升冪；未帶 fuelType 回全部
  400（fuelType 非列舉值）| 401 | 403
```

```ts
interface FuelPriceVersionDto {
  id: string;
  fuelType: "GASOLINE_92" | "GASOLINE_95" | "GASOLINE_98" | "DIESEL";
  pricePerLiter: string;      // toFixed(4)，Decimal(10,4)
  effectiveFrom: string;      // YYYY-MM-DD
  createdAt: string;          // ISO
}
```

#### 7.1.1 舊油資端點之凍結後合約（§16 **D1(a)** 已批准；落點 T3b、AC-37）

```
POST /parameters/fuel
  404 NOT_FOUND   { error: { code: "NOT_FOUND", message: "找不到請求的資源。", requestId } }
  // route 移除 → preHandler 鏈不執行 → 管理員／一般使用者／未登入皆為 404
  // 零寫入：FuelParameterVersion 不得因此路徑新增任何列

GET  /parameters/fuel
  200  { versions: FuelParameterDto[] }   // 唯讀保留；DTO 形狀、排序、授權鏈與 PHASE-003a 完全不變
  401 | 403 PASSWORD_CHANGE_REQUIRED | 403 FORBIDDEN
```

> **凍結後之唯一寫入入口為 `POST /parameters/fuel-price`（§7.1）。** `FuelParameterVersion` 表、既有列與 `TravelApplication.fuelParameterVersionId` 之歷史引用一律保留不動（§8.5、AC-27）。保留 `GET` 之目的：稽核追溯與 PHASE-008 舊模型快照之參數來源顯示（D1(a) 原文）。

### 7.2 使用者車輛油耗（管理員）

```
POST /users/:userId/fuel-consumption
  body: { fuelType: FuelType, kmPerLiter: string|number, effectiveFrom: "YYYY-MM-DD", basisNote: string }
  201  { version: FuelConsumptionVersionDto }
  400 | 401 | 403 | 404 NOT_FOUND（userId 不存在）| 409 PARAMETER_PERIOD_OVERLAP

GET  /users/:userId/fuel-consumption
  200  { versions: FuelConsumptionVersionDto[] }   // effectiveFrom 升冪；空陣列合法
  401 | 403 | 404
```

```ts
interface FuelConsumptionVersionDto {
  id: string;
  userId: string;
  fuelType: FuelType;
  kmPerLiter: string;         // toFixed(4)
  effectiveFrom: string;      // YYYY-MM-DD
  basisNote: string;
  state: "HISTORICAL" | "CURRENT" | "FUTURE";  // 後端相對查詢當日判定（AC-12）
  createdAt: string;
  createdById: string;
}
```

### 7.3 自身唯讀（一般使用者與管理員皆可）

```
GET /me/fuel-consumption
  200  { current: { fuelType, kmPerLiter, effectiveFrom } | null }
  401 | 403 PASSWORD_CHANGE_REQUIRED
```
> **鍵集合封閉**：`current` 非 null 時**恰有三鍵**；不得含 `id`／`basisNote`／`createdById`／`state`。

### 7.4 差旅預覽／完成之變更

```
POST /applications/travel/preview
  body: { tripDate?, segments[], ownerId? }      // ownerId 為新增（見 D6）
  200  { preview: TravelComputedDto }            // 形狀不變，missingParameters 值域擴充（見 D5）
  400 | 401 | 403（一般使用者指定他人 ownerId）

POST /applications/:id/complete
  409 PARAMETER_NOT_AVAILABLE
    details: { missing: MissingParameter[], tripDate: "YYYY-MM-DD" | null }
```

```ts
// 現行： type MissingParameter = "FUEL" | "ETC";
// 修訂： 見 §16 D5（推薦 "FUEL_PRICE" | "FUEL_CONSUMPTION" | "ETC"）
interface TravelComputedDto {
  parameterAvailable: boolean;
  missingParameters: MissingParameter[];
  totalKm: string;
  segments: TravelComputedSegmentDto[];
  totalRawAmount: string;
  totalAmount: number;
  // D6(c) 不變：草稿／預覽恆不含單價
}

interface TravelSnapshotDto {           // 僅 COMPLETED
  fuelType: FuelType | null;            // 新增；舊模型列為 null
  fuelPricePerLiter: string | null;     // 新增；toFixed(4)
  fuelConsumption: string | null;       // 新增；toFixed(4)
  fuelUnitPrice: string;                // 既有；推導取整後之每公里單價
  etcUnitPrice: string;
  fuelPriceVersionId: string | null;    // 新增
  fuelConsumptionVersionId: string | null; // 新增
  fuelParameterVersionId: string | null;   // 既有；新模型為 null（判別欄位，見 §8.4）
  etcParameterVersionId: string;
  totalKm: string;
  totalRawAmount: string;
  totalAmount: number;
  calculatedAt: string;
}
```

### 7.5 錯誤合約（沿用 PHASE-003a §14.2 之分層與文案表）

| 情境 | 狀態 | code | `fields[].field` |
|---|---|---|---|
| 油種非列舉值／缺漏 | 400 | `VALIDATION_ERROR` | `fuelType` |
| 油價格式層四道任一 | 400 | `VALIDATION_ERROR` | `pricePerLiter` |
| 油價 < 0 | 400 | `VALIDATION_ERROR` | `pricePerLiter` |
| 油耗格式層四道任一 | 400 | `VALIDATION_ERROR` | `kmPerLiter` |
| 油耗 ≤ 0 | 400 | `VALIDATION_ERROR` | `kmPerLiter` |
| 依據備註空／全空白／超長 | 400 | `VALIDATION_ERROR` | `basisNote` |
| `effectiveFrom` 非法 | 400 | `VALIDATION_ERROR` | `effectiveFrom` |
| 重複／陣列型 query 鍵 | 400 | `VALIDATION_ERROR` | 對應鍵名 |
| 未登入 | 401 | `UNAUTHORIZED` | — |
| 強制改密 | 403 | `PASSWORD_CHANGE_REQUIRED` | — |
| 非管理員 | 403 | `FORBIDDEN` | — |
| `userId` 不存在 | 404 | `NOT_FOUND` | — |
| 同油種／同使用者生效日重疊 | 409 | `PARAMETER_PERIOD_OVERLAP` | — （`details.conflictVersion`） |
| 完成時缺油耗／缺油價／缺 ETC | 409 | `PARAMETER_NOT_AVAILABLE` | — （`details.missing`） |
| 推導單價超出欄位容量 | 依 **D4** | 依 **D4** | 依 **D4** |

---

## 8. 資料模型與 migration

### 8.1 新增 enum

```prisma
enum FuelType {
  GASOLINE_92
  GASOLINE_95
  GASOLINE_98
  DIESEL
}
```
> 固定四項（Q4），**不提供自訂**。zh-TW 標籤由前端映射，不入 DB。儲存型別見 §16 **D2**。

`AuditAction` 追加一值：`USER_FUEL_CONSUMPTION_VERSION_CREATED`。

### 8.2 新增資料表

```prisma
/// PHASE-005a：按油種之每公升油價版本。取代 FuelParameterVersion 之油資角色（D1）。
model FuelPriceVersion {
  id            String   @id @default(cuid())
  fuelType      FuelType
  pricePerLiter Decimal  @db.Decimal(10, 4)   // 元／公升，≥0；沿用 UNIT_PRICE_CAPACITY
  effectiveFrom DateTime @db.Date             // 日粒度，含當日
  createdById   String                        // 建立之管理員 id（無 FK，沿用 003a 慣例）
  createdAt     DateTime @default(now())

  @@unique([fuelType, effectiveFrom])         // Q1：每油種各自一條時間軸；併發最後防線
  @@index([fuelType, effectiveFrom])
}

/// PHASE-005a：按使用者之車輛油種與油耗版本。僅管理員可寫（AD-US-15）。
model UserFuelConsumptionVersion {
  id            String   @id @default(cuid())
  userId        String
  user          User     @relation("UserFuelConsumption", fields: [userId], references: [id], onDelete: Restrict)
  fuelType      FuelType
  kmPerLiter    Decimal  @db.Decimal(10, 4)   // km/L，>0（容量見 D3(b)）
  effectiveFrom DateTime @db.Date
  basisNote     String                        // 必填核對依據（Q6；長度上限見 D3(c)）
  createdById   String                        // 操作管理員 id
  createdAt     DateTime @default(now())

  @@unique([userId, effectiveFrom])           // 同使用者不重疊；跨使用者互不干涉
  @@index([userId, effectiveFrom])
}
```

> `onDelete: Restrict`：AD-US-04「有歷史資料之帳號拒絕永久刪除」之既有語意延伸——油耗版本屬該使用者之歷史資料。**須同步確認 `users` 刪除守門（`backend/src/users/history.ts:userHasHistory`）納入本表**，否則刪除路徑會撞 FK 錯誤回 500。列為 T1 之 Done When。

### 8.3 既有表之擴充（**全部 nullable，零回填**）

```prisma
model TravelApplication {
  // ── 既有欄位一律不動 ──
  // fuelUnitPrice Decimal? @db.Decimal(10,4)      ← 語意由「參數表直讀單價」變為「推導取整後單價」
  // fuelParameterVersionId String?                ← 舊模型引用；新模型恆為 null（判別欄位）

  // ── PHASE-005a 新增（全部 nullable，無 default，不回填）──
  snapshotFuelType          FuelType?
  snapshotFuelPricePerLiter Decimal?  @db.Decimal(10, 4)
  snapshotFuelConsumption   Decimal?  @db.Decimal(10, 4)
  fuelPriceVersionId        String?
  fuelConsumptionVersionId  String?

  @@index([fuelPriceVersionId])
  @@index([fuelConsumptionVersionId])
}
```

### 8.4 新舊模型之判別（不可省略）

- **舊模型列**：`fuelParameterVersionId != null` 且 `fuelPriceVersionId == null`。
- **新模型列**：`fuelPriceVersionId != null` 且 `fuelConsumptionVersionId != null`。
- 完成流程**只寫新模型欄位**，`fuelParameterVersionId` 保持 `null`。
- `reference-guard.ts:parameterHasReferences` 之處置見 §16 **D11**。

### 8.5 既有 `FuelParameterVersion` 與 `/parameters/fuel` 之處置

**明確不做資料換算**：舊列之 `unitPrice` 語意為「每公里單價」（元／km），新模型為「每公升油價」（元／L），**量綱不同**，任何自動換算都須臆造油耗值 → 違反「不臆造」規則。三個處置選項見 §16 **D1**。

### 8.6 migration 順序、可逆性與 rollback

| # | 內容 | 可逆性 |
|---|---|---|
| M1 | `CREATE TYPE "FuelType"` | `DROP TYPE`（僅在 M2/M3 已回滾時） |
| M2 | `CREATE TABLE "FuelPriceVersion"`＋唯一索引 | `DROP TABLE`（**可逆**；本 Phase 前無任何列） |
| M3 | `CREATE TABLE "UserFuelConsumptionVersion"`＋唯一索引＋FK | `DROP TABLE`（**可逆**） |
| M4 | `ALTER TABLE "TravelApplication" ADD COLUMN ×5`（皆 NULL）＋2 索引 | `DROP COLUMN`（**可逆且不損既有資料**——新欄位在回滾前僅由本 Phase 之新完成申請寫入） |
| M5 | `ALTER TYPE "AuditAction" ADD VALUE 'USER_FUEL_CONSUMPTION_VERSION_CREATED'` | **PostgreSQL 不支援移除 enum 值**；回滾須重建型別。視為 **forward-only**，惟其為純新增且無既有資料使用該值，**回滾時保留該未使用值為無害**（明示於 rollback 手冊，見 §14）。 |

**硬性要求（Packet Done When 2）**：M1~M5 **全部為新增**，**不含任何 `UPDATE`／`DELETE`／欄位型別變更／NOT NULL 加設**。既有 `Application`／`TravelApplication`／`TripSegment`／`FuelParameterVersion`／`EtcParameterVersion` 之**任何既有欄位值零改寫**——由 AC-27 之 migration 前後欄位值比對測試機械證明。

**注意（實作提醒，非 AC）**：`ALTER TYPE ... ADD VALUE` 在 PostgreSQL 中新增之列舉值**不可於同一交易內使用**；Prisma migration 若將 M5 與使用該值之操作放同一檔會失敗。M5 應為**獨立 migration 檔**。

---

## 9. Data Flow（本 Phase 影響部分）

### 9.1 建立油耗版本（寫入路徑）

```
Admin UI ──POST /users/:userId/fuel-consumption──▶ routes（認證→改密→requireAdmin）
   │                                                    │
   │                                            userId 存在性檢查（404）
   │                                                    │
   │                              parseParameterDecimalField(kmPerLiter, CAPACITY)  ← 複用 003a
   │                              basisNote 必填/長度、fuelType 列舉、effectiveFrom 格式
   │                                                    │
   │                                        prisma.$transaction
   │                                          ├─ findMany(該 userId 全部版本)
   │                                          ├─ checkNoOverlap(existing, effectiveFrom)   ← 複用 003a 純函式
   │                                          ├─ create(UserFuelConsumptionVersion)
   │                                          ├─ before = findEffectiveVersion(existing, effectiveFrom−1d)
   │                                          └─ auditLog.create(USER_FUEL_CONSUMPTION_VERSION_CREATED)
   ◀────────────────── 201 { version }（P2002 → 409）
```

### 9.2 差旅單價解析（讀取路徑；預覽與完成共用）

```
resolveTravelParameters(db, tripDate, ownerId)
   │
   ├─ tripDate == null → missing = [FUEL_CONSUMPTION, FUEL_PRICE?, ETC]（見 B-07），不查 DB
   │
   ├─ findMany(UserFuelConsumptionVersion where userId = ownerId)     ← 全部版本，不在 DB 層過濾
   │     └─ findEffectiveVersion(versions, tripDate) → consumption | null
   │
   ├─ consumption == null → missing += FUEL_CONSUMPTION（油種未知，不查油價；B-05）
   │  consumption != null → findMany(FuelPriceVersion where fuelType = consumption.fuelType)
   │        └─ findEffectiveVersion(...) → price | null；null → missing += FUEL_PRICE
   │
   ├─ findMany(EtcParameterVersion) → findEffectiveVersion → etc | null；null → missing += ETC
   │
   └─ price && consumption → deriveFuelUnitPrice(price, consumption)   ← 純函式（AC-18、AC-20）
                                = ROUND_HALF_UP(price ÷ consumption, 0)
```

> **效能**：一次請求最多 3 次 `findMany`（油耗／油價／ETC），沿用 PHASE-004 §10.2「該類全部版本 findMany 後純函式選版」之既定作法，**不得**在 DB 層以 `effectiveFrom: { lte }` 先過濾（避免與 003a 日粒度語意分歧）。油價查詢**已由 `fuelType` 收斂**，非全表。

### 9.3 完成與快照寫入

```
complete（既有 Serializable 交易內，步驟順序不變）
  ② computeCompletionBlockers（missingParameters 值域擴充）
  ③ resolveTravelParameters(tx, tripDate, ownerId) → assertParametersAvailable（409，details.missing 區分）
  ③b deriveFuelUnitPrice 容量守門（AC-20 / D4）
  ④ calculateTravel({ segments, fuelUnitPrice: 推導取整後單價, etcUnitPrice })   ← 引擎零改動
  ⑤a 段快照（既有四欄，零改動）
  ⑤b TravelApplication 快照：既有欄位 ＋ snapshotFuelType / snapshotFuelPricePerLiter /
      snapshotFuelConsumption / fuelPriceVersionId / fuelConsumptionVersionId
  ⑤c Application.status = COMPLETED（最後寫入，不變）
```

---

## 10. 非功能需求

| 項目 | 要求 |
|---|---|
| **NFR-US-14 效能** | 油價查詢已由 `fuelType` 收斂；油耗查詢由 `userId` 收斂（皆有複合索引）。單次差旅解析最多 3 次 `findMany`，與 PHASE-004 現況（2 次）同量級。列表／詳情 2 秒目標不受影響。 |
| **NFR-US-16 結構化錯誤** | 統一錯誤形狀；不新增 `ErrorCode`（AC-35）；不外洩堆疊／SQL／絕對路徑（AC-34）。 |
| **NFR-US-27 響應式** | 375px 無水平溢位（AC-33）；寬表以 `.table-scroll` 內捲。 |
| **精度紀律（本 Phase 特別要求）** | 金額／油價／油耗全鏈 `Prisma.Decimal`；`Decimal` 一律以**字串**建構（D4 bright-line）；除法一律 `.div()` 而非 JS `/`；取整一律 `toDecimalPlaces(0, ROUND_HALF_UP)`。以 AC-28 結構性掃描守門。 |
| **可搬遷性** | 不新增任何依賴（Packet：Dependency Permission 無）。若實作認為必要，須回報為決策點，不得自行引入。 |
| **日誌安全** | 不記錄密碼／token／session cookie；`basisNote` 不入應用層日誌。 |

---

## 11. 測試策略

### 11.0 測試紀律（強制，寫入每個 Task Packet）

1. **TDD**：先寫會失敗的測試再實作；**不得**刪除、弱化、`skip` 既有測試換綠燈（CLAUDE.md）。
2. **金額語意類 Task（T2／T7／T8）之 Packet 必逐字引用本 Spec 之 AC 原文**（T8 教訓，PROJECT_STATE 慣例）。
3. **鑑別力自證**：每個金額／授權類 Task 之 Handoff 須附「刻意變異必紅」之實測證據（至少一個 mutant）。
4. **兩輪全綠**：後端整合測試須於同一 DB 連跑兩輪皆綠（INFRA-001 隔離已就緒）。
5. **基準線**：後端 1211 / 前端 137 / E2E 17（PHASE-005a 開工基準）。每 Task Handoff 須報實際增量。

### 11.1 單元（Vitest，不需 DB）

- `deriveFuelUnitPrice`：AC-18 之八列驗表逐條；銀行家取整 mutant（`ROUND_HALF_EVEN`）必紅；`0 ÷ C`、`P ÷ 極小 C`（AC-20）、`C ≤ 0` 之防禦性行為。
- 油種列舉守門純函式：四項通過、任何其他輸入拒絕。
- 版本 `state`（HISTORICAL/CURRENT/FUTURE）判定純函式：邊界為「當日」。
- 結構性掃描（AC-28）：本 Phase 新增 `src` 檔案之 `Number(`／`parseFloat` 白名單斷言。

### 11.2 整合（Vitest ＋ PostgreSQL ＋ 真實 route）

- 油價：AC-01~03、05、06（含四油種同生效日之完整組合）。
- 油耗：AC-07~11、B-10 並發（兩個並行 `POST` 恰一成功）。
- 授權矩陣 AC-36：15 必要格逐格；一般使用者寫入前後之 DB 列數／`updatedAt` 逐項比對（零寫入證明）。
- 稽核 AC-14：`before`／`after` 精確結構；密碼／token 不出現於 `summary`（序列化後字串掃描）。
- 自身唯讀 AC-15~17：逐鍵白名單；他人資料不可達。
- 解析與完成 AC-04、21~26：**必含**「他人有有效油耗」之對照組（AC-21 鑑別力）、「其他三油種皆有油價」之對照組（AC-22 鑑別力）、代操作互異單價（AC-23）。
- 快照可重現性 AC-25：由快照三來源值獨立重算並精確比對。
- migration 安全 AC-27：migration 前寫入舊模型列 → 套用 → 逐欄位值比對。
- 錯誤合約與日誌 AC-34／35：`logStream` 掃描（沿用 PHASE-005 T6 慣例）。
- 舊端點凍結 AC-37（T3b）：`POST /parameters/fuel` 三身分 404 ＋ 零寫入；`GET /parameters/fuel` 唯讀與授權鏈不變（既有三條授權 it 為現成證據，零改動）。受影響既有斷言之更新範圍以 AC-37(e) 逐檔清單為**封閉界線**，超出者須回報而非自行擴張。

### 11.3 前端（Vitest ＋ Testing Library，mock fetch）

- AC-29~32 五態；AC-32 之三情境文字**逐字互異**斷言。
- AC-31 ③：以「查詢所有 button/link 並斷言無新增／編輯／刪除語意元素」之負向斷言。
- 不自算鑑別力：mock 令後端回單價 `3`、金額 `46`，前端若自行以油價÷油耗計算必紅。

### 11.4 E2E（Playwright，整合 Gate）

1. 管理員建立四油種油價版本 → 版本列表按油種正確呈現。
2. 管理員為 staff01 建立油耗版本（含依據備註）→ 列表顯示 CURRENT。
3. staff01 登入 → 個人頁看到油種／油耗／生效日，且無編輯入口。
4. staff01 建差旅草稿 → **刪除其油耗版本前先建一筆缺油耗之情境**（以未建油耗之第二帳號）→ 完成被擋且提示為「建立油耗資料」。
5. staff01 完成差旅 → 金額等於以推導單價手算之值；報表區塊可見快照三來源值。
6. 375px 無水平溢位（三個畫面）。

### 11.5 安全測試

- 一般使用者對六個油耗端點／方法組合逐一 403，且 DB 零寫入。
- 偽造 cookie／停用帳號 → 401。
- 陣列型 query 鍵 → 400（B-11）。
- 回應原文掃描：不得含 `password`／`token`／絕對路徑／SQL 關鍵字。

---

## 12. AC ↔ 測試映射表（機械可查；隨 Task 完成更新「狀態」欄）

> **格式**：`AC` ｜ `層級` ｜ `測試檔（預定路徑）` ｜ `測試名（預定名稱）` ｜ `Task` ｜ `狀態`
> 狀態值：`PENDING`（Spec 階段）／`RED`（測試已寫且失敗）／`GREEN`（實作完成通過）。
> **Phase 完成前之覆蓋檢查與終審核對以本表為準**（治理 2026-08-02.1）。
> **`GREEN` 列之測試名須為實際存在之測試名（逐字可 `grep`）；`PENDING` 列為預定名稱。**

| AC | 層級 | 測試檔 | 測試名（預定） | Task | 狀態 |
|---|---|---|---|---|---|
| AC-01 | integration | `backend/test/integration/phase5a-fuel-price.test.ts` | `POST /parameters/fuel-price > AC-01 建立油價版本 > creates a version for each of the four fuel types (201, DTO shape key by key)` | T3 | GREEN |
| AC-02 | integration | `phase5a-fuel-price.test.ts` | `POST /parameters/fuel-price > AC-02 同油種重疊 > same fuelType + same effectiveFrom returns 409 with details.conflictVersion`；`… > a DIFFERENT fuelType with the same effectiveFrom is unaffected by the conflict above (cross-check AC-03)`；`… > concurrent duplicate create resolves to exactly one 201 and one 409 (never 500)` | T3 | GREEN |
| AC-03 | integration | `phase5a-fuel-price.test.ts` | `POST /parameters/fuel-price > AC-03 跨油種時間軸獨立 > all four fuel types may share the same effectiveFrom (201 each)`；`… > four concurrent effective versions coexist and are independently retrievable` | T3 | GREEN |
| AC-04 | integration | `backend/test/integration/phase5a-resolve.test.ts` | `AC-04 依出差日期取同油種有效版本 > four-point boundary (before / on / after effectiveFrom) selects the right version`；`… > DIESEL versions never affect the GASOLINE_95 result` | T7 | PENDING |
| AC-05 | integration | `phase5a-fuel-price.test.ts` | `POST /parameters/fuel-price > AC-05 油種列舉封閉 > fuelType=$label returns 400 locating fuelType (never 500)`（it.each 七列：GASOLINE_91／"98"／""／null／42／{}／[]）；`… > missing fuelType field returns 400 locating fuelType` | T3 | GREEN |
| AC-06 | integration | `phase5a-fuel-price.test.ts` | `POST /parameters/fuel-price > AC-06 油價欄位驗證（格式層四道＋值域） > ordered gate table: $label returns its own reason`（it.each 十七列）；`… > boundary positive: $label is accepted (201)`（it.each 三列：0／"999999.9999"／" 30.5 "） | T3 | GREEN |
| AC-07 | integration | `backend/test/integration/phase5a-fuel-consumption.test.ts` | `AC-07 管理員建立油耗版本 > admin creates a version for a target user (201, createdById = admin)`；`… > unknown userId returns 404 NOT_FOUND` | T4 | PENDING |
| AC-08 | integration | `phase5a-fuel-consumption.test.ts` | `AC-08 油耗必須大於 0 > 0 / "0" / -1 / "-0.0001" return 400 locating kmPerLiter`；`… > "0.0001" (smallest representable positive) is accepted` | T4 | PENDING |
| AC-09 | integration | `phase5a-fuel-consumption.test.ts` | `AC-09 依據備註必填 > missing / null / "" / all-whitespace basisNote returns 400 locating basisNote`；`… > over-length basisNote returns 400 locating basisNote` | T4 | PENDING |
| AC-10 | integration | `phase5a-fuel-consumption.test.ts` | `AC-10 同使用者重疊／跨使用者獨立 > same user + same effectiveFrom → 409 with conflictVersion`；`… > different user + same effectiveFrom → 201`；`… > concurrent duplicate resolves to exactly one 201 and one 409 (never 500)` | T4 | PENDING |
| AC-11 | integration | `phase5a-fuel-consumption.test.ts` | `AC-11 油耗欄位驗證 > ordered gate table mirrors the parameter contract, with "油耗必須大於 0" as the range-layer reason` | T4 | PENDING |
| AC-12 | integration | `backend/test/integration/phase5a-fuel-consumption-authz.test.ts` | `AC-12 版本清單 > returns HISTORICAL / CURRENT / FUTURE states relative to today, ascending by effectiveFrom`；`… > a user with no versions returns 200 with an empty array (not 404)` | T5 | PENDING |
| AC-13 | integration | `phase5a-fuel-consumption-authz.test.ts` | `AC-13 一般使用者不可寫 > normal user writing ANOTHER user's consumption → 403 and zero DB writes`；`… > normal user writing their OWN consumption → 403 and zero DB writes`；`… > 判定順序：malformed body as a normal user still returns 403, never 400 (no side channel)` | T5 | PENDING |
| AC-14 | integration | `phase5a-fuel-consumption-authz.test.ts` | `AC-14 稽核 > one AuditLog row per successful create, with actor / target / before / after / basisNote`；`… > before is null for the first version and the prior effective version otherwise`；`… > audit summary contains no password / token / cookie substring` | T5 | PENDING |
| AC-15 | integration | `backend/test/integration/phase5a-self-consumption.test.ts` | `AC-15 自身唯讀 > returns exactly { fuelType, kmPerLiter, effectiveFrom } for the current version (key-set equality)`；`… > never exposes basisNote / id / createdById / history` | T6 | PENDING |
| AC-16 | integration | `phase5a-self-consumption.test.ts` | `AC-16 空狀態 > user without any version returns 200 { current: null } (not 404)`；`… > only-future versions also yield current: null` | T6 | PENDING |
| AC-17 | integration | `phase5a-self-consumption.test.ts` | `AC-17 不得成為他人資料通道 > passing another userId via query / body / path never returns another user's data` | T6 | PENDING |
| AC-18 | unit | `backend/test/unit/fuel-price-engine.test.ts` | `deriveFuelUnitPrice — AC-18 rounds HALF_UP to an integer NTD per-km price (eight-row exact table)`（describe，含八列 it.each）；`… > 35 ÷ 10 and 45 ÷ 10 together discriminate HALF_UP from banker's rounding`；`… > accepts Prisma.Decimal instances as well as strings (identical result)`；`… > uses Decimal.div, never JS floating-point division (0.1+0.2-style precision retained)` | T2 | GREEN |
| AC-19 | integration | `backend/test/integration/phase5a-travel-complete.test.ts` | `AC-19 取整恰兩處 > segRaw = fuel + etc is rounded once (0.50km × 3 + 0.25km × 2.0000 → 2, not 3)`；`… > calculateTravel is reused verbatim — only the fuelUnitPrice source changed` | T8 | PENDING |
| AC-20 | unit + integration | `fuel-price-engine.test.ts`；`phase5a-travel-complete.test.ts` | 單元層（GREEN，T2）：`deriveFuelUnitPrice — AC-20 derived unit price at or beyond the column capacity is reported, never silently truncated`（describe，含恰 10^6 邊界、Spec 例、負值、never-throws、SF-1 非有限四條防禦測試）。整合層（PENDING，T8）：`AC-20 容量守門 > an overflowing price/consumption combination is rejected per D4, never 500` | T2, T8 | PENDING（T8 整合層待補；單元層 GREEN） |
| AC-21 | integration | `phase5a-resolve.test.ts` | `AC-21 缺油耗 > draft saves successfully with FUEL_CONSUMPTION blocker`；`… > complete returns 409 with details.missing containing the consumption code`；`… > another user's effective consumption value never appears in the result (no fallback)` | T7 | PENDING |
| AC-22 | integration | `phase5a-resolve.test.ts` | `AC-22 缺該油種油價 > the other three fuel types having prices does not satisfy the owner's fuel type`；`… > the 409 message differs verbatim from the missing-consumption message` | T7 | PENDING |
| AC-23 | integration | `phase5a-resolve.test.ts` | `AC-23 代操作 > admin acting on behalf resolves the OWNER's consumption, not the admin's (distinct derived prices 3 vs 5)` | T7 | PENDING |
| AC-24 | integration | `phase5a-travel-complete.test.ts` | `AC-24 後端權威 > body carrying fuelUnitPrice / pricePerLiter / kmPerLiter / totalAmount is ignored, response is the backend value`；`… > malformed injected fields never cause a 500` | T8 | PENDING |
| AC-25 | integration | `phase5a-travel-complete.test.ts` | `AC-25 快照七項＋版本 id > snapshot stores fuelType / pricePerLiter / consumption / derived unit price / etc / raw / total`；`… > recomputing ROUND_HALF_UP(price ÷ consumption) from the snapshot reproduces fuelUnitPrice exactly`；`… > recomputing segment amounts from the snapshot reproduces snapshotAmount exactly` | T8 | PENDING |
| AC-26 | integration | `phase5a-travel-complete.test.ts` | `AC-26 快照不可變 > adding an earlier-effective price or consumption version leaves the completed snapshot bit-identical`；`… > GET of a completed application performs no parameter resolution` | T8 | PENDING |
| AC-27 | integration | `backend/test/integration/phase5a-migration-safety.test.ts` | `PHASE-005a-T1 migration safety net — existing DB (AC-27) > AC-27 / Done When #1: every pre-existing column, across all five Spec §8.6 tables, is byte-for-byte unchanged after migration`；`… > AC-27: the five new columns are NULL (zero backfill) and §8.4 discriminator reads as OLD model`；`… > AC-27: GET the migrated application still returns 200 with a non-null snapshot`；另 existing DB 之 `Done When #2: … incrementally against an existing (pre-Phase) DB`、`— clean DB > Done When #2: … brand-new empty DB`（各一條）與 `— account deletion guard covers UserFuelConsumptionVersion > 409 CONFLICT (not 500) …` 一條 | T1 | GREEN |
| AC-28 | unit(structural) | `fuel-price-engine.test.ts` | `AC-28 零浮點中介 — PHASE-005a source files contain no Number()/parseFloat/parseInt on the amount path (date-parse whitelist only)`（describe；掃描由 `PHASE_005A_SRC_FILES` 清單驅動，缺檔必紅——T3/T4/T5/T7/T8 新增 src 檔須入列）：`… > scanned file: src/parameters/fuel-price-engine.ts > contains zero Number()/parseFloat/parseInt calls …`；`… > contains no unary/binary `+` numeric coercion …`；`… > every Prisma.Decimal construction in this file takes a string literal or an existing Prisma.Decimal-typed value (D4 bright-line)`；`… > scanner self-proof (discriminating power) …`；T3 起新增 `… > scanned file: src/parameters/fuel-price-service.ts > …` 三條（清單驅動自動生成） | T2 | GREEN（掃描清單須隨 T3~T8 擴充；T3 已入列 fuel-price-service.ts） |
| AC-29 | frontend | `frontend/test/ParametersPage.test.tsx` | `油價維護（PHASE-005a） > 表單含油種選擇與「每公升油價（元／公升）」欄位`；`… > 版本列表依油種分組呈現，四油種各自時間軸可辨識`；`… > 五態：Loading／Empty／400 就地標示／409 衝突／Success` | T9 | PENDING |
| AC-30 | frontend | `frontend/test/AdminFuelConsumptionPage.test.tsx` | `管理員油耗維護頁 > 版本列表顯示歷史／目前生效／未來生效與依據備註`；`… > 建立表單五欄齊備，basisNote 為必填`；`… > 五態：Loading／Empty／400／404／409／Success／Permission denied` | T10 | PENDING |
| AC-31 | frontend | `frontend/test/MyFuelConsumptionSection.test.tsx` | `個人車輛油耗檢視 > 顯示目前生效的油種、油耗與生效日期`；`… > 無資料時顯示空白狀態與「請聯絡管理員建立」`；`… > 畫面不存在任何新增／修改／刪除入口（負向斷言）`；`… > 固定顯示「如與實際車輛不符，請聯絡管理員核對後更新」` | T11 | PENDING |
| AC-32 | frontend | `frontend/test/TravelApplicationPage.test.tsx` | `缺參數提示（PHASE-005a） > 僅缺油耗 → 顯示「請聯絡管理員建立油耗資料」`；`… > 僅缺油價 → 顯示「請聯絡管理員設定參數」`；`… > 兩者皆缺 → 兩則訊息同時可見且逐字互異`；`… > 缺油資依據時預覽顯示「油資無法計算」而非金額 0` | T11 | PENDING |
| AC-33 | E2E | `e2e/fuel-model.spec.ts` | `PHASE-005a Gate E2E > 情境6：響應式 375px——油價頁／油耗維護頁／個人區塊 body 皆無水平溢位` | T13 | PENDING |
| AC-34 | integration | `backend/test/integration/phase5a-contract.test.ts` | `AC-34 錯誤格式統一且不外洩 > every error path returns { error: { code, message, requestId, fields? } }`；`… > no log line contains password / token / cookie / SQL / absolute path`；`… > basisNote never appears in application logs` | T12 | PENDING |
| AC-35 | unit(structural) | `phase5a-contract.test.ts` | `AC-35 不新增 ErrorCode > errors.ts ErrorCode union equals the known baseline`；`… > PHASE-005a source references only baseline ErrorCode literals` | T12 | PENDING |
| AC-36 | integration | `phase5a-fuel-consumption-authz.test.ts` | `AC-36 授權矩陣 > 15 必要格逐格（未登入／強制改密／一般使用者／管理員／停用帳號 × 六類端點）` | T5 | PENDING |
| AC-37 | integration | `backend/test/integration/phase3a-parameter-fuel-etc.test.ts`（就地改寫之 `POST /parameters/fuel` describe）；連動更新 `backend/test/integration/chore003-parameter-field-capacity.test.ts`、`backend/test/integration/phase3a-parameter-audit.test.ts` | `POST /parameters/fuel（D1(a) 凍結後） > AC-37(a) 管理員／一般使用者／未登入三種身分皆回 404 NOT_FOUND（統一錯誤形狀，不新增 ErrorCode）`；`… > AC-37(b) 三種身分之請求前後 FuelParameterVersion 列數與最大 createdAt 全等（零寫入）`；AC-37(c) 之證據為 GET describe：三條純授權 it **零改動仍綠**＋AC-19 **斷言逐字不變**（僅播種由 POST 改 prisma 直寫）（`AC-19: admin gets 200 list sorted by effectiveFrom, no sensitive fields`、`AC-16: USER role → 403 FORBIDDEN on GET /parameters/fuel`、`AC-17: unauthenticated → 401 on GET /parameters/fuel`、`mustChangePassword admin → 403 PASSWORD_CHANGE_REQUIRED on GET /parameters/fuel`）；稽核移轉五條（`phase3a-parameter-audit.test.ts`）：`POST /parameters/fuel-price → AuditLog (AC-18) > AC-18 fuel-price: create success → one AuditLog row with correct fields`；`… > AC-18 fuel-price security: summary and targetLabel must not contain sensitive keys`；`… > AC-18 fuel-price: non-admin USER create → 403, no audit row created`；`… > AC-18 fuel-price: unauthenticated create → 401, no audit row`；`… > AC-18 fuel-price atomicity: overlap → 409, no audit row added` | T3b | GREEN |

**覆蓋核對**：AC-01~AC-37 全數有映射（本表共 **37 列**）。無 AC 僅由 E2E 覆蓋（AC-33 除外——響應式本質為瀏覽器行為，沿用 PHASE-004 AC-89／PHASE-005 AC-32 慣例）。
> **AC-37 測試名為預定名稱**；落地後依 `vitest --reporter=verbose` 之實際輸出**逐字回填**（機械規則自 §18 第二列起適用）。

---

## 13. Architecture / Data Flow 需同步項清單（本 Phase 不修改該二檔）

> Packet「Architecture Change Permission：僅列清單」。以下由大總管於 Gate 後決定是否另行派工。

1. **ARCHITECTURE §3 模組表**：`parameters` 模組補註「PHASE-005a 起，油資由 `FuelPriceVersion`（按油種）維護；`FuelParameterVersion` 依 D1 定案處置」；新增 `users/fuel-consumption`（或依 D7 之落點）模組列。
2. **ARCHITECTURE §4（金額計算）**：新增「油資每公里單價為推導值：`ROUND_HALF_UP(每公升油價 ÷ 車輛油耗, 0)`；取整恰兩處（單價、段金額），不得新增第三處」。
3. **ARCHITECTURE §4.5（授權）**：補「油耗資料為使用者屬性但**僅管理員可寫**，一般使用者含本人皆不可寫」。
4. **DATA_FLOW**：以本 Spec §9.2／§9.3 之流程圖取代既有「依出差日期套用油資參數」段。
5. **PROJECT_STATE 跨 Phase 追蹤**：新增「PHASE-008 報表須同時支援舊模型快照（新五欄為 NULL）與新模型快照，判別依 `fuelPriceVersionId` 是否為 null（本 Spec §8.4）」。
6. **CLAUDE.md 常用指令節**：仍為空（INFRA-001 §16 既有建議），與本 Phase 無關，僅列為未關閉之文件債。

---

## 14. Rollback

- **新增內容**：1 個 enum、2 張新表、`TravelApplication` 5 個 nullable 欄位、1 個 `AuditAction` 值、4 個後端端點、1 個推導純函式模組、3 個前端畫面／區塊、測試。
- **開發階段回滾**：branch `phase-005a` 還原至 `e7f2860`；DB 以 M4→M3→M2→M1 逆序 `DROP`（M5 之 enum 值保留為無害未使用值，見 §8.6）。
- **既有資料補償**：**無**。本 Phase 不改寫任何既有資料列（AC-27 機械證明）。
- **已產生新模型完成申請後之回滾**：`DROP COLUMN` 會**永久遺失**該批申請之油種／油價／油耗三項來源值（`fuelUnitPrice` 與金額仍在，故金額不失真，但可重現性喪失）。**若已有新模型已完成申請，回滾前須先匯出該五欄之備份**（列為 rollback 手冊步驟；開發期為合成資料，風險可控）。
- **公開 contract 影響**：新增端點屬新增（回滾即移除 route）；`missingParameters` 之值域變更與預覽端點之 `ownerId` 屬**變更**（依 D5／D6 定案），回滾須同步還原前端。
- **不可逆資產**：`AuditLog` 之新 `action` 值一經寫入即為歷史紀錄，不刪除（符合稽核不可竄改原則）。

---

## 15. Task Graph

> 每 Task 一律 TDD、一個 atomic commit（含 Task ID）。**規模上限（Packet）：單 Task ≤ 5 AC、≤ 6 檔、不得同時橫跨 FE＋BE＋DB 三層。**

| Task | 內容 | 層 | AC（≤5） | 檔案（≤6） | Risk | 依賴 | Done When |
|---|---|---|---|---|---|---|---|
| **T1** | Schema ＋ migration：`FuelType` enum、兩張新表、`TravelApplication` 五欄、`AuditAction` 值、`userHasHistory` 納入新表 | DB | AC-27 | `backend/prisma/schema.prisma`、`backend/prisma/migrations/*`（≤3 檔）、`backend/src/users/history.ts`、`backend/test/integration/phase5a-migration-safety.test.ts` | **High**（migration） | — | migration 前後舊列逐欄位值比對全同；`prisma migrate` 於乾淨 DB 與既有 DB 皆成功；帳號刪除守門測試涵蓋新表 |
| **T2** | 單價推導純函式 `deriveFuelUnitPrice` ＋ 容量守門 ＋ 零浮點掃描 | BE（純函式，零接線） | AC-18, 20, 28 | `backend/src/parameters/fuel-price-engine.ts`、`backend/test/unit/fuel-price-engine.test.ts` | **High**（金額核心） | T1 | 八列驗表全綠；`ROUND_HALF_EVEN` mutant 必紅；結構性掃描斷言在場 |
| **T3** | 油價 service ＋ route（按油種建立／列表／重疊／驗證／稽核） | BE | AC-01, 02, 03, 05, 06 | `backend/src/parameters/fuel-price-service.ts`、`backend/src/parameters/routes.ts`、`backend/test/integration/phase5a-fuel-price.test.ts` | **High**（參數版本＝金額基準） | T1 | 四油種同生效日組合全綠；並發 409 非 500；複用 `parseParameterDecimalField`／`checkNoOverlap` 經 import 斷言證實 |
| **T3b** | **落實 D1(a)：移除 `POST /parameters/fuel`（回 404）、保留 `GET /parameters/fuel` 唯讀**；依 Spec 更新受影響之既有斷言（AC-37(e) 逐檔清單） | BE | AC-37 | `backend/src/parameters/routes.ts`（**僅**移除 POST handler；GET handler 與 `/parameters/etc`、`/parameters/depreciation`、`/parameters/fuel-price` 零改動）、`backend/test/integration/phase3a-parameter-fuel-etc.test.ts`、`backend/test/integration/chore003-parameter-field-capacity.test.ts`、`backend/test/integration/phase3a-parameter-audit.test.ts`（**4 檔**）<br>**硬性約束**：`parameter-service.ts` 之 `createFuelVersion`／`listFuelVersions` 與 `FuelParameterVersion` model **一律保留**（見 AC-37(e) 不受影響列） | **High**（公開 API contract 變更——**事前批准已由 §16 D1(a) 人類裁定構成**，不需另行 Gate） | T3 | 三身分 404 ＋ 零寫入實證全綠；`GET` 之既有三條授權 it **逐字零改動**且仍綠；`chore003` 之 ETC／折舊 it **零改動**且仍綠；`postFuel` 改指後 34 處呼叫全綠（唯一文案例外依 AC-37(e) 之 chore003 例外列處置）；`phase3a-parameter-audit` 之 5 條 fuel 稽核 it 移轉後全綠且**四項新端點原無之稽核覆蓋（敏感鍵掃描／403／401／409 原子性）確實新增**；`chore002-d4-decimal-number`／`chore003-string-fidelity`／`phase3a-parameter-model` **零改動且仍綠**（service 層未被誤刪之機械證明）；後端全套兩輪全綠且**無任何測試被刪除／`skip`／弱化**（Handoff 須附增刪計數） |
| **T4** | 油耗 service（建立／列表／驗證／重疊／依據備註） | BE | AC-07, 08, 09, 10, 11 | `backend/src/users/fuel-consumption-service.ts`、`backend/test/integration/phase5a-fuel-consumption.test.ts` | **High**（他人屬性寫入） | T1 | 值域邊界 `0.0001` 正例與 `0` 反例全綠；並發 409；跨使用者獨立 |
| **T5** | 油耗 route ＋ 授權矩陣 ＋ 稽核 ＋ 版本 `state` | BE | AC-12, 13, 14, 36 | `backend/src/users/fuel-consumption-routes.ts`、`backend/src/server.ts`（註冊）、`backend/test/integration/phase5a-fuel-consumption-authz.test.ts` | **High**（授權） | T4 | 15 必要格全綠；403 路徑 DB 零寫入實證；稽核 `before`/`after` 精確；判定順序無側信道 |
| **T6** | 自身唯讀端點 `GET /me/fuel-consumption` | BE | AC-15, 16, 17 | `backend/src/users/fuel-consumption-routes.ts`、`backend/test/integration/phase5a-self-consumption.test.ts` | **High**（授權／資料隔離） | T5 | 逐鍵白名單全等；他人識別值三路徑（query／body／path）皆不可達 |
| **T7** | `resolveTravelParameters` 改造（owner ＋ 油種鏈）＋ 缺參數區分 ＋ blockers | BE | AC-04, 21, 22, 23 | `backend/src/applications/travel-parameters.ts`、`backend/src/applications/completion-blockers.ts`、`backend/src/applications/travel-service.ts`、`backend/src/applications/routes.ts`、`backend/test/integration/phase5a-resolve.test.ts` | **High**（金額＋授權） | T2, T3, T6 | AC-21／AC-22 之對照組鑑別力全綠；代操作互異單價全綠；PHASE-004 既有差旅測試零弱化 |
| **T8** | 完成流程快照擴充 ＋ 取整層級 ＋ 不可變 ＋ 後端權威 | BE ＋ DB（寫入） | AC-19, 24, 25, 26 | `backend/src/applications/travel-service.ts`、`backend/test/integration/phase5a-travel-complete.test.ts` | **High**（不可逆快照） | T7 | 快照可重現性重算斷言全綠；`0.50/0.25` 取整鑑別例全綠；`calculateTravel` blob hash 零變更 |
| **T9** | 前端：油價維護頁（油種） | FE | AC-29 | `frontend/src/api/parameters.ts`、`frontend/src/types/api.ts`、`frontend/src/pages/ParametersPage.tsx`、`frontend/src/index.css`、`frontend/test/ParametersPage.test.tsx` | Medium | T3 | 五態全綠；四油種標籤逐字；既有 ETC／折舊區塊零回歸 |
| **T10** | 前端：管理員油耗維護頁 | FE | AC-30 | `frontend/src/api/fuelConsumption.ts`、`frontend/src/pages/AdminFuelConsumptionPage.tsx`、`frontend/src/App.tsx`（路由）、`frontend/src/pages/AdminUsersPage.tsx`（入口）、`frontend/src/index.css`、`frontend/test/AdminFuelConsumptionPage.test.tsx` | Medium | T5, T9 | 五態全綠；`.param-table`／`.num-col`／`YYYY-MM-DD` 慣例沿用 |
| **T11** | 前端：個人油耗檢視 ＋ 差旅缺參數提示 | FE | AC-31, 32 | `frontend/src/components/MyFuelConsumptionSection.tsx`、`frontend/src/pages/HomePage.tsx`、`frontend/src/pages/TravelApplicationPage.tsx`、`frontend/test/MyFuelConsumptionSection.test.tsx`、`frontend/test/TravelApplicationPage.test.tsx` | Medium | T6, T7 | 負向斷言（無寫入入口）全綠；三情境文字逐字互異全綠 |
| **T12** | 錯誤合約、`ErrorCode` 結構性斷言、日誌安全 | BE | AC-34, 35 | `backend/test/integration/phase5a-contract.test.ts` | Medium | T8 | `logStream` 掃描全綠；`ErrorCode` 聯集全等斷言全綠 |
| **T13** | 響應式 ＋ E2E（六情境） | FE ＋ E2E | AC-33 | `e2e/fuel-model.spec.ts`、`frontend/src/index.css` | Medium | T11, T12 | 六情境全綠（大總管親跑於 dev 拓撲）；三畫面 375px 無溢位 |

### 依賴圖

```
T1 ──▶ T2 ──▶ T3 ──┬──▶ T3b ──▶ T9
 │                  ├──▶ T7 ──▶ T8 ──▶ T12 ──┐
 └──▶ T4 ──▶ T5 ──▶ T6 ──┘                    │
                     │                        │
                     ├──▶ T10                 │
        T11 ◀── T6, T7                        │
                     └──▶ T11 ──▶ T13 ◀───────┘
```

> **排序硬性要求**：**T3b 必須在 T9 之前完成**。理由：T9 之 AC-29 將前端油資區塊改指 `/parameters/fuel-price`；若 T9 先行，前端已離開舊端點而後端仍可寫，等同 D1(a) 所否決之 **(b) 新舊並存**；若 T3b 先行，`frontend/src/api/parameters.ts:36` 之 `apiCreateFuelVersion` 成為 404 死路徑，**由 T9 於同一 Phase branch 內立即承接清除**（見 AC-37(e) 末二列之 T9 附帶必辦）。此為 Phase 內部之過渡狀態，不進 `main` 單獨發布。
> **T13 附帶必辦**：三個 e2e helper 之油資播種改寫（AC-37(e) 倒數第二列）與 D1(a) 附款「Gate 環境舊油資參數列由人類以新模型重建」合併於 T13 處理。

### 規模上限自查

| Task | AC 數 | 檔數 | 跨層 | 合規 |
|---|---|---|---|---|
| T1 | 1 | 6 | DB only（＋1 既有 src 檔之守門擴充） | ✅ |
| T2 | 3 | 2 | BE only | ✅ |
| T3 | 5 | 3 | BE only | ✅ |
| T3b | 1 | 4 | BE only（1 src ＋ 3 既有測試檔之斷言更新；零 schema、零 FE、零 E2E） | ✅ |
| T4 | 5 | 2 | BE only | ✅ |
| T5 | 4 | 3 | BE only | ✅ |
| T6 | 3 | 2 | BE only | ✅ |
| T7 | 4 | 5 | BE only | ✅ |
| T8 | 4 | 2 | BE ＋ DB（寫入既有表，無 schema 變更） | ✅ |
| T9 | 1 | 5 | FE only | ✅ |
| T10 | 1 | 6 | FE only | ✅ |
| T11 | 2 | 5 | FE only | ✅ |
| T12 | 2 | 1 | BE only | ✅ |
| T13 | 1 | 2 | FE ＋ E2E | ✅ |

> **無任何 Task 同時橫跨 FE＋BE＋DB 三層。** T1 為唯一含 schema/migration 之 Task；T8 寫入既有表但不改 schema。
> **TDD 順序**：T1（migration 安全網先建立）→ T2（純函式金額核心，零接線）→ T3/T4（service）→ T5/T6（授權面）→ T7/T8（差旅整合，金額落地）→ T9~T11（前端）→ T12/T13（合約與 Gate）。

---

## 16. 需人類批准之決策點（D1~D11）

> 每條格式：**為什麼要決定** ｜ **選項** ｜ **各選項影響** ｜ **推薦**。
> **凡未裁定者，相關 AC 與實作一律不得開工。**

---

### D1 — 既有 `FuelParameterVersion` 表與 `POST/GET /parameters/fuel` 端點之處置（**migration ＋ 公開 API contract，必人類批准**）

**為什麼要決定**
既有 `FuelParameterVersion.unitPrice` 為「每公里單價」（元／km），新模型為「每公升油價」（元／L），**量綱不同**，無法自動換算（換算須臆造油耗）。同時 `TravelApplication.fuelParameterVersionId` 之歷史引用與 `parameterHasReferences("FUEL", …)` 依賴該表存在。且 dev／Gate 環境已存在合成資料（PROJECT_STATE：油資 5.0000／2026-01-01 生效）。

**選項**

| 選項 | 內容 |
|---|---|
| **(a) 保留表、凍結寫入端點** | 新增 `FuelPriceVersion` 表與 `/parameters/fuel-price` 端點；`FuelParameterVersion` 表保留（歷史引用完整），`POST /parameters/fuel` **移除**（回 404），`GET /parameters/fuel` **保留為唯讀**（供稽核追溯與 PHASE-008 舊快照顯示）。前端油資區塊改指新端點。 |
| **(b) 保留表與兩個端點，新舊並存** | 舊端點完全不動，新舊模型並行可寫。 |
| **(c) 改造既有表** | 於 `FuelParameterVersion` 加 `fuelType` 欄、改唯一鍵、重新詮釋 `unitPrice` 為每公升油價。 |

**各選項影響**

- **(a)**：歷史引用與稽核完整；使用者可見行為變更明確（舊建立入口消失），Gate 可清楚驗收；`GET` 唯讀保留使 PHASE-008 能顯示舊申請之參數來源。成本：需移除一個既有端點（公開 contract 變更），並調整 PHASE-003a 之既有測試（**屬依 Spec 更新斷言，非弱化測試**）。
- **(b)**：無破壞，但**同時存在兩套油資模型可寫**，管理員可能誤建舊版本而毫無作用（新差旅永不讀舊表），是最容易產生金額誤解的選項。
- **(c)**：**最危險**。既有列之 `unitPrice = 5.0000` 會被重新詮釋為「每公升 5 元」，若未回填 `fuelType` 則需 backfill（違反「零回填」硬性要求）；且既有已完成快照透過 `fuelParameterVersionId` 指向的列，其語意會被就地改寫 —— **直接違反 Packet「既有已完成申請之快照不得受任何 migration 影響」**。

**推薦：(a)**。並附加：Gate 環境之舊油資參數列須以合成資料重建為新模型（不換算、由人類重新輸入油價與油耗）。

---

### D2 — 油種之儲存型別與 wire 值（**資料模型 ＋ 公開 API contract**）

**為什麼要決定**
油種同時出現在 DB（兩張新表 ＋ 快照欄位）與 API 回應。列舉值一經寫入快照即不可變。

**選項**

| 選項 | 內容 |
|---|---|
| **(a) Prisma enum `FuelType`，wire 值 `GASOLINE_92`/`GASOLINE_95`/`GASOLINE_98`/`DIESEL`** | 型別安全；DB 層即拒絕未知值；zh-TW 標籤由前端映射 |
| **(b) `String` 欄位 ＋ 應用層列舉守門** | 未來擴充油種不需 migration |
| **(c) enum，wire 值採 zh-TW（`92`/`95`/`98`/`柴油`）** | 前端零映射 |

**各選項影響**
- **(a)**：與專案既有慣例一致（`Role`／`ApplicationStatus`／`AttachmentRefType` 皆為 enum）；DB 為最後防線。成本：新增油種需 migration（Q4 已裁定不自訂，故非實際成本）；回滾時 enum 值不可移除（§8.6 已述，無害）。
- **(b)**：失去 DB 層守門；快照可能寫入任意字串。與 Q4「固定四項列舉」之意圖相悖。
- **(c)**：zh-TW 值進入 DB 與 API，未來多語系或標籤調整會改動歷史快照可讀性；且 `92` 這類純數字字串易與數值欄位混淆。

**推薦：(a)**。

---

### D3 — 數值精度、欄位容量與 `basisNote` 長度上限（**金額語意上游 ＋ 使用者可見行為**）

**為什麼要決定**
Q7 已裁定「油價 ≥0 容許小數、油耗 >0 容許小數」，但**實際小數位數由本 Spec 定案**（Packet 明文）。精度直接決定推導單價，屬金額語意上游。

**選項**

| 子項 | 選項 | 說明 |
|---|---|---|
| **(a) 油價 `pricePerLiter`** | **(a-1) `Decimal(10,4)`** ／ (a-2) `Decimal(8,2)` | (a-1) 直接複用既有 `UNIT_PRICE_CAPACITY` 與 `parseParameterDecimalField`，錯誤文案完全沿用 PHASE-003a §14.2 文案表；(a-2) 需新增一組容量常數與文案 |
| **(b) 油耗 `kmPerLiter`** | **(b-1) `Decimal(10,4)`** ／ (b-2) `Decimal(6,2)` | (b-1) 同上複用；(b-2) 更貼近實務值域（0.01~9999.99）但需新常數與新文案，且下界 `0.01` 會排除 `0.0001` 這類極端輸入（間接緩解 D4，但屬隱性耦合） |
| **(c) `basisNote` 長度上限** | **(c-1) ≤ 500 字** ／ (c-2) ≤ 200 字 ／ (c-3) 不設限 | (c-1) 沿用 PHASE-004 D14(ii) 之「出差目的 ≤500 字」既有慣例；(c-3) 無上限使 DB 與日誌面臨非受控輸入 |

**各選項影響**
- 複用（a-1）＋（b-1）使本 Phase **零新增驗證常數與文案**，錯誤合約與 CHORE-003 已固化之行為完全一致，reviewer 可直接比對；代價是油耗允許到 `999999.9999`（物理上不可能），僅由「>0」把關。
- （b-2）會使油耗值域收斂，但**不能取代 D4 之守門**（`0.01 km/L` ＋ `999999.9999 元/L` 之商仍為 1e8）。

**推薦：(a-1) ＋ (b-1) ＋ (c-1)**。理由：最大化複用既有已驗證之驗證管線，將「物理合理性」交由管理員判斷與稽核（`basisNote` 即為此設計），而非以欄位容量隱性表達業務規則。

---

### D4 — 推導單價超出快照欄位容量之處置（**錯誤合約 ＋ 金額語意，必人類批准**）

**為什麼要決定**
`TravelApplication.fuelUnitPrice` 為 `Decimal(10,4)`（整數部 6 位，`|v| < 1e6`），但輸入值域（油價 `< 1e6`、油耗 `> 0`）之商**無上界**。若不處理，`P = 999999.9999, C = 0.0001` 會在完成交易寫入時由 DB 拋錯 → **500**（與 CHORE-003 剛消滅的 500 路徑同型）。此為 US 層未預見之結構性邊界。

**選項**

| 選項 | 內容 |
|---|---|
| **(a) 推導處加容量守門** | `deriveFuelUnitPrice` 回傳「超出容量」結果；完成流程回 **409 `PARAMETER_NOT_AVAILABLE`**，`details.missing` 另加代碼（例 `FUEL_UNIT_PRICE_OUT_OF_RANGE`），訊息「油價與油耗之組合超出可計算範圍，請聯絡管理員檢查參數設定」。草稿仍可存，預覽顯示不可計算。**不改任何欄位容量。** |
| **(b) 擴充 `fuelUnitPrice` 欄位容量** | `ALTER COLUMN TYPE numeric(14,4)`。PostgreSQL 之 numeric 擴充為**非破壞性**且既有值不變，但屬「對承載歷史快照之欄位動型別」，與「快照零影響」之保守原則相衝。仍無法涵蓋所有商（`C = 0.0001` 之商可達 1e10）。 |
| **(c) 於建立時交叉守門** | 建立油價／油耗版本時檢查與另一表所有版本之組合。**不可行**：組合為跨表笛卡兒積，且未來新增版本會使既有組合失效。 |
| **(d) 不處理，接受 500** | 明確違反 NFR-US-16 與 CHORE-003 已建立之「消滅 500」方向。 |

**各選項影響**
- **(a)**：與 Q3「缺資料 → 草稿可存、完成被擋」之既有心智模型一致；零 migration；錯誤可定位可行動。代價：需新增一個 `details.missing` 代碼（**非**新增 `ErrorCode`，AC-35 仍成立）。
- **(b)**：治標不治本，且動了歷史快照欄位。
- **(d)**：不可接受。

**推薦：(a)**。

---

### D5 — `missingParameters` 之 wire 值域（**公開 API contract ＋ 使用者可見行為**）

**為什麼要決定**
現行 `type MissingParameter = "FUEL" | "ETC"`（`travel-parameters.ts:39`、`TravelComputedDto.missingParameters`），前端已依此顯示提示。FE-US-12 第四條 AC 要求缺油耗之提示須與缺參數**可區分**。

**選項**

| 選項 | wire 值 | 說明 |
|---|---|---|
| **(a) 更名 ＋ 新增** | `"FUEL_PRICE"` \| `"FUEL_CONSUMPTION"` \| `"ETC"` | 語意最清楚；`FUEL` → `FUEL_PRICE` 為**破壞性更名** |
| **(b) 保留 ＋ 新增** | `"FUEL"` \| `"FUEL_CONSUMPTION"` \| `"ETC"` | 零破壞；但 `FUEL` 在新模型下實指「油價」，命名與語意漂移 |
| **(c) 結構化** | `{ kind: "FUEL_PRICE", fuelType: "GASOLINE_95" }` 之物件陣列 | 資訊最完整（可顯示「95 無鉛汽油尚無油價」）；形狀變更最大 |

**各選項影響**
- **(a)**：需同步改前端與 `completion-blockers.ts:PARAMETER_LABELS`，PHASE-004 既有測試中對 `"FUEL"` 之斷言須更新（**屬依 Spec 更新斷言**，須於 Packet 逐檔列明）。系統尚未上線，破壞成本為零。
- **(b)**：省一次改名，但留下永久的命名債，日後閱讀者會誤以為 `FUEL` 涵蓋油耗。
- **(c)**：提示品質最佳，但 `TravelComputedDto` 形狀變更較大，且缺油耗時 `fuelType` 未知（須為 `null`），形狀不對稱。

**推薦：(a)**。並在 Packet 中逐檔列出須更新斷言之既有測試（避免 implementer 誤判為「弱化測試」）。

---

### D6 — 差旅預覽端點是否新增 `ownerId`（**授權面擴張 ＋ 公開 API contract，必人類批准**）

**為什麼要決定**
`POST /applications/travel/preview` 現為 **stateless**（PHASE-004 §6.1「無資料擁有權（stateless）；不回傳他人資料」，`routes.ts:489-491` 逐字），僅讀參數版本表。新模型下油資單價**依擁有人而異**，管理員代操作時的預覽必須用擁有人的油耗，否則預覽與完成結果不一致。

**選項**

| 選項 | 內容 |
|---|---|
| **(a) 新增可選 `ownerId`，走 `resolveOwnerId`** | 未帶 → 自己；一般使用者帶他人 → **403**（不靜默降級）；管理員帶他人 → 用該人資料。預覽端點自此**具有資料擁有權語意**。 |
| **(b) 不改預覽端點，代操作時預覽一律顯示「無法預覽」** | 預覽退化，管理員代操作體驗變差，但零授權面擴張。 |
| **(c) 改為對草稿 id 之有狀態預覽** | 需先存草稿才能預覽，違反 FE-US-10「輸入里程後即時查看」。 |

**各選項影響**
- **(a)**：新增授權面 —— 預覽回應本身不含單價（D6(c) 不變），但**金額**會間接洩漏他人之推導單價。故一般使用者帶他人 `ownerId` 必須 403（fail-closed），且此為 Q10「不得以不知情為安全前提」之直接適用場景。實作沿用既有 `resolveOwnerId`，無新機制。
- **(b)**：FE-US-10 第三條 AC 對代操作情境失效。
- **(c)**：違反 FE-US-10 第一條 AC。

**推薦：(a)**，並將 T7 標記為 **High**（已於 §15 標記）。

---

### D7 — 端點路徑形狀（**公開 API contract，必人類批准**）

**為什麼要決定**
四個新端點之路徑一經前端接線與 Gate 驗收即形成慣例。

**選項**

| 端點 | (a) 推薦 | (b) 替代 |
|---|---|---|
| 油價寫／讀 | `POST|GET /parameters/fuel-price` | `POST|GET /parameters/fuel`（沿用舊路徑，語意改變） |
| 油耗寫／讀（管理員） | `POST|GET /users/:userId/fuel-consumption` | `POST|GET /parameters/fuel-consumption?userId=` |
| 自身唯讀 | `GET /me/fuel-consumption` | `GET /users/me/fuel-consumption` ／ `GET /users/:userId/fuel-consumption`（自己時放行） |

**各選項影響**
- **(a)**：`/parameters/*` 保留給「全域參數」語意，`/users/:userId/*` 表達「使用者屬性」語意，兩者職責清楚；`/me/*` 為明確的「恆為自己」端點，**結構上不可能傳入他人識別值**（AC-17 之最強保證，非靠檢查而靠不存在參數）。
- **(b)** 之第三列（自身走 `/users/:userId/`）最危險：授權判定成為「若 `:userId === currentUser.id` 則放行」，一旦判定寫錯即為越權；`/me/*` 沒有這個失敗模式。

**推薦：(a) 全部三列**。

---

### D8 — 油耗版本是否可修改／刪除（**使用者可見行為 ＋ 資料保存**）

**為什麼要決定**
AD-US-15 第 9 條 AC 之文字為「管理員建立**或修改**油耗資料成功」，但 BE-US-19 第 4 條要求「已有歷史申請引用者不得覆寫」。兩者並存的唯一無矛盾解讀為 append-only（「修改」＝新增後續版本）。

**選項**

| 選項 | 內容 |
|---|---|
| **(a) Append-only** | 只提供建立與查詢；「修改」即新增新生效日之版本。與 `FuelParameterVersion`／`EtcParameterVersion`／`DepreciationParameterVersion` 三表之既有行為完全一致（PHASE-003a 從未提供 UPDATE／DELETE）。 |
| **(b) 允許修改未被引用之版本** | 需實作引用檢查（D11）＋ 更新端點 ＋ 更新稽核事件。 |
| **(c) 允許刪除未生效之未來版本** | 折衷；仍需引用檢查與刪除稽核。 |

**各選項影響**
- **(a)**：零新增不可逆操作面；輸入錯誤之補救方式為「新增一筆正確版本」，但**同一生效日之錯誤無法覆蓋**（須改用不同生效日），此為已知限制（見 §17）。
- **(b)/(c)**：新增不可逆／半不可逆操作，各需一組授權 ＋ 稽核 ＋ 引用保護 AC，Phase 規模顯著上升。

**附帶確認項（B-12）**：是否允許為 `isActive=false` 之使用者建立油耗版本？推薦**允許**（歷史資料維護需求；該使用者無法登入故無外洩面）。

**推薦：(a)**，附帶確認項採「允許」。

---

### D9 — 前端落點（**使用者可見行為，必人類批准**）

**為什麼要決定**
三個前端呈現點之落位影響導覽結構與 Gate 驗收路徑。

**選項**

| 畫面 | (a) 推薦 | (b) 替代 |
|---|---|---|
| 油價維護 | 擴充既有 `ParametersPage` 之油資區塊（加油種選擇與油種欄） | 獨立 `/admin/fuel-price` 頁 |
| 油耗維護 | **新頁** `/admin/users/:userId/fuel-consumption`，入口置於 `AdminUsersPage` 每列 | 併入 `ParametersPage`（加使用者選擇器） |
| 個人檢視 | **既有 `HomePage` 新增區塊**（沿用 PHASE-005 D6(a)「嵌既有頁」先例） | 新增 `/profile` 路由 |

**各選項影響**
- 油耗維護採新頁：與「油耗是使用者屬性而非全域參數」之模型一致（US-PROPOSAL §3.1 明列此區別），且天然帶入 `:userId` 上下文；併入 `ParametersPage` 會使該頁同時承載全域與個人兩種語意。
- 個人檢視嵌 `HomePage`：與 PHASE-005 統計區塊之處置一致，不增加路由與導覽複雜度。

**推薦：(a) 全部三列**。

---

### D10 — 舊模型已完成申請在 PHASE-008 報表之呈現（**跨 Phase 設計約束**）

**為什麼要決定**
migration 後，舊已完成申請之 `snapshotFuelType`／`snapshotFuelPricePerLiter`／`snapshotFuelConsumption` 恆為 `NULL`。PHASE-008 報表版型若無條件呈現三欄會出現空白或 `NaN`。此約束須**現在**定案，否則 008 會重工（PROJECT_STATE L7 排程理由原文：「008 報表前定案避免版型重工」）。

**選項**

| 選項 | 內容 |
|---|---|
| **(a) 版型條件呈現** | 新模型顯示「油種／每公升油價／油耗／每公里單價」四列；舊模型僅顯示「每公里單價」一列並註記「（舊制參數）」。判別依 `fuelPriceVersionId` 是否為 null（§8.4）。 |
| **(b) 人工回填舊申請** | 由管理員為舊申請補建油種／油價／油耗。**違反快照不可變**（AD-US-11 第 5 條），且屬臆造歷史。 |
| **(c) 作廢並重建舊申請** | 破壞歷史，且 PHASE-009 尚未實作。 |

**各選項影響**
- **(a)**：零資料改寫；報表誠實反映當時制度；成本為 008 版型多一個分支。
- **(b)/(c)**：皆改寫或破壞歷史，違反 CLAUDE.md「已完成申請不可修改」。

**推薦：(a)**，並由大總管將此結論寫入 PROJECT_STATE 跨 Phase 追蹤（§13 第 5 項）。

---

### D11 — 引用保護之適用範圍（`parameterHasReferences` 擴充）

**為什麼要決定**
BE-US-19 第 4 條：「Given 參數或油耗資料已有歷史申請引用／When 管理員建立新版本／Then 不得覆寫被引用的歷史內容。」現行 `reference-guard.ts:parameterHasReferences` 僅支援 `"FUEL" | "ETC"` 且查 `fuelParameterVersionId`。

**選項**

| 選項 | 內容 |
|---|---|
| **(a) 擴充型別為 `"FUEL_PRICE" \| "FUEL_CONSUMPTION" \| "ETC"`（保留 `"FUEL"` 供舊列查詢）** | 對應查 `fuelPriceVersionId`／`fuelConsumptionVersionId`。在 D8(a) append-only 下**無呼叫端**，屬「規則定義 ＋ 不變式守門」，與 PHASE-003a §4.7 之處置同型（該處亦為「先定義、後回歸」）。 |
| **(b) 不擴充** | BE-US-19 第 4 條在新模型下無對應實作點。 |

**各選項影響**
- **(a)**：成本低（一個函式加兩個分支 ＋ 單元測試），使 D8 若日後改為允許修改時有現成守門；並可作為「append-only 使覆寫不可能」之機械證明（測試斷言：不存在任何 UPDATE／DELETE 路徑）。
- **(b)**：US 條文無實作對應，終審覆蓋檢查會出現缺口。

**推薦：(a)**，惟**不新增端點**，僅擴充函式與其單元測試（併入 T3／T4 之檔案預算內，或由大總管視情況併為 Lite Task）。

---

## 17. 已知限制與跨 Phase 銜接

### 17.1 已知限制

1. **同一生效日之輸入錯誤無法覆蓋**（D8(a) 之直接後果）：管理員若在 `2026-06-01` 建立錯誤油耗，只能以不同生效日（如 `2026-06-02`）新增正確版本，`2026-06-01` 當日之差旅仍會套用錯誤值。緩解：`basisNote` 必填提高輸入前之核對品質；若實務上此限制不可接受，須改採 D8(b)。
2. **推導單價取整為 0 之情形合法但可能反直覺**（B-02）：油價 1 元／公升、油耗 3 km/L → 單價 0 → 油資補助 0 元。此為 BE-US-32 第 1 條 AC 逐字要求（取整為整數）之必然結果，非缺陷。
3. **舊模型與新模型之 `fuelUnitPrice` 共用同一欄位**（§8.4）：語意由「管理員直接輸入之每公里單價」變為「推導取整後之每公里單價」。判別須依 `fuelPriceVersionId`；任何未做此判別的下游讀取（PHASE-008／009／010）都會混淆兩種來源。已列入 §13 同步項第 5 點。
4. **預覽端點之金額間接洩漏推導單價**（D6 分析）：一般使用者可由自己的預覽金額 ÷ 里程反推自己的單價。此為 Q10 已裁定接受之邊界（沿用 PHASE-004 D6）；**但不得據此放寬他人資料之隔離**。
5. **油耗值域僅由 `> 0` 把關**（D3(b-1) 之代價）：物理不合理值（如 99999 km/L）可被建立。緩解：稽核 ＋ `basisNote`；若需業務值域，屬 US 層新增，須另走 US Gate。
6. **`AuditAction` enum 值回滾不可逆**（§8.6 M5）：PostgreSQL 限制，非設計缺陷。
7. **PHASE-004 兩處同型陣列 query 風險尚未修復**（PROJECT_STATE 追蹤項）：本 Phase 新端點依 B-11 自行防護，但既有 `GET /applications`／`attachment/routes.ts:125` 之 500 風險不在本 Phase 範圍。

### 17.2 與 PHASE-006／007／008／009／010 之銜接註記

- **PHASE-006（保養）**：不使用油資單價（保養以實際費用 × 公務比例計算）。惟其**快照**須沿用 BE-US-18 第 2 條之欄位清單，與本 Phase 無交集。本 Phase 新增之 `AuditAction` 值與參數頁改動不影響 006。
- **PHASE-007（折舊）**：折舊單價由 `DepreciationParameterVersion` 推導，與油資為**獨立參數族**（US-PROPOSAL §3.1 明列不受影響）。惟 007 開工 Packet 須引用本 Spec §10「精度紀律」與 AC-18 之取整慣例，避免兩處推導邏輯風格分歧。
- **PHASE-008（報表與 PDF）**：**硬性銜接** —— ①版型須呈現新快照四項（油種／每公升油價／油耗／每公里單價），②須依 §8.4 判別新舊模型並依 **D10** 分支呈現，③列印版與 PDF 同一版型（CLAUDE.md），故兩者須同時處理舊模型分支。008 開工 Packet 必引本節。
- **PHASE-009（作廢／修正版）**：修正版複製草稿時**不得**複製快照欄位（快照僅由完成流程寫入）；新草稿完成時會依當時參數重新解析，可能得到與原版不同之單價 —— 此為預期行為（修正版是新申請），須於 009 Spec 明示。
- **PHASE-010（稽核檢視）**：須涵蓋 `USER_FUEL_CONSUMPTION_VERSION_CREATED` 事件之呈現，且 `summary.basisNote` 之顯示須限管理員（§6.3）。

---

## 18. Spec 修訂紀錄

| 日期 | 版本／狀態 | 內容 | 依據 |
|---|---|---|---|
| 2026-08-03 | `DRAFT` 初版 | 本文件建立；36 AC、13 Task、D1~D11 決策點、AC↔測試映射表 36 列（全 `PENDING`） | Task Context Packet PHASE-005a-SPEC；`userstory.md`（`e7e2c34`）；`docs/specs/PHASE-005a-US-PROPOSAL.md`（APPROVED）；`PROJECT_STATE.md` L5~L16 |
| 2026-08-03 | `ACTIVE`（T2 複審修復同步） | T1R2+T2 合併複審 REQUEST_CHANGES（0 Must/4 Should/6 AR）→ **T2R-LITE**（`4259893`）修 SF-1（非有限除數/被除數守門——NaN 穿透 `lte(0)`、Infinity 靜默回 0，reviewer node 實測；後置有限性檢查補齊）、SF-3（AC-28 掃描改 `PHASE_005A_SRC_FILES` 清單驅動、缺檔必紅）、SF-4（裁定保留 RangeError；註解虛假上游依據更正，記 T7/T8「引擎 throw 不得 500」義務）；SF-2 由大總管以 verbose 實名回填 §12（AC-18/28 轉 GREEN、AC-20 單元層 GREEN/T8 整合層 PENDING、AC-27 實名更正）。「映射表名一律逐字複製 vitest verbose 輸出」自本列起為機械規則。AR-2（段金額/totalAmount 溢位邊界）移交 T8 邊界表。基準線 1244/0/0。 | 合併複審報告；大總管白名單 |
| 2026-08-03 | `ACTIVE`（T1 結案同步） | T1（`35b30e7`）＋T1R-LITE（`3a2c0a5`）＋T1R2-LITE（`255caed`，Review S-1 修復：AC-27 安全網擴為 §8.6 五表逐欄比對）結案；§12 映射表 AC-27 轉 `GREEN` 並回填實際測試名（Review S-2）。基準線 1217/0/0。 | T1 即審 REQUEST_CHANGES（0 Must/2 Should/7 AR）之 S-1/S-2 處置；大總管白名單（狀態欄／映射表狀態） |
| 2026-08-03 | `DRAFT` → **`ACTIVE`** | **Spec Gate 通過（人類 leonchih，2026-08-03，本 session AskUserQuestion）：D1~D11 全數照建議批准**——D1(a) 保留舊表凍結寫入＋GET 唯讀＋Gate 環境資料由人類重建；D2(a) Prisma enum `FuelType`；D3(a-1)(b-1)(c-1) 油價油耗均 `Decimal(10,4)` 複用既有驗證管線、`basisNote` ≤500 字；D4(a) 推導處容量守門→409 不改欄位；D5(a) `FUEL`→`FUEL_PRICE` 更名＋新增 `FUEL_CONSUMPTION`（既有斷言依 Spec 更新，Packet 逐檔列明）；D6(a) 預覽端點加可選 `ownerId` 走 `resolveOwnerId`（一般使用者帶他人→403）；D7(a) 三組路徑全採；D8(a) append-only＋允許為停用帳號建立；D9(a) 三落點全採；D10(a) 報表條件呈現（結論由大總管寫入 PROJECT_STATE 跨 Phase 追蹤）；D11(a) 擴充函式不新增端點。**兩項自主判斷（§5 B-05 缺油耗不回報油價缺項、D5 斷言更新非弱化）一併追認。T1~T8 High 之事前批准於本 Gate 取得。** | 人類 Spec Gate 裁定（leonchih，2026-08-03） |

| 2026-08-03 | `ACTIVE`（PHASE-005a-SPEC-REV1：D1(a) 排程缺口修補） | **T3 即審 S-2 查出：已批准之 D1(a)「`POST /parameters/fuel` 移除（回 404）、`GET /parameters/fuel` 保留唯讀」在原 36 AC／13 Task 中無任何歸屬**，導致兩套量綱不同（元／km vs 元／L）之油資寫入端點並存——即 D1 已否決之選項 (b)。本次修訂：①§2 新增 **AC-37**（含 (a) 三身分 404、(b) 零寫入、(c) `GET` 唯讀與授權鏈不變、(d) 不變式、(e) 受影響既有測試之 `grep` 實查逐檔清單）；②§7.1 新增 **§7.1.1 凍結後合約**；③§15 新增 **T3b**（High，依賴 T3，**T9 前必須完成**）＋依賴圖與規模上限自查同步；④§12 新增 AC-37 列（`PENDING`／T3b），並移除與現況矛盾之過時計數句（原「`PENDING` 36 列、`GREEN` 0」與已 `GREEN` 之 AC-18／27／28 相斥）。**本修訂為既有批准之排程落實，無任何新產品決策、無 Scope 擴大、無 AC 刪減。** 受影響測試之處置一律為 D1(a) 原文所預期之「依 Spec 更新斷言，非弱化測試」；`chore003` 之 `postFuel` 改指 `/parameters/fuel-price` 以**零刪除**保全 §14 欄位容量契約覆蓋（唯一文案例外見 AC-37(e) 末列，明令不得以實作遷就過時斷言）。 | §16 **D1(a)** 批准原文（人類 leonchih，2026-08-03，見本節第四列）；T3 即審 S-2；Task Context Packet PHASE-005a-SPEC-REV1 |

| 2026-08-03 | `ACTIVE`（PHASE-005a-SPEC-REV2：AC-37(e) 漏檔修補） | **T3b 實作觸發 Stop Condition**：REV1 之 AC-37(e)「封閉清單」漏列 `backend/test/integration/phase3a-parameter-audit.test.ts`——其 `describeWithDb("POST /parameters/fuel → AuditLog (AC-18)")`（L156）之 5 條 it／6 處 `url` 皆直打舊端點，route 移除後全轉 404 紅。**漏檔根因（記錄以杜絕再犯）：REV1 之搜尋結果遭工具截斷於前 100 筆（`[Showing results with pagination = limit: 100]`），spec-writer 未察覺截斷即據以宣告「封閉清單」。** 本次修訂：①(e) 表補列該檔，處置定為**移轉至 `POST /parameters/fuel-price`**（非改寫 404）——實查確認 `phase5a-fuel-price.test.ts:775` 僅有成功路徑一條，缺敏感鍵掃描／403／401／409 原子性四項，故移轉為**淨增覆蓋**，稽核契約零流失；逐項對應（`targetLabel FUEL# → FUEL_PRICE#`、`parameterType FUEL → FUEL_PRICE`、`unitPrice → pricePerLiter`、`action` 不變）依 T3 已落地之 `routes.ts:236-250` 實查形狀。②(e) 表首補記**本次三道 grep 指令原文與完整命中計數（61 行／11 檔 ＋ 40 行／3 檔 ＋ 交叉核對）**，並新增三列「不受影響＋理由」，使該表成為可機械複驗之窮盡清單。③由「不受影響」列導出 **T3b 硬性約束：只移除 route 註冊，`parameter-service.ts` 之 `createFuelVersion`／`listFuelVersions` 與 `FuelParameterVersion` model 一律保留**（`chore002-d4-decimal-number`／`chore003-string-fidelity`／`phase3a-parameter-model` 約 27 處直呼 service，誤刪即全紅）。④T3b 檔數 3→**4**，Done When 與規模上限自查同步。**無新產品決策、無 Scope 擴大、無 AC 刪減；AC 總數維持 37。** | T3b BLOCKED 事件回報；§16 **D1(a)** 批准原文；Task Context Packet PHASE-005a-SPEC-REV2 |

> **轉 `ACTIVE` 之條件**：§16 D1~D11 全數經人類裁定並由大總管於本節固化；未裁定項相關之 AC 與 Task 不得開工。
