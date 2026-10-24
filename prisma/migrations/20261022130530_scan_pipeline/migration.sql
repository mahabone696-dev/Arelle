-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "plan" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "promptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "providerCount" INTEGER NOT NULL DEFAULT 0;

-- AIResponse rows are immutable historical records. Reject any UPDATE at the
-- database level so no code path (or manual query) can rewrite collected answers.
-- DELETE stays possible only via cascades (e.g. project/organization deletion).
CREATE OR REPLACE FUNCTION ai_response_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AIResponse rows are immutable (id=%)', OLD.id USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_response_no_update
  BEFORE UPDATE ON "AIResponse"
  FOR EACH ROW EXECUTE FUNCTION ai_response_immutable();
