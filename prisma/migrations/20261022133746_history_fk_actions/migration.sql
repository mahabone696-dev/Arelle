-- DropForeignKey
ALTER TABLE "AIResponse" DROP CONSTRAINT "AIResponse_modelId_fkey";

-- DropForeignKey
ALTER TABLE "BrandMention" DROP CONSTRAINT "BrandMention_competitorId_fkey";

-- DropForeignKey
ALTER TABLE "Citation" DROP CONSTRAINT "Citation_competitorId_fkey";

-- DropForeignKey
ALTER TABLE "VisibilitySnapshot" DROP CONSTRAINT "VisibilitySnapshot_providerId_fkey";

-- DropForeignKey
ALTER TABLE "VisibilitySnapshot" DROP CONSTRAINT "VisibilitySnapshot_scanId_fkey";

-- AddForeignKey
ALTER TABLE "AIResponse" ADD CONSTRAINT "AIResponse_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "AIModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandMention" ADD CONSTRAINT "BrandMention_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Citation" ADD CONSTRAINT "Citation_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisibilitySnapshot" ADD CONSTRAINT "VisibilitySnapshot_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisibilitySnapshot" ADD CONSTRAINT "VisibilitySnapshot_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AIProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
