-- CreateTable
CREATE TABLE "FuelParameterVersion" (
    "id" TEXT NOT NULL,
    "unitPrice" DECIMAL(10,4) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FuelParameterVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EtcParameterVersion" (
    "id" TEXT NOT NULL,
    "unitPrice" DECIMAL(10,4) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EtcParameterVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepreciationParameterVersion" (
    "id" TEXT NOT NULL,
    "vehiclePrice" DECIMAL(12,2) NOT NULL,
    "usefulLifeYears" INTEGER NOT NULL,
    "estimatedAnnualKm" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepreciationParameterVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FuelParameterVersion_effectiveFrom_idx" ON "FuelParameterVersion"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "FuelParameterVersion_effectiveFrom_key" ON "FuelParameterVersion"("effectiveFrom");

-- CreateIndex
CREATE INDEX "EtcParameterVersion_effectiveFrom_idx" ON "EtcParameterVersion"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "EtcParameterVersion_effectiveFrom_key" ON "EtcParameterVersion"("effectiveFrom");

-- CreateIndex
CREATE INDEX "DepreciationParameterVersion_effectiveFrom_idx" ON "DepreciationParameterVersion"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "DepreciationParameterVersion_effectiveFrom_key" ON "DepreciationParameterVersion"("effectiveFrom");
