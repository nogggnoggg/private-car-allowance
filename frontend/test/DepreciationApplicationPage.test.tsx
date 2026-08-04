/**
 * DepreciationApplicationPage 前端單元測試 — PHASE-007-T13／T14
 *
 * 涵蓋 AC-38（表單僅提供申請年度一項可輸入欄位；年度公務里程無任何可輸入／
 * 覆寫欄位之負向斷言）、AC-39（預覽顯示折舊每公里單價／年度公務里程／
 * 取整後金額，直取後端；前端零自算鑑別；車價／折舊年限／預估年度行駛公里
 * 數三推導值於任何狀態下皆不出現之負向斷言）、AC-40（五態：Loading／
 * Empty／Error／Success／Permission denied；blockingCodes 驅動顯示）、
 * AC-41（缺參數時顯示聯絡管理員文案並停用「完成申請」，仍允許儲存草稿）、
 * AC-42（同年度重複提醒但不阻擋；折舊證明上傳／預覽／刪除；已完成無上傳／
 * 刪除入口之負向斷言）。
 *
 * 採用 URL/method 路由式 fetch mock（比照 MaintenanceApplicationPage.test.tsx
 * 既有慣例）——本頁掛載後會自動觸發一次 debounced 預覽請求，佇列式 mock 容易
 * 被插隊而錯位。
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { AttachmentDto } from "../src/api/attachments.js";
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

// 已填年度之草稿——供 AC-41「僅缺參數」情境使用：唯一 blocker 為
// PARAMETER_NOT_AVAILABLE（各測試視需要另以 overrides 補上 attachments）。
function filledDraftFixture(
  overrides: Partial<DepreciationApplicationDto> = {}
): DepreciationApplicationDto {
  return draftFixture({
    applicationYear: 2025,
    completionBlockers: [],
    ...overrides,
  });
}

function attachmentFixture(overrides: Partial<AttachmentDto> = {}): AttachmentDto {
  return {
    id: "att-1",
    status: "LINKED",
    mimeType: "image/jpeg",
    byteSize: 12345,
    originalFilename: "receipt.jpg",
    refType: "DEPRECIATION",
    refId: "app-1",
    previewUrl: "/attachments/att-1/thumbnail",
    downloadUrl: "/attachments/att-1/download",
    ...overrides,
  };
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
const isDelete = (p: string) => p === "/api/applications/app-1";
const isAttachmentsPost = (p: string) => p === "/api/attachments";

// Helper: create a synthetic File with given size and type (比照
// AttachmentUploader.test.tsx／006 T12 既有 makeFile 慣例)
function makeFile(name: string, size: number, type: string): File {
  const buf = new Uint8Array(size);
  return new File([buf], name, { type });
}

describe("DepreciationApplicationPage", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // 基本骨架（Loading／Permission denied）——AC-40 補齊段見下方「AC-40：五態」。
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
    expect(body).toEqual({ applicationYear: null, attachmentIds: [] });
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
    expect(body).toEqual({ applicationYear: 2025, attachmentIds: [] });
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

  // ===========================================================================
  // AC-40：五態（Loading／Empty／Error／Success／Permission denied）。
  // Loading／Permission denied 已於前段覆蓋，本段補齊 Empty／Error／
  // blockingCodes 驅動之顯示邏輯（非 calculable 單一旗標）。
  // ===========================================================================

  describe("AC-40：五態", () => {
    it("Empty：年度無任何有效差旅（totalKm=0.00、applicationCount=0）時顯示 0 值＋說明，非錯誤、非空白頁", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
      router.on("POST", isPreview, () =>
        jsonRes({
          preview: previewFixture({
            officialKm: "0.00",
            officialApplicationCount: 0,
            perKmUnitPrice: "1.1111",
            rawAmount: "0.0000",
            amount: 0,
          }),
        })
      );

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("0.00 公里")).toBeInTheDocument();
      });
      expect(screen.getByText("0")).toBeInTheDocument();
      // 非錯誤狀態：不應出現「無法計算」文案
      expect(screen.queryByText("年度補貼金額：無法計算")).not.toBeInTheDocument();
      // SF-3／Spec §4：Empty 列須有說明文字（非錯誤、為何是 0、仍可完成）
      expect(
        screen.getByText("該年度尚無已完成之差旅公務里程，補貼金額為 0；申請仍可完成。")
      ).toBeInTheDocument();
      // SF-3：Empty 態不得因 amount=0 而停用「完成申請」
      expect(screen.getByRole("button", { name: "完成申請" })).not.toBeDisabled();
    });

    it("Error：讀取草稿 500 時顯示錯誤訊息與重試按鈕，點擊重試重新呼叫 GET", async () => {
      const router = installFetchRouter();
      let getCalls = 0;
      router.on("GET", isGetDraft, () => {
        getCalls += 1;
        return jsonRes(
          { error: { code: "INTERNAL_ERROR", message: "系統發生錯誤，請稍後再試" } },
          500
        );
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("系統發生錯誤，請稍後再試")).toBeInTheDocument();
      });
      expect(getCalls).toBe(1);

      fireEvent.click(screen.getByRole("button", { name: "重試" }));
      await waitFor(() => {
        expect(getCalls).toBe(2);
      });
    });

    it("blockingCodes 驅動顯示：未知代碼原樣顯示（非以 calculable 單一旗標決定文案內容）", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
      router.on("POST", isPreview, () =>
        jsonRes({
          preview: previewFixture({
            calculable: false,
            perKmUnitPrice: null,
            rawAmount: null,
            amount: null,
            blockingCodes: ["SOME_UNKNOWN_BLOCKER_CODE"],
          }),
        })
      );

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("SOME_UNKNOWN_BLOCKER_CODE")).toBeInTheDocument();
      });
      expect(screen.queryByText("0")).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // AC-42：重複年度提醒（不阻擋）＋ 折舊證明上傳／預覽／刪除（草稿階段）＋
  // 已完成無上傳／刪除入口之負向斷言。
  // ===========================================================================

  describe("AC-42：重複提醒與證明", () => {
    it("同年度已有其他申請時顯示提醒文字，但不阻擋建立與完成（提醒在場且完成鈕可用）", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: filledDraftFixture({
            attachments: [attachmentFixture()],
            duplicateYearNotice: { count: 3, hasCompleted: true },
          }),
        })
      );
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

      renderPage();

      await waitFor(() => {
        expect(
          screen.getByText(/提醒：您在西元 2025 年度已有 3 筆其他折舊補貼申請/)
        ).toBeInTheDocument();
      });
      expect(screen.getByText(/含已完成之申請/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "完成申請" })).not.toBeDisabled();
    });

    it("無其他申請時不顯示重複提醒（count=0）", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: filledDraftFixture({
            attachments: [attachmentFixture()],
            duplicateYearNotice: { count: 0, hasCompleted: false },
          }),
        })
      );
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

      renderPage();
      await waitFor(() => {
        expect(screen.getByText("500.00 公里")).toBeInTheDocument();
      });
      expect(screen.queryByText(/提醒：您在西元/)).not.toBeInTheDocument();
    });

    it("Empty：尚無證明", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({ application: filledDraftFixture({ attachments: [] }) })
      );
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

      renderPage();
      await waitFor(() => {
        expect(screen.getByText("尚無證明")).toBeInTheDocument();
      });
    });

    it("上傳支援格式圖片 → 顯示縮圖預覽", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({ application: filledDraftFixture({ attachments: [] }) })
      );
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
      router.on("POST", isAttachmentsPost, () =>
        jsonRes(
          { attachment: attachmentFixture({ id: "att-new", originalFilename: "photo.jpg" }) },
          201
        )
      );

      renderPage();
      await waitFor(() => {
        expect(screen.getByText("尚無證明")).toBeInTheDocument();
      });

      const input = screen.getByLabelText(/選擇圖片/) as HTMLInputElement;
      await act(async () => {
        fireEvent.change(input, { target: { files: [makeFile("photo.jpg", 1024, "image/jpeg")] } });
      });

      await waitFor(() => {
        expect(screen.getByRole("img", { name: "photo.jpg" })).toBeInTheDocument();
      });
      expect(router.countCalls("POST", isAttachmentsPost)).toBe(1);
    });

    it("已有 5 張再上傳（第 6 張）→ 前端拒絕並顯示上限訊息、零上傳呼叫", async () => {
      const router = installFetchRouter();
      const fiveAttachments = Array.from({ length: 5 }, (_, i) =>
        attachmentFixture({ id: `att-${i + 1}`, originalFilename: `photo-${i + 1}.jpg` })
      );
      router.on("GET", isGetDraft, () =>
        jsonRes({ application: filledDraftFixture({ attachments: fiveAttachments }) })
      );
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

      renderPage();
      await waitFor(() => {
        expect(
          screen.getByText("已達上限（5 張），如需新增請先刪除現有附件。")
        ).toBeInTheDocument();
      });
      expect(screen.queryByLabelText(/選擇圖片/)).not.toBeInTheDocument();
      expect(router.countCalls("POST", isAttachmentsPost)).toBe(0);
    });

    it("刪除草稿階段附件 → 呼叫 DELETE /attachments/:id", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({ application: filledDraftFixture({ attachments: [attachmentFixture()] }) })
      );
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
      router.on(
        "DELETE",
        (p) => p === "/api/attachments/att-1",
        () => jsonRes({}, 200)
      );

      renderPage();
      await waitFor(() => {
        expect(screen.getByRole("img", { name: "receipt.jpg" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "刪除 receipt.jpg" }));

      await waitFor(() => {
        expect(router.countCalls("DELETE", (p) => p === "/api/attachments/att-1")).toBe(1);
      });
      await waitFor(() => {
        expect(screen.queryByRole("img", { name: "receipt.jpg" })).not.toBeInTheDocument();
      });
    });

    it("完成前無證明 → 完成鈕停用並顯示提示；草稿仍可儲存", async () => {
      const router = installFetchRouter();
      const noAttachmentBlocker = [
        { code: "DEPRECIATION_ATTACHMENT_REQUIRED", message: "請至少上傳 1 張折舊證明" },
      ];
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: filledDraftFixture({
            attachments: [],
            completionBlockers: noAttachmentBlocker,
          }),
        })
      );
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
      router.on("PUT", isPutDraft, () =>
        jsonRes({
          application: filledDraftFixture({
            attachments: [],
            completionBlockers: noAttachmentBlocker,
          }),
        })
      );

      renderPage();
      await waitFor(() => {
        expect(screen.getByText("請至少上傳 1 張折舊證明")).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: "完成申請" })).toBeDisabled();

      fireEvent.click(screen.getByRole("button", { name: "儲存草稿" }));
      await waitFor(() => {
        expect(screen.getByText("草稿已儲存。")).toBeInTheDocument();
      });
      expect(router.countCalls("PUT", isPutDraft)).toBe(1);
      expect(screen.getByRole("button", { name: "完成申請" })).toBeDisabled();
    });

    it("B-22／FW-11 裁定 A：attachmentIds 送出前去重（重複 id 不重複送出）", async () => {
      const router = installFetchRouter();
      const dupA = attachmentFixture({ id: "att-dup" });
      const dupB = attachmentFixture({ id: "att-dup" });
      router.on("GET", isGetDraft, () =>
        jsonRes({ application: filledDraftFixture({ attachments: [dupA, dupB] }) })
      );
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
      router.on("PUT", isPutDraft, () =>
        jsonRes({ application: filledDraftFixture({ attachments: [dupA] }) })
      );

      renderPage();
      await waitFor(() => {
        expect(screen.getByText("500.00 公里")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "儲存草稿" }));
      await waitFor(() => {
        expect(screen.getByText("草稿已儲存。")).toBeInTheDocument();
      });

      const body = router.lastBody("PUT", isPutDraft);
      expect(body?.attachmentIds).toEqual(["att-dup"]);
    });

    it("已完成之折舊申請不存在任何上傳／刪除入口（負向斷言）", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: draftFixture({
            status: "COMPLETED",
            applicationYear: 2025,
            completionBlockers: null,
            computed: null,
            attachments: [attachmentFixture()],
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
      expect(screen.getByText("receipt.jpg")).toBeInTheDocument();
      expect(screen.queryByLabelText(/選擇圖片/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /刪除/ })).not.toBeInTheDocument();
      expect(router.countCalls("POST", isAttachmentsPost)).toBe(0);
      expect(router.countCalls("DELETE", (p) => p.startsWith("/api/attachments/"))).toBe(0);
    });
  });
});
