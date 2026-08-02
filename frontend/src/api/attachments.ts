import { parseApiResponse } from "../types/api.js";

export type AttachmentStatus = "TEMP" | "LINKED";
export type AttachmentRefType = "TRIP_SEGMENT" | "MAINTENANCE" | "DEPRECIATION";

/**
 * Convert a backend-relative attachment URL (e.g. "/attachments/:id/thumbnail")
 * to the frontend-usable URL with the /api prefix (e.g. "/api/attachments/:id/thumbnail").
 *
 * This is required because:
 *   - The backend DTO exposes internal paths without /api prefix.
 *   - The frontend accesses the backend via the /api proxy (Vite dev: proxy /api → :3000;
 *     production: nginx /api → backend). All attachment content endpoints require auth,
 *     so they must go through the proxy, not be accessed directly.
 *   - The browser sends session cookies automatically with same-origin requests.
 */
export function toFrontendUrl(backendRelativeUrl: string): string {
  if (backendRelativeUrl.startsWith("/api/")) return backendRelativeUrl;
  return `/api${backendRelativeUrl}`;
}

export interface AttachmentDto {
  id: string;
  status: AttachmentStatus;
  mimeType: string;
  byteSize: number;
  originalFilename: string;
  refType?: AttachmentRefType | null;
  refId?: string | null;
  previewUrl: string;
  downloadUrl: string;
}

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
export const ATTACHMENT_ACCEPTED_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
export const ATTACHMENT_ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Client-side pre-flight check before sending. Returns error message or null. */
export function validateFileBeforeUpload(file: File): string | null {
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return `檔案大小超過上限（最大 10 MB），目前檔案為 ${(file.size / 1024 / 1024).toFixed(1)} MB。`;
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mimeOk = ATTACHMENT_ACCEPTED_MIME_TYPES.includes(file.type);
  const extOk = ATTACHMENT_ACCEPTED_EXTENSIONS.includes(ext);
  if (!mimeOk || !extOk) {
    return "格式不支援，僅接受 JPG、PNG、WebP 圖片。";
  }
  return null;
}

/** POST /api/attachments — upload a file */
export async function apiUploadAttachment(file: File): Promise<{ attachment: AttachmentDto }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/attachments", {
    method: "POST",
    credentials: "include",
    body: form,
  });
  return parseApiResponse<{ attachment: AttachmentDto }>(res);
}

// apiLinkAttachment (POST /api/attachments/:id/link) — REMOVED (PHASE-004-T11, D12).
// The public link endpoint was removed on the backend (AR-D 閉環): it let a
// caller self-supply `limit`/`refId`/`containerState`, which would have been a
// real authorization bypass once PHASE-004 has real completed applications.
// Attachment linking is now driven exclusively by `PUT /applications/travel/:id`'s
// `attachmentIds[]` (see frontend/src/pages travel form, T13).

/** DELETE /api/attachments/:id — delete/unlink an attachment */
export async function apiDeleteAttachment(attachmentId: string): Promise<void> {
  const res = await fetch(`/api/attachments/${attachmentId}`, {
    method: "DELETE",
    credentials: "include",
  });
  await parseApiResponse<{ ok: boolean }>(res);
}
