/**
 * MileageSummarySection 前端單元測試 — PHASE-005-T7
 *
 * 涵蓋 AC-27~30：
 *   - 五態（Loading / Empty / Error / Success / Permission denied）
 *   - AC-28：起>迄前端就地攔截（不呼叫後端）＋ 後端 400 fields.dateRange 就地呈現
 *   - AC-29：0 值明確顯示「0.00 公里」＋ 說明文字，非空白/—/NaN/錯誤樣式
 *   - AC-30：顯示值一律來自統計端點，不由列表 items[] 自算（999.99 vs 30.00 鑑別）
 *   - 防重複提交（查詢中禁用按鈕）
 *   - 初始態不自動查詢（掛載後不得呼叫 fetch）
 *
 * 沿用 ApplicationListSection.test.tsx / ParametersPage 之 fetch mock 慣例。
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { MileageSummaryResponse } from "../src/api/statistics.js";
import MileageSummarySection from "../src/components/MileageSummarySection.js";

function mockSummaryResponse(res: MileageSummaryResponse, status = 200) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify(res), { status, headers: { "Content-Type": "application/json" } })
  );
}

function mockErrorResponse(
  code: string,
  message: string,
  status: number,
  fields?: Array<{ field: string; reason: string }>
) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ error: { code, message, fields } }), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function fillAndSubmit(dateFrom: string, dateTo: string) {
  fireEvent.change(screen.getByLabelText(/起日/), { target: { value: dateFrom } });
  fireEvent.change(screen.getByLabelText(/迄日/), { target: { value: dateTo } });
  fireEvent.click(screen.getByRole("button", { name: /查詢|計算中/ }));
}

describe("MileageSummarySection", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- 初始態：不自動查詢（D5(a)） ----
  it("初始態：掛載後不呼叫 fetch，顯示「請選擇日期區間後查詢」", () => {
    render(<MileageSummarySection />);
    expect(screen.getByText("請選擇日期區間後查詢")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  // ---- Loading ----
  it("Loading：送出查詢後顯示「計算中…」，查詢鈕停用（防重複提交）", async () => {
    (fetch as Mock).mockImplementationOnce(() => new Promise(() => {}));
    render(<MileageSummarySection />);

    fillAndSubmit("2026-03-01", "2026-03-31");

    const button = await screen.findByRole("button", { name: "計算中…" });
    expect(button).toBeDisabled();
    expect(document.querySelector(".loading-block")).toBeInTheDocument();
  });

  it("防重複提交：查詢中重複點擊查詢鈕不得觸發第二次 fetch", async () => {
    let resolveFetch: (v: Response) => void = () => {};
    (fetch as Mock).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    render(<MileageSummarySection />);

    fillAndSubmit("2026-03-01", "2026-03-31");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "計算中…" })).toBeDisabled();
    });

    // The button is disabled — clicking it (or re-submitting the form) must
    // not fire a second fetch call.
    fireEvent.click(screen.getByRole("button", { name: "計算中…" }));
    expect(fetch).toHaveBeenCalledTimes(1);

    resolveFetch(
      new Response(
        JSON.stringify({
          totalKm: "10.00",
          applicationCount: 1,
          appliedFilters: { dateFrom: "2026-03-01", dateTo: "2026-03-31", ownerId: "self" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    await waitFor(() => {
      expect(screen.getByText("公務總里程 10.00 公里")).toBeInTheDocument();
    });
  });

  // ---- Success ----
  it("Success：顯示公務總里程與實際套用區間", async () => {
    mockSummaryResponse({
      totalKm: "35.75",
      applicationCount: 2,
      appliedFilters: { dateFrom: "2026-03-01", dateTo: "2026-03-31", ownerId: "self" },
    });
    render(<MileageSummarySection />);

    fillAndSubmit("2026-03-01", "2026-03-31");

    await waitFor(() => {
      expect(screen.getByText("公務總里程 35.75 公里")).toBeInTheDocument();
    });
    expect(screen.getByText(/2026-03-01 ～ 2026-03-31/)).toBeInTheDocument();
    expect(screen.getByText(/共 2 筆/)).toBeInTheDocument();
  });

  // ---- Empty (AC-29) ----
  it("Empty（AC-29）：後端回 0 → 顯示「0.00 公里」＋ 說明，非空白/—/NaN/錯誤樣式", async () => {
    mockSummaryResponse({
      totalKm: "0.00",
      applicationCount: 0,
      appliedFilters: { dateFrom: "2026-04-01", dateTo: "2026-04-30", ownerId: "self" },
    });
    render(<MileageSummarySection />);

    fillAndSubmit("2026-04-01", "2026-04-30");

    await waitFor(() => {
      expect(screen.getByText("0.00 公里")).toBeInTheDocument();
    });
    expect(screen.getByText("此區間無已完成的差旅紀錄")).toBeInTheDocument();

    // 反向鑑別：不得顯示空白、—、NaN，也不得落入 error-block（錯誤樣式）。
    const resultRegion = screen.getByText("0.00 公里").closest("div");
    expect(resultRegion).not.toBeNull();
    expect(resultRegion?.textContent).not.toMatch(/NaN/);
    expect(resultRegion?.textContent).not.toBe("—");
    expect(resultRegion?.className).not.toContain("error-block");
    expect(document.querySelector(".error-block")).not.toBeInTheDocument();
  });

  // ---- Error ----
  it("Error（5xx）：顯示 zh-TW 錯誤訊息 + 重試按鈕；點擊重試重新查詢", async () => {
    mockErrorResponse("INTERNAL_ERROR", "伺服器發生錯誤，請稍後再試。", 500);
    render(<MileageSummarySection />);

    fillAndSubmit("2026-03-01", "2026-03-31");

    await waitFor(() => {
      expect(screen.getByText("伺服器發生錯誤，請稍後再試。")).toBeInTheDocument();
    });
    const retryButton = screen.getByRole("button", { name: "重試" });
    expect(retryButton).toBeInTheDocument();

    mockSummaryResponse({
      totalKm: "12.34",
      applicationCount: 1,
      appliedFilters: { dateFrom: "2026-03-01", dateTo: "2026-03-31", ownerId: "self" },
    });
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(screen.getByText("公務總里程 12.34 公里")).toBeInTheDocument();
    });
  });

  // ---- Permission denied ----
  it("Permission denied（403 FORBIDDEN）：顯示可辨識訊息，不顯示任何數值", async () => {
    mockErrorResponse("FORBIDDEN", "無權查詢", 403);
    render(<MileageSummarySection />);

    fillAndSubmit("2026-03-01", "2026-03-31");

    await waitFor(() => {
      expect(screen.getByText("無權查詢此使用者之統計。")).toBeInTheDocument();
    });
    expect(screen.queryByText(/公務總里程 \d/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+(\.\d+)?\s*公里/)).not.toBeInTheDocument();
  });

  it("Permission denied（403 PASSWORD_CHANGE_REQUIRED）：顯示與 FORBIDDEN 不同之可辨識訊息", async () => {
    mockErrorResponse("PASSWORD_CHANGE_REQUIRED", "須變更密碼", 403);
    render(<MileageSummarySection />);

    fillAndSubmit("2026-03-01", "2026-03-31");

    await waitFor(() => {
      expect(screen.getByText("請先完成密碼變更後再查詢。")).toBeInTheDocument();
    });
  });

  it("Permission denied（401 UNAUTHORIZED）：顯示與其餘 permission-denied 訊息不同之可辨識訊息", async () => {
    mockErrorResponse("UNAUTHORIZED", "未登入", 401);
    render(<MileageSummarySection />);

    fillAndSubmit("2026-03-01", "2026-03-31");

    await waitFor(() => {
      expect(screen.getByText("請重新登入後再查詢。")).toBeInTheDocument();
    });
  });

  // ---- AC-28：起>迄 ----
  it("AC-28（前端攔截路）：起>迄 → 就地顯示區間錯誤，不呼叫 fetch", () => {
    render(<MileageSummarySection />);

    fireEvent.change(screen.getByLabelText(/起日/), { target: { value: "2026-03-02" } });
    fireEvent.change(screen.getByLabelText(/迄日/), { target: { value: "2026-03-01" } });
    fireEvent.click(screen.getByRole("button", { name: "查詢" }));

    expect(screen.getByText("起日不可晚於迄日，請重新選擇日期區間。")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();

    // 就地標示：日期欄位須與錯誤訊息關聯（aria-describedby）。
    const dateFromInput = screen.getByLabelText(/起日/);
    const dateToInput = screen.getByLabelText(/迄日/);
    expect(dateFromInput.getAttribute("aria-describedby")).toContain("mileage-dateRange-err");
    expect(dateToInput.getAttribute("aria-describedby")).toContain("mileage-dateRange-err");
  });

  it("AC-28（後端 400 路）：後端回 fields.dateRange → 就地呈現於日期欄位", async () => {
    // 前端未攔截的情境以「兩個合法日期但後端仍判定起>迄」模擬（例如前後端
    // 驗證邏輯落差）——重點在於元件對後端 400 fields 的呈現路徑本身。
    mockErrorResponse("VALIDATION_ERROR", "查詢參數有誤，請檢查標示欄位。", 400, [
      { field: "dateRange", reason: "起日（dateFrom）不可晚於迄日（dateTo）" },
    ]);
    render(<MileageSummarySection />);

    fillAndSubmit("2026-03-01", "2026-03-31");

    await waitFor(() => {
      expect(screen.getByText("起日（dateFrom）不可晚於迄日（dateTo）")).toBeInTheDocument();
    });

    const dateFromInput = screen.getByLabelText(/起日/);
    const dateToInput = screen.getByLabelText(/迄日/);
    expect(dateFromInput.getAttribute("aria-describedby")).toContain("mileage-dateRange-err");
    expect(dateToInput.getAttribute("aria-describedby")).toContain("mileage-dateRange-err");
  });

  it("後端 400 fields.dateFrom/dateTo（格式錯誤）→ 就地標示對應欄位", async () => {
    mockErrorResponse("VALIDATION_ERROR", "查詢參數有誤，請檢查標示欄位。", 400, [
      { field: "dateFrom", reason: "日期格式錯誤（必須為 YYYY-MM-DD）" },
    ]);
    render(<MileageSummarySection />);

    fillAndSubmit("2026-03-01", "2026-03-31");

    await waitFor(() => {
      expect(screen.getByText("日期格式錯誤（必須為 YYYY-MM-DD）")).toBeInTheDocument();
    });
    const dateFromInput = screen.getByLabelText(/起日/);
    expect(dateFromInput.getAttribute("aria-describedby")).toContain("mileage-dateFrom-err");
  });

  // ---- AC-30：鑑別力（999.99 vs 30.00）----
  it("AC-30：顯示值來自統計端點（999.99），即使假設列表加總為 30.00，也不得顯示 30.00", async () => {
    // 統計端點回 999.99；本元件不讀取、也不接觸任何「列表」資料——因此本測試
    // 只需證明：無論如何都不會顯示 30.00，且顯示的正是統計端點之 999.99。
    mockSummaryResponse({
      totalKm: "999.99",
      applicationCount: 3,
      appliedFilters: { dateFrom: "2026-01-01", dateTo: "2026-12-31", ownerId: "self" },
    });
    render(<MileageSummarySection />);

    fillAndSubmit("2026-01-01", "2026-12-31");

    await waitFor(() => {
      expect(screen.getByText("公務總里程 999.99 公里")).toBeInTheDocument();
    });
    expect(screen.queryByText(/30\.00/)).not.toBeInTheDocument();
  });
});
