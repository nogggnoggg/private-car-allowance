-- AlterTable
ALTER TABLE "DepreciationApplication" ADD COLUMN     "annualTotalKm" DECIMAL(9,1),
ADD COLUMN     "snapshotAnnualDepreciation" DECIMAL(12,2),
ADD COLUMN     "snapshotAnnualTotalKm" DECIMAL(9,1),
ADD COLUMN     "snapshotRatio" DECIMAL(9,6);

-- AlterTable
ALTER TABLE "DepreciationParameterVersion" ALTER COLUMN "estimatedAnnualKm" DROP NOT NULL;

