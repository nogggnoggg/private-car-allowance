/**
 * AdminUserApplicationsPage 前端單元測試 — PHASE-004-T14
 *
 * 涵蓋：五態（Loading/Empty/Error/Success/Permission denied）、未選使用者時
 * 代操作入口停用 + 選定後啟用（反向案例，AC-79 之 UX 面）、選定使用者後
 * GET /applications 帶正確 ownerId（AC-84）、代操作建立成功後導向草稿編輯頁
 * （AC-78）、代操作失敗顯示後端錯誤（使用者已停用）。
 *
 * 沿用 AdminUsersPage.test.tsx / ApplicationListSection.test.tsx 的位置性
 * `mockResolvedValueOnce` fetch mock 慣例（本頁無 debounce，順序決定性）。
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { ApplicationListResponse, TravelApplicationDto } from "../src/api/applications.js";
import type { MileageSummaryResponse } from "../src/api/statistics.js";
import { AuthProvider } from "../src/context/AuthContext.js";
import AdminUserApplicationsPage from "../src/pages/AdminUserApplicationsPage.js";
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

const userA: UserDto = {
  id: "user-a",
  loginName: "usera",
  displayName: "使用者甲",
  employeeNumber: "EMP001",
  role: "USER",
  isActive: true,
  mustChangePassword: false,
};

const userB: UserDto = {
  id: "user-b",
  loginName: "userb",
  displayName: "使用者乙",
  employeeNumber: null,
  role: "USER",
  isActive: false,
  mustChangePassword: false,
};

function draftFixture(overrides: Partial<TravelApplicationDto> = {}): TravelApplicationDto {
  return {
    id: "new-app-99",
    type: "TRAVEL",
    status: "DRAFT",
    ownerId: userA.id,
    ownerDisplayName: userA.displayName,
    createdById: adminUser.id,
    createdByDisplayName: adminUser.displayName,
    onBehalf: true,
    tripDate: null,
    purpose: null,
    segments: [],
    completionBlockers: [
      { code: "TRIP_DATE_REQUIRED", field: "tripDate", message: "請填寫出差日期" },
    ],
    computed: null,
    snapshot: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function emptyListResponse(ownerId: string): ApplicationListResponse {
  return {
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
      ownerId,
    },
  };
}

// ---- Mock helpers ----

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
    new Response(JSON.stringify({ user: regularUser }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
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

function mockApplicationsList(res: ApplicationListResponse) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify(res), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockErrorResponse(code: string, message: string, status: number) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockMileageSummary(res: MileageSummaryResponse) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify(res), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockCreateOnBehalfSuccess(application: TravelApplicationDto) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ application }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })
  );
}

/** Route placeholder for `/applications/travel/:id` — asserts navigation target's id. */
function TravelPlaceholder() {
  const { id } = useParams();
  return <div data-testid="travel-placeholder">草稿編輯頁占位:{id}</div>;
}

function renderPage(initialPath = "/admin/applications") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Routes>
          <Route path="/admin/applications" element={<AdminUserApplicationsPage />} />
          <Route path="/admin/users/:userId/applications" element={<AdminUserApplicationsPage />} />
          <Route path="/applications/travel/:id" element={<TravelPlaceholder />} />
          <Route path="/" element={<div>首頁占位</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("AdminUserApplicationsPage", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Loading ----
  it("Loading：初次渲染顯示載入中", () => {
    (fetch as Mock).mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/載入中/)).toBeInTheDocument();
  });

  // ---- Permission denied ----
  it("Permission denied：一般使用者存取本頁 → 顯示存取被拒，且不呼叫任何管理端點（不外洩他人資料）", async () => {
    mockMeAsUser();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/存取被拒/)).toBeInTheDocument();
    });

    const calledPaths = (fetch as Mock).mock.calls.map((call) => String(call[0]));
    expect(calledPaths.some((p) => p.includes("/admin/users"))).toBe(false);
    expect(calledPaths.some((p) => p.includes("/api/applications"))).toBe(false);
  });

  // ---- Error ----
  it("Error：載入使用者清單失敗顯示錯誤 + 重試", async () => {
    mockMeAsAdmin();
    mockErrorResponse("INTERNAL_ERROR", "系統發生錯誤，請稍後再試。", 500);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("系統發生錯誤，請稍後再試。");
    });

    mockGetUsers([userA]);
    fireEvent.click(screen.getByRole("button", { name: "重試" }));

    await waitFor(() => {
      expect(screen.getByLabelText("選擇使用者")).toBeInTheDocument();
    });
  });

  // ---- 未選使用者 disabled / 選定後 enabled（反向案例） ----
  it("未選使用者：代操作入口停用，且不觸發 GET /applications；選定使用者後入口啟用（反向案例）", async () => {
    mockMeAsAdmin();
    mockGetUsers([userA, userB]);
    renderPage("/admin/applications");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "代建立差旅草稿" })).toBeDisabled();
    });
    expect(screen.getByText("請先選擇使用者")).toBeInTheDocument();

    // Discriminating (would catch an "always disabled" fake-pass implementation
    // that never fetches anything): the list must NOT have been queried yet.
    const pathsBeforeSelect = (fetch as Mock).mock.calls.map((call) => String(call[0]));
    expect(pathsBeforeSelect.some((p) => p.includes("/api/applications"))).toBe(false);

    mockApplicationsList(emptyListResponse(userA.id));
    fireEvent.change(screen.getByLabelText("選擇使用者"), { target: { value: userA.id } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "代建立差旅草稿" })).toBeEnabled();
    });
  });

  // ---- 選定使用者後：GET /applications 帶正確 ownerId（AC-84） ----
  it("選定使用者後：GET /applications 查詢帶正確 ownerId", async () => {
    mockMeAsAdmin();
    mockGetUsers([userA, userB]);
    renderPage("/admin/applications");

    await waitFor(() => {
      expect(screen.getByLabelText("選擇使用者")).toBeInTheDocument();
    });

    mockApplicationsList(emptyListResponse(userA.id));
    fireEvent.change(screen.getByLabelText("選擇使用者"), { target: { value: userA.id } });

    await waitFor(() => {
      const calls = (fetch as Mock).mock.calls;
      const last = calls[calls.length - 1]?.[0] as string;
      expect(last).toContain("/api/applications");
      expect(last).toContain(`ownerId=${userA.id}`);
    });
  });

  // ---- Empty ----
  it("Empty：選定使用者但該使用者尚無申請紀錄 → 顯示「該使用者尚無申請紀錄」，不顯示自助新增連結", async () => {
    mockMeAsAdmin();
    mockGetUsers([userA]);
    mockApplicationsList(emptyListResponse(userA.id));
    renderPage(`/admin/users/${userA.id}/applications`);

    await waitFor(() => {
      expect(screen.getByText("該使用者尚無申請紀錄。")).toBeInTheDocument();
    });

    // Must NOT show the self-service "新增差旅補助" link (would create a draft
    // owned by the admin themselves — wrong in this context, see
    // ApplicationListSection.tsx's `showCreateLink` doc comment).
    expect(screen.queryByRole("link", { name: /新增差旅補助/ })).not.toBeInTheDocument();
    // The admin's own on-behalf entry must still be present and enabled.
    expect(screen.getByRole("button", { name: "代建立差旅草稿" })).toBeEnabled();
  });

  // ---- Success ----
  it("Success：選定使用者且有申請紀錄 → 顯示清單，標題含使用者姓名", async () => {
    mockMeAsAdmin();
    mockGetUsers([userA]);
    mockApplicationsList({
      items: [
        {
          id: "app-1",
          type: "TRAVEL",
          status: "DRAFT",
          primaryDate: "2026-03-01",
          tripDate: "2026-03-01",
          title: "台中客戶拜訪",
          totalKm: null,
          totalAmount: null,
          segmentCount: 1,
          ownerId: userA.id,
          ownerDisplayName: userA.displayName,
          onBehalf: true,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
      appliedFilters: {
        dateFrom: "2025-01-01",
        dateTo: null,
        type: null,
        status: null,
        keyword: null,
        ownerId: userA.id,
      },
    });
    renderPage(`/admin/users/${userA.id}/applications`);

    await waitFor(() => {
      expect(screen.getByText("台中客戶拜訪")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("heading", { level: 1, name: new RegExp(userA.displayName) })
    ).toBeInTheDocument();
  });

  // ---- 代操作建立成功 → 導向草稿編輯頁（AC-78） ----
  it("代操作建立成功 → 導向 /applications/travel/:id", async () => {
    mockMeAsAdmin();
    mockGetUsers([userA]);
    mockApplicationsList(emptyListResponse(userA.id));
    renderPage(`/admin/users/${userA.id}/applications`);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "代建立差旅草稿" })).toBeEnabled();
    });

    mockCreateOnBehalfSuccess(draftFixture());
    fireEvent.click(screen.getByRole("button", { name: "代建立差旅草稿" }));

    await waitFor(() => {
      expect(screen.getByTestId("travel-placeholder")).toHaveTextContent("new-app-99");
    });

    // The create request itself must have gone to the on-behalf endpoint.
    const calls = (fetch as Mock).mock.calls;
    const createCall = calls.find(([u]) => String(u).includes("/admin/users/"));
    expect(createCall?.[0]).toBe(`/api/admin/users/${userA.id}/applications/travel`);
  });

  // ---- 管理員統計區塊：ownerId 精確等於路由 :userId，顯示值非管理員自己的（AC-31） ----
  it("admin statistics request carries ownerId equal to route :userId", async () => {
    // --- Part 1：路由預選 userA ---
    mockMeAsAdmin();
    mockGetUsers([userA, userB]);
    mockApplicationsList(emptyListResponse(userA.id));
    const { unmount } = renderPage(`/admin/users/${userA.id}/applications`);

    await waitFor(() => {
      expect(screen.getByLabelText("起日 *")).toBeInTheDocument();
    });

    mockMileageSummary({
      totalKm: "247.10",
      applicationCount: 3,
      appliedFilters: { dateFrom: "2026-03-01", dateTo: "2026-03-31", ownerId: userA.id },
    });
    fireEvent.change(screen.getByLabelText("起日 *"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("迄日 *"), { target: { value: "2026-03-31" } });
    fireEvent.click(screen.getByRole("button", { name: "查詢" }));

    await waitFor(() => {
      expect(screen.getByText("公務總里程 247.10 公里")).toBeInTheDocument();
    });

    const callsA = (fetch as Mock).mock.calls;
    const statsCallA = callsA.find(([u]) => String(u).includes("/statistics/mileage"));
    expect(statsCallA?.[0]).toContain(`ownerId=${userA.id}`);
    expect(statsCallA?.[0]).not.toContain(`ownerId=${adminUser.id}`);

    unmount();

    // --- Part 2：路由改選 userB，統計端點回傳與 Part 1 互異之值（247.10 vs
    // 88.88）——鑑別「顯示值非管理員自己的」，也防止實作誤把 ownerId 寫死或
    // 遺漏（若遺漏，後端會依 AC-25 預設為呼叫者=管理員自己，數值必然不符）。
    mockMeAsAdmin();
    mockGetUsers([userA, userB]);
    mockApplicationsList(emptyListResponse(userB.id));
    renderPage(`/admin/users/${userB.id}/applications`);

    await waitFor(() => {
      expect(screen.getByLabelText("起日 *")).toBeInTheDocument();
    });

    mockMileageSummary({
      totalKm: "88.88",
      applicationCount: 1,
      appliedFilters: { dateFrom: "2026-03-01", dateTo: "2026-03-31", ownerId: userB.id },
    });
    fireEvent.change(screen.getByLabelText("起日 *"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("迄日 *"), { target: { value: "2026-03-31" } });
    fireEvent.click(screen.getByRole("button", { name: "查詢" }));

    await waitFor(() => {
      expect(screen.getByText("公務總里程 88.88 公里")).toBeInTheDocument();
    });

    const callsB = (fetch as Mock).mock.calls;
    // 用 findLast：兩個 render 共用同一支 spy，calls 累積了 Part 1（userA）的
    // 呼叫紀錄——必須取「最後一筆」統計請求，才是 Part 2（userB）之查詢。
    const statsCallB = [...callsB]
      .reverse()
      .find(([u]) => String(u).includes("/statistics/mileage"));
    expect(statsCallB?.[0]).toContain(`ownerId=${userB.id}`);
    expect(statsCallB?.[0]).not.toContain(`ownerId=${adminUser.id}`);
    // 反向鑑別：不得殘留/誤顯示 Part 1（userA）之數值。
    expect(screen.queryByText("公務總里程 247.10 公里")).not.toBeInTheDocument();
  });

  // ---- 代操作失敗（使用者已停用）→ 顯示後端錯誤 ----
  it("代操作失敗（使用者已停用）→ 就地顯示後端錯誤訊息", async () => {
    mockMeAsAdmin();
    mockGetUsers([userB]);
    mockApplicationsList(emptyListResponse(userB.id));
    renderPage(`/admin/users/${userB.id}/applications`);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "代建立差旅草稿" })).toBeEnabled();
    });

    mockErrorResponse("VALIDATION_ERROR", "指定的使用者已停用，無法代其建立申請", 400);
    fireEvent.click(screen.getByRole("button", { name: "代建立差旅草稿" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("指定的使用者已停用");
    });
  });
});
