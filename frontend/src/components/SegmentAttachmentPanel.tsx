import type React from "react";
import { useId, useRef, useState } from "react";
import {
  ATTACHMENT_MAX_BYTES,
  type AttachmentDto,
  apiDeleteAttachment,
  apiUploadAttachment,
  toFrontendUrl,
  validateFileBeforeUpload,
} from "../api/attachments.js";
import type { ApiError } from "../types/api.js";

interface SegmentAttachmentPanelProps {
  /** Human-readable label for this segment, used in aria-labels (e.g. "第 1 段"). */
  segmentLabel: string;
  attachments: AttachmentDto[];
  /** UI-only hint (backend 3/segment cap is authoritative, AC-22/D7). */
  limit: number;
  onChange: (attachments: AttachmentDto[]) => void;
  /** true while the enclosing application is COMPLETED (read-only) or a save is in-flight. */
  disabled?: boolean;
}

/**
 * Per-segment attachment upload / preview / delete panel — PHASE-004-T13.
 *
 * A deliberately SEPARATE component from `AttachmentUploader` (PHASE-003),
 * not a reuse-by-prop-change of it: `AttachmentUploader.tsx`'s existing test
 * suite (frontend/test/AttachmentUploader.test.tsx, case 5 "刪除已上傳項目 →
 * 清單中移除") asserts immediate deletion on a single click with no
 * confirmation step. This Task's C4 constraint requires a confirmation step
 * before deleting an attachment. Adding a confirm gate to the SHARED
 * component would break that existing (unmodifiable, C6) assertion, so this
 * upload/delete panel is implemented independently for the travel form
 * (`AttachmentUploader` remains untouched, still used by
 * `AttachmentsDemoPage`). Linking is NOT performed here — uploads produce
 * TEMP attachments; the parent (`TravelApplicationPage`) collects the
 * resulting ids into the segment's `attachmentIds` and links them via the
 * next `PUT /applications/travel/:id` (D15) — see that file's comments.
 */
export default function SegmentAttachmentPanel({
  segmentLabel,
  attachments,
  limit,
  onChange,
  disabled = false,
}: SegmentAttachmentPanelProps): React.ReactElement {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<AttachmentDto | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (fileInputRef.current) fileInputRef.current.value = "";

    const preflightError = validateFileBeforeUpload(file);
    if (preflightError) {
      setError(preflightError);
      return;
    }

    setError(null);
    setUploading(true);
    try {
      const { attachment } = await apiUploadAttachment(file);
      onChange([...attachments, attachment]);
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "PAYLOAD_TOO_LARGE") {
        setError(`檔案大小超過上限（最大 ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB）。`);
      } else if (apiErr.code === "UNSUPPORTED_MEDIA_TYPE") {
        setError("格式不支援，後端拒絕：僅接受 JPEG/PNG/WebP 圖片。");
      } else {
        setError(apiErr.message ?? "上傳失敗，請稍後再試。");
      }
    } finally {
      setUploading(false);
    }
  };

  const confirmDelete = async () => {
    if (!confirmTarget) return;
    const target = confirmTarget;
    setDeletingId(target.id);
    setError(null);
    try {
      await apiDeleteAttachment(target.id);
      onChange(attachments.filter((a) => a.id !== target.id));
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.message ?? "刪除失敗，請稍後再試。");
    } finally {
      setDeletingId(null);
      setConfirmTarget(null);
    }
  };

  const atLimit = attachments.length >= limit;

  return (
    <div className="segment-attachments">
      {error && (
        <div role="alert" className="attachment-error">
          {error}
        </div>
      )}

      {attachments.length > 0 && (
        <ul className="attachment-list" aria-label={`${segmentLabel} 已附圖片清單`}>
          {attachments.map((att) => (
            <li key={att.id} className="attachment-item">
              <img
                src={toFrontendUrl(att.previewUrl)}
                alt={att.originalFilename}
                className="attachment-thumb"
                width={64}
                height={64}
              />
              <span className="attachment-filename">{att.originalFilename}</span>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                aria-label={`刪除 ${att.originalFilename}`}
                disabled={disabled || deletingId !== null}
                onClick={() => setConfirmTarget(att)}
              >
                {deletingId === att.id ? "刪除中…" : "刪除"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!atLimit && !disabled && (
        <div className="attachment-upload-row">
          <label htmlFor={inputId} className="attachment-upload-label">
            選擇圖片
          </label>
          <input
            ref={fileInputRef}
            id={inputId}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleFileChange}
            disabled={uploading}
            style={{ display: "none" }}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            aria-label={uploading ? "上傳中，請稍候" : `為${segmentLabel}選擇並上傳圖片`}
          >
            {uploading ? "上傳中…" : "選擇圖片"}
          </button>
          <span className="attachment-limit-hint">
            （已上傳 {attachments.length} / {limit}，最多 {limit} 張；JPG、PNG、WebP，10 MB 以內）
          </span>
        </div>
      )}

      {atLimit && (
        <p className="attachment-limit-note">已達上限（{limit} 張），如需新增請先刪除現有附件。</p>
      )}

      {/* C4: 刪除附件須有確認步驟。 */}
      {confirmTarget && (
        <div className="dialog-overlay">
          <dialog open className="dialog-box" aria-label="確認刪除附件">
            <h3>確認刪除附件</h3>
            <p>確定要刪除「{confirmTarget.originalFilename}」嗎？此操作無法復原。</p>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-danger"
                onClick={confirmDelete}
                disabled={deletingId !== null}
              >
                {deletingId !== null ? "刪除中…" : "確認刪除"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmTarget(null)}
                disabled={deletingId !== null}
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
