/**
 * VoidApplicationDialog 元件單元測試 — PHASE-009-T14
 *
 * 涵蓋 AC-29(b)~(f)（二次確認對話框、必填原因、送出中停用、400／409 錯誤呈現、
 * 取消零請求）與 AC-33 之作廢側五態（Loading／Empty／Error 400/409/500／
 * Success／Permission denied）。
 *
 * 沿 ReportSection.test.tsx 之 URL/method 路由式 fetch mock 慣例（可對「零
 * POST」做精確計數斷言，佇列式 mock 無法表達）。
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VoidApplicationDialog from "../src/components/VoidApplicationDialog.js";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function installFetchRouter() {
  const calls: { method: string; path: string; body: string | null }[] = [];
  const routes: Array<{ method: string; test: (path: string) => boolean; handler: Handler }> = [];

  (fetch as Mock).mockImplementation(async (input: unknown, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : String(input);
    const url = new URL(urlStr, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path: url.pathname, body: (init?.body as string) ?? null });
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
    totalCalls() {
      return calls.length;
    },
    bodies(method: string, test: (path: string) => boolean) {
      return calls.filter((c) => c.method === method && test(c.path)).map((c) => c.body);
    },
  };
}

const isPostVoid = (p: string) => p === "/api/applications/app-1/void";

function renderDialog(
  overrides: Partial<{
    onCancel: () => void;
    onVoided: (application: unknown) => void;
    onReload: () => void;
  }> = {}
) {
  const onCancel = overrides.onCancel ?? vi.fn();
  const onVoided = overrides.onVoided ?? vi.fn();
  const onReload = overrides.onReload ?? vi.fn();
  render(
    <VoidApplicationDialog
      applicationId="app-1"
      onCancel={onCancel}
      onVoided={onVoided}
      onReload={onReload}
    />
  );
  return { onCancel, onVoided, onReload };
}

function typeReason(value: string) {
  fireEvent.change(screen.getByLabelText("作廢原因"), { target: { value } });
}

describe("VoidApplicationDialog", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- AC-29(b) 對話框形狀 ----
  it("AC-29(b): 渲染 .dialog-overlay 二次確認對話框，含作廢原因輸入欄與確認／取消兩鈕，且掛載時零請求", () => {
    installFetchRouter();
    const { container } = render(
      <VoidApplicationDialog
        applicationId="app-1"
        onCancel={vi.fn()}
        onVoided={vi.fn()}
        onReload={vi.fn()}
      />
    );

    expect(container.querySelector(".dialog-overlay")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "確認作廢申請" })).toBeInTheDocument();
    expect(screen.getByLabelText("作廢原因")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "確認作廢" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  // ---- AC-29(c) 空／純空白原因 → 確認鈕停用且零 POST ----
  describe("AC-29(c): 原因為空或僅空白 → 確認鈕停用且零 POST（前端第一道）", () => {
    const blanks: Array<[string, string]> = [
      ["空字串", ""],
      ["半形空白", "   "],
      ["全形空白", "　　　"],
      ["Tab", "\t\t"],
      ["換行", "\n\n"],
      ["混合空白（全形空白＋Tab＋換行）", "　\t\n "],
    ];

    for (const [label, value] of blanks) {
      it(`${label} → 確認鈕停用，點擊後零 POST`, () => {
        const router = installFetchRouter();
        renderDialog();

        if (value !== "") typeReason(value);

        const confirmBtn = screen.getByRole("button", { name: "確認作廢" });
        expect(confirmBtn).toBeDisabled();

        fireEvent.click(confirmBtn);
        expect(router.countCalls("POST", isPostVoid)).toBe(0);
        expect(router.totalCalls()).toBe(0);
      });
    }

    it("輸入非空白原因後確認鈕啟用；再清空 → 重新停用", () => {
      installFetchRouter();
      renderDialog();

      typeReason("誤植金額");
      expect(screen.getByRole("button", { name: "確認作廢" })).toBeEnabled();

      typeReason("   ");
      expect(screen.getByRole("button", { name: "確認作廢" })).toBeDisabled();
    });
  });

  // ---- AC-29(f) 取消零請求 ----
  it("AC-29(f): 取消時呼叫 onCancel，且零請求（即使已輸入原因）", () => {
    const router = installFetchRouter();
    const { onCancel, onVoided } = renderDialog();

    typeReason("誤植金額");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onVoided).not.toHaveBeenCalled();
    expect(router.totalCalls()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  // ---- AC-33 五態 ----
  describe("AC-33: 作廢側五態", () => {
    it("Empty：初始態零錯誤區塊、零送出中文案、原因欄為空", () => {
      installFetchRouter();
      renderDialog();

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("作廢中…")).not.toBeInTheDocument();
      expect(screen.getByLabelText("作廢原因")).toHaveValue("");
    });

    // ---- AC-29(d) 送出中停用（防重複提交） ----
    it("Loading（AC-29(d)）：送出中確認鈕顯示「作廢中…」且停用、取消鈕亦停用；重複點擊僅一次 POST", async () => {
      const router = installFetchRouter();
      const resolveRef: { current: (() => void) | null } = { current: null };
      router.on(
        "POST",
        isPostVoid,
        () =>
          new Promise((resolve) => {
            resolveRef.current = () => resolve(jsonRes({ application: { id: "app-1" } }));
          })
      );
      renderDialog();

      typeReason("誤植金額");
      fireEvent.click(screen.getByRole("button", { name: "確認作廢" }));

      const busyBtn = await screen.findByRole("button", { name: "作廢中…" });
      expect(busyBtn).toBeDisabled();
      expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();

      fireEvent.click(busyBtn);
      fireEvent.click(busyBtn);
      expect(router.countCalls("POST", isPostVoid)).toBe(1);

      resolveRef.current?.();
      await waitFor(() => {
        expect(router.countCalls("POST", isPostVoid)).toBe(1);
      });
    });

    it("Success：200 → 以回應之 application 呼叫 onVoided 恰一次，POST 送出 { reason }", async () => {
      const router = installFetchRouter();
      const application = { id: "app-1", status: "VOIDED" };
      router.on("POST", isPostVoid, () => jsonRes({ application }));
      const { onVoided, onCancel } = renderDialog();

      typeReason("誤植金額");
      fireEvent.click(screen.getByRole("button", { name: "確認作廢" }));

      await waitFor(() => {
        expect(onVoided).toHaveBeenCalledTimes(1);
      });
      expect(onVoided).toHaveBeenCalledWith(application);
      expect(onCancel).not.toHaveBeenCalled();
      expect(router.countCalls("POST", isPostVoid)).toBe(1);
      expect(router.bodies("POST", isPostVoid)).toEqual([JSON.stringify({ reason: "誤植金額" })]);
    });

    it('Error 400：逐字顯示 error.message 與 fields[] 之 reason（field: "reason"），零 onVoided，且可修正後重送', async () => {
      const router = installFetchRouter();
      let postCount = 0;
      router.on("POST", isPostVoid, () => {
        postCount += 1;
        if (postCount === 1) {
          return jsonRes(
            {
              error: {
                code: "VALIDATION_ERROR",
                message: "輸入資料有誤",
                fields: [{ field: "reason", reason: "作廢原因不得超過 500 字" }],
              },
            },
            400
          );
        }
        return jsonRes({ application: { id: "app-1" } });
      });
      const { onVoided } = renderDialog();

      typeReason("誤植金額");
      fireEvent.click(screen.getByRole("button", { name: "確認作廢" }));

      // FW-3（T7b AR-2/FW-1）：fields[] 之逐欄訊息與 error.message 必須**同時**
      // 顯示，不得只顯示其一（fields 對不到輸入欄時會靜默吞錯）。
      expect(await screen.findByText("作廢原因不得超過 500 字")).toBeInTheDocument();
      expect(screen.getByText("輸入資料有誤")).toBeInTheDocument();
      expect(onVoided).not.toHaveBeenCalled();

      // 修正後重送：錯誤清除、成功回呼
      typeReason("誤植里程");
      fireEvent.click(screen.getByRole("button", { name: "確認作廢" }));
      await waitFor(() => {
        expect(onVoided).toHaveBeenCalledTimes(1);
      });
      expect(screen.queryByText("作廢原因不得超過 500 字")).not.toBeInTheDocument();
      expect(router.countCalls("POST", isPostVoid)).toBe(2);
    });

    it("Error 409：顯示狀態衝突訊息並提供「重新載入」，點擊呼叫 onReload 且不再送出 POST", async () => {
      const router = installFetchRouter();
      router.on("POST", isPostVoid, () =>
        jsonRes(
          {
            error: {
              code: "CONFLICT",
              message: "僅已完成之申請可作廢",
              details: { status: "VOIDED" },
            },
          },
          409
        )
      );
      const { onReload, onVoided } = renderDialog();

      typeReason("誤植金額");
      fireEvent.click(screen.getByRole("button", { name: "確認作廢" }));

      expect(await screen.findByText("僅已完成之申請可作廢")).toBeInTheDocument();
      const reloadBtn = screen.getByRole("button", { name: "重新載入" });
      expect(onVoided).not.toHaveBeenCalled();

      fireEvent.click(reloadBtn);
      expect(onReload).toHaveBeenCalledTimes(1);
      expect(router.countCalls("POST", isPostVoid)).toBe(1);
    });

    it("Error 500：顯示錯誤訊息，零 onVoided，確認鈕回復可用（可重試）", async () => {
      const router = installFetchRouter();
      router.on("POST", isPostVoid, () =>
        jsonRes({ error: { code: "INTERNAL_ERROR", message: "系統發生錯誤，請稍後再試" } }, 500)
      );
      const { onVoided } = renderDialog();

      typeReason("誤植金額");
      fireEvent.click(screen.getByRole("button", { name: "確認作廢" }));

      expect(await screen.findByText("系統發生錯誤，請稍後再試")).toBeInTheDocument();
      expect(onVoided).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "確認作廢" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "重新載入" })).not.toBeInTheDocument();
      expect(router.countCalls("POST", isPostVoid)).toBe(1);
    });

    it("Permission denied：403 FORBIDDEN → 顯示無權限訊息，且零後續請求（原因欄與確認鈕皆不在場）", async () => {
      const router = installFetchRouter();
      router.on("POST", isPostVoid, () =>
        jsonRes({ error: { code: "FORBIDDEN", message: "無權存取此資源" } }, 403)
      );
      const { onVoided } = renderDialog();

      typeReason("誤植金額");
      fireEvent.click(screen.getByRole("button", { name: "確認作廢" }));

      expect(await screen.findByText("無權作廢此申請。")).toBeInTheDocument();
      expect(onVoided).not.toHaveBeenCalled();

      // 零後續請求：不提供確認鈕／重試鈕／重新載入鈕，且原因欄移除。
      expect(screen.queryByRole("button", { name: "確認作廢" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "重試" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "重新載入" })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("作廢原因")).not.toBeInTheDocument();

      expect(router.countCalls("POST", isPostVoid)).toBe(1);
      expect(router.totalCalls()).toBe(1);
    });
  });
});
