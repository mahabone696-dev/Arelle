import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Check, Flag, LineChart, ListChecks, Search } from "lucide-react";
import { PublicShell } from "@/components/marketing/public-shell";
import { Button } from "@/components/ui/button";
import { getSessionUser } from "@/server/auth/session";
import { listOrganizationsForUser } from "@/server/organizations/service";
import { PLANS } from "@/server/billing/plans";

export const metadata: Metadata = {
  title: { absolute: "Arelle — AI search visibility" },
  description: "Track how ChatGPT, Gemini and Perplexity mention your brand, see where competitors win, and get concrete actions to improve.",
};

const STEPS = [
  { icon: Search, title: "Track the prompts buyers ask", text: "We find the questions in your category and ask ChatGPT, Gemini and Perplexity on a schedule, in your market." },
  { icon: LineChart, title: "Measure visibility", text: "Mentions, position, citations and sentiment become one visibility score — for you and each competitor, over time." },
  { icon: Flag, title: "Find the gaps", text: "Lost prompts, citation gaps and competitor dominance are detected automatically after every scan." },
  { icon: ListChecks, title: "Act and see what changed", text: "Each opportunity comes with concrete recommendations. Mark work as done and watch the observed before/after." },
];

export default async function Home() {
  const user = await getSessionUser();
  if (user) {
    const orgs = await listOrganizationsForUser(user.id);
    const first = orgs.find((o) => !o.isDemo) ?? orgs[0];
    redirect(first ? `/${first.slug}` : "/orgs/new");
  }
  return (
    <PublicShell>
      <section className="mx-auto max-w-3xl px-4 pb-16 pt-14 text-center md:pt-24">
        <h1 className="text-4xl font-semibold tracking-tight text-balance md:text-5xl">Win the answers AI gives your buyers</h1>
        <p className="mx-auto mt-5 max-w-xl text-[15px] text-muted-foreground text-pretty">
          Arelle tracks how AI assistants mention your brand, shows where competitors are recommended instead, and tells you what to change.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-2 sm:flex-row">
          <Button asChild size="lg">
            <Link href="/audit">
              Run a free audit <ArrowRight />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/sign-up">Create free account</Link>
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">No card required.</p>
      </section>

      <section className="border-y bg-sidebar">
        <ol className="mx-auto grid max-w-5xl gap-8 px-4 py-14 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <li key={s.title}>
              <s.icon className="size-5 text-muted-foreground" aria-hidden />
              <h2 className="mt-3 text-sm font-medium">{s.title}</h2>
              <p className="mt-1 text-[13px] text-muted-foreground">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-5xl px-4 py-16">
        <h2 className="text-center text-2xl font-semibold tracking-tight">Plans</h2>
        <p className="mt-2 text-center text-[13px] text-muted-foreground">Start free. Upgrade when you need more websites, prompts or daily tracking.</p>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Object.values(PLANS).map((p) => (
            <li key={p.tier} className="flex flex-col rounded-lg border bg-card p-5">
              <h3 className="text-sm font-medium">{p.name}</h3>
              <div className="mt-2">
                <span className="tabular text-2xl font-semibold">${p.priceUsd}</span>
                <span className="text-[13px] text-muted-foreground"> / month</span>
              </div>
              <ul className="mt-4 grid gap-1.5 text-[13px]">
                {[
                  `${p.limits.projects} website${p.limits.projects === 1 ? "" : "s"}`,
                  `${p.limits.prompts.toLocaleString("en-US")} tracked prompts`,
                  p.cadence,
                  ...(p.limits.actionEngine ? ["Recommendations & action tracking"] : []),
                  ...(p.limits.reports ? ["Shareable client reports"] : []),
                ].map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden /> {f}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
    </PublicShell>
  );
}
