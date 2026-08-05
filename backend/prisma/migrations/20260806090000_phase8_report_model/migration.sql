-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "reportNumber" TEXT NOT NULL,
    "numberPrefix" TEXT NOT NULL,
    "numberPeriod" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "generatedById" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Report_applicationId_key" ON "Report"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "Report_reportNumber_key" ON "Report"("reportNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Report_storageKey_key" ON "Report"("storageKey");

-- CreateIndex
CREATE INDEX "Report_numberPrefix_numberPeriod_idx" ON "Report"("numberPrefix", "numberPeriod");

-- CreateIndex
CREATE UNIQUE INDEX "Report_numberPrefix_numberPeriod_sequence_key" ON "Report"("numberPrefix", "numberPeriod", "sequence");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

