/**
 * AuditLogPage — PHASE-010-T7（稽核檢視頁：路由／入口／列表／篩選／分頁／五態）
 * ＋ PHASE-010-T7R（AC-16(d) 使用者下拉篩選；SF-1 人類裁定 2026-08-09）
 *
 * AD-US-14②③ 之使用者可見落點。路由 `/admin/audit-logs`（D10=(a)），管理員 only；
 * 一般使用者一律 Permission denied 態（AC-15(a)）。
 *
 * ---------------------------------------------------------------------------
 * Permission denied 之判定方式（沿 `AdminUsersPage.tsx` :71-79 既有模式）
 * ---------------------------------------------------------------------------
 * 進場先查 `authState.user.role`，非 `ADMIN` 即直接顯示 Permission denied，
 * **不**發送 `GET /admin/audit-logs`（§4 表「零後續請求」）。`load()` 之
 * catch 分支另對 `FORBIDDEN`／`UNAUTHORIZED`／`PASSWORD_CHANGE_REQUIRED` 三碼
 * 做同一分流，作為（例如工作階段於停留期間被撤銷等）後端真的回 403 時的
 * 兜底——兩層防禦沿既有頁面之既有紀律，非新設計。
 *
 * ---------------------------------------------------------------------------
 * 篩選與分頁（AC-16；沿 `ApplicationListSection.tsx` 既有模式）
 * ---------------------------------------------------------------------------
 * `filters`（表單即時值）與 `appliedFilters`（實際送出值）分離；僅
 * 「套用篩選」／「清除篩選」會把 `appliedFilters` 換新，且同時把 `page`
 * 重置為 1（AC-16(a)）。所有篩選與分頁值一律經 `apiListAuditLogs` 之 query
 * 參數送後端（`AuditLogQueryParams`）——本頁不對 `items` 做任何 `.filter()`
 * ／`.slice()`，AC-16(c) 之「零自行過濾」以此結構自然滿足。
 *
 * ---------------------------------------------------------------------------
 * AC-16(d)：`actorId`／`targetId` 兩篩選欄為使用者下拉（T7R）
 * ---------------------------------------------------------------------------
 * 人類 leonchih 2026-08-09 SF-1 裁定逐字：「改用使用者下拉」。選項文字為
 * **顯示名稱**、送出值為**使用者 id**；清單**複用既有** `apiGetUsers`
 * （`GET /admin/users`，`api/users.ts` :3），不另立端點——沿
 * `AdminFuelConsumptionPage.tsx` :297-309 之既有下拉先例。成因（Spec §2
 * AC-16(d)）：回應依 §6.3／AC-04(b) **不外露** `actorId`／`targetId`，管理員
 * 無從得知可輸入之值，故純文字 id 輸入實質不可用。
 *
 * 選項文字採 `顯示名稱（登入帳號）`（沿上述先例逐字）：顯示名稱可能重複，
 * 附掛登入帳號才足以區辨；登入帳號本就外露於列表之 `targetLabel`，非內部
 * 識別值，與 §6.3 不衝突。
 *
 * `apiGetUsers` 為管理員端點（`admin/routes.ts` 之 `adminPreHandlers` 含
 * `requireAdmin`），與本頁「管理員 only」相容；非管理員一律不發此請求。
 *
 * **降級**（清單載入失敗）：兩下拉停用並顯示提示，**列表與其餘篩選照常**
 * ——篩選為輔助功能，不得阻斷主功能（頁面不因此進 Error 態）。
 *
 * 分頁只提供上一頁／下一頁（無手打頁碼）——沿 T2 即審 FW-5 建議：後端
 * `page` 無上界、`skip` 超界回 200 空集合，若允許手打頁碼須前端 clamp，
 * 否則會出現 200 空白頁而無回饋；不提供手打頁碼即天然免疫此坑。
 * 「下一頁」停用條件 `page * pageSize >= total` 與「上一頁」停用條件
 * `page <= 1` 沿 `ApplicationListSection.tsx` 既有算式，永不依賴後端之
 * 無上界行為（AC-16(b)）。
 *
 * ---------------------------------------------------------------------------
 * 列表呈現（AC-15(c)／追加①／追加②）
 * ---------------------------------------------------------------------------
 * 四要素逐列：操作時間（追加②：`toLocaleString("zh-TW")` 在地化，沿
 * `AuditChangesList.tsx`／`ReportSection.tsx` 等既有「計算時間」呈現同型，
 * 不另立第二種格式；同頁不並存 ISO 原字串）／操作者（`actorDisplayName`）／
 * 操作類型（`AUDIT_ACTION_LABELS` 中文標籤，見下）／受影響資料
 * （`targetLabel`，必要時併 `targetDisplayName`，依 AC-04(c)）。
 *
 * 追加①（T6 W-3，大總管裁定）：`targetLabel` 經 React 文字節點渲染
 * （`{item.targetLabel}`），**不使用** `dangerouslySetInnerHTML`——理由與
 * 守門方式同 `AuditChangesList.tsx` 檔頭 AC-18(a) 段落，此處為該覆蓋在
 * 本頁列渲染處的落點。
 *
 * `changes[]` 之呈現直接複用 `AuditChangesList`（T6 既有元件，不重造——
 * 沿 T1 即審 FW-5／T3 即審 FW-6 上游 FW 義務）。
 *
 * ---------------------------------------------------------------------------
 * AUDIT_ACTION_LABELS（AC-10(c)）
 * ---------------------------------------------------------------------------
 * `Record<AuditAction, string>` 之型別本身即保證涵蓋全部 10 個 `AuditAction`
 * 值——缺一鍵是編譯期錯誤，不需額外執行期斷言。中文標籤之封閉覆蓋斷言
 * （enum 值集合 ⊆ 標籤表鍵集合）之測試義務歸 T4（本檔僅建表）。
 *
 * 檔案落點：Packet §15.2 註記本表「若依慣例應獨立檔案……以 T4 可 import
 * 為準，自行判斷並記錄理由」。選擇留在本檔並 `export`（而非另立
 * `components/audit-labels.ts`）：獨立檔會使本 Task 觸檔數達 7（超出
 * Files Allowed 之 6 檔上限），且此表僅本頁與 T4 兩處消費，非跨多元件共用
 * 之通用 util；T4 可直接 `import { AUDIT_ACTION_LABELS } from
 * "../src/pages/AuditLogPage.js"`。
 */

import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiListAuditLogs } from "../api/audit.js";
import { apiGetUsers } from "../api/users.js";
import AuditChangesList from "../components/AuditChangesList.js";
import { useAuth } from "../context/AuthContext.js";
import type { ApiError, AuditAction, AuditLogListItemDto, UserDto } from "../types/api.js";

/** AC-10(c)：`action` → 中文標籤（10 值封閉，見上方檔頭說明）。 */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  USER_CREATED: "新增使用者",
  USER_DEACTIVATED: "停用使用者",
  USER_ACTIVATED: "啟用使用者",
  USER_PASSWORD_RESET: "重設密碼",
  USER_DELETED: "刪除使用者",
  PARAMETER_VERSION_CREATED: "補助參數異動",
  APPLICATION_CREATED_ON_BEHALF: "代建立申請",
  APPLICATION_UPDATED_ON_BEHALF: "代修改申請",
  USER_FUEL_CONSUMPTION_VERSION_CREATED: "油耗資料異動",
  APPLICATION_VOIDED: "申請作廢",
};

interface FilterFormState {
  action: "" | AuditAction;
  actorId: string;
  targetId: string;
  dateFrom: string;
  dateTo: string;
}

const EMPTY_FILTERS: FilterFormState = {
  action: "",
  actorId: "",
  targetId: "",
  dateFrom: "",
  dateTo: "",
};

const PAGE_SIZE = 20;

/**
 * AC-16(d)：使用者下拉之清單狀態。`failed` 為**降級**態（非致命）——見檔頭
 * 「AC-16(d)」段落之降級設計。
 */
type UsersState = { kind: "loading" } | { kind: "ready"; users: UserDto[] } | { kind: "failed" };

type PageState =
  | { kind: "loading" }
  | { kind: "permission-denied" }
  | {
      kind: "error";
      message: string;
      fieldErrors?: Array<{ field: string; reason: string }>;
    }
  | {
      kind: "ready";
      items: AuditLogListItemDto[];
      page: number;
      pageSize: number;
      total: number;
    };

export default function AuditLogPage(): React.ReactElement {
  const { authState } = useAuth();

  const [filters, setFilters] = useState<FilterFormState>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<FilterFormState>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageState, setPageState] = useState<PageState>({ kind: "loading" });
  const [usersState, setUsersState] = useState<UsersState>({ kind: "loading" });

  const hasActiveFilters =
    appliedFilters.action !== "" ||
    appliedFilters.actorId.trim() !== "" ||
    appliedFilters.targetId.trim() !== "" ||
    appliedFilters.dateFrom !== "" ||
    appliedFilters.dateTo !== "";

  const load = useCallback(async (f: FilterFormState, p: number) => {
    setPageState({ kind: "loading" });
    try {
      const res = await apiListAuditLogs({
        action: f.action || undefined,
        actorId: f.actorId.trim() || undefined,
        targetId: f.targetId.trim() || undefined,
        dateFrom: f.dateFrom || undefined,
        dateTo: f.dateTo || undefined,
        page: p,
        pageSize: PAGE_SIZE,
      });
      setPageState({
        kind: "ready",
        items: res.items,
        page: res.page,
        pageSize: res.pageSize,
        total: res.total,
      });
    } catch (err) {
      const apiErr = err as ApiError;
      if (
        apiErr.code === "FORBIDDEN" ||
        apiErr.code === "UNAUTHORIZED" ||
        apiErr.code === "PASSWORD_CHANGE_REQUIRED"
      ) {
        setPageState({ kind: "permission-denied" });
      } else if (apiErr.code === "VALIDATION_ERROR" && apiErr.fields && apiErr.fields.length > 0) {
        setPageState({
          kind: "error",
          message: apiErr.message ?? "篩選參數有誤，請修正後再試。",
          fieldErrors: apiErr.fields,
        });
      } else {
        setPageState({ kind: "error", message: apiErr.message ?? "載入失敗，請稍後重試。" });
      }
    }
  }, []);

  useEffect(() => {
    if (authState.status !== "authenticated") return;
    if (authState.user.role !== "ADMIN") {
      setPageState({ kind: "permission-denied" });
      return;
    }
    load(appliedFilters, page);
  }, [authState, load, appliedFilters, page]);

  // AC-16(d)：兩個使用者下拉之選項來源。非管理員一律不發此請求（沿同頁
  // Permission denied 之「零後續請求」紀律）；失敗即降級，不阻斷列表。
  useEffect(() => {
    if (authState.status !== "authenticated") return;
    if (authState.user.role !== "ADMIN") return;
    let cancelled = false;
    void (async () => {
      try {
        const { users } = await apiGetUsers();
        if (!cancelled) setUsersState({ kind: "ready", users });
      } catch {
        if (!cancelled) setUsersState({ kind: "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authState]);

  function handleSubmitFilters(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setAppliedFilters(filters);
  }

  function handleClearFilters() {
    setFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    setPage(1);
  }

  // 進場時 authState 尚在 loading（`/api/me` 未回）——RequireAuth（App.tsx）
  // 已擋掉未登入者，此處僅為 authState 本身的短暫過渡態，沿既有頁面慣例
  // 顯示同一種載入中畫面。
  if (authState.status !== "authenticated") {
    return (
      <div className="page-container">
        <div className="loading-block" aria-busy="true">
          <span className="spinner" aria-label="載入中" />
          <p>載入中…</p>
        </div>
      </div>
    );
  }

  if (pageState.kind === "permission-denied") {
    return (
      <div className="page-container">
        <div className="permission-denied-block" role="alert">
          <h2>存取被拒</h2>
          <p>您沒有權限存取稽核紀錄頁面。</p>
          <Link to="/" className="btn btn-secondary">
            返回首頁
          </Link>
        </div>
      </div>
    );
  }

  const loading = pageState.kind === "loading";
  const userOptions = usersState.kind === "ready" ? usersState.users : [];
  const totalPages =
    pageState.kind === "ready" ? Math.max(1, Math.ceil(pageState.total / pageState.pageSize)) : 1;

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>稽核紀錄</h1>
        <div className="header-actions">
          <Link to="/" className="btn btn-secondary">
            返回首頁
          </Link>
        </div>
      </header>

      <main className="page-main">
        <form className="filter-bar" onSubmit={handleSubmitFilters} aria-label="篩選稽核紀錄">
          <div className="form-group">
            <label htmlFor="audit-filter-action">操作類型</label>
            <select
              id="audit-filter-action"
              value={filters.action}
              onChange={(e) =>
                setFilters((f) => ({ ...f, action: e.target.value as FilterFormState["action"] }))
              }
              disabled={loading}
            >
              <option value="">全部</option>
              {(Object.keys(AUDIT_ACTION_LABELS) as AuditAction[]).map((action) => (
                <option key={action} value={action}>
                  {AUDIT_ACTION_LABELS[action]}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="audit-filter-actorId">操作者</label>
            <select
              id="audit-filter-actorId"
              value={filters.actorId}
              onChange={(e) => setFilters((f) => ({ ...f, actorId: e.target.value }))}
              disabled={loading || usersState.kind !== "ready"}
            >
              <option value="">全部</option>
              {userOptions.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}（{u.loginName}）
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="audit-filter-targetId">受影響對象</label>
            <select
              id="audit-filter-targetId"
              value={filters.targetId}
              onChange={(e) => setFilters((f) => ({ ...f, targetId: e.target.value }))}
              disabled={loading || usersState.kind !== "ready"}
            >
              <option value="">全部</option>
              {userOptions.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}（{u.loginName}）
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="audit-filter-dateFrom">起日</label>
            <input
              id="audit-filter-dateFrom"
              type="date"
              value={filters.dateFrom}
              onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
              disabled={loading}
            />
          </div>
          <div className="form-group">
            <label htmlFor="audit-filter-dateTo">迄日</label>
            <input
              id="audit-filter-dateTo"
              type="date"
              value={filters.dateTo}
              onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
              disabled={loading}
            />
          </div>
          <div className="btn-row">
            <button type="submit" className="btn btn-secondary" disabled={loading}>
              套用篩選
            </button>
            <button
              type="button"
              className="btn btn-outline"
              onClick={handleClearFilters}
              disabled={loading}
            >
              清除篩選
            </button>
          </div>
        </form>

        {/* AC-16(d) 降級提示：沿既有 `<output className="warn-text">` 慣例
            （`DepreciationApplicationPage.tsx` :790）——非 Error 態，僅提示。 */}
        {usersState.kind === "failed" && (
          <output className="warn-text">
            使用者清單載入失敗，暫時無法依使用者篩選；其餘篩選與稽核列表不受影響。
          </output>
        )}

        {pageState.kind === "loading" && (
          <div className="loading-block" aria-busy="true">
            <span className="spinner" aria-label="載入中" />
            <p>載入中…</p>
          </div>
        )}

        {pageState.kind === "error" && (
          <div className="error-block" role="alert">
            <p>{pageState.message}</p>
            {pageState.fieldErrors && (
              <ul>
                {pageState.fieldErrors.map((fe) => (
                  <li key={fe.field}>
                    {fe.field}：{fe.reason}
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => load(appliedFilters, page)}
            >
              重試
            </button>
          </div>
        )}

        {pageState.kind === "ready" && pageState.items.length === 0 && !hasActiveFilters && (
          <div className="empty-block">
            <p>尚無任何稽核紀錄。</p>
          </div>
        )}

        {pageState.kind === "ready" && pageState.items.length === 0 && hasActiveFilters && (
          <div className="empty-block">
            <p>查無稽核紀錄。</p>
            <button type="button" className="btn btn-secondary" onClick={handleClearFilters}>
              清除篩選
            </button>
          </div>
        )}

        {pageState.kind === "ready" && pageState.items.length > 0 && (
          <>
            <ul className="audit-log-list" aria-label="稽核紀錄清單">
              {pageState.items.map((item) => (
                <li key={item.id} className="audit-log-item">
                  <div className="audit-log-item-header">
                    <span className="audit-log-time">
                      {new Date(item.createdAt).toLocaleString("zh-TW")}
                    </span>
                    <span className="audit-log-actor">{item.actorDisplayName}</span>
                    <span className="type-badge">{AUDIT_ACTION_LABELS[item.action]}</span>
                    <span className="audit-log-target">
                      {item.targetLabel}
                      {item.targetDisplayName !== null &&
                        item.targetDisplayName !== item.targetLabel && (
                          <>（{item.targetDisplayName}）</>
                        )}
                    </span>
                  </div>
                  <AuditChangesList changes={item.changes} />
                </li>
              ))}
            </ul>

            <div className="pagination">
              <span>
                第 {pageState.page} / {totalPages} 頁（共 {pageState.total} 筆）
              </span>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={pageState.page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  上一頁
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={pageState.page * pageState.pageSize >= pageState.total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一頁
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
