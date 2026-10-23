-- DropForeignKey
ALTER TABLE "ActionMeasurement" DROP CONSTRAINT "ActionMeasurement_scanId_fkey";

-- AlterTable
ALTER TABLE "Action" ADD COLUMN     "baselineAnswers" INTEGER,
ADD COLUMN     "scopePromptIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ActionMeasurement" ADD COLUMN     "afterAnswers" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN     "dismissedAt" TIMESTAMPTZ(3),
ADD COLUMN     "lastDetectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "resolvedAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE UNIQUE INDEX "ActionMeasurement_actionId_scanId_key" ON "ActionMeasurement"("actionId", "scanId");

-- CreateIndex
CREATE UNIQUE INDEX "Recommendation_opportunityId_type_key" ON "Recommendation"("opportunityId", "type");

-- AddForeignKey
ALTER TABLE "ActionMeasurement" ADD CONSTRAINT "ActionMeasurement_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Observed before/after measurements are history: never rewritten.
CREATE TRIGGER action_measurement_no_update BEFORE UPDATE ON "ActionMeasurement" FOR EACH ROW EXECUTE FUNCTION reject_history_update();
