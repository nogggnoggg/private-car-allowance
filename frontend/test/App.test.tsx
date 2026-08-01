import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.js";

describe("App — /api/health 狀態顯示", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("當 fetch 回 {status:ok, checks:{db:up}} → 顯示「資料庫：連線正常」", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok", checks: { db: "up" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/後端：正常/)).toBeInTheDocument();
      expect(screen.getByText(/資料庫：連線正常/)).toBeInTheDocument();
    });
  });

  it("當 fetch 回 503 {status:error, checks:{db:down}} → 顯示「資料庫：無法連線」", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "error", checks: { db: "down" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/後端：正常/)).toBeInTheDocument();
      expect(screen.getByText(/資料庫：無法連線/)).toBeInTheDocument();
    });
  });

  it("當 fetch 拒絕（reject）→ 顯示「無法連線至後端」", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/無法連線至後端/)).toBeInTheDocument();
    });
  });
});
