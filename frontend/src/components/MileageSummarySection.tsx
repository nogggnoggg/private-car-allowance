/**
 * MileageSummarySection — PHASE-005-T7
 *
 * 共用元件：區間公務總里程統計查詢區塊（FE-US-06、AD-US-06）。依 Gate 定案
 * D6(a)，本元件嵌入既有頁面（本 Task 僅嵌入 `HomePage`——一般使用者查詢自己；
 * `/admin/users/:userId/applications` 之嵌入屬 T8，不在本檔範圍）。透過
 * 可選的 `ownerId` prop 供 T8 之後複用（管理員查詢指定使用者），本 Task 不
 * 使用該分支。
 *
 * 五態（AC-27，明細見 Spec §4）：
 *   - Loading：查詢中，數值區顯示「計算中…」，查詢鈕停用（防重複提交）。
 *   - Empty：後端回 `totalKm === "0.00"` → 顯示「0.00 公里」＋ zh-TW 說明
 *     （AC-29），非錯誤樣式。
 *   - Error：400 `VALIDATION_ERROR` → 依 `fields` 就地標示 `dateFrom`／
 *     `dateTo`／`dateRange`（AC-28）；其餘（5xx／網路失敗）→ zh-TW 訊息 +
 *     「重試」。
 *   - Success：顯示「公務總里程 X.XX 公里」＋ 實際套用區間（`appliedFilters`）。
 *   - Permission denied：401／403（`FORBIDDEN`／`PASSWORD_CHANGE_REQUIRED`）
 *     → 可辨識之 zh-TW 訊息，不顯示任何數值。
 *
 * D5(a)：起訖皆必填，初始態（尚未查詢）不自動查詢、不套用任何預設值，顯示
 * 「請選擇日期區間後查詢」（Spec §4 表下方註）。
 *
 * AC-28：前端就地驗證（起 ≤ 迄；必填）僅為體驗，不呼叫後端即可攔截；後端
 * 仍為權威——即使前端未攔截（或前端與後端驗證邏輯有落差），後端 400 之
 * `fields.dateRange`／`fields.dateFrom`／`fields.dateTo` 一律就地呈現於對應
 * 欄位（與 `ParametersPage.tsx` 之 `fieldErrors` 慣例一致）。
 *
 * AC-30：顯示值一律逐字取自 `apiGetMileageSummary`（`frontend/src/api/
 * statistics.ts`）之回應——本檔不對任何列表資料做加總或其他數值運算。
 */

import type React from "react";
import { useCallback, useState } from "react";
import { type MileageSummaryResponse, apiGetMileageSummary } from "../api/statistics.js";
import type { ApiError } from "../types/api.js";

type SummaryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "permission-denied"; message: string }
  | { kind: "success"; data: MileageSummaryResponse };

export interface MileageSummarySectionProps {
  /** T8 之後供管理員頁複用（檢視指定使用者統計）；本 Task 不使用。省略 = 自己。 */
  ownerId?: string;
  /** 標題文字；預留供 T8 之後覆寫（例如「檢視中：<displayName>」）。 */
  title?: string;
}

export default function MileageSummarySection({
  ownerId,
  title = "區間公務總里程統計",
}: MileageSummarySectionProps): React.ReactElement {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [state, setState] = useState<SummaryState>({ kind: "idle" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const loading = state.kind === "loading";

  const runQuery = useCallback(
    async (df: string, dt: string) => {
      setState({ kind: "loading" });
      try {
        const data = await apiGetMileageSummary({ dateFrom: df, dateTo: dt, ownerId });
        setFieldErrors({});
        setState({ kind: "success", data });
      } catch (err) {
        const apiErr = err as ApiError;
        if (apiErr.code === "FORBIDDEN") {
          setState({ kind: "permission-denied", message: "無權查詢此使用者之統計。" });
        } else if (apiErr.code === "PASSWORD_CHANGE_REQUIRED") {
          setState({ kind: "permission-denied", message: "請先完成密碼變更後再查詢。" });
        } else if (apiErr.code === "UNAUTHORIZED") {
          setState({ kind: "permission-denied", message: "請重新登入後再查詢。" });
        } else if (
          apiErr.code === "VALIDATION_ERROR" &&
          apiErr.fields &&
          apiErr.fields.length > 0
        ) {
          const fErrs: Record<string, string> = {};
          for (const f of apiErr.fields) {
            fErrs[f.field] = f.reason;
          }
          setFieldErrors(fErrs);
          setState({ kind: "idle" });
        } else {
          setState({ kind: "error", message: apiErr.message ?? "查詢失敗，請稍後重試。" });
        }
      }
    },
    [ownerId]
  );

  function validateLocally(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!dateFrom) errs.dateFrom = "起日為必填";
    if (!dateTo) errs.dateTo = "迄日為必填";
    if (dateFrom && dateTo && dateFrom > dateTo) {
      errs.dateRange = "起日不可晚於迄日，請重新選擇日期區間。";
    }
    return errs;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return; // 防重複提交（查詢中禁用按鈕已擋住點擊，此為雙重防線）

    // AC-28：前端就地攔截（體驗用；不呼叫後端）。
    const localErrors = validateLocally();
    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      return;
    }

    setFieldErrors({});
    void runQuery(dateFrom, dateTo);
  }

  function handleRetry() {
    if (loading) return;
    void runQuery(dateFrom, dateTo);
  }

  const dateFromDescribedBy =
    [
      fieldErrors.dateFrom && "mileage-dateFrom-err",
      fieldErrors.dateRange && "mileage-dateRange-err",
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const dateToDescribedBy =
    [fieldErrors.dateTo && "mileage-dateTo-err", fieldErrors.dateRange && "mileage-dateRange-err"]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <section className="mileage-summary-section" aria-labelledby="mileage-summary-heading">
      <h2 id="mileage-summary-heading">{title}</h2>

      <form
        className="filter-bar"
        onSubmit={handleSubmit}
        aria-label="區間公務總里程查詢"
        noValidate
      >
        <div className="form-group">
          <label htmlFor="mileage-dateFrom">起日 *</label>
          <input
            id="mileage-dateFrom"
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            disabled={loading}
            aria-describedby={dateFromDescribedBy}
          />
          {fieldErrors.dateFrom && (
            <span id="mileage-dateFrom-err" className="field-error" role="alert">
              {fieldErrors.dateFrom}
            </span>
          )}
        </div>
        <div className="form-group">
          <label htmlFor="mileage-dateTo">迄日 *</label>
          <input
            id="mileage-dateTo"
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            disabled={loading}
            aria-describedby={dateToDescribedBy}
          />
          {fieldErrors.dateTo && (
            <span id="mileage-dateTo-err" className="field-error" role="alert">
              {fieldErrors.dateTo}
            </span>
          )}
        </div>
        {fieldErrors.dateRange && (
          <span id="mileage-dateRange-err" className="field-error" role="alert">
            {fieldErrors.dateRange}
          </span>
        )}
        <div className="btn-row">
          <button type="submit" className="btn btn-secondary" disabled={loading}>
            {loading ? "計算中…" : "查詢"}
          </button>
        </div>
      </form>

      <div className="mileage-summary-result">
        {state.kind === "idle" && <p className="mileage-summary-hint">請選擇日期區間後查詢</p>}

        {state.kind === "loading" && (
          <div className="loading-block" aria-busy="true">
            <span className="spinner" aria-label="計算中" />
            <p>計算中…</p>
          </div>
        )}

        {state.kind === "error" && (
          <div className="error-block" role="alert">
            <p>{state.message}</p>
            <button type="button" className="btn btn-secondary" onClick={handleRetry}>
              重試
            </button>
          </div>
        )}

        {state.kind === "permission-denied" && (
          <div className="permission-denied-block" role="alert">
            <p>{state.message}</p>
          </div>
        )}

        {state.kind === "success" && state.data.totalKm === "0.00" && (
          <div className="empty-block">
            <p className="mileage-summary-value">0.00 公里</p>
            <p>此區間無已完成的差旅紀錄</p>
          </div>
        )}

        {state.kind === "success" && state.data.totalKm !== "0.00" && (
          <div className="mileage-summary-value-block">
            <p className="mileage-summary-value">公務總里程 {state.data.totalKm} 公里</p>
            <p className="mileage-summary-meta">
              查詢區間：{state.data.appliedFilters.dateFrom} ～ {state.data.appliedFilters.dateTo}
              （共 {state.data.applicationCount} 筆）
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
