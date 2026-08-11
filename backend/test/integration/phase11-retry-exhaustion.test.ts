/**
 * Integration tests for PHASE-011-T1 — AC-01(c)(e)（依 `docs/specs/PHASE-011.md`
 * §16 D1=(a)）:
 *
 *   AC-01(c) — 503 路徑之鑑別力自證：以故障注入（`prisma.$transaction` 替身，
 *   使每次呼叫皆丟出 `isRetryableTransactionConflict` 判定為可重試之錯誤形狀
 *   ——P2034 序列化失敗，見 `maintenance-service.ts` :358-371 之判定準則）構造
 *   一次確定性之重試耗盡，斷言 `completeMaintenanceApplication` 最終得
 *   `SERVICE_UNAVAILABLE`/503，且 DB 零寫入（`Application.status` 仍
 *   `DRAFT`、`MaintenanceApplication.snapshot*` 全 `null`）。核銷
 *   `PROJECT_STATE.md` :417 AR-2「503 重試耗盡全 Phase 無測試」。
 *
 *   AC-01(e) — 本 Task 之 `backend/src` diff 射程結構性登記：D1=(a) 裁定為純
 *   測試面，`backend/src` diff 必須為 0。本檔以「故障注入完全不需
 *   `maintenance-service.ts` 新增任何匯出或 test-only 鉤子」之事實作結構性
 *   登記（見下方 `Object.keys` 封閉集合斷言）。
 *
 * 故障注入手法（依 D1 選項 (a) 之描述二擇一）：本檔**不**修改／匯出私有的
 * `isRetryableTransactionConflict`（該函式未 export，且改為 export 屬
 * `backend/src` diff，與 D1=(a) 之零 diff 承諾牴觸）。改以 `vi.spyOn` 替身
 * `prisma.$transaction`（`completeMaintenanceApplication` 之公開參數，非模組
 * 內部細節），使其每次呼叫皆同步丟出一個 `isRetryableTransactionConflict`
 * 判定準則所認得的錯誤（`PrismaClientKnownRequestError` code=`P2034`）——效
 * 果等同「`isRetryableTransactionConflict` 恆真之替身」，但完全不觸碰
 * `backend/src`。由於替身讓 `$transaction` 從未真正執行其回呼，交易內的所有
 * DB 寫入（快照、狀態轉換）從未發生，DB 零寫入為結構性必然，非僥倖。
 *
 * INFRA-001 隔離（`docs/specs/INFRA-001.md`）：替身僅作用於本檔自有之
 * `PrismaClient` 實例（`pool:"forks"` 下本檔獨立行程，不影響其他測試檔）；
 * `try/finally` 於成功與失敗兩路徑皆呼叫 `mockRestore()` 自我還原，不留殘留。
 *
 * Test discipline (Spec §11.0 / Packet):
 *   - loginName prefix "p11t1_" + per-run random suffix.
 *   - cleanup scoped to this suite's own tracked application/attachment ids +
 *     loginName prefix; NEVER deleteMany({}) globally.
 *   - synthetic data only.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { completeMaintenanceApplication } from "../../src/applications/maintenance-service.js";
import * as maintenanceServiceModule from "../../src/applications/maintenance-service.js";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0];
}

async function loginUser(
  app: FastifyInstance,
  loginName: string,
  password: string
): Promise<string> {
  const resp = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { loginName, password },
  });
  if (resp.statusCode !== 200) {
    throw new Error(`Login failed for ${loginName}: ${resp.statusCode} ${resp.body}`);
  }
  return extractCookieHeader(resp.headers["set-cookie"]);
}

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p11t1_";
const PASSWORD = "RetryExhaustionTest99!";
const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;

describeWithDb("PHASE-011-T1 AC-01(c)(e) — 完成保養申請之重試耗盡確定性 503", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let ownerId: string;
  let ownerCookie: string;

  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    const owner = await prisma.user.create({
      data: {
        loginName: OWNER_LOGIN,
        displayName: "P11T1 擁有人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    ownerId = owner.id;

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    ownerCookie = await loginUser(app, OWNER_LOGIN, PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      if (createdAttachmentIds.length > 0) {
        await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
      }
      if (createdApplicationIds.length > 0) {
        await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
      }
      if (ownerId) {
        await prisma.session.deleteMany({ where: { userId: ownerId } });
      }
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
  });

  async function createDraft(cookie: string): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/maintenance",
      headers: { cookie },
      payload: {},
    });
    expect(resp.statusCode).toBe(201);
    const id = resp.json<{ application: { id: string } }>().application.id;
    createdApplicationIds.push(id);
    return id;
  }

  async function putFields(cookie: string, id: string, fields: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/applications/maintenance/${id}`,
      headers: { cookie },
      payload: fields,
    });
  }

  function buildMultipartBody(
    filename: string,
    content: Buffer
  ): { body: Buffer; contentType: string } {
    const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
    const CRLF = "\r\n";
    const header = `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`;
    const footer = `${CRLF}--${boundary}--${CRLF}`;
    return {
      body: Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  function makeJpegBytes(size = 64): Buffer {
    const buf = Buffer.alloc(size, 0xaa);
    buf[0] = 0xff;
    buf[1] = 0xd8;
    buf[2] = 0xff;
    return buf;
  }

  async function uploadTemp(cookie: string, filename: string): Promise<string> {
    const { body, contentType } = buildMultipartBody(filename, makeJpegBytes());
    const resp = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { cookie, "content-type": contentType },
      payload: body,
    });
    expect(resp.statusCode).toBe(201);
    const id = resp.json<{ attachment: { id: string } }>().attachment.id;
    createdAttachmentIds.push(id);
    return id;
  }

  it("AC-01(c): 重試耗盡之 503 為確定性可構造 — 故障注入下 SERVICE_UNAVAILABLE ＋ DB 零寫入", async () => {
    // 建立一份「五欄齊備 + 1 張附件」之完全可完成草稿——刻意選擇本應可成功
    // 完成的狀態，藉此證明 503 並非因為草稿本身不合格，而是重試耗盡之誠實
    // 回應（D1 裁定原文）。
    const id = await createDraft(ownerCookie);
    const putResp = await putFields(ownerCookie, id, {
      lastMaintenanceDate: "2058-01-01",
      currentMaintenanceDate: "2058-01-28",
      lastOdometerKm: "0.00",
      currentOdometerKm: "100.00",
      actualCost: "300.00",
    });
    expect(putResp.statusCode).toBe(200);
    const attachmentId = await uploadTemp(ownerCookie, "ac01c.jpg");
    const linkResp = await putFields(ownerCookie, id, { attachmentIds: [attachmentId] });
    expect(linkResp.statusCode).toBe(200);

    // Before 快照：尚未完成，snapshot 全 null。
    const before = await prisma.maintenanceApplication.findUniqueOrThrow({
      where: { applicationId: id },
    });
    expect(before.snapshotIntervalKm).toBeNull();
    expect(before.snapshotOfficialKm).toBeNull();
    expect(before.snapshotRatio).toBeNull();
    expect(before.snapshotRawAmount).toBeNull();
    expect(before.calculatedAt).toBeNull();

    // 故障注入：$transaction 每次呼叫皆同步丟出可重試錯誤（P2034），從未
    // 真正執行回呼——交易內之任何寫入結構性地不可能發生。
    const txSpy = vi.spyOn(prisma, "$transaction").mockImplementation((async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        "simulated serialization failure (AC-01(c) fault injection)",
        { code: "P2034", clientVersion: "test" }
      );
    }) as unknown as typeof prisma.$transaction);

    try {
      await expect(completeMaintenanceApplication(prisma, id)).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        httpStatus: 503,
      });
      // 確定性物證：重試耗盡恰呼叫 $transaction 7 次
      // （`COMPLETE_MAINTENANCE_MAX_RETRIES=6`，attempt 0..6 共 7 次嘗試——見
      // `maintenance-service.ts` :1015/:1060/:1222）。此斷言刻意耦合該現況常
      // 數：若未來調整重試上限而漏改本檔，此斷言會示警而非靜默過關。
      expect(txSpy).toHaveBeenCalledTimes(7);
    } finally {
      // INFRA-001 自我還原：成功與失敗路徑皆還原，避免污染同檔後續測試。
      txSpy.mockRestore();
    }

    // DB 零寫入：Application 與 MaintenanceApplication 之可寫入面全維持
    // before 狀態；附件亦未被觸及（真交易從未執行，遑論附件狀態轉換）。
    const afterApp = await prisma.application.findUniqueOrThrow({ where: { id } });
    expect(afterApp.status).toBe("DRAFT");
    expect(afterApp.totalAmount).toBeNull();
    expect(afterApp.completedAt).toBeNull();

    const afterMaint = await prisma.maintenanceApplication.findUniqueOrThrow({
      where: { applicationId: id },
    });
    expect(afterMaint.snapshotIntervalKm).toBeNull();
    expect(afterMaint.snapshotOfficialKm).toBeNull();
    expect(afterMaint.snapshotRatio).toBeNull();
    expect(afterMaint.snapshotRawAmount).toBeNull();
    expect(afterMaint.calculatedAt).toBeNull();

    const afterAttachment = await prisma.attachment.findUniqueOrThrow({
      where: { id: attachmentId },
    });
    expect(afterAttachment.status).toBe("LINKED");
  });

  it("AC-01(e): 本 Task 之 backend/src diff 射程（D1=(a) 時為 0）之結構性登記 — 故障注入不倚賴任何新增之 src 匯出或測試鉤子", () => {
    // D1=(a)：上方 AC-01(c) 之確定性 503 完全靠本檔以「prisma.$transaction 替
    // 身」達成，不需 `maintenance-service.ts` 新增任何 export、任何與重試／
    // 序列化衝突相關之 test-only 選項（唯一既有 test-only 鉤子是 AC-25 既有
    // 之 `CompleteMaintenanceApplicationOptions.__testOnlyFailAfterSnapshotWrite`
    // ——本檔完全未使用它）。以下封閉集合斷言即為此事實之結構性登記：若未
    // 來有人為了讓 503 更好構造而新增匯出，本斷言會示警。
    expect(Object.keys(maintenanceServiceModule).sort()).toEqual([
      "MAINTENANCE_ATTACHMENT_LIMIT",
      "buildMaintenanceApplicationDto",
      "completeMaintenanceApplication",
      "computeMaintenanceComputed",
      "createMaintenanceDraft",
      "getMaintenanceApplication",
      "toMaintenanceApplicationDto",
      "updateMaintenanceDraft",
    ]);
  });
});
