import type React from "react";
import { Link } from "react-router-dom";
import type { AttachmentRefType } from "../api/attachments.js";
import AttachmentUploader from "../components/AttachmentUploader.js";
import { useAuth } from "../context/AuthContext.js";

const DEFAULT_REF_TYPE: AttachmentRefType = "TRIP_SEGMENT";
const DEFAULT_REF_ID = "demo-1";
const DEFAULT_LIMIT = 3;

/**
 * Minimal host page for PHASE-003 integration Gate E2E verification.
 *
 * PHASE-004-T11 (D12, AR-D 閉環): the "link" operation area and "已關聯附件"
 * list have been REMOVED — the public `POST /attachments/:id/link` endpoint
 * they exercised has been removed from the backend (it allowed a caller to
 * self-supply `limit`/`refId`/`containerState`, a real authorization bypass
 * once PHASE-004 has real completed applications). Attachment linking is now
 * driven exclusively by `PUT /applications/travel/:id`'s `attachmentIds[]`
 * (the real travel form UI, PHASE-004-T13) — there is no standalone "link"
 * action to demo anymore.
 *
 * This page now only demonstrates: upload + thumbnail preview + delete
 * (`AttachmentUploader`, unchanged) — retaining the PHASE-003 AC-19/20/21
 * regression value (thumbnail preview, size/format error messages, delete)
 * without the removed link functionality. NOT production UI — the real trip
 * form UI is PHASE-004-T13.
 */
export default function AttachmentsDemoPage(): React.ReactElement {
  const { authState, logout } = useAuth();

  // Fixed params for AttachmentUploader's props (PHASE-004-T11: no longer
  // editable — refType/refId never drove any link call even before this
  // Task, and the removed link endpoint was the only thing that made them
  // worth injecting per-test-run; `limit` still exercises the component's
  // limit-reached UI state, which retains PHASE-003 regression value).
  const refType: AttachmentRefType = DEFAULT_REF_TYPE;
  const refId = DEFAULT_REF_ID;
  const limit = DEFAULT_LIMIT;

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
        <section aria-labelledby="upload-heading">
          <h2 id="upload-heading">上傳 / 預覽 / 刪除附件</h2>
          <p className="placeholder-note">
            （PHASE-004-T11：關聯操作已隨公開 link 端點一併移除，見上方檔頭註解）
          </p>
          <AttachmentUploader
            refType={refType}
            refId={refId}
            limit={limit}
            initialAttachments={[]}
          />
        </section>
      </main>
    </div>
  );
}
