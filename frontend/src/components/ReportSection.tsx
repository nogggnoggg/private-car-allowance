/**
 * ReportSection — PHASE-008-T12（AC-30／AC-31；元件形狀一次到位含 AC-32）
 * T13 補：AC-33 Permission denied 態（`permission-denied` LoadState，403
 * FORBIDDEN → 無權限訊息，刻意不提供重試鈕，見 load 內註解）＋保養／折舊頁
 * 接線（pages/MaintenanceApplicationPage.tsx、pages/DepreciationApplicationPage.tsx）。
 *
 * 供三型申請詳情頁掛載的共用報表區塊。
 *
 * `status !== "COMPLETED"` 時**整個區塊不渲染**（回傳 `null`，非 disabled 按
 * 鈕）——guard 內建於元件本身而非交由每個呼叫端各自判斷，理由：
 *   (a) 避免三頁各自重寫一次同樣的條件判斷（DRY，三型共用同一元件）；
 *   (b) 「前端不渲染從不是授權或狀態依據」（Spec §4 註）——後端仍獨立守門
 *       （AC-25），本檢查僅為 UX 呈現層。
 * 掛載即觸發 `GET /applications/:id/report`（§3.4）決定 Empty／Success；
 * 點擊「產生正式報表」呼叫 `POST .../report`（§3.1，冪等）。
 */

import type React from "react";
import { useCallback, useEffect, useState } from "react";
import type { ApplicationStatusDto } from "../api/applications.js";
import { toFrontendUrl } from "../api/attachments.js";
import { type ReportDto, apiGenerateReport, apiGetReport } from "../api/reports.js";
import type { ApiError } from "../types/api.js";

interface Props {
  applicationId: string;
  status: ApplicationStatusDto;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "load-error"; message: string }
  | { kind: "permission-denied"; message: string }
  | { kind: "loaded"; report: ReportDto | null };

export default function ReportSection({ applicationId, status }: Props): React.ReactElement | null {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadState({ kind: "loading" });
    try {
      const { report } = await apiGetReport(applicationId);
      setLoadState({ kind: "loaded", report });
    } catch (err) {
      const apiErr = err as ApiError;
      // AC-33 Permission denied：403 FORBIDDEN 顯示無權限訊息且不提供重試
      // （重試即後續請求，牴觸「零後續請求」——見 load-error 態之通用重試
      // 鈕，此態刻意不沿用）。
      if (apiErr.code === "FORBIDDEN") {
        setLoadState({ kind: "permission-denied", message: "無權存取此申請之報表。" });
        return;
      }
      setLoadState({
        kind: "load-error",
        message: apiErr.message ?? "讀取報表資訊失敗，請稍後再試。",
      });
    }
  }, [applicationId]);

  useEffect(() => {
    if (status !== "COMPLETED") return;
    load();
  }, [status, load]);

  // AC-30：`status !== "COMPLETED"` 時整個區塊不渲染（負向斷言：本函式回傳
  // null，元件連 heading 都不掛載——見上方 useEffect 亦不觸發任何 fetch）。
  if (status !== "COMPLETED") return null;

  async function handleGenerate() {
    if (generating) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const { report } = await apiGenerateReport(applicationId);
      setLoadState({ kind: "loaded", report });
    } catch (err) {
      const apiErr = err as ApiError;
      // AC-31：僅顯示錯誤訊息＋重試，不外洩 details.stage 等內部細節。
      setGenerateError(apiErr.message ?? "報表產生失敗，請稍後再試。");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section aria-labelledby="report-heading">
      <h2 id="report-heading">報表</h2>

      {loadState.kind === "loading" && <p>讀取報表資訊中…</p>}

      {loadState.kind === "load-error" && (
        <div className="error-block" role="alert">
          <p>{loadState.message}</p>
          <button type="button" className="btn btn-secondary" onClick={load}>
            重試
          </button>
        </div>
      )}

      {loadState.kind === "permission-denied" && (
        <div className="permission-denied-block" role="alert">
          <p>{loadState.message}</p>
        </div>
      )}

      {loadState.kind === "loaded" && loadState.report === null && (
        <div className="empty-block">
          <p>尚未產生正式報表</p>
          {generateError ? (
            <div className="error-block" role="alert">
              <p>{generateError}</p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleGenerate}
                disabled={generating}
              >
                重試
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleGenerate}
              disabled={generating}
            >
              {generating ? "產生中…" : "產生正式報表"}
            </button>
          )}
        </div>
      )}

      {loadState.kind === "loaded" && loadState.report !== null && (
        <dl className="detail-list">
          <dt>報表編號</dt>
          <dd>{loadState.report.reportNumber}</dd>
          <dt>產生時間</dt>
          <dd>{loadState.report.generatedAt}</dd>
          <dt>檔案</dt>
          <dd>
            <a
              href={toFrontendUrl(loadState.report.printUrl)}
              target="_blank"
              rel="noreferrer noopener"
              className="btn btn-secondary btn-sm"
            >
              檢視列印版
            </a>{" "}
            <a
              href={toFrontendUrl(loadState.report.downloadUrl)}
              className="btn btn-secondary btn-sm"
            >
              下載 PDF
            </a>
          </dd>
        </dl>
      )}
    </section>
  );
}
