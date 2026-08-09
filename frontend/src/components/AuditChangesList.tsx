/**
 * AuditChangesList — PHASE-010-T6（稽核變更清單元件；呈現安全）
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
 * 覆蓋鍵集（**合計 31 鍵**）：跨 Phase 追蹤上游 FW 實證之 17 個真實頂層鍵
 * （PHASE-010-T3 即審 FW-5）＋ T6 實查補入之 7 鍵（`segmentsCount`／`fuelType`／
 * `pricePerLiter`／`effectiveFrom`／`unitPrice`／`vehiclePrice`／
 * `usefulLifeYears`）＋ **T7R** 補入之 7 鍵（期中複審 #2 SF-2：`applicationYear`／
 * `annualTotalKm`／`actualCost`／`lastOdometerKm`／`currentOdometerKm`／
 * `lastMaintenanceDate`／`currentMaintenanceDate`）。
 *
 * 此 31 鍵為 `backend/src` 全樹實掃之**全集**（T7R 覆核 17 個 `summary` 構造點：
 * `admin/routes.ts` 之 5 個 `writeAudit` ＋ 3 個代建、`applications/routes.ts`
 * 之 3 個代改 ＋ 作廢 ＋ 修正版、`parameters/routes.ts` 之 3 個、
 * `users/fuel-consumption-routes.ts` 之 1 個）。「刪表中任一鍵即紅」之覆蓋守門
 * 由 `AuditChangesList.test.tsx` 之 `REQUIRED_SUMMARY_FIELDS` 承擔——T6 版僅列
 * 17 鍵，故當時加碼之 7 鍵零守門（期中複審 #2 AR-3），T7R 一併補齊。
 *
 * **`before`／`after` 同名陷阱**（T1 即審 FW-4）：`USER_FUEL_CONSUMPTION_
 * VERSION_CREATED` 巢狀混合形之 `summary` 頂層鍵字面就叫 `before`／`after`
 * ——攤平後兩列的「欄位」欄若直譯為「改前」／「改後」會與表頭同名，讀者會
 * 誤讀成「欄位＝改前，此列改前＝空，改後＝{…}」。故 `field === "before"`／
 * `"after"` 之中文標籤刻意譯為「異動前版本」／「異動後版本」，與欄頭
 * 「改前」／「改後」的字面區隔開。
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

/** AC-18(c)：完整 ISO 8601 UTC 時間字串（含時間成分）——純日期字串不匹配。 */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** `before`／`after` 單一值之呈現字串（`null` → 「—」）。 */
function formatValue(value: string | null): string {
  if (value === null) return "—";
  if (ISO_DATETIME_RE.test(value)) {
    // 與既有「計算時間」呈現同型，不另立第二種格式（見檔頭 AC-18(c) 說明）。
    return new Date(value).toLocaleString("zh-TW");
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
              <td>{formatValue(change.before)}</td>
              <td>{formatValue(change.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
