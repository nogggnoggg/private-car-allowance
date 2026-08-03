import type React from "react";
import { Link } from "react-router-dom";
import ApplicationListSection from "../components/ApplicationListSection.js";
import MileageSummarySection from "../components/MileageSummarySection.js";
import { useAuth } from "../context/AuthContext.js";

export default function HomePage(): React.ReactElement {
  const { authState, logout } = useAuth();

  if (authState.status !== "authenticated") {
    return (
      <div className="page-container">
        <p>載入中…</p>
      </div>
    );
  }

  const { user } = authState;
  const roleLabel = user.role === "ADMIN" ? "管理員" : "一般使用者";

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>油資管理系統</h1>
        <div className="header-actions">
          <span className="user-info">
            {user.displayName}（{roleLabel}）
          </span>
          {user.role === "ADMIN" && (
            <Link to="/admin/users" className="btn btn-secondary">
              使用者管理
            </Link>
          )}
          {user.role === "ADMIN" && (
            <Link to="/admin/parameters" className="btn btn-secondary">
              補助參數維護
            </Link>
          )}
          <Link to="/change-password" className="btn btn-secondary">
            變更密碼
          </Link>
          <button type="button" onClick={() => logout()} className="btn btn-outline">
            登出
          </button>
        </div>
      </header>

      <main className="page-main">
        <MileageSummarySection />
        <h2>我的私車補助紀錄</h2>
        <ApplicationListSection />
      </main>
    </div>
  );
}
