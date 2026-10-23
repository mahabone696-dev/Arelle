import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Check, Loader2, Lock, X } from "lucide-react";
import { PublicShell } from "@/components/marketing/public-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSessionUser } from "@/server/auth/session";
import { getPublicAudit } from "@/server/audit/service";
import { cn } from "@/lib/utils";
import { AutoRefresh } from "./auto-refresh";

// Audit results are per-domain snapshots: never indexed.
export const metadata: Metadata = { title: "Your AI visibility audit", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const TEASER = [
  { key: "lostPrompts", label: "Lost prompts", hint: "Buyer questions where AI named competitors but not you" },
  { key: "citationOpportunities", label: "Citation opportunities", hint: "Sources AI cites in answers that leave you out" },
  { key: "recommendedActions", label: "Recommended actions", hint: "Concrete changes to win those answers" },
] as const;

function ScoreRing({ score }: { score: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 120 120" className="size-32 shrink-0" role="img" aria-label={`AI visibility score ${score.toFixed(0)} out of 100`}>
      <circle cx="60" cy="60" r={r} fill="none" stroke="var(--chart-grid)" strokeWidth="10" />
      <circle cx="60" cy="60" r={r} fill="none" stroke="var(--series-1)" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(c * Math.min(100, score)) / 100} ${c}`} transform="rotate(-90 60 60)" />
      <text x="60" y="62" textAnchor="middle" dominantBaseline="middle" className="fill-foreground text-[30px] font-semibold tabular-nums">
        {score.toFixed(0)}
      </text>
      <text x="60" y="86" textAnchor="middle" className="fill-muted-foreground text-[10px]">
        of 100
      </text>
    </svg>
  );
}

export default async function AuditResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [audit, user] = await Promise.all([getPublicAudit(id), getSessionUser()]);
  if (!audit) notFound();
  const signUp = `/sign-up?audit=${audit.id}`;
  const cta = user ? `/audit/${audit.id}/continue` : signUp;

  if (audit.status === "PENDING" || audit.status === "RUNNING") {
    return (
      <PublicShell signedIn={!!user}>
        <AutoRefresh />
        <section className="mx-auto max-w-xl px-4 py-20 text-center" aria-live="polite">
          <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" aria-hidden />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">Auditing {audit.domain}…</h1>
          <p className="mt-2 text-sm text-muted-foreground">{audit.status === "PENDING" ? "Waiting for a free slot." : "Reading your site and asking an AI engine what buyers ask. This usually takes under a minute."}</p>
        </section>
      </PublicShell>
    );
  }
  if (audit.status === "FAILED" || !audit.result) {
    return (
      <PublicShell signedIn={!!user}>
        <section className="mx-auto max-w-xl px-4 py-20 text-center">
          <h1 className="text-xl font-semibold tracking-tight">We couldn&apos;t finish the audit for {audit.domain}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{audit.error ?? "Something went wrong."}</p>
          <div className="mt-6 flex justify-center gap-2">
            <Button asChild variant="outline">
              <Link href="/audit">Try again</Link>
            </Button>
            <Button asChild>
              <Link href={cta}>Create free account</Link>
            </Button>
          </div>
        </section>
      </PublicShell>
    );
  }

  const r = audit.result;
  const rows = [{ name: r.brand.name, score: r.score, mentionRate: r.mentionRate, you: true }, ...r.competitors.map((c) => ({ ...c, you: false }))].sort((a, b) => b.score - a.score);
  const max = Math.max(1, ...rows.map((x) => x.score));
  const mentioned = r.prompts.filter((p) => p.mentioned).length;

  return (
    <PublicShell signedIn={!!user}>
      <section className="mx-auto grid max-w-3xl gap-4 px-4 py-10">
        <div>
          <p className="text-xs text-muted-foreground">
            AI visibility audit · {audit.domain} · {audit.createdAt.toISOString().slice(0, 10)}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{r.brand.name}</h1>
        </div>

        <Card>
          <CardContent className="flex flex-col items-center gap-6 pt-6 sm:flex-row">
            <ScoreRing score={r.score} />
            <div className="min-w-0">
              <h2 className="text-sm font-medium">AI Visibility Score</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {r.engine.name} mentioned {r.brand.name} in {mentioned} of {r.prompts.length} buyer questions{r.brand.industry ? ` about ${r.brand.industry.toLowerCase()}` : ""}. The score combines how often you&apos;re mentioned, how early, and how often your site is cited.
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Sample of {r.prompts.length} answers from one engine{r.engine.localized ? ` localized to ${r.country}` : " (not localized)"} — a snapshot, not a ranking guarantee.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Competitor comparison</CardTitle>
            <CardDescription>Visibility score in the same answers.</CardDescription>
          </CardHeader>
          <CardContent>
            {r.competitors.length ? (
              <ul className="grid gap-2.5">
                {rows.map((x) => (
                  <li key={x.name} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_3rem] items-center gap-3 text-[13px]">
                    <span className={cn("truncate", x.you && "font-medium")}>
                      {x.name}
                      {x.you ? <span className="text-muted-foreground"> (you)</span> : null}
                    </span>
                    <span className="h-2.5 rounded-full bg-muted">
                      <span className="block h-full rounded-full" style={{ width: `${Math.max(2, (x.score / max) * 100)}%`, background: x.you ? "var(--series-1)" : "var(--chart-axis)" }} />
                    </span>
                    <span className="tabular text-right">{x.score.toFixed(1)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">We couldn&apos;t identify competitors automatically. In your account you can add the ones you care about.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Questions we asked</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-[13px]">
              {r.prompts.map((p) => (
                <li key={p.text} className="flex items-start gap-2.5 py-2">
                  {p.mentioned ? <Check className="mt-0.5 size-4 shrink-0 text-success" aria-label="Mentioned" /> : <X className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Not mentioned" />}
                  <span className="min-w-0 flex-1">{p.text}</span>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">{p.mentioned ? (p.position ? `#${p.position} brand named` : "mentioned") : "not mentioned"}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="size-4 text-muted-foreground" aria-hidden /> Detailed results
            </CardTitle>
            <CardDescription>Unlock the full findings with a free account.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <ul className="grid gap-3 sm:grid-cols-3">
              {TEASER.map((t) => (
                <li key={t.key} className="rounded-md border px-4 py-3">
                  <div className="tabular text-2xl font-semibold">{r.teaser[t.key]}</div>
                  <div className="text-[13px] font-medium">{t.label}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{t.hint}</div>
                </li>
              ))}
            </ul>
            <div aria-hidden className="pointer-events-none select-none space-y-2 blur-[5px]">
              {[78, 64, 71].map((w, i) => (
                <div key={i} className="h-3.5 rounded bg-muted" style={{ width: `${w}%` }} />
              ))}
            </div>
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
              <Button asChild size="lg">
                <Link href={cta}>Create free account</Link>
              </Button>
              <span className="text-xs text-muted-foreground">Free plan: 1 website, 10 prompts, weekly scans. No card required.</span>
            </div>
          </CardContent>
        </Card>
      </section>
    </PublicShell>
  );
}
