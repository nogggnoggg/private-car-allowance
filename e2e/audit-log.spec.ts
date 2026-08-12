/**
 * E2E: 稽核檢視端到端 Gate — PHASE-010-T8（AC-19 四小項）
 * （Spec `docs/specs/PHASE-010.md` §2.F AC-19 :307-311）
 *
 * AC-19 逐字（:307-311）：
 *   (a) `e2e/audit-log.spec.ts`（新）：以管理員登入 → 執行一次真實管理操作
 *       （建立帳號）與一次真實作廢 → 進入稽核頁 → 該兩事件可見且四要素正確。
 *   (b) 篩選一次（依 `action`）後列表確實收斂；分頁至第 2 頁後列不重複。
 *   (c) 375px 寬度下列表零水平溢位（沿 PHASE-009 AC-36 慣例）。
 *   (d) 播種冪等（重跑不累積失敗）。
 *
 * ---------------------------------------------------------------------------
 * 五個測試（宣告序即執行序，`mode: "serial"`）
 * ---------------------------------------------------------------------------
 *   1. `AC-19(a): 管理員真實作廢 → 首頁入口進稽核頁 → 建立帳號／申請作廢兩事件
 *      可見且四要素正確`
 *   2. `AC-18(e)／MG-3 回歸（負向）: 稽核頁零內部識別碼（cuid）呈現`
 *   3. `AC-19(c): 375px——稽核列表／異動明細表／長作廢原因零水平溢位`
 *   4. `AC-19(b): 依 action 篩選確實收斂（值層中文化）＋ 起訖日以台北日曆日收斂`
 *   5. `AC-19(b): 分頁至第 2 頁且兩頁列不重複`
 *
 * 測試 5 之播種（見下方「分頁素材」）刻意排在**最後**：其新增之稽核列會成為
 * 全表最新列，若提前執行會把測試 1~3 所斷言之兩事件擠出第 1 頁。
 *
 * ---------------------------------------------------------------------------
 * 上游 FW 核銷（Packet 逐項）
 * ---------------------------------------------------------------------------
 *   **FW-A（FE 複審：一律中文標籤與中文值）**
 *     · `action` 一律以**中文標籤**斷言與操作（`selectOption({ label })`），
 *       全檔零 `APPLICATION_VOIDED`／`USER_CREATED` 等 enum 字面之畫面斷言。
 *     · **值層**亦一律中文：`role` → 「一般使用者」、`type` → 「差旅補助」、
 *       `fuelType` → 「柴油」（三個不同枚舉家族，AC-18(d) 之值層中文化；油種由
 *       `95 無鉛汽油` 改為 `柴油` 之理由見「T8R 跨 spec 共享軸隔離」）。
 *       **本檔刻意不涵蓋布林「是／否」**：其唯一真實來源為
 *       `USER_DEACTIVATED`／`USER_ACTIVATED` 之 `{isActive:{from,to}}`，而
 *       AC-19(a) 指定之真實管理操作恰為「建立帳號」一項；為此加開停用／啟用
 *       兩次額外管理操作會多寫兩列稽核並改變最新列順序（連帶影響測試 1~3 之
 *       第 1 頁定位）。該面之覆蓋由 T6 之
 *       `AuditChangesList.test.tsx` 14 值守門承擔，非本檔缺口。
 *
 *   **FW-B（BE2 即審 FW-3：日界 flaky）**
 *     全檔**零「今天」、零容器 UTC 日期**之篩選組法。唯一的日期篩選（測試 4）
 *     之日期字串**由該列自己畫面上的「操作時間」反推**——瀏覽器 context 固定
 *     `timezoneId: "Asia/Taipei"`，故該值即台北日曆日，與後端 AC-02(e)／MG-2
 *     之台北日界（`dateFrom` 台北 00:00 ＝ 前一日 16:00Z）定義一致。台北
 *     00:00-08:00 執行亦不錯位：日期取自事件本身而非時鐘。
 *     負向對照取**該日前一日**（`Date.UTC` 進位，跨月／跨年安全）。
 *
 *   **FW-C（MG-3 後現況：畫面零內部編號）**
 *     · `targetLabel` 之斷言一律為**裁切後**之顯示值（`loginName（顯示名稱）`），
 *       不期待 `#<cuid>` 尾段出現（`APPLICATION_VOIDED` 之 wire 值為
 *       `${ownerLoginName}#${applicationId}`，`AuditLogPage.tsx`
 *       :149-152 `truncateAtFirstHash`）。
 *     · 異動明細**恰三列**（`申請類型`／`作廢原因`／`作廢時間`）——`applicationId`
 *       屬 `HIDDEN_INTERNAL_ID_FIELDS` 而不渲染（`AuditChangesList.tsx` :189）；
 *       另有「零『申請編號』列」之逐字負向。
 *     · 測試 2 為**反向格**：整頁零 cuid 樣式字面，且本次執行之兩個已知 cuid
 *       （使用者 id／申請 id）逐字不出現。
 *
 *   **FW-D（T7 既有掛鉤）**
 *     清單一律以 `getByRole("list", { name: "稽核紀錄清單" })` 取得（T7 之
 *     `aria-label`）；篩選欄一律以 label 對應之 `#audit-filter-*` 取得
 *     （操作類型／操作者／受影響對象／起日／迄日五欄，`AuditLogPage.tsx`
 *     :318-386）。
 *
 *   **FW-E（篩選操作：使用者下拉，SF-1 後）**
 *     `actorId`／`targetId` 為 `<select>`（非文字輸入）。本檔對其只做
 *     **結構性**斷言（測試 4：兩欄為 `select`、選項文字為
 *     `顯示名稱（登入帳號）`、且**零 cuid 文字**），不以 cuid 硬填。AC-19(b)
 *     指定之「篩選一次」以 `action` 維度執行。
 *
 *   **FW-F（期中 #2 AR-5／FE 複審：375px 走查面）**
 *     測試 3 於 375px 下涵蓋：稽核列表本體、**異動明細表**、**長作廢原因**
 *     （171 字連續中文）。斷言為 `document.documentElement` 之
 *     `scrollWidth <= clientWidth`（body 零水平溢位）；明細表之長值若需橫向
 *     捲動，須捲於 `.table-scroll` 內（該 wrapper 自身之寬度亦斷言不超過視埠）。
 *
 *   **FW-G（E2E 慣例）**
 *     login helper／`API_BASE` 直呼播種／`RUN_ID` 隔離／`afterAll` best-effort
 *     清理，一律沿 `void-application.spec.ts`（PHASE-009-T17）與
 *     `report-pdf.spec.ts`（PHASE-008-T15）既有寫法。E2E 帳密 `e2eadmin`；
 *     `e2e/` 不入 `tsc`（既有 D-6 債），型別正確性由 Playwright 執行背書。
 *
 * ---------------------------------------------------------------------------
 * AC-19(d) 播種冪等——三道
 * ---------------------------------------------------------------------------
 *   1. **`RUN_ID` 隔離**：合成使用者名含時間戳 ＋ 亂數後綴，每次執行皆為全新
 *      使用者，重跑不互撞（沿 T17 FW-7）。
 *   2. **全域參數先查後建**（`ensureFuelPriceCovers`／`ensureEtcCovers`）：
 *      已覆蓋即不再寫入。
 *   3. **分頁素材「先量後補」**（測試 5）：先以唯讀查詢取得
 *      `油耗資料異動` 之現有筆數，僅補到 21 筆為止（`PAGE_SIZE = 20`，故 21 筆
 *      即保證第 2 頁存在）。首次執行補 N 筆、再次執行補 0 筆——重跑不累積、
 *      不失敗。
 *
 *   **清理之界限**（沿 T17 FW-7 同義）：合成使用者名下恆有**已作廢**申請，
 *   `userHasHistory` 使 `DELETE /admin/users/:id` 恆 409，故 `afterAll` 之刪除
 *   為 best-effort；稽核列本身依 AC-11「稽核不可變」**永不刪除**（本檔亦不得
 *   嘗試刪除）。重跑之互不干擾由 `RUN_ID` 保證，殘留素材之最終清理靠 Phase
 *   邊界之 dev DB 重置。
 *
 * ---------------------------------------------------------------------------
 * 分頁素材為何取「油耗資料異動」
 * ---------------------------------------------------------------------------
 * AC-19(b) 之「列不重複」須以**列的呈現內容**為身分（畫面上無 id 屬性可用）。
 * 若取未篩選之全表，第 1／2 頁交界可能落在兩列「呈現內容恰好相同」的環境既有
 * 列上（MG-3 隱藏 `applicationId` 之後，同秒、同操作者、同型別之兩筆代建立事件
 * 畫面完全同形），會產生**假紅**。改以 `油耗資料異動` 為篩選面後，每列必含
 * 「生效日」子欄且本檔補列之生效日彼此相異（`2030-01-01` 起逐日遞增）、環境
 * 既有列之 `targetLabel`（登入帳號）亦逐次執行相異，列內容因而結構性唯一。
 * 此舉同時滿足 (b) 之前半「篩選一次後列表確實收斂」與後半「分頁不重複」。
 *
 * ---------------------------------------------------------------------------
 * T8R 跨 spec 共享軸隔離（Phase 邊界 fresh-DB 自舉揭露；2026-08-10）
 * ---------------------------------------------------------------------------
 * **T8R 首輪紅燈**（fresh DB 全套首輪）：`fuel-model.spec.ts` 情境5 紅——
 * `合計金額：760` vs 手算期望 `360`（serial 連帶 1 did not run，53 passed）；
 * 單獨重跑 fuel-model 仍紅（該軸已被寫入，非一次性競態）。
 *
 * **根因（實查覆核）**：油價是**全站共享時間軸**，`findEffectiveVersion` 取
 * 「`effectiveFrom` ≤ 出差日之**最新**版本」——支配權由**日期大小**決定，
 * **與建立先後無關**。本檔原在 `fuel-model.spec.ts` 之手算軸（`GASOLINE_95`）
 * 上以 `2020-06-01` 播種 `65.0000`，日期晚於該檔之 `2020-01-01`／`30.0000`
 * （:64-68），因而恆為生效版本。算術逐項對得上：
 *   · 該檔手算前提 `STAFF_FUEL_UNIT_PRICE = ROUND(30.0000 ÷ 10.0000) = 3`（:89）
 *   · 被本檔蓋掉後之實際單價 `ROUND(65.0000 ÷ 10.0000) = 7`（0.5 進位）
 *   · 差額 `(7 − 3) × TRIP_TOTAL_KM(100) = 400`，恰為 `760 − 360`
 *     （ETC 側 `1.2 × 50 = 60` 兩邊相同——該檔 ETC 已於 T13R 動態化，未受害）。
 * PHASE-009 之 50/50 通過因當時無本檔；此為本檔引入之跨 spec 汙染，非產品缺陷。
 *
 * **修法（哨兵日為主、軸分離為輔；僅動本檔）**：全 `e2e/` 實查後確認
 * **`fuel-model.spec.ts` 情境5 是全套唯一硬編「油價推導金額」之處**——
 * `mileage-statistics.spec.ts` :64 與 `travel-application.spec.ts` :75 皆自載其
 * 播種值與金額無關（前者只斷言公里數，後者只斷言 `/合計金額：\d+/` 與 `>0`），
 * `admin-applications.spec.ts` 同為先查後建且零金額斷言。
 *
 *   · **主要保護＝哨兵日**（`FUEL_PRICE_EFFECTIVE_FROM`，見其 JSDoc）：本檔油價
 *     播種之 `effectiveFrom` 恆早於全 `e2e/` 任一油價常數，故**只要同軸另有任何
 *     spec 播種，本檔之版本必然落敗**——承重的是這一條。它與油種無關，因而同時
 *     擋住未來新 spec 在**任一**軸上的同型再犯。
 *   · **輔助保護＝軸分離**（`FUEL_TYPE = "DIESEL"`）：離開 fuel-model 情境5 之
 *     手算軸 `GASOLINE_95`，把「本檔與唯一金額硬編處相遇」的機會降為零。
 *
 * **【T8R-DOC／SF-1 更正】**：本段原稱「`DIESEL` 軸唯一使用者為
 * `mileage-statistics.spec.ts`」，**係事實錯誤**——肇事檔 `fuel-model.spec.ts`
 * 自己就是該軸之共用者（`FUEL_PRICE_BY_TYPE` :70 含 `DIESEL: "24.0000"`，
 * 情境1 :329 建立、:345-351 斷言），T8R 之「全 e2e 實查」恰恰漏掉了肇事檔本身。
 * 據實表述應為：
 *   · `DIESEL` 軸**另有** `fuel-model.spec.ts` 情境1 共用；惟其冪等守衛
 *     （`fuelPriceVersionExists` :138-143）為 **(油種, 生效日) 精確比對**、其斷言
 *     （:345-351）為**存在式**（`getByText(價格)`／`getByText(生效日)` 各
 *     `toBeVisible`，非計數、非排他），故本檔多出之一列對其**零影響**
 *     （T8R 探針已實跑背書：注入本檔之 `DIESEL @ 2010-01-01` 後情境1 仍綠）。
 *   · `mileage-statistics.spec.ts` 為該軸唯一之**金額相關性**使用者，且 :64 明文
 *     與金額無關。
 * 原敘述亦把風險排序寫反（稱軸分離「已足夠」、哨兵日為「第二保險」）——真正
 * 承重者是哨兵日，已於上方改列主要保護。
 *
 * **ETC 軸刻意不動**：本檔之 ETC 播種（`2020-06-01` ／ `1.8`）與
 * `void-application.spec.ts` :122／:126 逐字同型同值，屬既存且已隨 PHASE-009
 * 全綠之形狀；且全套唯一依賴 ETC 單價之手算（fuel-model 情境5）已於 T13R
 * 改為動態解析，結構上免疫。無證據支持的更動不做（最小修正）。
 *
 * **本檔零金額斷言**，故上述改動對本檔自身之綠燈判準零影響。
 *
 * ---------------------------------------------------------------------------
 * 首輪紅燈（TDD 紅燈物證，2026-08-10 實跑）
 * ---------------------------------------------------------------------------
 * 首次執行本檔：測試 1~3 綠、**測試 4 紅**——
 * `expect(filteredTotal).toBeLessThan(unfilteredTotal)`：`Expected: < 50 /
 * Received: 50`。成因為**讀值時序**而非產品缺陷：`.pagination` 之「共 N 筆」是
 * 一次性讀值，原本只等「清單可見」即讀，於篩選後之 `loading → ready` 轉換完成
 * 前讀到**上一次**查詢之 total（50 為未篩選總數），使「收斂」之強斷言恆等。
 * 修法見 `applyFilters`／`applyActionFilter`：以該次請求之回應為同步點，再加
 * 一道「清單零非該類型列」之重試型斷言。**斷言強度零弱化**（仍為嚴格
 * `toBeLessThan`），只修同步點。
 *
 * ---------------------------------------------------------------------------
 * Topology / Test account
 * ---------------------------------------------------------------------------
 * 大總管維護之 dev 拓撲（backend :3000、Vite :5173）；管理員 `e2eadmin`；
 * 合成使用者 `e2e-audit-<RUN_ID>`。
 */

import { type Locator, type Page, expect, test } from "@playwright/test";
import { generateRunSuffix, loginAsAdmin, uploadAttachment } from "./helpers";

const E2E_ADMIN = { loginName: "e2eadmin", password: "E2eAdmin@456!" };
const BASE = "http://localhost:5173";
const API_BASE = "http://localhost:3000";

/** `AuditLogPage.tsx` :143 之 `PAGE_SIZE`（前端固定值，非可調參數）。 */
const PAGE_SIZE = 20;

/** 第 2 頁存在所需之最小筆數。 */
const MIN_ROWS_FOR_PAGE_2 = PAGE_SIZE + 1;

// ---------------------------------------------------------------------------
// 中文標籤（FW-A：全檔零 enum 字面之畫面斷言）
// ---------------------------------------------------------------------------
/** `AuditLogPage.tsx` :114-125 `AUDIT_ACTION_LABELS` 實查逐字。 */
const LABEL_USER_CREATED = "新增使用者";
const LABEL_APPLICATION_VOIDED = "申請作廢";
const LABEL_FUEL_VERSION_CREATED = "油耗資料異動";

// ---------------------------------------------------------------------------
// 播種常數
// ---------------------------------------------------------------------------
const RUN_ID = generateRunSuffix();

const STAFF_TEMP_PASSWORD = "TempPw@2026Audit!";
const STAFF_NEW_PASSWORD = "NewPw@2026Audit!";

const PARAM_EFFECTIVE_FROM = "2020-06-01";

/**
 * FW-A：值層中文化之第三個枚舉家族（`柴油`）。
 *
 * **T8R 跨 spec 共享軸隔離之「輔助保護」**（主要保護為
 * `FUEL_PRICE_EFFECTIVE_FROM` 之哨兵日，見其 JSDoc）：本檔刻意**不用**
 * `GASOLINE_95`——該軸為 `fuel-model.spec.ts` 情境5 之手算基準
 * （`STAFF_FUEL_TYPE` :65 ＋ `STAFF_FUEL_UNIT_PRICE = 3` :89）。
 *
 * **`DIESEL` 軸並非本檔獨占**（T8R-DOC／SF-1 更正 T8R 之事實錯誤——原稱
 * 「唯一使用者為 `mileage-statistics.spec.ts`」，漏掉肇事檔本身）：
 *   · `fuel-model.spec.ts` 情境1 **亦共用**本軸（`FUEL_PRICE_BY_TYPE` :70 之
 *     `DIESEL: "24.0000"`，:329 建立、:345-351 斷言）。惟其冪等守衛
 *     （`fuelPriceVersionExists` :138-143）為 **(油種, 生效日) 精確比對**——不因
 *     本檔存在而略過自建；其斷言為**存在式**（各 `toBeVisible`，非計數、非排他）
 *     ——不因本檔多出一列而 strict violation。故對其**零影響**（T8R 探針實跑
 *     背書：注入 `DIESEL @ 2010-01-01 / 65.0000` 後情境1 仍綠）。
 *   · `mileage-statistics.spec.ts` 為本軸唯一之**金額相關性**使用者，:64 明文
 *     「與油資金額無關……播種數值無需與任何舊制單價換算等值」（僅斷言公里數）。
 *     **精確表述**：本檔之 `2010-01-01` 列會因該檔之 covers 語意（:209 之
 *     `effectiveFrom <= dateStr`）**抑制其自建** `DIESEL @ 2021-01-01`，故並非
 *     「對其零影響」，而是**對其斷言零影響**——受影響的只有單價數值，而該檔
 *     不對金額作任何斷言（實跑背書：6/6 綠）。
 */
const FUEL_TYPE = "DIESEL";

/**
 * **T8R**：本檔之油價播種**專用**生效日，刻意早於全 `e2e/` 任一 spec 之油價
 * 常數（現行最早為 `fuel-model.spec.ts` :64 之 `2020-01-01`）。
 *
 * 成因：油價為**全站共享時間軸**，`findEffectiveVersion` 取「`effectiveFrom`
 * ≤ 出差日之**最新**版本」，故支配權由**日期大小**決定，**與建立先後無關**。
 * 本檔原以 `PARAM_EFFECTIVE_FROM`（`2020-06-01`）播種，日期晚於 fuel-model 之
 * `2020-01-01`，因而**結構性**蓋掉該檔手算前提（見檔頭「T8R 首輪紅燈」）。
 * 取一個恆為最早之哨兵日後，本檔之版本在任何其他 spec 也播種同軸時**必然落敗**，
 * 僅在該軸完全空白時才生效（此時本檔之差旅得以完成，且無人依賴該軸金額）。
 *
 * **本條為主要保護、`FUEL_TYPE` 之軸分離為輔**（T8R-DOC 更正 T8R 原文之風險
 * 排序倒置——原稱「軸分離已足夠，此條再擋未來」）：真正提供結構性保證的是本
 * 哨兵日，它**與油種無關**，故對**任一**軸皆成立；軸分離只是把「與唯一金額硬編
 * 處相遇」的機會降為零，本身不構成保證（同軸若來一個更早的播種者仍會翻盤）。
 *
 * **下界但書（不得再往前調）**：本日期必須**嚴格晚於**
 * `travel-application.spec.ts` :62 之 `NO_PARAM_TRIP_DATE = "1999-05-05"`——該檔
 * 情境2「缺參數路徑」倚賴一條全 `e2e/` 共同不變式（:38-39 明文：「只要本檔
 * （及其他 E2E 檔）從未以 `<= 1999-05-05` 的 `effectiveFrom` 建立版本」），
 * 任何 spec 只要播下 `≤ 1999-05-05` 之版本，該情境即因「查得到版本」而失效。
 * 故本檔可用之**安全窗為 `(1999-05-05, 2020-01-01)`**（開區間：上界為現行最早之
 * 他檔油價常數 `fuel-model.spec.ts` :64）；`2010-01-01` 落於窗中且兩端皆有餘裕。
 *
 * 本檔零金額斷言，故哪個版本生效對本檔之綠燈皆無影響。
 */
const FUEL_PRICE_EFFECTIVE_FROM = "2010-01-01";
const FUEL_KM_PER_LITER = "10.0000";
/** 後端以 `toFixed(4)` 寫入稽核 summary（`fuel-consumption-service.ts` :187）。 */
const FUEL_KM_PER_LITER_AUDIT = "10.0000";
const FUEL_PRICE_PER_LITER = "65.0000";
const ETC_UNIT_PRICE = 1.8;
const FUEL_BASIS_NOTE = "PHASE-010-T8 E2E 合成資料（稽核 Gate E2E 播種用）";

/** 分頁素材之生效日起點（刻意取遠期，永不影響任何申請之金額計算）。 */
const TOPUP_EFFECTIVE_FROM_BASE = "2030-01-01";

function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
const TRIP_DATE = isoDateDaysAgo(20);

/**
 * FW-F：長作廢原因（171 字連續中文，零空白——不可斷行之連續字元最易撐破容器）。
 * 上限 500（`void-reason.ts` :24 `VOID_REASON_MAX_LENGTH`）。
 */
const VOID_REASON = `T8稽核端到端作廢原因${"因重複申報而作廢本筆差旅補助申請".repeat(10)}`;

// ---------------------------------------------------------------------------
// Auth / 播種 helpers（沿 void-application.spec.ts 既有慣例）
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  loginName: string;
  displayName: string;
}

async function fetchUsers(page: Page): Promise<UserRow[]> {
  const res = await page.request.get(`${API_BASE}/admin/users`);
  if (!res.ok()) throw new Error(`E2E 讀取使用者清單失敗: ${res.status()} ${await res.text()}`);
  const { users } = (await res.json()) as { users: UserRow[] };
  return users;
}

/**
 * AC-19(a) 之「真實管理操作（建立帳號）」——**以管理員 UI 執行**（`/admin/users`
 * 之新增對話框，`AdminUsersPage.tsx` :482-563），非 API 直呼。
 *
 * 置於 `beforeAll` 而非測試本體之理由：本檔全部素材（油耗版本、差旅申請、作廢）
 * 皆以此使用者為前提，測試本體無法先於它執行。其所產生之 `USER_CREATED` 稽核列
 * 正是測試 1 之斷言對象之一。
 */
async function createUserViaAdminUi(
  page: Page,
  loginName: string,
  displayName: string
): Promise<string> {
  await page.goto(`${BASE}/admin/users`, { waitUntil: "load" });
  await expect(page.locator("h1")).toHaveText("使用者管理");

  await page
    .locator(".page-header")
    .getByRole("button", { name: "新增使用者", exact: true })
    .click();
  const dialog = page.locator('.dialog-overlay dialog[aria-label="新增使用者"]');
  await expect(dialog).toBeVisible();

  await dialog.locator("#add-loginName").fill(loginName);
  await dialog.locator("#add-displayName").fill(displayName);
  await dialog.locator("#add-tempPassword").fill(STAFF_TEMP_PASSWORD);
  await dialog.getByRole("button", { name: "新增", exact: true }).click();
  await expect(dialog.locator("output.success-block")).toHaveText(
    "已建立，使用者首次登入須改密。",
    { timeout: 15000 }
  );
  await dialog.getByRole("button", { name: "關閉", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const created = (await fetchUsers(page)).find((u) => u.loginName === loginName);
  if (!created) throw new Error(`E2E 建立帳號後於使用者清單查無 ${loginName}`);
  return created.id;
}

async function ensureFuelPriceCovers(page: Page, fuelType: string, dateStr: string): Promise<void> {
  const res = await page.request.get(`${API_BASE}/parameters/fuel-price?fuelType=${fuelType}`);
  if (!res.ok()) throw new Error(`E2E 讀取油價版本失敗: ${res.status()} ${await res.text()}`);
  const { versions } = (await res.json()) as { versions: { effectiveFrom: string }[] };
  if (versions.some((v) => v.effectiveFrom <= dateStr)) return;
  const createRes = await page.request.post(`${API_BASE}/parameters/fuel-price`, {
    // T8R：專用哨兵日（見 `FUEL_PRICE_EFFECTIVE_FROM` 之 JSDoc）——**不可**改回
    // `PARAM_EFFECTIVE_FROM`，否則本檔會重新支配全站共享油價軸。
    data: {
      fuelType,
      pricePerLiter: FUEL_PRICE_PER_LITER,
      effectiveFrom: FUEL_PRICE_EFFECTIVE_FROM,
    },
  });
  if (!createRes.ok())
    throw new Error(`E2E 設定油價版本失敗: ${createRes.status()} ${await createRes.text()}`);
}

async function ensureEtcCovers(page: Page, dateStr: string): Promise<void> {
  const res = await page.request.get(`${API_BASE}/parameters/etc`);
  if (!res.ok()) throw new Error(`E2E 讀取 ETC 參數失敗: ${res.status()} ${await res.text()}`);
  const { versions } = (await res.json()) as { versions: { effectiveFrom: string }[] };
  if (versions.some((v) => v.effectiveFrom <= dateStr)) return;
  const createRes = await page.request.post(`${API_BASE}/parameters/etc`, {
    data: { unitPrice: ETC_UNIT_PRICE, effectiveFrom: PARAM_EFFECTIVE_FROM },
  });
  if (!createRes.ok())
    throw new Error(`E2E 設定 ETC 參數失敗: ${createRes.status()} ${await createRes.text()}`);
}

/**
 * 建立一個油耗版本（管理員代設定）——同時產生一列
 * `USER_FUEL_CONSUMPTION_VERSION_CREATED` 稽核（`fuel-consumption-routes.ts`
 * :247-259，於同一交易內）。
 */
async function createFuelConsumptionVersion(
  page: Page,
  userId: string,
  effectiveFrom: string
): Promise<void> {
  const res = await page.request.post(`${API_BASE}/users/${userId}/fuel-consumption`, {
    data: {
      fuelType: FUEL_TYPE,
      kmPerLiter: FUEL_KM_PER_LITER,
      effectiveFrom,
      basisNote: FUEL_BASIS_NOTE,
    },
  });
  if (!res.ok())
    throw new Error(
      `E2E 設定油耗版本失敗（${effectiveFrom}）: ${res.status()} ${await res.text()}`
    );
}

let staffPasswordAlreadyChanged = false;

async function loginAsStaff(page: Page, loginName: string): Promise<void> {
  if (staffPasswordAlreadyChanged) {
    const res = await page.request.post(`${API_BASE}/auth/login`, {
      data: { loginName, password: STAFF_NEW_PASSWORD },
    });
    if (!res.ok()) throw new Error(`E2E 合成使用者登入失敗: ${res.status()} ${await res.text()}`);
    return;
  }
  const loginRes = await page.request.post(`${API_BASE}/auth/login`, {
    data: { loginName, password: STAFF_TEMP_PASSWORD },
  });
  if (!loginRes.ok())
    throw new Error(`E2E 合成使用者首次登入失敗: ${loginRes.status()} ${await loginRes.text()}`);
  const changeRes = await page.request.post(`${API_BASE}/me/password`, {
    data: { currentPassword: STAFF_TEMP_PASSWORD, newPassword: STAFF_NEW_PASSWORD },
  });
  if (!changeRes.ok())
    throw new Error(`E2E 合成使用者強制改密失敗: ${changeRes.status()} ${await changeRes.text()}`);
  staffPasswordAlreadyChanged = true;
}

// ---------------------------------------------------------------------------
// 合成圖片（procedural；真實可解碼位元組——沿 report-pdf.spec.ts／T17）
// ---------------------------------------------------------------------------

function makeXorshift32(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
}

async function makeNoiseJpeg(width: number, height: number, seed: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const rnd = makeXorshift32(seed);
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(rnd() * 256) & 0xff;
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/** 播種一筆已完成之差旅申請（供測試 1 之真實作廢用）。 */
async function seedCompletedTravel(page: Page): Promise<string> {
  const createRes = await page.request.post(`${API_BASE}/applications/travel`, { data: {} });
  if (!createRes.ok()) throw new Error(`E2E 播種差旅建立失敗: ${createRes.status()}`);
  const { application } = (await createRes.json()) as { application: { id: string } };
  const tripId = application.id;

  const buf = await makeNoiseJpeg(600, 400, 0x1801);
  const attachmentId = await uploadAttachment(page, buf, "t8-trip.jpg");

  const putRes = await page.request.put(`${API_BASE}/applications/travel/${tripId}`, {
    data: {
      tripDate: TRIP_DATE,
      purpose: `PHASE-010-T8 稽核 Gate 出差目的（${RUN_ID}）`,
      segments: [
        {
          origin: "T8起點",
          destination: "T8終點",
          totalKm: "50.00",
          highwayKm: "10.00",
          attachmentIds: [attachmentId],
        },
      ],
    },
  });
  if (!putRes.ok())
    throw new Error(`E2E 播種差旅段落設定失敗: ${putRes.status()} ${await putRes.text()}`);

  const completeRes = await page.request.post(`${API_BASE}/applications/${tripId}/complete`);
  if (!completeRes.ok())
    throw new Error(`E2E 播種差旅完成失敗: ${completeRes.status()} ${await completeRes.text()}`);
  return tripId;
}

// ---------------------------------------------------------------------------
// 稽核頁 helpers（FW-D：一律走 T7 之既有掛鉤）
// ---------------------------------------------------------------------------

function auditList(page: Page): Locator {
  return page.getByRole("list", { name: "稽核紀錄清單" });
}

/**
 * 以「中文操作類型標籤（全等）」＋「列內含指定文字」定位單一稽核列。
 * FW-A：`actionLabel` 恆為中文標籤，非 enum 字面。
 */
function auditRow(page: Page, actionLabel: string, contains: string): Locator {
  return page
    .locator("li.audit-log-item")
    .filter({
      has: page.locator(".type-badge").filter({ hasText: new RegExp(`^${actionLabel}$`) }),
    })
    .filter({ hasText: contains });
}

interface ChangeRow {
  field: string;
  before: string;
  after: string;
}

/** 讀取單一稽核列之異動明細表（欄位／改前／改後三欄，依渲染序）。 */
async function readChanges(row: Locator): Promise<ChangeRow[]> {
  const trs = row.locator("table.audit-changes-table tbody tr");
  const count = await trs.count();
  const out: ChangeRow[] = [];
  for (let i = 0; i < count; i++) {
    const cells = await trs.nth(i).locator("td").allTextContents();
    out.push({ field: cells[0] ?? "", before: cells[1] ?? "", after: cells[2] ?? "" });
  }
  return out;
}

/** 由 `.pagination` 之「第 P / N 頁（共 T 筆）」讀出總筆數。 */
async function readTotal(page: Page): Promise<number> {
  const text = (await page.locator(".pagination span").first().textContent()) ?? "";
  const m = text.match(/共\s*(\d+)\s*筆/);
  if (!m) throw new Error(`E2E 無法自分頁列讀出總筆數: ${JSON.stringify(text)}`);
  return Number.parseInt(m[1] ?? "", 10);
}

/**
 * 按「套用篩選」並**等到該次查詢之回應落地**。
 *
 * 首輪實跑之紅燈即出於此（見檔頭「首輪紅燈」）：`.pagination` 之「共 N 筆」是
 * 一次性讀值（非重試型斷言），若只等「清單可見」，`pageState` 仍可能停在**上
 * 一次**查詢之 ready 狀態，讀到的是舊 total——篩選後之總數因而與未篩選相等而
 * 假綠／假紅。此處以 query 參數之**存在**（`marker`，如 `"action="`）辨識該次
 * 請求，不寫任何 enum 值字面（FW-A）。
 */
async function applyFilters(page: Page, marker: string): Promise<void> {
  const responded = page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/audit-logs") && r.url().includes(marker) && r.status() === 200,
    { timeout: 15000 }
  );
  await page.getByRole("button", { name: "套用篩選", exact: true }).click();
  await responded;
}

/** 選擇操作類型（以**中文標籤**選取）並套用篩選，等待列表換成該類型之結果。 */
async function applyActionFilter(page: Page, actionLabel: string): Promise<void> {
  await page.selectOption("#audit-filter-action", { label: actionLabel });
  await applyFilters(page, "action=");
  await expect(auditList(page)).toBeVisible({ timeout: 15000 });
  // 第二道（防「回應已到、React 尚未提交」之毫秒級縫隙）：清單零「非該類型」列。
  await expect(page.locator("li.audit-log-item").filter({ hasNotText: actionLabel })).toHaveCount(
    0,
    { timeout: 15000 }
  );
}

async function measureOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

/**
 * FW-B：由列上顯示之「操作時間」（`toLocaleString("zh-TW")` 於
 * `Asia/Taipei` context 下之 `YYYY/M/D ...`）反推該事件之**台北日曆日**
 * （`YYYY-MM-DD`）。零時鐘依賴，故無日界 flaky。
 */
function taipeiDayFromDisplayedTime(displayed: string): string {
  const m = displayed.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) throw new Error(`E2E 無法自操作時間反推台北日曆日: ${JSON.stringify(displayed)}`);
  return `${m[1]}-${(m[2] ?? "").padStart(2, "0")}-${(m[3] ?? "").padStart(2, "0")}`;
}

/** `YYYY-MM-DD` ± n 日（`Date.UTC` 進位，跨月／跨年／閏日安全）。 */
function shiftIsoDay(isoDay: string, deltaDays: number): string {
  const [y = 0, m = 1, d = 1] = isoDay.split("-").map((v) => Number.parseInt(v, 10));
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 共用播種狀態
// ---------------------------------------------------------------------------

let adminDisplayName: string;
let staffUserId: string;
let staffLoginName: string;
let staffDisplayName: string;
let travelAppId: string;

test.describe("稽核檢視端到端 Gate — PHASE-010-T8（AC-19）", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ timezoneId: "Asia/Taipei", locale: "zh-TW" });

  test.beforeAll(async ({ browser }) => {
    const adminContext = await browser.newContext({ timezoneId: "Asia/Taipei", locale: "zh-TW" });
    const adminPage = await adminContext.newPage();
    await loginAsAdmin(adminPage);

    const admin = (await fetchUsers(adminPage)).find((u) => u.loginName === E2E_ADMIN.loginName);
    if (!admin) throw new Error(`E2E 於使用者清單查無管理員 ${E2E_ADMIN.loginName}`);
    adminDisplayName = admin.displayName;

    // AC-19(a) 之「真實管理操作（建立帳號）」——管理員 UI 執行。
    staffLoginName = `e2e-audit-${RUN_ID}`;
    staffDisplayName = `T8稽核使用者${RUN_ID}`;
    staffUserId = await createUserViaAdminUi(adminPage, staffLoginName, staffDisplayName);

    await ensureFuelPriceCovers(adminPage, FUEL_TYPE, TRIP_DATE);
    await ensureEtcCovers(adminPage, TRIP_DATE);
    await createFuelConsumptionVersion(adminPage, staffUserId, PARAM_EFFECTIVE_FROM);
    await adminContext.close();

    const staffContext = await browser.newContext({ timezoneId: "Asia/Taipei", locale: "zh-TW" });
    const staffPage = await staffContext.newPage();
    await loginAsStaff(staffPage, staffLoginName);
    travelAppId = await seedCompletedTravel(staffPage);
    await staffContext.close();
  });

  test.afterAll(async ({ browser }) => {
    // best-effort：合成使用者名下恆有已作廢申請 → `DELETE` 恆 409（見檔頭
    // 「清理之界限」）。稽核列依 AC-11 不可變，本檔不得嘗試刪除。
    const context = await browser.newContext({ timezoneId: "Asia/Taipei", locale: "zh-TW" });
    const page = await context.newPage();
    await loginAsAdmin(page);
    if (staffUserId) {
      await page.request.delete(`${API_BASE}/admin/users/${staffUserId}`).catch(() => {});
    }
    await context.close();
  });

  // -------------------------------------------------------------------------
  // 測試 1（AC-19(a)）
  // -------------------------------------------------------------------------
  test("AC-19(a): 管理員真實作廢 → 首頁入口進稽核頁 → 建立帳號／申請作廢兩事件可見且四要素正確", async ({
    page,
  }) => {
    await loginAsAdmin(page);

    await test.step("真實作廢（管理員於申請詳情頁，二次確認 ＋ 必填原因）", async () => {
      await page.goto(`${BASE}/applications/travel/${travelAppId}`, { waitUntil: "load" });
      await expect(page.locator("h1")).toHaveText("差旅補助申請（已完成）", { timeout: 15000 });

      await page.getByRole("button", { name: "作廢", exact: true }).click();
      const dialog = page.locator(".dialog-overlay dialog.dialog-box");
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("h3")).toHaveText("確認作廢申請");

      const confirmBtn = dialog.getByRole("button", { name: "確認作廢", exact: true });
      await expect(confirmBtn).toBeDisabled();
      await dialog.locator("#void-reason").fill(VOID_REASON);
      await expect(confirmBtn).toBeEnabled();
      await confirmBtn.click();

      await expect(page.locator("h1")).toHaveText("差旅補助申請（已作廢）", { timeout: 20000 });
    });

    await test.step("首頁入口 → 稽核頁（AC-15(b)）", async () => {
      await page.goto(`${BASE}/`, { waitUntil: "load" });
      await page.getByRole("link", { name: "稽核紀錄", exact: true }).click();
      await page.waitForURL(`${BASE}/admin/audit-logs`);
      await expect(page.locator("h1")).toHaveText("稽核紀錄");
      await expect(auditList(page)).toBeVisible({ timeout: 15000 });
    });

    await test.step("事件一：申請作廢——四要素 ＋ 異動明細（值層中文化）", async () => {
      const row = auditRow(page, LABEL_APPLICATION_VOIDED, staffLoginName);
      await expect(row).toHaveCount(1, { timeout: 15000 });

      // 四要素之一：操作時間（在地化長相；ISO 字面或空值皆必紅）。
      await expect(row.locator(".audit-log-time")).toHaveText(
        /^\d{4}\/\d{1,2}\/\d{1,2} \S*\d{1,2}:\d{2}:\d{2}$/
      );
      // 四要素之二：操作者＝執行作廢之管理員。
      await expect(row.locator(".audit-log-actor")).toHaveText(adminDisplayName);
      // 四要素之三：操作類型（中文標籤，FW-A）。
      await expect(row.locator(".type-badge")).toHaveText(LABEL_APPLICATION_VOIDED);
      // 四要素之四：受影響對象＝申請擁有人。FW-C：wire 值為
      // `loginName#applicationId`，畫面**僅**呈現 `#` 前段 ＋ 顯示名稱附掛。
      await expect(row.locator(".audit-log-target")).toHaveText(
        `${staffLoginName}（${staffDisplayName}）`
      );

      // 異動明細：AC-24 之封閉四鍵中，`applicationId` 依 MG-3 不呈現 → 恰三列。
      const changes = await readChanges(row);
      expect(changes.map((c) => c.field)).toEqual(["申請類型", "作廢原因", "作廢時間"]);
      // 上一斷言已釘死 changes 恰三筆，故索引 0/1/2 必存在（同批窄化，非弱化）。
      const [change0, change1, change2] = changes;
      if (!change0 || !change1 || !change2) throw new Error("E2E 內部錯誤：changes 應恰三筆");
      // FW-A：`type` 值中文化（`TRAVEL` 字面必紅）。
      expect(change0.after).toBe("差旅補助");
      expect(change1.after).toBe(VOID_REASON);
      // AC-18(c)：`voidedAt` 為 ISO 8601，畫面須在地化（不得出現原始 ISO 字面）。
      expect(change2.after).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2} \S*\d{1,2}:\d{2}:\d{2}$/);
      // 三列之「改前」皆為 `null` → 「—」（(b-2) 分支）。
      expect(changes.map((c) => c.before)).toEqual(["—", "—", "—"]);
      // FW-C 逐字負向：畫面零「申請編號」列。
      await expect(row.getByText("申請編號", { exact: true })).toHaveCount(0);
    });

    await test.step("事件二：新增使用者——四要素 ＋ 異動明細（值層中文化）", async () => {
      const row = auditRow(page, LABEL_USER_CREATED, staffLoginName);
      await expect(row).toHaveCount(1, { timeout: 15000 });

      await expect(row.locator(".audit-log-time")).toHaveText(
        /^\d{4}\/\d{1,2}\/\d{1,2} \S*\d{1,2}:\d{2}:\d{2}$/
      );
      await expect(row.locator(".audit-log-actor")).toHaveText(adminDisplayName);
      await expect(row.locator(".type-badge")).toHaveText(LABEL_USER_CREATED);
      // `USER_CREATED` 之 `targetLabel` 為裸 `loginName`（無 `#`）→ 原樣全字呈現。
      await expect(row.locator(".audit-log-target")).toHaveText(
        `${staffLoginName}（${staffDisplayName}）`
      );

      // `admin/routes.ts` :271-281：未填員工編號時 summary 恰一鍵 `role`。
      const changes = await readChanges(row);
      expect(changes).toEqual([{ field: "角色", before: "—", after: "一般使用者" }]);
    });
  });

  // -------------------------------------------------------------------------
  // 測試 2（AC-18(e)／MG-3 回歸，負向）
  // -------------------------------------------------------------------------
  test("AC-18(e)／MG-3 回歸（負向）: 稽核頁零內部識別碼（cuid）呈現", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE}/admin/audit-logs`, { waitUntil: "load" });
    await expect(auditList(page)).toBeVisible({ timeout: 15000 });

    const listText = await auditList(page).innerText();

    // (i) 逐字負向：本次執行之兩個已知 cuid 一律不出現。
    expect(listText).not.toContain(staffUserId);
    expect(listText).not.toContain(travelAppId);

    // (ii) 樣式負向：cuid 之字面樣式（`c` ＋ 24 個小寫英數）零命中——涵蓋環境
    // 內既有列，任何一列漏掉截斷／漏掉隱藏欄皆必紅。
    const cuidLike = listText.match(/\bc[a-z0-9]{24}\b/g) ?? [];
    expect(cuidLike).toEqual([]);

    // (iii) 反面自證（防上兩格因「頁面根本沒渲染」而恆真）：本次之作廢列在場。
    await expect(auditRow(page, LABEL_APPLICATION_VOIDED, staffLoginName)).toHaveCount(1);
  });

  // -------------------------------------------------------------------------
  // 測試 3（AC-19(c)）
  // -------------------------------------------------------------------------
  test("AC-19(c): 375px——稽核列表／異動明細表／長作廢原因零水平溢位", async ({ browser }) => {
    const context = await browser.newContext({
      timezoneId: "Asia/Taipei",
      locale: "zh-TW",
      viewport: { width: 375, height: 800 },
    });
    const page = await context.newPage();
    await loginAsAdmin(page);
    await page.goto(`${BASE}/admin/audit-logs`, { waitUntil: "load" });
    await expect(auditList(page)).toBeVisible({ timeout: 15000 });

    // 本測試之量測對象：帶長作廢原因（171 字連續中文）與異動明細表之作廢列。
    const row = auditRow(page, LABEL_APPLICATION_VOIDED, staffLoginName);
    await expect(row).toHaveCount(1, { timeout: 15000 });
    await row.scrollIntoViewIfNeeded();

    // 內容可讀：長原因完整在場（未被裁切成別的字串）。
    await expect(row.locator("table.audit-changes-table")).toContainText(VOID_REASON);

    // (c) body 零水平溢位。
    const { scrollWidth, clientWidth } = await measureOverflow(page);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

    // 清單與明細表之 wrapper 自身亦不得超出視埠（長值須捲於 `.table-scroll`
    // 內，而非把版面撐開——FW-F）。
    const listBox = await auditList(page).boundingBox();
    if (!listBox) throw new Error("E2E 量測失敗：稽核紀錄清單無 bounding box");
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(clientWidth + 1);

    const scrollWrapper = row.locator(".table-scroll");
    await expect(scrollWrapper).toHaveCount(1);
    const wrapperBox = await scrollWrapper.boundingBox();
    if (!wrapperBox) throw new Error("E2E 量測失敗：.table-scroll 無 bounding box");
    expect(wrapperBox.x + wrapperBox.width).toBeLessThanOrEqual(clientWidth + 1);

    // 篩選欄（五欄）於 375px 下同樣不得撐破版面——套用一次篩選後再量一次。
    await applyActionFilter(page, LABEL_APPLICATION_VOIDED);
    const after = await measureOverflow(page);
    expect(after.scrollWidth).toBeLessThanOrEqual(after.clientWidth);

    await context.close();
  });

  // -------------------------------------------------------------------------
  // 測試 4（AC-19(b) 前半：篩選收斂）
  // -------------------------------------------------------------------------
  test("AC-19(b): 依 action 篩選確實收斂（值層中文化）＋ 起訖日以台北日曆日收斂", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE}/admin/audit-logs`, { waitUntil: "load" });
    await expect(auditList(page)).toBeVisible({ timeout: 15000 });

    const unfilteredTotal = await readTotal(page);

    await test.step("依「申請作廢」篩選 → 收斂且列型別齊一", async () => {
      await applyActionFilter(page, LABEL_APPLICATION_VOIDED);

      const filteredTotal = await readTotal(page);
      // 收斂之強斷言：嚴格小於未篩選總數（本次執行必有非作廢事件，如新增使用者）。
      expect(filteredTotal).toBeLessThan(unfilteredTotal);
      expect(filteredTotal).toBeGreaterThan(0);

      // 逐列型別齊一：畫面上每一列之操作類型皆為該中文標籤。
      const badges = await page.locator("li.audit-log-item .type-badge").allTextContents();
      expect(badges.length).toBeGreaterThan(0);
      expect(new Set(badges)).toEqual(new Set([LABEL_APPLICATION_VOIDED]));

      // 本次執行之作廢列仍在（篩選未把該筆篩掉）。
      await expect(auditRow(page, LABEL_APPLICATION_VOIDED, staffLoginName)).toHaveCount(1);
    });

    await test.step("依「油耗資料異動」篩選 → 值層中文化（柴油）", async () => {
      await page.goto(`${BASE}/admin/audit-logs`, { waitUntil: "load" });
      await expect(auditList(page)).toBeVisible({ timeout: 15000 });
      await applyActionFilter(page, LABEL_FUEL_VERSION_CREATED);

      const badges = await page.locator("li.audit-log-item .type-badge").allTextContents();
      expect(new Set(badges)).toEqual(new Set([LABEL_FUEL_VERSION_CREATED]));

      const row = auditRow(page, LABEL_FUEL_VERSION_CREATED, staffLoginName);
      await expect(row).toHaveCount(1, { timeout: 15000 });
      // AC-06(b-0)：`{before: null, after: {...}}` 逐子欄拆列 ＋ 頂層 `basisNote`。
      const changes = await readChanges(row);
      expect(changes).toEqual([
        // FW-A：`fuelType` 值中文化（`DIESEL` 字面必紅）。
        { field: "油種", before: "—", after: "柴油" },
        { field: "油耗（公里／公升）", before: "—", after: FUEL_KM_PER_LITER_AUDIT },
        { field: "生效日", before: "—", after: PARAM_EFFECTIVE_FROM },
        { field: "依據備註", before: "—", after: FUEL_BASIS_NOTE },
      ]);
    });

    await test.step("FW-E：操作者／受影響對象為使用者下拉，選項零 cuid", async () => {
      await page.goto(`${BASE}/admin/audit-logs`, { waitUntil: "load" });
      await expect(auditList(page)).toBeVisible({ timeout: 15000 });

      for (const id of ["#audit-filter-actorId", "#audit-filter-targetId"]) {
        const select = page.locator(id);
        await expect(select).toHaveJSProperty("tagName", "SELECT");
        const optionTexts = await select.locator("option").allTextContents();
        expect(optionTexts[0]).toBe("全部");
        // 選項文字為「顯示名稱（登入帳號）」——本次合成使用者必在其中。
        expect(optionTexts).toContain(`${staffDisplayName}（${staffLoginName}）`);
        // 零 cuid 文字（SF-1 之目的：管理員無從得知 id，故不得以 id 當選項文字）。
        expect(optionTexts.join("\n")).not.toMatch(/\bc[a-z0-9]{24}\b/);
      }
    });

    await test.step("FW-B：起訖日以該列自身之台北日曆日收斂（正向 ＋ 前一日負向）", async () => {
      await page.goto(`${BASE}/admin/audit-logs`, { waitUntil: "load" });
      await expect(auditList(page)).toBeVisible({ timeout: 15000 });

      const voidRow = auditRow(page, LABEL_APPLICATION_VOIDED, staffLoginName);
      await expect(voidRow).toHaveCount(1, { timeout: 15000 });
      const displayed = (await voidRow.locator(".audit-log-time").textContent()) ?? "";
      const taipeiDay = taipeiDayFromDisplayedTime(displayed);

      // 正向：起訖日皆取該事件之台北日 → 該列仍在（起訖日均含當日）。
      await page.fill("#audit-filter-dateFrom", taipeiDay);
      await page.fill("#audit-filter-dateTo", taipeiDay);
      await applyFilters(page, "dateFrom=");
      await expect(auditRow(page, LABEL_APPLICATION_VOIDED, staffLoginName)).toHaveCount(1, {
        timeout: 15000,
      });

      // 負向：起訖日皆取前一日 → 該列必不在（若後端誤用 UTC 日界則必紅）。
      const previousDay = shiftIsoDay(taipeiDay, -1);
      await page.fill("#audit-filter-dateFrom", previousDay);
      await page.fill("#audit-filter-dateTo", previousDay);
      await applyFilters(page, "dateFrom=");
      await expect(page.locator(".loading-block")).toHaveCount(0, { timeout: 15000 });
      await expect(auditRow(page, LABEL_APPLICATION_VOIDED, staffLoginName)).toHaveCount(0);
    });
  });

  // -------------------------------------------------------------------------
  // 測試 5（AC-19(b) 後半：分頁）＋ AC-19(d) 之「先量後補」播種
  // -------------------------------------------------------------------------
  test("AC-19(b): 分頁至第 2 頁且兩頁列不重複", async ({ page }) => {
    await loginAsAdmin(page);

    await test.step("先量後補：把「油耗資料異動」補到 21 筆為止（冪等）", async () => {
      const res = await page.request.get(
        `${API_BASE}/admin/audit-logs?action=USER_FUEL_CONSUMPTION_VERSION_CREATED&pageSize=1`
      );
      if (!res.ok()) throw new Error(`E2E 讀取稽核總數失敗: ${res.status()} ${await res.text()}`);
      const { total } = (await res.json()) as { total: number };
      const shortfall = Math.max(0, MIN_ROWS_FOR_PAGE_2 - total);
      for (let i = 0; i < shortfall; i++) {
        await createFuelConsumptionVersion(
          page,
          staffUserId,
          shiftIsoDay(TOPUP_EFFECTIVE_FROM_BASE, i)
        );
      }
    });

    await page.goto(`${BASE}/admin/audit-logs`, { waitUntil: "load" });
    await expect(auditList(page)).toBeVisible({ timeout: 15000 });
    await applyActionFilter(page, LABEL_FUEL_VERSION_CREATED);

    const total = await readTotal(page);
    expect(total).toBeGreaterThanOrEqual(MIN_ROWS_FOR_PAGE_2);

    // 第 1 頁：恰 PAGE_SIZE 列。
    await expect(page.locator(".pagination span").first()).toContainText("第 1 /");
    await expect(page.locator("li.audit-log-item")).toHaveCount(PAGE_SIZE);
    const firstPageTexts = await page.locator("li.audit-log-item").allInnerTexts();

    // 上一頁停用（第 1 頁）／下一頁可用。
    await expect(page.getByRole("button", { name: "上一頁", exact: true })).toBeDisabled();
    const nextBtn = page.getByRole("button", { name: "下一頁", exact: true });
    await expect(nextBtn).toBeEnabled();

    // 第 2 頁。
    await nextBtn.click();
    await expect(page.locator(".pagination span").first()).toContainText("第 2 /", {
      timeout: 15000,
    });
    const secondPageTexts = await page.locator("li.audit-log-item").allInnerTexts();
    expect(secondPageTexts.length).toBeGreaterThan(0);
    expect(secondPageTexts.length).toBeLessThanOrEqual(PAGE_SIZE);

    // AC-19(b)：兩頁之列不重複（全序排序下同一列不得跨頁重複出現）。
    const firstPageSet = new Set(firstPageTexts);
    const overlap = secondPageTexts.filter((t) => firstPageSet.has(t));
    expect(overlap).toEqual([]);

    // 防恆真：第 1 頁自身之列彼此相異（否則上一格之「零交集」可能來自
    // 「文字身分本就不可靠」而非真的不重複）。
    expect(firstPageSet.size).toBe(firstPageTexts.length);

    // 回到第 1 頁 → 內容與先前逐字相同（分頁為純檢視操作，不改變結果集）。
    await page.getByRole("button", { name: "上一頁", exact: true }).click();
    await expect(page.locator(".pagination span").first()).toContainText("第 1 /", {
      timeout: 15000,
    });
    expect(await page.locator("li.audit-log-item").allInnerTexts()).toEqual(firstPageTexts);
  });
});
