/**
 * TravelApplicationPage 前端單元測試 — PHASE-004-T13
 *
 * 涵蓋：五態、建立草稿導向、多段增刪、里程欄位純格式提示（D7c）、
 * 預覽 debounce 300ms（D8）、不自算金額鑑別力（D7/C1）、D6 單價未外洩
 * 鑑別力、儲存防重複提交、刪除/完成確認（C4）、已完成唯讀檢視。
 *
 * 採用 URL/method 路由式 fetch mock（而非位置性 mockResolvedValueOnce 佇列），
 * 因為本頁在掛載後會自動觸發一次 debounced 預覽請求，加上使用者互動觸發的
 * 請求，佇列式 mock 很容易因順序被自動預覽請求插隊而錯位。
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type {
  TravelApplicationDto,
  TravelComputedDto,
  VoidInfoDto,
} from "../src/api/applications.js";
import TravelApplicationPage from "../src/pages/TravelApplicationPage.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function draftFixture(overrides: Partial<TravelApplicationDto> = {}): TravelApplicationDto {
  return {
    id: "app-1",
    type: "TRAVEL",
    status: "DRAFT",
    ownerId: "self",
    ownerDisplayName: "使用者一",
    createdById: "self",
    createdByDisplayName: "使用者一",
    onBehalf: false,
    tripDate: null,
    purpose: null,
    segments: [],
    completionBlockers: [
      { code: "TRIP_DATE_REQUIRED", field: "tripDate", message: "請填寫出差日期" },
    ],
    computed: null,
    snapshot: null,
    void: null, // PHASE-009 §7.2：未作廢恆為 null
    // PHASE-009 §7.2（T16）：版本關聯之雙向投影；無關聯恆為 null。
    supersedes: null,
    supersededBy: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PHASE-009-T15 fixtures（作廢面）
// ---------------------------------------------------------------------------

function voidInfoFixture(overrides: Partial<VoidInfoDto> = {}): VoidInfoDto {
  return {
    reason: "里程填寫錯誤，需重新申報",
    voidedAt: "2026-03-05T02:34:56.000Z",
    voidedByDisplayName: "管理員甲",
    ...overrides,
  };
}

function completedFixture(overrides: Partial<TravelApplicationDto> = {}): TravelApplicationDto {
  return draftFixture({
    status: "COMPLETED",
    tripDate: "2026-03-01",
    purpose: "台中出差",
    completionBlockers: [],
    computed: null,
    completedAt: "2026-03-02T00:00:00.000Z",
    snapshot: {
      fuelUnitPrice: "5.0000",
      etcUnitPrice: "3.0000",
      fuelParameterVersionId: "fv-1",
      etcParameterVersionId: "ev-1",
      fuelPriceVersionId: null,
      fuelConsumptionVersionId: null,
      totalKm: "0.00",
      totalRawAmount: "0.0000",
      totalAmount: 0,
      calculatedAt: "2026-03-02T00:00:00.000Z",
    },
    ...overrides,
  });
}

/**
 * 已作廢之詳情 fixture。`snapshot: null` 為**後端實況**（實查
 * `backend/src/applications/travel-service.ts` :1799 之
 * `application.status === "COMPLETED" && …` 守門；保養／折舊之
 * `buildSnapshotDto` 亦同——三型對稱），故唯讀頁之快照區在 VOIDED 下不渲染。
 */
function voidedFixture(overrides: Partial<TravelApplicationDto> = {}): TravelApplicationDto {
  return completedFixture({
    status: "VOIDED",
    snapshot: null,
    void: voidInfoFixture(),
    ...overrides,
  });
}

/**
 * 讀取 `<dl className="detail-list">` 中指定 `<dt>` 緊鄰之 `<dd>` 文字（沿
 * DepreciationApplicationPage.test.tsx 既有 `dtDdText` 慣例）——將值與其標籤
 * 綁定比對，可鑑別「三項作廢資訊 dt/dd 配對互換」之錯置 mutant。
 */
function dtDdText(dtLabel: string): string | null {
  const dt = screen.getByText(dtLabel, { selector: "dt" });
  return dt.nextElementSibling?.textContent ?? null;
}

function previewFixture(overrides: Partial<TravelComputedDto> = {}): TravelComputedDto {
  return {
    parameterAvailable: true,
    missingParameters: [],
    totalKm: "0.00",
    segments: [],
    totalRawAmount: "0.0000",
    totalAmount: 0,
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
    reset() {
      calls.length = 0;
    },
  };
}

function renderPage(id = "app-1") {
  return render(
    <MemoryRouter initialEntries={[`/applications/travel/${id}`]}>
      <Routes>
        <Route path="/applications/travel/:id" element={<TravelApplicationPage />} />
        <Route path="/" element={<div>首頁占位</div>} />
      </Routes>
    </MemoryRouter>
  );
}

/** Real-timer wait, wrapped in `act` so state updates from the debounce
 * timer / fetch resolution flush before the next assertion (avoids benign
 * but noisy "not wrapped in act" warnings). */
async function sleep(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const isPreview = (p: string) => p === "/api/applications/travel/preview";
const isGetDraft = (p: string) => p === "/api/applications/travel/app-1";
const isPutDraft = (p: string) => p === "/api/applications/travel/app-1";
const isComplete = (p: string) => p === "/api/applications/app-1/complete";
const isDelete = (p: string) => p === "/api/applications/app-1";
const isGetReport = (p: string) => p === "/api/applications/app-1/report";
const isVoid = (p: string) => p === "/api/applications/app-1/void";

/** AC-31(c)／FE-US-26⑤：任何「把已作廢恢復為已完成」語意之控制項字樣。 */
const RESTORE_CONTROL_PATTERN = /恢復|還原|復原|取消作廢|重新完成|解除作廢/;

/** 唯讀頁不得出現之五類按鈕（AC-31(b) 逐一負向）。 */
const FORBIDDEN_VOIDED_BUTTONS = ["儲存草稿", "完成申請", "刪除草稿", "作廢", "建立修正版"];

/**
 * AC-31(b)(c)：唯讀頁零寫入型控制項。逐一具名負向（五類）＋全頁掃描
 * （避免「換個字樣就繞過具名斷言」）。「下載 PDF（作廢版）」等唯讀入口
 * 含「作廢」二字但非作廢入口，故以全等比對而非包含比對排除。
 */
function expectNoWriteControls(): void {
  for (const name of FORBIDDEN_VOIDED_BUTTONS) {
    expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  }
  const controls = [...screen.queryAllByRole("button"), ...screen.queryAllByRole("link")];
  for (const el of controls) {
    const label = el.textContent ?? "";
    expect(label).not.toMatch(/儲存|完成申請|刪除|建立修正版/);
    expect(label).not.toMatch(RESTORE_CONTROL_PATTERN);
    expect(label).not.toBe("作廢");
  }
}

describe("TravelApplicationPage", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Loading ----
  it("Loading：讀取草稿中顯示載入中", () => {
    (fetch as Mock).mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText("讀取草稿中…")).toBeInTheDocument();
  });

  it("/new：先顯示建立草稿中，再導向 /applications/travel/:id", async () => {
    const router = installFetchRouter();
    router.on(
      "POST",
      (p) => p === "/api/applications/travel",
      () => jsonRes({ application: draftFixture() }, 201)
    );
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    render(
      <MemoryRouter initialEntries={["/applications/travel/new"]}>
        <Routes>
          {/* Single :id route (matches App.tsx's actual routing — a separate
              static "/new" route would shadow the :id param, see App.tsx). */}
          <Route path="/applications/travel/:id" element={<TravelApplicationPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("建立草稿中…")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByLabelText("出差日期")).toBeInTheDocument();
    });
  });

  // ---- Error ----
  it("Error：載入失敗顯示錯誤訊息 + 重試", async () => {
    const router = installFetchRouter();
    let attempt = 0;
    router.on("GET", isGetDraft, () => {
      attempt += 1;
      if (attempt === 1)
        return jsonRes({ error: { code: "INTERNAL_ERROR", message: "系統錯誤" } }, 500);
      return jsonRes({ application: draftFixture() });
    });
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("系統錯誤");
    });

    fireEvent.click(screen.getByRole("button", { name: "重試" }));

    await waitFor(() => {
      expect(screen.getByLabelText("出差日期")).toBeInTheDocument();
    });
  });

  // ---- Permission denied ----
  it("Permission denied：403 顯示無權存取此資源", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () =>
      jsonRes({ error: { code: "FORBIDDEN", message: "無權存取" } }, 403)
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("無權存取此資源")).toBeInTheDocument();
    });
  });

  // ---- Not found ----
  it("找不到申請：404 顯示找不到指定的申請", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () =>
      jsonRes({ error: { code: "NOT_FOUND", message: "找不到" } }, 404)
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("找不到指定的申請。")).toBeInTheDocument();
    });
  });

  // ---- Success: draft form, completionBlockers shown as-is (D7) ----
  it("Success：草稿表單顯示欄位與後端 completionBlockers（D7 後端權威）", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("出差日期")).toBeInTheDocument();
      expect(screen.getByLabelText("出差目的")).toBeInTheDocument();
      expect(screen.getByText("請填寫出差日期")).toBeInTheDocument(); // 照實顯示後端 blocker
    });
  });

  // ---- Segments: add / remove (with confirm) ----
  it("新增行程段 → 出現獨立區塊；移除行程段需二次確認（C4）", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    renderPage();
    await waitFor(() => expect(screen.getByLabelText("出差日期")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "新增行程段" }));
    expect(screen.getByText("第 1 段")).toBeInTheDocument();
    expect(screen.getByLabelText("出發地點")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "移除此段" }));
    expect(screen.getByRole("dialog", { name: "確認移除行程段" })).toBeInTheDocument();

    // 取消 → 段落仍在
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByText("第 1 段")).toBeInTheDocument();

    // 再次移除並確認 → 段落消失
    fireEvent.click(screen.getByRole("button", { name: "移除此段" }));
    fireEvent.click(screen.getByRole("button", { name: "確認移除" }));
    expect(screen.queryByText("第 1 段")).not.toBeInTheDocument();
  });

  // ---- Field-level format hints (D7c, pure format only) ----
  it("里程欄位純格式提示：總里程 ≤0、高速里程超過總里程（D7c）", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    renderPage();
    await waitFor(() => expect(screen.getByLabelText("出差日期")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "新增行程段" }));

    fireEvent.change(screen.getByLabelText("總里程（公里）"), { target: { value: "0" } });
    expect(screen.getByText("總里程需大於 0")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("總里程（公里）"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("高速里程（公里）"), { target: { value: "20" } });
    expect(screen.getByText("高速里程不可超過總里程")).toBeInTheDocument();
  });

  // ---- D6 discriminating: draft view never shows unit price ----
  it("D6 鑑別力：草稿頁面全文不含「單價」字樣", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () =>
      jsonRes({
        preview: previewFixture({
          totalAmount: 123,
          segments: [
            {
              segmentId: null,
              segmentIndex: 0,
              fuelAmount: "1.0000",
              etcAmount: "2.0000",
              rawAmount: "3.0000",
              amount: 3,
            },
          ],
        }),
      })
    );

    const { container } = renderPage();
    await waitFor(() => expect(screen.getByLabelText("出差日期")).toBeInTheDocument());

    // Let the auto-triggered preview resolve too (debounce 300ms).
    await sleep(400);

    expect(container.textContent).not.toContain("單價");
  });

  // ---- No self-calc discriminating test (D7/C1): displayed amount is EXACTLY the mock ----
  it("不自算金額鑑別力：畫面顯示的金額即為 mock 之後端回應值", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () =>
      jsonRes({
        application: draftFixture({
          segments: [
            {
              id: "seg-1",
              sortOrder: 0,
              origin: "台北",
              destination: "台中",
              totalKm: "100.00",
              highwayKm: "80.00",
              attachments: [],
              snapshot: null,
            },
          ],
        }),
      })
    );
    // Deliberately implausible amount that would NOT match any naive frontend
    // arithmetic on totalKm/highwayKm (frontend has no unit price to compute
    // with at all — this proves the displayed number can only have come from
    // the backend response).
    router.on("POST", isPreview, () =>
      jsonRes({
        preview: previewFixture({
          totalAmount: 88888,
          totalKm: "100.00",
          segments: [
            {
              segmentId: "seg-1",
              segmentIndex: 0,
              fuelAmount: "11.1111",
              etcAmount: "22.2222",
              rawAmount: "33.3333",
              amount: 77777,
            },
          ],
        }),
      })
    );

    renderPage();
    // Origin/destination render as editable <input value> in DRAFT mode, not text nodes.
    await waitFor(() => expect(screen.getByDisplayValue("台北")).toBeInTheDocument());

    await waitFor(
      () => {
        expect(screen.getByText(/合計金額：88888/)).toBeInTheDocument();
        expect(screen.getByText("77777")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });

  // ---- AC-32（PHASE-005a-T11）：缺參數提示可區分 + 不可計算不得以 0 呈現 ----
  // D5(a) 再定向：`missingParameters` wire 值域由 "FUEL"|"ETC" 改為六碼
  // （FUEL_PRICE/FUEL_CONSUMPTION/ETC/FUEL_UNIT_PRICE_OUT_OF_RANGE/
  // FUEL_DATA_CORRUPTED/AMOUNT_OUT_OF_RANGE，§18 T8R 權威清單）。修正前之
  // `includes("FUEL")` 判斷恆為 false（wire 已無 "FUEL" 這個值）——下列四個
  // 測試皆會在修正前的邏輯下失敗（看不到任何缺參數提示文字），驗證本次修正
  // 確實接線正確的 wire 代碼。
  describe("缺參數提示（PHASE-005a）", () => {
    it("僅缺油耗 → 顯示「請聯絡管理員建立油耗資料」", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
      router.on("POST", isPreview, () =>
        jsonRes({
          preview: previewFixture({
            parameterAvailable: false,
            missingParameters: ["FUEL_CONSUMPTION"],
          }),
        })
      );

      renderPage();
      await waitFor(() => expect(screen.getByLabelText("出差日期")).toBeInTheDocument());
      await sleep(400);

      expect(screen.getByText("請聯絡管理員建立油耗資料")).toBeInTheDocument();
      expect(screen.queryByText("請聯絡管理員設定參數")).not.toBeInTheDocument();
    });

    it("僅缺油價 → 顯示「請聯絡管理員設定參數」", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
      router.on("POST", isPreview, () =>
        jsonRes({
          preview: previewFixture({
            parameterAvailable: false,
            missingParameters: ["FUEL_PRICE"],
          }),
        })
      );

      renderPage();
      await waitFor(() => expect(screen.getByLabelText("出差日期")).toBeInTheDocument());
      await sleep(400);

      expect(screen.getByText("請聯絡管理員設定參數")).toBeInTheDocument();
      expect(screen.queryByText("請聯絡管理員建立油耗資料")).not.toBeInTheDocument();
    });

    it("兩者皆缺 → 兩則訊息同時可見且逐字互異", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
      router.on("POST", isPreview, () =>
        jsonRes({
          preview: previewFixture({
            parameterAvailable: false,
            missingParameters: ["FUEL_CONSUMPTION", "FUEL_PRICE"],
          }),
        })
      );

      renderPage();
      await waitFor(() => expect(screen.getByLabelText("出差日期")).toBeInTheDocument());
      await sleep(400);

      const consumptionMsg = screen.getByText("請聯絡管理員建立油耗資料");
      const priceMsg = screen.getByText("請聯絡管理員設定參數");
      expect(consumptionMsg).toBeInTheDocument();
      expect(priceMsg).toBeInTheDocument();
      expect(consumptionMsg.textContent).not.toBe(priceMsg.textContent);
    });

    // ---- §11.3 不自算鑑別：mock 之 totalAmount/segments 皆為前端不可能自算出
    // 的implausible值——若前端曾自行計算或誤把 0 當最終值，本斷言必紅。 ----
    it("缺油資依據時預覽顯示「油資無法計算」而非金額 0", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: draftFixture({
            segments: [
              {
                id: "seg-1",
                sortOrder: 0,
                origin: "台北",
                destination: "台中",
                totalKm: "100.00",
                highwayKm: "0.00",
                attachments: [],
                snapshot: null,
              },
            ],
          }),
        })
      );
      router.on("POST", isPreview, () =>
        jsonRes({
          preview: previewFixture({
            parameterAvailable: false,
            missingParameters: ["FUEL_CONSUMPTION"],
            totalAmount: 0,
            totalKm: "100.00",
            segments: [
              {
                segmentId: "seg-1",
                segmentIndex: 0,
                fuelAmount: "0.0000",
                etcAmount: "0.0000",
                rawAmount: "0.0000",
                amount: 0,
              },
            ],
          }),
        })
      );

      renderPage();
      await waitFor(() => expect(screen.getByDisplayValue("台北")).toBeInTheDocument());
      await sleep(400);

      expect(screen.getAllByText("油資無法計算").length).toBeGreaterThan(0);
      expect(screen.queryByText(/合計金額：0/)).not.toBeInTheDocument();
      expect(screen.queryByText("0")).not.toBeInTheDocument();
    });

    // ---- 三個「不可計算」代碼各自之文案呈現（PROJECT_STATE T8R 移交 A-2）----
    it.each([
      ["FUEL_DATA_CORRUPTED" as const, "您的油耗資料異常，請聯絡管理員檢查"],
      [
        "FUEL_UNIT_PRICE_OUT_OF_RANGE" as const,
        "油價與油耗組合超出可計算範圍，請聯絡管理員檢查參數設定",
      ],
      ["AMOUNT_OUT_OF_RANGE" as const, "計算金額超出可儲存範圍，請聯絡管理員檢查里程與參數設定"],
    ])("不可計算代碼 %s → 顯示對應文案", async (code, expectedText) => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
      router.on("POST", isPreview, () =>
        jsonRes({
          preview: previewFixture({
            parameterAvailable: false,
            missingParameters: [code],
          }),
        })
      );

      renderPage();
      await waitFor(() => expect(screen.getByLabelText("出差日期")).toBeInTheDocument());
      await sleep(400);

      expect(screen.getByText(expectedText)).toBeInTheDocument();
    });

    // ---- 終審複審 SF-1 護欄：`FUEL_UNAVAILABLE_CODES`（油資無法計算之抑制
    // 清單）五碼全覆蓋——每碼皆須讓「油資無法計算」可見、且合計/段金額不得
    // 以 0 呈現為最終值（即便後端 totalAmount/amount 皆為 0）。mutant 實證：
    // 若清單漏掉任一碼（例如移除 AMOUNT_OUT_OF_RANGE），對應那一列必紅。----
    it.each([
      "FUEL_CONSUMPTION",
      "FUEL_PRICE",
      "FUEL_DATA_CORRUPTED",
      "FUEL_UNIT_PRICE_OUT_OF_RANGE",
      "AMOUNT_OUT_OF_RANGE",
    ] as const)(
      "油資無法計算抑制清單覆蓋 %s → 「油資無法計算」可見、合計/段金額不顯示為 0 之最終值",
      async (code) => {
        const router = installFetchRouter();
        router.on("GET", isGetDraft, () =>
          jsonRes({
            application: draftFixture({
              segments: [
                {
                  id: "seg-1",
                  sortOrder: 0,
                  origin: "台北",
                  destination: "台中",
                  totalKm: "100.00",
                  highwayKm: "0.00",
                  attachments: [],
                  snapshot: null,
                },
              ],
            }),
          })
        );
        router.on("POST", isPreview, () =>
          jsonRes({
            preview: previewFixture({
              parameterAvailable: false,
              missingParameters: [code],
              totalAmount: 0,
              totalKm: "100.00",
              segments: [
                {
                  segmentId: "seg-1",
                  segmentIndex: 0,
                  fuelAmount: "0.0000",
                  etcAmount: "0.0000",
                  rawAmount: "0.0000",
                  amount: 0,
                },
              ],
            }),
          })
        );

        renderPage();
        await waitFor(() => expect(screen.getByDisplayValue("台北")).toBeInTheDocument());
        await sleep(400);

        expect(screen.getAllByText("油資無法計算").length).toBeGreaterThan(0);
        expect(screen.queryByText(/合計金額：0/)).not.toBeInTheDocument();
      }
    );

    // ---- 終審複審 SF-1 補集：`ETC` 不在抑制清單——僅缺 ETC 時油資版本齊備，
    // 合計金額仍須照後端已算出之值顯示（非 0 佔位），確認在場（T11R 既有）。----

    // ---- 合併複審 SF-1：僅缺 ETC 時，油資版本齊備，不得誤報「油資無法
    // 計算」並隱藏後端已算出之油資金額（FE-US-10 第一條、PHASE-004 行為
    // 不得回退）。fixture 之 fuelAmount/totalAmount 皆為前端不可能自算出
    // 的implausible值（§11.3 不自算鑑別）。----
    it("僅缺 ETC → 仍顯示各段與合計油資金額、不顯示「油資無法計算」、ETC 提示可見", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: draftFixture({
            segments: [
              {
                id: "seg-1",
                sortOrder: 0,
                origin: "台北",
                destination: "台中",
                totalKm: "100.00",
                highwayKm: "0.00",
                attachments: [],
                snapshot: null,
              },
            ],
          }),
        })
      );
      router.on("POST", isPreview, () =>
        jsonRes({
          preview: previewFixture({
            parameterAvailable: false,
            missingParameters: ["ETC"],
            totalAmount: 300,
            totalKm: "100.00",
            segments: [
              {
                segmentId: "seg-1",
                segmentIndex: 0,
                fuelAmount: "300.0000",
                etcAmount: "0.0000",
                rawAmount: "300.0000",
                amount: 300,
              },
            ],
          }),
        })
      );

      renderPage();
      await waitFor(() => expect(screen.getByDisplayValue("台北")).toBeInTheDocument());
      await sleep(400);

      expect(screen.queryByText("油資無法計算")).not.toBeInTheDocument();
      expect(screen.getAllByText("300.0000").length).toBeGreaterThan(0);
      expect(screen.getByText(/合計金額：300/)).toBeInTheDocument();
      expect(screen.getByText("該出差日期缺少 ETC 補助參數，請聯絡管理員設定")).toBeInTheDocument();
    });
  });

  // ---- Preview debounce 300ms (D8) ----
  it("預覽 debounce 300ms：連續輸入僅觸發一次預覽請求", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () =>
      jsonRes({
        application: draftFixture({
          segments: [
            {
              id: "seg-1",
              sortOrder: 0,
              origin: null,
              destination: null,
              totalKm: null,
              highwayKm: null,
              attachments: [],
              snapshot: null,
            },
          ],
        }),
      })
    );
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    renderPage();
    await waitFor(() => expect(screen.getByLabelText("總里程（公里）")).toBeInTheDocument());

    // Let the initial auto-preview (fired on mount) settle first, then reset the counter.
    await sleep(400);
    router.reset();

    const input = screen.getByLabelText("總里程（公里）");
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.change(input, { target: { value: "123" } });

    // Still within the debounce window — no request yet.
    await sleep(150);
    expect(router.countCalls("POST", isPreview)).toBe(0);

    // Past the 300ms window from the LAST change — exactly one request.
    await sleep(300);
    expect(router.countCalls("POST", isPreview)).toBe(1);
  });

  // ---- Save: dedupe submit (C3) ----
  it("儲存草稿：送出中按鈕 disabled（防重複提交，C3）", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
    const resolveRef: { current: (() => void) | null } = { current: null };
    router.on("PUT", isPutDraft, () => {
      return new Promise((resolve) => {
        resolveRef.current = () => resolve(jsonRes({ application: draftFixture() }));
      });
    });

    renderPage();
    await waitFor(() => expect(screen.getByLabelText("出差日期")).toBeInTheDocument());

    const saveBtn = screen.getByRole("button", { name: "儲存草稿" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "儲存中…" })).toBeDisabled();
    });

    resolveRef.current?.();
    await waitFor(() => {
      expect(screen.getByText("草稿已儲存。")).toBeInTheDocument();
    });
  });

  // ---- Complete: confirm required (C4), irreversible ----
  it("完成申請：需二次確認，成功後轉為已完成唯讀檢視", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () =>
      jsonRes({
        application: draftFixture({
          tripDate: "2026-03-01",
          purpose: "台中出差",
          completionBlockers: [],
        }),
      })
    );
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
    router.on("POST", isComplete, () =>
      jsonRes({
        application: draftFixture({
          status: "COMPLETED",
          tripDate: "2026-03-01",
          purpose: "台中出差",
          completionBlockers: [],
          computed: null,
          completedAt: "2026-03-02T00:00:00.000Z",
          snapshot: {
            fuelUnitPrice: "5.0000",
            etcUnitPrice: "3.0000",
            // D5(a) 再定向（PHASE-005a-T11 必要）：`fuelParameterVersionId`
            // 改 nullable（新模型申請恆為 null，§8.4 判別欄位）；此為舊模型
            // 已完成申請之既有測試場景，維持非 null，另補新模型雙欄位 null。
            fuelParameterVersionId: "fv-1",
            etcParameterVersionId: "ev-1",
            fuelPriceVersionId: null,
            fuelConsumptionVersionId: null,
            totalKm: "0.00",
            totalRawAmount: "0.0000",
            totalAmount: 0,
            calculatedAt: "2026-03-02T00:00:00.000Z",
          },
        }),
      })
    );

    renderPage();
    await waitFor(() => expect(screen.getByLabelText("出差日期")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "完成申請" }));
    expect(screen.getByRole("dialog", { name: "確認完成申請" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "確認完成" }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "差旅補助申請（已完成）" })
      ).toBeInTheDocument();
      expect(screen.getByText("油資單價")).toBeInTheDocument(); // D6(c): completed view MAY show unit price
    });

    // D13: no invalid edit/save/delete/complete buttons on the completed view.
    expect(screen.queryByRole("button", { name: "儲存草稿" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刪除草稿" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("出差日期")).not.toBeInTheDocument();
  });

  // PHASE-008-T13：三型詳情頁皆掛載報表區塊（AC-30 三型面；差旅頁 T12 已
  // 接線，本測試補齊「掛載」斷言以與保養／折舊頁對稱）。
  it("AC-30: 三型詳情頁皆掛載報表區塊", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () =>
      jsonRes({
        application: draftFixture({
          status: "COMPLETED",
          tripDate: "2026-03-01",
          purpose: "台中出差",
          completionBlockers: [],
          computed: null,
          completedAt: "2026-03-02T00:00:00.000Z",
          snapshot: {
            fuelUnitPrice: "5.0000",
            etcUnitPrice: "3.0000",
            fuelParameterVersionId: "fv-1",
            etcParameterVersionId: "ev-1",
            fuelPriceVersionId: null,
            fuelConsumptionVersionId: null,
            totalKm: "0.00",
            totalRawAmount: "0.0000",
            totalAmount: 0,
            calculatedAt: "2026-03-02T00:00:00.000Z",
          },
        }),
      })
    );
    router.on("GET", isGetReport, () => jsonRes({ report: null }));

    renderPage();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "差旅補助申請（已完成）" })
      ).toBeInTheDocument();
    });
    expect(await screen.findByRole("heading", { name: "報表" })).toBeInTheDocument();
  });

  // ---- Delete: confirm required (C4), navigates away ----
  it("刪除草稿：需二次確認，成功後導向列表頁", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
    router.on("DELETE", isDelete, () => jsonRes({ ok: true }));

    renderPage();
    await waitFor(() => expect(screen.getByLabelText("出差日期")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "刪除草稿" }));
    expect(screen.getByRole("dialog", { name: "確認刪除草稿" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "確認刪除" }));

    await waitFor(() => {
      expect(screen.getByText("首頁占位")).toBeInTheDocument();
    });
  });

  // ---- PHASE-005a-T14（Gate 反饋①）：未儲存變更時「完成申請」確認框 ----
  describe("未儲存變更提示（T14）", () => {
    it("有未儲存變更 → 確認框顯示「有未儲存的變更，請先儲存草稿」、確認鈕停用、不含伺服器舊狀態缺項紅字", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

      renderPage();
      await waitFor(() => expect(screen.getByLabelText("出差日期")).toBeInTheDocument());

      // 使用者編輯欄位但未按「儲存草稿」→ dirty。
      fireEvent.change(screen.getByLabelText("出差日期"), { target: { value: "2026-03-05" } });

      fireEvent.click(screen.getByRole("button", { name: "完成申請" }));
      const dialog = screen.getByRole("dialog", { name: "確認完成申請" });

      expect(within(dialog).getByText("有未儲存的變更，請先儲存草稿")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "確認完成" })).toBeDisabled();
      expect(within(dialog).queryByText(/請填寫出差日期/)).not.toBeInTheDocument();
      expect(within(dialog).queryByText("至少需要一個行程段")).not.toBeInTheDocument();
    });

    it("無未儲存變更 → 完成申請確認框行為不變（現行文字、確認鈕可按）", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: draftFixture({
            tripDate: "2026-03-01",
            purpose: "台中出差",
            completionBlockers: [],
          }),
        })
      );
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

      renderPage();
      await waitFor(() => expect(screen.getByLabelText("出差日期")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: "完成申請" }));
      const dialog = screen.getByRole("dialog", { name: "確認完成申請" });

      expect(
        within(dialog).getByText("完成後將無法修改，且無法復原。確定要完成這筆申請嗎？")
      ).toBeInTheDocument();
      expect(within(dialog).queryByText("有未儲存的變更，請先儲存草稿")).not.toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "確認完成" })).not.toBeDisabled();
    });

    it("dirty → 儲存 → 再點完成 → 不再出現未儲存提示，確認鈕恢復可按", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: draftFixture({
            tripDate: "2026-03-01",
            purpose: "台中出差",
            completionBlockers: [],
          }),
        })
      );
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
      router.on("PUT", isPutDraft, () =>
        jsonRes({
          application: draftFixture({
            tripDate: "2026-03-02",
            purpose: "台中出差（修改）",
            completionBlockers: [],
          }),
        })
      );

      renderPage();
      await waitFor(() => expect(screen.getByLabelText("出差日期")).toBeInTheDocument());

      fireEvent.change(screen.getByLabelText("出差日期"), { target: { value: "2026-03-02" } });
      fireEvent.click(screen.getByRole("button", { name: "儲存草稿" }));
      await waitFor(() => expect(screen.getByText("草稿已儲存。")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: "完成申請" }));
      const dialog = screen.getByRole("dialog", { name: "確認完成申請" });

      expect(within(dialog).queryByText("有未儲存的變更，請先儲存草稿")).not.toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "確認完成" })).not.toBeDisabled();
    });

    // T14R2 Lite（SF-1 mutant M6 補強）：completeError 一旦由伺服器缺項寫入，
    // 不得在後續 dirty 分支的確認框中一併殘留顯示；dirty 分支只應顯示未儲存
    // 提示，不得同時渲染舊的伺服器缺項紅字。
    it("確認完成失敗顯示伺服器缺項紅字 → 取消後改欄位（dirty）→ 再開確認框只顯示未儲存提示、紅字不再出現", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: draftFixture({
            tripDate: "2026-03-01",
            purpose: "台中出差",
            completionBlockers: [],
          }),
        })
      );
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
      router.on("POST", isComplete, () =>
        jsonRes(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "尚有缺項",
              details: { blockers: [{ message: "請填寫出差日期" }] },
            },
          },
          422
        )
      );

      renderPage();
      await waitFor(() => expect(screen.getByLabelText("出差日期")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: "完成申請" }));
      let dialog = screen.getByRole("dialog", { name: "確認完成申請" });
      fireEvent.click(within(dialog).getByRole("button", { name: "確認完成" }));

      await waitFor(() => {
        expect(within(dialog).getByText("請填寫出差日期")).toBeInTheDocument();
      });

      fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "確認完成申請" })).not.toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText("出差日期"), { target: { value: "2026-03-06" } });

      fireEvent.click(screen.getByRole("button", { name: "完成申請" }));
      dialog = screen.getByRole("dialog", { name: "確認完成申請" });

      expect(within(dialog).getByText("有未儲存的變更，請先儲存草稿")).toBeInTheDocument();
      expect(within(dialog).queryByText("請填寫出差日期")).not.toBeInTheDocument();
    });
  });

  // ---- Responsive structure (AC-87): vertical stacked blocks, not a table ----
  it("響應式（AC-87）：多段表單使用垂直堆疊區塊而非表格", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    const { container } = renderPage();
    await waitFor(() => expect(screen.getByLabelText("出差日期")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "新增行程段" }));

    expect(container.querySelector(".trip-segment-list")).toBeInTheDocument();
    expect(container.querySelector(".trip-segment-list table")).not.toBeInTheDocument();
    expect(container.querySelector(".trip-segment")).toBeInTheDocument();
  });

  // =========================================================================
  // PHASE-009-T15：作廢入口／VOIDED 唯讀分支／作廢資訊
  // （AC-29(a)、AC-30(c)、AC-31(a)(b)(c)、AC-33 頁面層 Empty／Success）
  // =========================================================================
  describe("作廢（PHASE-009-T15）", () => {
    it("AC-31(a)：VOIDED 走唯讀分支，不再渲染草稿編輯表單", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: voidedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { level: 1, name: "差旅補助申請（已作廢）" })
        ).toBeInTheDocument();
      });

      // 現況缺陷之回歸鎖：VOIDED 曾落入草稿分支而渲染可編輯表單。
      expect(screen.queryByLabelText("出差日期")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("出差目的")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "新增行程段" })).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { level: 1, name: "差旅補助申請（草稿）" })
      ).not.toBeInTheDocument();
      // 唯讀頁不呼叫預覽端點（草稿分支才有的 debounce 預覽）。
      await sleep(400);
      expect(router.countCalls("POST", isPreview)).toBe(0);
    });

    it("AC-31(b)(c)：VOIDED 唯讀頁零五類按鈕、零可恢復為已完成之控制項", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: voidedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await waitFor(() => {
        expect(
          screen.getByRole("heading", { level: 1, name: "差旅補助申請（已作廢）" })
        ).toBeInTheDocument();
      });
      await screen.findByRole("heading", { name: "報表" });

      expectNoWriteControls();
      // 「產生正式報表」對 VOIDED 亦不得出現（AC-31(d) 之頁面層對照）。
      expect(screen.queryByRole("button", { name: "產生正式報表" })).not.toBeInTheDocument();
    });

    it("AC-30(c)：VOIDED 詳情頁逐字顯示作廢原因／作廢操作者／作廢時間", async () => {
      const info = voidInfoFixture();
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: voidedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "作廢資訊" })).toBeInTheDocument();
      });

      expect(dtDdText("作廢原因")).toBe(info.reason);
      expect(dtDdText("作廢操作者")).toBe(info.voidedByDisplayName);
      // 時間長相與既有「計算時間」同一格式（toLocaleString("zh-TW")）。
      // PHASE-008-TZ-FIX：CI（Linux ICU）會輸出細空格家族，故兩側同義正規化。
      expect(dtDdText("作廢時間")?.replace(/\s+/g, " ").trim()).toBe(
        new Date(info.voidedAt).toLocaleString("zh-TW").replace(/\s+/g, " ").trim()
      );
      // 原始 ISO 字串不得在場（負向鎖，沿 ReportSection 既有紀律）。
      expect(screen.queryByText(info.voidedAt)).not.toBeInTheDocument();
    });

    it("AC-33 Empty：COMPLETED（未作廢）詳情頁零作廢資訊區塊", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await waitFor(() => {
        expect(
          screen.getByRole("heading", { level: 1, name: "差旅補助申請（已完成）" })
        ).toBeInTheDocument();
      });

      expect(screen.queryByRole("heading", { name: "作廢資訊" })).not.toBeInTheDocument();
      expect(screen.queryByText("作廢原因")).not.toBeInTheDocument();
      expect(screen.queryByText("作廢操作者")).not.toBeInTheDocument();
      expect(screen.queryByText("作廢時間")).not.toBeInTheDocument();
    });

    it("AC-29(a)：COMPLETED 詳情頁有作廢入口，點擊開啟確認對話框；取消零請求", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));
      router.on("POST", isVoid, () => jsonRes({ application: voidedFixture() }));

      renderPage();
      const voidBtn = await screen.findByRole("button", { name: "作廢" });

      fireEvent.click(voidBtn);
      expect(screen.getByRole("dialog", { name: "確認作廢申請" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "確認作廢申請" })).not.toBeInTheDocument();
      });
      expect(router.countCalls("POST", isVoid)).toBe(0);
      // 取消零狀態變更：仍為已完成檢視。
      expect(
        screen.getByRole("heading", { level: 1, name: "差旅補助申請（已完成）" })
      ).toBeInTheDocument();
    });

    it("AC-33 Success：作廢成功後頁面轉唯讀、顯示三項作廢資訊，且報表區狀態變 VOIDED", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () =>
        jsonRes({
          report: {
            reportNumber: "TRV-202603-0001",
            generatedAt: "2026-03-02T01:23:45.678Z",
            fileName: "差旅_使用者一_2026-03-01_TRV-202603-0001.pdf",
            byteSize: 123456,
            downloadUrl: "/applications/app-1/report/pdf",
            printUrl: "/applications/app-1/report/print",
          },
        })
      );
      router.on("POST", isVoid, () => jsonRes({ application: voidedFixture() }));

      renderPage();
      // 作廢前：報表下載入口為正式版文案。
      expect(await screen.findByRole("link", { name: "下載 PDF" })).toBeInTheDocument();

      fireEvent.click(await screen.findByRole("button", { name: "作廢" }));
      fireEvent.change(screen.getByLabelText("作廢原因"), {
        target: { value: "里程填寫錯誤，需重新申報" },
      });
      fireEvent.click(screen.getByRole("button", { name: "確認作廢" }));

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { level: 1, name: "差旅補助申請（已作廢）" })
        ).toBeInTheDocument();
      });
      expect(screen.queryByRole("dialog", { name: "確認作廢申請" })).not.toBeInTheDocument();
      expect(dtDdText("作廢原因")).toBe("里程填寫錯誤，需重新申報");
      expect(dtDdText("作廢操作者")).toBe("管理員甲");
      expect(screen.getByRole("heading", { name: "作廢資訊" })).toBeInTheDocument();

      // T14 即審 FW-1：ReportSection 之 status prop 必須真變 VOIDED——否則
      // 下載入口仍稱「下載 PDF」而實得作廢版位元組（反向誤導）。
      await waitFor(() => {
        expect(screen.getByRole("link", { name: "下載 PDF（作廢版）" })).toBeInTheDocument();
      });
      expect(screen.queryByRole("link", { name: "下載 PDF" })).not.toBeInTheDocument();

      expectNoWriteControls();
    });
  });

  // =========================================================================
  // PHASE-009-T16：修正版入口 ＋ 版本關係區塊 ＋ 文案（AC-32／AC-33 Success）
  // =========================================================================
  describe("修正版（PHASE-009-T16）", () => {
    const isRevisionEndpoint = (p: string) => p === "/api/applications/app-1/revision";
    const isGetRevisionDraft = (p: string) => p === "/api/applications/travel/rev-1";

    /** 修正版草稿（`supersedes` 非 null，§7.3 之 201 回應形狀）。 */
    function revisionDraftFixture(
      overrides: Partial<TravelApplicationDto> = {}
    ): TravelApplicationDto {
      return draftFixture({
        id: "rev-1",
        tripDate: "2026-03-01",
        purpose: "台中出差",
        supersedes: {
          id: "app-1",
          status: "COMPLETED",
          primaryDate: "2026-03-01",
          reportNumber: "TRV-202603-0001",
        },
        ...overrides,
      });
    }

    it("AC-32(a)：COMPLETED 詳情頁出現「建立修正版」按鈕，且佔位文案逐字不在場", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await screen.findByRole("heading", { level: 1, name: "差旅補助申請（已完成）" });

      expect(screen.getByRole("button", { name: "建立修正版" })).toBeInTheDocument();
      // 逐字負向：佔位文案必須被真實入口取代（未移除之 mutant 必紅）。
      expect(document.body.textContent).not.toContain("功能將於後續版本提供");
      expect(document.body.textContent).not.toContain("請聯絡管理員建立修正版");
      // T16R S-1①：取代後之新文案本身亦須有正向斷言（否則「整段刪光」與
      // 「換成真實入口」對測試無從分辨）。
      expect(
        screen.getByText("此申請已完成，資料已鎖定不可修改。如需異動，請建立修正版。")
      ).toBeInTheDocument();
    });

    it("AC-32(a) 守門：VOIDED 唯讀頁零「建立修正版」按鈕（T15 負向相容）", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: voidedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await screen.findByRole("heading", { level: 1, name: "差旅補助申請（已作廢）" });

      expect(screen.queryByRole("button", { name: "建立修正版" })).not.toBeInTheDocument();
      expectNoWriteControls();
    });

    it("AC-32(b)／AC-33 Success：點擊建立修正版 → POST /revision（零 body）→ 導向新草稿頁", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));
      router.on("GET", isGetRevisionDraft, () => jsonRes({ application: revisionDraftFixture() }));
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
      router.on("POST", isRevisionEndpoint, () =>
        jsonRes({ application: revisionDraftFixture() }, 201)
      );

      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "建立修正版" }));

      // 導向新草稿頁（同一路由樣板、不同 :id）。
      await screen.findByRole("heading", { level: 1, name: "差旅補助申請（草稿）" });
      expect(router.countCalls("POST", isRevisionEndpoint)).toBe(1);
      expect(router.countCalls("GET", isGetRevisionDraft)).toBe(1);

      // AC-32(c) 修正版側：版本關係逐字 ＋ 指向原申請之連結。
      expect(screen.getByText("本申請為 TRV-202603-0001 之修正版")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "檢視原申請" })).toHaveAttribute(
        "href",
        "/applications/travel/app-1"
      );
    });

    it("AC-32(b)：修正版端點不得宣告 Content-Type（R8 防線：無 body 不宣告 body 型別）", async () => {
      const seen: { headers?: HeadersInit; body?: unknown }[] = [];
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));
      router.on("GET", isGetRevisionDraft, () => jsonRes({ application: revisionDraftFixture() }));
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
      router.on("POST", isRevisionEndpoint, (_url, init) => {
        seen.push({ headers: init?.headers, body: init?.body });
        return jsonRes({ application: revisionDraftFixture() }, 201);
      });

      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "建立修正版" }));
      await waitFor(() => expect(seen).toHaveLength(1));

      const first = seen[0] as { headers?: HeadersInit; body?: unknown };
      expect(first.body).toBeUndefined();
      expect(JSON.stringify(first.headers ?? {})).not.toContain("Content-Type");
    });

    it("AC-32(c) 原申請側：已有修正版時顯示「已建立修正版」與指向修正版之連結", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: completedFixture({
            supersededBy: { id: "rev-1", status: "DRAFT", primaryDate: "2026-03-01" },
          }),
        })
      );
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await screen.findByRole("heading", { name: "版本關係" });

      expect(screen.getByText("已建立修正版")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "檢視修正版" })).toHaveAttribute(
        "href",
        "/applications/travel/rev-1"
      );
    });

    // T16R M-1（`SPEC-REV-9T16`）：D15 之人類批准前提「不自動作廢 ＋ **前端強
    // 提示**」。原申請頁之 `supersededBy` 側必含「重複計入」提醒（三點語意：
    // ①仍為已完成 ②未作廢則兩筆同時計入統計 ③作廢入口即在本頁）。
    const DUPLICATE_COUNT_WARNING =
      "本申請仍為已完成狀態。若未作廢，本申請與修正版將同時計入里程與金額統計；如需避免重複計入，請於本頁作廢本申請。";

    it("AC-32(c)／D15：原申請已有修正版時，版本關係區塊含「重複計入」提醒文案（逐字）", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: completedFixture({
            supersededBy: { id: "rev-1", status: "DRAFT", primaryDate: "2026-03-01" },
          }),
        })
      );
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await screen.findByRole("heading", { name: "版本關係" });

      expect(screen.getByText(DUPLICATE_COUNT_WARNING)).toBeInTheDocument();
      // ③「作廢入口即在本頁」不能只是文案宣稱——同頁必須真的有作廢按鈕。
      expect(screen.getByRole("button", { name: "作廢" })).toBeInTheDocument();
    });

    it("AC-32(c)／D15 負向：已完成但未建立修正版時零提醒文案（防恆真）", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await screen.findByRole("heading", { level: 1, name: "差旅補助申請（已完成）" });

      expect(screen.queryByText(DUPLICATE_COUNT_WARNING)).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain("同時計入里程與金額統計");
    });

    it("AC-32(c)／D15 負向：修正版側（supersedes）不加此提醒——作廢落點在原申請頁", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetRevisionDraft, () => jsonRes({ application: revisionDraftFixture() }));
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

      renderPage("rev-1");
      await screen.findByRole("heading", { name: "版本關係" });

      expect(screen.queryByText(DUPLICATE_COUNT_WARNING)).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain("同時計入里程與金額統計");
    });

    it("AC-32(c)／D15 負向（T16R2 S-2）：VOIDED＋已有修正版 → 零提醒文案，但版本關係區塊其餘內容仍在場", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: voidedFixture({
            supersededBy: { id: "rev-1", status: "DRAFT", primaryDate: "2026-03-01" },
          }),
        })
      );
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await screen.findByRole("heading", { name: "差旅補助申請（已作廢）" });
      await screen.findByRole("heading", { name: "版本關係" });

      // 提醒之三點語意在 VOIDED 下**全部不成立**：①已非「仍為已完成」
      // ②已作廢即不計入統計 ③本頁零作廢按鈕（AC-31(b)）——照顯即為自相矛盾
      // 且指向不存在的操作。
      expect(screen.queryByText(DUPLICATE_COUNT_WARNING)).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain("同時計入里程與金額統計");
      expect(screen.queryByRole("button", { name: "作廢" })).not.toBeInTheDocument();

      // 正向對照（防「整個區塊消失」之誤修）：雙向連結內容不受守門影響。
      expect(screen.getByText("已建立修正版")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "檢視修正版" })).toHaveAttribute(
        "href",
        "/applications/travel/rev-1"
      );
    });

    it("AC-32(c) 負向：無任何版本關聯時零版本關係區塊", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await screen.findByRole("heading", { level: 1, name: "差旅補助申請（已完成）" });

      expect(screen.queryByRole("heading", { name: "版本關係" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "檢視原申請" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "檢視修正版" })).not.toBeInTheDocument();
    });

    it("AC-32(c)：原申請未產生報表（reportNumber 為 null）時以原日期呈現", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetRevisionDraft, () =>
        jsonRes({
          application: revisionDraftFixture({
            supersedes: {
              id: "app-1",
              status: "COMPLETED",
              primaryDate: "2026-03-01",
              reportNumber: null,
            },
          }),
        })
      );
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

      renderPage("rev-1");
      await screen.findByRole("heading", { name: "版本關係" });

      expect(screen.getByText("本申請為 2026-03-01 之修正版")).toBeInTheDocument();
    });

    it("AC-32(d)：COMPLETED 附件區提示逐字含「如需修正附件，請建立修正版」；VOIDED 零該提示", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      const { unmount } = renderPage();
      await screen.findByRole("heading", { name: "行程段明細" });
      expect(document.body.textContent).toContain("如需修正附件，請建立修正版");
      unmount();

      const router2 = installFetchRouter();
      router2.on("GET", isGetDraft, () => jsonRes({ application: voidedFixture() }));
      router2.on("GET", isGetReport, () => jsonRes({ report: null }));
      renderPage();
      await screen.findByRole("heading", { level: 1, name: "差旅補助申請（已作廢）" });
      expect(document.body.textContent).not.toContain("如需修正附件，請建立修正版");
    });

    it("AC-33 Error：409 已有修正版 → 顯示訊息並提供指向既有修正版之連結，且零導向", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));
      router.on("POST", isRevisionEndpoint, () =>
        jsonRes(
          {
            error: {
              code: "CONFLICT",
              message: "此申請已有修正版",
              details: { existingRevisionId: "rev-1" },
            },
          },
          409
        )
      );

      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "建立修正版" }));

      expect(await screen.findByText("此申請已有修正版")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "檢視既有修正版" })).toHaveAttribute(
        "href",
        "/applications/travel/rev-1"
      );
      // 零導向：仍停留在原已完成頁。
      expect(
        screen.getByRole("heading", { level: 1, name: "差旅補助申請（已完成）" })
      ).toBeInTheDocument();
    });

    it("AC-33 Error：400 逐字顯示 error.message（T7b AR-2：fields[].field=userId 對不到輸入欄，不得靜默吞錯）", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));
      router.on("POST", isRevisionEndpoint, () =>
        jsonRes(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "指定的使用者已停用，無法代其建立申請",
              fields: [{ field: "userId", reason: "指定的使用者已停用" }],
            },
          },
          400
        )
      );

      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "建立修正版" }));

      expect(await screen.findByText("指定的使用者已停用，無法代其建立申請")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "檢視既有修正版" })).not.toBeInTheDocument();
    });

    it("AC-32(e)：管理員代操作之申請（onBehalf）入口與文案一致", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: completedFixture({ onBehalf: true, createdByDisplayName: "管理員甲" }),
        })
      );
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await screen.findByRole("heading", { level: 1, name: "差旅補助申請（已完成）" });

      expect(screen.getByRole("button", { name: "建立修正版" })).toBeInTheDocument();
      expect(document.body.textContent).toContain("如需修正附件，請建立修正版");
      expect(document.body.textContent).not.toContain("功能將於後續版本提供");
    });

    it("C3：建立修正版送出中按鈕停用（防重複提交）", async () => {
      // 型別以 `let` 宣告 ＋ 明確聯集：TS 之控制流分析會把「只在 callback 內
      // 賦值」的變數窄化為 `never`，故以顯式型別註記阻斷該窄化。
      let resolveRevision: ((res: Response) => void) | undefined;
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));
      router.on(
        "POST",
        isRevisionEndpoint,
        () =>
          new Promise<Response>((resolve) => {
            resolveRevision = resolve;
          })
      );

      renderPage();
      const btn = await screen.findByRole("button", { name: "建立修正版" });
      fireEvent.click(btn);

      const pending = await screen.findByRole("button", { name: "建立中…" });
      expect(pending).toBeDisabled();
      fireEvent.click(pending);
      expect(router.countCalls("POST", isRevisionEndpoint)).toBe(1);

      // 收尾：讓 pending 的請求結束，避免測試結束時仍有未決 promise。
      resolveRevision?.(
        jsonRes({ error: { code: "INTERNAL_ERROR", message: "伺服器錯誤，請稍後再試。" } }, 500)
      );
      await screen.findByText("伺服器錯誤，請稍後再試。");
    });
  });
});
