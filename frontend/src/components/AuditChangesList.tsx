/**
 * AuditChangesList — PHASE-010-T6（稽核變更清單元件；呈現安全）
 * ＋ PHASE-010-T-MG1-FE（Mock Gate MG-1 修復：值層中文化 ＋ 欄名表補 `kmPerLiter`）
 *
 * 呈現單一稽核列之 `changes: AuditChangeDto[]`（§7.2；由後端
 * `flattenAuditSummary` 攤平而得）為「欄位／改前／改後」三欄表格。
 *
 * 範圍界定：本元件**只**吃 `changes[]`，不接收／不呈現 `targetLabel`
 * ——依檔名與 Files Allowed 範圍，`targetLabel` 之跳脫呈現屬 T7
 * （`AuditLogPage` 實際渲染該欄位之處）之測試義務，非本檔涵蓋對象
 * （Out of Scope：稽核頁／路由／篩選／分頁歸 T7）。
 *
 * ---------------------------------------------------------------------------
 * AC-18(a) 呈現安全（跳脫）
 * ---------------------------------------------------------------------------
 * `before`／`after` 皆為使用者自由文字或系統值之字串化（作廢原因、出差目的、
 * 油耗依據備註…），一律經 React 文字節點渲染（`{value}`）——**不使用**
 * `dangerouslySetInnerHTML`，故 `<script>`／`"><img onerror=`／`javascript:`
 * 等 payload 只會被當成純文字顯示，不會被解析為標籤或觸發任何 handler。
 *
 * ---------------------------------------------------------------------------
 * AC-18(b) `[object Object]` 負向守門（前端自帶）
 * ---------------------------------------------------------------------------
 * 契約上 `before`／`after` 恆為 `string | null`（後端已對非純量值做
 * `JSON.stringify`，見 `backend/src/audit/audit-summary.ts`）。本元件不對其
 * 做任何會觸發 `Object.prototype.toString`（如樣板字串拼接非字串值）的路徑
 * ——`formatValue` 只接受 `string | null`，型別層面即排除誤把物件塞入的可能；
 * 守門測試以 AC-06(c) 之巢狀混合真實 fixture 驗證渲染結果零 `"[object Object]"`。
 *
 * ---------------------------------------------------------------------------
 * AC-18(c) 時間呈現（D9）
 * ---------------------------------------------------------------------------
 * `changes[]` 之值多為純文字或 JSON 字串，但個別欄位（如 `voidedAt`）之值為
 * 完整 ISO 8601 UTC 時間字串。與既有「計算時間」呈現同型（`toLocaleString
 * ("zh-TW")`，見 `ReportSection.tsx`／`TravelApplicationPage.tsx` 等既有慣例，
 * 不另立第二種格式）——偵測到完整 ISO 8601 時間字串（含 `T`／`Z`，非僅日期）
 * 即在地化呈現，不顯示原始 ISO 字面，避免同頁 ISO 與在地化字串並存
 * （PHASE-008 SF-2 同型再犯防護）。純日期字串（`YYYY-MM-DD`，如 `tripDate`／
 * `effectiveFrom`）不含時間成分，非本條守門對象，逐字顯示。
 *
 * ---------------------------------------------------------------------------
 * D3=(c) 中文欄名對照（§18 Gate 固化）
 * ---------------------------------------------------------------------------
 * `field` 為後端 `summary` 之英文頂層鍵名，此處提供中文標籤對照表；缺表鍵
 * **不得崩、不得空白**——回退顯示原始英文鍵名（可接受回退）。
 *
 * 覆蓋鍵集（**合計 32 鍵**）：跨 Phase 追蹤上游 FW 實證之 17 個真實頂層鍵
 * （PHASE-010-T3 即審 FW-5）＋ T6 實查補入之 7 鍵（`segmentsCount`／`fuelType`／
 * `pricePerLiter`／`effectiveFrom`／`unitPrice`／`vehiclePrice`／
 * `usefulLifeYears`）＋ **T7R** 補入之 7 鍵（期中複審 #2 SF-2：`applicationYear`／
 * `annualTotalKm`／`actualCost`／`lastOdometerKm`／`currentOdometerKm`／
 * `lastMaintenanceDate`／`currentMaintenanceDate`）＋ **T-MG1-FE** 補入之
 * 1 鍵（`kmPerLiter`——AC-06(b-0) 油耗巢狀子欄拆列後首度成為 `changes[].field`
 * 之可能值，AC-18(d) 末段裁定連動）。
 *
 * 此 32 鍵之定義（依 T-MG1-FE／AC-18(d) 末段裁定，接替 T7R 版之「backend/src
 * 全樹頂層鍵實掃全集」定義）：`changes[].field` 之**可能值全集**＝`summary`
 * 頂層鍵全集 ∪ AC-06(b-0) 子欄拆列之子鍵聯集。「刪表中任一鍵即紅」之覆蓋守門
 * 由 `AuditChangesList.test.tsx` 之 `REQUIRED_SUMMARY_FIELDS` 承擔——T6 版僅列
 * 17 鍵（期中複審 #2 AR-3）、T7R 擴為 31 鍵（SF-2），T-MG1-FE 補齊 `kmPerLiter`
 * 達 32 鍵。
 *
 * **`before`／`after` 兩鍵（(b-0) 後常態不可達之保留條目）**：MG-1 之
 * AC-06(b-0) 生效後，`USER_FUEL_CONSUMPTION_VERSION_CREATED` 之油耗巢狀形
 * 已改為逐子欄拆列（`fuelType`／`kmPerLiter`／`effectiveFrom` 三列 ＋
 * `basisNote` 一列），**不再**產生頂層 `field: "before"`／`"after"` 列——此為
 * 目前唯一會觸發 (b-0) 之事件類型。故本表之 `before`／`after` 兩鍵於**現行
 * 常態流量下不可達**（BE1 即審 FW-1，大總管裁定：保留）；保留理由＝防禦未來
 * 不觸發 (b-0) 預檢之形狀（如兩側皆非物件，或新增事件類型之 `summary` 頂層
 * 恰含字面 `before`／`after` 鍵但值為純量）仍可讀，而非顯示未翻譯之英文鍵名。
 * 32 鍵計數**含**此 2 保留條目（非另外累加）。
 *
 * **`before`／`after` 同名陷阱**（T1 即審 FW-4）：上述保留情境若真的觸發，
 * 攤平後之列若直譯「欄位」為「改前」／「改後」會與表頭同名，讀者會誤讀成
 * 「欄位＝改前，此列改前＝空，改後＝{…}」。故 `field === "before"`／`"after"`
 * 之中文標籤刻意譯為「異動前版本」／「異動後版本」，與欄頭「改前」／「改後」
 * 的字面區隔開。
 *
 * ---------------------------------------------------------------------------
 * AC-18(d) 值層中文化（MG-1 裁定；T-MG1-FE）
 * ---------------------------------------------------------------------------
 * `changes[].before`／`after` 之**值**（非欄名）依**欄位限定**之枚舉映射表
 * 中文化——`type`（`ApplicationType` 三值，沿 `ApplicationListSection.tsx`
 * :30-32）／`fuelType`（`FuelType` 四值，沿 `AdminFuelConsumptionPage.tsx`
 * :59-62）／`role`（`Role` 兩值，沿 `AdminUsersPage.tsx` :310／:413）／
 * `parameterType`（參數類型三值，沿 `ParametersPage.tsx` 三節標題 :148／
 * :361／:547）；布林字面 `"true"`／`"false"` → 「是」／「否」，**限定**於
 * `isActive`／`mustChangePassword` 兩欄（T6 W-1 沿用：自由文字欄零轉換，防
 * 「作廢原因寫 `USER` 被誤譯」）。**依欄位限定**——同一值字面（如
 * `parameterType` 與 `type` 皆可能出現 `"DEPRECIATION"`）在不同欄位有不同
 * 中文譯法，故映射表以 `field` 為第一層鍵、**不是**全域「值 → 標籤」單層表。
 * 未知值（映射表無對應）與非限定欄位之值一律原樣回退顯示（同 D3=(c) 欄名
 * 對照表之回退慣例），不崩、不空白。覆蓋守門常數見
 * `AuditChangesList.test.tsx`（14 值：`ApplicationType` 3 ＋ `FuelType` 4 ＋
 * `Role` 2 ＋ 參數類型 3 ＋ 布林 2；沿 `REQUIRED_SUMMARY_FIELDS` 之守門形狀，
 * 獨立硬編、不衍生自本檔常數，以保有「刪值即紅」之鑑別力）。
 */

import type React from "react";
import type { AuditChangeDto } from "../types/api.js";

/** D3=(c)：`summary` 頂層鍵 → 中文標籤（缺表鍵回退顯示原鍵名）。 */
const FIELD_LABELS: Record<string, string> = {
  applicationId: "申請編號",
  type: "申請類型",
  reason: "作廢原因",
  voidedAt: "作廢時間",
  revisionOf: "修正自申請編號",
  tripDate: "出差日期",
  purpose: "出差目的",
  // 同名陷阱（T1 即審 FW-4）：不得譯為「改前」／「改後」（與表頭同名）。
  before: "異動前版本",
  after: "異動後版本",
  basisNote: "依據備註",
  parameterType: "參數類型",
  isActive: "啟用狀態",
  mustChangePassword: "須於下次登入變更密碼",
  role: "角色",
  employeeNumber: "員工編號",
  deletedLoginName: "已刪除之登入帳號",
  deletedDisplayName: "已刪除之顯示名稱",
  segmentsCount: "行程段數",
  fuelType: "油種",
  pricePerLiter: "每公升油價",
  // T-MG1-FE：AC-06(b-0) 油耗巢狀子欄拆列後首度成為 field 之新鍵；標籤沿
  // `AdminFuelConsumptionPage.tsx` :347 之表單標籤逐字，不另立第二種說法。
  kmPerLiter: "油耗（公里／公升）",
  effectiveFrom: "生效日",
  unitPrice: "單價",
  vehiclePrice: "車輛價格",
  usefulLifeYears: "耐用年限",
  // T7R（期中複審 #2 SF-2）：保養／折舊代建與代改之真實高頻鍵。中文用詞逐字
  // 沿既有申請頁之 `<dt>`（`MaintenanceApplicationPage.tsx` :611-620、
  // `DepreciationApplicationPage.tsx` :633、:654），不另立第二種說法。
  applicationYear: "申請年度",
  annualTotalKm: "年度總里程",
  actualCost: "本次實際保養費用",
  lastOdometerKm: "上次里程表",
  currentOdometerKm: "本次里程表",
  lastMaintenanceDate: "上次保養日期",
  currentMaintenanceDate: "本次保養日期",
};

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** AC-18(d)：`type` → `ApplicationType` 三值中文（沿 `ApplicationListSection.tsx` :30-32）。 */
export const TYPE_VALUE_LABELS: Record<string, string> = {
  TRAVEL: "差旅補助",
  MAINTENANCE: "保養分攤",
  DEPRECIATION: "折舊補貼",
};

/** AC-18(d)：`fuelType` → `FuelType` 四值中文（沿 `AdminFuelConsumptionPage.tsx` :59-62）。 */
export const FUEL_TYPE_VALUE_LABELS: Record<string, string> = {
  GASOLINE_92: "92 無鉛汽油",
  GASOLINE_95: "95 無鉛汽油",
  GASOLINE_98: "98 無鉛汽油",
  DIESEL: "柴油",
};

/** AC-18(d)：`role` → `Role` 兩值中文（沿 `AdminUsersPage.tsx` :310／:413、`HomePage.tsx` :20）。 */
export const ROLE_VALUE_LABELS: Record<string, string> = {
  ADMIN: "管理員",
  USER: "一般使用者",
};

/** AC-18(d)：`parameterType` → 參數類型三值中文（沿 `ParametersPage.tsx` 三節標題 :148／:361／:547）。 */
export const PARAMETER_TYPE_VALUE_LABELS: Record<string, string> = {
  FUEL_PRICE: "油資參數（油價）",
  ETC: "ETC 參數",
  DEPRECIATION: "折舊參數",
};

/**
 * AC-18(d)：依欄位限定之枚舉值映射表——`field` → 該欄位之「值 → 中文標籤」表。
 * 刻意以 `field` 為第一層鍵（**非**全域單層「值 → 標籤」表）：同一值字面
 * （如 `"DEPRECIATION"`）在 `type`／`parameterType` 兩欄位有不同中文譯法，
 * 全域字面替換會誤譯；亦防「作廢原因」等自由文字欄被意外命中（見檔頭
 * AC-18(d) 段落）。
 */
export const ENUM_VALUE_LABELS_BY_FIELD: Record<string, Record<string, string>> = {
  type: TYPE_VALUE_LABELS,
  fuelType: FUEL_TYPE_VALUE_LABELS,
  role: ROLE_VALUE_LABELS,
  parameterType: PARAMETER_TYPE_VALUE_LABELS,
};

/** AC-18(d)：布林限定欄位——僅這些欄位之 `"true"`／`"false"` 字面轉換為 是/否（T6 W-1 沿用）。 */
export const BOOLEAN_FIELDS: ReadonlySet<string> = new Set(["isActive", "mustChangePassword"]);

/** AC-18(d)：布林值 → 中文（僅 `BOOLEAN_FIELDS` 成員欄位適用）。 */
export const BOOLEAN_VALUE_LABELS: Record<"true" | "false", string> = {
  true: "是",
  false: "否",
};

/** AC-18(c)：完整 ISO 8601 UTC 時間字串（含時間成分）——純日期字串不匹配。 */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * `before`／`after` 單一值之呈現字串（`null` → 「—」）。
 *
 * AC-18(d)：`field` 用於查依欄位限定之枚舉／布林值映射表；未命中（未知值、
 * 非限定欄位、或自由文字）一律原樣回退，語意與 D3=(c) 之 `fieldLabel` 回退
 * 慣例同型。判斷順序：ISO 時間（AC-18(c)，語意不變）→ 枚舉映射 → 布林映射
 * → 原樣回退。
 */
function formatValue(field: string, value: string | null): string {
  if (value === null) return "—";
  if (ISO_DATETIME_RE.test(value)) {
    // 與既有「計算時間」呈現同型，不另立第二種格式（見檔頭 AC-18(c) 說明）。
    return new Date(value).toLocaleString("zh-TW");
  }
  const enumLabels = ENUM_VALUE_LABELS_BY_FIELD[field];
  if (enumLabels) {
    const enumLabel = enumLabels[value];
    if (enumLabel !== undefined) return enumLabel;
  }
  if (BOOLEAN_FIELDS.has(field) && (value === "true" || value === "false")) {
    return BOOLEAN_VALUE_LABELS[value];
  }
  return value;
}

export interface AuditChangesListProps {
  changes: AuditChangeDto[];
}

export default function AuditChangesList({ changes }: AuditChangesListProps): React.ReactElement {
  if (changes.length === 0) {
    return <p className="audit-changes-empty">（無異動明細）</p>;
  }

  return (
    <div className="table-scroll">
      <table className="audit-changes-table" aria-label="異動明細">
        <thead>
          <tr>
            <th>欄位</th>
            <th>改前</th>
            <th>改後</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change, index) => (
            <tr key={`${change.field}-${index}`}>
              <td>{fieldLabel(change.field)}</td>
              <td>{formatValue(change.field, change.before)}</td>
              <td>{formatValue(change.field, change.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
