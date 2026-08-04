/**
 * DepreciationApplicationPage 前端單元測試 — PHASE-007-T13
 *
 * 涵蓋 AC-38（表單僅提供申請年度一項可輸入欄位；年度公務里程無任何可輸入／
 * 覆寫欄位之負向斷言）、AC-39（預覽顯示折舊每公里單價／年度公務里程／
 * 取整後金額，直取後端；前端零自算鑑別；車價／折舊年限／預估年度行駛公里
 * 數三推導值於任何狀態下皆不出現之負向斷言）、AC-41（缺參數時顯示聯絡管理
 * 員文案並停用「完成申請」，仍允許儲存草稿）。
 *
 * 採用 URL/method 路由式 fetch mock（比照 MaintenanceApplicationPage.test.tsx
 * 既有慣例）——本頁掛載後會自動觸發一次 debounced 預覽請求，佇列式 mock 容易
 * 被插隊而錯位。
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type {
  DepreciationApplicationDto,
  DepreciationComputedDto,
} from "../src/api/depreciation.js";
import DepreciationApplicationPage from "../src/pages/DepreciationApplicationPage.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function draftFixture(
  overrides: Partial<DepreciationApplicationDto> = {}
): DepreciationApplicationDto {
  return {
    id: "app-1",
    type: "DEPRECIATION",
    status: "DRAFT",
    ownerId: "self",
    ownerDisplayName: "使用者一",
    createdById: "self",
    onBehalf: false,
    primaryDate: "2026-03-01",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    applicationYear: null,
    duplicateYearNotice: null,
    attachments: [],
    completionBlockers: [
      { code: "YEAR_REQUIRED", field: "applicationYear", message: "請選擇申請年度" },
      { code: "DEPRECIATION_ATTACHMENT_REQUIRED", message: "請至少上傳 1 張折舊證明" },
    ],
    computed: null,
    snapshot: null,
    ...overrides,
  };
}

// 已填年度、已有證明（fixture 直接注入，本 Task 不掛載上傳 UI）之草稿——供
// AC-41「僅缺參數」情境使用：唯一 blocker 為 PARAMETER_NOT_AVAILABLE。
function filledDraftFixture(
  overrides: Partial<DepreciationApplicationDto> = {}
): DepreciationApplicationDto {
  return draftFixture({
    applicationYear: 2025,
    completionBlockers: [],
    ...overrides,
  });
}

function previewFixture(overrides: Partial<DepreciationComputedDto> = {}): DepreciationComputedDto {
  return {
    calculable: true,
    officialKm: "500.00",
    officialApplicationCount: 3,
    perKmUnitPrice: "1.1111",
    rawAmount: "555.5500",
    amount: 556,
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
    <MemoryRouter initialEntries={[`/applications/depreciation/${id}`]}>
      <Routes>
        <Route path="/applications/depreciation/:id" element={<DepreciationApplicationPage />} />
        <Route path="/" element={<div>首頁占位</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const isGetDraft = (p: string) => p === "/api/applications/depreciation/app-1";
const isPutDraft = (p: string) => p === "/api/applications/depreciation/app-1";
const isCreate = (p: string) => p === "/api/applications/depreciation";
const isPreview = (p: string) => p === "/api/applications/depreciation/preview";
const isComplete = (p: string) => p === "/api/applications/app-1/complete";

describe("DepreciationApplicationPage", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // 基本骨架（Loading／Permission denied）——完整五態覆蓋屬 T14（AC-40）。
  // ===========================================================================

  it("Loading：讀取草稿中顯示載入中", () => {
    (fetch as Mock).mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText("讀取草稿中…")).toBeInTheDocument();
  });

  it("Permission denied：403 時顯示無權訊息，且不再送出任何寫入呼叫", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () =>
      jsonRes({ error: { code: "FORBIDDEN", message: "無權存取此資源" } }, 403)
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("無權存取此資源")).toBeInTheDocument();
    });
    expect(router.countCalls("POST", isPreview)).toBe(0);
    expect(router.countCalls("PUT", isPutDraft)).toBe(0);
  });

  // ===========================================================================
  // AC-38：表單僅提供「申請年度」一項可輸入欄位；年度公務里程無任何可輸入／
  // 覆寫欄位。
  // ===========================================================================

  it("AC-38：表單僅有申請年度一個可輸入欄位（逐字標籤）", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture({ calculable: false }) }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("申請年度")).toBeInTheDocument();
    });

    // 全頁僅有一個 <input>（申請年度），不存在任何名稱／標籤含「里程」之
    // 輸入欄位——年度公務里程恆為後端唯讀計算值。
    const inputs = screen.getAllByRole("spinbutton");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toHaveAttribute("id", "application-year");

    expect(screen.queryByLabelText(/里程/)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("AC-38：年度可為空值儲存（null 為合法值，前端轉為 JSON number｜null）", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture({ calculable: false }) }));
    router.on("PUT", isPutDraft, () => jsonRes({ application: draftFixture() }));

    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("申請年度")).toHaveValue(null);
    });

    screen.getByText("儲存草稿").click();

    await waitFor(() => {
      expect(router.countCalls("PUT", isPutDraft)).toBe(1);
    });
    const body = router.lastBody("PUT", isPutDraft);
    expect(body).toEqual({ applicationYear: null });
  });

  it("AC-38：填入年度後以 JSON number（非字串）送出", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture({ calculable: false }) }));
    router.on("PUT", isPutDraft, () => jsonRes({ application: filledDraftFixture() }));

    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("申請年度")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("申請年度"), { target: { value: "2025" } });

    screen.getByText("儲存草稿").click();

    await waitFor(() => {
      expect(router.countCalls("PUT", isPutDraft)).toBe(1);
    });
    const body = router.lastBody("PUT", isPutDraft);
    expect(body).toEqual({ applicationYear: 2025 });
    expect(typeof body?.applicationYear).toBe("number");
  });

  // ===========================================================================
  // AC-39：預覽直取後端；前端零自算鑑別；三推導值絕不出現。
  // ===========================================================================

  it("AC-39：預覽顯示折舊每公里單價／年度公務里程／年度補貼金額，逐字取自後端回應", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("500.00 公里")).toBeInTheDocument();
    });
    expect(screen.getByText("1.1111")).toBeInTheDocument();
    expect(screen.getByText("556")).toBeInTheDocument();
  });

  it("AC-39：前端零自算鑑別——mock 之 amount 與 officialKm×perKmUnitPrice 刻意不符，畫面仍顯示 mock 值", async () => {
    // 500.00 × 1.1111 = 555.55（四捨五入為 556）；此處刻意回傳一個算術上
    // 不可能由此二值推得的 amount（99999），若前端曾自行相乘取整，畫面會顯示
    // 556 而非 99999——本測試鎖定「前端從不自算」。
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
    router.on("POST", isPreview, () =>
      jsonRes({
        preview: previewFixture({
          officialKm: "500.00",
          perKmUnitPrice: "1.1111",
          amount: 99999,
        }),
      })
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("99999")).toBeInTheDocument();
    });
    expect(screen.queryByText("556")).not.toBeInTheDocument();
  });

  it("AC-39：車價／折舊年限／預估年度行駛公里數三推導值於草稿頁不出現", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    renderPage();
    await waitFor(() => {
      expect(screen.getByText("500.00 公里")).toBeInTheDocument();
    });

    expect(screen.queryByText(/車價/)).not.toBeInTheDocument();
    expect(screen.queryByText(/折舊年限/)).not.toBeInTheDocument();
    expect(screen.queryByText(/預估年度行駛公里數/)).not.toBeInTheDocument();
  });

  it("AC-39：不可計算時不得顯示金額 0，須顯示「無法計算」＋zh-TW 說明", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
    router.on("POST", isPreview, () =>
      jsonRes({
        preview: previewFixture({
          calculable: false,
          perKmUnitPrice: null,
          rawAmount: null,
          amount: null,
          blockingCodes: ["PARAMETER_NOT_AVAILABLE"],
        }),
      })
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("年度補貼金額：無法計算")).toBeInTheDocument();
    });
    expect(screen.getByText("該年度尚無有效折舊參數，請聯絡管理員設定")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("車價／折舊年限／預估年度行駛公里數三推導值於已完成頁亦不出現", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () =>
      jsonRes({
        application: draftFixture({
          status: "COMPLETED",
          applicationYear: 2025,
          completionBlockers: null,
          computed: null,
          snapshot: {
            officialKm: "500.00",
            perKmUnitPrice: "1.1111",
            rawAmount: "555.5500",
            totalAmount: 556,
            calculatedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      })
    );

    renderPage();
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "年度折舊補貼申請（已完成）" })
      ).toBeInTheDocument();
    });

    expect(screen.getByText("556")).toBeInTheDocument();
    expect(screen.queryByText(/車價/)).not.toBeInTheDocument();
    expect(screen.queryByText(/折舊年限/)).not.toBeInTheDocument();
    expect(screen.queryByText(/預估年度行駛公里數/)).not.toBeInTheDocument();
  });

  // ===========================================================================
  // AC-41：缺參數顯示聯絡管理員文案並停用完成，仍允許儲存草稿。
  // ===========================================================================

  it("AC-41：缺參數時顯示聯絡管理員文案、停用「完成申請」，但「儲存草稿」仍可用", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () =>
      jsonRes({
        application: filledDraftFixture({
          completionBlockers: [
            {
              code: "PARAMETER_NOT_AVAILABLE",
              message: "該年度尚無有效折舊參數，請聯絡管理員設定",
            },
          ],
        }),
      })
    );
    router.on("POST", isPreview, () =>
      jsonRes({
        preview: previewFixture({
          calculable: false,
          perKmUnitPrice: null,
          rawAmount: null,
          amount: null,
          blockingCodes: ["PARAMETER_NOT_AVAILABLE"],
        }),
      })
    );

    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText(
          "該年度尚無有效折舊參數，請聯絡管理員設定折舊參數後再完成申請。草稿仍可正常儲存。"
        )
      ).toBeInTheDocument();
    });

    const completeBtn = screen.getByText("完成申請");
    expect(completeBtn).toBeDisabled();

    const saveBtn = screen.getByText("儲存草稿");
    expect(saveBtn).not.toBeDisabled();
  });

  it("AC-41：條件齊備（無 blocker）時「完成申請」鈕可用，點擊後呼叫完成端點", async () => {
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
            officialKm: "500.00",
            perKmUnitPrice: "1.1111",
            rawAmount: "555.5500",
            totalAmount: 556,
            calculatedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      })
    );

    renderPage();
    await waitFor(() => {
      expect(screen.getByText("完成申請")).not.toBeDisabled();
    });

    screen.getByText("完成申請").click();
    await waitFor(() => {
      expect(screen.getByLabelText("確認完成申請")).toBeInTheDocument();
    });
    screen.getByText("確認完成").click();

    await waitFor(() => {
      expect(router.countCalls("POST", isComplete)).toBe(1);
    });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "年度折舊補貼申請（已完成）" })
      ).toBeInTheDocument();
    });
  });
});
