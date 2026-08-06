/**
 * PHASE-008-T6 — `report-images.ts`（證明圖片嵌入：storage 讀取 ＋ sharp 降
 * 尺寸 ＋ data URI ＋ 缺檔容錯）
 *
 * ---------------------------------------------------------------------------
 * 規範出處（Spec `docs/specs/PHASE-008.md`）
 * ---------------------------------------------------------------------------
 * AC-13(a)：每張證明以 `data:image/...;base64,` 內嵌；長邊超過
 *   `REPORT_IMAGE_MAX_PX`（預設 1600）者等比降尺寸後嵌入，不放大小圖；嵌入
 *   之位元組數 ≤ 原圖；來源檔遺失時該圖以佔位說明取代且整份報表仍產生成功
 *   （不得 500）。
 * B-10：附件檔案於 volume 遺失（DB 有列、檔案無）→ 該圖以佔位說明取代，整
 *   份報表仍成功；錯誤日誌不含 key。
 * §16 D16：sharp 降尺寸（長邊上限、不放大小圖、不持久化）以 `data:` URI 嵌
 *   入；`REPORT_IMAGE_MAX_PX` 由呼叫端傳入（本檔不讀環境變數，§9.1 (3)）。
 * §15 T6 Done When：長邊上限與不放大雙向測試；缺檔佔位且不中止；日誌零
 *   key；嵌入位元組 ≤ 原圖。
 *
 * ---------------------------------------------------------------------------
 * 上游契約義務核銷（T4/T5 Gate 移交，逐條於本檔或實作檔落實）
 * ---------------------------------------------------------------------------
 * 1. 回傳新物件（非就地改寫）——本檔「回傳新物件契約」區塊以 `Object.freeze`
 *    凍結輸入巢狀物件，若實作誤就地改寫將因嚴格模式 `TypeError` 而紅。
 * 2. 讀取失敗必設 `missing:true`（T4 預設 `false` 僅代表「尚未嘗試」）。
 * 3. `storageKey` 嵌入後清空（成功／缺檔兩分支皆須清空）。
 * 4. FW-2：`dataUri` 恆以 `data:` 起始之正向測試（T5 渲染層純信任呼叫端，
 *    本層為唯一保證點）。
 * 5. mimeType 沿既有 `detect-mime.ts` 封閉聯集，不重新偵測——測試以三種
 *    MIME（jpeg／png／webp）逐一驗證 `data:` 前綴逐字對應 `img.mimeType`。
 *
 * ---------------------------------------------------------------------------
 * 零 DB 紀律
 * ---------------------------------------------------------------------------
 * `embedImages` 不接觸 Prisma；本檔以合成 `ReportData` fixture（沿
 * `backend/test/unit/report-html.test.ts` 之零 DB fixture 建構器慣例）＋ 真
 * 實 `LocalVolumeStorage`（隔離 temp 目錄）＋ 真實 `sharp`（procedurally 產
 * 生之合成圖片，非真實照片，符合 CLAUDE.md 合成資料紀律）組成，無需
 * `DATABASE_URL` 即可全程執行。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  DepreciationReportBody,
  MaintenanceReportBody,
  ReportCommon,
  ReportData,
  ReportImage,
  TravelReportBody,
  TravelSegmentReport,
} from "../../src/reports/report-data.js";
import { type EmbedImagesLogger, embedImages } from "../../src/reports/report-images.js";
import { LocalVolumeStorage } from "../../src/storage/index.js";

// ---------------------------------------------------------------------------
// Storage helpers（沿 phase3-access.test.ts 既有慣例）
// ---------------------------------------------------------------------------

function makeTempStorageRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "phase8-report-images-test-"));
}

function removeTempStorageRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// 合成圖片產生器（procedurally 產生，非真實照片；真實可解碼位元組，供 sharp
// 實際降尺寸邏輯驗證，區別於其他測試檔之「magic bytes only」fixture）
// ---------------------------------------------------------------------------

async function makeRealJpeg(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 140, b: 160 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function makeRealPng(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 200, b: 30 } },
  })
    .png()
    .toBuffer();
}

async function makeRealWebp(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 10, b: 100 } },
  })
    .webp()
    .toBuffer();
}

async function dimsOf(bytes: Buffer): Promise<{ width: number; height: number }> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(bytes).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

// ---------------------------------------------------------------------------
// ReportData fixture 建構器（零 DB；沿 report-html.test.ts 既有慣例）
// ---------------------------------------------------------------------------

function makeCommon(overrides: Partial<ReportCommon> = {}): ReportCommon {
  return {
    reportNumber: "TRV-202608-0001",
    generatedAt: "2026-08-06T03:00:00.000Z",
    ownerDisplayName: "測試使用者",
    typeLabel: "差旅",
    statusLabel: "已完成",
    createdAt: "2026-08-01T09:00:00.000Z",
    totalAmount: 1234,
    ...overrides,
  };
}

function makeImage(
  id: string,
  storageKey: string,
  overrides: Partial<ReportImage> = {}
): ReportImage {
  return {
    attachmentId: id,
    storageKey,
    mimeType: "image/jpeg",
    originalFilename: `${id}.jpg`,
    dataUri: null,
    missing: false,
    ...overrides,
  };
}

function makeSegment(overrides: Partial<TravelSegmentReport> = {}): TravelSegmentReport {
  return {
    sortOrder: 1,
    origin: "台北",
    destination: "新竹",
    totalKm: "60.00",
    highwayKm: "50.00",
    segmentAmount: 300,
    attachments: [],
    ...overrides,
  };
}

function travelData(
  travel: Partial<TravelReportBody> & { segments: TravelSegmentReport[] }
): Extract<ReportData, { kind: "TRAVEL" }> {
  return {
    kind: "TRAVEL",
    common: makeCommon({ typeLabel: "差旅" }),
    travel: {
      model: "CURRENT",
      tripDate: "2026-08-01",
      purpose: "拜訪客戶",
      totalKm: "60.00",
      preRoundingTotal: "1234.5678",
      fuelUnitPrice: "2.5000",
      etcUnitPrice: "1.2000",
      fuelType: "GASOLINE_95",
      fuelPricePerLiter: "30.5000",
      fuelConsumption: "12.3400",
      ...travel,
    },
  };
}

function maintenanceData(attachments: ReportImage[]): Extract<ReportData, { kind: "MAINTENANCE" }> {
  const maintenance: MaintenanceReportBody = {
    lastMaintenanceDate: "2026-01-01",
    currentMaintenanceDate: "2026-07-01",
    lastOdometerKm: "1000.00",
    currentOdometerKm: "2000.00",
    intervalKm: "1000.00",
    officialKm: "500.00",
    ratioPercent: "50.0000",
    actualCost: "3000.00",
    companyAmount: 1500,
    attachments,
  };
  return { kind: "MAINTENANCE", common: makeCommon({ typeLabel: "保養" }), maintenance };
}

function depreciationData(
  attachments: ReportImage[]
): Extract<ReportData, { kind: "DEPRECIATION" }> {
  const depreciation: DepreciationReportBody = {
    model: "CURRENT",
    applicationYear: 2026,
    annualDepreciation: "10000.00",
    annualTotalKm: "12000.0",
    ratioPercent: "50.0000",
    perKmUnitPrice: null,
    officialKm: "6000.00",
    attachments,
  };
  return { kind: "DEPRECIATION", common: makeCommon({ typeLabel: "折舊" }), depreciation };
}

// ---------------------------------------------------------------------------
// 日誌 spy
// ---------------------------------------------------------------------------

function makeLoggerSpy(): {
  log: EmbedImagesLogger;
  calls: Array<{ obj: Record<string, unknown>; msg: string }>;
} {
  const calls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    log: {
      error: (obj, msg) => {
        calls.push({ obj, msg });
      },
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// 測試套件
// ---------------------------------------------------------------------------

describe("PHASE-008-T6 — embedImages", () => {
  let storageRoot: string;
  let storage: LocalVolumeStorage;

  function freshStorage() {
    storageRoot = makeTempStorageRoot();
    storage = new LocalVolumeStorage(storageRoot);
  }

  afterEach(() => {
    if (storageRoot) removeTempStorageRoot(storageRoot);
  });

  async function putAtt(id: string, bytes: Buffer, contentType: string, suffix = "original") {
    const key = `att/${id}/${suffix}`;
    await storage.put(key, bytes, contentType);
    return key;
  }

  // -------------------------------------------------------------------------
  // AC-13(a)：長邊上限與不放大雙向測試
  // -------------------------------------------------------------------------

  it("AC-13(a): 長邊超過 REPORT_IMAGE_MAX_PX（4000px 原圖）等比降尺寸至長邊 1600，嵌入位元組 ≤ 原圖", async () => {
    freshStorage();
    const original = await makeRealJpeg(4000, 3000);
    const key = await putAtt("big", original, "image/jpeg");
    const data = travelData({ segments: [makeSegment({ attachments: [makeImage("big", key)] })] });

    const { calls, log } = makeLoggerSpy();
    const result = await embedImages(storage, data, 1600, log);

    expect(calls).toHaveLength(0);
    if (result.kind !== "TRAVEL") throw new Error("unreachable");
    const img = result.travel.segments[0].attachments[0];
    expect(img.missing).toBe(false);
    expect(img.dataUri).not.toBeNull();
    const b64 = (img.dataUri as string).split(",")[1];
    const embeddedBytes = Buffer.from(b64, "base64");
    const dims = await dimsOf(embeddedBytes);
    expect(Math.max(dims.width, dims.height)).toBe(1600);
    expect(dims.width).toBeLessThanOrEqual(1600);
    expect(dims.height).toBeLessThanOrEqual(1600);
    expect(embeddedBytes.length).toBeLessThanOrEqual(original.length);
  });

  it("AC-13(a): 長邊未超過上限（800px 原圖）不放大，維持原尺寸與原位元組", async () => {
    freshStorage();
    const original = await makeRealJpeg(800, 600);
    const key = await putAtt("small", original, "image/jpeg");
    const data = travelData({
      segments: [makeSegment({ attachments: [makeImage("small", key)] })],
    });

    const { log } = makeLoggerSpy();
    const result = await embedImages(storage, data, 1600, log);

    if (result.kind !== "TRAVEL") throw new Error("unreachable");
    const img = result.travel.segments[0].attachments[0];
    expect(img.missing).toBe(false);
    const b64 = (img.dataUri as string).split(",")[1];
    const embeddedBytes = Buffer.from(b64, "base64");
    const dims = await dimsOf(embeddedBytes);
    // 不放大：尺寸恆等於原圖（結構性保證，非僅「不超過上限」）
    expect(dims.width).toBe(800);
    expect(dims.height).toBe(600);
    // 原樣嵌入（跳過重編碼分支）：位元組數與原圖逐位元組相等
    expect(embeddedBytes.equals(original)).toBe(true);
  });

  it("AC-13(a): 長邊恰為上限（1600px）不視為超過，原樣嵌入", async () => {
    freshStorage();
    const original = await makeRealJpeg(1600, 1200);
    const key = await putAtt("boundary", original, "image/jpeg");
    const data = maintenanceData([makeImage("boundary", key)]);

    const { log } = makeLoggerSpy();
    const result = await embedImages(storage, data, 1600, log);
    if (result.kind !== "MAINTENANCE") throw new Error("unreachable");
    const img = result.maintenance.attachments[0];
    const embeddedBytes = Buffer.from((img.dataUri as string).split(",")[1], "base64");
    expect(embeddedBytes.equals(original)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // B-10：缺檔容錯
  // -------------------------------------------------------------------------

  it("B-10: 來源檔遺失 → 該圖 missing:true、dataUri:null，整份不中止（其餘圖片仍正常嵌入）", async () => {
    freshStorage();
    const okBytes = await makeRealJpeg(400, 300);
    const okKey = await putAtt("ok", okBytes, "image/jpeg");
    // 刻意不 put，模擬「DB 有列、檔案無」
    const missingKey = "att/missing-id-xyz/original";

    const data = maintenanceData([makeImage("ok", okKey), makeImage("missing", missingKey)]);
    const { log } = makeLoggerSpy();

    const result = await embedImages(storage, data, 1600, log);
    if (result.kind !== "MAINTENANCE") throw new Error("unreachable");
    const [okImg, missingImg] = result.maintenance.attachments;

    expect(okImg.missing).toBe(false);
    expect(okImg.dataUri).not.toBeNull();

    expect(missingImg.missing).toBe(true);
    expect(missingImg.dataUri).toBeNull();
  });

  it("B-10: sharp 解碼失敗（位元組損毀，非有效圖片）亦視為缺檔佔位，不拋出", async () => {
    freshStorage();
    // 通過檔案存在檢查，但不是有效可解碼之圖片位元組
    const corrupt = Buffer.from("this is not a real image file, just garbage bytes", "utf8");
    const key = await putAtt("corrupt", corrupt, "image/jpeg");
    const data = depreciationData([makeImage("corrupt", key)]);
    const { log } = makeLoggerSpy();

    const result = await embedImages(storage, data, 1600, log);
    if (result.kind !== "DEPRECIATION") throw new Error("unreachable");
    const img = result.depreciation.attachments[0];
    expect(img.missing).toBe(true);
    expect(img.dataUri).toBeNull();
  });

  it("日誌零 key：缺檔錯誤日誌不含 storageKey 值，亦不含 att/ 子字串", async () => {
    freshStorage();
    const missingKey = "att/secret-leak-probe-id/original";
    const data = maintenanceData([makeImage("probe", missingKey)]);
    const { log, calls } = makeLoggerSpy();

    await embedImages(storage, data, 1600, log);

    expect(calls.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain(missingKey);
    expect(serialized).not.toContain("att/");
    expect(serialized).not.toContain("secret-leak-probe-id");
    // 允許出現非敏感之 attachmentId
    expect(serialized).toContain("probe");
  });

  // -------------------------------------------------------------------------
  // 上游契約 #1：回傳新物件（不就地改寫）
  // -------------------------------------------------------------------------

  it("回傳新物件：輸入 ReportData（含巢狀 segments/attachments）凍結後不被修改", async () => {
    freshStorage();
    const bytes = await makeRealJpeg(300, 200);
    const key = await putAtt("freeze-test", bytes, "image/jpeg");
    const img = makeImage("freeze-test", key);
    Object.freeze(img);
    const segment = makeSegment({ attachments: [img] });
    Object.freeze(segment.attachments);
    Object.freeze(segment);
    const data = travelData({ segments: [segment] });
    Object.freeze(data.travel.segments);
    Object.freeze(data.travel);
    Object.freeze(data);

    const { log } = makeLoggerSpy();
    // 若實作就地改寫任一凍結物件，嚴格模式下會拋出 TypeError，本呼叫應正常完成
    const result = await embedImages(storage, data, 1600, log);

    // 輸入原樣不變（未被 embedImages 填入 dataUri）
    expect(data.travel.segments[0].attachments[0].dataUri).toBeNull();
    expect(data.travel.segments[0].attachments[0].storageKey).toBe(key);
    // 輸出為新物件、已正確填入
    if (result.kind !== "TRAVEL") throw new Error("unreachable");
    expect(result).not.toBe(data);
    expect(result.travel).not.toBe(data.travel);
    expect(result.travel.segments[0].attachments[0].dataUri).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 上游契約 #3：storageKey 嵌入後清空
  // -------------------------------------------------------------------------

  it("storageKey 清空：成功嵌入後 storageKey 為空字串", async () => {
    freshStorage();
    const bytes = await makeRealJpeg(300, 200);
    const key = await putAtt("clear-ok", bytes, "image/jpeg");
    const data = maintenanceData([makeImage("clear-ok", key)]);
    const { log } = makeLoggerSpy();

    const result = await embedImages(storage, data, 1600, log);
    if (result.kind !== "MAINTENANCE") throw new Error("unreachable");
    expect(result.maintenance.attachments[0].storageKey).toBe("");
  });

  it("storageKey 清空：缺檔佔位後 storageKey 亦為空字串", async () => {
    freshStorage();
    const data = maintenanceData([makeImage("clear-missing", "att/never-put-id/original")]);
    const { log } = makeLoggerSpy();

    const result = await embedImages(storage, data, 1600, log);
    if (result.kind !== "MAINTENANCE") throw new Error("unreachable");
    expect(result.maintenance.attachments[0].storageKey).toBe("");
  });

  // -------------------------------------------------------------------------
  // 三型 ReportData 皆正確走訪（B-11 多張同時嵌入）
  // -------------------------------------------------------------------------

  it("TRAVEL：多段各自之 attachments 皆正確嵌入，不跨段混用", async () => {
    freshStorage();
    const bytesA = await makeRealJpeg(300, 200);
    const bytesB = await makeRealJpeg(300, 200);
    const keyA = await putAtt("segA", bytesA, "image/jpeg");
    const keyB = await putAtt("segB", bytesB, "image/jpeg");
    const data = travelData({
      segments: [
        makeSegment({ sortOrder: 1, attachments: [makeImage("segA", keyA)] }),
        makeSegment({ sortOrder: 2, attachments: [makeImage("segB", keyB)] }),
      ],
    });
    const { log } = makeLoggerSpy();

    const result = await embedImages(storage, data, 1600, log);
    if (result.kind !== "TRAVEL") throw new Error("unreachable");
    expect(result.travel.segments[0].attachments[0].attachmentId).toBe("segA");
    expect(result.travel.segments[0].attachments[0].dataUri).not.toBeNull();
    expect(result.travel.segments[1].attachments[0].attachmentId).toBe("segB");
    expect(result.travel.segments[1].attachments[0].dataUri).not.toBeNull();
  });

  it("B-11：5 張證明（上限）同時嵌入，皆成功且互不影響", async () => {
    freshStorage();
    const images: ReportImage[] = [];
    for (let i = 0; i < 5; i++) {
      const bytes = await makeRealJpeg(300, 200);
      const key = await putAtt(`five-${i}`, bytes, "image/jpeg");
      images.push(makeImage(`five-${i}`, key));
    }
    const data = maintenanceData(images);
    const { log } = makeLoggerSpy();

    const result = await embedImages(storage, data, 1600, log);
    if (result.kind !== "MAINTENANCE") throw new Error("unreachable");
    expect(result.maintenance.attachments).toHaveLength(5);
    for (const img of result.maintenance.attachments) {
      expect(img.missing).toBe(false);
      expect(img.dataUri).not.toBeNull();
    }
  });

  it("DEPRECIATION：attachments 正確嵌入", async () => {
    freshStorage();
    const bytes = await makeRealPng(300, 200);
    const key = await putAtt("dep1", bytes, "image/png");
    const data = depreciationData([makeImage("dep1", key, { mimeType: "image/png" })]);
    const { log } = makeLoggerSpy();

    const result = await embedImages(storage, data, 1600, log);
    if (result.kind !== "DEPRECIATION") throw new Error("unreachable");
    expect(result.depreciation.attachments[0].dataUri).toMatch(/^data:image\/png;base64,/);
  });

  // -------------------------------------------------------------------------
  // 上游契約 #5：mimeType 沿既有 detect-mime.ts 封閉聯集，不重新偵測
  // -------------------------------------------------------------------------

  it("mimeType：data URI 前綴逐字對應 img.mimeType（jpeg/png/webp 三型）", async () => {
    freshStorage();
    const jpegBytes = await makeRealJpeg(300, 200);
    const pngBytes = await makeRealPng(300, 200);
    const webpBytes = await makeRealWebp(300, 200);
    const jpegKey = await putAtt("m-jpeg", jpegBytes, "image/jpeg");
    const pngKey = await putAtt("m-png", pngBytes, "image/png");
    const webpKey = await putAtt("m-webp", webpBytes, "image/webp");

    const data = maintenanceData([
      makeImage("m-jpeg", jpegKey, { mimeType: "image/jpeg" }),
      makeImage("m-png", pngKey, { mimeType: "image/png" }),
      makeImage("m-webp", webpKey, { mimeType: "image/webp" }),
    ]);
    const { log } = makeLoggerSpy();

    const result = await embedImages(storage, data, 1600, log);
    if (result.kind !== "MAINTENANCE") throw new Error("unreachable");
    const [jpegImg, pngImg, webpImg] = result.maintenance.attachments;
    expect(jpegImg.dataUri).toMatch(/^data:image\/jpeg;base64,/);
    expect(pngImg.dataUri).toMatch(/^data:image\/png;base64,/);
    expect(webpImg.dataUri).toMatch(/^data:image\/webp;base64,/);
  });

  // -------------------------------------------------------------------------
  // 上游契約 #4（FW-2）：dataUri 恆以 data: 起始之正向測試
  // -------------------------------------------------------------------------

  it("FW-2: 所有成功嵌入之 dataUri 皆以 data: 起始（供 T5 渲染層信任呼叫端）", async () => {
    freshStorage();
    const bytes1 = await makeRealJpeg(4000, 3000); // 觸發降尺寸分支
    const bytes2 = await makeRealJpeg(300, 200); // 觸發原樣分支
    const key1 = await putAtt("fw2-a", bytes1, "image/jpeg");
    const key2 = await putAtt("fw2-b", bytes2, "image/jpeg");
    const data = maintenanceData([makeImage("fw2-a", key1), makeImage("fw2-b", key2)]);
    const { log } = makeLoggerSpy();

    const result = await embedImages(storage, data, 1600, log);
    if (result.kind !== "MAINTENANCE") throw new Error("unreachable");
    for (const img of result.maintenance.attachments) {
      expect(img.dataUri).not.toBeNull();
      expect((img.dataUri as string).startsWith("data:")).toBe(true);
    }
  });
});
