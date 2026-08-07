/**
 * ApplicationListSection — PHASE-004-T13
 *
 * 個人綜合紀錄列表 + 篩選（FE-US-04/05、AC-60~71/74/84）。Rendered inside
 * `HomePage`（一般使用者：自己的紀錄）. Kept as its own component (rather
 * than inlined into HomePage.tsx) so it can be unit-tested in isolation from
 * the page header/nav-link assertions already covered by
 * `frontend/test/HomePage.test.tsx` (PHASE-003a-T7, unmodifiable per C6),
 * and so PHASE-004-T14 (管理員檢視他人紀錄頁, out of this Task's scope) can
 * reuse it later via the optional `ownerId` prop below.
 *
 * D7 (後端權威): every displayed field — including `totalAmount` — comes
 * verbatim from `ApplicationListItemDto`; nothing here is computed.
 * AC-68: fields that don't apply to the row's type/status render literal
 * "—", never a guessed/derived value.
 */

import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  type ApplicationListItemDto,
  type ApplicationStatusDto,
  type ApplicationTypeDto,
  apiListApplications,
} from "../api/applications.js";
import type { ApiError } from "../types/api.js";

const TYPE_LABELS: Record<ApplicationTypeDto, string> = {
  TRAVEL: "差旅補助",
  MAINTENANCE: "保養分攤",
  DEPRECIATION: "折舊補貼",
};

// AC-62(b): type → detail-route path, exhaustive so a future new type is a
// compile-time error here (mirrors TYPE_LABELS above).
const TYPE_DETAIL_PATHS: Record<ApplicationTypeDto, string> = {
  TRAVEL: "/applications/travel",
  MAINTENANCE: "/applications/maintenance",
  DEPRECIATION: "/applications/depreciation",
};

const STATUS_LABELS: Record<ApplicationStatusDto, string> = {
  DRAFT: "草稿",
  COMPLETED: "已完成",
  VOIDED: "已作廢",
};

interface FilterFormState {
  dateFrom: string;
  dateTo: string;
  type: "" | ApplicationTypeDto;
  status: "" | ApplicationStatusDto;
  keyword: string;
}

const EMPTY_FILTERS: FilterFormState = {
  dateFrom: "",
  dateTo: "",
  type: "",
  status: "",
  keyword: "",
};

const PAGE_SIZE = 20;

type ListState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "permission-denied" }
  | {
      kind: "ready";
      items: ApplicationListItemDto[];
      page: number;
      pageSize: number;
      total: number;
    };

export interface ApplicationListSectionProps {
  /** Reused by the admin "檢視他人紀錄" page (PHASE-004-T14); omitted = self. */
  ownerId?: string;
  /**
   * PHASE-004-T14: the self-service "新增差旅補助" link (toolbar + empty
   * state) creates a draft owned by the CALLER (`POST /applications/travel`,
   * owner 恆為呼叫者 — AC-79a). That is wrong when this section is reused on
   * the admin "使用者 U 的申請紀錄" page: showing it there would let an admin
   * create a draft owned by *themselves* while viewing U's list, which is not
   * what Spec §3.2/§4 wants (that page has its own "代建立差旅草稿" entry,
   * calling `POST /admin/users/:userId/applications/travel` instead — see
   * `AdminUserApplicationsPage.tsx`). Defaults to `true` (existing self-view
   * behavior, PHASE-004-T13's `ApplicationListSection.test.tsx` renders with
   * no props and asserts this link is present — unchanged).
   */
  showCreateLink?: boolean;
  /**
   * PHASE-004-T14: Spec §4 為管理員頁的 Empty 狀態指定不同文案（「該使用者
   * 尚無申請紀錄」，而非個人列表頁的「尚無任何申請紀錄。」）. Defaults to the
   * original self-view text — unchanged for existing callers/tests.
   */
  emptyMessage?: string;
}

export default function ApplicationListSection({
  ownerId,
  showCreateLink = true,
  emptyMessage = "尚無任何申請紀錄。",
}: ApplicationListSectionProps): React.ReactElement {
  const [filters, setFilters] = useState<FilterFormState>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<FilterFormState>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<ListState>({ kind: "loading" });

  const hasActiveFilters =
    appliedFilters.dateFrom !== "" ||
    appliedFilters.dateTo !== "" ||
    appliedFilters.type !== "" ||
    appliedFilters.status !== "" ||
    appliedFilters.keyword.trim() !== "";

  const load = useCallback(
    async (f: FilterFormState, p: number) => {
      setState({ kind: "loading" });
      try {
        const res = await apiListApplications({
          ownerId,
          dateFrom: f.dateFrom || undefined,
          dateTo: f.dateTo || undefined,
          type: f.type || undefined,
          status: f.status || undefined,
          keyword: f.keyword.trim() || undefined,
          page: p,
          pageSize: PAGE_SIZE,
        });
        setState({
          kind: "ready",
          items: res.items,
          page: res.page,
          pageSize: res.pageSize,
          total: res.total,
        });
      } catch (err) {
        const apiErr = err as ApiError;
        if (apiErr.code === "FORBIDDEN" || apiErr.code === "UNAUTHORIZED") {
          setState({ kind: "permission-denied" });
        } else {
          setState({ kind: "error", message: apiErr.message ?? "載入失敗，請稍後重試。" });
        }
      }
    },
    [ownerId]
  );

  useEffect(() => {
    load(appliedFilters, page);
  }, [load, appliedFilters, page]);

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

  const loading = state.kind === "loading";
  const totalPages =
    state.kind === "ready" ? Math.max(1, Math.ceil(state.total / state.pageSize)) : 1;

  return (
    <section className="application-list-section" aria-label="我的申請紀錄">
      {showCreateLink && (
        <div className="list-toolbar">
          <Link to="/applications/travel/new" className="btn btn-primary">
            新增差旅補助
          </Link>
        </div>
      )}

      <form className="filter-bar" onSubmit={handleSubmitFilters} aria-label="篩選申請紀錄">
        <div className="form-group">
          <label htmlFor="filter-dateFrom">起日</label>
          <input
            id="filter-dateFrom"
            type="date"
            value={filters.dateFrom}
            onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
            disabled={loading}
          />
        </div>
        <div className="form-group">
          <label htmlFor="filter-dateTo">迄日</label>
          <input
            id="filter-dateTo"
            type="date"
            value={filters.dateTo}
            onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
            disabled={loading}
          />
        </div>
        <div className="form-group">
          <label htmlFor="filter-type">類型</label>
          <select
            id="filter-type"
            value={filters.type}
            onChange={(e) =>
              setFilters((f) => ({ ...f, type: e.target.value as FilterFormState["type"] }))
            }
            disabled={loading}
          >
            <option value="">全部</option>
            <option value="TRAVEL">差旅補助</option>
            <option value="MAINTENANCE">保養分攤</option>
            <option value="DEPRECIATION">折舊補貼</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="filter-status">狀態</label>
          <select
            id="filter-status"
            value={filters.status}
            onChange={(e) =>
              setFilters((f) => ({ ...f, status: e.target.value as FilterFormState["status"] }))
            }
            disabled={loading}
          >
            <option value="">全部</option>
            <option value="DRAFT">草稿</option>
            <option value="COMPLETED">已完成</option>
            {/* PHASE-009-T15b（AC-30(b)）：後端 `APPLICATION_STATUSES` 早已含
                `VOIDED`，缺口純在本下拉——無此選項則已作廢申請無法被篩出。 */}
            <option value="VOIDED">已作廢</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="filter-keyword">關鍵字（出差目的）</label>
          <input
            id="filter-keyword"
            type="text"
            value={filters.keyword}
            onChange={(e) => setFilters((f) => ({ ...f, keyword: e.target.value }))}
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

      {state.kind === "loading" && (
        <div className="loading-block" aria-busy="true">
          <span className="spinner" aria-label="載入中" />
          <p>載入中…</p>
        </div>
      )}

      {state.kind === "error" && (
        <div className="error-block" role="alert">
          <p>{state.message}</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => load(appliedFilters, page)}
          >
            重試
          </button>
        </div>
      )}

      {state.kind === "permission-denied" && (
        <div className="permission-denied-block" role="alert">
          <p>無權限存取此資料。</p>
        </div>
      )}

      {state.kind === "ready" && state.items.length === 0 && !hasActiveFilters && (
        <div className="empty-block">
          <p>{emptyMessage}</p>
          {showCreateLink && (
            <Link to="/applications/travel/new" className="btn btn-primary">
              新增差旅補助
            </Link>
          )}
        </div>
      )}

      {state.kind === "ready" && state.items.length === 0 && hasActiveFilters && (
        <div className="empty-block">
          <p>查無符合條件的紀錄。</p>
          <button type="button" className="btn btn-secondary" onClick={handleClearFilters}>
            清除篩選
          </button>
        </div>
      )}

      {state.kind === "ready" && state.items.length > 0 && (
        <>
          <div className="table-scroll">
            <table className="app-list-table" aria-label="申請紀錄清單">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>類型</th>
                  <th>狀態</th>
                  <th>出差目的</th>
                  <th>里程</th>
                  <th>金額</th>
                  <th>段數</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.primaryDate}</td>
                    <td>
                      <span className="type-badge">{TYPE_LABELS[item.type]}</span>
                      {/* PHASE-009-T16（AC-32／§7.2）：修正版徽章。純顯示，
                          只讀列表 DTO 之 `isRevision`（後端 `supersedesId
                          != null` 之投影，T16pre 落地）——列表刻意不外露
                          `supersedesId`，跳轉需求走詳情頁之 `supersedes`
                          投影（T16pre FW-2）。沿既有 `.type-badge` 樣式，
                          不新增 CSS class（AC-34 響應式沿既有慣例）。 */}
                      {item.isRevision && <span className="type-badge">修正版</span>}
                    </td>
                    <td>
                      <span className={`status-badge status-${item.status.toLowerCase()}`}>
                        {STATUS_LABELS[item.status]}
                      </span>
                    </td>
                    <td>{item.title ?? "—"}</td>
                    <td>{item.totalKm ?? "—"}</td>
                    <td>{item.totalAmount !== null ? item.totalAmount : "—"}</td>
                    <td>{item.segmentCount !== null ? item.segmentCount : "—"}</td>
                    <td>
                      <Link
                        to={`${TYPE_DETAIL_PATHS[item.type]}/${item.id}`}
                        className="btn btn-outline btn-sm"
                      >
                        檢視
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pagination">
            <span>
              第 {state.page} / {totalPages} 頁（共 {state.total} 筆）
            </span>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={state.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一頁
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={state.page * state.pageSize >= state.total}
                onClick={() => setPage((p) => p + 1)}
              >
                下一頁
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
