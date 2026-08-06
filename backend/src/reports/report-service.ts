/**
 * 報表產生服務 — PHASE-008-T8（BE-US-26／27）
 *
 * Spec `docs/specs/PHASE-008.md` §2.B/C AC-04／AC-05／AC-06／AC-07／AC-10、
 * §3.1、§9.1（唯一之寫入路徑）、§16 D3（併發保證與冪等）、D5（失敗語意與
 * 錯誤碼）。
 *
 * ---------------------------------------------------------------------------
 * §9.1 步驟對照（本檔為該流程之編排層；routes.ts 只負責授權／狀態守門與
 * 錯誤碼轉譯，見該檔）
 * ---------------------------------------------------------------------------
 * (1) 冪等前置查詢：`Report.findUnique({ applicationId })` 命中 → 直接回既
 *     有，零渲染、零寫入（AC-05(a)）。
 * (2)(3)(4) 組裝 `ReportData`（讀快照，零重算）→ 附件位元組降尺寸內嵌 →
 *     `renderReportHtml`（純函式，與列印端點同一份）。此三步失敗 → RENDER。
 * (5) `renderPdf`（Playwright；逾時／渲染失敗）→ RENDER。
 * (6) `storage.put` → STORE；讀回校驗（位元組數 + SHA-256）→ VERIFY。
 * (7) SERIALIZABLE 交易（重試 ≤5）：交易內再查一次冪等（TOCTOU 收斂為「敗
 *     方」）→ `max(sequence)+1` 配號 → `INSERT Report`。交易失敗（重試耗
 *     盡或非預期錯誤）→ PERSIST。
 * (8) 任一失敗 → 已寫入之 storage 檔案補償刪除（`safeDelete`，零殘留）；
 *     「敗方」（冪等碰撞，非失敗）亦須清理自己已寫入之孤兒檔（AC-10）。
 *
 * ---------------------------------------------------------------------------
 * 「配號在最後一步」（D3；不變式）
 * ---------------------------------------------------------------------------
 * `assignReportNumberAndInsert` 之 `max(sequence)+1` 計算與 `INSERT` 同在
 * 一個交易嘗試內完成——序號僅於交易**提交**時被消耗；(2)~(6) 之任一失敗絕
 * 不會呼叫本函式，故絕不消耗編號（避免編號出現無對應報表之洞）。
 *
 * ---------------------------------------------------------------------------
 * PDF 內容之 `ReportData.common.reportNumber`／`generatedAt`（實作決策揭
 * 露，交複審）
 * ---------------------------------------------------------------------------
 * §9.1 步驟 (2) 之 `buildReportData` 呼叫本檔傳入 `report: null`——這是對
 * Spec 流程順序的**必然**推論而非裁量：序號於步驟 (7) 才第一次被計算（見上
 * 方「配號在最後一步」），而 (2)~(6) 全部發生在 (7) 之前，故渲染／保存階段
 * 在結構上**不可能**取得最終報表編號或產生時間。持久化之 PDF 因而呈現
 * `report-html.ts` 之「尚未產生」佔位文字於報表編號／產生時間兩欄——這與列
 * 印端點（T10，於報表已產生後呼叫）以 `report: {reportNumber, generatedAt}`
 * 呼叫 `buildReportData` 之輸出不同輸入、不同輸出，**不違反** AC-15（AC-15
 * 之「同輸入兩次呼叫 toEqual」約束的是 `renderReportHtml` 之純函式性質，非
 * 「不同呼叫情境下必須同輸出」）。本檔僅以 spy 斷言 PDF 產生路徑呼叫的正是
 * `renderReportHtml`（T5-複審-FW-A 前置之服務層半；wire 級同版型全等屬
 * T10）。
 *
 * ---------------------------------------------------------------------------
 * 錯誤碼與日誌安全（T7-FW2①、§7.5 D5）
 * ---------------------------------------------------------------------------
 * `platform/errors.ts` 之 `ErrorCode` 聯集尚未收錄 `REPORT_GENERATION_FAILED`
 * ——該檔案屬 T11（錯誤合約與日誌）之 Files Allowed，非本 Task 範圍（治理
 * 2026-08-01.2：不得修改 Packet 標記為 Forbidden 的檔案）。本檔因而**不**
 * 經由 `AppError` 表達此失敗，改以本檔自有之 `ReportGenerationError`（僅含
 * `stage`，不含任何原始錯誤訊息、路徑或 storage key）向上拋出；
 * `routes.ts` 之 catch 區塊直接以 `buildErrorBody("REPORT_GENERATION_FAILED",
 * ...)` 組出 wire 格式（`buildErrorBody` 之 `code` 參數型別為 `string`，非
 * 收斂之 `ErrorCode`，故不需修改 `errors.ts` 即可組出正確、與其餘端點形狀
 * 一致的錯誤回應）。T11 落地 `ErrorCode` 聯集後，此處與 routes.ts 之呼叫端
 * 皆可原樣沿用（`buildErrorBody` 的 `code` 參數本就接受 union 的任何成員）。
 * 各階段之 catch 區塊刻意**不**保留原始 `err`（連內部欄位也不留）——
 * `LocalVolumeStorage` 之錯誤訊息逐字含 storage key（T8a `report-storage.ts`
 * 檔頭同型說明），`chromium.launch()` 失敗訊息逐字含 `executablePath`（T7-
 * FW2①）；`sanitizeForLog` 僅清除憑證樣式字串、不清除路徑或 key（見
 * `report-images.ts` 檔頭同型說明），不足以滿足本檔義務。故本檔的防線是
 * 「結構性地不持有」而非「持有後嘗試清洗」。
 */
import crypto from "node:crypto";
import type { ApplicationType, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { Storage } from "../storage/index.js";
import { renderPdf } from "./pdf-renderer.js";
import {
  type ReportApplicationRecord,
  buildReportData,
  reportApplicationInclude,
} from "./report-data.js";
import { buildReportFileName } from "./report-filename.js";
import { renderReportHtml } from "./report-html.js";
import { type EmbedImagesLogger, embedImages } from "./report-images.js";
import {
  buildReportNumber,
  getReportNumberPeriod,
  getReportNumberPrefix,
} from "./report-number.js";

// ---------------------------------------------------------------------------
// 公開型別
// ---------------------------------------------------------------------------

export interface ReportServiceDeps {
  prisma: PrismaClient;
  /** 附件 storage 實例（`att` 前綴）——`embedImages` 讀取證明圖片位元組之來源。 */
  attachmentStorage: Storage;
  /** 報表 storage 實例（`rpt` 前綴）——PDF 位元組之保存與讀回校驗。 */
  reportStorage: Storage;
  imageMaxPx: number;
  pdfTimeoutMs: number;
  log: EmbedImagesLogger;
}

export type ReportFailureStage = "RENDER" | "STORE" | "VERIFY" | "PERSIST";

/**
 * §7.5／D5：產生失敗之統一內部錯誤型別。刻意**不**繼承或攜帶原始 `err`
 * （見檔頭「錯誤碼與日誌安全」）——`stage` 是唯一允許外流（回應 `details`）
 * 之資訊。
 */
export class ReportGenerationError extends Error {
  readonly stage: ReportFailureStage;
  constructor(stage: ReportFailureStage) {
    super(`Report generation failed at stage ${stage}`);
    this.name = "ReportGenerationError";
    this.stage = stage;
  }
}

export interface GeneratedReportRow {
  reportNumber: string;
  generatedAt: Date;
  fileName: string;
  byteSize: number;
}

export interface GenerateReportOutcome {
  /** `true` = 本次呼叫實際新增（201）；`false` = 冪等回既有（200）。 */
  created: boolean;
  report: GeneratedReportRow;
}

// ---------------------------------------------------------------------------
// 內部工具
// ---------------------------------------------------------------------------

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** 補償刪除；本身失敗不得掩蓋呼叫端正在拋出的原始失敗（best-effort）。 */
async function safeDelete(storage: Storage, key: string): Promise<void> {
  try {
    await storage.delete(key);
  } catch {
    // best-effort cleanup
  }
}

/**
 * §8.4／AC-20：`buildReportFileName` 之型別專屬日期或年度來源。TRAVEL→出差
 * 日期／MAINTENANCE→本次保養日期／DEPRECIATION→申請年度。**刻意不使用
 * `generatedAt`**（date-only 語意；T4-FW4/FW-5）。
 */
function deriveDateOrYearSource(application: ReportApplicationRecord): Date | number | null {
  if (application.type === "TRAVEL") {
    return application.travel?.tripDate ?? null;
  }
  if (application.type === "MAINTENANCE") {
    return application.maintenance?.currentMaintenanceDate ?? null;
  }
  if (application.type === "DEPRECIATION") {
    return application.depreciation?.applicationYear ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 交易重試（沿 travel-service.ts updateTravelDraft 等既有 SERIALIZABLE 重試
// 慣例；本檔獨立持有一份，非共用匯入——與該檔案、maintenance-service.ts、
// depreciation-service.ts、attachment/lifecycle-service.ts 之既有慣例一致，
// 該四檔各自持有一份同型 `isRetryableTransactionConflict`，未抽共用）。
// ---------------------------------------------------------------------------

const REPORT_INSERT_MAX_RETRIES = 5;
const RETRY_BACKOFF_BASE_MS = 15;
const RETRY_BACKOFF_CAP_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryBackoffMs(attempt: number): number {
  const exp = Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

/**
 * 沿 `travel-service.ts` 之 `isRetryableTransactionConflict`（PHASE-004-R4）
 * 同型判斷：Postgres SERIALIZABLE 序列化失敗（40001）或死鎖（40P01），經
 * P2034（一般 Prisma 操作）或 P2010（raw query）兩種型態回報。
 */
function isRetryableTransactionConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2034") return true;
    if (err.code === "P2010") {
      const meta = err.meta as { code?: string } | undefined;
      return meta?.code === "40001" || meta?.code === "40P01";
    }
    return false;
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return /deadlock detected|could not serialize access/i.test(err.message);
  }
  return false;
}

type ReportConflictKind = "APPLICATION_ID" | "STORAGE_KEY" | "SEQUENCE" | "UNKNOWN";

/**
 * D3（人類已批准）：「P2002 須讀 `meta.target` 辨衝突鍵——`applicationId`
 * 冪等碰撞 vs `sequence` 配號碰撞（四唯一鍵同回 P2002，T1 碰撞測試實
 * 證）」。`storageKey` 碰撞另分一類：`storageKey` 於同一次呼叫全程不變
 * （`crypto.randomUUID()` 於呼叫端只生成一次），重試不會改變它，故不可重
 * 試——與可藉由重新計算 `sequence` 而收斂的碰撞型態本質不同。
 */
function classifyReportP2002(err: unknown): ReportConflictKind | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
    return null;
  }
  const meta = err.meta as { target?: unknown } | undefined;
  const target = meta?.target;
  const parts: string[] =
    typeof target === "string" ? [target] : Array.isArray(target) ? target.map(String) : [];
  const joined = parts.join(",");
  if (joined.includes("applicationId")) return "APPLICATION_ID";
  if (joined.includes("storageKey")) return "STORAGE_KEY";
  if (
    joined.includes("numberPrefix") ||
    joined.includes("numberPeriod") ||
    joined.includes("sequence") ||
    joined.includes("reportNumber")
  ) {
    return "SEQUENCE";
  }
  // meta 缺失或無法辨識——保守視為可重試：下一輪交易之冪等前置查詢
  // （見下方 assignReportNumberAndInsert）會在「其實是 applicationId 碰
  // 撞」時自然收斂為敗方；若並非如此，重試上限（5 次）確保不會無限重試。
  return "UNKNOWN";
}

interface AssignAndInsertInput {
  applicationId: string;
  type: ApplicationType;
  generatedAt: Date;
  actorId: string;
  storageKey: string;
  byteSize: number;
  contentHash: string;
  displayName: string;
  dateOrYearSource: Date | number | null;
  primaryDate: Date;
}

interface AssignAndInsertOutcome {
  created: boolean;
  row: GeneratedReportRow;
}

/**
 * §9.1 步驟 (7)：SERIALIZABLE 交易（重試 ≤5）。每次嘗試皆是全新交易——
 * Postgres 於交易內拋出任何錯誤後即中止該交易，不可在同一交易內恢復重
 * 試，故「重試」必然是「開新交易再跑一次」（沿 `travel-service.ts` 既有
 * for 迴圈外層 `prisma.$transaction` 慣例）。
 *
 * 交易第一步永遠是「再查一次冪等」（TOCTOU 收斂點）——不論上一次嘗試因何
 * 種原因失敗（`applicationId` 唯一鍵碰撞、序列化衝突……），只要現在已經有
 * 人贏得了這個 `applicationId`，本次嘗試會在此處自然發現並以「敗方」收
 * 斂，不需要精確判斷上一次失敗的確切原因即可正確運作——`classifyReportP2002`
 * 的分類只是用來**避免無謂重試**（例如 `storageKey` 碰撞永遠不會被這條路
 * 徑解決），並非正確性所必需。
 */
async function assignReportNumberAndInsert(
  prisma: PrismaClient,
  input: AssignAndInsertInput
): Promise<AssignAndInsertOutcome> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= REPORT_INSERT_MAX_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          // (7)a：交易內冪等前置查詢。
          const existing = await tx.report.findUnique({
            where: { applicationId: input.applicationId },
          });
          if (existing) {
            return { created: false, row: existing };
          }

          // (7)b：配號。T2-FW1——同月序號查詢一律以 getReportNumberPeriod()
          // 之字串比對 numberPeriod，禁 date_trunc('month', ...) 或任何 UTC
          // 月區間換算。
          const prefix = getReportNumberPrefix(input.type);
          const period = getReportNumberPeriod(input.generatedAt);
          const agg = await tx.report.aggregate({
            where: { numberPrefix: prefix, numberPeriod: period },
            _max: { sequence: true },
          });
          const nextSequence = (agg._max.sequence ?? 0) + 1;

          // T2-FW3：序號守門——Number.isInteger(n) && n >= 1。
          if (!Number.isInteger(nextSequence) || nextSequence < 1) {
            throw new Error("report sequence invariant violated");
          }

          const reportNumber = buildReportNumber(prefix, period, nextSequence);

          // T2-FW2：落庫前 assert reportNumber 與四欄一致（自我一致性防
          // 線——buildReportNumber 對同輸入必同輸出，此斷言恆真，但保留作
          // 為未來重構之結構性守門）。T2-FW3：最終字串落庫前之格式 assert。
          if (reportNumber !== buildReportNumber(prefix, period, nextSequence)) {
            throw new Error("report number derivation mismatch");
          }
          if (!/^(TRV|MNT|DEP)-\d{6}-\d{4,}$/.test(reportNumber)) {
            throw new Error("report number failed format invariant");
          }

          // AC-20：檔名於此刻（reportNumber 已確定）組裝並凍結；T2-FW4/
          // T3-FW3——reportNumber 參數僅接受 generateReportNumber 之同型產
          // 物（此處為 buildReportNumber，底層邏輯相同），不接受任何使用
          // 者可影響之字串。
          const fileName = buildReportFileName({
            type: input.type,
            displayName: input.displayName,
            dateOrYearSource: input.dateOrYearSource,
            primaryDate: input.primaryDate,
            reportNumber,
          });

          // (7)c：INSERT；唯一鍵衝突交由外層 catch 分類與重試。
          const created = await tx.report.create({
            data: {
              applicationId: input.applicationId,
              reportNumber,
              numberPrefix: prefix,
              numberPeriod: period,
              sequence: nextSequence,
              storageKey: input.storageKey,
              fileName,
              byteSize: input.byteSize,
              contentHash: input.contentHash,
              generatedById: input.actorId,
              generatedAt: input.generatedAt,
            },
          });
          return { created: true, row: created };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (err) {
      lastError = err;

      const conflict = classifyReportP2002(err);
      if (conflict === "STORAGE_KEY") {
        // storageKey 不隨重試改變，重試必再次衝突——非可重試錯誤。
        throw err;
      }
      const retryable =
        isRetryableTransactionConflict(err) ||
        conflict === "SEQUENCE" ||
        conflict === "APPLICATION_ID" ||
        conflict === "UNKNOWN";
      if (!retryable) {
        throw err;
      }
      if (attempt >= REPORT_INSERT_MAX_RETRIES) {
        throw err;
      }
      await sleep(retryBackoffMs(attempt));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// 入口（§9.1 全流程編排）
// ---------------------------------------------------------------------------

/**
 * 產生（或冪等回既有）正式報表。呼叫端（`routes.ts`）須已完成授權
 * （401／403）與狀態守門（409，DRAFT 拒絕）——本函式假設 `applicationId`
 * 對應之申請確實存在且為 `COMPLETED`。
 *
 * @throws {ReportGenerationError} 任一階段（RENDER／STORE／VERIFY／
 *   PERSIST）失敗時；已寫入之 storage 檔案已於拋出前補償刪除（零殘留）。
 */
export async function generateReport(
  deps: ReportServiceDeps,
  applicationId: string,
  actorId: string
): Promise<GenerateReportOutcome> {
  const { prisma } = deps;

  // §9.1 (1)：冪等前置查詢——命中則零渲染、零寫入（AC-05(a)）。
  const existingPre = await prisma.report.findUnique({ where: { applicationId } });
  if (existingPre) {
    return { created: false, report: existingPre };
  }

  // T4-FW7：直接使用 report-data.ts 匯出之 reportApplicationInclude（產生
  // 路徑之唯一 include 來源，不另立字面複本）。
  const application = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    include: reportApplicationInclude,
  });

  // §9.1 (2)(3)(4)：RENDER 階段。
  let html: string;
  try {
    const rawData = await buildReportData(prisma, application, null);
    const withImages = await embedImages(
      deps.attachmentStorage,
      rawData,
      deps.imageMaxPx,
      deps.log
    );
    html = renderReportHtml(withImages);
  } catch {
    throw new ReportGenerationError("RENDER");
  }

  // §9.1 (5)：RENDER 階段（PDF 渲染／逾時）。
  let pdfBytes: Buffer;
  try {
    pdfBytes = await renderPdf(html, { timeoutMs: deps.pdfTimeoutMs });
  } catch {
    throw new ReportGenerationError("RENDER");
  }

  const storageKey = `rpt/${crypto.randomUUID()}/pdf`;

  // §9.1 (6a)：STORE 階段。
  try {
    await deps.reportStorage.put(storageKey, pdfBytes, "application/pdf");
  } catch {
    throw new ReportGenerationError("STORE");
  }

  // §9.1 (6b)：VERIFY 階段——讀回校驗（位元組數 + SHA-256）。
  let contentHash: string;
  try {
    const readBack = await deps.reportStorage.get(storageKey);
    const readBackBytes = Buffer.isBuffer(readBack) ? readBack : await streamToBuffer(readBack);
    if (readBackBytes.length !== pdfBytes.length) {
      throw new Error("readback byte size mismatch");
    }
    const expectedHash = crypto.createHash("sha256").update(pdfBytes).digest("hex");
    const actualHash = crypto.createHash("sha256").update(readBackBytes).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error("readback hash mismatch");
    }
    contentHash = expectedHash;
  } catch {
    await safeDelete(deps.reportStorage, storageKey);
    throw new ReportGenerationError("VERIFY");
  }

  // §9.1 (7)(8)：PERSIST 階段——配號在最後一步；任一失敗或「敗方」皆須清
  // 理本次已寫入之 storage 檔（零殘留／零孤兒，AC-07／AC-10）。
  try {
    const generatedAt = new Date();
    const result = await assignReportNumberAndInsert(prisma, {
      applicationId,
      type: application.type,
      generatedAt,
      actorId,
      storageKey,
      byteSize: pdfBytes.length,
      contentHash,
      displayName: application.owner.displayName,
      dateOrYearSource: deriveDateOrYearSource(application),
      primaryDate: application.primaryDate,
    });

    if (!result.created) {
      await safeDelete(deps.reportStorage, storageKey);
    }

    return { created: result.created, report: result.row };
  } catch {
    await safeDelete(deps.reportStorage, storageKey);
    throw new ReportGenerationError("PERSIST");
  }
}
