/**
 * DepreciationApplicationPage — PHASE-007-T13／T14／R9（折舊模型修訂段）
 *
 * Routes: `/applications/depreciation/new`（建立草稿後導向 `:id`）、
 * `/applications/depreciation/:id`（草稿編輯 / 已完成檢視）。
 *
 * 涵蓋 AC-58（表單提供申請年度＋該車年度總里程兩項可輸入欄位；年度公務
 * 里程無任何可輸入／覆寫欄位之負向斷言**保留**；兩者標籤逐字互異）、
 * AC-59（預覽與完成後詳情顯示五值——每年折舊費用／年度公務里程／年度
 * 總里程／公務比例／補貼金額，逐字取自後端回應；前端零自算；車價／折舊
 * 年限／每公里補助單價三推導值絕不出現）、AC-40（五態：Loading／Empty／
 * Error／Success／Permission denied；不可計算時不顯示金額 `0`，一律以
 * `blockingCodes` 驅動顯示）、AC-41（該年度無有效折舊參數時顯示聯絡管理員
 * 文案並停用「完成申請」，但不阻擋草稿儲存）、AC-42（同年度重複申請提醒但
 * 不阻擋；折舊證明上傳／預覽／刪除——草稿階段；已完成申請無任何上傳／
 * 刪除入口之負向斷言）。
 *
 * T14 新增（折舊證明，沿用既有 `AttachmentUploader`，PHASE-003／006 同型）：
 *   - 上傳/刪除為即時 API 呼叫；關聯至本申請透過下一次「儲存草稿」PUT 之
 *     `attachmentIds[]` 宣告式全集對帳。B-22／T8 即審 FW-11 裁定 A：
 *     `attachmentIds` 送出前以 `Set` 去重（後端重複 id 觸發 409 且整筆
 *     回滾，前端去重使其不可達，同 006 T12 AR-3 同型）。
 *   - AC-54(b)（裁定②）：折舊證明改為選填，零附件之草稿可完成——
 *     `hasBlockers`（任一 blocker 即停用）之判斷邏輯零改動，僅後端 blocker
 *     碼聯集已退場 `DEPRECIATION_ATTACHMENT_REQUIRED`，故零附件不再產生
 *     該 blocker。
 *   - COMPLETED 檢視僅呈現唯讀縮圖清單，不掛載 `AttachmentUploader`（負向
 *     斷言：無任何上傳/刪除入口；T8 即審 FW-13：完成後附件讀取仍 200，
 *     AC-42「無上傳/刪除入口」為前端義務，後端不擋讀取）。
 *   - 重複年度提醒（AC-42 前半）：`duplicateYearNotice.count > 0` 時顯示
 *     提醒文字，但不停用任何操作（US 定稿「顯示提醒但允許繼續」）。
 *
 * 硬性約束落地重點（比照 MaintenanceApplicationPage.tsx 既有模式）：
 *   - §20.6／AC-59(b) 不自算鑑別：本頁從不自行計算 `officialKm`／
 *     `annualDepreciation`／`ratio`／`ratioPercent`／`rawAmount`／
 *     `amount`。草稿/預覽金額一律來自
 *     `POST /applications/depreciation/preview`（`computed`）；已完成金額
 *     一律來自 `snapshot`。
 *   - FW-5／B-02（T4 三裁定②）：`applicationYear` 於 wire 上僅收 JSON
 *     number｜null——`<input type="number">` 之字串值送出前須轉為
 *     `number`，空字串轉為 `null`。PHASE-007-R9：`annualTotalKm`（新欄）
 *     沿用同一 number wire 慣例（1dp）。
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
import {
  type RevisionLinkDto,
  type SupersedesLinkDto,
  apiCreateRevision,
  apiDeleteApplication,
} from "../api/applications.js";
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
import ReportSection from "../components/ReportSection.js";
import VoidApplicationDialog from "../components/VoidApplicationDialog.js";
import type { ApiError } from "../types/api.js";

const PREVIEW_DEBOUNCE_MS = 300; // D8

/** 本頁之詳情路由前綴——版本關聯之另一端恆為同型申請（AC-10：`type` 為複製欄）。 */
const DETAIL_BASE_PATH = "/applications/depreciation";

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
 * `TravelApplicationPage.tsx`／`MaintenanceApplicationPage.tsx` 同型——三頁各自
 * 持有一份（本 Phase 之 Files Allowed 為三頁 ＋ api client，不新建共用元件
 * 檔）。詳細設計理由見 TravelApplicationPage 同名函式之註解。
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

/** AC-42／§3.3：折舊證明上限 5 張（後端為權威來源，本常數僅供前端提示文案/UI）。 */
const DEPRECIATION_ATTACHMENT_LIMIT = 5;

/**
 * §20.5.1 完成阻擋碼（blocker codes）固定文案——修訂後六碼固定順序表，逐字
 * 對應後端 `depreciation-blockers.ts` 之訊息文案（純代碼→固定字串查表，
 * 不含任何金額/里程計算，AC-59(b) 不自算鑑別）。
 *
 * PHASE-007-R9：退場 1（`DEPRECIATION_ATTACHMENT_REQUIRED`，AC-54(b)）、
 * 新增 3（`ANNUAL_TOTAL_KM_REQUIRED`／`ANNUAL_TOTAL_KM_INVALID`／
 * `OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM`）——`backend/test/integration/
 * phase7-contract.test.ts` 之 FW-2「後端 blocker 訊息 ↔ 前端本表」結構性
 * 掃描逐碼逐字比對，本表任何文案異動須與該檔同步。
 */
const BLOCKING_CODE_MESSAGES: Record<string, string> = {
  YEAR_REQUIRED: "請選擇申請年度",
  ANNUAL_TOTAL_KM_REQUIRED: "請輸入該車年度總里程",
  ANNUAL_TOTAL_KM_INVALID: "年度總里程必須大於 0",
  PARAMETER_NOT_AVAILABLE: "該年度尚無有效折舊參數，請聯絡管理員設定",
  OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM: "年度公務里程大於年度總里程，請檢查年度總里程",
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
  annualTotalKm: string; // ★ R9／AC-58：<input type="number"> 之受控字串值
}

const EMPTY_FORM: FormFields = { applicationYear: "", annualTotalKm: "" };

function toFormFields(app: DepreciationApplicationDto): FormFields {
  return {
    applicationYear: app.applicationYear === null ? "" : String(app.applicationYear),
    annualTotalKm: app.annualTotalKm === null ? "" : app.annualTotalKm,
  };
}

/**
 * FW-5／B-02：`applicationYear` 僅收 JSON number｜null。空字串→`null`；
 * 其餘一律以 `Number()` 轉換後送出（含非整數/非數字之無效輸入——留給後端
 * `parseApplicationYearField` 判定並回 400 `fields[]`，本函式不重複驗證）。
 *
 * PHASE-007-R9：`annualTotalKm`（AC-47／AC-58）沿用同一 number wire 慣例——
 * 空字串→`null`；其餘以 `Number()` 轉換後送出，格式／小數位／值域一律留給
 * 後端 `parseAnnualTotalKmField` 判定並回 400 `fields[]`。
 */
function buildPreviewRequestBody(form: FormFields): DepreciationDraftFields {
  const trimmedYear = form.applicationYear.trim();
  const trimmedKm = form.annualTotalKm.trim();
  return {
    applicationYear: trimmedYear === "" ? null : Number(trimmedYear),
    annualTotalKm: trimmedKm === "" ? null : Number(trimmedKm),
  };
}

/**
 * R10 裁定（R9 移交項）：`isFormEntirelyBlank` 之判斷**不擴及**
 * `annualTotalKm`——僅以 `applicationYear` 是否為空作為「尚未開始輸入」之
 * 佔位文案（「請先選擇申請年度」）觸發條件。理由（AC-53(d)／§20.9）：
 *   - 若擴及 `annualTotalKm`，則「申請年度已填、年度總里程未填」情境會被
 *     導向佔位文案「請先選擇申請年度」——與畫面上申請年度欄位實際已填之
 *     狀態矛盾，對使用者具誤導性。
 *   - 維持現狀（僅查 `applicationYear`）時，該情境改由預覽 API 之
 *     `calculable=false` ＋ `blockingCodes=["ANNUAL_TOTAL_KM_REQUIRED"]`
 *     驅動顯示「無法計算」＋「請輸入該車年度總里程」——訊息精確對應缺漏
 *     欄位，且仍滿足 AC-53(d)「不得顯示金額 0」之硬性要求。
 * 兩條路徑皆不顯示金額 0，故本裁定不影響 AC-53(d) 之滿足與否，僅影響
 * 文案精確度；後者更精確，故維持現狀、不擴大本函式範圍。
 */
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
    setForm((f) => ({ ...f, applicationYear: value }));
    setDirty(true);
  }

  function updateAnnualTotalKm(value: string) {
    setForm((f) => ({ ...f, annualTotalKm: value }));
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
      const { application: revision } = await apiCreateRevision<DepreciationApplicationDto>(
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
  // `voided` 分歧（比照 TravelApplicationPage／MaintenanceApplicationPage 同型
  // 處置）。
  if (application.status === "COMPLETED" || application.status === "VOIDED") {
    const snapshot = application.snapshot;
    const voided = application.status === "VOIDED";
    const voidInfo = application.void;
    return (
      <div className="page-container">
        <header className="page-header">
          <h1>年度折舊補貼申請（{voided ? "已作廢" : "已完成"}）</h1>
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

          <section aria-labelledby="depreciation-info-heading">
            <h2 id="depreciation-info-heading">基本資料</h2>
            <dl className="detail-list">
              <dt>申請年度</dt>
              <dd>{application.applicationYear ?? "—"}</dd>
            </dl>
          </section>

          {/* 已完成申請的快照 — 唯一顯示補貼金額的權威來源。B-12：rawAmount
              （取整前）與 totalAmount（取整後、實際核發）同屏並列時須以文案
              區分兩者用途，避免使用者誤解為金額不一致。
              AC-59(a)：五值（每年折舊費用／年度公務里程／年度總里程／公務
              比例／補貼金額）逐字取自 `snapshot`——本區塊不含任何計算。
              AC-59(c) 負向斷言：`snapshot.perKmUnitPrice`（舊模型欄）刻意
              不渲染——即使該欄非 null（LEGACY 快照），畫面上仍不得出現。 */}
          {snapshot && (
            <section aria-labelledby="snapshot-heading">
              <h2 id="snapshot-heading">計算依據（完成時快照）</h2>
              <dl className="detail-list">
                <dt>每年折舊費用</dt>
                <dd>{snapshot.annualDepreciation}</dd>
                <dt>年度公務里程</dt>
                <dd>{snapshot.officialKm} 公里</dd>
                <dt>年度總里程</dt>
                <dd>{snapshot.annualTotalKm} 公里</dd>
                <dt>公務比例</dt>
                <dd>{snapshot.ratioPercent}%</dd>
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
            {/* AC-32(d)／FE-US-21④：已作廢不顯示——見 ATTACHMENT_REVISION_HINT
                之註解。 */}
            {!voided && <p className="warn-text">{ATTACHMENT_REVISION_HINT}</p>}
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
              setApplication(voidedApplication as DepreciationApplicationDto);
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
        {/* AC-32(c)：修正版剛建立時狀態為 DRAFT，故草稿分支亦須呈現版本關係。 */}
        <VersionRelationSection
          supersedes={application.supersedes}
          supersededBy={application.supersededBy}
        />

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
          {/* AC-58：表單提供「申請年度」與「該車年度總里程」兩項可輸入欄位
              ——年度公務里程仍為後端唯讀計算值，畫面上不存在任何可輸入／
              覆寫該值之欄位（負向斷言保留）。兩欄位標籤逐字互異且同時
              可見，使兩者來源可被使用者區分。 */}
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
          <div className="form-group">
            <label htmlFor="annual-total-km">該車年度總里程</label>
            <input
              id="annual-total-km"
              type="number"
              step="0.1"
              value={form.annualTotalKm}
              onChange={(e) => updateAnnualTotalKm(e.target.value)}
              disabled={saving}
              aria-describedby={saveFieldErrors.annualTotalKm ? "annual-total-km-err" : undefined}
            />
            {saveFieldErrors.annualTotalKm && (
              <span id="annual-total-km-err" className="field-error" role="alert">
                {saveFieldErrors.annualTotalKm}
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
                    // AC-59/41：不可計算狀態不得顯示金額 0，須顯示「無法計算」＋
                    // 可行動之 zh-TW 說明；車價／折舊年限／每公里補助單價三
                    // 推導值在任何狀態下皆不出現於本頁——後端 DTO 本即不回傳
                    // 這三值，此處無從顯示。
                    //
                    // R10／AC-60：比例 >100%（`OFFICIAL_KM_EXCEEDS_ANNUAL_
                    // TOTAL_KM`）須「顯示錯誤」——以 `error-block`／
                    // `role="alert"` 呈現，區別於其餘不可計算態（尚未輸入、
                    // 缺參數等）之一般提示 `warn-text`；顯示邏輯仍一律以
                    // `blockingCodes` 驅動（AC-60 末句），非新增 `calculable`
                    // 以外之第二旗標。
                    <div
                      className={
                        preview.blockingCodes.includes("OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM")
                          ? "error-block"
                          : "warn-text"
                      }
                      role={
                        preview.blockingCodes.includes("OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM")
                          ? "alert"
                          : undefined
                      }
                    >
                      <p>
                        <strong>年度補貼金額：無法計算</strong>
                      </p>
                      {blockingCodeMessages(preview.blockingCodes).map((msg) => (
                        <p key={msg}>{msg}</p>
                      ))}
                    </div>
                  ) : (
                    <>
                      {/* AC-59(a)：五值逐字取自後端回應，本區塊不含任何計算
                          （AC-59(b) 零自算鑑別）。 */}
                      <dl className="detail-list">
                        <dt>每年折舊費用</dt>
                        <dd>{preview.annualDepreciation}</dd>
                        <dt>年度公務里程</dt>
                        <dd>{preview.officialKm} 公里</dd>
                        <dt>年度總里程</dt>
                        <dd>{preview.annualTotalKm} 公里</dd>
                        <dt>公務比例</dt>
                        <dd>{preview.ratioPercent}%</dd>
                        <dt>年度補貼金額</dt>
                        <dd>{preview.amount}</dd>
                      </dl>
                      {/* SF-3／終審 SF-3／Spec §4 Empty 列：文案須由「里程事實」
                          （officialKm=0.00）驅動，不得以「金額結果」（amount=0）
                          推斷成因——B-10 合法情境（里程>0 但單價 0.0000 →
                          補貼 0 元）下 officialKm 非 0，此句不應出現，否則與
                          畫面同時顯示之非零里程自相矛盾。非錯誤、非空白頁，
                          金額本身不改帶「元」（全站既有慣例，§18 記勘誤）。 */}
                      {preview.officialKm === "0.00" && (
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
