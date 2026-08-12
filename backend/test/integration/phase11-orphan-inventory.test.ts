/**
 * Integration test: PHASE-011 storage 孤兒盤點（T6）（`docs/specs/PHASE-011.md`
 * **AC-08**；§16 **D5**=(c)：只盤點、只報告，不刪除）
 *
 * ---------------------------------------------------------------------------
 * 涵蓋
 * ---------------------------------------------------------------------------
 *   · **AC-08(a)** 四來源（`Attachment.storageKey`／`thumbnailKey`／
 *     `Report.storageKey`／`VoidedReportFile.storageKey`）與 storage 四型物件
 *     （`att/original`／`att/thumb`／`rpt/pdf`／`rpt/void`）之差集分類；
 *   · **AC-08(b)** 唯讀——執行前後 DB 全表快照與 storage 鍵集快照全等（**主防
 *     線**，執行物證）＋ 源碼零寫入呼叫字面（輔助，措辭不過度宣稱，見下方
 *     該格說明）；
 *   · **AC-08(c-1)**：D5=(c) 只報告分支——`readOnly: true` 為零刪除之結構性
 *     證明欄位；
 *   · **AC-08(d)**：`prefixes` 結構守門不在本檔（本 Task 未觸碰
 *     `server.ts`／`phase8-report-generate.test.ts`，見 Handoff 之獨立驗收
 *     指令）。
 *
 * ---------------------------------------------------------------------------
 * 三向 mutant（Packet Done When 明文；Task Context Packet 建議面向逐字）
 * ---------------------------------------------------------------------------
 *   ① **漏掃一型物件**：四型各安插一筆真孤兒，以 `ORPHAN_OBJECT_TYPES` 之
 *     `toEqual` 封閉比對 ＋ 逐型非零計數雙重釘死——少宣告一型即（a）常數比對
 *     紅，（b）該型孤兒從報告消失、總數少 1，兩處皆紅；
 *   ② **保護期消融**：`protectionWindowMs` 由預設改 0，剛寫入（in-doubt 窗
 *     內）之物件從「不計孤兒」變成「立即計入 confirmed」——直接以真實參數執行
 *     兩次對照（非模擬），對應 AC-08(c-2) 原文「保護期改 0 → 誤刪格必紅」在
 *     只報告分支下的對應語意（此處零刪除，翻紅的是「誤判」而非「誤刪」）；
 *   ③ **孤兒誤判 LINKED**：DB 有列的物件即使**極舊**（老於保護期、老於任何
 *     confirmed 孤兒）也恆不計孤兒——證明分類鍵是「是否在 DB 鍵集中」而非單純
 *     物件年齡，防「年齡達門檻即孤兒」這種會誤傷仍在使用中舊檔的錯誤實作。
 *
 * ---------------------------------------------------------------------------
 * MF-1 走廊（T10R；「掃不到東西」不得與「零孤兒」同結局）
 * ---------------------------------------------------------------------------
 * 以兩格對照證明兩者結構上可分辨：storage 兩側皆空（`attScannedKeyCount` ／
 * `rptScannedKeyCount` 皆 0）vs. storage 非空但僅含 DB 已知鍵（掃描量 > 0、
 * confirmed 孤兒仍為 0）——兩者 `totalConfirmedOrphanCount` 皆為 0，但掃描量
 * 欄位不同，讀者不會把「沒掃到東西」誤讀為「已驗證乾淨」。
 *
 * ---------------------------------------------------------------------------
 * T6R（即審 REQUEST_CHANGES）修訂——本檔新增第 10 格＋既有格之型別修法
 * ---------------------------------------------------------------------------
 *   · **AR-1**：新增「越界檔（不合 key 格式）不進入任何掃描／計數欄位」一
 *     格，釘住 `LocalVolumeStorage.list()` 的 keyRegex 過濾（此前零覆蓋，
 *     移除該過濾之變異可存活；補格後重跑轉紅，見 T6R Handoff）；
 *   · **SF-1**：`inventoryOrphans` 之依賴收斂為 `OrphanListableStorage`／
 *     `OrphanInventoryDb` 兩結構型介面（僅讀方法）之後，「list() 契約」格改
 *     以 `as unknown as OrphanListableStorage` 建構違規值（靜態型別已不能
 *     表達「宣告為必要卻缺 `list()`」這種違規，執行期守門因此仍必要）；
 *     `attStorage`／`rptStorage` 之宣告型別由 `Storage` 改 `LocalVolumeStorage`
 *     （前者含選用 `list?`，與收斂後要求必要 `list` 之參數型別不相容）。
 *
 * ---------------------------------------------------------------------------
 * 測試紀律（§11.0／`CLAUDE.md`）
 * ---------------------------------------------------------------------------
 *   · 全程合成資料；`loginName` 前綴 `p11t6`（不含 `_`／`%`）＋ 每次執行之隨機
 *     `RUN_ID`；storage 一律用本檔專屬之 `mkdtemp` 暫存根目錄，**不觸碰**
 *     `backend/.env` 之開發 storage 根目錄；
 *   · 清理一律以本檔前綴／id 精確比對；**禁用**全域 `deleteMany({})`；
 *   · DB 之 `attachment`／`report`／`voidedReportFile` 為**全域資料表**（本模組
 *     刻意不按 owner／RUN_ID 篩選——盤點本應涵蓋全庫），故本檔對「孤兒是否被
 *     計入」之斷言只依賴**本檔自建之專屬 storage 暫存根目錄**（該目錄下只有
 *     本檔寫入的檔案），與資料庫其餘既存列的規模無關——`dbKeyCount` 欄位本身
 *     允許非零基線，測試只斷言其「非零」而非精確值。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ORPHAN_OBJECT_TYPES,
  type OrphanGroupSummary,
  type OrphanInventoryReport,
  type OrphanListableStorage,
  type OrphanObjectType,
  inventoryOrphans,
} from "../../src/attachment/orphan-inventory.js";
import { hashPassword } from "../../src/auth/password.js";
import { LocalVolumeStorage } from "../../src/storage/local-volume-storage.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** 刻意不含 `_`／`%`：可安全用於 Prisma `startsWith`（編譯為 SQL LIKE）。 */
const LOGIN_PREFIX = "p11t6";

/** 固定之「現在」——保護期判定完全決定性（沿 T3 慣例）。 */
const NOW = new Date();

// ---------------------------------------------------------------------------
// 獨立驗證輔助（不依賴 `LocalVolumeStorage.list()`——AC-08(b) 之執行物證須是
// 與待測程式碼各自獨立的量測，不可用同一份實作驗證自己，沿 T3 之
// `listStorageKeys` 同一紀律）
// ---------------------------------------------------------------------------

function listStorageKeys(root: string): string[] {
  const walk = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
    return out;
  };
  return walk(root).sort();
}

/** 把 `storage.put` 寫入之檔案回溯至指定時間（模擬「早於保護期」的舊寫入）。 */
function backdate(root: string, key: string, when: Date): void {
  const abs = path.join(root, ...key.split("/"));
  fs.utimesSync(abs, when, when);
}

describeWithDb("PHASE-011-T6 — storage 孤兒盤點（AC-08；D5=(c) 只報告不刪）", () => {
  let prisma: PrismaClient;
  let ownerId: string;
  let maintenanceApplicationId: string;
  let reportId: string;

  let attRoot: string;
  let rptRoot: string;
  let attStorage: LocalVolumeStorage;
  let rptStorage: LocalVolumeStorage;

  // 舊（早於保護期，24h）／新（保護期窗內）之時間基準
  const OLD = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
  const ANCIENT = new Date(NOW.getTime() - 9000 * 60 * 60 * 1000); // 遠早於任一 confirmed 孤兒
  const RECENT = new Date(NOW.getTime() - 60 * 1000); // 1 分鐘前——保護期窗內

  const keys = {
    linkedOriginal: `att/${RUN_ID}linkedorig/original`,
    linkedThumb: `att/${RUN_ID}linkedthumb/thumb`,
    orphanOriginal: `att/${RUN_ID}orphanorig/original`,
    orphanThumb: `att/${RUN_ID}orphanthumb/thumb`,
    orphanOriginalPending: `att/${RUN_ID}pendingorig/original`,
    reportPdf: `rpt/${RUN_ID}rptpdf/pdf`,
    voidFile: `rpt/${RUN_ID}rptvoid/void`,
    orphanPdf: `rpt/${RUN_ID}orphanpdf/pdf`,
    orphanVoid: `rpt/${RUN_ID}orphanvoid/void`,
  };

  beforeAll(async () => {
    prisma = new PrismaClient();

    const owner = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}owner${RUN_ID}`,
        displayName: "孤兒盤點測試用人員",
        passwordHash: await hashPassword("Rk3-Thistle-Ferry-9"),
        role: "USER",
      },
    });
    ownerId = owner.id;

    const maintenanceApp = await prisma.application.create({
      data: {
        type: "MAINTENANCE",
        status: "DRAFT",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2031-03-01T00:00:00.000Z"),
      },
    });
    maintenanceApplicationId = maintenanceApp.id;

    attRoot = fs.mkdtempSync(path.join(os.tmpdir(), `p11t6-att-${RUN_ID}-`));
    rptRoot = fs.mkdtempSync(path.join(os.tmpdir(), `p11t6-rpt-${RUN_ID}-`));
    attStorage = new LocalVolumeStorage(attRoot, { prefixes: ["att"] });
    rptStorage = new LocalVolumeStorage(rptRoot, { prefixes: ["rpt"] });

    // ── DB 有列、storage 有檔（非孤兒）：LINKED 附件，刻意設極舊（ANCIENT）─
    const linkedAttachment = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: keys.linkedOriginal,
        thumbnailKey: keys.linkedThumb,
        mimeType: "image/jpeg",
        byteSize: 64,
        originalFilename: "合成收據-linked.jpg",
        uploaderId: ownerId,
        ownerId,
        refType: "MAINTENANCE",
        refId: maintenanceApplicationId,
        createdAt: ANCIENT,
        linkedAt: ANCIENT,
      },
    });
    await attStorage.put(keys.linkedOriginal, Buffer.alloc(64, 0xaa), "image/jpeg");
    await attStorage.put(keys.linkedThumb, Buffer.alloc(32, 0xaa), "image/jpeg");
    backdate(attRoot, keys.linkedOriginal, ANCIENT);
    backdate(attRoot, keys.linkedThumb, ANCIENT);

    const report = await prisma.report.create({
      data: {
        applicationId: maintenanceApplicationId,
        reportNumber: `MNT-T6-${RUN_ID}`,
        numberPrefix: "MNT",
        numberPeriod: "203103",
        sequence: 1,
        storageKey: keys.reportPdf,
        fileName: "MNT-T6.pdf",
        byteSize: 24,
        contentHash: "0".repeat(64),
        generatedById: ownerId,
        generatedAt: ANCIENT,
      },
    });
    reportId = report.id;
    await rptStorage.put(keys.reportPdf, Buffer.from(`pdf-${RUN_ID}`), "application/pdf");
    backdate(rptRoot, keys.reportPdf, ANCIENT);

    await prisma.voidedReportFile.create({
      data: {
        reportId,
        storageKey: keys.voidFile,
        fileName: "MNT-T6.pdf",
        byteSize: 24,
        contentHash: "1".repeat(64),
        createdById: ownerId,
        createdAt: ANCIENT,
      },
    });
    await rptStorage.put(keys.voidFile, Buffer.from(`void-${RUN_ID}`), "application/pdf");
    backdate(rptRoot, keys.voidFile, ANCIENT);

    // ── DB 無列、storage 有檔（真孤兒，每型各一，早於保護期）──────────────
    await attStorage.put(keys.orphanOriginal, Buffer.alloc(16, 0xbb), "image/jpeg");
    backdate(attRoot, keys.orphanOriginal, OLD);
    await attStorage.put(keys.orphanThumb, Buffer.alloc(8, 0xbb), "image/jpeg");
    backdate(attRoot, keys.orphanThumb, OLD);
    await rptStorage.put(keys.orphanPdf, Buffer.from(`orphan-pdf-${RUN_ID}`), "application/pdf");
    backdate(rptRoot, keys.orphanPdf, OLD);
    await rptStorage.put(keys.orphanVoid, Buffer.from(`orphan-void-${RUN_ID}`), "application/pdf");
    backdate(rptRoot, keys.orphanVoid, OLD);

    // ── DB 無列、storage 有檔，剛寫入（保護期窗內，非 confirmed）──────────
    await attStorage.put(keys.orphanOriginalPending, Buffer.alloc(4, 0xcc), "image/jpeg");
    backdate(attRoot, keys.orphanOriginalPending, RECENT);
  }, 60_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.voidedReportFile.deleteMany({ where: { reportId } });
      await prisma.report.deleteMany({ where: { id: reportId } });
      await prisma.attachment.deleteMany({ where: { ownerId } });
      await prisma.application.deleteMany({ where: { id: maintenanceApplicationId } });
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
    for (const root of [attRoot, rptRoot]) {
      if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // AC-08(a) — 四型分類
  // =========================================================================

  it("AC-08(a): 封閉宣告 ORPHAN_OBJECT_TYPES 恰為四型（新增／刪除一型即紅——mutant①之常數面）", () => {
    expect(ORPHAN_OBJECT_TYPES).toEqual([
      { type: "ATT_ORIGINAL", prefix: "att", suffix: "original" },
      { type: "ATT_THUMB", prefix: "att", suffix: "thumb" },
      { type: "RPT_PDF", prefix: "rpt", suffix: "pdf" },
      { type: "RPT_VOID", prefix: "rpt", suffix: "void" },
    ]);
  });

  it("AC-08(a): 四型各恰一筆 confirmed 孤兒、逐型非零（mutant①之功能面——漏掃任一型即該格單獨翻紅）", async () => {
    const report = await inventoryOrphans(prisma, attStorage, rptStorage, { now: NOW });

    const byType = Object.fromEntries(report.groups.map((g) => [g.type, g])) as Record<
      OrphanObjectType,
      OrphanGroupSummary
    >;
    expect(byType.ATT_ORIGINAL.confirmedOrphanCount).toBe(1);
    expect(byType.ATT_THUMB.confirmedOrphanCount).toBe(1);
    expect(byType.RPT_PDF.confirmedOrphanCount).toBe(1);
    expect(byType.RPT_VOID.confirmedOrphanCount).toBe(1);
    expect(byType.ATT_ORIGINAL.oldestConfirmedOrphanAt?.getTime()).toBe(OLD.getTime());

    expect(report.totalConfirmedOrphanCount).toBe(4);
    // pending：剛寫入之 orphanOriginalPending，保護期窗內，不計入 confirmed
    expect(byType.ATT_ORIGINAL.pendingCount).toBe(1);
    expect(report.totalPendingCount).toBe(1);

    expect(report.attScannedKeyCount).toBe(5); // linked×2 + orphan×2 + pending×1
    expect(report.rptScannedKeyCount).toBe(4); // report/void（非孤兒）+ orphan×2
    expect(report.dbKeyCount).toBeGreaterThanOrEqual(4); // 全域表，本檔至少貢獻 4 筆
    expect(report.unclassifiedKeyCount).toBe(0);
    expect(report.readOnly).toBe(true);
  });

  // =========================================================================
  // AC-08(b) — 唯讀（主防線：執行物證）
  // =========================================================================

  it("AC-08(b): 唯讀——執行前後 DB 全表快照（三表）與 storage 鍵集快照（兩根目錄）逐項全等", async () => {
    const attBefore = await prisma.attachment.findMany({ orderBy: { id: "asc" } });
    const reportBefore = await prisma.report.findMany({ orderBy: { id: "asc" } });
    const voidBefore = await prisma.voidedReportFile.findMany({ orderBy: { id: "asc" } });
    const attKeysBefore = listStorageKeys(attRoot);
    const rptKeysBefore = listStorageKeys(rptRoot);

    const report = await inventoryOrphans(prisma, attStorage, rptStorage, { now: NOW });

    const attAfter = await prisma.attachment.findMany({ orderBy: { id: "asc" } });
    const reportAfter = await prisma.report.findMany({ orderBy: { id: "asc" } });
    const voidAfter = await prisma.voidedReportFile.findMany({ orderBy: { id: "asc" } });
    const attKeysAfter = listStorageKeys(attRoot);
    const rptKeysAfter = listStorageKeys(rptRoot);

    expect(attAfter).toEqual(attBefore);
    expect(reportAfter).toEqual(reportBefore);
    expect(voidAfter).toEqual(voidBefore);
    expect(attKeysAfter).toEqual(attKeysBefore);
    expect(rptKeysAfter).toEqual(rptKeysBefore);
    expect(attKeysAfter.length).toBe(5);
    expect(rptKeysAfter.length).toBe(4);
    expect(report.readOnly).toBe(true); // AC-08(c-1)：零刪除之結構性證明欄位
  });

  it("（輔助，非主防線）源碼掃描：orphan-inventory.ts 零 storage 寫入呼叫、零 Prisma 寫入方法呼叫字面", () => {
    const srcPath = new URL("../../src/attachment/orphan-inventory.ts", import.meta.url);
    const raw = fs.readFileSync(srcPath, "utf8");
    // 去除註解——docstring 中以反引號說明的方法名（無呼叫用括號）不應誤判。
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

    expect(stripped).not.toMatch(/storage\.(put|delete)\s*\(/);
    expect(stripped).not.toMatch(/\.(create|update|delete|upsert)(Many)?(AndReturn)?\s*\(/);

    // 正向對照：確實觸及讀方法（防「本掃描因根本沒呼叫任何東西而恆真」）。
    expect(stripped).toMatch(/\.findMany\s*\(/);
    expect(stripped).toMatch(/\.list\s*\(\s*\)/);
  });

  // =========================================================================
  // 三向 mutant
  // =========================================================================

  it("mutant②保護期消融：protectionWindowMs 改 0 → 剛寫入（保護期窗內）之物件由『不計』變『立即計入 confirmed』", async () => {
    const withDefaultWindow = await inventoryOrphans(prisma, attStorage, rptStorage, { now: NOW });
    const pendingByType = Object.fromEntries(
      withDefaultWindow.groups.map((g) => [g.type, g.pendingCount])
    ) as Record<OrphanObjectType, number>;
    expect(pendingByType.ATT_ORIGINAL).toBe(1); // 預設保護期下：剛寫入者不算孤兒

    const withZeroWindow: OrphanInventoryReport = await inventoryOrphans(
      prisma,
      attStorage,
      rptStorage,
      { now: NOW, protectionWindowMs: 0 }
    );
    const confirmedByType = Object.fromEntries(
      withZeroWindow.groups.map((g) => [g.type, g.confirmedOrphanCount])
    ) as Record<OrphanObjectType, number>;
    // 保護期歸零 → 原本 pending 的那一筆現在也被算進 confirmed（+1，仍是同一筆）
    expect(confirmedByType.ATT_ORIGINAL).toBe(2); // 原本 1 筆舊孤兒 + 1 筆剛寫入者
    expect(withZeroWindow.totalPendingCount).toBe(0);
  });

  it("mutant③孤兒誤判 LINKED：DB 有列之物件即使遠老於任一 confirmed 孤兒（ANCIENT ≪ OLD）仍恆不計孤兒", async () => {
    const report = await inventoryOrphans(prisma, attStorage, rptStorage, { now: NOW });
    // linkedOriginal／linkedThumb／reportPdf／voidFile 皆以 ANCIENT 回溯（遠早於
    // OLD，比任一 confirmed 孤兒還舊），若實作誤用「純年齡門檻」判孤兒，總數會
    // 多出這 4 筆——確認總數仍恰為場景所設之 4（僅四個真孤兒），而非 8。
    expect(report.totalConfirmedOrphanCount).toBe(4);
    // 逐一確認：linked/report/void 之 key 不落在任何一組的 oldestConfirmedOrphanAt
    // 更早值——若被誤判進 ATT_ORIGINAL，oldest 會被 ANCIENT（比 OLD 更舊）取代。
    const attOriginalGroup = report.groups.find((g) => g.type === "ATT_ORIGINAL");
    expect(attOriginalGroup?.oldestConfirmedOrphanAt?.getTime()).toBe(OLD.getTime());
    expect(attOriginalGroup?.oldestConfirmedOrphanAt?.getTime()).not.toBe(ANCIENT.getTime());
  });

  // =========================================================================
  // MF-1 走廊：「掃不到東西」≠「零孤兒」
  // =========================================================================

  it("MF-1①：storage 兩側皆空 → 掃描量兩欄皆 0，dbKeyCount 仍非零（『沒掃到東西』的結構特徵）", async () => {
    const emptyAttRoot = fs.mkdtempSync(path.join(os.tmpdir(), `p11t6-empty-att-${RUN_ID}-`));
    const emptyRptRoot = fs.mkdtempSync(path.join(os.tmpdir(), `p11t6-empty-rpt-${RUN_ID}-`));
    try {
      const emptyAttStorage = new LocalVolumeStorage(emptyAttRoot, { prefixes: ["att"] });
      const emptyRptStorage = new LocalVolumeStorage(emptyRptRoot, { prefixes: ["rpt"] });

      const report = await inventoryOrphans(prisma, emptyAttStorage, emptyRptStorage, { now: NOW });

      expect(report.attScannedKeyCount).toBe(0);
      expect(report.rptScannedKeyCount).toBe(0);
      expect(report.totalConfirmedOrphanCount).toBe(0);
      expect(report.dbKeyCount).toBeGreaterThan(0); // 全域表非空——「沒掃到」不是因為 DB 也空
    } finally {
      fs.rmSync(emptyAttRoot, { recursive: true, force: true });
      fs.rmSync(emptyRptRoot, { recursive: true, force: true });
    }
  });

  it("MF-1②（對照組）：storage 非空但僅含 DB 已知鍵 → 掃描量 > 0、confirmed 孤兒仍為 0，與 MF-1① 結構上可區分", async () => {
    const cleanAttRoot = fs.mkdtempSync(path.join(os.tmpdir(), `p11t6-clean-att-${RUN_ID}-`));
    const cleanRptRoot = fs.mkdtempSync(path.join(os.tmpdir(), `p11t6-clean-rpt-${RUN_ID}-`));
    try {
      const cleanAttStorage = new LocalVolumeStorage(cleanAttRoot, { prefixes: ["att"] });
      const cleanRptStorage = new LocalVolumeStorage(cleanRptRoot, { prefixes: ["rpt"] });
      await cleanAttStorage.put(keys.linkedOriginal, Buffer.alloc(64, 0xaa), "image/jpeg");
      await cleanAttStorage.put(keys.linkedThumb, Buffer.alloc(32, 0xaa), "image/jpeg");
      await cleanRptStorage.put(keys.reportPdf, Buffer.from(`pdf-${RUN_ID}`), "application/pdf");

      const report = await inventoryOrphans(prisma, cleanAttStorage, cleanRptStorage, { now: NOW });

      expect(report.attScannedKeyCount).toBe(2);
      expect(report.rptScannedKeyCount).toBe(1);
      expect(report.totalConfirmedOrphanCount).toBe(0);
      expect(report.totalPendingCount).toBe(0);
      // 與 MF-1① 對比：同為 confirmed=0，但掃描量欄位（2/1 vs 0/0）使兩者結構上可區分。
    } finally {
      fs.rmSync(cleanAttRoot, { recursive: true, force: true });
      fs.rmSync(cleanRptRoot, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // AR-1（T6R）：keyRegex 過濾覆蓋——越界檔不得進入任何掃描/計數欄位
  // =========================================================================

  it("AR-1：越界檔（不合 key 格式，如亂放的 stray.bin）不進入任何掃描／計數欄位（keyRegex 過濾覆蓋；此前為零覆蓋、變異可存活）", async () => {
    // 直接寫檔（繞過 `storage.put`——`put` 自身的 `validateKey` 會拒絕不合格式
    // 的 key，故要重現「越界檔如何出現在 volume 上」只能繞過 Storage 抽象層，
    // 這正是 AR-1 要釘住的情境：非經本系統寫入路徑落地的雜項檔案）。
    const strayPath = path.join(attRoot, "stray.bin");
    fs.writeFileSync(strayPath, "junk-not-a-storage-object");
    try {
      const report = await inventoryOrphans(prisma, attStorage, rptStorage, { now: NOW });
      // 既有五筆之掃描量／分類完全不受越界檔影響——它在 list() 這一層已被濾除。
      expect(report.attScannedKeyCount).toBe(5);
      expect(report.unclassifiedKeyCount).toBe(0);
      expect(report.totalConfirmedOrphanCount).toBe(4);
    } finally {
      fs.rmSync(strayPath, { force: true });
    }
  });

  it("list() 契約：未實作 list() 之 storage → inventoryOrphans 立即拋錯（不得靜默略過，違反 MF-1 走廊）", async () => {
    // `OrphanListableStorage.list()` 為必要（非選用）屬性——型別上已不可能建
    // 出一個「宣告為 OrphanListableStorage 但缺 list()」的值。本格刻意模擬
    // 「型別宣稱符合、執行期其實沒有」的違規呼叫端（如透過 `as unknown as`
    // 繞過型別檢查），故用 `as unknown as` 建構，執行期守門即本格的驗證對象
    // （T6R／SF-1：靜態型別已不能表達這個違規，執行期守門因此仍必要）。
    const noListStorage = {
      put: async () => {},
      get: async () => Buffer.alloc(0),
      delete: async () => {},
      exists: async () => false,
    } as unknown as OrphanListableStorage;
    await expect(inventoryOrphans(prisma, noListStorage, rptStorage, { now: NOW })).rejects.toThrow(
      /list/
    );
  });
});
