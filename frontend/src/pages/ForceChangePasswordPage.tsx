import type React from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiChangePassword } from "../api/auth.js";
import { useAuth } from "../context/AuthContext.js";
import type { ApiError } from "../types/api.js";

export default function ForceChangePasswordPage(): React.ReactElement {
  const { refreshAuth, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setFieldErrors({});

    // Front-end validation: confirm match
    if (newPassword !== confirmPassword) {
      setFieldErrors({ confirmPassword: "兩次輸入的新密碼不一致。" });
      return;
    }

    // Front-end validation: min length
    if (newPassword.length < 10) {
      setFieldErrors({ newPassword: "密碼至少需 10 個字元。" });
      return;
    }

    setLoading(true);
    try {
      await apiChangePassword({ currentPassword, newPassword });
      setSuccess(true);
      // Refresh auth state so mustChangePassword is updated
      await refreshAuth();
      navigate("/", { replace: true });
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.fields && apiErr.fields.length > 0) {
        const fErrs: Record<string, string> = {};
        for (const f of apiErr.fields) {
          fErrs[f.field] = f.reason;
        }
        setFieldErrors(fErrs);
      } else {
        setErrorMsg(apiErr.message ?? "改密失敗，請稍後再試。");
      }
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h2>密碼已更新</h2>
          <p>密碼已成功變更，正在導向首頁…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>油資管理系統</h1>
        <h2>首次登入請變更密碼</h2>
        <p className="hint">您使用的是臨時密碼，請立即設定新密碼才能繼續使用系統。</p>

        {errorMsg && (
          <div className="error-block" role="alert">
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="currentPassword">目前（臨時）密碼</label>
            <input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={loading}
              required
              autoComplete="current-password"
            />
            {fieldErrors.currentPassword && (
              <span className="field-error">{fieldErrors.currentPassword}</span>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="newPassword">新密碼</label>
            <input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={loading}
              required
              autoComplete="new-password"
            />
            {fieldErrors.newPassword && (
              <span className="field-error">{fieldErrors.newPassword}</span>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="confirmPassword">確認新密碼</label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={loading}
              required
              autoComplete="new-password"
            />
            {fieldErrors.confirmPassword && (
              <span className="field-error">{fieldErrors.confirmPassword}</span>
            )}
          </div>

          <button type="submit" disabled={loading} className="btn btn-primary">
            {loading ? "變更中…" : "確認變更密碼"}
          </button>
        </form>

        <div className="auth-alt-action">
          <p className="hint">忘記臨時密碼？請先登出，再請管理員重新設定一組臨時密碼。</p>
          <button
            type="button"
            onClick={handleLogout}
            disabled={loading}
            className="btn btn-secondary"
          >
            登出
          </button>
        </div>
      </div>
    </div>
  );
}
