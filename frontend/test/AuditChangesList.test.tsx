/**
 * AuditChangesList 元件單元測試 — PHASE-010-T6（PHASE-010-T7R 擴充；
 * PHASE-010-T-MG1-FE 再擴充；PHASE-010-T-MG1-FE-R 暖續修復；
 * PHASE-010-T-MG3-FE 四度擴充）
 *
 * **T-MG3-FE（Mock Gate 第二輪修復，依 MG-3 裁定）**：新增
 * `describe("AC-18(e): 純內部識別碼列不呈現（MG-3）")`——`applicationId`／
 * `revisionOf` 兩列不渲染之正負向、隱藏欄常數恰兩鍵之刪／增 mutant、
 * 過濾過寬防護（其餘欄位照常渲染）、B-31 全濾後之既有空態；另於既有
 * 32 鍵欄名守門格（`D3=(c)` describe）**新增**（非刪除）(e-4) 鑑別力自證
 * 斷言——就 `applicationId`／`revisionOf` 兩鍵改以 `FIELD_LABELS`／
 * `fieldLabel()` 為斷言對象（見該 it 內對應段落）。
 *
 * **T-MG1-FE-R（FE 複審 SF-A／AR-10）**：AC-18(b) 格於 T-MG1-FE 之 fixture
 * 汰換（子欄拆列新契約）後已無任何 JSON blob 值 fixture，前端自帶負向守門
 * 因此失去對 (b-2) 整包字串化路徑之鑑別力（reviewer M3）；補一格獨立
 * (b-2) 形 fixture 予以恢復。另於「未知值與自由文字」格加一行 AR-10
 * （`reason:"true"` 不得被誤譯為「是」），封「布林映射限定於布林欄位」
 * 半邊（reviewer M23）。兩格詳見下方對應 `it`。
 *
 * 涵蓋 AC-18(a)(b)(c)（呈現安全；§12 三列預定測試名逐字對應）＋ D3=(c) 中文
 * 欄名對照（§18 Gate 固化，T3 即審 FW-5／T1 即審 FW-4／T1 即審 FW-5 三項上游
 * FW 義務）＋ **AC-18(d) 值層中文化**（MG-1 裁定，T-MG1-FE 新增）。
 *
 * **T7R（期中複審 #2 SF-2／AR-3）**：中文對照表之覆蓋守門常數由 T6 之 17 鍵
 * 擴為 `backend/src` 全樹實掃之 **31 鍵全集**（見 `REQUIRED_SUMMARY_FIELDS`
 * 之逐點列舉），使「刪 `FIELD_LABELS` 任一鍵即紅」成立於全部鍵——T6 加碼之
 * 7 鍵原本零守門（AR-3），另 7 個真實高頻鍵原本缺表（SF-2）。
 *
 * **T-MG1-FE（Mock Gate MG-1 修復）**：
 *   ① `REQUIRED_SUMMARY_FIELDS` 31 → **32 鍵**（新增 `kmPerLiter`——BE1
 *      AC-06(b-0) 生效後之油耗巢狀子欄拆列新鍵）；
 *   ② `FUEL_CONSUMPTION_NESTED_CHANGES` fixture 由「頂層 `before`／`after`
 *      各一列、值為 JSON 字串」之**修訂前**形狀，改為 BE1 新契約之**子欄拆列
 *      四列形**（`fuelType`／`kmPerLiter`／`effectiveFrom`／`basisNote`），
 *      逐值抄錄自 `backend/test/unit/audit-summary-flatten.test.ts` :662-691
 *      之 `FUEL_CONSUMPTION_NESTED` 真實輸出（不自行虛構，沿 T3 即審 FW-6）；
 *   ③ 新增 `describe("AC-18(d): 值層中文化")`——四格：枚舉四類逐值中文、
 *      布林 true/false → 是/否（限定布林欄位）、未知值與自由文字原樣顯示
 *      不崩（防誤譯）、14 值覆蓋守門常數刪值必紅。
 *   ④ `isActive` 相關格改用 BE1／BE2 後之新契約單列兩欄形
 *      （`{field:"isActive", before:"true", after:"false"}`，不再是舊契約之
 *      `{before:null, after:'{"from":true,"to":false}'}`），並新增其值依
 *      AC-18(d) 譯為「是」／「否」之斷言。
 *   ⑤「同名陷阱」格不再共用 `FUEL_CONSUMPTION_NESTED_CHANGES`（該 fixture
 *      經 (b-0) 後已不再產生 `field: "before"`／`"after"`），改用獨立最小
 *      fixture 直接構造這兩個現行常態不可達、但保留可讀之邊界值（見
 *      `AuditChangesList.tsx` 檔頭「`before`／`after` 兩鍵」段落）。
 *
 * 本檔為 AuditChangesList 之**唯一**測試檔——AC-18(b) 之
 * `[object Object]` 負向守門依 Spec §11.0 紀律 6／PHASE-009 T15c FW 前端
 * 自帶，不倚賴 `backend/test/unit/audit-summary-flatten.test.ts`（僅借用其
 * 真實 fixture 之值以貼近真實資料，見下方 FUEL_CONSUMPTION_NESTED_CHANGES）。
 *
 * 範圍界定：本元件只吃 `changes: AuditChangeDto[]`，不接收 `targetLabel`
 * （T7 之 `AuditLogPage` 渲染該欄位處另行涵蓋，見 `AuditChangesList.tsx`
 * 檔頭「範圍界定」段落）。
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AuditChangesList, {
  FIELD_LABELS,
  HIDDEN_INTERNAL_ID_FIELDS,
  fieldLabel,
} from "../src/components/AuditChangesList.js";
import type { AuditChangeDto } from "../src/types/api.js";

/**
 * 真實 fixture：`USER_FUEL_CONSUMPTION_VERSION_CREATED` 巢狀混合形，逐值抄錄
 * 自 `backend/test/unit/audit-summary-flatten.test.ts` :662-691 之
 * `FUEL_CONSUMPTION_NESTED` ── 經後端 `flattenAuditSummary`（**MG-1 後之新
 * 契約**：AC-06(b-0) 子欄拆列）之真實輸出形狀：恰 4 列＝三子鍵
 * （`fuelType`／`kmPerLiter`／`effectiveFrom`，各自改前→改後兩欄對照）＋
 * `basisNote` 純量一列；頂層 `before`／`after` **不**各自成列
 * （T-MG1-FE：修訂前 fixture 為頂層 `before`／`after` 各一列、值為
 * `JSON.stringify` 整包字串，已隨 BE1 新契約汰換——AC-06(f) 之最高密度案例
 * 仍以本 fixture 承接；T3 即審 FW-6：以真實字串長度為 fixture，非短純量）。
 */
const FUEL_CONSUMPTION_NESTED_CHANGES: AuditChangeDto[] = [
  { field: "fuelType", before: "GASOLINE_95", after: "GASOLINE_98" },
  { field: "kmPerLiter", before: "12.3400", after: "13.5000" },
  { field: "effectiveFrom", before: "2026-01-01", after: "2026-08-01" },
  { field: "basisNote", before: null, after: "原廠油耗數據（合成資料）" },
];

/**
 * `changes[].field` 之**可能值全集**（**32 鍵**）——T7R 對 `backend/src` 全樹
 * 之實掃結果（31 鍵）＋ T-MG1-FE 補入之 `kmPerLiter`（AC-06(b-0) 子欄拆列後
 * 新增之可能值；定義依 `AuditChangesList.tsx` 檔頭「D3=(c)」段落，接替 T7R
 * 版之「backend/src 全樹頂層鍵實掃全集」定義），逐一列舉：
 *
 *   · `admin/routes.ts` `writeAudit` ×5：`role`／`employeeNumber`（USER_CREATED）、
 *     `isActive`（USER_DEACTIVATED／USER_ACTIVATED）、`mustChangePassword`
 *     （USER_PASSWORD_RESET）、`deletedLoginName`／`deletedDisplayName`
 *     （USER_DELETED）
 *   · `admin/routes.ts` 代建 `auditLog.create` ×3：`applicationId`／`type` ＋
 *     TRAVEL 之 `tripDate`／`purpose`、MAINTENANCE 之 `lastMaintenanceDate`／
 *     `currentMaintenanceDate`／`lastOdometerKm`／`currentOdometerKm`／
 *     `actualCost`、DEPRECIATION 之 `applicationYear`／`annualTotalKm`
 *   · `applications/routes.ts` 代改 ×3：同上 ＋ TRAVEL 之 `segmentsCount`
 *   · `applications/routes.ts` 作廢：`reason`／`voidedAt`；修正版：`revisionOf`
 *   · `parameters/routes.ts` ×3：`parameterType`／`fuelType`／`pricePerLiter`／
 *     `effectiveFrom`／`unitPrice`／`vehiclePrice`／`usefulLifeYears`
 *   · `users/fuel-consumption-routes.ts` ×1：`before`／`after`／`basisNote`
 *     ——**(b-0) 後 `before`／`after` 常態不可達，保留條目**（BE1 即審 FW-1）
 *   · T-MG1-FE：`kmPerLiter`——(b-0) 子欄拆列後之新可能值
 *
 * 本常數即 D3=(c) 中文對照表之**覆蓋守門**（AR-3／SF-2／T-MG1-FE）：
 * `FIELD_LABELS` 刪去其中任一鍵，下方「逐鍵顯示中文標籤」之測試即因回退
 * 顯示英文原鍵名而變紅。T6 原版僅列 17 鍵（AR-3）、T7R 擴為 31 鍵（SF-2）、
 * T-MG1-FE 補齊 `kmPerLiter` 達 32 鍵。**刻意獨立硬編、不衍生自
 * `AuditChangesList.tsx` 之 `FIELD_LABELS`**（若改為 `Object.keys(FIELD_LABELS)`，
 * 刪表中鍵時本常數會同步縮小，「刪鍵即紅」之鑑別力即失效）。
 */
const REQUIRED_SUMMARY_FIELDS = [
  // T3 即審 FW-5 已實證之 17 鍵
  "applicationId",
  "type",
  "reason",
  "voidedAt",
  "revisionOf",
  "tripDate",
  "purpose",
  "before",
  "after",
  "basisNote",
  "parameterType",
  "isActive",
  "mustChangePassword",
  "role",
  "employeeNumber",
  "deletedLoginName",
  "deletedDisplayName",
  // T6 實查補入之 7 鍵（原無守門——AR-3）
  "segmentsCount",
  "fuelType",
  "pricePerLiter",
  "effectiveFrom",
  "unitPrice",
  "vehiclePrice",
  "usefulLifeYears",
  // T7R 實掃補入之 7 鍵（期中複審 #2 SF-2）
  "applicationYear",
  "annualTotalKm",
  "actualCost",
  "lastOdometerKm",
  "currentOdometerKm",
  "lastMaintenanceDate",
  "currentMaintenanceDate",
  // T-MG1-FE 補入之 1 鍵（AC-06(b-0) 子欄拆列後之新可能值）
  "kmPerLiter",
];

describe("AuditChangesList", () => {
  describe("AC-18: 呈現安全", () => {
    it("AC-18(a): XSS payload 三型跳脫；DOM 零新增 script 節點", () => {
      const scriptPayload = "<script>document.title = 'xss-1'</script>";
      const imgOnerrorPayload = '"><img src=x onerror="document.title = \'xss-2\'">';
      const javascriptUriPayload = "javascript:document.title = 'xss-3'";

      const changes: AuditChangeDto[] = [
        { field: "reason", before: null, after: scriptPayload },
        { field: "purpose", before: null, after: imgOnerrorPayload },
        { field: "basisNote", before: null, after: javascriptUriPayload },
      ];

      const scriptCountBefore = document.querySelectorAll("script").length;
      render(<AuditChangesList changes={changes} />);

      // 正向：三種 payload 皆逐字以純文字節點呈現（未被解析為標籤／屬性）
      expect(screen.getByText(scriptPayload)).toBeInTheDocument();
      expect(screen.getByText(imgOnerrorPayload)).toBeInTheDocument();
      expect(screen.getByText(javascriptUriPayload)).toBeInTheDocument();

      // 負向：全頁 DOM 無新增 <script> 節點；無新增 <img>／<a> 元素
      expect(document.querySelectorAll("script").length).toBe(scriptCountBefore);
      expect(document.querySelectorAll("img").length).toBe(0);
      expect(document.querySelectorAll("a").length).toBe(0);
      // 標題未被竄改（若 payload 真被執行，document.title 會變成 xss-1/2/3）
      expect(document.title).not.toMatch(/^xss-/);
    });

    it("AC-18(b): 巢狀混合 summary 渲染零 [object Object]（前端自帶負向）", () => {
      const { container } = render(<AuditChangesList changes={FUEL_CONSUMPTION_NESTED_CHANGES} />);

      // 負向：全渲染結果零 "[object Object]"（前端自帶，不倚賴後端測試）
      expect(container.textContent).not.toContain("[object Object]");

      // 正向：子欄拆列後之逐值可見——fuelType 值依 AC-18(d) 中文化（T-MG1-FE
      // 新契約：BE1 (b-0) 後不再產生整包 JSON 字串，改為子欄逐值對照）。
      expect(screen.getByText("95 無鉛汽油")).toBeInTheDocument();
      expect(screen.getByText("98 無鉛汽油")).toBeInTheDocument();
      expect(screen.getByText("12.3400")).toBeInTheDocument();
      expect(screen.getByText("13.5000")).toBeInTheDocument();
      expect(screen.getByText("2026-01-01")).toBeInTheDocument();
      expect(screen.getByText("2026-08-01")).toBeInTheDocument();
      expect(screen.getByText("原廠油耗數據（合成資料）")).toBeInTheDocument();
    });

    it("AC-18(b) 補格（PHASE-010-T-MG1-FE-R SF-A）：(b-2) 形整包 JSON blob 值仍零 [object Object]、逐字可見", () => {
      // T-MG1-FE 後兩測試檔已無任何 JSON blob 值 fixture（BE1 (b-0) 新契約
      // 使油耗巢狀 fixture 改為子欄拆列）——AC-18(b) 之存在理由正是「後端
      // 契約可能在前端腳下改變」，(b-2) 之整包字串化 blob 於契約上仍可達
      // （陣列／任意物件形，及 before/after 兩保留條目之未來形狀），故本格
      // 獨立補一個 (b-2) 形 fixture，防前端自帶負向守門因 fixture 汰換而
      // 失去鑑別力（reviewer M3：formatValue 內對 `{` 開頭值 JSON.parse 後
      // 樣板插值，在無 blob fixture 時可存活）。
      const blobValue =
        '{"fuelType":"GASOLINE_95","kmPerLiter":"12.3400","effectiveFrom":"2026-01-01"}';
      const changes: AuditChangeDto[] = [{ field: "after", before: null, after: blobValue }];

      const { container } = render(<AuditChangesList changes={changes} />);

      expect(container.textContent).not.toContain("[object Object]");
      expect(screen.getByText(blobValue)).toBeInTheDocument();
    });

    it("AC-18(c): 時間在地化單一形式；同頁不並存 ISO 原字串", () => {
      const isoVoidedAt = "2026-08-09T03:21:00.000Z";
      const changes: AuditChangeDto[] = [
        { field: "voidedAt", before: null, after: isoVoidedAt },
        // 純日期字串（無時間成分）不屬本條守門對象，逐字顯示，不做在地化轉換。
        { field: "tripDate", before: null, after: "2026-08-01" },
      ];

      render(<AuditChangesList changes={changes} />);

      // 負向：完整 ISO 時間原字串不得逐字出現在畫面（同頁不並存兩形式）
      expect(screen.queryByText(isoVoidedAt)).not.toBeInTheDocument();

      // 正向：改以與既有「計算時間」同型之台北在地化字串呈現（不硬編字面，
      // 避免主機時區／ICU 資料相依——比照 ReportSection.test.tsx 既有寫法）。
      expect(
        screen.getByText(new Date(isoVoidedAt).toLocaleString("zh-TW").replace(/\s+/g, " ").trim())
      ).toBeInTheDocument();

      // 純日期字串維持原字面（非本條守門對象，不應被誤轉換）
      expect(screen.getByText("2026-08-01")).toBeInTheDocument();
    });
  });

  describe("D3=(c): 中文欄名對照（§18 Gate 固化）", () => {
    it("中文對照表涵蓋 changes[].field 可能值全集（32 鍵，含 kmPerLiter），逐鍵顯示中文標籤（非原始英文鍵名）", () => {
      const changes: AuditChangeDto[] = REQUIRED_SUMMARY_FIELDS.map((field) => ({
        field,
        before: null,
        after: "x",
      }));

      render(<AuditChangesList changes={changes} />);

      // 逐鍵：畫面上不得出現原始英文鍵名字面（已被翻譯覆蓋，非缺表回退）
      for (const field of REQUIRED_SUMMARY_FIELDS) {
        expect(screen.queryByText(field)).not.toBeInTheDocument();
      }

      // AC-18(e-4)：(e-2) 生效後 applicationId／revisionOf 兩鍵之列完全不
      // 渲染，上方迴圈對此二鍵之斷言因此恆真而失去鑑別力（見
      // AuditChangesList.tsx 檔頭 AC-18(e-4) 段落）。就此二鍵改以標籤表本身
      // 為斷言對象：逐鍵須有非空、且不等於鍵名之中文標籤——「刪
      // FIELD_LABELS 之該鍵」之 mutant 會使 fieldLabel() 回退顯示原始英文
      // 鍵名（等於鍵名），下列斷言即必紅（§15 T-MG3-FE 機械連動預授權，
      // 本段為既有 it 之新增內容，零刪除既有 expect）。
      for (const field of HIDDEN_INTERNAL_ID_FIELDS) {
        const label = fieldLabel(field);
        expect(label).toBeTruthy();
        expect(label).not.toBe(field);
      }
    });

    it("缺表鍵不得崩、不得空白——回退顯示原始英文鍵名（可接受回退）", () => {
      const changes: AuditChangeDto[] = [
        { field: "unmappedFutureField", before: null, after: "value" },
      ];

      expect(() => render(<AuditChangesList changes={changes} />)).not.toThrow();
      expect(screen.getByText("unmappedFutureField")).toBeInTheDocument();
      expect(screen.getByText("value")).toBeInTheDocument();
    });

    it('before/after 同名陷阱：field="before"／"after" 之中文標籤不得與表頭「改前」／「改後」同名（T1 即審 FW-4；BE1 後為保留條目，見 AuditChangesList.tsx 檔頭）', () => {
      // (b-0) 生效後，油耗巢狀 fixture 已不再產生 field="before"／"after"
      // （見 FUEL_CONSUMPTION_NESTED_CHANGES 檔頭說明）——本格改以獨立最小
      // fixture 直接構造這兩個保留條目（BE1 即審 FW-1：現行常態不可達，但
      // 仍可能以「兩側皆非物件」等未來形狀出現，保留可讀）。
      const changes: AuditChangeDto[] = [
        { field: "before", before: null, after: "x" },
        { field: "after", before: null, after: "y" },
      ];
      render(<AuditChangesList changes={changes} />);

      // 表頭固定為「欄位」／「改前」／「改後」三欄
      expect(screen.getByRole("columnheader", { name: "欄位" })).toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "改前" })).toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "改後" })).toBeInTheDocument();

      // field="before"／"after" 之「欄位」欄中文標籤不得逐字等於「改前」／「改後」
      // ——否則會與表頭同名，讀者會誤讀成「欄位＝改前」。
      expect(screen.queryByRole("cell", { name: "改前" })).not.toBeInTheDocument();
      expect(screen.queryByRole("cell", { name: "改後" })).not.toBeInTheDocument();
      expect(screen.getByText("異動前版本")).toBeInTheDocument();
      expect(screen.getByText("異動後版本")).toBeInTheDocument();
    });

    it("isActive（USER_DEACTIVATED／USER_ACTIVATED，BE1／BE2 後為 {field:'isActive', before:'true', after:'false'} 單列兩欄形）在對照表中；值依 AC-18(d) 譯為 是/否（T1 即審 FW-5 沿用 ＋ MG-1 新契約）", () => {
      // T-MG1-FE：舊契約之 {before:null, after:'{"from":true,"to":false}'}
      // 已隨 BE1／BE2 之 (b-1) 分派（{from,to} 與 {before,after} 同等待遇）
      // 汰換為本列單列兩欄形（見 audit-summary-flatten.test.ts :736）。
      const changes: AuditChangeDto[] = [{ field: "isActive", before: "true", after: "false" }];

      render(<AuditChangesList changes={changes} />);

      expect(screen.queryByText("isActive")).not.toBeInTheDocument();
      expect(screen.getByText("啟用狀態")).toBeInTheDocument();
      // AC-18(d)：布林限定欄位之 true/false → 是/否
      expect(screen.getByText("是")).toBeInTheDocument();
      expect(screen.getByText("否")).toBeInTheDocument();
      expect(screen.queryByText("true")).not.toBeInTheDocument();
      expect(screen.queryByText("false")).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain("[object Object]");
    });
  });

  describe("AC-18(d): 值層中文化", () => {
    /**
     * 14 值覆蓋守門常數（Spec §2 AC-18(d) 末段：`ApplicationType` 3 ＋
     * `FuelType` 4 ＋ `Role` 2 ＋ 參數類型 3 ＋ 布林 2）。**刻意獨立硬編、
     * 不從 `AuditChangesList.tsx` 之值映射表衍生**——理由同
     * `REQUIRED_SUMMARY_FIELDS`：若改為從 src 常數衍生，刪 src 值時本常數
     * 會同步縮小，「刪值即紅」之鑑別力即失效。
     */
    const REQUIRED_ENUM_VALUE_MAPPINGS: Array<{ field: string; value: string; label: string }> = [
      // type → ApplicationType 三值（沿 ApplicationListSection.tsx :30-32）
      { field: "type", value: "TRAVEL", label: "差旅補助" },
      { field: "type", value: "MAINTENANCE", label: "保養分攤" },
      { field: "type", value: "DEPRECIATION", label: "折舊補貼" },
      // fuelType → FuelType 四值（沿 AdminFuelConsumptionPage.tsx :59-62）
      { field: "fuelType", value: "GASOLINE_92", label: "92 無鉛汽油" },
      { field: "fuelType", value: "GASOLINE_95", label: "95 無鉛汽油" },
      { field: "fuelType", value: "GASOLINE_98", label: "98 無鉛汽油" },
      { field: "fuelType", value: "DIESEL", label: "柴油" },
      // role → Role 兩值（沿 AdminUsersPage.tsx :310／:413）
      { field: "role", value: "ADMIN", label: "管理員" },
      { field: "role", value: "USER", label: "一般使用者" },
      // parameterType → 參數類型三值（沿 ParametersPage.tsx :148／:361／:547）
      { field: "parameterType", value: "FUEL_PRICE", label: "油資參數（油價）" },
      { field: "parameterType", value: "ETC", label: "ETC 參數" },
      { field: "parameterType", value: "DEPRECIATION", label: "折舊參數" },
      // 布林兩值（限定布林欄位：isActive／mustChangePassword，此處以 isActive 取樣）
      { field: "isActive", value: "true", label: "是" },
      { field: "isActive", value: "false", label: "否" },
    ];

    it("枚舉四類逐值中文（type／fuelType／role／parameterType）", () => {
      const changes: AuditChangeDto[] = [
        { field: "type", before: "TRAVEL", after: "MAINTENANCE" },
        { field: "fuelType", before: "GASOLINE_92", after: "GASOLINE_95" },
        { field: "role", before: "USER", after: "ADMIN" },
        { field: "parameterType", before: "FUEL_PRICE", after: "ETC" },
      ];

      render(<AuditChangesList changes={changes} />);

      expect(screen.getByText("差旅補助")).toBeInTheDocument();
      expect(screen.getByText("保養分攤")).toBeInTheDocument();
      expect(screen.getByText("92 無鉛汽油")).toBeInTheDocument();
      expect(screen.getByText("95 無鉛汽油")).toBeInTheDocument();
      expect(screen.getByText("一般使用者")).toBeInTheDocument();
      expect(screen.getByText("管理員")).toBeInTheDocument();
      expect(screen.getByText("油資參數（油價）")).toBeInTheDocument();
      expect(screen.getByText("ETC 參數")).toBeInTheDocument();

      // 負向：原始英文值不逐字出現（皆已被翻譯覆蓋，非缺表回退）
      for (const raw of [
        "TRAVEL",
        "MAINTENANCE",
        "GASOLINE_92",
        "GASOLINE_95",
        "USER",
        "ADMIN",
        "FUEL_PRICE",
        "ETC",
      ]) {
        expect(screen.queryByText(raw)).not.toBeInTheDocument();
      }
    });

    it("布林 true/false → 是/否（限定布林欄位）", () => {
      const changes: AuditChangeDto[] = [
        { field: "isActive", before: "true", after: "false" },
        { field: "mustChangePassword", before: null, after: "true" },
      ];

      render(<AuditChangesList changes={changes} />);

      expect(screen.getAllByText("是").length).toBeGreaterThanOrEqual(2); // isActive.before ＋ mustChangePassword.after
      expect(screen.getAllByText("否").length).toBeGreaterThanOrEqual(1); // isActive.after
      expect(screen.queryByText("true")).not.toBeInTheDocument();
      expect(screen.queryByText("false")).not.toBeInTheDocument();
    });

    it("未知值與自由文字原樣顯示不崩（防誤譯：作廢原因逐字不被映射）", () => {
      // T6 W-1 沿用：布林／枚舉映射僅限定於特定欄位；"reason" 非限定欄位，
      // 即使值字面恰為 Role 枚舉值 "USER"，亦不得被誤譯為「一般使用者」。
      const freeTextReason = "USER 帳號設定有誤，重新申請（合成資料）";
      const changes: AuditChangeDto[] = [
        { field: "type", before: null, after: "UNKNOWN_FUTURE_TYPE" },
        { field: "reason", before: null, after: freeTextReason },
        // AR-10（PHASE-010-T-MG1-FE-R）：封「布林映射限定於布林欄位」半邊
        // ——"reason" 非布林限定欄位，即使值字面恰為 "true"，亦不得被誤譯
        // 為「是」（reviewer M23：移除欄位限定判斷後仍可能存活之缺口）。
        { field: "reason", before: null, after: "true" },
      ];

      expect(() => render(<AuditChangesList changes={changes} />)).not.toThrow();
      expect(screen.getByText("UNKNOWN_FUTURE_TYPE")).toBeInTheDocument();
      expect(screen.getByText(freeTextReason)).toBeInTheDocument();
      expect(screen.queryByText("一般使用者")).not.toBeInTheDocument();
      // AR-10：非布林限定欄位之 "true" 原樣顯示，不被譯為「是」。
      expect(screen.getByText("true")).toBeInTheDocument();
      expect(screen.queryByText("是")).not.toBeInTheDocument();
    });

    it("14 值覆蓋守門常數：刪任一值即紅", () => {
      expect(REQUIRED_ENUM_VALUE_MAPPINGS).toHaveLength(14);

      const changes: AuditChangeDto[] = REQUIRED_ENUM_VALUE_MAPPINGS.map(({ field, value }) => ({
        field,
        before: null,
        after: value,
      }));

      render(<AuditChangesList changes={changes} />);

      for (const { label } of REQUIRED_ENUM_VALUE_MAPPINGS) {
        expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ==========================================================================
  // AC-18(e)：純內部識別碼列不呈現（MG-3，T-MG3-FE 新增）
  // ==========================================================================
  //
  // 人類 leonchih 2026-08-10 Mock Gate 第二輪 MG-3 裁定逐字：「內部申請編號
  // （cuid）對人類無意義，畫面不顯示、資料庫可查即可」；同日消歧裁定＝
  // 「兩處都拿掉」之②半邊（①半邊為 `AuditLogPage` 之 targetLabel 截斷，見
  // `AuditLogPage.test.tsx` 之「AC-18(e)」describe）。
  describe("AC-18(e): 純內部識別碼列不呈現（MG-3）", () => {
    it("applicationId／revisionOf 兩列不渲染（正向）且其值字面零命中（負向）", () => {
      const changes: AuditChangeDto[] = [
        { field: "applicationId", before: null, after: "app-cuid-abc" },
        { field: "revisionOf", before: null, after: "app-cuid-prev" },
        { field: "type", before: null, after: "TRAVEL" },
      ];

      const { container } = render(<AuditChangesList changes={changes} />);

      // 正向：僅餘 1 個非隱藏欄位列（+ 表頭列）
      expect(screen.getAllByRole("row")).toHaveLength(2);
      expect(screen.queryByText("申請編號")).not.toBeInTheDocument();
      expect(screen.queryByText("修正自申請編號")).not.toBeInTheDocument();

      // 負向：兩隱藏欄位之值於全渲染結果零命中
      expect(container.textContent).not.toContain("app-cuid-abc");
      expect(container.textContent).not.toContain("app-cuid-prev");
    });

    it("其餘欄位列逐列照常渲染（防過濾過寬）", () => {
      const changes: AuditChangeDto[] = [
        { field: "applicationId", before: null, after: "app-cuid-1" },
        { field: "type", before: "TRAVEL", after: "MAINTENANCE" },
        { field: "revisionOf", before: null, after: "app-cuid-0" },
        { field: "reason", before: null, after: "測試作廢原因（合成資料）" },
      ];

      render(<AuditChangesList changes={changes} />);

      expect(screen.getByText("申請類型")).toBeInTheDocument();
      expect(screen.getByText("差旅補助")).toBeInTheDocument();
      expect(screen.getByText("保養分攤")).toBeInTheDocument();
      expect(screen.getByText("作廢原因")).toBeInTheDocument();
      expect(screen.getByText("測試作廢原因（合成資料）")).toBeInTheDocument();

      // 僅隱藏兩列不渲染：表頭列 + 2 非隱藏資料列 = 3 列
      expect(screen.getAllByRole("row")).toHaveLength(3);
    });

    it("隱藏欄常數恰兩鍵：刪一鍵／多一鍵之 mutant 必紅", () => {
      expect(HIDDEN_INTERNAL_ID_FIELDS.size).toBe(2);
      expect([...HIDDEN_INTERNAL_ID_FIELDS].sort()).toEqual(["applicationId", "revisionOf"]);

      // (e-3)：隱藏欄集合 ⊆ FIELD_LABELS 鍵集
      for (const field of HIDDEN_INTERNAL_ID_FIELDS) {
        expect(Object.prototype.hasOwnProperty.call(FIELD_LABELS, field)).toBe(true);
      }
    });

    it("(e-4) 刪 FIELD_LABELS 之 applicationId／revisionOf 任一鍵 → 32 鍵守門仍必紅（鑑別力自證）", () => {
      // 隱藏後渲染不到這兩鍵，「畫面不出現鍵名」之負向斷言對它們恆真——
      // 鑑別力改由標籤表本身承載：逐鍵須有非空、且不等於鍵名之標籤，
      // 「刪 FIELD_LABELS 之該鍵」之 mutant 會使 fieldLabel() 回退顯示原始
      // 英文鍵名（等於鍵名），下列斷言即必紅。
      for (const field of HIDDEN_INTERNAL_ID_FIELDS) {
        const label = fieldLabel(field);
        expect(label).toBeTruthy();
        expect(label).not.toBe(field);
      }
    });

    it("B-31 全列被濾 → 既有空態「（無異動明細）」且無空表頭", () => {
      const changes: AuditChangeDto[] = [
        { field: "applicationId", before: null, after: "app-cuid-x" },
        { field: "revisionOf", before: null, after: "app-cuid-y" },
      ];

      render(<AuditChangesList changes={changes} />);

      expect(screen.getByText("（無異動明細）")).toBeInTheDocument();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(screen.queryByRole("columnheader")).not.toBeInTheDocument();
    });
  });
});
