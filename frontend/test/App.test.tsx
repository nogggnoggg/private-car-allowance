/**
 * App 整合路由測試：驗證路由守衛在各 auth 狀態下的行為。
 * 原 /api/health 顯示測試已由 api/health.ts 本身的邏輯覆蓋；
 * App.tsx 在 PHASE-002 改為路由骨架。
 */
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import App from "../src/App.js";

describe("App — 路由守衛", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("未登入（/api/me → 401）→ 顯示登入頁", async () => {
    (fetch as Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "未登入" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^登入$/ })).toBeInTheDocument();
    });
  });

  it("已登入（/api/me → 200，mustChangePassword=false）→ 顯示首頁", async () => {
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

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/我的私車補助紀錄/)).toBeInTheDocument();
    });
  });

  it("已登入但 mustChangePassword=true → 顯示強制改密頁", async () => {
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

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/首次登入請變更密碼/)).toBeInTheDocument();
    });
  });
});
