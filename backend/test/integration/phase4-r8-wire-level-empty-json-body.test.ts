/**
 * Integration tests for PHASE-004-R8 — 「完成申請」500 缺陷的回歸防線。
 *
 * 背景（R7 發現、大總管重現、R8 修復）：
 *   `frontend/src/api/applications.ts` 的 `apiCompleteApplication` 對
 *   `POST /applications/:id/complete` 設了 `Content-Type: application/json`
 *   卻不帶 `body`。Fastify 的預設 JSON body parser 對「宣告 JSON 但空 body」
 *   丟出 `FastifyError`（"Body cannot be empty when content-type is set to
 *   'application/json'"），且該 error **沒有** `.validation` 陣列（那是
 *   schema 驗證錯誤專屬），落入 `error-handler.ts` 的第 3 分支（未知例外）
 *   → 500 INTERNAL_ERROR。這發生在 body parser 階段，早於任何
 *   `preHandler`（含 `requireAuth`）——即使完全未登入、資源不存在，一樣先
 *   500，不會走到原本該有的 401。R8 修法：`apiCompleteApplication` 根本不
 *   宣告 `Content-Type`（AC-54：body 一律忽略，route 從未讀取
 *   `request.body`，沒有 body 就不該宣告 body 型別）。
 *
 * 為何既有 871 條整合測試測不到這個缺陷：
 *   全套既有測試呼叫 `app.inject` 一律不明確設定
 *   `headers: { "content-type": "application/json" }`。本檔的
 *   Test 1 是第一個明確以「R8 修復後、真實前端實際會送出的 wire-level
 *   形狀」（無 Content-Type、無 payload）呼叫 `/applications/:id/complete`
 *   並將其命名釘住為本次修復的回歸測試——證明修復後的呼叫形狀確實安全。
 *
 * 已嘗試但未收錄的做法（誠實揭露，供 Task Handoff 引用）：
 *   Packet 原文字面要求「明確設定 headers: {content-type: application/json}
 *   且不帶 payload，斷言回應不是 500」。經實測（見 Task Handoff「修復前紅
 *   的證據」），這個特定組合（刻意重新宣告該 header、不帶 body）在 wire
 *   level 對**任何**沒有 body 的 mutation 端點都會 500——包含
 *   `/applications/:id/complete` 本身——且與前端如何呼叫完全無關（body
 *   parser 在 `preHandler`/auth 之前執行，是 Fastify 全域 JSON parser +
 *   本專案全域 error handler 的組合行為）。要讓這個組合斷言為「不是
 *   500」，除了改前端呼叫方式（已完成，見 Test 1）外，唯一路徑是修改
 *   `backend/src/**`（body parser 或 error handler），這正是本 Packet
 *   明文禁止、且列為 Stop Condition 的範圍。因此本檔**不**包含「手動重新
 *   加上該 header 並斷言不是 500」的斷言（那會是一個必然恆紅、且需要被
 *   Forbidden 範圍外的修改才能轉綠的斷言，不符合「新增測試需可轉綠」的
 *   TDD 紀律）。真正能防止「未來有人不小心在某個無 body 端點的前端呼叫端
 *   加回這個 header」的位置是前端 API 呼叫層本身，見
 *   `frontend/test/api-no-body-mutations.test.ts`（本 Task 新增，直接
 *   spy `fetch` 斷言所有無 body 的 mutation 呼叫都不宣告
 *   `Content-Type`）——這與本檔互補：本檔釘住「/complete 修復後的實際呼叫
 *   形狀是安全的」，前端測試釘住「呼叫端未來不會重新引入這個 bug」。
 *
 * 為何不需要 DB／登入：body parser 在 `preHandler`（含 `requireAuth`）之前
 * 執行，即使完全未登入、資源不存在，`/applications/:id/complete` 對
 * 「無 Content-Type、無 payload」的呼叫穩定回 401 UNAUTHORIZED（既有
 * `phase4-travel-complete.test.ts` 的「未登入呼叫 complete → 401
 * UNAUTHORIZED」案例已覆蓋這個對照組；本檔的重點是把「R8 這個修復動作」
 * 明確命名釘住，而非重新驗證授權矩陣）。仍沿用 `describeWithDb` 慣例以與
 * 其他整合測試檔一致。
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

interface ErrorJson {
  error: { code: string; message: string };
}

describeWithDb("PHASE-004-R8 — 完成申請 500 缺陷回歸防線", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    if (!DB_URL) return;
    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("R8 修復後真實前端的呼叫形狀（無 Content-Type、無 payload）→ 不是 500，行為與其他無 body 端點一致（401 UNAUTHORIZED）", async () => {
    // 完全比照 apiCompleteApplication 修復後的 fetch init 形狀：
    // method: "POST", credentials: "include"，**不設** headers，**不帶** body。
    const resp = await app.inject({
      method: "POST",
      url: "/applications/nonexistent/complete",
    });
    expect(resp.statusCode).not.toBe(500);
    expect(resp.statusCode).toBe(401);
    expect(resp.json<ErrorJson>().error.code).toBe("UNAUTHORIZED");
  });

  it("對照：明確重新加上 Content-Type: application/json（模擬修復前的呼叫形狀）→ CHORE-001 硬化後為 400 VALIDATION_ERROR（非 500），證明本測試對這一類缺陷確實有鑑別力（非恆綠斷言）", async () => {
    // 這個 it 原先（PHASE-004-R8）刻意驗證「修復前的呼叫形狀」仍然是
    // 500——用來證明上面那個 it 不是恆真：如果有人不小心把 Content-Type
    // 加回 apiCompleteApplication，本檔的第一個測試會立刻從 401 變 500
    // 而失敗。CHORE-001 已把 wire-level 畸形/空 body 請求（Fastify body
    // parser 丟出的 FST_ERR_CTP_* 系列錯誤）從 500 INTERNAL_ERROR 硬化為
    // 400 VALIDATION_ERROR（見 backend/src/platform/error-handler.ts 分支
    // 3，此前已預告本檔會因此轉紅）。故本斷言由 500 轉正為 400；「加回
    // header 仍會被歸類為異常路徑（非 2xx/401）」這件事本身依然具鑑別力：
    // 若有人不慎讓這條路徑退化回被判定為未知例外，本斷言會再次變動而失敗。
    const resp = await app.inject({
      method: "POST",
      url: "/applications/nonexistent/complete",
      headers: { "content-type": "application/json" },
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json<ErrorJson>().error.code).toBe("VALIDATION_ERROR");
  });
});
