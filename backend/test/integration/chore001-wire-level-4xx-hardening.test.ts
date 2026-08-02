/**
 * CHORE-001-T1 修項① — wire-level 畸形請求 500 → 400 硬化。
 *
 * 背景：`backend/src/platform/error-handler.ts` 分支 3（修復前）將 Fastify
 * body parser／wire-level 錯誤（畸形 JSON、Content-Length 不符、空 body 帶
 * `Content-Type: application/json` 等）一律當作「未知例外」回 500
 * INTERNAL_ERROR，並以 level:50（error）記錄。此路徑發生在 Fastify 的
 * body parser 階段，早於任何 `preHandler`（含 `requireAuth`）——未登入者
 * 即可穩定觸發，屬於客戶端輸入問題，不應被歸類為伺服器未知錯誤。
 *
 * TDD：本檔在 CHORE-001 實作前（即 error-handler.ts 尚未新增分支 3 的
 * wire-level 4xx 分類時）(a)(b) 兩條會失敗（收到 500 而非 400）——修復前
 * 的紅燈輸出見本 Task Handoff。
 *
 * 不需要 DB：body parser 錯誤發生在任何 handler／preHandler 之前，
 * 用 dbProbeOverride 避免測試依賴真實資料庫連線（比照
 * backend/test/integration/log-security.test.ts 的既有手法）。
 */
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.js";

const noopDbProbe = async () => {};

interface ErrorJson {
  error: { code: string; message: string; requestId: string };
}

/** Collect raw JSON log lines into an array (比照 log-security.test.ts) */
function makeLogCapture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, stream };
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe("CHORE-001-T1 ①: wire-level 畸形請求硬化為 400（非 500）", () => {
  let app: FastifyInstance;
  let logLines: string[];

  beforeAll(async () => {
    const capture = makeLogCapture();
    logLines = capture.lines;
    app = await buildServer({ dbProbeOverride: noopDbProbe, logStream: capture.stream });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // (a) /auth/login 送畸形 JSON → 400 VALIDATION_ERROR（鑑別力：修復前為 500 INTERNAL_ERROR）
  it("(a) POST /auth/login 帶畸形 JSON body → 400 VALIDATION_ERROR（修復前為 500，見 Handoff 紅燈證據）", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{not valid json!!", // 畸形 JSON → Fastify FST_ERR_CTP_INVALID_JSON_BODY
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<ErrorJson>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.requestId).toBeTruthy();
  });

  // (b) 帶 Content-Type: application/json 但空 body 的 mutation 端點 → 400
  //     （鑑別力：修復前為 500，見 phase4-r8-wire-level-empty-json-body.test.ts
  //      同步轉正的對照斷言，以及本 Task Handoff 的修復前紅燈輸出）
  it("(b) POST 帶 Content-Type: application/json 且空 body 的 mutation 端點 → 400 VALIDATION_ERROR（修復前為 500）", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/nonexistent/complete",
      headers: { "content-type": "application/json" },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<ErrorJson>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  // (c) 鑑別力反向：正常合法請求不受影響 — 既有 error-handler.test.ts /
  //     全套整合測試（AppError、schema 驗證 400、401/403、404、500 各分支）
  //     即為證據，本檔不重複覆蓋；額外補一個「合法 JSON body 對同一畸形
  //     JSON 端點」不會被新分支誤判的最小案例：
  it("(c) 合法 JSON body（非 wire-level 錯誤）不受新分支影響 — 走既有 schema 驗證/業務邏輯路徑，不是硬編 400", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ loginName: "nonexistent-user", password: "wrong-but-valid-shape" }),
    });
    // 合法 JSON 語法，不會落入新的 wire-level 4xx 分支；業務邏輯判斷帳密錯誤
    // 回 401 UNAUTHORIZED（沿用既有錯誤協定），而非本次新增的 VALIDATION_ERROR。
    expect(resp.statusCode).not.toBe(500);
    expect(resp.statusCode).toBe(401);
    expect(resp.json<ErrorJson>().error.code).toBe("UNAUTHORIZED");
  });

  // (d) 4xx 路徑 log 不含 level:50（比照 log-security.test.ts 手法）
  it("(d) wire-level 4xx 路徑的 log 不含 level:50（error 級），僅 info 級", () => {
    const parsed = logLines
      .map(parseLine)
      .filter((obj): obj is Record<string, unknown> => obj !== null);
    const errorLevelEntries = parsed.filter((obj) => obj.level === 50);
    expect(errorLevelEntries.length).toBe(0);

    const infoLevelWireEntries = parsed.filter(
      (obj) => obj.level === 30 && obj.msg === "Wire-level 4xx error (body parser / framework)"
    );
    expect(infoLevelWireEntries.length).toBeGreaterThan(0);
  });
});
