/**
 * 報表路由 — PHASE-008-T8／T9／T10 ＋ PHASE-009-T12b／T13／T18
 * （BE-US-26／27／28；BE-US-31）
 *
 * T8 落地 `POST /applications/:id/report`（產生，冪等）。T9 新增
 * `GET /applications/:id/report`（查詢）與 `GET .../report/pdf`（下載）。
 * T10 新增 `GET .../report/print`（列印版 HTML）＋產生／列印兩端點之 409
 * 狀態守門（AC-25）＋列印安全標頭（AC-16(c)）。
 *
 * 【PHASE-009 之三次修訂（本檔沿革，避免上述 PHASE-008 敘述被誤讀為現況）】
 *   · **T12b**（AC-21(b)(d)／§16 D4(b1)）：下載端點於 `VOIDED` 且有
 *     `VoidedReportFile` 時回**作廢版**位元組——內容選擇，非狀態守門，狀態
 *     碼語意逐字不變（見下方「查詢／下載端點不另立狀態守門」節之修訂註）。
 *   · **T13**（AC-22／§16 D5）：**列印端點**之狀態守門由 `COMPLETED` 單值
 *     放行為 **`COMPLETED ∪ VOIDED`**（白名單）——故上一段 T10 所述之「產
 *     生／列印兩端點之 409 狀態守門」自 T13 起**僅對草稿**成立，且兩端點之
 *     守門字面**刻意不同**（產生端點不放行 `VOIDED`，B-27／D13）；逐條理由
 *     見該處行內註解。
 *   · **T18**（AC-40(b)／§16 D14(b)）：`REPORT_GENERATION_FAILED` 由
 *     `buildErrorBody` 繞道改經 `AppError` 承載（wire 逐字不變，見下）。
 *
 * Spec `docs/specs/PHASE-008.md` §7.1（端點總表）、§7.2（`ReportDto`）、
 * §7.4（列印版與 PDF 同一版型契約）、§7.5（錯誤合約）、§6.1（授權矩陣，判
 * 定紀律①②）、§9.2（列印版唯讀路徑）、§16 D7(a)+(i)（安全檔名規則 ＋ 產生
 * 時持久化）、D9(a)（管理員可代產生／存取）、D10(a)（查詢為獨立端點，未產
 * 生回 `200 { report: null }`）、D11（草稿 409 CONFLICT，僅適用產生／列
 * 印，見下）。
 *
 * ---------------------------------------------------------------------------
 * AC-15（T10 斷言基礎）：列印端點與持久化 PDF 之 HTML 字串全等
 * ---------------------------------------------------------------------------
 * 列印端點與 `report-service.ts` 之 (4)d 皆呼叫**同一函式**
 * `renderReportHtml`，且對**已產生報表**之申請皆以「`buildReportData` 讀出
 * 之基底資料 ＋ 已持久化之 `{ reportNumber, generatedAt }`」為輸入形狀
 * （前者經 `buildReportData(prisma, application, meta)` 之 `meta` 參數，
 * 後者經 `withReportMeta`）——兩條路徑**各自獨立**組裝、組裝結果經同一份
 * 純函式渲染，故字串全等係「同函式、同輸入」之直接結果，非重用同一次呼叫
 * 之結果（T5 複審 FW-A 綁定義務）。若任一路徑改為第二份模板或第二組樣
 * 式，兩者 HTML 即會分歧，`phase8-report-print.test.ts` 之 wire 斷言必紅。
 *
 * ---------------------------------------------------------------------------
 * 判定順序（§6.1 判定紀律②；AC-25 側信道守門）
 * ---------------------------------------------------------------------------
 * `requireAuth`（401）→ `requirePasswordChanged`（403）→ 申請存在性（404）
 * → `assertOwnershipOrAdmin`（403）→ 狀態守門（409，D11；**僅產生／列印兩
 * 端點**，見下）。**授權先於狀態**——他人之草稿與他人之已完成申請一律先以
 * 同一個 403 FORBIDDEN 收斂（逐字相同回應），不因狀態差異而洩漏他人申請是
 * 否為草稿。
 *
 * ---------------------------------------------------------------------------
 * 查詢／下載端點**不**另立狀態守門（§3.3／§3.4 pseudocode 逐字如此；與
 * AC-25 之產生／列印兩端點 409 CONFLICT 不同型；SPEC-REV-T9）
 * ---------------------------------------------------------------------------
 * 草稿申請之產生端點被拒絕（409），故草稿**恆無** `Report` 列（結構性不可
 * 達）。查詢端點對此天然回 `200 { report: null }`（D10 之既定行為，與是否
 * 為草稿無關）；下載端點對此天然回 `404 NOT_FOUND`（B-27「尚未產生報表即
 * 下載」，與 B-01/B-02 之產生端點 409/403 為不同情境）。兩端點皆**不**因
 * `application.status` 而拒絕，理由：`Report` 列的存在本身即結構性蘊含申請
 * 曾為 `COMPLETED`（唯一寫入路徑 `generateReport` 已守門），狀態守門只會是
 * 恆真的重複判斷，故依 §3.3／§3.4 之流程字面不實作。
 *
 * 【PHASE-009-T12b 修訂】下載端點自本次起**確有**讀取 `application.status`
 * ——但它**不是守門**，而是 AC-21(b) 之**內容選擇**（`VOIDED` 且有
 * `VoidedReportFile` → 回作廢版位元組）。狀態碼語意逐字不變：`VOIDED` 之下
 * 載仍為 200（§16 D4(b1)；AC-23 回歸格「下載 → 200」）。查詢端點維持零狀態
 * 讀取。
 *
 * ---------------------------------------------------------------------------
 * `REPORT_GENERATION_FAILED`（500）——經 `AppError` 承載
 * （PHASE-009-T18／AC-40(b)，§16 D14(b)）
 * ---------------------------------------------------------------------------
 * 【歷史沿革】T8 撰寫本節時 `platform/errors.ts` 之 `ErrorCode` 聯集尚未收
 * 錄此碼（屬 T11 之 Files Allowed，非當時 Task 範圍），故當時改以
 * `buildErrorBody`（`code` 參數型別為 `string`）手動組出錯誤回應，繞過
 * `ErrorCode` 之編譯期收斂檢查。T11（`51cc459`）已將此碼落地收錄，繞道之
 * 唯一理由自此消失——**PHASE-009-T18 依 §16 D14(b) 改回經 `AppError` 承
 * 載**：本檔捕捉 `report-service.ts` 之 `ReportGenerationError` 後拋出
 * `AppError("REPORT_GENERATION_FAILED", 500, …, undefined, { stage })`，由
 * error-handler 之 `AppError` 分支以**同一個 `buildErrorBody`** 組出回應。
 * 故 wire 格式（`{ error: { code, message, requestId, details:{ stage } } }`）
 * 與繞道時期**逐位元組相同**（`phase8-contract.test.ts` §D-6 之 AC-40(b) 回
 * 歸釘住鍵集、鍵序與值；§A 之結構斷言釘住「不得回退為繞道」）。回應
 * `details` 仍僅含 `{ stage }`，日誌仍僅含 `{ stage, applicationId }`——皆
 * 不含原始錯誤訊息（T7-FW2①）。
 *
 * 併記（範圍界線）：`applications/routes.ts` 之作廢版 PDF 同型 500 轉譯
 * （PHASE-009-T12a，沿本檔舊形狀複製）**不在** T18 之 Files Allowed，本次
 * 維持 `buildErrorBody` 繞道形狀；兩處 wire 輸出仍完全一致，僅實作形狀分歧
 * （已交審記錄）。
 *
 * ---------------------------------------------------------------------------
 * B-28：storage 檔案遺失 → 404 不 500，錯誤日誌不含 storage key
 * ---------------------------------------------------------------------------
 * `report-storage.get(storageKey)` 之例外一律轉為 `404 NOT_FOUND`（沿
 * `report-service.ts` 檔頭「結構性地不持有，而非持有後嘗試清洗」紀律）；
 * `request.log.error` 之物件參數僅含 `{ applicationId }`，**刻意不含**
 * `err`（`LocalVolumeStorage` 之錯誤訊息逐字含 storage key，見
 * `report-service.ts` 同型說明），亦不含任何原始錯誤訊息。
 */
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { assertOwnershipOrAdmin, requireAuth, requirePasswordChanged } from "../auth/middleware.js";
import { AppError } from "../platform/errors.js";
import type { Storage } from "../storage/index.js";
import { type ReportMeta, buildReportData, reportApplicationInclude } from "./report-data.js";
import { renderReportHtml } from "./report-html.js";
import { embedImages } from "./report-images.js";
import {
  type GeneratedReportRow,
  ReportGenerationError,
  buildReportContentDisposition,
  findReportByApplicationId,
  generateReport,
  streamToBuffer,
} from "./report-service.js";

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

interface ReportsPluginOptions {
  prisma: PrismaClient;
  /** 附件 storage 實例（`att` 前綴）——供 `embedImages` 讀取證明圖片。 */
  attachmentStorage: Storage;
  /** 報表 storage 實例（`rpt` 前綴）——PDF 位元組之保存與讀回校驗。 */
  reportStorage: Storage;
  imageMaxPx: number;
  pdfTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// §7.2 ReportDto 組裝（本 Task 之產生端點回應形狀；AC-27 之完整鍵集封閉斷
// 言屬 T4＋T9，此處先依 §7.2 逐字組出六鍵）
// ---------------------------------------------------------------------------

function toReportDto(applicationId: string, row: GeneratedReportRow) {
  return {
    reportNumber: row.reportNumber,
    generatedAt: row.generatedAt.toISOString(),
    fileName: row.fileName,
    byteSize: row.byteSize,
    downloadUrl: `/applications/${applicationId}/report/pdf`,
    printUrl: `/applications/${applicationId}/report/print`,
  };
}

// ---------------------------------------------------------------------------
// Reports plugin
// ---------------------------------------------------------------------------

export const reportsPlugin: FastifyPluginAsync<ReportsPluginOptions> = async (
  fastify: FastifyInstance,
  options: ReportsPluginOptions
) => {
  const { prisma, attachmentStorage, reportStorage, imageMaxPx, pdfTimeoutMs } = options;

  // -------------------------------------------------------------------------
  // POST /applications/:id/report — 產生正式報表（冪等）
  // §3.1／§9.1；AC-04／AC-05／AC-06／AC-07／AC-10。
  // -------------------------------------------------------------------------

  fastify.post(
    "/applications/:id/report",
    { preHandler: [requireAuth(prisma), requirePasswordChanged] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const actor = request.currentUser;

      const application = await prisma.application.findUnique({
        where: { id },
        select: { id: true, ownerId: true, status: true },
      });
      if (!application) {
        throw new AppError("NOT_FOUND", 404, "找不到指定的申請");
      }

      // 判定紀律②：授權先於狀態（AC-25 側信道守門）。D9(a)：擁有人或管理員。
      assertOwnershipOrAdmin(actor, application.ownerId);

      // D11：草稿一律拒絕（409 CONFLICT + details.status）。
      if (application.status !== "COMPLETED") {
        throw new AppError("CONFLICT", 409, "僅已完成之申請可產生正式報表", undefined, {
          status: application.status,
        });
      }

      const log = {
        error: (obj: Record<string, unknown>, msg: string) => request.log.error(obj, msg),
      };

      try {
        const outcome = await generateReport(
          { prisma, attachmentStorage, reportStorage, imageMaxPx, pdfTimeoutMs, log },
          id,
          actor.id
        );
        return reply
          .status(outcome.created ? 201 : 200)
          .send({ report: toReportDto(id, outcome.report) });
      } catch (err) {
        if (err instanceof ReportGenerationError) {
          // 僅記 stage + applicationId，不含原始錯誤訊息（見檔頭說明）。
          request.log.error({ stage: err.stage, applicationId: id }, "Report generation failed");
          // 【PHASE-009-T18／AC-40(b)】改經 `AppError` 承載（見檔頭）。
          throw new AppError(
            "REPORT_GENERATION_FAILED",
            500,
            "報表產生失敗，請稍後再試或聯絡管理員。",
            undefined,
            { stage: err.stage }
          );
        }
        throw err;
      }
    }
  );

  // -------------------------------------------------------------------------
  // GET /applications/:id/report — 查詢報表資訊（PHASE-008-T9）
  // §3.4／D10(a)；AC-24（查詢列）／AC-27（DTO 側）。
  // 尚未產生 → 200 { report: null }（**非 404**，D10 之定案）；不做狀態守
  // 門（見檔頭說明）。
  // -------------------------------------------------------------------------

  fastify.get(
    "/applications/:id/report",
    { preHandler: [requireAuth(prisma), requirePasswordChanged] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const actor = request.currentUser;

      const application = await prisma.application.findUnique({
        where: { id },
        select: { id: true, ownerId: true },
      });
      if (!application) {
        throw new AppError("NOT_FOUND", 404, "找不到指定的申請");
      }
      assertOwnershipOrAdmin(actor, application.ownerId);

      const report = await findReportByApplicationId(prisma, id);
      return reply.status(200).send({ report: report ? toReportDto(id, report) : null });
    }
  );

  // -------------------------------------------------------------------------
  // GET /applications/:id/report/pdf — 下載正式 PDF（PHASE-008-T9）
  // §3.3／§9.3；AC-08（重下一致 ＋ 渲染器零呼叫）／AC-22（Content-
  // Disposition 雙形式）／AC-23（檔名凍結）／AC-24（下載列）。
  // PHASE-009-T12b：AC-21(b)(d)（作廢後回作廢版位元組、編號不變、重複下載
  // 全等且零渲染；§16 D4(b1)）。
  // 一律回傳**已保存**之位元組（零渲染、零寫入）；Report 不存在 → 404
  // （B-27）；storage 檔遺失 → 404 不 500（B-28，見檔頭說明）。
  // -------------------------------------------------------------------------

  fastify.get(
    "/applications/:id/report/pdf",
    { preHandler: [requireAuth(prisma), requirePasswordChanged] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const actor = request.currentUser;

      const application = await prisma.application.findUnique({
        where: { id },
        select: { id: true, ownerId: true, status: true },
      });
      if (!application) {
        throw new AppError("NOT_FOUND", 404, "找不到指定的申請");
      }
      assertOwnershipOrAdmin(actor, application.ownerId);

      const report = await findReportByApplicationId(prisma, id);
      if (!report) {
        throw new AppError("NOT_FOUND", 404, "尚未產生正式報表");
      }

      // PHASE-009-T12b／AC-21(b)(d)（§16 D4(b1)）：已作廢且作廢版已落地 → 回
      // **作廢版**位元組；否則回原檔。兩條分支皆為**純讀取**（零渲染、零寫
      // 入），AC-08 之「下載期間渲染器零呼叫、重複下載位元組全等」紀律於作廢
      // 後仍逐字成立。關聯查詢（非 `report.id`）：`findReportByApplicationId`
      // 之回傳型別 `StoredReportRow` 不含 `id`，而 `VoidedReportFile.reportId`
      // 為唯一鍵，故以關聯過濾取至多一列，等價且不需擴充該型別。
      const voidedFile =
        application.status === "VOIDED"
          ? await prisma.voidedReportFile.findFirst({
              where: { report: { applicationId: id } },
              select: { storageKey: true, fileName: true },
            })
          : null;

      // fallback（T12a 即審 AR-1／FW-3，大總管 2026-08-07 裁量）：`VOIDED` 但
      // 無 `VoidedReportFile`（D4(b1) 之同交易語意下結構性不可達；僅理論競態
      // 窗或歷史資料可達）→ 回**原檔**。回原檔是 BE-US-27⑤「保留原始內容」之
      // 安全預設，遠優於 404／500。
      const source = voidedFile ?? report;

      let bytes: Buffer;
      try {
        const raw = await reportStorage.get(source.storageKey);
        bytes = Buffer.isBuffer(raw) ? raw : await streamToBuffer(raw);
      } catch {
        // B-28：storage 檔遺失（或讀取失敗）→ 404 不 500；日誌僅含
        // applicationId，不含 err（storage key 逐字含於錯誤訊息，見檔頭）。
        request.log.error({ applicationId: id }, "Report PDF file missing from storage");
        throw new AppError("NOT_FOUND", 404, "報表檔案遺失");
      }

      // AC-21(b)「報表編號不變」：ASCII fallback 檔名恆取自 `report.
      // reportNumber`（作廢不產生新編號）；RFC 5987 檔名取自 `source.fileName`
      // ——`VoidedReportFile.fileName` 依 §8.2 恆等於原 `Report.fileName`，故
      // 標頭作廢前後逐字不變。**不得**改用 `storageKey`（其後綴為 `void`，非
      // 檔名；T12a 即審 FW-1）。
      const disposition = buildReportContentDisposition(report.reportNumber, source.fileName);
      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", disposition)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(bytes);
    }
  );

  // -------------------------------------------------------------------------
  // GET /applications/:id/report/print — 列印版 HTML（PHASE-008-T10）
  // §3.2／§9.2；AC-11（已產生時含編號）／AC-15（與持久化 PDF 同一版型，見
  // 檔頭）／AC-16(c)（安全標頭）／AC-24（列印列）／AC-25（草稿 409）。
  // 唯讀路徑：絕不寫入任何資料列、絕不寫入任何檔案（§9.2 明文）。
  // -------------------------------------------------------------------------

  fastify.get(
    "/applications/:id/report/print",
    { preHandler: [requireAuth(prisma), requirePasswordChanged] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const actor = request.currentUser;

      const application = await prisma.application.findUnique({
        where: { id },
        select: { id: true, ownerId: true, status: true },
      });
      if (!application) {
        throw new AppError("NOT_FOUND", 404, "找不到指定的申請");
      }

      // 判定紀律②：授權先於狀態（AC-25 側信道守門）。
      assertOwnershipOrAdmin(actor, application.ownerId);

      // D11／AC-25（SPEC-REV-T9）＋【PHASE-009-T13／AC-22（§16 D5）】：狀態守
      // 門由 `COMPLETED` 單值放行為 **`COMPLETED ∪ VOIDED`**——FE-US-23⑤「報表
      // 已作廢 → 開啟列印版 → 顯示明確作廢標示及作廢原因」之前提。草稿仍一律
      // 409 CONFLICT + details.status（既有語意逐字不變；草稿無快照、無金額，
      // 列印版會呈現半成品或觸發 required() 拋錯，D5(c)）。
      //
      // **白名單而非黑名單**（刻意）：不寫成 `!== "DRAFT"`。二者在今日之三值
      // `ApplicationStatus` 上行為等價，但黑名單會使**未來新增之狀態**預設被
      // 放行；白名單則預設拒絕。此形式由 `phase8-report-print.test.ts` §K4 之
      // 原始碼字面斷言守門。
      //
      // 產生端點（上方）之守門**不**放行 VOIDED（B-27／D13：已作廢申請不得產
      // 生新報表），故兩端點之字面刻意不同。
      //
      // 訊息**逐字不變**（surgical）：本分支自本次起僅對 `DRAFT` 觸發，而
      // 「僅已完成之申請可檢視列印版」對草稿使用者仍是正確且可行動的指引；
      // 已作廢者永不再看到此訊息。改寫訊息會使草稿之 409 回應含「已作廢」字
      // 樣（§K1-d 之零洩漏掃描實測攔截），無益反增噪。
      if (application.status !== "COMPLETED" && application.status !== "VOIDED") {
        throw new AppError("CONFLICT", 409, "僅已完成之申請可檢視列印版", undefined, {
          status: application.status,
        });
      }

      // §9.2：組裝與 §9.1 (2)(3)(4)d 同一份實作——buildReportData（讀快照，
      // 零重算）→ embedImages（附件降尺寸內嵌）→ renderReportHtml（純函
      // 式，與持久化 PDF 同一函式，見檔頭 AC-15）。已產生報表時以持久化之
      // reportNumber／generatedAt 為 meta 輸入（與 report-service.ts 之
      // withReportMeta 同構）；尚未產生時 meta 為 null（AC-11「已產生
      // 時」，列印版仍可預覽）。
      const fullApplication = await prisma.application.findUniqueOrThrow({
        where: { id },
        include: reportApplicationInclude,
      });
      const existingReport = await findReportByApplicationId(prisma, id);
      const meta: ReportMeta | null = existingReport
        ? { reportNumber: existingReport.reportNumber, generatedAt: existingReport.generatedAt }
        : null;

      const rawData = await buildReportData(prisma, fullApplication, meta);
      const data = await embedImages(attachmentStorage, rawData, imageMaxPx, {
        error: (obj: Record<string, unknown>, msg: string) => request.log.error(obj, msg),
      });
      const html = renderReportHtml(data);

      // AC-16(c)：四個安全標頭逐字在場（CSP 移除任一部分之 mutant 必紅）。
      return reply
        .header("Content-Type", "text/html; charset=utf-8")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header(
          "Content-Security-Policy",
          "default-src 'none'; img-src data:; style-src 'unsafe-inline'"
        )
        .send(html);
    }
  );
};
