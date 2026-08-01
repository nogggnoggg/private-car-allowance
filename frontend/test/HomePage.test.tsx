/**
 * HomePage 前端單元測試 — PHASE-003a-T7
 *
 * 測試策略：
 *   - 管理員登入 → 首頁可見「補助參數維護」連結，且 href 指向 /admin/parameters
 *   - 一般使用者（role=USER）登入 → 首頁不顯示「補助參數維護」連結
 *   - 既有連結（使用者管理、變更密碼、登出）不受影響
 *
 * 沿用 AdminUsersPage.test.tsx 風格（MemoryRouter + AuthProvider + mock fetch）。
 */

import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { AuthProvider } from "../src/context/AuthContext.js";
import HomePage from "../src/pages/HomePage.js";
import type { UserDto } from "../src/types/api.js";

// ---- Fixture users ----

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
  employeeNumber: null,
  role: "USER",
  isActive: true,
  mustChangePassword: false,
};

// ---- Mock helpers ----

function mockMeAs(user: UserDto) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ user }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function renderHomePage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/admin/users" element={<div>使用者管理頁占位</div>} />
          <Route path="/admin/parameters" element={<div>補助參數維護頁占位</div>} />
          <Route path="/change-password" element={<div>變更密碼頁占位</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

// ============================================================
// 管理員首頁：補助參數維護連結
// ============================================================

describe("HomePage — 補助參數維護導覽連結", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("管理員登入 → 首頁顯示「補助參數維護」連結，指向 /admin/parameters", async () => {
    mockMeAs(adminUser);

    renderHomePage();

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /補助參數維護/ });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "/admin/parameters");
    });
  });

  it("一般使用者（role=USER）登入 → 首頁不顯示「補助參數維護」連結", async () => {
    mockMeAs(regularUser);

    renderHomePage();

    await waitFor(() => {
      // Verify page has rendered (user info visible)
      expect(screen.getByText(/使用者一/)).toBeInTheDocument();
    });

    // The link must NOT be present for regular users
    expect(screen.queryByRole("link", { name: /補助參數維護/ })).not.toBeInTheDocument();
  });

  it("管理員登入 → 首頁仍顯示既有「使用者管理」連結", async () => {
    mockMeAs(adminUser);

    renderHomePage();

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /使用者管理/ });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "/admin/users");
    });
  });

  it("管理員登入 → 首頁仍顯示「變更密碼」連結", async () => {
    mockMeAs(adminUser);

    renderHomePage();

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /變更密碼/ });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "/change-password");
    });
  });

  it("管理員登入 → 首頁仍顯示「登出」按鈕", async () => {
    mockMeAs(adminUser);

    renderHomePage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /登出/ })).toBeInTheDocument();
    });
  });
});
