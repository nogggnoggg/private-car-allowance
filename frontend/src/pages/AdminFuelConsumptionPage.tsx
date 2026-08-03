/**
 * AdminFuelConsumptionPage — PHASE-005a-T10
 *
 * 管理員油耗維護頁（AC-30／AD-US-15 第 10 條）：管理員選定一位使用者後，
 * 檢視該使用者之油耗版本列表（歷史／目前生效／未來生效可辨識，含生效日期
 * 與依據備註）＋建立表單（使用者、油種、油耗、生效日、依據備註）。
 *
 * 版型比照 PHASE-003a 參數頁（ParametersPage.tsx）：`.param-table` 樣式、
 * 數值欄靠右 `.num-col`、日期 `YYYY-MM-DD`（見 PHASE-003a §13 UI-FIX-001）。
 *
 * 路由（App.tsx）：
 *   - `/admin/users/:userId/fuel-consumption`（自 AdminUsersPage 每列
 *     「油耗維護」連結進入，`:userId` 預選）
 *   - `/admin/fuel-consumption`（一般化入口，未預選使用者，需自下拉選單
 *     挑選——沿用 PHASE-004-T14 AdminUserApplicationsPage 之雙路由慣例，
 *     兩者掛載同一元件）
 *
 * 使用者清單重用既有 `GET /admin/users`（不新增後端 API，同 T14 之 C3）；
 * 「使用者」為建立表單五欄之一（使用者、油種、油耗、生效日、依據備註），
 * 以下拉選單實作，同時也是「管理員選定一位使用者」的操作入口本身。
 *
 * 五態：
 *   - Loading：等待 `/api/me` 解析，或（一旦確認為 ADMIN）等待
 *     `GET /admin/users`；送出鈕於送出中停用防重複提交。
 *   - Empty：已選使用者但尚無版本 → 「此使用者尚未建立油耗資料」。
 *   - Error：400 就地標示（含 `basisNote`）；404 使用者不存在；
 *     409 重疊（顯示衝突版本生效日）。
 *   - Success：版本列表更新，`state` 標示。
 *   - Permission denied：非管理員：頁面顯示「僅管理員可使用」，
 *     **在呼叫任何 API 之前**就短路（比照 ParametersPage.tsx／
 *     AdminUsersPage.tsx 既有寫法）——即使前端判斷被繞過，
 *     `requireAdmin` 仍會在後端擋下（defense in depth）。
 *
 * §11.3（硬性約束）：`state`（HISTORICAL/CURRENT/FUTURE）恆採後端
 * `FuelConsumptionVersionWithStateDto.state` 回傳值直接顯示，前端不得以
 * `effectiveFrom` 與今日日期自行比較推導（後端伺服器時鐘推導，T5R AR-1）。
 */

import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  apiCreateFuelConsumptionVersion,
  apiGetFuelConsumptionVersions,
} from "../api/fuelConsumption.js";
import { apiGetUsers } from "../api/users.js";
import { useAuth } from "../context/AuthContext.js";
import type {
  ApiError,
  FuelConsumptionVersionDto,
  FuelConsumptionVersionState,
  FuelType,
  UserDto,
} from "../types/api.js";

// ---- 固定四項油種（同 ParametersPage.tsx 之 FUEL_TYPE_OPTIONS，逐字沿用） ----

const FUEL_TYPE_OPTIONS: ReadonlyArray<{ value: FuelType; label: string }> = [
  { value: "GASOLINE_92", label: "92 無鉛汽油" },
  { value: "GASOLINE_95", label: "95 無鉛汽油" },
  { value: "GASOLINE_98", label: "98 無鉛汽油" },
  { value: "DIESEL", label: "柴油" },
];

const STATE_LABELS: Record<FuelConsumptionVersionState, string> = {
  HISTORICAL: "歷史",
  CURRENT: "目前生效",
  FUTURE: "未來生效",
};

/** 格式化日期為 YYYY-MM-DD（同 ParametersPage.tsx 之 formatDateYmd，本檔獨立複製一份，
 *  避免跨頁面元件耦合——見 Packet Files Allowed，不修改 ParametersPage.tsx）。 */
function formatDateYmd(input: string | Date): string {
  const d = typeof input === "string" ? new Date(input) : input;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Parse ApiError.details.conflictVersion if available（同 ParametersPage 慣例） */
function getConflictVersionInfo(err: ApiError): string | null {
  const details = err.details;
  if (details?.conflictVersion) {
    const cv = details.conflictVersion as Record<string, unknown>;
    if (cv.effectiveFrom) {
      return String(cv.effectiveFrom);
    }
  }
  return null;
}

// ---- Page-level state (使用者清單) ----

type UsersState =
  | { kind: "loading" }
  | { kind: "permission-denied" }
  | { kind: "error"; message: string }
  | { kind: "ready"; users: UserDto[] };

// ---- Section-level state (所選使用者之油耗版本列表) ----

type VersionsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; versions: FuelConsumptionVersionDto[] };

export default function AdminFuelConsumptionPage(): React.ReactElement {
  const { authState } = useAuth();
  const { userId: routeUserId } = useParams<{ userId?: string }>();

  const [usersState, setUsersState] = useState<UsersState>({ kind: "loading" });
  const [selectedUserId, setSelectedUserId] = useState<string>(routeUserId ?? "");
  const [versionsState, setVersionsState] = useState<VersionsState>({ kind: "idle" });

  const [fuelType, setFuelType] = useState<FuelType>("GASOLINE_92");
  const [kmPerLiter, setKmPerLiter] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [basisNote, setBasisNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  // ---- 使用者清單載入（重用既有 GET /admin/users，不新增後端 API） ----

  const loadUsers = useCallback(async () => {
    setUsersState({ kind: "loading" });
    try {
      const { users } = await apiGetUsers();
      setUsersState({ kind: "ready", users });
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "FORBIDDEN" || apiErr.code === "UNAUTHORIZED") {
        setUsersState({ kind: "permission-denied" });
      } else {
        setUsersState({ kind: "error", message: apiErr.message ?? "載入失敗，請稍後重試。" });
      }
    }
  }, []);

  useEffect(() => {
    if (authState.status === "authenticated") {
      if (authState.user.role !== "ADMIN") {
        // Permission denied：前端判斷在呼叫任何 API 之前短路（C1，同
        // ParametersPage.tsx／AdminUsersPage.tsx）。
        setUsersState({ kind: "permission-denied" });
        return;
      }
      loadUsers();
    }
  }, [authState, loadUsers]);

  // 路由層預選（從 AdminUsersPage 帶 :userId 進入）
  useEffect(() => {
    if (routeUserId) {
      setSelectedUserId(routeUserId);
    }
  }, [routeUserId]);

  // ---- 所選使用者之油耗版本列表載入 ----

  const loadVersions = useCallback(async (userId: string) => {
    setVersionsState({ kind: "loading" });
    try {
      const { versions } = await apiGetFuelConsumptionVersions(userId);
      setVersionsState({ kind: "ready", versions });
    } catch (err) {
      const apiErr = err as ApiError;
      setVersionsState({
        kind: "error",
        message:
          apiErr.code === "NOT_FOUND"
            ? "使用者不存在。"
            : (apiErr.message ?? "載入失敗，請稍後重試。"),
      });
    }
  }, []);

  useEffect(() => {
    if (usersState.kind === "ready" && selectedUserId) {
      loadVersions(selectedUserId);
    } else if (!selectedUserId) {
      setVersionsState({ kind: "idle" });
    }
  }, [usersState.kind, selectedUserId, loadVersions]);

  function handleSelectUser(id: string) {
    setSelectedUserId(id);
    setFormError(null);
    setFormSuccess(null);
    setFieldErrors({});
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedUserId) return;
    setFieldErrors({});
    setFormError(null);
    setFormSuccess(null);
    setSubmitting(true);
    try {
      await apiCreateFuelConsumptionVersion(selectedUserId, {
        fuelType,
        kmPerLiter,
        effectiveFrom,
        basisNote,
      });
      setFormSuccess("油耗版本建立成功。");
      setKmPerLiter("");
      setEffectiveFrom("");
      setBasisNote("");
      await loadVersions(selectedUserId);
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "VALIDATION_ERROR" && apiErr.fields && apiErr.fields.length > 0) {
        const fErrs: Record<string, string> = {};
        for (const f of apiErr.fields) {
          fErrs[f.field] = f.reason;
        }
        setFieldErrors(fErrs);
      } else if (apiErr.code === "PARAMETER_PERIOD_OVERLAP") {
        const conflictDate = getConflictVersionInfo(apiErr);
        if (conflictDate) {
          setFormError(`生效期間重疊，與版本（生效日：${conflictDate}）衝突，請調整生效日期。`);
        } else {
          setFormError(apiErr.message ?? "生效期間與現有版本重疊，請調整生效日期。");
        }
      } else if (apiErr.code === "NOT_FOUND") {
        setFormError("使用者不存在。");
      } else {
        setFormError(apiErr.message ?? "建立失敗，請稍後再試。");
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Render ----

  if (usersState.kind === "loading") {
    return (
      <div className="page-container">
        <div className="loading-block" aria-busy="true">
          <span className="spinner" aria-label="載入中" />
          <p>載入中…</p>
        </div>
      </div>
    );
  }

  if (usersState.kind === "permission-denied") {
    return (
      <div className="page-container">
        <div className="permission-denied-block" role="alert">
          <h2>存取被拒</h2>
          <p>僅管理員可使用此頁面。</p>
          <Link to="/" className="btn btn-secondary">
            返回首頁
          </Link>
        </div>
      </div>
    );
  }

  if (usersState.kind === "error") {
    return (
      <div className="page-container">
        <div className="error-block" role="alert">
          <p>{usersState.message}</p>
          <button type="button" className="btn btn-secondary" onClick={loadUsers}>
            重試
          </button>
        </div>
      </div>
    );
  }

  const { users } = usersState;
  const selectedUser = users.find((u) => u.id === selectedUserId) ?? null;

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>使用者油耗維護{selectedUser ? `：${selectedUser.displayName}` : ""}</h1>
        <div className="header-actions">
          <Link to="/admin/users" className="btn btn-secondary">
            返回使用者管理
          </Link>
        </div>
      </header>

      <main className="page-main">
        <div className="form-group">
          <label htmlFor="fc-user-select">使用者 *</label>
          <select
            id="fc-user-select"
            value={selectedUserId}
            onChange={(e) => handleSelectUser(e.target.value)}
            required
          >
            <option value="">請選擇使用者</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}（{u.loginName}）{u.isActive ? "" : "・已停用"}
              </option>
            ))}
          </select>
        </div>

        {selectedUserId ? (
          <>
            {/* Create form */}
            <div className="param-form-card">
              <h3>新增油耗版本</h3>
              {formError && (
                <div className="error-block" role="alert">
                  {formError}
                </div>
              )}
              {formSuccess && <output className="success-block">{formSuccess}</output>}
              <form onSubmit={handleSubmit} noValidate>
                <div className="form-group">
                  <label htmlFor="fc-fuelType">油種 *</label>
                  <select
                    id="fc-fuelType"
                    value={fuelType}
                    onChange={(e) => setFuelType(e.target.value as FuelType)}
                    disabled={submitting}
                    required
                    aria-describedby={fieldErrors.fuelType ? "fc-fuelType-err" : undefined}
                  >
                    {FUEL_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  {fieldErrors.fuelType && (
                    <span id="fc-fuelType-err" className="field-error" role="alert">
                      {fieldErrors.fuelType}
                    </span>
                  )}
                </div>
                <div className="form-group">
                  <label htmlFor="fc-kmPerLiter">油耗（公里／公升）*</label>
                  <input
                    id="fc-kmPerLiter"
                    type="number"
                    step="0.0001"
                    min="0"
                    value={kmPerLiter}
                    onChange={(e) => setKmPerLiter(e.target.value)}
                    disabled={submitting}
                    required
                    aria-describedby={fieldErrors.kmPerLiter ? "fc-kmPerLiter-err" : undefined}
                  />
                  {fieldErrors.kmPerLiter && (
                    <span id="fc-kmPerLiter-err" className="field-error" role="alert">
                      {fieldErrors.kmPerLiter}
                    </span>
                  )}
                </div>
                <div className="form-group">
                  <label htmlFor="fc-effectiveFrom">生效日期 *</label>
                  <input
                    id="fc-effectiveFrom"
                    type="date"
                    value={effectiveFrom}
                    onChange={(e) => setEffectiveFrom(e.target.value)}
                    disabled={submitting}
                    required
                    aria-describedby={
                      fieldErrors.effectiveFrom ? "fc-effectiveFrom-err" : undefined
                    }
                  />
                  {fieldErrors.effectiveFrom && (
                    <span id="fc-effectiveFrom-err" className="field-error" role="alert">
                      {fieldErrors.effectiveFrom}
                    </span>
                  )}
                </div>
                <div className="form-group">
                  <label htmlFor="fc-basisNote">依據備註 *</label>
                  <input
                    id="fc-basisNote"
                    type="text"
                    value={basisNote}
                    onChange={(e) => setBasisNote(e.target.value)}
                    disabled={submitting}
                    required
                    aria-describedby={fieldErrors.basisNote ? "fc-basisNote-err" : undefined}
                  />
                  {fieldErrors.basisNote && (
                    <span id="fc-basisNote-err" className="field-error" role="alert">
                      {fieldErrors.basisNote}
                    </span>
                  )}
                </div>
                <div className="btn-row">
                  <button type="submit" disabled={submitting} className="btn btn-primary">
                    {submitting ? "建立中…" : "建立"}
                  </button>
                </div>
              </form>
            </div>

            {/* Version list */}
            <div className="param-list-card">
              <h3>版本列表</h3>
              {versionsState.kind === "loading" && (
                <div className="loading-block" aria-busy="true">
                  <span className="spinner" aria-label="載入中" />
                  <p>載入中…</p>
                </div>
              )}
              {versionsState.kind === "error" && (
                <div className="error-block" role="alert">
                  <p>{versionsState.message}</p>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => loadVersions(selectedUserId)}
                  >
                    重試
                  </button>
                </div>
              )}
              {versionsState.kind === "ready" && versionsState.versions.length === 0 && (
                <div className="empty-block">
                  <p>此使用者尚未建立油耗資料</p>
                </div>
              )}
              {versionsState.kind === "ready" && versionsState.versions.length > 0 && (
                <div className="table-scroll">
                  <table className="param-table" aria-label="油耗版本清單">
                    <thead>
                      <tr>
                        <th>生效日期</th>
                        <th>油種</th>
                        <th className="num-col">油耗（公里／公升）</th>
                        <th>狀態</th>
                        <th>依據備註</th>
                        <th>建立時間</th>
                      </tr>
                    </thead>
                    <tbody>
                      {versionsState.versions.map((v) => (
                        <tr key={v.id}>
                          <td>{v.effectiveFrom}</td>
                          <td>
                            {FUEL_TYPE_OPTIONS.find((o) => o.value === v.fuelType)?.label ??
                              v.fuelType}
                          </td>
                          <td className="num-col">{v.kmPerLiter}</td>
                          <td>
                            <span className={`status-badge state-${v.state.toLowerCase()}`}>
                              {STATE_LABELS[v.state]}
                            </span>
                          </td>
                          <td>{v.basisNote}</td>
                          <td>{formatDateYmd(v.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="empty-block">
            <p>請先於上方選擇使用者，以檢視及維護其油耗資料。</p>
          </div>
        )}
      </main>
    </div>
  );
}
