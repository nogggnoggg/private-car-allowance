/**
 * ParametersPage 前端單元測試 — PHASE-003a-T6
 *
 * 測試策略：
 *   - mock fetch (全域 vi.spyOn)
 *   - 三類參數（Fuel / ETC / Depreciation）× 五態（Loading / Empty / Error / Success / Permission denied）
 *   - 折舊顯示後端回傳的 derived（前端不自行計算）
 *   - 防重複提交（送出中按鈕禁用）
 *   - Error 細分：值域錯（fields 標欄位）、重疊錯（conflictVersion）、載入錯（可重試）
 *
 * 沿用 AdminUsersPage.test.tsx 風格（MemoryRouter + AuthProvider + mock fetch）。
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { AuthProvider } from "../src/context/AuthContext.js";
import ParametersPage from "../src/pages/ParametersPage.js";
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

function mockGetVersions(type: "fuel" | "etc" | "depreciation", versions: unknown[]) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ versions }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockGet403() {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "無權限。" } }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockGetError(message = "伺服器錯誤") {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ error: { code: "INTERNAL_SERVER_ERROR", message } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/parameters"]}>
      <AuthProvider>
        <Routes>
          <Route path="/admin/parameters" element={<ParametersPage />} />
          <Route path="/" element={<div>首頁占位</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

// Sample DTOs
const fuelVersion = {
  id: "fuel-v1",
  unitPrice: "3.5000",
  effectiveFrom: "2026-01-01",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const etcVersion = {
  id: "etc-v1",
  unitPrice: "2.0000",
  effectiveFrom: "2026-01-01",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const depreciationVersion = {
  id: "dep-v1",
  vehiclePrice: "500000.00",
  usefulLifeYears: 5,
  estimatedAnnualKm: 15000,
  effectiveFrom: "2026-01-01",
  createdAt: "2026-01-01T00:00:00.000Z",
  derived: {
    annualDepreciation: "100000.00",
    perKmUnitPrice: "6.6667",
  },
};

// ============================================================
// Loading 態
// ============================================================

describe("ParametersPage — Loading 態", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Fuel: 列表載入中顯示載入指示", async () => {
    // /api/me → admin (slow, never resolves)
    (fetch as Mock).mockImplementation(() => new Promise(() => {}));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/載入中/)).toBeInTheDocument();
    });
  });
});

// ============================================================
// Permission denied 態
// ============================================================

describe("ParametersPage — Permission denied 態", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("一般使用者：AuthContext 角色為 USER → 顯示無權限態", async () => {
    mockMeAs(regularUser);

    renderPage();

    await waitFor(() => {
      // Page-level permission denied shows "存取被拒" (single element)
      expect(screen.getByText(/存取被拒/)).toBeInTheDocument();
    });
  });

  it("Fuel: 後端回傳 403 → 顯示無權限態", async () => {
    mockMeAs(adminUser);
    // fuel GET → 403
    mockGet403();
    // etc GET → 403
    mockGet403();
    // depreciation GET → 403
    mockGet403();

    renderPage();

    await waitFor(() => {
      // Each section shows "無權限存取此資料。" on 403; use getAllByText since 3 sections appear
      const els = screen.getAllByText(/無權限/);
      expect(els.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ============================================================
// Empty 態
// ============================================================

describe("ParametersPage — Empty 態（各類無版本）", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Fuel Empty：無版本時顯示空狀態與建立入口", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", [etcVersion]);
    mockGetVersions("depreciation", [depreciationVersion]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/尚無任何油資版本/)).toBeInTheDocument();
    });
  });

  it("ETC Empty：無版本時顯示空狀態與建立入口", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", [fuelVersion]);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", [depreciationVersion]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/尚無任何 ETC 版本/)).toBeInTheDocument();
    });
  });

  it("Depreciation Empty：無版本時顯示空狀態與建立入口", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", [fuelVersion]);
    mockGetVersions("etc", [etcVersion]);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/尚無任何折舊版本/)).toBeInTheDocument();
    });
  });
});

// ============================================================
// Error 態
// ============================================================

describe("ParametersPage — Error 態", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("載入錯誤：顯示錯誤訊息與重試按鈕", async () => {
    mockMeAs(adminUser);
    // All three fail
    mockGetError("伺服器錯誤");
    mockGetError("伺服器錯誤");
    mockGetError("伺服器錯誤");

    renderPage();

    await waitFor(() => {
      // At least one error state with retry button
      expect(screen.getAllByRole("button", { name: /重試/ }).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("Fuel: 值域錯（unitPrice < 0）→ fields 標示 unitPrice 欄位", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      // 頁面就緒，找到油資表單
      expect(screen.getByLabelText(/油資單價/)).toBeInTheDocument();
    });

    // Fill form with invalid price
    fireEvent.change(screen.getByLabelText(/油資單價/), { target: { value: "-1" } });

    const [firstDateInput] = screen.getAllByLabelText(/生效日期/);
    if (firstDateInput) fireEvent.change(firstDateInput, { target: { value: "2026-02-01" } });

    // Mock POST → 400 VALIDATION_ERROR with fields
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: "輸入資料有誤，請檢查標示欄位。",
            fields: [{ field: "unitPrice", reason: "單價不得小於 0" }],
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    );

    const [firstSubmitBtn] = screen.getAllByRole("button", { name: /^建立$/ });
    if (firstSubmitBtn) fireEvent.click(firstSubmitBtn);

    await waitFor(() => {
      expect(screen.getByText(/單價不得小於 0/)).toBeInTheDocument();
    });
  });

  it("Fuel: 重疊錯（PARAMETER_PERIOD_OVERLAP）→ 顯示衝突版本", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText(/油資單價/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/油資單價/), { target: { value: "3.5" } });

    const [firstDateInput] = screen.getAllByLabelText(/生效日期/);
    if (firstDateInput) fireEvent.change(firstDateInput, { target: { value: "2026-01-01" } });

    // Mock POST → 409 PARAMETER_PERIOD_OVERLAP
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "PARAMETER_PERIOD_OVERLAP",
            message: "新版本的生效期間與現有版本重疊，請調整生效日期。",
            details: {
              conflictVersion: { id: "fuel-v1", effectiveFrom: "2026-01-01" },
            },
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      )
    );

    const [firstSubmitBtn] = screen.getAllByRole("button", { name: /^建立$/ });
    if (firstSubmitBtn) fireEvent.click(firstSubmitBtn);

    await waitFor(() => {
      // Should show conflict info (effectiveFrom of conflicting version)
      expect(screen.getByText(/重疊|衝突|2026-01-01/)).toBeInTheDocument();
    });
  });

  it("ETC: 值域錯（unitPrice < 0）→ fields 標示 unitPrice 欄位", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", [fuelVersion]);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText(/ETC 單價/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/ETC 單價/), { target: { value: "-5" } });

    const dateInputs = screen.getAllByLabelText(/生效日期/);
    const etcDateInput = dateInputs[1] ?? dateInputs[0];
    if (etcDateInput) fireEvent.change(etcDateInput, { target: { value: "2026-03-01" } });

    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: "輸入資料有誤，請檢查標示欄位。",
            fields: [{ field: "unitPrice", reason: "單價不得小於 0" }],
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    );

    // The ETC submit button (second "建立" button on page)
    const submitBtns = screen.getAllByRole("button", { name: /^建立$/ });
    const etcSubmitBtn = submitBtns[1] ?? submitBtns[0];
    if (etcSubmitBtn) fireEvent.click(etcSubmitBtn);

    await waitFor(() => {
      expect(screen.getByText(/單價不得小於 0/)).toBeInTheDocument();
    });
  });

  it("Depreciation: 值域錯（usefulLifeYears ≤ 0）→ fields 標示 usefulLifeYears", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", [fuelVersion]);
    mockGetVersions("etc", [etcVersion]);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText(/折舊年限/)).toBeInTheDocument();
    });

    // Fill with invalid usefulLifeYears
    fireEvent.change(screen.getByLabelText(/折舊年限/), { target: { value: "0" } });

    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: "輸入資料有誤，請檢查標示欄位。",
            fields: [{ field: "usefulLifeYears", reason: "必須大於 0" }],
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    );

    const submitBtns = screen.getAllByRole("button", { name: /^建立$/ });
    const depSubmitBtn = submitBtns[submitBtns.length - 1];
    if (depSubmitBtn) fireEvent.click(depSubmitBtn);

    await waitFor(() => {
      expect(screen.getByText(/必須大於 0/)).toBeInTheDocument();
    });
  });
});

// ============================================================
// Success 態
// ============================================================

describe("ParametersPage — Success 態", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Fuel: 建立成功 → 刷新列表 + 成功提示", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText(/油資單價/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/油資單價/), { target: { value: "3.5" } });

    const [firstDateInput] = screen.getAllByLabelText(/生效日期/);
    if (firstDateInput) fireEvent.change(firstDateInput, { target: { value: "2026-02-01" } });

    // Mock POST → 201 success
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ version: { ...fuelVersion, id: "fuel-v2", effectiveFrom: "2026-02-01" } }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      )
    );

    // Refresh GET fuel
    mockGetVersions("fuel", [{ ...fuelVersion, id: "fuel-v2", effectiveFrom: "2026-02-01" }]);

    const [firstSubmitBtn] = screen.getAllByRole("button", { name: /^建立$/ });
    if (firstSubmitBtn) fireEvent.click(firstSubmitBtn);

    await waitFor(() => {
      expect(screen.getByText(/建立成功|已建立/)).toBeInTheDocument();
    });
  });

  it("ETC: 建立成功 → 刷新列表 + 成功提示", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText(/ETC 單價/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/ETC 單價/), { target: { value: "2.0" } });

    const dateInputs = screen.getAllByLabelText(/生效日期/);
    const etcDateInput = dateInputs[1] ?? dateInputs[0];
    if (etcDateInput) fireEvent.change(etcDateInput, { target: { value: "2026-02-01" } });

    // Mock POST → 201 success
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ version: { ...etcVersion, id: "etc-v2", effectiveFrom: "2026-02-01" } }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      )
    );

    // Refresh GET etc
    mockGetVersions("etc", [{ ...etcVersion, id: "etc-v2", effectiveFrom: "2026-02-01" }]);

    const submitBtns = screen.getAllByRole("button", { name: /^建立$/ });
    const etcSubmitBtn = submitBtns[1] ?? submitBtns[0];
    if (etcSubmitBtn) fireEvent.click(etcSubmitBtn);

    await waitFor(() => {
      expect(screen.getByText(/建立成功|已建立/)).toBeInTheDocument();
    });
  });

  it("Depreciation: 建立成功 → 刷新列表 + 顯示後端 derived（前端不自算）", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText(/車價/)).toBeInTheDocument();
    });

    // Fill depreciation form
    fireEvent.change(screen.getByLabelText(/車價/), { target: { value: "500000" } });
    fireEvent.change(screen.getByLabelText(/折舊年限/), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/預估年度行駛公里數/), { target: { value: "15000" } });

    const dateInputs = screen.getAllByLabelText(/生效日期/);
    const lastDateInput = dateInputs[dateInputs.length - 1];
    if (lastDateInput) fireEvent.change(lastDateInput, { target: { value: "2026-02-01" } });

    // Mock POST → 201 success with derived from backend
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version: {
            ...depreciationVersion,
            effectiveFrom: "2026-02-01",
            derived: {
              annualDepreciation: "100000.00",
              perKmUnitPrice: "6.6667",
            },
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      )
    );

    // Refresh GET depreciation — returns version with derived
    mockGetVersions("depreciation", [
      {
        ...depreciationVersion,
        effectiveFrom: "2026-02-01",
        derived: {
          annualDepreciation: "100000.00",
          perKmUnitPrice: "6.6667",
        },
      },
    ]);

    const submitBtns = screen.getAllByRole("button", { name: /^建立$/ });
    const depSubmitBtn = submitBtns[submitBtns.length - 1];
    if (depSubmitBtn) fireEvent.click(depSubmitBtn);

    await waitFor(() => {
      expect(screen.getByText(/建立成功|已建立/)).toBeInTheDocument();
    });

    // Verify derived values displayed (from backend, not calculated by frontend)
    await waitFor(() => {
      expect(screen.getByText(/100000\.00|100000/)).toBeInTheDocument();
      expect(screen.getByText(/6\.6667/)).toBeInTheDocument();
    });
  });
});

// ============================================================
// 防重複提交
// ============================================================

describe("ParametersPage — 防重複提交", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Fuel: 送出中按鈕禁用，防止重複提交", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText(/油資單價/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/油資單價/), { target: { value: "3.5" } });

    const [firstDateInput] = screen.getAllByLabelText(/生效日期/);
    if (firstDateInput) fireEvent.change(firstDateInput, { target: { value: "2026-02-01" } });

    // Mock slow POST (never resolves for fuel endpoint)
    (fetch as Mock).mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/api/parameters/fuel")) {
        return new Promise(() => {}); // never resolves
      }
      return Promise.resolve(
        new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
      );
    });

    const [firstSubmitBtn] = screen.getAllByRole("button", { name: /^建立$/ });
    if (firstSubmitBtn) fireEvent.click(firstSubmitBtn);

    await waitFor(() => {
      // Button should be disabled or show loading text "建立中…"
      const loadingBtns = screen.getAllByRole("button", { name: /建立中/ });
      if (loadingBtns.length > 0) {
        expect(loadingBtns[0]).toBeInTheDocument();
      } else {
        // Alternatively, the submit button is disabled
        const [btn] = screen.getAllByRole("button", { name: /^建立$/ });
        expect(btn).toBeDisabled();
      }
    });
  });
});

// ============================================================
// 折舊顯示 derived（前端不自算）
// ============================================================

describe("ParametersPage — 折舊列表顯示 derived", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("列表顯示後端回傳的 derived.annualDepreciation 與 derived.perKmUnitPrice", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", [depreciationVersion]);

    renderPage();

    await waitFor(() => {
      // derived.annualDepreciation = "100000.00"
      expect(screen.getByText(/100000\.00/)).toBeInTheDocument();
      // derived.perKmUnitPrice = "6.6667"
      expect(screen.getByText(/6\.6667/)).toBeInTheDocument();
    });
  });
});

// ============================================================
// 版本列表渲染
// ============================================================

describe("ParametersPage — 版本列表渲染", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Fuel: 列表顯示版本 unitPrice 與 effectiveFrom", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", [fuelVersion]);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/3\.5000/)).toBeInTheDocument();
      expect(screen.getAllByText(/2026-01-01/).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("ETC: 列表顯示版本 unitPrice 與 effectiveFrom", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", [etcVersion]);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/2\.0000/)).toBeInTheDocument();
      expect(screen.getAllByText(/2026-01-01/).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("Depreciation: 列表顯示 vehiclePrice / usefulLifeYears / estimatedAnnualKm / derived", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", [depreciationVersion]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/500000\.00/)).toBeInTheDocument();
      expect(screen.getByText(/100000\.00/)).toBeInTheDocument();
      expect(screen.getByText(/6\.6667/)).toBeInTheDocument();
    });
  });
});
