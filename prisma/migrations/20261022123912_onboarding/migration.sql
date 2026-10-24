-- CreateEnum
CREATE TYPE "OnboardingStep" AS ENUM ('ANALYZE', 'BRAND', 'COMPETITORS', 'PROMPTS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "WebsiteAnalysisStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- AlterEnum
ALTER TYPE "EntitySource" ADD VALUE 'TEMPLATE';

-- AlterTable
ALTER TABLE "Competitor" ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "reason" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "onboardingCompletedAt" TIMESTAMPTZ(3),
ADD COLUMN     "onboardingStep" "OnboardingStep" NOT NULL DEFAULT 'ANALYZE';

-- AlterTable
ALTER TABLE "Prompt" ADD COLUMN     "approvedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "WebsiteAnalysis" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "WebsiteAnalysisStatus" NOT NULL DEFAULT 'RUNNING',
    "method" "ExtractionMethod",
    "requestedUrl" TEXT NOT NULL,
    "homepageUrl" TEXT,
    "site" TEXT,
    "robotsStatus" TEXT,
    "pagesCrawled" INTEGER NOT NULL DEFAULT 0,
    "pages" JSONB NOT NULL DEFAULT '[]',
    "failures" JSONB NOT NULL DEFAULT '[]',
    "extraction" JSONB,
    "aiProvider" TEXT,
    "aiModel" TEXT,
    "aiAttempts" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedCost" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "WebsiteAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebsiteAnalysis_projectId_createdAt_idx" ON "WebsiteAnalysis"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "WebsiteAnalysis_createdAt_idx" ON "WebsiteAnalysis"("createdAt");

-- AddForeignKey
ALTER TABLE "WebsiteAnalysis" ADD CONSTRAINT "WebsiteAnalysis_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteAnalysis" ADD CONSTRAINT "WebsiteAnalysis_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
