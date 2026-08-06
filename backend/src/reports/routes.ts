/**
 * 報表路由 — PHASE-008-T8（BE-US-26／27）
 *
 * 本 Task 僅落地 `POST /applications/:id/report`（產生，冪等）——`GET
 * /applications/:id/report`（查詢）、`GET .../report/print`（列印版）、
 * `GET .../report/pdf`（下載）為 T9／T10 之範圍（Spec §15 Task Graph），本
 * 檔預留供該二 Task 於同一 plugin 內擴充。
 *
 * Spec `docs/specs/PHASE-008.md` §7.1（端點總表）、§7.2（`ReportDto`）、
 * §7.5（錯誤合約）、§6.1（授權矩陣，判定紀律①②）、§16 D9(a)（管理員可代
 * 產生）、D11（草稿 409 CONFLICT）。
 *
 * ---------------------------------------------------------------------------
 * 判定順序（§6.1 判定紀律②；AC-25 側信道守門）
 * ---------------------------------------------------------------------------
 * `requireAuth`（401）→ `requirePasswordChanged`（403）→ 申請存在性（404）
 * → `assertOwnershipOrAdmin`（403）→ 狀態守門（409，D11）。**授權先於狀
 * 態**——他人之草稿與他人之已完成申請一律先以同一個 403 FORBIDDEN 收斂
 * （逐字相同回應），不因狀態差異而洩漏他人申請是否為草稿。
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
 */
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { assertOwnershipOrAdmin, requireAuth, requirePasswordChanged } from "../auth/middleware.js";
import { AppError, buildErrorBody } from "../platform/errors.js";
import type { Storage } from "../storage/index.js";
import {
  type GeneratedReportRow,
  ReportGenerationError,
  generateReport,
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
};
