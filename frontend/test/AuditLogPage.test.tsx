/**
 * AuditLogPage 前端單元測試 — PHASE-010-T7
 *
 * 涵蓋 AC-15（路由／入口／列表四要素）、AC-16（篩選與分頁 UI）、AC-17（五態）、
 * 追加①（`targetLabel` 之 AC-18(a) XSS 跳脫，頁面列渲染處自帶）、追加②
 * （`createdAt` 之 AC-18(c) 在地化單一形式，與 T6 之 `changes` 內 ISO 互補）。
 *
 * 測試策略沿用既有前端頁面慣例：
 *   - Permission denied：沿 `AdminUsersPage.test.tsx`「先查 authState.role 再
 *     決定是否發送列表請求」之既有模式（`AdminUsersPage.tsx` :71-79）——非管理員
 *     零後續請求，不倚賴後端真的回 403。
 *   - 篩選／分頁／五態：沿 `ApplicationListSection.test.tsx` 之
 *     `(fetch as Mock).mock.calls` 請求 URL 斷言手法（AC-16(c) 之「結構斷言」）。
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { AuthProvider } from "../src/context/AuthContext.js";
import AuditLogPage from "../src/pages/AuditLogPage.js";
import type { AuditLogListItemDto, UserDto } from "../src/types/api.js";

const adminUser: UserDto = {
  id: "admin-id",
  loginName: "admin",
  displayName: "管理員",
  employeeNumber: "EMP000",
  role: "ADMIN",
  isActive: true,
  mustChangePassword: false,
};

const regularUser: UserDto = {
  id: "user-id-1",
  loginName: "user1",
  displayName: "使用者一",
  employeeNumber: null,
  role: "USER",
  isActive: true,
  mustChangePassword: false,
};

function mockMeAs(user: UserDto) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ user }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockAuditList(body: {
  items: AuditLogListItemDto[];
  page: number;
  pageSize: number;
  total: number;
}) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockAuditListError(
  status: number,
  error: { code: string; message: string; fields?: Array<{ field: string; reason: string }> }
) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function baseItem(overrides: Partial<AuditLogListItemDto> = {}): AuditLogListItemDto {
  return {
    id: "audit-1",
    action: "USER_CREATED",
    createdAt: "2026-08-09T03:21:00.000Z",
    actorDisplayName: "管理員",
    targetLabel: "user1",
    // targetDisplayName 預設 null（沿 AC-04(c) 邊界，且避免與 targetLabel
    // 併陳呈現時 getByText 精確比對被組合字串「user1（使用者一）」卡住——
    // 併陳呈現另有專用測試覆蓋，見下方「AC-15(c)」測試）。
    targetDisplayName: null,
    changes: [],
    ...overrides,
  };
}

function renderAuditLogPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/audit-logs"]}>
      <AuthProvider>
        <Routes>
          <Route path="/admin/audit-logs" element={<AuditLogPage />} />
          <Route path="/" element={<div>首頁占位</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("AuditLogPage", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // AC-17：五態
  // ==========================================================================
  describe("AC-17: 五態", () => {
    it("Loading 態：顯示載入中，且篩選控制項停用", async () => {
      mockMeAs(adminUser);
      // /api/admin/audit-logs 掛起，永不 resolve
      (fetch as Mock).mockImplementation((url: string) => {
        if (typeof url === "string" && url.includes("/api/me")) {
          return Promise.resolve(
            new Response(JSON.stringify({ user: adminUser }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          );
        }
        return new Promise(() => {});
      });

      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText(/載入中/)).toBeInTheDocument();
      });
      expect(screen.getByLabelText("操作類型")).toBeDisabled();
      // 舊資料殘影：列表區不得渲染任何稽核列
      expect(screen.queryByRole("list", { name: "稽核紀錄清單" })).not.toBeInTheDocument();
    });

    it("Empty 態（無篩選）：顯示「尚無任何稽核紀錄」", async () => {
      mockMeAs(adminUser);
      mockAuditList({ items: [], page: 1, pageSize: 20, total: 0 });

      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText("尚無任何稽核紀錄。")).toBeInTheDocument();
      });
    });

    it("Empty 態（篩選導致空集合）：文案與「尚無任何稽核紀錄」可區辨", async () => {
      mockMeAs(adminUser);
      mockAuditList({ items: [baseItem()], page: 1, pageSize: 20, total: 1 });
      renderAuditLogPage();
      await waitFor(() => expect(screen.getByText("user1")).toBeInTheDocument());

      mockAuditList({ items: [], page: 1, pageSize: 20, total: 0 });
      fireEvent.change(screen.getByLabelText("操作類型"), { target: { value: "USER_CREATED" } });
      fireEvent.click(screen.getByRole("button", { name: "套用篩選" }));

      await waitFor(() => {
        expect(screen.getByText("查無稽核紀錄。")).toBeInTheDocument();
      });
      expect(screen.queryByText("尚無任何稽核紀錄。")).not.toBeInTheDocument();
    });

    it("Error 態（500）：顯示錯誤訊息與重試鈕，重試不重複送出", async () => {
      mockMeAs(adminUser);
      mockAuditListError(500, { code: "INTERNAL_ERROR", message: "伺服器錯誤，請稍後再試。" });

      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText("伺服器錯誤，請稍後再試。")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "重試" })).toBeInTheDocument();
      });

      const callsBeforeRetry = (fetch as Mock).mock.calls.length;
      mockAuditList({ items: [], page: 1, pageSize: 20, total: 0 });
      fireEvent.click(screen.getByRole("button", { name: "重試" }));

      // 重試中：按鈕消失（loading 態取代 error 態），無法連續點擊造成併發送出
      expect(screen.queryByRole("button", { name: "重試" })).not.toBeInTheDocument();

      await waitFor(() => {
        expect(screen.getByText("尚無任何稽核紀錄。")).toBeInTheDocument();
      });
      // 僅一次新增的請求（重試本身），未被重複觸發
      expect((fetch as Mock).mock.calls.length).toBe(callsBeforeRetry + 1);
    });

    it("Error 態（400 篩選參數違規）：逐欄提示 fields[].reason", async () => {
      mockMeAs(adminUser);
      mockAuditListError(400, {
        code: "VALIDATION_ERROR",
        message: "參數驗證失敗",
        fields: [{ field: "dateFrom", reason: "起日不得晚於迄日" }],
      });

      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText(/起日不得晚於迄日/)).toBeInTheDocument();
      });
    });

    it("Success 態：列表渲染 N 列，每列四要素，並顯示共 M 筆", async () => {
      mockMeAs(adminUser);
      mockAuditList({
        items: [
          baseItem({
            id: "audit-1",
            action: "USER_CREATED",
            createdAt: "2026-08-09T03:21:00.000Z",
            actorDisplayName: "管理員",
            targetLabel: "user1",
          }),
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      });

      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText("管理員")).toBeInTheDocument();
      });
      // 四要素：操作時間（在地化，見追加②獨立描述）／操作者／操作類型（中文標籤）／受影響資料
      expect(
        screen.getByText(new Date("2026-08-09T03:21:00.000Z").toLocaleString("zh-TW"))
      ).toBeInTheDocument();
      // 操作類型中文標籤同時出現在篩選下拉的 <option>，用 list 範圍鎖定實際列渲染。
      const list = screen.getByRole("list", { name: "稽核紀錄清單" });
      expect(within(list).getByText("新增使用者")).toBeInTheDocument();
      expect(screen.getByText("user1")).toBeInTheDocument();
      expect(screen.getByText(/共 1 筆/)).toBeInTheDocument();
    });

    it("Permission denied 態：一般使用者顯示無權限訊息，零後續請求，無重試鈕，零稽核內容", async () => {
      mockMeAs(regularUser);
      // 刻意不 mock /api/admin/audit-logs——若元件誤打此請求，fetch 呼叫數斷言會失敗。

      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText(/存取被拒/)).toBeInTheDocument();
      });
      expect(screen.getByText(/沒有權限/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "重試" })).not.toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "稽核紀錄清單" })).not.toBeInTheDocument();
      // 僅 /api/me 一次請求，零稽核端點請求
      expect((fetch as Mock).mock.calls.length).toBe(1);
      const calledUrls = (fetch as Mock).mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calledUrls.some((u) => u.includes("/api/admin/audit-logs"))).toBe(false);
    });
  });

  // ==========================================================================
  // AC-15：路由、入口與列表欄位
  // ==========================================================================
  describe("AC-15: 路由與列表欄位", () => {
    it("AC-15(a)：非管理員進入 /admin/audit-logs 不渲染任何稽核內容", async () => {
      mockMeAs(regularUser);
      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText(/存取被拒/)).toBeInTheDocument();
      });
      expect(screen.queryByLabelText("操作類型")).not.toBeInTheDocument();
    });

    it("AC-15(c)：列表逐列顯示四要素（操作時間／操作者／操作類型／受影響資料）", async () => {
      mockMeAs(adminUser);
      mockAuditList({
        items: [
          baseItem({
            action: "APPLICATION_VOIDED",
            actorDisplayName: "管理員",
            targetLabel: "user1#app-9",
            targetDisplayName: "使用者一",
          }),
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      });
      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText("管理員")).toBeInTheDocument();
      });
      // 操作類型中文標籤同時出現在篩選下拉的 <option>，用 list 範圍鎖定實際列渲染。
      const list = screen.getByRole("list", { name: "稽核紀錄清單" });
      expect(within(list).getByText("申請作廢")).toBeInTheDocument();
      // AC-04(c)：受影響資料＝targetLabel，必要時併 targetDisplayName——同一
      // <span> 內兩者皆逐字可見（非精確等於單一字串，因併陳呈現分屬多個文字節點）。
      expect(screen.getByText(/user1#app-9/)).toBeInTheDocument();
      expect(screen.getByText(/使用者一/)).toBeInTheDocument();
      expect(
        screen.getByText(new Date("2026-08-09T03:21:00.000Z").toLocaleString("zh-TW"))
      ).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // AC-16：篩選與分頁 UI
  // ==========================================================================
  describe("AC-16: 篩選與分頁 UI", () => {
    it("AC-16(a)：篩選變更即重置 page 為 1（先翻頁至 2，再套用篩選 → 請求帶 page=1）", async () => {
      mockMeAs(adminUser);
      const items = Array.from({ length: 20 }, (_, i) => baseItem({ id: `audit-${i}` }));
      mockAuditList({ items, page: 1, pageSize: 20, total: 45 });
      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText(/第 1 \/ 3 頁/)).toBeInTheDocument();
      });

      mockAuditList({ items: [], page: 2, pageSize: 20, total: 45 });
      fireEvent.click(screen.getByRole("button", { name: "下一頁" }));
      await waitFor(() => {
        const calls = (fetch as Mock).mock.calls;
        const last = String(calls[calls.length - 1]?.[0]);
        expect(last).toContain("page=2");
      });

      mockAuditList({ items: [], page: 1, pageSize: 20, total: 0 });
      fireEvent.change(screen.getByLabelText("操作類型"), { target: { value: "USER_CREATED" } });
      fireEvent.click(screen.getByRole("button", { name: "套用篩選" }));

      await waitFor(() => {
        const calls = (fetch as Mock).mock.calls;
        const last = String(calls[calls.length - 1]?.[0]);
        expect(last).toContain("page=1");
        expect(last).toContain("action=USER_CREATED");
      });
    });

    it("AC-16(b)：首頁「上一頁」停用、末頁「下一頁」停用", async () => {
      mockMeAs(adminUser);
      mockAuditList({ items: [baseItem()], page: 1, pageSize: 20, total: 1 });
      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "上一頁" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "下一頁" })).toBeDisabled();
      });
    });

    it("AC-16(c)：篩選與分頁參數確實經 query 送後端（請求 URL 含該參數）", async () => {
      mockMeAs(adminUser);
      mockAuditList({ items: [], page: 1, pageSize: 20, total: 0 });
      renderAuditLogPage();
      await waitFor(() => expect(screen.getByText("尚無任何稽核紀錄。")).toBeInTheDocument());

      mockAuditList({ items: [], page: 1, pageSize: 20, total: 0 });
      fireEvent.change(screen.getByLabelText("操作類型"), {
        target: { value: "APPLICATION_VOIDED" },
      });
      fireEvent.change(screen.getByLabelText("操作者 ID"), { target: { value: "actor-9" } });
      fireEvent.change(screen.getByLabelText("受影響對象 ID"), { target: { value: "target-9" } });
      fireEvent.change(screen.getByLabelText("起日"), { target: { value: "2026-08-01" } });
      fireEvent.change(screen.getByLabelText("迄日"), { target: { value: "2026-08-31" } });
      fireEvent.click(screen.getByRole("button", { name: "套用篩選" }));

      await waitFor(() => {
        const calls = (fetch as Mock).mock.calls;
        const last = String(calls[calls.length - 1]?.[0]);
        expect(last).toContain("action=APPLICATION_VOIDED");
        expect(last).toContain("actorId=actor-9");
        expect(last).toContain("targetId=target-9");
        expect(last).toContain("dateFrom=2026-08-01");
        expect(last).toContain("dateTo=2026-08-31");
        expect(last).toContain("page=1");
        expect(last).toContain("pageSize=20");
      });
    });
  });

  // ==========================================================================
  // 追加①（T6 W-3）：targetLabel 之 AC-18(a) XSS 跳脫
  // ==========================================================================
  describe("追加①: targetLabel 之 AC-18(a) XSS 跳脫", () => {
    it("三型 payload 逐字以純文字節點呈現，DOM 零新增 script 節點", async () => {
      mockMeAs(adminUser);
      const scriptPayload = "<script>document.title = 'xss-target-1'</script>";
      const imgOnerrorPayload = '"><img src=x onerror="document.title = \'xss-target-2\'">';
      const javascriptUriPayload = "javascript:document.title = 'xss-target-3'";

      mockAuditList({
        items: [
          baseItem({ id: "audit-x1", targetLabel: scriptPayload, targetDisplayName: null }),
          baseItem({ id: "audit-x2", targetLabel: imgOnerrorPayload, targetDisplayName: null }),
          baseItem({ id: "audit-x3", targetLabel: javascriptUriPayload, targetDisplayName: null }),
        ],
        page: 1,
        pageSize: 20,
        total: 3,
      });

      const scriptCountBefore = document.querySelectorAll("script").length;
      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText(scriptPayload)).toBeInTheDocument();
      });
      expect(screen.getByText(imgOnerrorPayload)).toBeInTheDocument();
      expect(screen.getByText(javascriptUriPayload)).toBeInTheDocument();

      expect(document.querySelectorAll("script").length).toBe(scriptCountBefore);
      expect(document.title).not.toMatch(/^xss-target-/);
    });
  });

  // ==========================================================================
  // 追加②（T6 W-2 互補）：createdAt 之 AC-18(c) 在地化單一形式
  // ==========================================================================
  describe("追加②: createdAt 之 AC-18(c) 在地化單一形式", () => {
    it("操作時間欄以在地化字串呈現，同頁不並存 ISO 原字串", async () => {
      mockMeAs(adminUser);
      const iso = "2026-08-09T03:21:00.000Z";
      mockAuditList({
        items: [baseItem({ createdAt: iso })],
        page: 1,
        pageSize: 20,
        total: 1,
      });

      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText(new Date(iso).toLocaleString("zh-TW"))).toBeInTheDocument();
      });
      // 負向：ISO 原字串不得逐字出現在畫面（createdAt 欄自身；changes[] 內之 ISO 屬 T6 範圍不在此檢查）
      expect(screen.queryByText(iso)).not.toBeInTheDocument();
    });
  });
});
