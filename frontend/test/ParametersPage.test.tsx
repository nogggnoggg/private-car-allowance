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

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { AuthProvider } from "../src/context/AuthContext.js";
import ParametersPage, { formatDateYmd } from "../src/pages/ParametersPage.js";
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
  fuelType: "GASOLINE_92",
  pricePerLiter: "30.5000",
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

  it("Fuel Empty：四油種皆無版本時各自顯示空狀態", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", [etcVersion]);
    mockGetVersions("depreciation", [depreciationVersion]);

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText(/尚未建立此油種的油價版本/).length).toBe(4);
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

  it("Fuel: 值域錯（pricePerLiter < 0）→ fields 標示 pricePerLiter 欄位", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      // 頁面就緒，找到油價表單
      expect(screen.getByLabelText(/每公升油價/)).toBeInTheDocument();
    });

    // Fill form with invalid price
    fireEvent.change(screen.getByLabelText(/每公升油價/), { target: { value: "-1" } });

    const [firstDateInput] = screen.getAllByLabelText(/生效日期/);
    if (firstDateInput) fireEvent.change(firstDateInput, { target: { value: "2026-02-01" } });

    // Mock POST → 400 VALIDATION_ERROR with fields
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: "輸入資料有誤，請檢查標示欄位。",
            fields: [{ field: "pricePerLiter", reason: "單價不得小於 0" }],
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
      expect(screen.getByLabelText(/每公升油價/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/每公升油價/), { target: { value: "30.5" } });

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
      expect(screen.getByLabelText(/每公升油價/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/每公升油價/), { target: { value: "30.5" } });

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
      expect(screen.getByLabelText(/每公升油價/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/每公升油價/), { target: { value: "30.5" } });

    const [firstDateInput] = screen.getAllByLabelText(/生效日期/);
    if (firstDateInput) fireEvent.change(firstDateInput, { target: { value: "2026-02-01" } });

    // Mock slow POST (never resolves for the fuel-price endpoint).
    // PHASE-005a-T9 附帶必辦：改用精確比對 "/api/parameters/fuel-price"，
    // 不得再用寬鬆的 "/api/parameters/fuel"（後者亦會命中已凍結的舊制端點，
    // 兩端點之 mock 因而無法區辨）。
    (fetch as Mock).mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/api/parameters/fuel-price")) {
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

  it("Fuel: 列表顯示版本 pricePerLiter 與 effectiveFrom（於對應油種分組下）", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", [fuelVersion]);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/30\.5000/)).toBeInTheDocument();
      expect(screen.getAllByText(/2026-01-01/).length).toBeGreaterThanOrEqual(1);
    });

    // fuelVersion 為 GASOLINE_92 → 應出現在該油種的表格內
    const table = screen.getByLabelText("92 無鉛汽油 油價版本清單");
    expect(table).toBeInTheDocument();
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

// ============================================================
// UI-FIX-001-T1 — 建立時間格式（YYYY-MM-DD，補零，本地時區）
// ============================================================

describe("formatDateYmd — 純函式單元測試", () => {
  it("單位數月份與日期均補零為兩位數", () => {
    // 2026-01-05T01:00:00.000Z 在 Asia/Taipei（UTC+8）為本地 2026-01-05 09:00
    expect(formatDateYmd("2026-01-05T01:00:00.000Z")).toBe("2026-01-05");
  });

  it("單位數日期、雙位數月份亦補零", () => {
    // 2026-09-01T01:00:00.000Z 在 Asia/Taipei 為本地 2026-09-01 09:00
    expect(formatDateYmd("2026-09-01T01:00:00.000Z")).toBe("2026-09-01");
  });

  it("雙位數月份與日期原樣輸出", () => {
    expect(formatDateYmd("2026-12-25T01:00:00.000Z")).toBe("2026-12-25");
  });
});

describe("ParametersPage — 建立時間欄格式化為 YYYY-MM-DD", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Fuel: 建立時間欄顯示補零的 YYYY-MM-DD（單位數月/日具鑑別力）", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", [{ ...fuelVersion, createdAt: "2026-03-05T01:00:00.000Z" }]);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      // 修復前 toLocaleDateString("zh-TW") 輸出為 "2026/3/5"（無補零），
      // 修復後應為 "2026-03-05"。
      expect(screen.getByText("2026-03-05")).toBeInTheDocument();
      expect(screen.queryByText(/2026\/3\/5/)).not.toBeInTheDocument();
    });
  });

  it("ETC: 建立時間欄顯示補零的 YYYY-MM-DD", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", [{ ...etcVersion, createdAt: "2026-09-01T01:00:00.000Z" }]);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("2026-09-01")).toBeInTheDocument();
      expect(screen.queryByText(/2026\/9\/1/)).not.toBeInTheDocument();
    });
  });

  it("Depreciation: 建立時間欄顯示補零的 YYYY-MM-DD", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", [
      { ...depreciationVersion, createdAt: "2026-07-04T01:00:00.000Z" },
    ]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("2026-07-04")).toBeInTheDocument();
      expect(screen.queryByText(/2026\/7\/4/)).not.toBeInTheDocument();
    });
  });
});

// ============================================================
// UI-FIX-001-T1 — 折舊表 .table-scroll wrapper
// ============================================================

describe("ParametersPage — 折舊表包在 .table-scroll wrapper 內", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("折舊表格的直接外層具備 .table-scroll class", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", [depreciationVersion]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("折舊參數版本清單")).toBeInTheDocument();
    });

    const table = screen.getByLabelText("折舊參數版本清單");
    expect(table.parentElement).toHaveClass("table-scroll");
  });

  it("油資（油價）表格不需要 .table-scroll wrapper（僅 3 欄）", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", [fuelVersion]);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("92 無鉛汽油 油價版本清單")).toBeInTheDocument();
    });

    const table = screen.getByLabelText("92 無鉛汽油 油價版本清單");
    expect(table.parentElement).not.toHaveClass("table-scroll");
  });
});

// ============================================================
// UI-FIX-001-T1 — 數值欄靠右對齊 class
// ============================================================

describe("ParametersPage — 數值欄具備靠右對齊 class", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Fuel: 每公升油價欄（th 與 td）具備 num-col class", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", [fuelVersion]);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/30\.5000/)).toBeInTheDocument();
    });

    const th = screen.getByRole("columnheader", { name: "每公升油價（元／公升）" });
    expect(th).toHaveClass("num-col");
    const td = screen.getByText("30.5000");
    expect(td).toHaveClass("num-col");
  });

  it("ETC: 每公里單價欄（th 與 td）具備 num-col class", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", [etcVersion]);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/2\.0000/)).toBeInTheDocument();
    });

    const th = screen.getByRole("columnheader", { name: "每公里單價（元）" });
    expect(th).toHaveClass("num-col");
    const td = screen.getByText("2.0000");
    expect(td).toHaveClass("num-col");
  });

  it("Depreciation: 五個數值欄（車價/折舊年限/預估年里程/每年折舊費用/每公里單價）均具備 num-col class", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", [depreciationVersion]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/500000\.00/)).toBeInTheDocument();
    });

    const headerNames = [
      "車價（元）",
      "折舊年限（年）",
      "預估年里程（公里）",
      "每年折舊費用（元）",
      "每公里單價（元）",
    ];
    for (const name of headerNames) {
      expect(screen.getByRole("columnheader", { name })).toHaveClass("num-col");
    }

    expect(screen.getByText("500000.00")).toHaveClass("num-col");
    expect(screen.getByText("5")).toHaveClass("num-col");
    expect(screen.getByText("15000")).toHaveClass("num-col");
    expect(screen.getByText("100000.00")).toHaveClass("num-col");
    expect(screen.getByText("6.6667")).toHaveClass("num-col");
  });
});

// ============================================================
// PHASE-005a-T9（AC-29）— 油價維護：油種選擇、每公升油價、依油種分組列表、五態
// ============================================================

describe("油價維護（PHASE-005a）", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("表單含油種選擇與「每公升油價（元／公升）」欄位", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText(/油種/)).toBeInTheDocument();
    });

    // 四項 zh-TW 標籤逐字（AC-29）
    const select = screen.getByLabelText(/油種/) as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toEqual(["92 無鉛汽油", "95 無鉛汽油", "98 無鉛汽油", "柴油"]);

    // 每公升油價欄位標籤明示單位「元／公升」
    expect(screen.getByLabelText(/每公升油價（元／公升）/)).toBeInTheDocument();
  });

  it("版本列表依油種分組呈現，四油種各自時間軸可辨識", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", [
      {
        id: "f-92-a",
        fuelType: "GASOLINE_92",
        pricePerLiter: "30.1000",
        effectiveFrom: "2026-01-01",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "f-92-b",
        fuelType: "GASOLINE_92",
        pricePerLiter: "31.2000",
        effectiveFrom: "2026-03-01",
        createdAt: "2026-03-01T00:00:00.000Z",
      },
      {
        id: "f-95-a",
        fuelType: "GASOLINE_95",
        pricePerLiter: "32.5000",
        effectiveFrom: "2026-02-01",
        createdAt: "2026-02-01T00:00:00.000Z",
      },
      {
        id: "f-diesel-a",
        fuelType: "DIESEL",
        pricePerLiter: "28.0000",
        effectiveFrom: "2026-01-15",
        createdAt: "2026-01-15T00:00:00.000Z",
      },
    ]);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("92 無鉛汽油 油價版本清單")).toBeInTheDocument();
    });

    // 92 無鉛汽油：兩筆版本同組時間軸皆可見
    const table92 = screen.getByLabelText("92 無鉛汽油 油價版本清單");
    expect(within(table92).getByText("30.1000")).toBeInTheDocument();
    expect(within(table92).getByText("31.2000")).toBeInTheDocument();
    expect(within(table92).queryByText("32.5000")).not.toBeInTheDocument();

    // 95 無鉛汽油：僅一筆，且與 92 分組互不干涉
    const table95 = screen.getByLabelText("95 無鉛汽油 油價版本清單");
    expect(within(table95).getByText("32.5000")).toBeInTheDocument();
    expect(within(table95).queryByText("30.1000")).not.toBeInTheDocument();

    // 98 無鉛汽油：尚無版本 → 空狀態（getByRole 排除下拉選單中的同名 option）
    expect(
      screen.getByRole("heading", { level: 4, name: "98 無鉛汽油" }).nextElementSibling
    ).toHaveTextContent("尚未建立此油種的油價版本");

    // 柴油：一筆，且與其他油種互不干涉
    const tableDiesel = screen.getByLabelText("柴油 油價版本清單");
    expect(within(tableDiesel).getByText("28.0000")).toBeInTheDocument();
    expect(within(tableDiesel).queryByText("30.1000")).not.toBeInTheDocument();
  });

  it("五態：Loading／Empty／400 就地標示／409 衝突／Success", async () => {
    // ---- Loading ----
    (fetch as Mock).mockImplementation(() => new Promise(() => {}));
    const loadingRender = renderPage();
    await waitFor(() => {
      expect(screen.getByText(/載入中/)).toBeInTheDocument();
    });
    loadingRender.unmount();
    (fetch as Mock).mockReset();

    // ---- Empty ----
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);
    const emptyRender = renderPage();
    await waitFor(() => {
      expect(screen.getAllByText(/尚未建立此油種的油價版本/).length).toBe(4);
    });
    emptyRender.unmount();
    (fetch as Mock).mockReset();

    // ---- 400 就地標示 ----
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);
    const errorRender = renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText(/每公升油價/)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/每公升油價/), { target: { value: "-5" } });
    {
      const [dateInput] = screen.getAllByLabelText(/生效日期/);
      if (dateInput) fireEvent.change(dateInput, { target: { value: "2026-05-01" } });
    }
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: "輸入資料有誤，請檢查標示欄位。",
            fields: [{ field: "pricePerLiter", reason: "單價不得小於 0" }],
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    );
    {
      const [submitBtn] = screen.getAllByRole("button", { name: /^建立$/ });
      if (submitBtn) fireEvent.click(submitBtn);
    }
    await waitFor(() => {
      expect(screen.getByText(/單價不得小於 0/)).toBeInTheDocument();
    });
    errorRender.unmount();
    (fetch as Mock).mockReset();

    // ---- 409 衝突 ----
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);
    const conflictRender = renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText(/每公升油價/)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/每公升油價/), { target: { value: "30" } });
    {
      const [dateInput] = screen.getAllByLabelText(/生效日期/);
      if (dateInput) fireEvent.change(dateInput, { target: { value: "2026-01-01" } });
    }
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "PARAMETER_PERIOD_OVERLAP",
            message: "新版本的生效期間與現有版本重疊，請調整生效日期。",
            details: { conflictVersion: { id: "fuel-v1", effectiveFrom: "2026-01-01" } },
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      )
    );
    {
      const [submitBtn] = screen.getAllByRole("button", { name: /^建立$/ });
      if (submitBtn) fireEvent.click(submitBtn);
    }
    await waitFor(() => {
      expect(screen.getByText(/重疊|衝突|2026-01-01/)).toBeInTheDocument();
    });
    conflictRender.unmount();
    (fetch as Mock).mockReset();

    // ---- Success ----
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);
    const successRender = renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText(/每公升油價/)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/每公升油價/), { target: { value: "30.5" } });
    {
      const [dateInput] = screen.getAllByLabelText(/生效日期/);
      if (dateInput) fireEvent.change(dateInput, { target: { value: "2026-02-01" } });
    }
    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version: { ...fuelVersion, id: "fuel-v3", effectiveFrom: "2026-02-01" },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      )
    );
    mockGetVersions("fuel", [{ ...fuelVersion, id: "fuel-v3", effectiveFrom: "2026-02-01" }]);
    {
      const [submitBtn] = screen.getAllByRole("button", { name: /^建立$/ });
      if (submitBtn) fireEvent.click(submitBtn);
    }
    await waitFor(() => {
      expect(screen.getByText(/建立成功|已建立/)).toBeInTheDocument();
    });
    successRender.unmount();
  });

  it("Permission denied：非管理員不呼叫寫入 API（POST /parameters/fuel-price 從未被呼叫）", async () => {
    mockMeAs(regularUser);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/存取被拒/)).toBeInTheDocument();
    });

    // 僅 /api/me 一次呼叫；頁面級權限守門阻擋所有區塊渲染與 API 呼叫
    expect((fetch as Mock).mock.calls.length).toBe(1);
    const calledUrls = (fetch as Mock).mock.calls.map((c) => c[0]);
    expect(
      calledUrls.some((u) => typeof u === "string" && u.includes("/api/parameters/fuel"))
    ).toBe(false);
  });

  it("鑑別力：建立呼叫精確命中 /api/parameters/fuel-price，而非已凍結之舊制 /api/parameters/fuel", async () => {
    mockMeAs(adminUser);
    mockGetVersions("fuel", []);
    mockGetVersions("etc", []);
    mockGetVersions("depreciation", []);

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText(/每公升油價/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/每公升油價/), { target: { value: "30.5" } });
    const [dateInput] = screen.getAllByLabelText(/生效日期/);
    if (dateInput) fireEvent.change(dateInput, { target: { value: "2026-02-01" } });

    (fetch as Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version: { ...fuelVersion, id: "fuel-v9", effectiveFrom: "2026-02-01" },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      )
    );
    mockGetVersions("fuel", [{ ...fuelVersion, id: "fuel-v9", effectiveFrom: "2026-02-01" }]);

    const [submitBtn] = screen.getAllByRole("button", { name: /^建立$/ });
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/建立成功|已建立/)).toBeInTheDocument();
    });

    const calledUrls = (fetch as Mock).mock.calls.map((c) => c[0]);
    // 精確比對：必須命中新端點，且從未命中舊端點的精確路徑
    expect(calledUrls).toContain("/api/parameters/fuel-price");
    expect(calledUrls).not.toContain("/api/parameters/fuel");
  });
});
