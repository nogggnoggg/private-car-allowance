import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { AuthProvider } from "../src/context/AuthContext.js";
import ForceChangePasswordPage from "../src/pages/ForceChangePasswordPage.js";

// Helper: render ForceChangePasswordPage with a pre-authenticated user (mustChangePassword=true)
function renderForcePage() {
  // Mock /api/me → authenticated user with mustChangePassword=true
  (fetch as Mock).mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        user: {
          id: "u2",
          loginName: "user1",
          displayName: "使用者一",
          employeeNumber: null,
          role: "USER",
          isActive: true,
          mustChangePassword: true,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );

  return render(
    <MemoryRouter initialEntries={["/change-password-forced"]}>
      <AuthProvider>
        <Routes>
          <Route path="/change-password-forced" element={<ForceChangePasswordPage />} />
          <Route path="/" element={<div>首頁占位</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("ForceChangePasswordPage", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染強制改密表單（臨時密碼/新密碼/確認新密碼）", async () => {
    renderForcePage();

    await waitFor(() => {
      expect(screen.getByLabelText(/目前（臨時）密碼/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^新密碼$/)).toBeInTheDocument();
      expect(screen.getByLabelText(/確認新密碼/)).toBeInTheDocument();
    });
  });

  it("確認密碼不一致 → 前端擋（不呼叫 API）", async () => {
    renderForcePage();

    await waitFor(() => {
      expect(screen.getByLabelText(/目前（臨時）密碼/)).toBeInTheDocument();
    });

    // Clear any /api/me mocks already set and re-spy
    const fetchSpy = fetch as Mock;
    const callCountBefore = fetchSpy.mock.calls.length;

    fireEvent.change(screen.getByLabelText(/目前（臨時）密碼/), {
      target: { value: "TempPass123" },
    });
    fireEvent.change(screen.getByLabelText(/^新密碼$/), {
      target: { value: "NewPass1234" },
    });
    fireEvent.change(screen.getByLabelText(/確認新密碼/), {
      target: { value: "DifferentPass!" },
    });

    fireEvent.click(screen.getByRole("button", { name: /確認變更密碼/ }));

    await waitFor(() => {
      expect(screen.getByText(/兩次輸入的新密碼不一致/)).toBeInTheDocument();
    });

    // fetch should NOT have been called for the password change endpoint
    // (the /api/me call is already done; no new call should happen)
    expect(fetchSpy.mock.calls.length).toBe(callCountBefore);
  });

  it("新密碼長度不足 → 前端擋", async () => {
    renderForcePage();

    await waitFor(() => {
      expect(screen.getByLabelText(/目前（臨時）密碼/)).toBeInTheDocument();
    });

    const fetchSpy = fetch as Mock;
    const callCountBefore = fetchSpy.mock.calls.length;

    fireEvent.change(screen.getByLabelText(/目前（臨時）密碼/), {
      target: { value: "TempPass123" },
    });
    fireEvent.change(screen.getByLabelText(/^新密碼$/), {
      target: { value: "short" },
    });
    fireEvent.change(screen.getByLabelText(/確認新密碼/), {
      target: { value: "short" },
    });

    fireEvent.click(screen.getByRole("button", { name: /確認變更密碼/ }));

    await waitFor(() => {
      expect(screen.getByText(/密碼至少需 10 個字元/)).toBeInTheDocument();
    });

    expect(fetchSpy.mock.calls.length).toBe(callCountBefore);
  });

  it("後端 VALIDATION_ERROR fields 逐欄顯示", async () => {
    renderForcePage();

    await waitFor(() => {
      expect(screen.getByLabelText(/目前（臨時）密碼/)).toBeInTheDocument();
    });

    // mock /api/me/password → 400 VALIDATION_ERROR
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: "輸入資料有誤",
            fields: [{ field: "newPassword", reason: "密碼不可使用常見弱密碼" }],
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    );

    fireEvent.change(screen.getByLabelText(/目前（臨時）密碼/), {
      target: { value: "TempPass123" },
    });
    fireEvent.change(screen.getByLabelText(/^新密碼$/), {
      target: { value: "password123" },
    });
    fireEvent.change(screen.getByLabelText(/確認新密碼/), {
      target: { value: "password123" },
    });

    fireEvent.click(screen.getByRole("button", { name: /確認變更密碼/ }));

    await waitFor(() => {
      expect(screen.getByText(/密碼不可使用常見弱密碼/)).toBeInTheDocument();
    });
  });

  it("舊密碼錯誤（401）→ 顯示錯誤訊息", async () => {
    renderForcePage();

    await waitFor(() => {
      expect(screen.getByLabelText(/目前（臨時）密碼/)).toBeInTheDocument();
    });

    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: "UNAUTHORIZED", message: "目前密碼不正確" },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )
    );

    fireEvent.change(screen.getByLabelText(/目前（臨時）密碼/), {
      target: { value: "WrongTemp" },
    });
    fireEvent.change(screen.getByLabelText(/^新密碼$/), {
      target: { value: "NewSecurePass1" },
    });
    fireEvent.change(screen.getByLabelText(/確認新密碼/), {
      target: { value: "NewSecurePass1" },
    });

    fireEvent.click(screen.getByRole("button", { name: /確認變更密碼/ }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("目前密碼不正確");
    });
  });

  it("改密成功 → 重新取得 /api/me 後導向首頁", async () => {
    renderForcePage();

    await waitFor(() => {
      expect(screen.getByLabelText(/目前（臨時）密碼/)).toBeInTheDocument();
    });

    // /api/me/password → success
    (fetch as Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    // /api/me (refreshAuth after success) → user without mustChangePassword
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: {
            id: "u2",
            loginName: "user1",
            displayName: "使用者一",
            employeeNumber: null,
            role: "USER",
            isActive: true,
            mustChangePassword: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    fireEvent.change(screen.getByLabelText(/目前（臨時）密碼/), {
      target: { value: "TempPass123" },
    });
    fireEvent.change(screen.getByLabelText(/^新密碼$/), {
      target: { value: "NewSecurePass1" },
    });
    fireEvent.change(screen.getByLabelText(/確認新密碼/), {
      target: { value: "NewSecurePass1" },
    });

    fireEvent.click(screen.getByRole("button", { name: /確認變更密碼/ }));

    await waitFor(() => {
      expect(screen.getByText("首頁占位")).toBeInTheDocument();
    });
  });
});

describe("ForceChangePasswordPage — 登出出口（Gate 反饋 2026-08-01）", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderWithLoginRoute() {
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: {
            id: "u2",
            loginName: "user1",
            displayName: "使用者一",
            employeeNumber: null,
            role: "USER",
            isActive: true,
            mustChangePassword: true,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    return render(
      <MemoryRouter initialEntries={["/change-password-forced"]}>
        <AuthProvider>
          <Routes>
            <Route path="/change-password-forced" element={<ForceChangePasswordPage />} />
            <Route path="/login" element={<div>登入頁占位</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );
  }

  it("頁面提供「登出」出口（忘記臨時密碼時的離開路徑）", async () => {
    renderWithLoginRoute();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /登出/ })).toBeInTheDocument();
    });
  });

  it("點擊登出 → 呼叫 logout API 並導向登入頁", async () => {
    renderWithLoginRoute();
    const btn = await waitFor(() => screen.getByRole("button", { name: /登出/ }));

    // Mock POST /api/auth/logout
    (fetch as Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByText("登入頁占位")).toBeInTheDocument();
    });
    const logoutCall = (fetch as Mock).mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/api/auth/logout")
    );
    expect(logoutCall).toBeTruthy();
  });
});
