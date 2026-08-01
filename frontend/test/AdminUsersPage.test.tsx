import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { AuthProvider } from "../src/context/AuthContext.js";
import AdminUsersPage from "../src/pages/AdminUsersPage.js";
import type { UserDto } from "../src/types/api.js";

const adminUser: UserDto = {
  id: "admin-id",
  loginName: "admin",
  displayName: "管理員",
  employeeNumber: "EMP000",
  role: "ADMIN",
  isActive: true,
  mustChangePassword: false,
};

const regularUser: UserDto = {
  id: "user-id-1",
  loginName: "user1",
  displayName: "使用者一",
  employeeNumber: null, // 員工編號為空
  role: "USER",
  isActive: true,
  mustChangePassword: false,
};

const inactiveUser: UserDto = {
  id: "user-id-2",
  loginName: "user2",
  displayName: "使用者二",
  employeeNumber: "EMP002",
  role: "USER",
  isActive: false,
  mustChangePassword: false,
};

function mockMeAsAdmin() {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ user: adminUser }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockMeAsUser() {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        user: { ...regularUser },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );
}

function mockGetUsers(users: UserDto[]) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ users }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function renderAdminPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/users"]}>
      <AuthProvider>
        <Routes>
          <Route path="/admin/users" element={<AdminUsersPage />} />
          <Route path="/" element={<div>首頁占位</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("AdminUsersPage", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Loading 態 ----
  it("Loading 態：顯示載入指示", async () => {
    // /api/me → admin (slow)
    (fetch as Mock).mockImplementation(() => new Promise(() => {}));

    renderAdminPage();

    await waitFor(() => {
      expect(screen.getByText(/載入中/)).toBeInTheDocument();
    });
  });

  // ---- Permission denied 態（一般使用者）----
  it("一般使用者直達 /admin/users → 顯示「存取被拒」", async () => {
    mockMeAsUser();
    // No need to mock /api/admin/users since we check role before fetching

    renderAdminPage();

    await waitFor(() => {
      expect(screen.getByText(/存取被拒/)).toBeInTheDocument();
    });
  });

  // ---- Error 態 ----
  it("Error 態：載入失敗時顯示錯誤與重試按鈕", async () => {
    mockMeAsAdmin();

    // /api/admin/users → server error
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: "INTERNAL_SERVER_ERROR", message: "伺服器錯誤" } }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    );

    renderAdminPage();

    await waitFor(() => {
      expect(screen.getByText(/伺服器錯誤/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /重試/ })).toBeInTheDocument();
    });
  });

  // ---- Empty 態 ----
  it("Empty 態：無使用者時顯示空狀態", async () => {
    mockMeAsAdmin();
    mockGetUsers([]);

    renderAdminPage();

    await waitFor(() => {
      expect(screen.getByText(/目前尚無使用者/)).toBeInTheDocument();
    });
  });

  // ---- 清單渲染 ----
  it("清單渲染：顯示帳號/姓名/員工編號（空顯「—」）/狀態", async () => {
    mockMeAsAdmin();
    mockGetUsers([regularUser, inactiveUser]);

    renderAdminPage();

    await waitFor(() => {
      // loginName
      expect(screen.getAllByText("user1").length).toBeGreaterThanOrEqual(1);
      // displayName (appears in table td and in card strong)
      expect(screen.getAllByText("使用者一").length).toBeGreaterThanOrEqual(1);
      // 員工編號空 → 顯示「—」(em dash)
      expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("user2").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("使用者二").length).toBeGreaterThanOrEqual(1);
      // 停用狀態標示
      expect(screen.getAllByText("停用").length).toBeGreaterThanOrEqual(1);
      // 啟用狀態標示
      expect(screen.getAllByText("啟用").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("停用使用者顯示「停用」狀態徽章", async () => {
    mockMeAsAdmin();
    mockGetUsers([inactiveUser]);

    renderAdminPage();

    await waitFor(() => {
      // The status badge should show "停用"
      const badges = screen.getAllByText("停用");
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---- 新增成功 ----
  it("新增使用者成功 → 顯示「已建立」提示並刷新清單", async () => {
    mockMeAsAdmin();
    mockGetUsers([regularUser]);

    renderAdminPage();

    await waitFor(() => {
      expect(screen.getByText("user1")).toBeInTheDocument();
    });

    // Open add dialog
    fireEvent.click(screen.getByRole("button", { name: /新增使用者/ }));

    await waitFor(() => {
      expect(screen.getByLabelText(/登入帳號 \*/)).toBeInTheDocument();
    });

    // Fill form
    fireEvent.change(screen.getByLabelText(/登入帳號 \*/), { target: { value: "newuser" } });
    fireEvent.change(screen.getByLabelText(/顯示姓名 \*/), { target: { value: "新使用者" } });
    fireEvent.change(screen.getByLabelText(/臨時密碼 \*/), {
      target: { value: "TempPass1234" },
    });

    // Mock POST /api/admin/users → success
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: {
            id: "new-id",
            loginName: "newuser",
            displayName: "新使用者",
            employeeNumber: null,
            role: "USER",
            isActive: true,
            mustChangePassword: true,
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      )
    );

    // Mock GET /api/admin/users (refresh after add)
    mockGetUsers([
      regularUser,
      {
        id: "new-id",
        loginName: "newuser",
        displayName: "新使用者",
        employeeNumber: null,
        role: "USER",
        isActive: true,
        mustChangePassword: true,
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /^新增$/ }));

    await waitFor(() => {
      expect(screen.getByText(/已建立，使用者首次登入須改密/)).toBeInTheDocument();
    });
  });

  // ---- 新增 409 CONFLICT ----
  it("新增使用者：帳號重複（409）→ 顯示「帳號已被使用」", async () => {
    mockMeAsAdmin();
    mockGetUsers([regularUser]);

    renderAdminPage();

    await waitFor(() => {
      expect(screen.getByText("user1")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /新增使用者/ }));

    await waitFor(() => {
      expect(screen.getByLabelText(/登入帳號 \*/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/登入帳號 \*/), { target: { value: "user1" } });
    fireEvent.change(screen.getByLabelText(/顯示姓名 \*/), { target: { value: "重複使用者" } });
    fireEvent.change(screen.getByLabelText(/臨時密碼 \*/), {
      target: { value: "TempPass1234" },
    });

    // Mock POST → 409 CONFLICT
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: "CONFLICT", message: "此登入帳號已被使用。" },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      )
    );

    fireEvent.click(screen.getByRole("button", { name: /^新增$/ }));

    await waitFor(() => {
      expect(screen.getByText(/帳號已被使用/)).toBeInTheDocument();
    });
  });

  // ---- 刪除 409 CONFLICT ----
  it("刪除使用者：有歷史（409）→ 顯示「請改用停用」提示", async () => {
    mockMeAsAdmin();
    mockGetUsers([regularUser]);

    renderAdminPage();

    await waitFor(() => {
      expect(screen.getByText("user1")).toBeInTheDocument();
    });

    // Click delete button for user1
    const [firstDeleteBtn] = screen.getAllByRole("button", { name: /^刪除$/ });
    if (firstDeleteBtn) fireEvent.click(firstDeleteBtn);

    await waitFor(() => {
      expect(screen.getByText(/確認刪除使用者/)).toBeInTheDocument();
    });

    // Mock DELETE → 409 CONFLICT (has history)
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: "CONFLICT", message: "此帳號已有資料，無法刪除，請改用停用。" },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      )
    );

    fireEvent.click(screen.getByRole("button", { name: /確認刪除/ }));

    await waitFor(() => {
      expect(screen.getByText(/此帳號已有資料，無法刪除，請改用停用/)).toBeInTheDocument();
    });
  });

  // ---- 停用二次確認 ----
  it("停用使用者：顯示二次確認警告文字", async () => {
    mockMeAsAdmin();
    mockGetUsers([regularUser]);

    renderAdminPage();

    await waitFor(() => {
      expect(screen.getByText("user1")).toBeInTheDocument();
    });

    const [firstDeactivateBtn] = screen.getAllByRole("button", { name: /^停用$/ });
    if (firstDeactivateBtn) fireEvent.click(firstDeactivateBtn);

    await waitFor(() => {
      expect(screen.getByText(/使用者將無法登入，且既有登入將立即失效/)).toBeInTheDocument();
    });
  });

  // ---- 停用成功 ----
  it("停用使用者成功 → 顯示成功提示", async () => {
    mockMeAsAdmin();
    mockGetUsers([regularUser]);

    renderAdminPage();

    await waitFor(() => {
      expect(screen.getByText("user1")).toBeInTheDocument();
    });

    const [firstStopBtn] = screen.getAllByRole("button", { name: /^停用$/ });
    if (firstStopBtn) fireEvent.click(firstStopBtn);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /確認停用/ })).toBeInTheDocument();
    });

    // Mock POST /deactivate
    (fetch as Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ user: { ...regularUser, isActive: false } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    // Refresh users list after deactivate
    mockGetUsers([{ ...regularUser, isActive: false }]);

    fireEvent.click(screen.getByRole("button", { name: /確認停用/ }));

    await waitFor(() => {
      expect(screen.getByText(/使用者已停用/)).toBeInTheDocument();
    });
  });
});
