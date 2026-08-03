/**
 * TravelApplicationPage — PHASE-004-T13
 *
 * Routes: `/applications/travel/new`（建立草稿後導向 `:id`）、
 * `/applications/travel/:id`（草稿編輯 / 已完成檢視）。
 *
 * 硬性約束落地重點：
 *   - C1/D6：本頁從不自行計算任何金額。草稿/預覽金額一律來自
 *     `POST /applications/travel/preview`（`computed`，§8.1
 *     `TravelComputedDto` 型別上就沒有單價欄位 —— 見 api/applications.ts
 *     的型別註解）；已完成金額一律來自 `snapshot`（唯一有單價的來源）。
 *   - D7：`completionBlockers` 由後端提供並照實顯示；本頁僅做「純欄位級」
 *     格式提示（`segmentFieldHints`，總里程 ≤0／高速<0／高速>總里程／必填
 *     空白），不判斷附件是否足夠、參數是否存在。
 *   - D8：預覽為 debounce 300ms 呼叫的獨立 stateless 端點。
 *   - D15：儲存為整份 `PUT`（以 `id` 對齊 diff），前端只需維護一份本地
 *     `segments` 陣列並在按下「儲存」時整份送出。
 *   - C3：儲存／完成／刪除／代操作提交鈕在進行中皆 disabled，防重複提交。
 *   - C4：刪除草稿／刪除行程段／完成申請皆需二次確認（`.dialog-overlay`
 *     元件，沿用 AdminUsersPage.tsx 既有樣式慣例）；附件刪除確認見
 *     `SegmentAttachmentPanel.tsx`。
 */

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  type PreviewMissingCode,
  type SegmentInput,
  type TravelApplicationDto,
  type TravelComputedDto,
  apiCompleteApplication,
  apiCreateTravelDraft,
  apiDeleteApplication,
  apiGetTravelDraft,
  apiPreviewTravel,
  apiUpdateTravelDraft,
} from "../api/applications.js";
import { type AttachmentDto, toFrontendUrl } from "../api/attachments.js";
import SegmentAttachmentPanel from "../components/SegmentAttachmentPanel.js";
import type { ApiError } from "../types/api.js";

const SEGMENT_ATTACHMENT_LIMIT = 3; // UI 提示用；後端上限為權威（AC-22）
const PREVIEW_DEBOUNCE_MS = 300; // D8

/**
 * AC-32（PHASE-005a-T11）：依 `missingParameters` 之 wire 代碼（D5(a)/T7 複審
 * SF-4 更名後之六碼權威清單，§18 T8R）逐碼對應之 zh-TW 文案。三個「缺參數」
 * 代碼（FUEL_CONSUMPTION/FUEL_PRICE/ETC）之文案逐字互異（AC-32 明文要求）；
 * 三個「不可計算」代碼（FUEL_DATA_CORRUPTED/FUEL_UNIT_PRICE_OUT_OF_RANGE/
 * AMOUNT_OUT_OF_RANGE）之文案亦互異，且與前三者不重複（PROJECT_STATE T8R
 * 移交 A-2 義務：不得洩漏技術細節、不得與 AC-32 三情境文字混淆）。
 *
 * 本函式純為代碼→固定字串查表，不含任何金額/單價計算（§11.3 不自算鑑別）。
 */
const MISSING_PARAMETER_MESSAGES: Record<PreviewMissingCode, string> = {
  FUEL_CONSUMPTION: "請聯絡管理員建立油耗資料",
  FUEL_PRICE: "請聯絡管理員設定參數",
  ETC: "該出差日期缺少 ETC 補助參數，請聯絡管理員設定",
  FUEL_DATA_CORRUPTED: "您的油耗資料異常，請聯絡管理員檢查",
  FUEL_UNIT_PRICE_OUT_OF_RANGE: "油價與油耗組合超出可計算範圍，請聯絡管理員檢查參數設定",
  AMOUNT_OUT_OF_RANGE: "計算金額超出可儲存範圍，請聯絡管理員檢查里程與參數設定",
};

/** 顯示順序固定（缺參數優先於不可計算，與 §9.2 解析順序一致）。 */
const MISSING_PARAMETER_ORDER: PreviewMissingCode[] = [
  "FUEL_CONSUMPTION",
  "FUEL_PRICE",
  "ETC",
  "FUEL_DATA_CORRUPTED",
  "FUEL_UNIT_PRICE_OUT_OF_RANGE",
  "AMOUNT_OUT_OF_RANGE",
];

function missingParameterMessages(missing: PreviewMissingCode[]): string[] {
  return MISSING_PARAMETER_ORDER.filter((code) => missing.includes(code)).map(
    (code) => MISSING_PARAMETER_MESSAGES[code]
  );
}

/**
 * 合併複審 SF-1 修復：「油資無法計算」標題與金額抑制僅繫於「油資相關」代碼
 * ——僅缺 `ETC` 時，油資版本本就齊備，後端仍會算出正確的油資試算金額
 * （`formatTravelComputed`，travel-service.ts 明文設計：只缺 ETC 版本時 ETC
 * 部分以 0 佔位、油資部分照實呈現），此時應維持顯示各段與合計金額（後端為
 * 準）＋ETC 缺項提示，而非誤報「油資無法計算」並隱藏已算出的金額
 * （FE-US-10 第一條、AC-32 字面僅涵蓋缺油耗/缺油價，未涵蓋僅缺 ETC）。
 * `AMOUNT_OUT_OF_RANGE` 必須保留在抑制清單——該情境下後端已把段金額歸零
 * （travel-service.ts 之 `amountOutOfRange` 分支），顯示歸零值即為 AC-32
 * 禁止之「金額 0 為最終值」。
 */
const FUEL_UNAVAILABLE_CODES: PreviewMissingCode[] = [
  "FUEL_PRICE",
  "FUEL_CONSUMPTION",
  "FUEL_DATA_CORRUPTED",
  "FUEL_UNIT_PRICE_OUT_OF_RANGE",
  "AMOUNT_OUT_OF_RANGE",
];

function isFuelUnavailable(missing: PreviewMissingCode[]): boolean {
  return missing.some((code) => FUEL_UNAVAILABLE_CODES.includes(code));
}

let localKeySeq = 0;
function nextLocalKey(): string {
  localKeySeq += 1;
  return `local-seg-${localKeySeq}`;
}

interface LocalSegment {
  key: string; // React key（新段落無 id 前的穩定鍵）
  id?: string; // 後端 id（既有段落才有；新段落 undefined，AC-08）
  origin: string;
  destination: string;
  totalKm: string;
  highwayKm: string;
  attachments: AttachmentDto[];
}

function toLocalSegments(dto: TravelApplicationDto): LocalSegment[] {
  return dto.segments
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((s) => ({
      key: s.id,
      id: s.id,
      origin: s.origin ?? "",
      destination: s.destination ?? "",
      totalKm: s.totalKm ?? "",
      highwayKm: s.highwayKm ?? "",
      attachments: s.attachments,
    }));
}

function buildSegmentInputs(segments: LocalSegment[]): SegmentInput[] {
  return segments.map((s) => ({
    id: s.id,
    origin: s.origin.trim() === "" ? null : s.origin,
    destination: s.destination.trim() === "" ? null : s.destination,
    totalKm: s.totalKm.trim() === "" ? null : s.totalKm,
    highwayKm: s.highwayKm.trim() === "" ? null : s.highwayKm,
    attachmentIds: s.attachments.map((a) => a.id),
  }));
}

/** D7(c): 純欄位級即時提示（格式性，不含「附件足夠」「參數存在」判斷）。 */
function segmentFieldHints(s: LocalSegment): { totalKm?: string; highwayKm?: string } {
  const hints: { totalKm?: string; highwayKm?: string } = {};
  const totalRaw = s.totalKm.trim();
  const highwayRaw = s.highwayKm.trim();
  const total = totalRaw === "" ? null : Number(totalRaw);
  const highway = highwayRaw === "" ? null : Number(highwayRaw);

  if (total !== null && !Number.isNaN(total) && total <= 0) {
    hints.totalKm = "總里程需大於 0";
  }
  if (highway !== null && !Number.isNaN(highway) && highway < 0) {
    hints.highwayKm = "高速里程不可為負數";
  }
  if (
    total !== null &&
    highway !== null &&
    !Number.isNaN(total) &&
    !Number.isNaN(highway) &&
    highway > total
  ) {
    hints.highwayKm = "高速里程不可超過總里程";
  }
  return hints;
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
  | { kind: "ready"; data: TravelComputedDto }
  | { kind: "error"; message: string };

export default function TravelApplicationPage(): React.ReactElement {
  const { id: routeId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [pageState, setPageState] = useState<PageState>(
    routeId === "new" ? { kind: "creating" } : { kind: "loading" }
  );
  const [application, setApplication] = useState<TravelApplicationDto | null>(null);

  // ---- Editable form state (DRAFT only) ----
  const [tripDate, setTripDate] = useState("");
  const [purpose, setPurpose] = useState("");
  const [segments, setSegments] = useState<LocalSegment[]>([]);
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

  const [removeSegmentKey, setRemoveSegmentKey] = useState<string | null>(null);

  const [previewState, setPreviewState] = useState<PreviewState>({ kind: "idle" });

  const createdRef = useRef(false);

  const loadApplication = useCallback(async (targetId: string) => {
    setPageState({ kind: "loading" });
    try {
      const { application: app } = await apiGetTravelDraft(targetId);
      setApplication(app);
      setTripDate(app.tripDate ?? "");
      setPurpose(app.purpose ?? "");
      setSegments(toLocalSegments(app));
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
          const { application: app } = await apiCreateTravelDraft({});
          navigate(`/applications/travel/${app.id}`, { replace: true });
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

  // ---- FE-US-07 AC4: 未儲存變更離開頁面前提示 ----
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
  // NOTE: `segments` (whole array, incl. origin/destination/attachments) is a
  // dependency because it's read inside the effect below; changing any
  // segment field re-triggers the debounce timer, but the request body itself
  // only ever carries totalKm/highwayKm, so origin/destination/attachment
  // edits still produce an identical preview request (harmless extra call).
  useEffect(() => {
    if (pageState.kind !== "ready" || !application || application.status !== "DRAFT") return;
    setPreviewState({ kind: "loading" });
    const handle = setTimeout(() => {
      apiPreviewTravel({
        tripDate: tripDate.trim() === "" ? null : tripDate,
        segments: segments.map((s) => ({
          totalKm: s.totalKm.trim() === "" ? null : s.totalKm,
          highwayKm: s.highwayKm.trim() === "" ? null : s.highwayKm,
        })),
      })
        .then(({ preview }) => setPreviewState({ kind: "ready", data: preview }))
        .catch((err: ApiError) => {
          setPreviewState({ kind: "error", message: err.message ?? "預覽失敗，請稍後再試。" });
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [tripDate, segments, pageState.kind, application]);

  // ---- Segment editing ----
  function addSegment() {
    setSegments((prev) => [
      ...prev,
      {
        key: nextLocalKey(),
        origin: "",
        destination: "",
        totalKm: "",
        highwayKm: "",
        attachments: [],
      },
    ]);
    setDirty(true);
  }

  function updateSegmentField(
    key: string,
    field: "origin" | "destination" | "totalKm" | "highwayKm",
    value: string
  ) {
    setSegments((prev) => prev.map((s) => (s.key === key ? { ...s, [field]: value } : s)));
    setDirty(true);
  }

  function updateSegmentAttachments(key: string, attachments: AttachmentDto[]) {
    setSegments((prev) => prev.map((s) => (s.key === key ? { ...s, attachments } : s)));
    setDirty(true);
  }

  function confirmRemoveSegment() {
    if (!removeSegmentKey) return;
    setSegments((prev) => prev.filter((s) => s.key !== removeSegmentKey));
    setDirty(true);
    setRemoveSegmentKey(null);
  }

  // ---- Save (整份 PUT，D15) ----
  async function handleSave() {
    if (!application || saving) return;
    setSaving(true);
    setSaveError(null);
    setSaveFieldErrors({});
    setSaveSuccess(null);
    try {
      const { application: updated } = await apiUpdateTravelDraft(application.id, {
        tripDate: tripDate.trim() === "" ? null : tripDate,
        purpose: purpose.trim() === "" ? null : purpose,
        segments: buildSegmentInputs(segments),
      });
      setApplication(updated);
      setTripDate(updated.tripDate ?? "");
      setPurpose(updated.purpose ?? "");
      setSegments(toLocalSegments(updated));
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
        setSaveError(apiErr.message ?? "該行程段最多 3 張附件。");
      } else if (apiErr.code === "FORBIDDEN") {
        setSaveError("已完成的申請不可修改，請建立修正版。");
      } else {
        setSaveError(apiErr.message ?? "儲存失敗，請稍後再試。");
      }
    } finally {
      setSaving(false);
    }
  }

  // ---- Complete（不可逆，C4 需確認）----
  async function handleComplete() {
    if (!application || completing) return;
    setCompleting(true);
    setCompleteError(null);
    try {
      const { application: completed } = await apiCompleteApplication(application.id);
      setApplication(completed);
      setSegments(toLocalSegments(completed));
      setShowCompleteConfirm(false);
      setDirty(false);
    } catch (err) {
      const apiErr = err as ApiError;
      const details = apiErr.details as { blockers?: { message: string }[] } | undefined;
      if (apiErr.code === "VALIDATION_ERROR" && details?.blockers && details.blockers.length > 0) {
        setCompleteError(details.blockers.map((b) => b.message).join("；"));
      } else if (apiErr.code === "PARAMETER_NOT_AVAILABLE") {
        setCompleteError("該出差日期尚無有效補助參數，請聯絡管理員設定。");
      } else if (apiErr.code === "FORBIDDEN") {
        setCompleteError("無權完成此申請，或此申請已完成。");
      } else {
        setCompleteError(apiErr.message ?? "完成失敗，請稍後再試。");
      }
    } finally {
      setCompleting(false);
    }
  }

  // ---- Delete draft（不可逆，C4 需確認）----
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
    // Unreachable in practice (pageState.kind === "ready" implies application is set),
    // guards TS narrowing below.
    return (
      <div className="page-container">
        <div className="error-block" role="alert">
          <p>發生未預期的錯誤。</p>
        </div>
      </div>
    );
  }

  // ---- COMPLETED：唯讀檢視（D13：不得出現無效按鈕）----
  if (application.status === "COMPLETED") {
    const snapshot = application.snapshot;
    return (
      <div className="page-container">
        <header className="page-header">
          <h1>差旅補助申請（已完成）</h1>
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

          <section aria-labelledby="trip-info-heading">
            <h2 id="trip-info-heading">基本資料</h2>
            <dl className="detail-list">
              <dt>出差日期</dt>
              <dd>{application.tripDate ?? "—"}</dd>
              <dt>出差目的</dt>
              <dd>{application.purpose ?? "—"}</dd>
            </dl>
          </section>

          <section aria-labelledby="segments-heading">
            <h2 id="segments-heading">行程段明細</h2>
            <div className="trip-segment-list">
              {segments.map((s, index) => {
                const snap = application.segments[index]?.snapshot;
                return (
                  <div className="trip-segment" key={s.key}>
                    <h3>第 {index + 1} 段</h3>
                    <dl className="detail-list">
                      <dt>出發地點</dt>
                      <dd>{s.origin || "—"}</dd>
                      <dt>到達地點</dt>
                      <dd>{s.destination || "—"}</dd>
                      <dt>總里程</dt>
                      <dd>{s.totalKm || "—"}</dd>
                      <dt>高速里程</dt>
                      <dd>{s.highwayKm || "—"}</dd>
                      <dt>油資補助（取整前）</dt>
                      <dd>{snap ? snap.fuelAmount : "—"}</dd>
                      <dt>ETC 補助（取整前）</dt>
                      <dd>{snap ? snap.etcAmount : "—"}</dd>
                      <dt>本段金額</dt>
                      <dd>{snap ? snap.amount : "—"}</dd>
                    </dl>
                    {s.attachments.length > 0 && (
                      <ul className="attachment-list" aria-label={`第 ${index + 1} 段截圖`}>
                        {s.attachments.map((att) => (
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
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* D6(c): 已完成申請的快照 — 唯一顯示單價的地方 */}
          {snapshot && (
            <section aria-labelledby="snapshot-heading">
              <h2 id="snapshot-heading">計算依據（完成時快照）</h2>
              <dl className="detail-list">
                <dt>油資單價</dt>
                <dd>{snapshot.fuelUnitPrice}</dd>
                <dt>ETC 單價</dt>
                <dd>{snapshot.etcUnitPrice}</dd>
                <dt>總里程</dt>
                <dd>{snapshot.totalKm}</dd>
                <dt>整筆金額</dt>
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
  const previewByIndex = new Map<number, TravelComputedDto["segments"][number]>();
  if (previewState.kind === "ready") {
    for (const seg of previewState.data.segments) {
      previewByIndex.set(seg.segmentIndex, seg);
    }
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>差旅補助申請（草稿）</h1>
        <div className="header-actions">
          <Link to="/" className="btn btn-secondary">
            返回列表
          </Link>
        </div>
      </header>

      <main className="page-main">
        {application.completionBlockers.length > 0 && (
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

        <section aria-labelledby="trip-info-heading">
          <h2 id="trip-info-heading">基本資料</h2>
          <div className="form-group">
            <label htmlFor="trip-date">出差日期</label>
            <input
              id="trip-date"
              type="date"
              value={tripDate}
              onChange={(e) => {
                setTripDate(e.target.value);
                setDirty(true);
              }}
              disabled={saving}
              aria-describedby={saveFieldErrors.tripDate ? "trip-date-err" : undefined}
            />
            {saveFieldErrors.tripDate && (
              <span id="trip-date-err" className="field-error" role="alert">
                {saveFieldErrors.tripDate}
              </span>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="trip-purpose">出差目的</label>
            <textarea
              id="trip-purpose"
              value={purpose}
              onChange={(e) => {
                setPurpose(e.target.value);
                setDirty(true);
              }}
              disabled={saving}
              aria-describedby={saveFieldErrors.purpose ? "trip-purpose-err" : undefined}
            />
            {saveFieldErrors.purpose && (
              <span id="trip-purpose-err" className="field-error" role="alert">
                {saveFieldErrors.purpose}
              </span>
            )}
          </div>
        </section>

        <section aria-labelledby="segments-heading">
          <div className="list-toolbar">
            <h2 id="segments-heading">行程段</h2>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={addSegment}
              disabled={saving}
            >
              新增行程段
            </button>
          </div>

          {segments.length === 0 && (
            <div className="empty-block">
              <p>尚無行程段，請點選「新增行程段」開始填寫。</p>
            </div>
          )}

          <div className="trip-segment-list">
            {segments.map((s, index) => {
              const hints = segmentFieldHints(s);
              const preview = previewByIndex.get(index);
              return (
                <div className="trip-segment" key={s.key}>
                  <div className="list-toolbar">
                    <h3>第 {index + 1} 段</h3>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => setRemoveSegmentKey(s.key)}
                      disabled={saving}
                    >
                      移除此段
                    </button>
                  </div>

                  <div className="form-group">
                    <label htmlFor={`seg-origin-${s.key}`}>出發地點</label>
                    <input
                      id={`seg-origin-${s.key}`}
                      type="text"
                      value={s.origin}
                      onChange={(e) => updateSegmentField(s.key, "origin", e.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor={`seg-destination-${s.key}`}>到達地點</label>
                    <input
                      id={`seg-destination-${s.key}`}
                      type="text"
                      value={s.destination}
                      onChange={(e) => updateSegmentField(s.key, "destination", e.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor={`seg-totalKm-${s.key}`}>總里程（公里）</label>
                    <input
                      id={`seg-totalKm-${s.key}`}
                      type="number"
                      step="0.01"
                      value={s.totalKm}
                      onChange={(e) => updateSegmentField(s.key, "totalKm", e.target.value)}
                      disabled={saving}
                      aria-describedby={hints.totalKm ? `seg-totalKm-hint-${s.key}` : undefined}
                    />
                    {hints.totalKm && (
                      <span id={`seg-totalKm-hint-${s.key}`} className="field-error">
                        {hints.totalKm}
                      </span>
                    )}
                  </div>
                  <div className="form-group">
                    <label htmlFor={`seg-highwayKm-${s.key}`}>高速里程（公里）</label>
                    <input
                      id={`seg-highwayKm-${s.key}`}
                      type="number"
                      step="0.01"
                      value={s.highwayKm}
                      onChange={(e) => updateSegmentField(s.key, "highwayKm", e.target.value)}
                      disabled={saving}
                      aria-describedby={hints.highwayKm ? `seg-highwayKm-hint-${s.key}` : undefined}
                    />
                    {hints.highwayKm && (
                      <span id={`seg-highwayKm-hint-${s.key}`} className="field-error">
                        {hints.highwayKm}
                      </span>
                    )}
                  </div>

                  <SegmentAttachmentPanel
                    segmentLabel={`第 ${index + 1} 段`}
                    attachments={s.attachments}
                    limit={SEGMENT_ATTACHMENT_LIMIT}
                    onChange={(attachments) => updateSegmentAttachments(s.key, attachments)}
                    disabled={saving}
                  />

                  <div className="preview-summary" aria-live="polite">
                    {previewState.kind === "loading" && <p>計算中…</p>}
                    {previewState.kind === "ready" &&
                      preview &&
                      (isFuelUnavailable(previewState.data.missingParameters) ? (
                        // AC-32（FE-US-10 第四條）：油資無法計算時，本段金額
                        // 不得以 0 呈現為最終值——顯示「油資無法計算」。
                        // SF-1：僅缺 ETC 時油資本可算出，不落入此分支。
                        <p className="warn-text">油資無法計算</p>
                      ) : (
                        <dl className="detail-list">
                          <dt>油資補助（試算）</dt>
                          <dd>{preview.fuelAmount}</dd>
                          <dt>ETC 補助（試算）</dt>
                          <dd>{preview.etcAmount}</dd>
                          <dt>本段金額（試算）</dt>
                          <dd>{preview.amount}</dd>
                        </dl>
                      ))}
                    {previewState.kind === "error" && (
                      <p className="field-error">{previewState.message}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section aria-labelledby="preview-total-heading">
          <h2 id="preview-total-heading">金額預覽（試算，後端計算）</h2>
          {previewState.kind === "loading" && <p>計算中…</p>}
          {previewState.kind === "ready" &&
            (() => {
              const { missingParameters } = previewState.data;
              const messages = missingParameterMessages(missingParameters);
              const fuelUnavailable = isFuelUnavailable(missingParameters);
              return (
                <>
                  {fuelUnavailable ? (
                    // AC-32：三種缺參數情境文字逐字互異（同時成立時同時顯示）；
                    // 且不得以「暫以 0 試算」之類文字暗示金額 0 為最終值。
                    <div className="warn-text">
                      <p>
                        <strong>油資無法計算</strong>
                      </p>
                      {messages.map((msg) => (
                        <p key={msg}>{msg}</p>
                      ))}
                    </div>
                  ) : (
                    <>
                      {messages.length > 0 && (
                        // SF-1：僅缺 ETC 時，油資部分仍可算出，維持顯示合計
                        // 金額（後端為準）＋ETC 缺項提示，不誤報「油資無法
                        // 計算」（FE-US-10 第一條、PHASE-004 既有行為）。
                        <div className="warn-text">
                          {messages.map((msg) => (
                            <p key={msg}>{msg}</p>
                          ))}
                        </div>
                      )}
                      <p>
                        <strong>合計金額：{previewState.data.totalAmount}</strong>（總里程：
                        {previewState.data.totalKm} 公里）
                      </p>
                    </>
                  )}
                </>
              );
            })()}
          {previewState.kind === "error" && (
            <p className="field-error" role="alert">
              {previewState.message}
            </p>
          )}
        </section>

        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "儲存中…" : "儲存草稿"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowCompleteConfirm(true)}
            disabled={saving || completing}
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

      {/* ---- 確認對話框（C4）---- */}

      {removeSegmentKey && (
        <div className="dialog-overlay">
          <dialog open className="dialog-box" aria-label="確認移除行程段">
            <h3>確認移除行程段</h3>
            <p>
              確定要移除此行程段嗎？其尚未儲存的附件關聯將一併移除。此變更需按下「儲存草稿」才會生效。
            </p>
            <div className="btn-row">
              <button type="button" className="btn btn-danger" onClick={confirmRemoveSegment}>
                確認移除
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setRemoveSegmentKey(null)}
              >
                取消
              </button>
            </div>
          </dialog>
        </div>
      )}

      {showCompleteConfirm && (
        <div className="dialog-overlay">
          <dialog open className="dialog-box" aria-label="確認完成申請">
            <h3>確認完成申請</h3>
            {dirty ? (
              // PHASE-005a-T14（Gate 反饋①）：表單存在未儲存變更時，確認框不得
              // 以伺服器舊狀態渲染 completionBlockers 衍生之誤導紅字（該狀態
              // 尚未反映使用者的未儲存編輯），改顯示本提示並停用確認送出。
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
            <p>刪除後將無法復原，其附件關聯也將一併解除。確定要刪除這筆草稿嗎？</p>
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
