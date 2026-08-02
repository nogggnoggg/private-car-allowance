/**
 * PHASE-004-R8 — 前端 API 呼叫層回歸防線：無 body 的 mutation 呼叫不得宣告
 * `Content-Type` header。
 *
 * 缺陷背景：`apiCompleteApplication`（`src/api/applications.ts`）曾對
 * `POST /applications/:id/complete` 設定 `headers: { "Content-Type":
 * "application/json" }` 卻不帶 `body`。Fastify 的預設 JSON body parser 對
 * 「宣告 JSON 但空 body」的請求會在 wire level（早於任何 auth
 * preHandler）丟出例外，被全域 error handler 轉成 500 INTERNAL_ERROR——即
 * 使完全未登入、資源不存在皆然，本應是 401。真實瀏覽器下「完成申請」因此
 * 每次都失敗（AC-49~54 自 T13 交付以來對真實使用者從未真正可用）。
 *
 * 為何既有測試測不到：`test/TravelApplicationPage.test.tsx` 等頁面測試以
 * `vi.spyOn(globalThis, "fetch").mockImplementation(...)` 攔截 fetch 並直接
 * 回傳假回應，完全不檢查呼叫時實際傳入的 `RequestInit`（例如有沒有多宣告
 * 一個沒對應 body 的 header）——這一層的 mock 天生看不到這類「送出去的
 * request 形狀本身有問題」的缺陷；後端整合測試套件則因為
 * `app.inject` 呼叫一律不明確設定該 header 而同樣測不到（見
 * `backend/test/integration/phase4-r8-wire-level-empty-json-body.test.ts`
 * 的完整說明）。
 *
 * 本檔的定位：這是唯一能真正**預防**這類缺陷重演的一層——直接針對
 * `src/api/**` 匯出的每一個「沒有 request body」的 mutation 函式，斷言它
 * 們實際傳給 `fetch` 的 `RequestInit` 不會同時滿足「宣告
 * `Content-Type`」且「沒有 `body`」。未來若有人不小心在這些函式之一重新
 * 加上多餘的 Content-Type header（或反過來，在有 body 的函式忘記帶
 * body），本檔會立刻失敗。
 *
 * 涵蓋範圍（R8 Packet「盲區稽核」要求）：對 `frontend/src/api/**` 全庫掃描
 * 後，「無 body 的 mutation 呼叫」共 7 個匯出函式，全部納入本檔：
 *   - apiCompleteApplication / apiDeleteApplication（applications.ts）
 *   - apiLogout（auth.ts）
 *   - apiDeleteAttachment（attachments.ts）
 *   - apiDeactivateUser / apiActivateUser / apiDeleteUser（users.ts）
 * （`apiUploadAttachment` 用 FormData 送 body，不在此列——FormData 請求本來
 * 就不該手動宣告 Content-Type，交給瀏覽器自動帶 boundary，屬於另一類已知
 * 正確的模式，非本回歸防線的涵蓋對象。）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { apiCompleteApplication, apiDeleteApplication } from "../src/api/applications.js";
import { apiDeleteAttachment } from "../src/api/attachments.js";
import { apiLogout } from "../src/api/auth.js";
import { apiActivateUser, apiDeactivateUser, apiDeleteUser } from "../src/api/users.js";

function okJsonResponse(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Extract the RequestInit-ish object passed as fetch's 2nd arg (may be undefined). */
function callInit(mock: Mock, callIndex = 0): RequestInit | undefined {
  return mock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
}

function hasContentTypeHeader(init: RequestInit | undefined): boolean {
  const headers = init?.headers as Record<string, string> | Headers | undefined;
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has("Content-Type") || headers.has("content-type");
  return Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
}

describe("PHASE-004-R8 — 無 body 的 mutation API 呼叫不得宣告 Content-Type", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okJsonResponse());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const cases: { name: string; call: () => Promise<unknown> }[] = [
    {
      name: "apiCompleteApplication（本次 500 的原始事發函式）",
      call: () => apiCompleteApplication("app-1"),
    },
    { name: "apiDeleteApplication", call: () => apiDeleteApplication("app-1") },
    { name: "apiLogout", call: () => apiLogout() },
    { name: "apiDeleteAttachment", call: () => apiDeleteAttachment("att-1") },
    { name: "apiDeactivateUser", call: () => apiDeactivateUser("user-1") },
    { name: "apiActivateUser", call: () => apiActivateUser("user-1") },
    { name: "apiDeleteUser", call: () => apiDeleteUser("user-1") },
  ];

  it.each(cases)(
    "$name：呼叫 fetch 時未宣告 Content-Type（且本來就沒有 body）",
    async ({ call }) => {
      await call();
      const mock = fetch as Mock;
      expect(mock).toHaveBeenCalledTimes(1);
      const init = callInit(mock);
      expect(init?.body).toBeUndefined();
      expect(hasContentTypeHeader(init)).toBe(false);
    }
  );

  it("鑑別力自證：若刻意送出「宣告 Content-Type 但無 body」的請求，本檔的檢查函式必須能抓到（證明上面的斷言不是恆真）", () => {
    const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" } };
    expect(init.body).toBeUndefined();
    expect(hasContentTypeHeader(init)).toBe(true); // 若上面 cases 的函式退化成這樣，測試會失敗
  });
});
