import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { AuthProvider } from "../src/context/AuthContext.js";
import LoginPage from "../src/pages/LoginPage.js";

// Helper to render LoginPage with router + AuthProvider
function renderLoginPage() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>首頁</div>} />
          <Route path="/change-password-forced" element={<div>強制改密頁</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染登入表單（帳號/密碼/送出鈕）", () => {
    // Mock /api/me → 401 so AuthProvider treats as unauthenticated
    (fetch as Mock).mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "未登入" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    renderLoginPage();
    expect(screen.getByLabelText(/登入帳號/)).toBeInTheDocument();
    expect(screen.getByLabelText(/密碼/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /登入/ })).toBeInTheDocument();
  });

  it("登入中：按鈕 disabled + 顯示「登入中…」", async () => {
    // /api/me → 401
    (fetch as Mock)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "未登入" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      )
      // /api/auth/login → hangs (never resolves quickly)
      .mockImplementationOnce(() => new Promise(() => {}));

    renderLoginPage();

    // Fill and submit
    fireEvent.change(screen.getByLabelText(/登入帳號/), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText(/密碼/), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: /^登入$/ }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /登入中/ })).toBeDisabled();
    });
  });

  it("登入失敗：顯示後端 message（統一訊息）", async () => {
    const unifiedMessage = "帳號或密碼錯誤，或此帳號目前無法登入";
    // /api/me → 401
    (fetch as Mock)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "未登入" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      )
      // /api/auth/login → 401 unified error
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: unifiedMessage } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      );

    renderLoginPage();

    fireEvent.change(screen.getByLabelText(/登入帳號/), { target: { value: "nobody" } });
    fireEvent.change(screen.getByLabelText(/密碼/), { target: { value: "wrongpass" } });
    fireEvent.click(screen.getByRole("button", { name: /^登入$/ }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(unifiedMessage);
    });
  });

  it("登入成功（redirect=home）→ 導向首頁", async () => {
    // /api/me → 401 (unauthenticated initially)
    (fetch as Mock)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "未登入" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      )
      // /api/auth/login → success
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: {
              id: "u1",
              loginName: "admin",
              displayName: "管理員",
              employeeNumber: null,
              role: "ADMIN",
              isActive: true,
              mustChangePassword: false,
            },
            redirect: "home",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    renderLoginPage();

    fireEvent.change(screen.getByLabelText(/登入帳號/), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText(/密碼/), { target: { value: "Admin@12345" } });
    fireEvent.click(screen.getByRole("button", { name: /^登入$/ }));

    await waitFor(() => {
      expect(screen.getByText("首頁")).toBeInTheDocument();
    });
  });

  it("登入成功（redirect=change-password-forced）→ 導向強制改密頁", async () => {
    // /api/me → 401
    (fetch as Mock)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "未登入" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      )
      // /api/auth/login → success with mustChangePassword
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: {
              id: "u2",
              loginName: "user1",
              displayName: "使用者一",
              employeeNumber: "EMP001",
              role: "USER",
              isActive: true,
              mustChangePassword: true,
            },
            redirect: "change-password-forced",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    renderLoginPage();

    fireEvent.change(screen.getByLabelText(/登入帳號/), { target: { value: "user1" } });
    fireEvent.change(screen.getByLabelText(/密碼/), { target: { value: "TempPass123" } });
    fireEvent.click(screen.getByRole("button", { name: /^登入$/ }));

    await waitFor(() => {
      expect(screen.getByText("強制改密頁")).toBeInTheDocument();
    });
  });
});
