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

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// PHASE-004-T13: HomePage now also renders <ApplicationListSection />, which
// fires a GET /api/applications on mount. These existing (PHASE-003a-T7)
// tests only assert on header/nav elements, but without this second mock the
// component would fall through to a real (failing) fetch call for the list —
// this queues a deterministic empty-list response so those unrelated
// assertions keep passing. Not a modification of any existing assertion.
// PHASE-005a-T11: HomePage now also renders <MyFuelConsumptionSection />,
// which fires a GET /api/me/fuel-consumption on mount (before
// <ApplicationListSection />'s GET /api/applications, per JSX/mount order).
// Mirrors the `mockEmptyApplicationsList` precedent above (PHASE-004-T13) —
// a queued mock for a newly-embedded component's own fetch, not a
// modification of any existing assertion's intent.
function mockMyFuelConsumptionEmpty() {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ current: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockEmptyApplicationsList() {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
        appliedFilters: {
          dateFrom: "2025-01-01",
          dateTo: null,
          type: null,
          status: null,
          keyword: null,
          ownerId: "self",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
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
    mockMyFuelConsumptionEmpty();
    mockEmptyApplicationsList();

    renderHomePage();

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /補助參數維護/ });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "/admin/parameters");
    });
  });

  it("一般使用者（role=USER）登入 → 首頁不顯示「補助參數維護」連結", async () => {
    mockMeAs(regularUser);
    mockMyFuelConsumptionEmpty();
    mockEmptyApplicationsList();

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
    mockMyFuelConsumptionEmpty();
    mockEmptyApplicationsList();

    renderHomePage();

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /使用者管理/ });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "/admin/users");
    });
  });

  it("管理員登入 → 首頁仍顯示「變更密碼」連結", async () => {
    mockMeAs(adminUser);
    mockMyFuelConsumptionEmpty();
    mockEmptyApplicationsList();

    renderHomePage();

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /變更密碼/ });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "/change-password");
    });
  });

  it("管理員登入 → 首頁仍顯示「登出」按鈕", async () => {
    mockMeAs(adminUser);
    mockMyFuelConsumptionEmpty();
    mockEmptyApplicationsList();

    renderHomePage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /登出/ })).toBeInTheDocument();
    });
  });
});

// ============================================================
// PHASE-010-T7（AC-15(b)）: 稽核紀錄導覽連結
// ============================================================

describe("HomePage — 稽核紀錄導覽連結", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("管理員登入 → 首頁顯示「稽核紀錄」連結，指向 /admin/audit-logs", async () => {
    mockMeAs(adminUser);
    mockMyFuelConsumptionEmpty();
    mockEmptyApplicationsList();

    renderHomePage();

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /稽核紀錄/ });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "/admin/audit-logs");
    });
  });

  it("一般使用者（role=USER）登入 → 首頁不顯示「稽核紀錄」連結", async () => {
    mockMeAs(regularUser);
    mockMyFuelConsumptionEmpty();
    mockEmptyApplicationsList();

    renderHomePage();

    await waitFor(() => {
      expect(screen.getByText(/使用者一/)).toBeInTheDocument();
    });

    expect(screen.queryByRole("link", { name: /稽核紀錄/ })).not.toBeInTheDocument();
  });
});

// ============================================================
// PHASE-005-T7: MileageSummarySection 嵌入首頁（D6(a)——不新增路由）
// ============================================================

describe("HomePage — MileageSummarySection 嵌入（D6(a) 共用元件）", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("一般使用者登入 → 首頁顯示區間公務總里程統計區塊，且掛載時不自動查詢（D5(a)）", async () => {
    mockMeAs(regularUser);
    mockMyFuelConsumptionEmpty();
    mockEmptyApplicationsList();

    renderHomePage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "區間公務總里程統計" })).toBeInTheDocument();
    });
    expect(screen.getByText("請選擇日期區間後查詢")).toBeInTheDocument();

    // 僅 /me、/me/fuel-consumption 與 /applications 三次 fetch（PHASE-005a-T11
    // 新增 <MyFuelConsumptionSection /> 之自動查詢，見上方 mockMyFuelConsumptionEmpty
    // 註解）；統計區塊掛載時仍不得多打一次 fetch。
    // PHASE-006-T11R-LITE：CI 慢環境下掛載後的非同步 fetch 可能尚未全數送出，
    // 改以 waitFor 等待穩定為 3 次；隨後短暫等待確認不會「稍後多打」而退化，
    // 鑑別方向（不自動查詢統計區塊）維持不變。
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(3);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("AC-30 鑑別力：統計端點回 999.99、申請列表 3 筆合計 30.00 → 畫面顯示 999.99（前端不自算）", async () => {
    mockMeAs(regularUser);
    mockMyFuelConsumptionEmpty();

    // 申請列表：3 筆，totalKm 合計恰為 30.00（若元件誤自行加總，會顯示 30.00）。
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "app-1",
              type: "TRAVEL",
              status: "COMPLETED",
              primaryDate: "2026-03-01",
              tripDate: "2026-03-01",
              title: "案件一",
              totalKm: "10.00",
              totalAmount: 100,
              segmentCount: 1,
              ownerId: "user-id-1",
              ownerDisplayName: "使用者一",
              onBehalf: false,
              createdAt: "2026-03-01T00:00:00.000Z",
              updatedAt: "2026-03-01T00:00:00.000Z",
            },
            {
              id: "app-2",
              type: "TRAVEL",
              status: "COMPLETED",
              primaryDate: "2026-03-05",
              tripDate: "2026-03-05",
              title: "案件二",
              totalKm: "10.00",
              totalAmount: 100,
              segmentCount: 1,
              ownerId: "user-id-1",
              ownerDisplayName: "使用者一",
              onBehalf: false,
              createdAt: "2026-03-05T00:00:00.000Z",
              updatedAt: "2026-03-05T00:00:00.000Z",
            },
            {
              id: "app-3",
              type: "TRAVEL",
              status: "COMPLETED",
              primaryDate: "2026-03-10",
              tripDate: "2026-03-10",
              title: "案件三",
              totalKm: "10.00",
              totalAmount: 100,
              segmentCount: 1,
              ownerId: "user-id-1",
              ownerDisplayName: "使用者一",
              onBehalf: false,
              createdAt: "2026-03-10T00:00:00.000Z",
              updatedAt: "2026-03-10T00:00:00.000Z",
            },
          ],
          page: 1,
          pageSize: 20,
          total: 3,
          appliedFilters: {
            dateFrom: "2025-01-01",
            dateTo: null,
            type: null,
            status: null,
            keyword: null,
            ownerId: "self",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    renderHomePage();

    await waitFor(() => {
      expect(screen.getByText("案件一")).toBeInTheDocument();
    });

    // 統計端點回 999.99（鑑別值——與列表合計 30.00 刻意不同）。
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          totalKm: "999.99",
          applicationCount: 3,
          appliedFilters: { dateFrom: "2026-03-01", dateTo: "2026-03-31", ownerId: "user-id-1" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    fireEvent.change(screen.getByLabelText("起日 *"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("迄日 *"), { target: { value: "2026-03-31" } });
    fireEvent.click(screen.getByRole("button", { name: "查詢" }));

    await waitFor(() => {
      expect(screen.getByText("公務總里程 999.99 公里")).toBeInTheDocument();
    });
    expect(screen.queryByText(/30\.00/)).not.toBeInTheDocument();
  });
});
