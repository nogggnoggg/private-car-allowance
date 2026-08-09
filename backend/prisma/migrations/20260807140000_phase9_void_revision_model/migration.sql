-- PHASE-009-T1（Spec §8.1/§8.2/§8.5；D1=a／D4=b1／D7=a 已裁定）
-- AlterTable: Application 新增四個作廢／版本關聯欄（皆 nullable、無 default，
-- 對既有列為純中繼資料操作，零改寫、零回填）。
ALTER TABLE "Application" ADD COLUMN     "supersedesId" TEXT,
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" TEXT;

-- CreateTable: VoidedReportFile（§8.2；D4=b1——作廢時同交易產生之作廢版 PDF，
-- 獨立表以維持 Report 零更新／刪除路徑之既有結構性守門）
CREATE TABLE "VoidedReportFile" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoidedReportFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VoidedReportFile_reportId_key" ON "VoidedReportFile"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "VoidedReportFile_storageKey_key" ON "VoidedReportFile"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "Application_supersedesId_key" ON "Application"("supersedesId");

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoidedReportFile" ADD CONSTRAINT "VoidedReportFile_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
