/**
 * 報表路由 — PHASE-008-T8／T9（BE-US-26／27／28）
 *
 * T8 落地 `POST /applications/:id/report`（產生，冪等）。**本檔（T9）新增**
 * `GET /applications/:id/report`（查詢）與 `GET .../report/pdf`（下載）；
 * `GET .../report/print`（列印版）為 T10 之範圍（Spec §15 Task Graph），本
 * 檔預留供該 Task 於同一 plugin 內擴充。
 *
 * Spec `docs/specs/PHASE-008.md` §7.1（端點總表）、§7.2（`ReportDto`）、
 * §7.5（錯誤合約）、§6.1（授權矩陣，判定紀律①②）、§16 D7(a)+(i)（安全檔名
 * 規則 ＋ 產生時持久化）、D9(a)（管理員可代產生／存取）、D10(a)（查詢為獨
 * 立端點，未產生回 `200 { report: null }`）、D11（草稿 409 CONFLICT，僅適
 * 用產生／列印，見下）。
 *
 * ---------------------------------------------------------------------------
 * 判定順序（§6.1 判定紀律②；AC-25 側信道守門）
 * ---------------------------------------------------------------------------
 * `requireAuth`（401）→ `requirePasswordChanged`（403）→ 申請存在性（404）
 * → `assertOwnershipOrAdmin`（403）→ 狀態守門（409，D11；**僅產生端點**，
 * 見下）。**授權先於狀態**——他人之草稿與他人之已完成申請一律先以同一個
 * 403 FORBIDDEN 收斂（逐字相同回應），不因狀態差異而洩漏他人申請是否為草
 * 稿。
 *
 * ---------------------------------------------------------------------------
 * 查詢／下載端點**不**另立狀態守門（§3.3／§3.4 pseudocode 逐字如此；與
 * AC-25 之產生端點 409 CONFLICT 不同型）
 * ---------------------------------------------------------------------------
 * 草稿申請之產生端點被拒絕（409），故草稿**恆無** `Report` 列（結構性不可
 * 達）。查詢端點對此天然回 `200 { report: null }`（D10 之既定行為，與是否
 * 為草稿無關）；下載端點對此天然回 `404 NOT_FOUND`（B-27「尚未產生報表即
 * 下載」，與 B-01/B-02 之產生端點 409/403 為不同情境）。兩端點皆**不**額
 * 外查詢 `application.status`，理由：`Report` 列的存在本身即結構性蘊含
 * `COMPLETED`（唯一寫入路徑 `generateReport` 已守門），額外的狀態檢查只會
 * 是恆真的重複判斷，故依 §3.3／§3.4 之流程字面不實作。
 *
 * ---------------------------------------------------------------------------
 * `REPORT_GENERATION_FAILED`（500）——不經 `AppError`（見 report-service.ts
 * 檔頭「錯誤碼與日誌安全」）
 * ---------------------------------------------------------------------------
 * `platform/errors.ts` 之 `ErrorCode` 聯集尚未收錄此碼（T11 之 Files
 * Allowed，非本 Task 範圍）。本檔改為捕捉 `report-service.ts` 之
 * `ReportGenerationError`，以既有 `buildErrorBody`（`code` 參數型別為
 * `string`）手動組出與其餘端點同形狀之錯誤回應——wire 格式（`{ error: {
 * code, message, requestId, details } }`）與經由 `AppError` 產生者完全一
 * 致，僅是繞過 `ErrorCode` 之編譯期收斂檢查（該檢查於 T11 落地後即涵蓋此
 * 碼，屆時本檔可原樣沿用不需修改）。回應 `details` 僅含 `{ stage }`，日誌
 * 僅含 `{ stage, applicationId }`——皆不含原始錯誤訊息（T7-FW2①）。
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
import { AppError, buildErrorBody } from "../platform/errors.js";
import type { Storage } from "../storage/index.js";
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
          const requestId = String(request.id);
          // 僅記 stage + applicationId，不含原始錯誤訊息（見檔頭說明）。
          request.log.error({ stage: err.stage, applicationId: id }, "Report generation failed");
          return reply
            .status(500)
            .send(
              buildErrorBody(
                "REPORT_GENERATION_FAILED",
                "報表產生失敗，請稍後再試或聯絡管理員。",
                requestId,
                undefined,
                { stage: err.stage }
              )
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
  // 一律回傳原保存位元組（零渲染）；Report 不存在 → 404（B-27）；storage
  // 檔遺失 → 404 不 500（B-28，見檔頭說明）。
  // -------------------------------------------------------------------------

  fastify.get(
    "/applications/:id/report/pdf",
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
      if (!report) {
        throw new AppError("NOT_FOUND", 404, "尚未產生正式報表");
      }

      let bytes: Buffer;
      try {
        const raw = await reportStorage.get(report.storageKey);
        bytes = Buffer.isBuffer(raw) ? raw : await streamToBuffer(raw);
      } catch {
        // B-28：storage 檔遺失（或讀取失敗）→ 404 不 500；日誌僅含
        // applicationId，不含 err（storage key 逐字含於錯誤訊息，見檔頭）。
        request.log.error({ applicationId: id }, "Report PDF file missing from storage");
        throw new AppError("NOT_FOUND", 404, "報表檔案遺失");
      }

      const disposition = buildReportContentDisposition(report.reportNumber, report.fileName);
      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", disposition)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(bytes);
    }
  );
};
