import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { AuthProvider } from "../src/context/AuthContext.js";
import ChangePasswordPage from "../src/pages/ChangePasswordPage.js";

function renderChangePage() {
  // /api/me → authenticated user
  (fetch as Mock).mockResolvedValueOnce(
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
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );

  return render(
    <MemoryRouter initialEntries={["/change-password"]}>
      <AuthProvider>
        <Routes>
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route path="/" element={<div>首頁占位</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("ChangePasswordPage（自行改密）", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染改密表單", async () => {
    renderChangePage();

    await waitFor(() => {
      expect(screen.getByLabelText(/目前密碼/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^新密碼$/)).toBeInTheDocument();
      expect(screen.getByLabelText(/確認新密碼/)).toBeInTheDocument();
    });
  });

  it("確認密碼不一致 → 前端擋，不呼叫 API", async () => {
    renderChangePage();

    await waitFor(() => {
      expect(screen.getByLabelText(/目前密碼/)).toBeInTheDocument();
    });

    const fetchSpy = fetch as Mock;
    const callCountBefore = fetchSpy.mock.calls.length;

    fireEvent.change(screen.getByLabelText(/目前密碼/), { target: { value: "OldPass1234" } });
    fireEvent.change(screen.getByLabelText(/^新密碼$/), { target: { value: "NewPass1234" } });
    fireEvent.change(screen.getByLabelText(/確認新密碼/), { target: { value: "Mismatch999" } });

    fireEvent.click(screen.getByRole("button", { name: /確認變更密碼/ }));

    await waitFor(() => {
      expect(screen.getByText(/兩次輸入的新密碼不一致/)).toBeInTheDocument();
    });

    expect(fetchSpy.mock.calls.length).toBe(callCountBefore);
  });

  it("新密碼過短 → 前端擋", async () => {
    renderChangePage();

    await waitFor(() => {
      expect(screen.getByLabelText(/目前密碼/)).toBeInTheDocument();
    });

    const fetchSpy = fetch as Mock;
    const callCountBefore = fetchSpy.mock.calls.length;

    fireEvent.change(screen.getByLabelText(/目前密碼/), { target: { value: "OldPass1234" } });
    fireEvent.change(screen.getByLabelText(/^新密碼$/), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText(/確認新密碼/), { target: { value: "short" } });

    fireEvent.click(screen.getByRole("button", { name: /確認變更密碼/ }));

    await waitFor(() => {
      expect(screen.getByText(/密碼至少需 10 個字元/)).toBeInTheDocument();
    });

    expect(fetchSpy.mock.calls.length).toBe(callCountBefore);
  });

  it("後端 fields 錯誤逐欄顯示（newPassword）", async () => {
    renderChangePage();

    await waitFor(() => {
      expect(screen.getByLabelText(/目前密碼/)).toBeInTheDocument();
    });

    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: "輸入資料有誤",
            fields: [{ field: "newPassword", reason: "請使用與目前不同的密碼" }],
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    );

    fireEvent.change(screen.getByLabelText(/目前密碼/), { target: { value: "SamePass1234" } });
    fireEvent.change(screen.getByLabelText(/^新密碼$/), { target: { value: "SamePass1234" } });
    fireEvent.change(screen.getByLabelText(/確認新密碼/), { target: { value: "SamePass1234" } });

    fireEvent.click(screen.getByRole("button", { name: /確認變更密碼/ }));

    await waitFor(() => {
      expect(screen.getByText(/請使用與目前不同的密碼/)).toBeInTheDocument();
    });
  });

  it("改密成功 → 顯示成功提示與返回首頁連結", async () => {
    renderChangePage();

    await waitFor(() => {
      expect(screen.getByLabelText(/目前密碼/)).toBeInTheDocument();
    });

    (fetch as Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    fireEvent.change(screen.getByLabelText(/目前密碼/), { target: { value: "OldPass1234" } });
    fireEvent.change(screen.getByLabelText(/^新密碼$/), { target: { value: "NewPass12345" } });
    fireEvent.change(screen.getByLabelText(/確認新密碼/), {
      target: { value: "NewPass12345" },
    });

    fireEvent.click(screen.getByRole("button", { name: /確認變更密碼/ }));

    await waitFor(() => {
      expect(screen.getByText(/密碼已成功變更/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /返回首頁/ })).toBeInTheDocument();
    });
  });
});
