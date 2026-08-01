# PHASE-002 Spec — 認證與帳號管理

- Governance-Version: 2026-08-01.1
- 狀態：**ACTIVE**（D1~D11 全數經人類批准，2026-08-01；含 D9 初始管理員 seed 機制）
- 修訂（2026-08-01，Mock/整合 Gate 人類反饋）：強制改密頁增加「登出」出口——忘記臨時密碼的使用者可登出後請管理員重設；同時解決同瀏覽器下 A 卡在改密頁導致 B 無法登入的問題。後端 `/auth/logout` 本就豁免 requirePasswordChanged（5.1），此為前端補齊；「阻擋進入其他系統頁面」的 FE-US-02 原意不變。
- 更新日期：2026-08-01
- Phase ID：PHASE-002
- Base Commit：3e16155（branch: phase-001；PHASE-001 已整合驗收通過，PR #1 待合併；本 Phase 於 phase-002 branch 實作，由大總管 commit）
- 上游事實來源：`userstory.md`（FE-US-01/02/03、AD-US-01~05、BE-US-01/02/04、NFR-US-08/09/11）、`docs/PRD.md` 第 5 節 PHASE-002、`docs/ARCHITECTURE.md`（auth/authz/users/audit 模組）、`docs/DATA_FLOW.md`（1 節實體、2.1 登入）、`docs/adr/ADR-0001.md`（同源 Cookie）、`docs/specs/PHASE-001.md`（5.2 錯誤協定、6 env 清單）、`CLAUDE.md`
- Risk Level：**High**（認證／授權／密碼）
- Human Gate：事前批准（High）+ Mock Gate（登入/改密/使用者管理畫面）+ 整合 Gate

> 本 Spec 目標為自足：implementer 依 TDD 逐 Task 實作時，不需再讀 `userstory.md` 全文即可完成 T1~T11。凡本 Spec 未定案而影響產品行為、安全、資料者，列於第 13 節開放事項並交回大總管，不得由 implementer 臆測。
>
> **本 Spec 為 DRAFT。第 12 節「High 風險決策彙整清單」為人類事前批准的審閱依據。未經批准不得開始實作。**

---

## 1. 目標與非目標

### 1.1 目標

建立完整的認證與帳號管理垂直切片，Phase 結束人類可實際操作以下完整流程：

1. 以**管理員**登入 → 建立一般使用者帳號（給臨時密碼）。
2. 該使用者以**臨時密碼登入** → 被**強制導向改密頁**（無法進入其他頁面）。
3. 使用者完成改密 → 臨時密碼失效 → 進入「我的私車補助紀錄」（本 Phase 為占位頁）。
4. 使用者**自行再改密**（驗舊密碼、新舊不同、規則檢查）。
5. 管理員**停用**該使用者 → 該使用者無法再登入，且其**既有 session 立即失效**。
6. 管理員**重設密碼** → 使用者既有 session 失效、下次登入須改密。
7. 管理員對**無歷史**帳號可**永久刪除**，對**有歷史**帳號**拒刪並提供停用**。
8. 連續登入失敗 5 次 → 該帳號**鎖定 15 分鐘**（鎖定期間即使正確密碼亦拒）。

並落地供後續所有受保護 Phase 沿用的骨架：**認證中介層**（requireAuth）、**授權中介層**（requireAdmin、資料擁有權判斷點）、**稽核寫入基礎**（帳號建立/停用/啟用/重設密碼/刪除；密碼絕不入稽核）。

### 1.2 非目標（Out of Scope）

- 任何補助申請資料與功能（差旅/保養/折舊）— PHASE-004+。
- 附件、參數維護 — PHASE-003 / PHASE-003a。
- HTTPS 部署硬化本體 — PHASE-011（但 Cookie `Secure` 屬性**依 `NODE_ENV` 切換**在本 Phase 定義並實作，見 4.3）。
- Email 密碼重設、電子簽核等 `userstory.md` 第七節項目。
- 「有歷史拒刪」**以申請資料為歷史來源**的完整回歸 — 待 PHASE-004+ 有申請資料後於 PHASE-010 回歸。本 Phase 先實作可擴充的「歷史判斷點」，歷史來源在本 Phase 僅涵蓋「該使用者名下之申請資料」（尚不存在，故本 Phase 一般帳號皆判為無申請歷史）——見 4.6 與 T9 對此的明確處理，避免臆測。
- 前端首頁「我的私車補助紀錄」的實際列表 — PHASE-004；本 Phase 僅提供登入後導向的**占位頁**（顯示使用者名稱/角色/登出，證明 session 生效）。

---

## 2. 可測試 Acceptance Criteria

將上游 US 的 Given/When/Then **具體化**為 PHASE-002 可驗收形式，**不改變原意**。每條標註對應 US 與覆蓋 Task。「統一錯誤訊息」定義見 4.5.1。

### 認證與登入

**AC-01 有效帳號成功登入並導向（FE-US-01 / T3）**
- Given 帳號存在、`isActive=true`、未被鎖定、密碼正確、`mustChangePassword=false`。
- When `POST /api/auth/login` 提交帳號+密碼。
- Then 回 200、建立 Session、`Set-Cookie`（見 4.3）；回應 body 指示導向 `home`（前端導向「我的私車補助紀錄」占位頁）。

**AC-02 統一登入錯誤訊息（FE-US-01, NFR-US-09 / T3, T4）**
- Given 下列任一情形：帳號不存在／密碼錯誤／帳號已停用／帳號被鎖定。
- When 登入失敗。
- Then 一律回 **HTTP 401、`code=UNAUTHORIZED`、同一則 message**「帳號或密碼錯誤，或此帳號目前無法登入」；**不得**以 message、code、HTTP 狀態、回應時間顯著差異或任何欄位透露「帳號是否存在／是否停用／是否被鎖定／哪一項錯」。
- And 不設置 Session Cookie。

**AC-03 臨時密碼登入強制改密（FE-US-02 / T3, T7）**
- Given 帳號 `mustChangePassword=true`、密碼正確、帳號啟用未鎖定。
- When 登入成功。
- Then 回 200、建立 Session（標記為 `mustChangePassword` 狀態）、回應指示導向 `change-password-forced`；此 Session 在改密完成前**僅能存取改密相關端點**，存取其他受保護端點一律被拒（見 AC-04）。

**AC-04 強制改密未完成阻擋其他頁面（FE-US-02, BE-US-01 / T5, T7）**
- Given 使用者持有 `mustChangePassword` 狀態的有效 Session。
- When 呼叫任何非「改密／登出／取得自身資訊」的受保護端點。
- Then 回 **HTTP 403、`code=PASSWORD_CHANGE_REQUIRED`**；前端據此維持在強制改密流程。

**AC-05 未登入存取受保護資源被拒（FE-US-01, BE-US-01 / T5）**
- Given 請求無有效 Session Cookie（或 Cookie 無對應有效 Session）。
- When 存取任一受保護端點。
- Then 回 **HTTP 401、`code=UNAUTHORIZED`**；不回傳任何業務資料。

**AC-06 Session 失效需重新登入（BE-US-01 / T3, T5）**
- Given Session 已過期（超過有效期，見 4.3）或已被標記失效（登出／停用／重設密碼）。
- When 使用該 Session 呼叫受保護端點。
- Then 回 **HTTP 401、`code=UNAUTHORIZED`**；並清除該 Cookie（`Set-Cookie` 使其過期）。

**AC-07 登出使 Session 失效（FE-US-01 衍生 / T3）**
- Given 已登入使用者。
- When `POST /api/auth/logout`。
- Then 該 Session 標記失效（後端不可再認），回應清除 Cookie；再以同 Cookie 呼叫受保護端點回 401。

### 密碼安全與規則

**AC-08 密碼不存明文（NFR-US-08, BE-US-04 / T2）**
- Given 任何建立/變更/重設密碼的操作。
- When 系統保存憑證。
- Then 資料庫僅保存**不可逆雜湊**（含演算法參數與 salt，見 4.1）；任何查詢/回應/管理員介面/稽核/日誌**皆不含明文或雜湊值**。

**AC-09 密碼規則：長度與弱密碼（NFR-US-08 / T2）**
- Given 使用者提交新密碼。
- When 密碼 **< 10 字元** 或屬於**已知弱密碼清單**。
- Then 拒絕、回 `code=VALIDATION_ERROR`、`fields` 標示 `newPassword` 與具體原因（過短／弱密碼）。
- And 密碼 ≥ 10 字元且不在弱密碼清單 → 通過規則檢查（其他條件另判）。

**AC-10 自行改密：驗舊密碼（FE-US-03, BE-US-04 / T8）**
- Given 已登入使用者提交舊密碼 + 新密碼。
- When 舊密碼**不正確**。
- Then 拒絕、回 `code=UNAUTHORIZED`（或 `VALIDATION_ERROR` 於 `currentPassword`，見 4.5.3 定案）；不變更密碼。

**AC-11 自行改密：新舊不得相同（FE-US-03 / T8）**
- Given 舊密碼正確、新密碼通過規則。
- When 新密碼與目前密碼**相同**。
- Then 拒絕、回 `code=VALIDATION_ERROR`、`fields` 標示 `newPassword`「請使用與目前不同的密碼」。

**AC-12 改密成功後舊密碼失效（FE-US-03, BE-US-04 / T8）**
- Given 使用者成功改密。
- When 下次登入。
- Then 舊密碼**不再可用**（登入視同密碼錯誤，走 AC-02 統一訊息）；新密碼可登入。

**AC-13 強制改密完成臨時密碼失效（FE-US-02 / T7）**
- Given `mustChangePassword` 使用者於強制改密頁提交合規新密碼。
- When 改密成功。
- Then `mustChangePassword` 轉為 `false`、臨時密碼失效、Session 解除限制、可進入首頁；臨時密碼再登入視同密碼錯誤。

### 登入失敗鎖定

**AC-14 連續失敗 5 次鎖定 15 分鐘（NFR-US-09 / T4）**
- Given 同一帳號連續登入失敗達 **5 次**。
- When 第 6 次（或鎖定視窗內）再嘗試登入。
- Then 該帳號進入鎖定，**自最後一次觸發鎖定起 15 分鐘內**一律拒絕登入。

**AC-15 鎖定期間正確密碼亦拒（NFR-US-09 / T4）**
- Given 帳號處於鎖定期間（`lockedUntil` 為未來）。
- When 以**正確密碼**登入。
- Then 仍拒絕（走 AC-02 統一訊息），不建立 Session、不重置鎖定計時。

**AC-16 失敗計數與重置規則（NFR-US-09 / T4）**
- Given 帳號未鎖定。
- When 一次**成功登入**。
- Then 失敗計數歸零、`lockedUntil` 清除。
- And Given 鎖定期已過（`lockedUntil` 已是過去）。When 下次登入。Then 視為可再嘗試（計數重新累計；實作定案見 4.5）。

### 管理員帳號管理

**AC-17 使用者清單（AD-US-01 / T9）**
- Given 管理員已登入（非 `mustChangePassword` 限制態）。
- When `GET /api/admin/users`。
- Then 回使用者清單，每筆含：登入帳號、顯示姓名、員工編號（可空，空值以 `null`）、角色、啟用/停用狀態；**不含密碼雜湊或任何憑證**；一般使用者呼叫此端點回 403（見 AC-24）。

**AC-18 新增使用者（AD-US-02 / T9）**
- Given 管理員輸入未被使用的登入帳號、顯示姓名、臨時密碼（符合密碼規則）。
- When `POST /api/admin/users`。
- Then 建立帳號、`mustChangePassword=true`、`isActive=true`、`role=USER`；員工編號未填仍可建立（存 `null`）；回 201。

**AC-19 帳號重複拒絕（AD-US-02 / T9）**
- Given 登入帳號已存在。
- When 管理員提交新增。
- Then 拒絕、回 **HTTP 409、`code=CONFLICT`**、message 指出帳號已存在；不建立。

**AC-20 停用使用者 + 既有 session 失效（AD-US-03, BE-US-01 / T5, T9）**
- Given 目標使用者為啟用且可能持有既有 Session。
- When 管理員 `POST /api/admin/users/:id/deactivate`。
- Then `isActive=false`；該使用者**所有既有 Session 立即失效**；其後續受保護請求回 401；其歷史資料（帳號本身）保留。

**AC-21 啟用使用者（AD-US-03 / T9）**
- Given 目標使用者為停用。
- When 管理員 `POST /api/admin/users/:id/activate`。
- Then `isActive=true`；使用者可再次登入。

**AC-22 重設密碼（AD-US-05, BE-US-04 / T2, T9）**
- Given 管理員為指定使用者設定合規臨時密碼。
- When `POST /api/admin/users/:id/reset-password`。
- Then 更新為新雜湊、`mustChangePassword=true`；該使用者**既有 Session 立即失效**；稽核記錄操作者/受影響使用者/時間，**不含密碼**（見 AC-27）。

**AC-23 條件式刪除（AD-US-04 / T9）**
- Given 目標使用者**無任何歷史資料**（本 Phase 歷史來源定義見 4.6）。
- When 管理員 `DELETE /api/admin/users/:id`。
- Then 永久刪除帳號（及其 Session）；寫稽核（不含敏感資料）。
- And Given 目標使用者**有歷史資料**。When 嘗試刪除。Then 拒絕、回 **HTTP 409、`code=CONFLICT`**、message 提示改用停用；不刪除。

### 授權與資料隔離骨架

**AC-24 requireAdmin 守門（BE-US-02 衍生 / T6）**
- Given 一般使用者（`role=USER`）已登入。
- When 呼叫任一 `admin` 端點。
- Then 回 **HTTP 403、`code=FORBIDDEN`**；不執行操作、不回傳資料。

**AC-25 資料擁有權判斷點可用（BE-US-02 / T6）**
- Given 授權中介層提供 `assertOwnershipOrAdmin(actor, resourceOwnerId)` 判斷點。
- When 一般使用者的 `actorId !== resourceOwnerId` 且非管理員。
- Then 判斷點丟出 `FORBIDDEN`（供後續 Phase 對申請/附件/報表沿用）；管理員或本人則通過。
- And 本 Phase 以「使用者取得自身資訊 `GET /api/me`」與 admin 端點驗證此骨架（申請資料情境於 PHASE-004 補齊）。

### 稽核與敏感資料

**AC-26 稽核事件寫入（AD-US-05 稽核面, BE-US-31 部分 / T10）**
- Given 管理員執行：新增使用者、停用、啟用、重設密碼、刪除。
- When 操作成功。
- Then 各寫入一筆 AuditLog，含：操作者(actor)、受影響使用者(owner/target)、時間、操作類型、可辨識的受影響資料摘要（見 4.7 欄位）。

**AC-27 密碼絕不入稽核與日誌（NFR-US-08, BE-US-04, BE-US-31 / T2, T10）**
- Given 任何密碼相關操作（登入、建立、改密、重設）。
- When 產生稽核紀錄與伺服器日誌。
- Then **不得包含明文密碼、雜湊值、臨時密碼**；日誌沿用 PHASE-001 pino redact + `sanitizeForLog`，`password`/`newPassword`/`currentPassword`/`temporaryPassword` 等欄位一律遮蔽。

### 前端五態與 Cookie 安全

**AC-28 Cookie 安全屬性依環境切換（NFR-US-11 / T3）**
- Given Session Cookie 建立。
- When `NODE_ENV=production`。
- Then Cookie 具 `HttpOnly`、`SameSite=Lax`、`Secure`、`Path=/`。
- And When `NODE_ENV!=production`（開發/測試）。Then 具 `HttpOnly`、`SameSite=Lax`、`Path=/`，**不**強制 `Secure`（本機 HTTP 可用）。前端 JS 任何情況下皆無法讀取 Cookie（HttpOnly）。

**AC-29 前端五態（FE-US-01/02/03, AD-US-01~05 / T11）**
- Given 登入頁、強制改密頁、自行改密頁、使用者清單/新增/啟停/重設/刪除各畫面。
- When 呈現。
- Then 各具備 **Loading / Empty / Error / Success / Permission denied** 五態的對應處理（見第 6 節細部），文案 zh-TW，響應式（桌機/平板/手機可用）。

---

## 3. 資料模型（Prisma model 層級定案）

於 `backend/prisma/schema.prisma` 新增以下 model 與 enum，並以 `prisma migrate dev --name phase2_auth` 產生 migration。以下為**定案**（欄位、關聯、唯一性、旗標）；型別以 Prisma 慣例表示。此為本 Phase 首批業務資料表。

> 保留 PHASE-001 的 `HealthProbe` model 不動。

### 3.1 enum

```prisma
enum Role {
  USER
  ADMIN
}
```

### 3.2 User

```prisma
model User {
  id                 String    @id @default(cuid())
  loginName          String    @unique          // 登入帳號，唯一
  displayName        String                     // 顯示姓名
  employeeNumber     String?                     // 員工編號，可空
  passwordHash       String                     // 僅存不可逆雜湊（argon2id 編碼字串，含參數+salt）
  role               Role      @default(USER)
  isActive           Boolean   @default(true)    // 啟用/停用
  mustChangePassword Boolean   @default(true)    // 首次登入/重設後強制改密旗標
  failedLoginCount   Int       @default(0)       // 連續登入失敗計數
  lockedUntil        DateTime?                    // 鎖定至（null=未鎖定；未來時間=鎖定中）
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  sessions           Session[]
  auditLogsAsActor   AuditLog[] @relation("AuditActor")
  auditLogsAsTarget  AuditLog[] @relation("AuditTarget")

  @@index([loginName])
}
```

- `loginName` 唯一 → AC-19 帳號重複由 DB 唯一性 + 應用層預檢共同保證（見 4.5.4 併發）。
- `passwordHash` 為 argon2id 產生之自描述編碼字串（`$argon2id$v=19$m=...,t=...,p=...$salt$hash`），演算法參數內嵌，利於日後調參與驗證（見 4.1）。
- `employeeNumber` 可空（AD-US-02）。
- 密碼明文/雜湊**不得**出現在任何 API 回應 DTO（見第 5 節，所有 User 回應排除 `passwordHash`）。

### 3.3 Session

```prisma
model Session {
  id           String    @id @default(cuid())   // 內部主鍵
  sessionToken String    @unique                 // 高熵隨機 token（見 4.3；存雜湊，見下）
  userId       String
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt    DateTime  @default(now())
  expiresAt    DateTime                          // 絕對到期
  lastSeenAt   DateTime  @default(now())         // 滑動更新用
  revokedAt    DateTime?                          // 失效標記（登出/停用/重設密碼即設）
  mustChangePassword Boolean @default(false)      // 建立時快照使用者強制改密狀態（見 4.7.1）

  @@index([userId])
  @@index([sessionToken])
}
```

- **DB session 定案**（見 4.2）：停用/重設密碼可靠地使既有 session 失效（設 `revokedAt` 或刪除該使用者所有 session）。
- `sessionToken` 欄位存**token 的雜湊**（見 4.3），Cookie 內為原始 token；查詢時以雜湊比對，DB 外洩不致直接得到可用 token。
- `onDelete: Cascade`：刪除 User 連帶刪除其 Session（配合 AC-23 條件刪除）。
- 有效 Session 判定：`revokedAt IS NULL AND expiresAt > now()`。
- `mustChangePassword` 於 Session 上作為快照（登入當下），避免每請求回查 User；改密完成時同步更新（見 4.7.1）。

### 3.4 AuditLog

```prisma
enum AuditAction {
  USER_CREATED
  USER_DEACTIVATED
  USER_ACTIVATED
  USER_PASSWORD_RESET
  USER_DELETED
}

model AuditLog {
  id          String      @id @default(cuid())
  action      AuditAction
  actorId     String                             // 操作者（管理員）
  actor       User        @relation("AuditActor", fields: [actorId], references: [id])
  targetId    String?                             // 受影響使用者（刪除後可能為 null）
  target      User?       @relation("AuditTarget", fields: [targetId], references: [id])
  targetLabel String                             // 受影響資料可讀摘要（如 loginName 快照），供刪除後仍可辨識
  summary     Json?                               // 前後重要欄位摘要（絕不含密碼；見 4.7）
  createdAt   DateTime    @default(now())

  @@index([actorId])
  @@index([targetId])
  @@index([createdAt])
}
```

- `targetLabel` 保存受影響帳號的可讀識別（如 `loginName`）快照，使**刪除後**稽核仍可辨識（AD-US-04 刪除留紀錄）。
- `summary` 為 JSON，僅存非敏感的前後摘要（例：停用 `{ "isActive": { "from": true, "to": false } }`）；**嚴禁**任何密碼欄位。
- 本 Phase 稽核 action 僅涵蓋帳號管理事件；代操作/作廢/參數等於後續 Phase 擴充 enum（沿用同一 AuditLog 結構）。

### 3.5 不變式

- `passwordHash` 只寫不讀（除登入時內部比對）；任何序列化 User 的路徑一律排除該欄位。
- 一使用者可有多個 Session；停用/重設密碼 → 該使用者**全部** Session 失效。
- 刪除 User 前必須通過「無歷史」判斷（4.6）；通過後連帶 Session 由 Cascade 清除，AuditLog 以 `targetLabel` 保留可讀性（`targetId` 允許 null）。

---

## 4. 關鍵技術定案（每項附理由與替代方案）

### 4.1 密碼雜湊：**argon2id**（定案）

- **定案**：使用 `argon2`（node-argon2，napi 綁定 libargon2），演算法 **argon2id**。
- **參數起始值**（可於實作微調並記錄，屬內部決策）：`memoryCost≈19456 KiB (19 MiB)`、`timeCost=2`、`parallelism=1`。此為 OWASP 對 argon2id 的建議下限之一；salt 由函式庫自動產生（每密碼獨立），輸出為自描述編碼字串存入 `passwordHash`。
- **理由**：argon2id 為現代密碼雜湊首選（記憶體困難、抵抗 GPU/ASIC 破解），OWASP Password Storage Cheat Sheet 首推；自描述編碼便於日後調參與版本演進；成熟、MIT。
- **替代方案**：`bcrypt`（node bcrypt）— 成熟、純 JS 版可免原生編譯，但無記憶體困難、上限 72 bytes 截斷、抗硬體破解弱於 argon2id。**不採為主**，但列為回退：若 `argon2` 原生模組在 Node 20-slim 容器（見環境備註 openssl/build-essential）安裝困難無法解決，回退 `bcryptjs`（純 JS、無原生編譯）並記錄為 Accepted Risk（4.1 回退）。
- **依賴風險備註**：`argon2` 含 postinstall/原生編譯；依 PROJECT_STATE 環境備註，npm 11 會封鎖 postinstall，需 `npm approve-scripts` 並確認 `package.json` 的 `allowScripts`；容器需確認 build 階段可編譯（node:20 builder 已含工具鏈，slim runtime 只需複製 build 產物 + openssl）。此為 T2 需驗證項，若不可行走回退方案（交回大總管決策，屬第 12 節 High 決策 D1）。

### 4.2 Session 儲存後端：**DB session**（定案，回應 ARCHITECTURE 開放問題）

- **定案**：Session 狀態存於 **PostgreSQL `Session` 表**（上 3.3）。Cookie 僅帶 opaque token，後端每請求以 token 雜湊查 DB 取得 session 與使用者。
- **理由**：
  1. **停用/重設密碼即失效**（AC-20/22、BE-US-01/04、AD-US-03/05 硬需求）：DB session 可直接刪除/標記該使用者所有 session，立即且可靠生效；無需等 token 過期。
  2. 單副本部署（ADR-0001 Zeabur，MVP）已足夠，不需外部 store。
  3. 與既有 Prisma/Postgres 技術棧一致，無新增基礎設施。
- **取捨**：每受保護請求多一次 DB 查詢（可加 `sessionToken` 索引；效能於 NFR-US-14 目標內，PHASE-011 驗證）；相較 stateless JWT，DB session 換取「即時撤銷」能力，這是本專案安全需求的必要取捨。
- **替代方案**：
  - **記憶體 session**：重啟即失全部 session、無法多副本、不利可靠撤銷 → 不採。
  - **stateless JWT（簽章 Cookie）**：無 DB 查詢，但**難以即時撤銷**（停用/重設密碼後 token 仍有效至過期），與 AC-20/22 直接衝突 → 不採。
  - **外部 store（Redis）**：可即時撤銷且高效，但增加一個服務與部署複雜度，MVP 單副本不需要 → 不採（未來若多副本可評估，屬 PHASE-011 議題）。

### 4.3 Session ID 產生、Cookie 屬性、有效期與滑動策略（定案）

- **Token 產生**：以 `crypto.randomBytes(32)`（256-bit）產生高熵隨機值，base64url 編碼為原始 token 放入 Cookie。**DB 僅存該 token 的 SHA-256 雜湊**（`sessionToken` 欄位），避免 DB 外洩即得可用 token。（雜湊用途僅為查找對照，非密碼，故用 SHA-256 即可，不需慢雜湊。）
- **Cookie 名稱**：`sid`（不含語意，不透露框架）。
- **Cookie 屬性**（AC-28）：`HttpOnly`（JS 不可讀）、`SameSite=Lax`（同源，ADR-0001，防 CSRF 基礎）、`Path=/`、`NODE_ENV=production` 時加 `Secure`。不設 `Domain`（同源預設）。
- **有效期**：絕對到期 `expiresAt = createdAt + ABSOLUTE_TTL`（預設 **8 小時**，由 env `SESSION_ABSOLUTE_TTL_HOURS`，見第 8 節）。Cookie 的 `Max-Age`／`Expires` 對齊 `expiresAt`。
- **滑動策略**：採**輕量滑動**——每請求若距 `lastSeenAt` 超過門檻（預設 5 分鐘）則更新 `lastSeenAt`，並將 `expiresAt` 順延（滑動視窗，上限為絕對 TTL 之外的 idle 保護）。**MVP 定案採「絕對到期 + lastSeenAt 記錄」**，滑動順延 `expiresAt` 為可選增強；為避免過度設計與每請求寫 DB，**本 Phase 定案：僅絕對到期，`lastSeenAt` 更新採門檻節流（>5 分鐘才寫），不順延 `expiresAt`**。（若人類要求 idle timeout，屬第 13 節開放事項可加。）
- **CSRF**：同源 + `SameSite=Lax` + 狀態變更端點使用非 GET 方法為 MVP 基礎防護；完整 CSRF token 機制不在本 Phase（若需要列第 13 節）。

### 4.4 弱密碼清單來源與檢查方式（不引入付費服務，定案）

- **定案**：內建一份**靜態 top-N 常見弱密碼清單**（打包於 backend，來源為公開的常見密碼清單如 SecLists top 10k 之子集，經去識別、純字串，無授權疑慮），於改密/建密/重設時檢查。
- **檢查方式**：
  1. 長度 < 10 → 拒（AC-09）。
  2. 正規化（轉小寫、去前後空白）後**完全命中清單** → 拒為弱密碼。
  3.（可選增強，內部決策）拒絕「與 loginName/displayName 高度相同」的密碼。
- **不採線上服務**（如 HaveIBeenPwned range API）：MVP 不引入外部依賴/網路呼叫/隱私考量；靜態清單免費、離線、可測試、可版本控管。
- **清單規模**：預設 top 10,000（可由檔案調整，屬內部決策）；以雜湊集合（Set）載入，查找 O(1)。

### 4.5 登入失敗鎖定：計數存放與重置規則（定案）

- **計數存放**：於 `User.failedLoginCount` 與 `User.lockedUntil`（DB，非記憶體），確保多請求/重啟一致、可跨副本（雖 MVP 單副本）。
- **規則**（AC-14/15/16）：
  1. 登入**密碼錯誤** → `failedLoginCount += 1`。達 **5** 時設 `lockedUntil = now + 15 min`（`LOGIN_LOCK_MINUTES`、`LOGIN_MAX_FAILURES` 由 env，見第 8 節）。
  2. `lockedUntil` 為未來 → 一律拒登（即使密碼正確，AC-15），**不重置計時**（不因嘗試而延長，避免無限延鎖；到期即解）。
  3. **成功登入** → `failedLoginCount = 0`、`lockedUntil = null`。
  4. `lockedUntil` 已過去且再次嘗試 → 視為解鎖，計數自該次重新累計（實作：驗證前若 `lockedUntil` 已過，先清 `lockedUntil` 並將 `failedLoginCount` 視為 0 起算）。
- **4.5.1 統一錯誤訊息設計（安全關鍵）**：帳號不存在、密碼錯誤、帳號停用、帳號鎖定 → **全部回同一則 401 訊息**（AC-02）。實作要點：
  - 帳號不存在時，仍執行一次**假雜湊比對**（對固定 dummy hash 跑 argon2 verify）以拉平回應時間，避免以時間差推測帳號存在性。
  - 不因鎖定/停用回不同 code 或不同 HTTP 狀態。
  - 失敗計數僅對**存在的帳號**累加（不存在帳號不建列）；此不對外可見，不影響統一訊息。
- **4.5.2 鎖定與統一訊息的交互**：鎖定期間正確密碼被拒時，回應與一般失敗**無法區分**（同 AC-02 訊息），不透露「因鎖定」。
- **4.5.3 改密驗舊密碼錯誤的 code**：定案回 `code=UNAUTHORIZED`（語意：憑證不符）於 `POST /api/me/password`；與登入統一訊息不同情境（此處使用者已登入、明確是改密流程，可回較明確錯誤但仍不透露細節）。實作回 401 + message「目前密碼不正確」。
- **4.5.4 帳號建立併發**：`loginName @unique` 由 DB 保證；應用層先查再建之間若併發，DB 唯一鍵衝突 → 捕捉並轉 `CONFLICT`（AC-19），不外洩 DB 錯誤原文。

### 4.6 「有歷史拒刪」的歷史判斷點（本 Phase 明確範圍）

- AD-US-04 要求「有草稿/已完成/已作廢/報表資料則拒刪」。本 Phase **尚無申請資料表**（PHASE-004+）。
- **定案（不臆測）**：實作一個 `userHasHistory(userId)` 判斷點，本 Phase 的歷史來源集合定義為「該使用者名下之**申請/報表**資料」。由於這些資料表在本 Phase 不存在，`userHasHistory` **本 Phase 回傳 false**（無申請歷史），因此本 Phase 一般帳號皆可刪除。
- **不把 Session/AuditLog 當作「歷史資料」**：Session 為登入狀態、AuditLog 為稽核（且刪除後以 `targetLabel` 保留），兩者非 US 所指「申請或歷史資料」，故不阻擋刪除（否則任何登入過的帳號都無法刪，違反 AD-US-04「無歷史即可刪」原意）。
- `userHasHistory` 設計為**可擴充接點**：PHASE-004 起將申請資料表納入其判斷；PHASE-010 對「有歷史拒刪」做完整回歸（PROJECT_STATE 跨 Phase 追蹤已記）。此為對 US 的忠實落地，非縮減 AC——本 Phase 的 AC-23「有歷史拒刪」在有歷史來源出現後自動生效，本 Phase 先驗證判斷點與拒刪路徑（可用 stub/測試注入歷史來源驗證拒刪分支，見 9 測試策略）。

### 4.7 授權中介層設計（供後續 Phase 沿用的骨架 API）

以 Fastify plugin/decorator 形式落地，位於後端 `auth`/`authz` 模組（ARCHITECTURE 第 3 節）：

- **`requireAuth`**（preHandler）：驗證 Cookie → 查有效 Session → 載入 User → 掛 `request.currentUser = { id, role, mustChangePassword, isActive }`。無有效 session → 401 `UNAUTHORIZED`（AC-05/06）。若 User `isActive=false`（停用後 session 應已被撤銷，此為雙重保險）→ 401。
- **`requirePasswordChanged`**（preHandler，接在 requireAuth 後）：若 `currentUser.mustChangePassword` 為 true → 403 `PASSWORD_CHANGE_REQUIRED`（AC-04）。改密/登出/取得自身資訊端點**不掛**此中介。
- **`requireAdmin`**（preHandler，接在 requireAuth[+requirePasswordChanged] 後）：`role !== ADMIN` → 403 `FORBIDDEN`（AC-24）。
- **`assertOwnershipOrAdmin(actor, resourceOwnerId)`**（純函式/服務）：`actor.role===ADMIN || actor.id===resourceOwnerId` → 通過；否則丟 `AppError(FORBIDDEN,403,...)`（AC-25）。**此為後續 Phase 對申請/附件/報表資料隔離的統一判斷點**（BE-US-02）。
- **4.7.1 mustChangePassword 一致性**：Session 建立時快照 `mustChangePassword`；`requireAuth` 以 User 現值為準（避免管理員重設後舊 session 快照過期問題）——**定案以 User 現值判定**，Session 上的快照僅為觀測欄位，不作為權威。重設密碼會撤銷既有 session，故不存在「已登入 session 需強制改密」的常態；但 `requireAuth` 仍以 User `mustChangePassword` 為準，保證正確。

### 4.8 錯誤碼擴充（沿用 PHASE-001 錯誤協定慣例）

沿用 `AppError(code, httpStatus, message, fields?)` 與統一 body `{ error: { code, message, requestId, fields? } }`（PHASE-001 5.2）。於 `platform/errors.ts` 的 `ErrorCode` union **新增**：

| code | HTTP | 用途 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 未登入、session 失效、登入失敗（統一訊息）、改密舊密碼錯 |
| `FORBIDDEN` | 403 | 角色不足（requireAdmin）、資料擁有權不符 |
| `PASSWORD_CHANGE_REQUIRED` | 403 | 強制改密未完成時存取其他受保護端點 |
| `CONFLICT` | 409 | 帳號重複、有歷史拒刪 |

- `VALIDATION_ERROR`(400) 沿用既有（密碼規則、新舊相同等帶 `fields`）。
- 慣例維持：HTTP 語意 + SNAKE_CASE 業務碼；`message` 面向使用者、不外洩內部細節；`fields` 僅驗證錯誤出現。

---

## 5. API Contract（本 Phase 全部端點）

- 路徑經 nginx `/api` 反向代理至後端（去 `/api` 前綴，PHASE-001 定案）；下表為**後端實際 route**（前端呼叫加 `/api`）。
- 所有回應成功/錯誤皆為 JSON；錯誤一律統一格式（4.8）。
- **所有 User 回應 DTO 一律排除 `passwordHash`**。`UserDto = { id, loginName, displayName, employeeNumber, role, isActive, mustChangePassword }`。

### 5.1 認證

| 方法 | 路徑 | 中介 | Request | 成功回應 | 主要錯誤 |
|---|---|---|---|---|---|
| POST | `/auth/login` | 無 | `{ loginName, password }` | 200 `{ user: UserDto, redirect: "home"｜"change-password-forced" }` + `Set-Cookie: sid` | 401 `UNAUTHORIZED`（統一訊息，AC-02/15）；400 `VALIDATION_ERROR`（缺欄位） |
| POST | `/auth/logout` | requireAuth | 無 | 200 `{ ok: true }` + 清除 Cookie | 401 |
| GET | `/me` | requireAuth | 無 | 200 `{ user: UserDto }` | 401 |
| POST | `/me/password` | requireAuth（**不掛** requirePasswordChanged，供強制改密與自行改密共用） | `{ currentPassword, newPassword }` | 200 `{ ok: true }`（成功後 session 維持有效、mustChangePassword→false） | 401 `UNAUTHORIZED`（舊密碼錯，AC-10）；400 `VALIDATION_ERROR`（規則/新舊相同，AC-09/11） |

- **登入端點的 login 流程**（AC-01/02/03/14/15）：查帳號→（不存在則假比對後統一 401）→檢查 `lockedUntil`→驗密碼→依結果更新計數/鎖定→成功則清計數、建 Session、設 Cookie、依 `mustChangePassword` 回 `redirect`。
- **改密端點**（`/me/password`）**同時服務強制改密（AC-13）與自行改密（AC-10/11/12）**：一律驗 `currentPassword`（強制改密情境的 currentPassword 即臨時密碼）、驗新密碼規則、驗新舊不同、更新雜湊、`mustChangePassword=false`、`failedLoginCount=0/lockedUntil=null` 不受影響。**改密不撤銷當前 session**（使用者可續用），但**撤銷該使用者其他 session**（可選；MVP 定案：改密只更新當前流程，不強制撤銷其他 session——與「重設密碼撤銷全部 session」區分，因自行改密者為本人。若人類要求改密也撤其他 session，列第 13 節）。

### 5.2 管理員帳號管理（全部：requireAuth + requirePasswordChanged + requireAdmin）

| 方法 | 路徑 | Request | 成功回應 | 主要錯誤 |
|---|---|---|---|---|
| GET | `/admin/users` | query 可選（分頁本 Phase 可省，回全列表） | 200 `{ users: UserDto[] }` | 401 / 403 `FORBIDDEN` |
| POST | `/admin/users` | `{ loginName, displayName, employeeNumber?, temporaryPassword }` | 201 `{ user: UserDto }` | 409 `CONFLICT`（帳號重複，AC-19）；400 `VALIDATION_ERROR`（臨時密碼不合規/缺欄位） |
| POST | `/admin/users/:id/deactivate` | 無 | 200 `{ user: UserDto }` | 401/403/404 `NOT_FOUND` |
| POST | `/admin/users/:id/activate` | 無 | 200 `{ user: UserDto }` | 401/403/404 |
| POST | `/admin/users/:id/reset-password` | `{ temporaryPassword }` | 200 `{ user: UserDto }` | 401/403/404；400（臨時密碼不合規） |
| DELETE | `/admin/users/:id` | 無 | 200 `{ ok: true }` | 409 `CONFLICT`（有歷史，AC-23）；401/403/404 |

- 新增/重設密碼的 `temporaryPassword` 亦須通過密碼規則（≥10、非弱密碼）——建立即合規，避免臨時密碼過弱。
- `:id` 為 User `id`。管理員不得停用/刪除自己 → 定案：**禁止對自身 `id` 執行 deactivate/delete**（回 409 `CONFLICT` message「不可對自己執行此操作」），避免鎖死唯一管理員（見 4.5 / 第 13 節初始管理員種子）。
- 所有寫入操作成功後**寫 AuditLog**（第 4.7 / T10）。

### 5.3 錯誤回應範例（沿用 PHASE-001 5.2 形狀）

登入失敗（統一）：
```json
{ "error": { "code": "UNAUTHORIZED", "message": "帳號或密碼錯誤，或此帳號目前無法登入", "requestId": "req-..." } }
```
密碼規則：
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "輸入資料有誤，請檢查標示欄位。", "requestId": "req-...", "fields": [ { "field": "newPassword", "reason": "密碼至少需 10 個字元" } ] } }
```
帳號重複：
```json
{ "error": { "code": "CONFLICT", "message": "此登入帳號已被使用。", "requestId": "req-..." } }
```

---

## 6. 前端頁面規格

技術：React 18 + Vite（PHASE-001 已建立 SPA 骨架）。一律相對路徑 `/api/*` 呼叫（同源）。文案 zh-TW，響應式（桌機/平板/手機）。所有頁面具 **Loading / Empty / Error / Success / Permission denied** 五態。錯誤依統一 `error.code` 判讀（不硬編 message）。

### 6.1 路由與守衛

- 前端維持 session 狀態（以 `GET /api/me` 判定登入與角色與 `mustChangePassword`）。
- 未登入 → 導向 `/login`（對應 AC-05；前端攔截 401）。
- 已登入但 `mustChangePassword=true` → 強制導向 `/change-password-forced`，其他路由一律重導回此頁（對應 AC-04；前端攔截 403 `PASSWORD_CHANGE_REQUIRED`）。
- 一般使用者存取 admin 路由 → 顯示 **Permission denied** 態（對應 403 `FORBIDDEN`）。

### 6.2 登入頁 `/login`（FE-US-01）

- 欄位：登入帳號、密碼；送出鈕。
- **Loading**：送出中禁用按鈕、顯示載入指示。
- **Error**：任何登入失敗一律顯示**統一訊息**（不區分原因，AC-02），錯誤區塊在表單上方。
- **Success**：依回應 `redirect` 導向首頁或強制改密頁。
- **Empty/Permission denied**：登入頁無 Empty；已登入者進入自動導走。
- 響應式：單欄置中卡片，手機滿版。

### 6.3 強制改密頁 `/change-password-forced`（FE-US-02）

- 欄位：目前（臨時）密碼、新密碼、確認新密碼。
- 阻擋離開：此頁未完成前，導覽列/其他連結不可用或點擊重導回本頁。
- **Error**：規則錯（`VALIDATION_ERROR` 對 `newPassword` 顯示具體原因）、舊密碼錯（401 顯示「目前密碼不正確」）、新舊相同。
- **Success**：改密成功 → 導向首頁占位頁。
- 響應式同登入頁。

### 6.4 自行改密頁 `/change-password`（FE-US-03）

- 與強制改密頁相同表單，但可從首頁進入、可返回。
- 五態同上；成功後顯示成功提示並可返回首頁。

### 6.5 首頁占位頁 `/`（本 Phase 占位）

- 顯示目前使用者 `displayName`、`role`、登出鈕、（管理員）進入使用者管理入口。
- 實際「我的私車補助紀錄」列表於 PHASE-004。

### 6.6 管理員使用者管理 `/admin/users`（AD-US-01~05）

- **清單**（AD-US-01）：表格顯示登入帳號、顯示姓名、員工編號（空顯「—」）、角色、狀態（啟用/停用明確標示）。每列操作：停用/啟用、重設密碼、刪除。
  - **Loading**：載入中骨架/spinner。
  - **Empty**：無使用者時顯示空狀態 + 新增入口（實務上至少有管理員自己，Empty 主要為篩選後；本 Phase 可不做篩選，Empty 態仍需具備）。
  - **Error**：載入失敗顯示錯誤與重試。
  - **Permission denied**：一般使用者進入顯示 403 態。
- **新增使用者**（AD-US-02）：表單（登入帳號、顯示姓名、員工編號可空、臨時密碼）。
  - **Success**：新增成功刷新清單、提示「已建立，使用者首次登入須改密」。
  - **Error**：帳號重複（409）顯示「帳號已被使用」；臨時密碼不合規顯示 `fields` 原因。
- **啟用/停用**（AD-US-03）：切換按鈕；**Success** 後即時更新狀態標示；停用需提示「使用者將無法登入且既有登入即失效」。
- **重設密碼**（AD-US-05）：輸入臨時密碼；**Success** 提示「已重設，使用者下次登入須改密、既有登入已失效」；不回顯密碼。
- **刪除**（AD-US-04）：二次確認；無歷史 → **Success** 刪除並刷新；有歷史 → **Error**（409）顯示「此帳號已有資料，無法刪除，請改用停用」。
- 響應式：桌機表格；手機以卡片式每使用者一張卡，主要資訊與操作不因水平溢位而不可用（對應 FE-US-27 精神，雖 FE-US-27 主驗於 004/008）。

---

## 7. 稽核事件清單（本 Phase）

寫入 AuditLog 的操作（AC-26）、記錄欄位、密碼絕不入稽核（AC-27）。

| 事件 | AuditAction | actor | target | targetLabel | summary（非敏感） |
|---|---|---|---|---|---|
| 管理員新增使用者 | `USER_CREATED` | 管理員 id | 新使用者 id | 新使用者 loginName | `{ role, employeeNumber?（可空）}`（不含密碼） |
| 停用使用者 | `USER_DEACTIVATED` | 管理員 id | 使用者 id | loginName | `{ isActive: { from:true, to:false } }` |
| 啟用使用者 | `USER_ACTIVATED` | 管理員 id | 使用者 id | loginName | `{ isActive: { from:false, to:true } }` |
| 重設密碼 | `USER_PASSWORD_RESET` | 管理員 id | 使用者 id | loginName | `{ mustChangePassword: true }`（**不含任何密碼/雜湊**） |
| 刪除使用者 | `USER_DELETED` | 管理員 id | null（已刪） | 刪除前 loginName 快照 | `{ deletedLoginName }`（供追溯；不含密碼） |

- **不寫稽核**（本 Phase）：登入成功/失敗、登出、使用者自行改密——這些非 AD-US-14 列舉之「重要管理與代操作」事件，本 Phase 不寫（避免擴大 Scope；若人類要登入稽核，列第 13 節）。登入失敗保護以計數處理，不入 AuditLog。
- **密碼保證**：summary/targetLabel 建構程式碼**不引用任何密碼欄位**；並以測試斷言稽核 JSON 不含密碼鍵（9 測試策略安全測試）。

---

## 8. 環境變數新增清單

沿用 PHASE-001 第 6 節既有變數（`NODE_ENV`/`PORT`/`DATABASE_URL`/`STORAGE_PATH`/`LOG_LEVEL`/`VITE_*`/`POSTGRES_*`）。本 Phase **新增**（一律經 `config/env.ts` zod schema 驗證，`.env.example` 補上佔位）：

| 變數 | 使用者 | 必要性 | 預設 | 說明 |
|---|---|---|---|---|
| `SESSION_ABSOLUTE_TTL_HOURS` | backend | 選用 | `8` | Session 絕對到期時數。 |
| `LOGIN_MAX_FAILURES` | backend | 選用 | `5` | 觸發鎖定的連續失敗次數（NFR-US-09 定義為 5；env 化便於測試，正式維持 5）。 |
| `LOGIN_LOCK_MINUTES` | backend | 選用 | `15` | 鎖定分鐘數（NFR-US-09 定義 15）。 |
| `SESSION_COOKIE_NAME` | backend | 選用 | `sid` | Cookie 名稱。 |

- **`NODE_ENV=production` 驅動 Cookie `Secure`**（AC-28），沿用既有 `NODE_ENV`，不新增旗標。
- **不新增 `SESSION_SECRET`**：因採 DB opaque token（非簽章 Cookie），不需簽章密鑰。（若日後改簽章 Cookie 才需要——本 Phase 定案不需要，避免無用 secret。此為與常見範式的刻意差異，列第 12 節 High 決策供批准。）
- 弱密碼清單為打包靜態檔（非 env）；密碼雜湊參數為程式常數（可微調，非 env，屬內部決策）。
- 新增變數皆有安全預設，缺失不致啟動失敗（僅 `DATABASE_URL` 為硬性必要，沿用 PHASE-001）。

---

## 9. 測試策略

沿用 PHASE-001：Vitest（unit/integration），Fastify `inject`，CI 以 GitHub Actions `services: postgres:16` + `prisma migrate deploy`（第 9.3 PHASE-001）。TDD：先寫會失敗的測試再實作，不得 skip/弱化換綠燈。

### 9.1 unit / integration 界線

- **unit（不需 DB）**：密碼規則（長度/弱密碼命中）、雜湊 verify 純邏輯（可用小參數）、失敗計數/鎖定的純狀態轉移函式（給定 count/lockedUntil/now → 下一狀態）、`assertOwnershipOrAdmin` 判斷、統一錯誤訊息組裝、Cookie 屬性組裝（依 NODE_ENV）、`userHasHistory` 判斷點（以注入的歷史來源測 true/false 兩分支）。
- **integration（需 Postgres）**：登入全流程、session 建立/查詢/失效、停用/重設密碼撤銷 session、鎖定端到端、管理員 CRUD、稽核寫入、擁有權/角色中介於真實 route 的 401/403。

### 9.2 五態測試（前端，Vitest + Testing Library，mock fetch）

- 每頁 Loading/Empty/Error/Success/Permission denied 各一測試：
  - 登入頁：載入態、統一錯誤態、成功導向、（已登入自動導走）。
  - 強制改密頁：規則錯/舊密碼錯/新舊相同/成功、阻擋離開。
  - 使用者清單：loading skeleton、empty、載入 error、一般使用者 403 態。
  - 新增/停用/重設/刪除：成功刷新、409 錯誤態、二次確認。

### 9.3 安全測試（High 風險必測）

1. **統一錯誤訊息不可區分帳號存在性**（AC-02）：對「不存在帳號」「存在但密碼錯」「停用帳號」「鎖定帳號」四情境，斷言回應 **body、code、HTTP 狀態完全一致**；並以假雜湊比對驗證程式路徑存在（時間側信道以「路徑一致 + 假比對」保證，不做嚴格計時斷言以免測試不穩）。
2. **停用/重設密碼即 session 失效時序**（AC-20/22）：登入取得 session → 管理員停用/重設 → 立即以原 session 呼叫受保護端點應 401（同一測試流程內驗「立即」）。
3. **鎖定計時**（AC-14/15/16）：連續 5 次錯 → 第 6 次正確密碼仍拒；以可注入的 `now`（或 env 縮短鎖定分鐘 + 時間旅行）驗證到期後可再嘗試；不真等 15 分鐘（以注入時鐘）。
4. **密碼不入稽核/日誌**（AC-27）：建立/重設密碼後，讀 AuditLog 該筆 JSON 斷言不含 `password`/`temporaryPassword`/`passwordHash`/雜湊字串；以 `logStream`（PHASE-001 buildServer 已支援）擷取登入/改密日誌，斷言不含密碼與 Cookie 值（沿用 pino redact + `sanitizeForLog`）。
5. **HttpOnly/SameSite/Secure**（AC-28）：斷言 `Set-Cookie` 於 `NODE_ENV=production` 含 `HttpOnly; SameSite=Lax; Secure; Path=/`；非 production 無 `Secure`。
6. **資料擁有權/角色**（AC-24/25）：一般使用者呼叫 admin 端點 401/403；本人 `GET /me` 通過。

### 9.4 CI

- 沿用 PHASE-001 CI（lint/typecheck/test/frontend build/backend build/docker build）。後端新增 argon2（原生模組）→ CI Linux 需能編譯（node:20 有工具鏈）；若採 bcryptjs 回退則無此顧慮。整合測試沿用 Postgres service。
- 新增 migration 於 CI 測試前 `prisma migrate deploy`。

---

## 10. Task 拆分（對齊 PRD T1~T11）

對齊 PRD PHASE-002 T1~T11；下述為可實作定案。每 Task 一律 TDD、一個 atomic commit。High 標記依 CLAUDE.md（認證/授權/密碼/不可逆刪除/稽核）。

> **微調說明**：整體對齊 PRD T1~T11，未改變 Task 邊界與依賴語意。僅補齊各 Task 的產出/Done When/測試要求。T11（前端）依賴 T3、T7、T8、T9。

### T1 — User / Session / AuditLog 資料模型 + migration（依 PHASE-001）
- **目標**：於 `schema.prisma` 新增 §3 的 enum 與三 model；產生 `phase2_auth` migration。
- **產出**：`schema.prisma` 更新、`prisma/migrations/**`、`prisma generate`。
- **Done When**：`migrate deploy` 於測試 DB 建表成功；可對 User 寫入/查回（integration）；欄位/唯一性/關聯符合 §3。
- **TDD**：先寫「migration 後可建立 User（loginName 唯一衝突丟錯）、可建 Session 關聯、可建 AuditLog」的 integration 測試。
- **High**：否（資料模型；但為 High Phase 一部分，需事前批准後才動）。

### T2 — 密碼雜湊與密碼規則（依 T1）— **High**
- **目標**：`hashPassword`/`verifyPassword`（argon2id，4.1）、密碼規則檢查（≥10 + 弱密碼清單，4.4）、假雜湊比對工具（4.5.1）。
- **產出**：`auth` 模組密碼服務、弱密碼清單靜態檔、規則函式。
- **Done When**：雜湊不可逆且 verify 正確；規則對過短/弱密碼回具體 `fields`；日誌/回應不含明文（AC-08/09/27）。
- **TDD**：unit——弱密碼命中、長度邊界（9 拒/10 過）、hash≠明文、verify true/false、假比對不丟錯。
- **High**：是（密碼）。

### T3 — 登入/登出 + Session 建立/失效 + Cookie 安全屬性（依 T1, T2）— **High**
- **目標**：`/auth/login`、`/auth/logout`、`/me`、Session 建立（opaque token + 雜湊存 DB）、Cookie 屬性依 `NODE_ENV`（4.3）、統一登入錯誤訊息（4.5.1）。
- **產出**：auth routes、session 服務、cookie 組裝。
- **Done When**：AC-01/02/06/07/28 綠；統一訊息四情境一致（安全測試 9.3.1）。
- **TDD**：integration——成功登入設 Cookie、四情境統一 401、登出後 session 失效、Cookie 屬性斷言。
- **High**：是（認證/session）。

### T4 — 登入失敗鎖定（5 次/15 分鐘）（依 T3）— **High**
- **目標**：失敗計數、`lockedUntil`、鎖定期間正確密碼亦拒、重置規則（4.5）；env `LOGIN_MAX_FAILURES`/`LOGIN_LOCK_MINUTES`。
- **產出**：登入流程整合鎖定狀態機。
- **Done When**：AC-14/15/16 綠（以注入時鐘測到期）。
- **TDD**：unit 狀態轉移 + integration 端到端鎖定（含正確密碼被拒、鎖定與統一訊息不可區分）。
- **High**：是。

### T5 — 認證中介層 requireAuth（+ requirePasswordChanged）（依 T3）— **High**
- **目標**：`requireAuth`（驗 session、掛 currentUser、停用即拒）、`requirePasswordChanged`（強制改密未完成阻擋，AC-04）。
- **產出**：`authz` preHandler decorators。
- **Done When**：AC-04/05/06/20（停用即失效由 T9 觸發、此處驗中介拒絕）綠。
- **TDD**：integration——無 cookie 401、失效 session 401、mustChangePassword 存取他端點 403。
- **High**：是（授權）。

### T6 — 授權中介層骨架 requireAdmin + 擁有權判斷點（依 T5）— **High**
- **目標**：`requireAdmin`（AC-24）、`assertOwnershipOrAdmin`（AC-25，供後續 Phase）。
- **產出**：`authz` 角色與擁有權 API。
- **Done When**：一般使用者打 admin 端點 403；擁有權判斷 true/false 正確。
- **TDD**：unit 判斷函式 + integration 角色守門。
- **High**：是（授權）。

### T7 — 首次登入強制改密流程（依 T3）— **High**
- **目標**：`mustChangePassword` 登入導向 `change-password-forced`；改密完成解除限制、臨時密碼失效（AC-03/13）；`/me/password` 服務強制改密情境。
- **產出**：改密端點（與 T8 共用）強制情境分支、session 限制邏輯。
- **Done When**：AC-03/04/13 綠。
- **TDD**：integration——臨時密碼登入回強制導向、限制期存取他端點 403、改密後可進首頁、臨時密碼再登入失敗。
- **High**：是（密碼/認證）。

### T8 — 自行改密（驗舊密碼、新舊不同）（依 T2, T3）— **High**
- **目標**：`/me/password` 自行改密：驗舊密碼、規則、新舊不同、舊密碼失效（AC-10/11/12）。
- **產出**：改密端點主邏輯。
- **Done When**：AC-10/11/12 綠。
- **TDD**：integration——舊密碼錯 401、新舊相同 400、成功後舊密碼登入失敗/新密碼成功。
- **High**：是（密碼）。

### T9 — 管理員：清單/新增/啟停/重設密碼/條件刪除（依 T5, T6）— **High**
- **目標**：`/admin/users` 全部端點（§5.2）；帳號重複 409；停用/重設撤銷既有 session；條件刪除（4.6 判斷點）；禁對自身停用/刪除。
- **產出**：users 模組 routes + 服務 + session 撤銷。
- **Done When**：AC-17~23 綠；停用/重設即 session 失效（9.3.2）；有歷史拒刪分支（以注入歷史來源測）。
- **TDD**：integration——CRUD、409 重複、409 有歷史、停用後原 session 401、重設後原 session 401。
- **High**：是（重設密碼、不可逆刪除、授權）。

### T10 — 稽核寫入基礎（依 T9）— **High**
- **目標**：新增/停用/啟用/重設密碼/刪除寫 AuditLog（§7）；密碼絕不入稽核（AC-26/27）。
- **產出**：audit 模組寫入服務 + 各 admin 操作接線。
- **Done When**：五事件各寫一筆、欄位齊備、JSON 不含密碼；刪除後 `targetLabel` 仍可辨識。
- **TDD**：integration——各操作後查 AuditLog 斷言內容 + 不含密碼鍵。
- **High**：是（稽核可追溯）。

### T11 — 前端登入/改密/使用者管理頁（依 T3, T7, T8, T9）
- **目標**：§6 全部頁面與五態、路由守衛（401→login、403 PASSWORD_CHANGE_REQUIRED→強制改密、403 FORBIDDEN→權限態）、zh-TW、響應式。
- **產出**：前端頁面、API client、路由守衛、五態元件。
- **Done When**：AC-29 綠（前端五態測試 9.2）；Mock Gate 可驗互動與版面。
- **TDD**：Vitest + Testing Library，各頁五態 mock fetch 測試先紅後綠。
- **High**：否（UI；但依賴 High 後端；Mock Gate + 整合 Gate 驗收）。

---

## 11. Rollback

- 本 Phase 新增資料表（User/Session/AuditLog）、端點與前端頁面，於 phase-002 branch 實作、Draft PR。
- **開發期回滾**：以分支還原至 base commit `3e16155`；開發資料為合成資料，dev/CI DB 可整庫重建，無正式資料風險。
- **migration 回滾**：提供對應 down（`prisma migrate` 產生的 migration 可於無正式資料時直接重置 `migrate reset`）；本 Phase 為首批業務資料表，尚無正式資料，回滾風險低。
- **不可逆操作**：本 Phase 的「永久刪除使用者」在正式環境為不可逆，但受 4.6 判斷點保護（有歷史拒刪）；開發期以合成資料，回滾不受影響。
- 若已合併且已有真實使用者資料後需回滾：須保留 migration 前向相容或以 down migration 復原，並確保 AuditLog `targetLabel` 對已刪帳號的追溯不受破壞（正式階段回滾為人類決策，非本 Phase 自動化）。

---

## 12. High 風險決策彙整清單（人類批准用）

每項一句話 + 影響。**未經人類批准不得將本 Spec 轉 ACTIVE、不得實作。**

| # | 決策 | 影響 |
|---|---|---|
| D1 | 密碼雜湊採 **argon2id**（回退 bcryptjs 若原生模組於容器不可行） | 憑證安全強度；依賴含原生編譯/postinstall，需容器與 npm approve-scripts 驗證。 |
| D2 | Session 採 **DB opaque token**（非 JWT），**不設 SESSION_SECRET** | 換取「停用/重設密碼即時撤銷」能力（安全硬需求）；每請求一次 DB 查詢；無簽章密鑰。 |
| D3 | **統一登入錯誤訊息**（不存在/密碼錯/停用/鎖定同一則 401 + 假雜湊比對拉平時間） | 不透露帳號存在性/停用/鎖定（NFR-US-09/FE-US-01 安全）；犧牲對使用者的精確提示。 |
| D4 | 登入失敗 **5 次鎖 15 分鐘**、鎖定期間正確密碼亦拒、到期自動解、成功即歸零 | 防暴力破解；被鎖使用者 15 分鐘內無法登入（含正確密碼）。 |
| D5 | Cookie `HttpOnly`+`SameSite=Lax`+`Path=/`，**`Secure` 依 `NODE_ENV=production` 切換** | 正式防竊取/CSRF 基礎；本機 HTTP 開發可用（NFR-US-11 Cookie 面）。 |
| D6 | **弱密碼採內建靜態 top-10k 清單**（離線、不引外部服務），密碼 ≥10 字元 | 符合 NFR-US-08；不引付費/網路依賴；清單覆蓋面有限（非即時 breached 資料）。 |
| D7 | 「有歷史拒刪」歷史來源本 Phase 定義為**申請/報表資料**（尚不存在，故本 Phase 一般帳號可刪）；Session/AuditLog 不算歷史 | 忠實落地 AD-US-04「無歷史即可刪」；完整回歸待 PHASE-004+/PHASE-010（已於跨 Phase 追蹤）。 |
| D8 | **禁止管理員對自己停用/刪除**（回 409） | 避免鎖死唯一管理員；管理員無法自我停用/刪除。 |
| D9 | 初始管理員以**種子（seed）建立**（見 13.1），非由本系統 UI 自助註冊 | 系統無公開註冊；首個管理員憑證由部署時人類設定（正式須改密）。 |
| D10 | 自行改密**不強制撤銷本人其他 session**（重設密碼才撤全部） | 本人改密不打斷自己其他裝置；與管理員重設語意區分。 |
| D11 | 本 Phase **不對登入成功/失敗/登出/自行改密寫 AuditLog**（僅帳號管理事件） | 對齊 AD-US-14 列舉範圍、不擴大 Scope；登入軌跡稽核若需要另議。 |

---

## 13. 已知限制與開放事項

### 13.1 需人類確認或後續 Phase 定案（本 Phase 已給預設，標示可調整）

1. **初始管理員種子**：本系統無公開註冊（D9）。定案：提供 `prisma` seed 或一次性建立腳本，讀 env（如 `SEED_ADMIN_LOGIN`/`SEED_ADMIN_PASSWORD`，僅本機/首次部署用，`mustChangePassword=true`）。**種子 env 屬 secrets，不進版控、正式由平台提供、首登即改密**。此為達成「管理員建帳號」流程的前置；**需人類確認種子機制與正式初始憑證流程**（列為 Blocking-lite：不阻擋 T1~T10 開發，但整合驗收「以管理員登入」需先有管理員）。建議實作一個 `npm run seed:admin`（僅在無任何 ADMIN 時可執行），細節於 T9 或獨立小步交付，人類批准。
2. **Idle timeout / 滑動順延**：本 Phase 定案僅絕對到期（8h）+ `lastSeenAt` 節流記錄，不順延 `expiresAt`。若人類要 idle 逾時登出，需加規則（開放）。
3. **完整 CSRF token**：MVP 以同源 + SameSite=Lax + 非 GET 變更為基礎防護；是否加 double-submit/synchronizer token 於 PHASE-011 硬化評估（開放）。
4. **登入軌跡稽核**：D11 不寫登入稽核；若合規需要登入/登出稽核，列後續。
5. **argon2 參數調校與升級路徑**：起始參數見 4.1；正式硬體上的實際延遲與 20 併發（NFR-US-14）於 PHASE-011 量測調整。
6. **Rate limit（IP 層）**：本 Phase 僅帳號層失敗鎖定；IP/全域 rate limit 屬 PHASE-011 硬化（開放）。

### 13.2 已知限制（本 Phase 刻意不做，非缺陷）

- HTTPS 部署本體、Secure 憑證由 Zeabur/PHASE-011；本 Phase 僅 Cookie `Secure` 屬性切換。
- 無 Email 密碼重設（Out of Scope）；密碼重設僅管理員設臨時密碼。
- 申請資料相關授權（附件/報表擁有權）於 PHASE-003/004 以本 Phase `assertOwnershipOrAdmin` 骨架落地。
- 分頁未於 `/admin/users` 實作（使用者數量 MVP 規模小）；若需要屬內部增強。

---

## 14. 附錄 — Task 依賴圖

```
T1（User/Session/AuditLog + migration）
 └─▶ T2（密碼雜湊/規則）── High
       └─▶ T3（登入/登出/session/cookie）── High
             ├─▶ T4（失敗鎖定）── High
             ├─▶ T5（requireAuth/requirePasswordChanged）── High
             │     └─▶ T6（requireAdmin/擁有權判斷點）── High
             │           └─▶ T9（管理員 CRUD/重設/條件刪除）── High
             │                 └─▶ T10（稽核寫入）── High
             ├─▶ T7（強制改密流程）── High
             └─▶ T8（自行改密）── High
                                   T11（前端登入/改密/使用者管理）← 依 T3,T7,T8,T9
```

建議順序：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11（T7/T8 可於 T3 後、T9 前並行；T11 於後端端點就緒後）。
