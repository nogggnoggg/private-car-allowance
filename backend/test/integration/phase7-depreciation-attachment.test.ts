/**
 * Integration tests for PHASE-007-T8:
 *   折舊證明附件——上限 5（AC-23）、完成鎖定（`deriveContainerState` 之
 *   `DEPRECIATION` 分支擴充，AC-25）、授權與孤兒（AC-26）。
 *
 * AC covered (PHASE-007 Spec §2 群組 G): AC-23、AC-25、AC-26；
 * B-21~B-25（B-21/22 上限與重複 id、B-23 他人附件、B-24 完成後刪除、
 * B-25 草稿刪除後之孤兒）。
 *
 * Test discipline (Spec §11.0 / Packet):
 *   - loginName prefix "p7t8_" + per-run random suffix。
 *   - cleanup 僅限本檔追蹤之 application／attachment id ＋ loginName 前綴；
 *     **絕不** `deleteMany({})`。
 *   - 一律合成資料（合成 JPEG magic bytes，無真實影像、無真實個資）。
 *
 * ── 修復前紅燈實證（Spec §15 T8 Done When 硬性項、§16 D10(a)） ───────────
 *
 * (1) AC-25 / B-24：本 Task 動工時，`deriveContainerState`
 *     （`backend/src/attachment/lifecycle-service.ts`）之 `DEPRECIATION`
 *     分支**無條件回 `'draft'`**（PHASE-003 之佔位註記「子表尚不存在，
 *     PHASE-007，防禦性」）。PHASE-007-T1 建表後這即成**真實安全缺口**：
 *     已完成折舊申請的證明附件仍可被 `DELETE /attachments/:id` 刪除／替換
 *     （違反 BE-US-25 第 4 條與 NFR-US-10）。下方
 *     `describe("AC-25 完成後鎖定")` 的第一條測試即為該缺口之修復前紅燈，
 *     其 RED 原文（`expected 200 to be 403`）逐字記錄於 Task Handoff 之
 *     Test Results。修復後該條轉綠，並永久留存為回歸守門——未來若有人把
 *     `DEPRECIATION` 分支改回佔位，本條會再次轉紅。
 *
 * (2) B-25（AC-05／AC-26 之孤兒補洞）：`deleteApplication`
 *     （`backend/src/applications/travel-service.ts`）原本只 detach
 *     `TRIP_SEGMENT` 與 `MAINTENANCE`，刪除折舊草稿會留下永遠停在 `LINKED`
 *     的孤兒附件（`isEligibleForCleanup` 對 `LINKED` 恆回 false，故 TTL
 *     永遠掃不到）。該補洞已於 PHASE-007-T4 隨草稿 DELETE 一併落地（本
 *     Task 之 Files Forbidden 涵蓋 `travel-service.ts`，故本 Task 未再改
 *     動該檔）。本檔以**活體突變自證**取得等價的修復前紅燈證據：暫時移除
 *     `detachAttachmentsByRefTx(tx, "DEPRECIATION", [id])` 一行後，下方
 *     `describe("AC-26 …")` 的 B-25 條轉紅（附件仍為 `LINKED` 且指向已刪除
 *     的申請），還原後轉綠；RED 原文同樣逐字記錄於 Handoff。
 */
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const LOGIN_PREFIX = "p7t8_";
const PASSWORD = "DepreciationAttachmentTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;
const PCR_LOGIN = `${LOGIN_PREFIX}pcr_${RUN_ID}`;

describeWithDb("PHASE-007-T8 — 折舊附件：上限 5 ＋ 對帳 ＋ 完成鎖定 ＋ 授權", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let otherId: string;
  let adminId: string;
  let pcrId: string;

  let ownerCookie: string;
  let otherCookie: string;
  let adminCookie: string;
  let pcrCookie: string;

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

  async function createOwnerDraft(payload: Record<string, unknown> = {}) {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/depreciation",
      headers: { cookie: ownerCookie },
      payload,
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ application: Record<string, unknown> & { id: string } }>();
    trackApp(body.application.id);
    return body.application;
  }

  async function createDraftFor(cookie: string, payload: Record<string, unknown> = {}) {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/depreciation",
      headers: { cookie },
      payload,
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<{ application: Record<string, unknown> & { id: string } }>();
    trackApp(body.application.id);
    return body.application;
  }

  async function putDraft(cookie: string, id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/applications/depreciation/${id}`,
      headers: { cookie },
      payload,
    });
  }

  function countLinked(applicationId: string): Promise<number> {
    return prisma.attachment.count({
      where: { refType: "DEPRECIATION", refId: applicationId, status: "LINKED" },
    });
  }

  /**
   * 直接把父列撥到 COMPLETED（T9 之完成流程尚未落地）。
   * 快照欄位刻意不寫——`buildSnapshotDto` 對此情形優雅回 `null`（既有慣例），
   * 而 `deriveContainerState` 只讀 `Application.status`，正是本 Task 要驗的面。
   */
  async function markCompleted(applicationId: string, totalAmount = 12345) {
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: "COMPLETED", completedAt: new Date(), totalAmount },
    });
  }

  /** 直接建立一張 refType=DEPRECIATION 的 LINKED 附件（免上傳來回）。 */
  async function createLinkedDepreciationAttachment(applicationId: string, forOwnerId: string) {
    const att = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `p7t8-synthetic-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
        mimeType: "image/jpeg",
        byteSize: 123,
        originalFilename: "synthetic.jpg",
        uploaderId: forOwnerId,
        ownerId: forOwnerId,
        refType: "DEPRECIATION",
        refId: applicationId,
        linkedAt: new Date(),
      },
    });
    trackAttachment(att.id);
    return att;
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
    // 合成的最小合法 JPEG magic header ＋ padding（非真實影像）。
    const buf = Buffer.alloc(size, 0xaa);
    buf[0] = 0xff;
    buf[1] = 0xd8;
    buf[2] = 0xff;
    return buf;
  }

  /** 經真實 `POST /attachments` 上傳取得 TEMP 附件（真實 TEMP→LINKED 轉換需要）。 */
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
    trackAttachment(id);
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
        displayName: "P7T8 擁有人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const other = await prisma.user.create({
      data: {
        loginName: OTHER_LOGIN,
        displayName: "P7T8 他人",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const admin = await prisma.user.create({
      data: {
        loginName: ADMIN_LOGIN,
        displayName: "P7T8 管理員",
        passwordHash: hash,
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    const pcr = await prisma.user.create({
      data: {
        loginName: PCR_LOGIN,
        displayName: "P7T8 待改密碼",
        passwordHash: hash,
        role: "USER",
        isActive: true,
        mustChangePassword: true,
      },
    });

    ownerId = owner.id;
    otherId = other.id;
    adminId = admin.id;
    pcrId = pcr.id;

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    ownerCookie = await loginUser(app, OWNER_LOGIN, PASSWORD);
    otherCookie = await loginUser(app, OTHER_LOGIN, PASSWORD);
    adminCookie = await loginUser(app, ADMIN_LOGIN, PASSWORD);
    pcrCookie = await loginUser(app, PCR_LOGIN, PASSWORD);
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
      const userIds = [ownerId, otherId, adminId, pcrId].filter(Boolean);
      if (userIds.length > 0) {
        await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      }
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
  });

  // ===========================================================================
  // AC-25 — 完成鎖定（deriveContainerState 之 DEPRECIATION 分支修復）
  //
  // 本區塊第一條即「修復前紅燈」之所在（Done When 硬性項）：動工時
  // `deriveContainerState` 的 DEPRECIATION 分支恆回 'draft'，故已完成折舊的
  // 證明可被刪除（實測回 200，附件被 detach 回 TEMP）。
  // ===========================================================================

  describe("AC-25 完成後鎖定（deriveContainerState DEPRECIATION 分支）", () => {
    it("B-24: DELETE /attachments/:id on a COMPLETED depreciation proof returns 403 and changes nothing (RED before the deriveContainerState fix — placeholder branch returned 'draft', so this used to be 200)", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      const attachment = await createLinkedDepreciationAttachment(draft.id as string, ownerId);
      await markCompleted(draft.id as string);

      const resp = await app.inject({
        method: "DELETE",
        url: `/attachments/${attachment.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");

      // 零副作用：附件仍 LINKED 且仍指向該申請。
      const stillThere = await prisma.attachment.findUnique({ where: { id: attachment.id } });
      expect(stillThere?.status).toBe("LINKED");
      expect(stillThere?.refType).toBe("DEPRECIATION");
      expect(stillThere?.refId).toBe(draft.id as string);
    });

    it("管理員亦不得刪除已完成折舊之證明（403；鎖定是容器狀態而非身分）", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      const attachment = await createLinkedDepreciationAttachment(draft.id as string, ownerId);
      await markCompleted(draft.id as string);

      const resp = await app.inject({
        method: "DELETE",
        url: `/attachments/${attachment.id}`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");

      const stillThere = await prisma.attachment.findUnique({ where: { id: attachment.id } });
      expect(stillThere?.status).toBe("LINKED");
    });

    it("正向對照組：DRAFT 折舊之證明仍可刪除（完成鎖定不得過度封鎖）", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      const attachment = await createLinkedDepreciationAttachment(draft.id as string, ownerId);

      const resp = await app.inject({
        method: "DELETE",
        url: `/attachments/${attachment.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(200);

      const detached = await prisma.attachment.findUnique({ where: { id: attachment.id } });
      expect(detached?.status).toBe("TEMP");
      expect(detached?.refType).toBeNull();
      expect(detached?.refId).toBeNull();
    });

    it("孤兒（refId 指向已不存在之 Application）→ 視為 draft、可刪除，絕不 500", async () => {
      // 直接建立一張指向不存在申請 id 的 LINKED 附件（模擬孤兒殘留）。
      const orphan = await prisma.attachment.create({
        data: {
          status: "LINKED",
          storageKey: `p7t8-orphan-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
          mimeType: "image/jpeg",
          byteSize: 10,
          originalFilename: "orphan.jpg",
          uploaderId: ownerId,
          ownerId,
          refType: "DEPRECIATION",
          refId: `p7t8-no-such-application-${RUN_ID}`,
          linkedAt: new Date(),
        },
      });
      trackAttachment(orphan.id);

      const resp = await app.inject({
        method: "DELETE",
        url: `/attachments/${orphan.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(200);

      const row = await prisma.attachment.findUnique({ where: { id: orphan.id } });
      expect(row?.status).toBe("TEMP");
    });

    it("鑑別力：完成鎖定確實由 Application.status 推導——把同一申請改回 DRAFT 後，同一張附件即可刪除", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      const attachment = await createLinkedDepreciationAttachment(draft.id as string, ownerId);
      await markCompleted(draft.id as string);

      const blocked = await app.inject({
        method: "DELETE",
        url: `/attachments/${attachment.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(blocked.statusCode).toBe(403);

      await prisma.application.update({
        where: { id: draft.id as string },
        data: { status: "DRAFT", completedAt: null, totalAmount: null },
      });

      const allowed = await app.inject({
        method: "DELETE",
        url: `/attachments/${attachment.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(allowed.statusCode).toBe(200);
    });

    it("已完成折舊之附件亦不得經 PUT attachmentIds[] 抽換（狀態機 403 先於一切）", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      const attachment = await createLinkedDepreciationAttachment(draft.id as string, ownerId);
      await markCompleted(draft.id as string);

      const resp = await putDraft(ownerCookie, draft.id as string, { attachmentIds: [] });
      expect(resp.statusCode).toBe(403);
      expect(await countLinked(draft.id as string)).toBe(1);
      const stillThere = await prisma.attachment.findUnique({ where: { id: attachment.id } });
      expect(stillThere?.status).toBe("LINKED");
    });

    it("既有 TRIP_SEGMENT／MAINTENANCE 之推導零回歸：已完成保養之證明仍為 403、DRAFT 保養之證明仍為 200", async () => {
      // 保養（既有 PHASE-006 分支）——本 Task 的擴充不得影響他型。
      const mResp = await app.inject({
        method: "POST",
        url: "/applications/maintenance",
        headers: { cookie: ownerCookie },
        payload: {},
      });
      expect(mResp.statusCode).toBe(201);
      const maintenanceId = mResp.json<{ application: { id: string } }>().application.id;
      trackApp(maintenanceId);

      const mkMaintenanceAttachment = async () => {
        const att = await prisma.attachment.create({
          data: {
            status: "LINKED",
            storageKey: `p7t8-maint-${RUN_ID}-${Math.random().toString(36).slice(2)}`,
            mimeType: "image/jpeg",
            byteSize: 10,
            originalFilename: "maint.jpg",
            uploaderId: ownerId,
            ownerId,
            refType: "MAINTENANCE",
            refId: maintenanceId,
            linkedAt: new Date(),
          },
        });
        trackAttachment(att.id);
        return att;
      };

      const draftAtt = await mkMaintenanceAttachment();
      const draftDel = await app.inject({
        method: "DELETE",
        url: `/attachments/${draftAtt.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(draftDel.statusCode).toBe(200);

      const completedAtt = await mkMaintenanceAttachment();
      await markCompleted(maintenanceId, 5000);
      const completedDel = await app.inject({
        method: "DELETE",
        url: `/attachments/${completedAtt.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(completedDel.statusCode).toBe(403);
    });
  });

  // ===========================================================================
  // AC-23 — 上限 5（沿既有 canLink／linkAttachmentTx，不重寫上限邏輯）
  // ===========================================================================

  describe("AC-23 上限 5：第 6 張 409 TOO_MANY_ATTACHMENTS ＋ 全交易回滾", () => {
    it("恰 5 張可儲存（邊界正例，防誤殺）", async () => {
      const draft = await createOwnerDraft({});
      const ids = [
        await uploadTemp(ownerCookie, "a1.jpg"),
        await uploadTemp(ownerCookie, "a2.jpg"),
        await uploadTemp(ownerCookie, "a3.jpg"),
        await uploadTemp(ownerCookie, "a4.jpg"),
        await uploadTemp(ownerCookie, "a5.jpg"),
      ];
      const resp = await putDraft(ownerCookie, draft.id as string, { attachmentIds: ids });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ application: { attachments: { id: string }[] } }>();
      expect(body.application.attachments.map((a) => a.id).sort()).toEqual([...ids].sort());
      expect(await countLinked(draft.id as string)).toBe(5);
    });

    it("B-21: 已有 5 張再加第 6 張 → 409 TOO_MANY_ATTACHMENTS，且同一 PUT 之業務欄位一併回滾", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2024 });
      const five = [
        await uploadTemp(ownerCookie, "b1.jpg"),
        await uploadTemp(ownerCookie, "b2.jpg"),
        await uploadTemp(ownerCookie, "b3.jpg"),
        await uploadTemp(ownerCookie, "b4.jpg"),
        await uploadTemp(ownerCookie, "b5.jpg"),
      ];
      expect(
        (await putDraft(ownerCookie, draft.id as string, { attachmentIds: five })).statusCode
      ).toBe(200);

      const sixth = await uploadTemp(ownerCookie, "b6.jpg");
      const resp = await putDraft(ownerCookie, draft.id as string, {
        attachmentIds: [...five, sixth],
        applicationYear: 2026, // 同一 PUT 夾帶之業務欄位——必須一併回滾
      });
      expect(resp.statusCode).toBe(409);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("TOO_MANY_ATTACHMENTS");

      // 全交易回滾：仍恰 5 張、年度仍為 2024、第 6 張仍為 TEMP。
      expect(await countLinked(draft.id as string)).toBe(5);
      const row = await prisma.depreciationApplication.findUnique({
        where: { applicationId: draft.id as string },
      });
      expect(row?.applicationYear).toBe(2024);
      const sixthRow = await prisma.attachment.findUnique({ where: { id: sixth } });
      expect(sixthRow?.status).toBe("TEMP");
      expect(sixthRow?.refId).toBeNull();
    });

    it("B-21: 單次 PUT 宣告 6 個全新 id → 409，零關聯（部分關聯必須全數回滾）", async () => {
      const draft = await createOwnerDraft({});
      const six = [
        await uploadTemp(ownerCookie, "c1.jpg"),
        await uploadTemp(ownerCookie, "c2.jpg"),
        await uploadTemp(ownerCookie, "c3.jpg"),
        await uploadTemp(ownerCookie, "c4.jpg"),
        await uploadTemp(ownerCookie, "c5.jpg"),
        await uploadTemp(ownerCookie, "c6.jpg"),
      ];
      const resp = await putDraft(ownerCookie, draft.id as string, { attachmentIds: six });
      expect(resp.statusCode).toBe(409);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("TOO_MANY_ATTACHMENTS");

      expect(await countLinked(draft.id as string)).toBe(0);
      for (const id of six) {
        const row = await prisma.attachment.findUnique({ where: { id } });
        expect(row?.status).toBe("TEMP");
        expect(row?.refId).toBeNull();
      }
    });

    it("B-22: attachmentIds[] 含重複 id 不得藉重複繞過上限——第二次見到同一 id 時該附件已 LINKED → 409 CONFLICT，零關聯", async () => {
      const draft = await createOwnerDraft({});
      const dup = await uploadTemp(ownerCookie, "d1.jpg");
      const resp = await putDraft(ownerCookie, draft.id as string, {
        attachmentIds: [dup, dup],
      });
      // 語意說明（Spec §5 B-22 措辭為「去重後計數」）：現況實作以既有
      // `linkAttachmentTx` 之「已 LINKED → 409 CONFLICT」封閉重複 id，與
      // PHASE-006 同型（不新增第二套去重規則）。無論回哪一種 4xx，B-22 的
      // 規範性要求「不得藉重複繞過上限」皆由下方「零關聯」斷言把關。
      expect(resp.statusCode).toBe(409);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("CONFLICT");
      expect(await countLinked(draft.id as string)).toBe(0);
      const row = await prisma.attachment.findUnique({ where: { id: dup } });
      expect(row?.status).toBe("TEMP");
    });

    it("B-22: 以 6 個 id 但其中含重複（3 個相異 id 重複兩次）仍不得產生 >5 之關聯", async () => {
      const draft = await createOwnerDraft({});
      const three = [
        await uploadTemp(ownerCookie, "e1.jpg"),
        await uploadTemp(ownerCookie, "e2.jpg"),
        await uploadTemp(ownerCookie, "e3.jpg"),
      ];
      const resp = await putDraft(ownerCookie, draft.id as string, {
        attachmentIds: [...three, ...three],
      });
      expect(resp.statusCode).toBe(409);
      expect(await countLinked(draft.id as string)).toBeLessThanOrEqual(5);
      expect(await countLinked(draft.id as string)).toBe(0); // 全交易回滾
    });

    it("宣告同一組 5 個 id 兩次為 no-op（仍恰 5 張、不因重送而 409）", async () => {
      const draft = await createOwnerDraft({});
      const five = [
        await uploadTemp(ownerCookie, "f1.jpg"),
        await uploadTemp(ownerCookie, "f2.jpg"),
        await uploadTemp(ownerCookie, "f3.jpg"),
        await uploadTemp(ownerCookie, "f4.jpg"),
        await uploadTemp(ownerCookie, "f5.jpg"),
      ];
      expect(
        (await putDraft(ownerCookie, draft.id as string, { attachmentIds: five })).statusCode
      ).toBe(200);
      expect(
        (await putDraft(ownerCookie, draft.id as string, { attachmentIds: five })).statusCode
      ).toBe(200);
      expect(await countLinked(draft.id as string)).toBe(5);
    });

    it("上限常數為後端權威：DEPRECIATION_ATTACHMENT_LIMIT === 5（結構性釘樁），且無任何端點可自帶 limit（POST /attachments/:id/link 為 404）", async () => {
      const mod = await import("../../src/applications/depreciation-service.js");
      expect(mod.DEPRECIATION_ATTACHMENT_LIMIT).toBe(5);

      const attachmentId = await uploadTemp(ownerCookie, "link-probe.jpg");
      const resp = await app.inject({
        method: "POST",
        url: `/attachments/${attachmentId}/link`,
        headers: { cookie: ownerCookie },
        payload: {
          refType: "DEPRECIATION",
          refId: "whatever",
          limit: 999,
          containerState: "draft",
        },
      });
      expect(resp.statusCode).toBe(404);
    });
  });

  // ===========================================================================
  // AC-26 — 授權與孤兒
  // ===========================================================================

  describe("AC-26 授權：附件讀取端點之五身分 ＋ 掛入守門 ＋ B-25 孤兒補洞", () => {
    async function ownerProof(): Promise<{ applicationId: string; attachmentId: string }> {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      const attachmentId = await uploadTemp(ownerCookie, "authz.jpg");
      const linkResp = await putDraft(ownerCookie, draft.id as string, {
        attachmentIds: [attachmentId],
      });
      expect(linkResp.statusCode).toBe(200);
      return { applicationId: draft.id as string, attachmentId };
    }

    it("擁有人本人可讀 content 與 thumbnail（200）", async () => {
      const { attachmentId } = await ownerProof();

      const contentResp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/content`,
        headers: { cookie: ownerCookie },
      });
      expect(contentResp.statusCode).toBe(200);
      expect(contentResp.headers["content-type"]).toContain("image/jpeg");

      const thumbResp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/thumbnail`,
        headers: { cookie: ownerCookie },
      });
      expect(thumbResp.statusCode).toBe(200);
      expect(thumbResp.headers["content-type"]).toMatch(/^image\//);
    });

    it("他人 → 403 且零位元組（content 與 thumbnail 皆然）", async () => {
      const { attachmentId } = await ownerProof();

      const contentResp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/content`,
        headers: { cookie: otherCookie },
      });
      expect(contentResp.statusCode).toBe(403);
      expect(contentResp.headers["content-type"]).toContain("application/json");

      const thumbResp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/thumbnail`,
        headers: { cookie: otherCookie },
      });
      expect(thumbResp.statusCode).toBe(403);
      expect(thumbResp.headers["content-type"]).toContain("application/json");
    });

    it("未登入 → 401（content 與 thumbnail 皆然，零位元組）", async () => {
      const { attachmentId } = await ownerProof();

      const contentResp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/content`,
      });
      expect(contentResp.statusCode).toBe(401);
      expect(contentResp.headers["content-type"]).toContain("application/json");

      const thumbResp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/thumbnail`,
      });
      expect(thumbResp.statusCode).toBe(401);
      expect(thumbResp.headers["content-type"]).toContain("application/json");
    });

    it("管理員 → 200（§6.1 第 8 列）", async () => {
      const { attachmentId } = await ownerProof();
      const resp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/content`,
        headers: { cookie: adminCookie },
      });
      expect(resp.statusCode).toBe(200);
    });

    it("PCR（mustChangePassword）讀自己的折舊證明 → 200（§6.1 第 8 列：附件讀取不掛 requirePasswordChanged）", async () => {
      // PCR 使用者本身無法呼叫 `POST /attachments`（上傳端點掛
      // `requirePasswordChanged`），故先由 owner 真實上傳取得合法 storageKey
      // 與實體檔案，再把該列之 `ownerId` 改指 PCR 使用者——如此讀取端點面對
      // 的是一張「PCR 使用者擁有、且位元組確實存在」的附件，才能真正驗到
      // §6.1 第 8 列所要求的 **200**（而非因檔案不存在而落入其他狀態碼）。
      const attachmentId = await uploadTemp(ownerCookie, "pcr.jpg");
      await prisma.attachment.update({
        where: { id: attachmentId },
        data: { ownerId: pcrId },
      });

      const contentResp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/content`,
        headers: { cookie: pcrCookie },
      });
      expect(contentResp.statusCode).toBe(200);
      expect(contentResp.headers["content-type"]).toContain("image/jpeg");

      const thumbResp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/thumbnail`,
        headers: { cookie: pcrCookie },
      });
      expect(thumbResp.statusCode).toBe(200);

      // 對照組：同一張附件對「其他一般使用者」仍為 403——PCR 之 200 來自
      // 擁有權，不是因為讀取端點對所有人放行。
      const otherResp = await app.inject({
        method: "GET",
        url: `/attachments/${attachmentId}/content`,
        headers: { cookie: otherCookie },
      });
      expect(otherResp.statusCode).toBe(403);
    });

    it("B-23: attachmentIds[] 含他人附件 → 403 FORBIDDEN（fail-closed），零關聯", async () => {
      const draft = await createOwnerDraft({});
      const othersAttachment = await uploadTemp(otherCookie, "others.jpg");
      const resp = await putDraft(ownerCookie, draft.id as string, {
        attachmentIds: [othersAttachment],
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
      expect(resp.json<{ error: { message: string } }>().error.message).toContain(
        "附件擁有人與申請擁有人不一致"
      );

      expect(await countLinked(draft.id as string)).toBe(0);
      const row = await prisma.attachment.findUnique({ where: { id: othersAttachment } });
      expect(row?.status).toBe("TEMP");
      expect(row?.refId).toBeNull();
    });

    it("管理員代掛自己的附件到他人草稿 → 403（授權面不因管理員身分而擴大；管理員之 PUT 權限不等於跨擁有人掛入權限）", async () => {
      const othersDraft = await createDraftFor(otherCookie, {});
      const adminAttachment = await uploadTemp(adminCookie, "admin-own.jpg");

      const resp = await putDraft(adminCookie, othersDraft.id as string, {
        attachmentIds: [adminAttachment],
      });
      expect(resp.statusCode).toBe(403);
      expect(resp.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");

      expect(await countLinked(othersDraft.id as string)).toBe(0);
      const row = await prisma.attachment.findUnique({ where: { id: adminAttachment } });
      expect(row?.status).toBe("TEMP");
      expect(row?.refId).toBeNull();
    });

    it("一般使用者對他人草稿之 PUT 一律 403（授權先於任何附件業務規則）", async () => {
      const othersDraft = await createDraftFor(otherCookie, {});
      const ownAttachment = await uploadTemp(ownerCookie, "mine.jpg");

      const resp = await putDraft(ownerCookie, othersDraft.id as string, {
        attachmentIds: [ownAttachment],
      });
      expect(resp.statusCode).toBe(403);
      expect(await countLinked(othersDraft.id as string)).toBe(0);
    });

    it("LINKED 偷渡封閉：已關聯於他處之附件不得再掛入另一折舊草稿 → 409 CONFLICT", async () => {
      const draft1 = await createOwnerDraft({});
      const draft2 = await createOwnerDraft({});
      const attachmentId = await uploadTemp(ownerCookie, "steal.jpg");

      expect(
        (await putDraft(ownerCookie, draft1.id as string, { attachmentIds: [attachmentId] }))
          .statusCode
      ).toBe(200);

      const second = await putDraft(ownerCookie, draft2.id as string, {
        attachmentIds: [attachmentId],
      });
      expect(second.statusCode).toBe(409);
      expect(second.json<{ error: { code: string } }>().error.code).toBe("CONFLICT");

      // 原容器不受影響。
      expect(await countLinked(draft1.id as string)).toBe(1);
      expect(await countLinked(draft2.id as string)).toBe(0);
    });

    it("B-25: 刪除折舊草稿於同一交易內 detach 其 DEPRECIATION 附件回 TEMP，不留孤兒 LINKED（活體突變自證：移除 deleteApplication 之 DEPRECIATION detach 一行後本條必紅）", async () => {
      const draft = await createOwnerDraft({ applicationYear: 2025 });
      const att1 = await createLinkedDepreciationAttachment(draft.id as string, ownerId);
      const att2 = await createLinkedDepreciationAttachment(draft.id as string, ownerId);

      const resp = await app.inject({
        method: "DELETE",
        url: `/applications/${draft.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(resp.statusCode).toBe(200);

      for (const att of [att1, att2]) {
        const row = await prisma.attachment.findUnique({ where: { id: att.id } });
        expect(row?.status).toBe("TEMP");
        expect(row?.refType).toBeNull();
        expect(row?.refId).toBeNull();
        expect(row?.linkedAt).toBeNull();
      }

      // 父列確實已刪除——證明上面的 TEMP 不是「因為刪除失敗才沒動」。
      const parent = await prisma.application.findUnique({ where: { id: draft.id as string } });
      expect(parent).toBeNull();
    });
  });
});
