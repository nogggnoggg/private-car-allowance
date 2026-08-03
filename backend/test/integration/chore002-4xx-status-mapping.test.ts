/**
 * CHORE-002-T1 修項② — wire-level 4xx 原始 status 對照表。
 *
 * 背景（reviewer 於 CHORE-001 複審實測發現）：
 *   CHORE-001 為 error-handler.ts 新增的分支 3（wire-level 4xx 硬化）把所有
 *   「明確 4xx statusCode 或 FST_ERR_CTP_*」一律壓平為 400 VALIDATION_ERROR——
 *   但 Fastify 自身對 body 過大會拋 FST_ERR_CTP_BODY_TOO_LARGE（statusCode 413），
 *   對不支援的 Content-Type 會拋 FST_ERR_CTP_INVALID_MEDIA_TYPE（statusCode 415），
 *   這兩者的語意在舊分支 3 中流失（一律變成 400）。
 *
 * 修法：改為對照表 —— 413 → PAYLOAD_TOO_LARGE（保留 413）、
 *       415 → UNSUPPORTED_MEDIA_TYPE（保留 415）、其餘 4xx → 400 VALIDATION_ERROR（不變）。
 *       三個 code 均已在 errors.ts 的 ErrorCode 聯集中（PAYLOAD_TOO_LARGE /
 *       UNSUPPORTED_MEDIA_TYPE 原供附件上傳使用），不需修改 errors.ts。
 *
 * (a)(b) 為本次新增行為的紅燈/綠燈證據（修復前皆為 400，見 Task Handoff 貼上的
 * 修復前實測輸出）；(c) 證明畸形 JSON 這類「其餘 4xx」語意不變，仍是 400
 * VALIDATION_ERROR（沿用 chore001-wire-level-4xx-hardening.test.ts 既有斷言，
 * 本檔僅另外新增、不修改該檔）。
 *
 * 不需要 DB：body parser / content-type 檢查都發生在任何 handler 之前
 * （比照 chore001-wire-level-4xx-hardening.test.ts 用 dbProbeOverride）。
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.js";

const noopDbProbe = async () => {};

interface ErrorJson {
  error: { code: string; message: string; requestId: string };
}

describe("CHORE-002-T1 ②: wire-level 4xx 原始 status 對照表（413/415 保留,其餘仍 400）", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer({ dbProbeOverride: noopDbProbe });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // (a) 超過全域 bodyLimit 的 JSON body → 413 PAYLOAD_TOO_LARGE（修復前：400 VALIDATION_ERROR）
  it("(a) 超過全域 bodyLimit 的 JSON body → 413 PAYLOAD_TOO_LARGE（保留原始 413，非壓平的 400）", async () => {
    // Fastify 預設 bodyLimit 為 1MB；建構一個遠超過此上限、但格式合法的 JSON payload。
    const oversizedPayload = JSON.stringify({
      loginName: "x",
      password: "y".repeat(2 * 1024 * 1024), // 2MB，遠超過 1MB 預設上限
    });
    const resp = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: oversizedPayload,
    });
    expect(resp.statusCode).toBe(413);
    const body = resp.json<ErrorJson>();
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(body.error.requestId).toBeTruthy();
  });

  // (b) 不支援的 Content-Type → 415 UNSUPPORTED_MEDIA_TYPE（修復前：400 VALIDATION_ERROR）
  it("(b) 不支援的 Content-Type（application/x-not-a-real-type）→ 415 UNSUPPORTED_MEDIA_TYPE（保留原始 415）", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/x-not-a-real-type" },
      payload: "irrelevant body content",
    });
    expect(resp.statusCode).toBe(415);
    const body = resp.json<ErrorJson>();
    expect(body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(body.error.requestId).toBeTruthy();
  });

  // (c) 畸形 JSON（既有語意不變）→ 仍是 400 VALIDATION_ERROR（非 413/415，也非本次調整範圍）
  it("(c) 畸形 JSON（既有分支語意不變）→ 仍是 400 VALIDATION_ERROR", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{not valid json!!",
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json<ErrorJson>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  // (d) 附件業務路徑 413/415（AppError PAYLOAD_TOO_LARGE / UNSUPPORTED_MEDIA_TYPE）不受本次
  //     wire-level 對照表新增影響 —— AppError 走分支 1（本次未動），既有
  //     phase3-upload 相關測試全綠即為證據，本檔不重複覆蓋業務路徑。
});
