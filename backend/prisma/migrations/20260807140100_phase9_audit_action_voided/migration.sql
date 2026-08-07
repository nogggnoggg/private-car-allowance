-- PHASE-009-T1（Spec §8.5/D10(a)）
-- AlterEnum — 純新增一個列舉值，無既有資料使用該值。
-- ALTER TYPE ... ADD VALUE 不可與使用該值的操作放在同一交易內，故獨立成檔
-- （沿 PHASE-004/PHASE-005a 既有先例）。

ALTER TYPE "AuditAction" ADD VALUE 'APPLICATION_VOIDED';
