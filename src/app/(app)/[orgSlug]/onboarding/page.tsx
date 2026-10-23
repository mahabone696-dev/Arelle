import type { Metadata } from "next";
import { requireOrgPage } from "@/server/auth/session";
import { normalizeDomain } from "@/lib/domain";
import { COUNTRIES } from "@/lib/i18n";
import { OnboardingShell } from "./onboarding-shell";
import { Stepper } from "./stepper";
import { StartForm } from "./start-form";
import { startOnboardingAction } from "./actions";

export const metadata: Metadata = { title: "Set up a website" };
// Website analysis (bounded crawl + one AI extraction) runs inside this request.
export const maxDuration = 300;

export default async function OnboardingStartPage({ params, searchParams }: { params: Promise<{ orgSlug: string }>; searchParams: Promise<{ url?: string; country?: string }> }) {
  const [{ orgSlug }, sp] = await Promise.all([params, searchParams]);
  const domain = sp.url ? normalizeDomain(sp.url) : null;
  const country = COUNTRIES.some((c) => c.code === sp.country) ? sp.country : undefined;
  const { user } = await requireOrgPage(orgSlug, "project:create");
  return (
    <OnboardingShell user={user} exitHref={`/${orgSlug}`} stepper={<Stepper current="website" reached="website" />}>
      <div className="mx-auto max-w-xl pt-6 md:pt-14">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">What website do you want to improve in AI search?</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          We&apos;ll read your homepage and a few key pages to understand your brand, then suggest competitors and the prompts buyers ask AI assistants.
        </p>
        <div className="mt-8">
          <StartForm action={startOnboardingAction.bind(null, orgSlug)} initialUrl={domain?.ok ? `https://${domain.domain}` : undefined} initialCountry={country} />
        </div>
      </div>
    </OnboardingShell>
  );
}
