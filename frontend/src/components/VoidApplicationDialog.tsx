/**
 * VoidApplicationDialog — PHASE-009-T14（AC-29／AC-33 作廢側五態）
 *
 * 已完成申請之「作廢」二次確認對話框：沿既有 `.dialog-overlay` ＋
 * `<dialog open className="dialog-box">` 慣例（TravelApplicationPage 之刪除／
 * 完成確認框、AdminUsersPage 之停用確認框皆同形），差別僅在本框多一個**必填
 * 的作廢原因輸入欄**。
 *
 * 本元件只負責「對話框本身」，不負責入口按鈕與作廢後的頁面呈現——三型詳情頁
 * 之接線（作廢按鈕、作廢資訊區塊）歸 PHASE-009-T15。
 *
 * 設計要點：
 *   (a) AC-29(c)「前端第一道」：原因為空或**僅空白**時確認鈕停用，點擊零
 *       `POST`。空白判定用 `trim()`——JS 的 `\s`／`trim()` 涵蓋全形空白
 *       U+3000、Tab、換行（與後端 `void-reason.ts` 的 gate table 同語意）。
 *       但**不**在前端 trim 後送出：驗證與 trim 的唯一事實來源在後端
 *       （B-03），前端只做「不送明顯無效的請求」這一層 UX 守門。
 *   (b) AC-33 Permission denied：403 之後**零後續請求**——刻意把整個表單
 *       （原因欄＋確認鈕）換成無權限訊息，連重試鈕都不提供（沿
 *       ReportSection 之 `permission-denied` 態同一紀律）。
 *   (c) 409：狀態已被他處改變（例如另一分頁已作廢），重送必然再 409，故不
 *       提供「重試」而提供「重新載入」，由呼叫端重讀申請詳情。
 *   (d) 400：**同時**顯示 `error.message` 與 `fields[]` 之逐欄 `reason`——
 *       只顯示其一會在 `fields` 對不到輸入欄時靜默吞錯。
 */

import type React from "react";
import { useState } from "react";
import { apiVoidApplication } from "../api/applications.js";
import type { ApiError } from "../types/api.js";

interface Props {
  applicationId: string;
  /** 取消（零請求、零狀態變更）。 */
  onCancel: () => void;
  /** 作廢成功——參數為後端回傳之型別分派詳情 DTO。 */
  onVoided: (application: unknown) => void;
  /** 409 狀態衝突時之「重新載入」——由呼叫端重讀申請詳情。 */
  onReload: () => void;
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string; fieldReason: string | null }
  | { kind: "conflict"; message: string }
  | { kind: "permission-denied"; message: string };

export default function VoidApplicationDialog({
  applicationId,
  onCancel,
  onVoided,
  onReload,
}: Props): React.ReactElement {
  const [reason, setReason] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  const submitting = state.kind === "submitting";
  const denied = state.kind === "permission-denied";
  const reasonBlank = reason.trim().length === 0;

  async function handleConfirm() {
    // 防重複提交（AC-29(d)）＋前端第一道（AC-29(c)）——按鈕已 disabled，此處
    // 為程式面的第二道，確保任何路徑都不會送出空白原因或並發第二個請求。
    if (submitting || reasonBlank) return;
    setState({ kind: "submitting" });
    try {
      const { application } = await apiVoidApplication(applicationId, reason);
      onVoided(application);
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "FORBIDDEN") {
        setState({ kind: "permission-denied", message: "無權作廢此申請。" });
        return;
      }
      if (apiErr.code === "CONFLICT") {
        setState({
          kind: "conflict",
          message: apiErr.message ?? "申請狀態已變更，無法作廢。",
        });
        return;
      }
      const fieldReason = apiErr.fields?.find((f) => f.field === "reason")?.reason ?? null;
      setState({
        kind: "error",
        message: apiErr.message ?? "作廢失敗，請稍後再試。",
        fieldReason,
      });
    }
  }

  return (
    <div className="dialog-overlay">
      <dialog open className="dialog-box" aria-label="確認作廢申請">
        <h3>確認作廢申請</h3>

        {denied ? (
          <div className="permission-denied-block" role="alert">
            <p>{state.message}</p>
          </div>
        ) : (
          <>
            <p>作廢後將無法復原，且無法恢復為已完成。確定要作廢這筆申請嗎？</p>

            <div className="form-group">
              <label htmlFor="void-reason">作廢原因</label>
              <textarea
                id="void-reason"
                className="void-reason-input"
                rows={3}
                value={reason}
                disabled={submitting}
                onChange={(e) => setReason(e.target.value)}
              />
              {/* 確認鈕在原因空白時停用（AC-29(c)），此提示說明停用的原因，
                  沿既有 `.warn-text` 提示樣式（不另立新 class）。 */}
              <p className="warn-text">作廢原因為必填，將記錄於申請與列印版報表。</p>
            </div>

            {state.kind === "error" && (
              <div className="error-block" role="alert">
                <p>{state.message}</p>
                {state.fieldReason && <p>{state.fieldReason}</p>}
              </div>
            )}

            {state.kind === "conflict" && (
              <div className="error-block" role="alert">
                <p>{state.message}</p>
                <button type="button" className="btn btn-secondary" onClick={onReload}>
                  重新載入
                </button>
              </div>
            )}
          </>
        )}

        <div className="btn-row">
          {!denied && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={handleConfirm}
              disabled={submitting || reasonBlank}
            >
              {submitting ? "作廢中…" : "確認作廢"}
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={submitting}
          >
            {denied ? "關閉" : "取消"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
