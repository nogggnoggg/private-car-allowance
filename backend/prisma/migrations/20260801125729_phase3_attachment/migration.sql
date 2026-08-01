-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('TEMP', 'LINKED');

-- CreateEnum
CREATE TYPE "AttachmentRefType" AS ENUM ('TRIP_SEGMENT', 'MAINTENANCE', 'DEPRECIATION');

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'TEMP',
    "storageKey" TEXT NOT NULL,
    "thumbnailKey" TEXT,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "refType" "AttachmentRefType",
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");

-- CreateIndex
CREATE INDEX "Attachment_ownerId_idx" ON "Attachment"("ownerId");

-- CreateIndex
CREATE INDEX "Attachment_status_idx" ON "Attachment"("status");

-- CreateIndex
CREATE INDEX "Attachment_refType_refId_idx" ON "Attachment"("refType", "refId");

-- CreateIndex
CREATE INDEX "Attachment_createdAt_idx" ON "Attachment"("createdAt");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
