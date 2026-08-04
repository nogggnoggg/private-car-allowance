/**
 * MaintenanceApplicationPage — PHASE-006-T11
 *
 * Routes: `/applications/maintenance/new`（建立草稿後導向 `:id`）、
 * `/applications/maintenance/:id`（草稿編輯 / 已完成檢視）。
 *
 * 涵蓋 AC-34（五欄表單）、AC-35（預覽四值）、AC-37（表單/預覽兩處五態）之
 * 部分。**不含**保養證明附件上傳/刪除 UI（T12 範圍，見 Packet Files
 * Forbidden 說明）——完成鈕之停用邏輯已可運作（依 `completionBlockers`／
 * `computed.blockingCodes` 判斷），僅上傳區塊留待 T12。
 *
 * 硬性約束落地重點（比照 TravelApplicationPage.tsx 既有模式）：
 *   - §11.3 不自算鑑別：本頁從不自行計算 `intervalKm`／`officialKm`／
 *     `ratioPercent`／`amount`。草稿/預覽金額一律來自
 *     `POST /applications/maintenance/preview`（`computed`）；已完成金額
 *     一律來自 `snapshot`。
 *   - AC-35：`computed===null`（五欄未齊）為 Empty（非錯誤）；
 *     `computed.calculable===false` 時顯示「無法計算」＋blockingCodes 對應
 *     zh-TW 說明，絕不顯示金額 `0`；`OFFICIAL_KM_EXCEEDS_INTERVAL` 出現時
 *     額外停用「完成申請」鈕。
 *   - D8：預覽為 debounce 300ms 呼叫的獨立 stateless 端點。
 *   - AC-02：整份 PUT 三態語意——五欄一律逐一送出（未填 → `null`），
 *     故「僅填部分欄位」仍可成功儲存。
 *   - C4（沿用既有慣例）：完成／刪除草稿皆需二次確認對話框；表單存在未
 *     儲存變更時，完成確認框顯示「有未儲存的變更，請先儲存草稿」
 *     （PHASE-005a T14 已批行為）。
 */

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiDeleteApplication } from "../api/applications.js";
import {
  type MaintenanceApplicationDto,
  type MaintenanceComputedDto,
  type MaintenanceDraftFields,
  apiCompleteMaintenanceApplication,
  apiCreateMaintenanceDraft,
  apiGetMaintenanceDraft,
  apiPreviewMaintenance,
  apiUpdateMaintenanceDraft,
} from "../api/maintenance.js";
import type { ApiError } from "../types/api.js";

const PREVIEW_DEBOUNCE_MS = 300; // D8

/**
 * §7.4 十一碼中，預覽端點（`computeMaintenanceComputed`）只可能回傳第
 * 1~9、11 項（第 10 項「保養證明」需要附件計數，預覽不查）——見
 * `backend/src/applications/maintenance-service.ts` 之
 * `buildFieldsIncompleteResult`／`computeMaintenanceComputed` 文件註解。
 * 本表逐字對應後端 `maintenance-blockers.ts` 之訊息文案（純代碼→固定字串
 * 查表，不含任何金額/比例計算，§11.3 不自算鑑別）。
 */
const BLOCKING_CODE_MESSAGES: Record<string, string> = {
  LAST_MAINTENANCE_DATE_REQUIRED: "請填寫上次保養日期",
  CURRENT_MAINTENANCE_DATE_REQUIRED: "請填寫本次保養日期",
  MAINTENANCE_DATE_ORDER_INVALID: "本次保養日期必須晚於上次保養日期",
  LAST_ODOMETER_REQUIRED: "請填寫上次里程表數值",
  CURRENT_ODOMETER_REQUIRED: "請填寫本次里程表數值",
  ODOMETER_ORDER_INVALID: "本次里程表數值必須大於上次里程表數值",
  ACTUAL_COST_REQUIRED: "請填寫本次實際保養費用",
  ACTUAL_COST_INVALID: "本次實際保養費用必須大於 0",
  OFFICIAL_KM_EXCEEDS_INTERVAL: "期間公務里程大於保養區間里程，請檢查差旅、日期或里程資料",
  AMOUNT_OUT_OF_RANGE: "計算結果超出可儲存之金額範圍，請檢查里程與費用",
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
  | { kind: "ready"; data: MaintenanceComputedDto }
  | { kind: "error"; message: string };

interface FormFields {
  lastMaintenanceDate: string;
  currentMaintenanceDate: string;
  lastOdometerKm: string;
  currentOdometerKm: string;
  actualCost: string;
}

const EMPTY_FORM: FormFields = {
  lastMaintenanceDate: "",
  currentMaintenanceDate: "",
  lastOdometerKm: "",
  currentOdometerKm: "",
  actualCost: "",
};

function toFormFields(app: MaintenanceApplicationDto): FormFields {
  return {
    lastMaintenanceDate: app.lastMaintenanceDate ?? "",
    currentMaintenanceDate: app.currentMaintenanceDate ?? "",
    lastOdometerKm: app.lastOdometerKm ?? "",
    currentOdometerKm: app.currentOdometerKm ?? "",
    actualCost: app.actualCost ?? "",
  };
}

function buildRequestBody(form: FormFields): MaintenanceDraftFields {
  return {
    lastMaintenanceDate: form.lastMaintenanceDate.trim() === "" ? null : form.lastMaintenanceDate,
    currentMaintenanceDate:
      form.currentMaintenanceDate.trim() === "" ? null : form.currentMaintenanceDate,
    lastOdometerKm: form.lastOdometerKm.trim() === "" ? null : form.lastOdometerKm,
    currentOdometerKm: form.currentOdometerKm.trim() === "" ? null : form.currentOdometerKm,
    actualCost: form.actualCost.trim() === "" ? null : form.actualCost,
  };
}

function isFormEntirelyBlank(form: FormFields): boolean {
  return (
    form.lastMaintenanceDate.trim() === "" &&
    form.currentMaintenanceDate.trim() === "" &&
    form.lastOdometerKm.trim() === "" &&
    form.currentOdometerKm.trim() === "" &&
    form.actualCost.trim() === ""
  );
}

export default function MaintenanceApplicationPage(): React.ReactElement {
  const { id: routeId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [pageState, setPageState] = useState<PageState>(
    routeId === "new" ? { kind: "creating" } : { kind: "loading" }
  );
  const [application, setApplication] = useState<MaintenanceApplicationDto | null>(null);

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

  const createdRef = useRef(false);

  const loadApplication = useCallback(async (targetId: string) => {
    setPageState({ kind: "loading" });
    try {
      const { application: app } = await apiGetMaintenanceDraft(targetId);
      setApplication(app);
      setForm(toFormFields(app));
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
          const { application: app } = await apiCreateMaintenanceDraft({});
          navigate(`/applications/maintenance/${app.id}`, { replace: true });
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

  // ---- 未儲存變更離開頁面前提示（沿用 TravelApplicationPage 既有慣例）----
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
      apiPreviewMaintenance(buildRequestBody(form))
        .then(({ preview }) => setPreviewState({ kind: "ready", data: preview }))
        .catch((err: ApiError) => {
          setPreviewState({ kind: "error", message: err.message ?? "預覽失敗，請稍後再試。" });
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [form, pageState.kind, application]);

  function updateField(field: keyof FormFields, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setDirty(true);
  }

  // ---- Save（整份 PUT，AC-02 三態語意：五欄逐一送出）----
  async function handleSave() {
    if (!application || saving) return;
    setSaving(true);
    setSaveError(null);
    setSaveFieldErrors({});
    setSaveSuccess(null);
    try {
      const { application: updated } = await apiUpdateMaintenanceDraft(
        application.id,
        buildRequestBody(form)
      );
      setApplication(updated);
      setForm(toFormFields(updated));
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
      const { application: completed } = await apiCompleteMaintenanceApplication(application.id);
      setApplication(completed);
      setForm(toFormFields(completed));
      setShowCompleteConfirm(false);
      setDirty(false);
    } catch (err) {
      const apiErr = err as ApiError;
      const details = apiErr.details as { blockers?: { message: string }[] } | undefined;
      if (apiErr.code === "VALIDATION_ERROR" && details?.blockers && details.blockers.length > 0) {
        setCompleteError(details.blockers.map((b) => b.message).join("；"));
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
          <h1>保養費用申請（已完成）</h1>
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

          <section aria-labelledby="maintenance-info-heading">
            <h2 id="maintenance-info-heading">基本資料</h2>
            <dl className="detail-list">
              <dt>上次保養日期</dt>
              <dd>{application.lastMaintenanceDate ?? "—"}</dd>
              <dt>本次保養日期</dt>
              <dd>{application.currentMaintenanceDate ?? "—"}</dd>
              <dt>上次里程表</dt>
              <dd>{application.lastOdometerKm ?? "—"}</dd>
              <dt>本次里程表</dt>
              <dd>{application.currentOdometerKm ?? "—"}</dd>
              <dt>本次實際保養費用</dt>
              <dd>{application.actualCost ?? "—"}</dd>
            </dl>
          </section>

          {/* 已完成申請的快照 — 唯一顯示分攤金額的權威來源 */}
          {snapshot && (
            <section aria-labelledby="snapshot-heading">
              <h2 id="snapshot-heading">計算依據（完成時快照）</h2>
              <dl className="detail-list">
                <dt>保養區間總里程</dt>
                <dd>{snapshot.intervalKm}</dd>
                <dt>期間公務里程</dt>
                <dd>{snapshot.officialKm}</dd>
                <dt>公務使用比例</dt>
                <dd>{snapshot.ratioPercent}%</dd>
                <dt>公司分攤金額</dt>
                <dd>{snapshot.totalAmount}</dd>
                <dt>計算時間</dt>
                <dd>{new Date(snapshot.calculatedAt).toLocaleString("zh-TW")}</dd>
              </dl>
            </section>
          )}
        </main>
      </div>
    );
  }

  // ---- DRAFT：編輯表單 ----
  const preview = previewState.kind === "ready" ? previewState.data : null;
  const previewBlockingCodes = preview?.blockingCodes ?? [];
  const savedBlockingCodes = application.completionBlockers?.map((b) => b.code) ?? [];
  const officialKmExceeded =
    previewBlockingCodes.includes("OFFICIAL_KM_EXCEEDS_INTERVAL") ||
    savedBlockingCodes.includes("OFFICIAL_KM_EXCEEDS_INTERVAL");
  const formBlank = isFormEntirelyBlank(form);

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>保養費用申請（草稿）</h1>
        <div className="header-actions">
          <Link to="/" className="btn btn-secondary">
            返回列表
          </Link>
        </div>
      </header>

      <main className="page-main">
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

        <section aria-labelledby="maintenance-form-heading">
          <h2 id="maintenance-form-heading">保養資料</h2>
          <div className="form-group">
            <label htmlFor="last-maintenance-date">上次保養日期</label>
            <input
              id="last-maintenance-date"
              type="date"
              value={form.lastMaintenanceDate}
              onChange={(e) => updateField("lastMaintenanceDate", e.target.value)}
              disabled={saving}
              aria-describedby={
                saveFieldErrors.lastMaintenanceDate ? "last-maintenance-date-err" : undefined
              }
            />
            {saveFieldErrors.lastMaintenanceDate && (
              <span id="last-maintenance-date-err" className="field-error" role="alert">
                {saveFieldErrors.lastMaintenanceDate}
              </span>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="current-maintenance-date">本次保養日期</label>
            <input
              id="current-maintenance-date"
              type="date"
              value={form.currentMaintenanceDate}
              onChange={(e) => updateField("currentMaintenanceDate", e.target.value)}
              disabled={saving}
              aria-describedby={
                saveFieldErrors.currentMaintenanceDate ? "current-maintenance-date-err" : undefined
              }
            />
            {saveFieldErrors.currentMaintenanceDate && (
              <span id="current-maintenance-date-err" className="field-error" role="alert">
                {saveFieldErrors.currentMaintenanceDate}
              </span>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="last-odometer-km">上次里程表</label>
            <input
              id="last-odometer-km"
              type="number"
              step="0.01"
              value={form.lastOdometerKm}
              onChange={(e) => updateField("lastOdometerKm", e.target.value)}
              disabled={saving}
              aria-describedby={saveFieldErrors.lastOdometerKm ? "last-odometer-km-err" : undefined}
            />
            {saveFieldErrors.lastOdometerKm && (
              <span id="last-odometer-km-err" className="field-error" role="alert">
                {saveFieldErrors.lastOdometerKm}
              </span>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="current-odometer-km">本次里程表</label>
            <input
              id="current-odometer-km"
              type="number"
              step="0.01"
              value={form.currentOdometerKm}
              onChange={(e) => updateField("currentOdometerKm", e.target.value)}
              disabled={saving}
              aria-describedby={
                saveFieldErrors.currentOdometerKm ? "current-odometer-km-err" : undefined
              }
            />
            {saveFieldErrors.currentOdometerKm && (
              <span id="current-odometer-km-err" className="field-error" role="alert">
                {saveFieldErrors.currentOdometerKm}
              </span>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="actual-cost">本次實際保養費用</label>
            <input
              id="actual-cost"
              type="number"
              step="0.01"
              value={form.actualCost}
              onChange={(e) => updateField("actualCost", e.target.value)}
              disabled={saving}
              aria-describedby={saveFieldErrors.actualCost ? "actual-cost-err" : undefined}
            />
            {saveFieldErrors.actualCost && (
              <span id="actual-cost-err" className="field-error" role="alert">
                {saveFieldErrors.actualCost}
              </span>
            )}
          </div>
        </section>

        <section aria-labelledby="preview-heading">
          <h2 id="preview-heading">分攤預覽（試算，後端計算）</h2>
          <div aria-live="polite">
            {formBlank ? (
              <p>請先填寫上次／本次保養日期與里程表</p>
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
                    // AC-35：不可計算狀態不得顯示金額 0，須顯示「無法計算」＋
                    // 可行動之 zh-TW 說明。
                    <div className="warn-text">
                      <p>
                        <strong>公司分攤金額：無法計算</strong>
                      </p>
                      {blockingCodeMessages(preview.blockingCodes).map((msg) => (
                        <p key={msg}>{msg}</p>
                      ))}
                    </div>
                  ) : (
                    <dl className="detail-list">
                      <dt>保養區間總里程</dt>
                      <dd>{preview.intervalKm}</dd>
                      <dt>期間公務里程</dt>
                      <dd>{preview.officialKm}</dd>
                      <dt>公務使用比例</dt>
                      <dd>{preview.ratioPercent}%</dd>
                      <dt>公司分攤金額</dt>
                      <dd>{preview.amount}</dd>
                    </dl>
                  ))}
              </>
            )}
          </div>
        </section>

        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "儲存中…" : "儲存草稿"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowCompleteConfirm(true)}
            disabled={saving || completing || officialKmExceeded}
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
