/**
 * DepreciationApplicationPage 前端單元測試 — PHASE-007-T13／T14／R9
 * （折舊模型修訂段）
 *
 * PHASE-007-R9 改造重點（§20.12 R9 列；取代原 AC-38／AC-39 對應之測試）：
 *   - AC-58：表單提供「申請年度」與「該車年度總里程」兩項可輸入欄位，標籤
 *     逐字互異；年度公務里程仍無 textbox 之負向斷言**保留**。
 *   - AC-59：預覽與完成後詳情顯示五值（每年折舊費用／年度公務里程／年度
 *     總里程／公務比例／補貼金額），逐字取自後端回應；前端零自算鑑別；
 *     車價／折舊年限／每公里補助單價三推導值於草稿頁與已完成頁皆不出現。
 *   - `BLOCKING_CODE_MESSAGES` 六碼對齊 `depreciation-blockers.ts`（退場
 *     `DEPRECIATION_ATTACHMENT_REQUIRED`，新增
 *     `ANNUAL_TOTAL_KM_REQUIRED`／`ANNUAL_TOTAL_KM_INVALID`／
 *     `OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM`）。
 *
 * 本次改造連帶更新所有 fixture（`previewFixture`／`draftFixture` 之
 * `snapshot` 字面量）以符合新版 DTO 形狀——AC-40／41／42 段落之既有斷言
 * **語意不變**，僅欄位名稱與夾帶值隨 DTO 改造同步（§20.11.2 授權範圍：
 * 本檔整體列為 R9／R10 授權遷移）。
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
  DepreciationSnapshotDto,
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
    annualTotalKm: null,
    duplicateYearNotice: null,
    attachments: [],
    completionBlockers: [
      { code: "YEAR_REQUIRED", field: "applicationYear", message: "請選擇申請年度" },
      { code: "ANNUAL_TOTAL_KM_REQUIRED", field: "annualTotalKm", message: "請輸入該車年度總里程" },
    ],
    computed: null,
    snapshot: null,
    ...overrides,
  };
}

// 已填年度＋年度總里程之草稿——供 AC-41「僅缺參數」等情境使用：唯一
// blocker 為 PARAMETER_NOT_AVAILABLE（各測試視需要另以 overrides 補上
// attachments）。
function filledDraftFixture(
  overrides: Partial<DepreciationApplicationDto> = {}
): DepreciationApplicationDto {
  return draftFixture({
    applicationYear: 2025,
    annualTotalKm: "12345.6",
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

// §20.6 五值預設組——彼此互相自洽（500.00 公里 ÷ 12345.6 公里 ×
// 10000.00 ≈ 405；本檔零自算鑑別測試另以刻意不自洽之值覆寫）。
function previewFixture(overrides: Partial<DepreciationComputedDto> = {}): DepreciationComputedDto {
  return {
    calculable: true,
    annualDepreciation: "10000.00",
    officialKm: "500.00",
    officialApplicationCount: 3,
    annualTotalKm: "12345.6",
    ratio: "0.040498",
    ratioPercent: "4.0498",
    rawAmount: "404.9800",
    amount: 405,
    blockingCodes: [],
    ...overrides,
  };
}

function snapshotFixture(
  overrides: Partial<DepreciationSnapshotDto> = {}
): DepreciationSnapshotDto {
  return {
    model: "CURRENT",
    annualDepreciation: "10000.00",
    annualTotalKm: "12345.6",
    ratio: "0.040498",
    ratioPercent: "4.0498",
    perKmUnitPrice: null,
    officialKm: "500.00",
    rawAmount: "404.9800",
    totalAmount: 405,
    calculatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * 讀取 `<dl className="detail-list">` 中指定 `<dt>` 文字所緊鄰之 `<dd>` 文字
 * 內容——用於「五值渲染來源錯置」鑑別（AC-59(a)）：若僅斷言某值之文字存在
 * 於畫面任一處，無法鑑別「兩個 dt/dd 配對互換」之錯置 mutant（因兩值皆仍
 * 出現在畫面上，只是配錯 dt）。本函式將值與其標籤綁定比對。
 */
function dtDdText(dtLabel: string): string | null {
  const dt = screen.getByText(dtLabel, { selector: "dt" });
  const dd = dt.nextElementSibling;
  return dd?.textContent ?? null;
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
  // AC-58：表單提供「申請年度」與「該車年度總里程」兩項可輸入欄位，標籤逐字
  // 互異；年度公務里程無任何可輸入／覆寫欄位（負向斷言保留）。
  // ===========================================================================

  it("AC-58：表單提供申請年度與該車年度總里程兩個可輸入欄位（逐字標籤互異）", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture({ calculable: false }) }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("申請年度")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("該車年度總里程")).toBeInTheDocument();

    // 全頁恰有兩個 <input>（申請年度、該車年度總里程）——年度公務里程恆為
    // 後端唯讀計算值，不存在任何名稱／標籤含「年度公務里程」之輸入欄位。
    const inputs = screen.getAllByRole("spinbutton");
    expect(inputs).toHaveLength(2);
    expect(inputs.map((el) => el.id).sort()).toEqual(["annual-total-km", "application-year"]);

    expect(screen.queryByLabelText("年度公務里程")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("AC-58：兩者皆可為空值儲存（null 為合法值，前端轉為 JSON number｜null）", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture({ calculable: false }) }));
    router.on("PUT", isPutDraft, () => jsonRes({ application: draftFixture() }));

    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("申請年度")).toHaveValue(null);
    });
    expect(screen.getByLabelText("該車年度總里程")).toHaveValue(null);

    screen.getByText("儲存草稿").click();

    await waitFor(() => {
      expect(router.countCalls("PUT", isPutDraft)).toBe(1);
    });
    const body = router.lastBody("PUT", isPutDraft);
    expect(body).toEqual({ applicationYear: null, annualTotalKm: null, attachmentIds: [] });
  });

  it("AC-58：填入年度與年度總里程後皆以 JSON number（非字串）送出", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture({ calculable: false }) }));
    router.on("PUT", isPutDraft, () => jsonRes({ application: filledDraftFixture() }));

    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("申請年度")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("申請年度"), { target: { value: "2025" } });
    fireEvent.change(screen.getByLabelText("該車年度總里程"), { target: { value: "12345.6" } });

    screen.getByText("儲存草稿").click();

    await waitFor(() => {
      expect(router.countCalls("PUT", isPutDraft)).toBe(1);
    });
    const body = router.lastBody("PUT", isPutDraft);
    expect(body).toEqual({ applicationYear: 2025, annualTotalKm: 12345.6, attachmentIds: [] });
    expect(typeof body?.applicationYear).toBe("number");
    expect(typeof body?.annualTotalKm).toBe("number");
  });

  // ===========================================================================
  // AC-59：預覽與完成後詳情顯示五值，直取後端；前端零自算鑑別；車價／折舊
  // 年限／每公里補助單價三推導值絕不出現。
  // ===========================================================================

  it("AC-59：預覽顯示每年折舊費用／年度公務里程／年度總里程／公務比例／補貼金額，逐字取自後端回應", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("500.00 公里")).toBeInTheDocument();
    });
    // 逐值與其 <dt> 標籤綁定比對（鑑別「兩值互換配錯 dt」之渲染來源錯置
    // mutant——僅斷言文字存在於畫面任一處不足以鑑別此類 mutant）。
    expect(dtDdText("每年折舊費用")).toBe("10000.00");
    expect(dtDdText("年度公務里程")).toBe("500.00 公里");
    expect(dtDdText("年度總里程")).toBe("12345.6 公里");
    expect(dtDdText("公務比例")).toBe("4.0498%");
    expect(dtDdText("年度補貼金額")).toBe("405");
  });

  it("AC-59(b)：前端零自算鑑別——mock 之 amount 與 annualDepreciation×officialKm÷annualTotalKm 刻意不符，畫面仍顯示 mock 值", async () => {
    // 10000.00 × 500.00 ÷ 12345.6 ≈ 405；此處刻意回傳一個算術上不可能由
    // 此三值推得的 amount（99999），若前端曾自行計算取整，畫面會顯示 405
    // 而非 99999——本測試鎖定「前端從不自算」。
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
    router.on("POST", isPreview, () =>
      jsonRes({
        preview: previewFixture({
          annualDepreciation: "10000.00",
          officialKm: "500.00",
          annualTotalKm: "12345.6",
          amount: 99999,
        }),
      })
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("99999")).toBeInTheDocument();
    });
    expect(screen.queryByText("405")).not.toBeInTheDocument();
  });

  it("AC-59(c)：車價／折舊年限／每公里補助單價三推導值於草稿頁不出現", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    renderPage();
    await waitFor(() => {
      expect(screen.getByText("500.00 公里")).toBeInTheDocument();
    });

    expect(screen.queryByText(/車價/)).not.toBeInTheDocument();
    expect(screen.queryByText(/折舊年限/)).not.toBeInTheDocument();
    expect(screen.queryByText(/每公里補助單價/)).not.toBeInTheDocument();
  });

  it("AC-59：不可計算時不得顯示金額 0，須顯示「無法計算」＋zh-TW 說明", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
    router.on("POST", isPreview, () =>
      jsonRes({
        preview: previewFixture({
          calculable: false,
          annualDepreciation: null,
          annualTotalKm: null,
          ratio: null,
          ratioPercent: null,
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

  it("AC-59(c)：車價／折舊年限／每公里補助單價三推導值於已完成頁亦不出現", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () =>
      jsonRes({
        application: draftFixture({
          status: "COMPLETED",
          applicationYear: 2025,
          annualTotalKm: "12345.6",
          completionBlockers: null,
          computed: null,
          snapshot: snapshotFixture(),
        }),
      })
    );

    renderPage();
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "年度折舊補貼申請（已完成）" })
      ).toBeInTheDocument();
    });

    // 逐值與其 <dt> 標籤綁定比對（AC-59(a)；同上鑑別理由）。
    expect(dtDdText("每年折舊費用")).toBe("10000.00");
    expect(dtDdText("年度公務里程")).toBe("500.00 公里");
    expect(dtDdText("年度總里程")).toBe("12345.6 公里");
    expect(dtDdText("公務比例")).toBe("4.0498%");
    expect(dtDdText("年度補貼金額（四捨五入後，實際核發）")).toBe("405");
    expect(screen.queryByText(/車價/)).not.toBeInTheDocument();
    expect(screen.queryByText(/折舊年限/)).not.toBeInTheDocument();
    expect(screen.queryByText(/每公里補助單價/)).not.toBeInTheDocument();
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
          annualDepreciation: null,
          ratio: null,
          ratioPercent: null,
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
          snapshot: snapshotFixture(),
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
            ratio: "0.000000",
            ratioPercent: "0.0000",
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

    it("B-10（終審 SF-3）：年度里程 > 0 但每年折舊費用極小（每年折舊費用趨近 0）→ 補貼 0 元非錯誤，且不得誤顯示「尚無差旅」說明", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
      router.on("POST", isPreview, () =>
        jsonRes({
          preview: previewFixture({
            officialKm: "5000.00",
            officialApplicationCount: 3,
            annualDepreciation: "0.00",
            ratio: "0.405006",
            ratioPercent: "40.5006",
            rawAmount: "0.0000",
            amount: 0,
          }),
        })
      );

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("5000.00 公里")).toBeInTheDocument();
      });
      expect(screen.getByText("0")).toBeInTheDocument();
      expect(screen.queryByText("年度補貼金額：無法計算")).not.toBeInTheDocument();
      // 根因鑑別：文案須由里程事實（officialKm）驅動，非由金額結果（amount=0）
      // 推斷——此情境 officialKm > 0，畫面不得出現「尚無差旅」之自相矛盾陳述。
      expect(
        screen.queryByText("該年度尚無已完成之差旅公務里程，補貼金額為 0；申請仍可完成。")
      ).not.toBeInTheDocument();
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
            annualDepreciation: null,
            ratio: null,
            ratioPercent: null,
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

    it("AC-54(b)：完成前無證明 → 完成鈕仍可用（證明改選填，裁定②反轉）；草稿仍可儲存", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: filledDraftFixture({
            attachments: [],
            completionBlockers: [],
          }),
        })
      );
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
      router.on("PUT", isPutDraft, () =>
        jsonRes({
          application: filledDraftFixture({
            attachments: [],
            completionBlockers: [],
          }),
        })
      );

      renderPage();
      await waitFor(() => {
        expect(screen.getByText("500.00 公里")).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: "完成申請" })).not.toBeDisabled();

      fireEvent.click(screen.getByRole("button", { name: "儲存草稿" }));
      await waitFor(() => {
        expect(screen.getByText("草稿已儲存。")).toBeInTheDocument();
      });
      expect(router.countCalls("PUT", isPutDraft)).toBe(1);
      expect(screen.getByRole("button", { name: "完成申請" })).not.toBeDisabled();
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
            annualTotalKm: "12345.6",
            completionBlockers: null,
            computed: null,
            attachments: [attachmentFixture()],
            snapshot: snapshotFixture(),
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
