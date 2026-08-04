-- PHASE-007-T1 (Spec docs/specs/PHASE-007.md §8.4 M1)
--   純 CREATE：既有八表零 ALTER、零回填；不新增任何 enum 值（AC-01(c)(e)）。
--   `Application.depreciation` 為 Prisma schema 層之反向關聯，不產生 DDL。
--   回滾：DROP TABLE "DepreciationApplication"（補償步驟見 §8.4）。

-- CreateTable
CREATE TABLE "DepreciationApplication" (
    "applicationId" TEXT NOT NULL,
    "applicationYear" INTEGER,
    "snapshotVehiclePrice" DECIMAL(12,2),
    "snapshotUsefulLifeYears" INTEGER,
    "snapshotEstimatedAnnualKm" INTEGER,
    "snapshotPerKmUnitPrice" DECIMAL(14,4),
    "snapshotOfficialKm" DECIMAL(12,2),
    "snapshotRawAmount" DECIMAL(14,4),
    "calculatedAt" TIMESTAMP(3),
    "depreciationParameterVersionId" TEXT,

    CONSTRAINT "DepreciationApplication_pkey" PRIMARY KEY ("applicationId")
);

-- CreateIndex
CREATE INDEX "DepreciationApplication_applicationYear_idx" ON "DepreciationApplication"("applicationYear");

-- CreateIndex
CREATE INDEX "DepreciationApplication_depreciationParameterVersionId_idx" ON "DepreciationApplication"("depreciationParameterVersionId");

-- AddForeignKey
ALTER TABLE "DepreciationApplication" ADD CONSTRAINT "DepreciationApplication_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
