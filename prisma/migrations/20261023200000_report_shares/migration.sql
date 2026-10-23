-- AlterTable
ALTER TABLE "ReportShare" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "lastViewedAt" TIMESTAMPTZ(3),
ADD COLUMN     "range" VARCHAR(8) NOT NULL DEFAULT '30d',
ADD COLUMN     "viewCount" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "ReportShare" ADD CONSTRAINT "ReportShare_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

