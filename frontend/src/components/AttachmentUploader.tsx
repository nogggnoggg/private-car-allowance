import type React from "react";
import { useRef, useState } from "react";
import {
  ATTACHMENT_MAX_BYTES,
  type AttachmentDto,
  type AttachmentRefType,
  apiDeleteAttachment,
  apiUploadAttachment,
  toFrontendUrl,
  validateFileBeforeUpload,
} from "../api/attachments.js";
import type { ApiError } from "../types/api.js";

interface AttachmentUploaderProps {
  /** The reference type for linking (e.g. TRIP_SEGMENT) */
  refType: AttachmentRefType;
  /** The reference container ID for linking */
  refId: string;
  /** Maximum number of attachments allowed */
  limit: number;
  /** Initial list of attachments already associated */
  initialAttachments?: AttachmentDto[];
  /** Called when the list changes (upload or delete) */
  onListChange?: (attachments: AttachmentDto[]) => void;
}

/**
 * Reusable attachment upload/preview/delete component.
 * - Client-side pre-flight: rejects files >10MB or non-jpg/png/webp before sending.
 * - Shows thumbnail preview on successful upload (AC-19).
 * - Shows clear error messages for size/format issues (AC-20).
 * - Delete button removes item from list (AC-21).
 * - Upload button disabled while uploading (prevents duplicate submission).
 */
export default function AttachmentUploader({
  refType,
  refId,
  limit,
  initialAttachments = [],
  onListChange,
}: AttachmentUploaderProps): React.ReactElement {
  const [attachments, setAttachments] = useState<AttachmentDto[]>(initialAttachments);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateList = (next: AttachmentDto[]) => {
    setAttachments(next);
    onListChange?.(next);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so same file can be selected again after error
    if (fileInputRef.current) fileInputRef.current.value = "";

    // Client-side pre-flight validation (AC-20)
    const preflightError = validateFileBeforeUpload(file);
    if (preflightError) {
      setError(preflightError);
      return;
    }

    setError(null);
    setUploading(true);

    try {
      const { attachment } = await apiUploadAttachment(file);
      updateList([...attachments, attachment]);
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

  const handleDelete = async (attachment: AttachmentDto) => {
    setDeletingId(attachment.id);
    setError(null);
    try {
      await apiDeleteAttachment(attachment.id);
      updateList(attachments.filter((a) => a.id !== attachment.id));
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.message ?? "刪除失敗，請稍後再試。");
    } finally {
      setDeletingId(null);
    }
  };

  const atLimit = attachments.length >= limit;

  return (
    <div className="attachment-uploader">
      {/* Error message region (AC-20) */}
      {error && (
        <div role="alert" className="attachment-error">
          {error}
        </div>
      )}

      {/* Existing attachments list */}
      {attachments.length > 0 && (
        <ul className="attachment-list" aria-label="已附圖片清單">
          {attachments.map((att) => (
            <li key={att.id} className="attachment-item">
              {/* Thumbnail preview (AC-19): previewUrl is backend-relative (/attachments/:id/thumbnail);
                   toFrontendUrl prepends /api so Vite dev proxy / nginx can route it correctly */}
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
                disabled={deletingId === att.id}
                onClick={() => handleDelete(att)}
              >
                {deletingId === att.id ? "刪除中…" : "刪除"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Upload controls */}
      {!atLimit && (
        <div className="attachment-upload-row">
          <label htmlFor="attachment-file-input" className="attachment-upload-label">
            選擇圖片
          </label>
          <input
            ref={fileInputRef}
            id="attachment-file-input"
            type="file"
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            onChange={handleFileChange}
            disabled={uploading}
            style={{ display: "none" }}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            aria-label={uploading ? "上傳中，請稍候" : "選擇並上傳圖片"}
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
    </div>
  );
}
