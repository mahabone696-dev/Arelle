import type { Metadata } from "next";
import { getOnboardingLLM } from "@/server/ai/config";
import { OnboardingShell } from "../../onboarding-shell";
import { Stepper, stepFromOnboarding } from "../../stepper";
import { loadOnboarding } from "../load";
import { CompetitorsEditor } from "./competitors-editor";
import { regenerateCompetitorsAction, saveCompetitorsAction } from "../../actions";

export const metadata: Metadata = { title: "Competitors" };
export const maxDuration = 300;

export default async function CompetitorsStepPage({ params }: { params: Promise<{ orgSlug: string; projectId: string }> }) {
  const { orgSlug, projectId } = await params;
  const { user, project, brand, competitors, basePath } = await loadOnboarding(orgSlug, projectId);
  const aiAvailable = getOnboardingLLM() !== null;

  return (
    <OnboardingShell user={user} exitHref={`/${orgSlug}`} stepper={<Stepper current="competitors" reached={stepFromOnboarding(project.onboardingStep)} basePath={basePath} />}>
      <h1 className="text-2xl font-semibold tracking-tight">Who do you compete with?</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        We&apos;ll track how often AI answers mention these brands instead of {brand?.name ?? "you"}. Add, remove or edit them — you can change this later.
      </p>
      <div className="mt-8">
        <CompetitorsEditor
          // Remount when the server-side set changes (e.g. after "Suggest again").
          key={competitors.map((c) => c.id).join(",")}
          aiAvailable={aiAvailable}
          save={saveCompetitorsAction.bind(null, orgSlug, projectId)}
          regenerate={regenerateCompetitorsAction.bind(null, orgSlug, projectId)}
          initial={competitors.map((c) => ({ id: c.id, name: c.name, domain: c.domain ?? "", reason: c.reason ?? undefined, source: c.source }))}
        />
      </div>
    </OnboardingShell>
  );
}
