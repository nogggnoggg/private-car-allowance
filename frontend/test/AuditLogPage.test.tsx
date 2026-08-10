/**
 * AuditLogPage 前端單元測試 — PHASE-010-T7（PHASE-010-T7R 擴充；
 * PHASE-010-T-MG1-FE 再擴充；PHASE-010-T-MG3-FE 三度擴充；
 * PHASE-010-CIFIX-TZ／PHASE-010-CIFIX-NNSP CI 紅燈修復）
 *
 * 涵蓋 AC-15（路由／入口／列表四要素）、AC-16（篩選與分頁 UI）、**AC-16(d)**
 * （SF-1 裁定之使用者下拉，T7R 新增）、AC-17（五態）、**SF-5**（切頁 Loading
 * 守門，T7R 新增）、追加①（`targetLabel` 之 AC-18(a) XSS 跳脫，頁面列渲染處
 * 自帶）、追加②（`createdAt` 之 AC-18(c) 在地化單一形式，與 T6 之 `changes`
 * 內 ISO 互補）、**BE2 即審 FW-1**（`dateFrom`／`dateTo` 送出值紅線，
 * T-MG1-FE 新增——見下方同名 describe 區塊檔頭之完整說明）、**AC-18(e)**
 * （MG-3 裁定之內部識別碼不呈現——`targetLabel` 面，T-MG3-FE 新增；AC-15(c)
 * 一格同批重錨定，見下方 describe 區塊）。
 *
 * **PHASE-010-CIFIX-NNSP（2026-08-10，CI 第三輪）**：全部「以裸
 * `new Date(iso).toLocaleString("zh-TW")` 建 `getByText` 期望字串」之處
 * （AC-17 Success 態／AC-15(c) 四要素／追加② createdAt 在地化，共三處）
 * 改經下方 `localized()` helper——Linux ICU 於日期與「上午/下午」間插入
 * U+2009 THIN SPACE（Windows 為 U+0020），Testing Library 之字串 matcher
 * 僅 normalize 元素文字、不 normalize matcher 本身，故裸用在 Linux CI 上
 * 永遠比對失敗、Windows 本機因兩側皆半形空格而偶合通過。詳見 `localized()`
 * 之函式註解。**本地全綠不代表已修復——最終驗證依賴 CI 重跑。**
 *
 * 測試策略沿用既有前端頁面慣例：
 *   - Permission denied：沿 `AdminUsersPage.test.tsx`「先查 authState.role 再
 *     決定是否發送列表請求」之既有模式（`AdminUsersPage.tsx` :71-79）——非管理員
 *     零後續請求，不倚賴後端真的回 403。
 *   - 篩選／分頁／五態：沿 `ApplicationListSection.test.tsx` 之
 *     `(fetch as Mock).mock.calls` 請求 URL 斷言手法（AC-16(c) 之「結構斷言」）。
 *
 * ---------------------------------------------------------------------------
 * T7R：fetch mock 由「呼叫序佇列」改為「依 URL 分流之三佇列」
 * ---------------------------------------------------------------------------
 * AC-16(d) 使本頁多出第三個端點（`GET /api/admin/users`，複用 `apiGetUsers`）。
 * 原先以 `mockResolvedValueOnce` 依**呼叫順序**排隊之手法，會使每一個測試都
 * 隱性耦合於元件內 `useEffect` 的執行順序（多掛一個 effect 就全盤錯位）。
 * 改為 `/api/me`／`/api/admin/users`／`/api/admin/audit-logs` 各自獨立佇列：
 * 測試只宣告它關心的端點回應，跨端點順序無關；未宣告之使用者清單回退為空集合
 * （多數測試不關心該欄），其餘端點缺 mock 則**明確 reject**（不靜默放行）。
 * 此為測試基礎設施之等價改寫——既有各格之斷言逐條保留，無任何弱化。
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

/**
 * AC-16(d)：`GET /admin/users` 之播種回應——兩個下拉之選項來源。
 * `id` 刻意取 `actor-9`／`target-9`（既有 AC-16(c) 之送出值），使「選項文字＝
 * 顯示名稱、送出值＝id」可同時被正向格與 AC-16(c) 之 query 斷言驗證。
 */
const SEEDED_USERS: UserDto[] = [
  {
    id: "actor-9",
    loginName: "admin2",
    displayName: "稽核管理員",
    employeeNumber: "EMP009",
    role: "ADMIN",
    isActive: true,
    mustChangePassword: false,
  },
  {
    id: "target-9",
    loginName: "user9",
    displayName: "受影響使用者",
    employeeNumber: null,
    role: "USER",
    isActive: true,
    mustChangePassword: false,
  },
];

// ---------------------------------------------------------------------------
// 依 URL 分流之 fetch mock（見檔頭 T7R 段落）
// ---------------------------------------------------------------------------

type ResponseThunk = () => Promise<Response>;

const queues: { me: ResponseThunk[]; users: ResponseThunk[]; audit: ResponseThunk[] } = {
  me: [],
  users: [],
  audit: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** `/api/admin/audit-logs` 必須先於 `/api/admin/users` 比對（前者為後者之前綴外形）。 */
function queueFor(url: string): ResponseThunk[] | null {
  if (url.includes("/api/me")) return queues.me;
  if (url.includes("/api/admin/audit-logs")) return queues.audit;
  if (url.includes("/api/admin/users")) return queues.users;
  return null;
}

function mockMeAs(user: UserDto) {
  queues.me.push(() => Promise.resolve(jsonResponse({ user })));
}

function mockUsers(users: UserDto[]) {
  queues.users.push(() => Promise.resolve(jsonResponse({ users })));
}

function mockUsersError(status: number, error: { code: string; message: string }) {
  queues.users.push(() => Promise.resolve(jsonResponse({ error }, status)));
}

function mockAuditList(body: {
  items: AuditLogListItemDto[];
  page: number;
  pageSize: number;
  total: number;
}) {
  queues.audit.push(() => Promise.resolve(jsonResponse(body)));
}

function mockAuditListError(
  status: number,
  error: { code: string; message: string; fields?: Array<{ field: string; reason: string }> }
) {
  queues.audit.push(() => Promise.resolve(jsonResponse({ error }, status)));
}

/** 稽核列表回應永不 resolve —— 用於把畫面釘在 Loading 態（AC-17／SF-5）。 */
function mockAuditListHanging() {
  queues.audit.push(() => new Promise<Response>(() => {}));
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

/**
 * PHASE-010-CIFIX-NNSP：`new Date(iso).toLocaleString("zh-TW")` 之期望字串
 * 「裸用」於 `getByText` 在 Linux ICU 下必炸——Linux 之 `toLocaleString`
 * 在日期與「上午/下午」間插入 U+2009 THIN SPACE（Windows 為一般半形空格
 * U+0020）。Testing Library 的字串 matcher 比對為
 * `normalizer(elementText) === matcher`：**元素文字被 normalize**
 * （`\s+` → 單一空格，U+2009 ∈ `\s`），**matcher 字串本身不 normalize**
 * ——故 Linux 上 normalize 後之元素文字（半形空格）永遠不等於含 U+2009 之
 * 期望字串，`getByText` 必然找不到；Windows 因兩側皆為半形空格而偶合通過。
 * 本 helper 與 Testing Library 預設 normalizer 同式（collapse whitespace），
 * 使期望字串與元素文字在比對前皆已正規化——**禁止簡化回裸
 * `toLocaleString`**，那正是本次 CI 紅燈之根因。
 */
function localized(iso: string): string {
  return new Date(iso).toLocaleString("zh-TW").replace(/\s+/g, " ");
}

describe("AuditLogPage", () => {
  beforeEach(() => {
    queues.me = [];
    queues.users = [];
    queues.audit = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const queue = queueFor(url);
      if (queue === null) return Promise.reject(new Error(`未預期的請求：${url}`));
      const next = queue.shift();
      if (next) return next();
      // 未宣告之使用者清單 → 空集合（多數測試不關心該欄）；其餘端點缺 mock
      // 一律明確 reject，不靜默放行成真實網路請求。
      if (queue === queues.users) return Promise.resolve(jsonResponse({ users: [] }));
      return Promise.reject(new Error(`缺少 mock 回應：${url}`));
    });
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
      mockAuditListHanging();

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
      expect(screen.getByText(localized("2026-08-09T03:21:00.000Z"))).toBeInTheDocument();
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
      // AC-18(e-1)（MG-3 重錨定，T-MG3-FE）：targetLabel 只呈現第一個 `#` 前段，
      // 內部申請編號（`#app-9`）於全頁零命中——原斷言 `/user1#app-9/` 已隨此
      // 裁定改為下列正負向兩格（不得刪格，見 §15 T-MG3-FE 機械連動預授權）。
      expect(screen.getByText(/^user1/)).toBeInTheDocument();
      expect(screen.queryByText(/#app-9/)).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain("#app-9");
      expect(screen.getByText(/使用者一/)).toBeInTheDocument();
      expect(screen.getByText(localized("2026-08-09T03:21:00.000Z"))).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // AC-18(e)：內部識別碼不呈現（MG-3，T-MG3-FE 新增）
  // ==========================================================================
  //
  // 人類 leonchih 2026-08-10 Mock Gate 第二輪 MG-3 裁定逐字：「內部申請編號
  // （cuid）對人類無意義，畫面不顯示、資料庫可查即可」；同日消歧裁定＝
  // 「兩處都拿掉」。本 describe 涵蓋 (e-1)(e-7) 之 `targetLabel` 呈現面
  // （明細列面之 (e-2)~(e-5) 見 `AuditChangesList.test.tsx`）。
  describe("AC-18(e): 內部識別碼不呈現（MG-3）", () => {
    it("帳號#編號 只顯示帳號段，# 後段字面於全頁零命中", async () => {
      mockMeAs(adminUser);
      mockAuditList({
        items: [
          baseItem({
            action: "APPLICATION_VOIDED",
            targetLabel: "user1#app-9",
            targetDisplayName: null,
          }),
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      });
      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText("user1")).toBeInTheDocument();
      });
      expect(document.body.textContent).not.toContain("#app-9");
    });

    it("參數型 FUEL_PRICE#<cuid> 只顯示 FUEL_PRICE", async () => {
      mockMeAs(adminUser);
      mockAuditList({
        items: [
          baseItem({
            action: "PARAMETER_VERSION_CREATED",
            targetLabel: "FUEL_PRICE#param-cuid-1",
            targetDisplayName: null,
          }),
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      });
      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText("FUEL_PRICE")).toBeInTheDocument();
      });
      expect(document.body.textContent).not.toContain("param-cuid-1");
      expect(document.body.textContent).not.toContain("FUEL_PRICE#");
    });

    it("B-30 無 # 之 targetLabel 原樣全字呈現（不截斷）", async () => {
      mockMeAs(adminUser);
      mockAuditList({
        items: [
          baseItem({
            action: "USER_DELETED",
            targetLabel: "已刪除帳號快照-user1",
            targetDisplayName: null,
          }),
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      });
      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText("已刪除帳號快照-user1")).toBeInTheDocument();
      });
    });

    it("(e-7) 顯示名稱去重以裁切後之值比較——不得出現「alice（alice）」", async () => {
      mockMeAs(adminUser);
      mockAuditList({
        items: [
          baseItem({
            action: "APPLICATION_VOIDED",
            targetLabel: "alice#app-42",
            targetDisplayName: "alice",
          }),
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      });
      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText("alice")).toBeInTheDocument();
      });
      expect(screen.queryByText(/alice（alice）/)).not.toBeInTheDocument();
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
      // T7R／AC-16(d)：操作者與受影響對象改為使用者下拉，選取值須為清單內之
      // 真實 id，故本格改以播種使用者提供 `actor-9`／`target-9` 兩個選項。
      mockUsers(SEEDED_USERS);
      mockAuditList({ items: [], page: 1, pageSize: 20, total: 0 });
      renderAuditLogPage();
      await waitFor(() => expect(screen.getByText("尚無任何稽核紀錄。")).toBeInTheDocument());
      // 使用者清單到齊後兩下拉才可用（AC-16(d) 之降級設計）
      await waitFor(() => expect(screen.getByLabelText("操作者")).not.toBeDisabled());

      mockAuditList({ items: [], page: 1, pageSize: 20, total: 0 });
      fireEvent.change(screen.getByLabelText("操作類型"), {
        target: { value: "APPLICATION_VOIDED" },
      });
      fireEvent.change(screen.getByLabelText("操作者"), { target: { value: "actor-9" } });
      fireEvent.change(screen.getByLabelText("受影響對象"), { target: { value: "target-9" } });
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
  // BE2 即審 FW-1（T-MG1-FE 新增；PHASE-010-CIFIX-TZ 修正）：
  // dateFrom/dateTo 送出值紅線
  // ==========================================================================
  //
  // 實查（T-MG1-FE）：`AuditLogPage.tsx` 之 `load()`（`dateFrom: f.dateFrom ||
  // undefined`）與 `api/audit.ts` 之 `apiListAuditLogs`（`search.set("dateFrom",
  // params.dateFrom)`）皆**直傳** `<input type="date">` 之 `e.target.value`
  // 字串，零 `Date` 物件轉換——已直傳，本節純屬**守門新增**（防未來回歸），
  // 非行為變更（依 Packet FW-1：「已直傳則此格為守門新增非行為變更」）。
  //
  // **PHASE-010-CIFIX-TZ（2026-08-10）**：T-MG1-FE 原版曾以
  // `process.env.TZ = "America/Los_Angeles"`（釘死負偏移時區）執行本格，
  // 意圖使守門對「經本地時間方法之日期往返」回歸具真實鑑別力（本機
  // `Asia/Taipei` 為正偏移，同型回歸不會位移，守門會零鑑別力）。此法**曾
  // 被誤判**為 PR #19 首跑 CI（Linux）本檔另外三格（AC-17 Success 態／
  // AC-15(c) 四要素／追加② createdAt 在地化）之變紅根因（本機 Windows
  // 全綠、CI Linux 才紅，表徵與 PHASE-008 T2 SF-1 之 TZ 污染守門同族，
  // 診斷方向合理但**經 CIFIX-NNSP 於 Linux 容器十六進位傾印覆核後證實非
  // 真根因**——真根因是 Testing Library 字串 matcher 之正規化不對稱，見
  // 檔頭與下方 `localized()` helper 之說明，與本格之 `TZ` 操作無關）。
  // 惟本格移除 `process.env.TZ` 之全域寫入**本身仍是正確的測試衛生改進**
  // （零跨測試洩漏風險）——予以保留，不因根因判讀落差而回退。
  //
  // 改採**移除渲染面**（不釘死全域 `TZ`）：本格斷言之標的本就只是「送出
  // 之 query 字串是否逐字等於使用者所選 `YYYY-MM-DD`」，不需要、也不應該
  // 依賴任何時區才能成立——`YYYY-MM-DD` 逐字相等本身即可鑑別絕大多數真實
  // 回歸（任何經 `.toLocaleDateString()`／`.toISOString()` 等 `Date` 往返
  // 之路徑，只要輸出格式或數值與原始輸入字面不同即必紅，不論宿主時區）。
  // 唯一逃逸的極窄案例＝「轉換後格式恰為 `YYYY-MM-DD` 且數值恰好不變」
  // ——此案例本身即不構成 bug（值未變）。零環境變數操作，對本檔或其他檔
  // 之任何測試皆為零洩漏。
  describe("BE2 即審 FW-1: dateFrom/dateTo 送出值紅線（T-MG1-FE）", () => {
    it("dateFrom／dateTo 送出值逐字等於使用者所選 YYYY-MM-DD 字串", async () => {
      mockMeAs(adminUser);
      mockAuditList({ items: [], page: 1, pageSize: 20, total: 0 });
      renderAuditLogPage();
      await waitFor(() => expect(screen.getByText("尚無任何稽核紀錄。")).toBeInTheDocument());

      mockAuditList({ items: [], page: 1, pageSize: 20, total: 0 });
      fireEvent.change(screen.getByLabelText("起日"), { target: { value: "2026-08-01" } });
      fireEvent.change(screen.getByLabelText("迄日"), { target: { value: "2026-08-31" } });
      fireEvent.click(screen.getByRole("button", { name: "套用篩選" }));

      await waitFor(() => {
        const calls = (fetch as Mock).mock.calls;
        const last = String(calls[calls.length - 1]?.[0]);
        // 逐字相等（非僅 toContain 子字串）：任何經 Date 往返之格式／數值
        // 變化皆必紅，且不依賴任何全域環境狀態（零跨測試洩漏風險）。
        const url = new URL(last, "http://localhost");
        expect(url.searchParams.get("dateFrom")).toBe("2026-08-01");
        expect(url.searchParams.get("dateTo")).toBe("2026-08-31");
      });
    });
  });

  // ==========================================================================
  // AC-16(d)：操作者／受影響對象兩篩選欄為使用者下拉（SF-1 人類裁定 2026-08-09）
  // ==========================================================================
  describe("AC-16(d): 使用者下拉篩選", () => {
    it("AC-16(d) 正向：兩篩選欄為使用者下拉——選項文字為顯示名稱、送出值為 id，清單來自 apiGetUsers", async () => {
      mockMeAs(adminUser);
      mockUsers(SEEDED_USERS);
      mockAuditList({ items: [], page: 1, pageSize: 20, total: 0 });
      renderAuditLogPage();
      await waitFor(() => expect(screen.getByText("尚無任何稽核紀錄。")).toBeInTheDocument());
      await waitFor(() => expect(screen.getByLabelText("操作者")).not.toBeDisabled());

      // 清單複用既有使用者清單 API（`apiGetUsers` → GET /api/admin/users），不另立端點
      const calledUrls = (fetch as Mock).mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calledUrls.some((u) => u.includes("/api/admin/users"))).toBe(true);

      const actorSelect = screen.getByLabelText("操作者");
      const targetSelect = screen.getByLabelText("受影響對象");
      expect(actorSelect.tagName).toBe("SELECT");
      expect(targetSelect.tagName).toBe("SELECT");

      // 選項文字＝顯示名稱；送出值＝id（兩下拉皆然）
      for (const select of [actorSelect, targetSelect]) {
        const scoped = within(select);
        const actorOption = scoped.getByRole("option", { name: /稽核管理員/ }) as HTMLOptionElement;
        const targetOption = scoped.getByRole("option", {
          name: /受影響使用者/,
        }) as HTMLOptionElement;
        expect(actorOption.value).toBe("actor-9");
        expect(targetOption.value).toBe("target-9");
      }

      // 選取後，請求以 id 為送出值（非顯示名稱）
      mockAuditList({ items: [], page: 1, pageSize: 20, total: 0 });
      fireEvent.change(actorSelect, { target: { value: "actor-9" } });
      fireEvent.change(targetSelect, { target: { value: "target-9" } });
      fireEvent.click(screen.getByRole("button", { name: "套用篩選" }));

      await waitFor(() => {
        const calls = (fetch as Mock).mock.calls;
        const last = String(calls[calls.length - 1]?.[0]);
        expect(last).toContain("actorId=actor-9");
        expect(last).toContain("targetId=target-9");
      });
      // 負向：送出值不得為顯示名稱
      const lastUrl = String(
        (fetch as Mock).mock.calls[(fetch as Mock).mock.calls.length - 1]?.[0]
      );
      expect(lastUrl).not.toContain("稽核管理員");
      expect(lastUrl).not.toContain(encodeURIComponent("稽核管理員"));
    });

    it("AC-16(d) 負向：篩選區不得存在純文字 id 輸入欄", async () => {
      mockMeAs(adminUser);
      mockUsers(SEEDED_USERS);
      mockAuditList({ items: [], page: 1, pageSize: 20, total: 0 });
      renderAuditLogPage();
      await waitFor(() => expect(screen.getByText("尚無任何稽核紀錄。")).toBeInTheDocument());

      // 篩選表單內之 <input> 僅允許兩個日期欄；任何文字輸入框即違反 AC-16(d)
      const form = screen.getByRole("form", { name: "篩選稽核紀錄" });
      const inputs = Array.from(form.querySelectorAll("input"));
      expect(inputs.map((el) => el.type).sort()).toEqual(["date", "date"]);

      // 原純文字實作之無障礙名稱不得再存在
      expect(screen.queryByLabelText("操作者 ID")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("受影響對象 ID")).not.toBeInTheDocument();
    });

    it("AC-16(d) 降級：使用者清單載入失敗時兩下拉停用並提示，稽核列表與其餘篩選照常（篩選不阻斷主功能）", async () => {
      mockMeAs(adminUser);
      mockUsersError(500, { code: "INTERNAL_ERROR", message: "伺服器錯誤" });
      mockAuditList({ items: [baseItem()], page: 1, pageSize: 20, total: 1 });
      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByText(/使用者清單載入失敗/)).toBeInTheDocument();
      });
      expect(screen.getByLabelText("操作者")).toBeDisabled();
      expect(screen.getByLabelText("受影響對象")).toBeDisabled();

      // 主功能不受影響：列表照常渲染，其餘篩選控制項可用
      expect(screen.getByRole("list", { name: "稽核紀錄清單" })).toBeInTheDocument();
      expect(screen.getByText("user1")).toBeInTheDocument();
      expect(screen.getByLabelText("操作類型")).not.toBeDisabled();
      expect(screen.getByRole("button", { name: "套用篩選" })).not.toBeDisabled();
    });
  });

  // ==========================================================================
  // SF-5（期中複審 #2 M15 存活）：切頁／套用篩選期間之 Loading 守門
  // §4 表逐字：「列表區不渲染舊資料之殘影；篩選控制項停用」「切頁時同左；
  // 重複點擊不併發送出（送出中停用）」
  // ==========================================================================
  describe("SF-5: 切頁期間之 Loading 守門", () => {
    it("切頁請求掛起中：列表區零舊資料殘影、篩選控制項全停用、且無從重複送出", async () => {
      mockMeAs(adminUser);
      mockUsers(SEEDED_USERS);
      const items = Array.from({ length: 3 }, (_, i) =>
        baseItem({ id: `audit-${i}`, targetLabel: `stale-user-${i}` })
      );
      mockAuditList({ items, page: 1, pageSize: 20, total: 45 });
      renderAuditLogPage();

      await waitFor(() => {
        expect(screen.getByRole("list", { name: "稽核紀錄清單" })).toBeInTheDocument();
      });
      expect(
        within(screen.getByRole("list", { name: "稽核紀錄清單" })).getAllByRole("listitem")
      ).toHaveLength(3);

      // 第二次（切頁）回應永不 resolve → 畫面釘在切頁中的 Loading 態
      mockAuditListHanging();
      fireEvent.click(screen.getByRole("button", { name: "下一頁" }));

      await waitFor(() => {
        expect(screen.getByText(/載入中/)).toBeInTheDocument();
      });

      // (1) 列表區不渲染舊資料之殘影
      expect(screen.queryByRole("list", { name: "稽核紀錄清單" })).not.toBeInTheDocument();
      for (const item of items) {
        expect(screen.queryByText(item.targetLabel)).not.toBeInTheDocument();
      }

      // (2) 篩選控制項停用（五欄兩鈕逐一）
      expect(screen.getByLabelText("操作類型")).toBeDisabled();
      expect(screen.getByLabelText("操作者")).toBeDisabled();
      expect(screen.getByLabelText("受影響對象")).toBeDisabled();
      expect(screen.getByLabelText("起日")).toBeDisabled();
      expect(screen.getByLabelText("迄日")).toBeDisabled();
      expect(screen.getByRole("button", { name: "套用篩選" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "清除篩選" })).toBeDisabled();

      // (3) 重複點擊不併發送出：分頁鈕隨列表一併退場，停用中之「套用篩選」點擊零新增請求
      expect(screen.queryByRole("button", { name: "下一頁" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "上一頁" })).not.toBeInTheDocument();
      const callsDuringLoading = (fetch as Mock).mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "套用篩選" }));
      fireEvent.click(screen.getByRole("button", { name: "清除篩選" }));
      expect((fetch as Mock).mock.calls.length).toBe(callsDuringLoading);
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
        expect(screen.getByText(localized(iso))).toBeInTheDocument();
      });
      // 負向：ISO 原字串不得逐字出現在畫面（createdAt 欄自身；changes[] 內之 ISO 屬 T6 範圍不在此檢查）
      expect(screen.queryByText(iso)).not.toBeInTheDocument();
    });
  });
});
