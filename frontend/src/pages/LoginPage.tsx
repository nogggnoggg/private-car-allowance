import type React from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiLogin } from "../api/auth.js";
import { useAuth } from "../context/AuthContext.js";
import type { ApiError } from "../types/api.js";

export default function LoginPage(): React.ReactElement {
  const { setUser } = useAuth();
  const navigate = useNavigate();

  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErrorMsg(null);

    try {
      const result = await apiLogin({ loginName, password });
      setUser(result.user);
      if (result.redirect === "change-password-forced") {
        navigate("/change-password-forced", { replace: true });
      } else {
        navigate("/", { replace: true });
      }
    } catch (err) {
      const apiErr = err as ApiError;
      setErrorMsg(apiErr.message ?? "登入失敗，請稍後再試。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>油資管理系統</h1>
        <h2>登入</h2>

        {errorMsg && (
          <div className="error-block" role="alert">
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="loginName">登入帳號</label>
            <input
              id="loginName"
              type="text"
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              disabled={loading}
              required
              autoComplete="username"
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">密碼</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              required
              autoComplete="current-password"
            />
          </div>

          <button type="submit" disabled={loading} className="btn btn-primary">
            {loading ? "登入中…" : "登入"}
          </button>
        </form>
      </div>
    </div>
  );
}
