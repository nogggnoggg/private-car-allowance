/**
 * AdminFuelConsumptionPage 前端單元測試 — PHASE-005a-T10（AC-30）
 *
 * 涵蓋：版本列表三態（歷史／目前生效／未來生效）可辨識＋生效日＋依據備註
 * 呈現、建立表單五欄齊備（使用者、油種、油耗、生效日、依據備註）＋
 * basisNote 必填、五態（Loading／Empty／400／404／409／Success／
 * Permission denied）、§11.3 state 不自算鑑別（mock 後端回 FUTURE 但
 * effectiveFrom 為過去日期時，前端仍須顯示 FUTURE——證明前端直接採後端
 * `state` 欄位，不以日期自行比較推導）。
 *
 * 沿用 AdminUserApplicationsPage.test.tsx 之雙路由 + 位置性
 * `mockResolvedValueOnce` fetch mock 慣例。
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { AuthProvider } from "../src/context/AuthContext.js";
import AdminFuelConsumptionPage from "../src/pages/AdminFuelConsumptionPage.js";
import type { FuelConsumptionVersionDto, UserDto } from "../src/types/api.js";

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

function versionFixture(
  overrides: Partial<FuelConsumptionVersionDto> = {}
): FuelConsumptionVersionDto {
  return {
    id: "fc-v1",
    userId: userA.id,
    fuelType: "GASOLINE_95",
    kmPerLiter: "15.0000",
    effectiveFrom: "2026-01-01",
    basisNote: "依車籍資料核對",
    state: "HISTORICAL",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdById: adminUser.id,
    ...overrides,
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

function mockGetVersions(versions: FuelConsumptionVersionDto[]) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ versions }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockErrorResponse(
  code: string,
  message: string,
  status: number,
  extra: Record<string, unknown> = {}
) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ error: { code, message, ...extra } }), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function renderPage(initialPath = "/admin/fuel-consumption") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Routes>
          <Route path="/admin/fuel-consumption" element={<AdminFuelConsumptionPage />} />
          <Route
            path="/admin/users/:userId/fuel-consumption"
            element={<AdminFuelConsumptionPage />}
          />
          <Route path="/" element={<div>首頁占位</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("管理員油耗維護頁", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("版本列表顯示歷史／目前生效／未來生效與依據備註", async () => {
    mockMeAsAdmin();
    mockGetUsers([userA]);
    mockGetVersions([
      versionFixture({
        id: "v-hist",
        state: "HISTORICAL",
        effectiveFrom: "2025-01-01",
        basisNote: "舊車籍資料",
        createdAt: "2024-12-01T00:00:00.000Z",
      }),
      versionFixture({
        id: "v-cur",
        state: "CURRENT",
        effectiveFrom: "2026-01-01",
        basisNote: "目前生效依據",
        createdAt: "2025-12-01T00:00:00.000Z",
      }),
      versionFixture({
        id: "v-fut",
        state: "FUTURE",
        effectiveFrom: "2099-01-01",
        basisNote: "未來生效依據",
        createdAt: "2098-12-01T00:00:00.000Z",
      }),
    ]);

    renderPage(`/admin/users/${userA.id}/fuel-consumption`);

    await waitFor(() => {
      expect(screen.getByText("歷史")).toBeInTheDocument();
      expect(screen.getByText("目前生效")).toBeInTheDocument();
      expect(screen.getByText("未來生效")).toBeInTheDocument();
    });

    expect(screen.getByText("2025-01-01")).toBeInTheDocument();
    expect(screen.getByText("2026-01-01")).toBeInTheDocument();
    expect(screen.getByText("2099-01-01")).toBeInTheDocument();
    expect(screen.getByText("舊車籍資料")).toBeInTheDocument();
    expect(screen.getByText("目前生效依據")).toBeInTheDocument();
    expect(screen.getByText("未來生效依據")).toBeInTheDocument();
  });

  it("state 不自算：mock 後端回傳 FUTURE 但 effectiveFrom 為過去日期 → 前端仍顯示 FUTURE（§11.3 鑑別）", async () => {
    mockMeAsAdmin();
    mockGetUsers([userA]);
    // 刻意矛盾：後端回 state=FUTURE，但 effectiveFrom 是過去日期——
    // 若前端錯誤地自行以「effectiveFrom vs 今日」比較推導 state，會顯示
    // HISTORICAL/CURRENT 而非後端指定的 FUTURE，本測試即會失敗。
    mockGetVersions([
      versionFixture({ id: "v-mismatch", state: "FUTURE", effectiveFrom: "2020-01-01" }),
    ]);

    renderPage(`/admin/users/${userA.id}/fuel-consumption`);

    await waitFor(() => {
      expect(screen.getByText("未來生效")).toBeInTheDocument();
    });
    expect(screen.queryByText("歷史")).not.toBeInTheDocument();
    expect(screen.queryByText("目前生效")).not.toBeInTheDocument();
  });

  it("建立表單五欄齊備，basisNote 為必填", async () => {
    mockMeAsAdmin();
    mockGetUsers([userA]);
    mockGetVersions([]);

    renderPage(`/admin/users/${userA.id}/fuel-consumption`);

    await waitFor(() => {
      expect(screen.getByLabelText(/使用者/)).toBeInTheDocument();
    });

    // 五欄：使用者、油種、油耗、生效日、依據備註
    expect(screen.getByLabelText(/使用者/)).toBeInTheDocument();
    expect(screen.getByLabelText(/油種/)).toBeInTheDocument();
    const kmPerLiterInput = screen.getByLabelText(/油耗（/);
    expect(kmPerLiterInput).toBeInTheDocument();
    const effectiveFromInput = screen.getByLabelText(/生效日期/);
    expect(effectiveFromInput).toBeInTheDocument();
    const basisNoteInput = screen.getByLabelText(/依據備註/);
    expect(basisNoteInput).toBeInTheDocument();
    expect(basisNoteInput).toBeRequired();
  });
});

describe("管理員油耗維護頁 — 五態：Loading／Empty／400／404／409／Success／Permission denied", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Loading：初次渲染顯示載入中", () => {
    (fetch as Mock).mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/載入中/)).toBeInTheDocument();
  });

  it("Empty：已選使用者但尚無版本 → 顯示「此使用者尚未建立油耗資料」", async () => {
    mockMeAsAdmin();
    mockGetUsers([userA]);
    mockGetVersions([]);

    renderPage(`/admin/users/${userA.id}/fuel-consumption`);

    await waitFor(() => {
      expect(screen.getByText("此使用者尚未建立油耗資料")).toBeInTheDocument();
    });
  });

  it("400：VALIDATION_ERROR 就地標示欄位（含 basisNote）", async () => {
    mockMeAsAdmin();
    mockGetUsers([userA]);
    mockGetVersions([]);

    renderPage(`/admin/users/${userA.id}/fuel-consumption`);

    await waitFor(() => {
      expect(screen.getByLabelText(/依據備註/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/油耗（/), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/生效日期/), { target: { value: "2026-05-01" } });
    // basisNote 留空 → 送出後由後端回報必填錯誤

    mockErrorResponse("VALIDATION_ERROR", "輸入資料有誤，請檢查標示欄位。", 400, {
      fields: [{ field: "basisNote", reason: "請填寫核對依據" }],
    });

    fireEvent.click(screen.getByRole("button", { name: /^建立$/ }));

    await waitFor(() => {
      expect(screen.getByText("請填寫核對依據")).toBeInTheDocument();
    });
  });

  it("404：使用者不存在 → 版本列表載入顯示錯誤", async () => {
    mockMeAsAdmin();
    mockGetUsers([userA]);
    mockErrorResponse("NOT_FOUND", "使用者不存在", 404);

    renderPage(`/admin/users/${userA.id}/fuel-consumption`);

    await waitFor(() => {
      expect(screen.getByText("使用者不存在。")).toBeInTheDocument();
    });
  });

  it("409：PARAMETER_PERIOD_OVERLAP → 顯示衝突版本生效日", async () => {
    mockMeAsAdmin();
    mockGetUsers([userA]);
    mockGetVersions([versionFixture({ effectiveFrom: "2026-01-01" })]);

    renderPage(`/admin/users/${userA.id}/fuel-consumption`);

    await waitFor(() => {
      expect(screen.getByLabelText(/油耗（/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/油耗（/), { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText(/生效日期/), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText(/依據備註/), { target: { value: "重複測試依據" } });

    mockErrorResponse(
      "PARAMETER_PERIOD_OVERLAP",
      "新版本的生效期間與現有版本重疊，請調整生效日期。",
      409,
      { details: { conflictVersion: { id: "fc-v1", effectiveFrom: "2026-01-01" } } }
    );

    fireEvent.click(screen.getByRole("button", { name: /^建立$/ }));

    await waitFor(() => {
      expect(screen.getByText(/生效期間重疊.*2026-01-01.*衝突/)).toBeInTheDocument();
    });
  });

  it("Success：建立成功後版本列表更新，顯示 state 標示", async () => {
    mockMeAsAdmin();
    mockGetUsers([userA]);
    mockGetVersions([]);

    renderPage(`/admin/users/${userA.id}/fuel-consumption`);

    await waitFor(() => {
      expect(screen.getByLabelText(/油耗（/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/油耗（/), { target: { value: "18" } });
    fireEvent.change(screen.getByLabelText(/生效日期/), { target: { value: "2026-06-01" } });
    fireEvent.change(screen.getByLabelText(/依據備註/), { target: { value: "新版核對依據" } });

    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version: versionFixture({
            id: "fc-new",
            kmPerLiter: "18.0000",
            effectiveFrom: "2026-06-01",
            basisNote: "新版核對依據",
            state: "CURRENT",
          }),
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      )
    );
    mockGetVersions([
      versionFixture({
        id: "fc-new",
        kmPerLiter: "18.0000",
        effectiveFrom: "2026-06-01",
        basisNote: "新版核對依據",
        state: "CURRENT",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /^建立$/ }));

    await waitFor(() => {
      expect(screen.getByText("油耗版本建立成功。")).toBeInTheDocument();
      expect(screen.getByText("目前生效")).toBeInTheDocument();
      expect(screen.getByText("新版核對依據")).toBeInTheDocument();
    });
  });

  it("Permission denied：一般使用者存取本頁 → 顯示無權限，且不呼叫任何寫入 API", async () => {
    mockMeAsUser();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/僅管理員可使用/)).toBeInTheDocument();
    });

    const calledPaths = (fetch as Mock).mock.calls.map((call) => String(call[0]));
    expect(calledPaths.some((p) => p.includes("/admin/users"))).toBe(false);
    expect(calledPaths.some((p) => p.includes("/fuel-consumption"))).toBe(false);
  });
});
