-- Prompts that were active before review existed count as approved.
UPDATE "Prompt" SET "approvedAt" = "createdAt" WHERE "isActive" = true AND "approvedAt" IS NULL;

-- Projects that already have active prompts have completed setup.
UPDATE "Project" p
SET "onboardingStep" = 'COMPLETED', "onboardingCompletedAt" = NOW()
WHERE "onboardingCompletedAt" IS NULL
  AND EXISTS (SELECT 1 FROM "Prompt" pr WHERE pr."projectId" = p."id" AND pr."isActive" = true);
