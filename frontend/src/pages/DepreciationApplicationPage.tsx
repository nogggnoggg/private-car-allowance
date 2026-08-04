/**
 * DepreciationApplicationPage — PHASE-007-T13／T14
 *
 * Routes: `/applications/depreciation/new`（建立草稿後導向 `:id`）、
 * `/applications/depreciation/:id`（草稿編輯 / 已完成檢視）。
 *
 * 涵蓋 AC-38（表單僅提供申請年度一項可輸入欄位；年度公務里程無任何可輸入／
 * 覆寫欄位）、AC-39（預覽顯示折舊每公里單價／年度公務里程／取整後金額，
 * 三推導值——車價／折舊年限／預估年度行駛公里數——絕不出現；前端零自算，
 * 一律取自後端回應）、AC-40（五態：Loading／Empty／Error／Success／
 * Permission denied；不可計算時不顯示金額 `0`，一律以 `blockingCodes`
 * 驅動顯示）、AC-41（該年度無有效折舊參數時顯示聯絡管理員文案並停用
 * 「完成申請」，但不阻擋草稿儲存）、AC-42（同年度重複申請提醒但不阻擋；
 * 折舊證明上傳／預覽／刪除——草稿階段；已完成申請無任何上傳／刪除入口之
 * 負向斷言）。
 *
 * T14 新增（折舊證明，沿用既有 `AttachmentUploader`，PHASE-003／006 同型）：
 *   - 上傳/刪除為即時 API 呼叫；關聯至本申請透過下一次「儲存草稿」PUT 之
 *     `attachmentIds[]` 宣告式全集對帳。B-22／T8 即審 FW-11 裁定 A：
 *     `attachmentIds` 送出前以 `Set` 去重（後端重複 id 觸發 409 且整筆
 *     回滾，前端去重使其不可達，同 006 T12 AR-3 同型）。
 *   - `completionBlockers` 含 `DEPRECIATION_ATTACHMENT_REQUIRED` 時已由既有
 *     `hasBlockers`（任一 blocker 即停用）涵蓋，無需額外判斷。
 *   - COMPLETED 檢視僅呈現唯讀縮圖清單，不掛載 `AttachmentUploader`（負向
 *     斷言：無任何上傳/刪除入口；T8 即審 FW-13：完成後附件讀取仍 200，
 *     AC-42「無上傳/刪除入口」為前端義務，後端不擋讀取）。
 *   - 重複年度提醒（AC-42 前半）：`duplicateYearNotice.count > 0` 時顯示
 *     提醒文字，但不停用任何操作（US 定稿「顯示提醒但允許繼續」）。
 *
 * 硬性約束落地重點（比照 MaintenanceApplicationPage.tsx 既有模式）：
 *   - §11.3／AC-39 不自算鑑別：本頁從不自行計算 `officialKm`／
 *     `perKmUnitPrice`／`rawAmount`／`amount`。草稿/預覽金額一律來自
 *     `POST /applications/depreciation/preview`（`computed`）；已完成金額
 *     一律來自 `snapshot`。
 *   - FW-5／B-02（T4 三裁定②）：`applicationYear` 於 wire 上僅收 JSON
 *     number｜null——`<input type="number">` 之字串值送出前須轉為
 *     `number`，空字串轉為 `null`。
 *   - D8：預覽為 debounce 300ms 呼叫的獨立 stateless 端點。
 *   - AC-41：`completionBlockers` 含 `PARAMETER_NOT_AVAILABLE` 時停用
 *     「完成申請」鈕並顯示聯絡管理員文案；不影響「儲存草稿」鈕。
 *   - C4（沿用既有慣例）：完成／刪除草稿皆需二次確認對話框；表單存在未
 *     儲存變更時，完成確認框顯示「有未儲存的變更，請先儲存草稿」
 *     （PHASE-005a T14 已批行為）。
 */

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiDeleteApplication } from "../api/applications.js";
import { type AttachmentDto, toFrontendUrl } from "../api/attachments.js";
import {
  type DepreciationApplicationDto,
  type DepreciationComputedDto,
  type DepreciationDraftFields,
  type DepreciationUpdateFields,
  apiCompleteDepreciationApplication,
  apiCreateDepreciationDraft,
  apiGetDepreciationDraft,
  apiPreviewDepreciation,
  apiUpdateDepreciationDraft,
} from "../api/depreciation.js";
import AttachmentUploader from "../components/AttachmentUploader.js";
import type { ApiError } from "../types/api.js";

const PREVIEW_DEBOUNCE_MS = 300; // D8

/** AC-42／§3.3：折舊證明上限 5 張（後端為權威來源，本常數僅供前端提示文案/UI）。 */
const DEPRECIATION_ATTACHMENT_LIMIT = 5;

/**
 * §7.5 完成阻擋碼（blocker codes）固定文案——逐字對應後端
 * `depreciation-blockers.ts` 之訊息文案（純代碼→固定字串查表，不含任何
 * 金額/里程計算，§11.3 不自算鑑別）。
 */
const BLOCKING_CODE_MESSAGES: Record<string, string> = {
  YEAR_REQUIRED: "請選擇申請年度",
  DEPRECIATION_ATTACHMENT_REQUIRED: "請至少上傳 1 張折舊證明",
  PARAMETER_NOT_AVAILABLE: "該年度尚無有效折舊參數，請聯絡管理員設定",
  AMOUNT_OUT_OF_RANGE: "計算結果超出可儲存之金額範圍，請聯絡管理員檢查折舊參數",
};

function blockingCodeMessages(codes: string[]): string[] {
  return codes.map((code) => BLOCKING_CODE_MESSAGES[code] ?? code);
}

type PageState =
  | { kind: "loading" }
  | { kind: "creating" }
  | { kind: "error"; message: string }
  | { kind: "permission-denied" }
  | { kind: "not-found" }
  | { kind: "ready" };

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: DepreciationComputedDto }
  | { kind: "error"; message: string };

interface FormFields {
  applicationYear: string; // <input type="number"> 之受控字串值
}

const EMPTY_FORM: FormFields = { applicationYear: "" };

function toFormFields(app: DepreciationApplicationDto): FormFields {
  return { applicationYear: app.applicationYear === null ? "" : String(app.applicationYear) };
}

/**
 * FW-5／B-02：`applicationYear` 僅收 JSON number｜null。空字串→`null`；
 * 其餘一律以 `Number()` 轉換後送出（含非整數/非數字之無效輸入——留給後端
 * `parseApplicationYearField` 判定並回 400 `fields[]`，本函式不重複驗證）。
 */
function buildPreviewRequestBody(form: FormFields): DepreciationDraftFields {
  const trimmed = form.applicationYear.trim();
  return { applicationYear: trimmed === "" ? null : Number(trimmed) };
}

function isFormEntirelyBlank(form: FormFields): boolean {
  return form.applicationYear.trim() === "";
}

/**
 * PUT 儲存用 body——申請年度同 `buildPreviewRequestBody` ＋ `attachmentIds`
 * 宣告式全集。B-22／T8 即審 FW-11 裁定 A：`attachmentIds` 送出前以 `Set`
 * 去重，避免觸發後端「附件已關聯」409（該訊息對使用者具誤導性，前端去重
 * 使其不可達；同 006 T12 AR-3 同型）。
 */
function buildSaveRequestBody(
  form: FormFields,
  attachments: AttachmentDto[]
): DepreciationUpdateFields {
  return {
    ...buildPreviewRequestBody(form),
    attachmentIds: Array.from(new Set(attachments.map((a) => a.id))),
  };
}

export default function DepreciationApplicationPage(): React.ReactElement {
  const { id: routeId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [pageState, setPageState] = useState<PageState>(
    routeId === "new" ? { kind: "creating" } : { kind: "loading" }
  );
  const [application, setApplication] = useState<DepreciationApplicationDto | null>(null);

  const [form, setForm] = useState<FormFields>(EMPTY_FORM);
  const [dirty, setDirty] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveFieldErrors, setSaveFieldErrors] = useState<Record<string, string>>({});
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);

  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const [previewState, setPreviewState] = useState<PreviewState>({ kind: "idle" });

  const [attachments, setAttachments] = useState<AttachmentDto[]>([]);

  const createdRef = useRef(false);

  const loadApplication = useCallback(async (targetId: string) => {
    setPageState({ kind: "loading" });
    try {
      const { application: app } = await apiGetDepreciationDraft(targetId);
      setApplication(app);
      setForm(toFormFields(app));
      setAttachments(app.attachments);
      setDirty(false);
      setSaveSuccess(null);
      setPageState({ kind: "ready" });
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "NOT_FOUND") {
        setPageState({ kind: "not-found" });
      } else if (apiErr.code === "FORBIDDEN" || apiErr.code === "UNAUTHORIZED") {
        setPageState({ kind: "permission-denied" });
      } else {
        setPageState({ kind: "error", message: apiErr.message ?? "載入失敗，請稍後重試。" });
      }
    }
  }, []);

  // ---- "new" → create then redirect; otherwise load existing ----
  useEffect(() => {
    if (routeId === "new") {
      if (createdRef.current) return;
      createdRef.current = true;
      (async () => {
        try {
          const { application: app } = await apiCreateDepreciationDraft({});
          navigate(`/applications/depreciation/${app.id}`, { replace: true });
        } catch (err) {
          const apiErr = err as ApiError;
          setPageState({ kind: "error", message: apiErr.message ?? "建立草稿失敗，請稍後重試。" });
        }
      })();
      return;
    }
    if (routeId) {
      loadApplication(routeId);
    }
  }, [routeId, navigate, loadApplication]);

  // ---- 未儲存變更離開頁面前提示（沿用既有頁面慣例）----
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // ---- D8: debounced stateless preview (300ms) ----
  useEffect(() => {
    if (pageState.kind !== "ready" || !application || application.status !== "DRAFT") return;
    setPreviewState({ kind: "loading" });
    const handle = setTimeout(() => {
      apiPreviewDepreciation(buildPreviewRequestBody(form))
        .then(({ preview }) => setPreviewState({ kind: "ready", data: preview }))
        .catch((err: ApiError) => {
          setPreviewState({ kind: "error", message: err.message ?? "預覽失敗，請稍後再試。" });
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [form, pageState.kind, application]);

  function updateApplicationYear(value: string) {
    setForm({ applicationYear: value });
    setDirty(true);
  }

  // AC-42：附件上傳/刪除為即時 API 呼叫（同 MaintenanceApplicationPage 既有
  // 慣例），但關聯至本申請仍待下一次「儲存草稿」之 PUT attachmentIds 對帳；
  // 故本地清單變動視為未儲存變更（dirty=true），與其他表單欄位一致。
  function updateAttachments(next: AttachmentDto[]) {
    setAttachments(next);
    setDirty(true);
  }

  // ---- Save（整份 PUT）----
  async function handleSave() {
    if (!application || saving) return;
    setSaving(true);
    setSaveError(null);
    setSaveFieldErrors({});
    setSaveSuccess(null);
    try {
      const { application: updated } = await apiUpdateDepreciationDraft(
        application.id,
        buildSaveRequestBody(form, attachments)
      );
      setApplication(updated);
      setForm(toFormFields(updated));
      setAttachments(updated.attachments);
      setDirty(false);
      setSaveSuccess("草稿已儲存。");
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "VALIDATION_ERROR" && apiErr.fields && apiErr.fields.length > 0) {
        const fe: Record<string, string> = {};
        for (const f of apiErr.fields) fe[f.field] = f.reason;
        setSaveFieldErrors(fe);
        setSaveError(apiErr.message ?? "輸入資料有誤，請檢查標示欄位。");
      } else if (apiErr.code === "FORBIDDEN") {
        setSaveError("已完成的申請不可修改，請建立修正版。");
      } else {
        setSaveError(apiErr.message ?? "儲存失敗，請稍後再試。");
      }
    } finally {
      setSaving(false);
    }
  }

  // ---- Complete（不可逆，需確認）----
  async function handleComplete() {
    if (!application || completing) return;
    setCompleting(true);
    setCompleteError(null);
    try {
      const { application: completed } = await apiCompleteDepreciationApplication(application.id);
      setApplication(completed);
      setForm(toFormFields(completed));
      setShowCompleteConfirm(false);
      setDirty(false);
    } catch (err) {
      const apiErr = err as ApiError;
      const details = apiErr.details as { blockers?: { message: string }[] } | undefined;
      if (apiErr.code === "VALIDATION_ERROR" && details?.blockers && details.blockers.length > 0) {
        setCompleteError(details.blockers.map((b) => b.message).join("；"));
      } else if (apiErr.code === "PARAMETER_NOT_AVAILABLE") {
        setCompleteError(apiErr.message ?? "該年度尚無有效折舊參數，請聯絡管理員設定。");
      } else if (apiErr.code === "FORBIDDEN") {
        setCompleteError("無權完成此申請，或此申請已完成。");
      } else {
        setCompleteError(apiErr.message ?? "完成失敗，請稍後再試。");
      }
    } finally {
      setCompleting(false);
    }
  }

  // ---- Delete draft（不可逆，需確認）----
  async function handleDeleteDraft() {
    if (!application || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiDeleteApplication(application.id);
      navigate("/", { replace: true });
    } catch (err) {
      const apiErr = err as ApiError;
      setDeleteError(apiErr.message ?? "刪除失敗，請稍後再試。");
      setDeleting(false);
    }
  }

  // ===========================================================================
  // Render — 五態
  // ===========================================================================

  if (pageState.kind === "loading" || pageState.kind === "creating") {
    return (
      <div className="page-container">
        <div className="loading-block" aria-busy="true">
          <span className="spinner" aria-label="載入中" />
          <p>{pageState.kind === "creating" ? "建立草稿中…" : "讀取草稿中…"}</p>
        </div>
      </div>
    );
  }

  if (pageState.kind === "permission-denied") {
    return (
      <div className="page-container">
        <div className="permission-denied-block" role="alert">
          <h2>無權存取此資源</h2>
          <p>您沒有權限檢視或編輯這筆申請。</p>
          <Link to="/" className="btn btn-secondary">
            返回列表
          </Link>
        </div>
      </div>
    );
  }

  if (pageState.kind === "not-found") {
    return (
      <div className="page-container">
        <div className="error-block" role="alert">
          <p>找不到指定的申請。</p>
        </div>
        <Link to="/" className="btn btn-secondary">
          返回列表
        </Link>
      </div>
    );
  }

  if (pageState.kind === "error") {
    return (
      <div className="page-container">
        <div className="error-block" role="alert">
          <p>{pageState.message}</p>
          {routeId && routeId !== "new" && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => loadApplication(routeId)}
            >
              重試
            </button>
          )}
        </div>
        <Link to="/" className="btn btn-secondary">
          返回列表
        </Link>
      </div>
    );
  }

  if (!application) {
    // Unreachable in practice (pageState.kind === "ready" implies application is set).
    return (
      <div className="page-container">
        <div className="error-block" role="alert">
          <p>發生未預期的錯誤。</p>
        </div>
      </div>
    );
  }

  // ---- COMPLETED：唯讀檢視 ----
  if (application.status === "COMPLETED") {
    const snapshot = application.snapshot;
    return (
      <div className="page-container">
        <header className="page-header">
          <h1>年度折舊補貼申請（已完成）</h1>
          <div className="header-actions">
            <Link to="/" className="btn btn-secondary">
              返回列表
            </Link>
          </div>
        </header>
        <main className="page-main">
          <div className="success-block">
            此申請已完成，資料已鎖定不可修改。如需異動，請聯絡管理員建立修正版（功能將於後續版本提供）。
          </div>

          <section aria-labelledby="depreciation-info-heading">
            <h2 id="depreciation-info-heading">基本資料</h2>
            <dl className="detail-list">
              <dt>申請年度</dt>
              <dd>{application.applicationYear ?? "—"}</dd>
            </dl>
          </section>

          {/* 已完成申請的快照 — 唯一顯示補貼金額的權威來源。B-12：rawAmount
              （取整前）與 totalAmount（取整後、實際核發）同屏並列時須以文案
              區分兩者用途，避免使用者誤解為金額不一致。 */}
          {snapshot && (
            <section aria-labelledby="snapshot-heading">
              <h2 id="snapshot-heading">計算依據（完成時快照）</h2>
              <dl className="detail-list">
                <dt>年度公務里程</dt>
                <dd>{snapshot.officialKm} 公里</dd>
                <dt>折舊每公里補助單價</dt>
                <dd>{snapshot.perKmUnitPrice}</dd>
                <dt>四捨五入前金額（僅供對照，非實際核發金額）</dt>
                <dd>{snapshot.rawAmount}</dd>
                <dt>年度補貼金額（四捨五入後，實際核發）</dt>
                <dd>{snapshot.totalAmount}</dd>
                <dt>計算時間</dt>
                <dd>{new Date(snapshot.calculatedAt).toLocaleString("zh-TW")}</dd>
              </dl>
            </section>
          )}

          {/* AC-42 負向斷言：已完成之折舊申請不得出現任何上傳／刪除入口——
              僅呈現唯讀縮圖清單（比照 MaintenanceApplicationPage COMPLETED
              分支既有慣例），不掛載 AttachmentUploader。T8 即審 FW-13：完成
              後附件讀取仍 200，此為前端義務，非後端擋讀取。 */}
          <section aria-labelledby="depreciation-attachments-heading">
            <h2 id="depreciation-attachments-heading">折舊證明</h2>
            {application.attachments.length > 0 ? (
              <ul className="attachment-list" aria-label="折舊證明清單">
                {application.attachments.map((att) => (
                  <li key={att.id} className="attachment-item">
                    <img
                      src={toFrontendUrl(att.previewUrl)}
                      alt={att.originalFilename}
                      className="attachment-thumb"
                      width={64}
                      height={64}
                    />
                    <span className="attachment-filename">{att.originalFilename}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>尚無證明</p>
            )}
          </section>
        </main>
      </div>
    );
  }

  // ---- DRAFT：編輯表單 ----
  const preview = previewState.kind === "ready" ? previewState.data : null;
  const savedBlockingCodes = application.completionBlockers?.map((b) => b.code) ?? [];
  const parameterMissing = savedBlockingCodes.includes("PARAMETER_NOT_AVAILABLE");
  const formBlank = isFormEntirelyBlank(form);
  const hasBlockers = (application.completionBlockers?.length ?? 0) > 0;

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>年度折舊補貼申請（草稿）</h1>
        <div className="header-actions">
          <Link to="/" className="btn btn-secondary">
            返回列表
          </Link>
        </div>
      </header>

      <main className="page-main">
        {/* AC-42 前半（FE-US-17 第 4 條）：同年度已有其他申請時顯示提醒，
            但不阻擋建立與完成——僅提示，不停用任何按鈕。 */}
        {application.duplicateYearNotice && application.duplicateYearNotice.count > 0 && (
          <output className="warn-text">
            <p>
              提醒：您在西元 {application.applicationYear} 年度已有{" "}
              {application.duplicateYearNotice.count} 筆其他折舊補貼申請
              {application.duplicateYearNotice.hasCompleted ? "（含已完成之申請）" : ""}
              ，仍可繼續建立與完成本筆申請。
            </p>
          </output>
        )}

        {application.completionBlockers && application.completionBlockers.length > 0 && (
          <div className="warn-text" aria-live="polite" aria-label="尚未完成項目">
            <p>尚未完成項目：</p>
            <ul>
              {application.completionBlockers.map((b, i) => (
                <li key={`${b.code}-${i}`}>{b.message}</li>
              ))}
            </ul>
          </div>
        )}

        {/* AC-41：缺參數之獨立聯絡管理員文案（即使上方清單已含同一則訊息，
            仍額外以醒目提示呈現，避免使用者略過清單）。 */}
        {parameterMissing && (
          <div className="warn-text" role="alert">
            <p>該年度尚無有效折舊參數，請聯絡管理員設定折舊參數後再完成申請。草稿仍可正常儲存。</p>
          </div>
        )}

        {saveError && (
          <div className="error-block" role="alert">
            {saveError}
          </div>
        )}
        {saveSuccess && <output className="success-block">{saveSuccess}</output>}
        {completeError && (
          <div className="error-block" role="alert">
            {completeError}
          </div>
        )}
        {deleteError && (
          <div className="error-block" role="alert">
            {deleteError}
          </div>
        )}

        <section aria-labelledby="depreciation-form-heading">
          <h2 id="depreciation-form-heading">折舊資料</h2>
          {/* AC-38：表單僅提供「申請年度」一項可輸入欄位——年度公務里程為
              後端唯讀計算值，畫面上不存在任何可輸入／覆寫該值之欄位。 */}
          <div className="form-group">
            <label htmlFor="application-year">申請年度</label>
            <input
              id="application-year"
              type="number"
              step="1"
              value={form.applicationYear}
              onChange={(e) => updateApplicationYear(e.target.value)}
              disabled={saving}
              aria-describedby={
                saveFieldErrors.applicationYear ? "application-year-err" : undefined
              }
            />
            {saveFieldErrors.applicationYear && (
              <span id="application-year-err" className="field-error" role="alert">
                {saveFieldErrors.applicationYear}
              </span>
            )}
          </div>
        </section>

        <section aria-labelledby="preview-heading">
          <h2 id="preview-heading">補貼預覽（試算，後端計算）</h2>
          <div aria-live="polite">
            {formBlank ? (
              <p>請先選擇申請年度</p>
            ) : (
              <>
                {previewState.kind === "loading" && <p>計算中…</p>}
                {previewState.kind === "error" && (
                  <p className="field-error" role="alert">
                    {previewState.message}
                  </p>
                )}
                {preview &&
                  (!preview.calculable ? (
                    // AC-39/41：不可計算狀態不得顯示金額 0，須顯示「無法計算」＋
                    // 可行動之 zh-TW 說明；三推導值（車價／折舊年限／預估年度
                    // 行駛公里數）在任何狀態下皆不出現於本頁——後端 DTO 本即
                    // 不回傳這三值，此處無從顯示。
                    <div className="warn-text">
                      <p>
                        <strong>年度補貼金額：無法計算</strong>
                      </p>
                      {blockingCodeMessages(preview.blockingCodes).map((msg) => (
                        <p key={msg}>{msg}</p>
                      ))}
                    </div>
                  ) : (
                    <>
                      <dl className="detail-list">
                        <dt>年度公務里程</dt>
                        <dd>{preview.officialKm} 公里</dd>
                        <dt>折舊每公里補助單價</dt>
                        <dd>{preview.perKmUnitPrice}</dd>
                        <dt>年度補貼金額</dt>
                        <dd>{preview.amount}</dd>
                      </dl>
                      {/* SF-3／Spec §4 Empty 列：calculable=true 但 amount=0 時非
                          錯誤、非空白頁，須額外說明「為何是 0」＋「仍可完成」，
                          金額本身不改帶「元」（全站既有慣例，§18 記勘誤）。 */}
                      {preview.amount === 0 && (
                        <p>該年度尚無已完成之差旅公務里程，補貼金額為 0；申請仍可完成。</p>
                      )}
                    </>
                  ))}
              </>
            )}
          </div>
        </section>

        <section aria-labelledby="depreciation-attachments-heading">
          <h2 id="depreciation-attachments-heading">折舊證明</h2>
          {/* AC-42：上傳/刪除即時呼叫既有 AttachmentUploader（PHASE-003）；
              key 隨 application.updatedAt 變動以便儲存成功後以後端回應之
              attachments 重新初始化子元件內部狀態（AttachmentUploader 為
              initialAttachments-驅動的非受控元件，比照 006 T12 既有慣例）。 */}
          <AttachmentUploader
            key={`att-${application.updatedAt}`}
            refType="DEPRECIATION"
            refId={application.id}
            limit={DEPRECIATION_ATTACHMENT_LIMIT}
            initialAttachments={attachments}
            onListChange={updateAttachments}
            emptyMessage="尚無證明"
          />
        </section>

        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "儲存中…" : "儲存草稿"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowCompleteConfirm(true)}
            disabled={saving || completing || hasBlockers}
          >
            完成申請
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={saving || deleting}
          >
            刪除草稿
          </button>
        </div>
      </main>

      {/* ---- 確認對話框 ---- */}

      {showCompleteConfirm && (
        <div className="dialog-overlay">
          <dialog open className="dialog-box" aria-label="確認完成申請">
            <h3>確認完成申請</h3>
            {dirty ? (
              <p className="warn-text">有未儲存的變更，請先儲存草稿</p>
            ) : (
              <>
                <p>完成後將無法修改，且無法復原。確定要完成這筆申請嗎？</p>
                {completeError && (
                  <div className="error-block" role="alert">
                    {completeError}
                  </div>
                )}
              </>
            )}
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleComplete}
                disabled={completing || dirty}
              >
                {completing ? "處理中…" : "確認完成"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowCompleteConfirm(false)}
                disabled={completing}
              >
                取消
              </button>
            </div>
          </dialog>
        </div>
      )}

      {showDeleteConfirm && (
        <div className="dialog-overlay">
          <dialog open className="dialog-box" aria-label="確認刪除草稿">
            <h3>確認刪除草稿</h3>
            <p>刪除後將無法復原。確定要刪除這筆草稿嗎？</p>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleDeleteDraft}
                disabled={deleting}
              >
                {deleting ? "刪除中…" : "確認刪除"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
              >
                取消
              </button>
            </div>
          </dialog>
        </div>
      )}
    </div>
  );
}
