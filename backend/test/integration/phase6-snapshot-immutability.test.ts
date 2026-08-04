/**
 * Integration tests for PHASE-006-T8:
 *   快照不可變 ＋ 後端權威夾帶矩陣 ＋ 容量守門接線正式化 ＋ 併發
 *   （AC-19 整合層 / AC-20 / AC-28 / AC-29）。
 *
 * Spec §2（PHASE-006）：
 *   AC-28 — 快照不可變：完成後於期間內新增／完成新差旅或修改任何差旅資料，
 *     快照五欄＋Application.totalAmount 逐位元不變；讀取已完成申請不執行任何
 *     期間公務里程查詢（spy：讀 DRAFT +1、讀 COMPLETED +0）。
 *   AC-29 — 併發完成：同一保養草稿兩請求同時完成 → 恰一成功、另一 403，不得
 *     雙重完成／雙重快照、不得 500。
 *   AC-20 — 後端為唯一權威：body/query 夾帶 intervalKm/officialKm/ratio/
 *     ratioPercent/rawAmount/amount/totalAmount/snapshot* 等欄位一律忽略，
 *     絕不 500（含合法值／畸形值／null／字串／陣列／頂層非物件 body）。
 *   AC-19（整合層，T2 判定 ＋ T8 接線）— 草稿 DTO 與預覽端點皆須暴露
 *     AMOUNT_OUT_OF_RANGE（防「預覽說可以、完成才擋」反模式）；邊界正例已由
 *     T7 之 `phase6-maintenance-complete.test.ts`「AC-19 容量守門（完成端點）」
 *     覆蓋（本檔不重複宣稱，§12 回填以現實為準）。
 *
 * T7 即審移交 FW 必辦事項（本檔落地）：
 *   1. fixture 必經真實完成流程（HTTP `/applications/:id/complete`，非直寫
 *      `markCompleted`）——見 `buildCompletableDraft`/`completeHttp`。
 *   2. spy 範圍界定：spy 對象為 `sumOfficialMileage` 呼叫次數（見下方
 *      `AC-28 spy 零重查` describe 區塊的文件註解）。
 *   3. AR-2 關閉：空草稿完成 → 5 條 *_REQUIRED ＋ 5 條 fields[] 路徑 ＋ §7.4
 *      固定順序（見「AR-2 關閉」describe 區塊）。
 *   4. AR-3：B-30（完成 vs 刪除附件）之「條件式斷言改 N 輪迴圈」建議，字面
 *      指向 `phase6-maintenance-complete.test.ts`——該檔不在本 Task 之 Files
 *      Allowed 封閉清單內（僅 `maintenance-service.ts` 與本檔），故未動該檔；
 *      改為對本 Task **自己新增**的併發測試（AC-29：完成 vs 完成）套用同一
 *      「N 輪迴圈，降低單次斷言之靜默不覆蓋風險」原則（見下方 AC-29 describe
 *      區塊）。此偏離已於 Handoff Warnings 說明。
 *   5. AC-20 夾帶矩陣含 ownerId 非字串（fail-closed 靜默視為自己）、頂層非
 *      物件 body（T5 AR-5 釘形狀）。
 *   6. 併發（AC-29）：完成 vs 完成恰一成功另一 403；不得 500；雙重快照檢查
 *      （MaintenanceApplication 單列＋快照欄一次寫入）。
 *
 * Test discipline (Spec §11.0 / Packet):
 *   - loginName prefix "p6t8_" + per-run random suffix.
 *   - cleanup scoped to this suite's own tracked application/attachment ids +
 *     loginName prefix; NEVER deleteMany({}) globally.
 *   - synthetic data only.
 *   - 金額類斷言一律精確等值（Spec §2 逐字要求），不使用近似比較。
 */
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { completeMaintenanceApplication } from "../../src/applications/maintenance-service.js";
import { hashPassword } from "../../src/auth/password.js";
import * as mileageEngine from "../../src/mileage/mileage-engine.js";
import { AppError } from "../../src/platform/errors.js";
import { buildServer } from "../../src/server.js";

// T7R S-3 既有慣例延續（見 phase6-maintenance-complete.test.ts 檔頭）：包裝真實
// 實作為 spy，行為不變，只加可觀測性——用於 AC-28 之「讀 COMPLETED 零重查」。
vi.mock("../../src/mileage/mileage-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mileage/mileage-engine.js")>();
  return {
    ...actual,
    sumOfficialMileage: vi.fn(actual.sumOfficialMileage),
  };
});

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
const LOGIN_PREFIX = "p6t8_";
const PASSWORD = "MaintenanceSnapshotTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;

interface MaintenanceComputedJson {
  calculable: boolean;
  intervalKm: string | null;
  officialKm: string | null;
  ratio: string | null;
  ratioPercent: string | null;
  rawAmount: string | null;
  amount: number | null;
  blockingCodes: string[];
}

interface MaintenanceApplicationJson {
  id: string;
  status: string;
  lastMaintenanceDate: string | null;
  currentMaintenanceDate: string | null;
  lastOdometerKm: string | null;
  currentOdometerKm: string | null;
  actualCost: string | null;
  completionBlockers: Array<{ code: string; field?: string; message: string }> | null;
  computed: MaintenanceComputedJson | null;
  snapshot: {
    intervalKm: string;
    officialKm: string;
    ratio: string;
    ratioPercent: string;
    actualCost: string;
    rawAmount: string;
    totalAmount: number;
    calculatedAt: string;
  } | null;
}

describeWithDb("PHASE-006-T8 — 快照不可變 + 後端權威 + 容量守門接線 + 併發", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let ownerCookie: string;

  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  function trackApp(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }
  function trackAttachment(id: string): string {
    createdAttachmentIds.push(id);
    return id;
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    const owner = await prisma.user.create({
      data: {
        loginName: OWNER_LOGIN,
        displayName: "P6T8 擁有人",
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

  // ===========================================================================
  // Fixture helpers（沿 phase6-maintenance-complete.test.ts 既有形狀，T7 即審
  // FW-1「fixture 必經真實完成流程」）
  // ===========================================================================

  async function createDraft(cookie: string = ownerCookie): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/maintenance",
      headers: { cookie },
      payload: {},
    });
    expect(resp.statusCode).toBe(201);
    const id = resp.json<{ application: { id: string } }>().application.id;
    trackApp(id);
    return id;
  }

  async function putFields(
    id: string,
    fields: Record<string, unknown>,
    cookie: string = ownerCookie
  ) {
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

  async function uploadTemp(filename: string, cookie: string = ownerCookie): Promise<string> {
    const { body, contentType } = buildMultipartBody(filename, makeJpegBytes());
    const resp = await app.inject({
      method: "POST",
      url: "/attachments",
      headers: { cookie, "content-type": contentType },
      payload: body,
    });
    expect(resp.statusCode).toBe(201);
    const id = resp.json<{ attachment: { id: string } }>().attachment.id;
    trackAttachment(id);
    return id;
  }

  /** 直接建立一筆已完成之 TRAVEL 申請（供期間公務里程之分子）。 */
  async function seedCompletedTravel(opts: {
    tripDate: string;
    segments: Array<{ totalKm: string; highwayKm: string }>;
  }): Promise<string> {
    const snapshotTotalKm = opts.segments
      .reduce((acc, seg) => acc.plus(new Prisma.Decimal(seg.totalKm)), new Prisma.Decimal("0"))
      .toFixed(2);
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date(opts.tripDate),
        completedAt: new Date(),
        totalAmount: 1,
        travel: {
          create: {
            tripDate: new Date(opts.tripDate),
            purpose: "P6T8 合成差旅（供期間公務里程分子）",
            snapshotTotalKm,
          },
        },
      },
      include: { travel: true },
    });
    trackApp(application.id);
    for (const [i, seg] of opts.segments.entries()) {
      await prisma.tripSegment.create({
        data: {
          travelApplicationId: application.id,
          sortOrder: i,
          origin: "合成起點",
          destination: "合成迄點",
          totalKm: seg.totalKm,
          highwayKm: seg.highwayKm,
        },
      });
    }
    return application.id;
  }

  /** 建立一筆完成度已齊備（可完成）之保養草稿：五欄 + N 張附件。 */
  async function buildCompletableDraft(opts: {
    cookie?: string;
    lastMaintenanceDate: string;
    currentMaintenanceDate: string;
    lastOdometerKm: string;
    currentOdometerKm: string;
    actualCost: string;
    attachmentCount?: number;
  }): Promise<string> {
    const cookie = opts.cookie ?? ownerCookie;
    const id = await createDraft(cookie);
    const putResp = await putFields(
      id,
      {
        lastMaintenanceDate: opts.lastMaintenanceDate,
        currentMaintenanceDate: opts.currentMaintenanceDate,
        lastOdometerKm: opts.lastOdometerKm,
        currentOdometerKm: opts.currentOdometerKm,
        actualCost: opts.actualCost,
      },
      cookie
    );
    expect(putResp.statusCode).toBe(200);

    const attachmentCount = opts.attachmentCount ?? 1;
    if (attachmentCount > 0) {
      const ids: string[] = [];
      for (let i = 0; i < attachmentCount; i++) {
        ids.push(await uploadTemp(`p6t8-${i}-${Math.random().toString(36).slice(2)}.jpg`, cookie));
      }
      const linkResp = await putFields(id, { attachmentIds: ids }, cookie);
      expect(linkResp.statusCode).toBe(200);
    }
    return id;
  }

  async function completeHttp(id: string, cookie: string = ownerCookie) {
    return app.inject({
      method: "POST",
      url: `/applications/${id}/complete`,
      headers: { cookie },
    });
  }

  async function getApp(id: string, cookie: string = ownerCookie) {
    return app.inject({
      method: "GET",
      url: `/applications/maintenance/${id}`,
      headers: { cookie },
    });
  }

  async function previewHttp(fields: Record<string, unknown>, cookie: string = ownerCookie) {
    return app.inject({
      method: "POST",
      url: "/applications/maintenance/preview",
      headers: { cookie },
      payload: fields,
    });
  }

  // ===========================================================================
  // AC-28 — 快照不可變（逐位元）＋ spy 零重查
  // ===========================================================================

  describe("AC-28 快照不可變", () => {
    it("完成後新增一筆期間內已完成差旅、且直接改動既有差旅資料 → 快照五欄與 totalAmount 逐位元不變", async () => {
      const travelId = await seedCompletedTravel({
        tripDate: "2060-01-15",
        segments: [{ totalKm: "40.00", highwayKm: "10.00" }],
      });

      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2060-01-01",
        currentMaintenanceDate: "2060-02-01",
        lastOdometerKm: "1000.00",
        currentOdometerKm: "1100.00", // intervalKm = 100.00
        actualCost: "1000.00",
      });

      const completeResp = await completeHttp(id);
      expect(completeResp.statusCode).toBe(200);
      const before = completeResp.json<{ application: MaintenanceApplicationJson }>().application
        .snapshot;
      expect(before).not.toBeNull();
      const dbAppBefore = await prisma.application.findUniqueOrThrow({ where: { id } });

      // (a) 「事後...新增／完成新的差旅申請」：於同一期間內再補一筆已完成差旅，
      // 若快照重算會被影響（officialKm 應變為 40+30=70）。
      await seedCompletedTravel({
        tripDate: "2060-01-20",
        segments: [{ totalKm: "30.00", highwayKm: "0.00" }],
      });

      // (b) 「修改任何差旅資料」：業務層不允許修改已完成差旅（狀態機鎖定），
      // 直接以 Prisma 改動既有差旅之快照里程，模擬「事後資料drift」情境
      // （例如未來 PHASE-009 作廢/修正版落地前，任何假設性資料觸碰）——目的
      // 僅在證明：即使分子來源資料改變，本保養申請之快照仍不重算、不變。
      await prisma.travelApplication.update({
        where: { applicationId: travelId },
        data: { snapshotTotalKm: "999.00" },
      });

      const afterResp = await getApp(id);
      expect(afterResp.statusCode).toBe(200);
      const after = afterResp.json<{ application: MaintenanceApplicationJson }>().application
        .snapshot;
      expect(after).not.toBeNull();

      // 逐位元不變：五個快照欄位 + Application.totalAmount。
      expect(after?.intervalKm).toBe(before?.intervalKm);
      expect(after?.officialKm).toBe(before?.officialKm);
      expect(after?.ratio).toBe(before?.ratio);
      expect(after?.ratioPercent).toBe(before?.ratioPercent);
      expect(after?.actualCost).toBe(before?.actualCost);
      expect(after?.rawAmount).toBe(before?.rawAmount);
      expect(after?.totalAmount).toBe(before?.totalAmount);
      expect(after?.calculatedAt).toBe(before?.calculatedAt);

      const dbAppAfter = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbAppAfter.totalAmount).toBe(dbAppBefore.totalAmount);
      expect(dbAppAfter.completedAt?.getTime()).toBe(dbAppBefore.completedAt?.getTime());

      // 驗證資料確實已「改變」（否則本測試無鑑別力——若分子未變，逐位元
      // 相同就毫無意義）：officialKm 仍為原本的 40.00，而非 999+40/30 之衍生值。
      expect(after?.officialKm).toBe("40.00");
    });

    // ---------------------------------------------------------------------
    // spy 零重查（T7 即審 FW-2：spy 對象為 sumOfficialMileage 呼叫次數）
    //
    // buildMaintenanceApplicationDto（maintenance-service.ts）之既有設計：
    //   status !== "DRAFT" → 直接回傳，從不呼叫 computeMaintenanceComputed
    //   （故從不呼叫 sumOfficialMileage）；status === "DRAFT" 且五欄齊備 →
    //   呼叫一次。本測試正式將此不變式鎖入契約層級斷言。
    // ---------------------------------------------------------------------
    it("讀取 DRAFT（五欄齊備）觸發恰一次 sumOfficialMileage 呼叫；讀取 COMPLETED 觸發零次", async () => {
      const spy = vi.mocked(mileageEngine.sumOfficialMileage);

      // ---- DRAFT +1 ----
      const draftId = await createDraft();
      await putFields(draftId, {
        lastMaintenanceDate: "2061-01-01",
        currentMaintenanceDate: "2061-02-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "50.00",
        actualCost: "100.00",
      });

      const callsBeforeDraftGet = spy.mock.calls.length;
      const draftGetResp = await getApp(draftId);
      expect(draftGetResp.statusCode).toBe(200);
      expect(spy.mock.calls.length).toBe(callsBeforeDraftGet + 1);

      // ---- COMPLETED +0 ----
      await seedCompletedTravel({
        tripDate: "2061-03-15",
        segments: [{ totalKm: "20.00", highwayKm: "0.00" }],
      });
      const completedId = await buildCompletableDraft({
        lastMaintenanceDate: "2061-03-01",
        currentMaintenanceDate: "2061-04-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "100.00",
        actualCost: "300.00",
      });
      const completeResp = await completeHttp(completedId);
      expect(completeResp.statusCode).toBe(200);

      const callsBeforeCompletedGet = spy.mock.calls.length;
      const completedGetResp = await getApp(completedId);
      expect(completedGetResp.statusCode).toBe(200);
      expect(spy.mock.calls.length).toBe(callsBeforeCompletedGet); // +0，逐次讀取皆不變

      // 多讀幾次，鞏固「COMPLETED 恆為零重查」而非巧合。
      await getApp(completedId);
      await getApp(completedId);
      expect(spy.mock.calls.length).toBe(callsBeforeCompletedGet);
    });
  });

  // ===========================================================================
  // AC-29 — 併發完成（完成 vs 完成，恰一成功）
  //
  // AR-3 精神延續（見檔頭說明）：單次條件式斷言容易靜默不覆蓋「兩種終局皆
  // 曾出現」——改以 N 輪迴圈重複整個「建立可完成草稿 → 兩個併發完成請求」
  // 情境，每輪皆獨立斷言「恰一 200、恰一 403、不得 500、不得雙重快照」，
  // 而非只跑一次即視為通過。
  // ===========================================================================

  describe("AC-29 併發完成（N 輪迴圈，AR-3 精神）", () => {
    const CONCURRENCY_ROUNDS = 12;

    it(`${CONCURRENCY_ROUNDS} 輪：每輪同一保養草稿之兩個併發完成請求恰一成功、另一 403，絕不 500，不得雙重快照`, async () => {
      for (let round = 0; round < CONCURRENCY_ROUNDS; round++) {
        await seedCompletedTravel({
          tripDate: `2062-${String((round % 9) + 1).padStart(2, "0")}-15`,
          segments: [{ totalKm: "10.00", highwayKm: "0.00" }],
        });
        const id = await buildCompletableDraft({
          lastMaintenanceDate: `2062-${String((round % 9) + 1).padStart(2, "0")}-01`,
          currentMaintenanceDate: `2062-${String((round % 9) + 1).padStart(2, "0")}-28`,
          lastOdometerKm: "0.00",
          currentOdometerKm: "100.00",
          actualCost: `${200 + round}.00`,
        });

        const [first, second] = await Promise.allSettled([
          completeMaintenanceApplication(prisma, id),
          completeMaintenanceApplication(prisma, id),
        ]);

        const settled = [first, second];
        const fulfilled = settled.filter((r) => r.status === "fulfilled");
        const rejected = settled.filter((r) => r.status === "rejected");

        // 恰一成功、另一失敗（絕不兩者皆成功、絕不兩者皆失敗）。
        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);

        // 失敗方必為業務層 403 FORBIDDEN（狀態機已鎖定），絕不 500。
        const rejection = rejected[0] as PromiseRejectedResult;
        expect(rejection.reason).toBeInstanceOf(AppError);
        const err = rejection.reason as AppError;
        expect(err.httpStatus).toBe(403);
        expect(err.httpStatus).not.toBe(500);

        // 成功方之回傳值本身狀態正確。
        const winner = (
          fulfilled[0] as PromiseFulfilledResult<
            Awaited<ReturnType<typeof completeMaintenanceApplication>>
          >
        ).value;
        expect(winner.status).toBe("COMPLETED");

        // 不得雙重快照：DB 之 MaintenanceApplication 恆為單列（1:1 主鍵），
        // 快照欄位皆非 null 且僅反映一次成功寫入之值；Application.totalAmount
        // 與 winner 回傳值一致。
        const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
        expect(dbApp.status).toBe("COMPLETED");
        expect(dbApp.totalAmount).toBe(winner.totalAmount);
        expect(dbApp.completedAt).not.toBeNull();

        const dbMaintenance = await prisma.maintenanceApplication.findUniqueOrThrow({
          where: { applicationId: id },
        });
        expect(dbMaintenance.snapshotIntervalKm).not.toBeNull();
        expect(dbMaintenance.snapshotOfficialKm).not.toBeNull();
        expect(dbMaintenance.snapshotRatio).not.toBeNull();
        expect(dbMaintenance.snapshotRawAmount).not.toBeNull();
        expect(dbMaintenance.calculatedAt).not.toBeNull();
      }
    });
  });

  // ===========================================================================
  // AC-19（整合層）— DRAFT DTO 與預覽端點皆須暴露 AMOUNT_OUT_OF_RANGE
  // （防「預覽說可以、完成才擋」反模式；邊界正例已由 T7 覆蓋，不重複宣稱）
  // ===========================================================================

  describe("AC-19 容量守門（草稿 DTO ／ 預覽端點皆暴露 AMOUNT_OUT_OF_RANGE）", () => {
    it("草稿 DTO（GET /applications/maintenance/:id）之 computed 與 completionBlockers 皆暴露 AMOUNT_OUT_OF_RANGE，不因『仍是草稿』而放行", async () => {
      await seedCompletedTravel({
        tripDate: "2063-01-15",
        segments: [{ totalKm: "100.00", highwayKm: "0.00" }], // O == I == 100（不觸發 AC-18）
      });
      const id = await createDraft();
      const putResp = await putFields(id, {
        lastMaintenanceDate: "2063-01-01",
        currentMaintenanceDate: "2063-02-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "100.00",
        // rawAmount = 3,000,000,000 * 100 / 100 = 3,000,000,000 — 超過 int4 上界。
        actualCost: "3000000000.00",
      });
      expect(putResp.statusCode).toBe(200);

      const getResp = await getApp(id);
      expect(getResp.statusCode).toBe(200);
      const application = getResp.json<{ application: MaintenanceApplicationJson }>().application;

      expect(application.status).toBe("DRAFT");
      expect(application.computed?.calculable).toBe(false);
      expect(application.computed?.amount).toBeNull();
      expect(application.computed?.blockingCodes).toContain("AMOUNT_OUT_OF_RANGE");

      const blockerCodes = (application.completionBlockers ?? []).map((b) => b.code);
      expect(blockerCodes).toContain("AMOUNT_OUT_OF_RANGE");
    });

    it("預覽端點（POST /applications/maintenance/preview）同一超容量組合亦暴露 AMOUNT_OUT_OF_RANGE，且不寫入任何資料列", async () => {
      await seedCompletedTravel({
        tripDate: "2063-03-15",
        segments: [{ totalKm: "100.00", highwayKm: "0.00" }],
      });

      const countBefore = await prisma.application.count({ where: { ownerId } });

      const previewResp = await previewHttp({
        lastMaintenanceDate: "2063-03-01",
        currentMaintenanceDate: "2063-04-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "100.00",
        actualCost: "3000000000.00",
      });
      expect(previewResp.statusCode).toBe(200);
      const preview = previewResp.json<{ preview: MaintenanceComputedJson }>().preview;
      expect(preview.calculable).toBe(false);
      expect(preview.amount).toBeNull();
      expect(preview.blockingCodes).toContain("AMOUNT_OUT_OF_RANGE");

      const countAfter = await prisma.application.count({ where: { ownerId } });
      expect(countAfter).toBe(countBefore); // 零寫入（AC-36 同型鑑別）
    });
  });

  // ===========================================================================
  // AR-2 關閉（T7 即審移交）— 空草稿完成 → 5 條 *_REQUIRED ＋ 5 條 fields[] ＋
  // §7.4 固定順序（順序敏感斷言）
  // ===========================================================================

  describe("AR-2 關閉 — 空草稿完成之完整未通過項與固定順序", () => {
    it("完全空白之草稿（五欄皆 null、零附件）完成 → 400，details.blockers 依 §7.4 固定順序恰為 5 個 *_REQUIRED + MAINTENANCE_ATTACHMENT_REQUIRED，fields[] 恰含 5 個對應路徑", async () => {
      const id = await createDraft();

      const resp = await completeHttp(id);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<{
        error: {
          code: string;
          fields?: Array<{ field: string; reason: string }>;
          details?: { blockers?: Array<{ code: string; field?: string; message: string }> };
        };
      }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");

      const blockers = body.error.details?.blockers ?? [];
      // §7.4 固定順序（順序敏感）：五個 *_REQUIRED（date×2/odometer×2/cost×1）
      // 全數為結構性第一段判定，MAINTENANCE_ATTACHMENT_REQUIRED（第 10 項）
      // 與五欄是否齊備無關，於此仍會出現（attachmentCount=0）；
      // OFFICIAL_KM_EXCEEDS_INTERVAL/AMOUNT_OUT_OF_RANGE（第 9/11 項）因兩段式
      // 第一段未全通過而完全抑制，絕不出現。
      expect(blockers.map((b) => b.code)).toEqual([
        "LAST_MAINTENANCE_DATE_REQUIRED",
        "CURRENT_MAINTENANCE_DATE_REQUIRED",
        "LAST_ODOMETER_REQUIRED",
        "CURRENT_ODOMETER_REQUIRED",
        "ACTUAL_COST_REQUIRED",
        "MAINTENANCE_ATTACHMENT_REQUIRED",
      ]);

      const fieldPaths = (body.error.fields ?? []).map((f) => f.field);
      expect(fieldPaths).toEqual([
        "lastMaintenanceDate",
        "currentMaintenanceDate",
        "lastOdometerKm",
        "currentOdometerKm",
        "actualCost",
      ]);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.status).toBe("DRAFT");
    });
  });

  // ===========================================================================
  // AC-20 — 後端為唯一權威：夾帶矩陣
  //
  // 設計說明：Spec 明文之 8 個禁忌欄位種類（intervalKm/officialKm/ratio/
  // ratioPercent/rawAmount/amount/totalAmount/snapshot*）× 5 種代表值型態
  // （合法值／畸形值／null／字串／陣列）之全排列組合達 40 格；為在 Diff 預算
  // 內維持測試之可讀性與可維護性，本檔採「同一列同時夾帶全部 8 種禁忌欄位、
  // 皆設為同一種代表值」之矩陣列（5 列，逐列切換值型態），仍逐一覆蓋每個
  // 欄位名稱 × 每種代表值型態，只是不逐一單獨隔離——AC-20 原文要求「任一
  // 欄位」被忽略，並未要求逐格隔離測試。另以獨立測試涵蓋「頂層非物件 body」
  // 與「ownerId 非字串」兩項特殊情況（T5 AR-5 釘形狀 / 本 Task FW-5）。
  // ===========================================================================

  describe("AC-20 後端權威 — 夾帶矩陣", () => {
    function buildInjectedForbiddenFields(value: unknown): Record<string, unknown> {
      return {
        intervalKm: value,
        officialKm: value,
        ratio: value,
        ratioPercent: value,
        rawAmount: value,
        amount: value,
        totalAmount: value,
        snapshot: value,
        snapshotIntervalKm: value,
        snapshotOfficialKm: value,
        snapshotRatio: value,
        snapshotRawAmount: value,
        calculatedAt: value,
      };
    }

    const INJECTION_VALUE_VARIANTS: Array<{ label: string; value: unknown }> = [
      { label: "合法值（形似真實金額/里程格式的數字）", value: 1234.56 },
      { label: "畸形值（非數字字串）", value: "abc-not-a-number-💥" },
      { label: "null", value: null },
      { label: "字串（數字字面但為字串型別）", value: "999999" },
      { label: "陣列", value: [1, 2, 3] },
    ];

    it.each(INJECTION_VALUE_VARIANTS)(
      "POST /applications/maintenance（建立）— $label 夾帶全部禁忌欄位 → 201，絕不 500，回應之業務欄位不受影響",
      async ({ value }) => {
        const resp = await app.inject({
          method: "POST",
          url: "/applications/maintenance",
          headers: { cookie: ownerCookie },
          payload: buildInjectedForbiddenFields(value),
        });
        expect(resp.statusCode).toBe(201);
        const application = resp.json<{ application: MaintenanceApplicationJson }>().application;
        trackApp(application.id);
        // 五個業務欄位皆未被夾帶內容污染——本端點根本未讀取任何禁忌欄位，
        // body 為空 body 之等價（未提供五個業務欄位）→ 全部為 null。
        expect(application.lastMaintenanceDate).toBeNull();
        expect(application.currentMaintenanceDate).toBeNull();
        expect(application.lastOdometerKm).toBeNull();
        expect(application.currentOdometerKm).toBeNull();
        expect(application.actualCost).toBeNull();
        expect(application.status).toBe("DRAFT");
      }
    );

    it.each(INJECTION_VALUE_VARIANTS)(
      "PUT /applications/maintenance/:id（更新）— $label 夾帶全部禁忌欄位 + 真實五欄 → 200，computed 為後端真實算出之值（officialKm=0 情境），非夾帶值",
      async ({ value }) => {
        const id = await createDraft();
        const resp = await putFields(id, {
          lastMaintenanceDate: "2064-01-01",
          currentMaintenanceDate: "2064-02-01",
          lastOdometerKm: "0.00",
          currentOdometerKm: "100.00", // intervalKm=100（期間內無任何差旅 → officialKm=0）
          actualCost: "500.00",
          ...buildInjectedForbiddenFields(value),
        });
        expect(resp.statusCode).toBe(200);
        const application = resp.json<{ application: MaintenanceApplicationJson }>().application;
        // 後端真實計算：officialKm=0（期間內無已完成差旅）→ ratio=0、amount=0——
        // 絕非夾帶值（1234.56／"999999"／[1,2,3] 等皆與 0 不同）。
        expect(application.computed?.officialKm).toBe("0.00");
        expect(application.computed?.ratio).toBe("0.000000");
        expect(application.computed?.amount).toBe(0);
      }
    );

    it.each(INJECTION_VALUE_VARIANTS)(
      "POST /applications/maintenance/preview（預覽）— $label 夾帶全部禁忌欄位 + 真實五欄 → 200，preview 為後端真實算出之值，非夾帶值，零寫入",
      async ({ value }) => {
        const countBefore = await prisma.application.count({ where: { ownerId } });
        const resp = await previewHttp({
          lastMaintenanceDate: "2064-03-01",
          currentMaintenanceDate: "2064-04-01",
          lastOdometerKm: "0.00",
          currentOdometerKm: "50.00",
          actualCost: "200.00",
          ...buildInjectedForbiddenFields(value),
        });
        expect(resp.statusCode).toBe(200);
        const preview = resp.json<{ preview: MaintenanceComputedJson }>().preview;
        expect(preview.officialKm).toBe("0.00");
        expect(preview.ratio).toBe("0.000000");
        expect(preview.amount).toBe(0);

        const countAfter = await prisma.application.count({ where: { ownerId } });
        expect(countAfter).toBe(countBefore);
      }
    );

    it("POST /applications/:id/complete（完成）— 夾帶全部禁忌欄位（畸形值）之 body → 200，快照為後端真實算出之值，非夾帶值", async () => {
      await seedCompletedTravel({
        tripDate: "2064-05-15",
        segments: [{ totalKm: "25.00", highwayKm: "0.00" }],
      });
      const id = await buildCompletableDraft({
        lastMaintenanceDate: "2064-05-01",
        currentMaintenanceDate: "2064-06-01",
        lastOdometerKm: "0.00",
        currentOdometerKm: "100.00", // intervalKm=100, officialKm=25 → ratio=0.25
        actualCost: "1000.00", // amount = 1000*25/100 = 250
      });

      const resp = await app.inject({
        method: "POST",
        url: `/applications/${id}/complete`,
        headers: { cookie: ownerCookie, "content-type": "application/json" },
        payload: JSON.stringify(
          buildInjectedForbiddenFields({ totalAmount: 999999999, amount: 999999999 })
        ),
      });
      expect(resp.statusCode).toBe(200);
      const application = resp.json<{ application: MaintenanceApplicationJson }>().application;
      expect(application.snapshot?.totalAmount).toBe(250);
      expect(application.snapshot?.totalAmount).not.toBe(999999999);
    });

    // -------------------------------------------------------------------
    // 頂層非物件 body（T5 AR-5 釘形狀；B-33 明文）
    // -------------------------------------------------------------------
    const NON_OBJECT_BODIES: Array<{ label: string; raw: string }> = [
      { label: "null", raw: "null" },
      { label: "字串", raw: JSON.stringify("just a string") },
      { label: "陣列", raw: JSON.stringify([1, 2, 3]) },
    ];

    it.each(NON_OBJECT_BODIES)(
      "POST /applications/maintenance — 頂層非物件 body（$label）→ 絕不 500（回退為視同空 body）",
      async ({ raw }) => {
        const resp = await app.inject({
          method: "POST",
          url: "/applications/maintenance",
          headers: { cookie: ownerCookie, "content-type": "application/json" },
          payload: raw,
        });
        expect(resp.statusCode).not.toBe(500);
        expect(resp.statusCode).toBe(201);
        const application = resp.json<{ application: MaintenanceApplicationJson }>().application;
        trackApp(application.id);
        expect(application.lastMaintenanceDate).toBeNull();
      }
    );

    it.each(NON_OBJECT_BODIES)(
      "PUT /applications/maintenance/:id — 頂層非物件 body（$label）→ 絕不 500（既有五欄維持不變）",
      async ({ raw }) => {
        const id = await createDraft();
        const resp = await app.inject({
          method: "PUT",
          url: `/applications/maintenance/${id}`,
          headers: { cookie: ownerCookie, "content-type": "application/json" },
          payload: raw,
        });
        expect(resp.statusCode).not.toBe(500);
        expect(resp.statusCode).toBe(200);
        const application = resp.json<{ application: MaintenanceApplicationJson }>().application;
        expect(application.lastMaintenanceDate).toBeNull();
      }
    );

    it.each(NON_OBJECT_BODIES)(
      "POST /applications/maintenance/preview — 頂層非物件 body（$label）→ 絕不 500（視同空欄位，不可計算）",
      async ({ raw }) => {
        const resp = await app.inject({
          method: "POST",
          url: "/applications/maintenance/preview",
          headers: { cookie: ownerCookie, "content-type": "application/json" },
          payload: raw,
        });
        expect(resp.statusCode).not.toBe(500);
        expect(resp.statusCode).toBe(200);
        const preview = resp.json<{ preview: MaintenanceComputedJson }>().preview;
        expect(preview.calculable).toBe(false);
      }
    );

    // -------------------------------------------------------------------
    // ownerId 非字串（預覽端點）— fail-closed 靜默視為自己
    // -------------------------------------------------------------------
    const NON_STRING_OWNER_IDS: Array<{ label: string; value: unknown }> = [
      { label: "數字", value: 12345 },
      { label: "物件", value: { id: "someone-else" } },
      { label: "陣列", value: ["someone-else"] },
    ];

    it.each(NON_STRING_OWNER_IDS)(
      "POST /applications/maintenance/preview — ownerId 為 $label（非字串）→ fail-closed 靜默視為自己（200，非 403/500）",
      async ({ value }) => {
        const resp = await previewHttp({
          ownerId: value,
          lastMaintenanceDate: "2064-07-01",
          currentMaintenanceDate: "2064-08-01",
          lastOdometerKm: "0.00",
          currentOdometerKm: "10.00",
          actualCost: "100.00",
        });
        // 非字串 ownerId 在 routes.ts 被 `typeof body.ownerId === "string" ?
        // body.ownerId : undefined` 轉為 undefined，resolveOwnerId(actor,
        // undefined) 恆回傳 actor.id（自己）——既不 403（未被當成「帶他人」）
        // 也不 500（未被當成格式錯誤），是靜默视为自己而非顯式拒絕。
        expect(resp.statusCode).toBe(200);
        const preview = resp.json<{ preview: MaintenanceComputedJson }>().preview;
        expect(preview.officialKm).toBe("0.00"); // 期間內無差旅（自己的資料，非他人）
      }
    );
  });
});
