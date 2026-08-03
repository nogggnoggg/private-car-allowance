-- PHASE-005a-T1（Spec §8.1/§8.2/§8.3；M1~M4）
-- 全部為新增（CREATE TYPE / CREATE TABLE / ADD COLUMN，皆 NULL、無回填）。
-- 不含任何 UPDATE／DELETE／既有欄位型別變更／NOT NULL 加設（§8.6 硬性要求）。

-- CreateEnum
CREATE TYPE "FuelType" AS ENUM ('GASOLINE_92', 'GASOLINE_95', 'GASOLINE_98', 'DIESEL');

-- CreateTable
CREATE TABLE "FuelPriceVersion" (
    "id" TEXT NOT NULL,
    "fuelType" "FuelType" NOT NULL,
    "pricePerLiter" DECIMAL(10,4) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FuelPriceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserFuelConsumptionVersion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fuelType" "FuelType" NOT NULL,
    "kmPerLiter" DECIMAL(10,4) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "basisNote" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserFuelConsumptionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FuelPriceVersion_fuelType_effectiveFrom_key" ON "FuelPriceVersion"("fuelType", "effectiveFrom");

-- CreateIndex
CREATE INDEX "FuelPriceVersion_fuelType_effectiveFrom_idx" ON "FuelPriceVersion"("fuelType", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "UserFuelConsumptionVersion_userId_effectiveFrom_key" ON "UserFuelConsumptionVersion"("userId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "UserFuelConsumptionVersion_userId_effectiveFrom_idx" ON "UserFuelConsumptionVersion"("userId", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "UserFuelConsumptionVersion" ADD CONSTRAINT "UserFuelConsumptionVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable（TravelApplication 五欄擴充；全部 nullable，無 default，零回填）
ALTER TABLE "TravelApplication" ADD COLUMN     "snapshotFuelType" "FuelType",
ADD COLUMN     "snapshotFuelPricePerLiter" DECIMAL(10,4),
ADD COLUMN     "snapshotFuelConsumption" DECIMAL(10,4),
ADD COLUMN     "fuelPriceVersionId" TEXT,
ADD COLUMN     "fuelConsumptionVersionId" TEXT;

-- CreateIndex
CREATE INDEX "TravelApplication_fuelPriceVersionId_idx" ON "TravelApplication"("fuelPriceVersionId");

-- CreateIndex
CREATE INDEX "TravelApplication_fuelConsumptionVersionId_idx" ON "TravelApplication"("fuelConsumptionVersionId");
