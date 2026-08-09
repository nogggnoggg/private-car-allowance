import type React from "react";
import { Route, BrowserRouter as Router, Routes } from "react-router-dom";
import { RedirectIfAuthenticated, RequireAuth } from "./components/RouteGuard.js";
import { AuthProvider } from "./context/AuthContext.js";
import AdminFuelConsumptionPage from "./pages/AdminFuelConsumptionPage.js";
import AdminUserApplicationsPage from "./pages/AdminUserApplicationsPage.js";
import AdminUsersPage from "./pages/AdminUsersPage.js";
import AttachmentsDemoPage from "./pages/AttachmentsDemoPage.js";
import AuditLogPage from "./pages/AuditLogPage.js";
import ChangePasswordPage from "./pages/ChangePasswordPage.js";
import DepreciationApplicationPage from "./pages/DepreciationApplicationPage.js";
import ForceChangePasswordPage from "./pages/ForceChangePasswordPage.js";
import HomePage from "./pages/HomePage.js";
import LoginPage from "./pages/LoginPage.js";
import MaintenanceApplicationPage from "./pages/MaintenanceApplicationPage.js";
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

          {/* PHASE-004-T14: 管理員檢視指定使用者紀錄 + 代操作入口（§8.4 明定路由）。
              `:userId` 由 AdminUsersPage 的每列連結帶入，作為預選對象。 */}
          <Route
            path="/admin/users/:userId/applications"
            element={
              <RequireAuth>
                <AdminUserApplicationsPage />
              </RequireAuth>
            }
          />

          {/* PHASE-004-T14: 同一頁面元件的「未選使用者」進入點（Spec §8.4 未列舉，
              純屬額外 UI 入口，不變更任何既有路由/AC——見
              AdminUserApplicationsPage.tsx 檔頭註解的完整理由）。從
              AdminUsersPage 標頭的「使用者申請紀錄」連結進入，讓 Done When
              「未選使用者時代操作入口必須停用」有真實可到達的路由，而非只能
              以元件層級的 props 測試。 */}
          <Route
            path="/admin/applications"
            element={
              <RequireAuth>
                <AdminUserApplicationsPage />
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

          {/* PHASE-006-T11: 保養草稿建立／編輯／已完成檢視。單一 :id 路由
              涵蓋「/applications/maintenance/new」與
              「/applications/maintenance/:id」——理由同上方 TRAVEL 路由的
              既有註解（React Router 對靜態片段的比對優先於動態參數）。 */}
          <Route
            path="/applications/maintenance/:id"
            element={
              <RequireAuth>
                <MaintenanceApplicationPage />
              </RequireAuth>
            }
          />

          {/* PHASE-007-T13: 折舊草稿建立／編輯／已完成檢視。單一 :id 路由
              涵蓋「/applications/depreciation/new」與
              「/applications/depreciation/:id」——理由同上方 MAINTENANCE/
              TRAVEL 路由的既有註解（React Router 對靜態片段的比對優先於
              動態參數）。 */}
          <Route
            path="/applications/depreciation/:id"
            element={
              <RequireAuth>
                <DepreciationApplicationPage />
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

          {/* PHASE-005a-T10 (AC-30): 管理員油耗維護頁——沿用 PHASE-004-T14
              AdminUserApplicationsPage 之雙路由慣例，兩者掛載同一元件。
              `:userId` 由 AdminUsersPage 每列的「油耗維護」連結帶入預選。 */}
          <Route
            path="/admin/users/:userId/fuel-consumption"
            element={
              <RequireAuth>
                <AdminFuelConsumptionPage />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/fuel-consumption"
            element={
              <RequireAuth>
                <AdminFuelConsumptionPage />
              </RequireAuth>
            }
          />

          {/* PHASE-010-T7 (AC-15(a)／D10=(a)): 稽核檢視頁——`RequireAuth` 僅保護
              登入態，管理員 only 之判定在 `AuditLogPage` 內（沿
              `AdminUsersPage`／`ParametersPage` 既有慣例，路由層不做角色分流）。 */}
          <Route
            path="/admin/audit-logs"
            element={
              <RequireAuth>
                <AuditLogPage />
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
