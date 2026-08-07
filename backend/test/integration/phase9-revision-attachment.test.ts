/**
 * Integration tests for PHASE-009-T6:
 *   修正版之證明附件複製（位元組複製 ＋ 段對位 ＋ 失敗補償）。
 *
 * Spec `docs/specs/PHASE-009.md` AC-14（§2 :189，依 §16 **D6**＝(c) 複製位元組）逐字：
 *   (a) 原申請每一筆 `status='LINKED'` 之附件，於修正版產生**一筆新
 *       `Attachment` 列**（新 `id`、**新 `storageKey`**、`ownerId` ＝原擁有人、
 *       `uploaderId` ＝實際操作者、`status='LINKED'`、`refType`／`refId` 指向
 *       **新**容器）。
 *   (b) 新舊 `storageKey` **互異**且新檔位元組與原檔**逐位元組相同**
 *       （SHA-256 比對），縮圖同步複製（`thumbnailKey` 有值時）。
 *   (c) **差旅段對應**：原段 N 之附件恰複製至新段 N（依 `sortOrder` 對位，
 *       不跨段錯置）。
 *   (d) 附件上限（差旅每段 5、保養 5、折舊 5）於複製後仍成立。
 *   (e) 複製失敗（storage 讀寫錯誤）→ **整筆修正版交易回滾**、零殘留
 *       （DB 零新增列、storage 已寫之新 key 補償刪除），回應 500 且**日誌零
 *       storage key**。
 *
 * ── AC-14(d) 之上限常數：Spec 字面與實作之差異（誠實揭露，Handoff Warnings）──
 * AC-14(d) 字面寫「差旅每段 5」，但既有實作之權威常數為
 * `travel-service.ts:106` `SEGMENT_ATTACHMENT_LIMIT = 3`（PHASE-004-T11
 * AC-22／Spec §10.4「附件上限 3 為業務常數」）；保養／折舊確為 5
 * （`MAINTENANCE_ATTACHMENT_LIMIT`／`DEPRECIATION_ATTACHMENT_LIMIT`）。本檔
 * **不改變**任何常數，一律 import 既有常數作為斷言基準——AC-14(d) 之驗收語意
 * 是「複製後上限仍成立」，以真實常數驗證即為其忠實落地；Spec 之「5」屬字面
 * 失準，已於 Handoff 回報，不由本 Task 逕改 Spec。
 *
 * ── 本檔為何直接呼叫 service 而非端點 ────────────────────────────────────
 * `POST /applications/:id/revision` 端點屬 **T7**（本 Task 之 Files
 * Forbidden）。AC-14(e) 之「回應 500」為端點層語意，本 Task 交付其 service 層
 * 前提：拋出 `AppError("INTERNAL_ERROR", 500, …)`（既有 error-handler 逐字映
 * 射為 HTTP 500），並在此斷言該 code／httpStatus；HTTP 面之逐字斷言歸 T7。
 *
 * Test discipline（Spec §11.0 / Packet）：
 *   - loginName 前綴 "p9t6_" ＋ 每次執行之隨機後綴（RUN_ID）。
 *   - cleanup 僅限本檔建立之 user／application／attachment；絕不 `deleteMany({})`。
 *   - 一律合成資料（位元組為可辨識之 ASCII 標記，非真實圖檔）。
 *   - fixture 使用者顯式指定 `mustChangePassword: false`（T3 假綠教訓）。
 *   - 已完成申請以直寫 Prisma 合成（沿 `phase9-void.test.ts`／
 *     `phase9-revision.test.ts` 既有先例）——本檔測試對象是「附件複製」本身。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AttachmentRefType } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPRECIATION_ATTACHMENT_LIMIT } from "../../src/applications/depreciation-service.js";
import { MAINTENANCE_ATTACHMENT_LIMIT } from "../../src/applications/maintenance-service.js";
import { SEGMENT_ATTACHMENT_LIMIT } from "../../src/applications/travel-service.js";
import { createApplicationRevisionWithAttachments } from "../../src/attachment/attachment-copy.js";
import { hashPassword } from "../../src/auth/password.js";
import type { Storage } from "../../src/storage/index.js";
import { LocalVolumeStorage } from "../../src/storage/index.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const LOGIN_PREFIX = "p9t6_";
const PASSWORD = "P9t6-Synthetic-Passw0rd!";

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** 遞迴列出 storage root 下之全部檔案相對路徑（殘留檔偵測用）。 */
function listStorageFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  walk(root);
  return out.sort();
}

/**
 * 注入式失敗 storage —— 包住真實 `LocalVolumeStorage`，於第 `failOnPutIndex`
 * 次 `put`（0-based）拋出 storage 錯誤（訊息刻意含 storage key，用以檢驗
 * production 端不得把它寫進日誌）。所有實際落地之 key 皆記錄於 `putKeys`，
 * 供補償刪除之逐 key 斷言。
 */
class FailingStorage implements Storage {
  readonly putKeys: string[] = [];
  private putCount = 0;

  constructor(
    private readonly inner: Storage,
    private readonly failOnPutIndex: number
  ) {}

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const index = this.putCount++;
    if (index === this.failOnPutIndex) {
      throw new Error(`Injected storage failure while writing key: ${JSON.stringify(key)}`);
    }
    await this.inner.put(key, bytes, contentType);
    this.putKeys.push(key);
  }

  get(key: string): Promise<Buffer | NodeJS.ReadableStream> {
    return this.inner.get(key);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  exists(key: string): Promise<boolean> {
    return this.inner.exists(key);
  }
}

describeWithDb("PHASE-009-T6 修正版之證明附件複製（AC-14）", () => {
  let prisma: PrismaClient;
  let storage: LocalVolumeStorage;
  let storageRoot: string;
  let ownerId: string;
  let adminId: string;
  const createdApplicationIds: string[] = [];
  const createdUserIds: string[] = [];
  let attachmentSeq = 0;

  function trackApp(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  /** 收集式 log（AC-14(e)「日誌零 storage key」之掃描面）。 */
  function createCapturingLog(): { lines: string[]; warn: (msg: string) => void } {
    const lines: string[] = [];
    return { lines, warn: (msg: string) => lines.push(msg) };
  }

  interface SeededAttachment {
    id: string;
    storageKey: string;
    thumbnailKey: string | null;
    bytes: Buffer;
    thumbBytes: Buffer | null;
    originalFilename: string;
    byteSize: number;
  }

  /**
   * 合成一筆 LINKED 附件：位元組寫入 storage ＋ 建立 `Attachment` 列。
   * `payload` 為可辨識之 ASCII 標記，使「段—圖對位」可由內容直接判定。
   */
  async function seedAttachment(
    refType: AttachmentRefType,
    refId: string,
    payload: string,
    withThumb: boolean
  ): Promise<SeededAttachment> {
    const storageId = `p9t6${RUN_ID}${attachmentSeq++}`;
    const storageKey = `att/${storageId}/original`;
    const bytes = Buffer.from(`ORIGINAL:${payload}`, "utf8");
    await storage.put(storageKey, bytes, "image/jpeg");

    let thumbnailKey: string | null = null;
    let thumbBytes: Buffer | null = null;
    if (withThumb) {
      thumbnailKey = `att/${storageId}/thumb`;
      thumbBytes = Buffer.from(`THUMB:${payload}`, "utf8");
      await storage.put(thumbnailKey, thumbBytes, "image/jpeg");
    }

    const originalFilename = `p9t6-${payload}.jpg`;
    const row = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey,
        thumbnailKey,
        mimeType: "image/jpeg",
        byteSize: bytes.length,
        originalFilename,
        uploaderId: ownerId,
        ownerId,
        refType,
        refId,
        linkedAt: new Date("2026-03-01T01:02:03.456Z"),
      },
    });

    return {
      id: row.id,
      storageKey,
      thumbnailKey,
      bytes,
      thumbBytes,
      originalFilename,
      byteSize: bytes.length,
    };
  }

  /** 已完成差旅；`sortOrders` 為**插入順序**（刻意可與 sortOrder 升序不同）。 */
  async function createCompletedTravel(suffix: string, sortOrders: number[]): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-03-15T00:00:00.000Z"),
        totalAmount: 1500,
        completedAt: new Date("2026-03-15T08:00:00.000Z"),
        travel: {
          create: {
            tripDate: new Date("2026-03-15T00:00:00.000Z"),
            purpose: `PHASE-009-T6 出差-${suffix}`,
            segments: {
              create: sortOrders.map((sortOrder) => ({
                sortOrder,
                origin: `起-${sortOrder}`,
                destination: `迄-${sortOrder}`,
                totalKm: "80.50",
                highwayKm: "60.00",
              })),
            },
          },
        },
      },
    });
    return trackApp(created.id);
  }

  async function createCompletedMaintenance(suffix: string): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "MAINTENANCE",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2026-04-01T00:00:00.000Z"),
        totalAmount: 300,
        completedAt: new Date("2026-04-01T08:00:00.000Z"),
        maintenance: {
          create: {
            lastMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
            currentMaintenanceDate: new Date("2026-04-01T00:00:00.000Z"),
            lastOdometerKm: "1000.00",
            currentOdometerKm: "1500.00",
            actualCost: `1000.0${suffix.length % 10}`,
          },
        },
      },
    });
    return trackApp(created.id);
  }

  async function createCompletedDepreciation(year: number): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "DEPRECIATION",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date(`${year}-12-31T00:00:00.000Z`),
        totalAmount: 900,
        completedAt: new Date(`${year}-12-31T08:00:00.000Z`),
        depreciation: { create: { applicationYear: year, annualTotalKm: "3000.0" } },
      },
    });
    return trackApp(created.id);
  }

  /** 依 sortOrder 升序取得某差旅之段 id。 */
  async function segmentIdsOf(applicationId: string): Promise<string[]> {
    const segments = await prisma.tripSegment.findMany({
      where: { travelApplicationId: applicationId },
      orderBy: { sortOrder: "asc" },
      select: { id: true },
    });
    return segments.map((s) => s.id);
  }

  async function linkedAttachmentsOf(
    refType: AttachmentRefType,
    refId: string
  ): Promise<
    Array<{
      id: string;
      storageKey: string;
      thumbnailKey: string | null;
      mimeType: string;
      byteSize: number;
      originalFilename: string;
      uploaderId: string;
      ownerId: string;
      status: string;
      refType: AttachmentRefType | null;
      refId: string | null;
      linkedAt: Date | null;
    }>
  > {
    return prisma.attachment.findMany({
      where: { status: "LINKED", refType, refId },
      orderBy: { storageKey: "asc" },
      select: {
        id: true,
        storageKey: true,
        thumbnailKey: true,
        mimeType: true,
        byteSize: true,
        originalFilename: true,
        uploaderId: true,
        ownerId: true,
        status: true,
        refType: true,
        refId: true,
        linkedAt: true,
      },
    });
  }

  /** 本檔合成使用者名下之全部 `TripSegment` 列數（範圍封閉，不受其他檔案影響）。 */
  async function countOwnerSegments(): Promise<number> {
    const travelApplicationIds = (
      await prisma.application.findMany({
        where: { ownerId, type: "TRAVEL" },
        select: { id: true },
      })
    ).map((a) => a.id);
    return prisma.tripSegment.count({
      where: { travelApplicationId: { in: travelApplicationIds } },
    });
  }

  async function readKey(key: string): Promise<Buffer> {
    return storage.get(key);
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase9-t6-att-"));
    storage = new LocalVolumeStorage(storageRoot);

    const owner = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}owner_${RUN_ID}`,
        displayName: "T6 擁有人",
        passwordHash: await hashPassword(PASSWORD),
        role: "USER",
        isActive: true,
        mustChangePassword: false,
      },
    });
    ownerId = owner.id;
    createdUserIds.push(owner.id);

    const admin = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}admin_${RUN_ID}`,
        displayName: "T6 代操作管理員",
        passwordHash: await hashPassword(PASSWORD),
        role: "ADMIN",
        isActive: true,
        mustChangePassword: false,
      },
    });
    adminId = admin.id;
    createdUserIds.push(admin.id);
  });

  afterAll(async () => {
    if (!prisma) return;
    // 本檔建立之附件一律以合成使用者為 owner，範圍封閉（絕不 deleteMany({})）。
    await prisma.attachment.deleteMany({ where: { ownerId: { in: createdUserIds } } });
    for (const id of [...createdApplicationIds].reverse()) {
      await prisma.application.deleteMany({ where: { supersedesId: id } });
    }
    for (const id of [...createdApplicationIds].reverse()) {
      await prisma.application.deleteMany({ where: { id } });
    }
    for (const id of createdUserIds) {
      await prisma.user.deleteMany({ where: { id } });
    }
    await prisma.$disconnect();
    try {
      fs.rmSync(storageRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  // =========================================================================
  // AC-14(a)(b) — 三型各一正向
  // =========================================================================

  describe("AC-14(a)(b) 新列六欄 ＋ 位元組 SHA-256 相同 ＋ key 互異 ＋ 縮圖同步複製", () => {
    it("差旅：段附件複製為新列與新 storageKey（含縮圖），位元組逐位元組相同", async () => {
      const sourceId = await createCompletedTravel("ab-travel", [0]);
      const [sourceSegmentId] = await segmentIdsOf(sourceId);
      const withThumb = await seedAttachment("TRIP_SEGMENT", sourceSegmentId, "travel-a", true);
      const noThumb = await seedAttachment("TRIP_SEGMENT", sourceSegmentId, "travel-b", false);

      const before = new Date();
      const revision = await createApplicationRevisionWithAttachments(prisma, sourceId, adminId, {
        storage,
      });
      trackApp(revision.id);

      const [newSegmentId] = await segmentIdsOf(revision.id);
      const copies = await linkedAttachmentsOf("TRIP_SEGMENT", newSegmentId);
      expect(copies).toHaveLength(2);

      const sources = [withThumb, noThumb];
      for (const source of sources) {
        const copy = copies.find((c) => c.originalFilename === source.originalFilename);
        expect(copy, `找不到 ${source.originalFilename} 之複本`).toBeDefined();
        if (!copy) throw new Error("unreachable");

        // (a) 新 id／新 storageKey／ownerId ＝原擁有人／uploaderId ＝操作者／
        //     status LINKED／refType 與 refId 指向新容器。
        expect(copy.id).not.toBe(source.id);
        expect(copy.storageKey).not.toBe(source.storageKey);
        expect(copy.ownerId).toBe(ownerId);
        expect(copy.uploaderId).toBe(adminId);
        expect(copy.status).toBe("LINKED");
        expect(copy.refType).toBe("TRIP_SEGMENT");
        expect(copy.refId).toBe(newSegmentId);
        expect(copy.refId).not.toBe(sourceSegmentId);
        expect(copy.mimeType).toBe("image/jpeg");
        expect(copy.byteSize).toBe(source.byteSize);
        expect(copy.linkedAt).not.toBeNull();
        expect((copy.linkedAt as Date).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);

        // (b) 位元組 SHA-256 逐位元組相同。
        expect(sha256(await readKey(copy.storageKey))).toBe(sha256(source.bytes));

        // (b) 縮圖：原有縮圖者同步複製且 key 互異；原無縮圖者恆 null。
        if (source.thumbnailKey && source.thumbBytes) {
          expect(copy.thumbnailKey).not.toBeNull();
          expect(copy.thumbnailKey).not.toBe(source.thumbnailKey);
          expect(sha256(await readKey(copy.thumbnailKey as string))).toBe(
            sha256(source.thumbBytes)
          );
        } else {
          expect(copy.thumbnailKey).toBeNull();
        }
      }
    });

    it("保養：容器附件複製為新列與新 storageKey，位元組逐位元組相同", async () => {
      const sourceId = await createCompletedMaintenance("ab-maint");
      const source = await seedAttachment("MAINTENANCE", sourceId, "maint-a", true);

      const revision = await createApplicationRevisionWithAttachments(prisma, sourceId, adminId, {
        storage,
      });
      trackApp(revision.id);

      const copies = await linkedAttachmentsOf("MAINTENANCE", revision.id);
      expect(copies).toHaveLength(1);
      const copy = copies[0];
      expect(copy.id).not.toBe(source.id);
      expect(copy.storageKey).not.toBe(source.storageKey);
      expect(copy.ownerId).toBe(ownerId);
      expect(copy.uploaderId).toBe(adminId);
      expect(copy.status).toBe("LINKED");
      expect(copy.refType).toBe("MAINTENANCE");
      expect(copy.refId).toBe(revision.id);
      expect(copy.originalFilename).toBe(source.originalFilename);
      expect(sha256(await readKey(copy.storageKey))).toBe(sha256(source.bytes));
      expect(copy.thumbnailKey).not.toBe(source.thumbnailKey);
      expect(sha256(await readKey(copy.thumbnailKey as string))).toBe(
        sha256(source.thumbBytes as Buffer)
      );
    });

    it("折舊：容器附件複製為新列與新 storageKey，位元組逐位元組相同", async () => {
      const sourceId = await createCompletedDepreciation(2025);
      const source = await seedAttachment("DEPRECIATION", sourceId, "depre-a", false);

      const revision = await createApplicationRevisionWithAttachments(prisma, sourceId, adminId, {
        storage,
      });
      trackApp(revision.id);

      const copies = await linkedAttachmentsOf("DEPRECIATION", revision.id);
      expect(copies).toHaveLength(1);
      const copy = copies[0];
      expect(copy.id).not.toBe(source.id);
      expect(copy.storageKey).not.toBe(source.storageKey);
      expect(copy.ownerId).toBe(ownerId);
      expect(copy.uploaderId).toBe(adminId);
      expect(copy.refType).toBe("DEPRECIATION");
      expect(copy.refId).toBe(revision.id);
      expect(copy.thumbnailKey).toBeNull();
      expect(sha256(await readKey(copy.storageKey))).toBe(sha256(source.bytes));
    });

    it("來源附件之列與位元組零改動（複製流程不得觸原 storageKey）", async () => {
      const sourceId = await createCompletedMaintenance("ab-src-intact");
      const source = await seedAttachment("MAINTENANCE", sourceId, "src-intact", true);

      const beforeRow = await prisma.attachment.findUniqueOrThrow({ where: { id: source.id } });
      const beforeHash = sha256(await readKey(source.storageKey));
      const beforeThumbHash = sha256(await readKey(source.thumbnailKey as string));

      const revision = await createApplicationRevisionWithAttachments(prisma, sourceId, adminId, {
        storage,
      });
      trackApp(revision.id);

      const afterRow = await prisma.attachment.findUniqueOrThrow({ where: { id: source.id } });
      expect(afterRow).toEqual(beforeRow);
      expect(sha256(await readKey(source.storageKey))).toBe(beforeHash);
      expect(sha256(await readKey(source.thumbnailKey as string))).toBe(beforeThumbHash);
    });
  });

  // =========================================================================
  // AC-14(c) — 差旅段對位
  // =========================================================================

  describe("AC-14(c) 差旅段—圖對位複製（依 sortOrder，不跨段錯置）", () => {
    it("三段（插入順序刻意與 sortOrder 升序不同、中間段零附件）逐段對位，零跨段錯置", async () => {
      // 插入順序 1 → 2 → 0：若任一側查詢缺 `orderBy: { sortOrder: "asc" }`，
      // Postgres 之自然順序即為插入順序，對位立刻錯置 → 本 it 必紅。
      const sourceId = await createCompletedTravel("c-order", [1, 2, 0]);
      const sourceSegmentIds = await segmentIdsOf(sourceId); // sortOrder 0,1,2

      const expectedPayloads: string[][] = [
        ["seg0-a", "seg0-b"], // sortOrder 0：兩張
        [], // sortOrder 1：零張（空段亦不得被跳過而使後續段位移）
        ["seg2-a"], // sortOrder 2：一張
      ];
      const seededHashes: string[][] = [];
      for (const [index, payloads] of expectedPayloads.entries()) {
        const hashes: string[] = [];
        for (const payload of payloads) {
          const seeded = await seedAttachment(
            "TRIP_SEGMENT",
            sourceSegmentIds[index],
            payload,
            false
          );
          hashes.push(sha256(seeded.bytes));
        }
        seededHashes.push(hashes);
      }

      const revision = await createApplicationRevisionWithAttachments(prisma, sourceId, adminId, {
        storage,
      });
      trackApp(revision.id);

      const newSegmentIds = await segmentIdsOf(revision.id); // sortOrder 0,1,2
      expect(newSegmentIds).toHaveLength(3);

      for (const [index, expected] of expectedPayloads.entries()) {
        const copies = await linkedAttachmentsOf("TRIP_SEGMENT", newSegmentIds[index]);
        expect(
          copies.map((c) => c.originalFilename).sort(),
          `新段 sortOrder=${index} 之附件對位錯誤`
        ).toEqual(expected.map((p) => `p9t6-${p}.jpg`).sort());

        // 內容面對位（非僅檔名）：逐位元組雜湊集合相同。
        const copyHashes: string[] = [];
        for (const copy of copies) copyHashes.push(sha256(await readKey(copy.storageKey)));
        expect(copyHashes.sort()).toEqual([...seededHashes[index]].sort());
      }

      // 全域守恆：複製總數 ＝ 來源總數（沒有被吞掉、也沒有被複製兩次）。
      const totalCopies = await prisma.attachment.count({
        where: { status: "LINKED", refType: "TRIP_SEGMENT", refId: { in: newSegmentIds } },
      });
      expect(totalCopies).toBe(3);
    });
  });

  // =========================================================================
  // AC-14(d) — 上限於複製後仍成立
  // =========================================================================

  describe("AC-14(d) 附件上限於複製後仍成立", () => {
    it(`差旅：原段滿 ${SEGMENT_ATTACHMENT_LIMIT} 張（既有常數上限），複製後新段恰 ${SEGMENT_ATTACHMENT_LIMIT} 張且未超限`, async () => {
      const sourceId = await createCompletedTravel("d-travel", [0]);
      const [sourceSegmentId] = await segmentIdsOf(sourceId);
      for (let i = 0; i < SEGMENT_ATTACHMENT_LIMIT; i++) {
        await seedAttachment("TRIP_SEGMENT", sourceSegmentId, `d-travel-${i}`, false);
      }

      const revision = await createApplicationRevisionWithAttachments(prisma, sourceId, adminId, {
        storage,
      });
      trackApp(revision.id);

      const [newSegmentId] = await segmentIdsOf(revision.id);
      const count = await prisma.attachment.count({
        where: { status: "LINKED", refType: "TRIP_SEGMENT", refId: newSegmentId },
      });
      expect(count).toBe(SEGMENT_ATTACHMENT_LIMIT);
      expect(count).toBeLessThanOrEqual(SEGMENT_ATTACHMENT_LIMIT);
    });

    it(`保養：原容器滿 ${MAINTENANCE_ATTACHMENT_LIMIT} 張，複製後恰 ${MAINTENANCE_ATTACHMENT_LIMIT} 張且未超限`, async () => {
      const sourceId = await createCompletedMaintenance("d-maint");
      for (let i = 0; i < MAINTENANCE_ATTACHMENT_LIMIT; i++) {
        await seedAttachment("MAINTENANCE", sourceId, `d-maint-${i}`, false);
      }

      const revision = await createApplicationRevisionWithAttachments(prisma, sourceId, adminId, {
        storage,
      });
      trackApp(revision.id);

      const count = await prisma.attachment.count({
        where: { status: "LINKED", refType: "MAINTENANCE", refId: revision.id },
      });
      expect(count).toBe(MAINTENANCE_ATTACHMENT_LIMIT);
      expect(count).toBeLessThanOrEqual(MAINTENANCE_ATTACHMENT_LIMIT);
      expect(MAINTENANCE_ATTACHMENT_LIMIT).toBe(DEPRECIATION_ATTACHMENT_LIMIT);
    });
  });

  // =========================================================================
  // 空集合正向
  // =========================================================================

  it("無附件之來源：複製零動作仍成功（零 Attachment 新增、零 storage 寫入）", async () => {
    const sourceId = await createCompletedTravel("empty", [0, 1]);
    const filesBefore = listStorageFiles(storageRoot);
    const attachmentsBefore = await prisma.attachment.count({ where: { ownerId } });

    const revision = await createApplicationRevisionWithAttachments(prisma, sourceId, adminId, {
      storage,
    });
    trackApp(revision.id);

    expect(revision.supersedesId).toBe(sourceId);
    expect(await prisma.attachment.count({ where: { ownerId } })).toBe(attachmentsBefore);
    expect(listStorageFiles(storageRoot)).toEqual(filesBefore);
  });

  // =========================================================================
  // AC-14(e) — 複製失敗之整筆回滾、零殘留、日誌零 storage key
  // =========================================================================

  describe("AC-14(e) 複製失敗 → 整筆交易回滾、零殘留、500、日誌零 storage key", () => {
    it("storage put 注入失敗：DB 零新增列（Application／TripSegment／Attachment 皆零）＋ 已寫新 key 補償刪除 ＋ 500", async () => {
      const sourceId = await createCompletedTravel("e-rollback", [0]);
      const [sourceSegmentId] = await segmentIdsOf(sourceId);
      // 三張附件（首張含縮圖）：注入第 3 次 put 失敗 → 前兩次已落地之新 key
      // 必須被補償刪除，且第三張之 DB 列不得存在。
      for (let i = 0; i < 3; i++) {
        await seedAttachment("TRIP_SEGMENT", sourceSegmentId, `e-roll-${i}`, i === 0);
      }

      const applicationsBefore = await prisma.application.count({ where: { ownerId } });
      const segmentsBefore = await countOwnerSegments();
      const attachmentsBefore = await prisma.attachment.count({ where: { ownerId } });
      const filesBefore = listStorageFiles(storageRoot);

      const failing = new FailingStorage(storage, 2);
      await expect(
        createApplicationRevisionWithAttachments(prisma, sourceId, adminId, { storage: failing })
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR", httpStatus: 500 });

      // 交易確實走到過 storage 寫入（否則「補償」之斷言為恆真）。
      expect(failing.putKeys.length).toBeGreaterThan(0);

      // DB 零殘留。
      expect(await prisma.application.count({ where: { ownerId } })).toBe(applicationsBefore);
      expect(await countOwnerSegments()).toBe(segmentsBefore);
      expect(await prisma.attachment.count({ where: { ownerId } })).toBe(attachmentsBefore);
      expect(await prisma.application.count({ where: { supersedesId: sourceId } })).toBe(0);

      // storage 零殘留：逐一驗證已寫之新 key 皆被補償刪除，且整體檔案集合復原。
      for (const key of failing.putKeys) {
        expect(await storage.exists(key), "補償刪除遺漏 key（殘留檔）").toBe(false);
      }
      expect(listStorageFiles(storageRoot)).toEqual(filesBefore);
    });

    it("失敗路徑之日誌零 storage key（掃描 ＋ 反向探針證明掃描器有鑑別力）", async () => {
      const sourceId = await createCompletedMaintenance("e-log");
      const seeded = await seedAttachment("MAINTENANCE", sourceId, "e-log-0", true);
      const log = createCapturingLog();

      const failing = new FailingStorage(storage, 1); // 第二次 put（縮圖）失敗
      await expect(
        createApplicationRevisionWithAttachments(prisma, sourceId, adminId, {
          storage: failing,
          log,
        })
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR", httpStatus: 500 });

      const joined = log.lines.join("\n");
      const forbiddenFragments = [
        seeded.storageKey,
        seeded.thumbnailKey as string,
        ...failing.putKeys,
        "att/",
        storageRoot,
      ];
      for (const fragment of forbiddenFragments) {
        expect(joined.includes(fragment), "日誌洩漏 storage key／路徑片段").toBe(false);
      }

      // 反向探針：同一掃描條件對「確實含 key 的字串」必須判定為洩漏——
      // 證明上面的斷言不是因為 log 恆空／掃描條件失配而恆真。
      const probe = `compensation delete failed for ${seeded.storageKey}`;
      expect(forbiddenFragments.some((fragment) => probe.includes(fragment))).toBe(true);
    });
  });
});
