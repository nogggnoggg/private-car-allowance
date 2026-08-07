/**
 * MaintenanceApplicationPage — PHASE-006-T11／T12
 *
 * Routes: `/applications/maintenance/new`（建立草稿後導向 `:id`）、
 * `/applications/maintenance/:id`（草稿編輯 / 已完成檢視）。
 *
 * 涵蓋 AC-34（五欄表單）、AC-35（預覽四值）、AC-36（保養證明上傳/刪除、
 * 完成前缺證明停用完成鈕、COMPLETED 無上傳/刪除入口）、AC-37（表單/預覽/
 * 證明三處五態）。
 *
 * T12 新增（保養證明，沿用既有 `AttachmentUploader`，PHASE-003）：
 *   - 上傳/刪除為即時 API 呼叫；關聯至本申請透過下一次「儲存草稿」PUT 之
 *     `attachmentIds[]` 宣告式全集對帳（`reconcileMaintenanceAttachments`，
 *     T6），AR-3：送出前以 `Set` 去重。
 *   - `completionBlockers` 含 `MAINTENANCE_ATTACHMENT_REQUIRED` 時停用
 *     「完成申請」鈕（AC-36 明文；調整自 T11 僅看 `officialKmExceeded`
 *     之設計，見 Packet New Risks 移交）。
 *   - COMPLETED 檢視僅呈現唯讀縮圖清單，不掛載 `AttachmentUploader`（負向
 *     斷言：無任何上傳/刪除入口）。
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
import {
  type RevisionLinkDto,
  type SupersedesLinkDto,
  apiCreateRevision,
  apiDeleteApplication,
} from "../api/applications.js";
import { type AttachmentDto, toFrontendUrl } from "../api/attachments.js";
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
import AttachmentUploader from "../components/AttachmentUploader.js";
import ReportSection from "../components/ReportSection.js";
import VoidApplicationDialog from "../components/VoidApplicationDialog.js";
import type { ApiError } from "../types/api.js";

const PREVIEW_DEBOUNCE_MS = 300; // D8

/** 本頁之詳情路由前綴——版本關聯之另一端恆為同型申請（AC-10：`type` 為複製欄）。 */
const DETAIL_BASE_PATH = "/applications/maintenance";

/**
 * AC-32(d)／FE-US-21④：已完成申請之附件區提示。逐字含「如需修正附件，請建立
 * 修正版」（Spec 給的是**含**字串，前綴為自擬文案）。僅 `COMPLETED` 顯示：
 * 已作廢申請不能再建修正版（後端 409，§7.5），顯示此提示等於指向死路。
 * 三型頁逐字相同（PHASE-009-T16）。
 */
const ATTACHMENT_REVISION_HINT = "已完成申請的附件無法直接刪除或替換。如需修正附件，請建立修正版。";

/**
 * AC-32(c)／D15 之「重複計入」提醒（`SPEC-REV-9T16` 補入 AC）。逐字文案於
 * Mock Gate 由人類目視定案；文案可微調，但三點語意（仍為已完成／未作廢則
 * 重複計入統計／作廢入口在本頁）不得縮減。三型頁逐字相同。
 */
const DUPLICATE_COUNT_WARNING =
  "本申請仍為已完成狀態。若未作廢，本申請與修正版將同時計入里程與金額統計；如需避免重複計入，請於本頁作廢本申請。";

/**
 * 版本關係區塊（PHASE-009-T16；AC-32(c)、AC-34 之 DOM 面）。與
 * `TravelApplicationPage.tsx`／`DepreciationApplicationPage.tsx` 同型——三頁
 * 各自持有一份（本 Phase 之 Files Allowed 為三頁 ＋ api client，不新建共用
 * 元件檔；共用化如有需要屬後續 Task）。詳細設計理由見 TravelApplicationPage
 * 同名函式之註解。
 */
function VersionRelationSection({
  supersedes,
  supersededBy,
}: {
  supersedes: SupersedesLinkDto | null;
  supersededBy: RevisionLinkDto | null;
}): React.ReactElement | null {
  if (!supersedes && !supersededBy) return null;
  return (
    <section aria-labelledby="version-relation-heading">
      <h2 id="version-relation-heading">版本關係</h2>
      {supersedes && (
        <p>
          <span>{`本申請為 ${supersedes.reportNumber ?? supersedes.primaryDate} 之修正版`}</span>{" "}
          <Link to={`${DETAIL_BASE_PATH}/${supersedes.id}`}>檢視原申請</Link>
        </p>
      )}
      {supersededBy && (
        <>
          <p>
            <span>已建立修正版</span>{" "}
            <Link to={`${DETAIL_BASE_PATH}/${supersededBy.id}`}>檢視修正版</Link>
          </p>
          {/* AC-32(c)／D15（`SPEC-REV-9T16`）：人類 Spec Gate 批准「不自動作廢」
              之**前提**即為本則前端強提示——建立修正版**不會**自動作廢原申請，
              未作廢時兩筆都會進統計。三點語意不可省：①仍為已完成 ②未作廢則
              重複計入里程與金額統計 ③作廢入口即在本頁（同頁下方之「作廢」鈕）。
              **僅 `supersededBy` 側**——作廢動作之落點在原申請頁，修正版頁加此
              提示會把使用者導向錯誤的那一筆。 */}
          <p className="warn-text">{DUPLICATE_COUNT_WARNING}</p>
        </>
      )}
    </section>
  );
}

/** AC-21：保養證明上限 5 張（後端為權威來源，本常數僅供前端提示文案/UI）。 */
const MAINTENANCE_ATTACHMENT_LIMIT = 5;

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

function buildPreviewRequestBody(form: FormFields): MaintenanceDraftFields {
  return {
    lastMaintenanceDate: form.lastMaintenanceDate.trim() === "" ? null : form.lastMaintenanceDate,
    currentMaintenanceDate:
      form.currentMaintenanceDate.trim() === "" ? null : form.currentMaintenanceDate,
    lastOdometerKm: form.lastOdometerKm.trim() === "" ? null : form.lastOdometerKm,
    currentOdometerKm: form.currentOdometerKm.trim() === "" ? null : form.currentOdometerKm,
    actualCost: form.actualCost.trim() === "" ? null : form.actualCost,
  };
}

/**
 * PUT 儲存用 body——五欄同 `buildPreviewRequestBody` ＋ `attachmentIds`
 * 宣告式全集。AR-3：`attachmentIds` 送出前以 `Set` 去重，避免觸發後端
 * 「附件已關聯」409（該訊息對使用者具誤導性，前端去重使其不可達）。
 */
function buildSaveRequestBody(
  form: FormFields,
  attachments: AttachmentDto[]
): MaintenanceDraftFields {
  return {
    ...buildPreviewRequestBody(form),
    attachmentIds: Array.from(new Set(attachments.map((a) => a.id))),
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

  const [attachments, setAttachments] = useState<AttachmentDto[]>([]);

  // PHASE-009-T15（AC-29(a)）：作廢確認對話框之開關；對話框本體與其五態
  // 皆由 VoidApplicationDialog 負責（T14），本頁只負責入口與作廢後之呈現。
  const [showVoidDialog, setShowVoidDialog] = useState(false);

  // PHASE-009-T16（AC-32(b)／AC-33）：建立修正版之送出中旗標與錯誤呈現。
  const [creatingRevision, setCreatingRevision] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [existingRevisionId, setExistingRevisionId] = useState<string | null>(null);

  const createdRef = useRef(false);

  const loadApplication = useCallback(async (targetId: string) => {
    setPageState({ kind: "loading" });
    try {
      const { application: app } = await apiGetMaintenanceDraft(targetId);
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
      apiPreviewMaintenance(buildPreviewRequestBody(form))
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

  // AC-36：附件上傳/刪除為即時 API 呼叫（同 SegmentAttachmentPanel/AttachmentUploader
  // 既有慣例），但關聯至本申請仍待下一次「儲存草稿」之 PUT attachmentIds 對帳；
  // 故本地清單變動視為未儲存變更（dirty=true），與其他表單欄位一致。
  function updateAttachments(next: AttachmentDto[]) {
    setAttachments(next);
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
      } else if (apiErr.code === "TOO_MANY_ATTACHMENTS") {
        setSaveError(apiErr.message ?? `保養證明最多 ${MAINTENANCE_ATTACHMENT_LIMIT} 張。`);
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

  // ---- Create revision（PHASE-009-T16；AC-32(a)(b)、AC-33 Success）----
  //
  // 錯誤呈現以 `apiErr.message` 為主（T7b 即審 AR-2）：本端點之 400 其
  // `fields[].field` 為 `"userId"`，對不到本頁任何輸入欄——逐欄標紅會靜默
  // 吞錯。409「已有修正版」另附 `details.existingRevisionId`。
  async function handleCreateRevision() {
    if (!application || creatingRevision) return;
    setCreatingRevision(true);
    setRevisionError(null);
    setExistingRevisionId(null);
    try {
      const { application: revision } = await apiCreateRevision<MaintenanceApplicationDto>(
        application.id
      );
      navigate(`${DETAIL_BASE_PATH}/${revision.id}`);
    } catch (err) {
      const apiErr = err as ApiError;
      const details = apiErr.details as { existingRevisionId?: string } | undefined;
      if (apiErr.code === "CONFLICT" && typeof details?.existingRevisionId === "string") {
        setExistingRevisionId(details.existingRevisionId);
      }
      setRevisionError(apiErr.message ?? "建立修正版失敗，請稍後再試。");
    } finally {
      setCreatingRevision(false);
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

  // ---- COMPLETED／VOIDED：唯讀檢視 ----
  //
  // PHASE-009-T15（AC-31(a)）**現況缺陷修復**：`VOIDED` 原本落到本分支之後的
  // 草稿分支，因而渲染出可編輯表單。已作廢與已完成之呈現需求幾乎相同（同一組
  // 唯讀欄位＋證明清單＋報表區），差異僅在標題／提示文案、作廢入口（僅
  // `COMPLETED` 有）與作廢資訊區塊（僅 `VOIDED` 有），故沿用同一唯讀分支並以
  // `voided` 分歧（比照 TravelApplicationPage 同型處置）。
  if (application.status === "COMPLETED" || application.status === "VOIDED") {
    const snapshot = application.snapshot;
    const voided = application.status === "VOIDED";
    const voidInfo = application.void;
    return (
      <div className="page-container">
        <header className="page-header">
          <h1>保養費用申請（{voided ? "已作廢" : "已完成"}）</h1>
          <div className="header-actions">
            <Link to="/" className="btn btn-secondary">
              返回列表
            </Link>
          </div>
        </header>
        <main className="page-main">
          {voided ? (
            // AC-31(c)／FE-US-26⑤：文案明示不可恢復，且本分支不提供任何
            // 恢復途徑（負向斷言：整頁零「恢復／還原／取消作廢」控制項）。
            <div className="warn-text">此申請已作廢，資料已鎖定不可修改，且無法恢復為已完成。</div>
          ) : (
            // PHASE-009-T16（AC-32(a)）：佔位文案「功能將於後續版本提供」逐字
            // 移除，改以本段導向真實入口（本頁下方之「建立修正版」按鈕）。
            <div className="success-block">
              此申請已完成，資料已鎖定不可修改。如需異動，請建立修正版。
            </div>
          )}

          {/* AC-32(c)：版本關係（雙向皆為 supersedesId 之投影；兩向皆 null
              時整區不渲染）。 */}
          <VersionRelationSection
            supersedes={application.supersedes}
            supersededBy={application.supersededBy}
          />

          {/* AC-30(c)：作廢原因／操作者／時間三項逐字呈現。時間格式沿用本頁
              既有「計算時間」之 `toLocaleString("zh-TW")`（不另立第二種格式）。
              AC-33 Empty：`void` 未作廢恆為 null（§7.2），故未作廢時整個區塊
              不渲染——條件必須是 `voidInfo` 而非 `voided`。 */}
          {voidInfo && (
            <section aria-labelledby="void-info-heading">
              <h2 id="void-info-heading">作廢資訊</h2>
              <dl className="detail-list">
                <dt>作廢原因</dt>
                <dd>{voidInfo.reason}</dd>
                <dt>作廢操作者</dt>
                <dd>{voidInfo.voidedByDisplayName}</dd>
                <dt>作廢時間</dt>
                <dd>{new Date(voidInfo.voidedAt).toLocaleString("zh-TW")}</dd>
              </dl>
            </section>
          )}

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

          {/* AC-36 負向斷言：已完成之保養申請不得出現任何上傳／刪除入口——
              僅呈現唯讀縮圖清單（比照 TravelApplicationPage COMPLETED 分支
              既有慣例），不掛載 AttachmentUploader。 */}
          <section aria-labelledby="maintenance-attachments-heading">
            <h2 id="maintenance-attachments-heading">保養證明</h2>
            {/* AC-32(d)／FE-US-21④：已作廢不顯示——見 ATTACHMENT_REVISION_HINT
                之註解。 */}
            {!voided && <p className="warn-text">{ATTACHMENT_REVISION_HINT}</p>}
            {application.attachments.length > 0 ? (
              <ul className="attachment-list" aria-label="保養證明清單">
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

          {/* AC-30（PHASE-008-T13）／AC-31(d)（PHASE-009-T14）：已完成與已作廢
              皆顯示報表區塊。`status` 逐字透傳——作廢成功後本頁 state 會換成
              後端回傳的 VOIDED DTO，此 prop 隨之變為 "VOIDED"，元件才會把下載
              入口文案改為「下載 PDF（作廢版）」（T14 即審 FW-1）。 */}
          <ReportSection applicationId={application.id} status={application.status} />

          {/* AC-29(a)／AC-32(a)：作廢與建立修正版兩入口僅在已完成申請出現；
              已作廢頁零這兩個按鈕（AC-31(b) 五類負向，T15 已固化）。 */}
          {!voided && (
            <>
              {revisionError && (
                <div className="error-block" role="alert">
                  <p>{revisionError}</p>
                  {existingRevisionId && (
                    <Link
                      to={`${DETAIL_BASE_PATH}/${existingRevisionId}`}
                      className="btn btn-secondary"
                    >
                      檢視既有修正版
                    </Link>
                  )}
                </div>
              )}
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleCreateRevision}
                  disabled={creatingRevision}
                >
                  {creatingRevision ? "建立中…" : "建立修正版"}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => setShowVoidDialog(true)}
                  disabled={creatingRevision}
                >
                  作廢
                </button>
              </div>
            </>
          )}
        </main>

        {showVoidDialog && (
          <VoidApplicationDialog
            applicationId={application.id}
            onCancel={() => setShowVoidDialog(false)}
            onVoided={(voidedApplication) => {
              // 後端回傳型別分派之詳情 DTO（§7.3）；本頁以自己的型別窄化。
              setApplication(voidedApplication as MaintenanceApplicationDto);
              setShowVoidDialog(false);
            }}
            onReload={() => {
              setShowVoidDialog(false);
              loadApplication(application.id);
            }}
          />
        )}
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
  // AC-36：完成前缺證明 → 完成鈕停用（依已儲存之 completionBlockers 判定；
  // 預覽端點不查附件計數，故不看 previewBlockingCodes——同檔頭文件註解）。
  const attachmentRequired = savedBlockingCodes.includes("MAINTENANCE_ATTACHMENT_REQUIRED");
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
        {/* AC-32(c)：修正版剛建立時狀態為 DRAFT，故草稿分支亦須呈現版本關係。 */}
        <VersionRelationSection
          supersedes={application.supersedes}
          supersededBy={application.supersededBy}
        />

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

        <section aria-labelledby="maintenance-attachments-heading">
          <h2 id="maintenance-attachments-heading">保養證明</h2>
          {/* AC-36：上傳/刪除即時呼叫既有 AttachmentUploader（PHASE-003）；
              key 隨 application.updatedAt 變動以便儲存成功後以後端回應之
              attachments 重新初始化子元件內部狀態（AttachmentUploader 為
              initialAttachments-驅動的非受控元件，比照既有慣例）。 */}
          <AttachmentUploader
            key={`att-${application.updatedAt}`}
            refType="MAINTENANCE"
            refId={application.id}
            limit={MAINTENANCE_ATTACHMENT_LIMIT}
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
            disabled={saving || completing || officialKmExceeded || attachmentRequired}
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
