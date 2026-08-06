/**
 * ReportSection 元件單元測試 — PHASE-008-T12
 *
 * 涵蓋 AC-30（報表區塊與產生流程；三條）／AC-31（產生失敗不得顯示成功；一條）。
 * AC-32／AC-33（列印下載入口細節、五態）之測試義務歸 T13——本檔僅驗證 T12
 * 範圍，但元件實作已一次到位（見 src/components/ReportSection.tsx）。
 *
 * 採用與 TravelApplicationPage.test.tsx 相同的 URL/method 路由式 fetch mock
 * 慣例（避免佇列式 mock 因 mount 時自動 GET 查詢而錯位）。
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportDto } from "../src/api/reports.js";
import ReportSection from "../src/components/ReportSection.js";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function installFetchRouter() {
  const calls: { method: string; path: string }[] = [];
  const routes: Array<{ method: string; test: (path: string) => boolean; handler: Handler }> = [];

  (fetch as Mock).mockImplementation(async (input: unknown, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : String(input);
    const url = new URL(urlStr, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path: url.pathname });
    const route = routes.find((r) => r.method === method && r.test(url.pathname));
    if (!route) {
      throw new Error(`Unhandled fetch in test: ${method} ${url.pathname}`);
    }
    return route.handler(url, init);
  });

  return {
    on(method: string, test: (path: string) => boolean, handler: Handler) {
      routes.push({ method, test, handler });
    },
    countCalls(method: string, test: (path: string) => boolean) {
      return calls.filter((c) => c.method === method && test(c.path)).length;
    },
  };
}

const isGetReport = (p: string) => p === "/api/applications/app-1/report";
const isPostReport = (p: string) => p === "/api/applications/app-1/report";

function reportFixture(overrides: Partial<ReportDto> = {}): ReportDto {
  return {
    reportNumber: "TRV-202608-0001",
    generatedAt: "2026-08-06T01:23:45.678Z",
    fileName: "差旅_使用者一_2026-08-01_TRV-202608-0001.pdf",
    byteSize: 123456,
    downloadUrl: "/applications/app-1/report/pdf",
    printUrl: "/applications/app-1/report/print",
    ...overrides,
  };
}

describe("ReportSection", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- AC-30 草稿不渲染（負向斷言） ----
  it("AC-30: 草稿不渲染報表區塊（負向斷言：「產生正式報表」文字不存在），且零 fetch", () => {
    render(<ReportSection applicationId="app-1" status="DRAFT" />);

    expect(screen.queryByText("產生正式報表")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "報表" })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  // ---- AC-30 Empty 態 ----
  it("AC-30: 已完成但尚未產生報表時顯示 Empty 態文案與「產生正式報表」按鈕", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetReport, () => jsonRes({ report: null }));

    render(<ReportSection applicationId="app-1" status="COMPLETED" />);

    expect(await screen.findByRole("heading", { name: "報表" })).toBeInTheDocument();
    expect(await screen.findByText("尚未產生正式報表")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "產生正式報表" })).toBeInTheDocument();

    // Empty 態不得出現任何編號或入口
    expect(screen.queryByText(/TRV-/)).not.toBeInTheDocument();
    expect(screen.queryByText("檢視列印版")).not.toBeInTheDocument();
    expect(screen.queryByText("下載 PDF")).not.toBeInTheDocument();
  });

  // ---- AC-30 產生成功：逐字顯示編號與產生時間 ＋ 兩入口 ----
  it("AC-30: 點擊產生後成功，逐字顯示報表編號與產生時間，並出現「檢視列印版」與「下載 PDF」兩入口", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetReport, () => jsonRes({ report: null }));
    const report = reportFixture();
    router.on("POST", isPostReport, () => jsonRes({ report }, 201));

    render(<ReportSection applicationId="app-1" status="COMPLETED" />);

    const genBtn = await screen.findByRole("button", { name: "產生正式報表" });
    fireEvent.click(genBtn);

    await waitFor(() => {
      expect(screen.getByText(report.reportNumber)).toBeInTheDocument();
    });
    expect(screen.getByText(report.generatedAt)).toBeInTheDocument();

    const printLink = screen.getByRole("link", { name: "檢視列印版" });
    expect(printLink).toHaveAttribute("href", "/api/applications/app-1/report/print");
    expect(printLink).toHaveAttribute("target", "_blank");
    expect(printLink).toHaveAttribute("rel", expect.stringContaining("noopener"));

    const downloadLink = screen.getByRole("link", { name: "下載 PDF" });
    expect(downloadLink).toHaveAttribute("href", "/api/applications/app-1/report/pdf");

    // 產生按鈕於成功後不再顯示
    expect(screen.queryByRole("button", { name: "產生正式報表" })).not.toBeInTheDocument();
  });

  // ---- AC-31 產生失敗不得顯示成功 ----
  it("AC-31: 產生端點回 500 REPORT_GENERATION_FAILED → 顯示錯誤與重試，零編號零「已產生」零入口；重試會重新呼叫產生端點", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetReport, () => jsonRes({ report: null }));
    router.on("POST", isPostReport, () =>
      jsonRes(
        { error: { code: "REPORT_GENERATION_FAILED", message: "報表產生失敗，請稍後再試。" } },
        500
      )
    );

    render(<ReportSection applicationId="app-1" status="COMPLETED" />);

    const genBtn = await screen.findByRole("button", { name: "產生正式報表" });
    fireEvent.click(genBtn);

    const retryBtn = await screen.findByRole("button", { name: "重試" });
    expect(screen.getByText("報表產生失敗，請稍後再試。")).toBeInTheDocument();

    // 零編號、零「已產生」字樣、零下載/列印入口
    expect(screen.queryByText(/TRV-/)).not.toBeInTheDocument();
    expect(screen.queryByText(/已產生/)).not.toBeInTheDocument();
    expect(screen.queryByText("檢視列印版")).not.toBeInTheDocument();
    expect(screen.queryByText("下載 PDF")).not.toBeInTheDocument();

    expect(router.countCalls("POST", isPostReport)).toBe(1);

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(router.countCalls("POST", isPostReport)).toBe(2);
    });
  });
});
