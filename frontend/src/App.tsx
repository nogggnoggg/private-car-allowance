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
import ParametersPage from "./pages/ParametersPage.js";
import TravelApplicationPage from "./pages/TravelApplicationPage.js";

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

          {/* PHASE-004-T13: 差旅草稿建立／編輯／已完成檢視。
              單一路由涵蓋 §8.4 的兩條路由項——「/applications/travel/new」與
              「/applications/travel/:id」——因為 React Router 對靜態片段的比對
              優先於動態參數，若額外註冊一條無 :id 的靜態
              "/applications/travel/new" route，該路由底下 useParams().id 會是
              undefined 而非 "new"，導致 TravelApplicationPage 判斷不到「建立
              草稿」分支。保留單一 :id 路由，讓 "new" 本身成為 id 參數值。 */}
          <Route
            path="/applications/travel/:id"
            element={
              <RequireAuth>
                <TravelApplicationPage />
              </RequireAuth>
            }
          />

          {/* PHASE-003a: parameter maintenance page — admin only */}
          <Route
            path="/admin/parameters"
            element={
              <RequireAuth>
                <ParametersPage />
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
