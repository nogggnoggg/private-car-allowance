/**
 * Void-reason validation — PHASE-009-T3
 *
 * Spec §2 AC-03、§5 邊界條件 B-01~B-05、§16 D3(a)（人類已批准）。
 *
 * Pure function, zero IO — no prisma client, no env access. Single source of
 * truth for "is this a legal `reason` value for `POST /applications/:id/void`"
 * (§7.3 body `{ reason: string }`), consumed by `application-void.ts`'s
 * `voidApplication` (this Task) and, later, by the HTTP route (T4, which
 * reads `request.body.reason` and passes it through unvalidated).
 *
 * D3(a) 逐字裁定：`trim` 後長度須落於 1..500；僅空白字元（含全形空白
 * `　`、Tab、換行）視同空 → 拒絕；持久化值為 `trim` 後之字串。JavaScript
 * `String.prototype.trim()` 已涵蓋 Unicode `White_Space` 全集（含 U+3000
 * 全形空白、`\t`、`\n`、`\r`），故毋須另寫字元類別判斷。
 *
 * XSS payload（B-04）刻意**不**在此處跳脫或拒絕——原樣接受、原樣持久化；
 * 跳脫是「呈現」責任（列印版，T11 `escapeHtml`），非「驗證」責任，兩者不得
 * 合併（沿全案既定分工：驗證只管格式合法性，跳脫只管輸出安全）。
 */
import type { FieldError } from "../platform/errors.js";

/** D3(a) 逐字裁定：上界 500（trim 後）。 */
export const VOID_REASON_MAX_LENGTH = 500;

export type VoidReasonValidation = { ok: true; value: string } | { ok: false; error: FieldError };

const REQUIRED_MESSAGE = "作廢原因為必填，請輸入 1 至 500 字元";
const TOO_LONG_MESSAGE = `作廢原因不可超過 ${VOID_REASON_MAX_LENGTH} 字元`;

/**
 * 驗證作廢原因（AC-03、B-01~B-05）：
 *   - 缺鍵／`null`／非字串 → 拒絕（`REQUIRED_MESSAGE`）
 *   - `trim` 後長度 0（含僅空白，含全形空白／Tab／換行） → 拒絕（同上）
 *   - `trim` 後長度 > 500 → 拒絕（`TOO_LONG_MESSAGE`）
 *   - 其餘 → 接受，`value` 為 `trim` 後之字串（B-03：前後空白不入庫）
 */
export function validateVoidReason(input: unknown): VoidReasonValidation {
  if (typeof input !== "string") {
    return { ok: false, error: { field: "reason", reason: REQUIRED_MESSAGE } };
  }

  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return { ok: false, error: { field: "reason", reason: REQUIRED_MESSAGE } };
  }

  if (trimmed.length > VOID_REASON_MAX_LENGTH) {
    return { ok: false, error: { field: "reason", reason: TOO_LONG_MESSAGE } };
  }

  return { ok: true, value: trimmed };
}
