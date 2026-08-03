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

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { TravelApplicationDto, TravelComputedDto } from "../src/api/applications.js";
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
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
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
});
