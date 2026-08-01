import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  apiActivateUser,
  apiCreateUser,
  apiDeactivateUser,
  apiDeleteUser,
  apiGetUsers,
  apiResetPassword,
} from "../api/users.js";
import { useAuth } from "../context/AuthContext.js";
import type { ApiError, UserDto } from "../types/api.js";

type PageState =
  | { kind: "loading" }
  | { kind: "permission-denied" }
  | { kind: "error"; message: string }
  | { kind: "ready"; users: UserDto[] };

interface Dialog {
  type: "add" | "reset-password" | "deactivate" | "activate" | "delete";
  userId?: string;
  userLabel?: string;
}

export default function AdminUsersPage(): React.ReactElement {
  const { authState } = useAuth();

  const [pageState, setPageState] = useState<PageState>({ kind: "loading" });
  const [dialog, setDialog] = useState<Dialog | null>(null);

  // Add form state
  const [addLoginName, setAddLoginName] = useState("");
  const [addDisplayName, setAddDisplayName] = useState("");
  const [addEmployeeNumber, setAddEmployeeNumber] = useState("");
  const [addTempPassword, setAddTempPassword] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addFieldErrors, setAddFieldErrors] = useState<Record<string, string>>({});
  const [addSuccess, setAddSuccess] = useState<string | null>(null);

  // Reset password form state
  const [resetPassword, setResetPassword] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = useState<string | null>(null);

  // Action state (deactivate/activate/delete)
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setPageState({ kind: "loading" });
    try {
      const { users } = await apiGetUsers();
      setPageState({ kind: "ready", users });
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "FORBIDDEN") {
        setPageState({ kind: "permission-denied" });
      } else if (apiErr.code === "UNAUTHORIZED") {
        setPageState({ kind: "permission-denied" });
      } else {
        setPageState({ kind: "error", message: apiErr.message ?? "載入失敗，請稍後重試。" });
      }
    }
  }, []);

  useEffect(() => {
    if (authState.status === "authenticated") {
      if (authState.user.role !== "ADMIN") {
        setPageState({ kind: "permission-denied" });
        return;
      }
      loadUsers();
    }
  }, [authState, loadUsers]);

  function openDialog(d: Dialog) {
    setDialog(d);
    setAddError(null);
    setAddFieldErrors({});
    setAddSuccess(null);
    setResetPassword("");
    setResetError(null);
    setResetSuccess(null);
    setActionError(null);
    setActionSuccess(null);
  }

  function closeDialog() {
    setDialog(null);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddError(null);
    setAddFieldErrors({});
    setAddSuccess(null);
    setAddLoading(true);
    try {
      await apiCreateUser({
        loginName: addLoginName,
        displayName: addDisplayName,
        employeeNumber: addEmployeeNumber || undefined,
        temporaryPassword: addTempPassword,
      });
      setAddSuccess("已建立，使用者首次登入須改密。");
      setAddLoginName("");
      setAddDisplayName("");
      setAddEmployeeNumber("");
      setAddTempPassword("");
      await loadUsers();
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.fields && apiErr.fields.length > 0) {
        const fErrs: Record<string, string> = {};
        for (const f of apiErr.fields) {
          fErrs[f.field] = f.reason;
        }
        setAddFieldErrors(fErrs);
      } else if (apiErr.code === "CONFLICT") {
        setAddError("帳號已被使用，請更換登入帳號。");
      } else {
        setAddError(apiErr.message ?? "新增失敗，請稍後再試。");
      }
    } finally {
      setAddLoading(false);
    }
  }

  async function handleDeactivate() {
    if (!dialog?.userId) return;
    setActionLoading(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      await apiDeactivateUser(dialog.userId);
      setActionSuccess("使用者已停用，既有登入已立即失效。");
      await loadUsers();
    } catch (err) {
      const apiErr = err as ApiError;
      setActionError(apiErr.message ?? "停用失敗，請稍後再試。");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleActivate() {
    if (!dialog?.userId) return;
    setActionLoading(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      await apiActivateUser(dialog.userId);
      setActionSuccess("使用者已啟用，可重新登入。");
      await loadUsers();
    } catch (err) {
      const apiErr = err as ApiError;
      setActionError(apiErr.message ?? "啟用失敗，請稍後再試。");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!dialog?.userId) return;
    setResetLoading(true);
    setResetError(null);
    setResetSuccess(null);
    try {
      await apiResetPassword(dialog.userId, resetPassword);
      setResetSuccess("已重設密碼，使用者下次登入須改密、既有登入已失效。");
      setResetPassword("");
    } catch (err) {
      const apiErr = err as ApiError;
      setResetError(apiErr.message ?? "重設密碼失敗，請稍後再試。");
    } finally {
      setResetLoading(false);
    }
  }

  async function handleDelete() {
    if (!dialog?.userId) return;
    setActionLoading(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      await apiDeleteUser(dialog.userId);
      setActionSuccess("使用者已刪除。");
      closeDialog();
      await loadUsers();
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "CONFLICT") {
        setActionError("此帳號已有資料，無法刪除，請改用停用。");
      } else {
        setActionError(apiErr.message ?? "刪除失敗，請稍後再試。");
      }
    } finally {
      setActionLoading(false);
    }
  }

  // ---- Render ----

  if (pageState.kind === "loading") {
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
          <p>您沒有權限存取使用者管理頁面。</p>
          <Link to="/" className="btn btn-secondary">
            返回首頁
          </Link>
        </div>
      </div>
    );
  }

  if (pageState.kind === "error") {
    return (
      <div className="page-container">
        <div className="error-block" role="alert">
          <p>{pageState.message}</p>
          <button type="button" className="btn btn-secondary" onClick={loadUsers}>
            重試
          </button>
        </div>
      </div>
    );
  }

  const { users } = pageState;

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>使用者管理</h1>
        <div className="header-actions">
          <Link to="/" className="btn btn-secondary">
            返回首頁
          </Link>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => openDialog({ type: "add" })}
          >
            新增使用者
          </button>
        </div>
      </header>

      <main className="page-main">
        {users.length === 0 ? (
          <div className="empty-block">
            <p>目前尚無使用者。</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => openDialog({ type: "add" })}
            >
              新增使用者
            </button>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <table className="users-table" aria-label="使用者清單">
              <thead>
                <tr>
                  <th>登入帳號</th>
                  <th>顯示姓名</th>
                  <th>員工編號</th>
                  <th>角色</th>
                  <th>狀態</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={u.isActive ? "" : "row-inactive"}>
                    <td>{u.loginName}</td>
                    <td>{u.displayName}</td>
                    <td>{u.employeeNumber ?? "—"}</td>
                    <td>{u.role === "ADMIN" ? "管理員" : "一般使用者"}</td>
                    <td>
                      <span
                        className={`status-badge ${u.isActive ? "status-active" : "status-inactive"}`}
                      >
                        {u.isActive ? "啟用" : "停用"}
                      </span>
                    </td>
                    <td className="action-cell">
                      {u.isActive ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-warn"
                          onClick={() =>
                            openDialog({
                              type: "deactivate",
                              userId: u.id,
                              userLabel: u.loginName,
                            })
                          }
                        >
                          停用
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          onClick={() =>
                            openDialog({
                              type: "activate",
                              userId: u.id,
                              userLabel: u.loginName,
                            })
                          }
                        >
                          啟用
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() =>
                          openDialog({
                            type: "reset-password",
                            userId: u.id,
                            userLabel: u.loginName,
                          })
                        }
                      >
                        重設密碼
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() =>
                          openDialog({
                            type: "delete",
                            userId: u.id,
                            userLabel: u.loginName,
                          })
                        }
                      >
                        刪除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile cards */}
            <div className="users-cards">
              {users.map((u) => (
                <div key={u.id} className={`user-card ${u.isActive ? "" : "card-inactive"}`}>
                  <div className="card-header">
                    <strong>{u.displayName}</strong>
                    <span
                      className={`status-badge ${u.isActive ? "status-active" : "status-inactive"}`}
                    >
                      {u.isActive ? "啟用" : "停用"}
                    </span>
                  </div>
                  <div className="card-body">
                    <span>帳號：{u.loginName}</span>
                    <span>員編：{u.employeeNumber ?? "—"}</span>
                    <span>角色：{u.role === "ADMIN" ? "管理員" : "一般使用者"}</span>
                  </div>
                  <div className="card-actions">
                    {u.isActive ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-warn"
                        onClick={() =>
                          openDialog({ type: "deactivate", userId: u.id, userLabel: u.loginName })
                        }
                      >
                        停用
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() =>
                          openDialog({ type: "activate", userId: u.id, userLabel: u.loginName })
                        }
                      >
                        啟用
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      onClick={() =>
                        openDialog({
                          type: "reset-password",
                          userId: u.id,
                          userLabel: u.loginName,
                        })
                      }
                    >
                      重設密碼
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() =>
                        openDialog({ type: "delete", userId: u.id, userLabel: u.loginName })
                      }
                    >
                      刪除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </main>

      {/* ---- Dialogs ---- */}

      {dialog?.type === "add" && (
        <div className="dialog-overlay">
          <dialog open className="dialog-box" aria-label="新增使用者">
            <h3>新增使用者</h3>

            {addError && (
              <div className="error-block" role="alert">
                {addError}
              </div>
            )}
            {addSuccess && <output className="success-block">{addSuccess}</output>}

            <form onSubmit={handleAdd} noValidate>
              <div className="form-group">
                <label htmlFor="add-loginName">登入帳號 *</label>
                <input
                  id="add-loginName"
                  type="text"
                  value={addLoginName}
                  onChange={(e) => setAddLoginName(e.target.value)}
                  disabled={addLoading}
                  required
                />
                {addFieldErrors.loginName && (
                  <span className="field-error">{addFieldErrors.loginName}</span>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="add-displayName">顯示姓名 *</label>
                <input
                  id="add-displayName"
                  type="text"
                  value={addDisplayName}
                  onChange={(e) => setAddDisplayName(e.target.value)}
                  disabled={addLoading}
                  required
                />
                {addFieldErrors.displayName && (
                  <span className="field-error">{addFieldErrors.displayName}</span>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="add-employeeNumber">員工編號（選填）</label>
                <input
                  id="add-employeeNumber"
                  type="text"
                  value={addEmployeeNumber}
                  onChange={(e) => setAddEmployeeNumber(e.target.value)}
                  disabled={addLoading}
                />
              </div>

              <div className="form-group">
                <label htmlFor="add-tempPassword">臨時密碼 *</label>
                <input
                  id="add-tempPassword"
                  type="password"
                  value={addTempPassword}
                  onChange={(e) => setAddTempPassword(e.target.value)}
                  disabled={addLoading}
                  required
                  autoComplete="new-password"
                />
                {addFieldErrors.temporaryPassword && (
                  <span className="field-error">{addFieldErrors.temporaryPassword}</span>
                )}
              </div>

              <div className="btn-row">
                <button type="submit" disabled={addLoading} className="btn btn-primary">
                  {addLoading ? "新增中…" : "新增"}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={closeDialog}
                  disabled={addLoading}
                >
                  關閉
                </button>
              </div>
            </form>
          </dialog>
        </div>
      )}

      {dialog?.type === "deactivate" && (
        <div className="dialog-overlay">
          <dialog open className="dialog-box" aria-label="確認停用">
            <h3>確認停用使用者</h3>
            <p>
              確定要停用帳號 <strong>{dialog.userLabel}</strong>？
            </p>
            <p className="warn-text">使用者將無法登入，且既有登入將立即失效。</p>

            {actionError && (
              <div className="error-block" role="alert">
                {actionError}
              </div>
            )}
            {actionSuccess && <output className="success-block">{actionSuccess}</output>}

            <div className="btn-row">
              {!actionSuccess && (
                <button
                  type="button"
                  className="btn btn-warn"
                  onClick={handleDeactivate}
                  disabled={actionLoading}
                >
                  {actionLoading ? "處理中…" : "確認停用"}
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closeDialog}
                disabled={actionLoading}
              >
                {actionSuccess ? "關閉" : "取消"}
              </button>
            </div>
          </dialog>
        </div>
      )}

      {dialog?.type === "activate" && (
        <div className="dialog-overlay">
          <dialog open className="dialog-box" aria-label="確認啟用">
            <h3>確認啟用使用者</h3>
            <p>
              確定要啟用帳號 <strong>{dialog.userLabel}</strong>？
            </p>

            {actionError && (
              <div className="error-block" role="alert">
                {actionError}
              </div>
            )}
            {actionSuccess && <output className="success-block">{actionSuccess}</output>}

            <div className="btn-row">
              {!actionSuccess && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleActivate}
                  disabled={actionLoading}
                >
                  {actionLoading ? "處理中…" : "確認啟用"}
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closeDialog}
                disabled={actionLoading}
              >
                {actionSuccess ? "關閉" : "取消"}
              </button>
            </div>
          </dialog>
        </div>
      )}

      {dialog?.type === "reset-password" && (
        <div className="dialog-overlay">
          <dialog open className="dialog-box" aria-label="重設使用者密碼">
            <h3>重設使用者密碼</h3>
            <p>
              帳號：<strong>{dialog.userLabel}</strong>
            </p>

            {resetError && (
              <div className="error-block" role="alert">
                {resetError}
              </div>
            )}
            {resetSuccess && <output className="success-block">{resetSuccess}</output>}

            {!resetSuccess && (
              <form onSubmit={handleResetPassword} noValidate>
                <div className="form-group">
                  <label htmlFor="reset-temp-password">新臨時密碼 *</label>
                  <input
                    id="reset-temp-password"
                    type="password"
                    value={resetPassword}
                    onChange={(e) => setResetPassword(e.target.value)}
                    disabled={resetLoading}
                    required
                    autoComplete="new-password"
                  />
                </div>
                <div className="btn-row">
                  <button type="submit" disabled={resetLoading} className="btn btn-primary">
                    {resetLoading ? "處理中…" : "確認重設"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={closeDialog}
                    disabled={resetLoading}
                  >
                    取消
                  </button>
                </div>
              </form>
            )}

            {resetSuccess && (
              <div className="btn-row">
                <button type="button" className="btn btn-secondary" onClick={closeDialog}>
                  關閉
                </button>
              </div>
            )}
          </dialog>
        </div>
      )}

      {dialog?.type === "delete" && (
        <div className="dialog-overlay">
          <dialog open className="dialog-box" aria-label="確認刪除">
            <h3>確認刪除使用者</h3>
            <p>
              確定要永久刪除帳號 <strong>{dialog.userLabel}</strong>？
            </p>
            <p className="warn-text">
              此操作無法復原。如有歷史資料，系統將拒絕刪除並建議改用停用。
            </p>

            {actionError && (
              <div className="error-block" role="alert">
                {actionError}
              </div>
            )}
            {actionSuccess && <output className="success-block">{actionSuccess}</output>}

            <div className="btn-row">
              {!actionSuccess && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={handleDelete}
                  disabled={actionLoading}
                >
                  {actionLoading ? "刪除中…" : "確認刪除"}
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closeDialog}
                disabled={actionLoading}
              >
                {actionSuccess ? "關閉" : "取消"}
              </button>
            </div>
          </dialog>
        </div>
      )}
    </div>
  );
}
