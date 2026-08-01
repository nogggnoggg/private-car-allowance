import type React from "react";
import { Route, BrowserRouter as Router, Routes } from "react-router-dom";
import { RedirectIfAuthenticated, RequireAuth } from "./components/RouteGuard.js";
import { AuthProvider } from "./context/AuthContext.js";
import AdminUsersPage from "./pages/AdminUsersPage.js";
import AttachmentsDemoPage from "./pages/AttachmentsDemoPage.js";
import ChangePasswordPage from "./pages/ChangePasswordPage.js";
import ForceChangePasswordPage from "./pages/ForceChangePasswordPage.js";
import HomePage from "./pages/HomePage.js";
import LoginPage from "./pages/LoginPage.js";

export default function App(): React.ReactElement {
  return (
    <Router>
      <AuthProvider>
        <Routes>
          {/* Public: redirect to home if already logged in */}
          <Route
            path="/login"
            element={
              <RedirectIfAuthenticated>
                <LoginPage />
              </RedirectIfAuthenticated>
            }
          />

          {/* Force change password — requires auth but not blocked by mustChangePassword */}
          <Route
            path="/change-password-forced"
            element={
              <RequireAuth>
                <ForceChangePasswordPage />
              </RequireAuth>
            }
          />

          {/* Protected routes */}
          <Route
            path="/"
            element={
              <RequireAuth>
                <HomePage />
              </RequireAuth>
            }
          />

          <Route
            path="/change-password"
            element={
              <RequireAuth>
                <ChangePasswordPage />
              </RequireAuth>
            }
          />

          <Route
            path="/admin/users"
            element={
              <RequireAuth>
                <AdminUsersPage />
              </RequireAuth>
            }
          />

          {/* PHASE-003 Gate: attachment integration verification page */}
          <Route
            path="/attachments-demo"
            element={
              <RequireAuth>
                <AttachmentsDemoPage />
              </RequireAuth>
            }
          />

          {/* Fallback: redirect to home */}
          <Route
            path="*"
            element={
              <RequireAuth>
                <HomePage />
              </RequireAuth>
            }
          />
        </Routes>
      </AuthProvider>
    </Router>
  );
}
