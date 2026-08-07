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

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { VoidInfoDto } from "../src/api/applications.js";
import type { AttachmentDto } from "../src/api/attachments.js";
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
    void: null, // PHASE-009 §7.2：未作廢恆為 null
    // PHASE-009 §7.2（T16）：版本關聯之雙向投影；無關聯恆為 null。
    supersedes: null,
    supersededBy: null,
    ...overrides,
  };
}

function attachmentFixture(overrides: Partial<AttachmentDto> = {}): AttachmentDto {
  return {
    id: "att-1",
    status: "LINKED",
    mimeType: "image/jpeg",
    byteSize: 12345,
    originalFilename: "receipt.jpg",
    refType: "MAINTENANCE",
    refId: "app-1",
    previewUrl: "/attachments/att-1/thumbnail",
    downloadUrl: "/attachments/att-1/download",
    ...overrides,
  };
}

// PHASE-006-T12：預設已含 1 張證明、completionBlockers 全清（不含
// MAINTENANCE_ATTACHMENT_REQUIRED）——既有「完成申請」流程測試（dirty 提示、
// 成功完成）之前提是「除欄位外別無阻擋」，T12 將附件缺失納入完成鈕停用條件
// 後，若不補上這張證明會使那些既有測試因新阻擋條件而改變行為，故隨附件
// 語意調整此 fixture（測試意圖不變，僅補齊前提）。
function filledDraftFixture(
  overrides: Partial<MaintenanceApplicationDto> = {}
): MaintenanceApplicationDto {
  return draftFixture({
    lastMaintenanceDate: "2026-01-01",
    currentMaintenanceDate: "2026-02-01",
    lastOdometerKm: "1000.00",
    currentOdometerKm: "1100.00",
    actualCost: "2000.00",
    attachments: [attachmentFixture()],
    completionBlockers: [],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// PHASE-009-T15 fixtures（作廢面）
// ---------------------------------------------------------------------------

function voidInfoFixture(overrides: Partial<VoidInfoDto> = {}): VoidInfoDto {
  return {
    reason: "保養單據金額登打錯誤",
    voidedAt: "2026-03-05T02:34:56.000Z",
    voidedByDisplayName: "管理員甲",
    ...overrides,
  };
}

function completedFixture(
  overrides: Partial<MaintenanceApplicationDto> = {}
): MaintenanceApplicationDto {
  return draftFixture({
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
    ...overrides,
  });
}

/**
 * 已作廢之詳情 fixture。`snapshot: null` 為**後端實況**（實查
 * `backend/src/applications/maintenance-service.ts` :838 之
 * `application.status !== "COMPLETED"` 守門；差旅／折舊亦同——三型對稱），
 * 故唯讀頁之快照區在 VOIDED 下不渲染。
 */
function voidedFixture(
  overrides: Partial<MaintenanceApplicationDto> = {}
): MaintenanceApplicationDto {
  return completedFixture({
    status: "VOIDED",
    snapshot: null,
    void: voidInfoFixture(),
    ...overrides,
  });
}

/** 沿 DepreciationApplicationPage.test.tsx 既有 `dtDdText` 慣例（值綁標籤）。 */
function dtDdText(dtLabel: string): string | null {
  const dt = screen.getByText(dtLabel, { selector: "dt" });
  return dt.nextElementSibling?.textContent ?? null;
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
const isAttachmentsPost = (p: string) => p === "/api/attachments";
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

// Helper: create a synthetic File with given size and type (比照
// AttachmentUploader.test.tsx 既有 makeFile 慣例)
function makeFile(name: string, size: number, type: string): File {
  const buf = new Uint8Array(size);
  return new File([buf], name, { type });
}

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
    // AC-36/37：Permission denied 亦不得掛載 AttachmentUploader、零附件寫入呼叫
    expect(router.countCalls("POST", (p) => p === "/api/attachments")).toBe(0);
    expect(router.countCalls("DELETE", (p) => p.startsWith("/api/attachments/"))).toBe(0);
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
      attachmentIds: [],
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

  // PHASE-008-T13：三型詳情頁皆掛載報表區塊（AC-30 三型面）。
  it("AC-30: 三型詳情頁皆掛載報表區塊", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () =>
      jsonRes({
        application: draftFixture({
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
    router.on("GET", isGetReport, () => jsonRes({ report: null }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "保養費用申請（已完成）" })).toBeInTheDocument();
    });
    expect(await screen.findByRole("heading", { name: "報表" })).toBeInTheDocument();
  });

  // AC-30 負向：草稿頁不渲染報表區塊（保養頁僅於 COMPLETED 分支掛載
  // ReportSection，元件本身亦內建同一守門——見 ReportSection.test.tsx）。
  it("AC-30: 草稿頁不渲染報表區塊（負向斷言）", async () => {
    const router = installFetchRouter();
    router.on("GET", isGetDraft, () => jsonRes({ application: draftFixture() }));
    router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("上次保養日期")).toHaveValue("");
    });
    expect(screen.queryByText("產生正式報表")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "報表" })).not.toBeInTheDocument();
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

  // ===========================================================================
  // PHASE-006-T12 — AC-36（保養證明前端行為）／AC-37（證明區塊五態）
  // ===========================================================================

  describe("保養證明（AC-36/AC-37）", () => {
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

      const { fireEvent } = await import("@testing-library/react");
      const input = screen.getByLabelText(/選擇圖片/) as HTMLInputElement;
      await act(async () => {
        fireEvent.change(input, { target: { files: [makeFile("photo.jpg", 1024, "image/jpeg")] } });
      });

      await waitFor(() => {
        expect(screen.getByRole("img", { name: "photo.jpg" })).toBeInTheDocument();
      });
      expect(router.countCalls("POST", isAttachmentsPost)).toBe(1);
    });

    it("已有 5 張再上傳 → 前端拒絕並顯示上限訊息、零上傳呼叫", async () => {
      const router = installFetchRouter();
      const fiveAttachments = Array.from({ length: 5 }, (_, i) =>
        attachmentFixture({ id: `att-${i + 1}`, originalFilename: `photo-${i + 1}.jpg` })
      );
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: filledDraftFixture({ attachments: fiveAttachments, completionBlockers: [] }),
        })
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

    it("單張 > 10 MB → 前端即拒絕，零上傳呼叫（沿用既有 413 前置檢查）", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({ application: filledDraftFixture({ attachments: [] }) })
      );
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));

      renderPage();
      await waitFor(() => {
        expect(screen.getByLabelText(/選擇圖片/)).toBeInTheDocument();
      });

      const { fireEvent } = await import("@testing-library/react");
      const input = screen.getByLabelText(/選擇圖片/) as HTMLInputElement;
      await act(async () => {
        fireEvent.change(input, {
          target: { files: [makeFile("big.jpg", 11 * 1024 * 1024, "image/jpeg")] },
        });
      });

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(/大小超過上限/);
      });
      expect(router.countCalls("POST", isAttachmentsPost)).toBe(0);
    });

    it("無證明仍可儲存草稿，但完成鈕停用並顯示 MAINTENANCE_ATTACHMENT_REQUIRED 訊息", async () => {
      const router = installFetchRouter();
      const noAttachmentBlocker = [
        { code: "MAINTENANCE_ATTACHMENT_REQUIRED", message: "請至少上傳 1 張保養證明" },
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
        expect(screen.getByText("請至少上傳 1 張保養證明")).toBeInTheDocument();
      });
      // mutant 鑑別力：即使欄位齊備、比例正常，缺證明本身須單獨足以停用完成鈕
      expect(screen.getByRole("button", { name: "完成申請" })).toBeDisabled();

      const { fireEvent } = await import("@testing-library/react");
      fireEvent.click(screen.getByRole("button", { name: "儲存草稿" }));
      await waitFor(() => {
        expect(screen.getByText("草稿已儲存。")).toBeInTheDocument();
      });
      expect(router.countCalls("PUT", isPutDraft)).toBe(1);
      expect(screen.getByRole("button", { name: "完成申請" })).toBeDisabled();
    });

    it("已完成之保養申請不存在任何上傳／刪除入口（負向斷言）", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({
          application: draftFixture({
            status: "COMPLETED",
            completionBlockers: null,
            computed: null,
            attachments: [attachmentFixture()],
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
      expect(screen.getByText("receipt.jpg")).toBeInTheDocument();
      expect(screen.queryByLabelText(/選擇圖片/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /刪除/ })).not.toBeInTheDocument();
      expect(router.countCalls("POST", isAttachmentsPost)).toBe(0);
    });

    it("AR-3：attachmentIds 送出前去重（重複 id 不重複送出）", async () => {
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
        expect(screen.getByLabelText("本次實際保養費用")).toHaveValue(2000);
      });

      const { fireEvent } = await import("@testing-library/react");
      fireEvent.click(screen.getByRole("button", { name: "儲存草稿" }));
      await waitFor(() => {
        expect(screen.getByText("草稿已儲存。")).toBeInTheDocument();
      });

      const body = router.lastBody("PUT", isPutDraft);
      expect(body?.attachmentIds).toEqual(["att-dup"]);
    });

    it("PUT 409 TOO_MANY_ATTACHMENTS（後端仍為權威，AC-21）：儲存失敗訊息原樣呈現", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: filledDraftFixture() }));
      router.on("POST", isPreview, () => jsonRes({ preview: previewFixture() }));
      router.on("PUT", isPutDraft, () =>
        jsonRes({ error: { code: "TOO_MANY_ATTACHMENTS", message: "附件數量已達上限" } }, 409)
      );

      renderPage();
      await waitFor(() => {
        expect(screen.getByLabelText("本次實際保養費用")).toHaveValue(2000);
      });

      const { fireEvent } = await import("@testing-library/react");
      fireEvent.click(screen.getByRole("button", { name: "儲存草稿" }));

      await waitFor(() => {
        expect(screen.getByText("附件數量已達上限")).toBeInTheDocument();
      });
    });
  });

  // ===========================================================================
  // PHASE-009-T15：作廢入口／VOIDED 唯讀分支／作廢資訊
  // （AC-29(a)、AC-30(c)、AC-31(a)(b)(c)、AC-33 頁面層 Empty／Success）
  // ===========================================================================
  describe("作廢（PHASE-009-T15）", () => {
    it("AC-31(a)：VOIDED 走唯讀分支，不再渲染草稿編輯表單", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: voidedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "保養費用申請（已作廢）" })).toBeInTheDocument();
      });

      // 現況缺陷之回歸鎖：VOIDED 曾落入草稿分支而渲染可編輯表單。
      expect(screen.queryByLabelText("上次保養日期")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("本次實際保養費用")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "保養費用申請（草稿）" })
      ).not.toBeInTheDocument();
      await sleep(400);
      expect(router.countCalls("POST", isPreview)).toBe(0);
    });

    it("AC-31(b)(c)：VOIDED 唯讀頁零五類按鈕、零可恢復為已完成之控制項", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({ application: voidedFixture({ attachments: [attachmentFixture()] }) })
      );
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "保養費用申請（已作廢）" })).toBeInTheDocument();
      });
      await screen.findByRole("heading", { name: "報表" });

      expectNoWriteControls();
      expect(screen.queryByRole("button", { name: "產生正式報表" })).not.toBeInTheDocument();
      // 附件僅唯讀縮圖，無上傳入口（沿 COMPLETED 既有紀律之同型負向）。
      expect(screen.getByText("receipt.jpg")).toBeInTheDocument();
      expect(screen.queryByLabelText(/選擇圖片/)).not.toBeInTheDocument();
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
      // 時間長相與既有「計算時間」同一格式；TZ-FIX：兩側同義空白正規化。
      expect(dtDdText("作廢時間")?.replace(/\s+/g, " ").trim()).toBe(
        new Date(info.voidedAt).toLocaleString("zh-TW").replace(/\s+/g, " ").trim()
      );
      expect(screen.queryByText(info.voidedAt)).not.toBeInTheDocument();
    });

    it("AC-33 Empty：COMPLETED（未作廢）詳情頁零作廢資訊區塊", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "保養費用申請（已完成）" })).toBeInTheDocument();
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
      expect(screen.getByRole("heading", { name: "保養費用申請（已完成）" })).toBeInTheDocument();
    });

    it("AC-33 Success：作廢成功後頁面轉唯讀、顯示三項作廢資訊，且報表區狀態變 VOIDED", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () =>
        jsonRes({
          report: {
            reportNumber: "MNT-202603-0001",
            generatedAt: "2026-03-02T01:23:45.678Z",
            fileName: "保養_使用者一_2026-02-01_MNT-202603-0001.pdf",
            byteSize: 123456,
            downloadUrl: "/applications/app-1/report/pdf",
            printUrl: "/applications/app-1/report/print",
          },
        })
      );
      router.on("POST", isVoid, () => jsonRes({ application: voidedFixture() }));

      renderPage();
      expect(await screen.findByRole("link", { name: "下載 PDF" })).toBeInTheDocument();

      fireEvent.click(await screen.findByRole("button", { name: "作廢" }));
      fireEvent.change(screen.getByLabelText("作廢原因"), {
        target: { value: "保養單據金額登打錯誤" },
      });
      fireEvent.click(screen.getByRole("button", { name: "確認作廢" }));

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "保養費用申請（已作廢）" })).toBeInTheDocument();
      });
      expect(screen.queryByRole("dialog", { name: "確認作廢申請" })).not.toBeInTheDocument();
      expect(dtDdText("作廢原因")).toBe("保養單據金額登打錯誤");
      expect(dtDdText("作廢操作者")).toBe("管理員甲");

      // T14 即審 FW-1：ReportSection 之 status prop 必須真變 VOIDED。
      await waitFor(() => {
        expect(screen.getByRole("link", { name: "下載 PDF（作廢版）" })).toBeInTheDocument();
      });
      expect(screen.queryByRole("link", { name: "下載 PDF" })).not.toBeInTheDocument();

      expectNoWriteControls();
    });
  });

  // ===========================================================================
  // PHASE-009-T16：修正版入口 ＋ 版本關係區塊 ＋ 文案（AC-32／AC-33 Success）
  // ===========================================================================
  describe("修正版（PHASE-009-T16）", () => {
    const isRevisionEndpoint = (p: string) => p === "/api/applications/app-1/revision";
    const isGetRevisionDraft = (p: string) => p === "/api/applications/maintenance/rev-1";

    function revisionDraftFixture(
      overrides: Partial<MaintenanceApplicationDto> = {}
    ): MaintenanceApplicationDto {
      return draftFixture({
        id: "rev-1",
        supersedes: {
          id: "app-1",
          status: "COMPLETED",
          primaryDate: "2026-03-01",
          reportNumber: "MNT-202603-0001",
        },
        ...overrides,
      });
    }

    it("AC-32(a)：COMPLETED 詳情頁出現「建立修正版」按鈕，且佔位文案逐字不在場", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await screen.findByRole("heading", { name: "保養費用申請（已完成）" });

      expect(screen.getByRole("button", { name: "建立修正版" })).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("功能將於後續版本提供");
      expect(document.body.textContent).not.toContain("請聯絡管理員建立修正版");
    });

    it("AC-32(a) 守門：VOIDED 唯讀頁零「建立修正版」按鈕（T15 負向相容）", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: voidedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await screen.findByRole("heading", { name: "保養費用申請（已作廢）" });

      expect(screen.queryByRole("button", { name: "建立修正版" })).not.toBeInTheDocument();
      expectNoWriteControls();
    });

    it("AC-32(b)／AC-33 Success：點擊建立修正版 → POST /revision → 導向新草稿頁並顯示版本關係", async () => {
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

      await screen.findByRole("heading", { name: "保養費用申請（草稿）" });
      expect(router.countCalls("POST", isRevisionEndpoint)).toBe(1);
      // §7.3「Body：無（一律忽略）」——前端不得送 body。
      expect(router.lastBody("POST", isRevisionEndpoint)).toBeNull();

      expect(screen.getByText("本申請為 MNT-202603-0001 之修正版")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "檢視原申請" })).toHaveAttribute(
        "href",
        "/applications/maintenance/app-1"
      );
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
        "/applications/maintenance/rev-1"
      );
    });

    // T16R M-1（`SPEC-REV-9T16`）：D15 之人類批准前提「不自動作廢 ＋ **前端強
    // 提示**」。原申請頁之 `supersededBy` 側必含「重複計入」提醒（三點語意：
    // ①仍為已完成 ②未作廢則兩筆同時計入統計 ③作廢入口即在本頁）。
    //
    // 本頁自持一份 VersionRelationSection（三頁各一份，見 T16 Handoff W-3），
    // 故正向／負向皆須逐頁具備——差旅頁的負向無法證明本頁沒有把提醒寫死。
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
      await screen.findByRole("heading", { name: "保養費用申請（已完成）" });

      expect(screen.queryByText(DUPLICATE_COUNT_WARNING)).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain("同時計入里程與金額統計");
    });

    it("AC-32(c) 負向：無任何版本關聯時零版本關係區塊", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () => jsonRes({ application: completedFixture() }));
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      renderPage();
      await screen.findByRole("heading", { name: "保養費用申請（已完成）" });

      expect(screen.queryByRole("heading", { name: "版本關係" })).not.toBeInTheDocument();
    });

    it("AC-32(d)：COMPLETED 保養證明區提示逐字含「如需修正附件，請建立修正版」；VOIDED 零該提示", async () => {
      const router = installFetchRouter();
      router.on("GET", isGetDraft, () =>
        jsonRes({ application: completedFixture({ attachments: [attachmentFixture()] }) })
      );
      router.on("GET", isGetReport, () => jsonRes({ report: null }));

      const { unmount } = renderPage();
      await screen.findByRole("heading", { name: "保養證明" });
      expect(document.body.textContent).toContain("如需修正附件，請建立修正版");
      unmount();

      const router2 = installFetchRouter();
      router2.on("GET", isGetDraft, () =>
        jsonRes({ application: voidedFixture({ attachments: [attachmentFixture()] }) })
      );
      router2.on("GET", isGetReport, () => jsonRes({ report: null }));
      renderPage();
      await screen.findByRole("heading", { name: "保養費用申請（已作廢）" });
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
        "/applications/maintenance/rev-1"
      );
      expect(screen.getByRole("heading", { name: "保養費用申請（已完成）" })).toBeInTheDocument();
    });

    it("AC-33 Error：400 逐字顯示 error.message（不得靜默吞錯）", async () => {
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
  });
});
