import type React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.js";

/**
 * Wraps routes that require authentication.
 * - Loading: show spinner
 * - Unauthenticated: redirect to /login
 * - mustChangePassword: redirect to /change-password-forced (except on that page itself)
 */
export function RequireAuth({ children }: { children: React.ReactNode }): React.ReactElement {
  const { authState } = useAuth();
  const location = useLocation();

  if (authState.status === "loading") {
    return (
      <div className="page-container">
        <div className="loading-block" aria-busy="true">
          <span className="spinner" aria-label="載入中" />
          <p>載入中…</p>
        </div>
      </div>
    );
  }

  if (authState.status === "unauthenticated") {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Authenticated but must change password — block all routes except /change-password-forced
  if (authState.user.mustChangePassword && location.pathname !== "/change-password-forced") {
    return <Navigate to="/change-password-forced" replace />;
  }

  return <>{children}</>;
}

/**
 * Wraps the login page: if already authenticated (and not mustChangePassword), redirect to home.
 */
export function RedirectIfAuthenticated({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const { authState } = useAuth();

  if (authState.status === "loading") {
    return (
      <div className="page-container">
        <div className="loading-block" aria-busy="true">
          <span className="spinner" aria-label="載入中" />
          <p>載入中…</p>
        </div>
      </div>
    );
  }

  if (authState.status === "authenticated") {
    if (authState.user.mustChangePassword) {
      return <Navigate to="/change-password-forced" replace />;
    }
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
