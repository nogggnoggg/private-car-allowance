/**
 * ApplicationListSection 前端單元測試 — PHASE-004-T13
 *
 * 涵蓋：五態（Loading/Empty/Error/Success/Permission denied）、AC-68（不適用
 * 欄位顯示「—」）、AC-69（無紀錄 + 新增入口）、AC-70（篩選後無結果非錯誤）、
 * 篩選送出正確 query、分頁、D7（不自算金額——畫面顯示的即為 mock 之後端值）。
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { ApplicationListResponse } from "../src/api/applications.js";
import ApplicationListSection from "../src/components/ApplicationListSection.js";

function mockListResponse(res: ApplicationListResponse, status = 200) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify(res), { status, headers: { "Content-Type": "application/json" } })
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

function renderSection() {
  return render(
    <MemoryRouter>
      <ApplicationListSection />
    </MemoryRouter>
  );
}

const emptyFilters = {
  dateFrom: "2025-01-01",
  dateTo: null,
  type: null,
  status: null,
  keyword: null,
  ownerId: "self",
};

describe("ApplicationListSection", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Loading ----
  it("Loading：初次渲染顯示載入中", () => {
    (fetch as Mock).mockImplementationOnce(() => new Promise(() => {}));
    renderSection();
    expect(screen.getByText("載入中…")).toBeInTheDocument();
  });

  // ---- Empty (AC-69) ----
  it("Empty（無任何紀錄）：顯示空白狀態 + 新增差旅補助入口（AC-69）", async () => {
    mockListResponse({ items: [], page: 1, pageSize: 20, total: 0, appliedFilters: emptyFilters });
    renderSection();

    await waitFor(() => {
      expect(screen.getByText("尚無任何申請紀錄。")).toBeInTheDocument();
    });

    // AC-69: entry to create a new travel application must be present.
    const links = screen.getAllByRole("link", { name: /新增差旅補助/ });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/applications/travel/new");
    }
  });

  // ---- Empty after filtering (AC-70) ----
  it("篩選後無結果：顯示空白狀態，不得顯示錯誤訊息（AC-70）", async () => {
    // Initial load (no filters) — has records, so the section renders normally.
    mockListResponse({
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
          ownerId: "self",
          ownerDisplayName: "使用者一",
          onBehalf: false,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
      appliedFilters: emptyFilters,
    });
    renderSection();

    await waitFor(() => {
      expect(screen.getByText("台中客戶拜訪")).toBeInTheDocument();
    });

    // Apply a keyword filter that yields no results.
    mockListResponse({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
      appliedFilters: { ...emptyFilters, keyword: "不存在的關鍵字" },
    });

    fireEvent.change(screen.getByLabelText("關鍵字（出差目的）"), {
      target: { value: "不存在的關鍵字" },
    });
    fireEvent.click(screen.getByRole("button", { name: "套用篩選" }));

    await waitFor(() => {
      expect(screen.getByText("查無符合條件的紀錄。")).toBeInTheDocument();
    });

    // Must NOT render any error/alert element.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // ---- Error ----
  it("Error：載入失敗顯示錯誤訊息 + 重試按鈕", async () => {
    mockErrorResponse("INTERNAL_ERROR", "系統發生錯誤，請稍後再試。", 500);
    renderSection();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("系統發生錯誤，請稍後再試。");
    });

    mockListResponse({ items: [], page: 1, pageSize: 20, total: 0, appliedFilters: emptyFilters });
    fireEvent.click(screen.getByRole("button", { name: "重試" }));

    await waitFor(() => {
      expect(screen.getByText("尚無任何申請紀錄。")).toBeInTheDocument();
    });
  });

  // ---- Permission denied ----
  it("Permission denied：403 顯示無權限訊息", async () => {
    mockErrorResponse("FORBIDDEN", "無權查詢他人之申請紀錄", 403);
    renderSection();

    await waitFor(() => {
      expect(screen.getByText("無權限存取此資料。")).toBeInTheDocument();
    });
  });

  // ---- Success + AC-68 (type label / status badge / "—" for N/A fields) ----
  it("Success：顯示類型標籤、狀態、不適用欄位為「—」（AC-68），且金額為後端原值（不自算）", async () => {
    mockListResponse({
      items: [
        {
          id: "app-1",
          type: "TRAVEL",
          status: "COMPLETED",
          primaryDate: "2026-03-01",
          tripDate: "2026-03-01",
          title: "台中客戶拜訪",
          totalKm: "120.00",
          totalAmount: 777, // deliberately non-obvious value — must appear verbatim (D7)
          segmentCount: 2,
          ownerId: "self",
          ownerDisplayName: "使用者一",
          onBehalf: false,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
        {
          id: "app-2",
          type: "MAINTENANCE",
          status: "DRAFT",
          primaryDate: "2026-03-05",
          tripDate: null,
          title: null,
          totalKm: null,
          totalAmount: null,
          segmentCount: null,
          ownerId: "self",
          ownerDisplayName: "使用者一",
          onBehalf: false,
          createdAt: "2026-03-05T00:00:00.000Z",
          updatedAt: "2026-03-05T00:00:00.000Z",
        },
      ],
      page: 1,
      pageSize: 20,
      total: 2,
      appliedFilters: emptyFilters,
    });
    renderSection();

    await waitFor(() => {
      expect(screen.getByText("差旅補助")).toBeInTheDocument();
    });

    const table = within(screen.getByRole("table", { name: "申請紀錄清單" }));

    // Discriminating: displayed amount is EXACTLY the mocked backend value.
    expect(table.getByText("777")).toBeInTheDocument();
    expect(table.getByText("已完成")).toBeInTheDocument();
    expect(table.getByText("保養分攤")).toBeInTheDocument();
    expect(table.getByText("草稿")).toBeInTheDocument();

    // AC-68: N/A fields for the MAINTENANCE row render literal "—".
    const dashCells = table.getAllByText("—");
    expect(dashCells.length).toBeGreaterThanOrEqual(3); // title, totalKm, totalAmount, segmentCount, operation link
  });

  it("Success：篩選表單送出正確的 query（日期/類型/狀態/關鍵字）", async () => {
    mockListResponse({ items: [], page: 1, pageSize: 20, total: 0, appliedFilters: emptyFilters });
    renderSection();
    await waitFor(() => expect(screen.getByText("尚無任何申請紀錄。")).toBeInTheDocument());

    mockListResponse({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
      appliedFilters: { ...emptyFilters, type: "TRAVEL", status: "DRAFT", keyword: "客戶" },
    });

    fireEvent.change(screen.getByLabelText("起日"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("迄日"), { target: { value: "2026-12-31" } });
    fireEvent.change(screen.getByLabelText("類型"), { target: { value: "TRAVEL" } });
    fireEvent.change(screen.getByLabelText("狀態"), { target: { value: "DRAFT" } });
    fireEvent.change(screen.getByLabelText("關鍵字（出差目的）"), { target: { value: "客戶" } });
    fireEvent.click(screen.getByRole("button", { name: "套用篩選" }));

    await waitFor(() => {
      const calls = (fetch as Mock).mock.calls;
      const last = calls[calls.length - 1]?.[0] as string;
      expect(last).toContain("dateFrom=2026-01-01");
      expect(last).toContain("dateTo=2026-12-31");
      expect(last).toContain("type=TRAVEL");
      expect(last).toContain("status=DRAFT");
      expect(last).toContain("keyword=%E5%AE%A2%E6%88%B6");
    });
  });

  it("分頁：顯示頁次/總筆數，且下一頁按鈕送出 page=2", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: `app-${i}`,
      type: "TRAVEL" as const,
      status: "DRAFT" as const,
      primaryDate: "2026-03-01",
      tripDate: "2026-03-01",
      title: `行程 ${i}`,
      totalKm: null,
      totalAmount: null,
      segmentCount: 1,
      ownerId: "self",
      ownerDisplayName: "使用者一",
      onBehalf: false,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    }));
    mockListResponse({ items, page: 1, pageSize: 20, total: 45, appliedFilters: emptyFilters });
    renderSection();

    await waitFor(() => {
      expect(screen.getByText(/第 1 \/ 3 頁/)).toBeInTheDocument();
    });

    mockListResponse({ items: [], page: 2, pageSize: 20, total: 45, appliedFilters: emptyFilters });
    fireEvent.click(screen.getByRole("button", { name: "下一頁" }));

    await waitFor(() => {
      const calls = (fetch as Mock).mock.calls;
      const last = calls[calls.length - 1]?.[0] as string;
      expect(last).toContain("page=2");
    });
  });
});
