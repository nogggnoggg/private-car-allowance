import type React from "react";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  type AttachmentDto,
  type AttachmentRefType,
  apiDeleteAttachment,
  apiLinkAttachment,
  toFrontendUrl,
} from "../api/attachments.js";
import AttachmentUploader from "../components/AttachmentUploader.js";
import { useAuth } from "../context/AuthContext.js";
import type { ApiError } from "../types/api.js";

const DEFAULT_REF_TYPE: AttachmentRefType = "TRIP_SEGMENT";
const DEFAULT_REF_ID = "demo-1";
const DEFAULT_LIMIT = 3;

/**
 * Minimal host page for PHASE-003 integration Gate E2E verification.
 * Provides: upload component + injectable refType/refId/limit + link operation + linked list + delete.
 * NOT production UI — the real trip form UI is PHASE-004.
 */
export default function AttachmentsDemoPage(): React.ReactElement {
  const { authState, logout } = useAuth();

  // Configurable params (for integration Gate testing)
  const [refType, setRefType] = useState<AttachmentRefType>(DEFAULT_REF_TYPE);
  const [refId, setRefId] = useState(DEFAULT_REF_ID);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);

  // Staged (TEMP) attachments — uploaded but not yet linked
  const [tempAttachments, setTempAttachments] = useState<AttachmentDto[]>([]);

  // Linked attachments for this container
  const [linkedAttachments, setLinkedAttachments] = useState<AttachmentDto[]>([]);

  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [deleteLinkedId, setDeleteLinkedId] = useState<string | null>(null);
  const [deleteLinkedError, setDeleteLinkedError] = useState<string | null>(null);

  const handleListChange = (updated: AttachmentDto[]) => {
    setTempAttachments(updated);
  };

  const handleLink = async (att: AttachmentDto) => {
    setLinkError(null);
    setLinkingId(att.id);
    try {
      const { attachment } = await apiLinkAttachment(att.id, refType, refId, limit);
      // Move from temp to linked
      setTempAttachments((prev) => prev.filter((a) => a.id !== att.id));
      setLinkedAttachments((prev) => [...prev, attachment]);
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "TOO_MANY_ATTACHMENTS") {
        setLinkError(`已達數量上限（${limit} 張）：${apiErr.message}`);
      } else {
        setLinkError(apiErr.message ?? "關聯失敗，請稍後再試。");
      }
    } finally {
      setLinkingId(null);
    }
  };

  const handleDeleteLinked = async (att: AttachmentDto) => {
    setDeleteLinkedError(null);
    setDeleteLinkedId(att.id);
    try {
      await apiDeleteAttachment(att.id);
      setLinkedAttachments((prev) => prev.filter((a) => a.id !== att.id));
    } catch (err) {
      const apiErr = err as ApiError;
      setDeleteLinkedError(apiErr.message ?? "刪除失敗，請稍後再試。");
    } finally {
      setDeleteLinkedId(null);
    }
  };

  if (authState.status !== "authenticated") {
    return (
      <div className="page-container">
        <p>載入中…</p>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>附件功能驗收頁（整合 Gate）</h1>
        <div className="header-actions">
          <span className="user-info">{authState.user.displayName}</span>
          <Link to="/" className="btn btn-secondary">
            返回首頁
          </Link>
          <button type="button" onClick={() => logout()} className="btn btn-outline">
            登出
          </button>
        </div>
      </header>

      <main className="page-main">
        <section aria-labelledby="config-heading">
          <h2 id="config-heading">參數設定</h2>
          <p className="placeholder-note">（以下參數可注入以驗收不同情境）</p>
          <div className="form-row">
            <label htmlFor="ref-type-select">引用類型（refType）</label>
            <select
              id="ref-type-select"
              value={refType}
              onChange={(e) => setRefType(e.target.value as AttachmentRefType)}
            >
              <option value="TRIP_SEGMENT">TRIP_SEGMENT</option>
              <option value="MAINTENANCE">MAINTENANCE</option>
              <option value="DEPRECIATION">DEPRECIATION</option>
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="ref-id-input">引用容器 ID（refId）</label>
            <input
              id="ref-id-input"
              type="text"
              value={refId}
              onChange={(e) => setRefId(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label htmlFor="limit-input">數量上限（limit）</label>
            <input
              id="limit-input"
              type="number"
              min={1}
              max={10}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
          </div>
        </section>

        <hr />

        <section aria-labelledby="upload-heading">
          <h2 id="upload-heading">上傳附件</h2>
          <AttachmentUploader
            refType={refType}
            refId={refId}
            limit={limit}
            initialAttachments={[]}
            onListChange={handleListChange}
          />
        </section>

        {/* Temp attachments staging area for linking */}
        {tempAttachments.length > 0 && (
          <section aria-labelledby="stage-heading">
            <h2 id="stage-heading">暫存附件（待關聯）</h2>
            {linkError && (
              <div role="alert" className="attachment-error">
                {linkError}
              </div>
            )}
            <ul className="attachment-list">
              {tempAttachments.map((att) => (
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
                    className="btn btn-primary btn-sm"
                    disabled={linkingId === att.id}
                    onClick={() => handleLink(att)}
                    aria-label={`關聯 ${att.originalFilename}`}
                  >
                    {linkingId === att.id ? "關聯中…" : "關聯"}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <hr />

        <section aria-labelledby="linked-heading">
          <h2 id="linked-heading">已關聯附件</h2>
          {deleteLinkedError && (
            <div role="alert" className="attachment-error">
              {deleteLinkedError}
            </div>
          )}
          {linkedAttachments.length === 0 ? (
            <p className="placeholder-note">（尚無已關聯附件）</p>
          ) : (
            <ul className="attachment-list" aria-label="已關聯附件清單">
              {linkedAttachments.map((att) => (
                <li key={att.id} className="attachment-item">
                  <img
                    src={toFrontendUrl(att.previewUrl)}
                    alt={att.originalFilename}
                    className="attachment-thumb"
                    width={64}
                    height={64}
                  />
                  <span className="attachment-filename">{att.originalFilename}</span>
                  <span className="attachment-status-badge">已關聯</span>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    disabled={deleteLinkedId === att.id}
                    onClick={() => handleDeleteLinked(att)}
                    aria-label={`刪除 ${att.originalFilename}`}
                  >
                    {deleteLinkedId === att.id ? "刪除中…" : "刪除"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
