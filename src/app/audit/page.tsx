import type { Metadata } from "next";
import { Bot, Quote, Target } from "lucide-react";
import { PublicShell } from "@/components/marketing/public-shell";
import { getSessionUser } from "@/server/auth/session";
import { isFeatureEnabled } from "@/server/flags/flags";
import { AUDIT_LIMITS, issueFormToken } from "@/server/audit/service";
import { AuditForm } from "./audit-form";
import { startAuditAction } from "./actions";

export const metadata: Metadata = {
  title: "Free AI visibility audit",
  description: "See whether AI assistants mention your brand when buyers ask for recommendations — and which competitors they name instead.",
};
export const dynamic = "force-dynamic";

const POINTS = [
  { icon: Bot, title: "Real AI answers", text: `We ask an AI engine ${AUDIT_LIMITS.prompts} buyer questions about your category.` },
  { icon: Target, title: "Your visibility score", text: "How often and how prominently you're mentioned, 0–100." },
  { icon: Quote, title: "Competitor comparison", text: "Who the AI recommends instead of you." },
];

export default async function AuditPage() {
  const [user, enabled] = await Promise.all([getSessionUser(), isFeatureEnabled("publicAudit")]);
  return (
    <PublicShell signedIn={!!user}>
      <section className="mx-auto max-w-2xl px-4 pb-16 pt-12 md:pt-20">
        <p className="text-xs font-medium uppercase tracking-wide text-brand">Free AI visibility audit</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance md:text-4xl">Does AI recommend your brand?</h1>
        <p className="mt-4 text-[15px] text-muted-foreground text-pretty">
          Buyers now ask ChatGPT, Gemini and Perplexity which product to choose. Enter your website to see how often you show up — and who gets recommended instead.
        </p>
        <div className="mt-8">
          {enabled ? (
            <AuditForm action={startAuditAction} formToken={issueFormToken()} />
          ) : (
            <p className="rounded-md border bg-card px-4 py-3 text-sm text-muted-foreground">The free audit is temporarily unavailable. You can still create a free account and run a full analysis.</p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">No account needed. Takes about a minute. We read a few public pages of the site and keep only the summary, not the full answers.</p>
        </div>
        <ul className="mt-12 grid gap-6 sm:grid-cols-3">
          {POINTS.map((p) => (
            <li key={p.title}>
              <p.icon className="size-5 text-muted-foreground" aria-hidden />
              <h2 className="mt-2 text-sm font-medium">{p.title}</h2>
              <p className="mt-1 text-[13px] text-muted-foreground">{p.text}</p>
            </li>
          ))}
        </ul>
      </section>
    </PublicShell>
  );
}
