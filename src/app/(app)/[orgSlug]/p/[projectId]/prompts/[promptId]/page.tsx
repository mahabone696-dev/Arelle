import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, CircleCheck, CircleX, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { TrendChart } from "@/components/charts/trend-chart";
import { Delta, num1, pct } from "@/components/dashboard/delta";
import { PromptStatusBadge } from "@/components/dashboard/prompt-status";
import { getProjectPage } from "@/server/auth/session";
import { getPromptDetail } from "@/server/dashboard/metrics";
import { recommendationsForPrompt } from "@/server/opportunities/service";
import { ImpactBadge, RECOMMENDATION_LABELS, RecommendationStatusBadge } from "@/components/actions/labels";
import { promptStatus } from "@/server/dashboard/aggregate";
import { INTENT_LABELS } from "@/lib/prompt-intents";
import { DATE_RANGES, parseDateRange } from "@/lib/date-range";
import { countryName, languageName } from "@/lib/i18n";
import { isAppError } from "@/lib/errors";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Prompt" };

const OWNER = { PRIMARY: "your site", COMPETITOR: "competitor", THIRD_PARTY: null } as Record<string, string | null>;
const SEVERITY_ICON = { high: AlertTriangle, medium: Info, low: Info } as const;

export default async function PromptDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; projectId: string; promptId: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const [{ orgSlug, projectId, promptId }, sp] = await Promise.all([params, searchParams]);
  const { user } = await getProjectPage(orgSlug, projectId);
  const range = parseDateRange(sp.range);
  const d = await getPromptDetail(user.id, projectId, promptId, range).catch((e) => {
    if (isAppError(e)) notFound();
    throw e;
  });
  const recs = await recommendationsForPrompt(user.id, projectId, promptId);
  const base = `/${orgSlug}/p/${projectId}`;
  const mentionedIn = d.latest.filter((a) => a.mentions.some((m) => m.isPrimaryBrand)).length;
  const status = promptStatus(d.latest);
  const rangeLabel = DATE_RANGES.find((r) => r.key === range)!.label;

  return (
    <>
      <Link href={`${base}/prompts?range=${range}`} className="mb-4 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Prompts
      </Link>
      <div className="mb-6">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Prompt</div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-balance">“{d.prompt.text}”</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{INTENT_LABELS[d.prompt.intent].label}</Badge>
          <span>{[`P${d.prompt.priority}`, d.prompt.cluster?.name, countryName(d.prompt.country), languageName(d.prompt.language), rangeLabel].filter(Boolean).join(" · ")}</span>
        </div>
      </div>

      {d.answers === 0 ? (
        <EmptyState title="No answers in this period" description="Run a scan, or pick a longer date range." />
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-muted-foreground">Your brand</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                <div className="flex items-center gap-2 text-lg font-semibold">
                  {mentionedIn ? <CircleCheck className="size-5 text-success" /> : <CircleX className="size-5 text-destructive" />}
                  Mentioned: {mentionedIn ? "Yes" : "No"}
                </div>
                <p className="text-[13px] text-muted-foreground">
                  In {mentionedIn} of {d.latest.length} engines&apos; latest answers. <PromptStatusBadge status={status} />
                </p>
                <dl className="grid grid-cols-2 gap-y-1.5 text-[13px]">
                  <dt className="text-muted-foreground">Visibility</dt>
                  <dd className="flex items-baseline justify-end gap-2 whitespace-nowrap">
                    <Delta value={d.primary?.deltas?.visibilityScore} />
                    <span className="tabular font-semibold">{num1(d.primary?.visibilityScore)}</span>
                  </dd>
                  <dt className="text-muted-foreground">Mention rate</dt>
                  <dd className="tabular text-right">{pct(d.primary?.mentionRate)}</dd>
                  <dt className="text-muted-foreground">Avg. position</dt>
                  <dd className="tabular text-right">{num1(d.primary?.averagePosition)}</dd>
                  <dt className="text-muted-foreground">Answers</dt>
                  <dd className="tabular text-right">{d.answers}</dd>
                </dl>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Why you may be losing</CardTitle>
                <CardDescription>Patterns observed in this period&apos;s answers. These describe what the answers contain, not why the engines chose them.</CardDescription>
              </CardHeader>
              <CardContent>
                {d.insights.length ? (
                  <ul className="grid gap-2.5 text-[13px]">
                    {d.insights.map((i) => {
                      const Icon = SEVERITY_ICON[i.severity];
                      return (
                        <li key={i.kind} className="flex items-start gap-2.5">
                          <Icon className={cn("mt-0.5 size-4 shrink-0", i.severity === "high" ? "text-destructive" : "text-muted-foreground")} />
                          <span>{i.text}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-[13px] text-muted-foreground">Nothing stands out: {d.brandName} appears in these answers and is cited.</p>
                )}
                <div className="mt-4 border-t pt-3">
                  <h3 className="text-sm font-medium">Recommended actions</h3>
                  {recs.length ? (
                    <ul className="mt-1 divide-y text-[13px]">
                      {recs.map((r) => (
                        <li key={r.id}>
                          <Link href={`${base}/actions/${r.id}`} className="grid gap-1 py-2 hover:text-foreground">
                            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <ImpactBadge level={r.estimatedImpact} />
                              {RECOMMENDATION_LABELS[r.type]}
                              {r.status !== "OPEN" ? <RecommendationStatusBadge status={r.status} /> : null}
                            </span>
                            <span className="font-medium">{r.title}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-[13px] text-muted-foreground">No recommendations for this prompt right now. They&apos;re generated after each scan when an opportunity is detected.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="min-w-0 lg:col-span-2">
              <CardHeader>
                <CardTitle>Visibility over time</CardTitle>
                <CardDescription>Your score for this prompt, per scan day.</CardDescription>
              </CardHeader>
              <CardContent>
                <TrendChart data={d.series.map((p) => ({ date: p.date, ...p.scores }))} series={[{ key: "primary", name: `${d.brandName} (you)`, colorIndex: 0, emphasis: true }]} height={180} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Brand ranking</CardTitle>
                <CardDescription>Visibility on this prompt.</CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="grid gap-2 text-[13px]">
                  {d.ranking.map((r, i) => (
                    <li key={r.id ?? "primary"} className={cn("flex items-center gap-3", r.isPrimary && "font-medium")}>
                      <span className="tabular w-4 text-muted-foreground">{i + 1}</span>
                      <span className="flex-1 truncate">{r.isPrimary ? `${r.name} (you)` : r.name}</span>
                      <span className="tabular text-xs text-muted-foreground">{pct(r.metrics.mentionRate)}</span>
                      <span className="tabular w-10 text-right">{num1(r.metrics.visibilityScore)}</span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          </div>

          <div>
            <h2 className="mb-3 text-sm font-medium">Latest answer from each engine</h2>
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {d.latest.map((a) => (
                <Card key={a.responseId} className="flex min-w-0 flex-col">
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between gap-2">
                      {a.response.provider.displayName}
                      <span className="tabular text-xs font-normal text-muted-foreground">{a.createdAt.toISOString().slice(0, 10)}</span>
                    </CardTitle>
                    {(a.response.metadata as { locationSupported?: boolean } | null)?.locationSupported === false ? (
                      <CardDescription>Not localized: {a.response.provider.displayName} can&apos;t be set to {countryName(d.prompt.country)}.</CardDescription>
                    ) : null}
                  </CardHeader>
                  <CardContent className="grid flex-1 content-start gap-3 text-[13px]">
                    <div className="flex flex-wrap gap-1.5">
                      {a.mentions.some((m) => m.isPrimaryBrand) ? null : <Badge variant="destructive">{d.brandName} not mentioned</Badge>}
                      {[...a.mentions]
                        .sort((x, y) => x.position - y.position)
                        .map((m) => (
                          <Badge key={m.brandName} variant={m.isPrimaryBrand ? "success" : "outline"}>
                            #{m.position} {m.brandName}
                          </Badge>
                        ))}
                    </div>
                    <details>
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Read the answer</summary>
                      <p className="mt-2 whitespace-pre-wrap leading-relaxed">{a.response.normalizedText}</p>
                    </details>
                    {a.citations.length ? (
                      <div>
                        <div className="mb-1 text-xs text-muted-foreground">Sources</div>
                        <ol className="grid gap-1 text-xs">
                          {a.citations.map((c) => (
                            <li key={c.url} className="flex min-w-0 gap-1.5">
                              <span className="tabular text-muted-foreground">{c.position}.</span>
                              <a href={c.url} target="_blank" rel="noopener noreferrer nofollow" className="truncate hover:underline">
                                {c.domain}
                              </a>
                              {OWNER[c.ownerType] ? <span className="shrink-0 text-muted-foreground">({OWNER[c.ownerType]})</span> : null}
                            </li>
                          ))}
                        </ol>
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground">No sources cited.</div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
