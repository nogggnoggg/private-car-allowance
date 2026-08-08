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
// 確定性偽亂數（xorshift32；非 Math.random——T6R SF-2 義務：fixture 種子須
// 固定使測試可重現，且非低熵純色，見下方「高熵 fixture」節）
// ---------------------------------------------------------------------------

function makeXorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

function makeNoiseRaw(width: number, height: number, channels: number, seed: number): Buffer {
  const rnd = makeXorshift32(seed);
  const buf = Buffer.alloc(width * height * channels);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = rnd() & 0xff;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// 合成圖片產生器（procedurally 產生，非真實照片；真實可解碼位元組，供 sharp
// 實際降尺寸邏輯驗證，區別於其他測試檔之「magic bytes only」fixture）
//
// T6R SF-2：改為高熵（確定性種子雜訊）而非低熵純色——純色圖片經 sharp
// decode→encode 往返會位元組全等（同參數之 JPEG/PNG 編碼器對平坦色塊具確
// 定性輸出），使「重編碼是否曾發生」在純色 fixture 下不可鑑別，令 M2b（移
// 除原樣短路）／M8（`<=` 改 `<`）兩 mutant 存活。高熵內容之 decode→encode
// 往返必產生不同位元組（實測見 Task Handoff），使鑑別力恢復。
// ---------------------------------------------------------------------------

async function makeRealJpeg(width: number, height: number, seed = 0x2545f491): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const raw = makeNoiseRaw(width, height, 3, seed);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function makeRealPng(width: number, height: number, seed = 0x9e3779b9): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const raw = makeNoiseRaw(width, height, 3, seed);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

async function makeRealWebp(width: number, height: number, seed = 0x85ebca6b): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const raw = makeNoiseRaw(width, height, 3, seed);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .webp()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// 索引色地圖型 fixture（T6R SF-1；沿期中複審 #2 實測之地圖截圖特徵重現——細
// 網格線 ＋ 兩色階，palette PNG 原圖極小；sharp 重編碼〔無 `palette` 選
// 項〕之濾波在線條邊界產生大量中間色，破壞可壓縮性而膨脹，實測見 Task
// Handoff）
// ---------------------------------------------------------------------------

function makeGridMapRaw(width: number, height: number, channels: number): Buffer {
  const buf = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * channels;
      const isLine = x % 2 === 0 || y % 2 === 0;
      if (isLine) {
        buf[off] = 30;
        buf[off + 1] = 30;
        buf[off + 2] = 30;
      } else {
        buf[off] = 235;
        buf[off + 1] = 235;
        buf[off + 2] = 235;
      }
    }
  }
  return buf;
}

async function makeIndexColorMapPng(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const raw = makeGridMapRaw(width, height, 3);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ palette: true })
    .toBuffer();
}

// T6R2 AR-12（期中複審 #2 reviewer 指定釘住 fixture）：索引色地圖型 PNG ＋
// EXIF orientation 6 ── T6R 曾對「需轉正」路徑豁免取小者閘門，reviewer 實測
// 此組合之轉正重編碼膨脹 2.1～2.4×（見下方測試內實測值），證明豁免使不變式
// 不成立。sharp 對 PNG 之 `withMetadata({ orientation })` 寫入 eXIf chunk，
// `metadata().orientation` 可讀回，與 JPEG EXIF 標籤同一語意。
async function makeIndexColorOrientedMapPng(
  width: number,
  height: number,
  orientation: number
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const raw = makeGridMapRaw(width, height, 3);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .withMetadata({ orientation })
    .png({ palette: true })
    .toBuffer();
}

// ---------------------------------------------------------------------------
// EXIF orientation fixture（T6R SF-3；sharp `withMetadata({orientation})`
// 合成——原始像素以橫向排列儲存，`orientation` 標記實際應轉正之方向）
// ---------------------------------------------------------------------------

async function makeOrientedJpeg(
  width: number,
  height: number,
  orientation: number,
  seed = 0x1b873593
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const raw = makeNoiseRaw(width, height, 3, seed);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .withMetadata({ orientation })
    .jpeg({ quality: 80 })
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
    void: null, // PHASE-009-T10R：ReportCommon 受控擴充連動
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

  // -------------------------------------------------------------------------
  // T6R SF-1（§16 D16 修訂後定案；期中複審 #2 SF-1 人類裁定「取小者」）：
  // 索引色 PNG 之重編碼膨脹時改用原圖位元組，像素尺寸保留
  // -------------------------------------------------------------------------

  it("AC-13(a) 取小者: 索引色地圖型 PNG（2400x2400）重編碼膨脹時改用原圖位元組，像素尺寸保留", async () => {
    freshStorage();
    const original = await makeIndexColorMapPng(2400, 2400);
    const key = await putAtt("map", original, "image/png");
    const data = maintenanceData([makeImage("map", key, { mimeType: "image/png" })]);
    const { log } = makeLoggerSpy();

    const result = await embedImages(storage, data, 1600, log);
    if (result.kind !== "MAINTENANCE") throw new Error("unreachable");
    const img = result.maintenance.attachments[0];
    expect(img.missing).toBe(false);
    const embeddedBytes = Buffer.from((img.dataUri as string).split(",")[1], "base64");

    // 取小者之直接結果：嵌入位元組恆 <= 原圖（AC-13(a) 修訂：由約定升為不變式）
    expect(embeddedBytes.length).toBeLessThanOrEqual(original.length);
    // 改用原圖：位元組逐位元組相等、像素尺寸保留原尺寸（不縮至 1600）
    expect(embeddedBytes.equals(original)).toBe(true);
    const dims = await dimsOf(embeddedBytes);
    expect(dims.width).toBe(2400);
    expect(dims.height).toBe(2400);
  });

  // -------------------------------------------------------------------------
  // T6R2（2026-08-06 期中複審 #2 AR-11／AR-12；reviewer 指定釘住測試）：取小
  // 者閘門一律適用於「需轉正」路徑——T6R 曾豁免此路徑（`!needsRotation` 條
  // 件），reviewer 實測索引色 PNG＋orientation 6 之轉正重編碼膨脹 2.29×
  // （2400x1800，見下方 Task Handoff 實測輸出），豁免使 AC-13(a)「嵌入位元
  // 組 ≤ 原圖」不變式在此路徑不成立。本測試在「加回 `!needsRotation` 條件」
  // 之 mutant 下必紅（見 Task Handoff 之 mutant 自證輸出）。
  // -------------------------------------------------------------------------

  it("AC-13(a) 取小者一律化(T6R2 AR-12 釘住): 索引色 PNG＋orientation 6（需轉正且重編碼必膨脹）改用原圖，位元組相等且像素尺寸保留", async () => {
    freshStorage();
    const original = await makeIndexColorOrientedMapPng(2400, 1800, 6);
    const key = await putAtt("map-oriented", original, "image/png");
    const data = maintenanceData([makeImage("map-oriented", key, { mimeType: "image/png" })]);
    const { log } = makeLoggerSpy();

    const result = await embedImages(storage, data, 1600, log);
    if (result.kind !== "MAINTENANCE") throw new Error("unreachable");
    const img = result.maintenance.attachments[0];
    expect(img.missing).toBe(false);
    const embeddedBytes = Buffer.from((img.dataUri as string).split(",")[1], "base64");

    // 不變式（AC-13(a)；T6R2 一律化後對「需轉正」路徑亦成立）
    expect(embeddedBytes.length).toBeLessThanOrEqual(original.length);
    // 取小者：重編碼膨脹 ⇒ 回退原圖，位元組逐位元組相等
    expect(embeddedBytes.equals(original)).toBe(true);
    // 像素尺寸保留原始儲存尺寸（未被降尺寸，EXIF 標籤原樣隨原圖位元組保留，
    // 顯示轉正交由 Chromium `image-orientation: from-image` 處理，見檔頭
    // T6R2 節）
    const dims = await dimsOf(embeddedBytes);
    expect(dims.width).toBe(2400);
    expect(dims.height).toBe(1800);
  });

  // -------------------------------------------------------------------------
  // T6R SF-3（AC-13(a) 修訂註）：EXIF 轉正——resize 之前 `.rotate()`；長邊上
  // 限與不放大以轉正後幾何為準；兩分支（需/不需降尺寸）輸出方向須一致
  // -------------------------------------------------------------------------

  it("AC-13(a) EXIF 轉正: orientation 6（轉正後長邊未超過上限）resize 前轉正，寬高互換", async () => {
    freshStorage();
    // 原始像素儲存為橫向 1200x800；orientation=6 標記「實際應轉正為直向」
    const original = await makeOrientedJpeg(1200, 800, 6);
    const key = await putAtt("oriented-small", original, "image/jpeg");
    const data = maintenanceData([makeImage("oriented-small", key)]);
    const { log } = makeLoggerSpy();

    const result = await embedImages(storage, data, 1600, log);
    if (result.kind !== "MAINTENANCE") throw new Error("unreachable");
    const img = result.maintenance.attachments[0];
    const embeddedBytes = Buffer.from((img.dataUri as string).split(",")[1], "base64");
    const dims = await dimsOf(embeddedBytes);
    // 轉正後：寬高互換為直向（800x1200），非原始儲存之橫向（1200x800）——
    // 移除 `.rotate()` 之 mutant 會使輸出維持橫向，本斷言必紅（見 Task Handoff）
    expect(dims.width).toBe(800);
    expect(dims.height).toBe(1200);
  });

  it("AC-13(a) EXIF 轉正: orientation 6（轉正後長邊超過上限）resize 前轉正且降尺寸，長邊 1600 且方向正確", async () => {
    freshStorage();
    // 原始像素儲存為橫向 2400x1200；orientation=6 標記「實際應轉正為直向
    // 1200x2400」，轉正後長邊 2400 超過上限 1600，須降尺寸
    const original = await makeOrientedJpeg(2400, 1200, 6);
    const key = await putAtt("oriented-large", original, "image/jpeg");
    const data = maintenanceData([makeImage("oriented-large", key)]);
    const { log } = makeLoggerSpy();

    const result = await embedImages(storage, data, 1600, log);
    if (result.kind !== "MAINTENANCE") throw new Error("unreachable");
    const img = result.maintenance.attachments[0];
    const embeddedBytes = Buffer.from((img.dataUri as string).split(",")[1], "base64");
    const dims = await dimsOf(embeddedBytes);
    // 轉正後為直向（寬 < 高）且長邊（高）等於上限 1600——移除 `.rotate()` 之
    // mutant 會使輸出維持橫向（寬 1600、高 800），本斷言必紅（見 Task Handoff）
    expect(dims.width).toBeLessThan(dims.height);
    expect(dims.height).toBe(1600);
    expect(dims.width).toBeLessThanOrEqual(1600);
  });
});
