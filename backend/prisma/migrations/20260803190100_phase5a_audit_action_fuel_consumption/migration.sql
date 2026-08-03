-- PHASE-005a-T1（Spec §8.1/§8.6 M5）
-- AlterEnum — 純新增一個列舉值，無既有資料使用該值。
-- ALTER TYPE ... ADD VALUE 不可與使用該值的操作放在同一交易內，故獨立成檔
-- （Spec §8.6 實作提醒）。

ALTER TYPE "AuditAction" ADD VALUE 'USER_FUEL_CONSUMPTION_VERSION_CREATED';
