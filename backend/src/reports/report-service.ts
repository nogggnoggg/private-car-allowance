/**
 * 報表產生服務 — PHASE-008-T8／T8R／T8R2／T8R3／T8R4（BE-US-26／27）
 *
 * Spec `docs/specs/PHASE-008.md` §2.B/C AC-04／AC-05／AC-06／AC-07／AC-10、
 * §3.1、§9.1（唯一之寫入路徑，**方案 (d)**，2026-08-06 人類裁定；
 * **T8R4／SF-5 再裁定＝顧問鎖 ＋ `READ COMMITTED`**已落地於 (4)a/(4)b，
 * 見下）、§16 D3 修訂後定案（併發保證與冪等；末段「隔離等級修訂」）、D5
 * （失敗語意與錯誤碼；步驟順序已隨 D3／SF-5／T8R4 修訂）。
 *
 * ---------------------------------------------------------------------------
 * T8R4／隔離等級沿革（一次性揭露；避免重讀者誤以為 SERIALIZABLE 仍是唯一
 * 選項——後續各節之「本交易」一律指本報表產生交易，非全域設定）
 * ---------------------------------------------------------------------------
 * T8R3 依 Spec 原字面（顧問鎖疊加於 SERIALIZABLE 交易之上）落地後，經**三
 * 層獨立複現**（①原始 `psql` 雙 session，完全繞過 Prisma；②Prisma 層等效
 * 重現；③真實 12 併發、400ms 真實延遲之 AC-04(c) 全譜追蹤，attempt 0~5
 * 皆為 P2034）證明該機制**不成立**：PostgreSQL 之 SERIALIZABLE 快照於
 * **首語句即凍結、早於顧問鎖等待完成**，故排隊醒來之交易仍讀到舊
 * `max(sequence)`、照樣撞號（12 併發總耗更從 ~2.9s 惡化至 ~23-28s）。人類
 * 依此三層證據再裁定：**本報表產生交易之隔離等級改為 `READ COMMITTED`**
 * （**僅此交易**，其餘交易不受影響），並保留顧問鎖排隊——RC 之快照**每語
 * 句重新擷取**，故排隊醒來者之冪等再查與 `max(sequence)+1` 讀取皆能看見
 * 前位剛提交之列，鎖機制才真正達成「零撞號、每請求恰渲染一次」之設計目
 * 的。顧問鎖因而由 (4)b 前移為 **(4)a**（交易首語句），冪等再查隨之移入鎖
 * 內成為 **(4)b**（見下）。
 * ---------------------------------------------------------------------------
 * §9.1 流程對照（方案 (d)；本檔為該流程之編排層；routes.ts 只負責授權／狀
 * 態守門與錯誤碼轉譯，見該檔）
 * ---------------------------------------------------------------------------
 * (1) 冪等前置查詢（交易外）：`Report.findUnique({ applicationId })` 命中
 *     → 直接回既有，零渲染、零寫入（AC-05(a)）。
 * (2)(3) 交易外：`buildReportData`（讀快照＋附件列，`report: null`，零重
 *     算）→ `embedImages`（附件位元組降尺寸內嵌）。此二步只讀、無 DB 寫
 *     入，一律只呼叫一次（不隨重試輪重跑，§9.1「零重算」）。
 * (4) `READ COMMITTED` 交易（**本報表產生交易限定**；重試 ≤5，指數退
 *     避）；**每輪依序**：
 *     a. `pg_advisory_xact_lock(hashtext(numberPrefix || numberPeriod))`
 *        ——交易級顧問鎖（T8R4／SF-5 再裁定：顧問鎖 ＋ `READ COMMITTED`，
 *        §16 D3 修訂後定案末段「隔離等級修訂」）：鎖鍵為
 *        `(numberPrefix, numberPeriod)` 之穩定雜湊，同組請求於此排隊逐一
 *        進入，提交或回滾時自動釋放（無手動解鎖路徑）；**必須早於 b 冪
 *        等再查與 c 配號**（見下）——鎖必須是交易之**第一個陳述式**，
 *        `numberPrefix`／`numberPeriod`（進而 `generatedAt`）之計算故置
 *        於本步之前（純 JS 運算，非 DB 陳述式，不影響快照時序）。
 *     b. 交易內再查一次冪等（TOCTOU 收斂點）→ 命中即「敗方」，回既有。
 *        **鎖內查詢**：`READ COMMITTED` 之每語句重新擷取快照，使排隊醒
 *        來之交易能看見前位剛提交之列（見下方「同組排隊」）。
 *     c. `max(sequence)+1` 配號；`reportNumber`／`generatedAt`
 *        於此刻決定（交易內、尚未提交）——**配號必須早於渲染**（見下）。
 *     d. `renderReportHtml`——以 (2)(3) 之 `baseData` 覆寫
 *        `common.reportNumber`／`common.generatedAt` 後呼叫（純函式、與
 *        列印端點 T10 同一份實作；見 {@link withReportMeta}，不重新查詢
 *        DB，僅覆寫兩個純量欄位，仍屬「零重算」）。
 *     e. `renderPdf`（Playwright；逾時／渲染失敗）。
 *     f. `storage.put` → 讀回校驗（位元組數 ＋ SHA-256）。
 *     g. `tx.report.create`——**唯一鍵衝突（P2002；最後防線）**交由外層
 *        重試迴圈分類；命中則交易提交（h，顧問鎖於此自動釋放，下一個排
 *        隊者進入 a）。
 * (5) 任一輪回滾或最終失敗 → 該輪已 `put` 之 key 一律 `storage.delete`
 *     補償（交易回滾只還原 DB，storage 為交易外資源，補償刪檔為其唯一還
 *     原手段；**每一重試輪皆須補償，於該輪交易回滾之後執行**——見
 *     {@link generateOnceWithRetry} 之 `catch`，不在交易回呼內部執行）。
 * (6) 敗方 → `created: false`；不可恢復失敗 → `ReportGenerationError`
 *     （stage ∈ RENDER／STORE／VERIFY／PERSIST）。
 *
 * ---------------------------------------------------------------------------
 * 重試範圍（僅 (4)g 之 `P2002` 唯一鍵衝突可重試；(4)d／e／f 之失敗一律終
 * 止，不重試）
 * ---------------------------------------------------------------------------
 * `renderReportHtml`／`renderPdf`／`storage.put`／讀回校驗四者之失敗屬確
 * 定性失敗（模板錯誤、引擎崩潰、磁碟問題……），重試不會改變結果，故直接
 * 以 {@link ReportGenerationError} 終止本次呼叫（見 §9.1 pseudocode 之
 * 「不符→失敗路徑」，與 (4)g「唯一鍵衝突→回滾→重試 a」的「重試」用語有
 * 意區分）。只有 (4)g 之 `tx.report.create` 遭遇可重試之 DB 衝突時，才會
 * 開新交易重跑整輪 (4)a~h（含重新渲染——D3 修訂已明示接受之成本）。
 * **T8R4**：`READ COMMITTED` 下 Postgres 之序列化失敗（SQLSTATE 40001，
 * 僅 SERIALIZABLE／REPEATABLE READ 才會觸發）**結構上不可能發生於本交
 * 易**，故本檔不再將 `P2034`／`40001` 列為預期之重試分類（見下方
 * {@link isRetryableTransactionConflict} 之清理說明，避免留下暗示「序列
 * 化衝突仍是常態」之誤導性死碼）。唯一性之**主防線**是 (4)a 顧問鎖排
 * 隊，**最後防線**是三欄唯一約束 ＋ `applicationId` 唯一約束觸發之
 * `P2002`（≤5 次重試）；連線池相關之 `P2024`／`P2028`（MF-3，與隔離等
 * 級無關）仍循既有重試路徑。
 *
 * ---------------------------------------------------------------------------
 * 不燒號（D3 修訂後定案；不變式，字面已改、目的不變）
 * ---------------------------------------------------------------------------
 * 序號並非計數器物件或 DB `SEQUENCE`，而是配號當下之 `max(sequence)+1`
 * 即時查詢；未提交之交易對 `Report` 表零可見列。任一輪失敗都會使該輪交
 * 易回滾（不論是 (4)d~f 之終止性失敗、抑或 (4)g 之衝突重試），回滾後下
 * 一次查詢取得同一序號——渲染或寫檔失敗絕不消耗編號，由**交易回滾天然達
 * 成**，不需額外機制。
 *
 * ---------------------------------------------------------------------------
 * 同組排隊為唯一性之主防線（顧問鎖 ＋ `READ COMMITTED`；T8R4／2026-08-06
 * 人類再裁定 SF-5，§16 D3 修訂後定案末段「隔離等級修訂」；§9.1 (4) 不變
 * 式）
 * ---------------------------------------------------------------------------
 * 方案 (d) 將渲染移入交易，使 `max(sequence)+1` 之讀取窗口涵蓋整段渲
 * 染——同月同型高併發下若無收斂機制，衝突會於重試上限（5）內耗盡
 * （T8R2 以真實耗時替身 400ms 實測：12 併發約 6 筆失敗，三輪穩定）。
 * (4)a 之交易級顧問鎖使**同一 `(numberPrefix, numberPeriod)` 之請求排隊
 * 逐一執行**——組內任一時刻至多一個交易處於 b~h，**每個請求恰渲染一次**
 * （不再有「重試即重渲染」之放大）；**不同組（不同前綴或不同月份）互不
 * 阻擋**，並行度不受影響。鎖鍵為該二欄以 Postgres 內建 `hashtext()` 計算
 * 之穩定雜湊（同一組恆得同一鍵、跨程序一致；不同組偶發雜湊碰撞僅造成無
 * 害之額外排隊，不影響正確性）。**排隊之所以有效，前提是本交易為
 * `READ COMMITTED`**：其快照每語句重新擷取，排隊醒來者之 (4)b 冪等再查
 * 與 (4)c `max(sequence)+1` 皆能看見前位剛提交之列；**若為
 * `SERIALIZABLE`，快照於首語句即凍結、早於鎖等待完成，醒來仍讀舊值照樣
 * 撞號**——T8R3 已以三層獨立複現證明此點（見檔頭「隔離等級沿革」），此
 * 為本交易改採 `READ COMMITTED` 之直接理由。`AC-04(c)` 之字面（12 併發
 * 全成、編號集合恰為 `0001`~`0012`）不動；重試上限仍為 5（顧問鎖排隊為
 * 主防線後，三欄唯一約束 ＋ `P2002` 重試作為最後防線，理論上不應被觸
 * 及，但保留防禦——見上方「重試範圍」）。
 *
 * ---------------------------------------------------------------------------
 * PDF 內容含報表編號／產生時間（方案 (d) 之直接結果；恢復 AC-11／AC-15
 * 已批准之字面義務，非新增行為）
 * ---------------------------------------------------------------------------
 * (4)c 配號早於 (4)d 渲染，故 `renderReportHtml` 呼叫時 `common.reportNumber`
 * ／`common.generatedAt` 已非 `null`——持久化 PDF 與列印端點（T10，已產生
 * 報表之申請）呈現同一組編號／產生時間，AC-15 之「同一函式、同一輸入產
 * 生且字串全等」得以在 wire 層成立（純函式性質本身之 `toEqual` 恆成立，
 * 見 `report-html.test.ts`；此處額外之保證是「兩個呼叫情境輸入相同」）。
 *
 * ---------------------------------------------------------------------------
 * 錯誤碼與日誌安全（T7-FW2①、§7.5 D5）
 * ---------------------------------------------------------------------------
 * 【歷史沿革】撰寫本節時 `platform/errors.ts` 之 `ErrorCode` 聯集尚未收錄
 * `REPORT_GENERATION_FAILED`（該檔案屬 T11 之 Files Allowed，非當時 Task
 * 範圍）；T11（51cc459）已落地收錄此碼。本檔因而**不**經由 `AppError` 表達
 * 此失敗，改以本檔自有之 `ReportGenerationError`（僅含 `stage`，不含任何原
 * 始錯誤訊息、路徑或 storage key）向上拋出；`routes.ts` 之 catch 區塊直接以
 * `buildErrorBody("REPORT_GENERATION_FAILED", ...)` 組出 wire 格式
 * （`buildErrorBody` 之 `code` 參數型別為 `string`，非收斂之 `ErrorCode`，
 * 故不需修改 `errors.ts` 即可組出正確、與其餘端點形狀一致的錯誤回應）。
 * `ErrorCode` 聯集現已收錄此碼，此處與 routes.ts 之呼叫端原樣沿用
 * （`buildErrorBody` 的 `code` 參數本就接受 union 的任何成員），不需修改。
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

export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
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
 * §9.1 (4)d：以本輪配得之 `reportNumber`／`generatedAt` 覆寫 (2)(3) 已組裝
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

/**
 * T8R2 MF-2：Prisma 互動式交易若不明寫 `timeout`／`maxWait`，套用套件預設值
 * （`timeout` 5000ms、`maxWait` 2000ms）——遠低於 `REPORT_PDF_TIMEOUT_MS`
 * （預設 30000ms）與 AC-09(a) 之 10 秒效能目標，使交易在 (4)e 渲染仍進行中
 * 就被 Prisma 自身之交易逾時機制搶先中止（而非 `renderPdf` 自身
 * {@link import("./pdf-renderer.js").renderPdf} 之 `withTimeout` 機制）。
 * 此時拋出的是通用 `PrismaClientKnownRequestError`（P2028「Transaction
 * already closed」），並非 `ReportGenerationError`，被本檔外層
 * （{@link generateReport} 之 catch）誤標為 `PERSIST`——實際上失敗發生在
 * 交易本體執行期間，與 (4)g「持久化」步驟無關（reviewer 探針①實測：預設
 * 選項下交易內 sleep 6000ms → ~5000ms 即以此誤標收斂；本模組驗證腳本另
 * 實測 P2028 亦為 MF-3 連線池競爭下之相同錯誤碼，見下）。
 *
 * 修復：`timeout`／`maxWait` 兩值皆以 `deps.pdfTimeoutMs`（渲染逾時之唯一
 * 事實來源，來自 `REPORT_PDF_TIMEOUT_MS`）為基準加上裕度計算——不新增
 * env 變數（T8R2 Packet「Files Forbidden」明示：env.ts 若需新增交易裕度
 * 變數須 BLOCKED 回報，優先以既有 `REPORT_PDF_TIMEOUT_MS` 推導），亦不在
 * 呼叫處寫死最終毫秒數，避免未來調整 `REPORT_PDF_TIMEOUT_MS` 時交易逾時
 * 無聲維持在舊裕度而再度漂移。
 *
 * `REPORT_TX_TIMEOUT_MARGIN_MS`：涵蓋 (4)a 顧問鎖、(4)b 冪等查詢、(4)c
 * 配號聚合查詢、(4)f `put`／讀回校驗、(4)g `INSERT` 之額外耗時（皆為毫秒
 * 級 DB 操作，顧問鎖本身之取得亦僅毫秒級，除非同組已有請求排隊中——T8R4
 * 之 `READ COMMITTED` 下，排隊等待時間本身不再造成快照過期問題，見上方
 * 「同組排隊」）。
 * `REPORT_TX_MAX_WAIT_MARGIN_MS`：MF-3 高併發（連線池競爭）下，交易於
 * 「取得連線、正式開始執行前」之等待時間亦須有對應裕度，否則會在渲染都還
 * 沒開始前就先被 P2028（`maxWait` 逾時，reviewer 探針②之根因——實測訊息
 * 為「Unable to start a transaction in the given time」，見下方
 * `isRetryableTransactionConflict` P2028 分支）中止。兩裕度取同一基準，
 * 皆代表「單一嘗試」可額外容忍之等待，供 §9.1 (4) 重試迴圈每一輪皆有充足
 * 視窗完成一次嘗試。
 */
const REPORT_TX_TIMEOUT_MARGIN_MS = 10_000;
const REPORT_TX_MAX_WAIT_MARGIN_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryBackoffMs(attempt: number): number {
  const exp = Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

/**
 * T8R4／SF-5 清理（Packet 明文「40001／P2034 重試路徑於本交易失效之後不
 * 得留下誤導性敘述或死碼」）：本函式**原本**沿 `travel-service.ts` 之
 * `isRetryableTransactionConflict`（PHASE-004-R4）同型判斷 Postgres
 * SERIALIZABLE 序列化失敗（SQLSTATE 40001）或死鎖（40P01），經 P2034
 * （一般 Prisma 操作）或 P2010（raw query）兩種型態回報。**T8R4 之
 * `READ COMMITTED`（本交易限定）使 40001 序列化失敗結構上不可能發生於本
 * 交易**（40001 僅 SERIALIZABLE／REPEATABLE READ 隔離下才會被 Postgres
 * 觸發）——保留該分類會誤導未來讀者「序列化衝突仍是本交易之常態重試路
 * 徑」，故移除 `P2034` 頂層分類與 `P2010` 分支之 `40001` 檢查。
 *
 * **未移除 `P2010` 之 `40P01`（死鎖）檢查**：死鎖偵測**不限**
 * SERIALIZABLE，`READ COMMITTED` 下仍可能因鎖取得順序不同而觸發（例如顧
 * 問鎖與列鎖交錯），Spec 未將其列入本輪清理範圍（僅明列
 * 「P2034／40001」），且移除一個**仍可能發生**之防線與「不得留死碼」之
 * 精神相悖，故 `P2010` 函式與 `40P01` 檢查予以保留（`P2034` 之頂層分類
 * 雖同樣可能承載死鎖，但 Prisma 對 P2034 不暴露底層 SQLSTATE 無法區分死
 * 鎖與序列化失敗，Spec 明示歸類為整體移除——若未來偵測到本交易確實遭遇
 * P2034 型死鎖，屬新事實，須另行提交複審而非本輪默默保留半套分類）。
 *
 * T8R2 MF-3：`P2024`（連線池取得逾時）／`P2028`（Prisma 交易 API 錯誤，
 * 含 `maxWait` 逾時「Unable to start a transaction in the given time」與
 * `timeout` 逾時「Transaction already closed」兩種訊息）——與隔離等級無
 * 關（連線池／逾時層級之暫時性失敗，非資料衝突），**Spec 明示保留**。
 * reviewer 探針②實測（connection_limit=3＋交易內 1500ms＋12 併發）現況
 * 6/12 落於 P2028（maxWait 逾時）。**防禦縱深**：本檔已將 `timeout`／
 * `maxWait` 綁定 `deps.pdfTimeoutMs`＋裕度（見上）從根本降低觸發機率，此
 * 處之重試分類是第二道防線——即使裕度在更極端負載下仍被打穿，應用層重試
 * （≤5 次、指數退避）仍能收斂，而非直接以生硬的 500 終止（沿本檔一貫「結
 * 構性防線，不因『理論上不需要』而省略」慣例，見 `safeDelete` 之同型說
 * 明）。
 */
function isRetryableTransactionConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2024") return true;
    if (err.code === "P2028") return true;
    if (err.code === "P2010") {
      const meta = err.meta as { code?: string } | undefined;
      return meta?.code === "40P01";
    }
    return false;
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return /deadlock detected/i.test(err.message);
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
  // （§9.1 (4)b）會在「其實是 applicationId 碰撞」時自然收斂為敗方；若並
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
 * §9.1 (4)：`READ COMMITTED` 交易（**本報表產生交易限定**；重試 ≤5，指數
 * 退避）。每次嘗試皆是全新交易——Postgres 於交易內拋出任何錯誤後即中止該
 * 交易，不可在同一交易內恢復重試，故「重試」必然是「開新交易再跑一次」
 * （沿 `travel-service.ts` 既有 for 迴圈外層 `prisma.$transaction` 慣
 * 例）。
 *
 * **SF-4／結構性守門（T8R4 更新：雙守門）**：
 *   ① 交易隔離等級恆為 `ReadCommitted`（改回 `Serializable` 之 mutant 必
 *      紅——T8R3 三層獨立複現已證明 `SERIALIZABLE` 下顧問鎖排隊機制不成
 *      立，見檔頭「隔離等級沿革」，故此斷言之方向與 T8~T8R3 時期恰好相
 *      反）。
 *   ② `renderReportHtml` 之呼叫（(4)d）位於本函式傳給 `$transaction(...)`
 *      的回呼**內部**（非另立函式後於外部呼叫），且文字上位於配號（(4)c，
 *      `buildReportNumber(...)`）之後——此事實由
 *      `phase8-report-generate.test.ts` 之結構性測試以原始碼字串位置直
 *      接鑑別，任何把渲染移出交易或搬到配號之前的重構皆會使該測試轉紅。
 *
 * **T8R4／結構性守門**（比照 SF-4，§9.1 (4)a／(4)b 不變式）：交易級顧問
 * 鎖呼叫（`pg_advisory_xact_lock`）位於**交易之第一個陳述式**——早於冪
 * 等再查（(4)b，`tx.report.findUnique(`）與配號（(4)c，
 * `buildReportNumber(...)`）——此事實亦由
 * `phase8-report-generate.test.ts` 之結構性測試以原始碼字串位置鑑別，防
 * 後續重構默默移除鎖、或把鎖搬到冪等再查／配號之後（使顧問鎖排隊失去意
 * 義，序列化衝突風暴重現）。**鎖必須早於冪等再查**——鎖外之查詢在
 * `READ COMMITTED` 下雖然本身不會讀到過期快照，但若冪等再查於鎖之前執
 * 行，多個排隊者會同時通過冪等檢查（皆見「尚未存在」），使冪等收斂點失
 * 去「TOCTOU 收斂」之意義，須靠鎖排隊後才逐一重新確認。
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
          // §9.1 (4)a 之鎖鍵（numberPrefix／numberPeriod）須先決定；
          // generatedAt 一併於此取得（本輪一次性決定，交易內、尚未提
          // 交）。純 JS 運算（非 DB 陳述式），置於鎖之前不影響快照時序。
          const generatedAt = new Date();
          const prefix = getReportNumberPrefix(input.type);
          // T2-FW1：同月序號查詢一律以 getReportNumberPeriod() 之字串比對
          // numberPeriod，禁 date_trunc('month', ...) 或任何 UTC 月區間換算。
          const period = getReportNumberPeriod(generatedAt);

          // §9.1 (4)a：交易級顧問鎖（T8R4／SF-5 再裁定：顧問鎖 ＋
          // `READ COMMITTED`，§16 D3 修訂後定案末段「隔離等級修訂」）——
          // 鎖鍵為 `(numberPrefix, numberPeriod)` 以 Postgres 內建
          // `hashtext()` 計算之穩定雜湊；同一組請求於此排隊逐一進入，交
          // 易提交或回滾時自動釋放（無手動解鎖路徑、無洩漏鎖之可能）；
          // **必須是交易之第一個陳述式**（早於 (4)b 冪等再查與 (4)c 配
          // 號，見上方 SF-4／T8R4 結構性守門說明）——T8R3 三層獨立複現已
          // 證明：若本交易為 SERIALIZABLE，快照於首語句即凍結、早於鎖等
          // 待完成，排隊醒來仍讀舊值照樣撞號；本交易改為 `READ COMMITTED`
          // 後，鎖之位置才真正決定「排隊醒來者何時開始能看見新資料」。
          // `$executeRaw`（非 `$queryRaw`）：`pg_advisory_xact_lock` 回傳
          // 型別為 SQL `void`，`$queryRaw` 無法反序列化該型別（實測確
          // 認，見 Task Handoff），`$executeRaw` 僅回傳受影響列數、不嘗
          // 試反序列化回傳值，故為正確選擇。
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix} || ${period}))`;

          // §9.1 (4)b：交易內冪等前置查詢（TOCTOU 收斂點）——**鎖內查
          // 詢**：`READ COMMITTED` 之每語句重新擷取快照，使本查詢能看見
          // 排隊期間前位已提交之列；不論上一輪因何種原因失敗，只要現在
          // 已經有人贏得了這個 applicationId，本輪會在此處自然發現並以
          // 「敗方」收斂。
          const existing = await tx.report.findUnique({
            where: { applicationId: input.applicationId },
          });
          if (existing) {
            return { created: false, row: existing };
          }

          // §9.1 (4)c：配號——本輪一次性決定（交易內、尚未提交）——**必須
          // 早於 (4)d 渲染**（見下）。(4)a 之顧問鎖已排除同組併發、
          // `READ COMMITTED` 之每語句新快照使本查詢能看見前位已提交之
          // 序號，本查詢於正常情況下不再與同組其他請求競爭出重複序號。
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

          // §9.1 (4)d：帶編號渲染——純函式，與列印端點（T10）同一份實作、
          // 同一輸入形狀（AC-11／AC-15 之結構前提：配號（上）早於渲染
          // （下））。
          const dataWithMeta = withReportMeta(input.baseData, { reportNumber, generatedAt });
          let html: string;
          try {
            html = renderReportHtml(dataWithMeta);
          } catch {
            throw new ReportGenerationError("RENDER");
          }

          // §9.1 (4)e：PDF 渲染（Playwright；逾時／崩潰視為 RENDER）。
          let pdfBytes: Buffer;
          try {
            pdfBytes = await renderPdf(html, { timeoutMs: deps.pdfTimeoutMs });
          } catch {
            throw new ReportGenerationError("RENDER");
          }

          // §9.1 (4)f：put——自此刻起將 key 記入 attemptState，供交易外
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

          // §9.1 (4)f：讀回校驗（位元組數 ＋ SHA-256）。
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

          // §9.1 (4)g：INSERT——唯一鍵衝突（P2002；最後防線）交由外層重
          // 試迴圈分類（見下方 catch）；成功則交易提交（(4)h，顧問鎖於
          // 此自動釋放，下一個排隊者進入 a）。
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
        {
          // T8R4／SF-5 再裁定：本報表產生交易（僅此交易）改為
          // `ReadCommitted`——見檔頭「隔離等級沿革」與「同組排隊」之機制
          // 說明；SF-4 結構斷言已同步改為斷言 `ReadCommitted`（改回
          // `Serializable` 之 mutant 必紅）。
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          // T8R2 MF-2／MF-3：兩值皆自 deps.pdfTimeoutMs 推導＋裕度，見上方
          // REPORT_TX_TIMEOUT_MARGIN_MS／REPORT_TX_MAX_WAIT_MARGIN_MS 之說明。
          timeout: deps.pdfTimeoutMs + REPORT_TX_TIMEOUT_MARGIN_MS,
          maxWait: deps.pdfTimeoutMs + REPORT_TX_MAX_WAIT_MARGIN_MS,
        }
      );
    } catch (err) {
      // §9.1 (5)：本輪交易已回滾（Prisma 於回呼拋錯後自動 ROLLBACK）；若
      // 本輪已完成 storage.put，於回滾之後在此補償刪除（storage 為交易外
      // 資源，DB 回滾不會回收已寫入之檔案）。
      if (attemptState.storageKey) {
        await safeDelete(deps.reportStorage, attemptState.storageKey);
      }

      if (err instanceof ReportGenerationError) {
        // (4)d／e／f 之終止性失敗——不重試（見檔頭「重試範圍」）。
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
  // 外」）。此刻尚無報表編號／產生時間（report: null），(4)c 配號後由
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
    // (4)g 重試耗盡或不可重試之 DB 衝突——PERSIST（§16 D5，字面順序已隨
    // D3 修訂，錯誤碼與 stage 語意不變）。
    throw new ReportGenerationError("PERSIST");
  }
}

// ---------------------------------------------------------------------------
// §9.3／§3.4：查詢與下載支援（PHASE-008-T9；AC-08／AC-22／AC-23／AC-24／
// AC-27）——唯讀，零渲染、零 DB 寫入。`routes.ts` 之 GET 兩端點於授權與（下
// 載端點之）存在性守門後呼叫本節函式。
// ---------------------------------------------------------------------------

/** {@link findReportByApplicationId} 之回傳形狀——`GeneratedReportRow` 四鍵
 * ＋ `storageKey`（下載端點讀取 PDF 位元組之唯一依據；`ReportDto` 恆不含此
 * 欄，見 §7.2）。 */
export interface StoredReportRow extends GeneratedReportRow {
  storageKey: string;
}

/**
 * §9.3／§3.4：依 `applicationId` 查詢既有報表列（唯讀）。呼叫端
 * （`routes.ts`）須已完成授權判定；本函式不做任何授權或狀態守門。查詢端點
 * （`GET .../report`）與下載端點（`GET .../report/pdf`）共用本函式——前者
 * 僅取 `GeneratedReportRow` 之四鍵（經 `toReportDto` 過濾，AC-27），後者另
 * 需 `storageKey` 讀取位元組。
 */
export async function findReportByApplicationId(
  prisma: PrismaClient,
  applicationId: string
): Promise<StoredReportRow | null> {
  return prisma.report.findUnique({ where: { applicationId } });
}

/**
 * AC-22：`Content-Disposition` 之 RFC 5987 `filename*=UTF-8''` 值——對
 * `encodeURIComponent` 之輸出補完 attr-char 定義下仍不允許之四個字元
 * （`'`／`(`／`)`／`*`）。`encodeURIComponent` 本身已將任何控制字元（含
 * `\r`／`\n`）跳脫為 `%0D`／`%0A` 等百分比序列，故裸 CR/LF 不可能經由本函
 * 式流出（AC-22 header injection 封閉之第一層防線）。
 */
export function encodeRfc5987ValueChars(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * AC-22：`Content-Disposition` 雙形式——ASCII fallback（`filename="{報表編
 * 號}.pdf"`，僅 `[A-Za-z0-9.-]`）＋ RFC 5987（`filename*=UTF-8''{百分比編碼
 * 完整檔名}`）。
 *
 * `reportNumber` 之字元集由 AC-03(d) 結構性保證僅含 `[A-Z0-9-]`（見
 * `report-number.ts` 檔頭），故 ASCII fallback 恆安全；此處仍以顯式正則覆
 * 核作為結構性防線（沿本檔一貫「不因『理論上不需要』而省略」慣例，見
 * `safeDelete` 之同型說明）——若上游守門失效（未來重構誤傳未經
 * `buildReportNumber` 產生的字串），本函式會直接拋錯而非默默產出不安全標
 * 頭。`fileName` 一律經 {@link encodeRfc5987ValueChars} 百分比編碼，故理論
 * 上不會殘留裸 CR/LF；最終組出的標頭字串仍額外覆核零裸 CR/LF 作為第二層結
 * 構性斷言（AC-22「標頭值不含裸 CR/LF」之直接自證）。
 */
export function buildReportContentDisposition(reportNumber: string, fileName: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(reportNumber)) {
    throw new Error("reportNumber contains characters unsafe for ASCII fallback filename");
  }
  const asciiFileName = `${reportNumber}.pdf`;
  const encodedFileName = encodeRfc5987ValueChars(fileName);
  const header = `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`;
  if (/[\r\n]/.test(header)) {
    throw new Error("content-disposition header value contains raw CR/LF");
  }
  return header;
}
