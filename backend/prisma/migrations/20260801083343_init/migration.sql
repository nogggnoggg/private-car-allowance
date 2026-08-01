-- CreateTable
CREATE TABLE "HealthProbe" (
    "id" SERIAL NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthProbe_pkey" PRIMARY KEY ("id")
);
