/**
 * 報表產生服務 — PHASE-008-T8／T8R（BE-US-26／27）
 *
 * Spec `docs/specs/PHASE-008.md` §2.B/C AC-04／AC-05／AC-06／AC-07／AC-10、
 * §3.1、§9.1（唯一之寫入路徑，**方案 (d)**，2026-08-06 人類裁定）、§16 D3
 * 修訂後定案（併發保證與冪等）、D5（失敗語意與錯誤碼；步驟順序已隨 D3 修
 * 訂）。
 *
 * ---------------------------------------------------------------------------
 * §9.1 流程對照（方案 (d)；本檔為該流程之編排層；routes.ts 只負責授權／狀
 * 態守門與錯誤碼轉譯，見該檔）
 * ---------------------------------------------------------------------------
 * (1) 冪等前置查詢（交易外）：`Report.findUnique({ applicationId })` 命中
 *     → 直接回既有，零渲染、零寫入（AC-05(a)）。
 * (2)(3) 交易外：`buildReportData`（讀快照＋附件列，`report: null`，零重
 *     算）→ `embedImages`（附件位元組降尺寸內嵌）。此二步只讀、無 DB 寫
 *     入，一律只呼叫一次（不隨重試輪重跑，§9.1「零重算」）。
 * (4) 單一 SERIALIZABLE 交易（重試 ≤5，指數退避）；**每輪依序**：
 *     a. 交易內再查一次冪等（TOCTOU 收斂點）→ 命中即「敗方」，回既有。
 *     b. `max(sequence)+1` 配號；`reportNumber`／`generatedAt`
 *        於此刻決定（交易內、尚未提交）——**配號必須早於渲染**（見下）。
 *     c. `renderReportHtml`——以 (2)(3) 之 `baseData` 覆寫
 *        `common.reportNumber`／`common.generatedAt` 後呼叫（純函式、與
 *        列印端點 T10 同一份實作；見 {@link withReportMeta}，不重新查詢
 *        DB，僅覆寫兩個純量欄位，仍屬「零重算」）。
 *     d. `renderPdf`（Playwright；逾時／渲染失敗）。
 *     e. `storage.put` → 讀回校驗（位元組數 ＋ SHA-256）。
 *     f. `tx.report.create`——唯一鍵衝突／序列化失敗交由外層重試迴圈分
 *        類；命中則交易提交（g）。
 * (5) 任一輪回滾或最終失敗 → 該輪已 `put` 之 key 一律 `storage.delete`
 *     補償（交易回滾只還原 DB，storage 為交易外資源，補償刪檔為其唯一還
 *     原手段；**每一重試輪皆須補償，於該輪交易回滾之後執行**——見
 *     {@link generateOnceWithRetry} 之 `catch`，不在交易回呼內部執行）。
 * (6) 敗方 → `created: false`；不可恢復失敗 → `ReportGenerationError`
 *     （stage ∈ RENDER／STORE／VERIFY／PERSIST）。
 *
 * ---------------------------------------------------------------------------
 * 重試範圍（僅 (4)f 之唯一鍵／序列化衝突可重試；(4)c／d／e 之失敗一律終
 * 止，不重試）
 * ---------------------------------------------------------------------------
 * `renderReportHtml`／`renderPdf`／`storage.put`／讀回校驗四者之失敗屬確
 * 定性失敗（模板錯誤、引擎崩潰、磁碟問題……），重試不會改變結果，故直接
 * 以 {@link ReportGenerationError} 終止本次呼叫（見 §9.1 pseudocode 之
 * 「不符→失敗路徑」，與 (4)f「唯一鍵衝突／序列化失敗→回滾→重試 a」的
 * 「重試」用語有意區分）。只有 (4)f 之 `tx.report.create` 遭遇可重試之
 * DB 衝突時，才會開新交易重跑整輪 (4)a~g（含重新渲染——D3 修訂已明示接受
 * 之成本）。
 *
 * ---------------------------------------------------------------------------
 * 不燒號（D3 修訂後定案；不變式，字面已改、目的不變）
 * ---------------------------------------------------------------------------
 * 序號並非計數器物件或 DB `SEQUENCE`，而是配號當下之 `max(sequence)+1`
 * 即時查詢；未提交之交易對 `Report` 表零可見列。任一輪失敗都會使該輪交
 * 易回滾（不論是 (4)c~e 之終止性失敗、抑或 (4)f 之衝突重試），回滾後下
 * 一次查詢取得同一序號——渲染或寫檔失敗絕不消耗編號，由**交易回滾天然達
 * 成**，不需額外機制。
 *
 * ---------------------------------------------------------------------------
 * PDF 內容含報表編號／產生時間（方案 (d) 之直接結果；恢復 AC-11／AC-15
 * 已批准之字面義務，非新增行為）
 * ---------------------------------------------------------------------------
 * (4)b 配號早於 (4)c 渲染，故 `renderReportHtml` 呼叫時 `common.reportNumber`
 * ／`common.generatedAt` 已非 `null`——持久化 PDF 與列印端點（T10，已產生
 * 報表之申請）呈現同一組編號／產生時間，AC-15 之「同一函式、同一輸入產
 * 生且字串全等」得以在 wire 層成立（純函式性質本身之 `toEqual` 恆成立，
 * 見 `report-html.test.ts`；此處額外之保證是「兩個呼叫情境輸入相同」）。
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
  type ReportCommon,
  type ReportData,
  type ReportMeta,
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

/**
 * §9.1 (4)c：以本輪配得之 `reportNumber`／`generatedAt` 覆寫 (2)(3) 已組裝
 * 之 `baseData.common` 兩個純量欄位——**不重新查詢 DB**（`common` 之其餘
 * 欄位、`travel`／`maintenance`／`depreciation` 主體皆不受影響），故仍屬
 * §9.1「零重算」；輸出與呼叫端以 `buildReportData(prisma, application,
 * { reportNumber, generatedAt })` 重查一次所得者字面全等（`buildCommon` 只
 * 有這兩欄依賴 `report` 參數，見 `report-data.ts`）。
 */
function withReportMeta(data: ReportData, meta: ReportMeta): ReportData {
  const common: ReportCommon = {
    ...data.common,
    reportNumber: meta.reportNumber,
    generatedAt: meta.generatedAt.toISOString(),
  };
  if (data.kind === "TRAVEL") {
    return { kind: "TRAVEL", common, travel: data.travel };
  }
  if (data.kind === "MAINTENANCE") {
    return { kind: "MAINTENANCE", common, maintenance: data.maintenance };
  }
  return { kind: "DEPRECIATION", common, depreciation: data.depreciation };
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
 * 證）」。`storageKey` 碰撞另分一類：`storageKey` 於同一輪交易內由
 * `crypto.randomUUID()` 生成，重試會在下一輪產生**全新**的 key，故若本輪
 * 真的撞上 `storageKey`（機率上近乎不可能），重試無法解決同一碰撞——與可
 * 藉由重新配號而收斂的碰撞型態本質不同。
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
  // （§9.1 (4)a）會在「其實是 applicationId 碰撞」時自然收斂為敗方；若並
  // 非如此，重試上限（5 次）確保不會無限重試。
  return "UNKNOWN";
}

interface AttemptInput {
  applicationId: string;
  type: ApplicationType;
  /** §9.1 (2)(3) 之產物（`report: null`）；每一輪皆重複使用，不重新查詢。 */
  baseData: ReportData;
  actorId: string;
  displayName: string;
  dateOrYearSource: Date | number | null;
  primaryDate: Date;
}

interface AttemptOutcome {
  created: boolean;
  row: GeneratedReportRow;
}

/**
 * §9.1 (4)：單一 SERIALIZABLE 交易（重試 ≤5，指數退避）。每次嘗試皆是全新
 * 交易——Postgres 於交易內拋出任何錯誤後即中止該交易，不可在同一交易內恢
 * 復重試，故「重試」必然是「開新交易再跑一次」（沿 `travel-service.ts` 既
 * 有 for 迴圈外層 `prisma.$transaction` 慣例）。
 *
 * **SF-4／結構性守門**：`renderReportHtml` 之呼叫（(4)c）位於本函式傳給
 * `$transaction(...)` 的回呼**內部**（非另立函式後於外部呼叫），且文字上
 * 位於配號（(4)b，`buildReportNumber(...)`）之後——此二事實由
 * `phase8-report-generate.test.ts` 之結構性測試以原始碼字串位置直接鑑別，
 * 任何把渲染移出交易或搬到配號之前的重構皆會使該測試轉紅。
 *
 * **每一輪之補償刪檔於「該輪交易已回滾之後」執行**（§9.1 (5)）：`put` 是
 * storage（交易外資源）之副作用，DB 回滾不會回收已寫入之檔案；`attemptState`
 * 於回呼內部記下本輪 `put` 之 key，待 `$transaction(...)` 拋錯（＝該輪已
 * 回滾完成）後，於下方 `catch` 內以 `safeDelete` 補償——不在回呼內部提前
 * 刪除。
 */
async function generateOnceWithRetry(
  deps: ReportServiceDeps,
  input: AttemptInput
): Promise<AttemptOutcome> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= REPORT_INSERT_MAX_RETRIES; attempt++) {
    const attemptState: { storageKey?: string } = {};
    try {
      return await deps.prisma.$transaction(
        async (tx) => {
          // §9.1 (4)a：交易內冪等前置查詢（TOCTOU 收斂點）——不論上一輪因
          // 何種原因失敗，只要現在已經有人贏得了這個 applicationId，本輪
          // 會在此處自然發現並以「敗方」收斂。
          const existing = await tx.report.findUnique({
            where: { applicationId: input.applicationId },
          });
          if (existing) {
            return { created: false, row: existing };
          }

          // §9.1 (4)b：配號 ＋ generatedAt——本輪一次性決定，交易內、尚未
          // 提交（**必須早於 (4)c 渲染**，見下）。
          const generatedAt = new Date();
          const prefix = getReportNumberPrefix(input.type);
          // T2-FW1：同月序號查詢一律以 getReportNumberPeriod() 之字串比對
          // numberPeriod，禁 date_trunc('month', ...) 或任何 UTC 月區間換算。
          const period = getReportNumberPeriod(generatedAt);
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

          // §9.1 (4)c：帶編號渲染——純函式，與列印端點（T10）同一份實作、
          // 同一輸入形狀（AC-11／AC-15 之結構前提：配號（上）早於渲染
          // （下））。
          const dataWithMeta = withReportMeta(input.baseData, { reportNumber, generatedAt });
          let html: string;
          try {
            html = renderReportHtml(dataWithMeta);
          } catch {
            throw new ReportGenerationError("RENDER");
          }

          // §9.1 (4)d：PDF 渲染（Playwright；逾時／崩潰視為 RENDER）。
          let pdfBytes: Buffer;
          try {
            pdfBytes = await renderPdf(html, { timeoutMs: deps.pdfTimeoutMs });
          } catch {
            throw new ReportGenerationError("RENDER");
          }

          // §9.1 (4)e：put——自此刻起將 key 記入 attemptState，供交易外
          // （回滾之後）補償；SF-3：即使 put 本身失敗，亦以 safeDelete
          // best-effort 收尾（理論上無殘留，但不因「理論上不需要」而省略
          // 這條防線）。
          const storageKey = `rpt/${crypto.randomUUID()}/pdf`;
          try {
            await deps.reportStorage.put(storageKey, pdfBytes, "application/pdf");
            attemptState.storageKey = storageKey;
          } catch {
            await safeDelete(deps.reportStorage, storageKey);
            throw new ReportGenerationError("STORE");
          }

          // §9.1 (4)e：讀回校驗（位元組數 ＋ SHA-256）。
          let contentHash: string;
          try {
            const readBack = await deps.reportStorage.get(storageKey);
            const readBackBytes = Buffer.isBuffer(readBack)
              ? readBack
              : await streamToBuffer(readBack);
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
            throw new ReportGenerationError("VERIFY");
          }

          // §9.1 (4)f：INSERT——唯一鍵衝突／序列化失敗交由外層重試迴圈分
          // 類（見下方 catch）；成功則交易提交（(4)g）。
          const created = await tx.report.create({
            data: {
              applicationId: input.applicationId,
              reportNumber,
              numberPrefix: prefix,
              numberPeriod: period,
              sequence: nextSequence,
              storageKey,
              fileName,
              byteSize: pdfBytes.length,
              contentHash,
              generatedById: input.actorId,
              generatedAt,
            },
          });
          return { created: true, row: created };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (err) {
      // §9.1 (5)：本輪交易已回滾（Prisma 於回呼拋錯後自動 ROLLBACK）；若
      // 本輪已完成 storage.put，於回滾之後在此補償刪除（storage 為交易外
      // 資源，DB 回滾不會回收已寫入之檔案）。
      if (attemptState.storageKey) {
        await safeDelete(deps.reportStorage, attemptState.storageKey);
      }

      if (err instanceof ReportGenerationError) {
        // (4)c／d／e 之終止性失敗——不重試（見檔頭「重試範圍」）。
        throw err;
      }

      lastError = err;
      const conflict = classifyReportP2002(err);
      if (conflict === "STORAGE_KEY") {
        // storageKey 於本輪已補償刪除；碰撞本身不可藉重試解決。
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

  // §9.1 (1)：冪等前置查詢（交易外）——命中則零渲染、零寫入（AC-05(a)）。
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

  // §9.1 (2)(3)：交易外——快照組裝與圖片嵌入（零重算、零 DB 寫入）；只呼
  // 叫一次，不隨 (4) 之重試輪重跑（§9.1「(2)(3) 之順序不可對調且皆在交易
  // 外」）。此刻尚無報表編號／產生時間（report: null），(4)b 配號後由
  // {@link withReportMeta} 覆寫兩個純量欄位，不重新查詢 DB。
  let baseData: ReportData;
  try {
    const rawData = await buildReportData(prisma, application, null);
    baseData = await embedImages(deps.attachmentStorage, rawData, deps.imageMaxPx, deps.log);
  } catch {
    throw new ReportGenerationError("RENDER");
  }

  try {
    const outcome = await generateOnceWithRetry(deps, {
      applicationId,
      type: application.type,
      baseData,
      actorId,
      displayName: application.owner.displayName,
      dateOrYearSource: deriveDateOrYearSource(application),
      primaryDate: application.primaryDate,
    });
    return { created: outcome.created, report: outcome.row };
  } catch (err) {
    if (err instanceof ReportGenerationError) {
      throw err;
    }
    // (4)f 重試耗盡或不可重試之 DB 衝突——PERSIST（§16 D5，字面順序已隨
    // D3 修訂，錯誤碼與 stage 語意不變）。
    throw new ReportGenerationError("PERSIST");
  }
}
