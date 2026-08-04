-- PHASE-006-T1（Spec §8.2/§8.4 M1）
-- 全新子表：CREATE TABLE + FK + index，零 ALTER、零回填（§8.4 硬性要求）。
-- 回滾＝DROP TABLE "MaintenanceApplication"（FK 為 CASCADE，故無需額外清理
-- Application 端；回滾前若有 Attachment.refType='MAINTENANCE' 之附件引用本表
-- 所屬 applicationId，須依 rollback 手冊先行 detach/補償，本檔不處理附件）。

-- CreateTable
CREATE TABLE "MaintenanceApplication" (
    "applicationId" TEXT NOT NULL,
    "lastMaintenanceDate" DATE,
    "currentMaintenanceDate" DATE,
    "lastOdometerKm" DECIMAL(10,2),
    "currentOdometerKm" DECIMAL(10,2),
    "actualCost" DECIMAL(12,2),
    "snapshotIntervalKm" DECIMAL(12,2),
    "snapshotOfficialKm" DECIMAL(12,2),
    "snapshotRatio" DECIMAL(9,6),
    "snapshotRawAmount" DECIMAL(14,4),
    "calculatedAt" TIMESTAMP(3),

    CONSTRAINT "MaintenanceApplication_pkey" PRIMARY KEY ("applicationId")
);

-- CreateIndex
CREATE INDEX "MaintenanceApplication_currentMaintenanceDate_idx" ON "MaintenanceApplication"("currentMaintenanceDate");

-- AddForeignKey
ALTER TABLE "MaintenanceApplication" ADD CONSTRAINT "MaintenanceApplication_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
