import type { Metadata } from "next";
import { countryName, languageName } from "@/lib/i18n";
import { PROMPT_INTENTS } from "@/server/onboarding/intents";
import { OnboardingShell } from "../../onboarding-shell";
import { Stepper } from "../../stepper";
import { loadOnboarding } from "../load";
import { PromptReview } from "./prompt-review";
import { regeneratePromptsAction, savePromptsAction } from "../../actions";

export const metadata: Metadata = { title: "Review prompts" };
export const maxDuration = 300;

const INTENT_ORDER = new Map(PROMPT_INTENTS.map((i, idx) => [i, idx]));

export default async function PromptsStepPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const [{ orgSlug, projectId }, { saved }] = await Promise.all([params, searchParams]);
  const { user, project, prompts: unsorted, basePath } = await loadOnboarding(orgSlug, projectId);
  const prompts = [...unsorted].sort((a, b) => INTENT_ORDER.get(a.intent)! - INTENT_ORDER.get(b.intent)! || b.priority - a.priority || a.text.localeCompare(b.text));
  const sources = new Set(prompts.filter((p) => !p.approvedAt).map((p) => p.source));

  return (
    <OnboardingShell user={user} exitHref={`/${orgSlug}`} stepper={<Stepper current="prompts" reached="prompts" basePath={basePath} />}>
      <h1 className="text-2xl font-semibold tracking-tight">Choose the prompts to track</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        These are questions buyers in {countryName(project.country)} ask AI assistants in {languageName(project.language)}. Approve the ones that matter, edit wording, or add your own.
      </p>
      {sources.has("TEMPLATE") ? (
        <div className="mt-5 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-[13px]">
          Some prompts were created from templates rather than AI. They&apos;re marked <span className="font-medium">Template</span> — review their wording.
        </div>
      ) : null}
      <div className="mt-6">
        <PromptReview
          key={prompts.map((p) => p.id).join(",")}
          completed={!!project.onboardingCompletedAt}
          justSaved={Boolean(saved)}
          save={savePromptsAction.bind(null, orgSlug, projectId)}
          regenerate={regeneratePromptsAction.bind(null, orgSlug, projectId)}
          initial={prompts.map((p) => ({
            id: p.id,
            text: p.text,
            intent: p.intent,
            cluster: p.cluster?.name ?? "General",
            priority: p.priority,
            reason: p.reason ?? "",
            source: p.source,
            // Never-reviewed suggestions default to approved so the common path is one click;
            // explicit decisions are kept.
            approved: p.reviewedAt ? p.isActive : !project.onboardingCompletedAt,
          }))}
        />
      </div>
    </OnboardingShell>
  );
}
