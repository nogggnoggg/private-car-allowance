/**
 * AdminUserApplicationsPage — PHASE-004-T14
 *
 * 管理員檢視指定使用者的申請紀錄 + 代操作（代建立差旅草稿）入口
 * （AD-US-06/07, AC-84/78/79/85, Spec §3.2/§4/§8.4）.
 *
 * 路由（App.tsx）：
 *   - `/admin/users/:userId/applications`（Spec §8.4 明定）— 從
 *     `AdminUsersPage` 點選某使用者的「申請紀錄」連結進入，`:userId` 直接
 *     預選該使用者。
 *   - `/admin/applications`（本 Task 新增，Spec 路由表未列舉，但未變更任何
 *     既有路由／AC／contract，純屬額外的 UI 進入點）— 一般化入口（例如從
 *     `AdminUsersPage` 標頭的「使用者申請紀錄」連結），載入時**未選定任何
 *     使用者**，管理員需從下方選單挑選。這是 Packet Done When「未選使用者
 *     時代操作入口必須停用」得以被真實路由到達（而非只能靠直接建構元件
 *     props 測試）的唯一方式——Spec §8.4 表列的路由恆含 `:userId`，本身不
 *     會處於「未選」態。兩條路由掛載同一元件（見 App.tsx 註解）。
 *
 * 五態：
 *   - Loading：等待 `/api/me` 解析，或（一旦確認為 ADMIN）等待
 *     `GET /admin/users`（選單所需的使用者清單，C3：重用既有端點，不新增
 *     後端 API）。
 *   - Permission denied：一般使用者（`role !== "ADMIN"`）到達本頁 —
 *     **在呼叫任何管理端點之前**就短路（比照 `AdminUsersPage.tsx` 既有寫
 *     法），不呈現他人任何資料；即使這層前端判斷被繞過，`GET /admin/users`
 *     本身的後端 `requireAdmin` 仍會回 403、一樣落到這個狀態（defense in
 *     depth）——C1：前端判斷從不是唯一的授權層。
 *   - Error：`GET /admin/users` 失敗（載入使用者選單失敗）。
 *   - Empty / Success：委派給 `ApplicationListSection`（`ownerId` 指向所選
 *     使用者）——它自己的 ready/empty/error/permission-denied 分支已在
 *     T13 涵蓋；本頁透過 `showCreateLink={false}` 隱藏其「新增差旅補助」
 *     （那個連結會建立 owner=呼叫者的草稿，在這個情境下語意是錯的，見
 *     `ApplicationListSection.tsx` 該 prop 的文件註解）並改用
 *     `emptyMessage` 覆寫為 Spec §4 指定的「該使用者尚無申請紀錄」文案。
 *
 * 統計區塊（PHASE-005-T8，AC-31/32）：已選使用者時，於清單上方嵌入
 * `MileageSummarySection`，並顯式傳入 `ownerId={selectedUserId}`（`:userId`，
 * 非管理員自己；T7 已於元件內把 `ownerId` 逐字帶入
 * `apiGetMileageSummary` 的查詢字串，本頁不重複實作查詢邏輯）＋
 * `title` 覆寫為「統計對象：<displayName>」，以與 HomePage 的「查詢自己」
 * 語意區隔。未選使用者時不渲染（沒有 `:userId` 可查）。
 *
 * 代操作入口（「代建立差旅草稿」按鈕）：
 *   - 未選使用者 → `disabled`（`aria-describedby` 指向提示文字，C4）。
 *   - 已選使用者 → 啟用；送出中防重複提交（`creating` guard）。
 *   - 成功 → `navigate` 到 `/applications/travel/:id`（T13 已建立的草稿編輯
 *     頁，AC-78：`ownerId=:userId`、`createdById=`本管理員）。
 *   - 失敗（使用者已停用/不存在等）→ 就地顯示後端錯誤訊息（C4：不顯示原始
 *     stack trace，只顯示 `ApiError.message`）。
 *
 * C1（硬性約束）：本頁對「一般使用者」的攔截純粹是 UX（不呈現無效入口／
 * 不顯示他人資料），**不是**授權依據——`POST /admin/users/:userId/applications/travel`
 * 與 `GET /applications?ownerId=` 兩者的實際授權判定完全在後端
 * （`requireAdmin`／`resolveOwnerId`，T9/T10 既有測試）。
 */

import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiCreateTravelDraftOnBehalf } from "../api/applications.js";
import { apiGetUsers } from "../api/users.js";
import ApplicationListSection from "../components/ApplicationListSection.js";
import MileageSummarySection from "../components/MileageSummarySection.js";
import { useAuth } from "../context/AuthContext.js";
import type { ApiError, UserDto } from "../types/api.js";

type PageState =
  | { kind: "loading" }
  | { kind: "permission-denied" }
  | { kind: "error"; message: string }
  | { kind: "ready"; users: UserDto[] };

export default function AdminUserApplicationsPage(): React.ReactElement {
  const { authState } = useAuth();
  const { userId: routeUserId } = useParams<{ userId?: string }>();
  const navigate = useNavigate();

  const [pageState, setPageState] = useState<PageState>({ kind: "loading" });
  const [selectedUserId, setSelectedUserId] = useState<string>(routeUserId ?? "");

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setPageState({ kind: "loading" });
    try {
      const { users } = await apiGetUsers();
      setPageState({ kind: "ready", users });
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "FORBIDDEN" || apiErr.code === "UNAUTHORIZED") {
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

  // 路由層預選（從 AdminUsersPage 帶 :userId 進入）——若之後改變路由（不同
  // 使用者的連結），同步更新（避免元件被 React Router 重用而未重新掛載）。
  useEffect(() => {
    if (routeUserId) {
      setSelectedUserId(routeUserId);
    }
  }, [routeUserId]);

  function handleSelectUser(id: string) {
    setSelectedUserId(id);
    setCreateError(null);
  }

  async function handleCreateOnBehalf() {
    if (!selectedUserId || creating) return; // C4：未選定/送出中不得觸發（防重複提交、防未選送出）
    setCreating(true);
    setCreateError(null);
    try {
      const { application } = await apiCreateTravelDraftOnBehalf(selectedUserId, {});
      navigate(`/applications/travel/${application.id}`);
    } catch (err) {
      const apiErr = err as ApiError;
      setCreateError(apiErr.message ?? "代建立草稿失敗，請稍後再試。");
    } finally {
      setCreating(false);
    }
  }

  // ---- Loading ----
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

  // ---- Permission denied ----
  if (pageState.kind === "permission-denied") {
    return (
      <div className="page-container">
        <div className="permission-denied-block" role="alert">
          <h2>存取被拒</h2>
          <p>您沒有權限存取此頁面。</p>
          <Link to="/" className="btn btn-secondary">
            返回首頁
          </Link>
        </div>
      </div>
    );
  }

  // ---- Error ----
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

  // ---- Ready ----
  const { users } = pageState;
  const selectedUser = users.find((u) => u.id === selectedUserId) ?? null;

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>使用者申請紀錄{selectedUser ? `：${selectedUser.displayName}` : ""}</h1>
        <div className="header-actions">
          <Link to="/admin/users" className="btn btn-secondary">
            返回使用者管理
          </Link>
        </div>
      </header>

      <main className="page-main">
        <div className="form-group">
          <label htmlFor="admin-user-select">選擇使用者</label>
          <select
            id="admin-user-select"
            value={selectedUserId}
            onChange={(e) => handleSelectUser(e.target.value)}
          >
            <option value="">請選擇使用者</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}（{u.loginName}）{u.isActive ? "" : "・已停用"}
              </option>
            ))}
          </select>
        </div>

        <div className="list-toolbar">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleCreateOnBehalf}
            disabled={!selectedUserId || creating}
            aria-describedby={selectedUserId ? undefined : "on-behalf-create-hint"}
          >
            {creating ? "建立中…" : "代建立差旅草稿"}
          </button>
          {!selectedUserId && (
            <span id="on-behalf-create-hint" className="hint">
              請先選擇使用者
            </span>
          )}
        </div>

        {createError && (
          <div className="error-block" role="alert">
            {createError}
          </div>
        )}

        {selectedUserId ? (
          <>
            <MileageSummarySection
              key={selectedUserId}
              ownerId={selectedUserId}
              title={`統計對象：${selectedUser ? selectedUser.displayName : ""}`}
            />
            <ApplicationListSection
              ownerId={selectedUserId}
              showCreateLink={false}
              emptyMessage="該使用者尚無申請紀錄。"
            />
          </>
        ) : (
          <div className="empty-block">
            <p>請先於上方選擇使用者，以檢視其申請紀錄。</p>
          </div>
        )}
      </main>
    </div>
  );
}
