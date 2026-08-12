/**
 * Audit service — PHASE-002-T10.
 *
 * Writes AuditLog entries for admin account-management operations.
 * Spec §7 / AC-26 / AC-27:
 *   - Supported actions: USER_CREATED, USER_DEACTIVATED, USER_ACTIVATED,
 *     USER_PASSWORD_RESET, USER_DELETED
 *   - Passwords must NEVER appear in any audit record (AC-27).
 *   - Audit write failure must NOT fail the primary operation: wrap in
 *     try/catch and log the error (fire-and-forget safety pattern).
 *
 * Design notes:
 *   - writeAudit is async but callers await it; failure is swallowed.
 *   - summary is built by the caller and must not include any password field.
 */

import type { AuditAction, PrismaClient } from "@prisma/client";

export interface WriteAuditParams {
  prisma: PrismaClient;
  actorId: string;
  action: AuditAction;
  /** targetId: null for USER_DELETED (user no longer exists in DB) */
  targetId: string | null;
  /** targetLabel: stable snapshot (loginName) — survives user deletion */
  targetLabel: string;
  /** summary: non-sensitive JSON; MUST NOT contain any password field */
  detail?: Record<string, unknown>;
}

/**
 * Write a single AuditLog row.
 *
 * Failures are caught and logged to console.error (not re-thrown):
 * the primary admin operation has already succeeded and audit is
 * best-effort for write robustness (Spec §7 D11-compatible approach).
 *
 * The connect/disconnect pattern for targetId handles the nullable
 * FK case for USER_DELETED where the target user no longer exists.
 */
export async function writeAudit(params: WriteAuditParams): Promise<void> {
  const { prisma, actorId, action, targetId, targetLabel, detail } = params;

  try {
    await prisma.auditLog.create({
      data: {
        action,
        actorId,
        targetId,
        targetLabel,
        summary: detail as import("@prisma/client").Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    // Audit write failure must not propagate (Spec §7 / fire-and-forget safety).
    // PHASE-011-T16（AC-28(c)②）：不把 err 物件直接交給 console.error——Node 對
    // Error 引數會印出完整 stack（逐字含絕對路徑，可能挾帶連線資訊，見
    // KNOWN_ISSUES.md D-9／§13 #1）。只記分類標籤（err.name），不記 message／
    // stack，亦不記 detail/summary（AC-30(d) 同批處理）。
    console.error(
      "[audit] Failed to write AuditLog:",
      err instanceof Error ? err.name : "UnknownError"
    );
  }
}
