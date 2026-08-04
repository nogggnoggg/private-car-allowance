/**
 * MaintenanceApplicationPage 前端單元測試 — PHASE-006-T11
 *
 * 涵蓋 AC-34（五欄表單、部分欄位儲存、400 fields[] 就地標示）、AC-35（預覽
 * 四值直取後端、零自算鑑別、比例 > 100% 阻擋完成、不可計算不顯示 0）、
 * AC-37（表單/預覽兩處五態；Permission denied 零寫入呼叫）。
 *
 * 採用 URL/method 路由式 fetch mock（比照 TravelApplicationPage.test.tsx 既有
 * 慣例）——本頁掛載後會自動觸發一次 debounced 預覽請求，佇列式 mock 容易被
 * 插隊而錯位。
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { MaintenanceApplicationDto, MaintenanceComputedDto } from "../src/api/maintenance.js";
import MaintenanceApplicationPage from "../src/pages/MaintenanceApplicationPage.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function draftFixture(
  overrides: Partial<MaintenanceApplicationDto> = {}
): MaintenanceApplicationDto {
  return {
    id: "app-1",
    type: "MAINTENANCE",
    status: "DRAFT",
    ownerId: "self",
    ownerDisplayName: "使用者一",
    createdById: "self",
    onBehalf: false,
    primaryDate: "2026-03-01",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    lastMaintenanceDate: null,
    currentMaintenanceDate: null,
    lastOdometerKm: null,
    currentOdometerKm: null,
    actualCost: null,
    attachments: [],
    completionBlockers: [
      {
        code: "LAST_MAINTENANCE_DATE_REQUIRED",
        field: "lastMaintenanceDate",
        message: "請填寫上次保養日期",
      },
      {
        code: "CURRENT_MAINTENANCE_DATE_REQUIRED",
        field: "currentMaintenanceDate",
        message: "請填寫本次保養日期",
      },
      { code: "LAST_ODOMETER_REQUIRED", field: "lastOdometerKm", message: "請填寫上次里程表數值" },
      {
        code: "CURRENT_ODOMETER_REQUIRED",
        field: "currentOdometerKm",
        message: "請填寫本次里程表數值",
      },
      { code: "ACTUAL_COST_REQUIRED", field: "actualCost", message: "請填寫本次實際保養費用" },
      { code: "MAINTENANCE_ATTACHMENT_REQUIRED", message: "請至少上傳 1 張保養證明" },
    ],
    computed: null,
    snapshot: null,
    ...overrides,
  };
}

function filledDraftFixture(
  overrides: Partial<MaintenanceApplicationDto> = {}
): MaintenanceApplicationDto {
  return draftFixture({
    lastMaintenanceDate: "2026-01-01",
    currentMaintenanceDate: "2026-02-01",
    lastOdometerKm: "1000.00",
    currentOdometerKm: "1100.00",
    actualCost: "2000.00",
    completionBlockers: [
      { code: "MAINTENANCE_ATTACHMENT_REQUIRED", message: "請至少上傳 1 張保養證明" },
    ],
    ...overrides,
  });
}

function previewFixture(overrides: Partial<MaintenanceComputedDto> = {}): MaintenanceComputedDto {
  return {
    calculable: true,
    intervalKm: "100.00",
    officialKm: "50.00",
    officialApplicationCount: 2,
    ratio: "0.500000",
    ratioPercent: "50.0000",
    rawAmount: "999.0000",
    amount: 999,
    blockingCodes: [],
    ...overrides,
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// URL/method-routed fetch mock
// ---------------------------------------------------------------------------

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function installFetchRouter() {
  const calls: { method: string; path: string; body?: string }[] = [];
  const routes: Array<{ method: string; test: (path: string) => boolean; handler: Handler }> = [];

  (fetch as Mock).mockImplementation(async (input: unknown, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : String(input);
    const url = new URL(urlStr, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path: url.pathname, body: init?.body as string | undefined });
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
    lastBody(method: string, test: (path: string) => boolean): Record<string, unknown> | null {
      const match = [...calls].reverse().find((c) => c.method === method && test(c.path));
      return match?.body ? JSON.parse(match.body) : null;
    },
  };
}

function renderPage(id = "app-1") {
  return render(
    <MemoryRouter initialEntries={[`/applications/maintenance/${id}`]}>
      <Routes>
        <Route path="/applications/maintenance/:id" element={<MaintenanceApplicationPage />} />
        <Route path="/" element={<div>首頁占位</div>} />
      </Routes>
    </MemoryRouter>
  );
}

async function sleep(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const isGetDraft = (p: string) => p === "/api/applications/maintenance/app-1";
const isPutDraft = (p: string) => p === "/api/applications/maintenance/app-1";
const isCreate = (p: string) => p === "/api/applications/maintenance";
const isPreview = (p: string) => p === "/api/applications/maintenance/preview";
const isComplete = (p: string) => p === "/api/applications/app-1/complete";
const isDelete = (p: string) => p === "/api/applications/app-1";

describe("MaintenanceApplicationPage", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // 五態 — 表單
  // ===========================================================================

  it("Loading：讀取草稿中顯示載入中", () => {
    (fetch as Mock).mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText("讀取草稿中…")).toBeInTheDocument();
  });

  it("/new：先顯示建立草稿中，再導向 /applications/maintenance/:id", async () => {
    const router = installFetchRouter();
    router.on("POST", isCreate, () => jsonRes({ application: draftFixture() }, 201));
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    render(
      <MemoryRouter initialEntries={["/applications/maintenance/new"]}>
        <Routes>
          <Route path="/applications/maintenance/:id" element={<MaintenanceApplicationPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("建立草稿中…")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "保養費用申請（草稿）" })).toBeInTheDocument();
    });
  });

  it("Empty：新建立之草稿五欄皆空，且顯示尚未完成項目清單", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("上次保養日期")).toHaveValue("");
    });
    expect(screen.getByLabelText("本次保養日期")).toHaveValue("");
    expect(screen.getByLabelText("上次里程表")).toHaveValue(null);
    expect(screen.getByLabelText("本次里程表")).toHaveValue(null);
    expect(screen.getByLabelText("本次實際保養費用")).toHaveValue(null);
    expect(screen.getByText("請填寫上次保養日期")).toBeInTheDocument();
    expect(screen.getByText("請至少上傳 1 張保養證明")).toBeInTheDocument();
    // 預覽 Empty（非錯誤）
    expect(screen.getByText("請先填寫上次／本次保養日期與里程表")).toBeInTheDocument();
  });

  it("Error（5xx）：讀取失敗顯示 zh-TW 訊息並可重試", async () => {
    const router = installFetchRouter();
    let getCount = 0;
    router.on("GET", isGetDraft, () => {
      getCount += 1;
      if (getCount === 1) {
        return jsonRes(
          { error: { code: "INTERNAL_ERROR", message: "系統發生錯誤，請稍後再試" } },
          500
        );
      }
      return jsonRes({ application: draftFixture() });
    });
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("系統發生錯誤，請稍後再試")).toBeInTheDocument();
    });

    screen.getByRole("button", { name: "重試" }).click();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "保養費用申請（草稿）" })).toBeInTheDocument();
    });
  });

  it("Permission denied：非擁有人 403 → 顯示無權存取，且從未呼叫任何寫入 API（零呼叫）", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () =>
      jsonRes({ error: { code: "FORBIDDEN", message: "無權存取" } }, 403)
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("無權存取此資源")).toBeInTheDocument();
    });

    expect(router.countCalls("POST", isCreate)).toBe(0);
    expect(router.countCalls("PUT", isPutDraft)).toBe(0);
    expect(router.countCalls("POST", isPreview)).toBe(0);
    expect(router.countCalls("POST", isComplete)).toBe(0);
    expect(router.countCalls("DELETE", isDelete)).toBe(0);
  });

  // ===========================================================================
  // AC-34：五欄逐字標籤、部分欄位儲存、400 fields[] 就地標示
  // ===========================================================================

  it("AC-34：提供五個欄位（逐字標籤）", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("上次保養日期")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("本次保養日期")).toBeInTheDocument();
    expect(screen.getByLabelText("上次里程表")).toBeInTheDocument();
    expect(screen.getByLabelText("本次里程表")).toBeInTheDocument();
    expect(screen.getByLabelText("本次實際保養費用")).toBeInTheDocument();
  });

  it("AC-34：僅填部分欄位（本次實際保養費用）仍可「儲存草稿」成功", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
    router.on("PUT", isPutDraft, () =>
      jsonRes({ application: draftFixture({ actualCost: "500.00" }) })
    );

    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("本次實際保養費用")).toBeInTheDocument();
    });

    const { fireEvent } = await import("@testing-library/react");
    const costInput = screen.getByLabelText("本次實際保養費用");
    fireEvent.change(costInput, { target: { value: "500" } });

    fireEvent.click(screen.getByRole("button", { name: "儲存草稿" }));

    await waitFor(() => {
      expect(screen.getByText("草稿已儲存。")).toBeInTheDocument();
    });

    const body = router.lastBody("PUT", isPutDraft);
    expect(body).toEqual({
      lastMaintenanceDate: null,
      currentMaintenanceDate: null,
      lastOdometerKm: null,
      currentOdometerKm: null,
      actualCost: "500",
    });
  });

  it("AC-34：後端 400 之 fields[] 就地標示於對應欄位", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
    router.on("PUT", isPutDraft, () =>
      jsonRes(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "輸入資料有誤，請檢查標示欄位。",
            fields: [{ field: "actualCost", reason: "本次實際保養費用格式錯誤" }],
          },
        },
        400
      )
    );

    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("本次實際保養費用")).toBeInTheDocument();
    });

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(screen.getByRole("button", { name: "儲存草稿" }));

    await waitFor(() => {
      expect(screen.getByText("本次實際保養費用格式錯誤")).toBeInTheDocument();
    });
    const input = screen.getByLabelText("本次實際保養費用");
    expect(input).toHaveAttribute("aria-describedby", "actual-cost-err");
  });

  // ===========================================================================
  // AC-35：預覽四值、零自算鑑別、比例 > 100% 阻擋、不可計算不顯示 0
  // ===========================================================================

  it("AC-35：不自算金額鑑別力——畫面顯示的四值即為 mock 之後端回應值", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
    router.on("POST", isPreview, () =>
      jsonRes({
        preview: previewFixture({
          intervalKm: "100.00",
          officialKm: "50.00",
          ratioPercent: "50.0000",
          amount: 999,
        }),
      })
    );

    renderPage();

    await sleep(350);

    await waitFor(() => {
      expect(screen.getByText("999")).toBeInTheDocument();
    });
    expect(screen.getByText("100.00")).toBeInTheDocument();
    expect(screen.getByText("50.00")).toBeInTheDocument();
    expect(screen.getByText("50.0000%")).toBeInTheDocument();
  });

  it("AC-35：比例 > 100%（OFFICIAL_KM_EXCEEDS_INTERVAL）→ 顯示錯誤訊息並使「完成申請」不可用", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
    router.on("POST", isPreview, () =>
      jsonRes({
        preview: previewFixture({
          calculable: false,
          intervalKm: "10.00",
          officialKm: "20.00",
          ratio: null,
          ratioPercent: null,
          rawAmount: null,
          amount: null,
          blockingCodes: ["OFFICIAL_KM_EXCEEDS_INTERVAL"],
        }),
      })
    );

    renderPage();
    await sleep(350);

    await waitFor(() => {
      expect(
        screen.getByText("期間公務里程大於保養區間里程，請檢查差旅、日期或里程資料")
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "完成申請" })).toBeDisabled();
  });

  it("AC-35：不可計算狀態（欄位齊備但超出容量）不得顯示金額 0，須顯示「無法計算」＋zh-TW 說明", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
    router.on("POST", isPreview, () =>
      jsonRes({
        preview: previewFixture({
          calculable: false,
          intervalKm: "100.00",
          officialKm: "50.00",
          ratio: null,
          ratioPercent: null,
          rawAmount: null,
          amount: null,
          blockingCodes: ["AMOUNT_OUT_OF_RANGE"],
        }),
      })
    );

    renderPage();
    await sleep(350);

    await waitFor(() => {
      expect(screen.getByText("公司分攤金額：無法計算")).toBeInTheDocument();
    });
    expect(screen.getByText("計算結果超出可儲存之金額範圍，請檢查里程與費用")).toBeInTheDocument();
    // 不得以「0」呈現最終分攤金額
    expect(screen.queryByText("公司分攤金額")).not.toBeInTheDocument();
  });

  it("AC-35：五欄未齊（Empty，非錯誤）→ 顯示提示文字而非任何錯誤或金額 0", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () =>
      jsonRes({
        preview: previewFixture({
          calculable: false,
          intervalKm: null,
          officialKm: null,
          ratio: null,
          ratioPercent: null,
          rawAmount: null,
          amount: null,
          blockingCodes: [
            "LAST_MAINTENANCE_DATE_REQUIRED",
            "CURRENT_MAINTENANCE_DATE_REQUIRED",
            "LAST_ODOMETER_REQUIRED",
            "CURRENT_ODOMETER_REQUIRED",
            "ACTUAL_COST_REQUIRED",
          ],
        }),
      })
    );

    renderPage();
    await waitFor(() => {
      expect(screen.getByText("請先填寫上次／本次保養日期與里程表")).toBeInTheDocument();
    });
    expect(screen.queryByText("公司分攤金額：無法計算")).not.toBeInTheDocument();
  });

  // ===========================================================================
  // 預覽五態
  // ===========================================================================

  it("預覽 Loading：計算中", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
    router.on("POST", isPreview, () => new Promise(() => {}));

    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("本次實際保養費用")).toHaveValue(2000);
    });
    await sleep(310);
    expect(screen.getByText("計算中…")).toBeInTheDocument();
  });

  it("預覽 Error（5xx）：顯示 zh-TW 訊息", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
    router.on("POST", isPreview, () =>
      jsonRes({ error: { code: "INTERNAL_ERROR", message: "預覽計算失敗，請稍後再試" } }, 500)
    );

    renderPage();
    await sleep(350);

    await waitFor(() => {
      expect(screen.getByText("預覽計算失敗，請稍後再試")).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // 已完成（COMPLETED）唯讀檢視
  // ===========================================================================

  it("COMPLETED：唯讀顯示快照四值＋實際費用，且無任何編輯/儲存/完成/刪除操作", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () =>
      jsonRes({
        application: draftFixture({
          status: "COMPLETED",
          lastMaintenanceDate: "2026-01-01",
          currentMaintenanceDate: "2026-02-01",
          lastOdometerKm: "1000.00",
          currentOdometerKm: "1100.00",
          actualCost: "2000.00",
          completionBlockers: null,
          computed: null,
          snapshot: {
            intervalKm: "100.00",
            officialKm: "50.00",
            ratio: "0.500000",
            ratioPercent: "50.0000",
            actualCost: "2000.00",
            rawAmount: "1000.0000",
            totalAmount: 1000,
            calculatedAt: "2026-02-01T00:00:00.000Z",
          },
        }),
      })
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "保養費用申請（已完成）" })).toBeInTheDocument();
    });
    expect(screen.getByText("100.00")).toBeInTheDocument();
    expect(screen.getByText("50.00")).toBeInTheDocument();
    expect(screen.getByText("50.0000%")).toBeInTheDocument();
    expect(screen.getByText("1000")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "儲存草稿" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "完成申請" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刪除草稿" })).not.toBeInTheDocument();
  });

  // ===========================================================================
  // 完成／刪除確認（沿用既有 C4 慣例）
  // ===========================================================================

  it("完成申請：dirty 時確認框顯示「有未儲存的變更，請先儲存草稿」且確認鈕停用", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("本次實際保養費用")).toHaveValue(2000);
    });

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(screen.getByLabelText("本次實際保養費用"), { target: { value: "2500" } });
    fireEvent.click(screen.getByRole("button", { name: "完成申請" }));

    await waitFor(() => {
      expect(screen.getByText("有未儲存的變更，請先儲存草稿")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "確認完成" })).toBeDisabled();
  });

  it("完成申請成功：呼叫 POST /applications/:id/complete 並顯示已完成畫面", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
    router.on("POST", isComplete, () =>
      jsonRes({
        application: filledDraftFixture({
          status: "COMPLETED",
          completionBlockers: null,
          computed: null,
          snapshot: {
            intervalKm: "100.00",
            officialKm: "50.00",
            ratio: "0.500000",
            ratioPercent: "50.0000",
            actualCost: "2000.00",
            rawAmount: "1000.0000",
            totalAmount: 1000,
            calculatedAt: "2026-02-01T00:00:00.000Z",
          },
        }),
      })
    );

    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("本次實際保養費用")).toHaveValue(2000);
    });

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(screen.getByRole("button", { name: "完成申請" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "確認完成" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "確認完成" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "保養費用申請（已完成）" })).toBeInTheDocument();
    });
    expect(router.countCalls("POST", isComplete)).toBe(1);
  });

  it("刪除草稿：需二次確認後呼叫 DELETE /applications/:id 並導向首頁", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
    router.on("DELETE", isDelete, () => jsonRes({ ok: true }));

    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "刪除草稿" })).toBeInTheDocument();
    });

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(screen.getByRole("button", { name: "刪除草稿" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "確認刪除" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "確認刪除" }));

    await waitFor(() => {
      expect(screen.getByText("首頁占位")).toBeInTheDocument();
    });
    expect(router.countCalls("DELETE", isDelete)).toBe(1);
  });
});
