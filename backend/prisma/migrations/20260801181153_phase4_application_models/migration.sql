-- CreateEnum
CREATE TYPE "ApplicationType" AS ENUM ('TRAVEL', 'MAINTENANCE', 'DEPRECIATION');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('DRAFT', 'COMPLETED', 'VOIDED');

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "type" "ApplicationType" NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'DRAFT',
    "ownerId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "primaryDate" DATE NOT NULL,
    "totalAmount" INTEGER,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TravelApplication" (
    "applicationId" TEXT NOT NULL,
    "tripDate" DATE,
    "purpose" TEXT,
    "fuelUnitPrice" DECIMAL(10,4),
    "etcUnitPrice" DECIMAL(10,4),
    "fuelParameterVersionId" TEXT,
    "etcParameterVersionId" TEXT,
    "snapshotTotalKm" DECIMAL(12,2),
    "snapshotRawAmount" DECIMAL(14,4),
    "calculatedAt" TIMESTAMP(3),

    CONSTRAINT "TravelApplication_pkey" PRIMARY KEY ("applicationId")
);

-- CreateTable
CREATE TABLE "TripSegment" (
    "id" TEXT NOT NULL,
    "travelApplicationId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "origin" TEXT,
    "destination" TEXT,
    "totalKm" DECIMAL(10,2),
    "highwayKm" DECIMAL(10,2),
    "snapshotFuelAmount" DECIMAL(14,4),
    "snapshotEtcAmount" DECIMAL(14,4),
    "snapshotRawAmount" DECIMAL(14,4),
    "snapshotAmount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripSegment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Application_ownerId_status_primaryDate_idx" ON "Application"("ownerId", "status", "primaryDate");

-- CreateIndex
CREATE INDEX "Application_ownerId_primaryDate_idx" ON "Application"("ownerId", "primaryDate");

-- CreateIndex
CREATE INDEX "Application_type_status_idx" ON "Application"("type", "status");

-- CreateIndex
CREATE INDEX "Application_primaryDate_idx" ON "Application"("primaryDate");

-- CreateIndex
CREATE INDEX "TravelApplication_tripDate_idx" ON "TravelApplication"("tripDate");

-- CreateIndex
CREATE INDEX "TravelApplication_fuelParameterVersionId_idx" ON "TravelApplication"("fuelParameterVersionId");

-- CreateIndex
CREATE INDEX "TravelApplication_etcParameterVersionId_idx" ON "TravelApplication"("etcParameterVersionId");

-- CreateIndex
CREATE INDEX "TripSegment_travelApplicationId_sortOrder_idx" ON "TripSegment"("travelApplicationId", "sortOrder");

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelApplication" ADD CONSTRAINT "TravelApplication_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripSegment" ADD CONSTRAINT "TripSegment_travelApplicationId_fkey" FOREIGN KEY ("travelApplicationId") REFERENCES "TravelApplication"("applicationId") ON DELETE CASCADE ON UPDATE CASCADE;
