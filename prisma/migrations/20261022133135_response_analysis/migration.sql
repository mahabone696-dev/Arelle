-- CreateEnum
CREATE TYPE "CitationOwner" AS ENUM ('PRIMARY', 'COMPETITOR', 'THIRD_PARTY');

-- CreateEnum
CREATE TYPE "ScanAnalysisStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "BrandMention" ADD COLUMN     "occurrences" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "snippet" TEXT;

-- AlterTable
ALTER TABLE "Citation" ADD COLUMN     "competitorId" TEXT,
ADD COLUMN     "ownerType" "CitationOwner" NOT NULL DEFAULT 'THIRD_PARTY';

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "analysisCompletedAt" TIMESTAMPTZ(3),
ADD COLUMN     "analysisError" TEXT,
ADD COLUMN     "analysisStatus" "ScanAnalysisStatus";

-- CreateTable
CREATE TABLE "ResponseAnalysis" (
    "id" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "analysisVersion" INTEGER NOT NULL,
    "method" "ExtractionMethod" NOT NULL,
    "primaryMentioned" BOOLEAN NOT NULL,
    "primaryPosition" INTEGER,
    "primarySentiment" DOUBLE PRECISION,
    "recommendationStrength" DOUBLE PRECISION,
    "primaryCited" BOOLEAN NOT NULL,
    "brandsMentionedCount" INTEGER NOT NULL,
    "citationCount" INTEGER NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResponseAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResponseAnalysis_responseId_analysisVersion_key" ON "ResponseAnalysis"("responseId", "analysisVersion");

-- AddForeignKey
ALTER TABLE "ResponseAnalysis" ADD CONSTRAINT "ResponseAnalysis_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "AIResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Citation" ADD CONSTRAINT "Citation_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Analytic history is append-only: reject UPDATE on analysis rows and snapshots.
-- (Reuses the pattern of ai_response_immutable from scan_pipeline.)
CREATE OR REPLACE FUNCTION reject_history_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only (id=%)', TG_TABLE_NAME, OLD.id USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER response_analysis_no_update BEFORE UPDATE ON "ResponseAnalysis" FOR EACH ROW EXECUTE FUNCTION reject_history_update();
CREATE TRIGGER brand_mention_no_update BEFORE UPDATE ON "BrandMention" FOR EACH ROW EXECUTE FUNCTION reject_history_update();
CREATE TRIGGER citation_no_update BEFORE UPDATE ON "Citation" FOR EACH ROW EXECUTE FUNCTION reject_history_update();
CREATE TRIGGER visibility_snapshot_no_update BEFORE UPDATE ON "VisibilitySnapshot" FOR EACH ROW EXECUTE FUNCTION reject_history_update();
