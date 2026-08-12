/**
 * Audit service — PHASE-002-T10.
 *
 * Writes AuditLog entries for admin account-management operations.
 * Spec §7 / AC-26 / AC-27:
 *   - Supported actions: USER_CREATED, USER_DEACTIVATED, USER_ACTIVATED,
 *     USER_PASSWORD_RESET, USER_DELETED
 *   - Passwords must NEVER appear in any audit record (AC-27).
 *   - Audit write failure must NOT fail the primary operation: wrap in
 *     try/catch and log a classification label only — never the exception
 *     message/stack, never the summary (fire-and-forget safety pattern;
 *     日誌內容之邊界見下方 AC-30(d)／AC-28(c)②)。
 *
 * Design notes:
 *   - writeAudit is async but callers await it; failure is swallowed.
 *   - summary is built by the caller and must not include any password field.
 *
 * ---------------------------------------------------------------------------
 * 可靠性語意與其裁定（PHASE-011-T18；Spec §2 AC-30／§16 D16-5=(i)）
 * ---------------------------------------------------------------------------
 * 現況（刻意保留，非疏漏）：帳號類五事件（`admin/routes.ts` 之 USER_CREATED／
 * USER_DEACTIVATED／USER_ACTIVATED／USER_PASSWORD_RESET／USER_DELETED）經本
 * helper 寫稽核，走**非同交易**之 best-effort 路徑——主操作先各自提交，稽核寫入
 * 失敗只被吞掉並記一行分類日誌，因此**稽核可能靜默遺失**（`KNOWN_ISSUES.md`
 * §5-16）。其餘 12 處稽核寫入則與其業務寫入同交易（`tx.auditLog.create`）。
 * 此不對稱為已知且經人類**明示接受**（`PHASE-010.md` §16 D11=(a)「本期不動、
 * 移交 011」），PHASE-011 之裁定為 §16 **D16-5=(i)「僅固化現況」**：零行為變更，
 * 把已被接受的現況變成**有守門的顯性選擇**。
 *
 * ⚠ **未經人類裁定不得改為同交易**（Spec AC-30(c) 逐字：該變更會使管理操作因
 * 稽核失敗而 500，屬**使用者可見行為變更**）。要改，先回 Spec §16 D16-5 取得
 * 人類裁定，不得由實作端自行升級。
 *
 * 守門格：`backend/test/integration/phase11-audit-reliability.test.ts`
 *   · 現況固化（真實端點 × 注入稽核寫入失敗 → 主操作仍 2xx、稽核列為零）；
 *   · 失效行為＝吞掉（(i) 之語意），含防恆真與鑑別力自證；
 *   · 不對稱之結構快照（同交易 12／fire-and-forget 1／呼叫端 5）——任一方向的
 *     偏移都會讓它翻紅。
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
 * `targetId` 以**純量欄位**直接寫入（`schema.prisma` :93 之 `targetId String?`
 * ＋ :94 之選用關聯），不走 Prisma 的 `connect`／`disconnect` 關聯語法——如此
 * USER_DELETED 才能在目標使用者已不存在時仍寫得出一列（`targetId = null`，
 * 可讀性由 `targetLabel` 之快照承擔）。
 * 〔PHASE-011-T18 觸檔即校檔頭：原註解稱此處為「connect/disconnect pattern」
 * 與實作不符（本函式從未使用該語法），一併更正。〕
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
    // PHASE-011-T18（AR-4，T16 即審建議）：補記 `action`——它是 AuditAction 之
    // 10 值封閉列舉、零自由文字、零 PII，故不受 AC-30(d) 之限制，卻能答回
    // 「是哪一類稽核寫失敗」這個在 T16 拿掉 err.message 之後失去的脈絡。
    // 刻意**不**記 targetLabel／targetId（帳號名與識別碼），亦不記 detail。
    console.error(
      "[audit] Failed to write AuditLog:",
      action,
      err instanceof Error ? err.name : "UnknownError"
    );
  }
}
