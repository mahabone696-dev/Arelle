-- Existing approved prompts were reviewed when approved.
UPDATE "Prompt" SET "reviewedAt" = "approvedAt" WHERE "approvedAt" IS NOT NULL AND "reviewedAt" IS NULL;
