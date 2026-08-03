/**
 * MyFuelConsumptionSection 前端單元測試 — PHASE-005a-T11
 *
 * 涵蓋 AC-31 全四條：Success 顯示油種/油耗/生效日、Empty 空白狀態、負向斷言
 * （無新增/修改/刪除入口）、固定說明文案。另補 Loading/Error/401 三態
 * （Spec §4 五態表），完整覆蓋本元件之狀態機。
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import MyFuelConsumptionSection from "../src/components/MyFuelConsumptionSection.js";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderSection() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <MyFuelConsumptionSection />
    </MemoryRouter>
  );
}

describe("個人車輛油耗檢視", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("顯示目前生效的油種、油耗與生效日期", async () => {
    (fetch as Mock).mockResolvedValue(
      jsonRes({
        current: {
          fuelType: "GASOLINE_95",
          kmPerLiter: "15.0000",
          effectiveFrom: "2026-01-01",
        },
      })
    );

    renderSection();

    await waitFor(() => {
      expect(screen.getByText("95 無鉛汽油")).toBeInTheDocument();
      expect(screen.getByText("15.0000")).toBeInTheDocument();
      expect(screen.getByText("2026-01-01")).toBeInTheDocument();
    });
  });

  it("無資料時顯示空白狀態與「請聯絡管理員建立」", async () => {
    (fetch as Mock).mockResolvedValue(jsonRes({ current: null }));

    renderSection();

    await waitFor(() => {
      expect(screen.getByText("尚未建立車輛油耗資料，請聯絡管理員建立")).toBeInTheDocument();
    });
  });

  // ---- AC-31 ③ 負向斷言：不存在任何具「新增／修改／刪除」語意之可互動元素 ----
  it("畫面不存在任何新增／修改／刪除入口（負向斷言）", async () => {
    (fetch as Mock).mockResolvedValue(
      jsonRes({
        current: {
          fuelType: "DIESEL",
          kmPerLiter: "10.0000",
          effectiveFrom: "2026-01-01",
        },
      })
    );

    renderSection();

    await waitFor(() => {
      expect(screen.getByText("柴油")).toBeInTheDocument();
    });

    const writeSemanticPattern = /新增|建立|修改|編輯|刪除|更新|儲存|送出|提交/;
    const interactive = [
      ...screen.queryAllByRole("button"),
      ...screen.queryAllByRole("link"),
      ...screen.queryAllByRole("textbox"),
    ];
    for (const el of interactive) {
      expect(el.textContent ?? "").not.toMatch(writeSemanticPattern);
    }
    // 亦不應存在任何 <form>（無寫入表單）。
    expect(document.querySelector("form")).not.toBeInTheDocument();
  });

  it("固定顯示「如與實際車輛不符，請聯絡管理員核對後更新」", async () => {
    (fetch as Mock).mockResolvedValue(
      jsonRes({
        current: {
          fuelType: "GASOLINE_92",
          kmPerLiter: "12.0000",
          effectiveFrom: "2026-01-01",
        },
      })
    );

    renderSection();

    await waitFor(() => {
      expect(screen.getByText("如與實際車輛不符，請聯絡管理員核對後更新")).toBeInTheDocument();
    });
  });

  // ---- 補充：Spec §4 其餘三態 ----
  it("Loading：載入中顯示「載入中…」", () => {
    (fetch as Mock).mockImplementation(() => new Promise(() => {}));
    renderSection();
    expect(screen.getByText("載入中…")).toBeInTheDocument();
  });

  it("Error：5xx 顯示 zh-TW 錯誤訊息與重試", async () => {
    let attempt = 0;
    (fetch as Mock).mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return jsonRes({ error: { code: "INTERNAL_ERROR", message: "系統錯誤" } }, 500);
      }
      return jsonRes({
        current: {
          fuelType: "GASOLINE_98",
          kmPerLiter: "20.0000",
          effectiveFrom: "2026-01-01",
        },
      });
    });

    renderSection();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("系統錯誤");
    });

    await act(async () => {
      screen.getByRole("button", { name: "重試" }).click();
    });

    await waitFor(() => {
      expect(screen.getByText("98 無鉛汽油")).toBeInTheDocument();
    });
  });

  it("401：導向登入（沿用既有 parseApiResponse 慣例）", async () => {
    (fetch as Mock).mockResolvedValue(
      jsonRes({ error: { code: "UNAUTHORIZED", message: "請重新登入" } }, 401)
    );

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<MyFuelConsumptionSection />} />
          <Route path="/login" element={<div>登入頁面占位</div>} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("登入頁面占位")).toBeInTheDocument();
    });
  });
});
