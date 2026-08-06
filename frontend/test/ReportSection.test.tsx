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

  // ---- AC-32 列印與下載入口 ----
  it("AC-32: 檢視列印版以 target=_blank + rel=noopener 開啟 /api/.../report/print；下載導向 /api/.../report/pdf 且點擊時零 POST", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetReport, () => jsonRes({ report: null }));
    const report = reportFixture();
    router.on("POST", isPostReport, () => jsonRes({ report }, 201));

    render(<ReportSection applicationId="app-1" status="COMPLETED" />);

    const genBtn = await screen.findByRole("button", { name: "產生正式報表" });
    fireEvent.click(genBtn);

    const printLink = await screen.findByRole("link", { name: "檢視列印版" });
    expect(printLink).toHaveAttribute("href", "/api/applications/app-1/report/print");
    expect(printLink).toHaveAttribute("target", "_blank");
    expect(printLink).toHaveAttribute("rel", expect.stringContaining("noopener"));

    const downloadLink = screen.getByRole("link", { name: "下載 PDF" });
    expect(downloadLink).toHaveAttribute("href", "/api/applications/app-1/report/pdf");

    expect(router.countCalls("POST", isPostReport)).toBe(1);

    // 前端不自組檔名、不自行渲染 PDF、不重複呼叫產生端點：點擊下載入口
    // （純 <a href> 導覽，非 fetch 呼叫）不得觸發任何額外 POST。
    // preventDefault 僅為抑制 jsdom「Not implemented: navigation」雜訊
    // （jsdom 不支援真實頁面導覽），不影響本斷言之鑑別力——POST 計數的
    // 唯一來源是 handleGenerate，與是否實際導覽無關。
    downloadLink.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(downloadLink);
    expect(router.countCalls("POST", isPostReport)).toBe(1);
  });

  // ---- AC-33 五態 ----
  describe("AC-33: 五態", () => {
    it("Loading：產生中按鈕停用並顯示「產生中…」", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetReport, () => jsonRes({ report: null }));
      const resolveRef: { current: (() => void) | null } = { current: null };
      router.on(
        "POST",
        isPostReport,
        () =>
          new Promise((resolve) => {
            resolveRef.current = () => resolve(jsonRes({ report: reportFixture() }, 201));
          })
      );

      render(<ReportSection applicationId="app-1" status="COMPLETED" />);

      const genBtn = await screen.findByRole("button", { name: "產生正式報表" });
      fireEvent.click(genBtn);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "產生中…" })).toBeDisabled();
      });

      resolveRef.current?.();
      await waitFor(() => {
        expect(screen.getByText(/TRV-/)).toBeInTheDocument();
      });
    });

    it("Error：讀取報表資訊失敗顯示錯誤與重試（與 AC-31 產生失敗分開）", async () => {
      const router = installFetchRouter();
      let getCount = 0;
      router.on("GET", isGetReport, () => {
        getCount += 1;
        if (getCount === 1) {
          return jsonRes(
            { error: { code: "UNKNOWN", message: "讀取報表資訊失敗，請稍後再試。" } },
            500
          );
        }
        return jsonRes({ report: null });
      });

      render(<ReportSection applicationId="app-1" status="COMPLETED" />);

      expect(await screen.findByText("讀取報表資訊失敗，請稍後再試。")).toBeInTheDocument();
      expect(router.countCalls("GET", isGetReport)).toBe(1);

      fireEvent.click(screen.getByRole("button", { name: "重試" }));

      await waitFor(() => {
        expect(screen.getByText("尚未產生正式報表")).toBeInTheDocument();
      });
      expect(router.countCalls("GET", isGetReport)).toBe(2);
    });

    it("Permission denied：403 FORBIDDEN → 顯示無權限訊息，且零後續請求（無重試鈕）", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetReport, () =>
        jsonRes({ error: { code: "FORBIDDEN", message: "無權存取此資源" } }, 403)
      );

      render(<ReportSection applicationId="app-1" status="COMPLETED" />);

      expect(await screen.findByText("無權存取此申請之報表。")).toBeInTheDocument();

      // 無重試鈕（重試即後續請求，牴觸「零後續請求」）；亦無任何產生/下載
      // 入口。
      expect(screen.queryByRole("button", { name: "重試" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "產生正式報表" })).not.toBeInTheDocument();
      expect(screen.queryByText("檢視列印版")).not.toBeInTheDocument();

      expect(router.countCalls("GET", isGetReport)).toBe(1);
      expect(router.countCalls("POST", isPostReport)).toBe(0);
    });

    // Empty 態已由本檔 AC-30 既有測試涵蓋。Success 態則有兩條路徑：AC-30
    // 既有測試僅涵蓋「產生後（POST 回應）進入 Success」；「重開詳情頁時
    // GET 直接帶回已產生報表」路徑另補於下方，兩者不可互相取代。
    it("Success（經 GET 進入，非點擊產生）：mount 時 GET 直接回傳已產生報表，逐字顯示編號與產生時間、兩入口在場、產生鈕不在場，且零 POST", async () => {
      const router = installFetchRouter();
      const report = reportFixture();
      router.on("GET", isGetReport, () => jsonRes({ report }));

      render(<ReportSection applicationId="app-1" status="COMPLETED" />);

      expect(await screen.findByText(report.reportNumber)).toBeInTheDocument();
      expect(screen.getByText(report.generatedAt)).toBeInTheDocument();

      expect(screen.getByRole("link", { name: "檢視列印版" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "下載 PDF" })).toBeInTheDocument();

      expect(screen.queryByRole("button", { name: "產生正式報表" })).not.toBeInTheDocument();
      expect(screen.queryByText("尚未產生正式報表")).not.toBeInTheDocument();

      expect(router.countCalls("POST", isPostReport)).toBe(0);
    });
  });
});
